/* dm-bt-lighting.js — Bird Temple real-time lighting, shadows and glass (v110).
 *
 * Light budget (Justin, v110): the star is the only light for the ship, inside and out, and casts every real-time shadow.
 *   Ship materials see at most:
 *     outside (hull, top deck, hatch, stairwell top): JOTS_NatAmbient + Sol + the star's shadowed directional
 *                                                     + JOTS_MoonFill + BT_AltarLight + BT_CubeGlow       = 6
 *     inside  (decks, rooms, cargo bay, office):      ambient + the star's shadowed directional (through windows and the
 *                                                     open hatch) + BT_Caustic (the star's cookie through the nearest
 *                                                     window) + BT_Fill0/1 (2 unshadowed reading lights that follow
 *                                                     the room Ariel is in)                               = 5
 *   The 24 interior stand-ins, the 24 GLB lamps, the 3-point hull rig, altar and shard lamps are gone; neon is emissive.
 *   The pool (altar, cube glow, 2 fills, caustic) is fixed and created once before the warm-up compile, so nothing ever
 *   changes the light key. Only the star's directional casts shadows; at the temple its map is CACHED (re-rendered only
 *   when the star direction, the ship or Ariel move past a small tolerance).
 * Glass (hull windows + BTI_Glass): reflection + refraction from a cube probe at the window nearest the camera, Fresnel
 *   mixed in a node material; the probe renders one cube face per slice (time-sliced). Caustics: GPU-generated animated
 *   cookie (TSL quad into a 256² target) projected by BT_Caustic.
 * Material/light/render only: no geometry, deck, hatch, stairwell, cargo bay, collision or anchor changes.
 */
