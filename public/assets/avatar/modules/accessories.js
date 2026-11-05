/* Dot avatar studio: accessories (28 hats, 10 glasses, 16 extras).
 *
 * export const SLOTS = {hat: [...], glasses: [...], extra: [...]}   (catalog ids minus 'none')
 * createAccessories(THREE, mats) -> {
 *   build(slot, id, anchors, ctx) -> THREE.Group | null
 *     ctx {hex, soft, furLength, finishId, transmissive, faceMeta?, eyeC?, sdf?}
 *     faceMeta = shape.face (sdf.js): eye size for the eye top, and eyes 'cyclops' (one eye).
 *     eyeC = {p, r, n?}: the built cyclops eye (face.js group 'eyeC') in content space; wins
 *     over faceMeta. Both optional: without them a cyclops is fitted like a two-eyed face.
 *     sdf = shape.sdf (x, y, z): optional; head bands use it only to come out from under a cap
 *     that hangs far past the head sections (the mushroom), see headBand.
 *   occluders(slot, id, anchors) -> [{c:[x,y,z], r}]      spheres for fur trimming and contact shade
 * }
 * Every item is procedural three geometry (Lathe, Torus, Sphere, Capsule, Extrude, swept tubes,
 * deformed spheres, thin "slab" sheets) placed only from the Anchors contract, so it fits any shape.
 * The returned group carries userData {slot, id, dispose(), update(t, motion01)?}; parts that should
 * not cast shadows (lenses, glows) carry userData.noShadow.
 * Moving parts (ninja tails, nightcap, boppers, grad tassel, propeller, cape, wings, sprout, halo)
 * move only through update(t, motion01) and sit exactly in their built pose when motion01 is 0
 * (the propeller keeps its last angle: it spins by motion, it does not snap back).
 * Material kinds: the round-1 set plus 'leather' (eye patch, goggle cups and strap), 'terry'
 * (sweatband) and 'feather' (wings: one mesh per feather, its shaft on the geometry's own y axis at
 * x = 0, built at final size because the barb pattern is drawn in object space).
 *
 * This module imports nothing; three and the material factory are injected.
 *
 * THINGS THAT ARE EASY TO GET WRONG, handled below:
 *  1. Hats fit the head above anchors.hat as an ellipsoid dome: radii (rx, H, rz) around hat.c, H up
 *     to anchors.top. Fur inflates that dome by furLength (the hat is raised and widened by it).
 *     Rings between ears can be tiny or very thin (pill ridge), so the dome is widened to at least
 *     0.2 x body width with an x:z ratio of at most 1.45, and small hats and ornaments are sized
 *     by a head scale hs = max(ring radius, 0.22 x body width) rather than by the ring alone.
 *     Ring hats (beanie, cap, wizard, bucket, cowboy, sun hat, pirate, detective, witch, nightcap,
 *     viking, grad, propeller) and head bands (ninja, sweatband) are built in a frame scaled to the
 *     ring's ellipse; small hats (top hat, crown, chef, beret, party, pillbox, moon) are circular and
 *     "perched": their base ring is lowered along the dome normal until it touches the dome.
 *  2. Shells keep clear of the dome: their radius never drops below the dome's radius at that height.
 *     The dome normally stops at anchors.headTop, under thin antennas, stalks, buds and tufts (robot,
 *     sprout, cactus, strawberry: they come through the hat). On a narrow tip (star, drop) the
 *     head-top rays land beside it, so the dome reaches the top point; a pointed top (diamond,
 *     hexagon, triangle) rises a little above headTop, and the dome reaches to just under it.
 *  3. Glasses sit in a plane in front of the eyes (clearing the biggest eye domes and the fur), each
 *     lens turned a little toward its eye; the temples follow the head ellipse through brow and sides.
 *     A cyclops gets one lens of the chosen style, centred on and sized to its eye, no bridge; temples
 *     and straps stay (eye patch and goggles: one patch or cup on a strap at the eye's height).
 *     Straps that go all the way round (goggles, eye patch) and head bands follow headSec(): the
 *     eye-level section (a superellipse when the face is flat, as on the robot) shrinking toward the
 *     hat ring, upright at the sides of thin cookie-like heads, and a dome above a low ring.
 *  4. Neck items wrap the neck ring (inflated by fur); hanging parts never reach the ground.
 *  5. Colors keep an OKLab distance of at least 0.12 from the body; otherwise the alternate color, and
 *     if that also fails, the default pushed in lightness until it passes. Gold falls back to silver.
 *  6. Materials come only from mats.accessory (cached there): never mutate or dispose them.
 *  7. Winding is outward everywhere (signed volume checked in tests); materials stay FrontSide.
 *  8. Bands over the head (headphones, headset, cat headphones, cat ears, boppers) pass IN FRONT of
 *     whatever stands above the head top (ears, horns, antennas, tufts: the bounding box rises above
 *     anchors.headTop) and BEHIND eyes that sit on top bumps (frog), and are pushed out of the dome.
 *     Forehead bands (ninja, sweatband) sit above the eye top (faceMeta.eyeSize, or the cyclops eye).
 *  9. Hair clips sit on the dome of domed heads; on flat-topped heads (gem, cushion, robot, heads with
 *     the ring between the ears) the dome point is the top, so they go to the side of the head; with
 *     eyes on top bumps (frog) they stand between the bumps.
 * 10. Soft motion (nightcap, cape, ninja tails) rebuilds vertices from a rest copy (bender), so angle 0
 *     is exact. Hats that would swing into ears (nightcap, propeller blades) fold or rest clear of them.
 */

export const SLOTS = {
  hat: ['beanie', 'cap', 'tophat', 'crown', 'tiara', 'wizard', 'beret', 'party', 'chef', 'bucket', 'cowboy', 'sunhat', 'flowers', 'halo', 'bow',
    'pillbox', 'pirate', 'detective', 'ninja', 'witch', 'nightcap', 'sweatband', 'boppers', 'moon', 'viking', 'catears', 'grad', 'propeller'],
  glasses: ['round', 'square', 'sunnies', 'hearts', 'stars', 'monocle', 'visor', 'eyepatch', 'cateye', 'goggles'],
  extra: ['bowtie', 'scarf', 'headphones', 'pearls', 'bandana', 'bell', 'backpack', 'flower', 'sprout',
    'headset', 'catphones', 'heartclip', 'cape', 'wings', 'necktie', 'medal']
};

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smax = (a, b, k) => (a + b + Math.sqrt((a - b) * (a - b) + k * k)) / 2;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 1, 0]; };
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const fin3 = (p) => Array.isArray(p) && p.length >= 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]);
const perpTo = (v, n) => norm(sub(v, mul(n, dot(v, n))));

/* ---------- color (OKLab, Ottosson's published matrices) ---------- */

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
function contrastPick(cands, bg, min) {
  min = min || 0.12;
  const list = cands.map(hexNorm).filter(Boolean);
  for (const c of list) if (labDist(c, bg) >= min) return c;
  const c0 = lab(list[0] || '808080'), b = lab(bg);
  for (const d of (c0[0] >= b[0] ? [1, -1] : [-1, 1])) {
    for (let k = 1; k <= 18; k++) {
      const L = c0[0] + d * 0.04 * k;
      if (L < 0.08 || L > 0.98) break;
      const hx = labHex(L, c0[1], c0[2]);
      if (labDist(hx, bg) >= min) return hx;
    }
  }
  return b[0] > 0.6 ? '23222a' : 'f6f3ee';
}
const shade = (hex, dL, dC) => { const c = lab(hex); const k = 1 + (dC || 0); return labHex(clamp(c[0] + dL, 0.05, 0.98), c[1] * k, c[2] * k); };

/* ---------- 2D outlines ---------- */

function area2(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
const ccw = (p) => (area2(p) < 0 ? p.slice().reverse() : p);
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
function chaikin(pts, it) {
  let p = pts;
  for (let k = 0; k < it; k++) {
    const o = [];
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); }
    p = o;
  }
  return p;
}
const ellipse2 = (rx, ry, n) => { const o = []; for (let i = 0; i < n; i++) { const a = (i / n) * TAU; o.push([rx * Math.cos(a), ry * Math.sin(a)]); } return o; };
function heart2(w, n) {
  const raw = [];
  for (let i = 0; i < 96; i++) { const t = (i / 96) * TAU, s = Math.sin(t); raw.push([16 * s * s * s, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)]); }
  const k = w / 32;
  return ccw(resample(raw.map((p) => [p[0] * k, (p[1] + 2.6) * k]), n));
}
function star2(rO, rI, k, n, round) {
  const raw = [];
  for (let i = 0; i < k * 2; i++) { const a = Math.PI / 2 + (i / (k * 2)) * TAU, r = i % 2 ? rI : rO; raw.push([r * Math.cos(a), r * Math.sin(a)]); }
  return ccw(resample(chaikin(raw, round == null ? 2 : round), n));
}
function rrect2(w, h, rad, n) {
  rad = Math.min(rad, w / 2, h / 2);
  const raw = [], q = 8, cx = w / 2 - rad, cy = h / 2 - rad;
  for (const c of [[cx, cy, 0], [-cx, cy, 0.5], [-cx, -cy, 1], [cx, -cy, 1.5]]) for (let i = 0; i <= q; i++) { const a = (c[2] + (i / q) * 0.5) * Math.PI; raw.push([c[0] + rad * Math.cos(a), c[1] + rad * Math.sin(a)]); }
  return ccw(resample(raw, n));
}
const scale2 = (pts, sx, sy, cx, cy) => pts.map((p) => [(cx || 0) + (p[0] - (cx || 0)) * sx, (cy || 0) + (p[1] - (cy || 0)) * (sy == null ? sx : sy)]);
const bbox2 = (pts) => { let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 }; };
// Closed rounded-rectangle loop in (r, y), counterclockwise, starting mid-bottom (for LatheGeometry).
function rrLoop(r0, r1, y0, y1, rc, q) {
  rc = Math.max(1e-5, Math.min(rc, (r1 - r0) / 2 - 1e-5, (y1 - y0) / 2 - 1e-5));
  const pts = [[(r0 + r1) / 2, y0]];
  const corner = (cx, cy, a0) => { for (let i = 0; i <= q; i++) { const a = a0 + (i / q) * (Math.PI / 2); pts.push([cx + rc * Math.cos(a), cy + rc * Math.sin(a)]); } };
  corner(r1 - rc, y0 + rc, -Math.PI / 2);
  corner(r1 - rc, y1 - rc, 0);
  corner(r0 + rc, y1 - rc, Math.PI / 2);
  corner(r0 + rc, y0 + rc, Math.PI);
  pts.push([(r0 + r1) / 2, y0]);
  return pts;
}
// Insert points so no profile segment is longer than maxSeg (for smooth bending).
function subdiv(pts, maxSeg) {
  const o = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxSeg));
    for (let k = 1; k <= n; k++) o.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]);
  }
  return o;
}

/* ---------- the factory ---------- */

