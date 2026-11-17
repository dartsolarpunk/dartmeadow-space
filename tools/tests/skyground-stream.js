// node tools/tests/skyground-stream.js — (v330 streaming) after landing every nearby ground tile reaches full detail within a bounded number of frames,
// and nothing stalls.  Runs the REAL SkyGround (index.html, the same slices as fov-fill.js / skyground-budget.js) on Solenne's real height field from
// a coastal cliff (the HOME deck's height class), under a fake clock in which each tile build costs a set number of ms:
//  (1) pure gates: _skyIdleRoom (an idle build only starts when it fits the idle period), _skySliceOk (the no-requestIdleCallback timer slice only
//      with frame headroom), _mcUpHealthy / _mcUpDelay (the walk patch's detail ladder: med <= 50 ms, high <= 36 ms, backs off, never gives up)
//  (2) NO idle time (a frame-bound device / Safari near its 30 fps line): exactly the in-frame budget, as before; still drains (never stalls)
//  (3) idle time after each frame (requestIdleCallback): nearby tiles reach full detail in far fewer frames; every idle build started with room
//      for it; the frame's own build work is unchanged (no build past the frame budget but the one emergency)
//  (4) Safari timer slice: with headroom it fills faster; near the 30 fps line (EMA > 0.8 x budget) it never runs; a slice never starts a build past it
//  (5) the arrival quiet window, a hidden tab and a disposed ground never build; after the quiet window the fill resumes (no starvation)
//  (6) the final quadtree is the same as without idle fill; the ground under her is never bare after the first frame
//  (7) source: no per-frame allocation / closure in update / _idleKick / _idleRun / _sliceRun; the MC ladder has no 20-try cap; sw v330; ATMO 46
// MEASURE=1 prints frame counts only (also works on an older index.html via HTML=path: the before/after numbers in the PR come from that).
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(process.env.HTML || path.join(root, 'index.html'), 'utf8');
const TL = require(path.join(root, 'ui', 'dm-terrain-lod.js'));
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } else if (process.env.VERBOSE) console.log('  ok', m); };
const cut = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('marker not found: ' + a); const j = html.indexOf(b, i + a.length); if (j < 0) throw new Error('marker not found: ' + b); return html.slice(i, j); };
const has = s => html.indexOf(s) >= 0;
const srcNoise = cut('function _vnoise(x,y,seed){', '// Texel generation is pure arithmetic');
const srcD = cut('const ATMO_DEG_PER_UNIT=0.008;', '// One map per planet') + cut('function _siteWorldXZ(site){', 'const LAND_PICK_RANGE');
const srcCore = cut('function _terrainCore(x,z,seed,_ws){', '// ── Shoreline water');
const srcField = cut('function _groundField(body,site,pal){', '// ── The planet\'s ground, level of detail, pole to pole');
const srcPWF = cut('const PWF={u:null', 'function _pwfReady()') + cut('function _pwfMap(x,y,z,out){', '// the planet\'s centre in the drawn frame') + cut('function _pwfCentre(out){', '\n') + '\n';
const srcSky = cut('function SkyGround(scene,F,pal,o){', 'SkyGround.prototype.dispose=') + cut('SkyGround.prototype.dispose=', '\n') + '\n';
const srcMc = has('function _mcUpHealthy(') ? cut('function _mcUpHealthy(', '\n') + '\n' + cut('function _mcUpDelay(', '\n') + '\n' : '';
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } clone() { return new V3(this.x, this.y, this.z); }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; } add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; } dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  length() { return Math.hypot(this.x, this.y, this.z); } distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); } }
class Col { constructor() { this.r = 0; this.g = 0; this.b = 0; } copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; } clone() { return new Col().copy(this); } lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; } multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; } }
class Attr { constructor(a, s) { this.array = a; this.itemSize = s; this.needsUpdate = false; } }
class Geo { constructor() { this.attributes = {}; this.index = null; } setAttribute(k, a) { this.attributes[k] = a; } setIndex(a) { this.index = a; } computeBoundingSphere() { } dispose() { } }
class Mesh { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V3(); this.visible = true; this.userData = {}; } }
class Grp { constructor() { this.children = []; this.parent = null; this.name = ''; } add(o) { this.children.push(o); o.parent = this; } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; } }
const THREE = { Vector3: V3, Color: Col, BufferAttribute: Attr, Uint16BufferAttribute: Attr, BufferGeometry: Geo, Mesh, Group: Grp, Frustum: class { }, Matrix4: class { }, Sphere: class { constructor() { this.center = new V3(); this.radius = 0; } } };
const clock = { t: 0 }, performance = { now: () => clock.t };
const W = { document: { hidden: false } };   // the page: requestIdleCallback / setTimeout / DMBudget / _dmQuiet are set per run
const E = new Function('THREE', 'window', 'DMTerrainLod', 'performance', `
  const GFX = { isMobile: true, shadows: false };
  ${srcNoise}
  ${srcD}
  ${srcPWF}
  let PW = { site: null };
  const TERRAIN = { style: 'lush' }, _worldSeed = () => 311;
  const _terrainDetailMat = () => ({}); const _sbcIsEarth = () => false;
  const _sbcC = new THREE.Color();
  let surfaceBiomeColor = (x, z, h, slope, pal, seed, opts) => { _sbcC.r = h; _sbcC.g = slope; _sbcC.b = opts.siteLat; return _sbcC; };
  function _smooth01(t){ t=Math.max(0,Math.min(1,t)); return t*t*(3-2*t); }
  ${srcCore}
  ${srcField}
  ${srcSky}
  ${srcMc}
  function pwfOn(fx,fz,alt,s){ const lat=Math.max(-89.9,Math.min(89.9,s.lat-fz*ATMO_DEG_PER_UNIT))*Math.PI/180, w=1-_smooth01((alt-1500)/4500), gMax=Math.min(1/Math.max(1e-3,Math.cos(lat)),5.8);
    PWF.fx=fx; PWF.fz=fz; PWF.lat=lat; PWF.sl=Math.sin(lat); PWF.cl=Math.cos(lat); PWF.g=1+(gMax-1)*w; PWF.on=1; PWF.R=360/ATMO_DEG_PER_UNIT/(2*Math.PI); }
  const opt = name => { try { return eval(name); } catch (e) { return undefined; } };
  return { _groundField, SkyGround, PWF, GFX, pwfOn, _skyHorizonReach, _skyGroundR, _SKY_SETTLE, _skyGroundGate,
    _skyIdleRoom: opt('_skyIdleRoom'), _skySliceOk: opt('_skySliceOk'), _SKY_IDLE: opt('_SKY_IDLE'), _skySlowSlice: opt('_skySlowSlice'), _mcUpHealthy: opt('_mcUpHealthy'), _mcUpDelay: opt('_mcUpDelay'),
    setSite: s => { PW.site = s; } };
`)(THREE, W, TL, performance);
const MEASURE = !!process.env.MEASURE, NEW = typeof E._skyIdleRoom === 'function';

