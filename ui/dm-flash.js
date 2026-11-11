/* dm-flash.js — Ariel's AR-glasses flashlight (t1472).
   GEOMETRY  a very narrow LED bar on the TOP RIM of her glasses (black casing, white LED strip), a runtime THREE mesh parented to the glasses' bone
             (the glasses frame 'Mesh 1' of characterassests/Meshy_AI_Autumn_biped_Character_output.glb is skinned 100 % to 'Head'). No GLB edit.
             Proportions are read from the frame's own bind-pose vertices once at attach (front face, top of the rim over the bridge, frame width, rim
             band height); the bar is ~1/3 of the frame width (the marked white line in the reference), ~1/8 of the rim band tall. Fallback: the
             measured r-values below (GLB metres: frame 0.153 wide, top rim y 1.6689, front z -0.0133, rim band 0.027).
             Never a collider: not registered with DMCollide, raycast disabled, userData.noCollide.
   LIGHT     one SpotLight (narrow beam, ~12 deg half-angle, soft edge) along the glasses' forward axis, its target ahead of her. NO shadow on any tier
             (a shadow-casting spot is a second shadow map every frame — the hitch we are avoiding on Low). Created on the FIRST switch-on only and
             then kept in the scene with intensity 0 while off (adding / removing a light changes every lit material's light hash and recompiles them:
             once per session, never on each tap). The light lives in her top-level scene (not under the bone) so first person — which hides her
             body and with it everything under it — keeps the beam. Discrete lumen steps STEPS; intensity = lumens x LM_K (the scene's artist light
             scale: 750 lm ~ a lamp-post pool at 6 m, 4000 lm ~ 5x that). Session only: no save keys, nothing in localStorage.
   UI        a custom flashlight icon button (SVG, no text) docked to the RIGHT of the LEFT thumbstick of the current HUD (space #jL, sky
             #atmo-steer-zone, ground #surf-move-zone), bottom-aligned with it, never over it (the stick keeps every touch it had). Tap toggles; while on,
             a vertical stepped lumen bar (5 segments, 4000 top) opens beside the button; tap a segment to pick it. Flat DOM, placed only when the HUD
             changes or the window resizes (no per-frame layout).
   API       DMFlash.attach(CHAR) · DMFlash.tick(mode) (per frame, no allocation) · toggle(on?) · setStep(i) · lumens() · status() · STEPS */
