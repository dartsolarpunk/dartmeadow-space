/* DART Meadow — ground material library: 12 procedural pattern / deformation types, baked ONCE per world into a small atlas,
 * chosen per region (seed / biome / slope / noise) and blended by height so moss, water and dirt sit in the crevices.
 *
 * WHY (user feedback): the ground looked like one procedural style on every world, the bump was weak, and the dominant detail was
 * about a screen-half wide next to her foot.  Scale reference (index.html): she is CHAR_TERRAIN_HEIGHT = 3.26 scene units tall for a
 * 6 ft / 1.83 m rider, so 1 unit = 0.561 m, her shoe (0.27 m) is 0.48 units, and the dominant detail feature must be HALF A SHOE =
 * 0.24 units.  Every generator below is authored in "features per tile" with tileW = 4 units (mobile 3.2), so the main cell of every
 * type is 0.15-0.3 units (pebble 0.2, brick 0.4 x 0.17, flagstone 0.7 x 1.3, gravel 0.11, mud plate 0.6, ripple 0.16).
 *
 * COST MODEL (the frame rate is the budget):
 *   · the pattern maths runs on the CPU, ONCE per world, in 2-3 ms slices between frames (bake() is a generator; DMGround.pump()
 *     steps it).  Nothing is evaluated per pixel per frame except 3-7 texture fetches (atlas), never a noise function.
 *   · two RGBA8 atlases, 4x2 tiles of (T+8)^2 texels (4 px wrapped gutter so bilinear + mip level <= 2 never bleeds):
 *       A1 = height | slope x | slope y | albedo-lightness / 2        A2 = tint r | g | b (x2) | roughness
 *     (the slopes are baked: the per-pixel normal is ONE fetch at the parallax hit, not three height taps)
 *   · one 160x160 region map (1024 units wide, wraps): selector | moss | wetness | ruin — a single bilinear fetch picks the band.
 * This file is the pure-JS half (node-testable: tools/tests/ground-unit.js).  The shader half is DMGround.apply() at the bottom.
 */
