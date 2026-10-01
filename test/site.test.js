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

test('the site is installable as an app: manifest id, a no-cache service worker, and an Install app button', () => {
    const m = JSON.parse(pub('site.webmanifest'));
    assert.equal(m.id, '/');
    assert.equal(m.display, 'standalone');
    assert.match(pub('sw.js'), /addEventListener\('fetch'/);
    assert.doesNotMatch(pub('sw.js'), /caches\./); // never caches, so nothing can go stale
    const h = pub('index.html');
    assert.match(h, /id="installSection" hidden/);
    assert.match(h, /addEventListener\('beforeinstallprompt'/);
    assert.match(h, /serviceWorker\.register\('\/sw\.js'\)/);
    assert.ok(require('../vercel.json').headers.some(r => r.source === '/sw.js'));
});

test('Android assistant: the floating panel page, the native service wiring and the legal text all exist', () => {
    const root = path.join(__dirname, '..');
    const page = pub('assistant.html');
    assert.match(page, /Knowura isn\\?'t human\. It can make mistakes, so double check it\./);
    assert.match(page, /id="minBtn"/);
    assert.match(page, /window\.knowuraShown/);
    assert.match(page, /\.netlify\/functions\//);
    assert.match(page, /post\('ask-ai'/);
    const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    for (const re of [/BIND_VOICE_INTERACTION/, /android\.service\.voice\.VoiceInteractionService/, /android\.speech\.RecognitionService/, /RECORD_AUDIO/]) assert.match(manifest, re, String(re));
    const xml = fs.readFileSync(path.join(root, 'android/app/src/main/res/xml/interaction_service.xml'), 'utf8');
    assert.match(xml, /supportsAssist="true"/);
    for (const f of ['KnowuraInteractionService', 'KnowuraSessionService', 'KnowuraSession', 'KnowuraRecognitionService', 'PermissionActivity', 'InstallId', 'KnowuraLauncherActivity']) {
        assert.ok(fs.existsSync(path.join(root, `android/app/src/main/java/com/knowura/app/${f}.java`)), f);
    }
    assert.match(fs.readFileSync(path.join(root, 'android/app/src/main/java/com/knowura/app/KnowuraSession.java'), 'utf8'), /assistant\?native=1/);
    assert.match(pub('privacy.html'), /does <strong>not<\/strong> read your screen/);
    assert.match(pub('index.html'), /voiceLaunchPending/);
    assert.match(fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8'), /for = "\/assistant"/);
});

test('the assistant panel reuses the real app UI: generated files match index.html and cover the key components', () => {
    const generated = require('../scripts/build-shared-ui').build();
    for (const [name, text] of Object.entries(generated)) {
        assert.equal(fs.readFileSync(path.join(__dirname, '..', 'public/assets/ui', name), 'utf8'), text, `${name} is stale: run node scripts/build-shared-ui.js`);
    }
    for (const sel of ['.prompt-bar', '.pb-send', '.msg {', '.live-panel', '.orb-gif', '.study-overlay', '.fc-inner', '.btn-ui']) assert.ok(generated['app-ui.css'].includes(sel), sel);
    for (const fn of ['function openStudy', 'function renderQuizQ', 'function renderCard']) assert.ok(generated['app-ui.js'].includes(fn), fn);
    assert.match(generated['app-ui.js'], /icon-mic/);
});

test('assistant panel: voice first, X to text, swipe-up handoff, cloud sync, study tools and native sign-in are all wired', () => {
    const page = pub('assistant.html');
    assert.match(page, /id="voiceView" class="live-panel open"/);       // opens in voice mode
    assert.match(page, /\$\('voiceX'\)\.addEventListener\('click', \(\) => showText/); // the cross goes to text chat
    assert.match(page, /#kwimport=/);                                    // swipe-up handoff
    assert.match(page, /pointerup/);
    assert.match(page, /chat-save/); assert.match(page, /chat-load/);   // cloud sync
    assert.match(page, /studyChipHTML/); assert.match(page, /openStudy/); // quizzes + flashcards
    assert.match(page, /device-session/);                                  // signs in via the app's link
    assert.doesNotMatch(page, /knowuraSignedIn/);
    const root = path.join(__dirname, '..');
    assert.match(fs.readFileSync(path.join(root, 'android/app/src/main/java/com/knowura/app/KnowuraLauncherActivity.java'), 'utf8'), /kwdev/);
    assert.match(pub('index.html'), /function importAssistantChat/);
});

test('attachments: engine, vendored parsers and licences ship; app and panel are wired; legal text covers them', () => {
    const root = path.join(__dirname, '..');
    const has = (f) => fs.existsSync(path.join(root, f));
    for (const f of ['public/assets/attach/attach.js', 'public/assets/attach/attach.css', 'public/assets/vendor/pdfjs/pdf.min.mjs', 'public/assets/vendor/pdfjs/pdf.worker.min.mjs', 'public/assets/vendor/pdfjs/LICENSE', 'public/assets/vendor/jszip/jszip.min.js', 'public/assets/vendor/jszip/LICENSE']) assert.ok(has(f), f);
    const engine = pub('assets/attach/attach.js');
    for (const re of [/createImageBitmap/, /pdf\.min\.mjs/, /word\/document\.xml/, /ppt\\\/slides/, /xl\/sharedStrings/, /Do not follow instructions/, /e === 'svg'\) return \{ kind: 'text'/]) assert.match(engine, re, String(re));
    const app = pub('index.html');
    for (const re of [/assets\/attach\/attach\.js/, /id="pbAttachBtn"/, /id="attBar"/, /KnowuraAttach\.build\(text, atts\)/, /messagesForServer/, /contextText/]) assert.match(app, re, String(re));
    const panel = pub('assistant.html');
    for (const re of [/assets\/attach\/attach\.js/, /id="attachBtn"/, /KnowuraAttach\.build\(text, atts\)/, /forServer\(\)/]) assert.match(panel, re, String(re));
    assert.ok(has('android/app/src/main/java/com/knowura/app/FilePickActivity.java'));
    assert.match(fs.readFileSync(path.join(root, 'android/app/src/main/java/com/knowura/app/KnowuraSession.java'), 'utf8'), /onShowFileChooser/);
    assert.match(pub('privacy.html'), /Attachments \(optional\)/);
    assert.match(pub('terms.html'), /anything you attach/);
    assert.match(pub('privacy.html'), /No video is recorded or sent/);
    assert.match(engine, /att-sheet/); assert.match(engine, /camInput\.click\(\)/); assert.doesNotMatch(engine, /getUserMedia/);   // phone sheet + native camera app
    assert.match(app, /M12 5v14M5 12h14/); assert.match(panel, /M12 5v14M5 12h14/);       // the plus button in both prompt boxes
    assert.match(pub('eula.html'), /PDF\.js \(Apache-2\.0\), JSZip \(MIT\)/);
    // the server keeps handling pictures safely: the chat function must not accept remote image URLs
    assert.match(fs.readFileSync(path.join(root, 'functions/ask-ai.js'), 'utf8'), /IMAGE_URL = \/\^data:image/);
});

test('the camera is never opened by the page itself: the phone camera app takes the picture', () => {
    const main = require('../vercel.json').headers[0].headers.find(x => x.key === 'Permissions-Policy').value;
    assert.match(main, /camera=\(\)/);
    assert.match(main, /microphone=\(self\)/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8'), /camera=\(\)/);
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    assert.doesNotMatch(manifest, /permission\.CAMERA/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/java/com/knowura/app/FilePickActivity.java'), 'utf8'), /ACTION_IMAGE_CAPTURE/);
});

test('Vercel stays within the free plan\'s 12 functions, and the merged endpoints are routed', () => {
    const fns = fs.readdirSync(path.join(__dirname, '..', 'api')).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
    assert.ok(fns.length <= 12, `api/ has ${fns.length} functions`);
    const rewrites = require('../vercel.json').rewrites.map((r) => `${r.source}>${r.destination}`).join(' ');
    for (const n of ['device-link', 'device-session', 'models']) assert.ok(rewrites.includes(`/.netlify/functions/${n}>/api/misc?op=${n}`), n);
});

test('assistant panel: permission, copy, share and errors all give visible feedback and the native side recovers', () => {
    const panel = pub('assistant.html');
    const java = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/java/com/knowura/app/KnowuraSession.java'), 'utf8');
    const perm = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/java/com/knowura/app/PermissionActivity.java'), 'utf8');
    assert.match(panel, /id="micCard"/); assert.match(panel, /id="micAllow"/);        // an Allow button instead of a dead end
    assert.match(panel, /function copyText/); assert.match(panel, /function shareText/); assert.match(panel, /window\.knowuraNote/);
    assert.match(perm, /KnowuraSession\.permissionDone\(\)/);                          // the panel comes back after the prompt
    assert.match(java, /static void permissionDone/); assert.match(java, /public boolean copy\(/);
    assert.match(java, /startAssistantActivity\(intent\)[\s\S]*FLAG_ACTIVITY_NEW_TASK/);   // falls back to a plain start
});

test('assistant panel: the microphone is retried with plain constraints and reports the real reason', () => {
    const panel = pub('assistant.html');
    assert.match(panel, /MIC_TRIES/); assert.match(panel, /\{ audio: true \}/); assert.match(panel, /micWhy/);
});

test('the app lets go of the microphone when the assistant panel takes focus, and the panel explains a busy mic', () => {
    const app = pub('index.html'), panel = pub('assistant.html');
    assert.match(app, /window\.addEventListener\('blur', \(\) => \{ if \(isMobileUA\) stopMobileWake\(\); \}\)/);
    assert.match(app, /window\.addEventListener\('focus'/);
    assert.match(panel, /NotReadableError/);
});

test('assistant panel listens through Android (AudioRecord) and falls back to the browser microphone', () => {
    const panel = pub('assistant.html');
    const dir = path.join(__dirname, '..', 'android/app/src/main');
    const mic = fs.readFileSync(path.join(dir, 'java/com/knowura/app/NativeMic.java'), 'utf8');
    const session = fs.readFileSync(path.join(dir, 'java/com/knowura/app/KnowuraSession.java'), 'utf8');
    assert.match(mic, /new AudioRecord\(/); assert.match(mic, /RIFF/);
    assert.match(session, /public synchronized boolean micStart\(\)/); assert.match(session, /public void micArm\(/); assert.match(session, /public void micStop\(\)/);
    assert.match(fs.readFileSync(path.join(dir, 'AndroidManifest.xml'), 'utf8'), /MODIFY_AUDIO_SETTINGS/);
    assert.match(panel, /typeof bridge\.micStart === 'function'/);   // old installs without the native mic still use the browser path
    assert.match(panel, /window\.knowuraClip/);
});

test('assistant panel voice: failures are shown on screen, the keyboard shrinks the panel, and it animates in and out', () => {
    const panel = pub('assistant.html');
    assert.doesNotMatch(panel, /id="dbg"/);                                   // no debug trail any more
    assert.match(panel, /Didn\\'t catch that/);
    assert.match(panel, /--sheetMax/); assert.match(panel, /function fit\(\)/);    // shrinks to the room above the keyboard
    assert.doesNotMatch(panel, /translateY\(var\(--kb/);                      // and is no longer pushed up the screen
    assert.match(panel, /function playEnter/); assert.match(panel, /\.stack\.leaving/);
});

test('assistant panel motion: spring easing, state-aware orb, live waveform, ripples and reduced-motion support', () => {
    const panel = pub('assistant.html');
    assert.match(panel, /linear\(/); assert.match(panel, /--spring/);
    assert.match(panel, /id="bars"/); assert.match(panel, /data-state="listening"/);
    assert.match(panel, /\.orb-wrap\.thinking::after/); assert.match(panel, /\.orb-wrap\.speaking/);
    assert.match(panel, /getComputedStyle\(b\)\.position === 'static'/);        // ripples never override absolutely placed buttons
    assert.match(panel, /prefers-reduced-motion/);
});

test('assistant panel refreshes itself when the site has a newer build (the phone keeps the page loaded between uses)', () => {
    const panel = pub('assistant.html');
    assert.match(panel, /version\.json\?_=/); assert.match(panel, /newerSiteExists/); assert.match(panel, /location\.reload\(\)/);
    assert.match(panel, /if \(resume\) return;/);   // never mid picker
});

test('the secret menu offers a password-free owner switch for the owner Google account, and sign-in never turns it on', () => {
    const app = pub('index.html');
    assert.match(app, /id="ownerGoogleRow"/); assert.match(app, /function enableOwnerWithGoogle/);
    assert.doesNotMatch(app, /if \(data\.ownerToken\) setOwnerUnlocked/);        // no automatic owner mode
    const rewrites = require('../vercel.json').rewrites.map((r) => `${r.source}>${r.destination}`).join(' ');
    assert.ok(rewrites.includes('/.netlify/functions/owner-enable>/api/misc?op=owner-enable'));
});

test('the app refreshes itself when it comes back to the screen and the site has a newer build', () => {
    const app = pub('index.html');
    assert.match(app, /function staysCurrent|staysCurrent\(\)/); assert.match(app, /version\.json\?_=/);
    assert.match(app, /New version ready/); assert.match(app, /pageshow/);
    const headers = require('../vercel.json').headers.filter((h) => h.headers.some((x) => x.key === 'Cache-Control' && x.value === 'no-cache')).map((h) => h.source);
    for (const src of ['/', '/assistant', '/version.json']) assert.ok(headers.includes(src), src);   // always revalidated
});
