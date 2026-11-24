// (v380) Scalp-band SDF: a sparse 1.25 mm layer of the head field around the scalp, baked from the character's REAL bind-pose scalp + head skin
// (the same meshes and flood-fill sign as tools/hair/scalp-sdf.mjs), appended to the groom file as meta.sdfBand.  Why: Emma's head field is native
// 2.5 mm and the load-time refine (hair_strands.js) is clamped at 1.6 mm cells for memory, so at collision tier 2 her scalp was coarser than Ariel's
// (5 mm x3 = 1.7 mm) and the thin / curved parts of the Emma_Scalp shell (crown, part line, hairline, nape edge) were only seen at 2.5 mm.  The band
// keeps a full-res field only where hair meets the scalp: 8^3-cell bricks (9^3 values with the shared border) whose centre lies within
// BAND of the Emma_Scalp surface.  The groom, the 2.5 mm field and everything else in the file are byte-identical; re-running replaces the band.
//   node tools/hair/scalp-band.mjs emma [--cell 0.00125] [--band 0.006] [--out file.bin] [--no-lift]
// Run it on the v379 groom (characterassests/emma/emma_hair_strands.bin as of c6d11c0); re-running replaces the band and re-checks the chords.
import fs from 'fs'; import path from 'path'; import { pathToFileURL, fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const L = await import(pathToFileURL(path.join(ROOT, 'tools/tests/lib-hair-probe.mjs')).href); const { THREE } = L;
const name = process.argv[2] || 'emma', arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const C = L.CHARS[name], OUT = arg('--out', path.join(ROOT, C.bin)), CELL = +arg('--cell', 0.00125), BAND = +arg('--band', 0.006), BR = 8, BV = BR + 1, BV3 = BV * BV * BV;
const MESH = { emma: /^Emma_(Scalp|Body|Eye_[LR]|Cornea_[LR])$/ }[name]; if (!MESH) throw new Error('no scalp-band mesh set for ' + name);
const g = await L.loadGLB(path.join(ROOT, C.glb)); g.scene.updateMatrixWorld(true);
const tris = [], scalpTris = []; const v = new THREE.Vector3(), Mb = new THREE.Matrix4();
g.scene.traverse((o) => { if (!o.isSkinnedMesh || !MESH.test(o.name)) return; const hi = o.skeleton.bones.findIndex(b => b.name === 'Head'); if (hi < 0) return;
  Mb.multiplyMatrices(o.skeleton.boneInverses[hi], o.bindMatrix); const P = o.geometry.attributes.position, ix = o.geometry.index, W = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(Mb); W[i * 3] = v.x; W[i * 3 + 1] = v.y; W[i * 3 + 2] = v.z; }
  const nt = ix ? ix.count / 3 : P.count / 3, isS = /Scalp/.test(o.name);
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) { const q = ix ? ix.getX(t * 3 + c) : t * 3 + c; tris.push(W[q * 3], W[q * 3 + 1], W[q * 3 + 2]); if (isS) scalpTris.push(W[q * 3], W[q * 3 + 1], W[q * 3 + 2]); } });
function grid(T, cell) { let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9; for (let i = 0; i < T.length; i += 3) { x0 = Math.min(x0, T[i]); x1 = Math.max(x1, T[i]); y0 = Math.min(y0, T[i + 1]); y1 = Math.max(y1, T[i + 1]); z0 = Math.min(z0, T[i + 2]); z1 = Math.max(z1, T[i + 2]); }
  const nx = Math.ceil((x1 - x0) / cell) + 1, ny = Math.ceil((y1 - y0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1, cells = new Map(), key = (i, j, k) => (i * ny + j) * nz + k, f = (a, b) => Math.floor((a - b) / cell);
  for (let t = 0; t < T.length / 9; t++) { const o = t * 9; for (let i = f(Math.min(T[o], T[o + 3], T[o + 6]), x0); i <= f(Math.max(T[o], T[o + 3], T[o + 6]), x0); i++) for (let j = f(Math.min(T[o + 1], T[o + 4], T[o + 7]), y0); j <= f(Math.max(T[o + 1], T[o + 4], T[o + 7]), y0); j++) for (let k = f(Math.min(T[o + 2], T[o + 5], T[o + 8]), z0); k <= f(Math.max(T[o + 2], T[o + 5], T[o + 8]), z0); k++) { const q = key(i, j, k); let a = cells.get(q); if (!a) cells.set(q, a = []); a.push(t); } }
  return { T, n: T.length / 9, cell, x0, y0, z0, nx, ny, nz, cells, key, stamp: new Int32Array(T.length / 9), sid: 0, bb: [x0, y0, z0, x1, y1, z1] }; }
const GA = grid(new Float32Array(tris), 0.006), GS = grid(new Float32Array(scalpTris), 0.012);
// the groom file (any previous band is dropped: it is always the last block)
const buf = Buffer.from(fs.readFileSync(path.join(ROOT, C.bin))); const jl = buf.readUInt32LE(4); const meta = JSON.parse(buf.slice(12, 12 + jl).toString()); const ds = 12 + jl;
let dataEnd = buf.length - ds; if (meta.sdfBand) { dataEnd = meta.sdfBand.indexByteOffsetFromData; delete meta.sdfBand; }
const s0 = meta.sdf, [cx, cy, cz] = s0.dims, CV = new Int16Array(buf.buffer.slice(buf.byteOffset + ds + s0.byteOffsetFromData, buf.byteOffset + ds + s0.byteOffsetFromData + cx * cy * cz * 2)), unit = s0.unit || 1e-4;
const coarse = (x, y, z) => { const fx = (x - s0.origin[0]) / s0.cell, fy = (y - s0.origin[1]) / s0.cell, fz = (z - s0.origin[2]) / s0.cell; if (fx < 0 || fy < 0 || fz < 0 || fx >= cx - 1 || fy >= cy - 1 || fz >= cz - 1) return 1;
  const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k; let r = 0;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) r += (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (c ? tz : 1 - tz) * CV[((i + a) * cy + j + b) * cz + k + c]; return r * unit; };
// band box: the scalp's bounds + BAND + one brick, inside the coarse box
const bs = BR * CELL, M0 = BAND + bs, sb = GS.bb;
const O = [0, 1, 2].map(a => Math.max(s0.origin[a], sb[a] - M0)), E1 = [0, 1, 2].map(a => Math.min(s0.origin[a] + (s0.dims[a] - 1) * s0.cell, sb[a + 3] + M0));
const BD = [0, 1, 2].map(a => Math.max(1, Math.floor((E1[a] - O[a]) / bs))), [BX, BY, BZ] = BD, FX = BX * BR + 1, FY = BY * BR + 1, FZ = BZ * BR + 1;
// active bricks: centre within BAND + half a brick diagonal of the scalp
const idx = new Int32Array(BX * BY * BZ).fill(-1); let NB = 0; const reachB = BAND + bs * 0.87;
for (let i = 0; i < BX; i++) for (let j = 0; j < BY; j++) for (let k = 0; k < BZ; k++) { const r = L.nearest(GS, O[0] + (i + 0.5) * bs, O[1] + (j + 0.5) * bs, O[2] + (k + 0.5) * bs, reachB); if (r && Math.abs(r.d) <= reachB) idx[(i * BY + j) * BZ + k] = NB++; }
console.log(name, 'band box bricks', BD, 'active', NB, 'of', BX * BY * BZ, '->', (NB * BV3 * 2 / 1e6).toFixed(2), 'MB');
// fine nodes of the active bricks (dense flags over the fine box; values only where used)
const FN = FX * FY * FZ, use = new Uint8Array(FN), ud = new Float32Array(FN), sn = new Int8Array(FN), wall = new Uint8Array(FN), out = new Uint8Array(FN), nid = (i, j, k) => (i * FY + j) * FZ + k;
for (let i = 0; i < BX; i++) for (let j = 0; j < BY; j++) for (let k = 0; k < BZ; k++) if (idx[(i * BY + j) * BZ + k] >= 0)
  for (let a = 0; a < BV; a++) for (let b = 0; b < BV; b++) for (let c = 0; c < BV; c++) use[nid(i * BR + a, j * BR + b, k * BR + c)] = 1;
const t0 = Date.now(); let nu = 0; const REACH = BAND + bs * 2;
for (let i = 0; i < FX; i++) { for (let j = 0; j < FY; j++) for (let k = 0; k < FZ; k++) { const n = nid(i, j, k); if (!use[n]) continue; nu++;
  const r = L.nearest(GA, O[0] + i * CELL, O[1] + j * CELL, O[2] + k * CELL, REACH); if (r) { ud[n] = Math.abs(r.d); sn[n] = r.d >= 0 ? 1 : -1; if (ud[n] < CELL * 0.75) wall[n] = 1; } else ud[n] = -1; }
  if (i % 40 === 0) console.log('row', i, '/', FX, ((Date.now() - t0) / 1000).toFixed(0) + ' s'); }
// outside air inside the band: seeded where the (flood-filled) 2.5 mm field is clearly outside, grown through non-wall band nodes
const Q = new Int32Array(nu + 1); let qh = 0, qt = 0;
for (let i = 0; i < FX; i++) for (let j = 0; j < FY; j++) for (let k = 0; k < FZ; k++) { const n = nid(i, j, k); if (!use[n] || wall[n]) continue; if (coarse(O[0] + i * CELL, O[1] + j * CELL, O[2] + k * CELL) > 0.003) { out[n] = 1; Q[qt++] = n; } }
const NBR = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
while (qh < qt) { const n = Q[qh++], i = (n / (FY * FZ)) | 0, j = ((n / FZ) | 0) % FY, k = n % FZ;
  for (const [a, b, c] of NBR) { const ii = i + a, jj = j + b, kk = k + c; if (ii < 0 || jj < 0 || kk < 0 || ii >= FX || jj >= FY || kk >= FZ) continue; const m = nid(ii, jj, kk); if (!use[m] || out[m] || wall[m]) continue; out[m] = 1; Q[qt++] = m; } }
// brick values
const BVAL = new Int16Array(NB * BV3); let flips = 0, nIn = 0;
for (let i = 0; i < BX; i++) for (let j = 0; j < BY; j++) for (let k = 0; k < BZ; k++) { const s = idx[(i * BY + j) * BZ + k]; if (s < 0) continue;
  for (let a = 0; a < BV; a++) for (let b = 0; b < BV; b++) for (let c = 0; c < BV; c++) { const I = i * BR + a, J = j * BR + b, K = k * BR + c, n = nid(I, J, K), x = O[0] + I * CELL, y = O[1] + J * CELL, z = O[2] + K * CELL;
    let d; const cd = coarse(x, y, z);
    if (ud[n] < 0) d = cd;
    else if (out[n]) d = ud[n];
    else if (wall[n]) { let adj = false; for (const [p, q, r] of NBR) { const ii = I + p, jj = J + q, kk = K + r; if (ii >= 0 && jj >= 0 && kk >= 0 && ii < FX && jj < FY && kk < FZ && out[nid(ii, jj, kk)]) adj = true; } d = adj ? ud[n] * sn[n] : -ud[n]; }
    else d = -ud[n];
    if (d < 0) nIn++; if ((d < 0) !== (cd < 0)) flips++;
    BVAL[s * BV3 + (a * BV + b) * BV + c] = Math.max(-32767, Math.min(32767, Math.round(d / unit))); } }
console.log('band nodes', nu, 'inside', nIn, 'sign differs from the 2.5 mm field', flips, ((Date.now() - t0) / 1000).toFixed(0) + ' s');
const data = Buffer.from(buf.slice(ds, ds + dataEnd));
// rest-groom chords through the scalp: a strand segment (k-1 -> k, k >= 2) whose straight chord passes through an Emma_Scalp triangle is drawn as
// a ribbon cutting the scalp even when both of its points are clear (the ribbons are those chords, and the child strands are only collided once
// deflected).  Lift point k along the band field's gradient at the crossing until the chord is clear (roots / point 1 stay pinned).  --no-lift skips.
const band = (x, y, z, g) => { const fx = (x - O[0]) / CELL, fy = (y - O[1]) / CELL, fz = (z - O[2]) / CELL, bi = Math.floor(fx / BR), bj = Math.floor(fy / BR), bk = Math.floor(fz / BR);
  const e = CELL * 0.5, at = (X, Y, Z) => { const ax = (X - O[0]) / CELL, ay = (Y - O[1]) / CELL, az = (Z - O[2]) / CELL, i = Math.floor(ax / BR), j = Math.floor(ay / BR), k = Math.floor(az / BR);
    if (i < 0 || j < 0 || k < 0 || i >= BX || j >= BY || k >= BZ || idx[(i * BY + j) * BZ + k] < 0) return coarse(X, Y, Z); const s = idx[(i * BY + j) * BZ + k];
    const lx = ax - i * BR, ly = ay - j * BR, lz = az - k * BR, a0 = Math.min(BR - 1, lx | 0), b0 = Math.min(BR - 1, ly | 0), c0 = Math.min(BR - 1, lz | 0), tx = lx - a0, ty = ly - b0, tz = lz - c0; let r = 0;
    for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) for (let w = 0; w < 2; w++) r += (p ? tx : 1 - tx) * (q ? ty : 1 - ty) * (w ? tz : 1 - tz) * BVAL[s * BV3 + ((a0 + p) * BV + b0 + q) * BV + c0 + w]; return r * unit; };
  if (g) { g[0] = at(x + e, y, z) - at(x - e, y, z); g[1] = at(x, y + e, z) - at(x, y - e, z); g[2] = at(x, y, z + e) - at(x, y, z - e); const l = Math.hypot(g[0], g[1], g[2]) || 1; g[0] /= l; g[1] /= l; g[2] /= l; }
  return at(x, y, z); };
if (!process.argv.includes('--no-lift')) {
  const N = meta.count, K = meta.points, R = new Float32Array(data.buffer, data.byteOffset, N * K * 3), gg = [0, 0, 0], R0 = R.slice(); let moved = 0, maxMove = 0, big = 0;
  const cross = (s, k) => { const a = (s * K + k - 1) * 3, c = (s * K + k) * 3; return L.crosses(GS, R[a], R[a + 1], R[a + 2], R[c], R[c + 1], R[c + 2]); };
  const count = () => { let n = 0; for (let s = 0; s < N; s++) for (let k = 2; k < K; k++) n += cross(s, k) ? 1 : 0; return n; };
  console.log('rest chords through', name + '_Scalp before', count());
  for (let pass = 0; pass < 24; pass++) { let m = 0;
    for (let s = 0; s < N; s++) for (let k = 2; k < K; k++) { if (!cross(s, k)) continue; const a = (s * K + k - 1) * 3, c = (s * K + k) * 3;
      // sample the chord, find its deepest point, push point k out by twice that depth (+1 mm) along the gradient there (the midpoint moves by the depth)
      let dm = 1e9, best = 0.5; for (let t = 0.05; t < 1; t += 0.05) { const d = band(R[a] + (R[c] - R[a]) * t, R[a + 1] + (R[c + 1] - R[a + 1]) * t, R[a + 2] + (R[c + 2] - R[a + 2]) * t); if (d < dm) { dm = d; best = t; } }
      band(R[a] + (R[c] - R[a]) * best, R[a + 1] + (R[c + 1] - R[a + 1]) * best, R[a + 2] + (R[c + 2] - R[a + 2]) * best, gg);
      // both ends move by the depth (+1 mm) when point k-1 is free, so the chord lifts as a whole and nothing kinks; with k-1 pinned (k = 2) point k
      // takes it alone, scaled by where the chord dips.  At most 4 mm a pass, so a deep dip is walked out over a few passes along the updated gradient.
      const dep = Math.max(0, -dm) + 0.001, both = k - 1 >= 2, push = Math.min(0.004, both ? dep : dep / Math.max(0.25, best));
      R[c] += gg[0] * push; R[c + 1] += gg[1] * push; R[c + 2] += gg[2] * push; if (both) { R[a] += gg[0] * push; R[a + 1] += gg[1] * push; R[a + 2] += gg[2] * push; }
      m++; }
    moved += m; if (!m) break; }
  for (let i = 0; i < N * K * 3; i += 3) { const mv = Math.hypot(R[i] - R0[i], R[i + 1] - R0[i + 1], R[i + 2] - R0[i + 2]); if (mv > maxMove) maxMove = mv; if (mv > 0.005) big++; }
  console.log('rest chords through', name + '_Scalp after', count(), 'lifts', moved, 'max point move mm', (maxMove * 1000).toFixed(1), 'points moved > 5 mm', big);
}
// write: header + meta + data[0, dataEnd) + index (int32) + bricks (int16)
const pad = (4 - (data.length % 4)) % 4, iOff = data.length + pad, ib = Buffer.from(idx.buffer), vOff = iOff + ib.length, vb = Buffer.from(BVAL.buffer);
meta.sdfBand = { cell: CELL, brick: BR, origin: O, bdims: BD, count: NB, unit, band: BAND, indexByteOffsetFromData: iOff, byteOffsetFromData: vOff,
  note: 'v380: sparse ' + (CELL * 1000) + ' mm scalp band (bricks within ' + (BAND * 1000) + ' mm of ' + name + '_Scalp), same meshes + flood-fill sign as meta.sdf; read where present, meta.sdf elsewhere' };
let js = Buffer.from(JSON.stringify(meta)); const jpad = (4 - ((12 + js.length) % 4)) % 4; js = Buffer.concat([js, Buffer.alloc(jpad, 0x20)]);
const hdr = Buffer.alloc(12); hdr.write('DHS1', 0); hdr.writeUInt32LE(js.length, 4); hdr.writeUInt32LE(buf.readUInt32LE(8), 8);
fs.writeFileSync(OUT, Buffer.concat([hdr, js, data, Buffer.alloc(pad), ib, vb])); console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
process.exit(0);
