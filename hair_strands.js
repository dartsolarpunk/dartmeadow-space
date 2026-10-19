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

export async function attachHairStrands(CHAR, THREE, opts = {}) {
  if (!CHAR || !CHAR.root) throw new Error('[hair] no character root');
  if (CHAR._hair) return CHAR._hair;
  const url = opts.url || 'characterassests/ariel_hair_strands.bin';
  const res = await fetch(url);
  if (!res.ok) throw new Error('[hair] fetch ' + url + ' -> ' + res.status);
  const buf = await res.arrayBuffer();
  const H = buildHair(CHAR, THREE, buf, opts);
  CHAR._hair = H;
  if (typeof window !== 'undefined') window.DART_HAIR = H;
  return H;
}

export function buildHair(CHAR, THREE, buf, opts = {}) {
  /* ---------------- parse ---------------- */
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'DHS1') throw new Error('[hair] bad magic ' + magic);
  const jl = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jl)));
  const dataStart = 12 + jl;
  let off = dataStart;
  const N = meta.count, K = meta.points, G = meta.guides;
  const rest = new Float32Array(buf, off, N * K * 3); off += N * K * 12;
  const group = new Uint8Array(buf, off, N); off += (N + 3) & ~3;
  const guideOf = new Uint32Array(buf, off, N); off += N * 4;
  const guideStrand = new Uint32Array(buf, off, G);
  // head signed-distance field (v2)
  let SDF = null;
  if (meta.sdf && meta.sdf.byteOffsetFromData != null) {
    const s = meta.sdf, n = s.dims[0] * s.dims[1] * s.dims[2];
    if (dataStart + s.byteOffsetFromData + n * 2 <= buf.byteLength)
      SDF = { v: new Int16Array(buf, dataStart + s.byteOffsetFromData, n), nx: s.dims[0], ny: s.dims[1], nz: s.dims[2],
              ox: s.origin[0], oy: s.origin[1], oz: s.origin[2], inv: 1 / s.cell, unit: s.unit || 1e-4 };
  }

  /* ---------------- guard: only attach to Ariel ---------------- */
  const cardMeshes = [];   // legacy skinned hair cards (none in the current GLB)
  let scalpMesh = null, isAriel = false;
  CHAR.root.traverse((o) => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    if (/Ariel.?Hair(?!Strands)/i.test(o.name)) cardMeshes.push(o);
    if (/^Scalp/i.test(o.name)) { scalpMesh = scalpMesh || o; isAriel = true; }
    if (/^Ariel/i.test(o.name)) isAriel = true;
  });
  if (!isAriel) throw new Error('[hair] character is not Ariel (no Scalp/Ariel mesh, different character file) - strands not attached');

  /* ---------------- bones + colliders ---------------- */
  const root = CHAR.root;
  const findBone = (n) => (CHAR.bones && CHAR.bones[n]) || root.getObjectByName(n);
  const head = findBone(meta.headBone || 'Head');
  if (!head) throw new Error('[hair] Head bone not found');
  const cols = [];
  for (const c of meta.colliders || []) {
    // with the head SDF, the old single head sphere is replaced (it was smaller than the
    // skull at the back/crown and bulged past it above the ears)
    if (SDF && c.bone === (meta.headBone || 'Head')) continue;
    const b = findBone(c.bone);
    if (b) cols.push({ bone: b, a: new THREE.Vector3(...c.a), b: new THREE.Vector3(...c.b), r: c.r,
                       wa: new THREE.Vector3(), wb: new THREE.Vector3() });
  }
  const BODY = [
    ['Spine01', 'Spine', 0.125], ['Spine', 'neck', 0.125], ['Spine02', 'Spine01', 0.125],
    ['LeftShoulder', 'LeftArm', 0.06], ['RightShoulder', 'RightArm', 0.06],
    ['LeftArm', 'LeftForeArm', 0.052], ['RightArm', 'RightForeArm', 0.052],
    ['LeftForeArm', 'LeftHand', 0.042], ['RightForeArm', 'RightHand', 0.042],
    ['LeftHand', null, 0.05], ['RightHand', null, 0.05],
    ['Hips', 'Spine02', 0.14],
  ];
  if (opts.params ? opts.params.bodyColliders !== false : true) {
    const skip = (opts.params && opts.params.bodyExclude) || [];
    for (const [bn, cn, r] of BODY) {
      if (skip.includes(bn)) continue;
      const b = findBone(bn); if (!b) continue;
      const a = new THREE.Vector3(0, 0, 0), e = new THREE.Vector3(0, 0, 0);
      if (cn) { const c = findBone(cn); if (!c) continue; e.copy(c.position); if (c.parent !== b) continue; }
      cols.push({ bone: b, a, b: e, r, wa: new THREE.Vector3(), wb: new THREE.Vector3() });
    }
  }
  const nCols = cols.length;
  const colBuf = new Float32Array(nCols * 7);   // ax ay az bx by bz r (root-local), refreshed per frame
  const colSph = new Float32Array(nCols * 8);   // bounding sphere cx cy cz R per capsule
  const colHit = new Uint16Array(Math.max(1, nCols));

  /* ---------------- params ---------------- */
  const P = {
    enabled: true, gravity: 6.0, damping: 0.965,
    shapeStiffness: 0.6, tipStiffness: 0.02,        // weak global groom spring (head frame)
    bendRoot: 0.5, bendTip: 0.04,                  // local bending: combed at the root, drapes toward tips
    stretchBias: 0.5,                                // parent share of a length correction (root side heavier)
    wind: new THREE.Vector3(0, 0, 0), windGust: 0.35, iterations: 2, reach: 0.08, hairRadius: 0.006,
    minClear: 0.002, maxClear: 0.02, sdfEvery: 1, capsuleEveryIteration: false, broadPhase: true, friction: 0.35, collideChildren: true,
    maxRootStep: 0.06, drag: 1.6, motionWind: 0.05, maxMotionWind: 14, teleportSpeed: 400, popSpeed: 22, bodyColliders: true,
    minGravityScale: 0.0, interleave: 1, autoQuality: true, strandFraction: 1, scalpSheenOff: true,
    deferToRender: true,   // hooked mode: simulate in the strands' onBeforeRender, after every pose layer (see hook below)
    widthRoot: 0.0046, widthTip: 0.0022,
    ...(opts.params || {})
  };
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
    const d = sdf(x, y, z), c = Math.min(P.maxClear, Math.max(P.minClear, d * 0.7));
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
  const gRest = new Float32Array(GK * 3);
  const segLen = new Float32Array(G * (K - 1));
  const bendLen = new Float32Array(GK);   // |p_k - p_(k-2)| in the groom: symmetric bending constraint
  const gStiff = new Float32Array(GK), gBend = new Float32Array(GK), clrG = new Float32Array(GK), slkG = new Float32Array(GK);
  const gNear = new Uint8Array(GK);   // point can be near the head (rest within SDF box + slack)
  function buildStiffness() {
    for (let g = 0; g < G; g++) {
      const s = guideStrand[g];
      const gr = group[s], boost = gr === 1 ? 1.6 : gr === 2 ? 1.8 : 1.0;   // bangs / sideburns are short: hold shape harder
      for (let k = 0; k < K; k++) {
        const t = k / (K - 1), u = 1 - t;
        gStiff[g * K + k] = Math.min(0.9, (P.tipStiffness + (P.shapeStiffness - P.tipStiffness) * u * u * u * u) * boost);
        gBend[g * K + k] = Math.min(0.9, (P.bendTip + (P.bendRoot - P.bendTip) * u * u) * boost);
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
  let stiffDirty = false;
  const kMaxG = new Uint8Array(G);
  for (let g = 0; g < G; g++) kMaxG[g] = kMaxC[guideStrand[g]];
  const sp = new Float32Array(GK * 3);      // sim position (root-local)
  const sq = new Float32Array(GK * 3);      // previous position
  const restM = new Float32Array(GK * 3);   // guide rest in root-local (current head pose)
  let needInit = true;

  const SP = new Float32Array(K * 3);
  // static rest-pose radial direction (head-local) per point -> volumetric normals without per-frame sqrt
  const radial = new Float32Array(N * K * 3);
  { const hc = [0, 0.11, -0.03];
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
  for (let s = 0; s < N; s++) {
    const v = 0.75 + rnd() * 0.9;
    for (let k = 0; k < K * 2; k++) { const o = (s * K * 2 + k) * 3; col[o] = base[0] * v; col[o + 1] = base[1] * v; col[o + 2] = base[2] * v; }
  }
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3); aPos.setUsage(THREE.DynamicDrawUsage);
  const aNrm = new THREE.BufferAttribute(nrm, 3); aNrm.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('normal', aNrm);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, color: 0xffffff, roughness: meta.roughness ?? 0.5, metalness: 0.15,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ArielHairStrands';
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
  const camPos = new THREE.Vector3();
  let haveCam = false;
  // Deferred step (hooked mode): the game turns and levels her head AFTER the mixer update while
  // she rides (applySkyboardHeadOverride, up to 1.5 rad), so a sim run inside mixer.update saw the
  // pre-override head and the strands floated off the rotated scalp. Running the step here, after
  // the renderer has updated every world matrix, always matches the skinned scalp being drawn.
  let pendingDt = 0, renderSeen = false;
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
        const wd = U.wR.add(U.wT.sub(U.wR).mul(float(kF).div(K - 1))).mul(0.5).div(w.length().max(1e-9));
        const sv = U.cam.sub(pr); const svn = sv.div(sv.length().max(1e-9));
        const rad = textureLoad(tRad, ivec2(k, s)).xyz;
        const n = svn.mul(0.55).add(U.M.mul(vec4(rad, 0)).xyz.mul(0.45));
        return { pos: pk.add(w.mul(wd).mul(side)), nrm: n };
      };
      const aId = attribute('hsId', 'vec3'), aGk = attribute('hsGk', 'vec2');
      const gmat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, color: 0xffffff, roughness: mat.roughness, metalness: mat.metalness, side: THREE.DoubleSide });
      gmat.positionNode = Fn(() => {
        const R = ribbon(aId.x, aId.y, aId.z, aGk.x, aGk.y);
        normalLocal.assign(R.nrm);
        return R.pos;
      })();
      // swap the geometry to static ids: no dynamic position / normal buffers at all
      geo.setAttribute('hsId', new THREE.BufferAttribute(ids, 3));
      geo.setAttribute('hsGk', new THREE.BufferAttribute(gk, 2));
      geo.setAttribute('position', new THREE.BufferAttribute(ids, 3));
      geo.deleteAttribute('normal');
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
  let gcTex = null, gcResync = false;
  function initCompute(renderer) {
    const be = renderer && renderer.backend;
    if (P.gpuCompute === false || !be || !be.isWebGPUBackend || !be.device || typeof GPUBufferUsage === 'undefined') return false;
    if (nCols > HAIR_GPU_MAX_COLS) return false;
    const td = be.get && be.get(gpu.tDisp);
    if (!td || !td.texture) return null;   // not uploaded yet: retry next frame (CPU solve meanwhile)
    try {
      const c = createGuideSolverGPU(be.device, { G, K, gRest, segLen, bendLen, gStiff, gBend, clrG, slkG, kMaxG, SDF });
      gcTex = td.texture; gcResync = true;
      be.device.lost && be.device.lost.then(() => { gc = false; needInit = true; });
      stats.mode = 'gpu-compute';
      return c;
    } catch (e) { console.warn('[hair] GPU guide solve unavailable, CPU path', e); return false; }
  }
  const gF = { M: new Float32Array(16), Mi: new Float32Array(16), grav: new Float32Array(4), wind: new Float32Array(4), shift: new Float32Array(4),
               trig: new Float32Array(4), hc: new Float32Array(4), p0: new Float32Array(4), ip: new Uint32Array(4), cols: colBuf, sph: colSph, nCols, ext: [] };

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
        scalpOrigMat = m0; scalpMat = m0.clone();
        if ('sheen' in scalpMat) scalpMat.sheen = 0;           // body material carries a skin-tone sheen
        if ('roughness' in scalpMat) scalpMat.roughness = Math.max(scalpMat.roughness || 0, meta.roughness ?? 0.8);
        scalpMat.needsUpdate = true;
      }
      scalpMesh.material = scalpMat;
    } else if (scalpOrigMat) { scalpMesh.material = scalpOrigMat; }
  }
  setCards(false); setScalp(true);

  /* ---------------- scratch ---------------- */
  const M = new THREE.Matrix4(), Mi = new THREE.Matrix4(), rootInv = new THREE.Matrix4(), tmpM = new THREE.Matrix4();
  const v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), camL = new THREE.Vector3(), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  const lastRootW = new THREE.Vector3(); let haveLast = false;
  let lhx = 0, lhy = 0, lhz = 0, haveHL = false;
  const gravL = new THREE.Vector3(), windL = new THREE.Vector3(), windW = new THREE.Vector3(), velS = new THREE.Vector3();
  let gScale = 1;
  const extra = [];   // user colliders
  let time = 0, frame = 0, ema = 2, cool = 0;
  const stats = { ms: 0, simMs: 0, strands: N, drawn: NR, guides: G, sdf: !!SDF, contacts: 0 };
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
    const d = sdf(hx, hy, hz);
    if (d >= c) return false;
    const p = c - d, nx = hx + sg[0] * p, ny = hy + sg[1] * p, nz = hz + sg[2] * p;
    a[o] = me[0] * nx + me[4] * ny + me[8] * nz + me[12];
    a[o + 1] = me[1] * nx + me[5] * ny + me[9] * nz + me[13];
    a[o + 2] = me[2] * nx + me[6] * ny + me[10] * nz + me[14];
    return true;
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
    const d2 = dx * dx + dy * dy + dz * dz, rr = r + P.hairRadius;
    if (d2 < rr * rr) {
      const d = Math.sqrt(d2) || 1e-6, k = rr / d;
      const nx = cx + dx * k, ny = cy + dy * k, nz = cz + dz * k;
      // move the previous position with the push (a contact must not inject velocity), then friction:
      // hair resting on a shoulder / arm settles instead of buzzing
      const f = 1 - P.friction;
      sq[o] += nx - px; sq[o + 1] += ny - py; sq[o + 2] += nz - pz;
      sp[o] = nx; sp[o + 1] = ny; sp[o + 2] = nz;
      sq[o] = nx + (sq[o] - nx) * f; sq[o + 1] = ny + (sq[o + 1] - ny) * f; sq[o + 2] = nz + (sq[o + 2] - nz) * f;
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
    const its = Math.max(1, P.iterations | 0), wp = P.stretchBias, sdfEvery = Math.max(1, P.sdfEvery | 0), capsAll = !!P.capsuleEveryIteration;
    for (let it = 0; it < its; it++) {
      const last = it === its - 1;
      const doSdf = SDF && (last || (it % sdfEvery) === sdfEvery - 1);
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
          // body capsules, broad phase per 4-point chunk (chunk AABB vs capsule bounding sphere)
          const fr2 = 1 - P.friction, hr = P.hairRadius;
          for (let k0 = 2; k0 < K; k0 += 4) {
            const k1 = Math.min(K, k0 + 4);
            let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
            for (let k = k0; k < k1; k++) {
              const o = gb + k * 3, x = sp[o], y = sp[o + 1], z = sp[o + 2];
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
            }
            let nh = 0;
            for (let c = 0; c < nCols; c++) {
              const q = c * 8, cx = colSph[q], cy = colSph[q + 1], cz = colSph[q + 2], R = colSph[q + 3];
              const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0, dy = cy < y0 ? y0 - cy : cy > y1 ? cy - y1 : 0, dz = cz < z0 ? z0 - cz : cz > z1 ? cz - z1 : 0;
              if (!P.broadPhase || dx * dx + dy * dy + dz * dz <= R * R) colHit[nh++] = c;
            }
            if (!nh && !extra.length) continue;
            for (let k = k0; k < k1; k++) {
              const o = gb + k * 3;
              let hit = false;
              for (let h2 = 0; h2 < nh; h2++) {
                const q = colHit[h2] * 7;
                const ax = colBuf[q], ay = colBuf[q + 1], az = colBuf[q + 2];
                const abx = colBuf[q + 3] - ax, aby = colBuf[q + 4] - ay, abz = colBuf[q + 5] - az;
                const px = sp[o], py = sp[o + 1], pz = sp[o + 2];
                const ab2 = abx * abx + aby * aby + abz * abz;
                let t = ab2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ab2 : 0;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const ccx = ax + abx * t, ccy = ay + aby * t, ccz = az + abz * t;
                const dx = px - ccx, dy = py - ccy, dz = pz - ccz, d2 = dx * dx + dy * dy + dz * dz, rr = colBuf[q + 6] + hr;
                if (d2 < rr * rr) {
                  const d = Math.sqrt(d2) || 1e-6, kk = rr / d;
                  const nx = ccx + dx * kk, ny = ccy + dy * kk, nz = ccz + dz * kk;
                  sq[o] += nx - px; sq[o + 1] += ny - py; sq[o + 2] += nz - pz;   // a contact must not inject velocity
                  sp[o] = nx; sp[o + 1] = ny; sp[o + 2] = nz; hit = true;
                }
              }
              for (let c = 0; c < extra.length; c++) { const C = extra[c]; capsuleCollide(o, C.la.x, C.la.y, C.la.z, C.lb.x, C.lb.y, C.lb.z, C.lr); }
              if (hit) {   // friction: resting on a shoulder / arm settles instead of buzzing
                sq[o] = sp[o] + (sq[o] - sp[o]) * fr2; sq[o + 1] = sp[o + 1] + (sq[o + 1] - sp[o + 1]) * fr2; sq[o + 2] = sp[o + 2] + (sq[o + 2] - sp[o + 2]) * fr2;
                // capsules may have pushed a point back into the head: SDF wins (it is the closer surface)
                if (SDF && k <= km && near(sp, o, sb + k)) headCollide(sp, o, clrG[sb + k]);
              }
            }
          }
        }
      }
    }
    stats.contacts = contacts;
  }

  function update(dt) {
    if (!P.enabled || !(dt > 0) || !root.visible) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    root.updateWorldMatrix(true, false);
    head.updateWorldMatrix(true, false);
    rootInv.copy(root.matrixWorld).invert();
    M.multiplyMatrices(rootInv, head.matrixWorld);   // head bone (= scalp frame) in root-local space
    Mi.copy(M).invert();
    me = M.elements; mi = Mi.elements;
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

    // colliders -> root-local capsules
    for (let c = 0; c < nCols; c++) {
      const C = cols[c], q = c * 7;
      tmpM.multiplyMatrices(rootInv, C.bone.matrixWorld);
      tmpA.copy(C.a).applyMatrix4(tmpM); tmpB.copy(C.b).applyMatrix4(tmpM);
      colBuf[q] = tmpA.x; colBuf[q + 1] = tmpA.y; colBuf[q + 2] = tmpA.z; colBuf[q + 3] = tmpB.x; colBuf[q + 4] = tmpB.y; colBuf[q + 5] = tmpB.z; colBuf[q + 6] = C.r;
      const p8 = c * 8;
      colSph[p8] = (tmpA.x + tmpB.x) / 2; colSph[p8 + 1] = (tmpA.y + tmpB.y) / 2; colSph[p8 + 2] = (tmpA.z + tmpB.z) / 2;
      colSph[p8 + 3] = tmpA.distanceTo(tmpB) / 2 + C.r + P.hairRadius;
    }
    for (const C of extra) {
      C.la = (C.la || new THREE.Vector3()).copy(C.center).applyMatrix4(rootInv);
      C.lb = (C.lb || new THREE.Vector3()).copy(C.end || C.center).applyMatrix4(rootInv);
      C.lr = C.radius * Math.cbrt(Math.abs(rootInv.determinant()));
    }
    const onGPU = !!(gc && !P.verifyRibbons && extra.length <= HAIR_GPU_MAX_EXTRA);
    if (gc && gcResync && onGPU) { gc.setState(sp, sq); gcResync = false; }
    if (!onGPU && gc) gcResync = true;   // CPU took over for a frame: re-sync the GPU state when it resumes
    let reset = needInit || popped, shx = 0, shy = 0, shz = 0;
    // guide rest pose in root-local
    for (let i = 0; i < GK && !onGPU; i++) {
      const o = i * 3, x = gRest[o], y = gRest[o + 1], z = gRest[o + 2];
      restM[o] = me[0] * x + me[4] * y + me[8] * z + me[12];
      restM[o + 1] = me[1] * x + me[5] * y + me[9] * z + me[13];
      restM[o + 2] = me[2] * x + me[6] * y + me[10] * z + me[14];
    }
    if (needInit) { if (!onGPU) { sp.set(restM); sq.set(restM); } needInit = false; }
    if (popped) { if (!onGPU) { sp.set(restM); sq.set(restM); } velS.set(0, 0, 0); haveLast = false; }

    // root world motion -> small clamped inertial shift + steady apparent wind (tracks the HEAD bone)
    v3.setFromMatrixPosition(head.matrixWorld);
    const rs = Math.cbrt(Math.abs(root.matrixWorld.determinant())) || 1;
    let motionWind = 0;
    if (haveLast && dt < 0.25) {
      v3b.copy(v3).sub(lastRootW);
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
    lastRootW.copy(v3); haveLast = true;
    const vl = velS.length(), spd = vl / rs;
    motionWind = Math.min(P.maxMotionWind, spd * P.motionWind);
    windW.copy(P.wind);
    if (spd > 1e-3) windW.addScaledVector(velS, -motionWind / (vl || 1));

    // gravity / wind into root-local directions
    const up = opts.getDown ? opts.getDown() : null;   // optional: world-space "down" vector
    gravL.set(up ? up.x : 0, up ? up.y : -1, up ? up.z : 0).transformDirection(rootInv);
    const gsT = opts.getGravityScale ? opts.getGravityScale() : 1;
    gScale += (gsT - gScale) * (1 - Math.exp(-dt * 3));
    gravL.multiplyScalar(Math.max(P.minGravityScale, gScale));
    const wl = windW.length();
    windL.copy(windW).transformDirection(rootInv).multiplyScalar(wl);

    time += dt;
    const n = Math.min(2, Math.max(1, Math.ceil(dt / (1 / 60))));
    const h = Math.min(dt, 1 / 30) / n;
    if (onGPU) {
      const F = gF, hh = h * h, gs = P.gravity * hh, wd = P.drag * hh;
      F.M.set(me); F.Mi.set(mi);
      F.grav[0] = gravL.x * gs; F.grav[1] = gravL.y * gs; F.grav[2] = gravL.z * gs; F.grav[3] = Math.pow(P.damping, h * 60);
      F.wind[0] = windL.x * wd; F.wind[1] = windL.y * wd; F.wind[2] = windL.z * wd; F.wind[3] = P.windGust;
      F.shift[0] = shx; F.shift[1] = shy; F.shift[2] = shz; F.shift[3] = reset ? 1 : 0;
      F.trig[0] = Math.sin(time * 2.1); F.trig[1] = Math.cos(time * 2.1); F.trig[2] = Math.sin(time * 0.7); F.trig[3] = Math.cos(time * 0.7);
      F.hc[0] = hcx; F.hc[1] = hcy; F.hc[2] = hcz; F.hc[3] = hcR2;
      F.p0[0] = hsc2; F.p0[1] = P.friction; F.p0[2] = P.stretchBias; F.p0[3] = P.hairRadius;
      F.ip[0] = Math.max(1, P.iterations | 0); F.ip[1] = Math.max(1, P.sdfEvery | 0); F.ip[2] = (P.capsuleEveryIteration ? 1 : 0) | (P.broadPhase ? 2 : 0) | (SDF ? 4 : 0); F.ip[3] = n;
      F.ext.length = 0;
      for (const C of extra) F.ext.push([C.la.x, C.la.y, C.la.z, C.lb.x, C.lb.y, C.lb.z, C.lr]);
      if (stiffDirty) { gc.setStiffness(); stiffDirty = false; }
      try { gc.setFrame(F); gc.run(gcTex, !!P.countContacts); stats.uploadBytes = gc.bytesLastFrame; }
      catch (e) { console.warn('[hair] GPU guide solve failed, CPU path', e); gc = false; needInit = true; }
    } else {
      for (let s = 0; s < n; s++) step(h, time);
      stats.uploadBytes = gpu ? GK * 16 : VERTS * 24;
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
      for (let i = 0; i < GK; i++) { const o = i * 3, q = i * 4; d[q] = sp[o] - restM[o]; d[q + 1] = sp[o + 1] - restM[o + 1]; d[q + 2] = sp[o + 2] - restM[o + 2]; }
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
      const g = guideOf[s];
      const rb = s * K * 3, gb = g * K * 3, cb = s * K, kmc = kMaxC[s];
      for (let k = 0; k < K; k++) {
        const o = rb + k * 3, x = rest[o], y = rest[o + 1], z = rest[o + 2];
        const go = gb + k * 3, so = k * 3;
        const ddx = sp[go] - restM[go], ddy = sp[go + 1] - restM[go + 1], ddz = sp[go + 2] - restM[go + 2];
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
        const wd = (wR + (wT - wR) * (k / (K - 1))) * 0.5 / (Math.sqrt(wx * wx + wy * wy + wz * wz) || 1e-9);
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
      if (P.deferToRender && renderSeen && mesh.visible) { if (dt > 0) pendingDt = Math.min(pendingDt + dt, 0.1); }
      else { try { update(dt); } catch (e) { if (!H._warned) { H._warned = 1; console.warn('[hair] update', e); } } }
      return r;
    };
    CHAR.mixer.__hairHooked = true;
  };

  const H = {
    params: P, stats, mesh, update, meta, get gpu() { return gpu; }, ribbonArrays: { pos, nrm },
    setEnabled(v) { P.enabled = !!v; mesh.visible = !!v; setCards(!v); setScalp(!!v); if (v) needInit = true; },
    setStrandFraction,
    rebuildStiffness() { buildStiffness(); stiffDirty = true; },
    get compute() { return gc || null; },
    // debug / parity: GPU guide state read back (null on the CPU path)
    async readGuides() { return gc ? gc.read() : null; },
    _dbg() { return { sp, sq, restM }; },
    // test: points of a guide state inside the head (d < 0) / closer than 50 % of their clearance
    _penetration(a) {
      let inside = 0, under = 0; if (!SDF) return { inside, under };
      for (let g = 0; g < G; g++) for (let k = 2; k <= kMaxG[g]; k++) {
        const o = (g * K + k) * 3, x = a[o], y = a[o + 1], z = a[o + 2];
        const hx = mi[0] * x + mi[4] * y + mi[8] * z + mi[12], hy = mi[1] * x + mi[5] * y + mi[9] * z + mi[13], hz = mi[2] * x + mi[6] * y + mi[10] * z + mi[14];
        const d = sdf(hx, hy, hz); if (d < 0) inside++; else if (d < clrG[g * K + k] * 0.5) under++;
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
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [bufU, bufA, bufB, bufC, bufS, bufSt, bufOut, bufCnt].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const zero4 = new Uint32Array(4);
  let bytes = 0, rbBuf = null;
  const api = {
    G, K, uf, uu, pipeline,
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
      const enc = device.createCommandEncoder();
      if (countContacts) { device.queue.writeBuffer(bufCnt, 0, zero4); bytes += 16; }
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(G / 64)); pass.end();
      if (texture) enc.copyBufferToTexture({ buffer: bufOut, bytesPerRow: 256, rowsPerImage: G }, { texture }, { width: K, height: G, depthOrArrayLayers: 1 });
      device.queue.submit([enc.finish()]);
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