// ── (1) pure gates ──
if (NEW && !MEASURE) {
  const I = E._SKY_IDLE;
  ok(!E._skyIdleRoom(I.min - 0.01, 0) && E._skyIdleRoom(I.min, 0), 'idle room: nothing starts in an idle gap under ' + I.min + ' ms');
  ok(!E._skyIdleRoom(9, 6) && E._skyIdleRoom(10.5, 6), 'idle room: a 6 ms build needs 1.5 x 6 + ' + I.margin + ' ms left');
  ok(E._skySliceOk(20, 36) && !E._skySliceOk(33, 36) && !E._skySliceOk(0, 36) && E._skySliceOk(54, 68) && !E._skySliceOk(60, 68), 'timer slice only with headroom (EMA <= ' + I.head + ' x budget; legacy 68 ms budget scales)');
  ok(E._mcUpHealthy('med', 0.049) && !E._mcUpHealthy('med', 0.051) && E._mcUpHealthy('high', 0.035) && !E._mcUpHealthy('high', 0.04), 'MC ladder: med <= 50 ms frames, high only inside the 30 fps budget (36 ms)');
  ok(E._mcUpDelay(0) === 3000 && E._mcUpDelay(5) === 8000 && E._mcUpDelay(500) === 15000, 'MC ladder: re-check backs off 3 s -> 15 s, never stops');
}

