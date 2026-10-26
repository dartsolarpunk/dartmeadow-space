/* dm-bt-bake.js — Bird Temple baked GI, layer 1 of the hybrid (v120).
 *
 * Offline (tools/bake/): the Interior GLB is unwrapped into a lightmap atlas (xatlas, UV2, the GLB is never modified) and
 * path traced in Blender Cycles: irradiance (diffuse direct + indirect, NO Sun — the Sun stays real-time, layer 2) from the
 * altar light, the cube/neon/screen emissives and the dim space ambient, plus ambient occlusion. Shipped as separate assets:
 *   bake/bt-lm.json  per primitive: node name, primitive, vertex counts, byte offsets; the irradiance volume; the encode scale
 *   bake/bt-lm.bin   per primitive: source vertex map (vm), new index buffer, UV2 (uint16 unorm)
 *   bake/bt-irr[-half].webp, bake/bt-ao[-half].webp   the atlases (sRGB-encoded irradiance / linear AO)
 * Runtime: each matched temple mesh gets a rebuilt geometry (its own attributes gathered through vm + uv1) and its material
 * (cloned when an unbaked mesh shares it) gets lightMap + aoMap on channel 1. Applied BEFORE the temple warm-up compile.
 * Dynamic objects (Ariel, Madison, the board): a 12×8×24 irradiance volume sampled at Ariel feeds BTL's fixed BT_Bounce probe
 * (no extra light). Loaded lazily on temple approach. Tier: 0 = half-res atlases, lower intensity; 1 = half-res; 2+ = full. ?bake=0 or localStorage dm_bake=0
 * turns it all off; DMBtBake.setOn(false) restores the original geometry/materials. Layer 3 (Path Traced) is BTL.giTier.
 */
