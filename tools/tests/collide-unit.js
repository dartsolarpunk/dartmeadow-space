// node tools/tests/collide-unit.js — synthetic scenes for ui/dm-collide.js (DMCollide): no tunnelling at 15 fps, slide / step / slope, pooling, events, costs.
'use strict';
globalThis.window = undefined; require('../../ui/dm-collide.js'); const L = globalThis.DMCollideLib;
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, e, m) => ok(Math.abs(a - b) <= e, m + ' (' + a.toFixed(3) + ' vs ' + b.toFixed(3) + ')');
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const mk = (o) => L.create(o);

// 1. broadphase + pooling ------------------------------------------------------------------------------------------------
{ const W = mk(); const ids = [];
  for (let k = 0; k < 3; k++) { for (let i = 0; i < 500; i++) ids.push(W.addEllipsoid('chunk#a', rnd() * 300, 1, rnd() * 300, 1 + rnd(), 1, 'rock')); ok(W.count() === 500, 'count after add ' + W.count()); ok(W.groupCount('chunk#a') === 500, 'group count'); ok(W.clearGroup('chunk#a') === 500, 'clearGroup'); ok(W.count() === 0, 'pooled back to 0 round ' + k); ids.length = 0; }
  const peak = W.stats.peak; for (let r = 0; r < 30; r++) { for (let i = 0; i < 400; i++) W.addCylinder('c' + (r % 3), rnd() * 200, 0, 3, rnd() * 200, 0.3, 'wood'); W.clearGroup('c' + (r % 3)); }
  ok(W.count() === 0 && W.stats.overflow === 0, 'churn leaves no leak/overflow'); ok(W.stats.peak <= 500 + 400, 'peak bounded ' + W.stats.peak);
  // entry pool restored: fill to capacity of a different layout many times, should still be able to add the same number
  for (let r = 0; r < 5; r++) { for (let i = 0; i < 3000; i++) W.addBox('big', rnd() * 500, 1, rnd() * 500, 1, 1, 1, rnd() * 3, 'stone'); ok(W.count() === 3000, 'refill ' + r); W.clearGroup('big'); }
  // O(1) lookup: query cost independent of total colliders
  const t = (N) => { const V = mk({ capacity: 20000 }); for (let i = 0; i < N; i++) V.addSphere('s', rnd() * 3000, 1, rnd() * 3000, 0.5, 'rock'); const t0 = process.hrtime.bigint(); let s = 0; for (let i = 0; i < 20000; i++) s += V.query(100, 100, 112, 112); return Number(process.hrtime.bigint() - t0) / 20000; };
  const a = t(200), b = t(16000); ok(b < a * 6 + 2000, 'query cost O(1)-ish: 200 -> ' + a.toFixed(0) + ' ns, 16000 -> ' + b.toFixed(0) + ' ns'); }

// 2. character: wall, slide, tunnelling at dt spikes --------------------------------------------------------------------
function dts(frames, spike) { const a = []; for (let i = 0; i < frames; i++) { const r = rnd(); a.push(r < 0.1 ? spike : r < 0.5 ? 1 / 15 : 1 / 60); } return a; }
{ const W = mk(); W.addBox('wall', 10, 2, 0, 0.1, 3, 400, 0, 'stone');   // thin wall, 0.2 thick, x = 9.9..10.1
  const c = W.makeChar({ x: 0, y: 0, z: 0 }); let maxX = -1e9, crossed = false;
  for (const dt of dts(600, 0.25)) { W._dt = dt; W.walk(c, 30 * dt, 0); maxX = Math.max(maxX, c.x); if (c.x > 10) crossed = true; }
  ok(!crossed, 'no tunnelling through a 0.2 wall at run speed with 15 fps + 4 fps spikes (max x ' + maxX.toFixed(3) + ')'); ok(maxX <= 9.9 - 0.7 + 0.01, 'stops at the wall face minus radius ' + maxX.toFixed(3));
  // slide: diagonal into the wall keeps progressing in z
  const d = W.makeChar({ x: 5, y: 0, z: 0 }); for (let i = 0; i < 60; i++) { W._dt = 1 / 15; W.walk(d, 30 / 15 * 0.707, 30 / 15 * 0.707); } near(d.x, 9.2, 0.02, 'slides along the wall: x clamped'); ok(d.z > 40, 'slide keeps z moving ' + d.z.toFixed(1));
  // huge dt (teleport guard): >60 units is re-seated, never inside the wall
  const e = W.makeChar({ x: 9.5, y: 0, z: 0 }); W.walk(e, 100, 0); ok(!(e.x > 9.2 && e.x < 10.8), 'teleport re-seat leaves the wall'); }

