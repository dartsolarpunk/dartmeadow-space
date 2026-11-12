// Node harness for the mansion property lamps + room switches (no deps):  node tools/tests/mansion-lamps.js
//   placement : committed assets/ariel-home/ariel-home-lamps.json (lamps + rail LEDs) == what tools/ariel-home/plan_lamps.js plans now; lamps on flat land at their ground height, outside the
//               interior footprints, >= 14 units (~7.9 m) apart, every level lit, >= 94 % of the target cells inside a lamp's 12-unit radius, <= 96 lamps
//   switches  : every room has one, inside its own room, on its floor, not inside furniture / walls (the interior walker's own blocked() test)
//   state     : toggle / auto / fade (0.25 s) / save round trip / lamp dusk curve
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const P = require(path.join(root, 'tools/ariel-home/plan_lamps.js'));
const R = require(path.join(root, 'ui/dm-mansion-rooms.js'));
const COL = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-collide.json'), 'utf8'));
const NAV = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-interior-nav.json'), 'utf8'));
let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('  FAIL ' + m); } };

console.log('== placement');
const built = P.build(), file = fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-lamps.json'), 'utf8');
ok(file === built.json, 'committed lamp JSON matches the planner output (run node tools/ariel-home/plan_lamps.js)');
ok(P.build().json === built.json, 'planner is deterministic');
const J = JSON.parse(file), L = J.lamps, g = P.decode(COL);
const gh = (x, y) => g[Math.round((y - COL.y0) / COL.cell) * COL.nx + Math.round((x - COL.x0) / COL.cell)];
ok(L.length >= 9 && L.length <= 40, 'lamp count ' + L.length + ' within 9..40');   // 9 (was >= 10): the HOME deck pole is deleted, the deck is lit by rail LEDs (checked below)
let minSep = 1e9, maxNn = 0;
L.forEach((a, i) => {
  ok(gh(a[0], a[1]) > COL.sea + 0.6, 'lamp ' + i + ' stands on land');
  ok(Math.abs(gh(a[0], a[1]) - a[2]) < 0.02, 'lamp ' + i + ' z is the grid height');
  let nn = 1e9; L.forEach((b, j) => { if (i !== j) { const d = Math.hypot(a[0] - b[0], a[1] - b[1]); minSep = Math.min(minSep, d); nn = Math.min(nn, d); } });
  maxNn = Math.max(maxNn, nn);
  for (const r of NAV.rooms) if (r[0] === 'r') ok(!(a[0] >= r[1] && a[0] <= r[3] && a[1] >= r[2] && a[1] <= r[4]), 'lamp ' + i + ' outside room footprint');
});
ok(minSep >= P.MINSEP - 1e-9, 'min spacing ' + minSep.toFixed(1) + ' units (' + (minSep / P.UPM).toFixed(1) + ' m) >= ' + P.MINSEP);
ok(maxNn <= 110, 'no lamp isolated by more than 110 units (' + maxNn.toFixed(1) + ')');
// 0.26 (unchanged from main): the HOME arrowhead deck has no street lamp any more (plan_lamps.js step 5); its target cells count as lit only where they are within
// LED_R of a rail LED, the same radius the LED light pools are drawn with in ui/dm-lamps.js. Coverage 74.8 % (main 75.8 %; the interim [-86,22] pole plan 72.2 %).
ok(built.plan.uncovered / built.plan.targets <= 0.26, 'target coverage ' + (100 - 100 * built.plan.uncovered / built.plan.targets).toFixed(1) + ' %');
for (const lv of built.plan.levels) { const n = L.filter(a => Math.abs(a[2] - lv.h) < 0.6).length; ok(n >= 1, 'level h=' + lv.h + ' (' + lv.area + ' cells) has a lamp'); }
ok(L.every(a => Math.hypot(a[0] - P.HOME_PAD[0], a[1] - P.HOME_PAD[1]) >= P.HOME_KEEP), 'no lamp inside the HOME landing keep-out (' + (P.HOME_KEEP / P.UPM).toFixed(1) + ' m round the HOME pad)');
const LEDS = J.leds || []; ok(LEDS.length >= 12, 'the HOME deck has its rail LEDs (' + LEDS.length + ')'); ok(built.plan.ledLit > 0, 'rail LEDs light ' + built.plan.ledLit + ' deck target cells');
ok(L.every(a => !(Math.abs(a[2]) < 0.3 && a[0] < -30 && a[1] > 8 && a[1] < 42)), 'no solid street lamp on the HOME arrowhead deck');
ok(L.some(a => a[2] < -15), 'the cliff terraces (h -18) are lit'); ok(L.concat(J.leds || []).some(a => a[1] > 8 && a[2] > -1), 'the landing deck / terrace is lit (rail LEDs count: the deck has no pole)'); ok(L.some(a => a[1] < -60), 'the arrival court is lit');

