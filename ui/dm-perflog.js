/*
 * DART Meadow · Journey of the Skyboard: automatic PERFORMANCE LOG capture.
 *
 * Each play session (page open to close) is one file in the player's OWN
 * private vault repository (jots-<username>, the same one that holds their
 * saves), at perf/<sessionId>.json. It's written through window.JOTS.vault,
 * so it uses the same per-player GitHub sign-in that saves use. No new
 * secret, no shared token, and nobody can read another player's repository.
 *
 *   • A snapshot goes up every 60 s (only when something changed), plus one
 *     when the tab is hidden / pagehide fires, so a session that's still
 *     running can be read in its current state.
 *   • Nothing runs per frame here. It reads what the existing perf log
 *     already keeps (dm_perf_log / dm_hitch_log in localStorage and
 *     window.dmPerfEnv) and samples the mode every 5 s.
 *   • Size-capped (~48 KB): env, summaries and hitches are kept, and the
 *     10 s windows are trimmed first.
 *   • Guests (not signed in) keep the last session on this device only.
 *     The newest local session goes up when the vault becomes ready.
 *   • Every step fails silently.
 */
(function () {
  'use strict';
  window.DMPerfLogActive = true;   // (v105) GPU pass timing runs only while this log runs
  const SNAP_MS = 60000, MODE_MS = 5000, CAP = 48 * 1024, LKEY = 'dm_perf_session_v1';
  const rid = () => { try { return Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, '0')).join(''); } catch (e) { return Math.random().toString(16).slice(2, 10); } };
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const start = new Date();
  const sessionId = start.toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + '-' + rid();
  // windows / hitches already in localStorage from earlier sessions aren't ours
  const seen = new Set();
  try { (read('dm_perf_log') || []).concat(read('dm_hitch_log') || []).forEach((e) => seen.add(JSON.stringify(e))); } catch (e) {}
  const prevLocal = read(LKEY);
  const prevUnclean = !!(prevLocal && prevLocal.sessionId && !prevLocal.final);
  const windows = [], hitches = [], modes = {}, byScreen = {};
  let lastSig = '', dirty = true, ended = false, writing = false, endNote = null;
  // (v200) memory per 10 s window: GPU objects, draw load, DOM / scene size, JS heap
  const mem = [], MEM_MS = 10000; let uaMem = null;
  function countScene() { try { let n = 0; const sc = window.scene || (typeof scene !== 'undefined' ? scene : null); if (sc && sc.traverse) sc.traverse(() => { n++; }); return n; } catch (e) { return null; } }
  function sampleMem() {
    try {
      const r = window.flightRenderer || (typeof flightRenderer !== 'undefined' ? flightRenderer : null);
      const i = r && r.info, pm = performance.memory;
      const m = { t: Math.round((Date.now() - start.getTime()) / 1000), screen: curMode(), hidden: document.hidden,
        geo: i && i.memory ? i.memory.geometries : null, tex: i && i.memory ? i.memory.textures : null,
        progs: i && i.programs ? i.programs.length : null,
        calls: i && i.render ? i.render.calls : null, tris: i && i.render ? i.render.triangles : null,
        dom: document.getElementsByTagName('*').length, sceneObj: countScene(),
        heapUsed: pm ? Math.round(pm.usedJSHeapSize / 1048576) : null, heapTotal: pm ? Math.round(pm.totalJSHeapSize / 1048576) : null,
        heapLimit: pm ? Math.round(pm.jsHeapSizeLimit / 1048576) : null, uaMB: uaMem };
      mem.push(m); if (mem.length > 120) mem.splice(0, mem.length - 120); dirty = true;
      if (window.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
        performance.measureUserAgentSpecificMemory().then((x) => { uaMem = Math.round(x.bytes / 1048576); }).catch(() => {});
      }
    } catch (e) {}
  }
  // (v200) previous session ended uncleanly? (its last local copy never got a pagehide final)
  let navType = null; try { const ne = performance.getEntriesByType('navigation')[0]; navType = ne ? ne.type : null; } catch (e) {}

  function curMode() {
    let scr = '?', m = '';
    try { scr = (typeof STATE !== 'undefined' && STATE.screen) || '?'; } catch (e) {}
    try { m = (window.JOTS && window.JOTS.mode) || ''; } catch (e) {}
    // (v223) where in the world: lets a log say "died on Solenne's surface" instead of just "flight"
    let w = '';
    try { if (typeof PW !== 'undefined' && PW && PW.active && PW.body) w = '@' + PW.body.name + (typeof atmoActive !== 'undefined' && atmoActive ? '/atmo' : (typeof surfaceActive !== 'undefined' && surfaceActive ? '/surf' : '')); } catch (e) {}
    return (m && scr !== 'menu' ? scr + ':' + m : scr) + w;
  }
  function sampleMode() {
    try {
      if (document.hidden) return;
      const k = curMode(), now = new Date().toISOString();
      const v = modes[k] || (modes[k] = { first: now, last: now, sec: 0 });
      v.last = now; v.sec += MODE_MS / 1000;
    } catch (e) {}
  }
  function harvest() {
    try {
      (read('dm_perf_log') || []).forEach((e) => {
        const s = JSON.stringify(e); if (seen.has(s)) return; seen.add(s); windows.push(e); dirty = true;
        const b = byScreen[e.screen] || (byScreen[e.screen] = { windows: 0, frames: 0, fpsSum: 0, minFps: 1e9, worstMs: 0, jank: 0 });
        b.windows++; b.frames += e.frames || 0; b.fpsSum += e.fps || 0; b.minFps = Math.min(b.minFps, e.fps || 0);
        b.worstMs = Math.max(b.worstMs, e.worstMs || 0); b.jank += e.jank || 0;
      });
      (read('dm_hitch_log') || []).forEach((e) => { const s = JSON.stringify(e); if (seen.has(s)) return; seen.add(s); hitches.push(e); dirty = true; });
      if (hitches.length > 80) hitches.splice(0, hitches.length - 80);
    } catch (e) {}
  }
  function build(final) {
    harvest();
    let env = null; try { env = typeof window.dmPerfEnv === 'function' ? window.dmPerfEnv() : null; } catch (e) {}
    const summary = {};
    Object.keys(byScreen).forEach((k) => { const b = byScreen[k]; summary[k] = { windows: b.windows, frames: b.frames, avgFps: +(b.fpsSum / b.windows).toFixed(1), minFps: b.minFps, worstMs: b.worstMs, jank: b.jank }; });
    const doc = {
      v: 1, kind: 'DART MEADOW PERF REPORT', sessionId,
      pilot: (window.JOTS && window.JOTS.identity && window.JOTS.identity.name) || null,
      start: start.toISOString(), end: final ? new Date().toISOString() : null, updated: new Date().toISOString(),
      durationSec: Math.round((Date.now() - start.getTime()) / 1000), final: !!final,
      build: env && env.build, swCache: (env && env.swCache) || window._dmSwCache || null,
      backend: env && env.backend, gpu: env && env.gpu, preset: env && env.preset, hair: env && env.hair,
      warmupMs: window._warmupMs != null ? window._warmupMs : null,
      navType, prevUnclean, prevSessionId: prevLocal && prevLocal.sessionId || null, endNote: final ? endNote : null,
      env, modes, mem: mem.slice(), summary, gpuPasses: (function () { try { return window.DMGpuProf ? window.DMGpuProf.table() : null; } catch (e) { return null; } })(), hitches: hitches.slice(), windows: windows.slice(-60), trimmed: 0,
    };
    let s = JSON.stringify(doc);
    while (s.length > CAP && doc.windows.length) { doc.windows.splice(0, Math.ceil(doc.windows.length / 4) || 1); doc.trimmed = windows.length - doc.windows.length; s = JSON.stringify(doc); }
    while (s.length > CAP && doc.mem.length > 12) { doc.mem.splice(0, Math.ceil(doc.mem.length / 4)); s = JSON.stringify(doc); }
    while (s.length > CAP && doc.hitches.length > 10) { doc.hitches.splice(0, 10); s = JSON.stringify(doc); }
    return doc;
  }
  function vault() { try { const V = window.JOTS && window.JOTS.vault; return V && V.ready ? V : null; } catch (e) { return null; } }
  function snapshot(final) {
    try {
      const doc = build(final);
      const sig = JSON.stringify([windows.length, hitches.length, modes, final]);
      try { localStorage.setItem(LKEY, JSON.stringify(doc)); } catch (e) {}
      const V = vault(); if (!V || writing) return;
      if (!final && sig === lastSig && !dirty) return;
      writing = true; lastSig = sig; dirty = false;
      Promise.resolve().then(() => V.putJSON('perf/' + sessionId + '.json', doc, 'jots: perf ' + sessionId + (final ? ' (end)' : '')))
        .catch(() => { dirty = true; }).then(() => { writing = false; });
    } catch (e) { writing = false; }
  }
  // the previous session's last local copy (in case its final write never landed)
  let carried = false;
  function carryOver() {
    if (carried) return; const V = vault(); if (!V) return; carried = true;
    try {
      const prev = prevLocal;
      if (prev && prev.sessionId && prev.sessionId !== sessionId) {
        if (!prev.end) { prev.end = prev.updated; prev.final = true; prev.endNote = 'unclean end (no pagehide; tab killed/crashed?); end time = last snapshot; next session navType=' + navType; prev.unclean = true; }
        V.putJSON('perf/' + prev.sessionId + '.json', prev, 'jots: perf ' + prev.sessionId + ' (end)').catch(() => {});
      }
    } catch (e) {}
  }
  try {
    setInterval(sampleMode, MODE_MS);
    setInterval(() => { if (!document.hidden) snapshot(false); }, SNAP_MS);
    window.addEventListener('jots:vault', () => { carryOver(); setTimeout(() => snapshot(false), 3000); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot(false); });
    window.addEventListener('pagehide', (ev) => { if (ended) return; ended = true; endNote = 'pagehide' + (ev && ev.persisted ? ' (bfcache)' : ''); sampleMem(); snapshot(true); });
    setInterval(sampleMem, MEM_MS);
    setTimeout(carryOver, 8000);
  } catch (e) {}
  window.dmPerfLog = { sessionId, snapshot: () => snapshot(false), build: () => build(false), mem: () => mem.slice() };
})();
