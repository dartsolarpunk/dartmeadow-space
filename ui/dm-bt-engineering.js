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
 * No lights, no shadows, nothing touched in the temple: it mirrors the temple LOD (shown exactly when the interior
 * decks are), and is compiled hidden (and registered with the flight warm-up) before it is ever shown.
 * Tuning: window.BTE.cfg (live).
 */
(function () {
  'use strict';
  const URL_GLB = 'assets/bt-engineering/bt-engineering.glb?v=1';
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
    // walk collision: the desk box joins the temple's collision soup (decor is FX_ = excluded); rebake when idle
    try {
      if (typeof TCOL !== 'undefined') {
        TCOL.for = null;
        const go = () => { try { if (typeof _tcolBuild === 'function') _tcolBuild(); } catch (e) { console.warn('[BTE] collision bake', e); } };
        (window.requestIdleCallback ? requestIdleCallback(go, { timeout: 1500 }) : setTimeout(go, 200));
      }
    } catch (e) { }
    // mirror the temple LOD: visible exactly when the interior decks are
    const ref = BIRD_TEMPLE.group.getObjectByName('BTI_Floor_C') || BIRD_TEMPLE.group.getObjectByName('BTI_Shell_C');
    const lod = () => { try { const v = ref ? ref.visible : true; if (sc.visible !== v) sc.visible = v; } catch (e) { } };
    lod(); BTE._lod = setInterval(lod, 250);
    // the hologram spin rides on dm-birdtemple's per-frame update (runs only while she walks the ship)
    const up = BTI.update;
    BTI.update = function (dt) { up(dt); if (BTE.holo && sc.visible) BTE.holo.rotation.y += dt * cfg.holoSpin; };
    BTE.ready = true;
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
