// Text-to-speech for Live Voice mode. Sends reply text to Groq's Orpheus TTS
// endpoint and returns the generated audio as base64 so the browser can play
// it directly from a data: URI. Uses Node's built-in fetch (no dependency).

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
    };
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };

    try {
        const { text, voice } = JSON.parse(event.body);
        if (!text) throw new Error("No text provided");

        // Orpheus TTS caps input length; keep clips short and strip Markdown noise.
        const clean = text.replace(/[*_`#>]/g, "").slice(0, 1800);

        const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "canopylabs/orpheus-v1-english",
                input: clean,
                voice: voice || "autumn",
                response_format: "mp3"
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Groq TTS failed: ${errText}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        return { statusCode: 200, headers, body: JSON.stringify({ audio: base64, mimeType: "audio/mpeg" }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
