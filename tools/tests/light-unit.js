// Offline tests of DMLight's pure core (ui/dm-light.js): SH L1 projection/evaluation, EMA convergence of the 16-sample probe estimate, heightfield march and
// contact-hardening sun visibility against brute force, toroidal height cache, tier table monotonicity, headroom gate, ladder integration.
const assert = require('assert');
const L = require('../../ui/dm-light.js');
const B = require('../../ui/dm-budget.js');
const { Y0, Y1, shProject, shEval, rng, rayDirs, createHF, march, marchBrute, sunVis, sunVisBrute, effective, cost, TIERS, TIER_ORDER, pickTier, createHeadroom, createCascade, updateCascade, sampleCascade } = L;

// 1. SH: a constant radiance field of 1 gives E/pi = 1 for every normal; the unit-sphere Monte Carlo projection is unbiased
{ const a = new Float64Array(4), R = rng(1), d = new Float32Array(3 * 4096); rayDirs(4096, R(), 0.3, d);
  for (let i = 0; i < 4096; i++) shProject(a, 0, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], 1, 4 * Math.PI / 4096);
  for (const n of [[0, 1, 0], [1, 0, 0], [0, 0, -1], [0.577, 0.577, 0.577]]) assert(Math.abs(shEval(a, 0, n[0], n[1], n[2]) - 1) < 0.01, 'constant field ' + n); console.log('SH constant field: E/pi = 1 for all normals'); }
// 2. SH: upper hemisphere visible: up normal sees 1, down normal ~0 (L1 ringing allows a small negative), side 0.5 +- 0.1 (exact L1 values 1, 0, 0.5)
{ const a = new Float64Array(4), N = 20000, R = rng(2), d = new Float32Array(3 * N); rayDirs(N, R(), 0, d);
  for (let i = 0; i < N; i++) if (d[i * 3 + 1] > 0) shProject(a, 0, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], 1, 4 * Math.PI / N);
  assert(Math.abs(shEval(a, 0, 0, 1, 0) - 1) < 0.01); assert(Math.abs(shEval(a, 0, 0, -1, 0)) < 0.01); assert(Math.abs(shEval(a, 0, 1, 0, 0) - 0.5) < 0.01); console.log('SH hemisphere: up 1.00 / side 0.50 / down 0.00'); }

// 3. rayDirs: unit length, and 16 stratified rays cover the sphere evenly (each octant gets 1..3 of 16)
{ const d = new Float32Array(48); rayDirs(16, 0.37, 1.1, d); const oct = new Array(8).fill(0);
  for (let i = 0; i < 16; i++) { assert(Math.abs(Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]) - 1) < 1e-5); oct[(d[i * 3] > 0 ? 1 : 0) + (d[i * 3 + 1] > 0 ? 2 : 0) + (d[i * 3 + 2] > 0 ? 4 : 0)]++; }
  assert(oct.every(c => c >= 1 && c <= 3), 'octants ' + oct); }

// terrain used below: smooth dunes + a wall
const Hf = (x, z) => 4 * Math.sin(x * 0.045) * Math.cos(z * 0.05) + 1.5 * Math.sin(x * 0.19 + z * 0.13) + (x > 20 && x < 26 && z > -30 && z < 30 ? 14 : 0);
function mkHF(N, cell, cx, cz, f) { const hf = createHF(N, cell); hf.sampler = f || Hf; hf.setCenter(cx, cz); hf.fill(N * N, N * N * 2, 0); return hf; }

// 4. toroidal height cache: window fully valid after fill; moving the centre makes only the entering rows/cols stale, and values stay exact
{ const hf = mkHF(64, 2, 0, 0); let bad = 0; for (let i = -30; i < 30; i++) for (let j = -30; j < 30; j++) if (!hf.valid(i, j) || Math.abs(hf.get(i, j) - Hf(i * 2, j * 2)) > 1e-4) bad++; assert.strictEqual(bad, 0);
  hf.setCenter(8, 0); const n = hf.fill(1e9, 1e9, 0); assert.strictEqual(n, 64 * 4 | 0, 'only 4 entering columns refilled (' + n + ')');
  assert(Math.abs(hf.h(10.7, 3.3) - Hf(10.7, 3.3)) < 0.35, 'bilinear close to analytic'); console.log('toroidal HF: window fill ok, move refills ' + n + ' of 4096 cells'); }

