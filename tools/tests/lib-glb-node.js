// Minimal node GLB reader for tests: returns the node tree as {name, matrixWorld:{elements}, children, geometry?, material?}-shaped objects that
// DMCollide.fromMeshGen / fromObjectGen walk (isMesh, geometry.attributes.position/getX, geometry.index, traverse, updateMatrixWorld). No three.js needed.
'use strict';
const fs = require('fs');
function mul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }
function local(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1], [x, y, z, w] = q;
  const m = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, t[0], t[1], t[2], 1];
  for (let i = 0; i < 3; i++) { m[i] *= s[0]; m[4 + i] *= s[1]; m[8 + i] *= s[2]; } return m;
}
function load(file, base) {
  const b = fs.readFileSync(file), jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), bo = 20 + jl + 8;
  const CT = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array };
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  function acc(i) {
    const a = J.accessors[i], bv = J.bufferViews[a.bufferView], C = CT[a.componentType], n = NC[a.type], off = bo + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const stride = bv.byteStride ? bv.byteStride / C.BYTES_PER_ELEMENT : n; const raw = new C(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + (a.count - 1) * stride * C.BYTES_PER_ELEMENT + n * C.BYTES_PER_ELEMENT));
    const out = new C(a.count * n); for (let i2 = 0; i2 < a.count; i2++) for (let k = 0; k < n; k++) out[i2 * n + k] = raw[i2 * stride + k]; return { arr: out, n, count: a.count };
  }
  function mk(i, parentM, parent) {
    const nd = J.nodes[i], M = mul(parentM, local(nd)), o = { name: nd.name, matrixWorld: { elements: M }, children: [], parent, userData: {}, isMesh: false };
    o.updateMatrixWorld = () => { }; o.updateWorldMatrix = () => { };
    o.traverse = f => { f(o); o.children.forEach(c => c.traverse(f)); };
    o.getObjectByName = nm => { let r = null; o.traverse(x => { if (!r && x.name === nm) r = x; }); return r; };
    (nd.children || []).forEach(c => o.children.push(mk(c, M, o)));
    if (nd.mesh != null) for (const pr of J.meshes[nd.mesh].primitives) {
      const P = acc(pr.attributes.POSITION), I = pr.indices != null ? acc(pr.indices) : null, mat = J.materials[pr.material] || {};
      const m = { name: nd.name, isMesh: true, userData: {}, matrixWorld: { elements: M }, material: { name: mat.name }, parent: o, children: [], traverse(f) { f(m); }, updateMatrixWorld() { }, geometry: { attributes: { position: { count: P.count, getX: i2 => P.arr[i2 * 3], getY: i2 => P.arr[i2 * 3 + 1], getZ: i2 => P.arr[i2 * 3 + 2] } }, index: I ? { count: I.count, getX: i2 => I.arr[i2] } : null, boundingBox: null, computeBoundingBox() { const g = this; let a = [1e9, 1e9, 1e9], c = [-1e9, -1e9, -1e9]; for (let i2 = 0; i2 < P.count; i2++) for (let k = 0; k < 3; k++) { a[k] = Math.min(a[k], P.arr[i2 * 3 + k]); c[k] = Math.max(c[k], P.arr[i2 * 3 + k]); } g.boundingBox = { min: { x: a[0], y: a[1], z: a[2] }, max: { x: c[0], y: c[1], z: c[2] } }; } } };
      o.children.push(m);
    }
    return o;
  }
  const root = { name: 'root', children: [], userData: {}, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, updateMatrixWorld() { }, updateWorldMatrix() { } };
  root.traverse = f => { f(root); root.children.forEach(c => c.traverse(f)); }; root.getObjectByName = nm => { let r = null; root.traverse(x => { if (!r && x.name === nm) r = x; }); return r; };
  (J.scenes[J.scene || 0].nodes).forEach(i => root.children.push(mk(i, base || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], root)));
  return { root, json: J };
}
module.exports = { load };
