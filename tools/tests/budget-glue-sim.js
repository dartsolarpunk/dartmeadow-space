// ui/dm-budget.js browser glue under a fake window: device-class seeding, last-session seeding (+1 died / +2 died on a world), persistence of the
// settled pressure, pause during warm-up, ?gov=off and ?gov=N, typed accessors and the DMGov render-scale cap.
const assert = require('assert');
function boot(opts) {
  const store = Object.assign({}, opts.store || {});
  const G = globalThis; let raf = null, now = 0;
  for (const k of ['DMBudget', 'GFX', '_dmPrevAlive', '_dmWarming', '__JOTS_INTRO']) delete G[k];
  G.window = G; G.location = { search: opts.search || '' }; G.document = { hidden: false }; G.devicePixelRatio = 1.5; G.innerWidth = 1280;
  G.performance = { now: () => now }; G.requestAnimationFrame = (cb) => { raf = cb; return 1; }; G.addEventListener = () => {}; G.dispatchEvent = () => {}; G.CustomEvent = function () {};
  G.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  G.GFX = Object.assign({ isMobile: true, gpuClass: 'low', score: 51, deviceMem: 4 }, opts.gfx || {});
  if (opts.prev) G._dmPrevAlive = opts.prev;
  const realST = G.setTimeout; G.setTimeout = () => 0;
  delete require.cache[require.resolve('../../ui/dm-budget.js')]; require('../../ui/dm-budget.js'); G.setTimeout = realST;
  G.DMBudget.start();
  return { B: G.DMBudget, store, frame: (ms) => { now += ms; raf(now); }, run: (n, ms) => { for (let i = 0; i < n; i++) { now += ms; raf(now); } }, now: () => now };
}
const key = (g) => (g.isMobile ? 'm' : 'd') + '|' + g.gpuClass + '|15|6';
// 1. class seeding: low-GPU tablet 4, mid phone 2, desktop 0
assert.strictEqual(boot({}).B.p, 4);
assert.strictEqual(boot({ gfx: { gpuClass: 'mid', score: 70 } }).B.p, 2);
assert.strictEqual(boot({ gfx: { isMobile: false, gpuClass: 'high', score: 90 } }).B.p, 0);
// 2. history: last settled p=9 -> 9; previous session died (no pagehide) -> 10; died on the surface/atmosphere -> 11
const hist = JSON.stringify({ key: key({ isMobile: true, gpuClass: 'low' }), p: 9, t: Date.now() });
assert.strictEqual(boot({ store: { dm_budget_v1: hist } }).B.p, 9);
assert.strictEqual(boot({ store: { dm_budget_v1: hist }, prev: { clean: false, screen: 'flight:multiplayer', hidden: false } }).B.p, 10);
assert.strictEqual(boot({ store: { dm_budget_v1: hist }, prev: { clean: false, screen: 'flight:multiplayer@Solenne/surf', hidden: false } }).B.p, 11);
assert.strictEqual(boot({ store: { dm_budget_v1: hist }, prev: { clean: false, screen: 'flight:multiplayer@Solenne/atmo', hidden: true } }).B.p, 9, 'a hidden-tab kill is not a crash');
// a stale (> 21 d) or other-device record is ignored
assert.strictEqual(boot({ store: { dm_budget_v1: JSON.stringify({ key: 'x', p: 9, t: Date.now() }) } }).B.p, 4);
assert.strictEqual(boot({ store: { dm_budget_v1: JSON.stringify({ key: key({ isMobile: true, gpuClass: 'low' }), p: 9, t: Date.now() - 30 * 864e5 }) } }).B.p, 4);
// 3. flags
assert.strictEqual(boot({ search: '?gov=7' }).B.p, 7);
{ const t = boot({ search: '?gov=off' }); assert.strictEqual(t.B.on, false); assert.strictEqual(t.B.p, 0); assert.strictEqual(t.B.stats(), null); assert.strictEqual(t.B.resCap(), 1); assert.strictEqual(t.B.shadowEvery(), 1); }
// 4. accessors follow the ladder
{ const t = boot({ search: '?gov=0', gfx: { isMobile: false, gpuClass: 'high' } }); const B = t.B; assert.strictEqual(B.shadowEvery(), 1); assert.strictEqual(B.resCap(), 1); assert.strictEqual(B.parallax().steps, 1);
  B.force(17); assert.strictEqual(B.resCap(), 0.6); assert.strictEqual(B.shadowEvery(), 3); assert.strictEqual(B.shadowHalf(), true); assert.strictEqual(B.parallax().off, true); assert.strictEqual(B.sprayK(), 0); assert.strictEqual(B.atmoPeriod(), 0.4);
  B.force(2); assert.strictEqual(B.parallax().stepsMax, 4); assert.strictEqual(B.parallax().shadow, 1); B.force(3); assert.strictEqual(B.parallax().shadow, 0); assert.strictEqual(B.groundReach(), 1); B.force(5); assert.strictEqual(B.groundDual(), 0); }
// 5. live: warm-up pause, escalation on slow frames, persistence only after 15 s at a pressure
{ const t = boot({ gfx: { isMobile: false, gpuClass: 'high' } }); const B = t.B; assert.strictEqual(B.p, 0);
  globalThis._dmWarming = true; t.run(200, 120); assert.strictEqual(B.p, 0, 'no decisions during the warm-up'); globalThis._dmWarming = false;
  t.run(60, 120); assert(B.p >= 1, 'escalates on 8 fps frames, p=' + B.p);
  const p1 = B.p; t.run(400, 120); assert(B.p > p1);
  t.run(300, 16.7); // calm again, saves happen on the 32-frame tick
  const j = JSON.parse(t.store.dm_budget_v1 || 'null'); console.log('stored', j && j.p, 'live p', B.p); }
console.log('budget-glue-sim OK');
