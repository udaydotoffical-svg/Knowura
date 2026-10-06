// Generates the light and terminal theme overrides from the real stylesheets (index.html + assistant.html), so
// every rule that hard-codes a colour gets a matching light or green one. Called by build-shared-ui.js.
//   dark  -> light : dark surfaces become pale, light text becomes dark, the cyan accent becomes a deeper teal
//   dark  -> green : every coloured surface/text is re-tinted to phosphor green
// Rules that paint their own saturated background (blue buttons, selected pills) keep their text colour.

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

// ---- colour helpers ----
const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
function parseColor(tok) {
    tok = tok.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(tok); if (m) { const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16)); return { r, g, b, a: 1 }; }
    m = /^#([0-9a-f]{6})$/.exec(tok); if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(tok); if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    return null;
}
function toHsl({ r, g, b, a }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2; let h = 0, s = 0;
    if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return { h, s, l, a };
}
function fromHsl({ h, s, l, a }) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2; let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    const f = (v) => Math.round((v + m) * 255);
    return a >= 1 ? `rgb(${f(r)}, ${f(g)}, ${f(b)})` : `rgba(${f(r)}, ${f(g)}, ${f(b)}, ${+a.toFixed(2)})`;
}
const isBlack = (c) => c.r < 8 && c.g < 8 && c.b < 8;
const COLOR_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)/g;

const mappers = {
    light: {
        bg(c) {   // dark surfaces -> pale
            if (isBlack(c) || Math.max(c.r, c.g, c.b) > 150) return null;
            const h = toHsl(c); return fromHsl({ h: h.h, s: h.s * 0.45, l: clamp(0.97 - h.l * 0.55, 0.8, 0.97), a: h.a });
        },
        text(c) {
            const h = toHsl(c);
            if (h.l > 0.72 && h.a > 0.5) return fromHsl({ h: h.h, s: Math.min(h.s, 0.5), l: 0.12 + (1 - h.l) * 0.6, a: h.a });
            if (h.s > 0.8 && h.l > 0.45 && h.h > 170 && h.h < 200) return '#0b7f9e';   // the cyan accent
            if (h.l > 0.5 && h.l <= 0.72) return fromHsl({ h: h.h, s: h.s * 0.6, l: 0.34, a: h.a });
            return null;
        }
    },
    term: {
        bg(c) {
            if (isBlack(c)) return null;
            const h = toHsl(c);
            if (h.s < 0.12 && h.l > 0.5) return null;   // keep pale greys/whites out of the surfaces
            return fromHsl({ h: 140, s: Math.min(0.7, Math.max(h.s, 0.4)), l: h.l * (h.l > 0.5 ? 0.55 : 0.5), a: h.a });
        },
        text(c) {
            const h = toHsl(c);
            if (h.l > 0.9 && h.s < 0.3) return '#c9ffd6';
            if (h.s > 0.2 || h.l > 0.6) return fromHsl({ h: 135, s: 0.85, l: clamp(h.l * 0.9 + 0.1, 0.45, 0.85), a: h.a });
            return null;
        }
    }
};

// ---- tiny CSS walker: yields { selectors, body, wrap } for every leaf rule ----
function* rules(css) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const stack = []; let i = 0, start = 0;
    while (i < css.length) {
        const ch = css[i];
        if (ch === '{') {
            const prelude = css.slice(start, i).trim();
            stack.push({ prelude, bodyStart: i + 1, hasChild: false });
            if (stack.length > 1) stack[stack.length - 2].hasChild = true;
            start = i + 1;
        } else if (ch === '}') {
            const top = stack.pop();
            if (top && !top.hasChild) {
                const wrap = stack.map((s) => s.prelude).filter((p) => /^@(media|supports)/.test(p));
                const inKeyframes = stack.some((s) => /^@(-webkit-)?keyframes|^@font-face/.test(s.prelude)) || /^@/.test(top.prelude);
                if (!inKeyframes) yield { selectors: top.prelude, body: css.slice(top.bodyStart, i), wrap };
            }
            start = i + 1;
        } else if (ch === ';' && stack.length === 0) start = i + 1;
        i++;
    }
}

function decls(body) {
    const out = []; let depth = 0, cur = '';
    for (const ch of body) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ';' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
    if (cur.trim()) out.push(cur);
    return out.map((d) => { const k = d.indexOf(':'); return k < 0 ? null : [d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim()]; }).filter(Boolean);
}
const recolor = (value, fn) => value.replace(COLOR_RE, (tok) => { const c = parseColor(tok); if (!c) return tok; const r = fn(c); return r || tok; });

// text that sits on a saturated (blue/cyan/red) surface keeps its colour
const KEEP_TEXT = /\.user\b|selected|\.active|\bcta\b|primary|send|new-chat|btn-got|q-letter|study-actions|\.on\b|toast|att-x|\.cookie-btn|\.pb-pick\.max|\.mic-btn|end-call|\.owner/;
function themeCss(theme, sources) {
    const m = mappers[theme], prefix = theme === 'light' ? 'html.light' : 'html.term';
    const seen = new Set(), out = [];
    for (const src of sources) for (const rule of rules(src)) {
        if (/html\.(term|light|lite|balanced|hc|crt|is-booting)|\.boot|:root|@/.test(rule.selectors)) continue;
        const ds = decls(rule.body), keep = [];
        const paintsBg = ds.some(([k, v]) => (k === 'background' || k === 'background-image' || k === 'background-color') && (/gradient|url\(|var\(--(blue|cyan|owner)/.test(v) || (parseColor(v.split(/\s/)[0]) && toHsl(parseColor(v.split(/\s/)[0])).s > 0.5 && toHsl(parseColor(v.split(/\s/)[0])).l > 0.25)));
        for (const [k, v] of ds) {
            if (/var\(--/.test(v) && !COLOR_RE.test(v)) { COLOR_RE.lastIndex = 0; continue; }
            COLOR_RE.lastIndex = 0;
            let nv = null;
            if (k === 'background' || k === 'background-color' || k === 'background-image') { const r = recolor(v, m.bg); if (r !== v) nv = r; }
            else if (k === 'color' && !paintsBg && !KEEP_TEXT.test(rule.selectors)) { const r = recolor(v, m.text); if (r !== v) nv = r; }
            else if (k === 'border-color' || k === 'outline-color') { if (theme === 'term') { const r = recolor(v, (c) => (isBlack(c) ? null : m.bg(c))); if (r !== v) nv = r; } }
            if (nv) keep.push(`${k}: ${nv}`);
        }
        if (!keep.length) continue;
        const sel = rule.selectors.split(',').map((s) => `${prefix} ${s.trim()}`).join(', ');
        const key = rule.wrap.join('|') + sel + keep.join(';');
        if (seen.has(key)) continue; seen.add(key);
        const text = `${sel} { ${keep.join('; ')}; }`;
        out.push(rule.wrap.length ? `${rule.wrap.join(' { ')} { ${text} }${' }'.repeat(rule.wrap.length - 1)}` : text);
    }
    return out.join('\n');
}

function styles(htmlFile) {
    const html = fs.readFileSync(path.join(root, 'public', htmlFile), 'utf8');
    return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).filter((s) => !/#kw-boot|\.boot \{/.test(s.slice(0, 200)));
}

function build() {
    const sources = [...styles('index.html'), ...styles('assistant.html')];
    const head = '/* GENERATED by scripts/build-themes.js from the page stylesheets. Do not edit by hand. */\n';
    return { 'theme-light.css': head + themeCss('light', sources) + '\n', 'theme-term.css': head + themeCss('term', sources) + '\n' };
}
module.exports = { build };
