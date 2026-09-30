// Returns the live list of chat models Groq currently offers, for the model picker.
const { getChatModels, DEFAULT_MODEL } = require('./_models');
const { json, guard, readJson, rateLimit, tooMany } = require('./_util');

exports.handler = async (event) => {
    const early = guard(event, ["GET", "POST"]);
    if (early) return early;
    try {
        const { error: badBody } = readJson(event, 1024); // these routes take no body — refuse anything large or malformed
        if (badBody) return badBody;
        const wait = rateLimit(event, "models", 60, 60 * 1000);
        if (wait) return tooMany(wait);
        const models = await getChatModels();
        return json(200, { models, defaultModel: DEFAULT_MODEL }, { "Cache-Control": "public, max-age=300" });
    } catch (error) {
        return json(500, { error: "Couldn't load models." });
    }
};
