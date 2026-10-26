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
 * (v139) BAKED GLASS: the live cube probe, viewport refraction, caustic cookie and the window joint (pane) solve are gone.
 *   Each room has a Cycles-baked equirect reflection (bake/bt-refl-<room>.webp, tools/bake/lm_cubes.py) looked up box-projected
 *   from a flat, camera-facing normal (the GLB's window normals are unreliable). Panes stay clear (≈10% opaque head-on).
 *   Only the Sun (star) shadow is live. Old notes below kept for history.
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

  let bounce = null, key = null, fills = null, altar = null, cubeGlow = null, caus = null, probe = null, probeRT = null, readRT = null, writeRT = null, cubeNodes = [], causRT = null, causQuad = null, causT = null;
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
    // (v118) bounce: one LightProbe (SH, no shadow, fixed in the light key) standing in for the star light bouncing off the
    // sun-lit hull/deck/floors into the interior. Its SH is rebuilt on demand (star direction or ship attitude moved).
    bounce = mk(new THREE.LightProbe(), 'BT_Bounce'); bounce.intensity = 0;
    const TS = THREE.TSL;
    reflU = { toLocal: TS.uniform(new THREE.Matrix4()), inside: TS.uniform(0) };
    BTL.causticMode = 'off';
    key.matrixAutoUpdate = true;
    BTL.stats = { shadowedLights: 1, poolLights: 5, glass: 'baked' }; void tr;
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
    ext.push(altar, cubeGlow); int.push(fills[0], fills[1]); if (bounce) int.push(bounce);
    return { ext, int, sig: [sol, star].concat(amb) };
  }
  function nodes() {
    const s = lightSets(); snap = s;
    extNode = T().TSL.lights(s.ext); intNode = T().TSL.lights(s.int);
    BTL.stats.extLights = s.ext.length; BTL.stats.intLights = s.int.length;
  }
  function stale() { if (!snap) return true; return snap.sig.some(l => !l || !l.parent); }

  // (v118) glass is TRANSPARENT again (#166 made it an opaque node material whose emissive was the probe: with a half-filled
  // or outside-blind probe the panes read as flat pale panels). Now: alpha-blended, Fresnel opacity (≈8% head-on, ~85% grazing),
  // refraction = the opaque pass behind the pane (viewport texture, offset by the normal) on tier ≥ 1 or plain see-through on
  // tier 0, reflection = the cube probe weighted by Fresnel and only once all 6 faces are filled, plus animated caustic glints.
  // (v139) baked reflections: one texture per room, filled when bake/rooms.json + webps arrive (lazy, near the temple)
  let reflU = null; const REFL = { rooms: null, tex: {}, loading: false };
  function reflTex(k) {
    const THREE = T(); if (REFL.tex[k]) return REFL.tex[k];
    const c = document.createElement('canvas'); c.width = 2; c.height = 1; const x = c.getContext('2d'); x.fillStyle = '#1a1c24'; x.fillRect(0, 0, 2, 1);
    const t = new THREE.Texture(c); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true;
    return (REFL.tex[k] = t);
  }
  const ROOM_C = { bay: [3.33, -4.7, 0], cmd: [3.5, -4.2, 58.12], hall: [5, -9.08, -93.37], crew: [-2, -19.4, -100.5], engine: [-2, -20.4, -85.15], mess: [-2, -11.9, -92.5], nav: [-2, -4.4, -92.33], store: [-8.2, -11.9, -101.5] };
  BTL.loadRefl = function () {
    if (REFL.loading) return; REFL.loading = true;
    fetch('bake/bt-refl.json?v=139').then(r => r.json()).then(j => {
      REFL.rooms = j.rooms;
      for (const m of glassMats) { const R = j.rooms[m.userData.room]; if (R) { m.userData.bmin.value.fromArray(R.bmin); m.userData.bmax.value.fromArray(R.bmax); m.userData.rc.value.fromArray(R.c); } }
      const half = tier() < 2 ? '-half' : '';
      for (const k of Object.keys(j.rooms)) { const im = new Image(); im.decoding = 'async'; im.onload = () => { const t = reflTex(k); t.image = im; t.needsUpdate = true; BTL.stats.reflLoaded = (BTL.stats.reflLoaded || 0) + 1; }; im.src = 'bake/bt-refl-' + k + half + '.webp?v=139'; }
    }).catch(e => { BTL.stats.reflErr = String(e).slice(0, 80); });
  };
  function nearestRoom(pl) { let best = 'bay', bd = 1e18; for (const k in ROOM_C) { const c = ROOM_C[k], d = (c[0] - pl.x) ** 2 + 2 * (c[1] - pl.y) ** 2 + (c[2] - pl.z) ** 2; if (d < bd) { bd = d; best = k; } } return best; }
  const glassByKey = {};
  function glassMaterial(src, warm, room) {
    const THREE = T(), TS = THREE.TSL, key0 = room + '|' + warm.join() + '|' + src.side;
    if (glassByKey[key0]) return glassByKey[key0];
    const m = new THREE.MeshStandardNodeMaterial(); m.name = (src.name || 'BT_Glass') + '_baked_' + room;
    m.roughness = 0.04; m.metalness = 0.0; m.color = new THREE.Color(0, 0, 0); m.side = THREE.DoubleSide;
    m.transparent = true; m.depthWrite = false; m.userData.btGlass = true; m.userData.room = room;
    const c0 = ROOM_C[room]; const rc = TS.uniform(new THREE.Vector3(c0[0], c0[1], c0[2])), bmin = TS.uniform(new THREE.Vector3(c0[0] - 8, c0[1] - 2, c0[2] - 8)), bmax = TS.uniform(new THREE.Vector3(c0[0] + 8, c0[1] + 4, c0[2] + 8));
    m.userData.rc = rc; m.userData.bmin = bmin; m.userData.bmax = bmax;
    // window normals: a flat, camera-facing normal from screen derivatives (the GLB's pane normals are smoothed into the frames / flipped)
    const V = TS.positionWorld.sub(TS.cameraPosition).normalize();
    const Nf = TS.dFdx(TS.positionWorld).cross(TS.dFdy(TS.positionWorld)).normalize();
    const N = Nf.mul(TS.sign(Nf.dot(V.negate())).add(0.0001).sign());
    const cosT = TS.clamp(N.dot(V.negate()), 0.0, 1.0);
    const F = TS.float(0.04).add(TS.float(0.96).mul(TS.pow(TS.float(1).sub(cosT), 5.0)));
    const R = TS.reflect(V, N), Pl = reflU.toLocal.mul(TS.vec4(TS.positionWorld, 1.0)).xyz, Rl = reflU.toLocal.mul(TS.vec4(R, 0.0)).xyz.normalize();
    const Rs = Rl.add(TS.vec3(1e-5)), t1 = bmax.sub(Pl).div(Rs), t2 = bmin.sub(Pl).div(Rs), tf = TS.max(t1, t2);
    const dh = TS.max(TS.min(TS.min(tf.x, tf.y), tf.z), 0.0), d = Pl.add(Rl.mul(dh)).sub(rc).normalize();
    const eq = (dir) => TS.vec2(TS.atan(dir.z, dir.x).mul(1 / (2 * Math.PI)).add(0.5), TS.asin(TS.clamp(dir.y, -1.0, 1.0)).mul(1 / Math.PI).add(0.5));
    const cin = TS.texture(reflTex(room), eq(d)).rgb, cout = TS.texture(reflTex('out'), eq(Rl)).rgb;
    const refl = TS.mix(cout, cin, reflU.inside);
    const alpha = TS.clamp(F.mul(0.85).add(0.07), 0.0, 0.9);
    m.opacityNode = alpha;
    m.emissiveNode = refl.mul(F).mul(0.9).div(TS.max(alpha, 0.05)).add(TS.vec3(warm[0], warm[1], warm[2]).mul(0.3));
    glassByKey[key0] = m; glassMats.push(m);
    return m;
  }

  // (v117) every material this module touched, with a signature of its texture slots: a texture that arrives (or is
  // swapped in by the interior/engineering setup) after the light lists were applied re-flags the material, so its
  // program is rebuilt with the map instead of staying compiled untextured (first load after an update).
  const mats = new Set(); const SLOTS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'lightMap', 'envMap', 'alphaMap'];
  BTL.track = function (m) { if (!m || mats.has(m)) return; m.userData.btl = true; mats.add(m); m.userData.btlSig = texSig(m); };
  function texSig(m) { let s = ''; for (const k of SLOTS) { const t = m[k]; s += t ? (t.uuid.slice(0, 4) + (t.image ? 1 : 0)) : '-'; } return s; }
  let lastSig = 0;
  function recheck() { let n = 0; for (const m of mats) { const s = texSig(m); if (s !== m.userData.btlSig) { m.userData.btlSig = s; m.needsUpdate = true; n++; } } if (n) BTL.stats.retex = (BTL.stats.retex || 0) + n; }
  function apply(root, inside) {
    try { build(); } catch (e) { console.warn('[BTL] build', e); }
    if (!root || !key) return 0;
    if (!extNode || stale()) nodes();
    let n = 0;
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      // (v121) the per-mesh list used to be called `mats` too, shadowing the module Set: `mats.add` threw on the first lit material and aborted the whole temple apply (light lists, receiveShadow) since v117
      let nm = o.name || ''; for (let p = o.parent; p && p !== root; p = p.parent) nm += '|' + (p.name || '');
      const isWin = !inside && !Array.isArray(o.material) && (/window/i.test(nm) || /^BTI_Glass$/.test(o.material.name || ''));
      if (isWin && !o.material.userData.btGlass) {
        const warm = /^BTI_/.test(o.material.name || '') ? [0.02, 0.03, 0.035] : [0.12, 0.09, 0.05];
        const gr = (typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE._glb) || root, pl = new (T().Vector3)();
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); o.geometry.boundingBox.getCenter(pl); o.updateWorldMatrix(true, false); gr.updateWorldMatrix(true, false);
        pl.applyMatrix4(o.matrixWorld); gr.worldToLocal(pl);
        const g = glassMaterial(o.material, warm, nearestRoom(pl)); o.material = g; glassMeshes.push(o);
        const c = new (T().Vector3)(); windows.push({ o, c });
      }
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m || !('lightsNode' in m) || m.isLineBasicMaterial || m.isPointsMaterial) continue;
        if (m.isMeshBasicMaterial || m.isMeshBasicNodeMaterial || m.lights === false) continue;
        const want = (inside || BTI_RE_test(m.name) || /^MAD_|Madison|Hair/i.test(m.name || '') || o.name === 'FX_MadisonHair') ? intNode : extNode;
        if (m.lightsNode !== want) { m.lightsNode = want; m.needsUpdate = true; n++; }
        if (!m.userData.btl) { m.userData.btl = true; mats.add(m); m.userData.btlSig = texSig(m); }
      }
      if (false) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && /^BTI_Floor/.test(m.name || '') && !m.userData.btCaus && 'emissiveNode' in m) {
        const TS = T().TSL; m.userData.btCaus = true; floorMats.push(m);
        const pc = causMat.mul(TS.vec4(TS.positionWorld, 1.0)), uvp = pc.xy.div(pc.w);   // shadow.matrix already maps to 0..1
        const inside = TS.step(0.0, pc.w).mul(TS.step(0.0, uvp.x)).mul(TS.step(uvp.x, 1.0)).mul(TS.step(0.0, uvp.y)).mul(TS.step(uvp.y, 1.0));
        const cst = TS.texture(causRT.texture, uvp).rgb.mul(TS.vec3(1.0, 0.94, 0.84)).mul(causEmis.mul(inside).mul(0.55));
        m.emissiveNode = (m.emissiveNode || TS.materialEmissive).add(cst); m.needsUpdate = true;
      }
      // (v124) tier-gated: tiers 0/1 (Mali/iPhone) receive the Sun's shadow only on the big surfaces (floors, decks, hull,
      // temple shell, walls/ceilings); props and small meshes skip the shadow lookup. Tier 2+: every mesh.
      if (window.GFX && GFX.shadows) { const nm2 = (o.name || '') + '|' + ((Array.isArray(o.material) ? o.material[0] : o.material) || {}).name;
        o.receiveShadow = tier() >= 2 || /Floor|Deck|deck|Hull|Temple|Wall|Ceiling|Bay|Corr|Stair|Hatch/i.test(nm2); if (o.receiveShadow) BTL.stats.receivers = (BTL.stats.receivers || 0) + 1; }
    });
    BTL.stats.causticMode = causMode; BTL.stats.causticFloors = floorMats.length; BTL.stats.glass = glassMeshes.length; BTL.stats.windows = windows.length;
    return n;
  }
  BTL.apply = function (root, inside) { const n = apply(root, inside); if (root === (typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group)) BTL.ready = true; return n; };

  // ── compile everything this module adds, for both the canvas and the probe target ──
  async function compileProbe() { /* (v139) no probe target any more: the canvas compile covers the glass */ }
  function renderCaustic() {}
  BTL.warm = async function () {
    build(); const r = window.flightRenderer || (typeof flightRenderer !== 'undefined' ? flightRenderer : null); if (!r) return;
    try { renderCaustic(r, 0); } catch (e) { console.warn('[BTL] caustic warm', e); }
    try { const t0 = performance.now(); await compileProbe(r, flightScene); BTL._warmed = Math.round(performance.now() - t0); } catch (e) {}
  };
  // temple (and office) background compile: called by index.html's interior warm-up with decks visible
  BTL.warmTemple = async function (r, scene) { try { const t0 = performance.now(); await compileProbe(r, scene); BTL._warmedT = (BTL._warmedT || 0) + 1; BTL._warmedTms = Math.round(performance.now() - t0); } catch (e) {} };


  BTL.paneSolve = null;   // (v139) removed: baked glass
  function sigMoved(S, i, x, y, z, tol) { return !(Math.abs(S[i] - x) <= tol && Math.abs(S[i + 1] - y) <= tol && Math.abs(S[i + 2] - z) <= tol); }
  function sigStore(S, i, x, y, z) { S[i] = x; S[i + 1] = y; S[i + 2] = z; }
  BTL.cfg.minFill = 1.4;   // (v118) was 0.6: the lamp pools did not read in the bay / below deck
  BTL.cfg.poolR2 = 225;   // reading-light floor: a dark/switched-off room still gets this much from its nearest lamp
  function setFill(F, e, k) { if (e) { F.position.setFromMatrixPosition(e.mw); F.color.copy(e.src.color); const ud = e.src.userData || {}, mf = ud.btMinFill != null ? ud.btMinFill : BTL.cfg.minFill; F.intensity = Math.max(e.on || 0, mf) * k * (ud.btFillK != null ? ud.btFillK : 1); F.distance = Math.max(3, e.src.distance * 1.2); F.updateMatrixWorld(); } else F.intensity = 0; }   // (v139) per-room floor / mode scale (ui/dm-bt-roomlights.js)
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
    if (!g.visible) { for (const L of [fills[0], fills[1], altar, cubeGlow]) L.intensity = 0; if (bounce) bounce.intensity = 0; return; }
    { const nw = performance.now(); if (nw - lastSig > 1000) { lastSig = nw; try { recheck(); } catch (e) {} } }
    g.updateMatrixWorld(); g.getWorldPosition(_a);
    if (reflU) { const gr = BIRD_TEMPLE._glb || g; gr.updateWorldMatrix(true, false); reflU.toLocal.value.copy(gr.matrixWorld).invert(); }   // (v139) baked reflections follow the ship
    const R0 = (BIRD_TEMPLE._R0 || 10);
    const camW = BTL._cw || (BTL._cw = new THREE.Vector3()); camW.setFromMatrixPosition(cam.matrixWorld);
    const camNear = camW.distanceTo(_a) < R0 * 3;
    const aboard = shipAboard();
    const hasA = arielPos(_b);
    const near = camNear || aboard;
    if (near && window.DMBtBake && DMBtBake.on && !DMBtBake.ready) { try { DMBtBake.load(); } catch (e) {} }
    if (near && !REFL.loading && !/[?&]bake=0\b/.test(location.search)) BTL.loadRefl();
    if (!near) {   // far from the ship: nothing below runs (no window loop, no signatures); star shadow back to the game's own updates
      fills[0].intensity = fills[1].intensity = 0;
      try { const L = _charShadowLight; if (L && L.shadow && !L.shadow.autoUpdate) { L.shadow.autoUpdate = true; SIG.star[0] = NaN; } } catch (e) {}
      altar.intensity = 0; cubeGlow.intensity = 0; if (bounce) bounce.intensity = 0; return;
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
    let e0 = null, e1 = null, d0 = BTL.cfg.poolR2, d1 = BTL.cfg.poolR2;
    if (aboard && hasA) {
      try { for (const e of _btHold.used) { if (!e.src) continue; _d.setFromMatrixPosition(e.mw); const d = _d.distanceToSquared(_b);
        if (d < d0) { e1 = e0; d1 = d0; e0 = e; d0 = d; } else if (d < d1) { e1 = e; d1 = d; } } } catch (e) {}
    }
    setFill(fills[0], e0, 1.6); setFill(fills[1], e1, 1.1);
    if (aboard && hasA && !e0) { fills[0].position.copy(_b).addScaledVector(_up(g), 1.6); fills[0].color.setRGB(1, 0.86, 0.68); fills[0].intensity = BTL.cfg.minFill * 1.6; fills[0].distance = 6; fills[0].updateMatrixWorld(); }   // (v118) no lamp nearby: a warm pool over Ariel
    // outside: the altar light and the session cubes' glow
    try { const an = BIRD_TEMPLE._altarNode || (BIRD_TEMPLE._altarNode = (typeof shipNode === 'function' && shipNode(g, 'Altar Group')) || null);
      if (an) { an.updateWorldMatrix(true, false); altar.position.setFromMatrixPosition(an.matrixWorld); altar.position.addScaledVector(_up(g), 0.45); altar.intensity = 6; altar.updateMatrixWorld(); } else altar.intensity = 0; } catch (e) { altar.intensity = 0; }
    try { const cr = (typeof BT_CUBES !== 'undefined') && BT_CUBES.root; if (cr && cr.visible) { cr.updateWorldMatrix(true, false); cubeGlow.position.setFromMatrixPosition(cr.matrixWorld); cubeGlow.intensity = 3; cubeGlow.updateMatrixWorld(); } else cubeGlow.intensity = 0; } catch (e) { cubeGlow.intensity = 0; }
    // 3) (v139) glass: baked — only the inside/outside switch of the reflection set
    if (reflU) reflU.inside.value = aboard ? 1 : 0;
    // (v118) bounce probe: SH from the star direction in the ship frame. L0 = warm diffuse bounce (sun colour × deck albedo),
    // L1 points AWAY from the star (light comes back up off the lit floors / in through the windows' far walls). Tier-scaled.
    if (bounce) { const k = (BTL.volRGB ? [0.3, 0.35, 0.55, 0.7] : [0, 0.35, 0.55, 0.7])[tier()] * (aboard ? 1 : 0);
      const vr = BTL.volRGB, vs = vr ? vr.map(x => x.toFixed(2)).join() : '';   // (v120) baked irradiance volume at Ariel (ui/dm-bt-bake.js)
      if (sigMoved(SIG.bnc, 0, _c.x, _c.y, _c.z, 0.004) || bounce.intensity !== k || vs !== BTL._volSig) { sigStore(SIG.bnc, 0, _c.x, _c.y, _c.z); BTL._volSig = vs;
        const sh = bounce.sh.coefficients, col = [1.0, 0.86, 0.7], dx = -_c.x, dy = -_c.y, dz = -_c.z;
        for (let i = 0; i < 9; i++) sh[i].set(0, 0, 0);
        for (let ch = 0; ch < 3; ch++) { const c = col[ch]; sh[0].setComponent(ch, c * 0.9 + (vr ? vr[ch] * 1.2 / Math.max(k, 0.2) : 0)); sh[1].setComponent(ch, c * 0.5 * dy); sh[2].setComponent(ch, c * 0.5 * dz); sh[3].setComponent(ch, c * 0.5 * dx); }
        bounce.intensity = k; BTL.stats.bounceUpdates = (BTL.stats.bounceUpdates || 0) + 1; } }
  };
  BTL.afterSync = function () {};

  if (window.DMWarm) DMWarm.add('bt-lighting', () => BTL.warm()); else window.addEventListener('load', () => window.DMWarm && DMWarm.add('bt-lighting', () => BTL.warm()));
  BTL.build = build;
  // (v118) Layer-3 hook only: a future 'Path Traced' GI tier (?gi=pt or BTL.setGiTier('pt')). Not implemented — it records the
  // request and falls back to the hybrid path (cached star shadow + light pool + bounce probe + glass). Baked lightmaps = PR B.
  BTL.giTier = (location.search.match(/[?&]gi=(pt|hybrid)\b/) || [])[1] || 'hybrid';
  BTL.setGiTier = function (t) { BTL.giTier = t === 'pt' ? 'pt' : 'hybrid'; BTL.stats.giTierActive = 'hybrid'; return BTL.stats.giTierActive; };
})();
