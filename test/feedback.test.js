const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.OWNER_TOKEN_SECRET = 'feedback-owner-secret';
const owner = require('../functions/_lib/_ownerToken');
const feedback = require('../functions/feedback');
const { REASONS, VOTE_SCRIPT, PRESENCE_SCRIPT, LEAVE_SCRIPT, ACTIVE_COUNT_SCRIPT, NOTE_TTL_SECONDS, IDEMPOTENCY_TTL_SECONDS, DAILY_TTL_SECONDS, SESSION_TTL_MS } = feedback._test;
const event = (body, method = 'POST', extraHeaders = {}) => ({
    httpMethod: method,
    headers: { host: 'knowura.test', 'x-forwarded-for': '1.2.3.4', ...extraHeaders },
    body: JSON.stringify(body)
});
const token = (value) => crypto.createHash('sha256').update(value).digest('hex');
const invoke = async (body, headers = {}) => feedback.handler(event(body, 'POST', headers));
const setDeps = (redisPipeline, requestLimit = async () => null) => {
    feedback._test.setDependencies({ redisPipeline, requestLimit });
};
function memoryRedis() {
    const active = new Map();
    const commands = [];
    return {
        active,
        commands,
        async pipeline(batch) {
            return batch.map((command) => {
                commands.push(command);
                if (command[0] === 'EVAL' && command[1] === PRESENCE_SCRIPT) {
                    active.set(command[5], Number(command[4]));
                    for (const [id, score] of active) if (score <= Number(command[6])) active.delete(id);
                    return 1;
                }
                if (command[0] === 'EVAL' && command[1] === LEAVE_SCRIPT) {
                    active.delete(command[4]);
                    for (const [id, score] of active) if (score <= Number(command[5])) active.delete(id);
                    return 1;
                }
                if (command[0] === 'EVAL' && command[1] === ACTIVE_COUNT_SCRIPT) {
                    for (const [id, score] of active) if (score <= Number(command[4])) active.delete(id);
                    return active.size;
                }
                if (command[0] === 'HGETALL') return [];
                return null;
            });
        }
    };
}

