/* dm-bt-engineering.js — Bird Temple engineering office (lower deck, engine room) + the Madison plush + Polaroid.
 *
 * Purely additive. The art is one compact GLB (assets/bt-engineering/bt-engineering.glb, meshopt + webp, ~125 KB),
 * built by the scripted Blender source in assets/blender/bt-engineering/ (build_office.py → .blend + .glb). It is
 * authored in the temple model's own frame, so it is dropped into the temple's glTF root unchanged: no offsets here.
 *
 *   FX_BTE_Office   desk, terminal, stool, mat, shelf, Madison, Polaroid: 4 merged static meshes, 4 shared materials.
 *                   The FX_ prefix keeps all of it out of the walk collision (dm-birdtemple's _shipWalkMeshes filter).
 *     FX_BTE_Holo   wireframe planet over the desk projector: the only per-frame cost (one rotation, only while aboard).
 *   BTE_DeskCollider  hidden box = the desk's footprint/height, the ONLY thing added to the walk collision.
 *
 * No lights, no shadows, nothing touched in the temple. Visibility mirrors the temple's interior LOD through a
 * visible accessor on BTI_Floor_C (no polling, no timers). Collision: the desk's 12 triangles are appended to
 * the already-baked TCOL grid (no rebake). Compiled hidden + registered with the flight warm-up before it shows.
 * Tuning: window.BTE.cfg (live).
 */
