/* ============================================================================
   ui/dm-ariel-cloth.js — PROTOTYPE cloth solver for Ariel's garments (v190)
   OFF BY DEFAULT. Enable with  localStorage.dm_cloth_v1='1'  or URL ?cloth=1
   (window.DART_CLOTH.setEnabled(true|false) toggles at runtime and persists).

   Ariel ships as ONE multi-mesh skinned mesh (char1, 105,826 verts); garments are not
   separate meshes. Garments are therefore selected from the bind pose by region +
   texture colour, and the solver displaces those render vertices AFTER skinning
   (material.positionNode = positionLocal + clothOffset), so her rig, stance,
   skyboard pose, animation and the hair strand solver (hair_strands.js) are never
   touched. With the flag off this module is never imported.

   Physics: Earth gravity 9.81 m/s^2 (mesh units are metres, raw height 1.70),
   sea-level air drag (rho 1.225 kg/m^3, Cd 1.2, areal density 0.20 kg/m^2 ->
   quadratic drag k = 0.5*rho*Cd/sigma), verlet + PBD: neighbour distance
   constraints, tether to the skinned rest (garments are multi-mesh to the body), body
   + hair capsules on her bones, particle self-collision. The settled drape
   (pre-rolled on attach) is her default pose.
   Solver resolution: per garment, 25-50 % of that garment's render vertices
   (skirt 50 %). Belt, necklace and shoes are STIFF: bound to bones = pure skinning.
   GPU: TSL compute (WebGPU backend) for integrate/constraints/collision; CPU
   fallback runs the same steps. All buffers are preallocated: no per-frame allocs.
   ========================================================================== */
const G = 9.81, RHO = 1.225, CD = 1.2, SIGMA = 0.20, KDRAG = 0.5 * RHO * CD / SIGMA;
export const GARMENTS = [
  // match = garment SkinnedMesh name; res = solver particles / render verts; pinY: bind-space height above which it is bound
  // to the skin (shoulders / waistband); hang: max tether (m) at the free edge, growing linearly from pinY down to the hem.
  { name: 'shirt', match: /^Shirt/i,  res: 0.35, pinY: 1.30, hang: 0.035 },
  { name: 'pants', match: /^Pants/i,  res: 0.30, pinY: 0.93, hang: 0.012 },
  { name: 'skirt', match: /skirt/i,   res: 0.50, pinY: null, hang: 0.08 },   // higher resolution; Ariel has no skirt mesh yet
];
// stiff = bound to bones (pure skinning, never simulated): Belt, the necklace (Charm + neck Tube.004) and Shoes
export const STIFF = [ { name: 'belt', match: /^Belt/i }, { name: 'necklace', match: /^(Charm|Tube\.0*4\b|Tube\.004)/i }, { name: 'shoes', match: /^Shoes/i } ];
const CAPS = [ // bone a, bone b, radius (m), back offset (z, for the hair mass)
  ['Hips', 'Spine02', 0.125, 0], ['Spine02', 'Spine01', 0.12, 0], ['Spine01', 'Spine', 0.115, 0],
  ['LeftUpLeg', 'LeftLeg', 0.085, 0], ['RightUpLeg', 'RightLeg', 0.085, 0],
  ['LeftArm', 'LeftForeArm', 0.05, 0], ['RightArm', 'RightForeArm', 0.05, 0],
  ['neck', 'Spine01', 0.075, -0.07],   // hair: the hanging hair mass behind her back
];
export function clothWanted() {
  try { if (/[?&]cloth=1\b/.test(location.search)) return true; return localStorage.getItem('dm_cloth_v1') === '1'; } catch (e) { return false; }
}

