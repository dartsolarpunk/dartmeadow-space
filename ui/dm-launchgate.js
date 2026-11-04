/* dm-launchgate.js — logic for the menu -> game launch transition (no rendering, no three.js).
   Pure + dependency-free so tools/tests/launchgate.test.js can run it under node.

   The rules it encodes (index.html wires them to the real scene):
     1. The fly-out starts on the press itself: introNext() returns 'play' the moment the board + clips are ready, which is
        normally at the press (they are prepared in the menu's idle time). It never waits for the world, the warm-up or the loader.
     2. Everything that is not ready at the press is held behind a gate (createGate) that opens when the fly-out ends (or is
        skipped / fails), so no world build, compile or upload can land inside the animation.
     3. Work done in the menu's idle time runs through a slicer: tiny jobs, a per-frame budget (default 3 ms), and only on frames
        where the menu itself is running smoothly (drive()).
     4. After the fly-out: 'wait' (loader over the last menu frame) until the world is stable, then 'dissolve' (cross-fade). */
(function (root) {
  'use strict';

  /* ── phase decision ─────────────────────────────────────────────────────────────
     s: { phase:'hold'|'play'|'wait'|'', ready, heldMs, holdMax, flown, worldReady, stalled, over, skip }
     returns 'play' | 'wait' | 'dissolve' | null.
     'hold' exists only for the rare press where the board or her clips are not ready yet (first run, killed-tab recovery);
     it is bounded by holdMax and nothing but those two assets is waited for. */
  function introNext(s) {
    switch (s.phase) {
      case 'hold': return (s.ready || s.skip || s.heldMs >= s.holdMax) ? (s.skip ? 'wait' : 'play') : null;
      case 'play': return (s.flown || s.skip) ? (s.worldReady ? 'dissolve' : 'wait') : null;
      case 'wait': return (s.worldReady || s.stalled || s.over) ? 'dissolve' : null;
      default: return null;
    }
  }

  /* ── gate: callbacks held until open(); run immediately when already open ───────── */
  function createGate(opts) {
    const g = { isOpen: false, q: [], defer: (opts && opts.defer) || function (f) { setTimeout(f, 0); } };
    g.run = function (fn) { if (g.isOpen) { g.defer(fn); return false; } g.q.push(fn); return true; };   // true = held
    g.open = function () { if (g.isOpen) return 0; g.isOpen = true; const q = g.q; g.q = []; q.forEach(fn => g.defer(fn)); return q.length; };
    g.close = function () { g.isOpen = false; };
    return g;
  }

  /* ── slicer: a queue of small jobs run with a per-tick time budget ─────────────────
     job(): true = finished, false = not yet (try again next tick; ends this tick so it yields). A job is the unit that cannot be
     preempted, so jobs must be chunk-sized. At least one job runs per tick; more only while the budget lasts. */
  function createSlicer(opts) {
    const budget = (opts && opts.budgetMs) || 3, now = (opts && opts.now) || (() => performance.now());
    const q = []; const st = { ticks: 0, jobs: 0, maxTickMs: 0, overBudget: 0 };
    const s = {
      stats: st, get size() { return q.length; },
      add(name, fn) { q.push({ name, fn }); return s; },
      clear() { q.length = 0; },
      tick() {
        if (!q.length) return 0;
        const t0 = now(); let ran = 0; st.ticks++;
        while (q.length) {
          const j = q[0]; let done = true;
          try { done = j.fn() !== false; } catch (e) { done = true; if (s.onError) s.onError(j.name, e); }
          ran++; st.jobs++;
          if (done) q.shift(); else { q.push(q.shift()); break; }
          if (now() - t0 >= budget) break;
        }
        const dt = now() - t0; if (dt > st.maxTickMs) st.maxTickMs = dt; if (dt > budget * 1.5) st.overBudget++;
        return ran;
      }
    };
    return s;
  }

  /* drive(slicer): tick it from requestAnimationFrame, only on frames that follow a smooth frame (gap <= calmMs) and while the page is
     visible; stops itself when the queue is empty. Returns stop(). */
  function drive(slicer, opts) {
    const raf = (opts && opts.raf) || root.requestAnimationFrame, caf = (opts && opts.caf) || root.cancelAnimationFrame;
    const calm = (opts && opts.calmMs) || 24, hidden = (opts && opts.hidden) || (() => root.document && root.document.hidden);
    const canRun = (opts && opts.canRun) || (() => true);
    let last = 0, id = 0, on = true;
    const step = t => {
      if (!on) return;
      if (!slicer.size) { on = false; return; }
      const gap = last ? t - last : 1e9; last = t;
      if (gap <= calm && !hidden() && canRun()) slicer.tick();
      id = raf(step);
    };
    id = raf(step);
    return () => { on = false; try { caf && caf(id); } catch (e) {} };
  }

  const api = { introNext, createGate, createSlicer, drive };
  root.DMLaunch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
