// ui/dm-pw-handoff.js (v299, Worlds Wave 2b): the space -> surface hand-off.  Pre-build hidden from PWS_OPEN (9 R), visible at the DMAtmoShell
// perimeter (Solenne 1.18 R, Mars 1.06 R), hidden just outside it, hysteresis on the way out, the minimap globe on the same gate.
const assert = require('assert'), path = require('path');
const H = require('../../ui/dm-pw-handoff.js');
const R = 360 / 0.008 / (2 * Math.PI);   // _planetR() with ATMO_DEG_PER_UNIT 0.008
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const near = (a, b, e) => Math.abs(a - b) < (e || 1e-9);
// Solenne via the real DMAtmoShell glue (mesh userData 1.18 R)
globalThis.window = globalThis; globalThis._ATMO_LOOK = { earth: { mul: 1.18 }, mars: { mul: 1.06 }, other: { mul: 1.10 }, titan: { mul: 1.22 } };
require('../../ui/dm-atmo-shell.js');
const A = globalThis.DMAtmoShell, P = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); } });
const solenne = { type: 'Habitable', mesh: { position: P(0, 0, 0), traverse(f) { f({ userData: { jotsAtmo: true, planetR: 500, atmoTop: 90 } }); } } };
const mars = { name: 'Mars', mesh: { position: P(0, 0, 0), traverse() { } } };
const titan = { name: 'Titan', mesh: { position: P(0, 0, 0), traverse() { } } };
const airless = { type: 'Moon', hasAtmosphere: false, mesh: { position: P(0, 0, 0), traverse() { } } };
const sS = A.radii(solenne), sM = A.radii(mars), sT = A.radii(titan), sA = A.radii(airless);
ok(near(sS, 1.18) && near(sM, 1.06) && near(sT, 1.22) && sA === 1, 'shells from DMAtmoShell');

