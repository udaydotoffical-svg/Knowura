// Shape check for the WebAuthn credential JSON the browser posts back — only the fields
// the verifier reads, each type- and size-checked, so oversized or odd payloads never reach it.
// Not a route (no exports.handler).

const { isPlainObject } = require('./_util');

const b64url = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+={0,2}$/.test(v);

function cleanCredentialResponse(body) {
    if (!isPlainObject(body) || !isPlainObject(body.response)) return null;
    if (!b64url(body.id, 1400) || !b64url(body.rawId, 1400)) return null;
    if (body.type !== 'public-key') return null;

    const r = body.response, out = {};
    for (const k of ['clientDataJSON', 'authenticatorData', 'signature', 'attestationObject', 'userHandle']) {
        if (r[k] === undefined || r[k] === null) continue;
        if (!b64url(r[k], 8192)) return null;
        out[k] = r[k];
    }
    if (!out.clientDataJSON) return null;
    if (Array.isArray(r.transports)) out.transports = r.transports.filter(t => typeof t === 'string' && t.length <= 20).slice(0, 8);

    const clean = { id: body.id, rawId: body.rawId, type: 'public-key', response: out, clientExtensionResults: isPlainObject(body.clientExtensionResults) ? {} : {} };
    if (typeof body.authenticatorAttachment === 'string' && body.authenticatorAttachment.length <= 20) clean.authenticatorAttachment = body.authenticatorAttachment;
    return clean;
}

module.exports = { cleanCredentialResponse };
