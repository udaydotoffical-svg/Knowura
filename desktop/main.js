// Knowura for Windows: a small tray app. A global hotkey pops the assistant up over whatever you are doing;
// the page itself is https://knowura.vercel.app/assistant, so it updates the moment the website does.
//
// Built to stay light: no GPU process, one tiny renderer, a capped JS heap, and when the panel has been hidden for a
// couple of minutes its window is destroyed completely (only the tray stays, a few tens of MB) and rebuilt on demand.

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, session, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const HOST = 'knowura.vercel.app';
const assistantUrl = (mode) => `https://${HOST}/assistant?desktop=1&mode=${mode === 'text' ? 'text' : 'voice'}${prefs.transparent ? '&transparent=1' : ''}`;
const IDLE_DESTROY_MS = 2 * 60 * 1000;
const PARTITION = 'persist:knowura';
// the first combo of each pair that Windows lets us have: text box, and voice
const HOTKEYS = { text: ['Alt+Space', 'Control+Alt+K'], voice: ['Control+Space', 'Control+Alt+V'] };

let tray = null, panel = null, full = null, idleTimer = null, quitting = false;
const active = { text: null, voice: null };
let prefs = { autoStart: false, hideOnBlur: false, transparent: true };
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');

function loadPrefs() {
    try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch (e) { /* first run */ }
}
function savePrefs() {
    try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch (e) { /* not fatal */ }
}
loadPrefs();

// ── memory: cap the heap, drop features a single-site app never uses, and (opaque mode) skip the GPU process.
// A see-through window needs Windows' GPU compositing, so transparent mode keeps the GPU process, but only while the
// popup exists: after two minutes hidden the window is destroyed and the GPU process goes with it.
if (!prefs.transparent) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=160');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MediaRouter,Translate,AutofillServerCommunication,OptimizationHints,SpareRendererForSitePerProcess');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('no-pings');

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showPanel('text'));
}

// ── what the website is allowed to do: its own microphone, nothing else ──
function hostOf(url) { try { return new URL(url).host; } catch (e) { return ''; } }
function setupSession(ses) {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
        const mine = hostOf(details && details.requestingUrl ? details.requestingUrl : wc.getURL()) === HOST;
        const audioOnly = permission === 'media' && !(details && details.mediaTypes && details.mediaTypes.includes('video'));
        callback(mine && (audioOnly || permission === 'clipboard-sanitized-write'));
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => hostOf(origin) === HOST && (permission === 'media' || permission === 'clipboard-sanitized-write'));
}

function lockNavigation(win) {
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (hostOf(url) !== HOST) {
            e.preventDefault();
            if (/^https:\/\//i.test(url)) shell.openExternal(url);
        }
    });
}

function webPrefs() {
    return {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        devTools: !app.isPackaged,
        backgroundThrottling: true,
        partition: PARTITION
    };
}

const iconPath = () => path.join(__dirname, 'assets', 'tray.png');

// ── the popup panel ──
function placePanel() {
    if (!panel) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    const [w, h] = panel.getSize();
    panel.setPosition(Math.round(wa.x + wa.width - w - 16), Math.round(wa.y + wa.height - h - 16));
}

function createPanel(mode) {
    const wa = screen.getPrimaryDisplay().workArea;
    const w = 440, h = Math.min(720, wa.height - 32);
    panel = new BrowserWindow({
        width: w, height: h, minWidth: 360, minHeight: 420,
        show: false, frame: false, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
        // transparent: only the panel card shows, floating on your desktop (such windows can't be resized by dragging)
        transparent: !!prefs.transparent, hasShadow: !prefs.transparent, resizable: !prefs.transparent,
        backgroundColor: prefs.transparent ? '#00000000' : '#05070f', title: 'Knowura', icon: nativeImage.createFromPath(iconPath()),
        webPreferences: webPrefs()
    });
    panel.setMenuBarVisibility(false);
    panel.webContents.setUserAgent(panel.webContents.getUserAgent() + ' KnowuraDesktop/' + app.getVersion());
    lockNavigation(panel);
    panel.on('blur', () => { if (prefs.hideOnBlur && panel && panel.isVisible() && !panel.webContents.isDevToolsOpened()) hidePanel(); });
    panel.on('closed', () => { panel = null; });
    panel.webContents.on('render-process-gone', () => { if (panel) { panel.destroy(); panel = null; } });
    panel.loadURL(assistantUrl(mode));
}

function showPanel(mode) {
    mode = mode === 'voice' ? 'voice' : 'text';
    clearTimeout(idleTimer);
    const fresh = !panel;
    if (fresh) createPanel(mode);
    placePanel();
    panel.show();
    panel.focus();
    panel.webContents.focus();
    // a window that was only hidden tells the page it is back and in which mode; a brand new one starts in that mode itself
    if (!fresh) panel.webContents.executeJavaScript(`window.knowuraShown&&window.knowuraShown(true,false,${JSON.stringify(mode)})`).catch(() => {});
}

