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

  /* Table validation (also run by the node test): every row has 3 numbers; classes never get a LONGER reach than a stronger class; enter < leave < far; shadow < cut. */
  function validate() {
    const bad = [];
    for (const k in TABLE) { const r = TABLE[k]; if (r.length !== 3 || r.some(x => !(x >= 0) || !isFinite(x))) bad.push(k + ': malformed'); }
    ['prop.cutMax', 'prop.shadow', 'prop.ring', 'mansion.far', 'facility.cull', 'vantage.reach'].forEach(k => { const r = TABLE[k]; if (!(r[0] <= r[1] && r[1] <= r[2])) bad.push(k + ': not monotone across classes'); });
    TIERS.forEach((t, i) => {
      if (!(get(t, 'mansion.in') < get(t, 'mansion.out'))) bad.push(t + ': mansion.in >= out');
      if (!(get(t, 'mansion.out') < get(t, 'mansion.far'))) bad.push(t + ': mansion.out >= far');
      if (!(get(t, 'prop.shadow') < get(t, 'prop.cutMax'))) bad.push(t + ': shadow >= cut');
      if (!(get(t, 'prop.cutMin') <= get(t, 'prop.cutMax'))) bad.push(t + ': cutMin > cutMax');
      if (!(get(t, 'vantage.reach') > WALK_R)) bad.push(t + ': vantage does not extend the walk radius');
      if (!(get(t, 'prop.cutMax') < get(t, 'vantage.reach'))) bad.push(t + ': props reach past the vantage draw radius');
      if (get(t, 'prop.ring') !== Math.floor(get(t, 'prop.ring')) || get(t, 'prop.ring') < 1) bad.push(t + ': ring not a positive integer');
      void i;
    });
    return bad;
  }

  const core = { TIERS: TIERS, TABLE: TABLE, WALK_R: WALK_R, CHUNK: CHUNK, get: get, sw: sw, fade: fade, propCut: propCut, propRing: propRing, vantageReach: vantageReach, vantageFog: vantageFog, validate: validate, tierIndex: tierIndex };
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
  out.sw = sw; out.fade = fade;
  out.stats = function () { return { tier: out.tier, on: out.on, propCut900: out.propCut(900, 0), ring: out.propRing(420, 0), vantage: out.vantage(1) }; };
  // GFX is filled by detectCapabilities() after the scripts load: classify on first use and again a little later
  refresh(); setTimeout(refresh, 1600); setTimeout(refresh, 6000);
})(typeof window !== 'undefined' ? window : globalThis);
