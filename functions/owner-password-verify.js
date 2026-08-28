// Password fallback for unlocking Owner Mode, for when a hardware security
// key isn't handy. Compares against OWNER_PASSWORD (a Netlify env var —
// never hardcode it) using a constant-time comparison, then issues the same
// kind of signed token the WebAuthn path produces.

const crypto = require('crypto');
const { sign } = require('./_ownerToken');

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
    };
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };

    try {
        const { password } = JSON.parse(event.body || "{}");
        const expected = process.env.OWNER_PASSWORD;
        const secret = process.env.OWNER_TOKEN_SECRET;

        if (!expected || !secret) {
            return {
                statusCode: 500, headers,
                body: JSON.stringify({ verified: false, error: "Owner password isn't configured on the server (set OWNER_PASSWORD and OWNER_TOKEN_SECRET)." })
            };
        }

        const given = Buffer.from(String(password || ""));
        const wanted = Buffer.from(expected);
        // Compare equal-length buffers first so timingSafeEqual never throws on a length mismatch,
        // while still doing constant-time work either way so response time doesn't leak the length.
        const match = given.length === wanted.length
            ? crypto.timingSafeEqual(given, wanted)
            : (crypto.timingSafeEqual(wanted, wanted), false);

        if (!match) {
            return { statusCode: 401, headers, body: JSON.stringify({ verified: false }) };
        }

        return { statusCode: 200, headers, body: JSON.stringify({ verified: true, token: sign(secret) }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ verified: false, error: error.message }) };
    }
};