// ── the cliff on Solenne ──
const R = 360 / 0.008 / (2 * Math.PI);
const pal = { water: true, liquidColor: 0x1a4a7a, ground: 0x3a7d34 }, body = { name: 'Solenne', type: 'Habitable', home: true }, site = { lat: 18, lon: 40 };
E.setSite(site); const F = E._groundField(body, site, pal);
let cliff = null;
for (let x = -2600; x <= 2600; x += 40) for (let z = -2600; z <= 2600; z += 40) {
  const h = F.H(x, z); if (!(h > 30)) continue; let sea = false;
  for (let a = 0; a < 8; a++) if (F.H(x + Math.cos(a * 0.785) * 150, z + Math.sin(a * 0.785) * 150) < -5) sea = true;
  if (sea && (!cliff || Math.abs(h - 60) < Math.abs(cliff.h - 60))) cliff = { x, z, h };
}
const eye = cliff.h + 3.3, gR = E._skyGroundR(1200, E._skyHorizonReach(R, eye), Math.max(3500, E._skyHorizonReach(R, eye)));
const NEAR = 600;   // "nearby": every tile whose nearest point is within 600 u (~340 m) of the camera
const nearLeft = G => { let k = 0; for (const nd of G.queue) if (!nd.mesh && !nd._hidden && nd._d < NEAR) k++; return k; };
function coverage(G, rMax) {   // fov-fill.js: every ground point the camera can see out to rMax lies under a drawn tile?
  let miss = 0; const find = (x, z) => { for (const r of G.roots.values()) if (x >= r.x0 && x < r.x0 + r.size && z >= r.z0 && z < r.z0 + r.size) return r; return null; };
  for (let d = 30; d < rMax; d *= 1.12) for (let a = 0; a < 48; a++) {
    const x = cliff.x + Math.cos(a * 0.1309) * d, z = cliff.z + Math.sin(a * 0.1309) * d; let nd = find(x, z), cv = false, hid = false;
    while (nd) { if (nd._vis === false) { hid = true; break; } if (nd.mesh && nd.mesh.visible) { cv = true; break; } if (!nd.kids) break; const h = nd.size / 2; nd = nd.kids[(x >= nd.x0 + h ? 1 : 0) + (z >= nd.z0 + h ? 2 : 0)]; }
    if (!hid && !cv) miss++;
  }
  return miss;
}
const keyset = G => { const out = []; const w = nd => { if (nd.mesh && nd.mesh.visible) out.push(nd.x0 + ',' + nd.z0 + ',' + nd.size); if (nd.kids) nd.kids.forEach(w); }; G.roots.forEach(w); return out.sort().join(';'); };
// one run: frames of `frameMs` (77 ms = a 13 fps tablet; 33 ms = 30 fps), each tile build costs `cost` ms; after each frame the page gets `idle` ms of idle
// time (requestIdleCallback) or, with opts.slice, the timer slice fires under a DMBudget stub reporting opts.ema / opts.budget.
function run(o) {
  o = Object.assign({ cost: 6, frameMs: 77, idle: 0, slice: false, ema: 20, budget: 36, quietUntil: 0, max: 4000, mobile: true }, o);
  clock.t = 1000; E.GFX.isMobile = o.mobile; E.pwfOn(cliff.x, cliff.z, eye, site);
  let pending = null, idleStarts = 0, idleBad = 0, sliceBad = 0, frameBad = 0;
  delete W.requestIdleCallback; delete W.setTimeout; delete W.DMBudget;
  W._dmQuiet = () => clock.t < o.quietUntil; W.document.hidden = !!o.hidden;
  if (o.idle > 0) W.requestIdleCallback = f => { pending = f; return 1; };
  if (o.slice) { W.setTimeout = f => { pending = f; return 1; }; W.DMBudget = { on: true, emaMs: () => o.ema, budgetMs: () => o.budget }; }
  const G = new E.SkyGround(new Grp(), F, pal, {}); G.viewR = gR;
  const real = G._build; let inFrame = false, t0 = 0, dlEnd = 0, mode = '';
  G._build = function (nd) {
    if (inFrame) { const B = G.stat && G.budget; if (clock.t - t0 >= G.budget * E._SKY_SETTLE.k + 1e-9 && !nd._foc) frameBad++; }
    else if (mode === 'idle') { idleStarts++; if (dlEnd - clock.t < Math.max(4, (this.buildMs || 0) * 1.5 + 1.5) - 1e-9) idleBad++; }
    else if (mode === 'slice') { idleStarts++; if (clock.t >= dlEnd - 1e-9) sliceBad++; }
    real.call(this, nd); clock.t += o.cost;
  };
  let fr = 0, left = 1, nearFr = -1, covFr = -1, bareAfter1 = 0;
  const c = new V3(cliff.x, eye, cliff.z);
  while (fr < o.max) {
    const start = clock.t; t0 = clock.t; inFrame = true; left = G.update({ position: c }); inFrame = false; fr++;
    if (fr > 1 && G._bareUnder()) bareAfter1++;
    if (nearFr < 0 && nearLeft(G) === 0) nearFr = fr;
    if (covFr < 0 && fr % 2 === 0 && coverage(G, gR * 0.82) === 0) covFr = fr;
    if (left === 0 && nearFr >= 0) break;
    clock.t = Math.max(clock.t, start + o.frameMs - o.idle);   // the rest of the frame (render, other systems)
    if (pending) { const f = pending; pending = null;
      if (o.idle > 0) { mode = 'idle'; dlEnd = clock.t + o.idle; f({ didTimeout: false, timeRemaining: () => Math.max(0, dlEnd - clock.t) }); }
      else { mode = 'slice'; dlEnd = clock.t + (E.GFX.isMobile ? E._SKY_IDLE.slice : E._SKY_IDLE.sliceD); f(); }
      mode = ''; }
    clock.t = Math.max(clock.t, start + o.frameMs);
  }
  for (let i = 0; i < 20; i++) { clock.t += o.frameMs; G.update({ position: c }); }
  return { G, fr, left, nearFr, covFr, idleStarts, idleBad, sliceBad, frameBad, bareAfter1, keys: keyset(G), idleN: G.stat.idleN || 0 };
}
const s13 = (fr, ms) => (fr * ms / 1000).toFixed(1) + ' s';
const A = run({ cost: 6, frameMs: 77 });
console.log('  no idle time (13 fps tablet, 6 ms tiles, 4 ms budget): view covered in ' + A.covFr + ' frames, nearby tiles full detail in ' + A.nearFr + ' frames (' + s13(A.nearFr, 77) + '), every tile in ' + A.fr + ' frames (' + s13(A.fr, 77) + ')');
const A30 = run({ cost: 6, frameMs: 33 });
const D = run({ cost: 2.5, frameMs: 33, mobile: false });
console.log('  no idle time (desktop, 2.5 ms tiles, 7 ms budget): covered ' + D.covFr + ', nearby ' + D.nearFr + ' frames (' + s13(D.nearFr, 33) + '), all ' + D.fr + ' frames (' + s13(D.fr, 33) + ')');
console.log('  no idle time (30 fps phone, 6 ms tiles): covered ' + A30.covFr + ', nearby ' + A30.nearFr + ' frames (' + s13(A30.nearFr, 33) + '), all ' + A30.fr + ' frames (' + s13(A30.fr, 33) + ')');
if (MEASURE && !NEW) { console.log('(measure only: this index.html has no idle fill)'); process.exit(0); }
const B = run({ cost: 6, frameMs: 33, idle: 12 });
const BD = run({ cost: 2.5, frameMs: 33, idle: 12, mobile: false });
console.log('  idle fill (desktop, 2.5 ms tiles, 12 ms idle a frame): covered ' + BD.covFr + ', nearby ' + BD.nearFr + ' frames (' + s13(BD.nearFr, 33) + '), all ' + BD.fr + ' frames (' + s13(BD.fr, 33) + ')');
console.log('  idle fill (30 fps phone, 12 ms idle a frame): covered ' + B.covFr + ', nearby ' + B.nearFr + ' frames (' + s13(B.nearFr, 33) + '), all ' + B.fr + ' frames (' + s13(B.fr, 33) + '), ' + B.idleN + ' idle builds');
const S = run({ cost: 6, frameMs: 33, slice: true, ema: 22, budget: 36 });
console.log('  Safari timer slice (headroom, EMA 22 / 36 ms): nearby ' + S.nearFr + ' frames (' + s13(S.nearFr, 33) + '), all ' + S.fr + ' frames (' + s13(S.fr, 33) + ')');
if (MEASURE) process.exit(0);

