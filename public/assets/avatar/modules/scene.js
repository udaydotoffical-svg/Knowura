/* Dot avatar maker: the 3D stage (renderer, lights, shadows, camera, controls, render loop,
 * thumbnails and snapshots).
 *
 * An ES module factory with no imports (spec 0.6). studio.js calls
 *   createStage(THREE, deps, canvas) -> Stage
 *   deps = {materials, quality, reducedMotion, coarse}
 *     materials      the materials.js module: the stage owns one Mats per WebGL context, so it
 *                    calls materials.createMaterials() for the stage and again for thumbnails.
 *     quality        {fur, shadows} for the stage; without it fur = materials.furQualityFor()
 *                    (0.5 on coarse pointers, 0.6 at a pixel ratio of 1.8 or more, else 1)
 *     reducedMotion  idle motion starts off and the swap pop is skipped
 *     coarse         touch-first device: lower DPR cap and a smaller shadow map
 * Throws when WebGL2 is not available (three r185 needs it); studio.js turns that into the
 * page's no-WebGL fallback.
 *
 *   Stage = {
 *     renderer, scene, camera, mats (getter: the current Mats; replaced after a context loss),
 *     quality, character (getter),
 *     prepare(ch) -> Promise        compiles ch's programs off the main thread when the browser can
 *     setCharacter(ch, {pop})       swaps characters; pop 'big' | 'small' | false (160 ms soft pop)
 *     frame()                       re-frames the camera on the current character (eased)
 *     setMotion(on), motion (getter), zoom(dir), resetView(), setAngle(yaw, pitch, instant),
 *     getView() -> {yaw, pitch} the angle an export would use; onViewChange(cb) fires when the
 *                                angle settles on a new goal (not per drag frame),
 *     renderNow()                   draws one frame now, even in a background tab
 *     warmup(materialsList)         compiles materials ahead of use and keeps their programs alive
 *     snapshot({size, mode}) -> Promise<HTMLCanvasElement>   mode 'raw' or 'stage': see below
 *     thumbs: {render(kind, id, buildFn, size) -> Promise<ImageBitmap|HTMLCanvasElement|null>,
 *              mats (getter), reset()}
 *     stats() -> {fps, cpu, interval, minGap, frames, drawCalls, triangles}
 *     onContextLost(cb), onContextRestored(cb), dispose()
 *   }
 *
 * A character is what viewer.js buildCharacter() returns: {group, box, bodyBox, furLength, update,
 * rest, dispose, parts}. Its group already stands on y = 0, centered (do not move it again); the
 * stage turns it (yaw) inside a holder and scales it inside a popper for the swap pop.
 *
 * snapshot({size, mode: 'raw'}) is the contract exporter.js documents: a square, transparent,
 * uncropped render of the character alone, at rest (eyes open, no breathing or sway), with no
 * ground shadow and no contact shadow, framed tightly at the current yaw and pitch. The side is
 * capped by MAX_RENDERBUFFER_SIZE and MAX_VIEWPORT_DIMS (and 2048 on touch devices); if the GPU
 * gives up at that size the render is retried at two thirds (the export size itself). Cropping,
 * padding, backgrounds and the final resize happen in exporter.js.
 * snapshot({size, mode: 'stage'}) is for the page's own art, not for exports: the default view
 * (BASE_YAW, BASE_PITCH) framed the way the stage frames a square canvas, with the ground shadow
 * and the contact shadow, on a transparent background. assets/img/dot-avatar/poster-v2.webp and
 * assets/img/og/dot-avatar-maker-v1.jpg were made this way. Same size cap and retry as 'raw'.
 *
 * THINGS THAT ARE EASY TO GET WRONG, and are handled below:
 *  1. three applies tone mapping and the sRGB transfer only when it draws to the canvas, never
 *     into a render target. So snapshots are drawn into the stage's own canvas at the export size
 *     and copied out in the same task (the visible canvas never shows that frame: the browser
 *     composites only after the task, and the stage is redrawn before it ends), and thumbnails
 *     are drawn into a second, small canvas with its own renderer.
 *  2. js/slides.min.js turns arrow keys on any focused element into slide jumps. The canvas keys
 *     (arrows, + - 0 Home) are bound on the canvas itself, with preventDefault and
 *     stopPropagation, and only while it has focus.
 *  3. A plain wheel scrolls the page; only Ctrl or Cmd + wheel zooms (a trackpad pinch arrives as
 *     Ctrl + wheel). touch-action:pan-y is on the canvas in the page CSS, so a vertical swipe
 *     scrolls while a sideways drag turns and two fingers pinch.
 *  4. Yaw turns the character, not the camera, so the key light keeps lighting the face; reset
 *     turns back the short way, to the nearest whole turn.
 *  5. The old character is disposed only after the new one has been drawn once: its fur material
 *     shares a program with the new one, and releasing it first would throw the program away and
 *     stall the next frame on a fresh compile (a few hundred ms per finish).
 *  6. The loop runs only while something moves: idle motion on, inertia, an eased camera or a
 *     pop. It stops when the stage is off screen (IntersectionObserver) or the tab is hidden,
 *     and drops to 30 or 20 fps when a frame is expensive (CPU time per frame, or frames arriving
 *     late while uncapped, which is how a busy GPU shows itself). With no GPU at all (software GL,
 *     an old machine) a frame can take seconds, the idle loop then owns the main thread and the
 *     whole page stops answering: frames that keep arriving over SLOW_FRAME_MS late, and then cost
 *     that much when timed, switch the idle motion off, once, and onMotionBrake tells the page so
 *     the Motion button agrees. A visitor who turns it back on keeps it.
 *  7. A lost context loses the PMREM environment and every program. The stage makes a new Mats
 *     on restore and asks studio.js (onContextRestored) to rebuild the character from its cached
 *     mesh. The thumbnail renderer is simply thrown away and made again on the next request.
 *  8. Breathing and sway live in the character (viewer.js); the stage owns only the clock, so a
 *     snapshot can call rest() and the next frame picks the motion up again.
 */

