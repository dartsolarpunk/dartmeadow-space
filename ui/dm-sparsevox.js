/* DART Meadow — sparse voxel bricks for narrow-band marching cubes (v136, crunch-1).
 *
 * The world's density field only matters near its surface. Instead of meshing
 * a dense N³ grid, the grid is cut into B³-cell bricks and only the bricks
 * whose bounds can reach the surface band are generated and meshed on the GPU
 * (index.html: buildProceduralPlanetMesh for whole worlds, buildGpuSurfacePatch
 * for the walkable ground). Bricks keep their own (B+1)³ corner samples; a face
 * shared by two bricks is sampled at the same points with the same function, so
 * the seams are watertight at a given level (no transvoxel needed inside one mesh).
 *
 *   plan({N,half,radius,reliefBand})            sphere shell (orbital / far worlds)
 *   planColumns({N,B,GRID,CELL,oY,hcol,below,above})  height-field ground patch
 *   scatter(plan,sparse,GRID,fill) / gather(plan,dense,sparse)  sparse <-> dense copies
 *     (collision and the fragment cleaner still read a dense grid on the CPU)
 *   Pool: brick slot pool with a free list, keyed by brick coordinate, so a
 *     re-planned region keeps the slots of bricks it still has.
 * No THREE here; runs in Node for tests.
 */
