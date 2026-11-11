// node tools/tests/loader-text.js — loader messages all live in the one bottom-centre slot (ui/dm-sys.js); no mid-screen loader text, no loading-screen music chip.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL ' + m); } };
const html = rd('index.html'), menuCss = rd('ui/dm-menu.css');
ok(/#ls-status,#intro-status,#mini-loader-status,#mini-loader-pct\{display:none !important;\}/.test(html), 'mid-screen loader text lines are hidden');
ok(/<div id="float-music" style="display:none;(?:(?!display:)[^"])*"/.test(html), '#float-music is hidden by default (no second display:flex)');
ok(/body:has\(#loading-screen:not\(\.out\)\) #float-music/.test(menuCss) && /body:has\(#intro-veil\) #float-music/.test(menuCss), 'chip hidden while loading screen / intro veil are up');
ok(!/dmSys\.load\('intro','Tap to skip'\)/.test(html) && /dmSys\.hint\('Tap to skip'\)/.test(html), 'tap-to-skip goes through dmSys.hint');
const els = {}; const sb = { document: { body: { appendChild(e) { els.bar = e; } }, head: { appendChild() { } }, documentElement: {}, getElementById: () => null, createElement: () => ({ setAttribute() { }, isConnected: true, textContent: '', className: '' }), addEventListener() { } }, setTimeout, clearTimeout, Date };
sb.window = sb; vm.createContext(sb); vm.runInContext(rd('ui/dm-sys.js'), sb);
const d = sb.dmSys;
d.hint('Tap to skip'); ok(els.bar.textContent === 'Tap to skip', 'hint alone shows in the slot');
d.load('warm', 'Preparing world 1/11 · 0%'); ok(/^Preparing world 1\/11 .*Tap to skip$/.test(els.bar.textContent), 'hint stacks onto the loading line (one element, no overlap): ' + els.bar.textContent);
d.done('warm'); ok(els.bar.textContent === 'Tap to skip', 'back to hint alone');
d.done('intro'); ok(els.bar.className === '', 'done(intro) clears the hint and hides the bar');
console.log(fails ? fails + ' FAILED' : 'loader-text: all ok'); process.exit(fails ? 1 : 0);
