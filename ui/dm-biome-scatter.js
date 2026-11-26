/* DART Meadow - procedural BIOME SCATTER (foliage / rocks) for the planet worlds.  Opt-in: ?scatter=1  (v385).
 *
 * WHAT: a biome is JSON data - a list of plant entries {density per m2, scale range, slope / elevation / noise / shore-distance masks, clustering, 4 LOD levels, wind}.  The
 *   placement is a PURE function of (world seed, biome, entry, integer grid cell): non-destructive, the same spot always grows the same plant, stable while terrain chunks stream in
 *   and out, independent of chunk size and of load order, and the same biome can be applied to any number of terrains (it only asks the terrain for its height function).
 *   Ideas studied from the scatter / biome tooling used in Blender (Secret Paint, Geo-Scatter, Plant Library / Biome Reader) and Arboris' layered wind + LOD0-3 - concepts only,
 *   no code from any of them; see docs/CREDITS-scatter.md and docs/biome-scatter.md.  Independent implementation.
 *
 * LAYOUT (this file)
 *   1. PURE CORE  (no THREE, node-tested by tools/tests/biome-scatter*.js): hash / noise, mask maths, biome validation, candidate cells, placement, shore grid, LOD pick, budget tiers,
 *      view wedge, re-binning of the resident instances into the draw buffers.
 *   2. BROWSER GLUE (needs THREE + the TSL globals the game already puts on window): placeholder meshes, materials with 3-layer TSL wind, the pooled InstancedMeshes, chunk streaming.
 *
 * DRAW MODEL (frame rate first): ONE pooled InstancedMesh per (entry, LOD level), fixed capacity, never reallocated: <= entries x 4 draw calls in total (tier 0: one per entry).  The
 *   resident chunks keep their instances in typed arrays; a re-bin (a few times a second, only when the view moved) walks them nearest-first, drops what is out of the view wedge or past
 *   the level's distance, picks each instance's LOD level by distance and writes the matrices into the pooled buffers.  Draw count = what is written, so the GPU never sees culled
 *   or far-LOD instances.  Fixed capacity > 1000 keeps three's instanced-attribute path (a count baked into a uniform array would need a pipeline rebuild when it changes).
 *
 * BUDGET: tier 0 phones / tablets (default on a Mali tablet / iPhone: impostor cards only, low counts), 1 (LOD2 + cards), 2 desktop, 3 high.  ?scattertier=N forces one.  DMBudget's
 *   'props' stage (and the fast light-stack guard) then scale density, distance and the cheapest allowed LOD at run time without regenerating anything (instances carry a rank).
 *
 * FLAGS: ?scatter=1 on . ?scatterbiome=temperate-forest|meadow|dry-desert . ?scattertier=0..3 . ?scatterhud=1 (console stats) . ?scatterwind=0 (no wind)
 * Public: DMBiomeScatter.on . .core . .biomes . .registerBiome(json) . .tick(ctx) . .dispose() . .stats() . .replacesTrees() . .biomeFor(style, groundHex)
 */
