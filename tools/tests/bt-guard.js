// tools/tests/bt-guard.js — Bird Temple load / visibility guard (index.html _btLoadFailed / _btEnsure / _btGuard / _btVerify / _btArrive / _btRebuild / _btFixCull).
// Runs the REAL functions with real three.js math and fake timers:
//   load failure -> status line + breadcrumb + retry with backoff (max 3) then give up; a deliberate press restarts the budget; a stalled load times out;
//   the temple detached from the scene / hidden / unculled-with-NaN-sphere is repaired; nothing is touched far away; non-finite position respawns;
//   Quick Travel's arrival check: drawn -> quiet, never drawn -> recompile then reload, no meshes -> rebuild keeping its place; and static source checks
//   (the request is no longer buried at the end of buildSolarSystem; flight init and Quick Travel both ensure it; LOD never hides it inside BT_KEEP_R).
// three.js: THREE_CORE=/path/to/three.core.js (r185), else /workspace/three185/three.core.js or node_modules/three; SKIP (exit 0) if none.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), url = require('url');
const root = path.join(__dirname, '..', '..');
const cands = [process.env.THREE_CORE, '/workspace/three185/three.core.js', path.join(root, 'node_modules/three/build/three.core.js')].filter(Boolean);
const tp = cands.find(p => fs.existsSync(p));
if (!tp) { console.log('bt-guard: SKIP (no three.core.js; set THREE_CORE)'); process.exit(0); }
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const NAMES = ['_btCrumb', '_btSay', '_btNote', '_btProbeUrl', '_btGpuWatch', '_btSafeMaterials', '_btSwapSafe', '_btLoadFailed', '_btEnsure', '_btFixCull', '_btMeshCount', '_btProbe', '_btDist', '_btVerify', '_btGuard', '_btArrive', '_btRebuild'];

