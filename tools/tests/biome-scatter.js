// node tools/tests/biome-scatter.js - ui/dm-biome-scatter.js pure core: determinism, chunk-seam independence, mask logic, validation, LOD pick, budget caps, view wedge, re-bin.
'use strict';
const assert = require('assert'), path = require('path');
const S = require(path.join(__dirname, '../../ui/dm-biome-scatter.js')), core = S.core, BIOMES = require(path.join(__dirname, '../../ui/dm-biome-defs.js'));
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
const biome = (id) => core.validateBiome(BIOMES.find((b) => b.id === id)).biome;

// synthetic terrain: rolling hills, a sea basin (h < 0) around x=-200..0, a steep ridge at z ~ 450
const H = (x, z) => 18 * core.fbm(x / 140, z / 140, 9, 3) + 6 + (x < 0 ? -0.07 * Math.min(200, -x) : 0) + 60 * Math.exp(-(((z - 450) / 40) ** 2));
const mkFields = (x0, z0, x1, z1) => ({ H, sea: 0, grid: core.makeShoreGrid(H, x0, z0, x1, z1, 0, 10, 60) });
const place = (b, seed, i, j, K) => { const [x0, z0, x1, z1] = core.chunkBox(i, j); return core.placeBox(b, seed, x0, z0, x1, z1, mkFields(x0, z0, x1, z1), { densityK: K == null ? 1 : K }); };
const sum = (r) => r.reduce((a, x) => a + x.length / core.STRIDE, 0);

// 1. hash / noise / range maths
ok(core.hash32(1, 2, 3, 4) === core.hash32(1, 2, 3, 4) && core.hash32(1, 2, 3, 4) !== core.hash32(1, 2, 4, 3), 'hash deterministic + order sensitive');
{ let mn = 1, mx = 0, s = 0; for (let i = 0; i < 20000; i++) { const v = core.rnd(core.hash32(5, i, i * 3, 1), 2); mn = Math.min(mn, v); mx = Math.max(mx, v); s += v; } ok(mn >= 0 && mx < 1 && Math.abs(s / 20000 - 0.5) < 0.01, 'rnd uniform in [0,1)'); }
{ let mn = 1, mx = 0; for (let i = 0; i < 5000; i++) { const v = core.fbm(i * 0.37, i * 0.11, 3, 4); mn = Math.min(mn, v); mx = Math.max(mx, v); } ok(mn >= 0 && mx <= 1, 'fbm in 0..1'); }
ok(core.rangeWeight(5, { min: 0, max: 10, soft: 2 }) === 1 && core.rangeWeight(-0.1, { min: 0, max: 10 }) === 0 && core.rangeWeight(10.1, { min: 0, max: 10 }) === 0, 'range: inside 1, outside 0');
ok(core.rangeWeight(0, { min: 0, max: 10, soft: 2 }) === 0 && core.rangeWeight(1, { min: 0, max: 10, soft: 2 }) > 0.4 && core.rangeWeight(1, { min: 0, max: 10, soft: 2 }) < 0.6 && core.rangeWeight(2, { min: 0, max: 10, soft: 2 }) === 1, 'range: soft ramp inside the bound');
ok(core.rangeWeight(3, null) === 1 && core.rangeWeight(99, { min: 5 }) === 1 && core.rangeWeight(4, { min: 5 }) === 0, 'range: open ends');
{ const m = { scale: 50, threshold: 0.5, soft: 0.1, seedOffset: 1 }; let diff = 0; for (let i = 0; i < 400; i++) { const a = core.noiseWeight(m, i * 7, i * 3, 11), b = core.noiseWeight(Object.assign({ invert: true }, m), i * 7, i * 3, 11); ok(Math.abs(a + b - 1) < 1e-9, 'noise invert = 1 - w'); if (a > 0.01 && a < 0.99) diff++; } ok(diff > 5, 'noise mask has soft edges'); }
{ const c = { radius: 10, strength: 1, occupancy: 1, cell: 40 }; let lo = 1, hi = 0; for (let x = 0; x < 200; x += 1) for (let z = 0; z < 200; z += 5) { const w = core.clusterWeight(c, x, z, 5); lo = Math.min(lo, w); hi = Math.max(hi, w); } ok(lo < 0.05 && hi > 0.95, 'cluster weight spans 0..1'); ok(core.clusterWeight({ radius: 10, strength: 0 }, 3, 4, 1) === 1, 'cluster strength 0 = off'); }

