/* Dot avatar maker: materials (environment, 14 finishes, shell fur, prop and face materials).
 *
 * export function createMaterials(THREE, renderer, quality) -> Mats
 *   quality = {fur: 1 | 0.6 | 0.5 | 0.4, shadows: true | false}       (all optional)
 *             fur = the fraction of each fur finish's full shell count, 0.2..1 (see FUR QUALITY)
 *   Mats = {
 *     env                   PMREM texture of OUR OWN procedural studio room (a gradient box with a
 *                           few emissive soft boxes). null when renderer is null (Node tests).
 *     finishIds             the 14 finish ids, catalog order: plush fluffy felt clay | ceramic
 *                           crackle speckled pearl rubber | vinyl glitter jelly glass chrome
 *     toneKeys              the 8 paint tones in shader index order (see PAINT ZONE MATH)
 *     quality               the normalized quality object
 *     body(finishId, hex, shape) -> {material, fur: FurParams|null, soft, furLength}
 *                           shape = sdf.getShape(id) (its .paint zones are used); hex 'rrggbb'.
 *                           Materials are cached (LRU) and owned by Mats; disposing one is safe,
 *                           three re-initializes it on the next render.
 *     makeFur(geometry, finishId, hex, shape[, quality]) -> THREE.Mesh | null (null: not a fur finish)
 *                           ONE instanced draw over the body geometry. Add it next to the body with
 *                           the SAME transform (sibling in the same group, or child with identity).
 *                           mesh.userData: update(timeSeconds, motion01), setTrims(trims),
 *                           setQuality(q) (fewer shells at run time, q relative to the build),
 *                           dispose(), layers, furLength.
 *     setFurTrims(mesh, [{c:[x,y,z], r}])  up to 6 spheres (object space) where fur gets short
 *     setPaintUniforms(material, shape, hex)   re-target a body or fur material to a shape/color
 *     tones(hex) -> {cream, pink, dark, light, orange, white, screen, leaf, ink, inkLight, cheek}
 *                           'rrggbb' strings (lowercase, no '#'), contrast-adapted in OKLab
 *     accessory(kind, opts) -> Material   opts {color, soft, transmissive, finishId}; cached.
 *                           kinds: fabric knit felt straw paper plastic rubber gold silver gem pearl
 *                           lens-clear lens-dark lens-tint emissive ink enamel leather terry feather
 *     faceMaterial(kind, hex[, opts]) -> Material   hex = BODY color; opts {transmissive, finishId}
 *     isTransmissive(finishId) -> bool
 *     furParams(finishId[, quality]) -> FurParams | null
 *     furQualityFor(info) -> number       the named export below, for convenience
 *     dispose()
 *   }
 * export function furQualityFor({dpr, coarse, pixels}) -> 1 | 0.6 | 0.5   (pure, see FUR QUALITY)
 *
 * No imports (spec 0.6): THREE and the renderer are injected.
 *
 * FUR QUALITY (how the stage chooses quality.fur):
 *   Shell fur costs about (shells) x (device pixels it covers), and every shell runs the whole lit
 *   shader, because the stochastic cut-out leaves a survivor in nearly every pixel quad. So:
 *     coarse pointer (phones, tablets)                 0.5
 *     fine pointer and devicePixelRatio >= 1.8         0.6  plush 17 of 28 shells, fluffy 24 of 40,
 *       (or a drawing buffer above 2.6 megapixels)          felt 10 of 16: about 40% less fur fill
 *     anything else                                    1
 *     thumbnails                                       0.4  (unchanged)
 *   i.e. quality.fur = furQualityFor({dpr: Math.min(devicePixelRatio, dprCap), coarse}) before
 *   createMaterials() and makeFur(). Fewer shells are density-compensated: strands get up to 25%
 *   thicker and roots up to 12% less dark, in proportion to the shells left out, so the mean
 *   brightness (0..1) at q = 0.6 stays within 0.03 of full quality at 0, 45 and 70 degrees, and
 *   q = 0.4 within 0.045 head-on and 0.065 at 70 degrees (a Monte Carlo of this exact shader on a
 *   flat patch). mesh.userData.setQuality(q) applies the
 *   same compensation at run time. q is RELATIVE to the quality the mesh was built with (1 = as
 *   built, 0.6 = 60% of those shells) and never adds shells beyond the build, so the stage's
 *   frame-rate throttle calls setQuality(0.6) and setQuality(1) whatever quality.fur is.
 *
 * THINGS THAT ARE EASY TO GET WRONG, and are handled below:
 *  1. Injection targets. Every shader change is a string edit of one of three's `#include <chunk>`
 *     lines (plus three exact lines inside transmission_fragment). inject() throws a named Error
 *     when a target is missing, so a three.js update fails loudly instead of rendering garbage.
 *     Verified against THREE.ShaderLib.physical / .standard of three 0.185.1.
 *  2. Program cache. three caches programs by key, not by onBeforeCompile code, so every variant
 *     sets customProgramCacheKey ('da-body-<finish>-t8', 'da-fur-<mode>-t8', 'da-acc-<kind>' ...).
 *     The '-t8' suffix names the paint layout (8 tones); change it whenever the layout changes.
 *  3. Uniform objects are created once per material (material.userData.daU) and handed to the
 *     compiled shader by reference, so setPaintUniforms() and update() work after compilation.
 *  4. Derivatives (fwidth, dFdx) are taken only in uniform control flow and before any discard.
 *  5. Paint zones and fur trims live in the SDF's object space. Move the character with a parent
 *     group or mesh.position, never geometry.translate(), or the zones slide off the features.
 *  6. The `surf` attribute (vec2: x = ambient occlusion, 1 = open; y = curvature, + = convex) can
 *     be missing; material.defaultAttributeValues supplies [1, 0] (three honors it per material).
 *  7. Fur. The body under fur writes depth only (colorWrite false, a tiny polygon offset so the
 *     innermost shell wins the depth test) and still casts the shadow; its fragment shader is a
 *     one-liner. The shell mesh casts no shadow. Shells are opaque, cut out stochastically and
 *     drawn outermost first (instance 0 = tips) so early-z rejects buried inner shells. The
 *     innermost shell (height 0) never cuts out: it is the visible skin under the strands.
 *     Fur renderOrder is 1 so it draws after the depth-only body (renderOrder 0).
 *  8. One Mats per renderer. A PMREM texture belongs to one WebGL context, so the thumbnail
 *     renderer must call createMaterials() itself.
 *  9. Transmission (jelly, glass). Face and accessory materials must be `transparent` so three
 *     keeps them out of the transmission pass. Pass {transmissive: true} (or the body finishId)
 *     to accessory() and faceMaterial(); the transparent variant is cached separately.
 * 10. Strand cells are hashed on a cube-mapped lattice of the ROOT position (the body vertex before
 *     the shell offset, projected on the plane of its dominant normal axis), so a strand stays put
 *     from root to tip, does not swim when the shells sway, and shows no lattice-slicing rings.
 * 11. Crackle. A crack is a border of a 3D voronoi cell (object space) where the surface cuts it.
 *     Its width is measured ALONG the surface (3D distance to the border plane divided by the sine
 *     of the plane-to-surface angle), and borders lying almost flat in the surface fade out, or
 *     they would smear into blotches. Lines are box-filtered with the pixel footprint, so at
 *     thumbnail size they get fainter instead of aliasing.
 * 12. Glitter. Flakes are tiny mirrors on a jittered 3D lattice; their glint is an EXTRA GGX lobe
 *     around each flake's own normal ([da:glint] for direct lights, [da:glint-env] for the studio),
 *     while the base layer keeps its smooth normal: flakes that are not lined up add nothing, so
 *     the body color reads clean instead of turning into dark specks. Level of detail: flakes come
 *     from two lattice levels picked by the pixel footprint (each level doubles the cell size), so
 *     a flake always spans about three pixels or more (coarser sparkles in thumbnails, never
 *     noise); past the coarsest level they fade into their average, a broad metallic shimmer. The
 *     flake normal goes to view space through normalMatrix, declared in the fragment shader (three
 *     uploads it for every draw and declares it there itself only for object-space normal maps).
 * 13. RE_Direct is remapped at most once per program: [da:wrap] (rubber, jelly, fur) or
 *     [da:glint] (glitter). A finish that asked for both would throw when it is built.
 *
 * PAINT ZONE MATH (the same as sdf.js zoneDistance / paintTone, its CPU reference):
 *   q = |p - c| / r (per axis), S = qx^e + qy^e + qz^e, s = S^(1/e) (1 on the zone's skin),
 *   g = |grad s| = S^(1/e - 1) * length(q^(e-1) / r), d = (s - 1) / g (approximate distance)
 *   w = 1 - smoothstep(-k, k, d), k = max(soft / 2, footprint * 0.75)   (footprint = 0 on the CPU)
 *   zones apply in array order: color = mix(color, tone, w), later zones paint over earlier ones.
 *   q is clamped to >= 1e-4 (pow(0, y) is undefined in GLSL); S < 1e-12 means deep inside.
 *   Tone indices in the shaders: cream 0, pink 1, dark 2, light 3, orange 4, white 5, screen 6,
 *   leaf 7 (daTones[8]; the fur folds them into furTone0 = cream..light, furTone1 = orange..leaf).
 */

const FINISH_IDS = ['plush', 'fluffy', 'felt', 'clay', 'ceramic', 'crackle', 'speckled', 'pearl', 'rubber', 'vinyl', 'glitter', 'jelly', 'glass', 'chrome'];
const SOFT = { plush: true, fluffy: true, felt: true, clay: true };
const TRANSMISSIVE = { jelly: true, glass: true };
const TONE_KEYS = ['cream', 'pink', 'dark', 'light', 'orange', 'white', 'screen', 'leaf'];
const NT = TONE_KEYS.length;            // 8 tones; the shaders declare daTones[ NT ]
const LAYOUT = '-t' + NT;               // program cache key suffix for the paint/tone layout (trap 2)
const DEFAULT_HEX = 'ffd34e';
const MAX_ZONES = 12;
const MAX_TRIMS = 6;

/* Physical targets for the hard finishes (spec 4.5). The numbers are ours.
 * ao: how much baked AO darkens ambient light; aoDirect: how much it darkens direct light too;
 * cavity: extra darkening in concave creases; wrap: soft terminator; tintWhite: base color lift;
 * glaze: glaze pooling plus a rippled clear coat (ceramic, crackle).
 * crack (crackle): s1/s2 = cells per unit of the coarse and the fine network, w1/w2 = crack
 *   half-widths (object units), warp/warpF = domain warp amplitude and frequency, maskF = frequency
 *   of the patches where fine cracks show, fine = their strength, dark = crack color on light
 *   bodies (x body), pale = how far cracks go toward pale gray on very dark bodies, mix = crack
 *   opacity, groove = how deep cracks sink into the glaze, dull = clear coat lost inside a crack.
 * flake (glitter): cells = flake cells per unit at full detail, on = share of empty cells, rMin/rVar
 *   = flake radius in cells, tilt = tan of the largest mirror tilt, rough = flake roughness,
 *   haze = GGX alpha of the averaged shimmer, lift = how much a flake lightens the base, lod0 =
 *   pixel footprint (cells) where the next level starts, lodMax = coarsest level. */
const SURFACE = {
  clay: { roughness: 0.56, env: 0.85, ao: 0.85, aoDirect: 0.35, cavity: 0.22, bump: true },
  ceramic: { roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.035, env: 1.0, ao: 0.8, aoDirect: 0.25, cavity: 0.1, glaze: true },
  crackle: {
    roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.04, env: 1.0, ao: 0.8, aoDirect: 0.25, cavity: 0.1, glaze: true,
    crack: { s1: 5.6, s2: 13, w1: 0.0028, w2: 0.0016, warp: 0.02, warpF: 3.3, maskF: 2.6, fine: 0.55, dark: 0.42, pale: 0.45, mix: 0.8, groove: 0.0005, dull: 0.45 }
  },
  speckled: { roughness: 0.76, env: 0.8, ao: 0.85, aoDirect: 0.35, cavity: 0.2, bump: true },
  pearl: { roughness: 0.26, clearcoat: 0.55, clearcoatRoughness: 0.08, iridescence: 1, iridescenceIOR: 1.32, iridescenceThicknessRange: [180, 560], env: 1.0, ao: 0.8, aoDirect: 0.25, cavity: 0.12, bump: true },
  rubber: { roughness: 0.84, sheen: 0.4, sheenRoughness: 0.6, env: 0.75, ao: 0.85, aoDirect: 0.35, cavity: 0.2, wrap: 0.32, wrapTint: [1.0, 0.86, 0.82], bump: true },
  vinyl: { roughness: 0.3, clearcoat: 0.35, clearcoatRoughness: 0.22, env: 0.95, ao: 0.8, aoDirect: 0.3, cavity: 0.15 },
  glitter: {
    roughness: 0.46, clearcoat: 0.6, clearcoatRoughness: 0.14, env: 1.0, ao: 0.8, aoDirect: 0.3, cavity: 0.12,
    flake: { cells: 80, on: 0.3, rMin: 0.27, rVar: 0.16, tilt: 0.75, rough: 0.24, haze: 0.3, lift: 0.12, lod0: 0.4, lodMax: 3 }
  },
  jelly: { roughness: 0.07, transmission: 0.9, thickness: 0.8, ior: 1.35, attenuationDistance: 0.55, env: 1.0, ao: 0.55, aoDirect: 0.1, cavity: 0.05, wrap: 0.45, wrapTint: [1, 1, 1], tintWhite: 0.5, attenWhite: 0 },
  glass: { roughness: 0.035, transmission: 1, thickness: 0.6, ior: 1.5, dispersion: 0.18, attenuationDistance: 1.6, env: 1.0, ao: 0.45, aoDirect: 0.05, cavity: 0.0, tintWhite: 0.6, attenWhite: 0.3 },
  chrome: { roughness: 0.1, metalness: 1, env: 1.0, ao: 0.9, aoDirect: 0.2, cavity: 0.1 }
};

