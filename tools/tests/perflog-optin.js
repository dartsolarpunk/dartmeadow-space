// node tools/tests/perflog-optin.js — Wave 1 "60 s hitch": the perf log, GPU timestamp queries and the timed autosaves are off the play path.
//   1. ui/dm-perflog.js by default: no 60 s snapshot / 10 s memory sample timers, DMPerfLogActive unset (=> no WebGPU timestamp queries), crash forensics
//      (heartbeat, breadcrumbs, event ring) still on, and the one full report is still written when the tab hides.
//   2. opt-in (?perf=1 / ?perflog=1, remembered; ?perflog=0 forgets): the 60 s tick only QUEUES idle work; census | build | local write | upload run one per idle
//      period with >= 10 ms left (forced on the idle timeout), never on the timer tick.
//   3. index.html _gpuTimeWanted(): false unless the log is opted in.
//   4. index.html timed autosaves: the 1-min checkpoint / 5-min backup timers only queue; the save runs in an idle period (>= 12 ms, not mid landing),
//      is forced after ~20 s (never dropped), and writes the same key with the same buildSaveData('auto') payload.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const PL = fs.readFileSync(path.join(root, 'ui/dm-perflog.js'), 'utf8'), IDX = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function store(init) { const m = new Map(Object.entries(init || {})); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, _m: m }; }
function boot(search, ls) {
  let clock = 0; const intervals = [], timeouts = [], idle = [], listeners = {}, puts = [];
  const doc = { hidden: false, getElementsByTagName: () => ({ length: 10 }), addEventListener: (t, f) => { (listeners['d:' + t] = listeners['d:' + t] || []).push(f); } };
  const w = { location: { search }, localStorage: ls, sessionStorage: store(), document: doc, performance: { now: () => clock, getEntriesByType: () => [] }, crypto: { getRandomValues: a => a },
    setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; }, setTimeout: (f, ms) => { timeouts.push({ f, ms }); return timeouts.length; },
    requestIdleCallback: (f, o) => { idle.push({ f, o }); return idle.length; }, requestAnimationFrame: f => 0,
    addEventListener: (t, f) => { (listeners['w:' + t] = listeners['w:' + t] || []).push(f); }, console, JSON, Math, Date, Map, Set, Promise, Array, Object, String, Uint8Array };
  w.window = w; w.JOTS = { vault: { ready: true, putJSON: (p, d) => { puts.push(p); return Promise.resolve(); } } };
  vm.createContext(w); vm.runInContext(PL, w, { filename: 'dm-perflog.js' });
  return { w, intervals, timeouts, idle, listeners, puts, doc, adv: ms => { clock += ms; } };
}
const LKEY = 'dm_perf_session_v1';
console.log('== perf log: default (no opt-in)');
{ const ls = store(), B = boot('', ls);
  ok(B.w.DMPerfLogActive !== true, 'DMPerfLogActive is not set (no WebGPU timestamp queries)');
  ok(!B.intervals.some(i => i.ms === 60000), 'no 60 s snapshot timer'); ok(!B.intervals.some(i => i.ms === 10000), 'no 10 s memory-sample timer');
  ok(B.intervals.some(i => i.ms === 1000) && B.intervals.some(i => i.ms === 5000), 'breadcrumb flush (1 s) + heartbeat / mode (5 s) still run');
  ok(typeof B.w.DMCrumb.mark === 'function' && typeof B.w.dmPerfLog.event === 'function' && B.w.dmPerfLog.full === false, 'DMCrumb + dmPerfLog.event still there (riderFix etc.)');
  B.intervals.forEach(i => i.f()); ok(ls.getItem(LKEY) === null, 'no timer tick builds / writes the ~80 KB report');
  B.doc.hidden = true; (B.listeners['d:visibilitychange'] || []).forEach(f => f()); const s = ls.getItem(LKEY);
  ok(!!s && JSON.parse(s).kind === 'DART MEADOW PERF REPORT', 'tab hidden: the full report is still saved (off the play path)'); }
console.log('== perf log: opted in');
for (const q of ['?perf=1', '?perflog=1']) {
  const ls = store(), B = boot(q, ls);
  ok(B.w.DMPerfLogActive === true, q + ': DMPerfLogActive set (GPU timing allowed)');
  const snap = B.intervals.find(i => i.ms === 60000); ok(!!snap, q + ': 60 s snapshot timer present');
  const before = B.idle.length; snap.f(); ok(ls.getItem(LKEY) === null && B.idle.length === before + 1, q + ': the 60 s tick only queues idle work (nothing built on the tick)');
  let st = B.idle.pop(); st.f({ didTimeout: false, timeRemaining: () => 3 }); ok(ls.getItem(LKEY) === null && B.idle.length === before + 1, q + ': a short idle period (3 ms) is skipped, re-queued');
  let slices = 0; while (B.idle.length > before && slices < 10) { st = B.idle.pop(); st.f({ didTimeout: false, timeRemaining: () => 30 }); slices++; }
  ok(slices === 4 && !!ls.getItem(LKEY), q + ': census | build | local write | upload = ' + slices + ' separate idle slices; report written');
  const mt = B.intervals.find(i => i.ms === 10000); ok(!!mt, q + ': memory sample timer present'); const b2 = B.idle.length; mt.f(); ok(B.idle.length === b2 + 1, q + ': memory sample also goes through idle'); }
{ const ls = store(); boot('?perflog=1', ls); ok(ls.getItem('dm_perflog_on') === '1', '?perflog=1 is remembered on this device');
  const B2 = boot('', ls); ok(B2.w.DMPerfLogActive === true && B2.intervals.some(i => i.ms === 60000), 'next visit without the flag: still opted in');
  const B3 = boot('?perflog=0', ls); ok(ls.getItem('dm_perflog_on') === null && B3.w.DMPerfLogActive !== true, '?perflog=0 forgets it'); }

