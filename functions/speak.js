// Text-to-speech for Live Voice mode. Sends reply text to Groq's Orpheus TTS
// endpoint and returns the generated audio as base64 so the browser can play
// it directly from a data: URI. Uses Node's built-in fetch (no dependency).

const { BASE_HEADERS: headers, preflight, rateLimit, tooMany } = require('./_util');

// Groq's Orpheus voices — anything else is ignored so callers can't inject arbitrary values.
const VOICES = new Set(["autumn", "diana", "hannah", "austin", "daniel", "troy"]);

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return preflight();

    try {
        const wait = rateLimit(event, "speak", 30, 60 * 1000);
        if (wait) return tooMany(wait);

        const { text, voice } = JSON.parse(event.body || "{}");
        if (!text || typeof text !== "string") throw new Error("No text provided");

        // Keep voice replies short (Netlify functions time out around 10s, and a
        // long TTS render risks blowing past that) and cut at a sentence boundary
        // where possible, rather than mid-word.
        let clean = text.replace(/[*_`#>]/g, "").trim();
        if (clean.length > 600) {
            const cut = clean.slice(0, 600);
            const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
            clean = lastStop > 200 ? cut.slice(0, lastStop + 1) : cut;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        let res;
        try {
            res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "canopylabs/orpheus-v1-english",
                    input: clean,
                    voice: VOICES.has(voice) ? voice : "autumn",
                    response_format: "wav" // Orpheus only accepts wav, unlike the old playai-tts endpoint
                }),
                signal: controller.signal
            });
        } catch (fetchErr) {
            if (fetchErr.name === "AbortError") throw new Error("Groq TTS timed out after 8s");
            throw fetchErr;
        } finally {
            clearTimeout(timeout);
        }

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Groq TTS failed (${res.status}): ${errText}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        return { statusCode: 200, headers, body: JSON.stringify({ audio: base64, mimeType: "audio/wav" }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
