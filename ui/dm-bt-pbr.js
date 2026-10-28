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
 * Runtime: materials only — maps on the existing exterior materials, no lights, no new geometry. 2K at tier >= 3 (tier 2 on non-mobile), else 1K
 * (phones, Mali-class tablets). Applied before the temple warm-up compile (index.html), with a tick() fallback. ?pbr=0 disables.
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
    // (v206) phones/tablets take the 1K set even at tier 2: twelve 2K maps with mips are ~270 MB of GPU memory + a long upload stall on load, and a handheld screen cannot show the extra texels
    const res = ((window.GFX && GFX.isMobile) ? false : tier() >= 2) ? '2k' : '1k';   // (fps) mobile is always 1K now, even on the 4096-shadow tier
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
  const rejUV = new WeakSet();
  P.apply = function (root) {
    if (!P.on || !P.ready) return 0;
    const T = window.BIRD_TEMPLE; root = root || (T && (T._glb || T.group)); if (!root) return 0;
    const THREE = window.THREE; let n = 0; const seen = new Set();
    root.traverse(o => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const m = o.material; if (seen.has(m) || (m.userData && m.userData.btPbr && m.map === P.sets[m.userData.btPbr].map) || /^BTI_/.test(m.name || '') || (m.userData && m.userData.btGlass) || !('metalness' in m)) return;
      if (m.transmission > 0 || !o.geometry.attributes.uv || !o.geometry.attributes.tangent) return;
      const s = sectionOf(o, root); if (!s) return;
      // (v181) the exterior prims ship without NORMAL: TSL fell back to a constant normal, so lighting + normal maps read flat gray
      if (!o.geometry.attributes.normal) { o.geometry.computeVertexNormals(); P.stats.nrmFix = (P.stats.nrmFix || 0) + 1; }
      if (rejUV.has(o.geometry)) return;   // (fps) already judged stale: do not re-read 4000 UVs every scan
      if (!uvOk(o.geometry.attributes.uv)) { rejUV.add(o.geometry); P.stats.oldUV = (P.stats.oldUV || 0) + 1; return; }   // a stale (pre-v177) GLB: keep its plain look
      seen.add(m);
      const t = P.sets[s];
      m.map = t.map; m.normalMap = t.nrm; m.normalScale = new THREE.Vector2(NRM[s], NRM[s]);
      m.roughnessMap = t.orm; m.metalnessMap = t.orm; m.roughness = 1; m.metalness = 1;
      m.userData.btPbr = s; n++;
      try { paint(o, m, s, t); } catch (e) { P.stats.paintErr = String(e && e.message || e).slice(0, 120); }
      m.needsUpdate = true;
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
    const now = performance.now(); if (P.applied && now - lastScan < (T.group.visible === false ? 8000 : 4000)) return; lastScan = now;   // (fps) the full-temple traverse ran every 2 s; GI-bake swaps land within a few s of load
    P.apply();
  };
  // ---------------------------------------------------------------------------------------------------------------
  // (v181) palettes: shared TSL uniforms, values blended slowly in tick() (no allocations, no texture regeneration).
  // hull, trim, glow (emissive seam lines) + k, arch, altar border, maze inlay. Slabs stay white.
  const PAL = [
    { name: 'Gunmetal / cyan', hull: 0x22272e, trim: 0x3a414b, glow: 0x2fe6ff, k: 1.6, arch: 0xe6ebf2, border: 0xd8dde4, maze: 0x22e4ff },
    { name: 'Crimson / gold', hull: 0x4a0a10, trim: 0xc89b3c, glow: 0xffb040, k: 0.5, arch: 0xf6eedf, border: 0xd9ad3a, maze: 0xffbf2e },
    { name: 'Ivory / cobalt', hull: 0x1d2a48, trim: 0xe4e9f0, glow: 0x4a9dff, k: 0.9, arch: 0xf4f7fb, border: 0x9db8e6, maze: 0x3a86ff },
    { name: 'Verdigris / bronze', hull: 0x123029, trim: 0xa8713a, glow: 0x52ffb0, k: 0.7, arch: 0xeef4ec, border: 0xb3834a, maze: 0x2cffa0 },
    { name: 'Obsidian / violet', hull: 0x15111f, trim: 0x6a5a8e, glow: 0xb57cff, k: 1.1, arch: 0xf2eefa, border: 0xc4b4e6, maze: 0xa56cff },
  ];
  P.palettes = PAL.map(p => p.name);
  const HOLD = 3 * 3600e3, FADE = 20 * 60e3;          // 3 h per palette, 20 min cross-fade
  let U = null, cA = null, cB = null;
  function uni() {
    if (U) return U; const THREE = window.THREE, T = THREE.TSL; cA = new THREE.Color(); cB = new THREE.Color();
    U = { time: T.uniform(0) }; for (const k of ['hull', 'trim', 'glow', 'arch', 'border', 'maze']) U[k] = T.uniform(new THREE.Color());
    U.k = T.uniform(1); setPal(); return U;
  }
  P.lock = function (v) { try { localStorage.setItem('dm_bt_palette', String(v)); } catch (e) { } setPal(); };
  P.lockValue = function () { try { return localStorage.getItem('dm_bt_palette') || 'auto'; } catch (e) { return 'auto'; } };
  function setPal() {
    if (!U) return; let i = 0, j = 0, f = 0; const lv = P.lockValue(); const li = parseInt(lv, 10);
    if (lv !== 'auto' && li >= 0 && li < PAL.length) { i = j = li; }
    else { const t = (P.clock ? P.clock() : Date.now()); const c = Math.floor(t / HOLD); i = c % PAL.length; j = (i + 1) % PAL.length; const r = t - c * HOLD; f = r > HOLD - FADE ? (r - (HOLD - FADE)) / FADE : 0; f = f * f * (3 - 2 * f); }
    const A = PAL[i], B = PAL[j];
    for (const k of ['hull', 'trim', 'glow', 'arch', 'border', 'maze']) { cA.setHex(A[k]); cB.setHex(B[k]); U[k].value.copy(cA).lerp(cB, f); }
    U.k.value = A.k + (B.k - A.k) * f; P.stats.pal = f > 0 ? A.name + ' > ' + B.name + ' ' + (f * 100 | 0) + '%' : A.name;
  }
  const AVG = { hull: 0.707, temple: 0.745, altar: 0.717, trim: 0.54 };   // mean linear luminance of each colour map
  function paint(o, m, s, tx) {
    const THREE = window.THREE, T = THREE.TSL; if (!T || !m.isNodeMaterial) return; uni();
    let nm = ''; for (let p = o; p; p = p.parent) { if (byName.has(san(p.name))) { nm = san(p.name); break; } }
    // (v192) anti-tiling. Two stochastic layers (hash per tile: random offset + 90-degree rotation, explicit gradients so
    // mips stay seamless; layer B is shifted half a tile and covers A's cell borders), a low-frequency world-space noise
    // that blends in a second, larger texture scale, and scattered grime / panel / scratch variation keyed to world cells.
    // 7 fetches per pixel, all arithmetic otherwise; nodes are built once per material, nothing per frame.
    const uvn = T.uv(), dx = T.dFdx(uvn), dy = T.dFdy(uvn);
    const h2 = c => T.fract(T.sin(T.vec2(T.dot(c, T.vec2(127.1, 311.7)), T.dot(c, T.vec2(269.5, 183.3)))).mul(43758.5453));
    const h1 = c => T.fract(T.sin(T.dot(c, T.vec2(12.9898, 78.233))).mul(43758.5453));
    const layer = sh => {
      const q = uvn.add(sh), c = T.floor(q), h = h2(c), a = T.floor(h.x.mul(4)).mul(1.5707963), cs = T.cos(a), sn = T.sin(a);
      const rot = v => T.vec2(v.x.mul(cs).sub(v.y.mul(sn)), v.x.mul(sn).add(v.y.mul(cs)));
      const u = rot(q).add(h.mul(T.vec2(5.37, 9.71))), gx = rot(dx), gy = rot(dy);
      const f = T.fract(q), e = T.min(T.min(f.x, T.float(1).sub(f.x)), T.min(f.y, T.float(1).sub(f.y)));
      const n0 = T.texture(tx.nrm, u).grad(gx, gy).xy.mul(2).sub(1);
      const nxy = T.vec2(n0.x.mul(cs).add(n0.y.mul(sn)), n0.x.mul(sn).negate().add(n0.y.mul(cs)));   // back into the surface tangent frame
      return { col: T.texture(tx.map, u).grad(gx, gy), orm: T.texture(tx.orm, u).grad(gx, gy), nxy, w: T.smoothstep(0.0, 0.22, e), h };
    };
    const A = layer(T.vec2(0, 0)), B = layer(T.vec2(0.5, 0.5));
    const col = T.mix(B.col, A.col, A.w), orm = T.mix(B.orm, A.orm, A.w), nxy = T.mix(B.nxy, A.nxy, A.w);
    const nt = T.vec3(nxy, T.sqrt(T.float(1).sub(T.dot(nxy, nxy)).max(0.0))).mul(0.5).add(0.5);
    // low-frequency world noise (value noise, 2 octaves) -> blend toward a 0.31x rotated scale + grime + per-panel tint
    const pw = T.positionWorld;
    const vn = p2 => { const c = T.floor(p2), f = T.fract(p2), u2 = f.mul(f).mul(T.float(3).sub(f.mul(2)));
      return T.mix(T.mix(h1(c), h1(c.add(T.vec2(1, 0))), u2.x), T.mix(h1(c.add(T.vec2(0, 1))), h1(c.add(T.vec2(1, 1))), u2.x), u2.y); };
    const wp = T.vec2(pw.x.add(pw.y.mul(0.7)), pw.z.sub(pw.y.mul(0.4)));
    const n1 = vn(wp.mul(0.045)), n2 = vn(wp.mul(0.17).add(13.1));
    const um = T.vec2(uvn.x.mul(0.25).sub(uvn.y.mul(0.17)), uvn.x.mul(0.17).add(uvn.y.mul(0.25)));   // 0.31x scale, rotated ~34 deg
    const colM = T.texture(tx.map, um);
    const Y = T.vec3(0.2126, 0.7152, 0.0722);
    const lumS = T.mix(T.dot(col.rgb, Y), T.dot(colM.rgb, Y), T.smoothstep(0.3, 0.75, n1).mul(0.6));
    const grime = T.smoothstep(0.55, 0.9, n2.mul(0.65).add(n1.mul(0.35))).mul(T.float(1.25).sub(orm.r));   // pools in cavities (AO)
    const panel = h1(T.floor(wp.mul(0.35)).add(T.floor(pw.y.mul(0.35))));                                 // scattered panel-to-panel variation
    const lum = lumS.div(AVG[s]).mul(T.float(0.9).add(panel.mul(0.2))).mul(T.float(1).sub(grime.mul(0.3))).clamp(0.3, 1.6);   // layered detail kept on every palette
    const metal = orm.b, dev = T.length(nxy);
    // hairline brushed scratches in the per-tile rotated frame (direction varies tile to tile), density varies by world noise;
    // continuous distance fade (no tiers)
    const near = T.float(1).sub(T.smoothstep(2.5, 14, T.length(T.positionView)));
    const sc = T.mix(B.h, A.h, A.w), su = T.vec2(uvn.x.mul(sc.x.sub(0.5).mul(0.6).add(1)), uvn.y).mul(T.vec2(6, 520));
    const row = T.floor(su.y.add(sc.y.mul(97)));
    const h = T.fract(T.sin(row.mul(12.9898).add(T.floor(su.x.add(T.fract(T.sin(row.mul(4.1)).mul(91.3)).mul(7))).mul(78.233))).mul(43758.5453));
    const streak = T.smoothstep(T.float(0.97).sub(n2.mul(0.2)), 1.0, h).mul(near);
    m.roughnessNode = orm.g.add(grime.mul(0.22)).add(panel.sub(0.5).mul(0.08)).mul(T.float(1).sub(streak.mul(0.45))).add(near.mul(h.sub(0.5)).mul(0.08)).clamp(0.04, 1);
    m.normalNode = T.normalize(T.normalMap(nt, T.vec2(NRM[s], NRM[s])).add(T.tangentView.mul(h.sub(0.5).mul(0.06).mul(near))));
    m.metalnessNode = metal;
    m.vertexColors = false;
    const k0 = s === 'hull' ? 0.05 : 0.12;
    if (nm === 'Lower_maze' || nm === 'Upper_maze') {
      // white slab; the maze channels (vertical walls) carry the vibrant inlay + a subtle glow
      const wall = T.float(1).sub(T.abs(T.normalGeometry.y)).smoothstep(0.65, 0.95);
      m.colorNode = T.mix(T.vec3(0.93, 0.94, 0.95).mul(lum.mul(0.25).add(0.75)), U.maze, wall.mul(0.7));
      m.emissiveNode = U.maze.mul(wall.mul(0.9)).add(T.vec3(0.05));
      m.metalnessNode = metal.mul(0.2); return;
    }
    if (nm === 'Temple') {
      // arches: white with a slow iridescent sheen (time + view angle + height); one cos per pixel
      const fr = T.float(1).sub(T.abs(T.dot(T.normalView, T.positionViewDirection))).pow(2);
      const ph = U.time.mul(0.004).add(T.positionWorld.y.mul(0.015)).add(fr.mul(0.6));
      const irid = T.cos(T.vec3(0, 2.094, 4.188).add(ph.mul(6.2832))).mul(0.5).add(0.5);
      const base = U.arch.mul(lum);
      m.colorNode = T.mix(base, base.mul(irid.mul(0.6).add(0.55)), fr.mul(0.5).add(0.2));
      m.emissiveNode = base.mul(0.1).add(irid.mul(fr).mul(0.12)); return;
    }
    if (nm === 'Altar') { m.colorNode = U.border.mul(lum); m.emissiveNode = U.border.mul(0.08); return; }
    if (s === 'hull') {
      const base = T.mix(U.hull, U.trim, metal.smoothstep(0.4, 0.8)).mul(lum);
      const line = dev.smoothstep(0.3, 0.5);   // panel seams / raised trim edges in the normal map
      m.colorNode = T.mix(base, U.glow, line.mul(0.5));
      m.emissiveNode = base.mul(k0).add(U.glow.mul(line).mul(U.k)); return;
    }
    if (s === 'trim') { m.colorNode = U.trim.mul(lum); m.emissiveNode = U.trim.mul(k0); return; }
    // obelisks, shard, gods/angels: keep their own vertex colour + self-light; detail + scratches still apply
    m.vertexColors = !!o.geometry.attributes.color;
  }
  let palT = 0;
  const _tick = P.tick;
  P.tick = function () { _tick(); if (!U) return; const now = performance.now(); U.time.value = now / 1000; if (now - palT > 1000) { palT = now; setPal(); } };
})();
