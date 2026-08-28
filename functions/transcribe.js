// Speech-to-text for Live Voice mode. Accepts a base64-encoded audio clip
// recorded in the browser (MediaRecorder) and forwards it to Groq's Whisper
// endpoint. Uses Node's built-in fetch/FormData/Blob (no extra dependency).

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
    };
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };

    try {
        const { audio, mimeType } = JSON.parse(event.body);
        if (!audio) throw new Error("No audio provided");

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
