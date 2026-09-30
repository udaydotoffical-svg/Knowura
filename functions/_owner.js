// Owner detection for Google sign-in: when Google confirms the signed-in account is the
// owner's (verified email match), the server hands back an owner token — no extra step.
//
// The owner email defaults to the project owner's address and can be changed (or disabled by
// setting it to an empty string) with OWNER_EMAIL. For extra safety OWNER_GOOGLE_SUB can pin the
// Google account id so that only that exact account counts. Not a route (no exports.handler).

const { getPlatformStore } = require('./_store');
const { sign } = require('./_ownerToken');

const DEFAULT_OWNER_EMAIL = 'uday.dot.offical@gmail.com';

let storeOverride = null, cache = { at: 0, rec: undefined };
function store() { return storeOverride || getPlatformStore('owner'); }
function setStoreForTests(s) { storeOverride = s; cache = { at: 0, rec: undefined }; }

function ownerEmail() {
    const v = process.env.OWNER_EMAIL;
    return (v === undefined ? DEFAULT_OWNER_EMAIL : v).trim().toLowerCase();
}

// True only for a Google-VERIFIED email that matches the owner's (and the pinned sub, if set).
function isOwnerLogin(info) {
    const owner = ownerEmail();
    if (!owner || !info) return false;
    if (String(info.email_verified) !== 'true' || typeof info.email !== 'string') return false;
    if (info.email.trim().toLowerCase() !== owner) return false;
    const pinned = process.env.OWNER_GOOGLE_SUB;
    return !pinned || pinned === String(info.sub);
}

async function rememberOwner(sub, email) {
    cache = { at: Date.now(), rec: { sub, email: String(email).trim().toLowerCase() } };
    try { await store().setJSON('google-identity', cache.rec); } catch (e) { /* env pin / memory still work */ }
}

// Is this verified session sub the owner's account?
async function isOwnerSub(sub) {
    if (!ownerEmail() || !sub) return false;
    const pinned = process.env.OWNER_GOOGLE_SUB;
    if (pinned) return pinned === sub;
    if (Date.now() - cache.at > 5 * 60 * 1000 || cache.rec === undefined) {
        let rec = null;
        try { rec = await store().get('google-identity', { type: 'json' }); } catch (e) { rec = null; }
        cache = { at: Date.now(), rec };
    }
    return !!cache.rec && cache.rec.sub === sub && cache.rec.email === ownerEmail();
}

function issueOwnerToken() {
    return process.env.OWNER_TOKEN_SECRET ? sign(process.env.OWNER_TOKEN_SECRET) : null;
}

module.exports = { isOwnerLogin, rememberOwner, isOwnerSub, issueOwnerToken, ownerEmail, setStoreForTests };
