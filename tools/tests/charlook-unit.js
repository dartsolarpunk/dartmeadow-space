// node tools/tests/charlook-unit.js - pure logic of ui/dm-charlook.js: tier selection, normal smoothing, env derivation, material classification, matcap, and the real GLBs' seam census.
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), L = require('../../ui/dm-charlook.js');
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
// tier: URL wins, then stored, then the preset
ok(L.pickTier({ search: '?charlook=off', stored: 'high', preset: 'ultra' }) === 'off', 'url off wins');
ok(L.pickTier({ search: '?x=1&charlook=high', preset: 'low' }) === 'high', 'url high');
ok(L.pickTier({ search: '?charlook=0' }) === 'off' && L.pickTier({ search: '?charlook=1' }) === 'low', '0 / 1 aliases');
ok(L.pickTier({ stored: 'low', preset: 'ultra' }) === 'low', 'stored wins over preset');
ok(L.pickTier({ stored: 'auto', preset: 'high', pressure: 0 }) === 'high' && L.pickTier({ preset: 'ultra' }) === 'high', 'auto: high / ultra -> high');
ok(L.pickTier({ preset: 'high', pressure: 9 }) === 'low', 'auto: budget pressure -> low');
ok(L.pickTier({ preset: 'high', legacy: true }) === 'low' && L.pickTier({ preset: 'medium' }) === 'low' && L.pickTier({}) === 'low', 'auto: legacy / medium / unknown -> low');
ok(L.pickTier({ search: '?charlook=bogus', preset: 'low' }) === 'low', 'bogus url ignored');
ok(L.pickEnvKind({ search: '?charenv=matcap' }) === 'matcap' && L.pickEnvKind({ stored: 'both' }) === 'both' && L.pickEnvKind({}) === 'analytic' && L.pickEnvKind({ search: '?charenv=zz' }) === 'analytic', 'env kind');
// smoothing: two triangles sharing an edge, split normals at the seam -> averaged; a hard edge (90 deg) stays
{
  const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]);   // vertex 0 == 3 etc (same positions)
  const a = [0, 0, 1], b = [0.2588, 0, 0.9659];   // 15 deg apart: a soft seam
  const nrm = Float32Array.from([...a, ...a, ...a, ...b, ...b, ...b]);
  const r = L.smoothNormals(pos, nrm, {}); ok(r.nrm && r.groups === 3 && r.changed === 6, 'soft seam smoothed (' + r.groups + '/' + r.changed + ')');
  for (let g = 0; g < 3; g++) { const d = r.nrm[g * 3] * r.nrm[(g + 3) * 3] + r.nrm[g * 3 + 1] * r.nrm[(g + 3) * 3 + 1] + r.nrm[g * 3 + 2] * r.nrm[(g + 3) * 3 + 2]; ok(d > 0.99999, 'seam pair equal after smoothing'); ok(Math.abs(Math.hypot(r.nrm[g * 3], r.nrm[g * 3 + 1], r.nrm[g * 3 + 2]) - 1) < 1e-5, 'unit length'); }
  const hard = Float32Array.from([...a, ...a, ...a, 1, 0, 0, 1, 0, 0, 1, 0, 0]);   // 90 deg: a real edge
  const h = L.smoothNormals(pos, hard, {}); ok(h.nrm === null && h.changed === 0, 'hard edge kept (angle limit)');
  ok(L.smoothNormals(pos, Float32Array.from([...a, ...a, ...a, ...a, ...a, ...a]), {}).nrm === null, 'already smooth: untouched (null)');
  ok(L.smoothNormals(new Float32Array(0), new Float32Array(0)).nrm === null, 'empty ok');
  // the input is never mutated
  const keep = Float32Array.from(nrm); L.smoothNormals(pos, nrm, {}); ok(keep.every((v, i) => v === nrm[i]), 'input untouched');
}
// env derivation: follows the sun, dims at night, warm key / cool sky
{
  const day = L.deriveEnv({ sun: { dir: [0, 1, 0], color: [1, 0.95, 0.86], intensity: 2.6 }, hemi: { sky: [0.5, 0.6, 0.9], ground: [0.2, 0.15, 0.1], intensity: 0.4 }, amb: { color: [0.4, 0.5, 0.65], intensity: 0.5 }, day: 1 });
  const night = L.deriveEnv({ sun: { dir: [0, 1, 0], color: [1, 0.95, 0.86], intensity: 2.6 }, hemi: { sky: [0.5, 0.6, 0.9], ground: [0.2, 0.15, 0.1], intensity: 0.4 }, amb: { color: [0.4, 0.5, 0.65], intensity: 0.5 }, day: 0 });
  ok(day.key[0] > day.key[2] && day.skyTop[2] > day.skyTop[0], 'warm key, cool sky');
  ok(night.key[0] === 0 && night.skyTop[0] > 0, 'night: no key, sky stays');
  const low = L.deriveEnv({ sun: { dir: [1, 0.05, 0], color: [1, 0.95, 0.86], intensity: 2 }, day: 1 }); ok(low.key[2] / low.key[0] < day.key[2] / day.key[0], 'a low sun reddens the key');
  ok(Math.abs(Math.hypot(...day.dir) - 1) < 1e-9 && day.dir[1] === 1, 'dir normalised');
  const none = L.deriveEnv({}); ok(none.key.every(Number.isFinite) && none.skyTop.every((v) => v > 0), 'no lights -> finite, non-black sky');
  ok(L.deriveEnv({ sun: { dir: [0, 0, 0], intensity: 1 } }).dir.every(Number.isFinite), 'zero dir safe');
}
// classification
{
  ok(L.classify({ name: 'Emma_Skin' }) === 'skin' && L.classify({ name: 'Material_4.001', sheen: [1, 0.55, 0.4], metalness: 0 }) === 'skin', 'skin by name / by the GLB rose sheen');
  ok(L.classify({ name: 'Emma_Shirt' }) === 'cloth' && L.classify({ name: 'shirt' }) === 'cloth' && L.classify({ meshName: 'Pants Reach Pose.001' }) === 'cloth', 'cloth');
  ok(L.classify({ name: 'Emma_Eye_L', hasMap: true, clearcoat: 1 }) === 'eye' && L.classify({ name: 'Material_34', clearcoat: 1, hasMap: true }) === 'eye', 'eyes (clearcoat)');
  ok(L.classify({ name: 'Emma_Cornea', transparent: true, opacity: 0.06 }) === 'glass' && L.classify({ name: 'Emma_Lens', transparent: true, opacity: 0.1 }) === 'glass', 'glass');
  ok(L.classify({ name: 'Emma_BrowLash' }) === 'hair' && L.classify({ name: 'x', isHair: true }) === 'hair', 'hair / brows untouched');
  ok(L.classify({ name: 'Emma_GlassesFrame', metalness: 0.8 }) === 'metal' && L.classify({ name: 'Emma_Teeth' }) === 'other', 'metal / other');
  const lo = L.kindParams('skin', 'low'), hi = L.kindParams('skin', 'high'); ok(lo.wrap === 0 && hi.wrap === 1, 'wrap only on high skin');
  ok(L.kindParams('cloth', 'high').wrap === 0 && L.kindParams('hair', 'high').amb === 0, 'cloth no wrap, hair untouched');
  ok(L.ANISO.off === 1 && L.ANISO.low === 4 && L.ANISO.high === 8, 'anisotropy 4 / 8');
}
// matcap: finite, warm key upper-left brighter than lower-right, cool rim at the edge, deterministic bytes
{
  const E = L.deriveEnv({ sun: { dir: [0.4, 0.7, 0.5], color: [1, 0.95, 0.86], intensity: 2 }, hemi: { sky: [0.5, 0.6, 0.9], ground: [0.3, 0.2, 0.15], intensity: 0.5 } }), P = L.matcapPalette({ key: E.key, rim: E.rim, ground: E.ground, skyTop: E.skyTop, skyHor: E.skyHor });
  const a = L.matcapPixel(-0.42, 0.55, 0.72, P), b = L.matcapPixel(0.5, -0.5, 0.7, P); ok(a.every(Number.isFinite) && a[0] > b[0], 'key upper-left brighter than lower-right');
  const buf = L.matcapBytes(32, P), buf2 = L.matcapBytes(32, P); ok(buf.length === 32 * 32 * 4 && buf.every((v, i) => v === buf2[i]), 'matcap bytes deterministic');
  ok(buf.some((v) => v > 0) && buf.every((v) => v >= 0 && v <= 255), 'matcap bytes in range');
}
// the real GLBs: the census the seam fix is for (Ariel has split normals, Emma is welded)
function census(f) {
  const b = fs.readFileSync(f), jl = b.readUInt32LE(12), j = JSON.parse(b.slice(20, 20 + jl).toString()), bo = 20 + jl + 8; let tot = 0, ch = 0;
  const acc = (i) => { const a = j.accessors[i], bv = j.bufferViews[a.bufferView], c = a.type === 'VEC3' ? 3 : 2, off = bo + (bv.byteOffset || 0) + (a.byteOffset || 0), st = bv.byteStride || c * 4, o = new Float32Array(a.count * c); for (let k = 0; k < a.count; k++) for (let q = 0; q < c; q++) o[k * c + q] = b.readFloatLE(off + k * st + q * 4); return o; };
  for (const m of j.meshes) for (const p of m.primitives) { if (!p.attributes.NORMAL) continue; const pos = acc(p.attributes.POSITION); tot += pos.length / 3; if (pos.length / 3 > 90000) continue; const r = L.smoothNormals(pos, acc(p.attributes.NORMAL), {}); ch += r.changed; }
  return { tot, ch };
}
const root = path.join(__dirname, '..', '..'), A = census(path.join(root, 'characterassests/Meshy_AI_Autumn_biped_Character_output.glb'));
ok(A.ch > 1000 && A.ch < A.tot * 0.5, 'Ariel: split normals found and fixed (' + A.ch + ' of ' + A.tot + ' vertices)');
const em = path.join(root, 'characterassests/emma/Emma_Character.glb'); if (fs.existsSync(em)) { const E = census(em); ok(E.ch < E.tot * 0.01, 'Emma: already welded, nothing to do (' + E.ch + ' of ' + E.tot + ')'); }
// wiring: one script tag with a numeric tag, loaded after charpaint, applied before the light pass
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
ok(/ui\/dm-charlook\.js\?v=\d+/.test(html), 'script tag with ?v=');
ok(html.indexOf('ui/dm-charpaint.js') < html.indexOf('ui/dm-charlook.js'), 'loaded after charpaint');
ok(html.indexOf('DMCharLook.apply(CHAR.root') > 0 && html.indexOf('DMCharLook.apply(CHAR.root') < html.indexOf('DMLight.applyTree(CHAR.root'), 'applied before DMLight.applyTree');
ok(/DMCharLook\.tick\(/.test(html), 'ticked from the frame loop');
ok(/DMCharLook\.refresh/.test(fs.readFileSync(path.join(root, 'ui/dm-charpaint.js'), 'utf8')), 'charpaint re-applies the look after clones');
ok(/DMCharLook\.apply\(M\.root/.test(fs.readFileSync(path.join(root, 'ui/dm-charselect.js'), 'utf8')) && /rigStudio/.test(fs.readFileSync(path.join(root, 'ui/dm-charselect.js'), 'utf8')), 'studio applies the look + rig');
console.log('charlook-unit OK (' + n + ' checks)');
