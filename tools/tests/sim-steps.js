// node tools/tests/sim-steps.js — (t1536b) slow frames run in real time, under a cost budget, without tunnelling.
// The flight loop used to advance every frame over 250 ms by 1/60 s (3 fps = 5 % speed; 5-10 fps capped at 0.05 s = 25-50 %). This drives the REAL
// _simSteps / _simRun from index.html (frame wall time -> fixed steps <= SIM_H_MAX, cost budget, stall guard) with a mocked clock, plus the real
// DMCollide sweep for the tunnelling margin, and checks the wiring (only the controller step repeats; camera / HUD / visuals run once per frame).
'use strict';
const fs = require('fs'), path = require('path'), v8 = require('v8'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else console.log('  ok   ' + m); };
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0; const j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const CONSTS = (src.match(/const SIM_H_MAX=[^;]+;/) || [''])[0], SIMDEF = (src.match(/const _SIM=\{[^}]+\};/) || [''])[0];
ok(CONSTS && SIMDEF, 'SIM_* constants + _SIM state declared');
const WALK = +(src.match(/SURF_WALK_SPEED\s*=\s*([\d.]+)/) || [0, 14])[1], RUN = +(src.match(/SURF_RUN_SPEED\s*=\s*([\d.]+)/) || [0, 30])[1];

