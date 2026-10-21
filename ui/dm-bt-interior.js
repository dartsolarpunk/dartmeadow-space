/* dm-bt-interior.js — Bird Temple interior render budget (v116; v118 per-opening frustum seal). Separate code path from the temple lighting (#166).
 *
 * Below deck the hull hides the outside world, yet the frame still drew all of it: planets, the galaxy band, volumetric
 * dust, the star bubble, comets, the Oort cloud, the sky background and the true-atmosphere raymarch (full screen).
 * SEALED = the camera is inside the temple's volume, under the top deck, and no opening to the outside (the cargo-bay
 * side opening, the bridge's side + front glass, the hatch, the aft door, any glass mesh) is inside the view frustum.
 * While sealed, for the main render only: every flight-scene top-level object that is not the temple / Ariel / her
 * board / a light / a temple-owned helper is hidden, the background is cleared to black and the atmosphere pass is
 * skipped; all restored right after the render (visibility only — no material, pipeline or light-key change).
 * Conservative: an opening in view (even if a wall is in front of it) draws the world as before.
 *
 * Also here (per-frame budget, no visual change):
 *  - BTI screens (512×320 canvas textures, ~10 Hz each) only redraw/upload while on screen and within 45 units;
 *  - Madison's strand hair only draws while the camera is on her deck and within 30 units (the doll stays).
 * Tuning / debug: window.DMBtInterior ({on, sealed, stats, cfg}); ?btseal=0 turns the culling off.
 */
