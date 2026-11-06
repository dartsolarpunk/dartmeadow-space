// node tools/tests/landing-safe.js — the vanishing-rider fix: landing on a lamp / prop. Extracts the REAL _landSafe / _landSteer / _surfPlaceAt / _surfInSolid /
// _boardUnstick / _landForce / _landWatchTick / _riderEvent from index.html and drives them against the real DMCollide with lamp poles, props and water:
//   1. landing target search around lamps and a prop ring (both her capsule and the board footprint are clear at the result)
//   2. steering while landing (re-validated) ends on a clear spot, 3. a stalled landing is force-completed (timeout / touchdown / non-finite) and logged
//   4. on foot: non-finite / sunk / inside-a-lamp rider is repaired, stuck transition cleared, 5. park / summon state recovery
'use strict';
const fs = require('fs'), vm = require('vm');
globalThis.window = globalThis; globalThis.location = { search: '' };
require('../../ui/dm-collide.js'); require('../../ui/dm-collide-game.js'); const W = globalThis.DMCollide;
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const src = fs.readFileSync(__dirname + '/../../index.html', 'utf8');
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } clone() { return new V3(this.x, this.y, this.z); } }
const mkObj = () => ({ parent: null, visible: true, position: new V3(), scale: { x: 1, setScalar(a) { this.x = a; }, set(a) { this.x = a; } }, rotation: { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } } });
let clock = 1000; const events = [];
const scene = { children: [], add(o) { if (o.parent) o.parent.remove(o); o.parent = this; this.children.push(o); }, remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; } };
const ctx = { console, Math, isFinite, window: { DMCollide: W, DMLandZones: require('../../ui/dm-landzones.js'), DMCrumb: { mark: (a, b) => events.push([a, b]) }, dmPerfLog: { event: (a, b) => events.push([a, b]) } }, document: { hidden: false }, performance: { now: () => clock }, THREE: { Vector3: V3 }, setInterval: () => 0, toast() { }, setCharState() { }, _forceCharVisible() { },
  SURF_BOARD_SIDE: 1.5, SURF_BOARD_WAIST: 1, CHAR_MOUNT_YAW_OFFSET: 0, CHAR_TERRAIN_YAW_EXTRA: 0, _surfBoardDims: () => ({ half: 1.5, halfW: 0.4 }), _terrainBoardSideWorld: () => 1.2, _surfBoardSide: () => 1.5 };
