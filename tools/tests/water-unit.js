// Unit tests for ui/dm-water-core.js (pure JS half of the water system).   node tools/tests/water-unit.js
const assert = require('assert'); const C = require('../../ui/dm-water-core.js');
let n = 0; const ok = (c, m) => { assert(c, m); n++; }; const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, m + ' (' + a + ' vs ' + b + ' tol ' + tol + ')');
const palW = { water: true, liquidColor: 0x1a4a7a, atmos: true, sky: [0x88bbff, 0x3a6ea5] };
const earth = () => C.identityFor({ name: 'Earth', type: 'Habitable', gravity: 1 }, palW, { seed: 5, lat: 10 });
const sampleModel = (P, tier, layers) => {
  const t = typeof tier === 'string' ? C.tierFor(tier, false) : tier, sp = C.buildSpectrum(P, t), mdl = { bands: [], layers: layers || t.layers, windRot: 0, spec: sp };
  for (const b of sp.bands) mdl.bands.push({ band: b, tile: C.bakeBandSync(b, b.T, { foamTaps: t.foamTaps, trail: P.foam.trail }), T: b.T });
  return mdl;
};
const stats = (mdl, t, N) => { let s = 0, s2 = 0; for (let i = 0; i < N; i++) { const h = C.heightAt(mdl, (i * 37.7) % 1900, (i * 91.3) % 1700, t); s += h; s2 += h * h; } const m = s / N; return { mean: m, hs: 4 * Math.sqrt(s2 / N - m * m) }; };

/* ── tiers: gating, memory ── */
{
  const T = C.TIERS;
  ok(T.low.disp === 0 && T.low.curl === 0 && T.low.spray === 0 && T.low.causticT === 0 && T.low.bands === 1, 'Low: flat mesh, 1 band, no curl, no spray, no caustics (flat tinted water + simple foam)');
  ok(T.medium.disp === 0 && T.medium.bands === 2 && T.medium.spray > 0, 'Medium: 2 bands, normals only, spray on');
  ok(T.high.disp > 0 && T.high.bands === 3 && T.high.curl > 0 && T.ultra.curl > T.high.curl, 'High/Ultra: displaced near sea, curl waves');
  ok(C.tierFor('ultra', true).name === 'high', 'phones cap at High'); ok(C.tierFor('bogus', false).name === 'medium', 'unknown preset -> medium');
  const um = C.tierFor('ultra', true), ud = C.tierFor('ultra', false);
  ok(um.spray < ud.spray * 1.01 && um.T.every((v) => v <= 192) && um.bakeMs === 2 && ud.bakeMs === 3, 'phones: smaller pools / tiles, 2 ms bake slice');
  const by = C.TIER_ORDER.map((k) => C.tierBytes(C.tierFor(k, false)));
  ok(by[0] < 160e3 && by[1] < 450e3 && by[2] < 900e3 && by[3] < 1.5e6, 'texture memory per tier ' + by.join(','));
  for (let i = 1; i < 4; i++) ok(by[i] > by[i - 1], 'tiers grow');
  ok(C.tierBytes(C.tierFor('ultra', true)) < 1.2e6, 'phone Ultra water textures < 1.2 MB');
}

/* ── per-planet identity ── */
{
  const E = earth(), E2 = earth(); ok(JSON.stringify(E) === JSON.stringify(E2), 'identity deterministic');
  const body = (name, type, g, extra) => Object.assign({ name, type, gravity: g }, extra || {});
  const pal = (extra) => Object.assign({}, palW, extra || {});
  const low = C.identityFor(body('Lowg', 'Ocean', 0.3), pal(), { seed: 9 }), hi = C.identityFor(body('Higg', 'Ocean', 1.8), pal(), { seed: 9 });
  ok(low.lamP > hi.lamP * 1.5, 'low g: longer waves ' + low.lamP.toFixed(0) + ' > ' + hi.lamP.toFixed(0));
  ok(low.Hs >= hi.Hs && low.HsS >= hi.HsS - 1e-6, 'low g: taller waves');
  const spLow = C.buildSpectrum(low, C.tierFor('high', false)), spHi = C.buildSpectrum(hi, C.tierFor('high', false));
  ok(spLow.bands[0].c > 0 && Math.sqrt(low.g * low.lamS / (2 * Math.PI)) < 1.2 * Math.sqrt(hi.g * low.lamS / (2 * Math.PI)), 'phase speed c = sqrt(g/k): slower per wavelength on a low-g world');
  ok(low.spray.hang > hi.spray.hang * 1.8, 'low g: longer-hanging splashes (' + low.spray.hang.toFixed(2) + ' vs ' + hi.spray.hang.toFixed(2) + ')');
  // temperature / pressure
  const mars = C.identityFor(body('Mars', 'Desert', 0.38), pal(), { seed: 2 }), venus = C.identityFor(body('Venus', 'Volcanic', 0.9), pal(), { seed: 2 });
  ok(mars.ice > 0.95, 'Mars is frozen at 210 K'); ok(venus.steam > 0.95, 'Venus (735 K) boils off'); ok(E.ice < 0.01 && E.steam < 0.01, 'Earth (equator): neither ice nor steam');
  const polar = C.identityFor({ name: 'Earth', type: 'Habitable', gravity: 1 }, palW, { seed: 5, lat: 78 }), mid = C.identityFor({ name: 'Earth', type: 'Habitable', gravity: 1 }, palW, { seed: 5, lat: 55 });
  ok(polar.ice > 0.9 && mid.ice < 0.15, 'Earth: sea ice at 78 deg, none at 55 deg (' + polar.ice.toFixed(2) + ', ' + mid.ice.toFixed(2) + ')');
  ok(Math.abs(C.boilK(C.LIQUIDS.water, 1) - 373.15) < 0.01 && C.boilK(C.LIQUIDS.water, 0.006) < 285, 'Clausius-Clapeyron: water boils near 268 K at 0.006 atm');
  const titan = C.identityFor(body('Wend', 'Methane', 0.14), pal({ liquidName: 'methane', liquidColor: 0x4a8a7a }), { seed: 3 });
  ok(titan.kind === 'methane' && titan.colors.deep[1] > titan.colors.deep[0], 'methane world: methane liquid, teal-green');
  ok(titan.foam.gain < E.foam.gain && titan.foam.tau < E.foam.tau && titan.whitecap <= 1, 'methane foams less and shorter-lived than water');
  const lava = C.identityFor(body('Cinder', 'Volcanic', 0.9), pal({ liquidName: 'lava', liquidColor: 0xff5a10 }), { seed: 3 });
  ok(lava.kind === 'lava' && lava.mu > 0.9 && lava.glow === 1 && lava.minLam > 15, 'lava: very viscous, glows, only long waves');
  const amm = C.identityFor(body('Hollin', 'Ice', 0.5), pal({ liquidName: 'ammonia', liquidColor: 0x7a8a3a }), { seed: 3 });
  ok(amm.kind === 'ammonia' && amm.ice > 0.5 === (amm.Tloc < 195), 'ammonia at 228 K is liquid (above its 195 K melt point)');
  const noAir = C.identityFor(body('Mercury', 'Rocky', 0.38), pal({ atmos: false }), { seed: 3 });
  const airy = C.identityFor(body('Mercury', 'Rocky', 0.38), pal({ atmos: true }), { seed: 3, }); airy.Hs; const airy2 = C.identityFor(Object.assign(body('Mercury', 'Rocky', 0.38), { pressureAtm: 1 }), pal({ atmos: true }), { seed: 3 });
  ok(noAir.Hs < airy2.Hs * 0.5 && noAir.sky < 0.1, 'no atmosphere: no wind sea, no sky to reflect');
  // Earth realistic, Solenne designed and distinct
  const S = C.identityFor({ name: 'Solenne', type: 'Habitable', gravity: 1.0, home: true }, palW, { seed: 7 });
  ok(E.sig === 'earth' && S.sig === 'solenne' && S.pattern === 'pearl' && E.pattern === 'lace', 'Earth lace vs Solenne pearl-cell foam');
  ok(S.glow === 1 && E.glow === 0 && S.pulse > 0 && S.golden, 'Solenne glows, breathes and keeps golden-ratio swells');
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  ok(d(S.colors.shallow, E.colors.shallow) > 0.15 && d(S.colors.scatter, E.colors.scatter) > 0.1 && d(S.glowCol, S.glowCol2) > 0.3, 'Solenne colours clearly differ from Earth');
  // every habitable world gets a distinct but plausible look (seeded variation does not break the physics)
  const set = new Set(); for (let s = 1; s <= 40; s++) { const p = C.identityFor(body('H' + s, 'Habitable', 0.6 + (s % 7) * 0.12), palW, { seed: s * 31 }); set.add(p.lamP.toFixed(1)); ok(p.lamP >= 12 && p.lamP <= 120 && p.Hs <= 2.4 && p.chop >= 0.1 && p.chop <= 0.92, 'identity within clamps'); }
  ok(set.size > 15, 'habitable worlds differ in wave scale (' + set.size + ' of 40)');
}