// ---------- garment selection + particle clustering (shared with tools/bake-ariel-cloth.py) ----------
export function buildClothModel(geo, Gm) {
  const P = geo.attributes.position.array, nV = geo.attributes.position.count, idx = geo.index ? geo.index.array : null;
  const vPart = new Int32Array(nV).fill(-1), vW = new Float32Array(nV), parts = [], gStats = [];
  let y0 = 1e9, y1 = -1e9; for (let v = 0; v < nV; v++) { const y = P[v*3+1]; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const pinY = Gm.pinY != null ? Gm.pinY : y1 - 0.15 * (y1 - y0), span = Math.max(1e-3, pinY - y0);
  const sel = []; for (let v = 0; v < nV; v++) sel.push(v);
  {
    const target = Math.max(4, Math.round(nV * Gm.res)); let lo = 0.001, hi = 0.2, cell = 0.01, map = null;
    for (let it = 0; it < 22; it++) {
      cell = 0.5 * (lo + hi); map = new Map();
      for (const v of sel) { const k = Math.floor(P[v*3]/cell) + ',' + Math.floor(P[v*3+1]/cell) + ',' + Math.floor(P[v*3+2]/cell); if (!map.has(k)) map.set(k, []); map.get(k).push(v); }
      if (map.size > target) lo = cell; else hi = cell;
    }
    for (const vs of map.values()) {
      let cx = 0, cy = 0, cz = 0; for (const v of vs) { cx += P[v*3]; cy += P[v*3+1]; cz += P[v*3+2]; } cx /= vs.length; cy /= vs.length; cz /= vs.length;
      let best = vs[0], bd = 1e9; for (const v of vs) { const d = (P[v*3]-cx)**2 + (P[v*3+1]-cy)**2 + (P[v*3+2]-cz)**2; if (d < bd) { bd = d; best = v; } }
      const pi = parts.length, hangT = Math.min(1, Math.max(0, (pinY - cy) / span));
      parts.push({ rep: best, hang: Gm.hang * hangT, free: hangT > 0 ? 1 : 0 });
      for (const v of vs) { vPart[v] = pi; vW[v] = Math.min(1, Math.max(0, (pinY - P[v*3+1]) / span * 4)); }
    }
    gStats.push({ name: Gm.name, verts: nV, particles: parts.length, res: +(parts.length / nV).toFixed(3), cell: +cell.toFixed(4) });
  }
  // neighbour edges between particles from mesh triangles (max 8 each)
  const n = parts.length, K = 8, nb = new Int32Array(n * K).fill(-1);
  const add = (a, b) => { if (a < 0 || b < 0 || a === b) return; for (let k = 0; k < K; k++) { const s = nb[a*K+k]; if (s === b) return; if (s < 0) { nb[a*K+k] = b; return; } } };
  if (idx) for (let t = 0; t < idx.length; t += 3) { const a = vPart[idx[t]], b = vPart[idx[t+1]], c = vPart[idx[t+2]]; add(a,b); add(b,a); add(b,c); add(c,b); add(a,c); add(c,a); }
  return { parts, n, K, nb, vPart, vW, gStats };
}


// ---------- runtime ----------
export function attachArielCloth(CHAR, THREE, opts = {}) {
  if (!CHAR || !CHAR.root) throw new Error('[cloth] no character');
  if (CHAR._cloth) return CHAR._cloth;
  const found = [], stiff = [];
  CHAR.root.traverse(o => { if (!o.isSkinnedMesh) return; const g = GARMENTS.find(G => G.match.test(o.name)); if (g && !found.some(f => f.g === g)) found.push({ sm: o, g });
    const s = STIFF.find(S => S.match.test(o.name)); if (s) stiff.push(s.name + ':' + o.name); });
  const subs = found.map(f => makeGarment(CHAR, THREE, f.sm, f.g, opts)).filter(Boolean);
  const C = { subs, params: subs[0] ? subs[0].params : {}, stats: { garments: subs.map(x => x.stats), stiff, missing: GARMENTS.filter(G => !found.some(f => f.g === G)).map(G => G.name) },
    setEnabled(on) { subs.forEach(x => x.setEnabled(on)); try { localStorage.setItem('dm_cloth_v1', on ? '1' : '0'); } catch (e) {} },
    reset() { subs.forEach(x => x.reset()); }, detach() { subs.forEach(x => x.detach()); CHAR._cloth = null; },
    get capsules() { return subs[0] ? subs[0].capsules : null; } };
  CHAR._cloth = C; if (typeof window !== 'undefined') window.DART_CLOTH = C;
  console.log('[cloth] attached', JSON.stringify(C.stats));
  return C;
}
function makeGarment(CHAR, THREE, sm, Gm, opts) {
  const T = opts.TSL || THREE.TSL, renderer = opts.renderer || null;
  const geo = sm.geometry, posA = geo.attributes.position, uvA = geo.attributes.uv, nV = posA.count;
  const M = buildClothModel(geo, Gm), n = M.n, K = M.K;
  const P = { enabled: true, gravity: G, iterations: 4, substeps: 2, damping: 0.995, stretch: 0.7, selfCollide: true, gravityScale: 1 };
  const C = { model: M, params: P, stats: Object.assign({ mesh: sm.name, gpu: false, ms: 0 }, M.gStats[0]), capsules: new Float32Array(CAPS.length * 8) };
  if (!n) return null;
  // ---- preallocated state (root/mesh-local metres) ----
  const pos = new Float32Array(n * 3), prev = new Float32Array(n * 3), rest = new Float32Array(n * 3), restLen = new Float32Array(n * K);
  const hang = new Float32Array(n), free = new Uint8Array(n), rep = new Int32Array(n), minR = new Float32Array(n * CAPS.length);
  for (let i = 0; i < n; i++) { const q = M.parts[i]; hang[i] = q.hang; free[i] = q.free; rep[i] = q.rep; }
  const PA = posA.array;
  for (let i = 0; i < n; i++) for (let k = 0; k < K; k++) { const j = M.nb[i * K + k]; if (j < 0) continue; const a = rep[i] * 3, b = rep[j] * 3; restLen[i * K + k] = Math.hypot(PA[a] - PA[b], PA[a + 1] - PA[b + 1], PA[a + 2] - PA[b + 2]); }
  const clothVerts = []; for (let v = 0; v < nV; v++) if (M.vPart[v] >= 0 && M.vW[v] > 0) clothVerts.push(v);
  const CV = Int32Array.from(clothVerts); let vMin = nV, vMax = 0; for (const v of CV) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; }
  const offArr = new Float32Array(nV * 3), offAttr = new THREE.BufferAttribute(offArr, 3); offAttr.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('clothOffset', offAttr);
  const bones = {}; for (const b of sm.skeleton.bones) bones[b.name] = b;
  const capB = CAPS.map(c => [bones[c[0]], bones[c[1]]]);
  const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), invM = new THREE.Matrix4(), prevM = new THREE.Matrix4(), D = new THREE.Matrix4(), gv = new THREE.Vector3();
  let havePrev = false, lastT = 0;
  // spatial hash for self collision (fixed table)
  const HS = 8192, head = new Int32Array(HS), next = new Int32Array(n), selfR = 0.008;
  const hk = (x, y, z) => (((Math.floor(x / selfR / 2) * 73856093) ^ (Math.floor(y / selfR / 2) * 19349663) ^ (Math.floor(z / selfR / 2) * 83492791)) & (HS - 1));

  function updateRest() {
    sm.skeleton.update();
    for (let i = 0; i < n; i++) { tv.fromBufferAttribute(posA, rep[i]); sm.applyBoneTransform(rep[i], tv); rest[i * 3] = tv.x; rest[i * 3 + 1] = tv.y; rest[i * 3 + 2] = tv.z; }
    // capsules (mesh-local): world bone positions -> mesh local
    for (let c = 0; c < CAPS.length; c++) { const [ba, bb] = capB[c], o = c * 8; if (!ba || !bb) { C.capsules[o + 6] = 0; continue; }
      ba.getWorldPosition(tv).applyMatrix4(invM); bb.getWorldPosition(tv2).applyMatrix4(invM);
      C.capsules[o] = tv.x; C.capsules[o + 1] = tv.y; C.capsules[o + 2] = tv.z + CAPS[c][3]; C.capsules[o + 3] = tv2.x; C.capsules[o + 4] = tv2.y; C.capsules[o + 5] = tv2.z + CAPS[c][3]; C.capsules[o + 6] = CAPS[c][2]; }
    // each particle may sit no deeper in a capsule than its skinned rest does (garments are fused to the skin)
    for (let i = 0; i < n; i++) for (let c = 0; c < CAPS.length; c++) minR[i * CAPS.length + c] = Math.min(C.capsules[c * 8 + 6], capDist(rest, i, c) - 0.001);
  }
  let cqx = 0, cqy = 0, cqz = 0;
  function capDist(A, i, c) { const o = c * 8, ax = C.capsules[o], ay = C.capsules[o + 1], az = C.capsules[o + 2];
    const ex = C.capsules[o + 3] - ax, ey = C.capsules[o + 4] - ay, ez = C.capsules[o + 5] - az, px = A[i * 3] - ax, py = A[i * 3 + 1] - ay, pz = A[i * 3 + 2] - az;
    const t = Math.max(0, Math.min(1, (px * ex + py * ey + pz * ez) / Math.max(1e-9, ex * ex + ey * ey + ez * ez)));
    cqx = ax + ex * t; cqy = ay + ey * t; cqz = az + ez * t; return Math.hypot(A[i * 3] - cqx, A[i * 3 + 1] - cqy, A[i * 3 + 2] - cqz); }
  function frameShift() { // inertia: particles stay in the previous frame's space, rest moves with her
    if (!havePrev) return; D.multiplyMatrices(invM, prevM); const e = D.elements;
    if (Math.hypot(e[12], e[13], e[14]) > 0.5) { reset(); return; } // teleport / remount
    for (let i = 0; i < n; i++) { if (!free[i]) continue; for (const A of [pos, prev]) { const o = i * 3, x = A[o], y = A[o + 1], z = A[o + 2];
      A[o] = e[0] * x + e[4] * y + e[8] * z + e[12]; A[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; A[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]; } }
  }
  function reset() { pos.set(rest); prev.set(rest); }
  function cpuStep(h) {
    const gx = gv.x * h * h, gy = gv.y * h * h, gz = gv.z * h * h;
    for (let i = 0; i < n; i++) { const o = i * 3;
      if (!free[i]) { pos[o] = prev[o] = rest[o]; pos[o + 1] = prev[o + 1] = rest[o + 1]; pos[o + 2] = prev[o + 2] = rest[o + 2]; continue; }
      let vx = pos[o] - prev[o], vy = pos[o + 1] - prev[o + 1], vz = pos[o + 2] - prev[o + 2];
      const sp = Math.hypot(vx, vy, vz) / h, f = P.damping / (1 + KDRAG * sp * h); vx *= f; vy *= f; vz *= f;   // quadratic air drag
      prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2]; pos[o] += vx + gx; pos[o + 1] += vy + gy; pos[o + 2] += vz + gz; }
    for (let it = 0; it < P.iterations; it++) {
      for (let i = 0; i < n; i++) { if (!free[i]) continue; const o = i * 3;
        for (let k = 0; k < K; k++) { const j = M.nb[i * K + k]; if (j < 0) break; const q = j * 3;
          const dx = pos[q] - pos[o], dy = pos[q + 1] - pos[o + 1], dz = pos[q + 2] - pos[o + 2], d = Math.hypot(dx, dy, dz) || 1e-9;
          const w = free[j] ? 0.5 : 1, c = (d - restLen[i * K + k]) / d * P.stretch * w; pos[o] += dx * c; pos[o + 1] += dy * c; pos[o + 2] += dz * c;
          if (free[j]) { pos[q] -= dx * c; pos[q + 1] -= dy * c; pos[q + 2] -= dz * c; } }
        // tether to skinned rest
        const tx = pos[o] - rest[o], ty = pos[o + 1] - rest[o + 1], tz = pos[o + 2] - rest[o + 2], td = Math.hypot(tx, ty, tz);
        if (td > hang[i]) { const s = hang[i] / td; pos[o] = rest[o] + tx * s; pos[o + 1] = rest[o + 1] + ty * s; pos[o + 2] = rest[o + 2] + tz * s; }
        // body + hair capsules
        for (let c = 0; c < CAPS.length; c++) { const r = minR[i * CAPS.length + c]; if (r <= 0) continue; const d = capDist(pos, i, c);
          if (d < r) { const s = r / (d || 1e-9); pos[o] = cqx + (pos[o] - cqx) * s; pos[o + 1] = cqy + (pos[o + 1] - cqy) * s; pos[o + 2] = cqz + (pos[o + 2] - cqz) * s; } }
      }
    }
    if (P.selfCollide) { head.fill(-1); for (let i = 0; i < n; i++) { const h2 = hk(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); next[i] = head[h2]; head[h2] = i; }
      for (let i = 0; i < n; i++) { if (!free[i]) continue; const o = i * 3; let j = head[hk(pos[o], pos[o + 1], pos[o + 2])];
        while (j >= 0) { if (j !== i) { const q = j * 3, dx = pos[o] - pos[q], dy = pos[o + 1] - pos[q + 1], dz = pos[o + 2] - pos[q + 2], d = Math.hypot(dx, dy, dz);
          if (d > 1e-6 && d < selfR) { const c = 0.5 * (selfR - d) / d; pos[o] += dx * c; pos[o + 1] += dy * c; pos[o + 2] += dz * c; } } j = next[j]; } } }
  }
  function writeOffsets(src) { // particle displacement -> render vertices (mesh local, post-skin)
    for (let k = 0; k < CV.length; k++) { const v = CV[k], i = M.vPart[v], w = M.vW[v], o = i * 3;
      offArr[v * 3] = (src[o] - rest[o]) * w; offArr[v * 3 + 1] = (src[o + 1] - rest[o + 1]) * w; offArr[v * 3 + 2] = (src[o + 2] - rest[o + 2]) * w; }
    offAttr.clearUpdateRanges(); offAttr.addUpdateRange(vMin * 3, (vMax - vMin + 1) * 3); offAttr.needsUpdate = true;
  }
  // ---- GPU (TSL compute) path ----
  let gpu = null;
  try { if (opts.gpu !== false && renderer && renderer.backend && renderer.backend.isWebGPUBackend && T && T.instancedArray) gpu = buildGpu(); } catch (e) { console.info('[cloth] GPU path unavailable, CPU fallback:', e && e.message); gpu = null; }
  function buildGpu() {
    const { Fn, instancedArray, instanceIndex, uniform, uniformArray, float, int, vec3, vec4, If, Loop, max, min, clamp, length, dot } = T;
    const gPos = instancedArray(n, 'vec4'), gPrev = instancedArray(n, 'vec4'), gRest = instancedArray(n, 'vec4'), gTmp = instancedArray(n, 'vec4');
    const gNb = instancedArray(n * K, 'float'), gLen = instancedArray(n * K, 'float'), gInfo = instancedArray(n, 'vec4'); // hang, free
    const gMinR = instancedArray(n * CAPS.length, 'float');
    const restBuf = gRest.value.array; for (let i = 0; i < n * K; i++) { gNb.value.array[i] = M.nb[i]; gLen.value.array[i] = restLen[i]; }
    for (let i = 0; i < n; i++) { gInfo.value.array[i * 4] = hang[i]; gInfo.value.array[i * 4 + 1] = free[i]; }
    const uD = uniform(new THREE.Matrix4()), uG = uniform(new THREE.Vector3()), uH = uniform(1 / 120), uDamp = uniform(P.damping), uSt = uniform(P.stretch);
    const capVals = []; for (let c = 0; c < CAPS.length * 2; c++) capVals.push(new THREE.Vector4()); const uCap = uniformArray(capVals, 'vec4');
    const NC = CAPS.length;
    const kShift = Fn(() => { const i = instanceIndex, inf = gInfo.element(i); If(inf.y.greaterThan(0.5), () => {
      gPos.element(i).xyz.assign(uD.mul(vec4(gPos.element(i).xyz, 1)).xyz); gPrev.element(i).xyz.assign(uD.mul(vec4(gPrev.element(i).xyz, 1)).xyz); }); })().compute(n);
    const kInteg = Fn(() => { const i = instanceIndex, p = gPos.element(i), q = gPrev.element(i), r = gRest.element(i), inf = gInfo.element(i);
      If(inf.y.lessThan(0.5), () => { p.xyz.assign(r.xyz); q.xyz.assign(r.xyz); }).Else(() => {
        const v = p.xyz.sub(q.xyz).toVar(); const f = uDamp.div(float(1).add(float(KDRAG).mul(length(v)))); v.mulAssign(f);
        q.xyz.assign(p.xyz); p.xyz.addAssign(v.add(uG.mul(uH.mul(uH)))); }); })().compute(n);
    const kSolve = Fn(() => { const i = instanceIndex, inf = gInfo.element(i), p = gPos.element(i).xyz.toVar();
      If(inf.y.greaterThan(0.5), () => {
        const acc = vec3(0).toVar(), cnt = float(0).toVar();
        Loop(K, ({ i: k }) => { const j = int(gNb.element(i.mul(K).add(k))); If(j.greaterThanEqual(0), () => {
          const d = gPos.element(j).xyz.sub(p), L = max(length(d), 1e-9); acc.addAssign(d.mul(L.sub(gLen.element(i.mul(K).add(k))).div(L))); cnt.addAssign(1); }); });
        p.addAssign(acc.mul(uSt.mul(0.5)).div(max(cnt, 1)));
        const r = gRest.element(i).xyz, t = p.sub(r), td = length(t); If(td.greaterThan(inf.x), () => { p.assign(r.add(t.mul(inf.x.div(td)))); });
        Loop(NC, ({ i: c }) => { const a = uCap.element(c.mul(2)).xyz, b = uCap.element(c.mul(2).add(1)).xyz, rr = gMinR.element(i.mul(NC).add(c));
          const e = b.sub(a), tt = clamp(dot(p.sub(a), e).div(max(dot(e, e), 1e-9)), 0, 1), cp = a.add(e.mul(tt)), dd = length(p.sub(cp));
          If(rr.greaterThan(0).and(dd.lessThan(rr)), () => { p.assign(cp.add(p.sub(cp).mul(rr.div(max(dd, 1e-9))))); }); });
        // self collision: keep a minimum gap to mesh neighbours (cheap ring separation on GPU)
        Loop(K, ({ i: k }) => { const j = int(gNb.element(i.mul(K).add(k))); If(j.greaterThanEqual(0), () => { const d = p.sub(gPos.element(j).xyz), L = length(d);
          If(L.lessThan(selfR).and(L.greaterThan(1e-6)), () => { p.addAssign(d.mul(float(selfR).sub(L).mul(0.5).div(L))); }); }); });
      }); gTmp.element(i).xyz.assign(p); })().compute(n);
    const kCopy = Fn(() => { gPos.element(instanceIndex).xyz.assign(gTmp.element(instanceIndex).xyz); })().compute(n);
    // vertex side: part index + weight attributes, offset read straight from GPU storage
    const pi = new Float32Array(nV * 2); for (let v = 0; v < nV; v++) { pi[v * 2] = Math.max(0, M.vPart[v]); pi[v * 2 + 1] = M.vPart[v] >= 0 ? M.vW[v] : 0; }
    geo.setAttribute('clothPart', new THREE.BufferAttribute(pi, 2));
    const ap = T.attribute('clothPart', 'vec2'), ip = T.int(ap.x);
    const offNode = gPos.toReadOnly ? null : null; // (same buffer, read in vertex stage)
    const vOff = gPos.element(ip).xyz.sub(gRest.element(ip).xyz).mul(ap.y);
    return { kShift, kInteg, kSolve, kCopy, uD, uG, uH, uCap, capVals, restBuf, gRest, gPos, gPrev, gMinR, vOff,
      upload() { for (let i = 0; i < n; i++) { restBuf[i * 4] = rest[i * 3]; restBuf[i * 4 + 1] = rest[i * 3 + 1]; restBuf[i * 4 + 2] = rest[i * 3 + 2]; }
        gRest.value.needsUpdate = true; gMinR.value.array.set(minR); gMinR.value.needsUpdate = true;
        for (let c = 0; c < CAPS.length; c++) { const o = c * 8; capVals[c * 2].set(C.capsules[o], C.capsules[o + 1], C.capsules[o + 2], 0); capVals[c * 2 + 1].set(C.capsules[o + 3], C.capsules[o + 4], C.capsules[o + 5], 0); } },
      seed() { const a = gPos.value.array, b = gPrev.value.array; for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { a[i * 4 + c] = b[i * 4 + c] = pos[i * 3 + c]; } gPos.value.needsUpdate = gPrev.value.needsUpdate = true; } };
  }
  // ---- material: positionNode = skinned position + cloth offset (post-skin, mesh local) ----
  const origMat = sm.material; let clothMat = null;
  try {
    const NM = THREE.MeshPhysicalNodeMaterial || THREE.MeshStandardNodeMaterial; clothMat = new NM();
    for (const k of Object.keys(origMat)) { if (k === 'uuid' || k === 'id' || k === 'type' || k.startsWith('is') || k.startsWith('_') || typeof origMat[k] === 'function') continue;
      if (k in clothMat) { try { clothMat[k] = origMat[k]; } catch (e) {} } }
    clothMat.positionNode = T.positionLocal.add(gpu ? gpu.vOff : T.attribute('clothOffset', 'vec3'));
  } catch (e) { console.warn('[cloth] material', e); clothMat = null; }
  // ---- settle into the default (draped) pose ----
  function setup() { invM.copy(sm.matrixWorld).invert(); gv.set(0, -1, 0).transformDirection(invM).multiplyScalar(P.gravity * P.gravityScale); updateRest(); reset();
    for (let s = 0; s < 240; s++) cpuStep(1 / 120); prevM.copy(sm.matrixWorld); havePrev = true; if (gpu) { gpu.seed(); gpu.upload(); } writeOffsets(pos); }
  setup();
  if (clothMat) sm.material = clothMat;
  const prevOBR = sm.onBeforeRender;
  sm.onBeforeRender = function (r, s, cam, g, m, gr) {
    if (prevOBR) prevOBR.call(this, r, s, cam, g, m, gr);
    if (!P.enabled || !clothMat) return;
    const now = performance.now(); if (now - lastT < 2) return; // once per frame even with several passes (shadow, AR)
    const dt = Math.min(1 / 30, Math.max(1 / 240, lastT ? (now - lastT) / 1000 : 1 / 60)); lastT = now; const t0 = now;
    let gs = 1; try { gs = opts.getGravityScale ? opts.getGravityScale() : 1; } catch (e) {}
    invM.copy(sm.matrixWorld).invert(); gv.set(0, -1, 0).transformDirection(invM).multiplyScalar(P.gravity * gs);
    updateRest(); const sub = Math.max(1, P.substeps | 0), h = dt / sub;
    if (gpu) { D.multiplyMatrices(invM, prevM); gpu.uD.value.copy(D); gpu.uG.value.copy(gv); gpu.uH.value = h; gpu.upload();
      try { r.compute(gpu.kShift); for (let k = 0; k < sub; k++) { r.compute(gpu.kInteg); for (let it = 0; it < P.iterations; it++) { r.compute(gpu.kSolve); r.compute(gpu.kCopy); } } } catch (e) { console.warn('[cloth] GPU step failed, CPU fallback', e); gpu = null; clothMat.positionNode = T.positionLocal.add(T.attribute('clothOffset', 'vec3')); clothMat.needsUpdate = true; }
    } else { frameShift(); for (let k = 0; k < sub; k++) cpuStep(h); writeOffsets(pos); }
    prevM.copy(sm.matrixWorld); C.stats.ms = performance.now() - t0; C.stats.gpu = !!gpu;
  };
  C.setEnabled = on => { P.enabled = !!on; sm.material = on && clothMat ? clothMat : origMat; };
  C.detach = () => { P.enabled = false; sm.material = origMat; sm.onBeforeRender = prevOBR; };
  C.reset = () => { setup(); };
  C.step = cpuStep; C.state = { pos, rest };
  return C;
}
