// node tools/tests/home-move-input.js — t1472 "after HOME landing I still cannot move": the walk sticks' input path (no browser).
// Runs the REAL setupSurfaceJoysticks() from index.html against a tiny event DOM: a cancelled touch (iOS touchcancel: system gesture, the HUD
// swapping under the finger) used to leave the stick latched (`active` stuck, every later touchstart ignored -> the MOVE stick dead for the session).
// Asserts: touchend and touchcancel both release; a new touch then drives surfJoyMove again; _pwSetMode releases both sticks on every HUD change
// (landing / HOME / liftoff); the zone mapping (LEFT = look, RIGHT = move) and the 50 px radius are unchanged. The walk physics after a real HOME
// landing (stick vector -> she translates on the deck) is tools/tests/home-landing-real.js.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..'), src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error(name); }
function el(id, rect) { const L = {}; return { id, style: {}, classList: { toggle() { } }, L, addEventListener(t, f) { (L[t] = L[t] || []).push(f); }, removeEventListener(t, f) { const a = L[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }, getBoundingClientRect: () => rect, fire(t, e) { (L[t] || []).slice().forEach(f => f(e)); } }; }
const win = el('window'), doc = el('document');
const Z = { 'surf-move-zone': el('surf-move-zone', { left: 24, top: 600, width: 100, height: 100 }), 'surf-look-zone': el('surf-look-zone', { left: 600, top: 600, width: 100, height: 100 }) };
for (const k of ['surf-move-knob', 'surf-look-knob', 'surf-jump-btn', 'surf-run-btn', 'surf-climb-btn']) Z[k] = el(k);
const ctx = { window: win, document: doc, $: id => Z[id] || null, _clamp: (v, a, b) => Math.max(a, Math.min(b, v)), Math };
vm.createContext(ctx);
vm.runInContext('var surfJoyMove={x:0,y:0},surfLookJoy={x:0,y:0},surfJumpPressed=false,surfClimbHeld=false,surfRunToggle=false;\n' + fn('setupSurfaceJoysticks') + '\nsetupSurfaceJoysticks();', ctx);
const MOVE = Z['surf-look-zone'], LOOK = Z['surf-move-zone'], mv = () => ctx.surfJoyMove, lk = () => ctx.surfLookJoy;
const T = (id, x, y) => ({ identifier: id, clientX: x, clientY: y }), ev = (...t) => ({ changedTouches: t, preventDefault() { } });
// push the MOVE stick (right zone) forward: centre (650,650), up 40 px
MOVE.fire('touchstart', ev(T(1, 650, 610)));
ok(Math.abs(mv().y + 0.8) < 1e-9 && mv().x === 0, 'RIGHT zone drives surfJoyMove (push up -> y -0.8 = walk forward), radius 50 px unchanged');
ok(lk().x === 0 && lk().y === 0, 'LEFT zone (look) untouched by the right stick');
win.fire('touchend', ev(T(1, 650, 610))); ok(mv().x === 0 && mv().y === 0, 'touchend releases');
// the bug: a cancelled touch
MOVE.fire('touchstart', ev(T(2, 690, 650))); ok(mv().x > 0.7, 'second touch drives it (strafe right)');
win.fire('touchcancel', ev(T(2, 690, 650)));
ok(mv().x === 0 && mv().y === 0, 'touchcancel releases the MOVE stick (was: latched forever)');
MOVE.fire('touchstart', ev(T(3, 650, 690))); ok(mv().y > 0.7, 'after a cancelled touch a NEW touch drives the stick again (she can walk)');
win.fire('touchmove', ev(T(3, 610, 650))); ok(mv().x < -0.7 && Math.abs(mv().y) < 1e-9, 'and follows the finger');
// the LOOK stick (left) the same
LOOK.fire('touchstart', ev(T(4, 74, 610))); win.fire('touchcancel', ev(T(4, 74, 610))); LOOK.fire('touchstart', ev(T(5, 114, 650)));
ok(lk().x > 0.7, 'LEFT (look) stick: touchcancel releases too, a new touch drives it');
// a HUD change (landing / HOME / liftoff) releases both, even when no touchend / touchcancel ever arrives
ok(typeof ctx.setupSurfaceJoysticks.release === 'function', 'setupSurfaceJoysticks.release() exists');
if (ctx.setupSurfaceJoysticks.release) ctx.setupSurfaceJoysticks.release();
ok(mv().x === 0 && mv().y === 0 && lk().x === 0 && lk().y === 0 && Z['surf-look-knob'].style.left === '50%', 'release(): both sticks zeroed, knobs centred');
MOVE.fire('touchstart', ev(T(6, 650, 610))); ok(mv().y < -0.7, 'after release a new touch is accepted (no latch)');
const sm = fn('_pwSetMode'); ok(/setupSurfaceJoysticks\.release\(\)/.test(sm) && sm.indexOf('setupSurfaceJoysticks.release') < sm.indexOf('if(walk){'), '_pwSetMode releases the walk sticks on every mode change (before the walk HUD binds)');
ok(/mk\('surf-move-zone','surf-move-knob',surfLookJoy,false\)/.test(src) && /mk\('surf-look-zone','surf-look-knob',surfJoyMove,false\)/.test(src), 'stick wiring unchanged (LEFT zone = look, RIGHT zone = move)');
console.log(fails ? 'home-move-input: FAILED ' + fails + '/' + n : 'home-move-input: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
