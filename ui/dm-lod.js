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
 *   prop.errM/tauPx prop size (m) / px for the error-driven chunk cut 1.0/2.2 1.2/1.8 1.4/1.4
 *   terrain.reliefK relief-aware ground tile split                  0.4    0.7    1.0
 *   mip.bias        extra mip level at the far end of a detail band   1.0    0.8    0.5
 *   terrain.splitK (perf-mars) SkyGround split distance scale        .78    .88    1.0   x (0.5 + 0.5 x ladder ground reach)  (t1644: only with ?splitk=legacy; default 1 = PR #111)
 *   shadow.minExt   (perf-mars) skinned pieces under this fraction of her height do not cast into the sun shadow   .1   .1   0
 *
 * (v309) CLASSIC BASE.  The default table is the one that shipped before the Nov 5 far-range work (props 1400 m cut / 3x3 chunks, shadows 110 / 170, mansion 300-360 / 400-470, cull 5200 / 6000,
 *   no vantage extension, no mip bias, no relief-split, no error-driven cut, no chunk fade-in, no mansion impostor).  The Nov 5 additions are kept as the FAR table, off unless ?lodfar=1
 *   (DMLod.far); pure efficiency wins (chunk wedge cull, SkyGround budget / allocation work, queue-not-drop) are not behind it.  Rows marked [far] differ between the two tables.
 *
 * Public: DMLod.tier · .on · .get(key) (tier value) · .propCut(fog, agl) · .propRing(fog, agl) · .vantage(vt) · .mansion() · .sw(state, d, enter, leave) · .core
 */
(function (root) {
  'use strict';

  const TIERS = ['low', 'mobile', 'desktop'];
  // CLASSIC (default): the numbers the game used before 4ef7b2d.  Rows tagged [far] are the Nov 5 values, in FAR below.
  const TABLE = {
    'prop.cutMax':   [1400, 1400, 1400],     // [far 700 / 1000 / 1400] the old formula: min(fog x 1.05, agl > 60 ? fog x .85 : 1400)
    'prop.cutMin':   [260, 260, 260],
    'prop.shadow':   [110, 110, 170],        // [far 90 / 110 / 170]
    'prop.ring':     [1, 1, 1],              // [far 1 / 2 / 3] the 3x3 chunks around you, as before
    'prop.hyst':     [1.06, 1.06, 1.06],
    'prop.colRing':  [1, 1, 1],
    'mansion.in':    [300, 300, 400],
    'mansion.out':   [360, 360, 470],
    'mansion.far':   [5200, 5200, 5200],     // [far 4200 / 5200 / 5200]
    'facility.cull': [6000, 6000, 6000],     // [far 4800 / 6000 / 6000]
    'vantage.on':    [0, 0, 0],              // [far 1] 0 = the walking draw radius is never extended from a high vantage
    'vantage.reach': [1800, 2800, 4500],     // used only when vantage.on
    'vantage.fog':   [0.6, 0.62, 0.62],
    'water.minH':    [4, 4, 4],
    'lod2.on':       [0, 0, 0],              // [far 1] mansion LOD1 -> impostor level
    'mansion.lod2In':  [1300, 1500, 2200],   // LOD1 -> impostor (LOD2) enter distance; leave = x0.92 (far only)
    'xfade.s':       [0.35, 0.45, 0.6],      // cross-fade seconds for the mansion LOD swaps (far only; the fade mask is not installed in classic)
    'prop.fadeS':    [0.4, 0.5, 0.6],        // newly shown prop chunk fade-in seconds (far only)
    'impostor.tris': [1600, 2600, 4200],     // impostor triangle target (vertex clustering)
    'lod.tauPx':     [6, 4.5, 3],            // error-driven LOD: a level is used while its geometric error projects to <= this many pixels
    'billboard.px':  [30, 24, 18],           // on-screen size (px) below which an instanced prop may be drawn as a view billboard (groundwork; also the mansion size fade's projection)
    'prop.errOn':    [0, 0, 0],              // [far 1] error-driven prop chunk cut
    'prop.errM':     [1.0, 1.2, 1.4],        // typical prop size (m) whose projected size sets the chunk draw cut (a boulder / tree crown)
    'prop.tauPx':    [2.2, 1.8, 1.4],        // ... drawn while that size projects to >= this many pixels
    'terrain.reliefK': [0, 0, 0],            // [far 0.4 / 0.7 / 1.0] how much more finely the far ground tiles split where they hold relief
    'terrain.splitK': [0.78, 0.88, 1],       // (perf-mars) scale of the SkyGround split distance factor K (1.8): fewer, larger ground tiles on a phone / tablet (tris AND draw calls); x (0.5 + 0.5 x ladder ground reach)
    'shadow.minExt': [0.1, 0.1, 0],          // (perf-mars) sun-shadow casters: a skinned piece whose bind-pose extent is < this fraction of her height does not cast (accessories); 0 = everything casts (desktop)
    'mansion.goneDiam': [56, 48, 40],        // (v289) mansion + cliff is invisible when its bounding sphere projects to <= this many px across (altitude / distance fade)
    'mansion.fullDiam': [96, 84, 70],        // ... and fully drawn at >= this many px (smoothstep between): it cannot be seen from near-space
    'mip.bias':      [0, 0, 0],              // [far 1.0 / 0.8 / 0.5] extra texture LOD (mips) at the far end of a detail band
  };
  // the Nov 5 far-range values (rows not listed are identical in both tables)
  const FAR = Object.assign({}, TABLE, {
    'prop.cutMax': [700, 1000, 1400], 'prop.shadow': [90, 110, 170], 'prop.ring': [1, 2, 3], 'mansion.far': [4200, 5200, 5200], 'facility.cull': [4800, 6000, 6000],
    'vantage.on': [1, 1, 1], 'lod2.on': [1, 1, 1], 'prop.errOn': [1, 1, 1], 'terrain.reliefK': [0.4, 0.7, 1.0], 'mip.bias': [1.0, 0.8, 0.5],
  });
  let ACTIVE = TABLE;
  const WALK_R = 1200;     // the on-foot draw radius floor in index.html (walkR = max(1200, fogFar x 2.5)); a vantage extends it, never shrinks it
  const CHUNK = 300;       // SURF_CHUNK in index.html

  function tierIndex(name) { const i = TIERS.indexOf(name); return i < 0 ? 1 : i; }
  function get(tier, key) { const row = ACTIVE[key]; return row ? row[tierIndex(tier)] : undefined; }
  function setFar(on) { ACTIVE = on ? FAR : TABLE; return ACTIVE; }

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
    if (!get(tier, 'vantage.on')) return walk == null ? WALK_R : walk;   // classic: no extension
    const r = get(tier, 'vantage.reach'), w = walk == null ? WALK_R : walk, ext = Math.max(0, r - w) * (gk == null ? 1 : gk);
    return w + ext * Math.max(0, Math.min(1, vt));
  }
  /* Haze far distance from a vantage: blends the low-ground fog distance toward vantage.fog x reach, never past 0.92 x the drawn radius. */
  function vantageFog(tier, vt, fogFar, drawR) {
    if (!get(tier, 'vantage.on')) return fogFar;   // classic: the haze stays where the low-ground tier put it
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
  /* Prop chunk draw cut, error-driven: the table's fog-bound cut (propCut) is capped at the distance where a typical prop (prop.errM) projects to prop.tauPx pixels, so a smaller
     drawing buffer (render scale, a phone) or a narrower view draws fewer / nearer chunks by itself.  Never below prop.cutMin; k = ladder scale (applied last). */
  function propCutErr(tier, fog, agl, k, fovDeg, viewH) {
    const raw = propCut(tier, fog, agl, 1), cutMin = get(tier, 'prop.cutMin');
    if (!get(tier, 'prop.errOn') || !(fovDeg > 1) || !(viewH > 0)) return raw * (k == null ? 1 : k);
    const e = errDist(get(tier, 'prop.errM'), get(tier, 'prop.tauPx'), fovDeg, viewH);
    return Math.max(cutMin, Math.min(raw, e)) * (k == null ? 1 : k);
  }
  /* Ground tile split boost for relief: a tile of `size` m holding `range` m of height (a cliff, a coastal scarp) splits farther out, so the drop keeps its edge instead of becoming a
     50 m ramp: factor 1 + min(0.7, 2.5 x range / size) x reliefK x gk (reliefK from the table, gk = ladder ground reach). 1 for flat ground; <= 1.7 always. */
  function reliefBoost(tier, range, size, gk) {
    if (!(range > 0) || !(size > 0)) return 1;
    return 1 + Math.min(0.7, 2.5 * range / size) * get(tier, 'terrain.reliefK') * (gk == null ? 1 : gk);
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

  /* (v289) screen-size fade: 0 when the object's projected diameter is <= gone px, 1 at >= full px, smoothstep between.  The caller multiplies this into the screen-door interval
     (a landmark that is a speck from altitude is not drawn at all, so the 5 % of the planet radius that Ariel's cliff mansion spans is not seen from near-space). */
  function sizeFade(diamPx, gone, full) { if (!(full > gone)) return diamPx > gone ? 1 : 0; const t = Math.max(0, Math.min(1, (diamPx - gone) / (full - gone))); return t * t * (3 - 2 * t); }

  /* Extra texture LOD for a detail band: 0 at / inside `a`, `bias` at / beyond `b`, smooth between. */
  function mipBias(d, a, b, bias) { return (1 - fade(d, a, b)) * bias; }

  /* ── (fov-fill 2) QUALITY FADE CHAIN TO THE HORIZON ──
     Every layer that has a "near, high quality" version also has a cheaper one that carries on past it, and each hand-off is a smoothstep band, never a cut,
     so the view is filled out to where the ground itself dissolves (index.html: the haze ends at fogEnd = 0.82 x groundR on foot, the ground is gone at groundR).
     Pure: index.html / ui/dm-light.js read the same numbers (uniforms, set a few times a second, no recompile); tools/tests/fov-fade.js checks the chain.
       tex     near  [0.45 r, r]          the close-up field (worley pebbles / grit / cracks + their bump): unchanged, never past r
               mid   [5 r, 16 r]          one 2-octave value field, colour + roughness only (no worley, no normal): the ground keeps a grain past the pebbles
               far   [fogEnd, groundR]    one low-octave macro tint (patches of 60 u and 260 u) on every ground pixel, gone with the ground's own dissolve
       light   probes (SH cascades) out to their window, then a cheap far term (sky visibility from the coarse ground's normal + the horizon height field's
               cavity) that lasts to groundR; sun visibility: near march, far 8 m field, then the horizon field (48 m cells) to `hor`
       shadow  map   [0.82 h, 0.97 h]     the sun's shadow map (crisp, props + her) eased out at the edge of its own box (h = box half), not a square cut (t1537: was [0.6 h, 0.92 h] of a 0.62x box = a lit ring round her)
               terrain                    height-field march (near / far / horizon) beyond it, coarser with distance, to the horizon field's edge
       props   near  [0.72 c, c]          full prop chunks (trees, rocks; colliders near), c = min(draw cut, ring x 300): per-pixel dither, no chunk line
               far   in = 1 - near, out [0.8 fogEnd, fogEnd]   the far canopy (one instanced draw, crown cones only) from where the near trees thin to the haze end
     o: { reach, fogEnd, groundR, shadowHalf, propCut, ring, horHalf }.  Returns arrays [a, b] (1 inside a, 0 beyond b; props.farIn is the far canopy's rising edge = the near layer's falling one).
     res (optional): an object of the same shape to fill in place (the per-tick callers pass one: no allocation). */
  function S2(a, x, y) { a[0] = x; a[1] = y; }
  // (t1537) the sun shadow map's ease-out, as fractions of its box half h: was [0.6, 0.92] (with the 0.62x on-foot box that was 17-26 u on Low). Past the band nothing casts
  // the sun shadow, so a roofed floor (the mansion decks, any overhang) turned sunlit on a ring round her. Now the map holds to 0.82 h and is gone by 0.97 h (still inside the
  // inscribed circle of the square box: no square edge), i.e. 37-44 u on a 512 map, 57-68 u on 1024, 90-107 u on 2048 - past the third-person camera (~26 u behind her).
  const SHADOW_FADE = [0.82, 0.97];
  function qualityBands(tier, o, res) {
    o = o || {};
    const fe = Math.max(60, o.fogEnd || 420), gR = Math.max(fe * 1.0001, o.groundR || fe / 0.82), r = Math.max(4, o.reach || 30);
    const h = Math.max(8, o.shadowHalf || 70), ring = Math.max(1, o.ring || get(tier, 'prop.ring')), cut = Math.max(get(tier, 'prop.cutMin'), o.propCut || get(tier, 'prop.cutMax'));
    const c = Math.min(cut, ring * CHUNK), hor = Math.max(fe, o.horHalf || 2900);
    const B = res || { tex: { near: [0, 0], mid: [0, 0], far: [0, 0] }, light: { far: [0, 0], hor: [0, 0] }, shadow: { map: [0, 0], hor: [0, 0] }, props: { near: [0, 0], far: [0, 0], farIn: [0, 0] }, fogEnd: 0, groundR: 0 };
    S2(B.tex.near, r * 0.45, r); S2(B.tex.mid, r * 5, r * 16); S2(B.tex.far, fe, gR);
    S2(B.light.far, fe, gR); S2(B.light.hor, hor * 0.75, hor * 0.92);
    S2(B.shadow.map, h * SHADOW_FADE[0], h * SHADOW_FADE[1]); S2(B.shadow.hor, hor * 0.75, hor * 0.92);
    S2(B.props.near, c * 0.72, c); S2(B.props.far, fe * 0.8, fe); S2(B.props.farIn, c * 0.72, c);
    B.fogEnd = fe; B.groundR = gR;
    return B;
  }
  /* weight of a band at distance d (1 inside, 0 outside, smoothstep across) — the same curve the shaders use */
  function bandW(d, ab) { return fade(d, ab[0], ab[1]); }
  /* screen coverage of the two prop layers at distance d: the near chunks keep a pixel whose noise is < wN, the far canopy one whose noise is in [wN, wF) — so
     where both exist the coverage is max(wN, wF) (one layer hands its pixels to the other), never a gap and never a double layer. */
  function propCover(d, B) { const wN = bandW(d, B.props.near), wF = bandW(d, B.props.far); return Math.max(wN, wF); }

  /* Table validation (also run by the node test): every row has 3 numbers; classes never get a LONGER reach than a stronger class; enter < leave < far; shadow < cut. */
  function validate() {
    const bad = [], keep = ACTIVE, res = [];
    [false, true].forEach(f => { setFar(f); validateOne(res); });
    ACTIVE = keep; return res;
  }
  function validateOne(bad) {
    for (const k in ACTIVE) { const r = ACTIVE[k]; if (r.length !== 3 || r.some(x => !(x >= 0) || !isFinite(x))) bad.push(k + ': malformed'); }
    ['terrain.splitK'].forEach(k => { const r = ACTIVE[k]; if (!(r[0] <= r[1] && r[1] <= r[2])) bad.push(k + ': not monotone across classes'); });
    ['prop.cutMax', 'prop.shadow', 'prop.ring', 'mansion.far', 'facility.cull', 'vantage.reach', 'mansion.lod2In', 'impostor.tris'].forEach(k => { const r = ACTIVE[k]; if (!(r[0] <= r[1] && r[1] <= r[2])) bad.push(k + ': not monotone across classes'); });
    TIERS.forEach((t, i) => {
      if (!(get(t, 'mansion.in') < get(t, 'mansion.out'))) bad.push(t + ': mansion.in >= out');
      if (!(get(t, 'mansion.out') < get(t, 'mansion.far'))) bad.push(t + ': mansion.out >= far');
      if (!(get(t, 'prop.shadow') < get(t, 'prop.cutMax'))) bad.push(t + ': shadow >= cut');
      if (!(get(t, 'prop.cutMin') <= get(t, 'prop.cutMax'))) bad.push(t + ': cutMin > cutMax');
      if (!(get(t, 'mansion.lod2In') > get(t, 'mansion.out') && get(t, 'mansion.lod2In') < get(t, 'mansion.far'))) bad.push(t + ': lod2In outside (out, far)');
      if (!(get(t, 'prop.errM') > 0 && get(t, 'prop.tauPx') > 0 && get(t, 'terrain.reliefK') >= 0 && get(t, 'terrain.reliefK') <= 1)) bad.push(t + ': prop err / relief row');
      if (!(get(t, 'lod.tauPx') > 0 && get(t, 'billboard.px') > 0)) bad.push(t + ': tau / billboard row');
      if (!(get(t, 'terrain.splitK') >= 0.5 && get(t, 'terrain.splitK') <= 1 && get(t, 'shadow.minExt') >= 0 && get(t, 'shadow.minExt') < 0.2)) bad.push(t + ': splitK / shadow.minExt row out of range');
      if (!(get(t, 'xfade.s') > 0 && get(t, 'prop.fadeS') > 0 && get(t, 'impostor.tris') >= 500 && get(t, 'mip.bias') >= 0 && get(t, 'mip.bias') <= 2)) bad.push(t + ': xfade / impostor / mip row out of range');
      if (!(get(t, 'mansion.goneDiam') > 0 && get(t, 'mansion.goneDiam') < get(t, 'mansion.fullDiam'))) bad.push(t + ': mansion size fade gone >= full');
      if (!(get(t, 'vantage.reach') > WALK_R)) bad.push(t + ': vantage does not extend the walk radius');
      if (!(get(t, 'prop.cutMax') < get(t, 'vantage.reach'))) bad.push(t + ': props reach past the vantage draw radius');
      if (get(t, 'prop.ring') !== Math.floor(get(t, 'prop.ring')) || get(t, 'prop.ring') < 1) bad.push(t + ': ring not a positive integer');
      void i;
    });
    return bad;
  }

  /* THE LOD CENTRE (bubble-lod).  One rule for every world and every view (orbit camera, third person, first person, spectator): the LOD set (prop chunks, the far canopy, the sea sheet,
     the vantage height) is centred on the CAMERA's ground point - the camera's x / z in the world's flat frame, with height measured above the ground UNDER the camera (the playable
     ground level of that map: H(x, z), y = 0 on a flat map) - not on the player / board / spectator focus.  The ground tiles, the parallax march, the fade masks and the sparse-voxel
     bricks were already distance-from-camera; this makes the rest agree.  Gameplay streaming that must follow HER (colliders, the marching-cubes patch, the sun shadow box, light
     probes) keeps the driver: the driver is passed through unchanged (drv).  No camera (space / not placed yet) -> the driver is the centre.
     cam = [x, y, z] flat camera (or null), gc = ground height under the camera, drv = [x, z, agl].  out = {x, z, y, agl, g, camera, off} (written in place, returned). */
  function lodCentre(cam, gc, drv, out) {
    const o = out || {};
    if (cam && isFinite(cam[0]) && isFinite(cam[1]) && isFinite(cam[2])) {
      const g = isFinite(gc) ? gc : 0;
      o.x = cam[0]; o.z = cam[2]; o.y = cam[1]; o.g = g; o.agl = Math.max(0, cam[1] - g); o.camera = true;
      o.off = drv ? Math.hypot(cam[0] - drv[0], cam[2] - drv[1]) : 0;
    } else { o.x = drv[0]; o.z = drv[1]; o.y = 0; o.g = 0; o.agl = drv[2] || 0; o.camera = false; o.off = 0; }
    return o;
  }

  /* ── VIEW-CENTRE GROUND POINT + HORIZON (shield-lod) ──
     The LOD centre is not "where the camera is" when the camera is tilted down (the orbit camera over her shoulder, third person looking at the ground at her feet, a head-height camera
     looking down at her face): it is the ground point at the CENTRE OF THE VIEW (the camera's forward ray meeting the playable ground, refined against the terrain height, not only the
     plane), and the horizon / reach are those of a camera STANDING LEVEL ON THE GROUND AT THAT POINT (eye height `eye`, never the camera's own height above it).  A camera that looks
     level or up (the ray never meets the ground) keeps its own ground point.  Pure.
       cam = [x, y, z] flat camera, fwd = [x, y, z] its forward unit vector, groundAt(x, z) -> terrain height, R = planet radius (world units, the same radius the sky uses),
       eye = standing eye height above the ground (world units), relief = tallest ground that may stand beyond the horizon (terrain heights count: a peak past the geometric horizon shows
       its top: horizonDist adds that peak's own horizon).  out (optional, written in place) = { x, z, g, hit, off, eye, horizon }.
     The horizon is geometry only (Pythagoras on the sphere), so it is the same rule on every world: no per-world radius, no constant that cuts it short. */
  function horizonDist(R, eye, relief) { const h = Math.max(0, eye || 0), r = Math.max(0, relief || 0), RR = Math.max(1, R || 1); return Math.sqrt(h * (2 * RR + h)) + Math.sqrt(r * (2 * RR + r)); }
  function viewGround(cam, fwd, groundAt, R, eye, relief, out) {
    const o = out || {}, cx = cam[0], cy = cam[1], cz = cam[2], fx = fwd[0], fy = fwd[1], fz = fwd[2];
    const g0 = groundAt(cx, cz), gc = isFinite(g0) ? g0 : 0, agl = Math.max(0, cy - gc);
    let x = cx, z = cz, g = gc, hit = false;
    if (fy < -0.02) {   // looking down enough for the centre ray to meet the ground: plane first, then refined against the height field (3 steps)
      // plane first, then a secant refine of f(t) = ray height - terrain height along the ray (exact on a planar slope, a few steps on noise); t stays in [0, 3 x plane + 50]
      const F = t => { const gh = groundAt(cx + fx * t, cz + fz * t); return cy + fy * t - (isFinite(gh) ? gh : gc); };
      const tp = agl / -fy, tmax = tp * 3 + 50; let t0 = tp, f0 = F(t0), t1 = tp * 0.8 + 1e-3, f1 = F(t1);
      for (let i = 0; i < 4; i++) { const den = f1 - f0; if (!(Math.abs(den) > 1e-9)) break; let t2 = t1 - f1 * (t1 - t0) / den; if (!isFinite(t2)) break; t2 = Math.max(0, Math.min(tmax, t2)); t0 = t1; f0 = f1; t1 = t2; f1 = F(t1); if (Math.abs(f1) < 1e-4) break; }
      let t = t1, hx = cx + fx * t, hz = cz + fz * t;
      const hd = Math.hypot(hx - cx, hz - cz), lim = Math.max(1, horizonDist(R, agl, 0));   // never past what this camera could see level
      if (hd > lim) { const k = lim / hd; hx = cx + (hx - cx) * k; hz = cz + (hz - cz) * k; }
      if (isFinite(hx + hz)) { x = hx; z = hz; const gh = groundAt(x, z); g = isFinite(gh) ? gh : g; hit = true; }
    }
    const e = Math.max(0.3, Math.min(agl > 0 ? Math.max(agl, 0.3) : eye, eye));   // standing level: her eye height (lower when the camera is lower)
    o.x = x; o.z = z; o.g = g; o.hit = hit; o.off = Math.hypot(x - cx, z - cz); o.eye = e; o.horizon = horizonDist(R, e, relief);
    return o;
  }
  /* How far the on-foot ground / haze open toward that horizon, 0..1 (the same smooth weight family as the vantage k).  flag: 'off' | 'on' (all tiers) | number | undefined (= tier default).
     Tier defaults: desktop 1, mobile 0.35, low 0.2 - a weak tablet opens only part of the way - then the budget ladder's ground stage (gk 1 / .8 / .6, DMBudget.groundReach) scales it:
     full at gk 1, 0.6 at .8, 0.2 at .6, 0 below .5.  Weight 0 = exactly the previous on-foot radius. */
  const HZ_TIER = { low: 0.2, mobile: 0.35, desktop: 1 };
  function horizonW(tier, flag, gk) {
    if (flag === 'off' || flag === 0) return 0;
    const base = typeof flag === 'number' ? Math.max(0, Math.min(1, flag)) : flag === 'on' ? 1 : (HZ_TIER[tier] == null ? 0.35 : HZ_TIER[tier]);
    const k = gk == null ? 1 : Math.max(0, Math.min(1, (gk - 0.5) / 0.5));
    return base * k;
  }
  /* The haze far distance with the horizon opened: lerp(fogFar, 0.62 x horizon, w), never past 0.92 x the drawn ground radius, never below fogFar (0.62 is vantage.fog's ratio). */
  function horizonFog(fogFar, horizon, w, drawR) {
    const v = fogFar + (Math.max(fogFar, 0.62 * horizon) - fogFar) * Math.max(0, Math.min(1, w));
    return Math.max(fogFar, Math.min(v, Math.max(fogFar, drawR * 0.92)));
  }

  /* (perf-mars) SkyGround split factor for a class: K x table x (0.5 + 0.5 x ladder ground reach 1 / .8 / .6).  Pure; <= 1 always, so a tile never splits MORE than the old constant. */
  function splitScale(tier, gk) { return get(tier, 'terrain.splitK') * (0.5 + 0.5 * Math.max(0, Math.min(1, gk == null ? 1 : gk))); }
  /* (perf-mars) far-terrain colour smoothing.  The ground's vertex colours come from thresholds on height / slope (rock vs sand, strata): sampled every 11-44 m on a far tile they alias into
     hard stair-steps along the grid.  A tent filter over the colour grid (passes of [1 2 1] x [1 2 1], clamp at the edge) turns them into soft gradients.  passes by sample spacing (m). */
  function blurPasses(step) { return !(step >= 5) ? 0 : step < 11 ? 1 : 2; }
  /* in place: a = Float32Array(n*n*3) (r,g,b per cell, row-major), tmp = same length scratch; returns a */
  function blurRGB(a, n, passes, tmp) {
    const t = tmp || new Float32Array(a.length), N3 = n * 3;
    for (let p = 0; p < passes; p++) {
      for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) { const i = (r * n + q) * 3, l = (r * n + (q > 0 ? q - 1 : 0)) * 3, h = (r * n + (q < n - 1 ? q + 1 : n - 1)) * 3; for (let c = 0; c < 3; c++) t[i + c] = (a[l + c] + 2 * a[i + c] + a[h + c]) * 0.25; }
      for (let r = 0; r < n; r++) { const rl = (r > 0 ? r - 1 : 0) * N3, rh = (r < n - 1 ? r + 1 : n - 1) * N3, ri = r * N3; for (let q = 0; q < N3; q++) a[ri + q] = (t[rl + q] + 2 * t[ri + q] + t[rh + q]) * 0.25; }
    }
    return a;
  }
  /* (perf-mars) which skinned pieces cast into the sun's shadow map.  ext[i] = bind-pose bounding extent of piece i; the cut is minFrac x the tallest piece (her height).  lvl >= 1 (ladder shadow / skin
     stage or the fast guard) raises it to 0.13, which also drops the scalp cap.  Never returns an all-false set (the biggest piece always casts).  Pure. */
  function casterSet(ext, minFrac, lvl) {
    const n = ext.length, out = new Array(n); let mx = 0, bi = 0;
    for (let i = 0; i < n; i++) if (ext[i] > mx) { mx = ext[i]; bi = i; }
    const cut = minFrac > 0 ? mx * Math.max(minFrac, lvl >= 1 ? 0.13 : 0) : 0;
    for (let i = 0; i < n; i++) out[i] = ext[i] >= cut;
    if (n) out[bi] = true;
    return out;
  }
  const core = { viewGround: viewGround, horizonDist: horizonDist, horizonW: horizonW, horizonFog: horizonFog, lodCentre: lodCentre, TIERS: TIERS, TABLE: TABLE, FAR: FAR, setFar: setFar, WALK_R: WALK_R, CHUNK: CHUNK, get: get, sw: sw, fade: fade, propCutErr: propCutErr, reliefBoost: reliefBoost, projErrPx: projErrPx, errDist: errDist, lod2Dist: lod2Dist, sizeFade: sizeFade, levelByError: levelByError, billboardViews: billboardViews, chunkCulled: chunkCulled, billboardPx: billboardPx, createXfade: createXfade, mipBias: mipBias, splitScale: splitScale, blurPasses: blurPasses, blurRGB: blurRGB, casterSet: casterSet, qualityBands: qualityBands, bandW: bandW, propCover: propCover, propCut: propCut, propRing: propRing, vantageReach: vantageReach, vantageFog: vantageFog, validate: validate, tierIndex: tierIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;

  /* ───────────────────────── browser glue ───────────────────────── */
  const W = root, Q = (W.location && W.location.search) || '';
  const off = /[?&]lod=off\b/.test(Q), forced = (Q.match(/[?&]lod=(low|mobile|desktop)\b/) || [])[1];
  const farOn = !off && /[?&]lodfar=1\b/.test(Q);   // the Nov 5 far-range table + features (vantage extension, outer prop rings + fade-in, mansion impostor, relief split, mips); default = classic
  core.setFar(farOn);
  const out = { on: !off, far: farOn, core: core, tier: forced || 'desktop', ver: 0 };
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
  out.propCut = function (fog, agl, fov, viewH) { return propCutErr(out.tier, fog, agl, bud('propsK', 1), fov, viewH); };
  out.reliefK = function () { return get(out.tier, 'terrain.reliefK') * bud('groundReach', 1); };
  /* (t1644 CE-7) PR #111 split cadence restored: SkyGround splits at the full K (1.8) on every class and at every ladder stage, so a tablet gets the same
     smooth horizon-to-horizon falloff as the Oct 2 build (no blocky far tiles).  The ladder 'ground' stage sheds props / parallax / reach instead.
     ?splitk=legacy brings back the perf-mars scale (table x ladder ground reach) for an A/B. */
  out.splitLegacy = /[?&]splitk=legacy\b/.test(Q);
  out.splitK = function () { return out.on && out.splitLegacy ? splitScale(out.tier, bud('groundReach', 1)) : 1; };   // x SkyGround.K
  out.blurPasses = function (step) { return out.on && !farSmoothOff ? blurPasses(step) : 0; };
  /* (perf-mars) the sun-shadow caster policy on her skinned pieces.  Cached per model: [{m, ext, c0}]; castShadow is a plain flag (no pipeline rebuild).  Returns the number of casters. */
  out.applyCasters = function (root, lvl) {
    if (!root) return -1;
    let L = root.userData._dmSc;
    if (!L) {
      L = root.userData._dmSc = { list: [], key: '' };
      const T = W.THREE; root.traverse(o => { if (o.isSkinnedMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) { const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox(); const b = g.boundingBox; L.list.push({ m: o, ext: Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z), c0: o.castShadow }); } });
      void T;
    }
    const mf = out.on && !casterOff ? out.get('shadow.minExt') : 0, key = mf + '|' + (lvl >= 1 ? 1 : 0);
    if (L.key === key) return L.n;
    L.key = key; const set = casterSet(L.list.map(e => e.ext), mf, lvl); let n = 0;
    for (let i = 0; i < L.list.length; i++) { const e = L.list[i], c = mf > 0 ? (e.c0 && set[i]) : e.c0; if (e.m.castShadow !== c) e.m.castShadow = c; if (c) n++; }
    return (L.n = n);
  };
  out.propRing = function (fog, agl, fov, viewH) { return propRing(out.tier, propCutErr(out.tier, fog, agl, bud('propsK', 1), fov, viewH)); };
  out.vantage = function (vt, walk) { return vantageReach(out.tier, vt, walk, bud('groundReach', 1)); };
  out.vantageFog = function (vt, fogFar, drawR) { return vantageFog(out.tier, vt, fogFar, drawR); };
  out.mansion = function () { return { nIn: out.get('mansion.in'), nOut: out.get('mansion.out'), far: out.get('mansion.far') }; };
  out.mansionSize = function () { return { gone: out.get('mansion.goneDiam'), full: out.get('mansion.fullDiam') }; };
  const farSmoothOff = /[?&]farsmooth=0\b/.test(Q), casterOff = /[?&]shadowcast=all\b/.test(Q);   // (perf-mars) kill switches: ?farsmooth=0 (far colour smoothing) / ?shadowcast=all (every skinned piece casts)
  const hzFlag = (function () { const m = Q.match(/[?&]lodhorizon=([0-9.]+|on|off)\b/); if (!m) return undefined; return m[1] === 'on' ? 'on' : m[1] === 'off' ? 'off' : (m[1] === '1' ? 'on' : parseFloat(m[1])); })();
  out.horizonW = function () { return out.on ? horizonW(out.tier, hzFlag, bud('groundReach', 1)) : 0; };   // ?lodhorizon=off|0 disables, =on|1 full on every tier, =0.5 a weight
  out.viewGround = viewGround; out.horizonDist = horizonDist; out.horizonFog = horizonFog;
  out.centre = lodCentre; out.sizeFade = sizeFade; out.billboardPx = billboardPx;
  out.sw = sw; out.fade = fade; out.createXfade = createXfade;
  out.lod2Dist = function (errM, fovDeg, viewH) { return lod2Dist(out.tier, errM, fovDeg, viewH, bud('propsK', 1)); };
  out.bands = function (o, res) { return qualityBands(out.tier, o, res); };
  out.SHADOW_FADE = SHADOW_FADE;   // (t1537) read-only: the sun shadow ease-out fractions
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
