// Saves (full overwrite) a signed-in user's cloud chat document. Requires a
// valid user token; the document's own `profile.sub` must match the sub the
// token verified to, so a caller can never write into someone else's blob no
// matter what `doc` claims. Light shape/size validation only — this is a
// personal-scale app, so there's no locking — but writes are optimistic: the
// client sends `baseUpdatedAt` (the updatedAt of the doc it last loaded/saved) and
// if the stored doc is newer (another device saved in between) we answer 409 with
// the stored doc instead of silently overwriting it; the client merges and retries.

const { getPlatformStore } = require('./_store');
const { verify } = require('./_userToken');
const { rateLimit, tooMany } = require('./_util');

const MAX_DOC_BYTES = 4 * 1024 * 1024; // 4MB

function store() {
    return getPlatformStore("knowura-chats");
}

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
    };
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };

    try {
        const wait = rateLimit(event, "chat-save", 60, 60 * 1000);
        if (wait) return tooMany(wait);

        const { token, doc, baseUpdatedAt } = JSON.parse(event.body || "{}");
        const session = verify(token, process.env.KNOWURA_USER_TOKEN_SECRET);
        if (!session) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid or expired session" }) };
        }

        if (!doc || typeof doc !== "object" || !Array.isArray(doc.chats)) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: "Malformed document" }) };
        }
        if (!doc.profile || doc.profile.sub !== session.sub) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: "Document does not belong to this session" }) };
        }

        const serialized = JSON.stringify(doc);
        if (Buffer.byteLength(serialized, "utf8") > MAX_DOC_BYTES) {
            return { statusCode: 413, headers, body: JSON.stringify({ error: "Document too large" }) };
        }

        const existing = await store().get(session.sub, { type: "json" });
        if (existing?.updatedAt && existing.updatedAt > (Number(baseUpdatedAt) || 0)) {
            return { statusCode: 409, headers, body: JSON.stringify({ conflict: true, doc: existing }) };
        }

        doc.updatedAt = Math.max(Date.now(), (existing?.updatedAt || 0) + 1);
        await store().setJSON(session.sub, doc);

        return { statusCode: 200, headers, body: JSON.stringify({ saved: true, updatedAt: doc.updatedAt }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