console.log('== index.html _gpuTimeWanted');
{ const i = IDX.indexOf('function _gpuTimeWanted('), j = IDX.indexOf('return false; } }', i) + 'return false; } }'.length; const src = IDX.slice(i, j);
  for (const [ua, flag, q, want] of [['Mozilla/5.0 (Linux; Android 15) Chrome/131.0 Mobile Safari/537.36', undefined, '', false], ['Mozilla/5.0 (Linux; Android 15) Chrome/131.0 Mobile Safari/537.36', true, '', true],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/131.0 Safari/537.36', undefined, '', false], ['Mozilla/5.0 (Windows NT 10.0) Chrome/131.0 Safari/537.36', true, '?gputime=0', false]]) {
    const c = { window: { DMPerfLogActive: flag }, location: { search: q }, navigator: { userAgent: ua } }; vm.createContext(c); vm.runInContext(src, c);
    ok(vm.runInContext('_gpuTimeWanted()', c) === want, 'gpu timing ' + (want ? 'on' : 'off') + ' for ' + (flag ? 'opted-in ' : 'default ') + ua.slice(13, 30) + ' ' + q); }
  ok(/if \(ON\) window\.DMPerfLogActive = true;/.test(PL) && !/^\s*window\.DMPerfLogActive = true;/m.test(PL), 'dm-perflog.js sets DMPerfLogActive only when opted in'); }

console.log('== index.html timed autosaves');
{ const a = IDX.indexOf('  const _SAVE_Q=[];'), b = IDX.indexOf('  let _lastMilestone=0;', a); ok(a > 0 && b > a, 'idle save block found');
  const blk = IDX.slice(a, b);
  ok(/setInterval\(\(\)=>\{ if\(!document\.hidden\) _saveIdle\(_autosaveCheckpoint\); \},60000\);/.test(IDX), 'the 60 s checkpoint timer only queues');
  ok(/setInterval\(\(\)=>\{ if\(!document\.hidden\) _saveIdle\(_autosaveBackup\); \},AUTO_BACKUP_MS\);/.test(IDX), 'the 5 min backup timer only queues');
  ok(!/setInterval\([^;]*JSON\.stringify\(buildSaveData/.test(IDX), 'no timer serializes buildSaveData on its tick');
  ok(/localStorage\.setItem\('dm_autosave',JSON\.stringify\(buildSaveData\('auto'\)\)\)/.test(blk), 'checkpoint writes the same key + payload (dm_autosave = buildSaveData(\'auto\'))');
  let clock = 0; const idle = [], saved = []; const c = { performance: { now: () => clock }, console, document: { hidden: false }, localStorage: { setItem: (k, v) => saved.push([k, v]) },
    window: { requestIdleCallback: (f) => idle.push(f) }, requestIdleCallback: (f) => idle.push(f), STATE: { screen: 'surface' }, PW: {}, buildSaveData: (k) => ({ k, pos: [1, 2, 3] }), CHAR: { _transitioning: false }, atmoState: null, atmoActive: false, saveLocal: () => null, vaultAutosave() { } };
  vm.createContext(c); vm.runInContext(blk + '\n;this._saveIdle=_saveIdle;this._autosaveCheckpoint=_autosaveCheckpoint;', c);
  c._saveIdle(c._autosaveCheckpoint); ok(saved.length === 0 && idle.length === 1, 'queued, not run on the tick');
  idle.shift()({ didTimeout: false, timeRemaining: () => 4 }); ok(saved.length === 0 && idle.length === 1, 'a 4 ms idle gap is too short: re-queued');
  c.CHAR._transitioning = true; idle.shift()({ didTimeout: false, timeRemaining: () => 40 }); ok(saved.length === 0 && idle.length === 1, 'mid board transition: deferred');
  c.CHAR._transitioning = false; idle.shift()({ didTimeout: false, timeRemaining: () => 40 }); ok(saved.length === 1 && saved[0][0] === 'dm_autosave' && JSON.parse(saved[0][1]).k === 'auto' && idle.length === 0, 'runs in a roomy idle period: dm_autosave written');
  c._saveIdle(c._autosaveCheckpoint); c._saveIdle(c._autosaveCheckpoint); ok(idle.length === 1, 'the same job is not queued twice');
  c.CHAR._transitioning = true; for (let k = 0; k < 5; k++) { clock += 1000; idle.shift()({ didTimeout: false, timeRemaining: () => 2 }); } ok(saved.length === 1, 'still deferring while busy');
  clock += 20000; idle.shift()({ didTimeout: false, timeRemaining: () => 2 }); ok(saved.length === 2 && idle.length === 0, 'forced after ~20 s: a save is never dropped'); }
console.log(fails ? 'perflog-optin: FAILED ' + fails + '/' + n : 'perflog-optin: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
