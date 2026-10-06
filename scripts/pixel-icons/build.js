// Rebuilds the app's icon sprite from the "Pixel - Free" icon set by Streamline (CC BY 4.0, https://www.streamlinehq.com/icons/pixel).
// - src/*.svg  : icons downloaded from the set (merged into a single filled path each, recoloured with currentColor)
// - drawn below: the few the set doesn't have (plus, close, check, play/pause/skip, arrows, ...), drawn on the same 21x21 pixel grid
// Usage: node scripts/pixel-icons/build.js      (rewrites the sprite in public/index.html; then run `npm run build`)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const htmlPath = path.join(root, 'public', 'index.html');

// sprite id -> file in src/
const FROM_SET = {
    bolt: 'bolt', tag: 'tag', lock: 'lock', music: 'music', volume: 'volume', trash: 'trash', menu: 'menu3', settings: 'settings',
    logout: 'logout', mic: 'mic', 'mic-off': 'micoff', phone: 'phone', alert: 'alert', download: 'download', eye: 'eye', info: 'info',
    edit: 'edit', chat: 'chat', cpu: 'cpu', clip: 'clip', camera: 'camera', image: 'image', folder: 'folder', share: 'share'
};

// ---- icons the set lacks: drawn on a 21x21 grid (one cell = 32/21 units, the same pixel size as the set) ----
const N = 21, CELL = 32 / N;
function grid() {
    const g = Array.from({ length: N }, () => Array(N).fill(false));
    const api = {
        set: (x, y, v = true) => { if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = v; return api; },
        rect: (x0, y0, x1, y1, v = true) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) api.set(x, y, v); return api; },
        frame: (x0, y0, x1, y1, t = 2) => { api.rect(x0, y0, x1, y1); api.rect(x0 + t, y0 + t, x1 - t, y1 - t, false); return api; },
        g
    };
    return api;
}
function toPath(g) { // merge horizontal runs into rects: "M x y h w v 1 h -w z"
    const f = (n) => +(n * CELL).toFixed(2);
    let d = '';
    for (let y = 0; y < N; y++) {
        let x = 0;
        while (x < N) {
            if (!g[y][x]) { x++; continue; }
            let x1 = x;
            while (x1 + 1 < N && g[y][x1 + 1]) x1++;
            d += `M${f(x)} ${f(y)}h${f(x1 - x + 1)}v${f(1)}h${f(-(x1 - x + 1))}z`;
            x = x1 + 1;
        }
    }
    return d;
}
const DRAWN = {
    x: (o) => { for (let i = 0; i <= 14; i++) { o.set(3 + i, 3 + i).set(4 + i, 3 + i).set(18 - i, 3 + i).set(17 - i, 3 + i); } },
    plus: (o) => { o.rect(9, 3, 11, 17).rect(3, 9, 17, 11); },
    check: (o) => { for (let i = 0; i <= 4; i++) o.set(3 + i, 9 + i).set(4 + i, 9 + i); for (let i = 0; i <= 9; i++) o.set(8 + i, 13 - i).set(9 + i, 13 - i); },
    'chevron-down': (o) => { for (let i = 0; i <= 7; i++) o.set(3 + i, 6 + i).set(4 + i, 6 + i).set(17 - i, 6 + i).set(16 - i, 6 + i); },
    'arrow-right': (o) => { o.rect(3, 9, 12, 11); for (let x = 11; x <= 18; x++) { const h = 18 - x; o.rect(x, 10 - h, x, 10 + h); } },
    play: (o) => { for (let x = 5; x <= 17; x++) { const h = Math.round((17 - x) * 7 / 12); o.rect(x, 10 - h, x, 10 + h); } },
    pause: (o) => { o.rect(5, 3, 8, 17).rect(12, 3, 15, 17); },
    'skip-back': (o) => { o.rect(4, 3, 5, 17); for (let x = 7; x <= 17; x++) { const h = Math.round((x - 7) * 7 / 10); o.rect(x, 10 - h, x, 10 + h); } },
    'skip-forward': (o) => { o.rect(15, 3, 16, 17); for (let x = 3; x <= 13; x++) { const h = Math.round((13 - x) * 7 / 10); o.rect(x, 10 - h, x, 10 + h); } },
    search: (o) => {
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const d = Math.hypot(x + 0.5 - 8.5, y + 0.5 - 8.5); if (d >= 5.3 && d <= 7.5) o.set(x, y); }
        for (let i = 13; i <= 17; i++) o.set(i, i).set(i + 1, i).set(i, i + 1);
    },
    copy: (o) => { o.frame(2, 2, 12, 12); o.rect(7, 7, 18, 18, false); o.frame(8, 8, 18, 18); },
    code: (o) => { for (let i = 0; i <= 5; i++) { o.set(8 - i, 4 + i).set(7 - i, 4 + i).set(8 - i, 16 - i).set(7 - i, 16 - i); o.set(12 + i, 4 + i).set(13 + i, 4 + i).set(12 + i, 16 - i).set(13 + i, 16 - i); } o.set(2, 10).set(3, 10).set(17, 10).set(18, 10); },
    unlock: (o) => { o.frame(4, 10, 16, 18); o.rect(10, 13, 10, 15); o.rect(8, 2, 12, 2).rect(6, 3, 7, 9).rect(13, 3, 14, 5); },
    incognito: (o) => { o.rect(5, 3, 15, 7).rect(1, 8, 19, 9).rect(3, 12, 9, 16).rect(11, 12, 17, 16).rect(9, 13, 11, 13); },
    refresh: (o) => {
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const dx = x + 0.5 - 10.5, dy = y + 0.5 - 11, d = Math.hypot(dx, dy); if (d >= 5.4 && d <= 7.6 && !(dx > 0.5 && dy < -1)) o.set(x, y); }
        o.rect(12, 2, 18, 3).rect(17, 2, 18, 8);   // arrowhead corner
    },
    'thumb-up': (o) => { o.rect(2, 9, 5, 18).rect(7, 9, 18, 18).rect(9, 3, 12, 8).rect(13, 6, 14, 8); },
    'thumb-down': (o) => { o.rect(2, 2, 5, 11).rect(7, 2, 18, 11).rect(9, 12, 12, 17).rect(13, 12, 14, 14); },
    study: (o) => {
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.abs(x + 0.5 - 10.5) / 9.5 + Math.abs(y + 0.5 - 7) / 4.5 <= 1) o.set(x, y);
        o.rect(5, 11, 15, 15); o.rect(8, 11, 12, 12, false).rect(8, 11, 12, 11); o.rect(18, 7, 19, 14);
    },
    file: (o) => { o.frame(4, 2, 16, 18); o.rect(12, 2, 16, 6, false); for (let i = 0; i <= 4; i++) o.set(12 + i, 2 + i).set(11, 2 + i).set(11 + i, 7 - 0 * i); o.rect(7, 10, 13, 10).rect(7, 13, 13, 13).rect(7, 16, 10, 16); },
    sidebar: (o) => { o.frame(2, 3, 18, 17); o.rect(7, 3, 8, 17); }
};

