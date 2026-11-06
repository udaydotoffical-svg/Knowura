/* Dot avatar maker: character assembly, and the full-window viewer of the offline 3D file.
 *
 * Two exports, both factories with no imports (spec 0.6):
 *
 *   buildCharacter(THREE, mods, mats, state[, mesh[, opts]]) -> Character
 *     mods  = {catalog, sdf, mesher, face, accessories} module namespaces (mesher only when no mesh)
 *     mats  = createMaterials(THREE, renderer, quality) from materials.js
 *     mesh  = {positions, normals, indices, surf[, anchors]} as mesher-worker.js posts it; when it is
 *             missing the body is meshed here on the main thread with mods.mesher.meshSDF().
 *     opts  = {res: 112, quality: {fur, shadows}, anchors, ground: true, fur: true,
 *              faceFactory, accessoryFactory}   all optional
 *   Character = {
 *     group,       THREE.Group, ground at y = 0 and centered on x/z (ground: false keeps object space),
 *                  measured on the body mesh itself (anchors.ground and center are the fallback).
 *                  Do NOT translate it again for grounding; rotate and scale it freely.
 *                  group > pivot (idle sway and breathing, pivot at the ground) > content (offset)
 *     anchors,     object-space anchors (sdf.computeAnchors); offset maps them into group space
 *     offset,      [x, y, z] translation applied to content
 *     box,         {min:[x,y,z], max:[x,y,z]} of the whole character at rest in group space, fur excluded
 *                  (fur adds up to furLength), accessories included: use it for framing
 *     bodyBox,     the same for the body mesh alone: use it for the contact shadow footprint
 *     parts,       {body, fur, face (FaceRig), hat, glasses, extra (Groups or null), content, pivot}
 *     mesh,        the mesh data used (cache it to rebuild after a context loss without remeshing)
 *     state, shape, furLength, transmissive, errors (a face or accessory that failed is skipped and
 *                  its Error kept here, so one broken part never blanks the character)
 *     update(t, motion)  idle motion at time t (seconds) with amount motion 0..1: sway about +/-0.25
 *                  rad over 12 s, breathing +/-1.2 %, a blink every 2.5-6 s (0.15 s), fur wind.
 *                  motion 0 is the rest pose with eyes open. The caller owns the clock.
 *     rest()       rest pose now (for snapshots: eyes open, no breathing, no sway)
 *     setBlink(v), dispose()   dispose frees geometries, the fur material and the face rig; the body
 *                  and accessory materials belong to mats (cached there) and are left to mats.dispose().
 *   }
 *
 *   start(THREE, mods, STATE) -> Promise<Viewer|null>
 *     Used only inside the offline HTML (exporter.js): meshes once on the main thread and shows the
 *     character full-window over a CSS gradient. Drag turns it (with inertia), wheel or pinch zooms,
 *     arrows, + and - and 0 work from the keyboard, double-click resets, a button toggles idle
 *     motion, and a small credit link points back to the maker with the same character.
 *     It makes no network request.
 *
 * THINGS THAT ARE EASY TO GET WRONG, and are handled below:
 *  1. Breathing scales about the ground point, not the object origin, or the feet sink into the floor.
 *  2. Fur shells cannot sit over the eyes and mouth or under a hat brim: trims go to mats.setFurTrims,
 *     eyes and mouth first (the face rig's own rig.trims when it has them), then accessory
 *     occluders, then the nose, at most 6.
 *  3. Yaw turns the character, not the camera, so the key light keeps lighting the face.
 *  4. Reset turns back the short way: the goal is the nearest whole turn, not yaw 0.
 *  5. A lost WebGL context loses the PMREM environment too: the materials are rebuilt on restore,
 *     from the cached mesh data.
 */

const TAU = Math.PI * 2;
const SWAY = 0.25, SWAY_PERIOD = 12;
const BREATH = 0.012, BREATH_PERIOD = 3.4;
const BLINK_TIME = 0.15;
const MAX_TRIMS = 6;

const FACTORIES = new WeakMap();

function factoriesFor(THREE, mods, mats, opts) {
  let f = FACTORIES.get(mats);
  if (!f) {
    f = {
      face: mods.face && typeof mods.face.createFace === 'function' ? mods.face.createFace(THREE, mats) : null,
      acc: mods.accessories && typeof mods.accessories.createAccessories === 'function'
        ? mods.accessories.createAccessories(THREE, mats) : null
    };
    FACTORIES.set(mats, f);
  }
  return { face: opts.faceFactory || f.face, acc: opts.accessoryFactory || f.acc };
}

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isTransmissive(mats, finishId) {
  if (typeof mats.isTransmissive === 'function') return !!mats.isTransmissive(finishId);
  return finishId === 'jelly' || finishId === 'glass';
}

