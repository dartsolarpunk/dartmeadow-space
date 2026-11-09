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
  let prev = levelsAt(0); for (let p = 1; p <= MAX; p++) { const l = levelsAt(p); for (const k in l) assert(l[k] >= prev[k]); prev = l; } assert.strictEqual(levelsAt(MAX).res, 5); assert(order.indexOf('hudfx') < order.indexOf('water') && order.indexOf('props') < order.indexOf('shadow')); assert.strictEqual(levelsAt(MAX).hair, 1); assert.strictEqual(levelsAt(MAX).skin, 1); assert.strictEqual(levelsAt(MAX).shadow, 4); }

// 10. cost of the controller itself: 1e6 frames of bookkeeping
{ const c = createController({}); const t0 = process.hrtime.bigint(); let t = 0; for (let i = 0; i < 1e6; i++) { t += 16.7; c.sample(16.7, t); } const us = Number(process.hrtime.bigint() - t0) / 1e3 / 1e6; console.log('controller cost ' + us.toFixed(3) + ' us/frame'); assert(us < 20); }
console.log('budget-sim OK');
// 11. memory floor: floorP holds the ladder up even on a calm scene, and releases it stepwise afterwards
{ const c = createController({}); let t = 0; c.floorP = B.pOf('shadow', 3); for (let i = 0; i < 400; i++) { t += 16.7; c.sample(16.7, t); } assert.strictEqual(c.p, B.pOf('shadow', 3)); for (let i = 0; i < 3000; i++) { t += 16.7; c.sample(16.7, t); } assert.strictEqual(c.p, B.pOf('shadow', 3), 'held');
  c.floorP = 0; for (let i = 0; i < 12000; i++) { t += 16.7; c.sample(16.7, t); } assert.strictEqual(c.p, 0, 'released'); }
console.log('budget-sim memory floor OK');

// 12. (v259) a SLIDESHOW (FPS 1-2, the desktop screenshots): the old controller needed 8 frames per decision (8 s at 1 fps) and reset on a > 1.5 s frame, so it never rescued.
//     Now: the first decision after 2 slow frames, jumps scale with severity; a scene whose cost halves at the res stages reaches playable within a few seconds.
{ const resP = B.pOf('res', 1);
  // GPU-bound scene: 1000 ms at p=0, all of the cost falls away only through the render scale (res stages 1..5 -> x0.72 .. x0.18 fill), a bit through the others
  const fill = [1, 0.72, 0.52, 0.36, 0.25, 0.18];
  const model = (p) => { const l = levelsAt(p); return 1000 * (0.35 + 0.65 * fill[l.res]) * Math.pow(0.97, p - l.res); };
  const r = sim({ durMs: 60000, frame: (t, p) => model(p) });
  const first = r.trace[0]; console.log('1 fps GPU-bound: first decision at ' + (first[0] / 1000).toFixed(1) + ' s (p=' + first[1] + '), settled p=' + r.c.p + ' at ' + (r.trace[r.trace.length - 1][0] / 1000).toFixed(1) + ' s, frame ' + model(r.c.p).toFixed(0) + ' ms');
  assert(first[0] <= 2600, 'first decision within ~2 s of the slideshow starting: ' + first[0]); assert(r.trace[r.trace.length - 1][0] <= 12000, 'settled within 12 s');
  assert(r.c.p >= resP, 'went through the resolution stages'); }
{ // 0.5 fps (2 s frames, each > 1.5 s): still decided on, not ignored as hitches
  const r = sim({ durMs: 90000, frame: (t, p) => 2000 * Math.pow(0.8, p) }); assert(r.c.p >= 8, '2 s frames shed, p=' + r.c.p); console.log('0.5 fps: p=' + r.c.p + ', first decision ' + (r.trace[0][0] / 1000).toFixed(1) + ' s'); }
{ // a lone 3 s hitch followed by 16 ms frames never moves anything; a hitch followed by a few slow-ish frames costs at most the normal single step
  let n = 0; const r = sim({ durMs: 60000, frame: () => { n++; return n % 120 === 0 ? 3000 : 16; } }); assert.strictEqual(r.maxP, 0); }
console.log('budget-sim slideshow OK');
// (v297) 30 fps rule: budget 36 ms (legacy <= 3 GB: 68 ms, the 15 fps floor); a device locked to every 2nd vsync (33.3 ms +- jitter, a rare 3-vsync miss) HOLDS;
// a sustained 25 fps sheds until it is back under budget; a 60 fps device with headroom recovers to 0
{ assert.strictEqual(B.budgetFor({ isMobile: true, deviceMem: 8 }), B.TARGET_MS); assert.strictEqual(B.budgetFor({ deviceMem: 3 }), B.LEGACY_MS); assert.strictEqual(B.budgetFor({}), 36); assert.strictEqual(B.budgetFor(null), 36);
  assert.strictEqual(createController({}).budget, 36, 'default budget is the 30 fps one');
  let held = 0, worst = 0, last = null;
  for (let seed = 0; seed < 20; seed++) { let k = seed * 7919 + 1; const R = () => { k = (k * 1103515245 + 12345) & 0x7fffffff; return k / 0x7fffffff; };
    last = sim({ budget: B.TARGET_MS, seed: 6, durMs: 300000, frame: () => (R() < 0.03 ? 50 : 33.3 + (R() - 0.5) * 2) }); if (last.maxP === 6) held++; worst = Math.max(worst, last.maxP); }
  assert(held >= 18 && worst <= 7, 'a 30-fps-locked device (3 % missed vsyncs) holds: ' + held + '/20 never shed, worst p ' + worst); const lock30 = last;
  const slow = sim({ budget: B.TARGET_MS, durMs: 120000, frame: (t, p) => 40 * Math.pow(0.95, p) });
  assert(40 * Math.pow(0.95, slow.c.p) <= 36 && slow.c.p <= Math.ceil(Math.log(36 / 40) / Math.log(0.95)) + 1, '25 fps sheds just enough: p=' + slow.c.p); assert(slow.flips <= 2);
  const fast = sim({ budget: B.TARGET_MS, seed: 8, durMs: 120000, frame: () => 16.7 }); assert.strictEqual(fast.c.p, 0, 'headroom recovers');
  const legacy = sim({ budget: B.LEGACY_MS, durMs: 60000, frame: () => 50 }); assert.strictEqual(legacy.maxP, 0, 'legacy at 20 fps keeps its quality (15 fps floor)');
  console.log('30 fps target: locked-30 holds p=' + lock30.c.p + ', 25 fps scene settles p=' + slow.c.p + ', legacy floor ok'); }
