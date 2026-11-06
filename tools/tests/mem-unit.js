// Memory lane unit test (sw v292): ui/dm-mem.js with fakes, the index.html hooks, the estimator's before/after targets, and the shrunk phone mansion GLB.
//   node tools/tests/mem-unit.js
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m); } else console.log('ok  ', m); };

// ---- fakes ----
class ImageBitmap { constructor(w, h) { this.width = w; this.height = h; this.closed = false; } close() { this.closed = true; this.width = 0; this.height = 0; } }
global.ImageBitmap = ImageBitmap;
global.window = global; global.location = { search: '' };
global.createImageBitmap = async (src, o) => new ImageBitmap(o.resizeWidth, o.resizeHeight);
const mkTex = (w, h) => { const t = { isTexture: true, image: new ImageBitmap(w, h), userData: {}, disposed: 0, version: 1, generateMipmaps: true, dispose() { this.disposed++; } }; return t; };
const mkScene = (mats) => ({ traverse(f) { f({}); for (const m of mats) f({ material: m }); } });
delete require.cache[require.resolve('../../ui/dm-mem.js')];
const M = require('../../ui/dm-mem.js');

(async () => {
  // lean()
  global.GFX = { isMobile: true }; ok(M.lean() === true, 'lean on mobile');
  global.GFX = { isMobile: false }; ok(M.lean() === false, 'not lean on desktop');
  global.location = { search: '?lean=1' }; ok(M.lean() === true, '?lean=1 forces lean');
  global.GFX = { isMobile: true }; global.location = { search: '?lean=0' }; ok(M.lean() === false, '?lean=0 forces off');
  global.location = { search: '' };

  // collectTextures: slots + TSL node values + userData.dmTex
  const a = mkTex(8, 8), b = mkTex(8, 8), c = mkTex(8, 8), d = mkTex(8, 8);
  const node = { isNode: true, value: null, getChildren() { return [{ value: c, getChildren() { return []; } }]; } };
  const m1 = { map: a, normalMap: b, colorNode: node, userData: { dmTex: [d] } };
  const set = M.collectTextures(mkScene([m1]));
  ok(set.size === 4 && [a, b, c, d].every((t) => set.has(t)), 'collectTextures finds slot, node-held and dmTex textures');

  // disposeTexturesExcept: shared textures stay
  const e = mkTex(4, 4), keepT = mkTex(4, 4), own = mkTex(4, 4); const kept = mkTex(4, 4); kept.userData.dmKeep = true;
  const n = M.disposeTexturesExcept(mkScene([{ map: own, normalMap: keepT, roughnessMap: kept }]), mkScene([{ map: keepT }]));
  ok(n === 1 && own.disposed === 1 && keepT.disposed === 0 && kept.disposed === 0, 'LOD swap: only the old level\'s own textures are disposed');

  // sweepUnused: replaced maps go, still-referenced stay
  const oldA = mkTex(4, 4), oldB = mkTex(4, 4), live = mkTex(4, 4);
  const swn = M.sweepUnused(new Set([oldA, oldB, live]), [mkScene([{ map: live }])]);
  ok(swn === 2 && oldA.disposed === 1 && oldB.disposed === 1 && live.disposed === 0 && !oldA.image.closed, 'sweepUnused disposes unreferenced candidates, leaves used ones, does not close bitmaps');

  // releaseBitmapAfterUpload: closes on onUpdate only, chains the previous handler
  const r = mkTex(16, 16); let prevCalled = 0; r.onUpdate = () => { prevCalled++; };
  ok(M.releaseBitmapAfterUpload(r) === true && !r.image.closed, 'release armed, bitmap still open before upload');
  r.onUpdate(r); ok(r.image.closed && prevCalled === 1, 'bitmap closed after the upload callback, previous onUpdate still runs');
  ok(Math.abs(r.userData.dmBytes - 16 * 16 * 4 * 4 / 3) < 1e-6, 'size kept for the perf-log census');
  ok(M.releaseBitmapAfterUpload({ isTexture: true, image: {}, userData: {} }) === false, 'non-bitmap images are left alone');

  // shrinkTexture: dispose first, new smaller bitmap, old closed, serial
  const big = mkTex(1024, 640), small = mkTex(256, 256); const oldImg = big.image;
  await M.shrinkAll([big, small], 512);
  ok(big.image.width === 512 && big.image.height === 320 && big.disposed === 1 && oldImg.closed && big.needsUpdate === true, 'shrink 1024x640 -> 512x320 (aspect kept, GPU copy disposed, old bitmap closed)');
  ok(small.image.width === 256 && small.disposed === 0, 'images already within the cap are untouched');
  ok(JSON.stringify(M.fitSize(2048, 1024, 512)) === '[512,256]' && M.fitSize(512, 512, 512) === null, 'fitSize');
  const gone = mkTex(1024, 1024); gone.image.close(); await M.shrinkTexture(gone, 512); ok(gone.disposed === 0, 'a closed bitmap is skipped without throwing');

  // park / unpark
  const R = { w: 1100, h: 592, pr: 2, calls: [], getSize(v) { v.x = this.w; v.y = this.h; return v; }, getPixelRatio() { return this.pr; }, setPixelRatio(p) { this.pr = p; this.calls.push(['pr', p]); }, setSize(w, h, st) { this.w = w; this.h = h; this.calls.push(['size', w, h, st]); } };
  global.THREE = { Vector2: function () { this.x = 0; this.y = 0; } };
  ok(M.park(R, 'gm') && M.isParked(R) && R.w === 1 && R.h === 1 && R.pr === 1, 'park shrinks the drawing buffer to 1x1');
  ok(M.park(R, 'gm') === false, 'park twice is a no-op');
  ok(M.unpark(R) && !M.isParked(R) && R.w === 1100 && R.h === 592 && R.pr === 2, 'unpark restores size and pixel ratio');
  ok(M.unpark(R) === false, 'unpark when not parked is a no-op');
  ok(M.stats().errs === 0, 'no swallowed errors in the helpers');

  // ---- source hooks ----
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const has = (re, m) => ok(re.test(idx), m);
  has(/function disposeStartBtnTurntable\(\)/, 'index: start-button turntable can be disposed');
  has(/if\(_myGen!==sgGen\) return;\s*\/\/ \(memory lane\) disposed/, 'index: turntable frame loop stops on dispose');
  has(/loader\.load\('latedecemberSG\.glb', gltf=>\{\s*if\(_myGen!==sgGen\)/, 'index: a model that arrives after dispose is dropped');
  has(/if\(!_sgResizeBound\)/, 'index: resize listener bound once');
  has(/disposeStartBtnTurntable\(\); \},name==='flight'\?4000:1500\)/, 'index: goScreen schedules the dispose when the menu is left');
  has(/DMMem\.park\(builderRenderer,'builder'\)[\s\S]{0,200}DMMem\.unpark\(builderRenderer\)/, 'index: builder renderer parked / unparked');
  has(/DMMem\.park\(gmRenderer,'gm'\)/, 'index: galaxy map renderer parked after close');
  has(/DMMem\.isParked\(gmRenderer\)\)\{ DMMem\.unpark\(gmRenderer\)/, 'index: galaxy map renderer unparked on open');
  has(/DMMem\.isParked\(r\)\) return; try\{ r\.setPixelRatio\(effectivePixelRatio\(\)\)/, 'index: resize fit() leaves a parked renderer alone');
  has(/r\.bodies>1&&window\.DMMem&&DMMem\.lean\(\)\) return \{bodies:1,cap:r\.cap\}/, 'index: lean LOD preset keeps one resident body');
  has(/_disposeObject3D\(oldG,newG\)/, 'index: LOD cross-fade disposes the old level\'s own textures');
  has(/_disposeObject3D\(F\.oldG,F\.newG\)/, 'index: animated LOD fade does too');
  has(/function disposeObject3D\(root\)\{[\s\S]{0,700}DMMem\.collectTextures\(root\)/, 'index: world close disposes node-held textures');
  has(/DMMem\.shrinkAll\(_ts,512\)/, 'index: Bird Temple GLB textures fit 512 px on handhelds');
  ok(/<script src="ui\/dm-mem\.js\?v=\d+"><\/script>/.test(idx), 'index: dm-mem.js is loaded (classic script, before the game)');
  const fac = fs.readFileSync(path.join(ROOT, 'ui/dm-facilities.js'), 'utf8');
  ok(/\(_mem8 \|\| _cq === '1k'\) && _cq !== '512'/.test(fac), 'facilities: handhelds take the 1K rock sets only with >= 8 GB');
  ok(/'ariel-home-512\.glb' : 'ariel-home\.glb'\) \+ '\?v=' \+ F\.ver \+ \(c\.isMobile\(\) \? 'm\d+' : ''\)/.test(fac), 'facilities: phone GLB has its own cache key');
  // version discipline: every ui file this lane touched is loaded with a ?v= >= the sw cache number of its change
  const swv = +(sw.match(/dartmeadow-engine-v(\d+)/) || [])[1];
  for (const f of ['dm-mem.js', 'dm-bt-pbr.js', 'dm-facilities.js', 'dm-perflog.js', 'dm-earth.js']) { const v = +((idx.match(new RegExp('ui/' + f.replace('.', '\\.') + '\\?v=(\\d+)')) || [])[1]); ok(v >= 292 && v <= swv, 'index: ' + f + ' ?v=' + v + ' <= sw v' + swv); }

  // ---- estimator targets ----
  const E = require('../mem-estimate.js'); const tot = (x) => x.totals.before.gpu + x.totals.before.cpu, tota = (x) => x.totals.after.gpu + x.totals.after.cpu;
  const red = (k) => { const x = E.estimate(E.SCENARIOS[k]); return (tot(x) - tota(x)) / tot(x); };
  for (const [k, min] of [['tablet-high', 0.25], ['tablet-fresh', 0.25], ['tablet-8gb', 0.25], ['phone-ios', 0.25]]) ok(red(k) >= min, 'estimate ' + k + ': ' + (red(k) * 100).toFixed(1) + ' % lower (target >= ' + min * 100 + ' %)');
  const dsk = E.estimate(E.SCENARIOS['desktop-high']); const dsave = tot(dsk) - tota(dsk);
  ok(dsave > -1e-9 && dsave < 20, 'desktop High: only the Earth decode scratch (' + dsave.toFixed(1) + ' MB) changes');
  const rows = (k, id) => E.estimate(E.SCENARIOS[k]).rows.find((r) => r.id === id);
  ok(rows('desktop-high', 'lod').after.gpu === rows('desktop-high', 'lod').before.gpu && rows('desktop-high', 'sg').after.gpu === rows('desktop-high', 'sg').before.gpu, 'desktop keeps both LOD bodies and the menu turntable');

  // ---- phone mansion GLB ----
  const L = require('./lib-glb-node.js'); const g = L.load(path.join(ROOT, 'assets/ariel-home/ariel-home-512.glb'));
  let meshes = 0; g.root.traverse((o) => { if (o.isMesh) meshes++; });
  const gl = require('fs').readFileSync(path.join(ROOT, 'assets/ariel-home/ariel-home-512.glb')); const jl = gl.readUInt32LE(12), J = JSON.parse(gl.slice(20, 20 + jl).toString());
  ok(meshes > 0 && J.images.length === 27 && J.textures.length >= 27, 'phone mansion GLB parses with all 27 images and ' + meshes + ' meshes');
  const Em = E.estimate(E.SCENARIOS['tablet-high']).rows.find((r) => r.id === 'man-tex'); ok(Em.after.gpu <= 37, 'phone mansion textures <= 37 MB GPU (' + Em.after.gpu.toFixed(1) + ')');

  console.log(fail ? '\n' + fail + ' FAILED' : '\nall ok'); process.exit(fail ? 1 : 0);
})();
