// node tools/tests/hud-layout.js — v298 HUD (no browser): the CLINICAL BLOOM soundtrack chip lives on the menu's right instrument panel, not the bottom
// centre; the system message bar (ui/dm-sys.js) is centred with a two-sided fade, pointer-events none, lifted above the sticks in play; toast() is a dmSys shim.
// The full layout (real rects at desktop / phone landscape / phone portrait) is tools/tests/sys-strip.py (Playwright + Chromium).
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const html = rd('index.html'), menuCss = rd('ui/dm-menu.css'), compactCss = rd('ui/dm-compact.css');
// css rules (flat; @media blocks are flattened, their inner rules kept)
function rules(css) { css = css.replace(/\/\*[\s\S]*?\*\//g, ''); const out = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m; while ((m = re.exec(css))) out.push({ sel: m[1].trim().replace(/^@media[^{]*$/, ''), body: m[2] }); return out; }

console.log('== soundtrack chip (#float-music) on the right menu panel');
const fmRules = rules(menuCss).concat(rules(compactCss)).filter(r => /#float-music/.test(r.sel));
ok(fmRules.length > 0, 'menu css still styles the chip');
ok(!fmRules.some(r => /left\s*:\s*50%/.test(r.body) || /bottom\s*:/.test(r.body) && !/bottom\s*:\s*auto/.test(r.body)), 'no menu rule pins #float-music to the bottom / horizontal centre (incl. the portrait-phone override)');
ok(!/body:has\(#screen-menu\.active\)\s*#float-music/.test(menuCss.replace(/\/\*[\s\S]*?\*\//g, '')), 'the old body:has(#screen-menu.active) #float-music bottom-centre rule is gone');
const dock = fmRules.find(r => /\.mm-music\s*>\s*#float-music/.test(r.sel)); ok(dock && /position\s*:\s*static\s*!important/.test(dock.body) && /transform\s*:\s*none\s*!important/.test(dock.body), 'docked chip is static inside the panel (no fixed / translate)');
const iR = html.indexOf('<div id="mm-right"'), iB = html.indexOf('<div id="mm-bottom"', iR), right = html.slice(iR, iB);
ok(iR > 0 && iB > iR, '#mm-right block found');
ok(right.indexOf('id="mm-music"') > right.indexOf('class="mm-status"') && right.indexOf('class="mm-status"') > 0, '#mm-music slot is inside #mm-right, under the status rows');
const fmTag = html.slice(html.indexOf('<div id="float-music"'), html.indexOf('</div>', html.indexOf('<div id="float-music"')));
ok(/CLINICAL BLOOM/.test(fmTag) && !/CLASSICAL/.test(fmTag), 'label is CLINICAL BLOOM'); ok(/onclick="audioToggle\(\)"/.test(fmTag) && /onclick="audioStop\(\)"/.test(fmTag), 'play/pause + stop buttons kept');
const rw = (menuCss.match(/#mm-right\{[^}]*width:clamp\((\d+)px/) || [])[1]; ok(+rw >= 200, 'right panel widened for the chip (min ' + rw + ' px, was 180)');
ok(/#screen-menu \.mm-music\{grid-column:1 \/ -1;\}/.test(menuCss), 'portrait phones: the chip spans the panel grid');
// _dockFloatMusic: the real function against a tiny DOM
{ const src = html.slice(html.indexOf('function _dockFloatMusic('), html.indexOf('\n}\n', html.indexOf('function _dockFloatMusic(')) + 2);
  const mk = id => ({ id, parentNode: null, children: [], appendChild(c) { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) { this.appendChild(c); return c; } });
  const body = mk('body'), app = mk('app'), slot = mk('mm-music'), fm = mk('float-music'); body.appendChild(fm); body.appendChild(app);
  const ctx = { STATE: { screen: 'menu' }, document: { body }, $: id => ({ 'float-music': fm, 'mm-music': slot, app })[id] }; vm.createContext(ctx); vm.runInContext(src, ctx);
  ctx.STATE.screen = 'menu'; vm.runInContext('_dockFloatMusic()', ctx); ok(fm.parentNode === slot, 'menu: chip docks into #mm-music');
  ctx.STATE.screen = 'builder'; vm.runInContext('_dockFloatMusic()', ctx); ok(fm.parentNode === body, 'builder: chip back on its fixed spot (body)');
  ctx.STATE.screen = 'flight'; vm.runInContext('_dockFloatMusic()', ctx); ok(fm.parentNode === body, 'flight: chip stays out of the panel (hidden in game as before)'); }
const gs = html.slice(html.indexOf('function goScreen(name){'), html.indexOf('\n}\n', html.indexOf('function goScreen(name){')));
ok(/STATE\.screen=name;\s*\n\s*try\{ _dockFloatMusic\(\); \}catch\(e\)\{\}/.test(gs), 'goScreen docks / undocks the chip (event-driven, no per-frame work)');
ok(/hideFloatingMusicInGame\(\)/.test(gs) && /showFloatingMusic\(\)/.test(gs), 'show on pre-flight screens / hide in game unchanged');

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
const play = R.filter(r => /body:has\(#screen-flight\.active\) #dm-sys/.test(r.sel));
const lift = play.map(r => { const m = r.body.match(/bottom:calc\((?:clamp\((\d+)px[^)]*\)|(\d+)px)/); return m ? +(m[1] || m[2]) : 0; });
ok(play.length >= 2 && lift.every(v => v >= 130), 'gameplay: the same bar lifted above the stick row (' + lift.join(' / ') + ' px; sticks top out ~130 px)');
ok(play.every(r => /max-width:min\((\d+)vw/.test(r.body) && +r.body.match(/max-width:min\((\d+)vw/)[1] <= 56), 'gameplay: narrower bar (clears the side sticks / pads)');
ok(play.every(r => !/left|right:|transform/.test(r.body.replace(/padding-[a-z]+/g, ''))), 'gameplay: still the same centred element (only lift / width change)');
ok(/function toast\(/.test(html) && /dmSys\(/.test(html.slice(html.indexOf('function toast('), html.indexOf('function toast(') + 600)), 'toast() is still a dmSys shim');
ok(!/id="toast"/.test(html), 'no #toast element (retired v240)');
ok(/ui\/dm-sys\.js\?v=302/.test(html) && /ui\/dm-menu\.css\?v=302/.test(html), 'edited files restamped (?v=302 = sw dartmeadow-engine-v302)');
console.log(fails ? 'hud-layout: FAILED ' + fails + '/' + n : 'hud-layout: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
