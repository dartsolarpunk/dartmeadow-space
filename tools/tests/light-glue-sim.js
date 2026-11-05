// Browser-glue simulation of DMLight (no GPU): fake window / localStorage / budget; drives tick() for thousands of frames.
// Asserts: tier pick + boot-crumb cap (a boot that died while compiling steps the next one down, 10 healthy boots lift it), the per-frame slice stays inside the ms budget,
// the ladder levels freeze / thin the work, ?light=off does nothing, the compute tier stays closed without resources, stamping a rotated grid reaches the height cache.
const assert = require('assert'), path = require('path');
const FILE = path.resolve(__dirname, '../../ui/dm-light.js');
function boot(opts) {
  delete require.cache[FILE]; const store = Object.assign({}, opts.store || {});
  for (const k of Object.keys(globalThis)) if (/^DMLight$|^DMBudget$/.test(k)) delete globalThis[k];
  globalThis.window = globalThis; globalThis.location = { search: opts.q || '' }; globalThis.GFX = opts.gfx || { isMobile: false, gpuClass: 'high' };
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  globalThis.addEventListener = (n, f) => { (globalThis.__ev = globalThis.__ev || {})[n] = f; }; globalThis.TERRAIN = { sun: { color: { r: 1, g: 0.95, b: 0.85 }, intensity: 1.2 } };
  let lvl = 0, pr = 0; globalThis.DMBudget = { on: true, lvl: (s) => (s === 'light' ? lvl : 0), p: 0, stats: () => ({ emaMs: 12 }), shadowEvery: () => 1 }; Object.defineProperty(globalThis.DMBudget, 'p', { get: () => pr });
  require(FILE); return { D: globalThis.DMLight, store, setLvl: (l) => { lvl = l; }, setP: (p) => { pr = p; } };
}
const H = (x, z) => 3 * Math.sin(x * 0.05) * Math.cos(z * 0.04) + (x > 15 && x < 22 ? 9 : 0);
const sun = { x: 0.5, y: 0.6, z: 0.3 };
function run(t, frames, o) { let worst = 0; for (let f = 0; f < frames; f++) { const t0 = process.hrtime.bigint(); t.D.tick(1 / 60, Object.assign({ x: (o && o.x) || 0, y: 2, z: (o && o.z) || 0, H, sunDir: sun, day: 1, scene: { traverse() { } } }, o || {})); worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6); } return worst; }

// 1. desktop high-end: ultra tier, boots with a pending mark, healthy after 240 frames, cache fills, slice inside budget
{ const t = boot({}); const w = run(t, 400); const s = t.D.status();
  assert.strictEqual(s.tier, 'ultra'); assert(s.ready && s.hfFilled > 10000, 'height cache filled ' + s.hfFilled); assert(s.probesPerSec > 500, 'probes/s ' + s.probesPerSec);
  assert(s.ms < 6, 'avg tick ms ' + s.ms); assert(w < 60, 'worst tick ms ' + w.toFixed(1)); assert(!s.cs && !s.csBad, 'compute tier closed without GPU resources');
  const m = JSON.parse(t.store.dm_light_boot); assert.strictEqual(m.pend, false, 'healthy boot clears the pending mark'); console.log('ultra: tick avg ' + s.ms + ' ms, worst ' + w.toFixed(1) + ' ms (cold fill), ' + s.probesPerSec + ' probes/s, caches ' + s.MB + ' MB'); }
