// (v379) Re-bake a groom's head SDF against the character's REAL bind-pose scalp + head skin, with the sign from a flood fill, then lift the rest groom
// out of it.  Why: Emma_Scalp is a thick shell over her skull; the v2 SDF took its sign from the nearest face normal, so the gap between the shell's
// inner face and the skull read as OUTSIDE and the groom (and the solver) let strands run under the scalp (2,017 rest-groom crossings of the bind
// scalp, tools/tests/hair-scalp.js).  Here every cell the outside air cannot reach without crossing a surface is INSIDE, the grid is native 2.5 mm
// (was 5 mm), and rest points closer than 3 mm are lifted along the new gradient (roots / point 1 stay pinned).
//   node tools/hair/scalp-sdf.mjs emma [--out file.bin] [--cell 0.0025]
import fs from 'fs'; import path from 'path'; import { pathToFileURL, fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const L = await import(pathToFileURL(path.join(ROOT, 'tools/tests/lib-hair-probe.mjs')).href); const { THREE } = L;
const name = process.argv[2] || 'emma', arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const C = L.CHARS[name], OUT = arg('--out', path.join(ROOT, C.bin)), CELL = +arg('--cell', 0.0025);
const MESH = { emma: /^Emma_(Scalp|Body|Eye_[LR]|Cornea_[LR])$/, ariel: /^(Scalp|Ariel_Reach001|Sphere002)$/ }[name];
const g = await L.loadGLB(path.join(ROOT, C.glb)); g.scene.updateMatrixWorld(true);
const tris = []; const v = new THREE.Vector3(), Mb = new THREE.Matrix4(); const scalpTris = [];
g.scene.traverse((o) => { if (!o.isSkinnedMesh || !MESH.test(o.name)) return; const hi = o.skeleton.bones.findIndex(b => b.name === 'Head'); if (hi < 0) return;
  Mb.multiplyMatrices(o.skeleton.boneInverses[hi], o.bindMatrix); const P = o.geometry.attributes.position, ix = o.geometry.index, W = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(Mb); W[i * 3] = v.x; W[i * 3 + 1] = v.y; W[i * 3 + 2] = v.z; }
  const nt = ix ? ix.count / 3 : P.count / 3, isS = /Scalp/.test(o.name);
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) { const q = ix ? ix.getX(t * 3 + c) : t * 3 + c; tris.push(W[q * 3], W[q * 3 + 1], W[q * 3 + 2]); if (isS) scalpTris.push(W[q * 3], W[q * 3 + 1], W[q * 3 + 2]); }
  console.log('mesh', o.name, P.count, 'verts'); });
