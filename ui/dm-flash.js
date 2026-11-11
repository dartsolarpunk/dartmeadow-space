/* dm-flash.js — Ariel's AR-glasses flashlight (t1472).
   GEOMETRY  a very narrow LED bar on the TOP RIM of her glasses (black casing, white LED strip), a runtime THREE mesh parented to the glasses' bone
             (the glasses frame 'Mesh 1' of characterassests/Meshy_AI_Autumn_biped_Character_output.glb is skinned 100 % to 'Head'). No GLB edit.
             Proportions are read from the frame's own bind-pose vertices once at attach (front face, top of the rim over the bridge, frame width, rim
             band height); the bar is ~1/3 of the frame width (the marked white line in the reference), ~1/8 of the rim band tall. Fallback: the
             measured r-values below (GLB metres: frame 0.153 wide, top rim y 1.6689, front z -0.0133, rim band 0.027).
             Never a collider: not registered with DMCollide, raycast disabled, userData.noCollide.
   LIGHT     one SHADOW-CASTING SpotLight per scene she can be in (flightScene, each world scene), along the glasses' forward axis, its target ahead of her.
             Created by adoptScene BEFORE the first compile of that scene and kept with intensity 0 while off (adding / removing a light changes every lit
             material's light hash and recompiles them: never on a tap). Real lighting: every lit material (terrain, mansion, props, character, board, foliage)
             receives it through three's own light loop; materials that carry a private light list (the mansion atlas, the Bird Temple hull / interior) get it
             through one small hook each (DMFlash.sceneLight(scene)). Real-time SHADOWS: ONE modest shadow map (tier: 512 / 1024 / 2048), PCF soft, the map is
             only rendered while the light is ON (shadow.autoUpdate = false, needsUpdate set by tick() on its cadence) and the shader samples it only inside a
             uniform branch (zero ALU/texture cost while off). Cadence + size + reach follow the tier (phones: half rate, 100 m of casters), DMBudget and the
             measured frame time (auto-degrades to a cone without shadows if the frame stays > ~70 ms). ?flashshadow=0 never creates a shadow at all.
             The sun-visibility wrapper of DMLight (receivedShadowNode) is NOT applied to this light's shadow (tagged dmFlashShadow).
   BEAM      the visible light shaft: ONE additive back-face cone mesh per scene (made on first switch-on, hidden while off) whose shader marches 6-14 samples
             through the cone analytically (position / axis / angle / penumbra / length uniforms), clamped by the scene depth, weighted by an air-density
             term (fog-aware, near zero in vacuum) with a forward-scatter phase and dust noise on the desktop tier. Not shadowed by objects inside the cone
             (approximation). It YIELDS to DMVLight (ui/dm-vlight.js, which scatters the flashlight in scene.fogNode) while that is installed on a fogged
             scene on foot / in the air, so the shaft is never counted twice; it is the beam in open space and in fog-less scenes. ?flashbeam=0 off,
             ?flashbeam=<n> forces it on at gain n (on top of DMVLight), ?flashbeam=auto default.
   CONE      long-press the button (or the small cone key in the brightness bar) cycles wide 35 deg / medium 23 deg / spot 12 deg half-angle (uniform changes only).
   FLAGS     ?flashlight=0 (feature off) ?flashshadow=0|512|1024|2048 ?flashbeam=auto|0|k ?flashtier=low|phone|desktop ?flashbias=-0.0004.  Session only: no save keys.
   INTERFACE DMFlash.cone() -> {on, pos, dir, angle, cosOuter, cosInner, range, intensity, lumens, shadow{on,map,matrix,near,far,bias,size,every}, mode} (preallocated, valid
             after tick), DMFlash.U (TSL uniform nodes of the beam, null until built), DMFlash.medium {mul, add} (density hooks for the fog / mist / atmosphere passes),
             DMFlash.sceneLight(scene), DMFlash.hooks {gfx, depthOK, logDepth}.
   UI        a custom flashlight icon button (SVG, no text) docked to the RIGHT of the LEFT thumbstick of the current HUD (space #jL, sky
             #atmo-steer-zone, ground #surf-move-zone), bottom-aligned with it, never over it (the stick keeps every touch it had). Tap toggles; while on,
             a vertical stepped lumen bar (5 segments, 4000 top) opens beside the button; tap a segment to pick it. Flat DOM, placed only when the HUD
             changes or the window resizes (no per-frame layout).
   API       DMFlash.attach(CHAR) · DMFlash.tick(mode) (per frame, no allocation) · toggle(on?) · setStep(i) · setCone(i) · lumens() · status() · STEPS */