const TAU = Math.PI * 2;
const SLOW_FRAME_MS = 200;
const FOV = 24;
const PITCH_MAX = (25 * Math.PI) / 180;
export const BASE_YAW = -0.3;
export const BASE_PITCH = 0.12;
const ZOOM_MIN = 0.75, ZOOM_MAX = 1.6, ZOOM_STEP = 1.18;
const POP_MS = 160;
const KEY_YAW = 0.32, KEY_PITCH = 0.1;

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function easeOutBack(t) { const c1 = 1.5, c3 = c1 + 1; const u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; }

/* Key, rim and fill, shared by the stage and the thumbnail scene so both read the same. */
function addLights(THREE, scene, shadow) {
  const key = new THREE.DirectionalLight(0xfff1df, 1.55);
  key.position.set(-2.4, 4.4, 3.4);
  key.target.position.set(0, 0.6, 0);
  scene.add(key, key.target);
  if (shadow) {
    key.castShadow = true;
    key.shadow.mapSize.set(shadow, shadow);
    const sc = key.shadow.camera;
    sc.left = -1.6; sc.right = 1.6; sc.top = 1.6; sc.bottom = -1.6; sc.near = 0.5; sc.far = 14;
    key.shadow.radius = 5;
    key.shadow.blurSamples = 12;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
  }
  const rim = new THREE.DirectionalLight(0xd4e3ff, 1.15);
  rim.position.set(2.8, 2.6, -3.2);
  scene.add(rim);
  const fill = new THREE.HemisphereLight(0xf4f6ff, 0xeadfce, 0.4);
  scene.add(fill);
  return { key, rim, fill };
}

/* A soft radial blob under the character, scaled to its footprint (it reads as contact where the
 * shadow map's soft shadow is too faint to anchor the feet). */
function contactShadow(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0.26)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0.07)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.003;
  mesh.renderOrder = -1;
  mesh.name = 'contact-shadow';
  return mesh;
}

/* Compile obj's programs without blocking where the browser compiles in parallel
 * (KHR_parallel_shader_compile), then wait until they are linked. This is three's compileAsync
 * with three guards. (1) A material disposed while we wait (a thumbnail released after the cap
 * below, a character replaced before it was shown) has no program any more: three's own poll
 * reads currentProgram.isReady() on it, throws an uncaught TypeError and never resolves, so the
 * poll here skips it. (2) The poll stops when the wait ends, instead of running on. (3) A hidden
 * tab throttles setTimeout to once a second and then once a minute, so a hidden tab compiles
 * synchronously instead (nobody is watching that frame), a tab hidden mid-wait stops waiting, and
 * no wait outlasts 8 s: whatever is left finishes on the first draw. */
function compileSoon(renderer, obj, camera, target) {
  const doc = document;
  let pending = null;
  try { pending = renderer.compile(obj, camera, target || null); } catch (e) { pending = null; /* compiles on first draw */ }
  const props = renderer.properties;
  if (doc.hidden || !pending || typeof pending.forEach !== 'function' || !props || typeof props.has !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false, timer = 0;
    const t0 = Date.now();
    const onVis = () => { if (doc.hidden) finish(); };
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      doc.removeEventListener('visibilitychange', onVis);
      resolve();
    }
    function poll() {
      if (done) return;
      try {
        pending.forEach((m) => {
          const p = props.has(m) ? props.get(m).currentProgram : null;
          if (!p || typeof p.isReady !== 'function' || p.isReady()) pending.delete(m);
        });
      } catch (e) { pending.clear(); }
      if (!pending.size || Date.now() - t0 > 8000) finish();
      else timer = setTimeout(poll, 10);
    }
    doc.addEventListener('visibilitychange', onVis);
    poll();
  });
}

