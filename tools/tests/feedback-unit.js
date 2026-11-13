// ui/dm-feedback.js (v327): feedback transport with a mocked fetch - success, 401 (no retry), 5xx / network (one retry), queue + boot retry, mailto format.
const assert = require('assert');
const F = require('../../ui/dm-feedback.js');
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m }; };
const resp = (status, obj) => ({ status, ok: status < 400, text: () => Promise.resolve(typeof obj === 'string' ? obj : JSON.stringify(obj)) });
const noSleep = () => Promise.resolve();
const entry = { id: 'abc-1', ts: '2026-11-13T12:00:00.000Z', cat: 'BUG REPORT', msg: 'hull clips at the bay door', raw: 'hull clips at the bay door', user: 'someone', source: 'dartmeadow', platform: 'web' };
(async () => {
  // 1. success: Autumn-shaped ashwrite POST, text/plain (no preflight), no secret in the request
  { let calls = []; const fetch = (u, o) => { calls.push([u, o]); return Promise.resolve(resp(200, { ok: true })); };
    const r = await F.send(entry, { fetch, sleep: noSleep }); assert.strictEqual(r.ok, true); assert.strictEqual(r.attempts, 1); assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][1].method, 'POST'); assert.strictEqual(calls[0][1].headers['Content-Type'], 'text/plain'); assert(!/token|authorization/i.test(JSON.stringify(calls[0][1].headers)));
    const b = JSON.parse(calls[0][1].body); assert.strictEqual(b.action, 'ashwrite'); assert.strictEqual(b.path, 'feedback/inbox.json'); assert.strictEqual(b.append, true);
    assert.strictEqual(b.payload.length, 1); assert.strictEqual(b.payload[0].source, 'dartmeadow'); assert.strictEqual(b.payload[0].cat, 'BUG REPORT'); assert(!('raw' in b.payload[0]) && !('perf' in b.payload[0])); }
  // 2. the real failure: bridge returns 200 {ok:false,error:'read 401'} -> status 401, reason, NOT retried
  { let n = 0; const fetch = () => { n++; return Promise.resolve(resp(200, { ok: false, error: 'read 401' })); };
    await assert.rejects(F.send(entry, { fetch, sleep: noSleep }), (e) => { assert.strictEqual(e.status, 401); assert.strictEqual(e.retryable, false); assert.strictEqual(e.attempts, 1); assert(/HTTP 401/.test(F.describe(e))); assert(/key was rejected/.test(F.describe(e))); return true; });
    assert.strictEqual(n, 1, '401 is not retried'); }
  // 3. other 4xx (HTTP status itself) not retried
  { let n = 0; const fetch = () => { n++; return Promise.resolve(resp(403, 'forbidden')); };
    await assert.rejects(F.send(entry, { fetch, sleep: noSleep }), (e) => e.status === 403 && !e.retryable); assert.strictEqual(n, 1); }
  // 4. network error: retried once with backoff, then succeeds
  { let n = 0, slept = []; const fetch = () => { n++; return n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(resp(200, { ok: true })); };
    const r = await F.send(entry, { fetch, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }); assert.strictEqual(r.attempts, 2); assert.strictEqual(n, 2); assert.strictEqual(slept.length, 1); assert(slept[0] > 0); }
  // 5. network error twice: gives up after exactly 2 attempts, kind network, message says so
  { let n = 0; const fetch = () => { n++; return Promise.reject(new TypeError('Failed to fetch')); };
    await assert.rejects(F.send(entry, { fetch, sleep: noSleep }), (e) => { assert.strictEqual(e.kind, 'network'); assert.strictEqual(e.attempts, 2); assert(/could not reach the network/.test(F.describe(e))); return true; }); assert.strictEqual(n, 2); }
  // 6. 5xx via bridge error text is retried once
  { let n = 0; const fetch = () => { n++; return Promise.resolve(resp(200, { ok: false, error: 'write 502' })); };
    await assert.rejects(F.send(entry, { fetch, sleep: noSleep }), (e) => e.status === 502 && e.retryable && e.attempts === 2); assert.strictEqual(n, 2); }
  // 7. unparseable body -> informative, no crash
  { const fetch = () => Promise.resolve(resp(200, '<html>login</html>'));
    await assert.rejects(F.send(entry, { fetch, sleep: noSleep }), (e) => /unexpected reply/.test(e.reason)); }
  // 8. queue: max 5, newest kept, PII stripped (user name, e-mail, phone-like, token), failed send keeps entry, boot flush delivers + clears
  { const storage = mem();
    for (let i = 0; i < 7; i++) F.queueAdd(Object.assign({}, entry, { id: 'q' + i, msg: 'mail me at a.b@example.com or +1 (555) 123-4567 ghp_abcdefghijklmnop1234 #' + i }), { storage });
    const q = F.queueLoad({ storage }); assert.strictEqual(q.length, 5); assert.deepStrictEqual(q.map((x) => x.id), ['q2', 'q3', 'q4', 'q5', 'q6']);
    const raw = JSON.stringify(q); assert(!/example\.com|555|ghp_|someone/.test(raw), 'PII stripped'); assert(/\[email\]/.test(raw) && /\[number\]/.test(raw) && /\[token\]/.test(raw)); assert(q.every((x) => x.user === 'guest'));
    // still failing (network): all stay, attempts increment
    const bad = () => Promise.reject(new TypeError('offline')); let r = await F.flushQueue({ storage, fetch: bad, sleep: noSleep, backoffMs: 0 }); assert.strictEqual(r.sent, 0); assert.strictEqual(r.left, 5); assert(F.queueLoad({ storage }).every((x) => x.attempts === 1));
    // 401: stops after the first entry (does not hammer the bridge)
    let n = 0; await F.flushQueue({ storage, fetch: () => { n++; return Promise.resolve(resp(200, { ok: false, error: 'read 401' })); }, sleep: noSleep }); assert.strictEqual(n, 1);
    // recovered: everything delivered and cleared
    const sent = []; const good = (u, o) => { sent.push(JSON.parse(o.body).payload[0].id); return Promise.resolve(resp(200, { ok: true })); };
    r = await F.flushQueue({ storage, fetch: good, sleep: noSleep }); assert.strictEqual(r.sent, 5); assert.strictEqual(r.left, 0); assert.deepStrictEqual(sent, ['q2', 'q3', 'q4', 'q5', 'q6']); assert.strictEqual(F.queueLoad({ storage }).length, 0);
    // entries that keep failing are dropped after maxAttempts
    F.queueAdd(entry, { storage }); for (let i = 0; i < F.CFG.maxAttempts; i++) await F.flushQueue({ storage, fetch: () => Promise.resolve(resp(200, { ok: false, error: 'write 422' })), sleep: noSleep }); assert.strictEqual(F.queueLoad({ storage }).length, 0);
    // queueRemove + broken storage never throws
    F.queueAdd(entry, { storage }); F.queueRemove(entry.id, { storage }); assert.strictEqual(F.queueLoad({ storage }).length, 0);
    const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } }; assert.strictEqual(F.queueAdd(entry, { storage: boom }), false); assert.deepStrictEqual(F.queueLoad({ storage: boom }), []); }
  // 9. mailto format
  { const e2 = Object.assign({}, entry, { perf: Array.from({ length: 80 }, (_, i) => 'line ' + i).join('\n') }); const m = F.mailto(e2);
    assert.strictEqual(m.to, 'Justin@dartmeadow.com'); assert.strictEqual(m.subject, 'DART Meadow feedback: BUG REPORT');
    assert(m.url.startsWith('mailto:Justin@dartmeadow.com?subject=' + encodeURIComponent('DART Meadow feedback: BUG REPORT') + '&body=')); assert(m.body.startsWith('hull clips at the bay door'));
    assert(/PERFORMANCE LOG/.test(m.body) && /line 0/.test(m.body) && !/line 60/.test(m.body)); assert(!/radicaldeepscale/i.test(m.url));
    const m2 = F.mailto(entry); assert(!/PERFORMANCE LOG/.test(m2.body)); }
  console.log('feedback-unit OK (ashwrite shape, 401 no-retry, network/5xx retry once, queue max 5 + PII strip + boot flush, mailto Justin@dartmeadow.com)');
})().catch((e) => { console.error(e); process.exit(1); });
