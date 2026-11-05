/* DART Meadow — game-wide FAR-RANGE LEVEL-OF-DETAIL distance table (perf/visuals lane, sw v279).
 *
 * WHY: every layer used to carry its own hard-coded distances (props 260/900/1400 m, shadows 110/170 m, mansion LOD0/LOD1 400/470 m vs 300/360 m on phones, facility cull
 * 6000 m, walking draw radius 1200 m ...).  Nobody could see them side by side, nothing guaranteed that one layer's "far" was inside the next layer's "near", and none of
 * them knew the device class.  This module is the ONE table.  Pure data + pure functions (module.exports for node: tools/tests/lod-unit.js), a thin browser glue on top.
 *
 * DEVICE CLASS (DMLod.tier):  'low'     mobile with a low GPU class / score < 55 / <= 3 GB   (same test as ui/dm-budget.js classBase)
 *                             'mobile'  every other phone / tablet (Galaxy Tab Mali-G615, iPhone 16e)
 *                             'desktop' everything else
 *  ?lod=low|mobile|desktop forces a class (testing).  ?lod=off turns the glue off (DMLod.on=false: every caller falls back to its previous constant).
 *
 * BUDGET: ui/dm-budget.js stays the authority.  Prop distances are multiplied by DMBudget.propsK() (ladder stage 'props'), the vantage reach by DMBudget.groundReach()
 * (ladder stage 'ground').  The table only ever gives the CEILING for a tier; the ladder pulls it down when the frame rate asks.
 *
 * KEYS (metres unless noted)                      low     mobile   desktop
 *   prop.cutMax     chunk draw cut, near the ground, no fog bound   700   1000   1400
 *   prop.cutMin     chunk draw cut floor                             260    260    260
 *   prop.shadow     chunks within this cast into the sun map          90    110    170
 *   prop.ring       streaming radius ceiling (chunks, 300 m each)      1      2      3
 *   prop.hyst       draw / drop hysteresis factor                    1.06   1.06   1.06
 *   prop.colRing    chunks within this many chunks get colliders       1      1      1
 *   mansion.in/out  LOD1 -> LOD0 enter / leave (hysteresis)        300/360 300/360 400/470
 *   mansion.far     mansion group culled beyond                     4200   5200   5200
 *   facility.cull   other landmarks culled beyond                   4800   6000   6000
 *   vantage.reach   draw radius from a high vantage (deck, cliff)   1800   2800   4500
 *   vantage.fog     haze far / reach from a vantage                  0.6    0.62   0.62
 *   water.minH      m above the sea a rock / tree may stand           4      4      4
 *   mansion.lod2In  LOD1 -> impostor enter (leave x0.92)           1300   1500   2200
 *   xfade.s / prop.fadeS   cross-fade / chunk fade-in seconds        .35/.4 .45/.5 .6/.6
 *   impostor.tris   impostor triangle target                        1600   2600   4200
 *   lod.tauPx       screen-space error threshold (px)                 6    4.5      3
 *   billboard.px    prop -> billboard below this size (px)           30     24     18
 *   mip.bias        extra mip level at the far end of a detail band   1.0    0.8    0.5
 *
 * Public: DMLod.tier · .on · .get(key) (tier value) · .propCut(fog, agl) · .propRing(fog, agl) · .vantage(vt) · .mansion() · .sw(state, d, enter, leave) · .core
 */
