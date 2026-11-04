// node tools/tests/launchgate.test.js — unit + simulation test for ui/dm-launchgate.js (the menu -> game launch logic; no GPU, no DOM)
const L = require('../../ui/dm-launchgate.js'); const assert = require('assert');

// ── 1. phase decisions ─────────────────────────────────────────────────────────
{
  const n = L.introNext;
  // ready at the press: the fly-out starts at once, whatever the world / warm-up is doing (they are not even inputs)
  assert.strictEqual(n({ phase: 'hold', ready: true, heldMs: 0, holdMax: 15000 }), 'play');
  // not ready: bounded hold, then plays anyway
  assert.strictEqual(n({ phase: 'hold', ready: false, heldMs: 100, holdMax: 15000 }), null);
  assert.strictEqual(n({ phase: 'hold', ready: false, heldMs: 15000, holdMax: 15000 }), 'play');
  assert.strictEqual(n({ phase: 'hold', ready: false, skip: true, heldMs: 5, holdMax: 15000 }), 'wait');
  // play: runs until the board has gone; then the loader (wait) unless the world is already up
  assert.strictEqual(n({ phase: 'play', flown: false, worldReady: true }), null);   // a ready world never cuts the fly-out short
  assert.strictEqual(n({ phase: 'play', flown: true, worldReady: false }), 'wait');
  assert.strictEqual(n({ phase: 'play', flown: true, worldReady: true }), 'dissolve');
  // wait: cross-fade only when stable, or on stall / ceiling
  assert.strictEqual(n({ phase: 'wait', worldReady: false, stalled: false, over: false }), null);
  assert.strictEqual(n({ phase: 'wait', worldReady: true }), 'dissolve');
  assert.strictEqual(n({ phase: 'wait', stalled: true }), 'dissolve');
  assert.strictEqual(n({ phase: 'wait', over: true }), 'dissolve');
}

// ── 2. gate ───────────────────────────────────────────────────────────────────
{
  const ran = []; const g = L.createGate({ defer: f => f() });
  assert.strictEqual(g.run(() => ran.push('a')), true); g.run(() => ran.push('b'));
  assert.deepStrictEqual(ran, [], 'nothing runs while closed');
  assert.strictEqual(g.open(), 2); assert.deepStrictEqual(ran, ['a', 'b'], 'released in order');
  assert.strictEqual(g.run(() => ran.push('c')), false); assert.deepStrictEqual(ran, ['a', 'b', 'c'], 'open gate runs at once');
  assert.strictEqual(g.open(), 0);
}

// ── 3. slicer: budget, order, yielding, errors ─────────────────────────────────
{
  let t = 0; const sl = L.createSlicer({ budgetMs: 3, now: () => t }); const order = [];
  for (let i = 0; i < 6; i++) sl.add('j' + i, () => { order.push(i); t += 1; return true; });   // 1 ms jobs
  assert.strictEqual(sl.tick(), 3, '3 ms budget = 3 one-ms jobs'); assert.strictEqual(sl.tick(), 3); assert.strictEqual(sl.tick(), 0);
  assert.deepStrictEqual(order, [0, 1, 2, 3, 4, 5]);
  // a pending job yields the tick and is retried; the job behind it still gets its turn
  let polls = 0; sl.add('wait', () => ++polls >= 3); sl.add('after', () => { order.push('after'); return true; });
  sl.tick(); assert.strictEqual(polls, 1); assert.strictEqual(order.includes('after'), false, 'pending job ends the tick');
  sl.tick(); sl.tick(); sl.tick(); assert(order.includes('after')); assert.strictEqual(sl.size, 0);
  // a throwing job is dropped, reported, and never blocks the queue
  const errs = []; sl.onError = (n, e) => errs.push(n); sl.add('boom', () => { throw new Error('x'); }); sl.add('ok', () => true); sl.tick(); assert.deepStrictEqual(errs, ['boom']); assert.strictEqual(sl.size, 0);
}

