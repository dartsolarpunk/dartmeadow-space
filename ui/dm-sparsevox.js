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


  // ── Per-brick LOD (v136 crunch-1 part 2) ─────────────────────────────────────────────────────
  // Octree over the world's cube [-half,half]^3. Every leaf is ONE brick of B³ cells; a leaf at level L
  // spans B·2^L base cells (base cell = 2·half/(B·2^Lroot)), so every brick costs the same slot size
  // and near bricks are finer than far ones. A node is refined when the camera is within k node-sizes of
  // it (and it touches the relief shell [rMin,rMax] padded by one of its own cells), down to level 0;
  // nodes above `coarsest` are always refined so a far world is never cruder than N_eff = B·2^(Lroot-coarsest).
  // The leaf budget `maxBricks` is spent nearest-first. Seams between different levels are covered by
  // skirts in the GPU kernel (index.html).
  function lodSelect(o) {
    const B = o.B, Lr = o.rootLevel, half = o.half, base = half * 2 / (B * (1 << Lr));
    const cam = o.cam || [1e30, 1e30, 1e30], k = o.k || 2.5, coarsest = o.coarsest == null ? Lr : o.coarsest;
    const maxB = o.maxBricks || 512, out = [];
    const touches = (x0, y0, z0, w, pad) => {
      const x1 = x0 + w, y1 = y0 + w, z1 = z0 + w;
      const cx = Math.max(x0, Math.min(0, x1)), cy = Math.max(y0, Math.min(0, y1)), cz = Math.max(z0, Math.min(0, z1));
      const dmin = Math.hypot(cx, cy, cz), dmax = Math.hypot(Math.max(-x0, x1), Math.max(-y0, y1), Math.max(-z0, z1));
      return dmax >= o.rMin - pad && dmin <= o.rMax + pad;
    };
    const dist = (x0, y0, z0, w) => {
      const dx = Math.max(x0 - cam[0], 0, cam[0] - x0 - w), dy = Math.max(y0 - cam[1], 0, cam[1] - y0 - w), dz = Math.max(z0 - cam[2], 0, cam[2] - z0 - w);
      return Math.hypot(dx, dy, dz);
    };
    // node: [L, ox, oy, oz] in base cells; frontier refined nearest-first while the budget allows
    let open = [[Lr, 0, 0, 0]], count = 1;
    while (open.length) {
      const next = [];
      // nearest first, so a tight budget is spent where the camera is
      open.forEach((n) => { const w = B * (1 << n[0]) * base; n[4] = dist(n[1] * base - half, n[2] * base - half, n[3] * base - half, w); });
      open.sort((a, b) => a[4] - b[4]);
      for (const n of open) {
        const L = n[0], span = B * (1 << L), w = span * base, x0 = n[1] * base - half, y0 = n[2] * base - half, z0 = n[3] * base - half;
        const want = L > 0 && (L > coarsest || n[4] < k * w);
        let kids = null;
        if (want) {
          kids = []; const h = span >> 1;
          for (let c = 0; c < 8; c++) {
            const kx = n[1] + (c & 1) * h, ky = n[2] + ((c >> 1) & 1) * h, kz = n[3] + ((c >> 2) & 1) * h;
            if (touches(kx * base - half, ky * base - half, kz * base - half, w / 2, (w / 2) / B * 1.01)) kids.push([L - 1, kx, ky, kz]);
          }
          if (count - 1 + kids.length + next.length > maxB && L <= coarsest) kids = null; // budget: stay a leaf
        }
        if (kids) { count += kids.length - 1; for (const c of kids) next.push(c); }
        else out.push({ key: L + ':' + n[1] + ':' + n[2] + ':' + n[3], L, ox: n[1], oy: n[2], oz: n[3] });
      }
      open = next;
    }
    return { leaves: out, base, B, rootLevel: Lr };
  }

  // Incremental streaming on top of a Pool. desire(leaves) diffs against what is resident; step(n)
  // hands out at most n bricks to build (nearest first, as lodSelect ordered them). Bricks that left
  // the set stay drawn until every wanted brick is built, then are cleared in one go, so a level change
  // never opens a hole (the old and new levels overlap for a few frames instead).
  function LodStream(capacity) {
    this.cap = capacity; this.pool = new Pool(); this.resident = new Map(); this.want = new Map(); this.todo = []; this.stale = [];
  }
  LodStream.prototype.desire = function (leaves) {
    this.want = new Map(leaves.map((l) => [l.key, l]));
    this.todo = leaves.filter((l) => !this.resident.has(l.key));
    this.stale = Array.from(this.resident.keys()).filter((k) => !this.want.has(k));
    return this.todo.length;
  };
  LodStream.prototype.step = function (n) {
    const build = [], clear = [];
    // free slots for new bricks: use the free list, else (pool full) release stale bricks early
    while (build.length < n && this.todo.length) {
      if (this.pool.free.length === 0 && this.pool.next >= this.cap) {
        const k = this.stale.pop(); if (k == null) { this.todo.length = 0; break; }
        clear.push(this.resident.get(k).slot); this.resident.delete(k); this.pool.release(k); continue;
      }
      const l = this.todo.shift(), slot = this.pool.alloc(l.key);
      this.resident.set(l.key, { slot, l }); build.push(Object.assign({ slot }, l));
    }
    if (!this.todo.length && this.stale.length) {
      for (const k of this.stale) { const r = this.resident.get(k); if (r) { clear.push(r.slot); this.resident.delete(k); this.pool.release(k); } }
      this.stale = [];
    }
    return { build, clear, pending: this.todo.length };
  };


  // Dense-indexed view over the sparse brick samples — no G³ copy. get(gi)/set(gi,v) take the dense
  // index gx + gy·G + gz·G². A point on a brick face/edge/corner lives in up to 8 bricks: get reads the
  // first, set writes every copy (so the GPU re-mesh stays watertight). Points in no active brick read
  // fill(gx,gy,gz) and ignore writes that keep their sign (a write that flips one marks `spill`).
  function View(pl, sparse, GRID, fill) {
    const B = pl.B, NB = pl.NB, BP = B + 1, P3 = BP * BP * BP, c = pl.coords, lut = new Int32Array(NB * NB * NB).fill(-1);
    for (let s = 0; s < pl.count; s++) if (c[s * 4 + 3]) lut[c[s * 4] + NB * (c[s * 4 + 1] + NB * c[s * 4 + 2])] = s;
    const GG = GRID * GRID, v = { length: GRID * GG, sparse, dirty: false, spill: 0, isView: true };
    const cand = (g) => { const b = Math.min(NB - 1, (g / B) | 0); return (g % B === 0 && g > 0 && b === (g / B)) ? [b, b - 1] : [b]; };
    v.get = (gi) => {
      const gx = gi % GRID, gy = ((gi / GRID) | 0) % GRID, gz = (gi / GG) | 0;
      const bx = Math.min(NB - 1, (gx / B) | 0), by = Math.min(NB - 1, (gy / B) | 0), bz = Math.min(NB - 1, (gz / B) | 0);
      let s = lut[bx + NB * (by + NB * bz)];
      if (s >= 0) return sparse[s * P3 + (gx - bx * B) + (gy - by * B) * BP + (gz - bz * B) * BP * BP];
      for (const X of cand(gx)) for (const Y of cand(gy)) for (const Z of cand(gz)) { s = lut[X + NB * (Y + NB * Z)]; if (s >= 0) return sparse[s * P3 + (gx - X * B) + (gy - Y * B) * BP + (gz - Z * B) * BP * BP]; }
      return fill(gx, gy, gz);
    };
    v.set = (gi, val) => {
      const gx = gi % GRID, gy = ((gi / GRID) | 0) % GRID, gz = (gi / GG) | 0; let hit = false;
      for (const X of cand(gx)) for (const Y of cand(gy)) for (const Z of cand(gz)) { const s = lut[X + NB * (Y + NB * Z)]; if (s >= 0) { sparse[s * P3 + (gx - X * B) + (gy - Y * B) * BP + (gz - Z * B) * BP * BP] = val; hit = true; } }
      if (hit) v.dirty = true; else if ((val < 0) !== (fill(gx, gy, gz) < 0)) v.spill++;
    };
    return v;
  }

  const builds = [];
  function noteBuild(kind, info) { if (!info) return; builds.push(Object.assign({ kind, t: Date.now() }, info)); if (builds.length > 40) builds.shift(); }
  // whole-feature off switch for A/B: ?sparse=0
  let on = true; try { on = !/[?&]sparse=0\b/.test(root.location.search); } catch (e) {}
  const api = { Pool, plan, lodSelect, LodStream, View, planColumns, scatter, gather, noteBuild, builds, on };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (on) root.DMSparseVox = api; else root.DMSparseVoxOff = api;
})(typeof window !== 'undefined' ? window : globalThis);