(function () {
  'use strict';
  const URL_GLB = 'assets/bt-engineering/bt-engineering.glb?v=3';
  const cfg = { holoSpin: 0.6, selfLight: 0.16, glow: 1.35, holoOpacity: 0.75 };
  const BTE = { cfg, ready: false, root: null, holo: null, collider: null };
  window.BTE = BTE;

  function templeRoot() {     // the temple's glTF scene (child of the scaled wrapper) = the frame the GLB is authored in
    const g = BIRD_TEMPLE.group, ref = g.getObjectByName('BTI_Interior');
    if (!ref) return null;
    let o = ref; while (o.parent && o.parent !== g) o = o.parent;
    return o.parent === g ? o : null;
  }
  async function loader() {
    const L = new THREE.GLTFLoader();
    try { const m = await import('three/addons/libs/meshopt_decoder.module.js'); L.setMeshoptDecoder(m.MeshoptDecoder); }
    catch (e) { console.warn('[BTE] meshopt decoder', e); }
    return L;
  }
  function tidyMaterials(scene) {
    const seen = new Set();
    scene.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false;
      const m = o.material; if (!m || seen.has(m)) return; seen.add(m);
      if (m.name === 'BTE_Felt' || m.name === 'BTE_Polaroid') {   // the interior is night-dim: a little self light so they read
        m.emissive && m.emissive.setRGB(1, 1, 1); m.emissiveMap = m.map; m.emissiveIntensity = cfg.selfLight; if ('envMapIntensity' in m) m.envMapIntensity = 0.12;
      } else if (m.name === 'BTE_Glow' || m.name === 'BTE_Screen') {
        m.emissive && m.emissive.setRGB(1, 1, 1); m.emissiveIntensity = cfg.glow; m.toneMapped = true;
      } else if (m.name === 'BTE_Holo') {
        m.transparent = true; m.opacity = cfg.holoOpacity; m.depthWrite = false; m.blending = THREE.AdditiveBlending;
        m.side = THREE.DoubleSide; if (m.color) m.color.setRGB(0.25, 0.95, 0.9); if (m.emissive) m.emissive.setRGB(0.3, 1, 0.95);
      }
      m.needsUpdate = true;
    });
  }
  function lodRef() {   // first BTI_-material mesh of the lower deck (the LOD's own unit of switching)
    const g = BIRD_TEMPLE.group;
    for (const n of ['BTI_Floor_C', 'BTI_Shell_C']) {
      const o = g.getObjectByName(n); if (!o) continue;
      let hit = null;
      o.traverse(m => { if (!hit && m.isMesh) { const mt = Array.isArray(m.material) ? m.material[0] : m.material; if (mt && /^BTI_/.test(mt.name || '')) hit = m; } });
      if (hit) return hit;
    }
    return null;
  }
  // Append the desk box's 12 triangles to the baked TCOL grid in place (same cells, same frame).
  // If TCOL isn't baked yet, nothing to do: the first bake already includes BTE_DeskCollider.
  function addDeskToCollision() {
    if (typeof TCOL === 'undefined' || !BTE.collider) return;
    const g = BIRD_TEMPLE.group;
    if (TCOL.for !== g || !TCOL.T) return;
    const mesh = []; BTE.collider.traverse(o => { if (o.isMesh) mesh.push(o); });
    g.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
    const add = [];
    for (const o of mesh) {
      const geo = o.geometry, pos = geo.attributes.position, idx = geo.index; m.multiplyMatrices(inv, o.matrixWorld);
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        const t = [];
        for (let j = 0; j < 3; j++) { v.fromBufferAttribute(pos, idx ? idx.getX(i + j) : i + j).applyMatrix4(m); t.push(v.x, v.y, v.z); }
        add.push(t);
      }
    }
    const k0 = TCOL.n, K = k0 + add.length, T = new Float32Array(K * 9), N = new Float32Array(K * 3), ST = new Uint8Array(K);
    T.set(TCOL.T.subarray(0, k0 * 9)); N.set(TCOL.N.subarray(0, k0 * 3)); if (TCOL.ST) ST.set(TCOL.ST.subarray(0, k0));
    const cells = new Map(); let k = k0;
    for (const t of add) {
      const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2], wx = t[6] - t[0], wy = t[7] - t[1], wz = t[8] - t[2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz);
      if (!(l > 1e-9)) continue;
      T.set(t, k * 9); N[k * 3] = nx / l; N[k * 3 + 1] = ny / l; N[k * 3 + 2] = nz / l;
      const cl = (a, n) => Math.max(0, Math.min(n - 1, a));
      const i0 = cl(Math.floor((Math.min(t[0], t[3], t[6]) - TCOL.x0) / TCOL.cs), TCOL.gx), i1 = cl(Math.floor((Math.max(t[0], t[3], t[6]) - TCOL.x0) / TCOL.cs), TCOL.gx);
      const j0 = cl(Math.floor((Math.min(t[2], t[5], t[8]) - TCOL.z0) / TCOL.cs), TCOL.gz), j1 = cl(Math.floor((Math.max(t[2], t[5], t[8]) - TCOL.z0) / TCOL.cs), TCOL.gz);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const c = j * TCOL.gx + i; (cells.get(c) || cells.set(c, []).get(c)).push(k); }
      k++;
    }
    // rebuild the CSR cell index with the extra entries (array copy only, no mesh re-read)
    const C = TCOL.gx * TCOL.gz, start = new Uint32Array(C + 1), old = TCOL.start, oi = TCOL.items;
    for (let c = 0; c < C; c++) start[c + 1] = start[c] + (old[c + 1] - old[c]) + (cells.has(c) ? cells.get(c).length : 0);
    const items = new Uint32Array(start[C]);
    for (let c = 0; c < C; c++) {
      let w = start[c]; for (let q = old[c]; q < old[c + 1]; q++) items[w++] = oi[q];
      const ex = cells.get(c); if (ex) for (const t of ex) items[w++] = t;
    }
    Object.assign(TCOL, { T, N, ST, n: k, start, items, stamp: new Uint32Array(k), sid: 0 });
    console.log('[BTE] desk added to temple collision:', k - k0, 'triangles (no rebake)');
  }
  async function init() {
    const root = templeRoot(); if (!root) { console.log('[BTE] no temple interior — idle'); return; }
    const gltf = await (await loader()).loadAsync(URL_GLB);
    const sc = gltf.scene; sc.name = 'BTE_Engineering';
    tidyMaterials(sc);
    BTE.root = sc.getObjectByName('FX_BTE_Office');
    BTE.holo = sc.getObjectByName('FX_BTE_Holo');
    BTE.collider = sc.getObjectByName('BTE_DeskCollider');
    if (BTE.collider) BTE.collider.traverse(o => { o.visible = false; });   // collision only
    sc.visible = false;
    root.add(sc);
    sc.updateMatrixWorld(true);
    sc.traverse(o => { if (o !== BTE.holo && !(BTE.holo && o.parent === BTE.holo)) o.matrixAutoUpdate = false; });
    if (BTE.holo) BTE.holo.matrixAutoUpdate = true;
    BTE.scene = sc;
    // compile before first show (same helper the temple uses), and register with the flight warm-up
    try { if (window.DMWarm && DMWarm.add) DMWarm.add('engineering office', () => (typeof _dmCompileObject === 'function') && _dmCompileObject(sc)); } catch (e) { }
    try { if (typeof _dmCompileObject === 'function') await _dmCompileObject(sc); } catch (e) { }
    // walk collision: only the desk box joins the temple's existing collision soup (no rebake; decor is FX_ = excluded)
    addDeskToCollision();
    // visibility mirrors the temple's interior LOD (index.html toggles .visible on every BTI_-material mesh).
    // No polling: BTI_Floor_C (a single-primitive BTI_Floor mesh in 'Bird Temple Interior.glb') gets a visible
    // accessor that forwards each change to the office.
    const ref = lodRef();
    if (ref) {
      let v = ref.visible; sc.visible = v;
      Object.defineProperty(ref, 'visible', { configurable: true, enumerable: true, get() { return v; }, set(x) { v = x; sc.visible = x; } });
    } else { sc.visible = true; console.warn('[BTE] no interior LOD reference mesh; office always visible'); }
    // the hologram spin rides on dm-birdtemple's per-frame update (runs only while she walks the ship)
    const up = BTI.update;
    BTI.update = function (dt) { up(dt); if (BTE.holo && sc.visible) BTE.holo.rotation.y += dt * cfg.holoSpin; };
    BTE.ready = true;
    try { window.dispatchEvent(new CustomEvent('bte:ready')); } catch (e) { }
    console.log('[BTE] engineering office ready');
  }
  let tries = 0;
  const boot = setInterval(() => {
    tries++;
    try {
      if (window.BTI && BTI.ready && typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group && window.THREE && THREE.GLTFLoader) {
        clearInterval(boot); init().catch(e => console.warn('[BTE] init', e));
      }
    } catch (e) { clearInterval(boot); console.warn('[BTE] boot', e); }
    if (tries > 900) clearInterval(boot);
  }, 700);
})();
