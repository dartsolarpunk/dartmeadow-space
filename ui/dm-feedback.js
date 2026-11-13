/* DART Meadow - DMFeedback: the in-game feedback transport (v327).
 *
 * Delivery path = the SAME one Autumn web / Autumn iOS / ArcLake use: POST {action:'ashwrite', path:'feedback/inbox.json', uid, append:true,
 * payload:[entry]} (Content-Type text/plain, so no CORS preflight) to the shared Apps Script bridge, which appends the entry to
 * DART-Skyboard/leatr-ash feedback/inbox.json using ITS OWN server-side GitHub token.  The client holds no secret.
 * The bridge answers HTTP 200 with {ok:true} or {ok:false,error:'read 401'|'write 403'|...}; the number is the GitHub status the bridge saw.
 * 401 there means the bridge's GitHub token was rejected (expired / revoked): nothing the game can fix, so it is reported plainly and the
 * message goes to the local queue + the email fallback instead of being lost.
 *
 * API (window.DMFeedback; pure core also module.exports for node, tools/tests/feedback-unit.js):
 *   send(entry, opts?)       -> Promise<{ok:true,attempts}>; rejects with Error{status, kind, reason, retryable, attempts}.  One retry (backoff) on network/timeout/5xx only.
 *   describe(err)            -> short human string with the HTTP status + reason
 *   mailto(entry)            -> {to, subject, body, url}   (Justin@dartmeadow.com, 'DART Meadow feedback: <category>')
 *   queueAdd/queueRemove/queueLoad, flushQueue(opts)  -> localStorage queue (max 5, PII stripped), retried on next boot
 */