(function () {
  'use strict';
  const BTL = window.BTL = { ready: false, stats: {}, cfg: {} };
  const T = () => window.THREE;
  const tier = () => { const s = (window.GFX && GFX.shadowSize) || 1024; return s >= 4096 ? 3 : s >= 2048 ? 2 : s >= 1024 ? 1 : 0; };
  // per tier: [keyShadowMap, probeFace res, frames between probe faces, caustic Hz]  (Ultra keeps everything)
  const TIERS = [[512, 64, 4, 10], [1024, 128, 2, 20], [1024, 128, 1, 30], [2048, 256, 1, 30]];

  function BTI_RE_test(n) { return /^BT[IE]_/.test(n || ''); }

  let key = null, fills = null, altar = null, cubeGlow = null, caus = null, probe = null, probeRT = null, causRT = null, causQuad = null, causT = null;
  let causMode = 'light', causEmis = null, causMat = null, floorMats = [];
  let glassMats = [], glassMeshes = [], windows = [], extNode = null, intNode = null, snap = null;
  let face = 0, frame = 0, lastCaus = 0;

  function build() {
    const THREE = T(); if (!THREE || key) return;
    const tr = TIERS[tier()];
    const mk = (L, nm) => { L.name = nm; L.castShadow = false; L.userData.bti = true; L.userData.btStandIn = true; if (typeof flightScene !== 'undefined' && flightScene) flightScene.add(L); if (L.target && L.target.parent == null && flightScene) flightScene.add(L.target); return L; };
    fills = [mk(new THREE.PointLight(0xffffff, 0, 3.4, 2), 'BT_Fill0'), mk(new THREE.PointLight(0xffffff, 0, 3.4, 2), 'BT_Fill1')];
    altar = mk(new THREE.PointLight(0xfff2cc, 0, 5, 2), 'BT_AltarLight');
    cubeGlow = mk(new THREE.PointLight(0x8fd8ff, 0, 3.5, 2), 'BT_CubeGlow');
    key = fills[0];
    // caustic cookie, generated on the GPU (TSL quad into a small render target)
    const TS = THREE.TSL;
    causRT = new THREE.RenderTarget(256, 256, { type: THREE.HalfFloatType, generateMipmaps: false });
    causRT.texture.wrapS = causRT.texture.wrapT = THREE.ClampToEdgeWrapping;
    causT = TS.uniform(0);
    const cm = new THREE.MeshBasicNodeMaterial(); cm.name = 'BT_CausticGen';
    cm.colorNode = TS.Fn(() => {
      const uv0 = TS.uv(); const p = uv0.mul(7.0).toVar();
      for (let i = 0; i < 3; i++) {
        const k = 1.0 + i * 0.6;
        p.addAssign(TS.vec2(TS.sin(p.y.mul(k).add(causT.mul(0.9 + i * 0.35))), TS.cos(p.x.mul(k).sub(causT.mul(0.7 + i * 0.3)))).mul(0.55 / k));
      }
      const w = TS.abs(TS.sin(p.x).mul(TS.sin(p.y)));
      const c = TS.pow(TS.float(1).sub(w), 7.0).mul(1.6);
      const r = uv0.sub(0.5).length().mul(2.0);
      const vig = TS.float(1).sub(TS.smoothstep(0.55, 1.0, r));
      return TS.vec3(c.mul(1.0), c.mul(0.96), c.mul(0.85)).add(0.06).mul(vig);
    })();
    causQuad = new THREE.QuadMesh(cm);
    caus = new THREE.SpotLight(0xfff0d6, 0, 9, 0.55, 0.4, 1.5); caus.name = 'BT_Caustic'; caus.castShadow = false; mk(caus, 'BT_Caustic');
    // caustic path, decided once before anything compiles (the light key never changes afterwards):
    //   'light'    — the cookie is BT_Caustic.map (three's projected spot-light map, WebGPU + WebGL2 node backends)
    //   'emissive' — fallback: the same GPU cookie projected in the floor materials' emissive (no light map at all)
    // ?caustic=light|emissive overrides; iOS defaults to 'emissive' (untested there), as does any build without SpotLight.map.
    try { const q = (location.search.match(/[?&]caustic=(light|emissive)/) || [])[1];
      causMode = q || ((!('map' in caus)) || (window.GFX && GFX.isIOS) ? 'emissive' : 'light'); } catch (e) { causMode = 'light'; }
    if (causMode === 'light') caus.map = causRT.texture;
    causEmis = TS.uniform(0); causMat = TS.uniform(new THREE.Matrix4());
    BTL.causticMode = causMode;
    // probe
    probeRT = new THREE.CubeRenderTarget(tr[1], { type: THREE.HalfFloatType, generateMipmaps: false });
    probe = new THREE.CubeCamera(0.03, 1e6, probeRT); probe.name = 'BT_GlassProbe';
    [key, caus, probe].forEach(o => { o.matrixAutoUpdate = true; });
    BTL.stats = { shadowedLights: 1, poolLights: 5, probeRes: tr[1], probeFaceEvery: tr[2], causticHz: tr[3] };
  }

  // ── per-material light lists ──
  function lightSets() {
    const THREE = T(), ext = [], int = [];
    const amb = []; try { flightScene.traverse(o => { if (o.isAmbientLight || o.isHemisphereLight) amb.push(o); }); } catch (e) {}
    const star = (typeof _charShadowLight !== 'undefined') ? _charShadowLight : null;
    const sol = (typeof _sunLight !== 'undefined') ? _sunLight : null;
    amb.forEach(l => { ext.push(l); int.push(l); });
    if (sol) ext.push(sol); if (star) { ext.push(star); int.push(star); }
    try { if (window._NAT && _NAT.moon) ext.push(_NAT.moon); } catch (e) {}   // #165's moonlight fill (fixed, unshadowed) on the hull too
    ext.push(altar, cubeGlow); int.push(caus, fills[0], fills[1]);
    return { ext, int, sig: [sol, star].concat(amb) };
  }
  function nodes() {
    const s = lightSets(); snap = s;
    extNode = T().TSL.lights(s.ext); intNode = T().TSL.lights(s.int);
    BTL.stats.extLights = s.ext.length; BTL.stats.intLights = s.int.length;
  }
  function stale() { if (!snap) return true; return snap.sig.some(l => !l || !l.parent); }

  function glassMaterial(src, warm) {
    const THREE = T(), TS = THREE.TSL;
    const m = new THREE.MeshStandardNodeMaterial(); m.name = src.name || 'BT_Glass';
    m.roughness = 0.04; m.metalness = 0.0; m.color = new THREE.Color(0.02, 0.025, 0.03); m.side = src.side;
    m.userData.btGlass = true;
    m.emissiveNode = TS.Fn(() => {
      const V = TS.positionWorld.sub(TS.cameraPosition).normalize(), N = TS.normalWorld;
      const R = TS.reflect(V, N), Tr = TS.refract(V, N, TS.float(0.667));
      const cosT = TS.clamp(N.dot(V.negate()), 0.0, 1.0);
      const F = TS.float(0.04).add(TS.float(0.96).mul(TS.pow(TS.float(1).sub(cosT), 5.0)));
      const refl = TS.cubeTexture(probeRT.texture, R).rgb;
      const refr = TS.cubeTexture(probeRT.texture, Tr).rgb.mul(TS.vec3(0.82, 0.92, 0.95));
      const glow = TS.vec3(warm[0], warm[1], warm[2]);
      return TS.mix(refr.mul(0.85).add(glow), refl, F);
    })();
    return m;
  }

  function apply(root, inside) {
    try { build(); } catch (e) { console.warn('[BTL] build', e); }
    if (!root || !probeRT) return 0;
    if (!extNode || stale()) nodes();
    let n = 0;
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let nm = o.name || ''; for (let p = o.parent; p && p !== root; p = p.parent) nm += '|' + (p.name || '');
      const isWin = !inside && !Array.isArray(o.material) && (/window/i.test(nm) || /^BTI_Glass$/.test(o.material.name || ''));
      if (isWin && !o.material.userData.btGlass) {
        const warm = /^BTI_/.test(o.material.name || '') ? [0.02, 0.03, 0.035] : [0.12, 0.09, 0.05];
        const g = glassMaterial(o.material, warm); o.material = g; glassMats.push(g); glassMeshes.push(o);
        const c = new (T().Vector3)(); windows.push({ o, c });
      }
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m || !('lightsNode' in m) || m.isLineBasicMaterial || m.isPointsMaterial) continue;
        if (m.isMeshBasicMaterial || m.isMeshBasicNodeMaterial || m.lights === false) continue;
        const want = (inside || BTI_RE_test(m.name) || /^MAD_|Madison|Hair/i.test(m.name || '') || o.name === 'FX_MadisonHair') ? intNode : extNode;
        if (m.lightsNode !== want) { m.lightsNode = want; m.needsUpdate = true; n++; }
        if (!m.userData.btl) m.userData.btl = true;
      }
      if (causMode === 'emissive') for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && /^BTI_Floor/.test(m.name || '') && !m.userData.btCaus && 'emissiveNode' in m) {
        const TS = T().TSL; m.userData.btCaus = true; floorMats.push(m);
        const pc = causMat.mul(TS.vec4(TS.positionWorld, 1.0)), uvp = pc.xy.div(pc.w);   // shadow.matrix already maps to 0..1
        const inside = TS.step(0.0, pc.w).mul(TS.step(0.0, uvp.x)).mul(TS.step(uvp.x, 1.0)).mul(TS.step(0.0, uvp.y)).mul(TS.step(uvp.y, 1.0));
        const cst = TS.texture(causRT.texture, uvp).rgb.mul(TS.vec3(1.0, 0.94, 0.84)).mul(causEmis.mul(inside).mul(0.55));
        m.emissiveNode = (m.emissiveNode || TS.materialEmissive).add(cst); m.needsUpdate = true;
      }
      if (window.GFX && GFX.shadows) o.receiveShadow = true;
    });
    BTL.stats.causticMode = causMode; BTL.stats.causticFloors = floorMats.length; BTL.stats.glass = glassMeshes.length; BTL.stats.windows = windows.length;
    return n;
  }
  BTL.apply = function (root, inside) { const n = apply(root, inside); if (root === (typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group)) BTL.ready = true; return n; };

  // ── compile everything this module adds, for both the canvas and the probe target ──
  async function compileProbe(r, scene) {
    if (!r || !r.compileAsync || !probe) return;
    const un = []; scene.traverse(o => { if (o.frustumCulled) { o.frustumCulled = false; un.push(o); } });
    const prev = r.getRenderTarget(); let p = null;
    try { r.setRenderTarget(probeRT, 0); p = r.compileAsync(scene, probe.children[0]); } catch (e) {} finally { r.setRenderTarget(prev); for (const o of un) o.frustumCulled = true; }
    try { await p; } catch (e) {}
  }
  function renderCaustic(r, t) {
    if (!causQuad) return; causT.value = t;
    const prev = r.getRenderTarget(); try { r.setRenderTarget(causRT); causQuad.render(r); } finally { r.setRenderTarget(prev); }
  }
  BTL.warm = async function () {
    build(); const r = window.flightRenderer || (typeof flightRenderer !== 'undefined' ? flightRenderer : null); if (!r) return;
    try { renderCaustic(r, 0); } catch (e) { console.warn('[BTL] caustic warm', e); }
    try { const t0 = performance.now(); await compileProbe(r, flightScene); BTL._warmed = Math.round(performance.now() - t0); } catch (e) {}
  };
  // temple (and office) background compile: called by index.html's interior warm-up with decks visible
  BTL.warmTemple = async function (r, scene) { try { const t0 = performance.now(); await compileProbe(r, scene); BTL._warmedT = (BTL._warmedT || 0) + 1; BTL._warmedTms = Math.round(performance.now() - t0); } catch (e) {} };

  // ── per frame (called right before the main render) ──
  const V = () => T().Vector3;
  let _a, _b, _c, _d, _q, _m4 = null;
  const SIG = { star: new Float64Array(9).fill(NaN), sun: new Float64Array(3).fill(NaN) };
  function sigMoved(S, i, x, y, z, tol) { return !(Math.abs(S[i] - x) <= tol && Math.abs(S[i + 1] - y) <= tol && Math.abs(S[i + 2] - z) <= tol); }
  function sigStore(S, i, x, y, z) { S[i] = x; S[i + 1] = y; S[i + 2] = z; }
  BTL.cfg.minFill = 0.6;   // reading-light floor: a dark/switched-off room still gets this much from its nearest lamp
  function setFill(F, e, k) { if (e) { F.position.setFromMatrixPosition(e.mw); F.color.copy(e.src.color); F.intensity = Math.max(e.on || 0, BTL.cfg.minFill) * k; F.distance = Math.max(3, e.src.distance * 1.2); F.updateMatrixWorld(); } else F.intensity = 0; }
  const PROBE_REFRESH_MS = 4000;
  let probeAt = null, dirty = 63, lastFull = 0, lastFaceFrame = -99, casters = null; const holdA = [], holdN = [];
  const _upV = { v: null }; function _up(g) { const THREE = T(); if (!_upV.v) _upV.v = new THREE.Vector3(); g.getWorldQuaternion(_q); return _upV.v.set(0, 1, 0).applyQuaternion(_q); }
  function shipAboard() { return typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active; }
  function arielPos(out) { try { if (CHAR && CHAR.root) { CHAR.root.getWorldPosition(out); return true; } } catch (e) {} return false; }
  BTL.preRender = function (r, scene, cam) {
    if (BTL.debugCam) { try { const THREE = T(), m = BTL._dm || (BTL._dm = new THREE.Matrix4()), up = BTL._du || (BTL._du = new THREE.Vector3());
      const g0 = BIRD_TEMPLE.group; up.set(0, 1, 0); if (g0) up.applyQuaternion(g0.getWorldQuaternion(new THREE.Quaternion()));
      m.lookAt(BTL.debugCam.pos, BTL.debugCam.look, up); m.setPosition(BTL.debugCam.pos); cam.matrixWorldAutoUpdate = false; cam.matrixWorld.copy(m); cam.matrixWorldInverse.copy(m).invert(); } catch (e) {} }   // headless screenshots only (unset in play)
    else if (BTL._dm && cam.matrixWorldAutoUpdate === false) { cam.matrixWorldAutoUpdate = true; }
    if (!key || typeof BIRD_TEMPLE === 'undefined' || !BIRD_TEMPLE.group) return;
    const THREE = T(); if (!_a) { _m4 = new THREE.Matrix4(); _a = new THREE.Vector3(); _b = new THREE.Vector3(); _c = new THREE.Vector3(); _d = new THREE.Vector3(); _q = new THREE.Quaternion(); }
    const g = BIRD_TEMPLE.group; frame++;
    if (!BTL.ready) { if (BIRD_TEMPLE.spawned && window.BTI && BTI.ready) { apply(g); BTL.ready = true; } else return; }   // normally done by the interior warm-up first
    if (!g.visible) { for (const L of [fills[0], fills[1], altar, cubeGlow, caus]) L.intensity = 0; return; }
    g.updateMatrixWorld(); g.getWorldPosition(_a);
    const R0 = (BIRD_TEMPLE._R0 || 10);
    const camW = BTL._cw || (BTL._cw = new THREE.Vector3()); camW.setFromMatrixPosition(cam.matrixWorld);
    const camNear = camW.distanceTo(_a) < R0 * 3;
    const aboard = shipAboard();
    const hasA = arielPos(_b);
    const near = camNear || aboard;
    if (!near) {   // far from the ship: nothing below runs (no window loop, no signatures); star shadow back to the game's own updates
      fills[0].intensity = fills[1].intensity = caus.intensity = 0;
      try { const L = _charShadowLight; if (L && L.shadow && !L.shadow.autoUpdate) { L.shadow.autoUpdate = true; SIG.star[0] = NaN; } } catch (e) {}
      altar.intensity = 0; cubeGlow.intensity = 0; return;
    }
    // star direction at the ship (Sol at the origin)
    _c.copy(_a); if (_c.lengthSq() < 1e-6) _c.set(1, 0.3, 0.2); _c.normalize();   // from Sol toward the ship
    // 1) star cascade: cached while at the temple; numeric signature (light pos, ship quat, Ariel) with tolerances
    try {
      const L = _charShadowLight;
      if (L && L.shadow) {
        L.updateMatrixWorld(); g.getWorldQuaternion(_q);
        const S = SIG.star; L.shadow.autoUpdate = false;
        if (sigMoved(S, 0, L.position.x, L.position.y, L.position.z, 0.01) || sigMoved(S, 3, _q.x, _q.y, _q.z, 0.0005) || (hasA && sigMoved(S, 6, _b.x, _b.y, _b.z, 0.01))) {
          sigStore(S, 0, L.position.x, L.position.y, L.position.z); sigStore(S, 3, _q.x, _q.y, _q.z); if (hasA) sigStore(S, 6, _b.x, _b.y, _b.z);
          L.shadow.needsUpdate = true; BTL.stats.starRenders = (BTL.stats.starRenders || 0) + 1;
        }
      }
    } catch (e) {}
    // 2) two reading lights: the lit interior lamps nearest Ariel (only below deck), unshadowed; top-2 search, no allocations
    let e0 = null, e1 = null, d0 = 49, d1 = 49;
    if (aboard && hasA) {
      try { for (const e of _btHold.used) { if (!e.src) continue; _d.setFromMatrixPosition(e.mw); const d = _d.distanceToSquared(_b);
        if (d < d0) { e1 = e0; d1 = d0; e0 = e; d0 = d; } else if (d < d1) { e1 = e; d1 = d; } } } catch (e) {}
    }
    setFill(fills[0], e0, 1.0); setFill(fills[1], e1, 0.7);
    // outside: the altar light and the session cubes' glow
    try { const an = BIRD_TEMPLE._altarNode || (BIRD_TEMPLE._altarNode = (typeof shipNode === 'function' && shipNode(g, 'Altar Group')) || null);
      if (an) { an.updateWorldMatrix(true, false); altar.position.setFromMatrixPosition(an.matrixWorld); altar.position.addScaledVector(_up(g), 0.45); altar.intensity = 6; altar.updateMatrixWorld(); } else altar.intensity = 0; } catch (e) { altar.intensity = 0; }
    try { const cr = (typeof BT_CUBES !== 'undefined') && BT_CUBES.root; if (cr && cr.visible) { cr.updateWorldMatrix(true, false); cubeGlow.position.setFromMatrixPosition(cr.matrixWorld); cubeGlow.intensity = 3; cubeGlow.updateMatrixWorld(); } else cubeGlow.intensity = 0; } catch (e) { cubeGlow.intensity = 0; }
    // 3) window centres (ship-relative, so refreshed only while near), nearest to Ariel (caustic) and to the camera (probe)
    const ref = hasA && aboard ? _b : camW; let w = null, wd = 1e9, wc = null, cd = 1e9;
    for (const it of windows) { it.o.getWorldPosition(it.c); const d = it.c.distanceToSquared(ref); if (d < wd) { wd = d; w = it; } const dc = it.c.distanceToSquared(camW); if (dc < cd) { cd = dc; wc = it; } }
    const tr = TIERS[tier()];
    if (aboard && w && wd < 100) {
      caus.position.copy(w.c).addScaledVector(_c, -1.2); caus.target.position.copy(w.c).addScaledVector(_c, 4);
      caus.updateMatrixWorld(); caus.target.updateMatrixWorld();
      if (causMode === 'light') caus.intensity = 6; else { caus.intensity = 0; causEmis.value = 1; caus.shadow.updateMatrices(caus); causMat.value.copy(caus.shadow.matrix); }
      const now = performance.now();
      if (now - lastCaus > 1000 / tr[3]) { lastCaus = now; try { renderCaustic(r, now / 1000); } catch (e) {} }
    } else { caus.intensity = 0; if (causEmis) causEmis.value = 0; }
    // 4) glass probe: ON DEMAND. All 6 faces are marked dirty when the probe changes window or the star direction moves;
    //    a slow refresh re-marks them every few seconds (the world drifts). At most one face per `every` frames.
    if (camNear && wc && probe) {
      if (wc !== probeAt || sigMoved(SIG.sun, 0, _c.x, _c.y, _c.z, 0.002)) { probeAt = wc; sigStore(SIG.sun, 0, _c.x, _c.y, _c.z); dirty = 63; }
      const now = performance.now(); if (!dirty && now - lastFull > PROBE_REFRESH_MS) dirty = 63;
      if (dirty && frame - lastFaceFrame >= Math.max(2, tr[2] + 1)) {
        while (!(dirty & (1 << face))) face = (face + 1) % 6;
        if (face === 0 || dirty === 63) probe.position.copy(wc.c), probe.updateMatrixWorld(true);
        if (!casters) { casters = []; scene.traverse(o => { if (o.isLight && o.shadow && o.castShadow !== undefined) casters.push(o); }); }   // cached: the scene's light set is fixed
        for (let i = 0; i < casters.length; i++) { const o = casters[i]; holdA[i] = o.shadow.autoUpdate; holdN[i] = o.shadow.needsUpdate; o.shadow.autoUpdate = false; o.shadow.needsUpdate = false; }
        for (const m of glassMeshes) m.visible = false;
        const prev = r.getRenderTarget(), pac = r.autoClear, tp = performance.now();
        try { r.setRenderTarget(probeRT, face); r.autoClear = true; r.render(scene, probe.children[face]); BTL.stats.probeMs = Math.round(performance.now() - tp); }
        catch (e) {}
        finally { r.setRenderTarget(prev); r.autoClear = pac; for (const m of glassMeshes) m.visible = true; for (let i = 0; i < casters.length; i++) { casters[i].shadow.autoUpdate = holdA[i]; casters[i].shadow.needsUpdate = holdN[i]; } }
        dirty &= ~(1 << face); if (!dirty) lastFull = now; lastFaceFrame = frame; face = (face + 1) % 6; BTL.stats.probeFaces = (BTL.stats.probeFaces || 0) + 1;
      }
    }
  };
  BTL.afterSync = function () {};

  if (window.DMWarm) DMWarm.add('bt-lighting', () => BTL.warm()); else window.addEventListener('load', () => window.DMWarm && DMWarm.add('bt-lighting', () => BTL.warm()));
  BTL.build = build;
})();
