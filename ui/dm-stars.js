/* DART Meadow — DMStars: the ONE sun-direction source on a world (v334, JOTS Cosmos).
 *
 * The sky on a planet's surface and in its air is lit by the system's REAL stars: the same star bodies that are drawn in open space
 * (Sol's Sun, a procedural system's star, Veyra A + B round their barycentre).  Each frame the world tick hands this module the
 * viewer's open-space position and the space -> drawn-frame rotation (index.html _PWS: Mi * Qi, the very rotation the camera and
 * the layered open-space sky go through), so a star's direction in the drawn world is exactly where that star body is drawn behind
 * it: flying up out of the air toward a star leads straight at it in space, with no swap or jump at the hand-off.
 *
 * Classic script (window.DMStars) + module.exports for node (tools/tests/system-stars-unit.js).  Nothing allocates per frame.
 *
 *   DMStars.setSources([{obj, radius, temp, name}, ...])   at system build (obj: the star's top-level group in the flight scene;
 *                                                          radius in flight units; temp in K).  null / [] clears.  Up to MAX (3).
 *   DMStars.update(viewer, q, o)                           once per frame: viewer {x,y,z} (open space), q {x,y,z,w} space -> local
 *                                                          rotation, o {atmos (bool), ext [r,g,b] zenith optical depth}.
 *   DMStars.spaceDirFrom(pos, i, out)                      star i's unit direction from any open-space point.
 *   DMStars.fromPoint(pos, dirs, ws) -> key                every star's direction + sky weight from a point (an orbit pass), into
 *                                                          caller-owned arrays; the world state is left alone.
 *   Read-only state (preallocated; THREE.Vector3 / THREE.Color when THREE is loaded, plain {x,y,z} / {r,g,b} otherwise):
 *     count, valid, frame
 *     dir[i]   unit direction in the local (drawn) frame        dirS[i]  the same in open space
 *     col[i]   chromaticity from temperature (luminance 1; 5778 K = exactly white, never green-dominant)
 *     temp[i], radius[i], angR[i] (true angular radius asin(R/d), clamped to [ANG_MIN, ANG_MAX])
 *     I[i]     physical relative flux (R/d)^2 (T/5778)^4, sum 1          w[i]  perceptual sky weight ~ sqrt(I), sum 1
 *     tr[i]    {r,g,b} transmission through the air toward it (airmass extinction + horizon), 1 on airless worlds
 *     day[i]   0 night .. 1 day for that star                            day   sky daylight (sum w[i] day[i], 0..1)
 *     keyIdx, keyDir, keyCol, keyI   the key light: the brightest APPARENT star (I x transmission luminance), with hysteresis
 *                                    (a new key must out-shine the current one by KEY_HYST); at night the primary keeps the key.
 */
