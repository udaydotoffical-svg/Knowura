/* Dot avatar maker: the 44 character shapes as signed distance functions,
 * with their paint zones, face hints and the anchor points that face.js,
 * accessories.js and the stage build on.
 *
 * Pure math with no imports, no DOM and no THREE: it runs in the mesher
 * worker, on the main thread (offline viewer, fallback meshing) and in Node.
 *
 * CONVENTIONS
 *  - Object space, y up, +z toward the viewer (the face looks down +z),
 *    right-handed. Every character fits inside [-1.05, 1.05]^3.
 *  - sdf(x, y, z) < 0 inside. Values stay close to a true distance
 *    (Lipschitz about 1), so sphere tracing with a 0.9 step is safe.
 *  - Each character is ONE blob: parts join with a polynomial smooth min,
 *    so ears, tails and flippers grow out of the body with soft fillets.
 *  - Every shape stands on a flattened bottom; anchors.ground is its min y.
 *
 * PAINT ZONES (materials.js mirrors this math per fragment, in object space)
 *    q_i = |p_i - c_i| / r_i                     for i in x, y, z
 *    S   = q_x^p + q_y^p + q_z^p,   s = S^(1/p)   (s = 1 on the zone's skin)
 *    g   = S^(1/p - 1) * sqrt(sum_i (q_i^(p-1) / r_i)^2)        (|grad s|)
 *    d   = (s - 1) / g                (approximate distance, object units)
 *    w   = 1 - smoothstep(-soft / 2, soft / 2, d)
 *  Zones are mixed over the body color in array order, so later zones win.
 *  paintTone() below is the CPU reference of exactly this.
 *
 * THINGS THAT ARE EASY TO GET WRONG, and are handled below:
 *  1. Mirrored parts. Most designs fold x to |x| and model one side. Parts
 *     that cross x = 0 and must blend with their mirror image (heart lobes,
 *     star arms, flower petals, bunny cheeks) are evaluated on both sides,
 *     or the seam at x = 0 turns into a sharp crease.
 *  2. Lipschitz. Squashing a part along an axis multiplies its gradient, so
 *     the result is divided by the squash factor to stay a lower bound. The
 *     ellipsoid formula is a bound, not exact; the mesher's block skip uses
 *     the full block diagonal, which leaves room for that error. Deep
 *     inside, the ellipsoid bound jumps at an ellipsoid's own center; only
 *     the sign is used there, so that is harmless.
 *  3. Speed. The mesher calls sdf() about a million times at res 128, so
 *     parts are plain parameter objects, nothing is allocated inside sdf(),
 *     and a part is skipped when its bounding sphere is farther away than
 *     the current distance plus the blend radius.
 *  4. Fitting. Designs are drawn in their own units; FIT scales and moves
 *     each one into the shared box and BOUNDS is the fitted surface AABB
 *     plus 0.04. Both come from meshing every design at a high resolution:
 *     regenerate them whenever a design changes.
 *  5. Hats on eared animals. The hat ring sits between the ears or under
 *     their roots (rig.hat), never through them, and always above the eyes.
 *
 * Primitive formulas (ellipsoid bound, round cone, rounded box, arc,
 * equilateral triangle, polynomial smooth min) follow Inigo Quilez's
 * published distance-function articles; everything else is our own.
 */

const sqrt = Math.sqrt, abs = Math.abs, min = Math.min, max = Math.max;
const sin = Math.sin, cos = Math.cos, atan2 = Math.atan2, PI = Math.PI;
const MARGIN = 0.04;

// ---------------------------------------------------------------- helpers

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// Polynomial smooth min / max with blend radius k.
function smin(a, b, k) {
  const h = k - abs(a - b);
  const m = a < b ? a : b;
  return h > 0 ? m - h * h * 0.25 / k : m;
}
function smax(a, b, k) {
  const h = k - abs(a - b);
  const m = a > b ? a : b;
  return h > 0 ? m + h * h * 0.25 / k : m;
}

// Ellipsoid distance bound (gradient-normalized implicit).
function ellipsoid(x, y, z, rx, ry, rz) {
  const ax = x / rx, ay = y / ry, az = z / rz;
  const k0 = sqrt(ax * ax + ay * ay + az * az);
  const bx = ax / rx, by = ay / ry, bz = az / rz;
  const k1 = sqrt(bx * bx + by * by + bz * bz);
  return k1 < 1e-9 ? -min(rx, ry, rz) : k0 * (k0 - 1) / k1;
}
function ellipse2(x, y, rx, ry) {
  const ax = x / rx, ay = y / ry;
  const k0 = sqrt(ax * ax + ay * ay);
  const bx = ax / rx, by = ay / ry;
  const k1 = sqrt(bx * bx + by * by);
  return k1 < 1e-9 ? -min(rx, ry) : k0 * (k0 - 1) / k1;
}

function roundBox(x, y, z, bx, by, bz, r) {
  const qx = abs(x) - bx + r, qy = abs(y) - by + r, qz = abs(z) - bz + r;
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
  const inner = qx > qy ? (qx > qz ? qx : qz) : (qy > qz ? qy : qz);
  return sqrt(ox * ox + oy * oy + oz * oz) + (inner < 0 ? inner : 0) - r;
}
function roundBox2(x, y, bx, by, r) {
  const qx = abs(x) - bx + r, qy = abs(y) - by + r;
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
  const inner = qx > qy ? qx : qy;
  return sqrt(ox * ox + oy * oy) + (inner < 0 ? inner : 0) - r;
}

// Rounded cylinder along the x axis (bolts) or z axis (snouts), elliptical
// cross-section allowed: radii (ra, rb) across, half length hl, rounding rr.
function roundCyl(u, v, w, ra, rb, hl, rr) {
  const a = ellipse2(u, v, ra - rr, rb - rr);
  const b = abs(w) - (hl - rr);
  const oa = a > 0 ? a : 0, ob = b > 0 ? b : 0;
  const inner = a > b ? a : b;
  return (inner < 0 ? inner : 0) + sqrt(oa * oa + ob * ob) - rr;
}

// Equilateral triangle of half side r, centroid at the origin, apex up.
function tri2(px, py, r) {
  const k = 1.7320508075688772;
  px = abs(px) - r;
  py = py + r / k;
  if (px + k * py > 0) {
    const nx = (px - k * py) * 0.5, ny = (-k * px - py) * 0.5;
    px = nx; py = ny;
  }
  px -= clamp(px, -2 * r, 0);
  const l = sqrt(px * px + py * py);
  return py > 0 ? -l : l;
}

// Circular arc of radius ra and thickness rb, symmetric about +y, half
// aperture given by its sine and cosine.
function arc2(px, py, sa, ca, ra, rb) {
  px = abs(px);
  if (ca * px > sa * py) {
    const dx = px - sa * ra, dy = py - ca * ra;
    return sqrt(dx * dx + dy * dy) - rb;
  }
  return abs(sqrt(px * px + py * py) - ra) - rb;
}

function circle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return sqrt(dx * dx + dy * dy) - r;
}

// Rotation R = Rz(az) * Ry(ay) * Rx(ax), row-major. A part's local frame is
// turned by R; world to local multiplies by the transpose.
function rotation(ax, ay, az) {
  const cx = cos(ax), sx = sin(ax), cy = cos(ay), sy = sin(ay), cz = cos(az), sz = sin(az);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

// ------------------------------------------------------------------ parts
// Parts are plain objects with a bounding sphere (cx, cy, cz, br) so the
// add*() helpers can skip them cheaply.

// Ellipsoid, optionally rotated (radians about x, then y, then z).
function E(cx, cy, cz, rx, ry, rz, ax, ay, az) {
  const m = (ax || ay || az) ? rotation(ax || 0, ay || 0, az || 0) : null;
  return { cx, cy, cz, rx, ry, rz, m, br: max(rx, ry, rz) };
}
function evE(P, x, y, z) {
  let dx = x - P.cx, dy = y - P.cy, dz = z - P.cz;
  const m = P.m;
  if (m !== null) {
    const lx = m[0] * dx + m[3] * dy + m[6] * dz;
    const ly = m[1] * dx + m[4] * dy + m[7] * dz;
    const lz = m[2] * dx + m[5] * dy + m[8] * dz;
    dx = lx; dy = ly; dz = lz;
  }
  return ellipsoid(dx, dy, dz, P.rx, P.ry, P.rz);
}

// Round cone (tapered capsule) from a (radius r1) to b (radius r2),
// optionally squashed about its middle by factor sq[3] along the unit axis
// sq[0..2] (the part gets that many times thinner along the axis).
function RC(ax, ay, az, bx, by, bz, r1, r2, sq) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  let nx = 0, ny = 0, nz = 1, f = 1;
  if (sq) {
    const l = sqrt(sq[0] * sq[0] + sq[1] * sq[1] + sq[2] * sq[2]);
    nx = sq[0] / l; ny = sq[1] / l; nz = sq[2] / l; f = sq[3];
  }
  return {
    ax, ay, az, bax, bay, baz, l2, rr, a2: l2 - rr * rr, il2: 1 / l2, r1, r2,
    cx: (ax + bx) / 2, cy: (ay + by) / 2, cz: (az + bz) / 2,
    br: sqrt(l2) / 2 + max(r1, r2), nx, ny, nz, f, fk: 1 / f,
  };
}
function evRC(P, x, y, z) {
  if (P.f !== 1) {
    const s = ((x - P.cx) * P.nx + (y - P.cy) * P.ny + (z - P.cz) * P.nz) * (P.f - 1);
    x += s * P.nx; y += s * P.ny; z += s * P.nz;
  }
  const pax = x - P.ax, pay = y - P.ay, paz = z - P.az;
  const l2 = P.l2, rr = P.rr;
  const yv = pax * P.bax + pay * P.bay + paz * P.baz;
  const zv = yv - l2;
  const qx = pax * l2 - P.bax * yv, qy = pay * l2 - P.bay * yv, qz = paz * l2 - P.baz * yv;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yv * yv * l2;
  const z2 = zv * zv * l2;
  const k = (rr > 0 ? rr * rr : rr < 0 ? -rr * rr : 0) * x2;
  let d;
  if ((zv > 0 ? P.a2 : zv < 0 ? -P.a2 : 0) * z2 > k) d = sqrt(x2 + z2) * P.il2 - P.r2;
  else if ((yv > 0 ? P.a2 : yv < 0 ? -P.a2 : 0) * y2 < k) d = sqrt(x2 + y2) * P.il2 - P.r1;
  else d = (sqrt(x2 * P.a2 * P.il2) + yv * rr) * P.il2 - P.r1;
  return d * P.fk;
}

// Tube along a circular arc in the yz plane at x = 0 (tails). The arc runs
// from angle a0 to a1 (radians, atan2(z - cz, y - cy)), tapering r0 -> r1.
function ARC(cy, cz, R, a0, a1, r0, r1) {
  return {
    cy, cz, R, a0, a1, r0, r1,
    e0y: cy + R * cos(a0), e0z: cz + R * sin(a0),
    e1y: cy + R * cos(a1), e1z: cz + R * sin(a1),
    cx: 0, br: R + max(r0, r1),
  };
}
function evARC(P, x, y, z) {
  const dy = y - P.cy, dz = z - P.cz;
  let t = atan2(dz, dy);
  while (t < P.a0) t += 2 * PI;
  if (t <= P.a1) {
    const r = P.r0 + (P.r1 - P.r0) * (t - P.a0) / (P.a1 - P.a0);
    const q = sqrt(dy * dy + dz * dz) - P.R;
    return sqrt(q * q + x * x) - r;
  }
  const ay = y - P.e0y, az = z - P.e0z, by = y - P.e1y, bz = z - P.e1z;
  const da = sqrt(x * x + ay * ay + az * az) - P.r0;
  const db = sqrt(x * x + by * by + bz * bz) - P.r1;
  return da < db ? da : db;
}

// Blending a part in: d = smin(d, part, k). A part's value is floored at
// the distance to its bounding sphere (cx, cy, cz, br). That floor is still
// a valid bound and leaves the surface unchanged, and it makes skipping the
// part exact: outside radius d + k + br the blend would return d anyway, so
// the field stays continuous however far the early-out reaches.
// reach() returns that floor, or NaN when the part is out of reach.
function reach(P, x, y, z, dk) {
  const lim = dk + P.br;
  if (lim <= 0) return NaN;
  const dx = x - P.cx, dy = y - P.cy, dz = z - P.cz;
  const r2 = dx * dx + dy * dy + dz * dz;
  return r2 < lim * lim ? sqrt(r2) - P.br : NaN;
}
function addE(d, P, x, y, z, k) {
  const fl = reach(P, x, y, z, d + k);
  if (fl !== fl) return d;
  const v = evE(P, x, y, z);
  return smin(d, v > fl ? v : fl, k);
}
function addRC(d, P, x, y, z, k) {
  const fl = reach(P, x, y, z, d + k);
  if (fl !== fl) return d;
  const v = evRC(P, x, y, z);
  return smin(d, v > fl ? v : fl, k);
}
function addARC(d, P, x, y, z, k) {
  const fl = reach(P, x, y, z, d + k);
  if (fl !== fl) return d;
  const v = evARC(P, x, y, z);
  return smin(d, v > fl ? v : fl, k);
}
// A bounding sphere for a group of parts blended together first.
function SPHERE(cx, cy, cz, br) { return { cx, cy, cz, br }; }

// Mochi body: an ellipsoid that sags a little wider at the bottom (pear)
// with a flattened base at y = yb (blend kb).
function MOCHI(cy, rx, ry, rz, pear, yb, kb) { return { cy, rx, ry, rz, pear, yb, kb }; }
function evMochi(P, x, y, z) {
  const ly = y - P.cy;
  const s = 1 + P.pear * clamp(-ly / P.ry, -1, 1);
  let d = ellipsoid(x / s, ly, z / s, P.rx, P.ry, P.rz);
  if (s < 1) d *= s;
  return smax(d, P.yb - y, P.kb);
}

// Cushion: inflate a 2D silhouette distance d2 (xy plane) into a pillow.
// The rim has an elliptical profile E wide (in plane) and H tall (in z);
// inside that band the pillow is a plateau of half thickness H.
function cushion(d2, z, E, H) {
  const a = d2 + E, v = abs(z);
  const de = ellipse2(a, v, E, H);
  const qy = v - H;
  const ox = a > 0 ? a : 0, oy = qy > 0 ? qy : 0;
  const inner = a > qy ? a : qy;
  const ds = sqrt(ox * ox + oy * oy) + (inner < 0 ? inner : 0);
  return de < ds ? de : ds;
}
// Classic puff: cushion + a soft dome in the middle + a flat base.
function puff(d2, x, y, z, C) {
  let d = cushion(d2, z, C.E, C.H);
  const D = C.dome;
  d = smin(d, ellipsoid(x - D[0], y - D[1], z, D[2], D[3], D[4]), D[5]);
  return smax(d, C.yb - y, C.kb);
}

