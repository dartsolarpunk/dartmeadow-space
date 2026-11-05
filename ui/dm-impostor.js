/* DART Meadow — distant IMPOSTOR meshes (far-range LOD, sw v280).
 *
 * WHY: past ~1.5 km the mansion + its cliff are a few hundred pixels; LOD1 (15k triangles, 12 materials, 12 draw calls) is far more than they deserve, and a silhouette that is
 * thinned by a generic decimator loses the cliff edge.  The impostor is the LOD1 geometry merged into ONE mesh, re-meshed by VERTEX CLUSTERING (grid cell x normal octant, so a thin
 * wall's two faces and a cliff's top and front stay separate), with the material colour BAKED into vertex colours (the base-colour map sampled at each vertex through a 64 px
 * copy).  One draw call, ~1.6-4 k triangles, silhouette within one cell of the original, fog-faded like everything else (scene fog), never missing: it is built from the same
 * geometry, so no face the LOD1 has is absent.
 *
 * Pure core (node-tested: tools/tests/lod-unit.js):  simplify(pos, nor, col, idx, cell) · fitCell(pos, idx, targetTris) · merge(parts)
 * Browser:  DMImpostor.build(lodRoot, T, opts) -> { geometry, material, tris, ms } | null   (opts.tris target; DMLod table 'impostor.tris')
 */