function fromSet(file) {
    const svg = fs.readFileSync(path.join(__dirname, 'src', file + '.svg'), 'utf8');
    // each sub-path must start with an absolute M, or a leading relative "m" would continue from the previous sub-path when merged
    // (a leading relative "m" is absolute for the first point, and later pairs stay relative: "m x y a b" -> "M x y l a b")
    const abs = (d) => d.trim().replace(/^m\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*(?=[-\d.])/, 'M$1 $2l').replace(/^m\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/, 'M$1 $2');
    const ds = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => abs(m[1]));
    return ds.join('');
}
const symbols = [];
for (const [id, file] of Object.entries(FROM_SET)) symbols.push([id, fromSet(file)]);
for (const [id, draw] of Object.entries(DRAWN)) { const o = grid(); draw(o); symbols.push([id, toPath(o.g)]); }
symbols.sort((a, b) => a[0].localeCompare(b[0]));

const sprite = '<svg style="display:none" aria-hidden="true">\n        <defs>\n            <!-- Pixel icon set by Streamline (CC BY 4.0, streamlinehq.com/icons/pixel); the rest are drawn on the same grid. Rebuild: node scripts/pixel-icons/build.js -->\n'
    + symbols.map(([id, d]) => `            <symbol id="icon-${id}" viewBox="0 0 32 32"><path fill="currentColor" d="${d}"/></symbol>`).join('\n')
    + '\n        </defs>\n    </svg>';
let html = fs.readFileSync(htmlPath, 'utf8');
const re = /<svg style="display:none" aria-hidden="true">[\s\S]*?<\/svg>/;
if (!re.test(html)) throw new Error('sprite not found in index.html');
html = html.replace(re, () => sprite);
fs.writeFileSync(htmlPath, html);
console.log(`pixel icons: ${symbols.length} symbols, ${(sprite.length / 1024).toFixed(1)} KB`);