// ── (2) no idle time ──
ok(A.left === 0 && A.nearFr > 0 && A.idleStarts === 0, 'no idle time: drains in the frame budget alone (' + A.fr + ' frames), no work outside the frame');
ok(A30.left === 0 && A30.idleStarts === 0, 'no idle time at 30 fps: drains (' + A30.fr + ' frames)');
ok(A.frameBad === 0 && A30.frameBad === 0, 'frame budget honoured (no non-focus build starts past the settle budget)');
// ── (3) idle fill ──
ok(B.left === 0 && B.idleStarts > 0 && B.idleBad === 0, 'idle fill: ' + B.idleStarts + ' idle builds, every one started with room for it');
// bounds (v329, same harness: nearby 248 / 253 frames on the 13 fps tablet / 30 fps phone, all 268 / 273; desktop nearby ~110)
ok(A.nearFr <= 200 && A30.nearFr <= 200, 'build order: nearby tiles at full detail within 200 frames with no idle time at all (' + A.nearFr + ' / ' + A30.nearFr + '; v329 ~250)');
ok(B.nearFr <= 140 && B.nearFr < A30.nearFr * 0.75, 'idle fill (30 fps phone): nearby tiles at full detail within 140 frames (' + B.nearFr + ', 4.6 s; no idle ' + A30.nearFr + ')');
ok(B.fr < A30.fr * 0.75, 'idle fill: every tile in ' + B.fr + ' frames (no idle ' + A30.fr + ')');
ok(BD.nearFr <= 60 && BD.nearFr < D.nearFr, 'desktop with idle: nearby tiles at full detail within 60 frames (' + BD.nearFr + '; no idle ' + D.nearFr + ')');
ok(A.covFr > 0 && A.covFr <= 30 && B.covFr <= 30 && D.covFr <= 30, 'the view still fills first: covered in ' + A.covFr + ' / ' + B.covFr + ' / ' + D.covFr + ' frames (<= 30)');
ok(B.frameBad === 0, 'idle fill leaves the frame\'s own budget unchanged');
// ── (4) Safari timer slice ──
ok(S.left === 0 && S.idleStarts > 0 && S.sliceBad === 0 && S.fr < A30.fr, 'timer slice with headroom: ' + S.fr + ' frames (was ' + A30.fr + '), no build starts past the slice');
const S2 = run({ cost: 6, frameMs: 33, slice: true, ema: 33, budget: 36, max: 3000 });
// (t1590) near / below the line the headroom slice stays shut, but ONE bounded slice still runs at most every _SKY_IDLE.slowMs (time-based), so the fill never freezes
{ const bound = Math.ceil(S2.fr * 33 / E._SKY_IDLE.slowMs) + 1;
  ok(S2.left === 0 && S2.sliceBad === 0 && S2.idleStarts > 0 && S2.G.stat.slow <= bound && S2.fr <= A30.fr, 't1590: near the 30 fps line (EMA 33 / 36) the slow slice runs ' + S2.G.stat.slow + ' times (<= ' + bound + ', one per ' + E._SKY_IDLE.slowMs + ' ms), drains in ' + S2.fr + ' frames (no slice ' + A30.fr + ')'); }
