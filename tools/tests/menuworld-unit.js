// node tools/tests/menuworld-unit.js — pure logic of ui/dm-menuworld.js (tiers, star field, box merge, sun placement, light rig, parallax, orbit camera).
'use strict';
const assert = require('assert'), MW = require('../../ui/dm-menuworld.js'); let n = 0; const ok = (c, m) => { n++; assert(c, m); };
// modes + tiers
ok(MW.parseMode('?menuscene=off') === 'off' && MW.parseMode('?a=1&menuscene=0') === 'off' && MW.parseMode('?menuscene=low') === 'low' && MW.parseMode('') === 'auto' && MW.parseMode('?menuscene=zzz') === 'auto', 'parseMode');
ok(MW.tierFor({ mode: 'off' }).on === false && MW.tierFor({ mode: 'low' }).name === 'low', 'off / low forced');
ok(MW.tierFor({ isMobile: false, pressure: 0 }).name === 'high' && MW.tierFor({ isMobile: false, pressure: 4 }).name === 'mid' && MW.tierFor({ isMobile: false, pressure: 8 }).name === 'low', 'desktop tiers drop with budget pressure');
ok(MW.tierFor({ isMobile: true, pressure: 0 }).name === 'mid' && MW.tierFor({ isMobile: true, pressure: 5 }).name === 'low', 'mobile starts mid, low under pressure');
const H = MW.TIERS.high, M = MW.TIERS.mid, L = MW.TIERS.low;
ok(L.stars < M.stars && M.stars < H.stars && L.planetOct <= M.planetOct && M.planetOct < H.planetOct && L.prCap <= M.prCap && M.prCap <= H.prCap && !M.band && !L.band, 'mobile tiers are strictly cheaper');
ok(M.prCap <= 1.25 && L.prCap <= 1, 'pixel-ratio caps on mobile tiers');
// star field
const st = MW.starfield([{ n: 500, dist: 1000, ang: [0.001, 0.004] }, { n: 100, dist: 50, size: [0.02, 0.05] }], 3), st2 = MW.starfield([{ n: 500, dist: 1000, ang: [0.001, 0.004] }, { n: 100, dist: 50, size: [0.02, 0.05] }], 3);
ok(st.length === 600 && JSON.stringify(st) === JSON.stringify(st2), 'deterministic count');
ok(st.every((s) => Math.abs(Math.hypot(s.x, s.y, s.z) - 1) < 1e-9 && s.a >= 0.35 && s.a <= 1 && s.size > 0), 'unit directions, sane brightness / size');
ok(st.slice(0, 500).every((s) => Math.abs(s.size / 1000 - Math.min(Math.max(s.size / 1000, 0.001), 0.004)) < 1e-12), 'angular size range');
ok(Math.abs(st.slice(0, 500).reduce((a, s) => a + s.z, 0) / 500) < 0.15, 'roughly uniform over the sphere');
const hemi = MW.starfield([{ n: 300, dist: 100, size: [1, 2] }], 4, { hemi: true }); ok(hemi.every((s) => s.z < -0.2 && Math.abs(Math.hypot(s.x, s.y, s.z) - 1) < 1e-9), 'forward cap for the card scene');
const q = MW.starQuads(st.slice(0, 10)); ok(q.pos.length === 120 && q.idx.length === 60 && q.col.length === 160 && q.uv.length === 80, 'quad buffer sizes');
for (let i = 0; i < 10; i++) { const s = st[i]; const c = [0, 1, 2, 3].map((k) => [q.pos[i * 12 + k * 3], q.pos[i * 12 + k * 3 + 1], q.pos[i * 12 + k * 3 + 2]]); const mid = [0, 1, 2].map((a) => (c[0][a] + c[2][a]) / 3 * 0 + (c[0][a] + c[2][a]) / 2);
  ok(Math.abs(Math.hypot(...mid) - 1000) < 1.5, 'quad centred at dist'); const e = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]); ok(Math.abs(e - s.size) < 1e-3 * Math.max(1, s.size), 'quad edge = size'); }
