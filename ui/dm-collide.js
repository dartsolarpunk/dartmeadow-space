// dm-collide.js — DMCollide: the one collision layer for everything that is not the terrain mesh itself.
//
//   STATIC COLLIDERS   primitive shapes registered into a uniform XZ spatial hash (O(1) cell lookup):
//                      sphere, ellipsoid (vertical axis), vertical cylinder, yaw-rotated box (OBB), heightfield tile.
//                      Struct-of-arrays storage + free lists: nothing is allocated after create(). Groups (a streamed chunk, a
//                      settlement, the mansion) unregister in one clearGroup() and their slots are pooled for the next chunk.
//   CHARACTER SWEEP    walk(c, dx, dz): a vertical capsule moved in fixed sub-steps (<= radius/2 each, so a 15 fps frame at run speed
//                      cannot tunnel), pushed out of shapes with slide, step-up (<= c.step), a per-sweep climb budget (slope limit),
//                      ground snapping, and soft actor-vs-actor separation. supportAt() is the "what am I standing on" query.
//   DYNAMIC BODIES    spheres with mass / restitution / friction from material tags: fixed 1/120 s sub-steps (capped), impulse response
//                      against statics, the terrain callback, actors and each other, buoyancy + drag in water, sleeping.
//   CONTACT EVENTS    on(fn): impact / scrape / land / step / splash / exit / hit events (shared event object, ring-buffered, rate-limited)
//                      carrying both material tags and an fx tag (dust, spark, splash, chime, thud, shatter) for audio / particles /
//                      the water ripple ring (see ui/dm-collide-fx.js).
//   QUERIES            query / raycast / sweepSphere / pushOut / topAt for the board, camera and gameplay probes.
//
// Pure JS with no THREE dependency in the core (node-testable: tools/tests/collide-unit.js). The debug view (?collider=1) needs THREE and
// lives at the bottom. Units are scene units (the character is ~3.26 tall; 1 unit ~ 0.55 ft).
(function (root) {
  'use strict';
  const T_SPHERE = 1, T_ELLIPSOID = 2, T_CYL = 3, T_BOX = 4, T_HF = 5;
  const F_ON = 1, F_SOFT = 2, F_ACTOR = 4, F_TRIG = 8;   // active · characters pass (foliage; bodies still hit) · kinematic character · no response
  const MATS = ['ground', 'rock', 'wood', 'metal', 'glass', 'foliage', 'water', 'fabric', 'flesh', 'stone', 'plastic'];
  //            rest  fric  dens(kg/m3)   fx
  const MP = {
    ground: [0.15, 0.80, 1600, 'dust'], rock: [0.30, 0.65, 2600, 'dust'], wood: [0.30, 0.55, 700, 'thud'], metal: [0.45, 0.30, 7800, 'spark'],
    glass: [0.20, 0.15, 2500, 'chime'], foliage: [0.05, 0.90, 300, 'leaf'], water: [0.00, 0.10, 1000, 'splash'], fabric: [0.05, 0.90, 400, 'thud'],
    flesh: [0.10, 0.70, 1000, 'thud'], stone: [0.28, 0.70, 2400, 'dust'], plastic: [0.55, 0.40, 1100, 'thud']
  };
  const MID = {}, REST = new Float32Array(16), FRIC = new Float32Array(16), DENS = new Float32Array(16), FXN = [];
  MATS.forEach((m, i) => { MID[m] = i; REST[i] = MP[m][0]; FRIC[i] = MP[m][1]; DENS[i] = MP[m][2]; FXN[i] = MP[m][3]; });
  const matId = (m) => (typeof m === 'number' ? m : (MID[m] != null ? MID[m] : 0));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sqrt = Math.sqrt, abs = Math.abs, min = Math.min, max = Math.max;

  function create(o) {
    o = o || {};
    const CAP = o.capacity || 8192, CELL = o.cell || 6, HASH = 8192, ENT = CAP * 6, BIGCAP = 256, QCAP = 768, NB = o.bodies || 48, NA = o.actors || 24;
    const W = { cell: CELL, cap: CAP, gravity: o.gravity != null ? o.gravity : 9.8, on: true, version: 0, water: null, ground: null,
      stats: { colliders: 0, bodies: 0, actors: 0, queries: 0, cands: 0, pushes: 0, subSteps: 0, bodySteps: 0, ms: 0, groups: 0, peak: 0, overflow: 0 } };
    // ── collider storage
    const typ = new Uint8Array(CAP), mat = new Uint8Array(CAP), flg = new Uint8Array(CAP), grp = new Int32Array(CAP), gnx = new Int32Array(CAP);
    const px = new Float32Array(CAP), py = new Float32Array(CAP), pz = new Float32Array(CAP), ea = new Float32Array(CAP), eb = new Float32Array(CAP), ec = new Float32Array(CAP);
    const cs = new Float32Array(CAP), sn = new Float32Array(CAP), bx0 = new Float32Array(CAP), bz0 = new Float32Array(CAP), bx1 = new Float32Array(CAP), bz1 = new Float32Array(CAP);
    const cr0 = new Int32Array(CAP), cr1 = new Int32Array(CAP), cr2 = new Int32Array(CAP), cr3 = new Int32Array(CAP), big = new Int32Array(CAP), stamp = new Uint32Array(CAP);
    const hf = new Array(CAP).fill(null), ud = new Array(CAP).fill(null);
    const freeC = new Int32Array(CAP); let nFreeC = CAP; for (let i = 0; i < CAP; i++) freeC[i] = CAP - 1 - i;
    // ── grid: bucket heads + entry pool
    const head = new Int32Array(HASH).fill(-1), entC = new Int32Array(ENT), entN = new Int32Array(ENT), freeE = new Int32Array(ENT); let nFreeE = ENT; for (let i = 0; i < ENT; i++) freeE[i] = ENT - 1 - i;
    const bigList = new Int32Array(BIGCAP); let nBig = 0, qStamp = 1;
    const hsh = (ix, iz) => (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) & (HASH - 1);
    // ── groups
    const gNames = new Map(), gHead = []; const gFree = [];
    function groupId(name) { let g = gNames.get(name); if (g === undefined) { g = gFree.length ? gFree.pop() : gHead.length; if (g === gHead.length) gHead.push(-1); else gHead[g] = -1; gNames.set(name, g); W.stats.groups = gNames.size; } return g; }
    W.group = groupId;
    W.groupCount = (name) => { const g = gNames.get(name); if (g === undefined) return 0; let n = 0; for (let i = gHead[g]; i >= 0; i = gnx[i]) n++; return n; };
    W.hasGroup = (name) => gNames.has(name);

    function cellRange(i) { cr0[i] = Math.floor(bx0[i] / CELL); cr1[i] = Math.floor(bx1[i] / CELL); cr2[i] = Math.floor(bz0[i] / CELL); cr3[i] = Math.floor(bz1[i] / CELL); }
    function link(i) {
      cellRange(i); const nx = cr1[i] - cr0[i] + 1, nz = cr3[i] - cr2[i] + 1;
      if (nx * nz > 64 || nFreeE < nx * nz) { if (nBig < BIGCAP) { bigList[nBig++] = i; big[i] = 1; } else W.stats.overflow++; return; }
      big[i] = 0;
      for (let ix = cr0[i]; ix <= cr1[i]; ix++) for (let iz = cr2[i]; iz <= cr3[i]; iz++) { const e = freeE[--nFreeE], h = hsh(ix, iz); entC[e] = i; entN[e] = head[h]; head[h] = e; }
    }
    function unlink(i) {
      if (big[i]) { for (let k = 0; k < nBig; k++) if (bigList[k] === i) { bigList[k] = bigList[--nBig]; break; } big[i] = 0; return; }
      for (let ix = cr0[i]; ix <= cr1[i]; ix++) for (let iz = cr2[i]; iz <= cr3[i]; iz++) {
        const h = hsh(ix, iz); let prev = -1;
        for (let e = head[h]; e >= 0; prev = e, e = entN[e]) if (entC[e] === i) { if (prev < 0) head[h] = entN[e]; else entN[prev] = entN[e]; freeE[nFreeE++] = e; break; }
      }
    }
    function alloc(t, g, m, f) {
      if (!nFreeC) { W.stats.overflow++; return -1; }
      const i = freeC[--nFreeC]; typ[i] = t; mat[i] = matId(m); flg[i] = F_ON | (f || 0); grp[i] = g; hf[i] = null; ud[i] = null; stamp[i] = 0;
      gnx[i] = gHead[g]; gHead[g] = i; const s = W.stats; s.colliders = CAP - nFreeC; if (s.colliders > s.peak) s.peak = s.colliders; W.version++; return i;
    }
    function bounds(i) {
      const t = typ[i];
      if (t === T_BOX) { const ex = abs(cs[i]) * ea[i] + abs(sn[i]) * ec[i], ez = abs(sn[i]) * ea[i] + abs(cs[i]) * ec[i]; bx0[i] = px[i] - ex; bx1[i] = px[i] + ex; bz0[i] = pz[i] - ez; bz1[i] = pz[i] + ez; }
      else if (t === T_HF) { const h = hf[i]; bx0[i] = h.x0; bz0[i] = h.z0; bx1[i] = h.x0 + h.cell * (h.nx - 1); bz1[i] = h.z0 + h.cell * (h.nz - 1); }
      else { bx0[i] = px[i] - ea[i]; bx1[i] = px[i] + ea[i]; bz0[i] = pz[i] - ea[i]; bz1[i] = pz[i] + ea[i]; }
    }
    // y extent (min, max) of a collider
    const yLo = (i) => (typ[i] === T_SPHERE ? py[i] - ea[i] : typ[i] === T_ELLIPSOID ? py[i] - eb[i] : typ[i] === T_HF ? -1e9 : py[i] - eb[i]);
    const yHi = (i) => (typ[i] === T_SPHERE ? py[i] + ea[i] : typ[i] === T_ELLIPSOID ? py[i] + eb[i] : typ[i] === T_HF ? 1e9 : py[i] + eb[i]);
    function fin(i) { bounds(i); link(i); return i; }

    // ── registration
    W.addSphere = (g, x, y, z, r, m, f) => { const i = alloc(T_SPHERE, groupId(g), m, f); if (i < 0) return -1; px[i] = x; py[i] = y; pz[i] = z; ea[i] = r; eb[i] = r; ec[i] = r; return fin(i); };
    W.addEllipsoid = (g, x, y, z, rxz, ry, m, f) => { const i = alloc(T_ELLIPSOID, groupId(g), m, f); if (i < 0) return -1; px[i] = x; py[i] = y; pz[i] = z; ea[i] = rxz; eb[i] = ry; ec[i] = rxz; return fin(i); };
    // vertical cylinder: base y0, top y1, radius r
    W.addCylinder = (g, x, y0, y1, z, r, m, f) => { const i = alloc(T_CYL, groupId(g), m, f); if (i < 0) return -1; px[i] = x; py[i] = (y0 + y1) * 0.5; pz[i] = z; ea[i] = r; eb[i] = (y1 - y0) * 0.5; ec[i] = r; return fin(i); };
    // box: centre, half extents, yaw about +Y (radians)
    W.addBox = (g, x, y, z, hx, hy, hz, yaw, m, f) => { const i = alloc(T_BOX, groupId(g), m, f); if (i < 0) return -1; px[i] = x; py[i] = y; pz[i] = z; ea[i] = hx; eb[i] = hy; ec[i] = hz; cs[i] = Math.cos(yaw || 0); sn[i] = Math.sin(yaw || 0); return fin(i); };
    // heightfield tile: h Float32Array/Array (nx*nz), origin x0,z0, cell size; scale multiplies stored heights, yOff adds. opts.block => also blocks walking sideways
    W.addHeightfield = (g, x0, z0, cell, nx, nz, h, m, opts) => { const i = alloc(T_HF, groupId(g), m, 0); if (i < 0) return -1; hf[i] = { x0, z0, cell, nx, nz, h, scale: (opts && opts.scale) || 1, yOff: (opts && opts.yOff) || 0, block: !!(opts && opts.block) }; return fin(i); };
    W._boxYaw = (i) => Math.atan2(sn[i], cs[i]);
    W.setUser = (i, u) => { ud[i] = u; }; W.getUser = (i) => ud[i];
    W.setSoft = (i, on) => { if (on) flg[i] |= F_SOFT; else flg[i] &= ~F_SOFT; };
    W.isValid = (i) => i >= 0 && i < CAP && (flg[i] & F_ON) !== 0;
    function remove(i) {
      if (!(flg[i] & F_ON)) return; unlink(i); flg[i] = 0; hf[i] = null; ud[i] = null; freeC[nFreeC++] = i; W.stats.colliders = CAP - nFreeC; W.version++;
    }
    W.remove = (i) => { const g = grp[i]; if (!(flg[i] & F_ON)) return; if (gHead[g] === i) gHead[g] = gnx[i]; else for (let k = gHead[g]; k >= 0; k = gnx[k]) if (gnx[k] === i) { gnx[k] = gnx[i]; break; } remove(i); };
    W.clearGroup = (name) => {
      const g = gNames.get(name); if (g === undefined) return 0; let n = 0;
      for (let i = gHead[g]; i >= 0;) { const nx = gnx[i]; remove(i); n++; i = nx; }
      gHead[g] = -1; gNames.delete(name); gFree.push(g); W.stats.groups = gNames.size; return n;
    };
    // move a collider (door, lid, drifting prop): re-hashes only when its cell range changes
    W.move = (i, x, y, z, yaw) => {
      px[i] = x; py[i] = y; pz[i] = z; if (yaw != null && typ[i] === T_BOX) { cs[i] = Math.cos(yaw); sn[i] = Math.sin(yaw); }
      const a = cr0[i], b = cr1[i], c = cr2[i], d = cr3[i]; bounds(i);
      if (Math.floor(bx0[i] / CELL) !== a || Math.floor(bx1[i] / CELL) !== b || Math.floor(bz0[i] / CELL) !== c || Math.floor(bz1[i] / CELL) !== d) { unlinkAt(i, a, b, c, d); link(i); }
    };
    function unlinkAt(i, a, b, c, d) { const s0 = cr0[i], s1 = cr1[i], s2 = cr2[i], s3 = cr3[i]; if (big[i]) { unlink(i); return; } cr0[i] = a; cr1[i] = b; cr2[i] = c; cr3[i] = d; unlink(i); cr0[i] = s0; cr1[i] = s1; cr2[i] = s2; cr3[i] = s3; }

    // ── broadphase
    const Q = new Int32Array(QCAP); let nQ = 0;
    function queryInto(out, cap, x0, z0, x1, z1) {
      const st = ++qStamp; let n = 0; W.stats.queries++;
      const a = Math.floor(x0 / CELL), b = Math.floor(x1 / CELL), c = Math.floor(z0 / CELL), d = Math.floor(z1 / CELL);
      if ((b - a + 1) * (d - c + 1) > 400) { x1 = x0 + CELL * 20; }   // pathological huge query: bounded
      for (let ix = a; ix <= b; ix++) for (let iz = c; iz <= d; iz++) {
        for (let e = head[hsh(ix, iz)]; e >= 0; e = entN[e]) { const i = entC[e]; if (stamp[i] === st) continue; stamp[i] = st; if (bx1[i] < x0 || bx0[i] > x1 || bz1[i] < z0 || bz0[i] > z1) continue; if (n < cap) out[n++] = i; }
      }
      for (let k = 0; k < nBig; k++) { const i = bigList[k]; if (stamp[i] === st) continue; stamp[i] = st; if (bx1[i] < x0 || bx0[i] > x1 || bz1[i] < z0 || bz0[i] > z1) continue; if (n < cap) out[n++] = i; }
      W.stats.cands += n; return n;
    }
    W.query = (x0, z0, x1, z1) => { nQ = queryInto(Q, QCAP, x0, z0, x1, z1); return nQ; };
    W.results = Q;
    W.info = (i) => ({ type: typ[i], mat: MATS[mat[i]], x: px[i], y: py[i], z: pz[i], a: ea[i], b: eb[i], c: ec[i], group: grp[i], flags: flg[i] });

    // ── materials / events
    W.mats = MATS; W.matId = matId; W.fxOf = (m) => FXN[matId(m)];
    const EVN = 192, EV = []; for (let i = 0; i < EVN; i++) EV.push({ type: '', mat: 0, matB: 0, fx: '', x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, speed: 0, a: -1, b: -1, t: 0 });
    let evHead = 0, evCount = 0; const listeners = []; W.time = 0;
    const lastEv = new Float32Array(2048);   // per (kind, key) rate limiter
    function emit(type, m, mb, x, y, z, nx, ny, nz, speed, a, b, key, cool) {
      if (cool) { const k = (key & 2047); if (W.time - lastEv[k] < cool) return; lastEv[k] = W.time; }
      const e = EV[(evHead + evCount) % EVN]; if (evCount < EVN) evCount++; else evHead = (evHead + 1) % EVN;
      e.type = type; e.mat = m; e.matB = mb; e.fx = FXN[m] || ''; e.x = x; e.y = y; e.z = z; e.nx = nx; e.ny = ny; e.nz = nz; e.speed = speed; e.a = a; e.b = b; e.t = W.time;
    }
    W.on = (fn) => { if (listeners.indexOf(fn) < 0) listeners.push(fn); return fn; };
    W.off = (fn) => { const k = listeners.indexOf(fn); if (k >= 0) listeners.splice(k, 1); };
    W.emit = (type, m, x, y, z, speed) => emit(type, matId(m), 0, x, y, z, 0, 1, 0, speed || 0, -1, -1, 0, 0);
    W.flush = () => { let n = 0; while (evCount > 0) { const e = EV[evHead]; evHead = (evHead + 1) % EVN; evCount--; n++; for (let k = 0; k < listeners.length; k++) { try { listeners[k](e); } catch (err) { /* a bad listener never stops physics */ } } } return n; };
    W.pending = () => evCount;

    // ── narrow phase: vertical body (cylinder at x,z radius r over [ylo,yhi]) vs collider i. Returns penetration depth; push in PX/PZ.
    let PX = 0, PZ = 0;
    function bodyPush(i, x, z, r, ylo, yhi) {
      const t = typ[i];
      if (t === T_BOX) {
        if (py[i] + eb[i] <= ylo || py[i] - eb[i] >= yhi) return 0;
        const dx = x - px[i], dz = z - pz[i], c = cs[i], s = sn[i], lx = c * dx + s * dz, lz = -s * dx + c * dz;
        const cx = clamp(lx, -ea[i], ea[i]), cz = clamp(lz, -ec[i], ec[i]), ddx = lx - cx, ddz = lz - cz, d2 = ddx * ddx + ddz * ddz;
        let plx, plz, depth;
        if (d2 > 1e-10) { if (d2 >= r * r) return 0; const d = sqrt(d2); depth = r - d; plx = ddx / d * depth; plz = ddz / d * depth; }
        else {   // centre inside the box: leave through the nearest face
          const gx = ea[i] - abs(lx), gz = ec[i] - abs(lz);
          if (gx < gz) { plx = (lx >= 0 ? 1 : -1) * (gx + r); plz = 0; depth = gx + r; } else { plz = (lz >= 0 ? 1 : -1) * (gz + r); plx = 0; depth = gz + r; }
        }
        PX = c * plx - s * plz; PZ = s * plx + c * plz; return depth;
      }
      if (t === T_HF) {
        const h = hf[i]; if (!h.block) return 0;
        let sx = 0, sz = 0, n = 0;
        for (let k = 0; k < 8; k++) { const a = k * 0.7853982, qx = x + Math.cos(a) * r, qz = z + Math.sin(a) * r; const hh = hfHeight(h, qx, qz); if (hh > ylo && hh < 1e8) { sx -= Math.cos(a); sz -= Math.sin(a); n++; } }
        if (!n) return 0; const l = sqrt(sx * sx + sz * sz) || 1; const dep = r * 0.2 * n / 8 + 0.01; PX = sx / l * dep; PZ = sz / l * dep; return dep;
      }
      let rr;
      if (t === T_CYL) { if (py[i] + eb[i] <= ylo || py[i] - eb[i] >= yhi) return 0; rr = ea[i]; }
      else {   // sphere / ellipsoid: widest cross-section inside the slab
        const b = eb[i], dyc = py[i] < ylo ? ylo - py[i] : py[i] > yhi ? py[i] - yhi : 0; if (dyc >= b) return 0; const k = dyc / b; rr = ea[i] * sqrt(1 - k * k);
      }
      const dx = x - px[i], dz = z - pz[i], d2 = dx * dx + dz * dz, R = rr + r; if (d2 >= R * R) return 0;
      const d = sqrt(d2); if (d < 1e-6) { PX = R; PZ = 0; return R; } const dep = R - d; PX = dx / d * dep; PZ = dz / d * dep; return dep;
    }
    function hfHeight(h, x, z) {
      let fx = (x - h.x0) / h.cell, fz = (z - h.z0) / h.cell; if (fx < 0 || fz < 0 || fx > h.nx - 1 || fz > h.nz - 1) return -1e9;
      let ix = fx | 0, iz = fz | 0; if (ix > h.nx - 2) ix = h.nx - 2; if (iz > h.nz - 2) iz = h.nz - 2; if (ix < 0) ix = 0; if (iz < 0) iz = 0; fx -= ix; fz -= iz;
      const H = h.h, w = h.nx, a = H[iz * w + ix], b = H[iz * w + ix + 1], c = H[(iz + 1) * w + ix], d = H[(iz + 1) * w + ix + 1];
      return ((a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz) * h.scale + h.yOff;
    }
    // top surface of collider i above point (x,z), NaN when the point is outside its footprint
    function topUnder(i, x, z) {
      const t = typ[i], dx = x - px[i], dz = z - pz[i];
      if (t === T_BOX) { const c = cs[i], s = sn[i], lx = c * dx + s * dz, lz = -s * dx + c * dz; return (abs(lx) <= ea[i] && abs(lz) <= ec[i]) ? py[i] + eb[i] : NaN; }
      if (t === T_CYL) return (dx * dx + dz * dz <= ea[i] * ea[i]) ? py[i] + eb[i] : NaN;
      if (t === T_HF) { const v = hfHeight(hf[i], x, z); return v > -1e8 ? v : NaN; }
      const d2 = (dx * dx + dz * dz) / (ea[i] * ea[i]); return d2 <= 1 ? py[i] + eb[i] * sqrt(1 - d2) : NaN;
    }
    function bottomUnder(i, x, z) {   // underside at (x,z) (for passing under bridges / lids)
      const t = typ[i]; if (t === T_BOX || t === T_CYL) return py[i] - eb[i];
      if (t === T_HF) return -1e9; const dx = x - px[i], dz = z - pz[i], d2 = (dx * dx + dz * dz) / (ea[i] * ea[i]); return d2 <= 1 ? py[i] - eb[i] * sqrt(1 - d2) : NaN;
    }

    // highest collider top at (x,z) that is at or below `ceil` (and above `floor`); out: W.lastMat/W.lastId. Walkers pass ceil = feet + step.
    W.lastMat = 0; W.lastId = -1;
    W.topAt = (x, z, ceil, floor, r) => {
      r = r || 0; const n = queryInto(Q2, 256, x - r, z - r, x + r, z + r); let best = -1e9, bi = -1;
      for (let k = 0; k < n; k++) {
        const i = Q2[k]; if (flg[i] & F_ACTOR) continue; let top = topUnder(i, x, z);
        if (top !== top && r > 0) { top = topUnder(i, x + r * 0.6, z); if (top !== top) top = topUnder(i, x - r * 0.6, z); if (top !== top) top = topUnder(i, x, z + r * 0.6); if (top !== top) top = topUnder(i, x, z - r * 0.6); }
        if (top !== top || top > ceil || top < floor) continue; if (top > best) { best = top; bi = i; }
      }
      W.lastId = bi; W.lastMat = bi >= 0 ? mat[bi] : 0; return best;
    };
    const Q2 = new Int32Array(256);
    // "what am I standing on": colliders only (the caller maxes it with its own terrain height)
    W.supportAt = (x, z, feet, step, r) => W.topAt(x, z, feet + (step == null ? 0.6 : step), -1e9, r == null ? 0.35 : r);

    // ── character
    // c: { x,y(feet),z, r, h, step, snap, slope(tan), grounded, id(actor id or -1), vy }
    W.makeChar = (o2) => Object.assign({ x: 0, y: 0, z: 0, r: 0.7, h: 3.2, step: 0.6, snap: 0.5, slope: 1.2, grounded: true, actor: -1, vy: 0, mat: 0, stride: 0, lastX: NaN, lastZ: NaN, blocked: 0, riseUsed: 0, _wet: false, support: -1e9 }, o2 || {});
    const CAND = new Int32Array(256);
    function depenChar(c, cand, n) {
      const ylo = c.y + c.step, yhi = c.y + c.h; let hit = 0;
      for (let it = 0; it < 3; it++) {
        let moved = 0;
        for (let k = 0; k < n; k++) {
          const i = cand[k]; if ((flg[i] & (F_SOFT | F_TRIG)) || i === c.actor) continue;
          if ((flg[i] & F_ACTOR)) continue;
          const d = bodyPush(i, c.x, c.z, c.r, ylo, yhi); if (d > 1e-5) { c.x += PX; c.z += PZ; moved = 1; hit = 1; c.blocked = i + 1; W.stats.pushes++; }
        }
        if (!moved) break;
      }
      return hit;
    }
    // actors vs actor: soft separation (the local character yields by its share; the other actor's share is recorded in W.actorPush)
    function actorSep(c) {
      if (!nAct) return;
      for (let a = 0; a < NA; a++) {
        if (!aOn[a] || a === c.actor) continue; const dx = c.x - ax[a], dz = c.z - az[a], R = c.r + ar[a];
        if (dx * dx + dz * dz >= R * R || c.y > ay[a] + ah[a] || c.y + c.h < ay[a]) continue;
        const d = sqrt(dx * dx + dz * dz) || 1e-4, dep = R - d, w = aKin[a] ? 1 : 0.5; c.x += dx / d * dep * w; c.z += dz / d * dep * w;
        if (!aKin[a]) { apx[a] -= dx / d * dep * (1 - w); apz[a] -= dz / d * dep * (1 - w); } W.stats.pushes++;
        emit('hit', MID.flesh, MID.flesh, c.x, c.y + c.h * 0.5, c.z, dx / d, 0, dz / d, dep, c.actor, a, 3000 + a, 0.25);
      }
    }
    // Move c by (dx,dz) in sub-steps. Returns number of sub-steps. c.x/c.y/c.z updated. c.y rises on step-ups, snaps down on grounded descents.
    W.walk = (c, dx, dz) => {
      const dist = sqrt(dx * dx + dz * dz), r = c.r; c.blocked = 0;
      if (!(dist === dist)) return 0;
      const wasX = c.x, wasZ = c.z;
      if (dist > 60) { c.x += dx; c.z += dz; const n0 = queryInto(CAND, 256, c.x - r, c.z - r, c.x + r, c.z + r); depenChar(c, CAND, n0); settle(c); return 0; }   // teleport: re-seat, no sweep
      const pad = r + c.step + 0.5, n = queryInto(CAND, 256, min(wasX, wasX + dx) - pad, min(wasZ, wasZ + dz) - pad, max(wasX, wasX + dx) + pad, max(wasZ, wasZ + dz) + pad);
      const subMax = max(0.12, min(0.45, r * 0.5)); let ns = Math.ceil(dist / subMax); if (ns < 1) ns = 1; if (ns > 64) ns = 64;
      const sx = dx / ns, sz = dz / ns, budget = c.step + c.slope * dist; c.riseUsed = 0; let k = 0;
      for (; k < ns; k++) {
        const ox = c.x, oz = c.z; c.x += sx; c.z += sz;
        if (n) depenChar(c, CAND, n);
        actorSep(c);
        if (c.grounded && (n || c.ground)) {
          let s = n ? W.topAt(c.x, c.z, c.y + c.step, -1e9, r * 0.5) : -1e9; const gt = c.ground ? c.ground(c.x, c.z) : -1e9; if (gt > s && !(gt > c.y + c.step)) { s = gt; W.lastMat = 0; }
          if (s > c.y + 1e-4) {
            const rise = s - c.y;
            if (c.riseUsed + rise > budget) { c.x = ox; c.z = oz; if (!tryAxis(c, ox, oz, sx, sz, budget)) c.blocked = -1; }
            else { c.riseUsed += rise; c.y = s; c.support = s; c.mat = W.lastMat; }
          } else if (s > -1e8 && c.y - s <= c.snap) { c.y = s; c.support = s; c.mat = W.lastMat; } else c.support = -1e9;
        }
        W.stats.subSteps++;
      }
      // stride events (footsteps): fx tag of whatever she walks on
      const moved = sqrt((c.x - wasX) * (c.x - wasX) + (c.z - wasZ) * (c.z - wasZ));
      if (c.grounded && moved > 0) { c.stride += moved; if (c.stride > (c.strideLen || 2.2)) { c.stride = 0; emit('step', c.mat, 0, c.x, c.y, c.z, 0, 1, 0, moved / (W._dt || 0.016), c.actor, -1, 5000, 0); } }
      if (c.blocked > 0) emit('hit', mat[c.blocked - 1], MID.flesh, c.x, c.y + c.h * 0.5, c.z, 0, 0, 1, dist / (W._dt || 0.016), c.actor, c.blocked - 1, 4000 + (c.blocked & 255), 0.3);
      return k;
    };
    // slide: the substep was refused for climbing too fast — try each axis alone
    function tryAxis(c, ox, oz, sx, sz, budget) {
      for (let a = 0; a < 2; a++) {
        c.x = a ? ox : ox + sx; c.z = a ? oz + sz : oz; if (abs(a ? sz : sx) < 1e-6) continue;
        const s = W.topAt(c.x, c.z, c.y + c.step, -1e9, c.r * 0.5); if (s <= c.y + 1e-4 || c.riseUsed + (s - c.y) <= budget) { if (s > c.y) { c.riseUsed += s - c.y; c.y = s; } return true; }
      }
      c.x = ox; c.z = oz; return false;
    }
    function settle(c) { if (c.grounded) { const s = W.topAt(c.x, c.z, c.y + c.step, -1e9, c.r * 0.5); if (s > -1e8) { c.y = max(c.y, s); c.mat = W.lastMat; } } }
    // push a vertical body (x,y feet,z,r,h) out of all statics, no sweep (camera / board / spawn). out[0],out[1] = dx,dz. returns depth moved
    const POUT = [0, 0];
    W.pushOut = (x, y, z, r, h, step, out) => {
      out = out || POUT; const n = queryInto(Q2, 256, x - r - 0.2, z - r - 0.2, x + r + 0.2, z + r + 0.2); let cx = x, cz = z; const ylo = y + (step || 0), yhi = y + h;
      for (let it = 0; it < 3; it++) { let mv = 0; for (let k = 0; k < n; k++) { const i = Q2[k]; if (flg[i] & (F_ACTOR | F_TRIG)) continue; if (bodyPush(i, cx, cz, r, ylo, yhi) > 1e-5) { cx += PX; cz += PZ; mv = 1; } } if (!mv) break; }
      out[0] = cx - x; out[1] = cz - z; return sqrt(out[0] * out[0] + out[1] * out[1]);
    };

    // ── actors (other players, NPCs, creatures): kinematic vertical capsules the character and bodies collide with
    const ax = new Float32Array(NA), ay = new Float32Array(NA), az = new Float32Array(NA), ar = new Float32Array(NA), ah = new Float32Array(NA), apx = new Float32Array(NA), apz = new Float32Array(NA);
    const aOn = new Uint8Array(NA), aKin = new Uint8Array(NA); let nAct = 0; const aUd = new Array(NA).fill(null);
    W.addActor = (x, y, z, r, h, kinematic, user) => { for (let a = 0; a < NA; a++) if (!aOn[a]) { aOn[a] = 1; aKin[a] = kinematic ? 1 : 0; ax[a] = x; ay[a] = y; az[a] = z; ar[a] = r; ah[a] = h; apx[a] = apz[a] = 0; aUd[a] = user || null; nAct++; W.stats.actors = nAct; return a; } return -1; };
    W.setActor = (a, x, y, z) => { ax[a] = x; ay[a] = y; az[a] = z; };
    W.removeActor = (a) => { if (a >= 0 && aOn[a]) { aOn[a] = 0; aUd[a] = null; nAct--; W.stats.actors = nAct; } };
    W.actorPush = (a, out) => { out[0] = apx[a]; out[1] = apz[a]; apx[a] = apz[a] = 0; return out; };
    W.actorCount = () => nAct;

    // ── dynamic bodies (spheres)
    const bX = new Float32Array(NB), bY = new Float32Array(NB), bZ = new Float32Array(NB), bVX = new Float32Array(NB), bVY = new Float32Array(NB), bVZ = new Float32Array(NB);
    const bR = new Float32Array(NB), bIM = new Float32Array(NB), bMat = new Uint8Array(NB), bOn = new Uint8Array(NB), bSleep = new Float32Array(NB), bWet = new Uint8Array(NB), bAsleep = new Uint8Array(NB), bGrav = new Float32Array(NB), bDamp = new Float32Array(NB);
    const bUd = new Array(NB).fill(null); let nBod = 0, acc = 0;
    W.bodies = { x: bX, y: bY, z: bZ, vx: bVX, vy: bVY, vz: bVZ, r: bR, on: bOn, asleep: bAsleep, ud: bUd, cap: NB };
    W.addBody = (b) => {
      for (let i = 0; i < NB; i++) if (!bOn[i]) {
        bOn[i] = 1; bX[i] = b.x; bY[i] = b.y; bZ[i] = b.z; bVX[i] = b.vx || 0; bVY[i] = b.vy || 0; bVZ[i] = b.vz || 0; bR[i] = b.r || 0.3; bMat[i] = matId(b.mat || 'plastic');
        const m = b.mass != null ? b.mass : (4 / 3 * Math.PI * bR[i] * bR[i] * bR[i] * DENS[bMat[i]]); bIM[i] = m > 0 ? 1 / m : 0; bSleep[i] = 0; bWet[i] = 0; bAsleep[i] = 0; bGrav[i] = b.gravityScale != null ? b.gravityScale : 1; bDamp[i] = b.damping != null ? b.damping : 0.02; bUd[i] = b.user || null;
        nBod++; W.stats.bodies = nBod; return i;
      }
      return -1;
    };
    W.removeBody = (i) => { if (i >= 0 && bOn[i]) { bOn[i] = 0; bUd[i] = null; nBod--; W.stats.bodies = nBod; } };
    W.wake = (i) => { bAsleep[i] = 0; bSleep[i] = 0; };
    W.impulse = (i, jx, jy, jz) => { bVX[i] += jx * bIM[i]; bVY[i] += jy * bIM[i]; bVZ[i] += jz * bIM[i]; bAsleep[i] = 0; bSleep[i] = 0; };
    const FIX = o.fixedDt || 1 / 120, MAXSTEPS = o.maxSteps || 10;
    const DN = new Float32Array(3);
    // sphere (x,y,z,r) vs collider i → penetration depth; normal in DN (points from collider to sphere)
    function spherePen(i, x, y, z, r) {
      const t = typ[i], dx = x - px[i], dy = y - py[i], dz = z - pz[i];
      if (t === T_SPHERE || t === T_ELLIPSOID) {
        const b = t === T_SPHERE ? ea[i] : eb[i], a = ea[i], qx = dx / a, qy = dy / b, qz = dz / a, q = sqrt(qx * qx + qy * qy + qz * qz), d = sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) { DN[0] = 0; DN[1] = 1; DN[2] = 0; return a + r; }
        if (q > 1 + (r + 0.01) / min(a, b)) return 0;
        const surf = q > 1e-6 ? d / q : 0, pen = r - (d - surf); if (pen <= 0) return 0;
        // gradient of the ellipsoid as the normal
        let gx = qx / a, gy = qy / b, gz = qz / a, gl = sqrt(gx * gx + gy * gy + gz * gz) || 1; if (q < 1) { gx = dx; gy = dy; gz = dz; gl = d; }
        DN[0] = gx / gl; DN[1] = gy / gl; DN[2] = gz / gl; return pen;
      }
      let cx, cy, cz;   // closest point on the solid
      if (t === T_CYL) {
        const dxz = sqrt(dx * dx + dz * dz), y0 = py[i] - eb[i], y1 = py[i] + eb[i], inR = dxz <= ea[i], inY = y >= y0 && y <= y1;
        if (inR && inY) {   // centre inside: exit through the nearest face
          const gR = ea[i] - dxz, gT = y1 - y, gB = y - y0; if (gR <= gT && gR <= gB) { const l = dxz || 1; DN[0] = dxz ? dx / l : 1; DN[1] = 0; DN[2] = dxz ? dz / l : 0; return gR + r; } if (gT < gB) { DN[0] = 0; DN[1] = 1; DN[2] = 0; return gT + r; } DN[0] = 0; DN[1] = -1; DN[2] = 0; return gB + r;
        }
        const k = dxz > ea[i] ? ea[i] / dxz : 1; cx = px[i] + dx * k; cz = pz[i] + dz * k; cy = clamp(y, y0, y1);
      } else if (t === T_BOX) {
        const c = cs[i], s = sn[i], lx = c * dx + s * dz, lz = -s * dx + c * dz, ly = dy;
        const qx = clamp(lx, -ea[i], ea[i]), qy = clamp(ly, -eb[i], eb[i]), qz = clamp(lz, -ec[i], ec[i]);
        if (qx === lx && qy === ly && qz === lz) {   // inside
          const gx = ea[i] - abs(lx), gy = eb[i] - abs(ly), gz = ec[i] - abs(lz); let nlx = 0, nly = 0, nlz = 0, dep;
          if (gx <= gy && gx <= gz) { nlx = lx >= 0 ? 1 : -1; dep = gx; } else if (gy <= gz) { nly = ly >= 0 ? 1 : -1; dep = gy; } else { nlz = lz >= 0 ? 1 : -1; dep = gz; }
          DN[0] = c * nlx - s * nlz; DN[1] = nly; DN[2] = s * nlx + c * nlz; return dep + r;
        }
        cx = px[i] + c * qx - s * qz; cy = py[i] + qy; cz = pz[i] + s * qx + c * qz;
      } else if (t === T_HF) {
        const h = hf[i], g = hfHeight(h, x, z); if (g < -1e8 || y - r > g) return 0; const e = h.cell * 0.5, gx = hfHeight(h, x + e, z) - hfHeight(h, x - e, z), gz = hfHeight(h, x, z + e) - hfHeight(h, x, z - e), l = sqrt(gx * gx + 4 * e * e + gz * gz);
        DN[0] = -gx / l; DN[1] = 2 * e / l; DN[2] = -gz / l; return g + r * 1 - y;
      } else return 0;
      const ex = x - cx, ey = y - cy, ez = z - cz, d2 = ex * ex + ey * ey + ez * ez; if (d2 >= r * r) return 0; const d = sqrt(d2) || 1e-6; DN[0] = ex / d; DN[1] = ey / d; DN[2] = ez / d; return r - d;
    }
    function respond(b, nx, ny, nz, pen, rest2, fric2) {
      bX[b] += nx * pen; bY[b] += ny * pen; bZ[b] += nz * pen;
      const vn = bVX[b] * nx + bVY[b] * ny + bVZ[b] * nz; if (vn >= 0) return 0;
      const e = sqrt(REST[bMat[b]] * rest2) * (-vn > 1.2 ? 1 : 0), j = -(1 + e) * vn;
      bVX[b] += nx * j; bVY[b] += ny * j; bVZ[b] += nz * j;
      const tx = bVX[b] - (bVX[b] * nx + bVY[b] * ny + bVZ[b] * nz) * nx, ty = bVY[b] - (bVX[b] * nx + bVY[b] * ny + bVZ[b] * nz) * ny, tz = bVZ[b] - (bVX[b] * nx + bVY[b] * ny + bVZ[b] * nz) * nz, tl = sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-6) { const mu = sqrt(FRIC[bMat[b]] * fric2), dv = min(tl, mu * j); bVX[b] -= tx / tl * dv; bVY[b] -= ty / tl * dv; bVZ[b] -= tz / tl * dv; }
      return -vn;
    }
    function stepBodies(h) {
      const g = W.gravity, wf = W.water, gf = W.ground;
      for (let b = 0; b < NB; b++) {
        if (!bOn[b] || bAsleep[b]) continue; const r = bR[b];
        bVY[b] -= g * bGrav[b] * h;
        // water: buoyancy from the submerged fraction, drag, splash on entry / exit
        let wet = 0;
        if (wf) { const ws = wf(bX[b], bZ[b]); if (ws === ws && ws > -1e8) { const depth = ws - (bY[b] - r); wet = clamp(depth / (2 * r), 0, 1);
          if (wet > 0) { const rho = DENS[bMat[b]], buoy = g * bGrav[b] * (1000 / max(60, rho)) * wet; bVY[b] += buoy * h; const dr = 1 - min(0.9, (2.5 + 4 * wet) * h * wet); bVX[b] *= dr; bVY[b] *= dr; bVZ[b] *= dr; }
          if (wet > 0 && !bWet[b]) { const sp = abs(bVY[b]) + sqrt(bVX[b] * bVX[b] + bVZ[b] * bVZ[b]) * 0.5; emit('splash', MID.water, bMat[b], bX[b], ws, bZ[b], 0, 1, 0, sp, b, -1, 100 + b, 0.12); bWet[b] = 1; }
          else if (wet === 0 && bWet[b]) { bWet[b] = 0; emit('exit', MID.water, bMat[b], bX[b], ws, bZ[b], 0, 1, 0, abs(bVY[b]), b, -1, 200 + b, 0.2); } } }
        const damp = 1 - bDamp[b] * h; bVX[b] *= damp; bVY[b] *= damp; bVZ[b] *= damp;
        let spd = sqrt(bVX[b] * bVX[b] + bVY[b] * bVY[b] + bVZ[b] * bVZ[b]); let ns = Math.ceil(spd * h / (r * 0.5)); if (ns < 1) ns = 1; if (ns > 8) ns = 8; const hh = h / ns;
        for (let s = 0; s < ns; s++) {
          bX[b] += bVX[b] * hh; bY[b] += bVY[b] * hh; bZ[b] += bVZ[b] * hh; W.stats.bodySteps++;
          const n = queryInto(Q2, 256, bX[b] - r, bZ[b] - r, bX[b] + r, bZ[b] + r); let touch = 0;
          for (let k = 0; k < n; k++) {
            const i = Q2[k]; if (flg[i] & F_TRIG) continue; if (bY[b] - r > yHi(i) || bY[b] + r < yLo(i)) continue;
            const pen = spherePen(i, bX[b], bY[b], bZ[b], r); if (pen <= 0) continue;
            const nx = DN[0], ny = DN[1], nz = DN[2], sp = respond(b, nx, ny, nz, pen, REST[mat[i]], FRIC[mat[i]]); touch = 1;
            if (sp > 1.0) emit('impact', mat[i], bMat[b], bX[b] - nx * r, bY[b] - ny * r, bZ[b] - nz * r, nx, ny, nz, sp, b, i, 300 + (i & 511), 0.07);
            else { const tv = sqrt(bVX[b] * bVX[b] + bVZ[b] * bVZ[b]); if (tv > 1.5) emit('scrape', mat[i], bMat[b], bX[b] - nx * r, bY[b] - ny * r, bZ[b] - nz * r, nx, ny, nz, tv, b, i, 900 + b, 0.12); }
          }
          if (gf) {   // the terrain
            const gy = gf(bX[b], bZ[b]);
            if (gy === gy && bY[b] - r < gy) {
              const e = 0.4, hx = gf(bX[b] + e, bZ[b]) - gf(bX[b] - e, bZ[b]), hz = gf(bX[b], bZ[b] + e) - gf(bX[b], bZ[b] - e), l = sqrt(hx * hx + 4 * e * e + hz * hz);
              const sp = respond(b, -hx / l, 2 * e / l, -hz / l, gy + r - bY[b], REST[0], FRIC[0]); touch = 1;
              if (sp > 1.0) emit('impact', 0, bMat[b], bX[b], gy, bZ[b], -hx / l, 2 * e / l, -hz / l, sp, b, -1, 700 + b, 0.07);
              else { const tv = sqrt(bVX[b] * bVX[b] + bVZ[b] * bVZ[b]); if (tv > 1.5) emit('scrape', 0, bMat[b], bX[b], gy, bZ[b], 0, 1, 0, tv, b, -1, 800 + b, 0.12); }
            }
          }
          // actors
          if (nAct) for (let a = 0; a < NA; a++) if (aOn[a]) {
            const dx = bX[b] - ax[a], dz = bZ[b] - az[a], R = r + ar[a]; if (dx * dx + dz * dz >= R * R || bY[b] + r < ay[a] || bY[b] - r > ay[a] + ah[a]) continue;
            const d = sqrt(dx * dx + dz * dz) || 1e-4, nx = dx / d, nz = dz / d, sp = respond(b, nx, 0, nz, R - d, REST[MID.flesh], FRIC[MID.flesh]);
            if (sp > 0.5) { emit('hit', MID.flesh, bMat[b], bX[b] - nx * r, bY[b], bZ[b] - nz * r, nx, 0, nz, sp, b, a, 1100 + a, 0.1); if (!aKin[a]) { apx[a] -= nx * sp / (bIM[b] ? 1 : 1) * bIM[b] * 0.2; apz[a] -= nz * sp * bIM[b] * 0.2; } }
          }
          spd = sqrt(bVX[b] * bVX[b] + bVY[b] * bVY[b] + bVZ[b] * bVZ[b]); if (touch && s === ns - 1) { bSleep[b] = spd < 0.12 ? bSleep[b] + hh : 0; }
        }
        if (bSleep[b] > 0.6) { bAsleep[b] = 1; bVX[b] = bVY[b] = bVZ[b] = 0; }
      }
      // body vs body
      for (let a = 0; a < NB; a++) { if (!bOn[a]) continue; for (let b = a + 1; b < NB; b++) {
        if (!bOn[b]) continue; const dx = bX[b] - bX[a], R = bR[a] + bR[b]; if (dx > R || dx < -R) continue; const dz = bZ[b] - bZ[a]; if (dz > R || dz < -R) continue; const dy = bY[b] - bY[a]; const d2 = dx * dx + dy * dy + dz * dz; if (d2 >= R * R) continue;
        if (bAsleep[a] && bAsleep[b]) continue; const d = sqrt(d2) || 1e-5, nx = dx / d, ny = dy / d, nz = dz / d, im = bIM[a] + bIM[b]; if (im <= 0) continue; const pen = R - d;
        bX[a] -= nx * pen * bIM[a] / im; bY[a] -= ny * pen * bIM[a] / im; bZ[a] -= nz * pen * bIM[a] / im; bX[b] += nx * pen * bIM[b] / im; bY[b] += ny * pen * bIM[b] / im; bZ[b] += nz * pen * bIM[b] / im;
        const vn = (bVX[b] - bVX[a]) * nx + (bVY[b] - bVY[a]) * ny + (bVZ[b] - bVZ[a]) * nz; if (vn >= 0) continue; const e = sqrt(REST[bMat[a]] * REST[bMat[b]]) * (-vn > 1.2 ? 1 : 0), j = -(1 + e) * vn / im;
        bVX[a] -= nx * j * bIM[a]; bVY[a] -= ny * j * bIM[a]; bVZ[a] -= nz * j * bIM[a]; bVX[b] += nx * j * bIM[b]; bVY[b] += ny * j * bIM[b]; bVZ[b] += nz * j * bIM[b]; bAsleep[a] = bAsleep[b] = 0; bSleep[a] = bSleep[b] = 0;
        if (-vn > 1.0) emit('impact', bMat[a], bMat[b], bX[a] + nx * bR[a], bY[a] + ny * bR[a], bZ[a] + nz * bR[a], nx, ny, nz, -vn, a, b + 1000, 1300 + a * 7 + b, 0.07);
      } }
    }
    // advance dynamic bodies by a frame time (fixed sub-steps; a 15 fps frame = 8 sub-steps of 1/120)
    W.step = (dt) => {
      W._dt = dt > 1e-4 ? dt : 0.016; const t0 = (root.performance || Date).now(); W.time += dt;
      if (nBod) { acc += min(dt, FIX * MAXSTEPS); let n = 0; while (acc >= FIX && n < MAXSTEPS) { stepBodies(FIX); acc -= FIX; n++; } if (n === MAXSTEPS) acc = 0; }
      W.flush(); W.stats.ms = (root.performance || Date).now() - t0;
    };
    // wake sleeping bodies near a moving character / actor
    W.wakeNear = (x, z, r) => { for (let b = 0; b < NB; b++) if (bOn[b] && bAsleep[b]) { const dx = bX[b] - x, dz = bZ[b] - z; if (dx * dx + dz * dz < r * r) { bAsleep[b] = 0; bSleep[b] = 0; } } };

    // swept sphere through statics: first hit along p0→p1 (marching at r/2). Fills W.hit {t,x,y,z,nx,ny,nz,id,mat}. Used for the board in flight, projectiles.
    W.hit = { t: 1, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, id: -1, mat: 0 };
    W.sweepSphere = (x0, y0, z0, x1, y1, z1, r) => {
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L = sqrt(dx * dx + dy * dy + dz * dz), H = W.hit; H.t = 1; H.id = -1;
      let ns = Math.ceil(L / max(0.05, r * 0.5)); if (ns < 1) ns = 1; if (ns > 256) ns = 256;
      const n = queryInto(Q2, 256, min(x0, x1) - r, min(z0, z1) - r, max(x0, x1) + r, max(z0, z1) + r); if (!n) return false;
      for (let s = 0; s <= ns; s++) {
        const t = s / ns, x = x0 + dx * t, y = y0 + dy * t, z = z0 + dz * t;
        for (let k = 0; k < n; k++) { const i = Q2[k]; if (flg[i] & (F_TRIG | F_ACTOR)) continue; if (y - r > yHi(i) || y + r < yLo(i)) continue; const pen = spherePen(i, x, y, z, r); if (pen > 0) { H.t = t; H.x = x + DN[0] * pen; H.y = y + DN[1] * pen; H.z = z + DN[2] * pen; H.nx = DN[0]; H.ny = DN[1]; H.nz = DN[2]; H.id = i; H.mat = mat[i]; return true; } }
      }
      return false;
    };
    // ray vs statics (marching, coarse): returns distance or -1. For camera / line-of-sight probes against props.
    W.raycast = (ox, oy, oz, dx, dy, dz, maxD, r) => {
      r = r || 0.05; const stp = max(0.1, r), ns = Math.min(512, Math.ceil(maxD / stp)); const n = queryInto(Q2, 256, min(ox, ox + dx * maxD) - r, min(oz, oz + dz * maxD) - r, max(ox, ox + dx * maxD) + r, max(oz, oz + dz * maxD) + r); if (!n) return -1;
      for (let s = 0; s <= ns; s++) { const d = s * maxD / ns, x = ox + dx * d, y = oy + dy * d, z = oz + dz * d; for (let k = 0; k < n; k++) { const i = Q2[k]; if (flg[i] & (F_TRIG | F_ACTOR | F_SOFT)) continue; if (y - r > yHi(i) || y + r < yLo(i)) continue; if (spherePen(i, x, y, z, r) > 0) { W.hit.id = i; W.hit.mat = mat[i]; return d; } } }
      return -1;
    };

    // ── generation helpers ────────────────────────────────────────────────────────────────────────────────────────
    // Deterministic de-overlap of scattered discs (rocks / trunks): no RNG, in place, O(n^2) over one chunk. xs/zs/rs are arrays; n entries; `fixed[i]` (optional)
    // marks entries that do not move. Everything is also kept inside [x0,x1]x[z0,z1] (a chunk never leaks a prop into its neighbour, so chunks never overlap each other).
    // Returns the number of entries it could not separate (callers drop those). Smaller discs move; ties move the later one.
    W.relaxDiscs = (xs, zs, rs, n, x0, x1, z0, z1, gap, iters, bad) => {
      gap = gap || 0; iters = iters || 6; let left = 0;
      for (let i = 0; i < n; i++) { xs[i] = clamp(xs[i], x0 + rs[i], x1 - rs[i]); zs[i] = clamp(zs[i], z0 + rs[i], z1 - rs[i]); if (bad) bad[i] = 0; }
      for (let it = 0; it < iters; it++) {
        let any = 0;
        for (let i = 0; i < n; i++) { if (bad && bad[i]) continue; for (let j = i + 1; j < n; j++) {
          if (bad && bad[j]) continue; const dx = xs[j] - xs[i], dz = zs[j] - zs[i], R = rs[i] + rs[j] + gap; if (dx > R || dx < -R || dz > R || dz < -R) continue; const d2 = dx * dx + dz * dz; if (d2 >= R * R) continue;
          any = 1; const d = sqrt(d2); let ux, uz; if (d < 1e-5) { ux = Math.cos((i * 31 + j) * 2.399963); uz = Math.sin((i * 31 + j) * 2.399963); } else { ux = dx / d; uz = dz / d; }
          const pen = R - d, wi = rs[i] >= rs[j] ? 0.15 : 0.85, wj = 1 - wi;   // the smaller one gives way
          xs[i] -= ux * pen * wi; zs[i] -= uz * pen * wi; xs[j] += ux * pen * wj; zs[j] += uz * pen * wj;
          xs[i] = clamp(xs[i], x0 + rs[i], x1 - rs[i]); zs[i] = clamp(zs[i], z0 + rs[i], z1 - rs[i]); xs[j] = clamp(xs[j], x0 + rs[j], x1 - rs[j]); zs[j] = clamp(zs[j], z0 + rs[j], z1 - rs[j]);
        } }
        if (!any) break;
      }
      // anything still overlapping is flagged (not moved again)
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const dx = xs[j] - xs[i], dz = zs[j] - zs[i], R = rs[i] + rs[j] + gap * 0.5; if (dx * dx + dz * dz < R * R * 0.98) { if (bad) { const k = rs[i] >= rs[j] ? j : i; if (!bad[k]) { bad[k] = 1; left++; } } else left++; } }
      return left;
    };
    // Move discs (xs,zs,rs; n) clear of FIXED discs (fx,fz,fr; m) by pushing radially outward; clamps to the chunk box. Returns how many are still overlapping (flag them / drop them).
    W.pushDiscsFrom = (xs, zs, rs, n, fx, fz, fr, m, gap, x0, x1, z0, z1, bad) => {
      gap = gap || 0; let left = 0;
      for (let i = 0; i < n; i++) {
        if (bad && bad[i]) continue;
        for (let it = 0; it < 4; it++) { let any = 0;
          for (let j = 0; j < m; j++) { const dx = xs[i] - fx[j], dz = zs[i] - fz[j], R = rs[i] + fr[j] + gap; if (dx > R || dx < -R || dz > R || dz < -R) continue; const d2 = dx * dx + dz * dz; if (d2 >= R * R) continue; any = 1;
            const d = sqrt(d2); let ux, uz; if (d < 1e-5) { ux = Math.cos(j * 2.399963); uz = Math.sin(j * 2.399963); } else { ux = dx / d; uz = dz / d; } xs[i] = fx[j] + ux * R; zs[i] = fz[j] + uz * R; }
          xs[i] = clamp(xs[i], x0 + rs[i], x1 - rs[i]); zs[i] = clamp(zs[i], z0 + rs[i], z1 - rs[i]); if (!any) break; }
        for (let j = 0; j < m; j++) { const dx = xs[i] - fx[j], dz = zs[i] - fz[j], R = rs[i] + fr[j] + gap * 0.5; if (dx * dx + dz * dz < R * R * 0.98) { if (bad) bad[i] = 1; left++; break; } }
      }
      return left;
    };
    // register an instanced mesh's transforms as colliders in time-sliced steps. Generator: yields every `per` instances.
    // spec: { kind:'ellipsoid'|'sphere'|'cyl'|'box', mat, k (radius factor on scale), ky, y0f, y1f (cyl: base/top as fraction of scale.y about the centre), soft }
    // M = Float32Array of instance matrices (column-major 16 floats each), count = real instances (zero-scale padding is skipped).
    W.fromInstancedGen = function* (name, M, count, spec, per) {
      per = per || 48; const k = spec.k || 1, ky = spec.ky || k, soft = spec.soft ? F_SOFT : 0; let nReg = 0;
      for (let n = 0; n < count; n++) {
        if (n % per === per - 1) yield nReg; const o = n * 16;
        const sx = sqrt(M[o] * M[o] + M[o + 1] * M[o + 1] + M[o + 2] * M[o + 2]), sy = sqrt(M[o + 4] * M[o + 4] + M[o + 5] * M[o + 5] + M[o + 6] * M[o + 6]), sz = sqrt(M[o + 8] * M[o + 8] + M[o + 9] * M[o + 9] + M[o + 10] * M[o + 10]);
        if (sx < 1e-4 || sy < 1e-4) continue; const x = M[o + 12], y = M[o + 13], z = M[o + 14]; let id;
        if (spec.kind === 'sphere') id = W.addSphere(name, x, y, z, max(sx, sz) * k, spec.mat, soft);
        else if (spec.kind === 'cyl') { const rr = max(sx, sz) * k, hy = sy * (spec.hy || 0.5); id = W.addCylinder(name, x - 0 + 0, y - hy + (spec.yShift || 0) * sy, y + hy + (spec.yShift || 0) * sy, z, rr, spec.mat, soft); }
        else if (spec.kind === 'box') { const yaw = Math.atan2(-M[o + 8], M[o]); id = W.addBox(name, x, y, z, sx * k, sy * ky, sz * k, yaw, spec.mat, soft); }
        else id = W.addEllipsoid(name, x, y, z, max(sx, sz) * k, sy * ky, spec.mat, soft);
        if (id >= 0) nReg++;
      }
      return nReg;
    };
    // register the world-space bounds of every mesh under a THREE.Object3D (non-instanced props, GLB structures): yaw-OBB boxes from each mesh's local bounding box
    // and world matrix, thin tall things as cylinders. opts: { mat, soft, minSize, maxMeshes, filter(mesh)->bool, glass(mesh)->bool }. Generator (yield every `per` meshes).
    W.fromObjectGen = function* (name, obj, opts, per) {
      opts = opts || {}; per = per || 8; obj.updateMatrixWorld(true); let n = 0, reg = 0; const e = new Float64Array(16); const meshes = []; obj.traverse(m => { if (m.isMesh && m.geometry && !m.isInstancedMesh && !(m.userData && m.userData.noCollide)) meshes.push(m); });
      for (const m of meshes) {
        if (++n % per === 0) yield reg; if (opts.filter && !opts.filter(m)) continue; if (reg >= (opts.maxMeshes || 400)) break;
        const g = m.geometry; if (!g.boundingBox) g.computeBoundingBox(); const bb = g.boundingBox; if (!bb || bb.isEmpty()) continue; const me = m.matrixWorld.elements; for (let i = 0; i < 16; i++) e[i] = me[i];
        const sx = sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]), sy = sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]), sz = sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
        const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2, hx = (bb.max.x - bb.min.x) / 2 * sx, hy = (bb.max.y - bb.min.y) / 2 * sy, hz = (bb.max.z - bb.min.z) / 2 * sz;
        if (max(hx, hz) < (opts.minSize || 0.12) && hy < (opts.minSize || 0.12)) continue;
        const wx = e[0] * cx + e[4] * cy + e[8] * cz + e[12], wy = e[1] * cx + e[5] * cy + e[9] * cz + e[13], wz = e[2] * cx + e[6] * cy + e[10] * cz + e[14], yaw = Math.atan2(-e[8], e[0]);
        const isGlass = opts.glass ? opts.glass(m) : false, mt = isGlass ? 'glass' : (opts.matOf ? opts.matOf(m) : (opts.mat || 'stone')), fl = opts.soft ? F_SOFT : 0;
        const id = (hy > 3 * max(hx, hz) && abs(hx - hz) < 0.3 * max(hx, hz) && max(hx, hz) < 2) ? W.addCylinder(name, wx, wy - hy, wy + hy, wz, max(hx, hz), mt, fl) : W.addBox(name, wx, wy, wz, hx, hy, hz, yaw, mt, fl);
        if (id >= 0) reg++;
      }
      return reg;
    };
    W.runGen = (it) => { let r; do { r = it.next(); } while (!r.done); return r.value; };   // finish a generator at once (tests, small props)

    // ── terrain / water hooks (set by the game)
    W.setGround = (fn) => { W.ground = fn; }; W.setWater = (fn) => { W.water = fn; };
    W.reset = () => { for (const name of Array.from(gNames.keys())) W.clearGroup(name); for (let b = 0; b < NB; b++) if (bOn[b]) W.removeBody(b); for (let a = 0; a < NA; a++) if (aOn[a]) W.removeActor(a); evCount = 0; };
    W.count = () => CAP - nFreeC;
    W._raw = { typ, mat, flg, px, py, pz, ea, eb, ec, bx0, bx1, bz0, bz1, hf };
    return W;
  }

  // ── debug view (?collider=1): wireframes of the colliders near the player, one preallocated LineSegments, rebuilt when the player moves / the set changes
  function attachDebug(W, THREE, scene, opts) {
    opts = opts || {}; const MAXV = opts.maxVerts || 90000, R = opts.radius || 90;
    const pos = new Float32Array(MAXV * 3), col = new Float32Array(MAXV * 3), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 });
    const mesh = new THREE.LineSegments(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 999; mesh.name = 'DMCollide_debug'; mesh.userData.noBend = true; mesh.raycast = () => { };
    scene.add(mesh);
    const COL = { ground: [0.6, 0.5, 0.3], rock: [0.9, 0.9, 0.9], wood: [0.9, 0.6, 0.2], metal: [0.4, 0.8, 1], glass: [0.3, 1, 1], foliage: [0.3, 1, 0.3], water: [0.2, 0.4, 1], fabric: [1, 0.5, 0.8], flesh: [1, 0.3, 0.3], stone: [0.8, 0.8, 0.6], plastic: [1, 1, 0.3] };
    let n = 0, lx = 1e9, lz = 1e9, lv = -1, tAcc = 9;
    const R_ = W._raw;
    function seg(a, b, c, d, e, f, rgb) { if (n + 2 > MAXV) return; let o = n * 3; pos[o] = a; pos[o + 1] = b; pos[o + 2] = c; pos[o + 3] = d; pos[o + 4] = e; pos[o + 5] = f; col[o] = rgb[0]; col[o + 1] = rgb[1]; col[o + 2] = rgb[2]; col[o + 3] = rgb[0]; col[o + 4] = rgb[1]; col[o + 5] = rgb[2]; n += 2; }
    function ring(cx, cy, cz, rx, rz, plane, rgb, yaw) {   // plane 0: XZ, 1: XY, 2: ZY
      const N = 14; let px_, py_, pz_;
      for (let k = 0; k <= N; k++) { const a = k / N * 6.2831853, c = Math.cos(a), s = Math.sin(a); let x = cx, y = cy, z = cz; if (plane === 0) { x += c * rx; z += s * rz; } else if (plane === 1) { x += c * rx; y += s * rz; } else { z += c * rx; y += s * rz; } if (k) seg(px_, py_, pz_, x, y, z, rgb); px_ = x; py_ = y; pz_ = z; }
    }
    function draw(i) {
      const t = R_.typ[i], c = COL[W.mats[R_.mat[i]]] || COL.rock, x = R_.px[i], y = R_.py[i], z = R_.pz[i], a = R_.ea[i], b = R_.eb[i], cc = R_.ec[i], soft = (R_.flg[i] & 2) ? [c[0] * 0.5, c[1] * 0.5 + 0.3, c[2] * 0.5] : c;
      if (t === 1 || t === 2) { ring(x, y, z, a, a, 0, soft); ring(x, y, z, a, t === 1 ? a : b, 1, soft); ring(x, y, z, a, t === 1 ? a : b, 2, soft); }
      else if (t === 3) { ring(x, y - b, z, a, a, 0, soft); ring(x, y + b, z, a, a, 0, soft); for (let k = 0; k < 4; k++) { const q = k * 1.5707963; seg(x + Math.cos(q) * a, y - b, z + Math.sin(q) * a, x + Math.cos(q) * a, y + b, z + Math.sin(q) * a, soft); } }
    }
    function drawBox(i, rgb) {
      const info = W.info(i); const e = W._boxYaw(i), c = Math.cos(e), s = Math.sin(e), hx = info.a, hy = info.b, hz = info.c;
      const P = []; for (let k = 0; k < 8; k++) { const sx = (k & 1) ? 1 : -1, sy = (k & 2) ? 1 : -1, sz = (k & 4) ? 1 : -1, lx = sx * hx, lz = sz * hz; P.push([info.x + c * lx - s * lz, info.y + sy * hy, info.z + s * lx + c * lz]); }
      const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]; for (const [p, q] of E) seg(P[p][0], P[p][1], P[p][2], P[q][0], P[q][1], P[q][2], rgb);
    }
    const dbg = {
      mesh, enabled: true, count: () => n / 2,
      update(dt, fx, fz) {
        tAcc += dt; if (!mesh.visible) return; if (tAcc < 0.25 && W.version === lv && Math.abs(fx - lx) < 6 && Math.abs(fz - lz) < 6) return; tAcc = 0; lx = fx; lz = fz; lv = W.version; n = 0;
        const m = W.query(fx - R, fz - R, fx + R, fz + R), ids = new Int32Array(Math.min(m, 700)); for (let k = 0; k < ids.length; k++) ids[k] = W.results[k];
        for (let k = 0; k < ids.length; k++) { const i = ids[k], t = R_.typ[i]; if (t === 4) drawBox(i, COL[W.mats[R_.mat[i]]] || COL.stone); else if (t === 5) { const h = R_.hf[i]; const x0 = h.x0, z0 = h.z0, x1 = x0 + h.cell * (h.nx - 1), z1 = z0 + h.cell * (h.nz - 1), y = h.yOff; seg(x0, y, z0, x1, y, z0, COL.ground); seg(x1, y, z0, x1, y, z1, COL.ground); seg(x1, y, z1, x0, y, z1, COL.ground); seg(x0, y, z1, x0, y, z0, COL.ground); } else draw(i); }
        const B = W.bodies; for (let b = 0; b < B.cap; b++) if (B.on[b]) { ring(B.x[b], B.y[b], B.z[b], B.r[b], B.r[b], 0, B.asleep[b] ? [0.5, 0.5, 0.5] : [1, 0.2, 1]); ring(B.x[b], B.y[b], B.z[b], B.r[b], B.r[b], 1, [1, 0.2, 1]); }
        geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; geo.setDrawRange(0, n);
      },
      dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); }
    };
    return dbg;
  }

  const API = { create, attachDebug, MATS, MP, T_SPHERE, T_ELLIPSOID, T_CYL, T_BOX, T_HF };
  root.DMCollideLib = API;
})(typeof window !== 'undefined' ? window : globalThis);
