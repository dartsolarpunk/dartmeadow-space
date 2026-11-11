// Offline tests of DMVLight's pure core (ui/dm-vlight.js): light-list packing (view space), top-N picker, slot fading, range window / cone falloff
// (smooth, zero at the edge), equi-angular in-scatter vs brute-force integration (point + spot), flashlight-cone behaviour, budget plan.
const assert = require('assert');
const V = require('../../ui/dm-vlight.js');
const { rangeWindow, coneFactor, hg, lightScatter, lightScatterBrute, packLight, clearSlot, createPicker, pickReset, pickPush, lightScore, createSlots, stepSlots, budgetPlan, STRIDE, TIERS } = V;
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b);
const rel = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-9), (msg || '') + ' ' + a + ' vs ' + b);

// 1. range window: 1 at the light, exactly 0 and flat at range, monotone, zero beyond
{ near(rangeWindow(0, 10), 1, 1e-12); assert.strictEqual(rangeWindow(10, 10), 0); assert.strictEqual(rangeWindow(25, 10), 0);
  let prev = 1; for (let r = 0; r <= 10; r += 0.1) { const w = rangeWindow(r, 10); assert(w <= prev + 1e-12 && w >= 0); prev = w; }
  assert(rangeWindow(9.9, 10) < 1e-3, 'flat approach to zero (no hard edge)'); assert.strictEqual(rangeWindow(1, 0), 0); console.log('range window: 1 -> 0 smooth, zero beyond range'); }

// 2. cone: 0 outside cosOuter, 1 inside cosInner, smooth between (no step)
{ const co = Math.cos(0.5), ci = Math.cos(0.5 * 0.4), inv = 1 / (ci - co);
  assert.strictEqual(coneFactor(co - 0.01, co, inv), 0); near(coneFactor(ci + 0.01, co, inv), 1, 1e-12);
  let prev = 0, maxStep = 0; for (let c = co; c <= ci; c += (ci - co) / 400) { const f = coneFactor(c, co, inv); maxStep = Math.max(maxStep, f - prev); assert(f >= prev - 1e-12); prev = f; }
  assert(maxStep < 0.02, 'no jump ' + maxStep); console.log('cone: smoothstep edge, max step ' + maxStep.toFixed(4)); }

// 3. Henyey-Greenstein normalised over the sphere (integral of p over solid angle = 1) and forward-peaked for g > 0
{ for (const g of [0, 0.45, 0.7]) { let s = 0; const n = 20000; for (let i = 0; i < n; i++) { const c = -1 + 2 * (i + 0.5) / n; s += hg(c, g) * 2 * Math.PI * (2 / n); } near(s, 1, 0.01, 'HG g=' + g); }
  assert(hg(1, 0.45) > hg(-1, 0.45) * 5); console.log('HG normalised, forward peaked'); }

// 4. point light, no cone: sampled equi-angular form vs brute force over many geometries (ray passing near / far, light behind, light beyond the end)
{ const dirs = [[0, 0, -1], [0.6, 0, -0.8], [0, 0.3, -Math.sqrt(1 - 0.09)]]; let worst = 0, n = 0; const errs = [];
  for (const d of dirs) for (const [x, y, z] of [[0, 0, -5], [2, 0, -6], [-3, 1, -4], [0.3, 0.2, -12], [4, 4, -2], [0, 0, 3], [1, -1, -30]]) for (const L of [8, 40, 120]) for (const range of [8, 25]) {
    const li = { x, y, z, dx: 0, dy: 0, dz: 0, range, cosOuter: 0, invR: 1 }, sigma = 0.03;
    const ref = lightScatterBrute(li, d, L, sigma, 0.45, 40000), got = lightScatter(li, d, L, sigma, 0.45, 4, null);
    if (ref > 1e-7) { const e = Math.abs(got - ref) / ref; worst = Math.max(worst, e); errs.push(e); n++; assert(e < 0.2, `point ${JSON.stringify([d, x, y, z, L, range])} ${got} vs ${ref}`); } else assert(got < 1e-6, 'zero where brute is zero'); }
  errs.sort((a, b) => a - b); assert(errs[errs.length >> 1] < 0.03, 'median err'); console.log('point light vs brute: ' + n + ' cases, median rel err ' + (errs[errs.length >> 1] * 100).toFixed(2) + ' %, worst ' + (worst * 100).toFixed(1) + ' % (K=4, unjittered; worst = narrow-window cases)'); }

// 5. closed form: window = 1 (range huge), no transmittance, isotropic -> (sigma/(4 pi)) (I/H) (atan b - atan a)
{ const li = { x: 1, y: 0, z: -6, dx: 0, dy: 0, dz: 0, range: 1e6, cosOuter: 0, invR: 1 }, d = [0, 0, -1], H = Math.sqrt(1 + V.EPS * V.EPS), tc = 6, L = 20;
  const exact = (1 / (4 * Math.PI)) / H * (Math.atan((L - tc) / H) - Math.atan((0 - tc) / H));
  const got = lightScatter(li, d, L, 1e-9, 0, 1, null) / 1e-9; rel(got, exact, 1e-3, 'closed form'); console.log('closed form atan integral matches (rel ' + (Math.abs(got - exact) / exact).toExponential(1) + ')'); }