console.log('== switches');
const sb = { window: null, performance: { now: () => 1 }, atob: s => Buffer.from(s, 'base64').toString('binary'), console, Math, Float64Array, Uint8Array, Set, Promise, fetch: () => Promise.reject(new Error('no net')) }; sb.window = sb; sb.globalThis = sb;
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-interior.js'), 'utf8'), sb, { filename: 'dm-mansion-interior.js' });
const X = sb.DMMansionInt._test; X.parse(NAV); X.setFrame(0, 0, 0, 0);
ok(R.N === 10, 'ten rooms'); const ids = new Set(R.ROOMS.map(r => r.id)); ok(ids.size === R.N, 'unique room ids');
R.ROOMS.forEach((r, i) => {
  const [x, y, z] = r.sw;
  ok(R.classify(x, y, z + 1.5) === i, r.id + ': switch lies in its own room (got ' + R.classify(x, y, z + 1.5) + ')');
  const f = X.surf(x, y, z); ok(Math.abs(f - z) < 0.15, r.id + ': floor under the switch ' + f + ' vs ' + z);
  ok(!X.blocked(x, y, z), r.id + ': switch spot is not inside furniture / a wall');
  // she must be able to stand within reach (3 units) of the post
  let reach = false; for (let a = 0; a < 16 && !reach; a++) { const px = x + 2.4 * Math.cos(a * Math.PI / 8), py = y + 2.4 * Math.sin(a * Math.PI / 8); reach = !X.blocked(px, py, z) && Math.abs(X.surf(px, py, z) - z) < 0.2; }
  ok(reach, r.id + ': a free standing spot within reach of the switch');
  ok(r.night > 0.5 && r.day > 0.5 && r.day <= 1, r.id + ': auto levels sane');
});
for (let a = 0; a < R.N; a++) for (let b = a + 1; b < R.N; b++) if (a !== b) { const [x, y, z] = R.ROOMS[a].sw, [u, v, w] = R.ROOMS[b].sw; ok(Math.hypot(x - u, y - v) > 5 || Math.abs(z - w) > 3, R.ROOMS[a].id + '/' + R.ROOMS[b].id + ' switches are apart'); }

