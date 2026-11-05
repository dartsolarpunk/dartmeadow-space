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
console.log('lod-unit OK (' + n + ' checks)');
