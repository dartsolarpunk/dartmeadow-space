/* dm-bt-terminal.js — v122: the engineering-office desk terminal (beside Madison) becomes a holographic glass panel.
 *
 *  In-world: the old monitor body / neck / neon strip (felt + glow triangles around the screen) are dropped from the
 *  merged FX_BTE_Office draw meshes at runtime (index-buffer filter, nothing else touched; the foot stays as the
 *  emitter base). The BTE_Screen plane becomes see-through glass showing a real screenshot of the in-game Autumn UI
 *  (assets/bt-engineering/autumn-terminal.webp) through a light shader (scanlines, slow sweep, flicker, edge glow; v128).
 *  Per frame it only writes a time uniform, and only while it is on screen and near.
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
    shot: 'assets/bt-engineering/autumn-terminal.webp',   // screenshot of the guest edition (leatr.xyz/?embed=jots), 1024x640
    nearR: 14, zoneM: 1.8, aimM: 0.55, alpha: 0.7, gain: 1.35,
    accent: '#ff0073', bg1: '#6f00ff', bg2: '#00ff73',      // Justin's Autumn palette "Data Ariel"
    // terminal cut box, relative to the screen centre in the office glTF frame (Blender x, z, -y)
    cut: { x: 0.8, y0: -0.8, y1: 0.55, z0: -0.2, z1: 0.2 },
  };
  const BTT = { cfg, ready: false, open: false, mesh: null, ix: null };
  window.BTT = BTT;
  let THREE, tex;

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

  // \u2500\u2500\u2500\u2500\u2500 the glass: a real screenshot of the in-game Autumn UI (shipped asset) on a see-through shader \u2500\u2500\u2500\u2500\u2500
  // One static texture; the light animation (scan sweep, scanlines, soft flicker, edge glow) runs in the fragment shader,
  // so a frame costs one uniform write while the panel is on screen and near (no canvas redraw, no video decode, no upload).
  // WebGPURenderer (three r185): a MeshBasicNodeMaterial with TSL colour / opacity nodes; plain textured glass as fallback.
  function glassMaterial(tex) {
    const T = THREE.TSL;
    if (!T || !THREE.MeshBasicNodeMaterial) {
      const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: cfg.alpha, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      return { mat: m, u: { uTime: { value: 0 }, uHot: { value: 0 }, uReady: { value: 1 } } };
    }
    const { texture, uv, uniform, sin, fract, abs, smoothstep, min, vec2, vec3, float, dot, clamp } = T;
    const u = { uTime: uniform(0), uHot: uniform(0), uReady: uniform(0) };
    const accent = vec3(...new THREE.Color(cfg.accent).toArray()), tint = vec3(...new THREE.Color(cfg.bg1).toArray()), rimC = vec3(...new THREE.Color('#8cfffa').toArray());
    const U = uv();
    const img = texture(tex, U).rgb.mul(u.uReady).mul(cfg.gain);
    const lum = dot(img, vec3(0.299, 0.587, 0.114));
    const scan = sin(U.y.mul(900.0)).mul(0.10).add(0.90);                                         // fine scanlines
    const sweep = float(1).sub(smoothstep(0.0, 0.10, abs(fract(U.y.sub(u.uTime.mul(0.08))).sub(0.5)).sub(0.38)));   // slow bright band
    const flick = sin(u.uTime.mul(7.3)).mul(sin(u.uTime.mul(2.1))).mul(0.04).add(0.96);
    const e = min(U, vec2(1.0).sub(U)), edge = min(e.x.mul(1.6), e.y);
    const rim = float(1).sub(smoothstep(0.0, 0.022, edge)), rim2 = float(1).sub(smoothstep(0.0, 0.05, edge)).sub(rim);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    m.colorNode = img.mul(scan).mul(flick).add(accent.mul(sweep.mul(0.10))).add(tint.mul(0.06))
      .add(rimC.mul(rim.mul(1.2))).add(accent.mul(rim2.mul(u.uHot.mul(0.35).add(0.35))));
    m.opacityNode = clamp(float(cfg.alpha).mul(lum.mul(0.45).add(0.55)).mul(scan).add(sweep.mul(0.06)).add(rim.mul(0.9)).add(rim2.mul(0.25)), 0.0, 1.0);
    return { mat: m, u };
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
    tex = new THREE.TextureLoader().load(cfg.shot, () => { G.u.uReady.value = 1; });
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 4;
    const G = glassMaterial(tex), mat = G.mat, uni = G.u;
    mat.name = 'FX_BTT_Glass';
    scr.material = mat; scr.renderOrder = 5; BTT.mat = mat; BTT.mesh = scr; BTT.uni = uni;
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
        if (BTT.open || !visibleNow()) return;   // frozen (and nearly free) while off screen or while the overlay is open
        const u = BTT.uni; u.uTime.value = performance.now() / 1000;
        u.uHot.value += ((BTT.cur ? 1 : 0) - u.uHot.value) * Math.min(1, dt * 6 || .1);
      } catch (e) { if (!BTT._err) { BTT._err = 1; console.warn('[BTT] update', e); } }
    };
    BTT.ready = true; console.log('[BTT] glass terminal ready');
  }
  const go = () => { try { init(); } catch (e) { console.warn('[BTT] init', e); } };
  if (window.BTE && BTE.ready) go(); else window.addEventListener('bte:ready', go, { once: true });
})();
