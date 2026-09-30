// Speech-to-text for Live Voice mode. Accepts a base64-encoded audio clip recorded in the
// browser (MediaRecorder) and forwards it to Groq's Whisper endpoint. Uses Node's built-in
// fetch/FormData/Blob (no extra dependency). Counts against the person's daily voice limit
// (owner mode is exempt).

const { json, guard, readJson, cleanStr } = require('./_util');
const { whoIs, usageGate } = require('./_limits');

const MAX_BODY_BYTES = 4 * 1024 * 1024;        // Vercel functions cap requests at 4.5MB
const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|aac|x-m4a|m4a)(;.*)?$/i;

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const { body, error } = readJson(event, MAX_BODY_BYTES, { allowEmpty: false });
        if (error) return error;

        const ident = whoIs(body, event);
        const gate = await usageGate(event, ident, 'voice');
        if (gate.response) return gate.response;

        const audio = cleanStr(body.audio, MAX_BODY_BYTES, 16);
        if (audio === null || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return json(400, { error: "No valid audio provided" });
        const mimeType = typeof body.mimeType === "string" && AUDIO_TYPES.test(body.mimeType) ? body.mimeType.split(";")[0] : "audio/webm";

        const buffer = Buffer.from(audio, "base64");
        const blob = new Blob([buffer], { type: mimeType });

        const form = new FormData();
        form.append("file", blob, "voice.webm");
        form.append("model", "whisper-large-v3-turbo");
        form.append("response_format", "json");

        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
            body: form,
            signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) return json(502, { error: "Transcription failed. Please try again." });

        const data = await res.json();
        return json(200, { text: String(data.text || "").slice(0, 4000) });
    } catch (error) {
        return json(500, { error: "Transcription failed." });
    }
};
