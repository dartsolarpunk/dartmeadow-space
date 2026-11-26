// Shared helpers for the hair collision tests / fit tool (node ESM): loads the real character GLBs with three@0.185 (textures stripped, skinned meshes kept),
// poses them with the real merged-animation clips, and measures strands (child ribbon centrelines) against the SKINNED body / shirt / glasses triangles
// (segment-triangle crossings through a uniform grid). Used by tools/tests/hair-collision.js and tools/hair-fit-colliders.mjs. three: env DM_HARNESS_NODE or ~/.cache/dm-harness.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = [process.env.DM_HARNESS_NODE && path.join(process.env.DM_HARNESS_NODE, 'node_modules/three'), path.join(process.env.HOME || '/root', '.cache/dm-harness/node_modules/three'), '/home/claude/emma-work/anim/node/node_modules/three'].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'build/three.module.js')));
export const HAVE_THREE = !!T;
export const THREE = T ? await import(pathToFileURL(path.join(T, 'build/three.module.js')).href) : null;
const GLTFLoader = T ? (await import(pathToFileURL(path.join(T, 'examples/jsm/loaders/GLTFLoader.js')).href)).GLTFLoader : null;
export const D = ROOT + '/';


function strip(file){ const b=fs.readFileSync(file); const jl=b.readUInt32LE(12); const J=JSON.parse(b.slice(20,20+jl).toString()); 
  delete J.textures; delete J.images; delete J.samplers; for(const m of J.materials||[]){ for(const k of Object.keys(m)) if(/Texture/.test(k)) delete m[k]; if(m.pbrMetallicRoughness){ for(const k of Object.keys(m.pbrMetallicRoughness)) if(/Texture/.test(k)) delete m.pbrMetallicRoughness[k]; } if(m.extensions) delete m.extensions; }
  delete J.extensionsUsed; delete J.extensionsRequired;
  const js=Buffer.from(JSON.stringify(J)); const pad=(4-js.length%4)%4; const jb=Buffer.concat([js,Buffer.alloc(pad,0x20)]);
  const rest=b.slice(20+jl); const out=Buffer.alloc(12+8+jb.length+rest.length); out.write('glTF',0); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8); out.writeUInt32LE(jb.length,12); out.write('JSON',16); jb.copy(out,20); rest.copy(out,20+jb.length);
  return out.buffer.slice(out.byteOffset,out.byteOffset+out.length); }

export function loadGLB(file){ return new Promise((res,rej)=>{ new GLTFLoader().parse(strip(file),'',res,rej); }); }

