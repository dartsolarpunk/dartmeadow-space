// Ariel's necklace + charm solver (ui/dm-necklace-sim.js) and its hook-up (ui/dm-charm.js, index.html) - pure node, no three.js:  node tools/tests/necklace-sim.test.js
//  - the recipe the game uses (DMNecklaceSim.ARIEL colliders -> pre-roll -> mirror -> settle) gives a loop AROUND the neck, resting on the shoulder yoke, outside every body collider,
//    symmetric, the charm hanging from node 0 on the chest, all links intact
//  - chain / charm / body collisions: a node forced into the neck, into the charm, into another link is pushed out; no tunnelling under scripted frame motion (nod, bob, lean) or when gravity
//    points anywhere in her frame (prone, supine, on her side); the loop never leaves her; teleports / mirrored frames reset cleanly; deterministic; no NaN; cheap
//  - hook-up: dm-charm.js nodes / names / bones, the baked chain + charm hidden, ArielCharmRig on Spine02 kept for the hazard LED, ui/dm-necklace-sim.js loaded before dm-charm.js, ?v= tag untouched
'use strict';
const fs = require('fs'), path = require('path'), root = path.join(__dirname, '..', '..');
const SIM = require(path.join(root, 'ui', 'dm-necklace-sim.js'));
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const G0 = [0, -9.81, 0], mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const rigidInv = m => { const t = [m[12], m[13], m[14]]; return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]), 1]; };
// a frame that rotates about x through a pivot 25 cm below the neck (a nod / lean of the upper body) and translates: column-major 4x4
const frame = (a, tx, ty, tz) => { const c = Math.cos(a), s = Math.sin(a), py = -0.25; const T0 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -py, 0, 1], R = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1], T1 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, py, 0, 1], Tt = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]; return mul(Tt, mul(T1, mul(R, T0))); };
const gravityIn = (M, w) => { const iv = rigidInv(M); return [iv[4] * w[1] + iv[0] * w[0] + iv[8] * w[2], iv[5] * w[1] + iv[1] * w[0] + iv[9] * w[2], iv[6] * w[1] + iv[2] * w[0] + iv[10] * w[2]]; };   // world direction -> frame-local
function arielRest(u = 1) { const S = SIM.createAriel(u), caps = SIM.bindCapsules(u), nc = SIM.ARIEL.colliders.length; SIM.settle(S, caps, nc, [0, -9.81 * u, 0], u); return { S, caps, nc }; }

ok(SIM && typeof SIM.create === 'function' && SIM.ARIEL.colliders.length === 4 && SIM.ARIEL.colliders.map(c => c.name).join() === 'neck,yoke,chest,back', 'API + 4 body colliders (neck, yoke, chest, back)');
{ const names = new Set(); for (const c of SIM.ARIEL.colliders) for (const w of [c.wa, c.wb]) { const t = Object.values(w).reduce((a, b) => a + b, 0); ok(Math.abs(t - 1) < 0.011, c.name + ' skin weights sum to 1 (' + t.toFixed(2) + ')'); Object.keys(w).forEach(k => names.add(k)); }
  ok([...names].every(n => ['Spine', 'Spine01', 'Spine02', 'neck', 'Head', 'LeftShoulder', 'RightShoulder'].includes(n)), 'collider ends are skinned to rig bones only: ' + [...names].join(',')); }

