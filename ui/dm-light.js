/* DART Meadow — DMLight: unified real-time-bake lighting (Cosmos lighting parts 2-4).
 *
 * IDEA (what the game does instead of per-pixel ray tracing): light is BAKED CONTINUOUSLY.  A few rays per probe per update (<= 16), accumulated over time
 * (EMA, 1/16 weight per ray) into persistent caches, then read by every material with a handful of texture fetches:
 *   • world-space RADIANCE CACHE: SH L1 probes (sky visibility + bent normal, bounce RGB incl. lamps) in two cascades (clipmap) of terrain-following 3D textures
 *     around the camera.  Probe positions are toroidal (move the camera and only the entering columns are re-traced); updates are time-sliced by a ms budget.
 *   • HEIGHT CACHE: a toroidal heightfield clipmap (terrain H(x,z) + overlays: mansion collision grid, cliffs) — the one occluder representation the CPU rays AND the
 *     shader march read.  Sun visibility is a contact-hardening march of that field (8-12 steps), blended into the shadow-map result so shadows exist when the sun
 *     shadow map is cadenced / out of range.
 *   • materials: sky visibility + bent normal -> aoNode (crevices darken, shares the parallax relief height), bounce -> emissive (albedo * E/pi), HF sun visibility
 *     -> receivedShadowNode.  Everything is uniforms + textures: quality moves with the budget ladder (ui/dm-budget.js stage 'light') and NEVER recompiles.
 *   • tiers: off | low | med | high | ultra (?light=).  'ultra' (desktop GPU with headroom for several seconds at pressure 0) additionally opens the compute ray-march
 *     path (opt-in until verified on hardware: ?lightcs=1).
 *
 * Units: shE(n) = E(n)/pi (diffuse out = albedo * shE).  Bounce radiance of a hit = albedo * (sunI*cos*vis + skyI*skyVis) / pi.
 * Frame: x east, y up, z south (the surface scene's flat frame, H(x,z) = terrain height).
 * Public: DMLight.{core, on, tick, applyMaterial, setLamps, setLampLevel, addOverlay, status, tier}; pure core is also module.exports for node (tools/tests/light-unit.js).
 */
