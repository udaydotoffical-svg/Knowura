// Gate for the passkey *registration* endpoints. Before this, anyone could
// register their own security key over the owner's and log straight into Owner
// Mode. Now:
//   - if an owner credential already exists, replacing it needs a valid owner
//     token (X-Owner-Token) — i.e. you must already be the owner;
//   - if none exists yet (first-time setup), the caller must send the
//     WEBAUTHN_SETUP_SECRET env var value in X-Setup-Secret.
// Not a route (no exports.handler).

const crypto = require('crypto');
const { verify } = require('./_ownerToken');
const { header } = require('./_util');

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    if (x.length !== y.length) { crypto.timingSafeEqual(y, y); return false; }
    return crypto.timingSafeEqual(x, y);
}

// Returns null when allowed, otherwise { statusCode, error }.
function checkRegistrationAllowed(event, existingCredential) {
    if (existingCredential) {
        const ok = verify(header(event, 'x-owner-token'), process.env.OWNER_TOKEN_SECRET);
        return ok ? null : { statusCode: 403, error: "A key is already registered — unlock Owner Mode first to replace it." };
    }
    const setup = process.env.WEBAUTHN_SETUP_SECRET;
    if (!setup) return { statusCode: 403, error: "Key registration is disabled (set WEBAUTHN_SETUP_SECRET to enable first-time setup)." };
    return safeEqual(header(event, 'x-setup-secret'), setup) ? null : { statusCode: 403, error: "Invalid setup secret." };
}

module.exports = { checkRegistrationAllowed };
