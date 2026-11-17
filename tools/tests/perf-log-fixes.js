// node tools/tests/perf-log-fixes.js — (v337) fixes from the Mali-G615 perf log perf/20261117T041548-fc1bb4f0.json (gpuClass low, score 37, sw v329):
//   1. kite-board buttons: _kbPlace (250 ms timer / resize / orientation) reads NO layout (no getBoundingClientRect / checkVisibility / offset*); the
//      rects arrive through an IntersectionObserver callback and the placement written there is identical to the old synchronous code.
//   2. perflog memCensus: the memory scan runs as a resumable job in small slices (<= MEM_SLICE_MS each), resumed by idle callbacks (timer fallback
//      on Safari), finished synchronously only when the tab is hidden / the session ends; its result is the same report shape.
//   3. preset: an explicit pick above the device class is kept (saved as picked) but the runtime tier eases down one step per sustained 30 fps miss,
//      never below what Auto picks for the device; Auto / custom untouched; a fresh pick restores it.
//   4. (#256 review) upgradeSurfaceMcLOD locks the MC ladder when the renderer is not real WebGPU (the walk-patch loop stops).
// (v339, Watcher's #261 deep review)
//   5. no double drop: the preset steps down only while DMBudget.isExhausted() (ladder fully shed, still over budget), counting exhausted time only.
//   6. memCensus: a world build / close aborts the sliced scan (generator ended, idle callback cancelled, no scene refs kept); it also self-aborts on a world change.
//   7. dm-governor never persists the session-eased scale under the player's pick (GFX.runtimeTier set).
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const IDX = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), PL = fs.readFileSync(path.join(root, 'ui/dm-perflog.js'), 'utf8');
const SW = fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), SWV = +((SW.match(/CACHE_NAME = 'dartmeadow-engine-v(\d+)'/) || [])[1] || 0);   // the expected stamp follows sw.js (CE renumbers at merge)
const cut = (s, a, b) => { const i = s.indexOf(a); if (i < 0) throw new Error('missing ' + a); const j = s.indexOf(b, i + a.length); if (j < 0) throw new Error('missing ' + b); return s.slice(i, j); };

