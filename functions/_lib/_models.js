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

let cache = { at: 0, all: null };
const GUARD = /guard|safeguard/i;
const FALLBACK_GUARDS = ["meta-llama/llama-guard-4-12b", "openai/gpt-oss-safeguard-20b"];

function labelFor(id) {
    return id.split("/").pop();
}

// Every active model Groq lists, cached for a few minutes.
async function getCatalog() {
    if (cache.all && Date.now() - cache.at < CACHE_MS) return cache.all;
    const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
    });
    if (!res.ok) throw new Error(`Groq /models returned ${res.status}`);
    const data = await res.json();
    const all = (data.data || []).filter(m => m.id && m.active !== false);
    if (!all.length) throw new Error("no models returned");
    cache = { at: Date.now(), all };
    return all;
}

async function getChatModels() {
    try {
        const models = (await getCatalog())
            .filter(m => !NON_CHAT.test(m.id))
            .map(m => ({ id: m.id, label: labelFor(m.id), owned_by: m.owned_by, context_window: m.context_window }))
            .sort((a, b) => a.id.localeCompare(b.id));
        if (!models.length) throw new Error("no chat models returned");
        return models;
    } catch (e) {
        console.warn("Falling back to the built-in model list:", e.message);
        return cache.all ? cache.all.filter(m => !NON_CHAT.test(m.id)).map(m => ({ id: m.id, label: labelFor(m.id) })) : FALLBACK;
    }
}

// The safety models Groq offers (Llama Guard, gpt-oss-safeguard). If the list can't be fetched, try the usual names.
async function getGuardModels() {
    try {
        const ids = (await getCatalog()).map(m => m.id).filter(id => GUARD.test(id));
        return ids.length ? ids : [];
    } catch (e) {
        return FALLBACK_GUARDS;
    }
}

module.exports = { getChatModels, getGuardModels, DEFAULT_MODEL };