(function (root) {
  'use strict';

  /* Vertex clustering.  pos/nor/col: Float32Array xyz per vertex (col optional), idx: Uint32Array|Uint16Array|Array triangle list.  Vertices fall in the same cluster when they share a
     grid cell of size `cell` and the sign octant of their normal.  Cluster position = mean of members, normal = normalised sum, colour = mean.  Triangles with two members in one cluster
     collapse and are dropped; duplicates (same three clusters, any order) are dropped.  Deterministic (first-seen order). */
  function simplify(pos, nor, col, idx, cell) {
    const n = pos.length / 3, inv = 1 / cell, map = new Map(), cid = new Int32Array(n);
    const sx = [], sy = [], sz = [], nx = [], ny = [], nz = [], cr = [], cg = [], cb = [], cnt = [];
    for (let v = 0; v < n; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (!(isFinite(x) && isFinite(y) && isFinite(z))) { cid[v] = -1; continue; }
      const ax = nor ? nor[v * 3] : 0, ay = nor ? nor[v * 3 + 1] : 1, az = nor ? nor[v * 3 + 2] : 0;
      const oc = (ax < 0 ? 1 : 0) | (ay < 0 ? 2 : 0) | (az < 0 ? 4 : 0);
      const key = Math.floor(x * inv) + ',' + Math.floor(y * inv) + ',' + Math.floor(z * inv) + ',' + oc;
      let c = map.get(key);
      if (c === undefined) { c = cnt.length; map.set(key, c); sx.push(0); sy.push(0); sz.push(0); nx.push(0); ny.push(0); nz.push(0); cr.push(0); cg.push(0); cb.push(0); cnt.push(0); }
      cid[v] = c; sx[c] += x; sy[c] += y; sz[c] += z; nx[c] += ax; ny[c] += ay; nz[c] += az; cnt[c]++;
      if (col) { cr[c] += col[v * 3]; cg[c] += col[v * 3 + 1]; cb[c] += col[v * 3 + 2]; }
    }
    const seen = new Set(), tri = [], used = new Int32Array(cnt.length).fill(-1); let m = 0;
    const C = cnt.length;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = cid[idx[t]], b = cid[idx[t + 1]], c = cid[idx[t + 2]];
      if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
      const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi, k = (lo * C + mid) * C + hi;   // C < 2^17 in practice: exact in a double
      if (seen.has(k)) continue; seen.add(k);
      for (const q of [a, b, c]) if (used[q] < 0) used[q] = m++;
      tri.push(used[a], used[b], used[c]);
    }
    const P = new Float32Array(m * 3), N = new Float32Array(m * 3), K = col ? new Float32Array(m * 3) : null;
    for (let c = 0; c < C; c++) {
      const o = used[c]; if (o < 0) continue; const k = 1 / cnt[c];
      P[o * 3] = sx[c] * k; P[o * 3 + 1] = sy[c] * k; P[o * 3 + 2] = sz[c] * k;
      const l = Math.hypot(nx[c], ny[c], nz[c]) || 1; N[o * 3] = nx[c] / l; N[o * 3 + 1] = ny[c] / l; N[o * 3 + 2] = nz[c] / l;
      if (K) { K[o * 3] = cr[c] * k; K[o * 3 + 1] = cg[c] * k; K[o * 3 + 2] = cb[c] * k; }
    }
    return { pos: P, nor: N, col: K, idx: m < 65536 ? new Uint16Array(tri) : new Uint32Array(tri), tris: tri.length / 3, verts: m };
  }

  /* smallest cell (bisection, ~9 passes) whose simplified triangle count is <= target; bounded by the mesh extent */
  function fitCell(pos, nor, idx, target) {
    let mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
    for (let v = 0; v < pos.length; v += 3) for (let a = 0; a < 3; a++) { const x = pos[v + a]; if (x < mn[a]) mn[a] = x; if (x > mx[a]) mx[a] = x; }
    const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
    let lo = ext / 4096, hi = ext / 2;
    if (simplify(pos, nor, null, idx, lo).tris <= target) return lo;
    for (let i = 0; i < 9; i++) { const mid = Math.sqrt(lo * hi); if (simplify(pos, nor, null, idx, mid).tris <= target) hi = mid; else lo = mid; }
    return hi;
  }

  /* concatenate parts [{pos, nor, col, idx}] into one indexed mesh */
  function merge(parts) {
    let nv = 0, ni = 0; for (const p of parts) { nv += p.pos.length / 3; ni += p.idx.length; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni); let vo = 0, io = 0;
    for (const p of parts) {
      pos.set(p.pos, vo * 3); nor.set(p.nor, vo * 3); if (p.col) col.set(p.col, vo * 3); else for (let i = 0; i < p.pos.length; i++) col[vo * 3 + i] = 0.5;
      for (let i = 0; i < p.idx.length; i++) idx[io + i] = p.idx[i] + vo;
      vo += p.pos.length / 3; io += p.idx.length;
    }
    return { pos: pos, nor: nor, col: col, idx: idx };
  }

  const core = { simplify: simplify, fitCell: fitCell, merge: merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;

  /* ───────────────────────── browser: bake from a loaded LOD group ───────────────────────── */
  const W = root;
  const toLin = (b) => Math.pow(b / 255, 2.2);
  function sampler(mat) {   // 64 x 64 RGBA copy of the base-colour map (null when the image is not readable)
    try {
      const im = mat.map && mat.map.image; if (!im || !(im.width > 0)) return null;
      const cv = W.document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, 64, 64); return g.getImageData(0, 0, 64, 64).data;
    } catch (e) { return null; }
  }
  /* lodRoot: the loaded LOD1 group (Object3D).  T: THREE.  Returns the impostor in lodRoot's LOCAL space, or null when it holds no triangles. */
  function build(lodRoot, T, opts) {
    opts = opts || {}; const t0 = W.performance.now(), target = opts.tris || 2600;
    lodRoot.updateWorldMatrix(true, true);
    const inv = new T.Matrix4().copy(lodRoot.matrixWorld).invert(), parts = [], v = new T.Vector3(), nm = new T.Matrix3(), mm = new T.Matrix4(), cache = new Map();
    lodRoot.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const g = o.geometry, P = g.attributes.position, N = g.attributes.normal, UV = g.attributes.uv, cnt = P.count;
      mm.multiplyMatrices(inv, o.matrixWorld); nm.getNormalMatrix(mm);
      const pos = new Float32Array(cnt * 3), nor = new Float32Array(cnt * 3), col = new Float32Array(cnt * 3);
      const mats = Array.isArray(o.material) ? o.material : [o.material], m0 = mats[0] || {};
      let px = cache.get(m0); if (px === undefined) { px = sampler(m0); cache.set(m0, px); }
      const bc = m0.color || { r: 0.5, g: 0.5, b: 0.5 };
      for (let i = 0; i < cnt; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(mm); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        if (N) { v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nor[i * 3] = v.x; nor[i * 3 + 1] = v.y; nor[i * 3 + 2] = v.z; } else nor[i * 3 + 1] = 1;
        let r = 1, gg = 1, b = 1;
        if (px && UV) { const u = UV.getX(i), w = UV.getY(i), fx = ((u % 1) + 1) % 1, fy = ((w % 1) + 1) % 1, ix = Math.min(63, (fx * 64) | 0), iy = Math.min(63, ((m0.map && m0.map.flipY === false ? fy : 1 - fy) * 64) | 0), k = (iy * 64 + ix) * 4; r = toLin(px[k]); gg = toLin(px[k + 1]); b = toLin(px[k + 2]); }
        col[i * 3] = r * bc.r; col[i * 3 + 1] = gg * bc.g; col[i * 3 + 2] = b * bc.b;
      }
      let idx = g.index ? g.index.array : null; if (!idx) { idx = new Uint32Array(cnt); for (let i = 0; i < cnt; i++) idx[i] = i; }
      parts.push({ pos: pos, nor: nor, col: col, idx: idx });
    });
    if (!parts.length) return null;
    const M = merge(parts), cell = fitCell(M.pos, M.nor, M.idx, target), S = simplify(M.pos, M.nor, M.col, M.idx, cell);
    if (S.tris < 12) return null;
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(S.pos, 3)); geo.setAttribute('normal', new T.BufferAttribute(S.nor, 3)); geo.setAttribute('color', new T.BufferAttribute(S.col, 3));
    geo.setIndex(new T.BufferAttribute(S.idx, 1)); geo.computeBoundingSphere();
    const MatC = T.MeshStandardNodeMaterial || T.MeshStandardMaterial, mat = new MatC({ vertexColors: true, roughness: 0.92, metalness: 0.0 });
    mat.name = 'dm_impostor'; mat.userData.shared = true; geo.userData.shared = true;
    return { geometry: geo, material: mat, tris: S.tris, verts: S.verts, cell: cell, srcTris: M.idx.length / 3, ms: W.performance.now() - t0 };
  }
  W.DMImpostor = { core: core, build: build };
})(typeof window !== 'undefined' ? window : globalThis);