export const CHARS = {
  ariel: { glb: 'characterassests/Meshy_AI_Autumn_biped_Character_output.glb', anim: 'characterassests/Meshy_AI_Autumn_biped_Meshy_AI_Meshy_Merged_Animations.glb', bin: 'characterassests/ariel_hair_strands.bin', cfg: null, idle: 'Idle_Breathe_Blink',
    sets: { body: ['Ariel_Reach001'], shirt: ['Shirt001', 'Belt001', 'Pants_Reach_Pose001'], glasses: ['Mesh_1', 'Mesh_2'], scalp: ['Scalp'] }, glassZ: 0.03,
    glasses: { lens: ['Mesh_2'], frame: ['Mesh_1'], frontZ: 0.04, faceZ: 0.0258 }, ear: { c: [0.074, 0.088, -0.0135], h: [0.014, 0.035, 0.0425] } },
  emma: { glb: 'characterassests/emma/Emma_Character.glb', anim: 'characterassests/emma/Emma_Merged_Animations.glb', bin: 'characterassests/emma/emma_hair_strands.bin', cfg: 'characterassests/emma/emma_hair_config.json', idle: 'Emma_Idle',
    sets: { body: ['Emma_Body'], shirt: ['Emma_Shirt', 'Emma_Belt', 'Emma_Pants'], glasses: ['Emma_Glasses_Frame', 'Emma_Glasses_Bridge', 'Emma_Lenses'], scalp: ['Emma_Scalp'] }, glassZ: 0.055,
    glasses: { lens: ['Emma_Lenses'], frame: ['Emma_Glasses_Frame', 'Emma_Glasses_Bridge'], frontZ: 0.063, faceZ: 0.06 }, ear: { c: [0.073, 0.072, -0.012], h: [0.012, 0.03, 0.026] } },
};
export async function setup(name, hairMod, opts = {}) {
  const C = CHARS[name], g = await loadGLB(D + C.glb), ga = await loadGLB(D + C.anim);
  const root = g.scene; const bones = {}; root.traverse(o => { if (o.isBone) bones[o.name] = o; });
  const mixer = new THREE.AnimationMixer(root); const CHAR = { root, bones, mixer };
  const buf = (b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))(fs.readFileSync(D + C.bin));
  const cfg = C.cfg ? JSON.parse(fs.readFileSync(D + C.cfg)) : undefined;
  const H = hairMod.buildHair(CHAR, THREE, buf, Object.assign({ manual: true, config: cfg, character: true }, opts, { params: Object.assign({ deferToRender: false, autoQuality: false, hitchMs: 1e9 }, opts.params || {}) }));
  const meshes = {}; root.traverse(o => { if (o.isSkinnedMesh) meshes[o.name] = o; });
  return { C, CHAR, H, meshes, clips: ga.animations, mixer, root, bones, restQ: bones.Head.quaternion.clone() };
}
export function play(S, clipName, t0 = 0) {
  S.bones.Head.quaternion.copy(S.restQ); S.mixer.stopAllAction(); const clip = S.clips.find(c => c.name === clipName); if (!clip) throw new Error('no clip ' + clipName);
  const a = S.mixer.clipAction(clip); a.play(); S.mixer.setTime(t0); S.root.updateMatrixWorld(true); return clip;
}
// triangle soup of the named skinned meshes in root-local space, with a uniform grid
export function surfaces(S, set) {
  S.root.updateMatrixWorld(true); const rootInv = new THREE.Matrix4().copy(S.root.matrixWorld).invert(); const v = new THREE.Vector3(); const out = {};
  for (const [cat, names] of Object.entries(S.C.sets)) {
    if (set && !set.includes(cat)) continue;
    const tris = []; 
    for (const n of names) { const m = S.meshes[n]; if (!m) { console.warn('missing mesh', n); continue; } m.skeleton.update(); const P = m.geometry.attributes.position, ix = m.geometry.index; const M = new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld);
      const w = new Float32Array(P.count * 3); for (let i = 0; i < P.count; i++) { m.getVertexPosition(i, v); v.applyMatrix4(M); w[i * 3] = v.x; w[i * 3 + 1] = v.y; w[i * 3 + 2] = v.z; }
      const nt = ix ? ix.count / 3 : P.count / 3; for (let t = 0; t < nt; t++) { const a = ix ? ix.getX(t * 3) : t * 3, b = ix ? ix.getX(t * 3 + 1) : t * 3 + 1, c = ix ? ix.getX(t * 3 + 2) : t * 3 + 2; tris.push(w[a * 3], w[a * 3 + 1], w[a * 3 + 2], w[b * 3], w[b * 3 + 1], w[b * 3 + 2], w[c * 3], w[c * 3 + 1], w[c * 3 + 2]); } }
    if (cat === 'glasses' && S.C.glassZ != null) { // keep the lens / front of the frame (temple arms legitimately pass through hair at the ears)
      const hm = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(S.bones.Head.matrixWorld).invert(), S.root.matrixWorld), q = new THREE.Vector3(), keep = [];
      for (let t = 0; t < tris.length; t += 9) { q.set((tris[t] + tris[t + 3] + tris[t + 6]) / 3, (tris[t + 1] + tris[t + 4] + tris[t + 7]) / 3, (tris[t + 2] + tris[t + 5] + tris[t + 8]) / 3).applyMatrix4(hm); if (q.z > S.C.glassZ) for (let i = 0; i < 9; i++) keep.push(tris[t + i]); }
      tris.length = 0; for (const x of keep) tris.push(x); }
    out[cat] = grid(new Float32Array(tris));
  }
  return out;
}
function grid(T, cell = 0.012) {
  const n = T.length / 9; let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
  for (let i = 0; i < T.length; i += 3) { x0 = Math.min(x0, T[i]); x1 = Math.max(x1, T[i]); y0 = Math.min(y0, T[i + 1]); y1 = Math.max(y1, T[i + 1]); z0 = Math.min(z0, T[i + 2]); z1 = Math.max(z1, T[i + 2]); }
  const nx = Math.ceil((x1 - x0) / cell) + 1, ny = Math.ceil((y1 - y0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1, cells = new Map();
  const key = (i, j, k) => (i * ny + j) * nz + k;
  for (let t = 0; t < n; t++) { const o = t * 9; const ax = Math.min(T[o], T[o + 3], T[o + 6]), bx = Math.max(T[o], T[o + 3], T[o + 6]), ay = Math.min(T[o + 1], T[o + 4], T[o + 7]), by = Math.max(T[o + 1], T[o + 4], T[o + 7]), az = Math.min(T[o + 2], T[o + 5], T[o + 8]), bz = Math.max(T[o + 2], T[o + 5], T[o + 8]);
    for (let i = Math.floor((ax - x0) / cell); i <= Math.floor((bx - x0) / cell); i++) for (let j = Math.floor((ay - y0) / cell); j <= Math.floor((by - y0) / cell); j++) for (let k = Math.floor((az - z0) / cell); k <= Math.floor((bz - z0) / cell); k++) { const q = key(i, j, k); let a = cells.get(q); if (!a) cells.set(q, a = []); a.push(t); } }
  return { T, n, cell, x0, y0, z0, nx, ny, nz, cells, key, stamp: new Int32Array(n), sid: 0 };
}
// closest point on triangle (Ericson); writes into out[0..2], returns squared distance and sets sign from the face normal
const tmp = new Float32Array(6);
function closest(T, o, px, py, pz, out) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz; let u, v, w;
  const set = (s, t) => { out[0] = ax + abx * s + acx * t; out[1] = ay + aby * s + acy * t; out[2] = az + abz * s + acz * t; };
  if (d1 <= 0 && d2 <= 0) set(0, 0);
  else { const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) set(1, 0);
    else { const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) set(d1 / (d1 - d3), 0);
      else { const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) set(0, 1);
        else { const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) set(0, d2 / (d2 - d6));
          else { const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const s = (d4 - d3) / ((d4 - d3) + (d5 - d6)); set(1 - s, s); }
            else { const dn = 1 / (va + vb + vc); set(vb * dn, vc * dn); } } } } } }
  const dx = px - out[0], dy = py - out[1], dz = pz - out[2]; return dx * dx + dy * dy + dz * dz;
}
// signed distance to a triangle soup, nearest within `reach` (m); sign from the nearest face normal. returns {d, tri} or null when nothing within reach
export function nearest(Gr, px, py, pz, reach = 0.03) {
  const c = Gr.cell; let best = 1e9, bt = -1; const out = tmp;
  const i0 = Math.floor((px - reach - Gr.x0) / c), i1 = Math.floor((px + reach - Gr.x0) / c), j0 = Math.floor((py - reach - Gr.y0) / c), j1 = Math.floor((py + reach - Gr.y0) / c), k0 = Math.floor((pz - reach - Gr.z0) / c), k1 = Math.floor((pz + reach - Gr.z0) / c);
  Gr.sid++; let bsx = 0, bsy = 0, bsz = 0;
  for (let i = Math.max(0, i0); i <= Math.min(Gr.nx - 1, i1); i++) for (let j = Math.max(0, j0); j <= Math.min(Gr.ny - 1, j1); j++) for (let k = Math.max(0, k0); k <= Math.min(Gr.nz - 1, k1); k++) {
    const a = Gr.cells.get(Gr.key(i, j, k)); if (!a) continue;
    for (let q = 0; q < a.length; q++) { const t = a[q]; if (Gr.stamp[t] === Gr.sid) continue; Gr.stamp[t] = Gr.sid; const d2 = closest(Gr.T, t * 9, px, py, pz, out); if (d2 < best) { best = d2; bt = t; bsx = px - out[0]; bsy = py - out[1]; bsz = pz - out[2]; } } }
  if (bt < 0) return null; const T = Gr.T, o = bt * 9;
  const ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2], vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const sg = (bsx * nx + bsy * ny + bsz * nz) >= 0 ? 1 : -1;
  return { d: Math.sqrt(best) * sg, tri: bt };
}
// does segment p->q pass through any triangle of the soup (Moller-Trumbore, segment form)
export function crosses(Gr, ax, ay, az, bx, by, bz) {
  const c = Gr.cell; const i0 = Math.floor((Math.min(ax, bx) - Gr.x0) / c), i1 = Math.floor((Math.max(ax, bx) - Gr.x0) / c), j0 = Math.floor((Math.min(ay, by) - Gr.y0) / c), j1 = Math.floor((Math.max(ay, by) - Gr.y0) / c), k0 = Math.floor((Math.min(az, bz) - Gr.z0) / c), k1 = Math.floor((Math.max(az, bz) - Gr.z0) / c);
  Gr.sid++; const dx = bx - ax, dy = by - ay, dz = bz - az, T = Gr.T; let hits = 0;
  for (let i = Math.max(0, i0); i <= Math.min(Gr.nx - 1, i1); i++) for (let j = Math.max(0, j0); j <= Math.min(Gr.ny - 1, j1); j++) for (let k = Math.max(0, k0); k <= Math.min(Gr.nz - 1, k1); k++) {
    const a = Gr.cells.get(Gr.key(i, j, k)); if (!a) continue;
    for (let q = 0; q < a.length; q++) { const t = a[q]; if (Gr.stamp[t] === Gr.sid) continue; Gr.stamp[t] = Gr.sid; const o = t * 9;
      const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2], e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
      const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x, a0 = e1x * hx + e1y * hy + e1z * hz; if (Math.abs(a0) < 1e-12) continue;
      const f = 1 / a0, sx = ax - T[o], sy = ay - T[o + 1], sz = az - T[o + 2], u = f * (sx * hx + sy * hy + sz * hz); if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = f * (dx * qx + dy * qy + dz * qz); if (v < 0 || u + v > 1) continue;
      const tt = f * (e2x * qx + e2y * qy + e2z * qz); if (tt >= 0 && tt <= 1) hits++; } }
  return hits;
}
// measure the current hair state: child centrelines (CPU ribbon arrays, root-local) against the surfaces
export function measure(S, surf, rad = 0.0025, stride = 1) {
  const H = S.H, pos = H.ribbonArrays.pos, K = H.meta.points, N = H.meta.count, grp = H.meta._group; const res = {};
  const NR = H.stats.drawn;
  for (const cat of Object.keys(surf)) res[cat] = { cross: 0, inside: 0, touch: 0, strandsX: 0, byGroup: {} };
  const grpOf = H.groupOf; const P = new Float32Array(K * 3);
  for (let s = 0; s < NR; s += stride) {
    for (let k = 0; k < K; k++) { const o = (s * K + k) * 6; P[k * 3] = (pos[o] + pos[o + 3]) / 2; P[k * 3 + 1] = (pos[o + 1] + pos[o + 4]) / 2; P[k * 3 + 2] = (pos[o + 2] + pos[o + 5]) / 2; }
    for (const [cat, Gr] of Object.entries(surf)) {
      let sx = 0; const R = res[cat], gname = H.groupName ? H.groupName(s) : 'all';
      for (let k = 2; k < K; k++) { // points 0,1 are pinned to the scalp
        const px = P[k * 3], py = P[k * 3 + 1], pz = P[k * 3 + 2];
        const x = crosses(Gr, P[k * 3 - 3], P[k * 3 - 2], P[k * 3 - 1], px, py, pz); if (x) { R.cross += x; sx = 1; R.byGroup[gname] = (R.byGroup[gname] || 0) + x; }
        const nr = nearest(Gr, px, py, pz, 0.02); if (nr && cat !== 'glasses' && cat !== 'scalp') { if (nr.d < 0) R.inside++; if (nr.d < rad) R.touch++; } else if (nr && nr.d !== undefined && Math.abs(nr.d) < rad) R.touch++;
      }
      R.strandsX += sx;
    }
  }
  return res;
}
// dominant bone name per triangle (body/shirt surfaces) -> for attributing intrusions to regions
export function triBones(S, cat) {
  const out = []; for (const n of S.C.sets[cat]) { const m = S.meshes[n]; if (!m) continue; const ix = m.geometry.index, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, bn = m.skeleton.bones;
    const dom = i => { let b = 0, w = -1; for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > w) { w = sw.getComponent(i, k); b = si.getComponent(i, k); } return bn[b].name; };
    const nt = ix.count / 3; for (let t = 0; t < nt; t++) out.push(dom(ix.getX(t * 3))); }
  return out;
}
