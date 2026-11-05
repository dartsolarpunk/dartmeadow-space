// Offline bake of the water flipbook sheet: assets/water/spray-sheet.webp   node tools/water/sheets.js [outDir]
// One 512x512 RGB sheet, 4x4 frames of 128x128; each COLOUR CHANNEL is a different sprite family (alpha = 255, so nothing is premultiplied or colour-managed):
//   R  spray sheet   LOOPING   a fan of fine droplets thrown up from a point (white-water jet / bow spray / breaking lip), made by a tiny 2-D particle sim
//   G  crown splash  ONE-SHOT  a centre jet, a ring of droplets on ballistic arcs, a membrane curtain and a ripple ring (footfalls, landings, impacts)
//   B  mist puff     LOOPING   soft billows that rise and widen (sea mist, steam, spray haze)
// Looping = every particle's age is (t - birth) mod 1, so frame 15 flows into frame 0. No texture is generated at runtime; the game loads this file through the heavy-load queue.
const N = 128, F = 16, COLS = 4;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
function rng(seed) { let a = seed | 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * v); };
function splat(acc, cx, cy, r, w) {
  const R = Math.ceil(r * 2.4), x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(N - 1, Math.ceil(cx + R)), y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(N - 1, Math.ceil(cy + R)), ir2 = 1.7 / (r * r);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; acc[y * N + x] += w * Math.exp(-(dx * dx + dy * dy) * ir2); }
}
// soft value noise (not tiled: a sprite, not a texture) used to ragged the edges
function vnoise(seed, cell) { cell = cell || 4; const g = new Float32Array(33 * 33); const r = rng(seed); for (let i = 0; i < g.length; i++) g[i] = r(); return (x, y) => { x = clamp(x / cell, 0, 31.99); y = clamp(y / cell, 0, 31.99); const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, s = (t) => t * t * (3 - 2 * t); const a = g[iy * 33 + ix], b = g[iy * 33 + ix + 1], c = g[(iy + 1) * 33 + ix], d = g[(iy + 1) * 33 + ix + 1]; return (a + (b - a) * s(fx)) * (1 - s(fy)) + (c + (d - c) * s(fx)) * s(fy); }; }
const nz = vnoise(7, 5), nz2 = vnoise(19, 3);
function finish(acc, k, rag) { const out = new Float32Array(N * N); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = y * N + x; let a = 1 - Math.exp(-acc[i] * k); a *= 1 - rag + rag * 2 * (0.6 * nz(x, y) + 0.4 * nz2(x * 1.7, y * 1.7)); out[i] = clamp(a, 0, 1); } return out; }

