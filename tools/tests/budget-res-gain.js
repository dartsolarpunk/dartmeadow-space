// (t1516) render-scale gain check of the frame-budget ladder (ui/dm-budget.js pure core): the last five steps (render scale 0.85 .. 0.42) are kept only when they
// BUY frame time.  A CPU-bound 20-27 fps scene (what Justin's v329 phone shots show) used to run the 36 ms ladder to its end and sit at a 0.42 render scale (jagged
// edges with AA off) without getting faster; a GPU / fill-bound scene must still get its cut.
const assert = require('assert');
const B = require('../../ui/dm-budget.js');
const { createController, levelsAt, MAX, RES0, RES_GAIN } = B;
const resK = (p) => [1, 0.85, 0.72, 0.6, 0.5, 0.42][levelsAt(p).res] || 1;
function run(frame, dur, budget) { const c = createController({ budgetMs: budget || 36 }); let t = 0, maxRes = 0; for (; t < dur;) { const ms = frame(c.p); t += ms; c.sample(ms, t); maxRes = Math.max(maxRes, levelsAt(c.p).res); } return { c, maxRes }; }
assert(RES0 === MAX - 4 && RES_GAIN > 0 && RES_GAIN < 0.2, 'res steps are the last five');
let n = 0;
// 1. CPU-bound: 45 / 52 ms frames, each ladder step buys 0.5 %, the render scale buys nothing -> ends with NO render-scale cut (sharp), and the frame is no slower
for (const base of [40, 45, 52]) {
  const r = run(p => base * Math.pow(0.995, p), 300000);
  const lv = levelsAt(r.c.p);
  assert.strictEqual(lv.res, 0, base + ' ms CPU-bound: res level ' + lv.res + ' (p ' + r.c.p + ')');
  if (base >= 45) assert(r.c.resNoGain >= 1, base + ' ms: the no-gain judgement happened');
  console.log('CPU-bound ' + base + ' ms: settled p=' + r.c.p + ' res=' + lv.res + ' (scale ' + resK(r.c.p) + '), no-gain x' + r.c.resNoGain); n++;
}
// 2. GPU / fill-bound: 60 ms frames, 70 % of it fill (scales with k^2) -> the res cut stays and brings the frame under budget
{
  const r = run(p => { const k = resK(p); return 60 * Math.pow(0.995, p) * (0.3 + 0.7 * k * k); }, 300000);
  const lv = levelsAt(r.c.p), ms = 60 * Math.pow(0.995, r.c.p) * (0.3 + 0.7 * resK(r.c.p) ** 2);
  assert(lv.res >= 2, 'fill-bound keeps its render-scale cut, res=' + lv.res); assert(ms <= 36 * 1.05, 'fill-bound frame under budget ' + ms.toFixed(1));
  console.log('fill-bound 60 ms: settled p=' + r.c.p + ' res=' + lv.res + ' frame ' + ms.toFixed(1) + ' ms'); n++;
}
// 3. a slideshow (200 ms, nothing helps) is unchanged: the ladder still reaches its floor (v272 Mali tablet rule)
{ const r = run(() => 200, 60000); assert.strictEqual(r.c.p, MAX, 'slideshow floor'); n++; }
// 4. the old 50 ms budget never cut resolution in the CPU-bound case either (reference)
{ const r = run(p => 45 * Math.pow(0.995, p), 300000, 50); assert.strictEqual(levelsAt(r.c.p).res, 0); n++; }
console.log('budget-res-gain: all ' + n + ' checks passed');
