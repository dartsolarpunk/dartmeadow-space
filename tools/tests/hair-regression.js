// Hair loader regression: node tools/tests/hair-regression.js [--write-golden] [--against path/to/old/hair_strands.js]
// Loads Ariel's real groom (characterassests/ariel_hair_strands.bin) with hair_strands.js on a stub skeleton (the real Autumn GLB bone tree, three.core only,
// CPU solver, no renderer), moves the character deterministically for 90 solver steps and hashes the ribbon positions / normals / colours.
//  * default: compares with tools/tests/fixtures/ariel-hair-golden.json (written from the loader BEFORE it became data-driven) -> Ariel's hair must be bit-identical
//  * --against OLD.js : runs OLD.js and the current loader side by side and compares them (no fixture needed)
// Also checks that a made-up multi-cluster config (4 clusters + width/colour/stiffness/clearance, body capsule override) loads and stays finite.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..', '..');
const THREE_DIR = [process.env.DM_HARNESS_NODE && path.join(process.env.DM_HARNESS_NODE, 'node_modules/three'), path.join(process.env.HOME || '/root', '.cache/dm-harness/node_modules/three'), '/home/claude/emma-work/anim/node/node_modules/three'].filter(Boolean).find(p => fs.existsSync(path.join(p, 'build/three.core.js')));
if (!THREE_DIR) { console.log('SKIP: three@0.185.0 not installed (npm i three@0.185.0 in ~/.cache/dm-harness)'); process.exit(0); }
const args = process.argv.slice(2), against = args.includes('--against') ? args[args.indexOf('--against') + 1] : null, writeGolden = args.includes('--write-golden');
const hash = a => crypto.createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex').slice(0, 16);

