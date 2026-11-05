/* DART Meadow — parallax occlusion mapping (POM) for procedurally generated surfaces.
 *
 * Gives flat generated textures (cobblestone, rock plates, cracked mud, planet crust) "true geometry" depth: crevices that hide
 * what is behind them, light that falls off into the cracks, contact shadow of the high parts on the low parts.  No geometry.
 *
 * ALGORITHM — the standard published height-field ray-march, written from scratch here:
 *   · Policarpo et al., "Parallax Occlusion Mapping / Relief Texture Mapping", I3D 2005 (relief mapping: linear search + binary refine)
 *   · N. Tatarchuk, "Dynamic parallax occlusion mapping with approximate soft shadows", I3D 2006 (view-adaptive step count, soft shadow)
 *   · Dachsbacher & Tatarchuk, "Prism parallax occlusion mapping", 2007 (silhouette handling)
 *   · Schüler, "Followup: Normal Mapping Without Precomputed Tangents" (derivative tangent frame, so any mesh/UV works)
 *   Inspiration for the inputs (Depth, Bias, per-pixel iterations) is the Blender extension "Parallax Node" by MultLabs
 *   (https://multlabs.com, GPL-3.0-or-later). NO CODE from it was read into or copied into this file; the original is GPL-3.0-or-later
 *   and this file is the project's own implementation of the published algorithm.
 *
 * MODEL (all in "uv units"; the polygon plane is z = 0, heights h in 0..1 from the height texture):
 *   surface(uv) = depth * (h(uv) - bias).  bias = 1: everything sinks below the polygon (classic POM); bias = 0: it all stands above;
 *   0.5: half and half.  The eye ray enters the slab at its top, z = depth*(1-bias), and is stepped down in n layers to the first layer
 *   below the surface; the last two samples are then linearly interpolated (and, on desktop, binary-refined: "relief" steps).
 *
 * COST CONTROL (the frame rate is the budget, never the preset the player chose):
 *   · the TSL graph is built ONCE per device class with fixed upper bounds (desktop 24 steps/6 shadow taps/2 relief, mobile 16/3/1);
 *     the live step counts are shared uniforms driven by the graphics preset (desktop 4-24, mobile 3-16), so changing
 *     preset or the governor's render scale never recompiles.  Per-material numbers (depth, bias, reach) are material properties
 *     read through materialReference, so all materials of a kind share ONE shader program.
 *   · distance fade: beyond `far` the whole march sits behind a real branch (plain UVs, one texture fetch); inside, depth fades out.
 *   · view-angle adaptive step count (fewer steps looking straight down), grazing clamp (|V.xy/V.z| limited) for silhouettes.
 *   · self-shadow of the height field along the sun (soft, 6 taps) only on the desktop tier.
 *   · ui/dm-governor.js render scale < ~0.9 lowers the step count and drops shadows (uniform writes only, polled twice a second).
 *   · FRAME-TIME GOVERNOR (v236): the march is a per-pixel cost on all the walkable ground near the camera, so it follows the MEASURED frame time,
 *     not only the preset. Three levels, uniforms only (no recompile, no material rebuild): 2 = the preset's own steps (+ shadow/relief on desktop),
 *     1 = at most 4 steps, 0 = the march branch is skipped (the height-gradient normal and cavity stay, so the ground keeps its relief; only the
 *     hidden-behind-the-stone parallax shift goes).  Phones/tablets START at level 1 and are promoted to 2 only after the frames have been inside
 *     budget for a while; any stretch over budget steps down at once.  A promotion that is undone within 20 s doubles the wait before the next try
 *     (hysteresis + back-off), so a device where the preset's march is too dear settles on the cheaper level instead of flapping.  ?pxgov=0 disables it.
 *   · height maps are derived ONCE from the generated texels and cached (R8, 1/4 of the RGBA), shared by every material using them.
 *   · (v256) EVERY tier marches: Low is not "off" any more, it is the same graph with small numbers.  The per-tier table (TIERS below) gives, per device class:
 *     steps (max layers) + minSteps (the governor's floor), shadow taps on/off, relief (binary refine) on/off, depth (relief depth multiplier), reach (multiplier of every
 *     near/far fade distance), lodBias (coarser height mip = fewer cache lines), hTile (ground height-atlas tile texels), hMax (derived structure height map cap, px).
 *     All of those except hTile/hMax are shared uniforms (steps, shadow, relief, depthK, reachK, lodBias): a tier or governor change is a uniform write, never a recompile,
 *     and every material of a kind shares ONE program (depth / bias / range / map size ride on material properties through materialReference).
 *   · QUALITY GOVERNOR (v256, replaces the 3-level one): q in [0,1], continuous, uniforms only.  steps = max(minSteps, round(steps*q)), depth = tier depth*(0.55+0.45q),
 *     reach = tier reach*(0.5+0.5q), relief only above q 0.5, shadow only above q 0.85.  Phones/tablets start from the last settled q (localStorage) or 0.6; over budget for 1 s
 *     trims q at once (bigger step when far over), calm for `hold` ms probes one small step up; a probe undone within 20 s doubles the hold (hysteresis).  ui/dm-governor.js
 *     asks DMParallax.trimFirst() before it cuts the render scale: parallax steps / reach / depth are traded FIRST (for at most 6 s per episode, never when >2.5x over budget).
 *   · ?px=0 is the A/B kill switch (the graph is not built at all).  ?px=ultra|high|medium|low forces a tier, ?pxq=0..1 pins q (tests / renders).
 *
 * Public: DMParallax.{ref, heightFromRGBA, heightFromNormals, makeTile, heightTexture, refresh, applyToMaterial, applyGround, config, status}
 *   ref = the pure-JS version of the stepping math (unit-tested against analytic height fields in tools/tests/parallax-unit.js).
 */
