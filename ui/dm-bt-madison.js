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
 * No lights, no shadows, compiled hidden at load + registered with DMWarm. Tuning: window.BTE.madison.cfg.
 */
(function () {
  'use strict';
  const URL_GLB = 'assets/bt-engineering/madison.glb?v=1', URL_HAIR = 'assets/bt-engineering/madison_hair.bin?v=1';
  const cfg = {
    // seat on the desk, temple glTF frame (= Blender (-6.55, 90.93, -20.75) → glTF (x, z, -y)); doll units → temple units
    pos: [-6.55, -20.75, -90.93], yaw: -0.24, scale: 1.1, seatDrop: 0.29,
    near: 14, nearY: 5, waveAt: 4.5, selfLight: 0.14, hair: true,
    hairParams: { bodyColliders: false, widthRoot: 0.009, widthTip: 0.004, hairRadius: 0.012, gravity: 5.0, maxRootStep: 0.03 },
  };
  const MAD = { cfg, ready: false, root: null, mixer: null, hair: null, actions: {}, active: false };
  function boot() {
    const B = window.BTE;
    if (!(B && B.ready && B.scene && window.THREE && THREE.GLTFLoader)) return false;
    B.madison = MAD; init(B).catch(e => console.warn('[Madison] init', e)); return true;
  }
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
        if (/^MAD_(Suit|Skin|Mitten|Scalp|Lash|Zip|Eye)/.test(m.name) && m.emissive) {   // night-dim deck: a touch of self light
          m.emissive.setRGB(1, 1, 1); m.emissiveMap = m.map || null; m.emissiveIntensity = m.map ? cfg.selfLight : 0;
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
    B.scene.add(holder); holder.updateMatrixWorld(true);
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
    // per-frame driver rides on dm-birdtemple's update (only runs while she walks the ship)
    const P = new THREE.Vector3(...cfg.pos);
    const up = BTI.update;
    BTI.update = function (dt) {
      up(dt);
      try {
        const L = (typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active) ? SHIP_WALK.localPos : null;
        const near = !!(L && B.scene.visible && Math.abs(L.y - P.y) < cfg.nearY && Math.hypot(L.x - P.x, L.z - P.z) < cfg.near);
        MAD.active = near;
        if (!near) { MAD._waved = false; return; }
        const d = Math.hypot(L.x - P.x, L.z - P.z);
        if (d > cfg.waveAt * 2) MAD._waved = false;
        if (wave && d < cfg.waveAt && !MAD._waved) { MAD._waved = true; wave.reset().play(); if (sit) wave.crossFadeFrom(sit, 0.35, false); }
        mixer.update(Math.min(dt, 0.1));
      } catch (e) { if (!MAD._err) { MAD._err = 1; console.warn('[Madison] update', e); } }
    };
    MAD.ready = true;
    console.log('[Madison] doll ready', MAD.hair ? '(strand hair: ' + MAD.hair.meta.count + ' strands)' : '(no hair)');
  }
  let n = 0; const t = setInterval(() => { n++; if (boot() || n > 900) clearInterval(t); }, 800);
})();
