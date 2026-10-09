// Usage limits that protect the API keys (Groq / Tavily) and the auth routes.
//
//  - Auth routes: max 5 attempts per 15 minutes per client IP.
//  - Chat/voice: a per-minute burst limit plus a cap per person (signed-in user, else IP)
//    per 5-hour window, a background-helper allowance tied to real usage, and a global
//    daily circuit breaker.
//  - Owner mode (a verified owner token) skips every one of these.
//
// Everything is decided on the server from verified identity — nothing the browser says
// (a "guest" flag, a message count, a kind) can raise its own allowance. Counters live in
// Upstash Redis when UPSTASH_REDIS_REST_URL/TOKEN are set (atomic INCRBY — exact even under
// a burst of parallel requests), otherwise in the private Blob store (best-effort under
// parallel bursts), with an in-memory copy in front. Not a route (no exports.handler).

const crypto = require('crypto');
const { getPlatformStore } = require('./_store');
const { clientIp, ipKey, rateLimit, tooMany, json } = require('./_util');
const { verify: verifyOwner } = require('./_ownerToken');
const { verify: verifyUser } = require('./_userToken');

const num = (name, dflt) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n >= 0 ? n : dflt; };
const LIMITS = () => ({
    windowMs: Math.max(1, num('LIMIT_WINDOW_HOURS', 5)) * 60 * 60 * 1000, // how long a per-person allowance lasts
    guest: num('LIMIT_GUEST', 60),        // messages per window, not signed in
    user: num('LIMIT_USER', 150),         // messages per window, signed in with Google
    voice: num('LIMIT_VOICE', 40),        // voice turns (transcribe + speak) per window
    wake: num('LIMIT_WAKE', 300),         // short wake-phrase clips (phone "Hey Knowura") per window
    globalDaily: num('LIMIT_GLOBAL_DAILY', 5000),
    burstPerMin: num('LIMIT_BURST_PER_MIN', 10)
});

const DAY = 24 * 60 * 60 * 1000;
const AUTH_WINDOW = 15 * 60 * 1000;
const AUTH_MAX = 5;
const AUX_PER_CHAT = 3; // background helper calls (title/memory/summary) allowed per real message

let storeOverride = null; // tests inject an in-memory store
const mem = new Map();
function store() { return storeOverride || getPlatformStore('ratelimit'); }
function setStoreForTests(s) { storeOverride = s; mem.clear(); }
const keyOf = (bucket, id) => crypto.createHash('sha256').update(`${bucket}|${id}`).digest('hex').slice(0, 40);

