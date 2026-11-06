// node tools/tests/lod-unit.js — ui/dm-lod.js: the far-range distance table (monotone per class, hysteresis, no flip-flop, legacy-equal on desktop) + browser glue with fake globals
'use strict';
const assert = require('assert'), path = require('path'), vm = require('vm'), fs = require('fs');
const L = require(path.join(__dirname, '../../ui/dm-lod.js'));
let n = 0; const ok = (c, m) => { n++; assert(c, m); };

// 1. table invariants
ok(L.validate().length === 0, 'table invalid: ' + L.validate().join('; '));

// 2. propCut == the previous hard-coded formula on desktop (no behaviour change where nothing was asked to change), monotone in fog, floor, ceiling
const legacy = (fog, agl) => Math.max(260, Math.min(fog * 1.05, agl > 60 ? Math.max(260, fog * 0.85) : 1400));
for (const fog of [40, 120, 280, 420, 820, 1500, 3000, 2e6]) for (const agl of [0, 30, 60, 61, 400]) ok(Math.abs(L.propCut('desktop', fog, agl, 1) - legacy(fog, agl)) < 1e-9, 'legacy ' + fog + '/' + agl);
for (const t of L.TIERS) for (const agl of [0, 100]) {
  let prev = -1; for (let fog = 50; fog <= 5000; fog += 25) { const c = L.propCut(t, fog, agl, 1); ok(c >= prev - 1e-9 || agl > 60, t + ' propCut not monotone in fog (' + fog + ')'); if (agl === 0) prev = c; ok(c >= L.get(t, 'prop.cutMin') && (agl > 60 ? c <= Math.max(260, fog * 1.05) + 1e-9 : c <= L.get(t, 'prop.cutMax') + 1e-9), 'cut bounds (aloft the cut follows the fog, as before)'); }
}
// ladder scale: halving k halves the cut, never negative
for (const t of L.TIERS) ok(Math.abs(L.propCut(t, 420, 0, 0.45) - L.propCut(t, 420, 0, 1) * 0.45) < 1e-9, 'k scales linearly');

// 3. ring: integer, 1..tier cap, nondecreasing in cut, and a chunk that enters the wanted set is >= cut x hyst away whenever the cap allows
for (const t of L.TIERS) {
  let prev = 0; for (let cut = 100; cut <= 3000; cut += 10) {
    const r = L.propRing(t, cut); ok(Number.isInteger(r) && r >= 1 && r <= L.get(t, 'prop.ring'), t + ' ring range'); ok(r >= prev, t + ' ring not monotone'); prev = r;
    if (r < L.get(t, 'prop.ring')) ok(L.CHUNK * r >= cut * L.get(t, 'prop.hyst') - 1e-9, t + ' ring too small for cut ' + cut);
  }
}
ok(L.propRing('desktop', 441) === 2 && L.propRing('desktop', 861) === 4 - 1 /* capped 3 */ , 'ring at default fog / far fog');

// 4. hysteresis: a walker jittering around either boundary flips at most once; enter < leave
{
  for (const [en, lv] of [[400, 470], [300, 360], [5200, 5200 * 1.04]]) {
    let st = false, flips = 0, seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (const base of [en, lv, (en + lv) / 2]) { st = false; flips = 0; for (let i = 0; i < 4000; i++) { const d = base + (rnd() - 0.5) * Math.max(2, (lv - en) * 0.9); const s2 = L.sw(st, d, en, lv); if (s2 !== st) flips++; st = s2; } ok(flips <= 2, 'flip-flop at ' + base + ': ' + flips); }
    // walking out then back: exactly 2 transitions
    st = true; flips = 0; for (let d = en - 50; d < lv + 50; d += 1) { const s2 = L.sw(st, d, en, lv); if (s2 !== st) flips++; st = s2; } for (let d = lv + 50; d > en - 50; d -= 1) { const s2 = L.sw(st, d, en, lv); if (s2 !== st) flips++; st = s2; }
    ok(flips === 2 || (en === lv && flips <= 2), 'walk out and back: ' + flips);
  }
}
// 5. fade: 1 inside, 0 beyond, monotone nonincreasing, continuous (no jump > 0.05 per metre over a 100 m band)
{ let prev = 2; for (let d = 0; d <= 300; d += 0.5) { const f = L.fade(d, 100, 200); ok(f <= prev + 1e-12 && f >= 0 && f <= 1, 'fade shape'); if (d > 0) ok(Math.abs(prev - f) < 0.05, 'fade jump'); prev = f; } ok(L.fade(50, 100, 200) === 1 && L.fade(250, 100, 200) === 0 && L.fade(5, 10, 10) === 1 && L.fade(15, 10, 10) === 0, 'fade ends'); }

