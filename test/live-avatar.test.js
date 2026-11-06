const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const pub = (file) => fs.readFileSync(path.join(root, 'public', file), 'utf8');
const avatarJs = pub('assets/ui/live-avatar.js');
const avatarCss = pub('assets/ui/live-avatar.css');
const runtimeHtml = pub('assets/avatar/dot-avatar-live.html');
const moduleDir = path.join(root, 'public/assets/avatar/modules');
const stillFallback = path.join(root, 'public/assets/avatar/dot-avatar-fallback.png');

function makeClassList(initial = []) {
    const values = new Set(initial);
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        contains: (name) => values.has(name),
        toggle(name, force) {
            const next = force === undefined ? !values.has(name) : !!force;
            if (next) values.add(name);
            else values.delete(name);
            return next;
        }
    };
}

function makeHarness({ assistant = false, reduced = false } = {}) {
    const panel = { classList: makeClassList(['open']) };
    const wrap = {
        classList: makeClassList(),
        dataset: {},
        style: {
            values: new Map(),
            setProperty(key, value) { this.values.set(key, String(value)); },
            getPropertyValue(key) { return this.values.get(key) || ''; }
        },
        insertBefore(node) { this.frame = node; }
    };
    const fallback = {
        attributes: { src: 'assets/images/bloub-cercle-neutre-bleu.gif' },
        currentSrc: 'https://knowura.test/assets/images/bloub-cercle-neutre-bleu.gif',
        getAttribute(key) { return this.attributes[key] ?? null; },
        setAttribute(key, value) { this.attributes[key] = String(value); },
        removeAttribute(key) { delete this.attributes[key]; }
    };
    const status = { textContent: 'Listening…' };
    const observers = [];
    const map = { orbWrap: wrap, liveOrb: fallback, liveStatus: status };
    map[assistant ? 'voiceView' : 'livePanel'] = panel;
    const document = {
        readyState: 'complete',
        documentElement: { classList: makeClassList() },
        getElementById(id) { return map[id] || null; },
        createElement(name) {
            assert.equal(name, 'iframe');
            const attributes = {};
            const node = {
                id: '', className: '', title: '', tabIndex: 0, style: {},
                referrerPolicy: '', loading: '',
                contentWindow: { dotAvatarViewer: null },
                attributes,
                setAttribute(key, value) { attributes[key] = String(value); },
                getAttribute(key) { return attributes[key] ?? null; },
                removeAttribute(key) { delete attributes[key]; }
            };
            Object.defineProperty(node, 'src', {
                get() { return attributes.src || ''; },
                set(value) { attributes.src = String(value); }
            });
            return node;
        },
        addEventListener() {}
    };
    const messageHandlers = [];
    const timeouts = new Map();
    let timerId = 0;
    const mediaHandlers = [];
    const media = {
        matches: reduced,
        addEventListener(_name, callback) { mediaHandlers.push(callback); },
        addListener(callback) { mediaHandlers.push(callback); }
    };
    const window = {
        matchMedia: () => media,
        setTimeout(callback, delay) { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timeouts.delete(id); },
        addEventListener(name, callback) { if (name === 'message') messageHandlers.push(callback); }
    };
    class FakeMutationObserver {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(target) { this.targets.push(target); }
        trigger(target) { if (this.targets.includes(target)) this.callback([], this); }
    }
    const location = { href: 'https://knowura.test/index.html', origin: 'https://knowura.test' };
    const context = {
        document, window, location, URL, MutationObserver: FakeMutationObserver,
        console: { warn() {}, error() {} }
    };
    vm.runInNewContext(avatarJs, context, { filename: 'live-avatar.js' });

    function trigger(target) {
        for (const observer of observers) observer.trigger(target);
    }
    function message(data) {
        const event = {
            source: wrap.frame.contentWindow,
            origin: location.origin,
            data
        };
        for (const handler of messageHandlers) handler(event);
    }
    function instanceOf(frame) {
        return new URL(frame.src, location.href).searchParams.get('instance');
    }
    function changeMotion(value) {
        media.matches = value;
        for (const handler of mediaHandlers) handler({ matches: value });
    }
    return {
        panel, wrap, fallback, status, window, document, observers, timeouts,
        messageHandlers, instanceOf, message, trigger, changeMotion,
        api: window.KnowuraLiveAvatar
    };
}

