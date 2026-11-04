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
  // (perf-stability) Heartbeat: a tiny key rewritten every 5 s with where the session is and whether it ended cleanly. The 60 s snapshot cadence
  // only bounds a death to a minute; this pins it to ~5 s, names the screen / warm-up phase it died in, and lets the next session tell a
  // killed tab (heartbeat left clean:false, no pagehide) from a script-initiated reload (window.dmReloadWhy() leaves a reason in sessionStorage).
  // window._dmPrevAlive is also what the warm-up reads to boot lean after a kill (index.html _dmRecovery).
  const AKEY = 'dm_alive_v1', RKEY = 'dm_reloadWhy';
  const prevAlive = read(AKEY);
  let reloadWhy = null; try { reloadWhy = JSON.parse(sessionStorage.getItem(RKEY) || 'null'); sessionStorage.removeItem(RKEY); } catch (e) {}
  window._dmPrevAlive = prevAlive;
  window.dmReloadWhy = (why) => { try { sessionStorage.setItem(RKEY, JSON.stringify({ why: String(why).slice(0, 80), at: Date.now(), screen: curMode() })); } catch (e) {} };
  function beat(clean) {
    try { localStorage.setItem(AKEY, JSON.stringify({ sid: sessionId, t: Date.now(), up: Math.round((Date.now() - start.getTime()) / 1000), screen: curMode(), phase: window._dmWarmPhase || null, warming: !!window._dmWarming, hidden: !!document.hidden, clean: !!clean })); } catch (e) {}
  }
  const prevUnclean = !!(prevLocal && prevLocal.sessionId && !prevLocal.final);
  const windows = [], hitches = [], modes = {}, byScreen = {};
  let lastSig = '', dirty = true, ended = false, writing = false, endNote = null;
  // (v200) memory per 10 s window: GPU objects, draw load, DOM / scene size, JS heap
  const mem = [], MEM_MS = 10000; let uaMem = null;
  function countScene() { try { let n = 0; const sc = window.scene || (typeof scene !== 'undefined' ? scene : null); if (sc && sc.traverse) sc.traverse(() => { n++; }); return n; } catch (e) { return null; } }
  function quiet() { try { return !!(window._dmQuiet && window._dmQuiet()); } catch (e) { return false; } }   // fly-out / dissolve / 2.5 s settle only; the loader hold keeps sampling (memory during the warm-up matters)
  function sampleMem() {
    try {
      if (quiet()) return;   // (menu-perf) no DOM walk / scene traverse during the launch transition
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
  // (v224) What the scene is actually made of: for each top-level object of the flight scene and the world scene, the
  // visible draw count, triangles (instances included) and how many of those triangles also draw in the shadow pass.
  // Perf logs said "2.4 M triangles a frame" but not whose; this names them. Recomputed at most every 25 s.
  let _census = null, _censusAt = 0;
  function census() {
    const now = Date.now(); if (_census && now - _censusAt < 25000) return _census;
    const out = {};
    try {
      const roots = [];
      if (typeof flightScene !== 'undefined' && flightScene) roots.push(['flight', flightScene]);
      if (typeof PW !== 'undefined' && PW && PW.active && PW.scene) roots.push(['world', PW.scene]);
      for (const [rn, root] of roots) {
        const rows = [];
        for (const ch of root.children) {
          if (!ch.visible) continue;
          let draws = 0, tris = 0, shTris = 0, inst = 0, mat = '';
          ch.traverseVisible((o) => {
            const g = o.geometry; if (!g || !(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
            const pos = g.attributes && g.attributes.position; if (!pos) return;
            const n = (g.index ? g.index.count : pos.count) / (o.isMesh ? 3 : 1);
            const k = o.isInstancedMesh ? (o.count || 0) : 1;
            draws++; tris += n * k; if (o.isInstancedMesh) inst += k; if (o.castShadow) shTris += n * k;
            if (!mat) { const m = Array.isArray(o.material) ? o.material[0] : o.material; mat = (m && m.name) || ''; }
          });
          if (draws) rows.push({ name: (ch.name || ch.type) + (mat ? ' [' + mat + ']' : ''), draws, tris: Math.round(tris), shadowTris: Math.round(shTris), inst });
        }
        rows.sort((a, b) => b.tris - a.tris);
        out[rn] = { total: Math.round(rows.reduce((a, r) => a + r.tris, 0)), shadowTotal: Math.round(rows.reduce((a, r) => a + r.shadowTris, 0)), top: rows.slice(0, 22) };
      }
    } catch (e) { out.err = String(e && e.message || e).slice(0, 120); }
    _census = out; _censusAt = now; return out;
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
      reloadWhy, prevAlive: prevAlive ? { sid: prevAlive.sid, clean: prevAlive.clean, upSec: prevAlive.up, screen: prevAlive.screen, phase: prevAlive.phase, warming: prevAlive.warming, hidden: prevAlive.hidden, deadAfterSec: prevAlive.t ? Math.round((start.getTime() - prevAlive.t) / 1000) : null } : null,
      warmSteps: window._warmSteps || null, recovery: !!window._dmRecoveryUsed,
      transitions: window._dmTransitions && window._dmTransitions.length ? window._dmTransitions.slice() : null,   // (menu-perf) launch fly-out markers: per phase frames / max gap / gaps > 50, 100 ms
      navType, prevUnclean, prevSessionId: prevLocal && prevLocal.sessionId || null, endNote: final ? endNote : null,
      env, modes, mem: mem.slice(), summary, gpuPasses: (function () { try { return window.DMGpuProf ? window.DMGpuProf.table() : null; } catch (e) { return null; } })(), hitches: hitches.slice(), windows: windows.slice(-60), trimmed: 0, census: census(),
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
      const sig = JSON.stringify([windows.length, hitches.length, modes, final, window._dmTransitions ? window._dmTransitions.length : 0]);
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
    beat(false); setInterval(() => { beat(false); }, 5000);
    setInterval(() => { if (!document.hidden && !quiet()) snapshot(false); }, SNAP_MS);   // (menu-perf) not mid-transition (JSON of the whole log + vault upload); the next tick takes it
    window.addEventListener('jots:vault', () => { carryOver(); setTimeout(() => snapshot(false), 3000); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot(false); });
    window.addEventListener('pagehide', (ev) => { if (ended) return; ended = true; endNote = 'pagehide' + (ev && ev.persisted ? ' (bfcache)' : ''); beat(true); sampleMem(); snapshot(true); });
    setInterval(sampleMem, MEM_MS);
    setTimeout(carryOver, 8000);
  } catch (e) {}
  window.dmPerfLog = { sessionId, touch: () => { dirty = true; }, snapshot: () => snapshot(false), build: () => build(false), mem: () => mem.slice() };
})();