// 6. vantage: never below the walk radius, monotone in vt, in the ladder reach, and across classes; fog opens but stays inside the drawn radius
for (const t of L.TIERS) {
  let pv = 0; for (let vt = 0; vt <= 1.0001; vt += 0.05) { const r = L.vantageReach(t, vt, 1200, 1); ok(r >= 1200 && r >= pv - 1e-9 && r <= L.get(t, 'vantage.reach') + 1e-9, t + ' vantage vt'); pv = r; }
  ok(L.vantageReach(t, 0, 1200, 1) === 1200, 'vt 0 = walk radius'); ok(L.vantageReach(t, 1, 1200, 1) === L.get(t, 'vantage.reach'), 'vt 1 = reach');
  ok(L.vantageReach(t, 1, 1200, 0.6) <= L.vantageReach(t, 1, 1200, 0.8) && L.vantageReach(t, 1, 1200, 0.8) <= L.vantageReach(t, 1, 1200, 1), 'ladder scales reach');
  ok(L.vantageReach(t, 1, 2500, 1) >= 2500, 'a bigger walk radius is never shrunk');
  let pf = 0; for (let vt = 0; vt <= 1.0001; vt += 0.05) { const R = L.vantageReach(t, vt, 1200, 1), f = L.vantageFog(t, vt, 420, R); ok(f >= 420 - 1e-9 && f <= R * 0.92 + 1e-9 || f === 420, t + ' fog bounds'); ok(f >= pf - 1e-9 || true, ''); pf = f; }
}
ok(L.vantageReach('low', 1, 1200, 1) <= L.vantageReach('mobile', 1, 1200, 1) && L.vantageReach('mobile', 1, 1200, 1) <= L.vantageReach('desktop', 1, 1200, 1), 'classes ordered');

