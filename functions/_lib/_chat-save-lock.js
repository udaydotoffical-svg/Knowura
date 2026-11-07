'use strict';

const crypto = require('crypto');

// Production chat writes use the same Upstash Redis already required by the
// production usage limiter. Redis SET NX is atomic across function instances;
// the blob document itself remains on the configured platform store.
const LEASE_MS = 120_000;
const WAIT_MS = 10_000;
const REDIS_TIMEOUT_MS = 2_500;
const RENEW_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

class ChatSaveLockError extends Error {
    constructor(code) {
        super(code === 'busy'
            ? 'Chat saves are busy; retry shortly.'
            : 'The chat save lock is unavailable.');
        this.name = 'ChatSaveLockError';
        this.code = code;
    }
}

function isProductionServerless(env) {
    return env.NODE_ENV === 'production' || !!env.VERCEL || (!!env.NETLIFY && !env.NETLIFY_LOCAL);
}

function createChatSaveLock(options = {}) {
    const env = options.env || process.env;
    const fetcher = options.fetch || ((...args) => globalThis.fetch(...args));
    const now = options.now || Date.now;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const random = options.random || Math.random;
    const waitMs = options.waitMs ?? WAIT_MS;
    const retryMs = options.retryMs ?? 30;
    const localTails = new Map();

    async function localLock(key, work) {
        const previous = localTails.get(key) || Promise.resolve();
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => held);
        localTails.set(key, tail);
        await previous;
        try {
            return await work({ assertHeld: async () => {} });
        } finally {
            release();
            if (localTails.get(key) === tail) localTails.delete(key);
        }
    }

    async function redisCommand(conf, args) {
        const response = await fetcher(`${conf.url}/pipeline`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${conf.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify([args]),
            signal: AbortSignal.timeout(REDIS_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`Redis returned ${response.status}`);
        const result = await response.json();
        if (!Array.isArray(result) || result.length !== 1 || result[0]?.error) throw new Error('Redis command failed');
        return result[0].result;
    }

    async function withChatSaveLock(subject, work) {
        const url = env.UPSTASH_REDIS_REST_URL;
        const token = env.UPSTASH_REDIS_REST_TOKEN;
        if (!url || !token) {
            if (isProductionServerless(env)) throw new ChatSaveLockError('unavailable');
            // Local development and unit tests are single-process; deployed functions
            // never use this fallback because it cannot coordinate other instances.
            return localLock(subject, work);
        }

        const conf = { url: String(url).replace(/\/$/, ''), token };
        const key = `kw:lock:chat-save:${crypto.createHash('sha256').update(String(subject)).digest('hex')}`;
        const lockToken = crypto.randomUUID();
        const deadline = now() + waitMs;
        let acquired = false;
        while (!acquired && now() <= deadline) {
            let result;
            try {
                result = await redisCommand(conf, ['SET', key, lockToken, 'NX', 'PX', String(LEASE_MS)]);
            } catch (error) {
                throw new ChatSaveLockError('unavailable');
            }
            if (result === 'OK') {
                acquired = true;
                break;
            }
            const remaining = deadline - now();
            if (remaining > 0) await sleep(Math.min(retryMs + Math.floor(random() * retryMs), remaining));
        }
        if (!acquired) throw new ChatSaveLockError('busy');

        let lost = false;
        let renewing = null;
        const assertHeld = async () => {
            if (lost) throw new ChatSaveLockError('unavailable');
            let renewed;
            try {
                renewed = await redisCommand(conf, ['EVAL', RENEW_SCRIPT, '1', key, lockToken, String(LEASE_MS)]);
            } catch (error) {
                lost = true;
                throw new ChatSaveLockError('unavailable');
            }
            if (Number(renewed) !== 1) {
                lost = true;
                throw new ChatSaveLockError('unavailable');
            }
        };
        const heartbeat = setInterval(() => {
            if (renewing || lost) return;
            renewing = assertHeld().catch(() => { lost = true; }).finally(() => { renewing = null; });
        }, Math.floor(LEASE_MS / 3));
        heartbeat.unref?.();

        try {
            await assertHeld();
            const result = await work({ assertHeld });
            if (lost) throw new ChatSaveLockError('unavailable');
            return result;
        } finally {
            clearInterval(heartbeat);
            if (renewing) await renewing;
            try {
                await redisCommand(conf, ['EVAL', RELEASE_SCRIPT, '1', key, lockToken]);
            } catch (error) {
                // The bounded lease expires automatically if Redis cannot release it.
            }
        }
    }

    return withChatSaveLock;
}

const withChatSaveLock = createChatSaveLock();
module.exports = { withChatSaveLock, createChatSaveLock, ChatSaveLockError };