(function (root) {
  'use strict';
  function Pool() { this.slotOf = new Map(); this.free = []; this.next = 0; }
  Pool.prototype.alloc = function (key) {
    let s = this.slotOf.get(key); if (s != null) return s;
    s = this.free.length ? this.free.pop() : this.next++;
    this.slotOf.set(key, s); return s;
  };
  Pool.prototype.release = function (key) { const s = this.slotOf.get(key); if (s == null) return; this.slotOf.delete(key); this.free.push(s); };
  // keep only `keys`; returns slots in use (dense-packed slot ids are reused first)
  Pool.prototype.retain = function (keys) {
    const want = new Set(keys);
    for (const k of Array.from(this.slotOf.keys())) if (!want.has(k)) this.release(k);
    return keys.map((k) => this.alloc(k));
  };

  function pick(B0, N) { const B = Math.max(2, Math.min(B0 || 4, N)); return { B, NB: Math.ceil(N / B) }; }
  function pack(list, NB, B, pool) {
    // list: [bx,by,bz,...]; returns compact coords in slot order
    const n = list.length / 3, keys = new Array(n);
    for (let i = 0; i < n; i++) keys[i] = list[i * 3] + NB * (list[i * 3 + 1] + NB * list[i * 3 + 2]);
    let slots;
    if (pool) slots = pool.retain(keys); else { slots = new Array(n); for (let i = 0; i < n; i++) slots[i] = i; }
    const count = slots.reduce((m, s) => Math.max(m, s + 1), 0);
    const coords = new Uint32Array(Math.max(1, count) * 4);
    // unused (freed, not refilled) slots point at brick (0,0,0) — a corner brick, always outside the band: meshes nothing
    for (let i = 0; i < n; i++) { const s = slots[i]; coords[s * 4] = list[i * 3]; coords[s * 4 + 1] = list[i * 3 + 1]; coords[s * 4 + 2] = list[i * 3 + 2]; coords[s * 4 + 3] = 1; }
    return { coords, count, active: n, slots, keys };
  }

  // Sphere shell: brick is active if its AABB distance range overlaps [radius-band, radius+band].
  function plan(o) {
    const N0 = o.N | 0; let { B, NB } = pick(o.B || (N0 >= 80 ? 8 : 4), N0);
    const N = NB * B, half = o.half, cell = half * 2 / N, R = o.radius, band = o.reliefBand + cell * 1.01;
    const list = [], bw = B * cell;
    for (let bz = 0; bz < NB; bz++) for (let by = 0; by < NB; by++) for (let bx = 0; bx < NB; bx++) {
      const x0 = bx * bw - half, y0 = by * bw - half, z0 = bz * bw - half, x1 = x0 + bw, y1 = y0 + bw, z1 = z0 + bw;
      const cxn = Math.max(x0, Math.min(0, x1)), cyn = Math.max(y0, Math.min(0, y1)), czn = Math.max(z0, Math.min(0, z1));
      const dmin = Math.hypot(cxn, cyn, czn);
      const dmax = Math.hypot(Math.max(-x0, x1), Math.max(-y0, y1), Math.max(-z0, z1));
      if (dmax >= R - band && dmin <= R + band) list.push(bx, by, bz);
    }
    const p = pack(list, NB, B, o.pool);
    return Object.assign(p, { N, B, NB, total: NB * NB * NB, kind: 'shell' });
  }

  // Height field: brick active if its y span overlaps [min(h)-below, max(h)+above] over its columns.
  function planColumns(o) {
    const N0 = o.N | 0; const pk = pick(o.B || 8, N0);
    if (pk.NB * pk.B !== N0) { pk.B = N0 % 8 === 0 ? 8 : (N0 % 6 === 0 ? 6 : (N0 % 5 === 0 ? 5 : (N0 % 4 === 0 ? 4 : N0))); pk.NB = N0 / pk.B; }
    const { B, NB } = pk, N = N0, G = o.GRID, cell = o.CELL, h = o.hcol, list = [];
    for (let bz = 0; bz < NB; bz++) for (let bx = 0; bx < NB; bx++) {
      let lo = Infinity, hi = -Infinity;
      for (let z = bz * B; z <= bz * B + B; z++) for (let x = bx * B; x <= bx * B + B; x++) { const v = h[x + z * G]; if (v < lo) lo = v; if (v > hi) hi = v; }
      lo -= o.below + cell; hi += o.above + cell;
      for (let by = 0; by < NB; by++) {
        const y0 = o.oY + by * B * cell, y1 = y0 + B * cell;
        if (y1 >= lo && y0 <= hi) list.push(bx, by, bz);
      }
    }
    const p = pack(list, NB, B, o.pool);
    return Object.assign(p, { N, B, NB, total: NB * NB * NB, kind: 'columns' });
  }

  // sparse brick samples -> dense GRID³ (fill(gx,gy,gz) for points no brick covers)
  function scatter(pl, sparse, GRID, fill) {
    const dense = new Float32Array(GRID * GRID * GRID), seen = new Uint8Array(dense.length);
    const B = pl.B, BP = B + 1, P3 = BP * BP * BP, c = pl.coords;
    for (let s = 0; s < pl.count; s++) {
      if (!c[s * 4 + 3]) continue;
      const ox = c[s * 4] * B, oy = c[s * 4 + 1] * B, oz = c[s * 4 + 2] * B;
      for (let z = 0; z < BP; z++) for (let y = 0; y < BP; y++) for (let x = 0; x < BP; x++) {
        const gi = (ox + x) + (oy + y) * GRID + (oz + z) * GRID * GRID;
        dense[gi] = sparse[s * P3 + x + y * BP + z * BP * BP]; seen[gi] = 1;
      }
    }
    for (let gz = 0; gz < GRID; gz++) for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
      const gi = gx + gy * GRID + gz * GRID * GRID; if (!seen[gi]) dense[gi] = fill(gx, gy, gz);
    }
    return dense;
  }
  function gather(pl, dense, sparse, GRID) {
    const B = pl.B, BP = B + 1, P3 = BP * BP * BP, c = pl.coords;
    for (let s = 0; s < pl.count; s++) {
      if (!c[s * 4 + 3]) continue;
      const ox = c[s * 4] * B, oy = c[s * 4 + 1] * B, oz = c[s * 4 + 2] * B;
      for (let z = 0; z < BP; z++) for (let y = 0; y < BP; y++) for (let x = 0; x < BP; x++)
        sparse[s * P3 + x + y * BP + z * BP * BP] = dense[(ox + x) + (oy + y) * GRID + (oz + z) * GRID * GRID];
    }
    return sparse;
  }

  const builds = [];
  function noteBuild(kind, info) { if (!info) return; builds.push(Object.assign({ kind, t: Date.now() }, info)); if (builds.length > 40) builds.shift(); }
  // whole-feature off switch for A/B: ?sparse=0
  let on = true; try { on = !/[?&]sparse=0\b/.test(root.location.search); } catch (e) {}
  const api = { Pool, plan, planColumns, scatter, gather, noteBuild, builds, on };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (on) root.DMSparseVox = api; else root.DMSparseVoxOff = api;
})(typeof window !== 'undefined' ? window : globalThis);
