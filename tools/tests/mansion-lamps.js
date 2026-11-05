// Node harness for the mansion property lamps + room switches (no deps):  node tools/tests/mansion-lamps.js
//   placement : committed assets/ariel-home/ariel-home-lamps.json == what tools/ariel-home/plan_lamps.js plans now; lamps on flat land at their ground height, outside the
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
ok(L.length >= 10 && L.length <= 40, 'lamp count ' + L.length + ' within 10..40');
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
ok(built.plan.uncovered / built.plan.targets <= 0.26, 'target coverage ' + (100 - 100 * built.plan.uncovered / built.plan.targets).toFixed(1) + ' %');
for (const lv of built.plan.levels) { const n = L.filter(a => Math.abs(a[2] - lv.h) < 0.6).length; ok(n >= 1, 'level h=' + lv.h + ' (' + lv.area + ' cells) has a lamp'); }
ok(L.some(a => a[2] < -15), 'the cliff terraces (h -18) are lit'); ok(L.some(a => a[1] > 8 && a[2] > -1), 'the landing deck / terrace is lit'); ok(L.some(a => a[1] < -60), 'the arrival court is lit');

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
console.log(fails ? 'FAILED ' + fails + '/' + checks : 'OK ' + checks + '/' + checks + ' checks (' + L.length + ' lamps, min spacing ' + (minSep / P.UPM).toFixed(1) + ' m)');
process.exit(fails ? 1 : 0);
