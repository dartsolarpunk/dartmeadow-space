// Headless harness for the HOME landing vs. a held sysBusy (ui/dm-arielhome.js pollLand/homeNow + ui/dm-facilities.js tick/loadMansion/place/teleport).
// The mansion GLB fetch must not wait for a system rebuild (_sysRebuildBusy): the HOME landing waits for the mansion warm-up, which needs MAN.glb.
// Only the heavy steps (place = scene add + compile) may wait for the rebuild. Both cases must reach the deck landing and clear arriveAt:
//   A. HOME pressed from space during a system switch: sysBusy is held N pollLand ticks (600 ms each), then a second rebuild holds it again right after the landing opens the world.
//   B. HOME after a cold reload: restored in Solenne's atmosphere, boot rebuild holds sysBusy for N ticks, nothing is loaded yet.
// Real ui/dm-arielhome.js + ui/dm-facilities.js run in a vm with a fake clock / timers and a mock ctx (no THREE, no GL). Pure node:  node tools/tests/mansion-home-landing.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const SRC_A = fs.readFileSync(path.join(root, 'ui/dm-arielhome.js'), 'utf8'), SRC_F = fs.readFileSync(path.join(root, 'ui/dm-facilities.js'), 'utf8');
const COL = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-collide.json'), 'utf8'));
const tick = () => new Promise(r => setImmediate(r));
let fails = 0, checks = 0;
function ok(c, msg) { checks++; if (!c) { fails++; console.log('  FAIL ' + msg); } }

let NID = 1;
class Node {      // the slice of THREE.Object3D / Group / Mesh that dm-facilities touches on the mansion path
  constructor(name) { this.id = NID++; this.name = name || ''; this.children = []; this.parent = null; this.visible = true; this.userData = {}; this.position = { set() { } }; this.rotation = { y: 0 }; }
  add(o) { o.parent = this; this.children.push(o); return this; }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  getObjectByName(n) { let r = null; this.traverse(o => { if (!r && o.name === n) r = o; }); return r; }
  getObjectById(i) { let r = null; this.traverse(o => { if (!r && o.id === i) r = o; }); return r; }
  clone() { const n = new Node(this.name); n.isMesh = this.isMesh; n.geometry = this.geometry; n.material = this.material; for (const c of this.children) n.add(c.clone()); return n; }
  updateMatrixWorld() { }
}
function mockGLB() { const sc = new Node('Scene'); for (const nm of ['Mansion_LOD0', 'Mansion_LOD1']) { const g = new Node(nm), m = new Node(nm + '_m'); m.isMesh = true; m.geometry = { boundingSphere: null, computeBoundingSphere() { this.boundingSphere = {}; } }; m.material = { name: 'ah_slate' }; g.add(m); sc.add(g); } return { scene: sc }; }