// 2. biome validation
for (const b of BIOMES) { const v = core.validateBiome(b); ok(v.ok, b.id + ' invalid: ' + v.errors.join('; ')); ok(JSON.stringify(JSON.parse(JSON.stringify(b))) === JSON.stringify(b), b.id + ' is plain JSON data'); }
ok(BIOMES.length === 3, 'three starter biomes');
{ const bad = (mut) => { const b = JSON.parse(JSON.stringify(BIOMES[0])); mut(b); return core.validateBiome(b); };
  ok(!bad((b) => { b.entries[0].density = 0; }).ok, 'density 0 rejected'); ok(!bad((b) => { b.entries[0].scale = [2, 1]; }).ok, 'scale min>max rejected');
  ok(!bad((b) => { b.entries[0].avoid = [{ entry: 'broadleaf' }]; }).ok, 'avoid of a LATER entry (cycle) rejected'); ok(!bad((b) => { b.entries[1].id = 'conifer'; }).ok, 'duplicate id rejected');
  ok(!bad((b) => { b.entries[0].lod = []; }).ok, 'no lod rejected'); ok(!bad((b) => { b.entries[0].lod[1].maxDist = 10; }).ok, 'lod maxDist must increase'); ok(!bad((b) => { b.entries[0].slope = { min: 30, max: 10 }; }).ok, 'slope min>max rejected');
  ok(!core.validateBiome(null).ok && !core.validateBiome({ id: 'x', entries: [] }).ok, 'empty / null rejected'); }

// 3. determinism + order independence + seed sensitivity
for (const id of ['temperate-forest', 'meadow', 'dry-desert']) {
  const b = biome(id), a1 = place(b, 1234, 0, 0), a2 = place(b, 1234, 0, 0), a3 = place(b, 99, 0, 0);
  ok(sum(a1) > 50, id + ' places something (' + sum(a1) + ')');
  ok(a1.every((x, k) => Buffer.compare(Buffer.from(x.buffer), Buffer.from(a2[k].buffer)) === 0), id + ' identical on a re-run');
  ok(a1.some((x, k) => x.length !== a3[k].length || Buffer.compare(Buffer.from(x.buffer), Buffer.from(a3[k].buffer)) !== 0), id + ' changes with the world seed');
  // streaming order: building a neighbour first (fresh sampler) does not change this chunk
  place(b, 1234, 1, 0); place(b, 1234, -1, 3); const a4 = place(b, 1234, 0, 0); ok(a1.every((x, k) => Buffer.compare(Buffer.from(x.buffer), Buffer.from(a4[k].buffer)) === 0), id + ' independent of what else was streamed');
}
// 4. seams: the union of two adjacent chunks == one box covering both (so no seam, no doubled plant on a chunk border) - incl. avoidance across the border
{
  const b = biome('temperate-forest'), [x0, z0] = core.chunkBox(0, 0), [, , x1, z1] = core.chunkBox(1, 0), mid = core.chunkBox(0, 0)[2];
  const whole = core.placeBox(b, 7, x0, z0, x1, z1, mkFields(x0, z0, x1, z1), { densityK: 1 });
  const A = place(b, 7, 0, 0), B = place(b, 7, 1, 0);
  const key = (r) => r.map((arr) => { const s = new Set(); for (let o = 0; o < arr.length; o += core.STRIDE) s.add(arr[o].toFixed(4) + ',' + arr[o + 2].toFixed(4)); return s; });
  const kw = key(whole), ka = key(A), kb = key(B);
  ok(b.entries.every((e, ei) => { const u = new Set([...ka[ei], ...kb[ei]]); if (u.size !== ka[ei].size + kb[ei].size) return false; for (const k of u) if (!kw[ei].has(k)) return false; for (const k of kw[ei]) if (!u.has(k)) return false; return true; }), 'two chunks == one box over both: same set of plants, none doubled, none lost on the seam');
  ok(core.chunkBox(1, 0)[0] === mid, 'chunk boxes tile');
}

