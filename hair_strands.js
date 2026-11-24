/* ============================================================================
   hair_strands.js  —  real-time individual-strand hair for the DART Meadow
   character (Ariel).  Self-contained ES module, shared by the game and the
   Ariel Rig Viewer (radicaldeepscale.com imports this exact file from the same
   dartmeadow-space commit, so both always run one solver):

       import('./hair_strands.js').then(m=>m.attachHairStrands(CHAR,THREE,{url:...}))

   DATA  (characterassests/ariel_hair_strands.bin, "DHS1", v2)
     5,665 strands from Justin's 4 layered Blender hair-curve sets (grown on the
     separated Scalp), 14 points each, root-dense spacing, HEAD-BONE-LOCAL.
     1,415 of them are GUIDES (physically simulated); every strand follows its
     nearest guide.  Strand order is shuffled so any prefix is a uniform subset
     (lets Auto quality draw fewer children without bald patches).
     v2 appends a signed-distance field of the head (Scalp + head-weighted face/
     ears, 5 mm cells, int16 0.1 mm units) in Head-bone space.  The rest groom was
     de-penetrated against it offline (every point >= 3 mm outside the head) and
     each root's first segment leaves the scalp along its grow direction tilted
     up the scalp normal.

   SOLVER  (position-based dynamics, per guide, in the character root's local
   frame so it is precision-safe at planetary coordinates)
     - points 0 and 1 are pinned to the skinned scalp (Scalp is 100% Head-
       weighted, so the Head bone frame IS the scalp frame): root position and
       root tangent come straight from the groom every frame
     - verlet integration with damping, gravity and gusting wind (+ apparent
       wind from the character's own motion); root motion is fed in as a
       clamped inertial shift so hair trails a moving / flying character
     - per iteration: segment-length constraints (root -> tip), a LOCAL bending
       constraint (each segment pulled toward its groomed direction in the
       head frame: strong at the root, soft toward the tip, so hair stays combed
       on the scalp but folds and drapes further down), a weak global shape
       spring, and head SDF collision for EVERY free point (each point keeps the
       clearance it has in the groom, clamped 2 mm .. 2 cm) with friction
     - body capsules (neck / chest / shoulders / arms / hands) on the last
       iteration, as before
     - child strands = their rest groom + their guide's deflection, then pushed
       out of the head SDF themselves, so interpolation never cuts into the scalp
     - the Scalp's skin sheen (shared body material) is switched off on a private
       material copy while strands are live, so it reads as hair-coloured scalp

   RUNTIME API (window.DART_HAIR after attach):
       HAIR.params   {gravity, damping, shapeStiffness, tipStiffness, bendRoot,
                      bendTip, wind:Vector3, windGust, enabled, iterations, ...}
       HAIR.addCollider({center:Vector3 (WORLD), radius, end?:Vector3}) -> handle
       HAIR.removeCollider(handle)
       HAIR.setEnabled(bool)
       HAIR.setStrandFraction(f)   // 0..1 of the 5,665 strands drawn (guides always simulate)
       HAIR.stats                  // {ms, simMs, strands, drawn, guides, sdf}
   ========================================================================== */

/* ============================================================================
   PER-CHARACTER CONFIG  (data-driven clusters; see docs/hair-new-character.md)
   A groom file stores a cluster id per strand (`group`, uint8, names in meta.groups). Everything cluster-specific is read from a config:
       meta.config (inside the .bin's JSON header)  <  opts.config (host / per-character override)
   {
     name:      'Emma'                          mesh name = name + 'HairStrands'  (default 'Ariel')
     character: true                            allow a character without an Ariel/Scalp mesh
     clusters:  [ { name, stiffBoost, bendBoost, widthScale, color:[r,g,b], colorJitter:[lo,hi], gradient:{root,tip,tipStart,streak,streakFrac,streakStart},
                    clearance:{min,max,scale} } , ... ]      index = group id; missing ids / fields use the defaults below (1, 1, 1, meta.color ...)
     clumps:    { clumpName: { tint:[r,g,b] (multiplies the strand colour), widthScale } }   per-clump look, keyed by meta.clusters[] names (file section `cluster`)
     params:    { gravity, damping, shapeStiffness, bendRoot, widthRoot ... }   merged into the solver params (opts.params still wins)
     body:      [ [bone, childBone|null, radius], ... ]    body capsules the strands collide with (replaces the default torso/arm list)
   }
   With no config at all the built-in table below applies: Ariel's four layers, behaviour unchanged.
   Cost: tables are filled once at load; the per-frame cost is one multiply per ribbon vertex (width) and nothing in the solver.
   Limits: one point count K per file (the groom builder resamples every cluster to K points; a short cluster simply has shorter segments),
   the solver params that are not per-point (gravity, damping, wind ...) stay per character, not per cluster.
   ========================================================================== */
export const HAIR_DEFAULT_CONFIG = {
  name: 'Ariel',
  // Ariel: back / bangs / sideburns / top. Bangs and sideburns are short: they hold their shape harder.
  clusters: [{ name: 'back' }, { name: 'bangs', stiffBoost: 1.6 }, { name: 'sideburns', stiffBoost: 1.8 }, { name: 'top' }],
  // Ariel collision data for tiers >= 1 (fitted to her skinned body / shirt / glasses / ears with tools/hair-fit-colliders.mjs; see docs/hair-collision-notes.md)
  collision: {
    fileColliders: false,
    margin: {bundle: 1, cap: 0.012},
    separation: {neighbours: 3, frac: 0.6},
    capsules: {
      1: [
        { bone: 'Spine02', a: [0, -0.0019, 0.0306], b: [0, 0.1289, 0.0306], r: 0.1331 },
        { bone: 'Spine01', a: [0, -0.0066, 0.0527], b: [0, 0.1209, 0.0527], r: 0.1331 },
        { bone: 'Spine', a: [0, 0, 0.0093], b: [0, 0.0435, 0.0093], r: 0.1176 },
        { bone: 'Spine', a: [-0.002, 0.021, -0.0009], b: [0.0771, 0.0106, 0.0509], r: 0.0931 },
        { bone: 'LeftShoulder', a: [-0.0317, 0.0108, 0.0053], b: [-0.0317, 0.1319, 0.0053], r: 0.0835 },
        { bone: 'LeftArm', a: [0, 0, 0], b: [0, 0.1574, 0], r: 0.058 },
        { bone: 'LeftForeArm', a: [0, 0, 0], b: [0, 0.2221, -0.0378], r: 0.055 },
        { bone: 'LeftHand', a: [0, 0, 0], b: [0, 0.0981, 0], r: 0.04 },
        { bone: 'Spine', a: [0.002, 0.021, -0.0009], b: [-0.0771, 0.0106, 0.0509], r: 0.0931 },
        { bone: 'RightShoulder', a: [0.0317, 0.0108, 0.0053], b: [0.0317, 0.1319, 0.0053], r: 0.0835 },
        { bone: 'RightArm', a: [0, 0, 0], b: [0, 0.1542, 0], r: 0.058 },
        { bone: 'RightForeArm', a: [0, 0, 0], b: [0, 0.2214, -0.0409], r: 0.055 },
        { bone: 'RightHand', a: [0, 0, 0], b: [0, 0.0981, 0], r: 0.04 },
        { bone: 'Hips', a: [0, 0, 0], b: [0, 0.1314, 0], r: 0.14 },
        { bone: 'neck', a: [0, 0, 0], b: [0, 0.1068, 0], r: 0.055 }
      ],
      2: [
        { bone: 'Spine02', a: [0, -0.0015, 0.0242], b: [0, 0.1292, 0.0242], r: 0.1257 },
        { bone: 'Spine02', a: [0.0763, -0.0019, 0.0306], b: [0.0763, 0.1289, 0.0306], r: 0.1031 },
        { bone: 'Spine02', a: [-0.0763, -0.0019, 0.0306], b: [-0.0763, 0.1289, 0.0306], r: 0.1031 },
        { bone: 'Spine01', a: [0, -0.0038, 0.0305], b: [0, 0.1237, 0.0305], r: 0.1107 },
        { bone: 'Spine01', a: [0.07, -0.0066, 0.0527], b: [0.07, 0.1209, 0.0527], r: 0.0949 },
        { bone: 'Spine01', a: [-0.07, -0.0066, 0.0527], b: [-0.07, 0.1209, 0.0527], r: 0.0949 },
        { bone: 'Spine', a: [0, 0, 0.0191], b: [0, 0.0435, 0.0191], r: 0.1009 },
        { bone: 'Spine', a: [0.0724, 0, -0.0125], b: [0.0724, 0.0435, -0.0125], r: 0.0892 },
        { bone: 'Spine', a: [-0.0724, 0, -0.0125], b: [-0.0724, 0.0435, -0.0125], r: 0.0892 },
        { bone: 'Spine', a: [0, 0.0235, 0], b: [0.0771, 0.0237, 0.0178], r: 0.06 },
        { bone: 'LeftShoulder', a: [-0.0044, 0.0015, 0.013], b: [-0.0044, 0.1226, 0.013], r: 0.0623 },
        { bone: 'LeftArm', a: [0, 0, 0], b: [0, 0.1574, 0], r: 0.0607 },
        { bone: 'LeftForeArm', a: [0, 0, 0], b: [0, 0.2221, -0.0378], r: 0.055 },
        { bone: 'LeftHand', a: [0, 0, 0], b: [0, 0.0981, 0], r: 0.04 },
        { bone: 'Spine', a: [0, 0.0235, 0], b: [-0.0771, 0.0237, 0.0178], r: 0.06 },
        { bone: 'RightShoulder', a: [0.0044, 0.0015, 0.013], b: [0.0044, 0.1226, 0.013], r: 0.0623 },
        { bone: 'RightArm', a: [0, 0, 0], b: [0, 0.1542, 0], r: 0.0607 },
        { bone: 'RightForeArm', a: [0, 0, 0], b: [0, 0.2214, -0.0409], r: 0.055 },
        { bone: 'RightHand', a: [0, 0, 0], b: [0, 0.0981, 0], r: 0.04 },
        { bone: 'Hips', a: [0, 0, 0], b: [0, 0.1314, 0], r: 0.14 },
        { bone: 'neck', a: [0, 0, 0], b: [0, 0.1068, 0], r: 0.055 }
      ]
    },
    boxes: [
      { name: 'lensL', c: [0.041, 0.15, 0.0407], h: [0.0311, 0.018, 0.0149], margin: 0.001 },
      { name: 'lensR', c: [-0.041, 0.15, 0.0407], h: [0.0311, 0.018, 0.0149], margin: 0.001 },
      { name: 'frameBar', c: [0, 0.163, 0.042], h: [0.052, 0.0096, 0.0018], margin: 0.001 },
      { name: 'earL', c: [0.074, 0.088, -0.0135], h: [0.014, 0.035, 0.0425], margin: 0.001 },
      { name: 'earR', c: [-0.074, 0.088, -0.0135], h: [0.014, 0.035, 0.0425], margin: 0.001 }
    ]
  },
};
function hairConfig(meta, opts) {
  const m = meta.config || {}, o = opts.config || {};
  const C = Object.assign({}, HAIR_DEFAULT_CONFIG, m, o);
  const objs = (a) => Array.isArray(a) && a.length && typeof a[0] === 'object' ? a : null;
  C.clusters = objs(o.clusters) || objs(m.clusters) || objs(meta.clusters) || HAIR_DEFAULT_CONFIG.clusters;
  C.clumps = Object.assign({}, m.clumps, o.clumps);
  // per-character collider data for tiers >= 1; the built-in default (Ariel's numbers) only applies when the character brings no clusters / collision of its own
  C.collision = o.collision || m.collision || ((objs(o.clusters) || objs(m.clusters) || objs(meta.clusters)) ? undefined : HAIR_DEFAULT_CONFIG.collision);
  C.params = Object.assign({}, m.params, o.params);
  return C;
}

export async function attachHairStrands(CHAR, THREE, opts = {}) {
  if (!CHAR || !CHAR.root) throw new Error('[hair] no character root');
  if (CHAR._hair) return CHAR._hair;
  const url = opts.url || 'characterassests/ariel_hair_strands.bin';
  const res = await fetch(url);
  if (!res.ok) throw new Error('[hair] fetch ' + url + ' -> ' + res.status);
  const buf = await res.arrayBuffer();
  if (opts.isCurrent && !opts.isCurrent()) return null;   // (bugfix-1119) the character this was started for has been dropped (pilot changed): never build onto the next one
  if (CHAR._hair) return CHAR._hair;
  const H = buildHair(CHAR, THREE, buf, opts);
  CHAR._hair = H;
  if (typeof window !== 'undefined') window.DART_HAIR = H;
  return H;
}

const BOXS = 32;   // floats per keep-out box in the per-frame buffer: t(3) Ainv(9) A(9) h(3) margin(1) sphere(4) + pad

// strands [N][K0][3] -> [N][K1][3]: points 0 and 1 (scalp-pinned) kept, points 1..K0-1 resampled to 1..K1-1 in groom-index space (keeps the root-dense
// spacing the groom builder chose), centripetal-free uniform Catmull-Rom so the new points lie on a smooth curve through the groom points.  Load time only.
export function resampleStrands(src, N, K0, K1) {
  const out = new Float32Array(N * K1 * 3), n0 = K0 - 1, span = K0 - 2, steps = K1 - 2;
  for (let s = 0; s < N; s++) {
    const a = s * K0 * 3, b = s * K1 * 3;
    for (let c = 0; c < 6; c++) out[b + c] = src[a + c];   // points 0, 1
    for (let j = 2; j < K1; j++) {
      const u = 1 + (j - 1) * span / steps, i1 = Math.min(n0 - 1, Math.floor(u)), t = u - i1, i0 = Math.max(0, i1 - 1), i2 = Math.min(n0, i1 + 1), i3 = Math.min(n0, i1 + 2);
      const t2 = t * t, t3 = t2 * t, w0 = -0.5 * t3 + t2 - 0.5 * t, w1 = 1.5 * t3 - 2.5 * t2 + 1, w2 = -1.5 * t3 + 2 * t2 + 0.5 * t, w3 = 0.5 * t3 - 0.5 * t2;
      for (let c = 0; c < 3; c++) out[b + j * 3 + c] = w0 * src[a + i0 * 3 + c] + w1 * src[a + i1 * 3 + c] + w2 * src[a + i2 * 3 + c] + w3 * src[a + i3 * 3 + c];
    }
    for (let c = 0; c < 3; c++) out[b + (K1 - 1) * 3 + c] = src[a + n0 * 3 + c];   // tip exactly
  }
  return out;
}

// (t1645u) refine a DHS1 head SDF grid by an integer factor: three separable 1-D Catmull-Rom passes (z, y, x), clamped ends, int16 out. Same origin /
// extent; cell / f.  Exported for tools/tests.
export function upsampleSDF(S, f) {
  const nx = S.nx, ny = S.ny, nz = S.nz, mx = (nx - 1) * f + 1, my = (ny - 1) * f + 1, mz = (nz - 1) * f + 1;
  const W = new Float32Array(4 * f);
  for (let j = 0; j < f; j++) { const t = j / f, t2 = t * t, t3 = t2 * t;
    W[j * 4] = -0.5 * t3 + t2 - 0.5 * t; W[j * 4 + 1] = 1.5 * t3 - 2.5 * t2 + 1; W[j * 4 + 2] = -1.5 * t3 + 2 * t2 + 0.5 * t; W[j * 4 + 3] = 0.5 * t3 - 0.5 * t2; }
  // one axis: src lines of length n (stride st) -> dst lines of length m; lines enumerated by (outer, inner) with the given strides
  const pass = (src, dst, n, m, nOut, nIn, sOutS, sInS, sS, sOutD, sInD, sD) => {
    for (let a = 0; a < nOut; a++) for (let b = 0; b < nIn; b++) {
      const bs = a * sOutS + b * sInS, bd = a * sOutD + b * sInD;
      for (let i = 0; i < n - 1; i++) {
        const v0 = src[bs + Math.max(0, i - 1) * sS], v1 = src[bs + i * sS], v2 = src[bs + (i + 1) * sS], v3 = src[bs + Math.min(n - 1, i + 2) * sS];
        for (let j = 0; j < f; j++) { const w = j * 4; dst[bd + (i * f + j) * sD] = W[w] * v0 + W[w + 1] * v1 + W[w + 2] * v2 + W[w + 3] * v3; }
      }
      dst[bd + (m - 1) * sD] = src[bs + (n - 1) * sS];
    }
  };
  // layout: v[(i * ny + j) * nz + k]
  const A = new Float32Array(nx * ny * mz); pass(S.v, A, nz, mz, nx, ny, ny * nz, nz, 1, ny * mz, mz, 1);
  const B = new Float32Array(nx * my * mz); pass(A, B, ny, my, nx, mz, ny * mz, 1, mz, my * mz, 1, mz);
  const C = new Float32Array(mx * my * mz); pass(B, C, nx, mx, my, mz, mz, 1, my * mz, mz, 1, my * mz);
  const v = new Int16Array(C.length); for (let i = 0; i < C.length; i++) { const x = Math.round(C[i]); v[i] = x > 32767 ? 32767 : x < -32768 ? -32768 : x; }
  return { v, nx: mx, ny: my, nz: mz, ox: S.ox, oy: S.oy, oz: S.oz, inv: S.inv * f, unit: S.unit, fine: f };
}