// ── the rest pose
const A = arielRest(), S = A.S, N = S.N, X = (i, k) => S.x[i * 3 + k];
ok(S.hasRest && S.stepsDone > 400, 'settle pre-rolled (' + S.stepsDone + ' steps)');
ok(S.penetration(A.caps, A.nc) < 0.0006, 'rest: nothing inside any body collider (deepest ' + (S.penetration(A.caps, A.nc) * 1000).toFixed(2) + ' mm)');
ok(S.maxLinkError() < 0.12 && S.charmError() < 0.02, 'rest: links intact (max stretch ' + (S.maxLinkError() * 100).toFixed(1) + ' %, charm link ' + (S.charmError() * 100).toFixed(2) + ' %)');
let sym = 0; for (let i = 0; i < N; i++) { const j = (N - i) % N; sym = Math.max(sym, Math.abs(X(i, 0) + X(j, 0)), Math.abs(X(i, 1) - X(j, 1)), Math.abs(X(i, 2) - X(j, 2))); }
ok(sym < 1e-9 && Math.abs(X(0, 0)) < 1e-12 && Math.abs(X(N, 0)) < 1e-12, 'rest: mirror-symmetric about x = 0, charm on the centre line');
{ let ang = 0; for (let i = 0; i < N; i++) { const j = (i + 1) % N; let d = Math.atan2(X(j, 0), X(j, 2) + 0.004) - Math.atan2(X(i, 0), X(i, 2) + 0.004); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; ang += d; }
  ok(Math.abs(Math.abs(ang) - 2 * Math.PI) < 0.05, 'rest: the loop goes ROUND the neck axis once (winding ' + (ang / (2 * Math.PI)).toFixed(3) + ')'); }
{ let lo = 9, hi = -9; for (let i = 0; i < N; i++) { lo = Math.min(lo, X(i, 1)); hi = Math.max(hi, X(i, 1)); }
  ok(lo > 0.0 && hi < 0.09, 'rest: the loop sits at the base of the neck (y ' + (lo * 100).toFixed(1) + '..' + (hi * 100).toFixed(1) + ' cm above the neck bone head; shirt rim ~ +4.2..+6.9)');
  ok(X(0, 2) > 0.05 && X(0, 1) > 0.025 && X(0, 1) < 0.06, 'rest: the front node rests on the shirt neckline (' + (X(0, 1) * 100).toFixed(1) + ' cm up, ' + (X(0, 2) * 100).toFixed(1) + ' cm forward)');
  ok(X(0, 1) < X(N / 4, 1) + 0.03 && X(N / 4, 1) > 0.045, 'rest: higher at the sides (on the shoulder yoke) than at the front'); }
ok(X(N, 1) < X(0, 1) - 0.04 && X(N, 1) > -0.13 && X(N, 2) > 0.06, 'rest: the charm hangs from node 0 and lies on the upper chest (tip ' + (X(N, 1) * 100).toFixed(1) + ' cm, ' + (X(N, 2) * 100).toFixed(1) + ' cm forward)');
const A2 = arielRest(); ok(A2.S.x.every((v, i) => v === S.x[i]), 'deterministic: two settles are bit-identical');
{ const B = arielRest(1.9), r = i => B.S.x[i] / 1.9; ok(S.x.every((v, i) => Math.abs(v - r(i)) < 2e-3), 'scales with u (1.9 x body = 1.9 x the loop, within 2 mm)'); }

// ── collisions
{ const T = arielRest(); T.S.x[3 * 3] = 0; T.S.x[3 * 3 + 1] = 0.06; T.S.x[3 * 3 + 2] = 0; T.S.p.set(T.S.x); T.S.step(1 / 60, G0, null, T.caps, T.nc);
  ok(T.S.penetration(T.caps, T.nc) < 0.0006, 'a link forced into the neck is pushed back out (' + (T.S.penetration(T.caps, T.nc) * 1000).toFixed(2) + ' mm left)'); }
{ // contacts in isolation (no links pulling, no gravity): the solver's own pair / charm / body routines
  const s = SIM.createAriel(1), H = s.hooks, n = 6; SIM.settle(s, SIM.bindCapsules(1), 4, [0, -9.81, 0], 1);
  const m = [0, 1, 2].map(k => (s.x[k] + s.x[N * 3 + k]) / 2); for (let k = 0; k < 3; k++) s.x[n * 3 + k] = m[k] + (k === 2 ? 0.0004 : 0);
  H.segPush(n); const a = [s.x[0], s.x[1], s.x[2]], b = [s.x[N * 3], s.x[N * 3 + 1], s.x[N * 3 + 2]], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  let t = ((s.x[n * 3] - a[0]) * d[0] + (s.x[n * 3 + 1] - a[1]) * d[1] + (s.x[n * 3 + 2] - a[2]) * d[2]) / dd; t = Math.max(0.12, Math.min(1, t));
  const dist = Math.hypot(s.x[n * 3] - a[0] - d[0] * t, s.x[n * 3 + 1] - a[1] - d[1] * t, s.x[n * 3 + 2] - a[2] - d[2] * t);
  ok(dist >= 0.9 * (SIM.ARIEL.chain.chainR + SIM.ARIEL.chain.charmR * 0.6), 'chain vs charm: a link lying ON the kite is pushed to its surface (' + (dist * 1000).toFixed(2) + ' mm from its axis, contact radius ' + ((SIM.ARIEL.chain.chainR + SIM.ARIEL.chain.charmR * 0.6) * 1000).toFixed(1) + ' mm; the tip yields by mass share)'); }
{ const s = SIM.createAriel(1), H = s.hooks; SIM.settle(s, SIM.bindCapsules(1), 4, [0, -9.81, 0], 1); for (let k = 0; k < 3; k++) { s.x[10 * 3 + k] = s.x[4 * 3 + k]; } s.x[10 * 3 + 1] += 0.0006;
  H.pair(4, 10, 2 * SIM.ARIEL.chain.chainR); const d = Math.hypot(...[0, 1, 2].map(k => s.x[10 * 3 + k] - s.x[4 * 3 + k])); ok(Math.abs(d - 2 * SIM.ARIEL.chain.chainR) < 1e-9, 'chain vs chain: two overlapping links are separated to exactly 2 x the chain radius (' + (d * 1000).toFixed(2) + ' mm)');
  const w0 = s.w[N] / s.w[3]; ok(Math.abs(w0 - 1 / SIM.ARIEL.chain.charmMass) < 1e-9, 'the charm is ' + SIM.ARIEL.chain.charmMass + ' x heavier than a link (inverse mass ratio ' + w0 + ')'); }
{ const T = arielRest(), s = T.S; for (let k = 0; k < 3; k++) { s.x[N * 3 + k] = [0.0, 0.0, 0.02][k]; } s.p.set(s.x); s.cn.fill(0); s.cnN = 0;   // the tip pushed into the sternum capsule
  s.hooks.pushCaps(N, T.caps, T.nc); ok(s.penetration(T.caps, T.nc) < 0.0006 && s.cnN >= 1 && s.cn[2] / s.cnN > 0.3, 'charm vs body: the tip is lifted out of the chest and reports the surface normal (' + [...s.cn].map(v => v.toFixed(2)).join(',') + ')'); }

