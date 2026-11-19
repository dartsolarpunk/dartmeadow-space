/* ============================================================================
   ui/dm-charpaint.js — applies a character LOOK (colours + logo decals) to a loaded character, in the studio and in the game.
   Registry-driven (ui/dm-chars.js): only the regions a registry entry declares are touched, and nothing is touched unless the player changed it, so the
   default look (the baked / shipped materials) is byte for byte what it was.

   How each kind of region is recoloured (limits are in docs/character-select-notes.md):
     hair   per strand group (cluster): hair_strands.js H.setTint({clusterName:[r,g,b] linear}) rewrites the strand vertex colours once; each strand keeps its own
            light / dark jitter and root->tip gradient, only the base hue is replaced.  No per-frame work.
     flat   an item whose material is a plain colour factor (Ariel's shirt and pants): material.color.  Nothing else changes.
     baked  an item painted into a shared baked colour map (Emma's cloth atlas holds shirt + pants): the item's UV islands are rasterised into a 1024 px canvas that
            starts as the baked image; inside the island the colour is REPLACED by the chosen one while the baked light / dark detail (wrinkles, wear) is kept
            (ratio of each texel's luminance to the island mean).  One CanvasTexture per atlas, written once per change, never per frame.
      decals logos are baked into the same canvas, once per change.  Every decal is a PROJECTION: the garment's rest-pose vertices (root space) are projected along one of
            four horizontal axes (front / back / left / right) into the garment's own bounding box; per UV texel the rest position and normal are interpolated, the
            normal must face the axis (dot > 0.3) and the position is mapped into the decal's rotated square, which samples a 192 px logo mask.  The result is
            alpha-composited over the colour.  'uv' items (Emma) use their own UV islands; 'planar' items (Ariel, no UVs) are unwelded and given a generated 4-view atlas
            (front / back / left / right quadrants) first, only when a decal exists.  No extra draw call (the atlas is the material's map), no per-frame canvas work.
  Pure parts (raster, luminance transfer, sRGB, plane maths, compositing) are exported for node tests (tools/tests/charpaint-unit.js) as module.exports / DMCharPaint.core.
   ========================================================================== */
