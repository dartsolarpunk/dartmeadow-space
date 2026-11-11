// node tools/tests/loader-text.js — loader messages all live in the one bottom-centre slot (ui/dm-sys.js); no mid-screen loader text, no music control during loading.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL ' + m); } };
const html = rd('index.html'), menuCss = rd('ui/dm-menu.css');
ok(/#ls-status,#intro-status,#mini-loader-status,#mini-loader-pct(,#warp-status)?\{display:none !important;\}/.test(html), 'mid-screen loader text lines are hidden');
ok(!/id="float-music"/.test(html) && !/float-music/.test(menuCss), 'no floating music pill exists to show during loading; the control is only in the menu panel');
const els = {}; const sb = { document: { body: { appendChild(e) { els.bar = e; } }, head: { appendChild() { } }, documentElement: {}, getElementById: () => null, createElement: () => ({ setAttribute() { }, isConnected: true, textContent: '', className: '' }), addEventListener() { } }, setTimeout, clearTimeout, Date };
sb.window = sb; vm.createContext(sb); vm.runInContext(rd('ui/dm-sys.js'), sb);
const d = sb.dmSys;
d.load('warm', 'Preparing world 1/11 \u00b7 0%'); ok(els.bar.textContent === 'Preparing world 1/11 \u00b7 0%' && /\bld\b/.test(els.bar.className), 'loading line alone in the slot, .ld');
d.done('warm'); ok(els.bar.className === '' && typeof d.hint === 'undefined', 'done hides the bar; dmSys.hint removed');
console.log(fails ? fails + ' FAILED' : 'loader-text: all ok'); process.exit(fails ? 1 : 0);
