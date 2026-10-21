/* dm-bt-terminal.js — v122: the engineering-office desk terminal (beside Madison) becomes a holographic glass panel.
 *
 *  In-world: the old monitor body / neck / neon strip (felt + glow triangles around the screen) are dropped from the
 *  merged FX_BTE_Office draw meshes at runtime (index-buffer filter, nothing else touched; the foot stays as the
 *  emitter base). The BTE_Screen plane becomes see-through glass: a 512×320 canvas (Autumn UI + the background video
 *  at reduced alpha + emissive edge glow) redrawn at ~10 fps, and only while it is on screen and near.
 *  No iframe is ever rendered into the 3D scene.
 *  Interaction: one BTI interactable, zone 'aim' (≈1.8 m and crosshair on the panel), E / F / the HUD button → USE.
 *  USE opens a see-through glass overlay holding the in-game guest edition of Autumn (leatr.xyz/?embed=jots).
 *  While it is open game input is paused (keys swallowed, held keys released, pointer lock released). X / Esc close.
 *  Purely additive: no temple geometry, collision or GLB is changed. Tuning: window.BTT.cfg (live).
 */
(function () {
  'use strict';
  const cfg = {
    url: 'https://leatr.xyz/?embed=jots', video: 'assets/bt-engineering/autumn-bg.mp4',
    fps: 10, nearR: 14, zoneM: 1.8, aimM: 0.55, videoAlpha: 0.42, glassAlpha: 0.16,
    accent: '#ff0073', bg1: '#6f00ff', bg2: '#00ff73',      // Justin's Autumn palette "Data Ariel"
    // terminal cut box, relative to the screen centre in the office glTF frame (Blender x, z, -y)
    cut: { x: 0.8, y0: -0.8, y1: 0.55, z0: -0.2, z1: 0.2 },
  };
  const BTT = { cfg, ready: false, open: false, mesh: null, ix: null };
  window.BTT = BTT;
  let THREE, cv, ctx, tex, vid, last = 0, frame = 0;

  function cutMonitor(sc, scr) {
    // screen centre in the BTE_Engineering frame; drop triangles of the other static meshes inside the cut box
    sc.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(sc.matrixWorld).invert();
    if (!scr.geometry.boundingBox) scr.geometry.computeBoundingBox();
    const c = scr.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, scr.matrixWorld));
    const K = cfg.cut, m = new THREE.Matrix4(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
    let dropped = 0;
    sc.traverse(o => {
      if (!o.isMesh || o === scr || !o.geometry || !o.geometry.attributes.position) return;
      const mn = (Array.isArray(o.material) ? o.material[0] : o.material) || {};
      if (!/^BTE_(Felt|Glow)$/.test(mn.name || '')) return;
      const g = o.geometry, pos = g.attributes.position, idx = g.index; if (!idx) return;
      m.multiplyMatrices(inv, o.matrixWorld);
      const src = idx.array, keep = [];
      for (let i = 0; i + 2 < src.length; i += 3) {
        a.fromBufferAttribute(pos, src[i]).applyMatrix4(m); b.fromBufferAttribute(pos, src[i + 1]).applyMatrix4(m); d.fromBufferAttribute(pos, src[i + 2]).applyMatrix4(m);
        const x = (a.x + b.x + d.x) / 3 - c.x, y = (a.y + b.y + d.y) / 3 - c.y, z = (a.z + b.z + d.z) / 3 - c.z;
        if (Math.abs(x) < K.x && y > K.y0 && y < K.y1 && z > K.z0 && z < K.z1) { dropped++; continue; }
        keep.push(src[i], src[i + 1], src[i + 2]);
      }
      if (keep.length * 1 !== src.length) {
        const ng = g.clone(); ng.setIndex(keep); ng.clearGroups && ng.clearGroups();
        if (g.groups && g.groups.length) ng.addGroup(0, keep.length, 0);
        o.geometry = ng;
      }
    });
    console.log('[BTT] monitor removed:', dropped, 'triangles (draw only, no collision change)');
  }

  // \u2500\u2500\u2500\u2500\u2500 the glass texture: video (low alpha) + Autumn-style UI + edge glow, ~10 fps while visible \u2500\u2500\u2500\u2500\u2500
  const W = 512, H = 320;
  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    const gr = ctx.createLinearGradient(0, 0, W, H); gr.addColorStop(0, 'rgba(111,0,255,' + cfg.glassAlpha + ')'); gr.addColorStop(1, 'rgba(0,255,115,' + cfg.glassAlpha * 0.6 + ')');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    if (vid && vid.readyState >= 2) { ctx.globalAlpha = cfg.videoAlpha; try { ctx.drawImage(vid, 0, 0, W, H); } catch (e) { } ctx.globalAlpha = 1; }
    // header
    ctx.fillStyle = 'rgba(4,6,20,.45)'; ctx.fillRect(10, 10, W - 20, 34);
    ctx.font = '700 18px ui-monospace,Menlo,monospace'; ctx.fillStyle = '#ffffff'; ctx.shadowColor = cfg.accent; ctx.shadowBlur = 10;
    ctx.fillText('AUTUMN', 22, 33); ctx.shadowBlur = 0;
    ctx.font = '11px ui-monospace,Menlo,monospace'; ctx.fillStyle = cfg.accent; ctx.fillText('LEATR \u00b7 GUEST \u00b7 JOTS', 112, 32);
    const on = (Math.floor(t * 2) % 2) === 0; ctx.fillStyle = on ? '#00ff73' : 'rgba(0,255,115,.35)'; ctx.beginPath(); ctx.arc(W - 30, 27, 5, 0, 6.283); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText('LIVE', W - 70, 31);
    // chat bubbles (scrolling)
    const lines = ['Welcome aboard the Bird Temple.', 'Ash memory: synced', 'Skyboard telemetry \u2713', 'Ask me anything, Ariel.', 'Engine room nominal.', 'LEATR reflex online'];
    ctx.save(); ctx.beginPath(); ctx.rect(10, 52, W - 150, H - 104); ctx.clip();
    const off = (t * 14) % 44;
    for (let i = 0; i < 7; i++) {
      const y = 60 + i * 44 - off, me = i % 2 === 1, s = lines[(i + Math.floor(t * 14 / 44)) % lines.length];
      const bw = Math.min(W - 170, 30 + s.length * 7.2), x = me ? W - 150 - bw - 6 : 18;
      ctx.fillStyle = me ? 'rgba(255,0,115,.28)' : 'rgba(10,12,40,.55)'; ctx.strokeStyle = me ? cfg.accent : 'rgba(0,255,115,.6)';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, bw, 32, 10) : ctx.rect(x, y, bw, 32); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '12px ui-monospace,Menlo,monospace'; ctx.fillText(s, x + 12, y + 20);
    }
    ctx.restore();
    // side panel: waveform + rings
    const px = W - 132; ctx.fillStyle = 'rgba(4,6,20,.4)'; ctx.fillRect(px, 52, 122, H - 104);
    ctx.strokeStyle = cfg.accent; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i <= 110; i++) { const y = 92 + Math.sin(i * 0.22 + t * 4) * 14 * Math.sin(t * 1.3 + i * 0.05); i ? ctx.lineTo(px + 6 + i, y) : ctx.moveTo(px + 6, y); }
    ctx.stroke();
    ctx.strokeStyle = '#00ff73'; ctx.beginPath(); ctx.arc(px + 61, 180, 30, t, t + 4.2); ctx.stroke();
    ctx.strokeStyle = 'rgba(111,0,255,.9)'; ctx.beginPath(); ctx.arc(px + 61, 180, 22, -t * 1.4, -t * 1.4 + 3.5); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '10px ui-monospace,Menlo,monospace'; ctx.fillText('ASH ' + (60 + Math.round(30 * Math.sin(t * 0.7))) + '%', px + 38, 184);
    // input bar
    ctx.fillStyle = 'rgba(4,6,20,.5)'; ctx.fillRect(10, H - 44, W - 20, 32); ctx.strokeStyle = 'rgba(255,0,115,.7)'; ctx.strokeRect(10, H - 44, W - 20, 32);
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '12px ui-monospace,Menlo,monospace'; ctx.fillText('Talk to Autumn\u2026' + (on ? '\u258c' : ''), 22, H - 23);
    ctx.fillStyle = cfg.accent; ctx.fillText(BTT.cur ? '[E] USE' : 'APPROACH + AIM', W - 130, H - 23);
    // emissive glass edge
    ctx.shadowColor = '#7ff'; ctx.shadowBlur = 14; ctx.strokeStyle = 'rgba(140,255,250,.95)'; ctx.lineWidth = 3; ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.shadowColor = cfg.accent; ctx.strokeStyle = 'rgba(255,0,115,.55)'; ctx.lineWidth = 1.5; ctx.strokeRect(8, 8, W - 16, H - 16); ctx.shadowBlur = 0;
    tex.needsUpdate = true;
  }
  function visibleNow() {
    try {
      if (!BTE.scene || !BTE.scene.visible || typeof SHIP_WALK === 'undefined' || !SHIP_WALK.active || !SHIP_WALK.localPos) return false;
      const P = SHIP_WALK.localPos, q = BTT.ix.pos;
      if (Math.hypot(P.x - q.x, P.z - q.z) > cfg.nearR || Math.abs(P.y + 2.5 - q.y) > 5) return false;
      if (window.DMBtInterior && DMBtInterior.on && DMBtInterior.screenVisible) return DMBtInterior.screenVisible({ mat: BTT.mat });
      return true;
    } catch (e) { return false; }
  }

  // \u2500\u2500\u2500\u2500\u2500 overlay \u2500\u2500\u2500\u2500\u2500
  let ov = null;
  function buildOverlay() {
    if (ov) return ov;
    const css = document.createElement('style');
    css.textContent = `
#btt-ov{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;
  background:rgba(8,4,24,.12);backdrop-filter:blur(3px) saturate(1.15);-webkit-backdrop-filter:blur(3px) saturate(1.15);}
#btt-ov.on{display:flex;}
#btt-ov .gl{position:relative;width:min(1100px,94vw);height:min(720px,86vh);border-radius:18px;overflow:hidden;
  background:linear-gradient(165deg,rgba(111,0,255,.10),rgba(0,255,115,.05));
  border:1.5px solid rgba(140,255,250,.85);box-shadow:0 0 22px rgba(120,255,245,.45),0 0 2px rgba(255,0,115,.9),inset 0 0 28px rgba(255,0,115,.22);}
#btt-ov video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.32;pointer-events:none;}
#btt-ov iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;color-scheme:normal;}
#btt-ov .x{position:absolute;top:10px;right:10px;z-index:2;width:40px;height:40px;border-radius:50%;cursor:pointer;
  border:1.5px solid rgba(140,255,250,.9);background:rgba(10,6,30,.45);color:#eafffd;font:700 20px/1 ui-monospace,monospace;
  box-shadow:0 0 12px rgba(120,255,245,.6);touch-action:manipulation;}
#btt-ov .hint{position:absolute;left:14px;bottom:10px;z-index:2;font:11px ui-monospace,monospace;color:rgba(234,255,253,.7);letter-spacing:.12em;pointer-events:none}
`;
    document.head.appendChild(css);
    ov = document.createElement('div'); ov.id = 'btt-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Autumn terminal');
    ov.innerHTML = '<div class="gl"><video muted loop playsinline preload="none"></video><iframe title="Autumn" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" allow="autoplay; clipboard-write" allowtransparency="true" referrerpolicy="strict-origin-when-cross-origin"></iframe>' +
      '<button class="x" type="button" aria-label="Close">\u2715</button><div class="hint">ESC TO CLOSE</div></div>';
    document.body.appendChild(ov);
    ov.querySelector('video').src = cfg.video; ov.querySelector('video').muted = true;
    ov.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); close(); });
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    // nothing inside the overlay reaches the game's touch / mouse / wheel handlers
    ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'wheel', 'contextmenu'].forEach(n => ov.addEventListener(n, e => e.stopPropagation(), { passive: true }));
    window.addEventListener('message', e => { if (e.origin === 'https://leatr.xyz' && e.data && e.data.type === 'autumn:jots-close') close(); });
    return ov;
  }
  function swallowKeys(e) {
    if (!BTT.open) return;
    if (e.key === 'Escape' && e.type === 'keydown') { e.preventDefault(); close(); }
    e.stopImmediatePropagation();
  }
  window.addEventListener('keydown', swallowKeys, true);
  window.addEventListener('keyup', swallowKeys, true);
  function open() {
    buildOverlay();
    const f = ov.querySelector('iframe'); if (!f.src) f.src = cfg.url;
    try { if (typeof KEYS === 'object' && KEYS) for (const k in KEYS) KEYS[k] = false; } catch (e) { }
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { }
    BTT.open = true; window.DM_TERMINAL_OPEN = true; ov.classList.add('on');
    const v = ov.querySelector('video'); v.play().catch(() => { });
    try { f.focus(); } catch (e) { }
  }
  function close() {
    if (!ov || !BTT.open) return;
    BTT.open = false; window.DM_TERMINAL_OPEN = false; ov.classList.remove('on');
    try { ov.querySelector('video').pause(); } catch (e) { }
    try { if (typeof KEYS === 'object' && KEYS) for (const k in KEYS) KEYS[k] = false; } catch (e) { }
  }
  BTT.openOverlay = open; BTT.close = close;

  function init() {
    THREE = window.THREE;
    const sc = BTE.scene; let scr = null;
    sc.traverse(o => { if (!scr && o.isMesh && o.material && o.material.name === 'BTE_Screen') scr = o; });
    if (!scr) { console.warn('[BTT] no terminal screen'); return; }
    try { cutMonitor(sc, scr); } catch (e) { console.warn('[BTT] monitor cut', e); }
    cv = document.createElement('canvas'); cv.width = W; cv.height = H; ctx = cv.getContext('2d');
    tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    mat.name = 'FX_BTT_Glass';
    scr.material = mat; scr.renderOrder = 5; BTT.mat = mat; BTT.mesh = scr;
    vid = document.createElement('video'); vid.muted = true; vid.loop = true; vid.playsInline = true; vid.setAttribute('playsinline', ''); vid.preload = 'none'; vid.src = cfg.video;
    draw(0);
    // interactable (temple frame) at the panel centre
    const g = BIRD_TEMPLE.group; g.updateMatrixWorld(true); if (!scr.geometry.boundingSphere) scr.geometry.computeBoundingSphere();
    const pos = g.worldToLocal(scr.geometry.boundingSphere.center.clone().applyMatrix4(scr.matrixWorld));
    const ix = { obj: scr, type: 'terminal', prompt: 'USE', radius: 8, zone: 'aim', zoneM: cfg.zoneM, aimM: cfg.aimM, pos };
    BTT.ix = ix; BTI.ix.push(ix);
    const act = BTI.act; BTI.act = function () { if (BTI.cur === ix) { open(); return; } return act.apply(this, arguments); };
    const up = BTI.update;
    BTI.update = function (dt) {
      up(dt);
      try {
        BTT.cur = BTI.cur === ix;
        const now = performance.now();
        if (now - last < 1000 / cfg.fps) return;
        const vis = !BTT.open && visibleNow();
        if (!vis) { if (!vid.paused) vid.pause(); return; }
        if (vid.paused) vid.play().catch(() => { });
        last = now; draw(now / 1000);
      } catch (e) { if (!BTT._err) { BTT._err = 1; console.warn('[BTT] update', e); } }
    };
    BTT.ready = true; console.log('[BTT] glass terminal ready');
  }
  const go = () => { try { init(); } catch (e) { console.warn('[BTT] init', e); } };
  if (window.BTE && BTE.ready) go(); else window.addEventListener('bte:ready', go, { once: true });
})();
