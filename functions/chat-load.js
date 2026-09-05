// Loads a signed-in user's cloud chat document (chats + memory), keyed by
// their verified Google `sub`. Requires a valid user token from
// google-signin-verify.js — nothing is ever looked up from a client-supplied
// id directly, only from what the signature already proved.

const { getStore } = require('@netlify/blobs');
const { verify } = require('./_userToken');

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
        const { token } = JSON.parse(event.body || "{}");
        const session = verify(token, process.env.KNOWURA_USER_TOKEN_SECRET);
        if (!session) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid or expired session" }) };
        }

        const doc = await store().get(session.sub, { type: "json" });
        return { statusCode: 200, headers, body: JSON.stringify({ found: !!doc, doc: doc || null }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
