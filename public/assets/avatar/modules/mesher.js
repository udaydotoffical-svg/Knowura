/* Dot avatar maker: surface-nets mesher for the shapes in sdf.js.
 *
 * Pure math with no imports: runs in the mesher worker, on the main thread
 * (offline viewer, fallback) and in Node.
 *
 * meshSDF(sdf, bounds, res, opts) -> {positions, normals, indices, surf,
 *   vertexCount, triangleCount}
 *  - res is the number of cells along the longest bounds axis; the other
 *    axes get as many cells as keep them cubic.
 *  - One vertex per cell whose corners change sign, placed at the mean of
 *    its edge crossings, then pulled onto the surface with two gradient
 *    steps: the first uses the exact value and the gradient of the cell's
 *    trilinear field (its corners are already sampled), the second a
 *    tetrahedral stencil. Normals are the SDF gradient from that stencil.
 *  - surf holds two floats per vertex: ambient occlusion (1 = fully open),
 *    baked from four SDF taps along the normal, and curvature in -1..1
 *    (positive = convex), tanh of the SDF Laplacian at the vertex.
 *  - Triangles wind counter-clockwise seen from outside.
 *  - opts {ao, curvature, blockSkip} all default to true.
 *
 * THINGS THAT ARE EASY TO GET WRONG, and are handled below:
 *  1. Block skip. The grid is walked in 4x4x4-cell blocks; a block whose
 *     center is farther from the surface than the block's full diagonal is
 *     not sampled at all. Every edge with a sign change therefore lies
 *     inside sampled blocks, and so do the four cells around it, so skipped
 *     blocks never open holes. Only cells of sampled blocks make vertices,
 *     and the later passes read nothing but those cells' corners, so the
 *     corners of skipped blocks (stale scratch) are never read.
 *  2. Winding. Each crossing edge emits one quad from the four cells
 *     around it; its order flips with the edge's direction (inside to
 *     outside), and the quad is split along its shorter diagonal.
 *  3. Scale. AO taps are in object units, not cells, so a res 56 thumbnail
 *     and a res 128 stage mesh shade alike.
 *  4. Speed. Corner values live in one Float32Array, vertices in growing
 *     typed arrays; nothing is allocated per sample, and the grid scratch
 *     arrays are kept between calls (only the returned arrays are new; the
 *     scratch holds about 19 MB after a res 128 mesh).
 *     Each vertex costs 10 SDF calls: 1 for the first projection step,
 *     1 + 4 for the second (value, normal, curvature) and 4 for AO.
 */

const sqrt = Math.sqrt, abs = Math.abs, min = Math.min, max = Math.max;

const B = 4;                                         // cells per block side
const AO_T = [0.035, 0.09, 0.17, 0.28];             // tap distances (object units)
const AO_W = [0.36, 0.3, 0.21, 0.13];               // tap weights, sum 1
const AO_K = 1.6;                                    // occlusion strength
const CURV_K = 0.08;                                 // Laplacian -> tanh scale

// Corner offsets (bit 0 = +x, bit 1 = +y, bit 2 = +z) and the 12 cell edges.
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];

// Grid scratch kept between calls (a worker meshes one shape at a time).
let sVal = new Float32Array(0), sState = new Uint8Array(0), sCell = new Int32Array(0);

function tanh(v) {
  if (v > 10) return 1;
  if (v < -10) return -1;
  const e = Math.exp(2 * v);
  return (e - 1) / (e + 1);
}

