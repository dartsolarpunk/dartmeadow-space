// Offline test of the global frame-budget controller (ui/dm-budget.js pure core): frame-time sequences through createController with a fake clock.
// Asserts: calm stays at 0; a slow scene escalates in LADDER order and reaches the floor fast; spikes/hitches do not move it; recovery is slow and
// stepwise; a scene whose cost is a function of the pressure settles without oscillating; an undone recovery is locked (exponential back-off).
const assert = require('assert');
const B = require('../../ui/dm-budget.js');
const { createController, LADDER, MAX, levelsAt } = B;

// scene model: frame time = base(t) * f(p); each ladder step removes a fraction of the cost
function sim(opts) {
  const c = createController({ budgetMs: opts.budget || 50 });
  if (opts.seed) c.seed(opts.seed, 0);
  let t = 0, maxP = c.p, minP = c.p, flips = 0, lastDir = 0, lastP = c.p; const trace = [];
  for (; t < opts.durMs;) {
    const ms = opts.frame(t, c.p);
    t += ms; c.sample(ms, t);
    if (c.p !== lastP) { const dir = Math.sign(c.p - lastP); if (lastDir && dir !== lastDir) flips++; lastDir = dir; lastP = c.p; trace.push([Math.round(t), c.p]); }
    maxP = Math.max(maxP, c.p); minP = Math.min(minP, c.p);
  }
  return { c, t, maxP, minP, flips, trace };
}
const gain = (p) => Math.pow(0.93, p);   // each step buys ~7 % (17 steps ~ 0.29)

// 1. calm 16.7 ms frames: nothing happens, ever
{ const r = sim({ durMs: 120000, frame: () => 16.7 }); assert.strictEqual(r.maxP, 0); assert.strictEqual(r.c.changes, 0); }

// 2. 200 ms frames (5 fps) that no step can fix: climbs in LADDER order to the floor within 40 s, then flags exhausted; two steps at a time while > 2.2x over
{ const r = sim({ durMs: 60000, frame: (t, p) => 200 }); assert.strictEqual(r.c.p, MAX, 'floor reached'); const tFloor = r.trace[r.trace.length - 1][0]; assert(tFloor < 40000, 'floor in ' + tFloor);
  assert(r.c.stats().exhausted, 'exhausted flag'); for (let i = 1; i < r.trace.length; i++) assert(r.trace[i][1] > r.trace[i - 1][1], 'monotone climb'); console.log('5 fps scene: floor p=' + MAX + ' at ' + (tFloor / 1000).toFixed(1) + ' s, steps ' + r.trace.length); }

// 3. a scene that costs 130 ms at p=0 and each step buys 7 %: it escalates only as far as needed (<= 20 fps) and then HOLDS (no oscillation)
{ const r = sim({ durMs: 120000, frame: (t, p) => 130 * gain(p) });
  const need = Math.ceil(Math.log(50 / 130) / Math.log(0.93)); console.log('130 ms scene: needs p>=' + need + ', settled p=' + r.c.p + ', flips ' + r.flips);
  assert(r.c.p >= need && r.c.p <= need + 1, 'settles just past the need'); assert(r.flips <= 2, 'no oscillation, flips=' + r.flips);
  assert(130 * gain(r.c.p) <= 50, 'settled under budget'); }

// 4. a transient (a 12 s hard stretch) escalates, then recovers slowly and fully when the scene calms; recovery is 1 step per >= 4 s
{ const r = sim({ durMs: 200000, frame: (t, p) => (t > 20000 && t < 32000 ? 180 * gain(p) : 16.7 * gain(p) + 4) });
  assert(r.maxP >= 3, 'escalated during the stretch'); assert.strictEqual(r.c.p, 0, 'recovered fully');
  const rec = r.trace.filter((x, i) => i && x[1] < r.trace[i - 1][1]); for (let i = 1; i < rec.length; i++) assert(rec[i][0] - rec[i - 1][0] >= 3900, 'recovery gap');
  console.log('transient: max p ' + r.maxP + ', recovered to 0 at ' + (rec[rec.length - 1][0] / 1000).toFixed(1) + ' s'); }

// 5. spikes and compile hitches (3 s gaps, 400 ms single frames every 2 s) on a 25 ms scene do not move the controller
{ let n = 0; const r = sim({ durMs: 90000, frame: () => { n++; return n % 80 === 0 ? 3000 : n % 40 === 0 ? 400 : 25; } }); assert.strictEqual(r.maxP, 0, 'hitches ignored, maxP=' + r.maxP); }

// 6. cost cliff: stage 9 buys nothing until step 10 (a CPU-bound frame): the controller keeps going and finally gives the budget; with a floor it never leaves [0, MAX]
{ const r = sim({ durMs: 120000, frame: (t, p) => (p >= 10 ? 40 : 90) }); assert(r.c.p >= 10 && r.c.p <= 11, 'settled right after the cliff p=' + r.c.p); assert(r.flips <= 2); }

// 7. recovery trial that fails is LOCKED (exponential back-off): a scene that is fine at p>=4 and 70 ms at p=3 flaps at most a few times in 10 min
{ const r = sim({ durMs: 600000, frame: (t, p) => (p >= 4 ? 30 : 70) });
  const ups = r.trace.filter((x, i) => i && x[1] < r.trace[i - 1][1]).length; console.log('failed-recovery scene: ' + ups + ' recovery trials in 10 min, settled p=' + r.c.p + ', locks=' + r.c.fails);
  assert(ups <= 6, 'trials bounded: ' + ups); assert(r.c.p >= 4); }

// 8. seed: starts at the seeded level at once (no slideshow); a seeded device on a calm scene recovers one step at a time
{ const r = sim({ durMs: 60000, seed: 6, frame: (t, p) => 20 }); assert.strictEqual(r.trace.length, 6, 'recovers 6 steps'); assert.strictEqual(r.c.p, 0); assert(r.trace[0][0] >= 4000); console.log('seeded 6 -> 0 at ' + (r.trace[5][0] / 1000).toFixed(1) + ' s'); }

// 9. ladder order is the contract: parallax first, resolution last; levels are monotone per stage
{ assert.strictEqual(LADDER[0][0], 'parallax'); assert.strictEqual(LADDER[LADDER.length - 1][0], 'res'); const order = LADDER.map((x) => x[0]);
  assert(order.indexOf('pxshadow') < order.indexOf('ground') && order.indexOf('ground') < order.indexOf('water') && order.indexOf('water') < order.indexOf('shadow') && order.indexOf('shadow') < order.indexOf('atmo') && order.indexOf('atmo') < order.indexOf('res'));
  let prev = levelsAt(0); for (let p = 1; p <= MAX; p++) { const l = levelsAt(p); for (const k in l) assert(l[k] >= prev[k]); prev = l; } assert.strictEqual(levelsAt(MAX).res, 3); assert.strictEqual(levelsAt(MAX).shadow, 3); }

// 10. cost of the controller itself: 1e6 frames of bookkeeping
{ const c = createController({}); const t0 = process.hrtime.bigint(); let t = 0; for (let i = 0; i < 1e6; i++) { t += 16.7; c.sample(16.7, t); } const us = Number(process.hrtime.bigint() - t0) / 1e3 / 1e6; console.log('controller cost ' + us.toFixed(3) + ' us/frame'); assert(us < 20); }
console.log('budget-sim OK');
