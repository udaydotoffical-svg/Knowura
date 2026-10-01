// Loads a signed-in user's cloud chat document (chats + memory), keyed by their verified
// Google `sub`. Requires a valid user token from google-signin-verify.js — nothing is ever
// looked up from a client-supplied id directly, only from what the signature already proved.

const { getPlatformStore } = require('./_store');
const { verify } = require('./_userToken');
const { isOwnerSub } = require('./_owner');
const { json, guard, readJson, cleanStr, rateLimit, tooMany } = require('./_util');

function store() {
    return getPlatformStore("knowura-chats");
}

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const wait = rateLimit(event, "chat-load", 60, 60 * 1000);
        if (wait) return tooMany(wait);

        const { body, error } = readJson(event, 2 * 1024);
        if (error) return error;
        const token = cleanStr(body.token, 400, 1);
        const session = token && verify(token, process.env.KNOWURA_USER_TOKEN_SECRET);
        if (!session) return json(401, { error: "Invalid or expired session" });

        const doc = await store().get(session.sub, { type: "json" });
        // Only says whether this is the owner's account (so the secret menu can offer "turn on owner mode").
        // Owner mode itself is never switched on automatically.
        const ownerEligible = await isOwnerSub(session.sub);
        return json(200, { found: !!doc, doc: doc || null, ownerEligible });
    } catch (error) {
        return json(500, { error: "Couldn't load your chats." });
    }
};
