#!/usr/bin/env node
'use strict';
/* bake_gi.js: offline, deterministic baked global illumination for Ariel's mansion interior (JOTS lighting PR 1/4).
 *
 *   node tools/ariel-home/bake_gi.js                       (defaults: 512 lightmap, 256 spp, 3 bounces, all CPU cores)
 *   node tools/ariel-home/bake_gi.js --size 512 --spp 256 --bounces 3 --threads 8 --out assets/ariel-home/gi
 *
 * Needs: node >= 18 and ffmpeg on PATH (only to decode the 128px albedo preview of the atlas for bounce colour). Reads
 *   assets/ariel-home/ariel-home-interior.glb          the interior (3 prims; prim 0 = int_atlas gets the lightmap, prim 1 = int_emit = the lamps = area lights)
 *   assets/ariel-home/ariel-home.glb  (LOD0, optional)  exterior shell, occluder only (glass is transparent)
 *   assets/ariel-home/ariel-home-interior-nav.json      walkable patches -> where the light probes go
 * and writes (all lazy-loaded at runtime by ui/dm-mansion-look.js, never inlined):
 *   gi/ariel-home-interior-gi.json      meta: geometry hash, lightmap gain, files, probe mean
 *   gi/ariel-home-interior-uv2.bin      UV2 (lightmap UV) per vertex of prim 0, Uint16 x2, same vertex order as the GLB (runtime verifies the count + hash)
 *   gi/ariel-home-interior-lm-{512,256}.png   baked irradiance (sRGB 8-bit, value*gain = irradiance); desktop 512, mobile 256
 *   gi/ariel-home-interior-ao-{512,256}.png   baked ambient occlusion (gray); 256 is also the Low-preset map
 *   gi/ariel-home-interior-probes.bin   light-probe grid, spherical harmonics L1 (cosine-convolved irradiance), 12 bytes / probe
 * UV2: coplanar edge-connected quads are merged into planar charts and shelf-packed (bake_gi_uv.js). Light: every emitter triangle is an area light (NEE with
 * shadow rays), constant sky on escaped rays, >= 2 diffuse bounces (default 3) with per-face albedo from the atlas. Everything is seeded per texel/probe, so the
 * output is bit-identical for the same inputs regardless of thread count. */
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const L = require('./bake_gi_lib.js'), UV = require('./bake_gi_uv.js');

const PI = Math.PI, EPS = 0.03;
const LE = 9.0, SKY = [0.30, 0.38, 0.52];   // emitter radiance (per unit area), constant sky radiance