// boxes
const mb = MW.mergeBoxes([{ c: [0, 0, 0], s: [2, 2, 2], ph: 0.5 }, { c: [10, 1, 0], s: [1, 4, 1] }]);
ok(mb.pos.length === 144 && mb.idx.length === 72 && Math.max(...mb.idx) === 47 && mb.ph[0] === 0.5 && mb.ph[24] === 0, 'merged boxes sizes + phase');
let nrmOk = true; for (let v = 0; v < 48; v++) { if (Math.abs(Math.hypot(mb.nrm[v * 3], mb.nrm[v * 3 + 1], mb.nrm[v * 3 + 2]) - 1) > 1e-6) nrmOk = false; } ok(nrmOk, 'unit normals');
for (let t = 0; t < 24; t++) { const i0 = mb.idx[t * 3], i1 = mb.idx[t * 3 + 1], i2 = mb.idx[t * 3 + 2], P = (i) => [mb.pos[i * 3], mb.pos[i * 3 + 1], mb.pos[i * 3 + 2]];
  const a = P(i0), b = P(i1), c = P(i2), u = b.map((x, k) => x - a[k]), w = c.map((x, k) => x - a[k]), cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const dn = cr[0] * mb.nrm[i0 * 3] + cr[1] * mb.nrm[i0 * 3 + 1] + cr[2] * mb.nrm[i0 * 3 + 2]; ok(dn > 0, 'triangle ' + t + ' winds outward'); }
// sun placement: inside the frame for any stage aspect
for (const asp of [0.5, 0.8, 1.2, 1.8]) { const s = MW.sunDirFor(asp, 30, -1, 9, 0.62), hf = Math.atan(Math.tan(15 * Math.PI / 180) * asp), az = Math.atan2(-s[0], -s[2]), el = Math.asin(s[1]);
  ok(Math.abs(Math.hypot(...s) - 1) < 1e-9 && s[0] < 0 && s[2] < 0 && Math.abs(az) < hf && Math.abs(el) < 15 * Math.PI / 180, 'sun in frame at aspect ' + asp); }
ok(MW.sunDirFor(1.5, 50, 1, 13, 0.55)[0] > 0, 'side +1 puts the sun right');
// light rig: rim comes from the sun side (behind her), key from the front
const sun = MW.sunDirFor(1.2, 30, -1, 9, 0.62), rig = MW.lightRig(sun);
ok(rig.rim.dir[2] < 0 && rig.rim.dir[0] < 0 && rig.rim.dir[1] > 0 && rig.key.dir[2] > 0 && rig.key.dir[1] > 0, 'rim from the sun (behind-left-above), key from front-right');
const br = MW.bayStudioRig('studio'), bc = MW.bayStudioRig('cards');
ok(br && bc && br.key && br.spot && br.rim && br.hemi && br.fill && br.fixture, 'bayStudioRig returns the studio spotlight fields');
ok(br.key.dir[0] > 0 && br.key.dir[1] > 0 && br.key.dir[2] > 0, 'studio key is front-3/4 (right, above, toward camera)');
ok(br.rim.dir[2] < 0 && br.rim.color === 0x8fb0ff, 'studio rim is cool from the window / planet side');
ok(br.hemi.intensity <= 0.85 && br.fill.intensity <= 0.5 && bc.hemi.intensity <= 0.9, 'ambient stays modest so black hair does not wash out');
ok(br.spot.intensity > 0 && br.spot.angle > 0 && br.spot.distance > 0 && br.spot.penumbra > 0, 'crisp key spotlight is present');
ok(bc.spot.distance > br.spot.distance && bc.spot.intensity >= br.spot.intensity, 'cards rig covers the wider observation deck');
ok(br.fixture.intensity > 0 && bc.fixture.distance > br.fixture.distance, 'fixture point lights scale with the bay');
ok(MW.STUDIO_CAM && MW.STUDIO_CAM.maxY < 4.25 && MW.STUDIO_CAM.maxR < 5.45 && MW.STUDIO_CAM.minY > 0, 'studio camera clamp stays inside the scaled bay');

