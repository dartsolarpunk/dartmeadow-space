/* ============================================================================
   ui/dm-charpaint.js — applies a character LOOK (colours; Phase 3 adds logo decals) to a loaded character, in the studio and in the game.
   Registry-driven (ui/dm-chars.js): only the regions a registry entry declares are touched, and nothing is touched unless the player changed it, so the
   default look (the baked / shipped materials) is byte for byte what it was.

   How each kind of region is recoloured (limits are in docs/character-select-notes.md):
     hair   per strand group (cluster): hair_strands.js H.setTint({clusterName:[r,g,b] linear}) rewrites the strand vertex colours once; each strand keeps its own
            light / dark jitter and root->tip gradient, only the base hue is replaced.  No per-frame work.
     flat   an item whose material is a plain colour factor (Ariel's shirt and pants): material.color.  Nothing else changes.
     baked  an item painted into a shared baked colour map (Emma's cloth atlas holds shirt + pants): the item's UV islands are rasterised into a 1024 px canvas that
            starts as the baked image; inside the island the colour is REPLACED by the chosen one while the baked light / dark detail (wrinkles, wear) is kept
            (ratio of each texel's luminance to the island mean).  One CanvasTexture per atlas, written once per change, never per frame.
   Pure parts (raster, luminance transfer, sRGB) are exported for node tests (tools/tests/charpaint-unit.js) as module.exports / DMCharPaint.core.
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
  function transfer(r, g, b, refLum, target, lo, hi) {
    const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255, k = refLum > 1e-4 ? Math.max(lo == null ? 0.55 : lo, Math.min(hi == null ? 1.8 : hi, l / refLum)) : 1;
    return [Math.min(255, target[0] * k), Math.min(255, target[1] * k), Math.min(255, target[2] * k)];
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
  function stateOf(rootObj) { return rootObj.userData.dmPaint || (rootObj.userData.dmPaint = { flat: new Map(), atlases: new Map(), meshMats: new Map() }); }
  function revert(rootObj) {
    const S = rootObj.userData && rootObj.userData.dmPaint; if (!S) return;
    for (const [m, c] of S.flat) { try { m.color.copy(c); m.needsUpdate = true; } catch (e) { } }
    S.flat.clear();
    for (const [mesh, orig] of S.meshMats) { try { const cur = mesh.material; mesh.material = orig; if (cur && cur !== orig && cur.dispose) cur.dispose(); } catch (e) { } }
    S.meshMats.clear();
    for (const [, A] of S.atlases) { try { A.tex && A.tex.dispose(); } catch (e) { } }
    S.atlases.clear();
  }
  function lookColor(look, id) { const c = look && look.colors && look.colors[id]; return c && /^#[0-9a-f]{6}$/i.test(c) ? c : null; }

  function apply(rootObj, def, look, THREE, opts) {
    opts = opts || {}; if (!rootObj || !def) return null; revert(rootObj); const S = stateOf(rootObj);
    const items = def.items || {}, atlasGroups = {};
    for (const id of Object.keys(items)) {
      const it = items[id], hex = lookColor(look, id), meshes = itemMeshes(rootObj, it);
      if (!meshes.length) continue;
      if (it.mode === 'flat') {
        if (!hex) continue;
        const col = new THREE.Color(hex);   // sRGB hex -> the working colour space
        for (const mesh of meshes) for (const m of matsOf(mesh)) { if (!m.color) continue; if (!S.flat.has(m)) S.flat.set(m, m.color.clone()); m.color.copy(col); m.needsUpdate = true; }
      } else if (it.mode === 'baked') {
        (atlasGroups[it.atlas || id] = atlasGroups[it.atlas || id] || []).push({ id, it, meshes, hex });
      }
    }
    for (const key of Object.keys(atlasGroups)) { try { paintAtlas(rootObj, key, atlasGroups[key], THREE, S, opts); } catch (e) { try { console.warn('[charpaint] atlas', key, e); } catch (_) { } } }
    return S;
  }

  // one baked atlas (e.g. Emma's cloth map): all items that share it are rasterised into one canvas
  function paintAtlas(rootObj, key, group, THREE, S, opts) {
    if (!group.some((g) => g.hex)) return;   // nothing chosen on this atlas: the shipped material stays, no canvas at all
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
      let n = 0, sum = 0; const seen = new Uint8Array(size * size), list = [];
      for (const t of texels) { if (seen[t]) continue; seen[t] = 1; list.push(t); sum += (0.299 * px[t * 4] + 0.587 * px[t * 4 + 1] + 0.114 * px[t * 4 + 2]) / 255; n++; }
      if (!n) continue; const ref = sum / n;
      for (const t of list) { const o = t * 4, c = transfer(px[o], px[o + 1], px[o + 2], ref, target); px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; }
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

  const core = { s2l, l2s, hexToRgb, hexToLinear, lum709, raster, transfer, hairTints, ATLAS };
  return { api: { apply, revert, dispose, applyHair, hairTints, core, ...core } };
});
