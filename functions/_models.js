// Live list of Groq chat models, fetched from Groq's /models endpoint and
// cached briefly in memory (per warm function instance). Used both to serve
// the picker (models.js) and to validate the model id ask-ai.js is asked to
// use, so a client can't request an arbitrary/non-chat model on our key.

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const DEFAULT_MODEL = "openai/gpt-oss-20b";
const CACHE_MS = 10 * 60 * 1000;

// Speech, moderation and embedding models are listed by Groq too but can't
// answer chat messages here.
const NON_CHAT = /whisper|tts|orpheus|playai|guard|safeguard|embed|moderation/i;

const FALLBACK = [
    { id: "openai/gpt-oss-20b", label: "gpt-oss-20b" },
    { id: "openai/gpt-oss-120b", label: "gpt-oss-120b" }
];

let cache = { at: 0, models: null };

function labelFor(id) {
    return id.split("/").pop();
}

async function getChatModels() {
    if (cache.models && Date.now() - cache.at < CACHE_MS) return cache.models;
    try {
        const res = await fetch("https://api.groq.com/openai/v1/models", {
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
        });
        if (!res.ok) throw new Error(`Groq /models returned ${res.status}`);
        const data = await res.json();
        const models = (data.data || [])
            .filter(m => m.id && m.active !== false && !NON_CHAT.test(m.id))
            .map(m => ({ id: m.id, label: labelFor(m.id), owned_by: m.owned_by, context_window: m.context_window }))
            .sort((a, b) => a.id.localeCompare(b.id));
        if (!models.length) throw new Error("no chat models returned");
        cache = { at: Date.now(), models };
        return models;
    } catch (e) {
        console.warn("Falling back to the built-in model list:", e.message);
        return cache.models || FALLBACK;
    }
}

module.exports = { getChatModels, DEFAULT_MODEL };
