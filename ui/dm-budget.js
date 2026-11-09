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
 *   (v264 DMLight, ui/dm-light.js, stage 'light': L1 rays/steps halved + compute path closed (after ground 2) · L2 4 rays, far cascade idle, half the probe budget (after water 3) · L3 cache frozen, short shader march (after shadow 2))
 *   12 atmo L1      cloud/density volume re-evaluated at ~7 Hz     13 shadow L3   shadow map side halved (the one allocation, late)
 *   14 atmo L2      volume at 2.5 Hz, near-ground height re-bake slower   15 res L1  render scale <= 0.85   16 res L2  <= 0.72   17 res L3  <= 0.6
 *
 * CONTROL LAW (pure, deterministic, unit-tested by tools/tests/budget-sim.js with fake clocks):
 *  - input: real frame time of every rendered frame (own rAF probe; one subtraction).  EMA (tau 1 s) + p95 of the last ~90 frames; a frame is
 *    clipped to 250 ms and a gap > 1.5 s is a tab-sleep / shader-compile hitch and is not a sample.  Warm-up, intro, hidden tab, AR: no decisions.
 *  - ESCALATE (shed one step; two when the frame is > 2.2x over budget) when the EMA is over the budget (v297: 36 ms = below ~27.8 fps; see TARGET) or the p95 is
 *    spiky (> 2.2x budget) while the EMA is within 25% of it, and has stayed so for a dwell of 0.6 s (> 2x over) / 1.0 s (> 1.4x) / 1.6 s.
 *    After every change the window is cleared: the next decision judges only frames drawn at the new setting.
 *  - RECOVER one step after 4 s of calm (EMA < 0.72 x budget and p95 < 1.5 x budget), never while that step is LOCKED.  A step that is undone
 *    (escalated again within 12 s of the recovery) is locked for 20 s, doubling to 5 min: no oscillation, and a device that cannot afford a
 *    step settles below it.  A recovery that held 40 s halves its lock again.
 *  - SEED: the first seconds are not a slideshow: start at max(device-class base, the settled pressure of the last session on this device);
 *    the last session died (no pagehide) -> +1, died on a surface/atmosphere screen -> +2.  Persisted in localStorage (dm_budget_v1).
 *  - TARGET (v297, Justin's rule): a steady 30 fps on every preset and device.  The budget is 36 ms, not 33.3: a device locked to every 2nd vsync reports
 *    33.3 ms +- jitter and must HOLD there, not shed its whole ladder chasing a coin flip; a sustained average under ~27.8 fps sheds (35 ms still
 *    shed a 30-locked device with 3 % missed vsyncs in the sim).  The calm line (0.72 x) is ~26 ms, so a 30-fps-locked device holds its level and a device with real headroom recovers.  LEGACY class only (deviceMemory <= 3 GB) keeps the
 *    15 fps floor: 68 ms (sheds under ~14.7 fps).  Light / shadow / atmo stages therefore shed at 30 fps on surface, atmosphere and the mansion (budgetFor()).
 *    If everything is shed and the frame is still slow it is CPU-bound beyond this controller's reach: stats().exhausted says so.
 *
 * Flags: ?gov=off  controller off (every level 0; the older per-feature governors run exactly as before) · ?gov=N  force pressure N (testing) ·
 *        ?govhud=1  corner readout · ?govbudget=ms  override the 36 ms (legacy 68 ms) budget.
 * Public: DMBudget.lvl(stage) (0..), .stats(), .force(p), .on, .ver (bumps on every change), typed accessors (.parallax() .shadowEvery() .atmoPeriod() .resCap() ...),
 *   allocation-free per-frame reads .emaMs() .budgetMs() (stats() builds an object: not for a per-frame path)
 *   (pure core: DMBudget.core = { createController, LADDER, STAGES, levelsAt, MAX, budgetFor, TARGET_MS, LEGACY_MS } — also module.exports for node.)
 */
(function (root) {
  'use strict';

  /* ───────────────────────── pure core ───────────────────────── */
  const LADDER = [
    ['parallax', 1], ['parallax', 2], ['hudfx', 1], ['pxshadow', 1], ['ground', 1], ['props', 1], ['ground', 2], ['light', 1],
    ['water', 1], ['water', 2], ['water', 3], ['light', 2], ['parallax', 3],
    ['shadow', 1], ['skin', 1], ['shadow', 2], ['light', 3], ['hair', 1], ['atmo', 1], ['props', 2], ['shadow', 3], ['atmo', 2], ['shadow', 4],
    ['res', 1], ['res', 2], ['res', 3], ['res', 4], ['res', 5],
  ];
  const MAX = LADDER.length;
  const STAGES = ['parallax', 'pxshadow', 'hudfx', 'ground', 'light', 'props', 'water', 'shadow', 'skin', 'hair', 'atmo', 'res'];
  // pressure at which a stage first reaches a level (the memory floors below are expressed in stages, not magic numbers)
  function pOf(stage, level) { for (let i = 0; i < LADDER.length; i++) if (LADDER[i][0] === stage && LADDER[i][1] === level) return i + 1; return LADDER.length; }
  function levelsAt(p, out) {
    out = out || {};
    for (let i = 0; i < STAGES.length; i++) out[STAGES[i]] = 0;
    for (let i = 0; i < p && i < MAX; i++) out[LADDER[i][0]] = LADDER[i][1];
    return out;
  }

  // (v297) frame budget for the 30 fps rule; legacy class (<= 3 GB device memory) keeps the 15 fps floor.  g: GFX ({deviceMem}).
  const TARGET_MS = 36, LEGACY_MS = 68;
  function isLegacy(g) { return !!(g && g.deviceMem > 0 && g.deviceMem <= 3); }
  function budgetFor(g) { return isLegacy(g) ? LEGACY_MS : TARGET_MS; }

  function createController(o) {
    o = o || {};
    const N = 96, sorted = new Float32Array(N);
    const C = {
      budget: o.budgetMs || TARGET_MS, p: 0, base: 0, max: MAX,
      ring: new Float32Array(N), head: 0, count: 0, ema: 0, prevMs: 0, min2: 0, lastHitch: 0, emaOK: false, t: 0,
      nextEval: 0, over: 0, calm: 0, lastChange: -1e9, lastRecover: -1e9, lastEval: 0, settleUntil: 0,
      lock: new Float64Array(MAX + 2), hold: new Float64Array(MAX + 2),
      changes: 0, esc: 0, rec: 0, fails: 0, history: [], lv: levelsAt(0), ver: 0, exhausted: false, p95: 0, settledP: 0, settledSince: 0, recTo: -1, floorP: 0, onChange: o.onChange || null,
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
      if (ms > 1500) {   // a lone 1.5 s+ gap is a tab sleep / shader compile / GC: not a measurement.  Two in a row is a device at < 0.7 fps: that IS the measurement.
        if (ms > 8000 || !C.lastHitch || now - C.lastHitch > ms * 1.6) { C.lastHitch = now; C.reset(); C.prevMs = 0; return false; }
        C.lastHitch = now;
      }
      // (v259) a frame of 1.5-4 s used to RESET the window, so a device at 0.5-1 fps never produced a decision at all.  Slow frames are evidence now: the ring holds up to
      // 1 s, and a lone hitch cannot move the ladder far because the big jumps below look at the SMALLER of the last two frames (min2).
      const f = ms > 1000 ? 1000 : ms;
      C.min2 = C.prevMs > 0 && C.prevMs < f ? C.prevMs : f; C.prevMs = f;
      C.ring[C.head] = f; C.head = (C.head + 1) % N; if (C.count < N) C.count++;
      if (!C.emaOK) { C.ema = f; C.emaOK = true; } else C.ema += (f - C.ema) * (1 - Math.exp(-(f > 250 ? 250 : f) / 1000));   // (the EMA keeps its 250 ms clip: one hitch must not look like a slideshow)
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
      if (C.p < C.floorP) { C.set(C.floorP, now, 'mem'); return true; }   // memory pressure: a floor under the ladder (shadow map, render scale are what give memory back)
      const slowNow = C.min2 > C.budget * 3;   // two slow frames in a row: no need to wait for 8 of them (at 1 fps that was 8 s per ladder step)
      if (now < C.settleUntil && !slowNow) return false;
      if (C.count < (slowNow ? 2 : C.ema > 2.5 * C.budget ? 3 : 8)) return false;
      const B = C.budget, p95 = pct95(); C.p95 = p95;
      const e = slowNow ? Math.max(C.ema, Math.min(C.min2, 1000) * 0.5) : C.ema;   // a sustained slideshow: the EMA lags (tau 1 s, 250 ms clip) - use the faster of the two
      const sev = e / B, sev2 = C.min2 / B;      // sev2: the smaller of the last two frames (a lone hitch cannot raise it)
      const bad = e > B || (p95 > B * 2.2 && e > B * 0.75);
      const calm = e < B * 0.72 && p95 < B * 1.5;
      if (bad) { C.over += dtE; C.calm = 0; } else { C.over = Math.max(0, C.over - dtE * 0.5); C.calm = calm ? C.calm + dtE : Math.max(0, C.calm - dtE * 0.5); }
      if (C.recTo >= 0 && C.p === C.recTo && now - C.lastRecover > 40000) { const k = C.recTo + 1; C.hold[k] = Math.max(20000, C.hold[k] / 2); C.recTo = -1; }   // a recovery that held 40 s relaxes its back-off
      if (C.settledP !== C.p) { C.settledP = C.p; C.settledSince = now; }
      if (bad) {
        const dwell = sev2 > 4 ? 0 : sev > 2 ? 600 : sev > 1.4 ? 1000 : 1600;
        if (C.over >= dwell && now - C.lastChange >= (sev2 > 4 ? 300 : 900)) {
          if (C.p >= MAX) { C.exhausted = true; return true; }
          // how far to jump: a slideshow (frames > 4x the budget) sheds in big strides - the render scale at the end of the ladder is what usually buys most - then settles
          let step = sev2 > 16 ? 9 : sev2 > 8 ? 6 : sev2 > 4 ? 4 : sev > 2.2 ? 2 : 1; if (C.p + step > MAX) step = MAX - C.p; if (step < 1) step = 1;
          if (C.lastRecover > 0 && now - C.lastRecover < 12000) {   // an undone recovery: the level we just left is locked (exponential back-off)
            const lv = Math.min(MAX, C.p + 1); C.fails++; C.hold[lv] = Math.min(300000, C.hold[lv] * 2); C.lock[lv] = now + C.hold[lv];   // lock[k]: do not leave pressure k downwards
          }
          C.esc++; C.exhausted = false; C.set(C.p + step, now, 'esc ' + Math.round(e) + 'ms');
          return true;
        }
        return false;
      }
      if (calm && C.p > C.floorP && C.calm >= 4000 && now - C.lastChange >= 4000) {
        const target = C.p - 1;
        if (now < C.lock[C.p]) return false;
        C.rec++; C.exhausted = false; C.lastRecover = now; C.recTo = target; C.set(target, now, 'rec ' + Math.round(e) + 'ms');
        return true;
      }
      if (C.p < MAX) C.exhausted = false;
      return false;
    };
    C.stats = function () {
      return { min2: +C.min2.toFixed(0), p: C.p, max: MAX, base: C.base, lv: C.lv, emaMs: +C.ema.toFixed(1), p95Ms: +C.p95.toFixed(1), budgetMs: C.budget, changes: C.changes, esc: C.esc, rec: C.rec, locks: C.fails, exhausted: C.exhausted, hist: C.history.slice(-12) };
    };
    return C;
  }

  const core = { createController: createController, LADDER: LADDER, STAGES: STAGES, levelsAt: levelsAt, MAX: MAX, pOf: pOf, budgetFor: budgetFor, isLegacy: isLegacy, TARGET_MS: TARGET_MS, LEGACY_MS: LEGACY_MS };
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
  function hudClass(on) { try { const d = W.document && W.document.documentElement; if (d) d.classList.toggle('dm-hudlite', !!on); } catch (e) { } }   // ui/dm-hud.css: no filter / shadow / animation / transition on the HUD
  function applied(c) {
    out.lv = c.lv; out.ver = c.ver; out.p = c.p; hudClass(c.lv.hudfx >= 1);
    try { W.dispatchEvent(new W.CustomEvent('dm:budget', { detail: { p: c.p, lv: c.lv } })); } catch (e) { }
    try { if (W.DMCrumb && W.DMCrumb.mark) W.DMCrumb.mark('budget', 'p' + c.p); } catch (e) { }
  }

  // (v273) RENDER-SCALE ENFORCER.  The v272 log of the Mali tablet: the ladder sat at its last step (p 27, res stage 5 = cap 0.42) for 6 minutes at ~4 fps while the renderer's pixel
  // ratio stayed 1.5 - the one lever that scales fill cost never moved, because it was only ever applied through ui/dm-governor.js, which is off for a player whose saved
  // "auto balance" is unticked (GFX.dynamicRes === false) and silent while its own gates hold.  The controller now guarantees its own cap: every ~0.5 s the drawing buffer is
  // brought down to effectivePixelRatio() x cap (and handed back to the governor / restored when the cap lifts).  Independent of the governor's state.
  function enforceRes() {
    try {
      if (!out.on || W.__JOTS_INTRO || (W.DMAR && W.DMAR.active) || typeof W.effectivePixelRatio !== 'function') return;
      const r = W.flightRenderer || (typeof flightRenderer !== 'undefined' ? flightRenderer : null); if (!r || !r.getPixelRatio || !r.setPixelRatio) return;
      const cap = out.resCap(), cur = r.getPixelRatio(), base = W.effectivePixelRatio(), d = r._dr && r._dr.ring ? r._dr : null;
      const want = base * Math.min(cap, d ? d.k : 1);
      if (cap < 1 && cur > want * 1.03) { r.setPixelRatio(base * cap); if (d) { d.k = Math.min(d.k, cap); d.since = now(); } r._dmEnf = cap; S.enf = (S.enf | 0) + 1; }
      else if (cap >= 1 && r._dmEnf && !d && cur < base * 0.98) { r.setPixelRatio(base); r._dmEnf = 0; S.enf = (S.enf | 0) + 1; }   // no governor to hand it back: restore it here
      else if (cap >= 1 && r._dmEnf) r._dmEnf = 0;
    } catch (e) { }
  }
  function start() {
    if (S.started || !out.on) return; S.started = true;
    const c = S.C = createController({ budgetMs: budgetOv || budgetFor(W.GFX), onChange: applied });   // (v297) 30 fps target, 15 fps legacy floor
    S.seed = seedP(); let p0 = S.seed.p;
    if (forceP != null) { p0 = +forceP; S.seed.why = 'forced'; }
    c.seed(p0, now()); hudClass(c.lv.hudfx >= 1); out.lv = c.lv; out.ver = c.ver + 1; out.p = c.p; out.seedWhy = S.seed.why;
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
      if ((++tickN & 31) === 0) { S.screen = curScreen(); persist(false); enforceRes(); }
    };
    W.requestAnimationFrame(fr);
    // GPU/memory watch (the OS kills the tab, not the frame rate): the renderer's own byte estimate (info.memory.total: textures + buffers + render targets).
    // Logs: the Galaxy Tab died at 1.75 GB on 4 GB, the iPhone at geo 1037 / tex 269.  Over the soft limit the ladder is held at shadow L3 (half shadow map, slow atmosphere),
    // over the hard limit at res L1 (render scale <= 0.85 -> smaller targets); the floor lifts again 10 % below the limit.
    setInterval(() => {
      try {
        const r = W.flightRenderer || (typeof flightRenderer !== 'undefined' ? flightRenderer : null), tot = r && r.info && r.info.memory && r.info.memory.total; if (!(tot > 0)) return;
        const mb = tot / 1048576, ios = !!(W.GFX && W.GFX.isIOS), mob = !!(W.GFX && W.GFX.isMobile), soft = ios ? 700 : mob ? 800 : 2600, hard = ios ? 900 : mob ? 950 : 3400;   // (logs: the Mali-G615 tab died at 917-990 MB renderer bytes, the iPhone at 900) S.memMB = Math.round(mb);
        const P_HARD = core.pOf('res', 1), P_SOFT = core.pOf('shadow', 3);
        let f = c.floorP; if (mb > hard) f = P_HARD; else if (mb > soft) f = Math.max(f === P_HARD && mb > hard * 0.9 ? P_HARD : 0, P_SOFT); else if (mb < soft * 0.9) f = 0;
        if (f !== c.floorP) { c.floorP = f; if (f > c.p) c.set(f, now(), 'mem ' + Math.round(mb) + 'MB'); }
      } catch (e) { }
    }, 2000);
    W.addEventListener('pagehide', () => { persist(true); });
    if (/[?&]govhud=1\b/.test(Q)) hud();
  }
  function hud() {
    const d = W.document.createElement('div'); d.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;font:10px/1.25 monospace;color:#9fe;background:rgba(0,0,0,.55);padding:3px 6px;pointer-events:none;white-space:pre';
    W.document.body.appendChild(d);
    setInterval(() => { const s = out.stats(); if (!s) return; const l = s.lv; d.textContent = 'BUD p' + s.p + '/' + s.max + '  ' + s.emaMs + '/' + s.budgetMs + 'ms p95 ' + s.p95Ms + '\npx' + l.parallax + ' pxs' + l.pxshadow + ' gnd' + l.ground + ' wat' + l.water + ' shd' + l.shadow + ' atm' + l.atmo + ' res' + l.res + (s.exhausted ? ' EXHAUSTED' : ''); }, 500);
  }

  out.stats = function () { const c = S.C; if (!c) return null; const s = c.stats(); s.seed = out.seedWhy; s.dev = devKey(); s.memMB = S.memMB; s.floorP = c.floorP; s.screens = S.perScreen; s.enf = S.enf | 0; return s; };
  out.force = function (p) { if (S.C) S.C.set(p, now(), 'force'); };
  out.lvl = function (n) { return out.lv[n] | 0; };
  out.emaMs = function () { return S.C ? S.C.ema : 0; };            // (v297) per-frame readers (no object): ui/dm-light.js headroom gate
  out.budgetMs = function () { return S.C ? S.C.budget : TARGET_MS; };
  // typed accessors for the feature hooks; each returns the neutral value while the controller is off or at level 0
  out.parallax = function () { const l = out.lvl('parallax'); return { lvl: l, steps: [1, 0.6, 0.4, 0][l], stepsMax: l === 2 ? 4 : 99, reach: [1, 0.8, 0.6, 0.6][l], depth: [1, 0.9, 0.75, 0.75][l], off: l >= 3, shadow: out.lvl('pxshadow') ? 0 : 1 }; };
  out.groundReach = function () { return [1, 0.8, 0.6][out.lvl('ground')] || 1; };
  out.groundDual = function () { return out.lvl('ground') >= 2 ? 0 : 1; };
  out.waterCap = function () { return [1, 0.85, 0.6, 0.3][out.lvl('water')] || 1; };   // multiplies the water governor's own cap
  out.sprayK = function () { const k = [1, 0.7, 0.4, 0][out.lvl('water')]; return k == null ? 1 : k; };
  out.mistK = function () { const k = [1, 0.6, 0, 0][out.lvl('water')]; return k == null ? 1 : k; };
  out.shadowEvery = function () { const l = out.lvl('shadow'); return l >= 4 ? 30 : l >= 2 ? 3 : l >= 1 ? 2 : 1; };   // L4 (last resort, logs: the sun-shadow pass alone cost ~50 ms on the Mali tab at 0.4 MP): the map refreshes about twice a second
  out.shadowHalf = function () { return out.lvl('shadow') >= 3; };
  out.atmoPeriod = function () { const l = out.lvl('atmo'); return l >= 2 ? 0.4 : l >= 1 ? 0.15 : 0.066; };   // seconds between density-volume computes
  out.atmoBakeGap = function () { const l = out.lvl('atmo'); return l >= 2 ? 1800 : l >= 1 ? 900 : 500; };       // ms between near-ground height re-bakes
  out.lightLvl = function () { return out.lvl('light'); };
  out.resCap = function () { return [1, 0.85, 0.72, 0.6, 0.5, 0.42][out.lvl('res')] || 1; };
  out.hudLite = function () { return out.lvl('hudfx') >= 1; };                       // HUD: no filter / shadow / animation / transition while the canvas animates
  out.propsK = function () { return [1, 0.7, 0.45][out.lvl('props')] || 1; };            // prop draw distance multiplier (planet props, boulders, scatter)
  out.skinEvery = function () { return out.lvl('skin') >= 1 ? 2 : 1; };                 // skinned meshes (NPC / creatures / far characters) animate every 2nd frame
  out.hairEvery = function () { return out.lvl('hair') >= 1 ? 3 : 1; };                  // strand-hair guide solver runs every 3rd frame (accumulated step)

  out.start = start;
  // start once the page globals it reads (GFX from detectCapabilities) exist; the first frame is a while away
  setTimeout(start, 1500);
})(typeof window !== 'undefined' ? window : globalThis);
