/* dm-sys.js — the ONE place the game talks to the player in small print.
   A single narrow strip in the bottom-right corner: a gradient (~80 % at the right edge, fading out toward the bottom-centre) with
   small text. It carries
     - every loading message (initial load, menu -> game, flight warm-up, "Preparing galaxy 5/11" ...): dmSys.load(key, msg) holds the
       strip up until dmSys.done(key) for the last key;
     - every in-game system message / toast / hint: dmSys(msg, {dur, cls, sticky}) pops in, fades after ~2.4 s when nothing newer
       arrives; a newer message replaces the text.
   The old toast() in index.html is a shim over dmSys(); ui files that call window.toast() keep working.
   pointer-events:none, safe-area aware, above the loaders and below nothing — but it is 1 line high and hugs the corner, so it never
   sits on the music bar (top-right) or the centred loader. Classic script, no dependencies. */
(function () {
  'use strict';
  if (window.dmSys) return;
  var DEF_MS = 2400, MIN_MS = 1400;
  var css =
    '#dm-sys{position:fixed;right:0;bottom:0;z-index:2147483000;box-sizing:border-box;max-width:min(48vw,480px);min-width:min(30vw,220px);' +
    'padding:5px calc(12px + env(safe-area-inset-right,0px)) calc(5px + env(safe-area-inset-bottom,0px)) 36px;' +
    'background:linear-gradient(to left,rgba(4,12,26,.8) 0%,rgba(4,12,26,.8) 38%,rgba(4,12,26,0) 100%);' +
    'font:600 10px/1.35 var(--font-mono,ui-monospace,Menlo,monospace);letter-spacing:.06em;text-align:right;color:#bfe6ff;' +
    'text-shadow:0 0 6px rgba(80,170,255,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;' +
    'opacity:0;transform:translateX(14px);transition:opacity .28s ease,transform .28s ease;}' +
    '#dm-sys.on{opacity:1;transform:none;}' +
    '#dm-sys.warn{color:#ffd37a;text-shadow:0 0 6px rgba(255,190,70,.5);}' +
    '#dm-sys.err{color:#ff9b9b;text-shadow:0 0 6px rgba(255,90,90,.5);}' +
    '#dm-sys.ld{color:#9fd8ff;}';
  var el = null, loads = {}, order = [], msg = null, msgUntil = 0, timer = 0, seq = 0, held = null;

  function ensure() {
    if (el && el.isConnected) return el;
    if (!document.body) return null;
    if (!document.getElementById('dm-sys-css')) {
      var st = document.createElement('style'); st.id = 'dm-sys-css'; st.textContent = css; (document.head || document.documentElement).appendChild(st);
    }
    el = document.getElementById('dm-sys') || document.createElement('div');
    el.id = 'dm-sys'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    return el;
  }
  function render() {
    clearTimeout(timer);
    var now = Date.now(), text = '', cls = '';
    if (!order.length && held) {   // a message that arrived mid-load is shown once the loading text is gone (if still fresh)
      var h = held; held = null;
      if (now - h.at < 6000) { msg = h.m; msgUntil = now + h.dur; }
    }
    if (msg && msg.sticky) { text = msg.text; cls = msg.cls; }
    else if (msg && msgUntil > now) { text = msg.text; cls = msg.cls; timer = setTimeout(render, msgUntil - now + 20); }
    else {
      msg = null;
      var k = order.length ? order[order.length - 1] : null;
      if (k) { text = loads[k]; cls = 'ld'; }
    }
    var e = ensure(); if (!e) { document.addEventListener('DOMContentLoaded', render, { once: true }); return; }
    if (text) {
      if (e.textContent !== text) e.textContent = text;
      e.className = 'on' + (cls ? ' ' + cls : '');
    } else e.className = '';
  }
  function norm(a, b) {   // old toast(msg, dur, cls) call shapes: (m), (m, 2000), (m, 'warn'), (m, 'warn', 2000), (m, '', 1200)
    var o = {};
    [a, b].forEach(function (x) {
      if (typeof x === 'number') o.dur = x;
      else if (typeof x === 'string' && x) o.cls = x;
      else if (x && typeof x === 'object') for (var k in x) o[k] = x[k];
    });
    return o;
  }
  function dmSys(text, opts, extra) {
    if (text === '' || text == null) { msg = null; render(); return; }
    var o = norm(opts, extra);
    var dur = o.dur > 0 ? Math.max(MIN_MS, Math.min(o.dur, 6000)) : DEF_MS;
    var m = { text: String(text), cls: o.cls === 'warn' || o.cls === 'err' ? o.cls : '', sticky: !!o.sticky, id: ++seq };
    if (order.length && !m.cls && !m.sticky) { held = { m: m, dur: dur, at: Date.now() }; return; }   // loading text owns the strip; plain notes wait
    msg = m; msgUntil = Date.now() + dur;
    render();
  }
  dmSys.load = function (key, text) {   // a loading stage: stays up (replaced in place) until dmSys.done(key)
    key = key || 'load'; if (text == null || text === '') return;
    if (loads[key] === String(text) && order[order.length - 1] === key) return;
    if (!(key in loads)) order.push(key); else { var i = order.indexOf(key); if (i >= 0 && i !== order.length - 1) { order.splice(i, 1); order.push(key); } }
    loads[key] = String(text); render();
  };
  dmSys.done = function (key) {
    if (!(key in loads)) return;
    delete loads[key]; var i = order.indexOf(key); if (i >= 0) order.splice(i, 1);
    render();
  };
  dmSys.loading = function () { return order.length > 0; };
  dmSys.clear = function () { msg = null; held = null; render(); };
  dmSys.text = function () { return el ? el.textContent : ''; };
  window.dmSys = dmSys;
  // the strip exists from the first paint: the splash's first stage message lands in it
  if (document.body) ensure(); else document.addEventListener('DOMContentLoaded', ensure, { once: true });
})();
