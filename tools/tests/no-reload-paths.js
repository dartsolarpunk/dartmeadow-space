// node tools/tests/no-reload-paths.js — "the game restarts to the menu mid-play" guard.  Static scan of index.html + ui/*.js + jots/*.js:
//   1. every script-initiated reload (location.reload / location.replace / history.go(0)) is on the allow-list: user-tapped actions or the single dmReload() helper
//   2. the service-worker controllerchange handler never reloads (a new SW activating mid-session must not restart the page)
//   3. every allowed gameplay-reachable reload goes through dmReload (breadcrumb 'reload' + reason) and the breadcrumb listens on pagehide / hidden / context lost / error
//   4. sw.js: no client.navigate / postMessage-driven reload
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const files = ['index.html', 'sw.js'].concat(['ui', 'jots'].flatMap((d) => fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => d + '/' + f) : []));
const RX = /\b(?:window\.|document\.)?location\s*\.\s*(reload|replace)\s*\(|history\.go\(\s*0\s*\)|\blocation\s*\.\s*href\s*=[^=]|\bwindow\.location\s*=[^=]|\.navigate\(/g;
// file -> [ { must contain (on the same line), why } ]
const ALLOW = {
  'index.html': [
    { has: 'window.dmReload=function', why: 'the single helper (breadcrumb first)' },
    { has: "window.dmReload?window.dmReload('updateBar')", why: 'player taps the update bar' },
    { has: "window.dmReload?window.dmReload('gpuLost: '+why)", why: 'GPU device lost: nothing else can recover the renderer (3 in 2 min -> hold + message)' },
    { has: "window.dmReload?window.dmReload('adminClearCache'", why: 'player taps CLEAR CACHE' },
    { has: "window.dmReload?window.dmReload('bootCatch')", why: 'boot-time catch, once per tab (sessionStorage guard)' },
    { has: 'mailto:', why: 'feedback mail link' }, { has: '_ghWin.location.href=url', why: 'GitHub sign-in popup' }, { has: 'location.href=_webUrl', why: 'GitHub sign-in (no popups)' },
  ],
  'ui/dm-safety.js': [{ has: 'window.location.href = href', why: 'mailto report' }, { has: "location.replace(u.toString())", why: 'player taps CLEAR THIS DEVICE' }],
};
const found = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
  lines.forEach((ln, i) => { const t = ln.trim(); if (t.startsWith('//') || t.startsWith('*')) return; RX.lastIndex = 0; if (!RX.test(ln)) return; found.push({ f, i: i + 1, ln });
    const al = (ALLOW[f] || []).find((a) => ln.includes(a.has));
    ok(!!al, 'unlisted reload path ' + f + ':' + (i + 1) + '  ' + t.slice(0, 120)); });
}
ok(found.length > 5, 'scan found the known reload sites (' + found.length + ')');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// 2. controllerchange
{ const i = html.indexOf("addEventListener('controllerchange'"); ok(i > 0, 'controllerchange handler present'); const body = html.slice(i, html.indexOf('catch(e){}', html.indexOf('setTimeout', i)) + 12);
  ok(!/reload|location\./.test(body.replace(/'[^']*'/g, "''")), 'controllerchange handler does not reload / navigate'); ok(/dmBreadcrumb\('sw'/.test(body), 'controllerchange leaves a breadcrumb'); }
// 3. breadcrumb coverage
for (const ev of ["'pagehide'", "'visibilitychange'", "'webglcontextlost'", "'error'", "'unhandledrejection'"]) ok(html.includes("addEventListener(" + ev) && html.includes('dm_bc_v1'), 'breadcrumb listens on ' + ev);
ok(/onDeviceLost=\(info\)=>_gpuLost/.test(html) && /dmBreadcrumb&&window\.dmBreadcrumb\('gpulost'/.test(html), 'device-lost handler leaves a breadcrumb');
ok(/window\.dmReload=function\(why,url\)\{ try\{ window\.dmBreadcrumb\('reload',why\)/.test(html), 'dmReload writes the breadcrumb BEFORE reloading');
ok(/prevBreadcrumb/.test(fs.readFileSync(path.join(root, 'ui/dm-perflog.js'), 'utf8')), 'perf log report carries prevBreadcrumb');
ok(/dmAction\(/.test(html) && ['fastTravelToSystem', 'journeyLoad', 'resumeJourney', 'cycleCamMode', '_pwOpen'].every((f) => new RegExp('function ' + f + '\\([^)]*\\)\\{\\s*try\\{ window\\.dmAction').test(html)), 'travel / load / camera / world-open record dmAction');
// the 'Render hitch' toast path is only a toast + breadcrumb
{ const i = html.indexOf('function _animLoopWarn'), body = html.slice(i, html.indexOf('\n}', i)); ok(!/reload|location\./.test(body.replace(/\/\/.*$/gm, '').replace(/'[^']*'/g, "''")), '_animLoopWarn (Render hitch toast) never reloads'); ok(/dmBreadcrumb\('hitch'/.test(body), '_animLoopWarn leaves a breadcrumb'); }
// 4. service worker
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
ok(!/\.navigate\(|postMessage|reload/.test(sw.replace(/\/\/.*$/gm, '')), 'sw.js never navigates / reloads clients');
// breadcrumb unit: run the real module in a stub window
{ const vm = require('vm'), a = html.indexOf('// (v314) RESTART BREADCRUMB'), b = html.indexOf('window.dmBreadcrumb(\'boot\'', a), end = html.indexOf('})();', b) + 5;
  const store = {}, ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, L = {};
  const w = { addEventListener: (t, f) => (L[t] = L[t] || []).push(f), localStorage: ls, performance: { memory: { usedJSHeapSize: 5e7 } }, dmBcCtx: () => ({ mode: 'flight', trail: [[1, 'x']], active: [] }) };
  const ctx = { window: w, document: { hidden: false, addEventListener: (t, f) => (L['d:' + t] = L['d:' + t] || []).push(f) }, localStorage: ls, performance: w.performance, console, JSON, Date, Math, location: { reload() { ctx._reloaded = (ctx._reloaded || 0) + 1; } }, setTimeout };
  vm.createContext(ctx); vm.runInContext(html.slice(a, end), ctx);
  w.dmAction('travel', 'Veyra'); w.dmReloadWhy = (x) => { ctx._why = x; }; w.dmReload('unit-test');
  const e = JSON.parse(store.dm_bc_v1); const r = e[e.length - 1];
  ok(e[0].k === 'boot' && r.k === 'reload' && r.w === 'unit-test' && r.last && r.last[0][1] === 'travel' && ctx._why === 'unit-test' && ctx._reloaded === 1, 'dmReload: breadcrumb has reason + last action + screen context, then reloads');
  L.pagehide.forEach((f) => f({ persisted: false })); L['d:visibilitychange'].forEach((f) => f()); L.webglcontextlost.forEach((f) => f());
  const ks = JSON.parse(store.dm_bc_v1).map((x) => x.k); ok(['pagehide', 'ctxlost'].every((k) => ks.includes(k)), 'pagehide / context lost leave entries (' + ks.join(',') + ')');
  for (let i = 0; i < 20; i++) w.dmBreadcrumb('error', 'loop ' + i); ok(JSON.parse(store.dm_bc_v1).filter((x) => x.k === 'error').length <= 1, 'an error loop is rate-limited to one entry per 5 s');
  ok(JSON.parse(store.dm_bc_v1).length <= 8, 'ring is capped at 8');
  // next boot reads the previous session's entries
  const w2 = { addEventListener() {}, localStorage: ls, performance: {} }, ctx2 = { window: w2, document: { hidden: false, addEventListener() {} }, localStorage: ls, console: { info() {}, warn() {} }, JSON, Date, Math, location: { reload() {} }, performance: {}, setTimeout }; vm.createContext(ctx2); vm.runInContext(html.slice(a, end), ctx2);
  ok(w2._dmPrevBreadcrumbs.length >= 3 && w2.dmBreadcrumbs().previous.length === w2._dmPrevBreadcrumbs.length, 'the next boot exposes the previous session\'s breadcrumbs');
}
console.log(fails ? 'no-reload-paths: ' + fails + ' FAILED of ' + n : 'no-reload-paths: all ' + n + ' checks passed (' + found.length + ' reload/navigate sites, all allow-listed)');
process.exit(fails ? 1 : 0);