// 3. step-up, step too high, stairs, ground snap, climb budget -------------------------------------------------------------
{ const W = mk(); W.addBox('s', 5, 0.25, 0, 1, 0.25, 5, 0, 'stone');   // 0.5 high
  const c = W.makeChar({ x: 0, y: 0, z: 0, ground: () => 0 }); for (let i = 0; i < 10; i++) { W._dt = 1 / 30; W.walk(c, 0.5, 0); } near(c.y, 0.5, 1e-4, 'stepped up a 0.5 ledge (x ' + c.x.toFixed(1) + ')');
  for (let i = 0; i < 20; i++) { W._dt = 1 / 30; W.walk(c, 0.5, 0); } near(c.y, 0, 1e-4, 'snapped back down when walking off (grounded)');
  const W2 = mk(); W2.addBox('s', 5, 0.75, 0, 1, 0.75, 5, 0, 'stone'); const d = W2.makeChar({ x: 0, y: 0, z: 0 }); for (let i = 0; i < 40; i++) W2.walk(d, 0.5, 0); ok(d.x <= 4 - 0.7 + 0.02 && d.y === 0, 'a 1.5 high block is a wall, not a step ' + d.x.toFixed(2));
  // stairs: 6 steps of 0.4
  const W3 = mk(); for (let k = 0; k < 6; k++) W3.addBox('st', 3 + k * 1.2 + 0.6, 0.2 + k * 0.2, 0, 0.6, 0.2 + k * 0.2, 3, 0, 'stone'); const s = W3.makeChar({ x: 0, y: 0, z: 0 }); for (let i = 0; i < 80; i++) { W3._dt = 1 / 15; W3.walk(s, 2, 0); }
  near(s.y, 2.4, 0.01, 'climbs a flight of 0.4 stairs at run speed / 15 fps');
  // dome: cannot climb a steep dome in a single frame
  const W4 = mk(); W4.addEllipsoid('d', 0, 0, 0, 4, 6, 'rock'); const m = W4.makeChar({ x: -8, y: 0, z: 0, slope: 0.5 }); W4.walk(m, 7.6, 0); ok(m.y <= m.step + 0.5 * 7.6 + 1e-3, 'climb budget caps a one-frame dome climb: y=' + m.y.toFixed(2));
  // standing on a rock top via supportAt, and landing from a fall at a 15 fps step (vertical tunnelling guard)
  const W5 = mk(); W5.addEllipsoid('r', 0, 0.5, 0, 1.5, 1, 'rock'); near(W5.supportAt(0, 0, 1.45, 0.6, 0.35), 1.5, 1e-3, 'supportAt rock top'); ok(W5.supportAt(0, 0, 0.2, 0.6, 0.35) < -1e8, 'top above feet+step is not support');
  let feet = 6, vy = 0; for (let i = 0; i < 40; i++) { const dt = 1 / 15; vy -= 9.8 * dt; const pf = feet; feet += vy * dt; const s2 = W5.supportAt(0, 0, pf, 0.6, 0.35); if (s2 > -1e8 && feet < s2) { feet = s2; vy = 0; } } near(feet, 1.5, 1e-3, 'lands on the rock from a fall at 15 fps (uses previous feet height)'); }

