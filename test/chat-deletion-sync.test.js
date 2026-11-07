const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createChatSaveLock } = require('../functions/_lib/_chat-save-lock');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const assistant = fs.readFileSync(path.join(root, 'public/assistant.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function source(text, name, optional = false) {
    const match = text.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^    \\}`, 'm'));
    if (optional && !match) return '';
    assert.ok(match, `production function ${name} exists`);
    return match[0];
}
const chat = (id, updatedAt = 10) => ({ id, title: id, createdAt: 1, updatedAt, messages: [{ type: 'user', text: 'fixture' }] });
const memory = { summary: 'Keep this summary', facts: ['Keep this fact'] };
function frontend(chats = [chat('keep'), chat('deleted-test-chat')]) {
    const requests = [];
    const context = vm.createContext({
        console: { warn() {} }, incognito: false, cloudLoadFailed: false, cloudBaseUpdatedAt: 10, cloudSaveQueue: Promise.resolve(),
        cloudSaveTimer: null, cloudChangeRevision: 0, cloudLogoutInProgress: false, stashedStore: null,
        userProfile: { sub: 'fixture-sub', given_name: 'Fixture' }, userSub: 'fixture-sub', userToken: 'fixture-token',
        chatStore: { chats: plain(chats), activeChatId: chats.at(-1)?.id || null }, cloudMemory: plain(memory),
        isCloudUser: () => true, showConfirm: async () => true,
        clearTimeout() {}, setTimeout: () => 1,
        finishTyping() {}, abortAsk() {}, haptic() {}, closeSidebarMobile() {},
        renderChatList() {}, renderActiveChat() {}, saveChatStore() {}, closeCodeBox() {}, closeSidebarMobile() {},
        showChatSkeleton() {}, landOnChat() {}, settings: { sidebarCollapsed: false },
        document: {
            body: { classList: { toggle() {}, remove() {} } },
            getElementById: () => ({ classList: { remove() {}, toggle() {} }, setAttribute() {}, focus() {}, hidden: false })
        },
        fetch: async (url, options) => { requests.push({ url, ...JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ saved: true, updatedAt: 30 }) }; }
    });
    const functions = ['normalizeChatMetadata', 'mergeDeletedChatIds', 'recordChatDeletions', 'mergeChats', 'scheduleCloudSave', 'persistCloudStore', 'setIncognito', 'deleteChat', 'deleteAllChats', 'newChat', 'loadCloudChats'];
    vm.runInContext(functions.map(name => source(html, name, ['mergeDeletedChatIds', 'recordChatDeletions'].includes(name))).join('\n'), context);
    return { context, requests };
}
function conflictThenSuccess(context, requests, remote) {
    context.fetch = async (url, options) => {
        requests.push({ url, ...JSON.parse(options.body) });
        return requests.length === 1
            ? { ok: false, status: 409, json: async () => ({ conflict: true, doc: plain(remote) }) }
            : { ok: true, status: 200, json: async () => ({ saved: true, updatedAt: 30 }) };
    };
}
function backend(initial, options = {}) {
    let stored = initial ? plain(initial) : null;
    const exports = {};
    const cloudStore = options.cloudStore || {
        get: async () => stored ? plain(stored) : null,
        setJSON: async (key, doc) => { stored = plain(doc); }
    };
    const code = fs.readFileSync(path.join(root, 'functions/chat-save.js'), 'utf8');
    vm.runInNewContext(code, {
        exports, Buffer, process: { env: {} }, console,
        require: id => id === './_lib/_store'
            ? { getPlatformStore: () => cloudStore }
            : id === './_lib/_chat-save-lock'
                ? (options.lockModule || require(path.join(root, 'functions', id)))
            : id === './_lib/_userToken'
                ? { verify: token => token === 'fixture-token' ? { sub: 'fixture-sub' } : null }
                : require(path.join(root, 'functions', id))
    });
    const save = async (doc, baseUpdatedAt) => exports.handler({ httpMethod: 'POST', headers: { host: 'knowura.test' }, body: JSON.stringify({ token: 'fixture-token', doc, baseUpdatedAt }) });
    return { save, get: () => stored, cleanDoc: exports._test.cleanDoc, handler: exports.handler };
}
const cloudDoc = chats => ({ version: 1, profile: { sub: 'fixture-sub', given_name: 'Fixture' }, chats, activeChatId: chats.at(-1)?.id || null, memory: plain(memory), updatedAt: 20 });

test('deployed chat saves fail closed instead of using a process-local lock when Redis is missing', async () => {
    const lock = createChatSaveLock({ env: { NODE_ENV: 'production' } });
    await assert.rejects(lock('fixture-sub', async () => 'unsafe'), error => error.code === 'unavailable');
});

test('the confirmed synthetic 409 retry cannot resurrect a deleted chat', async () => {
    const { context, requests } = frontend();
    const remote = cloudDoc([chat('keep'), chat('deleted-test-chat')]);
    conflictThenSuccess(context, requests, remote);
    await context.deleteChat('deleted-test-chat');
    await context.persistCloudStore();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].doc.chats.map(c => c.id), ['keep']);
    assert.deepEqual(requests[1].doc.deletedChatIds, ['deleted-test-chat']);
    assert.deepEqual(requests[1].doc.memory, memory);
    assert.equal(requests[1].baseUpdatedAt, 20);
    assert.deepEqual(plain(context.chatStore.chats).map(c => c.id), ['keep']);
});

test('concurrent cloud saves serialize an older in-flight write before the deletion save', async () => {
    const { context, requests } = frontend();
    let finishFirst;
    let inFlight = 0;
    let maxInFlight = 0;
    let stored;
    context.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, ...body });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (requests.length === 1) await new Promise(resolve => { finishFirst = resolve; });
        stored = plain(body.doc);
        inFlight--;
        return { ok: true, status: 200, json: async () => ({ saved: true, updatedAt: 30 + requests.length }) };
    };

    const oldSave = context.persistCloudStore();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1, 'the first save is held in flight');
    assert.deepEqual(requests[0].doc.chats.map(c => c.id), ['keep', 'deleted-test-chat']);

    await context.deleteChat('deleted-test-chat');
    const deletionSave = context.persistCloudStore();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1, 'the deletion write waits instead of racing the older request');
    finishFirst();

    assert.equal(await oldSave, true);
    assert.equal(await deletionSave, true);
    assert.equal(maxInFlight, 1, 'only one cloud write can be active for this tab');
    assert.deepEqual(requests[1].doc.chats.map(c => c.id), ['keep']);
    assert.deepEqual(requests[1].doc.deletedChatIds, ['deleted-test-chat']);
    assert.deepEqual(stored.chats.map(c => c.id), ['keep']);
    assert.deepEqual(stored.deletedChatIds, ['deleted-test-chat']);
});

test('entering Incognito cannot make an already-queued cloud save snapshot the empty Incognito store', async () => {
    const { context, requests } = frontend();
    let releaseFirst;
    let signalFirst;
    const firstStarted = new Promise(resolve => { signalFirst = resolve; });
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    context.fetch = async (url, options) => {
        requests.push({ url, ...JSON.parse(options.body) });
        if (requests.length === 1) {
            signalFirst();
            await firstGate;
        }
        return { ok: true, status: 200, json: async () => ({ saved: true, updatedAt: 30 + requests.length }) };
    };

    const earlierSave = context.persistCloudStore();
    await firstStarted;
    context.cloudSaveTimer = 77;
    context.setIncognito(true);
    assert.equal(context.incognito, true);
    assert.deepEqual(plain(context.chatStore.chats), [], 'Incognito has its own empty in-memory store');
    releaseFirst();
    assert.equal(await earlierSave, true);
    await context.cloudSaveQueue;

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].doc.chats.map(c => c.id), ['keep', 'deleted-test-chat']);
    assert.equal(requests[1].doc.profile.sub, 'fixture-sub');
});

test('independent server requests serialize deletion against a stale client write', async () => {
    const initial = cloudDoc([chat('keep'), chat('deleted-test-chat')]);
    const state = { doc: plain(initial) };
    let reads = 0;
    let signalFirstRead;
    let releaseFirstRead;
    let signalDeletionWrite;
    const firstReadEntered = new Promise(resolve => { signalFirstRead = resolve; });
    const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve; });
    const deletionWritten = new Promise(resolve => { signalDeletionWrite = resolve; });
    const cloudStore = {
        async get() {
            reads++;
            if (reads === 1) {
                signalFirstRead();
                await firstReadGate;
            }
            return plain(state.doc);
        },
        async setJSON(key, doc) {
            if (doc.chats.some(c => c.id === 'deleted-test-chat')) {
                // Force the old failure ordering: a stale overwrite is held until
                // after the deletion write, then would resurrect the deleted chat.
                await deletionWritten;
            }
            state.doc = plain(doc);
            if (doc.deletedChatIds.includes('deleted-test-chat')) signalDeletionWrite();
        }
    };

    const redisLocks = new Map();
    const redisFetch = async (_url, request) => {
        const commands = JSON.parse(request.body);
        const results = commands.map(([command, ...args]) => {
            if (command === 'SET') {
                const [key, value] = args;
                if (redisLocks.has(key)) return null;
                redisLocks.set(key, value);
                return 'OK';
            }
            if (command === 'EVAL') {
                const [script, keyCount, key, value] = args;
                if (redisLocks.get(key) !== value) return 0;
                if (script.includes('pexpire')) return 1;
                if (script.includes("redis.call('del'")) {
                    redisLocks.delete(key);
                    return 1;
                }
            }
            throw new Error(`Unexpected fake Redis command: ${command}`);
        });
        return { ok: true, status: 200, json: async () => results.map(result => ({ result })) };
    };
    const makeLock = () => createChatSaveLock({
        env: { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture' },
        fetch: redisFetch, waitMs: 1000, retryMs: 1, random: () => 0
    });
    const deletionClient = backend(null, { cloudStore, lockModule: { withChatSaveLock: makeLock(), ChatSaveLockError: Error } });
    const staleClient = backend(null, { cloudStore, lockModule: { withChatSaveLock: makeLock(), ChatSaveLockError: Error } });
    const deletionDoc = { ...plain(initial), chats: [chat('keep')], activeChatId: 'keep', deletedChatIds: ['deleted-test-chat'] };

    const deletionRequest = deletionClient.save(deletionDoc, 20);
    await firstReadEntered;
    const staleRequest = staleClient.save(initial, 20);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(reads, 1, 'the independent stale request cannot read while the deletion transaction owns the Redis lock');

    releaseFirstRead();
    const [deletionResponse, staleResponse] = await Promise.all([deletionRequest, staleRequest]);
    assert.equal(deletionResponse.statusCode, 200);
    assert.equal(staleResponse.statusCode, 409, 'the stale client must receive the committed document rather than overwrite it');
    assert.deepEqual(state.doc.deletedChatIds, ['deleted-test-chat']);
    assert.deepEqual(state.doc.chats.map(c => c.id), ['keep']);
    assert.deepEqual(JSON.parse(staleResponse.body).doc.deletedChatIds, ['deleted-test-chat']);
    assert.equal(reads, 2, 'the second request reads only after the first write is committed');
});

for (const action of ['last chat', 'all chats', 'old empty chat']) {
    test(`${action} deletion survives a conflict without repopulating the store`, async () => {
        const chats = action === 'old empty chat' ? [{ ...chat('deleted-test-chat'), messages: [] }] : [chat('deleted-test-chat')];
        const { context, requests } = frontend(chats);
        conflictThenSuccess(context, requests, cloudDoc(chats));
        if (action === 'all chats') await context.deleteAllChats();
        else if (action === 'old empty chat') context.newChat();
        else await context.deleteChat('deleted-test-chat');
        await context.persistCloudStore();
        assert.deepEqual(requests[1].doc.chats, []);
        assert.equal(requests[1].doc.activeChatId, null);
        assert.deepEqual(requests[1].doc.deletedChatIds, ['deleted-test-chat']);
    });
}

test('a stale second device merges remote deletion intent before its retry', async () => {
    const { context, requests } = frontend();
    const remote = { ...cloudDoc([chat('keep'), chat('remote-new', 22)]), deletedChatIds: ['deleted-test-chat'] };
    conflictThenSuccess(context, requests, remote);
    await context.persistCloudStore();
    assert.deepEqual(requests[1].doc.chats.map(c => c.id).sort(), ['keep', 'remote-new']);
    assert.deepEqual(requests[1].doc.deletedChatIds, ['deleted-test-chat']);
});

test('normal conflict merge still preserves distinct chats and the newer same-ID version', () => {
    const { context } = frontend();
    const merged = plain(context.mergeChats([chat('same', 40), chat('local', 5)], [chat('same', 20), chat('remote', 6)]));
    assert.deepEqual(merged.map(c => [c.id, c.updatedAt]), [['same', 40], ['remote', 6], ['local', 5]]);
});

test('server sanitizes, applies, and durably retains deletion intent even for an older writer', async () => {
    const initial = cloudDoc([chat('keep'), chat('deleted-test-chat')]);
    const store = backend(initial);
    const doc = { ...initial, deletedChatIds: ['deleted-test-chat', 'deleted-test-chat', '../../bad', null, 42] };
    const saved = await store.save(doc, 20);
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(store.get().chats.map(c => c.id), ['keep']);
    assert.deepEqual(store.get().deletedChatIds, ['deleted-test-chat']);
    assert.equal(store.get().activeChatId, null);
    assert.deepEqual(store.get().memory, memory);
    assert.equal(store.get().profile.given_name, 'Fixture');
    const stale = await store.save(initial, 20);
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(JSON.parse(stale.body).doc.deletedChatIds, ['deleted-test-chat']);
    const legacy = await store.save(initial, store.get().updatedAt);
    assert.equal(legacy.statusCode, 200);
    assert.deepEqual(store.get().chats.map(c => c.id), ['keep']);
    assert.deepEqual(store.get().deletedChatIds, ['deleted-test-chat'], 'omitting the field never clears stored tombstones');
});

test('legacy cloud documents normalize without losing unrelated metadata', () => {
    const { cleanDoc } = backend();
    const cleaned = plain(cleanDoc(cloudDoc([chat('keep')]), 'fixture-sub'));
    assert.deepEqual(cleaned.chats.map(c => c.id), ['keep']);
    assert.deepEqual(cleaned.deletedChatIds, []);
    assert.deepEqual(cleaned.memory, memory);
});

test('cloud load retains markers and excludes any matching stale chat', async () => {
    const { context } = frontend([]);
    const doc = { ...cloudDoc([chat('keep'), chat('deleted-test-chat')]), deletedChatIds: ['deleted-test-chat'] };
    context.fetch = async () => ({ ok: true, json: async () => ({ found: true, doc }) });
    await context.loadCloudChats();
    assert.deepEqual(plain(context.chatStore.chats).map(c => c.id), ['keep']);
    assert.deepEqual(plain(context.chatStore.deletedChatIds), ['deleted-test-chat']);
});

test('incognito deletion adds no cloud intent and performs no cloud write', async () => {
    const { context, requests } = frontend();
    context.incognito = true;
    await context.deleteChat('deleted-test-chat');
    await context.persistCloudStore();
    assert.equal(requests.length, 0);
    assert.deepEqual(plain(context.chatStore.deletedChatIds || []), []);
});

test('logout awaits a pending deletion-marker save before clearing credentials and chat state', async () => {
    const order = [];
    let finishSave;
    const context = vm.createContext({
        showConfirm: async () => true,
        document: {
            body: { classList: { remove() {} } },
            getElementById: () => ({ classList: { remove() {} }, style: {}, hidden: false, innerHTML: '' })
        },
        window: {},
        syncAssistantLink: () => order.push('unlink'),
        endCall() {}, stopWakeListener() {}, clearSession: () => order.push('clear-session'),
        clearTimeout: id => order.push(`clear:${id}`), setTimeout: () => 1, requestAnimationFrame() {},
        localStorage: { removeItem() {} },
        incognito: false, cloudLoadFailed: false, isCloudUser: () => true, stashedStore: null, currentUser: 'Fixture',
        cloudLogoutInProgress: false, cloudChangeRevision: 0, cloudSaveQueue: Promise.resolve(),
        userSub: 'fixture-sub', userToken: 'fixture-token', userProfile: { sub: 'fixture-sub' },
        chatStore: { chats: [], activeChatId: null, deletedChatIds: ['deleted-test-chat'] },
        cloudMemory: { summary: '', facts: [] }, cloudSaveTimer: 42,
        ownerMode: false, ownerEligible: false, ownerToken: null,
        persistCloudStore: () => {
            order.push('save-start');
            assert.equal(context.userToken, 'fixture-token');
            assert.deepEqual([...context.chatStore.deletedChatIds], ['deleted-test-chat']);
            return new Promise(resolve => { finishSave = () => { order.push('save-finish'); resolve(true); }; });
        }
    });
    vm.runInContext(source(html, 'logOut'), context);
    const pending = context.logOut(true);
    assert.deepEqual(order.slice(0, 2), ['clear:42', 'save-start']);
    assert.equal(order.includes('clear-session'), false, 'credentials remain until the pending write settles');
    finishSave();
    await pending;
    assert.ok(order.indexOf('save-finish') < order.indexOf('clear-session'));
    assert.equal(context.userToken, null);
    assert.deepEqual(plain(context.chatStore.chats), []);
});

test('logout drains edits made while its successful cloud flush is in flight', async () => {
    const order = [];
    const requests = [];
    let releaseFirst;
    let signalFirst;
    const firstStarted = new Promise(resolve => { signalFirst = resolve; });
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const element = () => ({ classList: { remove() {}, toggle() {} }, style: {}, hidden: false, innerHTML: '', setAttribute() {}, focus() {} });
    const context = vm.createContext({
        showConfirm: async () => true,
        console: { warn() {} },
        document: { body: { classList: { remove() {} } }, getElementById: element },
        window: {}, syncAssistantLink: () => order.push('unlink'),
        endCall() {}, stopWakeListener() {}, clearSession: () => order.push('clear-session'),
        clearTimeout() {}, setTimeout: () => 55, requestAnimationFrame() {}, localStorage: { removeItem() {} },
        incognito: false, cloudLoadFailed: false, isCloudUser: () => true, stashedStore: null, currentUser: 'Fixture',
        cloudLogoutInProgress: false, cloudChangeRevision: 0, cloudSaveTimer: null, cloudSaveQueue: Promise.resolve(),
        userSub: 'fixture-sub', userToken: 'fixture-token', userProfile: { sub: 'fixture-sub', given_name: 'Fixture' },
        chatStore: { chats: [chat('keep')], activeChatId: 'keep', deletedChatIds: [] },
        cloudMemory: { summary: '', facts: [] }, cloudBaseUpdatedAt: 10, ownerMode: false, ownerEligible: false, ownerToken: null,
        renderChatList() {}, finishTyping() {}, abortAsk() {}, haptic() {}, closeSidebarMobile() {},
        fetch: async (url, options) => {
            requests.push({ url, ...JSON.parse(options.body) });
            if (requests.length === 1) {
                signalFirst();
                await firstGate;
            }
            return { ok: true, status: 200, json: async () => ({ saved: true, updatedAt: 30 + requests.length }) };
        }
    });
    vm.runInContext(['mergeDeletedChatIds', 'mergeChats', 'scheduleCloudSave', 'persistCloudStore', 'logOut'].map(name => source(html, name)).join('\n'), context);

    const logout = context.logOut(true);
    await firstStarted;
    context.chatStore.chats.push(chat('added-during-logout', 40));
    context.scheduleCloudSave();
    releaseFirst();
    await logout;

    assert.equal(requests.length, 2, 'logout saves again after noticing a newer edit revision');
    assert.deepEqual(requests[0].doc.chats.map(c => c.id), ['keep']);
    assert.deepEqual(requests[1].doc.chats.map(c => c.id).sort(), ['added-during-logout', 'keep']);
    assert.ok(order.indexOf('clear-session') > 0, 'the session is cleared only after the drain completes');
    assert.equal(context.userToken, null);
});

test('logout stays signed in with deletion intent intact when the cloud flush fails', async () => {
    const prompts = [];
    const requests = [];
    const timers = new Map();
    let nextTimer = 100;
    const context = vm.createContext({
        showConfirm: async (...args) => { prompts.push(args); return false; },
        console: { warn() {} }, document: {},
        window: {}, syncAssistantLink() { throw new Error('must not unlink while save is failing'); },
        endCall() {}, stopWakeListener() {}, clearSession() { throw new Error('must not clear a session after a failed save'); },
        clearTimeout(id) { timers.delete(id); }, setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, requestAnimationFrame() {}, localStorage: { removeItem() {} },
        incognito: false, cloudLoadFailed: false, isCloudUser: () => true, stashedStore: null, currentUser: 'Fixture',
        cloudLogoutInProgress: false, cloudChangeRevision: 1,
        userSub: 'fixture-sub', userToken: 'fixture-token', userProfile: { sub: 'fixture-sub' },
        chatStore: { chats: [], activeChatId: null, deletedChatIds: ['deleted-test-chat'] },
        cloudMemory: { summary: '', facts: [] }, cloudBaseUpdatedAt: 10, cloudSaveQueue: Promise.resolve(), cloudSaveTimer: 42,
        ownerMode: false, ownerEligible: false, ownerToken: null,
        renderChatList() {},
        fetch: async (url, options) => {
            requests.push({ url, ...JSON.parse(options.body) });
            return { ok: false, status: 500, json: async () => ({ error: 'Could not save' }) };
        }
    });
    vm.runInContext(['mergeDeletedChatIds', 'mergeChats', 'scheduleCloudSave', 'persistCloudStore', 'logOut'].map(name => source(html, name)).join('\n'), context);
    assert.equal(await context.persistCloudStore(), false, 'an HTTP 500 is reported as a failed save');
    assert.deepEqual(requests[0].doc.deletedChatIds, ['deleted-test-chat']);
    requests.length = 0;
    prompts.length = 0;
    await context.logOut(true);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].doc.deletedChatIds, ['deleted-test-chat']);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0][0], /could not be saved/i);
    assert.equal(prompts[0][2], 'Retry');
    assert.equal(prompts[0][3], 'Stay Signed In');
    assert.equal(context.userToken, 'fixture-token');
    assert.equal(context.currentUser, 'Fixture');
    assert.deepEqual(plain(context.chatStore.deletedChatIds), ['deleted-test-chat']);
    assert.ok(context.cloudSaveTimer, 'Stay Signed In re-arms a background retry');
    const retry = timers.get(context.cloudSaveTimer);
    assert.equal(typeof retry, 'function');
    retry();
    await context.cloudSaveQueue;
    assert.equal(requests.length, 2, 'the re-armed timer retries without waiting for another edit');
});

test('a stale assistant panel cannot upsert a deleted ID into the shared document', async () => {
    const posts = [];
    const context = vm.createContext({
        signedIn: () => true, chat: chat('deleted-test-chat'), tok: () => 'fixture-token', session: { sub: 'fixture-sub' },
        post: async (name, body) => {
            posts.push({ name, body });
            return name === 'chat-load'
                ? { ok: true, json: async () => ({ found: true, doc: { ...cloudDoc([chat('keep')]), deletedChatIds: ['deleted-test-chat'] } }) }
                : { ok: true };
        }
    });
    vm.runInContext(source(assistant, 'cloudUpsert'), context);
    await context.cloudUpsert();
    assert.deepEqual(posts.map(p => p.name), ['chat-load']);
});

test('a stale assistant import is rejected while a fresh chat ID still imports', () => {
    const { context } = frontend([chat('keep')]);
    context.chatStore.deletedChatIds = ['deleted-test-chat'];
    context.history = { replaceState() {} };
    context.safeHtml = value => value;
    context.atob = value => Buffer.from(value, 'base64').toString('binary');
    vm.runInContext(source(html, 'importAssistantChat'), context);
    for (const id of ['deleted-test-chat', 'fresh-import']) {
        context.location = { hash: '#kwimport=' + Buffer.from(JSON.stringify(chat(id))).toString('base64url'), pathname: '/', search: '' };
        context.importAssistantChat();
    }
    assert.deepEqual(plain(context.chatStore.chats).map(c => c.id).sort(), ['fresh-import', 'keep']);
    assert.equal(context.chatStore.activeChatId, 'fresh-import');
});

test('guest deletions remain local and do not create cloud deletion intent', async () => {
    const { context, requests } = frontend();
    context.isCloudUser = () => false;
    await context.deleteChat('deleted-test-chat');
    await context.persistCloudStore();
    assert.equal(requests.length, 0);
    assert.deepEqual(plain(context.chatStore.deletedChatIds || []), []);
});

test('marker growth fails the document size cap rather than silently pruning old deletions', async () => {
    const ids = prefix => Array.from({ length: 35000 }, (_, index) => (prefix + index.toString(36).padStart(7, '0')).padEnd(60, 'x'));
    const initial = { ...cloudDoc([chat('keep')]), deletedChatIds: ids('old_') };
    const incoming = { ...cloudDoc([chat('keep')]), deletedChatIds: ids('new_') };
    assert.ok(Buffer.byteLength(JSON.stringify(incoming)) < 4.3 * 1024 * 1024, 'the incoming request is within the existing body cap');
    assert.ok(Buffer.byteLength(JSON.stringify([...initial.deletedChatIds, ...incoming.deletedChatIds])) > 4 * 1024 * 1024);
    const store = backend(initial);
    const result = await store.save(incoming, 20);
    assert.equal(result.statusCode, 413);
    assert.equal(store.get().updatedAt, 20, 'no oversized write was made');
    assert.deepEqual(store.get().deletedChatIds, initial.deletedChatIds);
});

test('actual client retry and server handler preserve deletion together end to end', async () => {
    const { context, requests } = frontend();
    const store = backend(cloudDoc([chat('keep'), chat('deleted-test-chat')]));
    context.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        const result = await store.save(body.doc, body.baseUpdatedAt);
        requests.push({ ...body, status: result.statusCode });
        return { ok: result.statusCode === 200, status: result.statusCode, json: async () => JSON.parse(result.body) };
    };
    await context.deleteChat('deleted-test-chat');
    await context.persistCloudStore();
    assert.deepEqual(requests.map(r => r.status), [409, 200]);
    assert.deepEqual(store.get().chats.map(c => c.id), ['keep']);
    assert.deepEqual(store.get().deletedChatIds, ['deleted-test-chat']);
    assert.deepEqual(store.get().memory, memory);
});

test('touch chat actions are visible without hover and have usable tap targets', () => {
    const touch = html.match(/@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n        \}/);
    assert.ok(touch, 'the override is limited to non-hover or coarse-pointer devices');
    assert.match(touch[1], /\.chat-actions\s*\{\s*display:\s*flex;/);
    assert.match(touch[1], /\.chat-action-btn\s*\{\s*width:\s*44px;\s*height:\s*44px;/);
});

test('desktop chat actions retain their existing hidden-until-hover behavior', () => {
    assert.match(html, /\.chat-actions\s*\{\s*display:\s*none;/);
    assert.match(html, /\.chat-list-item:hover \.chat-actions\s*\{\s*display:\s*flex;/);
    assert.match(html, /\.chat-action-btn\s*\{\s*width:\s*22px;\s*height:\s*22px;/);
});