export function buildHair(CHAR, THREE, buf, opts = {}) {
  /* ---------------- parse ---------------- */
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'DHS1') throw new Error('[hair] bad magic ' + magic);
  const jl = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jl)));
  const dataStart = 12 + jl;
  const CFG = hairConfig(meta, opts);
  const clusterOf = (g) => CFG.clusters[g] || {};
  let off = dataStart;
  const N = meta.count, K0 = meta.points, G = meta.guides;
  let rest = new Float32Array(buf, off, N * K0 * 3); off += N * K0 * 12;
  // (t1644u) strand resolution: opts.segments (number or () => number) = points per strand wanted.  The groom file stores K0 (Ariel 14, Emma 16) root-dense
  // points; when more are asked for, every strand is resampled ONCE here (Catmull-Rom in groom-index space, so the root-dense spacing and the pinned
  // points 0 / 1 are kept exactly) and the whole solver / ribbon path simply runs at the new K.  Never fewer than the file has; capped at 24 (16 with the
  // opt-in GPU guide solver, whose WGSL path holds <= 16).  No option = the file's K0, bit-identical to before.
  let K = K0;
  {
    let want = 0; try { want = typeof opts.segments === 'function' ? +opts.segments() : +(opts.segments || 0); } catch (e) { want = 0; }
    const gpuWanted = (opts.params && opts.params.gpuCompute === true) || (typeof location !== 'undefined' && /[?&]hairgpu=1\b/.test(location.search || ''));
    want = Math.min(gpuWanted ? 16 : 24, want | 0);
    if (want > K0 && K0 >= 3) { rest = resampleStrands(rest, N, K0, want); K = want; meta.points = K; meta.pointsFile = K0; }
  }
  const group = new Uint8Array(buf, off, N); off += (N + 3) & ~3;
  const guideOf = new Uint32Array(buf, off, N); off += N * 4;
  const guideStrand = new Uint32Array(buf, off, G);
  // optional per-strand clump index (uint8[N] -> meta.clusters names), for CFG.clumps tint / width
  let clumpOf = null;
  if (meta.layout && meta.layout.clusterByteOffsetFromData != null && Array.isArray(meta.clusters) && dataStart + meta.layout.clusterByteOffsetFromData + N <= buf.byteLength) clumpOf = new Uint8Array(buf, dataStart + meta.layout.clusterByteOffsetFromData, N);
  // head signed-distance field (v2)
  let SDF = null;
  if (meta.sdf && meta.sdf.byteOffsetFromData != null) {
    const s = meta.sdf, n = s.dims[0] * s.dims[1] * s.dims[2];
    if (dataStart + s.byteOffsetFromData + n * 2 <= buf.byteLength)
      SDF = { v: new Int16Array(buf, dataStart + s.byteOffsetFromData, n), nx: s.dims[0], ny: s.dims[1], nz: s.dims[2],
              ox: s.origin[0], oy: s.origin[1], oz: s.origin[2], inv: 1 / s.cell, unit: s.unit || 1e-4 };
  }
  // (t1645u) the collision surface is denser than anything that touches it: the groom's head SDF (5 mm cells) is refined ONCE here by `sdfFine`
  // (2 -> 2.5 mm on tier >= 1, below the finest strand segment: Emma 3.8 mm at the root, Ariel 9 mm; 3 -> 1.7 mm) with a separable Catmull-Rom (C1) resample, so
  // the trilinear field + gradient the solver reads changes direction every 2.5 mm instead of 5 and contacts slide over the scalp instead of stepping
  // cell to cell.  Load time only (~15-40 ms, ~2.8 MB per groom at x2); per frame it is the same one lookup.  ?hairsdf=1 / opts.sdfFine:1 = the file's grid.
  if (SDF) {
    // refine by the collision tier at load: tier 0 (frame-budget fallback / explicit Low-0 callers) keeps the file's grid
    let t0 = 0; try { const ct = opts.params && opts.params.collisionTier; t0 = (ct != null && ct !== 'auto') ? +ct : (opts.getCollisionTier ? +opts.getCollisionTier() : 0); } catch (e) { t0 = 0; }
    // (v379, approved by Justin 2026-11-24) tier 2 at load (game Medium / High / Ultra, menu desktop) refines x3 -> 1.7 mm cells (~9.4 MB for Ariel's 5 mm groom);
    // tier 1 (game Low, menu phones / tablets: 3-4 GB iPhone, Tab A11) x2 -> 2.5 mm (~2.8 MB); tier 0 the file's grid.  Emma's groom is baked at 2.5 mm, so the
    // 1.6 mm clamp below keeps her at the native grid on every tier
    const fDef = t0 >= 2 ? 3 : t0 > 0 ? 2 : 1;
    let f = fDef; try { if (opts.sdfFine != null) f = typeof opts.sdfFine === 'function' ? +opts.sdfFine() : +opts.sdfFine; } catch (e) { f = fDef; }
    if (typeof location !== 'undefined') { const m = /[?&]hairsdf=(\d)/.exec(location.search || ''); if (m) f = +m[1]; }
    f = Math.max(1, Math.min(3, f | 0));
    // a groom baked finer than 5 mm (Emma v379: native 2.5 mm) is refined only while the cells stay >= 1.6 mm (memory: same budget as a 5 mm file x3)
    { const cl = 1 / SDF.inv; while (f > 1 && cl / f < 0.0016) f--; }
    if (f > 1) { SDF = upsampleSDF(SDF, f); meta.sdfFine = f; }
  }

  /* ---------------- guard: only attach to Ariel ---------------- */
  const cardMeshes = [];   // legacy skinned hair cards (none in the current GLB)
  let scalpMesh = null, isAriel = false;
  CHAR.root.traverse((o) => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    if (/Ariel.?Hair(?!Strands)/i.test(o.name)) cardMeshes.push(o);
    if (/^Scalp/i.test(o.name)) { scalpMesh = scalpMesh || o; isAriel = true; }
    else if (/^[A-Za-z]+_Scalp$/.test(o.name)) scalpMesh = scalpMesh || o;   // e.g. Emma_Scalp (attaches only with character:true)
    if (/^Ariel/i.test(o.name)) isAriel = true;
  });
  // opts.character: explicit opt-in for another groomed character (e.g. the Madison doll, ui/dm-bt-engineering.js)
  if (!isAriel && !opts.character && !CFG.character) throw new Error('[hair] character is not Ariel (no Scalp/Ariel mesh, different character file) - strands not attached');

  /* ---------------- bones + colliders ---------------- */
  const root = CHAR.root;
  const findBone = (n) => (CHAR.bones && CHAR.bones[n]) || root.getObjectByName(n);
  const head = findBone(meta.headBone || 'Head');
  if (!head) throw new Error('[hair] Head bone not found');
  const fileCols = [];
  for (const c of meta.colliders || []) {
    // with the head SDF, the old single head sphere is replaced (it was smaller than the
    // skull at the back/crown and bulged past it above the ears)
    if (SDF && c.bone === (meta.headBone || 'Head')) continue;
    const b = findBone(c.bone);
    if (b) fileCols.push({ bone: b, a: new THREE.Vector3(...c.a), b: new THREE.Vector3(...c.b), r: c.r,
                       wa: new THREE.Vector3(), wb: new THREE.Vector3() });
  }
  const BODY = CFG.body || [
    ['Spine01', 'Spine', 0.125], ['Spine', 'neck', 0.125], ['Spine02', 'Spine01', 0.125],
    ['LeftShoulder', 'LeftArm', 0.06], ['RightShoulder', 'RightArm', 0.06],
    ['LeftArm', 'LeftForeArm', 0.052], ['RightArm', 'RightForeArm', 0.052],
    ['LeftForeArm', 'LeftHand', 0.042], ['RightForeArm', 'RightHand', 0.042],
    ['LeftHand', null, 0.05], ['RightHand', null, 0.05],
    ['Hips', 'Spine02', 0.14],
  ];
  // body capsule list -> colliders. Entry: [bone, childBone|null, radius]  (segment from the bone to its direct child, as always)
  //                                    or {bone, a:[x,y,z], b:[x,y,z], r}   (free segment in the bone's own frame: neck / shoulder / chest fits)
  const buildBody = (list) => {
    const out = [];
    if (!(opts.params ? opts.params.bodyColliders !== false : true)) return out;
    const skip = (opts.params && opts.params.bodyExclude) || [];
    for (const en of list) {
      const obj = !Array.isArray(en), bn = obj ? en.bone : en[0];
      if (skip.includes(bn)) continue;
      const b = findBone(bn); if (!b) continue;
      const a = new THREE.Vector3(0, 0, 0), e = new THREE.Vector3(0, 0, 0);
      if (obj) { if (en.a) a.fromArray(en.a); if (en.b) e.fromArray(en.b); }
      else { const cn = en[1]; if (cn) { const c = findBone(cn); if (!c) continue; e.copy(c.position); if (c.parent !== b) continue; } }
      out.push({ bone: b, a, b: e, r: obj ? en.r : en[2], wa: new THREE.Vector3(), wb: new THREE.Vector3() });
    }
    return out;
  };
  /* ---- collision quality tiers (docs/hair-collision-notes.md) ----
     Tier 0 (Low) = the original solver, bit-identical: file colliders + BODY capsules, head SDF, capsules on the last iteration.
     Tier 1 (Mid) and tier 2 (High) add, from CFG.collision (per character data): a refitted capsule list that follows the skinned bones,
     keep-out boxes (glasses lenses / frame), a per-point margin for the child strands each guide carries (bundle radius, per cluster scale),
     capsules + boxes on every iteration; tier 2 also tests segment midpoints (tessellation) and keeps neighbouring guides apart. */
  const COLL = CFG.collision || {};
  const sets = [];
  const mkSet = (cols, boxes) => ({ cols, n: cols.length, buf: new Float32Array(cols.length * 7), sph: new Float32Array(cols.length * 8), hit: new Uint16Array(Math.max(1, cols.length)), gl: new Uint16Array(Math.max(1, cols.length)), bgl: new Uint16Array(Math.max(1, boxes.length)),
    boxes, nb: boxes.length, bbuf: new Float32Array(Math.max(1, boxes.length) * BOXS), bhit: new Uint16Array(Math.max(1, boxes.length)) });
  {
    let list = BODY;
    sets[0] = mkSet(fileCols.concat(buildBody(BODY)), []);
    for (let t = 1; t <= 2; t++) {
      const L = COLL.capsules && (COLL.capsules[t] || COLL.capsules[String(t)]); if (L) list = L;
      const boxes = [];
      for (const bx of COLL.boxes || []) {
        if ((bx.tier ?? 1) > t) continue;
        const b = findBone(bx.bone || meta.headBone || 'Head'); if (!b) continue;
        boxes.push({ bone: b, c: new THREE.Vector3(...bx.c), h: bx.h.slice(), m: bx.margin || 0, name: bx.name || '' });
      }
      sets[t] = mkSet((COLL.fileColliders === false ? [] : fileCols).concat(buildBody(list)), boxes);   // collision.fileColliders:false = the tier's own capsule list replaces the groom file's neck / chest / shoulder capsules
    }
  }
  let CS = sets[0], cols = CS.cols, nCols = CS.n, colBuf = CS.buf, colSph = CS.sph, colHit = CS.hit;   // active collider set (tier), swapped in _update
  const nCols0 = sets[0].n;   // the GPU guide solver only knows the tier-0 capsule set

  /* ---------------- params ---------------- */
  const P = {
    enabled: true, gravity: 6.0, damping: 0.965,
    shapeStiffness: 0.6, tipStiffness: 0.02,        // weak global groom spring (head frame)
    bendRoot: 0.5, bendTip: 0.04,                  // local bending: combed at the root, drapes toward tips
    stretchBias: 0.5,                                // parent share of a length correction (root side heavier)
    wind: new THREE.Vector3(0, 0, 0), windGust: 0.35, iterations: 2, reach: 0.08, hairRadius: 0.006,
    minClear: 0.002, maxClear: 0.02, sdfEvery: 1, capsuleEveryIteration: false, broadPhase: true, friction: 0.35, collideChildren: true,
    // (t1645u) soft, damped contacts (softBand m, softK share per pass): body capsules get a compliant cushion just OUTSIDE their contact distance
    // (strands decelerate onto shoulders / torso / arms over a few passes instead of hitting a wall; nothing rests inside the capsule), the scalp SDF a soft
    // layer just INSIDE the groom clearance (hard floor = clearance - band, >= 40 % of it, always outside the head).  Every push also moves the previous
    // position (no injected velocity) and friction applies, so contacts are damped.  softBand 0 = the old rigid projection (?hairsoft=0); softHead:false
    // = rigid scalp only.  contactSpacing: at tier 2 every segment is tested at ceil(restLength / contactSpacing) - 1 interior points (1..3), so long
    // segments cannot chord through an ear / shoulder between samples.  All load-time tables; zero per-frame allocation.
    softBand: 0.0025, softK: 0.4, contactSpacing: 0.016,
    maxRootStep: 0.06, hitchMs: 250, settleTime: 0.45, maxDeflect: 2.5, drag: 1.6, motionWind: 0.05, maxMotionWind: 14, teleportSpeed: 400, popSpeed: 22, bodyColliders: true,
    minGravityScale: 0.0, interleave: 1, autoQuality: true, strandFraction: 1, scalpSheenOff: true,
    deferToRender: true,   // hooked mode: simulate in the strands' onBeforeRender, after every pose layer (see hook below)
    widthRoot: 0.0046, widthTip: 0.0022,
    ...(meta.widthRoot ? { widthRoot: meta.widthRoot } : {}), ...(meta.widthTip ? { widthTip: meta.widthTip } : {}),   // groom-file width hints (Ariel's file has none: her params unchanged)
    ...CFG.params,
    ...(opts.params || {})
  };
  // finer strands need more constraint passes to keep the file resolution's drape length / stiffness and contact quality (tools/tests/hair-collision.js
  // High+20: Ariel 14->20 pts x 4 passes 555 -> 546 crossings, Emma 16->20 x 4 575 -> 571, head-SDF points 1101 -> 1076; at 3 passes both got worse).
  // The extra passes run only at collision tier 2 (studio / menu / High-Ultra); when the frame-budget ladder drops hair to Low the file's pass count is used.
  if (typeof location !== 'undefined' && /[?&]hairsoft=0\b/.test(location.search || '')) P.softBand = 0;
  if (K > K0 && !(opts.params && opts.params.iterations != null)) { P.iterationsFine = P.iterationsFine || (P.iterations | 0) * 2; P.iterations = Math.max(P.iterations | 0, Math.ceil((P.iterations | 0) * K / K0 / 1.25)); }
  if (opts.strandFraction != null) P.strandFraction = opts.strandFraction;
  if (opts.getStrandFraction) { try { const f = +opts.getStrandFraction(); if (f > 0) P.strandFraction = Math.min(1, f); } catch (e) {} }

  /* ---------------- SDF sampling (head-local), gradient into sg ---------------- */
  const sg = new Float32Array(3);
  const FAR = 1e9;
  function sdf(x, y, z) {
    const S = SDF;
    const fx = (x - S.ox) * S.inv, fy = (y - S.oy) * S.inv, fz = (z - S.oz) * S.inv;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= S.nx - 1 || fy >= S.ny - 1 || fz >= S.nz - 1) return FAR;
    const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k;
    const nz = S.nz, nyz = S.ny * nz, v = S.v, b = (i * S.ny + j) * nz + k;
    const c000 = v[b], c001 = v[b + 1], c010 = v[b + nz], c011 = v[b + nz + 1];
    const c100 = v[b + nyz], c101 = v[b + nyz + 1], c110 = v[b + nyz + nz], c111 = v[b + nyz + nz + 1];
    const ux = 1 - tx, uy = 1 - ty, uz = 1 - tz;
    const c00 = c000 * uz + c001 * tz, c01 = c010 * uz + c011 * tz, c10 = c100 * uz + c101 * tz, c11 = c110 * uz + c111 * tz;
    const c0 = c00 * uy + c01 * ty, c1 = c10 * uy + c11 * ty;
    let gx = c1 - c0;
    let gy = (c01 - c00) * ux + (c11 - c10) * tx;
    let gz = ((c001 - c000) * uy + (c011 - c010) * ty) * ux + ((c101 - c100) * uy + (c111 - c110) * ty) * tx;
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gl > 1e-6) { sg[0] = gx / gl; sg[1] = gy / gl; sg[2] = gz / gl; } else { sg[0] = 0; sg[1] = 1; sg[2] = 0; }
    return (c0 * ux + c1 * tx) * S.unit;
  }
  // groom clearance per point (k >= 1): keep the layer offset the groom has, 2 mm .. 2 cm
  // clearance = 70 % of the groom's own distance (2 mm .. 2 cm); slack^2 = how far a point may be
  // deflected from its groom position before it could possibly reach the head (skips the SDF lookup)
  const clrC = new Float32Array(N * K), slkC = new Float32Array(N * K);
  const clrOf = (x, y, z, i) => {
    if (!SDF) return 0;
    const cc_ = clusterOf(group[(i / K) | 0]).clearance, d = sdf(x, y, z), c = cc_ ? Math.min(cc_.max ?? P.maxClear, Math.max(cc_.min ?? P.minClear, d * (cc_.scale ?? 0.7))) : Math.min(P.maxClear, Math.max(P.minClear, d * 0.7));
    const sl = d >= FAR ? 1 : Math.max(0, d - c); slkC[i] = sl * sl; return c;
  };
  const kMaxC = new Uint8Array(N);   // last point of each strand that can reach the head (groom within P.reach of it)
  for (let st = 0; st < N; st++) {
    let km = 1;
    for (let k = 1; k < K; k++) {
      const i = st * K + k, x = rest[i * 3], y = rest[i * 3 + 1], z = rest[i * 3 + 2];
      clrC[i] = clrOf(x, y, z, i);
      if (SDF && sdf(x, y, z) < (P.reach || 0.08)) km = k;
    }
    kMaxC[st] = Math.min(K - 1, km + 1);
  }

  /* ---------------- guide rest data ---------------- */
  const GK = G * K;
  // (t1645u) contact samples per guide segment (tier 2): ceil(rest length / contactSpacing) - 1, 1..3 (see the segment pass in the solver)
  const segS = new Uint8Array(GK);
  for (let g = 0; g < G; g++) { const st = guideStrand[g]; for (let k = 1; k < K; k++) { const a0 = (st * K + k - 1) * 3, a1 = (st * K + k) * 3;
    const L = Math.hypot(rest[a1] - rest[a0], rest[a1 + 1] - rest[a0 + 1], rest[a1 + 2] - rest[a0 + 2]); segS[g * K + k] = Math.max(1, Math.min(3, Math.ceil(L / Math.max(1e-3, P.contactSpacing || 0.016)) - 1)); } }
  const gRest = new Float32Array(GK * 3);
  const segLen = new Float32Array(G * (K - 1));
  const bendLen = new Float32Array(GK);   // |p_k - p_(k-2)| in the groom: symmetric bending constraint
  const gStiff = new Float32Array(GK), gBend = new Float32Array(GK), clrG = new Float32Array(GK), slkG = new Float32Array(GK);
  const gNear = new Uint8Array(GK);   // point can be near the head (rest within SDF box + slack)
  function buildStiffness() {
    for (let g = 0; g < G; g++) {
      const s = guideStrand[g];
      const cl = clusterOf(group[s]), boost = cl.stiffBoost ?? 1.0, bboost = cl.bendBoost ?? boost;   // e.g. Ariel's bangs / sideburns are short: hold shape harder
      for (let k = 0; k < K; k++) {
        const t = k / (K - 1), u = 1 - t;
        gStiff[g * K + k] = Math.min(0.9, (P.tipStiffness + (P.shapeStiffness - P.tipStiffness) * u * u * u * u) * boost);
        gBend[g * K + k] = Math.min(0.9, (P.bendTip + (P.bendRoot - P.bendTip) * u * u) * bboost);
      }
    }
  }
  for (let g = 0; g < G; g++) {
    const s = guideStrand[g];
    for (let k = 0; k < K * 3; k++) gRest[g * K * 3 + k] = rest[s * K * 3 + k];
    for (let k = 1; k < K; k++) {
      const a = (g * K + k - 1) * 3, b = (g * K + k) * 3;
      segLen[g * (K - 1) + k - 1] = Math.hypot(gRest[b] - gRest[a], gRest[b + 1] - gRest[a + 1], gRest[b + 2] - gRest[a + 2]);
      if (k >= 2) { const c = (g * K + k - 2) * 3; bendLen[g * K + k] = Math.hypot(gRest[b] - gRest[c], gRest[b + 1] - gRest[c + 1], gRest[b + 2] - gRest[c + 2]); }
    }
    for (let k = 0; k < K; k++) {
      const i = s * K + k; clrG[g * K + k] = clrC[i]; slkG[g * K + k] = slkC[i];
      gNear[g * K + k] = 1;   // any free point may swing into the head; sdf() rejects far points cheaply
    }
  }
  buildStiffness();
  // child-bundle margin (tier >= 1): a child strand is its guide's point plus a constant head-frame offset, so a guide kept `bundle` further
  // from a collider keeps all its children out of it too (children are not collided against capsules / boxes themselves).
  // Per point: min(cap, widest child offset of the guide at that point x bundle scale x cluster.collisionMargin) + cluster.collisionExtra.
  const mrgG = new Float32Array(GK); let mrgMax = 0;
  {
    const bun = new Float32Array(GK), mc = COLL.margin || {}, cap = mc.cap ?? 0.012, bsc = mc.bundle ?? 1;
    for (let st = 0; st < N; st++) {
      const g = guideOf[st];
      for (let k = 2; k < K; k++) { const o = (st * K + k) * 3, q = (g * K + k) * 3, d = Math.hypot(rest[o] - gRest[q], rest[o + 1] - gRest[q + 1], rest[o + 2] - gRest[q + 2]); if (d > bun[g * K + k]) bun[g * K + k] = d; }
    }
    for (let g = 0; g < G; g++) {
      const cl = clusterOf(group[guideStrand[g]]), cm = cl.collisionMargin ?? 1, ex = cl.collisionExtra ?? 0;
      for (let k = 2; k < K; k++) { const m = Math.min(cap, bun[g * K + k] * bsc * cm) + ex; mrgG[g * K + k] = m; if (m > mrgMax) mrgMax = m; }
    }
  }
  // neighbour guides (tier 2): per guide its 3 nearest guides of the same cluster (rest chain-middle distance) -> min-distance pairs. Built on first use.
  let sepPairs = null;   // { n, a: Uint32Array, b: Uint32Array, min: Float32Array(n*K) }
  function ensureSep() {
    if (sepPairs) return sepPairs;
    const NB = (COLL.separation && COLL.separation.neighbours) || 3, frac = (COLL.separation && COLL.separation.frac) ?? 0.6, kq = Math.min(K - 1, (K * 0.5) | 0);
    const seen = new Set(), pa = [], pb = [];
    const mid = new Float32Array(G * 3); for (let g = 0; g < G; g++) { const o = (g * K + kq) * 3; mid[g * 3] = gRest[o]; mid[g * 3 + 1] = gRest[o + 1]; mid[g * 3 + 2] = gRest[o + 2]; }
    const gg = new Uint8Array(G); for (let g = 0; g < G; g++) gg[g] = group[guideStrand[g]];
    const bd = new Float32Array(NB), bi = new Int32Array(NB);
    for (let g = 0; g < G; g++) {
      bd.fill(1e9); bi.fill(-1);
      for (let h = 0; h < G; h++) {
        if (h === g || gg[h] !== gg[g]) continue;
        const d = (mid[g * 3] - mid[h * 3]) ** 2 + (mid[g * 3 + 1] - mid[h * 3 + 1]) ** 2 + (mid[g * 3 + 2] - mid[h * 3 + 2]) ** 2;
        if (d < bd[NB - 1]) { let j = NB - 1; while (j > 0 && bd[j - 1] > d) { bd[j] = bd[j - 1]; bi[j] = bi[j - 1]; j--; } bd[j] = d; bi[j] = h; }
      }
      for (let j = 0; j < NB; j++) { const h = bi[j]; if (h < 0) continue; const key = g < h ? g * G + h : h * G + g; if (seen.has(key)) continue; seen.add(key); pa.push(g); pb.push(h); }
    }
    const n = pa.length, min = new Float32Array(n * K), hr2 = P.hairRadius;
    for (let i = 0; i < n; i++) for (let k = 2; k < K; k++) {
      const a = (pa[i] * K + k) * 3, b = (pb[i] * K + k) * 3, d = Math.hypot(gRest[a] - gRest[b], gRest[a + 1] - gRest[b + 1], gRest[a + 2] - gRest[b + 2]);
      min[i * K + k] = d > hr2 * 0.8 ? Math.max(d * frac, hr2 * 0.6) : 0;   // strands that start closer than a hair radius are one clump: leave them
    }
    return (sepPairs = { n, a: Uint32Array.from(pa), b: Uint32Array.from(pb), min });
  }
  const gLen = new Float32Array(G);   // chain length per guide (runaway bound for the blow-up guard)
  for (let g = 0; g < G; g++) { let l = 0; for (let k = 0; k < K - 1; k++) l += segLen[g * (K - 1) + k]; gLen[g] = l; }
  let stiffDirty = false;
  const kMaxG = new Uint8Array(G);
  for (let g = 0; g < G; g++) kMaxG[g] = kMaxC[guideStrand[g]];
  const sp = new Float32Array(GK * 3);      // sim position (root-local)
  const sq = new Float32Array(GK * 3);      // previous position
  const restM = new Float32Array(GK * 3);   // guide rest in root-local (current head pose)

  /* ---------------- (v379) skin-following head collision (scalp / head / neck / shoulder skin) ----------------
     The head SDF and the pinned roots live in the HEAD bone frame, which is exact for a scalp that is 100 % Head-weighted (Ariel: Scalp 21,719 verts,
     all Head).  Emma's scalp (2,740 verts) and the neck / nape skin under her hair are blended to neck / Jaw / shoulders / Spine (1,003 scalp verts), so
     as soon as her neck bends the real skin slides away from the head-frame SDF and strands sink into it (tools/tests/hair-scalp.js: 2,523 scalp
     crossings in idle / head turn / run before this).  Fix: a load-time SKIN-WEIGHT FIELD over the SDF box (every skinned mesh piece the hair can touch:
     scalp, head, face, neck, shoulders, collar), 5 mm nodes, each node = the distance-weighted blend of the nearby vertices' non-Head bone weights (top 2).
     Per frame: one 3x4 delta matrix per bone slot (A_j - I, head-local).  The SDF is then read in BIND space (q = x - sum w_j (A_j - I) x), so the
     collision surface rides the skinned scalp / neck exactly where the mesh bends, and the guide / child roots are carried by the same field.
     OPT-IN per groom: only a character config with params.skinWarp === true (characterassests/emma/emma_hair_config.json) builds it; every other groom
     (Ariel, made-up configs) builds nothing and stays bit-identical (stats.skinWarp null).  ?hairwarp=0 forces it off.  Zero per-frame allocation. */
  const WARP = (() => {
    if (!SDF || P.skinWarp !== true) return null;
    if (typeof location !== 'undefined' && /[?&]hairwarp=0\b/.test(location.search || '')) return null;
    const WC = 0.005, R = 0.014, R2 = R * R;
    const ox = SDF.ox, oy = SDF.oy, oz = SDF.oz, ex = (SDF.nx - 1) / SDF.inv, ey = (SDF.ny - 1) / SDF.inv, ez = (SDF.nz - 1) / SDF.inv;
    const nx = Math.ceil(ex / WC) + 1, ny = Math.ceil(ey / WC) + 1, nz = Math.ceil(ez / WC) + 1, NN = nx * ny * nz;
    const slots = [], slotOf = new Map(), MAXS = 8;
    const pts = [];   // [x, y, z, (slot, w) x up to 4] bind head-local
    const v4 = new THREE.Vector4(), vp = new THREE.Vector3(), Mb = new THREE.Matrix4();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isSkinnedMesh || !o.skeleton || !o.geometry || !o.geometry.attributes.skinIndex) return;
      const bonesS = o.skeleton.bones, hi = bonesS.indexOf(head); if (hi < 0) return;
      Mb.multiplyMatrices(o.skeleton.boneInverses[hi], o.bindMatrix);   // mesh bind -> bind head-local (the SDF / groom frame)
      const Pp = o.geometry.attributes.position, SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight;
      for (let i = 0; i < Pp.count; i++) {
        vp.fromBufferAttribute(Pp, i).applyMatrix4(Mb);
        if (vp.x < ox - R || vp.y < oy - R || vp.z < oz - R || vp.x > ox + ex + R || vp.y > oy + ey + R || vp.z > oz + ez + R) continue;
        const e = [vp.x, vp.y, vp.z];
        v4.fromBufferAttribute(SI, i); const ii = [v4.x, v4.y, v4.z, v4.w]; v4.fromBufferAttribute(SW, i); const ww = [v4.x, v4.y, v4.z, v4.w];
        for (let c = 0; c < 4; c++) { const b = bonesS[ii[c]]; if (!b || b === head || !(ww[c] > 0.004)) continue;
          let s = slotOf.get(b);
          if (s == null) { if (slots.length >= MAXS) continue; s = slots.length; slotOf.set(b, s); slots.push({ bone: b, C: new THREE.Matrix4().multiplyMatrices(o.skeleton.boneInverses[ii[c]], new THREE.Matrix4().copy(o.skeleton.boneInverses[hi]).invert()) }); }
          e.push(s, ww[c]); }
        pts.push(e);
      }
    });
    if (!slots.length) return null;
    const S = slots.length, acc = new Float32Array(NN * S), wsum = new Float32Array(NN), rc = Math.ceil(R / WC);
    for (const e of pts) {
      const ci = Math.round((e[0] - ox) / WC), cj = Math.round((e[1] - oy) / WC), ck = Math.round((e[2] - oz) / WC);
      for (let i = Math.max(0, ci - rc); i <= Math.min(nx - 1, ci + rc); i++) for (let j = Math.max(0, cj - rc); j <= Math.min(ny - 1, cj + rc); j++) for (let k = Math.max(0, ck - rc); k <= Math.min(nz - 1, ck + rc); k++) {
        const dx = ox + i * WC - e[0], dy = oy + j * WC - e[1], dz = oz + k * WC - e[2], d2 = dx * dx + dy * dy + dz * dz; if (d2 >= R2) continue;
        const q = 1 - d2 / R2, g = q * q, n = (i * ny + j) * nz + k; wsum[n] += g;
        for (let t = 3; t < e.length; t += 2) acc[n * S + e[t]] += g * e[t + 1];
      }
    }
    const sl = new Uint8Array(NN * 2).fill(255), wt = new Float32Array(NN * 2); let used = 0;
    for (let n = 0; n < NN; n++) { const W = wsum[n]; if (!(W > 0)) continue; let b0 = -1, b1 = -1, w0 = 0, w1 = 0;
      for (let s = 0; s < S; s++) { const w = acc[n * S + s] / W; if (w > w0) { b1 = b0; w1 = w0; b0 = s; w0 = w; } else if (w > w1) { b1 = s; w1 = w; } }
      if (w0 > 0.002) { sl[n * 2] = b0; wt[n * 2] = w0; used++; } if (w1 > 0.002) { sl[n * 2 + 1] = b1; wt[n * 2 + 1] = w1; } }
    if (!used) return null;
    return { WC, ox, oy, oz, nx, ny, nz, sl, wt, slots, D: new Float32Array(S * 12), tm: new THREE.Matrix4(), hInv: new THREE.Matrix4(), on: false, nodes: used, verts: pts.length };
  })();
  // node index of a head-local point (-1 = outside the field / no skin blend there)
  function warpNode(x, y, z) {
    const W = WARP, i = Math.round((x - W.ox) / W.WC), j = Math.round((y - W.oy) / W.WC), k = Math.round((z - W.oz) / W.WC);
    if (i < 0 || j < 0 || k < 0 || i >= W.nx || j >= W.ny || k >= W.nz) return -1;
    const n = (i * W.ny + j) * W.nz + k; return W.sl[n * 2] === 255 ? -1 : n;
  }
  // skin displacement at node n for head-local point (x, y, z) -> wd[0..2] (head-local, = sum w_j (A_j - I) p)
  const wd = new Float32Array(3);
  function warpDisp(n, x, y, z) {
    const W = WARP, D = W.D; wd[0] = wd[1] = wd[2] = 0;
    for (let c = 0; c < 2; c++) { const s = W.sl[n * 2 + c]; if (s === 255) continue; const w = W.wt[n * 2 + c], o = s * 12;
      wd[0] += w * (D[o] * x + D[o + 1] * y + D[o + 2] * z + D[o + 3]);
      wd[1] += w * (D[o + 4] * x + D[o + 5] * y + D[o + 6] * z + D[o + 7]);
      wd[2] += w * (D[o + 8] * x + D[o + 9] * y + D[o + 10] * z + D[o + 11]); }
  }
  // per frame: A_j = HeadW^-1 . Bone_j W . (boneInverse_j . boneInverse_head^-1), stored as A_j - I (rows); W.on = any bone moved off the head frame
  function warpFrame() {
    const W = WARP; if (!W) return; W.hInv.copy(head.matrixWorld).invert(); let mx = 0;
    for (let s = 0; s < W.slots.length; s++) { const Sl = W.slots[s]; W.tm.multiplyMatrices(W.hInv, Sl.bone.matrixWorld).multiply(Sl.C); const e = W.tm.elements, o = s * 12;
      W.D[o] = e[0] - 1; W.D[o + 1] = e[4]; W.D[o + 2] = e[8]; W.D[o + 3] = e[12];
      W.D[o + 4] = e[1]; W.D[o + 5] = e[5] - 1; W.D[o + 6] = e[9]; W.D[o + 7] = e[13];
      W.D[o + 8] = e[2]; W.D[o + 9] = e[6]; W.D[o + 10] = e[10] - 1; W.D[o + 11] = e[14];
      for (let q = 0; q < 12; q++) { const a = Math.abs(W.D[o + q]); if (a > mx) mx = a; } }
    W.on = mx > 1e-5;
  }
  // roots carried by the field: per guide the node at its root (or -1); a child strand takes its guide's root displacement with its deflection
  const wNodeG = WARP ? new Int32Array(G).fill(-1) : null;
  const wG = new Float32Array(G * 3);   // per guide: root skin displacement, root-local (added to its rest; children read it with their guide's deflection)
  if (WARP) for (let g = 0; g < G; g++) wNodeG[g] = warpNode(gRest[g * K * 3], gRest[g * K * 3 + 1], gRest[g * K * 3 + 2]);
  let needInit = true;

  const SP = new Float32Array(K * 3);
  // static rest-pose radial direction (head-local) per point -> volumetric normals without per-frame sqrt
  const radial = new Float32Array(N * K * 3);
  { const hc = meta.headCenter || [0, 0.11, -0.03];
    for (let i = 0; i < N * K; i++) { const o = i * 3; let x = rest[o] - hc[0], y = rest[o + 1] - hc[1], z = rest[o + 2] - hc[2]; const l = Math.hypot(x, y, z) || 1; radial[o] = x / l; radial[o + 1] = y / l; radial[o + 2] = z / l; } }

  /* ---------------- render mesh ---------------- */
  const VERTS = N * K * 2;
  const pos = new Float32Array(VERTS * 3);
  const nrm = new Float32Array(VERTS * 3);
  const idx = new Uint32Array(N * (K - 1) * 6);
  let ii = 0;
  for (let s = 0; s < N; s++) {
    for (let k = 0; k < K - 1; k++) {
      const a = (s * K + k) * 2, b = a + 1, c = a + 2, d = a + 3;
      idx[ii++] = a; idx[ii++] = b; idx[ii++] = c; idx[ii++] = b; idx[ii++] = d; idx[ii++] = c;
    }
  }
  const col = new Float32Array(VERTS * 3);
  const base = meta.color || [0.005, 0.005, 0.006];
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const GR0 = meta.gradient, GR = GR0;   // optional root→tip colour (+ streak strands), e.g. Madison's blue→violet yarn
  const wScale = new Float32Array(N); let anyW = false;
  for (let s = 0; s < N; s++) {
    const CL = clusterOf(group[s]), jit = CL.colorJitter || [0.75, 1.65], GR = CL.gradient || GR0, bs = CL.color || base;
    const v = jit[0] + rnd() * (jit[1] - jit[0]);
    const KC = clumpOf && CFG.clumps ? CFG.clumps[meta.clusters[clumpOf[s]]] : null;
    const tn = (KC && KC.tint) || [1, 1, 1];
    wScale[s] = (CL.widthScale ?? 1) * ((KC && KC.widthScale) ?? 1); if (wScale[s] !== 1) anyW = true;
    if (GR) {
      const streak = rnd() < (GR.streakFrac || 0), tip = streak && GR.streak ? GR.streak : GR.tip, t0 = streak ? (GR.streakStart ?? 0.3) : (GR.tipStart ?? 0.45);
      const vv = 0.85 + (v - 0.75) * 0.35;
      for (let k = 0; k < K * 2; k++) {
        const t = Math.max(0, Math.min(1, ((k >> 1) / (K - 1) - t0) / (1 - t0))), w = t * t * (3 - 2 * t), o = (s * K * 2 + k) * 3;
        for (let c = 0; c < 3; c++) col[o + c] = (GR.root[c] * (1 - w) + tip[c] * w) * vv * tn[c];
      }
      continue;
    }
    for (let k = 0; k < K * 2; k++) { const o = (s * K * 2 + k) * 3; col[o] = bs[0] * v * tn[0]; col[o + 1] = bs[1] * v * tn[1]; col[o + 2] = bs[2] * v * tn[2]; }
  }
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3); aPos.setUsage(THREE.DynamicDrawUsage);
  const aNrm = new THREE.BufferAttribute(nrm, 3); aNrm.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('normal', aNrm);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Runtime recolour (character select / profile, ui/dm-charpaint.js): H.setTint({ clusterName: [r,g,b] linear } | null).  A tinted cluster's base colour is REPLACED by the
  // given one; every strand keeps its own light/dark variation and root->tip gradient (its colour relative to the cluster mean).  null / unlisted = the groomed colours.
  // One pass over the colour buffer + one upload, never per frame; the generated colours above are untouched (colBase), so Ariel's default is identical.
  const colBase = new Float32Array(col), gMean = new Float32Array(256), gCnt = new Float32Array(256), colAttr = geo.getAttribute('color');
  for (let s2 = 0; s2 < N; s2++) { const g = group[s2]; for (let k = 0; k < K * 2; k++) { const o = (s2 * K * 2 + k) * 3; gMean[g] += 0.2126 * colBase[o] + 0.7152 * colBase[o + 1] + 0.0722 * colBase[o + 2]; gCnt[g]++; } }
  for (let g = 0; g < 256; g++) gMean[g] = gCnt[g] ? gMean[g] / gCnt[g] : 0;
  const groupName = (g) => (CFG.clusters[g] && CFG.clusters[g].name) || (Array.isArray(meta.groups) && meta.groups[g]) || ('g' + g);
  function setTint(map) {
    const by = new Array(256).fill(null); let any = false;
    if (map) for (let g = 0; g < 256; g++) { const t = map[groupName(g)]; if (t && t.length >= 3) { by[g] = t; any = true; } }
    for (let s2 = 0; s2 < N; s2++) {
      const t = by[group[s2]], m = gMean[group[s2]];
      for (let k = 0; k < K * 2; k++) {
        const o = (s2 * K * 2 + k) * 3;
        if (!t || !(m > 1e-6)) { col[o] = colBase[o]; col[o + 1] = colBase[o + 1]; col[o + 2] = colBase[o + 2]; continue; }
        const r = Math.max(0.35, Math.min(2.4, (0.2126 * colBase[o] + 0.7152 * colBase[o + 1] + 0.0722 * colBase[o + 2]) / m));
        col[o] = t[0] * r; col[o + 1] = t[1] * r; col[o + 2] = t[2] * r;
      }
    }
    colAttr.needsUpdate = true; return any;
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // meta.fuzz (optional, e.g. Madison's yarn): sheen on the strands, and on the GPU path a soft alpha-hashed fringe
  // across each ribbon's width. Ariel's file has no fuzz block, so her material is unchanged.
  const FZ = meta.fuzz || null;
  const mat = new (FZ && THREE.MeshPhysicalMaterial ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({
    vertexColors: true, color: 0xffffff, roughness: meta.roughness ?? 0.86, metalness: meta.metalness ?? 0,
    side: THREE.DoubleSide, envMapIntensity: 0
  });
  if ('specularIntensity' in mat) mat.specularIntensity = 0.16;
  if ('sheen' in mat && !FZ) { mat.sheen = 0; if (mat.sheenRoughness != null) mat.sheenRoughness = 1; }
  mat.envMap = null;
  // fuzz.glow: a little self-light from the strand colour so dark yarn still reads in a dim room (no lights added)
  if (FZ && FZ.glow && GR && mat.emissive) { mat.emissive.setRGB((GR.root[0] + GR.tip[0]) / 2, (GR.root[1] + GR.tip[1]) / 2, (GR.root[2] + GR.tip[2]) / 2); mat.emissiveIntensity = FZ.glow; }
  if (FZ && 'sheen' in mat) { mat.sheen = FZ.sheen ?? 0.8; mat.sheenRoughness = FZ.sheenRoughness ?? 0.5; if (FZ.sheenColor) mat.sheenColor.setRGB(...FZ.sheenColor); }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = (CFG.name || 'Ariel') + 'HairStrands';
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
  const camPos = new THREE.Vector3();
  let haveCam = false;
  // Deferred step (hooked mode): the game turns and levels her head AFTER the mixer update while
  // she rides (applySkyboardHeadOverride, up to 1.5 rad), so a sim run inside mixer.update saw the
  // pre-override head and the strands floated off the rotated scalp. Running the step here, after
  // the renderer has updated every world matrix, always matches the skinned scalp being drawn.
  let pendingDt = 0, renderSeen = false;
  // frame-stall recovery: a wall-clock gap > P.hitchMs between mixer updates means the game clamped dt
  // but the character still travelled the whole stall; reseed to the groom and hold the motion-driven
  // terms (inertial shift, apparent wind) for P.settleTime so nothing is flung out of the head
  let lastWall = 0, hitch = false, settleT = 0, resanitized = 0;
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const pM = new Float32Array(16); let havePM = false, headMoved = true;
  mesh.onBeforeRender = function (renderer, scene, camera) {
    camera.getWorldPosition(camPos); haveCam = true; renderSeen = true;
    if (gpu === null) gpu = initGPU(renderer);
    if (gc === null && gpu) gc = initCompute(renderer);
    if (pendingDt > 0) { const d = pendingDt; pendingDt = 0; try { update(d); } catch (e) { if (!H._warned) { H._warned = 1; console.warn('[hair] update', e); } } }
  };
  root.add(mesh);

  /* ---------------- GPU ribbons (WebGPURenderer + TSL, either backend) ----------------
     The guide PBD stays on the CPU (19,810 points, bit-identical drape / wind / collisions).
     Everything per child (5,665 x 14 points: rest groom + guide deflection, head-SDF push-out,
     camera-facing width, volumetric normal) is evaluated in the vertex shader from static
     textures; per frame only the guide deflection texture (G x K RGBA32F, ~310 KB) is rewritten
     in place. Classic WebGLRenderer hosts (Rig Viewer) keep the CPU ribbon path below. */
  let gpu = null;   // null = undecided, false = CPU ribbons, object = GPU ribbons
  function initGPU(renderer) {
    const T = THREE.TSL;
    if (!renderer || !renderer.isWebGPURenderer || !T || !THREE.MeshStandardNodeMaterial || P.gpuRibbons === false) return false;
    try {
      const { Fn, If, float, int, ivec2, vec3, vec4, uniform, attribute, textureLoad, normalLocal, select } = T;
      const mkTex = (data, w, h, fmt) => { const t = new THREE.DataTexture(data, w, h, fmt, THREE.FloatType); t.needsUpdate = true; t.userData.hair = 1; return t; };
      const restT = new Float32Array(N * K * 4), radT = new Float32Array(N * K * 4);
      for (let i = 0; i < N * K; i++) {
        restT[i * 4] = rest[i * 3]; restT[i * 4 + 1] = rest[i * 3 + 1]; restT[i * 4 + 2] = rest[i * 3 + 2]; restT[i * 4 + 3] = clrC[i];
        radT[i * 4] = radial[i * 3]; radT[i * 4 + 1] = radial[i * 3 + 1]; radT[i * 4 + 2] = radial[i * 3 + 2]; radT[i * 4 + 3] = slkC[i];
      }
      const tRest = mkTex(restT, K, N, THREE.RGBAFormat), tRad = mkTex(radT, K, N, THREE.RGBAFormat);
      const disp = new Float32Array(G * K * 4);
      const tDisp = mkTex(disp, K, G, THREE.RGBAFormat);
      const SW = 2048;
      let tSdf = null, sdfRows = 1;
      if (SDF) {
        const n = SDF.nx * SDF.ny * SDF.nz; sdfRows = Math.ceil(n / SW);
        const d = new Float32Array(SW * sdfRows); for (let i = 0; i < n; i++) d[i] = SDF.v[i];
        tSdf = mkTex(d, SW, sdfRows, THREE.RedFormat);
      } else tSdf = mkTex(new Float32Array(1), 1, 1, THREE.RedFormat);
      // static per-vertex data: (strand, point, side), (guide, last collidable point)
      const ids = new Float32Array(VERTS * 3), gk = new Float32Array(VERTS * 2);
      for (let st = 0; st < N; st++) for (let k = 0; k < K; k++) for (let sd = 0; sd < 2; sd++) {
        const v = (st * K + k) * 2 + sd; ids[v * 3] = st; ids[v * 3 + 1] = k; ids[v * 3 + 2] = sd ? 1 : -1; gk[v * 2] = guideOf[st]; gk[v * 2 + 1] = kMaxC[st];
      }
      const U = {
        M: uniform(new THREE.Matrix4()), Mi: uniform(new THREE.Matrix4()), cam: uniform(new THREE.Vector3()),
        hc: uniform(new THREE.Vector3()), hcR2: uniform(0), hsc2: uniform(1), wR: uniform(P.widthRoot), wT: uniform(P.widthTip), cc: uniform(0)
      };
      const S0 = SDF || { ox: 0, oy: 0, oz: 0, inv: 1, nx: 2, ny: 2, nz: 2, unit: 1 };
      const sdfAt = (b) => textureLoad(tSdf, ivec2(b.mod(int(SW)), b.div(int(SW)))).x;
      // exact port of headCollide() for one root-local point (same trilinear value + gradient)
      const collide = (p, clr) => {
        const out = p.toVar();
        const e = p.sub(U.hc);
        If(e.dot(e).lessThanEqual(U.hcR2), () => {
          const h = U.Mi.mul(vec4(p, 1)).xyz.toVar();
          const f = h.sub(vec3(S0.ox, S0.oy, S0.oz)).mul(S0.inv).toVar();
          If(f.x.greaterThanEqual(0).and(f.y.greaterThanEqual(0)).and(f.z.greaterThanEqual(0))
            .and(f.x.lessThan(S0.nx - 1)).and(f.y.lessThan(S0.ny - 1)).and(f.z.lessThan(S0.nz - 1)), () => {
            const fi = f.floor(), t = f.sub(fi), u = vec3(1).sub(t);
            const i = int(fi.x), j = int(fi.y), kk = int(fi.z);
            const nz = int(S0.nz), nyz = int(S0.ny * S0.nz);
            const b = i.mul(int(S0.ny)).add(j).mul(nz).add(kk).toVar();
            const c000 = sdfAt(b), c001 = sdfAt(b.add(1)), c010 = sdfAt(b.add(nz)), c011 = sdfAt(b.add(nz).add(1));
            const c100 = sdfAt(b.add(nyz)), c101 = sdfAt(b.add(nyz).add(1)), c110 = sdfAt(b.add(nyz).add(nz)), c111 = sdfAt(b.add(nyz).add(nz).add(1));
            const c00 = c000.mul(u.z).add(c001.mul(t.z)), c01 = c010.mul(u.z).add(c011.mul(t.z));
            const c10 = c100.mul(u.z).add(c101.mul(t.z)), c11 = c110.mul(u.z).add(c111.mul(t.z));
            const c0 = c00.mul(u.y).add(c01.mul(t.y)), c1 = c10.mul(u.y).add(c11.mul(t.y));
            const g = vec3(c1.sub(c0), c01.sub(c00).mul(u.x).add(c11.sub(c10).mul(t.x)),
              c001.sub(c000).mul(u.y).add(c011.sub(c010).mul(t.y)).mul(u.x).add(c101.sub(c100).mul(u.y).add(c111.sub(c110).mul(t.y)).mul(t.x))).toVar();
            const gl = g.length();
            const gn = select(gl.greaterThan(1e-6), g.div(gl), vec3(0, 1, 0));
            const d = c0.mul(u.x).add(c1.mul(t.x)).mul(S0.unit);
            If(d.lessThan(clr), () => { out.assign(U.M.mul(vec4(h.add(gn.mul(clr.sub(d))), 1)).xyz); });
          });
        });
        return out;
      };
      // child point k of strand s (port of the CPU ribbon loop's SP[] fill)
      const point = (s, k, g, kmc) => {
        const r = textureLoad(tRest, ivec2(k, s)), dd = textureLoad(tDisp, ivec2(k, g)).xyz;
        const p = U.M.mul(vec4(r.xyz, 1)).xyz.add(dd).toVar();
        const slk = textureLoad(tRad, ivec2(k, s)).w;
        If(U.cc.greaterThan(0.5).and(k.greaterThanEqual(2)).and(k.lessThanEqual(kmc)).and(dd.dot(dd).greaterThan(slk.mul(U.hsc2))), () => { p.assign(collide(p, r.w)); });
        return p;
      };
      const ribbon = (sF, kF, side, gF, kmF) => {
        const s = int(sF), k = int(kF), g = int(gF), kmc = int(kmF);
        const k0 = k.sub(1).max(0), k1 = k.add(1).min(K - 1);
        const p0 = point(s, k0, g, kmc), p1 = point(s, k1, g, kmc), pk = point(s, k, g, kmc), pr = point(s, int(0), g, kmc);
        const tg = p1.sub(p0), v = U.cam.sub(pk);
        const w = tg.cross(v);
        const wBase = U.wR.add(U.wT.sub(U.wR).mul(float(kF).div(K - 1))), wd = (anyW ? wBase.mul(attribute('hsW', 'float')) : wBase).mul(0.5).div(w.length().max(1e-9));   // anyW: per-cluster width scale (Ariel: graph unchanged)
        const sv = U.cam.sub(pr); const svn = sv.div(sv.length().max(1e-9));
        const rad = textureLoad(tRad, ivec2(k, s)).xyz;
        const n = svn.mul(0.55).add(U.M.mul(vec4(rad, 0)).xyz.mul(0.45));
        return { pos: pk.add(w.mul(wd).mul(side)), nrm: n };
      };
      const aId = attribute('hsId', 'vec3'), aGk = attribute('hsGk', 'vec2');
      const GM = FZ && THREE.MeshPhysicalNodeMaterial ? THREE.MeshPhysicalNodeMaterial : THREE.MeshStandardNodeMaterial;
      const gmat = new GM({ vertexColors: true, color: 0xffffff, roughness: mat.roughness, metalness: mat.metalness, side: THREE.DoubleSide, envMapIntensity: 0 });
      if ('specularIntensity' in gmat) gmat.specularIntensity = ('specularIntensity' in mat ? mat.specularIntensity : 0.16);
      if ('sheen' in gmat && !FZ) { gmat.sheen = 0; if (gmat.sheenRoughness != null) gmat.sheenRoughness = 1; }
      gmat.envMap = null;
      if (FZ) {
        if ('sheen' in gmat) { gmat.sheen = mat.sheen; gmat.sheenRoughness = mat.sheenRoughness; if (mat.sheenColor) gmat.sheenColor.copy(mat.sheenColor); }
        if (FZ.glow && T.vertexColor) gmat.emissiveNode = T.vertexColor().mul(float(FZ.glow));
        if (FZ.fringe && T.smoothstep && T.abs) {   // side is ±1 at the ribbon edges, 0 down the middle: fade the edges
          const f0 = float(1 - FZ.fringe);
          gmat.opacityNode = float(1).sub(T.smoothstep(f0, float(1), T.abs(attribute('hsId', 'vec3').z)));
          gmat.alphaHash = true;
        }
      }
      gmat.positionNode = Fn(() => {
        const R = ribbon(aId.x, aId.y, aId.z, aGk.x, aGk.y);
        normalLocal.assign(R.nrm);
        return R.pos;
      })();
      // swap the geometry to static ids: no dynamic position / normal buffers at all
      geo.setAttribute('hsId', new THREE.BufferAttribute(ids, 3));
      geo.setAttribute('hsGk', new THREE.BufferAttribute(gk, 2));
      if (anyW) { const wv = new Float32Array(VERTS); for (let st = 0; st < N; st++) for (let q = 0; q < K * 2; q++) wv[st * K * 2 + q] = wScale[st]; geo.setAttribute('hsW', new THREE.BufferAttribute(wv, 1)); }
      geo.setAttribute('position', new THREE.BufferAttribute(ids, 3));
      geo.deleteAttribute('normal');
      gmat.colorWrite = mat.colorWrite; gmat.depthWrite = mat.depthWrite;
      mesh.material = gmat; mat.dispose();
      stats.gpu = true; stats.mode = 'gpu';
      return { U, disp, tDisp, ribbon, mat: gmat, textures: [tRest, tRad, tDisp, tSdf] };
    } catch (e) {
      console.warn('[hair] GPU ribbons unavailable, CPU path', e);
      return false;
    }
  }

  /* ---------------- GPU guide solve (WebGPU backend only) ----------------
     The ribbon shader's deflection texture is filled straight from the compute result (GPU->GPU
     copy). Waits until three has created that texture, then hands the current CPU state over, so the
     switch is seamless. Any failure falls back to the CPU solver below. */
  let gc = null;   // null = undecided / waiting, false = CPU solve, object = GPU solve
  let gcTex = null, gcResync = false, gcWasOn = false;
  // v91: OPT-IN until verified on Apple GPUs (v90 lost the hair on iPhone Safari). Enable with
  // params.gpuCompute = true or ?hairgpu=1. Even then it starts in PROBATION: the CPU solver keeps
  // driving the ribbons while the GPU solves the same frames in lockstep; only after a read-back
  // matches (finite, within 5 mm of the CPU) does the GPU take over. Any validation error, device
  // loss, non-finite result, mismatch or read-back timeout -> permanent CPU path. Hair always renders.
  let gcVerified = false, gcProbe = 0, gcCheck = null;
  const gpuOptIn = () => P.gpuCompute === true || (typeof location !== 'undefined' && /[?&]hairgpu=1\b/.test(location.search || ''));
  function gcFail(why, e) {
    if (gc === false) return;
    console.warn('[hair] GPU guide solve disabled (' + why + '), CPU path', e || '');
    stats.gpuFail = why; stats.mode = gpu ? 'gpu' : 'cpu';
    try { if (gc && gc.destroy) gc.destroy(); } catch (x) {}
    gc = false; gcVerified = false;
    if (gcWasOn) needInit = true;   // the CPU state is stale: reseed instead of snapping
    if (gpu && gpu.tDisp) gpu.tDisp.needsUpdate = true;
  }
  function initCompute(renderer) {
    const be = renderer && renderer.backend;
    if (!gpuOptIn() || !be || !be.isWebGPUBackend || !be.device || typeof GPUBufferUsage === 'undefined') return false;
    if (nCols0 > HAIR_GPU_MAX_COLS) return false;
    const dev = be.device, L = dev.limits || {};
    // the solver needs 7 storage buffers, a 64-wide workgroup and a ~1.4 KB uniform block
    if ((L.maxStorageBuffersPerShaderStage || 0) < 7 || (L.maxComputeWorkgroupSizeX || 0) < 64 || (L.maxComputeInvocationsPerWorkgroup || 0) < 64 ||
        (L.maxUniformBufferBindingSize || 0) < 2048 || (L.maxStorageBufferBindingSize || 0) < GK * 32) { stats.gpuFail = 'limits'; return false; }
    const td = be.get && be.get(gpu.tDisp);
    if (!td || !td.texture) return null;   // not uploaded yet: retry next frame (CPU solve meanwhile)
    const T = td.texture;
    // the ribbon texture must be exactly what the copy writes: rgba32float, K x G, single layer, COPY_DST
    if (T.format !== 'rgba32float' || T.width !== K || T.height !== G || (T.depthOrArrayLayers || 1) !== 1 || (typeof GPUTextureUsage !== 'undefined' && T.usage != null && !(T.usage & GPUTextureUsage.COPY_DST))) {
      stats.gpuFail = 'texture ' + T.format + ' ' + T.width + 'x' + T.height; return false;
    }
    try {
      dev.pushErrorScope('validation'); dev.pushErrorScope('out-of-memory');
      const c = createGuideSolverGPU(dev, { G, K, gRest, segLen, bendLen, gStiff, gBend, clrG, slkG, kMaxG, SDF });
      dev.popErrorScope().then((e) => { if (e) gcFail('oom', e.message); });
      dev.popErrorScope().then((e) => { if (e) gcFail('validation', e.message); });
      gcTex = T; gcResync = true; gcVerified = false; gcProbe = 0; gcCheck = null;
      dev.lost && dev.lost.then((i) => gcFail('device lost', i && i.message));
      c.dev = dev;
      stats.mode = 'gpu-probation';
      return c;
    } catch (e) { stats.gpuFail = 'init'; console.warn('[hair] GPU guide solve unavailable, CPU path', e); return false; }
  }
  const gF = { M: new Float32Array(16), Mi: new Float32Array(16), grav: new Float32Array(4), wind: new Float32Array(4), shift: new Float32Array(4),
               trig: new Float32Array(4), hc: new Float32Array(4), p0: new Float32Array(4), ip: new Uint32Array(4), cols: sets[0].buf, sph: sets[0].sph, nCols: nCols0, ext: [] };

  let NR = N;   // strands drawn
  function setStrandFraction(f) {
    f = Math.max(0, Math.min(1, +f || 0));
    P.strandFraction = f;
    NR = Math.max(Math.min(N, G), Math.min(N, Math.round(N * f)));
    geo.setDrawRange(0, NR * (K - 1) * 6);
  }
  setStrandFraction(P.strandFraction);

  /* ---------------- hide legacy cards; hair-coloured scalp while strands are live ---------------- */
  const setCards = (v) => cardMeshes.forEach((m) => { m.visible = v; });
  let scalpOrigMat = null, scalpMat = null;
  function setScalp(on) {
    if (!scalpMesh || !P.scalpSheenOff) return;
    if (on) {
      if (!scalpOrigMat) {
        const m0 = scalpMesh.material;
        if (!m0 || Array.isArray(m0) || !m0.clone) return;
        scalpOrigMat = m0;
        // Material.clone() JSON-copies userData; the parallax pass stores circular links there (dmPxFrom/dmPxTwin), so hide them during the clone
        const ud = m0.userData || {}, hid = {};
        for (const k of ['dmPxFrom', 'dmPxTwin']) if (k in ud) { hid[k] = ud[k]; delete ud[k]; }
        try { scalpMat = m0.clone(); } finally { Object.assign(ud, hid); }
        if ('sheen' in scalpMat) scalpMat.sheen = 0;           // body material carries a skin-tone sheen
        if ('roughness' in scalpMat) scalpMat.roughness = Math.max(scalpMat.roughness || 0, meta.roughness ?? 0.8);
        scalpMat.needsUpdate = true;
      }
      scalpMesh.material = scalpMat;
    } else if (scalpOrigMat) { scalpMesh.material = scalpOrigMat; }
  }
  // Warm-up gate: the ribbon vertex shader reads head matrix / camera / deflection uniforms that only
  // hold real values after the first update(). Drawn earlier they sit at identity (a giant black
  // polygon flashes over the menu as the hair loads), so strands write no pixels, and the legacy
  // cards stay up, until a few real frames have run; then the swap happens in one frame.
  let primed = false, warm = 0;
  const gate = (on) => { const m = mesh.material; m.colorWrite = !on; m.depthWrite = !on; m.needsUpdate = true; };
  const prime = () => { primed = true; gate(false); setCards(false); setScalp(true); };
  const unprime = () => { primed = false; warm = 0; gate(true); setCards(true); };
  gate(true);

  /* ---------------- scratch ---------------- */
  const M = new THREE.Matrix4(), Mi = new THREE.Matrix4(), rootInv = new THREE.Matrix4(), tmpM = new THREE.Matrix4(), tmpM2 = new THREE.Matrix4();
  const v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), camL = new THREE.Vector3(), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  const lastRootW = new THREE.Vector3(); let haveLast = false;
  let lhx = 0, lhy = 0, lhz = 0, haveHL = false;
  const fvel = new THREE.Vector3();
  const gravL = new THREE.Vector3(), windL = new THREE.Vector3(), windW = new THREE.Vector3(), velS = new THREE.Vector3();
  let gScale = 1;
  const extra = [];   // user colliders
  let curTier = 0, tMrg = false, tMid = false, tSep = false;   // collision quality tier this frame (see resolveTier) and its features
  const tmpP = new Float32Array(3);
  // (t1645u) soft, damped contact = a thin compliant cushion OUTSIDE each collider's contact distance c: a point in [c, c + band) is eased outward
  // softK of the remaining way per pass (it decelerates onto the surface over a few passes / frames instead of hitting a wall); a point inside c goes
  // straight to c plus that share.  Nothing ever rests inside c (no clipping, the hard floor is unchanged); continuous at c.  softBand 0 = rigid (old).
  function cushion() { return P.softBand > 0 ? P.softBand : 0; }
  function softTo(d, c) {
    const sb = P.softBand > 0 ? P.softBand : 0;
    if (sb <= 0) return c;
    return d < c ? c + sb * P.softK : d + (c + sb - d) * P.softK;
  }
  let curIts = 0;     // solver iterations this frame = P.iterations x physics intensity (ui/dm-cgroup.js); 0 = P.iterations
  let time = 0, frame = 0, ema = 2, cool = 0;
  const stats = { ms: 0, simMs: 0, strands: N, drawn: NR, guides: G, sdf: !!SDF, skinWarp: WARP ? { slots: WARP.slots.length, nodes: WARP.nodes, verts: WARP.verts } : null, contacts: 0, intensity: 1, segLen: (() => { let s = 0, c = 0; for (let i = 0; i < segLen.length; i++) if (segLen[i] > 0) { s += segLen[i]; c++; } return c ? s / c : 0; })() };
  let me = M.elements, mi = Mi.elements;
  // SDF box bounding sphere (head-local centre / radius), moved to root-local each frame
  let hcx = 0, hcy = 0, hcz = 0, hcR2 = 0, hsc2 = 1;
  const sdfC = SDF ? [SDF.ox + (SDF.nx - 1) / SDF.inv / 2, SDF.oy + (SDF.ny - 1) / SDF.inv / 2, SDF.oz + (SDF.nz - 1) / SDF.inv / 2] : [0, 0, 0];
  const sdfR = SDF ? 0.5 * Math.hypot(SDF.nx - 1, SDF.ny - 1, SDF.nz - 1) / SDF.inv : 0;

  // push root-local point (array a, offset o) out of the head SDF to clearance c; returns true on contact
  function headCollide(a, o, c) {
    const x = a[o], y = a[o + 1], z = a[o + 2];
    const ex = x - hcx, ey = y - hcy, ez = z - hcz;
    if (ex * ex + ey * ey + ez * ez > hcR2) return false;   // outside the SDF box's bounding sphere
    const hx = mi[0] * x + mi[4] * y + mi[8] * z + mi[12];
    const hy = mi[1] * x + mi[5] * y + mi[9] * z + mi[13];
    const hz = mi[2] * x + mi[6] * y + mi[10] * z + mi[14];
    let d;
    if (WARP && WARP.on) { const n = warpNode(hx, hy, hz); if (n >= 0) { warpDisp(n, hx, hy, hz); d = sdf(hx - wd[0], hy - wd[1], hz - wd[2]); } else d = sdf(hx, hy, hz); }
    else d = sdf(hx, hy, hz);
    const cu = P.softHead === false ? 0 : cushion();
    if (d >= c + cu) return false;
    const p = (cu > 0 ? softTo(d, c) : c) - d, nx = hx + sg[0] * p, ny = hy + sg[1] * p, nz = hz + sg[2] * p;
    a[o] = me[0] * nx + me[4] * ny + me[8] * nz + me[12];
    a[o + 1] = me[1] * nx + me[5] * ny + me[9] * nz + me[13];
    a[o + 2] = me[2] * nx + me[6] * ny + me[10] * nz + me[14];
    return true;
  }

  // (v379) hard exit for the closing pass: re-sample and re-project (<= 3 times) until the point is out of the warped head field, so a curved / thin
  // part of the scalp cannot leave it just inside after one gradient step.  No soft cushion here: this is the floor, not the contact layer.
  function headOut(a, o, c) {
    let moved = false;
    for (let r = 0; r < 4; r++) {
      const x = a[o], y = a[o + 1], z = a[o + 2];
      const ex = x - hcx, ey = y - hcy, ez = z - hcz;
      if (ex * ex + ey * ey + ez * ez > hcR2) return moved;
      const hx = mi[0] * x + mi[4] * y + mi[8] * z + mi[12], hy = mi[1] * x + mi[5] * y + mi[9] * z + mi[13], hz = mi[2] * x + mi[6] * y + mi[10] * z + mi[14];
      const n = warpNode(hx, hy, hz); let d;
      if (n >= 0) { warpDisp(n, hx, hy, hz); d = sdf(hx - wd[0], hy - wd[1], hz - wd[2]); } else d = sdf(hx, hy, hz);
      if (d >= (r === 0 ? 0 : -1e-5)) return moved;
      if (r === 3) {   // the field's gradient did not lead out (deep in a thin shell / fold): fall back to the groom point, which sits >= 3 mm clear
        sq[o] += restM[o] - x; sq[o + 1] += restM[o + 1] - y; sq[o + 2] += restM[o + 2] - z; a[o] = restM[o]; a[o + 1] = restM[o + 1]; a[o + 2] = restM[o + 2]; return true;
      }
      const p = c - d, nx = hx + sg[0] * p, ny = hy + sg[1] * p, nz = hz + sg[2] * p;
      const qx = me[0] * nx + me[4] * ny + me[8] * nz + me[12], qy = me[1] * nx + me[5] * ny + me[9] * nz + me[13], qz = me[2] * nx + me[6] * ny + me[10] * nz + me[14];
      sq[o] += qx - x; sq[o + 1] += qy - y; sq[o + 2] += qz - z;   // no injected velocity
      a[o] = qx; a[o + 1] = qy; a[o + 2] = qz; moved = true;
    }
    return moved;
  }
  // guide point deflected far enough from its groom position that it might touch the head?
  function near(a, o, i) {
    const dx = a[o] - restM[o], dy = a[o + 1] - restM[o + 1], dz = a[o + 2] - restM[o + 2];
    return dx * dx + dy * dy + dz * dz > slkG[i] * hsc2;
  }
  function capsuleCollide(o, ax, ay, az, bx, by, bz, r) {
    const px = sp[o], py = sp[o + 1], pz = sp[o + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const ab2 = abx * abx + aby * aby + abz * abz;
    let t = ab2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ab2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const d2 = dx * dx + dy * dy + dz * dz, rr = r + P.hairRadius, ro = rr + cushion();
    if (d2 < ro * ro) {
      const d = Math.sqrt(d2) || 1e-6, k = softTo(d, rr) / d;
      const nx = cx + dx * k, ny = cy + dy * k, nz = cz + dz * k;
      // move the previous position with the push (a contact must not inject velocity), then friction:
      // hair resting on a shoulder / arm settles instead of buzzing
      const f = 1 - P.friction;
      sq[o] += nx - px; sq[o + 1] += ny - py; sq[o + 2] += nz - pz;
      sp[o] = nx; sp[o + 1] = ny; sp[o + 2] = nz;
      sq[o] = nx + (sq[o] - nx) * f; sq[o + 1] = ny + (sq[o + 1] - ny) * f; sq[o + 2] = nz + (sq[o + 2] - nz) * f;
    }
  }

  // keep-out box (head / bone frame): push a point out along the axis of least penetration. bq = offset in CS.bbuf, mg = extra margin (child bundle). returns true on contact
  function boxPush(o, bq, mg) {
    const bb = CS.bbuf, dx = sp[o] - bb[bq], dy = sp[o + 1] - bb[bq + 1], dz = sp[o + 2] - bb[bq + 2];
    const m = (bb[bq + 24] + P.hairRadius + mg + (P.softBox === false ? 0 : cushion())) * bb[bq + 25];   // (t1645u) keep-out boxes (glasses, face) carry the same cushion width as the scalp, so strands the soft scalp layer lifts are not pushed into them
    const hx = bb[bq + 21] + m, hy = bb[bq + 22] + m, hz = bb[bq + 23] + m;
    const lx = bb[bq + 3] * dx + bb[bq + 4] * dy + bb[bq + 5] * dz, ly = bb[bq + 6] * dx + bb[bq + 7] * dy + bb[bq + 8] * dz, lz = bb[bq + 9] * dx + bb[bq + 10] * dy + bb[bq + 11] * dz;
    const ex = hx - Math.abs(lx), ey = hy - Math.abs(ly), ez = hz - Math.abs(lz);
    if (ex <= 0 || ey <= 0 || ez <= 0) return false;
    let ax = 0, d;
    if (ex <= ey && ex <= ez) { ax = 12; d = lx < 0 ? -ex : ex; } else if (ey <= ez) { ax = 15; d = ly < 0 ? -ey : ey; } else { ax = 18; d = lz < 0 ? -ez : ez; }
    const px = bb[bq + ax] * d, py = bb[bq + ax + 1] * d, pz = bb[bq + ax + 2] * d;
    sp[o] += px; sp[o + 1] += py; sp[o + 2] += pz; sq[o] += px; sq[o + 1] += py; sq[o + 2] += pz;
    return true;
  }
  // tier 2: neighbouring guides keep a minimum spacing (a fraction of their groom spacing) so clumps do not collapse into one strand when they swing
  function separate() {
    const S = ensureSep(), n = S.n, pa = S.a, pb = S.b, mn = S.min;
    for (let i = 0; i < n; i++) {
      const ga = pa[i] * K * 3, gb2 = pb[i] * K * 3, mb = i * K;
      for (let k = 2; k < K; k++) {
        const md = mn[mb + k]; if (!(md > 0)) continue;
        const a = ga + k * 3, b = gb2 + k * 3, dx = sp[a] - sp[b], dy = sp[a + 1] - sp[b + 1], dz = sp[a + 2] - sp[b + 2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= md * md) continue;
        const d = Math.sqrt(d2) || 1e-9, f = (md - d) * 0.5 / d, px = dx * f, py = dy * f, pz = dz * f;
        sp[a] += px; sp[a + 1] += py; sp[a + 2] += pz; sq[a] += px; sq[a + 1] += py; sq[a + 2] += pz;
        sp[b] -= px; sp[b + 1] -= py; sp[b + 2] -= pz; sq[b] -= px; sq[b + 1] -= py; sq[b + 2] -= pz;
      }
    }
  }

  function step(h, simTime) {
    const hh = h * h;
    const damp = Math.pow(P.damping, h * 60);
    const gx = gravL.x * P.gravity * hh, gy = gravL.y * P.gravity * hh, gz = gravL.z * P.gravity * hh;
    const fr = 1 - P.friction;
    let contacts = 0;
    // 1. integrate (points 0,1 pinned to the scalp frame)
    for (let g = 0; g < G; g++) {
      const gb = g * K * 3;
      for (let k = 0; k < 2; k++) { const o = gb + k * 3; sp[o] = sq[o] = restM[o]; sp[o + 1] = sq[o + 1] = restM[o + 1]; sp[o + 2] = sq[o + 2] = restM[o + 2]; }
      const ph = g * 0.37;
      const gust = 1 + P.windGust * Math.sin(simTime * 2.1 + ph) * Math.sin(simTime * 0.7 + ph * 1.7);
      const wx = windL.x * P.drag * gust * hh, wy = windL.y * P.drag * gust * hh, wz = windL.z * P.drag * gust * hh;
      for (let k = 2; k < K; k++) {
        const o = gb + k * 3;
        const vx = (sp[o] - sq[o]) * damp, vy = (sp[o + 1] - sq[o + 1]) * damp, vz = (sp[o + 2] - sq[o + 2]) * damp;
        sq[o] = sp[o]; sq[o + 1] = sp[o + 1]; sq[o + 2] = sp[o + 2];
        let x = sp[o] + vx + gx + wx, y = sp[o + 1] + vy + gy + wy, z = sp[o + 2] + vz + gz + wz;
        const st = gStiff[g * K + k];   // weak global groom spring
        x += (restM[o] - x) * st; y += (restM[o + 1] - y) * st; z += (restM[o + 2] - z) * st;
        sp[o] = x; sp[o + 1] = y; sp[o + 2] = z;
      }
    }
    // 2. constraints
    const its = Math.max(1, curIts || ((curTier >= 2 && P.iterationsFine) ? P.iterationsFine : (P.iterations | 0))), wp = P.stretchBias, sdfEvery = Math.max(1, P.sdfEvery | 0), capsAll = !!P.capsuleEveryIteration || (curTier >= 2 && !P.noCapsAll);
    for (let it = 0; it < its; it++) {
      const last = it === its - 1;
      const doSdf = SDF && (last || (it % sdfEvery) === sdfEvery - 1);
      if (tSep && last) separate();
      for (let g = 0; g < G; g++) {
        const gb = g * K * 3, lb = g * (K - 1), sb = g * K;
        const km = kMaxG[g];
        for (let k = 2; k < K; k++) {
          const a = gb + (k - 1) * 3, b = gb + k * 3;
          // bending: distance to the point two up the chain (resists folding; strong at the root, soft at the tip)
          {
            const c = gb + (k - 2) * 3, bs = gBend[sb + k];
            const ex = sp[b] - sp[c], ey = sp[b + 1] - sp[c + 1], ez = sp[b + 2] - sp[c + 2];
            const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
            const ed = (el - bendLen[sb + k]) / el * bs;
            if (k <= 3) { sp[b] -= ex * ed; sp[b + 1] -= ey * ed; sp[b + 2] -= ez * ed; }   // k-2 is pinned
            else { const h1 = ed * 0.5; sp[c] += ex * h1; sp[c + 1] += ey * h1; sp[c + 2] += ez * h1; sp[b] -= ex * h1; sp[b + 1] -= ey * h1; sp[b + 2] -= ez * h1; }
          }
          // segment length (parent pinned for k-1 <= 1)
          const dx = sp[b] - sp[a], dy = sp[b + 1] - sp[a + 1], dz = sp[b + 2] - sp[a + 2];
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
          const diff = (len - segLen[lb + k - 1]) / len;
          if (k === 2) { sp[b] -= dx * diff; sp[b + 1] -= dy * diff; sp[b + 2] -= dz * diff; }
          else {
            const fa = wp * diff, fb = (1 - wp) * diff;
            sp[a] += dx * fa; sp[a + 1] += dy * fa; sp[a + 2] += dz * fa;
            sp[b] -= dx * fb; sp[b + 1] -= dy * fb; sp[b + 2] -= dz * fb;
          }
          // head / scalp SDF: every free point, every iteration
          if (doSdf && k <= km && near(sp, b, sb + k)) {
            const x0 = sp[b], y0 = sp[b + 1], z0 = sp[b + 2];
            if (headCollide(sp, b, clrG[sb + k])) {
              contacts++;
              // no injected velocity from the push, then friction against the scalp
              sq[b] += sp[b] - x0; sq[b + 1] += sp[b + 1] - y0; sq[b + 2] += sp[b + 2] - z0;
              sq[b] = sp[b] + (sq[b] - sp[b]) * fr; sq[b + 1] = sp[b + 1] + (sq[b + 1] - sp[b + 1]) * fr; sq[b + 2] = sp[b + 2] + (sq[b + 2] - sp[b + 2]) * fr;
            }
          }
        }
        if (capsAll || last) {
          // body capsules (+ keep-out boxes at tier >= 1), broad phase per 4-point chunk (chunk AABB vs capsule / box bounding sphere)
          const cush = cushion(), fr2 = 1 - P.friction, hr = P.hairRadius, nb = P.noBoxes ? 0 : CS.nb, bb = CS.bbuf, bhit = CS.bhit, tmg = tMrg, gl = CS.gl, bgl = CS.bgl;
          // guide-level broad phase first (one AABB over the whole chain): a guide that is nowhere near a capsule / box skips the per-chunk tests (pure pruning: same contacts)
          let gx0 = 1e9, gy0 = 1e9, gz0 = 1e9, gx1 = -1e9, gy1 = -1e9, gz1 = -1e9;
          for (let k = (tMid && last ? 1 : 2); k < K; k++) {
            const o = gb + k * 3, x = sp[o], y = sp[o + 1], z = sp[o + 2];
            if (x < gx0) gx0 = x; if (x > gx1) gx1 = x; if (y < gy0) gy0 = y; if (y > gy1) gy1 = y; if (z < gz0) gz0 = z; if (z > gz1) gz1 = z;
          }
          let ng = 0, gnb = 0;
          for (let c = 0; c < nCols; c++) {
            const q = c * 8, cx = colSph[q], cy = colSph[q + 1], cz = colSph[q + 2], R = colSph[q + 3];
            const dx = cx < gx0 ? gx0 - cx : cx > gx1 ? cx - gx1 : 0, dy = cy < gy0 ? gy0 - cy : cy > gy1 ? cy - gy1 : 0, dz = cz < gz0 ? gz0 - cz : cz > gz1 ? cz - gz1 : 0;
            if (!P.broadPhase || dx * dx + dy * dy + dz * dz <= R * R) gl[ng++] = c;
          }
          for (let c = 0; c < nb; c++) {
            const q = c * BOXS + 26, cx = bb[q], cy = bb[q + 1], cz = bb[q + 2], R = bb[q + 3];
            const dx = cx < gx0 ? gx0 - cx : cx > gx1 ? cx - gx1 : 0, dy = cy < gy0 ? gy0 - cy : cy > gy1 ? cy - gy1 : 0, dz = cz < gz0 ? gz0 - cz : cz > gz1 ? cz - gz1 : 0;
            if (dx * dx + dy * dy + dz * dz <= R * R) bgl[gnb++] = c;
          }
          if (ng || gnb || extra.length) for (let k0 = 2; k0 < K; k0 += 4) {
            const k1 = Math.min(K, k0 + 4);
            let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
            for (let k = (tMid && last ? k0 - 1 : k0); k < k1; k++) {
              const o = gb + k * 3, x = sp[o], y = sp[o + 1], z = sp[o + 2];
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
            }
            let nh = 0;
            for (let j = 0; j < ng; j++) {
              const c = gl[j], q = c * 8, cx = colSph[q], cy = colSph[q + 1], cz = colSph[q + 2], R = colSph[q + 3];
              const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0, dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0, dz = cz < z0 ? z0 - cz : cz > z1 ? cz - z1 : 0;
              if (!P.broadPhase || dx * dx + dy * dy + dz * dz <= R * R) colHit[nh++] = c;
            }
            let nbh = 0;
            for (let j = 0; j < gnb; j++) {
              const c = bgl[j], q = c * BOXS + 26, cx = bb[q], cy = bb[q + 1], cz = bb[q + 2], R = bb[q + 3];
              const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0, dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0, dz = cz < z0 ? z0 - cz : cz > z1 ? cz - z1 : 0;
              if (dx * dx + dy * dy + dz * dz <= R * R) bhit[nbh++] = c;
            }
            if (!nh && !nbh && !extra.length) continue;
            for (let k = k0; k < k1; k++) {
              const o = gb + k * 3, mg = tmg ? mrgG[sb + k] : 0;
              let hit = false;
              for (let h2 = 0; h2 < nh; h2++) {
                const c = colHit[h2], q = c * 7, q8 = c * 8;
                const px = sp[o], py = sp[o + 1], pz = sp[o + 2];
                { const ex = px - colSph[q8], ey = py - colSph[q8 + 1], ez = pz - colSph[q8 + 2], R = colSph[q8 + 3] + 1e-4 + cush; if (ex * ex + ey * ey + ez * ez > R * R) continue; }   // per-point sphere reject (pure pruning, same contacts)
                const ax = colBuf[q], ay = colBuf[q + 1], az = colBuf[q + 2];
                const abx = colBuf[q + 3] - ax, aby = colBuf[q + 4] - ay, abz = colBuf[q + 5] - az;
                const ab2 = abx * abx + aby * aby + abz * abz;
                let t = ab2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ab2 : 0;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const ccx = ax + abx * t, ccy = ay + aby * t, ccz = az + abz * t;
                const dx = px - ccx, dy = py - ccy, dz = pz - ccz, d2 = dx * dx + dy * dy + dz * dz, rr = colBuf[q + 6] + hr + mg;
                if (d2 < (rr + cush) * (rr + cush)) {
                  const d = Math.sqrt(d2) || 1e-6, kk = softTo(d, rr) / d;
                  const nx = ccx + dx * kk, ny = ccy + dy * kk, nz = ccz + dz * kk;
                  sq[o] += nx - px; sq[o + 1] += ny - py; sq[o + 2] += nz - pz;   // a contact must not inject velocity
                  sp[o] = nx; sp[o + 1] = ny; sp[o + 2] = nz; hit = true;
                }
              }
              for (let h2 = 0; h2 < nbh; h2++) if (boxPush(o, bhit[h2] * BOXS, mg)) hit = true;
              for (let c = 0; c < extra.length; c++) { const C = extra[c]; capsuleCollide(o, C.la.x, C.la.y, C.la.z, C.lb.x, C.lb.y, C.lb.z, C.lr); }
              if (hit) {   // friction: resting on a shoulder / arm settles instead of buzzing
                sq[o] = sp[o] + (sq[o] - sp[o]) * fr2; sq[o + 1] = sp[o + 1] + (sq[o + 1] - sp[o + 1]) * fr2; sq[o + 2] = sp[o + 2] + (sq[o + 2] - sp[o + 2]) * fr2;
                // capsules may have pushed a point back into the head: SDF wins (it is the closer surface)
                if (SDF && k <= km && near(sp, o, sb + k)) headCollide(sp, o, clrG[sb + k]);
              }
            }
            // tier 2 tessellation: the midpoint of every segment of the chunk against head SDF / capsules / boxes (a long segment can chord through an ear or a shoulder
            // although both end points are clear); the push goes to both end points (point 1 is pinned: its partner takes it all)
            if (tMid && last) {
              // (t1645u) not just the midpoint: ns = 1..3 evenly spaced interior samples per segment by its rest length (segS), each a PBD point
              // constraint on the interpolated position (end-point shares (1-u) / u over (1-u)^2 + u^2; pinned point 1: its partner takes e / u)
              for (let k = k0; k < k1; k++) {
                const o = gb + k * 3, o0 = o - 3, free0 = k > 2, ns = segS[sb + k] || 1;   // k-1 >= 2 is free; point 1 is pinned
                const mg = tmg ? (mrgG[sb + k] + mrgG[sb + k - 1]) * 0.5 : 0, cl = (clrG[sb + k] + clrG[sb + k - 1]) * 0.5, sl = Math.min(slkG[sb + k], slkG[sb + k - 1]);
                for (let si = 1; si <= ns; si++) {
                  const u = si / (ns + 1), u0 = 1 - u;
                  const mx0 = sp[o0] * u0 + sp[o] * u, my0 = sp[o0 + 1] * u0 + sp[o + 1] * u, mz0 = sp[o0 + 2] * u0 + sp[o + 2] * u;
                  tmpP[0] = mx0; tmpP[1] = my0; tmpP[2] = mz0;
                  let moved = false;
                  if (SDF && k <= km) {
                    const rx = restM[o0] * u0 + restM[o] * u - mx0, ry = restM[o0 + 1] * u0 + restM[o + 1] * u - my0, rz = restM[o0 + 2] * u0 + restM[o + 2] * u - mz0;
                    if (rx * rx + ry * ry + rz * rz > sl * hsc2 && headCollide(tmpP, 0, cl)) moved = true;
                  }
                  for (let h2 = 0; h2 < nh; h2++) {
                    const q = colHit[h2] * 7, ax = colBuf[q], ay = colBuf[q + 1], az = colBuf[q + 2], abx = colBuf[q + 3] - ax, aby = colBuf[q + 4] - ay, abz = colBuf[q + 5] - az;
                    const px = tmpP[0], py = tmpP[1], pz = tmpP[2], ab2 = abx * abx + aby * aby + abz * abz;
                    let t = ab2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ab2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
                    const ccx = ax + abx * t, ccy = ay + aby * t, ccz = az + abz * t, dx = px - ccx, dy = py - ccy, dz = pz - ccz, d2 = dx * dx + dy * dy + dz * dz, rr = colBuf[q + 6] + hr + mg;
                    if (d2 < (rr + cush) * (rr + cush)) { const d = Math.sqrt(d2) || 1e-6, kk = softTo(d, rr) / d; tmpP[0] = ccx + dx * kk; tmpP[1] = ccy + dy * kk; tmpP[2] = ccz + dz * kk; moved = true; }
                  }
                  if (moved) {
                    const ex = tmpP[0] - mx0, ey = tmpP[1] - my0, ez = tmpP[2] - mz0;
                    if (free0) {
                      const D = 1 / (u0 * u0 + u * u), a1 = u * D, a0 = u0 * D;
                      sp[o] += ex * a1; sp[o + 1] += ey * a1; sp[o + 2] += ez * a1; sq[o] += ex * a1; sq[o + 1] += ey * a1; sq[o + 2] += ez * a1;
                      sp[o0] += ex * a0; sp[o0 + 1] += ey * a0; sp[o0 + 2] += ez * a0; sq[o0] += ex * a0; sq[o0 + 1] += ey * a0; sq[o0 + 2] += ez * a0;
                    } else {
                      const a1 = 1 / u; sp[o] += ex * a1; sp[o + 1] += ey * a1; sp[o + 2] += ez * a1; sq[o] += ex * a1; sq[o + 1] += ey * a1; sq[o + 2] += ez * a1;
                    }
                    contacts++;
                  }
                }
              }
            }
          }
          // (v379) closing head pass: capsule / box / segment-sample pushes above can leave a point back inside the scalp; the head SDF is the
          // closest surface, so it gets the last word on the final iteration (same near() pruning, no allocation)
          // only where the skin-following field is live (Emma: non-Head-weighted scalp); Ariel's solve stays bit-identical
          if (last && doSdf && WARP && WARP.on) for (let k = 2; k <= km && k < K; k++) { if (headOut(sp, gb + k * 3, clrG[sb + k])) contacts++; }
        }
      }
    }
    stats.contacts = contacts;
  }

  // probation: after ~20 lockstep frames read the GPU state back and compare with the CPU solver
  function probeCheck() {
    gcProbe++;
    if (gcCheck) { if (performance.now() - gcCheck.t > 4000) gcFail('readback timeout'); return; }
    if (gcProbe < 20) return;
    const ref = Float32Array.from(sp), c = gc;
    gcCheck = { t: performance.now() };
    c.read().then((r) => {
      if (gc !== c) return;
      gcCheck = null;
      let bad = 0, sum = 0, mx = 0, mag = 0;
      for (let i = 0; i < ref.length; i++) {
        const v = r.sp[i]; if (!Number.isFinite(v)) { bad++; continue; }
        const d = Math.abs(v - ref[i]); sum += d; if (d > mx) mx = d; mag += Math.abs(v);
      }
      const mean = sum / ref.length;
      stats.gpuCheck = { bad, mean, max: mx };
      if (bad || !(mag > 0) || mean > 1e-3 || mx > 0.05) { gcFail('readback mismatch bad=' + bad + ' mean=' + mean.toExponential(1) + ' max=' + mx.toExponential(1)); return; }
      if (gcProbe < 40) return;   // two passing checks before handing over
      gcVerified = true; gcResync = true; stats.mode = 'gpu-compute';
    }).catch((e) => { if (gc === c) gcFail('readback', e); });
  }

  // collision quality tier: params.collisionTier (0 Low / 1 Mid / 2 High) > host opts.getCollisionTier() > 0. The frame-budget ladder (DMBudget 'hair' level >= 1) drops to Low.
  function resolveTier() {
    let t = P.collisionTier;
    if (t == null || t === 'auto') { t = 0; if (opts.getCollisionTier) { try { t = +opts.getCollisionTier(); } catch (e) { t = 0; } } }
    t = t > 0 ? Math.min(2, t | 0) : 0;
    if (t > 0) { const B = (typeof window !== 'undefined') ? window.DMBudget : null; if (B && B.on && B.lvl && B.lvl('hair') >= 1) t = 0; }
    return t;
  }
  function update(dt) {
    _update(dt);
    if (!primed && P.enabled && root.visible && dt > 0 && renderSeen && gpu !== null && ++warm >= 4) prime();
  }
  // CPU path: any guide point that went non-finite or ran away (> P.maxDeflect x its chain length from the
  // groom) reseeds its whole guide to the groom. The GPU path does the same inside the compute shader.
  function sanitizeCPU() {
    const sc = Math.sqrt(hsc2) || 1;
    for (let g = 0; g < G; g++) {
      const lim = P.maxDeflect * gLen[g] * sc, lim2 = lim * lim, b = g * K * 3;
      let bad = false;
      for (let k = 2; k < K; k++) {
        const o = b + k * 3, dx = sp[o] - restM[o], dy = sp[o + 1] - restM[o + 1], dz = sp[o + 2] - restM[o + 2];
        if (!(dx * dx + dy * dy + dz * dz < lim2)) { bad = true; break; }   // NaN fails the compare too
      }
      if (bad) { for (let k = 0; k < K * 3; k++) { sp[b + k] = restM[b + k]; sq[b + k] = restM[b + k]; } resanitized++; }
    }
  }
  let bAcc = 0, bCnt = 0;
  function _update(dt) {
    if (!P.enabled || !(dt > 0) || !root.visible) return;
    // (v259) frame-budget ladder (ui/dm-budget.js, stage 'hair'): the guide solver (~10-13 ms a frame on the tablet) runs every 3rd frame with the accumulated step
    // (capped well below the 0.25 s hitch reset), the strands keep moving, the cost drops to a third.
    { const B = (typeof window !== 'undefined') ? window.DMBudget : null, ev = B && B.on && B.hairEvery ? B.hairEvery() : 1;
      if (ev > 1) { bAcc += dt; if ((++bCnt % ev) !== 0) return; dt = bAcc > 0.05 ? 0.05 : bAcc; bAcc = 0; } else if (bAcc > 0) { bAcc = 0; } }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (dt >= 0.25) hitch = true;
    if (hitch) { hitch = false; needInit = true; haveLast = false; havePM = false; haveHL = false; velS.set(0, 0, 0); settleT = P.settleTime; }
    if (settleT > 0) settleT -= dt;
    root.updateWorldMatrix(true, false);
    head.updateWorldMatrix(true, false);
    rootInv.copy(root.matrixWorld).invert();
    M.multiplyMatrices(rootInv, head.matrixWorld);   // head bone (= scalp frame) in root-local space
    Mi.copy(M).invert();
    me = M.elements; mi = Mi.elements;
    // NaN / Infinity in the head frame (degenerate matrix after a teleport) would poison every strand for good
    if (!(Math.abs(me[0] + me[5] + me[10] + me[12] + me[13] + me[14]) < 1e9) || !(Math.abs(M.determinant()) > 1e-12)) { needInit = true; return; }
    hcx = me[0] * sdfC[0] + me[4] * sdfC[1] + me[8] * sdfC[2] + me[12];
    hcy = me[1] * sdfC[0] + me[5] * sdfC[1] + me[9] * sdfC[2] + me[13];
    hcz = me[2] * sdfC[0] + me[6] * sdfC[1] + me[10] * sdfC[2] + me[14];
    { const sc = Math.cbrt(Math.abs(M.determinant())) || 1; hcR2 = sdfR * sc * sdfR * sc; hsc2 = sc * sc;
      // did the head move relative to the body since the last step? (> ~0.6 deg or 2 mm)
      headMoved = !havePM;
      if (havePM) {
        const tr = 0.01 * sc, tt = 0.002 * sc;
        for (let i = 0; i < 15 && !headMoved; i++) { if (i === 3 || i === 7 || i === 11) continue; if (Math.abs(me[i] - pM[i]) > (i >= 12 ? tt : tr)) headMoved = true; }
      }
      for (let i = 0; i < 16; i++) pM[i] = me[i];
      havePM = true; }
    // animation pop (clip loop / teleport of the head relative to the body): re-seed instead of whipping
    let popped = false;
    if (haveHL && dt > 0 && dt < 0.25 && Math.hypot(me[12] - lhx, me[13] - lhy, me[14] - lhz) / dt > P.popSpeed) popped = true;
    lhx = me[12]; lhy = me[13]; lhz = me[14]; haveHL = true;

    // collision tier -> active collider set
    { const t = resolveTier();
      if (t !== curTier || CS !== sets[t]) { curTier = t; CS = sets[t]; cols = CS.cols; nCols = CS.n; colBuf = CS.buf; colSph = CS.sph; colHit = CS.hit; }
      tMrg = t >= 1 && !P.noMargin; tMid = t >= 2 && !P.noMid; tSep = t >= 2 && !P.noSep; stats.tier = t; stats.cols = nCols; stats.boxes = P.noBoxes ? 0 : CS.nb; }
    const hrM = P.hairRadius + (tMrg ? mrgMax : 0), nbAct = P.noBoxes ? 0 : CS.nb;
    // colliders -> root-local capsules
    for (let c = 0; c < nCols; c++) {
      const C = cols[c], q = c * 7;
      tmpM.multiplyMatrices(rootInv, C.bone.matrixWorld);
      tmpA.copy(C.a).applyMatrix4(tmpM); tmpB.copy(C.b).applyMatrix4(tmpM);
      colBuf[q] = tmpA.x; colBuf[q + 1] = tmpA.y; colBuf[q + 2] = tmpA.z; colBuf[q + 3] = tmpB.x; colBuf[q + 4] = tmpB.y; colBuf[q + 5] = tmpB.z; colBuf[q + 6] = C.r;
      const p8 = c * 8;
      colSph[p8] = (tmpA.x + tmpB.x) / 2; colSph[p8 + 1] = (tmpA.y + tmpB.y) / 2; colSph[p8 + 2] = (tmpA.z + tmpB.z) / 2;
      colSph[p8 + 3] = tmpA.distanceTo(tmpB) / 2 + C.r + hrM + cushion();
    }
    // keep-out boxes (tier >= 1) -> root-local frame: t, Ainv (3x3 rows), A (3 columns), half extents, margin, 1/scale, bounding sphere
    for (let c = 0; c < nbAct; c++) {
      const B = CS.boxes[c], o = c * BOXS, bb = CS.bbuf;
      tmpM.multiplyMatrices(rootInv, B.bone.matrixWorld); const e = tmpM.elements, sc = Math.cbrt(Math.abs(tmpM.determinant())) || 1;
      tmpA.copy(B.c).applyMatrix4(tmpM); bb[o] = tmpA.x; bb[o + 1] = tmpA.y; bb[o + 2] = tmpA.z;
      tmpM2.copy(tmpM).invert(); const ie = tmpM2.elements;
      bb[o + 3] = ie[0]; bb[o + 4] = ie[4]; bb[o + 5] = ie[8]; bb[o + 6] = ie[1]; bb[o + 7] = ie[5]; bb[o + 8] = ie[9]; bb[o + 9] = ie[2]; bb[o + 10] = ie[6]; bb[o + 11] = ie[10];
      bb[o + 12] = e[0]; bb[o + 13] = e[1]; bb[o + 14] = e[2]; bb[o + 15] = e[4]; bb[o + 16] = e[5]; bb[o + 17] = e[6]; bb[o + 18] = e[8]; bb[o + 19] = e[9]; bb[o + 20] = e[10];
      bb[o + 21] = B.h[0]; bb[o + 22] = B.h[1]; bb[o + 23] = B.h[2]; bb[o + 24] = B.m; bb[o + 25] = 1 / sc;
      bb[o + 26] = tmpA.x; bb[o + 27] = tmpA.y; bb[o + 28] = tmpA.z; bb[o + 29] = Math.hypot(B.h[0], B.h[1], B.h[2]) * sc + B.m + hrM;
    }
    for (const C of extra) {
      C.la = (C.la || new THREE.Vector3()).copy(C.center).applyMatrix4(rootInv);
      C.lb = (C.lb || new THREE.Vector3()).copy(C.end || C.center).applyMatrix4(rootInv);
      C.lr = C.radius * Math.cbrt(Math.abs(rootInv.determinant()));
    }
    const gcOk = !!(gc && !P.verifyRibbons && extra.length <= HAIR_GPU_MAX_EXTRA && curTier === 0);   // the GPU guide solver is the tier-0 solver only
    const onGPU = gcOk && (gcVerified || (!gpu && !opts.probation));   // headless tests (no ribbons) skip probation unless asked
    const probe = gcOk && !onGPU;                 // CPU drives the ribbons, GPU solves alongside
    if (gc && gcResync && (onGPU || probe)) { gc.setState(sp, sq); gcResync = false; }
    if (!onGPU && !probe && gc) {
      gcResync = true;   // CPU took over: re-sync the GPU state when it resumes
      // the CPU's sp/sq are stale while the GPU solved: reseed from the groom instead of snapping
      if (gcWasOn) needInit = true;
    }
    gcWasOn = onGPU;
    let reset = needInit || popped, shx = 0, shy = 0, shz = 0;
    // guide rest pose in root-local
    for (let i = 0; i < GK && !onGPU; i++) {
      const o = i * 3, x = gRest[o], y = gRest[o + 1], z = gRest[o + 2];
      restM[o] = me[0] * x + me[4] * y + me[8] * z + me[12];
      restM[o + 1] = me[1] * x + me[5] * y + me[9] * z + me[13];
      restM[o + 2] = me[2] * x + me[6] * y + me[10] * z + me[14];
    }
    // (v379) the roots ride the skinned scalp / nape: each guide's rest is carried by the skin displacement at its root
    warpFrame();
    if (WARP && WARP.on && !onGPU) {
      for (let g = 0; g < G; g++) { const n = wNodeG[g], q = g * 3; if (n < 0) { wG[q] = wG[q + 1] = wG[q + 2] = 0; continue; }
        const r0 = g * K * 3; warpDisp(n, gRest[r0], gRest[r0 + 1], gRest[r0 + 2]);
        const dx = me[0] * wd[0] + me[4] * wd[1] + me[8] * wd[2], dy = me[1] * wd[0] + me[5] * wd[1] + me[9] * wd[2], dz = me[2] * wd[0] + me[6] * wd[1] + me[10] * wd[2];
        wG[q] = dx; wG[q + 1] = dy; wG[q + 2] = dz;
        for (let k = 0; k < K; k++) { const o = r0 + k * 3; restM[o] += dx; restM[o + 1] += dy; restM[o + 2] += dz; } }
    } else if (WARP) wG.fill(0);
    if (needInit) { if (!onGPU) { sp.set(restM); sq.set(restM); } needInit = false; }
    if (popped) { if (!onGPU) { sp.set(restM); sq.set(restM); } velS.set(0, 0, 0); haveLast = false; }

    // root world motion -> small clamped inertial shift + steady apparent wind (tracks the HEAD bone)
    v3.setFromMatrixPosition(head.matrixWorld);
    const rs = Math.cbrt(Math.abs(root.matrixWorld.determinant())) || 1;
    let motionWind = 0;
    if (haveLast && dt < 0.25 && settleT <= 0) {
      v3b.copy(v3).sub(lastRootW);
      // v94: motion relative to the frame she stands on (the moving Bird Temple deck), not raw world motion
      if (opts.getFrameVel) { opts.getFrameVel(fvel); v3b.addScaledVector(fvel, -dt); }
      const l = v3b.length();
      if (l / rs / dt > P.teleportSpeed) { velS.set(0, 0, 0); }   // origin re-centre / teleport: ignore
      else {
        const a = 1 - Math.exp(-dt * 5);
        velS.x += (v3b.x / dt - velS.x) * a; velS.y += (v3b.y / dt - velS.y) * a; velS.z += (v3b.z / dt - velS.z) * a;
        const maxStep = P.maxRootStep * rs;
        let lc = l;
        if (lc > maxStep) { v3b.multiplyScalar(maxStep / lc); lc = maxStep; }
        if (lc > 1e-9) {
          v3b.transformDirection(rootInv).multiplyScalar(lc / rs);
          const sx = -v3b.x, sy = -v3b.y, sz = -v3b.z;
          shx = sx; shy = sy; shz = sz;
          for (let i = 0; i < GK && !onGPU; i++) {
            const o = i * 3;
            sp[o] += sx; sp[o + 1] += sy; sp[o + 2] += sz;
            sq[o] += sx; sq[o + 1] += sy; sq[o + 2] += sz;
          }
        }
      }
    } else if (dt >= 0.25) { if (!onGPU) { sp.set(restM); sq.set(restM); } reset = true; velS.set(0, 0, 0); }
    else if (settleT > 0) velS.set(0, 0, 0);   // post-stall settle: no inertial shift / apparent wind
    lastRootW.copy(v3); haveLast = true;
    const vl = velS.length(), spd = vl / rs;
    motionWind = Math.min(P.maxMotionWind, spd * P.motionWind);
    // v94: calm air indoors (host getCalm): no weather wind / gusts, only her own motion
    const calm = !!(opts.getCalm && opts.getCalm());
    if (calm) windW.set(0, 0, 0); else windW.copy(P.wind);
    if (spd > 1e-3) windW.addScaledVector(velS, -motionWind / (vl || 1));

    // gravity / wind into root-local directions
    const up = opts.getDown ? opts.getDown() : null;   // optional: world-space "down" vector
    gravL.set(up ? up.x : 0, up ? up.y : -1, up ? up.z : 0).transformDirection(rootInv);
    let gsT = opts.getGravityScale ? opts.getGravityScale() : 1;
    if (!Number.isFinite(gsT)) gsT = 1;
    if (!Number.isFinite(gScale)) gScale = 1;   // a single NaN here used to poison gravL permanently
    gScale += (gsT - gScale) * (1 - Math.exp(-Math.min(dt, 0.25) * 3));
    gravL.multiplyScalar(Math.max(P.minGravityScale, gScale));
    const wl = windW.length();
    windL.copy(windW).transformDirection(rootInv).multiplyScalar(wl);

    time += dt;
    // physics intensity (character group): scales iterations + substeps; exactly 1 = the original behaviour
    let kI = 1; if (opts.getIntensity) { try { kI = +opts.getIntensity(); } catch (e) { kI = 1; } }
    kI = kI >= 0.5 ? Math.min(3, kI) : (kI > 0 ? 0.5 : 1); stats.intensity = kI;
    curIts = Math.max(1, Math.round(((curTier >= 2 && P.iterationsFine) ? P.iterationsFine : (P.iterations | 0)) * kI));
    const n = Math.min(3, Math.max(1, Math.round(Math.min(2, Math.max(1, Math.ceil(dt / (1 / 60)))) * kI)));
    const h = Math.min(dt, 1 / 30) / n;
    const fillF = () => {
      const F = gF, hh = h * h, gs = P.gravity * hh, wd = P.drag * hh;
      F.M.set(me); F.Mi.set(mi);
      F.grav[0] = gravL.x * gs; F.grav[1] = gravL.y * gs; F.grav[2] = gravL.z * gs; F.grav[3] = Math.pow(P.damping, h * 60);
      F.wind[0] = windL.x * wd; F.wind[1] = windL.y * wd; F.wind[2] = windL.z * wd; F.wind[3] = P.windGust;
      F.shift[0] = shx; F.shift[1] = shy; F.shift[2] = shz; F.shift[3] = reset ? 1 : 0;
      F.trig[0] = Math.sin(time * 2.1); F.trig[1] = Math.cos(time * 2.1); F.trig[2] = Math.sin(time * 0.7); F.trig[3] = Math.cos(time * 0.7);
      F.hc[0] = hcx; F.hc[1] = hcy; F.hc[2] = hcz; F.hc[3] = hcR2;
      F.p0[0] = hsc2; F.p0[1] = P.friction; F.p0[2] = P.stretchBias; F.p0[3] = P.hairRadius;
      F.ip[0] = Math.max(1, curIts || (P.iterations | 0)); F.ip[1] = Math.max(1, P.sdfEvery | 0); F.ip[2] = (P.capsuleEveryIteration ? 1 : 0) | (P.broadPhase ? 2 : 0) | (SDF ? 4 : 0); F.ip[3] = n;
      F.ext.length = 0;
      for (const C of extra) F.ext.push([C.la.x, C.la.y, C.la.z, C.lb.x, C.lb.y, C.lb.z, C.lr]);
      if (stiffDirty) { gc.setStiffness(); stiffDirty = false; }
      return F;
    };
    if (onGPU) {
      try { gc.setFrame(fillF()); gc.run(gcTex, !!P.countContacts); stats.uploadBytes = gc.bytesLastFrame; }
      catch (e) { gcFail('run', e); }
    } else {
      let ran = false;
      if (probe) { try { gc.setFrame(fillF()); ran = gc.run(null, false); } catch (e) { gcFail('run', e); } }
      if (probe && gc && !ran) gcResync = true;   // pipeline not ready yet: hand the CPU state over again once it is
      for (let s = 0; s < n; s++) step(h, time);
      sanitizeCPU();
      stats.uploadBytes = gpu ? GK * 16 : VERTS * 24;
      if (probe && gc && ran) probeCheck();
    }
    const tSim = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    stats.simMs = tSim - t0;

    /* ---- write render ribbons ---- */
    if (haveCam) camL.copy(camPos).applyMatrix4(rootInv); else camL.set(0, 1.6, 3);
    const wR = P.widthRoot, wT = P.widthTip, cc = SDF && P.collideChildren;
    frame++;
    // host-driven child count (game: Auto graphics preset); re-read every ~2 s, cheap
    if (opts.getStrandFraction && frame % 120 === 1) { try { const f = +opts.getStrandFraction(); if (f > 0 && Math.abs(f - P.strandFraction) > 1e-3) setStrandFraction(f); } catch (e) {} }
    if (onGPU && !gpu) { stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0; stats.mode = 'gpu-compute'; return; }   // headless (tests)
    if (gpu && onGPU) {
      const U = gpu.U;
      U.M.value.copy(M); U.Mi.value.copy(Mi); U.cam.value.copy(camL);
      U.hc.value.set(hcx, hcy, hcz); U.hcR2.value = hcR2; U.hsc2.value = hsc2;
      U.wR.value = wR; U.wT.value = wT; U.cc.value = cc ? 1 : 0;
      stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      stats.drawn = NR; stats.interleave = 1; stats.mode = 'gpu-compute';
      return;
    }
    if (gpu) {
      if (gc) stats.mode = 'gpu';
      // deflection of every guide point from its groom (exactly what the CPU loop adds per child)
      const d = gpu.disp;
      for (let i = 0; i < GK; i++) { const o = i * 3, q = i * 4, w3 = ((i / K) | 0) * 3; d[q] = sp[o] - restM[o] + wG[w3]; d[q + 1] = sp[o + 1] - restM[o + 1] + wG[w3 + 1]; d[q + 2] = sp[o + 2] - restM[o + 2] + wG[w3 + 2]; }
      gpu.tDisp.needsUpdate = true;   // (GPU solve: never set, the compute pass writes this texture)
      const U = gpu.U;
      U.M.value.copy(M); U.Mi.value.copy(Mi); U.cam.value.copy(camL);
      U.hc.value.set(hcx, hcy, hcz); U.hcR2.value = hcR2; U.hsc2.value = hsc2;
      U.wR.value = wR; U.wT.value = wT; U.cc.value = cc ? 1 : 0;
      stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      stats.drawn = NR; stats.interleave = 1;
      if (!P.verifyRibbons) return;   // debug: also fill the CPU ribbon arrays (H.ribbonArrays) to diff against the shader
    }
    // interleave (slow devices) refreshes only every il-th ribbon; while the head turns, a ribbon
    // left from the last frame would hang off the old scalp, so those frames refresh them all
    const il = headMoved || gpu ? 1 : (P.interleave | 0 || 1);
    for (let s = frame % il; s < NR; s += il) {
      const g = guideOf[s], wS = wScale[s];
      const rb = s * K * 3, gb = g * K * 3, cb = s * K, kmc = kMaxC[s];
      for (let k = 0; k < K; k++) {
        const o = rb + k * 3, x = rest[o], y = rest[o + 1], z = rest[o + 2];
        const go = gb + k * 3, so = k * 3;
        const ddx = sp[go] - restM[go] + wG[g * 3], ddy = sp[go + 1] - restM[go + 1] + wG[g * 3 + 1], ddz = sp[go + 2] - restM[go + 2] + wG[g * 3 + 2];
        SP[so] = me[0] * x + me[4] * y + me[8] * z + me[12] + ddx;
        SP[so + 1] = me[1] * x + me[5] * y + me[9] * z + me[13] + ddy;
        SP[so + 2] = me[2] * x + me[6] * y + me[10] * z + me[14] + ddz;
        // children never cut into the scalp (only checked once deflected past their groom slack)
        if (cc && k >= 2 && k <= kmc && ddx * ddx + ddy * ddy + ddz * ddz > slkC[cb + k] * hsc2) headCollide(SP, so, clrC[cb + k]);
      }
      // per-strand view vector (normalised once) for the volumetric normal
      let sx0 = camL.x - SP[0], sy0 = camL.y - SP[1], sz0 = camL.z - SP[2];
      const sl = Math.sqrt(sx0 * sx0 + sy0 * sy0 + sz0 * sz0) || 1e-9; sx0 /= sl; sy0 /= sl; sz0 /= sl;
      for (let k = 0; k < K; k++) {
        const k0 = k > 0 ? k - 1 : 0, k1 = k < K - 1 ? k + 1 : K - 1;
        const tx = SP[k1 * 3] - SP[k0 * 3], ty = SP[k1 * 3 + 1] - SP[k0 * 3 + 1], tz = SP[k1 * 3 + 2] - SP[k0 * 3 + 2];
        const px = SP[k * 3], py = SP[k * 3 + 1], pz = SP[k * 3 + 2];
        const vx = camL.x - px, vy = camL.y - py, vz = camL.z - pz;
        let wx = ty * vz - tz * vy, wy = tz * vx - tx * vz, wz = tx * vy - ty * vx;
        const wd = (wR + (wT - wR) * (k / (K - 1))) * wS * 0.5 / (Math.sqrt(wx * wx + wy * wy + wz * wz) || 1e-9);
        wx *= wd; wy *= wd; wz *= wd;
        const ro = rb + k * 3, rx0 = radial[ro], ry0 = radial[ro + 1], rz0 = radial[ro + 2];
        const nx = sx0 * 0.55 + (me[0] * rx0 + me[4] * ry0 + me[8] * rz0) * 0.45;
        const ny = sy0 * 0.55 + (me[1] * rx0 + me[5] * ry0 + me[9] * rz0) * 0.45;
        const nz = sz0 * 0.55 + (me[2] * rx0 + me[6] * ry0 + me[10] * rz0) * 0.45;
        const vo = (s * K + k) * 6;
        pos[vo] = px - wx; pos[vo + 1] = py - wy; pos[vo + 2] = pz - wz;
        pos[vo + 3] = px + wx; pos[vo + 4] = py + wy; pos[vo + 5] = pz + wz;
        nrm[vo] = nx; nrm[vo + 1] = ny; nrm[vo + 2] = nz; nrm[vo + 3] = nx; nrm[vo + 4] = ny; nrm[vo + 5] = nz;
      }
    }
    aPos.needsUpdate = true; aNrm.needsUpdate = true;
    stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    stats.drawn = NR;
    // adaptive governor: trade ribbon refresh rate (interleave) for CPU time on slow devices
    ema += (stats.ms - ema) * 0.05;
    if (P.autoQuality && --cool <= 0) {
      if (ema > 3.5 && (P.interleave | 0 || 1) < 3) { P.interleave = (P.interleave | 0 || 1) + 1; cool = 90; }
      else if (ema < 1.4 && (P.interleave | 0 || 1) > 1) { P.interleave = (P.interleave | 0 || 1) - 1; cool = 240; }
    }
    stats.interleave = P.interleave | 0 || 1;
  }

  /* ---------------- hook: run after the character's mixer each frame ---------------- */
  let origUpdate = null;
  const hook = () => {
    if (!CHAR.mixer || CHAR.mixer.__hairHooked) return;
    origUpdate = CHAR.mixer.update.bind(CHAR.mixer);
    CHAR.mixer.update = function (dt) {
      const r = origUpdate(dt);
      { const w = nowMs(); if (lastWall && w - lastWall > P.hitchMs) hitch = true; lastWall = w; }
      if (P.deferToRender && renderSeen && mesh.visible) { if (dt > 0) pendingDt = Math.min(pendingDt + dt, 0.1); }
      else { try { update(dt); } catch (e) { if (!H._warned) { H._warned = 1; console.warn('[hair] update', e); } } }
      return r;
    };
    CHAR.mixer.__hairHooked = true;
  };

  const H = {
    params: P, stats, mesh, update, meta, get gpu() { return gpu; }, ribbonArrays: { pos, nrm },
    setEnabled(v) { P.enabled = !!v; mesh.visible = !!v; if (v) { unprime(); needInit = true; } else { setCards(true); setScalp(false); primed = false; } },
    setStrandFraction, setTint, groupNames: () => { const a = []; for (let g = 0; g < 256 && gCnt[g]; g++) a.push(groupName(g)); return a; },
    rebuildStiffness() { buildStiffness(); stiffDirty = true; },
    get compute() { return gc || null; },
    // debug / parity: GPU guide state read back (null on the CPU path)
    async readGuides() { return gc ? gc.read() : null; },
    _dbg() { return { sp, sq, restM }; },
    get tier() { return curTier; },
    // test / tools: the active capsules (root-local a, b, r) and boxes (t, Ainv, A, h, margin, 1/scale), margin per guide point
    _capsules() { const o = []; for (let c = 0; c < nCols; c++) { const q = c * 7; o.push({ a: [colBuf[q], colBuf[q + 1], colBuf[q + 2]], b: [colBuf[q + 3], colBuf[q + 4], colBuf[q + 5]], r: colBuf[q + 6], bone: cols[c].bone.name }); } return o; },
    _boxes() { return CS.boxes.map((B, c) => ({ name: B.name, bone: B.bone.name, buf: Array.from(CS.bbuf.subarray(c * BOXS, (c + 1) * BOXS)) })); },
    _margins() { return mrgG; },
    groupOf(s) { return group[s]; },   // test / tools: cluster id of strand s
    groupName(s) { const c = clusterOf(group[s]); return c.name || ('g' + group[s]); },
    get recovered() { return resanitized; },
    hitchNow() { hitch = true; },
    // test: points of a guide state inside the head (d < 0) / closer than 50 % of their clearance
    _penetration(a) {
      let inside = 0, under = 0; if (!SDF) return { inside, under };
      for (let g = 0; g < G; g++) for (let k = 2; k <= kMaxG[g]; k++) {
        const o = (g * K + k) * 3, x = a[o], y = a[o + 1], z = a[o + 2];
        const hx = mi[0] * x + mi[4] * y + mi[8] * z + mi[12], hy = mi[1] * x + mi[5] * y + mi[9] * z + mi[13], hz = mi[2] * x + mi[6] * y + mi[10] * z + mi[14];
        let d; const n = (WARP && WARP.on) ? warpNode(hx, hy, hz) : -1; // same skin-following field the solver collides with
        if (n >= 0) { warpDisp(n, hx, hy, hz); d = sdf(hx - wd[0], hy - wd[1], hz - wd[2]); } else d = sdf(hx, hy, hz);
        if (d < 0) inside++; else if (d < clrG[g * K + k] * 0.5) under++;
      }
      return { inside, under };
    },
    addCollider(c) { extra.push(c); return c; },
    removeCollider(c) { const i = extra.indexOf(c); if (i >= 0) extra.splice(i, 1); },
    reset() { needInit = true; haveLast = false; havePM = false; },
    dispose() { root.remove(mesh); geo.dispose(); mesh.material.dispose(); if (gpu) gpu.textures.forEach((t) => t.dispose()); setCards(true); setScalp(false); if (scalpMat) scalpMat.dispose(); if (CHAR.mixer && origUpdate) { CHAR.mixer.update = origUpdate; CHAR.mixer.__hairHooked = false; } }
  };
  // headless / test: solve on a caller-supplied GPUDevice without a renderer (no texture copy)
  if (opts.computeDevice) { gc = createGuideSolverGPU(opts.computeDevice, { G, K, gRest, segLen, bendLen, gStiff, gBend, clrG, slkG, kMaxG, SDF }); gcTex = null; gcResync = true; }
  if (!opts.manual) hook();
  H.hook = hook;
  return H;
}

/* ============================================================================
   Guide-strand PBD on WebGPU compute (engine-v90).
   One invocation per guide runs the exact CPU step() (integrate, bending, length,
   head SDF, body capsules with broad phase, friction) on persistent storage
   buffers; the CPU only writes one small uniform block per frame (matrices,
   gravity / wind / gust phase, inertial shift, colliders). The result, guide
   deflection from the groom, is copied GPU->GPU into the ribbon shader's
   deflection texture, so nothing per point crosses the bus.
   D = { G, K, gRest, segLen, bendLen, gStiff, gBend, clrG, slkG, kMaxG, SDF }
   ========================================================================== */
export const HAIR_GPU_MAX_COLS = 16, HAIR_GPU_MAX_EXTRA = 8;
const UF = 32 + 4 * 13 + 8 * HAIR_GPU_MAX_COLS + 4 * HAIR_GPU_MAX_COLS + 8 * HAIR_GPU_MAX_EXTRA;   // floats in the uniform block
export function hairGuideWGSL(K) {
  return /* wgsl */`
const K : u32 = ${K}u;
struct Cap { a : vec4f, b : vec4f };
struct U {
  M : mat4x4f, Mi : mat4x4f,
  grav : vec4f,   // gravity*hh (xyz), damp
  wind : vec4f,   // wind*drag*hh (xyz), windGust
  shift : vec4f,  // inertial shift (xyz), reset flag
  trig : vec4f,   // sin/cos(t*2.1), sin/cos(t*0.7)
  hc : vec4f,     // SDF bounding sphere centre (root-local), R^2
  p0 : vec4f,     // hsc2, friction, stretchBias, hairRadius
  ip : vec4u,     // iterations, sdfEvery, flags(1 capsAll, 2 broadPhase, 4 sdf), substeps
  cnt : vec4u,    // nCols, nExtra, G, 0
  sdfO : vec4f,   // origin xyz, inv cell
  sdfN : vec4u,   // nx ny nz
  sdfU : vec4f,   // unit
  pad0 : vec4f, pad1 : vec4f,
  col : array<Cap, ${HAIR_GPU_MAX_COLS}>,
  sph : array<vec4f, ${HAIR_GPU_MAX_COLS}>,
  ext : array<Cap, ${HAIR_GPU_MAX_EXTRA}>,
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var<storage, read> A : array<vec4f>;      // rest xyz, segLen to previous
@group(0) @binding(2) var<storage, read> B : array<vec4f>;      // stiff, bend, clearance, slack^2
@group(0) @binding(3) var<storage, read> C : array<vec4f>;      // bendLen, kMax (float), 0, 0
@group(0) @binding(4) var<storage, read> S : array<f32>;        // head SDF
@group(0) @binding(5) var<storage, read_write> st : array<vec4f>;  // sp [0,GK), sq [GK,2GK)
@group(0) @binding(6) var<storage, read_write> outD : array<vec4f>; // deflection, 16 texels per guide row
@group(0) @binding(7) var<storage, read_write> contacts : atomic<u32>;

var<private> p : array<vec3f, ${K}>;
var<private> q : array<vec3f, ${K}>;
var<private> r : array<vec3f, ${K}>;
var<private> hit_sdf : bool;

fn nz1(x : f32) -> f32 { return select(x, 1e-9, x == 0.0); }

fn sdfAt(b : u32) -> f32 { return S[b]; }
// push root-local point x out of the head SDF to clearance c (port of headCollide)
fn headCollide(x : vec3f, c : f32) -> vec3f {
  hit_sdf = false;
  let e = x - u.hc.xyz;
  if (dot(e, e) > u.hc.w) { return x; }
  let h = (u.Mi * vec4f(x, 1.0)).xyz;
  let f = (h - u.sdfO.xyz) * u.sdfO.w;
  let n = u.sdfN;
  if (f.x < 0.0 || f.y < 0.0 || f.z < 0.0 || f.x >= f32(n.x - 1u) || f.y >= f32(n.y - 1u) || f.z >= f32(n.z - 1u)) { return x; }
  let fi = floor(f); let t = f - fi; let w = vec3f(1.0) - t;
  let nzz = n.z; let nyz = n.y * n.z;
  let b = (u32(fi.x) * n.y + u32(fi.y)) * nzz + u32(fi.z);
  let c000 = sdfAt(b); let c001 = sdfAt(b + 1u); let c010 = sdfAt(b + nzz); let c011 = sdfAt(b + nzz + 1u);
  let c100 = sdfAt(b + nyz); let c101 = sdfAt(b + nyz + 1u); let c110 = sdfAt(b + nyz + nzz); let c111 = sdfAt(b + nyz + nzz + 1u);
  let c00 = c000 * w.z + c001 * t.z; let c01 = c010 * w.z + c011 * t.z; let c10 = c100 * w.z + c101 * t.z; let c11 = c110 * w.z + c111 * t.z;
  let c0 = c00 * w.y + c01 * t.y; let c1 = c10 * w.y + c11 * t.y;
  let g = vec3f(c1 - c0, (c01 - c00) * w.x + (c11 - c10) * t.x,
                ((c001 - c000) * w.y + (c011 - c010) * t.y) * w.x + ((c101 - c100) * w.y + (c111 - c110) * t.y) * t.x);
  let gl = length(g);
  var gn = vec3f(0.0, 1.0, 0.0);
  if (gl > 1e-6) { gn = g / gl; }
  let d = (c0 * w.x + c1 * t.x) * u.sdfU.x;
  if (d >= c) { return x; }
  hit_sdf = true;
  return (u.M * vec4f(h + gn * (c - d), 1.0)).xyz;
}
fn near(k : u32, i : u32) -> bool { let d = p[k] - r[k]; return dot(d, d) > B[i].w * u.p0.x; }

fn step(g : u32) -> u32 {
  let base = g * K;
  let damp = u.grav.w;
  let fr = 1.0 - u.p0.y;
  var nc = 0u;
  for (var k = 0u; k < 2u; k++) { p[k] = r[k]; q[k] = r[k]; }
  let ph = f32(g) * 0.37;
  let s1 = u.trig.x * cos(ph) + u.trig.y * sin(ph);
  let s2 = u.trig.z * cos(ph * 1.7) + u.trig.w * sin(ph * 1.7);
  let gust = 1.0 + u.wind.w * s1 * s2;
  let wv = u.wind.xyz * gust;
  for (var k = 2u; k < K; k++) {
    let v = (p[k] - q[k]) * damp;
    q[k] = p[k];
    var x = p[k] + v + u.grav.xyz + wv;
    x += (r[k] - x) * B[base + k].x;
    p[k] = x;
  }
  let its = max(1u, u.ip.x); let sdfEvery = max(1u, u.ip.y); let fl = u.ip.z;
  let wp = u.p0.z; let hr = u.p0.w;
  let km = u32(C[base].y);
  for (var it = 0u; it < its; it++) {
    let last = it == its - 1u;
    let doSdf = (fl & 4u) != 0u && (last || (it % sdfEvery) == sdfEvery - 1u);
    for (var k = 2u; k < K; k++) {
      let i = base + k;
      { // bending
        let e = p[k] - p[k - 2u];
        let el = nz1(length(e));
        let ed = (el - C[i].x) / el * B[i].y;
        if (k <= 3u) { p[k] -= e * ed; }
        else { let h1 = ed * 0.5; p[k - 2u] += e * h1; p[k] -= e * h1; }
      }
      let dd = p[k] - p[k - 1u];
      let len = nz1(length(dd));
      let diff = (len - A[i].w) / len;
      if (k == 2u) { p[k] -= dd * diff; }
      else { p[k - 1u] += dd * (wp * diff); p[k] -= dd * ((1.0 - wp) * diff); }
      if (doSdf && k <= km && near(k, i)) {
        let x0 = p[k];
        let nx = headCollide(p[k], B[i].z);
        if (hit_sdf) {
          p[k] = nx; nc++;
          q[k] += p[k] - x0;
          q[k] = p[k] + (q[k] - p[k]) * fr;
        }
      }
    }
    if ((fl & 1u) != 0u || last) {
      let nCols = u.cnt.x; let nExt = u.cnt.y;
      for (var k0 = 2u; k0 < K; k0 += 4u) {
        let k1 = min(K, k0 + 4u);
        var lo = vec3f(1e9); var hi = vec3f(-1e9);
        for (var k = k0; k < k1; k++) { lo = min(lo, p[k]); hi = max(hi, p[k]); }
        var hm = 0u;   // bitmask of capsules passing the broad phase
        for (var c = 0u; c < nCols; c++) {
          let s = u.sph[c];
          let dl = max(max(lo - s.xyz, s.xyz - hi), vec3f(0.0));
          if ((fl & 2u) == 0u || dot(dl, dl) <= s.w * s.w) { hm |= (1u << c); }
        }
        if (hm == 0u && nExt == 0u) { continue; }
        for (var k = k0; k < k1; k++) {
          var hit = false;
          for (var c = 0u; c < nCols; c++) {
            if ((hm & (1u << c)) == 0u) { continue; }
            let a = u.col[c].a.xyz; let ab = u.col[c].b.xyz - a;
            let ab2 = dot(ab, ab);
            var t = 0.0;
            if (ab2 > 1e-12) { t = dot(p[k] - a, ab) / ab2; }
            t = clamp(t, 0.0, 1.0);
            let cc = a + ab * t; let dv = p[k] - cc; let d2 = dot(dv, dv); let rr = u.col[c].a.w + hr;
            if (d2 < rr * rr) {
              let d = select(sqrt(d2), 1e-6, d2 == 0.0);
              let n = cc + dv * (rr / d);
              q[k] += n - p[k]; p[k] = n; hit = true;
            }
          }
          for (var c = 0u; c < nExt; c++) {
            let a = u.ext[c].a.xyz; let ab = u.ext[c].b.xyz - a;
            let ab2 = dot(ab, ab);
            var t = 0.0;
            if (ab2 > 1e-12) { t = dot(p[k] - a, ab) / ab2; }
            t = clamp(t, 0.0, 1.0);
            let cc = a + ab * t; let dv = p[k] - cc; let d2 = dot(dv, dv); let rr = u.ext[c].a.w + hr;
            if (d2 < rr * rr) {
              let d = select(sqrt(d2), 1e-6, d2 == 0.0);
              let n = cc + dv * (rr / d);
              q[k] += n - p[k]; p[k] = n;
              q[k] = n + (q[k] - n) * fr;
            }
          }
          if (hit) {
            q[k] = p[k] + (q[k] - p[k]) * fr;
            if ((fl & 4u) != 0u && k <= km && near(k, base + k)) { let nx = headCollide(p[k], B[base + k].z); if (hit_sdf) { p[k] = nx; } }
          }
        }
      }
    }
  }
  return nc;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let g = id.x;
  if (g >= u.cnt.z) { return; }
  let base = g * K; let GK = u.cnt.z * K;
  for (var k = 0u; k < K; k++) {
    r[k] = (u.M * vec4f(A[base + k].xyz, 1.0)).xyz;
    p[k] = st[base + k].xyz; q[k] = st[GK + base + k].xyz;
  }
  if (u.shift.w > 0.5) { for (var k = 0u; k < K; k++) { p[k] = r[k]; q[k] = r[k]; } }
  for (var k = 0u; k < K; k++) { p[k] += u.shift.xyz; q[k] += u.shift.xyz; }
  var nc = 0u;
  for (var s = 0u; s < u.ip.w; s++) { nc += step(g); }
  { // blow-up guard: NaN / runaway (> 2.5 x chain length from the groom, scaled) reseeds the guide to its groom
    var chain = 0.0;
    for (var k = 1u; k < K; k++) { chain += A[base + k].w; }
    let lim = 2.5 * chain; let lim2 = lim * lim * u.p0.x;
    var bad = false;
    for (var k = 2u; k < K; k++) { let dv = p[k] - r[k]; if (!(dot(dv, dv) < lim2)) { bad = true; } }
    if (bad) { for (var k = 0u; k < K; k++) { p[k] = r[k]; q[k] = r[k]; } }
  }
  for (var k = 0u; k < K; k++) {
    st[base + k] = vec4f(p[k], 0.0); st[GK + base + k] = vec4f(q[k], 0.0);
    outD[g * 16u + k] = vec4f(p[k] - r[k], 0.0);
  }
  if (nc > 0u) { atomicAdd(&contacts, nc); }
}`;
}

export function createGuideSolverGPU(device, D) {
  const { G, K } = D, GK = G * K;
  if (K > 16) throw new Error('[hair] compute path supports <= 16 points per strand');
  const BU = GPUBufferUsage;
  const mk = (data, usage) => { const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | BU.COPY_DST }); device.queue.writeBuffer(b, 0, data); return b; };
  const A = new Float32Array(GK * 4), Bv = new Float32Array(GK * 4), Cv = new Float32Array(GK * 4);
  for (let g = 0; g < G; g++) for (let k = 0; k < K; k++) {
    const i = g * K + k;
    A[i * 4] = D.gRest[i * 3]; A[i * 4 + 1] = D.gRest[i * 3 + 1]; A[i * 4 + 2] = D.gRest[i * 3 + 2]; A[i * 4 + 3] = k ? D.segLen[g * (K - 1) + k - 1] : 0;
    Cv[i * 4] = D.bendLen[i]; Cv[i * 4 + 1] = D.kMaxG[g];
  }
  const fillB = () => { for (let i = 0; i < GK; i++) { Bv[i * 4] = D.gStiff[i]; Bv[i * 4 + 1] = D.gBend[i]; Bv[i * 4 + 2] = D.clrG[i]; Bv[i * 4 + 3] = D.slkG[i]; } };
  fillB();
  const S = D.SDF;
  const sdfF = S ? Float32Array.from(S.v) : new Float32Array(4);
  const bufA = mk(A, BU.STORAGE), bufB = mk(Bv, BU.STORAGE), bufC = mk(Cv, BU.STORAGE), bufS = mk(sdfF, BU.STORAGE);
  const bufSt = device.createBuffer({ size: GK * 2 * 16, usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
  const bufOut = device.createBuffer({ size: G * 16 * 16, usage: BU.STORAGE | BU.COPY_SRC });
  const bufCnt = device.createBuffer({ size: 16, usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
  const bufU = device.createBuffer({ size: UF * 4, usage: BU.UNIFORM | BU.COPY_DST });
  const ub = new ArrayBuffer(UF * 4), uf = new Float32Array(ub), uu = new Uint32Array(ub);
  const module = device.createShaderModule({ code: hairGuideWGSL(K) });
  // async pipeline build: a sync createComputePipeline stalls the frame it's created in (seconds on some mobile drivers)
  let pipeline = null, bind = null, failed = null;
  const mkBind = (p) => device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [bufU, bufA, bufB, bufC, bufS, bufSt, bufOut, bufCnt].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const desc = { layout: 'auto', compute: { module, entryPoint: 'main' } };
  const ready = (device.createComputePipelineAsync ? device.createComputePipelineAsync(desc) : Promise.resolve(device.createComputePipeline(desc)))
    .then((p) => { pipeline = p; bind = mkBind(p); return true; }, (e) => { failed = e || new Error('pipeline'); return false; });
  const zero4 = new Uint32Array(4);
  let bytes = 0, rbBuf = null;
  const api = {
    G, K, uf, uu, ready,
    get pipeline() { return pipeline; }, get isReady() { return !!pipeline; }, get failed() { return failed; },
    get bytesLastFrame() { return bytes; },
    // copy CPU state (sp, sq: Float32Array GK*3) into the persistent buffers (handoff / reseed)
    setState(sp, sq) {
      const t = new Float32Array(GK * 8);
      for (let i = 0; i < GK; i++) { t.set(sp.subarray(i * 3, i * 3 + 3), i * 4); t.set(sq.subarray(i * 3, i * 3 + 3), (GK + i) * 4); }
      device.queue.writeBuffer(bufSt, 0, t);
    },
    setStiffness() { fillB(); device.queue.writeBuffer(bufB, 0, Bv); },
    // fill the uniform block; F = { M, Mi (Float32/64 16), grav[4], wind[4], shift[4], trig[4], hc[4], p0[4], ip[4], cols, sph, nCols, ext[], sdf }
    setFrame(F) {
      uf.fill(0);
      uf.set(F.M, 0); uf.set(F.Mi, 16);
      uf.set(F.grav, 32); uf.set(F.wind, 36); uf.set(F.shift, 40); uf.set(F.trig, 44); uf.set(F.hc, 48); uf.set(F.p0, 52);
      uu.set(F.ip, 56); uu[60] = F.nCols; uu[61] = F.ext.length; uu[62] = G;
      if (S) { uf[64] = S.ox; uf[65] = S.oy; uf[66] = S.oz; uf[67] = S.inv; uu[68] = S.nx; uu[69] = S.ny; uu[70] = S.nz; uf[72] = S.unit; }
      const co = 84, so = co + 8 * HAIR_GPU_MAX_COLS, eo = so + 4 * HAIR_GPU_MAX_COLS;
      for (let c = 0; c < F.nCols; c++) {
        const q = c * 7, o = co + c * 8;
        uf[o] = F.cols[q]; uf[o + 1] = F.cols[q + 1]; uf[o + 2] = F.cols[q + 2]; uf[o + 3] = F.cols[q + 6];
        uf[o + 4] = F.cols[q + 3]; uf[o + 5] = F.cols[q + 4]; uf[o + 6] = F.cols[q + 5];
        uf[so + c * 4] = F.sph[c * 8]; uf[so + c * 4 + 1] = F.sph[c * 8 + 1]; uf[so + c * 4 + 2] = F.sph[c * 8 + 2]; uf[so + c * 4 + 3] = F.sph[c * 8 + 3];
      }
      for (let c = 0; c < F.ext.length; c++) { const e = F.ext[c], o = eo + c * 8; uf[o] = e[0]; uf[o + 1] = e[1]; uf[o + 2] = e[2]; uf[o + 3] = e[6]; uf[o + 4] = e[3]; uf[o + 5] = e[4]; uf[o + 6] = e[5]; }
      const used = (F.ext.length ? eo + 8 * F.ext.length : so + 4 * F.nCols) * 4;
      device.queue.writeBuffer(bufU, 0, ub, 0, used);
      bytes = used;
    },
    // dispatch the solve; optionally copy the deflection into a G-row x K-column rgba32float texture
    run(texture, countContacts) {
      if (failed) throw failed;
      if (!pipeline) return false;   // still compiling: caller keeps the CPU result
      const enc = device.createCommandEncoder();
      if (countContacts) { device.queue.writeBuffer(bufCnt, 0, zero4); bytes += 16; }
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(G / 64)); pass.end();
      if (texture) enc.copyBufferToTexture({ buffer: bufOut, bytesPerRow: 256, rowsPerImage: G }, { texture }, { width: K, height: G, depthOrArrayLayers: 1 });
      device.queue.submit([enc.finish()]);
      return true;
    },
    // async readback (debug / parity): { sp, sq, disp (GK*3), contacts }
    async read() {
      const rb = rbBuf || (rbBuf = device.createBuffer({ size: GK * 32 + G * 256 + 16, usage: BU.COPY_DST | BU.MAP_READ }));
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(bufSt, 0, rb, 0, GK * 32); enc.copyBufferToBuffer(bufOut, 0, rb, GK * 32, G * 256); enc.copyBufferToBuffer(bufCnt, 0, rb, GK * 32 + G * 256, 16);
      device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const f = new Float32Array((GK * 32 + G * 256 + 16) / 4); f.set(new Float32Array(rb.getMappedRange())); rb.unmap();
      const sp = new Float32Array(GK * 3), sq = new Float32Array(GK * 3), disp = new Float32Array(GK * 3);
      for (let i = 0; i < GK; i++) for (let c = 0; c < 3; c++) {
        sp[i * 3 + c] = f[i * 4 + c]; sq[i * 3 + c] = f[(GK + i) * 4 + c];
        const g = (i / K) | 0, k = i % K; disp[i * 3 + c] = f[GK * 8 + (g * 16 + k) * 4 + c];
      }
      return { sp, sq, disp, contacts: new Uint32Array(f.buffer, (GK * 8 + G * 64) * 4, 1)[0] };
    },
    destroy() { if (rbBuf) rbBuf.destroy(); [bufA, bufB, bufC, bufS, bufSt, bufOut, bufCnt, bufU].forEach((b) => b.destroy()); }
  };
  return api;
}