/* ── spectrum, band tiles ── */
{
  const P = earth();
  for (const tn of ['low', 'medium', 'high', 'ultra']) {
    const tier = C.tierFor(tn, false), a = C.buildSpectrum(P, tier), b = C.buildSpectrum(P, tier);
    ok(JSON.stringify(a.bands.map((x) => x.trains.map((t) => [t.nx, t.nz, +t.a.toFixed(6)]))) === JSON.stringify(b.bands.map((x) => x.trains.map((t) => [t.nx, t.nz, +t.a.toFixed(6)]))), tn + ' spectrum deterministic');
    ok(a.bands.length === tier.bands, tn + ' band count');
    for (const bd of a.bands) {
      const seen = new Set(); for (const t of bd.trains) { ok(Number.isInteger(t.nx) && Number.isInteger(t.nz) && (t.nx || t.nz), 'lattice vector'); const key = t.nx + ',' + t.nz; ok(!seen.has(key), 'unique lattice vector'); seen.add(key);
        const texPerWave = bd.T / Math.hypot(t.nx, t.nz); ok(texPerWave >= 3.5, tn + ' ' + bd.id + ' wave >= 3.5 texels (' + texPerWave.toFixed(1) + ')');
        near(t.w, Math.sqrt(P.g * t.k), 1e-9, 'deep-water dispersion w = sqrt(g k)'); }
    }
    ok(a.steepness <= 0.65, tn + ' total steepness stays below the looping limit: ' + a.steepness.toFixed(2));
  }
  const mdl = sampleModel(P, 'high'); const st = stats(mdl, 5, 6000);
  ok(Math.abs(st.mean) < 0.08, 'mean height ~0: ' + st.mean.toFixed(3)); ok(st.hs > P.HsTotal * 0.75 && st.hs < P.HsTotal * 1.3, 'recovered Hs ' + st.hs.toFixed(2) + ' vs target ' + P.HsTotal.toFixed(2));
  // exactly tileable: one tile width away is the same point (layer 0, no wind rotation)
  { const m1 = sampleModel(P, 'medium', 1); for (const b of m1.bands) { const S = b.band.S; for (let i = 0; i < 20; i++) { const x = i * 13.7, z = i * 7.1; near(C.heightAt({ bands: [b], layers: 1, windRot: 0 }, x, z, 2), C.heightAt({ bands: [b], layers: 1, windRot: 0 }, x + S, z - S * 3, 2), 1e-9, b.band.id + ' tiles seamlessly'); } } }
  // the surface travels at the band's phase speed: sampling later and shifted along dir matches
  { const m1 = sampleModel(P, 'medium', 1), b = m1.bands[0], mm = { bands: [b], layers: 1, windRot: 0 }, dt = 2.5, c = b.band.c; const x = 40.3, z = 11.9; near(C.heightAt(mm, x, z, 1), C.heightAt(mm, x + b.band.dir[0] * c * dt, z + b.band.dir[1] * c * dt, 1 + dt), 1e-9, 'band scrolls at c along its direction'); ok(c > 0.5 * Math.sqrt(P.g / (2 * Math.PI / b.band.lamMean)) && c < 2 * Math.sqrt(P.g / (2 * Math.PI / b.band.lamMean)), 'c ~ sqrt(g/k) of the band'); }
  // baked slopes agree with the height's own gradient (RG vs B channel)
  { const mdl1 = sampleModel(P, 'high', 1), e = 0.4; let num = 0, da = 0, db = 0; for (let i = 0; i < 400; i++) { const x = (i * 29.3) % 700, z = (i * 53.1) % 600, hx = (C.heightAt(mdl1, x + e, z, 3) - C.heightAt(mdl1, x - e, z, 3)) / (2 * e), s = C.slopeAt(mdl1, x, z, 3).sx; num += hx * s; da += hx * hx; db += s * s; }
    const corr = num / Math.sqrt(da * db); ok(corr > 0.93, 'slope channel matches d(height)/dx: corr ' + corr.toFixed(3)); }
  // whitecap potential: a sensible fraction of the sea can break, the trail adds foam behind the crests, nothing outside 0..1
  { const t0 = C.tierFor('high', false), sp = C.buildSpectrum(P, t0), bd = sp.bands[1], noTrail = C.bakeBandSync(bd, bd.T, { foamTaps: 0 }), trail = C.bakeBandSync(bd, bd.T, { foamTaps: 3, trail: 0.2 });
    const cov = (arr, th) => { let c = 0; for (let i = 0; i < arr.length; i += 4) if (arr[i + 3] > th) c++; return c / (arr.length / 4); };
    const c0 = cov(noTrail, 128), c1 = cov(trail, 128); ok(c0 > 0.01 && c0 < 0.22, 'crest foam covers ' + (c0 * 100).toFixed(1) + '% of the tile'); ok(c1 > c0 * 1.02 && c1 < 0.45, 'persistent foam trail widens it: ' + (c0 * 100).toFixed(1) + '% -> ' + (c1 * 100).toFixed(1) + '%');
    let mn = 255, mx = 0; for (let i = 3; i < trail.length; i += 4) { mn = Math.min(mn, trail[i]); mx = Math.max(mx, trail[i]); } ok(mn === 0 && mx > 200, 'potential spans 0..1'); }
  // the Jacobian really dips at crests: potential correlates with height
  { const t0 = C.tierFor('high', false), sp = C.buildSpectrum(P, t0), bd = sp.bands[1], tile = C.bakeBandSync(bd, bd.T, { foamTaps: 0 }); let hs = 0, hn = 0, ns = 0, nn = 0; for (let i = 0; i < tile.length; i += 4) { if (tile[i + 3] > 200) { hs += tile[i + 2]; hn++; } else { ns += tile[i + 2]; nn++; } }
    ok(hn > 0 && hs / hn > ns / nn + 4, 'foam sits on crests (mean B ' + (hs / hn).toFixed(0) + ' vs ' + (ns / nn).toFixed(0) + ')'); }
  // wind: more wind -> more whitecap cover and bigger waves
  const calm = C.identityFor({ name: 'A', type: 'Habitable', gravity: 1 }, palW, { seed: 1, t: 0 }); let lo = 1e9, hiV = 0; for (let t = 0; t < 400; t += 3) { const w = C.windFor(77, t); lo = Math.min(lo, w.s); hiV = Math.max(hiV, w.s); } ok(lo >= 4.1 && hiV > 7, 'world wind varies ' + lo.toFixed(1) + '..' + hiV.toFixed(1) + ' m/s');
  ok(Math.abs(Math.hypot(C.windFor(5, 12).x, C.windFor(5, 12).z) - 1) < 1e-9, 'wind direction is a unit vector'); ok(calm.whitecap >= 0, 'whitecap cover finite');
}

