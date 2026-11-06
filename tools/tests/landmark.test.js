// node tools/tests/landmark.test.js — MARK LANDING SPOT: tap-to-terrain target resolution, validation / snap-to-clear, the state machine, marker scale / fade,
// and the mansion landing pads (every patio / deck / court / terrace pad is clear of lamps, planters and walls; plenty of them).
'use strict';
const fs = require('fs'), path = require('path');
globalThis.window = globalThis; globalThis.location = { search: '' };
const LM = require('../../ui/dm-landmark.js'), Z = require('../../ui/dm-landzones.js');
require('../../ui/dm-collide.js'); require('../../ui/dm-collide-game.js'); const W = globalThis.DMCollide;
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
// 1 ─ tap -> terrain
{ const flat = () => 10, hill = (x, z) => 10 + Math.max(0, 40 - Math.hypot(x - 300, z)) * 0.5;
  let p = LM.pickGround([0, 500, 0], norm([0.3, -1, 0.2]), flat); ok(p && Math.abs(p[1] - 10) < 0.05 && Math.abs(p[0] / p[2] - 1.5) < 0.01, 'a tap from 500 m up lands on the ground along the ray (' + p.map(v => v.toFixed(1)) + ')');
  p = LM.pickGround([0, 30, 0], norm([1, -0.2, 0]), flat); ok(p && p[1] > 9.9 && p[0] > 90, 'a near-grazing tap from low altitude still resolves');
  p = LM.pickGround([0, 12, 0], [0, -1, 0], flat); ok(p && Math.abs(p[0]) < 1e-6 && Math.abs(p[1] - 10) < 0.01, 'straight down from near the ground');
  p = LM.pickGround([250, 120, 0], norm([50, -120, 0]), hill); ok(p && Math.abs(p[1] - hill(p[0], p[2])) < 0.05, 'the hit sits on the hill surface, not through it');
  ok(LM.pickGround([0, 500, 0], [0, 1, 0], flat) === null, 'a tap at the sky finds nothing');
  ok(LM.pickGround([0, 5000, 0], norm([1, -0.01, 0]), flat, { maxT: 6000 }) === null, 'beyond the pick range finds nothing'); }
// 2 ─ validation / snap
{ W.setGround(() => 0); W.setWater(() => -1e9, null); W.addCylinder('lamps', 100, 0, 7.8, 100, 0.27, 'metal'); W.addBox('lamps', 100, 0.27, 100, 0.8, 0.27, 0.8, 0, 'stone');
  const o = { ground: () => 0, r: 0.9, h: 3.1, margin: 0.4, bl: 1.5, bw: 0.4, ux: 0, uz: -1, side: [-1.2, 0] };
  const validate = (x, z) => { const r = W.findClear(x, z, o); return { ok: r.ok, x: r.x, z: r.z, moved: r.moved }; };
  let r = LM.resolve(100, 100, validate); ok(r.ok && r.snapped && r.dist > 1 && r.dist < 10, 'a tap on a lamp snaps to the nearest clear spot (' + r.dist.toFixed(1) + ' m)');
  ok(W.clearAt(r.x, r.z, o), 'the snapped spot validates'); r = LM.resolve(300, 300, validate); ok(r.ok && !r.snapped && r.x === 300, 'a clear tap is kept exactly');
  r = LM.resolve(0, 0, (x, z) => ({ ok: false })); ok(!r.ok, 'no clear spot in reach is reported'); }