test('reason menus are allow-listed and feedback totals use one atomic idempotent Redis script', () => {
    assert.deepEqual(REASONS.like, ['clear', 'accurate', 'example', 'relevant', 'other']);
    assert.deepEqual(REASONS.dislike, ['incorrect', 'unclear', 'too_short', 'too_long', 'off_topic', 'other']);
    assert.equal(NOTE_TTL_SECONDS, 7 * 24 * 60 * 60);
    assert.equal(IDEMPOTENCY_TTL_SECONDS, NOTE_TTL_SECONDS);
    assert.equal(DAILY_TTL_SECONDS, 35 * 24 * 60 * 60);
    assert.equal(SESSION_TTL_MS, 24 * 60 * 60 * 1000);
    assert.match(VOTE_SCRIPT, /if prior == ARGV\[5\] then return 0 else return -1 end/);
    assert.match(VOTE_SCRIPT, /HINCRBY/);
    assert.match(VOTE_SCRIPT, /SET', KEYS\[4\], '1', 'EX', ARGV\[7\]/);
    assert.match(VOTE_SCRIPT, /SET', KEYS\[5\], ARGV\[6\], 'EX', ARGV\[8\]/);
    assert.doesNotMatch(VOTE_SCRIPT, /ZADD|ZREMRANGEBYSCORE|PEXPIREAT/);
    assert.match(PRESENCE_SCRIPT, /redis.call\('ZADD', KEYS\[1\], ARGV\[1\], ARGV\[2\]\)/);
    assert.doesNotMatch(PRESENCE_SCRIPT, /INCR|ZINCRBY/);
    assert.doesNotMatch(PRESENCE_SCRIPT + LEAVE_SCRIPT, /ZCARD/);
});

test('seeded dashboard preview reason counts add up to each displayed sentiment total', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feedback-dashboard-preview.json'), 'utf8'));
    for (const sentiment of ['like', 'dislike']) {
        const reasonTotal = REASONS[sentiment].reduce((sum, reason) => sum + fixture.totals[`${sentiment}:${reason}`], 0);
        assert.equal(reasonTotal, fixture.totals[sentiment], `${sentiment} reasons must sum to the displayed total`);
    }
});

test('vote submission stores only selected feedback and a hashed idempotency key', async () => {
    const commands = [];
    setDeps(async (batch) => { commands.push(batch); return [1]; });
    const voteId = 'a2f1fd34-b19c-4f29-a4d0-6e2a78b9ef12';
    try {
        const result = await invoke({ action: 'vote', voteId, sentiment: 'dislike', reason: 'other', text: 'A concise note' });
        const body = JSON.parse(result.body);
        assert.equal(result.statusCode, 200);
        assert.deepEqual(body, { accepted: true, duplicate: false });
        const command = commands[0][0];
        assert.equal(command[0], 'EVAL');
        assert.equal(command[1], VOTE_SCRIPT);
        assert.equal(command[3], `kw:feedback:vote:${token(voteId)}`);
        assert.equal(command[6], `kw:feedback:comment:${token(voteId)}`);
        assert.equal(command[7], `kw:feedback:detail:${token(voteId)}`);
        assert.equal(command.includes(voteId), false);
        assert.equal(command[8], String(7 * 24 * 60 * 60));
        assert.equal(command[11], String(35 * 24 * 60 * 60));
        assert.equal(command[14], String(7 * 24 * 60 * 60), 'this note-index record expires independently after seven days');
        assert.equal(command[15], String(7 * 24 * 60 * 60), 'this note detail expires independently after seven days');
        assert.equal(command[12], token(JSON.stringify({ sentiment: 'dislike', reason: 'other', text: 'A concise note' })));
        const storedNote = JSON.parse(command[13]);
        assert.deepEqual({ ...storedNote, createdAt: 0 }, {
            sentiment: 'dislike', reason: 'other', text: 'A concise note', createdAt: 0
        });
        assert.ok(Number.isSafeInteger(storedNote.createdAt) && storedNote.createdAt > 0);
        assert.equal(command[13].includes('prompt'), false);
        assert.equal(command[13].includes('reply'), false);
    } finally { feedback._test.setDependencies(null); }
});

test('a newer optional note cannot renew an older note-index marker because each key expires independently', async () => {
    const commands = [];
    setDeps(async (batch) => { commands.push(batch[0]); return [1]; });
    try {
        for (const voteId of ['a2f1fd34-b19c-4f29-a4d0-6e2a78b9ef12', 'b2f1fd34-b19c-4f29-a4d0-6e2a78b9ef12']) {
            assert.equal((await invoke({ action: 'vote', voteId, sentiment: 'like', reason: 'other', text: 'A note' })).statusCode, 200);
        }
        assert.notEqual(commands[0][6], commands[1][6]);
        assert.equal(commands[1].includes(commands[0][6]), false, 'the new note never touches the old index key');
        for (const command of commands) {
            assert.match(command[6], /^kw:feedback:comment:[a-f0-9]{64}$/);
            assert.equal(command[14], String(NOTE_TTL_SECONDS));
            assert.equal(command[15], String(NOTE_TTL_SECONDS));
        }
    } finally { feedback._test.setDependencies(null); }
});

test('invalid or unlisted feedback reasons are rejected before storage', async () => {
    let called = false;
    setDeps(async () => { called = true; return [1]; });
    try {
        const result = await invoke({ action: 'vote', voteId: 'a2f1fd34-b19c-4f29-a4d0-6e2a78b9ef12', sentiment: 'like', reason: 'five-stars' });
        assert.equal(result.statusCode, 400);
        assert.equal(called, false);
    } finally { feedback._test.setDependencies(null); }
});

test('presence and leave require server-issued proof; unsigned caller UUIDs cannot change the owner-visible total', async () => {
    const redis = memoryRedis();
    setDeps(redis.pipeline.bind(redis));
    try {
        const sessionId = 'd38f4930-3d66-4a4b-8ab3-55718a5ecbd2';
        for (const action of ['presence', 'leave']) {
            for (const unsigned of [{ sessionId }, { sessionToken: sessionId }]) {
                const result = await invoke({ action, ...unsigned });
                assert.equal(result.statusCode, 401, `${action} rejects an unsigned caller-chosen UUID`);
                assert.equal(Object.hasOwn(JSON.parse(result.body), 'activeSessions'), false);
            }
            assert.equal((await invoke({ action }, { cookie: `kw_feedback_session=${sessionId}` })).statusCode, 401, 'an unsigned UUID cookie is not proof');
            assert.equal((await invoke({ action, sessionToken: feedback._test.issueSessionToken() })).statusCode, 401, 'even a signed token in JSON is not the browser-session cookie');
        }
        assert.equal(redis.commands.length, 0, 'untrusted UUIDs never reach active-session storage');
        const dashboard = await invoke({ action: 'dashboard', ownerToken: owner.sign('feedback-owner-secret') });
        assert.equal(dashboard.statusCode, 200);
        assert.equal(JSON.parse(dashboard.body).activeSessions, 0, 'owner-visible total is unchanged');
    } finally { feedback._test.setDependencies(null); }
});

test('a browser reuses its HttpOnly session cookie; public presence and leave return only a generic acknowledgement', async () => {
    const redis = memoryRedis();
    setDeps(redis.pipeline.bind(redis));
    try {
        const issued = await invoke({ action: 'session' });
        assert.equal(issued.statusCode, 200);
        assert.deepEqual(JSON.parse(issued.body), { ok: true }, 'the signed token is not returned to JavaScript');
        const setCookie = issued.headers['Set-Cookie'];
        assert.match(setCookie, /^kw_feedback_session=[^.]+\.[0-9]+\.[a-f0-9]{64};/);
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /Secure/);
        assert.match(setCookie, /SameSite=Strict/);
        const cookie = setCookie.split(';', 1)[0];
        const token = cookie.slice(cookie.indexOf('=') + 1);
        assert.ok(feedback._test.verifySessionToken(token));

        const refreshSession = await invoke({ action: 'session' }, { cookie });
        assert.deepEqual(JSON.parse(refreshSession.body), { ok: true });
        assert.equal(Object.hasOwn(refreshSession.headers, 'Set-Cookie'), false, 'an existing session cookie is reused, not re-minted');

        for (let i = 0; i < 2; i++) {
            const present = await invoke({ action: 'presence' }, { cookie });
            assert.equal(present.statusCode, 200);
            assert.deepEqual(JSON.parse(present.body), { ok: true });
        }
        const presenceCommands = redis.commands.filter((command) => command[0] === 'EVAL' && command[1] === PRESENCE_SCRIPT);
        assert.equal(presenceCommands.length, 2);
        assert.equal(presenceCommands[0][5], presenceCommands[1][5], 'refreshes address the same hashed server-issued session');
        assert.equal(redis.active.size, 1, 'ZADD refreshes one record rather than incrementing a counter');

        const dashboard = await invoke({ action: 'dashboard', ownerToken: owner.sign('feedback-owner-secret') });
        assert.equal(JSON.parse(dashboard.body).activeSessions, 1);
        const repeatRead = await invoke({ action: 'dashboard', ownerToken: owner.sign('feedback-owner-secret') });
        assert.equal(JSON.parse(repeatRead.body).activeSessions, 1, 'owner reads do not increment the aggregate');

        const left = await invoke({ action: 'leave' }, { cookie });
        assert.equal(left.statusCode, 200);
        assert.deepEqual(JSON.parse(left.body), { ok: true });
        assert.equal(redis.active.size, 0);
        const afterLeave = await invoke({ action: 'dashboard', ownerToken: owner.sign('feedback-owner-secret') });
        assert.equal(JSON.parse(afterLeave.body).activeSessions, 0);
    } finally { feedback._test.setDependencies(null); }
});

