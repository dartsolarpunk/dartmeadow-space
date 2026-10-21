/* dm-bt-interior.js — Bird Temple interior render budget (v116). Separate code path from the temple lighting (#166).
 *
 * Below deck the hull hides the outside world, yet the frame still drew all of it: planets, the galaxy band, volumetric
 * dust, the star bubble, comets, the Oort cloud, the sky background and the true-atmosphere raymarch (full screen).
 * SEALED = the camera is inside the temple's volume, under the top deck, and no opening to the outside (the cargo-bay
 * side opening, the bridge's side + front glass, the hatch, the aft door, any glass mesh) is inside the view frustum.
 * While sealed, for the main render only: every flight-scene top-level object that is not the temple / Ariel / her
 * board / a light / a temple-owned helper is hidden, the background is cleared to black and the atmosphere pass is
 * skipped; all restored right after the render (visibility only — no material, pipeline or light-key change).
 * Conservative: an opening in view (even if a wall is in front of it) draws the world as before.
 *
 * Also here (per-frame budget, no visual change):
 *  - BTI screens (512×320 canvas textures, ~10 Hz each) only redraw/upload while on screen and within 45 units;
 *  - Madison's strand hair only draws while the camera is on her deck and within 30 units (the doll stays).
 * Tuning / debug: window.DMBtInterior ({on, sealed, stats, cfg}); ?btseal=0 turns the culling off.
 */