ctx.PW = { active: true, body: {}, site: {}, scene, board: mkObj(), pal: { grav: 9 }, camera: { position: new V3() } }; scene.add(ctx.PW.board);
ctx.CHAR = { loaded: true, root: mkObj(), _transitioning: false, mounted: true, feetOffset: 0, scaleForTerrain: 1 };
ctx.BOARD_CALL = { parked: false, parkPos: null, parkLocal: null, summon: null, summonAt: 0 }; ctx._boardCallReset = () => { const T = ctx.BOARD_CALL; T.parked = false; T.parkPos = null; T.parkLocal = null; T.summon = null; T.summonAt = 0; ctx.__reset = (ctx.__reset || 0) + 1; };
const entered = []; ctx.enterSurface = (b, s, o) => { entered.push(o); ctx.surfaceActive = true; };
// ground: flat, a lake at z < -200, a steep wall at x > 400
ctx._surfHeight = (x, z) => (x > 400 ? (x - 400) * 2 : 0); ctx._atmoHeight = ctx._surfHeight; W.setGround(ctx._surfHeight); W.setWater((x, z) => (z < -200 ? 3 : -1e9), null);
ctx.DMCrumb = ctx.window.DMCrumb; ctx.dmPerfLog = ctx.window.dmPerfLog;
vm.createContext(ctx);
vm.runInContext(['_riderEvent', '_landSafe', '_surfPlaceAt', '_surfInSolid', '_landSteer', '_boardUnstick', '_landForce', '_landWatchTick'].map(fn).join('\n') + '\nlet _riderFixN=0,_landTok=0,_landWd={sink:0,stuck:0,trans:0,tdAt:0}; let surfaceActive=false,atmoActive=false,atmoState=null,surfPlayer=null,surfBoard=null,atmoBoard=null;', ctx);
const run = c => vm.runInContext(c, ctx);
const lamp = (x, z) => { W.addCylinder('lamps', x, 0, 7.8, z, 0.27, 'metal'); W.addBox('lamps', x, 0.27, z, 0.8, 0.27, 0.8, 0, 'stone'); };
const lampAt = [[100, 100], [100, 103], [104, 100], [96, 100], [100, 97]];   // a lamp with more lamps near it
lampAt.forEach(l => lamp(l[0], l[1]));
const flat = (x, z) => 0;
// 1 ─ target search
{ const b = ctx.PW.board; ctx.atmoBoard = null; run('atmoBoard=PW.board');
  b.position.set(100, 6, 100);
  const r = run('_landSafe(100,100,0)'); ok(r.ok && r.moved, 'landing on a lamp finds another spot (moved ' + r.dist.toFixed(1) + ' m, ' + r.tried + ' probes)');
  ok(W.pushOut(r.hx, 0, r.hz, 0.7, 3.1, 0.6, [0, 0]) < 1e-3, 'her capsule at the result is clear of every lamp');
  let hit = 0; for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) if (W.sphereOut(r.x + j * 0.4, 0.7, r.z + i * 0.75, 0.4) > 0.02) hit++; ok(hit === 0, 'and so is the board footprint');
  const r0 = run('_landSafe(300,300,0)'); ok(r0.ok && !r0.moved && r0.x === 300, 'open ground is left alone');
  const rw = run('_landSafe(100,-210,0)'); ok(rw.ok && rw.moved && rw.z >= -200.01, 'a landing over the lake moves to the shore (z ' + rw.z.toFixed(1) + ')');
  const rs = run('_landSafe(415,100,0)'); ok(rs.ok && rs.moved && rs.x < 405, 'a landing on the steep wall moves to gentle ground (x ' + rs.x.toFixed(1) + ')');
  const rh = run('_landSafe(100,100,0,{her:true})'); ok(rh.ok && rh.moved, 'starting from her own spot works too'); }
// 1b ─ near the mansion the planned landing pads win over a random clear patch
{ const Zr = ctx.window.DMLandZones; Zr.set([{ x: 125, y: 100, z: 0, r: 8, kind: 'deck', patch: 1, app: 8 }], (x, y, zz, o) => { o[0] = x; o[1] = zz; o[2] = y; }, 1);
  const r = run('_landSafe(100,100,0)'); ok(r.ok && r.zone === 'deck' && Math.abs(r.x - 125) < 1e-6, 'a blocked landing next to the mansion goes to the free deck pad (' + r.x.toFixed(1) + ',' + r.z.toFixed(1) + ')');
  Zr.set([{ x: 100, y: 100, z: 0, r: 8, kind: 'deck', patch: 1, app: 8 }], (x, y, zz, o) => { o[0] = x; o[1] = zz; o[2] = y; }, 1); const r2 = run('_landSafe(100,100,0)'); ok(r2.ok && !r2.zone && (r2.x !== 100 || r2.z !== 100), 'a pad that is itself blocked is skipped'); Zr.clear(); }
// 2 ─ steering while landing re-validates and ends clear
{ const s = { pos: new V3(100, 6, 100), yaw: 0, landing: true, vel: new V3() }; ctx.__s = s; clock = 5000;
  for (let i = 0; i < 90; i++) { clock += 66; run('_landSteer(__s,1/15)'); }
  ok(!!s.landT0, 'landing timer started'); const r = run('_landSafe(__s.pos.x,__s.pos.z,0)'); ok(r.ok && !r.moved, 'after steering the board sits on a clear footprint (' + s.pos.x.toFixed(1) + ',' + s.pos.z.toFixed(1) + ')'); }