function grid(T, cell) { let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9; for (let i = 0; i < T.length; i += 3) { x0 = Math.min(x0, T[i]); x1 = Math.max(x1, T[i]); y0 = Math.min(y0, T[i + 1]); y1 = Math.max(y1, T[i + 1]); z0 = Math.min(z0, T[i + 2]); z1 = Math.max(z1, T[i + 2]); }
  const nx = Math.ceil((x1 - x0) / cell) + 1, ny = Math.ceil((y1 - y0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1, cells = new Map(), key = (i, j, k) => (i * ny + j) * nz + k, f = (a, b) => Math.floor((a - b) / cell);
  for (let t = 0; t < T.length / 9; t++) { const o = t * 9; for (let i = f(Math.min(T[o], T[o + 3], T[o + 6]), x0); i <= f(Math.max(T[o], T[o + 3], T[o + 6]), x0); i++) for (let j = f(Math.min(T[o + 1], T[o + 4], T[o + 7]), y0); j <= f(Math.max(T[o + 1], T[o + 4], T[o + 7]), y0); j++) for (let k = f(Math.min(T[o + 2], T[o + 5], T[o + 8]), z0); k <= f(Math.max(T[o + 2], T[o + 5], T[o + 8]), z0); k++) { const q = key(i, j, k); let a = cells.get(q); if (!a) cells.set(q, a = []); a.push(t); } }
  return { T, n: T.length / 9, cell, x0, y0, z0, nx, ny, nz, cells, key, stamp: new Int32Array(T.length / 9), sid: 0 }; }
const GA = grid(new Float32Array(tris), 0.008), GS = grid(new Float32Array(scalpTris), 0.012);
// the groom file
const buf = Buffer.from(fs.readFileSync(path.join(ROOT, C.bin))); const jl = buf.readUInt32LE(4); const meta = JSON.parse(buf.slice(12, 12 + jl).toString()); const ds = 12 + jl;
const s0 = meta.sdf, n0 = s0.dims[0] * s0.dims[1] * s0.dims[2], old = new Int16Array(buf.buffer.slice(buf.byteOffset + ds + s0.byteOffsetFromData, buf.byteOffset + ds + s0.byteOffsetFromData + n0 * 2));
const oldS = (x, y, z) => { const fx = Math.min(s0.dims[0] - 1.001, Math.max(0, (x - s0.origin[0]) / s0.cell)), fy = Math.min(s0.dims[1] - 1.001, Math.max(0, (y - s0.origin[1]) / s0.cell)), fz = Math.min(s0.dims[2] - 1.001, Math.max(0, (z - s0.origin[2]) / s0.cell));
  const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k, [, ny, nz] = s0.dims; let r = 0;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) r += (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (c ? tz : 1 - tz) * old[((i + a) * ny + j + b) * nz + k + c]; return r * (s0.unit || 1e-4); };
// new grid: same box, finer cells
const ext = [0, 1, 2].map(a => (s0.dims[a] - 1) * s0.cell), dims = ext.map(e => Math.round(e / CELL) + 1), [NX, NY, NZ] = dims, NN = NX * NY * NZ, O = s0.origin;
const REACH = 0.012, ud = new Float32Array(NN), sgn = new Int8Array(NN), wall = new Uint8Array(NN); const t0 = Date.now();
for (let i = 0; i < NX; i++) { for (let j = 0; j < NY; j++) for (let k = 0; k < NZ; k++) { const n = (i * NY + j) * NZ + k, x = O[0] + i * CELL, y = O[1] + j * CELL, z = O[2] + k * CELL;
  const r = L.nearest(GA, x, y, z, REACH); if (r) { ud[n] = Math.abs(r.d); sgn[n] = r.d >= 0 ? 1 : -1; if (ud[n] < CELL * 0.75) wall[n] = 1; } else { ud[n] = -1; } }
  if (i % 20 === 0) console.log('dist row', i, '/', NX, ((Date.now() - t0) / 1000).toFixed(0) + ' s'); }
// flood fill the outside air from boundary cells the old field calls clearly outside
const out = new Uint8Array(NN), Q = new Int32Array(NN); let qh = 0, qt = 0;
const seed = (i, j, k) => { const n = (i * NY + j) * NZ + k; if (out[n] || wall[n]) return; if (oldS(O[0] + i * CELL, O[1] + j * CELL, O[2] + k * CELL) > 0.004) { out[n] = 1; Q[qt++] = n; } };
for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) { seed(i, j, 0); seed(i, j, NZ - 1); } for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) { seed(i, 0, k); seed(i, NY - 1, k); } for (let j = 0; j < NY; j++) for (let k = 0; k < NZ; k++) { seed(0, j, k); seed(NX - 1, j, k); }
while (qh < qt) { const n = Q[qh++], i = (n / (NY * NZ)) | 0, j = ((n / NZ) | 0) % NY, k = n % NZ;
  for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const ii = i + a, jj = j + b, kk = k + c; if (ii < 0 || jj < 0 || kk < 0 || ii >= NX || jj >= NY || kk >= NZ) continue; const m = (ii * NY + jj) * NZ + kk; if (out[m] || wall[m]) continue; out[m] = 1; Q[qt++] = m; } }
const unit = 1e-4, V = new Int16Array(NN); let flipped = 0;
for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) for (let k = 0; k < NZ; k++) { const n = (i * NY + j) * NZ + k, x = O[0] + i * CELL, y = O[1] + j * CELL, z = O[2] + k * CELL;
  let d;
  if (ud[n] < 0) d = oldS(x, y, z);   // no surface within reach: the old far field
  else if (out[n]) d = ud[n];
  else if (wall[n]) { let adj = false; for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const ii = i + a, jj = j + b, kk = k + c; if (ii >= 0 && jj >= 0 && kk >= 0 && ii < NX && jj < NY && kk < NZ && out[(ii * NY + jj) * NZ + kk]) { adj = true; break; } } d = adj ? ud[n] * sgn[n] : -ud[n]; }
  else d = -ud[n];
  if (d < 0 && oldS(x, y, z) > 0.0005) flipped++;
  V[n] = Math.max(-32767, Math.min(32767, Math.round(d / unit))); }
console.log('grid', dims, 'cells', NN, 'outside', qt, 'cells the old field had outside, now inside', flipped);
// sample the new field + gradient
const S1 = (x, y, z, g) => { const fx = (x - O[0]) / CELL, fy = (y - O[1]) / CELL, fz = (z - O[2]) / CELL; if (fx < 0 || fy < 0 || fz < 0 || fx >= NX - 1 || fy >= NY - 1 || fz >= NZ - 1) return 1;
  const e = 0.5 * CELL, f = (a, b, c) => { const X = (a - O[0]) / CELL, Y = (b - O[1]) / CELL, Z = (c - O[2]) / CELL, i = Math.min(NX - 2, Math.max(0, X | 0)), j = Math.min(NY - 2, Math.max(0, Y | 0)), k = Math.min(NZ - 2, Math.max(0, Z | 0)), tx = X - i, ty = Y - j, tz = Z - k; let r = 0;
    for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) for (let s = 0; s < 2; s++) r += (p ? tx : 1 - tx) * (q ? ty : 1 - ty) * (s ? tz : 1 - tz) * V[((i + p) * NY + j + q) * NZ + k + s]; return r * unit; };
  if (g) { g[0] = f(x + e, y, z) - f(x - e, y, z); g[1] = f(x, y + e, z) - f(x, y - e, z); g[2] = f(x, y, z + e) - f(x, y, z - e); const l = Math.hypot(g[0], g[1], g[2]) || 1; g[0] /= l; g[1] /= l; g[2] /= l; }
  return f(x, y, z); };
