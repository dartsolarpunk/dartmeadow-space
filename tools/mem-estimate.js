#!/usr/bin/env node
/* Static renderer-memory estimate (memory lane, sw v292).  No browser: every number comes from constructor arguments in the sources
 * (index.html / ui/*.js, matched by regex so a moved or renamed allocation fails tools/tests/mem-unit.js) and from the shipped assets
 * (GLB accessors and image headers).  It answers "what does this device hold in steady state, before and after the memory lane".
 *
 *   node tools/mem-estimate.js                    table for the tablet / phone / desktop scenarios
 *   node tools/mem-estimate.js --json             machine-readable
 *   const { estimate, SCENARIOS } = require('./mem-estimate.js')
 *
 * Model (per allocation, MB = 2^20):
 *   gpu  = bytes the renderer holds on the device (textures with a 4/3 mip chain, storage vec3 padded to vec4, MSAA colour + depth + resolve)
 *   cpu  = bytes the page process keeps in typed arrays / decoded bitmaps next to it (three keeps every uploaded geometry array; ImageBitmaps live until closed)
 * Phones/tablets have unified memory, so gpu + cpu is what the OS charges the tab.  "before" = origin/main at sw v294, "after" = this lane.
 * NOT modelled (same before/after): JS heap, DOM, WASM, audio elements, driver overhead, the flight canvas swap chain.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MB = 1048576;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------- asset readers ---------- */
function imgDims(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    const t = buf.slice(12, 16).toString();
    if (t === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    if (t === 'VP8L') { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
    return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) { let i = 2; while (i < buf.length) { if (buf[i] !== 0xff) { i++; continue; } const m = buf[i + 1]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]; i += 2 + buf.readUInt16BE(i + 2); } }
  return [0, 0];
}
function fileDims(f) { const b = fs.readFileSync(path.join(ROOT, f)); return imgDims(b.slice(0, 64)); }
const glbCache = {};
function glb(f) {
  if (glbCache[f]) return glbCache[f];
  const b = fs.readFileSync(path.join(ROOT, f)), jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), bo = 20 + jl + 8;
  const CS = { 5126: 4, 5123: 2, 5125: 4, 5121: 1, 5120: 1, 5122: 2 }, NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  let geo = 0, verts = 0;
  for (const m of J.meshes || []) for (const p of m.primitives) {
    for (const i of Object.values(p.attributes).concat(p.indices != null ? [p.indices] : [])) { const a = J.accessors[i]; geo += a.count * NC[a.type] * CS[a.componentType]; }
    verts += J.accessors[p.attributes.POSITION].count;
  }
  const imgs = (J.images || []).map((im, i) => {
    if (im.bufferView == null) return { w: 0, h: 0, ext: im.uri };
    const bv = J.bufferViews[im.bufferView], d = imgDims(b.slice(bo + (bv.byteOffset || 0), bo + (bv.byteOffset || 0) + 64));
    return { w: d[0], h: d[1] };
  });
  // which materials use each image (interior = BTI_*)
  const use = {}; (J.materials || []).forEach((m) => { const p = m.pbrMetallicRoughness || {}; [p.baseColorTexture, p.metallicRoughnessTexture, m.normalTexture, m.emissiveTexture, m.occlusionTexture].forEach((t) => { if (t) (use[J.textures[t.index].source] = use[J.textures[t.index].source] || new Set()).add(m.name || ''); }); });
  return (glbCache[f] = { geo, verts, imgs, use, materials: J.materials || [] });
}
const mipped = (w, h) => w * h * 4 * 4 / 3, flat = (w, h) => w * h * 4;
const fit = (w, h, m) => { const k = Math.max(w, h) > m ? m / Math.max(w, h) : 1; return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]; };

/* ---------- constants matched out of the sources (an anchor that stops matching throws) ---------- */
function grab(file, re, what) { const m = read(file).match(re); if (!m) throw new Error('mem-estimate: anchor not found: ' + what + ' in ' + file); return m; }
function lodPreset(preset) {
  const m = grab('index.html', /const SV_LOD_PRESET=\{low:\{bodies:(\d+),cap:(\d+)\},medium:\{bodies:(\d+),cap:(\d+)\},high:\{bodies:(\d+),cap:(\d+)\},ultra:\{bodies:(\d+),cap:(\d+)\}\}/, 'SV_LOD_PRESET');
  const i = { low: 1, medium: 3, high: 5, ultra: 7 }[preset]; return { bodies: +m[i], cap: +m[i + 1] };
}
function lodGeometry() {
  const B = +grab('index.html', /const SV_LOD=\{B:(\d+),DMAX:(\d+)/, 'SV_LOD')[1];
  grab('index.html', /const VPS=C3\*15\+FC\*12/, 'VPS = C3*15+FC*12'); grab('index.html', /FC=6\*B\*B/, 'FC');
  const C3 = B * B * B, FC = 6 * B * B, BP = B + 1;
  return { B, VPS: C3 * 15 + FC * 12, P3: BP * BP * BP };
}
function pxMp(preset) { const m = grab('index.html', /const _PX_MP=\{([^}]+)\}/, '_PX_MP')[1]; const mm = m.match(new RegExp(preset + ':([\\d.]+)')); return mm ? +mm[1] : 3.6; }
function shadowCap(isMobile) { grab('index.html', /if\(GFX\.isMobile&&GFX\.shadowSize>2048\)GFX\.shadowSize=2048/, 'mobile shadow cap'); return isMobile ? 2048 : 4096; }

