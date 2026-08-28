// Actually EXECUTES the inline script's top-level init code against a stub DOM,
// inside Node's real V8 engine — so real runtime errors (TDZ, undefined access,
// etc.) surface here instead of only in a live browser. Static checks alone
// (grepping for names) can't catch this class of bug.
const vm = require('vm');
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

function makeEl() {
    const el = {
        style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {},
        appendChild() { return el; }, removeChild() {},
        querySelectorAll() { return []; },
        querySelector() { return makeEl(); },
        setAttribute() {}, getAttribute() { return null; },
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
    documentElement: makeEl(),
};

const sandbox = {
    console,
    navigator: { userAgent: 'node-sim', mediaDevices: {}, maxTouchPoints: 0 },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') }); },
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
};
sandbox.window = sandbox;
sandbox.document = fakeDocument;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
    vm.runInContext(script, sandbox, { filename: 'inline-script.js' });
    console.log('SCRIPT INIT RAN WITHOUT ERROR');
} catch (e) {
    console.log('RUNTIME ERROR DURING INIT:', e.message);
    console.log(e.stack.split('\n').slice(0, 6).join('\n'));
    process.exitCode = 1;
}
