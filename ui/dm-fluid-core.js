/* DART Meadow — fluid VFX core (crunch1 fluids).
 *
 * Shared plumbing for the true-fluid modules (ui/dm-fluid-apic.js, ui/dm-fluid-spray.js,
 * ui/dm-fluid-smoke.js, ui/dm-fluid-world.js):
 *   - budgets per graphics preset (grid size, particle counts, raymarch steps, pressure iterations)
 *   - an Auto-preset governor: only when GFX.preset === 'auto' do the budgets shrink/grow with the
 *     measured frame time; a fixed preset (Low / Medium / High / Ultra) never changes under you
 *   - DMPerf.mark(name) passthrough: uses window.DMPerf (the ?perf=1 HUD) when it exists, otherwise no-op.
 *     No global shim is installed, so the perf branch's own DMPerf always wins.
 *   - the near-shore ocean's wave field (the 8 layers of _shoreWaterMaterial), mirrored in JS and TSL, so the
 *     local liquid sim couples to the far ocean surface.
 *
 * WebGPU only (compute). On the WebGL2 fallback DMFluidCore.ok() is false and the game keeps the current
 * ocean / dust / fumes.
 */
(function () {
  'use strict';
  const W = window;

  // per-preset budgets. Tuned for a Mali-G615 tablet: Ultra (1920x1200) >= 15 FPS, Medium >= 30 FPS.
  //   B      APIC brick edge (cells), bricks: max live bricks (Ariel + impacts), h: cell size (world units)
  //   ppc    APIC particles per wet cell, spray: PBF white-water particles
  //   smoke  stable-fluids grid edge, steps: raymarch steps (fixed budget), jac: pressure Jacobi iterations
  const BUDGET = {
    low:    { B: 12, bricks: 1, h: 0.6, ppc: 2, spray: 1024, smoke: 16, steps: 10, jac: 4,  sub: 1 },
    medium: { B: 16, bricks: 1, h: 0.5, ppc: 3, spray: 3072, smoke: 24, steps: 14, jac: 6,  sub: 1 },
    high:   { B: 16, bricks: 2, h: 0.5, ppc: 4, spray: 6144, smoke: 32, steps: 20, jac: 8,  sub: 1 },
    ultra:  { B: 20, bricks: 3, h: 0.45, ppc: 4, spray: 10240, smoke: 32, steps: 24, jac: 10, sub: 1 }
  };
  BUDGET.custom = BUDGET.high;

  function preset() {
    try { if (typeof resolvePreset === 'function') { const p = resolvePreset(); if (BUDGET[p]) return p; } } catch (e) {}
    try { const g = W.GFX; if (g && BUDGET[g.preset]) return g.preset; } catch (e) {}
    return 'medium';
  }
  function isAuto() { try { return !!(W.GFX && W.GFX.preset === 'auto'); } catch (e) { return false; } }

  // Auto governor: scale in [0.25, 1]; multiplies particle counts and raymarch steps on the Auto preset only.
  const gov = { scale: 1, ema: 16.7, t: 0, last: 0 };
  function govTick(dt) {
    if (!isAuto()) { gov.scale = 1; return; }
    const ms = Math.min(250, Math.max(1, dt * 1000));
    gov.ema += (ms - gov.ema) * 0.05; gov.t += dt;
    if (gov.t < 1.0) return; gov.t = 0;
    if (gov.ema > 36) gov.scale = Math.max(0.25, gov.scale * 0.8);        // under ~28 FPS: shed fluid work
    else if (gov.ema < 24) gov.scale = Math.min(1, gov.scale * 1.08);    // comfortable: grow back
  }
  function budget() {
    const b = Object.assign({}, BUDGET[preset()] || BUDGET.medium);
    const q = location.search;
    const m = /[?&]fluidq=(low|medium|high|ultra)\b/.exec(q); if (m) Object.assign(b, BUDGET[m[1]]);
    b.scale = gov.scale;
    return b;
  }

  function mark(name) { try { const P = W.DMPerf; if (P && typeof P.mark === 'function') P.mark(name); } catch (e) {} }

  function renderer() { try { return (typeof flightRenderer !== 'undefined' && flightRenderer) || null; } catch (e) { return null; } }
  function ok(r) {
    r = r || renderer();
    if (/[?&]nofluid=1\b/.test(location.search)) return false;
    const T = W;   // TSL is spread onto window by the module loader
    return !!(r && r.backend && r.backend.isWebGPUBackend && r.backend.device && W.THREE && W.THREE.Storage3DTexture &&
      typeof T.Fn === 'function' && typeof T.instancedArray === 'function' && typeof T.atomicAdd === 'function' && typeof T.textureStore === 'function');
  }

  // ── the near-shore sea's wave field (same constants as _shoreWaterMaterial in index.html) ──
  const WAVES = [60, 34, 19, 10.5, 5.9, 3.3, 1.85, 1.0].map((L, i) => {
    const a = 0.6 + (((i * 0.618034) % 1) - 0.5) * 2.2, k = 2 * Math.PI / L, w = Math.sqrt(9.81 * k), st = 0.085;
    return { dx: Math.cos(a), dz: Math.sin(a), k, w, amp: st / k * 0.5, ph0: i * 1.7 };
  });
  // JS: height and orbital velocity at (x,z,t). Only the 4 longest layers matter at sim scale.
  function waveJS(x, z, t, out) {
    let h = 0, u = 0, v = 0, wv = 0;
    for (let i = 0; i < 5; i++) {
      const L = WAVES[i], ph = (x * L.dx + z * L.dz) * L.k - t * L.w + L.ph0, s = Math.sin(ph), c = Math.cos(ph);
      h += L.amp * s; const aw = L.amp * L.w; u += aw * s * L.dx; wv += aw * s * L.dz; v += -aw * c;
    }
    out = out || {}; out.h = h; out.u = u; out.v = v; out.w = wv; return out;
  }
  // TSL: returns {h, vel(vec3)} nodes
  function waveTSL(x, z, t) {
    const { float, vec3, sin, cos } = W;
    let h = float(0), vel = vec3(0, 0, 0);
    for (let i = 0; i < 5; i++) {
      const L = WAVES[i];
      const ph = x.mul(L.dx * L.k).add(z.mul(L.dz * L.k)).sub(t.mul(L.w)).add(L.ph0);
      const s = sin(ph), c = cos(ph), aw = L.amp * L.w;
      h = h.add(s.mul(L.amp));
      vel = vel.add(vec3(s.mul(aw * L.dx), c.mul(-aw), s.mul(aw * L.dz)));
    }
    return { h, vel };
  }

  // integer hash → [0,1) in TSL (for respawn jitter)
  function hashTSL(n) {
    const { uint, float } = W;
    let x = uint(n).toVar();
    x.assign(x.bitXor(x.shiftRight(uint(16))).mul(uint(0x7feb352d)));
    x.assign(x.bitXor(x.shiftRight(uint(15))).mul(uint(0x846ca68b)));
    x.assign(x.bitXor(x.shiftRight(uint(16))));
    return float(x.bitAnd(uint(0xffffff))).div(16777216.0);
  }

  const T0 = performance.now();
  function clock() { return (performance.now() - T0) / 1000; }
  W.DMFluidCore = { clock, BUDGET, budget, preset, isAuto, govTick, gov, mark, ok, renderer, WAVES, waveJS, waveTSL, hashTSL };
})();
