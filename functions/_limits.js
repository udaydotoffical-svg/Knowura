// Usage limits that protect the API keys (Groq / Tavily) and the auth routes.
//
//  - Auth routes: max 5 attempts per 15 minutes per client IP, counted in the
//    persistent store so it holds across serverless instances (falls back to memory
//    if the store isn't reachable — it never blocks requests because storage is down).
//  - Chat/voice: a per-minute burst limit plus a cap per person (signed-in user or IP) per
//    rolling-ish 5-hour window, a small cap for background helper calls, and a global
//    daily circuit breaker.
//  - Owner mode (a verified owner token) skips every one of these.
//
// Limits are tunable with env vars (see .env.example). Not a route (no exports.handler).

const crypto = require('crypto');
const { getPlatformStore } = require('./_store');
const { clientIp, rateLimit, tooMany, json } = require('./_util');
const { verify: verifyOwner } = require('./_ownerToken');
const { verify: verifyUser } = require('./_userToken');

const num = (name, dflt) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n >= 0 ? n : dflt; };
const LIMITS = () => ({
    windowMs: Math.max(1, num('LIMIT_WINDOW_HOURS', 5)) * 60 * 60 * 1000, // how long a per-person allowance lasts
    guest: num('LIMIT_GUEST', 60),        // messages per window, not signed in
    user: num('LIMIT_USER', 150),         // messages per window, signed in with Google
    voice: num('LIMIT_VOICE', 40),        // voice turns (transcribe + speak) per window
    globalDaily: num('LIMIT_GLOBAL_DAILY', 5000),
    burstPerMin: num('LIMIT_BURST_PER_MIN', 10)
});

const DAY = 24 * 60 * 60 * 1000;
const AUTH_WINDOW = 15 * 60 * 1000;
const AUTH_MAX = 5;

let storeOverride = null; // tests inject an in-memory store
const mem = new Map();
function store() { return storeOverride || getPlatformStore('ratelimit'); }
function setStoreForTests(s) { storeOverride = s; mem.clear(); }
const keyOf = (bucket, id) => crypto.createHash('sha256').update(`${bucket}|${id}`).digest('hex').slice(0, 40);

// Counts `cost` against a fixed window. peek=true reads without counting.
// -> { allowed, used, limit, remaining, retryAfter }
async function hit(bucket, id, { max, windowMs, cost = 1, peek = false }) {
    const key = keyOf(bucket, id), now = Date.now();
    let rec = null;
    try { rec = await store().get(key, { type: 'json' }); } catch (e) { rec = null; }
    const m = mem.get(key);
    if (!rec || !(rec.resetAt > now)) rec = (m && m.resetAt > now) ? { ...m } : { n: 0, resetAt: now + windowMs };
    else if (m && m.resetAt === rec.resetAt && m.n > rec.n) rec = { ...m }; // memory ahead of a lagging store
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));

    if (peek) return { allowed: rec.n < max, used: rec.n, limit: max, remaining: Math.max(0, max - rec.n), retryAfter };
    if (rec.n + cost > max) return { allowed: false, used: rec.n, limit: max, remaining: Math.max(0, max - rec.n), retryAfter };

    rec.n += cost;
    mem.set(key, rec);
    if (mem.size > 5000) for (const [k, v] of mem) if (v.resetAt <= now) mem.delete(k);
    try { await store().setJSON(key, rec); } catch (e) { /* memory copy still applies */ }
    return { allowed: true, used: rec.n, limit: max, remaining: Math.max(0, max - rec.n), retryAfter };
}

// ─── auth routes: 5 attempts / 15 min / IP ────────────────────────────────

