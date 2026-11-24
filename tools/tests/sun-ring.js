// node tools/tests/sun-ring.js — t1537: no lit ring / pool of light follows her on foot.
// Root cause (deck-wide.jpg, flashlight off): the sun shadow map is eased out inside its own box (ui/dm-light.js receivedShadowNode wrapper, wMap over U.sm) and on foot
// ui/dm-polish.js fitSun tightened that box to 0.62x (28 u on a 512 map), so with ui/dm-lod.js qualityBands' [0.6 h, 0.92 h] the sun shadow was gone 17-26 u from her:
// every roofed / overhung floor past that turned fully sunlit, a ring round her (the third-person camera sits ~26 u back, right on it).
// Pins: (1) no on-foot tightening; (2) the ease-out sits at the box's edge [0.82 h, 0.97 h], inside the inscribed circle (no square edge); (3) on every map size and on the
// budget ladder's halved map the shadow is still full strength at the third-person camera's distance and well past it; (4) the wrapper still only touches the sun map
// (the flashlight's shadow passes untouched) and nothing else in DMLight lights a radial disc (the bounce / AO hand-off fades to the far term, not to a brighter value).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const L = require(path.join(root, 'ui/dm-lod.js'));
const sm = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// ── (1) fitSun: the on-foot box is the tier's full box ──
const win = {}; const ctx = { window: win, location: { search: '' }, performance: { now: () => 0 }, console, Math };
vm.createContext(ctx); vm.runInContext(rd('ui/dm-polish.js'), ctx);
const P = win.DMPolish;
ok(P && typeof P.fitSun === 'function', 'DMPolish.fitSun loads');
ok(P.TIGHT_K === 1, 'on-foot box factor is 1 (was 0.62: the 28 u box)');
const WIDE = { 512: 45, 1024: 70, 2048: 110, 4096: 150 };
function mkSun(size) {
  const v = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
  return { shadow: { mapSize: { x: size, y: size }, camera: { left: -1, right: 1, top: 1, bottom: -1, updateProjectionMatrix() {} }, bias: 0, normalBias: 0 },
    position: v(), target: { position: v(), updateMatrixWorld() {} } };
}
const dir = { x: 0.4, y: 0.8, z: 0.45 }; { const l = Math.hypot(dir.x, dir.y, dir.z); dir.x /= l; dir.y /= l; dir.z /= l; }
for (const size of [512, 1024, 2048, 4096]) {
  P._S.half = 0; const sun = mkSun(size);
  for (let i = 0; i < 400; i++) P.fitSun(sun, dir, 10 + i * 0.01, 5, -3, true);   // walking
  const hWalk = sun.shadow.camera.right;
  P._S.half = 0; const sun2 = mkSun(size); for (let i = 0; i < 400; i++) P.fitSun(sun2, dir, 10, 5, -3, false);
  ok(Math.abs(hWalk - WIDE[size]) <= 0.5, size + ': on-foot box half ' + hWalk + ' = the tier box ' + WIDE[size]);
  ok(Math.abs(hWalk - sun2.shadow.camera.right) <= 0.5, size + ': walking and flying use the same box');
}

