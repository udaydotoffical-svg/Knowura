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
const deviceLink = require('../functions/device-link');
const deviceSession = require('../functions/device-session');
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
    assert.equal((await askAi.handler(ev('x'.repeat(4 * 1024 * 1024)))).statusCode, 413);
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

test('owner mode is never switched on by signing in: chat-load only says whether the account is the owner\'s', async () => {
    const chatLoad = require('../functions/chat-load');
    const o = require('../functions/_owner');
    o.setStoreForTests(fakeStore());
    await o.rememberOwner('owner-sub', 'uday.dot.offical@gmail.com');
    const call = async (sub) => JSON.parse((await chatLoad.handler(ev({ token: user.sign(sub, 'user-secret') }))).body);
    const ownerBody = await call('owner-sub');
    assert.equal(ownerBody.ownerToken, undefined);          // no automatic owner mode
    assert.equal(ownerBody.ownerEligible, true);
    const other = await call('random-sub');
    assert.equal(other.ownerToken, undefined); assert.equal(other.ownerEligible, false);
});

test('owner-enable gives an owner token (no password) only to a signed-in owner Google account', async () => {
    const enable = require('../functions/owner-enable');
    const o = require('../functions/_owner');
    o.setStoreForTests(fakeStore());
    await o.rememberOwner('owner-sub', 'uday.dot.offical@gmail.com');
    const call = async (token) => enable.handler(ev({ token }));
    const good = await call(user.sign('owner-sub', 'user-secret'));
    assert.equal(good.statusCode, 200);
    assert.ok(owner.verify(JSON.parse(good.body).ownerToken, 'owner-secret'));
    assert.equal((await call(user.sign('random-sub', 'user-secret'))).statusCode, 403);   // someone else
    assert.equal((await call('not.a.token')).statusCode, 401);                              // not signed in
    assert.equal((await call(undefined)).statusCode, 401);
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


test('device link: the app links an install to an account and prefs; the panel gets the same sign-in; sign-out unlinks', async () => {
    const id = 'A'.repeat(22) + 'b'.repeat(10);
    const body = (o) => ev(JSON.stringify(o), { headers: { 'x-forwarded-for': '9.9.9.' + Math.floor(Math.random() * 200) } });
    // nothing linked yet -> not linked, no prefs
    let r = JSON.parse((await deviceSession.handler(body({ installId: id }))).body);
    assert.deepEqual(r, { linked: false, prefs: { assistantModel: '' } });
    // a bad token can't link
    assert.equal((await deviceLink.handler(body({ installId: id, token: 'nope' }))).statusCode, 401);
    // a real session token links it, with the chosen assistant model
    const tok = user.sign('google|42', 'user-secret');
    assert.equal((await deviceLink.handler(body({ installId: id, token: tok, profile: { given_name: 'Uday', email: 'u@x.com', picture: 'https://lh3.googleusercontent.com/a' }, prefs: { assistantModel: 'openai/gpt-oss-120b' } }))).statusCode, 200);
    r = JSON.parse((await deviceSession.handler(body({ installId: id }))).body);
    assert.equal(r.linked, true);
    assert.deepEqual(user.verify(r.token, 'user-secret'), { sub: 'google|42' });
    assert.equal(r.profile.given_name, 'Uday');
    assert.equal(r.prefs.assistantModel, 'openai/gpt-oss-120b');
    // changing only the model keeps the link
    await deviceLink.handler(body({ installId: id, prefs: { assistantModel: 'bad model!' } }));
    r = JSON.parse((await deviceSession.handler(body({ installId: id }))).body);
    assert.equal(r.linked, true); assert.equal(r.prefs.assistantModel, ''); // invalid ids are dropped
    // sign out in the app -> the panel is signed out too
    await deviceLink.handler(body({ installId: id, unlink: true }));
    r = JSON.parse((await deviceSession.handler(body({ installId: id }))).body);
    assert.equal(r.linked, false);
    // ids that aren't long random strings are refused, and nothing is stored in plain text
    assert.equal((await deviceSession.handler(body({ installId: 'short' }))).statusCode, 400);
});


test('ask-ai attachments: only small data-URL images from users, newest 3 kept, file text allowed, search ignores attached text', () => {
    const { sanitizeMessages, textOf, isVision, pickVisionModel, needsSearch } = askAi._test;
    const img = (n = 10) => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'A'.repeat(n) } });
    // good image parts survive; a missing text part is added
    let out = sanitizeMessages([{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, img()] }]);
    assert.equal(out[0].content.length, 2);
    out = sanitizeMessages([{ role: 'user', content: [img()] }]);
    assert.equal(out[0].content[0].type, 'text');
    // anything a model could fetch, odd types, huge images and assistant-supplied parts are dropped
    const evil = [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'https://evil.example/x.png' } },
        { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1500000) } },
        { type: 'image_url', image_url: { url: 'file:///etc/passwd' } }
    ];
    assert.equal(sanitizeMessages([{ role: 'user', content: evil }])[0].content.length, 1);
    assert.equal(sanitizeMessages([{ role: 'assistant', content: [img()] }]), null);
    // at most the newest 3 images are kept across the conversation
    const many = [1, 2, 3, 4, 5].map(i => ({ role: 'user', content: [{ type: 'text', text: 'q' + i }, img(10 + i)] }));
    const kept = sanitizeMessages(many);
    const count = kept.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0), 0);
    assert.equal(count, 3);
    assert.match(textOf(kept[0].content), /left out/);
    // user turns may carry long file text; assistant turns stay capped
    assert.equal(sanitizeMessages([{ role: 'user', content: 'x'.repeat(60000) }])[0].content.length, 60000);
    assert.ok(sanitizeMessages([{ role: 'assistant', content: 'x'.repeat(60000) }])[0].content.length <= 16000);
    // attached text must not trigger a web search; the question itself still can
    assert.equal(needsSearch(('summarize this' + '\n\n[Attached file: a.txt]\nthe latest news today').split(/\n\n\[Attached /)[0]), false);
    // vision routing
    const avail = [{ id: 'openai/gpt-oss-20b' }, { id: 'meta-llama/llama-4-scout-17b-16e-instruct' }, { id: 'qwen/qwen3.6-27b' }];
    assert.equal(isVision('openai/gpt-oss-20b'), false);
    assert.equal(pickVisionModel(avail, 'openai/gpt-oss-20b'), 'qwen/qwen3.6-27b');
    assert.equal(pickVisionModel(avail, 'meta-llama/llama-4-scout-17b-16e-instruct'), 'meta-llama/llama-4-scout-17b-16e-instruct');
    assert.equal(pickVisionModel([{ id: 'openai/gpt-oss-20b' }], 'openai/gpt-oss-20b'), null);
});

