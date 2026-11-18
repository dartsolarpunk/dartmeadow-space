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

console.log('== hazard indicator HUD (ui/dm-hazardhud.js)');
{ const hSrc = rd('ui/dm-hazardhud.js'), hzSrc = rd('ui/dm-hazard.js');
  ok(/ui\/dm-hazardhud\.js\?v=\d+/.test(html) && !/dm-shield\.js|dm-hazardbubble/.test(html), 'index.html loads ui/dm-hazardhud.js; the old SHIELD button file and the orb file are not referenced');
  ok(!fs.existsSync(path.join(root, 'ui', 'dm-shield.js')) && !/dm-shield-btn|DMShield\.toggle/.test(hSrc), 'no SHIELD toggle button any more');
  const cssTxt = (hSrc.match(/const CSS = ([\s\S]*?);\n  let el/) || [])[1] || '';
  const root0 = (cssTxt.match(/#dm-hazhud\{[^}]*\}/) || [''])[0]; ok(/position:fixed/.test(root0) && !/left:50%/.test(root0) && /pointer-events:none/.test(root0), 'a fixed, non-interactive tab on the LEFT, no longer centred on the screen (never eats a touch)');
  const topPx = +((cssTxt.match(/#dm-hazhud\{[^}]*top:(\d+)px/) || [])[1] || 0), leftPx = +((cssTxt.match(/#dm-hazhud\{[^}]*left:(\d+)px/) || [])[1] || 0);
  ok(topPx > 0 && topPx <= 60 && leftPx >= 34, 'default slot hangs right under the top-left header strip (top ' + topPx + ' px) and clears the fullscreen-exit button at the left edge (left ' + leftPx + ' px)');
  const w0 = +((cssTxt.match(/#dm-hazhud\{[^}]*width:(\d+)px/) || [])[1] || 999), mh = +((cssTxt.match(/\[data-show="1"\]\{max-height:(\d+)px/) || [])[1] || 999);
  ok(w0 <= 140 && mh <= 72, 'narrow (' + w0 + ' px) and short (<= ' + mh + ' px): a small tab, not a card');
  ok(/overflow:hidden;max-height:0;visibility:hidden/.test(cssTxt) && /transition:max-height/.test(cssTxt) && /data-show="1"\]\{max-height/.test(cssTxt), 'drop-down: retracted (max-height 0, hidden) until a hazard is sensed, then it extends with a max-height transition');
  ok(/\.hh-card\{[^}]*border-radius:0 0 \d+px \d+px[^}]*border-top:0/.test(cssTxt), 'cut-out tab look: square top edge flush with the header, rounded bottom corners');
  ok(/#screen-menu\.active\) #dm-hazhud/.test(cssTxt) && /#screen-builder\.active\) #dm-hazhud/.test(cssTxt), 'never over the menu / builder');
  ok(/#screen-menu\.active\) #dm-hazhud/.test(cssTxt) && /#screen-builder\.active\) #dm-hazhud/.test(cssTxt) && /display:none !important/.test(cssTxt), 'never over the menu / builder');
  ok(/function place\(\)/.test(hSrc) && /world-music/.test(hSrc) && /#fs-exit/.test(hSrc) && /mini-kite/.test(hSrc), 'placed from the live DOM: under the soundtrack strip, right of the fullscreen-exit button, left of the mini-kite (read when it opens / on resize, never per frame)');
  ok(!/(setInterval|requestAnimationFrame)\(/.test(hSrc.replace(/\/\*[\s\S]*?\*\//, '')) && /addEventListener\('dmhazardhud'/.test(hSrc), 'no timer / rAF: it only listens for dmhazardhud');
  ok(/band|hh-band/.test(hSrc) && /hh-mark/.test(hSrc) && /transition:left/.test(hSrc), 'band meter + marker that eases');
  // behaviour: the pure view() the card is rendered from
  const ctx = { window: null, document: null, console }; ctx.window = ctx; vm.createContext(ctx); vm.runInContext(hSrc, ctx); const V = ctx.DMHazardHud.view;
  ok(V(null).show === false && V({ on: false }).show === false, 'no hazard: hidden');
  let v = V({ on: true, sensed: true, state: 'protected', label: 'TOXIC ATMOSPHERE', hue: '#35ff7e', marker: 1, reserve: 0.5, sec: 45, zero: false });
  ok(v.show && v.type === 'TOXIC ATMOSPHERE' && v.time === 'SAFE TIME 00:45' && v.marker === 1 && v.st === 'protected', 'inside: type + SAFE TIME countdown + marker at the right end');
  v = V({ on: true, sensed: true, state: 'alert', label: 'VOLCANIC PLUME', marker: 0.3, reserve: 1, sec: Infinity }); ok(/NEAR/.test(v.time) && v.st === 'alert' && v.marker === 0.3, 'near: no countdown, marker on the left half');
  v = V({ on: true, sensed: true, state: 'exposed', label: 'TOXIC ATMOSPHERE', marker: 1, reserve: 0, sec: 0, zero: true }); ok(/OVEREXPOSED/.test(v.time) && v.st === 'exposed', 'zero: the clear warning state');
  v = V({ on: true, sensed: false, state: 'off', label: 'VOLCANIC PLUME', marker: 0, reserve: 0.6, refill: 12 }); ok(/RECOVERING 00:12/.test(v.time) && v.marker === 0, 'after she leaves: marker back at 0, RECOVERING with the refill time');
  v = V({ on: true, sensed: true, shield: true, state: 'shielded', label: 'TOXIC ATMOSPHERE', marker: 1, reserve: 1, sec: Infinity, refill: 0 }); ok(v.st === 'shielded' && /SHIELD ON/.test(v.time) && !/SAFE TIME/.test(v.time), 'shield ON, reserve full: no countdown, SHIELD ON');
  v = V({ on: true, sensed: true, shield: true, state: 'shielded', marker: 1, reserve: 0.4, sec: Infinity, refill: 27 }); ok(v.st === 'shielded' && v.time === 'RECOVERING 00:27', 'shield ON, reserve not full: RECOVERING mm:ss (the clock refills)');
  ok(V({ on: true, sensed: true, state: 'exposed', zero: true, marker: 1, reserve: 0 }).time.length <= 14 && V({ on: true, sensed: true, state: 'alert', marker: .2, reserve: 1 }).time.length <= 14, 'the long warnings are short enough for the narrow tab');
  ok(V({ on: true, sensed: true, state: 'protected', marker: 7, reserve: 3, sec: 1 }).marker === 1 && V({ on: true, sensed: true, state: 'protected', marker: -2, reserve: -1, sec: 1 }).reserve === 0, 'marker / reserve are clamped to 0..1');
  // dormant: one listener at load; the DOM exists only after the first sensed event
  const evs = {}, nodes = []; const mkEl = () => { const e = { style: { setProperty() { }, left: '', top: '', width: '', transform: '' }, attrs: {}, setAttribute(k, x) { this.attrs[k] = x; }, getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }, appendChild() { }, querySelector: () => mkEl(), textContent: '', set innerHTML(x) { } }; return e; };
  const dctx = { console, setInterval() { throw new Error('timer'); }, requestAnimationFrame() { throw new Error('raf'); }, addEventListener: (k, f) => { evs[k] = f; }, innerWidth: 800, document: { head: { appendChild() { } }, body: { appendChild(e) { nodes.push(e); } }, getElementById: () => null, createElement: () => mkEl(), querySelector: sel => (/world-music/.test(sel) ? { getBoundingClientRect: () => ({ left: 8, top: 9, right: 213, bottom: 33, width: 205, height: 24 }) } : /fs-exit/.test(sel) ? { getBoundingClientRect: () => ({ left: 0, top: 56, right: 34, bottom: 90, width: 34, height: 34 }) } : /mini-kite/.test(sel) ? { getBoundingClientRect: () => ({ left: 232, top: 6, right: 408, bottom: 87, width: 176, height: 81 }) } : null) } };
  dctx.window = dctx; vm.createContext(dctx); vm.runInContext(hSrc, dctx);
  ok(Object.keys(evs).join() === 'dmhazardhud' && nodes.length === 0, 'safe map: exactly one window listener, no DOM, no style');
  evs.dmhazardhud({ detail: { on: false } }); ok(nodes.length === 0, 'an "off" event builds nothing');
  evs.dmhazardhud({ detail: { on: true, sensed: true, state: 'protected', marker: 1, reserve: 1, sec: 90, label: 'X' } }); ok(nodes.length === 1 && nodes[0].attrs['data-show'] === '1', 'first sensed event: card built + shown');
  { const q = nodes[0].style; ok(+q.top.replace('px', '') >= 33 && +q.top.replace('px', '') <= 40 && +q.left.replace('px', '') >= 34 && +q.width.replace('px', '') >= 96 && +q.width.replace('px', '') <= 138 && (+q.left.replace('px', '') + +q.width.replace('px', '')) <= 232, 'placed at 800 x 450: top ' + q.top + ' left ' + q.left + ' width ' + q.width + ': under the soundtrack strip (bottom 33), right of the exit button (right 34), left of the mini-kite (left 232): no overlap'); }
  evs.dmhazardhud({ detail: { on: false } }); ok(nodes[0].attrs['data-show'] === '', 'hazard gone: card hidden (retracts)');
  // the hazard module emits it at <= ~4 Hz, on change
  ok(/function emitHud\(force\)/.test(hzSrc) && /now-EX\.emitT<250/.test(hzSrc), 'ui/dm-hazard.js emits dmhazardhud on change, at most every 250 ms'); }

console.log(fails ? 'hud-layout: FAILED ' + fails + '/' + n : 'hud-layout: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