// ── static checks on the source ────────────────────────────────────────────
{
  const bss = fn('buildSolarSystem');
  ok(!/Bird Temple Interior\.glb/.test(bss), 'the GLB request is not inside buildSolarSystem any more');
  ok(/_btLoadModel\(\)/.test(bss), 'buildSolarSystem still calls the top-level loader');
  ok(/function _btLoadModel\(/.test(src) && /BT_MODEL_URL/.test(fn('_btLoadModel')) && /Bird Temple Interior\.glb/.test(src), '_btLoadModel owns the request');
  ok(/_btEnsure\('init'\)/.test(src), 'flight init ensures the temple even if buildSolarSystem threw');
  ok(/_btArrive\(\)/.test(fn('_btQtJump')) && /_btQtWaitForTemple\(\)/.test(fn('travelToBirdTemple')), 'Quick Travel arrival check + wait-for-load are wired');
  ok(/_btGuard\(\)/.test(fn('updateBirdTemple')), 'updateBirdTemple runs the guard before its early return');
  ok(/d<BT_KEEP_R\)\{ wrapper\.visible=true/.test(src), 'the LOD interval never leaves the ship hidden inside BT_KEEP_R');
  ok(/gen!==BIRD_TEMPLE\._loadGen/.test(fn('_btLoadModel')), 'a stale (timed-out) load result is dropped, never a second ship');
}

{
  ok(/uncapturederror/.test(fn('_btGpuWatch')), 'WebGPU uncaptured errors are recorded');
  ok(/HEAD/.test(fn('_btProbeUrl')) && /_btProbeUrl\(\)/.test(fn('_btLoadFailed')), 'a failed load probes the URL and reports the HTTP status');
  ok(/pushErrorScope\('validation'\)/.test(fn('_btSafeMaterials')) && /_btSafeMaterials\('arrive'\)/.test(fn('_btArrive')), 'arrival compiles the ship under a validation scope and swaps rejected materials');
  ok(/window\.btDiag=/.test(src), 'window.btDiag() exists for bug reports');
  ok(/BT_MODEL_URL/.test(fn('_btLoadModel')), 'one shared model URL');
}
(async () => {
  const THREE = await import(url.pathToFileURL(tp).href);
  function world() {
    let now = 1000; const timers = [];
    const ctx = { THREE: Object.assign({}, THREE, { MeshStandardNodeMaterial: THREE.MeshStandardMaterial }), Math, isFinite, console: { warn() { }, log() { } }, fetch: (u, o) => Promise.resolve({ status: ctx.httpStatus || 200, headers: { get: () => null } }), Promise, flightRenderer: null,  performance: { now: () => now }, window: {}, says: [], crumbs: [], loads: 0, compiled: 0, disposed: 0,
      flightScene: new THREE.Scene(), flightCamera: new THREE.PerspectiveCamera(60, 1, 0.1, 3e5), STATE: { screen: 'flight' }, SHIP_WALK: { active: false },
      setTimeout: (f, ms) => { const t = { f, at: now + (ms || 0), id: timers.length + 1 }; timers.push(t); return t.id; }, clearTimeout: id => { const t = timers.find(x => x.id === id); if (t) t.dead = true; }, clearInterval() { },
      dmAction: (a, i) => ctx.crumbs.push(a + (i ? ':' + i : '')), dmBreadcrumb: (k, w) => ctx.crumbs.push('BC:' + k + ':' + w), dmSys: (m, o) => ctx.says.push(m + '|' + ((o && o.cls) || '')),
      _dmCompileObject: () => { ctx.compiled++; }, _disposeObject3D: () => { ctx.disposed++; }, BT_CUBES: { root: null } };
    ctx.window.dmAction = ctx.dmAction; ctx.window.dmBreadcrumb = ctx.dmBreadcrumb; ctx.window.dmSys = ctx.dmSys; ctx.window.__bt = 1;
    ctx.advance = ms => { const end = now + ms; for (;;) { const nxt = timers.filter(t => !t.dead && !t.done && t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!nxt) break; now = Math.max(now, nxt.at); nxt.done = true; nxt.f(); } now = end; };
    vm.createContext(ctx);
    vm.runInContext(NAMES.map(fn).join('\n') + '\nconst BT_MODEL_URL="x.glb"; const BT_KEEP_R=20000, BT_RETRY_MAX=3, BT_RETRY_MS=[1500,4000,9000], BT_LOAD_TIMEOUT_MS=120000;\nconst BIRD_TEMPLE={group:null,spawned:false,_R0:5,_loading:false,_gaveUp:false,_retryT:0};\n' +
      'function _btLoadModel(){ loads_++; BIRD_TEMPLE._loading=true; BIRD_TEMPLE._loadT0=performance.now(); BIRD_TEMPLE._loadGen=(BIRD_TEMPLE._loadGen|0)+1; }\nlet loads_=0;\n' +
      'function _dummy(){}', ctx);
    ctx.run = c => vm.runInContext(c, ctx);
    ctx.mkTemple = (pos) => { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 10), new THREE.MeshBasicMaterial()); m.name = 'Hull'; g.add(m); g.position.copy(pos || new THREE.Vector3(100, 0, 0)); ctx.flightScene.add(g); ctx.__g = g; ctx.run('BIRD_TEMPLE.group=__g; BIRD_TEMPLE.spawned=true; BIRD_TEMPLE._loading=false'); return g; };
    return ctx;
  }

  // 1. failure -> retry with backoff, max 3, then give up; a deliberate press restarts
  {
    const c = world();
    c.run('_btEnsure("init")'); ok(c.run('loads_') === 1 && c.run('BIRD_TEMPLE._loading'), 'ensure starts exactly one load');
    c.run('_btEnsure("guard")'); ok(c.run('loads_') === 1, 'ensure is idempotent while loading');
    c.run('BIRD_TEMPLE._loading=false; _btLoadFailed("net")');
    ok(c.says.some(s => /failed to load \(net\) - retrying 1\/3/.test(s)), 'status line says it failed and is retrying');
    ok(c.crumbs.some(x => /btLoadFail/.test(x)) && c.crumbs.some(x => /^BC:bt:btLoadFail/.test(x)), 'breadcrumb + dmBreadcrumb written');
    c.advance(1000); ok(c.run('loads_') === 1, 'no retry before the backoff (1.5 s)');
    c.advance(600); ok(c.run('loads_') === 2, 'retry #1 after 1.5 s');
    c.run('BIRD_TEMPLE._loading=false; _btLoadFailed("net")'); c.advance(3900); ok(c.run('loads_') === 2, 'backoff grows (4 s)'); c.advance(200); ok(c.run('loads_') === 3, 'retry #2');
    c.run('BIRD_TEMPLE._loading=false; _btLoadFailed("net")'); c.advance(9100); ok(c.run('loads_') === 4, 'retry #3 after 9 s');
    c.run('BIRD_TEMPLE._loading=false; _btLoadFailed("net")'); ok(c.run('BIRD_TEMPLE._gaveUp') === true && c.says.some(s => /could not be loaded \(net\)/.test(s) && /err/.test(s)), 'after 3 retries it gives up, loudly');
    c.advance(60000); ok(c.run('loads_') === 4, 'no endless retry loop');
    c.run('_btEnsure("guard")'); ok(c.run('loads_') === 4, 'the guard does not restart a given-up load');
    c.run('_btEnsure("user")'); ok(c.run('loads_') === 5 && c.run('BIRD_TEMPLE._gaveUp') === false, 'a deliberate press restarts the budget');
  }
  // 2. stalled load -> watchdog
  {
    const c = world(); c.run('_btEnsure("init")'); c.advance(119000); c.run('_btGuard()'); ok(c.run('loads_') === 1 && c.run('BIRD_TEMPLE._loading'), 'still loading at 119 s');
    c.advance(3000); c.run('BIRD_TEMPLE._guardAt=0; _btGuard()'); ok(!c.run('BIRD_TEMPLE._loading') && c.says.some(s => /retrying/.test(s)), 'watchdog fails a load stalled for 120 s and retries');
    const gen = c.run('BIRD_TEMPLE._loadGen'); c.advance(2000); ok(c.run('loads_') === 2 && c.run('BIRD_TEMPLE._loadGen') === gen + 1, 'the retry bumps the load generation (late results of the old one are dropped)');
  }
  // 3. verify / repair
  {
    const c = world(); const g = c.mkTemple(new THREE.Vector3(500, 0, 0));
    c.flightScene.remove(g); g.visible = false; g.children[0].geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(NaN, 0, 0), NaN);
    const v = c.run('_btVerify("t",true)');
    ok(g.parent === c.flightScene, 'detached temple is put back in the scene'); ok(g.visible === true, 'hidden temple is made visible');
    ok(g.children[0].frustumCulled === false, 'a NaN culling sphere turns culling off for that mesh'); ok(v.meshes === 1 && v.fixed.length >= 3, 'verify reports what it fixed');
    ok(c.crumbs.some(x => /btRepair/.test(x)), 'repair leaves a breadcrumb');
    // far away and healthy: untouched
    const c2 = world(); const g2 = c2.mkTemple(new THREE.Vector3(1e5, 0, 0)); g2.visible = false;
    c2.run('BIRD_TEMPLE._guardAt=0; _btGuard()'); ok(g2.visible === false, 'guard leaves a far temple alone');
    const c3 = world(); const g3 = c3.mkTemple(new THREE.Vector3(1000, 0, 0)); g3.visible = false; c3.run('_btGuard()'); ok(g3.visible === true, 'guard re-shows a hidden temple within BT_KEEP_R');
    const c4 = world(); const g4 = c4.mkTemple(); g4.position.x = NaN; c4.run('_btVerify("t",false)'); ok(c4.run('BIRD_TEMPLE.spawned') === false, 'non-finite position -> respawn');
    const c5 = world(); const g5 = c5.mkTemple(new THREE.Vector3(30000, 0, 0)); g5.visible = false; c5.run('BIRD_TEMPLE._arriveUntil=performance.now()+5000; BIRD_TEMPLE._guardAt=0; _btGuard()'); ok(g5.visible === true, 'while arriving the guard asserts it at any distance');
  }
  // 4. arrival
  {
    // drawn: quiet
    const c = world(); const g = c.mkTemple(); c.run('_btArrive()'); c.advance(50); c.run('BIRD_TEMPLE._drawnAt=performance.now()'); c.advance(6000);
    ok(c.compiled === 0 && c.disposed === 0 && c.run('BIRD_TEMPLE.group') === g, 'drawn ship: no recompile, no rebuild');
    // never drawn: recompile at 1.5 s, reload at 4 s, keeps its place
    const c2 = world(); const g2 = c2.mkTemple(new THREE.Vector3(7, 8, 9)); c2.run('_btArrive()'); c2.advance(1000); ok(c2.compiled === 0, 'nothing yet at 1 s');
    c2.advance(700); ok(c2.compiled === 1 && c2.crumbs.some(x => /btNotDrawn:recompile/.test(x)), 'not drawn after 1.5 s -> recompile');
    c2.advance(3000); ok(c2.run('BIRD_TEMPLE.group') === null && c2.disposed === 1 && c2.run('loads_') === 1, 'not drawn after 4 s -> rebuild (old ship disposed, model requested)');
    ok(c2.says.some(s => /never drawn.*rebuilding/.test(s)), 'with a visible status line naming the problem'); ok(c2.run('BIRD_TEMPLE._restorePos').equals(new THREE.Vector3(7, 8, 9)), 'the rebuilt ship comes back where it was');
    // no meshes: immediate rebuild
    const c3 = world(); const g3 = c3.mkTemple(); g3.remove(g3.children[0]); c3.run('_btArrive()'); c3.advance(10); ok(c3.run('BIRD_TEMPLE.group') === null && c3.run('loads_') === 1, 'an empty shell is rebuilt at once');
    // rebuild budget
    const c4 = world(); for (let i = 0; i < 5; i++) { const gg = c4.mkTemple(); c4.run('BIRD_TEMPLE._loading=false; _btRebuild("x")'); } ok(c4.run('BIRD_TEMPLE._rebuilds') === 3, 'rebuild is capped at 3');
    // not in flight: no escalation
    const c5 = world(); c5.mkTemple(); c5.STATE.screen = 'menu'; c5.run('_btArrive()'); c5.advance(6000); ok(c5.compiled === 0 && c5.run('BIRD_TEMPLE.group') !== null, 'no escalation while the flight screen is not up');
    // a second Quick Travel supersedes the first one's checks
    const c6 = world(); c6.mkTemple(); c6.run('_btArrive()'); c6.advance(100); c6.run('_btArrive()'); c6.advance(100); c6.run('BIRD_TEMPLE._drawnAt=performance.now()'); c6.advance(6000); ok(c6.compiled === 0 && c6.disposed === 0, 'overlapping arrivals do not double-fire');
  }
  // 7. concrete reporting: HTTP status of the model, GPU errors, rejected materials swapped
  {
    const c = world(); c.httpStatus = 404;
    c.run('_btEnsure("init"); BIRD_TEMPLE._loading=false; _btLoadFailed("glb: fetch responded with 404")');
    await new Promise(r => setTimeout(r, 5));
    ok(c.says.some(m => /model HTTP 404/.test(m)), 'a 404 on the model is named on screen');
    ok(c.says.some(m => /failed to load \(glb: fetch responded with 404\)/.test(m)), 'the failure reason is in the retry message');
    ok(c.run('BIRD_TEMPLE._notes').some(n => n.kind === 'url' && /404/.test(n.msg)), 'notes record the probe');
  }
  {
    const c = world(); c.setTimeout = (f, ms) => setTimeout(f, 0); const g = c.mkTemple(new THREE.Vector3(500, 0, 0)); const hull = g.children[0]; const bad = hull.material;
    const good = new THREE.MeshBasicMaterial(); const m2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), good); g.add(m2);
    let scopes = 0; const dev = { pushErrorScope() { scopes++; }, popErrorScope() { const m = c.cur; return Promise.resolve(m === bad ? { message: 'Binding size exceeds maxSampledTexturesPerShaderStage' } : null); }, addEventListener(t, f) { dev.l = f; } };
    c.flightRenderer = { backend: { device: dev }, compileAsync(mesh) { c.cur = mesh.material; return Promise.resolve(); } };
    c.run('BIRD_TEMPLE.group=null'); c.mk = 1;
    vm.runInContext('BIRD_TEMPLE.group=null', c);
    c.__g = g; vm.runInContext('BIRD_TEMPLE.group=__g; BIRD_TEMPLE.spawned=true;', c);
    const n = await vm.runInContext('_btSafeMaterials("t")', c);
    ok(n === 1, 'exactly the rejected material is counted (' + n + ')');
    ok(hull.material !== bad && hull.material.userData.btSafe && m2.material === good, 'rejected material swapped for a safe one, the good one untouched');
    ok(c.says.some(m => /1 materials were rejected by the GPU \(Binding size/.test(m)), 'the GPU message is shown on screen');
    vm.runInContext('_btGpuWatch()', c); ok(typeof dev.l === 'function', 'uncapturederror listener installed');
    c.advance(7000); dev.l({ error: { message: 'Invalid ShaderModule foo' } }); ok(c.run('BIRD_TEMPLE._gpuErrs')[0] === 'Invalid ShaderModule foo' && c.says.some(m => /GPU error: Invalid ShaderModule/.test(m)), 'GPU errors recorded and shown');
  }


  console.log(fails ? 'bt-guard: FAILED ' + fails + '/' + n : 'bt-guard: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