// ── (2)+(3) the ease-out band ──
const F = L.SHADOW_FADE || (L.qualityBands && null);
const bandsFor = h => L.qualityBands('desktop', { reach: 30, fogEnd: 420, groundR: 512, shadowHalf: h, propCut: 600, ring: 2, horHalf: 2900 }).shadow.map;
const CAM3P = 26;   // third-person camera distance behind her on foot (u), measured in the headless session (PW.camera vs focus)
for (const tier of L.TIERS) for (const h of [45, 70, 110, 150]) {
  const B = L.qualityBands(tier, { reach: 30, fogEnd: 420, groundR: 512, shadowHalf: h, propCut: 600, ring: 2, horHalf: 2900 }).shadow.map;
  ok(B[0] >= 0.8 * h - 1e-9, tier + ' h=' + h + ': the map holds to ' + B[0].toFixed(1) + ' u (>= 0.8 h)');
  ok(B[1] < h, tier + ' h=' + h + ': gone by ' + B[1].toFixed(1) + ' u, inside the box (no square edge)');
  const wAtCam = 1 - sm(B[0], B[1], CAM3P * 1.25);
  ok(wAtCam === 1, tier + ' h=' + h + ': full sun shadow at 1.25 x the third-person camera distance (' + (CAM3P * 1.25) + ' u)');
}
// before the fix: 0.62 x 45 = 28 -> [16.8, 25.8]: the ring sat between her and the camera
{ const h = 45 * 0.62, a = 0.6 * h, b = 0.92 * h; ok(1 - sm(a, b, CAM3P) < 0.01, 'sanity: the old numbers put the camera outside the shadow (' + a.toFixed(1) + '-' + b.toFixed(1) + ' u)'); }

// ── (5) (t1590) wherever the far layer does not RECEIVE (Low, Medium's shafts-only pass, every phone / tablet), covers() is false, so the on-foot box stays #269's full
// tier box with its 0.82-0.97 ease-out: the mansion deck / overhangs never go lit past a tight box (the t1537 lit-floor ring)
{ const SF = require(path.join(root, 'ui/dm-sunfar.js')).core;
  for (const t of ['low', 'med', 'high', 'ultra']) for (const mob of [false, true]) {
    const c = SF.tierCfg(t, mob), recv = !!(c && c.recv);
    ok(recv === (!mob && (t === 'high' || t === 'ultra')), t + (mob ? ' handheld' : ' desktop') + ': far layer ' + (c ? (recv ? 'receives' : 'shafts only') : 'off'));
    if (!recv) { win.DMSunFar = { covers: () => recv }; for (const size of [512, 1024]) { P._S.half = 0; const sun = mkSun(size); for (let i = 0; i < 400; i++) P.fitSun(sun, dir, 10, 5, -3, true);
      ok(Math.abs(sun.shadow.camera.right - WIDE[size]) <= 0.5, t + (mob ? ' handheld' : ' desktop') + ' ' + size + ': full near box ' + sun.shadow.camera.right + ' (no tight box without far receivers)'); } }
  }
  ok(/!!S\.cfg\.recv && coversAt/.test(rd('ui/dm-sunfar.js')), 'dm-sunfar: covers() needs a receiving tier');
  delete win.DMSunFar;
}

// ── (4) source pins ──
const lt = rd('ui/dm-light.js');
ok(/const wMap = float\(1\)\.sub\(smoothstep\(U\.sm\.x, U\.sm\.y/.test(lt), 'dm-light: the sun-map wrapper still reads U.sm (the band this test pins)');
ok(/s && s\.dmFlashShadow \? s :/.test(lt), 'dm-light: the flashlight shadow passes the wrapper untouched');
ok(/bounce = mix\(bounce, farB, wOut\)/.test(lt) && /const farB = FAR_AVG \? U\.bAvg\.mul\(clamp\(n\.y, 0\.0, 1\.0\)\.mul\(0\.65\)\.add\(0\.35\)\) : vec3\(0, 0, 0\);/.test(lt), 'dm-light (t1644): past its window the probe bounce fades to the window\'s own AVERAGE (never brighter than the window: no lit bubble edge); ?lightfar=0 = to nothing');
const pol = rd('ui/dm-polish.js');
ok(!/tight \? 0\.62/.test(pol), 'dm-polish: no 0.62x on-foot box left');
const html = rd('index.html');
ok(/DMLight\.setBands\(B\.shadow\.map\[0\],B\.shadow\.map\[1\]/.test(html.replace(/\s+/g, '')), 'index.html: U.sm comes from DMLod bands (shadow.map)');
console.log('sun-ring: ' + (n - fails) + '/' + n + ' ok');
if (fails) process.exit(1);
