// Actually EXECUTES the inline script's top-level init code against a stub DOM,
// inside Node's real V8 engine — so real runtime errors (TDZ, undefined access,
// etc.) surface here instead of only in a live browser. Static checks alone
// (grepping for names) can't catch this class of bug.
const vm = require('vm');
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
// the head also has a tiny inline <script> (Lite-mode detection) — the app script is the longest one
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).sort((a, b) => b.length - a.length)[0];

function makeEl() {
    const el = {
        style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {},
        appendChild() { return el; }, removeChild() {},
        querySelectorAll() { return []; },
        querySelector() { return makeEl(); },
        setAttribute() {}, getAttribute() { return null; }, remove() {}, toggleAttribute() {}, removeAttribute() {}, closest() { return null; },
        focus() {}, click() {},
        value: '', innerHTML: '', innerText: '', textContent: '', title: '', type: 'text',
        dataset: {}, children: [], parentNode: null, disabled: false,
        getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
        scrollIntoView() {}, scrollTop: 0,
        play() { return Promise.resolve(); }, pause() {},
        src: '', currentTime: 0, duration: 0, paused: true, volume: 1, mimeType: '',
    };
    return el;
}

const fakeDocument = {
    getElementById() { return makeEl(); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return makeEl(); },
    createTreeWalker() { return { nextNode() { return null; } }; },
    documentElement: makeEl(),
    body: makeEl(),
};

const errorLog = [];
const sandbox = {
    // warn/info are expected noise from the stubs (no real orb engine, canned fetch reply) — hidden
    // so a genuine failure stands out; console.error still fails the check.
    console: { ...console, warn() {}, info() {}, error: (...a) => { errorLog.push(a.map(String).join(' ')); } },
    navigator: { userAgent: 'node-sim', mediaDevices: {}, maxTouchPoints: 0 },
    location: { search: '', href: 'http://localhost/' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch(url) {
        const body = String(url).includes('ask-ai') ? { choices: [{ message: { content: 'hi there' } }] } : {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve('') });
    },
    AbortController, performance,
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout,
    setInterval() { return 0; }, // stubbed: don't actually keep the process alive for a one-shot check
    clearInterval() {},
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    AudioContext: function () {
        return {
            createMediaStreamSource() { return { connect() {} }; },
            createMediaElementSource() { return { connect() {} }; },
            createAnalyser() { return { connect() {}, frequencyBinCount: 32, fftSize: 32, getByteFrequencyData() {}, getByteTimeDomainData() {} }; },
        };
    },
    Audio: function () { return makeEl(); },
    MediaRecorder: function () { return { start() {}, stop() {}, state: 'inactive' }; },
    Blob: function () { return {}; },
    marked: { parse: (s) => s },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    NodeFilter: { SHOW_TEXT: 4 },
};
sandbox.window = sandbox;
sandbox.document = fakeDocument;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
    vm.runInContext(script, sandbox, { filename: 'inline-script.js' });
    console.log('SCRIPT INIT RAN WITHOUT ERROR');

    // Performance modes: switching must not throw
    vm.runInContext("setPerfMode('lite'); setPerfMode('balanced'); setPerfMode('full'); setPerfMode('auto'); bumpFpsSampler();", sandbox);
    console.log('PERF MODE SWITCH PASSED');

    // First-visit intro: the API must exist and replay()/reset() must not throw
    // (init already ran the IIFE once above, against a fake unseen visitor).
    const introOk = vm.runInContext(
        "typeof window.knowuraIntro === 'object' && typeof window.knowuraIntro.replay === 'function' && typeof window.knowuraIntro.maybeStart === 'function' && typeof window.knowuraIntro.reset === 'function'",
        sandbox
    );
    vm.runInContext("window.knowuraIntro.replay(); window.knowuraIntro.reset();", sandbox);
    console.log(introOk ? 'INTRO API PASSED' : 'INTRO API FAILED: knowuraIntro missing replay/maybeStart/reset');
    if (!introOk) process.exitCode = 1;

    // Smoke-test ask(): it swallows its own errors into a "Connection lost"
    // bubble, so a ReferenceError inside it only shows up as a console.error.
    vm.runInContext("ask('hello')", sandbox).then(() => {
        if (errorLog.length) {
            console.log('ask() SMOKE TEST FAILED:', errorLog[0]);
            process.exitCode = 1;
        } else {
            console.log('ask() SMOKE TEST PASSED');
        }
    });
} catch (e) {
    console.log('RUNTIME ERROR DURING INIT:', e.message);
    console.log(e.stack.split('\n').slice(0, 6).join('\n'));
    process.exitCode = 1;
}
