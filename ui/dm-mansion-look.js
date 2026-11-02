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
// Light modes (flat-DOM-free API, same set as the Bird Temple room lights, ui/dm-bt-roomlights.js): DMMansionLook.set('auto'|'bright'|'warm'|'cool'|'night'|'off'),
// .cycle(), .get(). Persisted in localStorage 'dm_mansion_light'; ?minlight=warm overrides for a session. A mode change only writes two uniforms.
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const LS = 'dm_mansion_light';
  const MODES = ['auto', 'bright', 'warm', 'cool', 'night', 'off'];
  // [fill, [r,g,b] tint]
  const SPEC = { auto: [0.52, [1, 1, 1]], bright: [0.8, [1, 1, 1]], warm: [0.58, [1, 0.78, 0.52]], cool: [0.58, [0.7, 0.85, 1]], night: [0.22, [1, 0.24, 0.28]], off: [0.1, [1, 1, 1]] };
  const S = { mode: 'auto', U: null, atlas: null, tex: [], lowCount: 0, loads: 0, THREE: null, lastMem: 0 };
  try { const m = (new URLSearchParams(G.location.search)).get('minlight') || G.localStorage.getItem(LS); if (m && MODES.indexOf(m) >= 0) S.mode = m; } catch (e) { }

  function applyMode() {
    const U = S.U, sp = SPEC[S.mode]; if (!U) return;
    U.fill.value = sp[0]; U.tint.value.setRGB(sp[1][0], sp[1][1], sp[1][2]);
    if (S.atlas && !U.node) { S.atlas.emissive.setScalar(sp[0] * 0.5); }   // classic-material fallback only
  }
  function texBytes(t) { const i = t && t.image; return i && i.width ? i.width * i.height * 4 * 1.34 : 0; }
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
      S.U = { node, fill: node ? T.uniform(1) : { value: 1 }, tint: node ? T.uniform(new THREE.Color(1, 1, 1)) : { value: new THREE.Color(1, 1, 1) } };
    }
    if (!S.atlas) {
      const T2 = THREE.TSL, U = S.U;
      if (U.node) {
        const m = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 1 });
        m.vertexColors = true; m.name = 'int_atlas';
        m.emissiveNode = T2.diffuseColor.rgb.mul(U.tint).mul(U.fill);
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

  const API = {
    MODES, SPEC,
    // root = the freshly parsed interior GLB scene. Swaps its materials for the shared set and trims textures for the preset. Returns a stats object.
    apply(root, ctx) {
      const t0 = performance.now(); ensureShared(ctx); S.loads++;
      const low = (ctx.tier ? ctx.tier() : 2) < 1, mobile = !!(ctx.isMobile && ctx.isMobile());
      let maxA = 1; try { const PW = ctx.PW(); maxA = (PW && PW.renderer && PW.renderer.getMaxAnisotropy && PW.renderer.getMaxAnisotropy()) || 1; } catch (e) { }
      const aniso = low ? 1 : Math.min(maxA, mobile ? 2 : 4);
      const A = S.atlas, old = new Set(), seen = new Set(); let meshes = 0, tris = 0;
      root.traverse(n => {
        if (!n.isMesh) return; meshes++;
        const g = n.geometry, ix = g.index; tris += ix ? ix.count / 3 : g.attributes.position.count / 3;
        const ms = Array.isArray(n.material) ? n.material : [n.material];
        for (let i = 0; i < ms.length; i++) {
          const m = ms[i]; if (!m) continue;
          if (m.name === 'int_atlas') {
            old.add(m);
            for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap']) { const t = m[k]; if (t && !seen.has(t)) { seen.add(t); } }
            ms[i] = A;
          } else { if (m.name === 'int_water') { m.depthWrite = false; } }
        }
        if (!Array.isArray(n.material)) n.material = ms[0];
      });
      // textures → the shared atlas material
      let g0 = null; for (const m of old) { g0 = m; break; }
      const prev = S.tex.slice(); S.tex.length = 0;
      if (g0) {
        const set = (key, t) => { A[key] = t || null; if (t) { t.anisotropy = aniso; if (S.tex.indexOf(t) < 0) S.tex.push(t); } };
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
      for (const t of prev) if (S.tex.indexOf(t) < 0) freeTex(t);
      // light list: ambient + hemisphere only, once per world (null → default list)
      if (S.U.node) { const L = lightList(ctx); const want = L && ctx.THREE.TSL.lights(L); if (S.atlasLights === undefined || (L && !S.atlasLights)) { A.lightsNode = want || null; S.atlasLights = want || null; } }
      A.needsUpdate = true;   // textures/low-path changed: one program lookup (same key as last visit → pipeline cache hit, no new compile)
      for (const m of old) { try { m.dispose(); } catch (e) { } }   // the GLB's own copies (textures now belong to the shared material)
      if (low) S.lowCount++;
      let bytes = 0; for (const t of S.tex) bytes += texBytes(t); S.lastMem = bytes;
      return { meshes, tris: Math.round(tris), textures: S.tex.length, texMB: +(bytes / 1048576).toFixed(1), low, aniso, lights: S.atlasLights ? 'amb+hemi' : 'scene', ms: +(performance.now() - t0).toFixed(1) };
    },
    // interior unloaded (she walked away): GPU textures + CPU bitmaps freed; the shared material objects stay (cheap) for the next visit
    release() { for (const t of S.tex) freeTex(t); S.tex.length = 0; S.lastMem = 0; if (S.atlas) { S.atlas.map = null; S.atlas.emissiveMap = null; S.atlas.normalMap = null; S.atlas.metalnessMap = null; S.atlas.roughnessMap = null; } },
    // the home world is gone: drop everything
    destroy() { API.release(); if (S.atlas) { try { S.atlas.dispose(); } catch (e) { } S.atlas = null; } S.atlasLights = undefined; },
    set(m) { if (MODES.indexOf(m) < 0) return S.mode; S.mode = m; try { G.localStorage.setItem(LS, m); } catch (e) { } applyMode(); return m; },
    get() { return S.mode; },
    cycle() { return API.set(MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]); },
    mem() { return { texMB: +(S.lastMem / 1048576).toFixed(2), textures: S.tex.length, loads: S.loads }; },
    _S: S,
  };
  G.DMMansionLook = API;
})();
