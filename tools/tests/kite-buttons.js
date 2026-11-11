// node tools/tests/kite-buttons.js — t1472 "park / summon buttons gone in every mode + no auto-summon (fall catch)".
// ROOT CAUSE (2610063, Nov 5): the big classic <script> (parsed BEFORE the three.js module has run, window.THREE does not exist yet) had a top-level
// `const _surfGN=new THREE.Vector3()`. That threw a ReferenceError at parse time and ABORTED the rest of the script: _installKiteBoardButtons never ran
// (no PARK / SUMMON / step-off), and every const after it (BC_COL, _KB_*, ...) stayed in its TDZ. Rule enforced here: nothing at the top level of that
// script may touch THREE; scratch objects are made lazily inside functions.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
console.log('== no THREE use while the classic script is being parsed');
const a = html.indexOf('<script>\n\'use strict\';\n// ══════'), b = html.indexOf('</script>', a), src = html.slice(a, b);
ok(a > 0 && b > a, 'main classic script found');
// top-level statement = a line starting in column 0 (the script is indented inside functions / blocks); allow function bodies on one line
const bad = src.split('\n').map((l, i) => [i, l]).filter(([, l]) => /^(const|let|var)\s[^=]*=\s*(new\s+)?THREE\./.test(l) || /^THREE\./.test(l) || /^(const|let|var)\s+\w+\s*=\s*new\s+THREE\./.test(l));
ok(!bad.length, 'no top-level `const x = new THREE.*` in the parse-time script (' + bad.map(([i, l]) => l.slice(0, 60)).join(' | ') + ')');
ok(/let _surfGN=null, _surfCN=null;/.test(src) && /_surfGN\|\|\(_surfGN=new THREE\.Vector3\(\)\)/.test(src) && /_surfCN\|\|\(_surfCN=new THREE\.Vector3\(\)\)/.test(src), 'walk scratch normals are lazy');
console.log('== the buttons are wired');
ok(/document\.addEventListener\('DOMContentLoaded',_installKiteBoardButtons\); else _installKiteBoardButtons\(\)/.test(src), 'installer runs at load');
ok(/mk\(document\.querySelector\('#surface-overlay \.mini-kite'\),pc,wirePC,false\)/.test(src) && /mk\(document\.querySelector\('#screen-flight \.hud-c'\),pc,wirePC,true\)/.test(src) && /kb-step/.test(src), 'walk + ship-deck park/summon and the sky step-off are installed');
console.log('== fall catch (auto-summon) against the real function');
{ const s = src.indexOf('const SURF_CATCH_DROP='), e = src.indexOf('\n}\n', src.indexOf('function _surfFallCatch(')) + 3;
  const mkV = () => ({ x: 0, y: 0, z: 0, clone() { return Object.assign(mkV(), this); }, sub(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; }, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; } });
  const board = { position: mkV(), rotation: { x: 0, z: 0, order: '' } }; let flew = 0, toasts = 0;
  const ctx = { CHAR_TERRAIN_HEIGHT: 3.26, surfBoard: board, CHAR: { _transitioning: false, loaded: false }, THREE: { Vector3: function (x, y, z) { return Object.assign(mkV(), { x, y, z }); } }, toast() { toasts++; }, surfaceActive: true, PW: { active: true, camera: { position: mkV() } }, _pwBeginFly() { flew++; }, atmoState: null, _bmsOnce: f => f, boardMountSequence() { }, setTimeout: f => f(), window: {} };
  vm.createContext(ctx); vm.runInContext(src.slice(s, e), ctx);
  const p = { pos: mkV().set(0, 40, 0), vel: mkV().set(0, 0, 0), onGround: true, yaw: 0, _floating: false }; board.position.set(2, 30, 0);
  ctx.p = p; const step = (g, dt) => { p.vel.y -= 9.8 * dt * 3; p.pos.y += p.vel.y * dt; ctx.dt = dt; vm.runInContext('_surfFallCatch(p,dt,' + g + ')', ctx); };
  step(37, 0.016);    // standing on a ledge at ground 37
  p.onGround = false; let caught = false, t = 0;
  while (t < 6 && !flew) { p.onGround = p.pos.y <= 3; step(0, 0.016); t += 0.016; if (p._catch) caught = true; }   // ground 100 u below: she runs off the ledge and falls
  ok(caught, 'a long fall starts the catch (the skyboard swoops in)'); ok(toasts >= 1, '"Skyboard catch!" toast');
  ok(flew === 1, 'the catch ends in the ride/flight hand-off once, at ' + t.toFixed(2) + ' s');
  ok(Math.abs(board.position.y - (p.pos.y - 3.0)) < 3.5, 'the board ends up under her feet'); }
console.log(fails ? 'kite-buttons: FAILED ' + fails + '/' + n : 'kite-buttons: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