/* Fur finishes. density = strand cells per object unit; thick = strand radius at the root in cell
 * units (<= 0.5: the 2x2 nearest-cell search is exact up to there); jitter = strand offset inside
 * its cell (0..1); lenVar = random strand shortening; under = height fraction of the dense
 * undercoat; mode 0 = strands on a cube-mapped 2D lattice, 1 = matted fuzz (3D value noise).
 * rootDark = light left at the roots. Round 2 raised it (plush 0.42 -> 0.60, fluffy 0.36 -> 0.48):
 * head-on, about half of a plush pixel shows the undercoat between strand tips, so the mean visible
 * brightness was 64% of the swatch and Butter read deep; it is now 76% (fluffy 68% -> 75%), with
 * the hue untouched (both measured with a Monte Carlo of this shader on a flat patch). */
const FUR = {
  plush: { layers: 28, length: 0.035, density: 160, thick: 0.42, jitter: 0.9, lenVar: 0.30, under: 0.10, gravity: 0.22, wind: 0.30, clump: 0, rootDark: 0.60, tipLift: 0.14, sheen: 0.55, colorNoise: 0.14, roughness: 0.74, env: 0.85, mode: 0 },
  fluffy: { layers: 40, length: 0.075, density: 95, thick: 0.46, jitter: 0.9, lenVar: 0.45, under: 0.07, gravity: 0.85, wind: 0.75, clump: 0.5, rootDark: 0.48, tipLift: 0.2, sheen: 0.38, colorNoise: 0.18, roughness: 0.8, env: 0.85, mode: 0 },
  felt: { layers: 16, length: 0.015, density: 230, thick: 0, jitter: 0, lenVar: 0, under: 0.18, gravity: 0.08, wind: 0.06, clump: 0, rootDark: 0.62, tipLift: 0.06, sheen: 0.22, colorNoise: 0.16, roughness: 0.95, env: 0.8, mode: 1 }
};
const FUR_WRAP = 0.35;
/* Density compensation for fewer shells (FUR QUALITY): with comp = the share of shells left out,
 * thick *= 1 + 0.25 comp (capped at 0.5, where the 2x2 strand search is still exact) and
 * rootDark += (1 - rootDark) * 0.12 comp. Fitted so q 0.6 matches q 1 within 0.03 (q 0.4: 0.065). */
const FUR_COMP = { thick: 0.25, rootDark: 0.12 };

function furLayerCount(F, q) { return Math.max(F.mode === 1 ? 5 : 8, Math.round(F.layers * q)); }

function furCompensated(F, layers) {
  const comp = clamp(1 - layers / F.layers, 0, 1);
  return {
    thick: F.thick > 0 ? Math.min(0.5, F.thick * (1 + FUR_COMP.thick * comp)) : F.thick,
    rootDark: F.rootDark + (1 - F.rootDark) * FUR_COMP.rootDark * comp
  };
}

/* Fur quality for a stage (FUR QUALITY). info = {dpr, coarse, pixels}: dpr = the renderer's pixel
 * ratio after the stage's cap, coarse = (pointer: coarse), pixels = drawing-buffer pixels (optional). */
export function furQualityFor(info) {
  const o = info || {};
  if (o.coarse) return 0.5;
  const dpr = typeof o.dpr === 'number' && o.dpr > 0 ? o.dpr : 1;
  const pixels = typeof o.pixels === 'number' && o.pixels > 0 ? o.pixels : 0;
  return dpr >= 1.8 || pixels > 2.6e6 ? 0.6 : 1;
}

/* Accessory kinds (spec 4.5). color is the default when opts.color is missing. Round 2 adds
 * leather (matte-satin, pebbled grain), terry (looped pile, very matte, fuzz from the sheen) and
 * feather (soft white, satin sheen, faint barbs). The detail patterns (knit, straw, felt, leather,
 * terry, feather) live in the accessory GEOMETRY's object space and are sized for character units
 * (a body about 1.6 tall): a mesh scaled by s shows them s times larger. knit and straw wrap around
 * the local y axis; feather barbs slant up and outward from a shaft along local y at x = 0. */
const ACC = {
  fabric: { type: 'phys', color: 'e85d75', roughness: 0.88, sheen: 0.55, sheenSoft: 1.0, sheenRoughness: 0.55 },
  knit: { type: 'phys', color: 'e85d75', roughness: 0.92, sheen: 0.65, sheenSoft: 1.0, sheenRoughness: 0.6, detail: 'knit' },
  felt: { type: 'phys', color: '6b8cff', roughness: 0.96, sheen: 0.45, sheenSoft: 0.8, sheenRoughness: 0.7, detail: 'felt' },
  straw: { type: 'phys', color: 'e6c88a', roughness: 0.8, detail: 'straw' },
  paper: { type: 'std', color: 'fff7ea', roughness: 0.95 },
  plastic: { type: 'phys', color: 'ff6f61', roughness: 0.34, clearcoat: 0.3, clearcoatRoughness: 0.2 },
  rubber: { type: 'phys', color: '34343a', roughness: 0.86, sheen: 0.25, sheenSoft: 0.25, sheenRoughness: 0.6 },
  gold: { type: 'phys', color: 'f9d77e', metalness: 1, roughness: 0.22 },
  silver: { type: 'phys', color: 'e2e5ea', metalness: 1, roughness: 0.16 },
  gem: { type: 'phys', color: 'e0457b', roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, ior: 2.0, specularIntensity: 1, iridescence: 0.25, iridescenceIOR: 1.4, flat: true, env: 1.4 },
  pearl: { type: 'phys', color: 'f6f1e8', roughness: 0.24, clearcoat: 0.6, clearcoatRoughness: 0.06, iridescence: 0.8, iridescenceIOR: 1.3, iridescenceThicknessRange: [200, 480] },
  'lens-clear': { type: 'phys', color: 'ffffff', roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.16, depthWrite: false },
  'lens-dark': { type: 'phys', color: '15151c', roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.88 },
  'lens-tint': { type: 'phys', color: 'ff8cc6', roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.5, depthWrite: false },
  emissive: { type: 'std', color: '8ef6ff', roughness: 0.4, glow: 1.8 },
  ink: { type: 'phys', color: '222228', roughness: 0.55 },
  enamel: { type: 'phys', color: 'ffffff', roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08 },
  leather: { type: 'phys', color: '7a4b2c', roughness: 0.5, clearcoat: 0.18, clearcoatRoughness: 0.4, detail: 'leather' },
  terry: { type: 'phys', color: 'f3efe7', roughness: 0.97, sheen: 0.55, sheenSoft: 0.75, sheenRoughness: 0.8, detail: 'terry' },
  feather: { type: 'phys', color: 'fbf8f1', roughness: 0.6, sheen: 0.5, sheenSoft: 0.6, sheenRoughness: 0.35, detail: 'feather' }
};

/* ------------------------------------------------------------------------------------------ */
/* Small numeric helpers                                                                        */
/* ------------------------------------------------------------------------------------------ */

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

// GLSL float literal: always has a decimal point ('1.00000'), never an int.
function f(x) { return (Number(x) || 0).toFixed(5); }
function v3(a) { return 'vec3( ' + f(a[0]) + ', ' + f(a[1]) + ', ' + f(a[2]) + ' )'; }

// 'rrggbb' (lowercase, no '#') from '#rgb', 'rgb', '#rrggbb', 'rrggbb', a number or a THREE.Color.
function normHex(x) {
  if (typeof x === 'number' && isFinite(x)) return ('000000' + (x >>> 0).toString(16)).slice(-6);
  if (x && x.isColor && typeof x.getHexString === 'function') return x.getHexString();
  let s = String(x == null ? '' : x).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return /^[0-9a-f]{6}$/.test(s) ? s : null;
}

/* ------------------------------------------------------------------------------------------ */
/* OKLab (Bjorn Ottosson, "A perceptual color space for image processing", 2020)               */
/* ------------------------------------------------------------------------------------------ */

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  ];
}

function oklabToLinear(L, a, b) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ];
}

function hexToLab(hex) {
  const n = parseInt(hex, 16);
  return linearToOklab(srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255));
}

function inGamut(rgb) { return rgb[0] >= -1e-4 && rgb[0] <= 1.0001 && rgb[1] >= -1e-4 && rgb[1] <= 1.0001 && rgb[2] >= -1e-4 && rgb[2] <= 1.0001; }

// OKLab -> 'rrggbb'; out-of-gamut colors keep L and hue and lose chroma (bisection).
function labToHex(lab) {
  const L = clamp(lab[0], 0, 1);
  let rgb = oklabToLinear(L, lab[1], lab[2]);
  if (!inGamut(rgb)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, lab[1] * mid, lab[2] * mid))) lo = mid; else hi = mid;
    }
    rgb = oklabToLinear(L, lab[1] * lo, lab[2] * lo);
  }
  let out = '';
  for (let i = 0; i < 3; i++) out += ('0' + Math.round(clamp(linearToSrgb(clamp(rgb[i], 0, 1)), 0, 1) * 255).toString(16)).slice(-2);
  return out;
}

function lch(L, C, hDeg) { const h = (hDeg * Math.PI) / 180; return [L, C * Math.cos(h), C * Math.sin(h)]; }
function labDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

// First candidate at least minDist from the body color in OKLab, else the farthest one.
function pickTone(cands, body, minDist) {
  let best = cands[0], bestD = -1;
  for (let i = 0; i < cands.length; i++) {
    const d = labDist(cands[i], body);
    if (d >= minDist) return cands[i];
    if (d > bestD) { bestD = d; best = cands[i]; }
  }
  return best;
}

