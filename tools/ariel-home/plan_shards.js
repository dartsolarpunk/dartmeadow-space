// node tools/ariel-home/plan_shards.js  ->  assets/ariel-home/cliff/shards.json
// (t1516 Solenne shard cliff, tone follow-up) Macro SHARD-ROCK layer of Ariel's cliff: clusters of angular
// prisms of opaque weathered rock (the cliff's own ah_rockc / ah_rockt PBR sets, no crystal, no emissive)
// standing in the sea at the foot of the face and leaning into it, a skirt of half-drowned angular blocks
// along the GLB's seaward edge (hides the seam where the GLB's sea floor meets the generated sea floor) and
// outcrops over both flank seams (snapped to the generated ground at runtime).  Tops are cleaved or stepped
// ledges, not pointed pyramids; height:width is capped so nothing is needle-like; every prism touches a
// neighbour in its massif (no lone spires).  The GLB's own shards are +-2.6 u of relief on a 400 x 120 u
// wall: flat beyond ~300 m.  These stay tall enough that the silhouette reads at LOD1, but they are thick
// columns, not spikes.  Deterministic (fixed seed), mansion frame (bx along the wall, by seaward = -glTF z,
// heights relative to the plateau / y0), checked against the house: no prism within 3 u of any non-rock
// triangle (decks, piers, stairs, pools, glass) and every prism top >= 4 u under the cliff lip, so nothing
// touches a walkable deck or the HOME pad.  Runtime: ui/dm-facilities.js F.shardBuild (flat-shaded, half or fewer of the previous 205 shards / 3309 tris).
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
const MAX_SLEND = 3.25, MAX_R = 11, CONTACT = 0.05, TRI_CAP = 1654, COUNT_CAP = 100;   // half of the previous 205 shards / 3309 tris, or fewer
function slim(h, r) {
  if (r < 3.4) r = 3.4;
  if (h > MAX_SLEND * 2 * r) { r = Math.min(MAX_R, h / (2 * MAX_SLEND)); if (h > MAX_SLEND * 2 * r) h = MAX_SLEND * 2 * r; }
  return [h, r];
}
function capStyle() {   // ak < 0.35: cleaved tilted plane (ak = tilt in radii); ak >= 0.35: stepped ledge
  return rnd() < 0.42 ? U(0.38, 0.56) : U(0.12, 0.28);
}
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
const push = (o) => {
  const row = [o.bx, o.by, o.base, o.h, o.r, o.n, o.rot, o.lx, o.ly, o.ak, o.ax, o.ay, o.mat, o.tone, o.g || 0].map(v => typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  if (row[3] > MAX_SLEND * 2 * row[4]) row[3] = Math.floor(MAX_SLEND * 2 * row[4] * 100) / 100;
  shards.push(row);
};
let rejected = 0;
// (1) face massif: one continuous chain of thick columns along the foot, each touching the last, plus a
// leaning companion on some stations.  Fewer, larger prisms so the face reads as one weathered massif,
// not a spray of shards (about half the previous count, or fewer).
for (let prev = null, bc = -194 + U(0, 6); bc <= 194; ) {
  let r = U(5.4, 9.6);
  const F0 = face(bc);
  if (!F0) { bc += 14; continue; }
  const n = 1 + (rnd() < 0.7 ? 1 : 0);   // 1-2 per station: a column, often a touching companion
  const cluster = [];
  for (let k = 0; k < n; k++) {
    let bx, by, rr = k === 0 ? r : U(4.6, 8.2);
    if (k === 0) { bx = bc; by = Math.min(118, F0.footBy + U(-1, 6)); }
    else { if (!cluster.length) { rejected++; continue; } const src = cluster[0]; const d = (src.r + rr) * U(0.62, 0.88); bx = src.bx + U(-0.4, 0.4) * d; by = src.by + U(0.15, 0.85) * d; }
    const F = face(bx) || F0; by = Math.max((F.footBy || F0.footBy) - 3, Math.min(118, by));
    const fl = grid(bx, by), base = Math.min(fl, SEA + 2) - 5, faceTop = F.lipH - 4;
    let h = (faceTop - base) * (k === 0 ? U(0.52, 0.84) : U(0.34, 0.7));
    const sl = slim(h, rr); h = sl[0]; rr = sl[1];
    const cap = houseCap(bx, by, rr, base); if (base + h > cap) { h = cap - base; const s2 = slim(h, rr); h = s2[0]; rr = s2[1]; }
    if (h < 8) { rejected++; continue; }
    const rec = { bx, by, base, h, r: rr, n: rnd() < 0.45 ? 6 : 5, rot: U(0, 6.283), lx: U(-0.04, 0.04) * h, ly: -U(0.02, 0.12) * h, ak: capStyle(), ax: U(-1, 1), ay: U(-1, 1), mat: 0, tone: U(0.88, 1.06) };
    cluster.push(rec); push(rec);
    if (k === 0) prev = rec;
  }
  bc = (cluster[0] ? cluster[0].bx + (cluster[0].r + 6) * U(0.68, 0.9) : bc + 14);
}
// (2) seaward edge skirt: fewer, larger half-drowned blocks over the seam, still packed so neighbours touch
for (let bx = -202 + U(0, 4); bx <= 202; ) {
  let r = U(5.8, 10.2);
  const by = 118 + U(-6, 6), base = Math.min(grid(Math.max(-198, Math.min(198, bx)), 118), SEA - 4) - 4, top = SEA + U(-7, 6);
  let h = top - base; const sl = slim(h, r); h = sl[0]; r = sl[1];
  if (h < 4) { rejected++; bx += 10; continue; }
  const rec = { bx, by, base, h, r, n: 5, rot: U(0, 6.283), lx: U(-0.08, 0.08) * h, ly: U(-0.08, 0.08) * h, ak: capStyle(), ax: U(-1, 1), ay: U(-1, 1), mat: 1, tone: U(0.86, 1.04) };
  push(rec);
  bx = rec.bx + (rec.r + 7) * U(0.72, 0.92);
}
// (3) flank outcrops over both side seams (x = +-200): fewer, larger; base / top snapped to the generated ground at runtime (ground = 1: h is the height ABOVE max(GLB, ground))
for (const sd of [-1, 1]) {
  for (let by = -112 + U(0, 6), prev = null; by <= 116; ) {
    let r = U(5.0, 9.4), tall = rnd() < 0.25, bx = prev ? prev.bx + sd * U(-1.2, 1.2) : sd * U(196, 210);
    const base0 = grid(sd * 198, by), cap = houseCap(bx, by, r, base0 - 20);
    if (cap < base0 + 6) { rejected++; by += U(10, 16); prev = null; continue; }
    let h = tall ? U(8, 15) : U(3.5, 8); const sl = slim(h, r); h = sl[0]; r = sl[1];
    const rec = { bx, by, base: -4, h, r, n: tall ? 6 : 5, rot: U(0, 6.283), lx: sd * U(0, 0.08), ly: U(-0.06, 0.06), ak: capStyle(), ax: U(-1, 1), ay: U(-1, 1), mat: tall ? 0 : 1, tone: U(0.88, 1.06), g: 1 };
    prev = rec; push(rec);
    by = rec.by + (rec.r + 6) * U(0.7, 0.95);
  }
}
function fam(q) { return q[0] < -180 ? -1 : q[0] > 180 ? 1 : 0; }
function touches(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]) <= a[4] + b[4] + CONTACT; }
// pull isolated prisms into their massif, then drop any that still stand alone
for (let iter = 0; iter < 8; iter++) {
  for (let i = 0; i < shards.length; i++) {
    const q = shards[i], f = fam(q);
    let best = -1, bestD = 1e9, touch = false;
    for (let j = 0; j < shards.length; j++) {
      if (j === i || fam(shards[j]) !== f) continue;
      const d = Math.hypot(q[0] - shards[j][0], q[1] - shards[j][1]);
      if (d <= q[4] + shards[j][4] + CONTACT) { touch = true; break; }
      if (d < bestD) { bestD = d; best = j; }
    }
    if (touch || best < 0 || bestD > 28 || bestD < 1e-6) continue;
    const p = shards[best], need = q[4] + p[4] + CONTACT * 0.5, ux = (p[0] - q[0]) / bestD, uy = (p[1] - q[1]) / bestD;
    let nx = p[0] - ux * need, ny = p[1] - uy * need;
    const F = face(nx) || face(q[0]);
    if (f === 0 && F && ny < F.lipBy + 2) ny = Math.max(ny, F.lipBy + 2);
    const cap = houseCap(nx, ny, q[4], q[2]); if (!q[14] && q[2] + q[3] > cap) continue;
    q[0] = Math.round(nx * 100) / 100; q[1] = Math.round(ny * 100) / 100;
  }
}
let removed = 1;
while (removed) {
  removed = 0;
  for (let i = shards.length - 1; i >= 0; i--) {
    const q = shards[i], f = fam(q);
    if (shards.some((p, j) => j !== i && fam(p) === f && touches(q, p))) continue;
    shards.splice(i, 1); rejected++; removed++;
  }
}
let tris = shards.reduce((a, q) => a + q[5] * 3, 0);
// hard cut: drop the shortest skirt/flank leaves until we are at or under half the previous count and tri budget
while (shards.length > COUNT_CAP || tris > TRI_CAP) {
  let pick = -1, bestH = 1e9;
  for (let i = 0; i < shards.length; i++) {
    const q = shards[i]; if (q[3] >= 12 && fam(q) === 0) continue;
    const f = fam(q), others = shards.filter((p, j) => j !== i && fam(p) === f);
    const still = others.length > 0 && others.every((p, _i, arr) => arr.some(o => o !== p && touches(p, o)) || arr.length === 1);
    // only drop a leaf (1 neighbour) or a short prism whose removal leaves the rest in contact
    const nbrs = shards.filter((p, j) => j !== i && fam(p) === f && touches(q, p));
    if (nbrs.length === 1 && q[3] < bestH) { bestH = q[3]; pick = i; }
    else if (nbrs.length <= 2 && still && q[3] < bestH) { bestH = q[3]; pick = i; }
  }
  if (pick < 0) {   // last resort: shave a 6-gon down to a 5-gon
    const hex = shards.find(q => q[5] === 6); if (!hex) break; hex[5] = 5; tris = shards.reduce((a, q) => a + q[5] * 3, 0); continue;
  }
  shards.splice(pick, 1); rejected++; tris = shards.reduce((a, q) => a + q[5] * 3, 0);
}
// trim can leave a flank leaf stranded: pull once more, then drop anyone still alone
for (let iter = 0; iter < 6; iter++) {
  for (let i = 0; i < shards.length; i++) {
    const q = shards[i], f = fam(q);
    let best = -1, bestD = 1e9, touch = false;
    for (let j = 0; j < shards.length; j++) {
      if (j === i || fam(shards[j]) !== f) continue;
      const d = Math.hypot(q[0] - shards[j][0], q[1] - shards[j][1]);
      if (d <= q[4] + shards[j][4] + CONTACT) { touch = true; break; }
      if (d < bestD) { bestD = d; best = j; }
    }
    if (touch || best < 0 || bestD > 40 || bestD < 1e-6) continue;
    const p = shards[best], need = q[4] + p[4] + CONTACT * 0.5, ux = (p[0] - q[0]) / bestD, uy = (p[1] - q[1]) / bestD;
    let nx = p[0] - ux * need, ny = p[1] - uy * need;
    const F = face(nx) || face(q[0]);
    if (f === 0 && F && ny < F.lipBy + 2) ny = Math.max(ny, F.lipBy + 2);
    const cap = houseCap(nx, ny, q[4], q[2]); if (!q[14] && q[2] + q[3] > cap) continue;
    q[0] = Math.round(nx * 100) / 100; q[1] = Math.round(ny * 100) / 100;
  }
}
removed = 1;
while (removed) {
  removed = 0;
  for (let i = shards.length - 1; i >= 0; i--) {
    const q = shards[i], f = fam(q);
    if (shards.some((p, j) => j !== i && fam(p) === f && touches(q, p))) continue;
    shards.splice(i, 1); rejected++; removed++;
  }
}
tris = shards.reduce((a, q) => a + q[5] * 3, 0);
const out = { version: 1, about: 'Macro shard-rock layer of the Solenne mansion cliff (tools/ariel-home/plan_shards.js). Mansion frame: bx along the wall, by seaward (= -glTF z), heights rel. the plateau (y0). ground=1: base/top follow the generated ground at runtime. Tops are cleaved or stepped ledges; no isolated spires; warm-brown tone multipliers in F.shardBuild.',
  fields: ['bx', 'by', 'base', 'height', 'radius', 'sides', 'rot', 'leanX', 'leanY', 'apexK', 'apexX', 'apexY', 'mat(0 ah_rockc, 1 ah_rockt)', 'tone', 'ground'],
  materials: ['ah_rockc', 'ah_rockt'], tileM: 3, sea: SEA, tris, count: shards.length, shards };
fs.writeFileSync(path.join(root, 'assets/ariel-home/cliff/shards.json'), JSON.stringify(out));
console.log('shards', shards.length, 'tris', tris, 'rejected', rejected, 'by kind', [0, 1].map(m => shards.filter(q => q[12] === m).length), 'flank', shards.filter(q => q[14]).length, 'max slend', Math.max(...shards.map(q => q[3] / (2 * q[4]))).toFixed(2));