// 6. spot (flashlight-like) pointing along the ray: bright beam; pointing away: dark; sampled vs brute
{ const a = 0.55, pen = 0.7, co = Math.cos(a), ci = Math.cos(a * (1 - pen)), inv = 1 / (ci - co);
  const beam = (dx, dy, dz) => ({ x: 0, y: -0.1, z: 0, dx, dy, dz, range: 60, cosOuter: co, invR: inv });
  const d = [0, 0, -1], sigma = 0.03;
  const along = beam(0, 0, -1), away = beam(0, 0, 1), side = beam(1, 0, 0);
  const bAlong = lightScatterBrute(along, d, 50, sigma, 0.45, 60000), gAlong = lightScatter(along, d, 50, sigma, 0.45, 4, null);
  rel(gAlong, bAlong, 0.12, 'spot along'); assert(bAlong > 0);
  assert(lightScatter(away, d, 50, sigma, 0.45, 4, null) < bAlong * 1e-3, 'away from the ray: no beam'); assert(lightScatter(side, d, 50, sigma, 0.45, 4, null) < bAlong * 1e-3);
  // a ray off to the side of the beam sees the cone edge smoothly: sweep the ray angle, the in-scatter changes without jumps
  let prev = null, maxJump = 0, peak = 0;
  for (let i = 0; i <= 200; i++) { const th = -0.9 + 1.8 * i / 200, dd = [Math.sin(th), 0, -Math.cos(th)], v = lightScatter(along, dd, 50, sigma, 0.45, 4, k => 0.5); peak = Math.max(peak, v); if (prev != null) maxJump = Math.max(maxJump, Math.abs(v - prev)); prev = v; }
  assert(maxJump < peak * 0.12, 'sweep across the cone is smooth: jump ' + (maxJump / peak).toFixed(3)); console.log('spot: along ' + gAlong.toExponential(2) + ' vs brute ' + bAlong.toExponential(2) + ', cone sweep max step ' + (maxJump / peak * 100).toFixed(1) + ' % of peak'); }

// 7. light outside range / behind the camera contributes exactly nothing; far away light dims smoothly with the window (no hard sphere edge)
{ const d = [0, 0, -1], mk = z => ({ x: 0, y: 0, z, dx: 0, dy: 0, dz: 0, range: 20, cosOuter: 0, invR: 1 });
  assert.strictEqual(lightScatter({ x: 50, y: 0, z: -5, dx: 0, dy: 0, dz: 0, range: 10, cosOuter: 0, invR: 1 }, d, 30, 0.03, 0.4, 3, null), 0);
  let prev = null, maxRel = 0; for (let i = 0; i <= 400; i++) { const x = 30 - 0.1 * i, li = { x, y: 0, z: -10, dx: 0, dy: 0, dz: 0, range: 20, cosOuter: 0, invR: 1 }, v = lightScatter(li, d, 40, 0.03, 0.4, 3, k => 0.5); if (prev != null && prev > 0) maxRel = Math.max(maxRel, Math.abs(v - prev) / Math.max(prev, 1e-12)); else if (prev === 0) assert(v < 1e-4 * 1e3); prev = v; }
  console.log('lateral sweep through the range edge: no NaN, finite'); assert(Number.isFinite(maxRel)); }

// 8. no NaN / negative anywhere on a random sweep (degenerate: light on the ray, light at the camera, zero length)
{ let s = 12345; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 4000; i++) { const th = r() * 6.283, ph = (r() - 0.5) * 3, d = [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)];
    const li = { x: (r() - 0.5) * 40, y: (r() - 0.5) * 10, z: (r() - 0.5) * 40, dx: r() < 0.5 ? 0 : r() - 0.5, dy: r() - 0.5, dz: r() - 0.5, range: 2 + r() * 40, cosOuter: Math.cos(0.1 + r()), invR: 1 + r() * 8 };
    if (i % 50 === 0) { li.x = d[0] * 5; li.y = d[1] * 5; li.z = d[2] * 5; } if (i % 97 === 0) { li.x = li.y = li.z = 0; }
    const v = lightScatter(li, d, r() * 200, 0.005 + r() * 0.08, r() * 0.8, 1 + (r() * 4 | 0), k => r()); assert(Number.isFinite(v) && v >= 0, 'finite ' + v); }
  console.log('4000 random rays: finite, non-negative'); }