// ---------------------------------------------------------------- designs

const DESIGNS = {};

function zone(cx, cy, cz, rx, ry, rz, tone, soft, p) {
  return { c: [cx, cy, cz], r: [rx, ry, rz], tone, soft: soft || 0.03, p: p || 2 };
}
// A mirrored pair of zones at +x and -x.
function zones2(cx, cy, cz, rx, ry, rz, tone, soft, p) {
  return [zone(-cx, cy, cz, rx, ry, rz, tone, soft, p), zone(cx, cy, cz, rx, ry, rz, tone, soft, p)];
}
function face(o) {
  return Object.assign({
    eyes: 'dot', eyeY: 0, eyeSpacing: 0.5, eyeSize: 0.075, mouthY: -0.2, noseY: null,
    nose: 'none', noseTone: 'dark', whiskers: false, cheeks: false, defaultMouth: 'smile',
  }, o);
}

// ---- classic: inflated silhouettes ------------------------------------

const ROUND_B = MOCHI(0, 0.86, 0.76, 0.6, 0.07, -0.66, 0.16);
DESIGNS.round = {
  raw: (x, y, z) => evMochi(ROUND_B, x, y, z),
  face: face({ eyeY: 0, eyeSpacing: 0.48, mouthY: -0.15 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.8 } },
};

const BEAN_C = { E: 0.4, H: 0.34, dome: [0, 0.02, 0.4, 0.62, 0.42, 0.24], yb: -0.84, kb: 0.12 };
const BEAN_SA = sin(0.42), BEAN_CA = cos(0.42);
DESIGNS.bean = {
  raw: (x, y, z) => {
    const d2 = arc2(y - 0.02, 0.95 - x, BEAN_SA, BEAN_CA, 1.0, 0.5 - 0.06 * y);
    return puff(d2, x, y, z, BEAN_C);
  },
  face: face({ eyeY: 0.22, eyeSpacing: 0.4, eyeSize: 0.068, mouthY: 0.08 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.8 } },
};

const PILL_C = { E: 0.42, H: 0.36, dome: [0, 0.02, 0.72, 0.4, 0.44, 0.24], yb: -0.42, kb: 0.12 };
DESIGNS.pill = {
  raw: (x, y, z) => {
    const dx = abs(x) - 0.44, ox = dx > 0 ? dx : 0;
    return puff(sqrt(ox * ox + y * y) - 0.5, x, y, z, PILL_C);
  },
  face: face({ eyeY: 0.04, eyeSpacing: 0.5, eyeSize: 0.07, mouthY: -0.12 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.62 } },
};

const CUSH_C = { E: 0.34, H: 0.34, dome: [0, 0, 0.6, 0.54, 0.44, 0.3], yb: -0.64, kb: 0.12 };
DESIGNS.cushion = {
  raw: (x, y, z) => puff(roundBox2(x, y, 0.78, 0.7, 0.36), x, y, z, CUSH_C),
  face: face({ eyeY: -0.02, eyeSpacing: 0.5, eyeSize: 0.072, mouthY: -0.18 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.7 } },
};

// Corner radius 0.3 >= rim width E, so no medial-axis ridge reaches the rim.
const TRI_C = { E: 0.28, H: 0.34, dome: [0, -0.12, 0.52, 0.52, 0.46, 0.3], yb: -0.6, kb: 0.12 };
DESIGNS.triangle = {
  raw: (x, y, z) => puff(tri2(x, y, 0.6) - 0.3, x, y, z, TRI_C),
  face: face({ eyeY: -0.1, eyeSpacing: 0.46, eyeSize: 0.068, mouthY: -0.25 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.55 } },
};

// Round silhouettes are built from 3D round cones and spheres squashed in z:
// smooth everywhere, so tips never show a crease.
const HEART_L = RC(0, -0.58, 0, 0.36, 0.16, 0, 0.12, 0.44, [0, 0, 1, 1.12]);
DESIGNS.heart = {
  raw: (x, y, z) => {
    let d = smin(evRC(HEART_L, x, y, z), evRC(HEART_L, -x, y, z), 0.2);
    d = smin(d, ellipsoid(x, y + 0.04, z, 0.4, 0.4, 0.42), 0.2);
    return smax(d, -0.6 - y, 0.1);
  },
  face: face({ eyeY: 0.04, eyeSpacing: 0.5, eyeSize: 0.07, mouthY: -0.12 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.62 } },
};

const STAR_ARMS = [0, 1, 2, 3, 4].map((i) => {
  const a = i * 2 * PI / 5;
  return RC(0, -0.04, 0, 0.6 * sin(a), -0.04 + 0.6 * cos(a), 0, 0.32, 0.17, [0, 0, 1, 1.18]);
});
const STAR_STEP = 2 * PI / 5;
const STAR_S1 = sin(STAR_STEP), STAR_C1 = cos(STAR_STEP), STAR_S2 = sin(2 * STAR_STEP), STAR_C2 = cos(2 * STAR_STEP);
DESIGNS.star = {
  raw: (x, y, z) => {
    // Fold to x >= 0 and blend only the two arms nearest in angle; the arms
    // are mirror images about each switch line, so the field is continuous.
    // (sector tests by the sign of sin(boundary angle - point angle))
    const ax = abs(x), yc = y + 0.04;
    let d;
    if (yc * STAR_S1 - ax * STAR_C1 >= 0) d = smin(evRC(STAR_ARMS[0], ax, y, z), evRC(STAR_ARMS[1], ax, y, z), 0.12);
    else if (yc * STAR_S2 - ax * STAR_C2 >= 0) d = smin(evRC(STAR_ARMS[1], ax, y, z), evRC(STAR_ARMS[2], ax, y, z), 0.12);
    else d = smin(evRC(STAR_ARMS[2], ax, y, z), evRC(STAR_ARMS[2], -ax, y, z), 0.12);
    const r = sqrt(x * x + (y + 0.04) * (y + 0.04) + z * z);
    d = smin(d, r - 0.36, 0.16);
    return smax(d, -0.62 - y, 0.08);
  },
  face: face({ eyeY: -0.04, eyeSpacing: 0.42, eyeSize: 0.066, mouthY: -0.18 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.32 } },
};

const CLOUD_Z = 1.25;
DESIGNS.cloud = {
  raw: (x, y, z) => {
    const ax = abs(x), zz = z * CLOUD_Z, zz2 = zz * zz;
    let dy = y - 0.22;
    let d = sqrt(ax * ax + dy * dy + zz2) - 0.46;
    let dx = ax - 0.47; dy = y - 0.04;
    d = smin(d, sqrt(dx * dx + dy * dy + zz2) - 0.37, 0.1);
    dx = ax - 0.82; dy = y + 0.16;
    d = smin(d, sqrt(dx * dx + dy * dy + zz2) - 0.26, 0.1);
    dx = ax - 0.6; dx = dx > 0 ? dx : 0; dy = y + 0.22;
    d = smin(d, sqrt(dx * dx + dy * dy + zz2) - 0.3, 0.12);
    return smax(d / CLOUD_Z, -0.46 - y, 0.1);
  },
  face: face({ eyeY: -0.04, eyeSpacing: 0.5, eyeSize: 0.07, mouthY: -0.2 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.5 } },
};

const FLOWER_P = [0, 1, 2, 3, 4].map((i) => {
  const a = i * 2 * PI / 5;
  return [0.5 * sin(a), -0.04 + 0.5 * cos(a)];
});
const FLOWER_C = { E: 0.3, H: 0.3, dome: [0, -0.04, 0.42, 0.42, 0.46, 0.18], yb: -0.74, kb: 0.1 };
DESIGNS.flower = {
  raw: (x, y, z) => {
    let d = circle(x, y, 0, -0.04, 0.46);
    for (let i = 0; i < 5; i++) d = smin(d, circle(x, y, FLOWER_P[i][0], FLOWER_P[i][1], 0.34), 0.08);
    return puff(d, x, y, z, FLOWER_C);
  },
  face: face({ eyeY: -0.02, eyeSpacing: 0.4, eyeSize: 0.064, mouthY: -0.16 }),
  paint: [zone(0, -0.04, 0.44, 0.36, 0.36, 0.22, 'cream', 0.04)],
  rig: { hat: { mode: 'top', frac: 0.3 } },
};

const DROP_A = RC(0, -0.2, 0, 0, 0.62, 0, 0.6, 0.07, [0, 0, 1, 1.25]);
DESIGNS.drop = {
  raw: (x, y, z) => smax(evRC(DROP_A, x, y, z), -0.72 - y, 0.12),
  face: face({ eyeY: -0.14, eyeSpacing: 0.46, eyeSize: 0.07, mouthY: -0.3 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.5 } },
};

const GEM_V = [-0.3, 0.52, 0.3, 0.52, 0.76, 0.17, 0.12, -0.62, -0.12, -0.62, -0.76, 0.17];
function polygon2(px, py, v) {
  const n = v.length / 2;
  let dx0 = px - v[0], dy0 = py - v[1];
  let d = dx0 * dx0 + dy0 * dy0, s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const vix = v[2 * i], viy = v[2 * i + 1], vjx = v[2 * j], vjy = v[2 * j + 1];
    const ex = vjx - vix, ey = vjy - viy, wx = px - vix, wy = py - viy;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t, by = wy - ey * t;
    const dd = bx * bx + by * by;
    if (dd < d) d = dd;
    const c1 = py >= viy, c2 = py < vjy, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * sqrt(d);
}
const GEM_C = { E: 0.36, H: 0.34, dome: [0, 0.02, 0.46, 0.42, 0.42, 0.22], yb: -0.66, kb: 0.1 };
DESIGNS.gem = {
  raw: (x, y, z) => puff(polygon2(x, y, GEM_V) - 0.12, x, y, z, GEM_C),
  face: face({ eyeY: 0.06, eyeSpacing: 0.46, eyeSize: 0.068, mouthY: -0.1 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.62 } },
};

// ---- animals: one mochi body with blended features ----------------------

const BUN_B = MOCHI(-0.2, 0.78, 0.7, 0.68, 0.06, -0.82, 0.16);
const BUN_EAR = E(0.25, 0.84, -0.08, 0.15, 0.4, 0.1, -0.12, 0, -0.14);
const BUN_CHEEK = E(0.1, -0.22, 0.56, 0.15, 0.12, 0.13);
const BUN_CHEEKS = SPHERE(0, -0.22, 0.56, 0.1 + 0.15 + 0.015);
const BUN_TAIL = E(0, -0.55, -0.68, 0.15, 0.15, 0.13);
DESIGNS.bunny = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(BUN_B, x, y, z);
    d = addE(d, BUN_EAR, x, y, z, 0.12);
    const fl = reach(BUN_CHEEKS, x, y, z, d + 0.08);
    if (fl === fl) {
      const v = smin(evE(BUN_CHEEK, x, y, z), evE(BUN_CHEEK, -x, y, z), 0.06);
      d = smin(d, v > fl ? v : fl, 0.08);
    }
    d = addE(d, BUN_TAIL, x, y, z, 0.06);
    return d;
  },
  face: face({ eyeY: -0.06, eyeSpacing: 0.56, eyeSize: 0.075, mouthY: -0.3, noseY: -0.19,
    nose: 'button', noseTone: 'pink', defaultMouth: 'cat' }),
  paint: [
    ...zones2(0.27, 0.86, 0.04, 0.07, 0.28, 0.06, 'pink'),
    zone(0, -0.24, 0.62, 0.25, 0.15, 0.16, 'cream'),
    zone(0, -0.66, 0.5, 0.4, 0.22, 0.32, 'cream', 0.04),
    zone(0, -0.55, -0.74, 0.17, 0.17, 0.14, 'cream'),
  ],
  rig: { hat: { mode: 'below', y: 0.3 } },
};

const CAT_B = MOCHI(-0.2, 0.82, 0.7, 0.68, 0.05, -0.82, 0.16);
const CAT_EAR = RC(0.4, 0.3, -0.02, 0.56, 0.84, -0.05, 0.22, 0.04, [0, 0, 1, 1.7]);
DESIGNS.cat = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(CAT_B, x, y, z);
    return addRC(d, CAT_EAR, x, y, z, 0.12);
  },
  face: face({ eyeY: -0.06, eyeSpacing: 0.6, eyeSize: 0.075, mouthY: -0.27, noseY: -0.18,
    nose: 'button', noseTone: 'pink', whiskers: true, defaultMouth: 'cat' }),
  paint: [...zones2(0.48, 0.58, 0.06, 0.09, 0.17, 0.05, 'pink')],
  rig: { hat: { mode: 'below', y: 0.2 } },
};

const BEAR_B = MOCHI(-0.2, 0.8, 0.72, 0.7, 0.06, -0.84, 0.16);
const BEAR_EAR = E(0.5, 0.4, -0.04, 0.21, 0.2, 0.13);
const BEAR_SNOUT = E(0, -0.22, 0.6, 0.24, 0.17, 0.17);
DESIGNS.bear = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(BEAR_B, x, y, z);
    d = addE(d, BEAR_EAR, x, y, z, 0.1);
    return addE(d, BEAR_SNOUT, x, y, z, 0.1);
  },
  face: face({ eyeY: -0.02, eyeSpacing: 0.58, eyeSize: 0.075, mouthY: -0.34, noseY: -0.16,
    nose: 'snout', noseTone: 'dark' }),
  paint: [
    ...zones2(0.5, 0.41, 0.07, 0.12, 0.11, 0.06, 'cream'),
    zone(0, -0.22, 0.72, 0.26, 0.19, 0.12, 'cream'),
  ],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.3 } },
};

