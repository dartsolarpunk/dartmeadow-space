/* DART Meadow — per-system frame-time HUD + hook API (v136, crunch-1).
 *
 * Always present (no-op cheap when off):
 *   DMPerf.b(name) / DMPerf.e()     CPU time of one system this frame (nestable)
 *   DMPerf.mark(name, ms)           add a measured time (e.g. a GPU sim step's CPU encode, or a known cost)
 *   DMPerf.measure(name, fn)        b/e around fn()
 *   DMPerf.frame()                  called once per rAF by the flight loop
 *   DMPerf.on                       true with ?perf=1 (or DMPerf.show())
 * Debug HUD (?perf=1): FPS, frame ms (avg / p95 / worst), CPU ms per system (EMA), the GPU
 * per-pass table from DMGpuProf (index.html, timestamp queries, WebGPU only), and the last
 * sparse-voxel terrain builds (ui/dm-sparsevox.js). Tap the HUD to collapse it.
 *
 * DMOcean (hook for the local fluid sim): CPU mirror of the far ocean's animated wave layers
 * (index.html, "animated sea surface", same 8 wavelengths/directions/steepness), so a local
 * APIC/PBF patch can blend into the far sea:
 *   DMOcean.heightAt(x, z, t?) -> metres above the sea surface level (DMOcean.seaY added)
 *   DMOcean.slopeAt(x, z, t?)  -> {sx, sz} (the same slopes the shader uses for its normal)
 *   t defaults to DMOcean.time() (seconds; set DMOcean.time to the renderer clock if needed).
 */