// (t1590) a 5 fps tablet without requestIdleCallback (Justin's v348 Mars: 3-11 fps): the fill CONVERGES, faster than the frame budget alone, and says so (stat.converged)
{ const T5 = run({ cost: 6, frameMs: 200, slice: true, ema: 200, budget: 36, max: 3000 }), N5 = run({ cost: 6, frameMs: 200, max: 3000 });
  ok(T5.left === 0 && T5.G.stat.converged === 1 && T5.sliceBad === 0, 't1590: 5 fps tablet, no idle callback: converges in ' + T5.fr + ' frames (' + s13(T5.fr, 200) + '), stat.converged = 1');
  ok(T5.fr < N5.fr, 't1590: the slow slice drains it sooner than the frame budget alone (' + T5.fr + ' vs ' + N5.fr + ' frames)');
  ok(N5.left === 0 && N5.G.stat.converged === 1, 't1590: even with no slice at all the queue converges (' + N5.fr + ' frames): it is never starved'); }
ok(E._SKY_IDLE.slowMs >= 100 && E._SKY_IDLE.slowMs <= 150 && E._skySlowSlice(1000, 1000 - E._SKY_IDLE.slowMs) && !E._skySlowSlice(1000, 1001 - E._SKY_IDLE.slowMs) && E._skySlowSlice(1000, 0), 't1590: _skySlowSlice is time-based (>= ' + E._SKY_IDLE.slowMs + ' ms apart)');
// ── (5) quiet / hidden / disposed / no starvation ──
const Q = run({ cost: 6, frameMs: 33, idle: 12, quietUntil: 1000 + 2500 });
ok(Q.left === 0 && Q.idleBad === 0 && Q.fr < A30.fr, 'arrival quiet window (2.5 s): no idle build inside it, the fill resumes after (' + Q.fr + ' frames)');
{ let qb = 0; const G0 = run({ cost: 6, frameMs: 33, idle: 12, max: 1 }).G; W._dmQuiet = () => true; const real = G0._build; G0._build = function (nd) { qb++; real.call(this, nd); };
  G0.queue.push(...[]); G0._idleRun({ didTimeout: false, timeRemaining: () => 50 }); ok(qb === 0, 'quiet window: an idle callback builds nothing');
  W._dmQuiet = () => false; W.document.hidden = true; G0._idleRun({ didTimeout: false, timeRemaining: () => 50 }); ok(qb === 0, 'hidden tab: builds nothing'); W.document.hidden = false;
  G0.dispose(); G0._idleRun({ didTimeout: false, timeRemaining: () => 50 }); let kicked = 0; W.requestIdleCallback = () => { kicked++; }; G0._idleOn = false; G0._idleKick();
  ok(qb === 0 && kicked === 0, 'disposed: builds nothing, asks for no idle time'); }