test('the same avatar controller and assets are wired into both live voice surfaces', () => {
    for (const file of ['index.html', 'assistant.html']) {
        const html = pub(file);
        assert.match(html, /assets\/ui\/live-avatar\.css/);
        assert.match(html, /assets\/ui\/live-avatar\.js/);
    }
    assert.match(avatarJs, /getElementById\('livePanel'\) \|\| document\.getElementById\('voiceView'\)/);
});

test('the 3D viewer uses same-origin ES modules permitted by the existing response CSP', () => {
    const vercel = JSON.parse(pub('../vercel.json'));
    const mainRule = vercel.headers.find((rule) => rule.source === '/((?!preview).*)');
    const csp = mainRule.headers.find((header) => header.key === 'Content-Security-Policy').value;
    const scriptSrc = csp.match(/script-src ([^;]+)/)[1];
    assert.match(scriptSrc, /'self'/);
    assert.doesNotMatch(scriptSrc, /\bblob:|\bdata:/);
    assert.match(runtimeHtml, /<script type="module" src="\/assets\/avatar\/modules\/boot\.js"><\/script>/);
    assert.doesNotMatch(runtimeHtml, /data-mod=|URL\.createObjectURL|new Blob|data:text\/javascript/);
    const metaScriptSrc = runtimeHtml.match(/script-src ([^;]+)/)[1];
    assert.doesNotMatch(metaScriptSrc, /\bblob:|\bdata:/);

    const files = fs.readdirSync(moduleDir).filter((file) => file.endsWith('.js'));
    assert.deepEqual(files.sort(), [
        'accessories.js', 'boot.js', 'catalog.js', 'face.js', 'materials.js',
        'mesher.js', 'scene.js', 'sdf.js', 'three.core.min.js', 'three.module.js', 'viewer.js'
    ]);
    const boot = fs.readFileSync(path.join(moduleDir, 'boot.js'), 'utf8');
    const bootImports = [...boot.matchAll(/^import .*? from '([^']+)';$/gm)].map((match) => match[1]);
    assert.equal(bootImports.length, 9);
    assert.ok(bootImports.every((specifier) => specifier.startsWith('./')));
    assert.match(fs.readFileSync(path.join(moduleDir, 'three.module.js'), 'utf8'), /from"\.\/three\.core\.min\.js"/);
});

