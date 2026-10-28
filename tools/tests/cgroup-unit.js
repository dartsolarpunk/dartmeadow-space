// node tools/tests/cgroup-unit.js  — unit test for ui/dm-cgroup.js (pure numbers, no THREE)
const G = require('../../ui/dm-cgroup.js'); const assert = require('assert');
const surf = (x, z) => 3 + 0.8 * Math.sin(x * 0.7) * Math.cos(z * 0.5) + 0.05 * Math.sin(x * 9);
let calls = 0; G.setSurface('t', (x, z) => { calls++; return surf(x, z); });
const pos = { x: 0, y: 4, z: 0 };
G.registerMember('char', { res: 0.27, bound: (o) => { o[0] = pos.x; o[1] = pos.y; o[2] = pos.z; o[3] = 1.6; return true; } });
G.registerMember('board', { res: () => 0.4, bound: (o) => { o[0] = pos.x + 0.5; o[1] = pos.y - 1; o[2] = pos.z; o[3] = 1.4; return true; },
  caps: (o, max, at) => { const q = at * 7; o[q] = pos.x - 1; o[q + 1] = pos.y - 1; o[q + 2] = pos.z; o[q + 3] = pos.x + 1; o[q + 4] = pos.y - 1; o[q + 5] = pos.z; o[q + 6] = 0.1; return 1; } });
G.registerMember('hair', { res: 0.02, bound: (o) => { o[0] = pos.x; o[1] = pos.y + 1; o[2] = pos.z; o[3] = 0.5; return true; } });
let maxS = 0, errMax = 0, notReady = 0;
for (let f = 0; f < 600; f++) {
  pos.x += 0.05; pos.z += 0.02 * Math.sin(f * 0.05);       // walking
  G.update(1 / 60);
  maxS = Math.max(maxS, G.stats().samplesFrame);
  if (f > 30) { const e = Math.abs(G.groundAt(pos.x, pos.z, NaN) - surf(pos.x, pos.z)); if (e === e) errMax = Math.max(errMax, e); else notReady++; }
}
const st = G.stats(); console.log(JSON.stringify(st), 'maxSamplesFrame', maxS, 'err', errMax.toFixed(4), 'uncovered', notReady, 'calls', calls);
assert(st.members === 3 && st.ready, 'ready');
assert(maxS <= 48 * 1.5 + 2, 'budget respected');
assert(errMax < 0.06, 'height error vs true surface (cell ' + st.cell + ')');
assert(st.limitedBy === 'budget' || st.limitedBy === 'hair', 'finest member / budget cap: ' + st.limitedBy);
assert(notReady < 5, 'patch keeps covering the group while it moves');
// ring-buffer reuse: moving one cell should cost O(N) samples, not O(N^2)
const c0 = calls; pos.x += st.cell * 1.01; G.update(1 / 60); G.update(1 / 60); assert(calls - c0 <= 2 * 48 * 1.5 + 4, 'incremental scroll ' + (calls - c0));
// intensity API
G.setContext('swim'); for (let i = 0; i < 120; i++) G.update(1 / 60); const iSw = G.intensity; assert(iSw > 1.4, 'swim intensity ' + iSw);
G.boost('fluid', 2, 0.5); for (let i = 0; i < 60; i++) G.update(1 / 60); assert(G.intensity > iSw, 'boost raises'); for (let i = 0; i < 120; i++) G.update(1 / 60); assert(Math.abs(G.intensity - iSw) < 0.1, 'boost expires');
G.setContext('walk'); for (let i = 0; i < 200; i++) G.update(1 / 60); assert(Math.abs(G.intensity - 1) < 0.05, 'walk back to 1');
// collide: sphere sunk into the ground, and into the board capsule
const gy = G.groundAt(pos.x, pos.z, NaN); let o = G.collideSphere(pos.x, gy - 0.05, pos.z, 0.1); assert(o && o.depth > 0.1 && o.src === 'ground' && o.ny > 0.5, 'ground collide');
o = G.collideSphere(pos.x, pos.y - 1 + 0.12, pos.z + 0.05, 0.1); assert(o && o.depth > 0, 'capsule collide'); assert(G.collideSphere(pos.x, pos.y + 5, pos.z, 0.1) === null, 'free sphere');
// LOD: a bigger perimeter (flight) rebuilds a coarser patch; the front keeps serving meanwhile
const lod0 = G.lod; G.members[0].bound = (q) => { q[0] = pos.x; q[1] = pos.y; q[2] = pos.z; q[3] = 12; return true; };
for (let i = 0; i < 400; i++) { G.update(1 / 60); } assert(G.lod > lod0 && G.stats().cell > st.cell, 'lod swap ' + JSON.stringify(G.stats()));
console.log('cgroup unit OK', JSON.stringify(G.stats()));