const PANDA_B = MOCHI(-0.2, 0.8, 0.72, 0.7, 0.06, -0.84, 0.16);
const PANDA_EAR = E(0.5, 0.4, -0.04, 0.21, 0.2, 0.13);
const PANDA_SNOUT = E(0, -0.2, 0.58, 0.2, 0.14, 0.15);
const PANDA_ARM = E(0.62, -0.52, 0.28, 0.15, 0.2, 0.15, 0.3, 0, 0.6);
const PANDA_FOOT = E(0.32, -0.8, 0.38, 0.19, 0.1, 0.18);
DESIGNS.panda = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(PANDA_B, x, y, z);
    d = addE(d, PANDA_EAR, x, y, z, 0.1);
    d = addE(d, PANDA_SNOUT, x, y, z, 0.1);
    d = addE(d, PANDA_ARM, x, y, z, 0.08);
    d = addE(d, PANDA_FOOT, x, y, z, 0.06);
    return smax(d, -0.815 - y, 0.03);
  },
  face: face({ eyeY: -0.04, eyeSpacing: 0.56, eyeSize: 0.075, mouthY: -0.32, noseY: -0.17,
    nose: 'button', noseTone: 'dark' }),
  paint: [
    ...zones2(0.5, 0.4, -0.04, 0.25, 0.24, 0.17, 'dark'),
    ...zones2(0.26, -0.03, 0.6, 0.15, 0.13, 0.15, 'dark'),
    ...zones2(0.31, -0.1, 0.58, 0.12, 0.11, 0.15, 'dark'),
    ...zones2(0.62, -0.52, 0.28, 0.2, 0.25, 0.21, 'dark'),
    ...zones2(0.32, -0.8, 0.38, 0.23, 0.14, 0.22, 'dark'),
  ],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.3 } },
};

const FOX_B = MOCHI(-0.22, 0.8, 0.7, 0.68, 0.08, -0.84, 0.16);
const FOX_EAR = RC(0.36, 0.28, -0.04, 0.54, 0.98, -0.1, 0.24, 0.045, [0, 0, 1, 1.7]);
const FOX_SNOUT = E(0, -0.21, 0.58, 0.2, 0.14, 0.16);
// Bushy tail: a horizontal spiral tube from the back, around the right side
// (+x), its tip rising a little at the front. u runs 0 (base) to 1 (tip).
const FOX_TAIL = { cy: -0.66, lift: 0.04, R0: 0.6, R1: 0.8, t0: PI + 0.25, t1: 0.85, r0: 0.11, r1: 0.1, bulge: 0.13 };
function foxTailAt(u) {
  const T = FOX_TAIL, t = T.t0 + (T.t1 - T.t0) * u, R = T.R0 + (T.R1 - T.R0) * u;
  return [R * sin(t), T.cy + T.lift * u * u, R * cos(t), T.r0 + (T.r1 - T.r0) * u + T.bulge * sin(PI * u)];
}
const FOX_TIP = foxTailAt(1), FOX_BASE = foxTailAt(0), FOX_WHITE = foxTailAt(0.94);
function foxTail(x, y, z) {
  const T = FOX_TAIL;
  let t = atan2(x, z);
  if (t < 0) t += 2 * PI;
  const u = (T.t0 - t) / (T.t0 - T.t1);
  if (u >= 0 && u <= 1) {
    const R = T.R0 + (T.R1 - T.R0) * u, cy = T.cy + T.lift * u * u;
    const r = T.r0 + (T.r1 - T.r0) * u + T.bulge * sin(PI * u);
    // oval cross-section, flatter than wide, so it hugs the ground
    return ellipse2(sqrt(x * x + z * z) - R, y - cy, r, 0.74 * r);
  }
  // end caps share the tube's oval section, so the field stays continuous
  const e = u > 1 ? FOX_TIP : FOX_BASE;
  return ellipsoid(x - e[0], y - e[1], z - e[2], e[3], 0.74 * e[3], e[3]);
}
DESIGNS.fox = {
  raw: (x, y, z) => {
    const tx = x;
    x = abs(x);
    let d = evMochi(FOX_B, x, y, z);
    d = addRC(d, FOX_EAR, x, y, z, 0.12);
    d = addE(d, FOX_SNOUT, x, y, z, 0.1);
    // the tail lies in a band (radius 0.6..0.8, height -0.66..-0.62, half
    // thickness <= 0.24, oval 0.74); lb is a lower bound of its value
    const lb = 0.74 * (max(abs(sqrt(tx * tx + z * z) - 0.7) - 0.1, abs(y + 0.64) - 0.02) - 0.24);
    if (lb < d + 0.1) d = smin(d, foxTail(tx, y, z), 0.1);
    return smax(d, -0.84 - y, 0.06);
  },
  face: face({ eyeY: -0.01, eyeSpacing: 0.56, eyeSize: 0.075, mouthY: -0.28, noseY: -0.18,
    nose: 'button', noseTone: 'dark' }),
  paint: [
    ...zones2(0.44, 0.58, 0.07, 0.09, 0.2, 0.06, 'cream'),
    ...zones2(0.54, 0.95, -0.1, 0.12, 0.13, 0.15, 'dark'),
    ...zones2(0.27, -0.27, 0.58, 0.26, 0.2, 0.22, 'cream', 0.04),
    zone(0, -0.37, 0.6, 0.2, 0.14, 0.2, 'cream'),
    zone(FOX_WHITE[0], FOX_WHITE[1], FOX_WHITE[2], 0.17, 0.17, 0.17, 'white', 0.05),
  ],
  rig: { hat: { mode: 'below', y: 0.18 } },
};

const PUP_B = MOCHI(-0.2, 0.72, 0.72, 0.7, 0.04, -0.84, 0.16);
// Floppy ears: long teardrop flaps from the top of the head, hanging down
// against the cheeks; a tight blend keeps their edge readable.
const PUP_EAR = RC(0.54, 0.32, 0.0, 0.78, -0.3, 0.02, 0.1, 0.2, flapNormal([0.24, -0.62, 0.02], [0, 0, 1]).concat(2.4));
const PUP_SNOUT = E(0, -0.24, 0.58, 0.26, 0.18, 0.18);
DESIGNS.pup = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(PUP_B, x, y, z);
    d = addRC(d, PUP_EAR, x, y, z, 0.04);
    return addE(d, PUP_SNOUT, x, y, z, 0.1);
  },
  face: face({ eyeY: -0.02, eyeSpacing: 0.56, eyeSize: 0.075, mouthY: -0.36, noseY: -0.17,
    nose: 'button', noseTone: 'dark' }),
  paint: [
    zone(0, -0.24, 0.72, 0.27, 0.19, 0.13, 'cream'),
    ...zones2(0.6, 0.2, 0.0, 0.12, 0.2, 0.13, 'dark', 0.04),
    ...zones2(0.75, -0.22, 0.01, 0.15, 0.34, 0.24, 'dark', 0.04),
  ],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.42 } },
};

const FROG_B = MOCHI(-0.24, 0.9, 0.6, 0.72, 0.1, -0.8, 0.16);
const FROG_BUMP = E(0.42, 0.3, 0.2, 0.25, 0.24, 0.24);
const FROG_FOOT = E(0.42, -0.76, 0.5, 0.2, 0.08, 0.15);
DESIGNS.frog = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(FROG_B, x, y, z);
    d = addE(d, FROG_BUMP, x, y, z, 0.12);
    d = addE(d, FROG_FOOT, x, y, z, 0.06);
    return smax(d, -0.775 - y, 0.03);
  },
  face: face({ eyes: 'frog', eyeY: 0.3, eyeSpacing: 0.84, eyeSize: 0.14, mouthY: -0.18 }),
  paint: [zone(0, -0.5, 0.55, 0.52, 0.26, 0.34, 'cream', 0.04)],
  rig: { hat: { mode: 'top', frac: 0.8, rmax: 0.42, z: -0.05 } },
};

const PEN_B = MOCHI(-0.12, 0.74, 0.82, 0.68, 0.1, -0.86, 0.16);
const PEN_FLIP = E(0.74, -0.26, 0.0, 0.08, 0.3, 0.17, 0, 0, 0.42);
const PEN_FOOT = E(0.24, -0.84, 0.42, 0.19, 0.1, 0.2);
DESIGNS.penguin = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(PEN_B, x, y, z);
    d = addE(d, PEN_FLIP, x, y, z, 0.08);
    d = addE(d, PEN_FOOT, x, y, z, 0.06);
    return smax(d, -0.835 - y, 0.03);
  },
  face: face({ eyeY: 0.04, eyeSpacing: 0.44, eyeSize: 0.07, mouthY: -0.2, noseY: -0.08,
    nose: 'beak', noseTone: 'orange', defaultMouth: 'none' }),
  paint: [
    ...zones2(0.19, 0.0, 0.58, 0.27, 0.3, 0.26, 'cream', 0.04),
    zone(0, -0.42, 0.5, 0.5, 0.42, 0.36, 'cream', 0.04),
    ...zones2(0.24, -0.86, 0.42, 0.23, 0.13, 0.24, 'orange'),
    zone(0, -0.08, 0.7, 0.07, 0.05, 0.08, 'orange', 0.02),
  ],
  rig: { hat: { mode: 'top', frac: 0.78 } },
};

const CHK_B = MOCHI(-0.18, 0.76, 0.72, 0.72, 0.05, -0.84, 0.16);
const CHK_F0 = RC(0, 0.46, 0.0, 0.0, 0.82, 0.05, 0.075, 0.05);
const CHK_F1 = RC(0.02, 0.46, 0.0, 0.21, 0.74, -0.02, 0.06, 0.042);
const CHK_WING = E(0.72, -0.24, 0.02, 0.09, 0.22, 0.2, 0, 0, 0.45);
const CHK_FOOT = E(0.22, -0.82, 0.44, 0.15, 0.09, 0.16);
DESIGNS.chick = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(CHK_B, x, y, z);
    d = addRC(d, CHK_F0, x, y, z, 0.05);
    d = addRC(d, CHK_F1, x, y, z, 0.05);
    d = addE(d, CHK_WING, x, y, z, 0.06);
    d = addE(d, CHK_FOOT, x, y, z, 0.05);
    return smax(d, -0.815 - y, 0.03);
  },
  face: face({ eyeY: -0.04, eyeSpacing: 0.48, eyeSize: 0.072, mouthY: -0.24, noseY: -0.14,
    nose: 'beak', noseTone: 'orange', cheeks: true, defaultMouth: 'none' }),
  paint: [
    ...zones2(0.22, -0.84, 0.44, 0.19, 0.12, 0.2, 'orange'),
    zone(0, -0.14, 0.72, 0.07, 0.05, 0.08, 'orange', 0.02),
  ],
  rig: { hat: { mode: 'top', frac: 0.78 } },
};

const MOU_B = MOCHI(-0.22, 0.76, 0.68, 0.68, 0.08, -0.84, 0.16);
const MOU_EAR = E(0.56, 0.42, -0.06, 0.3, 0.29, 0.085, 0, 0.35, -0.2);
const MOU_TAIL = ARC(-0.5, -0.5, 0.22, 0.85 * PI, 1.8 * PI, 0.05, 0.035);
DESIGNS.mouse = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(MOU_B, x, y, z);
    d = addE(d, MOU_EAR, x, y, z, 0.08);
    return addARC(d, MOU_TAIL, x, y, z, 0.05);
  },
  face: face({ eyeY: -0.06, eyeSpacing: 0.5, eyeSize: 0.07, mouthY: -0.28, noseY: -0.18,
    nose: 'button', noseTone: 'pink', whiskers: true }),
  paint: [...zones2(0.57, 0.43, 0.04, 0.19, 0.18, 0.07, 'pink')],
  rig: { hat: { mode: 'below', y: 0.1 } },
};

const PIG_B = MOCHI(-0.2, 0.82, 0.72, 0.72, 0.05, -0.84, 0.16);
// Flap normal of a part running along t, with its width roughly along w.
function flapNormal(t, w) {
  const tl = sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
  const tx = t[0] / tl, ty = t[1] / tl, tz = t[2] / tl;
  const k = w[0] * tx + w[1] * ty + w[2] * tz;
  const wx = w[0] - k * tx, wy = w[1] - k * ty, wz = w[2] - k * tz;
  return [ty * wz - tz * wy, tz * wx - tx * wz, tx * wy - ty * wx];
}
// Short flat triangle ears on the top corners, tipped a little forward.
const PIG_EAR = RC(0.4, 0.46, 0.04, 0.56, 0.63, 0.22, 0.17, 0.1,
  flapNormal([0.16, 0.17, 0.18], [0.22, -0.2, 0]).concat(2.3));
const PIG_SNOUT = SPHERE(0, -0.18, 0.7, 0.26);
const PIG_STUB = RC(0, -0.4, -0.6, 0, -0.4, -0.76, 0.04, 0.04);
const PIG_TAIL = { cy: -0.4, cz: -0.86, R: 0.095, r: 0.046, cx: 0, br: 0.15 };
DESIGNS.pig = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(PIG_B, x, y, z);
    d = addRC(d, PIG_EAR, x, y, z, 0.08);
    // snout: a short rounded cylinder along z with an oval face
    const fs = reach(PIG_SNOUT, x, y, z, d + 0.08);
    if (fs === fs) {
      const sn = roundCyl(x, y + 0.18, z - 0.7, 0.21, 0.16, 0.12, 0.06);
      d = smin(d, sn > fs ? sn : fs, 0.08);
    }
    d = addRC(d, PIG_STUB, x, y, z, 0.05);
    const ft = reach(PIG_TAIL, x, y, z, d + 0.05);
    if (ft === ft) {
      // curly tail: a small ring in the yz plane (exact torus distance)
      const dy = y - PIG_TAIL.cy, dz = z - PIG_TAIL.cz;
      const q = sqrt(dy * dy + dz * dz) - PIG_TAIL.R;
      d = smin(d, sqrt(q * q + x * x) - PIG_TAIL.r, 0.04);
    }
    return d;
  },
  face: face({ eyeY: 0.06, eyeSpacing: 0.56, eyeSize: 0.072, mouthY: -0.4, noseY: -0.18,
    nose: 'pig', noseTone: 'pink' }),
  paint: [zone(0, -0.18, 0.8, 0.24, 0.19, 0.1, 'pink', 0.025)],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.27 } },
};

// ---- fantasy -------------------------------------------------------------