function setupRenderer(THREE, renderer) {
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping !== undefined ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;   // a touch brighter than neutral: yellows read butter, not mustard
}

/* The 8 corners of box {min, max} (arrays) after matrix m (a THREE.Matrix4 or null). */
function corners(THREE, box, m, pad) {
  const p = pad || 0;
  const out = [];
  for (let i = 0; i < 8; i++) {
    const v = new THREE.Vector3(
      i & 1 ? box.max[0] + p : box.min[0] - p,
      i & 2 ? box.max[1] + p : box.min[1] - p,
      i & 4 ? box.max[2] + p : box.min[2] - p);
    if (m) v.applyMatrix4(m);
    out.push(v);
  }
  return out;
}

/* Distance from target at which every point fits a camera looking at target from `pitch` above
 * the horizon (camera on +z), with tan(half fov) vt vertically and ht horizontally. */
function fitDistance(points, target, pitch, vt, ht) {
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  let d = 0;
  for (const q of points) {
    const rx = q.x - target.x, ry = q.y - target.y, rz = q.z - target.z;
    const x = rx;
    const y = ry * cp - rz * sp;
    const z = ry * sp + rz * cp;       // toward the camera
    d = Math.max(d, z + Math.abs(x) / ht, z + Math.abs(y) / vt);
  }
  return d;
}

