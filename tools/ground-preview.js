// Node-rendered previews of the ground library: lit albedo (tile * baked slope shading) and height sheets, plus a "region map" world preview.
//   node tools/ground-preview.js [outDir] [seed]
const fs = require('fs'), path = require('path'); const G = require('../ui/dm-groundlib.js'); const { png } = require('./tests/png.js');
const out = process.argv[2] || path.join(__dirname, '..', 'docs', 'ground'), seed = +process.argv[3] || 1234, T = 192; fs.mkdirSync(out, { recursive: true });
const base = [0.46, 0.42, 0.34];   // a neutral biome vertex colour
function bakeAll() { const bufs = []; for (const ty of G.TYPES) { const b = G.newTileBuf(T), g = G.bakeTile(ty.id, T, seed, b, 64); while (!g.next().done); bufs.push(b); } return bufs; }
const bufs = bakeAll();
const cols = 4, rows = 3, rep = 2, cw = T * rep / 2 | 0, W = cols * (T + 4), H = rows * (T + 4);
function lit(b, x, y, L) {   // Lambert from height-field slope (same as the shader's baked slopes) with the sun at low angle
  const xm = (x - 1 + T) % T, xp = (x + 1) % T, ym = (y - 1 + T) % T, yp = (y + 1) % T;
  const gx = (b.H[y * T + xp] - b.H[y * T + xm]) * 0.5 * 6.0, gy = (b.H[yp * T + x] - b.H[ym * T + x]) * 0.5 * 6.0;
  const n = [-gx, -gy, 1], nl = Math.hypot(...n); const d = Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / nl);
  return 0.3 + 0.9 * d;
}
const sheet = new Uint8Array(W * H * 4), hsheet = new Uint8Array(W * H * 4);
const Ls = [-0.5, -0.4, 0.77]; const ln = Math.hypot(...Ls); Ls.forEach((v, i) => Ls[i] = v / ln);
G.TYPES.forEach((ty, k) => {
  const b = bufs[k], ox = (k % cols) * (T + 4) + 2, oy = Math.floor(k / cols) * (T + 4) + 2;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const i = y * T + x, sh = lit(b, x, y, Ls), p = ((oy + y) * W + ox + x) * 4;
    const cav = 0.55 + 0.45 * b.H[i];
    sheet[p] = Math.min(255, 255 * base[0] * b.L[i] * b.R[i] * sh * cav * 1.9); sheet[p + 1] = Math.min(255, 255 * base[1] * b.L[i] * b.G[i] * sh * cav * 1.9); sheet[p + 2] = Math.min(255, 255 * base[2] * b.L[i] * b.B[i] * sh * cav * 1.9); sheet[p + 3] = 255;
    const hv = b.H[i] * 255; hsheet[p] = hsheet[p + 1] = hsheet[p + 2] = hv; hsheet[p + 3] = 255;
  }
});
fs.writeFileSync(path.join(out, 'library-lit.png'), png(W, H, sheet)); fs.writeFileSync(path.join(out, 'library-height.png'), png(W, H, hsheet));
// 2x2 repeat of a few types to show tiling
const names = ['pebbleBed', 'flagstone', 'brick', 'sandFootprints'], RW = T * 2 * names.length, RH = T * 2, rep2 = new Uint8Array(RW * RH * 4);
names.forEach((nm, n) => { const k = G.TYPES.findIndex((t) => t.name === nm), b = bufs[k]; for (let y = 0; y < T * 2; y++) for (let x = 0; x < T * 2; x++) { const xx = x % T, yy = y % T, i = yy * T + xx, sh = lit(b, xx, yy, Ls), p = (y * RW + n * T * 2 + x) * 4, cav = 0.55 + 0.45 * b.H[i];
  rep2[p] = Math.min(255, 255 * base[0] * b.L[i] * b.R[i] * sh * cav * 1.9); rep2[p + 1] = Math.min(255, 255 * base[1] * b.L[i] * b.G[i] * sh * cav * 1.9); rep2[p + 2] = Math.min(255, 255 * base[2] * b.L[i] * b.B[i] * sh * cav * 1.9); rep2[p + 3] = 255; } });
fs.writeFileSync(path.join(out, 'tiling-2x2.png'), png(RW, RH, rep2));
// region maps of three different worlds (R selector as colour per band, ruin patches white, moss green, wet blue)
const styles = ['lush', 'dunes', 'volcanic', 'ice'], R = G.REG, RM = new Uint8Array(R * styles.length * R * 4), bandCol = [[200, 90, 70], [90, 150, 210], [220, 190, 80], [120, 200, 120], [170, 110, 200], [230, 140, 170]];
styles.forEach((st, n) => {
  const prof = G.profile({ style: st, seed: seed + n * 17, water: true }), reg = new Uint8Array(R * R * 4), g = (function* () { yield* G.bake.call(null, prof, G.allocAtlas(32), reg, 32); })();
  // only the region part is needed: run the generator with a tiny tile size
  while (!g.next().done);
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const i = (y * R + x) * 4, band = Math.min(5, Math.floor(reg[i] / 255 * 6)), c = bandCol[band], ruin = reg[i + 3] / 255, wet = reg[i + 2] / 255, moss = reg[i + 1] / 255;
    let r = c[0], gg = c[1], b = c[2]; gg = gg * (1 - 0.4 * moss) + 90 * moss; b = b * (1 - wet * 0.6) + 255 * wet * 0.6; if (ruin > 0.5) { r = 245; gg = 245; b = 245; }
    const p = (y * (R * styles.length) + n * R + x) * 4; RM[p] = r; RM[p + 1] = gg; RM[p + 2] = b; RM[p + 3] = 255;
  }
  console.log(st, prof.names.join(','), 'moss', prof.moss.toFixed(2), 'wet', prof.wet.toFixed(2), 'ruin', prof.ruin.toFixed(2));
});
fs.writeFileSync(path.join(out, 'regions-4-worlds.png'), png(R * styles.length, R, RM));
console.log('wrote', out);