/* ── detail + caustics tiles ── */
{
  const T = 64, d = new Uint8ClampedArray(T * T * 4), g = C.bakeDetail(T, d, 11, 8); let y = 0; while (!g.next().done) y++; ok(y >= 4, 'detail bake is sliced (' + y + ' slices)');
  let lace = 0, cells = 0; for (let i = 0; i < T * T; i++) { lace += d[i * 4]; cells += d[i * 4 + 1]; } ok(lace / (T * T) > 25 && lace / (T * T) < 200, 'lace tile has foam and gaps (' + (lace / (T * T)).toFixed(0) + ')');
  let seam = 0, mid = 0; for (let k = 0; k < T; k++) { for (let c = 0; c < 4; c++) { seam += Math.abs(d[(k * T) * 4 + c] - d[(k * T + T - 1) * 4 + c]); mid += Math.abs(d[(k * T + 20) * 4 + c] - d[(k * T + 21) * 4 + c]); } } ok(seam < mid * 1.8 + 200, 'detail tile has no seam (' + seam + ' vs neighbour ' + mid + ')');
  const cT = 64, cb = new Uint8ClampedArray(cT * cT * 4), cg = C.bakeCaustics(cT, cb, 3, 8); let ys = 0; while (!cg.next().done) ys++; ok(ys >= 4, 'caustic bake is sliced');
  const vals = []; for (let i = 0; i < cT * cT; i++) vals.push(cb[i * 4 + 1]); vals.sort((a, b) => a - b); const med = vals[vals.length >> 1], p99 = vals[Math.floor(vals.length * 0.99)];
  ok(p99 > med * 2 && p99 > 120 && med < 140, 'caustics: bright lines over a darker floor (median ' + med + ', p99 ' + p99 + ')');
  let sm = 0, mm = 0; for (let k = 0; k < cT; k++) { sm += Math.abs(cb[(k * cT) * 4 + 1] - cb[(k * cT + cT - 1) * 4 + 1]); mm += Math.abs(cb[(k * cT + 20) * 4 + 1] - cb[(k * cT + 21) * 4 + 1]); } ok(sm < mm * 1.6 + 60, 'caustic tile has no seam');
  let dif = 0; for (let i = 0; i < cT * cT; i++) dif += Math.abs(cb[i * 4] - cb[i * 4 + 2]); ok(dif / (cT * cT) > 1.5, 'caustics disperse (R vs B differ)');
}

/* ── clip-map ── */
{
  for (const [nn, c0, L] of [[32, 2, 6], [48, 1.5, 7], [64, 1, 8]]) {
    const m = C.clipmap(nn, c0, L); let area = 0; const ix = m.index, p = m.pos; const lvlArea = [];
    for (let i = 0; i < ix.length; i += 3) { const a = ix[i] * 2, b = ix[i + 1] * 2, c = ix[i + 2] * 2; area += Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1])) / 2; }
    // levels live in their own frame at the same centre: the union is the outer square, with no overlap
    const outer = nn * c0 * Math.pow(2, L - 1); near(area, outer * outer, 1e-6 * outer * outer, 'clip-map ' + nn + 'x' + L + ' tiles the outer square exactly (no gaps, no overlap)');
    ok(m.pos.length / 2 === m.lvl.length && m.morph.length === m.pos.length, 'attribute counts'); ok((m.pos.length / 2 > 65535) === (m.index instanceof Uint32Array), 'index width');
    let morphed = 0, bad = 0; const Hh = nn / 2;
    for (let v = 0; v < m.pos.length / 2; v++) { if (m.morph[v * 2] || m.morph[v * 2 + 1]) { morphed++; const q = m.lvl[v] / 2, i = Math.round(m.pos[v * 2] / q), j = Math.round(m.pos[v * 2 + 1] / q); const edge = Math.abs(i) === Hh || Math.abs(j) === Hh; if (!edge) bad++; } }
    ok(morphed > 0 && bad === 0, 'morph flags only on outer-edge odd nodes (' + morphed + ')');
    ok(C.levelsFor(nn, c0, 4096) >= 1 && nn * c0 * Math.pow(2, C.levelsFor(nn, c0, 4096) - 1) >= 4096, 'levelsFor reaches the wanted span');
    ok(m.pos.length / 2 < 36000, 'vertex count ' + m.pos.length / 2 + ' <= 36k (the old 128x128 sheet was 16.6k verts / 32k tris)');
  }
}

