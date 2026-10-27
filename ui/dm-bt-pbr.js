/* dm-bt-pbr.js — Bird Temple exterior layered PBR paint (v177).
 *
 * Offline (tools/bt-pbr/): Blender paints four tileable procedural layer stacks — base paint, panel lines, metallic trim
 * bands, edge wear (bare metal), grime — and bakes them to 2K maps; post.py packs them into
 *   assets/bt-pbr/<section>-color   sRGB base colour (cavity AO multiplied in: the baked GI already owns aoMap/channel 1)
 *   assets/bt-pbr/<section>-nrm     tangent-space normal (panel seams, raised trim, fine grain)
 *   assets/bt-pbr/<section>-orm     R=AO  G=roughness  B=metalness (glTF layout; roughnessMap + metalnessMap)
 * at 2K and 1K. Sections (UDIM-style, one texture set each, own texel density): hull, temple, altar, trim.
 * uv.py rewrote ONLY the exterior TEXCOORD_0 + TANGENT bytes of 'Bird Temple Interior.glb' in place (box projection);
 * positions, indices, colours, node names, transforms, deckAnchor and every collision input are byte-identical (verify.py).
 * Runtime: materials only — maps on the existing exterior materials, no lights, no new geometry. 2K at tier >= 2, else 1K
 * (Mali-class tablets). Applied before the temple warm-up compile (index.html), with a tick() fallback. ?pbr=0 disables.
 */
(function () {
  'use strict';
  const P = window.DMBtPbr = { on: true, ready: false, applied: false, stats: {} };
  try { if (/[?&]pbr=0\b/.test(location.search) || localStorage.getItem('dm_pbr') === '0') P.on = false; } catch (e) { }
  const SEC = {
    hull: ['Hull', 'Ballroom', 'Upper Lounge', 'Lower lounge', 'Hull window', 'Box', 'deck'],
    temple: ['Temple', 'Starboard obulisque', 'Port Obulisque', 'Obulisque', 'Lower maze', 'Upper maze', 'Bird Shard'],
    altar: ['Altar', 'Gods', 'Altar Realm', 'House Angels', 'Angels', 'Human halo', 'Bird Shard halo'],
    trim: ['Staff stuck', 'Staff amulet ring', 'Staff amulet triangle', 'Staff amulet', 'Staff base', 'dart', 'ornament', 'staff'],
  };
  const NRM = { hull: 0.9, temple: 0.8, altar: 0.6, trim: 0.5 };
  const san = n => String(n || '').replace(/\s/g, '_').replace(/[\[\].:\/]/g, '');
  const byName = new Map(); for (const s in SEC) for (const n of SEC[s]) byName.set(san(n), s);
  const tier = () => { const s = (window.GFX && GFX.shadowSize) || 1024; return s >= 4096 ? 3 : s >= 2048 ? 2 : s >= 1024 ? 1 : 0; };
  let loading = null;
  P.load = function () {
    if (!P.on) return Promise.resolve(null);
    if (loading) return loading;
    const res = tier() >= 2 ? '2k' : '1k';
    loading = (async () => {
      const THREE = window.THREE, tl = new THREE.TextureLoader(), sets = {};
      await Promise.all(Object.keys(SEC).map(async s => {
        const [map, nrm, orm] = await Promise.all(['color', 'nrm', 'orm'].map(c => tl.loadAsync('assets/bt-pbr/' + s + '-' + c + '-' + res + '.webp?v=177')));
        map.colorSpace = THREE.SRGBColorSpace; nrm.colorSpace = THREE.NoColorSpace; orm.colorSpace = THREE.NoColorSpace;
        for (const t of [map, nrm, orm]) { t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = res === '2k' ? 4 : 2; t.needsUpdate = true; }
        sets[s] = { map, nrm, orm };
      }));
      P.sets = sets; P.ready = true; P.stats.res = res; return sets;
    })().catch(e => { P.stats.err = String(e && e.message || e).slice(0, 160); return null; });
    return loading;
  };
  function sectionOf(o, root) { for (let p = o; p && p !== root; p = p.parent) { const s = byName.get(san(p.name)); if (s) return s; } return null; }
  // the v177 GLB carries box-projected UVs spanning many repeats; the old TEXCOORD_0 sat inside [0,1] with ~zero area
  function uvOk(a) { if (!a) return false; let lo = 1e9, hi = -1e9; const n = Math.min(a.count, 4000); for (let i = 0; i < n; i++) { const u = a.getX(i); if (u < lo) lo = u; if (u > hi) hi = u; } return lo < -0.01 || hi > 1.01; }
  P.apply = function (root) {
    if (!P.on || !P.ready) return 0;
    const T = window.BIRD_TEMPLE; root = root || (T && (T._glb || T.group)); if (!root) return 0;
    const THREE = window.THREE; let n = 0; const seen = new Set();
    root.traverse(o => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const m = o.material; if (seen.has(m) || (m.userData && m.userData.btPbr && m.map === P.sets[m.userData.btPbr].map) || /^BTI_/.test(m.name || '') || (m.userData && m.userData.btGlass) || !('metalness' in m)) return;
      if (m.transmission > 0 || !o.geometry.attributes.uv || !o.geometry.attributes.tangent) return;
      const s = sectionOf(o, root); if (!s) return;
      if (!uvOk(o.geometry.attributes.uv)) { P.stats.oldUV = (P.stats.oldUV || 0) + 1; return; }   // a stale (pre-v177) GLB: keep its plain look
      seen.add(m);
      const t = P.sets[s];
      m.map = t.map; m.normalMap = t.nrm; m.normalScale = new THREE.Vector2(NRM[s], NRM[s]);
      m.roughnessMap = t.orm; m.metalnessMap = t.orm; m.roughness = 1; m.metalness = 1;
      m.userData.btPbr = s; m.needsUpdate = true; n++;
      try { if (window.BTL && BTL.track) BTL.track(m); } catch (e) { }
    });
    P.applied = true; P.stats.mats = (P.stats.mats || 0) + n; if (n) console.log('[bt-pbr] layered PBR on', n, 'exterior materials (' + P.stats.res + ')');
    return n;
  };
  // fallback when the warm-up path did not run (no compileAsync): load once the temple exists, then apply
  // also re-scans (throttled) so materials the GI bake clones/swaps in after the first apply get painted too; apply() skips painted ones
  let lastScan = 0;
  P.tick = function () {
    if (!P.on) return; const T = window.BIRD_TEMPLE; if (!T || !T.group) return;
    if (!P.ready) { P.load(); return; }
    const now = performance.now(); if (P.applied && now - lastScan < 2000) return; lastScan = now;
    P.apply();
  };
})();