/* ---------- scenarios ---------- */
const SCENARIOS = {
  'tablet-high': { label: 'Galaxy Tab (Mali-G615, 4 GB class), High preset, Solenne flight', lean: true, preset: 'high', dpr: 2, vw: 1280, vh: 800, deviceMemory: 4, ios: false, mansion: true, visitedMap: true, visitedBuilder: true },
  'tablet-fresh': { label: 'Galaxy Tab High, Solenne flight, galaxy map and builder never opened (conservative)', lean: true, preset: 'high', dpr: 2, vw: 1280, vh: 800, deviceMemory: 4, ios: false, mansion: true, visitedMap: false, visitedBuilder: false },
  'tablet-8gb': { label: 'Same tablet reporting deviceMemory 8 (keeps the 1K rock sets)', lean: true, preset: 'high', dpr: 2, vw: 1280, vh: 800, deviceMemory: 8, ios: false, mansion: true, visitedMap: true, visitedBuilder: true },
  'phone-ios': { label: 'iPhone 16e (Safari), Medium preset, Solenne flight', lean: true, preset: 'medium', dpr: 3, vw: 390, vh: 844, deviceMemory: 0, ios: true, mansion: true, visitedMap: true, visitedBuilder: false },
  'desktop-high': { label: 'Desktop High (must not change)', lean: false, preset: 'high', dpr: 1, vw: 1920, vh: 1080, deviceMemory: 8, ios: false, mansion: true, visitedMap: true, visitedBuilder: true },
};

