// ui/dm-pw-handoff.js (v299, Worlds Wave 2b): the space -> surface hand-off.  Pre-build hidden from PWS_OPEN (9 R), visible at the DMAtmoShell
// perimeter (Solenne 1.18 R, Mars 1.06 R), hidden just outside it, hysteresis on the way out, the minimap globe on the same gate.
const assert = require('assert'), path = require('path');
const H = require('../../ui/dm-pw-handoff.js');
const R = 360 / 0.008 / (2 * Math.PI);   // _planetR() with ATMO_DEG_PER_UNIT 0.008
let n = 0, nf = 0; const ok = (c, m) => { if (process.env.PW_SOFT && !c) { nf++; console.log('FAIL: ' + m); return; } assert(c, m); n++; };   // PW_SOFT=1: list every failure
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
// sky→space switch (upAlt) and a fly-out through it: reveal must change smoothly, no snap
ok(tS.upAlt > tS.downAlt && tS.upAlt < tS.showAlt && tS.upAlt <= 2750, 'Solenne: sky→space switch just above the frame hand-off, inside the shell');
ok(near(tS.upAlt, tS.downAlt + (2750 - 2600)), 'Solenne: upAlt = downAlt + (PWS_UP - PWS_DOWN)');
ok(tM.upAlt > tM.downAlt && tM.upAlt < tM.showAlt, 'Mars: sky→space switch stays inside the shell (fade band narrower than PWS_UP-PWS_DOWN)');
ok(tA.upAlt > tA.downAlt && tA.upAlt < tA.showAlt, 'airless: sky→space switch stays inside the dissolve band');
{ const st = H.make(); const upR = 1 + tS.upAlt / R;
  H.step(st, tS.downR, sS, R); ok(near(st.reveal, 1), 'at downR (fly-in switch): reveal is 1');
  let prev = st.reveal, mid = 0, maxStep = 0;
  for (let dr = tS.downR; dr <= tS.showR + 1e-9; dr += 0.0005) {
    H.step(st, dr, sS, R);
    const d = prev - st.reveal;
    if (d > maxStep) maxStep = d;
    ok(st.reveal <= prev + 1e-12, 'fly-out reveal never jumps up at ' + dr.toFixed(4) + ' R');
    ok(d < 0.02, 'fly-out reveal has no snap at ' + dr.toFixed(4) + ' R (step ' + d.toFixed(4) + ')');
    if (st.reveal > 0 && st.reveal < 1) mid++;
    prev = st.reveal;
  }
  ok(mid > 10, 'fly-out fade plays through mid values (' + mid + ' samples)');
  H.step(st, upR, sS, R); ok(st.reveal > 0 && st.reveal < 1, 'at the sky→space switch, fade is in progress (not already 0)');
  H.step(st, tS.showR, sS, R); ok(near(st.reveal, 0), 'at the shell, dissolve is done'); }
