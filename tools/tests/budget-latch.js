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
console.log('budget-latch OK (' + n + ' checks)');