(function () {
  'use strict';
  const cfg = { on: !/[?&]btseal=0\b/.test(location.search), occ: /[?&]btocc=1\b/.test(location.search), occMs: 3, pad: 2.5, screenR: 45, hairR: 30, hairDY: 6 };
  const S = { cfg, on: cfg.on, sealed: false, stats: { frames: 0, sealedFrames: 0, hidden: 0 }, _boxes: null, _hid: [], _bg: undefined };
  window.DMBtInterior = S;
  let THREE, fr, M4, box, v;
  function init() {
    THREE = window.THREE; if (!THREE) return false;
    fr = new THREE.Frustum(); M4 = new THREE.Matrix4(); box = new THREE.Box3(); v = new THREE.Vector3();
    return true;
  }
  // openings to the outside, in temple-local coordinates (Blender layout from the BTI_Bay empty → local via BTI.toLocal)
  function buildBoxes() {
    const B = window.BTI, g = typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group;
    if (!B || !B.vol || !B.bay || !B.bay.L || !B.toLocal || !g) return null;
    const L = B.bay.L, out = [];
    const bl = (x0, x1, y0, y1, z0, z1) => { const b = new THREE.Box3(); b.expandByPoint(B.toLocal(x0, y0, z0)); b.expandByPoint(B.toLocal(x1, y1, z1)); out.push(b); };
    const zLo = (L.bf || -10.5) - 1.5, zHi = (L.bc || -0.3) + 1.0;
    if (L.bay) bl(22, 55, L.bay.y0 - 2, L.bay.y1 + 2, zLo, zHi);                                // the bay's open side
    const span = (q, i) => [Math.min(...q.map(p => p[i])), Math.max(...q.map(p => p[i]))];
    if (L.glass) { const y = span(L.glass, 0), z = span(L.glass, 1); bl(-55, 55, y[0] - 1, y[1] + 1, z[0] - 1, z[1] + 1); }    // bridge side glass (either side)
    if (L.glass_f) { const x = span(L.glass_f, 0), z = span(L.glass_f, 1); const y0 = L.cmd ? L.cmd.y0 : -77.6; bl(x[0] - 1, x[1] + 1, y0 - 4, y0 + 3, z[0] - 1, z[1] + 1); }   // bridge front glass
    if (L.east_door) bl(-55, 55, L.east_door[0] - 2, L.east_door[1] + 2, -30, 5);               // aft door (conservative: full width/height)
    const h = B.hatch && B.hatch.rect;
    if (h) out.push(new THREE.Box3(new THREE.Vector3(h.minX - 1, h.top - 10, h.minZ - 1), new THREE.Vector3(h.maxX + 1, h.top + 3, h.maxZ + 1)));   // the hatch up to the top deck
    // any glass in the temple (hull windows, BTI_Glass), local boxes
    g.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
    g.traverse(o => {
      if (!o.isMesh || !o.geometry) return; const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || !/glass|window/i.test(m.name || '') || /Holo/i.test(m.name || '')) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      out.push(o.geometry.boundingBox.clone().applyMatrix4(M4.multiplyMatrices(inv, o.matrixWorld)));
    });
    // (v116b) one box per opening: window panes split into several meshes give identical boxes; drop boxes inside another
    const uniq = [];
    for (const b of out) if (!uniq.some(u => u.containsBox(b))) { for (let i = uniq.length - 1; i >= 0; i--) if (b.containsBox(uniq[i])) uniq.splice(i, 1); uniq.push(b); }
    return uniq;
  }
  // (v116b) room-level occlusion. Whether a wall hides an opening from a spot does not depend on where the camera looks, only
  // on where it is: for each camera cell (2 temple units ≈ 0.2 world) every opening box is tested once against the baked hull/collision
  // soup (TCOL, the same triangles the walk and the cargo camera use) with a 7×7 ray grid over each box face turned toward the
  // camera. An opening counts as hidden only if EVERY ray hits a wall before reaching it. The test is time-sliced (≤ cfg.occMs
  // per frame); until a cell is finished it counts as "everything visible" (the world is drawn as before). LRU of 256 cells.
  const occ = { map: new Map(), job: null, cs: 2.0, N: 7 };
  function cellKey(c) { const q = occ.cs; return Math.round(c.x / q) + ',' + Math.round(c.y / q) + ',' + Math.round(c.z / q); }
  // first TCOL hit along a ray (temple frame) walking the XZ grid cell by cell from the origin (2-D DDA): stops as soon as the
  // nearest hit so far lies before the current cell's exit, so a wall a metre away costs a few cells, not the ray's whole box
  function rayHit(ox, oy, oz, dx, dy, dz, far) {
    const C = TCOL, T = C.T, cs = C.cs;
    if (++C.sid >= 0xfffffff0) { C.stamp.fill(0); C.sid = 1; }
    let i = Math.floor((ox - C.x0) / cs), j = Math.floor((oz - C.z0) / cs);
    const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-12 ? cs / Math.abs(dx) : Infinity, tdz = Math.abs(dz) > 1e-12 ? cs / Math.abs(dz) : Infinity;
    let tx = Math.abs(dx) > 1e-12 ? ((C.x0 + (i + (si > 0 ? 1 : 0)) * cs) - ox) / dx : Infinity;
    let tz = Math.abs(dz) > 1e-12 ? ((C.z0 + (j + (sj > 0 ? 1 : 0)) * cs) - oz) / dz : Infinity;
    let best = far, t0 = 0;
    for (let guard = 0; guard < 100000; guard++) {
      if (i >= 0 && i < C.gx && j >= 0 && j < C.gz) {
        const c = j * C.gx + i;
        for (let q = C.start[c]; q < C.start[c + 1]; q++) {
          const t = C.items[q]; if (C.stamp[t] === C.sid) continue; C.stamp[t] = C.sid;
          const o = t * 9, e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2], e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det, sx = ox - T[o], sy = oy - T[o + 1], sz = oz - T[o + 2], u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, w = (dx * qx + dy * qy + dz * qz) * inv; if (w < 0 || u + w > 1) continue;
          const d = (e2x * qx + e2y * qy + e2z * qz) * inv; if (d > 1e-6 && d < best) best = d;
        }
      } else if ((i < 0 && si < 0) || (i >= C.gx && si > 0) || (j < 0 && sj < 0) || (j >= C.gz && sj > 0)) break;   // left the grid for good
      const tn = Math.min(tx, tz); if (best <= tn || tn >= far) break;     // nearest hit is inside the cells already walked
      if (tx < tz) { i += si; tx += tdx; } else { j += sj; tz += tdz; }
      t0 = tn;
    }
    return best < far ? best : -1;
  }
  // hidden = every ray from the cell's centre AND its 8 corners to a 7×7 grid on each face of the (padded) opening turned
  // toward that point hits a wall first, so the answer holds anywhere in the cell, not just where it was asked from
  function* occJob(key, cx, cy, cz, boxes) {
    const res = new Uint8Array(boxes.length), N = occ.N, pad = cfg.pad, h2 = occ.cs * 0.5;
    const P = [[cx, cy, cz]]; for (let k = 0; k < 8; k++) P.push([cx + (k & 1 ? h2 : -h2), cy + (k & 2 ? h2 : -h2), cz + (k & 4 ? h2 : -h2)]);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi], x0 = b.min.x - pad, y0 = b.min.y - pad, z0 = b.min.z - pad, x1 = b.max.x + pad, y1 = b.max.y + pad, z1 = b.max.z + pad;
      let hidden = 1;
      for (let pi = 0; pi < P.length && hidden; pi++) {
        const [ox, oy, oz] = P[pi];
        if (ox >= x0 && ox <= x1 && oy >= y0 && oy <= y1 && oz >= z0 && oz <= z1) { hidden = 0; break; }
        const faces = [];
        if (ox < x0) faces.push([0, x0]); if (ox > x1) faces.push([0, x1]);
        if (oy < y0) faces.push([1, y0]); if (oy > y1) faces.push([1, y1]);
        if (oz < z0) faces.push([2, z0]); if (oz > z1) faces.push([2, z1]);
        for (const [ax, w] of faces) {
          for (let i = 0; i < N && hidden; i++) for (let j = 0; j < N && hidden; j++) {
            const u = i / (N - 1), t = j / (N - 1); let px, py, pz;
            if (ax === 0) { px = w; py = y0 + (y1 - y0) * u; pz = z0 + (z1 - z0) * t; }
            else if (ax === 1) { py = w; px = x0 + (x1 - x0) * u; pz = z0 + (z1 - z0) * t; }
            else { pz = w; px = x0 + (x1 - x0) * u; py = y0 + (y1 - y0) * t; }
            const dx = px - ox, dy = py - oy, dz = pz - oz, d = Math.hypot(dx, dy, dz); if (!(d > 1e-4)) { hidden = 0; break; }
            const h = rayHit(ox, oy, oz, dx / d, dy / d, dz / d, d);
            if (h < 0 || h > d - 0.05) hidden = 0;      // this ray reaches the opening
            yield 0;
          }
          if (!hidden) break;
        }
      }
      res[bi] = hidden;
    }
    if (occ.map.size > 256) occ.map.delete(occ.map.keys().next().value);
    occ.map.set(key, res);
  }
  S._occ = occ; S._occRun = function (cx, cy, cz) { _tcolBuild(); const t0 = performance.now(); const it = occJob('t', cx, cy, cz, S._boxes); let n = 0; while (!it.next().done) n++; return { ms: performance.now() - t0, rays: n, res: Array.from(occ.map.get('t')) }; };
  function occStep() {
    if (!occ.job) return;
    const t0 = performance.now();
    try { while (performance.now() - t0 < cfg.occMs) { const r = occ.job.it.next(); if (r.done) { occ.job = null; S.stats.occCells = occ.map.size; return; } } }
    catch (e) { occ.job = null; S.stats.occErr = String(e && e.message || e).slice(0, 120); }
  }
  const _sv = [];
  function screenArea(b, cam) {   // NDC bbox of the box's 8 corners, clamped to the viewport; corners behind the camera = full width
    if (!_sv.length) for (let k = 0; k < 8; k++) _sv.push(new THREE.Vector3());
    let x0 = 1, x1 = -1, y0 = 1, y1 = -1, behind = false;
    for (let k = 0; k < 8; k++) { const p = _sv[k].set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(cam.matrixWorldInverse);
      if (p.z > -1e-3) { behind = true; continue; } p.applyMatrix4(cam.projectionMatrix); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    if (behind) return 1;
    x0 = Math.max(-1, x0); x1 = Math.min(1, x1); y0 = Math.max(-1, y0); y1 = Math.min(1, y1);
    return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) / 4 : 0;
  }
  function isSealed(cam) {
    const B = window.BTI, g = typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group;
    if (!S.on || !B || !B.vol || !g || !g.visible) return (S.why = 'off', false);
    if (!((typeof SHIP_WALK !== 'undefined' && SHIP_WALK.active) && (B._depth || 0) > 0.9)) return (S.why = 'notBelow', false);
    if (!S._boxes) { S._boxes = buildBoxes(); if (!S._boxes) return (S.why = 'noBoxes', false); }
    // the camera itself must be inside the hull volume and under the top deck
    const cl = g.worldToLocal(v.setFromMatrixPosition(cam.matrixWorld));
    const V = B.vol, dy = B.hatch ? B.hatch.deckY : 0.75;
    if (cl.x < V.mn.x || cl.x > V.mx.x || cl.z < V.mn.z || cl.z > V.mx.z || cl.y < V.mn.y || cl.y > dy - 0.6) return (S.why = 'camOut', false);
    const cx = cl.x, cy = cl.y, cz = cl.z;
    // occlusion for this camera cell (null while it is still being worked out)
    let oc = null;
    if (cfg.occ && typeof TCOL !== 'undefined' && typeof _tcolBuild === 'function') {
      const key = cellKey(cl); oc = occ.map.get(key) || null;
      if (oc) { occ.map.delete(key); occ.map.set(key, oc); }   // LRU touch
      else if (!occ.job) { _tcolBuild(); const q = occ.cs; occ.job = { key, it: occJob(key, Math.round(cx / q) * q, Math.round(cy / q) * q, Math.round(cz / q) * q, S._boxes) }; }   // a running cell finishes first (no restarts while the camera bobs)
    }
    cam.updateMatrixWorld();
    fr.setFromProjectionMatrix(M4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const cw = v.setFromMatrixPosition(cam.matrixWorld);
    // (v118) per-opening, frustum based: an opening whose box is in the view frustum (even partly) keeps the whole outside
    // rendered. Occlusion is opt-in (?btocc=1): the ray soup includes the glass panes themselves, so it marked windows as hidden.
    // Visible openings' projected screen area (0..1 of the viewport) goes to S.openArea for LOD consumers (glass probe rate).
    let vis = 0, area = 0;
    for (let i = 0; i < S._boxes.length; i++) {
      box.copy(S._boxes[i]).expandByScalar(cfg.pad).applyMatrix4(g.matrixWorld);
      if (box.containsPoint(cw)) { S.openArea = 1; S.openVis = 1; return (S.why = 'inOpening' + i, false); }
      if (fr.intersectsBox(box) && !(oc && oc[i])) { vis++; area += screenArea(box, cam); }
    }
    S.openVis = vis; S.openArea = Math.min(1, area);
    if (vis) return (S.why = 'openings' + vis, false);
    S.why = 'sealed';
    return true;
  }
  function keep(o) {
    if (o.isLight || o.isCamera) return true;
    if (typeof BIRD_TEMPLE !== 'undefined' && o === BIRD_TEMPLE.group) return true;
    if (typeof CHAR !== 'undefined' && CHAR && o === CHAR.root) return true;
    if (typeof boardFlight !== 'undefined' && o === boardFlight) return true;
    const n = o.name || '';
    if (/^(BT_|BTI|BTE|FX_BTE|JOTS_BTLight)/.test(n) || (o.userData && (o.userData.bti || o.userData.btStandIn || o.userData.keepAboard))) return true;
    if (o.children && o.children.some(c => c.isLight)) return true;   // a light's holder (target groups, pools)
    return false;
  }
  // the session cubes over the roof (BT_Cubes, ~1k transparent instances + lines, frustumCulled=false because they animate):
  // one bounding sphere for the whole constellation (from its layout), tested against the view each frame
  let cubeSph = null;
  function cubesOff(cam) {
    const C = typeof BT_CUBES !== 'undefined' && BT_CUBES, r = C && C.root; if (!r || !r.visible || !C.layout) return null;
    if (S.sealed) return r;                                       // under the deck with no opening in view: the roof hides them
    if (!cubeSph) { const b = new THREE.Box3(); for (const c of C.layout) b.expandByPoint(c.pos); cubeSph = b.getBoundingSphere(new THREE.Sphere()); cubeSph.radius += 2.5; }
    r.updateWorldMatrix(true, false);
    const sp = S._cs || (S._cs = new THREE.Sphere()); sp.copy(cubeSph).applyMatrix4(r.matrixWorld);
    return fr.intersectsSphere(sp) ? null : r;
  }
  // before the temple lighting's preRender: decides SEALED for this frame (so the glass probe can wait while no glass is in view)
  S.pre = function (cam) {
    if (!THREE && !init()) return false;
    occStep();
    let sealed = false; try { sealed = isSealed(cam); } catch (e) { sealed = false; S.why = 'err'; }
    S.sealed = sealed; S._preF = S.stats.frames + 1;
    return sealed;
  };
  // call right before the main flight render; returns true when sealed (caller then skips the atmosphere pass)
  S.begin = function (scene, cam) {
    if (!THREE && !init()) return false;
    S.stats.frames++;
    if (S._preF !== S.stats.frames) { let sealed = false; try { occStep(); sealed = isSealed(cam); } catch (e) { sealed = false; } S.sealed = sealed; }
    else { cam.updateMatrixWorld(); fr.setFromProjectionMatrix(M4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)); }
    const hid = S._hid; hid.length = 0;
    try { const c = cubesOff(cam); if (c) { c.visible = false; hid.push(c); S.stats.cubesCulled = (S.stats.cubesCulled || 0) + 1; } } catch (e) { }
    if (!S.sealed) return false;
    S.stats.sealedFrames++;
    for (const o of scene.children) if (o.visible && !keep(o)) { o.visible = false; hid.push(o); }
    S.stats.hidden = hid.length;
    S._bg = scene.background; scene.background = null;
    return true;
  };
  S.end = function (scene) {
    for (const o of S._hid) o.visible = true; S._hid.length = 0;
    if (!S.sealed) return;
    if (S._bg !== undefined) { scene.background = S._bg; S._bg = undefined; }
  };
  // BTI screens: only the ones on screen and near redraw (dm-birdtemple asks per screen)
  const scrMeshes = new Map();
  S.screenVisible = function (s) {
    try {
      if (!THREE && !init()) return true;
      const cam = typeof flightCamera !== 'undefined' && flightCamera; if (!cam) return true;
      let ms = scrMeshes.get(s);
      if (!ms) { ms = []; BIRD_TEMPLE.group.traverse(o => { if (o.isMesh && (o.material === s.mat || (Array.isArray(o.material) && o.material.includes(s.mat)))) ms.push(o); }); scrMeshes.set(s, ms); }
      if (!ms.length) return true;
      cam.updateMatrixWorld(); fr.setFromProjectionMatrix(M4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      const cp = v.setFromMatrixPosition(cam.matrixWorld).clone();
      for (const o of ms) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const sp = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
        if (sp.center.distanceTo(cp) - sp.radius < cfg.screenR && fr.intersectsSphere(sp)) return true;
      }
      return false;
    } catch (e) { return true; }
  };
  // Madison's hair: drawn only on her deck and near
  let hairT = 0;
  S.tick = function () {
    const n = performance.now(); if (n - hairT < 200) return; hairT = n;
    try {
      const B = window.BTE, H = B && B.madison && B.madison.hair; if (!H || !H.mesh) return;
      const cam = typeof flightCamera !== 'undefined' && flightCamera; if (!cam || !THREE && !init()) return;
      const seat = H.mesh.parent && B.scene && B.scene.getObjectByName('FX_BTE_MadisonSeat');
      const p = (seat || H.mesh).getWorldPosition(new THREE.Vector3()), c = v.setFromMatrixPosition(cam.matrixWorld);
      const g = BIRD_TEMPLE.group, up = new THREE.Vector3(0, 1, 0).applyQuaternion(g.getWorldQuaternion(new THREE.Quaternion()));
      const s = g.scale.x || 1, d = c.distanceTo(p), dy = Math.abs(c.clone().sub(p).dot(up));
      H.mesh.visible = !S.on || (d < cfg.hairR * s && dy < cfg.hairDY * s);
    } catch (e) { }
  };
})();