// Trap 2: spheres where fur is shortened, in priority order. The face rig's own trims (sized from
// the features it actually built) win; without them the eyes and mouth are estimated from anchors.
function furTrims(shape, anchors, occluders, faceTrims) {
  const face = shape.face || {};
  const fr = anchors.faceRadius || 0.2;
  const eye = face.eyeSize > 0 ? face.eyeSize : fr * 0.22;
  const trims = [];
  const at = (a, r) => { if (a && a.p) trims.push({ c: a.p.slice(0, 3), r }); };
  const own = (faceTrims || []).filter((t) => t && t.c && t.r > 0);
  if (own.length) {
    own.forEach((t) => trims.push({ c: t.c.slice(0, 3), r: t.r }));
  } else {
    at(anchors.eyeL, eye * 1.9);
    at(anchors.eyeR, eye * 1.9);
    at(anchors.mouth, Math.max(eye * 1.6, fr * 0.3));
  }
  for (const o of occluders || []) {
    if (o && o.c && o.r > 0) trims.push({ c: o.c.slice(0, 3), r: o.r });
  }
  if (face.nose && face.nose !== 'none') at(anchors.nose, eye * 1.4);
  return trims.slice(0, MAX_TRIMS);
}

// Opaque accessory meshes cast shadows; lenses, glows and other see-through parts do not.
function prepAccessory(THREE, group) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const see = m && (m.transparent || (m.blending !== undefined && m.blending !== THREE.NormalBlending));
    o.castShadow = !(see || (o.userData && o.userData.noShadow));
    o.receiveShadow = false;
  });
}

// Box of every mesh under root except `skip`, in root's space (root has no parent here).
function restBox(THREE, root, skip) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    if (o === skip || !o.geometry || o.visible === false || o.isSprite) return;
    if (o.isInstancedMesh) {
      if (typeof o.computeBoundingBox === 'function') o.computeBoundingBox();
      if (!o.boundingBox) return;
      tmp.copy(o.boundingBox);
    } else {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (!o.geometry.boundingBox) return;
      tmp.copy(o.geometry.boundingBox);
    }
    if (tmp.isEmpty()) return;
    tmp.applyMatrix4(o.matrixWorld);
    box.union(tmp);
  });
  return box;
}

// The anchors' AABB in group space: side 0 = min corner, 1 = max corner.
function box0(a, offset, side) {
  const c = a.center || [0, 0, 0];
  const h = [(a.width || 1.6) / 2, (a.height || 1.5) / 2, (a.depth || 1) / 2];
  return [0, 1, 2].map((i) => c[i] + (side ? h[i] : -h[i]) + offset[i]);
}

// A brim (bucket, cowboy, sun hat) or a low cuff can come down over the eyes where the hat ring
// sits low between tall ears (fox, cat) or when fur raises the eyes. The hat is lifted until no
// part of it hangs over either eye's footprint below that eye's top, by at most 0.22 units.
// A cyclops has one eye, a group named 'eyeC' (face.js), and no eyeL/eyeR.
function clearEyes(THREE, content, hat, faceGroup) {
  const eyes = [];
  faceGroup.traverse((o) => { if (o.name === 'eyeL' || o.name === 'eyeR' || o.name === 'eyeC') eyes.push(o); });
  if (!eyes.length) return;
  content.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let lift = 0;
  for (const eye of eyes) {
    const eb = new THREE.Box3().setFromObject(eye);
    if (eb.isEmpty()) continue;
    const top = eb.max.y + 0.012;
    let low = Infinity;
    hat.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (v.x < eb.min.x || v.x > eb.max.x || v.z < eb.min.z - 0.02 || v.y < eb.min.y - 0.02) continue;
        if (v.y < low) low = v.y;
      }
    });
    if (low < top) lift = Math.max(lift, top - low);
  }
  if (lift > 0) hat.position.y += Math.min(0.22, lift);
}

function disposeMaterial(m) {
  if (!m) return;
  (Array.isArray(m) ? m : [m]).forEach((x) => { if (x && typeof x.dispose === 'function') x.dispose(); });
}

