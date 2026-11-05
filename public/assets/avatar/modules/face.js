/* Dot avatar studio: face features.
 *
 * createFace(THREE, mats) -> {build(shape, anchors, opts) -> FaceRig}
 *   opts    = {face, mouth, blush, lashes, hex, finishId, furLength}
 *   FaceRig = {group, setBlink(0..1), setLook(dx, dy), dispose(), trims}
 *   trims (extra, read-only): [{c:[x,y,z], r}] around the eyes and mouth for mats.setFurTrims.
 *
 * Eyes: 10 expressions (dot, happy, wink, sleepy, sparkle, hearts, surprised, cool,
 * starry, teary) on 6 eye types (dot, frog, robot, ghost, alien, cyclops). Mouths (8):
 * none, smile, grin, cat, o, tongue, fangs, kiss. Blush, lashes, noses (dot, button,
 * snout, beak, pig, koala), whiskers and the bear philtrum. Everything is procedural:
 * puffy domes over 2D outlines, capped tubes swept along curves, lathes and squashed
 * spheres. No textures, no model files.
 *
 * Eye types come from shape.face.eyes: 'frog' = white eyeballs on the top bumps with the
 * expression on the pupils; 'robot' = glowing shapes on the screen zone; 'ghost' = taller;
 * 'alien' = two big tilted almonds (outer corners up), dark and glossy with two shines;
 * 'cyclops' = ONE big eye (white sclera dome, dark iris, shine) at the midpoint of
 * eyeL/eyeR raised by 0.25 x eye spacing, sized from face.eyeSize (radius 1.2 x eyeSize
 * for a cyclops-sized eyeSize such as 0.16). Expressions map onto each type: closed arcs
 * stay arcs, hearts and stars replace the eye (cyclops: the iris), surprised enlarges
 * (cyclops: the iris shrinks), cool gets a half lid. 'starry' = puffy five-point stars with
 * a shine; 'teary' = big glossy eyes with large shines, tears welling along the lower lid
 * and one tear bead at each outer corner (no brows, nothing sad). Koala nose = a big puffy
 * vertical oval (0.22 x 0.3 eye spacing). Fangs = the smile with two small white fangs;
 * kiss = a puckered "3".
 *
 * This module imports nothing; three and the material factory are injected.
 *
 * THINGS THAT ARE EASY TO GET WRONG, handled below:
 *  1. eyeL is the viewer's left (-x). "wink" keeps eyeL open and closes eyeR (a cyclops
 *     winks with its one eye: a tilted closed arc).
 *  2. Features sit on the fur: each one is lifted along the true surface normal by
 *     furLength * 0.8, and every raised dome carries a skirt that reaches back below
 *     the skin, so no gap shows at grazing angles.
 *  3. The surface under a feature is fitted with a small quadric patch from the SDF
 *     (a few projections per feature), so strokes and discs hug the body without
 *     projecting every vertex. Without an SDF the patch is flat.
 *  4. Colors adapt to what is under each feature, not just to the body color: eyes on
 *     a dark paint zone (panda patches) turn light, anything on the robot screen glows.
 *     mats.faceMaterial(kind, BODY hex, {finishId, transmissive}) derives nose, beak, blush
 *     and glow tones from the body itself; where that tone would not stand out against the
 *     local zone, a fixed-color kind ('eye' dark, 'eye-light', 'pupil') is used instead.
 *     Contrast uses OKLab (Ottosson's published matrices).
 *  5. Materials come only from mats and are cached there: never mutate or dispose them.
 *  6. Each eye is built in its own local frame (u right, v up, w out), so setBlink can
 *     scale it on local y around its center. Closed-arc eyes do not blink.
 *  7. Triangle winding is outward everywhere (checked by signed volume in the tests);
 *     the materials stay FrontSide.
 *  8. Alien eyes are tilted by a group between the placement and the blink groups, and
 *     their shapes are built in that turned frame (rotHF turns the height field with it),
 *     so a blink closes an almond along its short axis. Lashes are not drawn on them.
 *  9. The cyclops eye is cast from the front at (midpoint.x, midpoint.y + 0.25 S) like the
 *     anchors are, so it sits on the surface even where the face curves back (where that
 *     point is above the head, the cast comes down until it lands). Its group is named
 *     'eyeC' (there is no eyeL/eyeR group); the sclera blinks, setLook moves only the iris,
 *     and parts that sit ON the sclera use a site whose height field is the sclera dome
 *     itself (onDome), so the iris hugs the eyeball.
 * 10. Star eyes are gold where gold stands out from what is under them, otherwise they use
 *     the eye ink; on the white of an eyeball they are dark. Colored bits (hearts, gold
 *     stars, tears, tongues) come from mats.accessory('enamel') as the hearts and tongue
 *     always did; everything else is a mats.faceMaterial kind.
 * 11. A tear hangs below the patch fitted around its eye, so it gets its own fitted site
 *     and stays out of the blink group (a blink never squashes it). The welling band does
 *     fold with the blink. The cyclops has a single trim that covers the whole eyeball.
 */

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 1]; };
const dist = (a, b) => len(sub(a, b));
const fin3 = (p) => Array.isArray(p) && p.length >= 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]);

/* ---------- color (OKLab) ---------- */

function hexNorm(h) {
  if (typeof h === 'number' && isFinite(h)) return ('000000' + (h >>> 0).toString(16)).slice(-6);
  if (h && typeof h === 'object' && typeof h.getHexString === 'function') return h.getHexString();
  let s = String(h == null ? '' : h).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s.replace(/./g, '$&$&');
  return /^[0-9a-f]{6}$/.test(s) ? s : null;
}
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function lab(hex) {
  const n = parseInt(hexNorm(hex) || '808080', 16);
  const r = toLin(((n >> 16) & 255) / 255), g = toLin(((n >> 8) & 255) / 255), b = toLin((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function labHex(L, A, B) {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  const ch = (c) => Math.round(clamp(toSrgb(c), 0, 1) * 255);
  const r = ch(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = ch(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const b = ch(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
const labDist = (x, y) => { const a = lab(x), b = lab(y); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };

// First candidate at least `min` away from `bg` in OKLab; else the first one pushed in lightness until it is.
function contrastPick(cands, bg, min) {
  min = min || 0.12;
  const list = cands.map(hexNorm).filter(Boolean);
  for (const c of list) if (labDist(c, bg) >= min) return c;
  const c0 = lab(list[0] || '808080'), b = lab(bg);
  const dirs = c0[0] >= b[0] ? [1, -1] : [-1, 1];
  for (const d of dirs) {
    for (let k = 1; k <= 18; k++) {
      const L = c0[0] + d * 0.04 * k;
      if (L < 0.08 || L > 0.98) break;
      const hx = labHex(L, c0[1], c0[2]);
      if (labDist(hx, bg) >= min) return hx;
    }
  }
  return b[0] > 0.6 ? '1e1d24' : 'f7f4ee';
}
// The candidate with the biggest lightness gap from bg.
function lightnessPick(cands, bg) {
  const L = lab(bg)[0];
  let best = null, bd = -1;
  for (const c of cands) {
    const h = hexNorm(c);
    if (!h) continue;
    const d = Math.abs(lab(h)[0] - L);
    if (d > bd) { bd = d; best = h; }
  }
  return best || '25232b';
}
// Star eyes are gold where gold stands out from the color under them; null = use the eye ink.
const STAR_GOLD = 'ffc83a';
const starGold = (bg) => (labDist(STAR_GOLD, bg) >= 0.18 ? STAR_GOLD : null);
// A pale water blue that still shows on what the tear hangs over.
const tearHex = (bg) => contrastPick(['8fd0ff', 'bfe6ff', '3d9be0'], bg, 0.1);

/* ---------- 2D outlines (u right, v up), counterclockwise ---------- */

function area2(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function ccw(pts) { return area2(pts) < 0 ? pts.slice().reverse() : pts; }
function resample(pts, n) {
  const m = pts.length, cum = [0];
  for (let i = 0; i < m; i++) { const p = pts[i], q = pts[(i + 1) % m]; cum.push(cum[i] + Math.hypot(q[0] - p[0], q[1] - p[1])); }
  const L = cum[m], out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * L;
    while (j < m - 1 && cum[j + 1] < t) j++;
    const p = pts[j], q = pts[(j + 1) % m], f = (t - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-9);
    out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
  }
  return out;
}
function ellipse(rx, ry, n, cx, cy) {
  const o = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU; o.push([(cx || 0) + rx * Math.cos(a), (cy || 0) + ry * Math.sin(a)]); }
  return o;
}
// Classic parametric heart (x = 16 sin^3 t, y = 13 cos t - 5 cos 2t - 2 cos 3t - cos 4t), width w, centered.
function heart(w, n) {
  const raw = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * TAU, s = Math.sin(t);
    raw.push([16 * s * s * s, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)]);
  }
  const k = w / 32;
  return ccw(resample(raw.map((p) => [p[0] * k, (p[1] + 2.6) * k]), n));
}
function roundRect(w, h, rad, n) {
  rad = Math.min(rad, w / 2, h / 2);
  const raw = [], q = 8, cx = w / 2 - rad, cy = h / 2 - rad;
  const corners = [[cx, cy, 0], [-cx, cy, 0.5], [-cx, -cy, 1], [cx, -cy, 1.5]];
  for (const c of corners) for (let i = 0; i <= q; i++) { const a = (c[2] + (i / q) * 0.5) * Math.PI; raw.push([c[0] + rad * Math.cos(a), c[1] + rad * Math.sin(a)]); }
  return ccw(resample(raw, n));
}
function clipTop(pts, vmax, n) { return ccw(resample(pts.map((p) => [p[0], Math.min(p[1], vmax)]), n)); }
// Chaikin corner cutting: rounds any polygon.
function chaikin(pts, it) {
  let p = pts;
  for (let k = 0; k < it; k++) {
    const o = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = o;
  }
  return p;
}
function star(rO, rI, k, n, rot) {
  const raw = [];
  for (let i = 0; i < k * 2; i++) { const a = (rot || Math.PI / 2) + (i / (k * 2)) * TAU, r = i % 2 ? rI : rO; raw.push([r * Math.cos(a), r * Math.sin(a)]); }
  return ccw(resample(chaikin(raw, 2), n));
}
// Open-mouth D: a shallow top lip over a deeper round bottom, pointed-round corners.
function mouthD(w, h, n) {
  const raw = [], q = 24;
  for (let i = 0; i <= q; i++) { const u = -w / 2 + (i / q) * w, x = (2 * u) / w; raw.push([u, -0.16 * h * (1 - x * x)]); }
  for (let i = q - 1; i > 0; i--) { const u = -w / 2 + (i / q) * w, x = (2 * u) / w; raw.push([u, -h * Math.pow(Math.max(0, 1 - x * x), 0.62)]); }
  return ccw(resample(raw, n));
}
// U-shaped tongue: flat top edge, round bottom.
function tongueU(w, h, n) {
  const R = w / 2, cy = -Math.max(h - R, 0), sy = Math.min(1, h / R), raw = [[R, 0], [-R, 0]];
  for (let i = 0; i <= 16; i++) { const a = Math.PI + (i / 16) * Math.PI; raw.push([R * Math.cos(a), cy + R * sy * Math.sin(a)]); }
  return ccw(resample(chaikin(raw, 1), n));
}
// Alien eye: an egg-shaped almond along u, round at the outer end (u = side * a), slimmer
// toward the nose. The tilt is applied by the caller's frame, not here.
function almond(a, b, side, n) {
  const o = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU, c = Math.cos(t), s = Math.sin(t);
    o.push([a * c, b * s * (0.79 + 0.21 * side * c)]);
  }
  return ccw(o);
}
// Teardrop, tip up at (0, h/2), round bottom at (0, -h/2), widest w.
function drop2(w, h, n) {
  const raw = [];
  let mx = 1e-9;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU, x = Math.sin(t) * Math.pow(Math.abs(Math.sin(t / 2)), 1.1);
    raw.push([x, Math.cos(t)]);
    mx = Math.max(mx, Math.abs(x));
  }
  return ccw(raw.map((p) => [(p[0] * w) / (2 * mx), (p[1] * h) / 2]));
}
// Distance from cen to a closed outline along direction ang (the farthest crossing).
function polyRadius(pts, cen, ang) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], ex = q[0] - p[0], ey = q[1] - p[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-14) continue;
    const wx = p[0] - cen[0], wy = p[1] - cen[1];
    const t = (wx * ey - wy * ex) / den, s = (wx * dy - wy * dx) / den;
    if (t > best && s >= -1e-9 && s <= 1 + 1e-9) best = t;
  }
  return best;
}
// Height above its base of a dome built by dome() over `pts` around `cen`, at (u, v).
// ell = [ru, rv] when the outline is an ellipse centered on cen: exact and much cheaper.
function outlineHeight(pts, cen, H, pw, ell) {
  const p = pw == null ? 0.55 : pw;
  return (u, v) => {
    const du = u - cen[0], dv = v - cen[1];
    let t;
    if (ell) t = Math.min(1, Math.hypot(du / ell[0], dv / ell[1]));
    else {
      const rho = Math.hypot(du, dv);
      if (rho < 1e-9) return H;
      const R = polyRadius(pts, cen, Math.atan2(dv, du));
      t = R > 1e-9 ? Math.min(1, rho / R) : 1;
    }
    return H * Math.pow(Math.max(0, 1 - t * t), p);
  };
}
// Teary eyes: tears welling along the lower lid. A curve just outside the bottom of an eye outline
// from the inner corner (t = 0) to the outer one (t = 1, at u = side), and the tear hanging there.
function welling(outline, cen, side, r) {
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 - side * (1.15 - 2.3 * (i / 16)), R = polyRadius(outline, cen, a) + 0.05 * r;
    pts.push([cen[0] + R * Math.cos(a), cen[1] + R * Math.sin(a)]);
  }
  const e = pts[pts.length - 1];
  return { pts, r, tear: { u: e[0] - side * 0.04 * r, v: e[1] + 0.03 * r, s: 0.9 * r } };
}
// A height field seen from a frame turned by `a` about the normal (tilted eyes): the turned
// frame's (u, v) is (u cos a - v sin a, u sin a + v cos a) in the original one.
function rotHF(hf, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return (u, v) => {
    const r = hf(u * c - v * s, u * s + v * c);
    return [r[0], r[1] * c + r[2] * s, -r[1] * s + r[2] * c];
  };
}