function computeTones(hex) {
  const B = hexToLab(hex);
  const Lb = B[0];
  const Cb = Math.hypot(B[1], B[2]);
  const hb = (Math.atan2(B[2], B[1]) * 180) / Math.PI;
  const veryDark = Lb < 0.40;
  let light;
  if (Lb > 0.86) light = lch(Lb - 0.12, Cb * 1.1 + 0.02, hb);
  else light = lch(Math.min(0.97, Lb + 0.15), Cb * 0.7, hb);
  if (labDist(light, B) < 0.08) light = lch(Lb > 0.5 ? Lb - 0.16 : Lb + 0.2, Cb * 0.8, hb);
  const T = {
    cream: pickTone([lch(0.95, 0.035, 85), lch(0.995, 0.006, 95), lch(0.83, 0.055, 75)], B, 0.12),
    pink: pickTone([lch(0.80, 0.10, 2), lch(0.91, 0.05, 5), lch(0.64, 0.15, 5)], B, 0.12),
    dark: veryDark
      ? pickTone([lch(0.90, 0.02, 85), lch(0.80, 0.03, 85)], B, 0.12)
      : pickTone([lch(0.27, 0.015, 30), lch(0.16, 0.01, 30), lch(0.42, 0.02, 30)], B, 0.12),
    light: light,
    orange: pickTone([lch(0.75, 0.16, 55), lch(0.63, 0.17, 38), lch(0.85, 0.14, 80)], B, 0.12),
    white: pickTone([lch(0.985, 0.005, 95), lch(0.90, 0.012, 250), lch(0.82, 0.015, 250)], B, 0.10),
    screen: pickTone([lch(0.22, 0.035, 265), lch(0.13, 0.02, 265), lch(0.40, 0.05, 255)], B, 0.14),
    // leaf: a fresh spring green; on a green body it goes deep green, then pale lime, whichever
    // first stands 0.12 apart in OKLab (else the farthest of the three)
    leaf: pickTone([lch(0.74, 0.17, 136), lch(0.52, 0.13, 145), lch(0.88, 0.12, 125)], B, 0.12),
    ink: veryDark ? lch(0.96, 0.01, 90) : pickTone([lch(0.22, 0.02, 300), lch(0.14, 0.01, 300)], B, 0.12),
    inkLight: veryDark ? lch(0.80, 0.02, 90) : lch(0.48, 0.03, 300),
    cheek: pickTone(veryDark ? [lch(0.80, 0.10, 8), lch(0.70, 0.14, 10)] : [lch(0.76, 0.12, 10), lch(0.62, 0.16, 12), lch(0.86, 0.07, 5)], B, 0.09)
  };
  const out = {};
  for (const k in T) out[k] = labToHex(T[k]);
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Paint zones on the CPU (used for the fur's per-vertex tone weights)                          */
/* ------------------------------------------------------------------------------------------ */

function arr3(a, d) {
  if (Array.isArray(a) || (a && typeof a.length === 'number')) return [+a[0] || 0, +a[1] || 0, +a[2] || 0];
  if (a && typeof a.x === 'number') return [a.x, a.y, a.z];
  if (typeof a === 'number') return [a, a, a];
  return [d, d, d];
}

function zoneList(shape) {
  const src = shape && Array.isArray(shape.paint) ? shape.paint : [];
  const out = [];
  for (let i = 0; i < src.length && out.length < MAX_ZONES; i++) {
    const z = src[i];
    if (!z) continue;
    const ti = TONE_KEYS.indexOf(z.tone);
    if (ti < 0) continue;
    const r = arr3(z.r, 0.1).map((v) => Math.max(1e-3, Math.abs(v)));
    out.push({ c: arr3(z.c, 0), r, p: clamp(+z.p || 2, 0.5, 16), soft: Math.max(1e-3, +z.soft || 0.03), ti });
  }
  return out;
}

// Coverage of one zone at (x, y, z): the shader's formula with a zero pixel footprint.
function zoneWeight(Z, x, y, z) {
  const k = Z.soft * 0.5;
  const e = Z.p, r = Z.r;
  const rmin = Math.min(r[0], r[1], r[2]);
  let qx = Math.abs(x - Z.c[0]) / r[0], qy = Math.abs(y - Z.c[1]) / r[1], qz = Math.abs(z - Z.c[2]) / r[2];
  if (e >= 1 && (Math.max(qx, qy, qz) - 1) * rmin > 2 * k) return 0;
  qx = Math.max(qx, 1e-4); qy = Math.max(qy, 1e-4); qz = Math.max(qz, 1e-4);
  const ex = Math.pow(qx, e), ey = Math.pow(qy, e), ez = Math.pow(qz, e);
  const S = ex + ey + ez;
  const Sc = Math.max(S, 1e-12);
  const s = Math.pow(Sc, 1 / e);
  const g = Math.pow(Sc, 1 / e - 1) * Math.hypot(ex / qx / r[0], ey / qy / r[1], ez / qz / r[2]);
  const d = S < 1e-12 ? -rmin : (s - 1) / Math.max(g, 1e-9);
  return 1 - smoothstep(-k, k, d);
}

// Folds the ordered mix() chain into 8 tone weights per vertex: final = base * (1 - sum) + sum(w_i * tone_i).
// furTone0 = cream, pink, dark, light; furTone1 = orange, white, screen, leaf.
function fillFurToneWeights(position, shape, t0, t1) {
  const zones = zoneList(shape);
  const n = position.count;
  const w = new Float32Array(NT);
  for (let v = 0; v < n; v++) {
    w.fill(0);
    if (zones.length) {
      const x = position.getX(v), y = position.getY(v), z = position.getZ(v);
      for (let i = 0; i < zones.length; i++) {
        const ww = zoneWeight(zones[i], x, y, z);
        if (ww <= 0) continue;
        for (let j = 0; j < NT; j++) w[j] *= 1 - ww;
        w[zones[i].ti] += ww;
      }
    }
    const o = v * 4;
    t0[o] = w[0]; t0[o + 1] = w[1]; t0[o + 2] = w[2]; t0[o + 3] = w[3];
    t1[o] = w[4]; t1[o + 1] = w[5]; t1[o + 2] = w[6]; t1[o + 3] = w[7];
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Shader injection                                                                             */
/* ------------------------------------------------------------------------------------------ */

// Inserts `code` after (or before, or instead of) the first `target` in `src`. Throws when the
// target is missing: a three.js update that renames a chunk must fail loudly (trap 1).
function inject(src, target, code, where, label) {
  const i = src.indexOf(target);
  if (i < 0) {
    throw new Error('[dot-avatar materials] shader injection "' + label + '": target "' + target +
      '" not found. three.js changed? Re-check the injection list against THREE.ShaderLib.physical.');
  }
  const rep = where === 'replace' ? code : where === 'before' ? code + '\n' + target : target + '\n' + code;
  return src.slice(0, i) + rep + src.slice(i + target.length);
}

/* ---- GLSL: shared helpers (fragment) ---------------------------------------------------- */

const GLSL_HASH = `
// ---- [da:hash] PCG3D integer hash (Jarzynski and Olano, JCGT 2020): stable randoms per lattice cell ----
highp uvec3 daPcg3d( highp uvec3 v ) {
	v = v * 1664525u + 1013904223u;
	v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
	v ^= v >> 16u;
	v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
	return v;
}
// cell: integer-valued lattice coordinate (already floored), |cell| < 32768; three randoms in [0, 1)
vec3 daHash33( vec3 cell ) {
	highp uvec3 u = uvec3( ivec3( cell ) + ivec3( 32768 ) );
	return vec3( daPcg3d( u ) >> 8u ) * ( 1.0 / 16777216.0 );
}
float daHash13( vec3 cell ) {
	return daHash33( cell ).x;
}
`;

const GLSL_NOISE = `
// ---- [da:noise] 3D value noise, gradient simplex noise and cellular (voronoi) noise ----
float daValueNoise( vec3 p ) {
	vec3 i = floor( p );
	vec3 f = p - i;
	vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	float n000 = daHash13( i );
	float n100 = daHash13( i + vec3( 1.0, 0.0, 0.0 ) );
	float n010 = daHash13( i + vec3( 0.0, 1.0, 0.0 ) );
	float n110 = daHash13( i + vec3( 1.0, 1.0, 0.0 ) );
	float n001 = daHash13( i + vec3( 0.0, 0.0, 1.0 ) );
	float n101 = daHash13( i + vec3( 1.0, 0.0, 1.0 ) );
	float n011 = daHash13( i + vec3( 0.0, 1.0, 1.0 ) );
	float n111 = daHash13( i + vec3( 1.0, 1.0, 1.0 ) );
	return mix( mix( mix( n000, n100, u.x ), mix( n010, n110, u.x ), u.y ),
		mix( mix( n001, n101, u.x ), mix( n011, n111, u.x ), u.y ), u.z );
}
vec3 daGrad3( vec3 cell ) {
	return normalize( daHash33( cell ) * 2.0 - 1.0 + vec3( 0.0001 ) );
}
// simplex noise on the skewed tetrahedral lattice, roughly in [-1, 1]
float daSimplex( vec3 p ) {
	const float F3 = 0.33333333;
	const float G3 = 0.16666667;
	vec3 s = floor( p + dot( p, vec3( F3 ) ) );
	vec3 x0 = p - s + dot( s, vec3( G3 ) );
	vec3 e = step( vec3( 0.0 ), x0 - x0.yzx );
	vec3 i1 = e * ( 1.0 - e.zxy );
	vec3 i2 = 1.0 - e.zxy * ( 1.0 - e );
	vec3 x1 = x0 - i1 + G3;
	vec3 x2 = x0 - i2 + 2.0 * G3;
	vec3 x3 = x0 - 1.0 + 3.0 * G3;
	vec4 w = max( 0.6 - vec4( dot( x0, x0 ), dot( x1, x1 ), dot( x2, x2 ), dot( x3, x3 ) ), 0.0 );
	w *= w;
	w *= w;
	vec4 d = vec4( dot( daGrad3( s ), x0 ), dot( daGrad3( s + i1 ), x1 ), dot( daGrad3( s + i2 ), x2 ), dot( daGrad3( s + 1.0 ), x3 ) );
	return 32.0 * dot( w, d );
}
// xyz = offset from p to the nearest feature point (lattice units), w = that distance (F1);
// id = a random number of the winning cell
vec4 daVoronoi( vec3 p, out float id ) {
	vec3 i = floor( p );
	vec3 fr = p - i;
	vec4 best = vec4( 0.0, 0.0, 0.0, 8.0 );
	id = 0.0;
	for ( int z = -1; z <= 1; z ++ ) {
		for ( int y = -1; y <= 1; y ++ ) {
			for ( int x = -1; x <= 1; x ++ ) {
				vec3 o = vec3( float( x ), float( y ), float( z ) );
				vec3 h = daHash33( i + o );
				vec3 r = o + h - fr;
				float d2 = dot( r, r );
				if ( d2 < best.w ) {
					best = vec4( r, d2 );
					id = fract( h.x * 17.13 + h.y * 3.71 + h.z * 1.37 );
				}
			}
		}
	}
	best.w = sqrt( best.w );
	return best;
}
// sum of smooth round bumps centered on jittered lattice points; continuous everywhere because
// each bump's support (radius <= 1 cell) stays inside the 3x3x3 neighborhood that is summed.
// density = fraction of cells that carry a bump; bump heights vary per cell (0.5..1)
float daBumpField( vec3 p, float radius, float density ) {
	vec3 i = floor( p );
	vec3 fr = p - i;
	float sum = 0.0;
	for ( int z = -1; z <= 1; z ++ ) {
		for ( int y = -1; y <= 1; y ++ ) {
			for ( int x = -1; x <= 1; x ++ ) {
				vec3 o = vec3( float( x ), float( y ), float( z ) );
				vec3 h = daHash33( i + o );
				float on = step( 1.0 - density, fract( h.x * 17.13 + h.y * 3.71 + h.z * 1.37 ) );
				float k = 1.0 - smoothstep( 0.0, radius, length( o + h - fr ) );
				sum += on * k * k * ( 0.5 + 0.5 * fract( h.z * 9.17 + h.x * 2.31 ) );
			}
		}
	}
	return sum;
}
`;

// Terry pile (accessory detail). Needs GLSL_HASH.
const GLSL_LOOPS = `
// ---- [da:loops] terry pile: the highest of the soft round loops around p, one per lattice cell.
// Centers sit within +-jitter/2 of the cell middle, so the 3x3x3 search is exact (continuous) for
// radius < 1.5 - jitter / 2; loop heights vary per cell (0.75..1) ----
float daLoopField( vec3 p, float radius, float jitter ) {
	vec3 i = floor( p );
	vec3 fr = p - i;
	float best = 0.0;
	for ( int z = -1; z <= 1; z ++ ) {
		for ( int y = -1; y <= 1; y ++ ) {
			for ( int x = -1; x <= 1; x ++ ) {
				vec3 o = vec3( float( x ), float( y ), float( z ) );
				vec3 h = daHash33( i + o );
				vec3 c = o + 0.5 + ( h - 0.5 ) * jitter - fr;
				float k = 1.0 - smoothstep( 0.0, radius, length( c ) );
				best = max( best, k * ( 0.75 + 0.25 * fract( h.z * 9.17 + h.x * 2.31 ) ) );
			}
		}
	}
	return best;
}
`;

const GLSL_BUMP = `
// ---- [da:bump] surface-gradient bump (Mikkelsen 2010): perturbs a view-space normal by a scalar
// height field using screen-space derivatives; no tangents or uvs needed. Call in uniform flow. ----
vec3 daBumpNormal( vec3 surfPos, vec3 n, float height ) {
	vec3 dpdx = dFdx( surfPos );
	vec3 dpdy = dFdy( surfPos );
	float dhdx = dFdx( height );
	float dhdy = dFdy( height );
	vec3 r1 = cross( dpdy, n );
	vec3 r2 = cross( n, dpdx );
	float det = dot( dpdx, r1 );
	vec3 grad = sign( det ) * ( dhdx * r1 + dhdy * r2 );
	vec3 bumped = abs( det ) * n - grad;
	float len2 = dot( bumped, bumped );
	return len2 > 1e-20 ? bumped * inversesqrt( len2 ) : n;
}
`;

// Crackle (trap 11). Needs GLSL_HASH.
const GLSL_CRACK = `
// ---- [da:crack] crackle glaze: distance to the nearest crack, a border of a 3D voronoi cell ----
// p: object position; n: unit object normal; scale: cells per object unit.
// The border is the bisector plane of the nearest and the second-nearest jittered feature point
// (exact away from junctions; near one it reads a little short, and real cracks widen there too).
// The distance is measured ALONG the surface: the 3D distance divided by the sine of the angle
// between that plane and the surface. A plane lying almost flat in the surface would smear into a
// blotch, so such borders fade out (vis). Returns object units.
float daCrackDist( vec3 p, vec3 n, float scale, out float vis ) {
	vec3 q = p * scale;
	vec3 i = floor( q );
	vec3 fr = q - i;
	float d1 = 64.0;
	float d2 = 64.0;
	vec3 r1 = vec3( 0.0 );
	vec3 r2 = vec3( 0.0 );
	for ( int z = -1; z <= 1; z ++ ) {
		for ( int y = -1; y <= 1; y ++ ) {
			for ( int x = -1; x <= 1; x ++ ) {
				vec3 o = vec3( float( x ), float( y ), float( z ) );
				vec3 r = o + 0.5 + ( daHash33( i + o ) - 0.5 ) * 0.9 - fr;
				float dd = dot( r, r );
				if ( dd < d1 ) {
					d2 = d1;
					r2 = r1;
					d1 = dd;
					r1 = r;
				} else if ( dd < d2 ) {
					d2 = dd;
					r2 = r;
				}
			}
		}
	}
	vec3 u = r2 - r1;
	u *= inversesqrt( max( dot( u, u ), 1e-8 ) );
	float d = max( dot( 0.5 * ( r1 + r2 ), u ), 0.0 );   // to the bisector plane, cell units
	float t = length( u - n * dot( u, n ) );              // sine of the plane-to-surface angle
	vis = smoothstep( 0.12, 0.35, t );
	return d / ( max( t, 0.12 ) * scale );
}
// box-filtered coverage of a line of half-width w at distance d; a = filter half-width (same units)
float daLineCov( float d, float w, float a ) {
	return max( min( d + a, w ) - max( d - a, - w ), 0.0 ) / ( 2.0 * a );
}
`;

// Glitter flakes (trap 12). Needs GLSL_HASH.
function glslFlake(F) {
  return `
// ---- [da:flake] glitter flakes: tiny mirrors on a jittered 3D lattice in object space ----
// Nearest flake center among the 2x2x2 closest cells. With jitter 0.9 this is exact for flakes of
// radius < 0.55 cell, so there are no seams. Returns the distance in cell units; h = its randoms.
float daFlakeNearest( vec3 q, out vec3 h ) {
	vec3 base = floor( q - 0.5 );
	float best = 64.0;
	h = vec3( 0.5 );
	for ( int z = 0; z < 2; z ++ ) {
		for ( int y = 0; y < 2; y ++ ) {
			for ( int x = 0; x < 2; x ++ ) {
				vec3 cell = base + vec3( float( x ), float( y ), float( z ) );
				vec3 hc = daHash33( cell );
				vec3 r = cell + 0.5 + ( hc - 0.5 ) * 0.9 - q;
				float dd = dot( r, r );
				if ( dd < best ) {
					best = dd;
					h = hc;
				}
			}
		}
	}
	return sqrt( best );
}
// One flake level with the given cells per object unit. Returns the antialiased coverage of the
// flake under p (px = pixel footprint in object units; n = unit object normal); tilt = its mirror
// tilt (object space, in the tangent plane, length = tan of the tilt angle: a random vector of
// the flake projected on the plane, so it is continuous everywhere and needs no tangent basis);
// tint = its color (the base lightened, some flakes silver).
float daFlakeLayer( vec3 p, vec3 n, float cells, float px, vec3 base, out vec3 tilt, out vec3 tint ) {
	vec3 h;
	float d = daFlakeNearest( p * cells, h );
	float r = ${f(F.rMin)} + ${f(F.rVar)} * h.y;
	float a = max( px * cells * 0.5, 0.02 );
	vec3 v = fract( h.zxy * vec3( 13.37, 7.11, 5.33 ) + h.yzx * 3.17 ) * 2.0 - 1.0;
	vec3 vt = v - n * dot( v, n );
	tilt = vt * ( ${f(F.tilt)} / max( length( vt ), 1.0 ) );
	tint = mix( mix( base, vec3( 1.0 ), 0.35 + 0.3 * h.y ), vec3( 0.95 ), step( 0.82, fract( h.z * 9.31 + h.x * 3.7 ) ) );
	return ( 1.0 - smoothstep( r - a, r + a, d ) ) * step( ${f(F.on)}, h.z );
}
`;
}

// Glitter: three declares normalMatrix in the fragment shader only for object-space normal maps.
const GLSL_NORMAL_MATRIX = `
// [da:normal-matrix] uploaded by three for every draw; turns the flake tilt into view space
#ifndef USE_NORMALMAP_OBJECTSPACE
uniform mat3 normalMatrix;
#endif
`;

// Glitter glint lobe for direct lights. Inserted right after lights_physical_pars_fragment, where
// RE_Direct_Physical, D_GGX and V_GGX_SmithCorrelated are defined (trap 13: one RE_Direct remap).
const GLSL_GLINT = `
// ---- [da:glint] glitter: every direct light also flashes on the flakes, a sharp GGX lobe around
// each flake's own mirror normal. The base layer keeps its smooth normal, so the body color reads
// clean, and a flake that is not lined up adds nothing instead of showing as a dark speck. ----
vec3 daFlakeN = vec3( 0.0, 0.0, 1.0 );   // view space; set in main() once the normal is known
vec3 daFlakeF = vec3( 0.0 );             // flake reflectance x coverage; set in the color stage
float daFlakeA = 0.3;                    // GGX alpha (roughness squared) of the flake lobe
void RE_Direct_DaGlint( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	float daNL = saturate( dot( daFlakeN, directLight.direction ) );
	float daNV = saturate( dot( daFlakeN, geometryViewDir ) );
	float daNH = saturate( dot( daFlakeN, normalize( directLight.direction + geometryViewDir ) ) );
	reflectedLight.directSpecular += directLight.color * daFlakeF * ( daNL * V_GGX_SmithCorrelated( daFlakeA, daNL, daNV ) * D_GGX( daFlakeA, daNH ) );
}
#undef RE_Direct
#define RE_Direct RE_Direct_DaGlint
`;

// Glitter: the flake normal in view space, after normal_fragment_maps (normal is known there).
const FLAKE_NORMAL = `
	// [da:flake-normal] the flake mirror normal in view space; the base layer and the clear coat
	// keep their smooth normals (clearcoat_normal_fragment_begin reads nonPerturbedNormal)
	{
		vec3 daTv = normalMatrix * daFlakeTilt;
		daTv *= length( daFlakeTilt ) * inversesqrt( max( dot( daTv, daTv ), 1e-12 ) );
		vec3 daVv = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( vViewPosition );
		daFlakeN = normalize( normal + daTv );
		daFlakeN = normalize( daFlakeN + daVv * max( 0.0, 0.1 - dot( daFlakeN, daVv ) ) );   // never facing away
	}`;

// Glitter: env glints, after lights_fragment_end and before aomap_fragment, so [da:ao] occludes them.
const FLAKE_ENV = `
	// ---- [da:glint-env] glitter: each flake also mirrors the studio in its own direction ----
	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
		reflectedLight.indirectSpecular += daFlakeF * getIBLRadiance( geometryViewDir, daFlakeN, sqrt( daFlakeA ) );
	#endif`;

// Crackle: after lights_physical_fragment, where material.clearcoat is set.
const CRACKLE_COAT = `
	// [da:crackle-coat] the glaze is thinner and duller inside the cracks
	#ifdef USE_CLEARCOAT
		material.clearcoat *= daCoatK;
		material.clearcoatRoughness = min( material.clearcoatRoughness + 0.14 * ( 1.0 - daCoatK ), 1.0 );
	#endif`;

const GLSL_PAINT = `
// ---- [da:paint] paint zones: superellipsoids in OBJECT space (same math as sdf.js paintTone) ----
#define DA_MAX_ZONES ${MAX_ZONES}
#define DA_TONES ${NT}
uniform int daZoneCount;
uniform vec3 daZoneC[ DA_MAX_ZONES ];   // centers
uniform vec3 daZoneR[ DA_MAX_ZONES ];   // radii
uniform vec4 daZoneP[ DA_MAX_ZONES ];   // x = exponent, y = soft edge width, z = tone index 0..7
uniform vec3 daTones[ DA_TONES ];       // linear RGB: cream, pink, dark, light, orange, white, screen, leaf
// p: object-space point; px: object-space size of one pixel (antialiasing).
// Returns the painted color; wAll = total zone coverage; wScreen = coverage of 'screen' zones;
// zoneCol = the zones' own color (tints the transmission of jelly and glass).
vec3 daPaint( vec3 p, vec3 base, float px, out float wAll, out float wScreen, out vec3 zoneCol ) {
	vec3 col = base;
	wAll = 0.0;
	wScreen = 0.0;
	zoneCol = base;
	for ( int i = 0; i < DA_MAX_ZONES; i ++ ) {
		if ( i >= daZoneCount ) break;
		vec3 r = daZoneR[ i ];
		vec4 zp = daZoneP[ i ];
		float e = zp.x;
		vec3 q = abs( p - daZoneC[ i ] ) / r;
		float rmin = min( r.x, min( r.y, r.z ) );
		float k = max( zp.y * 0.5, px * 0.75 );
		// early out: for e >= 1 the distance below is at least (max(q) - 1) * rmin / sqrt(3)
		if ( e >= 1.0 && ( max( q.x, max( q.y, q.z ) ) - 1.0 ) * rmin > 2.0 * k ) continue;
		q = max( q, vec3( 0.0001 ) );
		vec3 qe = pow( q, vec3( e ) );
		float S = qe.x + qe.y + qe.z;
		float Sc = max( S, 1e-12 );
		float s = pow( Sc, 1.0 / e );                                       // 1 on the zone's skin
		float g = pow( Sc, 1.0 / e - 1.0 ) * length( qe / q / r );          // |grad s|
		float d = S < 1e-12 ? - rmin : ( s - 1.0 ) / max( g, 1e-9 );       // approx. distance, object units
		float w = 1.0 - smoothstep( - k, k, d );
		int ti = clamp( int( zp.z + 0.5 ), 0, DA_TONES - 1 );
		vec3 tc = daTones[ ti ];
		col = mix( col, tc, w );
		zoneCol = mix( zoneCol, tc, w );
		wAll = wAll + w * ( 1.0 - wAll );
		if ( ti == 6 ) wScreen = max( wScreen, w );
	}
	return col;
}
`;

// Interleaved gradient noise (Jimenez 2014): a screen-space dither for the strand cut-out.
const GLSL_IGN = `
float daIGN( vec2 px ) {
	return fract( 52.9829189 * fract( dot( px, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

// Wrapped diffuse (soft terminator) replacing RE_Direct. With fur it also adds a velvet rim from
// each direct light. Inserted right after lights_physical_pars_fragment, where RE_Direct is defined.
function glslWrap(wrap, tint, fur) {
  return `
// ---- [da:wrap] wrapped diffuse: a soft, subsurface-like terminator${fur ? ' + fur rim from direct lights' : ''} ----
void RE_Direct_DaWrap( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	float daNL = dot( geometryNormal, directLight.direction );
	float daWrapT = saturate( ( daNL + ${f(wrap)} ) / ${f(1 + wrap)} ) - saturate( daNL );
	reflectedLight.directDiffuse += daWrapT * directLight.color * BRDF_Lambert( material.diffuseContribution ) * ${v3(tint)};${fur ? `
	float daNVd = saturate( dot( geometryNormal, geometryViewDir ) );
	reflectedLight.directSpecular += directLight.color * daSheenTintG * ( pow( 1.0 - daNVd, 3.0 ) * saturate( daNL + 0.6 ) * daFurSheen * 0.5 );` : ''}
}
#undef RE_Direct
#define RE_Direct RE_Direct_DaWrap
`;
}

/* ---- GLSL: body (MeshPhysicalMaterial) ------------------------------------------------- */

function bodyVertex(src) {
  src = inject(src, '#include <common>', `
// ==== [da:body-vert] object-space varyings for paint zones and procedural detail ====
attribute vec2 surf;   // from mesher.js: x = ambient occlusion (1 = open), y = curvature (+ = convex)
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec2 vSurf;`, 'after', 'body vertex declarations');
  src = inject(src, '#include <begin_vertex>', `
	// [da:body-vert-main]
	vObjPos = position;
	vObjNrm = normal;
	vSurf = surf;`, 'after', 'body vertex varyings');
  return src;
}

// Glaze pooling, shared by ceramic and crackle.
const GLAZE_POOL = `
	// glaze: pools deeper and more saturated where occluded or concave, thins on convex edges
	float daPool = clamp( ( 1.0 - clamp( vSurf.x, 0.0, 1.0 ) ) * 1.7 + max( - daCurv, 0.0 ) * 1.2, 0.0, 1.0 );
	daPool = daPool * daPool * ( 3.0 - 2.0 * daPool );
	float daLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 daDeep = max( mix( vec3( daLum ), diffuseColor.rgb, 1.4 ), vec3( 0.0 ) ) * 0.6;
	diffuseColor.rgb = mix( diffuseColor.rgb, daDeep, daPool * 0.8 );
	float daEdge = smoothstep( 0.15, 0.6, daCurv );
	diffuseColor.rgb = mix( diffuseColor.rgb, mix( diffuseColor.rgb, vec3( 0.80, 0.72, 0.60 ), 0.5 ), daEdge * 0.55 );
	diffuseColor.rgb *= 1.0 + 0.035 * daSimplex( daP * 3.0 );
	daRoughOff -= 0.06 * daPool;
	daGlazeH = daSimplex( daP * 9.0 ) * 0.0012 + daSimplex( daP * 23.0 ) * 0.0004;`;

function crackleDetail(C) {
  return `${GLAZE_POOL}
	// crackle: craquelure in the glaze. A coarse crack network plus a finer one that shows only in
	// patches (so cell sizes vary), both in gently warped object space so the lines wander a little.
	// Cracks are a little darker, duller and sunk into the glaze; very dark bodies get pale cracks.
	vec3 daNo = normalize( vObjNrm );
	vec3 daCw = daP + vec3( daSimplex( daP * ${f(C.warpF)} ), daSimplex( daP * ${f(C.warpF)} + 19.7 ), daSimplex( daP * ${f(C.warpF)} + 41.3 ) ) * ${f(C.warp)};
	float daCv1;
	float daCv2;
	float daCd1 = daCrackDist( daCw, daNo, ${f(C.s1)}, daCv1 );
	float daCd2 = daCrackDist( daCw, daNo, ${f(C.s2)}, daCv2 );
	float daCaa = max( daPx * 0.5, 0.00002 );                           // half a pixel, object units
	float daCrackA = daLineCov( daCd1, ${f(C.w1)}, daCaa ) * daCv1;
	float daCrackB = daLineCov( daCd2, ${f(C.w2)}, daCaa ) * daCv2 * smoothstep( 0.35, 0.65, daValueNoise( daP * ${f(C.maskF)} + 3.7 ) );
	float daCrack = max( daCrackA, daCrackB * ${f(C.fine)} ) * ( 1.0 - daScreenW );
	float daCrackLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 daCrackCol = mix( mix( diffuseColor.rgb, vec3( 0.66, 0.63, 0.58 ), ${f(C.pale)} ), diffuseColor.rgb * ${f(C.dark)}, smoothstep( 0.012, 0.045, daCrackLum ) );
	diffuseColor.rgb = mix( diffuseColor.rgb, daCrackCol, daCrack * ${f(C.mix)} );
	daRoughOff += 0.2 * daCrack;
	daCoatK = 1.0 - ${f(C.dull)} * daCrack;
	daGlazeH -= daCrack * ${f(C.groove)};`;
}

function glitterDetail(F) {
  const top = F.lod0 * Math.pow(2, F.lodMax);   // footprint (level-0 cells) where the coarsest level is reached
  return `
	// glitter: a body-colored base with tiny mirror flakes under a semi-gloss clear coat. Each flake
	// is tilted at random, so it flashes when its mirror lines up with a light or a bright part of
	// the studio, and other flakes flash as the view turns ([da:glint], [da:glint-env]).
	// Level of detail (trap 12): two lattice levels, each doubling the cell size, picked so a flake
	// spans about three pixels or more; the stronger of the two wins per pixel, its glint scaled by
	// its level weight. Past the coarsest level the flakes fade into their average shimmer.
	vec3 daNo = normalize( vObjNrm );
	float daFpx = daPx * ${f(F.cells)};                                  // pixel footprint in level-0 cells
	float daFlod = clamp( log2( max( daFpx, 0.000001 ) / ${f(F.lod0)} ), 0.0, ${f(F.lodMax)} );
	float daFla = floor( daFlod );
	float daFlt = daFlod - daFla;
	float daCellsA = ${f(F.cells)} * exp2( - daFla );
	vec3 daTiltA;
	vec3 daTintA;
	vec3 daTiltB;
	vec3 daTintB;
	float daWa = daFlakeLayer( daP, daNo, daCellsA, daPx, diffuseColor.rgb, daTiltA, daTintA );
	float daWb = daFlakeLayer( daP, daNo, daCellsA * 0.5, daPx, diffuseColor.rgb, daTiltB, daTintB );
	float daPickA = step( daWb * daFlt, daWa * ( 1.0 - daFlt ) );
	float daFvis = 1.0 - smoothstep( ${f(top)}, ${f(top * 2)}, daFpx );
	float daFnot = 1.0 - daScreenW;                                      // no glitter on the robot screen
	float daFcov = mix( daWb, daWa, daPickA ) * daFvis * daFnot;
	float daFgain = mix( daFlt, 1.0 - daFlt, daPickA );
	vec3 daFtint = mix( daTintB, daTintA, daPickA );
	vec3 daFavg = mix( mix( diffuseColor.rgb, vec3( 1.0 ), 0.5 ), vec3( 0.95 ), 0.18 );
	vec3 daFlakeTilt = mix( daTiltB, daTiltA, daPickA ) * daFcov;
	daFlakeF = daFtint * ( daFcov * daFgain ) + daFavg * ( 0.2 * ( 1.0 - daFvis ) * daFnot );
	daFlakeA = mix( ${f(F.haze)}, ${f(F.rough * F.rough)}, daFvis );
	diffuseColor.rgb = mix( diffuseColor.rgb, daFtint, daFcov * ${f(F.lift)} );   // flakes read faintly when not flashing`;
}

// Per-finish detail, inserted in the color stage. Locals available: daP (object position),
// daPx (pixel footprint), daAO, daCurv, daPaintW, daScreenW, daPaintCol. Writes diffuseColor.rgb,
// daRoughOff (added to roughness), daHeight (bump height, object units), daGlazeH, daIriT, daCoatK.
const FINISH_DETAIL = {
  clay: `
	// clay: shallow thumb dents (a continuous field of round dimples), rare fingerprint whorls,
	// faint vertical tool streaks
	float daDent = min( daBumpField( daP * 5.5, 0.8, 0.65 ), 1.0 );
	float daFpId;
	vec4 daV2 = daVoronoi( daP * 2.3, daFpId );
	float daFpR = daV2.w / 2.3;
	float daFpPh = daFpR * 560.0 + daFpId * 6.2831853;
	float daFpFade = 1.0 - smoothstep( 1.2, 2.6, fwidth( daFpPh ) );
	float daFp = sin( daFpPh ) * ( 1.0 - smoothstep( 0.035, 0.07, daFpR ) ) * step( daFpId, 0.22 ) * daFpFade;
	float daStreak = daValueNoise( vec3( daP.x * 60.0, daP.y * 6.0, daP.z * 60.0 ) ) - 0.5;
	daHeight = - daDent * 0.006 + daFp * 0.00045 + daStreak * 0.0009;
	diffuseColor.rgb *= ( 0.97 + 0.06 * daValueNoise( daP * 4.0 ) ) * ( 1.0 - 0.06 * daDent );
	daRoughOff += 0.06 * daDent + 0.05 * ( daValueNoise( daP * 11.0 ) - 0.5 );`,
  ceramic: `
	// ceramic: a smooth glaze${GLAZE_POOL}`,
  crackle: crackleDetail(SURFACE.crackle.crack),
  speckled: `
	// speckled stoneware: round fine specks of varied size plus sparse larger iron spots
	// (cellular spots, so specks are round, not lattice-aligned), rough with variation
	float daSpkId;
	vec4 daVf = daVoronoi( daP * 38.0, daSpkId );
	float daAa1 = max( fwidth( daVf.w ), 0.0001 );
	float daSpkR = 0.07 + 0.13 * fract( daSpkId * 7.31 );
	float daSpk = ( 1.0 - smoothstep( daSpkR - daAa1, daSpkR + daAa1, daVf.w ) ) * step( 0.45, daSpkId );
	float daSpotId;
	vec4 daVs = daVoronoi( daP * 9.0, daSpotId );
	float daAa2 = max( fwidth( daVs.w ), 0.0001 );
	float daSpotR = 0.06 + 0.06 * fract( daSpotId * 3.77 );
	float daSpot = ( 1.0 - smoothstep( daSpotR - daAa2, daSpotR + daAa2, daVs.w ) ) * step( 0.78, daSpotId );
	float daS = max( daSpk, daSpot );
	vec3 daSpeckCol = vec3( 0.045, 0.035, 0.03 ) + diffuseColor.rgb * 0.12;
	diffuseColor.rgb = mix( diffuseColor.rgb, daSpeckCol, daS * 0.85 );
	diffuseColor.rgb *= 0.95 + 0.08 * daValueNoise( daP * 6.0 );
	daRoughOff += 0.16 * ( daValueNoise( daP * 9.0 ) - 0.5 ) + 0.1 * daS;
	daHeight = - daS * 0.0015 + ( daValueNoise( daP * 40.0 ) - 0.5 ) * 0.0012;`,
  pearl: `
	// pearl: pale lift, nacre thin-film thickness varies over the surface
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), 0.10 );
	daIriT = clamp( 0.5 + 0.45 * daSimplex( daP * 2.2 ) + 0.2 * daCurv, 0.0, 1.0 );
	daHeight = daSimplex( daP * 14.0 ) * 0.0005;`,
  rubber: `
	// soft-touch rubber: fine grain in roughness and height
	daRoughOff += 0.06 * ( daValueNoise( daP * 40.0 ) - 0.5 );
	daHeight = ( daValueNoise( daP * 70.0 ) - 0.5 ) * 0.0004;`,
  vinyl: `
	// vinyl: smooth molded toy plastic, AO only`,
  glitter: glitterDetail(SURFACE.glitter.flake),
  jelly: `
	// jelly: transmission is tinted per zone and thinned toward the silhouette (transmission stage)`,
  glass: `
	// glass: as jelly, with a lighter tint`,
  chrome: `
	// chrome: tiny roughness variation so reflections are not perfectly sterile
	daRoughOff += 0.04 * ( daValueNoise( daP * 8.0 ) - 0.5 );`
};

function bodyFragment(THREE, src, id) {
  const S = SURFACE[id];
  const detail = FINISH_DETAIL[id] || '';
  if (S.wrap && S.flake) throw new Error('[dot-avatar materials] finish "' + id + '": wrap and glint both remap RE_Direct (trap 13)');
  const usesNoise = /daValueNoise|daSimplex|daVoronoi|daBumpField/.test(detail);
  const usesCrack = /daCrackDist|daLineCov/.test(detail);
  const usesFlake = !!S.flake;
  const usesHash = usesNoise || usesCrack || usesFlake;
  const usesBump = !!S.bump || !!S.glaze;
  src = inject(src, '#include <common>', `
// ==== [da:body-frag] dot avatar body, finish: ${id} ====
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec2 vSurf;
${usesFlake ? GLSL_NORMAL_MATRIX : ''}${usesHash ? GLSL_HASH : ''}${usesNoise ? GLSL_NOISE : ''}${usesCrack ? GLSL_CRACK : ''}${usesFlake ? glslFlake(S.flake) : ''}${usesBump ? GLSL_BUMP : ''}${GLSL_PAINT}`, 'after', 'body fragment declarations');

  src = inject(src, '#include <color_fragment>', `
	// ---- [da:color] paint zones + finish detail (${id}) ----
	vec3 daP = vObjPos;
	float daPx = length( fwidth( vObjPos ) );
	float daAO = mix( 1.0, clamp( vSurf.x, 0.0, 1.0 ), ${f(S.ao)} );
	float daCurv = clamp( vSurf.y, -1.0, 1.0 );
	float daPaintW;
	float daScreenW;
	vec3 daPaintCol;
	diffuseColor.rgb = daPaint( daP, diffuseColor.rgb, daPx, daPaintW, daScreenW, daPaintCol );
	float daRoughOff = - 0.3 * daScreenW;   // the robot screen zone reads as glossy glass
	float daHeight = 0.0;
	float daGlazeH = 0.0;
	float daIriT = 0.5;
	float daCoatK = 1.0;   // clear coat kept (crackle thins it inside cracks)${detail}`, 'after', 'body color stage');

  src = inject(src, '#include <roughnessmap_fragment>', `
	// [da:roughness]
	roughnessFactor = clamp( roughnessFactor + daRoughOff, 0.03, 1.0 );`, 'after', 'body roughness');

  if (S.bump) {
    src = inject(src, '#include <normal_fragment_maps>', `
	// [da:bump-apply]
	normal = daBumpNormal( - vViewPosition, normal, daHeight );`, 'after', 'body bump');
  }
  if (S.flake) {
    src = inject(src, '#include <normal_fragment_maps>', FLAKE_NORMAL, 'after', 'glitter flake normal');
  }
  if (S.glaze) {
    src = inject(src, '#include <clearcoat_normal_fragment_begin>', `
	// [da:glaze-ripple] a glaze surface is never perfectly flat (crackle: it also dips into the cracks)
	#ifdef USE_CLEARCOAT
		clearcoatNormal = daBumpNormal( - vViewPosition, clearcoatNormal, daGlazeH );
	#endif`, 'after', id + ' glaze ripple');
  }
  if (id === 'pearl') {
    src = inject(src, '#include <lights_physical_fragment>', `
	// [da:nacre] vary the thin-film thickness between the min and max of iridescenceThicknessRange
	#ifdef USE_IRIDESCENCE
		material.iridescenceThickness = mix( iridescenceThicknessMinimum, iridescenceThicknessMaximum, daIriT );
	#endif`, 'after', 'pearl nacre');
  }
  if (S.crack) {
    src = inject(src, '#include <lights_physical_fragment>', CRACKLE_COAT, 'after', 'crackle coat');
  }
  if (S.wrap) {
    src = inject(src, '#include <lights_physical_pars_fragment>', glslWrap(S.wrap, S.wrapTint || [1, 1, 1], false), 'after', 'body wrap lighting');
  }
  if (S.flake) {
    src = inject(src, '#include <lights_physical_pars_fragment>', GLSL_GLINT, 'after', 'glitter glint lobe');
    src = inject(src, '#include <lights_fragment_end>', FLAKE_ENV, 'after', 'glitter env glints');
  }

  src = inject(src, '#include <aomap_fragment>', `
	// ---- [da:ao] baked ambient occlusion (surf.x) and crevice darkening (surf.y) ----
	{
		float daNVo = saturate( dot( geometryNormal, geometryViewDir ) );
		float daCav = 1.0 - ${f(S.cavity)} * smoothstep( 0.0, 0.7, - daCurv );
		reflectedLight.indirectDiffuse *= daAO * daCav;
		reflectedLight.directDiffuse *= mix( 1.0, daAO, ${f(S.aoDirect)} ) * mix( 1.0, daCav, 0.6 );
		float daSpecOcc = computeSpecularOcclusion( daNVo, daAO, material.roughness );
		reflectedLight.indirectSpecular *= daSpecOcc;
		#ifdef USE_CLEARCOAT
			clearcoatSpecularIndirect *= daSpecOcc;
		#endif
		#ifdef USE_SHEEN
			sheenSpecularIndirect *= daAO;
		#endif
	}`, 'after', 'body ambient occlusion');

  if (TRANSMISSIVE[id]) {
    // Inline three's transmission chunk with three edits: painted zones transmit less (they read
    // as opaque candy paint), the absorption tint follows the zones, and the path is thinner
    // toward the silhouette (a sphere's chord is short at grazing angles), deeper in the middle.
    let chunk = THREE.ShaderChunk.transmission_fragment;
    chunk = inject(chunk, 'material.transmission = transmission;',
      'material.transmission = transmission * ( 1.0 - 0.65 * daPaintW );', 'replace', 'transmission per zone');
    chunk = inject(chunk, 'material.thickness = thickness;',
      'material.thickness = thickness * mix( 0.3, 1.0, saturate( dot( normal, normalize( vViewPosition ) ) ) );', 'replace', 'transmission thickness');
    chunk = inject(chunk, 'material.attenuationColor = attenuationColor;',
      'material.attenuationColor = mix( attenuationColor, daPaintCol, daPaintW );', 'replace', 'transmission tint');
    // On a transparent canvas nothing opaque is behind the body (props are transparent, trap 9;
    // the ground is a ShadowMaterial), so three's transmission buffer holds only the clear color
    // and glass would show just its highlights. Fill that missing backdrop with the studio
    // environment seen along the refracted ray, tinted by the same absorption.
    chunk = inject(chunk, 'material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );', `
	// [da:backdrop] refracted studio where the transmission buffer was empty
	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
	{
		vec3 daMS = vec3( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ), length( modelMatrix[ 2 ].xyz ) );
		float daPath = material.thickness * dot( daMS, vec3( 1.0 / 3.0 ) );
		vec3 daAtt = material.diffuseContribution * volumeAttenuation( daPath, material.attenuationColor, material.attenuationDistance );
		float daAttAvg = max( ( daAtt.r + daAtt.g + daAtt.b ) / 3.0, 0.05 );
		// three returns alpha = 1 - (1 - backdrop alpha) * transmittance: recover the empty part
		float daGap = saturate( ( 1.0 - transmitted.a ) / daAttAvg );
		vec3 daRay = refract( - v, n, 1.0 / material.ior );
		vec3 daEnvT = textureCubeUV( envMap, envMapRotation * daRay, max( material.roughness, 0.1 ) ).rgb * envMapIntensity;
		transmitted.rgb += daGap * 0.96 * daAtt * daEnvT;
		transmitted.a = mix( transmitted.a, 1.0, daGap );
	}
	#endif`, 'before', 'transmission backdrop');
    src = inject(src, '#include <transmission_fragment>', '\t// ---- [da:transmission] three\'s transmission_fragment, edited ----\n' + chunk, 'replace', 'body transmission');
  }
  return src;
}

// Body under fur: depth (and shadow) only. The fragment stage does nothing (trap 7).
const DEPTH_ONLY_FRAGMENT = `
// ==== [da:depth-only] body under fur: writes depth and casts the shadow; the shells draw color ====
void main() {
	gl_FragColor = vec4( 0.0 );
}
`;

/* ---- GLSL: fur shells (MeshStandardMaterial + InstancedBufferGeometry) ------------------ */

const FUR_VERTEX_DECL = `
// ==== [da:fur-vert] instanced shell fur: one instance per shell, instance 0 = outermost ====
attribute float furLayer;   // per instance: 1 = tip shell ... 0 = skin shell
attribute vec2 surf;        // x = ambient occlusion (1 = open), y = curvature
attribute vec4 furTone0;    // per-vertex paint weights: cream, pink, dark, light
attribute vec4 furTone1;    // orange, white, screen, leaf
uniform float daFurLen;     // object units
uniform vec3 daGravity;     // object space, scaled by strength
uniform vec3 daWind;        // object space, scaled by strength
uniform float daTime;
uniform float daMotion;     // 0..1, idle motion amount
uniform int daTrimCount;
uniform vec4 daTrim[ ${MAX_TRIMS} ];      // xyz = center (object space), w = radius
uniform vec3 daTones[ ${NT} ];             // cream, pink, dark, light, orange, white, screen, leaf
uniform vec3 daFurBase;     // linear body color
varying vec3 vObjPos;       // ROOT position: strands are hashed here so they never swim
varying vec3 vObjNrm;
varying vec2 vSurf;
varying float vFurH;        // 0 at the skin, 1 at the tips
varying vec3 vFurCol;
// fur gets short inside trim spheres (eyes, mouth, nose, under a hat brim)
float daTrimScale( vec3 p ) {
	float s = 1.0;
	for ( int i = 0; i < ${MAX_TRIMS}; i ++ ) {
		if ( i >= daTrimCount ) break;
		vec4 t = daTrim[ i ];
		float d = length( p - t.xyz );
		s = min( s, mix( 0.12, 1.0, smoothstep( t.w * 0.55, t.w * 1.2, d ) ) );
	}
	return s;
}
// shell offset for root p with unit normal n at height h (0..1), strand length len
vec3 daFurOffset( vec3 p, vec3 n, float h, float len ) {
	vec3 off = n * ( h * len );
	float h2 = h * h;
	// gravity: tips droop along the surface, and fur on top flattens a little
	float gn = dot( daGravity, n );
	vec3 gt = daGravity - n * gn;
	off += ( gt + n * min( gn, 0.0 ) * 0.3 ) * ( h2 * len );
	// wind: two detuned sines with a spatial phase so strands do not move in lockstep
	float ph = dot( p, vec3( 6.1, 3.7, 4.9 ) );
	float sway = sin( daTime * 1.7 + ph ) * 0.6 + sin( daTime * 2.9 + ph * 1.7 ) * 0.4;
	vec3 wt = daWind - n * dot( daWind, n );
	off += wt * ( sway * h2 * len * daMotion );
	// never let a shell sink below a quarter of its rest height
	float up = dot( off, n );
	off += n * max( 0.0, 0.25 * h * len - up );
	return off;
}`;

const FUR_VERTEX_NORMAL = `
	// [da:fur-vert-normal] offset the shell, bend the shading normal toward the strand direction
	vec3 daN = normalize( normal );
	float daLen = daFurLen * daTrimScale( position );
	vec3 daOff = daFurOffset( position, daN, furLayer, daLen );
	objectNormal = normalize( daN + ( daOff - daN * dot( daOff, daN ) ) * ( 0.6 / max( daLen, 0.0001 ) ) );`;

const FUR_VERTEX_MAIN = `
	// [da:fur-vert-main]
	transformed = position + daOff;
	vObjPos = position;
	vObjNrm = daN;
	vSurf = surf;
	vFurH = furLayer;
	// paint zones, folded on the CPU into tone weights (zones apply in order, later over earlier)
	float daBaseW = 1.0 - dot( furTone0, vec4( 1.0 ) ) - dot( furTone1, vec4( 1.0 ) );
	vFurCol = daFurBase * max( daBaseW, 0.0 )
		+ daTones[ 0 ] * furTone0.x + daTones[ 1 ] * furTone0.y + daTones[ 2 ] * furTone0.z + daTones[ 3 ] * furTone0.w
		+ daTones[ 4 ] * furTone1.x + daTones[ 5 ] * furTone1.y + daTones[ 6 ] * furTone1.z + daTones[ 7 ] * furTone1.w;`;

function furFragmentDecl(P) {
  const coverage = P.mode === 1 ? `
// felt: matted fuzz, two octaves of 3D value noise over the ROOT position, thresholded by height
float daFurCoverage( vec3 p, vec3 n, float h, out float rnd ) {
	vec3 q = p * daFurDensity;
	float v = daValueNoise( q ) * 0.62 + daValueNoise( q * 2.71 + vec3( 17.0 ) ) * 0.38;
	rnd = daValueNoise( q * 0.23 + vec3( 5.0 ) );
	float lo = 0.12 + h * 0.8;
	float aa = clamp( fwidth( v ), 0.001, 0.2 );
	return smoothstep( lo - aa, lo + aa, v );
}` : `
// strands on a cube-mapped lattice: the ROOT position is projected on the plane of its dominant
// normal axis (the choice is dithered in 2x2-cell blocks so the six seams are ragged, not lines),
// one fully jittered strand per 2D cell, nearest of the 2x2 closest cells (exact for radius <= 0.5).
// A 3D lattice sliced by the surface would make the strands thick and thin in concentric rings.
float daFurCoverage( vec3 p, vec3 n, float h, out float rnd ) {
	// cheap arithmetic hash for the seam dither (the strands themselves use daHash33)
	vec3 dc = floor( p * ( daFurDensity * 0.5 ) );
	vec3 dj = fract( vec3( dot( dc, vec3( 0.1031, 0.1137, 0.1379 ) ), dot( dc, vec3( 0.1173, 0.1301, 0.0973 ) ), dot( dc, vec3( 0.1409, 0.0917, 0.1237 ) ) ) * 97.13 );
	vec3 an = abs( n ) + ( dj - 0.5 ) * 0.14;
	float ax = step( an.y, an.x ) * step( an.z, an.x );
	float ay = ( 1.0 - ax ) * step( an.z, an.y );
	float az = 1.0 - ax - ay;
	vec2 uv = p.yz * ax + p.zx * ay + p.xy * az;
	float face = ax * ( n.x < 0.0 ? 1.0 : 0.0 ) + ay * ( n.y < 0.0 ? 3.0 : 2.0 ) + az * ( n.z < 0.0 ? 5.0 : 4.0 );
	vec2 q = uv * daFurDensity;
	float aa = clamp( 0.5 * length( fwidth( q ) ), 0.001, 0.25 );   // before any early return
	rnd = 0.5;
	// dense undercoat: nothing to search (h is the same for a whole shell, so this is quad-uniform)
	if ( h < daFurUnder ) return 1.0;${P.clump > 0 ? `
	// clumps: strands lean toward the nearest jittered clump center as they rise (inverse mapping
	// of the lean). Cellular over the 2x2 nearest clump cells, so partings are irregular lines.
	vec2 daCq = q * 0.2;
	vec2 daCi = floor( daCq - 0.5 );
	vec2 daCenter = daCq;
	float daCBest = 9.0;
	for ( int cj = 0; cj < 2; cj ++ ) {
		for ( int ci = 0; ci < 2; ci ++ ) {
			vec2 cc = daCi + vec2( float( ci ), float( cj ) );
			vec2 ctr = cc + 0.5 + ( daHash33( vec3( cc, face * 4096.0 + 2048.0 ) ).xy - 0.5 ) * 0.6;
			vec2 dv = ctr - daCq;
			float d2 = dot( dv, dv );
			if ( d2 < daCBest ) {
				daCBest = d2;
				daCenter = ctr;
			}
		}
	}
	daCenter /= 0.2;
	q = daCenter + ( q - daCenter ) / ( 1.0 - daFurClump * h );
	aa = min( aa / ( 1.0 - daFurClump * h ), 0.25 );` : ''}
	vec2 base = floor( q - 0.5 );
	float best = 9.0;
	vec3 bestH = vec3( 0.5 );
	for ( int j = 0; j < 2; j ++ ) {
		for ( int i = 0; i < 2; i ++ ) {
			vec2 cell = base + vec2( float( i ), float( j ) );
			vec3 hr = daHash33( vec3( cell, face * 4096.0 ) );
			vec2 c = cell + 0.5 + ( hr.xy - 0.5 ) * daFurJitter;
			float len = 1.0 - daFurLenVar * hr.z;                    // per-strand length
			float t = min( h / len, 1.0 );
			float radius = daFurThick * ( 1.0 - 0.8 * t * t );      // taper toward the tip
			float dd = h > len ? 9.0 : length( q - c ) - radius;    // signed distance to the strand edge
			if ( dd < best ) {
				best = dd;
				bestH = hr;
			}
		}
	}
	rnd = fract( bestH.x * 7.31 + bestH.y * 3.17 + bestH.z * 1.13 );
	return 1.0 - smoothstep( - aa, aa, best );
}`;
  return `
// ==== [da:fur-frag] shell fur: strands, stochastic cut-out, root darkening, rim sheen ====
#define DA_FUR 1
uniform float daFurDensity;
uniform float daFurThick;
uniform float daFurJitter;
uniform float daFurLenVar;
uniform float daFurUnder;
uniform float daFurClump;
uniform float daFurRootDark;
uniform float daFurTipLift;
uniform float daFurSheen;
uniform float daFurColorNoise;
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec2 vSurf;
varying float vFurH;
varying vec3 vFurCol;
vec3 daSheenTintG;   // set in main(), read by RE_Direct_DaWrap
${GLSL_HASH}${GLSL_NOISE}${GLSL_IGN}${coverage}
`;
}

const FUR_FRAGMENT_COLOR = `
	// ---- [da:fur-color] strand coverage, stochastic cut-out and color ----
	float daH = vFurH;
	float daAO = mix( 1.0, clamp( vSurf.x, 0.0, 1.0 ), 0.9 );
	float daRnd;
	float daCov = daFurCoverage( vObjPos, normalize( vObjNrm ), daH, daRnd );   // derivatives happen here, before the discard
	daCov = max( daCov, 1.0 - smoothstep( 0.0, daFurUnder, daH ) );   // dense undercoat near the skin
	vec3 daCol = vFurCol * ( 1.0 - 0.5 * daFurColorNoise + daFurColorNoise * daRnd );
	daCol *= 1.0 + daFurTipLift * smoothstep( 0.35, 1.0, daH );
	float daThr = 0.5 + ( daIGN( gl_FragCoord.xy + vec2( daH * 97.0, daH * 61.0 ) ) - 0.5 ) * 0.5;
	if ( daH > 0.0005 && daCov < daThr ) discard;               // the skin shell (h = 0) never cuts out
	diffuseColor.rgb = daCol;
	daSheenTintG = mix( daCol, vec3( 1.0 ), 0.45 );`;

const FUR_FRAGMENT_LIGHT = `
	// ---- [da:fur-light] self-shadowing toward the roots + velvet rim sheen from the environment ----
	{
		float daOcc = mix( daFurRootDark, 1.0, pow( daH, 0.8 ) ) * daAO;
		reflectedLight.directDiffuse *= daOcc;
		reflectedLight.indirectDiffuse *= daOcc;
		reflectedLight.directSpecular *= daOcc;
		reflectedLight.indirectSpecular *= daOcc;
		float daNVr = saturate( dot( geometryNormal, geometryViewDir ) );
		float daRimT = pow( 1.0 - daNVr, 3.0 ) * smoothstep( 0.1, 1.0, daH );
		reflectedLight.indirectSpecular += daSheenTintG * ( daRimT * daFurSheen * daAO ) * ( irradiance + iblIrradiance ) * RECIPROCAL_PI;
	}`;

/* ---- GLSL: accessory and face details --------------------------------------------------- */

const ACC_VERTEX_DECL = `
// ==== [da:acc-vert] object-space position and uv for procedural detail ====
varying vec3 vObjPos;
varying vec2 vDaUv;`;
const ACC_VERTEX_MAIN = `
	// [da:acc-vert-main]
	vObjPos = position;
	vDaUv = uv;`;

const ACC_DETAIL = {
  knit: `
	// ---- [da:knit] ribbed stitches around the local y axis, grooves a little darker ----
	vec3 daP = vObjPos;
	float daAng = atan( daP.z, daP.x + 0.000001 );
	float daRib = 0.5 + 0.5 * cos( daAng * 56.0 );
	float daRowPh = daP.y * 240.0;
	float daRowFade = 1.0 - smoothstep( 0.5, 1.5, fwidth( daRowPh ) );
	float daRow = 0.5 + 0.5 * cos( daRowPh );
	float daHeight = daRib * ( 0.65 + 0.35 * mix( 0.5, daRow, daRowFade ) ) * 0.0035;
	diffuseColor.rgb *= 0.86 + 0.14 * daRib;`,
  straw: `
	// ---- [da:straw] woven strips in polar coordinates around the local y axis ----
	vec3 daP = vObjPos;
	float daAng = atan( daP.z, daP.x + 0.000001 );
	float daU = daAng * 40.0;
	float daV = length( daP.xz ) * 70.0 + daP.y * 70.0;
	float daWeave = sin( daU ) * sin( daV );
	float daWFade = 1.0 - smoothstep( 0.6, 1.6, max( fwidth( daU ), fwidth( daV ) ) );
	float daHeight = daWeave * 0.0025 * daWFade;
	diffuseColor.rgb *= 0.9 + 0.1 * daWeave * daWFade + 0.06 * ( daValueNoise( daP * 30.0 ) - 0.5 );`,
  felt: `
	// ---- [da:felt] fuzzy micro height and soft color mottling ----
	vec3 daP = vObjPos;
	float daN = daValueNoise( daP * 90.0 ) * 0.6 + daValueNoise( daP * 210.0 ) * 0.4;
	float daHeight = ( daN - 0.5 ) * 0.0015;
	diffuseColor.rgb *= 0.93 + 0.12 * daValueNoise( daP * 12.0 );`,
  leather: `
	// ---- [da:leather] pebbled grain: shallow rounded cells with soft grooves, faint mottling; the
	// grain fades out once a cell gets smaller than about two pixels ----
	vec3 daP = vObjPos;
	float daLfade = 1.0 - smoothstep( 0.3, 0.8, length( fwidth( daP ) ) * 110.0 );
	float daLid;
	vec4 daLv = daVoronoi( daP * 110.0, daLid );
	float daPebble = 1.0 - smoothstep( 0.25, 0.75, daLv.w );
	float daHeight = ( daPebble - 0.5 ) * 0.0005 * daLfade;
	diffuseColor.rgb *= ( 0.95 + 0.07 * daValueNoise( daP * 9.0 ) ) * ( 1.0 - ( 0.05 * ( 1.0 - daPebble ) - 0.02 * ( daLid - 0.5 ) ) * daLfade );`,
  terry: `
	// ---- [da:terry] looped pile: a dense, even field of tiny soft loops, very matte; the sheen
	// adds the fuzz. Loops smaller than about two pixels fade into their average (0.25) ----
	vec3 daP = vObjPos;
	float daTfade = 1.0 - smoothstep( 0.35, 0.9, length( fwidth( daP ) ) * 95.0 );
	float daLoops = daLoopField( daP * 95.0, 0.72, 0.4 );
	float daHeight = ( daLoops - 0.25 ) * 0.001 * daTfade;
	diffuseColor.rgb *= mix( 0.895, 0.86 + 0.14 * daLoops, daTfade ) + 0.04 * ( daValueNoise( daP * 13.0 ) - 0.5 );`,
  feather: `
	// ---- [da:feather] faint barbs: fine wavy lines slanting up and outward on both sides of the
	// local y axis, like the vanes beside a feather's shaft; they fade before they can alias ----
	vec3 daP = vObjPos;
	float daBph = ( abs( daP.x ) * 0.75 - daP.y ) * 260.0 + 2.0 * daValueNoise( daP * 40.0 );
	float daBfade = 1.0 - smoothstep( 0.6, 1.6, fwidth( daBph ) );
	float daBarb = ( 0.5 + 0.5 * cos( daBph ) ) * daBfade;
	float daHeight = ( daBarb - 0.5 * daBfade ) * 0.0003;
	diffuseColor.rgb *= 0.97 + 0.03 * daBarb + 0.03 * ( daValueNoise( daP * 18.0 ) - 0.5 );`
};

const BLUSH_DETAIL = `
	// ---- [da:blush] soft round edge from the disc uv (CircleGeometry: center 0.5, radius 0.5) ----
	diffuseColor.a *= 1.0 - smoothstep( 0.16, 0.5, length( vDaUv - vec2( 0.5 ) ) );`;

function detailCompile(detail, label, withBump) {
  return function (shader) {
    shader.vertexShader = inject(shader.vertexShader, '#include <common>', ACC_VERTEX_DECL, 'after', label + ' vertex declarations');
    shader.vertexShader = inject(shader.vertexShader, '#include <begin_vertex>', ACC_VERTEX_MAIN, 'after', label + ' vertex varyings');
    shader.fragmentShader = inject(shader.fragmentShader, '#include <common>', `
// ==== [da:acc-frag] ${label} ====
varying vec3 vObjPos;
varying vec2 vDaUv;
${withBump ? GLSL_HASH + GLSL_NOISE + GLSL_BUMP : ''}${withBump && detail.indexOf('daLoopField(') >= 0 ? GLSL_LOOPS : ''}`, 'after', label + ' fragment declarations');
    shader.fragmentShader = inject(shader.fragmentShader, '#include <color_fragment>', detail, 'after', label + ' color');
    if (withBump) {
      shader.fragmentShader = inject(shader.fragmentShader, '#include <normal_fragment_maps>', `
	// [da:acc-bump-apply]
	normal = daBumpNormal( - vViewPosition, normal, daHeight );`, 'after', label + ' bump');
    }
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Factory                                                                                      */
/* ------------------------------------------------------------------------------------------ */

function makeCache(limit) {
  const map = new Map();
  return {
    get(key) {
      const v = map.get(key);
      if (v !== undefined) { map.delete(key); map.set(key, v); }
      return v;
    },
    set(key, v) {
      map.set(key, v);
      while (map.size > limit) {
        const k = map.keys().next().value;
        const old = map.get(k);
        map.delete(k);
        // Safe even if still on screen: three re-initializes a disposed material on its next use.
        if (old && typeof old.dispose === 'function') old.dispose();
      }
    },
    clear() {
      map.forEach((v) => { if (v && typeof v.dispose === 'function') v.dispose(); });
      map.clear();
    },
    get size() { return map.size; }
  };
}

export function createMaterials(THREE, renderer, quality) {
  if (!THREE || typeof THREE.MeshPhysicalMaterial !== 'function') throw new Error('createMaterials: THREE is required');
  const Q = {
    fur: clamp(quality && typeof quality.fur === 'number' ? quality.fur : 1, 0.2, 1),
    shadows: !(quality && quality.shadows === false)
  };

  const toneCache = new Map();
  const bodyCache = makeCache(40);
  const accCache = makeCache(96);
  const faceCache = makeCache(64);
  const furMaterials = new Set();
  let envRT = null;

  function tones(hex) {
    const h = normHex(hex) || DEFAULT_HEX;
    let t = toneCache.get(h);
    if (!t) {
      t = computeTones(h);
      if (toneCache.size > 256) toneCache.clear();
      toneCache.set(h, t);
    }
    return Object.assign({}, t);
  }

  function colorOf(hex) { return new THREE.Color().setHex(parseInt(normHex(hex) || DEFAULT_HEX, 16)); }   // sRGB -> linear

  /* ---- environment: our own studio room --------------------------------------------- */

  function buildStudioEnv() {
    if (!renderer || typeof THREE.PMREMGenerator !== 'function') return null;
    const scene = new THREE.Scene();
    const owned = [];
    // Room shell, seen from inside: dark floor, walls brightening upward, a light ceiling.
    // The PMREM camera sits at the origin, about where the character's middle is.
    const room = new THREE.BoxGeometry(18, 11, 18, 1, 10, 1);
    room.translate(0, 2.5, 0);
    const pos = room.attributes.position, nrm = room.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const ny = nrm.getY(i);
      let c;
      if (ny < -0.5) c = [0.07, 0.065, 0.06];             // floor
      else if (ny > 0.5) c = [0.5, 0.5, 0.51];            // ceiling
      else {
        const t = smoothstep(-3, 8, pos.getY(i));
        c = [0.14 + 0.28 * t, 0.135 + 0.28 * t, 0.13 + 0.28 * t];
      }
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    room.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const roomMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    scene.add(new THREE.Mesh(room, roomMat));
    owned.push(room, roomMat);

    // Emissive soft boxes facing the center, each with a dim halo behind it so highlights fall off.
    function softBox(w, h, x, y, z, k, rgb) {
      const layers = [[1.4, 0.16, 1.03], [1.0, 1.0, 1.0]];
      for (let i = 0; i < layers.length; i++) {
        const s = layers[i][0], kk = layers[i][1], back = layers[i][2];
        const g = new THREE.PlaneGeometry(w * s, h * s);
        const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
        m.color.setRGB(rgb[0] * k * kk, rgb[1] * k * kk, rgb[2] * k * kk);   // linear, HDR (> 1)
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(x * back, y * back, z * back);
        mesh.lookAt(0, 0, 0);
        scene.add(mesh);
        owned.push(g, m);
      }
    }
    softBox(6, 4.5, -5, 5, 6, 6.0, [1.0, 0.94, 0.86]);      // key: large, warm, front left above
    softBox(3, 6, 7, 1.5, 4, 2.2, [0.9, 0.95, 1.0]);        // fill: tall strip, front right
    softBox(8, 1.6, 1, 4, -7.5, 4.0, [0.85, 0.92, 1.0]);    // rim: wide strip behind, cool
    softBox(5, 5, 0, 7.6, 0.5, 2.5, [1.0, 1.0, 1.0]);       // top panel
    softBox(1.2, 5, -7.5, 2, -3, 3.0, [1.0, 1.0, 1.0]);     // narrow strip, back left (edge lines on chrome)
    softBox(6, 3, 0, -2.9, 4, 0.8, [1.0, 0.95, 0.88]);      // low bounce card in front

    let rt = null;
    let pmrem = null;
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      rt = pmrem.fromScene(scene, 0.035, 0.1, 100);
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[dot-avatar materials] environment failed', e);
      rt = null;
    }
    if (pmrem) pmrem.dispose();
    for (let i = 0; i < owned.length; i++) owned[i].dispose();
    return rt;
  }

  envRT = buildStudioEnv();
  const env = envRT ? envRT.texture : null;

  function applyEnv(m, k) {
    if (env) { m.envMap = env; m.envMapIntensity = k; }
  }

  /* ---- paint uniforms ------------------------------------------------------------------ */

  function paintUniforms() {
    const U = {
      daZoneCount: { value: 0 },
      daZoneC: { value: [] },
      daZoneR: { value: [] },
      daZoneP: { value: [] },
      daTones: { value: [] }
    };
    for (let i = 0; i < MAX_ZONES; i++) {
      U.daZoneC.value.push(new THREE.Vector3());
      U.daZoneR.value.push(new THREE.Vector3(1, 1, 1));
      U.daZoneP.value.push(new THREE.Vector4(2, 0.03, 0, 0));
    }
    for (let i = 0; i < NT; i++) U.daTones.value.push(new THREE.Color());
    return U;
  }

  function setTones(U, hex) {
    const T = tones(hex);
    for (let i = 0; i < TONE_KEYS.length; i++) U.daTones.value[i].setHex(parseInt(T[TONE_KEYS[i]], 16));
  }

  // Base color per finish: glass and jelly are lighter (their tint comes mostly from absorption),
  // chrome is lifted in OKLab so dark colors still reflect (yellow reads as gold).
  function bodyColor(id, hex) {
    const S = SURFACE[id] || {};
    if (id === 'chrome') {
      const B = hexToLab(hex);
      const L = Math.max(B[0], 0.74);
      return colorOf(labToHex([L, B[1] * 0.92, B[2] * 0.92]));
    }
    const c = colorOf(hex);
    if (S.tintWhite) c.lerp(new THREE.Color(1, 1, 1), S.tintWhite);
    return c;
  }

  function setPaintUniforms(material, shape, hex) {
    const ud = material && material.userData;
    const U = ud && ud.daU;
    if (!U) return;
    const h = normHex(hex) || DEFAULT_HEX;
    setTones(U, h);
    if (ud.daKind === 'fur') {
      U.daFurBase.value.copy(colorOf(h));
      const geo = ud.daFurGeo;
      const sid = shape && shape.id ? shape.id : '';
      if (geo && shape !== undefined && sid !== ud.daShapeId) {
        fillFurToneWeights(geo.attributes.position, shape, geo.attributes.furTone0.array, geo.attributes.furTone1.array);
        geo.attributes.furTone0.needsUpdate = true;
        geo.attributes.furTone1.needsUpdate = true;
        ud.daShapeId = sid;
      }
    } else {
      const zones = zoneList(shape);
      U.daZoneCount.value = zones.length;
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        U.daZoneC.value[i].set(z.c[0], z.c[1], z.c[2]);
        U.daZoneR.value[i].set(z.r[0], z.r[1], z.r[2]);
        U.daZoneP.value[i].set(z.p, z.soft, z.ti, 0);
      }
      if (ud.daKind === 'body') {
        const id = ud.daFinish;
        material.color.copy(bodyColor(id, h));
        const S = SURFACE[id];
        if (S && S.transmission) {
          const a = colorOf(h);
          if (S.attenWhite) a.lerp(new THREE.Color(1, 1, 1), S.attenWhite);
          material.attenuationColor.copy(a);
        }
        if (S && S.sheen) material.sheenColor.copy(colorOf(h).lerp(new THREE.Color(1, 1, 1), 0.5));
      }
      ud.daShapeId = shape && shape.id ? shape.id : '';
    }
    ud.daHex = h;
  }

  /* ---- body ---------------------------------------------------------------------------- */

  function furParams(id, q) {
    const F = FUR[id];
    if (!F) return null;
    const qq = clamp(typeof q === 'number' ? q : q && typeof q.fur === 'number' ? q.fur : Q.fur, 0.2, 1);
    const layers = furLayerCount(F, qq);
    // thick and rootDark are the density-compensated values for this shell count (FUR QUALITY)
    return Object.assign({ finishId: id }, F, { layers, quality: qq }, furCompensated(F, layers));
  }

  function createBodyMaterial(id, hex, shape) {
    const S = SURFACE[id] || {};
    const furry = !!FUR[id];
    const p = { color: 0xffffff, roughness: furry ? 1 : S.roughness, metalness: S.metalness || 0 };
    if (S.clearcoat) { p.clearcoat = S.clearcoat; p.clearcoatRoughness = S.clearcoatRoughness; }
    if (S.sheen) { p.sheen = S.sheen; p.sheenRoughness = S.sheenRoughness; }
    if (S.iridescence) { p.iridescence = S.iridescence; p.iridescenceIOR = S.iridescenceIOR; p.iridescenceThicknessRange = S.iridescenceThicknessRange.slice(); }
    if (S.transmission) {
      p.transmission = S.transmission; p.thickness = S.thickness; p.ior = S.ior;
      p.attenuationDistance = S.attenuationDistance;
      if (S.dispersion) p.dispersion = S.dispersion;
    }
    const m = new THREE.MeshPhysicalMaterial(p);
    m.name = 'da-body-' + id;
    m.defaultAttributeValues = { surf: [1, 0] };
    applyEnv(m, furry ? 1 : S.env);
    const U = paintUniforms();
    m.userData.daU = U;
    m.userData.daKind = 'body';
    m.userData.daFinish = id;
    if (furry) {
      // Trap 7: depth and shadow only, one-line fragment shader.
      m.colorWrite = false;
      m.polygonOffset = true;
      m.polygonOffsetFactor = 1;
      m.polygonOffsetUnits = 1;
      m.userData.depthOnly = true;
      m.onBeforeCompile = function (shader) {
        shader.fragmentShader = DEPTH_ONLY_FRAGMENT;
      };
      m.customProgramCacheKey = function () { return 'da-body-depth'; };
    } else {
      m.onBeforeCompile = function (shader) {
        Object.assign(shader.uniforms, U);
        shader.vertexShader = bodyVertex(shader.vertexShader);
        shader.fragmentShader = bodyFragment(THREE, shader.fragmentShader, id);
      };
      m.customProgramCacheKey = function () { return 'da-body-' + id + LAYOUT; };
    }
    setPaintUniforms(m, shape, hex);
    return m;
  }

  function checkFinish(id) {
    if (FINISH_IDS.indexOf(id) >= 0) return id;
    if (typeof console !== 'undefined') console.warn('[dot-avatar materials] unknown finish "' + id + '", using plush');
    return 'plush';
  }

  function body(finishId, hex, shape) {
    const id = checkFinish(finishId);
    const h = normHex(hex) || DEFAULT_HEX;
    const sid = shape && shape.id ? shape.id : '';
    const key = id + '|' + h + '|' + sid;
    let m = sid ? bodyCache.get(key) : undefined;
    if (m) setPaintUniforms(m, shape, h);    // in case someone re-targeted the cached material
    else {
      m = createBodyMaterial(id, h, shape);
      if (sid) bodyCache.set(key, m);
    }
    const F = FUR[id];
    return { material: m, fur: furParams(id), soft: !!SOFT[id], furLength: F ? F.length : 0 };
  }

  /* ---- fur ----------------------------------------------------------------------------- */

  function makeFur(geometry, finishId, hex, shape, quality) {
    const id = checkFinish(finishId);
    const P = furParams(id, quality);
    if (!P || !geometry || !geometry.attributes || !geometry.attributes.position) return null;
    const h = normHex(hex) || DEFAULT_HEX;
    const pos = geometry.attributes.position;
    const n = pos.count;

    // ONE draw: the body's own buffers (shared, not copied) instanced once per shell.
    const g = new THREE.InstancedBufferGeometry();
    if (geometry.index) g.setIndex(geometry.index);
    g.setAttribute('position', pos);
    if (geometry.attributes.normal) g.setAttribute('normal', geometry.attributes.normal);
    if (geometry.attributes.surf) g.setAttribute('surf', geometry.attributes.surf);
    g.setAttribute('furTone0', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('furTone1', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    const layer = new Float32Array(P.layers);
    for (let i = 0; i < P.layers; i++) layer[i] = P.layers === 1 ? 1 : 1 - i / (P.layers - 1);   // outermost first
    g.setAttribute('furLayer', new THREE.InstancedBufferAttribute(layer, 1));
    g.instanceCount = P.layers;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (geometry.boundingSphere) {
      g.boundingSphere = geometry.boundingSphere.clone();
      g.boundingSphere.radius += P.length * (1.6 + P.gravity + P.wind);
    }
    if (geometry.boundingBox) {
      g.boundingBox = geometry.boundingBox.clone();
      g.boundingBox.expandByScalar(P.length * (1.6 + P.gravity + P.wind));
    }

    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: P.roughness, metalness: 0 });
    m.name = 'da-fur-' + id;
    m.defaultAttributeValues = { surf: [1, 0], furTone0: [0, 0, 0, 0], furTone1: [0, 0, 0, 0], furLayer: [0] };
    applyEnv(m, P.env);
    const windDir = new THREE.Vector3(1, 0, 0.35).normalize();
    const U = {
      daFurLen: { value: P.length },
      daGravity: { value: new THREE.Vector3(0, -P.gravity, 0) },
      daWind: { value: windDir.multiplyScalar(P.wind) },
      daTime: { value: 0 },
      daMotion: { value: 0 },
      daTrimCount: { value: 0 },
      daTrim: { value: [] },
      daTones: { value: [] },
      daFurBase: { value: new THREE.Color() },
      daFurDensity: { value: P.density },
      daFurThick: { value: P.thick },
      daFurJitter: { value: P.jitter },
      daFurLenVar: { value: P.lenVar },
      daFurUnder: { value: Math.max(0.001, P.under) },
      daFurClump: { value: clamp(P.clump, 0, 0.7) },
      daFurRootDark: { value: P.rootDark },
      daFurTipLift: { value: P.tipLift },
      daFurSheen: { value: P.sheen },
      daFurColorNoise: { value: P.colorNoise }
    };
    for (let i = 0; i < MAX_TRIMS; i++) U.daTrim.value.push(new THREE.Vector4(0, 0, 0, 0));
    for (let i = 0; i < NT; i++) U.daTones.value.push(new THREE.Color());
    m.userData.daU = U;
    m.userData.daKind = 'fur';
    m.userData.daFinish = id;
    m.userData.daFurGeo = g;
    const cacheKey = 'da-fur-' + P.mode + (P.clump > 0 ? '-clump' : '') + LAYOUT;
    m.onBeforeCompile = function (shader) {
      Object.assign(shader.uniforms, U);
      let vs = shader.vertexShader;
      vs = inject(vs, '#include <common>', FUR_VERTEX_DECL, 'after', 'fur vertex declarations');
      vs = inject(vs, '#include <beginnormal_vertex>', FUR_VERTEX_NORMAL, 'after', 'fur shell offset');
      vs = inject(vs, '#include <begin_vertex>', FUR_VERTEX_MAIN, 'after', 'fur vertex varyings');
      shader.vertexShader = vs;
      let fs = shader.fragmentShader;
      fs = inject(fs, '#include <common>', furFragmentDecl(P), 'after', 'fur fragment declarations');
      fs = inject(fs, '#include <color_fragment>', FUR_FRAGMENT_COLOR, 'after', 'fur color and cut-out');
      fs = inject(fs, '#include <lights_physical_pars_fragment>', glslWrap(FUR_WRAP, [1, 0.95, 0.92], true), 'after', 'fur wrap lighting');
      fs = inject(fs, '#include <aomap_fragment>', FUR_FRAGMENT_LIGHT, 'after', 'fur self-shadowing');
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = function () { return cacheKey; };
    setPaintUniforms(m, shape, h);
    furMaterials.add(m);
    m.addEventListener('dispose', function () { furMaterials.delete(m); });

    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'da-fur';
    mesh.renderOrder = 1;            // after the depth-only body
    mesh.castShadow = false;         // the body casts the shadow
    mesh.receiveShadow = quality && typeof quality === 'object' && 'shadows' in quality ? quality.shadows !== false : Q.shadows;
    mesh.userData.layers = P.layers;
    mesh.userData.furLength = P.length;
    mesh.userData.furParams = P;
    mesh.userData.update = function (t, motion) {
      U.daTime.value = Number(t) || 0;
      U.daMotion.value = clamp(Number(motion) || 0, 0, 1);
    };
    mesh.userData.setTrims = function (trims) { setFurTrims(mesh, trims); };
    // Fewer shells for a while (the stage's frame-rate throttle): q in [0.2, 1] is RELATIVE to the
    // quality this mesh was built with (1 = as built, 0.6 = 60% of those shells; round 1 took a
    // fraction of the full count, which made the throttle a no-op on meshes built below 1). Never
    // more shells than were built. Rewrites the per-instance heights so the skin shell is always
    // the last one drawn, and re-applies the density compensation for the new count (FUR QUALITY).
    mesh.userData.setQuality = function (q) {
      const F = FUR[id];
      const nL = Math.min(furLayerCount(F, P.quality * clamp(Number(q) || 1, 0.2, 1)), P.layers);
      for (let i = 0; i < nL; i++) layer[i] = nL === 1 ? 1 : 1 - i / (nL - 1);
      g.attributes.furLayer.needsUpdate = true;
      g.instanceCount = nL;
      const C = furCompensated(F, nL);
      U.daFurThick.value = C.thick;
      U.daFurRootDark.value = C.rootDark;
      mesh.userData.layers = nL;
      return nL;
    };
    mesh.userData.dispose = function () {
      // Also releases the GPU buffers shared with the body; three re-uploads them if the body is
      // drawn again.
      m.dispose();
      g.dispose();
    };
    return mesh;
  }

  function setFurTrims(mesh, trims) {
    const m = mesh && mesh.material;
    const U = m && m.userData && m.userData.daU;
    if (!U || !U.daTrim) return;
    const list = Array.isArray(trims) ? trims : [];
    let count = 0;
    for (let i = 0; i < list.length && count < MAX_TRIMS; i++) {
      const t = list[i];
      if (!t || !(t.r > 0)) continue;
      const c = arr3(t.c, 0);
      U.daTrim.value[count].set(c[0], c[1], c[2], t.r);
      count++;
    }
    for (let i = count; i < MAX_TRIMS; i++) U.daTrim.value[i].set(0, 0, 0, 0);
    U.daTrimCount.value = count;
  }

  /* ---- accessories ----------------------------------------------------------------------- */

  function wantsTransparent(opts) {
    return !!(opts && (opts.transmissive || (opts.finishId && TRANSMISSIVE[opts.finishId])));
  }

  function buildAccessory(kind, def, hex, soft, transmissive) {
    const color = colorOf(hex);
    const p = { color, roughness: def.roughness, metalness: def.metalness || 0 };
    if (def.type === 'phys') {
      if (def.clearcoat) { p.clearcoat = def.clearcoat; p.clearcoatRoughness = def.clearcoatRoughness || 0.05; }
      if (def.sheen) {
        p.sheen = soft ? (def.sheenSoft || def.sheen) : def.sheen;
        p.sheenRoughness = def.sheenRoughness || 0.5;
        p.sheenColor = colorOf(hex).lerp(new THREE.Color(1, 1, 1), 0.4);
      }
      if (def.iridescence) {
        p.iridescence = def.iridescence;
        p.iridescenceIOR = def.iridescenceIOR || 1.3;
        if (def.iridescenceThicknessRange) p.iridescenceThicknessRange = def.iridescenceThicknessRange.slice();
      }
      if (def.ior) p.ior = def.ior;
      if (def.specularIntensity) p.specularIntensity = def.specularIntensity;
    }
    if (def.glow) { p.emissive = colorOf(hex); p.emissiveIntensity = def.glow; }
    if (def.flat) p.flatShading = true;
    if (def.transparent) {
      p.transparent = true;
      p.opacity = def.opacity;
      if (def.depthWrite === false) p.depthWrite = false;
    }
    const m = def.type === 'std' ? new THREE.MeshStandardMaterial(p) : new THREE.MeshPhysicalMaterial(p);
    m.name = 'da-acc-' + kind;
    applyEnv(m, def.env || 1);
    if (transmissive) m.transparent = true;   // trap 9
    if (def.detail && ACC_DETAIL[def.detail]) {
      m.onBeforeCompile = detailCompile(ACC_DETAIL[def.detail], 'accessory ' + def.detail, true);
      const key = 'da-acc-' + def.detail;
      m.customProgramCacheKey = function () { return key; };
    }
    m.userData.daKind = 'accessory';
    m.userData.daAccessory = kind;
    return m;
  }

  function accessory(kind, opts) {
    const o = opts || {};
    let k = kind;
    if (!ACC[k]) {
      if (typeof console !== 'undefined') console.warn('[dot-avatar materials] unknown accessory kind "' + kind + '", using plastic');
      k = 'plastic';
    }
    const def = ACC[k];
    const hex = normHex(o.color) || def.color;
    const soft = !!o.soft;
    const tr = wantsTransparent(o);
    const key = k + '|' + hex + '|' + (soft ? 1 : 0) + '|' + (tr ? 1 : 0);
    let m = accCache.get(key);
    if (!m) {
      m = buildAccessory(k, def, hex, soft, tr);
      accCache.set(key, m);
    }
    return m;
  }

  /* ---- face ---------------------------------------------------------------------------- */

  function glowHex(bodyHex) {
    const cyan = '86f3ff';
    return labDist(hexToLab(cyan), hexToLab(bodyHex)) < 0.15 ? 'ffe27a' : cyan;
  }

  function buildFace(kind, bodyHex, transmissive) {
    const T = tones(bodyHex);
    let m;
    switch (kind) {
      case 'eye':
        m = new THREE.MeshPhysicalMaterial({ color: colorOf('1d1a22'), roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.03 });
        break;
      case 'eye-light':
        m = new THREE.MeshPhysicalMaterial({ color: colorOf('f3efe6'), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03 });
        break;
      case 'white':
        m = new THREE.MeshPhysicalMaterial({ color: colorOf('fbfaf6'), roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.06 });
        break;
      case 'pupil':
        m = new THREE.MeshPhysicalMaterial({ color: colorOf('121016'), roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.03 });
        break;
      case 'glow': {
        const g = glowHex(bodyHex);
        m = new THREE.MeshStandardMaterial({ color: colorOf(g), emissive: colorOf(g), emissiveIntensity: 2.0, roughness: 0.4 });
        break;
      }
      case 'blush':
        m = new THREE.MeshStandardMaterial({
          color: colorOf(T.cheek), roughness: 0.9, transparent: true, opacity: 0.6, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
        });
        m.onBeforeCompile = detailCompile(BLUSH_DETAIL, 'blush', false);
        m.customProgramCacheKey = function () { return 'da-face-blush'; };
        break;
      case 'nose-dark':
        m = new THREE.MeshPhysicalMaterial({ color: colorOf(T.dark), roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.08 });
        break;
      case 'nose-pink':
        m = new THREE.MeshPhysicalMaterial({ color: colorOf(T.pink), roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.1 });
        break;
      case 'beak':
        m = new THREE.MeshPhysicalMaterial({ color: colorOf(T.orange), roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.12 });
        break;
      default:
        return null;
    }
    m.name = 'da-face-' + kind;
    applyEnv(m, 1);
    if (transmissive) m.transparent = true;   // trap 9
    m.userData.daKind = 'face';
    m.userData.daFace = kind;
    return m;
  }

  function faceMaterial(kind, hex, opts) {
    const h = normHex(hex) || DEFAULT_HEX;
    const tr = wantsTransparent(opts);
    let k = kind;
    if (['eye', 'eye-light', 'white', 'pupil', 'glow', 'blush', 'nose-dark', 'nose-pink', 'beak'].indexOf(k) < 0) {
      if (typeof console !== 'undefined') console.warn('[dot-avatar materials] unknown face material "' + kind + '", using eye');
      k = 'eye';
    }
    // Colors of eye, eye-light, white and pupil do not depend on the body color.
    const colorKey = (k === 'eye' || k === 'eye-light' || k === 'white' || k === 'pupil') ? '-' : h;
    const key = k + '|' + colorKey + '|' + (tr ? 1 : 0);
    let m = faceCache.get(key);
    if (!m) {
      m = buildFace(k, h, tr);
      faceCache.set(key, m);
    }
    return m;
  }

  /* ---- api ----------------------------------------------------------------------------- */

  const api = {
    env,
    finishIds: FINISH_IDS.slice(),
    toneKeys: TONE_KEYS.slice(),
    quality: Q,
    body,
    makeFur,
    setFurTrims,
    setPaintUniforms,
    tones,
    accessory,
    faceMaterial,
    isTransmissive(id) { return !!TRANSMISSIVE[id]; },
    furParams,
    furQualityFor,
    dispose() {
      bodyCache.clear();
      accCache.clear();
      faceCache.clear();
      furMaterials.forEach((m) => m.dispose());
      furMaterials.clear();
      if (envRT) envRT.dispose();
      envRT = null;
      api.env = null;
    }
  };
  return api;
}