// 4. dynamic bodies ------------------------------------------------------------------------------------------------------------
{ const W = mk(); W.addBox('floor', 0, -1, 0, 50, 1, 50, 0, 'stone'); const log = []; W.on(e => { log.push([e.type, e.fx, e.speed]); });
  const b = W.addBody({ x: 0, y: 20, z: 0, r: 0.3, mat: 'rock' }); let minY = 1e9, bounce = 0, peakAfter = 0, hit = false;
  for (let i = 0; i < 400; i++) { W.step(1 / 15); const y = W.bodies.y[b]; minY = Math.min(minY, y); if (y < 0.31) hit = true; if (hit) peakAfter = Math.max(peakAfter, y); }
  ok(minY >= 0.3 - 0.05, 'dropped body never sinks below the floor at 15 fps (min y ' + minY.toFixed(3) + ')'); ok(log.some(e => e[0] === 'impact' && e[1] === 'dust'), 'impact event with dust fx for rock'); ok(W.bodies.asleep[b] === 1, 'comes to rest and sleeps');
  const W2 = mk(); W2.addBox('wall', 40, 2, 0, 0.05, 4, 20, 0, 'metal'); const hits = []; W2.on(e => hits.push(e.fx)); const f = W2.addBody({ x: 0, y: 2, z: 0, vx: 160, r: 0.1, mat: 'metal', gravityScale: 0 });
  for (let i = 0; i < 30; i++) W2.step(1 / 15); ok(W2.bodies.x[f] < 40, 'a 160 u/s projectile does not tunnel a 0.1 wall (x ' + W2.bodies.x[f].toFixed(2) + ')'); ok(hits.indexOf('spark') >= 0, 'metal hit reports spark fx');
  // restitution: two materials, rebound height ratio
  const W3 = mk(); W3.addBox('floor', 0, -1, 0, 50, 1, 50, 0, 'metal'); const p = W3.addBody({ x: 0, y: 5, z: 0, r: 0.2, mat: 'plastic', damping: 0 }); let maxRe = 0, landed = false, prev = 5; for (let i = 0; i < 600; i++) { W3.step(1 / 60); const y = W3.bodies.y[p], v = W3.bodies.vy[p]; if (!landed && v > 0) { landed = true; } if (landed) maxRe = Math.max(maxRe, y); prev = y; }
  const e2 = Math.sqrt(0.55 * 0.45); const expect = 0.2 + (5 - 0.2) * e2 * e2; ok(Math.abs(maxRe - expect) / expect < 0.25, 'bounce height follows restitution ' + maxRe.toFixed(2) + ' vs ' + expect.toFixed(2));
  // water: splash event + floats
  const W4 = mk(); W4.setWater(() => 0); W4.setGround(() => -10); const ev = []; W4.on(e => ev.push(e.type)); const wb = W4.addBody({ x: 0, y: 4, z: 0, r: 0.3, mat: 'wood' }); for (let i = 0; i < 300; i++) W4.step(1 / 15);
  ok(ev.indexOf('splash') >= 0, 'splash event on water entry'); ok(Math.abs(W4.bodies.y[wb]) < 0.6 && W4.bodies.y[wb] > -0.6, 'wood floats near the surface ' + W4.bodies.y[wb].toFixed(2));
  const sk = W4.addBody({ x: 3, y: 1, z: 0, r: 0.3, mat: 'metal' }); for (let i = 0; i < 400; i++) W4.step(1 / 15); ok(W4.bodies.y[sk] < -5, 'metal sinks to the floor ' + W4.bodies.y[sk].toFixed(2));
  // body vs body
  const W5 = mk(); W5.setGround(() => 0); const A = W5.addBody({ x: 0, y: 0.3, z: 0, vx: 5, r: 0.3, mat: 'rock', gravityScale: 0 }), B = W5.addBody({ x: 3, y: 0.3, z: 0, r: 0.3, mat: 'rock', gravityScale: 0 }); for (let i = 0; i < 60; i++) W5.step(1 / 15); ok(W5.bodies.vx[B] > 0.5 && W5.bodies.x[B] > 3, 'momentum passes between bodies'); }

// 5. actors ----------------------------------------------------------------------------------------------------------------------
{ const W = mk(); const a = W.addActor(5, 0, 0, 0.7, 3.2, true); const c = W.makeChar({ x: 0, y: 0, z: 0 }); for (let i = 0; i < 40; i++) W.walk(c, 0.5, 0); ok(c.x <= 5 - 1.4 + 0.01, 'a kinematic actor blocks the character ' + c.x.toFixed(2));
  const b = W.addActor(0, 0, 10, 0.7, 3.2, false); const d = W.makeChar({ x: 0, y: 0, z: 10.5 }); W.walk(d, 0, 0.05); const o = [0, 0]; W.actorPush(b, o); ok(Math.abs(o[1]) > 0.0 || Math.abs(d.z - 10.5) > 0, 'soft actors split the push'); }

// 6. soft foliage, rays, sweepSphere, pushOut ---------------------------------------------------------------------------------------
{ const W = mk(); W.addEllipsoid('crown', 0, 6, 0, 1.5, 1.2, 'foliage', 2); const c = W.makeChar({ x: -4, y: 0, z: 0 }); for (let i = 0; i < 20; i++) W.walk(c, 0.5, 0); ok(c.x > 3, 'walkers pass soft foliage'); ok(W.raycast(-5, 6, 0, 1, 0, 0, 10, 0.1) < 0, 'rays ignore soft foliage (camera)');
  ok(W.sweepSphere(-5, 6, 0, 5, 6, 0, 0.2) && W.hit.t < 0.5, 'but projectiles hit it');
  W.addBox('b', 20, 1, 0, 1, 1, 1, 0.7, 'wood'); const out = [0, 0]; const dpt = W.pushOut(20.5, 0, 0.2, 0.7, 3, 0, out); ok(dpt > 0.7, 'pushOut leaves the box ' + dpt.toFixed(2)); }

