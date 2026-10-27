// dm-localcollide.js — adaptive local collision tessellation.
// Coarse collision surfaces (big terrain / deck / building faces) are resampled into a fine height patch only
// around Ariel + her board, at a cell size tied to the board's (or her foot's) own size, so contact follows the
// real surface. The patch is cached and only rebuilt when the target leaves its inner region; rebuilds while the
// old patch still covers the target are amortized over frames (opts.budget samples per frame, into a back buffer
// that swaps in when complete). All buffers are allocated once. Render geometry is never touched.
// opts: n (cells/side), cell, sample(x,z,yHint)->y|NaN, budget (samples/frame for amortized rebuilds),
//       yTol (rebuild when the query height moves this far: other floor/deck), frame (Object3D: patch lives in
//       its local frame; lift() converts, and scales the answer back to world for a uniform-scale frame).
(function () {
  'use strict';
  function create(THREE, opts) {
    opts = opts || {};
    const n = Math.max(4, opts.n | 0 || 12), r = n + 1, N = r * r;
    const P = { n, cell: opts.cell || 0.25, sample: opts.sample, budget: opts.budget | 0, yTol: opts.yTol || 0, frame: opts.frame || null,
      cx: NaN, cz: NaN, cy: 0, h: new Float32Array(N), bk: new Float32Array(N), bx: NaN, bz: NaN, by: 0, bcell: 0, bi: -1,
      pts: null, np: 0, owner: null, v: new THREE.Vector3(), m: new THREE.Matrix4(), mi: new THREE.Matrix4(), b: new THREE.Box3(), rebuilds: 0, samples: 0 };
    const fill = (H, x0, z0, c, y, i0, i1) => { for (let k = i0; k < i1; k++) { const v = P.sample(x0 + (k % r) * c, z0 + ((k / r) | 0) * c, y); H[k] = v === v ? v : -1e9; } P.samples += i1 - i0; };
    P.invalidate = () => { P.cx = NaN; P.bi = -1; };
    P.setCell = (c) => { if (c > 1e-4 && Math.abs(c - P.cell) > P.cell * 0.02) { P.cell = c; P.invalidate(); } };
    P.ensure = (x, z, y) => {
      y = y || 0; const half = P.cell * n * 0.5, valid = P.cx === P.cx && !(P.yTol && Math.abs(y - P.cy) > P.yTol);
      const dx = Math.abs(x - P.cx), dz = Math.abs(z - P.cz);
      if (valid && dx < half * 0.5 && dz < half * 0.5) { P.bi = -1; return; }
      if (valid && P.budget > 0 && dx < half * 0.85 && dz < half * 0.85) {        // still covered: amortize
        if (P.bi < 0 || P.bcell !== P.cell) { P.bx = x; P.bz = z; P.by = y; P.bcell = P.cell; P.bi = 0; }
        const e = Math.min(N, P.bi + P.budget); fill(P.bk, P.bx - half, P.bz - half, P.cell, P.by, P.bi, e); P.bi = e;
        if (e >= N) { const t = P.h; P.h = P.bk; P.bk = t; P.cx = P.bx; P.cz = P.bz; P.cy = P.by; P.bi = -1; P.rebuilds++; }
        return;
      }
      P.cx = x; P.cz = z; P.cy = y; P.bi = -1; P.rebuilds++; fill(P.h, x - half, z - half, P.cell, y, 0, N);   // left it: rebuild now
    };
    P.heightAt = (x, z) => {
      const half = P.cell * n * 0.5; let fx = (x - P.cx + half) / P.cell, fz = (z - P.cz + half) / P.cell;
      if (!(fx >= 0 && fz >= 0 && fx <= n && fz <= n)) return -1e9;
      let i = Math.min(n - 1, fx | 0), j = Math.min(n - 1, fz | 0); fx -= i; fz -= j; const H = P.h;
      return (H[j * r + i] * (1 - fx) + H[j * r + i + 1] * fx) * (1 - fz) + (H[(j + 1) * r + i] * (1 - fx) + H[(j + 1) * r + i + 1] * fx) * fz;
    };
    // fine contact footprint on the underside of obj (its own local frame), subdivided to roughly the patch cell
    P.footprint = (obj) => {
      obj.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert(), box = new THREE.Box3(), tb = new THREE.Box3();
      obj.traverse(o => { if (o.isMesh && o.geometry) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); tb.copy(o.geometry.boundingBox).applyMatrix4(P.m.multiplyMatrices(inv, o.matrixWorld)); box.union(tb); } });
      P.owner = obj; if (box.isEmpty()) { P.np = 0; return 0; }
      const ws = new THREE.Vector3(); obj.getWorldScale(ws); const sz = box.getSize(new THREE.Vector3());
      const nu = Math.max(2, Math.min(12, Math.ceil(sz.x * Math.abs(ws.x) / P.cell) + 1)), nv = Math.max(2, Math.min(12, Math.ceil(sz.z * Math.abs(ws.z) / P.cell) + 1));
      P.np = nu * nv * 2; P.pts = new Float32Array(P.np * 3); let k = 0;
      for (const y of [box.min.y, box.max.y]) for (let a = 0; a < nu; a++) for (let c = 0; c < nv; c++) {
        P.pts[k++] = box.min.x + sz.x * a / (nu - 1); P.pts[k++] = y; P.pts[k++] = box.min.z + sz.z * c / (nv - 1); }
      return P.np;
    };
    // how far obj must rise (world units) so no footprint point is below the local surface (+pad, world units).
    // Needs obj.matrixWorld (and frame.matrixWorld) current.
    P.lift = (obj, pad) => {
      if (!P.pts || !P.np) return 0; const v = P.v, F = P.frame; let need = 0, s = 1;
      P.m.copy(obj.matrixWorld); if (F) { P.mi.copy(F.matrixWorld).invert(); P.m.premultiply(P.mi); s = F.scale.x || 1; }
      const e = P.m.elements; P.ensure(e[12], e[14], e[13]); const pl = (pad || 0) / s;
      for (let k = 0; k < P.np * 3; k += 3) { v.set(P.pts[k], P.pts[k + 1], P.pts[k + 2]).applyMatrix4(P.m);
        const d = P.heightAt(v.x, v.z) + pl - v.y; if (d > need) need = d; }
      return need * s;
    };
    return P;
  }
  window.DMLocalCollide = { create };
})();
