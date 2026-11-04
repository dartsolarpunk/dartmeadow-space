// node tools/tests/rider-watch.js — the rider (Ariel) must stay on the board that is DRAWN. Extracts the real _riderBoard / remountSkyboard /
// _riderProblems / _riderCheck from index.html and drives them against a stub scene graph: enter flight, open a world (sky), late character load,
// resume-from-menu remount, world close, re-enter, recovery boot. No GPU, no DOM.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../../index.html', 'utf8');
function fn(name) { const i = src.indexOf('function ' + name + '('); assert(i >= 0, name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } throw new Error(name); }
const V = (x,y,z) => ({ x, y, z, set(a,b,c){ this.x=a; this.y=b; this.z=c; return this; }, setScalar(a){ return this.set(a,a,a); }, copy(o){ return this.set(o.x,o.y,o.z); } });
const Q = () => ({ x:0,y:0,z:0,w:1, copy(o){ Object.assign(this,o); return this; } });
class O { constructor(n) { this.name = n || ''; this.children = []; this.parent = null; this.visible = true; this.userData = {}; this.position = V(0,0,0); this.scale = V(1,1,1); this.quaternion = Q(); this.matrixWorld = { elements: new Array(16).fill(0) }; }
  add(c) { if (c.parent) c.parent.remove(c); c.parent = this; this.children.push(c); } remove(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } }
  traverse(f) { f(this); this.children.forEach(c => c.traverse(f)); } updateMatrixWorld() {} }
const ctx = { console, setInterval: () => 0, document: { hidden: false }, isFinite, Math, Array, window: {}, STATE: { screen: 'flight', boardConfig: { template: 'A' } }, _glbCache: {}, SKYBOARD_TEMPLATES: { A: 'a.glb' }, GFX: {}, SHIP_WALK: { active: false }, INTRO: { on: false }, flightFP: false, surfaceActive: false };
ctx.PW = { active: false, opening: false, mode: null, board: null, scene: null };
ctx.flightScene = new O('flightScene'); ctx.boardFlight = new O('board'); ctx.flightScene.add(ctx.boardFlight);
const mesh = new O('mesh'); mesh.isMesh = true; mesh.isSkinnedMesh = true; mesh.frustumCulled = false; mesh.material = { visible: true, transparent: false, opacity: 1 };
ctx.CHAR = { loaded: true, root: new O('Scene'), mounted: false, bones: {}, restPose: null, scaleForBoard: 1 }; ctx.CHAR.root.add(mesh);
ctx.CHAR.root.matrixWorld.elements = new Array(16).fill(1);
ctx._charOnTempleDeck = () => false; ctx._forceCharVisible = () => { ctx.CHAR.root.visible = true; ctx.CHAR.root.traverse(o => { if (o.isMesh) { o.visible = true; o.frustumCulled = false; } }); };
ctx.mountSkyboard = b => { b.add(ctx.CHAR.root); ctx.CHAR.root.position.set(0,0,0); ctx.CHAR.root.scale.set(1,1,-1); ctx.CHAR.mounted = true; ctx._forceCharVisible(); };
ctx.buildBoardMesh = () => new O('newBoard'); ctx.disposeObject3D = () => {}; ctx.atmoBoard = null; ctx.surfBoard = null;
const events = []; ctx.window.DMCrumb = { mark: (n, i) => events.push([n, i]) }; ctx.window.dmPerfLog = { event: (n, i) => events.push([n, i]) };
ctx.DMCrumb = ctx.window.DMCrumb; ctx.dmPerfLog = ctx.window.dmPerfLog;
vm.createContext(ctx);
vm.runInContext(['_riderBoard', 'stripCharacterMount', 'remountSkyboard', '_riderProblems', '_riderTemplateReady', '_riderEvent', '_riderCheck'].map(fn).join('\n') + '\nlet _riderFixN=0;', ctx);
const run = c => vm.runInContext(c, ctx);
const C = ctx.CHAR;