// ── 4. drive(): only after smooth frames, only while visible, stops when empty ──
{
  let t = 0, cb = null, hidden = false; const raf = f => { cb = f; return 1; };
  const sl = L.createSlicer({ budgetMs: 3, now: () => t }); let ran = 0; for (let i = 0; i < 4; i++) sl.add('j', () => { ran++; return true; });
  L.drive(sl, { raf, caf() {}, hidden: () => hidden, calmMs: 24 });
  const frame = gap => { t += gap; const f = cb; cb = null; if (f) f(t); };
  frame(16.7);              // first frame: no previous timestamp, so no tick
  frame(60); assert.strictEqual(ran, 0, 'a janky frame (60 ms) does not run prep work');
  hidden = true; frame(16.7); assert.strictEqual(ran, 0, 'hidden page: no work');
  hidden = false; frame(16.7); assert(ran > 0, 'smooth + visible: runs');
  for (let i = 0; i < 6; i++) frame(16.7); assert.strictEqual(ran, 4); assert.strictEqual(cb, null, 'stops scheduling when the queue is empty');
}

// ── 5. simulation of the whole launch against the old behaviour ─────────────────
// Virtual 60 Hz main thread. Work items are blocking chunks (ms). The fly-out costs 6 ms of main thread per frame, 8.5 s long.
// OLD (v235): hold until the world + warm-up are done (warm-up = 11 blocking compile/upload steps), then fly-out.
//   (and the v234 behaviour, fly-out started at the press with the world build running alongside, for comparison)
// NEW: fly-out at the press; world build (the same chunks) released when the fly-out ends.
function sim(mode) {
  const FRAME = 1000 / 60, FLY = 8500;
  const world = [120, 400, 650, 900, 500, 700, 450, 800, 350, 600, 1100, 300];   // blocking chunks of the world build + warm-up (ms), phone-like
  let t = 0, flyT0 = -1, flyEnd = -1, nextWorld = 0, worldDone = false, pending = world.slice(), gaps = [], lastFrame = 0;
  const flyActive = () => flyT0 >= 0 && flyEnd < 0;
  if (mode === 'new') flyT0 = 0;          // press: fly-out begins in the same frame
  if (mode === 'alongside') flyT0 = 0;    // fly-out at the press AND the world build running right away
  for (let frame = 0; frame < 20000 && !(worldDone && flyEnd >= 0); frame++) {
    let busy = 0;                          // main-thread ms this frame
    if (flyActive()) busy += 6;
    const mayBuild = mode === 'old' ? flyT0 < 0 : mode === 'alongside' ? true : flyEnd >= 0;
    if (mayBuild && pending.length && t >= nextWorld) { busy += pending.shift(); if (!pending.length) worldDone = true; }   // one blocking chunk per frame when allowed
    const dur = Math.max(FRAME, busy);
    t += dur;
    if (flyActive()) { if (lastFrame) gaps.push(t - lastFrame); lastFrame = t; }
    if (mode === 'old' && worldDone && flyT0 < 0) { flyT0 = t; lastFrame = 0; }
    if (flyActive() && t - flyT0 >= FLY) flyEnd = t;
  }
  const max = Math.max(...gaps), over50 = gaps.filter(g => g > 50).length, over100 = gaps.filter(g => g > 100).length;
  return { mode, flyStart: Math.round(flyT0), flyFrames: gaps.length, avg: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1), max: Math.round(max), over50, over100, total: Math.round(t) };
}
const o = sim('old'), a = sim('alongside'), n = sim('new');
console.log(JSON.stringify(o)); console.log(JSON.stringify(a)); console.log(JSON.stringify(n));
assert.strictEqual(n.flyStart, 0, 'fly-out starts at the press');
assert(o.flyStart > 5000, 'old: fly-out only after the world/warm-up hold');
assert(a.max > 400 && a.over100 > 3, 'alongside (v234): the build lands inside the fly-out');
assert(n.max <= 20 && n.over50 === 0, 'new: no fly-out frame is longer than ~1 frame');
// the cost: on this model the world is ready (fly-out + build) later than the old order only by the fly-out time
assert(n.total - o.total < 9000, 'total time to the world stays within one fly-out of the old order');
console.log('launchgate: all passed');