export function buildCharacter(THREE, mods, mats, state, mesh, opts = {}) {
  if (!mods || !mods.sdf) throw new Error('buildCharacter: mods.sdf is required');
  if (!mats || typeof mats.body !== 'function') throw new Error('buildCharacter: mats from createMaterials is required');
  const catalog = mods.catalog || {};
  const s = typeof catalog.normalize === 'function' ? catalog.normalize(state || {}) : Object.assign({}, state);
  const shape = mods.sdf.getShape(s.shape);
  const quality = opts.quality || { fur: 1, shadows: true };
  const errors = [];

  let data = mesh;
  if (!data) {
    if (!mods.mesher || typeof mods.mesher.meshSDF !== 'function') throw new Error('buildCharacter: no mesh and no mesher');
    data = mods.mesher.meshSDF(shape.sdf, shape.bounds, opts.res || 112, { ao: true, curvature: true, blockSkip: true });
  }
  const anchors = opts.anchors || data.anchors || mods.sdf.computeAnchors(shape);

  // Body geometry straight from the mesher's typed arrays.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  if (data.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  if (data.surf) geometry.setAttribute('surf', new THREE.BufferAttribute(data.surf, 2));
  if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  if (!data.normals) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const look = mats.body(s.finish, s.color, shape);
  const furLength = look.furLength || 0;
  const transmissive = isTransmissive(mats, s.finish);
  const body = new THREE.Mesh(geometry, look.material);
  body.name = 'body';
  body.castShadow = true;
  body.receiveShadow = !!quality.shadows;

  const content = new THREE.Group();
  content.name = 'content';
  content.add(body);

  let fur = null;
  if (look.fur && opts.fur !== false && typeof mats.makeFur === 'function') {
    try {
      fur = mats.makeFur(geometry, s.finish, s.color, shape, quality);
      if (fur) {
        fur.name = 'fur';
        fur.castShadow = false;          // the depth-only body under it casts the shadow
        fur.receiveShadow = !!quality.shadows;
        content.add(fur);
      }
    } catch (e) {
      errors.push(e);
      fur = null;
    }
  }

  const fx = factoriesFor(THREE, mods, mats, opts);
  let face = null;
  if (fx.face) {
    try {
      face = fx.face.build(shape, anchors, {
        face: s.face, mouth: s.mouth, blush: !!s.blush, lashes: !!s.lashes,
        hex: s.color, finishId: s.finish, furLength
      });
      if (face && face.group) {
        face.group.name = face.group.name || 'face';
        content.add(face.group);
      }
    } catch (e) {
      errors.push(e);
      face = null;
    }
  }

  const parts = { body, fur, face, hat: null, glasses: null, extra: null, content, pivot: null };
  const occluders = [];
  // faceMeta tells accessories.js the eye size and whether the face is a cyclops; eyeC, the built
  // cyclops eye (face.js group 'eyeC') measured in content space, wins over it: {p, n, r}. sdf lets
  // the head bands find a cap that hangs over the forehead (the mushroom's).
  const ctx = { hex: s.color, soft: !!look.soft, furLength, finishId: s.finish, transmissive, faceMeta: shape.face, sdf: shape.sdf };
  try {
    const eyeC = face && face.group ? face.group.getObjectByName('eyeC') : null;
    if (eyeC) {
      content.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(content.matrixWorld).invert();
      const m = new THREE.Matrix4().multiplyMatrices(inv, eyeC.matrixWorld);
      const box = new THREE.Box3().setFromObject(eyeC).applyMatrix4(inv);
      if (!box.isEmpty()) {
        ctx.eyeC = {
          p: new THREE.Vector3().setFromMatrixPosition(m).toArray(),
          n: new THREE.Vector3(0, 0, 1).transformDirection(m).toArray(),
          r: (box.max.x - box.min.x) / 2
        };
      }
    }
  } catch (e) { errors.push(e); }
  for (const slot of ['hat', 'glasses', 'extra']) {
    const id = s[slot];
    if (!id || id === 'none' || !fx.acc) continue;
    try {
      const g = fx.acc.build(slot, id, anchors, ctx);
      if (g) {
        g.name = g.name || slot;
        prepAccessory(THREE, g);
        content.add(g);
        parts[slot] = g;
      }
      if (typeof fx.acc.occluders === 'function') {
        const occ = fx.acc.occluders(slot, id, anchors);
        if (Array.isArray(occ)) occluders.push(...occ);
      }
    } catch (e) {
      errors.push(e);
    }
  }
  if (parts.hat && face && face.group) {
    try { clearEyes(THREE, content, parts.hat, face.group); } catch (e) { errors.push(e); }
  }
  if (fur && typeof mats.setFurTrims === 'function') {
    try {
      mats.setFurTrims(fur, furTrims(shape, anchors, occluders, face && Array.isArray(face.trims) ? face.trims : null));
    } catch (e) { errors.push(e); }
  }

  // Ground at y = 0, centered on x/z; the pivot sits on the ground (trap 1). The body mesh's own
  // box is the surface itself, so it wins over the traced anchors; they are the fallback.
  const mb = geometry.boundingBox;
  const meshOk = mb && !mb.isEmpty() && isFinite(mb.min.y);
  const c = anchors.center || [0, 0, 0];
  const gx = meshOk ? (mb.min.x + mb.max.x) / 2 : c[0];
  const gy = meshOk ? mb.min.y : (anchors.ground || 0);
  const gz = meshOk ? (mb.min.z + mb.max.z) / 2 : c[2];
  const offset = opts.ground === false ? [0, 0, 0] : [-gx, -gy, -gz];
  content.position.set(offset[0], offset[1], offset[2]);
  const pivot = new THREE.Group();
  pivot.name = 'pivot';
  pivot.add(content);
  const group = new THREE.Group();
  group.name = 'dot-avatar';
  group.add(pivot);
  parts.pivot = pivot;

  const b3 = restBox(THREE, group, fur);
  const bodyBox = meshOk
    ? { min: [mb.min.x + offset[0], mb.min.y + offset[1], mb.min.z + offset[2]], max: [mb.max.x + offset[0], mb.max.y + offset[1], mb.max.z + offset[2]] }
    : { min: box0(anchors, offset, 0), max: box0(anchors, offset, 1) };
  const box = b3.isEmpty()
    ? { min: [-0.8, 0, -0.6], max: [0.8, 1.5, 0.6] }
    : { min: b3.min.toArray(), max: b3.max.toArray() };

  // Idle motion. Blinks come from a generator seeded by the character, so a given avatar blinks
  // the same way every time; time going backwards (a reset clock) restarts the schedule.
  const random = typeof catalog.mulberry32 === 'function'
    ? catalog.mulberry32(hashSeed(JSON.stringify(s))) : seededRandom(hashSeed(JSON.stringify(s)));
  let nextBlink = -1, blinkAt = -1e9, lastT = -1e9;
  let disposed = false;

  function setBlink(v) {
    if (face && typeof face.setBlink === 'function') face.setBlink(v);
  }

  function update(t, motion) {
    if (disposed) return;
    const m = motion > 0 ? Math.min(1, motion) : 0;
    const breath = Math.sin((t * TAU) / BREATH_PERIOD) * BREATH * m;
    pivot.scale.set(1 - breath * 0.5, 1 + breath, 1 - breath * 0.5);
    pivot.rotation.y = Math.sin((t * TAU) / SWAY_PERIOD) * SWAY * m;
    pivot.rotation.z = Math.sin((t * TAU) / 9.1 + 1.3) * 0.02 * m;
    let blink = 0;
    if (m > 0) {
      if (nextBlink < 0 || t < lastT) nextBlink = t + 1 + random() * 2.5;
      if (t >= nextBlink) { blinkAt = t; nextBlink = t + 2.5 + random() * 3.5; }
      const k = (t - blinkAt) / BLINK_TIME;
      // Close fast, hold shut for a couple of frames, open a little slower.
      if (k >= 0 && k <= 1) blink = (k < 0.35 ? k / 0.35 : k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45) * Math.min(1, m * 2);
    }
    lastT = t;
    setBlink(blink);
    if (fur && fur.userData && typeof fur.userData.update === 'function') fur.userData.update(t, m);
  }

  function setFace(next) {
    if (disposed) return;
    if (face && face.group) {
      content.remove(face.group);
      if (typeof face.dispose === 'function') { try { face.dispose(); } catch (e) { /* already disposed */ } }
    }
    face = next || null;
    parts.face = face;
    if (face && face.group) {
      face.group.name = face.group.name || 'face';
      content.add(face.group);
    }
    setBlink(0);
  }

  function rest() {
    if (disposed) return;
    pivot.scale.set(1, 1, 1);
    pivot.rotation.set(0, 0, 0);
    setBlink(0);
    if (fur && fur.userData && typeof fur.userData.update === 'function') fur.userData.update(Math.max(0, lastT), 0);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (group.parent) group.parent.remove(group);
    geometry.dispose();
    // The body material belongs to mats (cached per finish, color and shape, and reused by the
    // next character when only an accessory changed). Disposing it here would release its program
    // and stall the next frame on a recompile; mats disposes it when it leaves its cache.
    if (fur) {
      if (fur.geometry && fur.geometry !== geometry) fur.geometry.dispose();
      if (fur.material !== body.material) disposeMaterial(fur.material);
    }
    if (face && typeof face.dispose === 'function') {
      try { face.dispose(); } catch (e) { /* already gone */ }
    }
    for (const slot of ['hat', 'glasses', 'extra']) {
      const g = parts[slot];
      if (!g) continue;
      g.traverse((o) => {
        if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
        if (o.userData && typeof o.userData.dispose === 'function') o.userData.dispose();
      });
    }
  }

  return {
    group, anchors, offset, box, bodyBox, parts, mesh: data, state: s, shape, furLength, transmissive, errors,
    update, rest, setBlink, setFace, dispose
  };
}

