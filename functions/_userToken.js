// Shared helper for signed-in (Google) user sessions. Same HMAC pattern as
// _ownerToken.js, but the payload carries `sub` (the Google account id) too,
// since this token identifies *who*, not just *that someone is verified*.
// Uses its own secret (KNOWURA_USER_TOKEN_SECRET) — a different trust domain
// from owner mode, so the two must never share a secret.
//
// Not itself a Netlify Function (no exports.handler) — just a local dependency.

const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(sub, secret) {
    const exp = Date.now() + TOKEN_TTL_MS;
    const payload = `${encodeURIComponent(sub)}.${exp}`;
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

function verify(token, secret) {
    if (!token || !secret) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [subEnc, expStr, sig] = parts;
    if (!/^\d+$/.test(expStr)) return null;

    const payload = `${subEnc}.${expStr}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    if (Date.now() >= Number(expStr)) return null;
    return { sub: decodeURIComponent(subEnc) };
}

module.exports = { sign, verify };