export function createAccessories(THREE, mats) {
  if (!THREE || !mats) throw new Error('createAccessories needs THREE and mats');
  const M4 = new THREE.Matrix4();
  const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

  /* ---- geometry helpers ---- */

  function makeGeo(pos, idx) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  // Average normals of vertices that share a position (lathe seams, sphere poles after deformation).
  // Grids from LatheGeometry / SphereGeometry: duplicates are the first/last column and the pole rows.
  function weldGrid(g, cols, rows, colMajor) {
    const n = g.attributes.normal.array, p = g.attributes.position.array;
    const id = colMajor ? (c, r) => c * rows + r : (c, r) => r * cols + c;
    const avg = (list) => {
      let x = 0, y = 0, z = 0;
      for (const v of list) { x += n[v * 3]; y += n[v * 3 + 1]; z += n[v * 3 + 2]; }
      const l = Math.hypot(x, y, z) || 1;
      for (const v of list) { n[v * 3] = x / l; n[v * 3 + 1] = y / l; n[v * 3 + 2] = z / l; }
    };
    for (let r = 0; r < rows; r++) {
      const a = id(0, r), b = id(cols - 1, r);
      const same = Math.abs(p[a * 3] - p[b * 3]) + Math.abs(p[a * 3 + 1] - p[b * 3 + 1]) + Math.abs(p[a * 3 + 2] - p[b * 3 + 2]) < 1e-6;
      let pole = true;
      for (let c = 1; c < cols && pole; c++) { const v = id(c, r); pole = Math.abs(p[v * 3] - p[a * 3]) + Math.abs(p[v * 3 + 1] - p[a * 3 + 1]) + Math.abs(p[v * 3 + 2] - p[a * 3 + 2]) < 1e-6; }
      if (pole) { const all = []; for (let c = 0; c < cols; c++) all.push(id(c, r)); avg(all); } else if (same) avg([a, b]);
    }
    g.attributes.normal.needsUpdate = true;
    return g;
  }
  function weld(g) {
    const p = g.attributes.position.array, n = g.attributes.normal.array, map = new Map();
    for (let i = 0; i < p.length; i += 3) {
      const k = (Math.round(p[i] * 2e4) * 73856093) ^ (Math.round(p[i + 1] * 2e4) * 19349663) ^ (Math.round(p[i + 2] * 2e4) * 83492791);
      const e = map.get(k);
      if (e) { if (Math.abs(p[e[0]] - p[i]) + Math.abs(p[e[0] + 1] - p[i + 1]) + Math.abs(p[e[0] + 2] - p[i + 2]) < 1e-4) e.push(i); } else map.set(k, [i]);
    }
    for (const e of map.values()) {
      if (e.length < 2) continue;
      let x = 0, y = 0, z = 0;
      for (const i of e) { x += n[i]; y += n[i + 1]; z += n[i + 2]; }
      const l = Math.hypot(x, y, z) || 1;
      for (const i of e) { n[i] = x / l; n[i + 1] = y / l; n[i + 2] = z / l; }
    }
    g.attributes.normal.needsUpdate = true;
    return g;
  }
  function deform(g, fn) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) { const q = fn(p[i], p[i + 1], p[i + 2]); p[i] = q[0]; p[i + 1] = q[1]; p[i + 2] = q[2]; }
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();
    const pr = g.parameters || {};
    if (g.type === 'LatheGeometry') return weldGrid(g, pr.segments + 1, pr.points.length, true);
    if (g.type === 'SphereGeometry') return weldGrid(g, pr.widthSegments + 1, pr.heightSegments + 1, false);
    return weld(g);
  }
  // Closed meshes from parametric grids: flip the winding if the signed volume came out negative.
  function orient(g) {
    const p = g.attributes.position.array, ix = g.index.array;
    let v = 0;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    if (v < 0) {
      for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
      g.index.needsUpdate = true;
      g.computeVertexNormals();
    }
    return g;
  }
  function fixNormals(g, fallback) {
    const n = g.attributes.normal.array, p = g.attributes.position.array;
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]);
      if (l > 1e-6) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { const f = fallback(p[i], p[i + 1], p[i + 2]); n[i] = f[0]; n[i + 1] = f[1]; n[i + 2] = f[2]; }
    }
    g.attributes.normal.needsUpdate = true;
    return g;
  }
  function lathe(prof, segs, disp) {
    const pts = [];
    for (const q of prof) { const v = new THREE.Vector2(Math.max(0, q[0]), q[1]); if (!pts.length || v.distanceTo(pts[pts.length - 1]) > 1e-7) pts.push(v); }
    const g = new THREE.LatheGeometry(pts, segs);
    if (disp) deform(g, disp);
    else fixNormals(g, (x, y) => [0, y >= 0 ? 1 : -1, 0]);
    return g;
  }
  function sphere(rx, ry, rz, ws, hs) { const g = new THREE.SphereGeometry(1, ws || 20, hs || 14); g.scale(rx, ry == null ? rx : ry, rz == null ? rx : rz); return g; }
  // Place a geometry with a basis (x, y, z axes) and origin.
  function put(g, origin, x, y, z) { M4.makeBasis(V3(x), V3(y), V3(z)).setPosition(origin[0], origin[1], origin[2]); g.applyMatrix4(M4); return g; }
  function merge(list) {
    list = list.filter(Boolean);
    if (list.length === 1) return list[0];
    let nv = 0, ni = 0;
    for (const g of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = nv < 65535 ? new Uint16Array(ni) : new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const g of list) {
      const c = g.attributes.position.count;
      pos.set(g.attributes.position.array, vo * 3);
      nor.set(g.attributes.normal.array, vo * 3);
      if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i++) idx[io++] = a[i] + vo; } else for (let i = 0; i < c; i++) idx[io++] = vo + i;
      vo += c;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }
  // Tube along a polyline, optional rounded caps; radius(t) -> number | [across(B), along up(N)].
  // up(i) orients N; segMat(q) assigns a material index per segment (geometry groups).
  function sweep(pts, o) {
    const n = pts.length, R = o.radial || 12, closed = !!o.closed, caps = !closed && o.caps !== false, cs = o.capSegs || 4;
    const radAt = (t) => { const r = typeof o.radius === 'function' ? o.radius(t) : o.radius; return Array.isArray(r) ? r : [r, r]; };
    const T = [], Nn = [], Bn = [];
    for (let i = 0; i < n; i++) {
      const a = closed ? pts[(i - 1 + n) % n] : pts[Math.max(i - 1, 0)], b = closed ? pts[(i + 1) % n] : pts[Math.min(i + 1, n - 1)];
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
      for (let j = 0; j < R; j++) { const a = (j / R) * TAU, ca = Math.cos(a) * rb, sa = Math.sin(a) * rn; pos.push(c[0] + B[0] * ca + N[0] * sa, c[1] + B[1] * ca + N[1] * sa, c[2] + B[2] * ca + N[2] * sa); }
    };
    const pole = (p) => { rings.push({ s: pos.length / 3, n: 1 }); pos.push(p[0], p[1], p[2]); };
    let capRings = 0;
    const capL = (k, rb, rn) => (o.capLen == null ? (rb + rn) / 2 : Array.isArray(o.capLen) ? o.capLen[k] : o.capLen);
    if (caps) {
      const [rb, rn] = radAt(0), cl = capL(0, rb, rn);
      pole(sub(pts[0], mul(T[0], cl)));
      for (let k = cs - 1; k >= 1; k--) { const f = (k / cs) * (Math.PI / 2); ring(sub(pts[0], mul(T[0], Math.sin(f) * cl)), Nn[0], Bn[0], rb * Math.cos(f), rn * Math.cos(f)); }
      capRings = rings.length;
    }
    for (let i = 0; i < n; i++) { const [rb, rn] = radAt(n > 1 ? i / (n - 1) : 0); ring(pts[i], Nn[i], Bn[i], rb, rn); }
    if (caps) {
      const e = n - 1, [rb, rn] = radAt(1), cl = capL(1, rb, rn);
      for (let k = 1; k < cs; k++) { const f = (k / cs) * (Math.PI / 2); ring(add(pts[e], mul(T[e], Math.sin(f) * cl)), Nn[e], Bn[e], rb * Math.cos(f), rn * Math.cos(f)); }
      pole(add(pts[e], mul(T[e], cl)));
    }
    const segOf = [];
    const link = (A, B, seg) => {
      for (let j = 0; j < R; j++) {
        const j1 = (j + 1) % R;
        if (A.n === 1) idx.push(A.s, B.s + j, B.s + j1);
        else if (B.n === 1) idx.push(A.s + j, B.s, A.s + j1);
        else { const a = A.s + j, b = A.s + j1, c = B.s + j, d = B.s + j1; idx.push(a, c, b, b, c, d); }
      }
      segOf.push([seg, A.n === 1 || B.n === 1 ? R * 3 : R * 6]);
    };
    for (let q = 0; q < rings.length - 1; q++) link(rings[q], rings[q + 1], clamp(q - capRings, 0, n - 2));
    if (closed) link(rings[rings.length - 1], rings[0], n - 1);
    const g = makeGeo(pos, idx);
    if (o.segMat) {
      let start = 0, cur = null, run = 0;
      for (const [seg, cnt] of segOf) {
        const m = o.segMat(seg);
        if (m !== cur && run) { g.addGroup(start, run, cur); start += run; run = 0; }
        cur = m; run += cnt;
      }
      if (run) g.addGroup(start, run, cur);
    }
    return g;
  }
  // Thin sheet with soft edges: mid-surface map(s, t) -> [x,y,z], half thickness thick(s, t) (0 on closed edges).
  function slab(nu, nv, map, thick, rowMat) {
    const P = [], Hh = [], NV = (nu + 1) * (nv + 1);
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { P.push(map(i / nu, j / nv)); Hh.push(Math.max(0, thick(i / nu, j / nv))); }
    const at = (i, j) => P[j * (nu + 1) + i];
    const pos = new Array(NV * 6);
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const k = j * (nu + 1) + i;
      const ds = sub(at(Math.min(i + 1, nu), j), at(Math.max(i - 1, 0), j)), dt = sub(at(i, Math.min(j + 1, nv)), at(i, Math.max(j - 1, 0)));
      let n = cross(ds, dt);
      n = len(n) > 1e-12 ? norm(n) : [0, 0, 1];
      const p = P[k], h = Hh[k];
      pos[k * 3] = p[0] + n[0] * h; pos[k * 3 + 1] = p[1] + n[1] * h; pos[k * 3 + 2] = p[2] + n[2] * h;
      pos[(NV + k) * 3] = p[0] - n[0] * h; pos[(NV + k) * 3 + 1] = p[1] - n[1] * h; pos[(NV + k) * 3 + 2] = p[2] - n[2] * h;
    }
    const idx = [];
    for (const back of [0, 1]) {
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const o = back ? NV : 0, a = o + j * (nu + 1) + i, b = a + 1, d = a + nu + 1, c = d + 1;
        if (back) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
      }
    }
    const g = makeGeo(pos, idx);
    if (rowMat) {
      for (const back of [0, 1]) {
        let start = back * nu * nv * 6, cur = null, run = 0;
        for (let j = 0; j < nv; j++) {
          const m = rowMat((j + 0.5) / nv);
          if (m !== cur && run) { g.addGroup(start, run, cur); start += run; run = 0; }
          cur = m; run += nu * 6;
        }
        if (run) g.addGroup(start, run, cur);
      }
    }
    return g;
  }
  // Torus-topology grid (both directions wrap): fn(u, v) with u, v in [0, 1).
  function wrapGrid(nu, nv, fn) {
    const pos = [], idx = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const p = fn(i / nu, j / nv); pos.push(p[0], p[1], p[2]); }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = i * nv + j, b = i * nv + ((j + 1) % nv), c = ((i + 1) % nu) * nv + j, d = ((i + 1) % nu) * nv + ((j + 1) % nv);
      idx.push(a, b, c, b, d, c);
    }
    return orient(makeGeo(pos, idx));
  }
  function extrude(outline, holes, depth, bevel) {
    const sh = new THREE.Shape(ccw(outline).map((p) => new THREE.Vector2(p[0], p[1])));
    for (const h of holes || []) sh.holes.push(new THREE.Path(ccw(h).slice().reverse().map((p) => new THREE.Vector2(p[0], p[1]))));
    const g = new THREE.ExtrudeGeometry(sh, { depth, steps: 1, curveSegments: 1, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 3 });
    g.translate(0, 0, -depth / 2);
    g.deleteAttribute('uv');
    return fixNormals(g, (x, y, z) => [0, 0, z >= 0 ? 1 : -1]);
  }
  const crPts = (ctrl, n, closed) => new THREE.CatmullRomCurve3(ctrl.map(V3), !!closed, 'centripetal').getSpacedPoints(n).map((v) => [v.x, v.y, v.z]).slice(0, closed ? n : n + 1);
  function fluff(g, amt, freq) {
    return deform(g, (x, y, z) => {
      const l = Math.hypot(x, y, z) || 1, u = x / l, v = y / l, w = z / l;
      const k = 1 + amt * (Math.sin(freq * u + 1.3) * Math.sin(freq * v + 0.7) * Math.sin(freq * w + 2.1) + 0.5 * Math.sin(2.3 * freq * u + 0.2) * Math.sin(2.1 * freq * w + 1.1));
      return [x * k, y * k, z * k];
    });
  }
  // Teardrop lobe for bows: inner (knot) end at the origin, extends along +x.
  function lobe(L, H, D, dent) {
    return deform(new THREE.SphereGeometry(1, 26, 18), (x, y, z) => {
      const s = (x + 1) / 2, g = 0.26 + 0.74 * Math.pow(Math.sin(Math.min(1, s * 1.35) * (Math.PI / 2)), 0.9);
      const zz = z * D * g - (dent || 0) * D * Math.max(0, z) * (1 - y * y) * Math.sin(Math.PI * s);
      return [s * L, y * H * g * (1 + 0.15 * s), zz];
    });
  }
  function leafGeo(L, W, T, cup) {
    return slab(8, 12, (s, t) => {
      const w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.9) + 1e-4, x = (s - 0.5) * w;
      return [x, t * L, cup * (x * x) / Math.max(W, 1e-4) * 4 - 0.25 * cup * W * t * t - 0.06 * W * (1 - Math.abs(2 * s - 1)) * Math.sin(Math.PI * t)];
    }, (s, t) => T * Math.sqrt(Math.sin(Math.PI * s)) * Math.sqrt(Math.sin(Math.PI * clamp(t, 0, 1))));
  }

  /* ---- placement (pure functions of the anchors) ---- */

  // Hat frame: origin hat.c, axes X, Y (tilted up), Z; dome radii a (x), b (up), cz (z) inflated by fur.
  function hatFrame(A, fur) {
    const h = A.hat || {};
    const o = fin3(h.c) ? h.c.slice(0, 3) : [A.center[0], A.top.p[1] - 0.3, A.center[2]];
    const t = +h.tilt || 0, X = [1, 0, 0], Y = [0, Math.cos(t), Math.sin(t)], Z = [0, -Math.sin(t), Math.cos(t)];
    const W = A.width > 0.3 ? A.width : 1.6;
    const mx = h.rx > 0.03 ? h.rx : 0.4, mz = h.rz > 0.03 ? h.rz : mx;
    let rx = Math.max(mx, 0.2 * W), rz = Math.max(mz, 0.16 * W);
    rz = Math.max(rz, rx / 1.45); rx = Math.max(rx, rz / 1.45);
    // Dome height above the ring. anchors.top may sit on a thin antenna or tuft; an optional
    // anchors.headTop (y of the head top without them) wins when the anchors provide it. A narrow
    // tip (the star's top point, the drop's point) is the exception: the head-top rays land beside
    // it, below the ring (star) or on the shoulders of a taper well above the ring (drop), while the
    // top point rises well above a small ring, inside its footprint. Then the dome must reach the top
    // point, or a hat stops short of the tip and it pokes through. Antennas and sprouts stand on wide
    // rings, and a bud or stalk (cactus, strawberry) rises from a top that is level with the ring:
    // those are features that come through the hat, like the robot's antenna, not tips.
    const mr = (mx + mz) / 2, inside = Math.abs(A.top.p[0] - o[0]) < mx && Math.abs(A.top.p[2] - o[2]) < Math.max(mz, 0.05);
    const up = A.headTop - o[1];
    const tip = isFinite(A.headTop) && mr < 0.3 * W && inside &&
      ((up < 0.01 && A.top.p[1] - o[1] > 0.8 * mr) || (up > 0.25 * mr && up < 0.6 * mr && A.top.p[1] - A.headTop > 0.5 * mr));
    // A pointed top that is no thin feature (the diamond's and hexagon's points, the triangle's
    // peak) rises a little above anchors.headTop, more than a round crest does between the head-top
    // rays (under 0.15 mr). The dome then reaches to just under the point, so it does not show
    // through a crown. Thin features rise further (0.3 mr and up) and keep coming through.
    const rise = A.top.p[1] - A.headTop, peak = rise > 0.15 * mr && rise < 0.3 * mr;
    const tp = isFinite(A.headTop) && !tip ? [A.top.p[0], peak ? A.top.p[1] - 0.012 : Math.min(A.headTop, A.top.p[1]), A.top.p[2]] : A.top.p;
    const r0 = (rx + rz) / 2, H = clamp(dot(sub(tp, o), Y), 0.12 * r0, 2.4 * r0), f = fur * 0.9;
    const a = rx + f, cz = rz + f, b = H + f;
    return {
      o, t, X, Y, Z, a, b, cz, tip, H0: H, r0, rho: (a + cz) / 2, rmin: Math.min(a, cz), hs: Math.max((a + cz) / 2, 0.22 * W + f),
      w(p) { return [o[0] + X[0] * p[0] + Y[0] * p[1] + Z[0] * p[2], o[1] + X[1] * p[0] + Y[1] * p[1] + Z[1] * p[2], o[2] + X[2] * p[0] + Y[2] * p[1] + Z[2] * p[2]]; },
      l(p) { const d = sub(p, o); return [dot(d, X), dot(d, Y), dot(d, Z)]; },
      E(p) { return (p[0] / a) * (p[0] / a) + (p[1] / b) * (p[1] / b) + (p[2] / cz) * (p[2] / cz); },
      pt(alpha, phi) { const s = Math.sin(alpha); return [a * s * Math.sin(phi), b * Math.cos(alpha), cz * s * Math.cos(phi)]; },
      nrm(p) { return norm([p[0] / (a * a), p[1] / (b * b), p[2] / (cz * cz)]); }
    };
  }
  // Seat a circular base ring of radius R on the dome around polar angle alpha, azimuth phi (0 = front, +pi/2 = +x).
  function perch(F, R, alpha, phi) {
    const E0 = F.pt(alpha, phi), N0 = F.nrm(E0);
    let zf = sub([0, 0, 1], mul(N0, N0[2]));
    zf = len(zf) < 1e-3 ? [0, -N0[2] > 0 ? 1 : -1, 0] : norm(zf);
    const xf = cross(N0, zf);
    const g = (h) => {
      let m = 1e9;
      for (let k = 0; k < 24; k++) { const an = (k / 24) * TAU, p = add(add(E0, mul(N0, h)), add(mul(xf, R * Math.cos(an)), mul(zf, R * Math.sin(an)))); m = Math.min(m, F.E(p)); }
      return m - 1;
    };
    let lo = -(R + F.b), hi = R + F.b;
    for (let it = 0; it < 32; it++) { const mid = (lo + hi) / 2; if (g(mid) < 0) lo = mid; else hi = mid; }
    const p = add(E0, mul(N0, hi));
    if (p[1] < 0.02 * F.b) { const k = (0.02 * F.b - p[1]) / Math.max(N0[1], 0.3); p[0] += N0[0] * k; p[1] += N0[1] * k; p[2] += N0[2] * k; }
    return { p, x: xf, y: N0, z: zf };
  }
  // Perched hats: base radius (x head scale), polar tilt, azimuth (0 = front, +pi/2 = +x).
  const PERCH = { tophat: [0.62, 0.12, Math.PI / 2], crown: [0.6, 0, 0], chef: [0.8, 0, 0], beret: [0.76, 0.36, Math.PI / 2 + 0.25], party: [0.46, 0.34, -Math.PI / 2 + 0.2],
    pillbox: [0.58, 0.42, Math.PI / 2 - 0.4], moon: [0.1, 0.36, -0.62] };
  // On a narrow tip the crown would sit on the very point and look tiny: it rings the tip instead.
  const perchFor = (F, id) => { const q = PERCH[id]; let R = q[0] * F.hs; if (F.tip && id === 'crown') R = Math.max(R, 1.02 * F.rho); return { R, P: perch(F, R, q[1], q[2]) }; };
  const domeR = (F, y) => F.rho * Math.sqrt(Math.max(0, 1 - (y / F.b) * (y / F.b)));
  function neckFrame(A, fur) {
    const nk = A.neck || {}, f = fur * 0.85;
    const c = fin3(nk.c) ? nk.c.slice(0, 3) : [A.center[0], A.ground + 0.3 * A.height, A.center[2]];
    const rx = (nk.rx > 0.05 ? nk.rx : A.width * 0.4) + f, rz = (nk.rz > 0.05 ? nk.rz : A.depth * 0.4) + f;
    const u = clamp((rx + rz) / 2, 0.2, 0.8);
    return {
      c, rx, rz, u, ground: A.ground,
      pt(phi, push, dy) { const n = this.n(phi); return [c[0] + rx * Math.sin(phi) + n[0] * push, c[1] + (dy || 0), c[2] + rz * Math.cos(phi) + n[2] * push]; },
      n(phi) { return norm([Math.sin(phi) / rx, 0, Math.cos(phi) / rz]); }
    };
  }
  function faceFrame(A, fur) {
    const eL = A.eyeL.p, eR = A.eyeR.p, br = fin3(A.brow && A.brow.p) ? A.brow.p : mix3(eL, eR, 0.5);
    const S = clamp(len(sub(eR, eL)), 0.1, 1.4);
    const X = norm(sub(eR, eL));
    const nA = norm(add(A.eyeL.n || [0, 0, 1], A.eyeR.n || [0, 0, 1]));
    const Z = perpTo(norm(add(mul(nA, 0.5), [0, 0, 0.5])), X), Y = cross(Z, X);
    const wl = (p) => [dot(sub(p, br), X), dot(sub(p, br), Y), dot(sub(p, br), Z)];
    const lL = wl(eL), lR = wl(eR);
    const w0 = Math.max(lL[2], lR[2], 0) + fur * 0.8 + 0.13 * S + 0.012;
    const sL = fin3(A.sideL && A.sideL.p) ? A.sideL.p : add(eL, [-0.4, 0, -0.3]), sR = fin3(A.sideR && A.sideR.p) ? A.sideR.p : add(eR, [0.4, 0, -0.3]);
    const Ce = [(sL[0] + sR[0]) / 2, (eL[1] + eR[1]) / 2, (sL[2] + sR[2]) / 2];
    return {
      S, X, Y, Z, br, w0, vc: (lL[1] + lR[1]) / 2, sL, sR, Ce,
      ax: Math.max(Math.abs(sR[0] - sL[0]) / 2, 0.2), az: Math.max(br[2] - Ce[2], 0.15),
      o: add(br, mul(Z, w0)),
      w(p) { return add(add(add(this.o, mul(X, p[0])), mul(Y, p[1])), mul(Z, p[2])); }
    };
  }

  /* ---- head shape from the anchors (round 2) ---- */

  // anchors.eyeL/eyeR.n are blended 40% toward +z (sdf.js faceN). Undoing that gives the surface
  // normal, whose sideways tilt tells a curved face (blobs) from a flat one (the robot's box).
  const unblend = (nf) => { const L = (0.8 * nf[2] + Math.sqrt(0.64 * nf[2] * nf[2] + 0.8)) / 2; return [(nf[0] * L) / 0.6, (nf[1] * L) / 0.6, (nf[2] * L - 0.4) / 0.6]; };
  // What sits on the head: eyes on top bumps (frog-like: the brow ray lands far behind the eyes),
  // something standing above the head top (ears, horns, antennas, tufts, a narrow tip: the box top
  // is well above anchors.headTop), a flat face. tilt: how bands over the head lean (trap 8).
  function headInfo(A) {
    const ez = Math.min(A.eyeL.p[2], A.eyeR.p[2]);
    const topEyes = !!(A.brow && fin3(A.brow.p) && A.brow.p[2] < ez - 0.15);
    const ht = isFinite(A.headTop) ? Math.min(A.headTop, A.top.p[1]) : A.top.p[1];
    const boxTop = isFinite(A.ground) && A.height > 0 ? A.ground + A.height : A.top.p[1];
    const bumps = boxTop > ht + 0.06;
    let flat = false;
    if (!topEyes && fin3(A.eyeL.n) && fin3(A.eyeR.n)) { const l = unblend(A.eyeL.n), r = unblend(A.eyeR.n); flat = Math.max(Math.abs(l[0]), Math.abs(r[0])) < 0.02; }
    return { topEyes, bumps, flat, ht, boxTop, tilt: topEyes ? -0.5 : bumps ? 0.45 : 0 };
  }
  // Horizontal sections of the head (no fur): the eye-level section (sides, brow, back; a
  // superellipse when the face is flat) shrinks toward the measured hat ring along an elliptic
  // profile (exact for ellipsoids; superelliptic for flat faces); below the eyes it is the larger of
  // the eye section and the neck ring (bodies are widest in between). R(y, ph) is measured from C(y); ph 0 = front, +pi/2 = +x.
  function headSec(A) {
    const I = headInfo(A), H = A.height > 0.3 ? A.height : 1.5;
    const eL = A.eyeL.p, eR = A.eyeR.p, ye = (eL[1] + eR[1]) / 2;
    const sL = fin3(A.sideL && A.sideL.p) ? A.sideL.p : add(eL, [-0.4, 0, -0.3]), sR = fin3(A.sideR && A.sideR.p) ? A.sideR.p : add(eR, [0.4, 0, -0.3]);
    const ae = Math.max((sR[0] - sL[0]) / 2, 0.15), cxe = (sR[0] + sL[0]) / 2, cze = (sR[2] + sL[2]) / 2;
    const fz = !I.topEyes && fin3(A.brow && A.brow.p) ? A.brow.p[2] : Math.max(eL[2], eR[2]);
    const bf = Math.max(fz - cze, 0.12);
    let bb = bf;
    if (A.back && fin3(A.back.p)) bb = Math.max(0.12, lerp(cze - A.back.p[2], bf, clamp(Math.abs(A.back.p[1] - ye) / (0.25 * H), 0, 1)));
    const pe = I.flat ? 5 : 2, h = A.hat || {}, hc = fin3(h.c) ? h.c : [cxe, ye + 0.3 * H, cze];
    // A thin, cookie-like head (hexagon, cushion, heart) whose sides are upright walls at the eyes
    // (side normal level or facing down) keeps its width far above the eyes: its sides follow a
    // superelliptic profile, its front and back the elliptic one.
    const sny = fin3(A.sideL && A.sideL.n) && fin3(A.sideR && A.sideR.n) ? (A.sideL.n[1] + A.sideR.n[1]) / 2 : 1;
    const walls = !I.flat && !I.topEyes && (bf + bb) / (2 * ae) < 0.62 && sny > -0.3 && sny < 0.03;
    const pv = (ph) => (I.flat ? pe : walls ? 2 + 2 * Math.sin(ph) * Math.sin(ph) : 2);
    const yr = Math.max(hc[1], ye + 0.05), rx = h.rx > 0.03 ? h.rx : 0.8 * ae, rz = h.rz > 0.03 ? h.rz : 0.8 * Math.min(bf, bb);
    const nk = A.neck && fin3(A.neck.c) && A.neck.rx > 0.05 && A.neck.rz > 0.05 ? A.neck : null;
    const sec = (a, f, b, p, ph) => { const s = Math.abs(Math.sin(ph)), c = Math.cos(ph); return 1 / Math.pow(Math.pow(s / a, p) + Math.pow(Math.abs(c) / (c >= 0 ? f : b), p), 1 / p); };
    const C = (y) => { const t = clamp((y - ye) / (yr - ye), 0, 1); return [lerp(cxe, hc[0], t), lerp(cze, hc[2], t)]; };
    const R = (y, ph) => {
      const Re = sec(ae, bf, bb, pe, ph);
      if (y <= ye) {
        if (!nk || y > ye - 0.02) return Re;
        // the neck ring, re-centered on the eye section's axis
        const s = Math.sin(ph), c = Math.cos(ph), dx = nk.c[0] - cxe, dz = nk.c[2] - cze;
        const qa = (s * s) / (nk.rx * nk.rx) + (c * c) / (nk.rz * nk.rz), qb = -2 * ((dx * s) / (nk.rx * nk.rx) + (dz * c) / (nk.rz * nk.rz)), qc = (dx * dx) / (nk.rx * nk.rx) + (dz * dz) / (nk.rz * nk.rz) - 1;
        const Rn = (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa);
        return Math.max(Re, Rn * clamp((ye - y) / Math.max(ye - nk.c[1], 0.05) * 2, 0, 1));
      }
      const Rr = sec(rx, rz, rz, 2, ph);
      // Above the ring the head goes on up to its top (a low ring between ears: mouse, fox): at
      // least a parabolic dome from the ring to anchors.headTop, never a cylinder or a cut-off.
      const dome = y > yr ? Rr * Math.max(0, 1 - Math.pow((y - yr) / Math.max(I.ht - yr, 0.05), 2)) : 0;
      if (Rr >= Re * 0.999) return y > yr ? dome : lerp(Re, Rr, clamp((y - ye) / (yr - ye), 0, 1));
      // elliptic toward the ring (exact for ellipsoids); a flat-faced box keeps its section until
      // close to the top, so its profile is a superellipse too
      const pp = pv(ph), Y = (yr - ye) / Math.pow(1 - Math.pow(Rr / Re, pp), 1 / pp), q = (y - ye) / Y;
      return Math.max(dome, Re * Math.pow(Math.max(0, 1 - Math.pow(Math.min(q, 1), pp)), 1 / pp));
    };
    const pt = (y, ph, push) => { const c = C(y), r = R(y, ph) + (push || 0); return [c[0] + r * Math.sin(ph), y, c[1] + r * Math.cos(ph)]; };
    return {
      ye, yr, info: I, walls, R, C, pt,
      n(y, ph) {
        const d = 0.012, nn = norm(cross(sub(pt(y, ph + d), pt(y, ph - d)), sub(pt(y + d, ph), pt(y - d, ph))));
        return dot(nn, [Math.sin(ph), 0, Math.cos(ph)]) < 0 ? mul(nn, -1) : nn;
      }
    };
  }
  // A band over the head from pL to pR (pL on the -x side) in a plane tilted forward by o.tilt
  // (negative: backward) about the line between the ends, kept o.clear outside the head: the hat
  // dome F above the ring (fur already in it), the sections S below it (plus o.fur). o.apex = wanted
  // y of the top before pushing. Returns {pts, nrm}: n + 1 points from pL to pR and outward normals.
  function overHead(F, S, pL, pR, o) {
    const n = o.n || 40, clr = o.clear, fo = o.fur || 0, Cm = mix3(pL, pR, 0.5), Xb = norm(sub(pR, pL)), U = perpTo([0, 1, 0], Xb), Fw = cross(Xb, U);
    const tl = o.tilt || 0, Yb = norm(add(mul(U, Math.cos(tl)), mul(Fw, Math.sin(tl))));
    const hw = len(sub(pR, pL)) / 2, ex = 2 / 2.6, hb = Math.max(o.apex - Cm[1], 0.12) / Math.max(Math.cos(tl), 0.6);
    const push = (p) => {
      const l = F.l(p);
      if (l[1] > -0.02) {
        const a = F.a + clr, b = F.b + clr, c = F.cz + clr, ly = Math.max(l[1], 0), e = (l[0] / a) * (l[0] / a) + (ly / b) * (ly / b) + (l[2] / c) * (l[2] / c);
        if (e < 1) { const k = 1 / Math.sqrt(Math.max(e, 1e-4)); p = F.w([l[0] * k, l[1] >= 0 ? l[1] * k : l[1], l[2] * k]); }
      }
      if (p[1] < S.yr + 0.02) {
        const c = S.C(p[1]), ph = Math.atan2(p[0] - c[0], p[2] - c[1]), rr = Math.hypot(p[0] - c[0], p[2] - c[1]), need = S.R(p[1], ph) + clr + fo;
        if (rr < need) p = [c[0] + need * Math.sin(ph), p[1], c[1] + need * Math.cos(ph)];
      }
      return p;
    };
    let pts = [];
    for (let i = 0; i <= n; i++) {
      const ps = Math.PI * (1 - i / n), c = Math.cos(ps), s = Math.sin(ps);
      const p = add(Cm, add(mul(Xb, hw * Math.sign(c) * Math.pow(Math.abs(c), ex)), mul(Yb, hb * Math.pow(Math.abs(s), ex))));
      pts.push(i > 0 && i < n ? push(p) : p);
    }
    // Pushing leaves kinks where the arc meets the head; relax them, then push again.
    for (let it = 0; it < 4; it++) {
      const q = pts.map((p) => p.slice());
      for (let i = 1; i < n; i++) for (let k = 0; k < 3; k++) q[i][k] = 0.25 * pts[i - 1][k] + 0.5 * pts[i][k] + 0.25 * pts[i + 1][k];
      pts = q.map((p, i) => (i > 0 && i < n ? push(p) : p));
    }
    const nrm = pts.map((p, i) => perpTo(sub(p, Cm), norm(sub(pts[Math.min(i + 1, n)], pts[Math.max(i - 1, 0)]))));
    return { pts, nrm, Cm, Yb };
  }
  // Soft bend: every vertex turns about `axis` through `pivot` (both in the mesh's own space) by
  // angle x weight(rest position), then about `axis2` (optional) by angle2 x weight. Positions and
  // normals are rebuilt from a rest copy, so angle 0 is exactly the built shape (trap 10).
  // Returns set(angle, angle2).
  function bender(meshes, pivot, axis, weight, axis2) {
    const k = norm(axis), k2 = axis2 ? norm(axis2) : null, list = [];
    for (const m of meshes) {
      if (!m) continue;
      const P = m.geometry.attributes.position, N = m.geometry.attributes.normal;
      const p0 = Float32Array.from(P.array), n0 = Float32Array.from(N.array), w = new Float32Array(P.count);
      for (let i = 0; i < P.count; i++) w[i] = clamp(weight(p0[i * 3], p0[i * 3 + 1], p0[i * 3 + 2]), 0, 1);
      m.frustumCulled = false;
      list.push({ P, N, p0, n0, w });
    }
    let cur = 0, cur2 = 0;
    const [ox, oy, oz] = pivot, v = [0, 0, 0];
    // Rodrigues: rotate v in place about unit axis a by (c = cos, s = sin).
    const rot = (a, c, s) => {
      const vx = v[0], vy = v[1], vz = v[2], d = a[0] * vx + a[1] * vy + a[2] * vz, t = 1 - c;
      v[0] = vx * c + (a[1] * vz - a[2] * vy) * s + a[0] * d * t;
      v[1] = vy * c + (a[2] * vx - a[0] * vz) * s + a[1] * d * t;
      v[2] = vz * c + (a[0] * vy - a[1] * vx) * s + a[2] * d * t;
    };
    return (angle, angle2) => {
      const b2 = k2 && isFinite(angle2) ? angle2 : 0;
      if (!isFinite(angle) || (Math.abs(angle - cur) < 1e-7 && Math.abs(b2 - cur2) < 1e-7)) return;
      cur = angle; cur2 = b2;
      for (const it of list) {
        const p = it.P.array, nn = it.N.array, p0 = it.p0, n0 = it.n0;
        for (let i = 0, j = 0; i < it.w.length; i++, j += 3) {
          const w = it.w[i], c = Math.cos(angle * w), s = Math.sin(angle * w), two = b2 !== 0 && w > 0;
          const c2 = two ? Math.cos(b2 * w) : 1, s2 = two ? Math.sin(b2 * w) : 0;
          v[0] = p0[j] - ox; v[1] = p0[j + 1] - oy; v[2] = p0[j + 2] - oz;
          rot(k, c, s);
          if (two) rot(k2, c2, s2);
          p[j] = ox + v[0]; p[j + 1] = oy + v[1]; p[j + 2] = oz + v[2];
          v[0] = n0[j]; v[1] = n0[j + 1]; v[2] = n0[j + 2];
          rot(k, c, s);
          if (two) rot(k2, c2, s2);
          nn[j] = v[0]; nn[j + 1] = v[1]; nn[j + 2] = v[2];
        }
        it.P.needsUpdate = true;
        it.N.needsUpdate = true;
      }
    };
  }
  // Where a hair clip sits, above an eye on one side (side -1 = viewer's left): on the hat dome of
  // domed heads, at the side of the head between the eyes and the hat ring on flat-topped ones (trap 9),
  // on the head top between the eye bumps when the eyes sit on top.
  // Returns {p, n, s}: point (fur included), outward normal turned a little forward, head scale.
  function clipAt(A, fur, side) {
    const F = hatFrame(A, fur), I = headInfo(A);
    if (I.topEyes && fin3(A.brow && A.brow.p)) {
      const Sx = clamp(len(sub(A.eyeR.p, A.eyeL.p)), 0.1, 1.4), bn = norm(unblend(norm(A.brow.n || [0, 1, 0.3])));
      return { p: add(add(A.brow.p, [side * 0.15 * Sx, 0.02 * Sx, 0.04 * Sx]), mul(bn, fur * 0.85 + 0.02 + 0.03 * Sx)), n: norm(add(bn, [side * 0.3, 0, 1.1])), s: F.hs };
    }
    // The side of the head is no place for a clip when something much wider hangs over it (the
    // mushroom's cap: the body is twice as wide as the head at the eyes): it goes on the top then.
    const sx = fin3(A.sideL && A.sideL.p) && fin3(A.sideR && A.sideR.p) ? (A.sideR.p[0] - A.sideL.p[0]) / 2 : 0;
    if (F.H0 >= 0.3 * F.r0 || (sx > 0.1 && A.width / 2 > 1.5 * sx)) {
      const q = F.pt(1.0, side * 0.55), nq = F.nrm(q);
      return { p: F.w(add(q, mul(nq, 0.02 * F.hs))), n: norm(add(norm(sub(F.w(nq), F.o)), [0, 0, 0.5])), s: F.hs };
    }
    const S = headSec(A), y = S.ye + 0.35 * (S.yr - S.ye), ph = side * 1.0;
    return { p: S.pt(y, ph, fur * 0.85 + 0.02), n: norm(add(S.n(y, ph), [0, 0.2, 0.35])), s: F.hs };
  }

  // Height of the dome above a perched base plane, at radius r from the base center (the most over
  // any azimuth). A perched hat's underside follows it, so the hat sits on the head, not in it.
  function perchSag(F, P, R) {
    const H = [];
    for (let k = 0; k <= 6; k++) {
      const r = (k / 6) * R;
      let m = 0;
      for (let j = 0; j < 12; j++) {
        const an = (j / 12) * TAU, q = add(P.p, add(mul(P.x, r * Math.cos(an)), mul(P.z, r * Math.sin(an))));
        if (F.E(q) >= 1) continue;
        let lo = 0, hi = F.b + R;
        for (let it = 0; it < 24; it++) { const mid = (lo + hi) / 2; if (F.E(add(q, mul(P.y, mid))) < 1) lo = mid; else hi = mid; }
        m = Math.max(m, lo);
      }
      H.push(m);
    }
    return (r) => { const f = clamp(r / R, 0, 1) * 6, i = Math.min(5, Math.floor(f)); return lerp(H[i], H[i + 1], f - i); };
  }
  // A band around the head across the forehead, above the eyes (C.eyeTop) and below the head top, or
  // below the eye bumps when the eyes sit on top. Returns the closed center line from the front (phi 0) toward +x,
  // the band's up (along the head) and out (surface normal) vectors, and at(w, h, o): the point at
  // arc length w from the front center, h along up and o along out.
  function headBand(C, A, S, rn, rb, n) {
    const Sx = clamp(len(sub(A.eyeR.p, A.eyeL.p)), 0.1, 1.4), I = S.info;
    let yb = I.topEyes ? S.ye - 0.4 * Sx : Math.min(Math.max(C.eyeTop + 0.03 + rn, S.ye + 0.45 * (S.yr - S.ye)), lerp(S.ye, I.ht, 0.82));
    // Never where the modelled section has shrunk to a cap (a low, wide head): the band would collapse.
    const wide = (y) => [0, Math.PI / 2, Math.PI, -Math.PI / 2].every((ph) => S.R(y, ph) >= 0.6 * S.R(S.ye, ph));
    if (yb > S.ye && !wide(yb)) {
      let lo = S.ye, hi = yb;
      for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (wide(m)) lo = m; else hi = m; }
      yb = lo;
    }
    // the modelled sections run up to ~0.03 inside a cookie head's rounded-box corners
    const push = C.fur * 0.85 + rb * 0.9 + (I.topEyes ? 0.015 : S.walls ? 0.025 : 0), pts = [], up = [], out = [], cum = [0];
    for (let i = 0; i < n; i++) {
      const ph = (i / n) * TAU;
      pts.push(S.pt(yb, ph, push));
      out.push(S.n(yb, ph));
    }
    // A cap that hangs far past the head sections all the way round (the mushroom's, right over the
    // forehead) swallows the whole band. With the shape's own distance function (ctx.sdf), a band
    // whose center line is mostly inside the body is walked out along each azimuth until it clears
    // the surface, and takes the surface normal there: it rings the cap (`capped` when that took it
    // well away from the head, which the ninja's tails need to know). A band that is inside only in
    // places (ears, arms or a boxy head's corners crossing it) is left as the sections put it.
    const sd = C.sdf, lift = [];
    if (sd && pts.filter((p) => sd(p[0], p[1], p[2]) < 0).length > 0.7 * n) {
      const clr = C.fur * 0.85 + rb * 0.9 + 0.005, lim = 2 * Math.max(A.width || 0, A.depth || 0, 1), e = 2e-3;
      for (let i = 0; i < n; i++) {
        const ph = (i / n) * TAU, d = [Math.sin(ph), 0, Math.cos(ph)], p0 = pts[i];
        const g = (x) => sd(p0[0] + d[0] * x, p0[1], p0[2] + d[2] * x);
        if (g(0) >= clr) { lift.push(0); continue; }
        let lo = 0, hi = 0.04;
        while (hi < lim && g(hi) < clr) { lo = hi; hi *= 1.5; }
        if (hi >= lim) { lift.push(0); continue; }
        for (let k = 0; k < 22; k++) { const m = (lo + hi) / 2; if (g(m) < clr) lo = m; else hi = m; }
        const p = add(p0, mul(d, hi));
        const gr = [sd(p[0] + e, p[1], p[2]) - sd(p[0] - e, p[1], p[2]), sd(p[0], p[1] + e, p[2]) - sd(p[0], p[1] - e, p[2]), sd(p[0], p[1], p[2] + e) - sd(p[0], p[1], p[2] - e)];
        pts[i] = p;
        lift.push(hi);
        if (len(gr) > 1e-9 && dot(gr, d) > 0) out[i] = norm(gr);
      }
    }
    const capped = lift.length > 0 && lift.slice().sort((x, y) => x - y)[lift.length >> 1] > 0.1;
    for (let i = 0; i < n; i++) {
      up.push(perpTo([0, 1, 0], out[i]));
      if (i) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
    }
    const L = cum[n - 1] + len(sub(pts[0], pts[n - 1]));
    const at = (w, h, o) => {
      w = ((w % L) + L) % L;
      let i = 0;
      while (i < n - 1 && cum[i + 1] < w) i++;
      const j = (i + 1) % n, f = clamp((w - cum[i]) / Math.max((i + 1 < n ? cum[i + 1] : L) - cum[i], 1e-9), 0, 1);
      return add(mix3(pts[i], pts[j], f), add(mul(norm(mix3(up[i], up[j], f)), h), mul(norm(mix3(out[i], out[j], f)), o)));
    };
    return { pts, up, out, at, L, yb, rb, rn, Sx, capped };
  }
  // A closed strap around the head through knots [phi, dy] (phi increasing, dy in eye spacings above
  // the eye anchors), smoothed, then kept `push` outside the head sections. Returns {pts, nrm}.
  function headLoop(S, Sx, knots, push, n) {
    const ctrl = knots.map(([ph, dy]) => S.pt(S.ye + dy * Sx, ph, push));
    const pts = crPts(ctrl, n, true).map((p) => {
      const c = S.C(p[1]), ph = Math.atan2(p[0] - c[0], p[2] - c[1]), r = Math.hypot(p[0] - c[0], p[2] - c[1]), need = S.R(p[1], ph) + push;
      return r < need ? [c[0] + need * Math.sin(ph), p[1], c[1] + need * Math.cos(ph)] : p;
    });
    const nrm = pts.map((p) => { const c = S.C(p[1]); return S.n(p[1], Math.atan2(p[0] - c[0], p[2] - c[1])); });
    return { pts, nrm };
  }
  // Outer bounds of the body for things that hang on it (cape, necktie, medal), by the backpack
  // strap rules: the inflated bounding ellipsoid, the neck ring grown toward the eye-level width, and
  // for boxy bodies (the neck ring had to grow past the box) a superellipse of the box. R(y, ph) is
  // the farthest of them along azimuth ph from the neck axis; pt() pushes out from there.
  function bodyHull(A, off) {
    const c = A.center, ax = A.width / 2 + off, ay = A.height / 2 + off, az = A.depth / 2 + off;
    const NK = A.neck && fin3(A.neck.c) && A.neck.rx > 0.05 && A.neck.rz > 0.05 ? A.neck : null;
    const sL = A.sideL && fin3(A.sideL.p) ? A.sideL.p : null, sR = A.sideR && fin3(A.sideR.p) ? A.sideR.p : null;
    const boxP = NK ? -Math.LN2 / Math.log(Math.min(0.99, Math.max(NK.rx / (A.width / 2), NK.rz / (A.depth / 2)) / Math.SQRT2)) : 2;
    const o = NK ? [NK.c[0], NK.c[2]] : [c[0], c[2]];
    const ringAt = (y) => {
      if (!NK) return null;
      const ye = sL && sR ? (sL[1] + sR[1]) / 2 : NK.c[1], t = ye > NK.c[1] + 0.05 ? clamp((y - NK.c[1]) / (ye - NK.c[1]), 0, 1) : 0;
      const k = lerp(1, sL && sR ? clamp((1.05 * (sR[0] - sL[0])) / 2 / NK.rx, 0.8, 1.3) : 1, t);
      return [lerp(NK.c[0], sL && sR ? (sL[0] + sR[0]) / 2 : NK.c[0], t), NK.c[2], NK.rx * k + off, NK.rz * k + off];
    };
    // distance along the ray from o to the edge of a convex curve given by inside(x, z)
    const hit = (s, co, inside) => {
      let lo = 0, hi = 4 * Math.max(ax, az);
      if (!inside(o[0], o[1])) return 0;
      for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (inside(o[0] + m * s, o[1] + m * co)) lo = m; else hi = m; }
      return lo;
    };
    const R = (y, ph) => {
      const s = Math.sin(ph), co = Math.cos(ph), k = Math.sqrt(Math.max(0.0025, 1 - ((y - c[1]) / ay) ** 2));
      let r = hit(s, co, (x, z) => ((x - c[0]) / (ax * k)) ** 2 + ((z - c[2]) / (az * k)) ** 2 < 1);
      const q = ringAt(y);
      if (q) r = Math.max(r, hit(s, co, (x, z) => ((x - q[0]) / q[2]) ** 2 + ((z - q[1]) / q[3]) ** 2 < 1));
      if (boxP > 2.5) { const e = Math.min(boxP, 4); r = Math.max(r, hit(s, co, (x, z) => Math.abs((x - c[0]) / ax) ** e + Math.abs((z - c[2]) / az) ** e < 1)); }
      return r;
    };
    const pt = (y, ph, push) => { const r = R(y, ph) + (push || 0); return [o[0] + r * Math.sin(ph), y, o[1] + r * Math.cos(ph)]; };
    return { o, R, pt };
  }
  // With the shape's distance function (C.sdf), p walked out level from the axis point o = [x, z]
  // until the body is `need` away: for parts of a body that the bounds above miss (the cactus's
  // flower pot, which swallowed the medal and the tie blade). p itself when already clear.
  function sdfOut(C, o, p, need) {
    const sd = C.sdf, dx = p[0] - o[0], dz = p[2] - o[1], r = Math.hypot(dx, dz);
    if (!sd || r < 1e-6 || sd(p[0], p[1], p[2]) >= need) return p;
    const g = (t) => sd(p[0] + (dx / r) * t, p[1], p[2] + (dz / r) * t);
    let lo = 0, hi = 0.02;
    while (hi < 2 && g(hi) < need) { lo = hi; hi *= 1.5; }
    if (hi >= 2) return p;
    for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (g(m) < need) lo = m; else hi = m; }
    return [p[0] + (dx / r) * hi, p[1], p[2] + (dz / r) * hi];
  }
  // A child of the hat group that undoes its transform, for parts built from world points.
  function worldIn(hg) {
    hg.updateMatrix();
    const w = new THREE.Group();
    w.matrix.copy(hg.matrix).invert();
    w.matrix.decompose(w.position, w.quaternion, w.scale);
    hg.add(w);
    return w;
  }

  /* ---- build ---- */

  // Top of the eyes as face.js draws them (the tallest styles reach about 2 x eyeSize above the eye
  // anchors; a cyclops eye sits 0.25 x eye spacing higher), from ctx.eyeC or ctx.faceMeta when the
  // viewer passes them, else from a typical eye size. Bands across the forehead stay above it.
  function eyeTopOf(A, ctx, fur) {
    const fm = ctx && (ctx.faceMeta || ctx.face), e = ctx && ctx.eyeC, Sx = clamp(len(sub(A.eyeR.p, A.eyeL.p)), 0.1, 1.4), ye = (A.eyeL.p[1] + A.eyeR.p[1]) / 2;
    if (e && fin3(e.p) && e.r > 0) return e.p[1] + 1.05 * e.r + 0.8 * fur;
    const es = fm && fm.eyeSize > 0 ? +fm.eyeSize : 0.15 * Sx;
    if (fm && fm.eyes === 'cyclops') return ye + 0.25 * Sx + 1.05 * clamp(es >= 0.11 ? 1.2 * es : 2.2 * es, 0.2 * Sx, 0.55 * Sx) + 0.8 * fur;
    return ye + 2 * es + 0.8 * fur;
  }
  function newCtx(slot, id, A, ctx) {
    ctx = ctx || {};
    const body = hexNorm(ctx.hex) || 'ffd34e', soft = !!ctx.soft, fur = Math.max(0, +ctx.furLength || 0);
    const geos = [];
    const C = {
      A, body, soft, fur, geos, eyeTop: eyeTopOf(A, ctx, fur), sdf: typeof ctx.sdf === 'function' ? ctx.sdf : null,
      col: (def, alt, min) => contrastPick([def, alt], body, min),
      mat: (kind, color) => mats.accessory(kind, { color: hexNorm(color) || color, soft, transmissive: !!ctx.transmissive, finishId: ctx.finishId }),
      metal: (pref) => (labDist(pref === 'silver' ? 'd9dde3' : 'f2c14e', body) >= 0.12 ? (pref || 'gold') : (pref === 'silver' ? 'gold' : 'silver')),
      mesh(parent, geo, material, name, noShadow) {
        if (!geo || !material) return null;
        geos.push(geo);
        const m = new THREE.Mesh(geo, material);
        m.name = name || '';
        m.castShadow = !noShadow;
        m.receiveShadow = false;
        if (noShadow) m.userData.noShadow = true;
        parent.add(m);
        return m;
      }
    };
    C.metalMat = (pref) => { const k = C.metal(pref); return C.mat(k, k === 'gold' ? 'f2c14e' : 'd9dde3'); };
    return C;
  }
  function hatGroup(F) {
    const g = new THREE.Group();
    g.position.set(F.o[0], F.o[1], F.o[2]);
    g.rotation.set(F.t, 0, 0);
    return g;
  }
  // Ring hats: a child scaled to the ring ellipse (geometry inside is built for a round ring of radius rho).
  function shellOf(g, F) { const s = new THREE.Group(); s.scale.set(F.a / F.rho, 1, F.cz / F.rho); g.add(s); return s; }
  const ell = (F, p) => [p[0] * F.a / F.rho, p[1], p[2] * F.cz / F.rho];
  function perchGroup(g, P) {
    const s = new THREE.Group();
    M4.makeBasis(V3(P.x), V3(P.y), V3(P.z));
    s.quaternion.setFromRotationMatrix(M4);
    s.position.set(P.p[0], P.p[1], P.p[2]);
    g.add(s);
    return s;
  }
  const ribs = (N, amp, from, fade) => (x, y, z) => {
    const r = Math.hypot(x, z);
    if (r < 1e-6) return [x, y, z];
    const th = Math.atan2(x, z), w = clamp((r - from) / Math.max(amp * 4, 1e-6), 0, 1) * (fade ? fade(y) : 1);
    const k = (r + amp * w * (0.5 + 0.5 * Math.cos(N * th))) / r;
    return [x * k, y, z * k];
  };

  const HATS = {
    beanie(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('e2475c', '2a9d8f'), pom = C.col('fff1dc', 'ffc24d');
      const cuff = lathe(subdiv(rrLoop(p * 0.985, p * 1.12, -0.035 * p, 0.27 * p, 0.055 * p, 5), 0.03 * p), 132, ribs(44, 0.016 * p, p * 1.0));
      C.mesh(sh, cuff, C.mat('knit', main), 'beanie-cuff');
      const Rc = p * 1.07, Bc = Math.max(b * 1.06 + 0.22 * p, 0.82 * p), y0 = 0.14 * p, prof = [[0, y0]];
      const f0 = Math.asin(clamp(y0 / Bc, -1, 1));
      for (let i = 0; i <= 22; i++) { const f = lerp(f0, Math.PI / 2, i / 22); prof.push([Rc * Math.cos(f), Bc * Math.sin(f)]); }
      const crown = lathe(prof, 108, ribs(30, 0.014 * p, 0, (y) => 1 - Math.pow(clamp(y / Bc, 0, 1), 5)));
      C.mesh(sh, crown, C.mat('knit', main), 'beanie-crown');
      const pr = 0.3 * p, pp = fluff(sphere(pr, pr, pr, 30, 22), 0.09, 9);
      pp.translate(0, Bc + pr * 0.62, 0);
      C.mesh(g, pp, C.mat('knit', pom), 'beanie-pompom');
    },
    cap(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('3b6df2', 'f2a33a'), brimC = C.col(shade(main, -0.08), shade(main, 0.12));
      const Rc = p * 1.05, Bc = Math.max(b + 0.08 * p, 0.55 * p), y0 = -0.03 * p, prof = [[0, y0]];
      const f0 = Math.asin(clamp(y0 / Bc, -1, 1));
      for (let i = 0; i <= 22; i++) { const f = lerp(f0, Math.PI / 2, i / 22); prof.push([Rc * Math.cos(f), Bc * Math.sin(f)]); }
      const seam = (x, y, z) => {
        const r = Math.hypot(x, z);
        if (r < 1e-6) return [x, y, z];
        const th = Math.atan2(x, z), d = Math.abs(((th + TAU) % (Math.PI / 3)) - Math.PI / 6) - Math.PI / 6;
        const k = (r - 0.012 * p * Math.exp(-(d * d) / 0.0016) * sstep(0.02 * p, 0.12 * p, y) * (1 - Math.pow(clamp(y / Bc, 0, 1), 6))) / r;
        return [x * k, y, z * k];
      };
      C.mesh(sh, lathe(prof, 120, seam), C.mat('fabric', main), 'cap-crown');
      const btn = sphere(0.075 * p, 0.04 * p, 0.075 * p, 16, 10);
      btn.translate(0, Bc + 0.01 * p, 0);
      C.mesh(sh, btn, C.mat('fabric', main), 'cap-button');
      const fm = 1.25, visor = slab(28, 10, (s, t) => {
        const ph = (s - 0.5) * 2 * fm, L = 0.8 * p * Math.pow(Math.max(0, Math.cos((ph / fm) * (Math.PI / 2))), 0.5) + 1e-4;
        const r = 0.96 * p + t * L;
        return [r * Math.sin(ph), 0.015 * p - 0.12 * p * Math.pow(t, 1.6) * (L / (0.8 * p)) - 0.05 * p * Math.pow(Math.sin(ph) / Math.sin(fm), 2) * t, r * Math.cos(ph)];
      }, (s, t) => 0.026 * p * Math.pow(Math.sin(Math.PI * s), 0.35) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 6))));
      C.mesh(sh, visor, C.mat('fabric', brimC), 'cap-brim');
    },
    tophat(C, F, g) {
      const { R, P } = perchFor(F, 'tophat'), s = perchGroup(g, P);
      const main = C.col('2b2a33', 'ece4d4'), band = C.col('d23c4a', 'f2c14e');
      const Hc = 1.15 * R, rc = 0.08 * R, rad = (y) => R * (1 - 0.05 * Math.sin((Math.PI * y) / Hc) + 0.07 * Math.pow(y / Hc, 2));
      const prof = [[0, 0], [R, 0]];
      for (let i = 1; i <= 14; i++) { const y = (i / 14) * (Hc - rc); prof.push([rad(y), y]); }
      const rt = rad(Hc - rc);
      for (let i = 1; i <= 5; i++) { const a = (i / 5) * (Math.PI / 2); prof.push([rt - rc + rc * Math.cos(a), Hc - rc + rc * Math.sin(a)]); }
      prof.push([0, Hc]);
      C.mesh(s, lathe(prof, 72), C.mat('felt', main), 'tophat-crown');
      const Rb = 1.6 * R;
      const brim = lathe(subdiv(rrLoop(0.92 * R, Rb, -0.025 * R, 0.045 * R, 0.035 * R, 4), 0.06 * R), 96, (x, y, z) => {
        const r = Math.hypot(x, z), u = clamp((r - R) / (Rb - R), 0, 1), sn = r > 1e-6 ? x / r : 0;
        return [x, y + 0.22 * R * u * u * sn * sn - 0.03 * R * u * (1 - sn * sn), z];
      });
      C.mesh(s, brim, C.mat('felt', main), 'tophat-brim');
      const bandG = lathe(rrLoop(rad(0.05 * R) - 0.01 * R, rad(0.05 * R) + 0.03 * R, 0.05 * R, 0.3 * R, 0.012 * R, 3), 72);
      C.mesh(s, bandG, C.mat('fabric', band), 'tophat-band');
    },
    crown(C, F, g) {
      const { R, P } = perchFor(F, 'crown'), s = perchGroup(g, P);
      const gold = C.metalMat('gold'), h0 = 0.42 * R, hp = 0.5 * R, t = 0.08 * R, rc = 0.028 * R;
      const ro = (y) => R * (1 + (0.14 * y) / (h0 + hp));
      const top = (th) => h0 + hp * Math.pow(0.5 + 0.5 * Math.cos(5 * th), 2.4);
      // Cross-section loop per azimuth: rounded rectangle from (ro - t, 0) to (ro, top).
      const ri = ro(0) - t, rO = ro(0), parts = [0.05, 0.08, 0.29, 0.08, 0.05, 0.08, 0.29, 0.08];
      let lastTh = NaN, segs, corners;
      const loopPt = (th, v) => {
        if (th !== lastTh) {
          const yt = top(th);
          lastTh = th;
          segs = [[ri + rc, 0, rO - rc, 0], null, [rO, rc, rO, yt - rc], null, [rO - rc, yt, ri + rc, yt], null, [ri, yt - rc, ri, rc], null];
          corners = [[rO - rc, rc, -Math.PI / 2], [rO - rc, yt - rc, 0], [ri + rc, yt - rc, Math.PI / 2], [ri + rc, rc, Math.PI]];
        }
        let acc = 0;
        for (let k = 0; k < 8; k++) {
          if (v <= acc + parts[k] || k === 7) {
            const f = clamp((v - acc) / parts[k], 0, 1);
            let r, y;
            if (segs[k]) { const e = segs[k]; r = lerp(e[0], e[2], f); y = lerp(e[1], e[3], f); }
            else { const c = corners[(k - 1) / 2]; const a = c[2] + f * (Math.PI / 2); r = c[0] + rc * Math.cos(a); y = c[1] + rc * Math.sin(a); }
            const flare = ro(y) - ro(0);
            return [(r + flare) * Math.sin(th), y, (r + flare) * Math.cos(th)];
          }
          acc += parts[k];
        }
        return [0, 0, 0];
      };
      const band = wrapGrid(140, 28, (u, v) => loopPt(u * TAU, v));
      C.mesh(s, band, gold, 'crown-band');
      const balls = [], gems = [[], [], []], GC = [C.col('e0245e', '8a1fd0', 0.1), C.col('2f6bff', '1fae74', 0.1), C.col('1fae74', 'e0245e', 0.1)];
      for (let k = 0; k < 5; k++) {
        const th = (k / 5) * TAU, yt = h0 + hp + 0.05 * R, rr = ro(yt) - t / 2;
        const b0 = sphere(0.075 * R, 0.075 * R, 0.075 * R, 14, 10);
        b0.translate(rr * Math.sin(th), yt, rr * Math.cos(th));
        balls.push(b0);
        const big = k === 0 ? 1.25 : 1, yg = 0.24 * R, rg = ro(yg) + 0.004 * R;
        const n = [Math.sin(th), 0, Math.cos(th)], gm = sphere(0.085 * R * big, 0.1 * R * big, 0.045 * R * big, 16, 10);
        put(gm, [rg * n[0], yg, rg * n[2]], cross([0, 1, 0], n), [0, 1, 0], n);
        gems[k % 3].push(gm);
      }
      C.mesh(s, merge(balls), gold, 'crown-balls');
      gems.forEach((list, i) => { if (list.length) C.mesh(s, merge(list), C.mat('gem', GC[i]), 'crown-gems'); });
      const vprof = [[0, 0.1 * R], [ri * 0.97, 0.1 * R]];
      for (let i = 1; i <= 12; i++) { const a = (i / 12) * (Math.PI / 2); vprof.push([ri * 0.97 * Math.cos(a), 0.1 * R + (h0 + 0.12 * R) * Math.sin(a)]); }
      C.mesh(s, lathe(vprof, 64), C.mat('fabric', C.col('c21f3a', '3d3a8c')), 'crown-velvet');
    },
    tiara(C, F, g) {
      const p = F.hs, yt = 0.5 * F.b, k = Math.sqrt(Math.max(0.05, 1 - (yt / F.b) * (yt / F.b))), gold = C.metalMat('gold');
      const rt = 0.034 * p, push = rt + 0.006 * p;
      const at = (ph, y, out) => { const q = [F.a * k * Math.sin(ph), y, F.cz * k * Math.cos(ph)], n = F.nrm([q[0], yt, q[2]]); return add(q, mul(norm([n[0], 0, n[2]]), out)); };
      const arc = [];
      for (let i = 0; i <= 40; i++) arc.push(at(lerp(-2.0, 2.0, i / 40), yt, push));
      C.mesh(g, sweep(arc, { radius: rt, radial: 10 }), gold, 'tiara-band');
      const W = 0.66 * p, Pk = 0.56 * p, Rm = ((F.a + F.cz) / 2) * k;
      const wave = (amp, sc) => {
        const pts = [];
        for (let i = 0; i <= 36; i++) {
          const s = lerp(-1, 1, i / 36), f = Math.exp(-((s / 0.22) ** 2)) + 0.5 * Math.exp(-(((Math.abs(s) - 0.58) / 0.15) ** 2));
          const v = amp * f * sc, ph = (s * W) / Rm, q = at(ph, yt + v, push);
          pts.push(add(q, mul([Math.sin(ph), 0, Math.cos(ph)], -0.32 * v)));
        }
        return pts;
      };
      C.mesh(g, merge([sweep(wave(Pk, 1), { radius: 0.028 * p, radial: 8 }), sweep(wave(Pk * 0.55, 1), { radius: 0.021 * p, radial: 8 })]), gold, 'tiara-filigree');
      const gemAt = (s, v, r, colr) => {
        const ph = (s * W) / Rm, q = at(ph, yt + v, push + 0.01 * p), n = norm([Math.sin(ph), -0.3, Math.cos(ph)]);
        const gm = sphere(r, r * 1.22, r * 0.55, 18, 12);
        put(gm, add(q, mul([Math.sin(ph), 0, Math.cos(ph)], -0.32 * v)), perpTo([Math.cos(ph), 0, -Math.sin(ph)], n), cross(n, perpTo([Math.cos(ph), 0, -Math.sin(ph)], n)), n);
        return C.mesh(g, gm, C.mat('gem', colr), 'tiara-gem');
      };
      gemAt(0, Pk * 0.98, 0.1 * p, C.col('ff4f9a', '6ec6ff', 0.1));
      const side = C.col('6ec6ff', 'ff4f9a', 0.1);
      gemAt(-0.58, Pk * 0.5, 0.062 * p, side);
      gemAt(0.58, Pk * 0.5, 0.062 * p, side);
    },
    wizard(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('3d3a8c', 'b23a6f'), Hw = b + 1.55 * Math.max(p, F.hs * 0.9);
      const brim = lathe(subdiv(rrLoop(0.9 * p, 1.62 * p, -0.03 * p, 0.03 * p, 0.028 * p, 4), 0.05 * p), 112, (x, y, z) => {
        const r = Math.hypot(x, z), u = clamp((r - p) / (0.62 * p), 0, 1), th = Math.atan2(x, z);
        return [x, y + 0.06 * p * Math.sin(3 * th + 0.6) * u * u - 0.06 * p * u * u, z];
      });
      C.mesh(sh, brim, C.mat('felt', main), 'wizard-brim');
      const spine = crPts([[0, 0, 0], [0, 0.45 * Hw, -0.02 * p], [0, 0.78 * Hw, -0.08 * p], [0.14 * p, 0.95 * Hw, -0.12 * p], [0.42 * p, Hw - 0.06 * p, -0.1 * p], [0.66 * p, 0.88 * Hw, -0.05 * p]], 56);
      const lens = [0];
      for (let i = 1; i < spine.length; i++) lens.push(lens[i - 1] + len(sub(spine[i], spine[i - 1])));
      const L = lens[lens.length - 1];
      const radAt = (i) => { const t = lens[i] / L, y = spine[i][1], cone = 1.0 * p * Math.pow(1 - t, 1.05) + 0.02 * p; return y < b ? smax(cone, domeR(F, y) + 0.05 * p, 0.08 * p) : cone; };
      const rs = spine.map((_, i) => radAt(i));
      C.mesh(sh, sweep(spine, { radius: (t) => rs[Math.round(t * (rs.length - 1))], radial: 40, capSegs: 5, capLen: [0.03 * p, rs[rs.length - 1]] }), C.mat('felt', main), 'wizard-cone');
      const yb = 0.16 * p, iB = Math.max(0, spine.findIndex((q) => q[1] >= yb)), rbnd = rs[iB] + 0.008 * p, band = [];
      for (let i = 0; i < 64; i++) { const th = (i / 64) * TAU; band.push([rbnd * Math.sin(th), yb, rbnd * Math.cos(th)]); }
      C.mesh(sh, sweep(band, { closed: true, radius: [0.02 * p, 0.07 * p], up: [0, 1, 0], radial: 10 }), C.metalMat('gold'), 'wizard-band');
      const ys = 0.42 * Hw, iS = Math.max(0, spine.findIndex((q) => q[1] >= ys)), rS = rs[iS];
      const st = extrude(star2(0.17 * p, 0.075 * p, 5, 60, 2), [], 0.03 * p, 0.018 * p);
      const slope = Math.atan2(rs[Math.max(iS - 3, 0)] - rs[Math.min(iS + 3, rs.length - 1)], spine[Math.min(iS + 3, rs.length - 1)][1] - spine[Math.max(iS - 3, 0)][1]);
      st.rotateX(-slope);
      const pos = ell(F, [spine[iS][0], ys, spine[iS][2] + rS + 0.02 * p]);
      st.translate(pos[0], pos[1], pos[2]);
      C.mesh(g, st, C.metalMat('gold'), 'wizard-star');
    },
    beret(C, F, g) {
      const { R, P } = perchFor(F, 'beret'), s = perchGroup(g, P);
      const main = C.col('d6404e', '2b3a67');
      C.mesh(s, lathe(rrLoop(0.96 * R, 1.05 * R, -0.01 * R, 0.08 * R, 0.03 * R, 3), 72), C.mat('felt', shade(main, -0.06)), 'beret-band');
      const ctrl = [[0.98 * R, 0.05 * R], [1.22 * R, 0.12 * R], [1.36 * R, 0.26 * R], [1.3 * R, 0.42 * R], [0.95 * R, 0.56 * R], [0.4 * R, 0.62 * R], [0, 0.63 * R]];
      const prof = [[0, 0.05 * R]].concat(new THREE.SplineCurve(ctrl.map((q) => new THREE.Vector2(q[0], q[1]))).getPoints(28).map((v) => [v.x, v.y]));
      prof[prof.length - 1][0] = 0;
      C.mesh(s, lathe(prof, 80), C.mat('felt', main), 'beret-top');
      const nub = new THREE.CapsuleGeometry(0.04 * R, 0.05 * R, 4, 10);
      nub.translate(0, 0.66 * R, 0);
      C.mesh(s, nub, C.mat('felt', main), 'beret-nub');
    },
    party(C, F, g) {
      const { R, P } = perchFor(F, 'party'), s = perchGroup(g, P);
      const main = C.col('ff5fa2', '35b8c4'), d1 = C.col('ffd34e', '2f6bff'), d2 = C.col('5ab8ff', 'ff8a3d'), white = C.col('fff6ec', 'ffd34e');
      const Hc = 2.05 * R, rad = (y) => R * Math.pow(Math.max(0, 1 - y / Hc), 1.08);
      const prof = [[0, 0]];
      for (let i = 0; i <= 20; i++) { const y = (i / 20) * Hc * 0.985; prof.push([rad(y), y]); }
      prof.push([0, Hc]);
      C.mesh(s, lathe(prof, 64), C.mat('paper', main), 'party-cone');
      const rim = deform(new THREE.TorusGeometry(R * 1.0, 0.12 * R, 12, 64), (x, y, z) => {
        const a = Math.atan2(y, x), rr = Math.hypot(x, y), tx = x / (rr || 1), ty = y / (rr || 1), dx = x - tx * R, dy = y - ty * R;
        const k = 1 + 0.16 * Math.sin(16 * a) * Math.sin(5 * Math.atan2(z, dx * tx + dy * ty));
        return [tx * R + dx * k, ty * R + dy * k, z * k];
      });
      rim.rotateX(Math.PI / 2);
      rim.translate(0, 0.04 * R, 0);
      C.mesh(s, rim, C.mat('fabric', white), 'party-rim');
      const dots = [[], []], rows = [[0.24, 7, 0], [0.46, 5, 0.3], [0.66, 4, 0.1]];
      let k = 0;
      const slope = Math.atan2(R, Hc);
      for (const [tf, cnt, off] of rows) {
        const y = tf * Hc, rr = rad(y), rd = 0.12 * R * (1 - 0.45 * tf);
        for (let i = 0; i < cnt; i++) {
          const th = ((i + off) / cnt) * TAU, n = [Math.sin(th) * Math.cos(slope), Math.sin(slope), Math.cos(th) * Math.cos(slope)];
          const d = sphere(rd, rd, rd * 0.3, 12, 8), tg = [Math.cos(th), 0, -Math.sin(th)];
          put(d, add([rr * Math.sin(th), y, rr * Math.cos(th)], mul(n, 0.002 * R)), tg, cross(n, tg), n);
          dots[k++ % 2].push(d);
        }
      }
      C.mesh(s, merge(dots[0]), C.mat('paper', d1), 'party-dots');
      C.mesh(s, merge(dots[1]), C.mat('paper', d2), 'party-dots');
      const pom = fluff(sphere(0.3 * R, 0.3 * R, 0.3 * R, 24, 18), 0.1, 9);
      pom.translate(0, Hc + 0.12 * R, 0);
      C.mesh(s, pom, C.mat('fabric', white), 'party-pompom');
    },
    chef(C, F, g) {
      const { R, P } = perchFor(F, 'chef'), s = perchGroup(g, P);
      const main = C.col('fbfaf6', 'cfe2f5');
      const ctrl = [[R, 0], [1.02 * R, 0.25 * R], [1.03 * R, 0.45 * R], [0.99 * R, 0.53 * R], [1.16 * R, 0.64 * R], [1.3 * R, 0.86 * R], [1.24 * R, 1.1 * R], [0.9 * R, 1.3 * R], [0.42 * R, 1.37 * R], [0, 1.38 * R]];
      const prof = [[0, 0]].concat(new THREE.SplineCurve(ctrl.map((q) => new THREE.Vector2(q[0], q[1]))).getPoints(46).map((v) => [v.x, v.y]));
      prof[prof.length - 1][0] = 0;
      const geo = lathe(prof, 112, (x, y, z) => {
        const r = Math.hypot(x, z);
        if (r < 1e-6) return [x, y, z];
        const th = Math.atan2(x, z), wp = sstep(0.55 * R, 0.75 * R, y) * (1 - sstep(1.2 * R, 1.38 * R, y));
        const pleat = y < 0.5 * R ? 0.016 * R * (0.5 + 0.5 * Math.cos(18 * th)) * sstep(0.02 * R, 0.08 * R, y) : 0;
        const k = (r * (1 + 0.075 * Math.cos(7 * th) * wp) + pleat) / r;
        return [x * k, y - 0.045 * R * Math.cos(7 * th) * sstep(1.05 * R, 1.3 * R, y) * (r / R), z * k];
      });
      C.mesh(s, geo, C.mat('fabric', main), 'chef-toque');
    },
    bucket(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('cdb88f', '55705c'), bandC = C.col(shade(main, -0.18), shade(main, 0.2));
      const Hb = Math.max(b * 1.04 + 0.08 * p, 0.6 * p), rc = 0.12 * p;
      const rad = (y) => smax(1.06 * p - 0.16 * p * (y / Hb), domeR(F, y) + 0.045 * p, 0.05 * p);
      const prof = [[0, 0], [rad(0), 0]];
      for (let i = 1; i <= 16; i++) { const y = (i / 16) * (Hb - rc); prof.push([rad(y), y]); }
      const rt = rad(Hb - rc);
      for (let i = 1; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push([rt - rc + rc * Math.cos(a), Hb - rc + rc * Math.sin(a)]); }
      prof.push([0, Hb + 0.025 * p]);
      C.mesh(sh, lathe(prof, 96), C.mat('fabric', main), 'bucket-crown');
      const r0 = 0.98 * p, r1 = 1.62 * p, sl = 0.42, th = 0.022 * p, yb = 0.05 * p;
      const brimY = (r) => yb - (r - r0) * sl;
      const loop = [];
      const nB = 14;
      for (let i = 0; i <= nB; i++) { const r = lerp(r0, r1, i / nB); loop.push([r, brimY(r) - th]); }
      for (let i = 1; i < 8; i++) { const a = -Math.PI / 2 + (i / 8) * Math.PI; loop.push([r1 + th * 0.9 * Math.cos(a), brimY(r1) + th * Math.sin(a)]); }
      for (let i = nB; i >= 0; i--) { const r = lerp(r0, r1, i / nB); loop.push([r, brimY(r) + th]); }
      loop.push(loop[0].slice());
      C.mesh(sh, lathe(loop, 96), C.mat('fabric', main), 'bucket-brim');
      const st = [];
      for (const rr of [1.2 * p, 1.44 * p]) { const t0 = new THREE.TorusGeometry(rr, 0.006 * p, 6, 96); t0.rotateX(Math.PI / 2); t0.translate(0, brimY(rr) + th + 0.002 * p, 0); st.push(t0); }
      C.mesh(sh, merge(st), C.mat('fabric', bandC), 'bucket-stitch');
      C.mesh(sh, lathe(rrLoop(rad(0.1 * p) - 0.01 * p, rad(0.1 * p) + 0.016 * p, 0.03 * p, 0.17 * p, 0.012 * p, 3), 96), C.mat('fabric', bandC), 'bucket-band');
    },
    cowboy(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('b77b45', '4a3a30'), bandC = C.col('3a2a22', 'e8d2b0');
      const Hc = Math.max(b * 1.05 + 0.12 * p, 0.62 * p) + 0.22 * p, rc = 0.16 * p;
      const rad = (y) => smax(1.02 * p - 0.12 * p * Math.pow(y / Hc, 2), domeR(F, y) + 0.05 * p, 0.05 * p);
      const prof = [[0, 0], [rad(0), 0]];
      for (let i = 1; i <= 16; i++) { const y = (i / 16) * (Hc - rc); prof.push([rad(y), y]); }
      const rt = rad(Hc - rc);
      for (let i = 1; i <= 7; i++) { const a = (i / 7) * (Math.PI / 2); prof.push([rt - rc + rc * Math.cos(a), Hc - rc + rc * Math.sin(a)]); }
      for (let i = 1; i <= 4; i++) prof.push([(rt - rc) * (1 - i / 4), Hc]);
      const crown = lathe(prof, 96, (x, y, z) => {
        const w = sstep(Hc - 0.32 * p, Hc, y), r = Math.hypot(x, z), fz = r > 1e-6 ? Math.max(0, z / r) : 0;
        return [x * (1 - 0.13 * sstep(0.45 * Hc, Hc, y) * fz * fz), y - 0.14 * p * Math.exp(-((x / (0.3 * p)) ** 2)) * w, z];
      });
      C.mesh(sh, crown, C.mat('felt', main), 'cowboy-crown');
      const r1 = 1.8 * p;
      const brim = lathe(subdiv(rrLoop(0.95 * p, r1, -0.026 * p, 0.026 * p, 0.024 * p, 4), 0.05 * p), 112, (x, y, z) => {
        const r = Math.hypot(x, z), u = clamp((r - p) / (r1 - p), 0, 1), sn = r > 1e-6 ? x / r : 0;
        return [x, y + 0.42 * p * Math.pow(u, 2.2) * sn * sn - 0.07 * p * u * (1 - sn * sn), z];
      });
      C.mesh(sh, brim, C.mat('felt', main), 'cowboy-brim');
      C.mesh(sh, lathe(rrLoop(rad(0.1 * p) - 0.01 * p, rad(0.1 * p) + 0.016 * p, 0.03 * p, 0.15 * p, 0.012 * p, 3), 96), C.mat('fabric', bandC), 'cowboy-band');
      const bk = new THREE.BoxGeometry(0.11 * p, 0.09 * p, 0.02 * p, 1, 1, 1), fp = ell(F, [0, 0.09 * p, rad(0.09 * p) + 0.02 * p]);
      bk.translate(fp[0], fp[1], fp[2]);
      C.mesh(g, bk, C.metalMat('silver'), 'cowboy-buckle');
    },
    sunhat(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const straw = C.col('e8cf8f', 'b98552'), rib = C.col('ff7aa8', '4f8fe0');
      const Hs = Math.max(b * 1.03 + 0.07 * p, 0.5 * p), rc = 0.18 * p;
      const rad = (y) => smax(1.04 * p - 0.08 * p * (y / Hs), domeR(F, y) + 0.04 * p, 0.05 * p);
      const prof = [[0, 0], [rad(0), 0]];
      for (let i = 1; i <= 14; i++) { const y = (i / 14) * (Hs - rc); prof.push([rad(y), y]); }
      const rt = rad(Hs - rc);
      for (let i = 1; i <= 7; i++) { const a = (i / 7) * (Math.PI / 2); prof.push([rt - rc + rc * Math.cos(a), Hs - rc + rc * Math.sin(a)]); }
      prof.push([0, Hs + 0.02 * p]);
      C.mesh(sh, lathe(prof, 96), C.mat('straw', straw), 'sunhat-crown');
      const r1 = 1.82 * p;
      const brim = lathe(subdiv(rrLoop(0.95 * p, r1, -0.018 * p, 0.018 * p, 0.016 * p, 3), 0.05 * p), 120, (x, y, z) => {
        const r = Math.hypot(x, z), u = clamp((r - p) / (r1 - p), 0, 1), th = Math.atan2(x, z);
        return [x, y - 0.2 * p * Math.pow(u, 1.6) + 0.06 * p * Math.sin(7 * th) * Math.pow(u, 1.5) + 0.004 * p * Math.sin((r * 70) / p) * u, z];
      });
      C.mesh(sh, brim, C.mat('straw', straw), 'sunhat-brim');
      C.mesh(sh, lathe(rrLoop(rad(0.1 * p) - 0.01 * p, rad(0.1 * p) + 0.018 * p, 0.025 * p, 0.17 * p, 0.012 * p, 3), 96), C.mat('fabric', rib), 'sunhat-ribbon');
      const th = 2.35, rb = rad(0.1 * p) + 0.03 * p, at = ell(F, [rb * Math.sin(th), 0.1 * p, rb * Math.cos(th)]), n = norm(ell(F, [Math.sin(th), 0, Math.cos(th)]));
      bowAt(C, g, at, n, [0, 1, 0], 0.55 * p, rib, 'sunhat-bow');
    },
    flowers(C, F, g) {
      const p = F.hs, yf = 0.3 * F.b, k = Math.sqrt(Math.max(0.05, 1 - (yf / F.b) ** 2));
      const ringPt = (ph, out) => { const q = [F.a * k * Math.sin(ph), yf, F.cz * k * Math.cos(ph)], n = F.nrm(q); return add(q, mul(n, out)); };
      const vine = [];
      for (let i = 0; i < 72; i++) { const ph = (i / 72) * TAU; vine.push(add(ringPt(ph, 0.022 * p), [0, 0.012 * p * Math.sin(9 * ph), 0])); }
      const green = C.col('5a9a45', '2f6b3a', 0.1);
      C.mesh(g, sweep(vine, { closed: true, radius: 0.022 * p, radial: 8, up: (i) => F.nrm(vine[i]) }), C.mat('felt', green), 'flowers-vine');
      const palette = ['ff8fb8', 'fff6ec', 'ffd34e', 'b79cff', 'ff9b6a', '7fd0ff'].filter((c) => labDist(c, C.body) >= 0.14);
      if (palette.length < 2) palette.push(shade(C.body, -0.25), shade(C.body, 0.2));
      const byCol = new Map(), centers = [], leaves = [];
      const N = 9;
      for (let i = 0; i < N; i++) {
        const ph = (i / N) * TAU, s = (i % 2 ? 0.17 : 0.22) * p, q = ringPt(ph, 0.035 * p + 0.2 * s), n = norm(add(F.nrm(q), [0, 0.35, 0]));
        const tg = norm(cross([0, 1, 0], n)), bt = cross(n, tg), col = palette[i % palette.length];
        if (!byCol.has(col)) byCol.set(col, []);
        for (let j = 0; j < 5; j++) {
          const a = (j / 5) * TAU + i, dir = add(mul(tg, Math.cos(a)), mul(bt, Math.sin(a))), side = cross(n, dir);
          const pt = sphere(0.36 * s, 0.5 * s, 0.14 * s, 12, 8);
          const up = norm(add(dir, mul(n, 0.3)));
          put(pt, add(q, mul(dir, 0.5 * s)), side, up, norm(cross(side, up)));
          byCol.get(col).push(pt);
        }
        const cc = sphere(0.26 * s, 0.26 * s, 0.18 * s, 14, 10);
        put(cc, add(q, mul(n, 0.08 * s)), tg, bt, n);
        centers.push(cc);
        const pl = ph + Math.PI / N, ql = ringPt(pl, 0.03 * p), nl = F.nrm(ql), tl = norm(cross([0, 1, 0], nl));
        for (const sg of [-1, 1]) {
          const lf = leafGeo(0.24 * p, 0.1 * p, 0.014 * p, 0.25);
          const ax = norm(add(mul(tl, sg), [0, 0.25, 0]));
          put(lf, ql, cross(ax, nl), ax, nl);
          leaves.push(lf);
        }
      }
      for (const [col, list] of byCol) C.mesh(g, merge(list), C.mat('fabric', col), 'flowers-petals');
      C.mesh(g, merge(centers), C.mat('felt', C.col('ffcc3d', 'ff8a3d')), 'flowers-centers');
      C.mesh(g, merge(leaves), C.mat('felt', green), 'flowers-leaves');
    },
    halo(C, F, g, A) {
      // Float over the head top, and over ear tips when the shape has them (AABB top).
      const p = F.hs, top = F.l(A.top.p), hiY = isFinite(A.ground + A.height) ? A.ground + A.height : A.top.p[1];
      const lift = Math.max(0.42 * p + C.fur, (hiY - A.top.p[1]) + 0.2 * p + C.fur), c = add(top, [0, lift, 0]);
      const R = 0.62 * p, core = new THREE.TorusGeometry(R, 0.055 * p, 16, 96), glow = new THREE.TorusGeometry(R, 0.12 * p, 12, 72);
      const hold = new THREE.Group();
      hold.position.set(c[0], c[1], c[2]);
      hold.rotation.set(Math.PI / 2 + 0.35, 0, 0);
      g.add(hold);
      C.mesh(hold, core, C.mat('emissive', C.col('ffd25e', 'fff1b8', 0.08)), 'halo-core', true);
      C.mesh(hold, glow, C.mat('lens-tint', 'fff0b0'), 'halo-glow', true);
      g.userData.update = (t, m) => { hold.position.y = c[1] + 0.015 * p * Math.sin(t * 1.7) * (m == null ? 1 : m); };
    },
    bow(C, F, g) {
      const p = F.hs, q = F.pt(0.66, 1.05), n = F.nrm(q);
      bowAt(C, g, add(q, mul(n, 0.05 * p)), norm(add(n, [0, 0, 0.9])), [0, 1, 0], 1.25 * p, C.col('ff5f8f', '5b8def'), 'bow');
    },
    pillbox(C, F, g) {
      const { R, P } = perchFor(F, 'pillbox'), s = perchGroup(g, P), sag = perchSag(F, P, R);
      const main = C.col('2b2a3a', 'efe6d6'), rib = C.col('e2557a', 'f2c14e');
      const Hp = 0.7 * R, rc = 0.14 * R, rad = (y) => R * (1 - 0.03 * (y / Hp)), prof = [];
      for (let i = 0; i <= 8; i++) { const r = (i / 8) * R * 0.995; prof.push([r, sag(r) + 0.004 * R]); }
      for (let i = 0; i <= 10; i++) { const y = 0.02 * R + (i / 10) * (Hp - rc - 0.02 * R); prof.push([rad(y), y]); }
      const rt = rad(Hp - rc);
      for (let i = 1; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push([rt - rc + rc * Math.cos(a), Hp - rc + rc * Math.sin(a)]); }
      prof.push([0, Hp]);
      C.mesh(s, lathe(prof, 72), C.mat('felt', main), 'pillbox-body');
      const rb = rad(0.15 * R);
      C.mesh(s, lathe(rrLoop(rb - 0.01 * R, rb + 0.03 * R, 0.05 * R, 0.25 * R, 0.012 * R, 3), 72), C.mat('fabric', rib), 'pillbox-band');
      const ps = -0.55, at = [(rb + 0.05 * R) * Math.sin(ps), 0.15 * R, (rb + 0.05 * R) * Math.cos(ps)];
      bowAt(C, s, at, [Math.sin(ps), 0.1, Math.cos(ps)], [0, 1, 0], 0.8 * R, rib, 'pillbox-bow');
    },
    pirate(C, F, g) {
      // A captain's hat: a round crown with the brim turned up into a tall front and back flap that
      // meet in points over the sides, gold-edged, with a skull and crossbones on the front flap.
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('25232b', '6b3a2a'), gold = C.metalMat('gold');
      const Hc = Math.max(b * 1.06 + 0.2 * p, 0.72 * p), rc = 0.32 * p;
      const rad = (y) => smax(1.02 * p - 0.12 * p * Math.pow(y / Hc, 2), domeR(F, y) + 0.045 * p, 0.05 * p);
      const prof = [[0, 0], [rad(0), 0]];
      for (let i = 1; i <= 14; i++) { const y = (i / 14) * (Hc - rc); prof.push([rad(y), y]); }
      const rt = rad(Hc - rc);
      for (let i = 1; i <= 7; i++) { const a = (i / 7) * (Math.PI / 2); prof.push([rt - rc + rc * Math.cos(a), Hc - rc + rc * Math.sin(a)]); }
      prof.push([0, Hc]);
      C.mesh(sh, lathe(prof, 80), C.mat('felt', main), 'pirate-crown');
      // Each azimuth follows a quadratic bezier from inside the crown out to the brim edge: standing
      // nearly upright mid-flap (front and back), lying out flat at the side points.
      const cw = (th) => Math.pow(Math.sin(th) * Math.sin(th), 1.6), r0 = 0.94 * p, W = p, t0 = 0.026 * p;
      const path = (th, u) => {
        const c = cw(th), fr = Math.cos(th) > 0 ? 1 : 0.85, dO = p * (1.16 + 0.56 * c), yU = p * (0.8 * fr - (0.8 * fr - 0.12) * c), k = 1 - c;
        const P1 = [lerp((r0 + dO) / 2, dO + 0.04 * p, k), 0.02 * p], P2 = [dO - 0.12 * p * k, yU];
        const a = (1 - u) * (1 - u), m = 2 * u * (1 - u), e = u * u;
        const tx = 2 * (1 - u) * (P1[0] - r0) + 2 * u * (P2[0] - P1[0]), ty = 2 * (1 - u) * P1[1] + 2 * u * (P2[1] - P1[1]), l = Math.hypot(tx, ty) || 1;
        return { r: a * r0 + m * P1[0] + e * P2[0], y: m * P1[1] + e * P2[1], nr: -ty / l, ny: tx / l };
      };
      const brim = lathe(subdiv(rrLoop(r0, r0 + W, -t0, t0, 0.022 * p, 4), 0.06 * p), 120, (x, y, z) => {
        const th = Math.atan2(x, z), q = path(th, clamp((Math.hypot(x, z) - r0) / W, 0, 1)), R = q.r + q.nr * y;
        return [R * Math.sin(th), q.y + q.ny * y, R * Math.cos(th)];
      });
      C.mesh(sh, brim, C.mat('felt', main), 'pirate-brim');
      const trim = [];
      for (let i = 0; i < 120; i++) { const th = (i / 120) * TAU, q = path(th, 1); trim.push([q.r * Math.sin(th), q.y, q.r * Math.cos(th)]); }
      C.mesh(sh, sweep(trim, { closed: true, radius: 0.034 * p, radial: 8 }), gold, 'pirate-trim');
      // the skull goes on the outer face of the front flap (the side away from the crown)
      const q = path(0, 0.66), n = norm([0, -q.ny, (-q.nr * F.rho) / F.cz]), at = ell(F, [0, q.y - q.ny * t0, q.r - q.nr * t0]);
      skullAt(C, g, add(at, mul(n, 0.012 * p)), [0, 1, 0], n, 0.13 * p, 'pirate-skull');
    },
    detective(C, F, g) {
      // Deerstalker: a round eight-panel tweed crown with a checked weave of darker lines, peaks at
      // the front and back, and ear flaps tied up over the top with a cord bow.
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('a27a50', '5b4636'), dark = shade(main, -0.17);
      const Rc = p * 1.05, Bc = Math.max(b * 1.06 + 0.2 * p, 0.74 * p), y0 = -0.03 * p, prof = [[0, y0]];
      const f0 = Math.asin(clamp(y0 / Bc, -1, 1));
      for (let i = 0; i <= 24; i++) { const f = lerp(f0, Math.PI / 2, i / 24); prof.push([Rc * Math.cos(f), Bc * Math.sin(f)]); }
      const seam = (x, y, z) => {
        const r = Math.hypot(x, z);
        if (r < 1e-6) return [x, y, z];
        const th = Math.atan2(x, z), d = Math.abs(((th + TAU) % (Math.PI / 4)) - Math.PI / 8) - Math.PI / 8;
        const k = (r - 0.011 * p * Math.exp(-(d * d) / 0.0012) * sstep(0.02 * p, 0.1 * p, y) * (1 - Math.pow(clamp(y / Bc, 0, 1), 6))) / r;
        return [x * k, y, z * k];
      };
      C.mesh(sh, lathe(prof, 128, seam), C.mat('felt', main), 'detective-crown');
      // the weave: rings round the crown and lines down the middle of each panel
      const onC = (f, th, out) => { const r = Rc * Math.cos(f) + out; return [r * Math.sin(th), Bc * Math.sin(f) + 0.004 * p, r * Math.cos(th)]; }, lines = [];
      for (const f of [0.3, 0.62, 0.95]) { const ring = []; for (let i = 0; i < 96; i++) ring.push(onC(f, (i / 96) * TAU, 0.003 * p)); lines.push(sweep(ring, { closed: true, radius: 0.008 * p, radial: 5 })); }
      for (let k = 0; k < 8; k++) { const th = ((k + 0.5) / 8) * TAU, mer = []; for (let i = 0; i <= 18; i++) mer.push(onC(lerp(0.05, 1.32, i / 18), th, 0.003 * p)); lines.push(sweep(mer, { radius: 0.008 * p, radial: 5 })); }
      C.mesh(sh, merge(lines), C.mat('felt', dark), 'detective-weave');
      const btn = sphere(0.08 * p, 0.045 * p, 0.08 * p, 16, 10);
      btn.translate(0, Bc + 0.012 * p, 0);
      C.mesh(sh, btn, C.mat('felt', dark), 'detective-button');
      const peak = (ph0, L) => slab(24, 8, (s, t) => {
        const fm = 0.95, ph = (s - 0.5) * 2 * fm, LL = L * Math.pow(Math.max(0, Math.cos((ph / fm) * (Math.PI / 2))), 0.55) + 1e-4, r = 0.97 * p + t * LL;
        return [r * Math.sin(ph + ph0), 0.01 * p - 0.16 * p * Math.pow(t, 1.5) * (LL / L), r * Math.cos(ph + ph0)];
      }, (s, t) => 0.022 * p * Math.pow(Math.sin(Math.PI * s), 0.35) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 6))));
      C.mesh(sh, merge([peak(0, 0.52 * p), peak(Math.PI, 0.42 * p)]), C.mat('felt', main), 'detective-peaks');
      const flaps = [], cords = [], fTop = 1.02;
      for (const sd of [-1, 1]) {
        const tc = (sd * Math.PI) / 2;
        flaps.push(slab(16, 14, (s, t) => {
          const f = lerp(0.03, fTop, t), hw = 0.5 * Math.sqrt(Math.max(0, 1 - Math.pow(t, 3))) + 0.04, th = tc + (s - 0.5) * 2 * hw;
          return onC(f, th, 0.03 * p);
        }, (s, t) => 0.02 * p * Math.pow(Math.sin(Math.PI * s), 0.3) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 6))) * sstep(0, 0.06, t)));
        const pts = [];
        for (let i = 0; i <= 12; i++) pts.push(onC(lerp(fTop - 0.04, Math.PI / 2 - 0.1, i / 12), tc, 0.04 * p));
        cords.push(sweep(pts, { radius: 0.014 * p, radial: 6 }));
        for (const lb of [-1, 1]) {
          const loop = [];
          for (let i = 0; i <= 16; i++) { const a = (i / 16) * TAU; loop.push(onC(Math.PI / 2 - 0.1 - 0.07 * (1 - Math.cos(a)), lb * (Math.PI / 2) + sd * 0.0 + 0.35 * Math.sin(a) * sd, 0.045 * p)); }
          if (sd > 0) cords.push(sweep(loop, { radius: 0.013 * p, radial: 6 }));
        }
      }
      C.mesh(sh, merge(flaps), C.mat('felt', main), 'detective-flaps');
      C.mesh(sh, merge(cords), C.mat('fabric', dark), 'detective-cords');
    },
    ninja(C, F, g, A) {
      // A cloth band across the forehead (built from the head sections, in world space), a metal
      // plate in front, a knot at the back and two tails that flutter with motion.
      const S = headSec(A), wg = worldIn(g), s = F.hs, B = headBand(C, A, S, 0.15 * s, 0.03 * s, 120);
      const main = C.col('2a3150', 'd8343f'), cloth = C.mat('fabric', main), steel = C.metalMat('silver');
      C.mesh(wg, sweep(B.pts, { closed: true, radius: [B.rb, B.rn], up: (i) => B.up[i], radial: 14 }), cloth, 'ninja-band');
      const pw = 0.74 * s, ph = 1.5 * B.rn, po = B.rb + 0.01 * s;
      const plate = slab(18, 6, (u, v) => B.at((u - 0.5) * pw, (v - 0.5) * ph, po), (u, v) => 0.011 * s * Math.sqrt(Math.min(1, 7 * Math.min(u, 1 - u, v, 1 - v))));
      C.mesh(wg, plate, steel, 'ninja-plate');
      const f0 = B.at(0, 0, po + 0.012 * s), fu = norm(sub(B.at(0, 0.01, po), B.at(0, 0, po))), fo = norm(sub(B.at(0, 0, po + 0.01), B.at(0, 0, po))), fx = cross(fu, fo);
      const mark = extrude(star2(0.11 * s, 0.038 * s, 4, 48, 1), [ellipse2(0.02 * s, 0.02 * s, 16)], 0.008 * s, 0.003 * s);
      put(mark, f0, fx, fu, fo);
      C.mesh(wg, mark, C.mat('ink', '2a2c33'), 'ninja-mark');
      const rv = [];
      for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const d = sphere(0.02 * s, 0.02 * s, 0.011 * s, 10, 8); const q = B.at(a * 0.42 * pw, c * 0.32 * ph, po + 0.01 * s); put(d, q, fx, fu, fo); rv.push(d); }
      C.mesh(wg, merge(rv), steel, 'ninja-rivets');
      // knot and tails at the back
      const K = B.at(B.L / 2, 0, B.rb + 0.035 * s), kn = sphere(0.075 * s, 0.065 * s, 0.05 * s, 16, 12), ko = norm(sub(B.at(B.L / 2, 0, 1), B.at(B.L / 2, 0, 0)));
      put(kn, K, cross([0, 1, 0], ko), [0, 1, 0], ko);
      C.mesh(wg, kn, cloth, 'ninja-knot');
      const Lt = clamp(1.05 * s, 0.12, K[1] - A.ground - 0.12), Wt = 0.16 * s, sets = [];
      // On a cap (B.capped: the mushroom) the knot is out on the rim, far from the head below it:
      // the tails hang free from the knot instead of lying on the head.
      const kx = norm(cross([0, 1, 0], ko));
      for (const sd of [-1, 1]) {
        const at = B.capped ? (t) => [add(add(K, mul(kx, sd * (0.03 + 0.1 * t) * s)), add([0, -0.03 * s - t * Lt, 0], mul(ko, (0.02 + 0.05 * t) * s))), kx] : (t) => {
          const y = K[1] - 0.03 * s - t * Lt, phi = Math.PI + sd * (0.1 + 0.26 * t);
          return [S.pt(y, phi, C.fur * 0.85 + 0.045 * s + 0.09 * s * t), [Math.cos(phi), 0, -Math.sin(phi)]];
        };
        const tail = slab(4, 20, (u, t) => { const [c, w] = at(t); return add(c, mul(w, (u - 0.5) * Wt * (1 - 0.25 * t) + sd * 0.012 * s * Math.sin(5 * t))); },
          (u, t) => 0.008 * s * Math.pow(Math.sin(Math.PI * u), 0.4) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 10))));
        const m = C.mesh(wg, tail, cloth, 'ninja-tail');
        sets.push(bender([m], K, [1, 0, 0], (x, y, z) => Math.pow(clamp(Math.hypot(x - K[0], y - K[1], z - K[2]) / Lt, 0, 1), 1.2), [0, 0, 1]));
      }
      g.userData.update = (t, m) => {
        const k = m == null ? 1 : m;
        sets.forEach((set, i) => set(k * (0.15 + 0.1 * Math.sin(2.3 * t + 1.7 * i)), k * 0.1 * Math.sin(1.7 * t + 1.3 * i)));
      };
    },
    witch(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('4a2a78', '23212b'), Hw = b + 1.6 * Math.max(p, F.hs * 0.9);
      const brim = lathe(subdiv(rrLoop(0.9 * p, 1.9 * p, -0.028 * p, 0.028 * p, 0.026 * p, 4), 0.07 * p), 120, (x, y, z) => {
        const r = Math.hypot(x, z), u = clamp((r - p) / (0.9 * p), 0, 1), th = Math.atan2(x, z);
        return [x, y - 0.17 * p * u * u + 0.07 * p * Math.sin(2 * th + 0.5) * u * u * u, z];
      });
      C.mesh(sh, brim, C.mat('felt', main), 'witch-brim');
      // the cone leans back, kinks and flops back and to the left (the wizard's goes right)
      const spine = crPts([[0, 0, 0], [0, 0.42 * Hw, -0.03 * p], [-0.03 * p, 0.7 * Hw, -0.12 * p], [-0.12 * p, 0.86 * Hw, -0.32 * p], [-0.24 * p, 0.92 * Hw, -0.58 * p], [-0.36 * p, 0.82 * Hw, -0.8 * p]], 60);
      const lens = [0];
      for (let i = 1; i < spine.length; i++) lens.push(lens[i - 1] + len(sub(spine[i], spine[i - 1])));
      const L = lens[lens.length - 1];
      const rs = spine.map((q, i) => { const t = lens[i] / L, cone = 1.0 * p * Math.pow(1 - t, 1.05) + 0.02 * p; return q[1] < b ? smax(cone, domeR(F, q[1]) + 0.05 * p, 0.08 * p) : cone; });
      C.mesh(sh, sweep(spine, { radius: (t) => rs[Math.round(t * (rs.length - 1))], radial: 40, capSegs: 5, capLen: [0.03 * p, rs[rs.length - 1]] }), C.mat('felt', main), 'witch-cone');
      const yb = 0.17 * p, iB = Math.max(0, spine.findIndex((q) => q[1] >= yb)), rbnd = rs[iB] + 0.01 * p, band = [];
      for (let i = 0; i < 64; i++) { const th = (i / 64) * TAU; band.push([spine[iB][0] + rbnd * Math.sin(th), yb, spine[iB][2] + rbnd * Math.cos(th)]); }
      const bandC = labDist(main, '1f1d26') > 0.15 ? '1f1d26' : 'ff8a3d';
      C.mesh(sh, sweep(band, { closed: true, radius: [0.02 * p, 0.09 * p], up: [0, 1, 0], radial: 10 }), C.mat('fabric', bandC), 'witch-band');
      const slope = Math.atan2(rs[Math.max(iB - 3, 0)] - rs[Math.min(iB + 3, rs.length - 1)], spine[Math.min(iB + 3, rs.length - 1)][1] - spine[Math.max(iB - 3, 0)][1]);
      const bk = extrude(rrect2(0.3 * p, 0.24 * p, 0.05 * p, 48), [rrect2(0.17 * p, 0.11 * p, 0.025 * p, 40)], 0.03 * p, 0.008 * p);
      bk.rotateX(-slope);
      const pos = ell(F, [spine[iB][0], yb, spine[iB][2] + rbnd + 0.022 * p]);
      bk.translate(pos[0], pos[1], pos[2]);
      C.mesh(g, bk, C.metalMat('gold'), 'witch-buckle');
    },
    nightcap(C, F, g, A) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('5b7cff', 'ff6f91'), cream = C.col('fdf6e8', '2b2f45');
      C.mesh(sh, lathe(rrLoop(0.985 * p, 1.14 * p, -0.04 * p, 0.2 * p, 0.08 * p, 6), 112), C.mat('fabric', cream), 'nightcap-cuff');
      // A floppy striped cone: up over the dome, folded over to +x and hanging beside the head,
      // never lower than the ring there. It swings about the fold (trap 10). With ears or other
      // bumps beside the head top (mouse, bunny), it folds over to the back instead, clear of them.
      const top = b + 0.62 * p, low = Math.max(b - 0.3 * p, 0.1 * p);
      const be = A && headInfo(A).bumps ? Math.PI / 2 - 0.45 : 0, cb = Math.cos(be), sb = Math.sin(be);
      const turn = (q) => [q[0] * cb + q[2] * sb, q[1], -q[0] * sb + q[2] * cb];
      const spine = crPts([[0, 0.12 * p, 0], [0, 0.5 * b + 0.12 * p, 0], [0.04 * p, b + 0.3 * p, 0], [0.3 * p, top, 0], [0.78 * p, top - 0.04 * p, 0.02 * p], [1.12 * p, lerp(top, low, 0.55), 0.04 * p], [1.28 * p, low, 0.06 * p]], 72);
      const lens = [0];
      for (let i = 1; i < spine.length; i++) lens.push(lens[i - 1] + len(sub(spine[i], spine[i - 1])));
      const L = lens[lens.length - 1];
      const rs = spine.map((q, i) => { const t = lens[i] / L, cone = 1.07 * p * Math.pow(1 - t, 1.15) + 0.04 * p; return q[1] < b && q[0] < 0.3 * p ? smax(cone, domeR(F, q[1]) + 0.06 * p, 0.08 * p) : cone; });
      const mats2 = [C.mat('fabric', main), C.mat('fabric', cream)], sp = spine.map(turn);
      const cone = C.mesh(sh, sweep(sp, { radius: (t) => rs[Math.round(t * (rs.length - 1))], radial: 36, capSegs: 5, capLen: [0.03 * p, rs[rs.length - 1]], segMat: (q) => (Math.floor(q / 6) % 2) }), mats2, 'nightcap-cone');
      const tip = sp[sp.length - 1], T = norm(sub(tip, sp[sp.length - 3])), pr = 0.24 * p, pom = fluff(sphere(pr, pr, pr, 26, 18), 0.09, 9), pc = add(tip, mul(T, rs[rs.length - 1] + 0.55 * pr));
      pom.translate(pc[0], pc[1], pc[2]);
      const pomM = C.mesh(sh, pom, C.mat('knit', cream), 'nightcap-pompom');
      const set = bender([cone, pomM], turn([0.3 * p, top, 0]), turn([1, 0, 0]), (x, y, z) => sstep(0.3 * p, 1.2 * p, x * cb - z * sb));
      g.userData.update = (t, m) => set((m == null ? 1 : m) * 0.16 * Math.sin(1.5 * t));
    },
    sweatband(C, F, g, A) {
      const S = headSec(A), wg = worldIn(g), s = F.hs, B = headBand(C, A, S, 0.17 * s, 0.055 * s, 192);
      const main = C.col('ff4f7b', '2f6bff'), stripe = C.col('fbfaf6', 'ffd34e');
      C.mesh(wg, sweep(B.pts, { closed: true, radius: (t) => [B.rb * (1 + 0.1 * Math.cos(t * TAU * 48)), B.rn], up: (i) => B.up[i], radial: 16 }), C.mat('terry', main), 'sweatband-band');
      C.mesh(wg, sweep(B.pts, { closed: true, radius: [B.rb * 1.14, 0.26 * B.rn], up: (i) => B.up[i], radial: 12 }), C.mat('terry', stripe), 'sweatband-stripe');
    },
    boppers(C, F, g, A) {
      // An alice band with two springy antennae, each with a gold star, that wobble with motion.
      const S = headSec(A), wg = worldIn(g), s = F.hs;
      const { band, n } = aliceBand(C, F, S, s, C.col('ff5fa2', '7b5cff'), 'boppers-band', wg);
      const wire = C.metalMat('silver'), starM = C.metalMat('gold'), wobs = [];
      [S.info.bumps ? 0.38 : 0.31, S.info.bumps ? 0.62 : 0.69].forEach((f, k) => {
        const i = Math.round(f * n), base = band.pts[i], nb = band.nrm[i], sd = k ? 1 : -1;
        const dir = norm(add(add(mul(nb, 0.5), [0, 1, 0]), [sd * 0.3, 0, 0])), zf = perpTo([0, 0, 1], dir), xf = cross(dir, zf);
        const hold = new THREE.Group();
        M4.makeBasis(V3(xf), V3(dir), V3(zf));
        hold.quaternion.setFromRotationMatrix(M4);
        hold.position.set(base[0], base[1], base[2]);
        wg.add(hold);
        const wob = new THREE.Group();
        hold.add(wob);
        const Lc = 0.2 * s, L = 0.66 * s, coil = [];
        for (let j = 0; j <= 96; j++) { const t = j / 96, a = t * 6 * TAU; coil.push([0.04 * s * Math.cos(a), 0.01 * s + t * Lc, 0.04 * s * Math.sin(a)]); }
        C.mesh(wob, merge([sweep(coil, { radius: 0.011 * s, radial: 6 }), sweep(crPts([[0, Lc, 0], [0, 0.5 * (Lc + L), 0.012 * s], [0, L, 0]], 12), { radius: 0.011 * s, radial: 6 })]), wire, 'boppers-wire');
        const st = extrude(star2(0.21 * s, 0.095 * s, 5, 60, 2), [], 0.07 * s, 0.03 * s);
        st.translate(0, L + 0.1 * s, 0);
        C.mesh(wob, st, starM, 'boppers-star');
        wobs.push(wob);
      });
      g.userData.update = (t, m) => { const k = m == null ? 1 : m; wobs.forEach((w, i) => { w.rotation.z = k * 0.13 * Math.sin(2.7 * t + 1.9 * i); w.rotation.x = k * 0.08 * Math.sin(3.3 * t + 0.7 * i); }); };
    },
    moon(C, F, g) {
      // A gold crescent standing on the head, tips up and tilted, cradling a little gem star.
      const { P } = perchFor(F, 'moon'), s = perchGroup(g, P), p = F.hs;
      const Ro = 0.5 * p, Ri = 0.8 * Ro, d = 0.36 * Ro;
      const yi = (Ro * Ro - Ri * Ri + d * d) / (2 * d), xi = Math.sqrt(Math.max(1e-6, Ro * Ro - yi * yi));
      const aO = Math.atan2(yi, xi), aI = Math.atan2(yi - d, xi), raw = [];
      for (let i = 0; i < 48; i++) { const a = aO - (i / 48) * (Math.PI + 2 * aO); raw.push([Ro * Math.cos(a), Ro * Math.sin(a)]); }
      for (let j = 0; j < 36; j++) { const a = Math.PI - aI + (j / 36) * (Math.PI + 2 * aI); raw.push([Ri * Math.cos(a), d + Ri * Math.sin(a)]); }
      const moon = extrude(ccw(resample(chaikin(raw, 2), 120)), [], 0.13 * Ro, 0.05 * Ro);
      const star = extrude(star2(0.32 * Ro, 0.14 * Ro, 5, 60, 2), [], 0.12 * Ro, 0.04 * Ro);
      star.translate(0.03 * Ro, d - Ri + 0.33 * Ro, 0.01 * Ro);
      for (const geo of [moon, star]) geo.rotateZ(0.4);
      moon.computeBoundingBox();
      const lift = -moon.boundingBox.min.y - 0.01 * Ro;
      moon.translate(0, lift, 0);
      star.translate(0, lift, 0);
      C.mesh(s, moon, C.metalMat('gold'), 'moon-crescent');
      C.mesh(s, star, C.mat('gem', C.col('fff3b0', 'ffe066', 0.08)), 'moon-star');
    },
    viking(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const dk = C.metal('silver'), steel = C.mat(dk, dk === 'silver' ? 'd9dde3' : 'f2c14e');
      const trim = dk === 'silver' && C.metal('gold') === 'gold' ? C.mat('gold', 'f2c14e') : C.mat('gold', 'b0773a');
      const hornC = C.col('f1e4c8', 'b98a5a');
      const Rc = 1.05 * p, Bc = Math.max(b * 1.06 + 0.12 * p, 0.62 * p), y0 = -0.04 * p, prof = [[0, y0]];
      const f0 = Math.asin(clamp(y0 / Bc, -1, 1));
      for (let i = 0; i <= 24; i++) { const f = lerp(f0, Math.PI / 2, i / 24); prof.push([Rc * Math.cos(f), Bc * Math.sin(f)]); }
      C.mesh(sh, lathe(prof, 96), steel, 'viking-dome');
      C.mesh(sh, lathe(rrLoop(Rc - 0.02 * p, Rc + 0.06 * p, -0.07 * p, 0.12 * p, 0.03 * p, 3), 96), trim, 'viking-rim');
      const ridge = [], rn = [];
      for (let i = 0; i <= 40; i++) { const f = lerp(0.2, Math.PI - 0.2, i / 40), n = norm([0, Math.sin(f) / Bc, Math.cos(f) / Rc]); ridge.push(add([0, Bc * Math.sin(f), Rc * Math.cos(f)], mul(n, 0.012 * p))); rn.push(n); }
      C.mesh(sh, sweep(ridge, { radius: [0.06 * p, 0.022 * p], up: (i) => rn[i], radial: 10 }), trim, 'viking-ridge');
      const rv = [];
      for (let i = 0; i < 14; i++) { const th = ((i + 0.5) / 14) * TAU, d = sphere(0.03 * p, 0.03 * p, 0.018 * p, 10, 8); put(d, [(Rc + 0.06 * p) * Math.sin(th), 0.025 * p, (Rc + 0.06 * p) * Math.cos(th)], [Math.cos(th), 0, -Math.sin(th)], [0, 1, 0], [Math.sin(th), 0, Math.cos(th)]); rv.push(d); }
      C.mesh(sh, merge(rv), steel, 'viking-rivets');
      // horns, built unscaled in the hat frame from where they leave the dome
      const yh = 0.4 * Bc, rB = Rc * Math.cos(Math.asin(0.4)), horns = [], rings = [];
      for (const sd of [-1, 1]) {
        const E = ell(F, [sd * rB, yh, 0]), in0 = ell(F, [sd * 0.8 * rB, yh - 0.02 * p, 0]);
        const ctrl = [in0, add(E, [sd * 0.16 * p, 0.03 * p, 0.02 * p]), add(E, [sd * 0.34 * p, 0.18 * p, 0.05 * p]), add(E, [sd * 0.42 * p, 0.42 * p, 0.06 * p]), add(E, [sd * 0.36 * p, 0.64 * p, 0.03 * p])];
        const path = crPts(ctrl, 40);
        horns.push(sweep(path, { radius: (t) => 0.17 * p * Math.pow(1 - t, 0.85) + 0.012 * p, radial: 16, capSegs: 4 }));
        let k = 0;
        while (k < path.length - 2 && Math.abs(path[k][0]) < Math.abs(E[0])) k++;
        const T = norm(sub(path[Math.min(k + 2, path.length - 1)], path[Math.max(k - 2, 0)])), U = perpTo([0, 1, 0], T), rr = 0.17 * p * Math.pow(1 - k / (path.length - 1), 0.85) + 0.03 * p;
        const ring = new THREE.TorusGeometry(rr, 0.03 * p, 8, 32);
        put(ring, path[k], cross(U, T), U, T);
        rings.push(ring);
      }
      C.mesh(g, merge(horns), C.mat('enamel', hornC), 'viking-horns');
      C.mesh(g, merge(rings), trim, 'viking-horn-rings');
    },
    catears(C, F, g, A) {
      const S = headSec(A), wg = worldIn(g), s = F.hs;
      const main = C.col('2b2a33', 'f4f1ea'), innerC = labDist(main, 'ff9cc2') > 0.12 ? 'ff9cc2' : 'ff5c9a';
      const { band, n } = aliceBand(C, F, S, s, main, 'catears-band', wg);
      const outerM = C.mat('felt', main), innerM = C.mat('felt', innerC);
      // Eyes on top bumps (frog): the band runs behind them, so the ears stand higher on it and
      // upright, to show above the bumps.
      const tE = S.info.topEyes, fr = tE ? [0.38, 0.62] : S.info.bumps ? [0.36, 0.64] : [0.3, 0.7];
      fr.forEach((f, k) => {
        const i = Math.round(f * n), nb = band.nrm[i], sd = k ? 1 : -1;
        const up = norm(add(add(nb, [0, tE ? 1.2 : 0.5, 0]), [sd * 0.12, 0, 0]));
        catEar(C, wg, add(band.pts[i], mul(nb, -0.01 * s)), up, perpTo([0, 0.15, 1], up), 0.56 * s, outerM, innerM, 'catears-ear');
      });
    },
    grad(C, F, g) {
      const p = F.rho, b = F.b, sh = shellOf(g, F);
      const main = C.col('25232b', '2b3a67'), tas = C.col('f2c14e', 'e2475c');
      const Rc = 1.04 * p, Bc = Math.max(b * 1.02 + 0.06 * p, 0.45 * p), y0 = -0.03 * p, prof = [[0, y0]];
      const f0 = Math.asin(clamp(y0 / Bc, -1, 1));
      for (let i = 0; i <= 20; i++) { const f = lerp(f0, Math.PI / 2, i / 20); prof.push([Rc * Math.cos(f), Bc * Math.sin(f)]); }
      C.mesh(sh, lathe(prof, 96), C.mat('felt', main), 'grad-cap');
      // the board: square, unscaled, corner to the front; the tassel hangs from the +x corner
      const side = 2.05 * F.rho, th = 0.055 * p, yb = Bc + 0.015 * p;
      const board = extrude(rrect2(side, side, 0.03 * side, 64), [], th, 0.012 * p);
      board.rotateX(-Math.PI / 2);
      board.rotateY(Math.PI / 4);
      board.translate(0, yb, 0);
      C.mesh(g, board, C.mat('felt', main), 'grad-board');
      const yt = yb + th / 2 + 0.012 * p, btn = sphere(0.065 * p, 0.03 * p, 0.065 * p, 14, 8);
      btn.translate(0, yt + 0.012 * p, 0);
      C.mesh(g, btn, C.mat('fabric', tas), 'grad-button');
      const cx = (side / Math.SQRT2) * 0.97, cord = C.mat('fabric', tas);
      C.mesh(g, sweep(crPts([[0, yt + 0.014 * p, 0], [0.45 * cx, yt + 0.01 * p, 0.03 * p], [cx, yt + 0.006 * p, 0]], 16), { radius: 0.012 * p, radial: 6 }), cord, 'grad-cord');
      const piv = new THREE.Group();
      piv.position.set(cx, yt, 0);
      g.add(piv);
      const Lh = 0.42 * p;
      C.mesh(piv, sweep(crPts([[0, 0.006 * p, 0], [0.025 * p, -0.03 * p, 0], [0.03 * p, -0.5 * Lh, 0], [0.03 * p, -Lh, 0]], 16), { radius: 0.012 * p, radial: 6 }), cord, 'grad-cord');
      const kn = sphere(0.04 * p, 0.04 * p, 0.04 * p, 12, 8);
      kn.translate(0.03 * p, -Lh, 0);
      const tp = [[0, -Lh - 0.29 * p], [0.07 * p, -Lh - 0.29 * p], [0.075 * p, -Lh - 0.27 * p], [0.05 * p, -Lh - 0.12 * p], [0.035 * p, -Lh - 0.03 * p], [0, -Lh - 0.02 * p]];
      const skirt = lathe(tp, 36, ribs(18, 0.008 * p, 0.02 * p));
      skirt.translate(0.03 * p, 0, 0);
      C.mesh(piv, merge([kn, skirt]), cord, 'grad-tassel');
      g.userData.update = (t, m) => { const k = m == null ? 1 : m; piv.rotation.x = k * 0.18 * Math.sin(1.9 * t); piv.rotation.z = k * 0.07 * (0.5 + 0.5 * Math.sin(1.3 * t + 0.6)); };
    },
    propeller(C, F, g, A) {
      // A six-panel beanie with a short visor; the propeller spins with motion and keeps its angle.
      // Between ears (bumps beside the head top) the blades are shorter and rest front to back.
      const p = F.rho, b = F.b, sh = shellOf(g, F), bump = !!(A && headInfo(A).bumps), bl = bump ? 0.6 : 0.82;
      const red = C.col('e8434f', '3d7bf2'), yel = C.col('ffcf3a', '3fb56b'), blu = C.col('3d7bf2', 'e8434f');
      const Rc = 1.05 * p, Bc = Math.max(b + 0.08 * p, 0.55 * p), y0 = -0.03 * p, prof = [[0, y0]];
      const f0 = Math.asin(clamp(y0 / Bc, -1, 1));
      for (let i = 0; i <= 22; i++) { const f = lerp(f0, Math.PI / 2, i / 22); prof.push([Rc * Math.cos(f), Bc * Math.sin(f)]); }
      const SEG = 120, seam = (x, y, z) => {
        const r = Math.hypot(x, z);
        if (r < 1e-6) return [x, y, z];
        const th = Math.atan2(x, z), d = Math.abs(((th - Math.PI / 6 + 2 * TAU) % (Math.PI / 3)) - Math.PI / 6) - Math.PI / 6;
        const k = (r - 0.012 * p * Math.exp(-(d * d) / 0.0016) * sstep(0.02 * p, 0.12 * p, y) * (1 - Math.pow(clamp(y / Bc, 0, 1), 6))) / r;
        return [x * k, y, z * k];
      };
      const cap = lathe(prof, SEG, seam), per = cap.index.count / SEG;
      cap.clearGroups();
      // panel k spans columns 10 + 20k .. 30 + 20k (azimuth 30 + 60k .. 90 + 60k degrees); the front one is red
      for (let k = 0; k < 6; k++) {
        const c0 = 10 + 20 * k, m = (k + 1) % 3;
        if (c0 + 20 <= SEG) cap.addGroup(c0 * per, 20 * per, m);
        else { cap.addGroup(c0 * per, (SEG - c0) * per, m); cap.addGroup(0, (c0 + 20 - SEG) * per, m); }
      }
      C.mesh(sh, cap, [C.mat('fabric', red), C.mat('fabric', yel), C.mat('fabric', blu)], 'propeller-cap');
      const fm = 1.1, visor = slab(24, 8, (s, t) => {
        const ph = (s - 0.5) * 2 * fm, L = 0.42 * p * Math.pow(Math.max(0, Math.cos((ph / fm) * (Math.PI / 2))), 0.5) + 1e-4, r = 0.96 * p + t * L;
        return [r * Math.sin(ph), 0.015 * p - 0.1 * p * Math.pow(t, 1.6) * (L / (0.42 * p)), r * Math.cos(ph)];
      }, (s, t) => 0.024 * p * Math.pow(Math.sin(Math.PI * s), 0.35) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 6))));
      C.mesh(sh, visor, C.mat('fabric', blu), 'propeller-visor');
      const stemH = 0.16 * p, stem = new THREE.CylinderGeometry(0.028 * p, 0.036 * p, stemH, 12, 1);
      stem.translate(0, Bc + stemH / 2 - 0.01 * p, 0);
      C.mesh(g, stem, C.metalMat('silver'), 'propeller-stem');
      const spin = new THREE.Group();
      spin.position.set(0, Bc + stemH, 0);
      g.add(spin);
      C.mesh(spin, sphere(0.065 * p, 0.05 * p, 0.065 * p, 16, 10), C.mat('plastic', yel), 'propeller-hub');
      const blade = (sg) => slab(10, 14, (u, v) => {
        const x = sg * (0.04 * p + v * bl * p), wv = 0.24 * p * Math.pow(Math.sin(Math.PI * Math.min(1, 0.15 + 0.85 * v)), 0.6) + 0.04 * p, tw = sg * (0.5 - 0.25 * v), c = (u - 0.5) * wv;
        return [x, c * Math.sin(tw), c * Math.cos(tw)];
      }, (u, v) => 0.012 * p * Math.pow(Math.sin(Math.PI * u), 0.4) * Math.sqrt(Math.max(0, 1 - Math.pow(v, 8))));
      C.mesh(spin, blade(1), C.mat('plastic', red), 'propeller-blade');
      C.mesh(spin, blade(-1), C.mat('plastic', blu), 'propeller-blade');
      let ang = bump ? Math.PI / 2 : 0, last = null;
      spin.rotation.y = ang;
      g.userData.update = (t, m) => {
        const k = m == null ? 1 : m, dt = last == null ? 0 : clamp(t - last, 0, 0.1);
        last = t;
        if (k > 0 && dt > 0) { ang = (ang + 7.5 * k * dt) % TAU; spin.rotation.y = ang; }
      };
    }
  };

  // Ribbon bow: two lobes, a knot and two notched tails, facing `face`, sized by `size` (overall width).
  function bowAt(C, parent, at, face, upHint, size, color, name) {
    const Fz = norm(face), Fy = perpTo(upHint, Fz), Fx = cross(Fy, Fz);
    const L = 0.44 * size, Hh = 0.32 * size, D = 0.18 * size, parts = [];
    for (const sg of [-1, 1]) {
      const lb = lobe(L, Hh / 2, D / 2, 0.35);
      lb.rotateZ(sg > 0 ? 0.22 : Math.PI - 0.22);
      parts.push(lb);
    }
    parts.push(sphere(0.12 * size, 0.14 * size, 0.1 * size, 18, 12));
    for (const sg of [-1, 1]) {
      const Lt = 0.36 * size, Wt = 0.13 * size;
      const tail = slab(6, 12, (s, t) => {
        const along = t * Lt * (1 - 0.24 * (1 - Math.abs(2 * s - 1)) * sstep(0.7, 1, t) * 4 * 0.25) + 1e-4;
        const x = (s - 0.5) * Wt * (1 + 0.3 * t);
        const ang = sg * 0.42;
        return [x * Math.cos(ang) + along * Math.sin(ang), -along * Math.cos(ang) + x * Math.sin(ang) - 0.04 * size, -0.03 * size - 0.05 * size * t * t];
      }, (s, t) => 0.016 * size * Math.sqrt(Math.sin(Math.PI * s)) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 8))));
      parts.push(tail);
    }
    const geo = merge(parts);
    put(geo, at, Fx, Fy, Fz);
    return C.mesh(parent, geo, C.mat('fabric', color), name);
  }

  // A rounded cat ear standing on `base`, pointing along `up`, its face toward `face`; h = height.
  function catEar(C, parent, base, up, face, h, outerMat, innerMat, name, innerNoShadow) {
    const U = norm(up), Fz = perpTo(face, U), X = cross(U, Fz);
    const tri = ccw(resample(chaikin([[-0.5 * h, 0], [0.5 * h, 0], [0.04 * h, 1.04 * h]], 3), 48));
    const outer = extrude(tri, [], 0.16 * h, 0.07 * h);
    put(outer, base, X, U, Fz);
    C.mesh(parent, outer, outerMat, name);
    const inner = extrude(scale2(tri, 0.58, 0.6, 0, 0.3 * h), [], 0.05 * h, 0.03 * h);
    inner.translate(0, 0.05 * h, 0.13 * h);
    put(inner, base, X, U, Fz);
    C.mesh(parent, inner, innerMat, name + '-inner', !!innerNoShadow);
  }
  // A white skull and crossbones in relief, facing `face` with `up` up; q = size unit (skull radius).
  function skullAt(C, parent, at, up, face, q, name) {
    const Z = norm(face), Y = perpTo(up, Z), X = cross(Y, Z);
    const head = sphere(q, 0.92 * q, 0.42 * q, 22, 16);
    head.translate(0, 0.12 * q, 0);
    const jaw = sphere(0.6 * q, 0.42 * q, 0.36 * q, 18, 12);
    jaw.translate(0, -0.6 * q, 0);
    const bones = [head, jaw];
    for (const sg of [-1, 1]) {
      const a = sg * 0.8, d = [-Math.sin(a), Math.cos(a)], pp = [Math.cos(a), Math.sin(a)];
      const bn = new THREE.CapsuleGeometry(0.12 * q, 2.3 * q, 4, 10);
      bn.rotateZ(a);
      bn.translate(0, -0.25 * q, -0.2 * q);
      bones.push(bn);
      for (const e of [-1, 1]) for (const f of [-1, 1]) {
        const k = sphere(0.17 * q, 0.17 * q, 0.15 * q, 10, 8);
        k.translate(e * 1.27 * q * d[0] + f * 0.12 * q * pp[0], -0.25 * q + e * 1.27 * q * d[1] + f * 0.12 * q * pp[1], -0.2 * q);
        bones.push(k);
      }
    }
    const geo = merge(bones);
    put(geo, at, X, Y, Z);
    C.mesh(parent, geo, C.mat('enamel', 'f6f1e6'), name);
    const holes = [];
    for (const sg of [-1, 1]) { const e = sphere(0.25 * q, 0.27 * q, 0.1 * q, 14, 10); e.translate(sg * 0.36 * q, 0.04 * q, 0.33 * q); holes.push(e); }
    const nose = sphere(0.09 * q, 0.12 * q, 0.06 * q, 10, 8);
    nose.translate(0, -0.28 * q, 0.36 * q);
    holes.push(nose);
    const hg = merge(holes);
    put(hg, at, X, Y, Z);
    C.mesh(parent, hg, C.mat('ink', '1e1c22'), name + '-eyes');
  }

  // Over-ear headphones: cups on the sides at eye level, a band over the head (trap 8).
  // o {name, main, accent, pad, k (cup scale), bandR, bandT, glow}. Returns {cups, band, Rc}.
  function phones(C, A, g, o) {
    const Rc = clamp(0.11 * A.height, 0.1, 0.19) * (o.k || 1), Tc = 0.62 * Rc, tops = [], cups = [];
    for (const side of [-1, 1]) {
      const sd = side < 0 ? A.sideL : A.sideR;
      let ax = norm([sd.n[0], sd.n[1] * 0.2, sd.n[2] * 0.4]);
      if (Math.sign(ax[0]) !== side) ax = [side, 0, 0];
      const at = add(sd.p, mul(ax, C.fur * 0.7 + 0.01));
      const zf = perpTo([0, 0, 1], ax), xf = cross(ax, zf);
      const hold = new THREE.Group();
      M4.makeBasis(V3(xf), V3(ax), V3(zf));
      hold.quaternion.setFromRotationMatrix(M4);
      hold.position.set(at[0], at[1], at[2]);
      g.add(hold);
      const cush = new THREE.TorusGeometry(0.76 * Rc, 0.24 * Rc, 12, 40);
      cush.rotateX(Math.PI / 2);
      cush.translate(0, 0.2 * Rc, 0);
      C.mesh(hold, cush, C.mat('rubber', o.pad), o.name + '-pad');
      const y1 = 0.2 * Rc + Tc, rr = 0.16 * Rc, prof = [[0, 0.2 * Rc], [Rc * 0.9, 0.2 * Rc], [Rc, 0.3 * Rc], [Rc, y1 - rr]];
      for (let i = 1; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); prof.push([Rc - rr + rr * Math.cos(a), y1 - rr + rr * Math.sin(a)]); }
      prof.push([0.5 * Rc, y1 + 0.02 * Rc], [0, y1 + 0.03 * Rc]);
      C.mesh(hold, lathe(prof, 48), C.mat('plastic', o.main), o.name + '-cup');
      const capP = [[0, 0], [0.6 * Rc, 0]];
      for (let i = 1; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); capP.push([0.6 * Rc - 0.06 * Rc + 0.06 * Rc * Math.cos(a), 0.06 * Rc * Math.sin(a)]); }
      capP.push([0, 0.075 * Rc]);
      const cap = lathe(capP, 40);
      cap.translate(0, y1 + 0.005 * Rc, 0);
      C.mesh(hold, cap, C.mat('plastic', o.accent), o.name + '-accent');
      if (o.glow) {
        const ring = new THREE.TorusGeometry(0.8 * Rc, 0.06 * Rc, 10, 48);
        ring.rotateX(Math.PI / 2);
        ring.translate(0, y1 - 0.025 * Rc, 0);
        C.mesh(hold, ring, C.mat('emissive', o.glow), o.name + '-glow', true);
      }
      const mid = add(at, mul(ax, 0.2 * Rc + Tc * 0.5));
      tops.push(add(mid, mul(perpTo([0, 1, 0], ax), Rc * 0.8)));
      cups.push({ side, at, ax, zf, y1 });
    }
    const F = hatFrame(A, C.fur), S = headSec(A), I = S.info, bR = (o.bandR || 0.14) * Rc, bT = (o.bandT || 0.06) * Rc;
    const band = overHead(F, S, tops[0], tops[1], { tilt: I.tilt, clear: 0.02 + bR, fur: C.fur * 0.85, apex: (I.bumps || I.topEyes ? I.ht : A.top.p[1]) + C.fur + 0.06, n: 40 });
    C.mesh(g, sweep(band.pts, { radius: [bR, bT], up: (i) => band.nrm[i], radial: 14 }), C.mat('plastic', o.main), o.name + '-band');
    return { cups, band, Rc, Tc, S };
  }

  // A slim headband over the head, its ends on the sides a little below the hat ring (trap 8).
  function aliceBand(C, F, S, s, color, name, parent) {
    const I = S.info, n = 40, yE = I.topEyes ? S.ye - 0.25 * Math.abs(S.yr - S.ye) : lerp(S.ye, S.yr, 0.55), push = C.fur * 0.85 + 0.03 * s;
    const ends = [-1, 1].map((sd) => S.pt(yE, (sd * Math.PI) / 2, push));
    const band = overHead(F, S, ends[0], ends[1], { tilt: I.tilt, clear: 0.03 * s, fur: C.fur * 0.85, apex: I.ht + C.fur + 0.04, n });
    C.mesh(parent, sweep(band.pts, { radius: [0.055 * s, 0.024 * s], up: (i) => band.nrm[i], radial: 10 }), C.mat('plastic', color), name);
    return { band, n, X: norm(sub(ends[1], ends[0])) };
  }

  // The glasses frame: origin in front of the brow, axes G.X, G.Y, G.Z.
  function faceGroup(G, root) {
    const fg = new THREE.Group();
    M4.makeBasis(V3(G.X), V3(G.Y), V3(G.Z));
    fg.quaternion.setFromRotationMatrix(M4);
    fg.position.set(G.o[0], G.o[1], G.o[2]);
    root.add(fg);
    return fg;
  }

  /* ---- glasses ---- */

  // The one big eye of a cyclops face (face.js 'eyeC'): ctx.eyeC {p (skin point under the eye
  // center), r, n?} measured from the built face wins; else ctx.faceMeta (shape.face) with eyes
  // 'cyclops' gives it by face.js's own rule (midpoint of the eye anchors raised 0.25 x their
  // spacing, radius 1.2 x eyeSize clamped to [0.2, 0.55] x spacing). The eye stands 0.54 r above
  // the fur-lifted skin. Returns null for two-eyed faces; lens is the single lens center in G.
  function cyclopsEye(A, ctx, fur, G) {
    const e = ctx && ctx.eyeC, fm = ctx && (ctx.faceMeta || ctx.face);
    const nL = fin3(A.eyeL.n) ? norm(A.eyeL.n) : [0, 0, 1], nR = fin3(A.eyeR.n) ? norm(A.eyeR.n) : [0, 0, 1], nAvg = norm(add(nL, nR));
    let c, r, n;
    if (e && fin3(e.p) && e.r > 0) { c = e.p.slice(0, 3); r = +e.r; n = fin3(e.n) ? norm(e.n) : norm(unblend(nAvg)); }
    else if (fm && fm.eyes === 'cyclops') {
      // face.js casts the eye onto the surface 0.25 S above the eye midpoint. Without the SDF, the
      // face there is taken as the sphere that the two eye anchors and their (unblended) normals
      // span: the midpoint lies under it by the sagitta, and the cast point and its normal follow.
      const S = clamp(len(sub(A.eyeR.p, A.eyeL.p)), 0.1, 1.4), es = fm.eyeSize > 0 ? +fm.eyeSize : 0.15 * S;
      r = clamp(es >= 0.11 ? 1.2 * es : 2.2 * es, 0.2 * S, 0.55 * S);
      const nl = norm(unblend(nL)), nr = norm(unblend(nR)), na = norm(add(nl, nr)), ph = Math.acos(clamp(dot(nl, nr), -1, 1)) / 2;
      const Rs = ph > 0.02 ? clamp(S / 2 / Math.sin(ph), 0.6 * S, 6 * S) : 6 * S, mid = mix3(A.eyeL.p, A.eyeR.p, 0.5);
      const Cs = sub(add(mid, mul(na, Rs * (1 - Math.cos(Math.min(ph, 1.2))))), mul(na, Rs)), y = mid[1] + 0.25 * S;
      const h = Rs * Rs - (y - Cs[1]) * (y - Cs[1]) - (mid[0] - Cs[0]) * (mid[0] - Cs[0]);
      if (h > 0.04 * Rs * Rs) { c = [mid[0], y, Cs[2] + Math.sqrt(h)]; n = norm(sub(c, Cs)); }
      else { const Hs = headSec(A), cc = Hs.C(y); c = Hs.pt(y, Math.atan2(mid[0] - cc[0], mid[2] - cc[1]), 0); n = na; }
    } else return null;
    // The eye is a dome of radius r standing 0.54 r on a surface that may lean back: its lowest edge
    // can come further forward than its center, so the lens clears the whole disc.
    const front = add(c, mul(n, 0.54 * r + 0.8 * fur)), d = sub(front, G.o), nz = clamp(dot(n, G.Z), -1, 1);
    const reach = dot(sub(c, G.o), G.Z) + 0.8 * fur + r * Math.sqrt(Math.max(0, 1 - nz * nz)) + 0.54 * r * Math.max(nz, 0);
    return { c, n, r, front, lens: [dot(d, G.X), dot(d, G.Y), Math.max(reach, dot(d, G.Z)) + 0.05 * r + 0.02] };
  }
  function lensGroup(G, side, wrap, vc) {
    const lg = new THREE.Group();
    lg.position.set(side * G.S / 2, vc, 0);
    lg.rotation.set(0, side * wrap, 0);
    return lg;
  }
  const xfPt = (obj, p) => { obj.updateMatrix(); const v = V3(p).applyMatrix4(obj.matrix); return [v.x, v.y, v.z]; };
  // Temple arm from a hinge (object space) back along the eye-level head ellipse to just past the side.
  function temple(G, hinge, side, rad, fur) {
    const off = fur * 0.8 + 0.035 * G.S, ax = G.ax + off, az = G.az + off;
    const ph0 = Math.atan2((hinge[0] - G.Ce[0]) / ax, (hinge[2] - G.Ce[2]) / az);
    const side3 = side < 0 ? G.sL : G.sR, pts = [hinge];
    const ph1 = side * 1.72;
    for (let i = 1; i <= 10; i++) {
      const t = i / 10, ph = lerp(ph0 + side * 0.18, ph1, t), y = lerp(hinge[1], side3[1] + 0.03 * G.S, sstep(0, 1, t));
      pts.push([G.Ce[0] + ax * Math.sin(ph), y, G.Ce[2] + az * Math.cos(ph)]);
    }
    return sweep(crPts(pts, 24), { radius: rad, radial: 8 });
  }
  // Lens frames: spec {outline (the +x lens, outer side at +x), single (symmetric outline for a
  // cyclops, else outline), torus + wire (round wire frames), rim, depth, bevel, frameMat, lensMat,
  // bridge, arch, arm, deco(lensGroup, side, outline)}. Two lenses on the eyes, or one lens on a
  // cyclops eye, sized so its opening clears the eye, with temples on both sides and no bridge.
  function framedGlasses(C, root, G, spec) {
    const fg = faceGroup(G, root), Y = G.cyc, frameMat = spec.frameMat, lensMat = spec.lensMat, lenses = [];
    if (Y) {
      const base = spec.single || spec.outline, b0 = bbox2(base), cx = (b0.x0 + b0.x1) / 2, cy = (b0.y0 + b0.y1) / 2, rim = spec.torus ? spec.wire : spec.rim;
      const k = Math.max((1.1 * Y.r + rim) / (b0.w / 2), (1.02 * Y.r + rim) / (b0.h / 2));
      lenses.push({ side: 0, pos: Y.lens, wrap: 0, out: base.map((q) => [(q[0] - cx) * k, (q[1] - cy) * k]), torus: spec.torus ? 1.1 * Y.r + rim : 0 });
    } else {
      for (const side of [-1, 1]) lenses.push({ side, pos: [(side * G.S) / 2, G.vc, 0], wrap: side * 0.16, out: side < 0 ? spec.outline.map((q) => [-q[0], q[1]]) : spec.outline, torus: spec.torus || 0 });
    }
    const hinges = [], inner = [];
    for (const L of lenses) {
      const lg = new THREE.Group();
      lg.position.set(L.pos[0], L.pos[1], L.pos[2]);
      lg.rotation.set(0, L.wrap, 0);
      fg.add(lg);
      const o2 = L.out, bb = bbox2(o2), cyy = (bb.y0 + bb.y1) / 2;
      if (L.torus) C.mesh(lg, new THREE.TorusGeometry(L.torus, spec.wire, 10, 72), frameMat, 'glasses-frame');
      else C.mesh(lg, extrude(o2, [scale2(o2, 1 - (2 * spec.rim) / bb.w, 1 - (2 * spec.rim) / bb.h, 0, cyy)], spec.depth, spec.bevel), frameMat, 'glasses-frame');
      const lensOut = L.torus ? ellipse2(L.torus, L.torus, 56) : scale2(o2, 1 - (2 * spec.rim) / bb.w + 0.01, 1 - (2 * spec.rim) / bb.h + 0.01, 0, cyy);
      if (lensMat) C.mesh(lg, extrude(lensOut, [], 0.006 * G.S, 0), lensMat, 'glasses-lens', true);
      if (spec.deco) spec.deco(lg, L.side, o2);
      // hinges on the outer edges (both edges of a single lens), the bridge from the inner edges
      const hy = L.torus ? L.torus * 0.25 : bb.y1 * 0.45, edge = (sd) => (L.torus ? sd * L.torus : sd > 0 ? bb.x1 : bb.x0);
      for (const sd of L.side ? [L.side] : [-1, 1]) hinges.push([sd, G.w(xfPt(lg, [edge(sd), hy, -0.01 * G.S]))]);
      if (L.side) inner.push(xfPt(lg, [0.95 * edge(-L.side), L.torus ? L.torus * 0.2 : bb.y1 * 0.25, 0]));
    }
    if (inner.length === 2) {
      const mid = [0, (inner[0][1] + inner[1][1]) / 2 + spec.arch * G.S, -0.02 * G.S];
      C.mesh(fg, sweep(crPts([inner[0], mid, inner[1]], 16), { radius: spec.bridge, radial: 8 }), frameMat, 'glasses-bridge');
    }
    for (const [sd, h] of hinges) C.mesh(root, temple(G, h, sd, spec.arm, C.fur), frameMat, 'glasses-temple');
    return fg;
  }

  const GLASSES = {
    round(C, G, g) {
      const rl = 0.33 * G.S;
      framedGlasses(C, g, G, { outline: ellipse2(rl, rl, 56), torus: rl, wire: 0.022 * G.S, frameMat: C.metalMat('gold'), lensMat: C.mat('lens-clear', 'f4fbff'), bridge: 0.018 * G.S, arch: 0.08, arm: 0.016 * G.S });
    },
    square(C, G, g) {
      framedGlasses(C, g, G, { outline: rrect2(0.74 * G.S, 0.58 * G.S, 0.15 * G.S, 72), rim: 0.075 * G.S, depth: 0.04 * G.S, bevel: 0.016 * G.S, frameMat: C.mat('plastic', C.col('25232b', 'f05a7e')), lensMat: C.mat('lens-clear', 'f4fbff'), bridge: 0.032 * G.S, arch: 0.02, arm: 0.026 * G.S });
    },
    sunnies(C, G, g) {
      const S = G.S, sc = (pts) => ccw(resample(chaikin(pts.map((q) => [q[0] * S, q[1] * S]), 3), 72));
      const out = sc([[-0.4, 0.26], [0.4, 0.26], [0.39, 0.02], [0.27, -0.24], [0.04, -0.3], [-0.24, -0.26], [-0.38, 0.0]]);
      const single = sc([[-0.42, 0.26], [0.42, 0.26], [0.41, 0.0], [0.27, -0.24], [0.0, -0.3], [-0.27, -0.24], [-0.41, 0.0]]);
      framedGlasses(C, g, G, { outline: out, single, rim: 0.05 * S, depth: 0.04 * S, bevel: 0.014 * S, frameMat: C.mat('plastic', C.col('1f1e25', 'f2f2f5')), lensMat: C.mat('lens-dark', '1a1c22'), bridge: 0.03 * S, arch: 0.03, arm: 0.026 * S });
    },
    hearts(C, G, g) {
      framedGlasses(C, g, G, { outline: heart2(0.82 * G.S, 72), rim: 0.06 * G.S, depth: 0.04 * G.S, bevel: 0.014 * G.S, frameMat: C.mat('plastic', C.col('ff4f8b', 'b5179e')), lensMat: C.mat('lens-tint', 'ff7fb0'), bridge: 0.028 * G.S, arch: 0.05, arm: 0.024 * G.S });
    },
    stars(C, G, g) {
      framedGlasses(C, g, G, { outline: star2(0.46 * G.S, 0.25 * G.S, 5, 90, 2), rim: 0.06 * G.S, depth: 0.04 * G.S, bevel: 0.014 * G.S, frameMat: C.mat('plastic', C.col('ffc93c', '7b5cff')), lensMat: C.mat('lens-tint', '8fd3ff'), bridge: 0.028 * G.S, arch: 0.03, arm: 0.024 * G.S });
    },
    monocle(C, G, g, A) {
      const fg = faceGroup(G, g), Y = G.cyc, rl = Y ? 1.1 * Y.r + 0.03 * G.S : 0.36 * G.S, gold = C.metalMat('gold');
      const lg = Y ? new THREE.Group() : lensGroup(G, 1, 0.16, G.vc);
      if (Y) lg.position.set(Y.lens[0], Y.lens[1], Y.lens[2]);
      fg.add(lg);
      C.mesh(lg, new THREE.TorusGeometry(rl, 0.03 * G.S, 12, 72), gold, 'monocle-ring');
      C.mesh(lg, extrude(ellipse2(rl, rl, 56), [], 0.006 * G.S, 0), C.mat('lens-clear', 'f4fbff'), 'monocle-lens', true);
      const a = -0.9, start = G.w(xfPt(lg, [rl * Math.cos(a) * 1.05, rl * Math.sin(a) * 1.05, -0.01 * G.S]));
      const N = neckFrame(A, C.fur), end = N.pt(0.9, 0.02, 0.02);
      const mid = add(mix3(start, end, 0.5), [0.04, -0.07, 0.05]);
      const path = crPts([start, mid, end], 60), links = [];
      let acc = 0, li = 0;
      const pitch = 0.05 * G.S;
      for (let i = 1; i < path.length && li < 40; i++) {
        acc += len(sub(path[i], path[i - 1]));
        if (acc < pitch) continue;
        acc = 0;
        const t = norm(sub(path[i], path[i - 1])), up = li % 2 ? perpTo([0, 0, 1], t) : perpTo([1, 0, 0], t);
        const lk = new THREE.TorusGeometry(0.017 * G.S, 0.0045 * G.S, 6, 12);
        lk.scale(1.5, 1, 1);
        put(lk, path[i], t, up, cross(t, up));
        links.push(lk);
        li++;
      }
      if (links.length) C.mesh(g, merge(links), gold, 'monocle-chain');
    },
    visor(C, G, g) {
      // A cyclops visor rides at the eye's height, tall enough to cover it and clear of its dome.
      const S = G.S, Y = G.cyc, off = C.fur * 0.8 + 0.13 * S + 0.012, ax = G.ax + off;
      const az = Y ? Math.max(G.az + off + 0.02 * S, Y.front[2] - G.Ce[2] + 0.07 * S) : G.az + off + 0.02 * S;
      const y = Y ? Y.front[1] : G.br[1] - 0.03 * S, hh = Y ? Math.max(0.27 * S, 1.2 * Y.r) : 0.27 * S;
      const arc = (ph0, ph1, push, n) => { const o = []; for (let i = 0; i <= n; i++) { const ph = lerp(ph0, ph1, i / n); o.push([G.Ce[0] + (ax + push) * Math.sin(ph), y, G.Ce[2] + (az + push) * Math.cos(ph)]); } return o; };
      const band = C.col('22252f', 'eef1f6'), glow = C.col('5ff2ff', 'ff5fb0', 0.1);
      C.mesh(g, sweep(arc(-1.78, 1.78, 0, 48), { radius: [0.04 * S, hh], up: [0, 1, 0], radial: 20, capSegs: 5 }), C.mat('plastic', band), 'visor-band');
      C.mesh(g, sweep(arc(-1.3, 1.3, 0.04 * S, 40), { radius: 0.022 * S, up: [0, 1, 0], radial: 8 }), C.mat('emissive', glow), 'visor-glow', true);
    },
    eyepatch(C, G, g, A) {
      // A puffy leather shield over the viewer's right eye (+x), or over a cyclops eye, cupped to the
      // face, on a strap that runs behind it and rises across the forehead to clear the other eye.
      const Sx = G.S, Y = G.cyc, fg = faceGroup(G, g), col = C.col('1f1e25', '6b3a2a'), leather = C.mat('leather', col);
      const lg = Y ? new THREE.Group() : lensGroup(G, 1, 0.16, G.vc);
      if (Y) lg.position.set(Y.lens[0], Y.lens[1], Y.lens[2] - 0.03 * Y.r);
      fg.add(lg);
      const w = Y ? 1.16 * Y.r : 0.34 * Sx, h = Y ? 1.06 * Y.r : 0.3 * Sx, cup = Y ? 2.2 * Y.r : 0.9 * Sx, tz = 0.06 * Sx;
      const patch = deform(new THREE.SphereGeometry(1, 30, 22), (x, y, z) => {
        const X = x * w * (1 - 0.2 * Math.max(0, -y)), Yy = y * h, Z = z * tz * (z > 0 ? 1 : 0.4);
        return [X, Yy, Z - (X * X + Yy * Yy) / (2 * cup)];
      });
      patch.translate(0, 0, -0.02 * Sx);
      C.mesh(lg, patch, leather, 'eyepatch-patch');
      const S = headSec(A), I = S.info, push = C.fur * 0.85 + 0.022;
      let knots;
      if (Y) {
        const d0 = (Y.c[1] - S.ye) / Sx;
        knots = [[0, d0], [Math.PI / 2, d0 + 0.06], [Math.PI, d0 + 0.12], [1.5 * Math.PI, d0 + 0.06]];
      } else {
        const ce = S.C(S.ye), phE = Math.atan2(A.eyeR.p[0] - ce[0], A.eyeR.p[2] - ce[1]);
        const k = I.topEyes ? [0, -0.25, -0.3, -0.35, -0.25] : [0.2, 0.15, 0.12, 0.3, 0.46];
        knots = [[phE, k[0]], [1.65, k[1]], [Math.PI, k[2]], [TAU - 1.7, k[3]], [TAU + phE - 0.85, k[4]]];
      }
      const loop = headLoop(S, Sx, knots, push, 96);
      C.mesh(g, sweep(loop.pts, { closed: true, radius: [0.045 * Sx, 0.012 * Sx], up: (i) => loop.nrm[i], radial: 10 }), leather, 'eyepatch-strap');
    },
    cateye(C, G, g) {
      // Upswept outer corners with three little rhinestones on each; a cyclops gets both corners.
      const S = G.S, sc = (pts) => ccw(resample(chaikin(pts.map((q) => [q[0] * S, q[1] * S]), 3), 84));
      const out = sc([[-0.36, 0.05], [-0.31, 0.19], [-0.08, 0.25], [0.2, 0.27], [0.42, 0.37], [0.48, 0.33], [0.41, 0.08], [0.27, -0.17], [0.03, -0.26], [-0.22, -0.22], [-0.35, -0.09]]);
      const single = sc([[0, 0.24], [0.24, 0.26], [0.44, 0.37], [0.5, 0.33], [0.42, 0.08], [0.28, -0.17], [0, -0.25], [-0.28, -0.17], [-0.42, 0.08], [-0.5, 0.33], [-0.44, 0.37], [-0.24, 0.26]]);
      const gem = C.mat('gem', C.col('fff6fb', 'a8e6ff', 0.08));
      framedGlasses(C, g, G, {
        outline: out, single, rim: 0.085 * S, depth: 0.045 * S, bevel: 0.016 * S, frameMat: C.mat('plastic', C.col('e0457b', '2a2630')), lensMat: C.mat('lens-clear', 'f4fbff'), bridge: 0.03 * S, arch: 0.04, arm: 0.026 * S,
        deco: (lg, side, o2) => {
          // on the frame just inside the upper outer corner(s)
          const list = [], topY = (x) => { let m = -1e9; for (const q of o2) if (Math.abs(q[0] - x) < 0.03 * S && q[1] > m) m = q[1]; return m; };
          for (const sd of side ? [side] : [-1, 1]) {
            let c0 = o2[0];
            for (const q of o2) if (sd * q[0] + q[1] > sd * c0[0] + c0[1]) c0 = q;
            for (const [f, r] of [[0.82, 0.032], [0.64, 0.026], [0.47, 0.021]]) {
              const x = c0[0] * f, d = sphere(r * S, r * S, 0.5 * r * S, 12, 8);
              d.translate(x, topY(x) - 0.036 * S, 0.04 * S);
              list.push(d);
            }
          }
          C.mesh(lg, merge(list), gem, 'cateye-gems');
        }
      });
    },
    goggles(C, G, g, A) {
      // Aviator goggles: leather cups with metal rims and amber lenses on a strap around the head
      // at eye level; a cyclops gets one big cup.
      const Sx = G.S, Y = G.cyc, fg = faceGroup(G, g), leather = C.mat('leather', C.col('7a4a2a', 'c8a27a')), rimM = C.metalMat('silver'), lensM = C.mat('lens-tint', 'ffb347');
      const lenses = Y ? [{ side: 0, R: 1.2 * Y.r, D: 0.6 * Y.r + 0.8 * C.fur + 0.03 }] : [{ side: -1, R: 0.34 * Sx, D: 0.13 * Sx }, { side: 1, R: 0.34 * Sx, D: 0.13 * Sx }];
      const ends = [], inner = [];
      for (const L of lenses) {
        const lg = L.side ? lensGroup(G, L.side, 0.16, G.vc) : new THREE.Group();
        if (!L.side) lg.position.set(Y.lens[0], Y.lens[1], Y.lens[2]);
        fg.add(lg);
        const R = L.R, cup = lathe(rrLoop(0.8 * R, 1.1 * R, -L.D, 0.01 * Sx, 0.035 * Sx, 4), 48);
        cup.rotateX(Math.PI / 2);
        C.mesh(lg, cup, leather, 'goggles-cup');
        const rim = new THREE.TorusGeometry(0.95 * R, 0.07 * R, 10, 56);
        rim.translate(0, 0, 0.012 * Sx);
        C.mesh(lg, rim, rimM, 'goggles-rim');
        C.mesh(lg, extrude(ellipse2(0.9 * R, 0.9 * R, 56), [], 0.006 * Sx, 0), lensM, 'goggles-lens', true);
        for (const sd of L.side ? [L.side] : [-1, 1]) ends.push([sd, G.w(xfPt(lg, [sd * 1.08 * R, 0, -0.5 * L.D]))]);
        if (L.side) inner.push(xfPt(lg, [-L.side * 1.02 * R, 0.08 * R, -0.3 * L.D]));
      }
      if (inner.length === 2) C.mesh(fg, sweep(crPts([inner[0], [0, (inner[0][1] + inner[1][1]) / 2 + 0.04 * Sx, -0.04 * Sx], inner[1]], 12), { radius: [0.05 * Sx, 0.016 * Sx], up: [0, 0, 1], radial: 8 }), leather, 'goggles-bridge');
      // the strap: from the right cup round the back of the head to the left cup
      const S = headSec(A), push = C.fur * 0.85 + 0.018, eR = ends.find((e) => e[0] > 0)[1], eL = ends.find((e) => e[0] < 0)[1];
      const az = (p) => { const c = S.C(p[1]); return Math.atan2(p[0] - c[0], p[2] - c[1]); };
      const a0 = az(eR) + 0.22, a1 = TAU + az(eL) - 0.22, pts = [eR];
      for (let i = 0; i <= 16; i++) { const t = i / 16; pts.push(S.pt(lerp(eR[1], eL[1], t), lerp(a0, a1, t), push)); }
      pts.push(eL);
      const path = crPts(pts, 64).map((p, i, all) => {
        if (i < 3 || i > all.length - 4) return p;
        const c = S.C(p[1]), ph = Math.atan2(p[0] - c[0], p[2] - c[1]), r = Math.hypot(p[0] - c[0], p[2] - c[1]), need = S.R(p[1], ph) + push;
        return r < need ? [c[0] + need * Math.sin(ph), p[1], c[1] + need * Math.cos(ph)] : p;
      });
      const up = path.map((p) => { const c = S.C(p[1]); return S.n(p[1], Math.atan2(p[0] - c[0], p[2] - c[1])); });
      C.mesh(g, sweep(path, { radius: [0.075 * Sx, 0.014 * Sx], up: (i) => up[i], radial: 10 }), leather, 'goggles-strap');
    }
  };

  /* ---- extras ---- */

  const EXTRAS = {
    bowtie(C, A, g) {
      const N = neckFrame(A, C.fur), u = N.u, at = N.pt(0, 0.03 * u, 0.01 * u);
      const color = C.col('d8304a', '2b3a67'), parts = [];
      for (const sg of [-1, 1]) {
        const lb = deform(new THREE.SphereGeometry(1, 24, 16), (x, y, z) => {
          const s = (x + 1) / 2, g2 = 0.3 + 0.7 * Math.pow(s, 0.7);
          return [sg * s * 0.33 * u, y * 0.135 * u * g2 * (1 + 0.25 * s), z * 0.055 * u * (0.6 + 0.4 * g2) - 0.015 * u * Math.max(0, z) * (1 - y * y)];
        });
        if (sg < 0) { orient(lb); weldGrid(lb, 25, 17, false); }
        parts.push(lb);
      }
      parts.push(sphere(0.075 * u, 0.085 * u, 0.06 * u, 16, 12));
      const geo = merge(parts);
      put(geo, at, [1, 0, 0], [0, 1, 0], [0, 0, 1]);
      C.mesh(g, geo, C.mat('fabric', color), 'bowtie');
    },
    scarf(C, A, g) {
      const N = neckFrame(A, C.fur), u = N.u, main = C.col('e2475c', '2a9d8f'), stripe = C.col('fff1dc', '3b3a4a');
      const th = 0.07 * u, ring = [];
      for (let i = 0; i < 96; i++) { const ph = (i / 96) * TAU; ring.push(add(N.pt(ph, th * 0.9, -0.02 * u * Math.cos(ph) + 0.008 * u * Math.sin(3 * ph)), [0, 0, 0])); }
      const mats2 = [C.mat('knit', main), C.mat('knit', stripe)];
      const band = sweep(ring, { closed: true, radius: (t) => [th * (1 + 0.1 * Math.cos(t * TAU * 48)), 0.13 * u], up: [0, 1, 0], radial: 16, segMat: (q) => ((q % 12) < 2 ? 1 : 0) });
      C.mesh(g, band, mats2, 'scarf-band');
      const ph = 0.55, top = N.pt(ph, th * 1.6, -0.07 * u), tg = norm([Math.cos(ph) * N.rx, 0, -Math.sin(ph) * N.rz]), no = N.n(ph);
      const room = top[1] - N.ground - 0.02, fringe = room > 0.28 * u, Lt = clamp(0.5 * u, 0.04, room - (fringe ? 0.085 * u : 0.01)), Wt = 0.19 * u;
      const tail = slab(8, 22, (s, t) => add(add(top, mul(tg, (s - 0.5) * Wt + 0.03 * u * t * t)), add([0, -t * Lt, 0], mul(no, 0.03 * u * Math.pow(t, 1.2)))),
        (s, t) => 0.026 * u * Math.pow(Math.sin(Math.PI * s), 0.3) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 10))),
        (t) => ((t > 0.52 && t < 0.62) || (t > 0.72 && t < 0.82) ? 1 : 0));
      C.mesh(g, tail, mats2, 'scarf-tail');
      const fr = [];
      for (let i = 0; i < (fringe ? 5 : 0); i++) {
        const s = (i + 0.5) / 5, base = add(add(top, mul(tg, (s - 0.5) * Wt * 0.9 + 0.03 * u)), add([0, -Lt * 0.99, 0], mul(no, 0.03 * u)));
        const cp = new THREE.CapsuleGeometry(0.012 * u, 0.05 * u, 3, 6);
        cp.translate(base[0], base[1] - 0.035 * u, base[2]);
        fr.push(cp);
      }
      if (fr.length) C.mesh(g, merge(fr), mats2[0], 'scarf-fringe');
      const kn = sphere(0.075 * u, 0.07 * u, 0.05 * u, 16, 12);
      put(kn, add(top, mul(no, 0.02 * u)), tg, [0, 1, 0], no);
      C.mesh(g, kn, mats2[0], 'scarf-knot');
    },
    headphones(C, A, g) {
      phones(C, A, g, { name: 'headphones', main: C.col('f4f4f7', '2d2f3a'), accent: C.col('5fc8ff', 'ff6f9c'), pad: C.col('34353f', 'e9e6f0') });
    },
    pearls(C, A, g) {
      const N = neckFrame(A, C.fur), u = N.u, rp = clamp(0.065 * u, 0.022, 0.042);
      const per = Math.PI * (3 * (N.rx + N.rz) - Math.sqrt((3 * N.rx + N.rz) * (N.rx + 3 * N.rz)));
      const n = clamp(Math.round(per / (2.08 * rp)), 16, 72), list = [];
      for (let i = 0; i < n; i++) {
        const ph = (i / n) * TAU, q = N.pt(ph, rp * 0.92, -0.05 * u * Math.pow(Math.max(0, Math.cos(ph)), 2));
        const s = sphere(rp, rp, rp, 14, 10);
        s.translate(q[0], q[1], q[2]);
        list.push(s);
      }
      C.mesh(g, merge(list), C.mat('pearl', C.col('f6efe6', '3d4250')), 'pearls');
    },
    bandana(C, A, g) {
      const N = neckFrame(A, C.fur), u = N.u, main = C.col('d8343f', '2f5fbf'), dotC = C.col('fff6ea', '1f1f28');
      const ring = [];
      for (let i = 0; i < 80; i++) { const ph = (i / 80) * TAU; ring.push(N.pt(ph, 0.02 * u, 0.03 * u)); }
      C.mesh(g, sweep(ring, { closed: true, radius: [0.02 * u, 0.045 * u], up: [0, 1, 0], radial: 10 }), C.mat('fabric', main), 'bandana-band');
      const Rm = (N.rx + N.rz) / 2, Wb = 1.05 * u, Lb = clamp(0.62 * u, 0.08, (N.c[1] + 0.03 * u - N.ground) * 0.85);
      const mapF = (s, t) => {
        const w = Wb * (1 - 0.9 * t) + 0.02 * u, ph = ((s - 0.5) * w) / Rm, n = N.n(ph);
        return add(N.pt(ph, 0.03 * u + 0.035 * u * Math.sin(Math.PI * t) + 0.02 * u * t, 0.03 * u), [0, -t * Lb, 0]).map((v, i) => v + n[i] * 0);
      };
      const flap = slab(18, 16, mapF, (s, t) => 0.02 * u * Math.pow(Math.sin(Math.PI * s), 0.3) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 8))));
      C.mesh(g, flap, C.mat('fabric', main), 'bandana-flap');
      const dots = [];
      for (const [s, t] of [[0.3, 0.15], [0.5, 0.2], [0.7, 0.15], [0.4, 0.42], [0.6, 0.42], [0.5, 0.66]]) {
        const p0 = mapF(s, t), pa = mapF(s + 0.01, t), pb = mapF(s, t + 0.01), nn = norm(cross(sub(pa, p0), sub(pb, p0)));
        const d = sphere(0.032 * u, 0.032 * u, 0.008 * u, 12, 8), tg = norm(sub(pa, p0));
        put(d, add(p0, mul(nn, 0.02 * u)), tg, cross(nn, tg), nn);
        dots.push(d);
      }
      C.mesh(g, merge(dots), C.mat('fabric', dotC), 'bandana-dots');
      const kn = sphere(0.06 * u, 0.055 * u, 0.045 * u, 14, 10), back = N.pt(Math.PI, 0.04 * u, 0.03 * u);
      kn.translate(back[0], back[1], back[2]);
      C.mesh(g, kn, C.mat('fabric', main), 'bandana-knot');
    },
    bell(C, A, g) {
      const N = neckFrame(A, C.fur), u = N.u, collarC = C.col('d8304a', '2f6bff'), gold = C.metalMat('gold');
      const ring = [];
      for (let i = 0; i < 80; i++) { const ph = (i / 80) * TAU; ring.push(N.pt(ph, 0.028 * u, 0)); }
      C.mesh(g, sweep(ring, { closed: true, radius: [0.028 * u, 0.055 * u], up: [0, 1, 0], radial: 12 }), C.mat('rubber', collarC), 'bell-collar');
      // Hangs under the collar, but never below the ground (low necks on wide shapes).
      const rb = clamp(0.13 * u, 0.04, 0.085), at = add(N.pt(0, 0.028 * u + rb * 0.95, 0), [0, -0.055 * u - rb * 0.8, 0]);
      at[1] = Math.max(at[1], N.ground + rb * 1.15);
      const prof = [];
      for (let i = 0; i <= 24; i++) { const f = -Math.PI / 2 + (i / 24) * Math.PI, sy = Math.sin(f); prof.push([rb * Math.cos(f) * (1 + 0.06 * Math.exp(-(((sy - 0.08) / 0.09) ** 2))), rb * sy]); }
      prof[0][0] = 0; prof[prof.length - 1][0] = 0;
      const body = lathe(prof, 40);
      body.translate(at[0], at[1], at[2]);
      C.mesh(g, body, gold, 'bell-body');
      const slot = [], lat = -0.62;
      for (let i = 0; i <= 12; i++) { const az = lerp(-0.7, 0.7, i / 12); slot.push(add(at, mul([Math.cos(lat) * Math.sin(az), Math.sin(lat), Math.cos(lat) * Math.cos(az)], rb * 1.0))); }
      const dark = C.mat('ink', '1e1c22'), holes = [];
      for (const e of [slot[0], slot[slot.length - 1]]) { const h = sphere(0.13 * rb, 0.13 * rb, 0.13 * rb, 10, 8); h.translate(e[0], e[1], e[2]); holes.push(h); }
      C.mesh(g, merge([sweep(slot, { radius: 0.06 * rb, radial: 8 })].concat(holes)), dark, 'bell-slot');
      const loop = new THREE.TorusGeometry(0.24 * rb, 0.07 * rb, 8, 20);
      loop.translate(at[0], at[1] + rb * 1.12, at[2]);
      C.mesh(g, loop, gold, 'bell-loop');
    },
    backpack(C, A, g) {
      const Wb = clamp(0.4 * A.width, 0.3, 0.6), Hb = clamp(0.42 * A.height, 0.3, 0.62), Db = 0.42 * Wb;
      const bp = fin3(A.back && A.back.p) ? A.back.p : [A.center[0], A.center[1], A.center[2] - A.depth / 2];
      const F = norm(A.back && fin3(A.back.n) ? A.back.n : [0, 0, -1]), U = perpTo([0, 1, 0], F), Rr = cross(U, F);
      const at = add(add(bp, mul(F, C.fur * 0.85 + Db * 0.46)), mul(U, -0.02));
      const Rbody = (A.width + A.depth) / 4;
      const main = C.col('f08a3c', '3d7bd9'), pocketC = C.col(shade(main, 0.1, -0.1), shade(main, -0.12)), strapC = C.col(shade(main, -0.3, -0.2), '3a3440');
      const box = (w, h, d, pw, hug) => deform(new THREE.SphereGeometry(1, 30, 22), (x, y, z) => {
        const f = (v) => Math.sign(v) * Math.pow(Math.abs(v), 2 / pw);
        let X = f(x) * w / 2, Y = f(y) * h / 2, Z = f(z) * d / 2;
        if (hug) Z -= ((X * X + Y * Y) / (2 * Rbody)) * clamp(-Z / (d / 2), 0, 1);
        return [X, Y, Z];
      });
      const hold = new THREE.Group();
      M4.makeBasis(V3(Rr), V3(U), V3(F));
      hold.quaternion.setFromRotationMatrix(M4);
      hold.position.set(at[0], at[1], at[2]);
      g.add(hold);
      C.mesh(hold, box(Wb, Hb, Db, 3.2, true), C.mat('fabric', main), 'backpack-body');
      const pk = box(0.72 * Wb, 0.42 * Hb, 0.34 * Db, 3.0, false);
      pk.translate(0, -0.17 * Hb, Db * 0.47);
      C.mesh(hold, pk, C.mat('fabric', pocketC), 'backpack-pocket');
      const flap = slab(12, 8, (s, t) => [(s - 0.5) * 0.74 * Wb, -0.17 * Hb + 0.21 * Hb - t * 0.12 * Hb, Db * 0.47 + 0.17 * Db + 0.012 - 0.01 * t], (s, t) => 0.012 * Math.sqrt(Math.sin(Math.PI * s)) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 6))));
      C.mesh(hold, flap, C.mat('fabric', main), 'backpack-flap');
      const handle = [];
      for (let i = 0; i <= 12; i++) { const a = Math.PI * (i / 12); handle.push([0.12 * Wb * Math.cos(a), Hb / 2 - 0.01 + 0.07 * Math.sin(a), -0.05 * Db]); }
      C.mesh(hold, sweep(handle, { radius: [0.018, 0.01], up: [0, 0, 1], radial: 8 }), C.mat('fabric', strapC), 'backpack-handle');
      // Straps: from the pack's top corners around the body sides to the front, on an inflated body ellipsoid.
      // The bounding ellipsoid alone sinks into boxy or bottom-heavy bodies, so each strap point
      // also rides on the measured neck ring, blended toward the eye-level width, and keeps
      // whichever of the two is farther out.
      const off = C.fur + 0.026;
      const E = { c: A.center, ax: A.width / 2 + off, ay: A.height / 2 + off, az: A.depth / 2 + off };
      const NK = A.neck && fin3(A.neck.c) && A.neck.rx > 0.05 && A.neck.rz > 0.05 ? A.neck : null;
      const sL = A.sideL && fin3(A.sideL.p) ? A.sideL.p : null, sR = A.sideR && fin3(A.sideR.p) ? A.sideR.p : null;
      const ringAt = (y) => {
        if (!NK) return null;
        const ye = sL && sR ? (sL[1] + sR[1]) / 2 : NK.c[1], t = ye > NK.c[1] + 0.05 ? clamp((y - NK.c[1]) / (ye - NK.c[1]), 0, 1) : 0;
        const k = lerp(1, sL && sR ? clamp((1.05 * (sR[0] - sL[0])) / 2 / NK.rx, 0.8, 1.3) : 1, t);
        const cx = lerp(NK.c[0], sL && sR ? (sL[0] + sR[0]) / 2 : NK.c[0], t);
        return { cx, cz: NK.c[2], rx: NK.rx * k + off, rz: NK.rz * k + off };
      };
      // A neck ring that had to grow past the bounding box marks a boxy section; its diagonal
      // then sets a superellipse exponent for a bounding-box ring (rounded cubes).
      const boxP = NK ? -Math.LN2 / Math.log(Math.min(0.99, Math.max(NK.rx / (A.width / 2), NK.rz / (A.depth / 2)) / Math.SQRT2)) : 2;
      const sp = (c, e) => Math.sign(c) * Math.pow(Math.abs(c), e);
      const onE = (ph, y) => {
        const k = Math.sqrt(Math.max(0.08, 1 - ((y - E.c[1]) / E.ay) ** 2)), d = (q) => Math.hypot(q[0] - E.c[0], q[2] - E.c[2]);
        let best = [E.c[0] + E.ax * k * Math.sin(ph), y, E.c[2] + E.az * k * Math.cos(ph)];
        const r = ringAt(y);
        if (r) { const q = [r.cx + r.rx * Math.sin(ph), y, r.cz + r.rz * Math.cos(ph)]; if (d(q) > d(best)) best = q; }
        if (boxP > 2.5) { const e = 2 / Math.min(boxP, 4), q = [E.c[0] + E.ax * sp(Math.sin(ph), e), y, E.c[2] + E.az * sp(Math.cos(ph), e)]; if (d(q) > d(best)) best = q; }
        return best;
      };
      const nE = (q) => norm([(q[0] - E.c[0]) / (E.ax * E.ax), (q[1] - E.c[1]) / (E.ay * E.ay), (q[2] - E.c[2]) / (E.az * E.az)]);
      hold.updateMatrix();
      // Each strap loops around its side of the body, from the pack's top corner to its bottom corner.
      for (const sd of [-1, 1]) {
        const st = V3([sd * 0.3 * Wb, 0.4 * Hb, -0.42 * Db]).applyMatrix4(hold.matrix).toArray();
        const en = V3([sd * 0.32 * Wb, -0.36 * Hb, -0.42 * Db]).applyMatrix4(hold.matrix).toArray();
        const azi = (q) => Math.atan2((q[0] - E.c[0]) / E.ax, (q[2] - E.c[2]) / E.az);
        // The pack's local +x is the world -x side (it faces backward): pick the side from world x.
        const side = Math.sign(st[0] - E.c[0]) || sd, unwrap = (a) => (side > 0 ? (a < 0 ? a + TAU : a) : (a > 0 ? a - TAU : a));
        const ph0 = unwrap(azi(st)), ph1 = unwrap(azi(en)), phM = side * 1.42, pts = [st];
        for (let i = 1; i < 20; i++) {
          const t = i / 20, ph = t < 0.5 ? lerp(ph0, phM, sstep(0, 0.5, t)) : lerp(phM, ph1, sstep(0.5, 1, t));
          const y = lerp(st[1] + 0.04, en[1], t) + 0.06 * Math.sin(Math.PI * t);
          pts.push(onE(ph, y));
        }
        pts.push(en);
        const path = crPts(pts, 40);
        C.mesh(g, sweep(path, { radius: [0.045, 0.014], up: (i) => nE(path[i]), radial: 10 }), C.mat('fabric', strapC), 'backpack-strap');
      }
    },
    flower(C, A, g) {
      const K = clipAt(A, C.fur, 1), p = K.s, at = K.p, n = K.n;
      const s = 0.5 * p, tg = perpTo([1, 0, 0], n), bt = cross(n, tg), petals = [], leaves = [], dots = [];
      for (let j = 0; j < 6; j++) {
        const a = (j / 6) * TAU + 0.3, dir = add(mul(tg, Math.cos(a)), mul(bt, Math.sin(a))), side = cross(dir, n);
        const pt = deform(new THREE.SphereGeometry(1, 16, 12), (x, y, z) => { const al = (y + 1) / 2; return [x * 0.42 * s * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, al * 1.15))), al * 0.6 * s, z * 0.1 * s + 0.22 * s * al * al]; });
        put(pt, add(at, mul(dir, 0.1 * s)), side, dir, n);
        petals.push(pt);
      }
      for (let j = 0; j < 12; j++) { const a = (j / 12) * TAU, d = sphere(0.035 * s, 0.035 * s, 0.035 * s, 8, 6); const pp = add(add(at, mul(n, 0.12 * s)), add(mul(tg, 0.2 * s * Math.cos(a)), mul(bt, 0.2 * s * Math.sin(a)))); d.translate(pp[0], pp[1], pp[2]); dots.push(d); }
      const cc = sphere(0.24 * s, 0.24 * s, 0.16 * s, 18, 12);
      put(cc, add(at, mul(n, 0.06 * s)), tg, bt, n);
      for (const a of [3.6, 5.6]) {
        const dir = add(mul(tg, Math.cos(a)), mul(bt, Math.sin(a))), lf = leafGeo(0.55 * s, 0.26 * s, 0.03 * s, 0.2);
        put(lf, add(at, mul(n, -0.04 * s)), cross(dir, n), dir, n);
        leaves.push(lf);
      }
      C.mesh(g, merge(petals), C.mat('fabric', C.col('ff7eb6', 'fff4e8')), 'flower-petals');
      C.mesh(g, merge([cc].concat(dots)), C.mat('felt', C.col('ffcc3d', 'ff8a3d')), 'flower-center');
      C.mesh(g, merge(leaves), C.mat('felt', C.col('5aa647', '2e7d4f', 0.1)), 'flower-leaves');
    },
    sprout(C, A, g) {
      const F = hatFrame(A, C.fur), p = F.hs, base = A.top.p, n = norm(add(mul(norm(A.top.n || [0, 1, 0]), 0.5), [0, 0.5, 0])), h = 0.48 * p;   // integrator: 0.3 read as a speck at stage size
      const green = C.col('63c24f', '2e7d4f', 0.12), stemC = shade(green, -0.1);
      const side = perpTo([1, 0, 0], n), fwd = cross(side, n);
      const ctrl = [add(base, mul(n, -0.03)), add(base, mul(n, C.fur + 0.3 * h)), add(add(base, mul(n, C.fur + 0.7 * h)), mul(side, 0.06 * h)), add(add(base, mul(n, C.fur + 1.0 * h)), mul(side, -0.02 * h))];
      const stem = crPts(ctrl, 20);
      const stemGeo = sweep(stem, { radius: (t) => 0.06 * h * (1 - 0.3 * t), radial: 10 });
      const pivot = add(base, mul(n, C.fur)), pv = new THREE.Group(), inner = new THREE.Group();
      pv.position.set(pivot[0], pivot[1], pivot[2]);
      inner.position.set(-pivot[0], -pivot[1], -pivot[2]);
      pv.add(inner);
      g.add(pv);
      const tip = stem[stem.length - 1], leaves = [];
      for (const [sg, ang, L] of [[-1, 0.55, 1.05], [1, 0.38, 0.9]]) {
        const dir = norm(add(mul(side, sg * Math.cos(ang)), mul(n, Math.sin(ang)))), lf = leafGeo(L * h * 1.1, 0.5 * h, 0.05 * h, 0.35);
        const nrm = norm(add(fwd, mul(n, 0.3)));
        put(lf, tip, cross(dir, perpTo(nrm, dir)), dir, perpTo(nrm, dir));
        leaves.push(lf);
      }
      C.mesh(inner, stemGeo, C.mat('felt', stemC), 'sprout-stem');
      C.mesh(inner, merge(leaves), C.mat('felt', green), 'sprout-leaves');
      g.userData.update = (t, m) => { pv.rotation.z = 0.06 * Math.sin(t * 1.3) * (m == null ? 1 : m); };
    },
    headset(C, A, g) {
      // Gaming headset: bigger dark cups with glowing rings, and a boom mic from the right cup
      // along the cheek to beside the mouth (kept clear of the head sections).
      const main = C.col('2b2d38', 'eef1f6'), glow = C.col('5ff2ff', 'ff5fb0', 0.1);
      const P = phones(C, A, g, { name: 'headset', main, accent: shade(main, 0.08), pad: C.col('3a3d4a', 'd8dbe4'), k: 1.12, glow, bandR: 0.17, bandT: 0.07 });
      const cup = P.cups.find((c) => c.side > 0), S = P.S, Rc = P.Rc, Sx = clamp(len(sub(A.eyeR.p, A.eyeL.p)), 0.1, 1.4);
      const mo = A.mouth && fin3(A.mouth.p) ? A.mouth.p : [A.eyeR.p[0] - 0.24 * Sx, A.eyeR.p[1] - 0.5 * Sx, A.eyeR.p[2]];
      const start = add(add(cup.at, mul(cup.ax, 0.2 * Rc + 0.45 * P.Tc)), add([0, -0.5 * Rc, 0], mul(cup.zf, 0.3 * Rc)));
      const c0 = S.C(start[1]), ph0 = Math.atan2(start[0] - c0[0], start[2] - c0[1]), push = C.fur * 0.85 + 0.05, pts = [start];
      for (let i = 1; i <= 8; i++) { const t = i / 8, y = lerp(start[1], mo[1] + 0.02 * Sx, sstep(0, 1, t)); pts.push(S.pt(y, lerp(ph0 - 0.15, 0.42, sstep(0, 1, t)), push + 0.04 * (1 - t))); }
      const path = crPts(pts, 40).map((p, i) => {
        if (i < 2) return p;
        const c = S.C(p[1]), ph = Math.atan2(p[0] - c[0], p[2] - c[1]), r = Math.hypot(p[0] - c[0], p[2] - c[1]), need = S.R(p[1], ph) + push;
        return r < need ? [c[0] + need * Math.sin(ph), p[1], c[1] + need * Math.cos(ph)] : p;
      });
      C.mesh(g, sweep(path, { radius: 0.06 * Rc, radial: 8 }), C.mat('plastic', main), 'headset-boom');
      const tip = path[path.length - 1], T = norm(sub(tip, path[path.length - 3])), mic = sphere(0.17 * Rc, 0.17 * Rc, 0.17 * Rc, 16, 12);
      const mc = add(tip, mul(T, 0.1 * Rc));
      mic.scale(1, 1.25, 1);
      put(mic, mc, perpTo([1, 0, 0], T), T, cross(perpTo([1, 0, 0], T), T));
      C.mesh(g, mic, C.mat('rubber', C.col('34353f', 'd8dbe4')), 'headset-mic');
    },
    catphones(C, A, g) {
      const main = C.col('ff9cc2', 'b48cff'), white = C.col('fff3f8', '3a3440');
      const P = phones(C, A, g, { name: 'catphones', main, accent: white, pad: white });
      const band = P.band, n = band.pts.length - 1, outer = C.mat('plastic', main), glow = C.mat('emissive', C.col('ff6fb0', 'ffd1e8', 0.1));
      [P.S.info.bumps ? 0.36 : 0.3, P.S.info.bumps ? 0.64 : 0.7].forEach((f, k) => {
        const i = Math.round(f * n), nb = band.nrm[i], sd = k ? 1 : -1, up = norm(add(add(nb, [0, 0.45, 0]), [sd * 0.1, 0, 0]));
        catEar(C, g, add(band.pts[i], mul(nb, -0.04 * P.Rc)), up, perpTo([0, 0.1, 1], up), 1.35 * P.Rc, outer, glow, 'catphones-ear', true);
      });
    },
    heartclip(C, A, g) {
      // A puffy heart on a hair clip, above the viewer's left eye (the flower clip takes the right).
      const K = clipAt(A, C.fur, -1), w = 0.44 * K.s, n = K.n, up0 = perpTo([0, 1, 0], n), tw = -0.35;
      const up = norm(add(mul(up0, Math.cos(tw)), mul(cross(up0, n), Math.sin(tw)))), X = cross(up, n);
      const heart = deform(extrude(heart2(w, 80), [], 0.1 * w, 0.06 * w), (x, y, z) => {
        const q = 1 - Math.min(1, (x / (0.5 * w)) ** 2 + ((y - 0.05 * w) / (0.45 * w)) ** 2);
        return [x, y, z + Math.sign(z) * 0.12 * w * Math.sqrt(Math.max(0, q))];
      });
      put(heart, add(K.p, mul(n, 0.075 * w)), X, up, n);
      C.mesh(g, heart, C.mat('plastic', C.col('ff3d7f', 'b5179e')), 'heartclip-heart');
      const bar = new THREE.CapsuleGeometry(0.035 * w, 0.75 * w, 4, 8);
      bar.rotateZ(Math.PI / 2);
      put(bar, add(K.p, mul(n, 0.01 * w)), X, up, n);
      C.mesh(g, bar, C.metalMat('silver'), 'heartclip-clip');
    },
    cape(C, A, g) {
      // Tied at the neck ring, it drapes down the back to just above the ground, outside the body
      // bounds (it never comes back in once it has flared: it hangs), with a lighter lining. Motion
      // lifts the hem backward and lets it settle (trap 10).
      const N = neckFrame(A, C.fur), u = N.u, H = bodyHull(A, C.fur * 0.85 + 0.02);
      const main = C.col('d8343f', '2f5fbf'), lining = shade(main, 0.1, -0.15);
      const yN = N.c[1] + 0.02 * u, yH = A.ground + 0.04, drop = Math.max(yN - yH, 0.05);
      const ph0 = Math.PI / 2 - 0.42, ph1 = 1.5 * Math.PI + 0.42, NU = 40, NV = 28, o = H.o;
      const rad = [];
      for (let i = 0; i <= NU; i++) {
        const ph = lerp(ph0, ph1, i / NU), q = N.pt(ph, 0.04 * u), r0 = Math.hypot(q[0] - o[0], q[2] - o[1]), col = [];
        let env = r0;
        for (let j = 0; j <= NV; j++) {
          const t = j / NV, hr = H.R(yN - t * drop, ph) + 0.03 * u;
          env = Math.max(env, hr);
          col.push(Math.max(lerp(r0, env, sstep(0, 0.35, t)) + 0.12 * u * Math.pow(t, 1.6) + 0.03 * u * Math.sin(7 * ph) * Math.pow(t, 1.5), hr));
        }
        rad.push(col);
      }
      const cape = slab(NU, NV, (s, t) => {
        const i = Math.round(s * NU), j = Math.round(t * NV), ph = lerp(ph0, ph1, s), r = rad[i][j];
        return [o[0] + r * Math.sin(ph), Math.max(yN - t * drop + 0.012 * Math.sin(7 * ph) * t, A.ground + 0.02), o[1] + r * Math.cos(ph)];
      }, (s, t) => 0.013 * u * Math.sqrt(Math.sin(Math.PI * s)) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 10))) * sstep(0, 0.04, t));
      const half = NU * NV * 6;
      cape.clearGroups();
      cape.addGroup(0, half, 0);
      cape.addGroup(half, half, 1);
      const capeM = C.mesh(g, cape, [C.mat('fabric', lining), C.mat('fabric', main)], 'cape-cloth');
      const ring = [];
      for (let i = 0; i < 80; i++) { const ph = (i / 80) * TAU; ring.push(N.pt(ph, 0.03 * u, 0.012 * u)); }
      C.mesh(g, sweep(ring, { closed: true, radius: [0.024 * u, 0.055 * u], up: [0, 1, 0], radial: 10 }), C.mat('fabric', main), 'cape-collar');
      const clasps = [];
      for (const ph of [ph0 + 0.04, ph1 - 0.04]) {
        const nn = N.n(ph), at = N.pt(ph, 0.06 * u, 0.012 * u), disc = lathe([[0, -0.015 * u], [0.07 * u, -0.015 * u], [0.075 * u, 0], [0.06 * u, 0.018 * u], [0, 0.026 * u]], 32);
        put(disc, at, cross([0, 1, 0], nn), nn, perpTo([0, 1, 0], nn).map((v) => -v));
        clasps.push(disc);
      }
      C.mesh(g, merge(clasps), C.metalMat('gold'), 'cape-clasps');
      const set = bender([capeM], N.c, [1, 0, 0], (x, y, z) => Math.pow(clamp((yN - y) / drop, 0, 1), 1.4) * clamp(0.6 - (0.8 * (z - N.c[2])) / N.rz, 0, 1));
      g.userData.update = (t, m) => set((m == null ? 1 : m) * 0.1 * (0.55 + 0.45 * Math.sin(1.3 * t)));
    },
    wings(C, A, g) {
      // Small soft feathered wings at the back, angled 35 degrees away from it, that flap with motion.
      // Each feather is its own mesh with its shaft on its local y axis (the feather material's
      // barbs run from there).
      const W = A.width, Hh = A.height, bp = fin3(A.back && A.back.p) ? A.back.p : [A.center[0], A.center[1], A.center[2] - A.depth / 2];
      const Bn = norm(A.back && fin3(A.back.n) ? [A.back.n[0], 0, A.back.n[2]] : [0, 0, -1]);
      const span = clamp(0.3 * Math.min(W, Hh), 0.2, 0.42), col = C.col('fbfaf7', 'c9c2e8'), mat = C.mat('feather', col), mat2 = C.mat('feather', shade(col, -0.05));
      const zoff = (A.depth / 2) * (1 - Math.sqrt(Math.max(0, 1 - Math.pow((0.12 * W) / (A.width / 2), 2))));
      const flaps = [];
      const feather = (parent, base, dir, L, Wd, T, z, m, name) => {
        const geo = deform(new THREE.SphereGeometry(1, 14, 12), (x, y, zz) => {
          const s = (y + 1) / 2, wk = 0.55 + 0.6 * s;
          return [x * Wd * wk, s * L, zz * T * (0.4 + 0.6 * wk) + 0.25 * T * x * x];
        });
        const mesh = C.mesh(parent, geo, m, name);
        mesh.position.set(base[0], base[1], z);
        mesh.rotation.set(0, 0, Math.atan2(-dir[0], dir[1]));
        return mesh;
      };
      for (const sd of [-1, 1]) {
        const out = norm(add(mul([sd, 0, 0], Math.cos(0.61)), mul(Bn, Math.sin(0.61)))), Y = [0, 1, 0], Z = cross(out, Y);
        const root = add(add(bp, mul([sd, 0, 0], 0.12 * W)), add([0, 0.05 * Hh, 0], mul(Bn, C.fur * 0.85 + 0.012 - 0.5 * zoff)));
        const hold = new THREE.Group();
        M4.makeBasis(V3(out), V3(Y), V3(Z));
        hold.quaternion.setFromRotationMatrix(M4);
        hold.position.set(root[0], root[1], root[2]);
        g.add(hold);
        const flap = new THREE.Group();
        hold.add(flap);
        const top = (u) => [span * u, span * (0.05 + 0.55 * Math.sin(Math.PI * u * 0.85))];
        // flight feathers hanging from the top edge, longer and more outward toward the tip
        for (let i = 0; i < 6; i++) {
          const uu = 0.18 + 0.16 * i, b = top(uu), ga = 0.25 + 0.75 * uu, dir = [Math.sin(ga), -Math.cos(ga)];
          feather(flap, b, dir, span * (0.45 + 0.42 * uu), 0.12 * span * (1 + 0.3 * uu), 0.035 * span, -0.006 * i * span, i % 2 ? mat2 : mat, 'wings-feather');
        }
        // coverts over their roots, pointing down, and a soft leading edge
        for (let j = 0; j < 5; j++) {
          const uu = 0.08 + 0.2 * j, b = top(uu);
          feather(flap, [b[0], b[1] + 0.06 * span], [0.25, -1], span * 0.36, 0.13 * span, 0.04 * span, 0.02 * span, mat, 'wings-covert');
        }
        const edge = [];
        for (let k = 0; k <= 20; k++) { const b = top(k / 20); edge.push([b[0], b[1] + 0.04 * span, 0.012 * span]); }
        C.mesh(flap, sweep(edge, { radius: (t) => 0.06 * span * (1 - 0.55 * t) + 0.015 * span, radial: 10 }), mat, 'wings-edge');
        flaps.push([flap, sd]);
      }
      g.userData.update = (t, m) => { const k = m == null ? 1 : m; for (const [f, sd] of flaps) f.rotation.y = sd * k * 0.2 * Math.sin(2.4 * t); };
    },
    necktie(C, A, g) {
      // A shirt collar round the neck ring with two points, a knot, and a blade lying on the front
      // of the body (following the body bounds), as long as the room above the ground allows.
      const N = neckFrame(A, C.fur), u = N.u, H = bodyHull(A, C.fur * 0.85);
      const tieC = C.col('d8343f', '2f5fbf'), shirt = C.col('fbfaf6', '9cc3ff'), tie = C.mat('fabric', tieC), cloth = C.mat('fabric', shirt);
      const front = (y, ph, push) => { const a = N.pt(ph, push, y - N.c[1]), b = H.pt(y, ph, push); return sdfOut(C, H.o, Math.hypot(a[0] - H.o[0], a[2] - H.o[1]) >= Math.hypot(b[0] - H.o[0], b[2] - H.o[1]) ? a : b, C.fur * 0.85 + push); };
      const ring = [];
      for (let i = 0; i < 80; i++) { const ph = (i / 80) * TAU; ring.push(N.pt(ph, 0.024 * u, 0.025 * u)); }
      C.mesh(g, sweep(ring, { closed: true, radius: [0.024 * u, 0.06 * u], up: [0, 1, 0], radial: 10 }), cloth, 'necktie-collar');
      const pts = [];
      for (const sd of [-1, 1]) {
        const tipP = front(N.c[1] - 0.15 * u, sd * 0.24, 0.05 * u);
        pts.push(slab(8, 8, (s, t) => {
          const a = front(N.c[1] + 0.07 * u, sd * lerp(0.07, 0.44, s), 0.05 * u), p = mix3(a, add(tipP, [(s - 0.5) * 0.03 * u, 0, 0]), t), c = Math.hypot(p[0] - H.o[0], p[2] - H.o[1]);
          const ph = Math.atan2(p[0] - H.o[0], p[2] - H.o[1]), q = front(p[1], ph, 0.05 * u), need = Math.hypot(q[0] - H.o[0], q[2] - H.o[1]);
          return c < need ? q : p;
        }, (s, t) => 0.009 * u * Math.sqrt(Math.sin(Math.PI * s)) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 6)))));
      }
      C.mesh(g, merge(pts), cloth, 'necktie-points');
      const yK = N.c[1] + 0.01 * u, kc = front(yK, 0, 0.07 * u), kn = deform(new THREE.SphereGeometry(1, 18, 14), (x, y, z) => [x * 0.085 * u * (1 - 0.3 * Math.max(0, -y)), y * 0.075 * u, z * 0.05 * u]);
      kn.translate(kc[0], kc[1], kc[2]);
      C.mesh(g, kn, tie, 'necktie-knot');
      const yTop = yK - 0.05 * u, room = yTop - (A.ground + 0.05), L = clamp(0.9 * u, 0.06, room);
      const blade = slab(8, 26, (s, t) => {
        const yEnd = yTop - L * (1 - 0.17 * Math.abs(2 * s - 1)), y = lerp(yTop, yEnd, t), w = 0.11 * u + 0.13 * u * Math.pow(t, 0.7);
        const c = front(y, 0, 0.035 * u + 0.012 * u * t);
        return [c[0] + (s - 0.5) * w, y, c[2]];
      }, (s, t) => 0.016 * u * Math.sqrt(Math.sin(Math.PI * s)) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 12))));
      C.mesh(g, blade, tie, 'necktie-blade');
    },
    medal(C, A, g) {
      // A gold medal on a ribbon: round the back of the neck ring, then down in a V to its loop.
      const N = neckFrame(A, C.fur), u = N.u, H = bodyHull(A, C.fur * 0.85);
      const ribC = C.col('2f6bff', 'e2475c'), stripeC = labDist(ribC, 'fbfaf6') > 0.2 ? 'fbfaf6' : 'ffd34e', gold = C.metalMat('gold');
      const front = (y, ph, push) => { const a = N.pt(ph, push, y - N.c[1]), b = H.pt(y, ph, push); return sdfOut(C, H.o, Math.hypot(a[0] - H.o[0], a[2] - H.o[1]) >= Math.hypot(b[0] - H.o[0], b[2] - H.o[1]) ? a : b, C.fur * 0.85 + push); };
      const room = N.c[1] - (A.ground + 0.03), rm = clamp(0.17 * u, 0.04, 0.32 * room), yM = Math.max(N.c[1] - 0.12 * u - 1.6 * rm, A.ground + 0.03 + 1.1 * rm);
      const Mc = front(yM, 0, 0.02 * u + 0.12 * rm), Z = norm([Mc[0] - H.o[0], 0.25, Mc[2] - H.o[1]]), Yv = perpTo([0, 1, 0], Z), X = cross(Yv, Z), top = add(Mc, mul(Yv, 1.16 * rm));
      const pts = [add(top, mul(X, 0.03 * u))];
      for (let i = 1; i <= 6; i++) { const t = i / 6; pts.push(front(lerp(top[1], N.c[1] + 0.012 * u, t), lerp(0.08, 0.6, t), 0.016 * u)); }
      for (let i = 1; i < 24; i++) pts.push(N.pt(lerp(0.6, TAU - 0.6, i / 24), 0.016 * u, 0.012 * u));
      for (let i = 0; i <= 5; i++) { const t = i / 6; pts.push(front(lerp(N.c[1] + 0.012 * u, top[1], t), -lerp(0.6, 0.08, t), 0.016 * u)); }
      pts.push(sub(top, mul(X, 0.03 * u)));
      const path = crPts(pts, 90), up = path.map((p) => norm([p[0] - H.o[0], 0, p[2] - H.o[1]]));
      C.mesh(g, sweep(path, { radius: [0.055 * u, 0.01 * u], up: (i) => up[i], radial: 10, caps: false }), C.mat('fabric', ribC), 'medal-ribbon');
      C.mesh(g, sweep(path.map((p, i) => add(p, mul(up[i], 0.006 * u))), { radius: [0.017 * u, 0.01 * u], up: (i) => up[i], radial: 8, caps: false }), C.mat('fabric', stripeC), 'medal-stripe');
      const coin = lathe([[0, -0.07 * rm], [rm, -0.07 * rm], [1.02 * rm, 0.04 * rm], [0.95 * rm, 0.1 * rm], [0.84 * rm, 0.09 * rm], [0.8 * rm, 0.04 * rm], [0, 0.04 * rm]], 48);
      coin.rotateX(Math.PI / 2);
      const st = extrude(star2(0.52 * rm, 0.23 * rm, 5, 60, 2), [], 0.05 * rm, 0.02 * rm);
      st.translate(0, 0, 0.07 * rm);
      const loop = new THREE.TorusGeometry(0.15 * rm, 0.045 * rm, 8, 20);
      loop.translate(0, 1.1 * rm, 0);
      const geo = merge([coin, st, loop]);
      put(geo, Mc, X, Yv, Z);
      C.mesh(g, geo, gold, 'medal-coin');
    }
  };

  function build(slot, id, anchors, ctx) {
    if (!id || id === 'none') return null;
    const A = anchors;
    if (!A || !A.top || !A.eyeL || !A.eyeR) throw new Error('accessories.build: anchors incomplete');
    const C = newCtx(slot, id, A, ctx);
    const g = new THREE.Group();
    g.name = slot + ':' + id;
    if (slot === 'hat') {
      if (!HATS[id]) return null;
      const F = hatFrame(A, C.fur), hg = hatGroup(F);
      g.add(hg);
      HATS[id](C, F, hg, A);
      if (hg.userData.update) g.userData.update = hg.userData.update;
    } else if (slot === 'glasses') {
      if (!GLASSES[id]) return null;
      const G = faceFrame(A, C.fur);
      G.cyc = cyclopsEye(A, ctx, C.fur, G);
      GLASSES[id](C, G, g, A);
    } else if (slot === 'extra') {
      if (!EXTRAS[id]) return null;
      EXTRAS[id](C, A, g);
    } else return null;
    g.userData.slot = slot;
    g.userData.id = id;
    g.userData.dispose = () => { for (const geo of C.geos) geo.dispose(); C.geos.length = 0; };
    return g;
  }

  function occluders(slot, id, A) {
    if (!A || !A.top || !id || id === 'none') return [];
    const out = [];
    const sph = (c, r) => { if (fin3(c) && r > 0) out.push({ c: c.slice(0, 3), r }); };
    if (slot === 'hat') {
      const F = hatFrame(A, 0);
      if (['beanie', 'cap', 'wizard', 'bucket', 'cowboy', 'sunhat', 'pirate', 'detective', 'witch', 'nightcap', 'viking', 'grad', 'propeller'].indexOf(id) >= 0) {
        const lo = Math.min(F.a, F.cz), hi = Math.max(F.a, F.cz), y0 = Math.max(0, (F.b * F.b - lo * lo) / (2 * F.b)), r = Math.sqrt(lo * lo + y0 * y0) * 1.02;
        if (hi / lo < 1.25) sph(F.w([0, y0, 0]), r);
        else { const d = (hi - lo) * 0.6; for (const sg of [-1, 1]) sph(F.w(F.a > F.cz ? [sg * d, y0, 0] : [0, y0, sg * d]), r); }
      } else if (PERCH[id]) {
        const { R, P } = perchFor(F, id);
        sph(F.w(P.p), R * 1.08);
      } else if (id === 'tiara') {
        const yt = 0.5 * F.b, k = Math.sqrt(Math.max(0.05, 1 - 0.25));
        sph(F.w([0, yt, F.cz * k]), 0.16 * F.hs);
      } else if (id === 'bow') {
        sph(F.w(F.pt(0.66, 1.05)), 0.24 * F.hs);
      }
    } else if (slot === 'extra') {
      const N = neckFrame(A, 0), u = N.u;
      if (id === 'bowtie' || id === 'scarf' || id === 'bandana' || id === 'bell' || id === 'necktie') sph(N.pt(0, 0, 0), { bowtie: 0.16, scarf: 0.2, bandana: 0.22, bell: 0.13, necktie: 0.15 }[id] * u * 1.0);
      else if (id === 'headphones' || id === 'headset' || id === 'catphones') { const Rc = clamp(0.11 * A.height, 0.1, 0.19) * (id === 'headset' ? 1.12 : 1); for (const s of [A.sideL, A.sideR]) if (s) sph(s.p, Rc * 0.95); }
      else if (id === 'backpack') sph(A.back && A.back.p, 0.45 * Math.max(clamp(0.4 * A.width, 0.3, 0.6), clamp(0.42 * A.height, 0.3, 0.62)));
      else if (id === 'flower' || id === 'heartclip') { const K = clipAt(A, 0, id === 'flower' ? 1 : -1); sph(K.p, (id === 'flower' ? 0.3 : 0.24) * K.s); }
      else if (id === 'sprout') sph(A.top.p, 0.08 * hatFrame(A, 0).hs);
      else if (id === 'medal') sph(N.pt(0, 0, -0.2 * u), 0.13 * u);
    }
    return out;
  }

  return { build, occluders, SLOTS };
}
