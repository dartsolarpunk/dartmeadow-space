/* ============================================================================
   ui/dm-charselect.js — CHARACTER SELECT: card wheel + one-canvas 3D studio.            Flow: main menu -> CHARACTER -> SKYBOARD BUILDER -> game.
   Data comes from DMChars (ui/dm-chars.js): one registry entry per character.  This file never names a character.

   Budget rules (menus must be light):
     * ONE WebGPURenderer, on a fresh canvas, only while a studio is open or a thumbnail is being captured; disposed when the last lease is returned.
     * Cards show a small bust STILL rendered from the real 3D asset (real GLB + strand hair), captured once, cached in memory and in localStorage
       (dm_char_thumb_v1) so later sessions do not load the models at all just to draw the list.
     * The studio loop runs only while the studio is open and the tab is visible, capped at 30 fps; nothing runs per frame for the card list.
     * Leaving the studio disposes the model (geometry, materials, textures, hair, mixer), the scene helpers and the renderer.
   API: DMCharSelect.enter() / .leave() (called by goScreen), .openStudio(id), .closeStudio(), .panels (extension point: colours, logos), .status()
   ========================================================================== */
(function () {
  'use strict';
  if (window.DMCharSelect) return;
  const W = window, D = document, $ = (id) => D.getElementById(id);
  const CS = W.DMCharSelect = { panels: [], studioOpen: false, entered: false };
  /* card UI state machine: CSS hinges do the motion; this only flips classes (no per-frame work, no allocations in the studio loop).
     modes: idle (off-screen) | select (wheel + continue pop-out) | editor (taller card) | leaving */
  const UI = { mode: 'idle', pickedId: null };
  function uiMachine(state, ev) {
    const s = { mode: state.mode, pickedId: state.pickedId || null };
    switch (ev && ev.type) {
      case 'enter': s.mode = 'select'; s.pickedId = ev.pickedId || s.pickedId; break;
      case 'pick': if (s.mode !== 'editor' && s.mode !== 'leaving') s.mode = 'select'; s.pickedId = ev.id || s.pickedId; break;
      case 'edit': if (ev.id) s.pickedId = ev.id; s.mode = 'editor'; break;
      case 'back': s.mode = 'select'; break;
      case 'leave': s.mode = 'leaving'; break;
      case 'idle': s.mode = 'idle'; break;
    }
    return s;
  }
  function uiApply(next) {
    if (next) { UI.mode = next.mode; UI.pickedId = next.pickedId || null; }
    const sc = $('screen-character'), cont = $('cs-continue');
    if (sc) { sc.classList.toggle('cs-ui-select', UI.mode === 'select'); sc.classList.toggle('cs-ui-editor', UI.mode === 'editor'); }
    if (cont) {
      const show = UI.mode === 'select' && !!UI.pickedId;
      if (cont.hidden === show) {
        cont.hidden = !show;
        if (show) { try { void cont.offsetWidth; } catch (e) { } cont.classList.add('cs-pop'); }
        else cont.classList.remove('cs-pop');
      }
    }
  }
  CS.uiMachine = uiMachine; CS.uiState = () => ({ mode: UI.mode, pickedId: UI.pickedId });
  const THUMB_KEY = 'dm_char_thumb_v1', THUMB_VER = 1, TW = 200, TH = 250;
  const log = (...a) => { try { console.info('[charselect]', ...a); } catch (e) { } };
  const toast = (m, d) => { try { W.toast && W.toast(m, d || 2600); } catch (e) { } };
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ST = () => { try { return (typeof STATE !== 'undefined' && STATE.screen) || ''; } catch (e) { return ''; } };

  /* ───────────────────────── thumbnails (cache) ───────────────────────── */
  let thumbs = {};   // id -> { sig, url }
  try { const t = JSON.parse(localStorage.getItem(THUMB_KEY) || 'null'); if (t && t.v === THUMB_VER && t.t) thumbs = t.t; } catch (e) { thumbs = {}; }
  const thumbSig = (def) => def.id + '|' + (W.DMChars && W.DMChars.lookSig ? W.DMChars.lookSig(def.id) : '');
  function saveThumbs() { try { localStorage.setItem(THUMB_KEY, JSON.stringify({ v: THUMB_VER, t: thumbs })); } catch (e) { /* quota: the in-memory copy still serves this session */ } }
  const thumbFor = (def) => { const t = thumbs[def.id]; return t && t.sig === thumbSig(def) ? t.url : (t ? t.url : null); };   // a stale still beats an empty card; it is refreshed in the background

  /* ───────────────────────── the one renderer (leased) ───────────────────────── */
  const R = { r: null, canvas: null, leases: 0, making: null, killT: 0 };
  async function acquire(host) {
    clearTimeout(R.killT); R.leases++;
    if (!R.r) {
      if (!R.making) R.making = (async () => {
        const THREE = W.THREE; if (!THREE || !THREE.WebGPURenderer) throw new Error('THREE not ready');
        const cv = D.createElement('canvas'); cv.id = 'cs-canvas';
        const r = new THREE.WebGPURenderer({ canvas: cv, antialias: true, alpha: true });
        await r.init();
        r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0; r.setClearColor(0x000000, 0);
        r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
        R.r = r; R.canvas = cv; return r;
      })().finally(() => { R.making = null; });
      try { await R.making; } catch (e) { R.leases--; throw e; }
    } else if (R.making) { try { await R.making; } catch (e) { R.leases--; throw e; } }
    if (host && R.canvas && R.canvas.parentNode !== host) host.insertBefore(R.canvas, host.firstChild);
    return R.r;
  }
  function release() {
    R.leases = Math.max(0, R.leases - 1);
    if (R.leases > 0) return;
    clearTimeout(R.killT);
    R.killT = setTimeout(() => {   // a short grace: studio close -> thumbnail refresh reuses the device
      if (R.leases > 0 || !R.r) return;
      try { R.r.dispose(); } catch (e) { }
      try { if (R.canvas && R.canvas.parentNode) R.canvas.parentNode.removeChild(R.canvas); } catch (e) { }
      R.r = null; R.canvas = null; log('renderer disposed');
    }, 900);
  }

  /* ───────────────────────── a character in a scene ───────────────────────── */
  const gltfLoad = (url, onP) => new Promise((res, rej) => {
    const L = new W.THREE.GLTFLoader(); L.load(url, res, (x) => { try { if (onP && x.lengthComputable) onP(x.loaded / x.total); } catch (e) { } }, rej);
  });
  function disposeTree(root) {
    const seen = new Set();
    const tex = (m) => { for (const k in m) { const v = m[k]; if (v && v.isTexture && !seen.has(v)) { seen.add(v); try { v.dispose(); } catch (e) { } if (v.image && v.image.close) { try { v.image.close(); } catch (e) { } } } } };
    root.traverse((o) => {
      if (o.geometry && o.geometry.dispose) { try { o.geometry.dispose(); } catch (e) { } }
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach((m) => { if (m) { tex(m); try { m.dispose(); } catch (e) { } } });
    });
  }
  // the player's colours (+ logos in Phase 3) on a model: the same ui/dm-charpaint.js the game runs after its own load
  function applyLook(M, def, look) {   // look: the stored look unless a preview look (stored + a pending logo) is passed
    if (!M || !M.root || !W.DMCharPaint || !W.DMChars) return; const L = look || W.DMChars.look(def.id);
    try { W.DMCharPaint.apply(M.root, def, L, W.THREE); } catch (e) { log('paint', e && e.message); }
    try { if (M.hair) W.DMCharPaint.applyHair(M.hair, def, L); } catch (e) { log('hair look', e && e.message); }
  }
  // the character exactly as the game loads it (same GLB, same bone map), plus the studio's idle / wave clips and strand hair.  Everything it makes is owned here.
  async function buildCharacter(def, o) {
    const THREE = W.THREE, M = { def, root: null, bones: {}, mixer: null, actions: {}, hair: null, dead: false, extras: [], disposables: [] };
    const gltf = await gltfLoad(def.mesh, o.onProgress);
    M.root = gltf.scene; M.root.traverse((n) => { if (n.isBone || n.type === 'Bone') M.bones[n.name] = n; if (n.isSkinnedMesh) { n.frustumCulled = false; } });
    if (def.materialFix === 'meshy') meshyMaterialFix(M.root);   // the game's own fixes for her Meshy materials (see index.html loadCharacterAssets)
    M.root.updateMatrixWorld(true);
    M.mixer = new THREE.AnimationMixer(M.root);
    if (o.anims) {
      try {
        const ag = await gltfLoad(def.anims);
        const clip = (n) => ag.animations.find((a) => a.name === n);
        const idle = clip(def.studio.idle) || clip('Idle_Breathe_Blink');
        if (idle) { const a = M.mixer.clipAction(idle); a.setLoop(THREE.LoopRepeat, Infinity); a.play(); M.actions.idle = a; }
        for (const n of def.studio.extras || []) { const c = clip(n); if (c) { const a = M.mixer.clipAction(c); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; M.extras.push(a); } }
      } catch (e) { log('animations failed', e && e.message); }
    }
    if (o.hair !== false) {
      try {
        const mod = await import(W.DM_HAIR_MODULE || new URL('hair_strands.js?v=383', D.baseURI).href);
        let cfg; if (def.hair.configUrl) { const r = await fetch(def.hair.configUrl); if (r.ok) cfg = await r.json(); }
        const CHAR = { root: M.root, bones: M.bones, mixer: M.mixer };
        M.charLike = CHAR;
        M.hair = await mod.attachHairStrands(CHAR, THREE, { url: def.hair.url, config: cfg, character: !!cfg, getStrandFraction: () => (o.strandFraction || 0.6),
          // (t1644u) the studio is a static, 30 fps-capped scene, so it no longer runs the lowest collision tier: High (fitted body / shirt / glasses capsules +
          // keep-out boxes, capsules every pass, segment-midpoint tessellation) with 20-point strands (resampled once at load, 4 solver passes) so the hair
          // drapes over her scalp, skin and clothes instead of through them.  Phones / tablets below High keep the file's points at tier 1 (the 20-point
          // solve costs ~2.3x the guide solver; tools/tests/hair-collision.js has the numbers).  ?hairseg=N / ?hairtier=N override.
          segments: () => hairStudioQ().seg, getCollisionTier: () => hairStudioQ().tier, getCalm: () => !!(CS.studioOpen && S.dragging), params: { autoQuality: false } });
        if (M.dead) { try { M.hair.dispose(); } catch (e) { } M.hair = null; }
      } catch (e) { log('hair not attached', e && e.message); }
    }
    applyLook(M, def);
    try { if (W.DMCharLook) W.DMCharLook.apply(M.root, { THREE, env: 'studio' }); } catch (e) { log('charlook', e && e.message); }   // (ui/dm-charlook.js) smooth normals + soft sky / rim / matcap look, studio env; ?charlook=off|low|high
    try { if (W.DMMenuWorld && W.DMMenuWorld.protectHair) W.DMMenuWorld.protectHair(M.root); } catch (e) {}
    M.root.traverse((n) => { if (n.isMesh || n.isSkinnedMesh) { n.castShadow = !/hair|strand/i.test(n.name || ''); n.receiveShadow = !/hair|strand/i.test(n.name || ''); if (n.isSkinnedMesh) n.frustumCulled = false; } });
    return M;
  }
  function hairStudioQ() {
    const q = W.location ? W.location.search || '' : '', ms = /[?&]hairseg=(\d+)/.exec(q), mt = /[?&]hairtier=(\d)/.exec(q);
    let pre = 'medium'; try { pre = typeof W.resolvePreset === 'function' ? W.resolvePreset() : ((W.GFX && W.GFX.preset) || 'medium'); } catch (e) { }
    const mob = !!(W.GFX && W.GFX.isMobile) || /Android|iPhone|iPad/i.test((W.navigator && W.navigator.userAgent) || ''), hi = pre === 'high' || pre === 'ultra';
    const full = !mob || hi;
    return { seg: ms ? +ms[1] : (full ? 20 : 0), tier: mt ? Math.min(2, +mt[1]) : (full ? 2 : 1) };
  }
  CS.hairStudioQ = hairStudioQ;
  function meshyMaterialFix(root) {   // mirrors loadCharacterAssets: a metalness-1 default made her near black without an env map; vertex-coloured skin gets a warm floor
    const seen = new Set();
    root.traverse((o) => {
      if (!(o.isMesh || o.isSkinnedMesh)) return; const vc = !!(o.geometry && o.geometry.attributes && o.geometry.attributes.color);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (!m || seen.has(m)) return; seen.add(m);
        if (m.metalness !== undefined && !m.metalnessMap && m.metalness > 0.9) { m.metalness = 0.08; m.roughness = 0.55; }
        if (vc && m.emissive) { m.emissive.setRGB(0.16, 0.095, 0.075); m.emissiveIntensity = 1; }
        m.needsUpdate = true;
      });
    });
  }
  function disposeCharacter(M) {
    if (!M || M.dead) return; M.dead = true;
    try { if (M.hair) M.hair.dispose(); } catch (e) { }
    try { if (M.mixer) { M.mixer.stopAllAction(); M.mixer.uncacheRoot(M.root); } } catch (e) { }
    try { if (M.root) { if (M.root.parent) M.root.parent.remove(M.root); disposeTree(M.root); } } catch (e) { }
    M.root = null; M.actions = {}; M.extras = [];
  }

  // the studio set: a rust-dust pad with a few rocks, a warm key, a cool rim.  A handful of draw calls, no shadow maps.
  function buildSet(opaque) {
    const THREE = W.THREE, S = new THREE.Scene(); if (opaque) S.background = new THREE.Color(0x120c1c);
    const items = [];
    let key, rim;
    if (W.DMCharLook && W.DMCharLook.tier() !== 'off') { const rg = W.DMCharLook.rigStudio(S, THREE); key = rg.key; rim = rg.rim; }   // (ui/dm-charlook.js) warm key upper front-left, cool rim behind, warm bounce below + the matching studio env
    else {
      S.add(new THREE.HemisphereLight(0x9aa6d8, 0x3a1c14, 0.9));
      key = new THREE.DirectionalLight(0xffd7a8, 2.6); key.position.set(1.6, 2.6, 2.4); S.add(key);
      rim = new THREE.DirectionalLight(0x6a8cff, 1.9); rim.position.set(-2.2, 1.6, -2.0); S.add(rim);
      const fill = new THREE.DirectionalLight(0xff9a70, 0.5); fill.position.set(-1.5, 0.4, 1.8); S.add(fill);
    }
    const pad = new THREE.Mesh(new THREE.CircleGeometry(1.35, 40), new THREE.MeshStandardMaterial({ color: 0x4a2418, roughness: 0.96, metalness: 0 })); pad.rotation.x = -Math.PI / 2; pad.userData.dmSet = 1; S.add(pad); items.push(pad);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.27, 1.31, 64), new THREE.MeshBasicMaterial({ color: 0x5b7fff, transparent: true, opacity: 0.85, toneMapped: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; ring.userData.dmSet = 1; S.add(ring); items.push(ring);
    let sd = 7; const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    const rm = new THREE.MeshStandardMaterial({ color: 0x5b2f20, roughness: 0.98, flatShading: true }); items.push(rm);
    for (let i = 0; i < 7; i++) {
      const a = 2.3 + i * 0.52 + rnd() * 0.25, d = 0.95 + rnd() * 0.3, r = 0.05 + rnd() * 0.11;
      const g = new THREE.IcosahedronGeometry(r, 0), m = new THREE.Mesh(g, rm); m.position.set(Math.cos(a) * d, r * 0.45, -Math.sin(a) * d * 0.9 - 0.15); m.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6); m.scale.set(1, 0.7, 1.1); m.userData.dmSet = 1; S.add(m); items.push(g);
    }
    return { scene: S, items, key, rim };
  }
  function disposeSet(X) { if (!X) return; X.items.forEach((o) => { try { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); if (o.dispose) o.dispose(); } catch (e) { } }); }

  // camera framing from the model itself (no per-character numbers in the registry unless it wants an override)
  function frame(M, aspect, mode) {
    const THREE = W.THREE, box = new THREE.Box3().setFromObject(M.root), H = Math.max(0.5, box.max.y - box.min.y), fov = 30, th = Math.tan(fov * Math.PI / 360);
    const out = { H, fov, minY: box.min.y };
    if (mode === 'bust') {
      const head = M.bones.Head ? M.bones.Head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, box.min.y + H * 0.88, 0), half = 0.3;   // ~0.6 m of her: head + shoulders
      out.target = new THREE.Vector3(0, head.y - 0.07, 0); out.dist = Math.max(half / th, (0.27 / aspect) / th); out.camY = out.target.y + 0.02;
    } else {
      out.target = new THREE.Vector3(0, box.min.y + H * 0.5, 0); out.dist = Math.max((H * 0.62) / th, (0.62 / aspect) / th); out.camY = out.target.y + H * 0.04;
    }
    return out;
  }

  /* ───────────────────────── thumbnail capture (one at a time, studio has priority) ───────────────────────── */
  let thumbJob = null, thumbAbort = false, thumbBusy = false;
  async function captureThumb(def) {
    const THREE = W.THREE; let M = null, X = null, leased = false;
    try {
      const r = await acquire(null); leased = true;
      X = buildSet(true); M = await buildCharacter(def, { anims: false, hair: true, strandFraction: 0.5 });
      if (thumbAbort) return false;
      X.scene.add(M.root); M.root.position.y = -new THREE.Box3().setFromObject(M.root).min.y; M.root.updateMatrixWorld(true);
      const cam = new THREE.PerspectiveCamera(30, TW / TH, 0.05, 40), f = frame(M, TW / TH, 'bust');
      cam.position.set(0.18, f.camY, f.dist); cam.lookAt(f.target); cam.updateMatrixWorld(true);
      r.setPixelRatio(1); r.setSize(TW, TH, false); r._csW = 0;
      for (let i = 0; i < 10 && !thumbAbort; i++) { M.mixer.update(1 / 60); r.render(X.scene, cam); await sleep(45); }
      if (thumbAbort) return false;
      M.mixer.update(1 / 60); r.render(X.scene, cam);
      const c = D.createElement('canvas'); c.width = TW; c.height = TH; const g = c.getContext('2d'); g.fillStyle = '#120c1c'; g.fillRect(0, 0, TW, TH); g.drawImage(r.domElement, 0, 0, TW, TH);
      let url = c.toDataURL('image/webp', 0.84); if (!/^data:image\/webp/.test(url)) url = c.toDataURL('image/jpeg', 0.84);
      thumbs[def.id] = { sig: thumbSig(def), url }; saveThumbs(); return true;
    } catch (e) { log('thumb failed', def.id, e && e.message); return false; }
    finally { try { disposeCharacter(M); disposeSet(X); } catch (e) { } if (leased) release(); }
  }
  async function runThumbs() {
    if (thumbBusy) return; setThumbBusy(true); thumbAbort = false;
    try {
      for (const def of W.DMChars.list()) {
        if (thumbAbort || ST() !== 'character' || CS.studioOpen) break;
        const have = thumbs[def.id]; if (have && have.sig === thumbSig(def)) continue;
        setCardLoading(def.id, true); await captureThumb(def); setCardLoading(def.id, false); paintCard(def.id);
        await sleep(60);
      }
    } finally { setThumbBusy(false); }
  }
  function kickThumbs() { if (thumbBusy) return; setTimeout(() => { if (ST() === 'character' && !CS.studioOpen) runThumbs(); }, 250); }

  /* ───────────────────────── the card wheel ───────────────────────── */
  let activeIdx = 0, scrollRaf = 0;
  const cards = () => Array.from(D.querySelectorAll('#cs-wheel .cs-card-slot'));
  const cardFace = (slot) => (slot && slot.querySelector) ? (slot.querySelector('.cs-card') || slot) : slot;
  function buildCards() {
    const wheel = $('cs-wheel'); if (!wheel) return; wheel.textContent = '';
    W.DMChars.list().forEach((def) => {
      const b = D.createElement('button'); b.type = 'button'; b.className = 'cs-card-slot mm-panel'; b.dataset.id = def.id; b.setAttribute('role', 'option'); b.setAttribute('aria-label', def.name);
      b.innerHTML = '<span class="cs-card mm-frame"><span class="cs-thumbwrap"><img class="cs-thumb empty" alt="" decoding="async"><span class="cs-spin">LOADING<br>PORTRAIT</span></span><span class="cs-meta"><span class="cs-name"></span><span class="cs-tag"></span></span><span class="cs-badge" hidden></span></span>';
      b.querySelector('.cs-name').textContent = def.name.toUpperCase(); b.querySelector('.cs-tag').textContent = def.tag || '';
      b.addEventListener('click', () => onCardTap(def.id));
      wheel.appendChild(b);
    });
    const dots = $('cs-dots'); if (dots) { dots.textContent = ''; W.DMChars.list().forEach(() => dots.appendChild(D.createElement('i'))); }
    W.DMChars.list().forEach((d) => paintCard(d.id));
  }
  function paintCard(id) {
    const def = W.DMChars.get(id), el = D.querySelector('#cs-wheel .cs-card-slot[data-id="' + id + '"]'); if (!def || !el) return;
    const url = thumbFor(def), img = el.querySelector('.cs-thumb'), sp = el.querySelector('.cs-spin');
    if (url) { if (img.getAttribute('src') !== url) img.src = url; img.classList.remove('empty'); sp.style.display = 'none'; } else { img.classList.add('empty'); sp.style.display = ''; }
    const chosen = W.DMChars.selectedId() === id; el.classList.toggle('chosen', chosen && def.ready); cardFace(el).classList.toggle('chosen', chosen && def.ready);
    const bd = el.querySelector('.cs-badge'); if (!def.ready) { bd.hidden = false; bd.textContent = 'SOON'; bd.className = 'cs-badge soon'; } else if (chosen) { bd.hidden = false; bd.textContent = '✓ CHOSEN'; bd.className = 'cs-badge'; } else bd.hidden = true;
  }
  function setCardLoading(id, on) { const el = D.querySelector('#cs-wheel .cs-card-slot[data-id="' + id + '"] .cs-spin'); if (el && !thumbFor(W.DMChars.get(id))) el.textContent = on ? 'RENDERING…' : 'LOADING…'; }
  function layoutWheel() {   // scroll-driven transform: the centred card is full size, the others turn away and shrink.  Runs on scroll only.  Applied to the inner .cs-card so the slot can keep the enter/leave hinge.
    const wheel = $('cs-wheel'); if (!wheel) return; const mid = wheel.scrollLeft + wheel.clientWidth / 2; let best = 0, bd = 1e9; const cs = cards();
    cs.forEach((c, i) => {
      const cx = c.offsetLeft + c.offsetWidth / 2, d = (cx - mid) / (c.offsetWidth + 20), ad = Math.min(1.6, Math.abs(d));
      const face = cardFace(c);
      face.style.transform = 'translateZ(' + (-ad * 90).toFixed(1) + 'px) rotateY(' + (Math.max(-1, Math.min(1, d)) * -26).toFixed(1) + 'deg) scale(' + (1 - ad * 0.1).toFixed(3) + ')'; face.style.opacity = String(Math.max(0.45, 1 - ad * 0.38));
      if (Math.abs(cx - mid) < bd) { bd = Math.abs(cx - mid); best = i; }
    });
    activeIdx = best; cs.forEach((c, i) => { const on = i === best; c.classList.toggle('on', on); cardFace(c).classList.toggle('on', on); }); const dots = D.querySelectorAll('#cs-dots i'); dots.forEach((d, i) => d.classList.toggle('on', i === best));
    refreshFoot();
  }
  function centreOn(i, smooth) { const c = cards()[i]; const wheel = $('cs-wheel'); if (!c || !wheel) return; wheel.scrollTo({ left: c.offsetLeft + c.offsetWidth / 2 - wheel.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' }); }
  function onCardTap(id) {
    const i = W.DMChars.list().findIndex((d) => d.id === id);
    if (i !== activeIdx) { centreOn(i, true); return; }
    openStudio(id, cardFace(D.querySelector('#cs-wheel .cs-card-slot[data-id="' + id + '"]')));
  }
  function refreshFoot() {
    const cur = W.DMChars.list()[activeIdx];
    uiApply(uiMachine(UI, { type: 'pick', id: cur ? cur.id : UI.pickedId }));
    const nx = $('cs-next');
    if (!nx) return;
    const named = (cur && cur.ready) ? cur : (W.DMChars.get(W.DMChars.selectedId()) || null);
    nx.textContent = (named ? 'CONTINUE AS ' + named.name.toUpperCase() : 'CONTINUE') + ' ⟶';
  }

  /* ───────────────────────── the studio ───────────────────────── */
  const S = { M: null, X: null, cam: null, F: null, raf: 0, yaw: 0, vyaw: 0, dragging: false, pointers: new Map(), pinch0: 0, zoom: 1, pitch: 0, last: 0, accum: 0, nextExtra: 0, look: 0, lookT: 0, def: null, token: 0, leased: false };
  async function openStudio(id, fromEl) {
    const def = W.DMChars.get(id); if (!def || CS.studioOpen) return;
    clearTimeout(closeStudio._t); closeStudio._t = 0;   // a reopen inside the 550 ms close must not be hidden by finish()
    CS.studioOpen = true; thumbAbort = true; const token = ++S.token; S.def = def; if (CW.w) CW.w.pause(true); try { CS._resetFlow && CS._resetFlow(); } catch (e) { }
    uiApply(uiMachine(UI, { type: 'edit', id: def.id }));
    const root = $('cs-studio'), stage = $('cs-stage');
    $('cs-pname').textContent = def.name.toUpperCase(); $('cs-ptag').textContent = def.tag || '';
    $('cs-load').textContent = 'LOADING ' + def.name.toUpperCase() + '…'; $('cs-load').style.display = ''; $('cs-turn').classList.remove('gone');
    renderPanel(); layoutStudio();
    // the editor card hinges in like a main-menu panel (mmOpenR / mmOpenB); no clip-path expand
    root.classList.remove('leaving'); root.classList.add('open'); stage.classList.remove('drag');
    root.style.clipPath = 'none'; root.style.transition = 'none';
    void fromEl;
    try {
      while (thumbBusy) await sleep(40);   // the thumbnail job sees thumbAbort and lets go of the renderer within a frame or two
      if (token !== S.token) return;
      const r = await acquire(stage); S.leased = true;
      if (R.canvas) R.canvas.style.visibility = '';
      if (token !== S.token) { release(); S.leased = false; return; }
      S.X = buildSet(false); S.X.world = null;
      try { if (W.DMMenuWorld && W.DMMenuWorld.attachStudio) S.X.world = W.DMMenuWorld.attachStudio(W.THREE, S.X, { aspect: stage.clientWidth / Math.max(1, stage.clientHeight) }); } catch (e) { log('menu world (studio) failed', e && e.message); S.X.world = null; }   // ui/dm-menuworld.js; ?menuscene=off -> null
      try { if (W.DMCharLook && S.X.world) W.DMCharLook.syncStudio(S.X); } catch (e) { }   // the studio env follows the menu world's sun (key / rim)
      $('cs-studio').classList.toggle('mw-on', !!S.X.world);
      const M = await buildCharacter(def, { anims: true, hair: true, strandFraction: 0.75, onProgress: (p) => { if (token === S.token) $('cs-load').textContent = 'LOADING ' + def.name.toUpperCase() + ' ' + Math.round(p * 100) + '%'; } });
      if (token !== S.token) { disposeCharacter(M); return; }
      S.M = M; M.root.visible = false; S.X.scene.add(M.root); M.root.position.y = 0;
      try { if (M.mixer) { M.mixer.update(0); M.mixer.update(1 / 30); } } catch (e) { }
      M.root.updateMatrixWorld(true); const minY = new W.THREE.Box3().setFromObject(M.root).min.y; M.root.position.y = -minY; M.root.updateMatrixWorld(true);
      M.root.visible = true;
      S.cam = new W.THREE.PerspectiveCamera(30, 1, 0.05, 60); S.yaw = -0.35; S.vyaw = 0; S.zoom = 1; S.pitch = 0; S.vpitch = 0; S.ty = 0; S.home = false; S.F = null;
      if (S.X.world) S.X.world.prepCamera(S.cam);
      try { CS.onStudioModel && CS.onStudioModel(M, def); } catch (e) { log('onStudioModel', e); }
      $('cs-load').style.display = 'none'; S.last = 0; S.accum = 0; S.nextExtra = performance.now() + 2200; S.look = 0;
      layoutStudio(); startLoop();
    } catch (e) {
      log('studio failed', e && e.message); $('cs-load').textContent = 'COULD NOT LOAD ' + def.name.toUpperCase() + ' HERE'; toast('Could not load ' + def.name + ' on this device');
    }
  }
  function closeStudio(opts) {
    if (!CS.studioOpen) return; opts = opts || {}; const token = ++S.token; void token;
    stopLoop(); try { CS._discardPending && CS._discardPending(S.def); } catch (e) { }   // a logo still pending is dropped (and not in the card still)
    // refresh the card's still from the live model (colours / logos show on the card), then let everything go
    let refreshed = false;
    try { if (S.M && S.M.root && R.r && opts.thumb !== false && S.F) refreshed = grabThumbFromStudio(); } catch (e) { log('thumb refresh', e && e.message); }
    try { CS.onStudioClose && CS.onStudioClose(); } catch (e) { }
    disposeCharacter(S.M); if (S.X && S.X.world) { try { S.X.world.dispose(); } catch (e) { } S.X.world = null; } disposeSet(S.X); S.M = null; S.X = null; S.cam = null; S.F = null; S.pointers.clear();
    if (S.leased) { S.leased = false; release(); }
    const root = $('cs-studio');
    const hideChrome = opts.visual !== false;
    const reduce = (function () { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return true; } })();
    const finish = () => { if (!root) return; root.classList.remove('open', 'leaving'); root.style.clipPath = ''; root.style.transition = ''; };
    clearTimeout(closeStudio._t); closeStudio._t = 0;
    if (hideChrome && root && root.classList.contains('open') && !reduce && !opts.immediate) {
      root.classList.add('leaving');
      closeStudio._t = setTimeout(finish, 550);
    } else {
      finish();   // always including !hideChrome (leave / goScreen) and opts.immediate, so .open cannot linger
    }
    CS.studioOpen = false; if (refreshed && S.def) paintCard(S.def.id);
    if (hideChrome) uiApply(uiMachine(UI, { type: 'back' }));
    if (CW.w) { backToBg(); CW.w.pause(false); if (R.r) { R.r._csW = 0; } }
    if (ST() === 'character') kickThumbs();
  }
  function grabThumbFromStudio() {   // one extra render at card size, bust framing, straight into the cache
    const THREE = W.THREE, r = R.r, M = S.M, def = S.def, cam = new THREE.PerspectiveCamera(30, TW / TH, 0.05, 40), f = frame(M, TW / TH, 'bust');
    M.root.rotation.y = 0.18; M.root.updateMatrixWorld(true); cam.position.set(0.18, f.camY, f.dist); cam.lookAt(f.target); cam.updateMatrixWorld(true);
    const ob = S.X.scene.background; S.X.scene.background = new THREE.Color(0x120c1c);
    r.setPixelRatio(1); r.setSize(TW, TH, false); r._csW = 0; r.render(S.X.scene, cam);
    const c = D.createElement('canvas'); c.width = TW; c.height = TH; const g = c.getContext('2d'); g.fillStyle = '#120c1c'; g.fillRect(0, 0, TW, TH); g.drawImage(r.domElement, 0, 0, TW, TH);
    S.X.scene.background = ob; let url = c.toDataURL('image/webp', 0.84); if (!/^data:image\/webp/.test(url)) url = c.toDataURL('image/jpeg', 0.84);
    thumbs[def.id] = { sig: thumbSig(def), url }; saveThumbs(); return true;
  }
  function layoutStudio() {
    const stage = $('cs-stage'), r = R.r; if (!stage || !r || !S.cam) return;
    const w = Math.max(10, stage.clientWidth), h = Math.max(10, stage.clientHeight), pr = Math.min(devicePixelRatio || 1, (W.DMMenuWorld && S.X && S.X.world && W.DMMenuWorld.prCap()) || 1.5);
    if (r._csW !== w || r._csH !== h || r._csPR !== pr) { r._csW = w; r._csH = h; r._csPR = pr; r.setPixelRatio(pr); r.setSize(w, h, false); }
    S.cam.aspect = w / h; S.cam.updateProjectionMatrix(); if (S.X && S.X.world) S.X.world.setAspect(w / h); if (S.M) S.F = frame(S.M, w / h, 'full');
  }
  function startLoop() { if (S.raf) return; S.last = 0; const tick = (t) => { S.raf = requestAnimationFrame(tick); studioFrame(t); }; S.raf = requestAnimationFrame(tick); }
  function stopLoop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  const _q = { tmp: null };
  // idempotent per-bone look offset (pure; exported for tools/tests/head-spin.js).  st = { base, wrote, has }: base = the clip pose under the offset,
  // wrote = the quaternion written last call.  If the bone still holds exactly `wrote`, the mixer skipped it this frame, so the clip pose is still `base`.
  CS.lookState = (THREE) => { const mk = () => ({ base: new THREE.Quaternion(), wrote: new THREE.Quaternion(), has: false }); return { head: mk(), neck: mk() }; };
  CS.lookApply = (st, bone, offset) => {
    const q = bone.quaternion;
    if (st.has && q.x === st.wrote.x && q.y === st.wrote.y && q.z === st.wrote.z && q.w === st.wrote.w) q.copy(st.base);
    st.base.copy(q); q.multiply(offset); st.wrote.copy(q); st.has = true;
  };
  CS.clampLook = (v) => (v > 0.7 ? 0.7 : v < -0.7 ? -0.7 : v);   // |yaw| ≤ 0.42 rad head + 0.25 neck, pitch ≤ 0.035
  function studioFrame(t) {
    if (!S.M || !S.M.root || !R.r || D.hidden) { S.last = 0; return; }
    if (S.last && t - S.last < 30) return;                 // 30 fps cap: this is a menu
    const dt = S.last ? Math.min(0.1, (t - S.last) / 1000) : 0.016; S.last = t;
    if (R.r._csW !== $('cs-stage').clientWidth || R.r._csH !== $('cs-stage').clientHeight) layoutStudio();
    const THREE = W.THREE, M = S.M;
    // orbit the camera around Y (do not spin the character root: that would fling the hair)
    if (!S.dragging) { S.yaw += S.vyaw * dt; S.vyaw *= Math.pow(0.02, dt); if (Math.abs(S.vyaw) < 0.05) S.vyaw = 0; }
    M.root.rotation.y = 0;
    // extra clip (wave / expression) now and then, back to idle when it ends
    if (M.extras.length && t > S.nextExtra && !M.playing) {
      const a = M.extras[(Math.random() * M.extras.length) | 0]; a.reset(); a.setEffectiveWeight(1); a.fadeIn(0.25).play(); M.actions.idle && M.actions.idle.crossFadeTo(a, 0.25, false); M.playing = a;
      const done = (e) => { if (e.action !== a) return; M.mixer.removeEventListener('finished', done); a.fadeOut(0.3); if (M.actions.idle) { M.actions.idle.reset().fadeIn(0.3).play(); } M.playing = null; S.nextExtra = performance.now() + 5000 + Math.random() * 5000; };
      M.mixer.addEventListener('finished', done);
    }
    M.mixer.update(dt);
    // she looks around: toward the finger while it is down, an occasional glance otherwise (applied after the mixer, before the hair solver steps at render)
    const head = M.bones.Head, neck = M.bones.neck;
    if (head) {
      let want = 0; if (S.dragging && S.dragX != null) want = Math.max(-0.7, Math.min(0.7, S.dragX * 0.9)); else want = Math.sin(t / 1900) * 0.22 * Math.sin(t / 7300);
      S.look += (want - S.look) * Math.min(1, dt * 6);
      if (!_q.tmp) { _q.tmp = new THREE.Quaternion(); _q.e = new THREE.Euler(); _q.n = new THREE.Quaternion(); }
      // (t1644u head-spin fix) the look offset is applied on top of the CLIP pose, never on top of last frame's result: three's PropertyMixer skips setValue
      // when a track's mixed value did not change (Emma's constant wrist/finger/neck tracks, 30 fps cap frames, crossfades), so a bare multiply() accumulated
      // into a continuous 360° spin.  CS.lookApply restores the remembered clip base when the bone still holds what we wrote last frame, then base × offset.
      const lk = M._look || (M._look = CS.lookState(THREE));
      CS.lookApply(lk.head, head, _q.tmp.setFromEuler(_q.e.set(CS.clampLook(S.look) * 0.05, CS.clampLook(S.look) * 0.6, 0)));
      if (neck) CS.lookApply(lk.neck, neck, _q.n.setFromEuler(_q.e.set(0, CS.clampLook(S.look) * 0.35, 0)));
    }
    // camera
    // orbit camera: vertical drag swings the camera up over her head (top view) or down to her feet; target height + distance follow the pitch (DMMenuWorld.orbitRig, pure)
    const F = S.F; if (F) {
      if (!S.dragging) { S.pitch += (S.vpitch || 0) * dt; S.vpitch = (S.vpitch || 0) * Math.pow(0.02, dt); if (Math.abs(S.vpitch) < 0.02) S.vpitch = 0; }
      const MWc = W.DMMenuWorld, lo = MWc ? MWc.PITCH_MIN : -1.3, hi = MWc ? MWc.PITCH_MAX : 1.48;
      if (S.pitch < lo) { S.pitch = lo; S.vpitch = 0; } else if (S.pitch > hi) { S.pitch = hi; S.vpitch = 0; }
      if (S.home) {   // double-tap: ease back to the default view (nearest turn of yaw)
        const k = 1 - Math.exp(-dt * 8); S.pitch += (0 - S.pitch) * k; S.zoom += (1 - S.zoom) * k; S.ty += (0 - S.ty) * k; S.vpitch = 0; S.vyaw = 0;
        const hy = MWc ? MWc.nearestYaw(S.yaw, -0.35) : -0.35; S.yaw += (hy - S.yaw) * k;
        if (Math.abs(S.pitch) + Math.abs(S.zoom - 1) + Math.abs(S.ty) + Math.abs(S.yaw - hy) < 0.01) { S.pitch = 0; S.zoom = 1; S.ty = 0; S.yaw = hy; S.home = false; }
      }
      if (MWc) {
        const o = MWc.orbitRig(S.pitch, F.H, F.dist, S.zoom, S.ty, { floorY: 0 }), lim = MWc.STUDIO_CAM || { maxY: 3.55, maxR: 4.55, minY: 0.16 };
        const camY = Math.max(lim.minY, Math.min(o.camY, lim.maxY)), camR = Math.min(o.camR, lim.maxR);
        S.tgt = S.tgt || new THREE.Vector3(); S.tgt.set(0, o.ty, 0);
        // -S.yaw: drag-right is a natural orbit (see her right side). The bay/sky/lights use the same heading so the camera stays inside the hangar and the key stays in front of her.
        const yw = -S.yaw;
        S.cam.position.set(Math.sin(yw) * camR, camY, Math.cos(yw) * camR); S.cam.lookAt(S.tgt);
        S._yw = yw;
      } else { const d = F.dist * S.zoom, py = Math.max(-0.22, Math.min(0.3, S.pitch)); S.cam.position.set(Math.sin(-S.yaw) * Math.cos(py) * d, F.camY + Math.sin(py) * d * 0.6, Math.cos(-S.yaw) * Math.cos(py) * d); S.cam.lookAt(F.target); S._yw = -S.yaw; }
      S.cam.updateMatrixWorld(true);
    }
    if (S.X.world) { try { S.X.world.update(t, dt, S.cam, S._yw == null ? -S.yaw : S._yw, S.tgt, S.dragging); if (S.X.world.rescale) { S.X.world.rescale = false; layoutStudio(); } } catch (e) { log('menu world update', e && e.message); S.X.world.update = () => { }; } }
    if (S.X.world && S.X.world.render) S.X.world.render(R.r, S.X.scene, S.cam); else R.r.render(S.X.scene, S.cam);
    CS.onStudioFrame && CS.onStudioFrame(dt);
  }
  function bindStage() {
    const st = $('cs-stage'); if (!st || st._bound) return; st._bound = true;
    st.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return; try { st.setPointerCapture(e.pointerId); } catch (_) { }
      S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
      if (S.pointers.size === 1) { S.dragging = true; S.home = false; st.classList.add('drag'); S.vyaw = 0; S.vpitch = 0; $('cs-turn').classList.add('gone'); }
      if (S.pointers.size === 2) { const p = Array.from(S.pointers.values()); S.pinch0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); S.zoom0 = S.zoom; }
    });
    st.addEventListener('pointermove', (e) => {
      const p = S.pointers.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      const rc = st.getBoundingClientRect(); S.dragX = ((e.clientX - rc.left) / rc.width - 0.5) * 2;
      if (S.pointers.size >= 2) { const a = Array.from(S.pointers.values()); const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); S.home = false; if (S.pinch0 > 8) S.zoom = Math.max(0.45, Math.min(1.25, S.zoom0 * S.pinch0 / Math.max(8, d))); S.ty = Math.max(-1, Math.min(1, (S.ty || 0) - dy * 0.5 * 0.004)); return; }   // two fingers: pinch zooms, a shared vertical drag nudges the target height
      S.home = false; S.yaw += dx * 0.011; S.vyaw = dx * 0.011 * 30 * 0.6 + S.vyaw * 0.4;   // full 360 deg turntable
      { const lo = W.DMMenuWorld ? W.DMMenuWorld.PITCH_MIN : -1.3, hi = W.DMMenuWorld ? W.DMMenuWorld.PITCH_MAX : 1.48; S.pitch = Math.max(lo, Math.min(hi, S.pitch - dy * 0.0075)); S.vpitch = -dy * 0.0075 * 30 * 0.5 + (S.vpitch || 0) * 0.5; }   // drag up = camera up and over
    });
    const up = (e) => {
      const p = S.pointers.get(e.pointerId); S.pointers.delete(e.pointerId);
      if (p && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 8 && performance.now() - p.t0 < 350 && S.pointers.size === 0) {   // double tap = back to the default view
        const now = performance.now(); if (S.lastTap && now - S.lastTap < 320) { S.home = true; S.lastTap = 0; } else S.lastTap = now;
      }
      if (p && CS.onStageTap && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 8 && performance.now() - p.t0 < 450) { try { CS.onStageTap(e, st); } catch (er) { log('tap', er); } }
      if (S.pointers.size === 0) { S.dragging = false; S.dragX = null; st.classList.remove('drag'); }
    };
    st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
    st.addEventListener('wheel', (e) => { e.preventDefault(); S.home = false; S.zoom = Math.max(0.45, Math.min(1.25, S.zoom * (1 + Math.sign(e.deltaY) * 0.07))); }, { passive: false });
  }

  /* ───────────────────────── studio panel (tabs are an extension point: colours, logos) ───────────────────────── */
  let activeTab = null;
  function renderPanel() {
    const tabs = $('cs-tabs'), body = $('cs-pbody'), def = S.def; if (!tabs || !body || !def) return; tabs.textContent = ''; body.textContent = '';
    const P = CS.panels.filter((p) => !p.when || p.when(def));
    if (!P.length) { const p = D.createElement('p'); p.textContent = def.ready ? 'Drag to turn her. Pinch or scroll to zoom. Select her to fly as ' + def.name + '.' : def.name + ' is not flyable yet; you can look around her studio.'; body.appendChild(p); }
    if (P.length > 1) P.forEach((p) => { const b = D.createElement('button'); b.type = 'button'; b.textContent = p.label; b.dataset.tab = p.id; b.addEventListener('click', () => { activeTab = p.id; renderPanel(); }); tabs.appendChild(b); });
    if (P.length) { const cur = P.find((p) => p.id === activeTab) || P[0]; activeTab = cur.id; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === cur.id)); cur.render(body, { def, studio: CS, rerender: renderPanel }); }
    const sel = $('cs-sselect'); if (sel) { const chosen = W.DMChars.selectedId() === def.id; sel.textContent = !def.ready ? 'COMING SOON' : chosen ? '✓ CHOSEN — BACK' : 'SELECT ' + def.name.toUpperCase() + ' ✓'; sel.disabled = !def.ready; }
  }
  function choose() {
    const def = S.def; if (!def) return;
    if (!def.ready) { toast(def.name + ' is not ready to fly yet'); return; }
    W.DMChars.setSelected(def.id); closeStudio();
    /* (bugfix-1119) a pilot that was already preloaded is dropped and the chosen one loads when the game starts (loadCharacterAssets -> _charReconcile): no reload needed */ W.DMChars.list().forEach((d) => paintCard(d.id)); refreshFoot(); toast('Articren: ' + def.name);
  }

  /* ───────────────────────── COLOURS panel (registry regions: hair groups + clothing items) ───────────────────────── */
  let activeRegion = null;

  /* in-app HSV / hex colour picker (no native OS colour dialog) */
  function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : [128, 128, 128]; }
  function rgbToHex(r, g, b) { const u = (n) => ('0' + Math.max(0, Math.min(255, n | 0)).toString(16)).slice(-2); return '#' + u(r) + u(g) + u(b); }
  function rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; let h = 0; if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; } return { h, s: max ? d / max : 0, v: max }; }
  function hsvToRgb(h, s, v) { const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c; let r = 0, g = 0, b = 0; if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; } return [(r + m) * 255, (g + m) * 255, (b + m) * 255]; }
  function openPicker(start, onLive, onPick, anchor, label) {
    const prev = D.getElementById('cs-picker'); if (prev) { if (prev._close) prev._close(); else prev.remove(); }
    const pop = D.createElement('div'); pop.id = 'cs-picker'; pop.className = 'cs-picker'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', label || 'Colour picker');
    const rgb0 = hexToRgb(start), hsv = rgbToHsv(rgb0[0], rgb0[1], rgb0[2]);
    pop.innerHTML = '<div class="cs-pk-sv"><canvas width="180" height="140"></canvas><i></i></div><div class="cs-pk-hue"><canvas width="180" height="24"></canvas><i></i></div><div class="cs-pk-row"><span class="cs-pk-chip"></span><input class="cs-pk-hex" maxlength="7" spellcheck="false" aria-label="Hex colour"><button type="button" class="cs-pk-ok">SET</button></div>';
    const sv = pop.querySelector('.cs-pk-sv canvas'), hue = pop.querySelector('.cs-pk-hue canvas'), hex = pop.querySelector('.cs-pk-hex'), chip = pop.querySelector('.cs-pk-chip');
    const svx = pop.querySelector('.cs-pk-sv i'), hx = pop.querySelector('.cs-pk-hue i');
    const paint = () => {
      const sctx = sv.getContext('2d'), [rr, gg, bb] = hsvToRgb(hsv.h, 1, 1);
      const grdX = sctx.createLinearGradient(0, 0, sv.width, 0); grdX.addColorStop(0, '#fff'); grdX.addColorStop(1, 'rgb(' + (rr|0) + ',' + (gg|0) + ',' + (bb|0) + ')');
      sctx.fillStyle = grdX; sctx.fillRect(0, 0, sv.width, sv.height);
      const grdY = sctx.createLinearGradient(0, 0, 0, sv.height); grdY.addColorStop(0, 'rgba(0,0,0,0)'); grdY.addColorStop(1, '#000');
      sctx.fillStyle = grdY; sctx.fillRect(0, 0, sv.width, sv.height);
      const hctx = hue.getContext('2d'), hg = hctx.createLinearGradient(0, 0, hue.width, 0);
      for (let i = 0; i <= 6; i++) { const [r, g, b] = hsvToRgb(i * 60, 1, 1); hg.addColorStop(i / 6, 'rgb(' + (r|0) + ',' + (g|0) + ',' + (b|0) + ')'); }
      hctx.fillStyle = hg; hctx.fillRect(0, 0, hue.width, hue.height);
      const col = hsvToRgb(hsv.h, hsv.s, hsv.v), hxv = rgbToHex(col[0], col[1], col[2]);
      chip.style.background = hxv; if (D.activeElement !== hex) hex.value = hxv;
      svx.style.left = (hsv.s * 100) + '%'; svx.style.top = ((1 - hsv.v) * 100) + '%'; hx.style.left = (hsv.h / 360 * 100) + '%';
      return hxv;
    };
    let liveT = 0, liveH = null, liveTimer = 0, closed = false;
    const flushLive = () => { if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; } if (liveH && onLive) onLive(liveH); liveH = null; };
    const commit = (live) => {
      const h = paint();
      if (!live) { flushLive(); return h; }
      if (!onLive) return h;
      liveH = h; const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - liveT >= 180) { liveT = now; onLive(h); liveH = null; }
      else if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = 0; liveT = (typeof performance !== 'undefined' ? performance.now() : Date.now()); if (liveH && onLive) onLive(liveH); liveH = null; }, 180);
      return h;
    };
    paint();
    const bind = (cv, fn) => {
      const go = (e) => { const r = cv.getBoundingClientRect(); fn((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); commit(true); };
      cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); go(e); });
      cv.addEventListener('pointermove', (e) => { if (e.buttons) go(e); });
    };
    bind(sv, (x, y) => { hsv.s = Math.max(0, Math.min(1, x)); hsv.v = Math.max(0, Math.min(1, 1 - y)); });
    bind(hue, (x) => { hsv.h = Math.max(0, Math.min(359, x * 360)); });
    hex.addEventListener('change', () => { const v = hex.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) { const c = hexToRgb(v); const n = rgbToHsv(c[0], c[1], c[2]); hsv.h = n.h; hsv.s = n.s; hsv.v = n.v; commit(true); } });
    const close = () => { if (closed) return; closed = true; flushLive(); D.removeEventListener('pointerdown', outside, true); if (pop.parentNode) pop.remove(); };
    pop._close = close;
    pop.querySelector('.cs-pk-ok').addEventListener('click', () => { const h = commit(false); onPick(h); close(); });
    const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
    D.addEventListener('pointerdown', outside, true);
    const host = (anchor && anchor.closest && anchor.closest('.cs-reg')) || (anchor && anchor.parentNode) || $('cs-pbody');
    host.appendChild(pop);
  }

  function swatchGrid(region, def, rerender) {
    const wrap = D.createElement('div'); wrap.className = 'cs-reg';
    const grid = D.createElement('div'); grid.className = 'cs-sws'; wrap.appendChild(grid);
    const cur = (W.DMChars.look(def.id).colors || {})[region.id] || null;
    const pal = region.kind === 'hair' ? W.DMChars.PALETTE_HAIR : W.DMChars.PALETTE_CLOTH;
    const mk = (cls, label) => { const b = D.createElement('button'); b.type = 'button'; b.className = 'cs-sw ' + cls; b.setAttribute('aria-label', label); b.title = label; return b; };
    const pick = (hex) => { W.DMChars.setColor(def.id, region.id, hex); applyStudio(def); noteGame(def); rerender(); };
    // an item with a shipped texture offers DEFAULT TEXTURE (one tap back to the baked look); a colour swatch overrides the texture with a flat colour
    const d0 = mk('def' + (region.texture ? ' tex wide' : '') + (cur ? '' : ' on'), region.label + (region.texture ? ' default texture' : ' default')); d0.textContent = region.texture ? 'DEFAULT TEXTURE' : 'DEF'; d0.addEventListener('click', () => pick(null)); grid.appendChild(d0);
    pal.forEach((hex) => { const b = mk(cur === hex ? 'on' : '', region.label + ' ' + hex); b.style.background = hex; b.addEventListener('click', () => pick(hex)); grid.appendChild(b); });
    const plus = mk('custom' + (cur && !pal.includes(cur) ? ' on' : ''), region.label + ' custom colour'); plus.textContent = '+';
    plus.addEventListener('click', () => openPicker(cur || region.defaultColor || '#808080', (h) => { W.DMChars.setColor(def.id, region.id, h); applyStudio(def); }, pick, plus, region.label + ' colour'));
    grid.appendChild(plus); return wrap;
  }
  function noteGame(def) {   // the game already holds a pilot in memory: new colours show from the next game start
    try { if (typeof CHAR !== 'undefined' && CHAR.loaded && CHAR.charId === def.id && !CS._noted) { CS._noted = true; toast('Colours show in the game from its next start (reload) — she is already loaded this session', 4200); } } catch (e) { }
  }
  CS.panels.push({
    id: 'colours', label: 'COLOURS', when: (def) => W.DMChars.regions(def).length > 0,
    render(el, ctx) {
      const def = ctx.def, regs = W.DMChars.regions(def), L = W.DMChars.look(def.id);
      if (!regs.some((r) => r.id === activeRegion)) activeRegion = regs[0].id;
      const chips = D.createElement('div'); chips.className = 'cs-chips'; el.appendChild(chips);
      regs.forEach((r) => { const b = D.createElement('button'); b.type = 'button'; b.className = 'cs-chip' + (r.id === activeRegion ? ' on' : '') + ((L.colors || {})[r.id] ? ' set' : ''); b.textContent = r.label.toUpperCase();
        b.addEventListener('click', () => { activeRegion = r.id; ctx.rerender(); }); chips.appendChild(b); });
      el.appendChild(swatchGrid(regs.find((r) => r.id === activeRegion), def, ctx.rerender));
      const ar = regs.find((r) => r.id === activeRegion), p = D.createElement('p'); p.textContent = ar.texture ? 'DEFAULT TEXTURE keeps the original printed ' + ar.label.toLowerCase() + '. A colour swatch replaces the texture with that flat colour; tap DEFAULT TEXTURE to bring it back.' : 'DEF keeps her original look.'; el.appendChild(p);
      const rb = D.createElement('button'); rb.type = 'button'; rb.className = 'cs-btn cs-reset'; rb.textContent = 'RESET TO DEFAULT'; rb.disabled = W.DMChars.isDefaultLook(L);
      rb.addEventListener('click', () => { W.DMChars.resetLook(def.id); CS._resetFlow && CS._resetFlow(); applyStudio(def); ctx.rerender(); }); el.appendChild(rb);
    },
  });

  /* ───────────────────────── LOGOS panel (registry spots + DMChars decal model + DMDecalFlow staged logic + DMCharPaint projection) ─────────────────────────
     1 pick a logo, 2 tap a garment: a PENDING decal shows on the character (preview, nothing saved), 3 place it on the pad (drag to move, corner handle = size, top knob = turn),
     APPLY commits it.  Another logo picked while one is pending replaces the logo and keeps the placement.  RESET = default place / size / turn, CANCEL = drop it.
     Applied logos are listed: tap to select, DELETE SELECTED / CLEAR ALL ON <garment>, EDIT loads one back into the pending slot.  The pure logic is ui/dm-decalflow.js.
     Each change is one CPU bake into the garment's texture on release (debounced), no per-frame work. */
  const FL = W.DMDecalFlow; let FS = FL ? FL.newState() : null, FLOW = null;
  const flow = () => FLOW || (FLOW = FL.make(W.DMChars));
  const svgOf = (lg) => lg.text ? '<span class="cs-lgt">Aa</span>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="' + lg.d + '"/></svg>';
  const boxCache = new Map(), silCache = new Map();
  function itemInfo(def, item) {   // {unit, views:{key:{W,H,tris}}} for the pad (garment outline); null when the model is not there (the pad falls back to a plain 1:1.2 card)
    const k = def.id + '|' + item; if (boxCache.has(k)) return boxCache.get(k); let r = null;
    try { const ib = S.M && S.M.root && W.DMCharPaint && W.DMCharPaint._impl.itemOutline(S.M.root, def.items[item], W.THREE, !!def.decalFlip);
      if (ib) { r = { unit: ib.unit, views: {} }; for (const key of Object.keys(def.items[item].spots)) { const R = W.DMCharPaint.planeRange(ib.box, key); r.views[key] = { W: R.W, H: R.H, tris: ib.views[key] }; } } } catch (e) { log('outline', e && e.message); }
    if (r) boxCache.set(k, r); return r;
  }
  function silhouette(def, item, spot, w, h) {   // the garment outline of one view, drawn once into an offscreen canvas
    const info = itemInfo(def, item), v = info && info.views[spot]; if (!v || !v.tris || !v.tris.length) return null;
    const k = def.id + '|' + item + '|' + spot + '|' + w + 'x' + h; if (silCache.has(k)) return silCache.get(k);
    const c = D.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), t = v.tris;
    g.fillStyle = '#96c3ff'; g.strokeStyle = '#96c3ff'; g.lineWidth = 1.2; g.lineJoin = 'round';   // opaque here, faded when drawn onto the pad (no alpha build-up between triangles)
    g.beginPath(); for (let i = 0; i < t.length; i += 6) { g.moveTo(t[i] * w, t[i + 1] * h); g.lineTo(t[i + 2] * w, t[i + 3] * h); g.lineTo(t[i + 4] * w, t[i + 5] * h); g.closePath(); } g.fill(); g.stroke();
    silCache.set(k, c); return c;
  }
  const PAD_W = 270;
  function padSize(def, item, spot) { const info = itemInfo(def, item), v = info && info.views[spot], asp = v ? Math.max(0.5, Math.min(2, v.H / v.W)) : 1.2; return [PAD_W, Math.round(PAD_W * asp)]; }
  function drawLogo(ctx, lg, text, colour, px, outline) {
    ctx.fillStyle = colour; if (lg.text) { ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '900 ' + px * 0.5 + 'px Arial, sans-serif'; if (outline) { ctx.lineWidth = 2; ctx.strokeStyle = outline; ctx.strokeText(text || '', 0, 0, px); } ctx.fillText(text || '', 0, 0, px); return; }
    ctx.save(); ctx.scale(px / 24, px / 24); ctx.translate(-12, -12); const p = new Path2D(lg.d); if (outline) { ctx.lineWidth = 2 * 24 / px; ctx.strokeStyle = outline; ctx.stroke(p); } ctx.fill(p, 'evenodd'); ctx.restore();
  }
  // the placement pad: garment outline, thirds grid, snap dots, the other applied logos on this view (faint), the pending logo with its box, SIZE handle (corner) and TURN knob
  function drawPad(cv, def, FSt, live, mode) {
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, DC = W.DMChars, sp = def.items[FSt.item].spots[FSt.spot];
    ctx.clearRect(0, 0, w, h); const r = 14, bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, 'rgba(34,40,70,.95)'); bg.addColorStop(1, 'rgba(14,16,34,.95)');
    ctx.beginPath(); ctx.moveTo(r, 1); ctx.arcTo(w - 1, 1, w - 1, h - 1, r); ctx.arcTo(w - 1, h - 1, 1, h - 1, r); ctx.arcTo(1, h - 1, 1, 1, r); ctx.arcTo(1, 1, w - 1, 1, r); ctx.closePath(); ctx.fillStyle = bg; ctx.fill();
    ctx.save(); ctx.clip();
    const sil = silhouette(def, FSt.item, FSt.spot, w, h); if (sil) { ctx.globalAlpha = 0.24; ctx.drawImage(sil, 0, 0); ctx.globalAlpha = 1; }
    ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1; ctx.setLineDash([4, 5]); ctx.beginPath();
    for (let i = 1; i < 3; i++) { ctx.moveTo(w * i / 3, 0); ctx.lineTo(w * i / 3, h); ctx.moveTo(0, h * i / 3); ctx.lineTo(w, h * i / 3); } ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    const info = itemInfo(def, FSt.item), v = info && info.views[FSt.spot], unit = info ? info.unit : 1;
    // logos already applied on this view, for context
    DC.look(def.id).decals.forEach((d, i) => { if (d.item !== FSt.item || d.spot !== FSt.spot || i === FSt.editIndex) return; const g0 = FL.padGeom(v, sp, unit, d, w, h), lg0 = DC.logoById.get(d.id);
      ctx.save(); ctx.globalAlpha = 0.4; ctx.translate(g0.cx, g0.cy); ctx.rotate(g0.th); drawLogo(ctx, lg0, d.text, d.colour, g0.px, 'rgba(0,0,0,.5)'); ctx.restore(); });
    const near = DC.snapPoint(def, FSt.item, FSt.spot, live.x, live.y, DC.SNAP_R * 1.5);
    sp.snaps.forEach((sn) => { ctx.beginPath(); ctx.arc(sn.x * w, sn.y * h, sn === near ? 8 : 4, 0, 6.2832); ctx.fillStyle = sn === near ? '#ffd24a' : 'rgba(255,210,74,.5)'; ctx.fill(); if (sn === near) { ctx.font = '700 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd24a'; ctx.fillText(sn.label, Math.max(40, Math.min(w - 40, sn.x * w)), sn.y * h - 14); } });
    const g = FL.padGeom(v, sp, unit, live, w, h), lg = DC.logoById.get(FSt.logo);
    ctx.save(); ctx.translate(g.cx, g.cy); ctx.rotate(g.th); ctx.globalAlpha = 0.97; drawLogo(ctx, lg, FSt.text, FSt.colour, g.px, 'rgba(0,0,0,.55)'); ctx.restore();
    // box + handles
    ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath(); g.corners.forEach((c, i) => { if (i) ctx.lineTo(c[0], c[1]); else ctx.moveTo(c[0], c[1]); }); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(g.tip[0], g.tip[1]); ctx.lineTo(g.turn[0], g.turn[1]); ctx.stroke();
    const knob = (p, on, glyph) => { ctx.beginPath(); ctx.arc(p[0], p[1], on ? 14 : 12, 0, 6.2832); ctx.fillStyle = on ? '#ffd24a' : 'rgba(18,16,30,.92)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#ffd24a'; ctx.stroke();
      ctx.fillStyle = on ? '#1a1206' : '#ffd24a'; ctx.font = '700 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(glyph, p[0], p[1] + 1); };
    knob(g.turn, mode === 'turn', '↻'); knob(g.size, mode === 'size', '⤢');
    ctx.beginPath(); ctx.arc(g.cx, g.cy, 4, 0, 6.2832); ctx.fillStyle = '#ffd24a'; ctx.fill();
    ctx.restore(); ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '700 11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(((sp.label || DC.SPOT_AXES[FSt.spot].label) + '').toUpperCase(), 12, 10); ctx.strokeStyle = 'rgba(255,210,74,.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(r, 1); ctx.arcTo(w - 1, 1, w - 1, h - 1, r); ctx.arcTo(w - 1, h - 1, 1, h - 1, r); ctx.arcTo(1, h - 1, 1, 1, r); ctx.arcTo(1, 1, w - 1, 1, r); ctx.closePath(); ctx.stroke();
  }
  // the studio model shows the stored look + the pending decal (never the stored look alone while something is pending)
  let pvT = 0;
  function applyStudio(def) {
    clearTimeout(pvT); const DC = W.DMChars, L = DC.look(def.id); applyLook(S.M, def, FS && FS.pending && FLOW ? FLOW.previewLook(L, FS, def) : L);
  }
  const queuePreview = (def) => { clearTimeout(pvT); pvT = setTimeout(() => applyStudio(def), 90); };
  function commitLook(def) { applyStudio(def); noteGame(def); W.DMChars.list().forEach((d) => { if (d.id === def.id) paintCard(d.id); }); }
  function resetFlow() { clearTimeout(pvT); FS = FL ? FL.newState() : null; }
  function discardPending(def) { if (FS && FS.pending) { FS.pending = false; FS.editIndex = -1; } clearTimeout(pvT); if (def && S.M) applyStudio(def); }
  CS._resetFlow = resetFlow; CS._discardPending = discardPending; CS._flow = () => FS;

  CS.panels.push({
    id: 'logos', label: 'LOGOS', when: (def) => !!FL && Object.keys(def.items || {}).some((i) => def.items[i].spots),
    render(el, ctx) {
      const def = ctx.def, DC = W.DMChars, F = flow(), L = DC.look(def.id), items = Object.keys(def.items).filter((i) => def.items[i].spots), body = $('cs-pbody');
      const mk = (tag, cls, txt) => { const e = D.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
      const btn = (cls, txt, fn, label) => { const b = mk('button', cls, txt); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.addEventListener('click', fn); return b; };
      const rr = () => { const t = body ? body.scrollTop : 0; ctx.rerender(); if (body) body.scrollTop = t; };   // structural change: rebuild, keep the scroll position
      F.pruneSel(FS, L);
      const lgName = (id) => DC.logoById.get(id).label, itName = (id) => def.items[id].label;
      const cnt = (id) => F.count(def, L, id);

      /* 1  pick a logo */
      el.appendChild(mk('div', 'cs-reg-h', '1  PICK A LOGO'));
      const grid = mk('div', 'cs-lgs');
      DC.LOGOS.forEach((lg) => { const b = btn('cs-lg' + (FS.logo === lg.id ? ' on' : ''), '', () => {
        const r = F.pickLogo(FS, lg.id); if (r === 'swapped') { applyStudio(def); toast('Logo swapped: same place, size and turn'); } rr(); }, lg.label); b.title = lg.label; b.innerHTML = svgOf(lg); grid.appendChild(b); });
      el.appendChild(grid);
      if (FS.logo && DC.logoById.get(FS.logo).text) {
        const txt = mk('input', 'cs-txt'); txt.type = 'text'; txt.maxLength = 8; txt.placeholder = 'UP TO 8 LETTERS'; txt.value = FS.text; txt.setAttribute('aria-label', 'Logo text');
        txt.addEventListener('input', () => { FS.text = DC.cleanText(txt.value); if (FS.pending) { drawNow(); queuePreview(def); } }); el.appendChild(txt);
      }

      /* 2  garment */
      el.appendChild(mk('div', 'cs-reg-h', '2  TAP A GARMENT TO PREVIEW IT ON'));
      const chips = mk('div', 'cs-chips');
      items.forEach((id) => { const n = cnt(id), full = n >= DC.MAX_DECALS, on = FS.pending && FS.item === id;
        const b = btn('cs-chip big' + (on ? ' on' : '') + (full ? ' full' : ''), itName(id).toUpperCase() + '  ' + n + '/' + DC.MAX_DECALS + (full ? '  FULL' : ''), () => {
          const r = F.pickItem(FS, def, DC.look(def.id), id);
          if (!r.ok) { toast(r.reason === 'logo' ? 'Pick a logo first' : r.reason === 'full' ? itName(id) + ' is full (' + DC.MAX_DECALS + ' logos). Delete one below first' : 'That logo cannot go there'); return; }
          applyStudio(def); rr(); }, itName(id) + ', ' + n + ' of ' + DC.MAX_DECALS + ' logos'); chips.appendChild(b); });
      el.appendChild(chips);

      let cv = null, live = null, outs = {}, mode = '';
      function drawNow() { if (cv && FS.pending) { live = { x: FS.x, y: FS.y, scale: FS.scale, rotation: FS.rotation }; drawPad(cv, def, FS, live, mode); sync(); } }
      function sync() { if (outs.size) { outs.size.r.value = FS.scale; outs.size.o.textContent = FS.scale.toFixed(2) + 'x'; } if (outs.turn) { outs.turn.r.value = FS.rotation; outs.turn.o.textContent = FS.rotation + '°'; } if (outs.reset) outs.reset.disabled = F.isDefaultPlacement(FS, def); }

      if (!FS.pending) {
        const msg = mk('p', 'cs-hint', !FS.logo ? 'Pick a logo, then tap SHIRT or PANTS. It appears on the Articren as a preview; nothing is saved until you press APPLY.' :
          FS.item ? 'Applied. Add another ' + lgName(FS.logo) + ' on the ' + itName(FS.item) + ' below, pick a different logo, or tap a garment.' : 'Now tap a garment to preview ' + lgName(FS.logo) + ' on it.'); el.appendChild(msg);
        if (FS.logo && FS.item) { const full = cnt(FS.item) >= DC.MAX_DECALS; const b = btn('cs-btn gold cs-wide', full ? itName(FS.item).toUpperCase() + ' IS FULL' : '+ ADD ANOTHER ' + lgName(FS.logo).toUpperCase() + ' ON ' + itName(FS.item).toUpperCase(), () => { const r = F.addAnother(FS, def, DC.look(def.id)); if (r.ok) { applyStudio(def); rr(); } else toast('That garment is full. Delete one first'); }); b.disabled = full; el.appendChild(b); }
      } else {
        /* 3  place it */
        const it = def.items[FS.item], editing = FS.editIndex >= 0;
        el.appendChild(mk('div', 'cs-reg-h', '3  PLACE IT'));
        el.appendChild(mk('div', 'cs-pending', editing ? 'EDITING AN APPLIED LOGO · not saved until you press SAVE' : 'PREVIEW · NOT APPLIED YET'));
        const spots = mk('div', 'cs-chips'); Object.keys(it.spots).forEach((k) => spots.appendChild(btn('cs-chip' + (k === FS.spot ? ' on' : ''), (it.spots[k].label || DC.SPOT_AXES[k].label).toUpperCase(), () => { F.pickSpot(FS, def, k); applyStudio(def); rr(); })));
        el.appendChild(spots);
        const sz = padSize(def, FS.item, FS.spot); cv = mk('canvas', 'cs-pad'); cv.width = sz[0]; cv.height = sz[1]; cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Logo placement pad. Drag to move, corner handle to resize, top knob to turn'); el.appendChild(cv);
        el.appendChild(mk('p', 'cs-pad-help', 'Drag the logo to move it · ⤢ corner = size · ↻ knob = turn · gold dots snap'));
        live = { x: FS.x, y: FS.y, scale: FS.scale, rotation: FS.rotation }; drawPad(cv, def, FS, live, '');
        const info = itemInfo(def, FS.item), v = info && info.views[FS.spot], unit = info ? info.unit : 1, sp = it.spots[FS.spot];
        let off = [0, 0], held = false; const pt = (e) => { const r = cv.getBoundingClientRect(), k = cv.width / (r.width || cv.width); return [(e.clientX - r.left) * k, (e.clientY - r.top) * k, k]; };
        const apply1 = (e) => { const p = pt(e), g = FL.padGeom(v, sp, unit, live, cv.width, cv.height), patch = FL.padDrag(mode, g, live, p[0], p[1], cv.width, cv.height, off, { scaleMin: DC.SCALE_MIN, scaleMax: DC.SCALE_MAX });
          F.setPlacement(FS, def, patch); live = { x: FS.x, y: FS.y, scale: FS.scale, rotation: FS.rotation }; drawPad(cv, def, FS, live, mode); sync(); };
        cv.addEventListener('pointerdown', (e) => { const p = pt(e), g = FL.padGeom(v, sp, unit, live, cv.width, cv.height); mode = FL.padHit(g, p[0], p[1], 24 * p[2]); held = true; try { cv.setPointerCapture(e.pointerId); } catch (_) { }
          off = mode === 'move' && Math.hypot(p[0] - g.cx, p[1] - g.cy) <= g.half * 1.25 ? [p[0] - g.cx, p[1] - g.cy] : [0, 0]; apply1(e); e.preventDefault(); });
        cv.addEventListener('pointermove', (e) => { if (held) apply1(e); });
        const end = () => { if (!held) return; held = false; if (mode === 'move') F.setPlacement(FS, def, { snap: true }); mode = ''; drawNow(); queuePreview(def); };
        cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
        const stepper = (key, label, min, max, step, fmt, big, set) => { const row = mk('div', 'cs-row'); row.appendChild(mk('span', 'cs-rl', label));
          const dn = btn('cs-step', '−', () => { set(Math.max(min, +r.value - big)); }, label + ' down'), up = btn('cs-step', '+', () => { set(Math.min(max, +r.value + big)); }, label + ' up');
          const r = mk('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = FS[key]; r.setAttribute('aria-label', label); const o = mk('output', '', fmt(FS[key]));
          r.addEventListener('input', () => { F.setPlacement(FS, def, { [key]: +r.value }); drawNow(); }); r.addEventListener('change', () => queuePreview(def));
          row.appendChild(dn); row.appendChild(r); row.appendChild(up); row.appendChild(o); el.appendChild(row); outs[key === 'scale' ? 'size' : 'turn'] = { r, o }; };
        stepper('scale', 'SIZE', DC.SCALE_MIN, DC.SCALE_MAX, 0.05, (x) => (+x).toFixed(2) + 'x', 0.1, (x) => { F.setPlacement(FS, def, { scale: x }); drawNow(); queuePreview(def); });
        stepper('rotation', 'TURN', -180, 180, 5, (x) => x + '°', 15, (x) => { F.setPlacement(FS, def, { rotation: x }); drawNow(); queuePreview(def); });
        el.appendChild(mk('div', 'cs-reg-h', 'LOGO COLOUR'));
        const sw = mk('div', 'cs-sws'), setCol = (hex) => { F.setPlacement(FS, def, { colour: hex }); applyStudio(def); rr(); };
        DC.PALETTE_CLOTH.concat(['#ffffff']).forEach((hex) => { const b = btn('cs-sw' + (FS.colour === hex ? ' on' : ''), '', () => setCol(hex), 'Logo colour ' + hex); b.style.background = hex; sw.appendChild(b); });
        const plus = btn('cs-sw custom', '+', () => openPicker(FS.colour || '#ffffff', (h) => { F.setPlacement(FS, def, { colour: h }); applyStudio(def); }, setCol, plus, 'Custom logo colour'), 'Custom logo colour');
        sw.appendChild(plus); el.appendChild(sw);
        /* actions: always in reach (sticky) */
        const bar = mk('div', 'cs-actbar'), chk = F.canApply(FS, def, L);
        const rs = btn('cs-btn', 'RESET', () => { F.reset(FS, def); applyStudio(def); rr(); }, 'Reset position, size and turn to default'); rs.disabled = F.isDefaultPlacement(FS, def); outs.reset = rs;
        const cn = btn('cs-btn', 'CANCEL', () => { F.cancel(FS); applyStudio(def); rr(); }, 'Cancel this logo');
        const ap = btn('cs-btn gold cs-apply', editing ? 'SAVE ✓' : 'APPLY ✓', () => {
          const idx = F.apply(FS, def); if (idx < 0) { const why = F.canApply(FS, def, DC.look(def.id)).reason; toast(why === 'text' ? 'Type some text first' : why === 'full' ? itName(FS.item) + ' is full. Delete one first' : 'Could not apply that logo'); return; }
          commitLook(def); toast((editing ? 'Saved' : 'Applied') + ' · ' + itName(FS.item) + ' ' + cnt(FS.item) + '/' + DC.MAX_DECALS); rr(); }, editing ? 'Save changes' : 'Apply this logo');
        ap.disabled = !chk.ok; bar.appendChild(rs); bar.appendChild(cn); bar.appendChild(ap); el.appendChild(bar);
      }

      /* applied logos: select -> delete, edit, clear a garment */
      const total = L.decals.length;
      el.appendChild(mk('div', 'cs-reg-h', 'APPLIED LOGOS  ' + total));
      if (!total) el.appendChild(mk('p', '', 'No logos applied. Your Articren keeps her original look until you add one.'));
      else {
        const list = mk('div', 'cs-applied'); L.decals.forEach((d, i) => { const sel = FS.sel.includes(i), row = mk('div', 'cs-arow' + (sel ? ' sel' : '') + (FS.editIndex === i ? ' editing' : ''));
          const pick = btn('cs-apick', '', () => { F.toggleSel(FS, i); rr(); }, (sel ? 'Deselect ' : 'Select ') + lgName(d.id) + ' on ' + itName(d.item)); pick.setAttribute('aria-pressed', sel ? 'true' : 'false');
          const ic = mk('span', 'cs-aic'); ic.innerHTML = svgOf(DC.logoById.get(d.id)); ic.style.color = d.colour; pick.appendChild(ic);
          const tx = mk('span', 'cs-atx'); tx.appendChild(mk('b', '', (d.text ? d.text : lgName(d.id)).toUpperCase())); tx.appendChild(mk('i', '', itName(d.item) + ' · ' + (def.items[d.item].spots[d.spot].label || DC.SPOT_AXES[d.spot].label))); pick.appendChild(tx);
          const mark = mk('span', 'cs-achk', sel ? '✓' : ''); pick.appendChild(mark); row.appendChild(pick);
          row.appendChild(btn('cs-aedit', 'EDIT', () => { F.edit(FS, def, DC.look(def.id), i); applyStudio(def); rr(); }, 'Edit ' + lgName(d.id) + ' on ' + itName(d.item))); list.appendChild(row); });
        el.appendChild(list);
        const acts = mk('div', 'cs-chips');
        const del = btn('cs-btn cs-danger', 'DELETE SELECTED' + (FS.sel.length ? ' (' + FS.sel.length + ')' : ''), () => { const n = F.deleteSelected(FS, def); commitLook(def); toast(n + (n === 1 ? ' logo' : ' logos') + ' deleted'); rr(); }); del.disabled = !FS.sel.length; acts.appendChild(del);
        const all = btn('cs-btn', FS.sel.length === total ? 'SELECT NONE' : 'SELECT ALL', () => { if (FS.sel.length === total) FS.sel = []; else F.selectAll(FS, DC.look(def.id)); rr(); }); acts.appendChild(all);
        items.forEach((id) => { const n = cnt(id); if (!n) return; acts.appendChild(btn('cs-btn cs-danger', 'CLEAR ALL ON ' + itName(id).toUpperCase() + ' (' + n + ')', () => { const k = F.clearGarment(FS, def, id); commitLook(def); toast(k + (k === 1 ? ' logo' : ' logos') + ' cleared from ' + itName(id)); rr(); })); });
        el.appendChild(acts);
      }
    },
  });

  /* ───────────────────────── card-wheel backdrop (ui/dm-menuworld.js: observation deck) ─────────────────────────
     The screen holds one lease on the shared renderer while the wheel is up (the canvas lives in #cs-bg behind the cards); the studio borrows the same canvas and gives it back.
     Off / failed -> the flat CSS gradient.  Nothing here touches the paint panel. */
  const CW = { w: null, leased: false, token: 0 };
  function bgHost() { return $('cs-bg'); }
  function backToBg() { try { const h = bgHost(); if (h && R.canvas && R.canvas.parentNode !== h) h.appendChild(R.canvas); } catch (e) { } }
  async function startCardWorld() {
    const MW = W.DMMenuWorld; if (!MW || !MW.active() || CW.w || CW.leased) return; const token = ++CW.token, host = bgHost(); if (!host) return;
    try {
      CW.leased = true; const r = await acquire(host);
      if (token !== CW.token || !CS.entered) { CW.leased = false; release(); return; }
      if (CS.studioOpen) { backToBg(); }
      R.canvas.style.visibility = thumbBusy ? 'hidden' : '';
      CW.w = MW.cardWorld({ THREE: W.THREE, renderer: r, host, wheel: $('cs-wheel'), busy: () => thumbBusy });
      if (!CW.w) { CW.leased = false; release(); return; }
      $('screen-character').classList.add('mw-on'); CW.w.pause(CS.studioOpen); CW.w.start();
    } catch (e) { log('card world failed', e && e.message); stopCardWorld(); }
  }
  function stopCardWorld() {
    CW.token++; if (CW.w) { try { CW.w.dispose(); } catch (e) { } CW.w = null; }
    const sc = $('screen-character'); if (sc) sc.classList.remove('mw-on'); if (R.canvas) R.canvas.style.visibility = ''; try { const h = bgHost(); if (h) h.style.backgroundImage = ''; } catch (e) { }
    if (CW.leased) { CW.leased = false; release(); }
  }
  function setThumbBusy(b) {   // thumbnails resize + draw on the shared canvas: park a still of the deck behind the cards meanwhile (no flash of black)
    thumbBusy = b;
    try {
      const host = bgHost(); if (!R.canvas || !CW.w || !host) return;
      if (b) {
        try { CW.w.renderOnce(performance.now()); const c = D.createElement('canvas'), k = Math.min(1, 640 / Math.max(1, R.canvas.width)); c.width = Math.max(2, Math.round(R.canvas.width * k)); c.height = Math.max(2, Math.round(R.canvas.height * k));
          c.getContext('2d').drawImage(R.canvas, 0, 0, c.width, c.height); host.style.backgroundImage = 'url(' + c.toDataURL('image/jpeg', 0.7) + ')'; } catch (e) { }
        R.canvas.style.visibility = 'hidden';
      } else { R.canvas.style.visibility = ''; setTimeout(() => { if (!thumbBusy) host.style.backgroundImage = ''; }, 250); }
    } catch (e) { }
  }

  /* ───────────────────────── screen lifecycle ───────────────────────── */
  CS.enter = function () {
    if (!W.DMChars) return; CS.entered = true;
    const sc = $('screen-character'); if (sc) sc.classList.remove('cs-leaving');
    const studio = $('cs-studio');
    if (studio && !CS.studioOpen) { studio.classList.remove('open', 'leaving'); studio.style.clipPath = ''; studio.style.transition = ''; }
    const pick = W.DMChars.selectedId();
    uiApply(uiMachine(UI, { type: 'enter', pickedId: pick }));
    buildCards(); requestAnimationFrame(() => { const i = Math.max(0, W.DMChars.list().findIndex((d) => d.id === W.DMChars.selectedId())); centreOn(i, false); layoutWheel(); });
    bindStage(); refreshFoot(); startCardWorld(); kickThumbs();
  };
  CS.leave = function () {
    CS.entered = false; thumbAbort = true; uiApply(uiMachine(UI, { type: 'leave' }));
    if (CS.studioOpen) closeStudio({ thumb: false, visual: false, immediate: true }); stopCardWorld();
    clearTimeout(R.killT); if (R.leases === 0 && R.r) { try { R.r.dispose(); } catch (e) { } try { R.canvas && R.canvas.parentNode && R.canvas.parentNode.removeChild(R.canvas); } catch (e) { } R.r = null; R.canvas = null; }
    uiApply(uiMachine(UI, { type: 'idle' }));
  };
  CS.openStudio = (id) => openStudio(id, cardFace(D.querySelector('#cs-wheel .cs-card-slot[data-id="' + id + '"]')));
  CS.closeStudio = closeStudio;
  CS.status = () => ({ studioOpen: CS.studioOpen, renderer: !!R.r, leases: R.leases, thumbs: Object.keys(thumbs), loop: !!S.raf, model: !!S.M });
  CS.refreshLook = () => applyStudio(S.def);   // re-apply the stored look to the open studio model (panels call it; tests / tools too)
  CS._studio = S; CS._R = R; CS._CW = CW; CS.paintCard = paintCard; CS.frame = frame; CS.layoutStudio = layoutStudio; CS.renderPanel = renderPanel;

  function init() {
    const wheel = $('cs-wheel'); if (!wheel) return;
    let sT = 0; wheel.addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; layoutWheel(); }); clearTimeout(sT); }, { passive: true });
    wheel.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { centreOn(Math.min(cards().length - 1, activeIdx + 1), true); e.preventDefault(); } else if (e.key === 'ArrowLeft') { centreOn(Math.max(0, activeIdx - 1), true); e.preventDefault(); } });
    $('cs-back').addEventListener('click', () => W.goScreen('menu'));
    $('cs-next').addEventListener('click', () => { const cur = W.DMChars.list()[activeIdx]; if (cur && cur.ready) W.DMChars.setSelected(cur.id); const r = W.DMChars.resolveForGame(); if (r.fellBack) toast(W.DMChars.get(r.wanted).name + ' is not flyable yet: flying as ' + r.def.name); W.goScreen('builder'); });
    $('cs-sback').addEventListener('click', () => closeStudio());
    $('cs-sselect').addEventListener('click', choose);
    D.addEventListener('keydown', (e) => { if (e.key === 'Escape' && CS.studioOpen && ST() === 'character') closeStudio(); });
    addEventListener('resize', () => { if (CS.studioOpen) layoutStudio(); if (ST() === 'character') layoutWheel(); });
    D.addEventListener('visibilitychange', () => { S.last = 0; });
    if (W.DMChars) W.DMChars.onChange(() => { if (CS.entered) W.DMChars.list().forEach((d) => paintCard(d.id)); });
    CS.ready = true;
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
})();