// ── shared scene (identical in main + workers) ─────────────────────────────────────────────────────────────
function loadScene(o) {
  const g = L.readGLB(o.glb), J = g.json, prims = J.meshes[0].primitives;
  const A = prims[0], E = prims[1];
  const P = g.acc(A.attributes.POSITION).data, N = g.acc(A.attributes.NORMAL).data, I = g.acc(A.indices).data, UV0 = g.acc(A.attributes.TEXCOORD_0).data, C = g.acc(A.attributes.COLOR_0);
  const EP = g.acc(E.attributes.POSITION).data, EN = g.acc(E.attributes.NORMAL).data, EI = g.acc(E.indices).data, EC = g.acc(E.attributes.COLOR_0);
  const tris = [], alb = [], kind = [];   // kind 0 interior atlas, 1 emitter, 2 exterior
  // atlas preview for albedo
  const atl = atlasPreview(g, J);
  const faceAlb = (vs) => {   // albedo of a face from the atlas at the face's uv centroid x half the vertex-colour hue
    let u = 0, v = 0, r = 0, gg = 0, b = 0; for (const i of vs) { u += UV0[i * 2]; v += UV0[i * 2 + 1]; r += C.data[i * 4] / 255; gg += C.data[i * 4 + 1] / 255; b += C.data[i * 4 + 2] / 255; }
    const n = vs.length; u /= n; v /= n; r /= n; gg /= n; b /= n; const px = atl.sample(u, v), m = Math.max(r, gg, b, 1e-3), h = [r / m, gg / m, b / m];
    return [0, 1, 2].map(k => Math.min(0.85, Math.max(0.04, px[k] * (0.5 + 0.5 * h[k]))));
  };
  const fcache = new Map();
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    for (const i of [a, b, c]) tris.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    // per-face albedo: quads share vertex ids a..a+3 blocks; use the triangle's own 3 verts + its quad neighbour via cache key (min vertex id)
    const key = Math.min(a, b, c) - (Math.min(a, b, c) % 4); let f = fcache.get(key); if (!f) { f = faceAlb([key, key + 1, key + 2, key + 3].filter(i => i < P.length / 3)); fcache.set(key, f); }
    alb.push(f[0], f[1], f[2]); kind.push(0);
  }
  const nInt = kind.length;
  const emit = [];   // [ax,ay,az,bx,by,bz,cx,cy,cz, nx,ny,nz, area, r,g,b]
  for (let t = 0; t < EI.length / 3; t++) {
    const v = [EI[t * 3], EI[t * 3 + 1], EI[t * 3 + 2]]; const p = v.map(i => [EP[i * 3], EP[i * 3 + 1], EP[i * 3 + 2]]);
    for (const q of p) tris.push(q[0], q[1], q[2]); alb.push(0.3, 0.3, 0.3); kind.push(1);
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2], vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    const nx = EN[v[0] * 3], ny = EN[v[0] * 3 + 1], nz = EN[v[0] * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, ar = 0.5 * Math.hypot(cx, cy, cz); if (ar < 1e-8) continue;
    const col = [0, 1, 2].map(k => (EC.data[v[0] * 4 + k] + EC.data[v[1] * 4 + k] + EC.data[v[2] * 4 + k]) / (3 * 255));
    emit.push([p[0][0], p[0][1], p[0][2], p[1][0], p[1][1], p[1][2], p[2][0], p[2][1], p[2][2], nx, ny, nz, ar, col[0], col[1], col[2]]);
  }
  // exterior occluder (LOD0 only; glass transparent)
  let nExt = 0;
  if (o.occ && fs.existsSync(o.occ)) {
    const x = L.readGLB(o.occ), xj = x.json; const mi = xj.meshes.findIndex(m => /LOD0/.test(m.name)); const xp = xj.meshes[mi].primitives;
    for (const pr of xp) {
      const mn = xj.materials[pr.material].name; if (mn === 'ah_glass') continue;
      const xP = x.acc(pr.attributes.POSITION).data, xI = x.acc(pr.indices).data;
      for (let t = 0; t < xI.length / 3; t++) { for (let k = 0; k < 3; k++) { const i = xI[t * 3 + k]; tris.push(xP[i * 3], xP[i * 3 + 1], xP[i * 3 + 2]); } alb.push(0.4, 0.4, 0.4); kind.push(2); nExt++; }
    }
  }
  return { P, N, I, UV0, nInt, emit, tris: Float32Array.from(tris), alb: Float32Array.from(alb), kind: Uint8Array.from(kind), nExt, nVert: P.length / 3 };
}
function atlasPreview(g, J) {
  const m0 = J.materials[0], ti = m0.pbrMetallicRoughness.baseColorTexture.index, tx = J.textures[ti];
  const src = (tx.extensions && tx.extensions.EXT_texture_webp ? tx.extensions.EXT_texture_webp.source : tx.source), im = J.images[src], bv = J.bufferViews[im.bufferView];
  const data = g.bin.slice(g.bo + (bv.byteOffset || 0), g.bo + (bv.byteOffset || 0) + bv.byteLength), S = 128;
  const r = cp.spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=' + S + ':' + S + ':flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: data, maxBuffer: 1 << 26 });
  if (r.status !== 0 || r.stdout.length !== S * S * 3) throw new Error('ffmpeg could not decode the atlas preview: ' + (r.stderr || '').toString());
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const px = r.stdout;
  return { sample(u, v) { const x = Math.min(S - 1, Math.max(0, Math.floor(u * S))), y = Math.min(S - 1, Math.max(0, Math.floor(v * S))), i = (y * S + x) * 3; return [lin(px[i]), lin(px[i + 1]), lin(px[i + 2])]; } };
}