console.log('== 1. kite-board buttons: no layout read in _kbPlace, same placement');
{
  const src = cut(IDX, 'const _KB_GEO={', 'function _installKiteBoardButtons');
  // the old placement, verbatim maths (main 6d96dea)
  const oldPlace = (r, vis, shipOnly, sw) => { let show = r.width > 8 && r.height > 8 && vis; if (show && shipOnly) show = sw; if (!show) return { display: 'none' }; return { display: 'flex', left: ((r.left + r.width * 0.185) | 0) + 'px', top: ((r.top + r.height * 0.47) | 0) + 'px' }; };
  let layoutReads = 0, ioCb = null; const observed = [];
  const mkHost = (rect, vis) => ({ rect, vis, getBoundingClientRect() { layoutReads++; return this.rect; }, checkVisibility() { layoutReads++; return this.vis; }, get offsetWidth() { layoutReads++; return 0; } });
  const body = { classList: { contains: (c) => c === 'ship-walk' ? ctx.sw : false } };
  const ctx = { sw: false, document: { body }, console, Math,
    IntersectionObserver: function (cb) { ioCb = cb; this.observe = (h) => observed.push(h); this.unobserve = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext('var _KB_FLOAT=[];' + src + ';this._kbPlace=_kbPlace;this._KB_FLOAT=_KB_FLOAT;', ctx);
  const cases = [[{ left: 100.7, top: 200.2, width: 64.3, height: 40.9 }, true, false], [{ left: 0, top: 0, width: 0, height: 0 }, true, false], [{ left: 33.3, top: 77.7, width: 120, height: 9 }, false, false], [{ left: 500.5, top: 10.1, width: 48, height: 48 }, true, true]];
  const hosts = cases.map(([r, v, so]) => { const h = mkHost(r, v); const w = { style: {} }; ctx._KB_FLOAT.push({ host: h, w, shipOnly: so }); return h; });
  for (let k = 0; k < 3; k++) ctx._kbPlace();
  ok(layoutReads === 0, '_kbPlace x3: no getBoundingClientRect / checkVisibility / offset* read (' + layoutReads + ')');
  ok(observed.length === 12 && hosts.every(h => observed.includes(h)), 'each call re-observes every host (the browser computes the rect in its own rendering step)');
  for (const sw of [false, true]) {
    ctx.sw = sw; ctx._KB_FLOAT.forEach(F => { F.k = undefined; F.w.style = {}; });
    ioCb(hosts.map(h => ({ target: h, boundingClientRect: h.rect })));
    let same = true; ctx._KB_FLOAT.forEach((F, i) => { const want = oldPlace(cases[i][0], cases[i][1], cases[i][2], sw), got = F.w.style; for (const k in want) if (got[k] !== want[k]) same = false; });
    ok(same, 'observer callback writes the same display / left / top as the old code (ship-walk ' + sw + ')');
  }
  // unchanged rect: no style write
  let writes = 0; ctx._KB_FLOAT.forEach(F => { F.w.style = new Proxy({}, { set: (o, k, v) => { writes++; o[k] = v; return true; } }); });
  ioCb(hosts.map(h => ({ target: h, boundingClientRect: h.rect }))); ok(writes === 0, 'unchanged rects: no style writes');
  // fallback without IntersectionObserver: the old synchronous behaviour
  const ctx2 = Object.assign({}, ctx, { IntersectionObserver: undefined }); ctx2.window = ctx2; vm.createContext(ctx2);
  vm.runInContext('var _KB_FLOAT=[];' + src + ';this._kbPlace=_kbPlace;this._KB_FLOAT=_KB_FLOAT;', ctx2);
  const h2 = mkHost(cases[0][0], true), w2 = { style: {} }; ctx2._KB_FLOAT.push({ host: h2, w: w2, shipOnly: false }); ctx2._kbPlace();
  ok(w2.style.left === oldPlace(cases[0][0], true, false, false).left, 'no IntersectionObserver: falls back to the old read (same left)');
  const inst = cut(IDX, 'function _installKiteBoardButtons', '_bcButtons();');
  ok(/setInterval\(_kbPlace,250\)/.test(inst) && /addEventListener\('resize',_kbPlace\)/.test(inst) && /addEventListener\('orientationchange',_kbPlace\)/.test(inst), 'refreshed every 250 ms, on resize and on orientationchange (+ ResizeObserver on the hosts)');
  const placeBody = cut(src, 'function _kbPlace(){', 'const sw=document.body');
  ok(!/getBoundingClientRect|checkVisibility|offset(Width|Height|Top|Left)|getComputedStyle/.test(placeBody), 'the observer path of _kbPlace has no layout-reading call in its source');
}

console.log('== 2. perflog memCensus: sliced idle job');
{
  const job = cut(PL, 'const MEM_SLICE_MS', 'function census() {');
  let clock = 0; const ricQ = [], recs = [];
  const ctx = { performance: { now: () => clock }, document: { hidden: false }, Date, Math, Set, Map, Array, Object, String, console, JSON,
    window: {}, ric: (f, ms) => ricQ.push(f) };
  ctx.window.__dmRec = (k, ms) => recs.push([k, ms]);
  vm.createContext(ctx);
  vm.runInContext('let _memCache=null,_memAt=0,_memForce=false,_census=null,ended=false;' + job + ';this.memKick=memKick;this.memFinish=memFinish;this.get=()=>({c:_memCache,j:memJob});', ctx);
  // a scene: 3000 objects, each costing 0.01 ms of fake time to scan (30 ms total), 40 textures
  const texs = []; for (let i = 0; i < 40; i++) texs.push({ isTexture: true, name: 't' + i, image: { width: 1024 << (i % 3), height: 512 }, type: 1009 });
  const scene = { name: 'scene', children: [] };
  for (let g = 0; g < 30; g++) { const grp = { name: 'G' + g, parent: scene, children: [] }; scene.children.push(grp);
    for (let k = 0; k < 100; k++) { const o = { parent: grp, children: [], geometry: { attributes: { position: { array: { byteLength: 1200 } } } }, material: { map: texs[(g * 100 + k) % 40] } };
      Object.defineProperty(o, 'material', { get() { clock += 0.01; return this._m; }, set(v) { this._m = v; }, enumerable: true }); o.material = { map: texs[(g * 100 + k) % 40] }; grp.children.push(o); } }
  const roots = [['flight', scene]];
  ctx.memKick(roots);
  ok(ctx.get().c === null && ricQ.length === 1, 'census() path: nothing scanned synchronously, one idle callback queued');
  let slices = 0, maxSlice = 0;
  while (ricQ.length && slices < 1000) { const f = ricQ.shift(); const t0 = clock; f({ didTimeout: false, timeRemaining: () => 12 }); maxSlice = Math.max(maxSlice, clock - t0); slices++; }
  const m = ctx.get().c;
  ok(!!m && m.objects === 3031 && m.nTex === 40, 'the job finishes with every object / unique texture counted (' + (m && m.objects) + ' objects, ' + (m && m.nTex) + ' textures)');
  ok(slices >= 6 && m.slices === slices, 'it took ' + slices + ' idle slices (>= 6 for ~30 ms of work)');
  ok(maxSlice <= 4 + 0.05, 'every slice stays within the 4 ms budget (max ' + maxSlice.toFixed(2) + ' ms)');
  ok(Array.isArray(m.texTop) && m.texTop.length === 10 && Array.isArray(m.geoTop) && typeof m.texMB === 'number', 'same report shape (texTop / geoTop / texMB / geoMB / nTex)');
  ok(recs.length === 1 && recs[0][0] === 'perflog.memCensus' && Math.abs(recs[0][1] - m.ms) < 1e-6, 'perflog.memCensus still recorded (whole scan cost ' + m.ms + ' ms)');
  // Safari fallback: ric hands the callback null -> the fixed small budget
  vm.runInContext('_memCache=null;', ctx); ctx.memKick(roots); let sl2 = 0, max2 = 0;
  while (ricQ.length && sl2 < 1000) { const f = ricQ.shift(); const t0 = clock; f(null); max2 = Math.max(max2, clock - t0); sl2++; }
  ok(!!ctx.get().c && sl2 >= 6 && max2 <= 4.05, 'timer fallback (no idle deadline): ' + sl2 + ' slices, max ' + max2.toFixed(2) + ' ms');
  // tab hidden / final report: finished synchronously (nobody is playing)
  vm.runInContext('_memCache=null;', ctx); ctx.memFinish(roots); ok(!!ctx.get().c && !ctx.get().j, 'memFinish (hidden / pagehide report): runs to the end at once');
  const cen = cut(PL, 'function census() {', 'function build(');
  ok(/document\.hidden \|\| ended\) memFinish\(roots\); else memKick\(roots\)/.test(cen) && !/root\.traverse\(/.test(cen), 'census(): the play path only kicks the job; no whole-scene traverse inside it');
}

console.log('== 3. preset: explicit pick eases down under a sustained miss, never below the device class');
{
  const src = cut(IDX, 'var _PRESET_RANK=', 'function applyPreset(name){');
  const applied = [], toasts = []; let live = 0;
  const ctx = { GFX: { preset: 'ultra', runtimeTier: null }, STATE: { screen: 'flight' }, document: { hidden: false }, console, String,
    window: {}, applyPreset: (t) => applied.push(t), applyGraphicsLive: () => live++, autoPreset: () => 'low', toast: (m) => toasts.push(m), setInterval: () => 0 };
  ctx.window = Object.assign(ctx.window, { DMBudget: { on: true, emaMs: () => ctx.ema, budgetMs: () => 36, isExhausted: () => ctx.ex } }); ctx.ema = 37; ctx.ex = true;   // (v339) section 3 runs with the ladder exhausted; section 5 covers the gate
  vm.createContext(ctx); vm.runInContext(src + ';this.tick=_presetGovTick;this.step=_presetStepDown;', ctx);
  ok(ctx.step('ultra', 'low') === 'high' && ctx.step('high', 'low') === 'medium' && ctx.step('medium', 'low') === 'low' && ctx.step('low', 'low') === null && ctx.step('high', 'high') === null && ctx.step('auto', 'low') === null, '_presetStepDown: one step, floor = the Auto tier');
  for (let i = 0; i < 20; i++) ctx.tick(); ok(applied.length === 0, 'within budget (37 vs 36 ms, < 8 % over): no change');
  ctx.ema = 50; for (let i = 0; i < 5; i++) ctx.tick(); ok(applied.length === 0, '10 s over budget: not yet');
  ctx.tick(); ok(applied.join() === 'high' && ctx.GFX.runtimeTier === 'high' && ctx.GFX.preset === 'ultra' && live === 1, '12 s over budget: runtime tier ULTRA -> HIGH, GFX.preset (saved choice) still ultra');
  ok(toasts.length === 1 && /ULTRA choice is kept/.test(toasts[0]), 'one flat toast says so');
  for (let i = 0; i < 15; i++) ctx.tick(); ok(applied.length === 1, '30 s cool-down before the next look');
  for (let i = 0; i < 6; i++) ctx.tick(); ok(applied.join() === 'high,medium', 'still missing: HIGH -> MEDIUM');
  for (let i = 0; i < 21; i++) ctx.tick(); ok(applied.join() === 'high,medium,low', 'then MEDIUM -> LOW (= Auto for this device)');
  for (let i = 0; i < 60; i++) ctx.tick(); ok(applied.length === 3, 'never below the device-class tier');
  // a menu / hidden tab / warm-up never counts
  ctx.GFX.runtimeTier = null; applied.length = 0; for (const s of ['menu', 'loading']) { ctx.STATE.screen = s; for (let i = 0; i < 30; i++) ctx.tick(); } ok(applied.length === 0, 'menu / loading screens: no easing');
  ctx.STATE.screen = 'surface'; ctx.document.hidden = true; for (let i = 0; i < 30; i++) ctx.tick(); ok(applied.length === 0, 'hidden tab: no easing'); ctx.document.hidden = false;
  ctx.GFX.preset = 'auto'; for (let i = 0; i < 30; i++) ctx.tick(); ok(applied.length === 0, 'Auto (already class-based + live balanced): untouched');
  ctx.GFX.preset = 'custom'; for (let i = 0; i < 30; i++) ctx.tick(); ok(applied.length === 0, 'Custom: untouched');
  const ap = cut(IDX, 'function applyPreset(name){', 'const p=PRESETS[t]');
  ok(/!_PG\.applying&&name===GFX\.preset&&GFX\.runtimeTier/.test(ap), 'a boot / re-apply of the same pick keeps the eased tier for the session');
  ok(/function applyGfxScreen\(\)\{\s*GFX\.runtimeTier=null;/.test(IDX) && /GFX\.preset=q;GFX\.runtimeTier=null;/.test(IDX), 'picking a preset (gfx screen / settings) restores the full tier');
  const save = cut(IDX, 'function saveGfxChoice(){', 'function loadGfxChoice(){');
  ok(!/runtimeTier/.test(save) && /const GFX_KNOB_KEYS=\['preset',/.test(IDX) && !/'runtimeTier'/.test(cut(IDX, 'const GFX_KNOB_KEYS=', ';')), 'saves untouched: dm_gfx_v2 stores GFX.preset (the pick), never the eased tier');
}

console.log('== 4. #256 review: no real WebGPU -> MC ladder locked');
{
  const up = cut(IDX, 'async function upgradeSurfaceMcLOD(', '// (v330 streaming)');
  ok(/if\(!_isRealWebGPU\(surfRenderer\)\)\{ TERRAIN\.mcUpgradeLocked=true; return; \}/.test(up), 'upgradeSurfaceMcLOD sets mcUpgradeLocked when the renderer is not real WebGPU');
  const go = cut(IDX, 'const _go=(n)=>{', 'setTimeout(()=>_go(0),6000);');
  ok(/TERRAIN\.mcUpgradeLocked\) return;/.test(go) && /!TERRAIN\.mcUpgradeLocked\) setTimeout/.test(go), 'the walk-patch _go loop stops once it is locked');
}

console.log('== 5. (v339) no double drop: preset steps down only once DMBudget is exhausted');
{
  const BUD = fs.readFileSync(path.join(root, 'ui/dm-budget.js'), 'utf8');
  ok(/out\.isExhausted = function \(\) \{ return !!\(out\.on && S\.C && S\.C\.exhausted\); \};/.test(BUD), 'DMBudget.isExhausted(): allocation-free read of the controller flag (stats() builds an object)');
  const src = cut(IDX, 'var _PRESET_RANK=', 'function applyPreset(name){');
  const tick = cut(src, 'function _presetGovTick(){', 'const next=');   // the every-2-s check path (up to the rare step itself)
  ok(/B\.isExhausted\(\)/.test(tick) && !/stats\(\)|\{\s*\}|\[\s*\]|new |=>|function\s*\(/.test(tick.replace('function _presetGovTick(){', '')), 'the 2 s check reads isExhausted() and allocates nothing (no stats(), no literals / closures)');
  const applied = []; let p = 0, steps = 28;
  const ctx = { GFX: { preset: 'ultra', runtimeTier: null }, STATE: { screen: 'flight' }, document: { hidden: false }, console, String,
    window: {}, applyPreset: (t) => applied.push(t), applyGraphicsLive: () => {}, autoPreset: () => 'low', toast: () => {}, setInterval: () => 0 };
  ctx.window.DMBudget = { on: true, emaMs: () => 60, budgetMs: () => 36, isExhausted: () => p >= steps };
  vm.createContext(ctx); vm.runInContext(src + ';this.tick=_presetGovTick;', ctx);
  // Watcher's case: 12 s+ of misses while the ladder is at step 7 of 28 and still shedding (one step per tick)
  p = 7; for (let i = 0; i < 21; i++) { ctx.tick(); if (p < steps) p++; }
  ok(applied.length === 0 && p === steps, 'missing 30 fps for 42 s while the ladder sheds steps 7..27: NO preset step-down (the old code stepped at 12 s)');
  // ladder now exhausted: the 12 s window starts here (time before did not count)
  for (let i = 0; i < 5; i++) ctx.tick(); ok(applied.length === 0, 'exhausted for 10 s: not yet (the miss window counts exhausted time only)');
  ctx.tick(); ok(applied.join() === 'high', 'exhausted + still missing for 12 s: one step ULTRA -> HIGH');
  // the ladder recovers a step mid-window -> the window resets
  ctx.GFX.runtimeTier = null; applied.length = 0; vm.runInContext('_PG.cool=0;_PG.over=0;', ctx);
  for (let i = 0; i < 5; i++) ctx.tick(); p = steps - 1; ctx.tick(); p = steps; for (let i = 0; i < 5; i++) ctx.tick();
  ok(applied.length === 0, 'a tick with the ladder not exhausted resets the window (5 + 5 exhausted ticks: no step)');
  ctx.tick(); ok(applied.join() === 'high', '... and 6 consecutive exhausted ticks then step');
  // no accessor (older dm-budget.js) -> never steps
  ctx.GFX.runtimeTier = null; applied.length = 0; vm.runInContext('_PG.cool=0;_PG.over=0;', ctx); delete ctx.window.DMBudget.isExhausted;
  for (let i = 0; i < 30; i++) ctx.tick(); ok(applied.length === 0, 'no isExhausted accessor: no step-down (fails safe)');
}

console.log('== 6. (v339) memCensus aborts on a world change and lets the old scene go');
{
  const job = cut(PL, 'const MEM_SLICE_MS', 'function census() {');
  let clock = 0, ricId = 0; const ricQ = new Map(), cancelled = [];
  const ctx = { performance: { now: () => clock }, document: { hidden: false }, Date, Math, Set, Map, Array, Object, String, console, JSON, PW: { active: true, gen: 1 },
    window: { cancelIdleCallback: (id) => { cancelled.push(id); ricQ.delete(id); } }, ric: (f) => { ricQ.set(++ricId, f); return ricId; } };
  const recs = []; ctx.window.__dmRec = (k) => recs.push(k);
  vm.createContext(ctx);
  vm.runInContext('let _memCache=null,_memAt=0,_memForce=false,_census=null,ended=false;' + job + ';this.memKick=memKick;this.memAbort=memAbort;this.memFinish=memFinish;this.get=()=>({c:_memCache,j:memJob,on:memSliceOn,rid:memRic});', ctx);
  // a world scene whose objects we can watch: a WeakRef-able root, scanned through a generator that holds it
  const mkScene = (nObj) => { const sc = { name: 'world', children: [] }; for (let i = 0; i < nObj; i++) { const o = { parent: sc, children: [], geometry: null }; Object.defineProperty(o, 'material', { get() { clock += 0.01; return null; }, enumerable: true }); sc.children.push(o); } return sc; };
  let scene = mkScene(2000);
  ctx.memKick([['world', scene]]);
  // two slices in, then the world closes (index.html _pwClose -> dmPerfLog.abortCensus)
  for (let k = 0; k < 2; k++) { const [id, f] = ricQ.entries().next().value; ricQ.delete(id); f({ didTimeout: false, timeRemaining: () => 12 }); }
  ok(!!ctx.get().j && ricQ.size === 1, 'scan in progress after 2 slices (one idle slice pending)');
  const pendingId = ctx.get().rid, jobRef = ctx.get().j;
  ok(ctx.memAbort('pw:close') === true, 'abortCensus(): the in-progress job is aborted');
  ok(ctx.get().j === null && ctx.get().on === false && ctx.get().rid === 0, 'job forgotten, no slice marked pending');
  ok(cancelled.includes(pendingId) && ricQ.size === 0, 'the pending idle callback is cancelled');
  ok(jobRef.it === null, 'the generator is ended and dropped (its roots / stacks / seen-sets are released)');
  ok(ctx.get().c === null && !recs.includes('perflog.memCensus'), 'no half-finished result is reported as a census');
  ok(recs.includes('perflog.memAbort'), 'the abort is logged (perflog.memAbort)');
  // GC proof: with the job aborted nothing in the perflog module references the scene
  global.__oldScene = new WeakRef(scene); scene = null;   // checked after this job ends (a WeakRef keeps its target alive until then); needs node --expose-gc
  // self-abort: the world changed while a slice was pending and nobody called abortCensus
  const sc2 = mkScene(2000); ctx.memKick([['world', sc2]]);
  { const [id, f] = ricQ.entries().next().value; ricQ.delete(id); f({ didTimeout: false, timeRemaining: () => 12 }); }
  ok(!!ctx.get().j, 'a second scan is running');
  ctx.PW.gen = 2;   // a new world was built
  { const [id, f] = ricQ.entries().next().value; ricQ.delete(id); f({ didTimeout: false, timeRemaining: () => 12 }); }
  ok(ctx.get().j === null && ricQ.size === 0 && ctx.get().c === null, 'the next slice sees the world changed and aborts by itself (no further slices)');
  ctx.PW.active = false; const sc3 = mkScene(50); ctx.memKick([['flight', sc3]]); while (ricQ.size) { const [id, f] = ricQ.entries().next().value; ricQ.delete(id); f({ didTimeout: false, timeRemaining: () => 12 }); }
  ok(!!ctx.get().c && ctx.get().c.objects === 51, 'a scan with no world change still finishes normally');
  ok(/try\{ if\(window\.dmPerfLog&&dmPerfLog\.abortCensus\) dmPerfLog\.abortCensus\('pw:close'\); \}catch\(e\)\{\}/.test(cut(IDX, 'function _pwClose(opts){', 'disposeObject3D(scene)')), '_pwClose aborts the census before the world scene is disposed');
  ok(/dmPerfLog\.abortCensus\('pw:build'\)/.test(cut(IDX, 'function _pwBuild(body,site,mode,focus){', 'const gen=++PW.gen;')), '_pwBuild aborts any census of the previous world first');
  ok(/abortCensus: \(why\) => memAbort\(why\)/.test(PL), 'window.dmPerfLog.abortCensus exported');
}

console.log('== 7. (v339) dm-governor never saves the session-eased scale under the pick');
{
  const GV = fs.readFileSync(path.join(root, 'ui/dm-governor.js'), 'utf8');
  const runGov = (runtimeTier) => {
    let clock = 0; const writes = [];
    const store = { getItem: () => null, setItem: (k, v) => writes.push([k, v]) };
    const win = { localStorage: store, devicePixelRatio: 2, innerWidth: 1200, document: { hidden: false } };
    const ctx = { window: win, performance: { now: () => clock }, Math, JSON, Date, Float32Array, console };
    vm.createContext(ctx); vm.runInContext(GV, ctx);
    const gfx = { preset: 'ultra', runtimeTier, isMobile: true };
    const r = { setPixelRatio: () => {} };
    // 40 s of slow frames (50 ms: the governor steps the scale down), then 60 s calm (12 ms) so a settled scale would be remembered
    const run = (ms, dur) => { const end = clock + dur; while (clock < end) { clock += ms; win.DMGov.frame(r, gfx, 2); } };
    run(50, 40000); run(12, 60000);
    return { writes, k: r._dr.k };
  };
  const base = runGov(null);
  ok(base.writes.length > 0 && base.writes.some(([, v]) => JSON.parse(v).key.startsWith('ultra|')), 'control: no eased tier -> the settled scale is remembered under the pick (' + base.writes.length + ' writes, k ' + base.k + ')');
  const eased = runGov('high');
  ok(eased.writes.length === 0, 'GFX.runtimeTier set (session eased below ULTRA): NOTHING written to storage (' + eased.writes.length + ' writes)');
  const same = runGov('ultra');
  ok(same.writes.length === base.writes.length, 'runtimeTier equal to the pick is not "eased": saves as before');
  ok(/function save\(gfx, k\) \{ if \(eased\(gfx\)\) return;/.test(GV), 'save() itself refuses an eased session (belt and braces for every call site)');
}

console.log('== stamps');
{
  ok(SWV >= 337, 'sw dartmeadow-engine-v' + SWV + ' (read from sw.js; CE assigns the number at merge)');
  ok(new RegExp('ui/dm-perflog\\.js\\?v=(\\d+)').test(IDX) && +IDX.match(/ui\/dm-perflog\.js\?v=(\d+)/)[1] >= 337 && +IDX.match(/ui\/dm-perflog\.js\?v=(\d+)/)[1] <= SWV, 'ui/dm-perflog.js?v= within 337..v' + SWV);
  ok(/const ATMO_DEFAULT_AGL\s*=\s*46\b/.test(IDX), 'ATMO_DEFAULT_AGL stays 46');
}
setTimeout(() => {
  if (typeof global.gc === 'function') { for (let i = 0; i < 4; i++) global.gc(); ok(global.__oldScene.deref() === undefined, '6. the aborted scan\'s old world scene is garbage-collected (node --expose-gc)'); }
  else console.log('  (run with node --expose-gc to also prove the old scene is collected)');
  console.log(fails ? 'perf-log-fixes: ' + fails + ' of ' + n + ' checks FAILED' : 'perf-log-fixes: all ' + n + ' checks passed');
  process.exit(fails ? 1 : 0);
}, 0);
