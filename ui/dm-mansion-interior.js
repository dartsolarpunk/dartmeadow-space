// DM Mansion Interior (v228) — Ariel's cliffside home, walkable inside.
//
// What this file is:
//   • a lazy loader for ONE merged interior mesh (assets/ariel-home/ariel-home-interior[-512].glb: 3 draw calls, 1 PBR atlas, vertex-baked light)
//     that is added under the mansion root only while she is on or near the landing deck, and fully disposed when she leaves;
//   • the walking system for it. It plugs into the SAME ground-height path as the deck (TERRAIN.H → F.wrapH): while she is walking inside the
//     footprint, F.ovr(x,z) answers with the interior floor (hall, stair ramp, loft, podium, prow, workshop) instead of the roof the exterior
//     collision grid reports there; walk() (one call per frame from updateSurface) stops her at walls and props. Nothing here allocates per frame.
//
// Nav data (assets/ariel-home/ariel-home-interior-nav.json, built by tools/ariel-home/build_interior.py), mansion-local frame (x east, y seaward, z up):
//   patches  r = flat rect, p = flat polygon, s = ramp (stairs); the highest patch not more than STEP above her feet wins
//   obs      [x0,y0,x1,y1,zlo,zhi] boxes (furniture), seg [ax,ay,bx,by,zlo,zhi] thin walls/rails; both only block while her body overlaps [zlo,zhi]
//   rooms    footprints of the three enclosed volumes: inside one, anywhere with no floor is solid wall
//   soff     roof underside height grid; above it (on the roof) the exterior grid answers as before
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const STEP = 1.5, BODY = 3.2, RAD = 0.7, SEGR = 0.5, WALL_UP = 4.5, LIVE_R2 = 170 * 170, LOAD_D = 260, DROP_D = 400,
    TELE = 24, MAXSUB = 48;   // a frame hitch (compile / GC, even at run speed) is swept in <= 0.5 m sub-steps so it cannot tunnel a wall; only a jump of > 24 m is a teleport (re-seat, no sweep)
  const S = {
    F: null, rec: null, state: 0 /* 0 idle · 1 loading · 2 ready */, gen: 0, root: null, failed: 0,
    px: 0, pz: 0, y0: 0, ct: 1, st: 0, live: false, t: 0, feet: 0, have: false, lx: 0, ly: 0, nearAt: 0, farAt: 0,
  };
  let NAV = null, navP = null;     // parsed once, tiny, kept across unloads
  let _wall = false;

  // ── nav parse ────────────────────────────────────────────────────────────────────────────────────────────
  function shape(a, withH) {
    const o = { t: 0, x0: 0, y0: 0, x1: 0, y1: 0, h0: 0, h1: 0, ax: 0, pts: null };
    if (a[0] === 'p') { o.t = 1; const p = a[1], n = p.length, f = new Float64Array(n * 2); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < n; i++) { f[2 * i] = p[i][0]; f[2 * i + 1] = p[i][1]; x0 = Math.min(x0, p[i][0]); x1 = Math.max(x1, p[i][0]); y0 = Math.min(y0, p[i][1]); y1 = Math.max(y1, p[i][1]); }
      o.pts = f; o.x0 = x0; o.x1 = x1; o.y0 = y0; o.y1 = y1; if (withH) o.h0 = a[2]; return o; }
    o.x0 = a[1]; o.y0 = a[2]; o.x1 = a[3]; o.y1 = a[4];
    if (a[0] === 's') { o.t = 2; o.ax = a[5] === 'y' ? 1 : 0; o.h0 = a[6]; o.h1 = a[7]; } else if (withH) o.h0 = a[5];
    return o;
  }
  function parseNav(j) {
    const n = { patches: j.patches.map(a => shape(a, true)), rooms: j.rooms.map(a => shape(a, false)), bbox: j.bbox, spawn: j.spawn };
    n.obs = new Float64Array(j.obs.length * 6); j.obs.forEach((a, i) => { for (let k = 0; k < 6; k++) n.obs[i * 6 + k] = a[k]; });
    n.seg = new Float64Array(j.seg.length * 6); j.seg.forEach((a, i) => { for (let k = 0; k < 6; k++) n.seg[i * 6 + k] = a[k]; });
    const s = j.soff, bin = atob(s.data), d = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
    n.soff = { x0: s.x0, y0: s.y0, c: s.cell, nx: s.nx, ny: s.ny, d };
    return n;
  }

  // ── geometry queries (allocation-free) ───────────────────────────────────────────────────────────────────
  function inPoly(p, x, y) {
    let c = false; const n = p.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = p[2 * i], yi = p[2 * i + 1], xj = p[2 * j], yj = p[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function patchH(p, x, y) {
    if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) return NaN;
    if (p.t === 1) return inPoly(p.pts, x, y) ? p.h0 : NaN;
    if (p.t === 2) { const u = p.ax ? (y - p.y0) / (p.y1 - p.y0) : (x - p.x0) / (p.x1 - p.x0); return p.h0 + (p.h1 - p.h0) * u; }
    return p.h0;
  }
  function inRoom(x, y) {
    const R = NAV.rooms;
    for (let i = 0; i < R.length; i++) { const r = R[i]; if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue; if (r.t === 0 || inPoly(r.pts, x, y)) return true; }
    return false;
  }
  function soffAt(x, y) {
    const s = NAV.soff, i = Math.floor((x - s.x0) / s.c), j = Math.floor((y - s.y0) / s.c);
    if (i < 0 || j < 0 || i >= s.nx || j >= s.ny) return Infinity;
    const v = s.d[j * s.nx + i]; return v === 255 ? Infinity : v * 0.1;
  }
  // local floor height at (x,y) for a body whose feet are at `feet`; NaN = not ours (the exterior grid answers). Sets _wall when the cell is solid.
  function surf(x, y, feet) {
    _wall = false;
    if (feet >= soffAt(x, y) - 0.3) return NaN;           // on the roof: the exterior grid's job
    const P = NAV.patches, lim = feet + STEP; let best = NaN;
    for (let i = 0; i < P.length; i++) { const h = patchH(P[i], x, y); if (h <= lim && (best !== best || h > best)) best = h; }
    if (best === best) return best;
    if (inRoom(x, y)) { _wall = true; return feet + WALL_UP; }
    return NaN;
  }
  function blocked(x, y, feet) {
    if (S.state !== 2 && inRoom(x, y)) return true;   // doorway gate: the interior meshes are not in yet (loading / not started), so the glass holds her out instead of letting her into an empty shell
    surf(x, y, feet); if (_wall) return true;
    const O = NAV.obs, top = feet + BODY - 0.4;
    for (let i = 0; i < O.length; i += 6) {
      if (x < O[i] - RAD || x > O[i + 2] + RAD || y < O[i + 1] - RAD || y > O[i + 3] + RAD) continue;
      if (feet < O[i + 5] - 0.4 && top > O[i + 4]) return true;
    }
    const Sg = NAV.seg;
    for (let i = 0; i < Sg.length; i += 6) {
      if (!(feet < Sg[i + 5] - 0.4 && top > Sg[i + 4])) continue;
      const ax = Sg[i], ay = Sg[i + 1], ex = Sg[i + 2] - ax, ey = Sg[i + 3] - ay, px = x - ax, py = y - ay, l2 = ex * ex + ey * ey;
      let t = l2 > 0 ? (px * ex + py * ey) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - ex * t, qy = py - ey * t; if (qx * qx + qy * qy < SEGR * SEGR) return true;
    }
    return false;
  }

  // ── engine hooks ─────────────────────────────────────────────────────────────────────────────────────────
  // F.ovr(x,z): exact interior ground height (world y) or NaN. It answers ONLY inside ground() (her own ground query in updateSurface) and only while
  // walk() is live, so the board, trees, camera probes, ground marks and every other TERRAIN.H lookup keep seeing the roof / exterior grid.
  let _q = false;
  function ovr(x, z) {
    if (!_q || !S.live) return NaN;
    const dx = x - S.px, dz = z - S.pz, lx = dx * S.ct - dz * S.st, ly = -(dx * S.st + dz * S.ct), b = NAV.bbox;
    if (lx < b[0] || lx > b[2] || ly < b[1] || ly > b[3]) return NaN;
    const h = surf(lx, ly, S.feet); return h === h ? S.y0 + h : NaN;
  }
  // updateSurface asks for her ground height through this: ground(_surfHeight, x, z). fn is the wrapped height path (TERRAIN.H -> F.wrapH), so F.ovr is
  // consulted for this one call and nothing else (no allocation; the flag is cleared even if fn throws).
  function ground(fn, x, z) { _q = true; try { return fn(x, z); } finally { _q = false; } }
  // updateSurface calls this right after it moves p.pos in x/z (feet = pos.y - 3). Walls/props stop the move; she slides along them.
  function walk(pos) {
    if (NAV === null || S.rec === null) return;
    const dx = pos.x - S.px, dz = pos.z - S.pz;
    if (dx * dx + dz * dz > LIVE_R2) { S.live = false; S.have = false; if (G.DMMansionLook) G.DMMansionLook.probeTick(0, 0, 0, false); return; }
    const lx = dx * S.ct - dz * S.st, ly = -(dx * S.st + dz * S.ct), feet = pos.y - 3.0 - S.y0, b = NAV.bbox;
    S.feet = feet; S.live = true; S.t = performance.now();
    if (G.DMMansionLook) G.DMMansionLook.probeTick(lx, ly, feet, S.state === 2 && inRoom(lx, ly));   // baked light-probe tint of the world's own ambient/hemi lights (uniform writes only; restores when she steps out)
    if (!S.have || Math.abs(lx - S.lx) > TELE || Math.abs(ly - S.ly) > TELE || lx < b[0] - 3 || lx > b[2] + 3 || ly < b[1] - 3 || ly > b[3] + 3) { S.lx = lx; S.ly = ly; S.have = true; return; }
    const mx = lx - S.lx, my = ly - S.ly, dist = Math.abs(mx) + Math.abs(my);
    if (dist < 1e-6) return;
    if (blocked(S.lx, S.ly, feet)) { S.lx = lx; S.ly = ly; return; }      // already inside something (spawned in, landed on a prop): let her walk out
    const n = Math.min(MAXSUB, Math.ceil(dist / 0.5)), sx = mx / n, sy = my / n; let cx = S.lx, cy = S.ly;
    for (let i = 0; i < n; i++) {
      if (!blocked(cx + sx, cy + sy, feet)) { cx += sx; cy += sy; }
      else if (sx !== 0 && !blocked(cx + sx, cy, feet)) cx += sx;
      else if (sy !== 0 && !blocked(cx, cy + sy, feet)) cy += sy;
      else break;
    }
    const ex = cx - lx, ey = cy - ly;
    if (ex * ex + ey * ey > 1e-10) { pos.x += ex * S.ct - ey * S.st; pos.z += -ex * S.st - ey * S.ct; }
    S.lx = cx; S.ly = cy;
  }

  // ── lazy load / dispose ──────────────────────────────────────────────────────────────────────────────────
  function disposeObj(o) {
    const mats = new Set(), tex = new Set();
    o.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => mats.add(m)); });
    mats.forEach(m => { if (m.userData && m.userData.dmMansionLook) return; for (const k in m) { const v = m[k]; if (v && v.isTexture) tex.add(v); } m.dispose(); });
    tex.forEach(t => t.dispose());
  }
  function unload() {
    S.gen++; S.state = 0; S.live = false; S.have = false;
    if (S.root) { if (S.root.parent) S.root.parent.remove(S.root); disposeObj(S.root); S.root = null; }
    if (G.DMMansionLook) { try { G.DMMansionLook.release(); } catch (e) { } }   // shared materials stay; GPU textures + bitmaps go
  }
  // the nav JSON is 14 KB: it is fetched as soon as the mansion is placed (not with the 1 MB mesh) so the doorway gate and the terrace apron are live from the first step on the deck
  function ensureNav(F) {
    if (!navP) navP = fetch('assets/ariel-home/ariel-home-interior-nav.json?v=' + F.ver).then(r => { if (!r.ok) throw new Error('nav ' + r.status); return r.json(); }).then(j => { NAV = parseNav(j); }, e => { navP = null; console.warn('[mansion-interior] nav', e); });
    return navP;
  }
  const nextFrame = () => new Promise(res => { let d = false; const f = () => { if (!d) { d = true; res(); } }; if (G.requestAnimationFrame) G.requestAnimationFrame(f); G.setTimeout(f, 250); });
  // OOM fix (Chrome Aw-Snap): the GLB parse, the GI decode and the compile no longer overlap. Order: GLB parse (nav JSON alongside) -> look.apply(root, c, null)
  // -> await look.loadGI() (GI decoded one file at a time, attached to the shared atlas) -> a frame later: parent + tag + compileAsync, ONCE, with everything in.
  // The root stays out of the scene until then, so nothing half-lit is ever drawn or compiled. unload() -> look.release() cancels an in-flight loadGI.
  async function loadSeq(F, c, gen) {
    const base = 'assets/ariel-home/ariel-home-interior', v = '?v=' + F.ver, LK = G.DMMansionLook;
    const stale = () => gen !== S.gen || !S.rec || !S.rec.group;
    const glbUrl = base + (c.isMobile() ? '-512' : '') + '.glb' + v;
    c.glbUrl = glbUrl;                               // the file actually loaded (-512 on mobile): look's context-restore / closed-bitmap guard rebuilds from it
    const gl = (await Promise.all([c.loadGLB(glbUrl), navP]))[0];
    if (stale()) { disposeObj(gl.scene); return; }
    if (NAV === null) { disposeObj(gl.scene); throw new Error('no nav'); }
    const root = gl.scene; root.name = 'ArielInterior';
    root.traverse(n => { if (n.isMesh) { n.castShadow = false; n.receiveShadow = false; n.matrixAutoUpdate = false; } });
    S.root = root;                                   // unload() owns the disposal from here on (it is not in the scene yet)
    if (LK && typeof LK.loadGI === 'function') {
      try { LK.apply(root, c, null); } catch (e) { console.warn('[mansion-interior] look', e); }   // shared materials + cheap fake-light (ui/dm-mansion-look.js)
      if (stale()) return;
      try { await LK.loadGI(c, F.ver); } catch (e) { console.warn('[mansion-interior] gi', e); }  // false/throw = the vertex-baked look stays
    } else if (LK && LK.apply) {                    // older look script: its own prefetch, but still after the GLB parse (sequential, never in parallel with it)
      let gi = null; try { gi = LK.prefetch ? await LK.prefetch(c, F.ver) : null; } catch (e) { }
      if (stale()) { if (LK.discard) LK.discard(gi); return; }
      try { LK.apply(root, c, gi); } catch (e) { console.warn('[mansion-interior] look', e); }
    }
    if (stale()) return;
    await nextFrame(); if (stale()) return;           // compile only after the GI is in, not in the same task as its attach
    S.rec.group.add(root); root.updateMatrixWorld(true);
    // same order as the mansion itself (#239): tag FIRST, compile SECOND, once.
    c.mapTag(root);
    const PW = c.PW(), done = () => { if (gen !== S.gen) return; S.state = 2; };
    try { if (PW && PW.renderer && PW.renderer.compileAsync && PW.camera) PW.renderer.compileAsync(root, PW.camera, PW.scene).then(done, done); else done(); } catch (e) { done(); }
  }
  function load() {
    const F = S.F, gen = ++S.gen; S.state = 1;
    ensureNav(F);
    loadSeq(F, F.ctx, gen).catch(e => { if (gen !== S.gen) return; S.failed = performance.now(); S.state = 0; console.warn('[mansion-interior] load failed', e); });
  }

  // ── sealed room: skip the outside world (ported from the Bird Temple, ui/dm-bt-interior.js #168) ───────────────────────────────────────
  // SEALED = the camera is inside one of the three enclosed rooms, under the roof, and no glass of the house is inside the view frustum. While sealed, for the main
  // world render only: every planet-world top-level object that is not the mansion / Ariel / her board / a light holder is hidden, and the caller skips the
  // atmosphere pass (visibility only; no material, pipeline or light change; restored in end()). Conservative: ANY glass in view (even behind a wall) draws the
  // world as before. The Bird Temple's occJob (rays against a baked triangle soup) is not ported: the mansion has no collision triangles, so occlusion is always "visible".
  const Q = { fr: null, m4: null, box: null, v: null, glass: null, cell: 10, pad: 2.5, hid: [], rec: null };
  function glassBoxes(THREE) {     // world-space boxes of the house's glass, binned by triangle centroid into 10 m cells (a pane never spans the whole house); built once per mansion
    const out = [], cells = new Map(), g = S.rec.group, lod = g.userData.lod0 || g;
    g.updateMatrixWorld(true);
    lod.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.material || o.material.name !== 'ah_glass') return;
      const P = o.geometry.attributes.position, I = o.geometry.index, M = o.matrixWorld, n = I ? I.count : P.count, a = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      for (let i = 0; i + 2 < n; i += 3) {
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 3; k++) { a[k].fromBufferAttribute(P, I ? I.getX(i + k) : i + k).applyMatrix4(M); cx += a[k].x; cy += a[k].y; cz += a[k].z; }
        const key = Math.floor(cx / 3 / Q.cell) + ',' + Math.floor(cy / 3 / Q.cell) + ',' + Math.floor(cz / 3 / Q.cell);
        let b = cells.get(key); if (!b) { b = new THREE.Box3(); cells.set(key, b); out.push(b); }
        for (let k = 0; k < 3; k++) b.expandByPoint(a[k]);
      }
    });
    for (const b of out) b.expandByScalar(Q.pad);
    return out;
  }
  function keepObj(o, g, k0, k1) {
    if (o.isLight || o.isCamera || o === g || o === k0 || o === k1) return true;
    for (let i = 0; i < o.children.length; i++) if (o.children[i].isLight) return true;     // a light's holder (target groups)
    return false;
  }
  function isSealed(scene, cam) {
    if (S.state !== 2 || !S.live || !S.rec || !S.rec.group || !S.root || !NAV) return false;
    const THREE = S.F.ctx.THREE; if (!THREE) return false;
    if (!Q.fr) { Q.fr = new THREE.Frustum(); Q.m4 = new THREE.Matrix4(); Q.v = new THREE.Vector3(); }
    const cf = S.F.ctx.PW() && S.F.ctx.PW()._camFlat, cp = cf ? cf.p : cam.position;     // the flat-world camera (the drawn one is bent round the focus)
    const dx = cp.x - S.px, dz = cp.z - S.pz, lx = dx * S.ct - dz * S.st, ly = -(dx * S.st + dz * S.ct), ch = cp.y - S.y0;
    if (!inRoom(lx, ly) || ch >= soffAt(lx, ly) - 0.3) return false;                    // outside, or on / above the roof
    if (Q.rec !== S.rec) { Q.rec = S.rec; Q.glass = null; }
    if (!Q.glass) Q.glass = glassBoxes(THREE);
    cam.updateMatrixWorld(); Q.fr.setFromProjectionMatrix(Q.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    for (let i = 0; i < Q.glass.length; i++) { const b = Q.glass[i]; if (b.containsPoint(Q.v.copy(cp)) || Q.fr.intersectsBox(b)) return false; }
    return true;
  }
  // call right before the main world render with the planet scene + camera (+ the two things to keep: her root, her board); true = sealed (caller skips the atmosphere pass)
  function begin(scene, cam, k0, k1) {
    Q.hid.length = 0; S.sealed = false;
    let sealed = false; try { sealed = isSealed(scene, cam); } catch (e) { sealed = false; }
    if (!sealed) return false;
    const g = S.rec.group, ch = scene.children;
    for (let i = 0; i < ch.length; i++) { const o = ch[i]; if (o.visible && !keepObj(o, g, k0, k1)) { o.visible = false; Q.hid.push(o); } }
    S.sealed = true; return true;
  }
  function end() { for (let i = 0; i < Q.hid.length; i++) Q.hid[i].visible = true; Q.hid.length = 0; S.sealed = false; }

  const F_busy = () => !!(S.F && S.F.ctx && S.F.ctx.sysBusy);   // system rebuild running: the interior waits (same gate as pollLand)

  const API = {
    // place() calls this once the mansion root exists (px,pz = world origin of the root, y0 = its world y, th = its yaw)
    attach(F, rec, px, pz, y0, th) {
      if (S.state) unload();
      S.F = F; S.rec = rec; F.ovr = ovr; ensureNav(F); S.px = px; S.pz = pz; S.y0 = y0; S.ct = Math.cos(th); S.st = Math.sin(th); S.nearAt = S.farAt = 0; S.failed = 0;
    },
    // F.tick, per mansion, after the LOD upkeep: load when she has been near for a moment (and the exterior is warmed), drop when she has gone
    tick(rec, d2, now, arriving) {
      if (rec !== S.rec) return;
      if (S.live && now - S.t > 200) { S.live = false; S.have = false; }
      if (S.state === 0) {
        if (d2 < LOAD_D * LOAD_D && rec.warmed && !arriving && !F_busy()) {
          if (!S.nearAt) S.nearAt = now;
          if (now - S.nearAt > 800 && (!S.failed || now - S.failed > 30000)) load();
        } else S.nearAt = 0;
      } else if (d2 > DROP_D * DROP_D) { if (!S.farAt) S.farAt = now; if (now - S.farAt > 3000) { unload(); S.nearAt = S.farAt = 0; } } else S.farAt = 0;
    },
    detach() { unload(); if (S.F && S.F.ovr === ovr) S.F.ovr = null; if (G.DMMansionLook) { try { G.DMMansionLook.destroy(); } catch (e) { } } S.rec = null; S.F = null; },
    walk, ground, begin, end,
    status() { return { state: S.state, live: S.live, sealed: S.sealed, loaded: !!S.root, feet: S.feet, lx: S.lx, ly: S.ly }; },
    spawn() { return NAV ? NAV.spawn : null; },
    _test: { parse: j => { NAV = parseNav(j); }, surf, blocked, setFrame(px, pz, y0, th) { S.px = px; S.pz = pz; S.y0 = y0; S.ct = Math.cos(th); S.st = Math.sin(th); S.state = 2; S.F = { ovr: null }; }, ovr, S },
  };
  G.DMMansionInt = API;
})();
