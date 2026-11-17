// node tools/tests/galsky-compile.js — (v338) flight warm-up from the Mali-G615 perf log perf/20261117T041548-fc1bb4f0.json:
//   1. every GalSky drawable goes through exactly ONE warm-up compile: the world step's staged compile takes the visible LODs, the galaxy step only the
//      rest (hidden LODs), as a GalSky-subtree compile against flightScene (same cache / light reference as render()).  Visibility restored after.
//   2. when the world step hits its cap, the staged compile is abandoned: no more groups start, no more waiting, so the next step does not sit
//      on it (it used to wait up to 20 s for it).  The in-flight pipelines still finish (in the background).
//   3. the real _flightWarmup step loop, on a virtual clock with the log's costs: when 'sun and flares' starts, before vs after.
// HTML=path runs it against another index.html (e.g. main) to print the baseline numbers; the assertions are for this branch.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..');
const HTML = process.env.HTML || path.join(root, 'index.html'), BASE = !!process.env.HTML;
const IDX = fs.readFileSync(HTML, 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (BASE) { console.log('  (baseline) ' + (c ? 'yes ' : 'no  ') + m); return; } if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const cut = (s, a, b) => { const i = s.indexOf(a); if (i < 0) throw new Error('missing ' + a); const j = s.indexOf(b, i + a.length); if (j < 0) throw new Error('missing ' + b); return s.slice(i, j + b.length); };

// ── virtual clock ───────────────────────────────────────────────────────────────────────────────────────────
function clock() {
  let now = 0, seq = 0; const q = [];
  const C = { now: () => now, setTimeout: (f, ms) => { q.push({ t: now + Math.max(0, ms | 0), s: seq++, f }); return seq; }, clearTimeout: () => {} };
  C.run = async (until) => { for (let k = 0; k < 200000; k++) { for (let m = 0; m < 30; m++) await null; if (until && until()) return; if (!q.length) return; q.sort((a, b) => a.t - b.t || a.s - b.s); const e = q.shift(); now = Math.max(now, e.t); e.f(); } };
  return C;
}
// ── a tiny scene graph + a WebGPU-like renderer: pipelines cached by object, built one after another on a "GPU process" queue ──
function obj(name, kind, kids, visible = true) { const o = { name, visible, children: kids || [], parent: null, frustumCulled: false, isMesh: kind === 'mesh', isLight: false, isCamera: false };
  o.children.forEach(c => { c.parent = o; });
  o.traverse = function (f) { f(this); for (const c of this.children) c.traverse(f); };
  o.traverseVisible = function (f) { if (!this.visible) return; f(this); for (const c of this.children) c.traverseVisible(f); };
  return o; }
function world(C) {
  const mk = (p, k, cost) => { const a = []; for (let i = 0; i < k; i++) { const m = obj(p + i, 'mesh'); m.cost = cost; a.push(m); } return a; };
  const gsVis = mk('gs', 40, 150), gsHid = mk('gsLOD', 19, 150);                      // 40 visible GalSky draws (log: 40 draws, 59 pipelines)
  const lod = obj('lodHidden', 'group', gsHid, false);
  const gal = obj('JOTS_GalSky', 'group', gsVis.concat([lod]));
  const m1 = obj('miscA', 'group', mk('a', 11, 500)), m2 = obj('miscB', 'group', mk('b', 10, 600));   // log: misc 11, misc 10
  const scene = obj('flightScene', 'group', [gal, m1, m2]); scene.isScene = true;
  const R = { built: new Set(), gpuFree: 0, calls: [], projected: new Map() };
  R.compileAsync = (sc, cam, target) => {
    const vis = []; sc.traverseVisible(o => { if (o.isMesh) vis.push(o); });
    R.calls.push({ root: sc.name, target: target ? target.name : null, n: vis.length });
    let last = C.now();
    for (const o of vis) { R.projected.set(o, (R.projected.get(o) || 0) + 1); if (R.built.has(o)) continue; R.built.add(o); R.gpuFree = Math.max(R.gpuFree, C.now()) + o.cost; last = Math.max(last, R.gpuFree); }
    return new Promise(res => C.setTimeout(res, last - C.now()));
  };
  return { scene, gal, gsVis, gsHid, lod, R };
}
function ctxFor(C, W, extra) {
  const ctx = Object.assign({ console: { log() {}, warn() {}, error() {} }, Math, Set, WeakSet, Map, Promise, Array, Object, String, JSON, Date,
    performance: { now: C.now }, setTimeout: C.setTimeout, clearTimeout: C.clearTimeout, location: { search: '' }, GFX: { isMobile: true },
    dmSys: { load() {}, done() {} }, flightRenderer: W.R, flightScene: W.scene, flightCamera: { name: 'cam' }, galSkyRoot: W.gal, galSky: { ready: true } }, extra || {});
  ctx.window = ctx; vm.createContext(ctx); return ctx;
}
const STAGED = cut(IDX, 'async function _compileStaged(scene,cam,o){', '\n}\n');
const HAS_REST = IDX.includes('function _gsPrecompileRest(');
const GS = HAS_REST ? (() => { const i = IDX.indexOf('const _gsWarmed=new WeakSet();'), r = IDX.indexOf('function _gsPrecompileRest(){', i), j = IDX.indexOf('return pr;\n}', r); return IDX.slice(i, j + 12); })() : cut(IDX, 'function _gsPrecompile(){', 'return pr;\n}');

(async () => {
  console.log('== 1. GalSky: each drawable compiled once in the warm-up');
  {
    const C = clock(), W = world(C), ctx = ctxFor(C, W);
    vm.runInContext(STAGED + '\n' + GS + '\nthis._compileStaged=_compileStaged;this._gsMarkWarm=typeof _gsMarkWarm!=="undefined"?_gsMarkWarm:null;this.rest=typeof _gsPrecompileRest!=="undefined"?_gsPrecompileRest:_gsPrecompile;', ctx);
    const rec = { groups: [], ms: 0, capped: false, single: false }; let done = false;
    ctx._compileStaged(W.scene, ctx.flightCamera, { rec, cap: 13000, step: 6000, onCompile: ctx._gsMarkWarm || undefined }).then(() => { done = true; });
    await C.run(() => done && W.R.gpuFree <= C.now());
    await C.run(); W.R.calls.length = 0;
    const before = new Map(W.R.projected);
    let gDone = false; Promise.resolve(ctx.rest()).then(() => { gDone = true; }); await C.run(() => gDone);
    const visTwice = W.gsVis.filter(o => (W.R.projected.get(o) || 0) > 1).length, hidOnce = W.gsHid.filter(o => W.R.projected.get(o) === 1).length;
    const others = [...W.R.projected.keys()].filter(o => !W.gsVis.includes(o) && !W.gsHid.includes(o) && W.R.projected.get(o) > before.get(o)).length;
    ok(visTwice === 0, 'visible GalSky draws projected again by the galaxy step: ' + visTwice + ' of 40');
    ok(hidOnce === 19, 'hidden GalSky LODs compiled exactly once (galaxy step): ' + hidOnce + ' of 19');
    ok(others === 0, 'the galaxy step does not re-project the rest of the flight scene (' + others + ' non-GalSky draws re-projected)');
    ok(W.R.calls.length === 1 && W.R.calls[0].root === 'JOTS_GalSky' && W.R.calls[0].target === 'flightScene', 'galaxy step = one GalSky-subtree compile against flightScene (' + JSON.stringify(W.R.calls) + ')');
    ok(W.lod.visible === false && W.gsVis.every(o => o.visible) && W.gsHid.every(o => o.visible), 'visibility restored after the projection');
    // world step capped before reaching GalSky -> the galaxy step compiles all of it
    const C2 = clock(), W2 = world(C2), ctx2 = ctxFor(C2, W2); vm.runInContext(GS + '\nthis.rest=typeof _gsPrecompileRest!=="undefined"?_gsPrecompileRest:_gsPrecompile;', ctx2);
    let d2 = false; Promise.resolve(ctx2.rest()).then(() => { d2 = true; }); await C2.run(() => d2);
    ok(W2.gsVis.concat(W2.gsHid).every(o => W2.R.projected.get(o) === 1), 'nothing marked (world step never reached GalSky): the galaxy step compiles every GalSky draw');
  }

  console.log('== 2. world step cap: the abandoned staged compile settles at once');
  {
    const C = clock(), W = world(C); W.gsVis.forEach(o => { o.cost = 500; });   // GalSky alone: 20 s of pipelines
    const ctx = ctxFor(C, W); vm.runInContext(STAGED + '\nthis._compileStaged=_compileStaged;', ctx);
    const rec = { groups: [], ms: 0, capped: false, single: false }; let doneAt = -1;
    ctx._compileStaged(W.scene, ctx.flightCamera, { rec, cap: 13000, step: 6000 }).then(() => { doneAt = C.now(); });
    C.setTimeout(() => { if (rec.abandon) rec.abandon(); }, 15000);   // the step loop's 15 s cap
    await C.run(() => doneAt >= 0);
    ok(doneAt >= 0 && doneAt <= 15000 + 50, 'staged compile settles when abandoned at 15 s (settled at ' + doneAt + ' ms)');
    ok(rec.abandoned === true || BASE, 'rec.abandoned recorded (' + rec.abandonedAt + ' ms)');
    await C.run(); ok(W.gsVis.every(o => W.R.built.has(o)), 'pipelines already handed to the GPU still finish in the background');
  }

  console.log('== 3. the warm-up step loop (virtual clock, log costs)');
  for (const scenario of ['log']) {
    const C = clock(), W = world(C); W.gsVis.forEach(o => { o.cost = 300; });   // GalSky visible: 12 s of pipelines on the Mali (the group hit its 6 s wait)
    const starts = {}, costs = { 'sun and flares': 7063, 'star dive': 6000, atmosphere: 7000, 'planet maps': 3000, 'aboard occlusion': 1000 };
    const stub = (name) => () => { starts[name] = C.now(); return new Promise(r => C.setTimeout(r, costs[name] || 100)); };
    const ctx = ctxFor(C, W, { INTRO: { on: false }, DMWarm: { steps: [] }, DMAR: null, _dmRecovery: () => false, _btReserveLights() {}, BTL: null, updateDistantSystems() {}, _lcApplyWorlds() {}, _distLightT: 0,
      DMStar: { warm: stub('sun and flares') }, DMStarBubble: { warm: stub('star dive') }, _taWarm: stub('atmosphere'), _wmWarmAll: stub('planet maps'), _aoccWarm: stub('aboard occlusion'), _wmKickHome() {}, _dmQuiet: () => false, _warmDrainLater: (q) => { ctx._late = q.map(s => s[0]); } });
    W.R.render = () => { starts.uploading = C.now(); };
    // the 3 compile groups of the log: GalSky (visible: 40 x 150 = 6 s), then two misc groups that queue behind it on the GPU process
    const warm = cut(IDX, 'async function _flightWarmup(){', '\n}\n');
    vm.runInContext(STAGED + '\n' + GS + '\n' + warm + '\nthis.go=_flightWarmup;', ctx);
    let done = false; ctx.go().then(() => { done = true; }); await C.run(() => done);
    const fc = ctx._flightCompile || {};
    console.log('  world compile groups ' + JSON.stringify(fc.groups) + ' ms ' + fc.ms + (fc.abandoned ? ' (abandoned at ' + fc.abandonedAt + ' ms)' : '') + '; sun and flares started at ' + starts['sun and flares'] + ' ms; warm-up ' + ctx._warmupMs + ' ms; steps ' + JSON.stringify(ctx._warmSteps));
    ok(starts['sun and flares'] <= 15000 + 100, "'sun and flares' starts right after the world step's 15 s cap (" + starts['sun and flares'] + ' ms), not after the abandoned compile');
    ok(typeof ctx._warmupMs === 'number', 'warm-up completes');
  }

  console.log('== source checks');
  if (!BASE) {
    const loop = cut(IDX, 'const _rec=_dmRecovery()', 'if(_later.length) _warmDrainLater(_later);');
    ok(/if\(_to&&typeof steps\[i\]\[3\]==='function'\)\{ try\{ steps\[i\]\[3\]\(\); \}catch\(e\)\{\} \}/.test(loop), 'step loop: a capped step with an abandon hook is told to stop');
    ok(/\['galaxy',\(\)=>galSky&&galSky\.ready&&_gsPrecompileRest\(\)\]/.test(IDX) && /onCompile:_gsMarkWarm/.test(IDX), 'galaxy step = _gsPrecompileRest; world step marks what it compiled');
    ok(/try\{pr=flightRenderer\.compileAsync\(flightScene,flightCamera\);/.test(cut(IDX, 'function _gsPrecompile(){', 'return pr;\n}')) && /updateGalSky\(true\);\n  _gsPrecompile\(\);/.test(IDX), 'build-time _gsPrecompile (boot / rebuild, before the fly-out) unchanged');
    ok(!/forceSinglePass/.test(cut(IDX, 'const _gsWarmed=new WeakSet();', 'function setGalSkySystem')), 'no forceSinglePass / side / transparency change');
    ok(/const ATMO_DEFAULT_AGL\s*=\s*46\b/.test(IDX), 'ATMO_DEFAULT_AGL stays 46');
  }
  console.log(BASE ? 'galsky-compile: baseline printed' : (fails ? 'galsky-compile: ' + fails + ' of ' + n + ' checks FAILED' : 'galsky-compile: all ' + n + ' checks passed'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  ERROR ' + (e && e.stack || e)); process.exit(1); });
