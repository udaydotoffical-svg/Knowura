// Shared helper for both owner-unlock paths (security key + password).
// Not itself a Netlify Function (no exports.handler) — just a local dependency.
//
// Verifying a client-supplied `ownerMode: true` boolean directly (the old
// approach) is not real auth — anyone can send that flag from devtools with
// no key or password. Instead, a successful unlock gets a short-lived
// HMAC-signed token; ask-ai.js verifies the signature + expiry server-side
// before granting owner mode.

const crypto = require('crypto');

const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function sign(secret) {
    const exp = Date.now() + TOKEN_TTL_MS;
    const sig = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
    return `${exp}.${sig}`;
}

function verify(token, secret) {
    if (!token || !secret) return false;
    const parts = String(token).split('.');
    if (parts.length !== 2) return false;
    const [expStr, sig] = parts;
    if (!/^\d+$/.test(expStr)) return false;

    const expected = crypto.createHmac('sha256', secret).update(expStr).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

    return Date.now() < Number(expStr);
}

module.exports = { sign, verify };