(function (root) {
  'use strict';

  /* ═════════════════════════════ 1. PURE CORE ═════════════════════════════ */
  const TAU = Math.PI * 2;
  const CHUNK = 300;                       // metres; the same square as the game's prop chunks (SURF_CHUNK)

  // ── hashing (integers in, 32-bit mixes out; no Math.random anywhere) ──
  function hash32(a, b, c, d) {
    let h = (a | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h ^= (b | 0) + 0x7f4a7c15 + (h << 6) + (h >>> 2);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= (c | 0) + 0x165667b1 + (h << 6) + (h >>> 2);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h ^= (d | 0) + 0x27d4eb2f + (h << 6) + (h >>> 2);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
  }
  const U01 = (h) => (h >>> 0) / 4294967296;
  // k-th uniform of a cell hash (independent streams: k = 0, 1, 2 ...)
  function rnd(h, k) { return U01(hash32(h, k * 0x1000193 + 77, 0x51ed270b, k)); }
  function strHash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // ── value noise 0..1 (lattice hash, smooth interpolation) + fbm ──
  function vnoise(x, z, seed) {
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = U01(hash32(seed, xi, zi, 1)), b = U01(hash32(seed, xi + 1, zi, 1)), c = U01(hash32(seed, xi, zi + 1, 1)), d = U01(hash32(seed, xi + 1, zi + 1, 1));
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }
  function fbm(x, z, seed, oct) {
    let s = 0, a = 0.5, n = 0, f = 1;
    for (let i = 0; i < oct; i++) { s += a * vnoise(x * f + i * 17.3, z * f - i * 9.1, seed + i * 101); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }
  const smooth = (a, b, v) => { if (a === b) return v < a ? 0 : 1; const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  // ── masks ──
  // A range {min, max, soft}: weight 1 inside, smooth ramp of width `soft` INSIDE each bound (so min / max are hard limits where weight reaches 0).  min / max may be missing (open).
  function rangeWeight(v, r) {
    if (!r) return 1;
    let w = 1; const soft = r.soft > 0 ? r.soft : 0;
    if (r.min != null) { if (v < r.min) return 0; if (soft) w *= smooth(r.min, r.min + soft, v); }
    if (r.max != null) { if (v > r.max) return 0; if (soft) w *= 1 - smooth(r.max - soft, r.max, v); }
    return w;
  }
  // noise mask: n = fbm(x / scale, z / scale); weight = smoothstep(threshold - soft, threshold + soft, n) (invert flips it).  `seedOffset` decorrelates entries.
  function noiseWeight(m, x, z, seed) {
    if (!m) return 1;
    const sc = m.scale > 0 ? m.scale : 100, n = fbm(x / sc, z / sc, seed + (m.seedOffset | 0) * 7919, m.octaves | 0 || 3);
    const t = m.threshold != null ? m.threshold : 0.5, s = Math.max(1e-4, m.soft != null ? m.soft : 0.1);
    const w = smooth(t - s, t + s, n);
    return m.invert ? 1 - w : w;
  }
  // clustering: parent centres on a jittered grid (cell = c.cell, a centre exists in a cell with probability c.occupancy); weight = lerp(1, falloff(dist / radius), strength).
  // Centres are a pure function of the cell, so a cluster crossing a chunk border is the same cluster from both sides.
  function clusterWeight(c, x, z, seed) {
    if (!c || !(c.strength > 0)) return 1;
    const R = c.radius > 0 ? c.radius : 12, cell = c.cell > 0 ? c.cell : R * 4, occ = c.occupancy != null ? c.occupancy : 0.6, cs = seed ^ 0x5bd1e995;
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell); let best = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const i = ci + di, j = cj + dj, h = hash32(cs, i, j, 5);
      if (U01(h) > occ) continue;
      const cx = (i + 0.15 + 0.7 * rnd(h, 1)) * cell, cz = (j + 0.15 + 0.7 * rnd(h, 2)) * cell, d = Math.hypot(x - cx, z - cz) / (R * (0.6 + 0.8 * rnd(h, 3)));
      if (d < 1) { const f = 1 - smooth(0.35, 1, d); if (f > best) best = f; }
    }
    return lerp(1, best, Math.min(1, c.strength));
  }

  // ── biome JSON: validate + normalise (defaults filled; throws nothing, returns {ok, errors, biome}) ──
  const LEVELS = 4;
  const KINDS = ['tree', 'bush', 'grass', 'flower', 'rock', 'cactus'];
  function validateBiome(src) {
    const errors = []; const err = (m) => errors.push(m);
    if (!src || typeof src !== 'object') return { ok: false, errors: ['biome is not an object'], biome: null };
    const b = { id: String(src.id || ''), name: String(src.name || src.id || ''), version: src.version | 0 || 1, seed: String(src.seed != null ? src.seed : src.id || ''), entries: [] };
    if (!b.id) err('biome.id missing');
    if (!Array.isArray(src.entries) || !src.entries.length) err('biome.entries must be a non-empty array');
    const ids = new Set();
    (src.entries || []).forEach((e, idx) => {
      const tag = 'entries[' + idx + ']' + (e && e.id ? ' (' + e.id + ')' : '');
      if (!e || typeof e !== 'object') { err(tag + ' is not an object'); return; }
      const n = { id: String(e.id || ''), kind: KINDS.includes(e.kind) ? e.kind : 'bush', density: +e.density, scale: e.scale ? [+e.scale[0], +e.scale[1]] : [1, 1], scaleBias: e.scaleBias > 0 ? +e.scaleBias : 1,
        yScale: e.yScale ? [+e.yScale[0], +e.yScale[1]] : [1, 1], jitter: e.jitter != null ? +e.jitter : 0.8, sink: +e.sink || 0, tintVar: e.tintVar != null ? +e.tintVar : 0.15, footprint: e.footprint != null ? +e.footprint : 0.5,
        maxPerChunk: e.maxPerChunk > 0 ? e.maxPerChunk | 0 : 6000, slope: e.slope || null, elevation: e.elevation || null, noise: e.noise || null, waterDistance: e.waterDistance || null,
        cluster: e.cluster || null, avoid: [], lod: [], wind: Object.assign({ trunk: 1, branch: 1, leaf: 1 }, e.wind || {}), shadows: !!e.shadows };
      if (!n.id) err(tag + ' id missing'); else if (ids.has(n.id)) err(tag + ' duplicate id'); ids.add(n.id);
      if (!(n.density > 0) || !isFinite(n.density)) err(tag + ' density must be > 0 (per m2)');
      if (!(n.scale[0] > 0 && n.scale[1] >= n.scale[0])) err(tag + ' scale must be [min>0, max>=min]');
      if (!(n.jitter >= 0 && n.jitter <= 1)) err(tag + ' jitter must be 0..1');
      for (const key of ['slope', 'elevation', 'waterDistance']) {
        const r = n[key]; if (!r) continue;
        if (typeof r !== 'object' || (r.min != null && !isFinite(r.min)) || (r.max != null && !isFinite(r.max))) err(tag + ' ' + key + ' must be {min,max,soft}');
        else if (r.min != null && r.max != null && r.min > r.max) err(tag + ' ' + key + ' min > max');
      }
      if (n.noise && !(n.noise.scale > 0)) err(tag + ' noise.scale must be > 0');
      if (n.cluster && !(n.cluster.radius > 0)) err(tag + ' cluster.radius must be > 0');
      (e.avoid || []).forEach((a) => {
        if (!a || !a.entry) { err(tag + ' avoid needs {entry}'); return; }
        const prev = (src.entries || []).findIndex((x) => x && x.id === a.entry);
        if (prev < 0 || prev >= idx) err(tag + ' avoid "' + a.entry + '" must name an EARLIER entry (priority order, no cycles)'); else n.avoid.push({ entry: String(a.entry), extra: +a.extra || 0 });
      });
      const lods = Array.isArray(e.lod) ? e.lod : [];
      if (!lods.length || lods.length > LEVELS) err(tag + ' lod needs 1..' + LEVELS + ' levels');
      let prevD = 0;
      lods.forEach((l, k) => {
        if (!l || !(l.maxDist > prevD)) err(tag + ' lod[' + k + '].maxDist must increase (> ' + prevD + ')');
        if (!l || !(l.mesh || l.card)) err(tag + ' lod[' + k + '] needs mesh or card');
        n.lod.push({ mesh: l && l.mesh ? String(l.mesh) : '', card: l && l.card ? String(l.card) : '', maxDist: +(l && l.maxDist) || 0 }); prevD = +(l && l.maxDist) || prevD;
      });
      b.entries.push(n);
    });
    return { ok: errors.length === 0, errors, biome: errors.length ? null : b };
  }

  // ── budget tiers ──
  // minLevel: the lowest LOD index an entry may use (levels below it are skipped; the first allowed level covers the near range).  cardOnly: only 'card' levels (tier 0).
  const TIERS = [
    { name: 'phone',   cardOnly: true,  minLevel: 0, density: 0.40, dist: 0.65, ring: 1, capTotal: 3000,  bufCap: 2048,  gridStep: 15,  wind: [1, 0.5, 0], recv: false, rebinMs: 330 },
    { name: 'tablet',  cardOnly: false, minLevel: 2, density: 0.60, dist: 0.80, ring: 2, capTotal: 6000,  bufCap: 3072,  gridStep: 15,  wind: [1, 1, 0.5], recv: false, rebinMs: 250 },
    { name: 'desktop', cardOnly: false, minLevel: 1, density: 1.00, dist: 1.00, ring: 2, capTotal: 24000, bufCap: 8192,  gridStep: 10, wind: [1, 1, 1],   recv: true,  rebinMs: 160 },
    { name: 'high',    cardOnly: false, minLevel: 0, density: 1.00, dist: 1.15, ring: 3, capTotal: 48000, bufCap: 12288, gridStep: 10, wind: [1, 1, 1],   recv: true,  rebinMs: 120 },
  ];
  // runtime pressure from the frame-budget ladder: dyn 0..3 (DMBudget 'props' level + 1 when the fast guard is up).  Multipliers on the generated base tier; nothing is regenerated.
  const DYN = [{ density: 1, dist: 1, up: 0 }, { density: 0.7, dist: 0.85, up: 0 }, { density: 0.45, dist: 0.7, up: 1 }, { density: 0.25, dist: 0.5, up: 2 }];
  function tierFor(opt) {
    // opt: {force, lodTier ('low'|'mobile'|'desktop'), preset}; phones AND tablets start at tier 0 (frame rate is the priority); ?scattertier=1 opts a tablet in
    if (opt && opt.force != null && opt.force >= 0 && opt.force <= 3) return opt.force | 0;
    const t = opt && opt.lodTier;
    if (t === 'low' || t === 'mobile') return 0;
    return opt && (opt.preset === 'ultra') ? 3 : 2;
  }
  function dynFor(budgetProps, fast) { return Math.max(0, Math.min(3, (budgetProps | 0) + ((fast | 0) >= 2 ? 1 : 0))); }
  // the effective cap of ring chunks and each entry's draw distance for (tier, dyn)
  function ringFor(tier, maxDist) { return Math.max(1, Math.min(TIERS[tier].ring, Math.ceil(maxDist / CHUNK))); }
  function effDist(entry, lvl, tier, dyn, ringCap) {
    const d = entry.lod[lvl].maxDist * TIERS[tier].dist * DYN[dyn].dist; return ringCap ? Math.min(d, ringCap * CHUNK) : d;
  }
  // which LOD level draws an entry at distance d (3-D, metres), or -1 when it is not drawn.  Levels allowed by the tier / dyn only; the lowest allowed level covers the near range.
  function pickLod(entry, d, tier, dyn, ringCap) {
    const T = TIERS[tier]; const first = firstLevel(entry, tier, dyn);
    if (first < 0) return -1;
    for (let k = first; k < entry.lod.length; k++) {
      if (T.cardOnly && !entry.lod[k].card) continue;
      if (d < effDist(entry, k, tier, dyn, ringCap)) return k;
    }
    return -1;
  }
  function firstLevel(entry, tier, dyn) {
    const T = TIERS[tier], n = entry.lod.length; let k = Math.min(n - 1, T.minLevel + DYN[dyn].up);
    if (T.cardOnly) { k = -1; for (let q = 0; q < n; q++) if (entry.lod[q].card) { k = q; break; } return k; }
    return k;
  }
  function maxDistOf(biome, tier, dyn) {
    let m = 0; for (const e of biome.entries) { const f = firstLevel(e, tier, dyn); if (f < 0) continue; for (let k = f; k < e.lod.length; k++) if (!TIERS[tier].cardOnly || e.lod[k].card) m = Math.max(m, e.lod[k].maxDist * TIERS[tier].dist * DYN[dyn].dist); }
    return m;
  }

  // ── candidate cells ──
  // one candidate per square cell of side s = 1 / sqrt(density x densityK), jittered inside the cell; every random number comes from hash(seed, entry, cell) so a cell always gives the
  // same plant whichever chunk asks.  A candidate belongs to the chunk box that contains its (jittered) position.
  // maxPerChunk is per reference chunk (300 x 300 m), NOT per placement box, so the cell grid (and with it every plant) does not depend on the box asked for.
  function cellSide(entry, densityK) {
    const s = 1 / Math.sqrt(entry.density * densityK), minS = CHUNK / Math.sqrt(entry.maxPerChunk * Math.max(densityK, 0.05)); return Math.max(s, minS);
  }
  function candidate(bseed, ei, entry, ix, iz, s) {
    const h = hash32(bseed, ei + 1, ix, iz);
    const j = entry.jitter, px = (ix + 0.5 + (rnd(h, 0) - 0.5) * j) * s, pz = (iz + 0.5 + (rnd(h, 1) - 0.5) * j) * s;
    const su = Math.pow(rnd(h, 2), entry.scaleBias), sc = lerp(entry.scale[0], entry.scale[1], su);
    return { x: px, z: pz, scale: sc, sy: lerp(entry.yScale[0], entry.yScale[1], rnd(h, 3)), yaw: rnd(h, 4) * TAU, tint: rnd(h, 5), accept: rnd(h, 6), rank: rnd(h, 7), h };
  }

  // ── shore grid: coarse height + distance-to-water for a box, spacing `step`, extended `margin` metres beyond the box (water-distance masks saturate at `margin`) ──
  function makeShoreGrid(H, x0, z0, x1, z1, sea, step, margin) {
    step = step || 10; margin = margin == null ? 60 : margin;
    const gx0 = x0 - margin, gz0 = z0 - margin, nx = Math.ceil((x1 - x0 + 2 * margin) / step) + 1, nz = Math.ceil((z1 - z0 + 2 * margin) / step) + 1;
    const hh = new Float32Array(nx * nz), dist = new Float32Array(nx * nz), INF = 1e9;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const h = H(gx0 + i * step, gz0 + j * step); hh[j * nx + i] = h; dist[j * nx + i] = h < sea ? 0 : INF; }
    const D1 = step, D2 = step * 1.41421356;   // chamfer distance transform, two passes
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      let d = dist[j * nx + i]; if (d === 0) continue;
      if (i > 0) d = Math.min(d, dist[j * nx + i - 1] + D1); if (j > 0) { d = Math.min(d, dist[(j - 1) * nx + i] + D1); if (i > 0) d = Math.min(d, dist[(j - 1) * nx + i - 1] + D2); if (i < nx - 1) d = Math.min(d, dist[(j - 1) * nx + i + 1] + D2); }
      dist[j * nx + i] = d;
    }
    for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      let d = dist[j * nx + i]; if (d === 0) continue;
      if (i < nx - 1) d = Math.min(d, dist[j * nx + i + 1] + D1); if (j < nz - 1) { d = Math.min(d, dist[(j + 1) * nx + i] + D1); if (i < nx - 1) d = Math.min(d, dist[(j + 1) * nx + i + 1] + D2); if (i > 0) d = Math.min(d, dist[(j + 1) * nx + i - 1] + D2); }
      dist[j * nx + i] = d;
    }
    const sample = (arr, x, z) => {
      const fx = Math.min(nx - 1.001, Math.max(0, (x - gx0) / step)), fz = Math.min(nz - 1.001, Math.max(0, (z - gz0) / step)), i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
      const a = arr[j * nx + i], b = arr[j * nx + i + 1], c = arr[(j + 1) * nx + i], d = arr[(j + 1) * nx + i + 1];
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    };
    return { step, margin, h: (x, z) => sample(hh, x, z), shore: (x, z) => Math.min(margin, sample(dist, x, z)), n: nx * nz };
  }

  // ── the sampler: placement of one entry's cells, masks cheap -> costly, avoidance by recomputing the (pure) acceptance of earlier entries ──
  // fields = { H(x,z) exact ground height, sea (level, m), grid (makeShoreGrid result or null) }
  function makeSampler(biome, worldSeed, fields, opts) {
    opts = opts || {};
    const bseed = hash32(worldSeed | 0, strHash(biome.seed), 0, 0), K = opts.densityK != null ? opts.densityK : 1, sea = fields.sea != null ? fields.sea : 0;
    const H = fields.H, grid = fields.grid || null, memo = new Map(), side = biome.entries.map((e) => cellSide(e, K)), idx = {}; biome.entries.forEach((e, i) => { idx[e.id] = i; });
    let hCalls = 0; const Hc = (x, z) => { hCalls++; return H(x, z); };
    // acceptance of cell (ix, iz) of entry ei -> instance record or null (memoised per sampler)
    function cell(ei, ix, iz) {
      const key = ei + '|' + ix + '|' + iz; if (memo.has(key)) return memo.get(key);
      const e = biome.entries[ei], s = side[ei], c = candidate(bseed, ei, e, ix, iz, s); let out = null;
      do {
        let w = noiseWeight(e.noise, c.x, c.z, bseed); if (w <= 0) break;                      // 1. noise mask (no terrain read)
        w *= clusterWeight(e.cluster, c.x, c.z, bseed ^ (ei * 0x9e3779b1)); if (w <= 0) break;   // 2. clustering
        if (c.accept >= w) break;                                                                // 3. probabilistic thinning by the mask product (soft edges)
        if (grid) {                                                                              // 4. coarse elevation + shore distance (grid, no exact H)
          const gh = grid.h(c.x, c.z); if (e.elevation) { const er = e.elevation; if ((er.min != null && gh < er.min - 3) || (er.max != null && gh > er.max + 3)) break; }
          if (e.waterDistance) { const wd = rangeWeight(grid.shore(c.x, c.z), e.waterDistance); if (wd <= 0 || c.accept >= w * wd) break; }
        }
        const y = Hc(c.x, c.z);                                                                  // 5. exact height + elevation mask
        const we = rangeWeight(y - sea, e.elevation); if (we <= 0 || c.accept >= w * we) break;
        if (e.slope) {                                                                           // 6. slope (degrees) by forward differences over 1.5 m
          const dx = Hc(c.x + 1.5, c.z) - y, dz = Hc(c.x, c.z + 1.5) - y, sl = Math.atan(Math.hypot(dx, dz) / 1.5) * 180 / Math.PI, ws = rangeWeight(sl, e.slope);
          if (ws <= 0 || c.accept >= w * we * ws) break; c.slope = sl;
        }
        if (e.avoid.length) {                                                                     // 7. keep clear of earlier (higher priority) entries
          let blocked = false;
          for (const a of e.avoid) {
            const ai = idx[a.entry], ae = biome.entries[ai], as = side[ai], R = (ae.scale[1] * ae.footprint + e.scale[1] * e.footprint + a.extra) + 0.01;
            const i0 = Math.floor((c.x - R) / as - 0.5 - ae.jitter / 2) - 1, i1 = Math.floor((c.x + R) / as + 0.5 + ae.jitter / 2) + 1, j0 = Math.floor((c.z - R) / as - 0.5 - ae.jitter / 2) - 1, j1 = Math.floor((c.z + R) / as + 0.5 + ae.jitter / 2) + 1;
            for (let jj = j0; jj <= j1 && !blocked; jj++) for (let ii = i0; ii <= i1; ii++) {
              const o = cell(ai, ii, jj); if (!o) continue;
              if (Math.hypot(o.x - c.x, o.z - c.z) < o.scale * ae.footprint + c.scale * e.footprint + a.extra) { blocked = true; break; }
            }
            if (blocked) break;
          }
          if (blocked) break;
        }
        out = { x: c.x, z: c.z, y: y - e.sink * c.scale, scale: c.scale, sy: c.sy, yaw: c.yaw, tint: c.tint, rank: c.rank, slope: c.slope || 0 };
      } while (false);
      memo.set(key, out); return out;
    }
    return { cell, side, biome, stats: () => ({ hCalls, memo: memo.size }), clear: () => memo.clear() };
  }

  // instance record layout of the typed arrays (stride 8): x, y, z, scale, yaw, tint, sy, rank
  const STRIDE = 8;
  // placement of a box [x0,x1) x [z0,z1) as a generator (yields every `slice` candidates so the caller can spend a few ms a frame).  Returns per-entry Float32Arrays.
  function* placeBoxG(biome, worldSeed, x0, z0, x1, z1, fields, opts) {
    opts = opts || {}; const slice = opts.slice || 400;
    const S = makeSampler(biome, worldSeed, fields, { densityK: opts.densityK }), out = []; let c = 0;
    for (let ei = 0; ei < biome.entries.length; ei++) {
      const e = biome.entries[ei], s = S.side[ei], pad = e.jitter / 2 + 0.5, list = [];
      const i0 = Math.floor(x0 / s - pad) - 1, i1 = Math.ceil(x1 / s + pad) + 1, j0 = Math.floor(z0 / s - pad) - 1, j1 = Math.ceil(z1 / s + pad) + 1;
      for (let jz = j0; jz <= j1; jz++) for (let ix = i0; ix <= i1; ix++) {
        if ((++c % slice) === 0) yield;
        const cx = (ix + 0.5) * s, cz = (jz + 0.5) * s; if (cx < x0 - s * pad || cx > x1 + s * pad || cz < z0 - s * pad || cz > z1 + s * pad) continue;
        const o = S.cell(ei, ix, jz); if (!o || o.x < x0 || o.x >= x1 || o.z < z0 || o.z >= z1) continue;
        list.push(o);
      }
      const a = new Float32Array(list.length * STRIDE);
      for (let k = 0; k < list.length; k++) { const o = list[k], b = k * STRIDE; a[b] = o.x; a[b + 1] = o.y; a[b + 2] = o.z; a[b + 3] = o.scale; a[b + 4] = o.yaw; a[b + 5] = o.tint; a[b + 6] = o.sy; a[b + 7] = o.rank; }
      out.push(a); yield;
    }
    out.hCalls = S.stats().hCalls; return out;
  }
  function placeBox(biome, worldSeed, x0, z0, x1, z1, fields, opts) { const it = placeBoxG(biome, worldSeed, x0, z0, x1, z1, fields, opts); let r; do { r = it.next(); } while (!r.done); return r.value; }
  const chunkBox = (i, j, C) => { C = C || CHUNK; return [i * C - C / 2, j * C - C / 2, i * C + C / 2, j * C + C / 2]; };

  // ── view wedge (horizontal): conservative 2-D cone test, so what is behind you is not drawn ──
  // cam {x,y,z,qx,qy,qz,qw,fov (deg, vertical),aspect}.  Returns a view record or one with wedge=false (looking nearly up / down, or a very wide view: no culling).
  function makeView(cam, margin) {
    const q = cam, vx = 0, vy = 0, vz = -1, tx = 2 * (q.qy * vz - q.qz * vy), ty = 2 * (q.qz * vx - q.qx * vz), tz = 2 * (q.qx * vy - q.qy * vx);
    const fx = vx + q.qw * tx + (q.qy * tz - q.qz * ty), fy = vy + q.qw * ty + (q.qz * tx - q.qx * tz), fz = vz + q.qw * tz + (q.qx * ty - q.qy * tx);
    const hl = Math.hypot(fx, fz), v = { x: cam.x, y: cam.y, z: cam.z, fx: 0, fz: -1, wedge: false, nlx: 0, nlz: 0, nrx: 0, nrz: 0, near: 24 };
    if (hl < 0.35) return v;                                      // nearly straight up / down: draw all round
    const dx = fx / hl, dz = fz / hl, vf = (cam.fov || 60) * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * (cam.aspect || 1.6)), pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
    const a = Math.atan(Math.tan(hf / 2) / Math.max(0.2, Math.cos(pitch))) + (margin != null ? margin : 0.45);
    if (a >= 1.45) return v;                                       // >= 83 degrees half-angle: the wedge would cull almost nothing
    const rx = -dz, rz = dx, sa = Math.sin(a), ca = Math.cos(a);   // right = (-dz, dx) in x/z (forward x right is y-up)
    v.wedge = true; v.fx = dx; v.fz = dz; v.nrx = dx * sa - rx * ca; v.nrz = dz * sa - rz * ca; v.nlx = dx * sa + rx * ca; v.nlz = dz * sa + rz * ca;
    return v;
  }
  function inView(v, x, z, r) {
    const dx = x - v.x, dz = z - v.z;
    if (!v.wedge || dx * dx + dz * dz < v.near * v.near) return true;
    return (v.nrx * dx + v.nrz * dz + r >= 0) && (v.nlx * dx + v.nlz * dz + r >= 0);
  }

  // ── re-bin: resident chunks -> draw buffers ──
  // chunks: [{cx, cz, data:[Float32Array per entry]}] ; bins[entryIdx][level] = {m: Float32Array(cap*16), c: Float32Array(cap*3), n, cap}
  // Nearest chunk first, so overflow (the cap) always drops the far end.  Returns {total, culled, far}.
  function rebin(biome, chunks, view, tier, dyn, bins, ringCaps) {
    const T = TIERS[tier], dm = DYN[dyn], kRank = Math.min(1, dm.density), cap = T.capTotal; let total = 0, culled = 0, far = 0;
    for (const row of bins) for (const b of row) if (b) b.n = 0;
    const order = chunks.slice().sort((a, b) => ((a.cx - view.x) ** 2 + (a.cz - view.z) ** 2) - ((b.cx - view.x) ** 2 + (b.cz - view.z) ** 2));
    const chunkR = CHUNK * 0.72;
    for (const ch of order) {
      if (!inView(view, ch.cx, ch.cz, chunkR)) { culled += ch.count || 0; continue; }
      for (let ei = 0; ei < biome.entries.length; ei++) {
        const e = biome.entries[ei], a = ch.data[ei]; if (!a || !a.length) continue; const first = firstLevel(e, tier, dyn); if (first < 0) continue;
        const rowBins = bins[ei], rc = ringCaps ? ringCaps[ei] : 0, rad = e.scale[1] * e.footprint;
        for (let o = 0; o < a.length; o += STRIDE) {
          if (a[o + 7] >= kRank) continue;
          if (total >= cap) return { total, culled, far, capped: true };
          const x = a[o], y = a[o + 1], z = a[o + 2], dx = x - view.x, dz = z - view.z, dy = y - view.y, d = Math.sqrt(dx * dx + dz * dz + dy * dy);
          const lv = pickLod(e, d, tier, dyn, rc); if (lv < 0) { far++; continue; }
          if (!inView(view, x, z, rad + 2)) { culled++; continue; }
          const b = rowBins[lv]; if (!b || b.n >= b.cap) continue;
          // fade the last 12 % of the entry's last allowed level so the far limit shrinks instead of popping
          let s = a[o + 3]; const lastLv = e.lod.length - 1; if (lv === lastLv) { const dEnd = effDist(e, lv, tier, dyn, rc), f = (dEnd - d) / (dEnd * 0.12); if (f < 1) s *= Math.max(0.05, f); }
          const cs = Math.cos(a[o + 4]) * s, sn = Math.sin(a[o + 4]) * s, sy = a[o + 6] * s, m = b.m, p = b.n * 16, c = b.c, q = b.n * 3;
          m[p] = cs; m[p + 1] = 0; m[p + 2] = -sn; m[p + 3] = 0; m[p + 4] = 0; m[p + 5] = sy; m[p + 6] = 0; m[p + 7] = 0; m[p + 8] = sn; m[p + 9] = 0; m[p + 10] = cs; m[p + 11] = 0; m[p + 12] = x; m[p + 13] = y; m[p + 14] = z; m[p + 15] = 1;
          const tv = 1 + (a[o + 5] - 0.5) * 2 * e.tintVar; c[q] = tv; c[q + 1] = 1 + (a[o + 5] - 0.5) * e.tintVar; c[q + 2] = tv;
          b.n++; total++;
        }
      }
    }
    return { total, culled, far, capped: false };
  }

  // biome for a world (host passes the ground style string and the palette's ground colour as a number)
  function biomeFor(style, groundHex) {
    if (style === 'mesa' || style === 'dunes') return 'dry-desert';
    if (style === 'lush' || style == null) return groundHex === 0x3a7d34 ? 'temperate-forest' : 'meadow';
    return null;   // ice, volcanic, ...: no scatter yet
  }

  const core = { CHUNK, STRIDE, LEVELS, TIERS, DYN, hash32, rnd, strHash, vnoise, fbm, smooth, rangeWeight, noiseWeight, clusterWeight, validateBiome, tierFor, dynFor, ringFor, effDist, pickLod, firstLevel, maxDistOf,
    cellSide, candidate, makeShoreGrid, makeSampler, placeBox, placeBoxG, chunkBox, makeView, inView, rebin, biomeFor };

  /* ═════════════════════════════ 2. BROWSER GLUE ═════════════════════════════ */
  const api = { core, on: false, biomes: {}, version: 1 };
  api.registerBiome = function (json) { const v = validateBiome(json); if (!v.ok) { try { console.warn('[scatter] biome rejected', json && json.id, v.errors); } catch (e) {} return v; } api.biomes[v.biome.id] = v.biome; return v; };
  api.biomeFor = biomeFor;
  api.replacesTrees = function () { return !!(api.on && S.biome && S.biome.entries.some((e) => e.kind === 'tree') && S.ready); };

  if (typeof window === 'undefined') { if (typeof module !== 'undefined' && module.exports) module.exports = api; return; }

  const readQ = () => { try { return location.search || ''; } catch (e) { return ''; } };
  let q = readQ();   // re-read by dispose() (a new world visit), so tests / the console can change the flags
  api.on = /[?&]scatter=1\b/.test(q);
  const qs = (k) => { const m = new RegExp('[?&]' + k + '=([\\w.-]+)').exec(q); return m ? m[1] : null; };
  const NOWIND = /[?&]scatterwind=0\b/.test(q), HUD = /[?&]scatterhud=1\b/.test(q);

  const S = { biome: null, tier: 0, seedKey: null, gen: -1, root: null, chunks: new Map(), job: null, bins: null, meshes: null, mats: null, geos: null, ringCaps: null, ringN: 1,
    view: null, lastView: null, lastRebin: 0, dirty: true, dyn: 0, ready: false, wind: null, stats: { total: 0, culled: 0, far: 0, chunks: 0, genMs: 0, rebinMs: 0, draws: 0, capped: false }, fields: null, ctxGen: 0 };
  api.state = S;

  /* ── placeholder meshes: procedural, vertex-coloured, base at y = 0, 1 unit = 1 m.  Attribute 'wind' = (trunk, branch, leaf) weights 0..1 per vertex (the future GLB pipeline
        exports the same attribute, e.g. from vertex colours in Blender; docs/biome-scatter.md).  Needs THREE. ── */
  function MB(THREE) {
    const P = [], C = [], W = [], U = [], I = [];
    const col = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
    const b = {
      vert(x, y, z, c, w, u, v) { P.push(x, y, z); C.push(c[0], c[1], c[2]); W.push(w[0], w[1], w[2]); U.push(u || 0, v || 0); return P.length / 3 - 1; },
      tri(a, bb, c) { I.push(a, bb, c); },
      // tapered ring tube from (0,y0) to (0,y1)
      tube(y0, y1, r0, r1, seg, hex, wf) { const c = col(hex), base = P.length / 3; for (let k = 0; k < 2; k++) for (let i = 0; i < seg; i++) { const a = i / seg * TAU, r = k ? r1 : r0, y = k ? y1 : y0; b.vert(Math.cos(a) * r, y, Math.sin(a) * r, c, wf(y), 0, 0); }
        for (let i = 0; i < seg; i++) { const n = (i + 1) % seg; b.tri(base + i, base + n, base + seg + i); b.tri(base + n, base + seg + n, base + seg + i); } },
      cone(y0, y1, r, seg, hex, wf, x, z) { const c = col(hex), base = P.length / 3, ox = x || 0, oz = z || 0; for (let i = 0; i < seg; i++) { const a = i / seg * TAU; b.vert(ox + Math.cos(a) * r, y0, oz + Math.sin(a) * r, c, wf(y0), 0, 0); }
        const t = b.vert(ox, y1, oz, c, wf(y1), 0, 1), cb = b.vert(ox, y0, oz, c, wf(y0), 0, 0); for (let i = 0; i < seg; i++) { const n = (i + 1) % seg; b.tri(base + i, base + n, t); b.tri(base + n, base + i, cb); } },
      blob(cx, cy, cz, rx, ry, rz, lon, lat, hex, wf, jit, seed) { const c = col(hex), base = P.length / 3; let sd = seed | 0;
        const rd = () => { sd = (Math.imul(sd, 1664525) + 1013904223) | 0; return (sd >>> 8) / 16777216; };
        for (let j = 0; j <= lat; j++) for (let i = 0; i < lon; i++) { const th = j / lat * Math.PI, ph = i / lon * TAU, k = 1 + (jit ? (rd() - 0.5) * jit : 0); const x = cx + Math.sin(th) * Math.cos(ph) * rx * k, y = cy + Math.cos(th) * ry * k, z = cz + Math.sin(th) * Math.sin(ph) * rz * k; const sh = 0.75 + 0.25 * (y - (cy - ry)) / (2 * ry); b.vert(x, y, z, [c[0] * sh, c[1] * sh, c[2] * sh], wf(y), 0, 0); }
        for (let j = 0; j < lat; j++) for (let i = 0; i < lon; i++) { const n = (i + 1) % lon, a0 = base + j * lon + i, a1 = base + j * lon + n, b0 = base + (j + 1) * lon + i, b1 = base + (j + 1) * lon + n; b.tri(a0, b0, a1); b.tri(a1, b0, b1); } },
      // a grass-like blade: bent strip of 2 or 3 segments
      blade(x, z, ang, h, w, bend, hex, hexTip, segs) { const c0 = col(hex), c1 = col(hexTip || hex), base = P.length / 3, ca = Math.cos(ang), sa = Math.sin(ang);
        for (let k = 0; k <= segs; k++) { const t = k / segs, y = h * t, off = bend * t * t, ww = w * (1 - t * 0.92), cc = [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)], wgt = [0, 0.25 * t, t];
          b.vert(x + ca * off - sa * ww, y, z + sa * off + ca * ww, cc, wgt, 0, t); b.vert(x + ca * off + sa * ww, y, z + sa * off - ca * ww, cc, wgt, 1, t); }
        for (let k = 0; k < segs; k++) { const a = base + k * 2; b.tri(a, a + 1, a + 2); b.tri(a + 1, a + 3, a + 2); } },
      // crossed impostor card (two quads, uv 0..1) with a tint ramp bottom -> top
      card(w, h, hexLo, hexHi, wf) { const lo = col(hexLo), hi = col(hexHi), base = P.length / 3;
        for (let k = 0; k < 2; k++) { const a = k * Math.PI / 2, ca = Math.cos(a) * w / 2, sa = Math.sin(a) * w / 2;
          b.vert(-ca, 0, -sa, lo, wf(0), 0, 0); b.vert(ca, 0, sa, lo, wf(0), 1, 0); b.vert(ca, h, sa, hi, wf(h), 1, 1); b.vert(-ca, h, -sa, hi, wf(h), 0, 1); }
        for (let k = 0; k < 2; k++) { const a = base + k * 4; b.tri(a, a + 1, a + 2); b.tri(a, a + 2, a + 3); } },
      build() { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setAttribute('wind', new THREE.Float32BufferAttribute(W, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
        g.setIndex(I); g.computeVertexNormals(); g.computeBoundingSphere(); g.userData.shared = true; return g; },
    };
    return b;
  }
  // trunk (bends a little at the top), branches (middle), leaves (the crown): weight functions of height
  const WF = (h) => (y) => { const t = Math.max(0, Math.min(1, y / h)); return [t * t, smooth(0.25, 0.8, t), smooth(0.45, 1, t)]; };
  const WCARD = (h) => (y) => { const t = Math.max(0, Math.min(1, y / h)); return [t * t, 0.7 * t, t]; };
  const WGRASS = (h) => (y) => { const t = Math.max(0, Math.min(1, y / h)); return [0, 0.3 * t, t]; };
  const STIFF = () => [0, 0, 0];
  const BUILTIN = {
    // trees (the height is the nominal 1 x scale; a scale of 1 is ~7 m for conifer, ~6 m for broadleaf)
    'proc:conifer-0': (T) => { const h = 8, w = WF(h), b = MB(T); b.tube(0, 2.2, 0.28, 0.2, 6, 0x4a3220, w); for (let k = 0; k < 6; k++) b.cone(1.4 + k * 1.05, 3.2 + k * 1.05 + 0.4, 2.1 - k * 0.3, 9, k % 2 ? 0x1f5a2a : 0x246a30, w); b.cone(6.2, 8, 0.7, 7, 0x2a7336, w); return b.build(); },
    'proc:conifer-1': (T) => { const h = 8, w = WF(h), b = MB(T); b.tube(0, 2.2, 0.28, 0.2, 5, 0x4a3220, w); b.cone(1.4, 4.2, 2.0, 7, 0x1f5a2a, w); b.cone(3.2, 6.2, 1.5, 7, 0x246a30, w); b.cone(5, 8, 0.9, 6, 0x2a7336, w); return b.build(); },
    'proc:conifer-2': (T) => { const h = 8, w = WF(h), b = MB(T); b.tube(0, 1.8, 0.3, 0.2, 4, 0x4a3220, w); b.cone(1.2, 8, 1.8, 6, 0x236630, w); return b.build(); },
    'card:conifer': (T) => { const b = MB(T); b.card(4, 8, 0x1c4a26, 0x2a7336, WCARD(8)); return b.build(); },
    'proc:broadleaf-0': (T) => { const h = 7, w = WF(h), b = MB(T); b.tube(0, 3.4, 0.34, 0.2, 6, 0x5a4026, w); b.blob(0, 5.1, 0, 2.5, 1.9, 2.5, 9, 6, 0x3f8a36, w, 0.25, 11); b.blob(1.5, 4.4, 0.6, 1.5, 1.2, 1.5, 8, 5, 0x4a9a3e, w, 0.25, 12); b.blob(-1.3, 4.6, -0.8, 1.6, 1.2, 1.6, 8, 5, 0x377c30, w, 0.25, 13); return b.build(); },
    'proc:broadleaf-1': (T) => { const h = 7, w = WF(h), b = MB(T); b.tube(0, 3.4, 0.34, 0.2, 5, 0x5a4026, w); b.blob(0, 5, 0, 2.7, 2.1, 2.7, 7, 5, 0x3f8a36, w, 0.2, 21); return b.build(); },
    'proc:broadleaf-2': (T) => { const h = 7, w = WF(h), b = MB(T); b.tube(0, 3.2, 0.34, 0.25, 4, 0x5a4026, w); b.blob(0, 4.9, 0, 2.6, 2, 2.6, 5, 4, 0x3f8a36, w, 0, 0); return b.build(); },
    'card:broadleaf': (T) => { const b = MB(T); b.card(5.4, 7, 0x2e6a2a, 0x4a9a3e, WCARD(7)); return b.build(); },
    // bushes
    'proc:shrub-0': (T) => { const h = 1.6, w = WF(h), b = MB(T); b.blob(0, 0.8, 0, 1, 0.8, 1, 8, 5, 0x4a8a38, w, 0.3, 31); b.blob(0.7, 0.6, 0.3, 0.6, 0.5, 0.6, 7, 4, 0x57a043, w, 0.3, 32); b.blob(-0.6, 0.6, -0.4, 0.6, 0.5, 0.6, 7, 4, 0x3f7a32, w, 0.3, 33); return b.build(); },
    'proc:shrub-1': (T) => { const h = 1.6, w = WF(h), b = MB(T); b.blob(0, 0.8, 0, 1.1, 0.85, 1.1, 6, 4, 0x4a8a38, w, 0.2, 41); return b.build(); },
    'proc:shrub-2': (T) => { const h = 1.6, w = WF(h), b = MB(T); b.blob(0, 0.7, 0, 1.1, 0.8, 1.1, 5, 3, 0x4a8a38, w, 0, 0); return b.build(); },
    'card:shrub': (T) => { const b = MB(T); b.card(2.2, 1.6, 0x356a2c, 0x57a043, WCARD(1.6)); return b.build(); },
    // grass tufts / flowers (0.5 m)
    'proc:grass-0': (T) => { const b = MB(T); for (let i = 0; i < 9; i++) { const a = i * 2.399, r = 0.05 + (i % 3) * 0.05; b.blade(Math.cos(a) * r, Math.sin(a) * r, a, 0.38 + (i % 4) * 0.07, 0.025, 0.09 + (i % 2) * 0.06, 0x3f7a2c, 0x8fbf4a, 3); } return b.build(); },
    'proc:grass-1': (T) => { const b = MB(T); for (let i = 0; i < 4; i++) { const a = i * 2.399, r = 0.06 + (i % 2) * 0.05; b.blade(Math.cos(a) * r, Math.sin(a) * r, a, 0.42 + (i % 3) * 0.08, 0.04, 0.1, 0x3f7a2c, 0x8fbf4a, 2); } return b.build(); },
    'card:grass': (T) => { const b = MB(T); b.card(0.7, 0.55, 0x3f7a2c, 0x8fbf4a, WGRASS(0.55)); return b.build(); },
    'proc:flower-0': (T) => { const b = MB(T); for (let i = 0; i < 3; i++) { const a = i * 2.1, x = Math.cos(a) * 0.12, z = Math.sin(a) * 0.12; b.blade(x, z, a, 0.4, 0.012, 0.05, 0x3f7a2c, 0x5a9a3a, 2); b.blob(x + 0.02, 0.43, z, 0.07, 0.03, 0.07, 6, 3, i === 1 ? 0xf4e24a : 0xf0f0f4, WGRASS(0.45), 0, 0); } for (let i = 0; i < 4; i++) b.blade(Math.cos(i * 1.7) * 0.05, Math.sin(i * 1.7) * 0.05, i * 1.7, 0.3, 0.025, 0.07, 0x3f7a2c, 0x6aa03a, 2); return b.build(); },
    'proc:flower-1': (T) => { const b = MB(T); b.blade(0, 0, 0.5, 0.42, 0.03, 0.06, 0x3f7a2c, 0x6aa03a, 2); b.blob(0.01, 0.43, 0, 0.1, 0.04, 0.1, 5, 3, 0xf0e8a0, WGRASS(0.45), 0, 0); return b.build(); },
    'card:flower': (T) => { const b = MB(T); b.card(0.5, 0.45, 0x4a8a38, 0xf0e8a0, WGRASS(0.45)); return b.build(); },
    // dry biome
    'proc:cactus-0': (T) => { const h = 3, w = WF(h), b = MB(T); b.tube(0, 2.8, 0.3, 0.26, 8, 0x4f8a4a, STIFF); b.cone(2.8, 3.1, 0.26, 8, 0x4f8a4a, STIFF); b.tube(1.2, 1.5, 0.16, 0.16, 6, 0x4f8a4a, STIFF); b.tube(1.5, 2.3, 0.16, 0.14, 6, 0x4f8a4a, STIFF); b.tube(0.9, 1.1, 0.14, 0.14, 6, 0x4f8a4a, STIFF); return b.build(); },
    'proc:cactus-1': (T) => { const b = MB(T); b.tube(0, 2.8, 0.3, 0.26, 6, 0x4f8a4a, STIFF); b.cone(2.8, 3.1, 0.26, 6, 0x4f8a4a, STIFF); return b.build(); },
    'proc:cactus-2': (T) => { const b = MB(T); b.tube(0, 3, 0.3, 0.28, 4, 0x4f8a4a, STIFF); return b.build(); },
    'card:cactus': (T) => { const b = MB(T); b.card(1.6, 3, 0x3f7a3a, 0x5a9a50, STIFF); return b.build(); },
    'proc:deadbush-0': (T) => { const b = MB(T); for (let i = 0; i < 9; i++) { const a = i * 2.4, r = 0.05; b.blade(Math.cos(a) * r, Math.sin(a) * r, a, 0.5 + (i % 3) * 0.12, 0.02, 0.22, 0x6a4f32, 0x9a7c50, 2); } return b.build(); },
    'proc:deadbush-1': (T) => { const b = MB(T); for (let i = 0; i < 4; i++) b.blade(0, 0, i * 1.7, 0.6, 0.03, 0.2, 0x6a4f32, 0x9a7c50, 2); return b.build(); },
    'card:deadbush': (T) => { const b = MB(T); b.card(1, 0.8, 0x6a4f32, 0x9a7c50, WGRASS(0.8)); return b.build(); },
    'proc:drygrass-0': (T) => { const b = MB(T); for (let i = 0; i < 8; i++) { const a = i * 2.399, r = 0.05 + (i % 3) * 0.04; b.blade(Math.cos(a) * r, Math.sin(a) * r, a, 0.4 + (i % 4) * 0.08, 0.022, 0.12, 0x8a7440, 0xc9b070, 3); } return b.build(); },
    'proc:drygrass-1': (T) => { const b = MB(T); for (let i = 0; i < 3; i++) b.blade(Math.cos(i * 2.1) * 0.05, Math.sin(i * 2.1) * 0.05, i * 2.1, 0.45, 0.04, 0.12, 0x8a7440, 0xc9b070, 2); return b.build(); },
    'card:drygrass': (T) => { const b = MB(T); b.card(0.7, 0.5, 0x8a7440, 0xc9b070, WGRASS(0.5)); return b.build(); },
    // rocks (static: no wind)
    'proc:rock-0': (T) => { const b = MB(T); b.blob(0, 0.35, 0, 0.6, 0.4, 0.5, 8, 5, 0x7a7468, STIFF, 0.35, 51); return b.build(); },
    'proc:rock-1': (T) => { const b = MB(T); b.blob(0, 0.35, 0, 0.6, 0.4, 0.5, 5, 3, 0x7a7468, STIFF, 0.3, 52); return b.build(); },
  };
  api.meshRegistry = BUILTIN;
  // external assets (future GLB pipeline) register a factory: DMBiomeScatter.registerMesh('glb:oak_lod1', (THREE)=>BufferGeometry)
  api.registerMesh = function (id, factory) { BUILTIN[id] = factory; };

  // ── materials: one per (card shape | foliage), wind as three layers ──
  function windUniforms() {
    if (S.wind) return S.wind; const W = window; if (typeof W.uniform !== 'function') return null;
    S.wind = { dir: W.uniform(new THREE.Vector2(0.8, 0.6)), str: W.uniform(1), layers: W.uniform(new THREE.Vector3(1, 1, 1)), amp: W.uniform(new THREE.Vector3(0.35, 0.28, 0.06)) };
    return S.wind;
  }
  // 3 layers: (1) trunk sway - slow lean + oscillation of the whole plant, weight ~ height^2; (2) branch gust - travelling gust field, mid frequency; (3) leaf flutter - fast per-vertex
  // jitter driven by the gust.  positionLocal here is already the instanced position (three applies the instance matrix first), so world-ish x / z give a coherent travelling wave.
  function windNode(entryWind) {
    const W = window, U = windUniforms(); if (!U || NOWIND || typeof W.attribute !== 'function' || !W.time) return null;
    const wv = W.attribute('wind', 'vec3'), p = W.positionLocal, t = W.time, d = U.dir;
    const ph = p.x.mul(d.x).add(p.z.mul(d.y)).mul(0.07);
    const gust = W.sin(ph.sub(t.mul(1.1))).mul(0.5).add(0.5).mul(W.sin(p.x.mul(0.031).add(p.z.mul(0.047)).add(t.mul(0.23))).mul(0.5).add(0.5)).mul(0.8).add(0.2);
    const dir3 = W.vec3(d.x, 0, d.y), perp = W.vec3(d.y.negate(), 0, d.x);
    const trunk = dir3.mul(gust.mul(0.7).add(W.sin(t.mul(1.2).add(ph.mul(3))).mul(0.3))).mul(wv.x).mul(U.amp.x).mul(U.layers.x).mul(entryWind.trunk);
    const branch = dir3.add(perp.mul(W.sin(t.mul(1.7).add(p.y)))).mul(W.sin(t.mul(2.6).add(ph.mul(5)).add(p.y.mul(0.9))).mul(0.5).add(0.5)).mul(gust).mul(wv.y).mul(U.amp.y).mul(U.layers.y).mul(entryWind.branch);
    const pg = W.positionGeometry;
    const leaf = W.vec3(W.sin(t.mul(9).add(pg.x.mul(7)).add(pg.z.mul(5))), W.sin(t.mul(11).add(pg.y.mul(9))), W.cos(t.mul(8).add(pg.z.mul(6)).add(pg.x.mul(3)))).mul(gust).mul(wv.z).mul(U.amp.z).mul(U.layers.z).mul(entryWind.leaf);
    return p.add(trunk.mul(U.str)).add(branch.mul(U.str)).add(leaf.mul(U.str));
  }
  // procedural silhouettes for the impostor cards (alpha test, no textures)
  function cardAlpha(shape) {
    const W = window, uv = W.uv(), x = uv.x.sub(0.5).mul(2), y = uv.y;   // x -1..1, y 0..1;  f > 0 inside the silhouette; the result is a 0 / 1 mask for alphaTest
    const ell = (cx, cy, rx, ry) => W.float(1).sub(x.sub(cx).div(rx).pow(2).add(y.sub(cy).div(ry).pow(2)));
    const box = (cx, hx, y0, y1) => W.step(W.abs(x.sub(cx)), hx).mul(W.step(y0, y)).mul(W.step(y, y1)).sub(0.5);
    let f;
    if (shape === 'conifer') {
      const tri = W.float(1).sub(W.abs(x).div(W.float(0.04).add(W.float(1).sub(y.sub(0.15).div(0.85)).mul(0.96)))).mul(W.step(0.15, y)).sub(W.step(y, 0.15));
      f = W.max(tri, box(0, 0.1, 0, 0.2));
    } else if (shape === 'broadleaf') f = W.max(ell(0, 0.68, 0.95, 0.32), box(0, 0.1, 0, 0.45));
    else if (shape === 'shrub') f = ell(0, 0.42, 0.95, 0.58);
    else if (shape === 'cactus') f = W.max(W.max(box(0, 0.22, 0, 0.95), box(0.5, 0.12, 0.35, 0.7)), box(0.36, 0.2, 0.35, 0.45));   // trunk + one arm on the right
    else if (shape === 'flower') f = W.max(box(0, 0.1, 0, 0.7), ell(0, 0.85, 0.5, 0.17));
    else { const tri = W.abs(W.fract(x.mul(2.5).add(0.5)).sub(0.5)).mul(2); f = W.float(1).sub(y).mul(0.9).add(0.1).sub(tri); }   // grass / drygrass / deadbush: a fan of blades
    return W.step(0.0, f);
  }
  function getMaterial(THREE, key, entryWind, card) {
    const mk = key + '|' + entryWind.trunk + entryWind.branch + entryWind.leaf + '|' + (card ? 'c' : 'm'); if (S.mats[mk]) return S.mats[mk];
    const Mat = THREE.MeshLambertNodeMaterial || THREE.MeshStandardNodeMaterial || THREE.MeshLambertMaterial; let m;
    try { m = new Mat({ vertexColors: true, side: THREE.DoubleSide }); } catch (e) { m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); }
    try { const wn = windNode(entryWind); if (wn) m.positionNode = wn; } catch (e) { console.warn('[scatter] wind node', e); }
    if (card) { try { m.opacityNode = cardAlpha(key); m.alphaTest = 0.5; } catch (e) { console.warn('[scatter] card alpha', e); } }
    m.userData.shared = true; S.mats[mk] = m; return m;
  }
  const cardShapeOf = (id) => String(id).replace(/^card:/, '');

  // ── pooled meshes: one per (entry, level) ──
  function buildLayer(THREE, ctx) {
    const biome = S.biome, T = TIERS[S.tier]; S.geos = S.geos || {}; S.mats = S.mats || {}; S.bins = []; S.meshes = [];
    const root = new THREE.Group(); root.name = 'JOTS_BiomeScatter'; root.frustumCulled = false;
    biome.entries.forEach((e, ei) => {
      const bins = [], meshes = [];
      for (let lv = 0; lv < LEVELS; lv++) {
        const L = e.lod[lv]; if (!L) { bins.push(null); meshes.push(null); continue; }
        if (lv < firstLevel(e, S.tier, 0) || (T.cardOnly && !L.card)) { bins.push(null); meshes.push(null); continue; }
        const id = L.card || L.mesh, isCard = !!L.card; let geo = S.geos[id];
        if (!geo) { const f = BUILTIN[id]; if (!f) { console.warn('[scatter] unknown mesh', id, 'in', e.id); bins.push(null); meshes.push(null); continue; } geo = S.geos[id] = f(THREE); }
        const cap = Math.max(2048, T.bufCap), mat = getMaterial(THREE, isCard ? cardShapeOf(id) : id.split('-')[0], e.wind, isCard);
        const im = new THREE.InstancedMesh(geo, mat, cap); im.count = 0; im.frustumCulled = false; im.name = 'scatter:' + e.id + ':L' + lv;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); im.instanceColor.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = false; im.receiveShadow = !!T.recv && !isCard; im.matrixAutoUpdate = false; im.userData.noCollide = true;
        root.add(im); meshes.push(im); bins.push({ m: im.instanceMatrix.array, c: im.instanceColor.array, n: 0, cap });
      }
      S.bins.push(bins); S.meshes.push(meshes);
    });
    S.ringCaps = biome.entries.map((e) => 0);
    return root;
  }

  function disposeLayer() {
    const r = S.root; if (r) { if (r.parent) r.parent.remove(r); r.traverse((o) => { if (o.isInstancedMesh && o.dispose) o.dispose(); }); }
    if (S.geos) for (const k in S.geos) { try { S.geos[k].dispose(); } catch (e) {} }
    if (S.mats) for (const k in S.mats) { try { S.mats[k].dispose(); } catch (e) {} }
    S.root = null; S.geos = null; S.mats = null; S.bins = null; S.meshes = null; S.chunks.clear(); S.job = null; S.ready = false; S.stats = { total: 0, culled: 0, far: 0, chunks: 0, genMs: 0, rebinMs: 0, draws: 0, capped: false }; S.seedKey = null; S.dirty = true; S.lastView = null; S.lastRebin = 0;
  }
  api.dispose = function () { disposeLayer(); q = readQ(); S._warn = 0; };

  function pickTier(ctx) {
    const f = qs('scattertier'); let lodTier = null; try { lodTier = window.DMLod && DMLod.tier; } catch (e) {} if (!lodTier) lodTier = ctx.isMobile ? 'mobile' : 'desktop';
    return tierFor({ force: f != null ? +f : null, lodTier, preset: ctx.preset });
  }
  function dynNow() { let p = 0, f = 0; try { const B = window.DMBudget; if (B && B.on) { p = B.lvl('props'); f = B.fast ? B.fast() : 0; } } catch (e) {} return dynFor(p, f); }

  /* tick(ctx): called once per frame from the game's prop tick (index.html _pwPropsTick).
   * ctx = { THREE, parent (Group), seed, gen (world visit id), style, ground (palette ground hex), H(x,z), sea, px, pz (LOD centre, flat), agl, cam {x,y,z,qx,qy,qz,qw,fov,aspect}, isMobile, preset, tag(root), dt, now } */
  api.tick = function (ctx) {
    if (!api.on) return; const THREE = ctx.THREE;
    try {
      const key = ctx.gen + '|' + ctx.seed + '|' + q;
      if (S.seedKey !== key) {
        disposeLayer(); S.seedKey = key;
        const id = qs('scatterbiome') || biomeFor(ctx.style, ctx.ground); S.biome = id ? api.biomes[id] || null : null;
        if (!S.biome) { S.ready = false; return; }
        S.tier = pickTier(ctx); S.root = buildLayer(THREE, ctx); ctx.parent.add(S.root); S.root.visible = true;
        if (ctx.tag) ctx.tag(S.root);   // the planet frame (curvature + reveal mask) is applied to the materials once; they are shared by every chunk
        S.ready = true; S.dirty = true; S.chunks.clear(); S.job = null;
        S.ringN = Math.max(1, Math.min(TIERS[S.tier].ring, Math.ceil(maxDistOf(S.biome, S.tier, 0) / CHUNK))); S.ringCaps = S.biome.entries.map((e) => ringFor(S.tier, e.lod[e.lod.length - 1].maxDist * TIERS[S.tier].dist));
        try { console.log('[scatter] biome ' + S.biome.id + ' tier ' + S.tier + ' (' + TIERS[S.tier].name + ') ring ' + S.ringN); } catch (e) {}
      }
      if (!S.ready) return;
      const T = TIERS[S.tier], now = ctx.now || performance.now();
      S.root.visible = ctx.agl < 260;       // high above the ground nothing here would be seen (the far canopy / map take over)
      if (!S.root.visible) return;
      // wind uniforms (cheap; the three layers read them)
      if (S.wind) { const t = now / 1000, a = 0.9 + 0.35 * Math.sin(t * 0.05) + 0.15 * Math.sin(t * 0.13 + 1.3); S.wind.dir.value.set(Math.cos(a), Math.sin(a)); S.wind.str.value = 0.8 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.11)); S.wind.layers.value.set(T.wind[0], T.wind[1], T.wind[2]); }
      // chunk streaming: nearest missing first, one job at a time, ~2 ms (mobile) / 4 ms a frame
      const C = CHUNK, ci = Math.floor((ctx.px + C / 2) / C), cj = Math.floor((ctx.pz + C / 2) / C), R = S.ringN;
      let changed = false;
      for (const [k, ch] of S.chunks) if (Math.abs(ch.i - ci) > R + 1 || Math.abs(ch.j - cj) > R + 1) { S.chunks.delete(k); changed = true; }
      if (!S.job) {
        let bd = 1e30, bi = 0, bj = 0;
        for (let di = -R; di <= R; di++) for (let dj = -R; dj <= R; dj++) { const i = ci + di, j = cj + dj; if (S.chunks.has(i + '_' + j)) continue; const d = (i * C - ctx.px) ** 2 + (j * C - ctx.pz) ** 2; if (d < bd) { bd = d; bi = i; bj = j; } }
        if (bd < 1e30) { const [x0, z0, x1, z1] = chunkBox(bi, bj, C), grid = makeShoreGrid(ctx.H, x0, z0, x1, z1, ctx.sea || 0, T.gridStep, 60); S.job = { i: bi, j: bj, it: placeBoxG(S.biome, ctx.seed, x0, z0, x1, z1, { H: ctx.H, sea: ctx.sea || 0, grid }, { densityK: T.density, slice: 300 }), t: 0 }; }
      }
      if (S.job) {
        const t0 = performance.now(), budget = ctx.isMobile ? 2 : 4; let r;
        do { r = S.job.it.next(); } while (!r.done && performance.now() - t0 < budget);
        S.job.t += performance.now() - t0;
        if (r.done) { let n = 0; for (const a of r.value) n += a.length / STRIDE; S.chunks.set(S.job.i + '_' + S.job.j, { i: S.job.i, j: S.job.j, cx: S.job.i * C, cz: S.job.j * C, data: r.value, count: n }); S.stats.genMs = S.job.t; S.job = null; changed = true; }
      }
      // re-bin when the view moved / turned / the chunk set or the budget changed, at most every T.rebinMs
      const cam = ctx.cam, dyn = dynNow(); if (dyn !== S.dyn) { S.dyn = dyn; changed = true; }
      const lv = S.lastView, moved = !lv || Math.abs(cam.x - lv.x) + Math.abs(cam.z - lv.z) + Math.abs(cam.y - lv.y) > 4 || Math.abs(cam.qy - lv.qy) + Math.abs(cam.qx - lv.qx) + Math.abs(cam.qz - lv.qz) + Math.abs(cam.qw - lv.qw) > 0.04;
      if (changed) S.dirty = true;   // a change inside the throttle window must not be lost
      if ((moved || S.dirty) && now - S.lastRebin >= T.rebinMs) {
        const t0 = performance.now(), view = makeView(cam, 0.45);
        const res = rebin(S.biome, Array.from(S.chunks.values()), view, S.tier, S.dyn, S.bins, S.ringCaps);
        let draws = 0;
        for (let ei = 0; ei < S.meshes.length; ei++) for (let lv2 = 0; lv2 < LEVELS; lv2++) { const im = S.meshes[ei][lv2]; if (!im) continue; const n = S.bins[ei][lv2].n; im.count = n; im.visible = n > 0; if (n > 0) { draws++; const ia = im.instanceMatrix, ic = im.instanceColor; if (ia.clearUpdateRanges) { ia.clearUpdateRanges(); ia.addUpdateRange(0, n * 16); ic.clearUpdateRanges(); ic.addUpdateRange(0, n * 3); } ia.needsUpdate = true; ic.needsUpdate = true; } }
        S.lastView = { x: cam.x, y: cam.y, z: cam.z, qx: cam.qx, qy: cam.qy, qz: cam.qz, qw: cam.qw }; S.lastRebin = now; S.dirty = false;
        S.stats.total = res.total; S.stats.culled = res.culled; S.stats.far = res.far; S.stats.capped = !!res.capped; S.stats.chunks = S.chunks.size; S.stats.rebinMs = performance.now() - t0; S.stats.draws = draws; S.stats.tier = S.tier; S.stats.dyn = S.dyn;
        if (HUD && (S._hudN = (S._hudN || 0) + 1) % 20 === 0) console.log('[scatter]', JSON.stringify(S.stats));
      }
    } catch (e) { if (!S._warn) { S._warn = 1; console.warn('[scatter] tick failed; scatter switched off for this visit', e); } api.on = false; try { disposeLayer(); } catch (e2) {} }
  };
  api.stats = function () { return Object.assign({ on: api.on, ready: S.ready, biome: S.biome && S.biome.id, tier: S.tier }, S.stats); };

  root.DMBiomeScatter = api;
})(typeof window !== 'undefined' ? window : globalThis);