(function (root) {
  'use strict';
  if (root.DMFlash) return;
  const STEPS = [750, 1250, 2000, 3000, 4000];
  const LM_K = 0.35, COLOR = 0xfff4e6;
  // beam profiles (set on the light only when the mode's profile changes: angle / distance / decay / intensity are uniforms, never a recompile).
  // ground = on foot + board in the sky (metre scale): a wide ~31 deg cone that carries ~100 m.  space = open space / near a world (1 unit ~ 4 m, planets
  // tens of units away, she is tiny): the same cone, a far longer reach and a flatter fall-off so a passing planet or ship is lit.
  const PROF = { ground: { angle: 0.55, penumbra: 0.7, distance: 320, decay: 1.5, gain: 1 }, space: { angle: 0.45, penumbra: 0.6, distance: 1500, decay: 1.15, gain: 0.6 } };
  const R = { width: 0.153, top: 1.6689, front: -0.0133, band: 0.027 };   // GLB-measured fallback (metres, bind pose)
  const S = { on: false, step: 2, built: false, led: null, casing: null, strip: null, light: null, target: null, dims: null, mode: '', prof: 'ground', pairs: [], ui: null, dirty: true, wait: 0, err: null };
  const F = { STEPS, S, R, LM_K, PROF };
  root.DMFlash = F;
  let T = null; const _p = { x: 0, y: 0, z: 0 }; let _v = null, _d = null;
  F.lumens = () => STEPS[S.step];
  F.intensityFor = lm => lm * LM_K;

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
    _v = new T.Vector3(); _d = new T.Vector3();
    sync();
    return true;
  };
  // one beam per scene she can be in (flightScene in open space, the world scene on a planet): made BEFORE the first compile of that scene
  // (F.adoptScene from the scene builders) so switching on never changes a light set / recompiles; intensity 0 while off. Only one is ever lit.
  function pairFor(scene) {
    for (let i = 0; i < S.pairs.length; i++) if (S.pairs[i].scene === scene) return S.pairs[i];
    if (!T || !scene) return null;
    const L = new T.SpotLight(COLOR, 0, PROF.ground.distance, PROF.ground.angle, PROF.ground.penumbra, PROF.ground.decay); L.name = 'jots_glasses_flashlight'; L.castShadow = false;
    const t = new T.Object3D(); t.name = 'jots_glasses_flashlight_target'; L.target = t; L.userData.noCollide = true;
    scene.add(L); scene.add(t);
    const P = { scene, L, t, prof: 'ground' }; S.pairs.push(P); if (S.pairs.length > 3) S.pairs.shift();   // closed world scenes fall off the back
    return P;
  }
  F.adoptScene = function (scene) { T = T || root.THREE; return !!pairFor(scene); };
  function ensureLight() {
    if (S.light || !T) return;
    let top = S.led || null; while (top && top.parent) top = top.parent;
    const P = pairFor(top && top.isScene ? top : (S.pairs[0] ? S.pairs[0].scene : null)) || null;
    if (P) { S.light = P.L; S.target = P.t; return; }
    const L = new T.SpotLight(COLOR, 0, PROF.ground.distance, PROF.ground.angle, PROF.ground.penumbra, PROF.ground.decay); L.name = 'jots_glasses_flashlight'; L.castShadow = false;
    const t = new T.Object3D(); t.name = 'jots_glasses_flashlight_target'; L.target = t; S.light = L; S.target = t;   // no scene known yet: tick() parents it
  }
  function applyProf(P, name) {   // uniform-only changes
    const q = PROF[name]; P.prof = name; const L = P.L; L.angle = q.angle; L.penumbra = q.penumbra; L.distance = q.distance; L.decay = q.decay;
  }
  function sync() {   // state -> LED glow / light intensity (no allocation)
    if (S.strip) S.strip.material.color.setScalar(S.on ? 1 : 0.18);
    if (S.on && S.built) ensureLight();
    if (S.light) S.light.intensity = S.on ? F.intensityFor(STEPS[S.step]) * PROF[S.prof].gain : 0;
    ui();
  }
  F.toggle = function (on) { S.on = typeof on === 'boolean' ? on : !S.on; sync(); return S.on; };
  F.setStep = function (i) { i = Math.max(0, Math.min(STEPS.length - 1, i | 0)); S.step = i; sync(); return STEPS[i]; };
  F.status = () => ({ on: S.on, lumens: STEPS[S.step], step: S.step, built: S.built, light: !!S.light, intensity: S.light ? S.light.intensity : 0, shadow: !!(S.light && S.light.castShadow), mode: S.mode, dims: S.dims });

  // per frame: HUD mode change -> re-dock the button; while on, carry the beam with her glasses. No allocation.
  F.tick = function (mode) {
    mode = mode || '';
    if (mode !== S.mode) { S.mode = mode; S.dirty = true; S.wait = 0; }
    if (S.dirty) { if (S.wait > 0) S.wait--; else dock(); }   // a HUD that is not laid out yet is re-measured every ~15 frames, not every frame (getBoundingClientRect allocates)
    if (!S.on || !S.led) { if (!S.on && S.light && S.light.intensity !== 0) S.light.intensity = 0; return; }   // off: never leaves a lit beam behind, whatever the mode
    let top = S.led; while (top.parent) top = top.parent;
    if (!top.isScene) return;   // not in any scene (between worlds): nothing to light
    let P = null; for (let i = 0; i < S.pairs.length; i++) if (S.pairs[i].scene === top) { P = S.pairs[i]; break; }
    if (!P) P = pairFor(top);   // a scene nobody adopted: one-off lazy beam (recompiles that scene once)
    if (!P) return;
    const L = P.L;
    if (S.light !== L) { if (S.light) S.light.intensity = 0; S.light = L; S.target = P.t; }   // she moved scenes: the other beam goes dark
    const pn = mode === 'space' ? 'space' : 'ground';
    if (pn !== S.prof || P.prof !== pn) { S.prof = pn; applyProf(P, pn); }
    const I = F.intensityFor(STEPS[S.step]) * PROF[pn].gain; if (L.intensity !== I) L.intensity = I;
    if (L.parent !== top) { top.add(L); top.add(P.t); }
    const e = S.led.matrixWorld.elements;
    _v.set(e[12], e[13], e[14]); _d.set(e[8], e[9], e[10]).normalize();   // the bar's +Z = the glasses' forward (mirrored with her while riding)
    L.position.copy(_v); P.t.position.set(_v.x + _d.x * 20, _v.y + _d.y * 20, _v.z + _d.z * 20);
    L.updateMatrixWorld(); P.t.updateMatrixWorld();
  };

  // ── UI
  const ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8.2 3.5h7.6l-1.3 4.2H9.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M9.5 7.7h5v11.6a1.2 1.2 0 0 1-1.2 1.2h-2.6a1.2 1.2 0 0 1-1.2-1.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<rect x="11.2" y="11" width="1.6" height="3.4" rx=".8" fill="currentColor"/><path class="fl-ray" d="M5.2 2.6l1.6 1.4M18.8 2.6l-1.6 1.4M12 .6v1.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const CSS = '#dm-flash{position:fixed;left:0;bottom:0;z-index:3505;display:none;pointer-events:none;}' +
    'body:has(#screen-flight.active) #dm-flash[data-m]:not([data-m=""]){display:block;}' +
    '#dm-flash .fl-btn{position:absolute;left:0;bottom:0;width:34px;height:34px;border-radius:50%;padding:0;margin:0;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(6,14,28,.55);border:1px solid rgba(160,210,255,.45);color:#9fc8ee;pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;cursor:pointer;}' +
    '#dm-flash .fl-btn .fl-ray{opacity:0;}' +
    '#dm-flash.on .fl-btn{background:rgba(255,248,230,.16);border-color:#fff6e0;color:#fffaf0;box-shadow:0 0 10px rgba(255,244,214,.45);}#dm-flash.on .fl-btn .fl-ray{opacity:1;}' +
    '#dm-flash .fl-bar{position:absolute;left:37px;bottom:0;width:20px;display:none;flex-direction:column-reverse;gap:3px;padding:3px;box-sizing:border-box;border-radius:7px;' +
    'background:rgba(6,14,28,.6);border:1px solid rgba(160,210,255,.35);pointer-events:auto;touch-action:manipulation;}' +
    '#dm-flash.on .fl-bar{display:flex;}' +
    '#dm-flash .fl-seg{flex:1 1 0;min-height:10px;border-radius:3px;background:rgba(160,200,240,.16);border:0;padding:0;margin:0;cursor:pointer;}' +
    '#dm-flash .fl-seg.lit{background:linear-gradient(to top,#d8e8ff,#fffaf0);box-shadow:0 0 6px rgba(255,246,224,.5);}';
  function build() {
    if (S.ui || !root.document || !document.body) return S.ui;
    if (!document.getElementById('dm-flash-css')) { const st = document.createElement('style'); st.id = 'dm-flash-css'; st.textContent = CSS; document.head.appendChild(st); }
    const w = document.createElement('div'); w.id = 'dm-flash'; w.setAttribute('data-m', '');
    const b = document.createElement('button'); b.className = 'fl-btn'; b.type = 'button'; b.setAttribute('aria-label', 'Glasses flashlight'); b.title = 'Glasses flashlight'; b.innerHTML = ICON;
    const bar = document.createElement('div'); bar.className = 'fl-bar'; bar.setAttribute('role', 'radiogroup'); bar.setAttribute('aria-label', 'Flashlight brightness');
    STEPS.forEach((lm, i) => { const s = document.createElement('button'); s.type = 'button'; s.className = 'fl-seg'; s.setAttribute('data-i', i); s.setAttribute('aria-label', lm + ' lumens'); s.title = lm + ' lm'; bar.appendChild(s); });
    const stop = e => { e.stopPropagation(); };
    b.addEventListener('click', e => { stop(e); F.toggle(); });
    bar.addEventListener('click', e => { stop(e); const t = e.target && e.target.closest && e.target.closest('.fl-seg'); if (t) F.setStep(+t.getAttribute('data-i')); });
    for (const el of [b, bar]) { el.addEventListener('touchstart', stop, { passive: true }); el.addEventListener('mousedown', stop); el.addEventListener('pointerdown', stop); }
    w.appendChild(b); w.appendChild(bar); document.body.appendChild(w);
    S.ui = { w, b, bar, segs: bar.children };
    root.addEventListener('resize', () => { S.dirty = true; S.wait = 0; }); root.addEventListener('orientationchange', () => { S.dirty = true; S.wait = 0; });
    return S.ui;
  }
  function ui() {
    const u = build(); if (!u) return;
    u.w.classList.toggle('on', S.on); u.b.setAttribute('aria-pressed', S.on ? 'true' : 'false');
    for (let i = 0; i < u.segs.length; i++) { u.segs[i].classList.toggle('lit', i <= S.step); u.segs[i].setAttribute('aria-checked', i === S.step ? 'true' : 'false'); }
  }
  const STICK = { space: 'jL', fly: 'atmo-steer-zone', walk: 'surf-move-zone' }, NEXT = ['level-stack'];
  F.STICK = STICK;
  function dock() {   // the button sits just right of the left stick, bottom-aligned; the bar spans the stick's height beside it
    const u = build(); if (!u) return; S.dirty = false;
    const id = STICK[S.mode], z = id && document.getElementById(id);
    if (!z) { u.w.setAttribute('data-m', ''); return; }
    const r = z.getBoundingClientRect();
    if (r.width < 2) { u.w.setAttribute('data-m', ''); S.dirty = true; S.wait = 15; return; }   // its HUD is not laid out yet: try again in ~15 frames
    u.w.setAttribute('data-m', S.mode);
    // the side pads that share the stick row (space: #level-stack sits right of the stick in landscape) push it one slot further right
    let x = r.right + 6;
    for (let i = 0; i < NEXT.length; i++) {
      const e = document.getElementById(NEXT[i]); if (!e || !e.offsetParent) continue; const q = e.getBoundingClientRect();
      if (q.width > 1 && q.left < x + 60 && q.right > x - 2 && q.top < r.bottom && q.bottom > r.top) x = q.right + 6;
    }
    u.w.style.left = Math.round(x) + 'px'; u.w.style.bottom = Math.round(root.innerHeight - r.bottom) + 'px';
    u.bar.style.height = Math.round(Math.max(84, Math.min(110, r.height))) + 'px';
  }
  F._dock = dock;
  if (root.document) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ui()); else ui(); }
})(typeof window !== 'undefined' ? window : globalThis);
