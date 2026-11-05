// Headless check of the mansion's DMCollide shell (ui/dm-mansion-collide.js = the exact registration the game makes) against the real LOD0 GLB, in a rotated/offset
// world frame like the game's: every entrance must stay open for the character (r 0.7, h 3.1) AND for a 4.4-high probe (head-clearance margin over her 3.1),
// while the wall right beside each door still blocks.   node tools/tests/mansion-collide-doors.js
'use strict';
globalThis.window = undefined; require('../../ui/dm-collide.js'); const L = globalThis.DMCollideLib;
const path = require('path'), { load } = require('./lib-glb-node.js'), MC = require('../../ui/dm-mansion-collide.js'), P = MC._pure;
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else console.log('  ok   ' + m); };
for (const TH of [0.8, 0, 2.5, 4.0]) {
const PX = 4123.5, PZ = -877.25, Y0 = 311.0, ct = Math.cos(TH), st = Math.sin(TH); console.log('== world yaw ' + TH);
// mansion root placed like ui/dm-facilities.js place(): position (px, y0, pz), rotation.y = th
const base = [ct, 0, -st, 0, 0, 1, 0, 0, st, 0, ct, 0, PX, Y0, PZ, 1];
const toW = (lx, ly) => { const lz = -ly; return [PX + lx * ct + lz * st, PZ - lx * st + lz * ct]; };
const { root } = load(path.join(__dirname, '../../assets/ariel-home/ariel-home.glb'), base), lod0 = root.getObjectByName('Mansion_LOD0');
const W = L.create({ capacity: 8192 });
const meshes = P.prepare(lod0), t0 = Date.now(), nb = W.runGen(W.fromMeshGen('mansion', lod0, P.OPTS, 400));
ok(nb > 800 && nb < P.OPTS.maxBoxes, 'shell registered ' + nb + ' boxes from ' + meshes + ' meshes in ' + (Date.now() - t0) + ' ms (cap ' + P.OPTS.maxBoxes + ')');
// walk a straight local route (lx0,ly0) -> (lx1,ly1) at 14 u/s, 60 Hz; floor f above Y0; h = probe height. returns {x,y of the end in local coords, blocked}
function walk(a, b, f, h) {
  const [x0, z0] = toW(a[0], a[1]), [x1, z1] = toW(b[0], b[1]); const c = W.makeChar({ x: x0, y: Y0 + f, z: z0, h, r: 0.7 }); const len = Math.hypot(x1 - x0, z1 - z0), dt = 1 / 60, v = 14; let d = 0;
  for (let i = 0; i < 4000 && d < len - 0.01; i++) { const s = Math.min(v * dt, len - d); W._dt = dt; const px = c.x, pz = c.z; W.walk(c, (x1 - x0) / len * s, (z1 - z0) / len * s); d += Math.hypot(c.x - px, c.z - pz) < s * 0.3 ? 1e9 : s; if (d >= 1e9) break; }
  return { reached: Math.hypot(c.x - x1, c.z - z1) < 0.3, at: Math.hypot(c.x - x1, c.z - z1) };
}
const DOORS = [   // [name, from (local nav), to, floor]
  ['arrival-court main entrance', [0, -50], [0, -22], 0.6],
  ['east deck door', [52, 8], [52, -12], 0.1],
  ['prow balcony door', [-36, 2.8], [-30.4, 2.2], 0.1],
  ['prow balcony door (inside leg)', [-30.4, 2.2], [-20, 4], 0.1],
  ['hall front door D1 (west deck)', [-54, 6], [-54, -8], 0.6],
  ['prow doorway D2', [0, -8], [0, 12], 0.1],
  ['wing pedestrian door', [-62, -64], [-62, -78], 0.45],
  ['wing garage lane', [-18, -64], [-18, -78], 0.45],
];
for (const [name, a, b, f] of DOORS) {
  const r1 = walk(a, b, f, 3.1), r2 = walk(a, b, f, 4.4), r3 = walk(b, a, f, 3.1);
  ok(r1.reached, name + ': character (h 3.1) walks through ' + (r1.reached ? '' : '(stopped ' + r1.at.toFixed(1) + ' short)'));
  ok(r2.reached, name + ': a 4.4-high probe also fits (door head clearance > 3.1 by a margin)');
  ok(r3.reached, name + ': ... and back out');
}
// the wall right beside each new door still blocks (the shell is real, not empty)
for (const [name, a, b, f] of [['court rear wall', [-14, -50], [-14, -22], 0.6], ['hall front glass beside the east door', [40, 8], [40, -12], 0.1], ['prow glass beside the balcony door', [-40, 10], [-20, 10], 0.1]]) {
  const r = walk(a, b, f, 3.1); ok(!r.reached, name + ' blocks the character (stopped ' + r.at.toFixed(1) + ' short)');
}
}
console.log(fails ? "FAILED " + fails + "/" + n : "OK " + n + "/" + n + " checks"); process.exit(fails ? 1 : 0);
