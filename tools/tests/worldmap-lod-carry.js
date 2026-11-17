// node tools/tests/worldmap-lod-carry.js — t1516 live/local divergence: on REAL WebGPU (live devices) the per-brick cluster LOD planet mesh wore the world
// map as a brand-new plain material, dropping the brick fade (opacityNode + the stream's alphaHash switch) and the DMRock relief; the WebGL path (dev
// harness / local) never builds bricks, so it never showed.  Runs the REAL _wmCarry / _wmLodBind / _applyWorldMapToFlightBody from index.html.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const cut = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('marker ' + a); const j = html.indexOf(b, i + a.length); if (j < 0) throw new Error('end ' + b); return html.slice(i, j); };
const src = cut('function _wmCarry(prev,mat){', '// ── Whole-planet map (DART Engine)');
class Mat { constructor() { this.userData = {}; this.opacityNode = null; this.normalNode = null; this.roughnessNode = null; this.colorNode = null; this.alphaHash = false; this.needsUpdate = false; this.lightsNode = null; } }
const THREE = { MeshStandardNodeMaterial: Mat };
const E = new Function('THREE', 'window', '_wmBestMesh', '_wmColorNode', '_lcNode', src + '\nreturn {_wmCarry,_wmLodBind,_applyWorldMapToFlightBody};')(
  THREE, { texture: () => ({}) }, b => b._best, tex => ({ value: tex, map: true }), () => null);

// 1. a brick-LOD mesh: its material has the fade + rock nodes, the stream (ctl) toggles alphaHash on ctl.mat
function lodBody(hash) {
  const lmat = new Mat(); lmat.opacityNode = { fade: 1 }; lmat.normalNode = { rockBump: 1 }; lmat.roughnessNode = { rough: 1 }; lmat.userData.dmRock = 'mars'; lmat.userData._svFade = 1; lmat.alphaHash = !!hash;
  const ctl = { mat: lmat, hash(on) { const m = this.mat; if (m && m.alphaHash !== on) { m.alphaHash = on; m.needsUpdate = true; } } };
  const mesh = { material: lmat, userData: { svLod: ctl } };
  return { b: { name: 'Mars', mesh: {}, _best: mesh }, mesh, lmat, ctl };
}
for (const hash of [false, true]) {
  const T = lodBody(hash);
  E._applyWorldMapToFlightBody(T.b, { tex: { id: 1 } });
  const m = T.mesh.material;
  ok(m !== T.lmat && m.colorNode && m.colorNode.map, 'the map colour is applied (hash=' + hash + ')');
  ok(m.opacityNode === T.lmat.opacityNode, 'brick fade (opacityNode) kept on the drawn material');
  ok(m.normalNode === T.lmat.normalNode && m.roughnessNode === T.lmat.roughnessNode && m.userData.dmRock === 'mars', 'layered-rock relief + roughness kept (PBR detail from orbit)');
  ok(T.ctl.mat === m, 'the brick stream now switches alphaHash on the material actually drawn');
  ok(m.alphaHash === hash, 'a fade in progress stays dithered across the swap');
  T.ctl.hash(true); ok(m.alphaHash === true, 'stream fade start reaches the drawn material');
  T.ctl.hash(false); ok(m.alphaHash === false, 'and its end');
  // texture swap later: same material, no new graph
  const before = m; E._applyWorldMapToFlightBody(T.b, { tex: { id: 2 } }); ok(T.mesh.material === before && before.colorNode.value.id === 2, 'later maps swap the texture on the same node');
}
// 2. a plain (non-LOD) planet mesh: behaviour as before (only the map), no svLod binding
{
  const pm = new Mat(); const mesh = { material: pm, userData: {} }; const b = { name: 'Earth', mesh: {}, _best: mesh };
  E._applyWorldMapToFlightBody(b, { tex: { id: 3 } });
  ok(mesh.material !== pm && mesh.material.opacityNode === null && mesh.material.normalNode === null, 'plain planets: only the map, as before');
  ok(E._wmLodBind(mesh, mesh.material) === false, 'no stream to bind');
}
{ const px = new Mat(); px.normalNode = { parallaxUv: 1 }; px.opacityNode = { o: 1 }; const t = new Mat(); ok(E._wmCarry(px, t) === 0 && t.normalNode === null && t.opacityNode === null, 'a parallax / canvas planet material is not carried (its uv-space normal is its own)'); }
{ const nf = new Mat(); nf.opacityNode = { fade: 1 }; nf.userData._svFade = 1; const t = new Mat(); ok(E._wmCarry(nf, t) === 1 && t.opacityNode === nf.opacityNode, 'bricks with ?mat=0 (no rock layer) still keep their fade'); }
ok(/_lmat\.userData\._svFade=1;/.test(html), 'brick material is marked');
ok(E._wmCarry(null, new Mat()) === 0 && E._wmCarry(new Mat(), null) === 0, 'null-safe');
// 3. the warm-up path carries too (it builds the same material first), and upgradePlanetLOD still dresses the new level before compiling it
const warm = cut('async function _wmWarmAll(){', '// Earth wears its real map');
ok(/_wmCarry\(best\.material,mat\)/.test(warm), 'warm-up material carries the LOD / rock nodes');
ok(!/_wmLodBind/.test(warm), 'warm-up (temporary swap) never rebinds the stream');
ok(/if\(b\._wm\)\{ const keep=b\.mesh; b\.mesh=newGroup; try\{ _applyWorldMapToFlightBody\(b,b\._wm\); \}/.test(html), 'new LOD level is dressed before its compile');
ok(/_lmat\.opacityNode=\(_lmat\.opacityNode\|\|materialOpacity\)\.mul\(f\)/.test(html) && /ctl\.fading=_LOD_XFADE; ctl\.mat=_lmat;/.test(html), 'brick material shape this fix relies on is unchanged');
console.log(fails ? 'worldmap-lod-carry: ' + fails + ' FAILED of ' + n : 'worldmap-lod-carry: all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
