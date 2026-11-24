/* DART Meadow — contour-bounded water basins (t1644 CE-7).
 *
 * One map per seeded world of WHERE its liquid may exist: the ground's own height field (the whole-planet map index.html worldMapFor() bakes from
 * _terrainCore, i.e. the very function she walks on, plus Earth's real geography) is cut at the liquid level, and every below-level cell is labelled
 * as OCEAN (a large connected basin) or LAKE (a small enclosed one) by a flood fill that wraps east-west and stops at the poles.  The coastlines are
 * the contour lines of the terrain at sea level, so:
 *   - the sea sheet's clip-map tiles and fragments (ui/dm-water.js / dm-water-sea.js) are drawn only inside a basin perimeter, also past the near
 *     cover grid (that used to be "outside the grid: everything is drawn"),
 *   - the swim / buoyancy volume (index.html _surfWaterAt) only holds inside a basin,
 *   - lakes and oceans of every procedural world, Earth, Solenne and Titan's methane seas come from the same rule (the liquid's optics stay per world in
 *     ui/dm-water-core.js identityFor: water / methane / ammonia / lava).
 * No water geometry, shading or physics is ever produced under a continent or dry land.
 *
 * Grid: W x H cells, longitude -180..180 (wraps), latitude 90..-90, heights in world units relative to the liquid level (0 = sea level).
 * World <-> map: the flat frame x = lon / D, z = -lat / D (D = ATMO_DEG_PER_UNIT, index.html _siteWorldXZ); local walk frame = world - site offset.
 * Pure (node-testable): fromGrid, lowAt, wetAt, boxWet, windowInto.  Browser: window.DMWaterBasin registry (put / get / forBody).
 */