// ── under motion
function run(motion, frames, wdir, opt) {
  const T = arielRest(), s = T.S, o = Object.assign({ gdir: wdir || [0, -1, 0] }, opt); let mp = frame(0, 0, 0, 0), maxPen = 0, maxLink = 0, maxDev = 0, nan = false, tipFar = 0, winding = 0, st;
  for (let k = 0; k < frames; k++) { const M = motion(k / 60), D = mul(rigidInv(M), mp); mp = M; const g = gravityIn(M, o.gdir.map(v => v * 9.81)); st = s.step(1 / 60, g, D, T.caps, T.nc);
    maxPen = Math.max(maxPen, s.penetration(T.caps, T.nc)); maxLink = Math.max(maxLink, s.maxLinkError()); let dv = 0; for (let i = 0; i < s.M; i++) { if (!isFinite(s.x[i * 3]) || !isFinite(s.x[i * 3 + 1]) || !isFinite(s.x[i * 3 + 2])) nan = true; dv = Math.max(dv, Math.hypot(s.x[i * 3] - s.rest[i * 3], s.x[i * 3 + 1] - s.rest[i * 3 + 1], s.x[i * 3 + 2] - s.rest[i * 3 + 2])); } maxDev = Math.max(maxDev, dv);
    tipFar = Math.max(tipFar, Math.abs(Math.hypot(...[0, 1, 2].map(q => s.x[N * 3 + q] - s.x[q])) - s.P.charmLen)); }
  return { s, maxPen, maxLink, maxDev, nan, tipFar, resets: s.resets, T }; }
for (const [name, mot, lim] of [['nod 9 deg @2 Hz + 1 cm bob', t => frame(0.16 * Math.sin(2 * Math.PI * 2 * t), 0, 0.01 * Math.sin(2 * Math.PI * 4 * t), 0), 0.06], ['lean 8 deg @1.7 Hz', t => frame(0.14 * Math.sin(2 * Math.PI * 1.7 * t), 0, 0, 0.01 * Math.sin(2 * Math.PI * 1.7 * t)), 0.06], ['hard 12 deg @2 Hz', t => frame(0.21 * Math.sin(2 * Math.PI * 2 * t), 0, 0, 0), 0.08]]) {
  const r = run(mot, 360); ok(!r.nan && r.maxPen < 0.0012 && r.resets === 0 && r.maxLink < 0.25 && r.tipFar < 0.004 && r.maxDev < lim, name + ': no NaN, no tunnelling (' + (r.maxPen * 1000).toFixed(2) + ' mm), 0 resets, links <' + (r.maxLink * 100).toFixed(0) + ' % stretch, charm link intact, loop within ' + (r.maxDev * 100).toFixed(1) + ' cm of home'); }
