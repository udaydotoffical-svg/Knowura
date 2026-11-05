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