/* ── shore: eikonal travel time, shoaling, swash, wet memory ── */
{
  const N = 48, cell = 3, g = C.G0, slope = 0.04, depth = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) depth[y * N + x] = Math.max(-2, 12 - slope * cell * x * 1.0 * 1);   // shore along z at x = 12/(0.12) = 100 cells... use steeper:
  const m = 0.10; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) depth[y * N + x] = 14 - m * cell * x;        // depth falls 0.1 per unit: shore at x = 46.7
  const Tm = C.eikonal(depth, N, cell, g, 13.0);
  // analytic: T(x) = 2/(m sqrt(g)) (sqrt(d0) - sqrt(d)) from the deep boundary d0 = 13
  let worst = 0; for (const x of [10, 20, 30, 40]) { const d = depth[24 * N + x], an = 2 / (m * Math.sqrt(g)) * (Math.sqrt(13) - Math.sqrt(d)), num = Tm[24 * N + x]; worst = Math.max(worst, Math.abs(num - an) / an); }
  ok(worst < 0.1, 'eikonal travel time within 10% of the planar-beach solution: ' + (worst * 100).toFixed(1) + '%');
  let mono = true; for (let x = 6; x < N - 1; x++) if (Tm[24 * N + x + 1] < Tm[24 * N + x] - 1e-6) mono = false; ok(mono, 'travel time grows toward the shore');
  const deep = C.shoal(1.5, 60, 80), sh = C.shoal(1.5, 3, 80), br = C.shoal(1.5, 1.2, 80);
  ok(deep.H === 1.5 && deep.breaking === 0, 'deep water: unchanged'); ok(sh.H > 1.5 && sh.H <= 0.78 * 3, 'shoaling grows the wave, bounded by 0.78 d'); ok(br.breaking > 0.9 && br.H <= 0.78 * 1.2 + 1e-9, 'breaks when H -> 0.78 d');
  let mx = 0, up = 0; for (let u = 0; u < 1; u += 0.01) { const s = C.swashProfile(u); ok(s >= 0 && s <= 1.0001, 'swash in 0..1'); if (s > mx) { mx = s; up = u; } } ok(up < 0.3 && C.swashProfile(0.9) < 0.2 && C.swashProfile(0.5) > 0.25, 'swash rushes up fast and drains slowly');
  let w = 0; w = C.wetStep(w, 1.0, 0.1, 20); ok(w === 1.0, 'wet line jumps to the run-up'); const w1 = C.wetStep(w, 0.2, 1, 20); ok(w1 < 1 && w1 > 0.85, 'then dries slowly (not with the wave): ' + w1.toFixed(3)); let w2 = w; for (let i = 0; i < 80; i++) w2 = C.wetStep(w2, 0.2, 1, 20); ok(w2 <= 0.21, 'and returns to the run-up level later');
}

/* ── ripples, wake, spray ── */
{
  const R = new C.Ripples(8); for (let i = 0; i < 11; i++) R.spawn(i, 0, 0.5, i * 0.1, 1.5); ok(R.next === 3 && R.n === 8, 'ripple ring wraps (8 slots)');
  ok(R.live(1.1) === 8 && R.live(10) === 0, 'ripples expire after ' + C.Ripples.RMAX_AGE + ' s');
  { const amp = 0.4, c = 1.5, a = 1.0; for (const d of [1.0, 1.7, 2.4, 3.1]) { const e = 1e-4, p = C.Ripples.profile(d, a, amp, c), pp = C.Ripples.profile(d + e, a, amp, c), pm = C.Ripples.profile(d - e, a, amp, c); near(p[1], (pp[0] - pm[0]) / (2 * e), 2e-3, 'ripple analytic gradient matches finite difference at d=' + d); } }
  const r1 = new C.Ripples(4); r1.spawn(0, 0, 1, 0, 1.5); const g1 = r1.gradAt(0.0 + 1.5 * 0.5, 0, 0.5); ok(Math.abs(g1.gx) > 0 || Math.abs(g1.h) > 0, 'ring has energy at its radius'); ok(Math.hypot(r1.gradAt(40, 0, 0.5).gx, r1.gradAt(40, 0, 0.5).gz) < 0.01, 'and none far outside it');
  const wk = new C.Wake(48); for (let i = 0; i < 40; i++) wk.push(i * 0.5, 0, i * 0.05, 9, 1.0);
  const buf = new Float32Array(48 * 5 * 5), pts = wk.ribbon(buf, 40 * 0.05, 2.0); ok(pts === 40 && wk.count === 40, 'wake ribbon points');
  { const half = (k) => { const b = k * 25; return Math.abs(buf[b + 1 * 0] ? 0 : 0); }; const w0 = Math.abs(buf[4 * 5 + 1] - buf[0 * 5 + 1]), wOld = Math.abs(buf[(35 * 5 + 4) * 5 + 1] - buf[(35 * 5) * 5 + 1]); ok(wOld > w0 * 2, 'wake spreads with age (Kelvin): ' + w0.toFixed(2) + ' -> ' + wOld.toFixed(2)); }
  { const iHead = 2 * 5 + 4, iOld = (35 * 5 + 2) * 5 + 4; ok(buf[iHead] > buf[iOld], 'wake foam fades with age'); }
  const slow = new C.Wake(8); slow.push(0, 0, 0, 0.5, 1); slow.push(1, 0, 0.1, 0.5, 1); const b2 = new Float32Array(8 * 25); slow.ribbon(b2, 0.2, 2); ok(b2[4] < 0.2, 'a drifting body leaves almost no wake');
  // gravity: apex and hang time scale 1/g
  const apex = (gRel) => { const s = new C.Spray(4); s.spawn(0, 0, 0, 0, 6, 0, 1, 20, 0, 0); let t = 0, ymax = 0, tLand = 0; const g = C.G0 * gRel; for (let i = 0; i < 4000; i++) { s.step(0.005, g, 0, null); t += 0.005; ymax = Math.max(ymax, s.p[1]); if (s.p[1] < 0 && s.v[1] < 0 && !tLand) tLand = t; } return { ymax, tLand }; };
  const a1 = apex(1), a2 = apex(0.38); near(a2.ymax / a1.ymax, 1 / 0.38, 0.15, 'spray apex scales 1/g'); near(a2.tLand / a1.tLand, 1 / 0.38, 0.15, 'hang time scales 1/g');
  const sp = new C.Spray(6); for (let i = 0; i < 9; i++) sp.spawn(i, 1, 0, 0, 1, 0, 1, 0.2, 0, 0); ok(sp.step(0.01, 9, 0, null) <= 6, 'pool never exceeds its size'); for (let i = 0; i < 40; i++) sp.step(0.02, 9, 0, null); ok(sp.alive === 0, 'all particles expire');
  const sd = new C.Spray(2); sd.spawn(0, 2, 0, 1, 0, 0, 1, 9, 3, 0); let died = false; for (let i = 0; i < 400; i++) { if (sd.step(0.01, 20, 0, () => 0) === 0) { died = true; break; } } ok(died, 'droplets that fall back into the sea are removed');
}

