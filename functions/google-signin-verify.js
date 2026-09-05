// Verifies a Google Identity Services credential (ID token) server-side
// before trusting any of its claims. The client previously just decoded the
// JWT payload with atob() and trusted it as-is — anyone could hand-craft a
// fake JWT-shaped string with any name/email in devtools. This checks the
// token against Google's tokeninfo endpoint (signature + expiry, already
// validated by Google) and additionally checks `aud` matches this app's own
// OAuth client ID, then issues a short-lived signed session token keyed to
// the verified `sub` (Google's stable per-account id) for chat-load/chat-save
// to trust.

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { sign } = require('./_userToken');

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
    };
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };

    try {
        const { credential } = JSON.parse(event.body || "{}");
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const secret = process.env.KNOWURA_USER_TOKEN_SECRET;

        if (!clientId || !secret) {
            return {
                statusCode: 500, headers,
                body: JSON.stringify({ verified: false, error: "Google sign-in isn't configured on the server (set GOOGLE_CLIENT_ID and KNOWURA_USER_TOKEN_SECRET)." })
            };
        }
        if (!credential || typeof credential !== "string") {
            return { statusCode: 400, headers, body: JSON.stringify({ verified: false, error: "Missing credential" }) };
        }

        const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
        if (!res.ok) {
            return { statusCode: 401, headers, body: JSON.stringify({ verified: false, error: "Google rejected the credential" }) };
        }
        const info = await res.json();

        if (info.aud !== clientId) {
            return { statusCode: 401, headers, body: JSON.stringify({ verified: false, error: "Credential was issued for a different app" }) };
        }
        if (!info.sub) {
            return { statusCode: 401, headers, body: JSON.stringify({ verified: false, error: "Credential missing subject" }) };
        }
        // tokeninfo already rejects expired tokens, but double-check defensively.
        if (info.exp && Date.now() >= Number(info.exp) * 1000) {
            return { statusCode: 401, headers, body: JSON.stringify({ verified: false, error: "Credential expired" }) };
        }

        const profile = {
            sub: info.sub,
            email: info.email,
            given_name: info.given_name || info.name || "Learner",
            picture: info.picture
        };

        return {
            statusCode: 200, headers,
            body: JSON.stringify({ verified: true, token: sign(info.sub, secret), profile })
        };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ verified: false, error: error.message }) };
    }
};