// 7. relaxDiscs ---------------------------------------------------------------------------------------------------------------------
{ const N = 90, xs = new Float32Array(N), zs = new Float32Array(N), rs = new Float32Array(N), bad = new Uint8Array(N); for (let i = 0; i < N; i++) { xs[i] = rnd() * 300 - 150; zs[i] = rnd() * 300 - 150; rs[i] = 0.4 + rnd() * 2.2; }
  const W = mk(); const left = W.relaxDiscs(xs, zs, rs, N, -150, 150, -150, 150, 0.3, 8, bad); let ov = 0; for (let i = 0; i < N; i++) { ok(xs[i] - rs[i] >= -150 - 1e-3 && xs[i] + rs[i] <= 150 + 1e-3, 'inside chunk bounds'); for (let j = i + 1; j < N; j++) if (!bad[i] && !bad[j]) { const d = Math.hypot(xs[i] - xs[j], zs[i] - zs[j]); if (d < rs[i] + rs[j] - 1e-3) ov++; } }
  ok(ov === 0, 'no overlapping discs remain among kept ones (' + ov + ' overlaps, ' + left + ' flagged)');
  const A = new Float32Array(10).fill(0), B = new Float32Array(10).fill(0), C = new Float32Array(10).fill(1); const w2 = mk(); w2.relaxDiscs(A, B, C, 10, -50, 50, -50, 50, 0, 20); let mind = 1e9; for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) mind = Math.min(mind, Math.hypot(A[i] - A[j], B[i] - B[j])); ok(mind > 1.9, 'coincident discs are separated deterministically ' + mind.toFixed(2)); }

// 7b. pushDiscsFrom (trees away from rocks)
{ const W = mk(); const fx = new Float32Array([0, 10]), fz = new Float32Array([0, 0]), fr = new Float32Array([2, 2]); const xs = new Float32Array([1, 9.5, 40]), zs = new Float32Array([0.5, 0.2, 40]), rs = new Float32Array([0.6, 0.6, 0.6]), bad = new Uint8Array(3);
  const left = W.pushDiscsFrom(xs, zs, rs, 3, fx, fz, fr, 2, 0.3, -50, 50, -50, 50, bad); let clear = true; for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) if (!bad[i] && Math.hypot(xs[i] - fx[j], zs[i] - fz[j]) < rs[i] + fr[j]) clear = false; ok(clear, 'trees pushed clear of rocks (' + left + ' flagged)'); near(xs[2], 40, 1e-6, 'far disc untouched'); }

// 8b. wall rasterisation from triangles: a hollow 12x12 building (4 m walls, 3 m wide door in the south wall with a lintel above 3 m), roof and floor not solid
{ const W = mk(); const pos = [], idx = []; const quad = (a, b, c, d) => { const o = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
  const wall = (x0, z0, x1, z1, y0, y1) => quad([x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]);
  wall(-6, 6, -6, -6, 0, 4); wall(6, -6, 6, 6, 0, 4); wall(-6, -6, 6, -6, 0, 4);                  // west, east, north
  wall(-6, 6, -1.5, 6, 0, 4); wall(1.5, 6, 6, 6, 0, 4); wall(-1.5, 6, 1.5, 6, 3.5, 4);             // south with a door (lintel from y=3.5)
  quad([-6, 4, -6], [6, 4, -6], [6, 4, 6], [-6, 4, 6]); quad([-6, 0, -6], [6, 0, -6], [6, 0, 6], [-6, 0, 6]);     // roof, floor
  const P = new Float32Array(pos), I = new Uint32Array(idx);
  const mesh = { isMesh: true, userData: {}, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 100, 1] }, geometry: { attributes: { position: { count: P.length / 3, getX: (i) => P[i * 3], getY: (i) => P[i * 3 + 1], getZ: (i) => P[i * 3 + 2] } }, index: { count: I.length, getX: (i) => I[i] } } };
  const root = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 100, 1] }, updateMatrixWorld() { }, traverse(f) { f(mesh); } };
  const it = W.fromMeshGen('house', root, { cell: 0.5, layer: 0.5, mat: 'stone' }, 4); let steps = 0, r; while (!(r = it.next()).done) steps++; ok(r.value > 10 && r.value < 200, 'wall boxes merged (' + r.value + ', ' + steps + ' slices)');
  const out = W.makeChar({ x: 104, y: 0, z: 120 }); for (let i = 0; i < 40; i++) W.walk(out, 0, -0.5); ok(out.z > 100 + 6 + 0.7 - 0.1, 'outside: cannot walk through the south wall (z ' + (out.z - 100).toFixed(2) + ')');
  const door = W.makeChar({ x: 100, y: 0, z: 120 }); for (let i = 0; i < 80; i++) W.walk(door, 0, -0.5); ok(door.z < 100 - 4 && door.z > 100 - 6, 'through the 3 m doorway (lintel at 3.5 clears her 3.26 body; z ' + (door.z - 100).toFixed(2) + ')');
  const inside = W.makeChar({ x: 100, y: 0, z: 100 }); for (let i = 0; i < 40; i++) W.walk(inside, 0.5, 0); ok(inside.x < 100 + 6 - 0.7 + 0.1, 'inside: the east wall stops her'); }