// ─── atomic counters (Upstash Redis REST) ─────────────────────────────────
function redisConf() {
    const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
    return url && tok ? { url: url.replace(/\/$/, ''), tok } : null;
}
async function redisPipeline(conf, cmds) {
    const r = await fetch(`${conf.url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${conf.tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds),
        signal: AbortSignal.timeout(2500)
    });
    if (!r.ok) throw new Error(`redis ${r.status}`);
    const out = await r.json();
    if (!Array.isArray(out) || out.some(o => o?.error)) throw new Error('redis error');
    return out.map(o => o.result);
}
async function redisHit(conf, key, { max, windowMs, cost, peek }) {
    const k = `kw:${key}`, ttl = Math.ceil(windowMs / 1000);
    if (peek) {
        const [n, pttl] = await redisPipeline(conf, [['GET', k], ['PTTL', k]]);
        const used = Number(n || 0), retryAfter = Math.max(1, Math.ceil((Number(pttl) > 0 ? Number(pttl) : windowMs) / 1000));
        return { allowed: used < max, used, limit: max, remaining: Math.max(0, max - used), retryAfter };
    }
    const [n, , pttl] = await redisPipeline(conf, [['INCRBY', k, String(cost)], ['EXPIRE', k, String(ttl), 'NX'], ['PTTL', k]]);
    const used = Number(n);
    let ms = Number(pttl);
    if (!(ms > 0)) { ms = windowMs; redisPipeline(conf, [['EXPIRE', k, String(ttl)]]).catch(() => {}); } // never leave a key without an expiry
    const retryAfter = Math.max(1, Math.ceil(ms / 1000));
    if (used > max) {
        redisPipeline(conf, [['DECRBY', k, String(cost)]]).catch(() => {}); // a refused request doesn't use up allowance
        return { allowed: false, used: used - cost, limit: max, remaining: Math.max(0, max - (used - cost)), retryAfter };
    }
    return { allowed: true, used, limit: max, remaining: Math.max(0, max - used), retryAfter };
}

// Counts `cost` against a fixed window. peek=true reads without counting.
// -> { allowed, used, limit, remaining, retryAfter }
async function hit(bucket, id, { max, windowMs, cost = 1, peek = false }) {
    const key = keyOf(bucket, id), now = Date.now();

    const conf = redisConf();
    if (conf) { try { return await redisHit(conf, key, { max, windowMs, cost, peek }); } catch (e) { /* fall back to the Blob store */ } }

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
    const r = await hit(bucket, ipKey(event), { max, windowMs: AUTH_WINDOW });
    return r.allowed ? null : tooMany(r.retryAfter, `Too many attempts. Please wait ${Math.ceil(r.retryAfter / 60)} minutes and try again.`);
}
// Failures-only variants (Google sign-in): check first, record only the failures.
async function authBlocked(event, bucket, max = AUTH_MAX) {
    const r = await hit(bucket, ipKey(event), { max, windowMs: AUTH_WINDOW, peek: true });
    return r.allowed ? null : tooMany(r.retryAfter, `Too many failed attempts. Please wait ${Math.ceil(r.retryAfter / 60)} minutes and try again.`);
}
async function authFailure(event, bucket, max = AUTH_MAX) {
    await hit(bucket, ipKey(event), { max, windowMs: AUTH_WINDOW });
}

// ─── who is calling? ──────────────────────────────────────────────────────

// Reads the optional owner / user tokens from a request body and works out the identity
// that usage is counted against.  -> { owner, sub, id, kind: 'owner'|'user'|'guest' }
function whoIs(body, event) {
    const owner = verifyOwner(typeof body?.ownerToken === 'string' ? body.ownerToken : '', process.env.OWNER_TOKEN_SECRET);
    if (owner) return { owner: true, sub: null, id: 'owner', kind: 'owner' };
    const session = verifyUser(typeof body?.token === 'string' ? body.token : '', process.env.KNOWURA_USER_TOKEN_SECRET);
    if (session) return { owner: false, sub: session.sub, id: `u:${session.sub}`, kind: 'user' };
    return { owner: false, sub: null, id: `ip:${ipKey(event)}`, kind: 'guest' };
}

// ─── chat / voice usage ───────────────────────────────────────────────────

// The 429 the front end turns into the "limit reached" pop-up.
function limitResponse(kind, ident, r, L) {
    const hours = Math.max(1, Math.ceil(r.retryAfter / 3600));
    const mins = Math.max(1, Math.ceil(r.retryAfter / 60));
    const when = r.retryAfter < 5400 ? `${mins} minute${mins === 1 ? '' : 's'}` : `about ${hours} hour${hours === 1 ? '' : 's'}`;
    const span = `${Math.round(L.windowMs / 3600000)} hours`;
    const what = kind === 'voice' ? 'voice' : 'message';
    const error = ident.kind === 'guest'
        ? `You've used all ${r.limit} ${what}s for this ${span}. Sign in with Google for more, or try again in ${when}.`
        : `You've used all ${r.limit} ${what}s for this ${span}. You can send more in ${when}.`;
    return json(429, {
        error, limitReached: true, audience: ident.kind, what, limit: r.limit,
        resetIn: r.retryAfter, windowSeconds: Math.round(L.windowMs / 1000),
        upgradeTo: ident.kind === 'guest' ? (kind === 'voice' ? L.voice : L.user) : undefined
    }, { 'Retry-After': String(r.retryAfter) });
}

// kind: 'chat' (a message the person sent), 'aux' (background titles/summaries/memory),
// 'voice' (transcribe + speak), 'wake' (short phone wake-phrase clips). Owner mode is never limited.
// -> { response } to send back when blocked, or { usage: { limit, remaining } }.
async function usageGate(event, ident, kind = 'chat', cost = 1) {
    if (ident.owner) return { usage: null };
    const L = LIMITS();

    const wait = rateLimit(event, `burst-${kind}`, L.burstPerMin * (kind === 'aux' ? 4 : 1), 60 * 1000, ident.id);
    if (wait) return { response: tooMany(wait, `You're sending messages too fast — try again in ${wait} seconds.`) };

    const perWindow = kind === 'voice' ? L.voice : kind === 'wake' ? L.wake : ident.kind === 'user' ? L.user : L.guest;

    // Background helper calls can't be used as a side door: the client only *says* a call is
    // "aux", so they're allowed only in proportion to the real messages already sent.
    if (kind === 'aux') {
        const chat = await hit('window-chat', ident.id, { max: perWindow, windowMs: L.windowMs, peek: true });
        const aux = await hit('window-aux', ident.id, { max: perWindow * AUX_PER_CHAT + AUX_PER_CHAT, windowMs: L.windowMs, peek: true });
        if (aux.used + cost > chat.used * AUX_PER_CHAT + AUX_PER_CHAT) {
            return { response: json(429, { error: "Too many background requests — send a message first.", limitReached: false }, { 'Retry-After': '60' }) };
        }
    }
    const max = kind === 'aux' ? perWindow * AUX_PER_CHAT + AUX_PER_CHAT : perWindow;

    // wake-phrase clips are tiny and capped per person, so they don't count toward (or trip) the global chat breaker
    const g = kind === 'wake' ? { allowed: true } : await hit('global-daily', 'all', { max: L.globalDaily, windowMs: DAY, cost });
    if (!g.allowed) return { response: json(503, { error: "Knowura is very busy right now. Please try again a little later." }, { 'Retry-After': String(g.retryAfter) }) };

    const r = await hit(`window-${kind}`, ident.id, { max, windowMs: L.windowMs, cost });
    if (!r.allowed) return { response: limitResponse(kind, ident, r, L) };
    return { usage: { limit: r.limit, remaining: r.remaining, resetIn: r.retryAfter } };
}

module.exports = { hit, authAttempt, authBlocked, authFailure, whoIs, usageGate, setStoreForTests, LIMITS, AUTH_MAX, AUTH_WINDOW };