function glbJson(f) { const b = fs.readFileSync(f), jl = b.readUInt32LE(12); return JSON.parse(b.slice(20, 20 + jl).toString()); }
function stubChar(THREE, name) {
  const J = glbJson(path.join(ROOT, 'characterassests', 'Meshy_AI_Autumn_biped_Character_output.glb')), objs = J.nodes.map(n => { const o = (n.skin != null || n.mesh != null) ? new THREE.Object3D() : new THREE.Bone(); o.name = n.name || ''; if (n.translation) o.position.fromArray(n.translation); if (n.rotation) o.quaternion.fromArray(n.rotation); if (n.scale) o.scale.fromArray(n.scale); return o; });
  J.nodes.forEach((n, i) => (n.children || []).forEach(c => objs[i].add(objs[c])));
  const root = new THREE.Group(); J.scenes[J.scene || 0].nodes.forEach(i => root.add(objs[i])); const scalp = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()); scalp.name = name; root.add(scalp);
  const bones = {}; root.traverse(o => { if (o.isBone) bones[o.name] = o; });
  return { root, bones, mixer: new THREE.AnimationMixer(root) };
}
async function run(modPath, THREE, binBuf, opts, scalpName) {
  const mod = await import(pathToFileURL(modPath).href + '?x=' + Math.random()), CHAR = stubChar(THREE, scalpName || 'Scalp');
  const H = mod.buildHair(CHAR, THREE, binBuf, Object.assign({ manual: true, params: Object.assign({ deferToRender: false, autoQuality: false }, (opts && opts.params) || {}) }, opts || {}, { params: Object.assign({ deferToRender: false, autoQuality: false }, (opts && opts.params) || {}) }));
  const head = CHAR.bones.Head, out = { h0: null };
  const snap = () => ({ pos: hash(H.ribbonArrays.pos), nrm: hash(H.ribbonArrays.nrm) });
  for (let i = 0; i < 90; i++) {
    const t = i / 60; CHAR.root.position.set(Math.sin(t * 2) * 0.3, 0, i * 0.01); CHAR.root.rotation.y = Math.sin(t) * 0.4; head.rotation.x = 0.2 * Math.sin(t * 3); head.rotation.z = 0.15 * Math.sin(t * 2.2);
    CHAR.root.updateMatrixWorld(true); H.update(1 / 60); if (i === 0) out.h0 = snap();
  }
  out.h90 = snap(); out.col = hash(H.mesh.geometry.getAttribute('color').array); out.stats = { strands: H.stats.strands, guides: H.stats.guides };
  out.finite = Array.from(H.ribbonArrays.pos).every(Number.isFinite); out.H = H; out.CHAR = CHAR; return out;
}
(async () => {
  const THREE = await import(pathToFileURL(path.join(THREE_DIR, 'build/three.core.js')).href);
  const binBuf = (b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))(fs.readFileSync(path.join(ROOT, 'characterassests', 'ariel_hair_strands.bin')));
  let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
  const cur = await run(path.join(ROOT, 'hair_strands.js'), THREE, binBuf);
  const a1 = { h0: cur.h0, h90: cur.h90, col: cur.col, stats: cur.stats };
  const again = await run(path.join(ROOT, 'hair_strands.js'), THREE, binBuf); ok(JSON.stringify({ h0: again.h0, h90: again.h90, col: again.col }) === JSON.stringify({ h0: a1.h0, h90: a1.h90, col: a1.col }), 'loader is deterministic (two runs identical)');
  ok(cur.finite && a1.stats.strands === 5665 && a1.stats.guides === 1415, 'Ariel groom: ' + a1.stats.strands + ' strands, ' + a1.stats.guides + ' guides, finite');
  ok(cur.H.mesh.name === 'ArielHairStrands', 'mesh name unchanged (ArielHairStrands)');
  const gf = path.join(__dirname, 'fixtures', 'ariel-hair-golden.json');
  if (writeGolden) { fs.writeFileSync(gf, JSON.stringify(a1, null, 1)); console.log('golden written', a1); }
  else if (against) { const old = await run(path.resolve(against), THREE, binBuf); ok(JSON.stringify({ h0: old.h0, h90: old.h90, col: old.col }) === JSON.stringify({ h0: a1.h0, h90: a1.h90, col: a1.col }), 'identical to ' + against + ' (ribbon pos/nrm after 1 and 90 steps, colours)'); }
  else { const g = JSON.parse(fs.readFileSync(gf)); ok(JSON.stringify(g) === JSON.stringify(a1), 'identical to the golden recorded before the loader became data-driven'); if (JSON.stringify(g) !== JSON.stringify(a1)) console.log(' golden', g, '\n now   ', a1); }
  // data-driven config: a 4-cluster character with its own widths/colours/stiffness (the strand file's groups are reused as cluster ids)
  try {
    const cfg = { name: 'Test', character: true, clusters: [{ name: 'a', color: [0.4, 0.2, 0.1], stiffBoost: 1.3, widthScale: 0.8 }, { name: 'b', color: [0.5, 0.3, 0.1], colorJitter: [0.9, 1.1], stiffBoost: 2.0, bendBoost: 1.0, widthScale: 1.5, clearance: { min: 0.001, max: 0.01 } }, { name: 'c', gradient: { root: [0.2, 0.1, 0.05], tip: [0.8, 0.6, 0.3], tipStart: 0.3 } }, { name: 'd' }], body: [['Spine01', 'Spine', 0.1], ['Hips', 'Spine02', 0.12]], params: { gravity: 5 } };
    const t = await run(path.join(ROOT, 'hair_strands.js'), THREE, binBuf, { config: cfg }, 'NotScalp');
    ok(t.finite && t.H.mesh.name === 'TestHairStrands', 'multi-cluster config loads + simulates (finite), mesh named by config');
    ok(t.col !== a1.col && JSON.stringify(t.h90) !== JSON.stringify(a1.h90), 'config changes colours / widths / stiffness (not silently ignored)');
    ok(t.H.params.gravity === 5, 'config.params reaches the solver params');
  } catch (e) { fails++; console.log('FAIL config load', e && e.stack || e); }
  // Emma's real groom + config (if present): 6000 strands x 16 points, file width hints, clump tint, Emma_Scalp
  const ed = path.join(ROOT, 'characterassests', 'emma');
  if (fs.existsSync(path.join(ed, 'emma_hair_strands.bin'))) try {
    const eb = (b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))(fs.readFileSync(path.join(ed, 'emma_hair_strands.bin'))), ec = JSON.parse(fs.readFileSync(path.join(ed, 'emma_hair_config.json')));
    const e1 = await run(path.join(ROOT, 'hair_strands.js'), THREE, eb, { config: ec }, 'Emma_Scalp'), nc = Object.assign({}, ec); delete nc.clumps; const e0 = await run(path.join(ROOT, 'hair_strands.js'), THREE, eb, { config: nc }, 'Emma_Scalp');
    ok(e1.finite && e1.stats.strands === 6000 && e1.stats.guides === 1500, 'Emma groom: ' + e1.stats.strands + ' strands, ' + e1.stats.guides + ' guides, finite');
    ok(e1.H.mesh.name === 'EmmaHairStrands' && e1.H.params.widthRoot === 0.0056 && e1.H.params.widthTip === 0.0027, 'Emma mesh name + widths from the file / config');
    ok(e1.col !== e0.col, 'per-clump tint changes Emma colours');
    const e2 = await run(path.join(ROOT, 'hair_strands.js'), THREE, eb, {}, 'Emma_Scalp').catch(e => e); ok(e2 instanceof Error || e2.finite, 'Emma bin without config still loads or refuses cleanly');
  } catch (e) { fails++; console.log('FAIL emma hair', e && e.stack || e); }
  console.log(fails ? fails + ' FAILED' : 'ALL OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
