// Speech-to-text for Live Voice mode. Accepts a base64-encoded audio clip
// recorded in the browser (MediaRecorder) and forwards it to Groq's Whisper
// endpoint. Uses Node's built-in fetch/FormData/Blob (no extra dependency).

const { BASE_HEADERS: headers, preflight, rateLimit, tooMany } = require('./_util');

const MAX_AUDIO_B64_CHARS = 5 * 1024 * 1024; // ~3.7MB of audio — well over a spoken turn

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return preflight();

    try {
        const wait = rateLimit(event, "transcribe", 20, 60 * 1000);
        if (wait) return tooMany(wait);

        const { audio, mimeType } = JSON.parse(event.body || "{}");
        if (!audio || typeof audio !== "string") throw new Error("No audio provided");
        if (audio.length > MAX_AUDIO_B64_CHARS) {
            return { statusCode: 413, headers, body: JSON.stringify({ error: "Audio clip is too large" }) };
        }

        const buffer = Buffer.from(audio, "base64");
        const blob = new Blob([buffer], { type: mimeType || "audio/webm" });

        const form = new FormData();
        form.append("file", blob, "voice.webm");
        form.append("model", "whisper-large-v3-turbo");
        form.append("response_format", "json");

        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
            body: form
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Groq transcription failed: ${errText}`);
        }

        const data = await res.json();
        return { statusCode: 200, headers, body: JSON.stringify({ text: data.text || "" }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
