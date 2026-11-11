// node tools/tests/orbit-enclosed.js — ui/dm-orbit-clamp.js against a mock collider (a walled room with a ceiling, and open sky). Headless maths only.
'use strict';
const C = require('../../ui/dm-orbit-clamp.js');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } else if (process.env.VERBOSE) console.log('  ok', m); };
// room: x,z in [-4,4], floor y=0, ceiling y=3; ray from inside -> distance to the nearest face (slab method), -1 if none within maxD
function roomRay(ox, oy, oz, dx, dy, dz, maxD, rr) {   // rr = probe sphere radius (DMCollide.raycast is a swept sphere): the room shrinks by it
  rr = rr || 0; let t = Infinity; const f = (o, d, lo, hi) => { if (d > 1e-9) t = Math.min(t, (hi - o) / d); else if (d < -1e-9) t = Math.min(t, (lo - o) / d); };
  f(ox, dx, -4 + rr, 4 - rr); f(oy, dy, rr, 3 - rr); f(oz, dz, -4 + rr, 4 - rr); return t <= maxD ? t : -1;
}
const sky = () => -1;
const head = { x: 0, y: 2.2, z: 0 }, want = { x: 9, y: 4.5, z: 9 };   // the default ORBIT spot: far out and up -- outside the room
const run = (st, h, w, ray, secs, o) => { let r; for (let t = 0; t < secs; t += 1 / 60) r = C.update(st, h, w, 1 / 60, ray, o); return r; };
const inside = r => r.x > -4 && r.x < 4 && r.z > -4 && r.z < 4 && r.y > 0 && r.y < 3;