(function (root) {
  'use strict';
  const G = root;
  const off = /[?&]px=0\b/.test((G.location && G.location.search) || '');
  const forced = ((((G.location && G.location.search) || '').match(/[?&]px=(low|medium|high|ultra)\b/)) || [])[1] || null;

  /* ─────────────────────────── 1. tiers ─────────────────────────── */
  // steps = layers of the linear search at grazing (face-on the shader uses 35 %); minSteps = what the governor can never go below; shadow = soft shadow on/off; relief = binary
  // refine on/off; depth = relief depth multiplier; reach = multiplier of every near/far fade distance; lodBias = added to the height-mip level; hTile = ground atlas tile texels;
  // hMax = cap (px) of height maps derived from normal / colour maps.   Every tier is non-zero in every column (Low is small, never off).
  const TIERS = {
    desktop: {
      low:    { steps: 4,  minSteps: 2, shadow: 0, relief: 0, depth: 0.5, reach: 0.55, lodBias: 1.0, hTile: 96,  hMax: 256 },
      medium: { steps: 16, minSteps: 3, shadow: 0, relief: 0, depth: 0.8, reach: 0.85, lodBias: 0.0, hTile: 160, hMax: 512 },
      high:   { steps: 20, minSteps: 4, shadow: 1, relief: 1, depth: 1.0, reach: 1.0,  lodBias: 0.0, hTile: 192, hMax: 512 },
      ultra:  { steps: 24, minSteps: 4, shadow: 1, relief: 1, depth: 1.1, reach: 1.2,  lodBias: 0.0, hTile: 256, hMax: 1024 },
      custom: { steps: 16, minSteps: 3, shadow: 0, relief: 0, depth: 0.8, reach: 0.85, lodBias: 0.0, hTile: 160, hMax: 512 },
    },
    mobile: {
      low:    { steps: 3,  minSteps: 2, shadow: 0, relief: 0, depth: 0.45, reach: 0.5,  lodBias: 1.0, hTile: 96,  hMax: 256 },
      medium: { steps: 8,  minSteps: 3, shadow: 0, relief: 0, depth: 0.7,  reach: 0.7,  lodBias: 0.5, hTile: 128, hMax: 256 },
      high:   { steps: 12, minSteps: 3, shadow: 0, relief: 1, depth: 0.9,  reach: 0.9,  lodBias: 0.0, hTile: 160, hMax: 512 },
      ultra:  { steps: 16, minSteps: 4, shadow: 1, relief: 1, depth: 1.0,  reach: 1.0,  lodBias: 0.0, hTile: 192, hMax: 512 },
      custom: { steps: 8,  minSteps: 3, shadow: 0, relief: 0, depth: 0.7,  reach: 0.7,  lodBias: 0.5, hTile: 128, hMax: 256 },
    },
  };
  const BOUNDS = { desktop: { maxN: 24, shN: 6, rel: 2 }, mobile: { maxN: 16, shN: 3, rel: 1 } };   // compile-time loop bounds
  const TIER_ORDER = ['low', 'medium', 'high', 'ultra'];
  // Rough per-pixel cost model (texture fetches of the march itself, ground adds ~4 for the atlas / region lookups): worst = grazing view, every layer scanned, relief + shadow on;
  // typical = looking ~45 deg down, the ray hits half way.  ALU is ~1.5 x fetches for the TSL graph; the numbers are for ordering tiers, not for predicting ms.
  function cost(klass, tier, q) {
    const c = TIERS[klass][tier], b = BOUNDS[klass]; q = q == null ? 1 : q;
    const steps = Math.min(b.maxN, Math.max(c.minSteps, Math.round(c.steps * q))), rel = (q >= 0.5 ? c.relief : 0) * b.rel, sh = (q >= 0.85 ? c.shadow : 0) * b.shN;
    const nTyp = steps * (0.35 + 0.65 * 0.5);
    return { steps, worst: 2 + steps + rel + sh + 3, typical: +(2 + nTyp * 0.5 + rel * 0.6 + sh * 0.6 + 3).toFixed(2) };
  }
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* ─────────────────── 2. pure-JS reference of the stepping math ─────────────────── */
  // hf(u, v) -> h in 0..1.  V = unit view vector (surface -> eye) in tangent space (z = along the normal).
  // opts: depth (uv units), bias, n (layers), fade (0..1 multiplies depth), refine (binary steps), maxTan (grazing clamp)
  function march(hf, u0, v0, V, o) {
    o = o || {};
    const depth = (o.depth == null ? 0.05 : o.depth) * (o.fade == null ? 1 : o.fade), bias = o.bias == null ? 0 : o.bias;
    const n = Math.max(1, Math.round(o.n == null ? 16 : o.n)), refine = o.refine | 0, maxTan = o.maxTan || 6;
    const vz = Math.max(V[2], 0.1);
    let px = V[0] / vz * depth, py = V[1] / vz * depth;
    const pl = Math.hypot(px, py), lim = maxTan * depth;
    if (pl > lim) { px *= lim / pl; py *= lim / pl; }
    const at = (l) => [u0 + px * (1 - bias - l), v0 + py * (1 - bias - l)];
    const f = (l) => { const p = at(l); return hf(p[0], p[1]) + l - 1; };
    let pl_ = 0, pf = f(0), cl = 0, cf = pf, iters = 1;
    if (pf >= 0) { cl = 0; } else {
      for (let i = 1; i <= n; i++) {
        const l = i / n, fl = f(l); iters++;
        if (fl >= 0) { cl = l; cf = fl; break; }
        pl_ = l; pf = fl; cl = l; cf = fl;
      }
    }
    // linear root between the last two samples
    const d = cf - pf; let s = Math.abs(d) > 1e-6 ? -pf / d : 0; s = clamp(s, 0, 1);
    let lo = 0, hi = 1, flo = pf, fhi = cf;
    for (let j = 0; j < refine; j++) {   // relief refine: regula falsi on the bracket (same sequence as the shader)
      const l = pl_ + (cl - pl_) * s, fv = f(l); iters++;
      if (fv >= 0) { hi = s; fhi = fv; } else { lo = s; flo = fv; }
      const dd = fhi - flo; s = Math.abs(dd) > 1e-6 ? clamp(lo + (hi - lo) * (-flo) / dd, lo, hi) : (lo + hi) * 0.5;
    }
    const lh = pl_ + (cl - pl_) * s, p = at(lh);
    return { u: p[0], v: p[1], l: lh, h: hf(p[0], p[1]), iters, err: f(lh) };
  }
  // soft self-shadow of the height field toward the light L (tangent space, unit, L[2] > 0). 1 = lit, 0 = fully shadowed.
  function shadow(hf, u, v, h, L, o) {
    o = o || {};
    const depth = o.depth == null ? 0.05 : o.depth, taps = o.taps == null ? 6 : o.taps, k = o.k == null ? 4 : o.k;
    const lz = Math.max(L[2], 0.1), rx = L[0] / lz * depth * (1 - h), ry = L[1] / lz * depth * (1 - h);
    let occ = 0;
    for (let j = 1; j <= taps; j++) {
      const s = j / taps, hs = hf(u + rx * s, v + ry * s), ray = h + (1 - h) * s;
      occ = Math.max(occ, (hs - ray) * (1 - 0.5 * s));
    }
    return 1 - clamp(occ * k, 0, 1);
  }
  // distance fade 1 (near) -> 0 (far), and the view-adaptive layer count
  const distFade = (d, near, far) => 1 - sstep(near, far, d);
  const layersFor = (vz, nMax) => Math.round(nMax * (0.35 + 0.65 * (1 - clamp(vz, 0, 1))));

  /* ─────────────────── 3. height maps: derived once, cached ─────────────────── */
  // Colour texels (RGBA8) -> height (0..1): luminance, high-pass (removes the large-scale shading so only the relief stays), percentile stretch.
  // The derivations are generators that yield every few rows (the sliced runner below spends ~2-3 ms per slice between frames); the plain functions run them to the end.
  const runGen = (g) => { let r; do { r = g.next(); } while (!r.done); return r.value; };
  function* boxBlurWrapG(src, w, h, r, out) {
    const tmp = new Float32Array(w * h), inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {   // horizontal, wrapping (tiles / sphere seam)
      let a = 0; for (let k = -r; k <= r; k++) a += src[y * w + ((k + w * 4) % w)];
      for (let x = 0; x < w; x++) { tmp[y * w + x] = a * inv; a += src[y * w + ((x + r + 1) % w)] - src[y * w + ((x - r + w * 4) % w)]; }
      if ((y & 15) === 15) yield;
    }
    for (let x = 0; x < w; x++) {   // vertical, clamped (poles), running sum
      let a = 0; for (let k = -r; k <= r; k++) a += tmp[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = a * inv; a += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]; }
      if ((x & 15) === 15) yield;
    }
    return out;
  }
  const boxBlurWrap = (src, w, h, r, out) => runGen(boxBlurWrapG(src, w, h, r, out));
  function stretch8(f, n, lo, hi) {
    const bins = new Uint32Array(256); let mn = 1e30, mx = -1e30;
    for (let i = 0; i < n; i++) { if (f[i] < mn) mn = f[i]; if (f[i] > mx) mx = f[i]; }
    const sp = mx - mn || 1; for (let i = 0; i < n; i++) bins[Math.min(255, ((f[i] - mn) / sp * 255) | 0)]++;
    let acc = 0, a = 0, b = 255; for (let i = 0; i < 256; i++) { acc += bins[i]; if (acc >= n * lo) { a = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += bins[i]; if (acc >= n * (1 - hi)) { b = i; break; } }
    const o = new Uint8Array(n), A = mn + sp * a / 255, B = mn + sp * (b + 1) / 255, ds = (B - A) || 1;
    for (let i = 0; i < n; i++) o[i] = clamp(Math.round((f[i] - A) / ds * 255), 0, 255);
    return o;
  }
  function* heightFromRGBAG(data, w, h, opt) {
    opt = opt || {};
    const n = w * h, lum = new Float32Array(n), blur = new Float32Array(n), r = opt.radius || Math.max(2, Math.round(Math.min(w, h) / 48)), hp = opt.highpass == null ? 0.85 : opt.highpass;
    for (let i = 0; i < n; i++) { lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255; if ((i & 0xffff) === 0xffff) yield; }
    yield* boxBlurWrapG(lum, w, h, r, blur);
    for (let i = 0; i < n; i++) lum[i] = lum[i] - blur[i] * hp;
    yield;
    return stretch8(lum, n, 0.02, 0.98);
  }
  const heightFromRGBA = (data, w, h, opt) => runGen(heightFromRGBAG(data, w, h, opt));
  // Tangent-space normal map (RGBA8, x/y/z encoded 0..255 -> -1..1) -> height by path integration of the slopes, both orders averaged, drift removed.
  function* heightFromNormalsG(data, w, h, opt) {
    opt = opt || {};
    const n = w * h, gx = new Float32Array(n), gy = new Float32Array(n), flipY = opt.flipY ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const nx = data[i * 4] / 127.5 - 1, ny = (data[i * 4 + 1] / 127.5 - 1) * flipY, nz = Math.max(0.05, data[i * 4 + 2] / 127.5 - 1);
      gx[i] = -nx / nz; gy[i] = -ny / nz; if ((i & 0xffff) === 0xffff) yield;
    }
    const A = new Float32Array(n), B = new Float32Array(n);
    for (let y = 0; y < h; y++) { let a = 0; for (let x = 0; x < w; x++) { a += gx[y * w + x]; A[y * w + x] = a; } if ((y & 15) === 15) yield; }
    for (let x = 0; x < w; x++) { let a = 0; for (let y = 0; y < h; y++) { a += gy[y * w + x]; A[y * w + x] += a; } if ((x & 15) === 15) yield; }
    for (let x = 0; x < w; x++) { let a = 0; for (let y = 0; y < h; y++) { a += gy[y * w + x]; B[y * w + x] = a; } if ((x & 15) === 15) yield; }
    for (let y = 0; y < h; y++) { let a = 0; for (let x = 0; x < w; x++) { a += gx[y * w + x]; B[y * w + x] += a; } if ((y & 15) === 15) yield; }
    const f = new Float32Array(n), bl = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = (A[i] + B[i]) * 0.5;
    yield* boxBlurWrapG(f, w, h, opt.radius || Math.max(2, Math.round(Math.min(w, h) / 6)), bl);
    for (let i = 0; i < n; i++) f[i] -= bl[i];
    yield;
    return stretch8(f, n, 0.01, 0.99);
  }
  const heightFromNormals = (data, w, h, opt) => runGen(heightFromNormalsG(data, w, h, opt));
  // Procedural tileable height tiles (R8): cobble = rounded stones with deep joints, plates = flat plates with hairline cracks, pebble = small domes.
  function makeTile(kind, size, seed) {
    size = size || 128; let s = (seed | 0 || 1) >>> 0;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const cells = kind === 'pebble' ? 11 : kind === 'plates' ? 5 : 7, jx = new Float32Array(cells * cells), jy = new Float32Array(cells * cells), hh = new Float32Array(cells * cells);
    for (let i = 0; i < cells * cells; i++) { jx[i] = 0.18 + rnd() * 0.64; jy[i] = 0.18 + rnd() * 0.64; hh[i] = 0.78 + rnd() * 0.22; }
    const out = new Uint8Array(size * size), joint = kind === 'plates' ? 0.05 : kind === 'pebble' ? 0.16 : 0.2, round = kind === 'plates' ? 0.18 : 0.6;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const px = x / size * cells, py = y / size * cells, cx = Math.floor(px), cy = Math.floor(py);
      let d1 = 9, d2 = 9, id = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox, gy = cy + oy, k = ((gy % cells + cells) % cells) * cells + ((gx % cells + cells) % cells);
        const dx = gx + jx[k] - px, dy = gy + jy[k] - py, d = Math.hypot(dx, dy);
        if (d < d1) { d2 = d1; d1 = d; id = k; } else if (d < d2) d2 = d;
      }
      const edge = d2 - d1, t = sstep(0, joint, edge), dome = 1 - round * clamp(d1 * 1.1, 0, 1) * 0.55;   // joint depth * stone dome
      out[y * size + x] = clamp(Math.round(255 * (0.04 + 0.96 * t * dome * hh[id])), 0, 255);
    }
    return out;
  }

  /* ─────────────────── 4. runtime: tiers, uniforms, cache, TSL ─────────────────── */
  const govOff = /[?&]pxgov=0\b/.test((G.location && G.location.search) || '');
  const pxqForced = (() => { const m = ((G.location && G.location.search) || '').match(/[?&]pxq=([0-9.]+)/); const v = m ? parseFloat(m[1]) : NaN; return v >= 0 && v <= 1 ? v : null; })();
  const S = { gov: { q: 1, ema: 0, n: 0, over: 0, calm: 0, hold: 8000, since: 0, lastUp: -1e9, changes: 0, fails: 0, holdStart: 0, saveT: 0 }, ready: false, tier: 'medium', klass: 'desktop', cfg: TIERS.desktop.medium, scale: 1, U: null, THREE: null, T: null, fn: null, tex: new Map(), tiles: new Map(), mats: 0, builds: 0, q: [], qt: 0, sun: null, last: '', jobs: [], jobT: 0, pend: new Map() };
  function klass() { try { return (G.GFX && G.GFX.isMobile) ? 'mobile' : 'desktop'; } catch (e) { return 'desktop'; } }
  function curTier() {
    if (forced) return forced;
    try { return (typeof G.resolvePreset === 'function') ? G.resolvePreset() : 'medium'; } catch (e) { return 'medium'; }
  }
  function tierRow(t) { const k = klass(); return TIERS[k][t] || TIERS[k].medium; }
  function governorScale() {   // render scale from ui/dm-governor.js: when it has already cut the resolution the march gets cheaper too (never switched off)
    try { const r = (typeof flightRenderer !== 'undefined') ? flightRenderer : null, k = r && r._dr && r._dr.k; if (!(k > 0)) return 1; return k >= 0.9 ? 1 : k >= 0.75 ? 0.7 : k >= 0.62 ? 0.4 : 0.15; } catch (e) { return 1; }
  }
  // The live parameters for tier row c at quality q (0..1), render-scale factor sc: pure, shared with the node harness.
  function cfgAt(c, b, q, sc) {
    q = clamp(Math.min(q, sc == null ? 1 : sc), 0, 1);
    const steps = Math.min(b.maxN, Math.max(c.minSteps, Math.round(c.steps * q)));
    return { steps, shadow: q >= 0.85 ? c.shadow : 0, relief: q >= 0.5 ? c.relief : 0, depthK: c.depth * (0.55 + 0.45 * q), reachK: c.reach * (0.5 + 0.5 * q), lodBias: c.lodBias + (q < 0.35 ? 0.5 : 0), q };
  }
  function refreshCfg() {
    const t = curTier(), c = tierRow(t), sc = governorScale(), b = BOUNDS[S.klass];
    // (v256) ui/dm-budget.js owns the ladder when it runs: its parallax multipliers (steps / reach / depth, self-shadow, relief) are applied ON TOP of the tier's own numbers.
    // Its last rung used to switch the march off; here that rung lands on the tier's floor (minSteps, depth / reach as shrunk) - parallax is never off on any tier.
    const Bd = (G.DMBudget && G.DMBudget.on && G.DMBudget.parallax) ? G.DMBudget.parallax() : null;
    const q = pxqForced != null ? pxqForced : (Bd ? 1 : S.gov.q), cf = cfgAt(c, b, q, sc);
    if (Bd) {
      cf.reachK *= Bd.reach; cf.depthK *= Bd.depth; if (!Bd.shadow) cf.shadow = 0; if (Bd.lvl >= 1) cf.relief = 0;
      cf.steps = Bd.off ? c.minSteps : Math.max(c.minSteps, Math.min(Bd.stepsMax >= 99 ? b.maxN : Math.max(c.minSteps, Bd.stepsMax), Math.round(cf.steps * Bd.steps)));
    }
    S.tier = t; S.scale = sc; S.cfg = cf; S.last = t + '|' + cf.steps + '|' + cf.shadow + '|' + cf.relief;
    const U = S.U; if (U) { U.steps.value = cf.steps; U.shadow.value = cf.shadow; U.relief.value = cf.relief; U.depthK.value = cf.depthK; U.reachK.value = cf.reachK; U.lodBias.value = cf.lodBias; }
  }
  // ── quality governor: a tiny rAF probe (one subtraction per frame) + a decision every 500 ms ──
  // budget = the slowest frame we accept before the march is made cheaper; promote = how fast frames must be, for `hold` ms, before it is given back.
  const GOV_KEY = 'dm_px_q1';
  function govDevKey() { return S.klass + '|' + S.tier + '|' + Math.round(((G.devicePixelRatio) || 1) * 10) + '|' + Math.round(((G.innerWidth) || 0) / 100); }
  function govLoad() {
    try { const j = JSON.parse(G.localStorage.getItem(GOV_KEY) || 'null'); if (j && j.key === govDevKey() && Date.now() - j.t < 14 * 864e5 && j.q >= 0.05 && j.q <= 1) return j.q; } catch (e) { }
    return S.klass === 'mobile' ? 0.6 : 1;
  }
  function govSave(now) { const g = S.gov; if (now - g.saveT < 20000) return; g.saveT = now; try { G.localStorage.setItem(GOV_KEY, JSON.stringify({ key: govDevKey(), q: +g.q.toFixed(2), t: Date.now() })); } catch (e) { } }
  function govBudget() { const mobile = S.klass === 'mobile'; return { budget: mobile ? 22 : 18, promote: mobile ? 19 : 14.5 }; }
  function govTick() {
    const g = S.gov;
    if (govOff || forced || pxqForced != null) return;
    if (G.DMBudget && G.DMBudget.on && G.DMBudget.parallax) return;   // (v256) the global budget ladder drives this dial
    const now = (G.performance && G.performance.now) ? G.performance.now() : Date.now();
    if (G.document && G.document.hidden) { g.n = 0; return; }
    if (G._dmWarming || G.__JOTS_INTRO || g.n < 12) return;        // warm-up / launch intro / not enough frames yet
    const B = govBudget(), e = g.ema, ratio = e / B.budget;
    if (e > B.budget) { g.over += 500; g.calm = 0; } else if (e < B.promote) { g.calm += 500; g.over = Math.max(0, g.over - 250); } else { g.over = Math.max(0, g.over - 250); g.calm = Math.max(0, g.calm - 250); }
    const floorQ = 0.0;
    if (g.over >= 1000 && g.q > floorQ + 0.001) {                 // 1 s over budget: trim (bigger when far over); a trim soon after a promotion doubles the wait before the next try
      if (now - g.lastUp < 20000) { g.fails++; g.hold = Math.min(240000, g.hold * 2); }
      const step = clamp(0.06 + 0.3 * (ratio - 1), 0.06, 0.3);
      g.q = Math.max(floorQ, g.q - step); g.over = 0; g.calm = 0; g.since = now; g.changes++; if (!g.holdStart) g.holdStart = now; refreshCfg(); govSave(now);
    } else if (g.calm >= g.hold && g.q < 1 && now - g.since > g.hold) {   // inside budget for `hold`: one small step up
      g.q = Math.min(1, g.q + 0.08); g.calm = 0; g.over = 0; g.since = now; g.lastUp = now; g.changes++; refreshCfg(); govSave(now);
    }
    if (e <= B.budget) g.holdStart = 0;
  }
  // ui/dm-governor.js asks this before it lowers the render scale: while the march still has quality to give, trade THAT first (bounded to 6 s per episode, and never when the
  // frame is several times over budget: a 15 fps floor is not the place to wait).
  function trimFirst(frameMs) {
    const g = S.gov; if (!S.ready || govOff || forced || pxqForced != null || (G.DMBudget && G.DMBudget.on && G.DMBudget.parallax)) return false;
    const B = govBudget(); if (frameMs > B.budget * 2.5) return false;
    const now = (G.performance && G.performance.now) ? G.performance.now() : Date.now();
    if (g.q <= 0.02) return false;
    if (!g.holdStart) g.holdStart = now;
    return now - g.holdStart < 6000;
  }
  let probeOn = false;
  function startProbe() {
    if (probeOn || !G.requestAnimationFrame) return; probeOn = true;
    let last = 0;
    const fr = (t) => { if (last) { const d = t - last; if (d > 0 && d < 1000) { const g = S.gov, c = d > 250 ? 250 : d; g.ema = g.n ? g.ema + (c - g.ema) * 0.08 : c; g.n++; } else S.gov.n = 0; } last = t; G.requestAnimationFrame(fr); };
    G.requestAnimationFrame(fr);
  }
  function sunTick() {
    if (!S.U) return;
    try {
      const sun = (typeof TERRAIN !== 'undefined' && TERRAIN && TERRAIN.sun) || null;   // the surface sun (DirectionalLight)
      if (sun && sun.target) { const d = S.U.light.value; d.copy(sun.position).sub(sun.target.position); if (d.lengthSq() > 1e-9) d.normalize(); else d.set(0.3, 0.8, 0.2).normalize(); S.U.lit.value = 1; }
      else S.U.lit.value = 0;
    } catch (e) { S.U.lit.value = 0; }
  }

  function heightTexture(key, bytes, w, h, THREE) {   // cached R8 height texture
    THREE = THREE || G.THREE; let t = S.tex.get(key);
    if (t) return t;
    t = new THREE.DataTexture(bytes, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; t.userData = { px: true, key }; S.tex.set(key, t); return t;
  }
  function drain() { S.qt = 0; const j = S.q.shift(); if (j) { try { refresh(j[0], j[1]); } catch (e) { } } if (S.q.length) S.qt = setTimeout(drain, 120); }
  function tileTexture(kind, size, seed) {
    const key = 'tile|' + kind + '|' + size + '|' + seed;
    let t = S.tex.get(key); if (t) return t;
    return heightTexture(key, makeTile(kind, size, seed), size, size);
  }
  // planet crust: the colour DataTexture is filled asynchronously by a worker; derive its height when the texels land (call again, it overwrites in place).
  function refresh(colorTex, key) {
    const im = colorTex && colorTex.image; if (!im || !im.data) return null;
    const bytes = heightFromRGBA(im.data, im.width, im.height);
    let t = S.tex.get(key);
    if (!t) return heightTexture(key, bytes, im.width, im.height);
    t.image.data.set(bytes); t.needsUpdate = true; return t;
  }

  // ── the shared TSL graph ──
  function init() {
    if (S.ready) return true;
    const THREE = G.THREE, T = THREE && THREE.TSL;
    if (off || !T || !T.Fn || !T.Loop || !T.If || !T.Break || !T.materialReference || !T.dFdx || !THREE.DataTexture) return false;
    S.THREE = THREE; S.T = T; S.klass = klass();
    const { uniform, float, vec3 } = T;
    S.U = { steps: uniform(0), shadow: uniform(0), relief: uniform(0), depthK: uniform(1), reachK: uniform(1), lodBias: uniform(0), lit: uniform(0), light: uniform(new THREE.Vector3(0.3, 0.8, 0.2).normalize()) };
    S.tier = curTier(); S.gov.q = (govOff || forced || pxqForced != null) ? 1 : govLoad();   // phones/tablets start from the last settled quality (or 0.6) and earn the rest (see the header)
    refreshCfg(); sunTick(); startProbe();
    setInterval(() => { try { govTick(); refreshCfg(); sunTick(); } catch (e) { } }, 500);   // uniform writes only
    S.ready = true; return true;
  }

  // The shared march: tangent frame from derivatives, view vector in tangent space, the layered search + relief refine (+ soft shadow on desktop).
  // o: { uv, H(uvNode, lodNode) -> float node (optional; default = o.tex .r), size (texels of the height map), N (view normal node), mask, aspect,
  //      depth, bias, near, far (nodes) }.  Returns { uv (hit), h, shade (soft shadow), Tt, Bt, N0, V, fade, dEff, lod }.
  // Everything past the fade distance is behind a real branch: nothing is fetched there.
  function marchNodes(o) {
    const T = S.T, B = BOUNDS[S.klass];
    const { Fn, Loop, If, Break, float, vec2, vec3, vec4, smoothstep, max, min, clamp: tclamp, dot, cross, normalize, length, texture, dFdx, dFdy, positionView, normalView, cameraViewMatrix, log2 } = T;
    const U = S.U, depth = o.depth.mul(U.depthK).mul(o.depthMul || 1), bias = o.bias, near = o.near.mul(U.reachK), far = o.far.mul(U.reachK);   // (v256) tier / governor: relief depth and every fade distance are shared uniforms
    const asp = vec2(o.aspect ? o.aspect[0] : 1, o.aspect ? o.aspect[1] : 1), size = o.size && o.size.isNode ? o.size : float(o.size);
    const N0 = o.N || normalView, uv0 = o.uv;
    // tangent frame from screen-space derivatives (no tangents needed)
    const dp1 = dFdx(positionView), dp2 = dFdy(positionView), du1 = dFdx(uv0), du2 = dFdy(uv0);
    const p2 = cross(dp2, N0), p1 = cross(N0, dp1);
    const Tt = normalize(p2.mul(du1.x).add(p1.mul(du2.x))), Bt = normalize(p2.mul(du1.y).add(p1.mul(du2.y)));
    const V = normalize(positionView.negate());
    const Vt = vec3(dot(V, Tt), dot(V, Bt), dot(V, N0));
    const dist = length(positionView), fade = float(1).sub(smoothstep(near, far, dist)).mul(o.mask || float(1));
    const mipB = float(root.DMLod && root.DMLod.on ? root.DMLod.get('mip.bias') : 0.6);   // (far-range) the relief / height taps go up to mipB mips softer as the march fades out: no shimmer at the edge of the band
    const lod = tclamp(log2(max(length(du1.mul(size)), length(du2.mul(size))).max(1.0)).add(U.lodBias).add(smoothstep(near, far, dist).mul(mipB)), 0.0, o.lodMax == null ? 5.0 : o.lodMax);
    const H = o.H ? ((u) => o.H(u, lod)) : ((u) => texture(o.tex, u).level(lod).r);
    const res = Fn(() => {
    const res = vec4(uv0.x, uv0.y, 0.5, 1.0).toVar();
    const MAXI = B.maxN + 1;
    If(fade.greaterThan(0.002), () => {
      res.assign(vec4(uv0.x, uv0.y, H(uv0), 1.0));    // (the height at the unshifted point: also the answer when the march is off)
    If(U.steps.greaterThan(0.5), () => {
      const vz = max(Vt.z, 0.1), dEff = depth.mul(U.depthK).mul(fade);
      let P = vec2(Vt.x, Vt.y).div(vz).mul(dEff).mul(asp);
      const pl = length(P), lim = dEff.mul(6.0);
      P = P.mul(min(float(1), lim.div(max(pl, 1e-5))));
      const n = max(float(2), U.steps.mul(float(0.35).add(float(0.65).mul(float(1).sub(tclamp(Vt.z, 0.0, 1.0)))))).toVar();
      const at = (l) => uv0.add(P.mul(float(1).sub(bias).sub(l)));
      const prevL = float(0).toVar(), prevF = H(at(float(0))).sub(1.0).toVar(), curL = float(0).toVar(), curF = prevF.toVar();
      If(prevF.lessThan(0.0), () => {
        Loop(MAXI, ({ i }) => {
          const fi = float(i);
          If(fi.greaterThan(n), () => { Break(); });
          const l = fi.div(n), f = H(at(l)).add(l).sub(1.0);
          If(f.greaterThanEqual(0.0), () => { curL.assign(l); curF.assign(f); Break(); });
          prevL.assign(l); prevF.assign(f); curL.assign(l); curF.assign(f);
        });
      });
      const d = curF.sub(prevF), s = tclamp(prevF.negate().div(d.abs().max(1e-6)), 0.0, 1.0).toVar();
      if (B.rel > 0) {
        If(U.relief.greaterThan(0.5), () => {
          const lo = float(0).toVar(), hi = float(1).toVar(), flo = prevF.toVar(), fhi = curF.toVar();
          for (let j = 0; j < B.rel; j++) {
            const l = prevL.add(curL.sub(prevL).mul(s)), fv = H(at(l)).add(l).sub(1.0);
            If(fv.greaterThanEqual(0.0), () => { hi.assign(s); fhi.assign(fv); }).Else(() => { lo.assign(s); flo.assign(fv); });
            const dd = fhi.sub(flo);
            s.assign(tclamp(lo.add(hi.sub(lo).mul(flo.negate().div(dd.abs().max(1e-6)))), lo, hi));
          }
        });
      }
      const lh = prevL.add(curL.sub(prevL).mul(s)), uvH = at(lh), h = H(uvH);
      res.assign(vec4(uvH.x, uvH.y, h, 1.0));
      if (B.shN > 0) {
        If(U.shadow.greaterThan(0.5).and(U.lit.greaterThan(0.5)), () => {
          const Lv = normalize(cameraViewMatrix.mul(vec4(U.light, 0.0)).xyz), Lt = vec3(dot(Lv, Tt), dot(Lv, Bt), dot(Lv, N0));
          const lz = max(Lt.z, 0.1), step = vec2(Lt.x, Lt.y).div(lz).mul(dEff).mul(asp).mul(float(1).sub(h)), occ = float(0).toVar();
          for (let j = 1; j <= B.shN; j++) {
            const sj = j / B.shN, hs = H(uvH.add(step.mul(sj))), ray = h.add(float(1).sub(h).mul(sj));
            occ.assign(max(occ, hs.sub(ray).mul(1.0 - 0.5 * sj)));
          }
          res.assign(vec4(uvH.x, uvH.y, h, float(1).sub(tclamp(occ.mul(4.0), 0.0, 1.0))));
        });
      }
    });
    });
    return res;
    })().toVar();
    return { uv: vec2(res.x, res.y), h: res.z, shade: res.w, Tt, Bt, N0, V, fade, lod, size };
  }

  // Build the POM node for one material.  o: {uv (vec2 node), tex (height THREE.Texture), size (texels), mat props via materialReference: pxDepth, pxBias, pxNear, pxFar,
  //   aspect (uv->world ratio vec2 JS), N (view normal node), strength}.  Returns {uv, h, shade, N, T, B, fade} nodes.
  function build(o) {
    const T = S.T;
    const { float, vec2, vec3, mix, normalize, texture, materialReference } = T;
    const depth = materialReference('pxDepth', 'float'), bias = materialReference('pxBias', 'float'), near = materialReference('pxNear', 'float'), far = materialReference('pxFar', 'float'), strength = materialReference('pxStrength', 'float');
    const asp = vec2(o.aspect ? o.aspect[0] : 1, o.aspect ? o.aspect[1] : 1), size = float(o.size);
    const c = marchNodes(Object.assign({}, o, { depth, bias, near, far }));
    const { Tt, Bt, N0, fade } = c, uvOut = c.uv, hOut = c.h, shade = c.shade, lod = c.lod;
    const H = (u) => texture(o.tex, u).level(lod).r;
    // normal from the height gradient at the hit, in the tangent frame
    const e = float(1).div(size), hx = H(uvOut.add(vec2(e, 0.0))).sub(hOut), hy = H(uvOut.add(vec2(0.0, e))).sub(hOut);
    const k = depth.mul(S.U.depthK).mul(size).mul(float(o.nScale || 1)), nt = normalize(vec3(hx.negate().mul(k).div(asp.x), hy.negate().mul(k).div(asp.y), 1.0));
    const Nn = normalize(Tt.mul(nt.x).add(Bt.mul(nt.y)).add(N0.mul(nt.z)));
    const Nout = normalize(mix(N0, Nn, fade.mul(strength).clamp(0.0, 1.0)));
    // cavity: darker in the crevices, falling off with depth; shadow term only where it was computed (desktop)
    const cav = mix(float(1), float(0.35).add(hOut.mul(0.65)), fade.mul(strength).clamp(0.0, 1.0));
    S.builds++;
    return { uv: uvOut, h: hOut, shade: mix(float(1), shade, fade), cavity: cav, N: Nout, fade };
  }
  // Layered/atlas users (ui/dm-groundlib.js, structures): the march with a caller-supplied height function and constant depth/bias/range; the caller shades.
  function buildCore(o) {
    const T = S.T, { float } = T, nd = (x, d) => (x && x.isNode) ? x : float(x == null ? d : x);
    S.builds++;
    return marchNodes(Object.assign({}, o, { depth: nd(o.depthUV), bias: nd(o.bias, 0.55), near: nd(o.near), far: nd(o.far) }));
  }
  // Same march with depth / bias / range / map size / strength read from MATERIAL PROPERTIES (pxDepth, pxBias, pxNear, pxFar, pxSize, pxStrength): every material built this way
  // shares one shader program whatever its numbers (4 cliff sets, 4 mansion materials, 4 Bird Temple sections ...).  o: { uv, H(uv, lod) -> height node, N }.
  function marchRef(o) {
    const T = S.T, { materialReference, float } = T; S.builds++;
    return marchNodes(Object.assign({}, o, { depth: materialReference('pxDepth', 'float'), bias: materialReference('pxBias', 'float'), near: materialReference('pxNear', 'float'), far: materialReference('pxFar', 'float'), size: materialReference('pxSize', 'float'), mask: o.mask || materialReference('pxStrength', 'float') }));
  }

  function setProps(mat, p) {
    mat.pxDepth = p.depth; mat.pxBias = p.bias; mat.pxNear = p.near; mat.pxFar = p.far; mat.pxStrength = p.strength == null ? 1 : p.strength; if (p.size) mat.pxSize = p.size;
  }

  // Planet / moon crust: the material wears a generated colour DataTexture (`map`). Opt-in per material (mat.userData.noParallax = true opts out).
  // `radius` = body radius in world units (reach scales with it); the height map is derived from the colour texels and refreshed when the worker's texels land.
  function applyToMaterial(mat, colorTex, radius, key) {
    try {
      if (off || !mat || !colorTex || (mat.userData && (mat.userData.noParallax || mat.userData.dmPx))) return false;
      if (!init()) return false;
      if (!mat.isNodeMaterial) {   // the planets wear classic MeshStandardMaterials: carry the look over to a node twin (the renderer builds the same node program for them anyway)
        const THREE = S.THREE; if (!THREE.MeshStandardNodeMaterial || !mat.isMeshStandardMaterial) return false;
        const n = new THREE.MeshStandardNodeMaterial({ roughness: mat.roughness, metalness: mat.metalness, side: mat.side });
        n.color.copy(mat.color); n.emissive.copy(mat.emissive); n.emissiveIntensity = mat.emissiveIntensity; n.name = mat.name; n.userData = Object.assign({}, mat.userData);
        n.__pxFrom = mat; mat = n;
      }
      const im = colorTex.image; if (!im || !im.width) return false;
      key = key || ('crust|' + colorTex.uuid);
      const ht = heightTexture(key, new Uint8Array(im.width * im.height).fill(128), im.width, im.height);
      const T = S.T;
      const R = Math.max(1e-6, radius || 1);
      setProps(mat, { depth: 0.0014, bias: 0.5, near: R * 0.03, far: R * 0.35, strength: 0.9 });
      const b = build({ uv: T.uv(), tex: ht, size: im.height, aspect: [0.5, 1], N: T.normalView, nScale: 1 });
      mat.map = null;
      mat.colorNode = T.texture(colorTex, b.uv).rgb.mul(T.materialColor).mul(b.cavity).mul(T.mix(T.float(1), b.shade, 0.85));
      mat.normalNode = b.N;
      mat.userData.dmPx = { key, tex: colorTex };
      mat.needsUpdate = true; S.mats++;
      if (colorTex.userData && colorTex.userData.pxReady) texelsLanded(colorTex);
      return mat;   // the material to use (a node twin when a classic one came in)
    } catch (e) { try { console.warn('[parallax] planet', e); } catch (_) { } return false; }
  }
  // call when the worker's texels have landed (derives the height map once, in place)
  function texelsLanded(colorTex) {
    try {
      if (!colorTex) return; colorTex.userData = colorTex.userData || {}; colorTex.userData.pxReady = true; const k = 'crust|' + colorTex.uuid;
      if (S.tex.has(k)) { S.q.push([colorTex, k]); if (!S.qt) S.qt = setTimeout(drain, 250); }   // one map per task, off the frame path
    } catch (e) { }
  }

  // Walkable ground fallback (ui/index.html _terrainDetailMat, when the ground library is off): a cached cobble/plate height tile over the world-flat point, marched only close to her.
  // ctx: { p: world-flat point (vec3 node), flat: 0..1 walkable mask node, lvl: 1..3, N: current view-space normal node (optional) }
  function applyGround(m, ctx) {
    try {
      if (off || !m || !ctx || (m.userData && m.userData.noParallax)) return false;
      if (!init() || !m.isNodeMaterial) return false;
      const T = S.T, tileW = 2.4;                                  // one tile = 2.4 m, stones ~35 cm
      const ht = tileTexture(ctx.kind || 'cobble', tierRow(curTier()).hTile >= 128 ? 128 : 96, ctx.seed || 7);
      setProps(m, { depth: 0.07 / tileW, bias: 0.55, near: ctx.near || 4.5, far: ctx.far || 11, strength: ctx.strength == null ? 1 : ctx.strength });
      const uv = T.vec2(ctx.p.x, ctx.p.z).div(tileW);
      const b = build({ uv, tex: ht, size: ht.image.width, N: m.normalNode || T.normalView, mask: ctx.flat, nScale: 1 });
      m.normalNode = b.N;
      m.colorNode = m.colorNode.mul(b.cavity).mul(b.shade);
      m.userData.dmPx = { ground: true }; S.mats++;
      return true;
    } catch (e) { try { console.warn('[parallax] ground', e); } catch (_) { } return false; }
  }

  /* ─────────────────── 5. structures: cliffs, mansion, Bird Temple (GLB materials with maps + a height map) ─────────────────── */
  // GLB materials are classic MeshStandardMaterials; the march needs a node material, so each one is adopted ONCE into a node twin that replaces it on its meshes.
  // The twin samples its colour / normal / ORM through the parallax-displaced uv (explicit TextureNodes, swapped with structureMaps() when the streaming code
  // upgrades the maps), so everything the original had (vertex colour = macro tint, aoMap on uv1 = baked GI, positionNode = planet bend) carries over.
  // Cost: the SAME shared uniforms as the ground (preset steps, governor level, shadow/relief) — nothing extra to tune; distance-faded (near..far in scene units).
  function adopt(root, mat) {
    try {
      if (off || !mat || !root) return mat;
      if (mat.isNodeMaterial) return mat;
      if (mat.userData && mat.userData.dmPxTwin) {   // (v256) already adopted: still swap it onto the meshes of THIS root (an instance cloned before the adoption shares the old material)
        const tw0 = mat.userData.dmPxTwin;
        root.traverse((o) => { if (o.isMesh) { if (o.material === mat) o.material = tw0; else if (Array.isArray(o.material)) o.material = o.material.map((x) => (x === mat ? tw0 : x)); } });
        return tw0;
      }
      const THREE = G.THREE; if (!THREE || !THREE.MeshStandardNodeMaterial || !mat.isMeshStandardMaterial) return mat;
      const n = new THREE.MeshStandardNodeMaterial();
      const keep = ['name', 'color', 'roughness', 'metalness', 'map', 'normalMap', 'normalScale', 'roughnessMap', 'metalnessMap', 'aoMap', 'aoMapIntensity', 'lightMap', 'lightMapIntensity', 'envMap', 'envMapIntensity',
        'emissive', 'emissiveIntensity', 'emissiveMap', 'vertexColors', 'side', 'transparent', 'opacity', 'alphaTest', 'depthWrite', 'depthTest', 'flatShading', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'shadowSide', 'toneMapped', 'fog'];
      for (const k of keep) { if (mat[k] === undefined) continue; const v = mat[k]; n[k] = (v && v.isColor) ? v.clone() : (v && v.isVector2) ? v.clone() : v; }
      for (const k of ['positionNode', 'maskNode', 'colorNode', 'opacityNode']) if (mat[k]) n[k] = mat[k];
      n.userData = Object.assign({}, mat.userData); n.userData.dmPxFrom = mat; mat.userData = mat.userData || {}; mat.userData.dmPxTwin = n;
      root.traverse((o) => { if (o.isMesh) { if (o.material === mat) o.material = n; else if (Array.isArray(o.material)) o.material = o.material.map((x) => (x === mat ? n : x)); } });
      n.needsUpdate = true; return n;
    } catch (e) { try { console.warn('[parallax] adopt', e); } catch (_) { } return mat; }
  }
  // ── time-sliced height derivation (v256): a normal / colour map becomes a cached R8 height map, ONCE, ~2-3 ms per slice between frames ──
  // The DataTexture exists at its final size at once (flat 0.5), so a material can be built against it now and the real heights land in place later.
  function jobPump() {
    S.jobT = 0; if (!S.jobs.length) return;
    if (G._dmWarming || G.__JOTS_INTRO || (G.document && G.document.hidden)) { S.jobT = setTimeout(jobPump, 120); return; }
    const mobile = S.klass === 'mobile', t0 = G.performance.now(), budget = mobile ? 2.2 : 3.5, j = S.jobs[0];
    try {
      let r; do { r = j.g.next(); } while (!r.done && G.performance.now() - t0 < budget);
      if (r.done) { S.jobs.shift(); j.done(r.value); }
    } catch (e) { S.jobs.shift(); j.fail(e); }
    if (S.jobs.length) S.jobT = setTimeout(jobPump, mobile ? 30 : 16);
  }
  function sliced(g) { return new Promise((ok, no) => { S.jobs.push({ g, done: ok, fail: no }); if (!S.jobT) S.jobT = setTimeout(jobPump, 0); }); }
  // kind: 'nrm' (tangent normal map -> integrated slopes) | 'rgb' (luminance high-pass).  max: cap in px (tier hMax).  Returns { tex, ready: Promise<tex|null> }; cached by key.
  function deriveHeightInto(key, srcTex, kind, max, opt) {
    try {
      const cached = S.tex.get(key); if (cached) return { tex: cached, ready: cached.userData && cached.userData.pxPromise ? cached.userData.pxPromise : Promise.resolve(cached) };
      const im = srcTex && srcTex.image; if (!im || !im.width || !G.document) return { tex: null, ready: Promise.resolve(null) };
      const sc = Math.min(1, max / Math.max(im.width, im.height)), w = Math.max(16, Math.round(im.width * sc)), h = Math.max(16, Math.round(im.height * sc));
      const tex = heightTexture(key, new Uint8Array(w * h).fill(128), w, h);
      const cv = G.document.createElement('canvas'); cv.width = w; cv.height = h; const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h).data;
      const gen = kind === 'nrm' ? heightFromNormalsG(d, w, h, Object.assign({ flipY: false }, opt || {})) : heightFromRGBAG(d, w, h, opt);
      const p = sliced(gen).then((bytes) => { tex.image.data.set(bytes); tex.needsUpdate = true; tex.userData.pxDone = true; return tex; }).catch(() => null);
      tex.userData.pxPromise = p;
      return { tex, ready: p };
    } catch (e) { return { tex: null, ready: Promise.resolve(null) }; }
  }
  const deriveHeightAsync = (key, srcTex, kind, max, opt) => deriveHeightInto(key, srcTex, kind, max, opt).ready;
  // Synchronous variant (kept for tools / small maps): runs the whole derivation now.
  function deriveHeight(key, srcTex, kind, max) {
    try {
      let t = S.tex.get(key); if (t) return t;
      const im = srcTex && srcTex.image; if (!im || !im.width || !G.document) return null;
      const sc = Math.min(1, max / Math.max(im.width, im.height)), w = Math.max(16, Math.round(im.width * sc)), h = Math.max(16, Math.round(im.height * sc));
      const cv = G.document.createElement('canvas'); cv.width = w; cv.height = h; const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h).data, bytes = kind === 'nrm' ? heightFromNormals(d, w, h, { flipY: false }) : heightFromRGBA(d, w, h);
      return heightTexture(key, bytes, w, h);
    } catch (e) { return null; }
  }
  // Give an adopted twin parallax relief.  o: { tex:{map,nrm,orm} (THREE.Texture), height (THREE.Texture, .r = height 1 proud), hSize, tileM (metres per uv unit), depthM,
  //   near, far (scene units), bias, nrmScale, cavity, rot: 'flip'|'quarter'|'none', macro, stain, lichen, lichenCol:[r,g,b] }.  Returns true when built.
  //   ALL tiers build it (Low is just small numbers in the shared uniforms); only ?px=0 builds nothing.  Material properties (pxDepth, pxBias, pxNear, pxFar, pxSize, pxRot,
  //   pxMacro, pxStain, pxLichen, pxLichenCol) carry every number: all structure materials share ONE shader program.
  // (v260) ANTI-REPETITION. The texture is no longer one repeating lattice: every uv cell (1 tile) gets its own random offset and rotation (flip = 0/180 deg, quarter = 0/90/180/270,
  //   none = offset only), a second layer half a tile away covers the cell borders, the two are blended with the Heitz-Neyret variance-preserving rule (contrast does not wash out
  //   in the blend band; the mean comes from the top mip), the normal is rotated back into the surface frame, and THE HEIGHT MARCH FOLLOWS THE SAME CELL TRANSFORM: each step's
  //   tangent offset is rotated by the cell rotation and read from the same stochastic texel, so the displaced colour / normal / ORM fetches land on the heights that were marched.
  //   Layer B's fetches sit behind a branch on the border weight (inside a cell: one layer, three fetches).  On top: a low-frequency macro albedo / depth modulation, a second larger
  //   colour scale, vertical water stains and lichen in the crevices (ALU only, no extra fetches beyond the one macro colour tap).
  function structure(mat, o) {
    try {
      if (off || !mat || !mat.isNodeMaterial || !o || !o.height || !o.tex || !o.tex.map || (mat.userData && mat.userData.dmPxStruct)) return false;
      if (!init()) return false;
      const T = S.T, { float, vec2, vec3, vec4, texture, normalMap, mix, uv, materialColor, materialRoughness, materialMetalness, materialReference, dFdx, dFdy, floor, fract, sin, cos, dot, min, smoothstep, sqrt, Fn, If } = T;
      const hs = o.hSize || (o.height.image && o.height.image.width) || 512;
      setProps(mat, { depth: (o.depthM || 0.05) / (o.tileM || 1), bias: o.bias == null ? 0.5 : o.bias, near: o.near || 14, far: o.far || 40, strength: 1, size: hs });
      const rotMode = o.rot || 'flip'; mat.pxRot = rotMode === 'quarter' ? Math.PI / 2 : rotMode === 'none' ? 0 : Math.PI;
      mat.pxMacro = o.macro == null ? 0.22 : o.macro; mat.pxStain = o.stain || 0; mat.pxLichen = o.lichen || 0; mat.pxLichenCol = (o.lichenCol && o.lichenCol.length === 3) ? new S.THREE.Vector3(o.lichenCol[0], o.lichenCol[1], o.lichenCol[2]) : new S.THREE.Vector3(0.28, 0.38, 0.14);
      const rStep = materialReference('pxRot', 'float'), kMacro = materialReference('pxMacro', 'float'), kStain = materialReference('pxStain', 'float'), kLichen = materialReference('pxLichen', 'float'), lichCol = materialReference('pxLichenCol', 'vec3');
      const uvn = uv(), dx = dFdx(uvn), dy = dFdy(uvn);
      const h2 = c => fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))).mul(43758.5453));
      const h1 = c => fract(sin(dot(c, vec2(12.9898, 78.233))).mul(43758.5453));
      const vnoise = p2 => { const c = floor(p2), f = fract(p2), u2 = f.mul(f).mul(float(3).sub(f.mul(2)));
        return mix(mix(h1(c), h1(c.add(vec2(1, 0))), u2.x), mix(h1(c.add(vec2(0, 1))), h1(c.add(vec2(1, 1))), u2.x), u2.y); };
      // stage 1: the stochastic cell of this pixel
      const cell = (sh) => {
        const q = uvn.add(sh), c = floor(q), h = h2(c), a = floor(h.x.mul(4)).mul(rStep), cs = cos(a), sn = sin(a);
        const rot = v => vec2(v.x.mul(cs).sub(v.y.mul(sn)), v.x.mul(sn).add(v.y.mul(cs)));
        const f = fract(q), e = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y)));
        return { cs, sn, rot, u0: rot(q).add(h.mul(vec2(5.37, 9.71))), gx: rot(dx), gy: rot(dy), w: smoothstep(0.0, 0.22, e) };
      };
      const cA = cell(vec2(0, 0)), cB = cell(vec2(0.5, 0.5));
      const gateB = cA.w.lessThan(0.995);
      // stage 2 (after the march): the fetches at the displaced point
      const buildMaps = (Ph) => {
        const uOf = (C) => C.u0.add(C.rot(Ph));
        const colF = (C) => texture(o.tex.map, uOf(C)).grad(C.gx, C.gy).rgb;
        const ormF = (C) => (o.tex.orm ? texture(o.tex.orm, uOf(C)).grad(C.gx, C.gy).rgb : vec3(1, 0.8, 0));
        const nrmF = (C) => { if (!o.tex.nrm) return vec2(0, 0); const n0 = texture(o.tex.nrm, uOf(C)).grad(C.gx, C.gy).xy.mul(2).sub(1); return vec2(n0.x.mul(C.cs).add(n0.y.mul(C.sn)), n0.x.mul(C.sn).negate().add(n0.y.mul(C.cs))); };
        const aCol = colF(cA), aOrm = ormF(cA), aN = nrmF(cA);
        // layer B only where its weight is non-zero (the cell borders): each channel group is fetched once, behind the branch
        const colB = Fn(() => { const v = aCol.toVar(); If(gateB, () => { v.assign(colF(cB)); }); return v; })();
        const onB = Fn(() => { const v = vec4(aOrm.g, aOrm.b, aN.x, aN.y).toVar(); If(gateB, () => { const o2 = ormF(cB), n2 = nrmF(cB); v.assign(vec4(o2.g, o2.b, n2.x, n2.y)); }); return v; })();
        const w = cA.w, vp = sqrt(w.mul(w).add(float(1).sub(w).mul(float(1).sub(w))));      // Heitz-Neyret: keep the variance of the blend
        const meanC = texture(o.tex.map, vec2(0.5, 0.5)).level(float(12)).rgb;
        const col = meanC.add(aCol.mul(w).add(colB.mul(float(1).sub(w))).sub(meanC).div(vp)).max(0.0);
        const mixed = vec4(aOrm.g, aOrm.b, aN.x, aN.y).mul(w).add(onB.mul(float(1).sub(w)));
        return { col, orm: vec3(1.0, mixed.x, mixed.y), nxy: vec2(mixed.z, mixed.w) };
      };
      // the stochastic height: layer A's cell, plus layer B's where B still has weight (same blend weight as the colour)
      const Hs = (u, lod) => {
        const off2 = u.sub(uvn), hv = float(0).toVar();
        hv.assign(texture(o.height, cA.u0.add(cA.rot(off2))).level(lod).r);
        If(gateB, () => { hv.assign(mix(texture(o.height, cB.u0.add(cB.rot(off2))).level(lod).r, hv, cA.w)); });
        return hv;
      };
      const macro = vnoise(uvn.mul(0.11).add(7.3)).mul(0.6).add(vnoise(uvn.mul(0.37).add(1.7)).mul(0.4));      // 0..1, patches of ~9 and ~3 tiles
      const b = marchRef({ uv: uvn, H: Hs, N: T.normalView, mask: float(1), lodMax: 4.0, depthMul: float(1).add(macro.sub(0.5).mul(kMacro).mul(1.6)) });
      const Ph = b.uv.sub(uvn), m = buildMaps(Ph);
      const gate = b.fade.clamp(0.0, 1.0), cav = mix(float(1), float(0.55).add(b.h.mul(0.45)), gate.mul(o.cavity == null ? 0.8 : o.cavity));
      // macro albedo: +-kMacro/2 patch brightness, plus a larger colour scale (0.31x, rotated) blended in by the same noise
      const uvp = uvn.add(Ph), um = vec2(uvp.x.mul(0.25).sub(uvp.y.mul(0.17)), uvp.x.mul(0.17).add(uvp.y.mul(0.25)));
      const colM = texture(o.tex.map, um).rgb, Y = vec3(0.2126, 0.7152, 0.0722);
      const big = smoothstep(0.35, 0.75, vnoise(uvn.mul(0.19).add(3.1))).mul(0.55).mul(kMacro.mul(4.0).min(1.0));
      let alb = m.col.mul(float(1).sub(kMacro.mul(0.5)).add(macro.mul(kMacro)));
      alb = mix(alb, colM.mul(dot(alb, Y).div(dot(colM, Y).max(0.02))), big);                    // the larger-scale texture carries the same luminance: it re-patterns, it does not re-light
      // decals / scatter: vertical stains (streaks up the surface, stretched along v) and lichen in the crevices
      const sn1 = vnoise(vec2(uvn.x.mul(2.3), uvn.y.mul(0.35)).add(11.0)), stain = smoothstep(0.55, 0.85, sn1.mul(0.7).add(vnoise(vec2(uvn.x.mul(7.0), uvn.y.mul(0.9))).mul(0.3))).mul(kStain);
      const lp = smoothstep(0.58, 0.8, vnoise(uvn.mul(0.9).add(5.5)).mul(0.65).add(vnoise(uvn.mul(3.1)).mul(0.35))), lichen = lp.mul(float(1).sub(smoothstep(0.25, 0.7, b.h))).mul(kLichen);
      alb = mix(alb.mul(float(1).sub(stain.mul(0.45))), lichCol.mul(dot(alb, Y).mul(1.4).add(0.25)), lichen.clamp(0.0, 0.85));
      mat.map = null; mat.normalMap = null; mat.roughnessMap = null; mat.metalnessMap = null;
      mat.colorNode = alb.mul(materialColor.rgb).mul(cav).mul(mix(float(1), b.shade, gate));
      if (o.tex.nrm) { const ns = o.nrmScale == null ? 1 : o.nrmScale; mat.normalNode = normalMap(vec3(m.nxy, sqrt(float(1).sub(dot(m.nxy, m.nxy)).max(0.0))).mul(0.5).add(0.5), vec2(ns, ns)); }
      if (o.tex.orm) { mat.roughnessNode = materialRoughness.mul(m.orm.g).add(lichen.mul(0.3)).add(stain.mul(0.1)).clamp(0.04, 1.0); mat.metalnessNode = materialMetalness.mul(m.orm.b); }
      mat.userData.dmPxStruct = { stoch: true }; mat.userData.dmReliefH = b.h; mat.needsUpdate = true; S.mats++;
      try { if (G.DMLight && G.DMLight.on && !(mat.userData && mat.userData.noLight)) G.DMLight.applyMaterial(mat, { p: T.positionWorld, n: T.normalWorld, h: b.h }); } catch (e) { }   // (ui/dm-light.js) radiance cache: bent-normal AO + bounce + height-cache sun visibility; the relief height darkens crevices

      return true;
    } catch (e) { try { console.warn('[parallax] structure', e); } catch (_) { } return false; }
  }
  // the streaming code swapped the map set (512 -> 1K -> 2K): point the twin's texture nodes at the new textures (no recompile: same types)
  function structureMaps(mat, t) { return false; }   // (v260) the stochastic graph owns its texture nodes: swap the map set BEFORE structure() (the cliff / mansion loaders already do)
  // SHARED OPT-IN HELPER: anything that wears a standard material with a colour map + normal map (wood, metal, plaster, GLB props ...) can get parallax with one call:
  //   DMParallax.optIn(root, mat, { key, tileM, depthM, near, far, heightTex?, nrmScale, cavity })  -> Promise<boolean>
  // It adopts the material into its node twin on every mesh under `root`, derives (time-sliced, cached by key, capped at the tier's hMax) a height map from the material's
  // normal map (or, with no normal map, from the colour map) unless `heightTex` is given, and builds the shared march on it.  Safe to call for any tier; ?px=0 / no node renderer -> false.
  function optIn(root, mat, o) {
    o = o || {};
    try {
      if (off || !mat || !root || !init()) return Promise.resolve(false);
      let tw = mat; (Array.isArray(root) ? root : [root]).forEach((rt) => { tw = adopt(rt, mat); }); if (!tw || !tw.isNodeMaterial) return Promise.resolve(false);
      const a = tw.map || (tw.userData.dmPxFrom && tw.userData.dmPxFrom.map), n = tw.normalMap || (tw.userData.dmPxFrom && tw.userData.dmPxFrom.normalMap), r = tw.roughnessMap || (tw.userData.dmPxFrom && tw.userData.dmPxFrom.roughnessMap);
      if (!a) return Promise.resolve(false);
      const key = o.key || ('opt|' + (tw.name || tw.uuid)), cap = o.hMax || tierRow(curTier()).hMax;
      const hp = o.heightTex ? Promise.resolve(o.heightTex) : deriveHeightAsync(key, n || a, n ? 'nrm' : 'rgb', cap);
      return hp.then((ht) => (ht ? structure(tw, { tex: { map: a, nrm: n || null, orm: r || null }, height: ht, hSize: ht.image.width, tileM: o.tileM || 1, depthM: o.depthM || 0.03, near: o.near || 10, far: o.far || 30, bias: o.bias, nrmScale: o.nrmScale, cavity: o.cavity }) : false));
    } catch (e) { return Promise.resolve(false); }
  }

  G.DMParallax = {
    on: !off, ref: { march, shadow, distFade, layersFor, TIERS, BOUNDS, TIER_ORDER, cfgAt, cost },
    heightFromRGBA, heightFromNormals, heightFromRGBAG, heightFromNormalsG, makeTile, heightTexture, tileTexture, refresh, texelsLanded, applyToMaterial, applyGround, init, buildCore, marchRef, adopt, structure, structureMaps, deriveHeight, deriveHeightInto, deriveHeightAsync, optIn,
    tierRow, tierName: () => curTier(), klassName: () => klass(), trimFirst, setProps,
    config: () => ({ tier: S.tier, klass: S.klass, scale: S.scale, cfg: S.cfg }),
    status: () => ({ ready: S.ready, tier: S.tier, cfg: S.cfg, maps: S.tex.size, materials: S.mats, graphs: S.builds, off, gov: { q: +S.gov.q.toFixed(2), emaMs: +S.gov.ema.toFixed(1), changes: S.gov.changes, fails: S.gov.fails, holdMs: S.gov.hold } }),
    _S: S,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = G.DMParallax;
})(typeof window !== 'undefined' ? window : globalThis);