const N = meta.count, K = meta.points, R = new Float32Array(buf.buffer.slice(buf.byteOffset + ds, buf.byteOffset + ds + N * K * 12)), R0 = R.slice();
const census = () => { let cross = 0, inside = 0; for (let s = 0; s < N; s++) for (let k = 2; k < K; k++) { const a = (s * K + k - 1) * 3, c = (s * K + k) * 3; cross += L.crosses(GS, R[a], R[a + 1], R[a + 2], R[c], R[c + 1], R[c + 2]); if (S1(R[c], R[c + 1], R[c + 2]) < 0) inside++; } return { scalpCross: cross, insideNewSDF: inside }; };
console.log('rest before', JSON.stringify(census()));
const CL = 0.003, gg = new Float32Array(3);
for (let pass = 0; pass < 10; pass++) { let moved = 0;
  for (let s = 0; s < N; s++) for (let k = 2; k < K; k++) { const c = (s * K + k) * 3; const d = S1(R[c], R[c + 1], R[c + 2], gg); if (d < CL) { const p = Math.min(0.006, CL - d); R[c] += gg[0] * p; R[c + 1] += gg[1] * p; R[c + 2] += gg[2] * p; moved++; }
    // a segment that still cuts the scalp: lift its far end along the field at the midpoint
    const a = (s * K + k - 1) * 3; if (L.crosses(GS, R[a], R[a + 1], R[a + 2], R[c], R[c + 1], R[c + 2])) { S1((R[a] + R[c]) / 2, (R[a + 1] + R[c + 1]) / 2, (R[a + 2] + R[c + 2]) / 2, gg); R[c] += gg[0] * 0.003; R[c + 1] += gg[1] * 0.003; R[c + 2] += gg[2] * 0.003; moved++; } }
  const r = census(); console.log('lift pass', pass, 'moved', moved, JSON.stringify(r)); if (!moved) break; }
let mx = 0; for (let i = 0; i < R.length; i++) mx = Math.max(mx, Math.abs(R[i] - R0[i])); console.log('max rest move mm', (mx * 1000).toFixed(1));
if (process.argv.includes('--write')) {
  const sOff = s0.byteOffsetFromData, sdfBytes = Buffer.from(V.buffer), pad = (4 - (sdfBytes.length % 4)) % 4;
  const lay = meta.layout || {}, cOff = lay.clusterByteOffsetFromData;
  const head = Buffer.from(buf.slice(ds, ds + sOff)); Buffer.from(R.buffer).copy(head, 0);
  // cluster data only (uint8[N]); never keep a stale scalp band after the SDF size changes
  const tail = cOff != null ? buf.slice(ds + cOff, ds + cOff + N) : Buffer.alloc(0);
  delete meta.sdfBand;
  meta.sdf = Object.assign({}, s0, { cell: CELL, dims, byteOffsetFromData: sOff, note: 'v382: native ' + (CELL * 1000) + ' mm full-field SDF of bind scalp + body skin (same High cell size as Ariel 5 mm x3), flood-fill sign, no scalp-band proxy' });
  if (cOff != null) lay.clusterByteOffsetFromData = sOff + sdfBytes.length + pad;
  meta.note = (meta.note || '') + ' v382: head SDF re-baked at ' + (CELL * 1000) + ' mm (Emma_Scalp + Emma_Body, Ariel High-equivalent full field, flood-fill sign) and the rest lifted >= 3 mm out of it (tools/hair/scalp-sdf.mjs).';
  let js = Buffer.from(JSON.stringify(meta)); const jpad = (4 - ((12 + js.length) % 4)) % 4; js = Buffer.concat([js, Buffer.alloc(jpad, 0x20)]);
  const hdr = Buffer.alloc(12); hdr.write('DHS1', 0); hdr.writeUInt32LE(js.length, 4); hdr.writeUInt32LE(buf.readUInt32LE(8), 8);
  fs.writeFileSync(OUT, Buffer.concat([hdr, js, head, sdfBytes, Buffer.alloc(pad), tail])); console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
}
process.exit(0);