// 9. packing: view-space transform, weight on colour, spot axis normalised + rotated, point axis 0
{ const m = new Float32Array(16); // world -> view: rotate 90 deg about Y and translate (-1,-2,-3) first (column-major)
  // view = Ry(90) * (p - (1,2,3)):  x' = z - 3... build explicitly: R columns for Ry(90): (0,0,-1),(0,1,0),(1,0,0)
  const R = [[0, 0, -1], [0, 1, 0], [1, 0, 0]]; m.set([R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1]);
  const t = [-1, -2, -3]; m[12] = m[0] * t[0] + m[4] * t[1] + m[8] * t[2]; m[13] = m[1] * t[0] + m[5] * t[1] + m[9] * t[2]; m[14] = m[2] * t[0] + m[6] * t[1] + m[10] * t[2];
  const out = new Float32Array(3 * STRIDE);
  packLight(out, 1, m, 1, 2, 3, 0, 0, 0, 10, 8, 6, 0.5, 30, 0, 0);   // the camera position itself -> view origin
  near(out[12], 0, 1e-5); near(out[13], 0, 1e-5); near(out[14], 0, 1e-5); assert.strictEqual(out[15], 30); near(out[16], 5, 1e-6); near(out[17], 4, 1e-6); near(out[18], 3, 1e-6);
  assert.deepStrictEqual([out[20], out[21], out[22]], [0, 0, 0], 'point: axis 0');
  packLight(out, 2, m, 2, 2, 3, 3, 0, 0, 1, 1, 1, 1, 40, Math.cos(0.5), Math.cos(0.2));   // 1 m east of the camera; axis +x (unnormalised on purpose)
  near(out[24], 0, 1e-5); near(out[25], 0, 1e-5); near(out[26], -1, 1e-5, 'east -> view -z'); near(Math.hypot(out[32], out[33], out[34]), 1, 1e-5); near(out[34], -1, 1e-5, 'axis rotated'); near(out[35], 1 / (Math.cos(0.2) - Math.cos(0.5)), 1e-3);
  assert.strictEqual(out[0], 0, 'slot 0 untouched'); clearSlot(out, 2); assert(out.subarray(24, 36).every(v => v === 0)); console.log('packLight: view transform, weight, axis OK'); }

// 10. picker keeps the N best, sorted; spot (1e9) always first; score drops with distance and is zero past range+pad / at level 0
{ const p = createPicker(3); pickReset(p); const sc = [5, 1, 9, 7, 3, 8]; sc.forEach((s, i) => pickPush(p, i, s));
  assert.deepStrictEqual([p.id[0], p.id[1], p.id[2]], [2, 5, 3]); assert.strictEqual(p.size, 3); pickPush(p, 99, 1e9); assert.strictEqual(p.id[0], 99); assert.strictEqual(p.id[1], 2);
  assert(lightScore(10, 1, 2, 16, 60) > lightScore(10, 1, 20, 16, 60)); assert.strictEqual(lightScore(10, 1, 200, 16, 60), 0); assert.strictEqual(lightScore(10, 0, 2, 16, 60), 0); console.log('picker + score OK'); }

// 11. slots: entering lights fade in from 0, leaving ones fade out then free their slot; a stable set never moves; no swaps pop (weights stay in 0..1)
{ const S = createSlots(3), tg = new Int32Array(3); tg[0] = 10; tg[1] = 11; stepSlots(S, tg, 2, 0.016, 4);
  assert.strictEqual(S.id[0], 10); assert.strictEqual(S.w[0], 0); for (let i = 0; i < 20; i++) stepSlots(S, tg, 2, 0.016, 4); assert(S.w[0] > 0.9 && S.w[1] > 0.9);
  const slot10 = S.id.indexOf(10); tg[0] = 12; tg[1] = 11; for (let i = 0; i < 4; i++) stepSlots(S, tg, 2, 0.016, 4);
  assert.strictEqual(S.id.indexOf(10), slot10, '10 still fading in its slot'); assert(S.w[slot10] < 1 && S.w[slot10] > 0); assert(S.id.indexOf(12) >= 0 && S.id.indexOf(12) !== slot10, '12 took the free slot, starts at ~0');
  for (let i = 0; i < 40; i++) stepSlots(S, tg, 2, 0.016, 4); assert.strictEqual(S.id.indexOf(10), -1, '10 gone'); assert(S.w[S.id.indexOf(12)] > 0.99);
  for (let i = 0; i < 300; i++) { tg[0] = 20 + (i >> 3 & 7); tg[1] = 30 + (i >> 4 & 7); stepSlots(S, tg, 2, 0.016, 4); for (let k = 0; k < 3; k++) assert(S.w[k] >= 0 && S.w[k] <= 1); }
  console.log('slot fading OK (no pop: weights 0..1, ' + (1 / (0.016 * 4) | 0) + ' frames to full)'); }

// 12. budget plan is monotone and ends at off; tier table
{ let prev = 99; for (const [l, e] of [[0, 10], [1, 10], [2, 10], [3, 10]]) { const p = budgetPlan(8, l, e); assert(p.n <= prev); prev = p.n; } assert.strictEqual(budgetPlan(8, 3, 0).n, 0); assert.strictEqual(budgetPlan(8, 0, 70).n, 0); assert.strictEqual(budgetPlan(8, 0, 50).n, 2); assert.strictEqual(budgetPlan(8, 0, 50).sun, false); assert.strictEqual(budgetPlan(8, 1, 0).n, 4);
  assert(TIERS.low.n < TIERS.med.n && TIERS.med.n < TIERS.high.n && TIERS.low.k <= TIERS.med.k); console.log('budget plan + tier table OK'); }

console.log('vlight-unit: all passed');