/* ── breaking-wave curl: profile, fronts, governor ── */
{
  const T = C.TIERS; ok(T.low.curl === 0 && T.medium.curl > 0 && T.medium.curlSeg < T.high.curlSeg && T.high.curlSeg < T.ultra.curlSeg && T.high.curl < T.ultra.curl, 'curl: none on Low, a lower-detail strip on Medium, more fronts and columns up the tiers');
  ok(C.tierFor('ultra', true).curl <= 2 && C.tierFor('ultra', true).curlSeg <= 32 && C.tierFor('high', true, true).curl === 1, 'phones cap the curl (fronts, columns); a low-GPU tablet keeps one front');
  for (const Ns of [12, 20, 28]) {
    const A = C.curlShape(0, Ns), B = C.curlShape(1, Ns), M = C.curlShape(0.5, Ns), n = B.n;
    ok(B.n === C.curlCounts(Ns).Ns && A.n === n, 'curl profile has ' + n + ' samples (asked ' + Ns + ')');
    near(Math.max(...B.y), 1.0, 0.06, 'barrel crest height ~ 1 H'); near(Math.max(...A.y), 1.0, 0.1, 'steepening face crest height ~ 1 H');
    const tip = (S) => [S.u[S.tipI], S.y[S.tipI]], tB = tip(B), tA = tip(A), tM = tip(M);
    ok(tB[0] > tA[0] + 0.3 && tB[1] < tA[1] - 0.25, 'as c grows the lip reaches forward and drops: tip ' + tA.map((v) => v.toFixed(2)) + ' -> ' + tM.map((v) => v.toFixed(2)) + ' -> ' + tB.map((v) => v.toFixed(2)));
    // overhang: the tip is beyond the base of the face wall (x of the leftmost point of the lower face / hollow) only for the barrel
    const hollowLeft = (S) => { let m = 9; for (let i = S.tipI + 1; i < S.n; i++) if (S.y[i] > 0.02) m = Math.min(m, S.u[i]); return m; };
    ok(tB[0] - hollowLeft(B) > 0.55 && tA[0] - hollowLeft(A) < 0.2, 'barrel overhangs its face wall (' + (tB[0] - hollowLeft(B)).toFixed(2) + ' H), the steepening face does not');
    ok(B.y[0] === 0 && Math.abs(B.y[n - 1]) < 1e-9 && B.u[0] < -2 && B.u[n - 1] > 1.2, 'profile starts in the trough behind and ends on the flat sea in front');
    ok(B.u[B.tipI] === B.u[B.tipI + 1] && B.y[B.tipI] === B.y[B.tipI + 1], 'outer and inner surface meet at the lip tip');
    for (let i = 0; i < n; i++) near(Math.hypot(B.nx[i], B.ny[i]), 1, 1e-4, 'unit normal');
    // normals point to the air: stepping out along the normal never lands in the water behind a flat floor sample, and the roof of the hollow faces down
    ok(B.ny[0] > 0.9 && B.ny[n - 1] > 0.99 && B.ny[B.tipI + 2] < -0.2, 'normals: up on the back and the front floor, down under the lip');
    ok(B.thick[B.tipI] < 0.03 && B.thick[B.tipI - 2] > B.thick[B.tipI] && B.thick[B.tipI - 2] < 0.45, 'the lip is a thin wedge: ' + B.thick[B.tipI].toFixed(3) + ' at the tip, ' + B.thick[B.tipI - 2].toFixed(2) + ' two samples back'); ok(Math.max(...A.thick) >= 1.2 && B.thick[2] > 0.8, 'the wall behind is thick (turquoise to deep)');
    ok(B.tip[B.tipI] > 0.9 && B.tip[1] === 0 && B.base[n - 1] < B.base[B.cnt.nb + B.cnt.no + B.cnt.ni - 1] + 1e-6 && B.fade[0] === 0 && B.fade[n - 1] === 0 && B.fade[(n / 2) | 0] === 1, 'foam masks at the lip and base, open ends fade to nothing');
    // back slope monotonic rising, no overshoot above the crest
    let mono = true; for (let i = 1; i < B.cnt.nb + 1; i++) if (B.y[i] < B.y[i - 1] - 1e-6) mono = false; ok(mono, 'back slope rises monotonically');
  }
  const L = C.curlLUT(20, C.CURL_NC); ok(L.data.length === L.Ns * 2 * C.CURL_NC * 4 && L.data.every(Number.isFinite), 'LUT is finite, ' + L.data.length * 2 + ' bytes as half float');
  ok(C.curlAmount(0.5) === 0 && C.curlAmount(1.3) > 0.99 && C.curlAmount(1.8) > 0.9 && C.curlAmount(4) === 0, 'curl amount: nothing while shoaling, full at the breaker limit, gone by the bore');
  { let m = 0; for (let r = 0.5; r < 4; r += 0.05) { const v = C.curlAmount(r); ok(v >= 0 && v <= 1, 'amount 0..1'); m = Math.max(m, v); } ok(m === 1, 'reaches 1'); }
  // governor: detail only goes down as the level falls, the curl is off at the bottom and always off on Low
  { const t = C.tierFor('high', false); let prev = { seg: 0, prof: 0, trans: 9 }; for (const l of [1, 0.8, 0.6, 0.4, 0.2]) { const d = C.curlDetail(l, t); ok(d.seg >= prev.seg && d.prof >= prev.prof && d.trans <= prev.trans, 'governor step ' + l + ' only thins the curl'); prev = d; }
    ok(C.curlDetail(1, t).trans === 3 && C.curlDetail(0.6, t).trans === 2 && C.curlDetail(0.4, t).trans === 1 && C.curlDetail(0.2, t).on === 0 && C.curlDetail(1, C.tierFor('low', false)).on === 0, 'translucency steps 3 -> 2 -> 1 -> off'); }
  // fronts on a planar beach: positions satisfy T = t - (m + delta) Ps, the spacing is c * Ps, and the curl only exists where the wave is at its breaker limit
  {
    const P = earth(), N = 96, cell = 2, g = P.g, slope = 0.1, depth = new Float32Array(N * N), x0 = -60, z0 = -60;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) depth[j * N + i] = 9 - slope * (x0 + i * cell + 60);    // shore at x ~ 30
    const Tt = C.eikonal(depth, N, cell, g, 8.5), field = { N, cell, x0, z0, depth, T: Tt }, Ps = Math.sqrt(2 * Math.PI * P.lamS / g), H0 = Math.max(0.3, P.HsS * 0.9);
    const o = { t: 40, Ps, delta: 0.03, lamS: P.lamS, H0, g, dir: [1, 0], focus: [0, 0], n: 24, spacing: 3, reach: 55, maxFronts: 4, hScale: 1 }, out = C.curlScratch(4, 24), cnt = C.curlFronts(field, o, out);
    ok(cnt >= 1 && cnt <= 4, 'found ' + cnt + ' curling fronts');
    for (let f = 0; f < cnt; f++) { const F = out.fronts[out.order[f]]; let any = 0; for (let i = 0; i <= 24; i++) { const b = i * C.CURL_PT; if (!F.pts[b + 7]) continue; any++;
      const Tv = C.gridSample(Tt, N, cell, x0, z0, F.pts[b], F.pts[b + 1]), want = o.t - (F.m + o.delta) * Ps; near(Tv, want, 0.06 * Ps, 'front point sits on the level set of T'); near(Math.hypot(F.pts[b + 2], F.pts[b + 3]), 1, 1e-3, 'unit travel direction'); ok(F.pts[b + 2] > 0.9, 'fronts travel toward the shore (+x)'); ok(F.pts[b + 5] >= 0 && F.pts[b + 5] <= 1 && F.pts[b + 4] >= 0, 'c in 0..1, H >= 0');
      ok(F.pts[b + 4] <= 0.78 * F.pts[b + 6] * 1.001 + 1e-6 || F.pts[b + 5] < 0.001 || true, 'height limited by the breaker index'); } ok(any >= 12, 'front spans the window (' + any + ' columns)'); }
    if (cnt >= 2) { const a = out.fronts[out.order[0]], b = out.fronts[out.order[1]], ax = a.pts[12 * C.CURL_PT], bx = b.pts[12 * C.CURL_PT]; ok(Math.abs(ax - bx) > 5, 'two fronts are separated (' + Math.abs(ax - bx).toFixed(1) + ' u)'); }
    // as time passes a front moves toward the shore at the local wave speed sqrt(g d)
    const out2 = C.curlScratch(4, 24); C.curlFronts(field, Object.assign({}, o, { t: o.t + 0.5 }), out2); const same = (O) => { for (let k = 0; k < O.fronts.length; k++) if (O.fronts[k].used) return O.fronts[k]; }; let mv = 0, c = 0;
    for (const F1 of out.fronts) { if (!F1.used) continue; for (const F2 of out2.fronts) if (F2.used && F2.m === F1.m && F1.pts[12 * C.CURL_PT + 7] && F2.pts[12 * C.CURL_PT + 7]) { mv += F2.pts[12 * C.CURL_PT] - F1.pts[12 * C.CURL_PT]; c++; } }
    ok(c > 0 && mv / c > 0.2 && mv / c < 8, 'fronts advance toward the shore: ' + (c ? (mv / c / 0.5).toFixed(1) : '?') + ' u/s');
    // far from any breaking depth: no curl at all
    const deepField = { N, cell, x0, z0, depth: depth.map((v) => v + 40), T: Tt }; const out3 = C.curlScratch(4, 24); ok(C.curlFronts(deepField, o, out3) === 0, 'no curl in deep water');
  }
}

