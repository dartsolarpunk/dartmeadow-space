'use strict';
// bake_gi_uv.js: lightmap UV2 for the merged interior mesh = planar charts (coplanar edge-connected quads merged), shelf-packed into an N x N atlas.
// Deterministic: charts are ordered by (height desc, width desc, first-triangle index). Vertex order of the GLB is never changed; UV2 is a parallel array.
const G = 2;   // gutter texels around each chart (bilinear + one level of 2x downsample stay inside the chart)

function layout(P, I, opts) {
  // P: Float32Array positions (xyz per vertex, GLB frame), I: Uint32Array triangle indices. opts: { N, minTexel, maxTexel, maxChartTexels }
  const nT = I.length / 3, nV = P.length / 3, N = opts.N;
  // 1. faces = triangles connected through shared vertex indices (a quad's two triangles)
  const par = new Int32Array(nV); for (let i = 0; i < nV; i++) par[i] = i;
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let t = 0; t < nT; t++) { const a = find(I[t * 3]), b = find(I[t * 3 + 1]), c = find(I[t * 3 + 2]); par[b] = a; par[find(c)] = a; }
  const faceOf = new Map(), faces = [];
  for (let t = 0; t < nT; t++) { const r = find(I[t * 3]); let f = faceOf.get(r); if (f === undefined) { f = faces.length; faceOf.set(r, f); faces.push({ tris: [], verts: new Set() }); } faces[f].tris.push(t); for (let k = 0; k < 3; k++) faces[f].verts.add(I[t * 3 + k]); }
  // 2. face normal / plane
  for (const f of faces) {
    const t = f.tris[0], a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    f.n = [nx, ny, nz]; f.d = nx * P[a] + ny * P[a + 1] + nz * P[a + 2];
    // flat faces only: if any vertex is off the plane the face still works (projected), the bake just samples the projected position
  }
  // 3. merge coplanar faces that share an edge (same quantised endpoints)
  const fp = faces.map((_, i) => i); const ff = (a) => { while (fp[a] !== a) { fp[a] = fp[fp[a]]; a = fp[a]; } return a; };
  const q = (v) => Math.round(P[v * 3] * 100) + ',' + Math.round(P[v * 3 + 1] * 100) + ',' + Math.round(P[v * 3 + 2] * 100);
  const edges = new Map();
  faces.forEach((f, fi) => {
    for (const t of f.tris) for (let k = 0; k < 3; k++) {
      const a = q(I[t * 3 + k]), b = q(I[t * 3 + (k + 1) % 3]); if (a === b) continue; const key = a < b ? a + '|' + b : b + '|' + a;
      const l = edges.get(key); if (!l) edges.set(key, [fi]); else if (l.indexOf(fi) < 0) l.push(fi);
    }
  });
  for (const l of edges.values()) {
    if (l.length < 2) continue;
    for (let i = 1; i < l.length; i++) {
      const A = faces[l[0]], B = faces[l[i]];
      if (A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2] > 0.9995 && Math.abs(A.d - B.d) < 0.02) fp[ff(l[i])] = ff(l[0]);
    }
  }
  const chartMap = new Map(), charts = [];
  faces.forEach((f, fi) => { const r = ff(fi); let c = chartMap.get(r); if (!c) { c = { faces: [], n: faces[r].n, first: fi }; chartMap.set(r, c); charts.push(c); } c.faces.push(f); if (fi < c.first) c.first = fi; });
  // 4. chart basis + extents
  for (const c of charts) {
    const n = c.n, an = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])]; let u, v;
    if (an[1] > 0.999) { u = [1, 0, 0]; v = [0, 0, 1]; } else if (an[0] > 0.999) { u = [0, 0, 1]; v = [0, 1, 0]; } else if (an[2] > 0.999) { u = [1, 0, 0]; v = [0, 1, 0]; }
    else { u = [n[2], 0, -n[0]]; const l = Math.hypot(u[0], u[2]) || 1; u = [u[0] / l, 0, u[2] / l]; v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]; }
    c.u = u; c.v = v; let u0 = 1e30, u1 = -1e30, v0 = 1e30, v1 = -1e30;
    for (const f of c.faces) for (const vi of f.verts) { const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2], pu = x * u[0] + y * u[1] + z * u[2], pv = x * v[0] + y * v[1] + z * v[2]; if (pu < u0) u0 = pu; if (pu > u1) u1 = pu; if (pv < v0) v0 = pv; if (pv > v1) v1 = pv; }
    c.u0 = u0; c.v0 = v0; c.w = Math.max(u1 - u0, 1e-4); c.h = Math.max(v1 - v0, 1e-4);
  }
  // 5. choose the texel size (world units per texel) so everything fits N x N; then pack
  charts.sort((a, b) => 0);
  const mk = (d) => {
    const items = charts.map((c, i) => { const sw = Math.min(opts.maxChart, Math.max(opts.minTexel, Math.ceil(c.w / d - 1e-6))), sh = Math.min(opts.maxChart, Math.max(opts.minTexel, Math.ceil(c.h / d - 1e-6))); return { i, sw, sh }; });
    items.sort((a, b) => (b.sh - a.sh) || (b.sw - a.sw) || (charts[a.i].first - charts[b.i].first));
    let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      const w = it.sw + 2 * G, h = it.sh + 2 * G;
      if (x + w > N) { x = 0; y += rowH; rowH = 0; }
      if (y + h > N || w > N) return null;
      it.x = x + G; it.y = y + G; x += w; if (h > rowH) rowH = h;
    }
    return items;
  };
  let lo = opts.minD || 0.25, hi = 64, best = null, bd = hi;
  for (let it = 0; it < 40; it++) { const m = Math.sqrt(lo * hi), r = mk(m); if (r) { best = r; bd = m; hi = m; } else lo = m; if (hi / lo < 1.002) break; }
  if (!best) throw new Error('lightmap layout failed to fit ' + N + 'x' + N);
  const uv = new Float32Array(nV * 2), chartOfTri = new Int32Array(nT);
  for (const it of best) {
    const c = charts[it.i]; c.px = it.x; c.py = it.y; c.sw = it.sw; c.sh = it.sh;
    const ci = it.i;
    for (const f of c.faces) {
      for (const t of f.tris) chartOfTri[t] = ci;
      for (const vi of f.verts) {
        const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2], pu = x * c.u[0] + y * c.u[1] + z * c.u[2] - c.u0, pv = x * c.v[0] + y * c.v[1] + z * c.v[2] - c.v0;
        uv[vi * 2] = (c.px + pu / c.w * c.sw) / N; uv[vi * 2 + 1] = (c.py + pv / c.h * c.sh) / N;
      }
    }
  }
  return { uv, charts, chartOfTri, texel: bd, faces: faces.length, N };
}
module.exports = { layout, G };