/* ---------------- offline viewer ---------------- */

const NO_WEBGL = "Your browser can't show 3D here. Try a current version of Chrome, Edge, Firefox or Safari.";
const PITCH_MAX = (25 * Math.PI) / 180;
const BASE_PITCH = 0.12;
const ZOOM_MIN = 0.75, ZOOM_MAX = 1.6;
const FOV = 24;

const VIEWER_CSS = [
  '.dv-canvas{position:fixed;top:0;left:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;outline:none}',
  '.dv-canvas.is-dragging{cursor:grabbing}',
  '.dv-canvas:focus-visible{outline:2px solid #2f80ed;outline-offset:-6px}',
  '.dv-bar{position:fixed;top:16px;right:16px;display:flex;gap:8px;z-index:2}',
  '.dv-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;',
  'padding:0 14px;box-sizing:border-box;border-radius:999px;border:1px solid rgba(0,0,0,.14);background:rgba(255,255,255,.8);',
  'color:#1d1d22;font:inherit;font-size:14px;cursor:pointer;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
  '.dv-btn:hover{background:#fff}',
  '.dv-btn:focus-visible{outline:2px solid #2f80ed;outline-offset:3px}',
  '.dv-btn svg{width:18px;height:18px;flex:none}',
  '.dv-btn[aria-pressed="false"] .dv-on{display:none}',
  '.dv-btn[aria-pressed="true"] .dv-off{display:none}',
  '.dv-icon{padding:0}',
  '.dv-credit{position:fixed;left:16px;bottom:14px;z-index:2;font-size:13px;color:inherit;opacity:.8;text-decoration:none}',
  '.dv-credit:hover{opacity:1;text-decoration:underline}',
  '.dv-credit:focus-visible{outline:2px solid #2f80ed;outline-offset:3px;border-radius:2px}',
  '.dv-hint{position:fixed;right:16px;bottom:14px;margin:0;font-size:13px;opacity:.75;transition:opacity .8s;pointer-events:none}',
  '.dv-hint.is-gone{opacity:0}',
  '@media (max-width:520px){.dv-hint{bottom:40px;left:16px;right:auto}}',
  '@media (prefers-color-scheme:dark){.dv-btn{background:rgba(40,41,48,.8);border-color:rgba(255,255,255,.16);color:#ececf0}',
  '.dv-btn:hover{background:#2c2d34}}',
  '@media (prefers-reduced-motion:reduce){.dv-hint{transition:none}}'
].join('');

