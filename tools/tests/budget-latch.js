// node tools/tests/budget-latch.js — the quality ladder cannot latch (v353).  Justin's tablet + iPhone: every session that ended without a pagehide added +1/+2 to the REMEMBERED pressure
// for 21 days and nothing undid it (recovery needed 38 fps), so terrain detail stayed shed.  Pure seed + controller checks.
'use strict';
const assert = require('assert'), B = require('../../ui/dm-budget.js');
const { seedFor, createController, MAX, SEED_ABOVE_BASE, SEED_MAX_AGE_MS } = B, now = 1e12, RES0 = B.RES0;
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
const hist = (p, ageMs, b) => ({ p, t: now - ageMs, b });
// seed: no history -> class base
ok(seedFor({ base: 4, hist: null, now }).p === 4, 'no history = class base');
// a remembered pressure is believed up to base + 8
ok(seedFor({ base: 4, hist: hist(9, 1e3), now }).p === 9, 'history inside the cap');
ok(seedFor({ base: 4, hist: hist(27, 1e3), now }).p === 4 + SEED_ABOVE_BASE, 'history above the cap is clipped to base + ' + SEED_ABOVE_BASE);
// the ratchet: 50 unclean exits in a row (each persists what it started at) can never climb past the cap
{ let p = 4; for (let i = 0; i < 50; i++) p = seedFor({ base: 4, hist: hist(p, 1e3), now, prev: { clean: false, hidden: false, screen: 'flight:multiplayer@Mars/surf' } }).p; ok(p <= 4 + SEED_ABOVE_BASE, 'death penalty ratchet bounded, p=' + p); ok(p < RES0 - 1, 'never starts inside the render-scale steps'); }
// expiry and build change drop the history
ok(seedFor({ base: 4, hist: hist(12, SEED_MAX_AGE_MS + 1e3), now }).p === 4, 'history older than the max age is dropped');
ok(seedFor({ base: 2, hist: hist(12, 1e3, 'v352'), build: 'v353', now }).p === 2, 'a new build re-measures from the class base');
ok(seedFor({ base: 2, hist: hist(12, 1e3, 'v353'), build: 'v353', now }).p === 10, 'same build keeps the hint (capped)');
ok(seedFor({ base: 2, hist: hist(12, -5 * 864e5), now }).p === 2, 'a history from the future (clock jump) is dropped');
// recovery: a 30-fps-locked device (33.3 ms, under the 36 ms budget but over the 26 ms calm line) that was seeded high steps back to its class base
function run(frameMs, seed, base, dur) {
  const c = createController({ budgetMs: 36, okFloor: base }); c.seed(seed, 0); let t = 0;
  while (t < dur) { const ms = typeof frameMs === 'function' ? frameMs(c.p) : frameMs; t += ms; c.sample(ms, t); }
  return c;
}
{ const c = run(33.3, 12, 4, 600000); ok(c.p === 4, '30 fps-locked device seeded at 12 recovers to its class base 4, p=' + c.p); ok(c.okRec >= 8, 'by meets-target recoveries (' + c.okRec + ')'); }
{ const c = run(33.3, 4, 4, 300000); ok(c.p === 4 && c.changes === 0, 'at the class base it does not move'); }
// ... but never below the class base on the 'meets' path, and a device that cannot afford a step does not oscillate: cost model needs p >= 8
{ const c = run((p) => 33 * Math.pow(1.05, Math.max(0, 8 - p)) , 12, 4, 900000); ok(c.p >= 6 && c.p <= 8, 'a device that needs p=8 settles at 6..8, p=' + c.p); ok(c.changes <= 14, 'with few changes: ' + c.changes); }
// a slideshow still escalates exactly as before
{ const c = run(200, 0, 0, 60000); ok(c.p === MAX, 'slideshow reaches the floor'); }
// reset() contract lives in the glue; the pure part: floors under the ladder are respected by the meets path
{ const c = createController({ budgetMs: 36, okFloor: 0 }); c.seed(10, 0); c.floorP = 10; let t = 0; while (t < 300000) { t += 30; c.sample(30, t); } ok(c.p >= 10, 'memory floor respected, p=' + c.p); }

// ── browser glue under a fake window: the exact tablet case (low-GPU tablet, class base 4, remembered p=22, previous session died on the world)
function boot(opts) {
  const store = Object.assign({}, opts.store || {}); const G = globalThis; let raf = null, nowT = 0;
  for (const k of ['DMBudget', 'GFX', '_dmPrevAlive', '_dmWarming', '__JOTS_INTRO', 'DM_BUILD']) delete G[k];
  G.window = G; G.location = { search: '' }; G.document = { hidden: false }; G.devicePixelRatio = 1.5; G.innerWidth = 1280;
  G.performance = { now: () => nowT }; G.requestAnimationFrame = (cb) => { raf = cb; return 1; }; G.addEventListener = () => {}; G.dispatchEvent = () => {}; G.CustomEvent = function () {};
  G.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  G.GFX = { isMobile: true, gpuClass: 'low', score: 37, deviceMem: 8 }; if (opts.build) G.DM_BUILD = opts.build; if (opts.prev) G._dmPrevAlive = opts.prev;
  const realST = G.setTimeout; G.setTimeout = () => 0; G.setInterval = () => 1;
  delete require.cache[require.resolve('../../ui/dm-budget.js')]; require('../../ui/dm-budget.js'); G.setTimeout = realST; G.DMBudget.start();
  return { B: G.DMBudget, store, frame: (ms) => { nowT += ms; raf(nowT); } };
}
const key = 'm|low|15|6', dead = { clean: false, screen: 'flight:multiplayer@Mars/surf', hidden: false };
{ const t = boot({ store: { dm_budget_v1: JSON.stringify({ key, p: 22, t: Date.now() }) }, prev: dead });   // old code: min(22, 23) + 2 = 24 (render-scale steps, ground L2, props L2 ...)
  ok(t.B.p === 4 + SEED_ABOVE_BASE, 'tablet seed with p=22 history + died on world starts at ' + t.B.p + ' (was 24)'); ok(t.B.degraded().above === SEED_ABOVE_BASE, 'degraded() reports it');
  ok(t.B.lv.res === 0, 'no render-scale step inherited'); }
{ const t = boot({ build: 'v353', store: { dm_budget_v1: JSON.stringify({ key, p: 22, t: Date.now(), b: 'v352' }) }, prev: dead }); ok(t.B.p === 4, 'a new build starts from the class base'); ok(/new build/.test(t.B.seedWhy), 'and says why: ' + t.B.seedWhy); }
{ const t = boot({ store: { dm_budget_v1: JSON.stringify({ key, p: 22, t: Date.now() }) }, prev: dead }); ok(t.B.reset() === true, 'reset() works'); ok(t.B.p === 4 && !t.store.dm_budget_v1, 'reset: class base, remembered record forgotten');
  // 30 fps-locked frames (33.3 ms) for 5 minutes: the live controller walks back to the class base (and never below it on the meets path)
  for (let i = 0; i < 9000; i++) t.frame(33.3); ok(t.B.p === 4, 'live glue holds the class base at 33 ms, p=' + t.B.p); }
{ const t = boot({ store: { dm_budget_v1: JSON.stringify({ key, p: 22, t: Date.now() }) }, prev: dead }); for (let i = 0; i < 20000; i++) t.frame(33.3); ok(t.B.p === 4, 'seeded at 12, a 30 fps-locked tablet is back at the class base after ~11 min, p=' + t.B.p); }
console.log('budget-latch OK (' + n + ' checks)');