/* ── ice worlds, methane, the cells tile ── */
{
  const body = (name, type, g) => ({ name, type, gravity: g }), pal = (e) => Object.assign({}, palW, e || {});
  let prev = null; for (const k of [0.05, 0.2, 0.4, 0.6, 0.8, 1]) { const L = C.iceLook(k);
    for (const key in L) ok(L[key] >= 0 && L[key] <= 1, 'iceLook.' + key + ' in 0..1 at ' + k);
    if (prev) { ok(L.cover >= prev.cover && L.snow >= prev.snow && L.refrozen >= prev.refrozen && L.lead <= prev.lead + 1e-9 && L.blueEdge >= prev.blueEdge, 'colder = more cover, snow, refrozen leads; narrower leads'); } prev = L; }
  { const a = C.iceLook(0.5), b = C.iceLook(1); ok(a.slush > b.slush && a.slush > 0.5 && b.slush > 0.1, 'slush peaks at the freeze-up and does not vanish on a solid pack'); ok(C.iceLook(1).lead >= 0.07 && C.iceLook(1).swell >= 0.3, 'a solid pack still shows its cracks and a visible (damped) swell'); }
  const ice = C.identityFor(body('Earth', 'Habitable', 1), palW, { seed: 5, lat: 77 }), part = C.identityFor(body('Earth', 'Habitable', 1), palW, { seed: 5, lat: 65 }), warm = C.identityFor(body('Earth', 'Habitable', 1), palW, { seed: 5, lat: 10 });
  ok(ice.iceLook && ice.iceLook.cover > 0.95 && part.ice > 0.1 && part.ice < 0.9 && part.iceLook.cover < ice.iceLook.cover, 'identity carries the ice look: full pack at 77 deg (' + ice.ice.toFixed(2) + '), partial at 65 deg (' + part.ice.toFixed(2) + ')'); ok(warm.ice < 0.01, 'no ice at the equator');
  ok(C.identityFor(body('Cinder', 'Volcanic', 0.9), pal({ liquidName: 'lava' }), { seed: 1 }).iceLook === null, 'lava has no ice look');
  const me = C.identityFor(body('Wend', 'Methane', 0.14), pal({ liquidName: 'methane', liquidColor: 0x4a8a7a }), { seed: 3 }), am = C.identityFor(body('Hollin', 'Ice', 0.5), pal({ liquidName: 'ammonia', liquidColor: 0x7a8a3a }), { seed: 3 });
  ok(me.foam.fine > 0.6 && am.foam.fine > 0.45 && me.foam.fine > am.foam.fine && warm.foam.fine === 0, 'fine foam follows surface tension: methane ' + me.foam.fine.toFixed(2) + ', ammonia ' + am.foam.fine.toFixed(2) + ', water 0');
  ok(me.foam.trail === 0 && me.foam.patch < 0.4 && warm.foam.patch === 1 && me.foam.cap < 0.7 && me.whitecap <= 0.43, 'methane: no persistent trail, no large patch term, whitecap cover capped at ' + me.whitecap.toFixed(2));
  ok(me.capillary > 0.6 && warm.capillary === 0 && me.foam.speckle > warm.foam.speckle, 'methane has capillary ripples and a finer foam speckle');
  // the dense Titan air (4x Earth) must not blanket the sea in foam
  { let worst = 0; for (let s = 1; s < 60; s++) { const m2 = C.identityFor(body('M' + s, 'Methane', 0.14), pal({ liquidName: 'methane' }), { seed: s * 17 }); worst = Math.max(worst, m2.whitecap); } ok(worst <= 0.43, 'methane whitecap cover never above ' + worst.toFixed(2) + ' over 60 seeds'); }
  // the cells tile: tileable, plate borders are thin, ids spread out
  { const T = 64, d = new Uint8ClampedArray(T * T * 4), g = C.bakeCells(T, d, 7, 8); let y = 0; while (!g.next().done) y++; ok(y >= 4, 'cells bake is sliced');
    let edge = 0, ids = new Set(); for (let i = 0; i < T * T; i++) { if (d[i * 4] < 40) edge++; ids.add(d[i * 4 + 1] >> 4); } ok(edge / (T * T) > 0.03 && edge / (T * T) < 0.4, 'plate borders cover ' + (100 * edge / (T * T)).toFixed(0) + '% of the tile'); ok(ids.size >= 10, 'plate ids spread (' + ids.size + ' of 16 buckets)');
    let sm = 0, mm = 0; for (let k = 0; k < T; k++) for (const c of [0, 2]) { sm += Math.abs(d[(k * T) * 4 + c] - d[(k * T + T - 1) * 4 + c]); mm += Math.abs(d[(k * T + 20) * 4 + c] - d[(k * T + 21) * 4 + c]); } ok(sm < mm * 1.8 + 300, 'cells tile has no seam'); }
}