// ── tracer ────────────────────────────────────────────────────────────────────────────────────────────────
function makeTracer(S) {
  const B = L.buildBVH(S.tris), hit = new Float64Array(4), E = S.emit, ne = E.length;
  const cdf = new Float64Array(ne); let tot = 0; for (let i = 0; i < ne; i++) { tot += E[i][12]; cdf[i] = tot; }
  const triN = (t, out) => { const o = t * 9, T = S.tris, ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2], vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx; const l = Math.hypot(x, y, z) || 1; out[0] = x / l; out[1] = y / l; out[2] = z / l; };
  const n1 = [0, 0, 0], q = [0, 0, 0], d = [0, 0, 0], nrm = [0, 0, 0];
  // direct light at point p with unit normal n (facing the viewer side). Adds irradiance to out[0..2] (one NEE sample, weight w). If dirOut given, also returns the sample dir + flux.
  function nee(px, py, pz, nx, ny, nz, rnd, w, out, sh) {
    if (!ne) return;
    const r = rnd() * tot; let lo = 0, hi = ne - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
    const e = E[lo]; let a = rnd(), b = rnd(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const lx = e[0] + a * (e[3] - e[0]) + b * (e[6] - e[0]), ly = e[1] + a * (e[4] - e[1]) + b * (e[7] - e[1]), lz = e[2] + a * (e[5] - e[2]) + b * (e[8] - e[2]);
    let dx = lx - px, dy = ly - py, dz = lz - pz; const d2 = dx * dx + dy * dy + dz * dz, dl = Math.sqrt(d2); if (dl < 1e-4) return; dx /= dl; dy /= dl; dz /= dl;
    const cs = nx !== null ? nx * dx + ny * dy + nz * dz : 1, cl = -(e[9] * dx + e[10] * dy + e[11] * dz);
    if (cs <= 0 || cl <= 0) return;
    if (intersectAny(px, py, pz, dx, dy, dz, dl - 0.05)) return;
    const k = LE * cs * cl / d2 * tot * w;
    out[0] += k * e[13]; out[1] += k * e[14]; out[2] += k * e[15];
  }
  function intersectAny(ox, oy, oz, dx, dy, dz, tmax) { return L.intersect(B, ox, oy, oz, dx, dy, dz, tmax, hit, true); }
  function cosDir(nx, ny, nz, u1, u2, out) {
    const r = Math.sqrt(u1), ph = 2 * PI * u2, x = r * Math.cos(ph), y = r * Math.sin(ph), z = Math.sqrt(Math.max(0, 1 - u1));
    let tx, ty, tz; if (Math.abs(nx) > 0.9) { tx = 0; ty = 1; tz = 0; } else { tx = 1; ty = 0; tz = 0; }
    let bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx; const bl = Math.hypot(bx, by, bz); bx /= bl; by /= bl; bz /= bl;
    tx = by * nz - bz * ny; ty = bz * nx - bx * nz; tz = bx * ny - by * nx;
    out[0] = tx * x + bx * y + nx * z; out[1] = ty * x + by * y + ny * z; out[2] = tz * x + bz * y + nz * z;
  }
  // radiance arriving along the ray (o,d) (emitters excluded; their light comes in through NEE at the surface that receives it); `bounces` diffuse bounces
  const hd = [0, 0, 0], ed = [0, 0, 0];
  function pathRadiance(ox, oy, oz, dx, dy, dz, bounces, rnd, out) {
    let wr = 1, wg = 1, wb = 1; out[0] = out[1] = out[2] = 0;
    for (let b = 0; b < bounces; b++) {
      if (!L.intersect(B, ox, oy, oz, dx, dy, dz, 1e9, hit, false)) { out[0] += wr * SKY[0]; out[1] += wg * SKY[1]; out[2] += wb * SKY[2]; return; }
      const t = hit[1], tt = hit[0]; triN(t, nrm);
      if (nrm[0] * dx + nrm[1] * dy + nrm[2] * dz > 0) { nrm[0] = -nrm[0]; nrm[1] = -nrm[1]; nrm[2] = -nrm[2]; }
      const px = ox + dx * tt + nrm[0] * EPS, py = oy + dy * tt + nrm[1] * EPS, pz = oz + dz * tt + nrm[2] * EPS;
      wr *= S.alb[t * 3]; wg *= S.alb[t * 3 + 1]; wb *= S.alb[t * 3 + 2];
      ed[0] = ed[1] = ed[2] = 0; nee(px, py, pz, nrm[0], nrm[1], nrm[2], rnd, 1, ed);
      out[0] += wr * ed[0] / PI; out[1] += wg * ed[1] / PI; out[2] += wb * ed[2] / PI;
      cosDir(nrm[0], nrm[1], nrm[2], rnd(), rnd(), hd); ox = px; oy = py; oz = pz; dx = hd[0]; dy = hd[1]; dz = hd[2];
    }
  }
  return { B, nee, pathRadiance, cosDir, intersectAny, hit, tot, ne };
}