for (const [name, g] of [['prone (gravity = her forward)', [0, 0, 1]], ['supine (gravity = her back)', [0, 0, -1]], ['on her side', [1, 0, 0]], ['upside down', [0, 1, 0]]]) {
  const r = run(() => frame(0, 0, 0, 0), 300, g); const s = r.s, T = r.T; ok(!r.nan && r.maxPen < 0.0012 && r.tipFar < 0.004, name + ': settles, no NaN, nothing inside the body (' + (r.maxPen * 1000).toFixed(2) + ' mm), charm still on its chain');
  let far = 0; for (let i = 0; i < N; i++) far = Math.max(far, Math.hypot(s.x[i * 3], s.x[i * 3 + 2] - 0, s.x[i * 3 + 1] - 0.03)); ok(far < 0.16, name + ': the loop stays within 16 cm of her neck (' + (far * 100).toFixed(1) + ' cm)'); }
{ const T = arielRest(), s = T.S; const st = s.step(1 / 60, G0, frame(0, 0, 1.0, 0), T.caps, T.nc);
  ok(st === 'reset' && s.resets === 1 && s.x.every((v, i) => v === s.rest[i] || Math.abs(v - s.rest[i]) < 1e-12 + 0.0001), 'a 1 m jump of the frame (teleport) snaps the necklace back to its rest pose'); }
{ const T = arielRest(), s = T.S; s.x[5] = NaN; const st = s.step(1 / 60, G0, null, T.caps, T.nc); ok(st === 'reset' && s.x.every(Number.isFinite), 'a NaN particle triggers a reset, never propagates'); }
{ const T = arielRest(), s = T.S; for (const dt of [0, -1, NaN, 5, 1e-9]) s.step(dt, G0, null, T.caps, T.nc); ok(s.x.every(Number.isFinite) && s.penetration(T.caps, T.nc) < 0.0012, 'odd dt values (0, negative, NaN, 5 s, 1e-9) are clamped'); }
{ const r = run(t => frame(0.1 * Math.sin(2 * Math.PI * 2 * t), 0, 0, 0), 120), r2 = run(t => frame(0.1 * Math.sin(2 * Math.PI * 2 * t), 0, 0, 0), 120); ok(r.s.x.every((v, i) => v === r2.s.x[i]), 'deterministic under motion'); }
{ const T = arielRest(), s = T.S, t0 = process.hrtime.bigint(); let mp = frame(0, 0, 0, 0); for (let k = 0; k < 1000; k++) { const M = frame(0.1 * Math.sin(k / 30), 0, 0, 0), D = mul(rigidInv(M), mp); mp = M; s.step(1 / 60, gravityIn(M, [0, -9.81, 0]), D, T.caps, T.nc); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 1000; ok(ms < 0.6, 'cheap: ' + ms.toFixed(3) + ' ms per frame in node (16 links + charm, 4 capsules, 10 iterations; budget 0.6 ms, a phone is ~3x slower)'); }

// ── hook-up (source contract)
const charm = fs.readFileSync(path.join(root, 'ui', 'dm-charm.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
ok(/ArielNeckRig/.test(charm) && /ArielNecklaceChain/.test(charm) && /ArielKiteCharm/.test(charm) && /name='ArielNecklace'/.test(charm) && /CHAR\.bones\.Spine\|\|CHAR\.bones\.Spine01/.test(charm), "dm-charm.js: ArielNeckRig on the 'Spine' bone > ArielNecklace > ArielNecklaceChain + ArielKiteCharm");
ok(/CHAR\.bones\.Spine02\|\|CHAR\.bones\.Spine01/.test(charm) && /rig\.name='ArielCharmRig'/.test(charm) && /G\.rig=rig/.test(charm), 'dm-charm.js: ArielCharmRig stays on Spine02 (ui/dm-hazard.js parents her chest LED to DMCharm.rig)');
ok(/Charm\|Tube0\*21\$/.test(charm), "dm-charm.js: the baked chain ('Tube021') and charm ('Charm001') are hidden (three strips the dots from node names)");
ok(html.indexOf('ui/dm-necklace-sim.js') > 0 && html.indexOf('ui/dm-necklace-sim.js') < html.indexOf('ui/dm-charm.js'), 'index.html: ui/dm-necklace-sim.js is loaded before ui/dm-charm.js');
ok(/ui\/dm-charm\.js\?v=\d+"/.test(html), "index.html: dm-charm.js carries a numeric ?v= tag");
ok(!/\bMath\.random\b|\bnew (Float32Array|Float64Array|Array)\b/.test(fs.readFileSync(path.join(root, 'ui', 'dm-necklace-sim.js'), 'utf8').split('S.step = function')[1].split('S.maxLinkError')[0]), 'step() allocates nothing and is deterministic (no Math.random / new arrays in the hot path)');
console.log(fails ? fails + ' FAILED' : 'all ok'); process.exit(fails ? 1 : 0);