(function (root) {
  'use strict';

  /* ───────────────────────── pure core ───────────────────────── */
  const Y0 = 0.28209479177, Y1 = 0.48860251190, PI = Math.PI, GOLD = 2.399963229728653;

  // SH L1 coefficient order per channel: [c0, cx, cy, cz].
  function shProject(a, o, dx, dy, dz, v, w) { const vw = v * w; a[o] += vw * Y0; a[o + 1] += vw * Y1 * dx; a[o + 2] += vw * Y1 * dy; a[o + 3] += vw * Y1 * dz; }
  function shEval(a, o, nx, ny, nz) { return a[o] * Y0 + (2 / 3) * Y1 * (a[o + 1] * nx + a[o + 2] * ny + a[o + 3] * nz); }   // E(n)/pi, cosine-convolved
  function bentNormal(a, o, out) { const x = a[o + 1], y = a[o + 2], z = a[o + 3], l = Math.hypot(x, y, z); if (l < 1e-6) { out[0] = 0; out[1] = 1; out[2] = 0; } else { out[0] = x / l; out[1] = y / l; out[2] = z / l; } return out; }

  function rng(seed) { let s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  // n stratified sphere directions (Fibonacci spiral), jittered along z and rotated by yaw: a different set every update, uniform over time
  function rayDirs(n, u, yaw, out) {
    for (let i = 0; i < n; i++) {
      const z = 1 - 2 * (i + u) / n, r = Math.sqrt(Math.max(0, 1 - z * z)), a = (i + u) * GOLD + yaw;
      out[i * 3] = r * Math.cos(a); out[i * 3 + 1] = z; out[i * 3 + 2] = r * Math.sin(a);
    }
    return out;
  }

  /* toroidal height cache.  Cell (i,j) holds H at x = i*cell, z = j*cell; slot = (i&M, j&M); stamps tell whether the slot belongs to the current window. */
  function createHF(N, cell) {
    const M = N - 1, hf = {
      N, M, cell, data: new Float32Array(N * N), si: new Int32Array(N * N).fill(0x7fffffff), sj: new Int32Array(N * N).fill(0x7fffffff),
      ci: 0, cj: 0, cursor: 0, ver: 0, sampler: null, overlays: [], filled: 0,
    };
    hf.setCenter = function (x, z) { hf.ci = Math.round(x / cell); hf.cj = Math.round(z / cell); };
    hf.cellH = function (i, j) { const x = i * cell, z = j * cell; let h = hf.sampler ? hf.sampler(x, z) : 0; for (const o of hf.overlays) { const v = overlayAt(o, x, z); if (v > h) h = v; } return h; };
    // fills up to maxFill stale cells (checks at most maxCheck slots); returns the number filled.  ms > 0 bounds the time too.
    hf.fill = function (maxFill, maxCheck, ms) {
      const i0 = hf.ci - (N >> 1), j0 = hf.cj - (N >> 1), tot = N * N; let nf = 0, nc = 0, k = hf.cursor; const t0 = ms > 0 ? now() : 0;
      while (nc < maxCheck && nf < maxFill) {
        const i = i0 + (k % N), j = j0 + ((k / N) | 0), idx = (i & M) + (j & M) * N;
        if (hf.si[idx] !== i || hf.sj[idx] !== j) { hf.data[idx] = hf.cellH(i, j); hf.si[idx] = i; hf.sj[idx] = j; nf++; if (ms > 0 && (nf & 31) === 0 && now() - t0 > ms) { k = (k + 1) % tot; break; } }
        k = (k + 1) % tot; nc++;
      }
      hf.cursor = k; if (nf) { hf.ver++; hf.filled += nf; } return nf;
    };
    hf.valid = function (i, j) { const idx = (i & M) + (j & M) * N; return hf.si[idx] === i && hf.sj[idx] === j; };
    hf.get = function (i, j) { const idx = (i & M) + (j & M) * N; return hf.si[idx] === i && hf.sj[idx] === j ? hf.data[idx] : -1e9; };   // not-yet-filled = open air
    hf.h = function (x, z) {   // bilinear
      const fx = x / cell, fz = z / cell, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
      const a = hf.get(i, j), b = hf.get(i + 1, j), c = hf.get(i, j + 1), d = hf.get(i + 1, j + 1);
      if (a < -1e8 || b < -1e8 || c < -1e8 || d < -1e8) return Math.max(a, b, c, d);
      return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    };
    hf.normal = function (x, z, out) { const e = cell, hx = hf.h(x + e, z) - hf.h(x - e, z), hz = hf.h(x, z + e) - hf.h(x, z - e), l = Math.hypot(hx, 2 * e, hz); out[0] = -hx / l; out[1] = 2 * e / l; out[2] = -hz / l; return out; };
    hf.addOverlay = function (o) {   // o: {x0,z0,cell,nx,nz,h(Float32Array metres), floor}; heights <= floor are ignored.  Stale-marks the covered slots.
      hf.overlays.push(o); const i0 = Math.floor(o.x0 / cell), i1 = Math.ceil((o.x0 + o.nx * o.cell) / cell), j0 = Math.floor(o.z0 / cell), j1 = Math.ceil((o.z0 + o.nz * o.cell) / cell);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const idx = (i & M) + (j & M) * N; if (hf.si[idx] === i && hf.sj[idx] === j) hf.si[idx] = 0x7fffffff; }
      hf.ver++;
    };
    return hf;
  }
  function overlayAt(o, x, z) {
    const fx = (x - o.x0) / o.cell, fz = (z - o.z0) / o.cell; if (fx < 0 || fz < 0 || fx >= o.nx - 1 || fz >= o.nz - 1) return -1e9;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, h = o.h, nx = o.nx, a = h[j * nx + i], b = h[j * nx + i + 1], c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1], fl = o.floor == null ? -1e8 : o.floor;
    if (a <= fl && b <= fl && c <= fl && d <= fl) return -1e9;
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Ray march (quadratic step spacing: dense near the origin).  Returns hit distance or -1.  Refined by linear interpolation of the last two samples.
  function march(hf, ox, oy, oz, dx, dy, dz, maxD, steps, t0) {
    let tp = t0, dp = oy + dy * tp - hf.h(ox + dx * tp, oz + dz * tp); if (dp < 0) return tp;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps, t = t0 + (maxD - t0) * f * f, d = oy + dy * t - hf.h(ox + dx * t, oz + dz * t);
      if (d < 0) { const k = dp / (dp - d); return tp + (t - tp) * k; }
      tp = t; dp = d;
    }
    return -1;
  }
  function marchBrute(hf, ox, oy, oz, dx, dy, dz, maxD, t0) { const st = hf.cell * 0.05; for (let t = t0; t <= maxD; t += st) { if (oy + dy * t < hf.h(ox + dx * t, oz + dz * t)) return t; } return -1; }
  // Soft sun visibility along L (unit): min over steps of clamp(0.5 + 0.5*dh/(pen*t)).  The penumbra grows with distance to the occluder (contact hardening).
  function sunVis(hf, x, y, z, lx, ly, lz, steps, maxD, pen, bias) {
    if (ly <= 0.02) return 0; let vis = 1, t0 = hf.cell * 0.6;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps, t = t0 + (maxD - t0) * f * f, dh = y + ly * t - hf.h(x + lx * t, z + lz * t) + (bias || 0);
      const v = 0.5 + 0.5 * dh / (pen * t + 1e-4); if (v < vis) { vis = v < 0 ? 0 : v; if (vis <= 0) return 0; }
    }
    return vis > 1 ? 1 : vis;
  }
  function sunVisBrute(hf, x, y, z, lx, ly, lz, maxD) { if (ly <= 0.02) return 0; const st = hf.cell * 0.05; for (let t = hf.cell * 0.6; t <= maxD; t += st) if (y + ly * t < hf.h(x + lx * t, z + lz * t)) return 0; return 1; }

  // Long-range soft shadows: the near field (2 m cells, to nearMax) then the coarse field (8 m cells, to farMax) with a wider penumbra (big, soft shadows of ridges / cliffs / the mansion)
  function sunVisLong(hfN, hfF, x, y, z, lx, ly, lz, nSteps, fSteps, nearMax, farMax, penN, penF, bias) {
    if (ly <= 0.02) return 0; let vis = nSteps > 0 ? sunVis(hfN, x, y, z, lx, ly, lz, nSteps, nearMax, penN, bias) : 1; if (vis <= 0 || !hfF || fSteps <= 0) return vis;
    for (let s = 1; s <= fSteps; s++) {
      const f = s / fSteps, t = nearMax + (farMax - nearMax) * Math.pow(f, 1.5), dh = y + ly * t - hfF.h(x + lx * t, z + lz * t) + (bias || 0), v = 0.5 + 0.5 * dh / (penF * t + 1e-4);
      if (v < vis) { vis = v < 0 ? 0 : v; if (vis <= 0) return 0; }
    }
    return vis;
  }
  // World-aligned height overlay from a rotated local grid (the mansion collision grid).  g: local heights (nx*ny, row = y), local frame x0,y0,cell; fwd(lx,ly,lz) -> [wx,wy,wz];
  // inv(wx,wz) -> [lx,ly] (local nav x,y of a world point).  Cells where the grid holds no structure (h <= floor) stay empty.
  function rasterizeOverlay(g, nx, ny, x0, y0, cell, fwd, inv, wcell, floor) {
    let minx = 1e30, maxx = -1e30, minz = 1e30, maxz = -1e30;
    for (const [i, j] of [[0, 0], [nx - 1, 0], [0, ny - 1], [nx - 1, ny - 1]]) { const w = fwd(x0 + i * cell, y0 + j * cell, 0); minx = Math.min(minx, w[0]); maxx = Math.max(maxx, w[0]); minz = Math.min(minz, w[2]); maxz = Math.max(maxz, w[2]); }
    const ox = Math.floor(minx / wcell) * wcell, oz = Math.floor(minz / wcell) * wcell, wn = Math.ceil((maxx - ox) / wcell) + 1, wm = Math.ceil((maxz - oz) / wcell) + 1, out = new Float32Array(wn * wm).fill(-1e9);
    for (let j = 0; j < wm; j++) for (let i = 0; i < wn; i++) {
      const wx = ox + i * wcell, wz = oz + j * wcell, l = inv(wx, wz), fx = (l[0] - x0) / cell, fy = (l[1] - y0) / cell; if (fx < 0 || fy < 0 || fx >= nx - 1 || fy >= ny - 1) continue;
      const a = fx | 0, b = fy | 0, tx = fx - a, ty = fy - b, h00 = g[b * nx + a], h10 = g[b * nx + a + 1], h01 = g[(b + 1) * nx + a], h11 = g[(b + 1) * nx + a + 1];
      if (h00 <= floor && h10 <= floor && h01 <= floor && h11 <= floor) continue;
      const h = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty; out[j * wn + i] = fwd(l[0], l[1], h)[1];
    }
    return { x0: ox, z0: oz, cell: wcell, nx: wn, nz: wm, h: out, floor: -1e8 };
  }
  // compute-path ray set: the same stratified spiral as rayDirs, jitter + yaw from a hash of (probe, frame) so the GPU needs no RNG state.  hash1 mirrors the TSL fract(sin()) hash.
  function hash1(x) { const s = Math.sin(x) * 43758.5453; return s - Math.floor(s); }
  function csRayDirs(n, probe, frame, out) { return rayDirs(n, hash1(probe * 12.9898 + frame * 78.233), hash1(probe * 39.346 + frame * 11.135) * 6.2831853, out); }
  // a boot that never reached its 240th frame (shader / device failure during compile) steps the tier down for the next boot; a healthy boot clears the mark
  function stepDownTier(t) { const i = TIER_ORDER.indexOf(t); return i <= 1 ? 'off' : TIER_ORDER[i - 1]; }
  function capTier(t, cap) { return cap && TIER_ORDER.indexOf(cap) < TIER_ORDER.indexOf(t) ? cap : t; }
  function bootTier(want, mark) { return mark && mark.pend ? stepDownTier(mark.tier && TIER_ORDER.indexOf(mark.tier) < TIER_ORDER.indexOf(want) ? mark.tier : want) : want; }

  /* ───── tiers: every number the ladder moves is a plain parameter (uniform write / cadence); nothing here changes a shader graph ───── */
  const TIERS = {   // rays per probe update, cascades updated, probe ms budget per frame, march steps (rays), HF sun steps (shader), HF cells, cascade probes (P x P x L), compute allowed,
    // far-shadow steps (long-range soft shadows from the coarse 8 m field, 1 km window) and its cell count
    off:   { rays: 0,  casc: 0, ms: 0,   mSteps: 0,  sunSteps: 0,  hfN: 0,   P: 0,  L: 0, cs: false, farSteps: 0, farN: 0 },
    low:   { rays: 4,  casc: 1, ms: 0.6, mSteps: 6,  sunSteps: 6,  hfN: 64,  P: 16, L: 3, cs: false, farSteps: 0, farN: 0 },
    med:   { rays: 8,  casc: 2, ms: 1.0, mSteps: 8,  sunSteps: 8,  hfN: 128, P: 24, L: 4, cs: false, farSteps: 4, farN: 64 },
    high:  { rays: 16, casc: 2, ms: 1.5, mSteps: 10, sunSteps: 12, hfN: 128, P: 32, L: 4, cs: false, farSteps: 6, farN: 128 },
    ultra: { rays: 16, casc: 2, ms: 2.0, mSteps: 12, sunSteps: 12, hfN: 256, P: 32, L: 4, cs: true,  farSteps: 8, farN: 128 },
  };
  const FAR_CELL = 8, NEAR_MAX = 64, FAR_MAX = 720;
  const TIER_ORDER = ['off', 'low', 'med', 'high', 'ultra'];
  // ladder level (ui/dm-budget.js stage 'light', 0..3) -> effective parameters.  L1 halves rays/steps and closes the compute path, L2 = 4 rays, one cascade
  // fewer updates and half the update budget, L3 = the cache is frozen (held, still read) and the shader march is short.
  function effective(tier, lvl, headroom) {
    const b = TIERS[tier] || TIERS.off, e = Object.assign({}, b); lvl = lvl | 0;
    if (!b.rays) return Object.assign(e, { tier, lvl, cs: false, freeze: true });
    e.cs = !!(b.cs && lvl === 0 && headroom); e.freeze = false;
    e.farSteps = b.farSteps;
    if (lvl >= 1) { e.farSteps = b.farSteps >> 1; e.rays = Math.max(4, b.rays >> 1); e.mSteps = Math.max(5, b.mSteps >> 1); e.sunSteps = Math.max(5, (b.sunSteps * 2 / 3) | 0); }
    if (lvl >= 2) { e.rays = 4; e.casc = Math.max(1, b.casc - 1); e.ms = b.ms * 0.5; e.mSteps = 5; e.sunSteps = Math.max(5, b.sunSteps >> 1); e.farSteps = b.farSteps >> 2; }
    if (lvl >= 3) { e.freeze = true; e.ms = 0; e.sunSteps = 5; e.farSteps = Math.min(e.farSteps, 1); }
    e.tier = tier; e.lvl = lvl; return e;
  }
  // relative per-second cost (CPU rays + shader fetches) used by the monotonicity test and the status line
  function cost(e) { return e.ms * 100 + e.sunSteps * 2 + (e.farSteps || 0) * 2 + (e.cs ? 400 : 0) + e.casc * 4; }
  // tier from the device description (GFX in index.html); flag overrides
  function pickTier(g, flag) {
    if (flag && TIERS[flag]) return flag; g = g || {};
    if (g.preset === 'low') return 'low';
    if (g.isMobile) { const weak = g.gpuClass === 'low' || (g.score != null && g.score < 55) || (g.deviceMem > 0 && g.deviceMem <= 3); return weak ? 'low' : (g.gpuClass === 'high' ? 'high' : 'med'); }
    if (g.gpuClass === 'high') return 'ultra'; if (g.gpuClass === 'mid' || g.gpuClass === 'unknown' || g.gpuClass == null) return 'high'; return 'med';
  }
  // compute-path gate: headroom = pressure 0 and a calm frame for `hold` seconds.  Pure state machine so it can be tested with a fake clock.
  function createHeadroom(o) {
    o = o || {}; const hold = o.hold || 8, drop = o.drop || 1.5; let calm = 0, on = false, since = 0;
    return {
      step(dt, pressure, emaMs, budgetMs) {
        const ok = pressure === 0 && emaMs > 0 && emaMs < (budgetMs || 50) * 0.5;
        if (ok) { calm += dt; if (!on && calm >= hold) { on = true; since = 0; } } else { calm = 0; if (on) { since += dt; if (pressure > 0 || emaMs >= (budgetMs || 50) * 0.75 || since >= drop) on = false; } }
        if (on && !ok && since < drop) { /* brief blip: keep */ }
        return on;
      }, get on() { return on; }, get calm() { return calm; },
    };
  }

  /* ───── probe cascade ───── */
  function createCascade(P, L, sp, ly) {
    return { P, L, sp, ly, M: P - 1, data: new Float32Array(P * P * L * 16), si: new Int32Array(P * P).fill(0x7fffffff), sj: new Int32Array(P * P).fill(0x7fffffff), ci: 0, cj: 0, cursor: 0, ver: 0, fresh: [], updates: 0 };
  }
  function neutralProbe(d, o) { d.fill(0, o, o + 16); d[o] = 1 / Y0; }   // open sky: V = 1 everywhere -> c0 = 1/Y0 ... (sqrt(4 pi) = 1/Y0), bounce 0
  // Trace one probe: rays dirs, hits -> bounce radiance, escapes -> visibility.  S: {hf, sun:[x,y,z], sunI:[r,g,b], skyI:[r,g,b], albedo:[r,g,b], maxD, mSteps, sunSteps, lamps, lampK}
  const _n = [0, 1, 0], _d = new Float32Array(16 * 3 + 3);
  function traceProbe(c, o, px, py, pz, nRays, S, R) {
    const hf = S.hf, est = traceProbe._e || (traceProbe._e = new Float64Array(16)); est.fill(0);
    rayDirs(nRays, R(), R() * 6.2831853, _d); const w = 4 * PI / nRays, al = S.albedo;
    for (let i = 0; i < nRays; i++) {
      const dx = _d[i * 3], dy = _d[i * 3 + 1], dz = _d[i * 3 + 2];
      const t = march(hf, px, py, pz, dx, dy, dz, S.maxD, S.mSteps, hf.cell * 0.7);
      if (t < 0) { shProject(est, 0, dx, dy, dz, 1, w); continue; }   // escaped: sky is visible that way
      const hx = px + dx * t, hz = pz + dz * t, hy = py + dy * t; hf.normal(hx, hz, _n);
      const cs = _n[0] * S.sun[0] + _n[1] * S.sun[1] + _n[2] * S.sun[2];
      let dir = 0; if (cs > 0 && S.sunI[3] > 0) dir = cs * sunVis(hf, hx, hy + hf.cell * 0.3, hz, S.sun[0], S.sun[1], S.sun[2], S.sunSteps >> 1 || 4, S.maxD * 0.5, 0.05, 0);
      const sk = 0.5 + 0.5 * _n[1], k = 1 / PI;
      for (let ch = 0; ch < 3; ch++) shProject(est, 4 + ch * 4, dx, dy, dz, al[ch] * (S.sunI[ch] * dir + S.skyI[ch] * sk) * k, w);
    }
    if (S.lamps && S.lampK > 0.001) {   // lamps: analytic point sources, occluded by the same field
      const ls = S.lamps; for (let l = 0; l < ls.length; l += 7) {
        const dx = ls[l] - px, dy = ls[l + 1] - py, dz = ls[l + 2] - pz, d2 = dx * dx + dy * dy + dz * dz, r = ls[l + 6]; if (d2 > r * r) continue;
        const d = Math.sqrt(d2), inv = 1 / d; if (sunVis(hf, px, py + 0.2, pz, dx * inv, dy * inv, dz * inv, 5, d, 0.04, 0) < 0.3 && marchHit(hf, px, py, pz, dx * inv, dy * inv, dz * inv, d)) continue;
        const e = S.lampK * (1 - d / r) * (1 - d / r) / (d2 + 1) * 1.33;
        for (let ch = 0; ch < 3; ch++) shProject(est, 4 + ch * 4, dx * inv, dy * inv, dz * inv, ls[l + 3 + ch] * e, 1);
      }
    }
    const a = 1 - Math.pow(1 - 1 / 16, nRays), d = c.data;   // EMA: each ray carries 1/16 of the weight
    for (let k = 0; k < 16; k++) d[o + k] += (est[k] - d[o + k]) * a;
  }
  function marchHit(hf, ox, oy, oz, dx, dy, dz, maxD) { return march(hf, ox, oy, oz, dx, dy, dz, maxD * 0.97, 6, hf.cell * 0.7) >= 0; }

  // window of a cascade follows the camera; slots whose stamp is stale are reset and queued first.  Returns the number of probes traced within the ms budget.
  function updateCascade(c, hf, camx, camz, S, nRays, msBudget, maxProbes, R) {
    const ci = Math.round(camx / c.sp), cj = Math.round(camz / c.sp), h = c.P >> 1, i0 = ci - h, j0 = cj - h, P = c.P, M = c.M;
    c.ci = ci; c.cj = cj; const L = c.L, tot = P * P * L, t0 = now(); let n = 0, k = c.cursor, scanned = 0;
    // 1) columns that entered the window: reset to neutral, trace once at full rate
    for (let jj = 0; jj < P; jj++) for (let ii = 0; ii < P; ii++) {
      const i = i0 + ii, j = j0 + jj, col = (i & M) + (j & M) * P;
      if (c.si[col] !== i || c.sj[col] !== j) { c.si[col] = i; c.sj[col] = j; for (let l = 0; l < L; l++) neutralProbe(c.data, (col * L + l) * 16); c.fresh.push(col); }
    }
    while (c.fresh.length && n < maxProbes) {   // fresh columns first: ALL layers, so the camera never sits in an unlit hole
      const col = c.fresh[c.fresh.length - 1]; const i = c.si[col], j = c.sj[col];
      for (let l = 0; l < L; l++) { const o = (col * L + l) * 16; traceProbe(c, o, i * c.sp, hf.h(i * c.sp, j * c.sp) + (l + 0.5) * c.ly, j * c.sp, Math.max(nRays, 8), S, R); n++; }
      c.fresh.pop(); if (now() - t0 > msBudget * 1.5) break;
    }
    while (n < maxProbes && scanned < tot) {
      const l = k % L, col0 = (k / L) | 0, ii = col0 % P, jj = (col0 / P) | 0, i = i0 + ii, j = j0 + jj, col = (i & M) + (j & M) * P;
      const o = (col * L + l) * 16; traceProbe(c, o, i * c.sp, hf.h(i * c.sp, j * c.sp) + (l + 0.5) * c.ly, j * c.sp, nRays, S, R);
      n++; scanned++; k = (k + 1) % tot; if ((n & 3) === 0 && now() - t0 > msBudget) break;
    }
    c.cursor = k; if (n) { c.ver++; c.updates += n; } return n;
  }
  // read one probe-volume value at world (x,y,z): trilinear over the 8 probes (same math the shader does with hardware filtering)
  function sampleCascade(c, hf, x, y, z, outE, nx, ny, nz) {
    const fx = x / c.sp, fz = z / c.sp, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, g = hf.h(x, z), fl = (y - g) / c.ly - 0.5, l0 = Math.max(0, Math.min(c.L - 1, Math.floor(fl))), l1 = Math.min(c.L - 1, l0 + 1), tl = Math.max(0, Math.min(1, fl - l0)), M = c.M, L = c.L;
    outE[0] = outE[1] = outE[2] = outE[3] = 0;
    for (let a = 0; a < 8; a++) {
      const di = a & 1, dj = (a >> 1) & 1, dl = (a >> 2) & 1, w = (di ? tx : 1 - tx) * (dj ? tz : 1 - tz) * (dl ? tl : 1 - tl); if (w <= 0) continue;
      const o = ((((i + di) & M) + ((j + dj) & M) * c.P) * L + (dl ? l1 : l0)) * 16;
      outE[0] += w * shEval(c.data, o + 4, nx, ny, nz); outE[1] += w * shEval(c.data, o + 8, nx, ny, nz); outE[2] += w * shEval(c.data, o + 12, nx, ny, nz); outE[3] += w * shEval(c.data, o, nx, ny, nz);
    }
    return outE;   // [bounce r, g, b, sky visibility]
  }

  const core = { capTier, FAR_CELL, NEAR_MAX, FAR_MAX, sunVisLong, rasterizeOverlay, hash1, csRayDirs, stepDownTier, bootTier, Y0, Y1, shProject, shEval, bentNormal, rng, rayDirs, createHF, overlayAt, march, marchBrute, sunVis, sunVisBrute, TIERS, TIER_ORDER, effective, cost, pickTier, createHeadroom, createCascade, neutralProbe, traceProbe, updateCascade, sampleCascade };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;

  /* ───────────────────────── browser glue ───────────────────────── */
  const W = root, Q = (W.location && W.location.search) || '';
  const flag = ((Q.match(/[?&]light=(off|low|med|high|ultra|auto)\b/) || [])[1]) || 'auto';
  const csQ = (Q.match(/[?&]lightcs=(0|1)\b/) || [])[1];   // 0 = never, 1 = force (still needs ultra tier), default = automatic on ultra with headroom
  const gainQ = +((Q.match(/[?&]lightgain=([\d.]+)/) || [])[1] || 1);
  const LSK = 'dm_light_boot', LSC = 'dm_light_cs_bad';
  const lsGet = (k) => { try { return JSON.parse(W.localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { if (v == null) W.localStorage.removeItem(k); else W.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
  const D = {
    on: flag !== 'off', core, tier: 'off', flag, lvl: 0, eff: effective('off', 0, false), ready: false, failed: '', built: null, ticks: 0, probesPerSec: 0,
    msEma: 0, lamps: new Float32Array(0), lampK: 0, lampN: 0, hr: createHeadroom({ hold: 8 }), cs: false, csOk: null, csBad: '', csFrames: 0, upT: 0, uploads: 0, bytes: 0, mats: 0, overlays: 0, boot: null,
  };
  W.DMLight = D;
  const Rn = rng(12345);
  const sunV = [0.4, 0.8, 0.45], sunI = [0, 0, 0, 0], skyI = [0.5, 0.55, 0.65], albedo = [0.34, 0.30, 0.25];
  let hf = null, hf2 = null, casc = [], U = null, tex = null, CS = null, THREE_ = null, baseY = 0, lastH = null, hemiCache = null, lastFarC = [1e9, 1e9], farUpT = 0;

  function pickNow() {
    const g = W.GFX || {}; let t = pickTier(g, flag === 'auto' ? null : flag);
    const mark = lsGet(LSK) || {}; D.boot = { mark, want: t };
    if (flag === 'auto') {   // a boot that died during compile caps the tier (10 healthy boots lift the cap)
      if (mark.pend) { mark.cap = stepDownTier(mark.tier || t); mark.ok = 0; }
      t = capTier(t, mark.cap);
    }
    if (t !== 'off') lsSet(LSK, { pend: true, tier: t, cap: mark.cap || null, ok: mark.ok || 0, t: Date.now() });
    D.boot.tier = t; return t;
  }
  function bootHealthy() {
    const m = lsGet(LSK); if (!m) return; const ok = (m.ok || 0) + 1; lsSet(LSK, { pend: false, tier: m.tier, cap: ok >= 10 ? null : (m.cap || null), ok: ok >= 10 ? 0 : ok, t: Date.now() });
  }
  try { W.addEventListener('pagehide', () => { if (D.ticks > 30) bootHealthy(); }); } catch (e) { }
  function sceneLights(scene) {
    if (hemiCache) return hemiCache; const o = { hemi: null }; try { scene.traverse(x => { if (x.isHemisphereLight && !o.hemi && !(x.userData && (x.userData.btStandIn || x.userData.bti))) o.hemi = x; }); } catch (e) { } return (hemiCache = o);
  }

  function build() {   // allocate the caches for the tier (once; a tier change only happens at boot / on an explicit flag)
    const e = TIERS[D.tier]; if (!e || !e.rays) return false;
    hf = createHF(e.hfN, e.hfN >= 256 ? 1.5 : 2); casc = [];
    if (e.farN) hf2 = createHF(e.farN, FAR_CELL);
    const sp = [3, 12], ly = [2.5, 6]; for (let c = 0; c < e.casc; c++) casc.push(createCascade(e.P, e.L, sp[c], ly[c]));
    if (D._pend) { for (const o of D._pend) { hf.addOverlay(o); if (hf2) hf2.addOverlay(o); } D._pend = null; }
    D.bytes = hf.data.byteLength + (hf2 ? hf2.data.byteLength : 0) + casc.reduce((s, c) => s + c.data.byteLength, 0) + e.hfN * e.hfN * 2 + (e.farN ? e.farN * e.farN * 2 : 0) + casc.length * e.P * e.P * e.L * 8 * 4 + (e.cs ? e.P * e.P * e.L * 8 * 8 : 0);
    D.built = { tier: D.tier, hfN: e.hfN, cell: hf.cell, farN: e.farN, casc: casc.map(c => ({ P: c.P, L: c.L, sp: c.sp, ly: c.ly })) };
    return true;
  }

  // GPU resources (lazy: the first material that asks).  Fixed graph per tier; every live number is a uniform.
  function initGpu(THREE, T) {
    if (U) return true; if (!hf) return false; THREE_ = THREE; const Tt = THREE;
    if (!Tt.Data3DTexture || !Tt.DataTexture || !T.texture3D || !T.uniform) return false;
    const e = TIERS[D.tier], mk2 = (n) => { const t = new Tt.DataTexture(new Uint16Array(n * n), n, n, Tt.RedFormat, Tt.HalfFloatType); t.wrapS = t.wrapT = Tt.RepeatWrapping; t.minFilter = t.magFilter = Tt.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; };
    const hft = mk2(hf.N), hft2 = hf2 ? mk2(hf2.N) : null;
    const vols = casc.map(c => [0, 1, 2, 3].map(() => { const t = new Tt.Data3DTexture(new Uint16Array(c.P * c.P * c.L * 4), c.P, c.P, c.L); t.format = Tt.RGBAFormat; t.type = Tt.HalfFloatType; t.wrapS = t.wrapT = Tt.RepeatWrapping; t.wrapR = Tt.ClampToEdgeWrapping; t.minFilter = t.magFilter = Tt.LinearFilter; t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true; return t; }));
    tex = { hft, hft2, vols };
    U = {
      k: T.uniform(0), base: T.uniform(0), cam: T.uniform(new Tt.Vector2(0, 0)), sun: T.uniform(new Tt.Vector3(0.4, 0.8, 0.45)), hfSteps: T.uniform(e.sunSteps), farSteps: T.uniform(e.farSteps), hfK: T.uniform(0.5), gain: T.uniform(gainQ * 0.9),
      pen: T.uniform(0.05), penF: T.uniform(0.09), csK: T.uniform(0), lowSun: T.uniform(0),
    };
    // compute tier resources: storage volumes for cascade 0 (A = current, sampled by the materials; B = scratch), built only on tiers that allow it
    try { const rr = getRenderer(); if (e.cs && csQ !== '0' && rr && rr.backend && rr.backend.isWebGPUBackend && Tt.Storage3DTexture && T.textureStore && T.instancedArray && !(lsGet(LSC) && Date.now() - lsGet(LSC).t < 7 * 864e5)) CS = makeCsResources(Tt, T); } catch (err) { CS = null; csFail('resources: ' + (err && err.message || err)); }
    for (let c = 0; c < casc.length; c++) upload(c, true);
    uploadHF(true); if (hf2) uploadHF2();
    return true;
  }
  const H16 = (v) => (THREE_.DataUtils ? THREE_.DataUtils.toHalfFloat(v) : 0);
  function uploadHF(force) {
    if (!tex) return; const N = hf.N, d = tex.hft.image.data; baseY = Math.round(lastH == null ? 0 : lastH / 32) * 32; U.base.value = baseY;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const idx = j * N + i, v = hf.si[idx] === 0x7fffffff ? -300 : hf.data[idx] - baseY; d[idx] = H16(v < -500 ? -500 : v > 500 ? 500 : v); }
    tex.hft.needsUpdate = true; D.uploads++; D.hfVer = hf.ver;   // slot (i&M, j&M) IS texel (i&M, j&M): toroidal layout = RepeatWrapping with uv = (x/cell + 0.5)/N
  }
  function uploadHF2() {
    if (!tex || !tex.hft2) return; const N = hf2.N, d = tex.hft2.image.data;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const idx = j * N + i, v = hf2.si[idx] === 0x7fffffff ? -1500 : hf2.data[idx] - baseY; d[idx] = H16(v < -2000 ? -2000 : v > 2000 ? 2000 : v); }
    tex.hft2.needsUpdate = true; D.uploads++; D.hf2Ver = hf2.ver;
  }
  function upload(ci, force) {
    const c = casc[ci], vols = tex.vols[ci], n = c.P * c.P * c.L; if (!force && c.upVer === c.ver) return; c.upVer = c.ver;
    const dv = vols[0].image.data, dr = vols[1].image.data, dg = vols[2].image.data, db = vols[3].image.data, s = c.data;
    const P2 = c.P * c.P, L = c.L;   // CPU order is (column, layer); the 3D texture is layer-major (z slices of P x P)
    for (let p = 0; p < n; p++) { const col = (p / L) | 0, l = p - col * L, o = p * 16, q = (l * P2 + col) * 4; for (let k = 0; k < 4; k++) { dv[q + k] = H16(s[o + k]); dr[q + k] = H16(s[o + 4 + k]); dg[q + k] = H16(s[o + 8 + k]); db[q + k] = H16(s[o + 12 + k]); } }
    for (const t of vols) t.needsUpdate = true; D.uploads++;
  }

  /* ───── compute ray-march tier (WebGPU): few rays per probe per frame, accumulated into persistent storage volumes (cascade 0), blended with the CPU cache.  Any failure
     (no storage 3D textures, compile / dispatch error, a canary read-back that is not finite) disables ONLY this tier: csK eases to 0, dispatch stops, materials keep the CPU cache. ───── */
  function csFail(why) { D.csBad = why; D.csOk = false; D.cs = false; try { console.warn('[light] compute tier off:', why); } catch (e) { } lsSet(LSC, { t: Date.now(), why: String(why).slice(0, 120) }); try { if (W.DMCrumb && W.DMCrumb.mark) W.DMCrumb.mark('lightcs', 'off'); } catch (e) { } }
  function makeCsResources(THREE, T) {
    const c0 = casc[0], P = c0.P, L = c0.L, mkS = () => { const t = new THREE.Storage3DTexture(P, P, L); t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType; t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.wrapR = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; return t; };
    const A = [mkS(), mkS(), mkS(), mkS()], B = [mkS(), mkS(), mkS(), mkS()], canary = T.instancedArray(4, 'float');
    const C = { A, B, canary, P, L, ok: false, kStep: null, kCopy: null, i0p: 0, j0p: 0, first: true, frame: 0, checkT: 0, tries: 0, U: null };
    return C;
  }
  function buildCsKernels(T) {
    const { Fn, If, Loop, Break, float, vec2, vec3, vec4, uniform, texture, texture3D, textureStore, uvec3, instanceIndex, max, min, clamp, dot, normalize, mix, sqrt, sin, cos, floor, fract, abs, select } = T;
    const THREEv = THREE_, C = CS, c0 = casc[0], P = C.P, L = C.L, P2 = P * P, cell = hf.cell, N = hf.N;
    const CU = C.U = { i0: uniform(0), j0: uniform(0), i0p: uniform(0), j0p: uniform(0), first: uniform(1), n: uniform(4), frame: uniform(0), a: uniform(0.23), ms: uniform(8), maxD: uniform(c0.sp * 12), base: U.base, sun: U.sun,
      sunI: uniform(new THREEv.Vector3()), skyI: uniform(new THREEv.Vector3()), alb: uniform(new THREEv.Vector3(...albedo)), sunOn: uniform(0) };
    const hH = (x, z) => texture(tex.hft, vec2(x, z).div(cell).add(0.5).div(N)).level(0).r.add(CU.base);
    const hash = (x) => fract(sin(x).mul(43758.5453));
    const fm = (a, m) => a.sub(floor(a.div(m)).mul(m));
    const GOLDn = 2.399963229728653, PIn = Math.PI;
    const coef = (d) => vec4(Y0, d.x.mul(Y1), d.y.mul(Y1), d.z.mul(Y1));
    const slot = () => { const id = float(instanceIndex), l = floor(id.div(P2)), col = id.sub(l.mul(P2)), sy = floor(col.div(P)), sx = col.sub(sy.mul(P)); return { id, l, sx, sy }; };
    const uvwOf = (s) => vec3(s.sx.add(0.5).div(P), s.sy.add(0.5).div(P), s.l.add(0.5).div(L));
    const store = (tx, s, v) => textureStore(tx, uvec3(s.sx.toUint(), s.sy.toUint(), s.l.toUint()), v).toWriteOnly();
    C.kStep = Fn(() => {
      const s = slot(), i = CU.i0.add(fm(s.sx.sub(CU.i0), P)), j = CU.j0.add(fm(s.sy.sub(CU.j0), P)), ip = CU.i0p.add(fm(s.sx.sub(CU.i0p), P)), jp = CU.j0p.add(fm(s.sy.sub(CU.j0p), P));
      const stale = CU.first.greaterThan(0.5).or(i.notEqual(ip)).or(j.notEqual(jp));
      const x = i.mul(c0.sp), z = j.mul(c0.sp), py = hH(x, z).add(s.l.add(0.5).mul(c0.ly)), P3 = vec3(x, py, z);
      const uvw = uvwOf(s), pv = texture3D(C.A[0], uvw, 0), pr = texture3D(C.A[1], uvw, 0), pg = texture3D(C.A[2], uvw, 0), pb = texture3D(C.A[3], uvw, 0);
      const eV = vec4(0, 0, 0, 0).toVar(), eR = vec4(0, 0, 0, 0).toVar(), eG = vec4(0, 0, 0, 0).toVar(), eB = vec4(0, 0, 0, 0).toVar();
      const u = hash(s.id.mul(12.9898).add(CU.frame.mul(78.233))), yaw = hash(s.id.mul(39.346).add(CU.frame.mul(11.135))).mul(6.2831853);
      Loop(16, ({ i: r }) => {
        const ri = float(r); If(ri.greaterThan(CU.n.sub(0.5)), () => { Break(); });
        const zc = float(1).sub(ri.add(u).mul(2.0).div(CU.n)), rr = sqrt(max(float(0), float(1).sub(zc.mul(zc)))), ang = ri.add(u).mul(GOLDn).add(yaw), d = vec3(rr.mul(cos(ang)), zc, rr.mul(sin(ang)));
        const hitT = float(-1).toVar(), t0 = cell * 0.7;
        Loop(12, ({ i: st }) => {
          const fs = float(st).add(1.0); If(fs.greaterThan(CU.ms), () => { Break(); });
          const f = fs.div(CU.ms), t = float(t0).add(CU.maxD.sub(t0).mul(f).mul(f)), q = P3.add(d.mul(t));
          If(q.y.lessThan(hH(q.x, q.z)), () => { hitT.assign(t); Break(); });
        });
        If(hitT.lessThan(0.0), () => { eV.addAssign(coef(d)); }).Else(() => {
          const h = P3.add(d.mul(hitT)), e = float(cell), hx = hH(h.x.add(e), h.z).sub(hH(h.x.sub(e), h.z)), hz = hH(h.x, h.z.add(e)).sub(hH(h.x, h.z.sub(e))), n = normalize(vec3(hx.negate(), e.mul(2.0), hz.negate()));
          const cs = dot(n, CU.sun), dirv = float(0).toVar();
          If(cs.greaterThan(0.0).and(CU.sunOn.greaterThan(0.5)), () => {
            const o2 = h.add(vec3(0, cell * 0.3, 0)), vis = float(1).toVar();
            for (let k = 1; k <= 4; k++) { const t = (cell * 0.6) + (CU.maxD.mul(0.5)).mul(k * k / 16.0), q = o2.add(CU.sun.mul(t)); vis.assign(min(vis, clamp(q.y.sub(hH(q.x, q.z)).div(float(0.05).mul(t).add(1e-3)).mul(0.5).add(0.5), 0.0, 1.0))); }
            dirv.assign(cs.mul(vis));
          });
          const sk = n.y.mul(0.5).add(0.5), rad = CU.alb.mul(CU.sunI.mul(dirv).add(CU.skyI.mul(sk))).div(PIn), cf = coef(d);
          eR.addAssign(cf.mul(rad.x)); eG.addAssign(cf.mul(rad.y)); eB.addAssign(cf.mul(rad.z));
        });
      });
      const w = float(4 * PIn).div(CU.n), aE = select(stale, float(0.5), CU.a), neutral = vec4(1 / Y0, 0, 0, 0), zero = vec4(0, 0, 0, 0);
      const nV = mix(select(stale, neutral, pv), eV.mul(w), aE), nR = mix(select(stale, zero, pr), eR.mul(w), aE), nG = mix(select(stale, zero, pg), eG.mul(w), aE), nB = mix(select(stale, zero, pb), eB.mul(w), aE);
      store(C.B[0], s, nV); store(C.B[1], s, nR); store(C.B[2], s, nG); store(C.B[3], s, nB);
      If(instanceIndex.equal(0), () => { C.canary.element(0).assign(nV.x); C.canary.element(1).assign(nR.x.add(nG.x).add(nB.x)); });
    })().compute(P2 * L, [64]);
    C.kCopy = Fn(() => {
      const s = slot(), uvw = uvwOf(s);
      store(C.A[0], s, texture3D(C.B[0], uvw, 0)); store(C.A[1], s, texture3D(C.B[1], uvw, 0)); store(C.A[2], s, texture3D(C.B[2], uvw, 0)); store(C.A[3], s, texture3D(C.B[3], uvw, 0));
    })().compute(P2 * L, [64]);
    C.ok = true;
  }
  // one dispatch (kStep then kCopy); returns true when issued
  function csDispatch(renderer, e, o) {
    if (!CS || D.csBad || !renderer || !U) return false;
    try {
      const T = THREE_.TSL; if (!CS.ok) buildCsKernels(T);
      const C = CS, CU = C.U, c0 = casc[0], i0 = c0.ci - (c0.P >> 1), j0 = c0.cj - (c0.P >> 1);
      CU.i0.value = i0; CU.j0.value = j0; CU.i0p.value = C.first ? i0 : C.i0p; CU.j0p.value = C.first ? j0 : C.j0p; CU.first.value = C.first ? 1 : 0; CU.n.value = 4; CU.frame.value = (C.frame++) % 4096; CU.a.value = 1 - Math.pow(15 / 16, 4);
      CU.ms.value = Math.min(12, e.mSteps); CU.sunI.value.set(sunI[0], sunI[1], sunI[2]); CU.skyI.value.set(skyI[0], skyI[1], skyI[2]); CU.alb.value.set(albedo[0], albedo[1], albedo[2]); CU.sunOn.value = sunI[3] > 0 && sunV[1] > 0.02 ? 1 : 0;
      renderer.compute(C.kStep); renderer.compute(C.kCopy); C.i0p = i0; C.j0p = j0; C.first = false; D.csFrames++;
      if (D.csOk == null && !C.checking && D.csFrames > 20) { C.checking = true; setTimeout(() => csCheck(renderer), 1200); }
      return true;
    } catch (err) { csFail('dispatch: ' + (err && err.message || err)); return false; }
  }
  async function csCheck(renderer) {   // canary: the kernel writes probe 0's coefficients to a storage buffer; a never-run / failed shader leaves 0 / NaN
    const C = CS; try {
      const buf = await renderer.getArrayBufferAsync(C.canary.value), f = new Float32Array(buf), v = f[0], b = f[1];
      if (Number.isFinite(v) && Number.isFinite(b) && Math.abs(v) > 1e-4 && Math.abs(v) < 1e4) { D.csOk = true; C.checking = false; try { console.log('[light] compute tier verified', v.toFixed(3), b.toFixed(3)); } catch (e) { } }
      else if (++C.tries < 3) { C.checking = false; D.csFrames = 0; }   // retry after more frames
      else csFail('canary ' + v + ',' + b);
    } catch (err) { csFail('canary read: ' + (err && err.message || err)); }
  }

  const getRenderer = () => W.flightRenderer || (typeof flightRenderer !== 'undefined' ? flightRenderer : null);   // (the host's top-level `let` is visible to classic scripts)
  function lightParams() {
    const sun = W.TERRAIN && W.TERRAIN.sun;
    if (sun && sun.color) { const k = sun.intensity == null ? 1 : sun.intensity; sunI[0] = sun.color.r * k; sunI[1] = sun.color.g * k; sunI[2] = sun.color.b * k; sunI[3] = 1; } else { sunI[0] = sunI[1] = sunI[2] = 0; sunI[3] = 0; }
  }

  // per-frame: called from the surface tick.  o: {x,y,z, H (height fn), sunDir (Vector3), day (0..1), scene, renderer, walk}
  D.tick = function (dt, o) {
    if (!D.on || !o || o.walk === false) return; D.ticks++;
    const B = W.DMBudget, lvl = B && B.on ? B.lvl('light') : 0;
    if (D.tier === 'off' && D.ticks === 1) {
      D.tier = pickNow(); if (!TIERS[D.tier].rays) { D.on = false; return; }
      if (!build()) { D.on = false; return; } D.ready = true;
    }
    if (!D.ready) return;
    if (D.ticks === 240) bootHealthy();
    const st = B && B.on ? B.stats() : null; D.hr.step(dt, B && B.on ? (B.p | 0) : 0, st ? st.emaMs : 0, 50);
    const e = D.eff = effective(D.tier, lvl, D.hr.on); D.lvl = lvl;
    D.cs = !!(e.cs && CS && !D.csBad && csQ !== '0' && (D.csOk !== false));
    lastH = o.y; hf.sampler = o.H; hf.setCenter(o.x, o.z);
    const t0 = now();
    const hfMs = D.tier === 'low' ? 0.3 : 0.5; hf.fill(hf.N * hf.N, 4096, hfMs);
    if (hf2 && (e.farSteps > 0)) {   // coarse field: only when the window moved by >= 4 cells or is still filling
      hf2.sampler = o.H; if (Math.abs(o.x - lastFarC[0]) > FAR_CELL * 4 || Math.abs(o.z - lastFarC[1]) > FAR_CELL * 4) { hf2.setCenter(o.x, o.z); lastFarC[0] = o.x; lastFarC[1] = o.z; hf2.cursor = 0; }
      hf2.fill(hf2.N * hf2.N, 2048, 0.3);
    }
    const sd = o.sunDir; if (sd) { sunV[0] = sd.x; sunV[1] = sd.y; sunV[2] = sd.z; }
    lightParams(); const day = o.day == null ? 1 : o.day;
    const hm = sceneLights(o.scene || (W.PW && W.PW.scene)).hemi; if (hm && hm.color) { const k = hm.intensity == null ? 1 : hm.intensity; skyI[0] = hm.color.r * k; skyI[1] = hm.color.g * k; skyI[2] = hm.color.b * k; }
    if (!e.freeze && e.ms > 0) {
      const Sx = D._S || (D._S = { hf, sun: sunV, sunI, skyI, albedo, maxD: 40, mSteps: 8, sunSteps: 8, lamps: null, lampK: 0 });
      Sx.hf = hf; Sx.mSteps = e.mSteps; Sx.sunSteps = e.sunSteps; Sx.lamps = D.lampN ? D.lamps : null; Sx.lampK = D.lampK;
      let n = 0;
      for (let c = 0; c < casc.length && c < e.casc; c++) {
        const cc = casc[c]; if (c > 0 && (D.ticks & 3) !== 0) continue;
        Sx.maxD = cc.sp * 12; const left = e.ms - (now() - t0); if (left <= 0.05) break;
        n += updateCascade(cc, hf, o.x, o.z, Sx, e.rays, left * (c === 0 ? 0.8 : 1), c === 0 ? 160 : 60, Rn);
      }
      D.probesPerSec += (n / Math.max(dt, 1e-3) - D.probesPerSec) * 0.05;
    }
    // compute tier: 1 dispatch per frame while it is open (headroom, level 0, verified); eased in / out through csK
    let csTarget = 0;
    if (D.cs && U && casc[0]) { if (csDispatch(o.renderer || getRenderer(), e, o)) csTarget = D.csOk ? 0.55 : 0; }
    const ms = now() - t0; D.msEma += (ms - D.msEma) * 0.05;
    if (U) {
      U.cam.value.set(o.x, o.z); U.sun.value.set(sunV[0], sunV[1], sunV[2]); U.hfSteps.value = e.sunSteps; U.farSteps.value = e.farSteps;
      const cad = W.DMBudget && W.DMBudget.on ? W.DMBudget.shadowEvery() : 1; U.hfK.value = (cad > 1 ? 0.8 : 0.5) * (day > 0.05 ? 1 : 0);
      U.lowSun.value = 1 - Math.min(1, Math.max(0, sunV[1] * 2.2));
      U.k.value += (1 - U.k.value) * Math.min(1, dt * 2); U.csK.value += (csTarget - U.csK.value) * Math.min(1, dt * (csTarget > U.csK.value ? 0.8 : 3));
      const t = now(); if (t - D.upT > 160) { D.upT = t; for (let c = 0; c < casc.length; c++) upload(c, false); if (hf.ver !== D.hfVer) uploadHF(false); }
      if (hf2 && t - farUpT > 1200 && hf2.ver !== D.hf2Ver) { farUpT = t; uploadHF2(); }
    }
  };

  // lamps: flat array [x,y,z, r,g,b, radius] * n (world frame); level 0..1 (dusk fade * on/off), eased by the caller
  D.setLamps = function (arr) { D.lamps = arr instanceof Float32Array ? arr : new Float32Array(arr); D.lampN = (D.lamps.length / 7) | 0; };
  D.setLampLevel = function (k) { D.lampK = k < 0 ? 0 : k > 1 ? 1 : k; };
  D.addOverlay = function (o) { D.overlays++; if (hf) { hf.addOverlay(o); if (hf2) hf2.addOverlay(o); } else (D._pend || (D._pend = [])).push(o); };
  D.clearOverlays = function () { D._pend = null; D.overlays = 0; for (const h of [hf, hf2]) if (h && h.overlays.length) { h.overlays.length = 0; h.si.fill(0x7fffffff); h.cursor = 0; h.ver++; } };
  // stamp a rotated local height grid (the mansion collision grid) into the caches: o {g, nx, ny, x0, y0, cell, fwd, inv, floor, wcell}
  D.stampGrid = function (o) {
    try { const ov = rasterizeOverlay(o.g, o.nx, o.ny, o.x0, o.y0, o.cell, o.fwd, o.inv, o.wcell || 2, o.floor == null ? 0 : o.floor); D.addOverlay(ov); return ov.nx * ov.nz; } catch (e) { return 0; }
  };

  function ensure() {   // pick the tier and allocate the caches on first use (a material or the tick, whichever comes first)
    if (D.ready) return true; if (!D.on) return false;
    if (D.tier === 'off' && D.ticks === 0) { D.tier = pickNow(); if (!TIERS[D.tier].rays) { D.on = false; return false; } if (!build()) { D.on = false; return false; } D.ready = true; }
    return D.ready;
  }
  // ── TSL helpers shared by materials / water ──
  function sunVisNodes(T, p) {   // contact-hardening near march + coarse long-range march of the height caches -> float node (1 = lit); p: world position node
    const { float, vec2, texture, min, clamp, mix, If } = T, N = hf.N, cell = hf.cell, e = TIERS[D.tier];
    const hH = (x, z) => texture(tex.hft, vec2(x, z).div(cell).add(0.5).div(N)).level(0).r.add(U.base);
    const vs = float(1).toVar(), L = U.sun, t0 = cell * 0.6;
    for (let i = 1; i <= e.sunSteps; i++) {
      const f = i / e.sunSteps, t = t0 + (NEAR_MAX - t0) * f * f;
      If(U.hfSteps.greaterThan(i - 0.5), () => { const q = p.add(L.mul(t)), dh = q.y.sub(hH(q.x, q.z)).add(0.15); vs.assign(min(vs, clamp(dh.div(U.pen.mul(t).add(1e-3)).mul(0.5).add(0.5), 0.0, 1.0))); });
    }
    if (tex.hft2 && e.farSteps > 0) {
      const N2 = hf2.N, hF = (x, z) => texture(tex.hft2, vec2(x, z).div(FAR_CELL).add(0.5).div(N2)).level(0).r.add(U.base);
      for (let i = 1; i <= e.farSteps; i++) {
        const f = i / e.farSteps, t = NEAR_MAX + (FAR_MAX - NEAR_MAX) * Math.pow(f, 1.5);
        If(U.farSteps.greaterThan(i - 0.5), () => { const q = p.add(L.mul(t)), dh = q.y.sub(hF(q.x, q.z)).add(0.5); vs.assign(min(vs, clamp(dh.div(U.penF.mul(t).add(1e-3)).mul(0.5).add(0.5), 0.0, 1.0))); });
      }
    }
    return { vs, hH };
  }
  // node for other shaders (the sea): sun visibility 0..1 at a world position, blended by the same strength uniforms; null when DMLight cannot serve it
  D.sunVisNode = function (p) {
    try {
      if (!D.on || !ensure()) return null; const THREE = W.THREE, T = THREE && THREE.TSL; if (!THREE || !T || !initGpu(THREE, T)) return null;
      const { mix, float } = T, sn = sunVisNodes(T, p); return mix(float(1), sn.vs, U.hfK.mul(U.k));
    } catch (err) { D.failed = String(err && err.message || err); return null; }
  };

  // material hook.  o: { p (world position node), n (world normal node), h (0..1 relief height node, 1 = proud), bounce, ao, shadow (all default true) }
  D.applyMaterial = function (m, o) {
    try {
      if (!D.on || !m || !m.isNodeMaterial || (m.userData && m.userData.dmLight)) return false;
      if (!ensure()) return false;
      const THREE = W.THREE, T = THREE && THREE.TSL; if (!THREE || !T || !initGpu(THREE, T)) return false;
      o = o || {};
      const { float, vec2, vec3, texture, texture3D, max, clamp, dot, normalize, mix, abs, smoothstep, If } = T;
      const p = o.p || T.positionWorld;
      // the BUMPED normal (parallax / ground atlas / normal maps already wrote m.normalNode in view space) so relief bends the indirect light too
      const n = o.n || (m.normalNode && T.transformDirection && T.cameraWorldMatrix ? normalize(T.transformDirection(m.normalNode, T.cameraWorldMatrix)) : T.normalWorld);
      const N = hf.N, cell = hf.cell, hH = (x, z) => texture(tex.hft, vec2(x, z).div(cell).add(0.5).div(N)).level(0).r.add(U.base), g0 = hH(p.x, p.z);
      const useCs = !!(CS && CS.A && casc.length), lookups = [];
      for (let c = 0; c < casc.length; c++) {
        const cc = casc[c], vols = tex.vols[c], uv = vec2(p.x, p.z).div(cc.sp).add(0.5).div(cc.P), lz = clamp(p.y.sub(g0).div(cc.ly * cc.L), 0.5 / cc.L, 1 - 0.5 / cc.L), uvw = vec3(uv.x, uv.y, lz);
        const ev = (s) => s.x.mul(Y0).add(dot(vec3(s.y, s.z, s.w), n).mul((2 / 3) * Y1));
        const sv = texture3D(vols[0], uvw, 0), sr = texture3D(vols[1], uvw, 0), sg = texture3D(vols[2], uvw, 0), sb = texture3D(vols[3], uvw, 0);
        let vis = ev(sv), bounce = vec3(ev(sr), ev(sg), ev(sb));
        if (c === 0 && useCs) {   // compute-refined near cascade: blended in by csK (0 = CPU cache only)
          const cv = texture3D(CS.A[0], uvw, 0), cr = texture3D(CS.A[1], uvw, 0), cg = texture3D(CS.A[2], uvw, 0), cb = texture3D(CS.A[3], uvw, 0);
          vis = mix(vis, ev(cv), U.csK); bounce = mix(bounce, vec3(ev(cr), ev(cg), ev(cb)), U.csK);
        }
        const half = cc.P * cc.sp * 0.5, dxz = max(abs(p.x.sub(U.cam.x)), abs(p.z.sub(U.cam.y))), wC = float(1).sub(smoothstep(half * 0.55, half * 0.92, dxz));
        lookups.push({ w: wC, vis, bounce });
      }
      let vis = lookups[0].vis, bounce = lookups[0].bounce;
      if (lookups.length > 1) { const w = lookups[0].w; vis = mix(lookups[1].vis, vis, w); bounce = mix(lookups[1].bounce, bounce, w); }
      const skyVis = clamp(vis, 0.0, 1.0), hRel = o.h || m.userData.dmReliefH || null;
      // crevices: the relief height (parallax / ground atlas) darkens the sky term further, weighted by how closed the sky is
      const cav = hRel ? mix(float(1), float(0.6).add(clamp(hRel, 0.0, 1.0).mul(0.4)), float(1).sub(skyVis).mul(0.6).add(0.4)) : float(1);
      if (o.ao !== false) { const aoK = mix(float(1), skyVis.mul(cav), U.k); m.aoNode = m.aoNode ? m.aoNode.mul(aoK) : aoK; }
      if (o.bounce !== false) { const alb = T.diffuseColor ? T.diffuseColor.rgb : vec3(1, 1, 1); m.emissiveNode = (m.emissiveNode || vec3(0, 0, 0)).add(alb.mul(max(bounce, vec3(0, 0, 0))).mul(cav).mul(U.gain).mul(U.k)); }
      if (o.shadow !== false) {
        const sn = sunVisNodes(T, p);
        // relief-aware: with the sun low the crevices (low relief height) sit in the shadow of their own rims
        const rel = hRel ? mix(float(1), smoothstep(0.05, 0.6, clamp(hRel, 0.0, 1.0)), U.lowSun.mul(0.6)) : float(1);
        const hfVis = mix(float(1), sn.vs.mul(rel), U.hfK.mul(U.k)), prev = m.receivedShadowNode;
        m.receivedShadowNode = prev ? ((s) => prev(s).mul(hfVis)) : ((s) => s.mul(hfVis));
      }
      m.userData.dmLight = true; m.needsUpdate = true; D.mats++;
      return true;
    } catch (err) { try { console.warn('[light] applyMaterial', err); } catch (_) { } D.failed = String(err && err.message || err); return false; }
  };
  // characters: node materials take the hook directly; classic ones are adopted into a node twin first (ui/dm-parallax.js adopt keeps maps / skinning)
  D.applyTree = function (root, o) {
    let n = 0; try {
      if (!D.on || !root) return 0; const seen = new Set(), list = [];
      root.traverse(ob => { if (!ob.isMesh || !ob.material) return; (Array.isArray(ob.material) ? ob.material : [ob.material]).forEach(m => { if (m && !seen.has(m)) { seen.add(m); list.push(m); } }); });
      for (const m of list) { let t = m; if (!t.isNodeMaterial && W.DMParallax && W.DMParallax.adopt) t = W.DMParallax.adopt(root, m); if (t && t.isNodeMaterial && D.applyMaterial(t, Object.assign({ shadow: true }, o || {}))) n++; }
    } catch (e) { try { console.warn('[light] applyTree', e); } catch (_) { } } return n;
  };

  D.status = function () { return { on: D.on, tier: D.tier, flag, lvl: D.lvl, eff: D.eff, ready: D.ready, ms: +D.msEma.toFixed(2), probesPerSec: Math.round(D.probesPerSec), headroom: D.hr.on, cs: D.cs, csOk: D.csOk, csBad: D.csBad, csFrames: D.csFrames, csK: U ? +U.csK.value.toFixed(2) : 0, mats: D.mats, overlays: D.overlays, uploads: D.uploads, MB: +(D.bytes / 1048576).toFixed(2), built: D.built, failed: D.failed, hfFilled: hf ? hf.filled : 0, boot: D.boot }; };
  D.dispose = function () { try { if (tex) { tex.hft.dispose(); if (tex.hft2) tex.hft2.dispose(); for (const v of tex.vols) for (const t of v) t.dispose(); } if (CS) { for (const t of CS.A.concat(CS.B)) t.dispose(); } } catch (e) { } tex = null; U = null; CS = null; D.ready = false; D.tier = 'off'; D.ticks = 0; hf = null; hf2 = null; casc = []; hemiCache = null; D._S = null; };
})(typeof window !== 'undefined' ? window : globalThis);
