// Password fallback for unlocking Owner Mode, for when a hardware security key
// isn't handy. Compares against OWNER_PASSWORD (an env var — never hardcode it)
// using a constant-time comparison, then issues the same kind of signed token
// the WebAuthn path produces. Max 5 attempts per 15 minutes per IP.

const crypto = require('crypto');
const { sign } = require('./_lib/_ownerToken');
const { json, guard, readJson, cleanStr } = require('./_lib/_util');
const { authAttempt } = require('./_lib/_limits');

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const limited = await authAttempt(event, 'owner-password');
        if (limited) return limited;

        const { body, error } = readJson(event, 2 * 1024);
        if (error) return error;
        const password = cleanStr(body.password, 256, 1);
        if (password === null) return json(400, { verified: false, error: "A password is required." });

        const expected = process.env.OWNER_PASSWORD;
        const secret = process.env.OWNER_TOKEN_SECRET;
        if (!expected || !secret) {
            return json(500, { verified: false, error: "Owner password isn't configured on the server." });
        }

        const given = Buffer.from(password);
        const wanted = Buffer.from(expected);
        // Compare equal-length buffers first so timingSafeEqual never throws on a length mismatch,
        // while still doing constant-time work either way so response time doesn't leak the length.
        const match = given.length === wanted.length
            ? crypto.timingSafeEqual(given, wanted)
            : (crypto.timingSafeEqual(wanted, wanted), false);

        if (!match) return json(401, { verified: false });
        return json(200, { verified: true, token: sign(secret) });
    } catch (error) {
        return json(500, { verified: false, error: "Something went wrong." });
    }
};