function sprayParticles() {
  const r = rng(101), P = [];
  for (let i = 0; i < 560; i++) { const sheet = i < 80, th = -Math.PI / 2 + gauss(r) * (sheet ? 0.26 : 0.4), sp = (sheet ? 52 : 34) + r() * (sheet ? 56 : 96); P.push({ phi: r(), life: 0.55 + r() * 0.45, vx: Math.cos(th) * sp, vy: Math.sin(th) * sp, rad: sheet ? 4.2 + r() * 4.6 : 0.9 + r() * 1.2, w: sheet ? 0.075 : 0.55 + r() * 0.4, sheet, grow: sheet ? 1.5 : 0.25 }); }
  return P;
}
function sprayFrame(f, P) {
  const t = f / F, acc = new Float32Array(N * N), cyc = 1.0, g = 92;
  for (const p of P) {
    let age = t - p.phi; age -= Math.floor(age); if (age > p.life) continue;
    const a = age * cyc, x = 64 + p.vx * a, y = 122 + p.vy * a + 0.5 * g * a * a, u = age / p.life;
    if (y > 126) continue; const fade = Math.pow(1 - u, 0.7) * Math.min(1, age * 14 + 0.08);
    splat(acc, x, y, p.rad * (1 + p.grow * u), p.w * fade);
  }
  splat(acc, 64, 121, 6, 0.55); splat(acc, 64, 117, 4, 0.3);                                         // the foamy root of the jet
  return finish(acc, 1.6, 0.35);
}
function crownParticles() {
  const r = rng(202), P = [];
  for (let i = 0; i < 70; i++) P.push({ th: (24 + r() * 46) * Math.PI / 180, sp: 66 + r() * 52, side: i & 1 ? 1 : -1, rad: 1.0 + r() * 1.5, w: 0.7, curtain: false });
  for (let i = 0; i < 46; i++) P.push({ th: (30 + r() * 34) * Math.PI / 180, sp: 44 + r() * 36, side: i & 1 ? 1 : -1, rad: 3.2 + r() * 2.2, w: 0.22, curtain: true });
  return P;
}
function crownFrame(f, P) {
  const t = f / (F - 1), acc = new Float32Array(N * N), g = 118, T = t * 0.85;
  const jetH = 66 * Math.sin(Math.PI * clamp(t * 1.25, 0, 1)) * (1 - t * 0.35), jetW = 8 - 5 * t;
  for (let s = 0; s <= 1.0001; s += 0.05) splat(acc, 64 + Math.sin(s * 5 + t * 6) * 1.5, 122 - jetH * s, jetW * (1 - 0.55 * s) + 1, 0.55 * (1 - 0.5 * s));
  if (jetH > 8) splat(acc, 64, 122 - jetH, 3.6, 0.9);
  for (const p of P) {
    const x = 64 + p.side * (10 + p.sp * Math.cos(p.th) * T), y = 122 - p.sp * Math.sin(p.th) * T + 0.5 * g * T * T; if (y > 124) continue;
    splat(acc, x, y, p.rad * (p.curtain ? 1 + t * 0.6 : 1), p.w * (1 - t * 0.6));
  }
  const ringR = 6 + 54 * Math.pow(t, 0.7); for (let a = 0; a < 6.2832; a += 0.16) splat(acc, 64 + Math.cos(a) * ringR, 122 + Math.sin(a) * ringR * 0.1, 2.3, 0.3 * (1 - t));
  const k = acc; const out = finish(k, 1.5, 0.3), fade = 1 - clamp((t - 0.78) / 0.22, 0, 1); for (let i = 0; i < out.length; i++) out[i] *= fade; return out;
}
function mistBlobs() { const r = rng(303), B = []; for (let i = 0; i < 40; i++) B.push({ phi: r(), x: 64 + (r() - 0.5) * 78, drift: (r() - 0.5) * 34, r0: 9 + r() * 7, r1: 20 + r() * 14, rise: 62 + r() * 38, sw: r() * 6.28 }); return B; }
function mistFrame(f, B) {
  const t = f / F, acc = new Float32Array(N * N);
  for (const b of B) { let a = t - b.phi; a -= Math.floor(a); const w = Math.pow(Math.sin(Math.PI * a), 1.3) * 0.2; splat(acc, b.x + b.drift * a + Math.sin(a * 6.283 + b.sw) * 3, 118 - b.rise * a, b.r0 + (b.r1 - b.r0) * a, w); }
  return finish(acc, 1.0, 0.16);
}
function bake() {
  const W = COLS * N, sheet = new Uint8Array(W * W * 3), P = sprayParticles(), C = crownParticles(), B = mistBlobs(), frames = { r: [], g: [], b: [] };
  for (let f = 0; f < F; f++) {
    const fr = [sprayFrame(f, P), crownFrame(f, C), mistFrame(f, B)], ox = (f % COLS) * N, oy = Math.floor(f / COLS) * N;
    frames.r.push(fr[0]); frames.g.push(fr[1]); frames.b.push(fr[2]);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = ((oy + y) * W + ox + x) * 3, k = y * N + x; sheet[i] = Math.round(fr[0][k] * 255); sheet[i + 1] = Math.round(fr[1][k] * 255); sheet[i + 2] = Math.round(fr[2][k] * 255); }
  }
  return { sheet, W, frames, N, F, COLS };
}
module.exports = { bake, N, F, COLS };
if (require.main === module) {
  const fs = require('fs'), path = require('path'), out = process.argv[2] || path.join(__dirname, '..', '..', 'assets', 'water'); fs.mkdirSync(out, { recursive: true });
  const b = bake(); const sharp = require('/opt/npm-tools/node_modules/sharp');
  sharp(Buffer.from(b.sheet), { raw: { width: b.W, height: b.W, channels: 3 } }).webp({ lossless: true, effort: 6 }).toFile(path.join(out, 'spray-sheet.webp')).then((i) => console.log('spray-sheet.webp', i.size, 'bytes'));
}