const ICON_MOTION_ON = '';
const ICON_MOTION_OFF = '';
const ICON_RESET = '';

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function buildDom(doc, describe, href, touch) {
  const style = doc.createElement('style');
  style.textContent = VIEWER_CSS;
  doc.head.appendChild(style);

  const canvas = doc.createElement('canvas');
  canvas.className = 'dv-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '3D avatar: ' + describe + '. Drag or use the arrow keys to turn it; scroll, pinch, or plus and minus zoom; 0 resets the view.');

  const bar = doc.createElement('div');
  bar.className = 'dv-bar';
  const motion = doc.createElement('button');
  motion.type = 'button';
  motion.className = 'dv-btn';
  motion.title = 'Idle motion';
  motion.innerHTML = ICON_MOTION_ON + ICON_MOTION_OFF + '<span>Motion</span>';
  const reset = doc.createElement('button');
  reset.type = 'button';
  reset.className = 'dv-btn dv-icon';
  reset.setAttribute('aria-label', 'Reset view');
  reset.title = 'Reset view';
  reset.innerHTML = ICON_RESET;
  bar.append(motion, reset);

  const credit = doc.createElement('a');
  credit.className = 'dv-credit';
  credit.href = href;
  credit.target = '_blank';
  credit.rel = 'noopener';
  credit.textContent = 'Made with siter.io/dot-avatar-maker';

  const hint = doc.createElement('p');
  hint.className = 'dv-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = touch ? 'Drag to turn, pinch to zoom' : 'Drag to turn, scroll to zoom';

  let msg = doc.getElementById('da-msg');
  if (!msg) {
    msg = doc.createElement('p');
    msg.id = 'da-msg';
    msg.setAttribute('role', 'status');
    doc.body.appendChild(msg);
  }
  const stage = doc.getElementById('model-stage');
  (stage || doc.body).appendChild(canvas);
  doc.body.append(bar, credit, hint);
  return { canvas, motion, reset, credit, hint, msg };
}

function contactShadow(THREE, doc) {
  const c = doc.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.24)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.renderOrder = -1;
  mesh.name = 'contact-shadow';
  return mesh;
}

// Lets the "Building" message paint first. A background tab runs no animation frames, so a
// timeout stands in and the build still happens before the tab is shown.
function nextPaint(win) {
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    win.requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 150);
  });
}