console.log('== wiring');
const pwf = fn('_pwFrame'), us = fn('updateSurface'), uaf = fn('updateAtmoFlight'), pss = fn('_pwSpaceStep'), uf = fn('updateFlight');
ok(/const _rawDt=\(now-_flightLoopLast\)\/1000; _simSteps\(_rawDt,_SIM\); const dt=_SIM\.t;/.test(src) && !/_rawDt>0\.25\?1\/60/.test(src), 'loop: _simSteps plans the frame (old "> 250 ms = one 1/60 step" rule gone); dt = the frame\'s time');
ok(/_simRun\(updateFlight,''\)/.test(src), 'open space: updateFlight stepped by _simRun');
ok(/if\(fl\) _simRun\(_pwSpaceStep,'space'\)/.test(pwf) && /if\(fl\) _simRun\(updateAtmoFlight,'fly'\)/.test(pwf) && /if\(fl\) _simRun\(_simWalk,'walk'\)/.test(pwf), '_pwFrame: space / sky / walk controllers stepped by _simRun');
ok(/_pwCamBlend\(dt\)/.test(pwf) && /_charmTick\(dt\)/.test(pwf) && /CHAR\.mixer\.update\(dt\)/.test(pwf), '_pwFrame: camera blend, charm, mixer run once with the frame dt (not stepped, not 1/60)');
ok(/surfJumpPressed=false;[^\n]*\n  if\(_SIM\.stepping\)\{ if\(!_SIM\.last\) return; dt=_SIM\.fdt; \}/.test(us), 'updateSurface: after move + collision, board follow / camera / character sync / foot IK run on the last step only, with the frame dt');
ok(/if\(_simVis\(\) && TERRAIN\.windPoints/.test(us), 'updateSurface: wind particles once per frame');
ok(/if\(_SIM\.stepping\)\{ if\(!_SIM\.last\) return; dt=_SIM\.fdt; \}[^\n]*\n  if\(!s\.touchdown\)/.test(uaf), 'updateAtmoFlight: board pose, camera, HUD text once per frame');
ok(/if\(_simVis\(\)\)\{   \/\/ \(t1536b\) board pose \+ camera/.test(pss), '_pwSpaceStep: board pose + camera once per frame');
ok((uf.match(/if\(_simVis\(\)\)\{ updateBoardTransform\([^)]*\); updateFollowCam\(_simVdt\(dt\)\); \}/g) || []).length === 2, 'updateFlight: board transform + follow cam once per frame (both paths)');
ok(!/new |\[\]|\{\s*\w+:/.test(fn('_simRun') + fn('_simSteps')), '_simRun / _simSteps: no object / array literals or `new` (scalars only)');

// sandbox: real _simSteps / _simRun / _simWalk-like step, mocked clock and PW
const sb = { PW: { mode: 'walk', active: true }, clock: 0, cost: 0, dist: 0, steps: [], maxPer: 0 };
sb.performance = { now: () => sb.clock };
vm.createContext(sb);
vm.runInContext(CONSTS.replace(/const /, 'var ') + SIMDEF.replace('const _SIM', 'var _SIM') + fn('_simSteps') + fn('_simRun') + fn('_simVis') + fn('_simVdt') + ';', sb);
vm.runInContext('var lastCost=0; var stepFn=function(h){ dist+=SPEED*h; nStep++; if(h>maxH) maxH=h; clock+=cost+(_SIM.last?lastCost:0); };', sb);
function run(fps, secs, costMs, speed) {
  sb.SPEED = speed || WALK; sb.dist = 0; sb.nStep = 0; sb.maxH = 0; sb.cost = costMs; sb._SIM.ema = 0; sb._SIM.prevMs = 0; let maxPer = 0, frames = 0, perSum = 0;
  const raw = 1 / fps; for (let t = 0; t < secs - 1e-9; t += raw) { vm.runInContext('_simSteps(' + raw + ',_SIM); _simRun(stepFn,"walk");', sb); maxPer = Math.max(maxPer, sb._SIM.ran); perSum += sb._SIM.ran; frames++; }
  return { perSec: sb.dist / secs, maxH: sb.maxH, maxPer, avgPer: perSum / frames };
}
const ref = run(60, 10, 0);
console.log('== cheap step (0 ms): walk distance per wall-second vs 60 fps (' + ref.perSec.toFixed(2) + ' u/s)');
ok(Math.abs(ref.perSec - WALK) / WALK < 0.01, '60 fps walks at full speed');
for (const fps of [3, 5, 10, 20, 30]) { const r = run(fps, 10, 0), k = r.perSec / ref.perSec, old = 100 * (1 / fps > 0.25 ? 1 / 60 : Math.min(1 / fps, 0.05)) * fps;
  ok(Math.abs(k - 1) <= 0.10 && r.maxH <= 0.1 + 1e-9, fps + ' fps: ' + (k * 100).toFixed(1) + ' % (old ' + old.toFixed(0) + ' %), ' + r.maxPer + ' steps/frame max, max step ' + r.maxH.toFixed(3) + ' s'); }
console.log('== expensive step (mocked clock +6 ms per step)');
for (const fps of [3, 5, 10]) { const r = run(fps, 10, 6), k = r.perSec / ref.perSec;
  ok(r.maxPer <= 2 && r.maxH <= 0.1 + 1e-9, fps + ' fps @ 6 ms/step: ' + r.maxPer + ' steps/frame max (avg ' + r.avgPer.toFixed(2) + '), max step ' + r.maxH.toFixed(3) + ' s, ' + (k * 100).toFixed(1) + ' % speed (gives time up, no spiral)'); }
{ const r = run(3, 10, 1.5), k = r.perSec / ref.perSec; ok(r.maxPer <= 4 && r.maxH <= 0.1 + 1e-9, '3 fps @ 1.5 ms/step: ' + r.maxPer + ' steps/frame max, ' + (k * 100).toFixed(1) + ' % speed'); }
{ const r = run(3, 10, 2.5), k = r.perSec / ref.perSec; ok(r.maxPer <= 3, '3 fps @ 2.5 ms/step: ' + r.maxPer + ' steps/frame max (budget 4 ms), ' + (k * 100).toFixed(1) + ' % speed'); }
{ sb.lastCost = 8; const r = run(3, 10, 0.1), k = r.perSec / ref.perSec; sb.lastCost = 0; ok(r.maxPer === 4 && Math.abs(k - 1) <= 0.10, '3 fps, sim step 0.1 ms + 8 ms visuals on the last step (headless walk profile): ' + r.maxPer + ' steps/frame, ' + (k * 100).toFixed(1) + ' % speed (visual cost is once per frame, not budgeted)'); }
console.log('== stall / mode change / allocation');
{ const o = sb._SIM; vm.runInContext('_simSteps(5,_SIM)', sb); ok(o.n === 1 && Math.abs(o.t - 1 / 60) < 1e-9, 'a 5 s gap (tab switch) is a stall: one 1/60 s step');
  vm.runInContext('_simSteps(NaN,_SIM)', sb); ok(o.n === 1 && o.t > 0, 'non-finite gap: one 1/60 s step');
  vm.runInContext('_simSteps(0.9,_SIM)', sb); ok(o.n === 4 && Math.abs(o.t - 0.4) < 1e-9, '0.9 s frame: 0.4 s simulated in 4 steps');
  sb.PW.mode = 'walk'; sb.cost = 0; vm.runInContext('var nMode=0; var modeFn=function(h){ nMode++; PW.mode="fly"; }; _simSteps(1/3,_SIM); _simRun(modeFn,"walk");', sb); ok(sb.nMode === 1, 'steps stop when the mode changes mid-frame'); sb.PW.mode = 'walk';
  vm.runInContext('var vis=[]; var visFn=function(h){ vis.push(_simVis()?_simVdt(h):0); }; _simSteps(1/3,_SIM); _simRun(visFn,"walk");', sb); ok(sb.vis.length === 4 && sb.vis.slice(0, 3).every(x => x === 0) && Math.abs(sb.vis[3] - 1 / 3) < 1e-9, 'visual work: last step only, with the frame dt (' + sb.vis.map(x => x.toFixed(3)).join(',') + ')'); }
{ v8.setFlagsFromString('--expose-gc'); const gc = vm.runInNewContext('gc');
  vm.runInContext('var noop=function(h){ clock+=0.3; };', sb); const loop = vm.runInContext('(function(N){ for(var i=0;i<N;i++){ _simSteps(i%3?1/3:1/12,_SIM); _simRun(noop,"walk"); } })', sb);
  loop(20000); gc(); const h0 = process.memoryUsage().heapUsed; loop(200000); gc(); const dh = process.memoryUsage().heapUsed - h0;
  ok(dh < 64 * 1024, '200k frames of _simSteps + _simRun: heap delta ' + (dh / 1024).toFixed(1) + ' KB (no per-frame allocation)'); }

console.log('== tunnelling (real DMCollide sweep, thinnest box 0.11 m, her capsule r 0.7, run ' + RUN + ' u/s)');
{ globalThis.window = undefined; require('../../ui/dm-collide.js'); const L = globalThis.DMCollideLib;
  for (const [fps, cost] of [[10, 0], [20, 0], [3, 0], [3, 6], [2.5, 0]]) {
    const W = L.create(); W.addBox('wall', 10, 2, 0, 0.055, 3, 400, 0, 'stone');   // 0.11 thick: x = 9.945..10.055
    const c = W.makeChar({ x: 0, y: 0, z: 0, r: 0.7, h: 3.1, step: 0.6, snap: 0.5 }); let crossed = false, maxX = -1e9;
    vm.runInContext('var wallStep=null;', sb); sb.wallStep = h => { W._dt = h; W.walk(c, RUN * h, 0); if (c.x > 9.945) crossed = true; maxX = Math.max(maxX, c.x); sb.clock += cost; };
    sb._SIM.ema = 0; sb._SIM.prevMs = 0;
    for (let i = 0; i < Math.ceil(4 * fps); i++) vm.runInContext('_simSteps(' + (1 / fps) + ',_SIM); _simRun(wallStep,"walk");', sb);
    ok(!crossed && maxX <= 9.945 - 0.7 + 0.01, fps + ' fps' + (cost ? ' @ ' + cost + ' ms/step' : '') + ': run into a 0.11 m wall, no pass-through (stops at x ' + maxX.toFixed(3) + ', face - r = 9.245)'); }
  const subMax = Math.max(0.12, Math.min(0.45, 0.7 * 0.5)); console.log('     margin: per-step move ' + (RUN * 0.1).toFixed(1) + ' u at 0.1 s -> sweep sub-step ' + subMax + ' m vs r + half-thickness 0.755 m (2.2x); vertical: prop tops stood on from last step\'s feet'); }
console.log(fails ? 'sim-steps: FAILED ' + fails + '/' + n : 'sim-steps: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