/* ---------- the factory ---------- */

export function createFace(THREE, mats) {
  if (!THREE || !mats) throw new Error('createFace needs THREE and mats');
  const M4 = new THREE.Matrix4();

  function makeGeo(pos, idx, uv) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Tube along a polyline with rounded (hemi-ellipsoid) caps; radius(t) -> number | [across, along up].
  function sweep(pts, o) {
    const n = pts.length, R = o.radial || 10, closed = !!o.closed, caps = !closed && o.caps !== false, cs = o.capSegs || 4;
    const radAt = (t) => { const r = typeof o.radius === 'function' ? o.radius(t) : o.radius; return Array.isArray(r) ? r : [r, r]; };
    const T = [], Nn = [], Bn = [];
    for (let i = 0; i < n; i++) {
      const a = closed ? pts[(i - 1 + n) % n] : pts[Math.max(i - 1, 0)];
      const b = closed ? pts[(i + 1) % n] : pts[Math.min(i + 1, n - 1)];
      T.push(norm(sub(b, a)));
    }
    let prev = null;
    for (let i = 0; i < n; i++) {
      let up = o.up ? (typeof o.up === 'function' ? o.up(i) : o.up) : prev;
      if (!up) up = Math.abs(T[i][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let N = sub(up, mul(T[i], dot(up, T[i])));
      if (len(N) < 1e-6) N = prev || (Math.abs(T[i][0]) < 0.9 ? cross(T[i], [1, 0, 0]) : cross(T[i], [0, 1, 0]));
      N = norm(N);
      Nn.push(N); Bn.push(cross(T[i], N)); prev = N;
    }
    const pos = [], idx = [], rings = [];
    const ring = (c, N, B, rb, rn) => {
      rings.push({ s: pos.length / 3, n: R });
      for (let j = 0; j < R; j++) {
        const a = (j / R) * TAU, ca = Math.cos(a) * rb, sa = Math.sin(a) * rn;
        pos.push(c[0] + B[0] * ca + N[0] * sa, c[1] + B[1] * ca + N[1] * sa, c[2] + B[2] * ca + N[2] * sa);
      }
    };
    const pole = (p) => { rings.push({ s: pos.length / 3, n: 1 }); pos.push(p[0], p[1], p[2]); };
    if (caps) {
      const [rb, rn] = radAt(0), cl = (rb + rn) / 2;
      pole(sub(pts[0], mul(T[0], cl)));
      for (let k = cs - 1; k >= 1; k--) { const f = (k / cs) * (Math.PI / 2); ring(sub(pts[0], mul(T[0], Math.sin(f) * cl)), Nn[0], Bn[0], rb * Math.cos(f), rn * Math.cos(f)); }
    }
    for (let i = 0; i < n; i++) { const [rb, rn] = radAt(n > 1 ? i / (n - 1) : 0); ring(pts[i], Nn[i], Bn[i], rb, rn); }
    if (caps) {
      const e = n - 1, [rb, rn] = radAt(1), cl = (rb + rn) / 2;
      for (let k = 1; k < cs; k++) { const f = (k / cs) * (Math.PI / 2); ring(add(pts[e], mul(T[e], Math.sin(f) * cl)), Nn[e], Bn[e], rb * Math.cos(f), rn * Math.cos(f)); }
      pole(add(pts[e], mul(T[e], cl)));
    }
    const link = (A, B) => {
      for (let j = 0; j < R; j++) {
        const j1 = (j + 1) % R;
        if (A.n === 1) idx.push(A.s, B.s + j, B.s + j1);
        else if (B.n === 1) idx.push(A.s + j, B.s, A.s + j1);
        else { const a = A.s + j, b = A.s + j1, c = B.s + j, d = B.s + j1; idx.push(a, c, b, b, c, d); }
      }
    };
    for (let q = 0; q < rings.length - 1; q++) link(rings[q], rings[q + 1]);
    if (closed) link(rings[rings.length - 1], rings[0]);
    return makeGeo(pos, idx);
  }

  // SDF helpers: projection to the zero set and normals.
  function makeSurf(sdf) {
    const e = 1e-3;
    const f = (p) => { const v = +sdf(p[0], p[1], p[2]); return isFinite(v) ? v : 0; };
    const grad = (p) => {
      const a = f([p[0] + e, p[1] - e, p[2] - e]), b = f([p[0] - e, p[1] - e, p[2] + e]);
      const c = f([p[0] - e, p[1] + e, p[2] - e]), d = f([p[0] + e, p[1] + e, p[2] + e]);
      return [a - b - c + d, -a - b + c + d, -a + b - c + d];
    };
    return {
      f,
      normal: (p) => norm(grad(p)),
      project(p) {
        let q = p.slice();
        for (let k = 0; k < 6; k++) {
          const d = f(q);
          if (Math.abs(d) < 2e-5) break;
          const g = grad(q), gl = len(g);
          if (!(gl > 1e-9)) break;
          q = sub(q, mul(g, d / gl));
        }
        return q;
      }
    };
  }

  // A feature site: local frame (t1 right, t2 up, n out) + height field h(u, v) over the tangent plane.
  function siteFrom(o, t1, t2, n, hf) {
    return {
      o, t1, t2, n, hf,
      lift(u, v, z) {
        const r = hf(u, v), k = 1 / Math.sqrt(r[1] * r[1] + r[2] * r[2] + 1);
        return [u - r[1] * k * z, v - r[2] * k * z, r[0] + k * z];
      },
      nrm(u, v) { const r = hf(u, v); return norm([-r[1], -r[2], 1]); },
      world(l) { return [o[0] + t1[0] * l[0] + t2[0] * l[1] + n[0] * l[2], o[1] + t1[1] * l[0] + t2[1] * l[1] + n[1] * l[2], o[2] + t1[2] * l[0] + t2[2] * l[1] + n[2] * l[2]]; },
      local(w) { const d = sub(w, o); return [dot(d, t1), dot(d, t2), dot(d, n)]; },
      dirLocal(w) { return [dot(w, t1), dot(w, t2), dot(w, n)]; }
    };
  }
  function frameFor(n) {
    let t1 = sub([1, 0, 0], mul(n, n[0]));
    if (len(t1) < 1e-3) t1 = cross([0, 1, 0], n);
    t1 = norm(t1);
    return [t1, cross(n, t1)];
  }
  function bodySite(surf, p, nHint, fitR) {
    let o = p.slice(), n = norm(nHint || [0, 0, 1]);
    if (surf) {
      const q = surf.project(o);
      if (fin3(q) && dist(q, o) < Math.max(fitR * 2, 0.05)) { o = q; const nn = surf.normal(o); if (fin3(nn) && len(nn) > 0.5) n = nn; }
    }
    const [t1, t2] = frameFor(n);
    let A = 0, B = 0, C = 0;
    if (surf && fitR > 0) {
      // Least squares h = A u^2 + B uv + C v^2 from 8 projected samples around the site.
      let s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0, r1 = 0, r2 = 0, r3 = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU, q0 = add(o, add(mul(t1, Math.cos(a) * fitR), mul(t2, Math.sin(a) * fitR)));
        const q = surf.project(q0);
        if (!fin3(q) || dist(q, q0) > fitR) continue;
        const d = sub(q, o), u = dot(d, t1), v = dot(d, t2), h = dot(d, n);
        const x1 = u * u, x2 = u * v, x3 = v * v;
        s11 += x1 * x1; s12 += x1 * x2; s13 += x1 * x3; s22 += x2 * x2; s23 += x2 * x3; s33 += x3 * x3;
        r1 += x1 * h; r2 += x2 * h; r3 += x3 * h;
      }
      const reg = 1e-9;
      s11 += reg; s22 += reg; s33 += reg;
      const det = s11 * (s22 * s33 - s23 * s23) - s12 * (s12 * s33 - s23 * s13) + s13 * (s12 * s23 - s22 * s13);
      if (Math.abs(det) > 1e-18) {
        A = (r1 * (s22 * s33 - s23 * s23) - s12 * (r2 * s33 - s23 * r3) + s13 * (r2 * s23 - s22 * r3)) / det;
        B = (s11 * (r2 * s33 - s23 * r3) - r1 * (s12 * s33 - s23 * s13) + s13 * (s12 * r3 - r2 * s13)) / det;
        C = (s11 * (s22 * r3 - r2 * s23) - s12 * (s12 * r3 - r2 * s13) + r1 * (s12 * s23 - s22 * s13)) / det;
        const lim = 6;
        A = clamp(A, -lim, lim); B = clamp(B, -lim, lim); C = clamp(C, -lim, lim);
        if (!isFinite(A + B + C)) A = B = C = 0;
      }
    }
    return siteFrom(o, t1, t2, n, (u, v) => [A * u * u + B * u * v + C * v * v, 2 * A * u + B * v, B * u + 2 * C * v]);
  }
  // Site on the front of a sphere (frog eyeballs), origin at the front pole.
  function sphereSite(center, F, Rb) {
    const n = norm(F), [t1, t2] = frameFor(n), o = add(center, mul(n, Rb)), floor = (0.2 * Rb) * (0.2 * Rb);
    return siteFrom(o, t1, t2, n, (u, v) => {
      const q = Math.max(Rb * Rb - u * u - v * v, floor), s = Math.sqrt(q);
      return [s - Rb, -u / s, -v / s];
    });
  }
  function groupAt(site) {
    const g = new THREE.Group();
    M4.makeBasis(new THREE.Vector3(...site.t1), new THREE.Vector3(...site.t2), new THREE.Vector3(...site.n));
    g.quaternion.setFromRotationMatrix(M4);
    g.position.set(site.o[0], site.o[1], site.o[2]);
    return g;
  }
  // The top of a dome (as dome() builds it over `pts` around `cen`, `z0` above `site`) seen as
  // a site in the same frame, so an iris or a shine can sit on an eyeball and follow its curve.
  function onDome(site, pts, cen, H, pw, z0, ell) {
    const hz = outlineHeight(pts, cen, H, pw, ell), e = 1e-4;
    return siteFrom([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], (u, v) => {
      const r = site.hf(u, v);
      const hx = (hz(u + e, v) - hz(u - e, v)) / (2 * e), hy = (hz(u, v + e) - hz(u, v - e)) / (2 * e);
      return [r[0] + z0 + hz(u, v), r[1] + hx, r[2] + hy];
    });
  }
  // First surface point seen from the front at (x, y), marching down -z from zs; null on a miss.
  function castFront(surf, x, y, zs) {
    let z = zs;
    for (let i = 0; i < 256; i++) {
      const d = surf.f([x, y, z]);
      if (d < 2e-5) return [x, y, z];
      z -= Math.max(d * 0.9, 1e-4);
      if (z < zs - 3) break;
    }
    return null;
  }
  // A small tear bead hanging from (u, v) (its tip) on a site, with a glint.
  function buildTear(site, u, v, s, z0, parent, mat, hlMat, addMesh) {
    const w = 0.64 * s, h = s, ol = drop2(w, h, 36).map((p) => [p[0] + u, p[1] + v - 0.5 * h]);
    const cen = [u, v - 0.6 * h], H = 0.4 * w;
    addMesh(parent, dome(site, ol, cen, H, z0, { rings: 5, pow: 0.5, skirt: z0 + 0.15 * w }), mat, 'tear');
    const hz = outlineHeight(ol, cen, H, 0.5), bu = u - 0.16 * w, bv = v - 0.62 * h, bs = 0.13 * w;
    addMesh(parent, bead(site, bu, bv, z0 + hz(bu, bv) - 0.1 * bs, bs, bs * 1.35, bs * 0.4, 10), hlMat, 'tear-shine');
  }
  // One lash: a tapered stroke from `start` along `dir`, curling sideways by `bend` (+ = clockwise).
  function lashAt(site, start, dir, L, bend, rad, z, mat, parent, addMesh) {
    const d = norm([dir[0], dir[1], 0]), perp = [d[1], -d[0]];
    const a = [start[0], start[1]], c = [start[0] + d[0] * L + perp[0] * bend * L, start[1] + d[1] * L + perp[1] * bend * L];
    const b = [start[0] + d[0] * L * 0.55, start[1] + d[1] * L * 0.55];
    addMesh(parent, stroke(site, bez2(a, b, c, 7), rad, z, { sink: 0.3, radial: 7 }), mat, 'lash');
  }

  // Puffy dome over a closed outline, lifted onto a site; skirt reaches back under the base.
  function dome(site, outline, cen, H, base, o) {
    o = o || {};
    const ol = ccw(outline), nO = ol.length, nR = o.rings || 5, pw = o.pow == null ? 0.55 : o.pow;
    const pos = [], idx = [], uv = o.uv ? [] : null;
    // uv: the outline's half extents map to radius 0.5 around (0.5, 0.5), like CircleGeometry.
    let hx = 1e-6, hy = 1e-6;
    for (const p of ol) { hx = Math.max(hx, Math.abs(p[0] - cen[0])); hy = Math.max(hy, Math.abs(p[1] - cen[1])); }
    const put = (u, v, z) => { const l = site.lift(u, v, z); pos.push(l[0], l[1], l[2]); if (uv) uv.push(0.5 + (u - cen[0]) / (2 * hx), 0.5 + (v - cen[1]) / (2 * hy)); };
    put(cen[0], cen[1], base + H);
    for (let k = 1; k <= nR; k++) {
      const t = Math.sin((k / nR) * (Math.PI / 2)), h = H * Math.pow(Math.max(0, 1 - t * t), pw);
      for (const p of ol) put(cen[0] + (p[0] - cen[0]) * t, cen[1] + (p[1] - cen[1]) * t, base + h);
    }
    const skirt = o.skirt == null ? base + 0.004 : o.skirt;
    const nRing = skirt > 0 ? nR + 1 : nR;
    if (skirt > 0) for (const p of ol) put(p[0], p[1], base - skirt);
    for (let i = 0; i < nO; i++) idx.push(0, 1 + i, 1 + ((i + 1) % nO));
    for (let k = 1; k < nRing; k++) {
      const a0 = 1 + (k - 1) * nO, c0 = 1 + k * nO;
      for (let i = 0; i < nO; i++) {
        const i1 = (i + 1) % nO, a = a0 + i, b = a0 + i1, c = c0 + i, d = c0 + i1;
        idx.push(a, c, d, a, d, b);
      }
    }
    return makeGeo(pos, idx, uv);
  }
  // Height of a dome (as built above) at (u, v), for things that sit on it. Elliptic outlines only.
  const domeH = (u, v, ru, rv, H, pw) => { const t = Math.min(1, Math.hypot(u / ru, v / rv)); return H * Math.pow(Math.max(0, 1 - t * t), pw == null ? 0.55 : pw); };

  // Stroke: capped tube along a 2D curve lifted onto a site.
  function stroke(site, curve, rad, z0, o) {
    o = o || {};
    // The cross-section reaches from its top down below the skin, so a stroke lifted over fur
    // reads as a raised ridge rather than a floating tube.
    const n = curve.length, radAt = typeof rad === 'function' ? rad : () => rad, flat = o.flat || 0.82, sink = o.sink == null ? 0.35 : o.sink;
    const pts = [], ups = [], rn = [];
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0, r = radAt(t), c = curve[i];
      const top = z0 + r * (sink + flat), bot = Math.min(z0 + r * (sink - flat), -0.4 * r);
      pts.push(site.lift(c[0], c[1], (top + bot) / 2));
      rn.push((top - bot) / 2);
      ups.push(site.nrm(c[0], c[1]));
    }
    return sweep(pts, { radius: (t) => { const i = Math.round(t * (n - 1)); return [radAt(t), rn[i]]; }, up: (i) => ups[i], radial: o.radial || 10, capSegs: 4 });
  }
  const sampleCurve = (fn, n) => { const o = []; for (let i = 0; i < n; i++) o.push(fn(i / (n - 1))); return o; };
  const bez2 = (a, b, c, n) => sampleCurve((t) => { const s = 1 - t; return [s * s * a[0] + 2 * s * t * b[0] + t * t * c[0], s * s * a[1] + 2 * s * t * b[1] + t * t * c[1]]; }, n);

  // Small squashed sphere sitting on a site at (u, v, z) with radii (r, r, r*fz).
  function bead(site, u, v, z, rx, ry, rz, segs) {
    const g = new THREE.SphereGeometry(1, segs || 14, Math.max(6, Math.round((segs || 14) * 0.6)));
    g.scale(rx, ry, rz);
    const n = site.nrm(u, v), l = site.lift(u, v, z);
    const [t1] = frameFor(n), t2 = cross(n, t1);
    M4.makeBasis(new THREE.Vector3(...t1), new THREE.Vector3(...t2), new THREE.Vector3(...n)).setPosition(l[0], l[1], l[2]);
    g.applyMatrix4(M4);
    return g;
  }

  /* ---------- tones and materials ---------- */

  const FALLBACK = { cream: 'fff1d8', pink: 'ff9fbd', dark: '2b2830', light: 'fff8ee', orange: 'ff9a3c', white: 'ffffff', screen: '1c2130', ink: '24222a', inkLight: 'f6f2ea', cheek: 'ff8aa6' };
  function getTones(hex) {
    let t = null;
    try { t = typeof mats.tones === 'function' ? mats.tones(hex) : null; } catch (e) { t = null; }
    const out = {};
    for (const k of Object.keys(FALLBACK)) out[k] = hexNorm(t && t[k]) || FALLBACK[k];
    if (!t) {
      out.cream = contrastPick([FALLBACK.cream, 'f2d6a8'], hex);
      out.pink = contrastPick([FALLBACK.pink, 'e2668a'], hex);
      out.cheek = contrastPick([FALLBACK.cheek, 'e65a7f'], hex, 0.08);
      if (lab(hex)[0] < 0.4) out.dark = 'e9e4dc';
    }
    return out;
  }
  // Which paint zone covers p: the strongest zone wins, later zones on ties (paint zone math of the
  // spec: gradient-normalized superellipsoid distance, smoothstep over the zone's soft width).
  function zoneAt(shape, p) {
    const zones = (shape && Array.isArray(shape.paint)) ? shape.paint : [];
    let best = null, bw = 0.5;
    for (const z of zones) {
      if (!z || !z.c || !z.r) continue;
      const e = z.p || 2, r = z.r;
      const qx = Math.max(Math.abs(p[0] - z.c[0]) / r[0], 1e-4), qy = Math.max(Math.abs(p[1] - z.c[1]) / r[1], 1e-4), qz = Math.max(Math.abs(p[2] - z.c[2]) / r[2], 1e-4);
      const S = Math.pow(qx, e) + Math.pow(qy, e) + Math.pow(qz, e);
      const g = Math.pow(S, 1 / e - 1) * Math.hypot(Math.pow(qx, e - 1) / r[0], Math.pow(qy, e - 1) / r[1], Math.pow(qz, e - 1) / r[2]);
      const d = (Math.pow(S, 1 / e) - 1) / Math.max(g, 1e-9), k = Math.max((z.soft || 0.03) / 2, 1e-4);
      const t = clamp((d + k) / (2 * k), 0, 1), w = 1 - t * t * (3 - 2 * t);
      if (w >= bw) { bw = w; best = z.tone; }
    }
    return best;
  }
  // Fixed colors of the face kinds that do not depend on the body (mirrors materials.js).
  const EYE_DARK = '1d1a22', EYE_LIGHT = 'f3efe6';

  /* ---------- build ---------- */

  function build(shape, anchors, opts) {
    opts = opts || {};
    const A = anchors || {};
    if (!A.eyeL || !A.eyeR || !fin3(A.eyeL.p) || !fin3(A.eyeR.p)) throw new Error('face.build: anchors.eyeL/eyeR missing');
    const F = (shape && shape.face) || {};
    const fur = Math.max(0, +opts.furLength || 0), off = fur * 0.8;
    const body = hexNorm(opts.hex) || 'ffd34e';
    const tones = getTones(body);
    const mo = { finishId: opts.finishId, transmissive: !!opts.transmissive };
    const fm = (kind) => mats.faceMaterial(kind, body, mo);
    const am = (kind, hex) => mats.accessory(kind, { color: hexNorm(hex) || hex, soft: false, finishId: opts.finishId, transmissive: !!opts.transmissive });
    // A body-derived tone kind, or a fixed dark/light kind when that tone would not stand out.
    const toned = (kind, toneHex, bgHex) => {
      if (Math.abs(lab(toneHex)[0] - lab(bgHex)[0]) >= 0.22 || labDist(toneHex, bgHex) >= 0.2) return fm(kind);
      return fm(lab(bgHex)[0] > 0.55 ? 'eye' : 'eye-light');
    };
    const surf = shape && typeof shape.sdf === 'function' ? makeSurf(shape.sdf) : null;
    const eyeType = ['frog', 'robot', 'ghost', 'alien', 'cyclops'].indexOf(F.eyes) >= 0 ? F.eyes : 'dot';
    const expr = ['dot', 'happy', 'wink', 'sleepy', 'sparkle', 'hearts', 'surprised', 'cool', 'starry', 'teary'].indexOf(opts.face) >= 0 ? opts.face : 'dot';
    const mouthId = ['none', 'smile', 'grin', 'cat', 'o', 'tongue', 'fangs', 'kiss'].indexOf(opts.mouth) >= 0 ? opts.mouth : 'smile';
    let S = dist(A.eyeL.p, A.eyeR.p);
    if (!(S > 0.08 && S < 1.6)) S = 0.5;
    const r = clamp(F.eyeSize > 0 ? +F.eyeSize : 0.15 * S, 0.1 * S, 0.2 * S);

    const root = new THREE.Group();
    root.name = 'face';
    const geos = [];
    const addMesh = (parent, geo, mat, name) => {
      if (!geo || !mat) return null;
      geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.name = name || '';
      m.castShadow = false;
      m.receiveShadow = false;
      parent.add(m);
      return m;
    };
    const bgAt = (p) => { const z = zoneAt(shape, p); return { tone: z, hex: z && tones[z] ? tones[z] : body }; };
    const inkFor = (p, forceGlow) => {
      const bg = bgAt(p);
      if (forceGlow || bg.tone === 'screen') return { mat: fm('glow'), hex: 'ffffff', glow: true, bg: bg.hex };
      const h = lightnessPick([EYE_DARK, EYE_LIGHT], bg.hex);
      const light = h === EYE_LIGHT;
      return { mat: fm(light ? 'eye-light' : 'eye'), hex: h, glow: false, light, bg: bg.hex };
    };
    const white = () => fm('white');

    /* nose first: the mouth may have to move below it */
    const noseKind = ['dot', 'button', 'snout', 'beak', 'pig', 'koala'].indexOf(F.nose) >= 0 ? F.nose : 'none';
    let noseBottomW = null, noseSite = null;
    if (noseKind !== 'none' && A.nose && fin3(A.nose.p)) {
      noseSite = bodySite(surf, A.nose.p, A.nose.n, 0.16 * S);
      const g = groupAt(noseSite);
      g.name = 'nose';
      const tone = F.noseTone || (noseKind === 'beak' ? 'orange' : noseKind === 'pig' ? 'pink' : 'dark');
      const bg = bgAt(noseSite.o).hex;
      let bottomV = 0;
      if (noseKind === 'beak') {
        const Rb = 0.13 * S, L = 0.24 * S, prof = [];
        for (let i = 0; i <= 14; i++) {
          const t = i / 14, y = -0.3 * L + t * 1.3 * L, x = clamp((y + 0.3 * L) / (1.3 * L), 0, 1);
          prof.push(new THREE.Vector2(Rb * Math.pow(Math.max(0, 1 - Math.pow(x, 1.7)), 0.62) + 1e-4, y));
        }
        prof[prof.length - 1].x = 0;
        prof.unshift(new THREE.Vector2(0, -0.3 * L));
        const geo = new THREE.LatheGeometry(prof, 20);
        geo.scale(1.12, 1, 0.78);
        const dir = norm(add(noseSite.dirLocal([0, -0.18, 0.75]), [0, 0, 1]));
        const zl = norm(sub([0, 1, 0], mul(dir, dir[1]))), xl = cross(dir, zl);
        M4.makeBasis(new THREE.Vector3(...xl), new THREE.Vector3(...dir), new THREE.Vector3(...zl)).setPosition(0, 0, off);
        geo.applyMatrix4(M4);
        addMesh(g, geo, toned('beak', tones.orange, bg), 'beak');
        bottomV = -Rb * 0.85;
      } else if (noseKind === 'pig') {
        const R = 0.19 * S, Tk = 0.42 * R, rc = 0.32 * Tk, V2 = (x, y) => new THREE.Vector2(x, y);
        const prof = [V2(0, -0.6 * Tk), V2(R * 0.96, -0.6 * Tk), V2(R, -0.25 * Tk), V2(R, Tk - rc)];
        for (let i = 1; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push(V2(R - rc + rc * Math.cos(a), Tk - rc + rc * Math.sin(a))); }
        for (let i = 1; i <= 5; i++) { const t = i / 5; prof.push(V2((R - rc) * (1 - t), Tk * (1 + 0.05 * Math.sin(t * Math.PI / 2)))); }
        const geo = new THREE.LatheGeometry(prof, 28);
        geo.rotateX(Math.PI / 2);
        geo.scale(1.12, 1, 1);
        geo.translate(0, 0, off);
        addMesh(g, geo, fm('nose-pink'), 'pig-snout');
        const flat = siteFrom([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], () => [0, 0, 0]);
        for (const sx of [-1, 1]) {
          const ol = ellipse(0.15 * R, 0.25 * R, 20, sx * 0.36 * R * 1.12, 0);
          addMesh(g, dome(flat, ol, [sx * 0.36 * R * 1.12, 0], 0.04 * R, off + Tk * 1.0, { rings: 3, skirt: 0.06 * R }), fm('pupil'), 'nostril');
        }
        bottomV = -R * 0.9;
      } else if (noseKind === 'button') {
        const R = 0.07 * S, pinkish = tone === 'pink';
        const geo = new THREE.SphereGeometry(R, 20, 14);
        geo.scale(1.15, 0.95, 0.9);
        const l = noseSite.lift(0, 0, off + R * 0.32);
        geo.translate(l[0], l[1], l[2]);
        const nm = pinkish ? toned('nose-pink', tones.pink, bg) : toned('nose-dark', tones.dark, bg);
        addMesh(g, geo, nm, 'nose');
        if (!pinkish && nm.color && nm.color.getHSL({ h: 0, s: 0, l: 0 }).l < 0.25) addMesh(g, bead(noseSite, -0.35 * R, 0.4 * R, off + R * 1.12, 0.22 * R, 0.16 * R, 0.08 * R, 10), white(), 'nose-shine');
        bottomV = -R;
      } else if (noseKind === 'snout') {
        const w = 0.24 * S, h = 0.16 * S;
        const tri = ccw(resample(chaikin([[-w / 2, h * 0.42], [w / 2, h * 0.42], [0, -h * 0.58]], 3), 40));
        const pinkish = tone === 'pink';
        const nm = pinkish ? toned('nose-pink', tones.pink, bg) : toned('nose-dark', tones.dark, bg);
        addMesh(g, dome(noseSite, tri, [0, 0.05 * h], 0.42 * h, off, { rings: 6, pow: 0.6 }), nm, 'nose');
        if (!pinkish && nm.color && nm.color.getHSL({ h: 0, s: 0, l: 0 }).l < 0.25) addMesh(g, bead(noseSite, -0.2 * w, 0.18 * h, off + 0.36 * h, 0.13 * w, 0.07 * w, 0.03 * w, 10), white(), 'nose-shine');
        bottomV = -h * 0.5;
      } else if (noseKind === 'koala') {
        // Big puffy vertical oval, a little fuller at the top, with a soft glint.
        const w = 0.22 * S, h = 0.3 * S, ol = [];
        for (let i = 0; i < 56; i++) { const t = (i / 56) * TAU, sn = Math.sin(t); ol.push([0.5 * w * Math.cos(t) * (1 + 0.1 * sn), 0.5 * h * sn]); }
        const pinkish = tone === 'pink';
        const nm = pinkish ? toned('nose-pink', tones.pink, bg) : toned('nose-dark', tones.dark, bg);
        const cen = [0, 0.05 * h], H = 0.42 * w;
        addMesh(g, dome(noseSite, ol, cen, H, off, { rings: 7, pow: 0.5 }), nm, 'nose');
        if (!pinkish && nm.color && nm.color.getHSL({ h: 0, s: 0, l: 0 }).l < 0.25) {
          const hz = outlineHeight(ol, cen, H, 0.5), su = -0.19 * w, sv = 0.2 * h;
          addMesh(g, bead(noseSite, su, sv, off + hz(su, sv) - 0.012 * w, 0.1 * w, 0.17 * w, 0.045 * w, 10), white(), 'nose-shine');
        }
        bottomV = -h * 0.5;
      } else {
        const nm = tone === 'pink' ? toned('nose-pink', tones.pink, bg) : toned('nose-dark', tones.dark, bg);
        addMesh(g, dome(noseSite, ellipse(0.05 * S, 0.038 * S, 24), [0, 0], 0.028 * S, off, { rings: 4 }), nm, 'nose');
        bottomV = -0.038 * S;
      }
      noseBottomW = noseSite.world([0, bottomV, 0]);
      root.add(g);
    }

    /* mouth */
    const mouthTop = { none: 0, smile: 0.06 * S, grin: 0.03 * S, cat: 0.055 * S, o: 0.085 * S, tongue: 0.06 * S, fangs: 0.06 * S, kiss: 0.1 * S }[mouthId];
    let mouthSite = null;
    if (mouthId !== 'none' && A.mouth && fin3(A.mouth.p)) {
      let mp = A.mouth.p.slice();
      if (noseBottomW && noseKind !== 'dot') {
        const limit = noseBottomW[1] - 0.025 * S - mouthTop;
        if (mp[1] > limit) mp = [mp[0], limit, mp[2] + 0.0];
      }
      mouthSite = bodySite(surf, mp, A.mouth.n, 0.17 * S);
      const g = groupAt(mouthSite);
      g.name = 'mouth';
      const ink = inkFor(mouthSite.o, false);
      const rs = 0.027 * S;
      const w = 0.27 * S, d = 0.07 * S, v0 = 0.03 * S;
      const smileCurve = sampleCurve((t) => { const u = (t - 0.5) * w, x = (2 * u) / w; return [u, v0 - d * (1 - x * x)]; }, 17);
      if (mouthId === 'smile') {
        addMesh(g, stroke(mouthSite, smileCurve, rs, off), ink.mat, 'mouth');
      } else if (mouthId === 'cat') {
        const hw = 0.13 * S, dd = 0.058 * S;
        for (const sx of [-1, 1]) {
          const c = sampleCurve((t) => { const u = sx * t * hw, x = (2 * t - 1); return [u, v0 - dd * (1 - x * x)]; }, 13);
          addMesh(g, stroke(mouthSite, c, rs, off), ink.mat, 'mouth');
        }
      } else if (mouthId === 'grin') {
        const gw = 0.3 * S, gh = 0.2 * S, top = 0.04 * S, H = 0.035 * S;
        const out = mouthD(gw, gh, 44).map((p) => [p[0], p[1] + top]);
        addMesh(g, dome(mouthSite, out, [0, top - 0.5 * gh], H, off, { rings: 5, pow: 0.4 }), ink.mat, 'mouth');
        if (!ink.glow) {
          const tc = contrastPick(['ff6f8f', 'ff8fa8', 'e44e74'], ink.hex, 0.15);
          const tw = 0.15 * S, th = 0.075 * S, tcv = top - 0.69 * gh;
          addMesh(g, dome(mouthSite, ellipse(tw / 2, th / 2, 28, 0, tcv), [0, tcv], 0.018 * S, off + H * 0.55, { rings: 4, skirt: 0.01 * S }), am('enamel', tc), 'tongue');
        }
      } else if (mouthId === 'o') {
        const ow = 0.075 * S, oh = 0.088 * S;
        addMesh(g, dome(mouthSite, ellipse(ow, oh, 36, 0, -0.005 * S), [0, -0.005 * S], 0.035 * S, off, { rings: 5, pow: 0.45 }), ink.mat, 'mouth');
      } else if (mouthId === 'tongue') {
        addMesh(g, stroke(mouthSite, smileCurve, rs, off), ink.mat, 'mouth');
        const tc = contrastPick(['ff6f8f', 'ff8fa8', 'e44e74'], bgAt(mouthSite.o).hex, 0.12);
        const tw = 0.14 * S, th = 0.15 * S, tu = 0.03 * S, tv = v0 - d * 0.86;
        const out = tongueU(tw, th, 36).map((p) => [p[0] + tu, p[1] + tv]);
        addMesh(g, dome(mouthSite, out, [tu, tv - th * 0.45], 0.04 * S, off + rs * 0.15, { rings: 5, pow: 0.5 }), am('enamel', tc), 'tongue');
      } else if (mouthId === 'fangs') {
        // The smile, with two small white fangs hanging from it, tilted a little with its curve.
        addMesh(g, stroke(mouthSite, smileCurve, rs, off), ink.mat, 'mouth');
        const fw = 0.085 * S, fh = 0.13 * S;
        const tri = chaikin([[-fw / 2, 0.016 * S], [fw / 2, 0.016 * S], [0, -fh]], 3);
        for (const sx of [-1, 1]) {
          const fu = sx * 0.07 * S, x = (2 * fu) / w, fv = v0 - d * (1 - x * x);
          const a = 0.5 * Math.atan((8 * d * fu) / (w * w)), ca = Math.cos(a), sa = Math.sin(a);
          const ol = ccw(resample(tri.map((p) => [fu + p[0] * ca - p[1] * sa, fv + p[0] * sa + p[1] * ca]), 32));
          const cen = [fu + 0.36 * fh * sa, fv - 0.36 * fh * ca];
          addMesh(g, dome(mouthSite, ol, cen, 0.032 * S, off, { rings: 4, pow: 0.45 }), white(), 'fang');
        }
      } else if (mouthId === 'kiss') {
        // A puckered "3": two small bumps facing the viewer's right, meeting in a point.
        const kh = 0.15 * S, kw = 0.068 * S, ku = -0.012 * S;
        const bump = (cy, a0, a1) => sampleCurve((t) => { const a = a0 + (a1 - a0) * t; return [ku + kw * Math.cos(a), cy + (kh / 4) * Math.sin(a)]; }, 15);
        addMesh(g, stroke(mouthSite, bump(kh / 4, 2.25, -1.76), rs * 0.95, off), ink.mat, 'mouth');
        addMesh(g, stroke(mouthSite, bump(-kh / 4, 1.76, -2.25), rs * 0.95, off), ink.mat, 'mouth');
      }
      // Bear and pup muzzles: a short line from the nose down to the mouth.
      if (noseKind === 'snout' && noseBottomW && (mouthId === 'smile' || mouthId === 'cat' || mouthId === 'tongue' || mouthId === 'fangs')) {
        const nb = mouthSite.local(noseBottomW);
        const vTop = mouthId === 'cat' ? v0 : v0 - d;
        if (nb[1] - vTop > 0.03 * S) {
          const c = sampleCurve((t) => [nb[0] * (1 - t), nb[1] - 0.01 * S + (vTop - nb[1] + 0.01 * S) * t], 7);
          addMesh(g, stroke(mouthSite, c, rs * 0.85, off), ink.mat, 'philtrum');
        }
      }
      root.add(g);
    }

    /* eyes */
    const eyes = [];
    const lashesOn = !!opts.lashes;
    const ghostScale = eyeType === 'ghost' ? 1.45 : 1;
    const cyc = eyeType === 'cyclops' ? buildCyclops() : null;
    for (const side of cyc ? [] : [-1, 1]) {
      const an = side < 0 ? A.eyeL : A.eyeR;
      const kind = expr === 'wink' ? (side < 0 ? 'dot' : 'happy') : expr;
      const bsite = bodySite(surf, an.p, an.n, 1.7 * r);
      const holder = groupAt(bsite);
      holder.name = side < 0 ? 'eyeL' : 'eyeR';
      root.add(holder);
      let site = siteFrom([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], bsite.hf);
      let rr = r, ink, zBase = off;
      if (eyeType === 'frog') {
        // White eyeball half sunk into the bump, facing forward; the pupil carries the expression.
        const Rb = 1.45 * r;
        const fwd = norm(add(norm(bsite.dirLocal(an.n && fin3(an.n) ? an.n : bsite.n)), mul(bsite.dirLocal([0, 0, 1]), 1.1)));
        const center = [0, 0, off - 0.42 * Rb];
        const ball = new THREE.SphereGeometry(Rb, 28, 20);
        ball.translate(center[0], center[1], center[2]);
        addMesh(holder, ball, white(), 'eyeball');
        site = sphereSite(center, fwd, Rb);
        rr = 0.5 * Rb;
        zBase = 0;
        ink = { mat: fm('pupil'), hex: EYE_DARK, glow: false, bg: 'fbfaf6' };
      } else {
        ink = inkFor(bsite.o, eyeType === 'robot');
      }
      // Pivot chain: place (site frame; the sphere front for frogs) -> [tilt (alien)] -> blink
      // (scale y) -> look (drift). Lashes ride in the blink group, so they fold with the lid.
      const place = groupAt(site);
      holder.add(place);
      const blink = new THREE.Group(), look = new THREE.Group();
      let L = siteFrom([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], site.hf), theta = 0;
      if (eyeType === 'alien') {
        // Outer corners up; hearts and stars stay nearly upright.
        theta = side * (kind === 'hearts' || kind === 'starry' ? 0.12 : 0.38);
        const tilt = new THREE.Group();
        tilt.name = 'eye-tilt';
        tilt.rotation.z = theta;
        place.add(tilt);
        tilt.add(blink);
        L = siteFrom([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], rotHF(site.hf, theta));
      } else {
        place.add(blink);
      }
      blink.add(look);
      const info = buildEye(L, kind, side, rr, ink, zBase, eyeType, look, addMesh, white, fm, am, S);
      if (info.well) {
        // Teary: a pale water band along the lower lid (folds with the blink), spilling into a
        // tear that hangs, untilted and outside the blink group, from its outer end.
        const tm = ink.glow ? ink.mat : am('enamel', tearHex(ink.bg || body));
        addMesh(blink, stroke(L, info.well.pts, (t) => info.well.r * (0.035 + 0.075 * Math.sin(Math.PI * (0.1 + 0.8 * t))), zBase, { sink: 0.25 }), tm, 'tear-well');
        const c = Math.cos(theta), s = Math.sin(theta), t = info.well.tear, tu = t.u * c - t.v * s, tv = t.u * s + t.v * c;
        if (eyeType === 'frog') buildTear(L, tu, tv, t.s, zBase, place, tm, white(), addMesh);
        else hangTear(bsite, site.hf, tu, tv, t.s, tm);
      }
      if (lashesOn && eyeType !== 'alien') buildLashes(L, kind, side, rr, info, ink, zBase, blink, addMesh);
      eyes.push({ blink, look, open: info.open, rr, frog: eyeType === 'frog' });
    }

    /* blush */
    if ((opts.blush || F.cheeks) && A.cheekL && A.cheekR) {
      for (const an of [A.cheekL, A.cheekR]) {
        if (!fin3(an.p)) continue;
        const bx = 0.2 * S, by = 0.125 * S;
        const cs = bodySite(surf, an.p, an.n, bx);
        const g = groupAt(cs);
        g.name = 'blush';
        addMesh(g, dome(cs, ellipse(bx, by, 32), [0, 0], 0.004 * S, off + 0.006 * S, { rings: 4, pow: 0.5, uv: true, skirt: 0 }), fm('blush'), 'blush');
        root.add(g);
      }
    }

    /* whiskers */
    if (F.whiskers && A.nose && fin3(A.nose.p)) {
      const ns = noseSite || bodySite(surf, A.nose.p, A.nose.n, 0.16 * S);
      const g = new THREE.Group();
      g.name = 'whiskers';
      for (const side of [-1, 1]) {
        const start0 = ns.world([side * 0.19 * S, -0.02 * S, 0]);
        const ink = inkFor(start0, false);
        const angs = [0.24, 0.02, -0.2];
        for (let k = 0; k < 3; k++) {
          const a = angs[k], pts = [], ups = [];
          for (let i = 0; i < 7; i++) {
            const t = i / 6, L = 0.34 * S;
            const u = side * (0.19 * S + Math.cos(a) * L * t), v = 0.03 * S - k * 0.03 * S + Math.sin(a) * L * t - 0.03 * S * t * t;
            let p = ns.world([u, v, 0]), n = ns.n;
            if (surf) { const q = surf.project(p); if (fin3(q) && dist(q, p) < 0.3) { p = q; n = surf.normal(q); } }
            pts.push(add(p, mul(n, off + 0.006 * S + 0.03 * S * t * t)));
            ups.push(n);
          }
          const geo = sweep(pts, { radius: (t) => { const rr = 0.011 * S * (1 - 0.55 * t); return [rr, rr]; }, up: (i) => ups[i], radial: 6, capSegs: 3 });
          addMesh(g, geo, ink.mat, 'whisker');
        }
      }
      root.add(g);
    }

    const trims = [];
    if (cyc) trims.push({ c: cyc.c.slice(0, 3), r: 1.3 * cyc.R });
    else for (const an of [A.eyeL, A.eyeR]) trims.push({ c: an.p.slice(0, 3), r: (eyeType === 'frog' ? 1.6 : eyeType === 'alien' ? 2.6 : 1.45) * r * Math.max(1, ghostScale * 0.9) });
    if (mouthSite) trims.push({ c: mouthSite.o.slice(0, 3), r: 0.2 * S });

    function setBlink(v) {
      const s = 1 - 0.92 * clamp(+v || 0, 0, 1);
      for (const e of eyes) if (e.open) e.blink.scale.y = s;
    }
    function setLook(dx, dy) {
      const x = clamp(+dx || 0, -1, 1), y = clamp(+dy || 0, -1, 1);
      for (const e of eyes) {
        if (!e.open) continue;
        const k = (e.k != null ? e.k : e.frog ? 0.22 : 0.1) * e.rr;
        e.look.position.set(x * k, y * k, 0);
      }
    }

    // A tear hanging from (u, v) of an eye's body site. It reaches below the patch fitted around
    // the eye, so it gets its own site, fitted where it hangs, and stays out of the blink group.
    function hangTear(es, hf, u, v, s, mat) {
      const mid = es.world([u, v - 0.5 * s, hf(u, v - 0.5 * s)[0]]);
      const ts = bodySite(surf, mid, es.n, 0.6 * s);
      const g = groupAt(ts);
      g.name = 'tear';
      root.add(g);
      buildTear(siteFrom([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], ts.hf), 0, 0.5 * s, s, off, g, mat, white(), addMesh);
    }

    /* the cyclops: one big eye */
    function buildCyclops() {
      const es = F.eyeSize > 0 ? +F.eyeSize : 0.15 * S;
      // eyeSize ~0.16 means a cyclops-sized eye; a two-eye size (forced cyclops) is doubled.
      const R = clamp(es >= 0.11 ? 1.2 * es : 2.2 * es, 0.2 * S, 0.55 * S);
      const nL = fin3(A.eyeL.n) ? A.eyeL.n : [0, 0, 1], nR = fin3(A.eyeR.n) ? A.eyeR.n : [0, 0, 1];
      const nAvg = norm(add(norm(nL), norm(nR)));
      const mid = mul(add(A.eyeL.p, A.eyeR.p), 0.5);
      let cp = [mid[0], mid[1] + 0.25 * S, mid[2]], hit = null;
      // Cast from the front like the anchors; where the raised point is above the head (eyes on top
      // bumps), come down until the cast lands on the face.
      for (const k of [0.25, 0.18, 0.11, 0.04, -0.06, -0.18, -0.3]) {
        hit = surf ? castFront(surf, mid[0], mid[1] + k * S, Math.max(A.eyeL.p[2], A.eyeR.p[2]) + 0.6) : null;
        if (hit) break;
      }
      if (hit) cp = hit;
      else if (!surf) {
        // No SDF: the midpoint of two surface points lies under the surface by about the sagitta.
        const ph = Math.acos(clamp(dot(norm(nL), norm(nR)), -1, 1)) / 2;
        if (ph > 1e-3) cp = add(cp, mul(nAvg, ((S / 2) / Math.sin(ph)) * (1 - Math.cos(ph))));
      }
      const bs = bodySite(surf, cp, nAvg, 1.1 * R);
      const holder = groupAt(bs);
      holder.name = 'eyeC';
      root.add(holder);
      const L = siteFrom([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], bs.hf);
      const ink = inkFor(bs.o, false);
      const blink = new THREE.Group(), look = new THREE.Group();
      holder.add(blink);
      blink.add(look);
      const lashMat = ink.mat, lashR = (t) => R * (0.06 - 0.034 * t), lz = off + 0.02 * R;
      const out = { c: bs.o.slice(0, 3), R };

      if (expr === 'happy' || expr === 'sleepy' || expr === 'wink') {
        // Closed: one arc; a wink is a closed arc with a playful tilt.
        const w = 0.95 * R, rs = 0.12 * R, sleepy = expr === 'sleepy';
        let arc = sampleCurve((t) => {
          const u = (t - 0.5) * 2 * w, x = u / w;
          return sleepy ? [u, -0.2 * R + 0.36 * R * x * x] : [u, 0.34 * R - 0.62 * R * x * x];
        }, 21);
        const ta = expr === 'wink' ? 0.22 : 0, tc = Math.cos(ta), ts = Math.sin(ta);
        const turn = (p) => [p[0] * tc - p[1] * ts, p[0] * ts + p[1] * tc];
        if (ta) arc = arc.map(turn);
        addMesh(look, stroke(L, arc, rs, off), ink.mat, 'eye-arc');
        if (lashesOn) {
          const n = arc.length;
          if (sleepy) {
            for (const [t, dx] of [[0.3, -0.38], [0.5, 0], [0.7, 0.38]]) lashAt(L, arc[Math.round(t * (n - 1))], [dx, -1], 0.27 * R, dx * 0.4, lashR, lz, lashMat, look, addMesh);
          } else {
            for (const sd of [-1, 1]) {
              const e0 = arc[sd > 0 ? n - 1 : 0], e1 = arc[sd > 0 ? Math.round(0.86 * (n - 1)) : Math.round(0.14 * (n - 1))];
              lashAt(L, e0, turn([sd, 0.5]), 0.3 * R, sd * 0.15, lashR, lz, lashMat, look, addMesh);
              lashAt(L, e1, turn([sd * 0.75, 0.95]), 0.27 * R, sd * 0.15, lashR, lz, lashMat, look, addMesh);
            }
          }
        }
        eyes.push({ blink, look, open: false, rr: R });
        return out;
      }

      // Open: white sclera dome (blinks), dark iris on it (drifts), shines on the iris.
      const big = expr === 'surprised' ? 1.1 : 1, ru = R * big, rv = 0.96 * R * big;
      const cool = expr === 'cool', cut = 0.1 * R;
      const sc = cool ? clipTop(ellipse(ru, rv, 64), cut, 60) : ellipse(ru, rv, 64);
      const sCen = cool ? [0, -0.42 * R] : [0, 0], Hs = 0.46 * R, pws = 0.5;
      addMesh(blink, dome(L, sc, sCen, Hs, off, { rings: 8, pow: pws }), white(), 'sclera');
      const D = onDome(L, sc, sCen, Hs, pws, off, cool ? null : [ru, rv]);
      const zi = 0.006 * R, Hi = 0.08 * R;
      let io, ic = [0, -0.03 * R], imat = ink.glow ? ink.mat : fm('pupil'), ri = 0.6 * R, shineMat = white();
      if (expr === 'hearts') {
        ic = [0, -0.06 * R];
        io = heart(1.24 * R, 56).map((p) => [p[0], p[1] - 0.02 * R]);
        if (!ink.glow) imat = am('enamel', contrastPick(['ff3f6e', 'ff6a8e', 'c8174a'], 'fbfaf6', 0.12));
        ri = 0.6 * R;
      } else if (expr === 'starry') {
        ic = [0, -0.02 * R];
        io = star(0.7 * R, 0.39 * R, 5, 60, Math.PI / 2).map((p) => [p[0], p[1] + ic[1]]);
        ri = 0.7 * R;
      } else {
        ri = (expr === 'surprised' ? 0.34 : expr === 'sparkle' || expr === 'teary' ? 0.64 : 0.6) * R;
        if (cool) ic = [0, -0.16 * R];
        io = ellipse(ri, ri * 1.02, 48, ic[0], ic[1]);
        if (cool) { io = clipTop(io, cut - 0.03 * R, 44); ic = [0, ic[1] - 0.2 * ri]; }
      }
      addMesh(look, dome(D, io, ic, Hi, zi, { rings: 5, pow: 0.5, skirt: 0.03 * R }), imat, 'iris');
      const ih = outlineHeight(io, ic, Hi, 0.5, expr === 'hearts' || expr === 'starry' || cool ? null : [ri, ri * 1.02]);
      const shine = (u, v, s) => addMesh(look, bead(D, u, v, zi + ih(u, v) - 0.1 * s, s, s, 0.42 * s, 12), shineMat, 'eye-shine');
      const [cx, cy] = ic;
      if (expr === 'hearts') shine(cx - 0.3 * ri, cy + 0.34 * ri, 0.085 * R);
      else if (expr === 'starry') { shine(cx - 0.24 * ri, cy + 0.2 * ri, 0.1 * R); shine(cx + 0.2 * ri, cy - 0.2 * ri, 0.045 * R); }
      else if (expr === 'surprised') shine(cx - 0.32 * ri, cy + 0.34 * ri, 0.1 * R);
      else if (cool) shine(cx - 0.34 * ri, cy + 0.1 * ri, 0.11 * R);
      else if (expr === 'sparkle') {
        shine(cx - 0.32 * ri, cy + 0.36 * ri, 0.22 * R);
        const s = 0.17 * R, tu = cx + 0.36 * ri, tv = cy - 0.32 * ri, zb = zi + ih(tu, tv) - 0.05 * s;
        addMesh(look, dome(D, star(s, s * 0.32, 4, 40, Math.PI / 2).map((p) => [p[0] + tu, p[1] + tv]), [tu, tv], 0.18 * s, zb, { rings: 3, skirt: 0.2 * s }), shineMat, 'eye-twinkle');
      } else if (expr === 'teary') {
        shine(cx - 0.3 * ri, cy + 0.36 * ri, 0.25 * R);
        shine(cx + 0.38 * ri, cy - 0.06 * ri, 0.11 * R);
        shine(cx - 0.08 * ri, cy - 0.5 * ri, 0.055 * R);
        // Tears welling along the lower rim of the eyeball, spilling into one tear on the right.
        const wl = welling(sc, sCen, 1, 0.42 * R), tm = ink.glow ? ink.mat : am('enamel', tearHex(ink.bg || body));
        addMesh(blink, stroke(L, wl.pts, (t) => R * (0.016 + 0.034 * Math.sin(Math.PI * (0.1 + 0.8 * t))), off, { sink: 0.25 }), tm, 'tear-well');
        hangTear(bs, bs.hf, wl.tear.u, wl.tear.v, wl.tear.s, tm);
      } else {
        shine(cx - 0.32 * ri, cy + 0.36 * ri, 0.2 * R);
        shine(cx + 0.34 * ri, cy - 0.34 * ri, 0.08 * R);
      }
      if (cool) {
        const lw = 1.06 * ru, lid = sampleCurve((t) => { const u = (t - 0.5) * 2 * lw, x = u / lw; return [u, cut + 0.04 * R - 0.09 * R * x * x]; }, 17);
        addMesh(blink, stroke(L, lid, 0.1 * R, off + Hs * 0.12), ink.mat, 'eye-lid');
        if (lashesOn) for (const sd of [-1, 1]) {
          const e = lid[sd > 0 ? lid.length - 1 : 0];
          lashAt(L, e, [sd, 0.35], 0.28 * R, sd * 0.12, lashR, lz, lashMat, blink, addMesh);
          lashAt(L, [e[0] - sd * 0.16 * R, e[1] + 0.02 * R], [sd * 0.6, 0.9], 0.25 * R, sd * 0.12, lashR, lz, lashMat, blink, addMesh);
        }
      } else if (lashesOn) {
        // A short row along the top of the eyeball, curling away from the middle.
        for (const deg of [44, 67, 90, 113, 136]) {
          const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
          const p = [ru * ca * 0.95, rv * sa * 0.95], dir = [ca / ru, sa / rv];
          const Lh = (deg === 90 ? 0.3 : deg === 67 || deg === 113 ? 0.29 : 0.27) * R;
          lashAt(L, p, dir, Lh, ca > 0.05 ? 0.3 : ca < -0.05 ? -0.3 : 0, lashR, lz + Hs * 0.1, lashMat, blink, addMesh);
        }
      }
      eyes.push({ blink, look, open: true, rr: R, k: 0.1 });
      return out;
    }
    function dispose() { for (const g of geos) g.dispose(); geos.length = 0; }
    root.userData.dispose = dispose;
    return { group: root, setBlink, setLook, dispose, trims };
  }

  /* ---------- eyes ---------- */

  // Returns {open, rim:{ru, rv, cv} | null, arc: [[u,v]...] | null, outline?, tear?: {u, v, s}}.
  function buildEye(site, kind, side, r, ink, z0, eyeType, parent, addMesh, white, fm, am, S) {
    if (eyeType === 'alien') return buildAlienEye(site, kind, side, r, ink, z0, parent, addMesh, white, fm, am, S);
    const gs = eyeType === 'ghost' ? 1.45 : 1;
    const robot = eyeType === 'robot', frog = eyeType === 'frog';
    const Hk = frog ? 0.22 : 1;
    // Light eyes (very dark bodies) get shines in the background tone so they still read.
    const shine = () => (ink.light ? fm('pupil') : white());
    const hl = (u, v, s, ru, rv, H, pw) => addMesh(parent, bead(site, u, v, z0 + domeH(u, v, ru, rv, H, pw) - 0.12 * s, s, s, s * 0.42, 12), shine(), 'eye-shine');
    const twinkle = (u, v, s, ru, rv, H) => {
      const zb = z0 + domeH(u, v, ru, rv, H) - 0.05 * s;
      addMesh(parent, dome(site, star(s, s * 0.32, 4, 40, Math.PI / 2).map((p) => [p[0] + u, p[1] + v]), [u, v], 0.18 * s, zb, { rings: 3, skirt: 0.2 * s }), shine(), 'eye-twinkle');
    };
    if (kind === 'happy' || kind === 'sleepy') {
      const w = 1.05 * r, rs = (robot ? 0.3 : 0.27) * r;
      const arc = kind === 'happy'
        ? sampleCurve((t) => { const u = (t - 0.5) * 2 * w, x = u / w; return [u, 0.48 * r - 0.74 * r * x * x]; }, 17)
        : sampleCurve((t) => { const u = (t - 0.5) * 2 * w, x = u / w; return [u, -0.3 * r + 0.42 * r * x * x]; }, 17);
      addMesh(parent, stroke(site, arc, rs, z0), ink.mat, 'eye-arc');
      return { open: false, rim: null, arc, kind };
    }
    let ru, rv, outline, H, cv = 0;
    if (kind === 'hearts') {
      const w = 2.5 * r;
      outline = heart(w, 56);
      ru = 1.25 * r; rv = 1.12 * r; H = 0.42 * r * Hk;
      const col = ink.glow ? null : contrastPick(['ff3f6e', 'ff6a8e', 'c8174a'], ink.bg || 'ffffff', 0.12);
      addMesh(parent, dome(site, outline, [0, -0.05 * r], H, z0, { rings: 6, pow: 0.5 }), ink.glow ? ink.mat : am('enamel', col), 'eye');
      hl(-0.48 * ru, 0.36 * rv, 0.16 * r, ru, rv, H);
      return { open: true, rim: { ru, rv, cv: 0 }, kind };
    }
    if (kind === 'cool') {
      ru = 1.08 * r; rv = 1.02 * r * (gs > 1 ? 1.2 : 1);
      const cut = 0.14 * r;
      outline = robot ? clipTop(roundRect(1.7 * r, 2.2 * r, 0.8 * r, 64), cut, 48) : clipTop(ellipse(ru, rv, 64), cut, 48);
      H = 0.4 * r * Hk;
      addMesh(parent, dome(site, outline, [0, -0.42 * r], H, z0, { rings: 5, pow: 0.5 }), ink.mat, 'eye');
      const lw = 1.35 * r, lid = sampleCurve((t) => { const u = (t - 0.5) * 2 * lw, x = u / lw; return [u, cut + 0.05 * r - 0.1 * r * x * x + 0.04 * r * side * x]; }, 13);
      addMesh(parent, stroke(site, lid, 0.2 * r, z0 + H * 0.15), ink.mat, 'eye-lid');
      return { open: true, rim: { ru, rv: cut + 0.1 * r, cv: 0 }, lid, kind };
    }
    if (kind === 'starry') {
      const rO = 1.42 * r;
      outline = starEye(site, rO, gs > 1 ? 1.22 : 1, 0.5 * r * Hk, z0, ink, side, frog, parent, addMesh, white, am, shine);
      return { open: true, rim: { ru: rO, rv: rO * (gs > 1 ? 1.22 : 1), cv: 0 }, outline, kind };
    }
    if (kind === 'teary') {
      // Big and glossy with large shines; the caller adds the welling band and the tear (info.well).
      ru = 1.3 * r; rv = 1.36 * r * gs; H = 0.56 * r * Hk;
      if (robot) {
        const w = 1.9 * r, h = 2.55 * r;
        outline = roundRect(w, h, w * 0.5, 56);
        ru = w / 2; rv = h / 2;
      } else {
        outline = ellipse(ru, rv, 48);
      }
      addMesh(parent, dome(site, outline, [0, 0], H, z0, { rings: 6, pow: 0.55 }), ink.mat, 'eye');
      hl(-0.32 * ru, 0.36 * rv, 0.36 * r, ru, rv, H);
      hl(0.36 * ru, -0.1 * rv, 0.17 * r, ru, rv, H);
      hl(-0.12 * ru, -0.52 * rv, 0.08 * r, ru, rv, H);
      return { open: true, rim: { ru, rv, cv: 0 }, outline, kind, well: welling(outline, [0, 0], side, r) };
    }
    // Round family: dot, surprised, sparkle.
    const size = kind === 'surprised' ? [1.26, 1.32] : kind === 'sparkle' ? [1.32, 1.42] : [1, 1.06];
    ru = size[0] * r; rv = size[1] * r * gs;
    H = (kind === 'dot' ? 0.5 : 0.55) * r * Hk;
    if (robot) {
      const w = kind === 'dot' ? 1.5 * r : 1.85 * r, h = kind === 'dot' ? 2.3 * r : 2.5 * r;
      outline = roundRect(w, h, w * 0.5, 56);
      ru = w / 2; rv = h / 2;
    } else {
      outline = ellipse(ru, rv, 48);
    }
    addMesh(parent, dome(site, outline, [0, cv], H, z0, { rings: 6, pow: 0.55 }), ink.mat, 'eye');
    if (kind === 'surprised') {
      hl(-0.36 * ru, 0.4 * rv, 0.27 * r, ru, rv, H);
      hl(0.32 * ru, -0.38 * rv, 0.12 * r, ru, rv, H);
    } else if (kind === 'sparkle') {
      hl(-0.33 * ru, 0.36 * rv, 0.37 * r, ru, rv, H);
      twinkle(0.3 * ru, -0.32 * rv, 0.3 * r, ru, rv, H);
    }
    return { open: true, rim: { ru, rv, cv }, kind };
  }

  // A puffy five-point star eye (leaning a little outward) with two shines; returns its outline.
  // Gold where gold stands out; on an eyeball's white (onWhite) or a glow it uses the eye ink.
  function starEye(site, rO, vScale, H, z0, ink, side, onWhite, parent, addMesh, white, am, shine) {
    let outline = star(rO, 0.56 * rO, 5, 60, Math.PI / 2 - side * 0.1);
    if (vScale !== 1) outline = outline.map((p) => [p[0], p[1] * vScale]);
    const gold = ink.glow || onWhite ? null : starGold(ink.bg || 'ffffff');
    addMesh(parent, dome(site, outline, [0, 0], H, z0, { rings: 6, pow: 0.5 }), gold ? am('enamel', gold) : ink.mat, 'eye');
    const hz = outlineHeight(outline, [0, 0], H, 0.5), sh = gold ? white() : shine();
    const put = (u, v, s) => addMesh(parent, bead(site, u, v, z0 + hz(u, v) - 0.12 * s, s, s, 0.42 * s, 12), sh, 'eye-shine');
    put(-0.25 * rO, 0.2 * rO * vScale, 0.15 * rO);
    put(0.2 * rO, -0.2 * rO * vScale, 0.065 * rO);
    return outline;
  }

  // Alien eyes: big egg-shaped almonds, dark and glossy with two shines. The caller turns the
  // frame (outer corner up), so everything here is drawn level, the round end at u = side * a.
  function buildAlienEye(site, kind, side, r, ink, z0, parent, addMesh, white, fm, am, S) {
    const shine = () => (ink.light ? fm('pupil') : white());
    // Long, but the inner corners keep a gap of about a quarter of the eye spacing.
    const a0 = Math.min(2.2 * r, 0.38 * (S || 5 * r)), b0 = 0.6 * a0;
    r = a0 / 2.2;   // every other size below follows the (possibly capped) almond
    if (kind === 'happy' || kind === 'sleepy') {
      const w = 0.9 * a0, rs = 0.3 * r;
      const arc = kind === 'happy'
        ? sampleCurve((t) => { const u = (t - 0.5) * 2 * w, x = u / w; return [u, 0.48 * b0 - 0.82 * b0 * x * x]; }, 19)
        : sampleCurve((t) => { const u = (t - 0.5) * 2 * w, x = u / w; return [u, -0.3 * b0 + 0.48 * b0 * x * x]; }, 19);
      addMesh(parent, stroke(site, arc, rs, z0), ink.mat, 'eye-arc');
      return { open: false, rim: null, arc, kind };
    }
    if (kind === 'hearts') {
      const outline = heart(3.0 * r, 56), cen = [0, -0.05 * r], H = 0.46 * r;
      const col = ink.glow ? null : contrastPick(['ff3f6e', 'ff6a8e', 'c8174a'], ink.bg || 'ffffff', 0.12);
      addMesh(parent, dome(site, outline, cen, H, z0, { rings: 6, pow: 0.5 }), ink.glow ? ink.mat : am('enamel', col), 'eye');
      const hz = outlineHeight(outline, cen, H, 0.5), u = -0.68 * r, v = 0.46 * r, s = 0.2 * r;
      addMesh(parent, bead(site, u, v, z0 + hz(u, v) - 0.12 * s, s, s, s * 0.42, 12), shine(), 'eye-shine');
      return { open: true, rim: { ru: 1.5 * r, rv: 1.33 * r, cv: 0 }, outline, kind };
    }
    if (kind === 'starry') {
      const outline = starEye(site, 1.8 * r, 1, 0.5 * r, z0, ink, side, false, parent, addMesh, white, am, shine);
      return { open: true, rim: { ru: 1.8 * r, rv: 1.8 * r, cv: 0 }, outline, kind };
    }
    // The almond family: dot, sparkle, surprised (bigger), teary, cool (half lid).
    const k = kind === 'surprised' ? 1.16 : kind === 'teary' ? 1.08 : kind === 'sparkle' ? 1.05 : 1;
    const a = a0 * k, b = b0 * k, cool = kind === 'cool', cut = 0.14 * b;
    const outline = cool ? clipTop(almond(a, b, side, 64), cut, 56) : almond(a, b, side, 64);
    const cen = cool ? [0, -0.45 * b] : [0, 0], H = (cool ? 0.42 : 0.5) * r;
    addMesh(parent, dome(site, outline, cen, H, z0, { rings: 6, pow: 0.55 }), ink.mat, 'eye');
    const hz = outlineHeight(outline, cen, H, 0.55);
    const put = (u, v, s) => addMesh(parent, bead(site, u, v, z0 + hz(u, v) - 0.12 * s, s, s, s * 0.42, 12), shine(), 'eye-shine');
    if (cool) {
      const lw = 1.04 * a * Math.sqrt(Math.max(0, 1 - (cut / b) * (cut / b)));
      const lid = sampleCurve((t) => { const u = (t - 0.5) * 2 * lw, x = u / lw; return [u, cut + 0.05 * r - 0.1 * r * x * x]; }, 15);
      addMesh(parent, stroke(site, lid, 0.2 * r, z0 + H * 0.15), ink.mat, 'eye-lid');
      put(side * 0.3 * a, -0.2 * b, 0.2 * r);
      return { open: true, rim: null, lid, kind, outline, cen };
    }
    // Shines mirror between the eyes: a big one high on the round outer end, a small one low inside.
    const big = kind === 'surprised' ? 0.24 : kind === 'teary' ? 0.4 : kind === 'sparkle' ? 0.36 : 0.32;
    put(side * 0.3 * a, 0.36 * b, big * r);
    if (kind === 'sparkle') {
      const s = 0.3 * r, u = -side * 0.34 * a, v = -0.3 * b, zb = z0 + hz(u, v) - 0.05 * s;
      addMesh(parent, dome(site, star(s, s * 0.32, 4, 40, Math.PI / 2).map((p) => [p[0] + u, p[1] + v]), [u, v], 0.18 * s, zb, { rings: 3, skirt: 0.2 * s }), shine(), 'eye-twinkle');
    } else {
      put(-side * 0.34 * a, -0.3 * b, (kind === 'teary' ? 0.18 : kind === 'surprised' ? 0.1 : 0.13) * r);
    }
    return { open: true, rim: null, kind, outline, cen, well: kind === 'teary' ? welling(outline, [0, 0], side, r) : null };
  }

  function buildLashes(site, kind, side, r, info, ink, z0, parent, addMesh) {
    const lashR = (t) => r * (0.115 - 0.06 * t);
    const lash = (start, dir, L, bend) => {
      const d = norm([dir[0], dir[1], 0]), perp = [d[1] * side, -d[0] * side, 0];
      const a = [start[0], start[1]], c = [start[0] + d[0] * L + perp[0] * bend * L, start[1] + d[1] * L + perp[1] * bend * L];
      const b = [start[0] + d[0] * L * 0.55, start[1] + d[1] * L * 0.55];
      addMesh(parent, stroke(site, bez2(a, b, c, 7), lashR, z0 + 0.02 * r, { sink: 0.3, radial: 7 }), ink.mat, 'lash');
    };
    if (!info.open && info.arc) {
      const arc = info.arc, n = arc.length;
      const at = (s) => { const t = side > 0 ? s : 1 - s; return arc[Math.round(t * (n - 1))]; };
      if (info.kind === 'happy') {
        lash(at(1), [side, 0.5], 0.42 * r, 0.15);
        lash(at(0.86), [side * 0.75, 0.95], 0.38 * r, 0.15);
      } else {
        lash(at(0.62), [side * 0.3, -1], 0.36 * r, 0.12);
        lash(at(0.86), [side * 0.75, -0.8], 0.38 * r, 0.12);
      }
      return;
    }
    if (info.kind === 'cool' && info.lid) {
      const lid = info.lid, e = side > 0 ? lid[lid.length - 1] : lid[0];
      lash(e, [side, 0.35], 0.4 * r, 0.12);
      lash([e[0] - side * 0.22 * r, e[1] + 0.03 * r], [side * 0.6, 0.9], 0.36 * r, 0.12);
      return;
    }
    if (info.kind === 'starry' && info.outline) {
      // Two lashes fanning out of the notch between the top arm and the outer arm.
      for (const a of [0.66, 0.98]) {
        const ph = Math.atan2(Math.sin(a), side * Math.cos(a)), R0 = 0.94 * polyRadius(info.outline, [0, 0], ph);
        let d = [Math.cos(ph), Math.sin(ph)];
        const k = -side * 0.18, cs = Math.cos(k), sn = Math.sin(k);
        d = [d[0] * cs - d[1] * sn, d[0] * sn + d[1] * cs];
        lash([R0 * Math.cos(ph), R0 * Math.sin(ph)], d, (a > 0.8 ? 0.4 : 0.44) * r, 0.18);
      }
      return;
    }
    const rim = info.rim || { ru: r, rv: r, cv: 0 };
    const angs = info.kind === 'hearts' ? [0.75, 1.15] : [0.42, 0.85, 1.25];
    for (const a of angs) {
      const ca = Math.cos(a), sa = Math.sin(a);
      const p = [side * rim.ru * ca * 0.94, rim.cv + rim.rv * sa * 0.94];
      let d = norm([side * ca / rim.ru, sa / rim.rv, 0]);
      const k = -side * 0.22, cs = Math.cos(k), sn = Math.sin(k);
      d = [d[0] * cs - d[1] * sn, d[0] * sn + d[1] * cs, 0];
      lash(p, d, (a > 1.1 ? 0.4 : 0.48) * r, 0.18);
    }
  }

  return { build };
}