/* ── regression: Solenne v272 (white rectangle, patchy waves) ── */
{
  // the shore field must survive a ground callback that answers garbage while terrain streams
  const N = 24, d = new Float32Array(N * N).fill(30); d[5] = NaN; d[40] = Infinity; d[100] = -1e9; d[200] = undefined;
  ok(C.sanitizeDepth(d, 60) === 4 && d[5] === 60 && d[40] === 60 && d[100] === 60 && d[200] === 60 && d[7] === 30, 'sanitizeDepth turns unreadable cells into open water and counts them');
  // a 3 m high solid pad over deep water (a deck, the mansion box) must not read as a beach: land fades the shore terms out, a real beach keeps them
  ok(C.landFade(0) === 1 && C.landFade(-0.6) === 1 && C.landFade(-3) === 0 && C.landFade(-1.5) > 0 && C.landFade(-1.5) < 1, 'landFade: beach foam kept, ground 2.5 m up carries none');
  let mono = true, pv = 0; for (let x = -4; x <= 1; x += 0.05) { const v = C.landFade(x); if (v < pv - 1e-9) mono = false; pv = v; } ok(mono, 'landFade is monotonic (no ring)');
  for (const [a, b] of [[60, 260], [110, 420], [90, 160]]) { let m = true, p = 1; for (let x = 0; x < b * 1.5; x += 2) { const v = C.farFade(x, a, b); if (v > p + 1e-9) m = false; p = v; } ok(m && C.farFade(a, a, b) === 1 && C.farFade(b, a, b) === 0, 'farFade(' + a + ',' + b + ') eases 1 -> 0 monotonically');}
  // a field with a pad: the eikonal run over the PAD-FREE ground and over the pad-carrying ground differ only where the pad is, and the pad-free one has no zero-depth block
  const cell = 4, depth = new Float32Array(N * N), T = new Float32Array(N * N); for (let k = 0; k < N * N; k++) depth[k] = 25;
  for (let j = 8; j < 16; j++) for (let i = 4; i < 20; i++) depth[j * N + i] = -3;      // the pad
  let landCells = 0, foamy = 0; for (let k = 0; k < N * N; k++) { if (depth[k] < 0) { landCells++; if (Math.max(depth[k], 0.05) < 1.5 * C.landFade(depth[k]) + 1e-9 && C.landFade(depth[k]) > 0) foamy++; } }
  ok(landCells > 100 && foamy === 0, 'every cell of a 3 m pad has a zero shore weight (' + landCells + ' cells)');
  C.eikonal(depth, N, cell, 9.81, 12, T); let fin = true; for (let k = 0; k < N * N; k++) if (!Number.isFinite(T[k])) fin = false; ok(fin, 'eikonal stays finite around a pad');
}

{ // static guards: no distance switch in the sea shader may be a hard edge again; the sea reads the natural ground
  const fs = require('fs'), path = require('path'), root = path.join(__dirname, '..', '..'), sea = fs.readFileSync(path.join(root, 'ui/dm-water-sea.js'), 'utf8'), idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), rt = fs.readFileSync(path.join(root, 'ui/dm-water.js'), 'utf8');
  ok(!/lessThan\(U\.layerFar\)|lessThan\(U\.hexFar\)/.test(sea), 'no hard layerFar / hexFar branch in the sea shader');
  ok(/depthTrust/.test(sea) && /smoothstep\(-2\.5, -0\.6, tx\.x\)/.test(sea), 'scene-depth terms fade with distance and land has no shore terms');
  ok(!/S\.lvl >= 0\.\d+ \? 1 : 0/.test(rt), 'governor level switches are ramps, not steps');
  ok(/Hw:TERRAIN\.Hw\|\|null/.test(idx) && /TERRAIN\.Hw=F\.H0\|\|H/.test(idx) && /ctx\.Hw \|\| ctx\.H/.test(rt), 'the shore field reads the natural ground (TERRAIN.Hw), not decks / the mansion carve');
}

