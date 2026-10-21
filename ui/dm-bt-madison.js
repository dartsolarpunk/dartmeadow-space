/* dm-bt-madison.js — Madison v2: the rigged felt plush on the engineering-office desk (Bird Temple, deck C).
 *
 * Art: assets/bt-engineering/madison.glb (skinned, 20 joints, ~20.7k tris, actions Idle / Sit / Run / Wave, meshopt + webp)
 *      assets/bt-engineering/madison_hair.bin (DHS1 groom: 1,400 strands / 350 guides, blue→violet gradient, head +
 *      neck/torso/shoulder/arm capsules), both built by assets/blender/bt-engineering/build_madison*.py.
 * Hair runs on the game's own strand solver (hair_strands.js buildHair, the one Ariel uses), opted in with
 * opts.character; it hooks this doll's AnimationMixer, so it simulates only on frames the mixer is stepped.
 *
 * Per-frame cost: nothing unless Ariel is aboard AND within cfg.near of the desk. Then: one AnimationMixer.update
 * (Sit loop, 20 joints) + the hair step (350 guides × 14 points; GPU ribbons on WebGPU). Far away / outside the
 * ship, the doll is a static skinned draw that follows the office's LOD visibility (it is a child of the office).
 * Lazy: fetched on boarding (see hook()), compiled before shown + registered with DMWarm. Lit by the temple's interior light list (ui/dm-bt-lighting.js, v114), adds no lights. Tuning: window.BTE.madison.cfg.
 */
