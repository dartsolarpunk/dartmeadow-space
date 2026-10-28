/* DART Meadow — frame-rate governor (perf lane).
 *
 * Replaces the old _dynRes step-ladder.  The old one (a) only ran on Auto, (b) moved the resolution in 0.14 jumps
 * (a visible pop + a canvas re-allocation each time), (c) could never recover on a 60 Hz screen — a vsync-capped
 * frame time looks identical whether the GPU is idle or flat out, so "headroom" was never detected, and (d) forgot
 * everything at the next launch (a tablet spent its first 30 s at 6 fps working its way down again).
 *
 * This governor:
 *  - reads a ring of frame times (no allocation) and judges the 70th-percentile frame, so one shader-compile hitch
 *    never moves the resolution;
 *  - eases the render scale in SMALL steps (<= 0.06, rounded to 0.02) at a rate limit, bigger only when the frame
 *    is several times over budget; the chosen preset's own pixel ratio is always the ceiling;
 *  - finds headroom by PROBING: after a calm spell it tries one small step up; if frames degrade it steps back and
 *    remembers that ceiling (it relaxes again after a few minutes), so a vsync-locked device still recovers;
 *  - notices a display/OS frame cap (a step down that bought nothing) and leaves the scale alone;
 *  - remembers the settled scale per device+preset (localStorage) so the next launch starts there;
 *  - never touches any UI (DMUI3D, the HUD): it only calls renderer.setPixelRatio, and it pauses itself during
 *    warm-up, hidden tabs and the hitch frames around world changes.
 *
 * Public: DMGov.frame(renderer, gfx, basePixelRatio)  (once per rendered frame)   DMGov.prime(...) (warm-up)   DMGov.stats()
 */
