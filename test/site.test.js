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
    assert.match(mainCsp, /frame-ancestors 'self' https:\/\/uday3ebsite\.vercel\.app https:\/\/udaysingh\.vercel\.app(;|$)/);
    assert.ok(!main.headers.some(x => x.key === 'X-Frame-Options'), 'main block must not send X-Frame-Options');
    assert.equal(rule.headers.find(x => x.key === 'X-Frame-Options').value, 'SAMEORIGIN');
    const netlify = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
    assert.match(netlify, /for = "\/preview"\n  \[headers\.values\]\n    Content-Security-Policy = "default-src 'none'/);
    assert.doesNotMatch(netlify, /for = "\/\*"\n  \[headers\.values\]\n(?:    [^\n]*\n)*    X-Frame-Options/);
    assert.match(netlify, /for = "\/preview"\n  \[headers\.values\]\n    Content-Security-Policy = [^\n]*\n    X-Frame-Options = "SAMEORIGIN"/);
    assert.equal((netlify.match(/frame-ancestors 'self' https:\/\/uday3ebsite\.vercel\.app https:\/\/udaysingh\.vercel\.app;/g) || []).length, (netlify.match(/default-src 'self'; script-src/g) || []).length);
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
    assert.match(app, /id="pbAttachBtn"[^\n]*#icon-plus/); assert.match(panel, /id="attachBtn"[^\n]*#icon-plus/);       // the plus button in both prompt boxes
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

test('the Android panel reloads a stale page when it opens, so deploys always show', () => {
    const java = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/java/com/knowura/app/KnowuraSession.java'), 'utf8');
    assert.match(java, /loadedAt/); assert.match(java, /boolean stale = !resuming/); assert.match(java, /pageFailed \|\| stale/);
});

test('the assistant panel shows which build it is running', () => {
    const panel = pub('assistant.html');
    assert.match(panel, /id="buildTag"/); assert.match(panel, /'build ' \+/);
});

test('files picked for the assistant panel survive the picker: copied to app storage, panel re-shown through the service, page fetches them', () => {
    const dir = path.join(__dirname, '..', 'android/app/src/main/java/com/knowura/app');
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(read('PickedFiles.java'), /copyIn\(/);
    assert.match(read('FilePickActivity.java'), /PickedFiles\.copyIn/); assert.match(read('FilePickActivity.java'), /KnowuraSession\.filesPicked/);
    assert.match(read('KnowuraInteractionService.java'), /showSession\(null, 0\)/);
    const s = read('KnowuraSession.java');
    assert.match(s, /shouldInterceptRequest/); assert.match(s, /\/__kw_file\//); assert.match(s, /static void reopen\(/); assert.match(s, /public void pickedDone\(\)/);
    assert.match(s, /if \(!pageReady\) return;/);
    const panel = pub('assistant.html');
    assert.match(panel, /window\.knowuraPicked/); assert.match(panel, /\/__kw_file\//); assert.match(panel, /bridge\.pickedDone/);
});

test('Minimize turns the assistant into a floating bubble over other apps (overlay permission, no accessibility)', () => {
    const dir = path.join(__dirname, '..', 'android/app/src/main');
    const manifest = fs.readFileSync(path.join(dir, 'AndroidManifest.xml'), 'utf8');
    assert.match(manifest, /SYSTEM_ALERT_WINDOW/); assert.match(manifest, /\.BubbleService/); assert.match(manifest, /\.OverlayPermissionActivity/);
    assert.doesNotMatch(manifest, /BIND_ACCESSIBILITY_SERVICE/);
    const bubble = fs.readFileSync(path.join(dir, 'java/com/knowura/app/BubbleService.java'), 'utf8');
    assert.match(bubble, /TYPE_APPLICATION_OVERLAY/); assert.match(bubble, /snapToEdge/); assert.match(bubble, /dismiss\(\)/);
    assert.match(bubble, /R\.drawable\.ic_launcher_foreground/); assert.doesNotMatch(bubble, /quadTo/);   // Knowura's own logo, not a generic sparkle
    const session = fs.readFileSync(path.join(dir, 'java/com/knowura/app/KnowuraSession.java'), 'utf8');
    assert.match(session, /public void minimize\(\)/); assert.match(session, /Settings\.canDrawOverlays/); assert.match(session, /BubbleService\.hide\(\)/);
    const panel = pub('assistant.html');
    assert.match(panel, /typeof bridge\.minimize === 'function'/); assert.match(panel, /bridge\.minimize\(\)/);
});

test('the AI reply reveal animation never leaves a clip on the message (the avatar sits outside the bubble)', () => {
    const panel = pub('assistant.html');
    assert.match(panel, /\.msg\.reveal \{ animation: kwMsgL \.42s var\(--spring\) both, kwReveal \.8s cubic-bezier\(\.2,\.8,\.2,1\) backwards;/);
});

test('pulling the handle up grows the sheet to the full screen, drops the keyboard, then opens the app', () => {
    const panel = pub('assistant.html');
    assert.match(panel, /async function expandAndOpen/); assert.match(panel, /ae\.blur\(\)/);
    assert.match(panel, /body\.expanding \.sheet/); assert.match(panel, /sheet\.style\.height = '100vh'/);
    assert.match(panel, /window\.__resetSheet/);   // a fresh open is back to normal size
});

test('the call buttons are equal in size and share one shadow direction; no glow halos; build tag hidden by default', () => {
    const panel = pub('assistant.html');
    assert.match(panel, /#voiceView \.call-controls \.mic-btn \{ width: 64px; height: 64px;/);
    assert.match(panel, /\.mic-btn\.end-call svg \{ transform: none; \}/); /* the pixel handset is already drawn the right way up */
    assert.doesNotMatch(panel, /kwEdge/); assert.doesNotMatch(panel, /0 0 \d+px -\d+px rgba/);
    assert.match(panel, /\.build-tag \{ display: none;/);
});

test('opening the app from the panel is quick and clean: no cloud wait after the pull-up, panel stays until the app is up', () => {
    const panel = pub('assistant.html');
    assert.match(panel, /openAppWithChat\(true\)/); assert.match(panel, /async function openAppWithChat\(fast\)/);
    const java = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/java/com/knowura/app/KnowuraSession.java'), 'utf8');
    assert.match(java, /hideAfter\(550\)/); assert.match(java, /private void hideAfter\(long ms\)/);
});

test('the helper screens (picker, camera, permission prompts) live in their own task, so closing them never pulls the main Knowura app forward behind the panel', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    for (const name of ['FilePickActivity', 'OverlayPermissionActivity', 'PermissionActivity']) {
        const block = manifest.slice(manifest.indexOf(`android:name=".${name}"`), manifest.indexOf('/>', manifest.indexOf(`android:name=".${name}"`)));
        assert.match(block, /android:taskAffinity=""/, name);
    }
});

test('the Knowura app is opened from the panel through a hop screen, so it never stays parked in the assistant stack', () => {
    const dir = path.join(__dirname, '..', 'android/app/src/main');
    assert.match(fs.readFileSync(path.join(dir, 'java/com/knowura/app/OpenAppActivity.java'), 'utf8'), /FLAG_ACTIVITY_NEW_TASK/);
    assert.match(fs.readFileSync(path.join(dir, 'AndroidManifest.xml'), 'utf8'), /\.OpenAppActivity/);
    assert.match(fs.readFileSync(path.join(dir, 'java/com/knowura/app/KnowuraSession.java'), 'utf8'), /new Intent\(getContext\(\), OpenAppActivity\.class\)/);
});

test('the Windows desktop app: tray + hotkey + low-memory switches, a locked-down window, and the page adapts to it', () => {
    const dir = path.join(__dirname, '..', 'desktop');
    const main = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.match(main, /app\.disableHardwareAcceleration\(\)/); assert.match(main, /max-old-space-size/); assert.match(main, /IDLE_DESTROY_MS/);
    assert.match(main, /globalShortcut\.register/); assert.match(main, /new Tray\(/); assert.match(main, /requestSingleInstanceLock/);
    assert.match(main, /contextIsolation: true/); assert.match(main, /nodeIntegration: false/); assert.match(main, /sandbox: true/);
    assert.match(main, /setPermissionRequestHandler/); assert.match(main, /will-navigate/);
    assert.match(main, /knowura\.vercel\.app\/assistant/);
    assert.ok(pkg.devDependencies.electron && pkg.devDependencies['electron-builder']);
    assert.ok(fs.existsSync(path.join(dir, 'package-lock.json')) && fs.existsSync(path.join(dir, 'build', 'icon.png')));
    const preload = fs.readFileSync(path.join(dir, 'preload.js'), 'utf8');
    assert.match(preload, /contextBridge\.exposeInMainWorld\('KnowuraDesk'/); assert.doesNotMatch(preload, /require\('fs'\)|child_process/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', '.github/workflows/windows-app.yml'), 'utf8'), /windows-latest/);
    const panel = pub('assistant.html');
    assert.match(panel, /window\.KnowuraDesk/); assert.match(panel, /body\.desktop/); assert.match(panel, /desk\.hide\(\)/); assert.match(panel, /desk\.openApp\(path\)/);
});

test('the Windows popup is see-through by default (no black rectangle), with a tray switch back to the low-memory opaque mode', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop/main.js'), 'utf8');
    assert.match(main, /transparent: !!prefs\.transparent/); assert.match(main, /backgroundColor: prefs\.transparent \? '#00000000'/);
    assert.match(main, /if \(!prefs\.transparent\) app\.disableHardwareAcceleration\(\)/);   // transparency needs the GPU compositor
    assert.match(main, /See-through window/); assert.match(main, /transparent=1/);
    const panel = pub('assistant.html');
    assert.match(panel, /body\.desktop\.transparent/); assert.match(panel, /classList\.add\('transparent'\)/);
});

test('desktop hotkeys: Alt+Space opens the text box, Ctrl+Space opens voice mode, and the page honours both', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop/main.js'), 'utf8');
    assert.match(main, /text: \['Alt\+Space', 'Control\+Alt\+K'\]/); assert.match(main, /voice: \['Control\+Space', 'Control\+Alt\+V'\]/);
    assert.match(main, /async function hotkey\(mode\)/); assert.match(main, /mode=\$\{mode === 'text' \? 'text' : 'voice'\}/);
    const panel = pub('assistant.html');
    assert.match(panel, /window\.knowuraMode = /); assert.match(panel, /async \(hasMic, resume, mode\)/); assert.match(panel, /startMode === 'text'/);
    assert.match(panel, /get view\(\)/);
});

test('desktop file handoff hooks reuse the composer path and stay desktop-only', () => {
    const panel = pub('assistant.html');
    for (const n of ['knowuraAttachBegin', 'knowuraAttachChunk', 'knowuraAttachEnd', 'knowuraAttach'])
        assert.match(panel, new RegExp('window\\.' + n + ' = '));
    assert.match(panel, /window\.knowuraReady = true/);
    assert.match(panel, /document\.body\.classList\.contains\('desktop'\)/);
    assert.match(panel, /attachCtl\.add\(\[file\]\)/);
    assert.match(panel, /get attachments\(\)/);
});

test('desktop browser sign-in reuses the device link', () => {
    const panel = pub('assistant.html'), idx = pub('index.html');
    assert.match(panel, /bridge\?\.installId\?\.\(\) \|\| desk\?\.installId\?\.\(\) \|\| ''/);
    assert.match(panel, /desk\.signInBrowser\(\)/); assert.match(panel, /Sign in with browser/);
    assert.match(panel, /Sign in in the app or in your browser\. Either way it shows up here\./);
    assert.match(panel, /Signed in as /); assert.match(panel, /installId, unlink: true/);
    assert.doesNotMatch(panel, /classList\.add\('native'\)[^;]*desk/);
    assert.match(idx, /syncAssistantLink\(\);   \/\/ a browser opened with \?kwdev=/);
});

test('every icon is from the Pixel set (CC BY 4.0) or drawn on its grid, and the credit ships', () => {
    const app = pub('index.html');
    const sprite = app.match(/<svg style="display:none" aria-hidden="true">[\s\S]*?<\/svg>/)[0];
    const ids = [...sprite.matchAll(/<symbol id="icon-([a-z-]+)" viewBox="0 0 32 32">/g)].map(m => m[1]);
    assert.ok(ids.length >= 38, 'sprite has the pixel icons');
    assert.equal(new Set(ids).size, ids.length, 'no duplicate symbol ids');
    assert.doesNotMatch(sprite, /viewBox="0 0 24 24"/, 'no old stroke icons left in the sprite');
    // every <use href="#icon-x"> the pages and scripts reference exists
    for (const f of ['index.html', 'assistant.html', 'assets/attach/attach.js']) {
        for (const m of pub(f).matchAll(/#icon-([a-z-]+)/g)) assert.ok(ids.includes(m[1]), `${f} uses #icon-${m[1]} which is not in the sprite`);
    }
    assert.match(pub('assistant.html'), /d="M11 3L13 3/); assert.match(app, /const PB_ARROW = \[11, 3, 13, 3/);
    assert.match(app, />Pixel icons<\/a> by Streamline, <a[^>]*>CC BY 4\.0</);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts/pixel-icons/build.js')));
});

test('search engines can find Knowura: robots, sitemap, description, canonical and structured data', () => {
    const root = path.join(__dirname, '..', 'public');
    const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
    assert.match(robots, /Allow: \//); assert.match(robots, /Sitemap: https:\/\/knowura\.vercel\.app\/sitemap\.xml/);
    assert.match(robots, /Disallow: \/assistant/); assert.doesNotMatch(robots, /Disallow: \/\s*$/m);
    const sm = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
    for (const u of ['/', '/terms', '/privacy', '/eula', '/dmca']) assert.ok(sm.includes(`<loc>https://knowura.vercel.app${u}</loc>`), u);
    const h = pub('index.html');
    assert.match(h, /<meta name="description" content="Knowura is a free AI study helper/);
    assert.match(h, /<link rel="canonical" href="https:\/\/knowura\.vercel\.app\/">/);
    assert.doesNotMatch(h, /<meta name="robots" content="[^"]*noindex/);
    const ld = JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.ok(ld['@graph'].some(n => n['@type'] === 'WebSite' && n.name === 'Knowura'));
    for (const f of ['terms', 'privacy', 'eula', 'dmca']) assert.match(pub(f + '.html'), /rel="canonical"/);
    for (const f of ['assistant.html', '404.html', 'preview.html']) assert.match(pub(f), /noindex/);
    const llms = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8');
    assert.match(llms, /^# Knowura AI\n\n> /); assert.match(llms, /https:\/\/knowura\.vercel\.app\/terms/);
    assert.ok(!fs.existsSync(path.join(root, 'llm.txt')), 'only llms.txt ships');
});

test('the home page carries the Google Search Console verification tag', () => {
    assert.match(pub('index.html'), /<meta name="google-site-verification" content="9vt2JE-QknnLcxWJikBuNVfQzwLf875Vr40s72cNTpE"/);
});

test('the Android dismiss target draws a pixel X (no smooth lines left)', () => {
    const j = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/java/com/knowura/app/BubbleService.java'), 'utf8');
    assert.match(j, /21x21 pixel grid/); assert.match(j, /drawRect\(ox \+ k\[0\] \* cell/);
    assert.doesNotMatch(j, /c\.drawLine\(cx - d/);
});

test('boot counter: once per session, main page only, waits for the app, never traps the user', () => {
    const h = pub('index.html');
    assert.equal((h.match(/id="boot"/g) || []).length, 1);
    assert.ok(h.indexOf('<body>\n<div id="boot" class="boot" aria-hidden="true">') > 0, '#boot is the first child of <body>');
    for (const t of ['waking the tutor', 'warming up the models', 'loading your notes', 'ready to learn']) assert.ok(h.includes(`<li>${t}</li>`), t);
    // the gate runs first in <head>: session flag, reduced motion, main page only, 8 s failsafe
    const head = h.slice(h.indexOf('<head>'), h.indexOf('</head>'));
    assert.ok(head.indexOf('is-booting') < head.indexOf('<style'), 'gate script comes before any styles');
    assert.match(head, /sessionStorage\.getItem\('knowura-booted'\)/); assert.match(head, /prefers-reduced-motion: reduce/);
    assert.match(head, /\^\\\/\(index\\\.html\)\?\$/); assert.match(head, /setTimeout\(function \(\) \{[\s\S]*?\}, 8000\)/);
    // waits for load + fonts + the app, at least 1300 ms, hard cap 7000 ms
    assert.match(h, /var MIN = 1300, CAP = 7000/); assert.match(h, /ready\.load && ready\.fonts && ready\.app && t >= MIN/);
    assert.match(h, /document\.dispatchEvent\(new Event\('knowura:ready'\)\)/); assert.match(h, /window\.kwBootDone\?\.\(\);/);
    assert.match(h, /clip-path: inset\(0 0 100% 0\)/); assert.match(h, /setAttribute\('inert', ''\)/);
    // uses the app's colour tokens and the self-hosted pixel font; no old spinner loader left
    assert.match(h, /\.boot-num \{ font-size: min\(38vw, 48vh\); line-height: \.82; letter-spacing: -\.04em;/);
    assert.match(h, /var\(--cyan, #22e5ff\)/); assert.match(h, /var\(--ink, #000\)/);
    assert.doesNotMatch(h, /kw-boot|kwb-/);
    assert.equal(fs.readFileSync(path.join(__dirname, '..', 'public/sw.js'), 'utf8').includes('boot'), false, 'service worker untouched (nothing is cached)');
});

test('study mode, reply tools, follow-ups, streaks, weak spots and accessibility are wired', () => {
    const h = pub('index.html'), st = fs.readFileSync(path.join(__dirname, '..', 'functions/_study.js'), 'utf8'), ai = fs.readFileSync(path.join(__dirname, '..', 'functions/ask-ai.js'), 'utf8');
    // the AI reply badge is the Knowura logo, not a letter
    assert.match(h, /\.ai::before \{[^}]*url\(\/assets\/brand\/k-mark\.svg\)/); assert.doesNotMatch(h, /content: 'K'/);
    assert.match(pub('assets/ui/app-ui.css'), /k-mark\.svg/, 'the assistant panel gets the same badge');
    // study mode: the voice-mode orb is the avatar, the server gets the flag and only trusts a real boolean
    assert.match(h, /id="studyStrip"[^>]*>[^]*?bloub-cercle-neutre-bleu\.gif/); assert.match(h, /studyMode: !!settings\.studyMode/);
    assert.match(st, /STUDY_MODE_PROMPT/); assert.match(ai, /body\.studyMode === true \? STUDY_MODE_PROMPT/);
    // reply tools and follow-ups
    for (const f of ['regenerateLast', 'addReplyTools', 'loadFollowups', 'clearReplyTools']) assert.match(h, new RegExp('function ' + f));
    assert.match(h, /addReplyTools\(thinking, text, reply, atts\.length > 0\)/);
    // streaks + spaced weak spots + photo to quiz
    for (const f of ['markStudyDay', 'weakAdd', 'weakRate', 'startWeakReview', 'refreshStudyHome', 'quizFromPhoto']) assert.match(h, new RegExp('function ' + f));
    assert.match(h, /const WEAK_DAYS = \[1, 3, 7, 14\]/); assert.match(h, /weakAdd\(q\);/); assert.match(h, /label: 'Quiz from a photo'/);
    // accessibility
    assert.match(h, /data-group="textScale"/); assert.match(h, /data-group="contrast"/); assert.match(h, /function showShortcuts/); assert.match(h, /e\.altKey && !e\.ctrlKey/);
    for (const id of ['refresh', 'thumb-up', 'thumb-down', 'study']) assert.match(h, new RegExp('<symbol id="icon-' + id + '"'));
});

test('the assistant panel has the same study features, and the shared quiz code never calls helpers the panel lacks', () => {
    const a = pub('assistant.html'), ui = pub('assets/ui/app-ui.js');
    // quiz/flashcard code is shared with the panel, so everything it calls must ship in the same file
    for (const f of ['weakAdd', 'weakRate', 'markStudyDay', 'refreshStudyHome', 'startWeakReview']) assert.match(ui, new RegExp('function ' + f), f + ' ships with the shared UI');
    assert.doesNotMatch(ui, /const store =/, 'no clash with the panel\'s own store()');
    assert.match(a, /id="studyBtn"/); assert.match(a, /id="studyStrip"[^>]*>[^]*?bloub-cercle-neutre-bleu\.gif/); assert.match(a, /studyMode: studyOn/);
    for (const f of ['regenerate', 'loadFollowups', 'rate', 'applyA11y', 'toggleStudy']) assert.match(a, new RegExp('function ' + f));
    assert.match(a, /id="aaBtn"/); assert.match(a, /id="hcBtn"/); assert.match(a, /Quiz from a photo/); assert.match(a, /id="studyHome"/);
});

test('retro pack: Konami green terminal, CRT scanlines, 8-bit sounds, pixel burst and press-into-shadow buttons', () => {
    const h = pub('index.html'), a = pub('assistant.html'), ui = pub('assets/ui/app-ui.js'), css = pub('assets/ui/app-ui.css');
    // the code lives in the shared files, so the assistant panel gets it too
    for (const f of ['kwRetroSet', 'kwSfx', 'kwPixelBurst', 'kwTerminal']) assert.match(ui, new RegExp('function ' + f));
    assert.match(ui, /'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'/);
    assert.match(ui, /square/); assert.doesNotMatch(ui, /new Audio\(|\.mp3|\.wav/, 'sounds are synthesised, no files');
    assert.match(css, /html\.term \{ --dark: #000/); assert.match(css, /html\.term \{ filter: grayscale\(1\) sepia\(1\)/);
    assert.match(css, /knowura@alpha:~\$ \.\/learn --wip/); assert.match(css, /html\.crt::after/); assert.match(css, /html\.lite\.crt:not\(\.term\)::after/);
    assert.match(css, /\.btn-ui:not\(:disabled\):active/); assert.match(css, /prefers-reduced-motion: reduce\) \{ \.pxburst/);
    // saved state is applied before first paint on both pages
    for (const html of [h, a]) assert.match(html, /knowura_term'\) === '1'\) r\.classList\.add\('term'\)/);
    // sounds ride on haptic(), and are off until the user turns them on
    assert.match(h, /if \(typeof kwSfx === 'function'\) kwSfx\(kind\)/); assert.match(a, /kwSfx\(kind === 'tick' \? 'tap' : kind\)/);
    assert.match(ui, /crt: 'off', sfx: 'off'/); assert.match(h, /data-group="crt"/); assert.match(h, /data-group="sfx"/);
});
