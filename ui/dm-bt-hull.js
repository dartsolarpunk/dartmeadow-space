/* (v131) Bird Temple hull + Ariel look (overrides only — the GLB is untouched).
 *   Hull: the 'Hull' node's (untextured) materials become brushed metal (metalness .55, roughness .38) with the baked
 *     'out' panorama (bake/bt-refl-out.webp) as their environment, so the metal has something to reflect; it receives the
 *     Sun's shadow (BTL sets receiveShadow) and Ariel + the board cast it (they already castShadow).
 *   Ariel: near/aboard the temple the Sun (the one shadowed star light, no new light) gets the loading-screen look — a soft
 *     warm key (colour 0xffe0bc, softer PCF radius) — and a grounded contact shadow: one small multiply-blended blob decal
 *     at her feet (no light, ~1 draw call), only while she stands on the ship.
 */
(function () {
  'use strict';
  const H = window.DMBtHull = { done: false, stats: {} };
  const T = () => window.THREE;
  let hullMats = [], env = null, blob = null, keyHold = null;
  function hullSetup() {
    const THREE = T(); const BT = window.BIRD_TEMPLE; if (!BT || !BT.group || !BT.spawned) return false;
    const root = BT._glb || BT.group;
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      let hull = false; for (let p = o; p && p !== root; p = p.parent) if (/^Hull$/i.test(p.name || '')) { hull = true; break; }
      if (!hull) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && !m.userData.btGlass && !m.userData.btHull && !m.map && 'metalness' in m) {
        m.userData.btHull = true; m.metalness = 0.55; m.roughness = Math.min(m.roughness, 0.38); m.envMapIntensity = 0.55; m.needsUpdate = true; hullMats.push(m);
      }
    });
    if (/[?&]bake=0\b/.test(location.search)) { H.stats.hullMats = hullMats.length; return true; }   // ?bake=0: no baked env fetch
    const im = new Image(); im.onload = () => { env = new THREE.Texture(im); env.mapping = THREE.EquirectangularReflectionMapping; env.colorSpace = THREE.SRGBColorSpace; env.needsUpdate = true; for (const m of hullMats) { m.envMap = env; m.needsUpdate = true; } H.stats.env = true; };
    im.src = 'bake/bt-refl-out-half.webp?v=131';
    H.stats.hullMats = hullMats.length; return true;
  }
  function mkBlob() {
    const THREE = T(), c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 4, 64, 64, 62); gr.addColorStop(0, 'rgba(0,0,0,0.62)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.32)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.name = 'BT_ContactShadow';
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    blob = new THREE.Mesh(g, m); blob.name = 'BT_ContactShadow'; blob.renderOrder = 2; blob.frustumCulled = false; blob.visible = false; blob.castShadow = false; blob.receiveShadow = false;
    if (typeof flightScene !== 'undefined' && flightScene) flightScene.add(blob);
  }
  const _p = {}; let _q = null;
  H.tick = function () {
    const THREE = T(); if (!THREE) return;
    if (!H.done) { try { H.done = hullSetup(); } catch (e) { H.stats.err = String(e).slice(0, 80); H.done = true; } }
    const BT = window.BIRD_TEMPLE, aboard = typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active;
    // warm soft key while at the temple (restored when leaving)
    try { const L = typeof _charShadowLight !== 'undefined' ? _charShadowLight : null;
      if (L) { const near = !!(BT && BT.group && BT.group.visible && (aboard || (window.BTL && BTL.ready && BTL._cw && BT._R0 && BTL._cw.distanceTo(BT.group.getWorldPosition(_p.g || (_p.g = new THREE.Vector3()))) < BT._R0 * 3)));
        if (near && !keyHold) { keyHold = { c: L.color.clone(), r: L.shadow.radius }; L.color.setHex(0xffe0bc); L.shadow.radius = 3; }
        else if (!near && keyHold) { L.color.copy(keyHold.c); L.shadow.radius = keyHold.r; keyHold = null; } } } catch (e) {}
    // contact shadow under Ariel while she stands on the ship
    try {
      if (!blob) mkBlob();
      const C = typeof CHAR !== 'undefined' ? CHAR : null;
      const on = aboard && C && C.root && BT && BT.group && BT.group.visible;
      blob.visible = !!on; if (!on) return;
      if (!_q) { _q = new THREE.Quaternion(); _p.a = new THREE.Vector3(); _p.u = new THREE.Vector3(); }
      C.root.getWorldPosition(_p.a); BT.group.getWorldQuaternion(_q); _p.u.set(0, 1, 0).applyQuaternion(_q);
      const h = (typeof SHIP_CHAR_H !== 'undefined' ? SHIP_CHAR_H : 0.454);
      blob.position.copy(_p.a).addScaledVector(_p.u, h * 0.006); blob.quaternion.copy(_q); blob.scale.setScalar(h * 0.42); blob.updateMatrixWorld();
    } catch (e) {}
  };
})();
