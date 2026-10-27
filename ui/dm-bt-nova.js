/* dm-bt-nova.js — Nova Rustveil: a ball-jointed art doll on her own stool beside Madison's desk (Bird Temple, deck C engineering office).
 *
 * Art: assets/bt-engineering/nova.glb (skinned, same 20 joint names as Madison, ~8.3k tris incl. stool, actions Sit / Wave,
 *      meshopt + webp), built by assets/blender/bt-engineering/build_nova.py (+ make_nova_textures.py). Doll units are 1.0 tall
 *      and she is scaled ×2.2 here, so she stands about twice Madison (1.0 × 1.1).
 * Same pipeline as dm-bt-madison.js: lazy fetch on boarding (bte:ready → BTI.update hook), FX_ names (never walk collision),
 * compiled + DMWarm-registered before shown, BTL.apply for the interior light list, no lights added. Per frame: nothing unless
 * Ariel is aboard and within cfg.near; then one AnimationMixer.update + a small bone-offset layer (preallocated, no garbage).
 * Tuning: window.BTE.nova.cfg.
 */
(function () {
  'use strict';
  const URL_GLB = 'assets/bt-engineering/nova.glb?v=1';
  const cfg = {
    // stool on open floor just right of Madison's desk, clear of the drawer pedestal (desk x −8.4…−4.6), temple glTF frame (= Blender (-3.55, 90.2, -22.5) → glTF (x, z, -y)); turned toward Madison
    pos: [-3.55, -22.5, -90.2], yaw: -0.9, scale: 2.2,
    near: 14, nearY: 5, waveAt: 4.0, ixRadius: 6, ixZoneM: 2.0, ixAimM: 0.5, tapR: 1.1,
    breath: 0.05, sway: 0.03, headYaw: 0.4, headPitch: 0.1, turnEvery: [2.4, 5.2], blinkEvery: [2.0, 4.8], footTap: 0.12, shardGlow: 1.8, hairGlow: 0.22, skinGlow: 0.2, stoolGlow: 0.35,
  };
  const NOVA = { cfg, ready: false, root: null, mixer: null, actions: {}, active: false };
  let hooked = false, loading = false, tick = null;
  function hook() {
    const B = window.BTE;
    if (hooked || !(B && B.ready && B.scene && window.BTI && window.THREE && THREE.GLTFLoader)) return;
    hooked = true; B.nova = NOVA;
    const up = BTI.update;
    BTI.update = function (dt) {
      up(dt);
      if (tick) { tick(dt); return; }
      if (loading) return;
      const aboard = (typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active) || (BTI._depth || 0) > 0.01;
      if (aboard) { loading = true; init(B).catch(e => console.warn('[Nova] init', e)); }
    };
  }
  window.addEventListener('bte:ready', hook);
  hook();
  async function init(B) {
    const L = new THREE.GLTFLoader();
    try { const m = await import('three/addons/libs/meshopt_decoder.module.js'); L.setMeshoptDecoder(m.MeshoptDecoder); } catch (e) { }
    const gltf = await L.loadAsync(URL_GLB);
    const doll = gltf.scene; doll.name = 'FX_BTE_Nova';
    const holder = new THREE.Group(); holder.name = 'FX_BTE_NovaSeat';
    holder.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
    holder.rotation.y = cfg.yaw; holder.scale.setScalar(cfg.scale);
    holder.add(doll);
    const seen = new Set(); let faceTex = null;
    doll.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false;
      if (o.name) o.name = 'FX_' + o.name;
      for (const m of [o.material].flat()) {
        if (!m || seen.has(m)) continue; seen.add(m);
        const n = m.name || '';
        if (n === 'NOVA_Face' && m.map) { faceTex = m.map; if (m.emissive) { m.emissive.setRGB(1, 0.62, 0.45); m.emissiveMap = m.map; m.emissiveIntensity = cfg.skinGlow; m.roughness = 0.5; } }
        else if (n === 'NOVA_Skin' || n === 'NOVA_Wood') { if (n === 'NOVA_Skin') { m.color.multiplyScalar(0.94).offsetHSL(0, 0.06, 0); if (m.emissive) { m.emissive.copy(m.color).multiplyScalar(0.9); m.emissiveIntensity = cfg.skinGlow; } } if ('clearcoat' in m) { m.clearcoat = n === 'NOVA_Wood' ? 0.5 : 0.15; m.clearcoatRoughness = 0.35; } }
        else if (n === 'NOVA_Leather' || n === 'NOVA_Torso') { if ('clearcoat' in m) { m.clearcoat = 0.6; m.clearcoatRoughness = 0.25; } }
        else if (n === 'NOVA_Hair') {
          m.side = THREE.DoubleSide; m.alphaTest = 0.1; m.transparent = false; m.depthWrite = true;
          if (m.emissive) { m.emissive.setRGB(1, 0.45, 0.18); if (m.map) m.emissiveMap = m.map; m.emissiveIntensity = cfg.hairGlow; }   // faint copper self-glow so the hair reads orange under the purple office light   // low cutoff: mip-averaged strand alpha must not drop below it at distance
          if ('sheen' in m) { m.sheen = 0.6; m.sheenRoughness = 0.4; m.sheenColor && m.sheenColor.setRGB(1, 0.6, 0.35); }
        }
        else if (n === 'NOVA_Stool') { if (m.emissive) { m.emissive.setRGB(0.9, 0.55, 0.3); m.emissiveIntensity = cfg.stoolGlow; } }   // warm lacquer so the stool reads in the dark office
        else if (n === 'NOVA_Visor') {
          m.transparent = true; m.depthWrite = false; m.opacity = Math.min(m.opacity == null ? 0.22 : m.opacity, 0.25); m.roughness = 0.04;
          if ('clearcoat' in m) { m.clearcoat = 1; m.clearcoatRoughness = 0.02; }
        }
        else if (n === 'NOVA_Shard') {
          if (m.emissive) { m.emissive.setRGB(1, 0.06, 0.04); m.emissiveIntensity = cfg.shardGlow; } m.roughness = 0.08;
          if ('clearcoat' in m) { m.clearcoat = 1; m.clearcoatRoughness = 0.02; }
        }
      }
    });
    const headBone = doll.getObjectByName('Head'); if (headBone) headBone.position.y -= 0.02;   // shorter neck (Head has no position tracks)
    const mixer = new THREE.AnimationMixer(doll); NOVA.mixer = mixer;
    for (const c of gltf.animations) NOVA.actions[c.name] = mixer.clipAction(c);
    const sit = NOVA.actions.Sit, wave = NOVA.actions.Wave;
    if (sit) sit.play();
    if (wave) { wave.setLoop(THREE.LoopOnce, 1); wave.clampWhenFinished = false; }
    mixer.update(0);
    mixer.addEventListener('finished', e => { if (e.action === wave && sit) { sit.reset().play(); sit.crossFadeFrom(wave, 0.4, false); } });
    holder.updateMatrixWorld(true);
    NOVA.root = holder;
    const warm = async () => {
      if (typeof _dmCompileObject !== 'function') return;
      try { if (window.BTL && BTL.apply) BTL.apply(holder, true); } catch (e) { }
      await _dmCompileObject(holder);
    };
    try { if (window.DMWarm && DMWarm.add) DMWarm.add('Nova doll', warm); } catch (e) { }
    try { await warm(); } catch (e) { }
    B.scene.add(holder); holder.updateMatrixWorld(true);
    // ───────── procedural layer: idle life + greetings ─────────
    const bone = {}; doll.traverse(o => { if (o.isBone) bone[o.name] = o; });
    const rest = new Map(); for (const k in bone) rest.set(bone[k], bone[k].quaternion.clone());
    if (faceTex) { faceTex.matrixAutoUpdate = true; faceTex.offset.set(0, 0); faceTex.updateMatrix(); }
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
    const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _ax = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
    function rot(b, axis, ang) {
      if (!b || !ang) return;
      doll.getWorldQuaternion(_rq); b.parent.getWorldQuaternion(_pq);
      _ax.copy(axis).applyQuaternion(_rq).applyQuaternion(_pq.invert());
      b.quaternion.premultiply(_q.setFromAxisAngle(_ax, ang));
    }
    const rnd = (a, b) => a + Math.random() * (b - a), sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const I = { t: 0, yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, nextTurn: 1.2, lookAriel: 0, blinkT: -1, nextBlink: 2.5, g: null, last: '', tapT: 0 };
    NOVA.idle = I;
    let charHead = null;
    function arielHead(out) {
      try {
        if (typeof CHAR === 'undefined' || !CHAR.root) return null;
        if (charHead === null) charHead = CHAR.root.getObjectByName('Head') || CHAR.root.getObjectByName('mixamorig:Head') || CHAR.root.getObjectByName('mixamorigHead') || false;
        if (charHead) return charHead.getWorldPosition(out);
        return CHAR.root.getWorldPosition(out).add(_w.set(0, 1.6 * CHAR.root.getWorldScale(_v).y, 0));
      } catch (e) { return null; }
    }
    const GREET = ['hello', 'wave', 'shrug'];
    NOVA.greet = function (kind) {
      if (I.g && I.g.t < I.g.dur * 0.7) return false;
      if (!kind) { const pool = GREET.filter(k => k !== I.last); kind = pool[(Math.random() * pool.length) | 0]; }
      I.last = kind; I.g = { kind, t: 0, dur: kind === 'wave' ? 2.4 : kind === 'shrug' ? 2.0 : 2.6 };
      if (kind === 'wave' && wave) { wave.reset().play(); if (sit) wave.crossFadeFrom(sit, 0.3, false); }
      if (kind === 'hello') I.blinkT = 0.5;
      try { if (typeof sfx !== 'undefined' && sfx.chirp) sfx.chirp(); } catch (e) { }
      return true;
    };
    function life(dt) {
      I.t += dt; const t = I.t, g = I.g;
      if (g) { g.t += dt; if (g.t >= g.dur) I.g = null; }
      const env = g ? sm(0, 0.35, g.t) * (1 - sm(g.dur - 0.45, g.dur, g.t)) : 0;
      if ((I.nextTurn -= dt) <= 0) {
        I.nextTurn = rnd(cfg.turnEvery[0], cfg.turnEvery[1]);
        I.lookAriel = Math.random() < 0.4 ? 1 : 0;
        I.tYaw = rnd(-cfg.headYaw, cfg.headYaw); I.tPitch = rnd(-cfg.headPitch, cfg.headPitch * 0.6);
        I.tapT = Math.random() < 0.5 ? 2.5 : 0;            // a short foot-tap now and then
      }
      let lYaw = 0, lPitch = 0; const hp = arielHead(_v);
      if (hp && bone.Head) {
        doll.worldToLocal(hp); bone.Head.getWorldPosition(_w); doll.worldToLocal(_w); hp.sub(_w);
        lYaw = Math.max(-1.0, Math.min(1.0, Math.atan2(hp.x, hp.z)));
        lPitch = Math.max(-0.5, Math.min(0.25, -Math.atan2(hp.y, Math.hypot(hp.x, hp.z))));
      }
      const wLook = Math.max(I.lookAriel * 0.85, env);
      const k = Math.min(1, dt * 3.0);
      I.yaw += ((I.tYaw * (1 - wLook) + lYaw * wLook) - I.yaw) * k;
      I.pitch += ((I.tPitch * (1 - wLook) + lPitch * wLook) - I.pitch) * k;
      const br = Math.sin(t * 1.6), sw = Math.sin(t * 0.61);
      rot(bone.Spine01, X, -cfg.breath * 0.5 * br);
      rot(bone.Spine, X, -cfg.breath * 0.5 * br);
      rot(bone.LeftShoulder, Z, -0.035 * br); rot(bone.RightShoulder, Z, 0.035 * br);
      rot(bone.Hips, Z, cfg.sway * sw); rot(bone.Spine02, Y, 0.04 * Math.sin(t * 0.37));
      if (I.tapT > 0) { I.tapT -= dt; rot(bone.RightFoot, X, -cfg.footTap * Math.max(0, Math.sin(t * 9)) * sm(0, 0.3, I.tapT)); }
      let roll = 0, pitchX = 0;
      if (g && g.kind === 'hello') {   // head tilt + look up at Ariel, a little nod
        roll = 0.3 * env * (lYaw >= 0 ? 1 : -1); pitchX = -0.18 * env + 0.06 * Math.sin(g.t * 6) * env;
        rot(bone.Spine, X, -0.08 * env);
      }
      if (g && g.kind === 'shrug') {   // shoulders up, palms out, small head tilt
        const s = Math.sin(Math.min(1, g.t / g.dur) * Math.PI);
        rot(bone.LeftShoulder, Z, 0.22 * s); rot(bone.RightShoulder, Z, -0.22 * s);
        rot(bone.LeftForeArm, Y, 0.6 * s); rot(bone.RightForeArm, Y, -0.6 * s);
        roll = -0.15 * s;
      }
      const yaw = I.yaw, pitch = I.pitch + pitchX;
      rot(bone.neck, Y, yaw * 0.35); rot(bone.Head, Y, yaw * 0.65);
      rot(bone.neck, X, pitch * 0.35); rot(bone.Head, X, pitch * 0.65);
      rot(bone.Head, Z, roll);
      if (faceTex) {
        if ((I.nextBlink -= dt) <= 0) { I.blinkT = 0; I.nextBlink = Math.random() < 0.2 ? 0.3 : rnd(cfg.blinkEvery[0], cfg.blinkEvery[1]); }
        let closed = false;
        if (I.blinkT >= 0) { I.blinkT += dt; closed = I.blinkT < 0.12; if (!closed) I.blinkT = -1; }
        const ox = closed ? 0.5 : 0; if (faceTex.offset.x !== ox) { faceTex.offset.x = ox; faceTex.updateMatrix(); }
      }
    }
    const ix = { obj: holder, type: 'nova', prompt: 'SAY HI', radius: cfg.ixRadius, zone: 'aim', zoneM: cfg.ixZoneM, aimM: cfg.ixAimM, pos: new THREE.Vector3(cfg.pos[0], cfg.pos[1] + 1.2, cfg.pos[2]) };
    try {
      if (BTI.ix && !BTI.ix.includes(ix)) BTI.ix.push(ix);
      const act = BTI.act;
      BTI.act = function () { if (BTI.cur === ix) { NOVA.greet(); return; } return act.apply(this, arguments); };
    } catch (e) { }
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), sph = new THREE.Sphere();
    const lsph = new THREE.Box3().setFromObject(doll).getBoundingSphere(new THREE.Sphere());
    holder.updateMatrixWorld(true); const cLocal = holder.worldToLocal(lsph.center.clone()), rLocal = lsph.radius / holder.getWorldScale(new THREE.Vector3()).x;
    window.addEventListener('pointerdown', e => {
      try {
        if (!NOVA.active || !e.target || e.target.tagName !== 'CANVAS' || typeof flightCamera === 'undefined' || !flightCamera) return;
        const r = e.target.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, flightCamera);
        sph.center.copy(cLocal); holder.localToWorld(sph.center); sph.radius = rLocal * holder.getWorldScale(_w).x * cfg.tapR;
        if (ray.ray.intersectsSphere(sph)) NOVA.greet();
      } catch (err) { }
    }, { passive: true });
    const P = new THREE.Vector3(...cfg.pos);
    tick = function (dt) {
      try {
        const L = (typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active) ? SHIP_WALK.localPos : null;
        const near = !!(L && B.scene.visible && Math.abs(L.y - P.y) < cfg.nearY && Math.hypot(L.x - P.x, L.z - P.z) < cfg.near);
        NOVA.active = near;
        if (!near) { NOVA._waved = false; return; }
        const d = Math.hypot(L.x - P.x, L.z - P.z);
        if (d > cfg.waveAt * 2) NOVA._waved = false;
        if (d < cfg.waveAt && !NOVA._waved) { NOVA._waved = true; NOVA.greet('hello'); }
        dt = Math.min(dt, 0.1);
        for (const [b, q] of rest) b.quaternion.copy(q);
        mixer.update(dt);
        life(dt);
      } catch (e) { if (!NOVA._err) { NOVA._err = 1; console.warn('[Nova] update', e); } }
    };
    NOVA.ready = true;
    console.log('[Nova] doll ready');
  }
})();