export function createStage(THREE, deps, canvas) {
  const D = deps || {};
  const win = window, doc = document;
  const coarse = !!D.coarse;
  if (!D.materials || typeof D.materials.createMaterials !== 'function') throw new Error('createStage: deps.materials is required');
  const dprCap = coarse ? 1.5 : 2;
  const dpr = Math.min(win.devicePixelRatio || 1, dprCap);
  // Without a quality from the caller, fur follows materials.furQualityFor (fewer shells near DPR 2).
  const furDefault = typeof D.materials.furQualityFor === 'function' ? D.materials.furQualityFor({ dpr, coarse }) : (coarse ? 0.5 : 1);
  const quality = Object.assign({ fur: furDefault, shadows: true }, D.quality || {});

  // Throws without WebGL2 (three r185); studio.js shows the fallback.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  if (!renderer.capabilities || !renderer.capabilities.isWebGL2) throw new Error('WebGL2 is required');
  renderer.setPixelRatio(dpr);
  setupRenderer(THREE, renderer);
  renderer.shadowMap.enabled = !!quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  let mats = D.materials.createMaterials(THREE, renderer, quality);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
  const lights = addLights(THREE, scene, quality.shadows ? (coarse ? 1024 : 2048) : 0);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.12 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);
  const holder = new THREE.Group();       // yaw
  holder.name = 'holder';
  scene.add(holder);
  const contact = contactShadow(THREE);
  holder.add(contact);

  let ch = null, popper = null;
  let retired = [];                        // characters to dispose after the next frame (trap 5)
  const warmKeep = [];

  /* ---------------- view state ---------------- */

  const view = {
    yaw: BASE_YAW, yawGoal: BASE_YAW, pitch: BASE_PITCH, pitchGoal: BASE_PITCH,
    zoom: 1, zoomGoal: 1, vel: 0,
    ty: 0.75, tyGoal: 0.75, dist: 7, distGoal: 7
  };
  const target = new THREE.Vector3();
  let width = 1, height = 1;
  let pop = null;                          // {t0, from}
  let motionOn = !D.reducedMotion, motionAmt = motionOn ? 1 : 0;
  let clock = 0;

  // The stage framing for an aspect ratio: target height and camera distance at zoom 1.
  function framing(aspect) {
    const b = ch ? ch.box : { min: [-0.8, 0, -0.6], max: [0.8, 1.5, 0.6] };
    const pad = ch ? ch.furLength || 0 : 0;
    const halfH = (b.max[1] - b.min[1]) / 2 + pad + 0.03;
    // The farthest the character reaches from its turning axis, so no yaw ever crops it.
    let rxz = 0;
    for (const x of [b.min[0], b.max[0]]) for (const z of [b.min[2], b.max[2]]) rxz = Math.max(rxz, Math.hypot(x, z));
    rxz += pad;
    const vt = Math.tan((FOV * Math.PI) / 360);
    const ht = vt * Math.max(0.3, aspect);
    return { ty: (b.min[1] + b.max[1]) / 2 + 0.02, dist: (Math.max(halfH / vt, rxz / ht) + rxz * 0.55) * 1.1, halfH, rxz };
  }

  function frameGoals(first) {
    const f = framing(camera.aspect);
    const halfH = f.halfH, rxz = f.rxz;
    view.tyGoal = f.ty;
    view.distGoal = f.dist;
    if (first) { view.ty = view.tyGoal; view.dist = view.distGoal; }
    // Keep the shadow camera tight around the character for a crisp, soft shadow.
    const ext = Math.max(rxz, halfH) + 0.5;
    const sc = lights.key.shadow.camera;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
    sc.updateProjectionMatrix();
    lights.key.target.position.set(0, view.tyGoal, 0);
  }

  function placeCamera() {
    const d = view.dist / view.zoom;
    target.set(0, view.ty, 0);
    camera.position.set(0, view.ty + d * Math.sin(view.pitch), d * Math.cos(view.pitch));
    camera.near = Math.max(0.05, d - 4);
    camera.far = d + 8;
    camera.updateProjectionMatrix();
    camera.lookAt(target);
  }

  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
    const h = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1));
    if (w === width && h === height) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frameGoals(!ch);
    kick();
  }

  /* ---------------- loop ---------------- */

  let raf = 0, lastFrame = 0, lost = false, onScreen = true, disposed = false;
  let cpu = 0, interval = 0, minGap = 0, probeAt = 0, frames = 0, fpsT0 = 0, fpsN = 0, fps = 0;
  let furQuality = 1;
  let dragging = false, lastMove = 0;
  let slowRun = 0, slowProbes = 0, probing = motionOn, braked = false;
  const brakeCbs = [];

  // Called with the gap since the last idle frame. Late frames alone prove nothing (page load, a shader
  // compile), so two in a row only start a probe, and so does the very first frame: reading one pixel
  // back makes the GPU finish the frame, which is the only way to time it, since a draw call just
  // queues the work. Two slow probes in a row brake; the first frame alone may be a shader compile.
  function watchFrames(gap) {
    if (braked || probing) return;
    slowRun = gap > SLOW_FRAME_MS ? slowRun + 1 : 0;
    if (slowRun >= 2) { slowRun = 0; slowProbes = 0; probing = true; }
  }
  function probeFrame() {
    probing = false;
    const gl = renderer.getContext(), px = new Uint8Array(4), t0 = win.performance.now();
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (win.performance.now() - t0 <= SLOW_FRAME_MS) return;     // a slow moment, not a slow machine
    if (++slowProbes < 2) { probing = true; return; }
    braked = true;
    motionOn = false;
    motionAmt = 0;
    minGap = 0;
    interval = 0;
    for (const cb of brakeCbs) { try { cb(); } catch (e) { /* keep going */ } }
  }

  function canRun() { return !raf && !lost && !disposed && !doc.hidden && onScreen && !!ch; }
  function kick() { if (canRun()) raf = win.requestAnimationFrame(tick); }

  function settling() {
    return view.vel !== 0 || pop !== null ||
      Math.abs((motionOn ? 1 : 0) - motionAmt) > 0 ||
      Math.abs(view.yawGoal - view.yaw) > 1e-4 || Math.abs(view.pitchGoal - view.pitch) > 1e-4 ||
      Math.abs(view.zoomGoal - view.zoom) > 1e-4 || Math.abs(view.tyGoal - view.ty) > 1e-4 ||
      Math.abs(view.distGoal - view.dist) > 1e-3;
  }

  function step(dt, now) {
    const ease = 1 - Math.exp(-dt * 10);
    if (reducedPresentation) {
      view.vel = 0;
      view.yaw = view.yawGoal;
      view.pitch = view.pitchGoal;
      view.zoom = view.zoomGoal;
    } else if (!dragging) {
      if (view.vel) {
        view.yaw += view.vel * dt;
        view.yawGoal = view.yaw;
        view.vel *= Math.exp(-dt * 3.2);
        if (Math.abs(view.vel) < 0.02) { view.vel = 0; viewChanged(); }
      } else {
        view.yaw += (view.yawGoal - view.yaw) * ease;
      }
    }
    view.pitch += (view.pitchGoal - view.pitch) * ease;
    view.zoom += (view.zoomGoal - view.zoom) * ease;
    const fe = 1 - Math.exp(-dt * 7);
    view.ty += (view.tyGoal - view.ty) * fe;
    view.dist += (view.distGoal - view.dist) * fe;
    if (Math.abs(view.yawGoal - view.yaw) < 1e-4 && !view.vel) view.yaw = view.yawGoal;
    if (Math.abs(view.distGoal - view.dist) < 1e-3) view.dist = view.distGoal;
    if (Math.abs(view.tyGoal - view.ty) < 1e-4) view.ty = view.tyGoal;
    const mGoal = motionOn && !reducedPresentation ? 1 : 0;
    motionAmt = reducedPresentation ? 0 : motionAmt + (mGoal - motionAmt) * (1 - Math.exp(-dt * 4));
    if (Math.abs(mGoal - motionAmt) < 0.003) motionAmt = mGoal;
    clock += dt;
    if (pop && popper) {
      const t = clamp((now - pop.t0) / POP_MS, 0, 1);
      const s = pop.from + (1 - pop.from) * easeOutBack(t);
      popper.scale.setScalar(s);
      if (t >= 1) { popper.scale.setScalar(1); pop = null; }
    }
    if (ch) {
      ch.update(clock, motionAmt);
      animateState(clock, motionAmt);
      const parts = ch.parts || {};
      for (const slot of ['hat', 'extra']) {
        const g = parts[slot];
        if (g && g.userData && typeof g.userData.update === 'function') {
          try { g.userData.update(clock, motionAmt); } catch (e) { /* a decorative update never breaks the loop */ }
        }
      }
    }
    holder.rotation.y = view.yaw;
    placeCamera();
  }

  function draw() {
    const t0 = win.performance.now();
    renderer.render(scene, camera);
    const c = win.performance.now() - t0;
    cpu = cpu ? cpu * 0.9 + c * 0.1 : c;
    frames++;
    if (probing) probeFrame();
    if (retired.length) {
      const old = retired;
      retired = [];
      for (const r of old) { try { r.dispose(); } catch (e) { /* already gone */ } }
    }
  }

  function throttle(now) {
    if (!motionOn) { minGap = 0; return; }
    if (minGap === 0 && lastFrame) {
      const gap = now - lastFrame;
      interval = interval ? interval * 0.9 + gap * 0.1 : gap;
    }
    let want = cpu > 28 ? 50 : cpu > 14 ? 33 : 0;
    if (!want && minGap === 0 && frames > 30 && interval > 24) want = interval > 40 ? 50 : 33;
    if (want > minGap) { minGap = want; probeAt = now + 5000; }
    else if (minGap && !want && now > probeAt) { minGap = 0; interval = 0; }   // probe again
    const q = minGap >= 50 ? 0.6 : 1;
    if (q !== furQuality) {
      furQuality = q;
      const fur = ch && ch.parts && ch.parts.fur;
      if (fur && fur.userData && typeof fur.userData.setQuality === 'function') fur.userData.setQuality(q);
    }
  }

  function tick(now) {
    raf = 0;
    if (motionOn && minGap && lastFrame && now - lastFrame < minGap - 1 && !settling()) { kick(); return; }
    const dt = lastFrame ? Math.min(0.1, Math.max(0, (now - lastFrame) / 1000)) : 1 / 60;
    throttle(now);
    if (motionOn && lastFrame) watchFrames(now - lastFrame);
    lastFrame = now;
    step(dt, now);
    draw();
    if (!fpsT0) fpsT0 = now;
    fpsN++;
    if (now - fpsT0 > 1000) { fps = (fpsN * 1000) / (now - fpsT0); fpsT0 = now; fpsN = 0; }
    if (motionOn || settling()) kick();
    else { lastFrame = 0; fpsT0 = 0; fpsN = 0; }
  }

  function renderNow() {
    if (lost || disposed || !ch) return;
    resize();
    step(0, win.performance.now());
    draw();
  }

  /* ---------------- characters ---------------- */

  async function prepare(next) {
    if (!next || lost) return;
    await compileSoon(renderer, next.group, camera, scene);
  }

  function setCharacter(next, opts) {
    const o = opts || {};
    if (ch) retired.push(ch);
    if (popper) holder.remove(popper);
    ch = next;
    popper = null;
    if (ch) {
      popper = new THREE.Group();
      popper.name = 'popper';
      popper.add(ch.group);
      holder.add(popper);
      const bb = ch.bodyBox || ch.box;
      contact.scale.set(Math.max(0.3, (bb.max[0] - bb.min[0]) * 0.95), Math.max(0.3, (bb.max[2] - bb.min[2]) * 0.95), 1);
      contact.position.x = (bb.min[0] + bb.max[0]) / 2;
      contact.position.z = (bb.min[2] + bb.max[2]) / 2;
      const fur = ch.parts && ch.parts.fur;
      if (furQuality !== 1 && fur && fur.userData && typeof fur.userData.setQuality === 'function') fur.userData.setQuality(furQuality);
      const kind = o.pop === undefined ? 'small' : o.pop;
      if (kind && !D.reducedMotion) {
        pop = { t0: win.performance.now(), from: kind === 'big' ? 0.86 : 0.95 };
        popper.scale.setScalar(pop.from);
      } else {
        pop = null;
      }
      frameGoals(frames === 0 && !o.keepFrame);
    }
    if (doc.hidden || !onScreen) {
      // Nothing will draw for a while: release the old character now (its programs stay cached
      // as long as the new one uses the same materials, which compile on the next draw anyway).
      const old = retired;
      retired = [];
      for (const r of old) { try { r.dispose(); } catch (e) { /* already gone */ } }
    }
    kick();
  }

  /* Compile every material in the list once and keep the meshes, so their programs are never
   * released between characters (trap 5). list = [{material, geometry?} | THREE.Object3D]. */
  async function warmup(list) {
    if (!list || !list.length || lost) return;
    const group = new THREE.Group();
    const geo = new THREE.SphereGeometry(0.1, 8, 6);
    for (const item of list) {
      if (!item) continue;
      if (item.isObject3D) group.add(item);
      else if (item.material) group.add(new THREE.Mesh(item.geometry || geo, item.material));
    }
    warmKeep.push(group);
    group.position.set(0, -50, 0);
    await compileSoon(renderer, group, camera, scene);
  }

  /* ---------------- view controls ---------------- */

  const viewCbs = [];
  function viewChanged() { for (const cb of viewCbs) { try { cb(); } catch (e) { /* keep going */ } } }

  function setMotion(on) {
    motionOn = !!on;
    if (!motionOn) { minGap = 0; interval = 0; }
    kick();
  }

  function zoom(dir) {
    view.zoomGoal = clamp(view.zoomGoal * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
    kick();
  }

  function resetView() {
    view.vel = 0;
    view.yawGoal = BASE_YAW + Math.round((view.yaw - BASE_YAW) / TAU) * TAU;   // trap 4
    view.pitchGoal = BASE_PITCH;
    view.zoomGoal = 1;
    viewChanged();
    kick();
  }

  // instant: no easing, for an angle read from a link before the first frame.
  function setAngle(yaw, pitch, instant) {
    view.vel = 0;
    if (typeof yaw === 'number' && isFinite(yaw)) { view.yawGoal = yaw; if (instant) view.yaw = yaw; }
    if (typeof pitch === 'number' && isFinite(pitch)) {
      view.pitchGoal = clamp(pitch, -PITCH_MAX, PITCH_MAX);
      if (instant) view.pitch = view.pitchGoal;
    }
    viewChanged();
    kick();
  }

  function getView() {
    return { yaw: view.vel ? view.yaw : view.yawGoal, pitch: view.pitchGoal };
  }

  const pointers = new Map();
  let pinch = null;
  const spread = () => {
    const p = Array.from(pointers.values());
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  };

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!ch) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = true;
    view.vel = 0;
    lastMove = win.performance.now();
    if (pointers.size === 2) pinch = { d: spread(), zoom: view.zoomGoal };
  }
  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size >= 2) {
      if (pinch && pinch.d > 0) view.zoomGoal = view.zoom = clamp(pinch.zoom * (spread() / pinch.d), ZOOM_MIN, ZOOM_MAX);
    } else {
      const k = (1.6 * Math.PI) / Math.max(360, canvas.clientWidth);
      const dyaw = dx * k;
      view.yaw += dyaw;
      view.yawGoal = view.yaw;
      view.pitch = view.pitchGoal = clamp(view.pitch + dy * k * 0.6, -PITCH_MAX, PITCH_MAX);
      const now = win.performance.now();
      const dts = Math.max(4, now - lastMove) / 1000;
      lastMove = now;
      view.vel = view.vel * 0.5 + (dyaw / dts) * 0.5;
    }
    kick();
  }
  function onRelease(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) {
      dragging = false;
      if (win.performance.now() - lastMove > 90) view.vel = 0;   // let go without flicking
      view.vel = clamp(view.vel, -8, 8);
      if (!view.vel) viewChanged();                        // a flick reports when it comes to rest
    }
    kick();
  }
  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey) || !ch) return;          // trap 3: a plain wheel scrolls the page
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    view.zoomGoal = clamp(view.zoomGoal * Math.exp(-e.deltaY * unit * 0.01), ZOOM_MIN, ZOOM_MAX);
    kick();
  }
  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || !ch) return;
    switch (e.key) {
      case 'ArrowLeft': view.yawGoal -= KEY_YAW; break;
      case 'ArrowRight': view.yawGoal += KEY_YAW; break;
      case 'ArrowUp': view.pitchGoal = clamp(view.pitchGoal + KEY_PITCH, -PITCH_MAX, PITCH_MAX); break;
      case 'ArrowDown': view.pitchGoal = clamp(view.pitchGoal - KEY_PITCH, -PITCH_MAX, PITCH_MAX); break;
      case '+': case '=': case 'Add': view.zoomGoal = clamp(view.zoomGoal * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX); break;
      case '-': case '_': case 'Subtract': view.zoomGoal = clamp(view.zoomGoal / ZOOM_STEP, ZOOM_MIN, ZOOM_MAX); break;
      case '0': case 'Home': resetView(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();                                   // trap 2
    view.vel = 0;
    viewChanged();
    kick();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onRelease);
  canvas.addEventListener('pointercancel', onRelease);
  canvas.addEventListener('lostpointercapture', onRelease);
  canvas.addEventListener('dblclick', (e) => { e.preventDefault(); resetView(); });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKey);

  /* ---------------- visibility, size, context ---------------- */

  let ro = null, io = null;
  if (typeof win.ResizeObserver === 'function') {
    ro = new win.ResizeObserver(() => resize());
    ro.observe(canvas);
  } else {
    win.addEventListener('resize', resize);
  }
  if (typeof win.IntersectionObserver === 'function') {
    io = new win.IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      onScreen = !!(e && e.isIntersecting);
      if (onScreen) { lastFrame = 0; kick(); }
    });
    io.observe(canvas);
  }
  function onVisibility() {
    if (doc.hidden) { if (raf) win.cancelAnimationFrame(raf); raf = 0; lastFrame = 0; }
    else kick();
  }
  doc.addEventListener('visibilitychange', onVisibility);

  const lostCbs = [], restoredCbs = [];
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();                                    // lets the browser restore it
    lost = true;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    for (const cb of lostCbs) { try { cb(); } catch (err) { /* keep going */ } }
  });
  canvas.addEventListener('webglcontextrestored', () => {
    // three re-initializes its own state; the environment and the programs are gone (trap 7).
    lost = false;
    try { if (mats && typeof mats.dispose === 'function') mats.dispose(); } catch (e) { /* GL objects are gone anyway */ }
    mats = D.materials.createMaterials(THREE, renderer, quality);
    warmKeep.length = 0;
    const old = ch;
    ch = null;
    if (popper) holder.remove(popper);
    popper = null;
    if (old) { try { old.dispose(); } catch (e) { /* gone */ } }
    for (const r of retired) { try { r.dispose(); } catch (e) { /* gone */ } }
    retired = [];
    thumbs.reset();
    lastFrame = 0;
    for (const cb of restoredCbs) { try { cb(); } catch (err) { /* keep going */ } }
  });

  /* ---------------- snapshot (exports) ---------------- */

  // mode 'raw': the character alone, tightly framed at the angle the view is settling on (the
  // goal, so a shot taken while the view eases back after a reset is the reset pose).
  // mode 'stage': the default view as the stage frames it in a square canvas, ground shadow and
  // contact shadow included (the page poster and the social image are made this way).
  function snapshotOnce(side, mode) {
    const gl = renderer.getContext();
    const prevPr = renderer.getPixelRatio();
    const prevAspect = camera.aspect;
    const groundVis = ground.visible, contactVis = contact.visible;
    const asStage = mode === 'stage';
    let out = null;
    try {
      ground.visible = asStage;
      contact.visible = asStage;
      ch.rest();
      if (popper) popper.scale.setScalar(1);
      const yaw = asStage ? BASE_YAW : view.vel ? view.yaw : view.yawGoal;
      const pitch = asStage ? BASE_PITCH : view.pitchGoal;
      holder.rotation.y = yaw;
      holder.updateMatrixWorld(true);
      const c = new THREE.Vector3();
      let d;
      if (asStage) {
        const f = framing(1);
        c.set(0, f.ty, 0);
        d = f.dist;
      } else {
        const pts = corners(THREE, ch.box, holder.matrixWorld, (ch.furLength || 0) + 0.02);
        for (const p of pts) c.add(p);
        c.multiplyScalar(1 / pts.length);
        const vt = Math.tan((FOV * Math.PI) / 360);
        d = fitDistance(pts, c, pitch, vt, vt) * 1.04;
      }
      camera.aspect = 1;
      camera.position.set(c.x, c.y + d * Math.sin(pitch), c.z + d * Math.cos(pitch));
      camera.near = Math.max(0.05, d - 4);
      camera.far = d + 8;
      camera.updateProjectionMatrix();
      camera.lookAt(c);
      renderer.setPixelRatio(1);
      renderer.setSize(side, side, false);
      renderer.render(scene, camera);
      if (!gl.isContextLost()) {
        out = doc.createElement('canvas');
        out.width = out.height = side;
        out.getContext('2d').drawImage(renderer.domElement, 0, 0, side, side);
      }
    } finally {
      ground.visible = groundVis;
      contact.visible = contactVis;
      renderer.setPixelRatio(prevPr);
      renderer.setSize(width, height, false);
      camera.aspect = prevAspect;
      camera.updateProjectionMatrix();
      if (!gl.isContextLost()) {
        step(0, win.performance.now());
        renderer.render(scene, camera);
      }
    }
    return out;
  }

  async function snapshot(opts) {
    const o = opts || {};
    if (!ch) throw new Error('No character on the stage yet.');
    if (lost) throw new Error('The 3D view is restoring itself. Try again in a moment.');
    const gl = renderer.getContext();
    const maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096;
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [4096, 4096];
    const cap = Math.min(maxRb, vp[0], vp[1], coarse ? 2048 : 4096);
    const want = Math.max(64, Math.round(Number(o.size) || 1536));
    let side = Math.min(want, cap);
    let out = snapshotOnce(side, o.mode);
    if (!out || gl.isContextLost()) {
      // Fall back to 1x: the export size itself.
      side = Math.min(cap, Math.max(64, Math.round(want / 1.5)));
      if (gl.isContextLost()) throw new Error('The GPU could not render at that size. Try a smaller size.');
      out = snapshotOnce(side, o.mode);
    }
    if (!out) throw new Error('The 3D view could not render an image. Try again.');
    return out;
  }

  /* ---------------- thumbnails (trap 1, trap 7) ---------------- */

  let T = null;                // {canvas, renderer, mats, scene, camera, size, lost}
  let thumbQueue = Promise.resolve();

  function ensureThumbs() {
    if (T && !T.lost) return T;
    if (T) { try { T.renderer.dispose(); } catch (e) { /* gone */ } }
    const c = doc.createElement('canvas');
    c.width = c.height = 160;
    const r = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(1);
    setupRenderer(THREE, r);
    r.shadowMap.enabled = false;
    const tq = { fur: 0.4, shadows: false };
    const tm = D.materials.createMaterials(THREE, r, tq);
    const s = new THREE.Scene();
    addLights(THREE, s, 0);
    const cam = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
    const t = { canvas: c, renderer: r, mats: tm, scene: s, camera: cam, size: 160, lost: false, quality: tq };
    c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); t.lost = true; });
    T = t;
    return t;
  }

  async function renderThumb(buildFn, size) {
    const t = ensureThumbs();
    const side = Math.max(32, Math.min(512, Math.round(size || 160)));
    if (t.size !== side) { t.renderer.setSize(side, side, false); t.size = side; }
    const built = buildFn({ THREE, mats: t.mats, renderer: t.renderer, quality: t.quality });
    if (!built || !built.object) return null;
    const hold = new THREE.Group();
    hold.add(built.object);
    hold.rotation.y = typeof built.yaw === 'number' ? built.yaw : BASE_YAW;
    t.scene.add(hold);
    try {
      hold.updateMatrixWorld(true);
      const pitch = typeof built.pitch === 'number' ? built.pitch : 0.16;
      const pts = corners(THREE, built.box, hold.matrixWorld, built.pad || 0);
      const c = new THREE.Vector3();
      for (const p of pts) c.add(p);
      c.multiplyScalar(1 / pts.length);
      const vt = Math.tan((FOV * Math.PI) / 360);
      const d = fitDistance(pts, c, pitch, vt, vt) * (built.margin || 1.05);
      const cam = t.camera;
      cam.position.set(c.x, c.y + d * Math.sin(pitch), c.z + d * Math.cos(pitch));
      cam.near = Math.max(0.02, d - 4);
      cam.far = d + 8;
      cam.updateProjectionMatrix();
      cam.lookAt(c);
      await compileSoon(t.renderer, t.scene, cam, null);
      if (t.lost) throw new Error('thumbnail context lost');
      t.renderer.render(t.scene, cam);
      // Copy now, in the same task as the draw: the drawing buffer is not preserved.
      if (typeof win.createImageBitmap === 'function') {
        return await win.createImageBitmap(t.canvas);
      }
      const copy = doc.createElement('canvas');
      copy.width = copy.height = side;
      copy.getContext('2d').drawImage(t.canvas, 0, 0);
      return copy;
    } finally {
      t.scene.remove(hold);
      if (typeof built.dispose === 'function') { try { built.dispose(); } catch (e) { /* gone */ } }
    }
  }

  const thumbs = {
    render(kind, id, buildFn, size) {
      const job = thumbQueue.then(() => renderThumb(buildFn, size));
      thumbQueue = job.then(() => undefined, () => undefined);
      return job;
    },
    get mats() { return ensureThumbs().mats; },
    get renderer() { return ensureThumbs().renderer; },
    reset() {
      if (!T) return;
      try { T.mats.dispose(); } catch (e) { /* gone */ }
      try { T.renderer.dispose(); } catch (e) { /* gone */ }
      T = null;
    }
  };

  /* ---------------- api ---------------- */

  resize();
  frameGoals(true);
  placeCamera();

  return {
    renderer, scene, camera, quality, thumbs,
    get mats() { return mats; },
    get character() { return ch; },
    get motion() { return motionOn; },
    get lost() { return lost; },
    get view() { return { yaw: view.yaw, pitch: view.pitch, zoom: view.zoom }; },
    prepare, setCharacter, warmup,
    frame() { frameGoals(false); kick(); },
    onMotionBrake: (cb) => { brakeCbs.push(cb); },
    setMotion, zoom, resetView, setAngle, getView, renderNow, snapshot,
    onViewChange(cb) { if (typeof cb === 'function') viewCbs.push(cb); },
    stats() {
      const info = renderer.info.render;
      return { fps: Math.round(fps * 10) / 10, cpu: Math.round(cpu * 100) / 100, interval: Math.round(interval * 10) / 10, minGap, frames, drawCalls: info.calls, triangles: info.triangles };
    },
    onContextLost(cb) { if (typeof cb === 'function') lostCbs.push(cb); },
    onContextRestored(cb) { if (typeof cb === 'function') restoredCbs.push(cb); },
    dispose() {
      disposed = true;
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      if (ch) { try { ch.dispose(); } catch (e) { /* gone */ } }
      for (const r of retired) { try { r.dispose(); } catch (e) { /* gone */ } }
      thumbs.reset();
      try { mats.dispose(); } catch (e) { /* gone */ }
      renderer.dispose();
    }
  };
}