// parallax + sway
ok(MW.parallaxOffset([1, 2, 3], [0, 0, 0], 10).join() === '-10,-20,-30' && MW.parallaxOffset([1, 1, 1], [1, 1, 1], 99).every((v) => v === 0 || Object.is(v, -0)), 'parallax offset');
ok(MW.PARALLAX_K.starsFar < MW.PARALLAX_K.starsMid && MW.PARALLAX_K.starsMid < MW.PARALLAX_K.starsNear && MW.PARALLAX_K.planet < MW.PARALLAX_K.starsFar, 'nearer layers shift more');
let mx = 0; for (let t = 0; t < 600; t += 0.5) { const s = MW.swayAt(t, 0.1); mx = Math.max(mx, Math.abs(s.x), Math.abs(s.y)); } ok(mx <= 0.16 + 1e-9 && mx > 0.05, 'sway bounded');
// orbit camera
const Hh = 1.7, d0 = 3.9, rad = (x) => x * Math.PI / 180; let prevTy = null;
for (let deg = -90; deg <= 100; deg += 1) {
  const r = MW.orbitRig(rad(deg), Hh, d0, 1, 0), r2 = MW.orbitRig(rad(deg), Hh, d0, 0.45, 0); ok(Number.isFinite(r.ty + r.camY + r.camR + r.dist), 'finite ' + deg);
  ok(r.camY >= 0.14 - 1e-9 && r2.camY >= 0.14 - 1e-9, 'never below the floor at ' + deg); ok(r.pitch <= MW.PITCH_MAX + 1e-12 && r.pitch >= MW.PITCH_MIN - 1e-12, 'pitch clamped');
  if (prevTy != null) ok(r.ty >= prevTy - 1e-9, 'target height rises with pitch'); prevTy = r.ty;
  const dist3 = Math.hypot(r.camR, r.camY - r.ty); ok(Math.abs(dist3 - r.dist) < 0.02 || deg < -20, 'camera sits on the orbit sphere above the floor');
}
const lvl = MW.orbitRig(0, Hh, d0, 1, 0), low = MW.orbitRig(rad(-75), Hh, d0, 1, 0), top = MW.orbitRig(rad(85), Hh, d0, 1, 0);
ok(Math.abs(lvl.ty - Hh * 0.5) < 1e-9 && Math.abs(lvl.camR - d0) < 1e-9 && Math.abs(lvl.camY - Hh * 0.5) < 1e-9, 'level = the old framing');
ok(low.ty < 0.45 * Hh && low.ty < lvl.ty && low.dist < lvl.dist * 0.6 && low.camY < 0.3, 'feet close-up: target low, closer, camera near the floor');
ok(top.ty > 0.78 * Hh && top.camY > Hh * 1.5 && top.camR < 0.2 * d0, 'top view: target at the head, camera over her');
ok(MW.orbitRig(0, Hh, d0, 1, 1).ty > lvl.ty && MW.orbitRig(0, Hh, d0, 1, -1).ty < lvl.ty && MW.orbitRig(0, Hh, d0, 1, -50).ty >= 0.05, 'two-finger target nudge, clamped above the floor');
ok(MW.orbitRig(0, Hh, d0, 0.5, 0).dist < lvl.dist, 'zoom still scales the orbit');
ok(Math.abs(MW.nearestYaw(0.35 + 6.2832 * 3 + 0.1, 0.35) - (0.35 + 6.2832 * 3)) < 1e-3, 'nearestYaw takes the closest turn');
// governor: steady 33 ms frames never step; 70 ms frames step down, floor 0.6, kept
{ const g = MW.makeGovernor(); let dropped = 0; for (let i = 0; i < 600; i++) if (g.step(33.3)) dropped++; ok(dropped === 0 && g.scale === 1, 'a 30 fps menu is left alone');
  for (let i = 0; i < 600; i++) if (g.step(70)) dropped++; ok(dropped >= 3 && Math.abs(g.scale - 0.6) < 1e-9, 'a slow menu steps the pixel ratio down to the 0.6 floor (' + dropped + ' steps)');
  const g2 = MW.makeGovernor(); for (let i = 0; i < 8; i++) g2.step(120); for (let i = 0; i < 200; i++) g2.step(30); ok(g2.scale === 1, 'a short hitch does not step'); }

// cargo-bay placement (canonical 16 x 18 x 10, opening at z=-8)
ok(MW.placeBayTransform && MW.BAY_REF && MW.BAY_REF.w === 16 && MW.BAY_REF.openZ === -8, 'bay ref exported');
{ const s = MW.placeBayTransform('studio'); ok(Math.abs(s.sx - 6.8 / 16) < 1e-9 && Math.abs(s.z - (-2.2 - (-8) * s.sz)) < 1e-9 && s.y === 0, 'studio scales width 6.8 and lines the opening up at z=-2.2');
  const c = MW.placeBayTransform('cards'); ok(Math.abs(c.sx - 24 / 16) < 1e-9 && Math.abs(c.z - (-9.2 - (-8) * c.sz)) < 1e-9, 'cards scales width 24 and lines the opening up at z=-9.2');
  const Lz = 30, Wx = 18, Hy = 9, L = MW.placeBayTransform('launch', { w: Wx, d: Lz, h: Hy, openZ: -Lz / 2 });
  ok(Math.abs(L.sx - Wx / 16) < 1e-9 && Math.abs(L.sy - Hy / 10) < 1e-9 && Math.abs(L.sz - Lz / 18) < 1e-9, 'launch scales each axis to the hangar');
  ok(Math.abs((-Lz / 2) - (L.z + (-8) * L.sz)) < 1e-9, 'launch opening sits at -Lz/2'); }
console.log('menuworld-unit OK (' + n + ' checks)');