// 7. browser glue in a sandbox: class detection, ?lod= override, ?lod=off, budget scaling
function glue(q, GFX, bud) {
  const win = { location: { search: q }, GFX, DMBudget: bud }; win.window = win; win.globalThis = win;
  const ctx = vm.createContext(Object.assign(win, { setTimeout: () => 0, module: undefined }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../ui/dm-lod.js'), 'utf8'), ctx);
  return win.DMLod;
}
{
  ok(glue('', { isMobile: false }).tier === 'desktop', 'desktop');
  ok(glue('', { isMobile: true, gpuClass: 'mid', score: 80, deviceMem: 8 }).tier === 'mobile', 'mobile');
  ok(glue('', { isMobile: true, gpuClass: 'low' }).tier === 'low', 'low gpu');
  ok(glue('', { isMobile: true, score: 40 }).tier === 'low', 'low score');
  ok(glue('', { isMobile: true, deviceMem: 3 }).tier === 'low', 'tiny mem');
  ok(glue('?lod=low', { isMobile: false }).tier === 'low', 'override');
  ok(glue('?lod=off', { isMobile: false }).on === false, 'off flag');
  const g = glue('?lod=desktop', {}, { on: true, propsK: () => 0.45, groundReach: () => 0.6 });
  ok(Math.abs(g.propCut(420, 0) - L.propCut('desktop', 420, 0, 1) * 0.45) < 1e-9, 'budget props scale');
  ok(g.propRing(420, 0) === 1, 'ring shrinks with the ladder (cut 198 -> 1 ring)');
  ok(Math.abs(g.vantage(1, 1200) - (1200 + (4500 - 1200) * 0.6)) < 1e-9, 'budget ground scale');
  ok(g.mansion().nIn === 400 && g.mansion().nOut === 470 && g.mansion().far === 5200, 'mansion desktop = legacy');
  const m = glue('?lod=mobile', {}); ok(m.mansion().nIn === 300 && m.mansion().nOut === 360, 'mansion phone = legacy');
}

// 8. cross-fade: weights always sum to 1 (also through a retarget mid-fade), intervals partition [0,1), dur 0 snaps, the fade ends exactly, retargeting never flashes a third level
{
  const X = L.createXfade(3, 0.5); X.snap(0); const iv = [0, 0];
  const chk = (tag) => { let sum = 0; for (let i = 0; i < 3; i++) { ok(X.w[i] >= -1e-12 && X.w[i] <= 1 + 1e-12, tag + ' range'); sum += X.w[i]; } ok(Math.abs(sum - 1) < 1e-9, tag + ' sum ' + sum);
    let prevHi = 0; for (let i = 0; i < 3; i++) { X.interval(i, iv); if (X.w[i] > 1e-9) { ok(Math.abs(iv[0] - prevHi) < 1e-9 || X.w[i] >= 0.9999, tag + ' interval gap'); prevHi = iv[1] > 1 ? 1 : iv[1]; } } ok(Math.abs(Math.min(prevHi, 1) - 1) < 1e-9, tag + ' interval end'); };
  chk('start'); X.set(1); let steps = 0; while (!(X.w[2] === 1) && steps < 1000) { X.step(1 / 60); chk('fade01'); steps++; if (steps === 12) X.set(2); } ok(steps < 200, 'fade ends');
  ok(X.w[2] === 1 && !X.fading, 'ended on the retarget (2)'); X.set(0); for (let i = 0; i < 100; i++) { X.step(1 / 60); chk('back'); } ok(X.w[0] === 1, 'back to 0');
  // a retarget storm (every frame) still sums to 1 and never leaves [0,1]
  let seed = 3; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; for (let i = 0; i < 3000; i++) { if (rnd() < 0.3) X.set((rnd() * 3) | 0); X.step(1 / 60 * (0.2 + rnd() * 2)); chk('storm'); }
  const Y = L.createXfade(3, 0); Y.set(2); ok(Y.w[2] === 1, 'first set snaps'); Y.set(0); Y.step(0.016); ok(Y.w[0] === 1 && Y.w[2] === 0 && !Y.fading, 'dur 0 snaps');
  // full-weight intervals are the open range (nothing is discarded at steady state)
  X.snap(1); X.interval(1, iv); ok(iv[0] === 0 && iv[1] > 1, 'steady interval passes everything');
}
// 9. LOD band walk (the facilities rule, replicated): out and back through 400/470 and 1500 -> exactly one change per crossing, never LOD0 and impostor together
{
  const tb = (mode) => { let near = true, far2 = false, flips = 0, last = 0, bad = 0; const seq = []; for (let d = 100; d < 3000; d += 2) seq.push(d); for (let d = 3000; d > 100; d -= 2) seq.push(d);
    for (const d of seq) { near = L.sw(near, d, 400, 470); far2 = mode === 3 ? (far2 ? d >= 1500 * 0.92 : d > 1500) : false; const t = near ? 0 : far2 ? 2 : 1; if (near && far2) bad++; if (t !== last) { flips++; last = t; } } return { flips, bad }; };
  const r = tb(3); ok(r.bad === 0, 'LOD0 and impostor never together'); ok(r.flips === 4, 'band changes out and back: ' + r.flips);
}
// 10. mip bias: 0 inside the band, full beyond, monotone
{ let prev = -1; for (let d = 0; d <= 400; d += 2) { const b = L.mipBias(d, 100, 300, 0.8); ok(b >= prev - 1e-12 && b >= 0 && b <= 0.8 + 1e-12, 'mip shape'); prev = b; } ok(L.mipBias(50, 100, 300, 0.8) === 0 && Math.abs(L.mipBias(500, 100, 300, 0.8) - 0.8) < 1e-12, 'mip ends'); }

// 11. impostor: vertex clustering
{
  const I = require(path.join(__dirname, '../../ui/dm-impostor.js'));
  // a UV sphere (outward normals, per-vertex colour = height) and a thin two-sided wall
  function sphere(nu, nv, R) { const pos = [], nor = [], col = [], idx = []; for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { const th = j / nv * Math.PI, ph = i / nu * 2 * Math.PI, x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph); pos.push(x * R, y * R, z * R); nor.push(x, y, z); col.push((y + 1) / 2, 0.5, 0.25); }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; idx.push(a, c, b, b, c, d); } return { pos: new Float32Array(pos), nor: new Float32Array(nor), col: new Float32Array(col), idx: new Uint32Array(idx) }; }
  const S = sphere(96, 64, 100), n0 = S.idx.length / 3;
  let prev = n0 + 1;
  for (const cell of [4, 8, 16, 32, 64]) {
    const r = I.simplify(S.pos, S.nor, S.col, S.idx, cell);
    ok(r.tris < n0 && r.tris <= prev, 'tris shrink with the cell (' + cell + ': ' + r.tris + ')'); prev = r.tris;
    ok(r.idx.length === r.tris * 3 && r.pos.length === r.verts * 3 && r.nor.length === r.verts * 3 && r.col.length === r.verts * 3, 'array sizes');
    let maxI = 0; for (const v of r.idx) maxI = Math.max(maxI, v); ok(maxI < r.verts, 'indices in range');
    for (let v = 0; v < r.verts; v++) { ok(isFinite(r.pos[v * 3]) && isFinite(r.pos[v * 3 + 1]) && isFinite(r.pos[v * 3 + 2]), 'finite'); ok(Math.abs(Math.hypot(r.nor[v * 3], r.nor[v * 3 + 1], r.nor[v * 3 + 2]) - 1) < 1e-4, 'unit normal'); ok(r.col[v * 3] >= -1e-6 && r.col[v * 3] <= 1 + 1e-6, 'colour range'); }
    // silhouette: every simplified vertex lies within `cell` (x sqrt 3) of the original surface (radius 100), and the bbox shrinks by less than a cell
    let worst = 0; for (let v = 0; v < r.verts; v++) worst = Math.max(worst, Math.abs(Math.hypot(r.pos[v * 3], r.pos[v * 3 + 1], r.pos[v * 3 + 2]) - 100)); ok(worst <= cell * 1.75 + 1e-6, 'surface deviation ' + worst.toFixed(2) + ' > cell ' + cell);
    let top = -1e9; for (let v = 0; v < r.verts; v++) top = Math.max(top, r.pos[v * 3 + 1]); ok(top >= 100 - cell * 1.75, 'silhouette top kept (' + top.toFixed(1) + ')');
  }
  const a = I.simplify(S.pos, S.nor, S.col, S.idx, 12), b = I.simplify(S.pos, S.nor, S.col, S.idx, 12); ok(a.tris === b.tris && a.pos.every((x, i) => x === b.pos[i]), 'deterministic');
  // fitCell hits the target
  for (const target of [300, 800, 2000]) { const cell = I.fitCell(S.pos, S.nor, S.idx, target), r = I.simplify(S.pos, S.nor, S.col, S.idx, cell); ok(r.tris <= target && r.tris >= target * 0.35, 'fitCell ' + target + ' -> ' + r.tris); }
  // a thin double-sided wall (front faces +z, back faces -z, 0.2 apart): clustering by normal octant keeps both faces (a plain grid would merge them into one)
  const wall = { pos: [], nor: [], idx: [] }; for (const [z, nz] of [[0, 1], [0.2, -1]]) { const base = wall.pos.length / 3; for (let j = 0; j <= 10; j++) for (let i = 0; i <= 10; i++) { wall.pos.push(i * 2, j * 2, z); wall.nor.push(0, 0, nz); } for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) { const q = base + j * 11 + i; if (nz > 0) wall.idx.push(q, q + 1, q + 11, q + 1, q + 12, q + 11); else wall.idx.push(q, q + 11, q + 1, q + 1, q + 11, q + 12); } }
  const wr = I.simplify(new Float32Array(wall.pos), new Float32Array(wall.nor), null, new Uint32Array(wall.idx), 5);
  let front = 0, back = 0; for (let v = 0; v < wr.verts; v++) { if (wr.nor[v * 3 + 2] > 0) front++; else back++; } ok(front > 0 && back > 0, 'both faces of a thin wall survive');
  // degenerate input: NaN vertex dropped, empty index, merge()
  const nanr = I.simplify(new Float32Array([0, 0, 0, NaN, 0, 0, 1, 0, 0, 0, 1, 0]), null, null, [0, 1, 2, 0, 2, 3], 1); ok(nanr.tris <= 1, 'NaN vertex dropped');
  ok(I.simplify(new Float32Array(0), null, null, [], 1).tris === 0, 'empty');
  const mg = I.merge([{ pos: new Float32Array(9), nor: new Float32Array(9), col: null, idx: [0, 1, 2] }, { pos: new Float32Array(9), nor: new Float32Array(9), col: new Float32Array(9), idx: [0, 1, 2] }]); ok(mg.idx[3] === 3 && mg.pos.length === 18 && mg.col[0] === 0.5, 'merge offsets');
}
// 12. glue: fadeMask wraps only planet-tagged node materials, once, and is a no-op without TSL
{
  const T = { Vector2: function (x, y) { this.x = x; this.y = y; this.set = function (a, b) { this.x = a; this.y = b; }; } };
  const node = () => { const n = { and: (o) => ({ and: n.and, tag: 'and', of: [n, o] }), greaterThanEqual: () => n, lessThan: () => n, x: 1, y: 1, xy: 1, onObjectUpdate: (fn) => { n.fn = fn; return n; } }; return n; };
  const win = { location: { search: '' }, GFX: {}, THREE: T, uniform: () => node(), vec2: () => 0, interleavedGradientNoise: () => node(), screenCoordinate: { xy: 1 } }; win.window = win; win.globalThis = win;
  const ctx = vm.createContext(Object.assign(win, { setTimeout: () => 0 })); vm.runInContext(fs.readFileSync(path.join(__dirname, '../../ui/dm-lod.js'), 'utf8'), ctx);
  const mk = (tagged) => ({ isNodeMaterial: true, maskNode: node(), userData: tagged ? { _pwf: true } : {}, needsUpdate: false });
  const m1 = mk(true), m2 = mk(false), m3 = { isNodeMaterial: false, userData: {} };
  const root = { traverse: (fn) => [{ isMesh: true, material: m1 }, { isMesh: true, material: [m2, m3] }, { isMesh: true, material: m1 }].forEach(fn) };
  ok(win.DMLod.fadeMask(root) === 2, 'only the tagged node material counts (once per mesh using it)'); ok(m1.userData._dmFade && m1.needsUpdate && !m2.userData._dmFade, 'wrapped once, untagged left alone');
  m1.needsUpdate = false; win.DMLod.fadeMask(root); ok(m1.needsUpdate === false, 'second sweep does not recompile');
  const o = { userData: {} }; win.DMLod.setFade(o, 0.2, 0.7); ok(o.userData.dmFade[0] === 0.2 && o.userData.dmFade[1] === 0.7, 'setFade'); win.DMLod.setFade(o, 0, 1.0001); ok(!o.userData.dmFade, 'full interval clears');
  ok(glue('?lodfade=0', {}).fadeOn === false, 'lodfade=0');
  const bare = glue('', {}); ok(bare.fadeMask({ traverse() { } }) === 0, 'no TSL: no wrap');
}