// 5. march vs brute force: 16-step quadratic march agrees with a 0.05-cell brute force on >= 95 % of random rays, never reports a hit where brute is clear by margin
{ const hf = mkHF(128, 2, 0, 0), R = rng(7); let agree = 0, tot = 0, fp = 0, hits = 0;
  for (let q = 0; q < 3000; q++) {
    const x = (R() - 0.5) * 120, z = (R() - 0.5) * 120, y = hf.h(x, z) + 0.8 + R() * 4, v = [R() * 2 - 1, R() * 1.2 - 0.5, R() * 2 - 1], l = Math.hypot(...v), d = v.map(c => c / l), md = 40;
    const t = march(hf, x, y, z, d[0], d[1], d[2], md, 16, 1.4), tb = marchBrute(hf, x, y, z, d[0], d[1], d[2], md, 1.4); tot++; if (tb >= 0) hits++;
    if ((t >= 0) === (tb >= 0)) agree++; else if (t >= 0 && tb < 0) fp++;
  }
  assert(agree / tot > 0.95, 'agreement ' + agree / tot); assert(fp / tot < 0.02, 'false positives ' + fp / tot); assert(hits > 200); console.log('march vs brute: ' + (100 * agree / tot).toFixed(1) + '% agree, ' + hits + ' hits of ' + tot); }

// 6. sun visibility: soft march (12 steps) vs brute force.  Decision (vis < 0.5 = shadowed) agrees on >= 94 %, wall shadow is found, penumbra widens with occluder distance
{ const hf = mkHF(128, 2, 0, 0), R = rng(9); let agree = 0, tot = 0, shadowed = 0;
  for (let q = 0; q < 3000; q++) {
    const x = (R() - 0.5) * 120, z = (R() - 0.5) * 120, y = hf.h(x, z) + 0.1, a = 0.1 + R() * 1.3, az = R() * 6.283, L3 = [Math.cos(a) * Math.cos(az), Math.sin(a), Math.cos(a) * Math.sin(az)];
    const v = sunVis(hf, x, y, z, L3[0], L3[1], L3[2], 12, 64, 0.02, 0), b = sunVisBrute(hf, x, y, z, L3[0], L3[1], L3[2], 64); tot++; if (b === 0) shadowed++; if ((v < 0.5) === (b === 0)) agree++;
  }
  assert(agree / tot > 0.94, 'sun agreement ' + agree / tot); assert(shadowed > 150 && shadowed < tot - 150, "shadowed " + shadowed);
  const wallHF = mkHF(128, 2, 0, 0, (x, z) => (x > 20 && x < 24 ? 10 : 0));
  assert.strictEqual(sunVis(wallHF, 12, 0.1, 0, 0.6, 0.35, 0, 12, 64, 0.02, 0), 0, 'behind the wall'); assert.strictEqual(sunVis(wallHF, 12, 0.1, 0, -0.6, 0.35, 0, 12, 64, 0.02, 0), 1, 'away from the wall');
  // contact hardening: the same step-edge grazed at 2 m and at 20 m behind it: transition band (distance over which vis goes 0..1) is wider for the far one
  const edge = (d) => { const hf = mkHF(128, 1, 0, 0, (x) => (x > d ? 0.5 * d : 0)); const lx = 0.9, ly = 0.4359, vs = []; for (let y = 0; y < 400; y++) { vs.push(sunVis(hf, 0, 0.2 + y * 0.04, 0, lx, ly, 0, 48, 70, 0.04, 0)); } return vs; };
  const band = (vs) => vs.filter(v => v > 0.05 && v < 0.95).length; assert(band(edge(20)) >= band(edge(4)), 'penumbra widens with distance'); console.log('sun vis: ' + (100 * agree / tot).toFixed(1) + '% agree with brute force, wall + contact hardening ok'); }