function run(shell, path) { const st = H.make(); const out = []; for (const dr of path) { H.step(st, dr, shell, R); out.push({ dr, v: st.visible, r: st.reveal, pre: st.prebuild, close: st.close, down: st.downAlt, showR: st.showR, downR: st.downR, hideR: st.hideR }); } return out; }
for (const [name, shell] of [['Solenne', sS], ['Mars', sM], ['Titan', sT]]) {
  const t = H.thresholds(shell, R, {});
  ok(near(t.showR, shell), name + ': visible switch at the shell itself (' + shell + ' R), not 9 R');
  ok(t.downR < t.showR && t.downR > 1, name + ': dissolve completes inside the shell');
  ok(t.downAlt <= 2600 && t.downAlt >= 300 - 1e-9, name + ': frame hand-off height inside [floor, PWS_DOWN]');
  ok(t.hideR > t.showR && t.hideR < 2, name + ': hysteresis just outside the shell, far inside 9 R');
  const st = H.make();
  H.step(st, 9.5, shell, R); ok(!st.prebuild && !st.visible && st.reveal === 0, name + ' 9.5 R: nothing');
  H.step(st, 8.99, shell, R); ok(st.prebuild && !st.visible && st.reveal === 0, name + ' 9 R: pre-build, hidden');
  H.step(st, 3.5, shell, R); ok(st.prebuild && !st.visible && st.reveal === 0, name + ' 3.5 R (old globe range): hidden');
  H.step(st, shell * 1.01, shell, R); ok(!st.visible && st.reveal === 0, name + ' just outside the shell: hidden');
  H.step(st, shell + 1e-6, shell, R); ok(!st.visible && st.reveal === 0, name + ' a hair outside: hidden');
  H.step(st, shell, shell, R); ok(st.visible, name + ' at the shell: visible (globe on, dissolve starts)');
  H.step(st, (shell + t.downR) / 2, shell, R); ok(st.visible && st.reveal > 0 && st.reveal < 1, name + ' mid-dissolve');
  H.step(st, t.downR, shell, R); ok(st.visible && near(st.reveal, 1), name + ' dissolve complete at the frame hand-off');
  // way out: latched visible until hideR, then hidden; the world (prebuild) stays until 11 R; never back on at 9-11 R
  H.step(st, (shell + t.hideR) / 2, shell, R); ok(st.visible && st.reveal === 0, name + ' out, inside hysteresis: globe stays, world dissolved');
  H.step(st, t.hideR + 1e-6, shell, R); ok(!st.visible, name + ' out past hysteresis: hidden');
  H.step(st, (shell + t.hideR) / 2, shell, R); ok(!st.visible, name + ' back in inside the band: still hidden until the shell (no flicker)');
  for (const dr of [9, 9.5, 10, 10.9]) { H.step(st, dr, shell, R); ok(!st.visible && st.reveal === 0 && !st.close, name + ' ' + dr + ' R out: hidden, not closed'); }
  H.step(st, 11.01, shell, R); ok(st.close && !st.visible, name + ' 11 R: close');
}
// Solenne numbers (frame hand-off ~0.108 R ~ 773 units; was PWS_DOWN 2600 = 1.363 R, outside the 1.18 R shell)
const tS = H.thresholds(sS, R, {}); ok(near(tS.downR, 1.108, 1e-6) && near(tS.hideR, 1.225, 1e-6), 'Solenne down 1.108 R, hide 1.225 R');
ok(1 + 2600 / R > sS, 'old PWS_DOWN hand-off sat outside the Solenne shell (why the frame hand-off moves in)');
// Mars: floor binds (300 units), still inside its 1.06 shell
const tM = H.thresholds(sM, R, {}); ok(near(tM.downR, 1 + 300 / R) && tM.downR < 1.06, 'Mars: floor-bound frame hand-off inside the shell');
// airless: no shell -> visible just above the floor, band > 0
const tA = H.thresholds(sA, R, {}); ok(tA.showR > tA.downR && near(tA.showR, 1 + 300 / R + 0.01), 'airless: shows just above the floor');
// monotone reveal on the way in
{ const st = H.make(); let prev = 0; for (let dr = 1.3; dr >= tS.downR; dr -= 0.001) { H.step(st, dr, sS, R); ok(st.reveal >= prev - 1e-12, 'monotone'); prev = st.reveal; } }
// no allocation: step returns the same object and adds no keys
{ const st = H.make(), keys = Object.keys(st).length; ok(H.step(st, 1.1, sS, R) === st && Object.keys(st).length === keys, 'in-place state'); }
// globe gate: mirrors index.html _pwGlobeNear (space mode, the hand-off body)
const globe = (st, b, PW) => { if (PW.opening) return null; if (!PW.active || PW.body !== b) return b; return (PW.mode !== 'space' || st.visible) ? b : null; };
{ const st = H.make(), PW = { active: true, mode: 'space', body: solenne };
  H.step(st, 3.4, sS, R); ok(globe(st, solenne, PW) === null, 'globe hidden at the old 3.5 R approach range');
  H.step(st, 1.19, sS, R); ok(globe(st, solenne, PW) === null, 'globe hidden just outside the shell');
  H.step(st, 1.18, sS, R); ok(globe(st, solenne, PW) === solenne, 'globe on at the shell');
  H.step(st, 1.2, sS, R); ok(globe(st, solenne, PW) === solenne, 'globe stays inside hysteresis');
  H.step(st, 1.3, sS, R); ok(globe(st, solenne, PW) === null, 'globe off past hysteresis');
  ok(globe(st, solenne, { opening: true }) === null, 'globe hidden while the world builds');
  ok(globe(st, mars, PW) === mars, 'other body (no hand-off running for it): as before');
  ok(globe(st, solenne, { active: true, mode: 'fly', body: solenne }) === solenne, 'in the sky: atmo globe unaffected'); }
console.log('pw-handoff OK (' + n + ' checks; Solenne show ' + tS.showR.toFixed(3) + ' R, dissolve done ' + tS.downR.toFixed(3) + ' R (' + Math.round(tS.downAlt) + ' u), hide ' + tS.hideR.toFixed(3) + ' R; Mars show ' + tM.showR.toFixed(3) + ' R; pre-build 9 R, close 11 R)');
