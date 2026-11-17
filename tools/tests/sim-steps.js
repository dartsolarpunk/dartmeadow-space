// node tools/tests/sim-steps.js — (t1536b) slow frames run in real time. The flight loop used to advance every frame over 250 ms by 1/60 s, so at 3 fps she walked /
// flew at ~5 % speed ("can't move after landing" on a slow device). This drives the REAL _simSteps from index.html (how one frame's wall time becomes fixed
// simulation steps) and the REAL walk branch of _pwFrame (updateSurface called once per step, stopping if the mode changes) with a stub updateSurface that moves
// her at SURF_WALK_SPEED, and asserts: walk distance per wall-second at 3 fps / 5 fps / 10 fps / 20 fps is within 10 % of 60 fps; steps never exceed 0.1 s; a true
// stall (> 1 s gap: tab switch) still advances one 1/60 s step; _simSteps allocates nothing (writes into the same object).
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0; const j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const SIMDEF = (src.match(/const _SIM=\{n:1,h:1\/60\};/) || [''])[0]; ok(SIMDEF, '_SIM state object declared once');
const WALK_SPEED = +(src.match(/SURF_WALK_SPEED\s*=\s*([\d.]+)/) || [0, 14])[1];
// the walk branch of _pwFrame, verbatim (reps computed exactly as _pwFrame does)
const pwf = fn('_pwFrame');
const REPS = (pwf.match(/reps=\(dt>0&&dt===_SIM\.h\)\?_SIM\.n:1/) || [''])[0]; ok(REPS, '_pwFrame: reps = the frame\'s fixed steps when called from the loop, 1 for a hand-over call');
const WALK = (pwf.match(/try\{ for\(let _k=0;_k<reps&&PW\.mode==='walk';_k\+\+\)\{ surfTime\+=dt; updateSurface\(dt\); \} \}catch\(e\)\{[^}]*\}/) || [''])[0]; ok(WALK, '_pwFrame: the walk branch steps updateSurface once per fixed step');
ok(/for\(let _k=0;_k<reps&&PW\.mode==='fly';_k\+\+\) updateAtmoFlight\(dt\)/.test(pwf) && /for\(let _k=0;_k<reps&&PW\.mode==='space';_k\+\+\) _pwSpaceStep\(dt\)/.test(pwf), '_pwFrame: sky + space controllers step the same way');
ok(/const _rawDt=\(now-_flightLoopLast\)\/1000; _simSteps\(_rawDt,_SIM\); const dt=_SIM\.h;/.test(src) && !/_rawDt>0\.25\?1\/60/.test(src), 'flight loop feeds _simSteps (the old "> 250 ms = one 1/60 step" rule is gone)');
ok(/for\(let _k=0;_k<_SIM\.n;_k\+\+\)\{ updateFlight\(dt\);/.test(src), 'open-space flight steps updateFlight per fixed step');
const sb = { PW: { mode: 'walk' }, surfTime: 0, dist: 0, calls: 0, _animLoopWarn: (w, e) => { throw e; } };
sb.updateSurface = dt => { sb.dist += WALK_SPEED * dt; sb.calls++; };
const run = new Function('sb', 'with(sb){ ' + SIMDEF.replace('const _SIM', 'var _SIM') + fn('_simSteps') + '; sb._SIM=_SIM; sb._simSteps=_simSteps; sb.walk=function(dt){ const ' + REPS + '; ' + WALK + ' }; }');
run(sb);
function wallWalk(fps, secs) { sb.dist = 0; sb.calls = 0; let maxH = 0; const raw = 1 / fps; for (let t = 0; t < secs; t += raw) { sb._simSteps(raw, sb._SIM); maxH = Math.max(maxH, sb._SIM.h); sb.walk(sb._SIM.h); } return { perSec: sb.dist / secs, maxH, calls: sb.calls }; }
const ref = wallWalk(60, 10);
console.log('== walk distance per wall-second (SURF_WALK_SPEED ' + WALK_SPEED + ')');
ok(Math.abs(ref.perSec - WALK_SPEED) / WALK_SPEED < 0.02, '60 fps walks at full speed (' + ref.perSec.toFixed(2) + ' u/s)');
for (const fps of [3, 5, 10, 20, 30]) { const r = wallWalk(fps, 10); const k = r.perSec / ref.perSec; ok(Math.abs(k - 1) <= 0.10, fps + ' fps: ' + r.perSec.toFixed(2) + ' u/s = ' + (k * 100).toFixed(1) + ' % of 60 fps (old loop: ' + (100 * (1 / fps > 0.25 ? 1 / 60 : Math.min(1 / fps, 0.05)) * fps).toFixed(1) + ' %)'); ok(r.maxH <= 0.1 + 1e-9, fps + ' fps: every step <= 0.1 s (max ' + r.maxH.toFixed(3) + ')'); }
{ const o = sb._SIM; sb._simSteps(5.0, o); ok(o.n === 1 && Math.abs(o.h - 1 / 60) < 1e-9, 'a 5 s gap (tab switch) is a stall: one 1/60 s step'); sb._simSteps(NaN, o); ok(o.n === 1 && o.h > 0, 'a non-finite gap: one 1/60 s step');
  sb._simSteps(0.9, o); ok(o.n === 4 && Math.abs(o.n * o.h - 0.4) < 1e-9, 'a 0.9 s frame (just under the stall line) is capped at 0.4 s of simulation in 4 steps');
  const r = sb._simSteps(1 / 3, o); ok(r === o, '_simSteps writes into the given object (no allocation per frame)'); }
{ sb.PW.mode = 'walk'; sb.calls = 0; sb._simSteps(1 / 3, sb._SIM); sb.updateSurface = dt => { sb.calls++; sb.PW.mode = 'fly'; }; sb.walk(sb._SIM.h); ok(sb.calls === 1, 'the walk steps stop as soon as she leaves the ground (mode change mid-frame)'); }
console.log(fails ? 'sim-steps: FAILED ' + fails + '/' + n : 'sim-steps: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
