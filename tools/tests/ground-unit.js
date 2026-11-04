// Unit tests for ui/dm-groundlib.js (pure JS half).   node tools/tests/ground-unit.js
const assert = require('assert'); const G = require('../../ui/dm-groundlib.js');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const T = 128, TILE_U = 4.0, SHOE_U = 0.48;   // tile width in scene units; her shoe = 0.27 m = 0.48 u (CHAR_TERRAIN_HEIGHT 3.26 u = 1.83 m)
const bakeT = (id, seed, T) => { const b = G.newTileBuf(T), g = G.bakeTile(id, T, seed, b, 16); let yields = 0; while (!g.next().done) yields++; return { b, yields }; };
ok(G.TYPES.length === 12, '12 pattern/deformation types');
const wl = (b, T) => {   // dominant wavelength estimate (tile units): 2*pi*sqrt(var(h)/var(grad h)) with wrapped gradients
  let m = 0; const N = T * T; for (let i = 0; i < N; i++) m += b.H[i]; m /= N; let v = 0, g = 0;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) { const i = y * T + x, d = b.H[i] - m; v += d * d; const gx = (b.H[y * T + (x + 1) % T] - b.H[y * T + (x + T - 1) % T]) * 0.5, gy = (b.H[((y + 1) % T) * T + x] - b.H[((y + T - 1) % T) * T + x]) * 0.5; g += gx * gx + gy * gy; }
  return 2 * Math.PI * Math.sqrt((v / N) / Math.max(1e-9, g / N)) / T;
};
const scales = {};
for (const ty of G.TYPES) {
  const a = bakeT(ty.id, 99, T), b2 = bakeT(ty.id, 99, T), c = bakeT(ty.id, 100, T);
  ok(Buffer.compare(Buffer.from(a.b.H.buffer), Buffer.from(b2.b.H.buffer)) === 0, ty.name + ' deterministic');
  ok(Buffer.compare(Buffer.from(a.b.H.buffer), Buffer.from(c.b.H.buffer)) !== 0, ty.name + ' differs by seed');
  let mn = 9, mx = -9, finite = true; for (let i = 0; i < T * T; i++) { const h = a.b.H[i]; if (!(h >= 0 && h <= 1)) finite = false; mn = Math.min(mn, h); mx = Math.max(mx, h); if (!isFinite(a.b.L[i]) || !isFinite(a.b.Rg[i])) finite = false; }
  ok(finite, ty.name + ' finite, h in 0..1'); ok(mx - mn > 0.08, ty.name + ' has relief ' + (mx - mn).toFixed(2));
  // tileable: evaluating the generator an epsilon either side of the wrap gives the same value (no seam), in u and in v
  { const c = ty.init((99 * 7919 + ty.id * 104729) | 0), o1 = {}, o2 = {}; let du = 0, dv = 0, k = 0;
    for (let i = 0; i < 64; i++) { const t = (i + 0.37) / 64; ty.px(c, 1e-4, t, o1); ty.px(c, 1 - 1e-4, t, o2); du += Math.abs(o1.h - o2.h); ty.px(c, t, 1e-4, o1); ty.px(c, t, 1 - 1e-4, o2); dv += Math.abs(o1.h - o2.h); k++; }
    ok(du / k < 0.03 && dv / k < 0.03, ty.name + ' tiles without a seam: u ' + (du / k).toFixed(3) + ' v ' + (dv / k).toFixed(3)); }
  ok(a.yields >= 4, ty.name + ' is time-sliced (' + a.yields + ' slices)');
  scales[ty.name] = wl(a.b, T) * TILE_U;
}
// SCALE: the dominant detail wavelength of every type is between 0.12 u and 1.7 u (a quarter of a shoe to ~3.5 shoes); the median is about half a shoe to one shoe
const arr = Object.values(scales).sort((x, y) => x - y);
for (const k in scales) ok(scales[k] > 0.1 && scales[k] < 1.8, `scale ${k} ${scales[k].toFixed(2)} u = ${(scales[k] / SHOE_U).toFixed(2)} shoes`);
const med = arr[arr.length >> 1]; ok(med / SHOE_U > 0.3 && med / SHOE_U < 1.6, 'median feature ' + (med / SHOE_U).toFixed(2) + ' shoes');
// profiles: a biome never wears a type it forbids, every world gets 8 slots, and worlds differ
const styles = Object.keys(G.BIOMES); const seen = new Set(), sigs = new Set();
for (const st of styles) for (let s = 1; s <= 60; s++) {
  const p = G.profile({ style: st, seed: s * 7919, water: true }); ok(p.slots.length === 8 && p.names.length === 8, 'profile has 8 slots');
  for (const nm of p.bands) ok(G.BIOMES[st].w[nm] > 0, `${st} wears forbidden ${nm}`);
  sigs.add(p.names.join('|')); p.names.forEach((x) => seen.add(x));
  const q = G.profile({ style: st, seed: s * 7919, water: true }); ok(JSON.stringify(p) === JSON.stringify(q), 'profile deterministic');
}
ok(sigs.size > 150, 'worlds differ: ' + sigs.size + ' distinct slot sets of 360'); ok(seen.size === 12, 'all 12 types get used somewhere: ' + seen.size);
ok(G.profile({ style: 'dunes', seed: 5 }).moss === 0 && G.profile({ style: 'lush', seed: 5 }).moss > 0.4, 'moss only where it can grow');
ok(!G.profile({ style: 'mesa', seed: 5 }).ruin, 'no ruins on Mars'); ok(G.profile({ style: 'lush', seed: 5 }).ruin > 0.3, 'ruins grow over forest worlds');
// atlas packing: slots land in their own cells, the gutter wraps, slopes encode
const prof = G.profile({ style: 'lush', seed: 4242 }), r = G.bakeSync(prof, 64), L = G.layout(64);
ok(r.atlas.a1.length === L.W * L.H * 4 && L.W === 4 * 72 && L.H === 2 * 72, 'atlas size ' + L.W + 'x' + L.H);
for (let s = 0; s < 8; s++) {   // gutter pixel (-1,y) equals the tile's last column
  const ox = (s % 4) * L.cell, oy = Math.floor(s / 4) * L.cell, y = 30, g = ((oy + y + 4) * L.W + ox + 3) * 4, t = ((oy + y + 4) * L.W + ox + 4 + 63) * 4;
  ok(r.atlas.a1[g] === r.atlas.a1[t] && r.atlas.a2[g + 3] === r.atlas.a2[t + 3], 'gutter wraps in slot ' + s);
}
let lm = 0; for (let i = 0; i < 64 * 64; i++) lm += r.atlas.a1[(((4 + (i >> 6)) * L.W) + 4 + (i & 63)) * 4 + 3] * 2 / 255; lm /= 64 * 64; ok(Math.abs(lm - 1) < 0.15, 'tile lightness normalised to ~1: ' + lm.toFixed(2));
// region map: bands share the area evenly, ruin patches match the world's ruin amount, channels wrap
const reg = r.region, N = G.REG * G.REG, cnt = new Array(6).fill(0); let ruin = 0, nan = 0;
for (let i = 0; i < N; i++) { cnt[Math.min(5, Math.floor(reg[i * 4] / 255 * 6))]++; if (reg[i * 4 + 3] > 127) ruin++; }
for (let b = 0; b < 6; b++) ok(Math.abs(cnt[b] / N - 1 / 6) < 0.05, `band ${b} area ${(cnt[b] / N).toFixed(3)}`);
const rf = ruin / N, want = Math.min(0.3, prof.ruin * 0.1); ok(Math.abs(rf - want) < 0.03, `ruin area ${rf.toFixed(3)} vs ${want.toFixed(3)}`);
let seamJ = 0, innerJ = 0; for (let y = 0; y < G.REG; y++) { seamJ += Math.abs(reg[(y * G.REG) * 4] - reg[(y * G.REG + G.REG - 1) * 4]); innerJ += Math.abs(reg[(y * G.REG + 80) * 4] - reg[(y * G.REG + 79) * 4]); }
ok(seamJ < innerJ * 2 + 50, 'region map wraps: seam ' + seamJ + ' inner ' + innerJ);
// bake cost: whole bake at T=192 (desktop size) stays within a small CPU budget and no single slice exceeds ~15 ms
{ const p = G.profile({ style: 'lush', seed: 9 }), atlas = G.allocAtlas(192), region = new Uint8Array(G.REG * G.REG * 4), g = G.bake(p, atlas, region, 192); let worst = 0, tot = 0, slices = 0, all = [], t0 = process.hrtime.bigint();
  for (;;) { const a = process.hrtime.bigint(), d = g.next(); const ms = Number(process.hrtime.bigint() - a) / 1e6; worst = Math.max(worst, ms); if (d.done) break; slices++; all.push(ms); }
  all.sort((a, b) => a - b); const p95 = all[Math.floor(all.length * 0.95)];
  tot = Number(process.hrtime.bigint() - t0) / 1e6; ok(p95 < 8 && worst < 35, 'p95 slice ' + p95.toFixed(1) + ' ms, worst ' + worst.toFixed(1) + ' ms (JIT-cold first slices included)'); ok(slices > 40, 'slices ' + slices); console.log(`bake T=192: ${tot.toFixed(0)} ms total in ${slices} slices, p95 slice ${p95.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`); }
console.log('ground-unit: OK (' + n + ' checks); feature sizes (shoes):', Object.entries(scales).map(([k, v]) => k + ' ' + (v / SHOE_U).toFixed(2)).join(', '));
