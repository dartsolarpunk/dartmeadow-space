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
        r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05; r.setClearColor(0x000000, 0);
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
  function applyLook(M, def) {
    if (!M || !M.root || !W.DMCharPaint || !W.DMChars) return; const L = W.DMChars.look(def.id);
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
        const mod = await import(W.DM_HAIR_MODULE || new URL('hair_strands.js', D.baseURI).href);
        let cfg; if (def.hair.configUrl) { const r = await fetch(def.hair.configUrl); if (r.ok) cfg = await r.json(); }
        const CHAR = { root: M.root, bones: M.bones, mixer: M.mixer };
        M.charLike = CHAR;
        M.hair = await mod.attachHairStrands(CHAR, THREE, { url: def.hair.url, config: cfg, character: !!cfg, getStrandFraction: () => (o.strandFraction || 0.6),
          getCollisionTier: () => 0, getCalm: () => false, params: { autoQuality: false } });
        if (M.dead) { try { M.hair.dispose(); } catch (e) { } M.hair = null; }
      } catch (e) { log('hair not attached', e && e.message); }
    }
    applyLook(M, def);
    return M;
  }
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
    S.add(new THREE.HemisphereLight(0x9aa6d8, 0x3a1c14, 0.9));
    const key = new THREE.DirectionalLight(0xffd7a8, 2.6); key.position.set(1.6, 2.6, 2.4); S.add(key);
    const rim = new THREE.DirectionalLight(0x6a8cff, 1.9); rim.position.set(-2.2, 1.6, -2.0); S.add(rim);
    const fill = new THREE.DirectionalLight(0xff9a70, 0.5); fill.position.set(-1.5, 0.4, 1.8); S.add(fill);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(1.35, 40), new THREE.MeshStandardMaterial({ color: 0x4a2418, roughness: 0.96, metalness: 0 })); pad.rotation.x = -Math.PI / 2; S.add(pad); items.push(pad);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.27, 1.31, 64), new THREE.MeshBasicMaterial({ color: 0x5b7fff, transparent: true, opacity: 0.85, toneMapped: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; S.add(ring); items.push(ring);
    let sd = 7; const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    const rm = new THREE.MeshStandardMaterial({ color: 0x5b2f20, roughness: 0.98, flatShading: true }); items.push(rm);
    for (let i = 0; i < 7; i++) {
      const a = 2.3 + i * 0.52 + rnd() * 0.25, d = 0.95 + rnd() * 0.3, r = 0.05 + rnd() * 0.11;
      const g = new THREE.IcosahedronGeometry(r, 0), m = new THREE.Mesh(g, rm); m.position.set(Math.cos(a) * d, r * 0.45, -Math.sin(a) * d * 0.9 - 0.15); m.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6); m.scale.set(1, 0.7, 1.1); S.add(m); items.push(g);
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
    if (thumbBusy) return; thumbBusy = true; thumbAbort = false;
    try {
      for (const def of W.DMChars.list()) {
        if (thumbAbort || ST() !== 'character' || CS.studioOpen) break;
        const have = thumbs[def.id]; if (have && have.sig === thumbSig(def)) continue;
        setCardLoading(def.id, true); await captureThumb(def); setCardLoading(def.id, false); paintCard(def.id);
        await sleep(60);
      }
    } finally { thumbBusy = false; }
  }
  function kickThumbs() { if (thumbBusy) return; setTimeout(() => { if (ST() === 'character' && !CS.studioOpen) runThumbs(); }, 250); }

  /* ───────────────────────── the card wheel ───────────────────────── */
  let activeIdx = 0, scrollRaf = 0;
  const cards = () => Array.from(D.querySelectorAll('#cs-wheel .cs-card'));
  function buildCards() {
    const wheel = $('cs-wheel'); if (!wheel) return; wheel.textContent = '';
    W.DMChars.list().forEach((def) => {
      const b = D.createElement('button'); b.type = 'button'; b.className = 'cs-card'; b.dataset.id = def.id; b.setAttribute('role', 'option'); b.setAttribute('aria-label', def.name);
      b.innerHTML = '<span class="cs-thumbwrap"><img class="cs-thumb empty" alt="" decoding="async"><span class="cs-spin">LOADING<br>PORTRAIT</span></span><span class="cs-meta"><span class="cs-name"></span><span class="cs-tag"></span></span><span class="cs-badge" hidden></span>';
      b.querySelector('.cs-name').textContent = def.name.toUpperCase(); b.querySelector('.cs-tag').textContent = def.tag || '';
      b.addEventListener('click', () => onCardTap(def.id));
      wheel.appendChild(b);
    });
    const dots = $('cs-dots'); if (dots) { dots.textContent = ''; W.DMChars.list().forEach(() => dots.appendChild(D.createElement('i'))); }
    W.DMChars.list().forEach((d) => paintCard(d.id));
  }
  function paintCard(id) {
    const def = W.DMChars.get(id), el = D.querySelector('#cs-wheel .cs-card[data-id="' + id + '"]'); if (!def || !el) return;
    const url = thumbFor(def), img = el.querySelector('.cs-thumb'), sp = el.querySelector('.cs-spin');
    if (url) { if (img.getAttribute('src') !== url) img.src = url; img.classList.remove('empty'); sp.style.display = 'none'; } else { img.classList.add('empty'); sp.style.display = ''; }
    const chosen = W.DMChars.selectedId() === id; el.classList.toggle('chosen', chosen && def.ready);
    const bd = el.querySelector('.cs-badge'); if (!def.ready) { bd.hidden = false; bd.textContent = 'SOON'; bd.className = 'cs-badge soon'; } else if (chosen) { bd.hidden = false; bd.textContent = '✓ CHOSEN'; bd.className = 'cs-badge'; } else bd.hidden = true;
  }
  function setCardLoading(id, on) { const el = D.querySelector('#cs-wheel .cs-card[data-id="' + id + '"] .cs-spin'); if (el && !thumbFor(W.DMChars.get(id))) el.textContent = on ? 'RENDERING…' : 'LOADING…'; }
  function layoutWheel() {   // scroll-driven transform: the centred card is full size, the others turn away and shrink.  Runs on scroll only.
    const wheel = $('cs-wheel'); if (!wheel) return; const mid = wheel.scrollLeft + wheel.clientWidth / 2; let best = 0, bd = 1e9; const cs = cards();
    cs.forEach((c, i) => {
      const cx = c.offsetLeft + c.offsetWidth / 2, d = (cx - mid) / (c.offsetWidth + 20), ad = Math.min(1.6, Math.abs(d));
      c.style.transform = 'translateZ(' + (-ad * 90).toFixed(1) + 'px) rotateY(' + (Math.max(-1, Math.min(1, d)) * -26).toFixed(1) + 'deg) scale(' + (1 - ad * 0.1).toFixed(3) + ')'; c.style.opacity = String(Math.max(0.45, 1 - ad * 0.38));
      if (Math.abs(cx - mid) < bd) { bd = Math.abs(cx - mid); best = i; }
    });
    activeIdx = best; cs.forEach((c, i) => c.classList.toggle('on', i === best)); const dots = D.querySelectorAll('#cs-dots i'); dots.forEach((d, i) => d.classList.toggle('on', i === best));
    refreshFoot();
  }
  function centreOn(i, smooth) { const c = cards()[i]; const wheel = $('cs-wheel'); if (!c || !wheel) return; wheel.scrollTo({ left: c.offsetLeft + c.offsetWidth / 2 - wheel.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' }); }
  function onCardTap(id) {
    const i = W.DMChars.list().findIndex((d) => d.id === id);
    if (i !== activeIdx) { centreOn(i, true); return; }
    openStudio(id, D.querySelector('#cs-wheel .cs-card[data-id="' + id + '"]'));
  }
  function refreshFoot() {
    const sel = W.DMChars.get(W.DMChars.selectedId()), nx = $('cs-next');
    if (nx) nx.textContent = (sel ? 'CONTINUE AS ' + sel.name.toUpperCase() : 'CONTINUE') + ' ⟶';
    const cur = W.DMChars.list()[activeIdx], cb = $('cs-open'); if (cb && cur) cb.textContent = (cur.ready ? 'VIEW ' : 'PREVIEW ') + cur.name.toUpperCase();
  }

  /* ───────────────────────── the studio ───────────────────────── */
  const S = { M: null, X: null, cam: null, F: null, raf: 0, yaw: 0, vyaw: 0, dragging: false, pointers: new Map(), pinch0: 0, zoom: 1, pitch: 0, last: 0, accum: 0, nextExtra: 0, look: 0, lookT: 0, def: null, token: 0, leased: false };
  async function openStudio(id, fromEl) {
    const def = W.DMChars.get(id); if (!def || CS.studioOpen) return;
    CS.studioOpen = true; thumbAbort = true; const token = ++S.token; S.def = def;
    const root = $('cs-studio'), stage = $('cs-stage');
    $('cs-pname').textContent = def.name.toUpperCase(); $('cs-ptag').textContent = def.tag || '';
    $('cs-load').textContent = 'LOADING ' + def.name.toUpperCase() + '…'; $('cs-load').style.display = ''; $('cs-turn').classList.remove('gone');
    renderPanel(); layoutStudio();
    // expand from the card's rectangle
    root.classList.add('open'); stage.classList.remove('drag');
    try {
      const r = fromEl && fromEl.getBoundingClientRect(), w = innerWidth, h = innerHeight;
      if (r && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        root.style.transition = 'none'; root.style.clipPath = 'inset(' + r.top + 'px ' + (w - r.right) + 'px ' + (h - r.bottom) + 'px ' + r.left + 'px round 14px)'; void root.offsetWidth;
        root.style.transition = 'clip-path .32s cubic-bezier(.2,.9,.25,1)'; root.style.clipPath = 'inset(0 0 0 0 round 0px)';
      } else { root.style.transition = 'none'; root.style.clipPath = 'none'; }
    } catch (e) { root.style.clipPath = 'none'; }
    try {
      while (thumbBusy) await sleep(40);   // the thumbnail job sees thumbAbort and lets go of the renderer within a frame or two
      if (token !== S.token) return;
      const r = await acquire(stage); S.leased = true;
      if (token !== S.token) { release(); S.leased = false; return; }
      S.X = buildSet(false);
      const M = await buildCharacter(def, { anims: true, hair: true, strandFraction: 0.75, onProgress: (p) => { if (token === S.token) $('cs-load').textContent = 'LOADING ' + def.name.toUpperCase() + ' ' + Math.round(p * 100) + '%'; } });
      if (token !== S.token) { disposeCharacter(M); return; }
      S.M = M; S.X.scene.add(M.root); M.root.position.y = 0;
      M.root.updateMatrixWorld(true); const minY = new W.THREE.Box3().setFromObject(M.root).min.y; M.root.position.y = -minY; M.root.updateMatrixWorld(true);
      S.cam = new W.THREE.PerspectiveCamera(30, 1, 0.05, 60); S.yaw = 0.35; S.vyaw = 0; S.zoom = 1; S.pitch = 0; S.F = null;
      try { CS.onStudioModel && CS.onStudioModel(M, def); } catch (e) { log('onStudioModel', e); }
      $('cs-load').style.display = 'none'; S.last = 0; S.accum = 0; S.nextExtra = performance.now() + 2200; S.look = 0;
      layoutStudio(); startLoop();
    } catch (e) {
      log('studio failed', e && e.message); $('cs-load').textContent = 'COULD NOT LOAD ' + def.name.toUpperCase() + ' HERE'; toast('Could not load ' + def.name + ' on this device');
    }
  }
  function closeStudio(opts) {
    if (!CS.studioOpen) return; opts = opts || {}; const token = ++S.token; void token;
    stopLoop();
    // refresh the card's still from the live model (colours / logos show on the card), then let everything go
    let refreshed = false;
    try { if (S.M && S.M.root && R.r && opts.thumb !== false && S.F) refreshed = grabThumbFromStudio(); } catch (e) { log('thumb refresh', e && e.message); }
    try { CS.onStudioClose && CS.onStudioClose(); } catch (e) { }
    disposeCharacter(S.M); disposeSet(S.X); S.M = null; S.X = null; S.cam = null; S.F = null; S.pointers.clear();
    if (S.leased) { S.leased = false; release(); }
    const root = $('cs-studio'); root.classList.remove('open'); root.style.clipPath = ''; root.style.transition = '';
    CS.studioOpen = false; if (refreshed) paintCard(S.def.id);
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
    const w = Math.max(10, stage.clientWidth), h = Math.max(10, stage.clientHeight), pr = Math.min(devicePixelRatio || 1, 1.5);
    if (r._csW !== w || r._csH !== h || r._csPR !== pr) { r._csW = w; r._csH = h; r._csPR = pr; r.setPixelRatio(pr); r.setSize(w, h, false); }
    S.cam.aspect = w / h; S.cam.updateProjectionMatrix(); if (S.M) S.F = frame(S.M, w / h, 'full');
  }
  function startLoop() { if (S.raf) return; S.last = 0; const tick = (t) => { S.raf = requestAnimationFrame(tick); studioFrame(t); }; S.raf = requestAnimationFrame(tick); }
  function stopLoop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  const _q = { tmp: null };
  function studioFrame(t) {
    if (!S.M || !S.M.root || !R.r || D.hidden) { S.last = 0; return; }
    if (S.last && t - S.last < 30) return;                 // 30 fps cap: this is a menu
    const dt = S.last ? Math.min(0.1, (t - S.last) / 1000) : 0.016; S.last = t;
    if (R.r._csW !== $('cs-stage').clientWidth || R.r._csH !== $('cs-stage').clientHeight) layoutStudio();
    const THREE = W.THREE, M = S.M;
    // turntable: drag spins, release keeps a little inertia, otherwise a slow idle drift so it reads as a live stage
    if (!S.dragging) { S.yaw += S.vyaw * dt; S.vyaw *= Math.pow(0.02, dt); if (Math.abs(S.vyaw) < 0.05) S.vyaw = 0; }
    M.root.rotation.y = S.yaw;
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
      _q.tmp.setFromEuler(_q.e.set(S.look * 0.05, S.look * 0.6, 0)); head.quaternion.multiply(_q.tmp);
      if (neck) { _q.n.setFromEuler(_q.e.set(0, S.look * 0.35, 0)); neck.quaternion.multiply(_q.n); }
    }
    // camera
    const F = S.F; if (F) {
      const d = F.dist * S.zoom, py = S.pitch; S.cam.position.set(0, F.camY + Math.sin(py) * d * 0.6, Math.cos(py) * d); S.cam.lookAt(F.target); S.cam.updateMatrixWorld(true);
    }
    R.r.render(S.X.scene, S.cam);
    CS.onStudioFrame && CS.onStudioFrame(dt);
  }
  function bindStage() {
    const st = $('cs-stage'); if (!st || st._bound) return; st._bound = true;
    st.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return; try { st.setPointerCapture(e.pointerId); } catch (_) { }
      S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
      if (S.pointers.size === 1) { S.dragging = true; st.classList.add('drag'); S.vyaw = 0; $('cs-turn').classList.add('gone'); }
      if (S.pointers.size === 2) { const p = Array.from(S.pointers.values()); S.pinch0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); S.zoom0 = S.zoom; }
    });
    st.addEventListener('pointermove', (e) => {
      const p = S.pointers.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      const rc = st.getBoundingClientRect(); S.dragX = ((e.clientX - rc.left) / rc.width - 0.5) * 2;
      if (S.pointers.size >= 2) { const a = Array.from(S.pointers.values()); const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); if (S.pinch0 > 8) S.zoom = Math.max(0.4, Math.min(1.25, S.zoom0 * S.pinch0 / Math.max(8, d))); return; }
      S.yaw += dx * 0.011; S.vyaw = dx * 0.011 * 30 * 0.6 + S.vyaw * 0.4; S.pitch = Math.max(-0.22, Math.min(0.3, S.pitch + dy * 0.003));
    });
    const up = (e) => {
      const p = S.pointers.get(e.pointerId); S.pointers.delete(e.pointerId);
      if (p && CS.onStageTap && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 8 && performance.now() - p.t0 < 450) { try { CS.onStageTap(e, st); } catch (er) { log('tap', er); } }
      if (S.pointers.size === 0) { S.dragging = false; S.dragX = null; st.classList.remove('drag'); }
    };
    st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
    st.addEventListener('wheel', (e) => { e.preventDefault(); S.zoom = Math.max(0.4, Math.min(1.25, S.zoom * (1 + Math.sign(e.deltaY) * 0.07))); }, { passive: false });
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
    try { if (typeof CHAR !== 'undefined' && CHAR.loaded && CHAR.charId && CHAR.charId !== def.id) toast(def.name + ' will fly from the next game start (this session already has ' + (W.DMChars.get(CHAR.charId) || { name: 'another pilot' }).name + ' loaded; reload to switch)', 4600); } catch (e) { } W.DMChars.list().forEach((d) => paintCard(d.id)); refreshFoot(); toast('Pilot: ' + def.name);
  }

  /* ───────────────────────── COLOURS panel (registry regions: hair groups + clothing items) ───────────────────────── */
  let activeRegion = null;
  function swatchGrid(region, def, rerender) {
    const wrap = D.createElement('div'); wrap.className = 'cs-reg';
    const grid = D.createElement('div'); grid.className = 'cs-sws'; wrap.appendChild(grid);
    const cur = (W.DMChars.look(def.id).colors || {})[region.id] || null;
    const pal = region.kind === 'hair' ? W.DMChars.PALETTE_HAIR : W.DMChars.PALETTE_CLOTH;
    const mk = (cls, label) => { const b = D.createElement('button'); b.type = 'button'; b.className = 'cs-sw ' + cls; b.setAttribute('aria-label', label); b.title = label; return b; };
    const pick = (hex) => { W.DMChars.setColor(def.id, region.id, hex); applyLook(S.M, def); noteGame(def); rerender(); };
    const d0 = mk('def' + (cur ? '' : ' on'), region.label + ' default'); d0.textContent = 'DEF'; d0.addEventListener('click', () => pick(null)); grid.appendChild(d0);
    pal.forEach((hex) => { const b = mk(cur === hex ? 'on' : '', region.label + ' ' + hex); b.style.background = hex; b.addEventListener('click', () => pick(hex)); grid.appendChild(b); });
    const lb = D.createElement('label'); lb.className = 'cs-sw custom' + (cur && !pal.includes(cur) ? ' on' : ''); lb.title = region.label + ' custom colour'; lb.setAttribute('aria-label', region.label + ' custom colour');
    const inp = D.createElement('input'); inp.type = 'color'; inp.value = cur || region.defaultColor || '#808080'; lb.appendChild(inp); lb.insertAdjacentHTML('beforeend', '<span>+</span>');
    let tm = 0; inp.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { W.DMChars.setColor(def.id, region.id, inp.value); applyLook(S.M, def); noteGame(def); }, 220); });
    inp.addEventListener('change', () => { clearTimeout(tm); pick(inp.value); });
    grid.appendChild(lb); return wrap;
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
      const p = D.createElement('p'); p.textContent = 'DEF keeps her original look.'; el.appendChild(p);
      const rb = D.createElement('button'); rb.type = 'button'; rb.className = 'cs-btn cs-reset'; rb.textContent = 'RESET TO DEFAULT'; rb.disabled = W.DMChars.isDefaultLook(L);
      rb.addEventListener('click', () => { W.DMChars.resetLook(def.id); applyLook(S.M, def); ctx.rerender(); }); el.appendChild(rb);
    },
  });

  /* ───────────────────────── screen lifecycle ───────────────────────── */
  CS.enter = function () {
    if (!W.DMChars) return; CS.entered = true;
    buildCards(); requestAnimationFrame(() => { const i = Math.max(0, W.DMChars.list().findIndex((d) => d.id === W.DMChars.selectedId())); centreOn(i, false); layoutWheel(); });
    bindStage(); refreshFoot(); kickThumbs();
  };
  CS.leave = function () {
    CS.entered = false; thumbAbort = true; if (CS.studioOpen) closeStudio({ thumb: false });
    clearTimeout(R.killT); if (R.leases === 0 && R.r) { try { R.r.dispose(); } catch (e) { } try { R.canvas && R.canvas.parentNode && R.canvas.parentNode.removeChild(R.canvas); } catch (e) { } R.r = null; R.canvas = null; }
  };
  CS.openStudio = (id) => openStudio(id, D.querySelector('#cs-wheel .cs-card[data-id="' + id + '"]'));
  CS.closeStudio = closeStudio;
  CS.status = () => ({ studioOpen: CS.studioOpen, renderer: !!R.r, leases: R.leases, thumbs: Object.keys(thumbs), loop: !!S.raf, model: !!S.M });
  CS.refreshLook = () => applyLook(S.M, S.def);   // re-apply the stored look to the open studio model (panels call it; tests / tools too)
  CS._studio = S; CS._R = R; CS.paintCard = paintCard; CS.frame = frame; CS.layoutStudio = layoutStudio; CS.renderPanel = renderPanel;

  function init() {
    const wheel = $('cs-wheel'); if (!wheel) return;
    let sT = 0; wheel.addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; layoutWheel(); }); clearTimeout(sT); }, { passive: true });
    wheel.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { centreOn(Math.min(cards().length - 1, activeIdx + 1), true); e.preventDefault(); } else if (e.key === 'ArrowLeft') { centreOn(Math.max(0, activeIdx - 1), true); e.preventDefault(); } });
    $('cs-back').addEventListener('click', () => W.goScreen('menu'));
    $('cs-next').addEventListener('click', () => { const r = W.DMChars.resolveForGame(); if (r.fellBack) toast(W.DMChars.get(r.wanted).name + ' is not flyable yet: flying as ' + r.def.name); W.goScreen('builder'); });
    $('cs-open').addEventListener('click', () => { const d = W.DMChars.list()[activeIdx]; if (d) CS.openStudio(d.id); });
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