// Count an attempt; returns a 429 response when over the limit, else null.
async function authAttempt(event, bucket, max = AUTH_MAX) {
    const r = await hit(bucket, clientIp(event), { max, windowMs: AUTH_WINDOW });
    return r.allowed ? null : tooMany(r.retryAfter, `Too many attempts. Please wait ${Math.ceil(r.retryAfter / 60)} minutes and try again.`);
}
// Failures-only variants (Google sign-in): check first, record only the failures.
async function authBlocked(event, bucket, max = AUTH_MAX) {
    const r = await hit(bucket, clientIp(event), { max, windowMs: AUTH_WINDOW, peek: true });
    return r.allowed ? null : tooMany(r.retryAfter, `Too many failed attempts. Please wait ${Math.ceil(r.retryAfter / 60)} minutes and try again.`);
}
async function authFailure(event, bucket, max = AUTH_MAX) {
    await hit(bucket, clientIp(event), { max, windowMs: AUTH_WINDOW });
}

// ─── who is calling? ──────────────────────────────────────────────────────

// Reads the optional owner / user tokens from a request body and works out the identity
// that usage is counted against.  -> { owner, sub, id, kind: 'owner'|'user'|'guest' }
function whoIs(body, event) {
    const owner = verifyOwner(typeof body?.ownerToken === 'string' ? body.ownerToken : '', process.env.OWNER_TOKEN_SECRET);
    if (owner) return { owner: true, sub: null, id: 'owner', kind: 'owner' };
    const session = verifyUser(typeof body?.token === 'string' ? body.token : '', process.env.KNOWURA_USER_TOKEN_SECRET);
    if (session) return { owner: false, sub: session.sub, id: `u:${session.sub}`, kind: 'user' };
    return { owner: false, sub: null, id: `ip:${clientIp(event)}`, kind: 'guest' };
}

// ─── chat / voice usage ───────────────────────────────────────────────────

// kind: 'chat' (a message the person sent), 'aux' (background titles/summaries/memory),
// 'voice' (transcribe + speak). Owner mode is never limited.
// -> { response } to send back when blocked, or { usage: { limit, remaining } }.
async function usageGate(event, ident, kind = 'chat', cost = 1) {
    if (ident.owner) return { usage: null };
    const L = LIMITS();

    const wait = rateLimit(event, `burst-${kind}`, L.burstPerMin * (kind === 'aux' ? 4 : 1), 60 * 1000, ident.id);
    if (wait) return { response: tooMany(wait, `You're sending messages too fast — try again in ${wait} seconds.`) };

    const perWindow = kind === 'voice' ? L.voice : ident.kind === 'user' ? L.user : L.guest;
    const max = kind === 'aux' ? perWindow * 4 : perWindow;

    const g = await hit('global-daily', 'all', { max: L.globalDaily, windowMs: DAY, cost });
    if (!g.allowed) return { response: json(503, { error: "Knowura is very busy right now. Please try again a little later." }, { 'Retry-After': String(g.retryAfter) }) };

    const r = await hit(`window-${kind}`, ident.id, { max, windowMs: L.windowMs, cost });
    if (!r.allowed) {
        const hours = Math.max(1, Math.ceil(r.retryAfter / 3600));
        const mins = Math.max(1, Math.ceil(r.retryAfter / 60));
        const when = r.retryAfter < 5400 ? `${mins} minute${mins === 1 ? '' : 's'}` : `about ${hours} hour${hours === 1 ? '' : 's'}`;
        const span = `${Math.round(L.windowMs / 3600000)} hours`;
        const what = kind === 'voice' ? 'voice' : 'message';
        const msg = ident.kind === 'guest'
            ? `You've used all ${r.limit} ${what}s for this ${span}. Sign in with Google for more, or try again in ${when}.`
            : `You've used all ${r.limit} ${what}s for this ${span}. You can send more in ${when}.`;
        return { response: json(429, { error: msg }, { 'Retry-After': String(r.retryAfter) }) };
    }
    return { usage: { limit: r.limit, remaining: r.remaining } };
}

module.exports = { hit, authAttempt, authBlocked, authFailure, whoIs, usageGate, setStoreForTests, LIMITS, AUTH_MAX, AUTH_WINDOW };
