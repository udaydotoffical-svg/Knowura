// Static checks on the site files: legal pages, version wiring, incognito safeguards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const pkg = require('../package.json');

test('DMCA policy exists, has the notice/counter-notice elements, and is linked from every legal page and the app', () => {
    const d = pub('dmca.html');
    assert.match(d, /Copyright &amp; DMCA Policy/);
    assert.match(d, /penalty of perjury/);
    assert.match(d, /[Cc]ounter-notice/);
    assert.match(d, /[Rr]epeat infringers/);
    for (const f of ['terms.html', 'privacy.html', 'eula.html', '404.html', 'index.html']) assert.match(pub(f), /href="\/dmca"/, `${f} should link to /dmca`);
});

test('the version shown in the app matches package.json', () => {
    assert.match(pub('index.html'), new RegExp(`id="aboutVersionNum">v${pkg.version.replace(/\./g, '\\.')}<`));
    assert.match(pkg.scripts.build, /write-version\.js/);
});

test('incognito never writes to storage, memory or the cloud', () => {
    const h = pub('index.html');
    const fn = (name) => { const i = h.indexOf(name); return h.slice(i, i + 400); };
    assert.match(fn('    function saveChatStore() {'), /if \(incognito\) return;/);
    assert.match(fn('    function scheduleCloudSave() {'), /incognito/);
    assert.match(fn('    async function persistCloudStore('), /incognito/);
    assert.match(fn('    function getMemory() {'), /incognito/);
    for (const f of ['    async function extractFacts(', '    async function maybeSummarize(', '    async function generateChatTitle(']) assert.match(fn(f), /if \(incognito\) return;/, f);
});

test('mini-code-boxz: code blocks become cards, the panel lives inside #app, highlighter is vendored locally', () => {
    const h = pub('index.html');
    assert.match(h, /<script src="assets\/vendor\/highlightjs\/highlight\.min\.js"/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public/assets/vendor/highlightjs/highlight.min.js')));
    assert.match(h, /\.replace\(\/<pre><code[^\n]*codeCardHTML\)/);
    assert.match(h, /data-code="\$\{escaped\.replace\(\/"\/g, '&quot;'\)\}"/);
    const app = h.slice(h.indexOf('<div id="app">'), h.indexOf('<div id="musicPanel"'));
    assert.match(app, /<aside id="codeBox"/);
});

test('live preview runs only in a locked-down sandboxed iframe', () => {
    const h = pub('index.html');
    const tag = h.match(/<iframe id="cbFrame"[^>]*>/)[0];
    assert.match(tag, /sandbox="allow-scripts"/);
    assert.doesNotMatch(tag, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    assert.match(h, /default-src 'none'/);
});
