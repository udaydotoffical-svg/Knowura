// Anonymous answer feedback and short-lived active-session counts.
// The client sends no account ID or prompt/reply fields; optional user-written notes
// are limited to 240 characters, expire after seven days, and never enter the dashboard.
// Owner-only summaries are protected by the server-signed token used in owner mode.
const crypto = require('crypto');
const { verify: verifyOwner } = require('./_lib/_ownerToken');
const { json, guard, readJson, cleanStr, header } = require('./_lib/_util');
const { requestLimit } = require('./_lib/_limits');

const ACTIVE_KEY = 'kw:feedback:active';
const TOTAL_KEY = 'kw:feedback:total';
const COMMENT_INDEX_PREFIX = 'kw:feedback:comment:';
const SESSION_COOKIE_NAME = 'kw_feedback_session';
const SESSION_COOKIE_PATH = '/.netlify/functions/feedback';
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_TTL_SECONDS = 10 * 60;
const NOTE_TTL_SECONDS = 7 * 24 * 60 * 60;
const IDEMPOTENCY_TTL_SECONDS = NOTE_TTL_SECONDS;
const DAILY_TTL_SECONDS = 35 * 24 * 60 * 60;
const HISTORY_DAYS = 30;
const REASONS = Object.freeze({
    like: Object.freeze(['clear', 'accurate', 'example', 'relevant', 'other']),
    dislike: Object.freeze(['incorrect', 'unclear', 'too_short', 'too_long', 'off_topic', 'other'])
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let testDependencies = null;

const VOTE_SCRIPT = `
local prior = redis.call('GET', KEYS[1])
if prior then
  if prior == ARGV[5] then return 0 else return -1 end
end
redis.call('SET', KEYS[1], ARGV[5], 'EX', ARGV[1])
redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
redis.call('HINCRBY', KEYS[3], ARGV[2], 1)
redis.call('HINCRBY', KEYS[3], ARGV[3], 1)
redis.call('EXPIRE', KEYS[3], ARGV[4])
if ARGV[6] ~= '' then
  redis.call('SET', KEYS[4], '1', 'EX', ARGV[7])
  redis.call('SET', KEYS[5], ARGV[6], 'EX', ARGV[8])
end
return 1
`;
const PRESENCE_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;
const LEAVE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
return 1
`;
const ACTIVE_COUNT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZCARD', KEYS[1])
`;
function redisConfig() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}
async function redisPipeline(commands) {
    const config = redisConfig();
    if (!config) throw new Error('Feedback storage is not configured');
    const response = await fetch(`${config.url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) throw new Error(`Redis request failed (${response.status})`);
    const values = await response.json();
    if (!Array.isArray(values) || values.some((value) => value?.error)) throw new Error('Redis returned an invalid response');
    return values.map((value) => value.result);
}
function digest(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function feedbackSessionSecret() {
    return process.env.FEEDBACK_SESSION_SECRET || process.env.OWNER_TOKEN_SECRET || '';
}
function sessionSignature(value, secret) {
    return crypto.createHmac('sha256', secret).update(`knowura-feedback-session-v1:${value}`).digest('hex');
}
function issueSessionToken(now = Date.now()) {
    const secret = feedbackSessionSecret();
    if (!secret) throw new Error('Feedback session signing is not configured');
    const sessionId = crypto.randomBytes(16).toString('hex');
    const expiresAt = now + SESSION_TTL_MS;
    const payload = `${sessionId}.${expiresAt}`;
    return `${payload}.${sessionSignature(payload, secret)}`;
}
function verifySessionToken(value, now = Date.now()) {
    const token = cleanStr(value, 128, 1);
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !/^[0-9a-f]{32}$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return null;
    const [sessionId, expiry, signature] = parts;
    const expiresAt = Number(expiry);
    const secret = feedbackSessionSecret();
    if (!secret || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + SESSION_TTL_MS) return null;
    const expected = Buffer.from(sessionSignature(`${sessionId}.${expiry}`, secret), 'hex');
    const received = Buffer.from(signature, 'hex');
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
    return sessionId;
}
function sessionCookie(event) {
    const cookies = String(header(event, 'cookie') || '').split(';');
    for (const item of cookies) {
        const separator = item.indexOf('=');
        if (separator < 0 || item.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
        return item.slice(separator + 1).trim();
    }
    return '';
}
function sessionCookieHeader(token) {
    return `${SESSION_COOKIE_NAME}=${token}; Path=${SESSION_COOKIE_PATH}; Max-Age=${Math.ceil(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}
function validateVote(body) {
    const voteId = cleanStr(body.voteId, 36, 36);
    const sentiment = body.sentiment;
    const reason = body.reason;
    if (!voteId || !UUID_V4.test(voteId) || !['like', 'dislike'].includes(sentiment)) return null;
    if (!REASONS[sentiment].includes(reason)) return null;
    let text = '';
    if (body.text !== undefined) {
        const safe = cleanStr(body.text, 240, 0);
        if (safe === null) return null;
        text = safe.trim();
    }
    if (reason !== 'other' && text) return null;
    return { voteId, sentiment, reason, text };
}
function hashValues(value) {
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [String(key), String(item)]);
    return [];
}
function parseHash(value) {
    const pairs = hashValues(value);
    const result = Object.create(null);
    for (let i = 0; i + 1 < pairs.length; i += 2) result[pairs[i]] = Number(pairs[i + 1]) || 0;
    return result;
}
function utcDayKey(date) {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
}
function dayKeys(now) {
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    return Array.from({ length: HISTORY_DAYS }, (_, i) => {
        const date = new Date(today.getTime() - (HISTORY_DAYS - 1 - i) * 86400000);
        return { key: utcDayKey(date), day: date.toISOString().slice(0, 10) };
    });
}
function eventField(sentiment, reason) {
    return `${sentiment}:${reason}`;
}
function response(status, payload, extraHeaders) {
    return json(status, payload, extraHeaders);
}
async function applyLimit(deps, event, action) {
    if (!deps.requestLimit) return null;
    const config = action === 'vote'
        ? ['feedback-vote', 90, 15 * 60 * 1000, 'Too many feedback submissions. Try again later.']
        : action === 'dashboard'
            ? ['feedback-dashboard', 120, 15 * 60 * 1000, 'Too many dashboard refreshes. Try again later.']
            : action === 'session'
                ? ['feedback-session', 60, 15 * 60 * 1000, 'Too many active-session starts.']
            : ['feedback-presence', 3000, 15 * 60 * 1000, 'Too many active-session checks.'];
    return deps.requestLimit(event, ...config);
}
async function startSession(event, deps) {
    const existingToken = sessionCookie(event);
    if (verifySessionToken(existingToken)) return response(200, { ok: true });
    const limited = await applyLimit(deps, event, 'session');
    if (limited) return limited;
    const token = issueSessionToken();
    return response(200, { ok: true }, { 'Set-Cookie': sessionCookieHeader(token) });
}
async function saveVote(event, body, deps) {
    const vote = validateVote(body);
    if (!vote) return response(400, { error: 'Choose a valid feedback reason.' });
    const limited = await applyLimit(deps, event, 'vote');
    if (limited) return limited;

    const now = Date.now();
    const idHash = digest(vote.voteId);
    const payloadHash = digest(JSON.stringify({ sentiment: vote.sentiment, reason: vote.reason, text: vote.text }));
    const key = `kw:feedback:vote:${idHash}`;
    const commentIndexKey = `${COMMENT_INDEX_PREFIX}${idHash}`;
    const detailKey = `kw:feedback:detail:${idHash}`;
    const dailyKey = `kw:feedback:day:${utcDayKey(new Date(now))}`;
    const detail = vote.text ? JSON.stringify({ sentiment: vote.sentiment, reason: vote.reason, text: vote.text, createdAt: now }) : '';
    const result = await deps.redisPipeline([['EVAL', VOTE_SCRIPT, '5', key, TOTAL_KEY, dailyKey, commentIndexKey, detailKey,
        String(IDEMPOTENCY_TTL_SECONDS), vote.sentiment, eventField(vote.sentiment, vote.reason), String(DAILY_TTL_SECONDS),
        payloadHash, detail, String(NOTE_TTL_SECONDS), String(NOTE_TTL_SECONDS)]]);
    const code = Number(result[0]);
    if (code === -1) return response(409, { error: 'Feedback for this answer was already submitted.' });
    return response(200, { accepted: true, duplicate: code === 0 });
}
async function updatePresence(event, deps, leaving = false) {
    const sessionId = verifySessionToken(sessionCookie(event));
    if (!sessionId) return response(401, { error: 'A valid active-session token is required.' });
    const limited = await applyLimit(deps, event, 'presence');
    if (limited) return limited;
    const now = Date.now();
    const idHash = digest(sessionId);
    const command = leaving
        ? ['EVAL', LEAVE_SCRIPT, '1', ACTIVE_KEY, idHash, String(now - ACTIVE_WINDOW_MS)]
        : ['EVAL', PRESENCE_SCRIPT, '1', ACTIVE_KEY, String(now), idHash, String(now - ACTIVE_WINDOW_MS), String(ACTIVE_TTL_SECONDS)];
    await deps.redisPipeline([command]);
    return response(200, { ok: true });
}
async function loadDashboard(deps, now = Date.now()) {
    const days = dayKeys(now);
    const commands = [
        ['EVAL', ACTIVE_COUNT_SCRIPT, '1', ACTIVE_KEY, String(now - ACTIVE_WINDOW_MS)],
        ['HGETALL', TOTAL_KEY],
        ...days.map(({ key }) => ['HGETALL', `kw:feedback:day:${key}`])
    ];
    const values = await deps.redisPipeline(commands);
    const totals = parseHash(values[1]);
    const daily = days.map(({ key, day }, index) => {
        const counts = parseHash(values[index + 2]);
        return { day, like: counts.like || 0, dislike: counts.dislike || 0 };
    });
    const reasons = { like: Object.create(null), dislike: Object.create(null) };
    for (const sentiment of ['like', 'dislike']) {
        for (const reason of REASONS[sentiment]) reasons[sentiment][reason] = totals[eventField(sentiment, reason)] || 0;
    }
    return {
        generatedAt: now,
        activeSessions: Math.max(0, Number(values[0]) || 0),
        activeWindowSeconds: ACTIVE_WINDOW_MS / 1000,
        totals: { like: totals.like || 0, dislike: totals.dislike || 0 },
        reasons,
        trend: daily,
        otherNoteRetentionDays: NOTE_TTL_SECONDS / 86400
    };
}
async function dashboard(event, body, deps) {
    const token = cleanStr(body.ownerToken, 400, 1);
    if (!token || !verifyOwner(token, process.env.OWNER_TOKEN_SECRET)) {
        return response(401, { error: 'Owner access is required.' });
    }
    const limited = await applyLimit(deps, event, 'dashboard');
    if (limited) return limited;
    const data = await loadDashboard(deps);
    return response(200, data);
}
exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const { body, error } = readJson(event, 2 * 1024, { allowEmpty: false });
        if (error) return error;
        const deps = testDependencies || { redisPipeline, requestLimit };
        if (body.action === 'vote') return await saveVote(event, body, deps);
        if (body.action === 'session') return await startSession(event, deps);
        if (body.action === 'presence') return await updatePresence(event, deps, false);
        if (body.action === 'leave') return await updatePresence(event, deps, true);
        if (body.action === 'dashboard') return await dashboard(event, body, deps);
        return response(400, { error: 'Unknown feedback action.' });
    } catch (error) {
        return response(503, { error: 'Feedback metrics are temporarily unavailable.' });
    }
};
exports._test = {
    REASONS, VOTE_SCRIPT, PRESENCE_SCRIPT, LEAVE_SCRIPT, ACTIVE_COUNT_SCRIPT,
    IDEMPOTENCY_TTL_SECONDS, NOTE_TTL_SECONDS, DAILY_TTL_SECONDS, SESSION_TTL_MS, SESSION_COOKIE_NAME,
    validateVote, issueSessionToken, verifySessionToken, sessionCookie, sessionCookieHeader, hashValues, parseHash, dayKeys, eventField, loadDashboard,
    setDependencies(deps) { testDependencies = deps || null; }
};
