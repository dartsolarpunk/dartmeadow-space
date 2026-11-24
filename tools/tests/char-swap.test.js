// node tools/tests/char-swap.test.js — bugfix-1119: choosing Emma on the "Choose your pilot" screen made the game load Ariel.
// Root cause: the menu idle prep / menu prefetch preload the pilot that is selected AT THAT MOMENT (Ariel by default).  Choosing Emma afterwards only changed dm_char_v1;
// loadCharacterAssets() saw CHAR.loaded and returned the already-loaded Ariel, and the flight init / launch IIFE only called it when !CHAR.loaded.
// Runs the REAL _charResolve / _charStale / _charUnload / _charReconcile / _charDisposeTree from index.html against the REAL registry (ui/dm-chars.js) with fakes for
// the scene objects, hair, cloth, charm and flashlight; plus source checks on the wiring (loader, flight init, launch, late hair / cloth attach).
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const DMChars = require(path.join(root, 'ui', 'dm-chars.js'));
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const a = src.indexOf('let _charGen=0;'), b = src.indexOf('window._charReconcile=_charReconcile;');
if (a < 0 || b < 0) throw new Error('reconcile block not found');
const block = src.slice(a, b + 'window._charReconcile=_charReconcile;'.length);

// ── wiring (source) ──
{
  const lc = src.slice(src.indexOf('async function loadCharacterAssets()'));
  ok(/^async function loadCharacterAssets\(\)\{\s*try\{ await _charReconcile\(\); \}/.test(lc), 'loadCharacterAssets reconciles the selection before anything else');
  ok(/if\(\(!CHAR\.loaded && !CHAR\.loading\)\|\|_charStale\(\)\)\{[^}]*loadCharacterAssets\(\)/.test(src), 'flight init loads when a different pilot than the chosen one is preloaded');
  ok(/if\(!CHAR\.loaded\|\|_charStale\(\)\)\{\s*try\{ await loadCharacterAssets\(\)/.test(src), 'the launch / mount IIFE loads when the preloaded pilot is stale');
  ok(/const _myGen=_charGen;/.test(lc) && /if\(_myGen!==_charGen\) return null; return m\.attachHairStrands\(CHAR,THREE,\{isCurrent/.test(lc), 'late hair attach stands down when the pilot was dropped');
  ok(/if\(_myGen!==_charGen\) return null; return m\.attachArielCloth/.test(lc), 'late cloth attach stands down when the pilot was dropped');
  const hs = fs.readFileSync(path.join(root, 'hair_strands.js'), 'utf8');
  ok(/opts\.isCurrent && !opts\.isCurrent\(\)\) return null/.test(hs), 'attachHairStrands re-checks after its fetch');
  const cs = fs.readFileSync(path.join(root, 'ui', 'dm-charselect.js'), 'utf8');
  ok(!/reload to switch/.test(cs), 'the "reload to switch" toast is gone (the swap is automatic now)');
  ok(/DMCharm\.detach/.test(block) && /DMFlash\.detach/.test(block) && /_cloth\.detach/.test(block) && /_hair/.test(block), 'unload detaches charm, flashlight LED, cloth and hair');
  ok(/G\.detach=function/.test(fs.readFileSync(path.join(root, 'ui', 'dm-charm.js'), 'utf8')) && /F\.detach = function/.test(fs.readFileSync(path.join(root, 'ui', 'dm-flash.js'), 'utf8')), 'DMCharm.detach / DMFlash.detach exist');
}

// ── behaviour ──
function node(name) { const o = { name, parent: null, kids: [], geometry: null, material: null, disposed: 0,
  add(c) { c.parent = o; o.kids.push(c); return o; }, remove(c) { const i = o.kids.indexOf(c); if (i >= 0) o.kids.splice(i, 1); c.parent = null; },
  traverse(f) { f(o); o.kids.forEach((k) => k.traverse(f)); } }; return o; }
async function scenario(label, setup) {
  const calls = { hair: 0, cloth: 0, charm: 0, flash: 0, geo: 0, mat: 0, tex: 0, stop: 0, uncache: 0 };
  const store = {}; DMChars._reset({ getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } });
  const rootNode = node('arielRoot'), scene = node('scene'); scene.add(rootNode);
  const mesh = node('Body'); mesh.geometry = { dispose() { calls.geo++; } }; const tex = { isTexture: true, dispose() { calls.tex++; } }; mesh.material = { map: tex, dispose() { calls.mat++; } }; rootNode.add(mesh);
  const hair = { dispose() { calls.hair++; } }, cloth = { detach() { calls.cloth++; } };
  const ctx = { console, DMCharm: { detach() { calls.charm++; } }, DMFlash: { detach() { calls.flash++; } }, DMChars, DART_HAIR: hair, setTimeout, Promise };
  ctx.window = ctx;   // the page's global object: window.X === X
  vm.createContext(ctx);
  vm.runInContext(`
    const CHAR = { loaded:false, loading:false, root:null, skeleton:null, bones:{}, mixer:null, clips:{}, actions:{}, state:'idle', mounted:false, scene:null, _transitioning:false };
    let _charSel=null;
    ${fn('_charResolve')}
    ${block}
    ${fn('_charStale')}
    this.CHAR = CHAR; this.api = { _charResolve, _charStale, _charUnload, _charReconcile, gen: () => _charGen };
  `, ctx);
  const CHAR = ctx.CHAR;
  // an Ariel preloaded by the menu idle prep: root, bones, clips, hair, cloth, and the runtime caches the loader / pose code add
  Object.assign(CHAR, { loaded: true, loading: false, charId: 'ariel', root: rootNode, bones: { Hips: node('Hips') }, clips: { walk: {} }, actions: { walk: {} }, skinnedMesh: mesh,
    mixer: { stopAllAction() { calls.stop++; }, uncacheRoot() { calls.uncache++; } }, _hair: hair, _cloth: cloth, _xfTwin: {}, _gnMemo: 1, _menuPrep: true, restPose: { Hips: 1 }, scaleForBoard: 0.3, rawHeight: 1.7 });
  if (setup) setup(CHAR, ctx, store);
  return { ctx, CHAR, calls, store, scene, rootNode };
}

(async () => {
  // 1. the reported bug: Ariel preloaded, Emma chosen afterwards
  {
    const S = await scenario('swap'); const { ctx, CHAR, calls } = S;
    ok(!ctx.api._charStale(), 'same pilot (Ariel chosen, Ariel loaded) is not stale');
    DMChars.setSelected('emma');
    ok(ctx.api._charStale() === true, 'Emma chosen after an Ariel preload -> stale');
    const g0 = ctx.api.gen(); const r = await ctx.api._charReconcile();
    ok(r === true && ctx.api.gen() === g0 + 1, 'reconcile drops the preloaded pilot (generation bumped)');
    ok(CHAR.root === null && CHAR.loaded === false && CHAR.loading === false && !CHAR.charId, 'CHAR is back to its pristine state (no root, not loaded, no charId)');
    ok(Object.keys(CHAR.bones).length === 0 && Object.keys(CHAR.clips).length === 0 && Object.keys(CHAR.actions).length === 0, 'bones / clips / actions emptied (fresh objects, not Ariel\'s)');
    ok(!('_xfTwin' in CHAR) && !('_gnMemo' in CHAR) && !('_menuPrep' in CHAR) && !('restPose' in CHAR) && !('skinnedMesh' in CHAR), 'runtime caches added by the loader / pose code are gone');
    ok(calls.hair === 1 && calls.cloth === 1 && calls.charm === 1 && calls.flash === 1 && calls.stop === 1 && calls.uncache === 1, 'hair, cloth, necklace+charm, glasses LED and the mixer were all released once');
    ok(calls.geo === 1 && calls.mat === 1 && calls.tex === 1, 'geometry, material and textures of the old pilot disposed');
    ok(S.rootNode.parent === null && S.scene.kids.length === 0, 'the old root left the scene');
    ok(ctx.DART_HAIR === null, 'window.DART_HAIR no longer points at the dropped hair');
    const rr = ctx.api._charResolve(); ok(rr && rr.id === 'emma' && !rr.fellBack, 'the next load resolves to Emma (no fall-back)');
    ok(rr.def.mesh === 'characterassests/emma/Emma_Character.glb' && rr.def.anims === 'characterassests/emma/Emma_Merged_Animations.glb', 'with her registry paths (configurable from ui/dm-chars.js)');
    ok(rr.def.accessories.necklace === false && rr.def.accessories.glassesLed === true && rr.def.accessories.cloth === false, 'and her accessories flags (glasses flashlight on; Ariel-only necklace / cloth skipped)');
    ok(await ctx.api._charReconcile() === false, 'a second reconcile is a no-op');
  }
  // 2. same pilot -> nothing is touched
  {
    const S = await scenario('same'); const r = await S.ctx.api._charReconcile();
    ok(r === false && S.CHAR.loaded && S.CHAR.root === S.rootNode && S.calls.hair === 0 && S.calls.geo === 0, 'Ariel chosen + Ariel loaded: untouched');
  }
  // 3. a load of the OTHER pilot still in flight: it is awaited, then dropped
  {
    let release; const pending = new Promise((res) => { release = res; });
    const S = await scenario('inflight', (CHAR) => { CHAR.loaded = false; CHAR.loading = true; CHAR._loadPromise = pending; });
    DMChars.setSelected('emma');
    let done = false; const p = S.ctx.api._charReconcile().then((v) => { done = true; return v; });
    await new Promise((r) => setTimeout(r, 10)); ok(!done && S.CHAR.root === S.rootNode, 'an in-flight load is not cut off; reconcile waits');
    release(); ok(await p === true && S.CHAR.root === null, 'once it landed it is dropped and CHAR is clean');
  }
  // 4. two callers at once (menu prep + launch): one unload
  {
    const S = await scenario('concurrent'); DMChars.setSelected('emma');
    const [x, y] = await Promise.all([S.ctx.api._charReconcile(), S.ctx.api._charReconcile()]);
    ok(S.calls.hair === 1 && S.calls.geo === 1 && (x !== y), 'concurrent reconciles unload exactly once');
  }
  // 5. picks that fall back: the not-ready entry resolves to Ariel, so an Ariel preload is NOT stale
  {
    DMChars.register(Object.assign({}, DMChars.get('emma'), { id: 'zed', name: 'Zed', ready: false }));
    const S = await scenario('fallback'); DMChars.setSelected('zed');
    ok(S.ctx.api._charStale() === false, 'a not-ready pick falls back to Ariel: the Ariel preload stays');
    DMChars.unregister('zed');
  }
  // 6. Emma preloaded, Ariel chosen later: the swap works both ways
  {
    const S = await scenario('back', (CHAR) => { CHAR.charId = 'emma'; });
    DMChars.setSelected('ariel'); ok(S.ctx.api._charStale() === true && await S.ctx.api._charReconcile() === true, 'Emma -> Ariel is dropped too');
  }
  console.log(fails ? 'char-swap: ' + fails + ' FAILED of ' + n : 'char-swap: all ' + n + ' passed'); process.exit(fails ? 1 : 0);
})();