// 2. a boot that never reached frame 240 (crash during compile) caps the next one; ten healthy boots lift the cap
{ let t = boot({}); run(t, 5); assert.strictEqual(JSON.parse(t.store.dm_light_boot).pend, true);
  t = boot({ store: t.store }); run(t, 5); assert.strictEqual(t.D.tier, 'high', 'crashed ultra boot -> high'); assert.strictEqual(JSON.parse(t.store.dm_light_boot).cap, 'high');
  run(t, 300); t = boot({ store: t.store }); run(t, 3); assert.strictEqual(t.D.tier, 'high', 'cap persists after one healthy boot');
  for (let i = 0; i < 10; i++) { run(t, 250); t = boot({ store: t.store }); run(t, 3); } assert.strictEqual(t.D.tier, 'ultra', 'cap lifted after 10 healthy boots (' + t.D.tier + ')');
  const t2 = boot({ q: '?light=ultra', store: { dm_light_boot: JSON.stringify({ pend: true, tier: 'ultra' }) } }); run(t2, 3); assert.strictEqual(t2.D.tier, 'ultra', 'an explicit ?light= is honoured'); console.log('boot cap ok'); }
// 3. phone: low / med by class, off with the flag
{ let t = boot({ gfx: { isMobile: true, gpuClass: 'low' } }); run(t, 3); assert.strictEqual(t.D.tier, 'low'); t = boot({ gfx: { isMobile: true, gpuClass: 'mid', score: 70 } }); run(t, 3); assert.strictEqual(t.D.tier, 'med');
  t = boot({ q: '?light=off' }); run(t, 30); assert(!t.D.on && !t.D.ready && t.D.status().hfFilled === 0, 'off does nothing'); }
// 4. ladder: level 1 thins rays, level 3 freezes probe updates (cache held)
{ const t = boot({}); run(t, 200); t.setLvl(1); run(t, 5); assert(t.D.eff.rays <= 8 && !t.D.eff.cs); t.setLvl(2); run(t, 5); assert.strictEqual(t.D.eff.rays, 4);
  t.setLvl(3); run(t, 30); const c0 = t.D.status().probesPerSec; run(t, 120); assert(t.D.status().probesPerSec < Math.max(5, c0 * 0.5) || t.D.eff.freeze, 'frozen'); assert(t.D.eff.freeze && t.D.eff.ms === 0);
  t.setLvl(0); run(t, 120); assert(t.D.status().probesPerSec > 200, 'resumes'); console.log('ladder levels ok'); }
// 5. headroom gate: pressure 0 + calm opens it after 8 s; the compute tier stays closed (no resources) and is never reported as failed
{ const t = boot({}); run(t, 60 * 9); assert(t.D.hr.on, 'headroom open'); assert(!t.D.cs); t.setP(2); run(t, 5); assert(!t.D.hr.on, 'pressure closes headroom'); }
// 6. moving: the window follows (entering columns only), nothing explodes; budget respected while walking fast
{ const t = boot({ gfx: { isMobile: true, gpuClass: 'mid', score: 70 } }); run(t, 120); let w = 0; for (let i = 0; i < 300; i++) w = Math.max(w, run(t, 1, { x: i * 1.5, z: i * 0.7 })); assert(w < 40, 'worst walking tick ' + w.toFixed(1) + ' ms'); assert(t.D.status().ms < 4); console.log('walking: worst ' + w.toFixed(1) + ' ms, avg ' + t.D.status().ms + ' ms (node, ~3-5x a phone)'); }
// 7. stamping a rotated grid reaches the height cache and clears again
{ const t = boot({}); run(t, 5); const th = 0.4, c = Math.cos(th), s = Math.sin(th), g = new Float64Array(30 * 30).fill(0); for (let j = 8; j < 20; j++) for (let i = 8; i < 20; i++) g[j * 30 + i] = 30;
  const n = t.D.stampGrid({ g, nx: 30, ny: 30, x0: -30, y0: -30, cell: 2, floor: 0.5, wcell: 2, fwd: (lx, ly, lz) => [lx * c + ly * s, lz, -lx * s + ly * c], inv: (wx, wz) => [wx * c - wz * s, wx * s + wz * c] }); assert(n > 100); run(t, 200);
  const hf = t.D.core.createHF; assert(t.D.status().overlays === 1); t.D.clearOverlays(); assert.strictEqual(t.D.status().overlays, 0); console.log('stamp ok (' + n + ' cells)'); }
console.log('light-glue-sim OK');