// ── The real index.html sky tick and first space frame, run in a node vm (no copy of the rule in this file) ──
// INDEX_HTML can point the harness at another index.html (used to prove the checks fail on 21b45591 / b89a9fd).
const fs = require('fs'), vm = require('vm');
const IDX = fs.readFileSync(process.env.INDEX_HTML || path.join(__dirname, '../../index.html'), 'utf8');
const UI = (f) => fs.readFileSync(path.join(__dirname, '../../ui', f), 'utf8');
function fnSrc(src, name) {   // the whole `function name(...){...}` from index.html, by brace matching
  const i = src.indexOf('function ' + name + '('); assert(i >= 0, 'index: function ' + name + ' not found');
  let j = src.indexOf('{', i), d = 0;
  for (let k = j; k < src.length; k++) { const c = src[k]; if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
function lineSrc(src, re) { const m = src.match(re); assert(m, 'index: ' + re + ' not found'); return m[0]; }
function between(s, a, b) { const i = s.indexOf(a), j = s.indexOf(b, i + 1); assert(i >= 0 && j > i, 'index: slice ' + JSON.stringify(a) + ' .. ' + JSON.stringify(b)); return s.slice(i, j); }
const ATMO_SRC = fnSrc(IDX, 'updateAtmoFlight'), SPACE_SRC = fnSrc(IDX, '_pwSpaceStep');
// sky: from the terrain floor (landing settle, floor clamp, touchdown, board scale, the hand-off and the sky→space switch) to the world's edge
const SKY_TAIL = between(ATMO_SRC, 'const groundH=', "// the world's edge");
// space: section 3 to the end (lat/lon/alt of the board, the hand-off, reveal, the flight sphere, close / space→sky)
const SPACE_TAIL = SPACE_SRC.slice(SPACE_SRC.indexOf("// 3. into the world's frame"), SPACE_SRC.lastIndexOf('}'));
ok(/_pwHandoff\(/.test(SKY_TAIL) && /_pwFlyToSpace\(\)/.test(SKY_TAIL), 'index: sky slice carries the hand-off and the sky→space switch');
ok(/_pwfReveal\(ho\.reveal\)/.test(SPACE_TAIL) && SPACE_SRC.indexOf("// 3. into the world's frame") > 0, 'index: space slice carries the first-frame reveal');
const VM_SRC = [
  lineSrc(IDX, /const PLANET_VIS_SCALE\s*=\s*[^;]*;/), lineSrc(IDX, /const ATMO_BOARD_SCALE=[^;]*;/), lineSrc(IDX, /const PWS_OPEN=[^;]*;/),
  lineSrc(IDX, /const ATMO_DEG_PER_UNIT=[^;]*;/), lineSrc(IDX, /const _smooth01=v=>\{[^\n]*?\};/), lineSrc(IDX, /const _PWS=\{[^\n]*?\};/),
  fnSrc(IDX, '_pwsReady'), fnSrc(IDX, '_planetR'), fnSrc(IDX, '_bodyR'), fnSrc(IDX, '_pwfReveal'),
  lineSrc(IDX, /const _pwHO=\{[^\n]*?\};/), fnSrc(IDX, '_pwHandoff'), fnSrc(IDX, '_pwsLatLonAlt'),
  'function __sky(s,dt){ const landing=!!s.landing;\n' + SKY_TAIL + '\n}',
  'function __space(b,S,sp,sc){ let la;\n' + SPACE_TAIL + '\n}',
  'this.__sky=__sky; this.__space=__space; this.__R=_planetR(); this.__bodyR=_bodyR;',
].join('\n');
class V3 { constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } clone() { return new V3(this.x, this.y, this.z); }
  sub(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; } add(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; }
  applyQuaternion() { return this; } length() { return Math.hypot(this.x, this.y, this.z); } distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
  setScalar(v) { return this.set(v, v, v); } }
class Q4 { invert() { return this; } }
function bodyOf(kind) {   // fresh body objects per run (DMAtmoShell caches on the body)
  const mesh = { position: new V3(), visible: false, updateMatrixWorld() { }, getWorldPosition(v) { return v.copy(this.position); }, getWorldQuaternion(q) { return q; }, traverse() { } };
  if (kind === 'Solenne') { mesh.traverse = (f) => f({ userData: { jotsAtmo: true, planetR: 500, atmoTop: 90 } }); return { type: 'Habitable', name: 'Solenne', collisionRadius: 6, mesh }; }
  if (kind === 'Mars') return { name: 'Mars', collisionRadius: 3.4, mesh };
  if (kind === 'Titan') return { name: 'Titan', collisionRadius: 2.6, mesh };
  return { type: 'Moon', name: 'airless', hasAtmosphere: false, collisionRadius: 1.7, mesh };
}
function world(kind) {
  const b = bodyOf(kind), C = { Math, console, THREE: { Vector3: V3, Quaternion: Q4 }, _ATMO_LOOK: globalThis._ATMO_LOOK,
    PW: { body: b, board: { scale: new V3() } }, PWF: { reveal: 1, u: null }, atmoMach: 0, atmoBoard: { scale: new V3(1, 1, 1) },
    flightCamera: { position: new V3() }, FLIGHT_BOARD_WORLD_SCALE: 1, _atmoHeight: () => 0, _landSteer() { }, _atmoTouchdown() { },
    setTimeout() { }, _atmoXZ: () => ({ x: 0, z: 0 }), flyOuts: 0, toFly: 0, closes: 0 };
  C.window = C; C.globalThis = C;
  C._pwFlyToSpace = () => { C.flyOuts++; }; C._pwSpaceToFly = () => { C.toFly++; }; C._pwSpaceClose = () => { C.closes++; };
  vm.createContext(C);
  vm.runInContext(UI('dm-atmo-shell.js'), C); vm.runInContext(UI('dm-pw-handoff.js'), C); vm.runInContext(VM_SRC, C);
  C.H = C.DMPwHandoff.thresholds(C.DMAtmoShell.radii(b, 1), C.__R, {});
  // fly-in state: the sky took over at downAlt with reveal 1 and the flight sphere hidden (_pwSpaceToFly)
  C.flyIn = () => { C.PWF.reveal = 1; b.mesh.visible = false; };
  C.s = (y) => ({ pos: new V3(0, y, 0), vel: new V3(), landing: false, touchdown: false });
  C.sky = (s) => { C.__sky(s, 1 / 60); return { reveal: C.PWF.reveal, sphere: b.mesh.visible }; };
  // first space frame at the same height: the board at |p| = bodyR * (1 + alt/R) from the body centre (the space frame's own units)
  C.space = (y) => { const sp = { pos: new V3(C.__bodyR(b) * (1 + y / C.__R), 0, 0) }, S = { flat: new V3(), out: false };
    C.__space(b, S, sp, { t: 1, f: 1, fc: 1 }); return { reveal: C.PWF.reveal, sphere: b.mesh.visible }; };
  C.b = b; return C;
}
// 1. fly-out: walk the real sky tick up through downAlt to the switch, then the real first space frame (jump <= 0.02)
for (const name of ['Solenne', 'Mars', 'Titan']) {
  { const W = world(name), sp = W.space(W.H.upAlt + 1e-6), snapped = Math.abs(1 - sp.reveal);   // a held-at-1 sky (the 21b45591 bug) would snap
    ok(snapped > 0.02, name + ': a sky that left reveal at 1 would jump ' + snapped.toFixed(3) + ' on the first space frame (the case this test is for)'); }
  const W = world(name), t = W.H; W.flyIn();
  const s = W.s(t.downAlt - 20); let prev = W.sky(s), sawSwitch = false, maxSky = 0;
  ok(prev.reveal === 1 && !prev.sphere, name + ' below downAlt (real sky tick): reveal 1, flight sphere hidden');
  for (let y = t.downAlt - 19; y <= t.upAlt + 20; y += 1) {
    s.pos.y = y; const sky = W.sky(s), d = Math.abs(sky.reveal - prev.reveal); if (d > maxSky) maxSky = d;
    ok(d <= 0.02, name + ' real sky tick has no snap at ' + Math.round(y) + ' u (' + prev.reveal.toFixed(3) + ' -> ' + sky.reveal.toFixed(3) + ')');
    if (W.flyOuts) {
      const space = W.space(s.pos.y), jump = Math.abs(space.reveal - sky.reveal);
      ok(jump <= 0.02, name + ' real last sky frame -> real first space frame: ' + sky.reveal.toFixed(3) + ' -> ' + space.reveal.toFixed(3) + ' (jump ' + jump.toFixed(3) + ', max 0.02) at ' + Math.round(y) + ' u');
      ok(sky.sphere && space.sphere, name + ' flight sphere already on in the last sky frame and stays on (sky ' + sky.sphere + ', space ' + space.sphere + ')');
      ok(W.toFly === 0 && W.closes === 0, name + ' first space frame neither drops back to the sky nor closes');
      sawSwitch = true; break;
    }
    prev = sky;
  }
  ok(sawSwitch, name + ' real sky tick reached the sky→space switch');
}
// 2. LAND while climbing out: climb past downAlt, LAND mid-band, the real landing settle carries her down: reveal back to 1, sphere off, at and below downAlt
for (const name of ['Solenne', 'Mars', 'Titan', 'airless']) {
  const W = world(name), t = W.H; W.flyIn();
  const s = W.s(t.downAlt - 10);
  for (let y = t.downAlt - 10; y <= (t.downAlt + t.upAlt) / 2; y += 1) { s.pos.y = y; W.sky(s); }
  const mid = { reveal: W.PWF.reveal, sphere: W.b.mesh.visible };
  ok(mid.reveal < 0.999 && mid.sphere && W.flyOuts === 0, name + ' mid-band climb: fading (' + mid.reveal.toFixed(3) + '), sphere on, still in the sky');
  s.landing = true;
  let bad = 0, firstBad = '', ticks = 0;
  for (; ticks < 4000 && s.pos.y > 4.001; ticks++) {
    const r = W.sky(s);
    if (s.pos.y <= t.downAlt && (r.reveal !== 1 || r.sphere)) { if (!bad) firstBad = 'y ' + s.pos.y.toFixed(1) + ' reveal ' + r.reveal.toFixed(3) + ' sphere ' + r.sphere; bad++; }
  }
  const end = { reveal: W.PWF.reveal, sphere: W.b.mesh.visible };
  ok(s.pos.y <= 4.01, name + ' landing settle reached hover height (y ' + s.pos.y.toFixed(2) + ' after ' + ticks + ' ticks)');
  ok(bad === 0, name + ' LAND mid-climb: reveal 1 and sphere hidden at every tick at or below downAlt' + (bad ? ' (' + bad + ' bad, first ' + firstBad + ')' : ''));
  ok(end.reveal === 1 && !end.sphere, name + ' LAND mid-climb: touches down with reveal ' + end.reveal.toFixed(3) + ', sphere ' + (end.sphere ? 'on' : 'off'));
  ok(W.flyOuts === 0, name + ' LAND mid-climb never switches to space');
  // LAND just above upAlt: the switch stays guarded (she settles instead of flying out)
  const W2 = world(name); W2.flyIn(); const s2 = W2.s(W2.H.upAlt + 5); s2.landing = true; W2.sky(s2);
  ok(W2.flyOuts === 0, name + ' landing above upAlt: no sky→space switch');
}
// index.html wiring: updateAtmoFlight drives reveal + the flight sphere outside the landing guard; only the sky→space switch is guarded
{ const idx = IDX, atmo = ATMO_SRC;
  ok(atmo.indexOf('function updateAtmoFlight') === 0 && atmo.length > 100, 'index: found updateAtmoFlight');
  ok(/s\.pos\.y>ho\.downAlt\)\{\s*_pwfReveal\(ho\.reveal\)/.test(atmo), 'index: updateAtmoFlight drives _pwfReveal from the hand-off past downAlt');
  ok(/b\.mesh\.visible=PWF\.reveal<0\.999/.test(atmo), 'index: updateAtmoFlight shows the flight sphere once reveal drops below 0.999');
  ok(/if\(!landing&&s\.pos\.y>ho\.upAlt\)\{\s*_pwFlyToSpace\(\)/.test(atmo), 'index: sky→space switch is at the hand-off upAlt and is the only landing-guarded step');
  const ho = SKY_TAIL.slice(SKY_TAIL.indexOf('// over the top of the air'));
  ok(!/if\(!landing\)\s*\{/.test(ho), 'index: no if(!landing){ block wraps the hand-off reveal / sphere writes');
  ok(!/^\s*if\(!landing\s*&&\s*s\.pos\.y>PWS_UP\)/m.test(idx) && /\}else if\(!landing&&s\.pos\.y>PWS_UP\)\{\s*_pwFlyToSpace\(\)/.test(atmo), 'index: the bare PWS_UP switch is only the module-missing fallback');
  ok(!/<script src="ui\/dm-pw-handoff\.js\?v=\d+"><\/script>[^\n]*v297/.test(idx), 'index: dm-pw-handoff script tag does not carry the leftover dm-atmo-shell comment');
  ok(/<script src="ui\/dm-atmo-shell\.js\?v=297"><\/script>[^\n]*DMAtmoShell/.test(idx), 'index: dm-atmo-shell comment lives on its own tag'); }
if (nf) { console.log('pw-handoff FAILED (' + nf + ' failing, ' + n + ' passing)'); process.exit(1); }
console.log('pw-handoff OK (' + n + ' checks; Solenne show ' + tS.showR.toFixed(3) + ' R, dissolve done ' + tS.downR.toFixed(3) + ' R (' + Math.round(tS.downAlt) + ' u), hide ' + tS.hideR.toFixed(3) + ' R, up ' + Math.round(tS.upAlt) + ' u; Mars show ' + tM.showR.toFixed(3) + ' R; pre-build 9 R, close 11 R)');
