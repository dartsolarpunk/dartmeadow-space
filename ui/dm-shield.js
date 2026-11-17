/* dm-shield.js — HUD button for the breathing shield bubble (t1611u).
   A flat-DOM "SHIELD" toggle docked in the left-stick group, immediately next to
   (above) the glasses flashlight (#dm-flash .fl-btn). Markup, chrome and the lit
   `.on` class match the flashlight button exactly.
   Visibility and the lit state come from Lighting's hook (implemented separately
   in ui/dm-hazardbubble.js — this file does not create or own window.DMShield):
     window.DMShield.available  — true only on toxic-atmosphere worlds
     window.DMShield.on         — current bubble state
     DMShield.toggle() / .set(bool)
     window event `dmshield` with detail {on, available, status, state} on each change
     (t1612) with the orb OFF the button wears the board group's protection colour (data-st: protected green / warn amber / exposed red, the same as the
     staff crown + LED); orb ON: the plain lit button
   The button is hidden by default and stays hidden if DMShield is missing. A tap
   calls DMShield.toggle(). No per-frame polling or allocations (no rAF loop, no
   setInterval): it listens for `dmshield`, reads DMShield once on init, and
   re-docks from resize / orientationchange plus a MutationObserver on #dm-flash
   (the flashlight's own dock already runs on screen / world changes). Classic
   script, no deps. */
(function (root) {
  'use strict';
  const SZ = 34, GAP = 6;
  const ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3.2l7.2 2.2v6.3c0 4.4-3 7.4-7.2 9.1-4.2-1.7-7.2-4.7-7.2-9.1V5.4L12 3.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 7.2v6.2M9.4 9.6h5.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const CSS = '#dm-shield{position:fixed;left:0;bottom:0;z-index:3555;display:none;pointer-events:none;}' +
    '#dm-shield[data-show="1"]{display:block;}' +
    'body:has(#screen-menu.active) #dm-shield,body:has(#screen-builder.active) #dm-shield{display:none !important;}' +
    '#dm-shield .fl-btn{position:absolute;left:0;bottom:0;width:34px;height:34px;border-radius:50%;padding:0;margin:0;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(6,14,28,.55);border:1px solid rgba(160,210,255,.45);color:#9fc8ee;pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;cursor:pointer;}' +
    '#dm-shield.on .fl-btn{background:rgba(255,248,230,.16);border-color:#fff6e0;color:#fffaf0;box-shadow:0 0 10px rgba(255,244,214,.45);}' +
    '#dm-shield[data-st="protected"] .fl-btn{border-color:#35ff7e;color:#a8ffc8;box-shadow:0 0 9px rgba(53,255,126,.5);}' +
    '#dm-shield[data-st="warn"] .fl-btn{border-color:#ffc233;color:#ffe29a;box-shadow:0 0 9px rgba(255,194,51,.55);}' +
    '#dm-shield[data-st="exposed"] .fl-btn{border-color:#ff3b30;color:#ffb3ad;box-shadow:0 0 9px rgba(255,59,48,.6);}';

  let ui = null, avail = false, on = false, st = '', flashObs = null, flightObs = null;

  function build() {
    if (ui || !root.document || !document.body) return ui;
    if (!document.getElementById('dm-shield-css')) { const st = document.createElement('style'); st.id = 'dm-shield-css'; st.textContent = CSS; document.head.appendChild(st); }
    const w = document.createElement('div'); w.id = 'dm-shield';
    const b = document.createElement('button'); b.id = 'dm-shield-btn'; b.className = 'fl-btn'; b.type = 'button';
    b.setAttribute('aria-label', 'SHIELD'); b.title = 'SHIELD'; b.setAttribute('aria-pressed', 'false'); b.innerHTML = ICON;
    const stop = e => { e.stopPropagation(); };
    b.addEventListener('click', e => { stop(e); if (root.DMShield) DMShield.toggle(); });
    b.addEventListener('touchstart', stop, { passive: true });
    b.addEventListener('mousedown', stop);
    b.addEventListener('pointerdown', stop);
    w.appendChild(b); document.body.appendChild(w);
    ui = { w, b };
    return ui;
  }

  function read(ev) {
    const d = ev && ev.detail, api = root.DMShield;
    if (d && typeof d === 'object') { avail = !!d.available; on = !!d.on; st = d.status || ''; }
    else if (api) { avail = !!api.available; on = !!api.on; st = api.status || ''; }
    else { avail = false; on = false; st = ''; }
    if (on || !avail || (st !== 'protected' && st !== 'warn' && st !== 'exposed')) st = '';
  }

  function paint() {
    const u = build(); if (!u) return;
    u.w.classList.toggle('on', on);
    if (st) u.w.setAttribute('data-st', st); else u.w.removeAttribute('data-st');
    u.b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function dock() {
    const u = build(); if (!u) return;
    const d = root.document, flash = d.getElementById('dm-flash');
    const sf = d.getElementById('screen-flight');
    const inGame = !!(sf && sf.classList.contains('active'));
    const flashOn = !!(flash && flash.getAttribute('data-m'));
    if (!avail || !inGame || !flashOn) { u.w.setAttribute('data-show', ''); return; }
    u.w.setAttribute('data-show', '1');
    const bot = parseFloat(flash.style.bottom) || 0;
    u.w.style.left = flash.style.left;
    u.w.style.bottom = Math.round(Math.max(2, bot + SZ + GAP)) + 'px';
  }

  function sync(ev) { read(ev); paint(); dock(); }

  function watch() {
    const d = root.document; if (!d) return;
    const flash = d.getElementById('dm-flash');
    if (flash && !flashObs) {
      flashObs = new MutationObserver(dock);
      flashObs.observe(flash, { attributes: true, attributeFilter: ['style', 'data-m', 'class'] });
    }
    const sf = d.getElementById('screen-flight');
    if (sf && !flightObs) {
      flightObs = new MutationObserver(function () { sync(); });
      flightObs.observe(sf, { attributes: true, attributeFilter: ['class'] });
    }
  }

  function start() {
    build(); watch();
    root.addEventListener('dmshield', sync);
    root.addEventListener('resize', dock);
    root.addEventListener('orientationchange', dock);
    if (document.body && !flashObs) {
      const mo = new MutationObserver(function () {
        watch();
        if (flashObs) { try { mo.disconnect(); } catch (e) { } }
        dock();
      });
      mo.observe(document.body, { childList: true });
    }
    sync();
  }

  if (root.document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