// ── worker: texels + probes ────────────────────────────────────────────────────────────────────────────────
if (!isMainThread) {
  const W = workerData, S = loadScene(W.opts), T = makeTracer(S), tmp = [0, 0, 0], dir = [0, 0, 0], lo = [0, 0, 0], de = [0, 0, 0];
  const lm = new Float32Array(W.lmBuf), ao = new Float32Array(W.aoBuf), tp = new Float32Array(W.texPos), tn = new Float32Array(W.texN), tv = new Uint8Array(W.texValid);
  const NN = W.N * W.N;
  for (let i = W.id; i < NN; i += W.threads) {
    if (!tv[i]) continue;
    const rnd = L.rng(L.hash2(W.opts.seed, i)); const x = tp[i * 3], y = tp[i * 3 + 1], z = tp[i * 3 + 2], nx = tn[i * 3], ny = tn[i * 3 + 1], nz = tn[i * 3 + 2];
    const ox = x + nx * EPS, oy = y + ny * EPS, oz = z + nz * EPS; let ar = 0, ag = 0, ab = 0, dr = 0, dg = 0, db = 0, vis = 0;
    for (let s = 0; s < W.opts.spp; s++) {
      de[0] = de[1] = de[2] = 0; T.nee(ox, oy, oz, nx, ny, nz, rnd, 1, de); dr += de[0]; dg += de[1]; db += de[2];
      T.cosDir(nx, ny, nz, rnd(), rnd(), dir); T.pathRadiance(ox, oy, oz, dir[0], dir[1], dir[2], W.opts.bounces, rnd, lo); ar += lo[0]; ag += lo[1]; ab += lo[2];
    }
    const k = 1 / W.opts.spp; lm[i * 3] = dr * k + PI * ar * k; lm[i * 3 + 1] = dg * k + PI * ag * k; lm[i * 3 + 2] = db * k + PI * ab * k;
    for (let s = 0; s < W.opts.aoSpp; s++) { T.cosDir(nx, ny, nz, rnd(), rnd(), dir); if (!T.intersectAny(ox, oy, oz, dir[0], dir[1], dir[2], W.opts.aoR)) vis++; }
    ao[i] = vis / W.opts.aoSpp;
  }
  // probes (positions in GLB frame, interleaved)
  const pb = new Float32Array(W.probeBuf), pp = W.probePos, np = pp.length / 3;
  for (let pi = W.id; pi < np; pi += W.threads) {
    const rnd = L.rng(L.hash2(W.opts.seed ^ 0x51ed, pi)), px = pp[pi * 3], py = pp[pi * 3 + 1], pz = pp[pi * 3 + 2];
    const c = new Float64Array(12);   // per channel: L00, L1x, L1y, L1z (radiance SH projection)
    const K = W.opts.probeSpp, wgt = 4 * PI / K;
    for (let s = 0; s < K; s++) {
      const z = 1 - 2 * ((s + rnd()) / K), r = Math.sqrt(Math.max(0, 1 - z * z)), ph = 2 * PI * rnd(), dx = r * Math.cos(ph), dy = z, dz = r * Math.sin(ph);
      T.pathRadiance(px, py, pz, dx, dy, dz, W.opts.bounces, rnd, lo);
      for (let ch = 0; ch < 3; ch++) { const v = lo[ch] * wgt; c[ch * 4] += v * 0.282095; c[ch * 4 + 1] += v * 0.488603 * dx; c[ch * 4 + 2] += v * 0.488603 * dy; c[ch * 4 + 3] += v * 0.488603 * dz; }
    }
    // direct lamps: delta-like radiance, NEE samples -> L(w_l) = flux
    const KD = W.opts.probeSpp >> 1;
    for (let s = 0; s < KD; s++) {
      // sample a light point and project it as flux along its direction (uses the same estimator as nee() but with a free normal)
      de[0] = de[1] = de[2] = 0; const e0 = T.ne; if (!e0) break;
      const r2 = rnd() * T.tot, E = S.emit; let a = 0, b = E.length - 1, acc = 0, idx = 0; for (let i = 0; i < E.length; i++) { acc += E[i][12]; if (acc >= r2) { idx = i; break; } }
      const e = E[idx]; let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const lx = e[0] + u * (e[3] - e[0]) + v * (e[6] - e[0]), ly = e[1] + u * (e[4] - e[1]) + v * (e[7] - e[1]), lz = e[2] + u * (e[5] - e[2]) + v * (e[8] - e[2]);
      let dx = lx - px, dy = ly - py, dz = lz - pz; const d2 = dx * dx + dy * dy + dz * dz, dl = Math.sqrt(d2); if (dl < 0.1) continue; dx /= dl; dy /= dl; dz /= dl;
      const cl = -(e[9] * dx + e[10] * dy + e[11] * dz); if (cl <= 0) continue; if (T.intersectAny(px, py, pz, dx, dy, dz, dl - 0.05)) continue;
      const flux = LE * cl / d2 * T.tot / KD;
      for (let ch = 0; ch < 3; ch++) { const v2 = flux * e[13 + ch]; c[ch * 4] += v2 * 0.282095; c[ch * 4 + 1] += v2 * 0.488603 * dx; c[ch * 4 + 2] += v2 * 0.488603 * dy; c[ch * 4 + 3] += v2 * 0.488603 * dz; }
    }
    for (let ch = 0; ch < 3; ch++) {   // cosine-convolved irradiance: E(n) = a0 + a . n
      pb[pi * 12 + ch * 4] = PI * c[ch * 4]; for (let k = 1; k < 4; k++) pb[pi * 12 + ch * 4 + k] = (2 * PI / 3) * c[ch * 4 + k];
    }
  }
  parentPort.postMessage('done');
  return;
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; }
async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const o = {
    glb: path.resolve(root, arg('glb', 'assets/ariel-home/ariel-home-interior.glb')), occ: arg('occluder', 'assets/ariel-home/ariel-home.glb'), nav: path.resolve(root, arg('nav', 'assets/ariel-home/ariel-home-interior-nav.json')),
    out: path.resolve(root, arg('out', 'assets/ariel-home/gi')), size: +arg('size', 512), spp: +arg('spp', 256), bounces: +arg('bounces', 3), aoSpp: +arg('ao-samples', 192), aoR: +arg('ao-radius', 7),
    probeStep: +arg('probe-step', 4), probeStepY: +arg('probe-step-z', 3.5), probeSpp: +arg('probe-spp', 768), seed: +arg('seed', 1337), threads: +arg('threads', Math.min(8, require('os').cpus().length)),
  };
  if (o.occ !== 'none') o.occ = path.resolve(root, o.occ); else o.occ = null;
  if (o.bounces < 2) throw new Error('--bounces must be >= 2');
  fs.mkdirSync(o.out, { recursive: true }); const t0 = Date.now();
  const S = loadScene(o); console.log('scene: ' + S.nInt + ' interior tris, ' + S.emit.length + ' emitter tris, ' + S.nExt + ' occluder tris, ' + S.nVert + ' lightmapped verts');
  // UV2
  const lay = UV.layout(S.P, S.I, { N: o.size, minTexel: 2, maxChart: 256 });
  console.log('uv2: ' + lay.charts.length + ' charts, ' + lay.texel.toFixed(2) + ' units/texel (' + (lay.texel * 0.5618).toFixed(2) + ' m)');
  const N = o.size, NN = N * N;
  // texel -> triangle / position / normal (conservative raster, closest point for edge texels)
  const texPos = new Float32Array(NN * 3), texN = new Float32Array(NN * 3), texD = new Float32Array(NN).fill(1e9), texValid = new Uint8Array(NN), texChart = new Int32Array(NN).fill(-1);
  const { P, I, N: NR, uv } = { P: S.P, I: S.I, N: S.N, uv: lay.uv };
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const ax = uv[a * 2] * N, ay = uv[a * 2 + 1] * N, bx = uv[b * 2] * N, by = uv[b * 2 + 1] * N, cx = uv[c * 2] * N, cy = uv[c * 2 + 1] * N;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 1)), x1 = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx) + 1)), y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 1)), y1 = Math.min(N - 1, Math.ceil(Math.max(ay, by, cy) + 1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const bc = closestBary(x + 0.5, y + 0.5, ax, ay, bx, by, cx, cy); if (!bc) continue;
      const qx = bc[0] * ax + bc[1] * bx + bc[2] * cx - (x + 0.5), qy = bc[0] * ay + bc[1] * by + bc[2] * cy - (y + 0.5), dist = Math.hypot(qx, qy);
      if (dist > 0.8) continue; const i = y * N + x; if (dist >= texD[i] - 1e-6) continue; texD[i] = dist; texValid[i] = 1;
      for (let k = 0; k < 3; k++) texPos[i * 3 + k] = bc[0] * P[a * 3 + k] + bc[1] * P[b * 3 + k] + bc[2] * P[c * 3 + k];
      let nx = NR[a * 3] + NR[b * 3] + NR[c * 3], ny = NR[a * 3 + 1] + NR[b * 3 + 1] + NR[c * 3 + 1], nz = NR[a * 3 + 2] + NR[b * 3 + 2] + NR[c * 3 + 2]; const nl = Math.hypot(nx, ny, nz) || 1;
      texN[i * 3] = nx / nl; texN[i * 3 + 1] = ny / nl; texN[i * 3 + 2] = nz / nl; texChart[i] = lay.chartOfTri[t];
    }
  }
  let nValid = 0; for (let i = 0; i < NN; i++) nValid += texValid[i];
  console.log('texels: ' + nValid + ' / ' + NN + ' used (' + (100 * nValid / NN).toFixed(0) + '%)');
  // probe grid (nav frame: x east, y seaward, z up; GLB frame = (x, z, -y))
  const nav = JSON.parse(fs.readFileSync(o.nav, 'utf8')), PG = probeGrid(nav, o);
  console.log('probes: ' + PG.nx + 'x' + PG.ny + 'x' + PG.nz + ' = ' + PG.n + ' (' + PG.nValid + ' walkable)');
  const shared = (arr) => { const s = new SharedArrayBuffer(arr.byteLength); new arr.constructor(s).set(arr); return s; };
  const lmBuf = new SharedArrayBuffer(NN * 3 * 4), aoBuf = new SharedArrayBuffer(NN * 4), probeBuf = new SharedArrayBuffer(PG.n * 12 * 4);
  const tpS = shared(texPos), tnS = shared(texN), tvS = shared(texValid);
  const glbPos = new Float32Array(PG.n * 3); for (let i = 0; i < PG.n; i++) { glbPos[i * 3] = PG.pos[i * 3]; glbPos[i * 3 + 1] = PG.pos[i * 3 + 2]; glbPos[i * 3 + 2] = -PG.pos[i * 3 + 1]; }
  await Promise.all(Array.from({ length: o.threads }, (_, id) => new Promise((res, rej) => {
    const w = new Worker(__filename, { workerData: { id, threads: o.threads, opts: o, N, lmBuf, aoBuf, probeBuf, texPos: tpS, texN: tnS, texValid: tvS, probePos: glbPos } });
    w.on('message', res); w.on('error', rej); w.on('exit', c => { if (c) rej(new Error('worker ' + c)); });
  })));
  console.log('traced in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  const lm = new Float32Array(lmBuf), ao = new Float32Array(aoBuf), pbk = new Float32Array(probeBuf);
  // same-chart 3x3 smoothing (removes the residual Monte-Carlo noise, never crosses a chart edge), then dilate into the gutters
  smooth(lm, 3, N, texValid, texChart); smooth(ao, 1, N, texValid, texChart);
  dilate(lm, 3, N, texValid); dilate(ao, 1, N, texValid);
  // exposure: 99.5th percentile of luminance = 1.0 in the PNG; the runtime multiplies by `gain`
  const lum = []; for (let i = 0; i < NN; i++) if (texValid[i]) lum.push(0.2126 * lm[i * 3] + 0.7152 * lm[i * 3 + 1] + 0.0722 * lm[i * 3 + 2]); lum.sort((a, b) => a - b);
  const gain = Math.max(1e-3, lum[Math.floor(lum.length * 0.995)] * 1.0); const mean = lum.reduce((s, v) => s + v, 0) / lum.length;
  const base = path.join(o.out, 'ariel-home-interior-');
  const enc = (v) => { v = Math.min(1, Math.max(0, v / gain)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); };
  const png = (f, buf, ch, n) => { const px = new Uint8Array(n * n * ch); for (let i = 0; i < n * n * ch; i++) px[i] = ch === 3 ? enc(buf[i]) : Math.round(255 * Math.min(1, Math.max(0, buf[i]))); L.writePNG(f, n, n, ch, px); console.log('  ' + path.basename(f) + ' ' + fs.statSync(f).size + ' B'); };
  png(base + 'lm-' + N + '.png', lm, 3, N); png(base + 'ao-' + N + '.png', ao, 1, N);
  const h = N >> 1, lm2 = new Float32Array(h * h * 3), ao2 = new Float32Array(h * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) { for (let k = 0; k < 3; k++) lm2[(y * h + x) * 3 + k] = (lm[((2 * y) * N + 2 * x) * 3 + k] + lm[((2 * y) * N + 2 * x + 1) * 3 + k] + lm[((2 * y + 1) * N + 2 * x) * 3 + k] + lm[((2 * y + 1) * N + 2 * x + 1) * 3 + k]) / 4; ao2[y * h + x] = (ao[2 * y * N + 2 * x] + ao[2 * y * N + 2 * x + 1] + ao[(2 * y + 1) * N + 2 * x] + ao[(2 * y + 1) * N + 2 * x + 1]) / 4; }
  png(base + 'lm-' + h + '.png', lm2, 3, h); png(base + 'ao-' + h + '.png', ao2, 1, h);
  // UV2 binary
  const u16 = new Uint16Array(S.nVert * 2); for (let i = 0; i < u16.length; i++) u16[i] = Math.round(Math.min(1, Math.max(0, lay.uv[i])) * 65535);
  fs.writeFileSync(base + 'uv2.bin', Buffer.from(u16.buffer)); console.log('  uv2.bin ' + u16.byteLength + ' B');
  // probes: fill the non-walkable cells from neighbours, normalise by gain, quantise
  fillProbes(pbk, PG); for (let i = 0; i < pbk.length; i++) pbk[i] /= gain;
  const pmean = [0, 0, 0]; let pc = 0; for (let i = 0; i < PG.n; i++) if (PG.valid[i]) { for (let ch = 0; ch < 3; ch++) pmean[ch] += pbk[i * 12 + ch * 4]; pc++; } for (let ch = 0; ch < 3; ch++) pmean[ch] /= pc;
  // mean irradiance facing up / down over the walkable probes (GLB +y = up = nav +z): the runtime tints the hemisphere sky/ground colours by E(up)/mean, E(down)/mean
  const pup = [0, 0, 0], pdn = [0, 0, 0]; for (let i = 0; i < PG.n; i++) if (PG.valid[i]) for (let ch = 0; ch < 3; ch++) { pup[ch] += (pbk[i * 12 + ch * 4] + pbk[i * 12 + ch * 4 + 2]) / pc; pdn[ch] += (pbk[i * 12 + ch * 4] - pbk[i * 12 + ch * 4 + 2]) / pc; }
  let m0 = 1e-6, m1 = 1e-6; for (let i = 0; i < PG.n; i++) for (let ch = 0; ch < 3; ch++) { m0 = Math.max(m0, pbk[i * 12 + ch * 4]); for (let k = 1; k < 4; k++) m1 = Math.max(m1, Math.abs(pbk[i * 12 + ch * 4 + k])); }
  const pq = new Uint8Array(PG.n * 12);
  for (let i = 0; i < PG.n; i++) for (let ch = 0; ch < 3; ch++) {
    pq[i * 12 + ch * 4] = Math.round(255 * Math.sqrt(Math.min(1, Math.max(0, pbk[i * 12 + ch * 4] / m0))));
    for (let k = 1; k < 4; k++) { const v = pbk[i * 12 + ch * 4 + k] / m1; pq[i * 12 + ch * 4 + k] = (Math.round(127 * Math.sign(v) * Math.sqrt(Math.min(1, Math.abs(v)))) + 128) & 255; }
  }
  fs.writeFileSync(base + 'probes.bin', Buffer.from(pq)); console.log('  probes.bin ' + pq.length + ' B');
  const hash = crypto.createHash('sha1').update(Buffer.from(S.P.buffer, S.P.byteOffset, S.P.byteLength)).update(Buffer.from(S.I.buffer, S.I.byteOffset, S.I.byteLength)).digest('hex').slice(0, 16);
  const meta = {
    v: 1, verts: S.nVert, hash, psum: posSum(S.P), size: N, texelUnits: +lay.texel.toFixed(3), gain: +gain.toFixed(5), meanIrr: +mean.toFixed(5), aoRadius: o.aoR, bounces: o.bounces, spp: o.spp, seed: o.seed,
    files: { uv2: 'ariel-home-interior-uv2.bin', lm: { 512: 'ariel-home-interior-lm-' + N + '.png', 256: 'ariel-home-interior-lm-' + h + '.png' }, ao: { 512: 'ariel-home-interior-ao-' + N + '.png', 256: 'ariel-home-interior-ao-' + h + '.png' }, probes: 'ariel-home-interior-probes.bin' },
    probes: { frame: 'nav (x east, y seaward, z up)', origin: PG.origin, step: [o.probeStep, o.probeStep, o.probeStepY], dim: [PG.nx, PG.ny, PG.nz], m0: +m0.toFixed(5), m1: +m1.toFixed(5), mean: pmean.map(v => +v.toFixed(5)), up: pup.map(v => +v.toFixed(5)), down: pdn.map(v => +v.toFixed(5)), sh: 'per rgb channel [a0,a1,a2,a3], E(n)=a0+a1*nx+a2*ny+a3*nz in GLB axes (y up); a0 = m0*(q/255)^2, a1..3 = sign*m1*(|q-128|/127)^2; index ((k*ny+j)*nx+i)*12+ch*4' },
  };
  fs.writeFileSync(base + 'gi.json', JSON.stringify(meta) + '\n');
  console.log('done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s; gain ' + meta.gain + ', mean irradiance ' + meta.meanIrr);
}

