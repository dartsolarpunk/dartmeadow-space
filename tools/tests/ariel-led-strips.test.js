// Ariel's top-of-glasses LED half-strips (characterassests/Meshy_AI_Autumn_biped_Character_output.glb) - pure node, no three.js:  node tools/tests/ariel-led-strips.test.js [glb]
//  node + material names survive (LED_Top_Strip_L/R, LED_Top_Mat_L/R), each strip is its own skinned mesh, 100 % to the 'Head' joint, parent = the armature (like 'Mesh 1', the glasses
//  frame), emissive black + dark base colour, sits on top of the glasses frame, L = her left (+x) / R = -x, small; the rest of the file is untouched in structure
//  (every pre-existing node keeps its index/name, the last skinned mesh the game sees (CHAR.skinnedMesh) is still 'Tube.023').
'use strict';
const fs = require('fs'), path = require('path');
const f = process.argv[2] || path.join(__dirname, '..', '..', 'characterassests', 'Meshy_AI_Autumn_biped_Character_output.glb');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const b = fs.readFileSync(f), jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), bo = 20 + jl + 8;
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }, CT = { 5126: Float32Array, 5123: Uint16Array, 5121: Uint8Array };
function acc(i) { const a = J.accessors[i], v = J.bufferViews[a.bufferView], C = CT[a.componentType], n = NC[a.type], off = bo + (v.byteOffset || 0) + (a.byteOffset || 0);
  return { arr: new C(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + a.count * n * C.BYTES_PER_ELEMENT)), n, count: a.count, a }; }
const N = J.nodes, byName = n => N.findIndex(x => x.name === n);
const arm = byName('Ariel_Armature'), head = byName('Head'), glass = byName('Mesh 1'), sk = J.skins[0], hj = sk.joints.indexOf(head);
ok(arm >= 0 && head >= 0 && glass >= 0 && hj >= 0, 'armature / Head joint / glasses frame node exist');
ok(N.length === 194 && J.meshes.length === 21 && J.materials.length === 19, 'node/mesh/material counts = original 192/19/17 + 2 each');
const gp = acc(J.meshes[N[glass].mesh].primitives[0].attributes.POSITION).arr; let top = -1e9, zf = -1e9; for (let i = 0; i < gp.length; i += 3) { if (gp[i + 2] > zf) zf = gp[i + 2]; }
for (let i = 0; i < gp.length; i += 3) if (gp[i + 2] > zf - 0.027 && Math.abs(gp[i]) < 0.02 && gp[i + 1] > top) top = gp[i + 1];
const box = {};
for (const s of ['L', 'R']) {
  const ni = byName('LED_Top_Strip_' + s); ok(ni >= 0, 'node LED_Top_Strip_' + s + ' exists'); if (ni < 0) continue;
  const nd = N[ni], me = J.meshes[nd.mesh], pr = me.primitives[0], mat = J.materials[pr.material];
  ok(me.name === 'LED_Top_Strip_' + s && J.nodes.filter(x => x.name === nd.name).length === 1, 'mesh + node names exact and unique');
  ok(nd.skin === 0 && N[arm].children.includes(ni) && N[glass].skin === 0 && N[arm].children.includes(glass), 'skinned (skin 0), child of the armature like the glasses frame');
  ok(mat.name === 'LED_Top_Mat_' + s && J.materials.filter(x => x.name === mat.name).length === 1, 'material name ' + mat.name);
  ok(JSON.stringify(mat.emissiveFactor) === '[0,0,0]' && mat.pbrMetallicRoughness.baseColorFactor.slice(0, 3).every(v => v <= 0.05) && !(mat.extensions && mat.extensions.KHR_materials_unlit), 'emissive black, dark base colour, emissive-capable (no KHR_materials_unlit)');
  const P = acc(pr.attributes.POSITION), Jt = acc(pr.attributes.JOINTS_0), W = acc(pr.attributes.WEIGHTS_0), I = acc(pr.indices);
  ok(P.count >= 24 && I.count % 3 === 0 && I.count >= 36, 'enough faces to split: ' + P.count + ' verts / ' + I.count / 3 + ' tris');
  let allHead = true; for (let i = 0; i < P.count; i++) if (Jt.arr[i * 4] !== hj || W.arr[i * 4] !== 1 || Jt.arr[i * 4 + 1] || W.arr[i * 4 + 1]) allHead = false;
  ok(allHead, '100 % skinned to the Head joint (joint index ' + hj + ')');
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 0; i < P.count; i++) { const x = P.arr[i * 3], y = P.arr[i * 3 + 1], z = P.arr[i * 3 + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  box[s] = { x0, x1, y0, y1, z0, z1 };
  ok(y0 >= top - 0.001 && y1 > top + 0.003 && y1 < top + 0.008, 'sits on top of the glasses frame (top ' + top.toFixed(4) + ', strip y ' + y0.toFixed(4) + '..' + y1.toFixed(4) + ')');
  ok(x1 - x0 < 0.02 && z1 - z0 < 0.005 && y1 - y0 < 0.008, 'small: ' + ((x1 - x0) * 1000).toFixed(1) + ' x ' + ((y1 - y0) * 1000).toFixed(1) + ' x ' + ((z1 - z0) * 1000).toFixed(1) + ' mm per half');
  let up = 0; for (let t = 0; t < I.count; t += 3) { const a = I.arr[t], bb = I.arr[t + 1], c = I.arr[t + 2]; const g = (k, j) => P.arr[k * 3 + j];
    const ux = g(bb, 0) - g(a, 0), uy = g(bb, 1) - g(a, 1), uz = g(bb, 2) - g(a, 2), vx = g(c, 0) - g(a, 0), vy = g(c, 1) - g(a, 1), vz = g(c, 2) - g(a, 2); if (uz * vx - ux * vz > 1e-12) up++; }
  ok(up >= 4, 'top face points straight up (+y) with CCW winding (' + up + ' up-facing tris)');
}
if (box.L && box.R) {
  ok(box.L.x0 > 0 && box.R.x1 < 0 && box.L.x0 - box.R.x1 < 0.002, 'L is her left (+x), R is -x, split along the length with a hairline gap');
  ok(Math.abs(box.L.x1 + box.R.x0) < 1e-6 && Math.abs(box.L.y1 - box.R.y1) < 1e-9 && Math.abs(box.L.z0 - box.R.z0) < 1e-9, 'halves are mirror images about x = 0');
  ok(Math.abs((box.L.x1 - box.R.x0) - 0.036) < 0.001, 'overall length 36 mm (existing runtime LED casing is width/3 = 51 mm)');
}
const kids = N[arm].children, lastMesh = kids.filter(i => N[i].mesh != null).pop();
ok(N[lastMesh].name === 'Tube.023', "last skinned mesh in scene order is still 'Tube.023' (CHAR.skinnedMesh unchanged)");
ok(['Ariel_Armature', 'Hips', 'neck', 'Head', 'Mesh 1', 'Shirt.001', 'Charm.001', 'Tube.021', 'Scalp'].every(n => byName(n) >= 0) && byName('Hips') === 171 && byName('Mesh 1') === 179 && byName('Tube.023') === 190, 'pre-existing node indices unchanged (Hips 171, Mesh 1 179, Tube.023 190)');
ok(sk.joints.length === 172 && J.animations === undefined, 'skin unchanged: 172 joints');
console.log(fails ? fails + ' FAILED' : 'all ok'); process.exit(fails ? 1 : 0);