// ── (6) same result, never bare ──
ok(B.keys === A30.keys && S.keys === A30.keys && Q.keys === A30.keys, 'the finished quadtree is identical with and without the idle fill (' + A30.keys.split(';').length + ' drawn tiles)');
ok(A.bareAfter1 === 0 && B.bareAfter1 === 0 && S.bareAfter1 === 0, 'the ground under her is never bare after the first frame');
// ── (7) source ──
{
  const up = cut('SkyGround.prototype.update=function', 'SkyGround.prototype._rootKeep=');
  ok(!/new\s+(Set|Map|Array|THREE)/.test(up) && !/=>/.test(up), 'update(): no per-frame allocation or closure');
  const idl = cut('SkyGround.prototype._idleKick=function', 'SkyGround.prototype._visit=function');
  ok(!/\bnew\b/.test(idl) && !/=>/.test(idl) && !/\{[a-zA-Z_]+:/.test(idl), '_idleKick / _sliceRun / _idleRun: no allocation, no closure, no object literal');
  ok(/requestIdleCallback\(this\._idleFn\)/.test(idl) && /setTimeout\(this\._sliceFn,0\)/.test(idl), 'the idle / timer callbacks are the ones bound once in the constructor');
  const ctor = cut('function SkyGround(scene,F,pal,o){', 'const _SKY_FADE0');
  ok(/this\._idleFn=this\._idleRun\.bind\(this\)/.test(ctor) && /this\._sliceFn=this\._sliceRun\.bind\(this\)/.test(ctor), 'callbacks bound in the constructor');
  ok(/SkyGround\.prototype\.dispose=function\(\)\{ this\._dead=true;/.test(html), 'dispose stops the fill');
  const mc = cut('const _go=(n)=>{', 'setTimeout(()=>_go(0),6000);');
  ok(!/n<20/.test(mc) && /_mcUpHealthy\(next,TERRAIN\._shDt\)/.test(mc) && /_mcUpDelay\(n\)/.test(mc), 'MC ladder: no 20-try cap, tier-aware health gate, backs off');
  ok(/then\(ok=>/.test(mc) && /return true;/.test(cut('async function upgradeSurfaceMcLOD(', '// (v330 streaming)')), 'MC ladder: a finished step asks for the next (low -> med -> high)');
  { const v = +((fs.readFileSync(path.join(root, 'sw.js'), 'utf8').match(/dartmeadow-engine-v(\d+)/) || [])[1] || 0); ok(v >= 330, 'sw v330 or later (v' + v + ')'); }   // (t1516) a later branch bumps past v330
  ok(/const ATMO_DEFAULT_AGL\s*=\s*46\b/.test(html), 'ATMO_DEFAULT_AGL stays 46');
  ok(/if\(!_isRealWebGPU\(surfRenderer\)\)\{ TERRAIN\.mcUpgradeLocked=true; return; \}/.test(cut('async function upgradeSurfaceMcLOD(', '// (v330 streaming)')), '(v337, #256 review) no real WebGPU: the MC ladder locks, so the never-give-up loop stops');
}
console.log(fails ? 'skyground-stream FAILED ' + fails + '/' + n : 'skyground-stream OK (' + n + ' checks)'); process.exit(fails ? 1 : 0);