(function (root) {
  'use strict';
  const SEA_MARGIN = 0.5;           // a cell is liquid when its height < level + 0.5 (same test as ui/dm-planet.js PlanetLOD sea tiles: minH < 0.5)
  const OCEAN_FRAC = 0.02;          // a connected basin covering >= 2 % of the wet cells (or the largest) is an ocean; the rest are lakes
  const LAND = 1, OCEAN = 2, LAKE = 3;

  // heights: Float32Array W*H.  Returns { W, H, cls: Uint8Array (1 land, 2 ocean, 3 lake), low: Float32Array (3x3 minimum: conservative at the coast),
  // lakes, oceans, wetFrac, level }.  O(W*H), no recursion (explicit stack).
  function fromGrid(heights, W, H, level, opts) {
    const lv = level || 0, n = W * H, cls = new Uint8Array(n), low = new Float32Array(n), lab = new Int32Array(n).fill(-1), o = opts || {};
    let wet = 0;
    for (let k = 0; k < n; k++) { const h = heights[k]; if (h < lv + SEA_MARGIN) { cls[k] = 0; wet++; } else cls[k] = LAND; }
    // flood fill the wet cells into basins (4-connected, wraps in x)
    const stack = new Int32Array(n), sizes = []; let nb = 0;
    for (let s = 0; s < n; s++) {
      if (cls[s] === LAND || lab[s] >= 0) continue;
      let sp = 0, sz = 0; stack[sp++] = s; lab[s] = nb;
      while (sp > 0) {
        const k = stack[--sp]; sz++;
        const x = k % W, y = (k / W) | 0;
        for (let q = 0; q < 4; q++) {
          const m = q === 0 ? y * W + ((x + 1) % W) : q === 1 ? y * W + ((x - 1 + W) % W) : q === 2 ? (y > 0 ? k - W : -1) : (y < H - 1 ? k + W : -1);
          if (m >= 0 && cls[m] !== LAND && lab[m] < 0) { lab[m] = nb; stack[sp++] = m; }
        }
      }
      sizes.push(sz); nb++;
    }
    let big = 0; for (let b = 1; b < nb; b++) if (sizes[b] > sizes[big]) big = b;
    const oceanMin = Math.max(1, (o.oceanFrac == null ? OCEAN_FRAC : o.oceanFrac) * wet);
    let lakes = 0, oceans = 0; const isOcean = new Uint8Array(Math.max(1, nb));
    for (let b = 0; b < nb; b++) { if (b === big || sizes[b] >= oceanMin) { isOcean[b] = 1; oceans++; } else lakes++; }
    for (let k = 0; k < n; k++) if (cls[k] !== LAND) cls[k] = isOcean[lab[k]] ? OCEAN : LAKE;
    // conservative low field: the lowest height of the 3x3 neighbourhood (a coast between two cell centres is never lost)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let m = 1e9; for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -1; dx <= 1; dx++) { const v = heights[yy * W + ((x + dx + W) % W)] - lv; if (v < m) m = v; } }
      low[y * W + x] = m;
    }
    return { W, H, cls, low, lakes, oceans, wetFrac: n ? wet / n : 0, level: lv, basins: nb };
  }
  // bilinear sample of the low field at world (x, z) in the flat frame (x = lon / D, z = -lat / D)
  function lowAt(B, x, z, D) {
    if (!B) return -1e9;
    const lon = x * D, lat = -z * D, W = B.W, H = B.H;
    let u = ((lon + 180) / 360) * W - 0.5, v = ((90 - lat) / 180) * H - 0.5;
    u = u - Math.floor(u / W) * W; v = v < 0 ? 0 : (v > H - 1 ? H - 1 : v);
    const i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0, i1 = (i0 + 1) % W, j1 = Math.min(H - 1, j0 + 1), L = B.low;
    const a = L[j0 * W + i0], b = L[j0 * W + i1], c = L[j1 * W + i0], d = L[j1 * W + i1];
    return (a + (b - a) * fu) + ((c + (d - c) * fu) - (a + (b - a) * fu)) * fv;
  }
  // can liquid be at world (x, z)?  pad: metres of swell / swash allowance (the cover mask's COVER_LAND)
  function wetAt(B, x, z, D, pad) { return lowAt(B, x, z, D) <= (pad == null ? SEA_MARGIN : pad); }
  // can any liquid show in the world box?  Samples the corners, edge midpoints and the centre plus a lattice no coarser than the map cell (never misses a basin)
  function boxWet(B, x0, x1, z0, z1, D, pad) {
    if (!B) return true;
    const cell = 180 / B.H / D, nx = Math.min(16, Math.max(2, Math.ceil((x1 - x0) / cell) + 1)), nz = Math.min(16, Math.max(2, Math.ceil((z1 - z0) / cell) + 1));
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) if (wetAt(B, x0 + (x1 - x0) * i / nx, z0 + (z1 - z0) * j / nz, D, pad)) return true;
    return false;
  }
  // fill an N x N window (cell size `cell`, centred on LOCAL (cx, cz), site offset (sx, sz) = world - local) with the low field: the far cover texture
  function windowInto(B, out, N, cell, cx, cz, sx, sz, D) {
    const x0 = cx - N * cell / 2 + cell / 2, z0 = cz - N * cell / 2 + cell / 2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) out[j * N + i] = B ? lowAt(B, x0 + i * cell + sx, z0 + j * cell + sz, D) : -10;
    return out;
  }
  const core = { fromGrid, lowAt, wetAt, boxWet, windowInto, SEA_MARGIN, OCEAN_FRAC, LAND, OCEAN, LAKE };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;
  // ── browser registry: one basin map per world (keyed by body name), refreshed by every world-map pass (coarse first, then the full one)
  const W = root, reg = new Map();
  const Q = (() => { try { return W.location.search || ''; } catch (e) { return ''; } })();
  const out = Object.assign({}, core, {
    on: !/[?&]water=legacy\b/.test(Q),   // ?water=legacy: the old conservative sheet (drawn everywhere outside the near grid) and the box swim volume, for an A/B
    ver: 0,
    put(name, B) { if (!name || !B) return; reg.set(name, B); out.ver++; try { W.dispatchEvent(new CustomEvent('dm:basin', { detail: { name, lakes: B.lakes, oceans: B.oceans, wet: B.wetFrac, W: B.W } })); } catch (e) { } },
    get(name) { return out.on ? (reg.get(name) || null) : null; },
    forBody(b) { return b ? out.get(b.name) : null; },
    status() { const o = {}; reg.forEach((B, k) => { o[k] = { W: B.W, H: B.H, oceans: B.oceans, lakes: B.lakes, wet: +(B.wetFrac * 100).toFixed(1) + '%' }; }); return o; }
  });
  W.DMWaterBasin = out;
})(typeof window !== 'undefined' ? window : globalThis);