// one fresh page: new vm context, both scripts loaded, fake clock + timers; sysBusy is a function of the fake clock so the test controls exactly how long it stays held
function world(o) {
  const W = { now: 1000, timers: [], seq: 0, busyUntil: 0, glbCalls: [], glbAt: null, placeAt: null, log: [], landed: null };
  const sb = { console, Math, Int16Array, Float64Array, Set, Map, Promise, Array, Object, JSON, Date, Error, atob: s => Buffer.from(s, 'base64').toString('binary'), document: {}, CustomEvent: function () { } };
  sb.window = sb; sb.globalThis = sb;
  sb.performance = { now: () => W.now };
  sb.setTimeout = (fn, ms) => { W.timers.push({ at: W.now + (ms || 0), fn, n: W.seq++ }); return W.seq; };
  sb.requestAnimationFrame = fn => sb.setTimeout(fn, 16);
  sb.fetch = u => Promise.resolve({ ok: true, json: () => Promise.resolve(COL) });
  sb.dispatchEvent = () => { };
  W.sb = sb;
  const busy = () => W.now < W.busyUntil;
  const scene = new Node('PWscene'), st = { pos: { set(x, y, z) { st.p = [x, y, z]; } }, vel: { set() { } }, yaw: 0, pitch: 0, landing: false };
  const PW = { active: !!o.pwActive, opening: false, scene: o.pwActive ? scene : null, body: o.pwActive ? { name: 'Solenne' } : null, renderer: { compileAsync: () => new Promise(res => sb.setTimeout(res, 400)) }, camera: {} };
  W.scene = scene; W.PW = PW; W.st = st;
  const sys = { gal: o.gal, name: o.sys };
  const ctxA = {
    celestialBodies: [{ name: 'Solenne', mesh: {} }], closeQuickTravel() { }, toast() { }, GALAXY_DB: { current: sys.gal },
    curGalaxy: () => sys.gal, curSysName: () => sys.name, PW, atmoActive: !!o.pwActive, surfaceActive: false, flightInited: true,
    get sysBusy() { return busy(); },
    fastTravelToSystem(system, gal) { sys.gal = gal; sys.name = 'Veyra'; W.busyUntil = W.now + o.busyTicks * 600; W.log.push('rebuild@' + W.now); },
    enterAtmosphericFlight(b, p) { W.log.push('enter@' + W.now + (busy() ? ' BUSY' : '')); PW.active = true; PW.scene = scene; PW.body = { name: b.name }; if (o.rebuildAtLand) W.busyUntil = W.now + o.rebuildAtLand * 600; },
  };
  const ctxF = {
    THREE: { Group: Node }, PW: () => PW, TERRAIN: () => ({ H: () => 0 }), atmoState: () => st, atmoXZ: () => ({ x: -120, z: 0 }), mapTag() { },
    curSysName: () => sys.name, get sysBusy() { return busy(); }, shadows: () => false, isMobile: () => false, tier: () => 0,
    loadGLB(u) { W.glbCalls.push(u); if (W.glbAt === null) W.glbAt = W.now; W.glbBusy = busy(); return new Promise(res => sb.setTimeout(() => res(mockGLB()), 700)); },     // 700 ms network + parse
    afterTeleport(land) { W.landed = { land, at: W.now }; },
  };
  vm.runInNewContext(SRC_F, sb, { filename: 'dm-facilities.js' });
  vm.runInNewContext(SRC_A, sb, { filename: 'dm-arielhome.js' });
  sb.DMFac.bind(ctxF); sb.DMArielHome.bind(ctxA);
  { const L = sb.DMArielHome.SITES, keep = L.filter(x => x.id === 'home-mansion'); L.splice(0, L.length, ...keep); }     // only the mansion: the ocean city builds canvas textures
  sb.DMFac.baseH = (x, z) => (x <= 0 ? 62 : -10);        // plateau 62 m over a sea to the east: the mansion's coast search finds a spot
  W.F = sb.DMFac; W.A = sb.DMArielHome; W.DM = sb.window.DM_FAC; W.ctxF = ctxF; W.busy = busy;
  // the real placement hook: record when place() put the mansion into the scene
  const add = scene.add.bind(scene); scene.add = o2 => { if (o2.name === 'JOTS_ArielMansion' && W.placeAt === null) { W.placeAt = W.now; W.placeBusy = busy(); } return add(o2); };
  return W;
}
// advance the fake clock in 100 ms frames: due timers fire (pollLand, GLB, compile), then DMFac.tick runs like the game's frame hook
async function run(W, ms, until) {
  const end = W.now + ms;
  while (W.now < end) {
    W.now += 100;
    W.timers.sort((a, b) => a.at - b.at || a.n - b.n);
    while (W.timers.length && W.timers[0].at <= W.now) W.timers.shift().fn();
    await tick();
    if (W.PW.active) W.F.tick(0.1, { x: -120, y: 90, z: 0 }, 'flight');
    await tick();
    if (until && until()) return true;
  }
  return false;
}
const done = W => W.landed !== null && W.DM.arriveAt == null;