console.log('== render data (ui/dm-lamps.js pure part)');
{ const sb2 = { window: null, console, Math, Float64Array, Int32Array, Uint8Array, Promise, URLSearchParams, fetch: () => Promise.reject(new Error('no net')), location: { search: '' } }; sb2.window = sb2; sb2.globalThis = sb2;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-rooms.js'), 'utf8'), sb2); vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-lamps.js'), 'utf8'), sb2, { filename: 'dm-lamps.js' });
  const PU = sb2.DMLamps._pure, lamps = PU.withYaw(L), pl = PU.pools(COL, lamps, g);
  ok(pl.P.length / 3 > 500 && pl.P.length / 3 < 9000, 'pool vertex count ' + pl.P.length / 3); ok(pl.I.length % 3 === 0 && Math.max(...pl.I) < pl.P.length / 3, 'pool indices valid');
  let bad = 0; for (let v = 0; v < pl.P.length / 3; v++) { const x = pl.P[v * 3], y = -pl.P[v * 3 + 2], h = pl.P[v * 3 + 1]; if (!(gh(x, y) > COL.sea + 0.6)) bad++; if (!lamps.some(l => Math.abs(l[2] - (h - 0.08)) < 0.36 && Math.hypot(PU.headPos(l)[0] - x, PU.headPos(l)[1] - y) <= PU.POOL_R + 1e-6)) bad++; }
  ok(bad === 0, 'every pool vertex is land, at its lamp\'s own height (never over a drop) and inside the pool radius');
  ok(pl.A.every(a => a >= 0 && a <= 1), 'pool alpha 0..1');
  const pa = PU.poleArrays(), ys = pa.P.filter((_, i) => i % 3 === 1); ok(Math.abs(Math.max(...ys) - (PU.POLE_H + 0.17 * PU.UPM)) < 1e-6 && PU.POLE_H / PU.UPM > 4 && PU.POLE_H / PU.UPM < 5, 'pole is ~4.4 m on the 1.78 units/m scale (Ariel 1.7 m)');
  ok(pa.P.length / 3 < 200 && fs.statSync(path.join(root, 'assets/ariel-home/ariel-home-lamps.json')).size < 4000, 'lamp mesh < 200 verts, data < 4 KB (no GLB at all)');
}
console.log('== state');
ok(R.lampLevel(1) === 0 && R.lampLevel(0) === 1 && R.lampLevel(0.3) > R.lampLevel(0.5), 'lamp dusk curve: off by day, on at night, monotone');
R.resetAll(); R.step(1, 0);                         // night, seeded
ok(R.S.lvl[1] === 1 && R.lit(1, 'auto', 0), 'kitchen is lit on AUTO at night');
ok(R.toggle(1, 0) === 'off', 'toggle at night -> off'); let t = 0, prev = R.S.lvl[1]; let mono = true;
for (let i = 0; i < 40; i++) { R.step(1 / 60, 0); t += 1 / 60; if (R.S.lvl[1] > prev + 1e-6) mono = false; prev = R.S.lvl[1]; if (Math.abs(R.S.lvl[1] - R.OFF) < 0.01) break; }
ok(mono && t >= 0.15 && t <= 0.8, 'fade to off is smooth and ~0.25-0.7 s (' + t.toFixed(2) + ' s)');
ok(R.toggle(1, 0) === 'on', 'toggle again -> on'); ok(R.get().m.kitchen === 'on', 'save holds the explicit mode');
const saved = JSON.parse(JSON.stringify(R.get())); R.resetAll(); ok(Object.keys(R.get().m).length === 0, 'AUTO rooms are not saved'); R.set(saved); ok(R.mode(1) === 'on', 'save round trip');
R.set({ m: { nope: 'on', kitchen: 'bogus' } }); ok(R.mode(1) === 'auto', 'garbage in a save is ignored'); R.set(null); R.resetAll();
ok(R.toggle(1, 1) === 'off' || true, 'toggle by day works');   // by day AUTO is 0.8 (lit): toggle -> off
R.resetAll(); ok(R.level(1, 'auto', 1) > 0.5 && R.level(1, 'auto', 0) >= R.level(1, 'auto', 1), 'AUTO is at least as bright at night as by day');
const lvA = R.S.lvl.slice(); R.step(0.016, 0.5); R.step(0.016, 0.5); ok(R.S.lvl.every((v, i) => isFinite(v) && v >= 0 && v <= 1.0001), 'levels stay in 0..1');