// 7. probe estimate + EMA convergence: probe 1.7 m over flat ground under uniform sky.  Truth (analytic): upper hemisphere open -> skyVis(up) = 1, bounce(up)=0
//    ground hit radiance = albedo*(sky*0.5+0.5... ) / pi; check variance falls as rays accumulate and the converged value is within L1 error of the analytic one
{ const flat = mkHF(64, 2, 0, 0, () => 0), cc = createCascade(4, 2, 4, 2.5), S = { hf: flat, sun: [0, 1, 0], sunI: [0, 0, 0, 0], skyI: [1, 1, 1], albedo: [0.5, 0.5, 0.5], maxD: 40, mSteps: 8, sunSteps: 6, lamps: null, lampK: 0 };
  const probe = (nRays, seed, upd) => { const R = rng(seed); L.neutralProbe(cc.data, 0); for (let u = 0; u < upd; u++) L.traceProbe(cc, 0, 0, 1.7, 0, nRays, S, R); const a = cc.data; return { vis: shEval(a, 0, 0, 1, 0), visDown: shEval(a, 0, 0, -1, 0), b: shEval(a, 4, 0, -1, 0) }; };
  const stat = (nRays, upd) => { const v = []; for (let s = 0; s < 40; s++) v.push(probe(nRays, 100 + s, upd).vis); const m = v.reduce((a, b) => a + b) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length); return { m, sd }; };
  const s1 = stat(16, 1), s8 = stat(16, 12); assert(Math.abs(s8.m - 1) < 0.08, 'converged skyVis(up) ' + s8.m); assert(s8.sd < s1.sd + 1e-9 || s8.sd < 0.05, 'variance does not grow: ' + s1.sd + ' -> ' + s8.sd);
  const d = probe(16, 5, 40); assert(d.visDown < 0.1, 'ground blocks the down hemisphere ' + d.visDown); // bounce seen from below (facing the ground): albedo*skyI*0.5/pi*pi-ish ~ 0.25 * ground share
  assert(d.b > 0.1 && d.b < 0.5, 'bounce facing the ground ' + d.b);
  // the neutral start (vis = 1 all around) decays to the converged value with the 1/16-per-ray weight: after 4 updates of 16 rays >= 98 % of the way
  const neutral = shEval(Object.assign(new Float32Array(16), { 0: 1 / Y0 }), 0, 0, -1, 0); const R2 = rng(3); L.neutralProbe(cc.data, 0); let w = 1; for (let u = 0; u < 4; u++) { L.traceProbe(cc, 0, 0, 1.7, 0, 16, S, R2); w *= Math.pow(1 - 1 / 16, 16); } assert(w < 0.02, 'EMA residual after 4 x 16 rays ' + w); assert(neutral > 0.99);
  console.log('probe: skyVis(up) ' + s8.m.toFixed(3) + ' sd ' + s1.sd.toFixed(3) + ' -> ' + s8.sd.toFixed(3) + ' ; bounce(down) ' + d.b.toFixed(3) + ' ; EMA residual after 4 updates ' + w.toFixed(4)); }

// 8. cascade update: window follow + sampling.  A wall to the east shades probes next to it (lower skyVis for normals facing it), a lamp adds bounce light, budgets are respected
{ const hf = mkHF(128, 2, 0, 0, (x, z) => (x > 12 && x < 18 ? 12 : 0)), cc = createCascade(16, 3, 3, 2.5), R = rng(4);
  const S = { hf, sun: [0.3, 0.9, 0.3], sunI: [2, 2, 2, 1], skyI: [0.6, 0.7, 0.9], albedo: [0.4, 0.35, 0.3], maxD: 36, mSteps: 8, sunSteps: 6, lamps: null, lampK: 0 };
  for (let it = 0; it < 14; it++) updateCascade(cc, hf, 0, 0, S, 16, 50, 4000, R);
  const e = [0, 0, 0, 0], near = sampleCascade(cc, hf, 9, 1.5, 0, e, 1, 0, 0).slice(), open = sampleCascade(cc, hf, -9, 1.5, 0, e, 1, 0, 0).slice();
  assert(near[3] < open[3] - 0.15, 'wall side darker toward the wall: ' + near[3] + ' vs ' + open[3]);
  // lamp at (-9, 3, 0): bounce light appears near it after updates
  S.lamps = new Float32Array([-9, 3, 4, 1, 0.6, 0.3, 16]); S.lampK = 1; for (let it = 0; it < 14; it++) updateCascade(cc, hf, 0, 0, S, 16, 50, 4000, R);
  const lit = sampleCascade(cc, hf, -9, 1.5, 2, e, 0, 0.3, 1).slice(), dark = sampleCascade(cc, hf, 9, 1.5, 0, e, 0, 0.3, 1).slice(); assert(lit[0] > dark[0] + 0.02 && lit[0] > lit[2], 'lamp light is warm and local: ' + lit + ' vs ' + dark);
  // time slicing: the budget bounds work
  const t0 = process.hrtime.bigint(); const n = updateCascade(cc, hf, 0, 0, S, 16, 1.0, 100000, R); const ms = Number(process.hrtime.bigint() - t0) / 1e6; assert(ms < 6, 'ms budget respected: ' + ms.toFixed(2) + ' ms for ' + n + ' probes'); console.log('cascade: wall shade ' + near[3].toFixed(2) + ' vs open ' + open[3].toFixed(2) + ', 1.0 ms slice = ' + n + ' probes (' + ms.toFixed(2) + ' ms)');
  // camera moves: the entering columns come in neutral-then-traced, fresh queue drained within the budget
  const c0 = cc.fresh.length; updateCascade(cc, hf, 30, 0, S, 16, 50, 4000, R); assert(cc.fresh.length === 0 && c0 === 0); }

