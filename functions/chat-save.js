// Saves (full overwrite) a signed-in user's cloud chat document. Requires a valid
// user token; the document is rebuilt field by field from a whitelist (types, counts and
// sizes all capped) and stored under the *token's* sub, so a caller can never write into
// someone else's blob or smuggle unexpected data into their own.
//
// Writes are optimistic: the client sends `baseUpdatedAt` (the updatedAt of the doc it last
// loaded/saved) and if the stored doc is newer (another device saved in between) we answer
// 409 with the stored doc instead of silently overwriting it; the client merges and retries.

const { getPlatformStore } = require('./_lib/_store');
const { verify } = require('./_lib/_userToken');
const { json, guard, readJson, cleanStr, isPlainObject, rateLimit, tooMany } = require('./_lib/_util');

const MAX_BODY_BYTES = 4.3 * 1024 * 1024;  // under Vercel's 4.5MB request cap
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const MAX_CHATS = 60, MAX_MESSAGES = 120, MAX_TEXT = 100000, MAX_FACTS = 100;

function store() {
    return getPlatformStore("knowura-chats");
}

const num = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(v, 8.64e15)) : 0);

function cleanChat(c) {
    if (!isPlainObject(c)) return null;
    const id = cleanStr(c.id, 60, 1);
    if (id === null || !/^[\w-]+$/.test(id)) return null;
    const messages = [];
    for (const m of (Array.isArray(c.messages) ? c.messages.slice(-MAX_MESSAGES) : [])) {
        const text = isPlainObject(m) ? cleanStr(m.text, MAX_TEXT) : null;
        if (text === null || (m.type !== 'user' && m.type !== 'ai')) continue;
        messages.push({ text, type: m.type });
    }
    return { id, title: cleanStr(c.title, 160) ?? 'Chat', createdAt: num(c.createdAt), updatedAt: num(c.updatedAt), messages };
}

function cleanDoc(doc, sub) {
    if (!isPlainObject(doc) || !Array.isArray(doc.chats)) return null;
    const chats = doc.chats.slice(0, MAX_CHATS).map(cleanChat).filter(Boolean);
    const memory = isPlainObject(doc.memory) ? doc.memory : {};
    const p = isPlainObject(doc.profile) ? doc.profile : {};
    return {
        version: 1,
        profile: {
            sub,
            given_name: cleanStr(p.given_name, 60) ?? undefined,
            email: cleanStr(p.email, 254) ?? undefined,
            picture: typeof p.picture === 'string' && /^https:\/\//.test(p.picture) && p.picture.length <= 500 ? p.picture : undefined
        },
        chats,
        activeChatId: chats.some(c => c.id === doc.activeChatId) ? doc.activeChatId : null,
        memory: {
            summary: cleanStr(memory.summary, 4000) ?? '',
            facts: (Array.isArray(memory.facts) ? memory.facts : []).filter(f => typeof f === 'string').slice(0, MAX_FACTS).map(f => f.slice(0, 300))
        }
    };
}

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const wait = rateLimit(event, "chat-save", 60, 60 * 1000);
        if (wait) return tooMany(wait);

        const { body, error } = readJson(event, MAX_BODY_BYTES, { allowEmpty: false });
        if (error) return error;

        const token = cleanStr(body.token, 400, 1);
        const session = token && verify(token, process.env.KNOWURA_USER_TOKEN_SECRET);
        if (!session) return json(401, { error: "Invalid or expired session" });

        if (!isPlainObject(body.doc) || !Array.isArray(body.doc.chats)) return json(400, { error: "Malformed document" });
        if (!isPlainObject(body.doc.profile) || body.doc.profile.sub !== session.sub) {
            return json(403, { error: "Document does not belong to this session" });
        }
        const doc = cleanDoc(body.doc, session.sub);
        if (!doc) return json(400, { error: "Malformed document" });
        if (Buffer.byteLength(JSON.stringify(doc), "utf8") > MAX_DOC_BYTES) return json(413, { error: "Document too large" });

        const base = Number(body.baseUpdatedAt);
        const existing = await store().get(session.sub, { type: "json" });
        if (existing?.updatedAt && existing.updatedAt > (Number.isFinite(base) ? base : 0)) {
            return json(409, { conflict: true, doc: existing });
        }

        doc.updatedAt = Math.max(Date.now(), (existing?.updatedAt || 0) + 1);
        await store().setJSON(session.sub, doc);
        return json(200, { saved: true, updatedAt: doc.updatedAt });
    } catch (error) {
        return json(500, { error: "Couldn't save your chats." });
    }
};

exports._test = { cleanDoc };
