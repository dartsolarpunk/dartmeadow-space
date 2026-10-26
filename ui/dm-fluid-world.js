/* DART Meadow — fluid VFX glue (crunch1 fluids). Wires the true-fluid modules into the game:
 *   DMFluidWorld.tick(dt)                 from _pwFrame (planet world): APIC liquid + PBF spray round Ariel / her
 *                                         board over the sea, impact bricks (dives, hard landings, skims)
 *   DMFluidWorld.dust(scene, o)           drop-in for DMDust.create (same update/dispose): wind-blown dust as a
 *                                         stable-fluids volume that follows the player, crest emitters + kick-up
 *                                         under her board at low altitude (flight smoke) and her feet
 *   DMFluidWorld.asteroidFumes(g, rad, o) drop-in for DMMist.asteroidFumes: vented gas as a stable-fluids volume
 *   DMFluidWorld.nebula(scene, o)         stable-fluids gas cloud (emissive), same idea for interstellar gas
 *   DMFluidWorld.frame(camera, dt)        from the space frame: steps the nearest fumes/nebula volumes
 * All of it is WebGPU only; each entry returns null (callers fall back to the current effect) on WebGL.
 */
(function () {
  'use strict';
  const W = window;
  const C = () => W.DMFluidCore;
  const ok = () => !!(W.DMFluidCore && W.DMFluidCore.ok() && W.DMFluidAPIC && W.DMFluidSpray && W.DMFluidSmoke);
  // classic-script globals (top-level let/const of index.html are visible by bare name, not on window)
  const G = {
    PW: () => typeof PW !== 'undefined' ? PW : undefined,
    atmoState: () => typeof atmoState !== 'undefined' ? atmoState : undefined,
    surfPlayer: () => typeof surfPlayer !== 'undefined' ? surfPlayer : undefined,
    _surfHeight: () => typeof _surfHeight !== 'undefined' ? _surfHeight : undefined,
    _surfFluid: () => typeof _surfFluid !== 'undefined' ? _surfFluid : undefined,
    TERRAIN: () => typeof TERRAIN !== 'undefined' ? TERRAIN : undefined
  };
  const g = (name) => { try { return G[name] ? G[name]() : undefined; } catch (e) { return undefined; } };

  // ── liquid round Ariel ──
  const L = { apic: null, spray: null, scene: null, on: false, idle: 0, brick: [], prevY: null, impT: [0, 0, 0, 0], nextBrick: 1, failed: false };
  function liquidStop() {
    if (L.apic) { L.apic.dispose(); L.apic = null; }
    if (L.spray) { L.spray.dispose(); L.spray = null; }
    L.scene = null; L.on = false; L.prevY = null;
  }
  function tick(dt) {
    if (!ok() || L.failed) return;
    const PW = g('PW'); if (!PW || !PW.active) { if (L.apic) liquidStop(); return; }
    const mode = PW.mode, Wt = W.JOTS_WATER, H = g('_surfHeight');
    const c = C(); c.govTick(dt);
    let pos = null, vel = null;
    if (mode === 'fly') { const s = g('atmoState'); if (s) { pos = s.pos; vel = s.vel; } }
    else if (mode === 'walk') { const p = g('surfPlayer'); if (p) { pos = p.pos; vel = p.vel; } }
    if (!pos || !Wt || typeof H !== 'function') { if (L.apic) { L.apic.setVisible(false); L.spray.setVisible(false); } return; }
    const seaY = Wt.surfaceY || 0, agl = pos.y - seaY;
    let wet = false; try { wet = H(pos.x, pos.z) < seaY - 0.3; } catch (e) {}
    // walk mode: the SPH pool (ui/dm-fluid.js) already handles her own wading; we only add impact splashes
    const want = wet && agl < (mode === 'fly' ? 22 : 6);
    if (!want) {
      L.idle += dt;
      if (L.apic) { L.apic.setVisible(false); L.spray.setVisible(false); }
      if (L.apic && L.idle > 20) liquidStop();
      L.prevY = pos.y; return;
    }
    L.idle = 0;
    if (!L.apic || L.scene !== PW.scene) {
      liquidStop();
      try {
        const bud = c.budget();
        let col = 0x1a4a7a; try { const m = Wt.surfaceMesh && Wt.surfaceMesh.material; if (m && m.color) col = m.color.getHex(); } catch (e) {}
        L.spray = W.DMFluidSpray.create(PW.scene, { budget: bud, seaY });
        L.apic = W.DMFluidAPIC.create(PW.scene, { budget: bud, seaY, color: col, spray: L.spray });
        L.scene = PW.scene; L.brick = []; for (let k = 0; k < L.apic.NB; k++) L.brick.push({ x: 0, z: 0, on: false, t: 0 });
        L.apic.U.seaY.value = seaY; L.spray.U.seaY.value = seaY;
      } catch (e) { console.warn('[fluid] liquid off:', e); L.failed = true; liquidStop(); return; }
    }
    const A = L.apic, S = L.spray, span = A.B * A.h;
    A.setVisible(true); S.setVisible(true);
    // brick 0 follows her (fly mode, or wading on foot without the SPH pool)
    const b0 = L.brick[0];
    const follow = mode === 'fly' || !g('_surfFluid');
    if (follow) {
      if (!b0.on || Math.hypot(pos.x - b0.x, pos.z - b0.z) > span * 0.22) {
        b0.x = pos.x + (vel ? vel.x : 0) * 0.15; b0.z = pos.z + (vel ? vel.z : 0) * 0.15; b0.on = true;
        A.setBrick(0, b0.x, seaY, b0.z, true);
      }
    } else if (b0.on) { b0.on = false; A.setBrick(0, 0, 0, 0, false); }
    // her (or her board) as a solid body; low flight pushes a downwash into the sea (and throws a rooster tail)
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0, sp = Math.hypot(vx, vz);
    A.setBody(0, pos.x, pos.y - (mode === 'fly' ? 0.2 : 0.6), pos.z, mode === 'fly' ? 1.1 : 0.9, vx, vy, vz);
    if (mode === 'fly' && agl < 7) {
      const k = 1 - Math.max(0, agl) / 7;
      A.setImpulse(0, pos.x - vx * 0.08, seaY, pos.z - vz * 0.08, 2.2 + sp * 0.04, (18 + sp * 1.2) * k, (10 + sp * 2.0) * k * k);
    } else if (L.impT[0] <= 0) A.setImpulse(0, 0, -1e6, 0, 0, 0, 0);
    // impacts: crossing the surface fast (a dive, a dropped landing, a skim)
    if (L.prevY != null && dt > 0) {
      const vyM = (pos.y - L.prevY) / dt;
      if (L.prevY > seaY + 0.15 && pos.y <= seaY + 0.6 && vyM < -4) {
        const e = Math.min(1, -vyM / 25);
        let k = 0;
        if (A.NB > 1) { k = L.nextBrick; L.nextBrick = 1 + (L.nextBrick % (A.NB - 1)); const bk = L.brick[k]; bk.x = pos.x; bk.z = pos.z; bk.on = true; bk.t = 6; A.setBrick(k, pos.x, seaY, pos.z, true); }
        const ik = 1 + (k % 3);
        A.setImpulse(ik, pos.x, seaY, pos.z, 2.0 + e * 2.5, 40 + 60 * e, 120 + 140 * e); L.impT[ik] = 0.12;
      }
    }
    L.prevY = pos.y;
    for (let k = 1; k < 4; k++) if (L.impT[k] > 0) { L.impT[k] -= dt; if (L.impT[k] <= 0) A.setImpulse(k, 0, -1e6, 0, 0, 0, 0); }
    for (let k = 1; k < L.brick.length; k++) { const bk = L.brick[k]; if (bk.on) { bk.t -= dt; if (bk.t <= 0) { bk.on = false; A.setBrick(k, 0, 0, 0, false); } } }
    const r = c.renderer(); if (!r) return;
    try {
      const sc = c.gov.scale;
      A.step(r, dt, sc); S.step(r, dt, pos.x, seaY + 4, pos.z, sc);
    } catch (e) { console.warn('[fluid] liquid step failed, off:', e); L.failed = true; liquidStop(); }
  }

  // ── dust: stable fluids volume following the player (drop-in for DMDust.create) ──
  const h1 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  function dust(scene, o) {
    if (!ok()) return null;
    const c = C(), bud = c.budget(), THREE = W.THREE;
    const SX = 96, SY = 28, SZ = 96, H = o.height, seed = o.seed || 1, amount = o.amount == null ? 1 : o.amount;
    let vol;
    try { vol = W.DMFluidSmoke.create(scene, { budget: bud, size: [SX, SY, SZ], color: new THREE.Color(o.color != null ? o.color : 0xd8b878).lerp(new THREE.Color(0xffffff), 0.25).getHex(), buoy: 0.02, diss: 0.18, turb: 0.35, dens: 3.0 * Math.min(1.5, amount), depthTest: true }); }
    catch (e) { console.warn('[fluid] dust volume off:', e); return null; }
    const N = vol.N, cs = [SX / N, SY / N, SZ / N];
    let cx0 = null, cy0 = 0, cz0 = 0, emT = 0, failed = false;
    const t0 = performance.now(), worldT = () => (W.worldSeconds ? W.worldSeconds() : (performance.now() - t0) / 1000);
    const wind = { x: 1, z: 0, s: 5 };
    function windAt(t) {
      const a = h1(seed) * 6.283 + 0.8 * Math.sin(t / 173) + 0.35 * Math.sin(t / 61 + 1.3);
      const gust = Math.max(0, Math.sin(t / 7.3) * Math.sin(t / 3.1 + 0.7));
      wind.x = Math.cos(a); wind.z = Math.sin(a); wind.s = 4.2 + 2.2 * Math.sin(t / 37) ** 2 + 3.5 * gust;
    }
    let rs = (seed * 9301 + 49297) % 233280 || 1;
    const rnd = () => { rs = (rs * 16807) % 2147483647; return (rs - 1) / 2147483646; };
    const toU = (x, y, z) => [(x - vol.mesh.position.x) / SX + 0.5, (y - vol.mesh.position.y) / SY + 0.5, (z - vol.mesh.position.z) / SZ + 0.5];
    return {
      fluid: true, mesh: vol.mesh,
      update(dt, cam, cx, cz, day) {
        if (failed) return;
        let gy = 0; try { gy = H(cx, cz); } catch (e) {}
        if (!isFinite(gy)) gy = 0;
        const snap = (v, s) => Math.round(v / s) * s;
        const nx = snap(cx, cs[0]), ny = snap(gy + SY * 0.35, cs[1]), nz = snap(cz, cs[2]);
        if (cx0 === null) { cx0 = nx; cy0 = ny; cz0 = nz; }
        const dx = Math.round((nx - cx0) / cs[0]), dy = Math.round((ny - cy0) / cs[1]), dz = Math.round((nz - cz0) / cs[2]);
        if (dx || dy || dz) { vol.shift(dx, dy, dz); cx0 = nx; cy0 = ny; cz0 = nz; }
        vol.mesh.position.set(cx0, cy0, cz0);
        windAt(worldT());
        vol.wind(wind.x * wind.s / SX, 0.02, wind.z * wind.s / SZ, 0.8);
        vol.U.light.value = 0.25 + 0.75 * (day == null ? 1 : day);
        try { const sky = g('TERRAIN') && g('TERRAIN').sky; if (sky && sky.sunDir) vol.setSun(sky.sunDir); } catch (e) {}
        // emitters: 0-1 wind-swept crests upwind of the player, 2 her board's kick-up / her feet
        emT -= dt;
        if (emT <= 0) {
          emT = 0.6;
          for (let k = 0; k < 2; k++) {
            let bx = 0, bz = 0, by = 0, best = -1e9;
            for (let j = 0; j < 6; j++) {
              const a = rnd() * 6.283, r = 8 + Math.sqrt(rnd()) * 36;
              const x = cx - wind.x * 14 + Math.cos(a) * r, z = cz - wind.z * 14 + Math.sin(a) * r, y = H(x, z);
              const up = H(x - wind.x * 1.6, z - wind.z * 1.6), dn = H(x + wind.x * 1.6, z + wind.z * 1.6);
              const sc = (y - up) + (y - dn) * 0.6 + rnd() * 0.05;
              if (sc > best) { best = sc; bx = x; bz = z; by = y; }
            }
            const u = toU(bx, by + 0.6, bz);
            const rate = (0.6 + Math.max(0, best) * 2.5) * Math.min(1, wind.s / 7) * amount;
            vol.emit(k, u[0], u[1], u[2], 0.05, wind.x * wind.s / SX, 0.03, wind.z * wind.s / SZ, rate);
          }
        }
        let kick = 0, kx = cx, kz = cz, ky = gy;
        try {
          const PW = g('PW'), mode = PW && PW.mode;
          if (mode === 'fly') { const s = g('atmoState'); if (s) { const agl = s.pos.y - H(s.pos.x, s.pos.z), sp = s.vel ? Math.hypot(s.vel.x, s.vel.z) : 0; kx = s.pos.x; kz = s.pos.z; ky = H(kx, kz); if (agl < 10 && sp > 3) kick = (1 - agl / 10) * Math.min(1, sp / 25) * 6; } }
          else if (mode === 'walk') { const p = g('surfPlayer'); if (p) { const sp = p.vel ? Math.hypot(p.vel.x, p.vel.z) : 0; kx = p.pos.x; kz = p.pos.z; ky = H(kx, kz); if (p.onGround && sp > 4) kick = Math.min(1.5, sp / 10); } }
        } catch (e) {}
        const u = toU(kx, ky + 0.5, kz);
        vol.emit(2, u[0], u[1], u[2], kick > 0 ? 0.045 : 0, 0, 0.12, 0, kick * amount);
        const r = c.renderer(); if (!r) return;
        try { vol.step(r, dt, c.gov.scale); } catch (e) { console.warn('[fluid] dust step failed, off:', e); failed = true; vol.setVisible(false); }
      },
      dispose() { vol.dispose(); }
    };
  }

  // ── space: asteroid fumes, nebula gas ──
  const FUME_COLS = [[0.95, 0.85, 0.22, 1], [0.30, 0.85, 0.52, 1], [0.86, 0.38, 0.20, 1], [0.48, 0.72, 1.00, 1], [0.62, 0.42, 1.00, 1], [0.34, 0.31, 0.29, 0]];
  const vols = new Set();
  function asteroidFumes(group, rad, o) {
    if (!ok() || !group) return null;
    o = o || {};
    const rnd = o.rand || Math.random, col = FUME_COLS[(o.col != null ? o.col : Math.floor(rnd() * FUME_COLS.length)) % FUME_COLS.length];
    const THREE = W.THREE, c = C(), bud = c.budget();
    const S = rad * 10;
    let vol;
    try { vol = W.DMFluidSmoke.create(group, { budget: bud, size: [S, S, S], color: new THREE.Color(col[0], col[1], col[2]).getHex(), glow: col[3] ? 0.9 : 0, buoy: 0, diss: 0.06, turb: 0.5, dens: 4.0, depthClip: false, depthTest: true, renderOrder: 2 }); }
    catch (e) { console.warn('[fluid] fumes off:', e); return null; }
    const vents = o.low ? 2 : 3;
    for (let v = 0; v < vents; v++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
      const d = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)], f = (rad * 1.05) / S;
      vol.emit(v, 0.5 + d[0] * f, 0.5 + d[1] * f, 0.5 + d[2] * f, 0.04, d[0] * 0.05, d[1] * 0.05, d[2] * 0.05, 2.0 + rnd() * 1.5);
    }
    const h = { mesh: vol.mesh, group, rad, vol, range: rad * 160, kind: 'fume' };
    vols.add(h); return h;
  }
  function nebula(scene, o) {
    if (!ok()) return null;
    o = o || {};
    const THREE = W.THREE, c = C(), bud = c.budget(), S = o.size || 4000, rnd = o.rand || Math.random;
    let vol;
    try { vol = W.DMFluidSmoke.create(scene, { budget: bud, size: [S, S * 0.6, S], color: new THREE.Color(o.color != null ? o.color : 0x8866ff).getHex(), glow: 1.4, buoy: 0, diss: 0.01, turb: 0.8, dens: 1.2, depthClip: false, depthTest: true, renderOrder: 1 }); }
    catch (e) { console.warn('[fluid] nebula off:', e); return null; }
    if (o.position) vol.mesh.position.copy(o.position);
    for (let v = 0; v < 4; v++) vol.emit(v, 0.3 + rnd() * 0.4, 0.3 + rnd() * 0.4, 0.3 + rnd() * 0.4, 0.12, (rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.02, 0.8);
    vol.U.light.value = 0.2;
    const h = { mesh: vol.mesh, vol, range: S * 6, kind: 'nebula' };
    vols.add(h); return h;
  }
  const _wp = { x: 0, y: 0, z: 0 };
  function frame(cam, dt) {
    if (!vols.size || !cam) return;
    const c = C(), r = c && c.renderer(); if (!r) return;
    const THREE = W.THREE, v3 = new THREE.Vector3(), cp = cam.getWorldPosition ? cam.getWorldPosition(new THREE.Vector3()) : cam.position;
    let best = [];
    for (const h of vols) {
      if (!h.mesh.parent) { vols.delete(h); continue; }
      h.mesh.getWorldPosition(v3); const d = v3.distanceTo(cp);
      const vis = d < h.range * 2.5;
      h.mesh.visible = vis;
      h.vol.U.fade.value = Math.max(0, Math.min(1, (h.range * 2.5 - d) / (h.range * 1.2)));
      if (vis) best.push([d / h.range, h]);
    }
    best.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(2, best.length); i++) {
      if (best[i][0] > 1.5) break;
      try { c.mark('fluid:space'); best[i][1].vol.step(r, dt, c.gov.scale); } catch (e) { console.warn('[fluid] space gas step failed:', e); vols.delete(best[i][1]); best[i][1].vol.setVisible(false); }
    }
  }

  W.DMFluidWorld = { ok, tick, dust, asteroidFumes, nebula, frame, _L: L, _vols: vols };
})();