async function caseA(N, again) {
  const tag = 'A (HOME from space during a system switch, sysBusy held ' + N + ' ticks' + (again ? ' + ' + again + ' after the landing opens the world' : '') + ')';
  const W = world({ pwActive: false, gal: 'milkyway', sys: 'Sol', busyTicks: N, rebuildAtLand: again });
  W.A.homeNow();
  ok(W.log.length === 1 && /^rebuild/.test(W.log[0]), tag + ': system switch started');
  const reached = await run(W, (N + again + 60) * 600 + 60000, () => done(W));
  const hold = W.busyUntil;
  ok(reached, tag + ': deck landing reached (afterTeleport called, arriveAt cleared)');
  ok(W.landed && W.landed.land === true, tag + ': landed on the deck (afterTeleport(land=true))');
  ok(W.DM.arriveAt == null && W.DM.homeDeck === false, tag + ': arriveAt cleared and homeDeck consumed (arriveAt=' + W.DM.arriveAt + ')');
  ok(!/BUSY/.test(W.log.join(' ')), tag + ': the world opened only after the rebuild released sysBusy (' + W.log.join(', ') + ')');
  if (again) {
    ok(W.glbAt !== null && W.glbBusy === true, tag + ': MAN.glb fetch + parse started WHILE sysBusy was held (not waiting for the rebuild)');
    ok(W.placeAt !== null && W.placeBusy === false, tag + ': place() (scene add) waited for the rebuild to finish');
    ok(W.landed && W.landed.at >= hold, tag + ': teleport happened after the rebuild released');
  }
  ok(W.glbCalls.length === 1, tag + ': the mansion GLB is fetched exactly once (' + W.glbCalls.length + ')');
  ok(W.st.p && W.st.p.every(Number.isFinite), tag + ': deck position is finite');
}
async function caseB(N) {
  const tag = 'B (HOME after a cold reload, boot rebuild holds sysBusy ' + N + ' ticks)';
  const W = world({ pwActive: true, gal: 'lumenreach', sys: 'Veyra', busyTicks: 0 });
  W.busyUntil = W.now + N * 600;                      // the boot system rebuild is running when the page comes up in Solenne's sky
  ok(!W.F.sites.size && W.glbCalls.length === 0, tag + ': cold: nothing loaded');
  W.A.homeNow();                                      // onHome + atmoActive: arriveAt is set directly, no pollLand
  ok(W.DM.arriveAt === 'home-mansion' && W.DM.homeDeck === true, tag + ': HOME queued the deck arrival');
  const reached = await run(W, (N + 60) * 600 + 60000, () => done(W));
  ok(reached, tag + ': deck landing reached (afterTeleport called, arriveAt cleared)');
  ok(W.landed && W.landed.land === true, tag + ': landed on the deck (afterTeleport(land=true))');
  ok(W.DM.arriveAt == null && W.DM.homeDeck === false, tag + ': arriveAt cleared and homeDeck consumed (arriveAt=' + W.DM.arriveAt + ')');
  ok(W.glbAt !== null && W.glbAt < W.busyUntil && W.glbBusy === true, tag + ': MAN.glb fetch + parse started WHILE sysBusy was held (at ' + W.glbAt + ' < ' + W.busyUntil + ')');
  ok(W.placeAt !== null && W.placeBusy === false && W.placeAt >= W.busyUntil, tag + ': place() (scene add) waited for the rebuild to finish');
  ok(W.landed && W.landed.at >= W.busyUntil, tag + ': teleport happened after the rebuild released');
  ok(W.glbCalls.length === 1, tag + ': the mansion GLB is fetched exactly once (' + W.glbCalls.length + ')');
  ok(W.st.p && W.st.p.every(Number.isFinite), tag + ': deck position is finite');
}
(async () => {
  for (const [n, again] of [[2, 0], [50, 40], [300, 100]]) { console.log('case A N=' + n + ' again=' + again); await caseA(n, again); }
  for (const n of [1, 40, 300]) { console.log('case B N=' + n); await caseB(n); }
  console.log(fails ? fails + ' FAILED of ' + checks : 'ok: ' + checks + '/' + checks + ' checks');
  process.exit(fails ? 1 : 0);
})();
