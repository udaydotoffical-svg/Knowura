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

test('live preview loads pages in a sandboxed /preview page with its own CSP, and the main CSP stays strict', () => {
    const h = pub('index.html');
    const tag = h.match(/<iframe id="cbFrame"[^>]*>/)[0];
    assert.match(tag, /sandbox="allow-scripts"/);
    assert.doesNotMatch(tag, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    assert.match(pub('preview.html'), /e\.source !== parent/);
    const vercel = require('../vercel.json');
    const rule = vercel.headers.find(r => r.source === '/preview');
    const csp = rule.headers.find(x => x.key === 'Content-Security-Policy').value;
    for (const d of ["connect-src 'none'", "form-action 'none'", 'sandbox allow-scripts', "frame-ancestors 'self'", 'img-src https:', 'font-src https:']) assert.ok(csp.includes(d), d);
    assert.match(csp, /script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com/);
    const main = vercel.headers[0];
    assert.match(main.source, /\?!preview/);
    const mainCsp = main.headers.find(x => x.key === 'Content-Security-Policy').value;
    assert.match(mainCsp, /img-src 'self' data: blob: https:\/\/\*\.googleusercontent\.com;/);
    assert.match(mainCsp, /frame-src 'self' https:\/\/accounts\.google\.com/);
    const netlify = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
    assert.match(netlify, /for = "\/preview"\n  \[headers\.values\]\n    Content-Security-Policy = "default-src 'none'/);
    assert.doesNotMatch(netlify, /for = "\/\*"\n  \[headers\.values\]\n(?:    [^\n]*\n)*    Content-Security-Policy/);
});