test('the frame is consistently decorative for pointer and keyboard input', () => {
    const h = makeHarness();
    const frame = h.wrap.frame;
    assert.ok(frame);
    assert.equal(frame.tabIndex, -1);
    assert.equal(frame.getAttribute('aria-hidden'), 'true');
    assert.match(avatarCss, /#orbWrap #liveAvatarFrame[\s\S]*?pointer-events:\s*none/);
    const boot = fs.readFileSync(path.join(moduleDir, 'boot.js'), 'utf8');
    assert.match(boot, /canvas\.tabIndex\s*=\s*-1/);
    assert.match(boot, /canvas\.style\.pointerEvents\s*=\s*'none'/);
});

test('close/reopen rejects a stale ready message from the prior iframe navigation', () => {
    const h = makeHarness();
    const frame = h.wrap.frame;
    const oldInstance = h.instanceOf(frame);
    assert.ok(oldInstance);

    h.panel.classList.remove('open');
    h.trigger(h.panel);
    assert.equal(frame.getAttribute('src'), null);
    h.panel.classList.add('open');
    h.trigger(h.panel);
    const newInstance = h.instanceOf(frame);
    assert.notEqual(newInstance, oldInstance);

    const expressions = [];
    const motionCalls = [];
    frame.contentWindow.dotAvatarViewer = {
        setExpression(...args) { expressions.push(args); },
        setReducedMotion(value) { motionCalls.push(value); },
        dispose() {}
    };
    h.message({ type: 'knowura-live-avatar-ready', ok: true, instance: oldInstance });
    assert.equal(h.wrap.classList.contains('dot-avatar-ready'), false);
    h.message({ type: 'knowura-live-avatar-ready', ok: true, instance: newInstance });
    assert.equal(h.wrap.classList.contains('dot-avatar-ready'), true);
    assert.ok(expressions.length > 0);
    assert.deepEqual(motionCalls, [false]);
});

test('reduced motion uses a real still fallback and disables panel, level, and viewer motion', () => {
    const h = makeHarness({ reduced: true });
    assert.ok(fs.existsSync(stillFallback));
    assert.equal(h.fallback.getAttribute('src'), '/assets/avatar/dot-avatar-fallback.png');
    assert.match(avatarCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none\s*!important/);
    assert.match(avatarCss, /html\.lite #livePanel[\s\S]*?animation:\s*none\s*!important/);
    assert.match(avatarCss, /transform:\s*none\s*!important/);

    const frame = h.wrap.frame;
    const reducedCalls = [];
    frame.contentWindow.dotAvatarViewer = {
        setExpression() {},
        setReducedMotion(value) { reducedCalls.push(value); },
        dispose() {}
    };
    h.message({ type: 'knowura-live-avatar-ready', ok: true, instance: h.instanceOf(frame) });
    assert.deepEqual(reducedCalls, [true]);
    h.changeMotion(false);
    assert.equal(h.fallback.getAttribute('src'), 'assets/images/bloub-cercle-neutre-bleu.gif');
    assert.deepEqual(reducedCalls, [true, false]);
});

test('all ten voice states map, and non-listening states clear mic-level feedback', () => {
    const h = makeHarness({ assistant: true });
    const cases = [
        ['Call ended', 'idle'],
        ['Listening…', 'listening'],
        ['Thinking…', 'thinking'],
        ['Speaking…', 'speaking'],
        ['Ultra thinking…', 'ultra'],
        ['Connecting…', 'starting'],
        ['Muted', 'muted'],
        ['Microphone permission denied', 'mic-permission'],
        ['Microphone unavailable', 'mic-unavailable'],
        ['Text mode — continue by typing', 'text-fallback']
    ];
    for (const [text, expected] of cases) {
        h.status.textContent = text;
        h.trigger(h.status);
        assert.equal(h.api.getState(), expected, text);
    }
    h.api.setState('listening');
    h.api.setLevel(.63);
    assert.equal(h.api.getLevel(), .63);
    h.api.setState('muted');
    assert.equal(h.api.getLevel(), 0);
    assert.deepEqual([...h.api.states].sort(), [
        'idle', 'listening', 'thinking', 'speaking', 'ultra', 'starting', 'muted',
        'mic-permission', 'mic-unavailable', 'text-fallback'
    ].sort());
});

test('main mic denial shows the permission expression before the existing alert and close', () => {
    const html = pub('index.html');
    const start = html.indexOf('    async function startCall() {');
    const end = html.indexOf('    // ─── PUSH TO TALK', start);
    const startCall = html.slice(start, end);
    const statusAt = startCall.indexOf("setLiveStatus(unavailable ? 'Microphone unavailable' : 'Microphone permission denied')");
    const stateAt = startCall.indexOf('window.KnowuraLiveAvatar?.setState(avatarState)');
    const holdAt = startCall.indexOf('await new Promise(resolve => setTimeout(resolve, 850))');
    const alertAt = startCall.indexOf('showAlert("Microphone access is required for Live Mode."');
    const closeAt = startCall.indexOf('closeLivePanel();', alertAt);
    assert.ok(statusAt >= 0 && stateAt > statusAt && holdAt > stateAt && alertAt > holdAt && closeAt > alertAt);
    assert.match(startCall, /const attempt = \+\+callAttempt/);
    assert.match(startCall, /stream\?\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
});

test('main VAD feeds mic level into the Dot and clears it when the call ends', () => {
    const html = pub('index.html');
    const vadStart = html.indexOf('    function vadLoop() {');
    const vadEnd = html.indexOf('    function beginCapture()', vadStart);
    const vadLoop = html.slice(vadStart, vadEnd);
    assert.match(vadLoop, /KnowuraLiveAvatar\?\.setLevel\(Math\.min\(1, rms \* 6\)\)/);
    const endStart = html.indexOf('    function endCall() {');
    const endEnd = html.indexOf('    function enterListeningState()', endStart);
    assert.match(html.slice(endStart, endEnd), /KnowuraLiveAvatar\?\.setLevel\(0\)/);
    assert.match(avatarCss, /var\(--lvl, 0\) \* \.22 \+ var\(--avatar-level, 0\) \* \.22/);
});

test('both voice surfaces keep the avatar layer transparent and remove decorative orbit rings', () => {
    for (const file of ['index.html', 'assistant.html']) {
        const html = pub(file);
        assert.doesNotMatch(html, /class="ring(?:\s|\")/);
    }
    assert.match(avatarCss, /background:\s*transparent\s*!important/);
    assert.match(avatarCss, /#orbWrap \.ring[\s\S]*?display:\s*none\s*!important/);
    assert.match(runtimeHtml, /html\.avatar-embed body\{background:transparent!important;background-color:transparent!important\}/);
    assert.match(runtimeHtml, /html\.avatar-embed\{color-scheme:light;background:transparent!important;background-color:transparent!important\}/);
    assert.match(runtimeHtml, /html\.avatar-embed #model-stage>canvas\.dv-canvas\{background:transparent!important;background-color:transparent!important\}/);
    const viewer = fs.readFileSync(path.join(moduleDir, 'viewer.js'), 'utf8');
    assert.match(viewer, /renderer\.setClearColor\(0x000000, 0\)/);
    assert.match(viewer, /renderer\.setClearAlpha\?\.\(0\)/);
    assert.match(viewer, /const embedMode = doc\.documentElement\.classList\.contains\('avatar-embed'\)/);
    assert.match(viewer, /if \(!embedMode\)[\s\S]*?scene\.add\(ground\)/);
});

test('speech mouth input comes from measured playback waveform instead of synthetic word timing', () => {
    for (const file of ['index.html', 'assistant.html']) assert.match(pub(file), /attachSpeechAudio\(/);
    assert.match(avatarJs, /analyser\.getByteTimeDomainData\(samples\)/);
    assert.match(avatarJs, /const rms = Math\.sqrt\(sum \/ samples\.length\)/);
    const viewer = fs.readFileSync(path.join(moduleDir, 'viewer.js'), 'utf8');
    assert.match(viewer, /live playback envelope, not a guessed word\/viseme animation/);
    assert.match(viewer, /function setSpeechLevel\(value\)/);
    assert.doesNotMatch(viewer, /const rhythm = 0\.5 \+ 0\.5 \* Math\.sin/);
});

test('performance Lite keeps playback-level mouth motion while actual reduced motion suppresses it', () => {
    const h = makeHarness();
    const frame = h.wrap.frame;
    const reducedCalls = [], liteCalls = [], speechLevels = [];
    frame.contentWindow.dotAvatarViewer = {
        setExpression() {},
        setReducedMotion(value) { reducedCalls.push(value); },
        setPerformanceLite(value) { liteCalls.push(value); },
        setSpeechLevel(value) { speechLevels.push(value); },
        dispose() {}
    };
    h.message({ type: 'knowura-live-avatar-ready', ok: true, instance: h.instanceOf(frame) });
    h.document.documentElement.classList.add('lite');
    h.trigger(h.document.documentElement);
    h.api.setState('speaking');
    h.api.setSpeechLevel(.62);
    assert.deepEqual(reducedCalls, [false, false]);
    assert.deepEqual(liteCalls, [false, true]);
    assert.equal(speechLevels.at(-1), .62);

    h.changeMotion(true);
    h.api.setSpeechLevel(.45);
    assert.deepEqual(reducedCalls, [false, false, true]);
    assert.equal(speechLevels.at(-1), 0);

    const viewer = fs.readFileSync(path.join(moduleDir, 'viewer.js'), 'utf8');
    assert.match(viewer, /const amount = reducedPresentation \? 0 : performanceLite[\s\S]*?animationState === 'speaking' \? 1 : 0/);
    assert.match(viewer, /function setSpeechLevel\(value\)[\s\S]*?speechLevel = reducedPresentation \|\| !Number\.isFinite\(level\)/);
    assert.match(avatarJs, /viewer\.setPerformanceLite\?\.\(performanceLite\(\)\)/);
});

test('main voice TTS media errors clean the analyser/audio and return to listening', () => {
    const html = pub('index.html');
    const start = html.indexOf('    async function speakReply(text) {');
    const end = html.indexOf('    // ─── LIVE CAPTIONS', start);
    const fn = html.slice(start, end);
    assert.match(fn, /finished\.onerror\s*=\s*\(\)\s*=>\s*finishPlayback\(finished\.error/);
    assert.match(fn, /if \(activeReplyAnalyserCleanup === unhook\) activeReplyAnalyserCleanup = null/);
    assert.match(fn, /finished\.removeAttribute\('src'\)/);
    assert.match(fn, /finished\.load\(\)/);
    assert.match(fn, /if \(callActive\) enterListeningState\(\); else setOrbState\('idle'\)/);
    assert.match(fn, /let playbackFinished = false/);
});

test('received response text pulses are subtle, deduplicated, rate-limited, and respect voice haptic preferences', () => {
    const h = makeHarness();
    const pulses = [];
    let now = 1000;
    let preference = 'off';
    h.window.navigator = {
        userActivation: { hasBeenActive: true },
        vibrate(pattern) { pulses.push([...pattern]); return true; }
    };
    h.window.performance = { now: () => now };
    h.window.localStorage = { getItem(key) { assert.equal(key, 'knowura_settings'); return JSON.stringify({ haptics: preference }); } };

    assert.equal(h.api.responseTextChunk('  '), false);
    assert.equal(h.api.responseTextChunk('first chunk'), false);
    assert.equal(pulses.length, 0);
    preference = 'on';
    now += 100;
    h.api.resetResponseText();
    assert.equal(h.api.responseTextChunk('first chunk'), true);
    assert.deepEqual(pulses.at(-1), [7]);
    assert.equal(h.api.responseTextChunk('first chunk'), false);
    now += 100;
    assert.equal(h.api.responseTextChunk('first chunk plus another chunk'), false);
    now += 130;
    assert.equal(h.api.responseTextChunk('first chunk plus another chunk!'), true);
    assert.deepEqual(pulses.at(-1), [7]);
    preference = 'max';
    now += 250;
    assert.equal(h.api.hapticEvent('interrupt'), true);
    assert.deepEqual(pulses.at(-1), [41, 28, 19]);
    now += 250;
    assert.equal(h.api.responseTextChunk('third fresh chunk'), true);
    assert.deepEqual(pulses.at(-1), [17]);
    h.changeMotion(true);
    now += 250;
    assert.equal(h.api.responseTextChunk('fourth fresh chunk'), false);
    assert.equal(pulses.length, 4);
    h.changeMotion(false);
    h.window.navigator.userActivation.hasBeenActive = false;
    now += 250;
    assert.equal(h.api.responseTextChunk('fifth fresh chunk'), false);
    h.window.navigator.userActivation.hasBeenActive = true;
    assert.equal(h.api.hapticEvent('speech-start'), false);
    assert.equal(h.api.hapticEvent('speech-end'), false);
    h.window.navigator.vibrate = undefined;
    now += 250;
    assert.equal(h.api.responseTextChunk('sixth fresh chunk'), false);
});

test('the first response-text pulse is not suppressed by page-load time', () => {
    const h = makeHarness();
    const pulses = [];
    h.window.navigator = {
        userActivation: { hasBeenActive: true },
        vibrate(pattern) { pulses.push([...pattern]); return true; }
    };
    h.window.performance = { now: () => 100 };
    h.window.localStorage = { getItem() { return JSON.stringify({ haptics: 'on' }); } };

    assert.equal(h.api.responseTextChunk('first response'), true);
    assert.deepEqual(pulses, [[7]]);
});

test('voice haptics fire on received reply text, never on audio playback alone', () => {
    const main = pub('index.html');
    const assistant = pub('assistant.html');
    const mainAsk = main.slice(main.indexOf('    async function ask('), main.indexOf('    // ─── TYPEWRITER REPLY'));
    const assistantTurn = assistant.slice(assistant.indexOf('    async function onCaptured('), assistant.indexOf('    function backToListening'));
    const mainSpeech = main.slice(main.indexOf('    async function speakReply('), main.indexOf('    // ─── LIVE CAPTIONS'));
    const assistantSpeech = assistant.slice(assistant.indexOf('    async function speakInCall('), assistant.indexOf('    let captionTimer'));
    assert.match(mainAsk, /if \(opts\.fromVoice\) window\.KnowuraLiveAvatar\?\.responseTextChunk\?\.\(reply\)/);
    assert.ok(mainAsk.indexOf('responseTextChunk?.(reply)') < mainAsk.indexOf('if (opts.speak) speakReply(reply)'));
    assert.match(mainAsk, /typeReveal\(thinking, \{ haptics: !opts\.fromVoice \}\)/);
    assert.match(assistantTurn, /window\.KnowuraLiveAvatar\?\.responseTextChunk\?\.\(reply\)/);
    assert.ok(assistantTurn.indexOf('responseTextChunk?.(reply)') < assistantTurn.indexOf('await speakInCall(c, reply)'));
    assert.doesNotMatch(mainSpeech + assistantSpeech, /hapticEvent\(['"]speech-(?:start|end)['"]\)/);
    assert.doesNotMatch(assistantSpeech, /audio\.onplaying\s*=.*haptic/);
});

test('Study Mode banner uses the existing transparent 3D Dot embed in its original-size slot', () => {
    const html = pub('index.html');
    const dotRule = /\.study-strip \.study-dot-frame\s*\{([^}]*)\}/.exec(html);
    const stripStart = html.indexOf('<div id="studyStrip"');
    const stripEnd = html.indexOf('</div>', stripStart);
    const studyStrip = html.slice(stripStart, stripEnd + 6);
    assert.ok(dotRule);
    assert.ok(stripStart >= 0 && stripEnd > stripStart);
    assert.match(dotRule[1], /width:\s*36px/);
    assert.match(dotRule[1], /height:\s*36px/);
    assert.match(dotRule[1], /overflow:\s*hidden/);
    assert.match(studyStrip, /<iframe class="study-dot-frame" src="\/assets\/avatar\/dot-avatar-live\.html\?embed=1"[^>]*aria-hidden="true"[^>]*loading="lazy"/);
    assert.match(html, /background:\s*var\(--cyan\) url\(\/assets\/brand\/k-mark\.svg\)/);
    assert.doesNotMatch(html, /study-mode-on \.ai::before/);
    assert.doesNotMatch(studyStrip, /bloub-cercle-neutre-bleu\.gif/);
});

test('speech analysis is optional without AudioContext and direct playback remains available', async () => {
    const h = makeHarness();
    let plays = 0;
    const audio = { play() { plays++; return Promise.resolve('played'); } };
    assert.equal(h.api.attachSpeechAudio(audio), null);
    assert.equal(await audio.play(), 'played');
    assert.equal(plays, 1);
});

test('suspended AudioContexts are not allowed to capture TTS playback', async () => {
    const h = makeHarness();
    let created = 0, captures = 0, resumes = 0, ownedCloses = 0, suppliedCloses = 0, plays = 0;
    h.window.AudioContext = class {
        constructor() { created++; this.state = 'suspended'; this.destination = {}; }
        resume() { resumes++; return new Promise(() => {}); }
        close() { ownedCloses++; return Promise.resolve(); }
        createMediaElementSource() { captures++; throw new Error('must not capture a suspended source'); }
    };
    const supplied = {
        state: 'suspended', destination: {},
        resume() { resumes++; return new Promise(() => {}); },
        close() { suppliedCloses++; return Promise.resolve(); },
        createMediaElementSource() { captures++; throw new Error('must not capture a suspended source'); }
    };
    const audio = { play() { plays++; return Promise.resolve('played'); } };
    assert.equal(h.api.attachSpeechAudio(audio), null);
    assert.equal(h.api.attachSpeechAudio(audio, supplied), null);
    assert.equal(created, 1);
    assert.equal(captures, 0);
    assert.equal(resumes, 0);
    assert.equal(ownedCloses, 1);
    assert.equal(suppliedCloses, 0);
    assert.equal(await audio.play(), 'played');
    assert.equal(plays, 1);
});

test('analyser setup failure reconnects a captured source directly to output', () => {
    const h = makeHarness();
    const destination = {};
    const connected = [];
    const source = {
        connect(target) { connected.push(target); },
        disconnect() {}
    };
    const audio = {
        paused: true, ended: false,
        addEventListener() {}, removeEventListener() {}
    };
    const context = {
        state: 'running', destination,
        createMediaElementSource(value) { assert.equal(value, audio); return source; },
        createAnalyser() { throw new Error('analyser unavailable'); }
    };
    const cleanup = h.api.attachSpeechAudio(audio, context);
    assert.equal(typeof cleanup, 'function');
    assert.deepEqual(connected, [destination]);
    cleanup();
});

test('audio analyser passes clamped live RMS levels to the speaking Dot and clears on cleanup', () => {
    const h = makeHarness();
    const frame = h.wrap.frame;
    const levels = [];
    frame.contentWindow.dotAvatarViewer = {
        setExpression() {},
        setSpeechLevel(value) { levels.push(value); },
        setReducedMotion() {},
        dispose() {}
    };
    h.message({ type: 'knowura-live-avatar-ready', ok: true, instance: h.instanceOf(frame) });
    h.api.setState('speaking');
    h.window.requestAnimationFrame = () => 1;
    h.window.cancelAnimationFrame = () => {};

    const listeners = new Map();
    const audio = {
        paused: false,
        ended: false,
        addEventListener(name, fn) { listeners.set(name, fn); },
        removeEventListener(name) { listeners.delete(name); },
        fire(name) { listeners.get(name)?.(); }
    };
    const source = { connect() {}, disconnect() {} };
    const analyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect() {},
        disconnect() {},
        getByteTimeDomainData(samples) { samples.fill(192); }
    };
    const context = {
        state: 'running', destination: {},
        createMediaElementSource(value) { assert.equal(value, audio); return source; },
        createAnalyser() { return analyser; }
    };
    const observed = [];
    const cleanup = h.api.attachSpeechAudio(audio, context, (value) => observed.push(value));
    assert.equal(typeof cleanup, 'function');
    assert.equal(analyser.fftSize, 512);
    audio.fire('play');
    assert.ok(Math.abs(observed[0] - 0.5) < 0.0001);
    assert.ok(Math.abs(levels.at(-1) - 0.5) < 0.0001);
    cleanup();
    assert.equal(levels.at(-1), 0);
    assert.equal(listeners.size, 0);
});

test('legacy voice images are hidden from first paint, including loading and failed states', () => {
    for (const file of ['index.html', 'assistant.html']) {
        const image = pub(file).match(/<img\b[^>]*id="liveOrb"[^>]*>/)?.[0] || '';
        assert.match(image, /style="visibility:hidden"/);
        assert.match(image, /aria-hidden="true"/);
    }
    // An unconditional rule keeps both initial loading and a real WebGL failure
    // from resurrecting the previous GIF, while visibility preserves its layout.
    const rule = avatarCss.match(/#orbWrap #liveOrb\s*\{([^}]+)\}/)?.[1] || '';
    assert.match(rule, /visibility:\s*hidden/);
    assert.match(rule, /opacity:\s*0/);
    assert.doesNotMatch(rule, /display:\s*none/);
});

test('the iframe remains non-painting until ready and matches the transparent embed color scheme', () => {
    const hidden = avatarCss.match(/#orbWrap #liveAvatarFrame\s*\{([^}]+)\}/)?.[1] || '';
    const visible = avatarCss.match(/#orbWrap\.dot-avatar-ready #liveAvatarFrame\s*\{([^}]+)\}/)?.[1] || '';
    assert.match(hidden, /visibility:\s*hidden/);
    assert.match(hidden, /opacity:\s*0/);
    assert.match(hidden, /background:\s*transparent\s*!important/);
    assert.match(hidden, /color-scheme:\s*light/);
    assert.match(visible, /visibility:\s*visible/);
    assert.match(visible, /opacity:\s*1/);
    assert.match(runtimeHtml, /html\.avatar-embed\{color-scheme:light/);
});

test('Dot state and motion are applied while hidden, and close hides it before disposal', () => {
    for (const assistant of [false, true]) {
        const h = makeHarness({ assistant });
        const frame = h.wrap.frame;
        const applied = [];
        frame.contentWindow.dotAvatarViewer = {
            setExpression() {
                assert.equal(h.wrap.classList.contains('dot-avatar-ready'), false);
                applied.push('expression');
            },
            setReducedMotion() {
                assert.equal(h.wrap.classList.contains('dot-avatar-ready'), false);
                applied.push('motion');
            },
            dispose() {
                assert.equal(h.wrap.classList.contains('dot-avatar-ready'), false);
                assert.equal(h.api.isReady(), false);
                applied.push('dispose');
            }
        };
        h.message({ type: 'knowura-live-avatar-ready', ok: true, instance: h.instanceOf(frame) });
        assert.deepEqual(applied, ['expression', 'motion']);
        assert.equal(h.wrap.classList.contains('dot-avatar-ready'), true);
        h.panel.classList.remove('open');
        h.trigger(h.panel);
        assert.equal(applied.at(-1), 'dispose');
        assert.equal(frame.getAttribute('src'), null);
    }
});

test('a startup timeout stays hidden and cannot be revealed by a late ready message', () => {
    const h = makeHarness();
    const frame = h.wrap.frame;
    const instance = h.instanceOf(frame);
    frame.contentWindow.dotAvatarViewer = { setExpression() {}, setReducedMotion() {} };
    const timeout = [...h.timeouts.values()].find(({ delay }) => delay === 20000);
    assert.ok(timeout);
    timeout.callback();
    assert.equal(h.wrap.classList.contains('dot-avatar-failed'), true);
    assert.equal(h.wrap.classList.contains('dot-avatar-ready'), false);
    assert.equal(frame.getAttribute('src'), null);
    h.message({ type: 'knowura-live-avatar-ready', ok: true, instance });
    assert.equal(h.api.isReady(), false);
    assert.equal(h.wrap.classList.contains('dot-avatar-ready'), false);
});