(function (root, factory) {
  const core = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = core.api;
  else root.DMCharPaint = core.api;
})(typeof window !== 'undefined' ? window : this, function (W) {
  'use strict';
  const ATLAS = 1024;

  /* ───────── pure helpers ───────── */
  const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function hexToLinear(h) { const c = hexToRgb(h); return c ? [s2l(c[0] / 255), s2l(c[1] / 255), s2l(c[2] / 255)] : null; }
  const lum709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // Rasterise triangles of a UV layout into a size x size grid.  uv: Float32Array(u,v pairs, v down = image row, glTF convention); index: Uint32/16Array or null.
  // cb(texel, tri, w0, w1, w2) is called once per covered texel (the last triangle covering it wins) with barycentric weights.  `margin` px of overshoot past an
  // edge (default 0.75) closes the seam between islands and their neighbours so mip-mapped sampling never shows a halo of the old colour.
  function raster(uv, index, size, cb, margin) {
    const nT = index ? (index.length / 3) | 0 : ((uv.length / 2 / 3) | 0), m = margin == null ? 0.75 : margin;
    for (let t = 0; t < nT; t++) {
      const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
      const ax = uv[a * 2] * size, ay = uv[a * 2 + 1] * size, bx = uv[b * 2] * size, by = uv[b * 2 + 1] * size, cx = uv[c * 2] * size, cy = uv[c * 2 + 1] * size;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - m)), x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx) + m));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - m)), y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy) + m));
      const sg = area > 0 ? 1 : -1;
      const lab = Math.hypot(bx - ax, by - ay) || 1, lbc = Math.hypot(cx - bx, cy - by) || 1, lca = Math.hypot(ax - cx, ay - cy) || 1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const e0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sg, e1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sg, e2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sg;
        if (e0 / lab < -m || e1 / lbc < -m || e2 / lca < -m) continue;
        const A = Math.abs(area), w2 = e0 / A, w0 = e1 / A, w1 = e2 / A;
        cb(y * size + x, t, w0, w1, w2);
      }
    }
  }
  // colour transfer for a baked island: replace the base colour, keep the baked detail.  rgb in 0..255 sRGB; refLum = the island's mean luminance (0..1).
  function medianOf(a) { if (!a.length) return 0; const f = Float32Array.from(a).sort(); return f[f.length >> 1]; }
  function transfer(r, g, b, refLum, target, lo, hi) {
    const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255, k = refLum > 1e-4 ? Math.max(lo == null ? 0.55 : lo, Math.min(hi == null ? 1.8 : hi, l / refLum)) : 1;
    return [Math.min(255, target[0] * k), Math.min(255, target[1] * k), Math.min(255, target[2] * k)];
  }


  /* ───────── decal projection (pure) ───────── */
  const FR = { front: { n: [0, 0, 1], r: [1, 0, 0] }, back: { n: [0, 0, -1], r: [-1, 0, 0] }, left: { n: [1, 0, 0], r: [0, 0, -1] }, right: { n: [-1, 0, 0], r: [0, 0, 1] } };
  function emptyBox() { return { minx: 1e9, miny: 1e9, minz: 1e9, maxx: -1e9, maxy: -1e9, maxz: -1e9 }; }
  function growBox(b, pos) { for (let i = 0; i < pos.length; i += 3) { const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < b.minx) b.minx = x; if (x > b.maxx) b.maxx = x; if (y < b.miny) b.miny = y; if (y > b.maxy) b.maxy = y; if (z < b.minz) b.minz = z; if (z > b.maxz) b.maxz = z; } return b; }
  // the garment's box seen along `key`: u (0..1, left to right on screen), v (0..1, top to bottom)
  function planeRange(b, key) {
    const f = FR[key], useX = f.r[0] !== 0, sg = useX ? f.r[0] : f.r[2], lo = useX ? b.minx : b.minz, hi = useX ? b.maxx : b.maxz;
    const a = sg * lo, c = sg * hi; return { useX, sg, u0: Math.min(a, c), W: Math.max(1e-6, Math.abs(hi - lo)), y1: b.maxy, H: Math.max(1e-6, b.maxy - b.miny) };
  }
  function planeUV(R, x, y, z) { return [((R.sg * (R.useX ? x : z)) - R.u0) / R.W, (R.y1 - y) / R.H]; }
  // which of the four views a surface normal belongs to (the largest horizontal component)
  function viewOf(nx, nz) { return Math.abs(nz) >= Math.abs(nx) ? (nz >= 0 ? 'front' : 'back') : (nx >= 0 ? 'left' : 'right'); }
  // the decal's logo mask lookup for local coords s,t in 0..1 (bilinear on alpha)
  function maskAlpha(M, s, t) {
    const res = M.res, x = s * res - 0.5, y = t * res - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, g = (i, j) => (i < 0 || j < 0 || i >= res || j >= res ? 0 : M.data[j * res + i]);
    return ((g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy) / 255;
  }
  // composite decals into px (RGBA bytes, size x size).  infos: [{pos,nrm (root space, per vertex), uv, index}], item: registry item, box: union box of infos,
  // unit: root-space units per metre, masks: [{res,data}] parallel to decals.  Returns the number of texels touched.
  function composite(px, size, infos, decals, item, box, unit, masks) {
    const nT = size * size, mesh = new Int16Array(nT).fill(-1), tri = new Int32Array(nT), w0a = new Float32Array(nT), w1a = new Float32Array(nT);
    infos.forEach((I, mi) => raster(I.uv, I.index, size, (t, tr, w0, w1) => { mesh[t] = mi; tri[t] = tr; w0a[t] = w0; w1a[t] = w1; }));
    const D = decals.map((d, i) => { const th = d.rotation * Math.PI / 180, sp = item.spots[d.spot], col = hexToRgb(d.colour) || [236, 235, 230];
      return { d, f: FR[d.spot], R: planeRange(box, d.spot), c: Math.cos(th), s: Math.sin(th), size: Math.max(1e-6, sp.base * d.scale * unit), col, M: masks[i] }; });
    let hit = 0;
    for (let t = 0; t < nT; t++) {
      const mi = mesh[t]; if (mi < 0) continue; const I = infos[mi], tr = tri[t], idx = I.index;
      const a = idx ? idx[tr * 3] : tr * 3, b = idx ? idx[tr * 3 + 1] : tr * 3 + 1, c = idx ? idx[tr * 3 + 2] : tr * 3 + 2, w0 = w0a[t], w1 = w1a[t], w2 = 1 - w0 - w1, P = I.pos, N = I.nrm;
      const x = P[a * 3] * w0 + P[b * 3] * w1 + P[c * 3] * w2, y = P[a * 3 + 1] * w0 + P[b * 3 + 1] * w1 + P[c * 3 + 1] * w2, z = P[a * 3 + 2] * w0 + P[b * 3 + 2] * w1 + P[c * 3 + 2] * w2;
      const nx = N[a * 3] * w0 + N[b * 3] * w1 + N[c * 3] * w2, ny = N[a * 3 + 1] * w0 + N[b * 3 + 1] * w1 + N[c * 3 + 1] * w2, nz = N[a * 3 + 2] * w0 + N[b * 3 + 2] * w1 + N[c * 3 + 2] * w2;
      const nl = Math.hypot(nx, ny, nz) || 1;
      for (let k = 0; k < D.length; k++) {
        const q = D[k]; if ((nx * q.f.n[0] + ny * q.f.n[1] + nz * q.f.n[2]) / nl < 0.3) continue;
        const uv = planeUV(q.R, x, y, z), da = (uv[0] - q.d.x) * q.R.W, db = (uv[1] - q.d.y) * q.R.H;
        const ra = da * q.c + db * q.s, rb = -da * q.s + db * q.c, ss = ra / q.size + 0.5, tt = rb / q.size + 0.5;
        if (ss < 0 || ss > 1 || tt < 0 || tt > 1) continue; const al = maskAlpha(q.M, ss, tt); if (al <= 0.01) continue;
        const o = t * 4; px[o] += (q.col[0] - px[o]) * al; px[o + 1] += (q.col[1] - px[o + 1]) * al; px[o + 2] += (q.col[2] - px[o + 2]) * al; hit++;
      }
    }
    return hit;
  }

  /* ───────── helpers shared with the browser part ───────── */
  const norm = (s) => String(s || '');
  const matchMesh = (re, name) => { try { return new RegExp(re, 'i').test(norm(name)); } catch (e) { return false; } };
  function itemMeshes(rootObj, item) {
    const out = []; rootObj.traverse((o) => { if ((o.isSkinnedMesh || o.isMesh) && o.geometry && matchMesh(item.mesh, o.name)) out.push(o); }); return out;
  }
  const matsOf = (o) => (Array.isArray(o.material) ? o.material : [o.material]).filter(Boolean);

  /* ───────── the look, applied ───────── */
  // state lives on root.userData.dmPaint so apply() is idempotent: it first returns everything to the shipped look, then paints what the look asks for
  function stateOf(rootObj) { return rootObj.userData.dmPaint || (rootObj.userData.dmPaint = { flat: new Map(), flatMap: new Map(), atlases: new Map(), meshMats: new Map(), geoSwap: new Map() }); }
  function revert(rootObj) {
    const S = rootObj.userData && rootObj.userData.dmPaint; if (!S) return;
    for (const [m, c] of S.flat) { try { m.color.copy(c); m.needsUpdate = true; } catch (e) { } }
    S.flat.clear();
    for (const [m, t] of S.flatMap) { try { m.map = t; m.needsUpdate = true; } catch (e) { } }
    S.flatMap.clear();
    for (const [mesh, orig] of S.meshMats) { try { const cur = mesh.material; mesh.material = orig; if (cur && cur !== orig && cur.dispose) cur.dispose(); } catch (e) { } }
    S.meshMats.clear();
    for (const [mesh, orig] of S.geoSwap) { try { const cur = mesh.geometry; mesh.geometry = orig; if (cur && cur !== orig) cur.dispose(); } catch (e) { } }
    S.geoSwap.clear();
    for (const [, A] of S.atlases) { try { A.tex && A.tex.dispose(); } catch (e) { } }
    S.atlases.clear();
  }
  // an item with a shipped texture (baked into a shared atlas, or a plain item whose material carries a map): the DEFAULT swatch brings the texture back, a colour swatch overrides it
  const hasDefaultTexture = (it) => !!it && (it.mode === 'baked' || it.texture === true);
  // how a chosen colour meets that texture: 'solid' = replaces it (flat colour), 'tint' = replaces the base hue and keeps the baked light / dark detail
  const colourModeOf = (it) => (it && it.colourMode === 'tint' ? 'tint' : it && it.colourMode === 'solid' ? 'solid' : 'tint');
  function lookColor(look, id) { const c = look && look.colors && look.colors[id]; return c && /^#[0-9a-f]{6}$/i.test(c) ? c : null; }

  function apply(rootObj, def, look, THREE, opts) {
    opts = Object.assign({}, opts || {}); if (!rootObj || !def) return null; if (def.decalFlip) opts.flip = true; revert(rootObj); const S = stateOf(rootObj);
    const items = def.items || {}, atlasGroups = {};
    for (const id of Object.keys(items)) {
      const it = items[id], hex = lookColor(look, id), meshes = itemMeshes(rootObj, it);
      const decals = it.decals && look && Array.isArray(look.decals) ? look.decals.filter((d) => d.item === id && it.spots && it.spots[d.spot]) : [];
      if (!meshes.length) continue;
      if (it.mode === 'flat') {
        if (decals.length && it.decals === 'planar') { try { paintPlanar(rootObj, id, it, meshes, decals, hex, THREE, S, opts); } catch (e) { try { console.warn('[charpaint] planar', id, e); } catch (_) { } } continue; }
        if (!hex) continue;
        const col = new THREE.Color(hex);   // sRGB hex -> the working colour space
        for (const mesh of meshes) for (const m of matsOf(mesh)) { if (!m.color) continue; if (!S.flat.has(m)) S.flat.set(m, m.color.clone()); m.color.copy(col);
          if (hasDefaultTexture(it) && m.map) { if (!S.flatMap.has(m)) S.flatMap.set(m, m.map); m.map = null; }   // solid colour mode: the colour replaces the shipped texture (DEFAULT brings it back)
          m.needsUpdate = true; }
      } else if (it.mode === 'baked') {
        (atlasGroups[it.atlas || id] = atlasGroups[it.atlas || id] || []).push({ id, it, meshes, hex, decals });
      }
    }
    for (const key of Object.keys(atlasGroups)) { try { paintAtlas(rootObj, key, atlasGroups[key], THREE, S, opts); } catch (e) { try { console.warn('[charpaint] atlas', key, e); } catch (_) { } } }
    return S;
  }


  /* ───────── decals, browser part ───────── */
  const _tm = (THREE) => ({ v: new THREE.Vector3(), nm: new THREE.Matrix3() });
  // root-space rest positions / normals of a mesh (geometry space -> root space through the node chain; independent of the current pose)
  function restOf(rootObj, mesh, geo, THREE, flip) {
    rootObj.updateMatrixWorld(true); mesh.updateMatrixWorld(true);
    const M = new THREE.Matrix4().copy(rootObj.matrixWorld).invert().multiply(mesh.matrixWorld), NM = new THREE.Matrix3().getNormalMatrix(M), v = new THREE.Vector3();
    const pa = geo.attributes.position, na = geo.attributes.normal, n = pa.count, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(M); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      if (na) { v.fromBufferAttribute(na, i).applyMatrix3(NM).normalize(); nrm[i * 3] = v.x; nrm[i * 3 + 1] = v.y; nrm[i * 3 + 2] = v.z; } }
    if (!na) { const idx = geo.index ? geo.index.array : null, nT = idx ? idx.length / 3 : n / 3; for (let t = 0; t < nT; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2], wx = pos[c * 3] - pos[a * 3], wy = pos[c * 3 + 1] - pos[a * 3 + 1], wz = pos[c * 3 + 2] - pos[a * 3 + 2];
      const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx, l = Math.hypot(fx, fy, fz) || 1; for (const q of [a, b, c]) { nrm[q * 3] += fx / l; nrm[q * 3 + 1] += fy / l; nrm[q * 3 + 2] += fz / l; } } }
    if (flip) for (let i = 0; i < n; i++) { pos[i * 3] = -pos[i * 3]; pos[i * 3 + 2] = -pos[i * 3 + 2]; nrm[i * 3] = -nrm[i * 3]; nrm[i * 3 + 2] = -nrm[i * 3 + 2]; }   // def.decalFlip: the displayed front is the rest pose's -z (animation turns her 180 deg)
    return { pos, nrm, uv: geo.attributes.uv ? geo.attributes.uv.array : null, index: geo.index ? geo.index.array : null };
  }
  // a mesh without a UV layout: unweld it and give every triangle the planar UV of its view (front / back / left / right quadrant of one atlas)
  function planarize(rootObj, mesh, box, THREE, flip) {
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone(), I = restOf(rootObj, mesh, g, THREE, flip), n = g.attributes.position.count, uv = new Float32Array(n * 2);
    const Q = { front: [0, 0], back: [0.5, 0], left: [0, 0.5], right: [0.5, 0.5] };
    for (let t = 0; t < n / 3; t++) {
      let nx = 0, nz = 0; for (let k = 0; k < 3; k++) { nx += I.nrm[(t * 3 + k) * 3]; nz += I.nrm[(t * 3 + k) * 3 + 2]; }
      const key = viewOf(nx, nz), R = planeRange(box, key), q = Q[key];
      for (let k = 0; k < 3; k++) { const i = t * 3 + k, p = planeUV(R, I.pos[i * 3], I.pos[i * 3 + 1], I.pos[i * 3 + 2]);
        uv[i * 2] = q[0] + 0.02 + 0.46 * Math.min(1, Math.max(0, p[0])); uv[i * 2 + 1] = q[1] + 0.02 + 0.46 * Math.min(1, Math.max(0, p[1])); }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.userData.dmPlanar = true; I.uv = uv; I.index = null; return { geo: g, info: I };
  }
  // logo masks: 192 px alpha grids (Path2D, even-odd), text drawn centred in a bold sans
  function makeMasks(decals, doc, opts) {
    const logos = opts.logos || (W.DMChars && W.DMChars.logoById), res = 192, cache = new Map();
    return decals.map((d) => {
      const key = d.id + '|' + (d.text || ''); if (cache.has(key)) return cache.get(key);
      const cv = doc.createElement('canvas'); cv.width = cv.height = res; const g = cv.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff';
      const lg = logos && (logos.get ? logos.get(d.id) : logos[d.id]);
      if (lg && lg.text) { g.textAlign = 'center'; g.textBaseline = 'middle'; let fs = res * 0.5; g.font = '900 ' + fs + 'px Arial, Helvetica, sans-serif'; const w = g.measureText(d.text).width; if (w > res * 0.94) { fs *= res * 0.94 / w; g.font = '900 ' + fs + 'px Arial, Helvetica, sans-serif'; } g.fillText(d.text, res / 2, res / 2); }
      else if (lg && typeof Path2D !== 'undefined') { g.scale(res / 24, res / 24); g.fill(new Path2D(lg.d), 'evenodd'); }
      const im = g.getImageData(0, 0, res, res).data, a = new Uint8Array(res * res); for (let i = 0; i < a.length; i++) a[i] = im[i * 4 + 3];
      const M = { res, data: a }; cache.set(key, M); return M;
    });
  }
  function unitOf(rootObj, THREE) { try { const b = new THREE.Box3().setFromObject(rootObj), h = b.max.y - b.min.y; return h > 0.2 && isFinite(h) ? h / 1.7 : 1; } catch (e) { return 1; } }
  // the garment's root-space rest box and the unit (UI placement pad: aspect of each view, logo size as a fraction of the box)
  function itemBox(rootObj, item, THREE, flip) { const box = emptyBox(); itemMeshes(rootObj, item).forEach((m) => growBox(box, restOf(rootObj, m, m.geometry, THREE, flip).pos)); return box.minx > box.maxx ? null : { box, unit: unitOf(rootObj, THREE) }; }
  const sRGBTex = (THREE, cv, ref) => { const t = new THREE.CanvasTexture(cv); t.flipY = false; t.colorSpace = (ref && ref.colorSpace) || THREE.SRGBColorSpace; t.anisotropy = (ref && ref.anisotropy) || 4; t.channel = (ref && ref.channel) || 0; t.needsUpdate = true; return t; };

  // the garment's outline in one view for the placement pad: triangles facing that view as u,v (0..1, same frame as a decal's x,y), at most `max` of them.
  // I = {pos,nrm,index} from restOf, box = the garment's box.  Pure given the arrays.
  function silhouetteTris(I, box, key, max) {
    const R = planeRange(box, key), f = FR[key], idx = I.index, nT = idx ? idx.length / 3 : I.pos.length / 9, out = [], step = Math.max(1, Math.ceil(nT / (max || 6000)));
    for (let t = 0; t < nT; t += step) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const nx = I.nrm[a * 3] + I.nrm[b * 3] + I.nrm[c * 3], ny = I.nrm[a * 3 + 1] + I.nrm[b * 3 + 1] + I.nrm[c * 3 + 1], nz = I.nrm[a * 3 + 2] + I.nrm[b * 3 + 2] + I.nrm[c * 3 + 2], nl = Math.hypot(nx, ny, nz) || 1;
      if ((nx * f.n[0] + ny * f.n[1] + nz * f.n[2]) / nl < 0.05) continue;
      for (const q of [a, b, c]) { const uv = planeUV(R, I.pos[q * 3], I.pos[q * 3 + 1], I.pos[q * 3 + 2]); out.push(uv[0], uv[1]); }
    }
    return new Float32Array(out);
  }
  // the pad's outline for an item: {box, unit, views:{key:Float32Array(u,v ...)}}; one rest-pose read, cached by the caller
  function itemOutline(rootObj, item, THREE, flip) {
    const ms = itemMeshes(rootObj, item), infos = ms.map((m) => restOf(rootObj, m, m.geometry, THREE, flip)), box = emptyBox(); infos.forEach((I) => growBox(box, I.pos));
    if (box.minx > box.maxx) return null; const views = {};
    for (const key of Object.keys(item.spots || {})) { const parts = infos.map((I) => silhouetteTris(I, box, key, Math.ceil(6000 / infos.length))); const n = parts.reduce((a, p) => a + p.length, 0), all = new Float32Array(n); let o = 0; parts.forEach((p) => { all.set(p, o); o += p.length; }); views[key] = all; }
    return { box, unit: unitOf(rootObj, THREE), views };
  }

  // a flat-colour item with no UVs: planar atlas = garment colour + logos
  function paintPlanar(rootObj, id, it, meshes, decals, hex, THREE, S, opts) {
    const flip = !!opts.flip;
    const doc = opts.document || (typeof document !== 'undefined' ? document : null); if (!doc) return;
    rootObj.updateMatrixWorld(true); const box = emptyBox(); meshes.forEach((m) => growBox(box, restOf(rootObj, m, m.geometry, THREE, flip).pos));
    const size = ATLAS, cv = doc.createElement('canvas'); cv.width = cv.height = size; const g2 = cv.getContext('2d', { willReadFrequently: true });
    g2.fillStyle = hex || it.defaultColor || '#808080'; g2.fillRect(0, 0, size, size); const data = g2.getImageData(0, 0, size, size);
    const infos = [], swaps = [];
    for (const m of meshes) { const P = planarize(rootObj, m, box, THREE, flip); infos.push(P.info); swaps.push([m, P.geo]); }
    composite(data.data, size, infos, decals, it, box, unitOf(rootObj, THREE), makeMasks(decals, doc, opts)); g2.putImageData(data, 0, 0);
    const tex = sRGBTex(THREE, cv, null), clones = new Map();
    for (const [m, geo] of swaps) {
      if (!S.geoSwap.has(m)) S.geoSwap.set(m, m.geometry); m.geometry = geo;
      if (!S.meshMats.has(m)) S.meshMats.set(m, m.material);
      const mm = matsOf(m).map((o) => { if (!clones.has(o)) { const c = o.clone(); c.map = tex; if (c.color) c.color.set(0xffffff); c.needsUpdate = true; clones.set(o, c); } return clones.get(o); });
      m.material = Array.isArray(S.meshMats.get(m)) ? mm : mm[0];
    }
    S.atlases.set('planar:' + id, { tex, canvas: cv, mat: null });
  }

  // one baked atlas (e.g. Emma's cloth map): all items that share it are rasterised into one canvas
  function paintAtlas(rootObj, key, group, THREE, S, opts) {
    if (!group.some((g) => g.hex || (g.decals && g.decals.length))) return;   // nothing chosen on this atlas: the shipped material stays, no canvas at all
    const doc = opts.document || (typeof document !== 'undefined' ? document : null); if (!doc) return;
    // the shared material: all the group's meshes must use ONE material with a colour map
    const mat0 = matsOf(group[0].meshes[0])[0]; if (!mat0 || !mat0.map || !mat0.map.image) return;
    const img = mat0.map.image, size = Math.min(ATLAS, img.width || ATLAS), cv = doc.createElement('canvas'); cv.width = cv.height = size;
    const g2 = cv.getContext('2d', { willReadFrequently: true }); g2.drawImage(img, 0, 0, size, size);
    const data = g2.getImageData(0, 0, size, size), px = data.data;
    for (const gi of group) {
      if (!gi.hex) continue; const target = hexToRgb(gi.hex), texels = [];
      for (const mesh of gi.meshes) {
        const geo = mesh.geometry, uv = geo.attributes.uv; if (!uv) continue; const arr = uv.array, idx = geo.index ? geo.index.array : null;
        raster(arr, idx, size, (t) => { texels.push(t); });
      }
      let n = 0; const seen = new Uint8Array(size * size), list = [], lums = [];
      for (const t of texels) { if (seen[t]) continue; seen[t] = 1; list.push(t); lums.push((0.299 * px[t * 4] + 0.587 * px[t * 4 + 1] + 0.114 * px[t * 4 + 2]) / 255); n++; }
      if (!n) continue; const ref = medianOf(lums), solid = colourModeOf(gi.it) === 'solid';   // MEDIAN, not mean: a baked print (Emma's logo) must not darken the plain fabric. 'solid': the baked texture is replaced by the colour; 'tint': the colour replaces the base hue and the baked light / dark detail stays
      for (const t of list) { const o = t * 4; if (solid) { px[o] = target[0]; px[o + 1] = target[1]; px[o + 2] = target[2]; continue; } const c = transfer(px[o], px[o + 1], px[o + 2], ref, target); px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; }
    }
    for (const gi of group) {   // decals, after the colour: Emma's islands are used as they are
      if (!gi.decals || !gi.decals.length) continue; const infos = []; const box = emptyBox();
      for (const mesh of gi.meshes) { if (!mesh.geometry.attributes.uv) continue; const I = restOf(rootObj, mesh, mesh.geometry, THREE, !!opts.flip); infos.push(I); growBox(box, I.pos); }
      if (infos.length) composite(px, size, infos, gi.decals, gi.it, box, unitOf(rootObj, THREE), makeMasks(gi.decals, doc, opts));
    }
    g2.putImageData(data, 0, 0);
    const tex = new THREE.CanvasTexture(cv); tex.flipY = false; tex.colorSpace = mat0.map.colorSpace || THREE.SRGBColorSpace; tex.wrapS = mat0.map.wrapS; tex.wrapT = mat0.map.wrapT;
    tex.anisotropy = mat0.map.anisotropy || 1; tex.channel = mat0.map.channel || 0; tex.needsUpdate = true;
    // every mesh of the group gets one cloned material carrying the new map (the shipped material stays untouched for revert)
    const clone = mat0.clone(); clone.map = tex; clone.needsUpdate = true; S.atlases.set(key, { tex, canvas: cv, mat: clone });
    for (const gi of group) for (const mesh of gi.meshes) { if (!S.meshMats.has(mesh)) S.meshMats.set(mesh, mesh.material); mesh.material = clone; }
  }

  // hair: group id -> clusters -> H.setTint
  function hairTints(def, look) {
    const out = {}, groups = (def.hair && def.hair.groups) || []; let any = false;
    for (const g of groups) { const lin = hexToLinear(lookColor(look, 'hair.' + g.id)); if (!lin) continue; any = true; for (const c of g.clusters) out[c] = lin; }
    return any ? out : null;
  }
  function applyHair(H, def, look) {
    if (!H || typeof H.setTint !== 'function') return false; H.setTint(hairTints(def, look)); return true;
  }
  function dispose(rootObj) {
    revert(rootObj); if (rootObj && rootObj.userData) delete rootObj.userData.dmPaint;
  }

  const core = { silhouetteTris, hasDefaultTexture, colourModeOf, FR, emptyBox, growBox, planeRange, planeUV, viewOf, maskAlpha, composite, s2l, l2s, hexToRgb, hexToLinear, lum709, raster, transfer, hairTints, ATLAS };
  return { api: { apply, revert, dispose, applyHair, hairTints, core, ...core, _impl: { restOf, planarize, unitOf, itemBox, itemOutline } } };
});
