// node tools/ariel-home/plan_shards.js  ->  assets/ariel-home/cliff/shards.json
// (t1516 Solenne shard cliff) The macro SHARD-ROCK layer of Ariel's cliff: clusters of tall, straight, angular prisms (geode / cave-shard / dogtooth-spar habit,
// built as opaque weathered ROCK: the cliff's own ah_rockc / ah_rockt PBR sets, no crystal, no emissive) standing in the sea at the foot of the face and leaning
// into it, a skirt of half-drowned angular blocks along the GLB's seaward edge (hides the seam where the GLB's sea floor meets the generated sea floor) and outcrops
// over both flank seams (snapped to the generated ground at runtime).  The GLB's own shards are +-2.6 u of relief on a 400 x 120 u wall: flat beyond ~300 m.
// These are 8-60 u tall, so the silhouette stays angular at LOD1 distance.  Deterministic (fixed seed), mansion frame (bx along the wall, by seaward = -glTF z,
// heights relative to the plateau / y0), checked against the house: no prism within 3 u of any non-rock triangle (decks, piers, stairs, pools, glass) and every
// prism top >= 4 u under the cliff lip, so nothing touches a walkable deck or the HOME pad.  Runtime: ui/dm-facilities.js shardGeo() (flat-shaded, ~3-4k tris).
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const { load } = require(path.join(root, 'tools/tests/lib-glb-node.js'));
const COL = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-collide.json'), 'utf8'));
const raw = Buffer.from(COL.data, 'base64'), GH = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
const NX = COL.nx, NY = COL.ny, CELL = COL.cell, SEA = COL.sea;
const gi = bx => Math.max(0, Math.min(NX - 1, Math.round((bx - COL.x0) / CELL))), gj = by => Math.max(0, Math.min(NY - 1, Math.round((by - COL.y0) / CELL)));
const grid = (bx, by) => GH[gj(by) * NX + gi(bx)] / COL.scale;
let s = 0x5a17c1ff; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const U = (a, b) => a + (b - a) * rnd();
// house occupancy: every non-rock triangle of LOD0, rasterised (bbox) into the collision grid as [ymin, ymax]
const OMIN = new Float32Array(NX * NY).fill(1e9), OMAX = new Float32Array(NX * NY).fill(-1e9);
const glb = load(path.join(root, 'assets/ariel-home/ariel-home.glb'));
const lod0 = glb.root.getObjectByName('Mansion_LOD0');
lod0.traverse(m => {
  if (!m.isMesh || /^ah_rock/.test(m.material.name)) return;
  const P = m.geometry.attributes.position, I = m.geometry.index, n = I ? I.count : P.count;
  for (let t = 0; t < n; t += 3) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (let k = 0; k < 3; k++) { const v = I ? I.getX(t + k) : t + k, x = P.getX(v), y = P.getY(v), by = -P.getZ(v); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); b0 = Math.min(b0, by); b1 = Math.max(b1, by); }
    for (let i = gi(x0); i <= gi(x1); i++) for (let j = gj(b0); j <= gj(b1); j++) { const q = j * NX + i; if (y0 < OMIN[q]) OMIN[q] = y0; if (y1 > OMAX[q]) OMAX[q] = y1; }
  }
});
function houseCap(bx, by, r, base) {   // highest allowed top for a prism here (Infinity = free)
  let cap = Infinity; const R = r + 3;
  for (let i = gi(bx - R); i <= gi(bx + R); i++) for (let j = gj(by - R); j <= gj(by + R); j++) { const q = j * NX + i; if (OMAX[q] > base - 1 && OMIN[q] < 1e8) cap = Math.min(cap, OMIN[q] - 2); }
  return cap;
}
// the face, per column: lip (last plateau cell before the drop), its height, the foot (first GLB sea cell)
function face(bx) {
  let lipBy = null, lipH = -1e9, footBy = null;
  for (let by = -20; by <= 120; by += CELL) { if (grid(bx, by) < SEA + 20) { lipBy = by; break; } }
  if (lipBy === null) return null;
  for (let by = lipBy - 16; by < lipBy; by += CELL) lipH = Math.max(lipH, grid(bx, by));
  for (let by = lipBy; by <= 120; by += CELL) if (grid(bx, by) <= SEA + 0.6) { footBy = by; break; }
  if (footBy === null) footBy = Math.min(118, lipBy + 20);
  return { lipBy, lipH, footBy };
}
const shards = [];   // [bx, by, base, height, radius, sides, rot, leanX, leanY, apexK, apexX, apexY, mat, tone, ground]
const push = (o) => shards.push([o.bx, o.by, o.base, o.h, o.r, o.n, o.rot, o.lx, o.ly, o.ak, o.ax, o.ay, o.mat, o.tone, o.g || 0].map(v => typeof v === 'number' ? Math.round(v * 100) / 100 : v));
let rejected = 0;
// (1) face clusters: tall prisms in the sea at the foot, leaning into the wall
for (let bc = -194 + U(0, 6); bc <= 194; bc += U(11, 19)) {
  const F0 = face(bc); if (!F0) continue;
  const n = 3 + Math.floor(rnd() * 5);
  for (let k = 0; k < n; k++) {
    const bx = bc + U(-7, 7), F = face(bx) || F0, by = Math.min(118, F.footBy + U(-5, 11)), fl = grid(bx, by);
    const base = Math.min(fl, SEA + 2) - 5, faceTop = F.lipH - 4;
    let h = (faceTop - base) * (k === 0 ? U(0.62, 0.92) : U(0.28, 0.8)), r = U(2.2, 5.6) * (h > 40 ? 1.15 : 1);
    const cap = houseCap(bx, by, r, base); if (base + h > cap) h = cap - base;
    if (h < 9) { rejected++; continue; }
    push({ bx, by, base, h, r, n: rnd() < 0.55 ? 6 : 5, rot: U(0, 6.283), lx: U(-0.05, 0.05) * h, ly: -U(0.02, 0.14) * h, ak: U(0.1, 0.3), ax: U(-0.45, 0.45), ay: U(-0.45, 0.45), mat: 0, tone: U(0.74, 1) });
  }
}
// (2) seaward edge skirt: low, half-drowned angular blocks over the seam between the GLB's sea floor and the generated one
for (let bx = -202 + U(0, 4); bx <= 202; bx += U(6, 11)) {
  const by = 118 + U(-8, 9), base = Math.min(grid(Math.max(-198, Math.min(198, bx)), 118), SEA - 4) - 4, top = SEA + U(-7, 6), r = U(3, 7);
  const h = top - base; if (h < 4) { rejected++; continue; }
  push({ bx, by, base, h, r, n: 5, rot: U(0, 6.283), lx: U(-0.1, 0.1) * h, ly: U(-0.1, 0.1) * h, ak: U(0.3, 0.6), ax: U(-0.7, 0.7), ay: U(-0.7, 0.7), mat: 1, tone: U(0.7, 0.95) });
}
// (3) flank outcrops over both side seams (x = +-200): base / top snapped to the generated ground at runtime (ground = 1: h is the height ABOVE max(GLB, ground))
for (const sd of [-1, 1]) for (let by = -112 + U(0, 6); by <= 116; by += U(8, 14)) {
  const bx = sd * U(193, 214), r = U(3, 7.5), tall = rnd() < 0.35;
  const base0 = grid(sd * 198, by), cap = houseCap(bx, by, r, base0 - 20); if (cap < base0 + 6) { rejected++; continue; }
  push({ bx, by, base: -4, h: tall ? U(9, 22) : U(3, 9), r, n: tall ? 6 : 5, rot: U(0, 6.283), lx: sd * U(0, 0.08), ly: U(-0.06, 0.06), ak: tall ? U(0.15, 0.3) : U(0.35, 0.6), ax: U(-0.6, 0.6), ay: U(-0.6, 0.6), mat: tall ? 0 : 1, tone: U(0.72, 0.98), g: 1 });
}
const tris = shards.reduce((a, q) => a + q[5] * 3, 0);
const out = { version: 1, about: 'Macro shard-rock layer of the Solenne mansion cliff (tools/ariel-home/plan_shards.js). Mansion frame: bx along the wall, by seaward (= -glTF z), heights rel. the plateau (y0). ground=1: base/top follow the generated ground at runtime.',
  fields: ['bx', 'by', 'base', 'height', 'radius', 'sides', 'rot', 'leanX', 'leanY', 'apexK', 'apexX', 'apexY', 'mat(0 ah_rockc, 1 ah_rockt)', 'tone', 'ground'],
  materials: ['ah_rockc', 'ah_rockt'], tileM: 3, sea: SEA, tris, count: shards.length, shards };
fs.writeFileSync(path.join(root, 'assets/ariel-home/cliff/shards.json'), JSON.stringify(out));
console.log('shards', shards.length, 'tris', tris, 'rejected', rejected, 'by kind', [0, 1].map(m => shards.filter(q => q[12] === m).length), 'flank', shards.filter(q => q[14]).length);