const GH_BODY = RC(0, -0.46, 0, 0, 0.2, 0, 0.7, 0.58);
const GH_ARM = E(0.62, -0.12, 0.1, 0.17, 0.1, 0.11, 0, 0, -0.5);
const GH_Z = 1.14;
DESIGNS.ghost = {
  raw: (x, y, z) => {
    x = abs(x);
    const zz = z * GH_Z;
    let d = evRC(GH_BODY, x, y, zz) / GH_Z;
    d = addE(d, GH_ARM, x, y, z, 0.07);
    // Scalloped hem: the base is cut by a wave with 8 rounded lobes around
    // the bottom (4 face the viewer) and a pointed notch between them. The
    // wave fades out toward the middle of the base, which stays flat, and
    // the cut is divided by its gradient bound (1.7). Above y = -0.64 the
    // cut cannot change the result, so it is skipped there.
    if ((-0.64 - y) / 1.7 + 0.07 <= d) return d;
    const rho = sqrt(x * x + zz * zz);
    const t = clamp((rho - 0.38) / 0.24, 0, 1);
    const hem = -0.76 + 0.12 * t * t * (3 - 2 * t) * (1 - abs(sin(4 * atan2(x, zz))));
    return smax(d, (hem - y) / 1.7, 0.07);
  },
  face: face({ eyes: 'ghost', eyeY: 0.06, eyeSpacing: 0.42, eyeSize: 0.09, mouthY: -0.14,
    defaultMouth: 'o' }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.78 } },
};

const DINO_B = MOCHI(-0.16, 0.78, 0.74, 0.72, 0.08, -0.8, 0.16);
const DINO_ARM = RC(0.4, -0.46, 0.52, 0.48, -0.53, 0.72, 0.1, 0.07);
const DINO_SPIKES = [[0.55, 0.2], [0.9, 0.24], [1.25, 0.23], [1.6, 0.19], [1.95, 0.15]].map((s) => {
  const phi = s[0], hgt = s[1];
  const sy = -0.16 + 0.74 * cos(phi), sz = -0.72 * sin(phi);
  let ny = cos(phi) / 0.74, nz = -sin(phi) / 0.72;
  const nl = sqrt(ny * ny + nz * nz); ny /= nl; nz /= nl;
  return RC(0, sy - 0.05 * ny, sz - 0.05 * nz, 0, sy + hgt * ny, sz + hgt * nz, 0.15, 0.04, [1, 0, 0, 1.35]);
});
const DINO_TAIL = RC(0, -0.6, -0.5, 0, -0.76, -1.02, 0.26, 0.07);
DESIGNS.dino = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(DINO_B, x, y, z);
    d = addRC(d, DINO_ARM, x, y, z, 0.06);
    // the spikes are at most 0.15 / 1.35 wide in x: skip them all off the ridge
    if (x - 0.112 < d + 0.07) for (let i = 0; i < 5; i++) d = addRC(d, DINO_SPIKES[i], x, y, z, 0.07);
    d = addRC(d, DINO_TAIL, x, y, z, 0.12);
    return smax(d, -0.775 - y, 0.03);
  },
  face: face({ eyeY: 0.0, eyeSpacing: 0.56, eyeSize: 0.075, mouthY: -0.24, defaultMouth: 'grin' }),
  paint: [
    ...DINO_SPIKES.map((P) => zone(0, P.cy, P.cz, 0.1, 0.17, 0.17, 'light', 0.03)),
    zone(0, -0.58, 0.52, 0.4, 0.26, 0.3, 'cream', 0.04),
  ],
  rig: { hat: { mode: 'top', frac: 0.6, z: 0.15 } },
};

const ROBOT_STALK = RC(0, 0.5, 0, 0, 0.74, 0, 0.04, 0.04);
DESIGNS.robot = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = roundBox(x, y + 0.1, z, 0.74, 0.64, 0.56, 0.22);
    // recessed screen on the front
    d = smax(d, -roundBox(x, y, z - 0.645, 0.52, 0.36, 0.12, 0.12), 0.03);
    // side bolts
    d = smin(d, roundCyl(y, z, x - 0.76, 0.12, 0.12, 0.06, 0.03), 0.04);
    // antenna
    d = addRC(d, ROBOT_STALK, x, y, z, 0.05);
    const by = y - 0.8;
    return smin(d, sqrt(x * x + by * by + z * z) - 0.08, 0.03);
  },
  face: face({ eyes: 'robot', eyeY: 0.04, eyeSpacing: 0.46, eyeSize: 0.09, mouthY: -0.18 }),
  paint: [
    zone(0, 0.0, 0.53, 0.52, 0.36, 0.1, 'screen', 0.02, 6),
    zone(0, 0.8, 0, 0.1, 0.1, 0.1, 'light', 0.02),
  ],
  // a boxy section: let the neck ring cut the corners a little so it can
  // hug the sides, and keep it under the screen
  rig: { hat: { mode: 'top', frac: 0.85 }, neckY: -0.52, neckSlack: 0.07 },
};

// ---- round 2 helpers (geoA) ----------------------------------------------

// An ellipsoid part like E(), but oriented by axes instead of angles: local x
// runs along u, local z along w (made perpendicular to u), local y = z cross x.
function ga_axisE(cx, cy, cz, rx, ry, rz, u, w) {
  let l = sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
  const ux = u[0] / l, uy = u[1] / l, uz = u[2] / l;
  const k = w[0] * ux + w[1] * uy + w[2] * uz;
  let wx = w[0] - k * ux, wy = w[1] - k * uy, wz = w[2] - k * uz;
  l = sqrt(wx * wx + wy * wy + wz * wz); wx /= l; wy /= l; wz /= l;
  const vx = wy * uz - wz * uy, vy = wz * ux - wx * uz, vz = wx * uy - wy * ux;
  return { cx, cy, cz, rx, ry, rz, m: [ux, vx, wx, uy, vy, wy, uz, vz, wz], br: max(rx, ry, rz) };
}

// Where a ray from o along unit d first meets the zero set of f. Used once at
// load to seat details (leaves, seed dots) on a surface, never per sample.
function ga_hit(f, ox, oy, oz, dx, dy, dz) {
  let t = 0;
  for (let i = 0; i < 400; i++) {
    const v = f(ox + dx * t, oy + dy * t, oz + dz * t);
    if (v < 1e-5) break;
    t += v * 0.9;
  }
  return [ox + dx * t, oy + dy * t, oz + dz * t];
}

// ---- classic, round 2 ----------------------------------------------------

// Tiny ears: the cushion pillow with two small round ears blended onto its
// top corners; the hat sits between them.
const EARS_C = { E: 0.34, H: 0.34, dome: [0, 0.08, 0.6, 0.64, 0.44, 0.3], yb: -0.62, kb: 0.12 };
const EARS_EAR = E(0.56, 0.66, -0.03, 0.2, 0.2, 0.15);
DESIGNS.ears = {
  raw: (x, y, z) => {
    x = abs(x);
    return addE(puff(roundBox2(x, y, 0.78, 0.66, 0.38), x, y, z, EARS_C), EARS_EAR, x, y, z, 0.1);
  },
  face: face({ eyeY: -0.04, eyeSpacing: 0.5, eyeSize: 0.072, mouthY: -0.2 }),
  paint: [],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.32 } },
};

// Butterfly: a puffy round body carrying the face, with four wings set on
// its back in an X: a big upper pair rising out past the head, a smaller
// lower pair leaning out and down, inflated as one lens-like cushion. The
// wings are ellipses, whose 2D field has no ridge, so the rim may be as wide
// as a wing; the lobes of one side are always nearer than the mirrored
// ones, so folding x is exact. The wings sit behind the body's middle plane,
// so side anchors and rings land on the body, and they open wide enough
// above the head for a hat to sit between them.
const BFLY_BODY = E(0, 0, 0.06, 0.44, 0.54, 0.42);
const BFLY_UC = cos(0.85), BFLY_US = sin(0.85), BFLY_LC = cos(-0.6), BFLY_LS = sin(-0.6);
function ga_wings2(x, y) {
  let u = x - 0.64, v = y - 0.28;
  const up = ellipse2(u * BFLY_UC + v * BFLY_US, v * BFLY_UC - u * BFLY_US, 0.48, 0.34);
  u = x - 0.48; v = y + 0.22;
  const lo = ellipse2(u * BFLY_LC + v * BFLY_LS, v * BFLY_LC - u * BFLY_LS, 0.34, 0.24);
  return smin(up, lo, 0.08);
}
DESIGNS.butterfly = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = cushion(ga_wings2(x, y), z + 0.2, 0.26, 0.13);
    d = smin(d, evE(BFLY_BODY, x, y, z), 0.1);
    return smax(d, -0.5 - y, 0.06);
  },
  face: face({ eyeY: 0.04, eyeSpacing: 0.4, eyeSize: 0.07, mouthY: -0.12 }),
  paint: zones2(0.68, 0.36, -0.2, 0.15, 0.15, 0.3, 'light', 0.03),
  // the wings join the back at every height below the head: let the neck ring
  // pass through their roots instead of being widened around them
  rig: { hat: { mode: 'top', frac: 0.7, rmax: 0.32 }, neckSlack: 0.45 },
};

// Sprout: a round mochi with a short stem on top and two plump leaves
// opening sideways; the hat ring stays on the head, under the leaves.
const SPROUT_B = MOCHI(-0.1, 0.84, 0.72, 0.6, 0.07, -0.76, 0.16);
const SPROUT_STEM = RC(0, 0.52, 0, 0, 0.9, 0.01, 0.075, 0.06);
const SPROUT_LEAF = ga_axisE(0.21, 0.99, 0.02, 0.22, 0.13, 0.06, [cos(0.45), sin(0.45), 0], [0, sin(0.35), cos(0.35)]);
DESIGNS.sprout = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(SPROUT_B, x, y, z);
    d = addRC(d, SPROUT_STEM, x, y, z, 0.08);
    return addE(d, SPROUT_LEAF, x, y, z, 0.06);
  },
  face: face({ eyeY: -0.08, eyeSpacing: 0.48, mouthY: -0.24 }),
  paint: [zone(0, 0.96, 0, 0.5, 0.3, 0.3, 'leaf', 0.04, 4)],
  rig: { hat: { mode: 'top', frac: 0.75 } },
};

// Scallop: a round cushion whose outline carries 12 even round bumps. The
// outline is polar, r(t) = R - A (1 - |sin 6t|) with |s| softened to
// sqrt(s^2 + e2) so the notches are round too. The bump depth fades with
// the cube of the radius, so the contours inside the rim band round off
// instead of carrying sharp notches inward (which shaded as creases), and
// the bumps vanish at the center. The 2D field is that implicit outline
// divided by its gradient length (times 0.95 to stay a bound).
// Bumps sit at 15, 45, 75... degrees: it stands on two bumps and a hat
// rests across the two top ones. cos 6t and sin 6t come from (x + iy)^6
// divided by rho^6 (no trig per sample).
const SCAL_R = 0.92, SCAL_A = 0.16, SCAL_E2 = 0.06, SCAL_N = 1 / sqrt(1 + SCAL_E2);
function ga_scallop2(x, y) {
  const r2 = x * x + y * y, rho = sqrt(r2);
  if (rho < 1e-6) return -0.95 * SCAL_R;
  const ar = x * x - y * y, ai = 2 * x * y;              // (x + iy)^2
  const br = ar * x - ai * y, bi = ar * y + ai * x;      // (x + iy)^3
  const r6 = r2 * r2 * r2;
  const c = (br * br - bi * bi) / r6, sn = 2 * br * bi / r6;   // cos 6t, sin 6t
  const w = sqrt(sn * sn + SCAL_E2);
  const q = rho / SCAL_R, fa = SCAL_A * q * q * q;       // bump depth fades inward
  const v = 1 - w * SCAL_N;
  const F = rho - SCAL_R + fa * v;
  const gr = 1 + 3 * fa * v / rho;                       // dF/drho
  const gt = fa * SCAL_N * 6 * c * sn / (w * rho);       // dF/dt / rho
  const d = 0.95 * F / sqrt(gr * gr + gt * gt);
  // Outside, the normalization drifts with the angle; easing positive values
  // (slope 1 at the outline, flatter farther out) keeps the field a bound.
  return d > 0 ? d / (1 + 1.6 * d) : d;
}
const SCAL_C = { E: 0.24, H: 0.32, dome: [0, 0, 0.6, 0.6, 0.42, 0.26], yb: -0.8, kb: 0.1 };
DESIGNS.scallop = {
  raw: (x, y, z) => puff(ga_scallop2(x, y), x, y, z, SCAL_C),
  face: face({ eyeY: 0.0, eyeSpacing: 0.46, eyeSize: 0.07, mouthY: -0.16 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.5 } },
};

// Hexagon: a puffy rounded hexagon with a pointy top, standing on its
// truncated bottom corner. Corner radius 0.26 >= rim width E: no ridge.
function ga_hexagon2(x, y, r) {
  // Inigo Quilez's regular hexagon (apothem r), x and y swapped: pointy top
  let px = abs(y), py = abs(x);
  const t = 2 * min(-0.8660254037844386 * px + 0.5 * py, 0);
  px += t * 0.8660254037844386; py -= t * 0.5;
  px -= clamp(px, -0.5773502691896258 * r, 0.5773502691896258 * r);
  py -= r;
  const l = sqrt(px * px + py * py);
  return py > 0 ? l : -l;
}
const HEX_C = { E: 0.26, H: 0.34, dome: [0, 0, 0.52, 0.6, 0.42, 0.26], yb: -0.82, kb: 0.1 };
DESIGNS.hexagon = {
  raw: (x, y, z) => puff(ga_hexagon2(x, y, 0.6) - 0.26, x, y, z, HEX_C),
  face: face({ eyeY: 0.0, eyeSpacing: 0.48, eyeSize: 0.07, mouthY: -0.16 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.55 } },
};

// Diamond: a puffy rounded rhombus, a little taller than wide, standing on
// its truncated bottom tip (the gem is the cut-stone shape; this is not).
// Corner radius 0.38 >= rim width E: no ridge, and the top stays round
// enough for a hat crown to cover it.
function ga_rhombus2(x, y, bx, by) {
  // Inigo Quilez's rhombus with half diagonals bx, by
  x = abs(x); y = abs(y);
  const h = clamp(((bx - 2 * x) * bx - (by - 2 * y) * by) / (bx * bx + by * by), -1, 1);
  const dx = x - 0.5 * bx * (1 - h), dy = y - 0.5 * by * (1 + h);
  const d = sqrt(dx * dx + dy * dy);
  return x * by + y * bx - bx * by < 0 ? -d : d;
}
const DIAM_C = { E: 0.28, H: 0.36, dome: [0, 0, 0.44, 0.56, 0.42, 0.24], yb: -0.94, kb: 0.1 };
DESIGNS.diamond = {
  raw: (x, y, z) => puff(ga_rhombus2(x, y, 0.54, 0.7) - 0.38, x, y, z, DIAM_C),
  face: face({ eyeY: 0.02, eyeSpacing: 0.46, eyeSize: 0.068, mouthY: -0.14 }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.5 } },
};

