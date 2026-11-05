/* DART Meadow — water core (pure JS, no THREE / DOM: node-testable by tools/tests/water-unit.js).
 *
 * What the water is made of (everything heavy is BAKED ONCE PER WORLD in 2-3 ms slices; the live part is texture fetches):
 *   1. a wind-driven sea spectrum (JONSWAP shape, cos^2s directional spread, deep-water dispersion w^2 = g k) summed from Gerstner
 *      trains whose wave vectors sit on the integer lattice of a tile, so each band tile repeats exactly (no seam) -> 1-3 band tiles
 *      (swell / mid / chop), RGBA8 each = slope x | slope z | height | whitecap potential (Jacobian of the Gerstner map, ranked)
 *   2. a lace / cell / micro-slope detail tile and a chromatic caustic tile (analytic Hessian of a periodic height field, 1/|det|)
 *   3. a per-world identity (gravity, pressure, temperature, liquid) -> wave scale, foam, colour, ice slush, steam, glow, rhythm
 *   4. a camera-following clip-map grid (one draw call) with morph flags so displaced level seams never crack
 *   5. a shore field (depth + eikonal travel time of the waves + depth gradient) -> shoaling, breaking, swash, wet-sand memory
 *   6. a ring of ripples, a wake ribbon, a spray pool - the small CPU-side state the shaders read as uniforms
 * Techniques (credited in CREDITS.md): Tessendorf "Simulating Ocean Water" (spectrum + Jacobian foam), Gerstner / trochoidal waves,
 * Pierson-Moskowitz / JONSWAP spectra, Gerstner-sum SSS look (Atlas / Black Flag talk), clipmaps (Losasso & Hoppe), fast sweeping
 * (Zhao 2005) for the shoaling travel-time field, Kelvin wake angle, Clausius-Clapeyron boiling point.
 */