test('safety check: Llama Guard blocks unsafe pictures and text, self-harm gets care, failures fail safe', async () => {
    const safety = require('../functions/_safety');
    const realFetch = global.fetch;
    const reply = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });
    const img = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };
    const picMsg = [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, img] }];
    const txtMsg = [{ role: 'user', content: 'how do plants grow' }];
    let calls = [];
    try {
        // unsafe picture -> blocked, and the picture really was sent to the image-capable guard
        global.fetch = async (url, o) => { calls.push(JSON.parse(o.body)); return reply('unsafe\nS12'); };
        let r = await safety.moderate({ messages: picMsg, guards: ['meta-llama/llama-guard-4-12b', 'openai/gpt-oss-safeguard-20b'] });
        assert.equal(r.blocked, true); assert.equal(r.onPicture, true);
        assert.equal(calls[0].model, 'meta-llama/llama-guard-4-12b');
        assert.equal(calls[0].messages[0].content[1].type, 'image_url');
        // safe picture and safe text pass
        global.fetch = async () => reply('safe');
        assert.equal((await safety.moderate({ messages: picMsg, guards: ['meta-llama/llama-guard-4-12b'] })).blocked, false);
        assert.equal((await safety.moderate({ messages: txtMsg, guards: ['meta-llama/llama-guard-4-12b'] })).blocked, false);
        // blocked categories vs categories that are only answered with care or not blocked at all
        global.fetch = async () => reply('unsafe\nS4');
        assert.equal((await safety.moderate({ messages: txtMsg, guards: ['meta-llama/llama-guard-4-12b'] })).blocked, true);
        global.fetch = async () => reply('unsafe\nS11');
        r = await safety.moderate({ messages: txtMsg, guards: ['meta-llama/llama-guard-4-12b'] });
        assert.equal(r.blocked, false); assert.equal(r.care, true);
        global.fetch = async () => reply('unsafe\nS6');                 // specialized advice: not blocked in a study app
        assert.equal((await safety.moderate({ messages: txtMsg, guards: ['meta-llama/llama-guard-4-12b'] })).blocked, false);
        // no image-capable guard -> a vision chat model classifies the picture instead (JSON answer)
        calls = [];
        global.fetch = async (url, o) => { calls.push(JSON.parse(o.body)); return reply('{"unsafe":true,"categories":["S12"]}'); };
        r = await safety.moderate({ messages: picMsg, guards: ['openai/gpt-oss-safeguard-20b'], visionChat: 'qwen/qwen3.6-27b' });
        assert.equal(r.blocked, true); assert.equal(calls[0].model, 'qwen/qwen3.6-27b');
        // gpt-oss-safeguard for text carries the policy as the system message
        calls = [];
        global.fetch = async (url, o) => { calls.push(JSON.parse(o.body)); return reply('{"unsafe":false,"categories":[]}'); };
        await safety.moderate({ messages: txtMsg, guards: ['openai/gpt-oss-safeguard-20b'] });
        assert.equal(calls[0].messages[0].role, 'system');
        // failing safe: text goes through if the guard is down, a picture that can't be checked is refused
        global.fetch = async () => { throw new Error('network down'); };
        assert.equal((await safety.moderate({ messages: txtMsg, guards: ['meta-llama/llama-guard-4-12b'] })).blocked, false);
        r = await safety.moderate({ messages: picMsg, guards: ['meta-llama/llama-guard-4-12b'], visionChat: 'qwen/qwen3.6-27b' });
        assert.equal(r.blocked, true); assert.equal(r.unchecked, true);
        assert.equal((await safety.moderate({ messages: picMsg, guards: [] })).unchecked, true);
        assert.equal((await safety.moderate({ messages: txtMsg, guards: [] })).blocked, false);
    } finally { global.fetch = realFetch; }
});