// ---- food and plants -----------------------------------------------------

// Mushroom: a wide domed cap over a short chubby stem; the stem is cream and
// carries the face just under the rim, round white spots dot the cap.
const MUSH_CAP = { cy: 0, rx: 1.0, ry: 0.74, rz: 0.8, yb: 0.04 };
const MUSH_STEM = MOCHI(-0.3, 0.5, 0.75, 0.46, 0.05, -0.74, 0.12);
// A round spot zone on the cap dome in direction (dx, dy, dz) from its center.
function ga_mushSpot(dx, dy, dz) {
  const C = MUSH_CAP, ax = dx / C.rx, ay = dy / C.ry, az = dz / C.rz;
  const t = 1 / sqrt(ax * ax + ay * ay + az * az);
  return zone(dx * t, C.cy + dy * t, dz * t, 0.13, 0.13, 0.13, 'white', 0.03);
}
DESIGNS.mushroom = {
  raw: (x, y, z) => {
    x = abs(x);
    const C = MUSH_CAP;
    const cap = smax(ellipsoid(x, y - C.cy, z, C.rx, C.ry, C.rz), C.yb - y, 0.16);
    return smin(evMochi(MUSH_STEM, x, y, z), cap, 0.12);
  },
  face: face({ eyeY: -0.16, eyeSpacing: 0.42, eyeSize: 0.068, mouthY: -0.3 }),
  paint: [
    zone(0, -0.4, 0, 0.62, 0.44, 0.62, 'cream', 0.03, 4),
    ga_mushSpot(0, 0.75, 0.66),
    ga_mushSpot(-0.55, 0.45, 0.7), ga_mushSpot(0.55, 0.45, 0.7),
    ga_mushSpot(-0.95, 0.3, 0.05), ga_mushSpot(0.95, 0.3, 0.05),
    ga_mushSpot(-0.45, 0.55, -0.7), ga_mushSpot(0.45, 0.55, -0.7),
  ],
  rig: { hat: { mode: 'top', frac: 1, rmax: 0.5 } },
};

// Strawberry: broad round shoulders tapering to a rounded tip cut flat to
// stand, a calyx of five small leaves around a stem nub, and seed dots
// seated on the surface once, at load.
const STRAW_B = RC(0, 0.14, 0, 0, -0.52, 0, 0.68, 0.28, [0, 0, 1, 1.1]);
function ga_strawBody(x, y, z) {
  const d = smax(evRC(STRAW_B, x, y, z), y - 0.7, 0.3);
  return smax(d, -0.74 - y, 0.08);
}
const STRAW_STEM = RC(0, 0.62, 0, 0, 0.84, -0.03, 0.07, 0.05);
// A calyx leaf at azimuth psi (0 = front, toward +x positive), its middle
// rho from the axis, lying on the shoulder and tipped down by tau.
function ga_strawLeaf(psi, rho, tau) {
  const sx = sin(psi), sz = cos(psi);
  const p = ga_hit(ga_strawBody, sx * rho, 1.5, sz * rho, 0, -1, 0);
  return ga_axisE(p[0], p[1] + 0.035, p[2], 0.24, 0.12, 0.055,
    [sx * cos(tau), -sin(tau), sz * cos(tau)], [sx * sin(tau), cos(tau), sz * sin(tau)]);
}
const STRAW_LEAVES = [ga_strawLeaf(0, 0.27, 0.35), ga_strawLeaf(0.4 * PI, 0.27, 0.35), ga_strawLeaf(0.8 * PI, 0.27, 0.35)];
// Seed dots: [x, y] on the front, mirrored, plus one in the middle.
function ga_strawSeeds(list) {
  const out = [];
  for (const s of list) {
    const p = ga_hit(ga_strawBody, s[0], s[1], 1.5, 0, 0, -1);
    if (s[0] === 0) out.push(zone(0, p[1], p[2], 0.04, 0.05, 0.04, 'light', 0.02));
    else out.push(...zones2(p[0], p[1], p[2], 0.04, 0.05, 0.04, 'light', 0.02));
  }
  return out;
}
DESIGNS.strawberry = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = ga_strawBody(x, y, z);
    d = addRC(d, STRAW_STEM, x, y, z, 0.05);
    for (let i = 0; i < 3; i++) d = addE(d, STRAW_LEAVES[i], x, y, z, 0.04);
    return d;
  },
  face: face({ eyeY: 0.12, eyeSpacing: 0.46, eyeSize: 0.07, mouthY: -0.04 }),
  paint: [
    zone(0, 0.78, 0, 0.62, 0.2, 0.62, 'leaf', 0.025, 6),
    ...ga_strawSeeds([[0.5, 0.34], [0.62, 0.02], [0.38, -0.3], [0.16, -0.56], [0, -0.34]]),
  ],
  rig: { hat: { mode: 'top', frac: 0.6 } },
};

// Cactus: a chubby column with two arms bending up (the viewer's left one
// higher), standing in a small round pot with a rim, a flower bud on top.
// The arms are not mirrored, so they are evaluated at the true x. The
// column top is flattened a little so a hat rests on it around the bud.
const CACT_POT = RC(0, -0.9, 0, 0, -0.62, 0, 0.44, 0.52);
const CACT_COL = RC(0, -0.62, 0, 0, 0.5, 0, 0.48, 0.46, [0, 0, 1, 1.1]);
const CACT_ARMS = [
  RC(-0.34, -0.06, 0, -0.66, -0.04, 0, 0.16, 0.15), RC(-0.68, -0.04, 0, -0.7, 0.14, 0, 0.15, 0.14),
  RC(0.34, -0.18, 0, 0.64, -0.17, 0, 0.16, 0.15), RC(0.66, -0.17, 0, 0.68, 0.02, 0, 0.15, 0.14),
];
const CACT_BUD = E(0, 0.89, 0, 0.12, 0.1, 0.12);
DESIGNS.cactus = {
  raw: (x, y, z) => {
    const ax = abs(x);
    const col = smax(evRC(CACT_COL, ax, y, z), y - 0.86, 0.2);
    let d = col;
    // The pot and its rim are at least y + 0.52 away (smoothing included),
    // so where that exceeds the column by the 0.06 blend they cannot change
    // the result: skip them (exact, not an approximation).
    if (y + 0.46 < col) {
      d = smax(evRC(CACT_POT, ax, y, z), y + 0.6, 0.04);
      const q = sqrt(x * x + z * z) - 0.51, ry = y + 0.6;
      d = smin(d, sqrt(q * q + ry * ry) - 0.07, 0.04);
      d = smin(d, col, 0.06);
    }
    for (let i = 0; i < 4; i++) d = addRC(d, CACT_ARMS[i], x, y, z, 0.06);
    d = addE(d, CACT_BUD, ax, y, z, 0.05);
    return smax(d, -0.98 - y, 0.04);
  },
  face: face({ eyeY: 0.38, eyeSpacing: 0.4, eyeSize: 0.068, mouthY: 0.22 }),
  paint: [
    zone(0, -0.8, 0, 0.6, 0.27, 0.6, 'orange', 0.03, 6),
    zone(0, 0.89, 0, 0.15, 0.13, 0.15, 'pink', 0.03),
  ],
  rig: { hat: { mode: 'top', frac: 0.7, rmax: 0.34 }, neckY: -0.44 },
};

// ---- round 2 (geoB) BEGIN: owl, hamster, octopus, shiba, koala, axolotl,
// capybara (animals), alien, unicorn, monster (fantasy) -------------------

// One bounding sphere around a cluster of parts (tufts, an ear and its fluff,
// gill fronds). Out of reach of it, with the cluster's largest blend radius,
// every part of the cluster would be skipped by its own reach() test too, so
// one test skips them all and the field does not change.
function gb_enclose(parts) {
  let cx = 0, cy = 0, cz = 0, r = 0;
  for (const P of parts) { cx += P.cx / parts.length; cy += P.cy / parts.length; cz += P.cz / parts.length; }
  for (const P of parts) {
    const dx = P.cx - cx, dy = P.cy - cy, dz = P.cz - cz;
    r = max(r, sqrt(dx * dx + dy * dy + dz * dz) + P.br);
  }
  return SPHERE(cx, cy, cz, r);
}

// Owl: an egg of a body, feather tufts on the top corners that bend
// outward, folded wings, cream eye discs and belly, small orange feet.
const OWL_B = MOCHI(-0.16, 0.78, 0.78, 0.68, 0.08, -0.84, 0.16);
const OWL_TUFT0 = RC(0.3, 0.42, -0.04, 0.44, 0.62, -0.06, 0.14, 0.085, [0, 0, 1, 2.0]);
const OWL_TUFT1 = RC(0.44, 0.62, -0.06, 0.62, 0.76, -0.08, 0.085, 0.028, [0, 0, 1, 2.0]);
const OWL_WING = E(0.69, -0.32, -0.06, 0.09, 0.32, 0.24, 0, 0.3, 0.32);
const OWL_FOOT = E(0.22, -0.82, 0.44, 0.14, 0.09, 0.15);
const OWL_TUFTS = gb_enclose([OWL_TUFT0, OWL_TUFT1]);
DESIGNS.owl = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(OWL_B, x, y, z);
    const ft = reach(OWL_TUFTS, x, y, z, d + 0.1);
    if (ft === ft) {
      d = addRC(d, OWL_TUFT0, x, y, z, 0.1);
      d = addRC(d, OWL_TUFT1, x, y, z, 0.08);
    }
    d = addE(d, OWL_WING, x, y, z, 0.1);
    d = addE(d, OWL_FOOT, x, y, z, 0.05);
    return smax(d, -0.815 - y, 0.03);
  },
  face: face({ eyeY: 0.0, eyeSpacing: 0.5, eyeSize: 0.085, mouthY: -0.26, noseY: -0.12,
    nose: 'beak', noseTone: 'orange', defaultMouth: 'none' }),
  paint: [
    ...zones2(0.25, 0.0, 0.56, 0.23, 0.23, 0.2, 'cream', 0.03),
    zone(0, -0.5, 0.5, 0.44, 0.34, 0.36, 'cream', 0.04),
    zone(0, -0.12, 0.7, 0.06, 0.05, 0.08, 'orange', 0.02),
    ...zones2(0.22, -0.84, 0.44, 0.18, 0.12, 0.19, 'orange'),
  ],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.3 } },
};

// Hamster: a wide pear with small round ears, puffy cheek pouches, a small
// muzzle, tiny paws held at the chest; cream muzzle, cheeks and belly.
const HAMS_B = MOCHI(-0.24, 0.8, 0.66, 0.7, 0.12, -0.84, 0.16);
const HAMS_EAR = E(0.44, 0.32, -0.02, 0.15, 0.14, 0.07, -0.1, 0.45, -0.35);
const HAMS_POUCH = E(0.48, -0.32, 0.32, 0.3, 0.26, 0.28);
const HAMS_MUZZLE = E(0, -0.21, 0.6, 0.17, 0.12, 0.12);
const HAMS_PAW = E(0.16, -0.48, 0.64, 0.07, 0.06, 0.06);
const HAMS_FOOT = E(0.3, -0.82, 0.46, 0.13, 0.075, 0.12);
DESIGNS.hamster = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(HAMS_B, x, y, z);
    d = addE(d, HAMS_EAR, x, y, z, 0.07);
    d = addE(d, HAMS_POUCH, x, y, z, 0.16);
    d = addE(d, HAMS_MUZZLE, x, y, z, 0.08);
    d = addE(d, HAMS_PAW, x, y, z, 0.04);
    d = addE(d, HAMS_FOOT, x, y, z, 0.05);
    return smax(d, -0.815 - y, 0.03);
  },
  face: face({ eyeY: -0.02, eyeSpacing: 0.58, eyeSize: 0.068, mouthY: -0.3, noseY: -0.17,
    nose: 'button', noseTone: 'pink', defaultMouth: 'cat' }),
  paint: [
    ...zones2(0.46, 0.34, 0.05, 0.1, 0.1, 0.05, 'pink'),
    zone(0, -0.58, 0.42, 0.88, 0.52, 0.56, 'cream', 0.05),
    ...zones2(0.16, -0.48, 0.66, 0.09, 0.08, 0.08, 'pink', 0.02),
    ...zones2(0.3, -0.84, 0.46, 0.16, 0.1, 0.15, 'pink'),
  ],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.32 } },
};