test('cookie resets can establish another anonymous session, but new issuance remains rate-limited and existing cookies are reused', async () => {
    const redis = memoryRedis();
    let blockNewStarts = false;
    setDeps(redis.pipeline.bind(redis), async (request, bucket, max, windowMs) => {
        if (bucket !== 'feedback-session') return null;
        assert.equal(max, 60);
        assert.equal(windowMs, 15 * 60 * 1000);
        return blockNewStarts ? { statusCode: 429, headers: {}, body: JSON.stringify({ error: 'rate limited' }) } : null;
    });
    try {
        const first = await invoke({ action: 'session' });
        const firstCookie = first.headers['Set-Cookie'].split(';', 1)[0];
        const reset = await invoke({ action: 'session' });
        const resetCookie = reset.headers['Set-Cookie'].split(';', 1)[0];
        assert.notEqual(firstCookie, resetCookie, 'withholding/clearing the cookie remains an anonymous-session integrity limit');
        for (const cookie of [firstCookie, resetCookie]) assert.equal((await invoke({ action: 'presence' }, { cookie })).statusCode, 200);
        const data = JSON.parse((await invoke({ action: 'dashboard', ownerToken: owner.sign('feedback-owner-secret') })).body);
        assert.equal(data.activeSessions, 2, 'this is a cookie-session estimate, not a unique-person count');
        blockNewStarts = true;
        assert.equal((await invoke({ action: 'session' })).statusCode, 429);
        const reused = await invoke({ action: 'session' }, { cookie: firstCookie });
        assert.equal(reused.statusCode, 200);
        assert.equal(Object.hasOwn(reused.headers, 'Set-Cookie'), false);
    } finally { feedback._test.setDependencies(null); }
});