(function (root) {
  'use strict';
  if (root.DMFlash) return;
  const STEPS = [750, 1250, 2000, 3000, 4000];
  const LM_K = 0.35, COLOR = 0xfff4e6;
  // beam profiles (set on the light only when the mode's profile / cone changes: angle / distance / decay / intensity are uniforms, never a recompile).
  // ground = on foot + board in the sky (metre scale): a wide 35 deg half-angle cone with a soft penumbra that carries 260 m (surface light; the visible shaft and
  // the shadow map are shorter, see TIERS).  space = open space / near a world (1 unit ~ 4 m, planets tens of units away, she is tiny): a far longer reach
  // and a flatter fall-off so a passing planet or ship is lit.  shNear / shFar = the shadow camera's depth range for that mode (shFar is capped by the tier).
  const PROF = { ground: { angle: 0.61, penumbra: 0.8, distance: 260, decay: 1.5, gain: 1, shNear: 0.25, shFar: 1e9 }, space: { angle: 0.5, penumbra: 0.7, distance: 1500, decay: 1.15, gain: 0.6, shNear: 0.6, shFar: 140 } };
  // cone presets: factor on the profile's half-angle (wide 35 deg / medium 23 deg / spot 12 deg) and the intensity compensation (a narrower cone concentrates the same lumens)
  const CONES = [{ name: 'wide', k: 1, gain: 1 }, { name: 'medium', k: 0.66, gain: 1.35 }, { name: 'spot', k: 0.34, gain: 2.1 }];
  // quality tiers.  map = shadow map side, every = shadow refresh cadence (frames), far = shadow reach (m; casters beyond are never drawn into the map), steps = beam samples,
  // noise = dust texture in the beam (phones never pay for it).  low = the Low graphics preset / weak GPU, phone = handhelds, desktop = the rest.
  const TIERS = { low: { map: 512, every: 2, far: 60, steps: 6, noise: false }, phone: { map: 1024, every: 2, far: 100, steps: 8, noise: false }, desktop: { map: 2048, every: 1, far: 180, steps: 14, noise: true } };
  const R = { width: 0.153, top: 1.6689, front: -0.0133, band: 0.027 };   // GLB-measured fallback (metres, bind pose)
  const S = { on: false, step: 2, cone: 0, built: false, led: null, casing: null, strip: null, light: null, target: null, dims: null, mode: '', rc: 0, tries: 0, placed: false, prof: 'ground', pairs: [], ui: null, dirty: true, wait: 0, err: null,
    flags: null, tier: null, tierName: '', mapSize: 2048, shadowOn: false, shFrame: 0, shEvery: 1, shNear: 0.25, shFar: 180, bias: -0.0004, normalBias: 0.06, fresh: 0, shUpdates: 0,
    t: 0, dtEma: 16, slow: 0, fast: 0, autoOff: 0, retry: 0, beamOn: false, dens: 0.01, beamK: 1, wasOn: false, shadowUser: true, pair: null, U: null, beam: undefined };
  const F = { STEPS, S, R, LM_K, PROF, CONES, TIERS };
  root.DMFlash = F;
  let T = null; const _p = { x: 0, y: 0, z: 0 }; let _v = null, _d = null, _q = null, _z = null;
  F.hooks = { gfx: null, depthOK: null, logDepth: null };   // set by index.html: gfx() -> GFX, depthOK() -> may a shader read the scene depth, logDepth() -> logarithmic depth buffer
  F.medium = { mul: 1, add: 0 };                              // density hooks for the fog / mist / atmosphere passes: dens = base * mul + add (per metre)
  F.lumens = () => STEPS[S.step];
  F.intensityFor = lm => lm * LM_K;

  // ── flags + tiers (pure)
  F.readFlags = function (search) {
    const q = k => { const m = String(search || '').match(new RegExp('[?&]' + k + '=([^&#]*)')); return m ? decodeURIComponent(m[1]) : null; };
    const num = (v, d) => { const x = parseFloat(v); return isFinite(x) ? x : d; };
    const fs = q('flashshadow'), size = fs !== null && /^\d+$/.test(fs) && +fs > 1 ? Math.max(256, Math.min(4096, +fs | 0)) : 0;
    const fb = q('flashbeam');
    return { light: q('flashlight') !== '0', shadow: fs !== '0' && fs !== 'off', size, beam: fb === '0' || fb === 'off' ? 0 : (fb === null || fb === 'auto' ? 1 : Math.max(0, Math.min(8, num(fb, 1)))), beamForce: fb !== null && fb !== 'auto' && fb !== '0' && fb !== 'off',
      tier: /^(low|phone|desktop)$/.test(q('flashtier') || '') ? q('flashtier') : '', bias: q('flashbias') !== null ? num(q('flashbias'), -0.0004) : -0.0004 };
  };
  F.pickTier = function (gfx, ua, over) {   // gfx = the game's GFX (may be null), ua = navigator.userAgent, over = ?flashtier
    if (over && TIERS[over]) return over;
    if (gfx && (gfx.preset === 'low' || (gfx.shadowSize && gfx.shadowSize <= 512))) return 'low';
    if (gfx && gfx.isMobile) return 'phone';
    if (gfx && gfx.isMobile === false) return 'desktop';
    return /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua || '') ? 'phone' : 'desktop';
  };
  F.refreshTier = function () {   // flags + tier from the page and the game's GFX; cheap, called at adopt / attach (not per frame)
    let gfx = null; try { gfx = F.hooks.gfx ? F.hooks.gfx() : null; } catch (e) { gfx = null; }
    S.flags = F.readFlags(root.location && root.location.search || '');
    S.tierName = F.pickTier(gfx, root.navigator && root.navigator.userAgent || '', S.flags.tier); S.tier = TIERS[S.tierName];
    let sz = S.flags.size || S.tier.map; if (!S.flags.size && gfx && gfx.shadowSize) sz = Math.min(sz, Math.max(512, gfx.shadowSize));
    S.mapSize = sz; S.shFar = S.tier.far; S.bias = S.flags.bias; S.shEvery = S.tier.every;
    return S.tierName;
  };
  F.refreshTier();

  // ── cone / beam maths (pure; the TSL beam shader mirrors coneInterval one to one)
  // The ray ro + t rd (|rd| = 1) against the solid single-nappe cone: apex A, unit axis a, cos(half-angle) cosO, length L. Returns [lo, hi] (t range inside, clamped to
  // [0, tMax]) or null.  Same branch structure as the shader: two planes (s = 0, s = L) and the quadratic of the cone surface; the nappe is picked by the sign of rd.a.
  F.coneInterval = function (ro, rd, A, a, cosO, L, tMax, out) {
    const ox = ro[0] - A[0], oy = ro[1] - A[1], oz = ro[2] - A[2];
    const sd = rd[0] * a[0] + rd[1] * a[1] + rd[2] * a[2], so = ox * a[0] + oy * a[1] + oz * a[2], k2 = cosO * cosO;
    const rdoc = rd[0] * ox + rd[1] * oy + rd[2] * oz, oc2 = ox * ox + oy * oy + oz * oz;
    const A2 = sd * sd - k2, B2 = sd * so - k2 * rdoc, C2 = so * so - k2 * oc2;
    const sds = Math.abs(sd) < 1e-6 ? (sd < 0 ? -1e-6 : 1e-6) : sd, tA = -so / sds, tB = (L - so) / sds;
    let lo = Math.max(0, Math.min(tA, tB)), hi = Math.min(tMax, Math.max(tA, tB));
    const disc = B2 * B2 - A2 * C2, sq = Math.sqrt(Math.max(disc, 0));
    const A2s = A2 >= 0 ? Math.max(A2, 1e-6) : Math.min(A2, -1e-6), sg = B2 >= 0 ? 1 : -1;
    let q = -(B2 + sg * sq); if (Math.abs(q) < 1e-9) q = 1e-9;
    const rA = q / A2s, rB = C2 / q, r1 = Math.min(rA, rB), r2 = Math.max(rA, rB);
    if (A2 < 0) { if (!(disc > 0)) return null; lo = Math.max(lo, r1); hi = Math.min(hi, r2); }
    else if (disc >= 0) { if (sd > 0) lo = Math.max(lo, r2); else hi = Math.min(hi, r1); }
    if (!(hi > lo)) return null;
    out = out || [0, 0]; out[0] = lo; out[1] = hi; return out;
  };
  F.phase = function (c, g) { g = g == null ? 0.35 : g; return (1 - g * g) / Math.pow(Math.max(1e-4, 1 + g * g - 2 * g * c), 1.5); };   // Henyey-Greenstein, isotropic = 1 (x4 pi)
  F.coneGain = (i) => CONES[Math.max(0, Math.min(CONES.length - 1, i | 0))].gain;
  F.densityFor = function (mode, fogFar, mul, add) {   // air density (scatter per metre): thin dust in clear air, thicker with haze, ~nothing in vacuum
    let d = mode === 'space' ? 0.0006 : 0.010;
    if (mode !== 'space' && fogFar > 0) d *= Math.max(0.5, Math.min(3, 520 / Math.max(60, fogFar)));
    return Math.max(0, d * (mul == null ? 1 : mul) + (add || 0));
  };

  function initPre() { if (!_v && T) { _v = new T.Vector3(); _d = new T.Vector3(); _q = new T.Vector3(0, 0, 1); _z = new T.Vector3(); } }
  // ── the LED bar on the glasses
  function glassesMesh(rootObj) {
    let best = null;
    rootObj.traverse(o => { if (best || !o.isSkinnedMesh || !o.skeleton) return; if (o.name === 'Mesh_1' || o.name === 'Mesh 1' || (o.material && /Material_1\.001/.test(o.material.name || '') && o.skeleton.bones.some(b => b.name === 'Head'))) best = o; });
    return best;
  }
  // frame proportions from its own bind-pose vertices (mesh space): front face, top of the rim over the bridge, width, rim band
  function measure(m) {
    const P = m.geometry && m.geometry.attributes && m.geometry.attributes.position; if (!P || P.count < 50) return null;
    let zf = -1e9; for (let i = 0; i < P.count; i++) { const z = P.getZ(i); if (z > zf) zf = z; }
    let x0 = 1e9, x1 = -1e9, top = -1e9, lo = 1e9;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i); if (z < zf - 0.027) continue;   // the front of the frame (temples run back to the ears)
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (Math.abs(x) < 0.02) { if (y > top) top = y; if (y < lo) lo = y; }
    }
    if (!(x1 > x0) || !(top > lo)) return null;
    return { width: x1 - x0, top, front: zf, band: top - lo };
  }
  F.dimsFrom = function (d) {   // pure: LED bar proportions from the frame
    d = d || R;
    const len = d.width / 3, h = Math.max(0.0022, Math.min(0.004, d.band / 8)), dep = 0.006;
    return { len, h, dep, stripLen: len * 0.88, stripH: h * 0.38, x: 0, y: d.top + h * 0.5, z: d.front - dep * 0.5 + 0.0006, frame: d };
  };
  F.attach = function (CHAR) {
    T = root.THREE; if (S.built || !T || !CHAR || !CHAR.root) return false;
    F.refreshTier();
    const m = glassesMesh(CHAR.root); if (!m) return false;
    const bones = m.skeleton.bones; let hi = -1; for (let i = 0; i < bones.length; i++) if (bones[i].name === 'Head') { hi = i; break; }
    if (hi < 0) return false;
    const head = bones[hi], D = F.dimsFrom(measure(m) || R);
    // mesh (bind) space -> head-bone local: inverseBind(Head) x bindMatrix
    const M = new T.Matrix4().copy(m.skeleton.boneInverses[hi]).multiply(m.bindMatrix).multiply(new T.Matrix4().makeTranslation(D.x, D.y, D.z));
    const g = new T.Group(); g.name = 'jots_glasses_led'; M.decompose(g.position, g.quaternion, g.scale);
    const cas = new T.Mesh(new T.BoxGeometry(D.len, D.h, D.dep), new T.MeshStandardMaterial({ color: 0x060607, roughness: 0.55, metalness: 0.2 }));
    cas.name = 'jots_glasses_led_casing';
    const str = new T.Mesh(new T.BoxGeometry(D.stripLen, D.stripH, 0.0008), new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    str.name = 'jots_glasses_led_strip'; str.position.z = D.dep * 0.5 + 0.0002;
    for (const o of [g, cas, str]) { o.userData.noCollide = true; o.userData.dmFlash = true; o.raycast = () => { }; }
    cas.castShadow = false; cas.receiveShadow = false; str.castShadow = false;
    g.add(cas); g.add(str); head.add(g);
    S.led = g; S.casing = cas; S.strip = str; S.dims = D; S.built = true;
    initPre();
    sync();
    return true;
  };
  // ── the beam's shared uniforms (TSL nodes; null until TSL is there). Other passes (fog, mist, atmosphere, DMLight) may read these: cone axis / apex / angles / length / density.
  function ensureU() {
    if (S.U) return S.U;
    const TS = T && T.TSL; if (!TS || typeof TS.uniform !== 'function') return null;
    S.U = F.U = { A: TS.uniform(new T.Vector3()), a: TS.uniform(new T.Vector3(0, 0, 1)), cosO: TS.uniform(0.8), cosI: TS.uniform(0.9), len: TS.uniform(60), k: TS.uniform(0), dens: TS.uniform(0.01), col: TS.uniform(new T.Color(COLOR)), shOn: TS.uniform(0) };
    return S.U;
  }
  // the spot's own shadow node: (1) the shadow filter (the PCF taps) sits in a uniform branch — while the flashlight is off, or its shadows are throttled off, the pixel
  // shader neither samples the map nor pays for the filter; (2) the node it produces is tagged dmFlashShadow so DMLight's receivedShadowNode wrapper (sun height-field
  // visibility, sun-box fade) leaves it alone: the flashlight is not the sun.
  function shadowNodeFor(L) {
    const TS = T && T.TSL; if (!TS || !T.ShadowNode || typeof TS.If !== 'function' || typeof TS.float !== 'function') return null;
    const U = ensureU(); if (!U) return null;
    class FlashShadowNode extends T.ShadowNode {
      setupShadow(builder) { const o = super.setupShadow(builder); try { o.dmFlashShadow = true; } catch (e) { } return o; }
      setupShadowFilter(builder, inputs) {
        const out = TS.float(1).toVar();
        TS.If(U.shOn.greaterThan(0.5), () => { out.assign(super.setupShadowFilter(builder, inputs)); });
        return out;
      }
    }
    return new FlashShadowNode(L, L.shadow);
  }
  function configShadow(L) {   // tier-sized map, tight depth range, PCF soft, only updated when asked
    const sh = L.shadow; if (!sh) return;
    sh.mapSize.set(S.mapSize, S.mapSize); sh.autoUpdate = false; sh.needsUpdate = false; sh.bias = S.bias; sh.normalBias = S.normalBias; sh.camera.near = PROF.ground.shNear; sh.camera.far = Math.min(S.shFar, PROF.ground.distance);
    sh.camera.updateProjectionMatrix();
    const spotUM = Object.getPrototypeOf(sh).updateMatrices;
    if (typeof spotUM === 'function') {   // SpotLightShadow takes its far plane from light.distance: the shadow reach is shorter than the light's (tier + mode)
      sh.updateMatrices = function (light) { const d = light.distance; light.distance = S.shFar; spotUM.call(this, light); light.distance = d; };
    }
    try { const n = shadowNodeFor(L); if (n) sh.shadowNode = n; } catch (e) { S.err = 'shadownode: ' + (e && e.message || e); }
  }
  function makeSpot() {
    const L = new T.SpotLight(COLOR, 0, PROF.ground.distance, PROF.ground.angle, PROF.ground.penumbra, PROF.ground.decay); L.name = 'jots_glasses_flashlight'; L.userData.noCollide = true; L.userData.dmFlash = true;
    L.castShadow = !!(S.flags && S.flags.shadow);
    if (L.castShadow) { try { configShadow(L); } catch (e) { L.castShadow = false; S.err = 'shadow: ' + (e && e.message || e); } }
    const t = new T.Object3D(); t.name = 'jots_glasses_flashlight_target'; L.target = t; t.userData.noCollide = true;
    return { L, t };
  }
  // one beam per scene she can be in (flightScene in open space, the world scene on a planet): made BEFORE the first compile of that scene
  // (F.adoptScene from the scene builders) so switching on never changes a light set / recompiles; intensity 0 while off. Only one is ever lit.
  function dropPair(P) {
    try {
      if (P.beam) { P.beam.removeFromParent(); P.beam = null; }   // the beam geometry / material are shared by all pairs: not disposed here
      const sh = P.L.shadow; if (sh) { if (sh.shadowNode && sh.shadowNode.dispose) sh.shadowNode.dispose(); sh.shadowNode = undefined; if (sh.map && sh.map.dispose) sh.map.dispose(); sh.map = null; if (sh.dispose) sh.dispose(); }
      P.L.removeFromParent(); P.t.removeFromParent(); if (P.L.dispose) P.L.dispose();
    } catch (e) { }
    if (S.pair === P || S.light === P.L) { S.pair = null; S.light = null; S.target = null; }
    P.scene = null;
  }
  // a closed world scene: release its spot, shadow map and beam mesh now (index.html _pwClose); flightScene is never released
  F.releaseScene = function (scene) {
    for (let i = 0; i < S.pairs.length; i++) if (S.pairs[i].scene === scene) { const P = S.pairs[i]; S.pairs.splice(i, 1); dropPair(P); return true; }
    return false;
  };
  function pairFor(scene) {
    for (let i = 0; i < S.pairs.length; i++) if (S.pairs[i].scene === scene) return S.pairs[i];
    if (!T || !scene || !S.flags || !S.flags.light) return null;
    const s = makeSpot(), L = s.L, t = s.t;
    scene.add(L); scene.add(t);
    const P = { scene, L, t, prof: 'ground', cone: 0, beam: null }; S.pairs.push(P); if (S.pairs.length > 3) dropPair(S.pairs.shift());   // closed world scenes fall off the back
    return P;
  }
  F.adoptScene = function (scene) { T = T || root.THREE; F.refreshTier(); initPre(); return !!pairFor(scene); };
  F.sceneLight = function (scene) { for (let i = 0; i < S.pairs.length; i++) if (S.pairs[i].scene === scene) return S.pairs[i].L; return null; };
  function ensureLight() {
    if (S.light || !T || !S.flags || !S.flags.light) return;
    let top = S.led || null; while (top && top.parent) top = top.parent;
    const P = pairFor(top && top.isScene ? top : (S.pairs[0] ? S.pairs[0].scene : null)) || null;
    if (P) { S.light = P.L; S.target = P.t; S.pair = P; return; }
    const s = makeSpot(); S.light = s.L; S.target = s.t;   // no scene known yet: tick() parents it
  }
  const C = { on: false, mode: '', pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 }, angle: 0, penumbra: 0, cosOuter: 1, cosInner: 1, range: 0, intensity: 0, lumens: 0, cone: 0, coneName: 'wide',
    shadow: { on: false, light: null, map: null, matrix: null, near: 0, far: 0, bias: 0, size: 0, every: 1 } };
  F.cone = () => C;
  function applyProf(P, name) {   // uniform-only changes (profile of the mode x cone preset)
    const q = PROF[name], cn = CONES[S.cone]; P.prof = name; P.cone = S.cone; const L = P.L;
    L.angle = q.angle * cn.k; L.penumbra = q.penumbra; L.distance = q.distance; L.decay = q.decay;
  }
  function intensityNow(pn) { return F.intensityFor(STEPS[S.step]) * PROF[pn].gain * CONES[S.cone].gain; }
  function sync() {   // state -> LED glow / light intensity (no allocation)
    if (S.strip) S.strip.material.color.setScalar(S.on ? 1 : 0.18);
    if (S.on && S.built) ensureLight();
    if (S.light) S.light.intensity = S.on ? intensityNow(S.prof) : 0;
    if (!S.on) darkAll();
    ui();
  }
  function darkAll() {   // off: no lit beam, no shadow work, no volume anywhere (zero cost)
    for (let i = 0; i < S.pairs.length; i++) { const P = S.pairs[i]; P.L.intensity = 0; if (P.L.shadow) P.L.shadow.needsUpdate = false; if (P.beam && P.beam.visible) P.beam.visible = false; }
    if (S.light) S.light.intensity = 0;
    if (S.U) { S.U.shOn.value = 0; S.U.k.value = 0; }
    C.on = false; C.shadow.on = false; S.shadowOn = false; S.shFrame = 0;
  }
  F.toggle = function (on) { const was = S.on; S.on = typeof on === 'boolean' ? on : !S.on; if (S.on && !was) { S.fresh = 2; S.shFrame = 99; S.slow = 0; S.t = 0; } sync(); return S.on; };
  F.setStep = function (i) { i = Math.max(0, Math.min(STEPS.length - 1, i | 0)); S.step = i; sync(); return STEPS[i]; };
  F.setCone = function (i) { i = Math.max(0, Math.min(CONES.length - 1, i | 0)); S.cone = i; if (S.light && S.on) { for (let k = 0; k < S.pairs.length; k++) if (S.pairs[k].L === S.light) applyProf(S.pairs[k], S.prof); } sync(); return CONES[i].name; };
  F.setShadows = function (on) { S.shadowUser = !!on; if (on) { S.autoOff = 0; S.slow = 0; S.fresh = 2; } return S.shadowUser; };
  S.shadowUser = true;
  F.status = () => ({ on: S.on, lumens: STEPS[S.step], step: S.step, cone: CONES[S.cone].name, built: S.built, light: !!S.light, intensity: S.light ? S.light.intensity : 0, shadow: !!(S.light && S.light.castShadow), shadowOn: S.shadowOn,
    shadowUpdates: S.shUpdates, shadowSize: S.mapSize, shadowFar: S.shFar, shadowEvery: S.shEvery, autoOff: S.autoOff, tier: S.tierName, beam: S.beamOn, dens: S.dens, dtEma: S.dtEma, mode: S.mode, dims: S.dims, err: S.err, flags: S.flags });

  // ── the visible beam (volumetric shaft): one additive back-face cone, an analytic ray/cone interval + a handful of samples per pixel (see header)
  function makeBeamAsset() {
    const TS = T && T.TSL; if (!TS || typeof TS.Fn !== 'function' || typeof TS.Loop !== 'function' || !TS.viewportDepthTexture || !T.MeshBasicNodeMaterial) return null;
    let depthOK = true; try { if (F.hooks.depthOK) depthOK = !!F.hooks.depthOK(); } catch (e) { depthOK = false; }
    if (!depthOK) return null;   // multisampled WebGPU cannot bind the depth (index.html _viewportDepthOK): a shaft without a ground to stop on would pour through the terrain, so there is none
    const lgz = TS.logarithmicDepthToViewZ, pz = TS.perspectiveDepthToViewZ; if (typeof lgz !== 'function' && typeof pz !== 'function') return null;
    let logD = true; try { if (F.hooks.logDepth) logD = !!F.hooks.logDepth(); } catch (e) { }
    const toZ = logD && typeof lgz === 'function' ? lgz : pz; if (typeof toZ !== 'function') return null;
    const U = ensureU(); if (!U) return null;
    const { Fn, float, vec2, vec3, vec4, Loop, dot, sqrt, max, min, abs, select, smoothstep, fract, cameraPosition, positionWorld, cameraNear, cameraFar, cameraViewMatrix, viewportDepthTexture, screenUV } = TS;
    const N = S.tier.steps, noise = !!(S.tier.noise && typeof TS.mx_noise_float === 'function' && TS.time), G = 0.35;
    const sgn = x => select(x.greaterThanEqual(0.0), float(1.0), float(-1.0));
    const mat = new T.MeshBasicNodeMaterial({ side: T.BackSide, transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending });
    mat.fog = false; mat.name = 'jots_flash_beam';
    mat.colorNode = Fn(() => {
      const ro = cameraPosition, rv = positionWorld.sub(ro), tFar = rv.length(), rd = rv.div(max(tFar, 1e-4)), A = U.A, a = U.a;
      // the scene depth along this ray (the shaft stops on terrain / walls / props), as in the atmosphere shell
      const vzs = toZ(viewportDepthTexture(screenUV).r, cameraNear, cameraFar), vd = cameraViewMatrix.mul(vec4(rd, 0.0)).xyz;
      const ts = select(vzs.negate().lessThan(cameraFar.mul(0.98)), vzs.div(min(vd.z, -1e-4)), float(1e9));
      const tMax = min(tFar.add(0.01), ts);
      // ray / solid cone (mirrors F.coneInterval)
      const oc = ro.sub(A), sd = dot(rd, a), so = dot(oc, a), k2 = U.cosO.mul(U.cosO);
      const A2 = sd.mul(sd).sub(k2), B2 = sd.mul(so).sub(k2.mul(dot(rd, oc))), C2 = so.mul(so).sub(k2.mul(dot(oc, oc)));
      const sds = select(abs(sd).lessThan(1e-6), float(1e-6), sd), tA = so.negate().div(sds), tB = U.len.sub(so).div(sds);
      const lo0 = max(min(tA, tB), 0.0), hi0 = min(max(tA, tB), tMax);
      const disc = B2.mul(B2).sub(A2.mul(C2)), sq = sqrt(max(disc, 0.0));
      const A2s = select(A2.greaterThanEqual(0.0), max(A2, 1e-6), min(A2, -1e-6)), q0 = B2.add(sgn(B2).mul(sq)).negate(), q = select(abs(q0).lessThan(1e-9), float(1e-9), q0);
      const rA = q.div(A2s), rB = C2.div(q), r1 = min(rA, rB), r2 = max(rA, rB);
      const neg = A2.lessThan(0.0), has = disc.greaterThanEqual(0.0), fwd = sd.greaterThan(0.0);
      const lo = select(neg, max(lo0, r1), select(has.and(fwd), max(lo0, r2), lo0)), hi = select(neg, min(hi0, r2), select(has.and(fwd.not()), min(hi0, r1), hi0));
      const len = select(neg.and(disc.greaterThan(0.0).not()), float(0.0), max(hi.sub(lo), 0.0)), dt = len.div(float(N));
      const sc = TS.screenCoordinate || screenUV.mul(vec2(1024.0, 768.0));
      const jit = fract(float(52.9829189).mul(fract(dot(sc, vec2(0.06711056, 0.00583715)))));   // interleaved gradient noise: no banding with 6-14 samples
      const acc = float(0).toVar();
      Loop(N, ({ i }) => {
        const t = lo.add(dt.mul(float(i).add(jit))), p = ro.add(rd.mul(t)), d = p.sub(A), s = dot(d, a), r = max(d.length(), 0.05);
        const cone = smoothstep(U.cosO, U.cosI, s.div(r)), lf = float(1.0).sub(smoothstep(U.len.mul(0.55), U.len, s));
        const nr = float(1.0).add(r.mul(0.08)), near = float(1.0).div(nr.mul(sqrt(nr)));
        let rho = U.dens;
        if (noise) rho = rho.mul(float(0.55).add(TS.mx_noise_float(p.mul(0.11).add(vec3(0.0, TS.time.mul(0.04), 0.0))).mul(0.5).add(0.5).mul(0.9)));
        acc.addAssign(cone.mul(lf).mul(near).mul(rho).mul(dt));
      });
      const den = float(1.0 + G * G).add(sd.mul(2.0 * G)), ph = float(1.0 - G * G).div(den.mul(sqrt(den)));   // forward scatter: the camera in front of the lamp sees more (c = -rd.a)
      return U.col.mul(acc.mul(ph).mul(U.k));
    })();
    const geo = new T.ConeGeometry(1, 1, 20, 1, false); geo.translate(0, -0.5, 0); geo.rotateX(-Math.PI / 2);   // apex at the origin, opening along +Z, unit length / radius
    return { mat, geo, steps: N, noise };
  }
  function beamFor(P) {   // the cone mesh of this scene (made on first need, hidden when off)
    if (S.beam === undefined) { try { S.beam = makeBeamAsset(); } catch (e) { S.beam = null; S.err = 'beam: ' + (e && e.message || e); } }
    if (!S.beam) return null;
    if (!P.beam) {
      const m = new T.Mesh(S.beam.geo, S.beam.mat); m.name = 'jots_flash_beam'; m.frustumCulled = false; m.renderOrder = 52; m.visible = false; m.castShadow = false; m.receiveShadow = false;
      m.userData.noBend = true; m.userData.noCollide = true; m.userData.dmFlash = true; m.raycast = () => { };
      P.scene.add(m); P.beam = m;
    }
    return P.beam;
  }
  function governor() {   // frame-time EMA -> shadow cadence / auto-off (a flashlight must never be what drops the game under ~15 fps)
    const now = root.performance && root.performance.now ? root.performance.now() : Date.now(), dt = S.t ? now - S.t : 0; S.t = now;
    if (dt > 0 && dt < 250) S.dtEma += (dt - S.dtEma) * 0.06;
    if (S.autoOff === 0) { if (S.dtEma > 72) S.slow++; else S.slow = 0; if (S.slow > 90) { S.autoOff = 1; S.fast = 0; } }
    else if (S.autoOff === 1) { if (S.dtEma < 42) S.fast++; else S.fast = 0; if (S.fast > 600) { if (S.retry < 2) { S.retry++; S.autoOff = 0; S.slow = 0; S.fresh = 2; } else S.autoOff = 2; } }   // 2 = off for the rest of the session
  }
  function shadowStep(P, L, pn) {
    const sh = L.shadow, U = S.U, q = PROF[pn];
    if (!L.castShadow || !sh || !S.flags.shadow || !S.shadowUser || S.autoOff !== 0) { if (U) U.shOn.value = 0; sh && (sh.needsUpdate = false); S.shadowOn = false; C.shadow.on = false; return; }
    let size = S.mapSize, every = S.shEvery;
    const B = root.DMBudget;
    if (B && B.on) { try { if (B.shadowHalf && B.shadowHalf()) size = Math.max(512, size >> 1); if (B.shadowEvery) { const be = B.shadowEvery(); if (be > every) every = be; } } catch (e) { } }
    if (S.dtEma > 55) { if (every < 3) every = 3; } else if (S.dtEma > 38) { if (every < 2) every = 2; }
    if (sh.mapSize.x !== size) sh.mapSize.set(size, size);
    const far = Math.min(S.tier.far, q.shFar, q.distance);
    if (far !== S.shFar || q.shNear !== S.shNear) { S.shFar = far; S.shNear = q.shNear; sh.camera.near = q.shNear; sh.camera.updateProjectionMatrix(); S.fresh = 1; }
    if (++S.shFrame >= every || S.fresh > 0) { sh.needsUpdate = true; S.shFrame = 0; S.shUpdates++; if (S.fresh > 0) S.fresh--; }
    S.shadowOn = true; if (U) U.shOn.value = 1;
    const c = C.shadow; c.on = true; c.light = L; c.map = sh.map || null; c.matrix = sh.matrix; c.near = S.shNear; c.far = S.shFar; c.bias = sh.bias; c.size = size; c.every = every;
  }
  function beamStep(P, L, top, mode, pn) {
    const U = S.U || ensureU(); const B = S.flags.beam;
    const VL = root.DMVLight;   // DMVLight (ui/dm-vlight.js) already scatters the flashlight in the scene's fog (scene.fogNode): this cone then yields (no double beam) unless ?flashbeam=<k> forces it; it still covers vacuum / fog-less scenes
    const yielded = !S.flags.beamForce && mode !== 'space' && VL && VL.on && top.fogNode;
    let m = null; if (B > 0 && U && !yielded) m = beamFor(P);
    if (yielded && P.beam && P.beam.visible) P.beam.visible = false;
    if (!m) { S.beamOn = false; return; }
    const fog = top.fog; S.dens = F.densityFor(mode, fog && fog.far ? fog.far : 0, F.medium.mul, F.medium.add);
    const k = B * Math.pow(STEPS[S.step] / 2000, 0.7) * Math.sqrt(CONES[S.cone].gain) * (pn === 'space' ? 0.6 : 1);
    const on = S.dens * k > 2e-5; if (m.visible !== on) m.visible = on; S.beamOn = on; U.k.value = on ? k : 0;
    if (!on) return;
    const ang = L.angle, len = pn === 'space' ? 400 : (S.tierName === 'desktop' ? 120 : 70), rad = len * Math.tan(ang) * 1.04;
    U.dens.value = S.dens; U.len.value = len; U.cosO.value = C.cosOuter; U.cosI.value = C.cosInner;
    U.A.value.set(C.pos.x, C.pos.y, C.pos.z); U.a.value.set(C.dir.x, C.dir.y, C.dir.z);
    m.position.set(C.pos.x, C.pos.y, C.pos.z); _z.set(C.dir.x, C.dir.y, C.dir.z); m.quaternion.setFromUnitVectors(_q, _z); m.scale.set(rad, rad, len);
    if (m.parent !== top) top.add(m);
    m.updateMatrixWorld(true);
  }

  // per frame: HUD mode change -> re-dock the button; while on, carry the beam with her glasses. No allocation.
  F.tick = function (mode) {
    mode = mode || '';
    if (mode !== S.mode) { S.mode = mode; S.dirty = true; S.wait = 0; }
    if (++S.rc > 120) { S.rc = 0; S.dirty = true; S.wait = 0; S.tries = 0; }   // ~2 s: re-place if a HUD control moved into its slot
    if (S.dirty) { if (S.wait > 0) S.wait--; else dock(); }   // a HUD that is not laid out yet is re-measured every ~15 frames, not every frame (getBoundingClientRect allocates)
    if (!S.on || !S.led) { if (!S.on && S.wasOn) { S.wasOn = false; darkAll(); } if (!S.on && S.light && S.light.intensity !== 0) S.light.intensity = 0; return; }   // off: never leaves a lit beam behind, whatever the mode
    let top = S.led; while (top.parent) top = top.parent;
    if (!top.isScene) return;   // not in any scene (between worlds): nothing to light
    let P = null; for (let i = 0; i < S.pairs.length; i++) if (S.pairs[i].scene === top) { P = S.pairs[i]; break; }
    if (!P) P = pairFor(top);   // a scene nobody adopted: one-off lazy beam (recompiles that scene once)
    if (!P) return;
    const L = P.L; S.wasOn = true;
    if (S.light !== L) { for (let i = 0; i < S.pairs.length; i++) { const O = S.pairs[i]; if (O !== P) { O.L.intensity = 0; if (O.beam && O.beam.visible) O.beam.visible = false; } } if (S.light) S.light.intensity = 0; S.light = L; S.target = P.t; S.pair = P; S.fresh = 2; }   // she moved scenes: the other beam goes dark
    const pn = mode === 'space' ? 'space' : 'ground';
    if (pn !== S.prof || P.prof !== pn || P.cone !== S.cone) { S.prof = pn; applyProf(P, pn); S.fresh = 1; }
    const I = intensityNow(pn); if (L.intensity !== I) L.intensity = I;
    if (L.parent !== top) { top.add(L); top.add(P.t); }
    const e = S.led.matrixWorld.elements;
    _v.set(e[12], e[13], e[14]); _d.set(e[8], e[9], e[10]).normalize();   // the bar's +Z = the glasses' forward (mirrored with her while riding)
    L.position.copy(_v); P.t.position.set(_v.x + _d.x * 20, _v.y + _d.y * 20, _v.z + _d.z * 20);
    L.updateMatrixWorld(); P.t.updateMatrixWorld();
    C.on = true; C.mode = mode; C.pos.x = _v.x; C.pos.y = _v.y; C.pos.z = _v.z; C.dir.x = _d.x; C.dir.y = _d.y; C.dir.z = _d.z;
    C.angle = L.angle; C.penumbra = L.penumbra; C.cosOuter = Math.cos(L.angle); C.cosInner = Math.cos(L.angle * (1 - L.penumbra)); C.range = L.distance; C.intensity = I; C.lumens = STEPS[S.step]; C.cone = S.cone; C.coneName = CONES[S.cone].name;
    governor();
    shadowStep(P, L, pn);
    beamStep(P, L, top, mode, pn);
  };

  // ── UI
  const ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8.2 3.5h7.6l-1.3 4.2H9.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M9.5 7.7h5v11.6a1.2 1.2 0 0 1-1.2 1.2h-2.6a1.2 1.2 0 0 1-1.2-1.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<rect x="11.2" y="11" width="1.6" height="3.4" rx=".8" fill="currentColor"/><path class="fl-ray" d="M5.2 2.6l1.6 1.4M18.8 2.6l-1.6 1.4M12 .6v1.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const CSS = '#dm-flash{position:fixed;left:0;bottom:0;z-index:3555;display:none;pointer-events:none;}' +
    '#dm-flash[data-m]:not([data-m=""]){display:block;}' +   // (t1480) shown by data-m alone: the old `body:has(#screen-flight.active)` gate made the whole rule INVALID on a WebView without :has
    'body:has(#screen-menu.active) #dm-flash,body:has(#screen-builder.active) #dm-flash{display:none !important;}' +
    '#dm-flash .fl-btn{position:absolute;left:0;bottom:0;width:34px;height:34px;border-radius:50%;padding:0;margin:0;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(6,14,28,.55);border:1px solid rgba(160,210,255,.45);color:#9fc8ee;pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;cursor:pointer;}' +
    '#dm-flash .fl-btn .fl-ray{opacity:0;}' +
    '#dm-flash.on .fl-btn{background:rgba(255,248,230,.16);border-color:#fff6e0;color:#fffaf0;box-shadow:0 0 10px rgba(255,244,214,.45);}#dm-flash.on .fl-btn .fl-ray{opacity:1;}' +
    '#dm-flash .fl-bar{position:absolute;left:37px;bottom:0;width:20px;display:none;flex-direction:column-reverse;gap:3px;padding:3px;box-sizing:border-box;border-radius:7px;' +
    'background:rgba(6,14,28,.6);border:1px solid rgba(160,210,255,.35);pointer-events:auto;touch-action:manipulation;}' +
    '#dm-flash.on .fl-bar{display:flex;}' +
    '#dm-flash .fl-cone{flex:0 0 16px;width:100%;height:16px;border-radius:4px;border:0;padding:0;margin:0 0 1px;display:flex;align-items:center;justify-content:center;background:rgba(160,200,240,.2);color:#cfe4ff;cursor:pointer;}' +
    '#dm-flash .fl-cone svg{width:14px;height:12px;display:block;}#dm-flash .fl-cone .c1,#dm-flash .fl-cone .c2{opacity:.25;}#dm-flash[data-k="0"] .fl-cone .c1,#dm-flash[data-k="0"] .fl-cone .c2,#dm-flash[data-k="1"] .fl-cone .c1{opacity:1;}' +
    '#dm-flash .fl-seg{flex:1 1 0;min-height:10px;border-radius:3px;background:rgba(160,200,240,.16);border:0;padding:0;margin:0;cursor:pointer;}' +
    '#dm-flash .fl-seg.lit{background:linear-gradient(to top,#d8e8ff,#fffaf0);box-shadow:0 0 6px rgba(255,246,224,.5);}';
  function build() {
    if (S.ui || !root.document || !document.body) return S.ui;
    if (!document.getElementById('dm-flash-css')) { const st = document.createElement('style'); st.id = 'dm-flash-css'; st.textContent = CSS; document.head.appendChild(st); }
    const w = document.createElement('div'); w.id = 'dm-flash'; w.setAttribute('data-m', '');
    const b = document.createElement('button'); b.className = 'fl-btn'; b.type = 'button'; b.setAttribute('aria-label', 'Glasses flashlight'); b.title = 'Glasses flashlight'; b.innerHTML = ICON;
    const bar = document.createElement('div'); bar.className = 'fl-bar'; bar.setAttribute('role', 'radiogroup'); bar.setAttribute('aria-label', 'Flashlight brightness');
    const ck = document.createElement('button'); ck.type = 'button'; ck.className = 'fl-cone'; ck.setAttribute('aria-label', 'Beam width'); ck.title = 'Beam width (long-press the light button too)';
    ck.innerHTML = '<svg viewBox="0 0 14 12" aria-hidden="true"><path class="c0" d="M7 1L5.4 11M7 1L8.6 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path class="c1" d="M7 1L2.6 11M7 1L11.4 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path class="c2" d="M7 1L0.6 10M7 1L13.4 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>';
    STEPS.forEach((lm, i) => { const s = document.createElement('button'); s.type = 'button'; s.className = 'fl-seg'; s.setAttribute('data-i', i); s.setAttribute('aria-label', lm + ' lumens'); s.title = lm + ' lm'; bar.appendChild(s); });
    bar.appendChild(ck);   // column-reverse: the last child is the TOP of the bar
    const stop = e => { e.stopPropagation(); };
    let lp = 0, lpDone = false;   // long-press the light button: beam width wide -> medium -> spot (the cone key in the bar does the same)
    b.addEventListener('click', e => { stop(e); if (lpDone) { lpDone = false; return; } F.toggle(); });
    b.addEventListener('pointerdown', () => { lpDone = false; clearTimeout(lp); lp = setTimeout(() => { lpDone = true; F.setCone((S.cone + 1) % CONES.length); }, 520); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(lp));
    ck.addEventListener('click', e => { stop(e); F.setCone((S.cone + 1) % CONES.length); });
    bar.addEventListener('click', e => { stop(e); const t = e.target && e.target.closest && e.target.closest('.fl-seg'); if (t) F.setStep(+t.getAttribute('data-i')); });
    for (const el of [b, bar]) { el.addEventListener('touchstart', stop, { passive: true }); el.addEventListener('mousedown', stop); el.addEventListener('pointerdown', stop); }
    w.appendChild(b); w.appendChild(bar); document.body.appendChild(w);
    S.ui = { w, b, bar, ck, segs: bar.getElementsByClassName('fl-seg') };
    root.addEventListener('resize', () => { S.dirty = true; S.wait = 0; }); root.addEventListener('orientationchange', () => { S.dirty = true; S.wait = 0; });
    return S.ui;
  }
  function ui() {
    const u = build(); if (!u) return;
    u.w.classList.toggle('on', S.on); u.b.setAttribute('aria-pressed', S.on ? 'true' : 'false'); u.w.setAttribute('data-k', S.cone); u.ck.title = 'Beam width: ' + CONES[S.cone].name;
    for (let i = 0; i < u.segs.length; i++) { u.segs[i].classList.toggle('lit', i <= S.step); u.segs[i].setAttribute('aria-checked', i === S.step ? 'true' : 'false'); }
  }
  const STICK = { space: 'jL', fly: 'atmo-steer-zone', walk: 'surf-move-zone' }, NEXT = ['level-stack'];
  const STICK2 = { space: 'jR', fly: 'atmo-climb-zone', walk: 'surf-look-zone' };   // the right-hand stick of each HUD (second-choice side)
  F.STICK = STICK; F.STICK2 = STICK2;
  // (t1480) ALWAYS available: the button is shown in EVERY game mode (on foot, mansion / interior, sky, space), day or night. It prefers the slot right of
  // the left stick; if a HUD control sits there it tries the next free slot; if no stick can be found / laid out it still shows in a fixed bottom-left
  // slot (never hidden because a measurement failed). Re-checked every ~2 s so a control that opens later (globe, pads) cannot bury it.
  const OBST = '#surface-overlay button,#atmo-overlay button,#screen-flight button,#surf-move-zone,#surf-look-zone,#atmo-steer-zone,#atmo-climb-zone,#jL,#jR,#level-stack,' +
    '#atmo-overlay .side-pad,#dm-globe .dg-globe,#dm-globe .dg-b,.kite-board.kb-float,.kb-float';
  const SZ = 34, GAP = 6;
  function vis(e) { if (!e || (e.closest && e.closest('#dm-flash'))) return null; const q = e.getBoundingClientRect(); if (q.width < 2 || q.height < 2) return null; const c = root.getComputedStyle(e); if (c.visibility === 'hidden' || c.display === 'none' || +c.opacity < 0.05) return null; return q; }
  function free(x, b, obs, W, H) {   // a SZ square at left x / bottom-offset b: on screen and clear of every obstacle
    const l = x, t = H - b - SZ; if (l < 2 || l + SZ > W - 2 || t < 2 || t + SZ > H - 2) return false;
    for (let i = 0; i < obs.length; i++) { const q = obs[i]; if (q.left < l + SZ && q.right > l && q.top < t + SZ && q.bottom > t) return false; }
    return true;
  }
  F._free = free;
  function dock() {
    const u = build(); if (!u) return; S.dirty = false; S.rc = 0;
    const d = root.document, sf = d.getElementById('screen-flight');
    if (!S.mode || (sf && !sf.classList.contains('active'))) { u.w.setAttribute('data-m', ''); return; }   // not in a game screen (menu / builder / between worlds)
    const W = root.innerWidth, H = root.innerHeight;
    const z = d.getElementById(STICK[S.mode]), z2 = d.getElementById(STICK2[S.mode]);
    const r = z && z.getBoundingClientRect(), r2 = z2 && z2.getBoundingClientRect();
    const okR = r && r.width >= 2, okR2 = r2 && r2.width >= 2;
    if (!okR && S.tries < 3) { S.tries++; S.dirty = true; S.wait = 15; if (!S.placed) return; }   // (after 3 tries it settles on the fallback slot; the ~2 s recheck resets the count)   // its HUD is not laid out yet: retry in ~15 frames (a few times), then fall back
    if (okR) S.tries = 0;
    const obs = []; const nl = d.querySelectorAll(OBST); for (let i = 0; i < nl.length; i++) { const q = vis(nl[i]); if (q) obs.push(q); }
    const sb = (function () { try { return parseFloat(root.getComputedStyle(d.documentElement).getPropertyValue('--safe-bot')) || 0; } catch (e) { return 0; } })();
    const cand = [];   // [x, bottom-offset]
    if (okR) {
      let x = r.right + GAP;   // the side pads that share the stick row (space: #level-stack right of the stick in landscape) push it one slot further right
      for (let i = 0; i < NEXT.length; i++) {
        const e = d.getElementById(NEXT[i]); if (!e || !e.offsetParent) continue; const q = e.getBoundingClientRect();
        if (q.width > 1 && q.left < x + 60 && q.right > x - 2 && q.top < r.bottom && q.bottom > r.top) x = q.right + GAP;
      }
      cand.push([x, H - r.bottom]);                                  // right of the left stick, bottom aligned (preferred)
      cand.push([r.right + GAP, H - r.bottom + SZ + GAP]);           // ... one slot up
      cand.push([r.left, H - r.top + GAP]);                          // above the stick
    }
    if (okR2) { cand.push([r2.left - GAP - SZ, H - r2.bottom]); cand.push([r2.left - GAP - SZ, H - r2.bottom + SZ + GAP]); }   // left of the right stick
    cand.push([Math.round(W / 2 - SZ - 40), Math.max(12, sb + 12)]);  // bottom centre-left, clear of the stick row on a phone
    let pick = null; for (let i = 0; i < cand.length && !pick; i++) if (free(cand[i][0], cand[i][1], obs, W, H)) pick = cand[i];
    if (!pick) pick = cand.length > 1 && okR ? cand[0] : [12, Math.max(150, sb + 150)];   // nothing free (or no sticks at all): the stick slot / a fixed bottom-left slot — still visible, on top
    S.placed = true;
    u.w.setAttribute('data-m', S.mode);
    u.w.style.left = Math.round(Math.max(2, Math.min(W - SZ - 2, pick[0]))) + 'px'; u.w.style.bottom = Math.round(Math.max(2, pick[1])) + 'px';
    u.bar.style.height = Math.round(Math.max(104, Math.min(124, okR ? r.height : 108))) + 'px';
  }
  F._dock = dock;
  if (root.document) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ui()); else ui(); }
})(typeof window !== 'undefined' ? window : globalThis);
