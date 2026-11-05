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

  const core = { FAR_CELL, NEAR_MAX, FAR_MAX, sunVisLong, rasterizeOverlay, hash1, csRayDirs, stepDownTier, bootTier, Y0, Y1, shProject, shEval, bentNormal, rng, rayDirs, createHF, overlayAt, march, marchBrute, sunVis, sunVisBrute, TIERS, TIER_ORDER, effective, cost, pickTier, createHeadroom, createCascade, neutralProbe, traceProbe, updateCascade, sampleCascade };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;

  /* ───────────────────────── browser glue ───────────────────────── */
  const W = root, Q = (W.location && W.location.search) || '';
  const flag = ((Q.match(/[?&]light=(off|low|med|high|ultra|auto)\b/) || [])[1]) || 'auto';
  const csFlag = /[?&]lightcs=1\b/.test(Q) || (function () { try { return W.localStorage.getItem('dm_light_cs') === '1'; } catch (e) { return false; } })();
  const gainQ = +((Q.match(/[?&]lightgain=([\d.]+)/) || [])[1] || 1);
  const D = {
    on: flag !== 'off', core, tier: 'off', flag, S: null, lvl: 0, eff: effective('off', 0, false), ready: false, failed: '', built: null, ticks: 0, probesPerSec: 0,
    msEma: 0, lamps: new Float32Array(0), lampK: 0, lampN: 0, hr: createHeadroom({ hold: 8 }), cs: false, upT: 0, uploads: 0, bytes: 0, mats: 0, sunVisK: 1,
  };
  W.DMLight = D;
  const Rn = rng(12345);
  const sunV = [0.4, 0.8, 0.45], sunI = [0, 0, 0, 0], skyI = [0.5, 0.55, 0.65], albedo = [0.34, 0.30, 0.25];
  let hf = null, casc = [], U = null, tex = null, THREE_ = null, T_ = null, baseY = 0, lastH = null, hemiCache = null;

  function pickNow() {
    const g = W.GFX || {}; let t = pickTier(g, flag === 'auto' ? null : flag);
    if (flag === 'auto' && /[?&]px=0\b/.test(Q) && false) t = 'off';
    return t;
  }
  function sceneLights(scene) {   // find the ambient / hemisphere colours once (like ui/dm-mansion-look.js)
    if (hemiCache) return hemiCache; const o = { hemi: null }; try { scene.traverse(x => { if (x.isHemisphereLight && !o.hemi && !(x.userData && (x.userData.btStandIn || x.userData.bti))) o.hemi = x; }); } catch (e) { } return (hemiCache = o);
  }

  function build() {   // allocate caches for the tier (once; a tier change only ever happens at boot / on explicit flag)
    const e = TIERS[D.tier]; if (!e || !e.rays) return false;
    hf = createHF(e.hfN, e.hfN >= 256 ? 1.5 : 2); casc = [];
    const sp = [3, 12], ly = [2.5, 6]; for (let c = 0; c < e.casc; c++) casc.push(createCascade(e.P, e.L, sp[c], ly[c]));
    D.bytes = hf.data.byteLength + casc.reduce((s, c) => s + c.data.byteLength, 0) + e.hfN * e.hfN * 2 + casc.length * e.P * e.P * e.L * 8 * 4;
    D.built = { tier: D.tier, hfN: e.hfN, cell: hf.cell, casc: casc.map(c => ({ P: c.P, L: c.L, sp: c.sp, ly: c.ly })) };
    return true;
  }

  // GPU resources + TSL nodes (lazy: the first material that asks).  Fixed graph per tier; all live numbers are uniforms.
  function initGpu(THREE, T) {
    if (U) return true; if (!hf) return false; THREE_ = THREE; T_ = T; const Tt = THREE;
    if (!Tt.Data3DTexture || !Tt.DataTexture || !T.texture3D || !T.uniform) return false;
    const e = TIERS[D.tier], N = hf.N;
    const hft = new Tt.DataTexture(new Uint16Array(N * N), N, N, Tt.RedFormat, Tt.HalfFloatType); hft.wrapS = hft.wrapT = Tt.RepeatWrapping; hft.minFilter = hft.magFilter = Tt.LinearFilter; hft.generateMipmaps = false; hft.needsUpdate = true;
    const vols = casc.map(c => [0, 1, 2, 3].map(() => { const t = new Tt.Data3DTexture(new Uint16Array(c.P * c.P * c.L * 4), c.P, c.P, c.L); t.format = Tt.RGBAFormat; t.type = Tt.HalfFloatType; t.wrapS = t.wrapT = Tt.RepeatWrapping; t.wrapR = Tt.ClampToEdgeWrapping; t.minFilter = t.magFilter = Tt.LinearFilter; t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true; return t; }));
    tex = { hft, vols };
    U = {
      k: T.uniform(0), base: T.uniform(0), cam: T.uniform(new Tt.Vector2(0, 0)), sun: T.uniform(new Tt.Vector3(0.4, 0.8, 0.45)), hfSteps: T.uniform(e.sunSteps), hfK: T.uniform(0.5), gain: T.uniform(gainQ * 0.9), pen: T.uniform(0.05),
    };
    // neutral content so the first frames equal "no DMLight": vis = open sky, bounce 0
    for (let c = 0; c < casc.length; c++) upload(c, true);
    uploadHF(true);
    return true;
  }
  const H16 = (v) => (THREE_.DataUtils ? THREE_.DataUtils.toHalfFloat(v) : 0);
  function uploadHF(force) {
    if (!tex) return; const N = hf.N, d = tex.hft.image.data; baseY = Math.round(lastH == null ? 0 : lastH / 32) * 32; U.base.value = baseY;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const idx = j * N + i, v = hf.si[idx] === 0x7fffffff ? -300 : hf.data[idx] - baseY; d[idx] = H16(v < -500 ? -500 : v > 500 ? 500 : v); }
    // hf slot (i&M, j&M) IS the texture texel (i&M, j&M): toroidal layout = RepeatWrapping with uv = (x/cell + 0.5)/N
    tex.hft.needsUpdate = true; D.uploads++; D.hfVer = hf.ver;
  }
  function upload(ci, force) {
    const c = casc[ci], vols = tex.vols[ci], n = c.P * c.P * c.L; if (!force && c.upVer === c.ver) return; c.upVer = c.ver;
    const dv = vols[0].image.data, dr = vols[1].image.data, dg = vols[2].image.data, db = vols[3].image.data, s = c.data;
    const P2 = c.P * c.P, L = c.L;   // CPU order is (column, layer); the 3D texture is layer-major (z slices of P x P)
    for (let p = 0; p < n; p++) { const col = (p / L) | 0, l = p - col * L, o = p * 16, q = (l * P2 + col) * 4; for (let k = 0; k < 4; k++) { dv[q + k] = H16(s[o + k]); dr[q + k] = H16(s[o + 4 + k]); dg[q + k] = H16(s[o + 8 + k]); db[q + k] = H16(s[o + 12 + k]); } }
    for (const t of vols) t.needsUpdate = true; D.uploads++;
  }

  function lightParams() {
    const sun = W.TERRAIN && W.TERRAIN.sun;
    if (sun && sun.color) { const k = sun.intensity == null ? 1 : sun.intensity; sunI[0] = sun.color.r * k; sunI[1] = sun.color.g * k; sunI[2] = sun.color.b * k; sunI[3] = 1; } else { sunI[0] = sunI[1] = sunI[2] = 0; sunI[3] = 0; }
  }

  // per-frame: called from the surface tick.  o: {x,y,z (camera/player), H (height fn), sunDir (Vector3), day (0..1), dtMs?, scene}
  D.tick = function (dt, o) {
    if (!D.on || !o || o.walk === false) return; D.ticks++;
    const B = W.DMBudget, lvl = B && B.on ? B.lvl('light') : 0;
    if (D.tier === 'off' && D.ticks === 1) {
      D.tier = pickNow(); if (!TIERS[D.tier].rays) { D.on = false; return; }
      if (!build()) { D.on = false; return; } D.ready = true;
    }
    if (!D.ready) return;
    const st = B && B.on ? B.stats() : null; D.hr.step(dt, B && B.on ? (B.p | 0) : 0, st ? st.emaMs : 0, 50);
    D.cs = !!(D.tier === 'ultra' && csFlag && D.hr.on);   // compute refinement (opt-in until verified on hardware)
    const e = D.eff = effective(D.tier, lvl, D.hr.on); D.lvl = lvl;
    lastH = o.y; hf.sampler = o.H; hf.setCenter(o.x, o.z);
    const t0 = now();
    // 1) height cache: refill what the window needs (time-sliced; ~1/3 of the probe budget)
    const hfMs = D.tier === 'low' ? 0.3 : 0.5; hf.fill(hf.N * hf.N, 4096, hfMs);
    // 2) probes
    const sd = o.sunDir; if (sd) { sunV[0] = sd.x; sunV[1] = sd.y; sunV[2] = sd.z; }
    lightParams(); const day = o.day == null ? 1 : o.day;
    const hm = sceneLights(o.scene || (W.PW && W.PW.scene)).hemi; if (hm && hm.color) { const k = hm.intensity == null ? 1 : hm.intensity; skyI[0] = hm.color.r * k; skyI[1] = hm.color.g * k; skyI[2] = hm.color.b * k; }
    if (!e.freeze && e.ms > 0) {
      const Sx = D._S || (D._S = { hf, sun: sunV, sunI, skyI, albedo, maxD: 40, mSteps: 8, sunSteps: 8, lamps: null, lampK: 0 });
      Sx.hf = hf; Sx.mSteps = e.mSteps; Sx.sunSteps = e.sunSteps; Sx.lamps = D.lampN ? D.lamps : null; Sx.lampK = D.lampK;
      let n = 0;
      for (let c = 0; c < casc.length && c < e.casc; c++) {
        const cc = casc[c]; if (c > 0 && (D.ticks & 3) !== 0) continue;   // far cascade: every 4th frame
        Sx.maxD = cc.sp * 12; const left = e.ms - (now() - t0); if (left <= 0.05) break;
        n += updateCascade(cc, hf, o.x, o.z, Sx, e.rays, left * (c === 0 ? 0.8 : 1), c === 0 ? 160 : 60, Rn);
      }
      D.probesPerSec += (n / Math.max(dt, 1e-3) - D.probesPerSec) * 0.05;
    }
    const ms = now() - t0; D.msEma += (ms - D.msEma) * 0.05;
    // 3) GPU copies (throttled; only when something changed)
    if (U) {
      U.cam.value.set(o.x, o.z); U.sun.value.set(sunV[0], sunV[1], sunV[2]); U.hfSteps.value = e.sunSteps;
      const cad = W.DMBudget && W.DMBudget.on ? W.DMBudget.shadowEvery() : 1; U.hfK.value = (cad > 1 ? 0.8 : 0.45) * (day > 0.05 ? 1 : 0);
      U.k.value += (1 - U.k.value) * Math.min(1, dt * 2);
      const t = now(); if (t - D.upT > 160) { D.upT = t; for (let c = 0; c < casc.length; c++) upload(c, false); if (D.hfVer !== hf.ver || Math.abs(o.y - baseY) > 200) { if (hf.ver !== D.hfVer) uploadHF(false); } }
    }
  };

  // lamps: flat array [x,y,z, r,g,b, radius] * n (world frame); level 0..1 (dusk fade * on/off), eased by the caller
  D.setLamps = function (arr) { D.lamps = arr instanceof Float32Array ? arr : new Float32Array(arr); D.lampN = (D.lamps.length / 7) | 0; };
  D.setLampLevel = function (k) { D.lampK = k < 0 ? 0 : k > 1 ? 1 : k; };
  D.addOverlay = function (o) { if (hf) hf.addOverlay(o); else (D._pend || (D._pend = [])).push(o); };

  // material hook.  o: { p (world position node, default positionWorld), n (world normal node, default normalWorld), h (0..1 relief height node, 1 = proud), albedo }
  D.applyMaterial = function (m, o) {
    try {
      if (!D.on || !m || !m.isNodeMaterial || (m.userData && m.userData.dmLight)) return false;
      if (D.tier === 'off' && D.ticks === 0) { D.tier = pickNow(); if (!TIERS[D.tier].rays) { D.on = false; return false; } if (!build()) { D.on = false; return false; } D.ready = true; }
      if (!D.ready) return false;
      const THREE = W.THREE, T = THREE && THREE.TSL; if (!THREE || !T || !initGpu(THREE, T)) return false;
      o = o || {};
      const { float, vec2, vec3, texture, texture3D, min, max, clamp, dot, normalize, mix, abs, smoothstep, If } = T;
      const p = o.p || T.positionWorld, n = o.n || T.normalWorld, N = hf.N, cell = hf.cell;
      const hfU = (x, z) => vec2(x, z).div(cell).add(0.5).div(N);
      const hH = (x, z) => texture(tex.hft, hfU(x, z)).level(0).r.add(U.base);
      const g0 = hH(p.x, p.z);
      const lookups = [];
      for (let c = 0; c < casc.length; c++) {
        const cc = casc[c], vols = tex.vols[c];
        const uv = vec2(p.x, p.z).div(cc.sp).add(0.5).div(cc.P), lz = clamp(p.y.sub(g0).div(cc.ly * cc.L), 0.5 / cc.L, 1 - 0.5 / cc.L), uvw = T.vec3(uv.x, uv.y, lz);
        const f = (v) => texture3D(v, uvw, 0);
        const sv = f(vols[0]), sr = f(vols[1]), sg = f(vols[2]), sb = f(vols[3]);
        const ev = (s) => s.x.mul(Y0).add(dot(vec3(s.y, s.z, s.w), n).mul((2 / 3) * Y1));
        const half = cc.P * cc.sp * 0.5, dxz = max(abs(p.x.sub(U.cam.x)), abs(p.z.sub(U.cam.y))), wC = float(1).sub(smoothstep(half * 0.55, half * 0.92, dxz));
        lookups.push({ w: wC, vis: ev(sv), bent: vec3(sv.y, sv.z, sv.w), bounce: vec3(ev(sr), ev(sg), ev(sb)) });
      }
      let vis = lookups[0].vis, bent = lookups[0].bent, bounce = lookups[0].bounce;
      if (lookups.length > 1) { const w = lookups[0].w; vis = mix(lookups[1].vis, vis, w); bent = mix(lookups[1].bent, bent, w); bounce = mix(lookups[1].bounce, bounce, w); }
      const skyVis = clamp(vis, 0.0, 1.0);
      // crevices: the relief height (parallax / ground atlas) darkens the sky term further, weighted by how closed the sky is
      const hRel = o.h || m.userData.dmReliefH || null;
      const cav = hRel ? mix(float(1), float(0.6).add(clamp(hRel, 0.0, 1.0).mul(0.4)), float(1).sub(skyVis).mul(0.6).add(0.4)) : float(1);
      const aoK = mix(float(1), skyVis.mul(cav), U.k);
      m.aoNode = m.aoNode ? m.aoNode.mul(aoK) : aoK;
      const alb = T.diffuseColor ? T.diffuseColor.rgb : vec3(1, 1, 1);
      m.emissiveNode = (m.emissiveNode || vec3(0, 0, 0)).add(alb.mul(max(bounce, vec3(0, 0, 0))).mul(U.gain).mul(U.k));
      // sun: contact-hardening march of the height cache, folded into the shadow-map result
      const L = U.sun, steps = TIERS[D.tier].sunSteps, vs = float(1).toVar(), t0 = cell * 0.6, maxD = 64.0;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps, t = t0 + (maxD - t0) * f * f;
        If(U.hfSteps.greaterThan(i - 0.5), () => {
          const q = p.add(L.mul(t)), dh = q.y.sub(hH(q.x, q.z)).add(0.15), v = clamp(dh.div(U.pen.mul(t).add(1e-3)).mul(0.5).add(0.5), 0.0, 1.0);
          vs.assign(min(vs, v));
        });
      }
      const hfVis = mix(float(1), vs, U.hfK.mul(U.k));
      const prev = m.receivedShadowNode;
      m.receivedShadowNode = prev ? ((s) => prev(s).mul(hfVis)) : ((s) => s.mul(hfVis));
      m.userData.dmLight = true; m.needsUpdate = true; D.mats++;
      return true;
    } catch (err) { try { console.warn('[light] applyMaterial', err); } catch (_) { } D.failed = String(err && err.message || err); return false; }
  };

  D.status = function () { return { on: D.on, tier: D.tier, flag, lvl: D.lvl, eff: D.eff, ready: D.ready, ms: +D.msEma.toFixed(2), probesPerSec: Math.round(D.probesPerSec), headroom: D.hr.on, cs: D.cs, mats: D.mats, uploads: D.uploads, MB: +(D.bytes / 1048576).toFixed(2), built: D.built, failed: D.failed, hfFilled: hf ? hf.filled : 0 }; };
  D.dispose = function () { try { if (tex) { tex.hft.dispose(); for (const v of tex.vols) for (const t of v) t.dispose(); } } catch (e) { } tex = null; U = null; D.ready = false; D.tier = 'off'; D.ticks = 0; hf = null; casc = []; hemiCache = null; D._S = null; };
})(typeof window !== 'undefined' ? window : globalThis);