(function (root) {
  'use strict';
  const CFG = {
    gasUrl: 'https://script.google.com/macros/s/AKfycbyzkQxLR5miUXP6oDw-1AR1GIjgpzlw9iLw0gO_ZTeLfL849LWbNX7WVz_kf7yLWBKA_w/exec',
    path: 'feedback/inbox.json',
    mailto: 'Justin@dartmeadow.com',
    queueKey: 'dm_feedback_queue_v1',
    maxQueue: 5, maxAttempts: 6, timeoutMs: 15000, backoffMs: 1200, msgMax: 6500,
  };
  const REASONS = {
    400: 'the server rejected the request', 401: "the DART Network's GitHub key was rejected (expired or revoked on the server)",
    403: 'access refused or rate limited', 404: 'inbox not found', 408: 'timed out', 409: 'write conflict', 413: 'message too large',
    422: 'the server could not accept it', 429: 'rate limited, try again later', 500: 'server error', 502: 'bad gateway', 503: 'service unavailable', 504: 'gateway timeout',
  };
  function reasonFor(status) { return REASONS[status] || (status >= 500 ? 'server error' : status >= 400 ? 'request refused' : 'unexpected reply'); }
  function mkErr(kind, status, reason, extra) {
    const e = new Error((status ? 'HTTP ' + status + ' - ' : '') + reason);
    e.kind = kind; e.status = status || 0; e.reason = reason; e.retryable = kind === 'network' || kind === 'timeout' || (status >= 500 && status < 600);
    return Object.assign(e, extra || {});
  }
  // 'read 401' / 'write 403' / 'server 502' -> 401 / 403 / 502 (0 when none)
  function statusFromText(s) { const m = /\b([1-5]\d\d)\b/.exec(String(s || '')); return m ? +m[1] : 0; }
  function describe(err) {
    if (!err) return 'unknown error';
    if (err.kind === 'network' || err.kind === 'timeout') return (err.kind === 'timeout' ? 'timed out' : 'no connection') + ' - could not reach the network';
    if (err.status) return 'HTTP ' + err.status + ' - ' + (err.reason || reasonFor(err.status));
    return err.reason || err.message || 'error';
  }
  function clean(entry) { return { id: entry.id, ts: entry.ts, cat: entry.cat, msg: entry.msg, user: entry.user, source: entry.source || 'dartmeadow', platform: entry.platform }; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // one attempt: resolves {ok:true}; rejects an Error from mkErr
  function attempt(entry, o) {
    const f = o.fetch || (root.fetch && root.fetch.bind(root));
    if (!f) return Promise.reject(mkErr('network', 0, 'fetch unavailable'));
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false; const tm = setTimeout(() => { timedOut = true; try { ctrl && ctrl.abort(); } catch (e) { } }, o.timeoutMs || CFG.timeoutMs);
    const body = JSON.stringify({ action: 'ashwrite', path: CFG.path, uid: entry.user || 'guest', append: true, payload: [clean(entry)] });
    return Promise.resolve().then(() => f(o.gasUrl || CFG.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, signal: ctrl ? ctrl.signal : undefined }))
      .then((r) => r.text().then((txt) => {
        clearTimeout(tm);
        let d = null; try { d = JSON.parse(txt); } catch (e) { }
        if (d && d.ok) return { ok: true };
        const msg = d && (d.error || d.message);
        const st = (r.status >= 400 ? r.status : 0) || statusFromText(msg);
        throw mkErr(st ? 'http' : 'server', st, st ? reasonFor(st) : (msg ? String(msg).slice(0, 120) : 'unexpected reply from the server'), { raw: msg ? String(msg).slice(0, 120) : '' });
      }), (e) => { clearTimeout(tm); throw mkErr(timedOut || (e && e.name === 'AbortError') ? 'timeout' : 'network', 0, (e && e.message) || 'network error'); });
  }
  // up to 2 attempts; the retry happens only for network / timeout / 5xx
  function send(entry, opts) {
    const o = opts || {}, slp = o.sleep || sleep; let n = 0;
    const run = () => { n++; return attempt(entry, o).then((r) => Object.assign(r, { attempts: n }), (e) => {
      if (e.retryable && n < 2) return slp(o.backoffMs == null ? CFG.backoffMs : o.backoffMs).then(run);
      e.attempts = n; throw e; }); };
    return run();
  }

  // PII strip for the stored copy: no account name, e-mail addresses, phone-like / long digit runs, GitHub-style tokens
  function stripPII(s) {
    return String(s || '').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]').replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '[token]')
      .replace(/\+?\d[\d\s().-]{8,}\d/g, '[number]');
  }
  function toStored(entry) {
    return { id: entry.id, ts: entry.ts, cat: entry.cat, msg: stripPII(entry.msg).slice(0, CFG.msgMax), user: 'guest', source: 'dartmeadow', platform: entry.platform || 'web', attempts: entry.attempts | 0 };
  }
  function store(o) { try { return o && o.storage ? o.storage : root.localStorage; } catch (e) { return null; } }
  function queueLoad(o) { const s = store(o); if (!s) return []; try { const a = JSON.parse(s.getItem(CFG.queueKey) || '[]'); return Array.isArray(a) ? a.filter((x) => x && x.id && x.msg) : []; } catch (e) { return []; } }
  function queueSave(a, o) { const s = store(o); if (!s) return false; try { s.setItem(CFG.queueKey, JSON.stringify(a.slice(-CFG.maxQueue))); return true; } catch (e) { return false; } }
  function queueAdd(entry, o) { const a = queueLoad(o).filter((x) => x.id !== entry.id); a.push(toStored(entry)); return queueSave(a, o); }
  function queueRemove(id, o) { return queueSave(queueLoad(o).filter((x) => x.id !== id), o); }
  // retry queued entries (boot / next successful send); entries leave the queue on success, or after maxAttempts
  function flushQueue(o) {
    const opts = o || {}; const q = queueLoad(opts); if (!q.length) return Promise.resolve({ sent: 0, left: 0 });
    let sent = 0, chain = Promise.resolve(), stop = false;
    q.forEach((e) => { chain = chain.then(() => { if (stop) return; return send(e, Object.assign({}, opts, { backoffMs: opts.backoffMs })).then(() => { sent++; queueRemove(e.id, opts); }, (err) => {
      if (err.status === 401) stop = true;   // the bridge key itself is rejected: do not hammer it
      const a = queueLoad(opts).map((x) => x.id === e.id ? Object.assign(x, { attempts: (x.attempts | 0) + 1 }) : x).filter((x) => (x.attempts | 0) < CFG.maxAttempts); queueSave(a, opts); }); }); });
    return chain.then(() => ({ sent, left: queueLoad(opts).length }));
  }

  function mailto(entry) {
    const subject = 'DART Meadow feedback: ' + entry.cat;
    const perf = entry.perf ? '\n\n--- PERFORMANCE LOG ---\n' + String(entry.perf).split('\n').slice(0, 40).join('\n').slice(0, 1500) : '';
    const body = String(entry.raw || entry.msg || '') + '\n\n-\ncategory: ' + entry.cat + '\nplatform: ' + (entry.platform || 'web') + '\nts: ' + entry.ts + perf;
    return { to: CFG.mailto, subject, body, url: 'mailto:' + CFG.mailto + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body) };
  }

  const API = { CFG, send, describe, mailto, queueAdd, queueRemove, queueLoad, flushQueue, stripPII, statusFromText };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.DMFeedback = API;
})(typeof window !== 'undefined' ? window : globalThis);
