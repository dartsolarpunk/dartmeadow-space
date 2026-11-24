// node tools/tests/charselect-ui.test.js — v381 Articren selector / editor card UI.
// Pure node: source contracts on the real files + the exported uiMachine state machine
// (no THREE, no browser).  The machine is the only new control flow: select (wheel +
// continue pop-out) <-> editor (one taller card) <-> leave.  No eye / hide toggle.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = rd('index.html'), js = rd('ui/dm-charselect.js'), css = rd('ui/dm-charselect.css'), ui = rd('ui/dm-ui.css'), menu = rd('ui/dm-menu.css');
let n = 0, fails = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };

const screen = html.slice(html.indexOf('id="screen-character"'), html.indexOf('id="screen-builder"'));

// ── contracts: reuse the main-menu card system
ok(ui.includes('.dm-card,.mm-frame') && ui.includes('clip-path:polygon(var(--cut)'), 'shared .mm-frame / .dm-card hairline lives in ui/dm-ui.css');
ok(/@keyframes mmOpenL/.test(menu) && /@keyframes mmCloseR/.test(menu), 'hinge keyframes live in ui/dm-menu.css (reused, not redeclared)');
ok(!/@keyframes mmOpenL/.test(css) && !/@keyframes mmCloseL/.test(css), 'charselect.css does not redeclare menu hinge keyframes');
ok(/animation:mmOpenB/.test(css) && /animation:mmOpenR/.test(css) && /animation:mmCloseB/.test(css) && /animation:mmCloseR/.test(css), 'selector + editor animate with mmOpen / mmClose');
ok(/class="cs-card mm-frame"/.test(js) && /cs-card-slot mm-panel/.test(js), 'character cards are mm-panel slots wrapping an mm-frame');
ok(/id="cs-continue" class="mm-panel mm-frame mm-hinge-bottom"/.test(screen), 'continue is a small mm-frame pop-out card');
ok(/id="cs-panel" class="mm-panel mm-frame mm-hinge-right"/.test(screen), 'editor is one taller mm-frame card');
ok(/id="cs-head" class="mm-panel mm-hinge-top"/.test(screen), 'header uses the same top-hinge panel as the main menu title');
ok(/id="cs-next"/.test(screen) && screen.indexOf('id="cs-continue"') < screen.indexOf('id="cs-next"') && /W\.goScreen\('builder'\)/.test(js), 'cs-next still lives in the pop-out and continues to the builder');

// ── no leftover footer VIEW button, no eye / hide toggle, never "Pilot" in the UI
ok(!/id="cs-open"/.test(html) && !/id="cs-foot"/.test(html), 'VIEW footer (#cs-open / #cs-foot) is gone');
ok(!/VIEW ARIEL|id="cs-open"/.test(js), 'JS no longer binds a VIEW button');
const uiText = screen + js + css;
ok(!/\beye\b/i.test(screen) && !/id="cs-eye"|id="cs-hide"|cs-eye|cs-hide/.test(screen + js), 'no eye or dismiss control in the Articren selector or editor');
ok(!/\bPilot\b/.test(screen) && !/\bPilot\b/.test(css), 'character screen + charselect CSS never say Pilot');
const jsNoComments = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/\bPilot\b/.test(jsNoComments), 'charselect.js runtime strings never say Pilot');
ok(/CHOOSE YOUR ARTICREN/.test(screen) && /TAP A CARD TO EDIT/.test(screen), 'selector copy names Articren and says tap a card to edit');

// ── goScreen folds the character screen like the menu
const gs = html.slice(html.indexOf('function goScreen('), html.indexOf('function goScreen(') + 9000);
ok(/cs\.classList\.add\('cs-leaving'\)/.test(gs) && /cs-leaving/.test(css), 'goScreen adds .cs-leaving so the cards fold away');
ok(/if\(name==='character'\)\{\$\('screen-character'\)\.classList\.add\('active'\)/.test(html), 'goScreen character branch is intact');
ok(/_prevScreen==='character'&&name!=='character'&&window\.DMCharSelect\) DMCharSelect.leave\(\)/.test(html), 'leaving still disposes the studio');

// ── touch-friendly targets kept, ATMO_DEFAULT_AGL untouched
ok(/min-height:44px/.test(css) && /min-height:48px/.test(css), 'controls stay 44 px; continue is 48 px');
ok(/ATMO_DEFAULT_AGL\s*=\s*46/.test(html), 'ATMO_DEFAULT_AGL stays 46');

// ── state machine
const sandbox = { window: {}, document: { getElementById() { return null; }, readyState: 'complete', addEventListener() {} }, console };
sandbox.window = sandbox;
vm.runInNewContext(js, sandbox, { filename: 'dm-charselect.js' });
const M = sandbox.window.DMCharSelect;
ok(M && typeof M.uiMachine === 'function' && typeof M.uiState === 'function', 'DMCharSelect exports uiMachine + uiState');
const idle = { mode: 'idle', pickedId: null };
const entered = M.uiMachine(idle, { type: 'enter', pickedId: 'ariel' });
ok(entered.mode === 'select' && entered.pickedId === 'ariel', 'enter -> select with the picked id');
const picked = M.uiMachine(entered, { type: 'pick', id: 'emma' });
ok(picked.mode === 'select' && picked.pickedId === 'emma', 'pick updates the centred id and keeps the continue pop-out');
const editing = M.uiMachine(picked, { type: 'edit', id: 'emma' });
ok(editing.mode === 'editor' && editing.pickedId === 'emma', 'tapping the centred card enters the editor');
const ignoredPick = M.uiMachine(editing, { type: 'pick', id: 'ariel' });
ok(ignoredPick.mode === 'editor', 'a wheel pick while editing does not close the editor');
const back = M.uiMachine(editing, { type: 'back' });
ok(back.mode === 'select' && back.pickedId === 'emma', 'BACK leaves the editor on the same Articren');
const leaving = M.uiMachine(back, { type: 'leave' });
ok(leaving.mode === 'leaving' && leaving.pickedId === 'emma', 'leave starts the fold-away state');
const done = M.uiMachine(leaving, { type: 'idle' });
ok(done.mode === 'idle', 'idle after the screen is gone');
ok(M.uiState().mode === 'idle', 'uiState starts idle before enter (no DOM)');

console.log(fails ? 'charselect-ui: ' + fails + ' FAILED of ' + n : 'charselect-ui: all ' + n + ' passed');
process.exit(fails ? 1 : 0);
