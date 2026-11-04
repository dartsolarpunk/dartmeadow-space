// Frame-time governor of ui/dm-parallax.js (v236): levels follow the measured frame time, phones start coarse, promotion needs a calm spell,
// an undone promotion doubles the wait.  Pure simulation: fake clock, fake rAF, fake interval, stub TSL (init() only builds uniforms).
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
const lvl = () => P.status().gov.lvl, steps = () => P.status().cfg.steps;
function run(ms, frameMs) {   // advance `ms` of game time in frames of `frameMs`; the 500 ms decision interval fires on the clock
  let nextTick = Math.ceil(now / 500) * 500;
  for (const end = now + ms; now < end;) {
    now += frameMs; if (rafCb) rafCb(now);
    while (nextTick <= now) { tickCb(); nextTick += 500; }
  }
}
// 1. phones start at level 1 (coarse): at most 4 steps even at Ultra (10)
run(1000, 16.7);
assert.strictEqual(lvl(), 1); assert.strictEqual(steps(), 4);
// 2. a slow stretch (50 ms frames) drops to level 0 within ~2 s: march off
run(2500, 50);
assert.strictEqual(lvl(), 0); assert.strictEqual(steps(), 0);
// 3. calm frames promote one level per `hold` (8 s), not sooner
run(6000, 16.7); assert.strictEqual(lvl(), 0);
run(8000, 16.7); assert.strictEqual(lvl(), 1);
run(14000, 16.7); assert.strictEqual(lvl(), 2); assert.strictEqual(steps(), 10);
// 4. a promotion that is undone within 20 s doubles the wait before the next one
const h0 = P.status().gov.holdMs;
run(2500, 50); assert(lvl() <= 1); assert(P.status().gov.holdMs > h0, 'back-off');
// 5. in-between frames (24..34 ms) neither promote nor demote: no flapping
run(6000, 30); const l = lvl(); run(30000, 30); assert.strictEqual(lvl(), l);
console.log('parallax-gov-sim: OK', JSON.stringify(P.status().gov));
