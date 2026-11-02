// DM Mansion Look (v228) — shared materials + cheap lighting for Ariel's mansion interior (ui/dm-mansion-interior.js loads the geometry).
//
// Budget rules (this must only ever REDUCE GPU / memory load):
//   • ONE shared material per surface type, cached for the life of the home world: the interior's PBR atlas material (colour + normal + ORM, vertex-baked
//     AO / lamp tint), the unlit lamp/neon material and the pool water are built once and re-used by every room (the GLB is a single merged mesh).
//     Re-entering the house swaps the textures into the SAME material objects; no per-frame allocation, no per-frame material/texture work (nothing here
//     runs per frame at all: a light-mode change is a uniform write).
//   • NO lights are added to the scene (a changed light set recompiles every world material: #162 _lcNode). The atlas material gets its own light list
//     (material.lightsNode) of the world's ambient + hemisphere lights only: indoors the sun / star lights (shadow-map sampling per pixel, and the sun
//     is unshadowed under the roof anyway) are not evaluated at all. Lamps are the vertex bake; emissiveNode = diffuseColor (atlas × vertex AO/lamp tint)
//     × a shared fill uniform, so every room reads lamp-lit by day or night and the exterior light cannot leak in through the roof.
//   • Low preset: colour atlas only (normal + ORM textures are never uploaded → 1 texture fetch/pixel instead of 3, 2/3 less texture memory).
//   • Mobile: 512 atlas (chosen by the loader), anisotropy 2; desktop anisotropy ≤ 4. ImageBitmaps are closed and textures disposed on unload.
// Baked GI (lighting PR 1/4, tools/ariel-home/bake_gi.js): assets/ariel-home/gi/ holds a baked lightmap + AO (UV2 = a parallel Uint16 array on the atlas mesh) and a
//   spherical-harmonics L1 light-probe grid over the walkable volume. Lazy: DMMansionLook.prefetch() runs in parallel with the interior GLB, apply() attaches
//   material.lightMap / aoMap (channel 1) to the SAME shared atlas material (one program-key change per visit, compiled by the loader's existing compileAsync, no new
//   lights), release()/destroy() dispose the textures (the loader drops the interior > 400 m away). Tiers: desktop = 512 lightmap + 512 AO (R8); mobile = 256 + 256 AO;
//   Low = AO only (256, R8, 64 KB). Probes: probeTick() samples the grid (no allocation) and scales the world's EXISTING ambient + hemisphere light colours while she is
//   indoors (uniform writes only, restored on exit), so Ariel and every moving object pick up the room's light with zero extra lights / recompiles. ?mgi=0 or
//   localStorage dm_mansion_gi=0 turns the baked GI off (A/B).
// Low-memory load order (Chrome Aw-Snap OOM fix): apply(root, ctx, null) first (GLB parsed, shared atlas swapped in), THEN `await DMMansionLook.loadGI(ctx, ver)` (GI fetched + decoded one file at a
//   time, attached to the already-applied atlas, resolves true/false), THEN the loader's compileAsync (lightMap/aoMap change the atlas program key). Every ImageBitmap-backed texture (GLB atlas maps,
//   GI lightmap/AO) closes its CPU bitmap in Texture.onUpdate, i.e. right after the first GPU upload. release()/destroy() (the 400 m dispose hook) cancel an in-flight loadGI. prefetch()+apply(.., gi) still works.
// Light modes (flat-DOM-free API, same set as the Bird Temple room lights, ui/dm-bt-roomlights.js): DMMansionLook.set('auto'|'bright'|'warm'|'cool'|'night'|'off'),
// .cycle(), .get(). Persisted in localStorage 'dm_mansion_light'; ?minlight=warm overrides for a session. A mode change only writes two uniforms.
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const LS = 'dm_mansion_light';
  const MODES = ['auto', 'bright', 'warm', 'cool', 'night', 'off'];
  const GI_LM = 16, GI_EG = 0.45;   // lightMapIntensity at 'auto' (lightmap texel x meta.gain = irradiance; tuned against the vertex-baked look so mean brightness stays level while the lamp pools, window light and contact shadows come from the bake), unlit fill share kept when a lightmap is on
  // [fill, [r,g,b] tint]
  const SPEC = { auto: [0.52, [1, 1, 1]], bright: [0.8, [1, 1, 1]], warm: [0.58, [1, 0.78, 0.52]], cool: [0.58, [0.7, 0.85, 1]], night: [0.22, [1, 0.24, 0.28]], off: [0.1, [1, 1, 1]] };
  const S = { mode: 'auto', U: null, atlas: null, tex: [], lowCount: 0, loads: 0, THREE: null, lastMem: 0, gi: null, giOn: true, lmK: GI_LM, egK: GI_EG, tl: [], tlBase: [], tlLast: [], k: [1, 1, 1], pt: 0, plx: 1e9, ply: 1e9, plz: 1e9, active: false, gen: 0, giP: null, pend: null, ver: '' };
  try { const q = (new URLSearchParams(G.location.search)).get('mgi'); if (q === '0' || (q === null && G.localStorage.getItem('dm_mansion_gi') === '0')) S.giOn = false; } catch (e) { }
  try { const m = (new URLSearchParams(G.location.search)).get('minlight') || G.localStorage.getItem(LS); if (m && MODES.indexOf(m) >= 0) S.mode = m; } catch (e) { }

  function applyMode() {
    const U = S.U, sp = SPEC[S.mode]; if (!U) return;
    const gi = S.gi && S.gi.lm; U.fill.value = sp[0];
    // with a baked lightmap the colour tint rides on material.color (tints lightmap + ambient + fill alike) and the lightmap strength follows the mode's fill
    if (gi && S.atlas) { U.tint.value.setRGB(1, 1, 1); S.atlas.color.setRGB(sp[1][0], sp[1][1], sp[1][2]); S.atlas.lightMapIntensity = S.lmK * (sp[0] / 0.52); }
    else { U.tint.value.setRGB(sp[1][0], sp[1][1], sp[1][2]); if (S.atlas) S.atlas.color.setRGB(1, 1, 1); }
    if (U.eg) U.eg.value = gi ? S.egK : 1;
    if (S.atlas && !U.node) { S.atlas.emissive.setScalar(sp[0] * 0.5); }   // classic-material fallback only
  }
  function texBytes(t) { const i = t && t.image; if (!i || !i.width) return 0; const mip = t.generateMipmaps === false || t.minFilter === 1006 || t.minFilter === 1003 ? 1 : 1.34; return i.width * i.height * (t.format === 1028 ? 1 : 4) * mip; }
  function freeTex(t) {
    if (!t) return;
    try { t.dispose(); } catch (e) { }
    try { const d = t.source && t.source.data; if (d && typeof d.close === 'function') d.close(); } catch (e) { }
  }
  function ensureShared(ctx) {
    const THREE = ctx.THREE, T = THREE.TSL;
    S.THREE = THREE;
    if (!S.U) {
      const node = !!(THREE.MeshStandardNodeMaterial && T && T.uniform && T.diffuseColor && T.lights);
      S.U = { node, fill: node ? T.uniform(1) : { value: 1 }, eg: node ? T.uniform(1) : { value: 1 }, tint: node ? T.uniform(new THREE.Color(1, 1, 1)) : { value: new THREE.Color(1, 1, 1) } };
    }
    if (!S.atlas) {
      const T2 = THREE.TSL, U = S.U;
      if (U.node) {
        const m = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 1 });
        m.vertexColors = true; m.name = 'int_atlas';
        m.emissiveNode = T2.diffuseColor.rgb.mul(U.tint).mul(U.fill).mul(U.eg).mul(T2.materialAO || 1);   // materialAO = 1 unless the baked aoMap is on
        S.atlas = m;
      } else { const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 1 }); m.vertexColors = true; m.name = 'int_atlas'; m.emissive = new THREE.Color(0.3, 0.3, 0.3); S.atlas = m; }
      S.atlas.userData.dmMansionLook = true; S.atlasLow = null; S.atlasLights = undefined;
    }
    applyMode();
  }
  // ambient + hemisphere lights of the planet-world scene (stable singletons). null = none found → keep the scene's default light list (never an EMPTY list:
  // an empty lightsNode skips lighting altogether and would draw the raw albedo).
  function lightList(ctx) {
    const PW = ctx.PW && ctx.PW(); const sc = PW && PW.scene; if (!sc) return null; const a = [];
    sc.traverse(o => { if ((o.isAmbientLight || o.isHemisphereLight) && !(o.userData && (o.userData.btStandIn || o.userData.bti))) a.push(o); });
    return a.length ? a : null;
  }

  // ── baked GI: lazy fetch + decode (never inlined, never per frame) ──────────────────────────────────────────
  const GI_DIR = 'assets/ariel-home/gi/';   // ctx.giBase overrides (the standalone harness serves from tools/ariel-home/)
  const LUT0 = new Float32Array(256), LUT1 = new Float32Array(256);   // probe dequantisation (squared ramps), x m0 / m1 at load
  const PR = new Float32Array(9);          // scratch: sampled E(up) rgb, E(down) rgb, E(mean) rgb (lightmap units)
  const KT = new Float32Array(9), KC = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);   // light scale: target / current (up, down, mean) x rgb
  const BASE = new Float64Array(36), LAST = new Float64Array(36);       // per-light captured colours (up to 6 lights x 2 colours x rgb)
  function fetchBin(url) { return fetch(url).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.arrayBuffer(); }); }
  function fetchBmp(url) {
    return fetch(url).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.blob(); })
      .then(b => G.createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }));
  }
  function toR8(bmp) {   // gray PNG -> one byte per texel (R8: a quarter of RGBA8's memory); null = no canvas available (the caller then uses the bitmap as RGBA)
    try {
      const w = bmp.width, h = bmp.height, c = typeof G.OffscreenCanvas === 'function' ? new G.OffscreenCanvas(w, h) : G.document.createElement('canvas');
      c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, w, h).data, o = new Uint8Array(w * h); for (let i = 0; i < o.length; i++) o[i] = d[i * 4];
      return { w, h, data: o };
    } catch (e) { return null; }
  }
  // Resolves to a payload for attachGI (or null: the old look stays, nothing breaks). OOM fix: the GI files are fetched and decoded ONE AT A TIME (small buffers first, then the AO PNG -> R8 -> its bitmap
  // closed, then the lightmap PNG), with a macrotask yield between steps, so at most one decoded bitmap is alive here instead of all of them at once next to the GLB parse. `stale()` (optional)
  // aborts between steps and closes whatever was decoded (the interior was released while this ran).
  const yieldT = () => new Promise(res => G.setTimeout(res, 0));
  async function fetchGI(ctx, ver, stale) {
    if (ver !== undefined) S.ver = ver;
    if (!S.giOn || !G.fetch || !G.createImageBitmap) return null;
    const low = (ctx.tier ? ctx.tier() : 2) < 1, mobile = !!(ctx.isMobile && ctx.isMobile()), q = '?v=' + ver, dir = ctx.giBase || GI_DIR;
    let lm = null, aoB = null;
    try {
      const r = await fetch(dir + 'ariel-home-interior-gi.json' + q); if (!r.ok) throw new Error('gi ' + r.status);
      const meta = await r.json(), f = meta.files, lmK = (low ? 0 : mobile ? 256 : 512), aoK = (low || mobile) ? 256 : 512, u = n => dir + n + q;
      const uv2 = new Uint16Array(await fetchBin(u(f.uv2))); await yieldT(); if (stale && stale()) return null;
      const probes = new Uint8Array(await fetchBin(u(f.probes))); await yieldT(); if (stale && stale()) return null;
      aoB = await fetchBmp(u(f.ao[aoK])); const ao = toR8(aoB); if (ao) { try { aoB.close(); } catch (e) { } aoB = null; } await yieldT();
      if (stale && stale()) { if (aoB) aoB.close(); return null; }
      if (lmK) { lm = await fetchBmp(u(f.lm[lmK])); if (stale && stale()) { lm.close(); if (aoB) aoB.close(); return null; } }
      return { meta, uv2, lm, ao, aoBmp: aoB, probes, low, mobile };
    } catch (e) { try { if (lm) lm.close(); if (aoB) aoB.close(); } catch (e2) { } console.warn('[mansion-look] baked GI unavailable, using the vertex-baked look', e && e.message); return null; }
  }
  // Legacy entry (the loader may still start it in parallel with the GLB and hand the payload to apply()): same sequential decode. Prefer loadGI() AFTER apply().
  function prefetch(ctx, ver) { return fetchGI(ctx, ver); }
  // Awaitable, call AFTER apply() has returned (GLB parsed + materials swapped): fetches + decodes the GI sequentially, attaches uv1 / lightMap / aoMap / probes to the shared atlas, resolves true when
  // attached (false = no GI / mismatch / released meanwhile: the vertex-baked look stays). Call it BEFORE compileAsync: lightMap + aoMap change the atlas program key, so attaching them after the compile
  // costs one extra (atlas-only) recompile. Single flight; release()/destroy() cancel it.
  function loadGI(ctx, ver) {
    if (S.gi) return Promise.resolve(true);
    if (S.giP) return S.giP;
    const pend = S.pend; if (!pend || !S.giOn) return Promise.resolve(false);
    const gen = S.gen;
    const p = fetchGI(ctx, ver === undefined ? S.ver : ver, () => gen !== S.gen).then(gi => {
      if (S.giP === p) S.giP = null;
      if (!gi) return false;
      if (gen !== S.gen || S.pend !== pend) { discard(gi); return false; }
      let ok = false; try { ok = S.U && S.U.node && attachGI(pend.geo, S.atlas, gi, ctx.THREE); } catch (e) { console.warn('[mansion-look] GI attach', e); }
      if (!ok) { S.atlas.lightMap = null; S.atlas.aoMap = null; S.gi = null; discard(gi); return false; }
      if (S.gi.probes) { const L = lightList(ctx); if (L) { for (let i = 0; i < L.length && i < 6; i++) S.tl.push(L[i]); } }
      applyMode(); S.atlas.needsUpdate = true;
      const A = S.atlas, add = texBytes(A.lightMap) + texBytes(A.aoMap); S.lastMem += add; S.gi.mb = +((add + (S.gi.probes ? S.gi.probes.length : 0) + S.gi.uv2) / 1048576).toFixed(2);   // GLB textures may already be uploaded + closed (0 bytes now): only add the GI maps
      return true;
    });
    S.giP = p; return p;
  }
  // Close an ImageBitmap-backed texture's CPU copy as soon as three has uploaded it (Texture.onUpdate fires right after the upload): the decoded bitmap is the biggest JS-side holder. A texture that is
  // disposed and used again re-decodes from the GLB / GI files on the next visit (release() frees, apply()/loadGI() rebuild), so nothing re-uploads from a closed bitmap.
  function closeAfterUpload(t) {
    if (!t || !t.image || typeof t.image.close !== 'function' || t._dmClose) return; t._dmClose = true; const prev = t.onUpdate;
    t.onUpdate = tx => { tx.onUpdate = prev || null; try { if (tx.image && tx.image.close) tx.image.close(); } catch (e) { } if (prev) prev(tx); };
  }
  function discard(gi) { try { if (gi && gi.lm && gi.lm.close) gi.lm.close(); if (gi && gi.aoBmp && gi.aoBmp.close) gi.aoBmp.close(); } catch (e) { } }
  function psumOf(g) {   // same fingerprint as bake_gi.js posSum(): refuse lightmaps baked for a different interior GLB
    const a = g.attributes.position, n = a.count; let s = 0;
    if (a.array instanceof Float32Array && !a.isInterleavedBufferAttribute) { const P = a.array; for (let i = 0; i < n * 3; i += 3) s += P[i] + 3 * P[i + 1] + 7 * P[i + 2]; }
    else for (let i = 0; i < n; i++) s += a.getX(i) + 3 * a.getY(i) + 7 * a.getZ(i);
    return Math.round(s * 100) / 100;
  }
  // geometry check + UV2 + textures for the shared atlas material. Returns true when attached.
  function attachGI(g, A, gi, THREE) {
    const m = gi.meta, pc = g.attributes.position.count;
    if (pc !== m.verts || gi.uv2.length !== pc * 2 || Math.abs(psumOf(g) - m.psum) > 0.06) { console.warn('[mansion-look] baked GI does not match this interior GLB (re-run tools/ariel-home/bake_gi.js)'); return false; }
    g.setAttribute('uv1', new THREE.BufferAttribute(gi.uv2, 2, true));   // channel 1 (normalised Uint16)
    const mk = (t) => { t.channel = 1; t.flipY = false; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true; S.tex.push(t); return t; };
    let ao = null, lm = null;
    if (gi.ao) { ao = new THREE.DataTexture(gi.ao.data, gi.ao.w, gi.ao.h, THREE.RedFormat, THREE.UnsignedByteType); ao.colorSpace = THREE.NoColorSpace; ao.unpackAlignment = 1; }
    else if (gi.aoBmp) { ao = new THREE.Texture(gi.aoBmp); ao.colorSpace = THREE.NoColorSpace; gi.aoBmp = null; }
    if (ao) { if (gi.aoBmp === null && ao.isTexture && !ao.isDataTexture) closeAfterUpload(ao); A.aoMap = mk(ao); }
    if (gi.lm) { lm = new THREE.Texture(gi.lm); lm.colorSpace = THREE.SRGBColorSpace; gi.lm = null; closeAfterUpload(lm); A.lightMap = mk(lm); }
    A.aoMapIntensity = 0.85;
    const pm = m.probes, d = pm.dim, n = d[0] * d[1] * d[2];
    for (let i = 0; i < 256; i++) { const v = i / 255, c = (i - 128) / 127; LUT0[i] = pm.m0 * v * v; LUT1[i] = pm.m1 * Math.sign(c) * c * c; }
    S.gi = { meta: m, probes: gi.probes.length === n * 12 ? gi.probes : null, pm, lm: !!lm, ao: !!ao, uv2: pc * 4 };
    return true;
  }
  // E(n) at a nav-frame point: trilinear over the 8 surrounding probes. Fills PR (up, down, mean; rgb each). No allocation.
  function sampleProbes(x, y, z) {
    const P = S.gi.probes, pm = S.gi.pm, o = pm.origin, st = pm.step, d = pm.dim, nx = d[0], ny = d[1], nz = d[2];
    let fx = (x - o[0]) / st[0], fy = (y - o[1]) / st[1], fz = (z - o[2]) / st[2];
    fx = fx < 0 ? 0 : fx > nx - 1.001 ? nx - 1.001 : fx; fy = fy < 0 ? 0 : fy > ny - 1.001 ? ny - 1.001 : fy; fz = fz < 0 ? 0 : fz > nz - 1.001 ? nz - 1.001 : fz;
    const i0 = fx | 0, j0 = fy | 0, k0 = fz | 0, tx = fx - i0, ty = fy - j0, tz = fz - k0;
    for (let q = 0; q < 9; q++) PR[q] = 0;
    for (let c = 0; c < 8; c++) {
      const di = c & 1, dj = (c >> 1) & 1, dk = c >> 2, w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz); if (w <= 0) continue;
      const b = (((k0 + dk) * ny + (j0 + dj)) * nx + (i0 + di)) * 12;
      for (let ch = 0; ch < 3; ch++) {
        const a0 = LUT0[P[b + ch * 4]], a2 = LUT1[P[b + ch * 4 + 2]];   // GLB axes: +y (a2) is up
        PR[ch] += w * (a0 + a2); PR[3 + ch] += w * (a0 - a2); PR[6 + ch] += w * a0;
      }
    }
  }
  function clampK(v) { return v < 0.45 ? 0.45 : v > 1.5 ? 1.5 : v; }
  // write base * K into the world's existing ambient / hemisphere lights; `base` follows any colour the world itself rewrote since our last write
  function writeLights(restore) {
    let bi = 0;
    for (let i = 0; i < S.tl.length; i++) {
      const L = S.tl[i], hemi = !!L.isHemisphereLight, cols = hemi ? 2 : 1;
      for (let c = 0; c < cols; c++) {
        const col = c ? L.groundColor : L.color, b = bi + c * 3;
        if (col.r !== LAST[b] || col.g !== LAST[b + 1] || col.b !== LAST[b + 2]) { BASE[b] = col.r; BASE[b + 1] = col.g; BASE[b + 2] = col.b; }   // the world changed it: new base
        const kb = hemi ? (c ? 3 : 0) : 6;
        const r = restore ? BASE[b] : BASE[b] * KC[kb], g = restore ? BASE[b + 1] : BASE[b + 1] * KC[kb + 1], bl = restore ? BASE[b + 2] : BASE[b + 2] * KC[kb + 2];
        col.r = r; col.g = g; col.b = bl; LAST[b] = r; LAST[b + 1] = g; LAST[b + 2] = bl;
      }
      bi += 6;
    }
  }
  function probeTick(lx, ly, lz, indoors) {
    const gi = S.gi; if (!gi || !gi.probes || !S.tl.length) return;
    if (!indoors && !S.active) return;
    const now = performance.now();
    if (indoors) {
      if (!S.active) { S.active = true; S.plx = 1e9; for (let i = 0; i < S.tl.length * 6; i++) LAST[i] = NaN; }   // first frame in: re-capture the bases
      const mv = Math.abs(lx - S.plx) + Math.abs(ly - S.ply) + Math.abs(lz - S.plz);
      if (mv > 0.6 || now - S.pt > 250) {
        S.pt = now; S.plx = lx; S.ply = ly; S.plz = lz; sampleProbes(lx, ly, lz + 2.2);
        const mu = gi.pm.mean, up = gi.pm.up, dn = gi.pm.down;
        for (let ch = 0; ch < 3; ch++) { KT[ch] = clampK(PR[ch] / up[ch]); KT[3 + ch] = clampK(PR[3 + ch] / dn[ch]); KT[6 + ch] = clampK(PR[6 + ch] / mu[ch]); }
      }
    }
    let dev = 0;
    for (let q = 0; q < 9; q++) { const t = indoors ? KT[q] : 1; KC[q] += (t - KC[q]) * 0.1; dev += Math.abs(KC[q] - 1); }
    if (!indoors && dev < 0.02) { for (let q = 0; q < 9; q++) KC[q] = 1; writeLights(true); S.active = false; return; }
    writeLights(false);
  }
  function probeRelease() { if (S.active) { for (let q = 0; q < 9; q++) KC[q] = 1; writeLights(true); } S.active = false; S.tl.length = 0; }

  const API = {
    MODES, SPEC,
    // root = the freshly parsed interior GLB scene. Swaps its materials for the shared set and trims textures for the preset. Returns a stats object.
    apply(root, ctx, gi) {
      const t0 = performance.now(); ensureShared(ctx); S.loads++;
      const low = (ctx.tier ? ctx.tier() : 2) < 1, mobile = !!(ctx.isMobile && ctx.isMobile());
      let maxA = 1; try { const PW = ctx.PW(); maxA = (PW && PW.renderer && PW.renderer.getMaxAnisotropy && PW.renderer.getMaxAnisotropy()) || 1; } catch (e) { }
      const aniso = low ? 1 : Math.min(maxA, mobile ? 2 : 4);
      const A = S.atlas, old = new Set(), seen = new Set(); let meshes = 0, tris = 0, giMesh = null;
      probeRelease(); S.gi = null; A.lightMap = null; A.aoMap = null;   // a previous visit's GI is gone (release() already freed its textures)
      root.traverse(n => {
        if (!n.isMesh) return; meshes++;
        const g = n.geometry, ix = g.index; tris += ix ? ix.count / 3 : g.attributes.position.count / 3;
        const ms = Array.isArray(n.material) ? n.material : [n.material];
        for (let i = 0; i < ms.length; i++) {
          const m = ms[i]; if (!m) continue;
          if (m.name === 'int_atlas') {
            old.add(m); if (!giMesh && n.geometry.attributes.position) giMesh = n.geometry;
            for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap']) { const t = m[k]; if (t && !seen.has(t)) { seen.add(t); } }
            ms[i] = A;
          } else { if (m.name === 'int_water') { m.depthWrite = false; } }
        }
        if (!Array.isArray(n.material)) n.material = ms[0];
      });
      S.pend = giMesh ? { geo: giMesh } : null;   // loadGI() attaches uv1 / lightMap / aoMap to this geometry after apply()
      // textures → the shared atlas material
      let g0 = null; for (const m of old) { g0 = m; break; }
      const prev = S.tex.slice(); S.tex.length = 0;
      let giOK = false;
      if (g0) {
        const set = (key, t) => { A[key] = t || null; if (t) { t.anisotropy = aniso; if (S.tex.indexOf(t) < 0) S.tex.push(t); closeAfterUpload(t); } };
        set('map', g0.map); if (!S.U.node) A.emissiveMap = g0.map || null;
        if (low) {
          for (const k of ['normalMap', 'metalnessMap', 'roughnessMap']) { const t = g0[k]; if (t && t !== g0.map) freeTex(t); }   // never uploaded: only the CPU bitmap is released
          A.normalMap = null; A.metalnessMap = null; A.roughnessMap = null; A.roughness = 0.85; A.metalness = 0;
        } else {
          set('normalMap', g0.normalMap); set('metalnessMap', g0.metalnessMap); set('roughnessMap', g0.roughnessMap || g0.metalnessMap);
          A.roughness = 1; A.metalness = 1; if (g0.normalScale) A.normalScale.copy(g0.normalScale);
        }
        A.color.setRGB(1, 1, 1);
      }
      if (gi && giMesh && S.U.node && S.giOn) { try { giOK = attachGI(giMesh, A, gi, ctx.THREE); } catch (e) { console.warn('[mansion-look] GI attach', e); giOK = false; } }
      if (!giOK) { A.lightMap = null; A.aoMap = null; S.gi = null; discard(gi); }
      else if (S.gi.probes) { const L = lightList(ctx); if (L) { for (let i = 0; i < L.length && i < 6; i++) S.tl.push(L[i]); } }
      applyMode();
      for (const t of prev) if (S.tex.indexOf(t) < 0) freeTex(t);
      // light list: ambient + hemisphere only, once per world (null → default list)
      if (S.U.node) { const L = lightList(ctx); const want = L && ctx.THREE.TSL.lights(L); if (S.atlasLights === undefined || (L && !S.atlasLights)) { A.lightsNode = want || null; S.atlasLights = want || null; } }
      A.needsUpdate = true;   // textures/low-path changed: one program lookup (same key as last visit → pipeline cache hit, no new compile)
      for (const m of old) { try { m.dispose(); } catch (e) { } }   // the GLB's own copies (textures now belong to the shared material)
      if (low) S.lowCount++;
      let bytes = 0; for (const t of S.tex) bytes += texBytes(t); S.lastMem = bytes;
      const giB = S.gi ? S.tex.reduce((a, t) => a + (t === A.lightMap || t === A.aoMap ? texBytes(t) : 0), 0) + (S.gi.probes ? S.gi.probes.length : 0) + S.gi.uv2 : 0;
      return { meshes, tris: Math.round(tris), textures: S.tex.length, texMB: +(bytes / 1048576).toFixed(2), gi: S.gi ? { lightmap: S.gi.lm, ao: S.gi.ao, probes: !!S.gi.probes, lights: S.tl.length, giMB: +(giB / 1048576).toFixed(2) } : null, low, aniso, lights: S.atlasLights ? 'amb+hemi' : 'scene', ms: +(performance.now() - t0).toFixed(1) };
    },
    // interior unloaded (she walked away): GPU textures + CPU bitmaps freed; the shared material objects stay (cheap) for the next visit
    release() { S.gen++; S.giP = null; S.pend = null; probeRelease(); S.gi = null; for (const t of S.tex) freeTex(t); S.tex.length = 0; S.lastMem = 0; if (S.atlas) { S.atlas.lightMap = null; S.atlas.aoMap = null; S.atlas.color.setRGB(1, 1, 1); S.atlas.map = null; S.atlas.emissiveMap = null; S.atlas.normalMap = null; S.atlas.metalnessMap = null; S.atlas.roughnessMap = null; } },
    // the home world is gone: drop everything
    destroy() { API.release(); if (S.atlas) { try { S.atlas.dispose(); } catch (e) { } S.atlas = null; } S.atlasLights = undefined; },
    prefetch, loadGI, discard, probeTick,
    // baked probe irradiance (lightmap units x meta.gain = irradiance) at a nav-frame point, for moving objects that want their own tint; writes out[0..2] (mean). false = no probes loaded
    probeAt(x, y, z, out) { if (!S.gi || !S.gi.probes) return false; sampleProbes(x, y, z); out[0] = PR[6]; out[1] = PR[7]; out[2] = PR[8]; return true; },
    set(m) { if (MODES.indexOf(m) < 0) return S.mode; S.mode = m; try { G.localStorage.setItem(LS, m); } catch (e) { } applyMode(); return m; },
    get() { return S.mode; },
    cycle() { return API.set(MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]); },
    mem() { return { texMB: +(S.lastMem / 1048576).toFixed(2), textures: S.tex.length, loads: S.loads, gi: !!S.gi }; },
    _S: S,
  };
  G.DMMansionLook = API;
})();