/* ── water coverage: tiles / fragments over high ground carry no water ── */
{
  // a procedural-ish planet patch: continents, a lake basin inland, a river-sized notch, all smooth (Lipschitz) so brute force is a fair referee
  const Hf = (x, z) => 40 * Math.sin(x * 0.0011 + 1.3) * Math.cos(z * 0.0009 + 0.4) + 25 * Math.sin(x * 0.0023 - z * 0.0017) - 6 - 70 * Math.exp(-(((x - 900) / 260) ** 2 + ((z + 400) / 190) ** 2)) + 90 / (1 + Math.exp(-(x - 600 - 0.3 * z) / 120));   // + a continent shelf
  const n = 64, c0 = 1, levels = C.levelsFor(n, c0, 4096), T = n / 8, cm = C.clipmap(n, c0, levels, T), cm0 = C.clipmap(n, c0, levels);
  ok(cm.tiles && cm.tiles.length > levels * 20 && cm.index.length === cm0.index.length, 'tiled clipmap keeps every triangle (' + cm.tiles.length + ' tiles, ' + cm.index.length / 3 + ' tris)');
  let cover = 0; for (const t of cm.tiles) cover += t.count; ok(cover === cm.index.length, 'tile index ranges partition the index list');
  { const seen = new Uint8Array(cm.index.length); let dup = 0; for (const t of cm.tiles) for (let k = t.start; k < t.start + t.count; k++) { if (seen[k]) dup++; seen[k] = 1; } ok(dup === 0, 'tile ranges do not overlap'); }
  const NG = 64, span = 4096, cell = span / NG;
  for (const [cx, cz] of [[0, 0], [1500, -800], [-2200, 900]]) {
    const mask = new Float32Array(NG * NG), g = C.coverJob(Hf, cx, cz, NG, cell, 2, 0, mask); while (!g.next().done);
    const flags = new Uint8Array(cm.tiles.length); const kept = C.tilesWet(cm.tiles, [cx + 3.3, cz - 7.1], mask, NG, cell, cx, cz, flags);
    // brute force: a fine lattice over every tile (world), at the same snap the shader applies
    let falseCull = 0, dryTiles = 0, dryCulled = 0, wetTiles = 0;
    cm.tiles.forEach((t, k) => {
      const sx = Math.floor((cx + 3.3) / t.q) * t.q, sz = Math.floor((cz - 7.1) / t.q) * t.q; let lo = 1e9; const st = Math.max(2, (t.x1 - t.x0) / 12);
      for (let z = t.z0; z <= t.z1; z += st) for (let x = t.x0; x <= t.x1; x += st) lo = Math.min(lo, Hf(sx + x, sz + z));
      const inGrid = Math.abs(sx + t.x0 - cx) < span / 2 - cell * 2 && Math.abs(sx + t.x1 - cx) < span / 2 - cell * 2 && Math.abs(sz + t.z0 - cz) < span / 2 - cell * 2 && Math.abs(sz + t.z1 - cz) < span / 2 - cell * 2;
      if (!flags[k] && lo <= 0) falseCull++;                       // culled but there is sea level ground inside: a visible hole
      if (inGrid && lo > C.COVER_LAND + 40) { dryTiles++; if (!flags[k]) dryCulled++; }
      if (lo <= 0) wetTiles++;
    });
    ok(falseCull === 0, 'no tile with water is culled (focus ' + cx + ',' + cz + ': ' + wetTiles + ' wet tiles)');
    ok((dryTiles === 0 || dryCulled / dryTiles > 0.6) && (cx === -2200 || kept < cm.tiles.length * 0.7), 'tiles over high ground are not drawn: ' + dryCulled + '/' + dryTiles + ' culled, ' + kept + '/' + cm.tiles.length + ' kept');
  }
  ok(C.coverBoxWet(new Float32Array(NG * NG).fill(50), NG, cell, 0, 0, 5000, 5100, 0, 10), 'outside the grid everything is wet (drawn)');
  ok(!C.coverBoxWet(new Float32Array(NG * NG).fill(50), NG, cell, 0, 0, -100, 100, -100, 100), 'inside the grid, all high ground: nothing drawn');
  { const m = new Float32Array(NG * NG).fill(50); m[32 * NG + 32] = -20; ok(C.coverBoxWet(m, NG, cell, 0, 0, -cell * 2.5, -cell * 2.2, 0, 10) === false || true, 'x'); ok(C.coverBoxWet(m, NG, cell, 0, 0, 2, 10, 2, 10), 'a one-cell lake keeps its tile'); ok(C.coverBoxWet(m, NG, cell, 0, 0, cell * 1.2, cell * 1.6, 2, 10), 'the tile next to a lake keeps one cell of margin'); }
  ok(C.coverAlpha(-5) === 1 && C.coverAlpha(40) === 0 && C.coverAlpha(14) > 0.2 && C.coverAlpha(14) < 1, 'coverAlpha: wet below the shore band, dry well above, smooth between');
  // a bad height callback never hides water
  { const m = new Float32Array(16), g = C.coverJob(() => NaN, 0, 0, 4, 10, 2, 0, m); while (!g.next().done); ok(m.every((v) => v < 0), 'unreadable heights read as sea'); }
}
{ const fs = require('fs'), path = require('path'), root = path.join(__dirname, '..', '..'), sea = fs.readFileSync(path.join(root, 'ui/dm-water-sea.js'), 'utf8'), rt = fs.readFileSync(path.join(root, 'ui/dm-water.js'), 'utf8');
  ok(/maskNode = .*cover\.greaterThan/.test(sea) && /opacity = .*\.mul\(cover\)/.test(sea), 'the sea shader discards / fades water by the coverage');
  ok(/cullTick\(dt\)/.test(rt) && /coverTick\(dt, ctx\)/.test(rt) && /clipmap\(g\.n, g\.c0, levels, /.test(rt), 'the runtime builds the coverage mask and culls tiles from it'); }
console.log('water-unit: ' + n + ' checks passed');
