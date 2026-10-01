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

test('fonts are self-hosted: no page or CSP contacts Google Fonts, and the legal pages carry the required disclosures', () => {
    for (const f of ['index.html', 'terms.html', 'privacy.html', 'eula.html', 'dmca.html', '404.html']) {
        assert.doesNotMatch(pub(f), /fonts\.(googleapis|gstatic)\.com/, `${f} must not load Google Fonts`);
        assert.match(pub(f), /href="\/assets\/fonts\/geist-pixel\.css"|href="assets\/fonts\/geist-pixel\.css"/, `${f} should load the local font`);
    }
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public/assets/fonts/geist-pixel-latin.woff2')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public/assets/fonts/LICENSE-OFL.txt')));
    const main = require('../vercel.json').headers[0].headers.find(x => x.key === 'Content-Security-Policy').value;
    assert.doesNotMatch(main, /fonts\.(googleapis|gstatic)\.com/);
    const p = pub('privacy.html'), t = pub('terms.html');
    for (const re of [/legal basis/i, /International transfers/, /grievance officer/i, /Google API Services User Data Policy/, /under 18/i, /within one month/i]) assert.match(p, re, String(re));
    for (const re of [/not a human/, /under 18/i, /Governing law and courts/, /Severability/]) assert.match(t, re, String(re));
    assert.match(pub('index.html'), /confirm you are 13 or older/);
});

test('no unlicensed music ships: the Free To Use tracks are gone and the player has no dangling references', () => {
    const dir = path.join(__dirname, '..', 'public/assets/audio');
    for (const f of ['apple-tree', 'bean', 'flower-cup', 'spaceship', 'sunflower']) assert.ok(!fs.existsSync(path.join(dir, f + '.mp3')), f);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), []);
    assert.doesNotMatch(pub('index.html'), /assets\/audio\/[\w-]+\.mp3|Lukrembo/);
    assert.doesNotMatch(pub('eula.html'), /Lukrembo/);
});

test('Android wrapper: the APK package, site host and Digital Asset Links file agree', () => {
    const root = path.join(__dirname, '..');
    const links = JSON.parse(fs.readFileSync(path.join(root, 'public/.well-known/assetlinks.json'), 'utf8'));
    assert.equal(links[0].target.package_name, 'com.knowura.app');
    assert.match(links[0].target.sha256_cert_fingerprints[0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    assert.match(manifest, /DEFAULT_URL"\s+android:value="https:\/\/knowura\.vercel\.app\/"/);
    assert.match(fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'), /applicationId 'com\.knowura\.app'/);
    assert.ok(fs.existsSync(path.join(root, 'android/gradlew')));
});
