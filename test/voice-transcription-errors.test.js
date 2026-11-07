const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function source(name) {
    const match = html.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^    \\}`, 'm'));
    assert.ok(match, `production function ${name} exists`);
    return match[0];
}
const failure = 'Transcription failed. Please try again.';
function harness(fetchImpl) {
    const calls = { requests: [], asks: [], limits: [], statuses: [] };
    const transcript = { innerText: '' };
    const context = vm.createContext({
        Blob, console: { error() {} },
        callActive: true, callMuted: false, callAttempt: 1, callState: 'capturing',
        callChunks: [new Blob(['x'.repeat(4000)])], callRecorder: { mimeType: 'audio/webm' },
        VAD_MIN_BYTES: 3000, ultraThinkMode: false, ownerToken: null, userToken: null,
        blobToBase64: async () => 'c3ludGhldGljLXRlc3QtZml4dHVyZQ==',
        fetch: async (url, options) => { calls.requests.push({ url, body: JSON.parse(options.body) }); return fetchImpl(url, options); },
        ask: async (text, options) => calls.asks.push({ text, options }),
        showLimit: data => calls.limits.push(data),
        clearCaptionTimer() {}, setOrbState() {},
        setLiveStatus: text => calls.statuses.push(text),
        document: { getElementById: () => transcript }
    });
    context.endCall = () => { context.callActive = false; context.callAttempt++; context.callState = 'idle'; };
    vm.runInContext(['enterListeningState', 'transcribeBlob', 'onCaptureStop'].map(source).join('\n'), context);
    return { context, calls, transcript };
}
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

for (const [name, fetchImpl] of [
    ['the confirmed synthetic 502', async () => response(502, { error: failure })],
    ['an HTTP error containing transcript-like text', async () => response(502, { text: 'do not send this' })],
    ['a non-string transcript', async () => response(200, { text: 42 })],
    ['a null success payload', async () => response(200, null)],
    ['a network failure', async () => { throw new TypeError('Failed to fetch'); }],
    ['invalid JSON', async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('not JSON'); } })],
    ['a malformed success payload', async () => response(200, { unexpected: true })]
]) {
    test(`live transcription surfaces ${name} while allowing the next utterance`, async () => {
        const { context, calls } = harness(fetchImpl);
        await context.onCaptureStop();
        assert.equal(calls.requests.length, 1, 'only the mocked transcribe endpoint is called');
        assert.equal(calls.requests[0].url, '/.netlify/functions/transcribe');
        assert.equal(calls.asks.length, 0, 'a failed transcription never creates a chat request');
        assert.equal(context.callActive, true);
        assert.equal(context.callState, 'listening', 'the call is ready to retry');
        assert.equal(calls.statuses.at(-1), failure, 'the visible error is not overwritten by Listening');
    });
}

test('a valid empty transcript quietly resumes listening without a chat request', async () => {
    const { context, calls } = harness(async () => response(200, { text: '  \n ' }));
    await context.onCaptureStop();
    assert.equal(calls.asks.length, 0);
    assert.equal(context.callState, 'listening');
    assert.equal(calls.statuses.at(-1), 'Listening…');
});

test('a valid transcript is trimmed and sent to the chat exactly once', async () => {
    const { context, calls, transcript } = harness(async () => response(200, { text: '  Explain gravity  ' }));
    await context.onCaptureStop();
    assert.equal(transcript.innerText, 'Explain gravity');
    assert.deepEqual(JSON.parse(JSON.stringify(calls.asks)), [{ text: 'Explain gravity', options: { speak: true, fromVoice: true } }]);
});

test('closing Live Voice during audio encoding prevents the stale audio upload', async () => {
    let finishEncoding;
    const { context, calls } = harness(async () => response(200, { text: 'must not arrive' }));
    context.blobToBase64 = () => new Promise(resolve => { finishEncoding = resolve; });
    const pending = context.onCaptureStop();
    assert.equal(context.callState, 'processing');
    context.endCall();
    finishEncoding('c3ludGhldGljLWF1ZGlv');
    await pending;
    assert.equal(calls.requests.length, 0, 'the stale call does not POST audio after encoding completes');
    assert.equal(calls.asks.length, 0);
    assert.equal(context.callActive, false);
});

test('a voice limit retains its dedicated notice and ends the call', async () => {
    const { context, calls } = harness(async () => response(429, { limitReached: true, error: 'Voice limit reached' }));
    await context.onCaptureStop();
    assert.equal(calls.limits.length, 1);
    assert.equal(context.callActive, false);
    assert.equal(calls.asks.length, 0);
    assert.equal(calls.statuses.includes(failure), false);
});

for (const [name, result] of [
    ['success', response(200, { text: 'stale words' })],
    ['error', response(502, { error: failure })],
    ['limit', response(429, { limitReached: true })]
]) {
    test(`an old call's pending ${name} cannot affect a newly opened call`, async () => {
        let complete, started;
        const requestStarted = new Promise(resolve => { started = resolve; });
        const { context, calls } = harness(() => { started(); return new Promise(resolve => { complete = resolve; }); });
        const pending = context.onCaptureStop();
        await requestStarted;
        context.endCall();
        context.callAttempt++;
        context.callActive = true;
        context.callState = 'listening';
        calls.statuses.length = 0;
        complete(result);
        await pending;
        assert.equal(calls.asks.length, 0);
        assert.equal(calls.limits.length, 0);
        assert.equal(calls.statuses.length, 0);
        assert.equal(context.callActive, true);
        assert.equal(context.callState, 'listening');
    });
}
