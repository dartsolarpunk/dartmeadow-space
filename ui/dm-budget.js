/* DART Meadow — global FRAME-BUDGET controller (perf lane, v256).
 *
 * WHY: the per-feature governors (parallax 3 levels, water lvl, shadow cadence, ui/dm-governor.js render scale) each watch the frame time on
 * their own and none of them knows what the others already gave up.  On the Galaxy Tab (Mali-G615) the Solenne surface ran at 130-500 ms a frame
 * with every one of them already at its floor, and the heavy new layers (36-fetch ground atlas, cliff/mansion parallax, ocean, spray) had no
 * dial at all.  This controller owns ONE integer, the PRESSURE p (0 = full quality, MAX = everything shed), and a fixed, ordered LADDER that maps
 * p to a level per stage.  Every stage is a uniform write or a cadence: no recompile, no render-target recreation (the render scale, the only
 * thing that touches the canvas, is the very last stages and moves at most one rate-limited step at a time).
 *
 * LADDER (first = cheapest to the eye; High/Ultra keep every pixel until the frame rate says otherwise):
 *    1 parallax L1  steps x0.6, reach x0.8, depth x0.9            2 parallax L2  steps <= 4, reach x0.6, depth x0.75
 *    3 pxshadow     parallax self-shadow taps off                  4 ground L1    tile-detail reach x0.8
 *    5 ground L2    reach x0.6 + no second-tile blend (halves the march fetches)
 *    6 water L1     curl/foam detail, spray x0.7, mist x0.6        7 water L2   spray x0.4, no mist, band weights down
 *    8 water L3     no displacement, spray/mist off                9 parallax L3  march off (normal + cavity stay)
 *   10 shadow L1    sun shadow map refreshed every 2nd frame      11 shadow L2   every 3rd frame
 *   12 atmo L1      cloud/density volume re-evaluated at ~7 Hz     13 shadow L3   shadow map side halved (the one allocation, late)
 *   14 atmo L2      volume at 2.5 Hz, near-ground height re-bake slower   15 res L1  render scale <= 0.85   16 res L2  <= 0.72   17 res L3  <= 0.6
 *
 * CONTROL LAW (pure, deterministic, unit-tested by tools/tests/budget-sim.js with fake clocks):
 *  - input: real frame time of every rendered frame (own rAF probe; one subtraction).  EMA (tau 1 s) + p95 of the last ~90 frames; a frame is
 *    clipped to 250 ms and a gap > 1.5 s is a tab-sleep / shader-compile hitch and is not a sample.  Warm-up, intro, hidden tab, AR: no decisions.
 *  - ESCALATE (shed one step; two when the frame is > 2.2x over budget) when the EMA is over the budget (50 ms = below 20 fps) or the p95 is
 *    spiky (> 2.2x budget) while the EMA is within 25% of it, and has stayed so for a dwell of 0.6 s (> 2x over) / 1.0 s (> 1.4x) / 1.6 s.
 *    After every change the window is cleared: the next decision judges only frames drawn at the new setting.
 *  - RECOVER one step after 4 s of calm (EMA < 0.72 x budget and p95 < 1.5 x budget), never while that step is LOCKED.  A step that is undone
 *    (escalated again within 12 s of the recovery) is locked for 20 s, doubling to 5 min: no oscillation, and a device that cannot afford a
 *    step settles below it.  A recovery that held 40 s halves its lock again.
 *  - SEED: the first seconds are not a slideshow: start at max(device-class base, the settled pressure of the last session on this device);
 *    the last session died (no pagehide) -> +1, died on a surface/atmosphere screen -> +2.  Persisted in localStorage (dm_budget_v1).
 *  - Target: sustained >= ~15 fps by shedding in order until the floor.  If everything is shed and the frame is still slow it is CPU-bound beyond
 *    this controller's reach: stats().exhausted says so.
 *
 * Flags: ?gov=off  controller off (every level 0; the older per-feature governors run exactly as before) · ?gov=N  force pressure N (testing) ·
 *        ?govhud=1  corner readout · ?govbudget=ms  override the 50 ms budget.
 * Public: DMBudget.lvl(stage) (0..), .stats(), .force(p), .on, .ver (bumps on every change), typed accessors (.parallax() .shadowEvery() .atmoPeriod() .resCap() ...)
 *   (pure core: DMBudget.core = { createController, LADDER, STAGES, levelsAt, MAX } — also module.exports for node.)
 */
