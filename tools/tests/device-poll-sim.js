// Simulated GitHub device-flow poll loop for jots/jots-link.js (virtual clock).
// Asserts no devicepoll request goes out before `wait` since the previous one,
// even with constant taps, Continue presses, focus/visibility events, and that
// slow_down grows the wait by GitHub's interval + 5 s.   Run: node tools/tests/device-poll-sim.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
let now = 1e12; const timers = []; let tid = 0;
const setT = (fn, ms, rep) => { const t = { id: ++tid, at: now + Math.max(0, ms || 0), fn, rep: rep ? ms : 0 }; timers.push(t); return t.id; };
const clrT = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
const listeners = {};
const win = { addEventListener: (e, f) => (listeners[e] = listeners[e] || []).push(f), removeEventListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); } };
const fire = (e) => (listeners[e] || []).slice().forEach((f) => f({}));
const store = {};
const polls = []; let script = [];
const ctx = {
  window: win, console, JSON, Math, Promise, URLSearchParams, encodeURIComponent, AbortController,
  Date: Object.assign(function () { return new Date(now); }, { now: () => now }),
  setTimeout: (f, ms) => setT(f, ms), clearTimeout: clrT, setInterval: (f, ms) => setT(f, ms, true), clearInterval: clrT,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  document: { addEventListener: (e, f) => win.addEventListener('doc:' + e, f), hidden: false, cookie: '', querySelector: () => null, getElementById: () => null, createElement: () => ({ style: {} }) },
  navigator: { userAgent: 'sim', onLine: true }, location: { href: 'https://example.test/', search: '', hostname: 'example.test' },
  crypto: { getRandomValues: (a) => a, randomUUID: () => 'x' },
  fetch: async (url) => {
    if (!/action=devicepoll/.test(url)) return { ok: true, json: async () => ({}), text: async () => '{}' };
    polls.push(now);
    const ans = script.length ? script.shift() : { error: 'authorization_pending' };
    return { ok: true, text: async () => JSON.stringify(ans) };
  },
};
ctx.window.JOTS_RELAY_URL = ''; ctx.self = ctx.window;
vm.createContext(ctx);
try { vm.runInContext(fs.readFileSync(path.join(__dirname, '../../jots/jots-link.js'), 'utf8'), ctx); }
catch (e) { if (!(ctx.window.JOTS)) throw e; }
const auth = ctx.window.JOTS.auth;
const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms, every) {   // step the clock 100 ms at a time, running timers and optional per-step user activity
  const end = now + ms;
  while (now < end) {
    now += 100;
    if (every) every();
    for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > now) break;
      if (t.rep) t.at += t.rep; else timers.shift(); t.fn(); await flush(); }
    await flush(); await flush();
  }
}
(async () => {
  // GitHub: pending x2, then slow_down (interval 10), pending, then token.
  script = [{ error: 'authorization_pending' }, { error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { error: 'authorization_pending' }, { access_token: 'tok', username: 'u' }];
  let done = null, err = null, ticks = 0;
  auth.waitForToken({ device_code: 'dc', interval: 5, expires_in: 900 }, () => { ticks++; }).then((d) => (done = d), (e) => (err = e));
  let k = 0;
  // A user hammering the screen: pointerdown + pointermove + mouseover + resize every 100 ms,
  // Continue (pollNow) every 300 ms, focus/visibility every 700 ms.
  await advance(120000, () => {
    k++; ['pointerdown', 'pointermove', 'mouseover', 'touchstart', 'resize'].forEach(fire);
    if (k % 3 === 0) auth.pollNow(); if (k % 7 === 0) auth.pollNow(true);
    if (done || err) return;
  });
  if (err) throw err;
  assert.ok(done && done.access_token === 'tok', 'got token');
  const gaps = polls.slice(1).map((t, i) => t - polls[i]);
  console.log('poll gaps (s):', gaps.map((g) => g / 1000).join(', '));
  // wait is 5 s, then after slow_down(interval 10) -> max(5,10)+5 = 15 s
  [0, 1].forEach((i) => assert.ok(gaps[i] >= 5000, 'gap ' + i + ' >= 5 s: ' + gaps[i]));
  assert.ok(gaps[2] >= 15000, 'after slow_down gap >= 15 s: ' + gaps[2]);
  assert.ok(gaps[3] >= 15000, 'still >= 15 s: ' + gaps[3]);
  assert.ok(gaps.every((g) => g < 16000), 'urgent taps still poll promptly once the wait is over');
  assert.strictEqual(polls.length, 5);
  assert.ok(!listeners.pointermove || !listeners.pointermove.length, 'pointermove listener removed');
  assert.ok(!(listeners.mouseover || []).length, 'no mouseover kick');
  assert.ok(ticks > 0);
  // slow_down without interval (bridge drops it): +5 s.
  polls.length = 0; done = null;
  script = [{ error: 'slow_down' }, { error: 'authorization_pending' }, { access_token: 't2', username: 'u' }];
  auth.waitForToken({ device_code: 'dc2', interval: 5, expires_in: 900 }, () => {}).then((d) => (done = d));
  await advance(60000, () => { fire('pointerdown'); auth.pollNow(); });
  const g2 = polls.slice(1).map((t, i) => t - polls[i]);
  console.log('no-interval slow_down gaps (s):', g2.map((g) => g / 1000).join(', '));
  assert.ok(done && g2.every((g) => g >= 10000), 'slow_down w/o interval -> 10 s');
  console.log('PASS device-poll-sim');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
