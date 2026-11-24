// node tools/tests/t1644-track1.js — Track 1 (CE-6) pins: one resolution authority + Native / Sharp, stability gates, orbit line rings, the temple's full-quality textures.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const IDX = R('index.html');
const cut = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('anchor ' + a); return s.slice(i, j); };

// 1. effectivePixelRatio: Native / Sharp = min(dpr,2) x scale, no MP cap; Low held >= 0.85; MP cap desktop-only with Sharp off
{
  const src = cut(IDX, 'const _PX_MP=', 'window.effectivePixelRatio=effectivePixelRatio;');
  const mk = (gfx, w, h, preset) => { const ctx = { GFX: gfx, window: { innerWidth: w, innerHeight: h }, Math, resolvePreset: () => preset || gfx.preset }; vm.createContext(ctx); vm.runInContext(src + ';this.f=effectivePixelRatio;', ctx); return ctx.f(); };
  const tab = { dpr: 2, maxPixelRatio: 2, resScale: 0.7, preset: 'low', isMobile: true, sharp: true };
  ok(Math.abs(mk(tab, 1600, 2560) - 2 * 0.85) < 1e-9, 'Sharp, 3K tablet on Low: 2 x 0.85 (no 2 MP squeeze, scale held at 0.85)');
  ok(Math.abs(mk(Object.assign({}, tab, { preset: 'high', resScale: 1 }), 1600, 2560) - 2) < 1e-9, 'Sharp, tablet on High: native 2.0');
  ok(Math.abs(mk(Object.assign({}, tab, { sharp: false }), 1600, 2560) - 2 * 0.7) < 1e-9, 'Sharp OFF, tablet: no MP cap on a handheld (2 x 0.7)');
  const desk = { dpr: 2, maxPixelRatio: 2, resScale: 1, preset: 'medium', isMobile: false, sharp: false };
  ok(mk(desk, 3840, 2160) < 1, 'Sharp OFF, 4K desktop: the MP budget still applies (desktop only)');
  ok(Math.abs(mk(Object.assign({}, desk, { sharp: true }), 3840, 2160) - 2) < 1e-9, 'Sharp ON, 4K desktop: native');
  ok(Math.abs(mk(Object.assign({}, desk, { sharp: true, preset: 'custom', resScale: 0.65 }), 1280, 800, 'custom') - 1.3) < 1e-9, 'Custom keeps the player\'s own scale');
  ok(/sharp:true,/.test(IDX) && /'dynamicRes','sharp'\]/.test(IDX) && /id="set-sharp"/.test(IDX), 'GFX.sharp default ON, persisted, Settings toggle');
}
// 2. governor floors
{
  const G = {}; const root = { screen: { width: 1600, height: 2560 }, localStorage: { getItem: () => null, setItem() {} }, devicePixelRatio: 2, innerWidth: 1600, resolvePreset: () => 'medium' };
  const src = R('ui/dm-governor.js'); const ctx = { window: root, globalThis: root, performance: { now: () => 0 }, Math, JSON, Date, String, Float32Array, console }; root.window = root;
  vm.createContext(ctx); vm.runInContext(src, ctx); const D = root.DMGov;
  ok(D && typeof D.minFloor === 'function', 'DMGov.minFloor exported');
  ok(D.minFloor({ isMobile: true }) === 0.85, 'tablet floor 0.85');
  ok(D.minFloor({ isMobile: true, sharp: true }) === 0.9, 'Sharp floor 0.9');
  ok(D.minFloor({ isMobile: true, sharp: true, runtimeTier: 'low' }) === 0.85, 'Sharp floor on Low 0.85');
  root.screen = { width: 390, height: 844 }; ok(D.minFloor({ isMobile: true }) === 0, 'phone without Sharp: unchanged (0)');
  ok(/&& !sharp\(gfx\)\) \{ floor = Math\.min\(floor, 0\.42\)/.test(src), 'no 0.42 slide-show floor under Sharp');
}
// 3. budget ladder never writes the pixel ratio by default
ok(/if \(!RES_ENF\) return;/.test(R('ui/dm-budget.js')), 'budget enforceRes: advisory only (?resenf=1 A/B)');
// 4. stability gates
ok(/on:\/\[\?&\]lod=1\\b\/\.test\(location\.search\)\}/.test(IDX), 'sparse-brick LOD opt-in ?lod=1');
ok(/W\.GFX && W\.GFX\.isMobile && !\/\[\?&\]gpufluid=1/.test(R('ui/dm-fluid-core.js')), 'GPU fluid off on handhelds unless ?gpufluid=1');
ok(/forceWebGL:_dmForceGL\(\)/.test(IDX) && /GFX\.isIOS&&_isRealWebGPU\(flightRenderer\)[^\n]*dm_forceGL/.test(IDX), 'iOS: WebGL2 backend after a WebGPU device loss');
// 5. temple: no shrink / close by default; bt-irr / bt-ao full res + full strength on every tier
ok(/if\(\/\[\?&\]btshrink=1\\b\/\.test\(location\.search\)&&window\.DMMem&&DMMem\.lean\(\)\)/.test(IDX) && /dmKeepFull=true/.test(IDX), 'temple textures never shrunk / closed (opt-in A/B only), marked dmKeepFull');
{ const b = R('ui/dm-bt-bake.js'); ok(/bakehalf=1\\b\/\.test\(location\.search\) && tier\(\) < 2/.test(b) && /const lmI = 1 \* meta\.scale, aoI = 1;/.test(b) && !/\[0\.6, 0\.85, 1, 1\]/.test(b), 'bt-irr / bt-ao full quality on all devices'); }
ok(/setTimeout\(\(\) => \{ try \{ const f = DMMem\.sweepUnused/.test(R('ui/dm-bt-pbr.js')), 'bt-pbr: replaced GLB maps swept 3 s later, not under a live bind group');
// 6. orbit rings: line loops, no torus tubes
ok(/function _orbitRingLine\(r,color,opacity\)/.test(IDX) && (IDX.match(/_orbitRingLine\(/g) || []).length === 3 && !/TorusGeometry\(p\.oR,/.test(IDX) && !/TorusGeometry\(oR,\.035,3/.test(IDX), 'orbit rings are crisp LineLoops (Sol + procedural)');
// 7. createBuffer OOM guard: a mapped create that throws is served unmapped + writeBuffer
{
  const D = require('../../ui/dm-gpu-defer.js'); const writes = []; let calls = 0;
  const dev = { queue: { onSubmittedWorkDone: () => Promise.resolve(), writeBuffer: (b, o, d) => writes.push([o, d.byteLength]) },
    createBuffer(desc) { calls++; if (desc.mappedAtCreation) { const e = new RangeError('Failed to allocate'); throw e; } return { desc, destroy() {} }; } };
  const be = { device: dev, attributeUtils: { destroyAttribute() {} }, get: () => ({}), delete() {} };
  const api = D.install({ backend: be, _bindings: null }, {});
  const b = dev.createBuffer({ size: 16, usage: 0x20, mappedAtCreation: true }); const ab = b.getMappedRange(); new Uint8Array(ab)[0] = 7; b.unmap();
  ok(b.desc && b.desc.mappedAtCreation === false && (b.desc.usage & 0x8) && writes.length === 1 && writes[0][1] === 16 && api.stats.oomShadow === 1, 'OOM on mappedAtCreation -> valid unmapped buffer + writeBuffer upload');
  api.uninstall(); ok(!dev.__dmCB, 'uninstall restores createBuffer');
}
// 8. untouched: build stamp, ATMO
ok(/window\.DM_BUILD='v371'/.test(IDX) || /DM_BUILD\s*=\s*'v371'/.test(IDX), 'DM_BUILD untouched (v371)');
console.log(fails ? 't1644-track1: ' + fails + ' FAILED of ' + n : 't1644-track1: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