// 3 ─ a stalled landing is force-completed, logged, controls restored
{ ctx.atmoActive = true; run('atmoActive=true'); run('surfaceActive=false'); entered.length = 0; events.length = 0; ctx.CHAR._transitioning = true; ctx.CHAR.mounted = true; ctx.CHAR.root.parent = null;
  run('atmoState={pos:new THREE.Vector3(100,6,100),yaw:0,landing:true,touchdown:false,landT0:1000}'); clock = 40000; run('_landWatchTick()');
  ok(entered.length === 1 && entered[0].inPlace, 'timeout: the hand-over to walking was forced'); ok(!ctx.CHAR._transitioning, 'the transition flag is released'); ok(ctx.CHAR.root.parent === scene && !ctx.CHAR.mounted, 'she is standing in the world scene, not on the board');
  const p = ctx.CHAR.root.position; ok(W.pushOut(p.x, 0, p.z, 0.7, 3.1, 0.6, [0, 0]) < 1e-3, 'at a spot clear of the lamps'); ok(events.some(e => e[0] === 'riderFix' && /landForce:timeout/.test(e[1].why)), 'logged as riderFix landForce:timeout');
  run('surfaceActive=false;atmoState={pos:new THREE.Vector3(100,6,100),yaw:0,landing:true,touchdown:true,landT0:39000}'); entered.length = 0; clock = 41000; run('_landWatchTick()'); clock = 49000; run('_landWatchTick()'); ok(entered.length === 1, 'touchdown that never finishes is forced after 7 s');
  run('surfaceActive=false;atmoState={pos:new THREE.Vector3(NaN,6,100),yaw:0,landing:false,touchdown:false}'); entered.length = 0; run('_landWatchTick()'); ok(entered.length === 1, 'a non-finite board position is forced down'); }
// 4 ─ on foot: repair
{ run('atmoActive=false;atmoState=null;surfaceActive=true;surfBoard=PW.board;surfPlayer={pos:new THREE.Vector3(200,3,200),vel:new THREE.Vector3(),yaw:0,onGround:true,jumpActive:false}'); events.length = 0; ctx.CHAR.root.parent = scene;
  run('surfPlayer.pos.set(NaN,3,200)'); run('_landWatchTick()'); ok(isFinite(run('surfPlayer.pos.x+surfPlayer.pos.y+surfPlayer.pos.z')), 'non-finite rider position repaired'); ok(events.some(e => /surfRepair/.test(e[1].why)), 'logged surfRepair');
  run('surfPlayer.pos.set(200,-300,200)'); run('_landWatchTick()'); ok(run('surfPlayer.pos.y') > 0, 'rider that fell under the terrain is put back (y ' + run('surfPlayer.pos.y').toFixed(1) + ')');
  run('surfPlayer.pos.set(100,3,100)'); ok(run('_surfInSolid()'), 'standing inside a lamp pole is detected'); events.length = 0; for (let i = 0; i < 3; i++) run('_landWatchTick()');
  ok(!run('_surfInSolid()'), 'and she is moved out after ~1.5 s'); ok(events.some(e => /landUnstick/.test(e[1].why)), 'logged landUnstick');
  ctx.CHAR._transitioning = true; clock += 100; run('_landWatchTick()'); clock += 10000; run('_landWatchTick()'); ok(!ctx.CHAR._transitioning, 'a transition stuck > 9 s is released'); }
// 5 ─ park / summon state recovery
{ run('surfaceActive=true;surfBoard=PW.board;surfPlayer={pos:new THREE.Vector3(300,3,300),vel:new THREE.Vector3(),yaw:0,onGround:true}'); const T = ctx.BOARD_CALL; ctx.__reset = 0;
  T.parked = true; T.parkPos = new V3(NaN, 0, 0); run('_landWatchTick()'); ok(!T.parked && ctx.__reset >= 1, 'a park with a lost position is reset (park + summon available again)');
  T.summon = { t: 0 }; T.summonAt = clock - 25000; run('_landWatchTick()'); ok(T.summon === null, 'a summon that never arrives is reset');
  run('surfBoard=null'); run('_landWatchTick()'); ok(run('!!surfBoard'), 'a missing surfBoard is rebuilt so BOARD_CALL has a context again');
  run('surfBoard=PW.board'); const b = ctx.PW.board; b.position.set(100, 0.6, 100); b.rotation.y = 0; ok(run('_boardUnstick(PW.board)') && !(b.position.x === 100 && b.position.z === 100), 'a board ending inside a lamp slides to a clear footprint'); }
console.log(fails ? fails + ' FAILED of ' + n : 'landing-safe: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