export async function start(THREE, mods, STATE) {
  const doc = document, win = window;
  const embedMode = doc.documentElement.classList.contains('avatar-embed');
  const catalog = (mods && mods.catalog) || {};
  const state = typeof catalog.normalize === 'function' ? catalog.normalize(STATE || {}) : (STATE || {});
  const text = typeof catalog.describe === 'function' ? catalog.describe(state) : 'a dot avatar';
  const href = typeof catalog.siteUrl === 'function' ? catalog.siteUrl(state) : 'https://siter.io/dot-avatar-maker';
  const media = (q) => !!(win.matchMedia && win.matchMedia(q).matches);
  const coarse = media('(pointer: coarse)');
  const reduced = media('(prefers-reduced-motion: reduce)');
  const ui = buildDom(doc, text, href, coarse);
  const say = (m) => { ui.msg.textContent = m || ''; ui.msg.hidden = !m; };
  say('Building your avatar…');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    ui.canvas.hidden = true;
    say(NO_WEBGL);
    return null;
  }
  renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.setClearAlpha?.(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping !== undefined ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // Fur shells cost (shells x pixels): fewer at a high pixel ratio, as on the page (materials.js).
  const quality = {
    fur: mods.materials && typeof mods.materials.furQualityFor === 'function'
      ? mods.materials.furQualityFor({ dpr: renderer.getPixelRatio(), coarse }) : (coarse ? 0.5 : 1),
    shadows: true
  };
  const res = coarse ? 104 : 128;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
  const target = new THREE.Vector3(0, 0.7, 0);
  const holder = new THREE.Group();
  scene.add(holder);

  const key = new THREE.DirectionalLight(0xfff0dc, 1.6);
  key.position.set(-2.4, 4.2, 3.2);
  key.target.position.set(0, 0.6, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(coarse ? 512 : 1024, coarse ? 512 : 1024);
  const sc = key.shadow.camera;
  sc.left = -1.8; sc.right = 1.8; sc.top = 1.8; sc.bottom = -1.8; sc.near = 0.5; sc.far = 14;
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xd2e2ff, 1.1);
  rim.position.set(2.6, 2.4, -3.2);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xf4f6ff, 0xe6dccd, 0.35));

  if (!embedMode) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity: 0.12 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }
  const contact = contactShadow(THREE, doc);
  holder.add(contact);

  let mats = null, ch = null, meshData = null;
  let baseDist = 6;

  function build() {
    mats = mods.materials.createMaterials(THREE, renderer, quality);
    scene.environment = mats.env || null;
    ch = buildCharacter(THREE, mods, mats, state, meshData, { res, quality });
    meshData = ch.mesh;
    holder.add(ch.group);
    const bb = ch.bodyBox;
    contact.scale.set(Math.max(0.3, (bb.max[0] - bb.min[0]) * 0.92), Math.max(0.3, (bb.max[2] - bb.min[2]) * 0.92), 1);
  }

  function computeFrame() {
    const b = ch ? ch.box : { min: [-0.8, 0, -0.6], max: [0.8, 1.5, 0.6] };
    const pad = ch ? ch.furLength : 0;
    const halfH = (b.max[1] - b.min[1]) / 2 + pad + 0.03;
    target.set(0, (b.min[1] + b.max[1]) / 2, 0);
    // Farthest the character reaches from its turning axis, so no yaw ever crops it.
    let rxz = 0;
    for (const x of [b.min[0], b.max[0]]) for (const z of [b.min[2], b.max[2]]) rxz = Math.max(rxz, Math.hypot(x, z));
    rxz += pad;
    const vt = Math.tan((FOV * Math.PI) / 360);
    const ht = vt * camera.aspect;
    baseDist = (Math.max(halfH / vt, rxz / ht) + rxz * 0.6) * 1.08 * (coarse ? 0.84 : 1.65);
  }

  const view = { yaw: 0, yawGoal: 0, pitch: BASE_PITCH, pitchGoal: BASE_PITCH, zoom: 1, zoomGoal: 1, vel: 0 };

  function placeCamera() {
    const d = baseDist / view.zoom;
    camera.position.set(0, target.y + d * Math.sin(view.pitch), d * Math.cos(view.pitch));
    camera.lookAt(target);
  }

  function resize() {
    const w = Math.max(1, win.innerWidth), h = Math.max(1, win.innerHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    computeFrame();
    kick();
  }

  // ---- loop ----
  let raf = 0, lastFrame = 0, clock = 0, cost = 0, minGap = 0, lost = false;
  let dragging = false, lastMove = 0;
  let reducedPresentation = reduced;
  let performanceLite = false;
  let motionOn = !reducedPresentation && !performanceLite, motionAmt = motionOn ? 1 : 0;
  let animationState = 'idle';
  let speechLevel = 0, mouthMotion = 0;
  let poseFace = null, mouthNode = null, mouthBaseScale = null;
  let eyeL = null, eyeR = null, eyeLRest = null, eyeRRest = null;
  let posePivot = null, pivotRestY = 0;

  function cachePoseNodes() {
    const faceGroup = ch && ch.parts.face && ch.parts.face.group;
    if (faceGroup !== poseFace) {
      poseFace = faceGroup || null;
      mouthNode = poseFace ? poseFace.getObjectByName('mouth') : null;
      mouthBaseScale = mouthNode ? mouthNode.scale.clone() : null;
      eyeL = poseFace ? poseFace.getObjectByName('eyeL') : null;
      eyeR = poseFace ? poseFace.getObjectByName('eyeR') : null;
      eyeLRest = eyeL ? eyeL.position.clone() : null;
      eyeRRest = eyeR ? eyeR.position.clone() : null;
    }
    const pivot = ch && ch.parts.pivot;
    if (pivot !== posePivot) {
      posePivot = pivot || null;
      pivotRestY = posePivot ? posePivot.position.y : 0;
    }
  }

  function animateState(t, motion, dt = 1 / 60) {
    if (!ch) return;
    cachePoseNodes();
    const amount = reducedPresentation ? 0 : performanceLite
      ? (animationState === 'speaking' ? 1 : 0)
      : Math.max(0, Math.min(1, motion));
    if (mouthNode && mouthBaseScale) {
      if (animationState === 'speaking' && amount > 0) {
        // This is the live playback envelope, not a guessed word/viseme animation.
        const target = Math.max(0, Math.min(1, (speechLevel - 0.012) / 0.14));
        mouthMotion += (target - mouthMotion) * (1 - Math.exp(-dt * (target > mouthMotion ? 32 : 16)));
        const open = 0.08 + 1.42 * mouthMotion;
        mouthNode.scale.x = mouthBaseScale.x * (1 + (0.94 + 0.06 * open - 1) * amount);
        mouthNode.scale.y = mouthBaseScale.y * (1 + (open - 1) * amount);
        mouthNode.scale.z = mouthBaseScale.z;
      } else {
        mouthMotion = 0;
        mouthNode.scale.copy(mouthBaseScale);
      }
    }

    const thinking = animationState === 'thinking' && amount > 0;
    if (eyeL && eyeLRest) {
      const glance = thinking ? (Math.sin(t * TAU * 0.42) * 0.026 + Math.sin(t * TAU * 0.18) * 0.009) * amount : 0;
      const lift = thinking ? Math.sin(t * TAU * 0.55) * 0.012 * amount : 0;
      eyeL.position.set(eyeLRest.x + glance, eyeLRest.y + lift, eyeLRest.z);
    }
    if (eyeR && eyeRRest) {
      const glance = thinking ? (Math.sin(t * TAU * 0.42) * 0.026 + Math.sin(t * TAU * 0.18) * 0.009) * amount : 0;
      const lift = thinking ? Math.sin(t * TAU * 0.55) * 0.012 * amount : 0;
      eyeR.position.set(eyeRRest.x + glance, eyeRRest.y + lift, eyeRRest.z);
    }
    if (posePivot) {
      if (thinking) {
        posePivot.rotation.y += Math.sin(t * TAU * 0.27) * 0.045 * amount;
        posePivot.rotation.z += (-0.052 + Math.sin(t * TAU * 0.31) * 0.014) * amount;
        posePivot.position.y = pivotRestY + Math.sin(t * TAU * 0.5) * 0.008 * amount;
      } else posePivot.position.y = pivotRestY;
    }
  }

  function kick() {
    if (!raf && !lost && !doc.hidden && ch) raf = win.requestAnimationFrame(tick);
  }

  function tick(now) {
    raf = 0;
    if (motionOn && minGap && lastFrame && now - lastFrame < minGap - 1) { kick(); return; }
    const dt = lastFrame ? Math.min(0.1, Math.max(0, (now - lastFrame) / 1000)) : 1 / 60;
    lastFrame = now;
    const ease = 1 - Math.exp(-dt * 10);
    if (!dragging) {
      if (view.vel) {
        view.yaw += view.vel * dt;
        view.yawGoal = view.yaw;
        view.vel *= Math.exp(-dt * 3.5);
        if (Math.abs(view.vel) < 0.02) view.vel = 0;
      } else {
        view.yaw += (view.yawGoal - view.yaw) * ease;
      }
    }
    view.pitch += (view.pitchGoal - view.pitch) * ease;
    view.zoom += (view.zoomGoal - view.zoom) * ease;
    const mGoal = motionOn ? 1 : 0;
    motionAmt += (mGoal - motionAmt) * (1 - Math.exp(-dt * 4));
    if (Math.abs(mGoal - motionAmt) < 0.003) motionAmt = mGoal;
    clock += dt;
    ch.update(clock, motionAmt);
    animateState(clock, motionAmt, dt);
    holder.rotation.y = view.yaw;
    placeCamera();
    const t0 = win.performance.now();
    renderer.render(scene, camera);
    const c = win.performance.now() - t0;
    cost = cost ? cost * 0.9 + c * 0.1 : c;
    minGap = cost > 28 ? 50 : cost > 14 ? 33 : 0;
    const settling = view.vel !== 0 || motionAmt !== mGoal ||
      Math.abs(view.yawGoal - view.yaw) > 1e-4 || Math.abs(view.pitchGoal - view.pitch) > 1e-4 ||
      Math.abs(view.zoomGoal - view.zoom) > 1e-4;
    if (motionOn || settling) kick();
    else lastFrame = 0;
  }

  function resetView() {
    view.vel = 0;
    view.yawGoal = Math.round(view.yaw / TAU) * TAU;   // trap 4
    view.pitchGoal = BASE_PITCH;
    view.zoomGoal = 1;
    kick();
  }

  function setMotion(on) {
    motionOn = !!on && !reducedPresentation && !performanceLite;
    ui.motion.setAttribute('aria-pressed', motionOn ? 'true' : 'false');
    kick();
  }

  function setReducedMotion(on) {
    reducedPresentation = !!on;
    motionOn = !reducedPresentation && !performanceLite;
    motionAmt = reducedPresentation || performanceLite ? 0 : motionAmt;
    ui.motion.setAttribute('aria-pressed', motionOn ? 'true' : 'false');
    if (reducedPresentation) {
      speechLevel = 0;
      mouthMotion = 0;
      view.vel = 0;
      view.yaw = view.yawGoal;
      view.pitch = view.pitchGoal;
      view.zoom = view.zoomGoal;
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;
      if (ch) ch.update(clock, 0);
      animateState(clock, 0);
      placeCamera();
      renderer.render(scene, camera);
      lastFrame = 0;
    } else kick();
  }

  function setPerformanceLite(on) {
    performanceLite = !!on;
    motionOn = !reducedPresentation && !performanceLite;
    motionAmt = performanceLite || reducedPresentation ? 0 : motionAmt;
    ui.motion.setAttribute('aria-pressed', motionOn ? 'true' : 'false');
    if (performanceLite) {
      view.vel = 0;
      view.yaw = view.yawGoal;
      view.pitch = view.pitchGoal;
      view.zoom = view.zoomGoal;
      if (ch) ch.update(clock, 0);
      animateState(clock, 0);
      placeCamera();
      renderer.render(scene, camera);
      lastFrame = 0;
    } else if (!reducedPresentation) kick();
  }

  function setExpression(faceId, mouthId, stateId) {
    if (!ch || !mats || !mods.face || typeof mods.face.createFace !== 'function') return;
    const allowedFaces = ['dot','happy','wink','sleepy','sparkle','hearts','surprised','cool','starry','teary'];
    const allowedMouths = ['none','smile','grin','cat','o','tongue','fangs','kiss'];
    const f = allowedFaces.includes(faceId) ? faceId : 'happy';
    const m = allowedMouths.includes(mouthId) ? mouthId : 'smile';
    const factory = mods.face.createFace(THREE, mats);
    const next = factory.build(ch.shape, ch.anchors, {
      face: f, mouth: m, blush: false, lashes: false,
      hex: ch.state.color, finishId: ch.state.finish, furLength: ch.furLength
    });
    if (!next || !next.group) throw new Error('Could not build the 3D expression.');
    ch.setFace(next);
    animationState = stateId || 'idle';
    ch.state.face = f;
    ch.state.mouth = m;
    ch.update(clock, reducedPresentation ? 0 : motionAmt);
    animateState(clock, reducedPresentation ? 0 : motionAmt);
    kick();
  }

  function setSpeechLevel(value) {
    const level = Number(value);
    speechLevel = reducedPresentation || !Number.isFinite(level) ? 0 : Math.max(0, Math.min(1, level));
    if (!reducedPresentation) kick();
  }

  let hintTimer = 0;
  function hideHint() {
    clearTimeout(hintTimer);
    ui.hint.classList.add('is-gone');
  }

  // ---- input ----
  const pointers = new Map();
  let pinch = null;
  const spread = () => {
    const p = Array.from(pointers.values());
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  };

  ui.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { ui.canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = true;
    view.vel = 0;
    lastMove = win.performance.now();
    if (pointers.size === 2) pinch = { d: spread(), zoom: view.zoomGoal };
    ui.canvas.classList.add('is-dragging');
    hideHint();
  });
  ui.canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size >= 2) {
      if (pinch && pinch.d > 0) {
        view.zoomGoal = view.zoom = clamp(pinch.zoom * (spread() / pinch.d), ZOOM_MIN, ZOOM_MAX);
      }
    } else {
      const k = (1.6 * Math.PI) / Math.max(360, ui.canvas.clientWidth);
      const dyaw = dx * k;
      view.yaw += dyaw;
      view.yawGoal = view.yaw;
      view.pitch = view.pitchGoal = clamp(view.pitch + dy * k * 0.6, -PITCH_MAX, PITCH_MAX);
      const now = win.performance.now();
      const step = Math.max(4, now - lastMove) / 1000;
      lastMove = now;
      view.vel = view.vel * 0.5 + (dyaw / step) * 0.5;
    }
    kick();
  });
  const release = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) {
      dragging = false;
      ui.canvas.classList.remove('is-dragging');
      if (win.performance.now() - lastMove > 90) view.vel = 0;   // let go without flicking
      view.vel = reducedPresentation ? 0 : clamp(view.vel, -8, 8);
    }
    kick();
  };
  ui.canvas.addEventListener('pointerup', release);
  ui.canvas.addEventListener('pointercancel', release);
  ui.canvas.addEventListener('lostpointercapture', release);
  ui.canvas.addEventListener('dblclick', (e) => { e.preventDefault(); resetView(); });
  ui.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const speed = e.ctrlKey ? 0.01 : 0.0015;              // ctrl + wheel is a trackpad pinch
    view.zoomGoal = clamp(view.zoomGoal * Math.exp(-e.deltaY * unit * speed), ZOOM_MIN, ZOOM_MAX);
    hideHint();
    kick();
  }, { passive: false });

  win.addEventListener('keydown', (e) => {
    const a = doc.activeElement;
    if (a && a !== doc.body && a !== ui.canvas) return;   // buttons and the link keep their keys
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowLeft': view.yawGoal -= 0.35; break;
      case 'ArrowRight': view.yawGoal += 0.35; break;
      case 'ArrowUp': view.pitchGoal = clamp(view.pitchGoal + 0.12, -PITCH_MAX, PITCH_MAX); break;
      case 'ArrowDown': view.pitchGoal = clamp(view.pitchGoal - 0.12, -PITCH_MAX, PITCH_MAX); break;
      case '+': case '=': view.zoomGoal = clamp(view.zoomGoal * 1.15, ZOOM_MIN, ZOOM_MAX); break;
      case '-': case '_': view.zoomGoal = clamp(view.zoomGoal / 1.15, ZOOM_MIN, ZOOM_MAX); break;
      case '0': case 'Home': resetView(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    view.vel = 0;
    hideHint();
    kick();
  });

  ui.motion.addEventListener('click', () => setMotion(!motionOn));
  ui.reset.addEventListener('click', resetView);
  win.addEventListener('resize', resize);
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) { if (raf) win.cancelAnimationFrame(raf); raf = 0; lastFrame = 0; }
    else kick();
  });

  // Trap 5: a lost context loses the environment map with it.
  ui.canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    say('The 3D view was interrupted. It comes back when the browser restores it.');
  });
  ui.canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    try {
      if (ch) ch.dispose();
      if (mats && typeof mats.dispose === 'function') mats.dispose();
      build();
      computeFrame();
      say('');
    } catch (err) {
      say('The 3D view could not come back. Reload this file to see it again.');
    }
    lastFrame = 0;
    kick();
  });

  // ---- first build ----
  await nextPaint(win);
  try {
    build();
  } catch (e) {
    say("This avatar couldn't be built in this browser.");
    if (win.console) win.console.error(e);
    return null;
  }
  setMotion(motionOn);
  resize();
  placeCamera();
  if (typeof renderer.compileAsync === 'function') {
    try { await renderer.compileAsync(scene, camera); } catch (e) { /* compiles on first render instead */ }
  }
  say('');
  ch.update(0, motionAmt);
  holder.rotation.y = view.yaw;
  renderer.render(scene, camera);        // the first frame now, even in a background tab
  lastFrame = 0;
  kick();
  hintTimer = setTimeout(hideHint, 7000);

  return {
    renderer, scene, camera,
    get character() { return ch; },
    setMotion, setReducedMotion, setPerformanceLite, setExpression, setSpeechLevel, resetView,
    dispose() {
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;
      if (ch) ch.dispose();
      if (mats && typeof mats.dispose === 'function') mats.dispose();
      renderer.dispose();
    }
  };
}
