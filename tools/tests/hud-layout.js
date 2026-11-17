// node tools/tests/hud-layout.js — v298 HUD (no browser): the ONE soundtrack control lives in the menu's instrument panel (no floating pill); the system message bar (ui/dm-sys.js) is centred with a two-sided fade, pointer-events none, lifted above the sticks in play; toast() is a dmSys shim.
// The full layout (real rects at desktop / phone landscape / phone portrait) is tools/tests/sys-strip.py (Playwright + Chromium).
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const html = rd('index.html'), menuCss = rd('ui/dm-menu.css'), compactCss = rd('ui/dm-compact.css');
// css rules (flat; @media blocks are flattened, their inner rules kept)
function rules(css) { css = css.replace(/\/\*[\s\S]*?\*\//g, ''); const out = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m; while ((m = re.exec(css))) out.push({ sel: m[1].trim().replace(/^@media[^{]*$/, ''), body: m[2] }); return out; }

console.log('== soundtrack control: exactly one, inside the menu panel');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/id="float-music"/.test(html), 'the floating #float-music pill is gone from index.html');
ok(!/#float-music/.test(strip(menuCss)) && !/#float-music/.test(strip(compactCss)) && !/float-music/.test(rd('ui/dm-menuscene.js')), 'no css/js rule references #float-music any more');
ok((html.match(/id="mm-mus-toggle"/g) || []).length === 1, 'one toggle button in the page');
const iR = html.indexOf('<div id="mm-right"'), iB = html.indexOf('<div id="mm-bottom"', iR), right = html.slice(iR, iB);
ok(iR > 0 && iB > iR, '#mm-right block found');
ok(right.indexOf('id="mm-music"') > right.indexOf('class="mm-status"') && right.indexOf('class="mm-status"') > 0, '#mm-music is inside #mm-right, below the status rows');
ok(right.indexOf('id="mm-music"') > right.indexOf('class="mm-sub"'), 'and below the LOAD / SAVE / GRAPHICS mini buttons');
const mus = right.slice(right.indexOf('id="mm-music"'), right.indexOf('</div>', right.indexOf('id="mm-music"')));
ok(/onclick="audioToggle\(\)"/.test(mus) && /onclick="audioStop\(\)"/.test(mus) && /id="mm-mus-name"/.test(mus), 'name + play/pause + stop wired to audioToggle / audioStop');
const mr = rules(menuCss).filter(r => /\.mm-music\b/.test(r.sel));
ok(mr.some(r => /border\s*:\s*1px solid rgba\(var\(--acc-rgb\),\.45\)/.test(r.body) && /border-radius\s*:\s*4px/.test(r.body)), 'same border/radius as the .mm-mini buttons');
ok(!mr.some(r => /position\s*:\s*(fixed|absolute)/.test(r.body)), 'in flow (no fixed / absolute positioning)');
ok(/\.mm-mus-name\{[^}]*text-overflow:ellipsis/.test(menuCss) && /\.mm-mus-name\{[^}]*min-width:0/.test(menuCss), 'long track names ellipsize (no overflow on phones)');
ok(/#screen-menu \.mm-music\{grid-column:1 \/ -1;\}/.test(menuCss), 'portrait phones: spans the bottom of the top panel grid');
// state sync, using the real functions
{ const grab = n => html.slice(html.indexOf('function ' + n + '('), html.indexOf('\n}\n', html.indexOf('function ' + n + '(')) + 2);
  const mk = () => ({ textContent: '', dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, classList: { toggle() { } } });
  const tog = mk(), mm = mk(), nm = mk();
  const ctx = { AUDIO: { stopped: false, canStart: false }, $: id => ({ 'mm-mus-toggle': tog, 'mm-music': mm, 'mm-mus-name': nm })[id] || null, document: { querySelectorAll: () => [] } };
  vm.createContext(ctx); vm.runInContext(grab('syncAudioUI') + grab('updateTrackName'), ctx);
  vm.runInContext('syncAudioUI(true)', ctx); ok(tog.textContent === '⏸' && mm.dataset.state === 'playing', 'playing -> pause glyph, state=playing');
  vm.runInContext('syncAudioUI(false)', ctx); ok(tog.textContent === '▶' && mm.dataset.state === 'paused', 'paused -> play glyph, state=paused');
  ctx.AUDIO.stopped = true; vm.runInContext('syncAudioUI(false)', ctx); ok(mm.dataset.state === 'stopped', 'stopped -> state=stopped');
  vm.runInContext("updateTrackName('Arc Lake')", ctx); ok(nm.textContent === 'ARC LAKE', 'track name follows the playlist'); }
ok(/if\(!AUDIO\.canStart\) return;/.test(html), 'the first-tap kick does nothing until loading is finished (AUDIO.canStart)');
ok(/function enterApp\(\)\{[\s\S]{0,400}AUDIO\.canStart=true/.test(html) && /function startMenuMusic\(\)\{\s*\n\s*AUDIO\.canStart=true/.test(html), 'canStart is set only by LAUNCH (enterApp) / the menu showing (startMenuMusic)');

console.log('== system message bar (#dm-sys)');
let css = ''; const el = { setAttribute() { }, isConnected: true, textContent: '', className: '' };
const sb = { window: null, document: { body: { appendChild() { } }, head: { appendChild(st) { css += st.textContent; } }, documentElement: {}, getElementById: id => id === 'dm-sys' ? null : null,
  createElement: () => ({ setAttribute() { }, textContent: '', id: '', className: '' }), addEventListener() { } }, setTimeout, clearTimeout, Date };
sb.window = sb; vm.createContext(sb); vm.runInContext(rd('ui/dm-sys.js'), sb);
ok(typeof sb.dmSys === 'function' && typeof sb.dmSys.load === 'function', 'dmSys + dmSys.load exist');
const R = rules(css), base = R.find(r => r.sel === '#dm-sys'), on = R.find(r => r.sel === '#dm-sys.on');
ok(base && /left:50%/.test(base.body) && /translate\(-50%/.test(base.body) && /text-align:center/.test(base.body) && !/right:0/.test(base.body), 'bar is centred (left 50 % + translate -50 %, centred text, no right:0)');
ok(on && /translate\(-50%,0\)/.test(on.body), 'shown state keeps the centring');
ok(/pointer-events:none/.test(base.body), 'pointer-events none'); ok(/safe-area-inset-bottom/.test(base.body), 'safe-area aware');
const grad = (base.body.match(/linear-gradient\(([^;]*)\);/) || [])[1] || '', stops = grad.match(/rgba\([^)]*\)/g) || [], A = c => +c.slice(5, -1).split(',')[3];
ok(/^to right/.test(grad) && stops.length >= 3 && A(stops[0]) === 0 && A(stops[stops.length - 1]) === 0 && Math.max(...stops.map(A)) >= 0.75, 'two-sided fade: transparent at both ends, ' + Math.max(...stops.map(A)) + ' in the middle');
const play = R.filter(r => /body:has\(#screen-flight\.active\) #dm-sys/.test(r.sel) && !/#dm-sys\.ld/.test(r.sel));
const ldPlay = R.filter(r => /body:has\(#screen-flight\.active\) #dm-sys\.ld/.test(r.sel));
ok(ldPlay.length === 1 && !/bottom:/.test(ldPlay[0].body), 'loading/warp lines in play keep the bottom-edge position (no lift, so never mid-screen over a loader)');
const lift = play.map(r => { const m = r.body.match(/bottom:calc\((?:clamp\((\d+)px[^)]*\)|(\d+)px)/); return m ? +(m[1] || m[2]) : 0; });
ok(play.length >= 2 && lift.every(v => v >= 130), 'gameplay: the same bar lifted above the stick row (' + lift.join(' / ') + ' px; sticks top out ~130 px)');
ok(play.every(r => /max-width:min\((\d+)vw/.test(r.body) && +r.body.match(/max-width:min\((\d+)vw/)[1] <= 56), 'gameplay: narrower bar (clears the side sticks / pads)');
ok(play.every(r => !/left|right:|transform/.test(r.body.replace(/padding-[a-z]+/g, ''))), 'gameplay: still the same centred element (only lift / width change)');
ok(/function toast\(/.test(html) && /dmSys\(/.test(html.slice(html.indexOf('function toast('), html.indexOf('function toast(') + 600)), 'toast() is still a dmSys shim');
ok(!/id="toast"/.test(html), 'no #toast element (retired v240)');
ok(/ui\/dm-sys\.js\?v=(?:30[2-9]|3[1-9]\d)/.test(html) && /ui\/dm-menu\.css\?v=(?:30[2-9]|3[1-9]\d)/.test(html), 'edited files restamped (?v=302 = sw dartmeadow-engine-v302)');

console.log('== SHIELD left-stick button (t1611u)');
const shSrc = rd('ui/dm-shield.js'), flSrc = rd('ui/dm-flash.js');
ok(/ui\/dm-shield\.js\?v=\d+/.test(html), 'index.html loads ui/dm-shield.js (stamped)');
ok(/id = 'dm-shield'/.test(shSrc) && /id = 'dm-shield-btn'/.test(shSrc) && /className = 'fl-btn'/.test(shSrc), 'wrapper #dm-shield + button #dm-shield-btn.fl-btn (same class as the flashlight)');
ok(/#dm-shield\{[^}]*display:none/.test(shSrc) && /#dm-shield\[data-show="1"\]\{[^}]*display:block/.test(shSrc), 'hidden by default; shown only with data-show=1');
ok(/title = 'SHIELD'/.test(shSrc) && /aria-label', 'SHIELD'/.test(shSrc), 'labelled SHIELD');
ok(/#dm-shield\.on \.fl-btn\{/.test(shSrc) && /#dm-flash\.on \.fl-btn\{/.test(flSrc), 'lit state uses the same .on class as the flashlight');
{ const grab = (src, sel) => { const i = src.indexOf(sel); if (i < 0) return ''; const a = src.indexOf('{', i), b = src.indexOf('}', a); return src.slice(a + 1, b); };
  const fb = grab(flSrc, '#dm-flash .fl-btn{'), sb = grab(shSrc, '#dm-shield .fl-btn{');
  const fon = grab(flSrc, '#dm-flash.on .fl-btn{'), son = grab(shSrc, '#dm-shield.on .fl-btn{');
  ok(fb && fb === sb, 'flashlight and shield .fl-btn chrome CSS match exactly');
  ok(fon && fon === son, 'flashlight and shield lit (.on .fl-btn) CSS match exactly'); }
ok(/const SZ = 34, GAP = 6/.test(shSrc) && /getElementById\('dm-flash'\)/.test(shSrc) && /bot \+ SZ \+ GAP/.test(shSrc), 'docks next to #dm-flash (same 34 px button, 6 px gap, above the flashlight so the lumen bar stays free)');
ok(/addEventListener\('dmshield'/.test(shSrc), 'listens for the dmshield window event');
ok(/if \(root\.DMShield\) DMShield\.toggle\(\)/.test(shSrc), 'a tap calls window.DMShield && DMShield.toggle()');
ok(/touchstart/.test(shSrc) && /pointerdown/.test(shSrc) && /mousedown/.test(shSrc) && /stopPropagation/.test(shSrc), 'same pointer/touch stop as the flashlight (tap does not leak into the stick)');
ok(!/requestAnimationFrame\s*\(/.test(shSrc) && !/setInterval\s*\(/.test(shSrc), 'no rAF loop or setInterval');
ok(!/(?:window|root)\.DMShield\s*=/.test(shSrc), 'does not stub or assign window.DMShield (Lighting owns the hook in dm-hazardbubble.js)');
ok(!/dm-hazardbubble\.js/.test(shSrc) || /does not create or own/.test(shSrc), 'HUD file only; does not edit dm-hazardbubble.js');
// behaviour: hidden without DMShield; event shows it, lights .on, sits above the flashlight
{ const el = (tag) => {
    const o = { tagName: tag, id: '', className: '', style: {}, attrs: {}, children: [], listeners: {},
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      classList: { _s: new Set(), contains(n) { return this._s.has(n); }, toggle(n, on) { if (on) this._s.add(n); else this._s.delete(n); o.className = [...this._s].join(' '); } } };
    Object.defineProperty(o, 'innerHTML', { set() { }, get() { return ''; } });
    return o;
  };
  const body = el('body'), head = el('head'), nodes = {};
  const flash = el('div'); flash.id = 'dm-flash'; flash.attrs['data-m'] = 'walk'; flash.style.left = '120px'; flash.style.bottom = '40px';
  const flight = el('div'); flight.id = 'screen-flight'; flight.className = 'screen active'; flight.classList._s.add('active');
  const doc = { body, head, documentElement: {}, readyState: 'complete',
    getElementById: id => id === 'dm-flash' ? flash : id === 'screen-flight' ? flight : id === 'dm-shield' ? nodes.w : id === 'dm-shield-btn' ? nodes.b : id === 'dm-shield-css' ? nodes.css : null,
    createElement: tag => { const n = el(tag); if (tag === 'style') nodes.css = n; if (tag === 'div') nodes.w = n; if (tag === 'button') nodes.b = n; return n; },
    addEventListener() { } };
  body.appendChild = c => { body.children.push(c); return c; };
  const evs = {}, ctx = { document: doc, MutationObserver: function () { this.observe = function () { }; this.disconnect = function () { }; } };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.addEventListener = (t, fn) => { evs[t] = fn; };
  vm.createContext(ctx); vm.runInContext(shSrc, ctx);
  ok(nodes.w && nodes.w.id === 'dm-shield' && nodes.b && nodes.b.id === 'dm-shield-btn' && nodes.b.className === 'fl-btn', 'widget built as #dm-shield > #dm-shield-btn.fl-btn');
  ok(nodes.w.getAttribute('data-show') !== '1' && !nodes.w.classList.contains('on'), 'stays hidden when DMShield is missing');
  evs.dmshield({ type: 'dmshield', detail: { available: true, on: true } });
  ok(nodes.w.getAttribute('data-show') === '1', 'shown on dmshield when available');
  ok(nodes.w.classList.contains('on') && nodes.b.getAttribute('aria-pressed') === 'true', 'lit .on state follows detail.on');
  ok(nodes.w.style.left === '120px' && nodes.w.style.bottom === '80px', 'sits next to the flashlight (same left, 34+6 px above)');
  let toggled = 0; ctx.DMShield = { available: true, on: true, toggle() { toggled++; } };
  nodes.b.listeners.click({ stopPropagation() { } });
  ok(toggled === 1, 'click calls DMShield.toggle()');
  evs.dmshield({ type: 'dmshield', detail: { available: false, on: false } });
  ok(nodes.w.getAttribute('data-show') === '' && !nodes.w.classList.contains('on'), 'hides again when available is false'); }

console.log(fails ? 'hud-layout: FAILED ' + fails + '/' + n : 'hud-layout: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