(function () {
  'use strict';
  const q = (() => { try { return location.search || ''; } catch (e) { return ''; } })();
  const want = /[?&]perf=1\b/.test(q);
  if (want) window.DMPerfLogActive = true;   // lets index.html turn on WebGPU timestamp queries
  const now = () => performance.now();
  const acc = Object.create(null), ema = Object.create(null), stack = [];
  const ft = new Float32Array(120); let fi = 0, fn = 0, last = 0, hud = null, hudT = 0, small = false;

  const P = {
    on: want,
    b(name) { if (!P.on) return; stack.push(name, now()); },
    e() { if (!P.on || stack.length < 2) return; const t0 = stack.pop(), n = stack.pop(); acc[n] = (acc[n] || 0) + (now() - t0); },
    mark(name, ms) { if (!P.on) return; if (typeof ms === 'number') acc[name] = (acc[name] || 0) + ms; else acc[name] = acc[name] || 0; },
    measure(name, f) { P.b(name); try { return f(); } finally { P.e(); } },
    frame() {
      if (!P.on) return;
      const t = now();
      if (last) { ft[fi] = t - last; fi = (fi + 1) % ft.length; fn = Math.min(ft.length, fn + 1); }
      last = t;
      for (const k in acc) { ema[k] = ema[k] == null ? acc[k] : ema[k] * 0.9 + acc[k] * 0.1; acc[k] = 0; }
      for (const k in ema) if (!(k in acc)) ema[k] *= 0.9;
      stack.length = 0;
      if (t - hudT > 250) { hudT = t; draw(); }
    },
    stats() {
      const a = Array.from(ft.slice(0, fn)).sort((x, y) => x - y), avg = a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
      return { fps: avg ? 1000 / avg : 0, avgMs: avg, p95Ms: a[Math.floor(a.length * 0.95)] || 0, worstMs: a[a.length - 1] || 0, minFps: a.length ? 1000 / a[a.length - 1] : 0,
        cpu: Object.assign({}, ema), gpu: (window.DMGpuProf && window.DMGpuProf.table) ? window.DMGpuProf.table() : null,
        sparse: window.DMSparseVox ? window.DMSparseVox.builds.slice(-4) : null,
        lod: window._svLodResident ? window._svLodResident() : null };
    },
    show() { P.on = true; },
    hide() { P.on = false; if (hud) hud.remove(); hud = null; },
  };

  function draw() {
    try {
      if (!document.body) return;
      if (!hud) {
        hud = document.createElement('pre'); hud.id = 'dm-perf-hud';
        hud.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483000;margin:0;padding:6px 8px;max-width:46vw;max-height:70vh;overflow:hidden;'
          + 'font:11px/1.25 ui-monospace,Menlo,Consolas,monospace;color:#d8ffe0;background:rgba(0,0,0,.62);border-radius:6px;pointer-events:auto;white-space:pre';
        hud.addEventListener('click', () => { small = !small; });
        document.body.appendChild(hud);
      }
      const s = P.stats(), f = (v) => v.toFixed(1).padStart(5);
      let out = 'FPS ' + s.fps.toFixed(0) + '  min ' + s.minFps.toFixed(0) + '  ms avg ' + s.avgMs.toFixed(1) + ' p95 ' + s.p95Ms.toFixed(1) + ' worst ' + s.worstMs.toFixed(1);
      if (!small) {
        const cpu = Object.keys(s.cpu).filter((k) => s.cpu[k] > 0.05).sort((a, b) => s.cpu[b] - s.cpu[a]);
        let tot = 0; cpu.forEach((k) => { tot += s.cpu[k]; });
        out += '\nCPU ' + f(tot) + ' ms';
        cpu.slice(0, 14).forEach((k) => { out += '\n ' + f(s.cpu[k]) + '  ' + k; });
        const g = s.gpu;
        if (g && !g.unsupported && g.passes) {
          out += '\nGPU ' + f(g.gpuMsPerFrame) + ' ms';
          Object.keys(g.passes).slice(0, 12).forEach((k) => { const p = g.passes[k]; out += '\n ' + f(p.msPerFrame) + '  ' + k + ' (' + p.passesPerFrame + ')'; });
        } else out += '\nGPU  (no timestamp queries here)';
        if (s.lod) out += '\nLOD pool ' + s.lod.bodies + '/' + s.lod.maxBodies + ' bodies x ' + s.lod.cap + ' bricks  resident ' + s.lod.mb.toFixed(1) + ' MB (' + s.lod.bricks + ' bricks)';
        if (s.sparse && s.sparse.length) {
          out += '\nSparse MC';
          s.sparse.forEach((b) => { out += '\n ' + b.kind + ' N' + b.N + ' B' + b.B + ' bricks ' + b.bricks + '/' + b.of + ' cells ' + (100 * b.cells / b.denseCells).toFixed(0) + '% ' + b.ms + 'ms'; });
        }
      }
      hud.textContent = out;
    } catch (e) {}
  }
  window.DMPerf = P;

  // ── far-ocean wave mirror (keep in step with index.html "animated sea surface") ──
  const WL = [60, 34, 19, 10.5, 5.9, 3.3, 1.85, 1.0].map((L, i) => {
    const a = 0.6 + (((i * 0.618034) % 1) - 0.5) * 2.2, k = 2 * Math.PI / L;
    return { k, w: Math.sqrt(9.81 * k), dx: Math.cos(a), dz: Math.sin(a), st: 0.085, ph0: i * 1.7 };
  });
  const O = {
    seaY: 0,
    time: () => now() / 1000,
    heightAt(x, z, t) { if (t == null) t = O.time(); let h = 0; for (const W of WL) h += (W.st / W.k) * Math.sin(x * W.dx * W.k + z * W.dz * W.k - t * W.w + W.ph0); return O.seaY + h; },
    slopeAt(x, z, t) { if (t == null) t = O.time(); let sx = 0, sz = 0; for (const W of WL) { const c = Math.cos(x * W.dx * W.k + z * W.dz * W.k - t * W.w + W.ph0) * W.st; sx += c * W.dx; sz += c * W.dz; } return { sx, sz }; },
    layers: WL,
  };
  window.DMOcean = window.DMOcean || O;
})();
