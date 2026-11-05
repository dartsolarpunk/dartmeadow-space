// node tools/tests/collide-glue.js — ui/dm-collide-game.js against a stub scene: chunk registration is time-sliced and pooled, surfWalk stops at a registered trunk,
// supportFor lets her stand on a rock, contact events reach listeners, and closing the world frees everything.
'use strict';
globalThis.window = globalThis; globalThis.location = { search: '' };
require('../../ui/dm-collide.js'); require('../../ui/dm-collide-game.js'); const W = globalThis.DMCollide;
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
function inst(count, fill) { const a = new Float32Array(16 * 64); for (let k = 0; k < 64; k++) { const o = k * 16; a[o + 15] = 1; if (k < count) fill(k, a, o); } return { isInstancedMesh: true, count: 64, instanceMatrix: { array: a }, userData: {} }; }
const rocks = inst(40, (k, a, o) => { a[o] = a[o + 5] = a[o + 10] = 1.2; a[o + 12] = 10 + k * 7; a[o + 13] = 0.4; a[o + 14] = 20; }); rocks.userData.col = { kind: 'ellipsoid', mat: 'rock', k: 0.92, ky: 0.92 };
const trunks = inst(20, (k, a, o) => { a[o] = a[o + 10] = 0.2; a[o + 5] = 3; a[o + 12] = 5 + k * 9; a[o + 13] = 1.5; a[o + 14] = -30; }); trunks.userData.col = { kind: 'cyl', mat: 'wood', k: 0.9, hy: 0.5 };
const grp = { traverse(f) { f(rocks); f(trunks); } };
W.regChunk('chunk#0_0', grp); ok(W.pendingJobs() === 1, 'queued'); let frames = 0; while (W.pendingJobs() && frames < 100) { W.tick(1 / 15, {}); frames++; } ok(W.count() === 60, 'registered 60 colliders (' + W.count() + ')'); console.log('registered over', frames, 'tick(s)');
const p = { pos: { x: 0, y: 3, z: -30 }, onGround: true, _floating: false };
for (let i = 0; i < 40; i++) W.surfWalk(p, 2, 0, 1 / 15); ok(p.pos.x < 5 - 0.9 + 0.02, 'stopped by the first trunk at run speed / 15 fps (x ' + p.pos.x.toFixed(2) + ')');
const q = { pos: { x: 10, y: 3 + 0.9 + 0.2, z: 20 }, onGround: false }; ok(Math.abs(W.supportFor(q, 0.9 + 0.2 - 0.0) - (0.4 + 1.2 * 0.92)) < 0.01, 'stands on rock top');
const ev = []; W.on(e => ev.push(e.type + ':' + e.fx)); W.addBox('t', 0, 0, 0, 20, 1, 20, 0, 'metal'); const b = W.addBody({ x: 0, y: 5, z: 0, r: 0.3, mat: 'metal' }); for (let i = 0; i < 60; i++) W.tick(1 / 15, {}); ok(ev.indexOf('impact:spark') >= 0, 'impact reaches listeners with the spark fx tag (' + ev.slice(0, 3) + ')');
W.dropChunk('chunk#0_0'); ok(W.groupCount('chunk#0_0') === 0 && W.count() === 1, 'dropChunk unregisters'); W.closeWorld(); ok(W.count() === 0 && W.stats.bodies === 0, 'closeWorld frees everything');
console.log(fails ? fails + ' FAILED of ' + n : 'collide-glue: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