// Octopus: a round dome over 8 short tentacles. Each tentacle lies in its
// own radial plane (u out from the y axis, v across): it runs out along the
// ground from A to B, then curls up on an arc of radius OCTO_RC.
const OCTO_B = MOCHI(-0.06, 0.72, 0.76, 0.66, -0.06, -0.9, 0.1);
const OCTO_R0 = 0.16, OCTO_R1 = 0.095, OCTO_R2 = 0.06, OCTO_RC = 0.125, OCTO_AMAX = 2.5;
const OCTO_AU = 0.2, OCTO_AY = -0.86 + OCTO_R0, OCTO_BU = 0.62, OCTO_BY = -0.86 + OCTO_R1;
const OCTO_SU = OCTO_BU - OCTO_AU, OCTO_SY = OCTO_BY - OCTO_AY;
const OCTO_L2 = OCTO_SU * OCTO_SU + OCTO_SY * OCTO_SY, OCTO_L = sqrt(OCTO_L2);
const OCTO_CU = OCTO_BU - (OCTO_SY / OCTO_L) * OCTO_RC, OCTO_CY = OCTO_BY + (OCTO_SU / OCTO_L) * OCTO_RC;
const OCTO_A0 = atan2(OCTO_SY, OCTO_SU) - PI / 2;           // polar angle of B around the arc center
const OCTO_TU = OCTO_CU + OCTO_RC * cos(OCTO_A0 + OCTO_AMAX), OCTO_TY = OCTO_CY + OCTO_RC * sin(OCTO_A0 + OCTO_AMAX);
const OCTO_TOP = max(OCTO_AY + OCTO_R0, OCTO_TY + OCTO_R2, OCTO_CY + OCTO_RC + OCTO_R1);   // no tentacle reaches above
const OCTO_ANG = [0.5, 1.5, 2.5, 3.5].map((i) => i * PI / 4);   // angles from +z toward +x
const OCTO_C = OCTO_ANG.map(cos), OCTO_S = OCTO_ANG.map(sin);
function gb_tentacle(u, y, v) {
  const wu = u - OCTO_AU, wy = y - OCTO_AY;
  let t = (wu * OCTO_SU + wy * OCTO_SY) / OCTO_L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const eu = wu - OCTO_SU * t, ey = wy - OCTO_SY * t;
  let d = sqrt(eu * eu + ey * ey + v * v) - (OCTO_R0 + (OCTO_R1 - OCTO_R0) * t);
  const qu = u - OCTO_CU, qy = y - OCTO_CY;
  const rq = sqrt(qu * qu + qy * qy);
  if (abs(rq - OCTO_RC) - OCTO_R1 < d) {
    let a = atan2(qy, qu) - OCTO_A0;
    while (a < OCTO_AMAX / 2 - PI) a += 2 * PI;
    while (a >= OCTO_AMAX / 2 + PI) a -= 2 * PI;
    if (a >= 0 && a <= OCTO_AMAX) {
      const q = rq - OCTO_RC;
      const dc = sqrt(q * q + v * v) - (OCTO_R1 + (OCTO_R2 - OCTO_R1) * a / OCTO_AMAX);
      if (dc < d) d = dc;
    } else if (a > OCTO_AMAX) {
      const tu = u - OCTO_TU, ty = y - OCTO_TY;
      const dc = sqrt(tu * tu + ty * ty + v * v) - OCTO_R2;
      if (dc < d) d = dc;
    }
  }
  return d;
}
// Tentacle k of the +x half (s = 1) or its mirror image (s = -1).
function gb_tentacleK(ax, y, z, k, s) {
  return gb_tentacle(s * ax * OCTO_S[k] + z * OCTO_C[k], y, ax * OCTO_C[k] - s * z * OCTO_S[k]);
}
// Blend only the two tentacles nearest in angle (as the star does with its
// arms); the pair switches on a tentacle's own axis, where the dropped and
// the added neighbor are mirror images, so the field stays continuous.
// A tentacle lies within OCTO_R0 of its own plane, so |v| - OCTO_R0 bounds it
// from below: the farther one of the pair is evaluated only when that bound
// is within the blend of the nearer one (otherwise the smin returns the
// nearer one exactly).
function gb_tentacles(ax, y, z) {
  let j = 0;
  while (j < 4 && ax * OCTO_C[j] - z * OCTO_S[j] >= 0) j++;
  let k1 = j - 1, s1 = 1, k2 = j, s2 = 1;
  if (j === 0) { k1 = 0; s2 = -1; } else if (j === 4) { k2 = 3; s2 = -1; }
  const v1 = abs(ax * OCTO_C[k1] - s1 * z * OCTO_S[k1]), v2 = abs(ax * OCTO_C[k2] - s2 * z * OCTO_S[k2]);
  let a, b;
  if (v1 <= v2) {
    a = gb_tentacleK(ax, y, z, k1, s1);
    if (v2 - OCTO_R0 >= a + 0.06) return a;
    b = gb_tentacleK(ax, y, z, k2, s2);
  } else {
    a = gb_tentacleK(ax, y, z, k2, s2);
    if (v1 - OCTO_R0 >= a + 0.06) return a;
    b = gb_tentacleK(ax, y, z, k1, s1);
  }
  return smin(a, b, 0.06);
}
DESIGNS.octopus = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(OCTO_B, x, y, z);
    // y - OCTO_TOP bounds the tentacle field from below (less the pair blend)
    if (y - OCTO_TOP - 0.02 < d + 0.14) d = smin(d, gb_tentacles(x, y, z), 0.14);
    return smax(d, -0.84 - y, 0.03);
  },
  face: face({ eyeY: -0.14, eyeSpacing: 0.5, eyeSize: 0.075, mouthY: -0.34, cheeks: true }),
  paint: [],
  rig: { hat: { mode: 'top', frac: 0.8 } },
};

// Shiba: upright triangle ears, a muzzle, a curled tail lying on the back;
// cream inner ears, cheeks, muzzle, chest and two brow dots.
const SHIBA_B = MOCHI(-0.2, 0.8, 0.72, 0.7, 0.05, -0.84, 0.16);
const SHIBA_EAR = RC(0.38, 0.32, -0.04, 0.56, 0.82, -0.07, 0.21, 0.05, [0, 0, 1, 1.9]);
const SHIBA_SNOUT = E(0, -0.24, 0.58, 0.25, 0.17, 0.17);
// Tail: a fat curl that leaves the rump, swings back and up and lands on
// the back again (an arc in the x = 0 plane), with a cream tip.
const SHIBA_TAIL = ARC(-0.1, -0.76, 0.14, 2.74, 6.7, 0.115, 0.1);
const SHIBA_TIP = [-0.1 + 0.14 * cos(6.7), -0.76 + 0.14 * sin(6.7)];
DESIGNS.shiba = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(SHIBA_B, x, y, z);
    d = addRC(d, SHIBA_EAR, x, y, z, 0.12);
    d = addE(d, SHIBA_SNOUT, x, y, z, 0.1);
    return addARC(d, SHIBA_TAIL, x, y, z, 0.06);
  },
  face: face({ eyeY: -0.02, eyeSpacing: 0.56, eyeSize: 0.075, mouthY: -0.36, noseY: -0.17,
    nose: 'button', noseTone: 'dark', defaultMouth: 'cat' }),
  paint: [
    ...zones2(0.47, 0.6, 0.08, 0.09, 0.18, 0.1, 'cream'),
    ...zones2(0.28, -0.26, 0.56, 0.27, 0.21, 0.2, 'cream', 0.04),
    zone(0, -0.26, 0.7, 0.28, 0.2, 0.14, 'cream'),
    zone(0, -0.62, 0.52, 0.38, 0.24, 0.3, 'cream', 0.04),
    ...zones2(0.2, 0.15, 0.62, 0.065, 0.05, 0.08, 'cream', 0.02),
    zone(0, SHIBA_TIP[0] + 0.02, SHIBA_TIP[1] - 0.1, 0.13, 0.14, 0.13, 'cream', 0.04),
  ],
  rig: { hat: { mode: 'below', y: 0.22 } },
};

// Koala: big round ear discs set wide and low, facing forward, with a
// fluffy scalloped outer rim; cream inner ears and chin. The big dark oval
// nose is drawn by face.js (nose 'koala').
const KOALA_B = MOCHI(-0.2, 0.8, 0.72, 0.7, 0.06, -0.84, 0.16);
const KOALA_EAR = E(0.7, 0.28, -0.04, 0.29, 0.28, 0.14, 0, 0.35, -0.15);
// fluff: small balls on the outer rim of the ear disc (in its own plane)
const KOALA_FLUFF = [1.25, 0.6, -0.05].map((a) => {
  const m = KOALA_EAR.m, lx = 0.27 * cos(a), ly = 0.27 * sin(a);
  return E(0.7 + m[0] * lx + m[1] * ly, 0.28 + m[3] * lx + m[4] * ly, -0.04 + m[6] * lx + m[7] * ly, 0.1, 0.1, 0.065, 0, 0.35, -0.15);
});
const KOALA_EARS = gb_enclose([KOALA_EAR, ...KOALA_FLUFF]);
DESIGNS.koala = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(KOALA_B, x, y, z);
    const fe = reach(KOALA_EARS, x, y, z, d + 0.1);
    if (fe === fe) {
      d = addE(d, KOALA_EAR, x, y, z, 0.1);
      for (let i = 0; i < 3; i++) d = addE(d, KOALA_FLUFF[i], x, y, z, 0.06);
    }
    return d;
  },
  face: face({ eyeY: -0.05, eyeSpacing: 0.56, eyeSize: 0.07, mouthY: -0.38, noseY: -0.19,
    nose: 'koala', noseTone: 'dark' }),
  paint: [
    ...zones2(0.72, 0.28, 0.08, 0.2, 0.19, 0.12, 'cream'),
    zone(0, -0.62, 0.52, 0.4, 0.24, 0.32, 'cream', 0.04),
  ],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.36 } },
};

// Axolotl: a wide, low head-body with three flat gill fronds per side that
// sweep back, stubby legs and a short flat tail.
const AXO_B = MOCHI(-0.3, 0.84, 0.6, 0.66, 0.05, -0.8, 0.14);
// Gill fronds: [root x, y, z, lean out from vertical, lean back, half length,
// half width]. Each is a flat ellipsoid (long axis = local y); its pink zone
// is a ball moved 0.03 out along the frond, so it covers root to tip but
// stays off the head.
const AXO_FRONDS = [
  [0.5, 0.16, -0.12, 0.45, 0.35, 0.2, 0.085],
  [0.62, 0.06, -0.12, 1.0, 0.35, 0.2, 0.085],
  [0.7, -0.08, -0.1, 1.55, 0.35, 0.19, 0.08],
];
function gb_frondAt(f, t) {
  const b = f[3], c = f[4];
  return [f[0] + sin(b) * cos(c) * t, f[1] + cos(b) * cos(c) * t, f[2] - sin(c) * t];
}
const AXO_GILL = AXO_FRONDS.map((f) => {
  const p = gb_frondAt(f, f[5]);
  return E(p[0], p[1], p[2], f[6], f[5], 0.055, -f[4], 0, -f[3]);
});
const AXO_GILLS = gb_enclose(AXO_GILL);
const AXO_LEG = E(0.42, -0.74, 0.36, 0.13, 0.09, 0.12);
const AXO_HIND = E(0.5, -0.74, -0.3, 0.13, 0.09, 0.12);
const AXO_TAIL = RC(0, -0.58, -0.5, 0, -0.66, -0.98, 0.2, 0.05, [1, 0, 0, 2.2]);
DESIGNS.axolotl = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(AXO_B, x, y, z);
    const fg = reach(AXO_GILLS, x, y, z, d + 0.06);
    if (fg === fg) for (let i = 0; i < 3; i++) d = addE(d, AXO_GILL[i], x, y, z, 0.06);
    d = addE(d, AXO_LEG, x, y, z, 0.05);
    d = addE(d, AXO_HIND, x, y, z, 0.05);
    d = addRC(d, AXO_TAIL, x, y, z, 0.1);
    return smax(d, -0.78 - y, 0.03);
  },
  face: face({ eyeY: -0.12, eyeSpacing: 0.84, eyeSize: 0.06, mouthY: -0.3 }),
  paint: AXO_FRONDS.map((f) => {
    const p = gb_frondAt(f, f[5] + 0.03), r = f[5] + 0.005;
    return zones2(p[0], p[1], p[2], r, r, r, 'pink', 0.03);
  }).flat(),
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.36 } },
};

// Capybara: a calm rounded loaf, tiny ears on top, a broad muzzle on the
// lower front, small eyes set high.
const CAPY_MUZ = SPHERE(0, -0.28, 0.52, 0.56);
const CAPY_EAR = E(0.48, 0.44, -0.16, 0.11, 0.1, 0.07, 0, 0.3, 0);
const CAPY_FOOT = E(0.4, -0.82, 0.44, 0.14, 0.08, 0.14);
DESIGNS.capybara = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = roundBox(x, y + 0.16, z, 0.78, 0.68, 0.64, 0.52);
    const fm = reach(CAPY_MUZ, x, y, z, d + 0.1);
    if (fm === fm) {
      const m = roundBox(x, y + 0.28, z - 0.52, 0.42, 0.24, 0.24, 0.17);
      d = smin(d, m > fm ? m : fm, 0.1);
    }
    d = addE(d, CAPY_EAR, x, y, z, 0.05);
    d = addE(d, CAPY_FOOT, x, y, z, 0.05);
    return smax(d, -0.84 - y, 0.03);
  },
  face: face({ eyeY: 0.2, eyeSpacing: 0.66, eyeSize: 0.056, mouthY: -0.4, noseY: -0.14,
    nose: 'snout', noseTone: 'dark' }),
  paint: [zone(0, -0.28, 0.66, 0.45, 0.28, 0.2, 'light', 0.07, 3)],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.36 }, neckSlack: 0.05 },
};

// ---- fantasy, round 2

// Alien: a head-body wider at the top, two antennae with ball tips.
const ALIEN_B = MOCHI(-0.1, 0.84, 0.8, 0.68, -0.14, -0.84, 0.16);
const ALIEN_STALK = RC(0.36, 0.5, -0.06, 0.52, 0.92, -0.06, 0.05, 0.032);
const ALIEN_BALL = E(0.54, 0.97, -0.06, 0.1, 0.1, 0.1);
DESIGNS.alien = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(ALIEN_B, x, y, z);
    d = addRC(d, ALIEN_STALK, x, y, z, 0.06);
    return addE(d, ALIEN_BALL, x, y, z, 0.03);
  },
  face: face({ eyes: 'alien', eyeY: 0.0, eyeSpacing: 0.56, eyeSize: 0.11, mouthY: -0.32 }),
  paint: [...zones2(0.54, 0.97, -0.06, 0.13, 0.13, 0.13, 'light', 0.03)],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.3 } },
};

