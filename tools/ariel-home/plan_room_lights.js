// node tools/ariel-home/plan_room_lights.js [interior.glb] [out.json]
// Plans the REAL interior lights of Ariel's mansion (ui/dm-lamps.js picks the nearest few to her at run time, by tier) from the interior GLB's own emissive geometry
// (material `int_emit`: bulbs, pendants, overhead LED rails, under-cabinet strips - the same boxes tools/ariel-home/build_interior.py bakes its lamp tint from).
// Blender is not needed: the emissive primitive is read straight from the GLB. Output (assets/ariel-home/ariel-home-roomlights.json), nav frame (x east, y seaward, z up, 1.78 units = 1 m):
//   { v, upm, rooms: [id...], lights: [[x, y, z, r, g, b, R, k, roomIndex]...] }   roomIndex = DMMansionRooms.ROOMS order (-1 = none), R = reach (units), k = relative intensity
// Selection per room: boxes are merged into fixtures; ceiling bulbs / pendants -> one light each; long overhead rails -> one light per ~14 units; LED strips (>= 2.5 units) -> one dimmer
// light mid-strip; then <= MAX_PER_ROOM per room by greedy farthest-point sampling (biggest fixtures first) so a room is covered evenly.
'use strict';
const fs = require('fs'), path = require('path');
const R = require('../../ui/dm-mansion-rooms.js');
const glb = process.argv[2] || path.join(__dirname, '../../assets/ariel-home/ariel-home-interior-512.glb'), out = process.argv[3] || path.join(__dirname, '../../assets/ariel-home/ariel-home-roomlights.json');
const MAX_PER_ROOM = 6, CEIL_Z = 4.6;
function readEmit(file) {
  const b = fs.readFileSync(file), jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), bo = 20 + jl + 8;
  const mi = J.materials.findIndex(m => m.name === 'int_emit'), pr = J.meshes[0].primitives.find(p => p.material === mi); if (!pr) throw new Error('no int_emit primitive');
  const rd = (i, nComp, fl) => { const a = J.accessors[i], bv = J.bufferViews[a.bufferView], n = { VEC3: 3, VEC4: 4 }[a.type], off = bo + (bv.byteOffset || 0) + (a.byteOffset || 0), st = bv.byteStride || n * (fl ? 4 : 1), dv = new DataView(b.buffer, b.byteOffset + off), o = [];
    for (let k = 0; k < a.count; k++) { const r = []; for (let c = 0; c < n; c++) r.push(fl ? dv.getFloat32(k * st + c * 4, true) : dv.getUint8(k * st + c) / 255); o.push(r); } return o; };
  return { P: rd(pr.attributes.POSITION, 3, true), C: rd(pr.attributes.COLOR_0, 4, false) };
}
function fixtures(P, C) {   // quads (4 verts) -> AABBs -> merge touching boxes
  const q = []; for (let i = 0; i + 3 < P.length; i += 4) { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (let k = 0; k < 4; k++) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[i + k][a]); mx[a] = Math.max(mx[a], P[i + k][a]); } q.push({ mn, mx, c: C[i] }); }
  const par = q.map((_, i) => i), fd = i => par[i] === i ? i : (par[i] = fd(par[i])), eps = 0.02;
  for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) { let ok = true; for (let a = 0; a < 3; a++) if (q[i].mn[a] > q[j].mx[a] + eps || q[j].mn[a] > q[i].mx[a] + eps) { ok = false; break; } if (ok) par[fd(i)] = fd(j); }
  const g = {}; q.forEach((x, i) => { (g[fd(i)] = g[fd(i)] || []).push(x); });
  return Object.values(g).map(a => { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], c = [0, 0, 0]; for (const x of a) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], x.mn[k]); mx[k] = Math.max(mx[k], x.mx[k]); c[k] += x.c[k]; }
    // GLB frame (x east, y up, z = -seaward) -> nav frame (x, y = -z, z = y)
    return { mn: [mn[0], -mx[2], mn[1]], mx: [mx[0], -mn[2], mx[1]], col: c.map(v => v / a.length), n: a.length }; });
}
const lerp = (a, b, t) => a + (b - a) * t;
// lamps the interior build bakes WITHOUT any emissive geometry (build_interior.py: lampbulb(..., r = 0) coves and plain lamp() calls); same positions / reach / colour / k
const VIRTUAL = [];
for (let x = -60; x < 66; x += 9) VIRTUAL.push([x, -36.48, 6.5, 1, 0.72, 0.42, 22, 0.55]);                                          // ceiling light cove along the rear wall (HY0 + 1.2)
for (const [x, y] of [[-24, 12], [-17, 30], [-9, 44], [24, 12], [17, 30], [9, 44]]) VIRTUAL.push([x, y, 6.5, 1, 0.72, 0.42, 22, 0.55]);   // strips along the prow glass
VIRTUAL.push([13, 33, 5.1, 0.45, 0.55, 1, 22, 0.9], [0, 58, 5.0, 1, 0.8, 0.55, 20, 0.7]);                                             // game lounge blue lamp, tip lounge lamp
function plan(F) {
  const cand = [];
  for (const v of VIRTUAL) cand.push({ x: v[0], y: v[1], z: v[2] - 0.3, col: [v[3], v[4], v[5]], R: v[6], k: v[7], w: 1.5 });
  for (const f of F) {
    const sx = f.mx[0] - f.mn[0], sy = f.mx[1] - f.mn[1], sz = f.mx[2] - f.mn[2], cx = (f.mn[0] + f.mx[0]) / 2, cy = (f.mn[1] + f.mx[1]) / 2, cz = (f.mn[2] + f.mx[2]) / 2, big = Math.max(sx, sy), small = Math.max(Math.min(sx, sy), sz);
    const lum = f.col[0] * 0.3 + f.col[1] * 0.6 + f.col[2] * 0.1; if (lum < 0.45) continue;   // dark screens / off panels
    let col = f.col.slice(); const m = Math.max(col[0], col[1], col[2], 1e-3); col = col.map(v => Math.min(1, v / m));
    if (cz >= CEIL_Z && big <= 1.6) cand.push({ x: cx, y: cy, z: cz - 0.55, col, R: 22, k: 1, w: 3 });                                  // bulb / pendant
    else if (cz >= CEIL_Z && big > 6) { const a = sx >= sy; const L = a ? sx : sy, n = Math.max(1, Math.round(L / 14)); for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; cand.push({ x: a ? lerp(f.mn[0], f.mx[0], t) : cx, y: a ? cy : lerp(f.mn[1], f.mx[1], t), z: cz - 0.7, col, R: 24, k: 0.85, w: 2 }); } }   // overhead LED rail
    else if (big >= 2.5 && small <= 1.2 && cz < CEIL_Z) { const a = sx >= sy; cand.push({ x: cx, y: cy, z: cz + 0.2, col, R: 12, k: 0.45, w: 1 }); }                          // LED strip (under-cabinet, aisle neon, tub rim)
  }
  const rooms = new Map();
  for (const c of cand) { let ri = R.classify(c.x, c.y, c.z + 0.6); if (ri < 0) ri = R.classify(c.x, c.y, c.z - 1.2); c.room = ri; if (ri < 0) continue; if (!rooms.has(ri)) rooms.set(ri, []); rooms.get(ri).push(c); }
  const keep = [];
  for (const [ri, list] of rooms) {   // greedy farthest-point sampling, heaviest first
    list.sort((a, b) => b.w - a.w); const sel = [list[0]];
    while (sel.length < Math.min(MAX_PER_ROOM, list.length)) { let best = null, bd = -1; for (const c of list) { if (sel.includes(c)) continue; let d = 1e9; for (const s of sel) d = Math.min(d, Math.hypot(c.x - s.x, c.y - s.y)); d *= 0.6 + 0.2 * c.w; if (d > bd) { bd = d; best = c; } } if (!best || bd < 4) break; sel.push(best); }
    keep.push(...sel);
  }
  keep.sort((a, b) => a.room - b.room || a.x - b.x || a.y - b.y);
  return keep;
}
if (require.main === module) {
  const { P, C } = readEmit(glb), F = fixtures(P, C), L = plan(F), r2 = v => Math.round(v * 100) / 100;
  const j = { v: 1, upm: 1.78, frame: 'mansion nav frame: x east, y seaward, z up', rooms: R.ROOMS.map(r => r.id), note: 'planned by tools/ariel-home/plan_room_lights.js from the int_emit geometry of the interior GLB; [x, y, z, r, g, b, R (reach, units), k (relative intensity), roomIndex]',
    lights: L.map(c => [r2(c.x), r2(c.y), r2(c.z), r2(c.col[0]), r2(c.col[1]), r2(c.col[2]), c.R, c.k, c.room]) };
  fs.writeFileSync(out, JSON.stringify(j));
  const per = {}; for (const c of L) per[R.ROOMS[c.room].id] = (per[R.ROOMS[c.room].id] || 0) + 1;
  console.log(F.length + ' emissive fixtures -> ' + L.length + ' room lights', JSON.stringify(per), '(' + fs.statSync(out).size + ' B)');
}
module.exports = { readEmit, fixtures, plan };