(function (root) {
  'use strict';
  const G = root;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;
  const PI2 = Math.PI * 2;

  /* ─────────────────────────── 1. periodic noise toolkit ─────────────────────────── */
  function h2(x, y, s) {   // integer lattice hash -> [0,1)
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647) + 1013904223) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  }
  const wrap = (i, n) => ((i % n) + n) % n;
  const quint = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  // value noise on a Px x Py periodic lattice; x,y are in lattice units
  function vn(x, y, Px, Py, s) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = quint(x - ix), fy = quint(y - iy);
    const x0 = wrap(ix, Px), x1 = wrap(ix + 1, Px), y0 = wrap(iy, Py), y1 = wrap(iy + 1, Py);
    const a = h2(x0, y0, s), b = h2(x1, y0, s), c = h2(x0, y1, s), d = h2(x1, y1, s);
    return mix(mix(a, b, fx), mix(c, d, fx), fy);
  }
  // tileable fBm over the unit square: base period P, `oct` octaves
  function fbm(u, v, P, oct, s) {
    let a = 0.5, t = 0, n = 0, p = P;
    for (let i = 0; i < oct; i++) { t += a * vn(u * p, v * p, p, p, s + i * 31); n += a; a *= 0.5; p *= 2; }
    return t / n;
  }
  // periodic Worley: N cells per tile.  Result lives in W (no allocation): d1,d2 (cell units), id, id2, dx,dy (vector from the pixel to the nearest feature point)
  const W = { d1: 0, d2: 0, id: 0, id2: 0, dx: 0, dy: 0, cx: 0, cy: 0 };
  function wor(u, v, N, s, jit) {
    const x = u * N, y = v * N, ix = Math.floor(x), iy = Math.floor(y);
    let d1 = 9, d2 = 9, bi = 0, bj = 0, bx = 0, by = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = ix + ox, gy = iy + oy, wx = wrap(gx, N), wy = wrap(gy, N);
      const fx = gx + 0.5 + (h2(wx, wy, s) - 0.5) * jit - x, fy = gy + 0.5 + (h2(wx, wy, s + 77) - 0.5) * jit - y, d = Math.sqrt(fx * fx + fy * fy);
      if (d < d1) { d2 = d1; d1 = d; bi = wx; bj = wy; bx = fx; by = fy; } else if (d < d2) d2 = d;
    }
    W.d1 = d1; W.d2 = d2; W.id = h2(bi, bj, s + 5); W.id2 = h2(bi, bj, s + 13); W.dx = bx; W.dy = by; W.cx = bi; W.cy = bj;
    return W;
  }

  /* ─────────────────────────── 2. the type library ─────────────────────────── */
  // Each generator: init(seed) -> ctx, px(ctx, u, v, o) writes o.h (0..1, 1 = proud), o.l (lightness multiplier ~1), o.r,o.g,o.b (tint multipliers ~1), o.rough.
  // `amp` compresses the height around the surface plane (0.55): sand ripples are shallow, pebbles and bricks are deep.
  const TYPES = [];
  const def = (name, o) => { o.id = TYPES.length; o.name = name; TYPES.push(o); return o; };

  def('pebbleBed', {   // 0 — rounded stones packed edge to edge, a few fine pebbles filling the gaps; main pebble 0.2 u (half a shoe)
    amp: 1.0, feature: 0.2, init: (s) => ({ s }),
    px(c, u, v, o) {
      const w = wor(u, v, 20, c.s, 0.9), rr = 0.62 * (0.72 + 0.5 * w.id2), q = w.d1 / rr, dome = q < 1 ? Math.sqrt(1 - q * q) : 0, edge = w.d2 - w.d1, jt = sstep(0.0, 0.2, edge), id = w.id;
      let h = Math.pow(dome, 0.7) * (0.62 + 0.38 * id) * jt;
      const w2 = wor(u + 0.31, v + 0.17, 44, c.s + 9, 0.9), q2 = w2.d1 / 0.5, d2 = q2 < 1 ? Math.sqrt(1 - q2 * q2) : 0;
      h = Math.max(h, 0.34 * d2) + (fbm(u, v, 48, 1, c.s + 3) - 0.5) * 0.05;
      o.h = h; o.l = (0.55 + 0.75 * id) * (0.42 + 0.58 * jt) * (0.82 + 0.3 * dome);
      o.r = 1 + 0.16 * (w.id2 - 0.5); o.g = 1 + 0.06 * (id - 0.5); o.b = 1 - 0.14 * (w.id2 - 0.5); o.rough = 0.9 - 0.22 * dome;
    },
  });
  def('crackedPlates', {   // 1 — dry rock split into tilted plates (0.65 u) with deep cracks and hairlines, grit on top
    amp: 1.0, feature: 0.65, init: (s) => ({ s }),
    px(c, u, v, o) {
      const w = wor(u, v, 6, c.s, 0.85), e = w.d2 - w.d1, crack = 1 - sstep(0.0, 0.07, e);
      let h = 0.78 + (w.dx * (w.id - 0.5) + w.dy * (w.id2 - 0.5)) * 0.35 - crack * 0.62;
      const wh = wor(u, v, 15, c.s + 21, 0.95), eh = wh.d2 - wh.d1, gate = sstep(0.42, 0.58, fbm(u, v, 4, 2, c.s + 5)), hair = (1 - sstep(0.0, 0.05, eh)) * gate;
      h -= hair * 0.3; h += (fbm(u, v, 64, 2, c.s + 7) - 0.5) * 0.09;
      o.h = h; o.l = (0.8 + 0.5 * w.id) * (1 - 0.62 * crack) * (1 - 0.35 * hair) * (0.92 + 0.16 * (fbm(u, v, 24, 2, c.s + 11)));
      const tn = (w.id2 - 0.5) * 0.14; o.r = 1 + tn; o.g = 1; o.b = 1 - tn; o.rough = 0.88 + 0.08 * crack;
    },
  });
  def('mossStone', {   // 2 — cobbles (0.44 u) with soil joints and lichen on the tops; the moss in the crevices is added live by the region wetness
    amp: 1.0, feature: 0.44, init: (s) => ({ s }),
    px(c, u, v, o) {
      const w = wor(u, v, 9, c.s, 0.7), rr = 0.78 * (0.75 + 0.45 * w.id2), q = w.d1 / rr, dome = q < 1 ? Math.sqrt(1 - q * q) : 0, jt = sstep(0.02, 0.3, w.d2 - w.d1);
      const h = Math.pow(dome, 0.55) * (0.72 + 0.28 * w.id) * jt + (fbm(u, v, 40, 2, c.s + 3) - 0.5) * 0.06;
      const lich = sstep(0.54, 0.7, fbm(u, v, 12, 3, c.s + 17)) * (0.4 + 0.6 * dome);
      o.h = h; o.l = (0.6 + 0.5 * w.id) * (0.38 + 0.62 * jt) * (1 - 0.1 * lich);
      o.r = 1 - 0.22 * lich; o.g = 1 + 0.16 * lich; o.b = 1 - 0.3 * lich; o.rough = 0.92 - 0.1 * dome;
    },
  });
  def('gravel', {   // 3 — angular chips, 0.11 u, every chip its own tilt and tone
    amp: 0.75, feature: 0.11, init: (s) => ({ s }),
    px(c, u, v, o) {
      const w = wor(u, v, 36, c.s, 1.0), e = w.d2 - w.d1, jt = sstep(0.0, 0.14, e);
      const h = (0.55 + (w.dx * (w.id - 0.5) + w.dy * (w.id2 - 0.5)) * 0.9 + (w.id - 0.5) * 0.3) * (0.35 + 0.65 * jt);
      o.h = h; o.l = (0.45 + 0.9 * w.id2) * (0.5 + 0.5 * jt);
      const t = (w.id - 0.5) * 0.2; o.r = 1 + t; o.g = 1 + t * 0.4; o.b = 1 - t; o.rough = 0.93;
    },
  });
  def('mudCracks', {   // 4 — sun-dried mud: plates 0.6 u with curled lips and wide cracks, flakes on top
    amp: 1.0, feature: 0.6, init: (s) => ({ s }),
    px(c, u, v, o) {
      const w = wor(u, v, 7, c.s, 0.9), e = w.d2 - w.d1, crack = 1 - sstep(0.0, 0.1, e), lip = (1 - sstep(0.1, 0.42, e)) * (1 - crack);
      let h = 0.72 + lip * 0.16 + (w.id - 0.5) * 0.08 - crack * 0.7;
      const wf = wor(u, v, 26, c.s + 31, 1.0), ef = wf.d2 - wf.d1; h -= (1 - sstep(0, 0.06, ef)) * 0.12 * sstep(0.35, 0.6, fbm(u, v, 5, 2, c.s + 9));
      h += (fbm(u, v, 56, 2, c.s + 4) - 0.5) * 0.06;
      o.h = h; o.l = (0.88 + 0.28 * w.id) * (1 - 0.62 * crack) * (1 + 0.1 * lip);
      o.r = 1.06; o.g = 1.0; o.b = 0.9; o.rough = 0.92;
    },
  });
  // flagstone rows with staggered joints (ruins): tileable by construction (breakpoints per row repeat each tile)
  def('flagstone', {   // 5 — worn paving slabs ~1.3 x 0.7 u, sunk joints, a few cracked; the ruin floor
    amp: 0.95, feature: 0.7, init: (s) => ({ s, RN: 6, NB: 3 }),
    px(c, u, v, o) {
      const RN = c.RN, NB = c.NB, vr = v * RN, j = Math.floor(vr), fy = vr - j, jr = wrap(j, RN);
      const uu = (u + h2(jr, 0, c.s + 3)) % 1;   // row offset
      // breakpoints of this row: p_k = (k + 0.2 + 0.6 h)/NB
      let k = NB - 1, pk = 0, pn = 1;
      for (let i = 0; i < NB; i++) { const p = (i + 0.2 + 0.6 * h2(jr, i, c.s + 5)) / NB; if (p <= uu) { k = i; pk = p; } }
      const kn = (k + 1) % NB; pn = (kn + 0.2 + 0.6 * h2(jr, kn, c.s + 5)) / NB; if (kn === 0) pn += 1; if (uu < pk) pk -= 1;   // wrap
      const ex = Math.min(uu - pk, pn - uu), ey = Math.min(fy, 1 - fy) / RN, e = Math.min(ex, ey);
      const sid = h2(jr, k, c.s + 9), sid2 = h2(jr, k, c.s + 15);
      const joint = 1 - sstep(0.006, 0.02, e), worn = sstep(0.006, 0.05, e);
      let h = ((0.62 + 0.3 * sid) * (0.55 + 0.45 * worn)) * (1 - joint) + 0.17 * joint + (fbm(u, v, 40, 3, c.s + 2) - 0.5) * 0.07;
      const wc = wor(u, v, 5, c.s + 41, 1.0), ec = wc.d2 - wc.d1; const cr = (1 - sstep(0.0, 0.025, ec)) * (sid2 > 0.55 ? 1 : 0); h -= cr * 0.28;
      o.h = h; o.l = (0.62 + 0.55 * sid) * (1 - 0.6 * joint) * (1 - 0.3 * cr) * (0.9 + 0.2 * fbm(u, v, 18, 3, c.s + 6));
      const t = (sid2 - 0.5) * 0.2; o.r = 1 + t; o.g = 1 + t * 0.3; o.b = 1 - t * 0.8 + 0.04; o.rough = 0.86 + 0.1 * joint;
    },
  });
  def('brick', {   // 6 — running-bond bricks 0.4 x 0.17 u, chipped, with mortar; walls and ruin floors
    amp: 1.0, feature: 0.4, init: (s) => ({ s, R: 24, C: 10 }),
    px(c, u, v, o) {
      const R = c.R, C = c.C, vr = v * R, j = Math.floor(vr), fy = vr - j, jr = wrap(j, R);
      const ur = u * C + (jr & 1 ? 0.5 : 0), i = Math.floor(ur), fx = ur - i, ir = wrap(i, C);
      const bid = h2(ir, jr, c.s + 3), bid2 = h2(ir, jr, c.s + 8);
      const chip = (fbm(u, v, 64, 2, c.s + 6) - 0.5) * 0.06;
      const ex = Math.min(fx, 1 - fx) / C, ey = Math.min(fy, 1 - fy) / R;   // distance to the brick edge in tile units (bricks are 1/C x 1/R of a tile)
      const e = Math.min(ex, ey) + chip * 0.15, mortar = 1 - sstep(0.0035, 0.0075, e), round = sstep(0.004, 0.016, e);
      let h = ((0.86 - 0.08 * bid) * (0.7 + 0.3 * round)) * (1 - mortar) + 0.3 * mortar;
      h += (fbm(u, v, 80, 2, c.s + 11) - 0.5) * 0.06;
      o.h = h; o.l = mortar ? 0.82 : (0.6 + 0.5 * bid2) * (0.85 + 0.15 * round);
      if (mortar > 0.5) { o.r = 1.0; o.g = 0.96; o.b = 0.86; } else { o.r = 1.36 + 0.2 * (bid - 0.5); o.g = 0.8 + 0.1 * (bid2 - 0.5); o.b = 0.66; }
      o.rough = 0.88;
    },
  });
  def('sandRipples', {   // 7 — wind ripples, wavelength 0.16 u, warped, calm patches, grain
    amp: 0.5, feature: 0.16, init: (s) => ({ s, kx: 23, ky: 9 }),
    px(c, u, v, o) {
      const warp = (fbm(u, v, 6, 3, c.s) - 0.5) * 3.4, ph = c.kx * u + c.ky * v + warp, f = ph - Math.floor(ph);
      const saw = f < 0.72 ? f / 0.72 : (1 - f) / 0.28, sm = saw * saw * (3 - 2 * saw);
      const calm = 0.35 + 0.9 * sstep(0.3, 0.7, fbm(u, v, 5, 2, c.s + 8));
      const grain = vn(u * 96, v * 96, 96, 96, c.s + 4) - 0.5, dune = fbm(u, v, 4, 2, c.s + 12) - 0.5;
      o.h = 0.5 + (sm - 0.5) * 0.7 * calm + dune * 0.3 + grain * 0.05;
      o.l = 0.96 + (sm - 0.5) * 0.16 * calm + grain * 0.12; o.r = 1.0; o.g = 0.98; o.b = 0.93; o.rough = 0.97;
    },
  });
  def('sandFootprints', {   // 8 — sand ripples (softer) with two trails of shoe-sized prints (0.48 x 0.2 u) and a rim of pushed-up sand
    amp: 0.7, feature: 0.48,
    init: (s) => {
      const fp = []; const len = 0.12, wid = 0.026;   // tile units (tileW 4 u: 0.48 u long)
      for (let k = 0; k < 3; k++) {   // trail A runs along u at v = 0.27, stepping 1/3 tile, left/right alternate
        fp.push({ x: (k + 0.18) / 3, y: 0.27 + (k & 1 ? 0.02 : -0.02), a: 0.0, len, wid, side: k & 1 });
        fp.push({ x: (k + 0.68) / 3, y: 0.27 + (k & 1 ? -0.02 : 0.02), a: 0.0, len, wid, side: (k + 1) & 1 });
      }
      for (let k = 0; k < 3; k++) {   // trail B runs along v at u = 0.74, a little smaller prints (a child / a second walker)
        fp.push({ x: 0.74 + (k & 1 ? 0.02 : -0.02), y: (k + 0.3) / 3, a: Math.PI / 2, len: len * 0.8, wid: wid * 0.8, side: k & 1 });
        fp.push({ x: 0.74 + (k & 1 ? -0.02 : 0.02), y: (k + 0.8) / 3, a: Math.PI / 2, len: len * 0.8, wid: wid * 0.8, side: (k + 1) & 1 });
      }
      return { s, fp, kx: 19, ky: 7 };
    },
    px(c, u, v, o) {
      const warp = (fbm(u, v, 5, 3, c.s) - 0.5) * 3.0, ph = c.kx * u + c.ky * v + warp, f = ph - Math.floor(ph), rip = f < 0.7 ? f / 0.7 : (1 - f) / 0.3;
      const grain = vn(u * 96, v * 96, 96, 96, c.s + 4) - 0.5;
      let h = 0.5 + (rip - 0.5) * 0.28 + grain * 0.04 + (fbm(u, v, 4, 2, c.s + 12) - 0.5) * 0.2, shade = 1;
      for (let i = 0; i < c.fp.length; i++) {
        const F = c.fp[i]; let dx = u - F.x, dy = v - F.y; dx -= Math.round(dx); dy -= Math.round(dy);
        const ca = Math.cos(F.a), sa = Math.sin(F.a), a = (dx * ca + dy * sa) / F.len, b = (-dx * sa + dy * ca) / F.wid;   // a along the foot (-0.5..0.5), b across
        if (a < -0.8 || a > 0.8 || b < -2 || b > 2) continue;
        const waist = 0.78 + 0.22 * Math.cos(a * 2.6) * (a > 0 ? 1.0 : 0.85), r2 = (a * 2) * (a * 2) + (b / waist) * (b / waist);   // an ellipse that narrows at the arch
        if (r2 < 1) { const d = Math.sqrt(1 - r2); h -= 0.42 * Math.pow(d, 0.5) * (0.6 + 0.4 * sstep(0, 0.4, d)); shade *= 0.93; }
        else if (r2 < 1.7) { const t = 1 - (r2 - 1) / 0.7; h += 0.12 * t * t; }
      }
      o.h = h; o.l = 0.95 * shade + (rip - 0.5) * 0.1 + grain * 0.1; o.r = 1.0; o.g = 0.98; o.b = 0.92; o.rough = 0.97;
    },
  });
  def('snowCrust', {   // 9 — wind-sculpted sastrugi over a broken crust (plates 0.8 u), cold tint in the cracks
    amp: 0.6, feature: 0.8, init: (s) => ({ s }),
    px(c, u, v, o) {
      const st = 1 - Math.abs(2 * (vn(u * 3, v * 18, 3, 18, c.s) * 0.65 + vn(u * 6, v * 36, 6, 36, c.s + 5) * 0.35) - 1);
      const w = wor(u, v, 5, c.s + 41, 0.9), e = w.d2 - w.d1, crack = 1 - sstep(0.0, 0.045, e), plate = 0.5 + (w.id - 0.5) * 0.2;
      const grain = vn(u * 120, v * 120, 120, 120, c.s + 2) - 0.5;
      o.h = plate * 0.6 + st * 0.55 - crack * 0.42 + grain * 0.04;
      o.l = 1.15 - 0.25 * crack + grain * 0.18; o.r = 0.95 - 0.1 * crack; o.g = 1.0 - 0.04 * crack; o.b = 1.06 + 0.1 * crack; o.rough = 0.58 + 0.2 * crack;
    },
  });
  def('scoria', {   // 10 — volcanic cinder: a rough crust full of vesicles (0.1-0.3 u), dark with rust in the holes
    amp: 1.0, feature: 0.2, init: (s) => ({ s }),
    px(c, u, v, o) {
      const rid = 1 - Math.abs(2 * fbm(u, v, 8, 3, c.s) - 1);
      let h = 0.55 + rid * 0.4;
      let hole = 0;
      const w = wor(u, v, 15, c.s + 3, 1.0), rad = 0.18 + 0.3 * w.id2, q = w.d1 / rad;
      if (w.id > 0.3 && q < 1) { const t = 1 - q * q; hole = Math.pow(t, 0.6); h -= 0.62 * hole; } else if (w.id > 0.3 && q < 1.25) h += 0.1 * (1 - (q - 1) / 0.25);
      const w2 = wor(u + 0.2, v + 0.55, 34, c.s + 29, 1.0), q2 = w2.d1 / 0.34; if (w2.id > 0.45 && q2 < 1) { const t = 1 - q2 * q2; h -= 0.3 * Math.pow(t, 0.6); hole = Math.max(hole, 0.6 * t); }
      h += (fbm(u, v, 60, 2, c.s + 6) - 0.5) * 0.08;
      o.h = h; o.l = (0.5 + 0.45 * rid) * (1 - 0.55 * hole);
      o.r = 1.08 + 0.3 * hole; o.g = 0.96 - 0.1 * hole; o.b = 0.88 - 0.2 * hole; o.rough = 0.9;
    },
  });
  def('forestLitter', {   // 11 — leaf litter and roots: ~150 leaves (0.2-0.36 u) stacked at random, bark roots, dark soil between
    amp: 0.9, feature: 0.28,
    init: (s) => {
      const L = [], rnd = (i, k) => h2(i, k, s + 99), N = 150, GB = 8, bins = Array.from({ length: GB * GB }, () => []);
      for (let i = 0; i < N; i++) {
        const lf = { x: rnd(i, 1), y: rnd(i, 2), a: rnd(i, 3) * Math.PI, len: 0.036 + 0.03 * rnd(i, 4), z: rnd(i, 5), hue: rnd(i, 6) }; lf.wid = lf.len * (0.34 + 0.12 * rnd(i, 7));
        L.push(lf); const r = lf.len * 1.1;
        for (let gy = Math.floor((lf.y - r) * GB); gy <= Math.floor((lf.y + r) * GB); gy++) for (let gx = Math.floor((lf.x - r) * GB); gx <= Math.floor((lf.x + r) * GB); gx++) bins[wrap(gy, GB) * GB + wrap(gx, GB)].push(lf);
      }
      const roots = []; for (let k = 0; k < 3; k++) roots.push({ v0: 0.15 + 0.3 * k + 0.1 * rnd(k, 20), kk: 1 + k, ph: rnd(k, 21), amp: 0.05 + 0.04 * rnd(k, 22), th: 0.012 + 0.008 * rnd(k, 23) });
      return { s, L, bins, GB, roots };
    },
    px(c, u, v, o) {
      let zb = -1, hh = 0.2 + (fbm(u, v, 30, 2, c.s) - 0.5) * 0.1, lum = 0.34, hue = 0.5, rough = 0.95, mid = 0;
      const bi = c.bins[wrap(Math.floor(v * c.GB), c.GB) * c.GB + wrap(Math.floor(u * c.GB), c.GB)];
      for (let i = 0; i < bi.length; i++) {
        const lf = bi[i]; let dx = u - lf.x, dy = v - lf.y; dx -= Math.round(dx); dy -= Math.round(dy);
        const ca = Math.cos(lf.a), sa = Math.sin(lf.a), a = (dx * ca + dy * sa) / lf.len, b = (-dx * sa + dy * ca) / lf.wid;
        const prof = 1 - 4 * a * a; if (prof <= 0) continue; const r = Math.abs(b) / prof; if (r > 1 || lf.z < zb) continue;
        zb = lf.z; hh = 0.38 + 0.4 * lf.z + 0.08 * Math.sqrt(1 - r * r) - 0.05 * (1 - sstep(0, 0.08, Math.abs(b))) ; hue = lf.hue; lum = 0.55 + 0.6 * lf.hue * (1 - 0.3 * r); rough = 0.8; mid = 1;
      }
      for (let i = 0; i < 3; i++) {
        const R = c.roots[i], vy = R.v0 + R.amp * Math.sin(PI2 * (R.kk * u + R.ph)); let dv = v - vy; dv -= Math.round(dv);
        const t = Math.abs(dv) / R.th; if (t < 1) { const rh = 0.7 + 0.2 * Math.sqrt(1 - t * t) + (vn(u * 90, v * 90, 90, 90, c.s + 3) - 0.5) * 0.08; if (rh > hh) { hh = rh; lum = 0.4 + 0.1 * vn(u * 60, v * 60, 60, 60, c.s + 5); hue = 0.15; rough = 0.95; mid = 0; } }
      }
      o.h = hh; o.l = lum;
      if (hue > 0.66) { o.r = 1.0; o.g = 1.1; o.b = 0.55; } else if (hue > 0.33) { o.r = 1.35; o.g = 0.98; o.b = 0.5; } else { o.r = 1.2; o.g = 0.95; o.b = 0.7; }
      o.rough = rough;
    },
  });

  /* ─────────────────────────── 3. world profiles: which 8 of the 12 this world wears ─────────────────────────── */
  const T_ = {}; TYPES.forEach((t) => { T_[t.name] = t.id; });
  // base weights per world style (styleFor in ui/dm-worldstyle.js: lush | dunes | mesa | ice | volcanic | crater)
  const BIOMES = {
    lush:     { w: { pebbleBed: 1.0, crackedPlates: 0.8, mossStone: 1.6, gravel: 1.0, mudCracks: 0.5, sandRipples: 0.2, sandFootprints: 0.15, snowCrust: 0, scoria: 0.1, forestLitter: 1.7 }, moss: 1.0, wet: 0.85, ruin: 0.7, ruinTypes: ['flagstone', 'brick'], steep: 'crackedPlates' },
    dunes:    { w: { pebbleBed: 0.5, crackedPlates: 0.7, mossStone: 0, gravel: 1.0, mudCracks: 0.9, sandRipples: 2.0, sandFootprints: 1.6, snowCrust: 0, scoria: 0.1, forestLitter: 0 }, moss: 0, wet: 0.0, ruin: 0.25, ruinTypes: ['flagstone', 'brick'], steep: 'crackedPlates' },
    mesa:     { w: { pebbleBed: 1.0, crackedPlates: 1.5, mossStone: 0, gravel: 1.6, mudCracks: 1.0, sandRipples: 1.1, sandFootprints: 0.3, snowCrust: 0, scoria: 0.5, forestLitter: 0 }, moss: 0, wet: 0.0, ruin: 0.0, ruinTypes: ['flagstone'], steep: 'crackedPlates' },
    ice:      { w: { pebbleBed: 0.6, crackedPlates: 0.7, mossStone: 0, gravel: 0.6, mudCracks: 0.1, sandRipples: 0.3, sandFootprints: 0.1, snowCrust: 2.2, scoria: 0, forestLitter: 0 }, moss: 0, wet: 0.35, ruin: 0.12, ruinTypes: ['flagstone'], steep: 'crackedPlates' },
    volcanic: { w: { pebbleBed: 0.4, crackedPlates: 1.1, mossStone: 0, gravel: 1.2, mudCracks: 0.4, sandRipples: 0.6, sandFootprints: 0, snowCrust: 0, scoria: 2.0, forestLitter: 0 }, moss: 0, wet: 0.15, ruin: 0.0, ruinTypes: ['flagstone'], steep: 'scoria' },
    crater:   { w: { pebbleBed: 1.2, crackedPlates: 1.0, mossStone: 0, gravel: 1.8, mudCracks: 0.2, sandRipples: 0.9, sandFootprints: 0.1, snowCrust: 0, scoria: 0.7, forestLitter: 0 }, moss: 0, wet: 0.0, ruin: 0.0, ruinTypes: ['flagstone'], steep: 'crackedPlates' },
  };
  // seed -> deterministic profile.  opts: { style, seed, water (pal.water), lat }
  function profile(opts) {
    opts = opts || {}; const style = BIOMES[opts.style] ? opts.style : 'lush', B = BIOMES[style], seed = (opts.seed | 0) || 1;
    const names = TYPES.map((t) => t.name).filter((n) => n !== 'flagstone' && n !== 'brick');
    const scored = names.map((n, i) => ({ n, s: B.w[n] * (0.55 + 0.9 * h2(seed, i, 4101)) + 1e-6 * i })).filter((o) => B.w[o.n] > 0).sort((a, b) => b.s - a.s);
    const band = scored.slice(0, 6).map((o) => o.n);
    for (let i = 0; band.length < 6; i++) band.push(band[i % Math.max(1, band.length)]);   // (a very poor biome repeats its best types)
    // shuffle the band order by seed so neighbouring bands differ between worlds
    for (let i = band.length - 1; i > 0; i--) { const j = Math.floor(h2(seed, i, 4177) * (i + 1)); const t = band[i]; band[i] = band[j]; band[j] = t; }
    const ruinName = B.ruinTypes[Math.floor(h2(seed, 9, 4211) * B.ruinTypes.length)];
    const wet = B.wet * (opts.water === false ? 0.45 : 1) * (0.7 + 0.6 * h2(seed, 3, 4243));
    const slots = band.concat([ruinName, B.steep]);
    return {
      style, seed, bands: band, slots: slots.map((n) => T_[n]), names: slots,
      moss: B.moss * (0.6 + 0.5 * h2(seed, 5, 4261)), wet: clamp(wet, 0, 1), ruin: B.ruin * (0.6 + 0.8 * h2(seed, 7, 4283)),
      tileW: 4.0,
    };
  }

  /* ─────────────────────────── 4. baking (time-sliced) ─────────────────────────── */
  const COLS = 4, ROWS = 2, PAD = 4, GS = 6;   // atlas grid, gutter, slope encode scale
  function layout(T) { const cell = T + 2 * PAD; return { T, cell, W: cell * COLS, H: cell * ROWS }; }
  function allocAtlas(T) { const L = layout(T); return { L, a1: new Uint8Array(L.W * L.H * 4), a2: new Uint8Array(L.W * L.H * 4) }; }
  // Bake one tile (type id, size T, world seed) into tile-local float arrays; generator yields every `rows` rows.
  function* bakeTile(typeId, T, seed, out, rows) {
    const ty = TYPES[typeId], ctx = ty.init((seed * 7919 + typeId * 104729) | 0), o = { h: 0, l: 1, r: 1, g: 1, b: 1, rough: 0.9 };
    const H = out.H, Lm = out.L, R = out.R, Gc = out.G, B = out.B, Rg = out.Rg, amp = ty.amp;
    rows = rows || 16;
    for (let y = 0; y < T; y++) {
      const v = (y + 0.5) / T;
      for (let x = 0; x < T; x++) {
        ty.px(ctx, (x + 0.5) / T, v, o); const i = y * T + x;
        H[i] = clamp(0.55 + (clamp(o.h, 0, 1) - 0.55) * amp, 0, 1); Lm[i] = o.l; R[i] = o.r; Gc[i] = o.g; B[i] = o.b; Rg[i] = o.rough;
      }
      if ((y + 1) % rows === 0 && y < T - 1) yield;
    }
  }
  // Pack a baked tile into slot `slot` of the atlas (heights -> slopes by wrapped central differences; gutter wraps).
  function packTile(atlas, slot, T, out, part, parts) {
    parts = parts || 1; part = part | 0;
    // lightness is normalised to a mean of 1: the biome's own vertex colour sets how dark the ground is, the tile only adds the pattern (tints stay)
    if (part === 0) { let mean = 0; for (let i = 0; i < T * T; i++) mean += out.L[i]; mean = Math.max(1e-3, mean / (T * T)); const ln = clamp(1 / mean, 0.4, 2.4); for (let i = 0; i < T * T; i++) out.L[i] *= ln; }
    const L = atlas.L, cell = L.cell, ox = (slot % COLS) * cell, oy = Math.floor(slot / COLS) * cell, H = out.H;
    const span = T + 2 * PAD, jA = -PAD + Math.floor(span * part / parts), jB = -PAD + Math.floor(span * (part + 1) / parts);
    for (let j = jA; j < jB; j++) for (let i = -PAD; i < T + PAD; i++) {
      const x = wrap(i, T), y = wrap(j, T), k = y * T + x, xm = wrap(x - 1, T), xp = wrap(x + 1, T), ym = wrap(y - 1, T), yp = wrap(y + 1, T);
      const gx = (H[y * T + xp] - H[y * T + xm]) * 0.5, gy = (H[yp * T + x] - H[ym * T + x]) * 0.5;
      const p = ((oy + j + PAD) * L.W + (ox + i + PAD)) * 4;
      atlas.a1[p] = Math.round(clamp(H[k], 0, 1) * 255); atlas.a1[p + 1] = Math.round(clamp(0.5 + 0.5 * gx * GS, 0, 1) * 255); atlas.a1[p + 2] = Math.round(clamp(0.5 + 0.5 * gy * GS, 0, 1) * 255);
      atlas.a1[p + 3] = Math.round(clamp(out.L[k] * 0.5, 0, 1) * 255);
      atlas.a2[p] = Math.round(clamp(out.R[k] * 0.5, 0, 1) * 255); atlas.a2[p + 1] = Math.round(clamp(out.G[k] * 0.5, 0, 1) * 255); atlas.a2[p + 2] = Math.round(clamp(out.B[k] * 0.5, 0, 1) * 255);
      atlas.a2[p + 3] = Math.round(clamp(out.Rg[k], 0, 1) * 255);
    }
  }
  function newTileBuf(T) { const n = T * T; return { H: new Float32Array(n), L: new Float32Array(n), R: new Float32Array(n), G: new Float32Array(n), B: new Float32Array(n), Rg: new Float32Array(n) }; }

  // Region map: 4 channels over a wrapping 1024-unit square: R band selector (histogram-equalised so every band gets ~1/6 of the area),
  // G moss, B wetness, A ruin mask (0.5 = the patch edge).  Bilinear-sampled, so every channel is smooth.
  const REG = 160, REG_UNITS = 1024;
  function* bakeRegion(prof, out, rows) {
    rows = rows || 10; const s = prof.seed | 0, N = REG * REG, f = new Float32Array(N * 4), eq = (a) => {   // histogram equalise a field to ~uniform 0..1
      const bins = new Uint32Array(512); let mn = 1e9, mx = -1e9; for (let i = 0; i < N; i++) { if (a[i] < mn) mn = a[i]; if (a[i] > mx) mx = a[i]; }
      const sp = (mx - mn) || 1; for (let i = 0; i < N; i++) bins[Math.min(511, ((a[i] - mn) / sp * 512) | 0)]++;
      const cdf = new Float32Array(512); let acc = 0; for (let i = 0; i < 512; i++) { acc += bins[i]; cdf[i] = acc / N; }
      for (let i = 0; i < N; i++) a[i] = cdf[Math.min(511, ((a[i] - mn) / sp * 512) | 0)];
    };
    const A = new Float32Array(N), Bm = new Float32Array(N), C = new Float32Array(N), D = new Float32Array(N);
    for (let y = 0; y < REG; y++) {
      const v = (y + 0.5) / REG;
      for (let x = 0; x < REG; x++) {
        const u = (x + 0.5) / REG, i = y * REG + x;
        A[i] = fbm(u, v, 5, 2, s + 1) + 0.12 * fbm(u, v, 22, 1, s + 2);   // ~200-unit regions with ragged edges
        Bm[i] = fbm(u, v, 6, 3, s + 11); C[i] = fbm(u, v, 6, 3, s + 21); D[i] = fbm(u, v, 7, 2, s + 31);
      }
      if ((y + 1) % rows === 0) yield;
    }
    eq(A); yield; eq(Bm); yield; eq(C); yield; eq(D); yield;
    // ruin patches: the top `ruin*0.1` of the area (so a forest world has a few, a desert almost none); 0.5 at the edge
    const rArea = clamp(prof.ruin * 0.1, 0, 0.3), thr = 1 - rArea;
    for (let i = 0; i < N; i++) {
      out[i * 4] = Math.round(clamp(A[i], 0, 0.999) * 255);
      out[i * 4 + 1] = Math.round(clamp(Bm[i] * prof.moss, 0, 1) * 255);
      out[i * 4 + 2] = Math.round(clamp(sstep(0.5, 0.95, C[i]) * prof.wet, 0, 1) * 255);
      out[i * 4 + 3] = rArea <= 0 ? 0 : Math.round(clamp(sstep(thr - 0.035, thr + 0.035, D[i]), 0, 1) * 255);
    }
  }

  // The whole bake as one generator (tiles first, then the region map); yields between slices.  sizeT: tile texels (tier table: 96..256).
  function* bake(prof, atlas, region, sizeT) {
    const buf = newTileBuf(sizeT);
    for (let s = 0; s < 8; s++) {
      yield* bakeTile(prof.slots[s], sizeT, prof.seed, buf, 4);
      for (let part = 0; part < 4; part++) { packTile(atlas, s, sizeT, buf, part, 4); yield; }
    }
    yield* bakeRegion(prof, region, 10);
  }
  function bakeSync(prof, T) { const atlas = allocAtlas(T), region = new Uint8Array(REG * REG * 4); const g = bake(prof, atlas, region, T); while (!g.next().done); return { atlas, region }; }

  /* ─────────────────────────── 5. runtime: textures, slices, TSL ─────────────────────────── */
  const S = { ready: false, world: null, job: null, jobT: 0, jobMs: 0, bakes: 0, mats: 0, T: 0, lastProf: null, tex: null, U: null, bakeMsTotal: 0, done: false };
  function now() { return (G.performance && G.performance.now) ? G.performance.now() : Date.now(); }
  function klassMobile() { try { return !!(G.GFX && G.GFX.isMobile); } catch (e) { return false; } }
  // (v256) tile texels follow the parallax tier table (Low 96, phones 128-192, desktop 160-256); pinned for the session once the first atlas exists (the shaders bake the atlas
  // geometry in as constants, so a preset change takes effect at the next launch for this one number; every other tier parameter is a live uniform).
  function texSize() {
    if (S.T) return S.T;
    try { const P = G.DMParallax; if (P && P.tierRow) { const t = P.tierRow(P.tierName()).hTile; if (t >= 64 && t <= 320) return t; } } catch (e) { }
    return klassMobile() ? 128 : 192;
  }

  function mkTextures(THREE, T) {
    const L = layout(T), mk = (data, w, h, mips, sRGB) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.wrapS = t.wrapT = mips ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      t.generateMipmaps = !!mips; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; return t;
    };
    const atlas = allocAtlas(T);
    // neutral content until the bake lands: height 0.55 (the surface plane), flat slopes, lightness 1, tint 1, rough .9 -> the material looks like before
    for (let i = 0; i < L.W * L.H; i++) { atlas.a1[i * 4] = 140; atlas.a1[i * 4 + 1] = 128; atlas.a1[i * 4 + 2] = 128; atlas.a1[i * 4 + 3] = 128; atlas.a2[i * 4] = 128; atlas.a2[i * 4 + 1] = 128; atlas.a2[i * 4 + 2] = 128; atlas.a2[i * 4 + 3] = 230; }
    const region = new Uint8Array(REG * REG * 4); for (let i = 0; i < REG * REG; i++) { region[i * 4] = 100; }
    return { L, atlas, region, t1: mk(atlas.a1, L.W, L.H, true), t2: mk(atlas.a2, L.W, L.H, true), tr: mk(region, REG, REG, false) };
  }

  // Start (or restart) the bake for a world.  o: { style, seed, water, lat }.  Returns the profile.  The textures are created once and refilled in place.
  function beginWorld(o) {
    const THREE = G.THREE; if (!THREE) return null;
    const prof = profile(o), T = texSize(); S.lastProf = prof; S.done = false;
    if (!S.tex || S.T !== T) { S.tex = mkTextures(THREE, T); S.T = T; }
    S.world = prof; S.bakes++;
    if (!S.U && S.ready) initUniforms();
    S.job = bake(prof, S.tex.atlas, S.tex.region, T); S.jobMs = 0; S.t0 = now();
    if (S.U) { S.U.moss.value = prof.moss; S.U.wet.value = prof.wet; }
    pumpLater(0);
    return prof;
  }
  function pump(budgetMs) {   // run the bake for up to budgetMs; true while unfinished
    if (!S.job) return false;
    const t0 = now(); budgetMs = budgetMs || 3;
    try {
      do { const r = S.job.next(); if (r.done) { S.job = null; finish(); return false; } } while (now() - t0 < budgetMs);
    } catch (e) { S.job = null; try { console.warn('[ground] bake', e); } catch (_) { } return false; }
    S.jobMs += now() - t0; return true;
  }
  function finish() {
    const t = S.tex; t.t1.needsUpdate = true; t.t2.needsUpdate = true; t.tr.needsUpdate = true; S.done = true;
    S.bakeMsTotal = now() - S.t0;
    if (S.U) S.U.ready.value = 1;
    try { if (G.console && G.console.info) G.console.info('[ground] atlas baked: ' + S.world.names.join(', ') + ' in ' + S.jobMs.toFixed(0) + ' ms CPU (' + S.bakeMsTotal.toFixed(0) + ' ms wall)'); } catch (e) { }
  }
  let pumpT = 0;
  function pumpLater(delay) {
    if (pumpT || !S.job) return;
    pumpT = setTimeout(() => { pumpT = 0; if (G._dmWarming) { pumpLater(60); return; } const more = pump(klassMobile() ? 2 : 3); if (more) pumpLater(klassMobile() ? 40 : 24); }, delay == null ? 16 : delay);
  }
  function initUniforms() {
    const THREE = G.THREE, T = THREE.TSL, { uniform } = T;
    S.U = { reachK: uniform(1), dual: uniform(1), moss: uniform(S.world ? S.world.moss : 0), wet: uniform(S.world ? S.world.wet : 0), ready: uniform(0), sky: uniform(new THREE.Color(0.35, 0.5, 0.7)), skyAmt: uniform(0.0), mossCol: uniform(new THREE.Color(0.32, 0.46, 0.18)), waterCol: uniform(new THREE.Color(0.05, 0.08, 0.1)) };
    if (S.done) S.U.ready.value = 1;
    setInterval(pollSky, 600);   // uniform writes only
  }
  // sun height + sky / water / moss colours from the surface state (TERRAIN is a classic-script const in index.html, so reach it through typeof)
  function pollSky() {
    try { const B = G.DMBudget; if (S.U && B && B.on && B.groundReach) { S.U.reachK.value = B.groundReach(); S.U.dual.value = B.groundDual(); } else if (S.U) { S.U.reachK.value = 1; S.U.dual.value = 1; } } catch (e) { }
    try {
      const TR = (typeof TERRAIN !== 'undefined') ? TERRAIN : null; if (!TR || !S.U) return;
      const sun = TR.sun; let el = 0.6;
      if (sun && sun.position && sun.target) { const dx = sun.position.x - sun.target.position.x, dy = sun.position.y - sun.target.position.y, dz = sun.position.z - sun.target.position.z, l = Math.hypot(dx, dy, dz) || 1; el = dy / l; }
      const pal = TR.pal || {}, TH = G.THREE, c = (hex, f) => new TH.Color(hex).multiplyScalar(f == null ? 1 : f);
      const skyHex = pal.sky ? (Array.isArray(pal.sky) ? pal.sky[1] : pal.sky) : 0x6a8fb8;
      skyTick(el, c(skyHex, 0.9), pal.water ? c(pal.liquidColor != null ? pal.liquidColor : 0x1a4a7a, 0.55) : c(0x101418, 1), c(pal.ground != null ? pal.ground : 0x3a7d34, 0.7).lerp(new TH.Color(0.26, 0.4, 0.14), 0.45));
    } catch (e) { }
  }

  // ── the ground graph ──
  // m: MeshStandardNodeMaterial being built by _terrainDetailMat; ctx: { p (world-flat point node), flat (0..1 walkable), nFlat (world normal node, y up), reach, lvl, near, far }
  // All the work sits behind real branches on the detail weight: past `reach` a pixel costs nothing here.
  function apply(m, ctx) {
    try {
      const P = G.DMParallax; if (!P || !P.on || !m || !ctx || !m.isNodeMaterial) return false;
      if (m.userData && m.userData.noParallax) return false;   // (v256) every tier: Low gets the same graph with small numbers (ui/dm-parallax.js TIERS)
      if (!P.init()) return false;
      const THREE = G.THREE, T = THREE.TSL;
      if (!S.T) S.T = texSize();
      if (!S.U) initUniforms();
      if (!S.tex) S.tex = mkTextures(THREE, S.T);
      const tex = S.tex, Lc = tex.L, tileWj = S.world ? S.world.tileW : 4.0;
      const { Fn, If, float, vec2, vec3, vec4, mix: tmix, smoothstep, max, min, clamp: tcl, floor, fract, texture, normalize, length, dot, abs, mod, positionView, dFdx, dFdy, log2, step } = T;
      const U = S.U, p = ctx.p, reach = float(ctx.reach).mul(U.reachK);
      // (v260) ANTI-REPETITION: the tile lattice is domain-warped by two octaves of smooth world noise (ALU only, no fetch), so identical pits / cobbles no longer sit on a visible
      // grid; the SAME warped uv feeds the height march, the baked slopes and the colour, so relief and colour stay consistent.  A macro patch noise then modulates albedo
      // and relief depth over ~6-25 m patches (world-space, so it never follows the tile).
      const hs1 = (c) => fract(T.sin(dot(c, vec2(12.9898, 78.233))).mul(43758.5453));
      const vnz = (p2) => { const c = floor(p2), f = fract(p2), u2 = f.mul(f).mul(float(3).sub(f.mul(2))); return tmix(tmix(hs1(c), hs1(c.add(vec2(1, 0))), u2.x), tmix(hs1(c.add(vec2(0, 1))), hs1(c.add(vec2(1, 1))), u2.x), u2.y); };
      const uvRaw = vec2(p.x, p.z).div(float(tileWj));
      const warp = vec2(vnz(uvRaw.mul(0.31).add(vec2(3.7, 1.3))), vnz(uvRaw.mul(0.31).add(vec2(9.1, 5.9)))).sub(0.5).mul(0.55).add(vec2(vnz(uvRaw.mul(0.97).add(vec2(2.2, 8.4))), vnz(uvRaw.mul(0.97).add(vec2(6.6, 0.8)))).sub(0.5).mul(0.16));
      const uv0 = uvRaw.add(warp);
      const macroN = vnz(vec2(p.x, p.z).mul(0.045).add(vec2(17.3, 4.1))).mul(0.6).add(vnz(vec2(p.x, p.z).mul(0.16).add(vec2(1.9, 23.7))).mul(0.4));   // 0..1, ~6-25 m patches   // U.reachK / U.dual: ui/dm-budget.js ladder (uniforms; 1 = full)
      const dist = length(positionView);
      // weights: the tile detail (colour / roughness / baked bump) runs to `reach`; the parallax march only close in (ctx.near .. ctx.far)
      const nY = ctx.nFlat.y;
      const fadeF = float(1).sub(smoothstep(reach.mul(0.5), reach, dist)).mul(smoothstep(float(0.5), float(0.7), nY)).toVar();   // walkable-ish slopes only: the planar uv would streak on a cliff, which keeps its strata
      const steepW = smoothstep(float(0.14), float(0.34), float(1).sub(nY));   // slope steeper than ~30 deg -> rock plates
      const cellPx = float(Lc.cell), TT = float(Lc.T), atlasW = float(Lc.W), atlasH = float(Lc.H), pad = float(PAD);
      const tileUV = (uvw, idx) => {   // atlas coordinate of tile-space uvw (wrapping) inside slot idx; the gutter makes bilinear + mip <= 2 seamless
        const col = mod(idx, float(COLS)), row = floor(idx.div(float(COLS))), f = fract(uvw);
        return vec2(col.mul(cellPx).add(pad).add(f.x.mul(TT)).div(atlasW), row.mul(cellPx).add(pad).add(f.y.mul(TT)).div(atlasH));
      };
      const F1 = (uvw, idx, lod) => texture(tex.t1, tileUV(uvw, idx)).level(lod);
      const F2 = (uvw, idx, lod) => texture(tex.t2, tileUV(uvw, idx)).level(lod);
      const du1 = dFdx(uv0), du2 = dFdy(uv0);
      const lod = tcl(log2(max(length(du1.mul(TT)), length(du2.mul(TT))).max(1.0)), 0.0, 2.4);
      // ---- region: the two tiles of this pixel, the blend weight, moss / wetness / ruin (one bilinear fetch of the 160x160 region map)
      const RGa = Fn(() => {   // (slotA, slotB, t, 0)
        const o = vec4(0, 0, 0, 0).toVar();
        If(fadeF.greaterThan(0.0), () => {
          const r = texture(tex.tr, p.xz.div(float(REG_UNITS))).level(0.0);
          const x = r.x.mul(5.999), iA = floor(x), tb = smoothstep(float(0.62), float(1.0), x.sub(iA));
          const ruin = smoothstep(float(0.44), float(0.56), r.w).mul(float(1).sub(steepW));
          const ovr = max(ruin, steepW), hasO = step(float(0.002), ovr), ovIdx = tmix(float(7), float(6), step(steepW, ruin));
          o.assign(vec4(iA, tmix(min(iA.add(1.0), float(5)), ovIdx, hasO), tmix(tb, ovr, hasO), 0.0));
        });
        return o;
      })().toVar();
      const RGb = Fn(() => {   // (moss, wet, ruin, 0)
        const o = vec4(0, 0, 0, 0).toVar();
        If(fadeF.greaterThan(0.0), () => {
          const r = texture(tex.tr, p.xz.div(float(REG_UNITS))).level(0.0);
          o.assign(vec4(r.y, r.z, smoothstep(float(0.44), float(0.56), r.w).mul(float(1).sub(steepW)), 0.0));
        });
        return o;
      })().toVar();
      const iA = RGa.x, iB = RGa.y, tRaw = RGa.z, mossF = RGb.x, wetF = RGb.y, ruinF = RGb.z;
      // height-blend of the two tiles at the pixel's own uv: the higher tile pokes through the other near the seam
      const WB0 = Fn(() => {
        const wb = tRaw.toVar();
        If(fadeF.greaterThan(0.0).and(tRaw.greaterThan(0.002)).and(tRaw.lessThan(0.998)).and(U.dual.greaterThan(0.5)), () => {
          const ha = F1(uv0, iA, lod).x, hb = F1(uv0, iB, lod).x, sa = ha.add(float(1).sub(tRaw)), sb = hb.add(tRaw), mm = max(sa, sb).sub(0.22);
          const wa = max(sa.sub(mm), 0.0), wbb = max(sb.sub(mm), 0.0);
          wb.assign(wbb.div(wa.add(wbb).max(1e-4)));
        });
        return wb;
      })().toVar();
      const WB = WB0.mul(U.dual);   // budget stage "ground L2": no second-tile blend (every later fetch behind WB > 0.004 is skipped)
      // puddle level in height units: wet regions fill the low 64% of the relief at full wetness, only on flat ground
      const level = wetF.mul(0.64).mul(smoothstep(float(0.8), float(0.96), nY));
      const Hn = (uvw, lodv) => {
        const hv = F1(uvw, iA, lodv).x.toVar();
        If(WB.greaterThan(0.004), () => { hv.assign(tmix(hv, F1(uvw, iB, lodv).x, WB)); });
        return max(hv, level);
      };
      const depthUV = 0.105 / tileWj;
      const b = P.buildCore({ uv: uv0, H: Hn, size: Lc.T, N: m.normalNode || T.normalView, mask: ctx.flat, depthUV, depthMul: float(1).add(macroN.sub(0.5).mul(0.7)), bias: 0.55, near: ctx.near, far: ctx.far, lodMax: 2.4 });
      const uvH = b.uv;
      // ---- final fetch at the displaced uv (A, blended with B where the weight is non-zero)
      const FinA = Fn(() => {   // (height, slope x, slope y, lightness/2)
        const s1 = vec4(0.55, 0.5, 0.5, 0.5).toVar();
        If(fadeF.greaterThan(0.0), () => { s1.assign(F1(uvH, iA, lod)); If(WB.greaterThan(0.004), () => { s1.assign(tmix(s1, F1(uvH, iB, lod), WB)); }); });
        return s1;
      })().toVar();
      const FinB = Fn(() => {   // (tint r g b /2, roughness)
        const s2 = vec4(0.5, 0.5, 0.5, 0.9).toVar();
        If(fadeF.greaterThan(0.0), () => { s2.assign(F2(uvH, iA, lod)); If(WB.greaterThan(0.004), () => { s2.assign(tmix(s2, F2(uvH, iB, lod), WB)); }); });
        return s2;
      })().toVar();
      const hHit = max(FinA.x, level), lum = FinA.w.mul(2.0), tint = vec3(FinB.x, FinB.y, FinB.z).mul(2.0), rgh = FinB.w;
      // baked slopes -> tangent-space normal, in the tangent frame of the march, blended into the existing view-space normal
      const gx = FinA.y.mul(2.0).sub(1.0).div(float(GS)), gy = FinA.z.mul(2.0).sub(1.0).div(float(GS));
      const kN = float(depthUV).mul(TT).mul(P._S.U.depthK).mul(float(ctx.bumpGain || 1.0));
      const nt = normalize(vec3(gx.mul(kN).negate(), gy.mul(kN).negate(), float(1.0)));
      const water = smoothstep(level.add(0.03), level, FinA.x).mul(step(float(0.01), level)).mul(fadeF);   // 1 where the pixel sits at the puddle surface
      const fadeN = float(1).sub(smoothstep(reach.mul(0.3), reach.mul(0.75), dist)).mul(ctx.flat);
      const Nn = normalize(b.Tt.mul(nt.x).add(b.Bt.mul(nt.y)).add(b.N0.mul(nt.z)));
      m.normalNode = normalize(tmix(b.N0, tmix(Nn, b.N0, water.mul(0.96)), fadeN.mul(float(ctx.strength || 1)).clamp(0.0, 1.0)));
      // footfall / splash rings on the puddle surface (ui/dm-water.js ripple ring; nothing is evaluated while no ripple is alive)
      try {
        const DW = G.DMWater, rg = DW && DW.active && DW.rippleGrad ? DW.rippleGrad(vec2(p.x, p.z)) : null;
        if (rg) { const wv = T.transformDirection(vec3(rg.x.negate(), float(0.0), rg.y.negate()), T.cameraViewMatrix); m.normalNode = normalize(m.normalNode.add(wv.mul(water.mul(fadeN).mul(1.2)))); }
      } catch (e) { }
      // ---- colour: lightness + tint of the tile, moss in the crevices (and over the ruins), wet darkening, water
      const cav = tmix(float(1), float(0.62).add(hHit.mul(0.38)), fadeF.mul(0.85));
      const low = float(1).sub(smoothstep(float(0.35), float(0.82), hHit));   // 1 in crevices
      const mossAmt = tcl(mossF.mul(1.5).add(ruinF.mul(0.7)).mul(float(0.25).add(low.mul(0.95))).sub(0.26).mul(1.7), 0.0, 1.0).mul(float(1).sub(water)).mul(smoothstep(float(0.6), float(0.9), nY)).mul(fadeF);
      const tiled = m.colorNode.mul(tmix(vec3(1.0), vec3(lum).mul(tint).mul(float(0.84).add(macroN.mul(0.32))), fadeF)).mul(cav).mul(b.shade.mul(0.5).add(0.5));
      const mossed = tmix(tiled, vec3(U.mossCol).mul(float(0.55).add(lum.mul(0.5))).mul(tmix(float(0.85), float(1.15), hHit)), mossAmt.mul(0.85));
      const wetDark = mossed.mul(float(1).sub(tcl(wetF.mul(2.0), 0.0, 1.0).mul(fadeF).mul(0.38)));
      m.colorNode = tmix(wetDark, vec3(U.waterCol), water.mul(0.88));
      m.roughnessNode = tmix(tmix(tmix(m.roughnessNode, rgh, fadeF), float(0.98), mossAmt.mul(0.7)), float(0.05), water);
      // sky glint in puddles: a fresnel-weighted fake reflection that only exists while the sun is up (uniform), nothing elsewhere
      try {
        const fres = float(0.04).add(float(0.96).mul(float(1).sub(abs(dot(b.V, b.N0))).pow(4.0)));
        m.emissiveNode = (m.emissiveNode || vec3(0, 0, 0)).add(vec3(U.sky).mul(water).mul(fres.mul(1.4).add(0.12)).mul(U.skyAmt));
      } catch (e) { }
      if (G.__GDBG) { const d = G.__GDBG; m.colorNode = d === 'h' ? vec3(FinA.x) : d === 'lum' ? vec3(lum.mul(0.5)) : d === 'tint' ? tint.mul(0.5) : d === 'nt' ? vec3(nt.x.mul(0.5).add(0.5), nt.y.mul(0.5).add(0.5), 0.5) : d === 'ia' ? vec3(iA.div(8)) : d === 'wet' ? vec3(wetF) : d === 'moss' ? vec3(mossF) : d === 'ruin' ? vec3(ruinF) : d === 'wb' ? vec3(WB) : vec3(FinB.w); m.emissiveNode = m.colorNode; m.colorNode = vec3(0, 0, 0); }
      m.userData.dmGround = { slots: 8, atlas: true };
      m.needsUpdate = true; S.mats++;
      return true;
    } catch (e) { try { console.warn('[ground] apply', e); } catch (_) { } return false; }
  }

  // sun / sky uniforms for the puddle glint: polled by the caller a few times a second
  function skyTick(sunElev, skyColor, waterCol, mossCol) {
    if (!S.U) return;
    S.U.skyAmt.value = clamp(sunElev * 1.6, 0, 1);
    if (skyColor) S.U.sky.value.copy(skyColor);
    if (waterCol) S.U.waterCol.value.copy(waterCol);
    if (mossCol) S.U.mossCol.value.copy(mossCol);
  }

  // region wetness at a world point (0..1), nearest texel of the region map; 0 until the bake has landed. Used for puddle footfalls (ui/dm-water-fx.js).
  function wetAt(x, z) {
    const r = S.tex && S.tex.region; if (!r || !S.done) return 0;
    let u = (x / REG_UNITS) % 1, v = (z / REG_UNITS) % 1; if (u < 0) u += 1; if (v < 0) v += 1;
    return r[(((v * REG) | 0) * REG + ((u * REG) | 0)) * 4 + 2] / 255;
  }

  G.DMGround = {
    wetAt,
    TYPES, BIOMES, profile, bake, bakeSync, bakeTile, packTile, allocAtlas, newTileBuf, layout, REG, REG_UNITS, COLS, ROWS, PAD, GS,
    beginWorld, pump, apply, skyTick,
    ref: { h2, vn, fbm, wor },
    status: () => ({ world: S.world && S.world.names, done: S.done, bakes: S.bakes, jobMs: +S.jobMs.toFixed(0), wallMs: +S.bakeMsTotal.toFixed(0), mats: S.mats, T: S.T }),
    _S: S,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = G.DMGround;
})(typeof window !== 'undefined' ? window : globalThis);