(function (root) {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;
  const PI2 = Math.PI * 2;
  const UNIT_M = 0.561;                       // metres per scene unit (Ariel is 3.26 u = 1.83 m)
  const G0 = 9.81 / UNIT_M;                   // Earth gravity in scene units / s^2

  function hashStr(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = (seed | 0) || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function ndtri(p) {                          // inverse normal CDF (Acklam), for stratified direction samples
    p = clamp(p, 1e-6, 1 - 1e-6);
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /* ───────────────────────────── 1. tiers ───────────────────────────── */
  // T: band tile texels; layers: taps per band; grid: clip-map (n cells per level, finest cell c0); disp: vertex displacement radius (0 = flat mesh)
  const TIERS = {
    low:    { bands: 1, T: [96],              layers: 1, grid: { n: 32, c0: 2.0 }, disp: 0,   shore: 0,  curl: 0, spray: 0,   ripples: 4,  causticT: 0,   detailT: 96,  foamTaps: 0, wake: 0, sss: 0, caustic: 0, glint: 1, under: 1 },
    medium: { bands: 2, T: [128, 128],        layers: 2, grid: { n: 48, c0: 1.5 }, disp: 0,   shore: 32, curl: 0, spray: 96,  ripples: 8,  causticT: 96,  detailT: 128, foamTaps: 2, wake: 1, sss: 1, caustic: 1, glint: 1, under: 1 },
    high:   { bands: 3, T: [192, 192, 128],   layers: 2, grid: { n: 64, c0: 1.0 }, disp: 110, shore: 40, curl: 3, spray: 192, ripples: 12, causticT: 128, detailT: 128, foamTaps: 3, wake: 1, sss: 1, caustic: 1, glint: 1, under: 1 },
    ultra:  { bands: 3, T: [256, 256, 192],   layers: 2, grid: { n: 64, c0: 1.0 }, disp: 140, shore: 48, curl: 5, spray: 320, ripples: 16, causticT: 128, detailT: 128, foamTaps: 3, wake: 1, sss: 1, caustic: 1, glint: 1, under: 1 }
  };
  const TIER_ORDER = ['low', 'medium', 'high', 'ultra'];
  // preset name (+ phone flag) -> the tier config actually used. Phones cap at 'high' and trim the pools (memory pressure kills tabs).
  function tierFor(preset, mobile) {
    let name = TIERS[preset] ? preset : 'medium';
    if (mobile && TIER_ORDER.indexOf(name) > 2) name = 'high';
    const t = Object.assign({}, TIERS[name]); t.name = name; t.mobile = !!mobile;
    if (mobile) { t.spray = Math.round(t.spray * 0.6); t.ripples = Math.min(t.ripples, 12); t.T = t.T.map((v) => Math.min(v, 192)); t.shore = Math.min(t.shore, 40); t.bakeMs = 2; } else t.bakeMs = 3;
    return t;
  }
  function tierBytes(t) {                      // GPU bytes of the baked textures (RGBA8 + mips) - for DMCrumb.gpu and the memory test
    let b = 0; t.T.forEach((s) => { b += s * s * 4 * 1.34; });
    b += t.detailT * t.detailT * 4 * 1.34; b += (t.causticT || 0) * (t.causticT || 0) * 4 * 1.34;
    b += (t.shore || 0) * (t.shore || 0) * 8; return Math.round(b);
  }

  /* ───────────────────────────── 2. world wind + per-planet identity ───────────────────────────── */
  // the same recipe ui/dm-fluid-world.js uses for the dust (so the sea and the dust agree on where the wind blows)
  function h1(n) { n = (n | 0) * 374761393; n = (n ^ (n >>> 13)) * 1274126177; return (((n ^ (n >>> 16)) >>> 0) / 4294967296); }
  function windFor(seed, t) {
    const a = h1(seed) * 6.283 + 0.8 * Math.sin(t / 173) + 0.35 * Math.sin(t / 61 + 1.3);
    const gust = Math.max(0, Math.sin(t / 7.3) * Math.sin(t / 3.1 + 0.7));
    return { x: Math.cos(a), z: Math.sin(a), s: 4.2 + 2.2 * Math.pow(Math.sin(t / 37), 2) + 3.5 * gust, ang: a };
  }
  const PRESSURE_BY_NAME = { Earth: 1.0, Mars: 0.006, Venus: 92, Titan: 1.45, Solenne: 1.08 };
  const PRESSURE_BY_TYPE = { Habitable: 1.0, Ocean: 1.4, Methane: 1.45, Desert: 0.7, Ice: 0.5, Volcanic: 3.0, Rocky: 0, 'Barren Moon': 0 };
  const TEMP_BY_NAME = { Earth: 288, Mars: 210, Venus: 735, Titan: 94, Solenne: 292 };
  const TEMP_BY_TYPE = { Habitable: 288, Ocean: 296, Methane: 94, Desert: 318, Ice: 228, Volcanic: 560, Rocky: 250, 'Barren Moon': 200 };
  // liquids: rho (water = 1), mu (viscosity LOOK 0..1), melt / boil K at 1 atm, latent heat J/mol, absorption (1/unit, rgb), foam gain, hex colours
  const LIQUIDS = {
    water:   { rho: 1.0,  mu: 0.05, melt: 273.15, boil: 373.15, dH: 40660, abs: [0.34, 0.052, 0.022], foam: 1.0,  foamTau: 4.0,  scatter: 0x1fd6b8, foamCol: 0xf4fbff, deep: 0x1a4a7a },
    methane: { rho: 0.42, mu: 0.02, melt: 90.7,   boil: 111.7, dH: 8200,  abs: [0.16, 0.30, 0.46],   foam: 0.45, foamTau: 2.2,  scatter: 0x7fc9a0, foamCol: 0xd9e6c8, deep: 0x4a8a7a },
    ammonia: { rho: 0.68, mu: 0.08, melt: 195.4,  boil: 239.8, dH: 23300, abs: [0.10, 0.12, 0.42],   foam: 0.7,  foamTau: 3.0,  scatter: 0xd8e08a, foamCol: 0xfff6d8, deep: 0x7a8a3a },
    lava:    { rho: 2.6,  mu: 0.97, melt: 1400,   boil: 3000,  dH: 200000, abs: [0.02, 0.2, 0.9],    foam: 0.12, foamTau: 30.0, scatter: 0xff6a1a, foamCol: 0x2a1410, deep: 0x3a0e06 }
  };
  const boilK = (L, P) => (P <= 1e-6 ? 0 : 1 / (1 / L.boil - (8.314 / L.dH) * Math.log(P)));   // Clausius-Clapeyron

  function rgbOf(hex) { return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; }
  function lerp3(a, b, t) { return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]; }

  // body: catalog body {name,type,gravity,surface?}; pal: getSurfacePalette(body); o: {seed, lat, unitM}.  Deterministic.
  function identityFor(body, pal, o) {
    body = body || {}; pal = pal || {}; o = o || {};
    const name = body.name || '', type = body.type || 'Habitable', surf = body.surface || {};
    const seed = (o.seed != null ? o.seed | 0 : hashStr(name || type)) || 1, R = rng(seed ^ 0x5eed);
    const gRel = clamp(+(body.gravity != null ? body.gravity : (pal.grav != null ? pal.grav : 1)), 0.05, 4);
    let P = surf.pressureAtm != null ? +surf.pressureAtm : body.pressureAtm != null ? +body.pressureAtm : (PRESSURE_BY_NAME[name] != null ? PRESSURE_BY_NAME[name] : (PRESSURE_BY_TYPE[type] != null ? PRESSURE_BY_TYPE[type] : (pal.atmos ? 0.8 : 0)));
    if (pal.atmos === false) P = Math.min(P, 0.02);
    let T = surf.tempK != null ? +surf.tempK : body.tempK != null ? +body.tempK : (TEMP_BY_NAME[name] != null ? TEMP_BY_NAME[name] : (TEMP_BY_TYPE[type] != null ? TEMP_BY_TYPE[type] : 280));
    let lname = String(pal.liquidName || surf.liquidName || 'water').toLowerCase(); if (!LIQUIDS[lname]) lname = 'water';
    const L = LIQUIDS[lname], g = G0 * gRel, lat = (o.lat || 0) * Math.PI / 180;
    const Tloc = T - (name === 'Earth' ? 40 : 20) * Math.pow(Math.abs(Math.sin(lat)), 8);    // polar cooling: Earth's sea ice starts ~60 deg, solid by ~70
    const Tb = boilK(L, P);
    // freezing slush edges (cold side) and boiling steam (hot side) relative to THIS liquid's melt / boil point at THIS pressure
    const ice = lname === 'lava' ? 0 : sstep(L.melt * 1.004, L.melt * 0.974, Tloc);
    const steam = lname === 'lava' ? 0.35 : (P <= 1e-6 ? 1 : sstep(Tb * 0.9, Tb * 0.992, Tloc));
    // air density relative to Earth sea level (ideal gas, mean molar mass ~ 29 on every world: the data has no composition), liquid density relative to water
    const rhoAir = clamp(P * 288 / Math.max(60, Tloc), 0.002, 40), rhoLiq = L.rho;
    // wind: the world's wind recipe, scaled by what the air can do to THIS liquid (friction velocity ~ sqrt(rho_air / rho_liquid))
    const w0 = windFor(seed, o.t || 0);
    const couple = clamp(Math.sqrt(rhoAir / rhoLiq) / Math.sqrt(1.0 / 1.0), 0.35, 1.9);
    const windy = 0.7 + 0.7 * h1(seed * 3 + 1);                                  // each world has its own windiness (seeded)
    const Ue = w0.s * windy * (0.55 + 0.45 * couple);                                 // m/s, effective
    // Pierson-Moskowitz fully-developed sea: peak wavelength 8.17 U^2 / g, Hs 0.21 U^2 / g  (in scene units: g is in u/s^2, U/UNIT_M in u/s)
    const Uu = Ue / UNIT_M;
    let lamP = 8.17 * Uu * Uu / g, Hs = 0.21 * Uu * Uu / g;
    const mu = clamp(L.mu + (1 - clamp(rhoAir, 0, 1)) * 0.0, 0, 1);
    lamP = clamp(lamP, 12, 120); Hs = clamp(Hs, 0.12, 2.4);
    // a distant swell (long, regular, tall) rides under the local wind sea: peak ~3.4x longer, steepness 0.03 x a seeded strength; low gravity -> longer and taller
    const swellAmt = 0.55 + 0.45 * R();
    let lamS = clamp(lamP * 3.4, 56, 170), HsS = clamp(0.03 * lamS * swellAmt, 0.2, 2.6);
    if (lname === 'lava') { lamP = clamp(lamP * 0.7, 14, 50); Hs = Math.min(Hs, 1.0); lamS = clamp(lamS * 0.5, 40, 80); HsS = Math.min(HsS, 1.2); }
    if (rhoAir < 0.05) { Hs *= 0.3; HsS *= 0.6; }                            // a near-vacuum cannot raise a wind sea; only tides / swell remain
    const minLam = 0.9 + 26 * mu * mu;                                       // viscosity eats the short waves
    const chop = clamp(0.38 + 0.5 * clamp(Ue / 11, 0, 1) - 0.4 * mu, 0.1, 0.92);
    // whitecaps: need wind, air that can entrain bubbles, and a liquid that foams
    const wc = clamp(L.foam * Math.sqrt(rhoAir) * clamp((Ue - 3.2) / 8, 0.05, 1.1) * (1 - ice * 0.85), 0, 1);
    // colours
    const liq = pal.liquidColor != null ? pal.liquidColor : L.deep;
    const deep = rgbOf(liq), shallow = lerp3(deep, [0.37, 0.82, 0.78], lname === 'water' ? 0.55 : 0.3);
    let scatter = rgbOf(L.scatter), foamCol = rgbOf(L.foamCol);
    const skyArr = Array.isArray(pal.sky) ? pal.sky : [0x88bbff, 0x3a6ea5];
    const out = {
      v: 1, name, type, seed, kind: lname, liquid: lname, gRel, g, P, T, Tloc, Tb, rhoAir, rhoLiq,
      wind: { x: w0.x, z: w0.z, s: Ue, ang: w0.ang, s0: w0.s }, lamP, Hs, lamS, HsS, HsTotal: Math.sqrt(Hs * Hs + HsS * HsS), mu, minLam, chop, whitecap: wc,
      foam: { gain: L.foam, tau: L.foamTau, trail: lname === 'lava' ? 0.5 : clamp(0.1 + 0.1 * wc, 0.1, 0.22), cell: 0, lace: 1 },
      ice, steam, glow: lname === 'lava' ? 1 : 0, ice0: ice,
      colors: { deep, shallow, scatter, foam: foamCol, skyTop: rgbOf(skyArr[0]), skyHor: rgbOf(skyArr[skyArr.length - 1]), sunGlint: [1, 0.96, 0.86] },
      absorb: L.abs.slice(), sss: lname === 'water' ? 1 : lname === 'lava' ? 0.2 : 0.55, rough: 0.07 + 0.5 * mu + (lname === 'methane' ? 0.1 : 0),
      sky: pal.atmos === false ? 0.04 : 1, pattern: 'lace', pulse: 0, pulseHz: 0, sig: null,
      swell: { off: (R() - 0.5) * 1.3, amt: 0.55 + R() * 0.3 },           // a second, distant swell train: angle offset (rad) and strength
      spray: { g, hang: 1 / Math.sqrt(gRel), size: 1.0, rate: clamp(wc + 0.25, 0.2, 1) },
      crust: lname === 'lava' ? 1 : 0, swash: clamp(0.35 + 0.5 * Hs * 0.5, 0.25, 1.4), bubbly: lname === 'methane' ? 0.35 : 0
    };
    if (lname === 'methane') { out.colors.foam = rgbOf(0xcfe0c0); out.foam.lace = 0.7; }
    if (lname === 'lava') { out.pattern = 'crust'; out.colors.foam = rgbOf(0x1a0c08); out.colors.shallow = rgbOf(0xa02a08); out.colors.deep = rgbOf(0x2a0804); }
    // Earth: a realistic open-ocean preset (blue-green, white lace, turquoise crest light)
    if (name === 'Earth') { out.sig = 'earth'; out.colors.deep = rgbOf(0x0b3e66); out.colors.shallow = rgbOf(0x2fa7a8); out.colors.scatter = rgbOf(0x20e0b4); out.foam.trail = 0.16; out.wind.s = Math.max(out.wind.s, 6.2); }
    // Ariel's home planet Solenne: a luminous, designed sea - pearl-cell foam, two interleaved swells on a golden ratio, breathing
    // amplitude, bioluminescent crests and wake that glow at dusk and night, twin-sun sparkle.
    if (name === 'Solenne' || body.home || body.waterSig === 'solenne') {
      out.sig = 'solenne'; out.pattern = 'pearl';
      out.colors.deep = rgbOf(0x0c2f5a); out.colors.shallow = rgbOf(0x1ec9c4); out.colors.scatter = rgbOf(0x38ffd0); out.colors.foam = rgbOf(0xf0e8ff);
      out.glow = 1; out.glowCol = rgbOf(0x2cf0ff); out.glowCol2 = rgbOf(0xc060ff);
      out.pulse = 0.28; out.pulseHz = 1 / 13; out.golden = true; out.foam.cell = 1; out.foam.lace = 0.35; out.foam.trail = 0.2;
      out.absorb = [0.30, 0.04, 0.03]; out.twinSun = true; out.sss = 1.35;
    }
    out.glowCol = out.glowCol || out.colors.scatter; out.glowCol2 = out.glowCol2 || out.colors.scatter;
    out.maxSteep = 0.62;
    return out;
  }

  /* ───────────────────────────── 3. spectrum -> band tiles ───────────────────────────── */
  function jonswap(w, wp) { const sg = w <= wp ? 0.07 : 0.09, r = Math.exp(-((w - wp) * (w - wp)) / (2 * sg * sg * wp * wp)); return Math.pow(w, -5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(3.3, r); }

  // the band layout for a tier: wavelength range, tile world size, train count, directional spread (s of cos^2s) per band
  function bandPlan(P, tier) {
    const lp = P.lamP, ls = P.lamS, F = 3, Tm = tier.T, minL = P.minLam;
    const cap = (T) => Math.max(3, T / 12);                // largest lamMax/lamMin ratio a T-texel tile resolves (>= 4 texels per wave)
    const make = (id, lamMax, lamMin, T, N, sp, ix, peak, grp) => { lamMin = Math.max(minL, lamMin, lamMax / cap(T)); lamMax = Math.max(lamMax, lamMin * 1.4); return { id, ix, lamMax, lamMin, T, N, s: sp, S: F * lamMax, peak, grp }; };
    if (tier.bands >= 3) {
      const mid = make('mid', lp * 1.7, lp * 1.7 / 5, Tm[1], 12, 14, 1, lp, 'wind');
      return [make('swell', ls * 2.0, ls * 0.5, Tm[0], 8, 40, 0, ls, 'swell'), mid, make('chop', mid.lamMin, 0, Tm[2], 14, 6, 2, lp, 'wind')];
    }
    if (tier.bands === 2) return [make('swell', ls * 2.0, ls * 0.5, Tm[0], 8, 36, 0, ls, 'swell'), make('mid', lp * 1.7, 0, Tm[1], 16, 10, 1, lp, 'wind')];
    return [make('sea', ls * 1.5, 0, Tm[0], 14, 18, 0, ls, 'all')];
  }

  // trains of one band, quantised to the tile lattice (kx = 2 pi nx / S): an exact repeat in x and z
  function bandTrains(P, band, seedOff) {
    const R = rng(P.seed * 7 + band.ix * 977 + (seedOff | 0)), N = band.N, th0 = P.wind.ang, sigma = Math.sqrt(2 / band.s);
    const wp = Math.sqrt(P.g * PI2 / band.peak), tr = [], used = new Set();
    for (let i = 0; i < N; i++) {
      // wavelength: stratified in log space across the band; direction: stratified normal around the wind (with the second swell offset for the long band)
      const u = (i + 0.15 + 0.7 * R()) / N, lam = band.lamMin * Math.pow(band.lamMax / band.lamMin, 1 - u);
      let th = th0 + sigma * ndtri((((i * 0.618034) % 1) * 0.9 + 0.05 + 0.1 * R()));
      let amtMul = 1, lamU = lam;
      if (band.ix === 0 && band.id !== 'sea' && i % 3 === 2) { th = th0 + P.swell.off + sigma * 0.5 * ndtri(R() * 0.9 + 0.05); amtMul = P.swell.amt; }
      if (P.golden && band.ix === 0) {   // Solenne: two narrow swells at lamS and lamS*phi, ~17 deg apart; their neighbours beat into sets of waves
        const peak = (i & 1) ? P.lamS * 1.618 * 0.8 : P.lamS * 0.8, wob = 1 + 0.045 * (R() - 0.5) * 2;
        th = th0 + ((i & 1) ? 0.30 : -0.04) + 0.05 * (R() - 0.5); lamU = clamp(peak * wob, band.lamMin, band.lamMax); amtMul = 1.0;
      }
      let m = band.S / lamU, nx = Math.round(m * Math.cos(th)), nz = Math.round(m * Math.sin(th));
      let guard = 0; while ((nx === 0 && nz === 0) || used.has(nx + ',' + nz)) { nx += (guard++ & 1) ? 1 : -1; if (guard > 6) { nz += 1; } }
      used.add(nx + ',' + nz);
      const k = PI2 * Math.hypot(nx, nz) / band.S, w0 = Math.sqrt(P.g * k), wq = w0;
      const dx = nx / Math.hypot(nx, nz), dz = nz / Math.hypot(nx, nz);
      tr.push({ nx, nz, k, dx, dz, w: wq, lam: PI2 / k, ph: R() * PI2, a: 0, amt: amtMul });
    }
    // energy: JONSWAP S(w) dw per train (dw from the neighbours in w), then shaped by the cos^2s weight of its direction
    const idx = tr.map((t, i) => i).sort((a, b) => tr[a].w - tr[b].w);
    for (let j = 0; j < idx.length; j++) {
      const t = tr[idx[j]], wl = j > 0 ? tr[idx[j - 1]].w : t.w * 0.9, wh = j < idx.length - 1 ? tr[idx[j + 1]].w : t.w * 1.1;
      const dw = Math.max(1e-4, (wh - wl) * 0.5), dth = Math.acos(clamp(t.dx * Math.cos(th0) + t.dz * Math.sin(th0), -1, 1));
      const dirW = Math.pow(Math.cos(clamp(dth / 2, 0, Math.PI / 2 - 1e-3)), 2 * band.s * 0.5);
      t.a = Math.sqrt(2 * jonswap(t.w, wp) * dw) * (0.4 + 0.6 * dirW) * t.amt;
    }
    return tr;
  }
  // all bands, with amplitudes normalised to the world's Hs and limited so the summed steepness cannot loop the surface
  function buildSpectrum(P, tier) {
    const plan = bandPlan(P, tier), bands = [], BUD = { swell: 0.22, mid: 0.30, chop: 0.24, sea: 0.5 }, k0 = (P.maxSteep || 0.62) / 0.62;
    plan.forEach((b) => { bands.push(Object.assign({ trains: bandTrains(P, b) }, b)); });
    // energy per group: the swell band carries the swell Hs, everything else the wind sea (or one band carries both on Low)
    const grp = { swell: [], wind: [], all: [] }; bands.forEach((b) => grp[b.grp].push(b));
    const target = { swell: P.HsS, wind: P.Hs, all: P.HsTotal };
    for (const g in grp) {
      if (!grp[g].length) continue; let e = 0; grp[g].forEach((b) => b.trains.forEach((t) => { e += 0.5 * t.a * t.a; }));
      const sc = (target[g] / 4) / Math.sqrt(Math.max(e, 1e-12)); grp[g].forEach((b) => b.trains.forEach((t) => { t.a *= sc; }));
    }
    // steepness budget per band (the short bands would loop the surface): scale a band down when its sum of a*k passes its share
    let steep = 0;
    bands.forEach((b) => {
      let sk = 0; b.trains.forEach((t) => { sk += t.a * t.k; });
      const lim = (BUD[b.id] || 0.3) * k0; if (sk > lim) { const f = lim / sk; b.trains.forEach((t) => { t.a *= f; }); sk = lim; }
      steep += sk;
    });
    bands.forEach((b) => {
      let hm = 0, sm = 0, wsum = 0, kw = 0, vx = 0, vz = 0, ls = 0;
      b.trains.forEach((t) => { hm += t.a; sm += t.a * t.k; wsum += t.a * t.a; kw += t.a * t.a * t.w / t.k; vx += t.a * t.a * t.dx; vz += t.a * t.a * t.dz; ls += t.a * t.a * t.lam; });
      const vl = Math.hypot(vx, vz) || 1;
      b.hmax = Math.max(hm, 1e-6); b.smax = Math.max(sm, 1e-6); b.c = kw / Math.max(wsum, 1e-12); b.dir = [vx / vl, vz / vl]; b.lamMean = ls / Math.max(wsum, 1e-12);
      b.chop = P.chop;
    });
    return { bands, plan, steepness: steep, Hs: P.HsTotal };
  }

  /* ───────────────────────────── 4. band bake (generator, 2-3 ms slices) ───────────────────────────── */
  // out: Uint8Array/Uint8ClampedArray T*T*4.  R=slope x, G=slope z (0.5 = flat), B=height (0.5 = mean), A = whitecap potential (1 = most likely to break).
  function* bakeBand(band, T, out, rowsPerYield, opts) {
    opts = opts || {};
    const N = T * T, trains = band.trains, nt = trains.length, cosT = new Float32Array(T), sinT = new Float32Array(T);
    for (let i = 0; i < T; i++) { cosT[i] = Math.cos(PI2 * i / T); sinT[i] = Math.sin(PI2 * i / T); }
    const J = new Float32Array(N), hmax = band.hmax, smax = band.smax, Q = band.chop != null ? band.chop : 0.6, rows = rowsPerYield || 16;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        let h = 0, sx = 0, sz = 0, jxx = 0, jzz = 0, jxz = 0;
        for (let q = 0; q < nt; q++) {
          const t = trains[q], ix = ((t.nx * x + t.nz * y) % T + T) % T, c0 = cosT[ix], s0 = sinT[ix];
          // phase offset t.ph applied by the angle-sum identity (no trig per texel)
          const cp = t.cph !== undefined ? t.cph : (t.cph = Math.cos(t.ph)), sp = t.sph !== undefined ? t.sph : (t.sph = Math.sin(t.ph));
          const c = c0 * cp - s0 * sp, s = s0 * cp + c0 * sp;
          const a = t.a, ak = a * t.k;
          h += a * c; sx -= ak * t.dx * s; sz -= ak * t.dz * s;
          jxx += Q * ak * t.dx * t.dx * c; jzz += Q * ak * t.dz * t.dz * c; jxz += Q * ak * t.dx * t.dz * c;
        }
        const i = y * T + x, k4 = i * 4;
        out[k4] = clamp(Math.round(128 + 127 * sx / smax), 0, 255); out[k4 + 1] = clamp(Math.round(128 + 127 * sz / smax), 0, 255); out[k4 + 2] = clamp(Math.round(128 + 127 * h / hmax), 0, 255);
        J[i] = (1 - jxx) * (1 - jzz) - jxz * jxz;
      }
      if ((y + 1) % rows === 0) yield;
    }
    // whitecap potential: rank of the Jacobian (lowest 28% of the tile -> 1..0), then the persistent trail of foam left behind the crests
    const hist = new Uint32Array(1024); let jmin = 9, jmax = -9;
    for (let i = 0; i < N; i++) { const v = J[i]; if (v < jmin) jmin = v; if (v > jmax) jmax = v; }
    const span = Math.max(jmax - jmin, 1e-6);
    for (let i = 0; i < N; i++) hist[Math.min(1023, Math.floor((J[i] - jmin) / span * 1023.999))]++;
    const cdf = new Float32Array(1024); let acc = 0; for (let b = 0; b < 1024; b++) { acc += hist[b]; cdf[b] = acc / N; }
    const pot = new Float32Array(N);
    for (let i = 0; i < N; i++) { const r = cdf[Math.min(1023, Math.floor((J[i] - jmin) / span * 1023.999))]; pot[i] = Math.pow(clamp(1 - r / 0.28, 0, 1), 1.4); }
    yield;
    const taps = opts.foamTaps | 0, texPerUnit = T / band.S, trailLen = (opts.trail || 0.16) * band.lamMean, dx = band.dir[0], dz = band.dir[1];
    const fin = new Float32Array(N); fin.set(pot);
    for (let j = 1; j <= taps; j++) {
      const d = trailLen * j / taps * texPerUnit, w = Math.exp(-1.6 * j / taps), ox = -dx * d, oz = -dz * d;   // behind the crest = against the travel direction... sampled ahead of the pixel
      for (let y = 0; y < T; y++) {
        const fy = y - oz, y0 = Math.floor(fy), ty = fy - y0, ya = ((y0 % T) + T) % T, yb = (ya + 1) % T;
        for (let x = 0; x < T; x++) {
          const fx = x - ox, x0 = Math.floor(fx), tx = fx - x0, xa = ((x0 % T) + T) % T, xb = (xa + 1) % T;
          const v = mix(mix(pot[ya * T + xa], pot[ya * T + xb], tx), mix(pot[yb * T + xa], pot[yb * T + xb], tx), ty) * w;
          if (v > fin[y * T + x]) fin[y * T + x] = v;
        }
        if ((y + 1) % (rows * 2) === 0) yield;
      }
    }
    for (let i = 0; i < N; i++) out[i * 4 + 3] = clamp(Math.round(fin[i] * 255), 0, 255);
  }
  function bakeBandSync(band, T, opts) { const out = new Uint8ClampedArray(T * T * 4), g = bakeBand(band, T, out, 32, opts); while (!g.next().done); return out; }

  // CPU mirror of the shader's layer transform (so a swimmer, the board and the spray ride the SAME surface the GPU draws)
  const LAYERS = [{ s: 1.0, rot: 0.0, f: 1.0, w: 0.78 }, { s: 1.37, rot: 0.61, f: 0.77, w: 0.62 }];
  function bilin(tile, T, u, v, ch) {
    u = (u - Math.floor(u)) * T - 0.5; v = (v - Math.floor(v)) * T - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0, xa = ((x0 % T) + T) % T, xb = (xa + 1) % T, ya = ((y0 % T) + T) % T, yb = (ya + 1) % T;
    const a = tile[(ya * T + xa) * 4 + ch], b = tile[(ya * T + xb) * 4 + ch], c = tile[(yb * T + xa) * 4 + ch], d = tile[(yb * T + xb) * 4 + ch];
    return mix(mix(a, b, fx), mix(c, d, fx), fy) / 255;
  }
  // tile coordinate of world (x,z) for layer L of a band at time t; windRot = the slow rotation of the wind away from the baked direction
  function layerUV(band, L, x, z, t, windRot) {
    const cr = Math.cos(windRot || 0), sr = Math.sin(windRot || 0), wx = x * cr - z * sr, wz = x * sr + z * cr;
    const ly = LAYERS[L], px = wx - band.dir[0] * band.c * ly.f * t, pz = wz - band.dir[1] * band.c * ly.f * t;
    const c2 = Math.cos(ly.rot), s2 = Math.sin(ly.rot), rx = px * c2 - pz * s2, rz = px * s2 + pz * c2, S = band.S * ly.s;
    return [rx / S, rz / S];
  }
  // sea-surface height above the sea level at (x,z,t): the model {bands:[{band,tile,T}], layers, amp, windRot}
  function heightAt(model, x, z, t) {
    let h = 0; const nl = model.layers || 2;
    for (const b of model.bands) for (let L = 0; L < nl; L++) { const uv = layerUV(b.band, L, x, z, t, model.windRot); h += (bilin(b.tile, b.T, uv[0], uv[1], 2) * 2 - 1) * b.band.hmax * LAYERS[L].w; }
    return h * (model.amp == null ? 1 : model.amp);
  }
  function slopeAt(model, x, z, t) {
    let sx = 0, sz = 0; const nl = model.layers || 2, cr = Math.cos(model.windRot || 0), sr = Math.sin(model.windRot || 0);
    for (const b of model.bands) for (let L = 0; L < nl; L++) {
      const uv = layerUV(b.band, L, x, z, t, model.windRot), ly = LAYERS[L], gx = (bilin(b.tile, b.T, uv[0], uv[1], 0) * 2 - 1) * b.band.smax * ly.w / ly.s, gz = (bilin(b.tile, b.T, uv[0], uv[1], 1) * 2 - 1) * b.band.smax * ly.w / ly.s;
      const c2 = Math.cos(ly.rot), s2 = Math.sin(ly.rot), ax = gx * c2 + gz * s2, az = -gx * s2 + gz * c2;   // R_L^T g
      sx += ax * cr + az * sr; sz += -ax * sr + az * cr;                                                       // back through the wind rotation
    }
    const a = model.amp == null ? 1 : model.amp; return { sx: sx * a, sz: sz * a };
  }

  /* ───────────────────────────── 5. detail tile + caustics ───────────────────────────── */
  const wrap = (i, n) => ((i % n) + n) % n;
  function h2(x, y, s) { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647) + 1013904223) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h = (h ^ (h >>> 16)) >>> 0; return h / 4294967296; }
  const quint = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function vn(x, y, P, s) { const ix = Math.floor(x), iy = Math.floor(y), fx = quint(x - ix), fy = quint(y - iy), x0 = wrap(ix, P), x1 = wrap(ix + 1, P), y0 = wrap(iy, P), y1 = wrap(iy + 1, P); return mix(mix(h2(x0, y0, s), h2(x1, y0, s), fx), mix(h2(x0, y1, s), h2(x1, y1, s), fx), fy); }
  function fbm(u, v, P, oct, s) { let a = 0.5, t = 0, n = 0, p = P; for (let i = 0; i < oct; i++) { t += a * vn(u * p, v * p, p, s + i * 31); n += a; a *= 0.5; p *= 2; } return t / n; }
  // Worley: F1 and F2 on a periodic N x N cell grid
  function worley(u, v, N, s) {
    const x = u * N, y = v * N, ix = Math.floor(x), iy = Math.floor(y); let d1 = 9, d2 = 9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const gx = ix + ox, gy = iy + oy, wx = wrap(gx, N), wy = wrap(gy, N), fx = gx + 0.2 + 0.6 * h2(wx, wy, s) - x, fy = gy + 0.2 + 0.6 * h2(wx, wy, s + 77) - y, d = Math.sqrt(fx * fx + fy * fy); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
    return [d1, d2];
  }
  // detail tile RGBA8: R lace foam (warped billows, soft), G pearl cells (F2-F1 edges inverted: bubbles), B/A micro-slope noise x/z. Tileable.
  function* bakeDetail(T, out, seed, rowsPerYield) {
    const rows = rowsPerYield || 16;
    for (let y = 0; y < T; y++) {
      const v = y / T;
      for (let x = 0; x < T; x++) {
        const u = x / T;
        const wu = u + 0.09 * (fbm(u, v, 4, 2, seed + 1) - 0.5), wv = v + 0.09 * (fbm(u, v, 4, 2, seed + 2) - 0.5);
        const c = worley(wu, wv, 8, seed + 3), fil = 1 - sstep(0.0, 0.3, c[1] - c[0]);                         // filaments along the cell borders ...
        const bil = fbm(wu, wv, 5, 4, seed + 4), lace2 = sstep(0.34, 0.74, bil * 0.62 + fil * 0.5);               // ... carried by organic billows: patches with ragged lace edges
        const pc = worley(u, v, 6, seed + 5), pearl = 1 - sstep(0.0, 0.5, pc[0]) * 0.9;                       // round bubble cells (centre bright)
        const gxn = fbm(u, v, 24, 2, seed + 6), gzn = fbm(u, v, 24, 2, seed + 7), i4 = (y * T + x) * 4;
        out[i4] = clamp(Math.round(lace2 * 255), 0, 255); out[i4 + 1] = clamp(Math.round(pearl * 255), 0, 255); out[i4 + 2] = Math.round(gxn * 255); out[i4 + 3] = Math.round(gzn * 255);
      }
      if ((y + 1) % rows === 0) yield;
    }
  }
  // caustics: refract through a periodic height field (sum of lattice sines, analytic Hessian) onto a plane `depth` below; light density = 1 / |det(I + d H)|.
  // R/G/B use slightly different depths (dispersion). Tileable. out RGBA8 (A = 255).
  function* bakeCaustics(T, out, seed, rowsPerYield) {
    const R = rng(seed ^ 0xca57), terms = [];
    for (let i = 0; i < 14; i++) { const m = 1 + R() * 3.4, th = R() * PI2; terms.push({ nx: Math.round(m * Math.cos(th) * 2) || 1, nz: Math.round(m * Math.sin(th) * 2) || 1, amp: 0.55 / (1 + 0.55 * Math.hypot(m, 0)) * (0.6 + R() * 0.8), ph: R() * PI2 }); }
    const rows = rowsPerYield || 16, depths = [0.0042, 0.0046, 0.0050], vals = new Float32Array(T * T * 3);
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        let hxx = 0, hzz = 0, hxz = 0;
        for (let q = 0; q < terms.length; q++) {
          const t = terms[q], ph = PI2 * (t.nx * x + t.nz * y) / T + t.ph, c = Math.cos(ph), kx = PI2 * t.nx, kz = PI2 * t.nz, a = -t.amp * c;
          hxx += a * kx * kx; hzz += a * kz * kz; hxz += a * kx * kz;
        }
        for (let ch = 0; ch < 3; ch++) {
          const d = depths[ch] * 0.5, det = (1 + d * hxx) * (1 + d * hzz) - d * d * hxz * hxz;
          vals[(y * T + x) * 3 + ch] = 1 / (Math.abs(det) + 0.05);
        }
      }
      if ((y + 1) % rows === 0) yield;
    }
    let mean = 0; for (let i = 0; i < vals.length; i++) mean += vals[i]; mean /= vals.length;
    for (let i = 0; i < T * T; i++) for (let ch = 0; ch < 3; ch++) { const v = vals[i * 3 + ch] / mean; out[i * 4 + ch] = clamp(Math.round(Math.pow(clamp(v * 0.38, 0, 1), 1.25) * 255), 0, 255); out[i * 4 + 3] = 255; }
  }

  /* ───────────────────────────── 6. clip-map grid ───────────────────────────── */
  // Concentric square rings, cell size doubling per level. Level l covers +-n*c0*2^l/2 minus the finer level inside it.
  // attributes: pos (x,z in the level's own frame), lvl (snap quantum 2*cell of that level), morph (dx,dz): the odd nodes on the OUTER edge of a level
  // (not the last) carry the unit step along the edge so the vertex shader can pull them to the average of their two even neighbours (no cracks).
  function clipmap(n, c0, levels) {
    const pos = [], lvl = [], morph = [], idx = [], H = n / 2;
    for (let l = 0; l < levels; l++) {
      const c = c0 * Math.pow(2, l), q = 2 * c, map = new Map();
      const node = (i, j) => {
        const key = i + ',' + j; let id = map.get(key); if (id !== undefined) return id;
        id = pos.length / 2; map.set(key, id); pos.push(i * c, j * c); lvl.push(q);
        let mx = 0, mz = 0;
        if (l < levels - 1) { if (Math.abs(j) === H && (i & 1)) mx = 1; else if (Math.abs(i) === H && (j & 1)) mz = 1; }
        morph.push(mx, mz); return id;
      };
      const hole = l === 0 ? 0 : n / 4;           // the finer level (half the extent) sits in the middle: skip its cells
      for (let j = -H; j < H; j++) for (let i = -H; i < H; i++) {
        if (l > 0 && i >= -hole && i < hole && j >= -hole && j < hole) continue;
        const a = node(i, j), b = node(i + 1, j), d = node(i, j + 1), e = node(i + 1, j + 1);
        // alternate the diagonal so the mesh is symmetric
        if (((i + j) & 1) === 0) idx.push(a, d, b, b, d, e); else idx.push(a, d, e, a, e, b);
      }
    }
    return { pos: new Float32Array(pos), lvl: new Float32Array(lvl), morph: new Float32Array(morph), index: pos.length / 2 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), levels, n, c0, half: n * c0 * Math.pow(2, levels - 1) / 2 };
  }
  function levelsFor(n, c0, want) { let l = 1; while (n * c0 * Math.pow(2, l - 1) < want) l++; return l; }

  /* ───────────────────────────── 7. shore field (depth, wave travel time, gradient) ───────────────────────────── */
  // depth: Float32Array N*N (sea level - ground height, > 0 under water); returns T (seconds the wave takes from deep water, eikonal |grad T| = 1/c, c = sqrt(g d)) by fast sweeping
  function eikonal(depth, N, cell, g, dDeep, out) {
    const Tm = out || new Float32Array(N * N), BIG = 1e9;
    for (let i = 0; i < N * N; i++) Tm[i] = depth[i] >= dDeep ? 0 : BIG;
    const spd = (d) => Math.sqrt(g * Math.max(d, 0.04)), upd = (x, y) => {
      const i = y * N + x; if (depth[i] >= dDeep) return;
      const a = Math.min(x > 0 ? Tm[i - 1] : BIG, x < N - 1 ? Tm[i + 1] : BIG), b = Math.min(y > 0 ? Tm[i - N] : BIG, y < N - 1 ? Tm[i + N] : BIG);
      const f = cell / spd(depth[i]); let t;
      if (Math.abs(a - b) >= f) t = Math.min(a, b) + f; else t = 0.5 * (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b)));
      if (t < Tm[i]) Tm[i] = t;
    };
    for (let s = 0; s < 2; s++) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) upd(x, y);
      for (let y = 0; y < N; y++) for (let x = N - 1; x >= 0; x--) upd(x, y);
      for (let y = N - 1; y >= 0; y--) for (let x = 0; x < N; x++) upd(x, y);
      for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) upd(x, y);
    }
    for (let i = 0; i < N * N; i++) if (Tm[i] >= BIG) Tm[i] = 0;
    return Tm;
  }
  // wave height as the sea shoals: Green's law H ~ d^-1/4 from deep water, limited by the breaker index H <= 0.78 d. Returns {H, breaking 0..1}
  function shoal(H0, d, lam) {
    const d0 = lam * 0.5; if (d >= d0) return { H: H0, breaking: 0 };
    let H = H0 * Math.pow(d0 / Math.max(d, 0.05), 0.25); const lim = 0.78 * Math.max(d, 0);
    const ratio = lim > 0 ? H / lim : 9; const br = sstep(0.8, 1.0, ratio);
    return { H: Math.min(H, lim) , breaking: br, ratio };
  }
  // swash: run-up height above the still waterline as a function of the shore phase u in [0,1): quick rush up, slow backwash
  function swashProfile(u) { u = u - Math.floor(u); return u < 0.22 ? Math.sin(u / 0.22 * Math.PI / 2) : Math.pow(1 - (u - 0.22) / 0.78, 1.7); }
  // high-water memory: the damp band left on the sand. wetTop rises with the run-up and falls slowly (dry time seconds)
  function wetStep(wetTop, runup, dt, dry) { const fall = wetTop - dt * (wetTop / Math.max(dry, 1) + 0.02); return Math.max(fall, runup); }

  /* ───────────────────────────── 8. ripples (CPU ring) ───────────────────────────── */
  function Ripples(n) {
    this.n = n; this.d = new Float32Array(n * 4); this.k = new Float32Array(n); this.next = 0;   // d: x z t0 amp ; k: ring speed
    for (let i = 0; i < n; i++) this.d[i * 4 + 3] = 0;
  }
  Ripples.prototype.spawn = function (x, z, amp, t, speed) { const i = this.next; this.next = (i + 1) % this.n; this.d[i * 4] = x; this.d[i * 4 + 1] = z; this.d[i * 4 + 2] = t; this.d[i * 4 + 3] = amp; this.k[i] = speed || 1.6; return i; };
  Ripples.RMAX_AGE = 3.4; Ripples.WL = 0.62;
  // height and d(height)/d(distance) of one ripple at distance d, age a (the shader mirrors this)
  Ripples.profile = function (d, a, amp, c) {
    if (a < 0 || a > Ripples.RMAX_AGE || amp <= 0) return [0, 0];
    const u = d - c * a, w = 0.32 + 0.55 * Math.sqrt(a), kw = PI2 / Ripples.WL, e0 = amp * Math.exp(-a * 1.15) * (1 - sstep(Ripples.RMAX_AGE - 0.8, Ripples.RMAX_AGE, a));
    const q = 1 + 2.2 * d, E = e0 / Math.sqrt(q), dE = -1.1 * e0 / (q * Math.sqrt(q));      // 1/sqrt spreading of a ring
    const g = Math.exp(-(u * u) / (w * w)), cs = Math.cos(kw * u), sn = Math.sin(kw * u);
    return [E * g * cs, dE * g * cs + E * g * (-2 * u / (w * w) * cs - kw * sn)];
  };
  Ripples.prototype.gradAt = function (x, z, t) {
    let gx = 0, gz = 0, h = 0;
    for (let i = 0; i < this.n; i++) {
      const amp = this.d[i * 4 + 3]; if (amp <= 0) continue; const dx = x - this.d[i * 4], dz = z - this.d[i * 4 + 1], d = Math.hypot(dx, dz) + 1e-4;
      const r = Ripples.profile(d, t - this.d[i * 4 + 2], amp, this.k[i]); h += r[0]; gx += r[1] * dx / d; gz += r[1] * dz / d;
    }
    return { h, gx, gz };
  };
  Ripples.prototype.live = function (t) { let c = 0; for (let i = 0; i < this.n; i++) if (this.d[i * 4 + 3] > 0 && t - this.d[i * 4 + 2] < Ripples.RMAX_AGE) c++; return c; };

  /* ───────────────────────────── 9. wake ribbon (CPU history) ───────────────────────────── */
  // points x,z,t,speed,width ring; ribbon(…) writes the vertex strip into a Float32Array (no allocation)
  function Wake(n) { this.n = n; this.p = new Float32Array(n * 5); this.head = 0; this.count = 0; this.last = -1e9; }
  Wake.KELVIN = Math.tan(19.47 * Math.PI / 180);
  Wake.prototype.push = function (x, z, t, speed, width) { const i = this.head; this.head = (i + 1) % this.n; this.count = Math.min(this.n, this.count + 1); const o = i * 5; this.p[o] = x; this.p[o + 1] = z; this.p[o + 2] = t; this.p[o + 3] = speed; this.p[o + 4] = width; this.last = t; };
  Wake.prototype.clear = function () { this.count = 0; this.last = -1e9; };
  // vertices per history point: 5 across (arm L, edge L, core, edge R, arm R). out: [x, z, u(across -1..1), v(age 0..1), intensity] * 5 * points. Returns points written.
  Wake.prototype.ribbon = function (out, t, life) {
    let w = 0; const n = this.count;
    for (let k = 0; k < n; k++) {
      const i = (this.head - 1 - k + this.n * 2) % this.n, o = i * 5, age = t - this.p[o + 2]; if (age > life) break;
      const x = this.p[o], z = this.p[o + 1], spd = this.p[o + 3], wd = this.p[o + 4];
      // direction from the next-older point (or the newer one for the head)
      let dx = 0, dz = 0; const j = (i - 1 + this.n) % this.n;
      if (k < n - 1) { dx = x - this.p[j * 5]; dz = z - this.p[j * 5 + 1]; } else if (k > 0) { const m = (i + 1) % this.n; dx = this.p[m * 5] - x; dz = this.p[m * 5 + 1] - z; }
      const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl; const nx = -dz, nz = dx;
      const a01 = age / life, spread = wd * 0.5 + age * Wake.KELVIN * Math.min(spd, 14) * 0.55, fade = Math.pow(1 - a01, 1.4) * clamp(spd / 3.5, 0, 1);
      const us = [-1, -0.45, 0, 0.45, 1], ws = [spread, wd * 0.5 + (spread - wd * 0.5) * 0.3, 0, wd * 0.5 + (spread - wd * 0.5) * 0.3, spread];
      for (let c = 0; c < 5; c++) {
        const side = us[c] < 0 ? -1 : us[c] > 0 ? 1 : 0, off = side * ws[c], b = w * 5;
        out[b] = x + nx * off; out[b + 1] = z + nz * off; out[b + 2] = us[c]; out[b + 3] = a01;
        out[b + 4] = fade * (c === 2 ? 0.95 : (c === 1 || c === 3) ? 0.5 : 0.7); w++;
      }
    }
    return w / 5;
  };

  /* ───────────────────────────── 10. spray pool (CPU ballistic particles; the flipbook is the look) ───────────────────────────── */
  function Spray(n) {
    this.n = n; this.p = new Float32Array(n * 4); this.v = new Float32Array(n * 3); this.m = new Float32Array(n * 4);   // p: x y z size ; v ; m: age life type rot
    this.alive = 0; this.next = 0;
    for (let i = 0; i < n; i++) this.m[i * 4 + 1] = 0;
  }
  Spray.prototype.spawn = function (x, y, z, vx, vy, vz, size, life, type, rot) {
    // reuse a dead slot (scan from `next`); if all are alive overwrite the oldest-in-order slot
    let i = this.next; for (let k = 0; k < this.n; k++) { const j = (this.next + k) % this.n; if (this.m[j * 4 + 1] <= 0) { i = j; break; } }
    this.next = (i + 1) % this.n; const o = i * 4;
    this.p[o] = x; this.p[o + 1] = y; this.p[o + 2] = z; this.p[o + 3] = size; this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.m[o] = 0; this.m[o + 1] = life; this.m[o + 2] = type; this.m[o + 3] = rot || 0; return i;
  };
  // advance; seaYAt(x,z) lets a droplet that falls back into the sea die; g = gravity (scene u/s^2, per planet), drag 1/s. Returns live count.
  Spray.prototype.step = function (dt, g, drag, seaYAt) {
    let live = 0; const dk = Math.max(0, 1 - drag * dt);
    for (let i = 0; i < this.n; i++) {
      const o = i * 4; if (this.m[o + 1] <= 0) continue;
      this.m[o] += dt; if (this.m[o] >= this.m[o + 1]) { this.m[o + 1] = 0; continue; }
      const type = this.m[o + 2], ballistic = type !== 2;                     // mist (type 2) drifts, the others fall
      if (ballistic) this.v[i * 3 + 1] -= g * dt; else this.v[i * 3 + 1] += 0.25 * dt;
      this.v[i * 3] *= dk; this.v[i * 3 + 2] *= dk; if (!ballistic) this.v[i * 3 + 1] *= dk;
      this.p[o] += this.v[i * 3] * dt; this.p[o + 1] += this.v[i * 3 + 1] * dt; this.p[o + 2] += this.v[i * 3 + 2] * dt;
      if (ballistic && type === 3 && seaYAt && this.p[o + 1] < seaYAt(this.p[o], this.p[o + 2]) && this.v[i * 3 + 1] < 0) { this.m[o + 1] = 0; continue; }
      live++;
    }
    this.alive = live; return live;
  };

  /* ───────────────────────────── exports ───────────────────────────── */
  const API = {
    VERSION: 1, UNIT_M, G0, TIERS, TIER_ORDER, tierFor, tierBytes, windFor, identityFor, LIQUIDS, boilK,
    bandPlan, buildSpectrum, bakeBand, bakeBandSync, bakeDetail, bakeCaustics, LAYERS, layerUV, heightAt, slopeAt, bilin,
    clipmap, levelsFor, eikonal, shoal, swashProfile, wetStep, Ripples, Wake, Spray,
    util: { clamp, sstep, mix, hashStr, rng, ndtri, fbm, worley, h2 }
  };
  root.DMWaterCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