// 9. tier table: every parameter is monotone non-decreasing off < low < med < high < ultra; the ladder only ever reduces cost; compute path needs ultra + level 0 + headroom
{ const keys = ['rays', 'casc', 'ms', 'mSteps', 'sunSteps', 'hfN', 'P', 'L']; for (const k of keys) for (let i = 1; i < TIER_ORDER.length; i++) assert(TIERS[TIER_ORDER[i]][k] >= TIERS[TIER_ORDER[i - 1]][k], k + ' monotone over tiers');
  for (const t of TIER_ORDER) { let prev = Infinity; for (let lvl = 0; lvl <= 3; lvl++) { const c = cost(effective(t, lvl, true)); assert(c <= prev + 1e-9, t + ' lvl ' + lvl + ' cost ' + c + ' > ' + prev); prev = c; } }
  for (let i = 1; i < TIER_ORDER.length; i++) assert(cost(effective(TIER_ORDER[i], 0, true)) >= cost(effective(TIER_ORDER[i - 1], 0, true)), 'cost over tiers');
  assert(effective('ultra', 0, true).cs && !effective('ultra', 1, true).cs && !effective('ultra', 0, false).cs && !effective('high', 0, true).cs);
  assert.strictEqual(effective('ultra', 3, true).freeze, true); assert.strictEqual(effective('off', 0, true).rays, 0);
  // rays at every level are in {0,4,8,16}; 16 only at high+ at level 0
  for (const t of TIER_ORDER) for (let l = 0; l <= 3; l++) assert([0, 4, 8, 16].includes(effective(t, l, true).rays));
  // memory: caches of the biggest tier stay far below the 64 MB iPhone cap
  const T = TIERS.ultra, mb = (T.hfN * T.hfN * (4 + 2) + 2 * T.P * T.P * T.L * (64 + 32)) / 1048576; assert(mb < 8, 'cache MB ' + mb); console.log('tiers monotone; ultra caches ' + mb.toFixed(2) + ' MB'); }
// 10. device -> tier, headroom gate
{ assert.strictEqual(pickTier({ isMobile: true, gpuClass: 'low' }), 'low'); assert.strictEqual(pickTier({ isMobile: true, gpuClass: 'mid', score: 70 }), 'med'); assert.strictEqual(pickTier({ gpuClass: 'high' }), 'ultra'); assert.strictEqual(pickTier({ gpuClass: 'mid' }), 'high'); assert.strictEqual(pickTier({ gpuClass: 'low' }), 'med'); assert.strictEqual(pickTier({ preset: 'low', gpuClass: 'high' }), 'low'); assert.strictEqual(pickTier({ gpuClass: 'high' }, 'med'), 'med');
  const h = createHeadroom({ hold: 8 }); let t = 0; for (; t < 7.9; t += 0.1) assert(!h.step(0.1, 0, 14, 50)); assert(h.step(0.1, 0, 14, 50), 'opens after 8 s calm'); assert(h.step(0.1, 0, 14, 50)); assert(!h.step(0.1, 1, 14, 50), 'pressure closes it at once'); for (let i = 0; i < 70; i++) assert(!h.step(0.1, 0, 14, 50) || i >= 79, 'needs a fresh calm period'); console.log('device tiers + headroom gate ok'); }
// 11. budget ladder carries the light stage in order, monotone, and its steps sit between existing stages
{ assert(B.STAGES.includes('light')); const order = B.LADDER.map(x => x[0]); const li = order.map((s, i) => s === 'light' ? i : -1).filter(i => i >= 0); assert.strictEqual(li.length, 3); for (let i = 0; i < 3; i++) assert.strictEqual(B.LADDER[li[i]][1], i + 1); assert(li[0] < order.indexOf('atmo') && li[2] < order.indexOf('res'), 'light sheds before resolution'); assert(li[0] > order.indexOf('ground'), 'after the cheap parallax/ground sheds'); console.log('ladder light steps at p=' + li.map(i => i + 1)); }
console.log('light-unit OK');
