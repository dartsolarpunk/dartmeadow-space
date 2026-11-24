// node tools/tests/mars-facility.js — the Valles Rim annex (Track 5 / t1590): ui/dm-mars-facility.js + assets/mars-facility/mf-annex.json against the real
// ui/dm-collide.js. Checks: data sanity; every room reachable on foot from the apron through real doorways (BFS over the DMCollide boxes, then walked with
// DMCollide's own character at 60 / 15 fps); walls hold; the hangar door blocks while shut and opens with the FUNCTION toggle (collider moves with the leaf);
// her floor (inside / roof / outside, only inside her own ground query); seating on sloped ground + the apron ramp; the dm-facilities.js / index.html wiring;
// the Valles Rim building is no longer near-black metal.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.V) console.log('  ok   ' + m); };
const D = JSON.parse(fs.readFileSync(path.join(root, 'assets/mars-facility/mf-annex.json'), 'utf8'));
globalThis.window = undefined; require(path.join(root, 'ui/dm-collide.js')); const L = globalThis.DMCollideLib;
let T = 1000, inG = false;
const sb = { performance: { now: () => T }, console, Math, location: { search: '' }, fetch: () => Promise.reject(new Error('no fetch')) };
sb.window = sb; sb.globalThis = sb;
sb.DMMansionInt = { inGround: () => inG };
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mars-facility.js'), 'utf8'), sb, { filename: 'dm-mars-facility.js' });
const M = sb.DMMarsFac, X = M._test;
// 1. data
const U = D.U;
ok(D.cols.length >= 60, 'colliders: ' + D.cols.length);
ok(D.lights.length >= 30, 'fixtures for the 2-light pool: ' + D.lights.length);
ok(['airlock', 'spine', 'control', 'crew', 'med', 'mess', 'workshop', 'power', 'hangar'].every(k => D.rooms[k]), 'every room of the plan: ' + Object.keys(D.rooms).join(', '));
ok(D.tris.ext + D.tris.int < 30000, 'triangle budget (ext ' + D.tris.ext + ' + int ' + D.tris.int + ')');
ok(D.foot[3] < -40, 'the annex (apron front z ' + D.foot[3] + ') stays clear of the kept building (block + foundation to z -40)');
for (const f of ['mf-annex.glb', 'mf-annex-512.glb']) { const st = fs.statSync(path.join(root, 'assets/mars-facility', f)); ok(st.size > 50000 && st.size < 3.5e6, f + ' size ' + (st.size / 1e6).toFixed(2) + ' MB'); }
// 2. collision world: the annex at the origin, floor y 0, th 0 (local = world)
const W = L.create({ capacity: 4096 }); const fakeC = { addBox: (...a) => W.addBox(...a), move: (...a) => W.move(...a), clearGroup: g => W.clearGroup(g) };
sb.DMCollide = fakeC;
X.setData(D); X.setFrame(0, 0, 0, 0); X.S.rec = { y: 0 }; X.S.F = { solids: [], addSolids: null, ctx: { isMobile: () => false } }; X.addCols();
ok(X.S.ncol === D.cols.length && X.S.doorId >= 0, 'all colliders registered (' + X.S.ncol + ') + the door leaf');
const OUT = new Float64Array(4);
const free = (x, z) => W.pushOut(x, 0, z, 0.7, 3.2, 0.6, OUT) < 1e-3;
const C = 0.5, f = D.foot, nx = Math.ceil((f[2] - f[0]) / C) + 1, nz = Math.ceil((f[3] - f[1] + 30) / C) + 1, z00 = f[1];
function bfs(sx, sz, tx, tz) {
  const id = (i, j) => j * nx + i, prev = new Int32Array(nx * nz).fill(-2), q = []; const si = Math.round((sx - f[0]) / C), sj = Math.round((sz - z00) / C), ti = Math.round((tx - f[0]) / C), tj = Math.round((tz - z00) / C);
  prev[id(si, sj)] = -1; q.push(id(si, sj));
  for (let h = 0; h < q.length; h++) { const k = q[h], i = k % nx, j = (k / nx) | 0; if (i === ti && j === tj) { const p = []; let c = k; while (c >= 0) { p.push([f[0] + (c % nx) * C, z00 + ((c / nx) | 0) * C]); c = prev[c]; } return p.reverse(); }
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= nx || jj >= nz || prev[id(ii, jj)] !== -2) continue; if (!free(f[0] + ii * C, z00 + jj * C)) { prev[id(ii, jj)] = -3; continue; } prev[id(ii, jj)] = k; q.push(id(ii, jj)); } }
  return null;
}
function freeNear(x, z) { for (let r = 0; r < 24; r++) for (let a = 0; a < 16; a++) { const px = x + r * 0.5 * Math.cos(a * Math.PI / 8), pz = z + r * 0.5 * Math.sin(a * Math.PI / 8); if (free(px, pz)) return [px, pz]; } return null; }
const center = r => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
const start = D.spawn.apron; const S0 = [start[0], start[2]];
ok(free(...S0), 'apron spawn is free');
function walkPath(p, fps) {
  const c = W.makeChar({ x: p[0][0], y: 0, z: p[0][1] }); const v = 9;
  for (let w = 1; w < p.length; w++) { let k = 0; while (k++ < 400) { const dx = p[w][0] - c.x, dz = p[w][1] - c.z, d = Math.hypot(dx, dz); if (d < 0.25) break; const s = Math.min(d, v / fps); W._dt = 1 / fps; W.walk(c, dx / d * s, dz / d * s); c.y = 0; }
    if (Math.hypot(p[w][0] - c.x, p[w][1] - c.z) > 0.6) return [c.x, c.z]; }
  return null;
}
// door shut: the hangar is reachable only through the workshop / mess doors (walk-in), not across the leaf; the habitat through the airlock
for (const rn of ['airlock', 'spine', 'control', 'crew', 'med', 'mess', 'workshop', 'power', 'hangar']) {
  const t = freeNear(...center(D.rooms[rn])); ok(!!t, 'a free spot in ' + rn); if (!t) continue;
  const p = bfs(S0[0], S0[1], t[0], t[1]); ok(!!p, 'apron -> ' + rn + ' through real doorways (door shut)');
  if (p) for (const fps of [60, 15]) { const st = walkPath(p, fps); ok(!st, 'walked apron -> ' + rn + ' at ' + fps + ' fps' + (st ? ' (stuck at ' + st.map(v => v.toFixed(1)) + ')' : '')); }
}
// walls hold: straight line from the apron into the control room through the front wall (window sill) must stop
{ const c = W.makeChar({ x: -22 * U, y: 0, z: -(D.Z0 - 4 * U) }); for (let i = 0; i < 200; i++) { W._dt = 1 / 30; W.walk(c, 0, -0.3); c.y = 0; } ok(c.z > -D.Z0, 'the control-room front wall stops her (z ' + c.z.toFixed(1) + ')'); }
// hangar door: shut = blocks the straight run in; open = clear
const dr = D.door.rect, dc = [(dr[0] + dr[2]) / 2, dr[3] + 6];
{ const c = W.makeChar({ x: dc[0], y: 0, z: dc[1] }); for (let i = 0; i < 200; i++) { W._dt = 1 / 30; W.walk(c, 0, -0.3); c.y = 0; } ok(c.z > dr[1], 'shut hangar door blocks (z ' + c.z.toFixed(1) + ')'); }
X.S.state = 2; X.S.open = 1; X.S.F.ctx = { isMobile: () => false }; M.tick === undefined || 0;
// move the leaf collider fully open through the module's own path
X.S.want = 1; X.S.open = 0.999; X.S.rec.ready = true; const recRef = X.S.rec; M.tick(recRef, 0, T, 0.1, { x: 1e5, y: 0, z: 1e5 }, 'walk');
ok(X.S.open === 1, 'the door eases fully open');
{ const c = W.makeChar({ x: dc[0], y: 0, z: dc[1] }); for (let i = 0; i < 300; i++) { W._dt = 1 / 30; W.walk(c, 0, -0.3); c.y = 0; } ok(c.z < dr[1] - 10, 'open hangar door: she walks straight in (z ' + c.z.toFixed(1) + ')'); }
// 3. her floor
M.walk({ x: 14 * U, y: 3 + 0, z: -(D.Z0 + 10 * U) }); inG = true;
const hIn = M.ovr(14 * U, -(D.Z0 + 10 * U)); ok(hIn === 0, 'inside the hangar: the annex floor (' + hIn + ')');
M.walk({ x: 14 * U, y: 3 + D.roofs[1][4], z: -(D.Z0 + 10 * U) }); const hR = M.ovr(14 * U, -(D.Z0 + 10 * U)); ok(Math.abs(hR - D.roofs[1][4]) < 1e-6, 'on the hangar roof: the roof (' + hR.toFixed(2) + ')');
inG = false; ok(isNaN(M.ovr(14 * U, -(D.Z0 + 10 * U))), 'nobody else gets the override (not her ground query)');
inG = true; ok(isNaN(M.ovr(500, 500)), 'far away: no override'); T += 1000; ok(isNaN(M.ovr(14 * U, -(D.Z0 + 10 * U))), 'stale feet: no override'); inG = false;
ok(X.isInside(14 * U, -(D.Z0 + 10 * U), 0) && !X.isInside(14 * U, -(D.Z0 + 10 * U), D.roofs[1][4]) && !X.isInside(0, 0, 0), 'inside test (floor yes, roof no, the deck no)');
ok(X.nearDoor(dc[0], dc[1], 0) && !X.nearDoor(-40, -(D.Z0 + 30 * U), 0), 'FUNCTION button only near the hangar door');
// seating on a slope: the floor sits on the highest ground in the footprint, the apron ramp covers the drop at the front
X.S.F = { baseH: (x, z) => -z * 0.05, solids: [], ctx: X.S.F.ctx }; X.S.rec = { y: 0 }; const y = X.seat();
ok(y >= -D.foot[0 + 1] * 0.05 - 1e-6 && y < -D.foot[1] * 0.05 + 1, 'seated on the highest ground (' + y.toFixed(2) + ')'); ok(X.S.rampDrop > 1, 'front drop ' + X.S.rampDrop.toFixed(2) + ' u gets a ramp');
// 4. wiring
const fac = fs.readFileSync(path.join(root, 'ui/dm-facilities.js'), 'utf8'), idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), mi = fs.readFileSync(path.join(root, 'ui/dm-mansion-interior.js'), 'utf8');
ok(/variant === 'mars' && window\.DMMarsFac\) \{ try \{ rec\.ext = DMMarsFac\.attach\(F, rec\)/.test(fac), 'dm-facilities.js place(): Mars attaches the annex');
ok(/if \(rec\.ext\) \{ try \{ rec\.ext\.tick\(/.test(fac) && /r\.ext\.detach\(\)/.test(fac) && /F\.addSolids = addSolids/.test(fac), 'tick + teardown + F.addSolids hooks');
ok(/<script src="ui\/dm-mars-facility\.js\?v=\d+" defer><\/script>/.test(idx) && idx.indexOf('ui/dm-mars-facility.js') < idx.indexOf('ui/dm-facilities.js'), 'index.html loads dm-mars-facility.js before facilities');
ok(/G\.DMMarsFac\) G\.DMMarsFac\.walk\(pos\)/.test(mi) && /inGround: \(\) => _q/.test(mi), 'dm-mansion-interior.js: feet hook + inGround');
ok(/metalness: 0\.05, roughness: 1/.test(fac) && /const r0 = 158/.test(fac), 'the Valles Rim building is a light dielectric composite now (not near-black metal)');
console.log(fails ? fails + ' FAILED of ' + n : 'mars-facility: all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