(function (root) {
  'use strict';
  const MAX = 3, T_REF = 5778, ANG_MIN = 0.0045, ANG_MAX = 0.075, KEY_HYST = 1.25;

  // Black-body colour (Tanner Helland fit, sRGB-ish), normalised so 5778 K is exactly white and scaled to luminance 1.
  function rawRGB(T, o) {
    const t = Math.max(1000, Math.min(40000, T || T_REF)) / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : (t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307);
    o[0] = Math.max(0, Math.min(255, r)); o[1] = Math.max(0, Math.min(255, g)); o[2] = Math.max(0, Math.min(255, b)); return o;
  }
  const REF = rawRGB(T_REF, [0, 0, 0]), _rgb = [0, 0, 0];
  function kelvinRGB(T, out) {
    rawRGB(T, _rgb);
    let r = _rgb[0] / REF[0], g = _rgb[1] / REF[1], b = _rgb[2] / REF[2];
    g = Math.min(g, Math.max(r, b));                                   // a star is never green
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b || 1;
    out.r = r / L; out.g = g / L; out.b = b / L; return out;
  }
  // relative airmass at elevation sin(alt) = y (Kasten-Young-ish; same law as ui/dm-sky.js's star extinction)
  function airmass(y) { const u = Math.max(0, y); return 1 / (u + 0.025 * Math.exp(-11 * u)); }
  const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  const S = {
    MAX, T_REF, ANG_MIN, ANG_MAX, KEY_HYST, kelvinRGB, airmass,
    count: 0, valid: false, frame: 0, day: 1, keyIdx: 0, keyI: 1,
    dir: null, dirS: null, col: null, tr: null, temp: new Float64Array(MAX), radius: new Float64Array(MAX), angR: new Float64Array(MAX),
    I: new Float64Array(MAX), w: new Float64Array(MAX), dayK: new Float64Array(MAX), keyDir: null, keyCol: null, src: []
  };
  function mkV() { const T = root && root.THREE; return T && T.Vector3 ? new T.Vector3(0, 1, 0) : { x: 0, y: 1, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }; }
  function mkC() { const T = root && root.THREE; return T && T.Color ? new T.Color(1, 1, 1) : { r: 1, g: 1, b: 1, set(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } }; }
  function ensure() {
    if (S.dir && (!(root && root.THREE) || S.dir[0].isVector3)) return;
    S.dir = []; S.dirS = []; S.col = []; S.tr = [];
    for (let i = 0; i < MAX; i++) { S.dir.push(mkV()); S.dirS.push(mkV()); S.col.push(mkC()); S.tr.push(mkC()); }
    S.keyDir = mkV(); S.keyCol = mkC();
  }
  ensure();

  S.setSources = function (list) {
    ensure(); S.src.length = 0; S.count = 0; S.valid = false; S.keyIdx = 0;
    if (!list) return S;
    for (let i = 0; i < list.length && S.src.length < MAX; i++) {
      const s = list[i]; if (!s || !s.obj || !s.obj.position) continue;
      const k = S.src.length; S.src.push(s);
      S.temp[k] = s.temp > 0 ? s.temp : T_REF; S.radius[k] = s.radius > 0 ? s.radius : 1;
      kelvinRGB(S.temp[k], S.col[k]);
    }
    S.count = S.src.length; return S;
  };
  S.spaceDirFrom = function (pos, i, out) {
    const p = S.src[i] && S.src[i].obj.position; if (!p) return out;
    const x = p.x - pos.x, y = p.y - pos.y, z = p.z - pos.z, L = Math.hypot(x, y, z) || 1;
    return out.set(x / L, y / L, z / L);
  };
  // directions + sky weights of every star from an open-space point (an orbit view's planet centre) into caller-owned arrays; returns the key
  // (largest flux).  Leaves the world state (dir / w / keyDir) alone.  No allocation.
  S.fromPoint = function (pos, dirs, ws) {
    let sumF = 0, sumW = 0, key = 0;
    for (let i = 0; i < S.count; i++) {
      const p = S.src[i].obj.position, x = p.x - pos.x, y = p.y - pos.y, z = p.z - pos.z, d = Math.hypot(x, y, z) || 1;
      dirs[i].set(x / d, y / d, z / d);
      const k = Math.min(1, S.radius[i] / d), tk = S.temp[i] / T_REF; ws[i] = k * k * tk * tk * tk * tk; sumF += ws[i];
    }
    for (let i = 0; i < S.count; i++) { ws[i] = sumF > 0 ? Math.sqrt(ws[i] / sumF) : (i ? 0 : 1); sumW += ws[i]; if (ws[i] > ws[key]) key = i; }
    for (let i = 0; i < S.count; i++) ws[i] /= sumW || 1;
    return key;
  };
  // v' = q v q*  (no allocation)
  function rot(q, x, y, z, out) {
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    return out.set(x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx));
  }
  S.update = function (viewer, q, o) {
    S.frame++;
    if (!S.count || !viewer || !q) { S.valid = false; return S; }
    const atmos = !o || o.atmos !== false, E = (o && o.ext) || null;
    let sumF = 0, sumW = 0;
    for (let i = 0; i < S.count; i++) {
      const p = S.src[i].obj.position, x = p.x - viewer.x, y = p.y - viewer.y, z = p.z - viewer.z, d = Math.hypot(x, y, z) || 1;
      S.dirS[i].set(x / d, y / d, z / d);
      rot(q, x / d, y / d, z / d, S.dir[i]);
      const R = S.radius[i], k = Math.min(1, R / d), tk = S.temp[i] / T_REF;
      S.angR[i] = Math.max(ANG_MIN, Math.min(ANG_MAX, Math.asin(k)));
      S.I[i] = k * k * tk * tk * tk * tk; sumF += S.I[i];
      // the air toward it: airmass extinction per channel; the horizon (the planet itself) hides it
      const ey = S.dir[i].y, hz = sm(-0.02, 0.01, ey), tr = S.tr[i];
      if (atmos && E) { const X = airmass(ey) - 1; tr.set(Math.exp(-E[0] * X) * hz, Math.exp(-E[1] * X) * hz, Math.exp(-E[2] * X) * hz); }
      else tr.set(hz, hz, hz);
      S.dayK[i] = Math.max(0, Math.min(1, (ey + 0.1) / 0.25));
    }
    if (!(sumF > 0)) { S.valid = false; return S; }
    for (let i = 0; i < S.count; i++) { S.I[i] /= sumF; S.w[i] = Math.sqrt(S.I[i]); sumW += S.w[i]; }
    let day = 0, best = -1, bestA = -1;
    for (let i = 0; i < S.count; i++) {
      S.w[i] /= sumW; day += S.w[i] * S.dayK[i];
      const t = S.tr[i], a = S.I[i] * (0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b);
      if (a > bestA) { bestA = a; best = i; }
    }
    S.day = Math.max(0, Math.min(1, day));
    let key = S.keyIdx < S.count ? S.keyIdx : 0;
    const t0 = S.tr[key], curA = S.I[key] * (0.2126 * t0.r + 0.7152 * t0.g + 0.0722 * t0.b);
    if (bestA <= 1e-6) { let m = 0; for (let i = 1; i < S.count; i++) if (S.I[i] > S.I[m]) m = i; key = m; }   // night: the primary keeps the key
    else if (best !== key && bestA > curA * KEY_HYST) key = best;
    S.keyIdx = key; S.keyI = S.I[key];
    const kd = S.dir[key], kc = S.col[key]; S.keyDir.set(kd.x, kd.y, kd.z); S.keyCol.set(kc.r, kc.g, kc.b);
    S.valid = true; return S;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = S;
  if (root) root.DMStars = S;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
