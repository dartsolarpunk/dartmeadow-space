// (v334 Cosmos) the system's real stars in a world's sky (ui/dm-stars.js + its glue in index.html / ui/dm-sky.js / ui/dm-atmo.js):
// binary blend, extinction / reddening, the key light, frame continuity of a star's direction across the space <-> world hand-off
// (index.html's own _pwsSync / _pwsQToDrawn, evaluated here with a tiny THREE shim), never green, the old single glare gone, no allocation.
//   node --expose-gc tools/tests/system-stars-unit.js
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = rd('index.html'), sky = rd('ui/dm-sky.js'), atmo = rd('ui/dm-atmo.js');
let n = 0; const ok = (c, m) => { assert(c, m); n++; if (process.env.VERBOSE && /[0-9]\)|\(/.test(m)) console.log('  ok', m); };

// ── a tiny THREE (enough for index.html's _pws* functions and DMStars' vectors) ──
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; this.isVector3 = true; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(v) { return this.set(v.x, v.y, v.z); } clone() { return new V3(this.x, this.y, this.z); }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; } add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; } addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  negate() { return this.multiplyScalar(-1); } dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; } length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { return this.multiplyScalar(1 / (this.length() || 1)); } distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  applyQuaternion(q) { const { x, y, z } = this, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    return this.set(x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)); } }
class Q { constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; } copy(q) { return this.set(q.x, q.y, q.z, q.w); } clone() { return new Q(this.x, this.y, this.z, this.w); }
  invert() { return this.set(-this.x, -this.y, -this.z, this.w); }
  multiply(q) { return this.multiplyQuaternions(this.clone(), q); }
  premultiply(q) { return this.multiplyQuaternions(q, this.clone()); }
  multiplyQuaternions(a, b) { const ax = a.x, ay = a.y, az = a.z, aw = a.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
    return this.set(ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz); }
  setFromAxisAngle(a, t) { const s = Math.sin(t / 2); return this.set(a.x * s, a.y * s, a.z * s, Math.cos(t / 2)); }
  setFromRotationMatrix(m) { const e = m.elements, m11 = e[0], m12 = e[4], m13 = e[8], m21 = e[1], m22 = e[5], m23 = e[9], m31 = e[2], m32 = e[6], m33 = e[10], tr = m11 + m22 + m33; let s;
    if (tr > 0) { s = 0.5 / Math.sqrt(tr + 1); return this.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s); }
    if (m11 > m22 && m11 > m33) { s = 2 * Math.sqrt(1 + m11 - m22 - m33); return this.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s); }
    if (m22 > m33) { s = 2 * Math.sqrt(1 + m22 - m11 - m33); return this.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s); }
    s = 2 * Math.sqrt(1 + m33 - m11 - m22); return this.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s); } }
class M4 { constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  makeBasis(x, y, z) { const e = this.elements; e[0] = x.x; e[1] = x.y; e[2] = x.z; e[4] = y.x; e[5] = y.y; e[6] = y.z; e[8] = z.x; e[9] = z.y; e[10] = z.z; return this; } }
class Color { constructor(r = 1, g = 1, b = 1) { this.r = r; this.g = g; this.b = b; } set(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } }
global.THREE = { Vector3: V3, Quaternion: Q, Matrix4: M4, Color };
global.window = global;
const S = require('../../ui/dm-stars.js');

// ── 1. colour from temperature: 5778 K white, warm M, blue-white A/B, NEVER green ──
{ const c = S.kelvinRGB(5778, {}); ok(Math.abs(c.r - 1) < 1e-9 && Math.abs(c.g - 1) < 1e-9 && Math.abs(c.b - 1) < 1e-9, 'Sol (5778 K) is exactly white: Earth / Mars skies keep their look');
  let worst = -1; for (let T = 1200; T <= 40000; T += 25) { const k = S.kelvinRGB(T, {}); worst = Math.max(worst, k.g - Math.max(k.r, k.b)); ok(isFinite(k.r + k.g + k.b) && Math.abs(0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b - 1) < 1e-9, 'luminance 1 at ' + T); }
  ok(worst <= 1e-12, 'no star colour is green-dominant (worst g - max(r,b) = ' + worst.toExponential(2) + ')');
  const m = S.kelvinRGB(3000, {}), a = S.kelvinRGB(8200, {}); ok(m.r > m.g && m.g > m.b, 'Veyra B (3000 K) red'); ok(a.b > a.g && a.b > a.r, 'Veyra A (8200 K) blue-white'); }