function estimate(sc) {
  const rows = [], add = (id, what, src, b, a, note) => rows.push({ id, what, src, before: { gpu: b[0] / MB, cpu: b[1] / MB }, after: { gpu: a[0] / MB, cpu: a[1] / MB }, note: note || '' });
  const lean = sc.lean;

  // 1. start-button turntable: second WebGPU device + latedecemberSG.glb (everything stays after "START")
  { const g = glb('latedecemberSG.glb'), tex = g.imgs.reduce((s, i) => s + mipped(i.w, i.h), 0), bmp = g.imgs.reduce((s, i) => s + flat(i.w, i.h), 0);
    grab('index.html', /function disposeStartBtnTurntable\(\)/, 'disposeStartBtnTurntable'); grab('index.html', /sgRenderer=new THREE\.WebGPURenderer\(\{antialias:true/, 'sg renderer');
    const dev = 24 * MB;   // second device, 140 px MSAA canvas, PMREM environment, pipelines: a flat allowance (not measured)
    add('sg', 'Start-button turntable (2nd WebGPU device, latedecemberSG.glb 2.4 M verts)', 'index.html initStartBtnTurntable', [g.geo + tex + dev, g.geo + bmp], lean ? [0, 0] : [g.geo + tex + dev, g.geo + bmp], 'disposed 4 s after the game starts (lean), rebuilt with the menu'); }

  // 2. sparse-voxel LOD brick pools
  { const P = lodPreset(sc.preset), G = lodGeometry();
    const per = (bodies, cap) => { const v = cap * G.VPS;   // gpu, cpu: three keeps the vec4-padded array of every storage buffer
      return [bodies * (v * 3 * 16 + cap * G.P3 * 4), bodies * (v * 3 * 16)]; };
    grab('index.html', /function _svLodPreset\(\)\{[^\n]*r\.bodies>1&&window\.DMMem&&DMMem\.lean\(\)\) return \{bodies:1,cap:r\.cap\}/, 'lean LOD preset');
    add('lod', 'Sparse-voxel LOD brick pools (' + P.bodies + ' x cap ' + P.cap + ' x ' + G.VPS + ' verts x 3 vec3->vec4 buffers)', 'index.html _svLodPlanetMesh', per(P.bodies, P.cap), lean ? per(1, P.cap) : per(P.bodies, P.cap), 'resident bodies 2 -> 1 on handhelds at High (cap kept)'); }

  // 3. Bird Temple Interior GLB
  { const f = 'Bird Temple Interior.glb', g = glb(f), geo = g.geo;
    add('bt-geo', 'Bird Temple Interior geometry (' + (g.verts / 1e6).toFixed(2) + ' M verts incl. tangents)', f, [geo, geo], [geo, geo], 'unchanged: collision + shaders read it');
    const tex = g.imgs.reduce((s, i) => s + mipped(i.w, i.h), 0), bmp = g.imgs.reduce((s, i) => s + flat(i.w, i.h), 0);
    const tex5 = g.imgs.reduce((s, i) => { const [w, h] = fit(i.w, i.h, 512); return s + mipped(w, h); }, 0);
    grab('index.html', /DMMem\.shrinkAll\(_ts,512\)/, 'BT shrinkAll'); grab('index.html', /DMMem\.releaseBitmapAfterUpload\(x\)/, 'BT releaseBitmapAfterUpload');
    add('bt-tex', 'Bird Temple Interior GLB textures (' + g.imgs.length + ' images, all BTI_ interior)', f, [tex, bmp], lean ? [tex5, 0] : [tex, bmp], '512 px fit + decoded bitmaps closed after upload; assumes they were uploaded'); }
  { const dims = [].concat(...['altar', 'hull', 'temple', 'trim'].map((s) => ['color', 'nrm', 'orm'].map((c) => fileDims('assets/bt-pbr/' + s + '-' + c + '-1k.webp'))));
    const b = dims.reduce((s, d) => s + mipped(d[0], d[1]), 0);
    add('bt-pbr', 'Bird Temple layered PBR sets (4 x colour/nrm/orm 1K, phones are always 1K)', 'ui/dm-bt-pbr.js', [b, 0], [b, 0], 'unchanged'); }

  // 4. Ariel's mansion (surface walk scene)
  if (sc.mansion) {
    const mob = lean, f = mob ? 'assets/ariel-home/ariel-home-512.glb' : 'assets/ariel-home/ariel-home.glb', g = glb(f), geo = g.geo;
    // before: the phone GLB carried fifteen 1024 px images; recomputed from the unshrunk size list recorded in tools/ariel-home/shrink_glb_textures.py's docstring
    const nowTex = g.imgs.reduce((s, i) => s + mipped(i.w, i.h), 0), nowBmp = g.imgs.reduce((s, i) => s + flat(i.w, i.h), 0);
    const was = mob ? g.imgs.map((i, k) => (k < 9 || (k >= 12 && k < 18)) ? { w: 1024, h: 1024 } : i) : g.imgs;
    const wasTex = was.reduce((s, i) => s + mipped(i.w, i.h), 0), wasBmp = was.reduce((s, i) => s + flat(i.w, i.h), 0);
    add('man-geo', 'Mansion geometry (' + path.basename(f) + ')', f, [geo, geo], [geo, geo], 'unchanged');
    add('man-tex', 'Mansion GLB textures (' + g.imgs.length + ' images)', f, [wasTex, wasBmp], [nowTex, nowBmp], mob ? 'phone GLB re-encoded at true 512 px (tools/ariel-home/shrink_glb_textures.py)' : 'desktop keeps its 1K set');
    // cliff rock sets
    const cdim = (r) => fileDims('assets/ariel-home/cliff/strata-color-' + r + '.webp');
    const set = (r) => ['color', 'nrm', 'orm', 'height'].reduce((s, m) => s + mipped(...fileDims('assets/ariel-home/cliff/strata-' + m + '-' + r + '.webp')), 0) * 4;   // 4 sets of equal size
    const mem8 = sc.deviceMemory >= 8, beforeRes = mob ? ((!sc.ios) ? '1k' : '512') : '2k', afterRes = mob ? ((!sc.ios && mem8) ? '1k' : '512') : '2k';
    grab('ui/dm-facilities.js', /\(_mem8 \|\| _cq === '1k'\) && _cq !== '512'/, 'cliff 1k gate');
    add('cliff', 'Cliff rock sets (4 x colour/nrm/orm/height) at ' + beforeRes + ' -> ' + afterRes, 'ui/dm-facilities.js upgradeCliff', [set(beforeRes), 0], [set(afterRes), 0], mob ? 'handhelds keep the 512 set unless the browser reports >= 8 GB' : 'desktop 2K unchanged');
  }

  // 5. shadow maps (unchanged, listed for completeness): sun + the character's light, depth32
  { const sz = Math.min({ low: 512, medium: 1024, high: 2048, ultra: 4096 }[sc.preset], shadowCap(lean)); const b = 2 * sz * sz * 4;
    add('shadow', 'Shadow maps (sun + character light, ' + sz + ' px depth32)', 'index.html', [b, 0], [b, 0], 'unchanged (the budget ladder halves the sun map under pressure)'); }

  // 6. flight drawing buffer + atmosphere pass at the effective pixel ratio
  { const mp = Math.min(pxMp(sc.preset) * 1e6, sc.vw * sc.vh * sc.dpr * sc.dpr), px = mp;   // effectivePixelRatio caps the pixel count at _PX_MP
    const canvas = px * (4 + 4), post = px * (8 + 4);   // swap chain colour + depth32 | pass() HalfFloat colour + depth
    add('canvas', 'Flight canvas + atmosphere pass (' + (px / 1e6).toFixed(1) + ' Mpx)', 'index.html effectivePixelRatio', [canvas + post, 0], [canvas + post, 0], 'unchanged'); }

  // 7. secondary renderers (MSAA 4x colour + depth + resolve), only if the screen was opened in this session
  { const gmW = Math.min(sc.vw * 0.92, 1100), gmH = Math.min(sc.vh * 0.74, 640), pr = Math.min(sc.dpr, 2), px = gmW * gmH * pr * pr, b = px * (4 * (4 + 4) + 4);
    grab('index.html', /gmRenderer=new THREE\.WebGPURenderer\(\{canvas:cv,antialias:true/, 'gm renderer'); grab('index.html', /DMMem\.park\(gmRenderer,'gm'\)/, 'gm park');
    add('gm', 'Galaxy map drawing buffer (' + gmW.toFixed(0) + 'x' + gmH.toFixed(0) + ' css @' + pr + 'x, 4x MSAA)', 'index.html initGalaxyMapScene', sc.visitedMap ? [b, 0] : [0, 0], sc.visitedMap && !lean ? [b, 0] : [0, 0], 'parked to 1x1 15 s after the map closes'); }
  { const bw = sc.vw - 300, bh = sc.vh, pr = Math.min(sc.dpr, 2), px = bw * bh * pr * pr, b = px * (4 * (4 + 4) + 4);
    grab('index.html', /builderRenderer=new THREE\.WebGPURenderer\(\{canvas:cv,antialias:true/, 'builder renderer'); grab('index.html', /DMMem\.park\(builderRenderer,'builder'\)/, 'builder park');
    add('builder', 'Board-builder drawing buffer (' + bw + 'x' + bh + ' css @' + pr + 'x, 4x MSAA)', 'index.html initBuilderScene', sc.visitedBuilder ? [b, 0] : [0, 0], sc.visitedBuilder && !lean ? [b, 0] : [0, 0], 'parked to 1x1 when the screen is left'); }

  // 8. the character (kept)
  { const g = glb('characterassests/Meshy_AI_Autumn_biped_Character_output.glb'); const t = g.imgs.reduce((s, i) => s + mipped(i.w, i.h), 0);
    add('char', 'Character (Autumn) geometry + textures', 'characterassests/', [g.geo + t, g.geo], [g.geo + t, g.geo], 'unchanged'); }

  // 9. Earth maps
  { grab('ui/dm-earth.js', /src\.close\(\)/, 'earth bitmap close'); const w = 2048, h = 1024;
    add('earth', 'Earth relief decode (bitmap + scratch canvas, 2048x1024)', 'ui/dm-earth.js', [0, w * h * 4 * 2], [0, 0], 'closed after the heights are copied out'); }

  const sum = (k, p) => rows.reduce((s, r) => s + r[k][p], 0);
  return { scenario: sc, rows, totals: { before: { gpu: sum('before', 'gpu'), cpu: sum('before', 'cpu') }, after: { gpu: sum('after', 'gpu'), cpu: sum('after', 'cpu') } } };
}

function table(name, E) {
  const f = (x) => x.toFixed(1).padStart(7), tb = E.totals.before, ta = E.totals.after, bt = tb.gpu + tb.cpu, at = ta.gpu + ta.cpu;
  const L = ['', '== ' + name + ': ' + E.scenario.label, ' ' + 'allocation'.padEnd(78) + ' before gpu/cpu     after gpu/cpu     saved'];
  for (const r of E.rows) {
    const b = r.before.gpu + r.before.cpu, a = r.after.gpu + r.after.cpu;
    L.push(' ' + r.what.slice(0, 78).padEnd(78) + f(r.before.gpu) + f(r.before.cpu) + '   ' + f(r.after.gpu) + f(r.after.cpu) + '  ' + f(b - a));
  }
  L.push(' ' + 'TOTAL (MB)'.padEnd(78) + f(tb.gpu) + f(tb.cpu) + '   ' + f(ta.gpu) + f(ta.cpu) + '  ' + f(bt - at) + '   = ' + (bt ? ((bt - at) / bt * 100).toFixed(1) : '0') + ' %');
  return L.join('\n');
}

if (require.main === module) {
  const json = process.argv.includes('--json'), out = {};
  for (const k of Object.keys(SCENARIOS)) out[k] = estimate(SCENARIOS[k]);
  if (json) console.log(JSON.stringify(out, null, 1));
  else for (const k of Object.keys(out)) console.log(table(k, out[k]));
}
module.exports = { estimate, SCENARIOS, table };