(function () {
  'use strict';
  const B = window.DMBtBake = { on: true, ready: false, applied: false, stats: {}, data: null };
  try { if (/[?&]bake=0\b/.test(location.search) || localStorage.getItem('dm_bake') === '0') B.on = false; } catch (e) { }
  const tier = () => { const s = (window.GFX && GFX.shadowSize) || 1024; return s >= 4096 ? 3 : s >= 2048 ? 2 : s >= 1024 ? 1 : 0; };
  const BASE = 'bake/';
  const san = n => String(n || '').replace(/\s/g, '_').replace(/[\[\].:\/]/g, '');
  let loading = null;
  B.load = function () {
    if (!B.on) return Promise.resolve(null);
    if (loading) return loading;
    const half = tier() < 2 ? '-half' : '';
    loading = (async () => {
      const THREE = window.THREE;
      const [meta, bin] = await Promise.all([fetch(BASE + 'bt-lm.json?v=139').then(r => r.json()), fetch(BASE + 'bt-lm.bin?v=139').then(r => r.arrayBuffer())]);
      const tl = new THREE.TextureLoader();
      const [irr, ao] = await Promise.all(['bt-irr', 'bt-ao'].map(n => tl.loadAsync(BASE + n + half + '.webp?v=139')));
      irr.colorSpace = THREE.SRGBColorSpace; ao.colorSpace = THREE.NoColorSpace;
      for (const t of [irr, ao]) { t.channel = 1; t.flipY = false; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; }
      B.data = { meta, bin, irr, ao }; B.ready = true; B.stats.bytes = bin.byteLength; B.stats.half = !!half;
      return B.data;
    })().catch(e => { B.stats.err = String(e && e.message || e).slice(0, 160); return null; });
    return loading;
  };
  function view(bin, off, n, big) { return big ? new Uint32Array(bin, off, n) : new Uint16Array(bin, off, n); }
  function rebuild(g0, e, bin) {
    const THREE = window.THREE, vm = view(bin, e.vm, e.n2, e.vm32), g = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(g0.attributes)) {
      const k = a.itemSize, Arr = a.array.constructor, out = new Arr(e.n2 * k);
      if (a.isInterleavedBufferAttribute) { for (let i = 0; i < e.n2; i++) for (let c = 0; c < k; c++) out[i * k + c] = a.getComponent(vm[i], c); }
      else { const src = a.array; for (let i = 0; i < e.n2; i++) { const s = vm[i] * k; for (let c = 0; c < k; c++) out[i * k + c] = src[s + c]; } }
      g.setAttribute(name, new THREE.BufferAttribute(out, k, a.normalized));
    }
    const uv = new Uint16Array(bin, e.uv, e.n2 * 2); g.setAttribute('uv1', new THREE.BufferAttribute(uv, 2, true));
    g.setIndex(new THREE.BufferAttribute(e.ind32 ? new Uint32Array(bin, e.ind, e.ni) : new Uint16Array(bin, e.ind, e.ni), 1));
    g.groups = []; g.computeBoundingBox(); g.computeBoundingSphere(); g.name = (g0.name || '') + '+lm';
    return g;
  }
  const undo = [];
  // the GLB root is BIRD_TEMPLE._glb (set in index.html); the baked data is in that root's space
  B.apply = function () {
    if (!B.on || !B.ready || B.applied) return 0;
    const T = typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE, root = T && (T._glb || (T.group && T.group.children[0])); if (!root) return 0;
    const THREE = window.THREE, { meta, bin, irr, ao } = B.data;
    const idx = new Map(); for (const e of meta.prims) idx.set(san(e.node) + '#' + e.prim, e);
    const hits = [], users = new Map();
    root.traverse(o => { if (!o.isMesh || !o.geometry || o.isInstancedMesh || o.isSkinnedMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) users.set(m, (users.get(m) || 0) + 1);
      let e = null;
      if (o.parent && o.parent !== root && o.parent.isGroup && o.parent.children.filter(c => c.isMesh).length > 1) { const i = o.parent.children.filter(c => c.isMesh).indexOf(o); e = idx.get(san(o.parent.name) + '#' + i); }
      if (!e) e = idx.get(san(o.name) + '#0');
      if (e && o.geometry.attributes.position && o.geometry.attributes.position.count === e.nv && !Array.isArray(o.material)) hits.push([o, e]); });
    const hitCount = new Map(); for (const [o] of hits) hitCount.set(o.material, (hitCount.get(o.material) || 0) + 1);
    const lmI = [0.55, 0.8, 1, 1][tier()] * meta.scale, aoI = [0.6, 0.8, 1, 1][tier()];
    const clones = new Map(); let n = 0;
    for (const [o, e] of hits) {
      const m0 = o.material; if (!m0 || !('lightMap' in m0) || m0.userData.btGlass) continue;
      let m = m0;
      if (hitCount.get(m0) !== users.get(m0)) { m = clones.get(m0); if (!m) { m = m0.clone(); if (m0.lightsNode) m.lightsNode = m0.lightsNode; m.userData = Object.assign({}, m0.userData); clones.set(m0, m); } }
      const g0 = o.geometry; undo.push([o, g0, m0]);
      o.geometry = rebuild(g0, e, bin); o.material = m;
      if (m.lightMap !== irr) { m.lightMap = irr; m.lightMapIntensity = lmI; m.aoMap = ao; m.aoMapIntensity = aoI; m.needsUpdate = true; }
      try { if (window.BTL && BTL.track) BTL.track(m); } catch (e) { }   // (v124) clones too: BTL's texture recheck rebuilds them if a map lands late
      n++;
    }
    B.applied = true; B.stats.meshes = n; B.stats.matched = hits.length; B.stats.prims = meta.prims.length; B.stats.clones = clones.size;
    console.log('[bake] lightmaps on', n, 'meshes of', meta.prims.length, 'baked primitives');
    return n;
  };
  B.setOn = function (on) {
    B.on = !!on; try { localStorage.setItem('dm_bake', on ? '1' : '0'); } catch (e) { }
    if (!on) { for (const [o, g0, m0] of undo.splice(0)) { o.geometry = g0; o.material = m0; } B.applied = false; if (window.BTL) BTL.volRGB = null; }
    else B.load().then(() => B.apply());
    return B.on;
  };
  // irradiance volume (glTF/root space) -> RGB at a world point, trilinear
  const _p = { v: null };
  B.sampleVol = function (world, out) {
    if (!B.ready || !B.applied) return null;
    const T = BIRD_TEMPLE, root = T._glb || T.group.children[0], V = B.data.meta.vol, THREE = window.THREE;
    const p = (_p.v || (_p.v = new THREE.Vector3())).copy(world); root.worldToLocal(p);
    const f = [0, 1, 2].map(i => Math.min(Math.max(((p.getComponent(i) - V.min[i]) / (V.max[i] - V.min[i])) * V.n[i] - 0.5, 0), V.n[i] - 1.0001));
    const i0 = f.map(Math.floor), t = f.map((x, i) => x - i0[i]); out[0] = out[1] = out[2] = 0;
    for (let k = 0; k < 8; k++) { const ix = i0[0] + (k & 1), iy = i0[1] + (k >> 1 & 1), iz = i0[2] + (k >> 2 & 1), w = (k & 1 ? t[0] : 1 - t[0]) * (k & 2 ? t[1] : 1 - t[1]) * (k & 4 ? t[2] : 1 - t[2]);
      const q = ((Math.min(ix, V.n[0] - 1) * V.n[1] + Math.min(iy, V.n[1] - 1)) * V.n[2] + Math.min(iz, V.n[2] - 1)) * 3;
      out[0] += V.rgb[q] * w; out[1] += V.rgb[q + 1] * w; out[2] += V.rgb[q + 2] * w; }
    return out;
  };
  let volT = 0; const rgb = [0, 0, 0];
  B.tick = function () {   // 5 Hz: the volume at Ariel -> BTL's bounce probe (Ariel, Madison and the board all use it)
    const n = performance.now(); if (n - volT < 200 || !B.applied || !window.BTL) return; volT = n;
    try { const THREE = window.THREE, w = B._w || (B._w = new THREE.Vector3()); if (!(typeof CHAR !== 'undefined' && CHAR && CHAR.root)) return; CHAR.root.getWorldPosition(w);
      if (B.sampleVol(w, rgb)) BTL.volRGB = rgb.map(x => x * [0.6, 0.85, 1, 1][tier()]); } catch (e) { }
  };
  // (v124) lazy: nothing is fetched at page load; the temple lighting asks for it on approach (BTL.preRender) and the
  // temple warm-up awaits it before the compile.
})();
