/* dm-hazardhud.js - the HAZARD indicator on the flight HUD: a small DROP-DOWN TAB hanging from the top header on the LEFT (v357; was a wide card in the middle of the screen).
   It sits right under the soundtrack strip (#wm-surf, the top-left of the header), clear of the fullscreen-exit button (left edge), the mini-kite (top centre) and the globe cluster
   (left, ~100 px down); the geometry is read from the live DOM when the tab opens and on resize (place()), never per frame.  Narrow (<= 138 px) and short (~46 px).
   The tab EXTENDS (slides down out of the header, a max-height transition) while ui/dm-hazard.js reports a hazard sensed at her (or her reserve is still recovering) and RETRACTS when
   clear.  pointer-events none, only in the game screens (never over the menu / builder).  Content (unchanged): the hazard type, the coloured band with the proximity marker, and the
   SAFE TIME countdown (RECOVERING mm:ss after she leaves; SHIELD ON while the Shield toggle protects her: the clock stops draining and refills).
   Dormant by default: at load this file registers ONE window listener (`dmhazardhud`); the element + style are created the first time a hazard is sensed.  No rAF, no timers, no polling: the
   hazard module emits the event on change (<= ~4 Hz).  `?hazardhud=0` never shows it.  Classic script, no deps. */
(function (root) {
  'use strict';
  const CSS = '#dm-hazhud{position:fixed;left:44px;top:40px;z-index:3550;display:block;pointer-events:none;box-sizing:border-box;width:132px;overflow:hidden;max-height:0;visibility:hidden;' +
    'transition:max-height .28s ease,visibility 0s .28s;}' +
    '#dm-hazhud[data-show="1"]{max-height:70px;visibility:visible;transition:max-height .28s ease,visibility 0s;}' +
    'body:has(#screen-menu.active) #dm-hazhud,body:has(#screen-builder.active) #dm-hazhud{display:none !important;}' +
    '#dm-hazhud .hh-card{box-sizing:border-box;padding:4px 7px 5px;border-radius:0 0 9px 9px;background:rgba(8,14,26,.72);border:1px solid rgba(160,210,255,.38);border-top:0;color:#dbe9f8;font:700 9px/1.25 system-ui,sans-serif;letter-spacing:.03em;}' +
    '#dm-hazhud .hh-row{display:flex;align-items:center;gap:5px;}' +
    '#dm-hazhud .hh-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--hh,#ffc233);box-shadow:0 0 5px var(--hh,#ffc233);}' +
    '#dm-hazhud .hh-type{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#dm-hazhud .hh-band{position:relative;height:6px;margin:5px 0 3px;border-radius:3px;background:linear-gradient(90deg,#1f9d55 0%,#9bd13a 30%,#ffc233 55%,#ff7a2a 78%,#ff3b30 100%);box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);}' +
    '#dm-hazhud .hh-edge{position:absolute;left:50%;top:-1px;bottom:-1px;width:1px;background:rgba(255,255,255,.55);}' +
    '#dm-hazhud .hh-mark{position:absolute;top:-4px;width:0;height:0;margin-left:-4px;border-left:4px solid transparent;border-right:4px solid transparent;border-top:6px solid #fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,.6));transition:left .35s linear;}' +
    '#dm-hazhud .hh-time{font-variant-numeric:tabular-nums;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#dm-hazhud .hh-res{height:2px;margin-top:4px;border-radius:2px;background:rgba(255,255,255,.14);overflow:hidden;}' +
    '#dm-hazhud .hh-res i{display:block;height:100%;width:100%;background:#35ff7e;transform-origin:left center;transition:transform .35s linear,background .35s;}' +
    '#dm-hazhud[data-st="warn"] .hh-res i{background:#ffc233;}#dm-hazhud[data-st="exposed"] .hh-res i{background:#ff3b30;}#dm-hazhud[data-st="shielded"] .hh-res i{background:#4d8dff;}' +
    '#dm-hazhud[data-st="alert"] .hh-card,#dm-hazhud[data-st="warn"] .hh-card{border-color:#ffc233;}#dm-hazhud[data-st="shielded"] .hh-card{border-color:#4d8dff;}' +
    '#dm-hazhud[data-st="exposed"] .hh-card{border-color:#ff3b30;background:rgba(40,8,8,.78);animation:dmHazPulse 1s ease-in-out infinite;}' +
    '#dm-hazhud[data-st="exposed"] .hh-time{color:#ffb3ad;}#dm-hazhud[data-st="shielded"] .hh-time{color:#a9c8ff;}' +
    '@keyframes dmHazPulse{50%{box-shadow:0 0 10px rgba(255,59,48,.8);}}';
  let el = null, last = '';
  function clock(sec) { if (!isFinite(sec)) return '--:--'; sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  // pure: what the card says for a `dmhazardhud` detail (the test drives it)
  function view(d) {
    if (!d || !d.on) return { show: false };
    const sh = !!d.shield && d.sensed;
    let st = sh ? 'shielded' : d.state === 'off' ? (d.sensed ? 'protected' : 'recover') : d.state, time;
    if (sh) time = d.reserve >= 0.999 ? 'SHIELD ON - SAFE' : 'RECOVERING ' + clock(d.refill);
    else if (d.zero || st === 'exposed') time = 'OVEREXPOSED';
    else if (st === 'alert') time = 'NEAR THE ZONE';
    else if (d.sensed) time = 'SAFE TIME ' + clock(d.sec);
    else time = 'RECOVERING ' + clock(d.refill);
    return { show: true, st: st === 'recover' ? 'protected' : st, type: d.sensed ? (d.label || 'HAZARD') : (d.label || 'RECOVERING'), time, marker: Math.max(0, Math.min(1, +d.marker || 0)), reserve: Math.max(0, Math.min(1, +d.reserve)), hue: d.hue || '#ffc233' };
  }
  // where the tab goes: under the soundtrack strip, right of the fullscreen-exit button, left of the mini-kite (DOM geometry, read when it opens / on resize)
  function place() {
    if (!el || !root.document) return;
    try {
      const d = root.document, q = s => { const e = d.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 ? r : null; };
      const wm = q('#screen-flight .world-music') || q('.world-music'), fx = q('#fs-exit'), kite = q('#screen-flight .mini-kite') || q('.mini-kite');
      const W = root.innerWidth || 800, top = wm ? wm.bottom : 34, left = Math.max(fx ? fx.right + 6 : 8, 8);
      let w = 138; if (kite && kite.left > left + 70) w = Math.min(w, kite.left - left - 8);
      w = Math.max(96, Math.min(w, W - left - 8));
      el.style.top = Math.round(top + 2) + 'px'; el.style.left = Math.round(left) + 'px'; el.style.width = Math.round(w) + 'px';
    } catch (e) { }
  }
  function build() {
    if (el || !root.document || !document.body) return el;
    if (!document.getElementById('dm-hazhud-css')) { const c = document.createElement('style'); c.id = 'dm-hazhud-css'; c.textContent = CSS; document.head.appendChild(c); }
    el = document.createElement('div'); el.id = 'dm-hazhud'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="hh-card"><div class="hh-row"><span class="hh-dot"></span><span class="hh-type"></span></div><div class="hh-band"><span class="hh-edge"></span><span class="hh-mark"></span></div><div class="hh-time"></div><div class="hh-res"><i></i></div></div>';
    if (root.addEventListener) { root.addEventListener('resize', place); root.addEventListener('orientationchange', place); }
    document.body.appendChild(el); return el;
  }
  function onEvt(ev) {
    const v = view(ev && ev.detail);
    if (!v.show) { if (el) el.setAttribute('data-show', ''); last = ''; return; }
    if (!build()) return;
    const sig = v.st + '|' + v.type + '|' + v.time + '|' + Math.round(v.marker * 100) + '|' + Math.round(v.reserve * 100);
    if (sig === last) return; last = sig;
    if (el.getAttribute('data-show') !== '1') place();
    el.setAttribute('data-show', '1'); el.setAttribute('data-st', v.st); el.style.setProperty('--hh', v.hue);
    el.querySelector('.hh-type').textContent = v.type; el.querySelector('.hh-time').textContent = v.time;
    el.querySelector('.hh-mark').style.left = (v.marker * 100).toFixed(1) + '%';
    el.querySelector('.hh-res i').style.transform = 'scaleX(' + v.reserve.toFixed(3) + ')';
  }
  root.DMHazardHud = { view, clock };
  if (root.addEventListener) root.addEventListener('dmhazardhud', onEvt);
})(typeof window !== 'undefined' ? window : globalThis);