// cheap geometry fingerprint the runtime can recompute from the loaded GLB (guards against a rebuilt interior GLB with stale lightmaps)
function posSum(P) { let s = 0; for (let i = 0; i < P.length; i += 3) s += P[i] + 3 * P[i + 1] + 7 * P[i + 2]; return Math.round(s * 100) / 100; }
function closestBary(px, py, ax, ay, bx, by, cx, cy) {   // 2D closest point on a triangle -> barycentric (Ericson)
  const abx = bx - ax, aby = by - ay, acx = cx - ax, acy = cy - ay, den = abx * acy - aby * acx; if (Math.abs(den) < 1e-9) return null;
  const apx = px - ax, apy = py - ay, d1 = abx * apx + aby * apy, d2 = acx * apx + acy * apy; if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bpx = px - bx, bpy = py - by, d3 = abx * bpx + aby * bpy, d4 = acx * bpx + acy * bpy; if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cpx = px - cx, cpy = py - cy, d5 = abx * cpx + aby * cpy, d6 = acx * cpx + acy * cpy; if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4; if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
  const dn = 1 / (va + vb + vc); const v = vb * dn, w = vc * dn; return [1 - v - w, v, w];
}
function smooth(buf, ch, N, valid, chart) {
  const src = buf.slice();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x; if (!valid[i]) continue; const acc = [0, 0, 0]; let w = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue; const j = yy * N + xx; if (!valid[j] || chart[j] !== chart[i]) continue; for (let k = 0; k < ch; k++) acc[k] += src[j * ch + k]; w++; }
    for (let k = 0; k < ch; k++) buf[i * ch + k] = acc[k] / w;
  }
}
function dilate(buf, ch, N, valid0) {
  let valid = Uint8Array.from(valid0);
  for (let pass = 0; pass < 6; pass++) {
    const nv = Uint8Array.from(valid), src = buf.slice();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x; if (valid[i]) continue; const acc = [0, 0, 0]; let w = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue; const j = yy * N + xx; if (!valid[j]) continue; for (let k = 0; k < ch; k++) acc[k] += src[j * ch + k]; w++; }
      if (w) { for (let k = 0; k < ch; k++) buf[i * ch + k] = acc[k] / w; nv[i] = 1; }
    }
    valid = nv;
  }
  const m = new Array(ch).fill(0); let c = 0; for (let i = 0; i < N * N; i++) if (valid0[i]) { for (let k = 0; k < ch; k++) m[k] += buf[i * ch + k]; c++; }
  for (let i = 0; i < N * N; i++) if (!valid[i]) for (let k = 0; k < ch; k++) buf[i * ch + k] = m[k] / c;
}
// walkable-volume probe grid from the nav patches (nav frame). A cell is "walkable" if a patch lies 1.2..5.5 below it.
function probeGrid(nav, o) {
  const b = nav.bbox, sx = o.probeStep, sz = o.probeStepY, x0 = Math.floor(b[0] / sx) * sx, y0 = Math.floor(b[1] / sx) * sx, z0 = 0.5;
  const nx = Math.ceil((b[2] - x0) / sx) + 1, ny = Math.ceil((b[3] - y0) / sx) + 1, nz = 5, n = nx * ny * nz;
  const pos = new Float32Array(n * 3), valid = new Uint8Array(n); let nValid = 0;
  const inPoly = (p, x, y) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, yi] = p[i], [xj, yj] = p[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const hAt = (a, x, y) => {
    if (a[0] === 'p') { const xs = a[1].map(q => q[0]), ys = a[1].map(q => q[1]); if (x < Math.min(...xs) || x > Math.max(...xs) || y < Math.min(...ys) || y > Math.max(...ys) || !inPoly(a[1], x, y)) return NaN; return a[2]; }
    if (x < a[1] || x > a[3] || y < a[2] || y > a[4]) return NaN; if (a[0] === 's') { const u = a[5] === 'y' ? (y - a[2]) / (a[4] - a[2]) : (x - a[1]) / (a[3] - a[1]); return a[6] + (a[7] - a[6]) * u; } return a[5];
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const id = (k * ny + j) * nx + i, x = x0 + i * sx, y = y0 + j * sx, z = z0 + k * sz; pos[id * 3] = x; pos[id * 3 + 1] = y; pos[id * 3 + 2] = z;
    for (const p of nav.patches) { const h = hAt(p, x, y); if (h === h && z - h >= 1.2 && z - h <= 5.5) { valid[id] = 1; nValid++; break; } }
  }
  return { nx, ny, nz, n, pos, valid, nValid, origin: [x0, y0, z0] };
}
function fillProbes(pb, PG) {
  let have = Uint8Array.from(PG.valid); const { nx, ny, nz } = PG;
  for (let pass = 0; pass < 12; pass++) {
    const nh = Uint8Array.from(have), src = pb.slice(); let any = false;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = (k * ny + j) * nx + i; if (have[id]) continue; const acc = new Float64Array(12); let w = 0;
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const a = i + di, b = j + dj, c = k + dk; if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue; const q = (c * ny + b) * nx + a; if (!have[q]) continue; for (let m = 0; m < 12; m++) acc[m] += src[q * 12 + m]; w++; }
      if (w) { for (let m = 0; m < 12; m++) pb[id * 12 + m] = acc[m] / w; nh[id] = 1; any = true; }
    }
    have = nh; if (!any) break;
  }
  const m = new Float64Array(12); let c = 0; for (let i = 0; i < PG.n; i++) if (PG.valid[i]) { for (let q = 0; q < 12; q++) m[q] += pb[i * 12 + q]; c++; }
  for (let i = 0; i < PG.n; i++) if (!have[i]) for (let q = 0; q < 12; q++) pb[i * 12 + q] = m[q] / c;
  PG.valid = PG.valid;
}
main().catch(e => { console.error(e); process.exit(1); });