// 5. masks are honoured: every placed plant satisfies its entry's slope / elevation / water-distance range (exact terrain, so check with the exact H)
{
  const b = biome('temperate-forest'), r = place(b, 21, 0, 1), f = mkFields(...core.chunkBox(0, 1));
  b.entries.forEach((e, ei) => {
    const a = r[ei]; for (let o = 0; o < a.length; o += core.STRIDE) {
      const x = a[o], z = a[o + 2], y = H(x, z), sl = Math.atan(Math.hypot(H(x + 1.5, z) - y, H(x, z + 1.5) - y) / 1.5) * 180 / Math.PI;
      if (e.elevation) ok(core.rangeWeight(y, e.elevation) > 0, e.id + ' elevation ' + y);
      if (e.slope) ok(sl <= e.slope.max + 1e-6, e.id + ' slope ' + sl);
      if (e.waterDistance) ok(f.grid.shore(x, z) >= e.waterDistance.min - 1e-6, e.id + ' shore distance ' + f.grid.shore(x, z));
      ok(a[o + 3] >= e.scale[0] - 1e-6 && a[o + 3] <= e.scale[1] + 1e-6, e.id + ' scale in range');
    }
  });
  ok(sum(r) > 0, 'forest chunk non-empty');
}
// 5b. a flat-out mask test: elevation window excludes everything / includes everything
{
  const mk = (extra) => core.validateBiome({ id: 't', entries: [Object.assign({ id: 'a', kind: 'bush', density: 0.01, scale: [1, 1], lod: [{ mesh: 'proc:shrub-0', maxDist: 100 }] }, extra)] }).biome;
  const flat = () => 10, f = (x0, z0, x1, z1) => ({ H: flat, sea: 0, grid: core.makeShoreGrid(flat, x0, z0, x1, z1, 0, 10, 60) });
  const run = (b) => core.placeBox(b, 3, 0, 0, 300, 300, f(0, 0, 300, 300), {});
  const all = sum(run(mk({}))), none = sum(run(mk({ elevation: { min: 50, max: 80 } }))), some = sum(run(mk({ elevation: { min: 5, max: 20 } }))), slopeNone = sum(run(mk({ slope: { min: 20 } })));
  ok(all > 700 && all < 1000, 'density 0.01/m2 x 90000 m2 ~ 900 (got ' + all + ')'); ok(none === 0, 'elevation window above the terrain: 0'); ok(some === all, 'elevation window containing the terrain: all'); ok(slopeNone === 0, 'min slope 20 on flat ground: 0');
  const half = sum(run(mk({ noise: { scale: 80, threshold: 0.5, soft: 0.02 } }))); ok(half > all * 0.2 && half < all * 0.8, 'a 50 % noise mask keeps about half (' + half + ' of ' + all + ')');
  // water-distance: terrain with a sea in x < 100: nothing within 40 m of the water when min = 40
  const hs = (x) => (x < 100 ? -3 : 10), fs = { H: hs, sea: 0, grid: core.makeShoreGrid(hs, 0, 0, 300, 300, 0, 10, 60) };
  const wd = core.placeBox(mk({ waterDistance: { min: 40 } }), 3, 0, 0, 300, 300, fs, {}); let minX = 1e9; for (let o = 0; o < wd[0].length; o += core.STRIDE) minX = Math.min(minX, wd[0][o]); ok(wd[0].length > 100 && minX >= 100 + 40 - 12, 'water-distance mask keeps plants away from the shore (nearest x ' + minX.toFixed(1) + ')');
  const noSea = core.placeBox(mk({ elevation: { min: 0 } }), 3, 0, 0, 300, 300, fs, {}); let minX2 = 1e9; for (let o = 0; o < noSea[0].length; o += core.STRIDE) minX2 = Math.min(minX2, noSea[0][o]); ok(minX2 >= 100 - 1, 'nothing is planted under the sea');
}
// 6. avoidance: a later entry keeps clear of the earlier one (distance >= footprints), across the whole chunk
{
  const b = core.validateBiome({ id: 'av', entries: [{ id: 't', kind: 'tree', density: 0.004, scale: [1, 1], footprint: 2, lod: [{ mesh: 'proc:broadleaf-0', maxDist: 100 }] }, { id: 'g', kind: 'grass', density: 0.05, scale: [1, 1], footprint: 0.5, avoid: [{ entry: 't', extra: 0.5 }], lod: [{ mesh: 'proc:grass-0', maxDist: 100 }] }] }).biome;
  const flat = () => 5, r = core.placeBox(b, 8, 0, 0, 300, 300, { H: flat, sea: 0, grid: null }, {}), T = r[0], G = r[1]; let minD = 1e9;
  for (let g = 0; g < G.length; g += core.STRIDE) for (let t = 0; t < T.length; t += core.STRIDE) minD = Math.min(minD, Math.hypot(G[g] - T[t], G[g + 2] - T[t + 2]));
  ok(T.length > 100 && G.length > 100 && minD >= 2 + 0.5 + 0.5 - 1e-6, 'grass keeps clear of trees (min gap ' + minD.toFixed(2) + ')');
}
// 7. budget tiers: counts shrink with the tier / pressure, caps hold, subsets are nested (rank), tier choice
ok(core.tierFor({ lodTier: 'low' }) === 0 && core.tierFor({ lodTier: 'mobile' }) === 0 && core.tierFor({ lodTier: 'desktop' }) === 2 && core.tierFor({ lodTier: 'desktop', preset: 'ultra' }) === 3 && core.tierFor({ lodTier: 'mobile', force: 1 }) === 1, 'phones / tablets default to tier 0; desktop 2; ultra 3; ?scattertier forces');
ok(core.dynFor(0, 0) === 0 && core.dynFor(2, 0) === 2 && core.dynFor(2, 2) === 3 && core.dynFor(5, 3) === 3, 'dynFor clamps 0..3');
for (const id of ['temperate-forest', 'meadow', 'dry-desert']) {
  const b = biome(id);
  for (let t = 1; t < 4; t++) ok(core.TIERS[t].capTotal >= core.TIERS[t - 1].capTotal && core.TIERS[t].density >= core.TIERS[t - 1].density && core.TIERS[t].dist >= core.TIERS[t - 1].dist, 'tier table monotone');
  // tier 0: every drawn level is a card; no mesh level has a buffer
  for (const e of b.entries) { const f = core.firstLevel(e, 0, 0); ok(f < 0 || e.lod[f].card, id + '/' + e.id + ' tier 0 first level is a card (or none)'); }
  // gather 9 chunks at the tier's density, rebin at a camera in the middle, under each (tier, dyn): the cap and the buffers must hold
  const cam = { x: 0, y: 12, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, fov: 60, aspect: 1.7 };
  let prevTotal = 1e9;
  for (let tier = 0; tier < 4; tier++) {
    const T = core.TIERS[tier], chunks = []; const R = core.ringFor(tier, 1e9);
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) { const r = place(b, 5, i, j, T.density); chunks.push({ cx: i * 300, cz: j * 300, data: r, count: sum(r) }); }
    const mkBins = () => b.entries.map((e) => e.lod.map((l, lv) => (lv < core.firstLevel(e, tier, 0) || (T.cardOnly && !l.card) ? null : { m: new Float32Array(Math.max(2048, T.bufCap) * 16), c: new Float32Array(Math.max(2048, T.bufCap) * 3), n: 0, cap: Math.max(2048, T.bufCap) })));
    const view = core.makeView(cam, 0.45), ringCaps = b.entries.map((e) => core.ringFor(tier, e.lod[e.lod.length - 1].maxDist * T.dist));
    let last = 1e9;
    for (let dyn = 0; dyn < 4; dyn++) {
      const bins = mkBins(), res = core.rebin(b, chunks, view, tier, dyn, bins, ringCaps); let drawn = 0;
      bins.forEach((row, ei) => row.forEach((x, lv) => { if (x) { ok(x.n <= x.cap, 'buffer cap'); drawn += x.n; } else ok(true, ''); }));
      ok(drawn === res.total, 'rebin total == sum of bins'); ok(res.total <= T.capTotal, id + ' tier ' + tier + ' dyn ' + dyn + ' total ' + res.total + ' <= cap ' + T.capTotal);
      ok(res.total <= last + 0, id + ' tier ' + tier + ': pressure never ADDS instances'); last = res.total;
      if (tier === 0) bins.forEach((row, ei) => row.forEach((x, lv) => { if (x && x.n) ok(b.entries[ei].lod[lv].card, 'tier 0 draws impostor cards only'); }));
    }
    if (tier === 0) ok(last >= 0, 'tier 0 ran');
    const t0 = core.rebin(b, chunks, view, tier, 0, mkBins(), ringCaps).total; ok(t0 <= T.capTotal, 'cap at dyn 0'); void prevTotal; prevTotal = t0;
  }
}
// 7b. nested rank subsets: instances kept at dyn 2 are a subset of those kept at dyn 0 (same x,z)
{
  const b = biome('meadow'), r = place(b, 5, 0, 0, 1), chunks = [{ cx: 0, cz: 0, data: r, count: sum(r) }], view = core.makeView({ x: 0, y: 10, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, fov: 60, aspect: 1.7 }, 0.45);
  const T = core.TIERS[3], mk = () => b.entries.map((e) => e.lod.map((l) => ({ m: new Float32Array(12288 * 16), c: new Float32Array(12288 * 3), n: 0, cap: 12288 }))), rc = b.entries.map(() => 3);
  const A = mk(), B = mk(); core.rebin(b, chunks, view, 3, 0, A, rc); core.rebin(b, chunks, view, 3, 1, B, rc);
  const posSet = (bins) => { const s = new Set(); bins.forEach((row) => row.forEach((x) => { for (let k = 0; k < x.n; k++) s.add(x.m[k * 16 + 12].toFixed(3) + ',' + x.m[k * 16 + 14].toFixed(3)); })); return s; };
  const pa = posSet(A), pb = posSet(B); ok(pb.size < pa.size && [...pb].every((k) => pa.has(k)), 'dyn 1 draws a strict subset of dyn 0 (nested by rank): ' + pb.size + ' of ' + pa.size); void T;
}
// 8. LOD pick: monotone in distance, -1 past the end, ring cap clamps, tiers skip levels
{
  const e = biome('temperate-forest').entries[0];
  for (let tier = 0; tier < 4; tier++) for (let dyn = 0; dyn < 4; dyn++) { let prev = -1; for (let d = 0; d < 1500; d += 5) { const lv = core.pickLod(e, d, tier, dyn, 0); if (lv < 0) { prev = 99; continue; } ok(prev !== 99, 'once -1 stays -1'); ok(lv >= prev, 'LOD index never decreases with distance'); prev = lv; } }
  ok(core.pickLod(e, 10, 3, 0, 0) === 0 && core.pickLod(e, 10, 2, 0, 0) === 1 && core.pickLod(e, 10, 1, 0, 0) === 2 && core.pickLod(e, 10, 0, 0, 0) === 3, 'near LOD: tier 3 -> 0, 2 -> 1, 1 -> 2, 0 -> card');
  ok(core.pickLod(e, 40, 3, 0, 0) === 0 && core.pickLod(e, 80, 3, 0, 0) === 1 && core.pickLod(e, 200, 3, 0, 0) === 2 && core.pickLod(e, 400, 3, 0, 0) === 3, 'tier 3 bands follow lod[].maxDist (x1.15)');
  ok(core.pickLod(e, 300 * 1 + 1, 0, 0, 1) === -1, 'ring cap clamps the far end'); ok(core.pickLod(e, 10, 3, 3, 0) === 2 || core.pickLod(e, 10, 3, 3, 0) === 3, 'pressure moves the first level up');
  ok(core.ringFor(0, 1e9) === 1 && core.ringFor(2, 1e9) === 2 && core.ringFor(3, 1e9) === 3 && core.ringFor(3, 100) === 1, 'ring caps');
}
// 9. view wedge: in front kept, behind dropped, near kept, looking straight down = no culling
{
  const q0 = { x: 0, y: 5, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, fov: 60, aspect: 1.6 };   // identity: looks down -z
  const v = core.makeView(q0, 0.2); ok(v.wedge && v.fz < -0.99, 'wedge looks along -z');
  ok(core.inView(v, 0, -100, 1) && !core.inView(v, 0, 100, 1) && core.inView(v, 0, 10, 1) && !core.inView(v, 500, 0, 1) && core.inView(v, 70, -100, 1), 'front in, behind out, near in, side out');
  const sy = Math.sin(Math.PI / 4), cy = Math.cos(Math.PI / 4), v2 = core.makeView({ x: 0, y: 5, z: 0, qx: 0, qy: sy, qz: 0, qw: cy, fov: 60, aspect: 1.6 }, 0.2);   // yaw 90 deg: looks along -x
  ok(core.inView(v2, -100, 0, 1) && !core.inView(v2, 100, 0, 1), 'yaw 90: looks along -x');
  const down = core.makeView({ x: 0, y: 5, z: 0, qx: -Math.SQRT1_2, qy: 0, qz: 0, qw: Math.SQRT1_2, fov: 60, aspect: 1.6 }, 0.2); ok(!down.wedge && core.inView(down, 0, 500, 1), 'looking straight down: no culling');
  // sweep: anything inside the true frustum (|bearing| < hfov/2) is never culled
  const hf = 2 * Math.atan(Math.tan(30 * Math.PI / 180) * 1.6); for (let a = -hf / 2; a <= hf / 2; a += 0.02) for (const d of [30, 100, 400]) ok(core.inView(v, Math.sin(a) * d, -Math.cos(a) * d, 0), 'inside the frustum is never culled');
}
// 10. shore grid: distance is ~Euclidean to the water, 0 in it, saturates at the margin
{
  const hs = (x) => (x < 50 ? -2 : 5), g = core.makeShoreGrid(hs, 0, 0, 200, 200, 0, 10, 60);
  ok(g.shore(20, 100) === 0 && Math.abs(g.shore(110, 100) - 60) < 12 && g.shore(190, 100) === 60 && g.shore(52, 100) <= 12, 'shore distance 0 in water, ~metres out, saturating at the margin');
  ok(Math.abs(g.h(100, 100) - 5) < 1e-6, 'coarse height');
}
// 11. biomeFor
ok(core.biomeFor('lush', 0x3a7d34) === 'temperate-forest' && core.biomeFor('lush', 0x6a7a4a) === 'meadow' && core.biomeFor('mesa', 0) === 'dry-desert' && core.biomeFor('dunes', 0) === 'dry-desert' && core.biomeFor('ice', 0) === null, 'biome per world style');
// 12. cost guard: the exact-height calls per chunk stay bounded (the existing prop scatter does ~1000 per chunk)
{ const b = biome('temperate-forest'), [x0, z0, x1, z1] = core.chunkBox(0, 0); let calls = 0; const Hc = (x, z) => { calls++; return H(x, z); }; const f = { H: Hc, sea: 0, grid: core.makeShoreGrid(H, x0, z0, x1, z1, 0, 10, 60) };
  const r = core.placeBox(b, 1, x0, z0, x1, z1, f, { densityK: 0.3 }); ok(sum(r) > 0 && calls < 12000, 'tier-0 density chunk: ' + calls + ' exact height reads for ' + sum(r) + ' plants'); console.log('  (info) tier-0 chunk: ' + sum(r) + ' plants, ' + calls + ' H reads, grid ' + f.grid.n + ' cells'); }
console.log('biome-scatter OK (' + n + ' checks)');