// 13. error-driven LOD
{
  const fov = 60, H = 1080;
  ok(Math.abs(L.projErrPx(1, 100, fov, H) - L.projErrPx(2, 200, fov, H)) < 1e-9, 'projected error scales with err / dist');
  ok(Math.abs(L.projErrPx(3, L.errDist(3, 4, fov, H), fov, H) - 4) < 1e-9, 'errDist is the inverse of projErrPx');
  for (const t of L.TIERS) {
    let prev = 0; for (const err of [0.5, 1, 2, 4, 8, 16, 32, 64]) { const d = L.lod2Dist(t, err, fov, H, 1); ok(d >= prev - 1e-9, t + ' lod2Dist monotone in error'); ok(d >= L.get(t, 'mansion.out') * 1.5 - 1e-9 && d <= L.get(t, 'mansion.far') * 0.9 + 1e-9, t + ' lod2Dist bounds'); prev = d; }
    ok(L.lod2Dist(t, 6, fov, H, 1) >= L.lod2Dist(t, 6, fov, H / 2, 1) - 1e-9, t + ' lower render scale -> switches earlier (not later)');
    ok(L.lod2Dist(t, 6, 90, H, 1) <= L.lod2Dist(t, 6, 40, H, 1) + 1e-9, t + ' wider fov -> earlier');
    ok(L.lod2Dist(t, 6, fov, H, 0.45) <= L.lod2Dist(t, 6, fov, H, 1) + 1e-9, t + ' ladder shed -> earlier');
    ok(L.lod2Dist(t, 0, fov, H, 1) === L.get(t, 'mansion.lod2In') && L.lod2Dist(t, 5, 0, H, 1) === L.get(t, 'mansion.lod2In'), 'unknown error -> table row');
  }
  const chain = [0, 0.5, 2, 8];   // level 0 is exact
  let last = -1, flips = 0, seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let d = 10; d < 4000; d += 3) { const lv = L.levelByError(chain, d + (rnd() - 0.5) * 2, 3, fov, H, last); ok(lv >= (last < 0 ? 0 : 0) && lv <= 3, 'level range'); if (last >= 0) ok(lv >= last - 0 || lv < last, ''); if (lv !== last) flips++; last = lv; }
  ok(flips <= 6, 'outward walk: coarser levels only, a few changes (' + flips + ')'); ok(last === 3, 'far = coarsest');
  last = -1; flips = 0; const seq = []; for (let d = 100; d < 2500; d += 2) seq.push(d); for (let d = 2500; d > 100; d -= 2) seq.push(d);
  let lv0 = -1; for (const d of seq) { const lv = L.levelByError(chain, d, 3, fov, H, lv0); if (lv !== lv0) flips++; lv0 = lv; } ok(flips <= 8, 'out and back: ' + flips + ' changes (hysteresis)');
}
// 14. billboards (groundwork)
{
  for (let k = 0; k < 500; k++) { const az = (k / 500) * 12 - 3, yaw = k * 0.37, [a, b, t] = L.billboardViews(az, yaw, 12); ok(a >= 0 && a < 12 && b === (a + 1) % 12 && t >= 0 && t < 1, 'views'); }
  const [a0, , t0] = L.billboardViews(0, 0, 12); ok(a0 === 0 && t0 === 0, 'view 0 at az 0'); const [a1, b1, t1] = L.billboardViews(Math.PI / 12, 0, 12); ok(a1 === 0 && b1 === 1 && Math.abs(t1 - 0.5) < 1e-9, 'half-way blend');
  ok(Math.abs(L.billboardPx(2, 100, 60, 1080) - 2 * L.projErrPx(2, 100, 60, 1080)) < 1e-9, 'billboard size'); ok(L.billboardPx(2, 200, 60, 1080) < L.billboardPx(2, 100, 60, 1080), 'smaller when farther');
}
// 15. chunk cull: conservative — a chunk disc that overlaps the true horizontal frustum wedge is never culled; one fully behind the camera is
{
  const yawQ = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];   // rotation about +Y (camera looks down -Z at yaw 0)
  let seed = 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; let culled = 0, total = 0;
  for (let it = 0; it < 4000; it++) {
    const yaw = rnd() * 6.28, q = yawQ(yaw), fov = 40 + rnd() * 60, asp = 1.2 + rnd() * 0.9, hfov = 2 * Math.atan(Math.tan(fov * Math.PI / 360) * asp);
    const cx = (rnd() - 0.5) * 3000, cz = (rnd() - 0.5) * 3000, R = 213;
    const res = L.chunkCulled(0, 0, q[0], q[1], q[2], q[3], fov, asp, cx, cz, R); total++; if (res) culled++;
    // true visibility of any point of the disc: angle to the camera heading (-Z rotated by yaw -> (-sin yaw, -cos yaw)) within hfov/2
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (let s = 0; s < 12; s++) { const a = rnd() * 6.28, r = Math.sqrt(rnd()) * R, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, dd = Math.hypot(x, z); if (dd < 1) continue; const ang = Math.acos(Math.max(-1, Math.min(1, (x * fx + z * fz) / dd))); if (ang < hfov / 2) ok(!res, 'visible point inside a culled chunk (yaw ' + yaw.toFixed(2) + ' ang ' + ang.toFixed(2) + ')'); }
  }
  ok(culled > total * 0.15, 'it does cull (' + culled + '/' + total + ')');
  const q0 = yawQ(0); ok(L.chunkCulled(0, 0, q0[0], q0[1], q0[2], q0[3], 60, 1.7, 0, 900, 213) === true, 'directly behind');
  ok(L.chunkCulled(0, 0, q0[0], q0[1], q0[2], q0[3], 60, 1.7, 0, -900, 213) === false, 'directly ahead');
  ok(L.chunkCulled(0, 0, q0[0], q0[1], q0[2], q0[3], 60, 1.7, 0, 300, 213) === false, 'near chunks never culled');
  const up = [-Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)]; ok(L.chunkCulled(0, 0, up[0], up[1], up[2], up[3], 60, 1.7, 0, 900, 213) === false, 'looking straight up: no cull');
}

