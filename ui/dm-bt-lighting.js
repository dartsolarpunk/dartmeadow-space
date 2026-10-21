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
    caus = new THREE.SpotLight(0xfff0d6, 0, 16, 0.7, 0.35, 1.2); caus.name = 'BT_Caustic'; caus.castShadow = false; mk(caus, 'BT_Caustic');
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
    readRT = writeRT = probeRT;
    [key, caus, probe].forEach(o => { o.matrixAutoUpdate = true; });
    BTL.stats = { shadowedLights: 1, poolLights: 6, probeRes: tr[1], probeFaceEvery: tr[2], causticHz: tr[3] };
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
    ext.push(altar, cubeGlow); int.push(caus, fills[0], fills[1]); if (bounce) int.push(bounce);
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
  let probeReady = null, glassT = null, probeU = null;
  function mkProbeU() { const THREE = T(), TS = THREE.TSL; probeU = { toLocal: TS.uniform(new THREE.Matrix4()), toWorld: TS.uniform(new THREE.Matrix4()), bmin: TS.uniform(new THREE.Vector3(-1, -1, -1)), bmax: TS.uniform(new THREE.Vector3(1, 1, 1)), pos: TS.uniform(new THREE.Vector3()), boxOn: TS.uniform(0) }; }
  // room boxes (temple-local) from the deck floors: floor bbox, raised to the ceiling; a window takes the room it borders
  let roomBoxes = null;
  function roomFor(g, cLocal) {
    const THREE = T();
    if (!roomBoxes) { roomBoxes = []; g.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), M = new THREE.Matrix4();
      g.traverse(o => { const m = o.isMesh && (Array.isArray(o.material) ? o.material[0] : o.material); if (!m || !/^BTI_Floor/.test(m.name || '') || !o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(M.multiplyMatrices(inv, o.matrixWorld));
        if (b.max.y - b.min.y < 2) b.max.y = b.min.y + 10.2; roomBoxes.push(b); }); }
    let best = null, bd = 1e9;
    for (const b of roomBoxes) { const dx = Math.max(b.min.x - cLocal.x, 0, cLocal.x - b.max.x), dz = Math.max(b.min.z - cLocal.z, 0, cLocal.z - b.max.z), dy = Math.max(b.min.y - cLocal.y, 0, cLocal.y - b.max.y), d = dx + dz + dy * 2; if (d < bd) { bd = d; best = b; } }
    if (best && bd < 6) return best;
    return new THREE.Box3().setFromCenterAndSize(cLocal, new THREE.Vector3(24, 11, 24));
  }
  function glassMaterial(src, warm) {
    const THREE = T(), TS = THREE.TSL;
    if (!probeReady) { probeReady = TS.uniform(0); glassT = TS.uniform(0); mkProbeU(); }
    const m = new THREE.MeshStandardNodeMaterial(); m.name = src.name || 'BT_Glass';
    m.roughness = 0.04; m.metalness = 0.0; m.color = new THREE.Color(0, 0, 0); m.side = src.side;
    m.transparent = true; m.depthWrite = false; m.userData.btGlass = true;
    const useRefr = tier() >= 2 &&   // (v118) not on tier 0/1 (Mali): no per-frame opaque-pass copy there
       typeof TS.viewportSharedTexture === 'function' && !/[?&]glassrefr=0\b/.test(location.search);
    const V = TS.positionWorld.sub(TS.cameraPosition).normalize(), N = TS.normalWorld;
    const cosT = TS.clamp(N.dot(V.negate()).abs(), 0.0, 1.0);
    const F = TS.float(0.04).add(TS.float(0.96).mul(TS.pow(TS.float(1).sub(cosT), 5.0)));
    // (v121) box-projected, parallax-corrected reflection: the reflected ray is intersected with the room's box (temple-local)
    // and the cube is looked up from the probe's position toward that hit, so the room reflects at its true scale and place
    const R = TS.reflect(V, N), Pl = probeU.toLocal.mul(TS.vec4(TS.positionWorld, 1.0)).xyz, Rl = probeU.toLocal.mul(TS.vec4(R, 0.0)).xyz.normalize();
    const Rs = Rl.add(TS.vec3(1e-5)), t1 = probeU.bmax.sub(Pl).div(Rs), t2 = probeU.bmin.sub(Pl).div(Rs), tf = TS.max(t1, t2);
    const dh = TS.min(TS.min(tf.x, tf.y), tf.z), hit = Pl.add(Rl.mul(dh)), dW = probeU.toWorld.mul(TS.vec4(hit.sub(probeU.pos), 0.0)).xyz.normalize();
    const Rb = TS.mix(R, dW, probeU.boxOn);
    const cn = TS.cubeTexture(readRT.texture, Rb); cubeNodes.push(cn);
    const cpl = TS.uniform(new THREE.Color(0, 0, 0)); m.userData.cpl = cpl;   // (v124) Σ_j T_ij·L_j from the pane solve (CPU)
    const refl = cn.rgb.mul(probeReady);
    const pw = TS.positionLocal.mul(0.9);   // (v121) glint pattern in model units (world units are ship-scaled: the pattern was mis-sized)
    const g1 = TS.sin(pw.x.add(glassT.mul(0.8)).add(TS.sin(pw.y.mul(1.3).add(glassT.mul(0.6))))).mul(TS.sin(pw.z.mul(1.1).sub(glassT.mul(0.7)).add(TS.cos(pw.x.mul(0.9)))));
    const caus = TS.pow(TS.float(1).sub(TS.abs(g1)), 14.0).mul(0.07);
    const tint = TS.vec3(warm[0], warm[1], warm[2]).mul(0.3);
    // both paths alpha-blend over what is already drawn (Fresnel opacity ≈8% head-on): in refraction mode a stale or empty
    // viewport copy can only tint the pane, never make it solid. The copy only happens while a pane is actually drawn.
    const alpha = TS.clamp(F.mul(0.85).add(0.08), 0.0, 0.92);
    m.opacityNode = useRefr ? TS.clamp(alpha.add(0.25), 0.0, 0.92) : alpha;
    if (useRefr) {
      const behind = TS.viewportSharedTexture(TS.screenUV.add(TS.normalView.xy.mul(0.02))).rgb.mul(TS.vec3(0.94, 0.98, 1.0));
      m.emissiveNode = TS.mix(behind, refl, F).add(caus).add(tint).add(cpl);
      m.userData.btRefr = true;
    } else {
      m.emissiveNode = refl.mul(F).div(TS.max(alpha, 0.05)).add(caus).add(tint).add(cpl.div(TS.max(alpha, 0.05)));
    }
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
    if (!root || !probeRT) return 0;
    if (!extNode || stale()) nodes();
    let n = 0;
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      // (v121) the per-mesh list used to be called `mats` too, shadowing the module Set: `mats.add` threw on the first lit material and aborted the whole temple apply (light lists, receiveShadow) since v117
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
        if (!m.userData.btl) { m.userData.btl = true; mats.add(m); m.userData.btlSig = texSig(m); }
      }
      if (causMode === 'emissive') for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && /^BTI_Floor/.test(m.name || '') && !m.userData.btCaus && 'emissiveNode' in m) {
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


  // ── (v124) window-to-window light: one joint solve over all panes (replaces the ping-pong probe) ──
  // Panes i = the glass meshes (temple-local centre c_i, unit normal n_i, area A_i, transmittance τ_i). Precomputed once
  // (when the collision soup exists), in the temple frame so it moves with the ship:
  //   T_ij = V_ij · F(cosθ_i) · (cosθ_i · cosθ_j · A_j) / (π r_ij² + A_j)        (i ≠ j, both faces: |n·d|)
  //   V_ij = fraction of 5 rays (centre + 4 inset corners of j) from c_i that reach pane j without hitting the temple soup
  //   F(c) = 0.04 + 0.96 (1 − c)^5  (Schlick, n≈1.5), the share of j's light that i reflects toward the viewer; the τ_j share
  //   that j transmits is already in L_j.  Sparse: the 8 largest T_ij per row above 1e-4.
  // Per solve (tier 1: every 8 frames, 1 Jacobi step; tier 2+: every 2 frames, 3 steps; tier 0: off):
  //   E_i = F̄ · room_i + τ_i · sky_i     room_i = baked irradiance volume at c_i (or the reading-light level),
  //                                       sky_i  = space radiance + the Sun's lobe when n_i faces it (transmitted sky)
  //   L ← E + T·L   (Jacobi, from the previous frame's L, so 2–3 steps converge; ‖T‖∞ < 1 by construction)
  //   each pane's shader gets cpl_i = Σ_j T_ij · L_j (RGB), added to its emissive: every pane sends and receives in the
  //   same solve, no frame lag between panes.
  const PS = { panes: null, T: null, L: null, E: null, tmp: null, frame: 0 };
  BTL.paneSolve = PS;
  // (v126) built incrementally: a generator stepped ≤ 2 ms per frame (paneStep), one pane / one row of T per step
  function* paneBuildGen(g) {
    const THREE = T(), DI = window.DMBtInterior; if (!DI || !DI.rayHit || DI.rayHit(0, 0, 0, 1, 0, 0, 1) === -2) return false;
    yield 0;
    g.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), M = new THREE.Matrix4(), n3 = new THREE.Matrix3();
    const P = [];
    for (const o of glassMeshes) {
      const geo = o.geometry, pos = geo && geo.attributes.position; if (!pos) continue;
      M.multiplyMatrices(inv, o.matrixWorld); n3.getNormalMatrix(M);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cr = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(); let A = 0;
      const idx = geo.index, nt = idx ? idx.count / 3 : pos.count / 3, bb = new THREE.Box3();
      for (let t = 0; t < nt; t++) { const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(M); b.fromBufferAttribute(pos, i1).applyMatrix4(M); c.fromBufferAttribute(pos, i2).applyMatrix4(M);
        cr.subVectors(b, a).cross(c.clone().sub(a)); const ar = cr.length() * 0.5; if (!(ar > 0)) continue;
        if (N.dot(cr) < 0) cr.negate(); N.add(cr); A += ar; C.addScaledVector(a.add(b).add(c), ar / 3); bb.expandByPoint(a); bb.expandByPoint(b); bb.expandByPoint(c); }
      if (!(A > 0)) continue; C.divideScalar(A); N.normalize();
      P.push({ o, m: o.material, c: C, n: N, A, bb, tau: 0.92, sunVis: 1 });
      yield 0;
    }
    const n = P.length; if (!n) return false;
    const rows = [];
    for (let i = 0; i < n; i++) { const pi = P[i], row = [];
      for (let j = 0; j < n; j++) { if (i === j) continue; const pj = P[j];
        const d = pj.c.clone().sub(pi.c), r2 = d.lengthSq(); if (r2 < 1e-6) continue; d.normalize();
        const ci = Math.abs(pi.n.dot(d)), cj = Math.abs(pj.n.dot(d)); if (ci < 0.02 || cj < 0.02) continue;
        const ff = ci * cj * pj.A / (Math.PI * r2 + pj.A), F = 0.04 + 0.96 * Math.pow(1 - ci, 5); let t = F * ff; if (t < 1e-4) continue;
        // visibility: centre + 4 corners (inset 20%) of pane j's box
        const s = pj.bb, k = 0.2, pts = [pj.c, new (T().Vector3)(s.min.x + (s.max.x - s.min.x) * k, s.min.y + (s.max.y - s.min.y) * k, s.min.z + (s.max.z - s.min.z) * k), new (T().Vector3)(s.max.x - (s.max.x - s.min.x) * k, s.max.y - (s.max.y - s.min.y) * k, s.max.z - (s.max.z - s.min.z) * k), new (T().Vector3)(s.min.x + (s.max.x - s.min.x) * k, s.max.y - (s.max.y - s.min.y) * k, s.min.z + (s.max.z - s.min.z) * k), new (T().Vector3)(s.max.x - (s.max.x - s.min.x) * k, s.min.y + (s.max.y - s.min.y) * k, s.max.z - (s.max.z - s.min.z) * k)];
        let vis = 0; for (const q of pts) { const e = q.clone().sub(pi.c), L = e.length(); if (L < 1e-4) { vis++; continue; } e.divideScalar(L);
          const o0 = pi.c.clone().addScaledVector(e, 0.08), h = DI.rayHit(o0.x, o0.y, o0.z, e.x, e.y, e.z, L - 0.16); if (h < 0) vis++; }
        t *= vis / pts.length; if (t >= 1e-4) row.push([j, t]); }
      row.sort((x, y) => y[1] - x[1]); row.length = Math.min(row.length, 8);
      const sum = row.reduce((s2, x) => s2 + x[1], 0); if (sum > 0.9) for (const x of row) x[1] *= 0.9 / sum;   // keep ‖T‖∞ < 1
      rows.push(row); yield 0; }
    PS.panes = P; PS.T = rows; PS.L = new Float32Array(n * 3); PS.E = new Float32Array(n * 3); PS.tmp = new Float32Array(n * 3);
    BTL.stats.panes = n; BTL.stats.paneLinks = rows.reduce((s2, r) => s2 + r.length, 0);
    return true;
  }
  let paneJob = null;
  function paneStep(g) {   // true once built
    if (PS.panes) return true;
    if (!paneJob) paneJob = paneBuildGen(g);
    const t0 = performance.now();
    try { while (performance.now() - t0 < 2) { const r = paneJob.next(); if (r.done) { paneJob = null; return !!r.value; } } }
    catch (e) { paneJob = null; BTL.stats.paneErr = String(e && e.message || e).slice(0, 120); }
    return false;
  }
  // (v126) the Sun lobe is occlusion-tested per pane: one ray from the pane toward the Sun against the temple soup, cached
  // and refreshed (8 panes per solve) only when the Sun direction in the ship frame moves
  const sunSig = { x: NaN, y: NaN, z: NaN }; let sunNext = 0;
  function paneSunVis(sunLocal) {
    const P = PS.panes, DI = window.DMBtInterior; if (!P || !DI || !DI.rayHit) return;
    if (!(Math.abs(sunSig.x - sunLocal.x) < 0.01 && Math.abs(sunSig.y - sunLocal.y) < 0.01 && Math.abs(sunSig.z - sunLocal.z) < 0.01)) { sunSig.x = sunLocal.x; sunSig.y = sunLocal.y; sunSig.z = sunLocal.z; sunNext = 0; }
    for (let k = 0; k < 8 && sunNext < P.length; k++, sunNext++) { const p = P[sunNext], sd = p.n.dot(sunLocal) >= 0 ? 1 : -1;
      const ox = p.c.x + p.n.x * 0.08 * sd, oy = p.c.y + p.n.y * 0.08 * sd, oz = p.c.z + p.n.z * 0.08 * sd;   // just off the sun-facing side
      const h = DI.rayHit(ox, oy, oz, sunLocal.x, sunLocal.y, sunLocal.z, 400); p.sunVis = h < 0 ? 1 : 0; }
  }
  const _pv = [0, 0, 0];
  function paneSolve(g, sunLocal, hasSun) {
    const tr = tier(); if (tr === 0) return;
    const every = tr === 1 ? 8 : 2, iters = tr === 1 ? 1 : 3; if (++PS.frame % every) return;
    if (!PS.panes) { paneStep(g); return; }
    paneSunVis(sunLocal);
    const P = PS.panes, n = P.length, E = PS.E, L = PS.L, X = PS.tmp, B = window.DMBtBake, w = BTL._pw || (BTL._pw = new (T().Vector3)());
    const sky = [0.012, 0.014, 0.022];   // space radiance (galaxy/stars) seen through a pane
    for (let i = 0; i < n; i++) { const p = P[i];
      let rr = 0.25, rg = 0.22, rb = 0.2;   // room level without the bake (reading light)
      if (B && B.applied && B.sampleVol) { w.copy(p.c).applyMatrix4(g.matrixWorld); if (B.sampleVol(w, _pv)) { rr = _pv[0]; rg = _pv[1]; rb = _pv[2]; } }
      const sunT = hasSun && p.sunVis ? Math.pow(Math.max(0, Math.abs(p.n.dot(sunLocal))), 8) * 0.6 : 0;
      E[i * 3] = 0.1 * rr + p.tau * (sky[0] + sunT); E[i * 3 + 1] = 0.1 * rg + p.tau * (sky[1] + sunT * 0.95); E[i * 3 + 2] = 0.1 * rb + p.tau * (sky[2] + sunT * 0.85); }
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) { let r = E[i * 3], gg = E[i * 3 + 1], b = E[i * 3 + 2]; for (const [j, t] of PS.T[i]) { r += t * L[j * 3]; gg += t * L[j * 3 + 1]; b += t * L[j * 3 + 2]; } X[i * 3] = r; X[i * 3 + 1] = gg; X[i * 3 + 2] = b; }
      L.set(X); }
    for (let i = 0; i < n; i++) { let r = 0, gg = 0, b = 0; for (const [j, t] of PS.T[i]) { r += t * L[j * 3]; gg += t * L[j * 3 + 1]; b += t * L[j * 3 + 2]; }
      const u = P[i].m && P[i].m.userData.cpl; if (u) u.value.setRGB(r, gg, b); }
    BTL.stats.paneSolves = (BTL.stats.paneSolves || 0) + 1;
  }

  // ── per frame (called right before the main render) ──
  const V = () => T().Vector3;
  let _a, _b, _c, _d, _q, _m4 = null;
  const SIG = { star: new Float64Array(9).fill(NaN), sun: new Float64Array(3).fill(NaN), bnc: new Float64Array(3).fill(NaN) };
  function sigMoved(S, i, x, y, z, tol) { return !(Math.abs(S[i] - x) <= tol && Math.abs(S[i + 1] - y) <= tol && Math.abs(S[i + 2] - z) <= tol); }
  function sigStore(S, i, x, y, z) { S[i] = x; S[i + 1] = y; S[i + 2] = z; }
  BTL.cfg.minFill = 1.4;   // (v118) was 0.6: the lamp pools did not read in the bay / below deck
  BTL.cfg.poolR2 = 225;   // reading-light floor: a dark/switched-off room still gets this much from its nearest lamp
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
    if (!g.visible) { for (const L of [fills[0], fills[1], altar, cubeGlow, caus]) L.intensity = 0; if (bounce) bounce.intensity = 0; return; }
    { const nw = performance.now(); if (nw - lastSig > 1000) { lastSig = nw; try { recheck(); } catch (e) {} } }
    g.updateMatrixWorld(); g.getWorldPosition(_a);
    if (probeU) { probeU.toWorld.value.copy(g.matrixWorld); probeU.toLocal.value.copy(g.matrixWorld).invert(); }   // (v121) box projection follows the ship
    const R0 = (BIRD_TEMPLE._R0 || 10);
    const camW = BTL._cw || (BTL._cw = new THREE.Vector3()); camW.setFromMatrixPosition(cam.matrixWorld);
    const camNear = camW.distanceTo(_a) < R0 * 3;
    const aboard = shipAboard();
    const hasA = arielPos(_b);
    const near = camNear || aboard;
    if (near && window.DMBtBake && DMBtBake.on && !DMBtBake.ready) { try { DMBtBake.load(); } catch (e) {} }   // (v124) lazy bake fetch on approach
    if (!near) {   // far from the ship: nothing below runs (no window loop, no signatures); star shadow back to the game's own updates
      fills[0].intensity = fills[1].intensity = caus.intensity = 0;
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
    // 3) window centres (ship-relative, so refreshed only while near), nearest to Ariel (caustic) and to the camera (probe)
    const ref = hasA && aboard ? _b : camW; let w = null, wd = 1e9, wc = null, cd = 1e9;
    for (const it of windows) { it.o.getWorldPosition(it.c); const d = it.c.distanceToSquared(ref); if (d < wd) { wd = d; w = it; } const dc = it.c.distanceToSquared(camW); if (dc < cd) { cd = dc; wc = it; } }
    const tr = TIERS[tier()];
    if (aboard && w && wd < 400) {
      caus.position.copy(w.c).addScaledVector(_c, -1.2); caus.target.position.copy(w.c).addScaledVector(_c, 4);
      caus.updateMatrixWorld(); caus.target.updateMatrixWorld();
      if (causMode === 'light') caus.intensity = 14; else { caus.intensity = 0; causEmis.value = 1; caus.shadow.updateMatrices(caus); causMat.value.copy(caus.shadow.matrix); }
      const now = performance.now();
      if (now - lastCaus > 1000 / tr[3]) { lastCaus = now; try { renderCaustic(r, now / 1000); } catch (e) {} }
    } else { caus.intensity = 0; if (causEmis) causEmis.value = 0; }
    // 4) glass probe: ON DEMAND. All 6 faces are marked dirty when the probe changes window or the star direction moves;
    //    a slow refresh re-marks them every few seconds (the world drifts). At most one face per `every` frames.
    if (glassT) glassT.value = performance.now() / 1000;
    const _arNear = aboard || (hasA && _b.distanceTo(_a) < R0 * 3);   // (v126) only with Ariel aboard or near the temple
    try { if (windows.length && _arNear) { const sl = BTL._sl || (BTL._sl = new THREE.Vector3()); sl.copy(_c).negate().transformDirection(_m4.copy(g.matrixWorld).invert()); paneSolve(g, sl, true); } } catch (e) { BTL.stats.paneErr = String(e && e.message || e).slice(0, 120); }
    // (v118) bounce probe: SH from the star direction in the ship frame. L0 = warm diffuse bounce (sun colour × deck albedo),
    // L1 points AWAY from the star (light comes back up off the lit floors / in through the windows' far walls). Tier-scaled.
    if (bounce) { const k = (BTL.volRGB ? [0.3, 0.35, 0.55, 0.7] : [0, 0.35, 0.55, 0.7])[tier()] * (aboard ? 1 : 0);
      const vr = BTL.volRGB, vs = vr ? vr.map(x => x.toFixed(2)).join() : '';   // (v120) baked irradiance volume at Ariel (ui/dm-bt-bake.js)
      if (sigMoved(SIG.bnc, 0, _c.x, _c.y, _c.z, 0.004) || bounce.intensity !== k || vs !== BTL._volSig) { sigStore(SIG.bnc, 0, _c.x, _c.y, _c.z); BTL._volSig = vs;
        const sh = bounce.sh.coefficients, col = [1.0, 0.86, 0.7], dx = -_c.x, dy = -_c.y, dz = -_c.z;
        for (let i = 0; i < 9; i++) sh[i].set(0, 0, 0);
        for (let ch = 0; ch < 3; ch++) { const c = col[ch]; sh[0].setComponent(ch, c * 0.9 + (vr ? vr[ch] * 1.2 / Math.max(k, 0.2) : 0)); sh[1].setComponent(ch, c * 0.5 * dy); sh[2].setComponent(ch, c * 0.5 * dz); sh[3].setComponent(ch, c * 0.5 * dx); }
        bounce.intensity = k; BTL.stats.bounceUpdates = (BTL.stats.bounceUpdates || 0) + 1; } }
    const _sealed = !!(window.DMBtInterior && DMBtInterior.sealed);   // (v116) no glass in view: faces stay dirty and are rendered once glass is back in view
    if (camNear && wc && probe && !_sealed) {
      if (wc !== probeAt || sigMoved(SIG.sun, 0, _c.x, _c.y, _c.z, 0.002)) { probeAt = wc; sigStore(SIG.sun, 0, _c.x, _c.y, _c.z); dirty = 63; }
      const now = performance.now(); const oa = (window.DMBtInterior && DMBtInterior.openArea) || 0; if (!dirty && now - lastFull > PROBE_REFRESH_MS * (oa > 0.15 ? 1 : 2)) dirty = 63;
      if (dirty && frame - lastFaceFrame >= Math.max(2, tr[2] + 1)) {
        while (!(dirty & (1 << face))) face = (face + 1) % 6;
        if (face === 0 || dirty === 63) {
          if (probeU) { const inv = probeU.toLocal.value.copy(g.matrixWorld).invert(); probeU.toWorld.value.copy(g.matrixWorld);
            if (!wc.box) { const cl = wc.c.clone().applyMatrix4(inv); wc.box = roomFor(g, cl); }
            const b = wc.box, ctr = b.getCenter(new (T().Vector3)()); probeU.bmin.value.copy(b.min); probeU.bmax.value.copy(b.max); probeU.pos.value.copy(ctr); probeU.boxOn.value = 1;
            probe.position.copy(ctr).applyMatrix4(g.matrixWorld); }   // (v121) the probe sits at the room's centre, its box is the room
          else probe.position.copy(wc.c);
          probe.updateMatrixWorld(true); }
        if (!casters) { casters = []; scene.traverse(o => { if (o.isLight && o.shadow && o.castShadow !== undefined) casters.push(o); }); }   // cached: the scene's light set is fixed
        for (let i = 0; i < casters.length; i++) { const o = casters[i]; holdA[i] = o.shadow.autoUpdate; holdN[i] = o.shadow.needsUpdate; o.shadow.autoUpdate = false; o.shadow.needsUpdate = false; }
        for (const m of glassMeshes) m.visible = false;
        const prev = r.getRenderTarget(), pac = r.autoClear, tp = performance.now();
        try { r.setRenderTarget(writeRT, face); r.autoClear = true; r.render(scene, probe.children[face]); BTL.stats.probeMs = Math.round(performance.now() - tp); }
        catch (e) {}
        finally { r.setRenderTarget(prev); r.autoClear = pac; for (const m of glassMeshes) m.visible = true; for (let i = 0; i < casters.length; i++) { casters[i].shadow.autoUpdate = holdA[i]; casters[i].shadow.needsUpdate = holdN[i]; } }
        dirty &= ~(1 << face); if (!dirty) { lastFull = now; if (probeReady) probeReady.value = 1; } lastFaceFrame = frame; face = (face + 1) % 6; BTL.stats.probeFaces = (BTL.stats.probeFaces || 0) + 1;
      }
    }
  };
  BTL.afterSync = function () {};

  if (window.DMWarm) DMWarm.add('bt-lighting', () => BTL.warm()); else window.addEventListener('load', () => window.DMWarm && DMWarm.add('bt-lighting', () => BTL.warm()));
  BTL.build = build;
  // (v118) Layer-3 hook only: a future 'Path Traced' GI tier (?gi=pt or BTL.setGiTier('pt')). Not implemented — it records the
  // request and falls back to the hybrid path (cached star shadow + light pool + bounce probe + glass). Baked lightmaps = PR B.
  BTL.giTier = (location.search.match(/[?&]gi=(pt|hybrid)\b/) || [])[1] || 'hybrid';
  BTL.setGiTier = function (t) { BTL.giTier = t === 'pt' ? 'pt' : 'hybrid'; BTL.stats.giTierActive = 'hybrid'; return BTL.stats.giTierActive; };
})();