// Unicorn: small pointed ears, a twisted horn rising from a puff of bangs,
// a soft scalloped mane from behind the crown down the back, a puff of a
// tail. The hat sits between the ears, behind the bangs, in front of the
// mane (which starts outside the hat dome).
const UNI_B = MOCHI(-0.2, 0.8, 0.72, 0.7, 0.05, -0.84, 0.16);
const UNI_EAR = RC(0.42, 0.32, -0.12, 0.52, 0.64, -0.18, 0.12, 0.035, [0, 0, 1, 1.7]);
const UNI_HORN = RC(0, 0.36, 0.38, 0, 0.88, 0.6, 0.105, 0.022);
const UNI_BANGS = E(0, 0.41, 0.34, 0.18, 0.12, 0.17, -0.7, 0, 0);
// horn frame: axis (0, hy, hz), across e1 = +x and e2 = axis x e1
const UNI_HL = sqrt(UNI_HORN.l2), UNI_HY = UNI_HORN.bay / UNI_HL, UNI_HZ = UNI_HORN.baz / UNI_HL;
const UNI_TWIST = 2 * PI * 2.5, UNI_GROOVE = 0.14;
// Two ridges winding 2.5 turns up the cone: the cone's distance minus a
// ripple proportional to the local radius, divided by its gradient bound.
function gb_horn(x, y, z) {
  const P = UNI_HORN;
  const qx = x - P.ax, qy = y - P.ay, qz = z - P.az;
  let t = (qy * UNI_HY + qz * UNI_HZ) / UNI_HL;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const th = atan2(qy * UNI_HZ - qz * UNI_HY, qx);
  const rad = P.r1 + (P.r2 - P.r1) * t;
  return (evRC(P, x, y, z) - UNI_GROOVE * rad * sin(2 * th - UNI_TWIST * t)) / 1.12;
}
// Mane: a tube along an arc in the x = 0 plane around (0, MCY, 0), from
// angle MA1 behind the top (crown) to MA0 (low on the back), with an oval
// section (half width w across, half height h outward) that tapers and
// swells into three soft scallops. Angles as atan2(z - 0, y - MCY).
const UNI_MCY = -0.2, UNI_MR = 0.66, UNI_MA0 = -2.15, UNI_MA1 = -0.55;
function gb_maneW(u) { return 0.16 - 0.06 * u; }
function gb_maneH(u) { return (0.135 - 0.05 * u) * (1 + 0.14 * cos(2 * PI * 3 * u)); }
const UNI_ME0 = [UNI_MCY + UNI_MR * cos(UNI_MA1), UNI_MR * sin(UNI_MA1)];   // crown end (u = 0)
const UNI_ME1 = [UNI_MCY + UNI_MR * cos(UNI_MA0), UNI_MR * sin(UNI_MA0)];   // low end (u = 1)
function gb_mane(x, y, z) {
  const dy = y - UNI_MCY;
  const t = atan2(z, dy);
  const u = (UNI_MA1 - t) / (UNI_MA1 - UNI_MA0);
  if (u >= 0 && u <= 1) return ellipse2(x, sqrt(dy * dy + z * z) - UNI_MR, gb_maneW(u), gb_maneH(u));
  // end caps share the tube's section, so the field stays continuous
  const e = u < 0 ? UNI_ME0 : UNI_ME1, uu = u < 0 ? 0 : 1;
  return ellipsoid(x, y - e[0], z - e[1], gb_maneW(uu), gb_maneH(uu), gb_maneH(uu));
}
const UNI_TAIL = E(0, -0.58, -0.74, 0.13, 0.17, 0.12, 0.6, 0, 0);
DESIGNS.unicorn = {
  raw: (x, y, z) => {
    const tx = x;
    x = abs(x);
    let d = evMochi(UNI_B, x, y, z);
    d = addRC(d, UNI_EAR, x, y, z, 0.1);
    d = addE(d, UNI_BANGS, x, y, z, 0.08);
    const fh = reach(UNI_HORN, tx, y, z, d + 0.06);
    if (fh === fh) {
      const h = gb_horn(tx, y, z);
      d = smin(d, h > fh ? h : fh, 0.06);
    }
    // the mane lies in |x| <= 0.16 and z <= -0.2: skip it outside that slab
    if (x - 0.16 < d + 0.08 && z + 0.2 < d + 0.08) d = smin(d, gb_mane(x, y, z), 0.08);
    return addE(d, UNI_TAIL, x, y, z, 0.06);
  },
  face: face({ eyeY: -0.04, eyeSpacing: 0.56, eyeSize: 0.075, mouthY: -0.3 }),
  paint: [
    ...zones2(0.47, 0.48, -0.08, 0.06, 0.13, 0.05, 'pink'),
    zone(0, 0.43, 0.36, 0.24, 0.15, 0.18, 'pink', 0.04),
    zone(0, 0.05, -0.45, 0.2, 0.8, 0.62, 'pink', 0.04),
    zone(0, -0.58, -0.76, 0.17, 0.2, 0.15, 'pink', 0.04),
    zone(0, 0.68, 0.51, 0.11, 0.23, 0.11, 'light', 0.03),
  ],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.26, z: -0.1 } },
};

// Monster: a mochi with two small horns, stubby arms and feet. One big eye
// (face.js 'cyclops') and fangs.
const MONS_B = MOCHI(-0.2, 0.82, 0.74, 0.7, 0.08, -0.84, 0.16);
const MONS_HORN = RC(0.42, 0.32, 0.0, 0.6, 0.7, 0.0, 0.105, 0.03);
const MONS_ARM = E(0.74, -0.56, 0.14, 0.12, 0.17, 0.12, 0, 0, 0.7);
const MONS_FOOT = E(0.32, -0.8, 0.38, 0.18, 0.1, 0.17);
DESIGNS.monster = {
  raw: (x, y, z) => {
    x = abs(x);
    let d = evMochi(MONS_B, x, y, z);
    d = addRC(d, MONS_HORN, x, y, z, 0.08);
    d = addE(d, MONS_ARM, x, y, z, 0.07);
    d = addE(d, MONS_FOOT, x, y, z, 0.06);
    return smax(d, -0.815 - y, 0.03);
  },
  face: face({ eyes: 'cyclops', eyeY: 0.0, eyeSpacing: 0.5, eyeSize: 0.16, mouthY: -0.3,
    defaultMouth: 'fangs' }),
  paint: [...zones2(0.52, 0.58, 0.0, 0.13, 0.2, 0.12, 'light', 0.03)],
  rig: { hat: { mode: 'between', frac: 0.8, rmax: 0.26 } },
};
// ---- round 2 (geoB) END

// --------------------------------------------------------- fitted numbers
// FIT: [scale, ox, oy, oz] maps design units into object space.
// BOUNDS: the fitted surface AABB plus 0.04 on every side.
/* FIT:BEGIN */
const FIT = {
  round: [1, 0, -0.0528, 0],
  bean: [1, 0, -0.0181, 0],
  pill: [1, 0, -0.054, 0],
  cushion: [1, 0, -0.0402, 0],
  triangle: [1, 0, -0.1964, 0],
  heart: [1, 0, 0, 0],
  star: [1, 0, -0.0554, 0],
  cloud: [0.9259, 0, -0.1051, 0],
  flower: [1, 0, -0.0338, 0],
  drop: [1, 0, 0.0116, 0],
  gem: [1, 0, 0.0093, 0],
  bunny: [0.9785, 0, -0.2074, 0.052],
  cat: [1, 0, -0.035, 0],
  bear: [1, 0, 0.115, -0.0356],
  panda: [1, 0, 0.1075, -0.0205],
  fox: [1, 0, -0.1027, 0.0266],
  pup: [1, 0, 0.155, -0.0318],
  frog: [1, 0, 0.1175, 0],
  penguin: [1, 0, 0.0675, 0],
  chick: [1, 0, -0.0273, 0],
  mouse: [1, 0, 0.0573, 0.0387],
  pig: [1, 0, 0.0544, 0.0905],
  ghost: [1, 0, -0.01, 0],
  dino: [1, 0, 0.0475, 0.1496],
  robot: [1, 0, -0.07, 0],
  ears: [1, 0, -0.1223, 0],
  butterfly: [0.9553, 0, -0.0985, -0.0573],
  sprout: [1, 0, -0.1966, 0],
  scallop: [1, 0, -0.0468, 0],
  hexagon: [1, 0, -0.0664, 0],
  diamond: [0.9901, 0, -0.0693, 0],
  mushroom: [1, 0, 0, 0],
  strawberry: [1, 0, -0.076, 0],
  cactus: [1, 0, -0.005, 0],
  owl: [1, 0, 0.0135, 0],
  hamster: [1, 0, 0.1771, -0.0125],
  octopus: [1, 0, 0.07, 0],
  shiba: [1, 0, -0.02, 0.1255],
  koala: [0.9569, 0, 0.0999, 0],
  axolotl: [0.9454, 0, 0.1309, 0.174],
  capybara: [1, 0, 0.15, -0.06],
  alien: [1, 0, -0.1244, 0],
  unicorn: [1, 0, -0.0371, 0.0885],
  monster: [1, 0, 0.0427, 0],
};
const BOUNDS = {
  round: [-0.903, -0.748, -0.642, 0.903, 0.748, 0.642],
  bean: [-0.6, -0.898, -0.487, 0.602, 0.898, 0.487],
  pill: [-0.981, -0.513, -0.507, 0.981, 0.513, 0.507],
  cushion: [-0.832, -0.717, -0.514, 0.832, 0.717, 0.514],
  triangle: [-0.94, -0.837, -0.527, 0.94, 0.837, 0.527],
  heart: [-0.84, -0.641, -0.472, 0.84, 0.64, 0.472],
  star: [-0.781, -0.715, -0.416, 0.781, 0.715, 0.416],
  cloud: [-1.04, -0.565, -0.381, 1.04, 0.565, 0.381],
  flower: [-0.856, -0.807, -0.501, 0.856, 0.807, 0.501],
  drop: [-0.64, -0.742, -0.52, 0.64, 0.742, 0.52],
  gem: [-0.92, -0.69, -0.483, 0.92, 0.69, 0.483],
  bunny: [-0.805, -1.04, -0.781, 0.805, 1.04, 0.781],
  cat: [-0.862, -0.885, -0.721, 0.862, 0.885, 0.721],
  bear: [-0.842, -0.755, -0.777, 0.842, 0.755, 0.777],
  panda: [-0.842, -0.748, -0.762, 0.842, 0.748, 0.762],
  fox: [-0.843, -0.963, -0.811, 0.988, 0.963, 0.811],
  pup: [-0.927, -0.715, -0.773, 0.927, 0.715, 0.773],
  frog: [-0.945, -0.698, -0.764, 0.945, 0.698, 0.764],
  penguin: [-0.923, -0.808, -0.724, 0.923, 0.808, 0.724],
  chick: [-0.886, -0.883, -0.761, 0.886, 0.883, 0.761],
  mouse: [-0.884, -0.808, -0.761, 0.884, 0.808, 0.761],
  pig: [-0.862, -0.816, -0.951, 0.862, 0.816, 0.951],
  ghost: [-0.817, -0.81, -0.655, 0.817, 0.81, 0.655],
  dino: [-0.823, -0.768, -0.98, 0.823, 0.768, 0.98],
  robot: [-0.86, -0.851, -0.601, 0.86, 0.85, 0.601],
  ears: [-0.832, -0.778, -0.514, 0.832, 0.778, 0.514],
  butterfly: [-1.041, -0.615, -0.442, 1.041, 0.615, 0.442],
  sprout: [-0.883, -0.981, -0.642, 0.883, 0.982, 0.642],
  scallop: [-0.934, -0.887, -0.485, 0.934, 0.887, 0.485],
  hexagon: [-0.901, -0.927, -0.492, 0.901, 0.927, 0.492],
  diamond: [-0.951, -1.04, -0.49, 0.951, 1.04, 0.49],
  mushroom: [-1.015, -0.781, -0.819, 1.015, 0.78, 0.819],
  strawberry: [-0.72, -0.854, -0.659, 0.72, 0.854, 0.659],
  cactus: [-0.88, -1.026, -0.62, 0.86, 1.025, 0.62],
  owl: [-0.877, -0.842, -0.723, 0.877, 0.842, 0.723],
  hamster: [-0.847, -0.678, -0.758, 0.847, 0.678, 0.758],
  octopus: [-0.818, -0.81, -0.818, 0.818, 0.81, 0.818],
  shiba: [-0.841, -0.89, -0.923, 0.841, 0.89, 0.922],
  koala: [-1.04, -0.735, -0.712, 1.04, 0.735, 0.712],
  axolotl: [-1.04, -0.647, -0.839, 1.041, 0.647, 0.839],
  capybara: [-0.82, -0.73, -0.74, 0.82, 0.73, 0.74],
  alien: [-0.889, -0.986, -0.727, 0.889, 0.986, 0.727],
  unicorn: [-0.841, -0.908, -0.83, 0.841, 0.908, 0.83],
  monster: [-0.923, -0.813, -0.743, 0.923, 0.813, 0.743],
};
/* FIT:END */

// ------------------------------------------------------------- public API

export const SHAPE_IDS = [
  'round', 'bean', 'pill', 'cushion', 'triangle', 'heart', 'star', 'cloud', 'flower', 'drop', 'gem',
  'ears', 'butterfly', 'sprout', 'scallop', 'hexagon', 'diamond',
  'bunny', 'cat', 'bear', 'panda', 'fox', 'pup', 'frog', 'penguin', 'chick', 'mouse', 'pig',
  'owl', 'hamster', 'octopus', 'shiba', 'koala', 'axolotl', 'capybara',
  'ghost', 'dino', 'robot',
  'alien', 'unicorn', 'monster',
  'mushroom', 'strawberry', 'cactus',
];

const built = {};

function buildShape(id) {
  const D = DESIGNS[id];
  const f = FIT[id] || [1, 0, 0, 0];
  const s = f[0], ox = f[1], oy = f[2], oz = f[3];
  const raw = D.raw, inv = 1 / s;
  const sdf = (s === 1 && ox === 0 && oy === 0 && oz === 0) ? raw
    : (x, y, z) => s * raw((x - ox) * inv, (y - oy) * inv, (z - oz) * inv);
  const F = D.face;
  const fc = Object.freeze(Object.assign({}, F, {
    eyeY: s * F.eyeY + oy,
    eyeSpacing: s * F.eyeSpacing,
    eyeSize: s * F.eyeSize,
    mouthY: s * F.mouthY + oy,
    noseY: s * (F.noseY === null ? F.eyeY + 0.55 * (F.mouthY - F.eyeY) : F.noseY) + oy,
  }));
  const paint = Object.freeze(D.paint.map((z) => Object.freeze({
    c: [s * z.c[0] + ox, s * z.c[1] + oy, s * z.c[2] + oz],
    r: [s * z.r[0], s * z.r[1], s * z.r[2]],
    tone: z.tone, soft: s * z.soft, p: z.p,
  })));
  const R = D.rig || {}, H = R.hat || { mode: 'top', frac: 0.8 };
  const rig = Object.freeze({
    axisZ: s * (R.axisZ || 0) + oz,
    hat: Object.freeze({
      mode: H.mode || 'top', frac: H.frac || 0.8,
      rmax: H.rmax ? s * H.rmax : Infinity,
      y: H.y === undefined ? null : s * H.y + oy,
      z: s * (H.z || 0),
    }),
    backY: R.backY === undefined ? null : s * R.backY + oy,
    neckY: R.neckY === undefined ? null : s * R.neckY + oy,
    neckSlack: s * (R.neckSlack || 0.03),
  });
  const bounds = BOUNDS[id] ? BOUNDS[id].slice() : [-1.1, -1.1, -1.1, 1.1, 1.1, 1.1];
  return Object.freeze({ id, sdf, bounds, face: fc, paint, rig });
}

export function getShape(id) {
  if (!Object.prototype.hasOwnProperty.call(DESIGNS, id)) throw new Error('Unknown shape: ' + id);
  return built[id] || (built[id] = buildShape(id));
}

// Design-space access for the fitting script (not used at runtime).
export function _design(id) { return DESIGNS[id]; }

// ------------------------------------------------------------ paint zones