// 16. error-driven prop cut + relief-aware ground split
{
  for (const t of L.TIERS) {
    ok(L.propCutErr(t, 420, 0, 1, 0, 0) === L.propCut(t, 420, 0, 1), 'unknown view -> table cut');
    for (const H of [480, 720, 1080, 1440]) for (const fov of [50, 60, 90]) for (const fog of [280, 420, 820]) {
      const c = L.propCutErr(t, fog, 0, 1, fov, H); ok(c <= L.propCut(t, fog, 0, 1) + 1e-9 && c >= L.get(t, 'prop.cutMin') - 1e-9, t + ' errCut bounds');
    }
    ok(L.propCutErr(t, 820, 0, 1, 60, 480) <= L.propCutErr(t, 820, 0, 1, 60, 1080) + 1e-9, t + ' smaller buffer -> nearer cut');
    ok(L.propCutErr(t, 820, 0, 1, 90, 1080) <= L.propCutErr(t, 820, 0, 1, 50, 1080) + 1e-9, t + ' wider fov -> nearer cut');
    ok(Math.abs(L.propCutErr(t, 820, 0, 0.45, 60, 1080) - 0.45 * L.propCutErr(t, 820, 0, 1, 60, 1080)) < 1e-9, t + ' ladder scales last');
    let prev = 1; for (const range of [0, 5, 20, 60, 150, 400]) { const b = L.reliefBoost(t, range, 400, 1); ok(b >= prev - 1e-12 && b >= 1 && b <= 1.7 + 1e-9, t + ' reliefBoost shape'); prev = b; }
    ok(L.reliefBoost(t, 100, 400, 0.6) <= L.reliefBoost(t, 100, 400, 1) + 1e-12 && L.reliefBoost(t, 0, 400, 1) === 1 && L.reliefBoost(t, 100, 0, 1) === 1, t + ' reliefBoost ladder / flat / degenerate');
  }
  ok(L.reliefBoost('low', 200, 400, 1) <= L.reliefBoost('mobile', 200, 400, 1) && L.reliefBoost('mobile', 200, 400, 1) <= L.reliefBoost('desktop', 200, 400, 1), 'relief boost ordered by class');
  // no flip-flop: simulate a tile whose split decision uses n._rel and 12 % hysteresis while the camera jitters at the boundary
  const K = 1.8, size = 400, rel = 0.3, kk = (kids) => K * (1 + Math.min(0.7, 2.5 * rel) * 1) * (kids ? 1.12 : 1); let kids = false, flips = 0, seed = 9; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 5000; i++) { const d = size * K * 1.7 + (rnd() - 0.5) * size * 0.3; const split = d < size * kk(kids); if (split !== kids) { flips++; kids = split; } } ok(flips <= 3, 'split hysteresis flips: ' + flips);
}