// 1. enclosed room: camera ends up inside the walls with the margin, along head->want
let st = C.create(), r = C.update(st, head, want, 1 / 60, roomRay, { unit: 1, near: 0.1 });
ok(r.enclosed && r.clamped, 'room is detected as enclosed on the first frame');
ok(inside(r), 'first frame is already inside the room (' + [r.x, r.y, r.z].map(v => v.toFixed(2)) + ')');
r = run(st, head, want, roomRay, 2, { unit: 1, near: 0.1 });
const hit = roomRay(head.x, head.y, head.z, ...(() => { const D = Math.hypot(9, 2.3, 9); return [9 / D, 2.3 / D, 9 / D]; })(), 99), dist = Math.hypot(r.x - head.x, r.y - head.y, r.z - head.z);
ok(inside(r), 'settled position is inside the room');
const hitR = roomRay(head.x, head.y, head.z, 9 / 13.0, 2.3 / 13.0, 9 / 13.0, 99, 0.2);
ok(Math.abs(dist - (hitR - (0.35 + 0.15))) < 0.15, 'settles at first (swept-sphere) hit minus margin and near-plane clearance: ' + dist.toFixed(3) + ' vs ' + (hitR - 0.5).toFixed(3));
ok(r.y < 3 - 0.2, 'stays under the ceiling with clearance (y ' + r.y.toFixed(2) + ')');
// 2. keeps running while orbiting: sweep yaw/pitch, the camera never leaves the room on any frame
st = C.create(); let bad = 0, maxRays = 0, frames = 0;
for (let k = 0; k < 600; k++) {
  const yaw = k * 0.03, pit = -0.3 + 1.2 * Math.abs(Math.sin(k * 0.011)), d = 9 + 3 * Math.sin(k * 0.05);
  const w = { x: head.x + Math.sin(yaw) * Math.cos(pit) * d, y: head.y + Math.sin(pit) * d, z: head.z + Math.cos(yaw) * Math.cos(pit) * d };
  const q = C.update(st, head, w, 1 / 60, roomRay, { unit: 1, near: 0.1 }); frames++; maxRays = Math.max(maxRays, st.rays);
  if (!(q.y > 0 && q.y < 3 && Math.abs(q.x) < 4 && Math.abs(q.z) < 4)) bad++;
}
ok(bad === 0, 'orbit sweep: camera inside the room on every frame (bad ' + bad + ')');
ok(maxRays <= 6, 'ray budget: at most 6 per frame (peak ' + maxRays + ')');
// 3. no snap through: a sudden jump of the wanted position to straight through a wall pulls in, never emerges
st = C.create(); run(st, head, { x: 0, y: 2.2, z: 3 }, roomRay, 1, { unit: 1, near: 0.1 });
r = C.update(st, head, { x: 0, y: 2.2, z: 12 }, 1 / 60, roomRay, { unit: 1, near: 0.1 }); ok(inside(r), 'sudden far target: clamped on that very frame');
// 4. open sky: untouched, no clamp ray, no state
st = C.create(); let same = true, rays = 0;
for (let k = 0; k < 120; k++) { const q = C.update(st, head, want, 1 / 60, sky, { unit: 1, near: 0.1 }); if (q.x !== want.x || q.y !== want.y || q.z !== want.z || q.enclosed || q.clamped) same = false; rays += st.rays; }
ok(same, 'open sky: returned position is exactly the wanted position, never enclosed');
ok(rays / 120 < 1, 'open sky: probe cost is tiny (' + (rays / 120).toFixed(2) + ' rays/frame avg, 5 Hz overhead probe only)');
// ceiling only (a roof, open sides): up hit but no cone hits -> NOT enclosed (lone flat lid is not a room) ; a canopy-sized lid with cone hits IS
const lid = (ox, oy, oz, dx, dy, dz, maxD) => { if (dy <= 0.05) return -1; const t = (3 - oy) / dy, x = ox + dx * t, z = oz + dz * t; return t <= maxD && Math.abs(x) < 0.5 && Math.abs(z) < 0.5 ? t : -1; };
st = C.create(); r = run(st, head, want, lid, 1, { unit: 1 }); ok(!r.enclosed, 'a thin patch directly overhead alone does not count as enclosed');
// 5. hysteresis: leaving the room does not flip back at once; after EXIT_T of clear probes it releases, easing out (no snap) then plain orbit
st = C.create(); run(st, head, want, roomRay, 1, { unit: 1, near: 0.1 }); ok(st.enclosed, 'enclosed inside the room');
let flips = 0, last = st.enclosed; for (let k = 0; k < 40; k++) { const flick = (k % 2) ? roomRay : sky; C.update(st, head, want, 1 / 60, flick, { unit: 1 }); if (st.enclosed !== last) { flips++; last = st.enclosed; } }
ok(flips === 0, 'flickering probe (alternate hit / clear per frame): no flip (flips ' + flips + ')');
let t = 0, left = -1; while (t < 3) { C.update(st, head, want, 1 / 60, sky, { unit: 1 }); t += 1 / 60; if (!st.enclosed && left < 0) left = t; }
ok(left >= C._k.EXIT_T - 0.25 && left <= C._k.EXIT_T + 0.4, 'leaves enclosed state after ~EXIT_T of clear probes (' + left.toFixed(2) + ' s)');
r = C.update(st, head, want, 1 / 60, sky, { unit: 1 }); ok(!r.enclosed, 'released');
// release eases out rather than teleporting
st = C.create(); run(st, head, want, roomRay, 1, { unit: 1, near: 0.1 }); const near0 = st.d; run(st, head, want, sky, 0.9, { unit: 1 }); ok(st.d === null || st.d > near0, 'after leaving, camera eases back out toward the wanted distance');
r = run(st, head, want, sky, 4, { unit: 1 }); ok(r.x === want.x && r.y === want.y && r.z === want.z && st.d === null, 'then returns to the exact existing orbit position');
// 6. toggle off/on re-evaluates: reset clears, a different structure is picked up on the first frame
st = C.create(); run(st, head, want, roomRay, 1, { unit: 1 }); C.reset(st); ok(!st.enclosed && st.d === null, 'reset (toggle) clears the enclosed decision');
r = C.update(st, head, want, 1 / 60, sky, { unit: 1 }); ok(!r.enclosed && r.x === want.x, 'toggled on under open sky: nothing special');
console.log(fails ? fails + ' FAILED of ' + n : 'orbit-enclosed: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
