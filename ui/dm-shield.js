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
   The button is hidden by default and stays hidden if DMShield is missing.
   (t1612) DORMANT on safe maps: at load this file only registers two window listeners (`dmshield`, `dmhazard`); the button, its style, the resize /
   orientation listeners and the MutationObservers are created when DMShield first reports `available` and are removed again when it stops being available
   (no DOM, no observers, no layout work on a healthy planet). A near hazard source (`dmhazard`, window.DMHazard) shows a small prompt 'Hazard detected -
   initialize protection shield?' [ACCEPT] [DISMISS]: ACCEPT = DMShield.arm(true); DISMISS = DMHazard.dismiss() (2 min cooldown); never while armed / protected. A tap
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
    '#dm-shield[data-st="exposed"] .fl-btn{border-color:#ff3b30;color:#ffb3ad;box-shadow:0 0 9px rgba(255,59,48,.6);}' +
    '#dm-shield[data-st="alert"] .fl-btn{border-color:#ffc233;color:#ffe29a;box-shadow:0 0 9px rgba(255,194,51,.55);animation:dmShAlert 1.1s ease-in-out infinite;}' +
    '@keyframes dmShAlert{50%{box-shadow:0 0 16px rgba(255,194,51,.95);}}';

  let ui = null, avail = false, on = false, lit = false, st = '', flashObs = null, flightObs = null, active = false, pr = null, prShown = false;
  const PCSS = '#dm-shield-prompt{position:fixed;left:50%;top:58px;transform:translateX(-50%);z-index:3560;display:none;max-width:min(92vw,420px);padding:8px 10px;border-radius:8px;' +
    'background:rgba(8,14,26,.88);border:1px solid #ffc233;color:#ffe9b8;font:600 12px/1.3 system-ui,sans-serif;box-shadow:0 0 14px rgba(255,194,51,.35);pointer-events:auto;}' +
    '#dm-shield-prompt[data-show="1"]{display:block;}#dm-shield-prompt .sp-row{display:flex;gap:8px;margin-top:6px;}' +
    '#dm-shield-prompt button{flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,194,51,.7);background:rgba(255,194,51,.14);color:#fff1cf;font:700 11px system-ui,sans-serif;touch-action:manipulation;}' +
    '#dm-shield-prompt button.sp-no{border-color:rgba(160,210,255,.4);background:transparent;color:#bcd6ee;}' +
    'body:has(#screen-menu.active) #dm-shield-prompt{display:none !important;}';
  const stop = e => { e.stopPropagation(); };

  function build() {
    if (ui || !root.document || !document.body) return ui;
    if (!document.getElementById('dm-shield-css')) { const st = document.createElement('style'); st.id = 'dm-shield-css'; st.textContent = CSS; document.head.appendChild(st); }
    const w = document.createElement('div'); w.id = 'dm-shield';
    const b = document.createElement('button'); b.id = 'dm-shield-btn'; b.className = 'fl-btn'; b.type = 'button';
    b.setAttribute('aria-label', 'SHIELD'); b.title = 'SHIELD'; b.setAttribute('aria-pressed', 'false'); b.innerHTML = ICON;
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
    let state = '';
    if (d && typeof d === 'object') { avail = !!d.available; on = !!d.on; st = d.status || ''; state = d.state || ''; }
    else if (api) { avail = !!api.available; on = !!api.on; st = api.status || ''; state = api.state || ''; }
    else { avail = false; on = false; st = ''; }
    lit = state ? state === 'orb' : on;          // lit = the orb is up (state 'alert' / 'board': the status colour instead)
    if (!avail || lit || (st !== 'protected' && st !== 'warn' && st !== 'exposed' && st !== 'alert')) st = '';
  }

  function paint() {
    if (!ui) return;
    ui.w.classList.toggle('on', lit);
    if (st) ui.w.setAttribute('data-st', st); else ui.w.removeAttribute('data-st');
    ui.b.setAttribute('aria-pressed', lit ? 'true' : 'false');
  }

  function dock() {
    if (!ui) return;
    const u = ui, d = root.document, flash = d.getElementById('dm-flash');
    const sf = d.getElementById('screen-flight');
    const inGame = !!(sf && sf.classList.contains('active'));
    const flashOn = !!(flash && flash.getAttribute('data-m'));
    if (!avail || !inGame || !flashOn) { u.w.setAttribute('data-show', ''); return; }
    u.w.setAttribute('data-show', '1');
    const bot = parseFloat(flash.style.bottom) || 0;
    u.w.style.left = flash.style.left;
    u.w.style.bottom = Math.round(Math.max(2, bot + SZ + GAP)) + 'px';
  }

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

  // wake: the button + observers + layout listeners exist only while the shield is available (hostile air, armed, or a hazard source alert)
  function activate() {
    if (active) return; active = true;
    build(); watch();
    root.addEventListener('resize', dock);
    root.addEventListener('orientationchange', dock);
  }
  function deactivate() {
    if (!active) return; active = false;
    if (ui) { ui.w.setAttribute('data-show', ''); ui.w.classList.toggle('on', false); ui.w.removeAttribute('data-st'); try { if (ui.w.remove) ui.w.remove(); } catch (e) { } }
    ui = null;
    try { if (flashObs) flashObs.disconnect(); if (flightObs) flightObs.disconnect(); } catch (e) { }
    flashObs = flightObs = null;
    root.removeEventListener && root.removeEventListener('resize', dock);
    root.removeEventListener && root.removeEventListener('orientationchange', dock);
  }

  function sync(ev) {
    read(ev);
    if (avail) { activate(); paint(); dock(); } else deactivate();
    if (pr && prShown && (!avail || (root.DMShield && DMShield.armed))) hidePrompt();
  }

  // ── the hazard prompt ──
  function hidePrompt() { if (pr) pr.setAttribute('data-show', ''); prShown = false; }
  function showPrompt(d) {
    if (!root.document || !document.body) return;
    if (!pr) {
      if (!document.getElementById('dm-shield-pcss')) { const c = document.createElement('style'); c.id = 'dm-shield-pcss'; c.textContent = PCSS; document.head.appendChild(c); }
      pr = document.createElement('div'); pr.id = 'dm-shield-prompt'; pr.setAttribute('role', 'alertdialog');
      const t = document.createElement('div'); t.className = 'sp-txt'; pr.appendChild(t);
      const row = document.createElement('div'); row.className = 'sp-row';
      const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'sp-yes'; yes.textContent = 'ACCEPT';
      const no = document.createElement('button'); no.type = 'button'; no.className = 'sp-no'; no.textContent = 'DISMISS';
      yes.addEventListener('click', e => { stop(e); if (root.DMShield) DMShield.arm(true); hidePrompt(); });
      no.addEventListener('click', e => { stop(e); if (root.DMHazard) DMHazard.dismiss(); hidePrompt(); });
      for (const b of [yes, no]) { b.addEventListener('touchstart', stop, { passive: true }); b.addEventListener('pointerdown', stop); b.addEventListener('mousedown', stop); }
      row.appendChild(yes); row.appendChild(no); pr.appendChild(row); document.body.appendChild(pr);
    }
    const kind = d && (d.gas || d.type) ? ' (' + String(d.gas || d.type).replace(/[<>&]/g, '') + ')' : '';
    pr.firstChild.textContent = 'Hazard detected' + kind + ' - initialize protection shield?';
    pr.setAttribute('data-show', '1'); prShown = true;
  }
  function onHaz(ev) {
    const d = ev && ev.detail;
    if (!d || !d.near) { hidePrompt(); return; }
    const sh = root.DMShield, hz = root.DMHazard;
    if (prShown || (sh && (sh.armed || sh.state === 'orb' || sh.state === 'board')) || (hz && hz.cooling)) return;
    showPrompt(d);
  }

  function start() {
    root.addEventListener('dmshield', sync);
    root.addEventListener('dmhazard', onHaz);
    if (root.DMShield && root.DMShield.available) sync();
  }

  if (root.document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
