// Security-focused tests: payload limits, origin checks, rate limits, owner exemption, input cleaning.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OWNER_TOKEN_SECRET = 'owner-secret';
process.env.KNOWURA_USER_TOKEN_SECRET = 'user-secret';
process.env.LIMIT_GUEST = '3';
process.env.LIMIT_USER = '5';

// Every route's storage is an in-memory fake (installed before any route is required), so nothing
// here ever touches a real Blob store.
const makeFake = () => { const m = new Map(); return { async get(k) { return m.get(k) ?? null; }, async setJSON(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); } }; };
const stores = {};
require('../functions/_store').getPlatformStore = (name) => (stores[name] ||= makeFake());

const util = require('../functions/_util');
const limits = require('../functions/_limits');
const owner = require('../functions/_ownerToken');
const user = require('../functions/_userToken');
const askAi = require('../functions/ask-ai');
const chatSave = require('../functions/chat-save');
const pwVerify = require('../functions/owner-password-verify');
const { cleanCredentialResponse } = require('../functions/_webauthnInput');

// tiny in-memory stand-in for the Blob store so limits are tested exactly as they'd persist
const fakeStore = makeFake;
const ev = (body, extra = {}) => ({ httpMethod: 'POST', headers: { 'x-forwarded-for': '7.7.7.7', host: 'knowura.test', ...(extra.headers || {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('readJson rejects oversized, malformed and non-object bodies', () => {
    assert.equal(util.readJson(ev('x'.repeat(200)), 100).error.statusCode, 413);
    assert.equal(util.readJson(ev('{nope'), 1000).error.statusCode, 400);
    assert.equal(util.readJson(ev('[1,2]'), 1000).error.statusCode, 400);
    assert.equal(util.readJson(ev('null'), 1000).error.statusCode, 400);
    assert.equal(util.readJson(ev(''), 1000, { allowEmpty: false }).error.statusCode, 400);
    assert.deepEqual(util.readJson(ev({ a: 1 }), 1000).body, { a: 1 });
    assert.equal(util.readJson({ httpMethod: 'POST', headers: { 'content-length': '999999' }, body: '{}' }, 1000).error.statusCode, 413);
});

test('guard: method allow-list and same-origin check', () => {
    assert.equal(util.guard({ httpMethod: 'GET', headers: {} }).statusCode, 405);
    assert.equal(util.guard({ httpMethod: 'OPTIONS', headers: {} }).statusCode, 204);
    assert.equal(util.guard(ev({}, { headers: { origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal(util.guard(ev({}, { headers: { origin: 'https://knowura.test' } })), null);
    assert.equal(util.guard(ev({})), null); // no Origin header (curl/server) is allowed through to the rate limits
});

test('cleanStr strips control characters and enforces length/type', () => {
    assert.equal(util.cleanStr('he\u0000llo\u0007', 10), 'hello');
    assert.equal(util.cleanStr('toolong', 3), null);
    assert.equal(util.cleanStr(123, 10), null);
    assert.equal(util.cleanStr('', 10, 1), null);
});

test('auth routes: 5 attempts per 15 minutes, then 429', async () => {
    limits.setStoreForTests(fakeStore());
    for (let i = 0; i < 5; i++) assert.equal(await limits.authAttempt(ev({}), 'owner-password'), null);
    const blocked = await limits.authAttempt(ev({}), 'owner-password');
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['Retry-After']) > 0);
    // a different IP is unaffected
    assert.equal(await limits.authAttempt({ httpMethod: 'POST', headers: { 'x-forwarded-for': '8.8.8.8' } }, 'owner-password'), null);
});

test('owner-password route locks out after 5 wrong guesses', async () => {
    limits.setStoreForTests(fakeStore());
    process.env.OWNER_PASSWORD = 'correct horse';
    let last;
    for (let i = 0; i < 6; i++) last = await pwVerify.handler(ev({ password: 'wrong' + i }));
    assert.equal(last.statusCode, 429);
    // even the right password is refused while locked out
    assert.equal((await pwVerify.handler(ev({ password: 'correct horse' }))).statusCode, 429);
});

test('failed Google sign-ins are counted, successful ones are not', async () => {
    limits.setStoreForTests(fakeStore());
    for (let i = 0; i < 5; i++) await limits.authFailure(ev({}), 'google-signin-fail');
    assert.equal((await limits.authBlocked(ev({}), 'google-signin-fail')).statusCode, 429);
});

test('message caps per 5-hour window: guest, signed-in user, and owner is exempt', async () => {
    limits.setStoreForTests(fakeStore());
    const guest = limits.whoIs({}, ev({}));
    assert.equal(guest.kind, 'guest');
    for (let i = 0; i < 3; i++) assert.ok((await limits.usageGate(ev({}), guest)).usage);
    const blocked = await limits.usageGate(ev({}), guest);
    assert.equal(blocked.response.statusCode, 429);
    assert.match(JSON.parse(blocked.response.body).error, /Sign in with Google/);
    assert.match(JSON.parse(blocked.response.body).error, /5 hours/);
    assert.ok(Number(blocked.response.headers['Retry-After']) <= 5 * 3600);
    assert.equal(limits.LIMITS().windowMs, 5 * 3600 * 1000);
    assert.equal(limits.LIMITS().guest, 3); // (env override in this test; the default is 60)

    const token = user.sign('google|1', 'user-secret');
    const u = limits.whoIs({ token }, ev({}));
    assert.equal(u.kind, 'user');
    for (let i = 0; i < 5; i++) assert.ok((await limits.usageGate(ev({}, { headers: { 'x-forwarded-for': '1.1.1.1' } }), u)).usage !== undefined);
    assert.equal((await limits.usageGate(ev({}), u)).response.statusCode, 429);

    const o = limits.whoIs({ ownerToken: owner.sign('owner-secret') }, ev({}));
    assert.equal(o.owner, true);
    for (let i = 0; i < 200; i++) assert.equal((await limits.usageGate(ev({}), o)).response, undefined);
});

test('ask-ai handler: rejects bad payloads and enforces the cap before touching the API', async () => {
    limits.setStoreForTests(fakeStore());
    assert.equal((await askAi.handler(ev('not json'))).statusCode, 400);
    assert.equal((await askAi.handler(ev('x'.repeat(400 * 1024)))).statusCode, 413);
    assert.equal((await askAi.handler(ev({ messages: 'hi' }))).statusCode, 400);
    assert.equal((await askAi.handler({ httpMethod: 'GET', headers: {} })).statusCode, 405);

    // use up the guest's daily cap, then the handler must answer 429 without calling Groq
    const guest = limits.whoIs({}, ev({}));
    for (let i = 0; i < 3; i++) await limits.usageGate(ev({}), guest);
    const res = await askAi.handler(ev({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(res.statusCode, 429);
});

test('chat-save rebuilds the document from a whitelist and drops junk', () => {
    const doc = chatSave._test.cleanDoc({
        chats: [
            { id: 'c_1', title: 'ok', createdAt: 1, updatedAt: 2, messages: [{ text: 'hi', type: 'user' }, { text: 'x', type: 'evil' }, { text: 5, type: 'ai' }], extra: 'zzz' },
            { id: '../../etc', messages: [] },     // bad id -> dropped
            'not an object'
        ],
        activeChatId: 'nope', memory: { summary: 's', facts: ['a', 7, 'b'] }, profile: { sub: 'attacker', given_name: 'Me' }, __proto__: { polluted: true }, admin: true
    }, 'real-sub');
    assert.equal(doc.profile.sub, 'real-sub');
    assert.equal(doc.chats.length, 1);
    assert.deepEqual(doc.chats[0].messages, [{ text: 'hi', type: 'user' }]);
    assert.equal(doc.chats[0].extra, undefined);
    assert.equal(doc.activeChatId, null);
    assert.deepEqual(doc.memory.facts, ['a', 'b']);
    assert.equal(doc.admin, undefined);
});

test('webauthn payload shape check', () => {
    const good = { id: 'abc_-', rawId: 'abc_-', type: 'public-key', response: { clientDataJSON: 'abcd', authenticatorData: 'abcd', signature: 'abcd' } };
    assert.ok(cleanCredentialResponse(good));
    assert.equal(cleanCredentialResponse({ ...good, type: 'password' }), null);
    assert.equal(cleanCredentialResponse({ ...good, id: '<script>' }), null);
    assert.equal(cleanCredentialResponse({ ...good, response: { clientDataJSON: 'x'.repeat(9000) } }), null);
    assert.equal(cleanCredentialResponse('nope'), null);
});

test('no credentials are committed to the repo', () => {
    const found = require('../scripts/check-secrets').scan();
    assert.deepEqual(found, []);
});

test('every endpoint rejects wrong methods, cross-origin calls, malformed and oversized bodies', async () => {
    const fs = require('fs'), path = require('path');
    limits.setStoreForTests(fakeStore());
    const dir = path.join(__dirname, '..', 'functions');
    const routes = fs.readdirSync(dir).filter(f => /^[a-z-]+\.js$/.test(f) && !f.startsWith('_'));
    assert.ok(routes.length >= 12);
    let n = 0;
    const e = (m, body, headers = {}) => ({ httpMethod: m, headers: { host: 'k.test', 'x-forwarded-for': `4.4.${++n % 250}.${Math.floor(n / 250)}`, ...headers }, body });
    for (const f of routes) {
        const { handler } = require(path.join(dir, f));
        assert.equal((await handler(e('DELETE', '{}'))).statusCode, 405, `${f}: wrong method`);
        assert.equal((await handler(e('POST', '{}', { origin: 'https://evil.example' }))).statusCode, 403, `${f}: cross-origin`);
        assert.equal((await handler(e('POST', '{bad json'))).statusCode, 400, `${f}: malformed`);
        assert.equal((await handler(e('POST', 'x'.repeat(5 * 1024 * 1024)))).statusCode, 413, `${f}: oversized`);
    }
});

// ── bypass hunting ─────────────────────────────────────────────────────────

test('client-supplied IP headers cannot mint new identities', () => {
    const save = { V: process.env.VERCEL, N: process.env.NETLIFY };
    try {
        process.env.VERCEL = '1'; delete process.env.NETLIFY;
        assert.equal(util.clientIp({ headers: { 'x-nf-client-connection-ip': '9.9.9.9', 'x-vercel-forwarded-for': '1.2.3.4' } }), '1.2.3.4');
        delete process.env.VERCEL; process.env.NETLIFY = 'true';
        assert.equal(util.clientIp({ headers: { 'x-forwarded-for': 'evil', 'x-nf-client-connection-ip': '5.6.7.8' } }), '5.6.7.8');
    } finally { save.V === undefined ? delete process.env.VERCEL : process.env.VERCEL = save.V; save.N === undefined ? delete process.env.NETLIFY : process.env.NETLIFY = save.N; }
    // rotating addresses inside one IPv6 /64 is still one identity
    assert.equal(util.ipKey({ headers: { 'x-forwarded-for': '2001:db8:abcd:12::1' } }), util.ipKey({ headers: { 'x-forwarded-for': '2001:db8:abcd:12:ffff:1:2:3' } }));
    assert.notEqual(util.ipKey({ headers: { 'x-forwarded-for': '2001:db8:abcd:13::1' } }), util.ipKey({ headers: { 'x-forwarded-for': '2001:db8:abcd:12::1' } }));
});

test('"aux" background calls are not a side door around the message cap', async () => {
    limits.setStoreForTests(fakeStore());
    const guest = limits.whoIs({}, ev({}));
    let ok = 0;
    for (let i = 0; i < 50; i++) if ((await limits.usageGate(ev({}, { headers: { 'x-forwarded-for': '6.6.6.6' } }), guest, 'aux')).usage !== undefined) ok++;
    assert.ok(ok <= 3, `aux-only spam let ${ok} calls through`);       // no real messages sent -> only the tiny grace amount
    await limits.usageGate(ev({}), guest, 'chat');                        // after one real message a few more are allowed
    let more = 0;
    for (let i = 0; i < 20; i++) if ((await limits.usageGate(ev({}, { headers: { 'x-forwarded-for': '6.6.6.7' } }), guest, 'aux')).usage !== undefined) more++;
    assert.ok(more <= 4);
});

test('limit-reached response carries what the pop-up needs', async () => {
    limits.setStoreForTests(fakeStore());
    const e2 = ev({}, { headers: { 'x-forwarded-for': '10.20.30.40' } });
    const guest = limits.whoIs({}, e2);
    for (let i = 0; i < 3; i++) await limits.usageGate(e2, guest);
    const body = JSON.parse((await limits.usageGate(e2, guest)).response.body);
    assert.equal(body.limitReached, true);
    assert.equal(body.audience, 'guest');
    assert.equal(body.limit, 3);
    assert.equal(body.windowSeconds, 5 * 3600);
    assert.ok(body.resetIn > 0 && body.resetIn <= 5 * 3600);
});

test('Redis counters are atomic: a burst of parallel requests cannot exceed the cap', async () => {
    const data = new Map(), realFetch = global.fetch;
    global.fetch = async (url, opts) => {
        const cmds = JSON.parse(opts.body);
        const out = cmds.map(([c, k, v]) => {
            if (c === 'INCRBY') { data.set(k, (data.get(k) || 0) + Number(v)); return { result: data.get(k) }; }
            if (c === 'DECRBY') { data.set(k, (data.get(k) || 0) - Number(v)); return { result: data.get(k) }; }
            if (c === 'GET') return { result: data.has(k) ? String(data.get(k)) : null };
            if (c === 'PTTL') return { result: 3600000 };
            return { result: 1 }; // EXPIRE
        });
        return { ok: true, json: async () => out };
    };
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example'; process.env.UPSTASH_REDIS_REST_TOKEN = 't';
    try {
        const results = await Promise.all(Array.from({ length: 60 }, () => limits.hit('t-bucket', 'someone', { max: 5, windowMs: 3600000 })));
        assert.equal(results.filter(r => r.allowed).length, 5);
        assert.equal([...data.values()][0], 5); // refused requests were given back
    } finally { global.fetch = realFetch; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN; }
});

test('owner Google login: verified owner email only', async () => {
    const o = require('../functions/_owner');
    o.setStoreForTests(fakeStore());
    const good = { email: 'Uday.Dot.Offical@gmail.com', email_verified: 'true', sub: '111' };
    assert.equal(o.isOwnerLogin(good), true);                                        // case-insensitive
    assert.equal(o.isOwnerLogin({ ...good, email_verified: 'false' }), false);       // unverified never counts
    assert.equal(o.isOwnerLogin({ ...good, email: 'someone.else@gmail.com' }), false);
    assert.equal(o.isOwnerLogin({ ...good, email: 'uday.dot.offical@gmail.com.evil.com' }), false);
    assert.equal(o.isOwnerLogin(null), false);
    process.env.OWNER_GOOGLE_SUB = '999';
    assert.equal(o.isOwnerLogin(good), false);                                       // pinned to a different account
    delete process.env.OWNER_GOOGLE_SUB;
    process.env.OWNER_EMAIL = '';
    assert.equal(o.isOwnerLogin(good), false);                                       // disabled by an empty OWNER_EMAIL
    delete process.env.OWNER_EMAIL;

    await o.rememberOwner('111', good.email);
    assert.equal(await o.isOwnerSub('111'), true);
    assert.equal(await o.isOwnerSub('222'), false);
    assert.ok(o.issueOwnerToken());
});

test('chat-load renews owner mode only for the owner account', async () => {
    const chatLoad = require('../functions/chat-load');
    const o = require('../functions/_owner');
    o.setStoreForTests(fakeStore());
    await o.rememberOwner('owner-sub', 'uday.dot.offical@gmail.com');
    const call = async (sub) => JSON.parse((await chatLoad.handler(ev({ token: user.sign(sub, 'user-secret') }))).body);
    const ownerBody = await call('owner-sub');
    assert.ok(ownerBody.ownerToken && owner.verify(ownerBody.ownerToken, 'owner-secret'));
    assert.equal((await call('random-sub')).ownerToken, undefined);
});


test('the everyday system prompt has nothing secret in it for the thinking panel to reveal', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'functions', 'ask-ai.js'), 'utf8');
    const base = src.slice(src.indexOf('const baseSystemPrompt = `'), src.indexOf('const ownerSystemPrompt = `'));
    assert.ok(base.length > 100);
    assert.doesNotMatch(base, /hidden|secret|owner|unlock|security key|password|clueless|never|must|instruction|policy|rule|refuse|reveal/i);
    assert.ok(base.length < 400, 'keep the everyday prompt short so the model has little to echo');
    assert.match(src, /reasoning/); // thinking still passes through untouched (no redaction step)
    assert.equal(require('fs').existsSync(require('path').join(__dirname, '..', 'functions', '_redact.js')), false);
});


test('memory notes and web results travel as user text, never inside the system prompt', () => {
    const msgs = askAi._test.buildMessages('SYS', 'About me: likes chemistry', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'latest news?' }], '\n\n[Web results]');
    assert.equal(msgs[0].content, 'SYS');
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[1].content, /chemistry/);
    assert.match(msgs[msgs.length - 1].content, /latest news\?\n\n\[Web results\]/);
    assert.equal(msgs[2].content, 'hi');                 // earlier turns untouched
    assert.doesNotMatch(msgs[0].content, /chemistry|Web results/);
});


test('the creator is only named when asked, not volunteered', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'functions', 'ask-ai.js'), 'utf8');
    const base = src.slice(src.indexOf('const baseSystemPrompt = `'), src.indexOf('const ownerSystemPrompt = `'));
    assert.match(base, /^const baseSystemPrompt = `You are Knowura, an AI study helper\./);   // identity first, no name-drop
    assert.match(base, /If someone asks who made you/);
});

test('phone wake-phrase clips have their own allowance and never trip the global chat breaker', async () => {
    limits.setStoreForTests(fakeStore());
    process.env.LIMIT_WAKE = '2';
    process.env.LIMIT_GLOBAL_DAILY = '1';
    try {
        const guest = limits.whoIs({}, ev({}));
        assert.ok((await limits.usageGate(ev({}), guest, 'wake')).usage);
        assert.ok((await limits.usageGate(ev({}), guest, 'wake')).usage);
        assert.equal((await limits.usageGate(ev({}), guest, 'wake')).response.statusCode, 429); // its own cap
        // the global daily breaker (1 here) still has room for a real chat message
        assert.ok((await limits.usageGate(ev({}), guest, 'chat')).usage);
    } finally { delete process.env.LIMIT_WAKE; delete process.env.LIMIT_GLOBAL_DAILY; }
});
