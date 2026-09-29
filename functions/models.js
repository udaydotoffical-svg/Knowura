// Returns the live list of chat models Groq currently offers, for the model picker.
const { getChatModels, DEFAULT_MODEL } = require('./_models');
const { rateLimit, tooMany } = require('./_util');

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300"
    };
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };
    try {
        const wait = rateLimit(event, "models", 60, 60 * 1000);
        if (wait) return tooMany(wait);
        const models = await getChatModels();
        return { statusCode: 200, headers, body: JSON.stringify({ models, defaultModel: DEFAULT_MODEL }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