(function (root) {
  'use strict';
  const N = 96;                                   // ring length (frames)
  const KEY = 'dm_gov_v1';
  const sorted = new Float32Array(N);

  function snap(x) { return Math.round(x * 50) / 50; }
  function pct(d, n, q) {                           // q-th percentile of the last n ring entries, no allocation
    for (let i = 0; i < n; i++) sorted[i] = d.ring[(d.head - n + i + N * 2) % N];
    const s = sorted.subarray(0, n); s.sort();
    return s[Math.min(n - 1, Math.floor(n * q))];
  }
  function devKey(gfx) {
    return (gfx.preset || '?') + '|' + (gfx.isMobile ? 'm' : 'd') + '|' + Math.round((root.devicePixelRatio || 1) * 10) + '|' + Math.round((root.innerWidth || 0) / 100);
  }
  function loadSaved(gfx) {
    try { const j = JSON.parse(root.localStorage.getItem(KEY) || 'null'); if (j && j.key === devKey(gfx) && Date.now() - j.t < 14 * 864e5 && j.k > 0.3 && j.k <= 1) return j.k; } catch (e) {}
    return 1;
  }
  function save(gfx, k) { try { root.localStorage.setItem(KEY, JSON.stringify({ key: devKey(gfx), k: k, t: Date.now() })); } catch (e) {} }

  function make(gfx) {
    return {
      t: 0, ring: new Float32Array(N), head: 0, count: 0, skip: 0,
      k: 1, floor: 0.6, ceil: 1, ref: 16.7,        // render scale now / lowest allowed / highest allowed after a failed probe / display period
      since: 0, calm: 0, nextEval: 0, probe: null, hold: 8000, tCeil: 0, saveT: 0, saved: 1,
      noGain: 0, lock30: 0, walkFrom: 1, back: 0, noPrefUntil: 0, freezeMs: 40000, prevMed: 0, lastDown: null, frozenUntil: 0, changes: 0, loaded: false
    };
  }

  function init(r, gfx, basePR, now) {
    const d = r._dr = make(gfx); d.t = now; d.since = now; d.nextEval = now + 2500;
    const sk = loadSaved(gfx); d.saved = sk; d.loaded = true;
    if (sk < 1) { d.k = sk; d.hold = 5000; try { r.setPixelRatio(basePR * sk); } catch (e) {} }
    return d;
  }
  // Warm-up step: apply the remembered scale now, so the drawing-buffer reallocation (and the first render at that size) happens
  // behind the start-up status line instead of on the first visible frame.
  function prime(r, gfx, basePR) {
    if (!r || !gfx || gfx.dynamicRes === false) return false;
    if (!r._dr || !r._dr.ring) init(r, gfx, basePR, performance.now());
    return r._dr.k;
  }

  function frame(r, gfx, basePR) {
    if (!r || !gfx || gfx.dynamicRes === false) return;
    const now = performance.now();
    let d = r._dr;
    // AR owns the pixel ratio and the rAF while it is active (ui/dm-ar-core.js wraps effectivePixelRatio and pumps XR frames): hands off
    if (root.DMAR && root.DMAR.active) { if (d && d.ring) { d.t = now; d.skip = 6; } return; }
    if (!d || !d.ring) { init(r, gfx, basePR, now); return; }   // fresh (or reset by applyGraphicsLive): restore last settled scale
    const raw = now - d.t; d.t = now;
    if (raw <= 0) return;
    // pause: warm-up, hidden, world-change hitches (a >400 ms frame is a compile/upload, not load) and the frames after
    if (root._dmWarming || root.document && root.document.hidden || raw > 400) { d.skip = 6; d.since = Math.max(d.since, now - 1000); return; }
    if (d.skip > 0) { d.skip--; return; }
    d.ring[d.head] = Math.min(raw, 250); d.head = (d.head + 1) % N; if (d.count < N) d.count++;
    if (now < d.nextEval || d.count < 24) return;
    d.nextEval = now + 500;

    const mobile = !!gfx.isMobile;
    const star = !!(root.DMStarBubble && (root.DMStarBubble.a > 0.05 || root.DMStarBubble.inStar));
    const auto = gfx.preset === 'auto';
    // lowest scale: a chosen preset keeps most of its sharpness; Auto may go lower; diving into a star lowers it further
    const absMin = mobile ? 0.82 : 0.8;              // never below ~0.8 device pixels per CSS pixel unless the player's own scale is already that low
    let floor = auto ? (star ? 0.42 : 0.5) : (star ? 0.58 : (mobile ? 0.6 : 0.72));
    if (basePR < absMin) floor = Math.max(floor, 0.85);                     // already low-res by the player's choice: leave a small margin only
    else floor = Math.max(floor, Math.min(1, absMin / basePR));
    d.floor = floor;
    // budget: the slowest frame cadence we accept, snapped to a whole number of display refreshes (a frame time only ever lands on
    // 1x, 2x, 3x… of the refresh, so a target between two of them is unreachable and would only make the scale chase it).
    // Phones/tablets ~38-45 fps (30 on Auto), desktops ~55 fps.
    const wantMs = mobile ? (auto ? 33.4 : 26.0) : 17.5;
    const mult = Math.max(1, Math.floor(wantMs / d.ref + (mobile ? 0.5 : 0.35)));
    const target = d.ref * mult;
    const n = Math.min(d.count, 72);
    const p70 = pct(d, n, 0.70), p90 = pct(d, n, 0.90), med = pct(d, n, 0.5), p10 = pct(d, n, 0.10);
    // display period: the fastest steady cadence seen (a 120 Hz iPad Pro gets 8.3, a 30 Hz low-power phone stays above 16.7)
    if (p10 < d.ref - 0.3 && p10 > 6.5) d.ref += (p10 - d.ref) * 0.25;
    else if (p10 > d.ref * 1.5 && d.count >= N) d.ref += (Math.min(16.7, p10) - d.ref) * 0.01;
    // Preferred cadence: ~60 fps.  Frames only land on whole refreshes, so a scene a little over 16.7 ms shows as 33 ms and the
    // size of the cut that would fix it cannot be read from the frame time: instead walk down in small steps (down to ~0.78x on a
    // chosen preset, 0.6x on Auto) while it keeps paying off; the no-gain check below stops the walk and backs out if it does not.
    let goal = target;
    const pref = d.ref * Math.max(1, Math.round(16.7 / d.ref));
    if (now >= d.lock30 && pref < target - 0.5 && p70 > pref * 1.12 && p70 <= pref * 2.3 && d.k > Math.max(floor, auto ? 0.6 : 0.78) + 0.005 && now >= d.noPrefUntil) goal = pref;
    const over = p70 / goal;                         // > 1.12: over budget
    const calm = p90 <= goal * 1.1;                  // nearly every frame inside the budget
    const since = now - d.since;
    const frozen = now < d.frozenUntil;               // after a no-gain walk: no more cuts for a while (probing back up is still allowed)

    // learn: did the last step down buy anything?  (a display/OS frame cap, or a CPU-bound scene, looks the same at every scale)
    if (d.lastDown && since > 2200) {
      const gain = (d.lastDown.med - med) / d.lastDown.med;
      if (gain < 0.04 && med > goal * 1.05) d.noGain++; else d.noGain = 0;
      d.lastDown = null;
      // full scale already on a 30 fps cadence (walk started at >= 0.98; fastest frames >= 30 ms, median <= 36 ms) and the cut bought nothing: a 30 Hz display / power-saver cap.
      // No further cuts or probes can show; put the scale back where it was and leave it until the cadence changes (10 min).
      if (d.noGain >= 1 && p10 >= 30 && med <= 36 && (d.walkFrom || 1) >= 0.98) { d.lock30 = now + 600000; d.noGain = 0; d.probe = null; d.calm = 0; setK(r, d, gfx, basePR, Math.max(d.k, d.walkFrom || 1), now); return; }
      if (d.noGain >= 3) {                           // three steps, nothing gained: not fill-bound. Walk back up and leave it alone for a while
        d.ceil = Math.min(1, Math.max(d.k + 0.12, d.walkFrom || 1)); d.tCeil = now; d.frozenUntil = now + d.freezeMs; d.noPrefUntil = now + d.freezeMs * 2; d.freezeMs = Math.min(600000, d.freezeMs * 2); d.noGain = 0; d.hold = 5000; d.back = 0.04; return;
      }
    }
    // a probe that failed (frames got clearly worse than before the step up): back out and remember where
    if (d.probe) {
      if (since < 3500) {
        if (p70 > d.probe.med * 1.25 || over > 1.25 * Math.max(1, d.probe.med / goal)) { const kk = d.probe.from; d.ceil = kk; d.hold = Math.min(90000, d.hold * 2); d.tCeil = now; d.probe = null; setK(r, d, gfx, basePR, kk, now); }
        return;
      }
      d.probe = null; d.hold = Math.max(8000, d.hold * 0.8);                // it held
    }

    if (over > 1.12 && d.k > floor + 0.005 && !frozen && !(now < d.lock30 && p70 <= 38)) {   // (a locked 30 fps cadence is left alone; a genuinely slower one still gets cut)
      if (since < (over > 2 ? 1400 : 2600)) return;                         // rate limit
      // size the step from how far over we are (fill cost ~ k^2), but never a pop: 0.03 .. 0.07, 0.10 when several times over
      const need = d.k - d.k * Math.sqrt(1 / over) * 0.97;
      let step = Math.min(over > 2.2 ? 0.10 : 0.07, Math.max(0.03, need));
      if (star) step *= 1.5;
      if (!d.lastDown && !d.noGain) d.walkFrom = d.k;
      d.lastDown = { med: med };
      setK(r, d, gfx, basePR, Math.max(floor, d.k - step), now); d.calm = 0; return;
    }
    if (d.k < floor) { setK(r, d, gfx, basePR, floor, now); return; }
    if (d.k < 1 && calm) {
      d.calm += 500;
      if (now - d.tCeil > 180000 && d.ceil < 1) { d.ceil = Math.min(1, d.ceil + 0.04); d.tCeil = now; }
      if (d.calm >= d.hold && since >= d.hold && d.k < d.ceil - 0.001) {   // probe one small step up
        const from = d.k; d.probe = { from: from, med: p70 }; d.calm = 0;
        setK(r, d, gfx, basePR, Math.min(d.ceil, from + (d.back || (star ? 0.06 : 0.04))), now);
      }
    } else if (!calm) d.calm = Math.max(0, d.calm - 250);
    // persist a settled scale (stable for a while, not mid-probe)
    if (!d.probe && since > 20000 && now - d.saveT > 30000 && Math.abs(d.k - d.saved) >= 0.02) { d.saved = d.k; d.saveT = now; save(gfx, d.k); }
    else if (!d.probe && d.k >= 1 && d.saved < 1 && since > 20000) { d.saved = 1; d.saveT = now; save(gfx, 1); }
  }

  function setK(r, d, gfx, basePR, k, now) {
    k = snap(Math.min(1, Math.max(0.3, k)));
    if (k === d.k) return;
    d.k = k; d.since = now; d.changes++; root._dmResChanges = (root._dmResChanges || 0) + 1;
    d.count = Math.min(d.count, 8); d.nextEval = now + 800;                 // judge the new scale on fresh frames only
    try { r.setPixelRatio(basePR * k); } catch (e) {}
  }

  function stats() {
    const r = root.flightRenderer, d = r && r._dr;
    return d && d.ring ? { k: d.k, floor: d.floor, ceil: d.ceil, ref: +d.ref.toFixed(1), changes: d.changes, hold: d.hold, probing: !!d.probe, noGain: d.noGain, saved: d.saved } : null;
  }
  root.DMGov = { frame: frame, prime: prime, stats: stats, KEY: KEY };
})(window);
