/* DART Meadow — renderer MEMORY helpers (memory lane, sw v292).
 *
 * WHY: phones/tablets die on process bytes, not on frame rate (Mali-G615 tab at 917-990 MB, iPhone 16e at ~900 MB).  Process bytes = GPU buffers/textures
 * (renderer.info.memory.total) PLUS the CPU copies three.js keeps of everything it has uploaded (typed arrays, decoded ImageBitmaps) PLUS every extra
 * WebGPU device/canvas the page opened.  Three r185's WebGPU info keeps a STRONG Map (texture/attribute -> size), so a texture or geometry that was uploaded
 * and never .dispose()d is never garbage-collected: it leaks its GPU copy and its CPU copy for the rest of the session.
 *
 * "lean" = phones and tablets (GFX.isMobile), or ?lean=1.  ?lean=0 forces it off.  Desktop never goes lean by itself, so none of the CPU-copy / parking paths
 * below can change what a desktop player sees.  Everything here is wrapped: a failure leaves the memory where it was, never breaks a frame.
 *
 * Public (window.DMMem):
 *   .lean()                      -> bool
 *   .collectTextures(root)       -> Set<Texture>  every texture a scene graph holds (material slots + TSL texture nodes + userData.dmTex)
 *   .disposeTexturesExcept(old, keep) -> n  dispose textures held by `old` that `keep` does not hold (LOD swaps: the new level shares what it can)

 *   .shrinkTexture(tex, maxDim) / .shrinkAll(set, maxDim)  fit the decoded bitmap to maxDim (serial queue); the GPU copy is disposed first and re-uploads smaller
 *   .releaseBitmapAfterUpload(tex)    decoded ImageBitmap of a texture is closed once the renderer has uploaded it (only for textures that are never disposed and re-used)
 *   .sweepUnused(candidates, roots)   dispose candidate textures that no material under `roots` references any more (BT PBR replaced the GLB's own maps)
 *   .park(renderer, key) / .unpark(renderer, key)   shrink a hidden secondary renderer's drawing buffer to 1x1 (MSAA colour + depth go back) and restore it
 *   .stats()                     counters for the perf log
 *   (pure core: DMMem.core = { bytesOf, estimate... } for tools/tests/mem-unit.js)
 */