(function (root) {
  'use strict';

  const TIERS = ['low', 'mobile', 'desktop'];
  const TABLE = {
    'prop.cutMax':   [700, 1000, 1400],
    'prop.cutMin':   [260, 260, 260],
    'prop.shadow':   [90, 110, 170],
    'prop.ring':     [1, 2, 3],
    'prop.hyst':     [1.06, 1.06, 1.06],
    'prop.colRing':  [1, 1, 1],
    'mansion.in':    [300, 300, 400],
    'mansion.out':   [360, 360, 470],
    'mansion.far':   [4200, 5200, 5200],
    'facility.cull': [4800, 6000, 6000],
    'vantage.reach': [1800, 2800, 4500],
    'vantage.fog':   [0.6, 0.62, 0.62],
    'water.minH':    [4, 4, 4],
    'mansion.lod2In':  [1300, 1500, 2200],   // LOD1 -> impostor (LOD2) enter distance; leave = x0.92
    'xfade.s':       [0.35, 0.45, 0.6],      // cross-fade seconds for the mansion LOD swaps
    'prop.fadeS':    [0.4, 0.5, 0.6],        // newly shown prop chunk: screen-door fade-in seconds
    'impostor.tris': [1600, 2600, 4200],     // impostor triangle target (vertex clustering)
    'lod.tauPx':     [6, 4.5, 3],            // error-driven LOD: a level is used while its geometric error projects to <= this many pixels
    'billboard.px':  [30, 24, 18],           // on-screen size (px) below which an instanced prop may be drawn as a view billboard (groundwork)
    'mip.bias':      [1.0, 0.8, 0.5],        // extra texture LOD (mips) at the far end of a detail band: far surfaces average instead of shimmering
  };
  const WALK_R = 1200;     // the on-foot draw radius floor in index.html (walkR = max(1200, fogFar x 2.5)); a vantage extends it, never shrinks it
  const CHUNK = 300;       // SURF_CHUNK in index.html

  function tierIndex(name) { const i = TIERS.indexOf(name); return i < 0 ? 1 : i; }
  function get(tier, key) { const row = TABLE[key]; return row ? row[tierIndex(tier)] : undefined; }

  /* hysteresis switch: `state` is the previous answer (true = near / on).  Enter below `enter`, leave above `leave` (enter <= leave) — in between nothing changes. */
  function sw(state, d, enter, leave) { return state ? !(d > leave) : d < enter; }

  /* 1 inside `a`, 0 beyond `b`, smoothstep between (a < b): the continuous blend weight a caller multiplies into an opacity / scale / detail amount */
  function fade(d, a, b) { if (!(b > a)) return d < a ? 1 : 0; const t = Math.max(0, Math.min(1, (d - a) / (b - a))); return 1 - t * t * (3 - 2 * t); }

  /* Chunk draw cut (the old constant formula of index.html _propsLod, now per tier): never past the haze, 260 m floor; flying high (agl > 60) the cut follows the fog, close to the ground it may run to cutMax. k = ladder scale. */
  function propCut(tier, fog, agl, k) {
    const cutMax = get(tier, 'prop.cutMax'), cutMin = get(tier, 'prop.cutMin');
    return Math.max(cutMin, Math.min(fog * 1.05, agl > 60 ? Math.max(cutMin, fog * 0.85) : cutMax)) * (k == null ? 1 : k);
  }
  /* How many chunk rings must be streamed (hidden) before a chunk can become visible, so a chunk is never BUILT inside the drawn range: a chunk that enters the wanted set
     is >= ring x 300 m away, so ring = ceil(cut x hysteresis / 300).  Capped by the device class (and 1 when the cut itself is already <= one chunk). */
  function propRing(tier, cut) {
    const need = Math.ceil(cut * get(tier, 'prop.hyst') / CHUNK);
    return Math.max(1, Math.min(get(tier, 'prop.ring'), need));
  }
  /* View radius from a high vantage.  vt 0..1 (how far above the land around: index.html _vtK).  walk = the normal on-foot radius, gk = ladder ground reach 1 / .8 / .6.
     The extension (reach - walk) is what the ladder scales; the result is never below `walk`, monotone in vt and in gk. */
  function vantageReach(tier, vt, walk, gk) {
    const r = get(tier, 'vantage.reach'), w = walk == null ? WALK_R : walk, ext = Math.max(0, r - w) * (gk == null ? 1 : gk);
    return w + ext * Math.max(0, Math.min(1, vt));
  }
  /* Haze far distance from a vantage: blends the low-ground fog distance toward vantage.fog x reach, never past 0.92 x the drawn radius. */
  function vantageFog(tier, vt, fogFar, drawR) {
    const target = Math.max(fogFar, get(tier, 'vantage.fog') * get(tier, 'vantage.reach'));
    const v = fogFar + (target - fogFar) * Math.max(0, Math.min(1, vt));
    return Math.max(fogFar, Math.min(v, drawR * 0.92));
  }

  /* Cross-fade of N levels (N = 3: LOD0 / LOD1 / impostor).  Each weight moves toward its target (1 for the wanted level, 0 for the rest) at 1 / dur per second; because every weight
     moves at the same rate the sum stays 1 through a fade AND through a retarget in the middle of one (no frame with a hole or a double layer).  dur 0 snaps. */
  function createXfade(n, dur) {
    const X = { n: n, dur: dur, w: new Float64Array(n), target: -1, fading: false };
    X.snap = function (t) { for (let i = 0; i < n; i++) X.w[i] = i === t ? 1 : 0; X.target = t; X.fading = false; };
    X.set = function (t) { if (X.target < 0) { X.snap(t); return; } X.target = t; };
    X.step = function (dt) {
      const t = X.target; if (t < 0) return X.w;
      if (!(X.dur > 0)) { X.snap(t); return X.w; }
      // the wanted level gains k = dt / dur per step and every other level gives up that much IN PROPORTION to what it holds: the sum is exactly 1 at every step, also when the target
      // changes in the middle of a fade (the level that was rising starts to fall, nothing flashes), and the wanted level is the only one that rises
      const k = dt / X.dur, so = 1 - X.w[t], gain = Math.min(k, so); let done = false;
      if (so <= 1e-12) done = true;
      else if (so - gain <= 1e-9) { X.snap(t); X.fading = false; return X.w; }
      else { const sc = (so - gain) / so; for (let i = 0; i < n; i++) if (i !== t) X.w[i] *= sc; X.w[t] += gain; }
      X.fading = !done; return X.w;
    };
    /* the screen-door interval [lo, hi) of level i out of the unit noise range: level 0 first, then 1, then 2 ... (weights partition [0,1) exactly) */
    X.interval = function (i, out) { let lo = 0; for (let j = 0; j < i; j++) lo += X.w[j]; out = out || [0, 0]; out[0] = lo; out[1] = lo + X.w[i]; if (X.w[i] >= 0.9999) { out[0] = 0; out[1] = 1.0001; } return out; };
    return X;
  }
  /* ── ERROR-DRIVEN LOD (screen-space error, after Ponchio / meshoptimizer's projected error; the idea of scthe/nanite-webgpu, MIT) ──
     A level whose geometry is off by `errM` metres projects to errM x viewH / (2 x dist x tan(fov/2)) pixels.  It may be used while that stays <= tau.  So the switch distance is
     errM x viewH / (2 tan(fov/2) tau): it follows the render scale (viewH is the drawing buffer), the field of view and the ladder (tau / k) instead of one fixed number. */
  function projErrPx(errM, dist, fovDeg, viewH) { return errM * viewH / (2 * Math.max(1e-6, dist) * Math.tan(fovDeg * Math.PI / 360)); }
  function errDist(errM, tauPx, fovDeg, viewH) { return errM * viewH / (2 * Math.tan(fovDeg * Math.PI / 360) * tauPx); }
  /* distance at which LOD1 hands over to the impostor: from the impostor's error, clamped between 1.5 x the LOD0 leave distance and 0.9 x the cull (the table row 'mansion.lod2In'
     is the fallback when the error is unknown).  k = ladder scale (< 1 = shed: a larger tolerance, so the cheaper level starts sooner). */
  function lod2Dist(tier, errM, fovDeg, viewH, k) {
    if (!(errM > 0) || !(fovDeg > 1) || !(viewH > 0)) return get(tier, 'mansion.lod2In');
    const d = errDist(errM, get(tier, 'lod.tauPx') / Math.max(0.25, k == null ? 1 : k), fovDeg, viewH);
    return Math.max(get(tier, 'mansion.out') * 1.5, Math.min(get(tier, 'mansion.far') * 0.9, d));
  }
  /* index of the cheapest level of an error chain (errors ascending: [e0 < e1 < ...], level 0 = full detail) that still projects <= tau; hysteresis `prev` (last answer, -1 none): the
     finer level returns only when the coarser one exceeds tau x 1.15 */
  function levelByError(chain, dist, tauPx, fovDeg, viewH, prev) {
    let best = 0; for (let i = 0; i < chain.length; i++) if (projErrPx(chain[i], dist, fovDeg, viewH) <= tauPx) best = i;
    if (prev >= 0 && prev > best && projErrPx(chain[prev], dist, fovDeg, viewH) <= tauPx * 1.15) return prev;
    return best;
  }
  /* ── VIEW BILLBOARDS (groundwork; 12 views around the up axis, as in scthe/nanite-webgpu): which two baked views a camera sees an object with yaw `objYaw` from, and the dither weight
     of the second.  az = camera azimuth around the object (rad).  Returns [a, b, t] with a, b in 0..n-1, t in 0..1. */
  function billboardViews(az, objYaw, n) {
    n = n || 12; let a = (az - (objYaw || 0)) / (2 * Math.PI) * n; a = ((a % n) + n) % n; const i = Math.floor(a);
    return [i % n, (i + 1) % n, a - i];
  }
  function billboardPx(radiusM, dist, fovDeg, viewH) { return 2 * radiusM * viewH / (2 * Math.max(1e-6, dist) * Math.tan(fovDeg * Math.PI / 360)); }

  /* ── CHUNK CULL (conservative, flat frame): is a disc of radius R at (cx, cz) outside the camera's horizontal wedge?  Camera at (px, pz), orientation quaternion (qx, qy, qz, qw), vertical
     fov, aspect.  The wedge half-angle is atan(tan(hfov/2) / cos(pitch)) + 25 deg + asin(R / dist); nothing closer than R + 150 m is ever culled, nor anything while the camera looks within
     ~66 deg of straight up / down (the horizontal heading is meaningless there).  Returns true = cull. */
  function chunkCulled(px, pz, qx, qy, qz, qw, fovDeg, aspect, cx, cz, R) {
    const fx = -2 * (qx * qz + qw * qy), fz = -(1 - 2 * (qx * qx + qy * qy)), hl = Math.hypot(fx, fz);
    if (hl < 0.4) return false;
    const dx = cx - px, dz = cz - pz, dist = Math.hypot(dx, dz); if (dist <= R + 150) return false;
    const half = Math.atan(Math.tan(fovDeg * Math.PI / 360) * (aspect || 1.6) / Math.max(0.3, hl)) + 0.436, slack = Math.asin(Math.min(1, R / dist));
    if (half + slack >= Math.PI) return false;
    return (dx * fx + dz * fz) / (dist * hl) < Math.cos(half + slack);
  }

  /* Extra texture LOD for a detail band: 0 at / inside `a`, `bias` at / beyond `b`, smooth between. */
  function mipBias(d, a, b, bias) { return (1 - fade(d, a, b)) * bias; }

  /* Table validation (also run by the node test): every row has 3 numbers; classes never get a LONGER reach than a stronger class; enter < leave < far; shadow < cut. */
  function validate() {
    const bad = [];
    for (const k in TABLE) { const r = TABLE[k]; if (r.length !== 3 || r.some(x => !(x >= 0) || !isFinite(x))) bad.push(k + ': malformed'); }
    ['prop.cutMax', 'prop.shadow', 'prop.ring', 'mansion.far', 'facility.cull', 'vantage.reach', 'mansion.lod2In', 'impostor.tris'].forEach(k => { const r = TABLE[k]; if (!(r[0] <= r[1] && r[1] <= r[2])) bad.push(k + ': not monotone across classes'); });
    TIERS.forEach((t, i) => {
      if (!(get(t, 'mansion.in') < get(t, 'mansion.out'))) bad.push(t + ': mansion.in >= out');
      if (!(get(t, 'mansion.out') < get(t, 'mansion.far'))) bad.push(t + ': mansion.out >= far');
      if (!(get(t, 'prop.shadow') < get(t, 'prop.cutMax'))) bad.push(t + ': shadow >= cut');
      if (!(get(t, 'prop.cutMin') <= get(t, 'prop.cutMax'))) bad.push(t + ': cutMin > cutMax');
      if (!(get(t, 'mansion.lod2In') > get(t, 'mansion.out') && get(t, 'mansion.lod2In') < get(t, 'mansion.far'))) bad.push(t + ': lod2In outside (out, far)');
      if (!(get(t, 'lod.tauPx') > 0 && get(t, 'billboard.px') > 0)) bad.push(t + ': tau / billboard row');
      if (!(get(t, 'xfade.s') > 0 && get(t, 'prop.fadeS') > 0 && get(t, 'impostor.tris') >= 500 && get(t, 'mip.bias') >= 0 && get(t, 'mip.bias') <= 2)) bad.push(t + ': xfade / impostor / mip row out of range');
      if (!(get(t, 'vantage.reach') > WALK_R)) bad.push(t + ': vantage does not extend the walk radius');
      if (!(get(t, 'prop.cutMax') < get(t, 'vantage.reach'))) bad.push(t + ': props reach past the vantage draw radius');
      if (get(t, 'prop.ring') !== Math.floor(get(t, 'prop.ring')) || get(t, 'prop.ring') < 1) bad.push(t + ': ring not a positive integer');
      void i;
    });
    return bad;
  }

  const core = { TIERS: TIERS, TABLE: TABLE, WALK_R: WALK_R, CHUNK: CHUNK, get: get, sw: sw, fade: fade, projErrPx: projErrPx, errDist: errDist, lod2Dist: lod2Dist, levelByError: levelByError, billboardViews: billboardViews, chunkCulled: chunkCulled, billboardPx: billboardPx, createXfade: createXfade, mipBias: mipBias, propCut: propCut, propRing: propRing, vantageReach: vantageReach, vantageFog: vantageFog, validate: validate, tierIndex: tierIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;

  /* ───────────────────────── browser glue ───────────────────────── */
  const W = root, Q = (W.location && W.location.search) || '';
  const off = /[?&]lod=off\b/.test(Q), forced = (Q.match(/[?&]lod=(low|mobile|desktop)\b/) || [])[1];
  const out = { on: !off, core: core, tier: forced || 'desktop', ver: 0 };
  W.DMLod = out;

  function classify() {   // same test as ui/dm-budget.js classBase()
    if (forced) return forced;
    const g = W.GFX || {};
    if (!g.isMobile) return 'desktop';
    const lowGpu = g.gpuClass === 'low' || (g.score != null && g.score < 55), tiny = g.deviceMem > 0 && g.deviceMem <= 3;
    return lowGpu || tiny ? 'low' : 'mobile';
  }
  function refresh() { const t = classify(); if (t !== out.tier) { out.tier = t; out.ver++; } return t; }
  out.refresh = refresh;
  out.get = function (key) { return get(out.tier, key); };
  const bud = (fn, d) => { try { const B = W.DMBudget; if (B && B.on && B[fn]) return B[fn](); } catch (e) { } return d; };
  out.propCut = function (fog, agl) { return propCut(out.tier, fog, agl, bud('propsK', 1)); };
  out.propRing = function (fog, agl) { return propRing(out.tier, propCut(out.tier, fog, agl, bud('propsK', 1))); };
  out.vantage = function (vt, walk) { return vantageReach(out.tier, vt, walk, bud('groundReach', 1)); };
  out.vantageFog = function (vt, fogFar, drawR) { return vantageFog(out.tier, vt, fogFar, drawR); };
  out.mansion = function () { return { nIn: out.get('mansion.in'), nOut: out.get('mansion.out'), far: out.get('mansion.far') }; };
  out.sw = sw; out.fade = fade; out.createXfade = createXfade;
  out.lod2Dist = function (errM, fovDeg, viewH) { return lod2Dist(out.tier, errM, fovDeg, viewH, bud('propsK', 1)); };
  out.mipBias = function () { return out.on ? out.get('mip.bias') : 0; };

  /* ── SCREEN-DOOR CROSS-FADE (no per-object materials) ──
     Every planet material already has a `maskNode` (ui: index.html _pwMapTag gives it the planet-reveal dither: a discard on the screen-space interleaved-gradient noise).  We AND a second
     test into it: the pixel survives when the same noise falls inside this OBJECT's interval [lo, hi) read from `object.userData.dmFade` (a per-object uniform, updated by the renderer
     as it draws each object - so LOD0 / LOD1 / impostor, or a prop chunk, can share one material and still fade independently).  No dmFade = [0, 1.0001) = everything passes.
     Complementary intervals (DMLod.createXfade().interval) mean a pixel is drawn by exactly one level: no hole, no double layer, no blending, no sorting, and no new discard
     (the mask is already there).  Wrapped once per material (a recompile when it happens); ?lodfade=0 turns it off (swaps snap, as before). */
  const fadeOn = !/[?&]lodfade=0\b/.test(Q);
  let FU = null, wrapped = 0;
  function fadeNode() {
    if (FU || !fadeOn) return FU;
    try {
      const T = W.THREE; if (!T || !W.uniform || !W.vec2 || !W.interleavedGradientNoise || !W.screenCoordinate) return null;
      const u = W.uniform(new T.Vector2(0, 1.0001)).onObjectUpdate(function (fr, self) { const o = fr.object, f = o && o.userData && o.userData.dmFade; if (f) self.value.set(f[0], f[1]); else self.value.set(0, 1.0001); });
      const ign = W.interleavedGradientNoise(W.screenCoordinate.xy);
      FU = ign.greaterThanEqual(u.x).and(ign.lessThan(u.y));
    } catch (e) { FU = null; console.warn('[lod] fade node', e); }
    return FU;
  }
  /* walk `root`; every mesh material that already carries the planet mask gets the fade test.  Returns how many materials are fade-capable under root (so a caller knows whether a
     cross-fade will really fade or must snap).  Cheap to call repeatedly (a flag per material). */
  out.fadeMask = function (root) {
    if (!out.on || !fadeOn || !root) return 0;
    const node = fadeNode(); if (!node) return 0;
    let n = 0;
    root.traverse(function (o) {
      if (!(o.isMesh || o.isInstancedMesh) || !o.material) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        if (!m || !m.isNodeMaterial) continue;
        if (m.userData._dmFade) { n++; continue; }
        if (!m.maskNode || !m.userData._pwf) continue;   // not planet-tagged yet: a later sweep picks it up
        try { m.maskNode = m.maskNode.and(node); m.userData._dmFade = true; m.needsUpdate = true; wrapped++; n++; } catch (e) { console.warn('[lod] fade wrap', e); }
      }
    });
    return n;
  };
  out.fadeOn = fadeOn; out.wrapped = function () { return wrapped; };
  out.setFade = function (obj, lo, hi) { const u = obj.userData; if (hi - lo >= 1) { if (u.dmFade) u.dmFade = null; return; } (u.dmFade || (u.dmFade = [0, 1.0001]))[0] = lo; u.dmFade[1] = hi; };
  out.stats = function () { return { tier: out.tier, on: out.on, propCut900: out.propCut(900, 0), ring: out.propRing(420, 0), vantage: out.vantage(1) }; };
  // GFX is filled by detectCapabilities() after the scripts load: classify on first use and again a little later
  refresh(); setTimeout(refresh, 1600); setTimeout(refresh, 6000);
})(typeof window !== 'undefined' ? window : globalThis);
