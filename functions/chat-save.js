// Saves (full overwrite) a signed-in user's cloud chat document. Requires a
// valid user token; the document's own `profile.sub` must match the sub the
// token verified to, so a caller can never write into someone else's blob no
// matter what `doc` claims. Light shape/size validation only — this is a
// personal-scale app, not a multi-tenant service, so no locking/versioning.

const { getStore } = require('@netlify/blobs');
const { verify } = require('./_userToken');

const MAX_DOC_BYTES = 4 * 1024 * 1024; // 4MB

function store() {
    return getStore({
        name: "knowura-chats",
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN
    });
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
        const { token, doc } = JSON.parse(event.body || "{}");
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

        doc.updatedAt = Date.now();
        await store().setJSON(session.sub, doc);

        return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
