// dm-localcollide.js — adaptive local collision tessellation.
// Coarse collision surfaces (big terrain / deck / building faces) are resampled into a fine height patch only
// around Ariel + her board, at a cell size tied to the board's own size, so contact follows the real surface.
// The patch is cached and only rebuilt when the board leaves its inner region; all buffers are allocated once.
// Render geometry is never touched.
(function () {
  'use strict';
  function create(THREE, opts) {
    const n = Math.max(4, (opts && opts.n) | 0 || 12);          // cells per side
    const P = { n, cell: (opts && opts.cell) || 0.25, sample: opts.sample, cx: NaN, cz: NaN,
      h: new Float32Array((n + 1) * (n + 1)), pts: null, np: 0, v: new THREE.Vector3(), m: new THREE.Matrix4(), b: new THREE.Box3(), rebuilds: 0 };
    P.setCell = (c) => { if (c > 1e-4 && Math.abs(c - P.cell) > 1e-6) { P.cell = c; P.cx = NaN; } };
    P.ensure = (x, z) => {
      const half = P.cell * n * 0.5;
      if (P.cx === P.cx && Math.abs(x - P.cx) < half * 0.5 && Math.abs(z - P.cz) < half * 0.5) return;
      P.cx = x; P.cz = z; P.rebuilds++;
      const x0 = x - half, z0 = z - half;
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const y = P.sample(x0 + i * P.cell, z0 + j * P.cell); P.h[j * (n + 1) + i] = y === y ? y : -1e9; }
    };
    P.heightAt = (x, z) => {
      const half = P.cell * n * 0.5; let fx = (x - P.cx + half) / P.cell, fz = (z - P.cz + half) / P.cell;
      if (!(fx >= 0 && fz >= 0 && fx <= n && fz <= n)) return -1e9;
      let i = Math.min(n - 1, fx | 0), j = Math.min(n - 1, fz | 0); fx -= i; fz -= j; const r = n + 1, H = P.h;
      return (H[j * r + i] * (1 - fx) + H[j * r + i + 1] * fx) * (1 - fz) + (H[(j + 1) * r + i] * (1 - fx) + H[(j + 1) * r + i + 1] * fx) * fz;
    };
    // fine contact footprint on the underside of obj (its own local frame), subdivided to roughly the patch cell
    P.footprint = (obj) => {
      obj.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert(), box = new THREE.Box3(), tb = new THREE.Box3();
      obj.traverse(o => { if (o.isMesh && o.geometry) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); tb.copy(o.geometry.boundingBox).applyMatrix4(P.m.multiplyMatrices(inv, o.matrixWorld)); box.union(tb); } });
      if (box.isEmpty()) return 0;
      const ws = new THREE.Vector3(); obj.getWorldScale(ws); const sz = box.getSize(new THREE.Vector3());
      const nu = Math.max(2, Math.min(12, Math.ceil(sz.x * Math.abs(ws.x) / P.cell) + 1)), nv = Math.max(2, Math.min(12, Math.ceil(sz.z * Math.abs(ws.z) / P.cell) + 1));
      P.np = nu * nv * 2; P.pts = new Float32Array(P.np * 3); let k = 0;
      for (const y of [box.min.y, box.max.y]) for (let a = 0; a < nu; a++) for (let c = 0; c < nv; c++) {
        P.pts[k++] = box.min.x + sz.x * a / (nu - 1); P.pts[k++] = y; P.pts[k++] = box.min.z + sz.z * c / (nv - 1); }
      return P.np;
    };
    // how far obj must rise so no footprint point is below the local surface (+pad). Needs obj.matrixWorld current.
    P.lift = (obj, pad) => {
      if (!P.pts) return 0; const e = obj.matrixWorld.elements, v = P.v; let need = 0;
      P.ensure(e[12], e[14]);
      for (let k = 0; k < P.np * 3; k += 3) { v.set(P.pts[k], P.pts[k + 1], P.pts[k + 2]).applyMatrix4(obj.matrixWorld);
        const d = P.heightAt(v.x, v.z) + (pad || 0) - v.y; if (d > need) need = d; }
      return need;
    };
    return P;
  }
  window.DMLocalCollide = { create };
})();
