/* dm-hazardhud.js - the HAZARD indicator on the flight HUD.  Out of the way: top centre, just under the mini-kite strip (which ends ~118 px from the top), clear of the corner
   clusters (world rail top right, sticks bottom, flashlight dock bottom left, system bar bottom centre), pointer-events none, never over the crosshair.
   Shows ONLY while ui/dm-hazard.js reports a hazard sensed at her (or while her exposure reserve is still recovering after she leaves):
     (a) a coloured band meter (green -> amber -> red) whose marker follows her proximity to the source: the left half is the NEAR band, the middle tick is the edge of the zone, the
         right half is inside it (a world's whole toxic air = full right).  It eases (css transition) and falls back to the left as she moves away; the card goes when she is clear
         and the reserve has refilled.
     (b) the hazard type (DM_HAZ.table label);
     (c) the time she can stay: SAFE TIME mm:ss counting down while exposed (reserve x safeSec / intensity), RECOVERING mm:ss to full after she leaves, and at zero the clear warning
         OVEREXPOSED - LEAVE THE ZONE (red, pulsing).  Nothing else happens at zero (no damage, no game-over).
   Dormant by default: at load this file registers ONE window listener (`dmhazardhud`); the element + style are created the first time a hazard is sensed.  No rAF, no timers, no polling: the
   hazard module emits the event on change (<= ~4 Hz).  `?hazardhud=0` never shows it.  Classic script, no deps. */
(function (root) {
  'use strict';
  const CSS = '#dm-hazhud{position:fixed;left:50%;top:calc(126px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:3550;display:none;pointer-events:none;box-sizing:border-box;' +
    'width:min(86vw,232px);padding:6px 9px 7px;border-radius:8px;background:rgba(8,14,26,.66);border:1px solid rgba(160,210,255,.38);color:#dbe9f8;font:700 11px/1.25 system-ui,sans-serif;letter-spacing:.04em;}' +
    'body:has(#screen-flight.active) #dm-hazhud[data-show="1"]{display:block;}' +
    'body:has(#screen-menu.active) #dm-hazhud,body:has(#screen-builder.active) #dm-hazhud{display:none !important;}' +
    '#dm-hazhud .hh-row{display:flex;align-items:center;gap:6px;justify-content:space-between;}' +
    '#dm-hazhud .hh-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--hh,#ffc233);box-shadow:0 0 6px var(--hh,#ffc233);}' +
    '#dm-hazhud .hh-type{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#dm-hazhud .hh-band{position:relative;height:9px;margin:6px 0 4px;border-radius:5px;background:linear-gradient(90deg,#1f9d55 0%,#9bd13a 30%,#ffc233 55%,#ff7a2a 78%,#ff3b30 100%);box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);}' +
    '#dm-hazhud .hh-edge{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:rgba(255,255,255,.55);}' +
    '#dm-hazhud .hh-mark{position:absolute;top:-4px;width:0;height:0;margin-left:-5px;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid #fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,.6));transition:left .35s linear;}' +
    '#dm-hazhud .hh-time{font-variant-numeric:tabular-nums;font-size:12px;}' +
    '#dm-hazhud .hh-res{height:3px;margin-top:5px;border-radius:2px;background:rgba(255,255,255,.14);overflow:hidden;}' +
    '#dm-hazhud .hh-res i{display:block;height:100%;width:100%;background:#35ff7e;transform-origin:left center;transition:transform .35s linear,background .35s;}' +
    '#dm-hazhud[data-st="warn"] .hh-res i{background:#ffc233;}#dm-hazhud[data-st="exposed"] .hh-res i{background:#ff3b30;}' +
    '#dm-hazhud[data-st="alert"]{border-color:#ffc233;}#dm-hazhud[data-st="warn"]{border-color:#ffc233;}' +
    '#dm-hazhud[data-st="exposed"]{border-color:#ff3b30;background:rgba(40,8,8,.74);animation:dmHazPulse 1s ease-in-out infinite;}' +
    '#dm-hazhud[data-st="exposed"] .hh-time{color:#ffb3ad;}' +
    '@keyframes dmHazPulse{50%{box-shadow:0 0 14px rgba(255,59,48,.8);}}';
  let el = null, last = '';
  function clock(sec) { if (!isFinite(sec)) return '--:--'; sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  // pure: what the card says for a `dmhazardhud` detail (the test drives it)
  function view(d) {
    if (!d || !d.on) return { show: false };
    let st = d.state === 'off' ? (d.sensed ? 'protected' : 'recover') : d.state, time;
    if (d.zero || st === 'exposed') time = 'OVEREXPOSED - LEAVE THE ZONE';
    else if (st === 'alert') time = 'NEAR THE ZONE - NOT EXPOSED YET';
    else if (d.sensed) time = 'SAFE TIME ' + clock(d.sec);
    else time = 'RECOVERING ' + clock(d.refill);
    return { show: true, st: st === 'recover' ? 'protected' : st, type: d.sensed ? (d.label || 'HAZARD') : (d.label || 'RECOVERING'), time, marker: Math.max(0, Math.min(1, +d.marker || 0)), reserve: Math.max(0, Math.min(1, +d.reserve)), hue: d.hue || '#ffc233' };
  }
  function build() {
    if (el || !root.document || !document.body) return el;
    if (!document.getElementById('dm-hazhud-css')) { const c = document.createElement('style'); c.id = 'dm-hazhud-css'; c.textContent = CSS; document.head.appendChild(c); }
    el = document.createElement('div'); el.id = 'dm-hazhud'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="hh-row"><span class="hh-dot"></span><span class="hh-type"></span></div><div class="hh-band"><span class="hh-edge"></span><span class="hh-mark"></span></div><div class="hh-time"></div><div class="hh-res"><i></i></div>';
    document.body.appendChild(el); return el;
  }
  function onEvt(ev) {
    const v = view(ev && ev.detail);
    if (!v.show) { if (el) el.setAttribute('data-show', ''); last = ''; return; }
    if (!build()) return;
    const sig = v.st + '|' + v.type + '|' + v.time + '|' + Math.round(v.marker * 100) + '|' + Math.round(v.reserve * 100);
    if (sig === last) return; last = sig;
    el.setAttribute('data-show', '1'); el.setAttribute('data-st', v.st); el.style.setProperty('--hh', v.hue);
    el.querySelector('.hh-type').textContent = v.type; el.querySelector('.hh-time').textContent = v.time;
    el.querySelector('.hh-mark').style.left = (v.marker * 100).toFixed(1) + '%';
    el.querySelector('.hh-res i').style.transform = 'scaleX(' + v.reserve.toFixed(3) + ')';
  }
  root.DMHazardHud = { view, clock };
  if (root.addEventListener) root.addEventListener('dmhazardhud', onEvt);
})(typeof window !== 'undefined' ? window : globalThis);