function hidePanel() {
    if (!panel) return;
    // the page stops the microphone before the window goes away
    panel.webContents.executeJavaScript('window.knowuraHidden&&window.knowuraHidden()').catch(() => {});
    panel.hide();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (panel && !panel.isVisible()) { panel.destroy(); panel = null; }   // frees the renderer's memory completely
    }, IDLE_DESTROY_MS);
}

// one hotkey per mode: hidden -> open in that mode; open in the other mode -> switch to this one; open in this mode -> hide
async function hotkey(mode) {
    if (panel && panel.isVisible()) {
        let view = '';
        try { view = await panel.webContents.executeJavaScript('window.__kw && window.__kw.view'); } catch (e) { /* page still loading */ }
        if (view === mode && panel.isFocused()) { hidePanel(); return; }
        panel.focus();
        panel.webContents.focus();
        if (view !== mode) panel.webContents.executeJavaScript(`window.knowuraMode&&window.knowuraMode(${JSON.stringify(mode)})`).catch(() => {});
        return;
    }
    showPanel(mode);
}
const togglePanel = () => hotkey('text');   // tray click: the text box (never switches the microphone on by itself)

// ── the full Knowura app in its own window (used by the pull-up in the panel) ──
function openFull(urlPath) {
    const safe = typeof urlPath === 'string' && urlPath.startsWith('/') && !urlPath.startsWith('//') && urlPath.length <= 200000 ? urlPath : '/';
    const url = `https://${HOST}${safe}`;
    if (full && !full.isDestroyed()) {
        full.loadURL(url);
        full.show();
        full.focus();
    } else {
        full = new BrowserWindow({
            width: 1100, height: 780, minWidth: 420, minHeight: 500, autoHideMenuBar: true, backgroundColor: '#05070f',
            title: 'Knowura', icon: nativeImage.createFromPath(iconPath()), webPreferences: { ...webPrefs(), preload: undefined }
        });
        full.setMenuBarVisibility(false);
        lockNavigation(full);
        full.on('closed', () => { full = null; });
        full.loadURL(url);
    }
    hidePanel();
}

ipcMain.on('kw:hide', (e) => { if (panel && e.sender === panel.webContents) hidePanel(); });
ipcMain.on('kw:openApp', (e, p) => { if (panel && e.sender === panel.webContents) openFull(p); });

// ── tray + hotkey ──
function registerShortcuts() {
    globalShortcut.unregisterAll();
    for (const mode of ['text', 'voice']) {
        active[mode] = null;
        for (const combo of HOTKEYS[mode]) {
            try { if (globalShortcut.register(combo, () => hotkey(mode))) { active[mode] = combo; break; } } catch (e) { /* try the next one */ }
        }
    }
}
const pretty = (c) => (c || '').replace('Control', 'Ctrl');

function buildTray() {
    const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    const refresh = () => {
        tray.setToolTip('Knowura' + (active.text || active.voice ? ` (${pretty(active.text) || '-'} text, ${pretty(active.voice) || '-'} voice)` : ''));
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Open the text box', click: () => showPanel('text') },
            { label: 'Start voice mode', click: () => showPanel('voice') },
            { label: 'Open the full Knowura app', click: () => openFull('/') },
            { type: 'separator' },
            { label: 'Start with Windows', type: 'checkbox', checked: !!prefs.autoStart, click: (m) => { prefs.autoStart = m.checked; savePrefs(); applyAutoStart(); } },
            { label: 'Hide when I click away', type: 'checkbox', checked: !!prefs.hideOnBlur, click: (m) => { prefs.hideOnBlur = m.checked; savePrefs(); } },
            { label: 'See-through window (uses more memory while open)', type: 'checkbox', checked: !!prefs.transparent, click: (m) => { prefs.transparent = m.checked; savePrefs(); quitting = true; app.relaunch(); app.exit(0); } },
            { type: 'separator' },
            { label: active.text ? `Text box: ${pretty(active.text)}` : 'Text hotkey unavailable (another app uses it)', enabled: false },
            { label: active.voice ? `Voice: ${pretty(active.voice)}` : 'Voice hotkey unavailable (another app uses it)', enabled: false },
            { label: 'Quit Knowura', click: () => { quitting = true; app.quit(); } }
        ]));
    };
    refresh();
    tray.on('click', togglePanel);
}

function applyAutoStart() {
    try { app.setLoginItemSettings({ openAtLogin: !!prefs.autoStart, args: ['--hidden'] }); } catch (e) { /* portable builds can't register */ }
}

app.whenReady().then(() => {
    setupSession(session.fromPartition(PARTITION));
    setupSession(session.defaultSession);
    registerShortcuts();
    buildTray();
    applyAutoStart();
    if (!process.argv.includes('--hidden')) showPanel('text');
});

// a tray app: closing every window must not quit it
app.on('window-all-closed', () => { /* stays in the tray */ });
app.on('before-quit', () => { quitting = true; globalShortcut.unregisterAll(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