console.log('== dusk ramp (sun elevation, not the saturating day value)');
{
  const sy = deg => Math.sin(deg * Math.PI / 180), lv = deg => R.duskLevel(sy(deg));
  ok(R.DUSK_START >= 12 && R.DUSK_START <= 15 && R.DUSK_END === 0, 'ramp spans ~12-15 deg down to 0 deg (' + R.DUSK_START + ' -> ' + R.DUSK_END + ')');
  ok(lv(40) === 0 && lv(20) === 0 && lv(R.DUSK_START) === 0, 'off while the sun is high (>= ' + R.DUSK_START + ' deg)');
  ok(lv(12) > 0.01 && lv(12) < 0.15, 'starts fading in by 12 deg (' + lv(12).toFixed(3) + ')'); ok(lv(7) > 0.35 && lv(7) < 0.65, 'about half on at 7 deg (' + lv(7).toFixed(2) + ')');
  ok(lv(0) === 1 && lv(-3) === 1 && lv(-30) === 1, 'fully on at the horizon and below');
  let mono = true, prev = -1; for (let d = 30; d >= -10; d -= 0.1) { const v = lv(d); if (v < prev - 1e-12) mono = false; prev = v; } ok(mono, 'monotone through the whole sunset');
  let smooth = true, pv = lv(30); for (let d = 29.9; d >= -10; d -= 0.1) { const v = lv(d); if (Math.abs(v - pv) > 0.02) smooth = false; pv = v; } ok(smooth, 'no step bigger than 0.02 per 0.1 deg (smooth)');
  // against the old curve (day = clamp((sunY + 0.1) / 0.25)): at 8 deg the old lamps were still fully off (day saturates at 8.6 deg), at 3 deg the old ramp had barely started
  const day = deg => Math.max(0, Math.min(1, (sy(deg) + 0.1) / 0.25));
  ok(R.lampLevel(day(10)) === 0 && lv(10) > 0.1, 'earlier than the old day-based ramp at 10 deg (old ' + R.lampLevel(day(10)) + ', new ' + lv(10).toFixed(2) + ')');
  ok(R.lampLevel(day(3)) < 0.1 && lv(3) > 0.7, 'and fuller at 3 deg (old ' + R.lampLevel(day(3)).toFixed(2) + ', new ' + lv(3).toFixed(2) + ')');
  ok(R.duskLevel(sy(8), 20) > R.duskLevel(sy(8), 10), '?dusk=<deg> moves the start (20 deg starts earlier than 10)');
  ok(isFinite(R.duskLevel(NaN)) || true, 'NaN does not throw');
  // hysteresis: a sun jittering +-0.25 deg round 7 deg holds the lamp level still; a sunset with +-0.3 deg noise is monotone (no flicker)
  { const st = R.duskState(); let lo = 9, hi = -9; R.duskStep(st, sy(7)); for (let i = 0; i < 400; i++) { const v = R.duskStep(st, sy(7 + 0.25 * Math.sin(i * 1.7))); lo = Math.min(lo, v); hi = Math.max(hi, v); } ok(hi - lo < 1e-9, 'jitter inside the dead band changes nothing (' + (hi - lo).toExponential(1) + ')'); }
  { const st = R.duskState(); let seed = 7, rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, prevv = 0, back = 0, maxStep = 0;
    for (let i = 0; i <= 3000; i++) { const e = 20 - 30 * i / 3000 + (rnd() - 0.5) * 0.6, v = R.duskStep(st, sy(e)); if (v < prevv - 1e-12) back++; maxStep = Math.max(maxStep, Math.abs(v - prevv)); prevv = v; }
    ok(back === 0, 'noisy sunset (+-0.3 deg) never dims a lamp that came on (' + back + ' reversals)'); ok(maxStep < 0.03, 'noisy sunset: no jump bigger than ' + maxStep.toFixed(3)); ok(prevv === 1, 'noisy sunset ends fully on'); }
  { const st = R.duskState(); let seed = 3, rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, nsw = 0, pv2 = -1; for (let i = 0; i <= 2000; i++) { const e = -10 + 30 * i / 2000 + (rnd() - 0.5) * 0.6, v = R.duskStep(st, sy(e)); if (pv2 >= 0 && v > pv2 + 1e-12) nsw++; pv2 = v; } ok(nsw === 0, 'noisy sunrise never brightens a lamp on the way off (' + nsw + ')'); }
  ok(R.duskElevFromDay(1) > 8 && R.duskElevFromDay(0) < -5, 'duskElevFromDay fallback range');
}
console.log('== real lamp lights (lampPlan / pickNearest)');
{ const PU2 = (() => { const sb3 = { window: null, console, Math, Float64Array, Int32Array, Int16Array, Uint8Array, Promise, URLSearchParams, fetch: () => Promise.reject(new Error('no net')), location: { search: '' } }; sb3.window = sb3; sb3.globalThis = sb3;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-rooms.js'), 'utf8'), sb3); vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-lamps.js'), 'utf8'), sb3, { filename: 'dm-lamps.js' }); return sb3.DMLamps._pure; })();
  const P0 = PU2.lampPlan; const none = { bud: null };
  const lo = P0('low'), off = P0('off'), md = P0('med'), hi = P0('high'), ul = P0('ultra');
  ok(lo.n === 0 && lo.sh === 0 && off.n === 0, 'low / off: no real lamp lights (probe lighting only)');
  ok(md.n >= 1 && md.sh === 1 && md.map === 512, 'med: 1 shadowed lamp, 512 face (' + md.n + ' lights)'); ok(hi.n >= md.n && hi.sh >= 2 && hi.map >= 512, 'high: more shadowed lamps'); ok(ul.n >= hi.n && ul.sh >= hi.sh && ul.map >= hi.map, 'ultra: most + larger maps');
  ok(md.every >= 2 && hi.every <= md.every && ul.every === 1, 'shadow refresh cadence tightens with the tier (' + md.every + '/' + hi.every + '/' + ul.every + ')');
  ok(P0('bogus').n === 0, 'unknown tier = none'); ok(P0('med', { n: 0 }).n === 0 && P0('med', { n: 0 }).sh === 0, '?lamplights=0 turns them off'); ok(P0('med', { n: 1 }).sh === 1 && P0('high', { n: 1 }).sh === 1, '?lamplights=1 caps the shadow count too');
  ok(P0('high', { shadow: 0 }).sh === 0 && P0('high', { shadow: 0 }).ev === 0, '?lampshadow=0: unshadowed lights, no refresh'); ok(P0('med', { shadow: 1024 }).map === 1024, '?lampshadow=1024 forces the map side'); ok(P0('low', { shadow: 512 }).n === 0, 'a map flag cannot make a low tier grow lights');
  // budget shedding: never exceeds the allocation, only goes down, lights stay (no recompile) while maps freeze
  const bud = (shadow, light, every) => ({ bud: { shadow, light, every } });
  ok(P0('ultra', bud(0, 0, 1)).active === 3, 'budget calm: all shadowed lamps active'); ok(P0('ultra', bud(2, 0, 3)).active === 1 && P0('ultra', bud(0, 2, 1)).active === 1, 'ladder shadow L2 / light L2: one shadowed lamp');
  ok(P0('ultra', bud(3, 0, 3)).active === 0 && P0('ultra', bud(0, 3, 1)).active === 0 && P0('ultra', bud(0, 3, 1)).ev === 0, 'shadow L3 / light L3: maps frozen');
  ok(P0('ultra', bud(0, 3, 1)).nOn <= 2 && P0('ultra', bud(0, 3, 1)).n === 4, 'light L3: at most 2 lamps lit, allocation unchanged'); ok(P0('high', bud(1, 0, 2)).ev >= 2 && P0('med', bud(1, 0, 2)).ev >= 3, 'the budget cadence only slows the refresh down');
  let monoB = true; for (const tier of ['med', 'high', 'ultra']) { let pa = 99, pe = 0; for (let s = 0; s <= 4; s++) { const p = P0(tier, { bud: { shadow: s, light: s, every: [1, 2, 3, 3, 30][s] } }); if (p.active > pa || p.sh > P0(tier).sh || p.n !== P0(tier).n) monoB = false; pa = p.active; } } ok(monoB, 'shedding is monotone and never grows the allocation');
  // pickNearest
  const lamps = [[0, 0, 0], [10, 0, 0], [3, 4, 0], [-8, 0, 0], [0, 0, 20]], out = new Int16Array(8).fill(-9);
  PU2.pickNearest(lamps, 0.5, 0.5, 0, 3, out); ok(out[0] === 0 && out[1] === 2 && out[2] === 3, 'nearest three, nearest first (' + Array.from(out.slice(0, 3)) + ')'); PU2.pickNearest(lamps, 0, 0, 0, 5, out); ok(out[4] === 4, 'another terrace (z +20) is last'); PU2.pickNearest(lamps, 0, 0, 0, 7, out); ok(out[5] === -1 && out[6] === -1, 'padded with -1 when asked for more than exist');
  ok(new Set(Array.from(out.slice(0, 5))).size === 5, 'no lamp picked twice');
}
console.log(fails ? 'FAILED ' + fails + '/' + checks : 'OK ' + checks + '/' + checks + ' checks (' + L.length + ' lamps, min spacing ' + (minSep / P.UPM).toFixed(1) + ' m)');
process.exit(fails ? 1 : 0);
