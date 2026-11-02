'use strict';
// bake_gi_lib.js: geometry helpers for bake_gi.js (GLB reader, planar-chart UV2 packer, BVH, PNG writer). Pure node, no dependencies.
const zlib = require('zlib'), fs = require('fs');

// ── GLB (uncompressed, as produced by build_interior.py / build_mansion.py) ─────────────────────────────────
function readGLB(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + file);
  const jl = b.readUInt32LE(12), json = JSON.parse(b.slice(20, 20 + jl).toString('utf8'));
  const bo = 20 + jl + 8;
  const acc = (i) => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView], n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const off = bo + (v.byteOffset || 0) + (a.byteOffset || 0), ct = a.componentType, stride = v.byteStride || 0;
    const C = ct === 5126 ? Float32Array : ct === 5125 ? Uint32Array : ct === 5123 ? Uint16Array : ct === 5121 ? Uint8Array : null;
    if (!C) throw new Error('component ' + ct);
    const bytes = C.BYTES_PER_ELEMENT, out = new C(a.count * n);
    for (let i2 = 0; i2 < a.count; i2++) for (let k = 0; k < n; k++) {
      const p = off + (stride ? i2 * stride : i2 * n * bytes) + k * bytes;
      out[i2 * n + k] = ct === 5126 ? b.readFloatLE(p) : ct === 5125 ? b.readUInt32LE(p) : ct === 5123 ? b.readUInt16LE(p) : b.readUInt8(p);
    }
    return { data: out, n, count: a.count, norm: !!a.normalized, ct };
  };
  return { json, acc, bin: b, bo };
}

// ── PNG writer (8-bit gray / RGB), deterministic (fixed zlib level) ────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), l = Buffer.alloc(4); l.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); }
function writePNG(file, w, h, ch, px) {   // ch 1 (gray) or 3 (RGB), px Uint8Array
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = 1;   // filter: Sub (smooth data compresses well)
    for (let x = 0; x < w * ch; x++) { const i = (y * w) * ch + x; raw[y * (w * ch + 1) + 1 + x] = (px[i] - (x >= ch ? px[i - ch] : 0)) & 255; }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = ch === 1 ? 0 : 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

// ── deterministic PRNG (mulberry32) ──────────────────────────────────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash2(a, b) { let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b)) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; return h >>> 0; }

// ── BVH over triangles (flat arrays, SAH-lite median split on the longest axis) ──────────────────────────────
// tri: Float32Array 9 per triangle. Returns { nodes: Float32Array (6 bbox + ...), ... } packed for fast traversal.
function buildBVH(tri) {
  const n = tri.length / 9, cen = new Float32Array(n * 3), idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) { idx[i] = i; for (let k = 0; k < 3; k++) cen[i * 3 + k] = (tri[i * 9 + k] + tri[i * 9 + 3 + k] + tri[i * 9 + 6 + k]) / 3; }
  const maxN = 2 * n + 1, bb = new Float32Array(maxN * 6), left = new Int32Array(maxN), cnt = new Int32Array(maxN), first = new Int32Array(maxN); let nn = 0;
  function build(lo, hi) {
    const id = nn++; let x0 = 1e30, y0 = 1e30, z0 = 1e30, x1 = -1e30, y1 = -1e30, z1 = -1e30;
    for (let i = lo; i < hi; i++) { const t = idx[i] * 9; for (let v = 0; v < 3; v++) { const x = tri[t + v * 3], y = tri[t + v * 3 + 1], z = tri[t + v * 3 + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; } }
    bb[id * 6] = x0; bb[id * 6 + 1] = y0; bb[id * 6 + 2] = z0; bb[id * 6 + 3] = x1; bb[id * 6 + 4] = y1; bb[id * 6 + 5] = z1;
    if (hi - lo <= 4) { left[id] = -1; first[id] = lo; cnt[id] = hi - lo; return id; }
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0, ax = ex > ey && ex > ez ? 0 : ey > ez ? 1 : 2;
    const sub = Array.from(idx.subarray(lo, hi)).sort((a, b) => (cen[a * 3 + ax] - cen[b * 3 + ax]) || (a - b));
    for (let i = 0; i < sub.length; i++) idx[lo + i] = sub[i];
    const mid = (lo + hi) >> 1; left[id] = build(lo, mid); const r = build(mid, hi); cnt[id] = 0; first[id] = r; return id;
  }
  build(0, n);
  return { tri, idx, bb: bb.slice(0, nn * 6), left: left.slice(0, nn), cnt: cnt.slice(0, nn), first: first.slice(0, nn), n };
}
const _stack = new Int32Array(128);
// closest hit. out: [t, triIndex, u, v]. returns true on hit with t in (tmin, tmax)
function intersect(B, ox, oy, oz, dx, dy, dz, tmax, out, anyHit) {
  const { tri, idx, bb, left, cnt, first } = B; const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz; let sp = 0, hit = false; _stack[sp++] = 0;
  while (sp) {
    const id = _stack[--sp], b = id * 6;
    let t0 = (bb[b] - ox) * ix, t1 = (bb[b + 3] - ox) * ix, tn = t0 < t1 ? t0 : t1, tf = t0 < t1 ? t1 : t0;
    t0 = (bb[b + 1] - oy) * iy; t1 = (bb[b + 4] - oy) * iy; let a = t0 < t1 ? t0 : t1, c = t0 < t1 ? t1 : t0; if (a > tn) tn = a; if (c < tf) tf = c;
    t0 = (bb[b + 2] - oz) * iz; t1 = (bb[b + 5] - oz) * iz; a = t0 < t1 ? t0 : t1; c = t0 < t1 ? t1 : t0; if (a > tn) tn = a; if (c < tf) tf = c;
    if (tn > tf || tf < 0 || tn > tmax) continue;
    if (left[id] < 0) {
      for (let k = first[id], e = k + cnt[id]; k < e; k++) {
        const ti = idx[k], t = ti * 9;
        const e1x = tri[t + 3] - tri[t], e1y = tri[t + 4] - tri[t + 1], e1z = tri[t + 5] - tri[t + 2], e2x = tri[t + 6] - tri[t], e2y = tri[t + 7] - tri[t + 1], e2z = tri[t + 8] - tri[t + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue; const inv = 1 / det;
        const sx = ox - tri[t], sy = oy - tri[t + 1], sz = oz - tri[t + 2], u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv; if (tt > 1e-4 && tt < tmax) { tmax = tt; out[0] = tt; out[1] = ti; out[2] = u; out[3] = v; hit = true; if (anyHit) return true; }
      }
    } else { _stack[sp++] = first[id]; _stack[sp++] = left[id]; }
  }
  return hit;
}

module.exports = { readGLB, writePNG, rng, hash2, buildBVH, intersect };