(function (root) {
  'use strict';
  const W = typeof window !== 'undefined' ? window : root;
  const S = { shrunk: 0, shrunkBytes: 0, closed: 0, closedBytes: 0, disposed: 0, swept: 0, parked: 0, unparked: 0, sg: 0, errs: 0 };
  const PARK = new Map();   // renderer -> { key, w, h, pr }

  function q() { try { return W.location && W.location.search || ''; } catch (e) { return ''; } }
  function lean() {
    const s = q();
    if (/[?&]lean=0\b/.test(s)) return false;
    if (/[?&]lean=1\b/.test(s)) return true;
    try { return !!(W.GFX && W.GFX.isMobile); } catch (e) { return false; }
  }

  /* ───────── texture inventory ───────── */
  const SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'envMap', 'bumpMap', 'displacementMap', 'lightMap', 'specularMap',
    'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap',
    'anisotropyMap', 'specularIntensityMap', 'specularColorMap', 'gradientMap'];
  function addNodeTextures(m, out) {
    // TSL: material.colorNode / normalNode / ... hold texture nodes whose .value is the Texture.  Bounded depth-first walk (same bound as the perf-log census).
    let n = 0;
    const seen = new Set();
    const walk = (nd, dep) => {
      if (!nd || dep > 6 || n > 600 || seen.has(nd)) return; seen.add(nd); n++;
      const v = nd.value; if (v && v.isTexture) out.add(v);
      let ch = null; try { ch = nd.getChildren ? nd.getChildren() : null; } catch (e) { ch = null; }
      if (ch) for (const c of ch) walk(c, dep + 1);
    };
    for (const k in m) {
      if (SLOTS.indexOf(k) >= 0) continue;
      let v; try { v = m[k]; } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      if (v.isTexture) out.add(v);
      else if (v.isNode) walk(v, 0);
    }
  }
  function collectTextures(rootObj, out) {
    out = out || new Set();
    if (!rootObj || !rootObj.traverse) return out;
    rootObj.traverse((o) => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) {
        if (!m) continue;
        for (const k of SLOTS) { const t = m[k]; if (t && t.isTexture) out.add(t); }
        try { addNodeTextures(m, out); } catch (e) { S.errs++; }
        const ud = m.userData && m.userData.dmTex; if (ud) for (const t of (Array.isArray(ud) ? ud : [ud])) if (t && t.isTexture) out.add(t);
      }
    });
    return out;
  }
  function disposeTexturesExcept(oldRoot, keepRoot) {
    let n = 0;
    try {
      const keep = keepRoot ? collectTextures(keepRoot) : new Set();
      for (const t of collectTextures(oldRoot)) {
        if (keep.has(t) || (t.userData && t.userData.dmKeep)) continue;
        try { t.dispose(); n++; } catch (e) { S.errs++; }
      }
    } catch (e) { S.errs++; }
    S.disposed += n; return n;
  }
  function sweepUnused(cands, roots) {
    let n = 0;
    try {
      const used = new Set(); for (const r of (Array.isArray(roots) ? roots : [roots])) collectTextures(r, used);
      for (const t of cands) {
        if (!t || !t.isTexture || used.has(t) || (t.userData && t.userData.dmKeep)) continue;
        try { t.dispose(); n++; } catch (e) { S.errs++; }
      }
    } catch (e) { S.errs++; }
    S.swept += n; return n;
  }

  /* ───────── decoded copies ───────── */
  function bitmapBytes(im) { return im && im.width && im.height ? im.width * im.height * 4 : 0; }
  function closeBitmap(t) {
    const im = t && t.image;
    if (im && typeof im.close === 'function' && typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) {
      const b = bitmapBytes(im);
      if (t.userData) t.userData.dmBytes = (t.userData.dmBytes || b * (t.generateMipmaps === false ? 1 : 4 / 3));
      try { im.close(); S.closed++; S.closedBytes += b; } catch (e) { }
    }
  }
  function releaseBitmapAfterUpload(t) {
    if (!t || !t.isTexture) return false;
    const im = t.image;
    if (!(im && typeof im.close === 'function' && typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap)) return false;
    if (t.userData) { t.userData.dmBytes = bitmapBytes(im) * (t.generateMipmaps === false ? 1 : 4 / 3); t.userData.dmW = im.width; t.userData.dmH = im.height; }
    const prev = t.onUpdate;
    t.onUpdate = function () {
      try { if (prev) prev.apply(this, arguments); } finally { try { closeBitmap(t); } catch (e) { } }
    };
    return true;
  }
  // (Storage-buffer pools cannot hand their CPU arrays back: the same attribute is also the mesh's vertex buffer, and three reads attribute.array whenever a pipeline is
  // built.  The pool is sized instead: see _svLodPreset in index.html.)

  // Halve (or fit to maxDim) the decoded bitmap of a texture BEFORE or after its upload: the GPU copy is disposed first (a texture's GPU size is fixed at creation), the
  // smaller bitmap goes in and the texture re-uploads on demand.  Serial queue: one resize at a time, so the transient peak is one extra image.
  let shrinkQ = Promise.resolve();
  function fitSize(w, h, maxDim) { const m = Math.max(w, h); if (!(m > maxDim)) return null; const k = maxDim / m; return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]; }
  function shrinkTexture(t, maxDim) {
    shrinkQ = shrinkQ.then(() => {
      const im = t && t.image;
      if (!(im && typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap && im.width > 0 && typeof W.createImageBitmap === 'function')) return false;
      const sz = fitSize(im.width, im.height, maxDim); if (!sz) return false;
      return W.createImageBitmap(im, { resizeWidth: sz[0], resizeHeight: sz[1], resizeQuality: 'medium', imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then((nb) => {
        const was = im.width * im.height * 4;
        try { t.dispose(); } catch (e) { }
        t.image = nb; t.needsUpdate = true;
        try { im.close(); } catch (e) { }
        S.shrunk++; S.shrunkBytes += was - nb.width * nb.height * 4; return true;
      }).catch(() => false);
    }).catch(() => false);
    return shrinkQ;
  }
  function shrinkAll(texs, maxDim) { const out = []; for (const t of texs) out.push(shrinkTexture(t, maxDim)); return Promise.all(out); }

  /* ───────── secondary renderers ───────── */
  function park(r, key) {
    try {
      if (!r || !r.setSize || PARK.has(r)) return false;
      const sz = r.getSize ? r.getSize(new (W.THREE && W.THREE.Vector2 || function () { this.x = 0; this.y = 0; })()) : { x: 0, y: 0 };
      PARK.set(r, { key, w: sz.x, h: sz.y, pr: r.getPixelRatio ? r.getPixelRatio() : 1 });
      if (r.setPixelRatio) r.setPixelRatio(1);
      r.setSize(1, 1, false); S.parked++; return true;
    } catch (e) { S.errs++; return false; }
  }
  function unpark(r) {
    try {
      const p = PARK.get(r); if (!p) return false; PARK.delete(r);
      if (r.setPixelRatio) r.setPixelRatio(p.pr);
      r.setSize(p.w, p.h, false); S.unparked++; return true;
    } catch (e) { S.errs++; return false; }
  }
  function isParked(r) { return PARK.has(r); }

  /* ───────── pure estimators (shared with tools/mem-estimate.js) ───────── */
  const core = {
    MIP: 4 / 3,
    texBytes(w, h, bpp, mips, layers) { return w * h * (layers || 1) * bpp * (mips === false ? 1 : 4 / 3); },
    // WebGPU storage vec3 buffers are padded to vec4 on the GPU AND in the CPU array the renderer keeps
    storageBytes(count, itemSize) { return count * (itemSize === 3 ? 4 : itemSize) * 4; },
    msaaBytes(w, h, samples, colorBpp, depthBpp) { return w * h * (samples > 1 ? samples : 1) * (colorBpp + depthBpp) + (samples > 1 ? w * h * colorBpp : 0); },
  };

  const out = W.DMMem = {
    lean, collectTextures, disposeTexturesExcept, sweepUnused, releaseBitmapAfterUpload, shrinkTexture, shrinkAll, fitSize, park, unpark, isParked, core,
    stats() { return Object.assign({ lean: lean(), parkedNow: PARK.size }, S); },
    note(k, n) { S[k] = (S[k] || 0) + (n || 1); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
})(typeof globalThis !== 'undefined' ? globalThis : this);