export function meshSDF(sdf, bounds, res, opts) {
  opts = opts || {};
  const doAO = opts.ao !== false, doCurv = opts.curvature !== false, skip = opts.blockSkip !== false;
  res = max(4, Math.round(res) || 4);

  const ex = bounds[3] - bounds[0], ey = bounds[4] - bounds[1], ez = bounds[5] - bounds[2];
  const h = max(ex, ey, ez) / res;
  const nx = max(2, Math.ceil(ex / h - 1e-6)), ny = max(2, Math.ceil(ey / h - 1e-6)), nz = max(2, Math.ceil(ez / h - 1e-6));
  // Center the grid on the bounds.
  const gx = (bounds[0] + bounds[3]) / 2 - nx * h / 2;
  const gy = (bounds[1] + bounds[4]) / 2 - ny * h / 2;
  const gz = (bounds[2] + bounds[5]) / 2 - nz * h / 2;
  const NX = nx + 1, NY = ny + 1, NXY = NX * NY;
  const nCorner = NXY * (nz + 1), nCell = nx * ny * nz;
  if (sVal.length < nCorner) { sVal = new Float32Array(nCorner); sState = new Uint8Array(nCorner); }
  if (sCell.length < nCell) sCell = new Int32Array(nCell);
  const val = sVal;

  // ---- 1. sample corners (with block skipping) ----
  const nbx = Math.ceil(nx / B), nby = Math.ceil(ny / B), nbz = Math.ceil(nz / B);
  const active = new Uint8Array(nbx * nby * nbz);
  if (skip) {
    const state = sState;                                   // 1 = sampled
    state.fill(0, 0, nCorner);
    for (let bk = 0; bk < nbz; bk++) {
      const k0 = bk * B, k1 = min(k0 + B, nz);
      for (let bj = 0; bj < nby; bj++) {
        const j0 = bj * B, j1 = min(j0 + B, ny);
        for (let bi = 0; bi < nbx; bi++) {
          const i0 = bi * B, i1 = min(i0 + B, nx);
          const b = bi + nbx * (bj + nby * bk);
          const wx = (i1 - i0) * h, wy = (j1 - j0) * h, wz = (k1 - k0) * h;
          const c = sdf(gx + (i0 + i1) * 0.5 * h, gy + (j0 + j1) * 0.5 * h, gz + (k0 + k1) * 0.5 * h);
          if (abs(c) > sqrt(wx * wx + wy * wy + wz * wz)) continue;
          active[b] = 1;
          for (let k = k0; k <= k1; k++) {
            const z = gz + k * h;
            for (let j = j0; j <= j1; j++) {
              const y = gy + j * h;
              let idx = i0 + NX * (j + NY * k);
              for (let i = i0; i <= i1; i++, idx++) {
                if (state[idx] === 0) { val[idx] = sdf(gx + i * h, y, z); state[idx] = 1; }
              }
            }
          }
        }
      }
    }
  } else {
    active.fill(1);
    for (let k = 0, idx = 0; k <= nz; k++) {
      const z = gz + k * h;
      for (let j = 0; j <= ny; j++) {
        const y = gy + j * h;
        for (let i = 0; i <= nx; i++, idx++) val[idx] = sdf(gx + i * h, y, z);
      }
    }
  }

  // ---- 2. one vertex per sign-changing cell ----
  const cellIdx = sCell;
  cellIdx.fill(-1, 0, nCell);
  let cap = 16384, vc = 0;
  let pos = new Float32Array(cap * 3);
  let cells = new Int32Array(cap);
  const cv = new Float64Array(8);
  const cornerOff = [0, 1, NX, NX + 1, NXY, NXY + 1, NXY + NX, NXY + NX + 1];
  for (let bk = 0; bk < nbz; bk++) {
    for (let bj = 0; bj < nby; bj++) {
      for (let bi = 0; bi < nbx; bi++) {
        if (active[bi + nbx * (bj + nby * bk)] === 0) continue;
        const k1 = min(bk * B + B, nz), j1 = min(bj * B + B, ny), i1 = min(bi * B + B, nx);
        for (let k = bk * B; k < k1; k++) {
          for (let j = bj * B; j < j1; j++) {
            for (let i = bi * B; i < i1; i++) {
              const base = i + NX * (j + NY * k);
              let mask = 0;
              for (let c = 0; c < 8; c++) {
                const v = val[base + cornerOff[c]];
                cv[c] = v;
                if (v < 0) mask |= 1 << c;
              }
              if (mask === 0 || mask === 255) continue;
              let sx = 0, sy = 0, sz = 0, n = 0;
              for (let e = 0; e < 24; e += 2) {
                const a = EDGES[e], bb = EDGES[e + 1];
                const va = cv[a], vb = cv[bb];
                if ((va < 0) === (vb < 0)) continue;
                const t = va / (va - vb);
                sx += (a & 1) + ((bb & 1) - (a & 1)) * t;
                sy += ((a >> 1) & 1) + (((bb >> 1) & 1) - ((a >> 1) & 1)) * t;
                sz += ((a >> 2) & 1) + (((bb >> 2) & 1) - ((a >> 2) & 1)) * t;
                n++;
              }
              if (vc === cap) {
                cap *= 2;
                const p2 = new Float32Array(cap * 3); p2.set(pos); pos = p2;
                const c2 = new Int32Array(cap); c2.set(cells); cells = c2;
              }
              pos[vc * 3] = gx + (i + sx / n) * h;
              pos[vc * 3 + 1] = gy + (j + sy / n) * h;
              pos[vc * 3 + 2] = gz + (k + sz / n) * h;
              const cell = i + nx * (j + ny * k);
              cells[vc] = cell;
              cellIdx[cell] = vc++;
            }
          }
        }
      }
    }
  }

  // ---- 3. quads around every crossing edge ----
  let icap = vc * 6 + 64, ic = 0;
  let idxArr = new Uint32Array(icap);
  const P = pos;
  function quad(a, b, c, d) {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (ic + 6 > icap) {
      icap *= 2;
      const n2 = new Uint32Array(icap); n2.set(idxArr); idxArr = n2;
    }
    const acx = P[a * 3] - P[c * 3], acy = P[a * 3 + 1] - P[c * 3 + 1], acz = P[a * 3 + 2] - P[c * 3 + 2];
    const bdx = P[b * 3] - P[d * 3], bdy = P[b * 3 + 1] - P[d * 3 + 1], bdz = P[b * 3 + 2] - P[d * 3 + 2];
    if (acx * acx + acy * acy + acz * acz <= bdx * bdx + bdy * bdy + bdz * bdz) {
      idxArr[ic++] = a; idxArr[ic++] = b; idxArr[ic++] = c;
      idxArr[ic++] = a; idxArr[ic++] = c; idxArr[ic++] = d;
    } else {
      idxArr[ic++] = a; idxArr[ic++] = b; idxArr[ic++] = d;
      idxArr[ic++] = b; idxArr[ic++] = c; idxArr[ic++] = d;
    }
  }
  const sxC = 1, syC = nx, szC = nx * ny;
  for (let v = 0; v < vc; v++) {
    const cell = cells[v];
    const i = cell % nx, j = ((cell / nx) | 0) % ny, k = (cell / (nx * ny)) | 0;
    const c0 = val[i + NX * (j + NY * k)];
    const in0 = c0 < 0;
    // +x edge: cells (j-1..j, k-1..k)
    if (j > 0 && k > 0 && (val[i + 1 + NX * (j + NY * k)] < 0) !== in0) {
      const a = cellIdx[cell - syC - szC], b = cellIdx[cell - szC], c = v, d = cellIdx[cell - syC];
      if (in0) quad(a, b, c, d); else quad(d, c, b, a);
    }
    // +y edge: cells (i-1..i, k-1..k)
    if (i > 0 && k > 0 && (val[i + NX * (j + 1 + NY * k)] < 0) !== in0) {
      const a = cellIdx[cell - sxC - szC], b = cellIdx[cell - sxC], c = v, d = cellIdx[cell - szC];
      if (in0) quad(a, b, c, d); else quad(d, c, b, a);
    }
    // +z edge: cells (i-1..i, j-1..j)
    if (i > 0 && j > 0 && (val[i + NX * (j + NY * (k + 1))] < 0) !== in0) {
      const a = cellIdx[cell - sxC - syC], b = cellIdx[cell - syC], c = v, d = cellIdx[cell - sxC];
      if (in0) quad(a, b, c, d); else quad(d, c, b, a);
    }
  }

  // ---- 4. project, normals, curvature, AO ----
  const positions = new Float32Array(vc * 3);
  const normals = new Float32Array(vc * 3);
  const surf = new Float32Array(vc * 2);
  const k2 = max(0.6 * h, 0.004);
  const maxStep = 0.9 * h;
  const ih = 1 / h;
  for (let v = 0; v < vc; v++) {
    let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    // step 1: exact value, gradient of the cell's trilinear field
    {
      const cell = cells[v];
      const i = cell % nx, j = ((cell / nx) | 0) % ny, k = (cell / (nx * ny)) | 0;
      const base = i + NX * (j + NY * k);
      const c0 = val[base], c1 = val[base + 1], c2 = val[base + NX], c3 = val[base + NX + 1];
      const c4 = val[base + NXY], c5 = val[base + NXY + 1], c6 = val[base + NXY + NX], c7 = val[base + NXY + NX + 1];
      const u = (x - gx) * ih - i, w1 = (y - gy) * ih - j, w2 = (z - gz) * ih - k;
      const u0 = 1 - u, v0 = 1 - w1, t0 = 1 - w2;
      const tx = ((c1 - c0) * v0 * t0 + (c3 - c2) * w1 * t0 + (c5 - c4) * v0 * w2 + (c7 - c6) * w1 * w2) * ih;
      const ty = ((c2 - c0) * u0 * t0 + (c3 - c1) * u * t0 + (c6 - c4) * u0 * w2 + (c7 - c5) * u * w2) * ih;
      const tz = ((c4 - c0) * u0 * v0 + (c5 - c1) * u * v0 + (c6 - c2) * u0 * w1 + (c7 - c3) * u * w1) * ih;
      const t2 = tx * tx + ty * ty + tz * tz;
      if (t2 > 1e-12) {
        const s = sdf(x, y, z) / t2;
        let mx = s * tx, my = s * ty, mz = s * tz;
        const ml = sqrt(mx * mx + my * my + mz * mz);
        if (ml > maxStep) { const r = maxStep / ml; mx *= r; my *= r; mz *= r; }
        x -= mx; y -= my; z -= mz;
      }
    }
    // step 2: exact value plus a wider stencil for normal and curvature
    const f0 = sdf(x, y, z);
    const f1 = sdf(x + k2, y - k2, z - k2), f2 = sdf(x - k2, y - k2, z + k2);
    const f3 = sdf(x - k2, y + k2, z - k2), f4 = sdf(x + k2, y + k2, z + k2);
    const ux = f1 - f2 - f3 + f4, uy = -f1 - f2 + f3 + f4, uz = -f1 + f2 - f3 + f4;
    const g2 = ux * ux + uy * uy + uz * uz;
    let nxv = 0, nyv = 1, nzv = 0;
    if (g2 > 1e-24) {
      const gl = sqrt(g2);
      nxv = ux / gl; nyv = uy / gl; nzv = uz / gl;
      const grad = gl / (4 * k2);
      let st = f0 / max(grad, 0.2);
      if (st > maxStep) st = maxStep; else if (st < -maxStep) st = -maxStep;
      x -= nxv * st; y -= nyv * st; z -= nzv * st;
    }
    positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
    normals[v * 3] = nxv; normals[v * 3 + 1] = nyv; normals[v * 3 + 2] = nzv;
    let curv = 0;
    if (doCurv) curv = tanh(CURV_K * (f1 + f2 + f3 + f4 - 4 * f0) / (2 * k2 * k2));
    let ao = 1;
    if (doAO) {
      let occ = 0;
      for (let t = 0; t < 4; t++) {
        const dt = AO_T[t];
        const d = sdf(x + nxv * dt, y + nyv * dt, z + nzv * dt);
        const o = (dt - d) / dt;
        if (o > 0) occ += AO_W[t] * (o < 1 ? o : 1);
      }
      ao = 1 - AO_K * occ;
      if (ao < 0) ao = 0;
    }
    surf[v * 2] = ao;
    surf[v * 2 + 1] = curv;
  }

  return {
    positions, normals, surf,
    indices: idxArr.length === ic ? idxArr : idxArr.slice(0, ic),
    vertexCount: vc, triangleCount: ic / 3,
  };
}