(function () {
  'use strict';
  const cfg = { on: !/[?&]btseal=0\b/.test(location.search), pad: 2.5, screenR: 45, hairR: 30, hairDY: 6 };
  const S = { cfg, on: cfg.on, sealed: false, stats: { frames: 0, sealedFrames: 0, hidden: 0 }, _boxes: null, _hid: [], _bg: undefined };
  window.DMBtInterior = S;
  let THREE, fr, M4, box, v;
  function init() {
    THREE = window.THREE; if (!THREE) return false;
    fr = new THREE.Frustum(); M4 = new THREE.Matrix4(); box = new THREE.Box3(); v = new THREE.Vector3();
    return true;
  }
  // openings to the outside, in temple-local coordinates (Blender layout from the BTI_Bay empty → local via BTI.toLocal)
  function buildBoxes() {
    const B = window.BTI, g = typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group;
    if (!B || !B.vol || !B.bay || !B.bay.L || !B.toLocal || !g) return null;
    const L = B.bay.L, out = [];
    const bl = (x0, x1, y0, y1, z0, z1) => { const b = new THREE.Box3(); b.expandByPoint(B.toLocal(x0, y0, z0)); b.expandByPoint(B.toLocal(x1, y1, z1)); out.push(b); };
    const zLo = (L.bf || -10.5) - 1.5, zHi = (L.bc || -0.3) + 1.0;
    if (L.bay) bl(22, 55, L.bay.y0 - 2, L.bay.y1 + 2, zLo, zHi);                                // the bay's open side
    const span = (q, i) => [Math.min(...q.map(p => p[i])), Math.max(...q.map(p => p[i]))];
    if (L.glass) { const y = span(L.glass, 0), z = span(L.glass, 1); bl(-55, 55, y[0] - 1, y[1] + 1, z[0] - 1, z[1] + 1); }    // bridge side glass (either side)
    if (L.glass_f) { const x = span(L.glass_f, 0), z = span(L.glass_f, 1); const y0 = L.cmd ? L.cmd.y0 : -77.6; bl(x[0] - 1, x[1] + 1, y0 - 4, y0 + 3, z[0] - 1, z[1] + 1); }   // bridge front glass
    if (L.east_door) bl(-55, 55, L.east_door[0] - 2, L.east_door[1] + 2, -30, 5);               // aft door (conservative: full width/height)
    const h = B.hatch && B.hatch.rect;
    if (h) out.push(new THREE.Box3(new THREE.Vector3(h.minX - 1, h.top - 10, h.minZ - 1), new THREE.Vector3(h.maxX + 1, h.top + 3, h.maxZ + 1)));   // the hatch up to the top deck
    // any glass in the temple (hull windows, BTI_Glass), local boxes
    g.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
    g.traverse(o => {
      if (!o.isMesh || !o.geometry) return; const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || !/glass|window/i.test(m.name || '') || /Holo/i.test(m.name || '')) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      out.push(o.geometry.boundingBox.clone().applyMatrix4(M4.multiplyMatrices(inv, o.matrixWorld)));
    });
    return out;
  }
  function isSealed(cam) {
    const B = window.BTI, g = typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group;
    if (!S.on || !B || !B.vol || !g || !g.visible) return false;
    if (!((typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active) && (B._depth || 0) > 0.9)) return false;
    if (!S._boxes) { S._boxes = buildBoxes(); if (!S._boxes) return false; }
    // the camera itself must be inside the hull volume and under the top deck
    const cl = g.worldToLocal(v.setFromMatrixPosition(cam.matrixWorld));
    const V = B.vol, dy = B.hatch ? B.hatch.deckY : 0.75;
    if (cl.x < V.mn.x || cl.x > V.mx.x || cl.z < V.mn.z || cl.z > V.mx.z || cl.y < V.mn.y || cl.y > dy - 0.6) return false;
    cam.updateMatrixWorld();
    fr.setFromProjectionMatrix(M4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    for (const b of S._boxes) {
      box.copy(b).expandByScalar(cfg.pad).applyMatrix4(g.matrixWorld);
      if (box.containsPoint(v.setFromMatrixPosition(cam.matrixWorld)) || fr.intersectsBox(box)) return false;
    }
    return true;
  }
  function keep(o) {
    if (o.isLight || o.isCamera) return true;
    if (typeof BIRD_TEMPLE !== 'undefined' && o === BIRD_TEMPLE.group) return true;
    if (typeof CHAR !== 'undefined' && CHAR && o === CHAR.root) return true;
    if (typeof boardFlight !== 'undefined' && o === boardFlight) return true;
    const n = o.name || '';
    if (/^(BT_|BTI|BTE|FX_BTE|JOTS_BTLight)/.test(n) || (o.userData && (o.userData.bti || o.userData.btStandIn || o.userData.keepAboard))) return true;
    if (o.children && o.children.some(c => c.isLight)) return true;   // a light's holder (target groups, pools)
    return false;
  }
  // call right before the main flight render; returns true when sealed (caller then skips the atmosphere pass)
  S.begin = function (scene, cam) {
    if (!THREE && !init()) return false;
    S.stats.frames++;
    let sealed = false; try { sealed = isSealed(cam); } catch (e) { sealed = false; }
    S.sealed = sealed; if (!sealed) return false;
    S.stats.sealedFrames++;
    const hid = S._hid; hid.length = 0;
    for (const o of scene.children) if (o.visible && !keep(o)) { o.visible = false; hid.push(o); }
    S.stats.hidden = hid.length;
    S._bg = scene.background; scene.background = null;
    return true;
  };
  S.end = function (scene) {
    if (!S.sealed) return;
    for (const o of S._hid) o.visible = true; S._hid.length = 0;
    if (S._bg !== undefined) { scene.background = S._bg; S._bg = undefined; }
  };
  // BTI screens: only the ones on screen and near redraw (dm-birdtemple asks per screen)
  const scrMeshes = new Map();
  S.screenVisible = function (s) {
    try {
      if (!THREE && !init()) return true;
      const cam = typeof flightCamera !== 'undefined' && flightCamera; if (!cam) return true;
      let ms = scrMeshes.get(s);
      if (!ms) { ms = []; BIRD_TEMPLE.group.traverse(o => { if (o.isMesh && (o.material === s.mat || (Array.isArray(o.material) && o.material.includes(s.mat)))) ms.push(o); }); scrMeshes.set(s, ms); }
      if (!ms.length) return true;
      cam.updateMatrixWorld(); fr.setFromProjectionMatrix(M4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      const cp = v.setFromMatrixPosition(cam.matrixWorld).clone();
      for (const o of ms) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const sp = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
        if (sp.center.distanceTo(cp) - sp.radius < cfg.screenR && fr.intersectsSphere(sp)) return true;
      }
      return false;
    } catch (e) { return true; }
  };
  // Madison's hair: drawn only on her deck and near
  let hairT = 0;
  S.tick = function () {
    const n = performance.now(); if (n - hairT < 200) return; hairT = n;
    try {
      const B = window.BTE, H = B && B.madison && B.madison.hair; if (!H || !H.mesh) return;
      const cam = typeof flightCamera !== 'undefined' && flightCamera; if (!cam || !THREE && !init()) return;
      const seat = H.mesh.parent && B.scene && B.scene.getObjectByName('FX_BTE_MadisonSeat');
      const p = (seat || H.mesh).getWorldPosition(new THREE.Vector3()), c = v.setFromMatrixPosition(cam.matrixWorld);
      const g = BIRD_TEMPLE.group, up = new THREE.Vector3(0, 1, 0).applyQuaternion(g.getWorldQuaternion(new THREE.Quaternion()));
      const s = g.scale.x || 1, d = c.distanceTo(p), dy = Math.abs(c.clone().sub(p).dot(up));
      H.mesh.visible = !S.on || (d < cfg.hairR * s && dy < cfg.hairDY * s);
    } catch (e) { }
  };
})();