export function zoneDistance(zn, x, y, z) {
  const p = zn.p, r = zn.r, c = zn.c;
  const qx = abs(x - c[0]) / r[0], qy = abs(y - c[1]) / r[1], qz = abs(z - c[2]) / r[2];
  let S, gx, gy, gz;
  if (p === 2) {
    S = qx * qx + qy * qy + qz * qz;
    gx = qx / r[0]; gy = qy / r[1]; gz = qz / r[2];
  } else {
    S = Math.pow(qx, p) + Math.pow(qy, p) + Math.pow(qz, p);
    gx = Math.pow(qx, p - 1) / r[0]; gy = Math.pow(qy, p - 1) / r[1]; gz = Math.pow(qz, p - 1) / r[2];
  }
  if (S < 1e-12) return -min(r[0], r[1], r[2]);
  const s = Math.pow(S, 1 / p);
  const g = Math.pow(S, 1 / p - 1) * sqrt(gx * gx + gy * gy + gz * gz);
  return (s - 1) / max(g, 1e-9);
}

function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// The zone that wins at a point and its weight: {tone, w}. tone is null and
// w is 0 where no zone applies (plain body color).
export function paintTone(shape, x, y, z) {
  let tone = null, w = 0;
  const zs = shape.paint;
  for (let i = 0; i < zs.length; i++) {
    const zn = zs[i];
    const wi = 1 - smoothstep(-zn.soft / 2, zn.soft / 2, zoneDistance(zn, x, y, z));
    if (wi > 0 && wi >= w) { w = wi; tone = zn.tone; }
  }
  return { tone, w };
}

// ---------------------------------------------------------------- tracing

// Sphere tracing from o along unit d. Returns the hit distance, or -1. A
// step that lands inside is refined by bisection, so a slightly
// over-estimating SDF still returns the first crossing it can see.
export function traceRay(sdf, o, d, tMax) {
  const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
  let t = 0, f = sdf(ox, oy, oz);
  if (f <= 0) return 0;
  for (let i = 0; i < 512; i++) {
    if (f < 1e-5) return t;
    const tp = t;
    t += max(f * 0.9, 1e-5);
    if (t > tMax) return -1;
    f = sdf(ox + dx * t, oy + dy * t, oz + dz * t);
    if (f < 0) {
      let a = tp, b = t;
      for (let j = 0; j < 48; j++) {
        const m = (a + b) * 0.5;
        if (sdf(ox + dx * m, oy + dy * m, oz + dz * m) < 0) b = m; else a = m;
      }
      return (a + b) * 0.5;
    }
  }
  return -1;
}

// From a point inside, march along d to where the surface is crossed.
function marchOut(sdf, o, d, tMax) {
  const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
  let t = 0, f = sdf(ox, oy, oz);
  if (f >= 0) return 0;
  for (let i = 0; i < 1024; i++) {
    const tp = t;
    t += max(-f, 2e-4);
    if (t > tMax) return -1;
    f = sdf(ox + dx * t, oy + dy * t, oz + dz * t);
    if (f >= 0) {
      let a = tp, b = t;
      for (let j = 0; j < 48; j++) {
        const m = (a + b) * 0.5;
        if (sdf(ox + dx * m, oy + dy * m, oz + dz * m) < 0) a = m; else b = m;
      }
      return (a + b) * 0.5;
    }
  }
  return -1;
}

export function sdfNormal(sdf, x, y, z) {
  const h = 1e-3;
  const f1 = sdf(x + h, y - h, z - h), f2 = sdf(x - h, y - h, z + h);
  const f3 = sdf(x - h, y + h, z - h), f4 = sdf(x + h, y + h, z + h);
  const nx = f1 - f2 - f3 + f4, ny = -f1 - f2 + f3 + f4, nz = -f1 + f2 - f3 + f4;
  const l = sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// ---------------------------------------------------------------- anchors

function norm3(v) {
  const l = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// Anchors as in the spec, plus headTop: the y of the head's top without thin
// tufts, antennas or ears (the median of a few downward rays), for hat domes.
export function computeAnchors(shape) {
  const f = shape.sdf, b = shape.bounds, F = shape.face;
  const R = shape.rig || { axisZ: 0, hat: { mode: 'top', frac: 0.8, rmax: Infinity, y: null, z: 0 }, backY: null, neckY: null, neckSlack: 0.03 };
  const x0 = b[0] + MARGIN, y0 = b[1] + MARGIN, z0 = b[2] + MARGIN;
  const x1 = b[3] - MARGIN, y1 = b[4] - MARGIN, z1 = b[5] - MARGIN;
  const az = R.axisZ;
  const span = max(x1 - x0, y1 - y0, z1 - z0) + 1;

  const at = (p, n) => ({ p, n });
  const surfN = (p) => sdfNormal(f, p[0], p[1], p[2]);
  const faceN = (p) => {
    const n = surfN(p);
    return norm3([0.6 * n[0], 0.6 * n[1], 0.6 * n[2] + 0.4]);
  };
  const cast = (o, d) => {
    const t = traceRay(f, o, d, span + 1);
    return t < 0 ? null : [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  };
  // A front-facing point at (x, y), nudged up and down if the ray misses.
  const front = (x, y) => {
    for (let i = 0; i < 24; i++) {
      const dy = (i & 1 ? 1 : -1) * Math.ceil(i / 2) * 0.02;
      const p = cast([x, y + dy, z1 + 0.3], [0, 0, -1]);
      if (p) return p;
    }
    return [x, y, z1];
  };
  const down = (x, z) => cast([x, y1 + 0.3, z], [0, -1, 0]);
  const cross = (y, zc) => {
    const o = [0, y, zc];
    if (f(0, y, zc) >= 0) return null;
    const xr = marchOut(f, o, [1, 0, 0], span), xl = marchOut(f, o, [-1, 0, 0], span);
    const zf = marchOut(f, o, [0, 0, 1], span), zb = marchOut(f, o, [0, 0, -1], span);
    if (xr < 0 || xl < 0 || zf < 0 || zb < 0) return null;
    return { xl: -xl, xr, zb: zc - zb, zf: zc + zf };
  };

  // Head top: median of a small grid of downward rays (ignores thin tufts
  // and antennas), and the highest point at x = 0 for the 'top' anchor.
  const hs = [];
  const sq = 0.12 * (y1 - y0);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const p = down(i * sq, az + j * sq);
    if (p) hs.push(p[1]);
  }
  hs.sort((a, c) => a - c);
  const headTop = hs.length ? hs[hs.length >> 1] : y1;
  let topP = null, bestZ = az;
  const hd = 0.35 * (z1 - z0) / 2;
  for (let j = -4; j <= 4; j++) {
    const p = down(0, az + (j / 4) * hd);
    if (p && (!topP || p[1] > topP[1])) { topP = p; bestZ = az + (j / 4) * hd; }
  }
  for (let step = hd / 8; step > 1e-4; step /= 2) {
    for (const zz of [bestZ - step, bestZ + step]) {
      const p = down(0, zz);
      if (p && p[1] > topP[1]) { topP = p; bestZ = zz; }
    }
  }
  if (!topP) topP = [0, y1, az];

  // Face.
  const sp = F.eyeSpacing / 2;
  const eyeL = front(-sp, F.eyeY), eyeR = front(sp, F.eyeY);
  const mouth = front(0, F.mouthY);
  const nose = front(0, F.noseY);
  const brow = front(0, F.eyeY + F.eyeSize * 1.1);
  const cy = F.mouthY + 0.35 * (F.eyeY - F.mouthY);
  const cx = sp + F.eyeSize * 0.6;
  const cheekL = front(-cx, cy), cheekR = front(cx, cy);
  const sideL = cast([x0 - 0.3, F.eyeY, az], [1, 0, 0]) || [x0, F.eyeY, az];
  const sideR = cast([x1 + 0.3, F.eyeY, az], [-1, 0, 0]) || [x1, F.eyeY, az];

  // Rings. An ellipse through the four axis points of a cross-section can
  // still cut a boxy section at the diagonals, so rings are widened until
  // no point of theirs is inside the body (circumscribe), and a hat ring
  // that would sink into a dented top (heart, frog) is raised until it
  // rests on the highest point under it (rest).
  // Scale for a ring so that no point of it is more than `slack` inside.
  const circumscribe = (c, rx, rz, slack) => {
    let k = 1;
    for (let i = 0; i < 24; i++) {
      const t = i / 24 * 2 * PI, ct = cos(t), st = sin(t);
      const e = sqrt(rx * ct * rx * ct + rz * st * rz * st);
      const r = marchOut(f, c, [ct * rx / e, 0, st * rz / e], span);
      if (r > 0) k = max(k, (r - slack) / e);
    }
    return k;
  };
  const rest = (cx, cz, rx, rz) => {
    let y = -Infinity;
    for (let i = 0; i < 24; i++) {
      const t = i / 24 * 2 * PI;
      const p = down(cx + rx * cos(t), cz + rz * sin(t));
      if (p && p[1] > y) y = p[1];
    }
    return y;
  };
  // Depth of the body at height y around x = 0 (or a little to the sides
  // when the middle is a dent): {zb, zf} or null.
  const zSpan = (y, zc, rx) => {
    let best = null;
    for (const sx of [0, -0.5, 0.5]) {
      const o = [sx * rx, y, zc];
      if (f(o[0], o[1], o[2]) >= 0) continue;
      const zf = marchOut(f, o, [0, 0, 1], span), zb = marchOut(f, o, [0, 0, -1], span);
      if (zf > 0 && zb > 0 && (!best || zf + zb > best.zf - best.zb)) best = { zb: zc - zb, zf: zc + zf };
    }
    return best;
  };

  // Hat ring.
  const H = R.hat;
  const hz = az + H.z;
  const wRef = cross((y0 + headTop) / 2, az);
  const W = wRef ? (wRef.xr - wRef.xl) / 2 : (x1 - x0) / 2;
  const yFloor = F.eyeY + F.eyeSize * 1.5;
  let hat;
  if (H.mode === 'below' && H.y !== null) {
    const y = max(H.y, yFloor);
    const cs = cross(y, hz) || { xl: -W * 0.7, xr: W * 0.7, zb: hz - W * 0.6, zf: hz + W * 0.6 };
    const c = [(cs.xr + cs.xl) / 2, y, (cs.zf + cs.zb) / 2];
    const k = circumscribe(c, (cs.xr - cs.xl) / 2, (cs.zf - cs.zb) / 2, 0.005);
    hat = { c, rx: k * (cs.xr - cs.xl) / 2, rz: k * (cs.zf - cs.zb) / 2 };
  } else {
    const target = min(H.frac * W, H.rmax);
    let yA = headTop - 0.004, yB = yA;
    const half = (y) => { const c = cross(y, hz); return c ? (c.xr - c.xl) / 2 : 0; };
    while (yB > yFloor && half(yB) < target) { yA = yB; yB -= 0.01; }
    if (yB < yFloor) yB = yFloor;
    for (let i = 0; i < 24; i++) {
      const m = (yA + yB) / 2;
      if (half(m) < target) yA = m; else yB = m;
    }
    let y = yB, cz = hz;
    let zs = zSpan(y, hz, target);
    let rz = zs ? (zs.zf - zs.zb) / 2 : target;
    if (zs) cz = (zs.zf + zs.zb) / 2;
    if (H.mode === 'between') rz = min(rz, target * 1.25);
    for (let i = 0; i < 2; i++) {
      const yr = rest(0, cz, target, rz);
      if (!(yr > y + 0.002)) break;
      y = yr;
      zs = zSpan(y - 0.01, hz, target);
      if (zs) {
        rz = max(rz * 0.6, (zs.zf - zs.zb) / 2);
        if (H.mode === 'between') rz = min(rz, target * 1.25);
      }
    }
    hat = { c: [0, y, cz], rx: target, rz };
  }
  // Tilt follows the slope of the head under the ring center (not the top
  // point, which may be a tuft or a spike), and backs off when the tilted
  // ring would sink deeper into the surface than the level one.
  const ringMin = (tl) => {
    let m = Infinity;
    for (let i = 0; i < 32; i++) {
      const t = i / 32 * 2 * PI, lz = hat.rz * sin(t);
      m = min(m, f(hat.c[0] + hat.rx * cos(t), hat.c[1] - lz * sin(tl), hat.c[2] + lz * cos(tl)));
    }
    return m;
  };
  const under = down(hat.c[0], hat.c[2]);
  const tn = under ? surfN(under) : surfN(topP);
  let tilt = clamp(0.5 * atan2(tn[2], tn[1]), -0.3, 0.3);
  const level = ringMin(0);
  for (let i = 0; i < 4 && tilt !== 0 && ringMin(tilt) < min(level, 0) - 0.01; i++) tilt = i < 3 ? tilt * 0.5 : 0;
  hat.tilt = tilt;

  // Neck ring: about 30% up, below the mouth, hugging the body.
  let ny = R.neckY !== null ? R.neckY : y0 + 0.3 * (headTop - y0);
  ny = clamp(ny, y0 + 0.1, mouth[1] - 0.12);
  const nk = cross(ny, az) || { xl: -W * 0.8, xr: W * 0.8, zb: az - W * 0.7, zf: az + W * 0.7 };
  const nc = [(nk.xr + nk.xl) / 2, ny, (nk.zf + nk.zb) / 2];
  const nkk = circumscribe(nc, (nk.xr - nk.xl) / 2, (nk.zf - nk.zb) / 2, R.neckSlack);
  const neck = { c: nc, rx: nkk * (nk.xr - nk.xl) / 2, rz: nkk * (nk.zf - nk.zb) / 2 };

  // Back: middle of the back at about 45% height.
  const by = R.backY !== null ? R.backY : y0 + 0.45 * (headTop - y0);
  const back = cast([0, by, z0 - 0.3], [0, 0, 1]) || [0, by, z0];

  return {
    ground: y0,
    width: x1 - x0, height: y1 - y0, depth: z1 - z0,
    center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
    top: at(topP, surfN(topP)),
    headTop,
    hat,
    eyeL: at(eyeL, faceN(eyeL)), eyeR: at(eyeR, faceN(eyeR)),
    mouth: at(mouth, faceN(mouth)), nose: at(nose, faceN(nose)),
    cheekL: at(cheekL, faceN(cheekL)), cheekR: at(cheekR, faceN(cheekR)),
    brow: at(brow, faceN(brow)),
    sideL: at(sideL, surfN(sideL)), sideR: at(sideR, surfN(sideR)),
    neck,
    back: at(back, surfN(back)),
    faceRadius: F.eyeSpacing * 1.25,
  };
}
