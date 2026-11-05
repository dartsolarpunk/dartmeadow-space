// Tier parameter tables of ui/dm-parallax.js (v256).   node tools/tests/parallax-tiers.js
// Checks: every tier of both device classes is non-zero in every column (Low scales DOWN, it is never off), cost is monotonic low < medium < high < ultra,
// depth / reach / steps never grow when q shrinks, the governor floor is non-zero, ground tile sizes and height-map caps grow with the tier, mobile never exceeds the
// compile-time bounds, and every tier of one class can run on the SAME shader (bounds are per class, not per tier).  Prints the per-tier cost table.
const assert = require('assert'); const P = require('../../ui/dm-parallax.js'); const R = P.ref;
const { TIERS, BOUNDS, TIER_ORDER, cfgAt, cost } = R; let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const rows = [];
for (const k of ['desktop', 'mobile']) {
  let prev = null;
  for (const t of TIER_ORDER) {
    const c = TIERS[k][t], b = BOUNDS[k];
    for (const col of ['steps', 'minSteps', 'depth', 'reach', 'hTile', 'hMax']) ok(c[col] > 0, `${k}.${t}.${col} > 0`);
    ok(c.minSteps >= 2 && c.minSteps <= c.steps, `${k}.${t} floor steps`);
    ok(c.steps <= b.maxN, `${k}.${t} steps within the compile-time loop bound`);
    ok(c.depth <= 1.2 && c.reach <= 1.3, `${k}.${t} depth / reach sane`);
    for (const q of [0, 0.25, 0.5, 0.85, 1]) {
      const f = cfgAt(c, b, q, 1);
      ok(f.steps >= 2 && f.steps <= b.maxN && f.depthK > 0 && f.reachK > 0, `${k}.${t} q=${q} never off`);
      ok(f.relief <= b.rel && f.shadow <= 1, `${k}.${t} q=${q} gates`);
    }
    ok(cfgAt(c, b, 0, 1).steps === c.minSteps, `${k}.${t} q=0 lands on the floor`);
    // monotonic in q
    let ps = 0, pd = 0, pr = 0; for (let i = 0; i <= 20; i++) { const f = cfgAt(c, b, i / 20, 1); ok(f.steps >= ps && f.depthK >= pd - 1e-9 && f.reachK >= pr - 1e-9, `${k}.${t} monotonic in q`); ps = f.steps; pd = f.depthK; pr = f.reachK; }
    // the render-scale factor can only make it cheaper, and never zero
    ok(cfgAt(c, b, 1, 0.15).steps >= c.minSteps && cfgAt(c, b, 1, 0.15).steps <= cfgAt(c, b, 1, 1).steps, `${k}.${t} render-scale coupling`);
    const cs = cost(k, t, 1);
    if (prev) { ok(cs.worst > prev.worst && cs.typical > prev.typical, `${k}: cost(${t}) > cost(previous tier)`); for (const col of ['steps', 'depth', 'reach', 'hTile', 'hMax']) ok(c[col] >= prev.c[col], `${k}: ${col} does not shrink up the tiers (${t})`); }
    prev = { worst: cs.worst, typical: cs.typical, c };
    rows.push([k, t, cs.steps, cfgAt(c, b, 1, 1).relief ? 'relief' : '-', cfgAt(c, b, 1, 1).shadow ? 'shadow' : '-', c.depth, c.reach, c.hTile, c.hMax, cs.worst, cs.typical, cost(k, t, 0).worst]);
  }
  ok(TIERS[k].custom.steps > 0, `${k}.custom`);
}
// the phones' High / Ultra are meaningfully rich (>= 12 / 16 layers, refine on) while the governor can trim them to the floor
ok(TIERS.mobile.high.steps >= 12 && TIERS.mobile.high.relief === 1 && TIERS.mobile.ultra.steps >= 16 && TIERS.mobile.ultra.shadow === 1, 'mobile High/Ultra are rich');
ok(TIERS.mobile.ultra.minSteps <= 4 && TIERS.mobile.low.steps <= 3, 'floors / Low are cheap');
// per-pixel cost at the governor floor is below the cost of the tier's neighbour below at full quality only for the top two tiers: sanity that q is a real lever
for (const k of ['desktop', 'mobile']) ok(cost(k, 'ultra', 0).worst < cost(k, 'ultra', 1).worst && cost(k, 'high', 0).worst < cost(k, 'high', 1).worst, `${k}: q lowers the cost`);
console.log('class   tier    steps relief shadow depth reach hTile hMax  worst-fetches typical floor(q=0)');
for (const r of rows) console.log(r.map((x, i) => String(x).padEnd(i < 2 ? 8 : 7)).join(''));
console.log('parallax-tiers: OK (' + n + ' checks)');
