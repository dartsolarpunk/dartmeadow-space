// Edge-of-screen gate + stateless body visibility.   node tools/tests/viewgate.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const V = require('../../ui/dm-viewgate.js');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
// camera at origin looking down -Z, 60 deg vertical, aspect 1: identity view matrix
const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], ty = Math.tan(Math.PI / 6), tx = ty;
const sph = (x, y, z) => [x, y, z];
ok(V.inView(I, tx, ty, 0, sph(0, 0, -100), 5, 0, 1), 'centre in view');
ok(!V.inView(I, tx, ty, 0, sph(0, 0, 100), 5, 0, 1), 'behind');
ok(!V.inView(I, tx, ty, 0, sph(300, 0, -100), 5, 0, 1), 'far off to the side');
ok(V.inView(I, tx, ty, 0, sph(62, 0, -100), 10, 0, 1), 'edge-grazing sphere (centre outside, body inside)');
ok(!V.inView(I, tx, ty, 0, sph(75, 0, -100), 5, 0, 1), 'just outside without pad');
ok(V.inView(I, tx, ty, 0, sph(75, 0, -100), 5, 0.2, 1), 'inside with an angular pad');
// hysteresis: a body jittering across the edge flips the gate at most twice, not every frame
const g = new V.Gate(1500); let t = 0, flips = 0, was = false;
for (let f = 0; f < 600; f++) { t += 16.7; const x = 60 + 6 * Math.sin(f * 0.9);   // jitters over the edge
  const tight = V.inView(I, tx, ty, 0, sph(x, 0, -100), 2, 0, 1), wide = V.inView(I, tx, ty, 0, sph(x, 0, -100), 2, 0.2, 1);
  const a = g.update(t, tight, wide); if (a !== was) { flips++; was = a; } }
ok(flips === 1, 'jittering at the edge: armed once and held (flips=' + flips + ')');
// leaves for good: drops only after holdMs outside the WIDE pad
const g2 = new V.Gate(1500); g2.update(0, true, true); ok(g2.active, 'armed');
g2.update(100, false, true); ok(g2.active, 'still active inside the wide pad');
g2.update(200, false, false); ok(g2.active, 'held after leaving');
g2.update(1590, false, false); ok(g2.active, 'held until holdMs passed (last inside at 100)');
g2.update(1700, false, false); ok(!g2.active, 'released after holdMs outside');
g2.update(1900, true, true); ok(g2.active, 're-enters immediately on the tight test');
// budget: stops once the slice is used, always makes progress, re-queues a task that says false
let clock = 0; const q = []; const log = [];
for (let i = 0; i < 10; i++) q.push(() => { clock += 4; log.push(i); });
ok(V.runBudget(q, 10, () => clock) === 3 && q.length === 7, '10 ms budget, 4 ms tasks -> 3 run');
ok(V.runBudget([() => { clock += 50; }, () => { clock += 50; }], 1, () => clock) === 1, 'at least one task even when over budget');
const q2 = []; let tries = 0; q2.push(() => (++tries < 3 ? false : undefined));
V.runBudget(q2, 100, () => 0); V.runBudget(q2, 100, () => 0); V.runBudget(q2, 100, () => 0);
ok(tries === 3 && q2.length === 0, 'a task returning false is retried on later frames');
// breadcrumbs
V.EdgeLog.add('in', 'Mars', 1000); V.EdgeLog.add('out', 'Venus', 5000);
ok(V.EdgeLog.recent(5200, 1500).join() === 'out:Venus', 'only recent breadcrumbs ride on a hitch');

// ---- regression: leave view, then re-enter -> the body is visible / built again (the Sol-speck rule from index.html, run for real) ----
const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
function grab(re) { const m = html.match(re); assert(m, 'source not found: ' + re); return m[0]; }
const fnNear = grab(/function _solBodyNear\(cam\)\{[\s\S]*?\n\}\n/);
const fnLod = grab(/function updateSolGalLod\(\)\{[\s\S]*?\n\}\n/);
const vm = require('vm');
function world(curSystem) {
  const B = []; const mk = (name, x) => ({ name, mcRadius: 6, mesh: { visible: true, position: { x, y: 0, z: 0 }, parent: {} } });
  const ctx = { window: { _curSystem: curSystem, _solFullSysHidden: false }, celestialBodies: B, flightCamera: { position: { x: 0, y: 0, z: 0 } },
    GAL_SOL_SPECK_DIST: 14000, _bodyVisRadius: b => b.mcRadius, PW: { active: false, opening: false }, _bodyEdgeTick() {}, Math, THREE: {},
    _flightSystemExtras: [], oortCloudGroup: null, distantSystems: [], flightTime: 0, performance: { now: () => 0 } };
  ctx._setSolFullSysVisible = function (vis) { for (const b of B) b.mesh.visible = vis; };
  B.push(mk('Earth', 500), mk('Neptune', 15000));
  vm.createContext(ctx); vm.runInContext(fnNear + fnLod.replace(/_setSolFullSysVisible\(!far\)/, '_setSolFullSysVisible(!far)'), ctx);
  return { ctx, B };
}
// Sol: the camera flies out past the speck radius (nothing near) -> hidden; flying back / to Neptune -> visible again
let W = world(null); const cam = W.ctx.flightCamera.position;
cam.x = 20000; W.ctx.updateSolGalLod(); ok(W.B.every(b => !b.mesh.visible), 'Sol far from every body: hidden (speck)');
cam.x = 15100; W.ctx.updateSolGalLod(); ok(W.B.every(b => b.mesh.visible), 'beside Neptune (28+ AU out): every body is shown, Neptune included');
cam.x = 14500; W.ctx.updateSolGalLod(); ok(W.B[1].mesh.visible, 'stays shown while Neptune is in reach');
cam.x = 100; W.ctx.updateSolGalLod(); ok(W.B.every(b => b.mesh.visible), 'home: shown');
// another system (built at the origin): its bodies are never hidden by the Sol rule, wherever the camera is
W = world({ name: 'Veyra' }); W.ctx.window._solFullSysHidden = true; W.B.forEach(b => b.mesh.visible = false);
W.ctx.flightCamera.position.x = 40000; W.ctx.updateSolGalLod();
ok(W.B.every(b => b.mesh.visible) && W.ctx.window._solFullSysHidden === false, 'procedural system: bodies restored and never speck-hidden');
// the player turns away (nothing in the rule depends on the view) and back: still visible
W.ctx.flightCamera.position.x = 40000; for (let i = 0; i < 5; i++) W.ctx.updateSolGalLod(); ok(W.B.every(b => b.mesh.visible), 'stable across frames');
console.log('viewgate.test.js: ' + n + ' checks passed');