// 8. instanced registration + cost ---------------------------------------------------------------------------------------------------
{ const W = mk(); const M = new Float32Array(16 * 64); for (let k = 0; k < 64; k++) { const o = k * 16; M[o] = M[o + 5] = M[o + 10] = k < 60 ? 1.5 : 0; M[o + 15] = 1; M[o + 12] = k * 4; M[o + 13] = 1; M[o + 14] = 2; }
  const it = W.fromInstancedGen('chunk#1', M, 64, { kind: 'ellipsoid', mat: 'rock', k: 0.92 }, 16); let steps = 0, r; while (!(r = it.next()).done) steps++; ok(r.value === 60 && W.count() === 60, 'zero-scale padding skipped (' + r.value + ')'); ok(steps >= 3, 'time-sliced in steps (' + steps + ')'); W.clearGroup('chunk#1');
  // cost: 200 colliders near the player, 16 bodies, 15 fps and 60 fps frames
  const C = mk({ capacity: 4096 }); for (let i = 0; i < 200; i++) { const t = i % 3; const x = rnd() * 60 - 30, z = rnd() * 60 - 30; if (t === 0) C.addEllipsoid('p', x, 0.5, z, 1 + rnd(), 1, 'rock'); else if (t === 1) C.addCylinder('p', x, 0, 4, z, 0.3, 'wood'); else C.addBox('p', x, 1, z, 1.2, 1, 0.6, rnd() * 3, 'stone'); }
  C.setGround(() => 0); for (let i = 0; i < 16; i++) C.addBody({ x: rnd() * 20 - 10, y: 2 + rnd() * 4, z: rnd() * 20 - 10, r: 0.3, vx: rnd() * 4, mat: 'rock' }); const ch = C.makeChar({ x: 0, y: 0, z: 0 }); const N = 2000, t0 = process.hrtime.bigint(); let ang = 0;
  for (let i = 0; i < N; i++) { const dt = i % 4 === 0 ? 1 / 15 : 1 / 60; ang += 0.01; C._dt = dt; C.walk(ch, Math.cos(ang) * 30 * dt, Math.sin(ang) * 30 * dt); C.step(dt); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N; console.log('cost: ' + ms.toFixed(4) + ' ms/frame with 200 colliders + 16 bodies (node; mobile ~5x) pushes/frame ' + (C.stats.pushes / N).toFixed(2) + ' cands ' + (C.stats.cands / C.stats.queries).toFixed(1)); ok(ms < 0.3, 'frame cost < 0.3 ms in node (= < 1.5 ms at 5x slower mobile): ' + ms.toFixed(3)); }

// 9. determinism --------------------------------------------------------------------------------------------------------------------------
{ const run = () => { seed = 99; const W = mk(); for (let i = 0; i < 100; i++) W.addEllipsoid('g', rnd() * 50, 0.5, rnd() * 50, 1, 1, 'rock'); const c = W.makeChar({ x: 0, y: 0, z: 0 }); for (let i = 0; i < 300; i++) W.walk(c, 0.4, 0.3); return c.x.toFixed(5) + ',' + c.z.toFixed(5); }; ok(run() === run(), 'deterministic'); }
console.log(fails ? fails + ' FAILED of ' + n : 'collide-unit: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