test('a browser refresh reuses the session cookie without exposing or resending a token from JavaScript', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'ui', 'feedback.js'), 'utf8');
    const calls = [];
    const cookieJar = new Map();
    let mintCount = 0;
    const fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        assert.equal(options.credentials, 'same-origin');
        if (body.action === 'session' && !cookieJar.has('kw_feedback_session')) {
            cookieJar.set('kw_feedback_session', 'server-minted-only-once');
            mintCount++;
        }
        if (body.action !== 'session') assert.ok(cookieJar.has('kw_feedback_session'), 'browser automatically sends its existing HttpOnly cookie');
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    for (let refresh = 0; refresh < 2; refresh++) {
        vm.runInNewContext(source, {
            window: { crypto: crypto.webcrypto, setInterval() {}, addEventListener() {} },
            document: { readyState: 'complete', visibilityState: 'visible', addEventListener() {} },
            fetch
        }, { timeout: 1000 });
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(calls.filter((body) => body.action === 'session').length, 2, 'each page start checks the existing browser cookie');
    assert.equal(mintCount, 1, 'the same cookie jar receives one server-issued identity across refreshes');
    const pulses = calls.filter((body) => body.action === 'presence');
    assert.equal(pulses.length, 2);
    assert.ok(pulses.every((body) => Object.keys(body).length === 1 && body.action === 'presence'), 'JavaScript sends no caller-selected ID or token');
});

test('dashboard is owner-only and returns aggregate totals, reasons, a 30-day graph, and active sessions only', async () => {
    let queried = false;
    const responseFor = async (commands) => {
        queried = true;
        assert.equal(commands.some((command) => command.some((part) => String(part).includes('feedback:detail') || String(part).includes('feedback:comment:'))), false, 'dashboard reads no note text or per-note index');
        return commands.map((command) => {
            if (command[0] === 'EVAL' && command[1] === ACTIVE_COUNT_SCRIPT) return 3;
            if (command[0] === 'HGETALL' && command[1] === 'kw:feedback:total') return ['like', '8', 'dislike', '3', 'like:clear', '5', 'like:accurate', '2', 'like:other', '1', 'dislike:incorrect', '2', 'dislike:other', '1'];
            if (command[0] === 'HGETALL') return [];
            return null;
        });
    };
    setDeps(responseFor);
    try {
        const denied = await invoke({ action: 'dashboard', ownerToken: 'not-signed' });
        assert.equal(denied.statusCode, 401);
        assert.equal(queried, false, 'unauthenticated summary requests never touch metrics');

        const allowed = await invoke({ action: 'dashboard', ownerToken: owner.sign('feedback-owner-secret') });
        const data = JSON.parse(allowed.body);
        assert.equal(allowed.statusCode, 200);
        assert.equal(data.activeSessions, 3);
        assert.equal(data.activeWindowSeconds, 300);
        assert.deepEqual(data.totals, { like: 8, dislike: 3 });
        assert.equal(data.reasons.like.clear, 5);
        assert.equal(data.reasons.like.other, 1);
        assert.equal(data.reasons.dislike.incorrect, 2);
        assert.equal(data.reasons.dislike.other, 1);
        assert.equal(Object.values(data.reasons.like).reduce((sum, count) => sum + count, 0), data.totals.like);
        assert.equal(Object.values(data.reasons.dislike).reduce((sum, count) => sum + count, 0), data.totals.dislike);
        assert.equal(data.trend.length, 30);
        assert.equal(data.otherNoteRetentionDays, 7);
        assert.equal(Object.hasOwn(data, 'comments'), false);
        assert.doesNotMatch(JSON.stringify(data), /Please add one more example|detail-hash|feedback:detail/);
    } finally { feedback._test.setDependencies(null); }
});

test('users can add optional Other context, but the owner dashboard has no free-text display path', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const helper = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'ui', 'feedback.js'), 'utf8');
    assert.match(helper, /Optional note/);
    assert.match(helper, /action: 'vote', voteId, sentiment, reason/);
    assert.match(main, /Why people liked it/);
    assert.match(main, /Why people disliked it/);
    assert.match(main, /feedbackLikeReasons/);
    assert.match(main, /feedbackDislikeReasons/);
    assert.doesNotMatch(main, /feedbackComments|data\?\.comments|Recent optional notes/);
    assert.match(main, /never shown in this dashboard/);
});

test('the feedback endpoint allows POST only and stops when its abuse limiter rejects', async () => {
    let stored = false;
    setDeps(async () => { stored = true; return [1]; }, async () => ({ statusCode: 429, headers: {}, body: JSON.stringify({ error: 'rate limited' }) }));
    try {
        const badMethod = await feedback.handler(event({}, 'GET'));
        assert.equal(badMethod.statusCode, 405);
        const rateLimited = await invoke({ action: 'session' });
        assert.equal(rateLimited.statusCode, 429);
        assert.equal(stored, false);
    } finally { feedback._test.setDependencies(null); }
});
