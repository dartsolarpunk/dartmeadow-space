// Quality governor of ui/dm-parallax.js (v256): a continuous q follows the measured frame time (steps / depth / reach shrink toward the tier floor, never to zero), phones start at 0.6,
// recovery needs a calm spell, an undone promotion doubles the wait, and trimFirst() lets the march go before the resolution governor.  Pure simulation: fake clock, fake rAF, fake interval, stub TSL (init() only builds uniforms).
const assert = require('assert');
let now = 0, rafCb = null, tickCb = null;
const G = globalThis;
G.window = G; G.location = { search: '' }; G.document = { hidden: false };
G.performance = { now: () => now };
G.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
G.setInterval = (cb) => { tickCb = cb; return 1; };
G.GFX = { isMobile: true }; G.resolvePreset = () => 'ultra';
const nop = () => ({});
G.THREE = { TSL: { Fn: nop, Loop: nop, If: nop, Break: nop, materialReference: nop, dFdx: nop, uniform: (v) => ({ value: v }), float: nop, vec3: nop }, DataTexture: function () {}, Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } normalize() { return this; } copy() { return this; } sub() { return this; } lengthSq() { return 1; } set() { return this; } } };
require('../../ui/dm-parallax.js');
const P = G.DMParallax;
assert(P.init(), 'init');
const q = () => P.status().gov.q, steps = () => P.status().cfg.steps, cfg = () => P.status().cfg;
function run(ms, frameMs) {   // advance `ms` of game time in frames of `frameMs`; the 500 ms decision interval fires on the clock
  let nextTick = Math.ceil(now / 500) * 500;
  for (const end = now + ms; now < end;) {
    now += frameMs; if (rafCb) rafCb(now);
    while (nextTick <= now) { tickCb(); nextTick += 500; }
  }
}
// 1. phones start from q = 0.6 (no saved value): Ultra's 16 steps become 10
run(1000, 16.7);
assert(Math.abs(q() - 0.6) < 1e-9, 'start q ' + q()); assert.strictEqual(steps(), 10);
// 2. a slow stretch (50 ms frames) trims quality within ~2 s and bottoms out at the tier floor: steps never reach 0, depth / reach stay > 0 (Low is small, never off)
run(2500, 50); assert(q() < 0.5, 'trimmed ' + q());
run(12000, 50); assert.strictEqual(q(), 0); assert.strictEqual(steps(), 4); assert(cfg().depthK > 0.5 && cfg().reachK > 0.4, 'floors ' + JSON.stringify(cfg())); assert.strictEqual(cfg().relief, 0); assert.strictEqual(cfg().shadow, 0);
// 3. calm frames give quality back one small step per `hold` (8 s), not sooner
run(6000, 16.7); assert.strictEqual(q(), 0);
run(8000, 16.7); assert(q() > 0 && q() <= 0.081, 'first probe ' + q());
run(60000, 16.7); assert(q() > 0.5, 'recovering ' + q());
// 4. a promotion that is undone within 20 s doubles the wait before the next one
const h0 = P.status().gov.holdMs;
run(2500, 50); assert(P.status().gov.holdMs > h0, 'back-off');
// 5. in-between frames (19..22 ms) neither promote nor trim: no flapping
run(6000, 20.5); const q1 = q(); run(30000, 20.5); assert.strictEqual(q(), q1);
// 6. the resolution governor defers to the march first: true while quality is left (bounded to 6 s), false when it is spent or the frame is hopeless (>2.5x budget)
run(2500, 50); run(12000, 50);                                          // spend it all
assert.strictEqual(P.trimFirst(40), false, 'nothing left to trim');
run(3200000, 16.7); assert(q() > 0.9, "recovered after the back-off " + q());
assert.strictEqual(P.trimFirst(30), true);                              // an episode starts
assert.strictEqual(P.trimFirst(80), false, 'catastrophic frame: both act');
run(3000, 24); assert(q() > 0.02); assert.strictEqual(P.trimFirst(30), true, 'still inside the 6 s window');
run(4000, 24); assert(q() > 0.02); assert.strictEqual(P.trimFirst(30), false, 'the deferral is bounded to ~6 s');
console.log('parallax-gov-sim: OK', JSON.stringify(P.status().gov));