(function (root) {
  'use strict';

  /* ───────────────────────── pure core ───────────────────────── */
  const LADDER = [
    ['parallax', 1], ['parallax', 2], ['pxshadow', 1], ['ground', 1], ['ground', 2],
    ['water', 1], ['water', 2], ['water', 3], ['parallax', 3],
    ['shadow', 1], ['shadow', 2], ['atmo', 1], ['shadow', 3], ['atmo', 2],
    ['res', 1], ['res', 2], ['res', 3],
  ];
  const MAX = LADDER.length;
  const STAGES = ['parallax', 'pxshadow', 'ground', 'water', 'shadow', 'atmo', 'res'];
  function levelsAt(p, out) {
    out = out || {};
    for (let i = 0; i < STAGES.length; i++) out[STAGES[i]] = 0;
    for (let i = 0; i < p && i < MAX; i++) out[LADDER[i][0]] = LADDER[i][1];
    return out;
  }

  function createController(o) {
    o = o || {};
    const N = 96, sorted = new Float32Array(N);
    const C = {
      budget: o.budgetMs || 50, p: 0, base: 0, max: MAX,
      ring: new Float32Array(N), head: 0, count: 0, ema: 0, emaOK: false, t: 0,
      nextEval: 0, over: 0, calm: 0, lastChange: -1e9, lastRecover: -1e9, lastEval: 0, settleUntil: 0,
      lock: new Float64Array(MAX + 2), hold: new Float64Array(MAX + 2),
      changes: 0, esc: 0, rec: 0, fails: 0, history: [], lv: levelsAt(0), ver: 0, exhausted: false, p95: 0, settledP: 0, settledSince: 0, recTo: -1, onChange: o.onChange || null,
    };
    for (let i = 0; i < C.hold.length; i++) C.hold[i] = 20000;

    C.reset = function () { C.head = 0; C.count = 0; C.emaOK = false; C.over = 0; C.calm = 0; C.ema = 0; };
    C.set = function (p, now, why) {
      p = Math.max(0, Math.min(MAX, p | 0)); if (p === C.p) return false;
      const from = C.p; C.p = p; C.lastChange = now; C.changes++; C.ver++; levelsAt(p, C.lv);
      C.reset(); C.settleUntil = now + 700;
      if (C.history.length >= 64) C.history.shift();
      C.history.push([Math.round(now), from, p, why || '']);
      if (C.onChange) { try { C.onChange(C, from, p); } catch (e) { } }
      return true;
    };
    C.seed = function (p, now) {
      C.base = Math.max(0, Math.min(MAX, p | 0)); C.set(C.base, now || 0, 'seed');
      C.lastChange = -1e9; C.changes = 0; C.history.length = 0; C.settledP = C.p; C.settledSince = now || 0; C.settleUntil = 0;
    };

    // one real frame (ms).  Returns true when a decision changed something or hit the floor.
    C.sample = function (ms, now) {
      if (!(ms > 0)) return false;
      if (ms > 1500) { C.reset(); return false; }          // tab sleep / shader compile / GC: not a measurement
      const f = ms > 250 ? 250 : ms;
      C.ring[C.head] = f; C.head = (C.head + 1) % N; if (C.count < N) C.count++;
      if (!C.emaOK) { C.ema = f; C.emaOK = true; } else C.ema += (f - C.ema) * (1 - Math.exp(-f / 1000));
      C.t = now;
      if (now < C.nextEval) return false;
      C.nextEval = now + 400;
      return C.evaluate(now);
    };

    function pct95() {
      const n = Math.min(C.count, 90);
      for (let i = 0; i < n; i++) sorted[i] = C.ring[(C.head - n + i + N * 2) % N];
      const s = sorted.subarray(0, n); s.sort();
      return s[Math.min(n - 1, Math.floor(n * 0.95))];
    }

    C.evaluate = function (now) {
      const dtE = C.lastEval ? Math.min(1500, now - C.lastEval) : 400; C.lastEval = now;
      if (now < C.settleUntil || C.count < 8) return false;
      const B = C.budget, e = C.ema, p95 = pct95(); C.p95 = p95;
      const sev = e / B;
      const bad = e > B || (p95 > B * 2.2 && e > B * 0.75);
      const calm = e < B * 0.72 && p95 < B * 1.5;
      if (bad) { C.over += dtE; C.calm = 0; } else { C.over = Math.max(0, C.over - dtE * 0.5); C.calm = calm ? C.calm + dtE : Math.max(0, C.calm - dtE * 0.5); }
      if (C.recTo >= 0 && C.p === C.recTo && now - C.lastRecover > 40000) { const k = C.recTo + 1; C.hold[k] = Math.max(20000, C.hold[k] / 2); C.recTo = -1; }   // a recovery that held 40 s relaxes its back-off
      if (C.settledP !== C.p) { C.settledP = C.p; C.settledSince = now; }
      if (bad) {
        const dwell = sev > 2 ? 600 : sev > 1.4 ? 1000 : 1600;
        if (C.over >= dwell && now - C.lastChange >= 900) {
          if (C.p >= MAX) { C.exhausted = true; return true; }
          const step = sev > 2.2 && C.p + 2 <= MAX ? 2 : 1;
          if (C.lastRecover > 0 && now - C.lastRecover < 12000) {   // an undone recovery: the level we just left is locked (exponential back-off)
            const lv = Math.min(MAX, C.p + step); C.fails++; C.hold[lv] = Math.min(300000, C.hold[lv] * 2); C.lock[lv] = now + C.hold[lv];   // lock[k]: do not leave pressure k downwards
          }
          C.esc++; C.exhausted = false; C.set(C.p + step, now, 'esc ' + Math.round(e) + 'ms');
          return true;
        }
        return false;
      }
      if (calm && C.p > 0 && C.calm >= 4000 && now - C.lastChange >= 4000) {
        const target = C.p - 1;
        if (now < C.lock[C.p]) return false;
        C.rec++; C.exhausted = false; C.lastRecover = now; C.recTo = target; C.set(target, now, 'rec ' + Math.round(e) + 'ms');
        return true;
      }
      if (C.p < MAX) C.exhausted = false;
      return false;
    };
    C.stats = function () {
      return { p: C.p, max: MAX, base: C.base, lv: C.lv, emaMs: +C.ema.toFixed(1), p95Ms: +C.p95.toFixed(1), budgetMs: C.budget, changes: C.changes, esc: C.esc, rec: C.rec, locks: C.fails, exhausted: C.exhausted, hist: C.history.slice(-12) };
    };
    return C;
  }

  const core = { createController: createController, LADDER: LADDER, STAGES: STAGES, levelsAt: levelsAt, MAX: MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;

  /* ───────────────────────── browser glue ───────────────────────── */
  const W = root, Q = (W.location && W.location.search) || '';
  const offFlag = /[?&]gov=off\b/.test(Q), forceP = ((Q.match(/[?&]gov=(\d+)\b/) || [])[1]);
  const KEY = 'dm_budget_v1';
  const budgetOv = +((Q.match(/[?&]govbudget=(\d+)\b/) || [])[1] || 0);
  const now = () => (W.performance && W.performance.now ? W.performance.now() : Date.now());

  function devKey() {
    const g = W.GFX || {}; return (g.isMobile ? 'm' : 'd') + '|' + (g.gpuClass || '?') + '|' + Math.round((W.devicePixelRatio || 1) * 10) + '|' + Math.round((W.innerWidth || 0) / 200);
  }
  function classBase() {   // starting pressure by device class (before any history)
    const g = W.GFX || {}; if (!g.isMobile) return 0;
    const lowGpu = g.gpuClass === 'low' || (g.score != null && g.score < 55), tiny = g.deviceMem > 0 && g.deviceMem <= 3;
    return lowGpu || tiny ? 4 : 2;
  }
  function loadHist() { try { const j = JSON.parse(W.localStorage.getItem(KEY) || 'null'); if (j && j.key === devKey() && Date.now() - j.t < 21 * 864e5) return j; } catch (e) { } return null; }
  function seedP() {
    const base = classBase(), h = loadHist(); let p = base, why = 'class ' + base;
    if (h) {
      p = Math.max(base, h.p | 0); why = 'last p=' + (h.p | 0);
      const pa = W._dmPrevAlive;   // (ui/dm-perflog.js) did the previous session end without a pagehide, and where?
      if (pa && pa.clean === false && !pa.hidden) { const surf = /surf|atmo/.test(pa.screen || ''); p += surf ? 2 : 1; why += surf ? ' +2 died on world' : ' +1 died'; }
    }
    return { p: Math.min(MAX, p), why: why };
  }

  const S = { C: null, started: false, saveT: 0, savedP: -1, screen: '', perScreen: {}, seed: null };
  const out = { on: !offFlag, ver: 0, p: 0, lv: levelsAt(0), core: core, seedWhy: '' };
  W.DMBudget = out;

  function paused() {
    try {
      if (W._dmWarming || W.__JOTS_INTRO || (W.document && W.document.hidden)) return true;
      if (W.DMAR && W.DMAR.active) return true;
    } catch (e) { }
    return false;
  }
  function curScreen() { try { return (typeof W.STATE !== 'undefined' && W.STATE.screen) || ''; } catch (e) { return ''; } }
  function persist(force) {
    const c = S.C; if (!c) return;
    const t = now(); if (!force && t - S.saveT < 5000) return;
    // what the NEXT launch starts from: the pressure held for >= 15 s (a spike the controller is about to undo is not the device's level)
    const hp = (t - c.settledSince >= 15000) ? c.p : (S.savedP >= 0 ? S.savedP : c.p);
    if (hp === S.savedP) return;
    S.saveT = t; S.savedP = hp;
    try { W.localStorage.setItem(KEY, JSON.stringify({ key: devKey(), p: hp, t: Date.now(), max: c.p })); } catch (e) { }
  }
  function applied(c) {
    out.lv = c.lv; out.ver = c.ver; out.p = c.p;
    try { W.dispatchEvent(new W.CustomEvent('dm:budget', { detail: { p: c.p, lv: c.lv } })); } catch (e) { }
    try { if (W.DMCrumb && W.DMCrumb.mark) W.DMCrumb.mark('budget', 'p' + c.p); } catch (e) { }
  }

  function start() {
    if (S.started || !out.on) return; S.started = true;
    const c = S.C = createController({ budgetMs: budgetOv || 50, onChange: applied });
    S.seed = seedP(); let p0 = S.seed.p;
    if (forceP != null) { p0 = +forceP; S.seed.why = 'forced'; }
    c.seed(p0, now()); out.lv = c.lv; out.ver = c.ver + 1; out.p = c.p; out.seedWhy = S.seed.why;
    let last = 0, tickN = 0;
    const fr = (t) => {
      W.requestAnimationFrame(fr);
      if (paused()) { last = 0; c.reset(); return; }
      if (last) {
        const d = t - last;
        if (forceP == null) c.sample(d, t);
        const sc = S.screen;   // per-screen frame stats for the perf log (EMA only, no allocation)
        if (sc && d > 0 && d < 1500) { let r = S.perScreen[sc]; if (!r) r = S.perScreen[sc] = { n: 0, ema: 0, max: 0, over: 0, h: [0, 0, 0, 0, 0, 0, 0, 0] }; const f = d > 250 ? 250 : d; r.n++; r.ema += (f - r.ema) * 0.02; if (f > r.max) r.max = f; if (f > 66.7) r.over++; r.h[f <= 17.5 ? 0 : f <= 25 ? 1 : f <= 33.4 ? 2 : f <= 50 ? 3 : f <= 66.7 ? 4 : f <= 100 ? 5 : f <= 200 ? 6 : 7]++; }   // bins: <=17.5 <=25 <=33 <=50 <=67 <=100 <=200 >200 ms (p95 per screen = read off the cumulative counts)
      }
      last = t;
      if ((++tickN & 31) === 0) { S.screen = curScreen(); persist(false); }
    };
    W.requestAnimationFrame(fr);
    W.addEventListener('pagehide', () => { persist(true); });
    if (/[?&]govhud=1\b/.test(Q)) hud();
  }
  function hud() {
    const d = W.document.createElement('div'); d.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;font:10px/1.25 monospace;color:#9fe;background:rgba(0,0,0,.55);padding:3px 6px;pointer-events:none;white-space:pre';
    W.document.body.appendChild(d);
    setInterval(() => { const s = out.stats(); if (!s) return; const l = s.lv; d.textContent = 'BUD p' + s.p + '/' + s.max + '  ' + s.emaMs + 'ms p95 ' + s.p95Ms + '\npx' + l.parallax + ' pxs' + l.pxshadow + ' gnd' + l.ground + ' wat' + l.water + ' shd' + l.shadow + ' atm' + l.atmo + ' res' + l.res + (s.exhausted ? ' EXHAUSTED' : ''); }, 500);
  }

  out.stats = function () { const c = S.C; if (!c) return null; const s = c.stats(); s.seed = out.seedWhy; s.dev = devKey(); s.screens = S.perScreen; return s; };
  out.force = function (p) { if (S.C) S.C.set(p, now(), 'force'); };
  out.lvl = function (n) { return out.lv[n] | 0; };
  // typed accessors for the feature hooks; each returns the neutral value while the controller is off or at level 0
  out.parallax = function () { const l = out.lvl('parallax'); return { lvl: l, steps: [1, 0.6, 0.4, 0][l], stepsMax: l === 2 ? 4 : 99, reach: [1, 0.8, 0.6, 0.6][l], depth: [1, 0.9, 0.75, 0.75][l], off: l >= 3, shadow: out.lvl('pxshadow') ? 0 : 1 }; };
  out.groundReach = function () { return [1, 0.8, 0.6][out.lvl('ground')] || 1; };
  out.groundDual = function () { return out.lvl('ground') >= 2 ? 0 : 1; };
  out.waterCap = function () { return [1, 0.85, 0.6, 0.3][out.lvl('water')] || 1; };   // multiplies the water governor's own cap
  out.sprayK = function () { const k = [1, 0.7, 0.4, 0][out.lvl('water')]; return k == null ? 1 : k; };
  out.mistK = function () { const k = [1, 0.6, 0, 0][out.lvl('water')]; return k == null ? 1 : k; };
  out.shadowEvery = function () { const l = out.lvl('shadow'); return l >= 2 ? 3 : l >= 1 ? 2 : 1; };
  out.shadowHalf = function () { return out.lvl('shadow') >= 3; };
  out.atmoPeriod = function () { const l = out.lvl('atmo'); return l >= 2 ? 0.4 : l >= 1 ? 0.15 : 0.066; };   // seconds between density-volume computes
  out.atmoBakeGap = function () { const l = out.lvl('atmo'); return l >= 2 ? 1800 : l >= 1 ? 900 : 500; };       // ms between near-ground height re-bakes
  out.resCap = function () { return [1, 0.85, 0.72, 0.6][out.lvl('res')] || 1; };

  out.start = start;
  // start once the page globals it reads (GFX from detectCapabilities) exist; the first frame is a while away
  setTimeout(start, 1500);
})(typeof window !== 'undefined' ? window : globalThis);