(function () {
  'use strict';
  const URL_GLB = 'assets/bt-engineering/madison.glb?v=4', URL_HAIR = 'assets/bt-engineering/madison_hair.bin?v=4';
  const cfg = {
    // seat on the desk, temple glTF frame (= Blender (-6.55, 90.93, -20.75) → glTF (x, z, -y)); doll units → temple units
    pos: [-6.55, -20.75, -90.93], yaw: -0.24, scale: 1.1, seatDrop: 0.29,
    near: 14, nearY: 5, waveAt: 4.5, ixRadius: 4.2, tapR: 1.25,
    // idle layer (only while near): breathing, blinks, small head turns; greetings on tap / F
    breath: 0.06, sway: 0.035, headYaw: 0.45, headPitch: 0.12, turnEvery: [2.2, 4.8], blinkEvery: [1.8, 4.5], selfLight: 0.22, eyeLight: 0.55, hair: true,
    hairParams: { bodyColliders: false, widthRoot: 0.016, widthTip: 0.008, hairRadius: 0.012, gravity: 5.0, maxRootStep: 0.03 },
  };
  const MAD = { cfg, ready: false, root: null, mixer: null, hair: null, actions: {}, active: false };
  // Start: event-driven, no polling. dm-bt-engineering fires 'bte:ready' once the office is in the temple; we then
  // hook BTI.update and fetch the ~0.9 MB doll + groom only on the first frame Ariel is boarding/aboard (hatch → deck A),
  // so it is loaded, compiled and warmed well before she can reach the engine room on deck C. Never aboard = never loaded.
  let hooked = false, loading = false, tick = null;
  function hook() {
    const B = window.BTE;
    if (hooked || !(B && B.ready && B.scene && window.BTI && window.THREE && THREE.GLTFLoader)) return;
    hooked = true; B.madison = MAD;
    const up = BTI.update;
    BTI.update = function (dt) {
      up(dt);
      if (tick) { tick(dt); return; }
      if (loading) return;
      const aboard = (typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active) || (BTI._depth || 0) > 0.01;
      if (aboard) { loading = true; init(B).catch(e => console.warn('[Madison] init', e)); }
    };
  }
  window.addEventListener('bte:ready', hook);
  hook();   // in case the office was already up
  async function init(B) {
    const L = new THREE.GLTFLoader();
    try { const m = await import('three/addons/libs/meshopt_decoder.module.js'); L.setMeshoptDecoder(m.MeshoptDecoder); } catch (e) { }
    const gltf = await L.loadAsync(URL_GLB);
    const doll = gltf.scene; doll.name = 'FX_BTE_Madison';            // FX_: never part of the walk collision
    const holder = new THREE.Group(); holder.name = 'FX_BTE_MadisonSeat';
    holder.position.set(cfg.pos[0], cfg.pos[1] - cfg.seatDrop * cfg.scale, cfg.pos[2]);
    holder.rotation.y = cfg.yaw; holder.scale.setScalar(cfg.scale);
    holder.add(doll);
    const seen = new Set();
    doll.traverse(o => {
      if (o.name === 'MadisonCollider') { o.visible = false; return; }   // capsule/sphere proxy (hair colliders mirror it)
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        if (!m || seen.has(m)) continue; seen.add(m);
        // night-dim deck, no lights added: warm self-light from the atlas itself (black suit stays black, peach face glows a
        // little), bright amber eyes with a glossy clear-coat catchlight
        if (m.name === 'MAD_Felt' && m.emissive && m.map) {
          m.emissive.setRGB(1, 0.8, 0.68); m.emissiveMap = m.map; m.emissiveIntensity = cfg.selfLight;
          if ('sheen' in m) { m.sheen = Math.max(m.sheen || 0, 0.7); m.sheenRoughness = 0.5; m.sheenColor && m.sheenColor.setRGB(1, 0.82, 0.7); }
        } else if (m.name === 'MAD_Eye' && m.emissive && m.map) {
          m.emissive.setRGB(1, 0.9, 0.75); m.emissiveMap = m.map; m.emissiveIntensity = cfg.eyeLight; m.roughness = 0.08;
          if ('clearcoat' in m) { m.clearcoat = 1; m.clearcoatRoughness = 0.02; }
        }
      }
    });
    // animation: Sit is her pose on the desk; Wave once when Ariel walks right up
    const mixer = new THREE.AnimationMixer(doll); MAD.mixer = mixer;
    for (const c of gltf.animations) MAD.actions[c.name] = mixer.clipAction(c);
    const sit = MAD.actions.Sit, wave = MAD.actions.Wave;
    if (sit) sit.play();
    if (wave) { wave.setLoop(THREE.LoopOnce, 1); wave.clampWhenFinished = false; }
    mixer.update(0);                                                     // seated from the first frame drawn
    mixer.addEventListener('finished', e => { if (e.action === wave && sit) { sit.reset().play(); sit.crossFadeFrom(wave, 0.4, false); } });
    holder.updateMatrixWorld(true);
    MAD.root = holder;
    // hair: the game's strand solver on Madison's own groom
    if (cfg.hair) {
      try {
        const mod = await import('../hair_strands.js');
        const buf = await (await fetch(URL_HAIR)).arrayBuffer();
        const bones = {}; doll.traverse(o => { if (o.isBone) bones[o.name] = o; });
        const CH = { root: doll, bones, mixer };
        MAD.hair = mod.buildHair(CH, THREE, buf, { character: 'madison', params: cfg.hairParams });
        MAD.hair.mesh.name = 'FX_MadisonHair';
      } catch (e) { console.info('[Madison] hair not attached:', e && e.message); }
    }
    // compile now (hidden, off to the side) and on the flight warm-up, so boarding never compiles her
    const warm = async () => {
      if (typeof _dmCompileObject !== 'function') return;
      try { if (window.BTL && BTL.apply) BTL.apply(holder, true); } catch (e) { }   // v114: the temple's interior light list (star through the windows, reading lights, caustics) + star shadow, before compiling
      await _dmCompileObject(holder);
      try {   // the strand ribbons swap to their GPU material on first draw: draw once into a 4×4 target, then compile that too
        const H = MAD.hair, r = (typeof flightRenderer !== 'undefined') && flightRenderer;
        if (H && r && typeof flightCamera !== 'undefined' && !MAD._rtDone) {
          MAD._rtDone = true;
          const rt = new THREE.RenderTarget(4, 4), prev = r.getRenderTarget(), vis = B.scene.visible;
          r.setRenderTarget(rt); try { r.render(holder, flightCamera); } finally { r.setRenderTarget(prev); }
          rt.dispose();
          const m = H.mesh.material, cw = m.colorWrite, dw = m.depthWrite; m.colorWrite = true; m.depthWrite = true;
          await _dmCompileObject(holder); m.colorWrite = cw; m.depthWrite = dw;
        }
      } catch (e) { }
    };
    try { if (window.DMWarm && DMWarm.add) DMWarm.add('Madison doll', warm); } catch (e) { }
    try { await warm(); } catch (e) { }
    B.scene.add(holder); holder.updateMatrixWorld(true);                  // shown only once compiled
    // ───────── procedural layer: idle life + greetings (bone offsets on top of the Sit clip) ─────────
    const bone = {}; doll.traverse(o => { if (o.isBone) bone[o.name] = o; });
    const rest = new Map(); for (const k in bone) rest.set(bone[k], bone[k].quaternion.clone());
    let eyeTex = null; doll.traverse(o => { if (o.isMesh) for (const m of [o.material].flat()) if (m && m.name === 'MAD_Eye' && m.map) eyeTex = m.map; });
    if (eyeTex) { eyeTex.matrixAutoUpdate = true; eyeTex.offset.set(0, 0); eyeTex.updateMatrix(); }
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
    const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _ax = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
    // rotate a bone about an axis given in the doll's own frame (doll faces +Z, +X her left, +Y up)
    function rot(b, axis, ang) {
      if (!b || !ang) return;
      doll.getWorldQuaternion(_rq); b.parent.getWorldQuaternion(_pq);
      _ax.copy(axis).applyQuaternion(_rq).applyQuaternion(_pq.invert());
      b.quaternion.premultiply(_q.setFromAxisAngle(_ax, ang));
    }
    const rnd = (a, b) => a + Math.random() * (b - a), sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const I = { t: 0, yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, nextTurn: 1.5, lookAriel: 0, blinkT: -1, nextBlink: 2, g: null, last: '' };
    MAD.idle = I;
    let charHead = null;
    function arielHead(out) {   // world position of Ariel's head (her Head bone, else her root + her height)
      try {
        if (typeof CHAR === 'undefined' || !CHAR.root) return null;
        if (charHead === null) charHead = CHAR.root.getObjectByName('Head') || CHAR.root.getObjectByName('mixamorig:Head') || CHAR.root.getObjectByName('mixamorigHead') || false;
        if (charHead) return charHead.getWorldPosition(out);
        return CHAR.root.getWorldPosition(out).add(_w.set(0, 1.6 * CHAR.root.getWorldScale(_v).y, 0));
      } catch (e) { return null; }
    }
    const GREET = ['hello', 'wave', 'kick', 'shy'];
    MAD.greet = function (kind) {
      if (I.g && I.g.t < I.g.dur * 0.7) return false;
      if (!kind) { const pool = GREET.filter(k => k !== I.last); kind = pool[(Math.random() * pool.length) | 0]; }
      I.last = kind; I.g = { kind, t: 0, dur: kind === 'wave' ? 2.6 : kind === 'shy' ? 2.8 : 2.2 };
      if (kind === 'wave' && wave) { wave.reset().play(); if (sit) wave.crossFadeFrom(sit, 0.3, false); }
      if (kind === 'shy') I.blinkT = 0;
      try { if (typeof sfx !== 'undefined' && sfx.chirp) sfx.chirp(); } catch (e) { }
      return true;
    };
    function life(dt) {
      I.t += dt; const t = I.t, g = I.g;
      if (g) { g.t += dt; if (g.t >= g.dur) I.g = null; }
      const env = g ? sm(0, 0.35, g.t) * (1 - sm(g.dur - 0.45, g.dur, g.t)) : 0;
      // idle head turns: a new small glance every few seconds, sometimes straight at Ariel
      if ((I.nextTurn -= dt) <= 0) {
        I.nextTurn = rnd(cfg.turnEvery[0], cfg.turnEvery[1]);
        I.lookAriel = Math.random() < 0.35 ? 1 : 0;
        I.tYaw = rnd(-cfg.headYaw, cfg.headYaw); I.tPitch = rnd(-cfg.headPitch, cfg.headPitch * 0.6);
      }
      // look-at toward Ariel's head, in the doll frame
      let lYaw = 0, lPitch = 0; const hp = arielHead(_v);
      if (hp && bone.Head) {
        doll.worldToLocal(hp); bone.Head.getWorldPosition(_w); doll.worldToLocal(_w); hp.sub(_w);
        lYaw = Math.max(-1.0, Math.min(1.0, Math.atan2(hp.x, hp.z)));
        lPitch = Math.max(-0.55, Math.min(0.25, -Math.atan2(hp.y, Math.hypot(hp.x, hp.z))));
      }
      let wLook = I.lookAriel * 0.85;
      if (g && g.kind !== 'shy') wLook = Math.max(wLook, env);
      const k = Math.min(1, dt * 3.2);
      I.yaw += ((I.tYaw * (1 - wLook) + lYaw * wLook) - I.yaw) * k;
      I.pitch += ((I.tPitch * (1 - wLook) + lPitch * wLook) - I.pitch) * k;
      // breathing + a slow sway
      const br = Math.sin(t * 1.9), sw = Math.sin(t * 0.73);
      rot(bone.Spine01, X, -cfg.breath * 0.5 * br);
      rot(bone.Spine, X, -cfg.breath * 0.5 * br);
      rot(bone.LeftShoulder, Z, -0.04 * br); rot(bone.RightShoulder, Z, 0.04 * br);
      rot(bone.Hips, Z, cfg.sway * sw);
      // greetings
      let roll = 0, yawX = 0, pitchX = 0; doll.position.y = 0;
      if (g && g.kind === 'hello') { roll = 0.34 * env * (lYaw >= 0 ? 1 : -1); pitchX = 0.08 * Math.sin(g.t * 7) * env; }
      if (g && g.kind === 'kick') {
        const s = Math.sin(g.t * 11);
        rot(bone.LeftLeg, X, -0.55 * s * env); rot(bone.RightLeg, X, 0.55 * s * env);
        doll.position.y = 0.025 * Math.abs(Math.sin(g.t * 5.5)) * env; pitchX = -0.06 * env;
      }
      if (g && g.kind === 'shy') {
        yawX = (I.yaw >= 0 ? -1 : 1) * 0.55 * env - I.yaw * env; pitchX = 0.42 * env; roll = 0.12 * env;
        rot(bone.LeftArm, X, -1.15 * env); rot(bone.RightArm, X, -1.15 * env);
        rot(bone.LeftForeArm, X, -0.95 * env); rot(bone.RightForeArm, X, -0.95 * env);
        rot(bone.LeftArm, Y, -0.35 * env); rot(bone.RightArm, Y, 0.35 * env);
      }
      // head: split the turn between neck and head so it reads as a gentle, plush move
      const yaw = I.yaw + yawX, pitch = I.pitch + pitchX;
      rot(bone.neck, Y, yaw * 0.35); rot(bone.Head, Y, yaw * 0.65);
      rot(bone.neck, X, pitch * 0.35); rot(bone.Head, X, pitch * 0.65);
      rot(bone.Head, Z, roll);
      // blink: swap the eye sheet to its closed half for ~0.13 s (double blink now and then; eyes shut while shy)
      if (eyeTex) {
        if ((I.nextBlink -= dt) <= 0) { I.blinkT = 0; I.nextBlink = Math.random() < 0.2 ? 0.28 : rnd(cfg.blinkEvery[0], cfg.blinkEvery[1]); }
        let closed = false;
        if (I.blinkT >= 0) { I.blinkT += dt; closed = I.blinkT < 0.13; if (!closed) I.blinkT = -1; }
        if (g && g.kind === 'shy' && g.t > 0.4 && g.t < g.dur - 0.6) closed = true;
        const ox = closed ? 0.5 : 0; if (eyeTex.offset.x !== ox) { eyeTex.offset.x = ox; eyeTex.updateMatrix(); }
      }
    }
    // F / interact button: one more interactable in dm-birdtemple's list (its F bubble, key and nearest-pick do the rest)
    const ix = { obj: holder, type: 'madison', prompt: 'SAY HI', radius: cfg.ixRadius, pos: new THREE.Vector3(cfg.pos[0], cfg.pos[1], cfg.pos[2]) };
    try {
      if (BTI.ix && !BTI.ix.includes(ix)) BTI.ix.push(ix);
      const act = BTI.act;
      BTI.act = function () { if (BTI.cur === ix) { MAD.greet(); return; } return act.apply(this, arguments); };
    } catch (e) { }
    // tap / click on her (canvas only, never swallows the event: the player carries on)
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), sph = new THREE.Sphere();
    const lbox = new THREE.Box3().setFromObject(doll); const lsph = lbox.getBoundingSphere(new THREE.Sphere());
    holder.updateMatrixWorld(true); const cLocal = holder.worldToLocal(lsph.center.clone()), rLocal = lsph.radius / holder.getWorldScale(new THREE.Vector3()).x;
    window.addEventListener('pointerdown', e => {
      try {
        if (!MAD.active || !e.target || e.target.tagName !== 'CANVAS' || typeof flightCamera === 'undefined' || !flightCamera) return;
        const r = e.target.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, flightCamera);
        sph.center.copy(cLocal); holder.localToWorld(sph.center); sph.radius = rLocal * holder.getWorldScale(_w).x * cfg.tapR;
        if (ray.ray.intersectsSphere(sph)) MAD.greet();
      } catch (err) { }
    }, { passive: true });
    // per-frame driver rides on dm-birdtemple's update (only runs while she walks the ship, and only near the desk)
    const P = new THREE.Vector3(...cfg.pos);
    tick = function (dt) {
      try {
        const L = (typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active) ? SHIP_WALK.localPos : null;
        const near = !!(L && B.scene.visible && Math.abs(L.y - P.y) < cfg.nearY && Math.hypot(L.x - P.x, L.z - P.z) < cfg.near);
        MAD.active = near;
        if (!near) { MAD._waved = false; return; }
        const d = Math.hypot(L.x - P.x, L.z - P.z);
        if (d > cfg.waveAt * 2) MAD._waved = false;
        if (d < cfg.waveAt && !MAD._waved) { MAD._waved = true; MAD.greet('wave'); }
        dt = Math.min(dt, 0.1);
        for (const [b, q] of rest) b.quaternion.copy(q);   // bones the clip doesn't key go back to rest before the offsets
        mixer.update(dt);
        life(dt);
      } catch (e) { if (!MAD._err) { MAD._err = 1; console.warn('[Madison] update', e); } }
    };
    MAD.ready = true;
    console.log('[Madison] doll ready', MAD.hair ? '(strand hair: ' + MAD.hair.meta.count + ' strands)' : '(no hair)');
  }
})();