// ── 2. the Veyra binary from Solenne: flux, perceptual weights, blended daylight, key light ──
const BIN = { sep: 560, massA: 0.62, rA: 118, rB: 78 }, AU = 500;
const A = { position: new V3() }, B = { position: new V3() };
function place(ang) { const fA = BIN.sep * (1 - BIN.massA), fB = BIN.sep * BIN.massA; A.position.set(-fA * Math.cos(ang), 0, -fA * Math.sin(ang)); B.position.set(fB * Math.cos(ang), 0, fB * Math.sin(ang)); }
S.setSources([{ obj: A, radius: BIN.rA, temp: 8200, name: 'Veyra' }, { obj: B, radius: BIN.rB, temp: 3000, name: 'Veyra B' }]);
ok(S.count === 2 && S.dir[0].isVector3, 'two sources, THREE vectors');
const ID = new Q(), EXT = [0.11, 0.24, 0.52];
// a local frame where +y is "up" at the viewer: rotate space so the given up vector maps to +y
function upTo(up) { const u = up.clone().normalize(), ax = new V3(-u.z, 0, u.x), s = ax.length(); const q = new Q(); if (s < 1e-9) return u.y > 0 ? q : q.set(1, 0, 0, 0); ax.multiplyScalar(1 / s); return q.setFromAxisAngle(ax, Math.acos(Math.max(-1, Math.min(1, u.y)))); }
{ place(0.3); const P = new V3(3.2 * AU, 0, 0); const toA = A.position.clone().sub(P).normalize();
  // stand where A is at the zenith
  S.keyIdx = 0; S.update(P.clone(), upTo(toA), { atmos: true, ext: EXT });
  ok(S.valid && Math.abs(S.I[0] + S.I[1] - 1) < 1e-12 && Math.abs(S.w[0] + S.w[1] - 1) < 1e-12, 'fluxes and sky weights each sum to 1');
  const dA = A.position.distanceTo(P), dB = B.position.distanceTo(P), fr = (BIN.rB / dB) ** 2 * (3000 / 8200) ** 4 / ((BIN.rA / dA) ** 2);
  ok(Math.abs(S.I[1] / S.I[0] - fr) < 1e-9, 'flux ratio B/A = (R/d)^2 (T)^4: ' + fr.toFixed(4));
  ok(Math.abs(S.w[1] / S.w[0] - Math.sqrt(fr)) < 1e-9 && S.w[1] > 0.05, 'sky weight ~ sqrt(flux): B still tints the sky (' + (S.w[1] * 100).toFixed(1) + ' %)');
  ok(Math.abs(S.dir[0].y - 1) < 1e-9 && S.keyIdx === 0, 'A overhead is the key light');
  ok(Math.abs(S.angR[0] - Math.min(S.ANG_MAX, Math.asin(BIN.rA / dA))) < 1e-12 && S.angR[1] < S.angR[0] && S.angR[1] >= S.ANG_MIN, 'discs at their true angular radius (A ' + (S.angR[0] * 180 / Math.PI).toFixed(2) + ' deg, B ' + (S.angR[1] * 180 / Math.PI).toFixed(2) + ' deg)');
  const dsum = S.w[0] * S.dayK[0] + S.w[1] * S.dayK[1]; ok(Math.abs(S.day - Math.min(1, dsum)) < 1e-12, 'daylight = sum of each star\'s weight x its own daylight');
  // binary blend in the volumetric air (dm-atmo setStars): per star colour x weight, key first; sums to the key's colour on a single star
  const sc = [0, 0].map((_, i) => [S.col[i].r * S.w[i], S.col[i].g * S.w[i], S.col[i].b * S.w[i]]);
  ok(sc[1][0] > sc[1][2] && sc[0][2] > sc[0][0], 'each star scatters in its own colour (A blue-white, B red)');
  // blended tint of the dome is never green
  const tw = S.w[0] * S.dayK[0] + S.w[1] * S.dayK[1], tg = (S.col[0].g * S.w[0] * S.dayK[0] + S.col[1].g * S.w[1] * S.dayK[1]) / tw,
    tr = (S.col[0].r * S.w[0] * S.dayK[0] + S.col[1].r * S.w[1] * S.dayK[1]) / tw, tb = (S.col[0].b * S.w[0] * S.dayK[0] + S.col[1].b * S.w[1] * S.dayK[1]) / tw;
  ok(tg <= Math.max(tr, tb) + 1e-12, 'blended daylight tint not green (' + [tr, tg, tb].map((v) => v.toFixed(3)).join('/') + ')');
}
// A sets, B is still up: the key passes to B (hysteresis), and back
{ place(Math.PI / 2); const P = new V3(3.2 * AU, 0, 0), toA = A.position.clone().sub(P).normalize(), toB = B.position.clone().sub(P).normalize();
  // a local "up" between them, tipped so A is just below the horizon and B well up
  const side = toA.clone().addScaledVector(toB, -toA.dot(toB)).normalize();   // in the A-B plane, square to B
  const ang = Math.acos(toA.dot(toB));
  let keys = [], days = [];
  for (let k = 0; k <= 60; k++) {
    const tilt = -0.2 + k / 60 * 0.4;   // A's elevation sweeps -0.2 .. +0.2 rad
    // in the A-B vertical plane: up = cos(a) toB + sin(a) side with a = ang - pi/2 + tilt  =>  elev(A) = tilt, elev(B) = ang + tilt
    const aa = ang - Math.PI / 2 + tilt, best = toB.clone().multiplyScalar(Math.cos(aa)).addScaledVector(side, Math.sin(aa));
    if (!best) continue; S.update(P.clone(), upTo(best), { atmos: true, ext: EXT }); keys.push(S.keyIdx); days.push(S.day);
  }
  ok(keys.length > 40 && keys[0] === 1 && keys[keys.length - 1] === 0, 'A below the horizon: B is the key; A risen: A takes it back (' + keys.join('') + ')');
  let flips = 0; for (let i = 1; i < keys.length; i++) if (keys[i] !== keys[i - 1]) flips++;
  ok(flips === 1, 'one clean key hand-over (hysteresis, no flicker)');
  { // the key light eases across the swap: per-frame keyDir step stays small, and it lands exactly on the new key star after SWAP_S
    S.keyIdx = 0; S.swapT = 1; let prev = null, worst = 0, landed = false;
    for (let k = 0; k <= 240; k++) { const tilt = 0.05 - k / 240 * 0.25, aa = ang - Math.PI / 2 + tilt;
      const u = toB.clone().multiplyScalar(Math.cos(aa)).addScaledVector(side, Math.sin(aa)); S.update(P.clone(), upTo(u), { atmos: true, ext: EXT, dt: 1 / 60 });
      const kd = S.keyDir.clone(); if (prev) worst = Math.max(worst, Math.acos(Math.min(1, kd.dot(prev)))); prev = kd;
      if (S.keyIdx === 1 && S.swapT >= 1) landed = Math.abs(kd.dot(S.dir[1]) - 1) < 1e-9; }
    ok(worst < 0.01, 'A -> B key swap eases the key light (max step ' + (worst * 180 / Math.PI).toFixed(3) + ' deg/frame, the stars are ' + (ang * 180 / Math.PI).toFixed(1) + ' deg apart)');
    ok(landed, 'after the ease the key light is exactly the new key star'); }
  { const u = toA.clone().add(toB).normalize().negate(); S.update(P.clone(), upTo(u), { atmos: true, ext: EXT }); ok(S.keyIdx === 0 && S.day === 0, 'both down (night): the primary keeps the key, no daylight'); }
  let jump = 0; for (let i = 1; i < days.length; i++) jump = Math.max(jump, Math.abs(days[i] - days[i - 1])); ok(jump < 0.1, 'daylight blends continuously through A\'s sunrise (max step ' + jump.toFixed(3) + ')');
  ok(Math.min(...days) > 0.05, 'with A down, B alone still lights a dim red day (' + Math.min(...days).toFixed(3) + ')');
}
// ── 3. extinction: dims and reddens toward the horizon, gone below it; airless worlds unattenuated ──
{ const P = new V3(); const src = { position: new V3() }; S.setSources([{ obj: src, radius: 10, temp: 5778 }]);
  let prev = null; for (let el = 1.5; el >= -0.05; el -= 0.01) {
    src.position.set(Math.cos(el) * 1000, Math.sin(el) * 1000, 0); S.update(P, ID, { atmos: true, ext: EXT });
    const t = S.tr[0]; if (prev) ok(t.r <= prev.r + 1e-12 && t.b <= prev.b + 1e-12, 'transmission falls toward the horizon at ' + el.toFixed(2));
    if (el > 0.02) ok(t.r >= t.g && t.g >= t.b, 'reddened (r >= g >= b) at ' + el.toFixed(2)); prev = { r: t.r, b: t.b }; }
  src.position.set(1000, 1000 * Math.sin(0.05), 0); S.update(P, ID, { atmos: true, ext: EXT }); const lo = S.tr[0].b / S.tr[0].r;
  src.position.set(0, 1000, 0); S.update(P, ID, { atmos: true, ext: EXT }); const hi = S.tr[0].b / S.tr[0].r;
  ok(lo < 0.35 * hi, 'a low sun is far redder than a high one (b/r ' + lo.toFixed(3) + ' vs ' + hi.toFixed(3) + ')');
  src.position.set(0, -1000, 0); S.update(P, ID, { atmos: true, ext: EXT }); ok(S.tr[0].r === 0 && S.day === 0, 'below the horizon: hidden, night');
  src.position.set(1000, 1000 * Math.sin(0.05), 0); S.update(P, ID, { atmos: false }); ok(S.tr[0].r === 1 && S.tr[0].b === 1, 'airless: no extinction above the horizon');
}
// ── 4. frame continuity across the hand-off: index.html's own space <-> drawn transform ──
{ const a = html.indexOf('const _PWS={'), b = html.indexOf('// where a space point is over the planet');
  ok(a > 0 && b > a, '_PWS block found');
  const PWF = { fx: 0, fz: 0, lat: 0, R: 0 }, ATMO_DEG_PER_UNIT = 0.008, PLANET_VIS_SCALE = 6, _planetR = () => 360 / ATMO_DEG_PER_UNIT / (2 * Math.PI);
  const F = new Function('THREE', 'PWF', 'ATMO_DEG_PER_UNIT', 'PLANET_VIS_SCALE', '_planetR', html.slice(a, b) + '\nreturn {_PWS,_pwsSync,_pwsQToDrawn,_pwsQFromDrawn,_pwsToDrawn,_pwsFromDrawn};')(THREE, PWF, ATMO_DEG_PER_UNIT, PLANET_VIS_SCALE, _planetR);
  ok(/q\.copy\(_PWS\.Mi\)\.multiply\(_PWS\.Qi\)/.test(html) && /_pwsSync\(PW\.body,PW\.site\); _pwStarsTick\(dt\);/.test(html), 'the world tick turns the stars with Mi * Qi right after _pwsSync (both modes)');
  ok((html.match(/_pwsSync\(PW\.body,PW\.site\); _pwStarsTick\(dt\);/g) || []).length === 2, 'space and fly/walk branches both tick the stars');
  // planet in space: tilted + spun; a star far off; the board just above the air at some lat/lon
  const Pp = new V3(1200, 30, -900), Qp = new Q().setFromAxisAngle(new V3(0.3, 1, 0.2).normalize(), 1.1);
  const mesh = { position: Pp, quaternion: Qp, updateMatrixWorld() {}, getWorldPosition(o) { return o.copy(Pp); }, getWorldQuaternion(o) { return o.copy(Qp); } };
  const body = { mesh, collisionRadius: 6.72 };
  const star = { position: new V3(-300, 80, 400) }; S.setSources([{ obj: star, radius: 118, temp: 8200 }]);
  const site = { lat: 18, lon: 40 };
  let prevCamDir = null, worst = 0, worstStep = 0;
  for (let k = 0; k <= 40; k++) {
    // climb straight up out of the air above the site (body frame up at lat/lon), drifting east a little
    const lat = site.lat * Math.PI / 180, lon = (site.lon + k * 0.02) * Math.PI / 180;
    const upB = new V3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    const sp = upB.clone().applyQuaternion(Qp).multiplyScalar(6.72 * (1.0 + 0.003 * k)).add(Pp);
    // the space camera looks straight at the star from the board
    const fwd = star.position.clone().sub(sp).normalize(), qc = new Q().setFromAxisAngle(new V3(0, 1, 0), 0);
    { const z = new V3(0, 0, -1), ax = new V3(z.y * fwd.z - z.z * fwd.y, z.z * fwd.x - z.x * fwd.z, z.x * fwd.y - z.y * fwd.x), s = ax.length(); if (s > 1e-9) qc.setFromAxisAngle(ax.multiplyScalar(1 / s), Math.acos(Math.max(-1, Math.min(1, z.dot(fwd))))); }
    // into the world frame at this focus
    PWF.fx = k * 0.02 / ATMO_DEG_PER_UNIT; PWF.fz = 0; PWF.lat = lat; PWF.R = _planetR();
    F._pwsSync(body, site);
    const qd = F._pwsQToDrawn(qc, new Q()), camFwdD = new V3(0, 0, -1).applyQuaternion(qd);
    const qL = new Q().copy(F._PWS.Mi).multiply(F._PWS.Qi);
    S.update(sp, qL, { atmos: true, ext: EXT });
    const dd = S.dir[0], err = Math.acos(Math.max(-1, Math.min(1, dd.x * camFwdD.x + dd.y * camFwdD.y + dd.z * camFwdD.z)));
    worst = Math.max(worst, err);
    // the drawn camera turned back to space is the space camera (the layered open-space sky's own camera): the star is dead centre there too
    const qb = F._pwsQFromDrawn(qd, new Q()), fB = new V3(0, 0, -1).applyQuaternion(qb); worst = Math.max(worst, Math.acos(Math.min(1, fB.dot(fwd))));
    // the star in the camera's own frame (what is on screen) does not jump from one step to the next
    const inv = qd.clone().invert(), cd = dd.clone().applyQuaternion(inv);
    if (prevCamDir) worstStep = Math.max(worstStep, Math.acos(Math.min(1, cd.dot(prevCamDir)))); prevCamDir = cd;
    ok(Math.abs(S.dirS[0].dot(fwd) - 1) < 1e-12, 'open-space direction = the star body\'s direction from the board');
  }
  ok(worst < 1e-6, 'the star sits on the camera axis in BOTH frames through the climb (worst ' + worst.toExponential(2) + ' rad)');
  ok(worstStep < 1e-6, 'no swap or jump of the star on screen across the hand-off (worst step ' + worstStep.toExponential(2) + ' rad)');
}
// ── 5. the glare is gone; every consumer reads the one key direction ──
ok(!/pow\(sd, W\.float\(48\)\)/.test(sky) && !/U\.glow\.mul\(halo\)/.test(sky), 'dm-sky: the fixed pow(48)+pow(6) sun glare is gone');
ok(/for \(let k = 0; k < 3; k\+\+\)/.test(sky) && /U\.ext\.mul\(X\)/.test(sky) && /S4\.w/.test(sky), 'dm-sky: up to 3 analytic star discs at their angular size, extinguished by airmass');
ok(!/pow\(max\(dot\(rdW,U\.sun\),0\.0\),8\.0\)/.test(html), 'classic surface shell: the pow(.,8) sun glare lobe is gone');
ok(/U\.st\[k\]/.test(html.slice(html.indexOf('function _pwAtmoShell'), html.indexOf('function _pwfAnisoG'))), 'classic surface shell: lit by every real star');
ok(/const NS = Math\.max\(1, Math\.min\(3, opt\.stars/.test(atmo) && /setStars\(S, dirs, ws, key\)/.test(atmo) && /U\.sc\[k\]/.test(atmo), 'volumetric air: per-star scattering, star count fixed at build (pass key carries it)');
ok(/stars:nSt\}\);/.test(html) && /'\|'\+nSt;/.test(html), 'surface + orbit passes built with the system\'s star count');
ok(/DMLight\.tick\(dt,\{x:px,y:f\.y,z:pz,H,sunDir:_pwKeyDir\(\)/.test(html) && /DMVLight\.tick\(dt,\{camera:cam,scene,sunDir:_pwKeyDir\(\)/.test(html) && /let d=_pwKeyDir\(\), up=null;/.test(html), 'DMLight, DMVLight and the shadow sun all read DMStars.keyDir');
ok(/sky\.update\(cam,dt,ll\.lat,ll\.lon,_pwStarsLive\(\)\)/.test(html), 'the sky dome follows the real stars');
ok(/DMStars\.setSources\(\[\{obj:sunGroup/.test(html) && /_starSrc\.push\(\{obj:sb\.group/.test(html) && /DMStars\.setSources\(null\)/.test(html), 'sources: Sol\'s Sun, a system\'s star + Veyra B; cleared with the system');
// one legacy star (no DMStars) = the old split-scatter sum, algebraically (cloud / weather / layer terms)
{ const phM = 0.37, ext = 2.3, cd = 0.4, alb = 0.7; ok(Math.abs(ext * 0.9 * cd * (phM * 0.5 + 0.06) - (ext * 0.9 * cd * 0.5 * phM + ext * 0.9 * cd * 0.06)) < 1e-15 && Math.abs(ext * alb * (phM * 0.4 + 0.05) - (ext * alb * 0.4 * phM + ext * alb * 0.05)) < 1e-15, 'single star: the split scattering equals the old sum'); }
// ── 5b. phones: Low preset / weak device march the key star only; the pass keys carry the count (warm-up = frame) ──
{ const a = html.indexOf('function _taStarNFor('), b = html.indexOf('\n', a); ok(a > 0, '_taStarNFor found');
  const f = new Function(html.slice(a, b) + '\nreturn _taStarNFor;')();
  ok(f(2, 'low', 'desktop') === 1 && f(2, 'medium', 'low') === 1 && f(3, 'low', 'low') === 1, 'Low preset / weak phone (DMLod tier low): one star in the march loop');
  ok(f(2, 'high', 'desktop', 3) === 1 && f(2, 'high', 'desktop', 2) === 1 && f(2, 'high', 'desktop', 4) === 2 && f(2, 'high', 'desktop', 0) === 2, 'legacy (deviceMemory <= 3 GB): one star; unknown memory (0) = all');
  ok(f(2, 'medium', 'mobile') === 2 && f(2, 'high', 'desktop') === 2 && f(5, 'ultra', null) === 3 && f(0, 'high', null) === 1 && f(1, 'ultra', 'desktop') === 1, 'otherwise every star (1..3)');
  ok((html.match(/const nSt=_taStarN\(\);/g) || []).length === 3, 'orbit frame, orbit warm-up and surface passes all size by _taStarN()');
  ok(/key='sp\|'\+best\.mesh\.uuid\+'\|'\+_taQ\(\)\+'\|'\+\(E&&E\.ready\?1:0\)\+\(nSt>1\?'\|'\+nSt:''\)/.test(html) && (html.match(/\(nSt>1\?'\|'\+nSt:''\)/g) || []).length === 2, 'warm-up and frame orbit keys carry the same |nSt suffix');
  const sh = html.slice(html.indexOf('function _pwAtmoShell'), html.indexOf('function _pwfAnisoG'));
  ok(/const NSs=_taStarN\(\);/.test(sh) && /for\(let k=0;k<NSs;k\+\+\)/.test(sh), 'classic surface shell: star loop sized by _taStarN (key only on Low)');
  ok(/for \(let k = 0; k < NS; k\+\+\)/.test(atmo), 'volumetric air: per-step star loop is NS (1 on Low)');
  ok(S.keyColor === S.keyCol && S.keyIntensity === S.keyI, 'Lighting aliases keyColor / keyIntensity'); }
// ── 6. no per-frame allocation in DMStars.update ──
{ place(0.5); S.setSources([{ obj: A, radius: BIN.rA, temp: 8200 }, { obj: B, radius: BIN.rB, temp: 3000 }]);
  const P = new V3(1600, 0, 0), q = new Q(); for (let i = 0; i < 2000; i++) S.update(P, q, { atmos: true, ext: EXT });
  const o = { atmos: true, ext: EXT };
  if (global.gc) { global.gc(); const h0 = process.memoryUsage().heapUsed; for (let i = 0; i < 200000; i++) { P.x = 1600 + (i & 7); S.update(P, q, o); } global.gc(); const dh = process.memoryUsage().heapUsed - h0; ok(dh < 64 * 1024, 'update x 200k retains < 64 KB (' + dh + ' B)'); }
  const src = S.update.toString(); ok(!/new |\[\]|\{\s*[a-z]+\s*:/.test(src), 'update() source has no new / [] / object literal'); }
console.log('system-stars-unit OK (' + n + ' checks)');
