// (v380) The cargo-bay door opening is clear once the leaves slide away: no static triangle of assets/places/menu_cargobay.glb (Bay_* meshes, world
// space = builder frame: Y up, opening at z = OPEN_Z) lies inside the opening volume, and no static Collide_* body intrudes into it.  The leaves
// (Door_* hooks) are excluded: they slide clear on X.  node tools/tests/bay-opening.test.js
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..'), b = fs.readFileSync(path.join(ROOT, 'assets/places/menu_cargobay.glb'));
const jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), BIN = 20 + jl + 8;
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
const W = 16, H = 10, OPEN_Z = -8, HALF_W = W / 2;
// opening volume: inside the amber frame (|x| < HALF_W - 0.6), above the sill / lip LEDs, below the header / top frame, from the door plane to 1 m in
const V = { x: HALF_W - 0.6, y0: 0.4, y1: H - 0.9, z0: OPEN_Z - 0.1, z1: OPEN_Z + 1.0 };
const mul = (A, B) => { const C = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) C[r * 4 + c] += A[r * 4 + k] * B[k * 4 + c]; return C; };
const local = (n) => { const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], t = n.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, t[0], 2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, t[1],
    2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, t[2], 0, 0, 0, 1]; };
const parent = {}; J.nodes.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));
const world = (i) => { let M = local(J.nodes[i]); while (parent[i] != null) { i = parent[i]; M = mul(local(J.nodes[i]), M); } return M; };
const acc = (ai) => { const a = J.accessors[ai], bv = J.bufferViews[a.bufferView], off = BIN + (bv.byteOffset || 0) + (a.byteOffset || 0); return { a, off }; };
const inV = (p) => Math.abs(p[0]) < V.x && p[1] > V.y0 && p[1] < V.y1 && p[2] > V.z0 && p[2] < V.z1;
let bad = 0, tris = 0, inDoor = 0;
J.nodes.forEach((n, i) => {
  if (n.mesh == null) return; const nm = n.name || '';
  let p = i, door = false; while (p != null) { if (/^Door_/.test(J.nodes[p].name || '')) door = true; p = parent[p]; }
  const M = world(i);
  for (const pr of J.meshes[n.mesh].primitives) {
    const { a: pa, off: po } = acc(pr.attributes.POSITION), { a: ia, off: io } = acc(pr.indices), P = (k) => { const x = b.readFloatLE(po + k * 12), y = b.readFloatLE(po + k * 12 + 4), z = b.readFloatLE(po + k * 12 + 8);
      return [M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]]; };
    const rd = ia.componentType === 5125 ? (k) => b.readUInt32LE(io + k * 4) : (k) => b.readUInt16LE(io + k * 2);
    if (/^Collide_/.test(nm)) {   // static collision body AABB vs the opening
      if (door) continue; let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (let k = 0; k < pa.count; k++) { const q = P(k); for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], q[c]); hi[c] = Math.max(hi[c], q[c]); } }
      const hit = lo[0] < V.x && hi[0] > -V.x && lo[1] < V.y1 && hi[1] > V.y0 && lo[2] < V.z1 && hi[2] > V.z0;
      // floor / ceiling / header slabs and the jambs only touch the rim (below y0 / above y1 / outside the frame line)
      ok(!hit || hi[1] <= V.y0 + 0.01 || lo[1] >= V.y1 - 0.01 || hi[0] <= -V.x + 0.6 || lo[0] >= V.x - 0.6, nm + ' does not intrude into the opening');
      continue;
    }
    for (let t = 0; t < ia.count; t += 3) { tris++; const A = P(rd(t)), B = P(rd(t + 1)), C = P(rd(t + 2)); if (inV(A) && inV(B) && inV(C)) { if (door) inDoor++; else bad++; } }
  }
});
ok(tris > 1000, 'bay GLB parsed (' + tris + ' triangles)');
ok(bad === 0, 'no static bay geometry inside the door opening (' + bad + ' triangles; the leaves slide clear: ' + inDoor + ' door triangles)');
const names = J.nodes.map((n) => n.name || '');
ok(!names.some((s) => /Pillar|Mullion|Glass|Pane/i.test(s)), 'no Pillar / Mullion / Glass / Pane nodes');
console.log(fails ? fails + ' FAILED' : 'bay-opening OK'); process.exit(fails ? 1 : 0);