// 1. normal space flight: remount -> boardFlight, watchdog quiet
run('remountSkyboard(boardFlight)'); assert.strictEqual(C.root.parent, ctx.boardFlight); assert.strictEqual(run('_riderCheck("t")'), true); assert.strictEqual(events.length, 0);

// 2. a world (sky) opens: she rides ITS board, the space board is hidden
function openSky() { const sc = new O('pwScene'), b = new O('pwBoard'); sc.add(b); ctx.PW.active = true; ctx.PW.mode = 'fly'; ctx.PW.board = b; ctx.PW.scene = sc; ctx.boardFlight.visible = false; ctx.atmoBoard = b; return b; }
let pb = openSky(); run('mountSkyboard(PW.board)');
// 2a. late load / cold-watch / resume-from-menu remount aimed at the (hidden) space board must land on the world board
run('remountSkyboard(boardFlight)'); assert.strictEqual(C.root.parent, pb, 'remount redirected to the world board'); assert.strictEqual(run('_riderCheck("t")'), true);
// 2b. stolen by something else (old behaviour): watchdog puts her back and logs riderFix
ctx.boardFlight.add(C.root); events.length = 0;
assert.strictEqual(run('_riderCheck("test")'), true); assert.strictEqual(C.root.parent, pb); assert(events.some(e => e[0] === 'riderFix'), 'riderFix logged');
// 2c. hidden / culled / transparent / NaN
C.root.visible = false; mesh.visible = false; mesh.frustumCulled = true; mesh.material.opacity = 0; mesh.material.transparent = true;
assert.strictEqual(run('_riderCheck("test")'), true); assert(C.root.visible && mesh.visible && !mesh.frustumCulled && mesh.material.opacity === 1);
C.root.position.x = NaN; assert.strictEqual(run('_riderCheck("test")'), true); assert(isFinite(C.root.position.x));
// 2d. world is still opening: no remount onto the not-yet-built board, nothing stolen
ctx.PW.active = false; ctx.PW.opening = true; ctx.boardFlight.visible = true; run('mountSkyboard(boardFlight)'); assert.strictEqual(run('remountSkyboard(boardFlight)'), false); assert.strictEqual(C.root.parent, ctx.boardFlight);
ctx.PW.opening = false;

// 3. world closes (she is detached first), space board shown again, re-enter flight
openSky(); run('mountSkyboard(PW.board)'); C.root.parent.remove(C.root); ctx.PW.active = false; ctx.PW.mode = null; ctx.PW.board = null; ctx.PW.scene = null; ctx.boardFlight.visible = true; ctx.atmoBoard = null;
run('remountSkyboard(boardFlight)'); assert.strictEqual(C.root.parent, ctx.boardFlight); assert.strictEqual(run('_riderCheck("t")'), true);

// 4. recovery boot: the sky opens BEFORE the character exists, then her load finishes (remount(boardFlight) is what the load does)
C.root.parent.remove(C.root); C.loaded = false; C.mounted = false; pb = openSky();
assert.strictEqual(run('_riderCheck("t")'), true, 'nothing to check while loading'); C.loaded = true;
run('remountSkyboard(boardFlight)'); assert.strictEqual(C.root.parent, pb, 'late load lands on the world board');
// 5. on foot: no board at all, watchdog silent
ctx.PW.mode = 'walk'; events.length = 0; assert.strictEqual(run('_riderCheck("t")'), true); assert.strictEqual(events.length, 0);
// 6. stand-in board swapped once the template arrives
ctx.PW.mode = 'fly'; pb.userData.procFallback = true; ctx._glbCache['a.glb'] = {}; events.length = 0;
run('_riderCheck("tmpl")'); assert.notStrictEqual(ctx.PW.board, pb, 'procedural world board replaced'); assert.strictEqual(C.root.parent, ctx.PW.board);
console.log('rider-watch: all assertions passed');
