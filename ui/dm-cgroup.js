// dm-cgroup.js — "character group" adaptive collision.
// The group is Ariel (172 bones) + her skyboard + the strand-hair solver + the cloth solver. Every frame it
//   1. computes the group PERIMETER (union of the members' bounding spheres, plus a margin for the surroundings),
//   2. takes the FINEST tessellation among the members (board, foot/body, hair segment spacing, cloth cell),
//      limited only by a node budget (so a huge perimeter never explodes the cost),
//   3. keeps one fine local collision PATCH of the true surface (terrain / density fn) at that cell size,
//      scrolled incrementally as the group moves (toroidal ring buffer: a move of one cell resamples one row/column,
//      everything else is reused), budgeted per frame by samples AND milliseconds, double-buffered on LOD changes,
//   4. publishes a physics-intensity scalar per context (walk, flight, swim, fluid…) that solvers read to scale
//      substeps / iterations / resolution inside the perimeter.
// Consumers: foot / board contact (groundAt), hair (intensity + ground proxy), cloth & fluid (collideSphere, intensity,
// registerMember). All buffers are allocated at create time. No THREE objects are created or used here (pure numbers),
// so it can run in any frame loop, a worker, or a unit test.
//
// API (window.DMCGroup):
//   registerMember(id, {res, bound(out4)->bool, caps(outF32,max)->n})   res: cell size (world units) or fn
//   unregisterMember(id)
//   setSurface(key, sample(x,z,yHint)->y|NaN)   key change invalidates the patch
//   update(dt)                                  once per frame (cheap; budgeted)
//   groundAt(x,z,fallback) / normalAt(x,z,out3) / collideSphere(x,y,z,r,out,skipId)
//   setContext(name)  boost(name,k,ttl)  intensity (smoothed scalar)  levels: DMCGroup.contexts
//   stats()  perimeter  patch (cell, ready, coverage)  reset()
(function (root) {
  'use strict';
  const NMAX = 40, NN = NMAX * NMAX, BIG = 0x7fffffff;
  const mod = (a) => { const m = a % NMAX; return m < 0 ? m + NMAX : m; };

  // ── toroidal fine height patch ────────────────────────────────────────────────────────────────────────
  function makePatch() {
    return { c: 0, h: new Float32Array(NN), ti: new Int32Array(NN), tj: new Int32Array(NN),
      i0: 0, j0: 0, n: 0, ci: 0, cj: 0, rcore: 0, ready: false, samples: 0, filledNow: 0, y: 0 };
  }
  function pReset(P, c) { P.c = c; P.ti.fill(BIG); P.tj.fill(BIG); P.ready = false; P.n = 0; }
  // node window covering [cx±half, cz±half]; ring radius (in cells) that must be complete before the patch is "ready"
  function pWindow(P, cx, cz, half, core) {
    const c = P.c; P.ci = Math.round(cx / c); P.cj = Math.round(cz / c);
    const r = Math.min((NMAX >> 1) - 1, Math.ceil(half / c)); P.i0 = P.ci - r; P.j0 = P.cj - r; P.n = 2 * r + 1;
    P.rcore = Math.min(r, Math.ceil(core / c));
  }
  // fill missing nodes ring by ring outward from the centre. budget = max samples, tEnd = deadline (ms, 0 = none).
  // returns true when every node inside rcore is valid (the patch can serve the perimeter).
  function pFill(P, sample, y, budget, tEnd, nowFn) {
    const c = P.c, H = P.h, TI = P.ti, TJ = P.tj, R = (P.n - 1) >> 1; let used = 0, coreOk = true;
    for (let r = 0; r <= R; r++) {
      const len = r === 0 ? 1 : 8 * r, s2 = 2 * r;
      for (let k = 0; k < len; k++) {
        let di = 0, dj = 0;
        if (r > 0) { const side = (k / s2) | 0, t = k - side * s2;
          if (side === 0) { di = -r + t; dj = -r; } else if (side === 1) { di = r; dj = -r + t; } else if (side === 2) { di = r - t; dj = r; } else { di = -r; dj = r - t; } }
        const i = P.ci + di, j = P.cj + dj, s = mod(j) * NMAX + mod(i);
        if (TI[s] === i && TJ[s] === j) continue;
        if (used >= budget || (tEnd > 0 && (used & 3) === 3 && nowFn() > tEnd)) { P.samples += used; P.filledNow = used; return r > P.rcore && coreOk; }
        H[s] = sample(i * c, j * c, y); TI[s] = i; TJ[s] = j; used++;      // NaN = valid node, no surface here
      }
    }
    P.samples += used; P.filledNow = used; return coreOk;
  }
  function pHeight(P, x, z) {
    const c = P.c; if (!(c > 0)) return NaN;
    const fx = x / c, fz = z / c, i = Math.floor(fx), j = Math.floor(fz), ax = fx - i, az = fz - j;
    const s00 = mod(j) * NMAX + mod(i), s10 = mod(j) * NMAX + mod(i + 1), s01 = mod(j + 1) * NMAX + mod(i), s11 = mod(j + 1) * NMAX + mod(i + 1);
    const TI = P.ti, TJ = P.tj;
    if (TI[s00] !== i || TJ[s00] !== j || TI[s10] !== i + 1 || TJ[s10] !== j || TI[s01] !== i || TJ[s01] !== j + 1 || TI[s11] !== i + 1 || TJ[s11] !== j + 1) return NaN;
    const H = P.h;
    return (H[s00] * (1 - ax) + H[s10] * ax) * (1 - az) + (H[s01] * (1 - ax) + H[s11] * ax) * az;
  }

  // ── intensity contexts ────────────────────────────────────────────────────────────────────────────────
  const CONTEXTS = { idle: 0.85, walk: 1, run: 1.15, ride: 0.9, flight: 0.75, jump: 1.3, climb: 1.3, swim: 1.6, fluid: 1.8, step: 1.2 };

  const G = {
    NMAX, contexts: CONTEXTS,
    opts: { margin: 0.35, minCell: 1e-4, budget: 48, maxMs: 0.8, lodHyst: 0.18, intensityTau: 0.25, maxBoost: 3 },
    members: [], _ctx: 'walk', _boosts: [], intensity: 1, _target: 1,
    key: null, sample: null, A: makePatch(), B: makePatch(), building: false,
    per: { x: 0, y: 0, z: 0, r: 0, ymin: 0, ymax: 0, n: 0 }, cell: 0, limitedBy: '', lod: 0,
    _t: new Float32Array(4), _caps: new Float32Array(7 * 32), _ncaps: 0, _now: (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()),
    ms: 0, samplesFrame: 0, frames: 0,
  };
  const OUT = { nx: 0, ny: 1, nz: 0, depth: 0, src: '' };

  G.registerMember = function (id, spec) {
    G.unregisterMember(id); spec = spec || {}; spec.id = id; G.members.push(spec); return spec;
  };
  G.unregisterMember = function (id) { for (let i = G.members.length - 1; i >= 0; i--) if (G.members[i].id === id) G.members.splice(i, 1); };
  G.setSurface = function (key, sample) {
    if (key !== G.key) { G.key = key; G.sample = sample; pReset(G.A, 0); pReset(G.B, 0); G.building = false; G.cell = 0; }
    else G.sample = sample;
  };
  G.setContext = function (name) { if (CONTEXTS[name] !== undefined) G._ctx = name; };
  // temporary intensity boost from any system (e.g. a fluid volume): k multiplies the context level for ttl seconds
  G.boost = function (name, k, ttl) {
    for (let i = 0; i < G._boosts.length; i++) if (G._boosts[i].n === name) { G._boosts[i].k = k; G._boosts[i].t = ttl; return; }
    G._boosts.push({ n: name, k, t: ttl });
  };
  G.reset = function () { G.key = null; G.sample = null; pReset(G.A, 0); pReset(G.B, 0); G.building = false; G.cell = 0; };

  G.update = function (dt) {
    const t0 = G._now(), O = G.opts, per = G.per; dt = dt > 0 ? Math.min(dt, 0.1) : 0.016;
    // 1. perimeter + 2. finest member resolution
    let minX = 1e30, minZ = 1e30, maxX = -1e30, maxZ = -1e30, minY = 1e30, maxY = -1e30, fine = 1e30, who = '', nb = 0, ncap = 0; const T = G._t;
    for (let k = 0; k < G.members.length; k++) {
      const m = G.members[k];
      if (m.bound && m.bound(T)) {
        const r = T[3]; nb++;
        if (T[0] - r < minX) minX = T[0] - r; if (T[0] + r > maxX) maxX = T[0] + r;
        if (T[2] - r < minZ) minZ = T[2] - r; if (T[2] + r > maxZ) maxZ = T[2] + r;
        if (T[1] - r < minY) minY = T[1] - r; if (T[1] + r > maxY) maxY = T[1] + r;
        const res = typeof m.res === 'function' ? m.res() : m.res;
        if (res > O.minCell && res < fine) { fine = res; who = m.id; }
      }
      if (m.caps && ncap < 32) ncap += m.caps(G._caps, 32, ncap) | 0;
    }
    G._ncaps = ncap;
    // 4. intensity (context level × strongest live boost), smoothed so solver counts do not flicker
    let tgt = CONTEXTS[G._ctx] || 1, bmax = 1;
    for (let i = G._boosts.length - 1; i >= 0; i--) { const b = G._boosts[i]; b.t -= dt; if (b.t <= 0) { G._boosts.splice(i, 1); continue; } if (b.k > bmax) bmax = b.k; }
    tgt = Math.min(O.maxBoost, tgt * bmax); G._target = tgt;
    G.intensity += (tgt - G.intensity) * (1 - Math.exp(-dt / O.intensityTau));
    G.frames++;
    if (!nb || !G.sample) { G.ms = G._now() - t0; return; }
    per.x = (minX + maxX) * 0.5; per.z = (minZ + maxZ) * 0.5; per.y = (minY + maxY) * 0.5; per.ymin = minY; per.ymax = maxY;
    per.r = Math.max(maxX - minX, maxZ - minZ) * 0.5; per.n = nb;
    const half = per.r * (1 + O.margin);
    // desired cell: finest member, finer with intensity (up to ~1.7x at 3), floored by the node budget
    let want = fine / Math.sqrt(Math.max(0.5, Math.min(3, G.intensity))), capCell = (2 * half) / (NMAX - 3), by = who;
    if (want < capCell) { want = capCell; by = 'budget'; }
    G.limitedBy = by;
    // 3. patch: LOD change builds the back patch, the front keeps serving until the back is ready (hysteresis)
    const A = G.A, B = G.B, tEnd = t0 + O.maxMs, bud = O.budget * (0.75 + 0.25 * Math.min(3, G.intensity));
    if (!(A.c > 0)) { pReset(A, want); G.cell = want; }
    else if (!G.building && Math.abs(want - A.c) > A.c * O.lodHyst) { pReset(B, want); G.building = true; }
    const P = G.building ? B : A;
    pWindow(P, per.x, per.z, half, per.r + P.c * 2);
    const ok = pFill(P, G.sample, per.y, G.building ? bud * 1.5 : bud, tEnd, G._now);
    P.ready = ok && P.n > 0;
    if (G.building && B.ready) { const t = G.A; G.A = G.B; G.B = t; G.building = false; G.cell = G.A.c; G.lod++; }
    G.samplesFrame = P.filledNow; G.ms = G._now() - t0;
  };

  // true-surface height at x,z through the fine patch (fallback when not covered / not ready)
  G.groundAt = function (x, z, fallback) {
    const h = pHeight(G.A, x, z); return h === h ? h : fallback;
  };
  G.covers = function (x, z) { return pHeight(G.A, x, z) === pHeight(G.A, x, z); };
  G.normalAt = function (x, z, out) {
    const e = Math.max(G.A.c * 0.5, 1e-3), hx0 = pHeight(G.A, x - e, z), hx1 = pHeight(G.A, x + e, z), hz0 = pHeight(G.A, x, z - e), hz1 = pHeight(G.A, x, z + e);
    if (!(hx0 === hx0 && hx1 === hx1 && hz0 === hz0 && hz1 === hz1)) { out[0] = 0; out[1] = 1; out[2] = 0; return false; }
    let nx = (hx0 - hx1) / (2 * e), nz = (hz0 - hz1) / (2 * e); const l = Math.sqrt(nx * nx + 1 + nz * nz);
    out[0] = nx / l; out[1] = 1 / l; out[2] = nz / l; return true;
  };
  // sphere vs ground patch + the members' capsules: the one query cloth / fluid / hair particles need.
  // returns the deepest penetration (OUT is reused: copy what you need) or null.
  G.collideSphere = function (x, y, z, r, skipId) {
    let best = 0; const o = OUT; o.depth = 0;
    const h = pHeight(G.A, x, z);
    if (h === h && y - r < h) {
      const d = h - (y - r); const nrm = G._nrm || (G._nrm = new Float32Array(3)); G.normalAt(x, z, nrm);
      best = d; o.nx = nrm[0]; o.ny = nrm[1]; o.nz = nrm[2]; o.src = 'ground';
    }
    const C = G._caps;
    for (let k = 0; k < G._ncaps; k++) {
      const q = k * 7, ax = C[q], ay = C[q + 1], az = C[q + 2], bx = C[q + 3] - ax, by = C[q + 4] - ay, bz = C[q + 5] - az;
      const ll = bx * bx + by * by + bz * bz; let t = ll > 1e-12 ? ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / ll : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + bx * t), dy = y - (ay + by * t), dz = z - (az + bz * t), dd = Math.sqrt(dx * dx + dy * dy + dz * dz), pen = C[q + 6] + r - dd;
      if (pen > best) { best = pen; const il = dd > 1e-9 ? 1 / dd : 0; o.nx = dx * il; o.ny = dd > 1e-9 ? dy * il : 1; o.nz = dz * il; o.src = 'caps'; }
    }
    o.depth = best; return best > 0 ? o : null;
  };

  G.stats = function () {
    const A = G.A, per = G.per;
    return { cell: +G.cell.toFixed(5), limitedBy: G.limitedBy, perimeterR: +per.r.toFixed(4), members: per.n, nodes: A.n * A.n, ready: A.ready, building: G.building, lod: G.lod,
      samplesFrame: G.samplesFrame, samples: A.samples + G.B.samples, ms: +G.ms.toFixed(4), intensity: +G.intensity.toFixed(3), ctx: G._ctx, caps: G._ncaps, frames: G.frames };
  };
  G._patch = { height: pHeight, make: makePatch, reset: pReset, window: pWindow, fill: pFill };
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
  root.DMCGroup = G;
})(typeof window !== 'undefined' ? window : globalThis);
