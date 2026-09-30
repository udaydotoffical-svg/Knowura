// Text-to-speech for Live Voice mode. Sends reply text to Groq's Orpheus TTS endpoint and
// returns the generated audio as base64 so the browser can play it from a data: URI.
// Uses Node's built-in fetch (no dependency). Counts against the daily voice limit
// (owner mode is exempt).

const { json, guard, readJson, cleanStr } = require('./_util');
const { whoIs, usageGate } = require('./_limits');

// Groq's Orpheus voices — anything else is ignored so callers can't inject arbitrary values.
const VOICES = new Set(["autumn", "diana", "hannah", "austin", "daniel", "troy"]);

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const { body, error } = readJson(event, 16 * 1024, { allowEmpty: false });
        if (error) return error;

        const ident = whoIs(body, event);
        const gate = await usageGate(event, ident, 'voice');
        if (gate.response) return gate.response;

        const text = cleanStr(body.text, 12000, 1);
        if (text === null) return json(400, { error: "No text provided" });

        // Keep voice replies short (functions time out after ~10s and a long TTS render risks
        // blowing past that) and cut at a sentence boundary where possible, not mid-word.
        let clean = text.replace(/[*_`#>]/g, "").trim();
        if (clean.length > 600) {
            const cut = clean.slice(0, 600);
            const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
            clean = lastStop > 200 ? cut.slice(0, lastStop + 1) : cut;
        }

        const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "canopylabs/orpheus-v1-english",
                input: clean,
                voice: VOICES.has(body.voice) ? body.voice : "autumn",
                response_format: "wav" // Orpheus only accepts wav
            }),
            signal: AbortSignal.timeout(8000)
        }).catch(e => { throw new Error(e.name === "TimeoutError" ? "Groq TTS timed out" : "Groq TTS unreachable"); });

        if (!res.ok) return json(502, { error: "Voice generation failed. Please try again." });

        const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
        return json(200, { audio: base64, mimeType: "audio/wav" });
    } catch (error) {
        return json(500, { error: "Voice generation failed." });
    }
};