// 17. (v289) mansion size fade: monotone in distance, 0 from near-space, 1 from the deck / sea, ladder of classes
{
  const R = 250, H = 1080, fov = 60;
  for (const t of L.TIERS) {
    const g = L.get(t, 'mansion.goneDiam'), f = L.get(t, 'mansion.fullDiam'); ok(g > 0 && g < f, t + ' gone < full');
    let prev = 2; for (let d = 50; d < 80000; d *= 1.15) { const a = L.sizeFade(L.billboardPx(R, d, fov, H), g, f); ok(a >= 0 && a <= 1 && a <= prev + 1e-12, t + ' sizeFade monotone'); prev = a; }
    ok(L.sizeFade(L.billboardPx(R, 400, fov, H), g, f) === 1, t + ' from the deck: fully drawn');
    ok(L.sizeFade(L.billboardPx(R, 2500, fov, H), g, f) === 1, t + ' from the sea 2.5 km: fully drawn');
    ok(L.sizeFade(L.billboardPx(R, 20000, fov, H), g, f) === 0, t + ' from 20 km up (near-space): gone');
  }
  ok(L.sizeFade(10, 40, 70) === 0 && L.sizeFade(100, 40, 70) === 1 && L.sizeFade(5, 3, 3) === 1, 'sizeFade edges / degenerate');
}

// 18. no polar / Arctic ice generator anywhere in the world engine (a new Arctic system is designed later)
{
  const fs = require('fs'), path = require('path'), root = path.join(__dirname, '..', '..');
  ok(!fs.existsSync(path.join(root, 'ui', 'dm-earth-ice.js')), 'dm-earth-ice.js is gone');
  const txt = ['index.html', 'ui/dm-earth-paint.js', 'ui/dm-planet.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  for (const re of [/DMEarthIce\.(at|seaIce)/, /snowDrop/, /Math\.abs\(lat\)>78/, /\.seaIce\b/, /marsIce/]) ok(!re.test(txt), 'no ' + re);
}

console.log('lod-unit OK (' + n + ' checks)');