// 3 ─ state machine
{ const M = LM.create(), V = (x, z) => ({ ok: true, x, z, moved: false }); ok(M.state === 'idle', 'starts idle');
  ok(M.toggle() === 'picking' && M.state === 'picking', 'MARK enters picking'); ok(M.toggle() === 'cancel-picking' && M.state === 'idle', 'MARK again cancels picking');
  M.toggle(); ok(M.tap(null, V).ok === false && M.state === 'picking', 'a tap at the sky keeps picking'); ok(M.tap([5, 0, 6], V).ok && M.state === 'flying' && M.x === 5 && M.z === 6, 'a valid tap starts the flight');
  ok(M.tap([1, 0, 1], V) === null, 'taps while flying are ignored'); ok(M.toggle() === 'cancel-flying' && M.state === 'idle', 'MARK cancels the flight');
  M.toggle(); M.tap([5, 0, 6], V); ok(M.arrive() && M.state === 'landing', 'arrival -> landing'); ok(M.toggle() === 'ignored', 'MARK while landing is ignored'); ok(M.landed() && M.state === 'idle', 'landed -> idle');
  M.toggle(); M.tap([5, 0, 6], V); ok(M.cancel() && M.state === 'idle', 'the stick / LAND / leaving the sky cancels'); ok(!M.cancel(), 'cancel when idle is a no-op'); ok(M.toggle(false) === 'ignored', 'cannot start while a manoeuvre runs');
  const B = LM.create(); B.toggle(); ok(B.tap([1, 0, 1], () => ({ ok: false })).why === 'blocked' && B.state === 'picking', 'no clear spot: stays in picking'); }
// 4 ─ marker scale / fade
{ ok(LM.scaleAt(10) === 1 && LM.scaleAt(800) === 10 && LM.scaleAt(1e6) === 60, 'marker scale: 1 up close, grows with distance, capped'); ok(LM.fade(0) === 0 && LM.fade(100) === 1 && LM.fade(26) > 0.2 && LM.fade(26) < 0.8, 'marker fades out as the craft sets down'); }
// 5 ─ mansion landing pads
{ const R = p => path.join(__dirname, '../../assets/ariel-home', p), nav = JSON.parse(fs.readFileSync(R('ariel-home-interior-nav.json'), 'utf8')), L = JSON.parse(fs.readFileSync(R('ariel-home-lamps.json'), 'utf8')).lamps, c = JSON.parse(fs.readFileSync(R('ariel-home-collide.json'), 'utf8'));
  const b = Buffer.from(c.data, 'base64'), g = new Float64Array(c.nx * c.ny); for (let i = 0; i < g.length; i++) g[i] = b.readInt16LE(i * 2) / c.scale;
  const pads = Z.build(nav, L), terr = Z.buildGrid(nav, L, g, c); ok(pads.length >= 8, 'decks / patios / courts / prow: ' + pads.length + ' planned pads'); ok(terr.length >= 12, 'terraces + plateau from the collision grid: ' + terr.length + ' pads');
  const kinds = new Set(pads.concat(terr).map(p => p.kind)); ok(kinds.has('deck') && kinds.has('prow') && kinds.has('terrace'), 'kinds: ' + [...kinds].join(','));
  let bad = 0; for (const p of pads.concat(terr)) { for (const l of L) if (Math.abs(l[2] - p.z) < 2.5 && Math.hypot(l[0] - p.x, l[1] - p.y) < p.r) bad++; for (const o of nav.obs) if (Math.abs(o[4] - p.z) <= 2.5 || o[5] >= p.z + 0.2) { const dx = Math.max(o[0] - p.x, 0, p.x - o[2]), dy = Math.max(o[1] - p.y, 0, p.y - o[3]); if (Math.hypot(dx, dy) < p.r - 1e-6) bad++; } }
  ok(bad === 0, 'no lamp or planter / furniture box inside any pad (' + bad + ')');
  const hall = nav.rooms[0]; ok(!pads.concat(terr).some(p => p.x > hall[1] && p.x < hall[3] && p.y > hall[2] && p.y < hall[4]), 'no pad inside the roofed hall');
  Z.set(pads.concat(terr), (x, y, zz, o) => { o[0] = x; o[1] = zz; o[2] = -y; }, 1); ok(Z.count() === pads.length + terr.length, 'registered'); const nz = Z.nearest(0, 20, 90); ok(nz && nz.dist < 60, 'a pad is near the prow (' + (nz && nz.dist.toFixed(0)) + ' m)');
  const sk = [nz.i]; const nz2 = Z.nearest(0, 20, 90, sk); ok(nz2 && nz2.i !== nz.i, 'skip list returns the next pad'); Z.clear(); ok(Z.count() === 0, 'cleared'); }
console.log(fails ? fails + ' FAILED of ' + n : 'landmark: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
