// dm-collide-game.js — wires DMCollide (ui/dm-collide.js) into the game.
//   window.DMCollide            the one world (static colliders, bodies, actors, events)
//   DMCollide.regChunk(k,g)     queue a streamed prop group's instanced meshes (userData.col specs) for time-sliced registration (~1 ms a frame)
//   DMCollide.dropChunk(k)      unregister the group (slots pooled), also cancels a half-registered one
//   DMCollide.surfWalk(p,dx,dz,dt)   the walking character's sweep (called from updateSurface)   ·   DMCollide.supportFor(p,prevFeet)
//   DMCollide.tick(dt,env)      per-frame: registration slices, body stepping, contact-event particles / ripples, debug view (?collider=1)
//   Switches: ?collide=0 turns the whole layer off · ?collider=1 draws the wireframes · ?slope=deg limits walkable terrain slope (default off: the climb system owns cliffs)
(function (root) {
  'use strict';
  const Lib = root.DMCollideLib; if (!Lib) return;
  const Q = new URLSearchParams((root.location && root.location.search) || '');
  const W = Lib.create({ capacity: 8192 });
  root.DMCollide = W;
  W.on = W.on; W.enabled = Q.get('collide') !== '0'; W.on_ = W.enabled;
  const EYE = 3.0;                                   // updateSurface keeps p.pos at eye height: feet = pos.y - 3.0
  const C = W.makeChar({ r: 0.7, h: 3.1, step: 0.6, snap: 0.5, slope: Math.tan(((+Q.get('slope')) || 55) * Math.PI / 180), strideLen: 2.6 });
  W.char = C;
  const slopeDeg = +Q.get('slope') || 0;
  // ── streamed chunk registration (time-sliced)
  const jobs = []; let cur = null;
  function specsOf(g) { const out = []; g.traverse(o => { if (o.isInstancedMesh && o.userData && o.userData.col) out.push(o); }); return out; }
  W.regChunk = (key, g) => { if (!W.enabled || !g) return; const ims = specsOf(g); if (ims.length) jobs.push({ key, ims, i: 0, it: null }); };
  // a loaded object (GLB structure, prop model): walls rasterised from its triangles ('walls') or one box per mesh ('boxes'); sliced like the chunk jobs
  W.regObject = (key, obj, opts) => { if (!W.enabled || !obj) return; opts = opts || {}; try { obj.updateWorldMatrix(true, true); } catch (e) { } jobs.push({ key, ims: [], i: 0, it: null, gen: opts.mode === 'boxes' ? W.fromObjectGen(key, obj, opts, 6) : W.fromMeshGen(key, obj, opts, 400) }); };
  W.dropChunk = (key) => { for (let k = jobs.length - 1; k >= 0; k--) if (jobs[k].key === key) jobs.splice(k, 1); if (cur && cur.key === key) cur = null; W.clearGroup(key); };
  function pump(ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (!cur) { cur = jobs.shift(); if (!cur) return; }
      if (cur.gen) { let r; try { r = cur.gen.next(); } catch (e) { cur = null; continue; } if (r.done) cur = null; continue; }
      if (!cur.it) { const im = cur.ims[cur.i]; if (!im) { cur = null; continue; } const sp = im.userData.col; cur.it = W.fromInstancedGen(cur.key, im.instanceMatrix.array, im.count, sp, 24); }
      const r = cur.it.next(); if (r.done) { cur.it = null; cur.i++; }
    }
  }
  W.pendingJobs = () => jobs.length + (cur ? 1 : 0);
  // ── hooks the game fills in
  W.setGround(null); W.setWater(function (x, z) {
    const w = root.JOTS_WATER; if (!w || typeof w.surfaceY !== 'number') return NaN; let y = w.surfaceY;
    const D = root.DMWater; if (D && D.active && D.heightAt) { try { y += D.heightAt(x, z) || 0; } catch (e) { } } return y;
  });
  // ── the character
  W.surfWalk = (p, dx, dz, dt) => {
    if (!(dx === dx && dz === dz) || Math.abs(dx) > 1e4 || Math.abs(dz) > 1e4) { dx = 0; dz = 0; }   // (v274) a NaN / absurd step must never reach the position
    if (!W.enabled || (p._ghostUntil > performance.now())) { p.pos.x += dx; p.pos.z += dz; return; }   // ghost: the unstick watchdog lets her walk out of whatever holds her
    const px0 = p.pos.x, py0 = p.pos.y, pz0 = p.pos.z;
    C.x = p.pos.x; C.z = p.pos.z; C.y = p.pos.y - EYE; C.grounded = !!p.onGround && !p._floating; W._dt = dt;
    if (slopeDeg > 0 && root._surfHeight && C.grounded) {   // optional terrain slope limit (off by default)
      const tan = Math.tan(slopeDeg * Math.PI / 180), ox = C.x, oz = C.z, g0 = root._surfHeight(ox, oz), g1 = root._surfHeight(ox + dx, oz + dz), d = Math.hypot(dx, dz);
      if (d > 1e-5 && g1 - g0 > tan * d && g1 > C.y + C.step) { const k = 0.0; dx *= k; dz *= k; }
    }
    W.walk(C, dx, dz);
    if (!(C.x === C.x && C.z === C.z && C.y === C.y) || Math.abs(C.x) > 1e7 || Math.abs(C.z) > 1e7) { C.x = px0; C.z = pz0; C.y = py0 - EYE; W.stats.nan = (W.stats.nan | 0) + 1; return; }   // (v274) the sweep produced a non-finite result: keep the old position
    p.pos.x = C.x; p.pos.z = C.z;
    if (C.grounded && C.y + EYE > p.pos.y) p.pos.y = Math.min(C.y + EYE, py0 + 6);   // (v274) a step-up is a ledge, never a launch (at most 6 m in one frame)
  };
  // overlapping a collider (inside a prop / wall after a spawn, a late registration or a moving actor): push her out; true when she moved
  W.unstick = (p) => { if (!W.enabled || !W.count()) return false; const d = W.pushOut(p.pos.x, p.pos.y - EYE, p.pos.z, C.r, 3, 0.5, PO); if (d > 1e-4 && PO[0] === PO[0] && PO[1] === PO[1]) { p.pos.x += PO[0]; p.pos.z += PO[1]; return true; } return false; };
  W.overlapping = (p) => !!(W.enabled && W.count() && W.pushOut(p.pos.x, p.pos.y - EYE, p.pos.z, C.r, 3, 0.5, PO) > 1e-4);
  // NPCs / creatures (ui/dm-creatures.js): a kinematic actor each (the player is stopped by it), pushed out of props and out of the player. cr = {x,y,z,rig}
  const PO = [0, 0];
  W.npcStep = (cr, r, h) => {
    if (!W.enabled) return; r = r || Math.min(1.1, Math.max(0.3, ((cr.rig && cr.rig.sphereR) || 1.5) * 0.3)); h = h || 3;
    if (cr._act == null || cr._act < 0) { cr._act = W.addActor(cr.x, cr.y, cr.z, r, h, false, cr); if (cr._act < 0) return; }
    if (W.count() && !cr.npcSite) { const d = W.pushOut(cr.x, cr.y || 0, cr.z, r, h, 0.5, PO); if (d > 1e-4) { cr.x += PO[0]; cr.z += PO[1]; } }
    const dx = cr.x - C.x, dz = cr.z - C.z, R = r + C.r, d2 = dx * dx + dz * dz;   // not through the player either (she is moved by her own sweep)
    if (d2 < R * R && Math.abs((cr.y || 0) - C.y) < h) { const d = Math.sqrt(d2) || 1e-3; cr.x += dx / d * (R - d); cr.z += dz / d * (R - d); }
    W.setActor(cr._act, cr.x, cr.y || 0, cr.z);
  };
  W.npcDrop = (cr) => { if (cr && cr._act != null && cr._act >= 0) { W.removeActor(cr._act); cr._act = -1; } };
  // other players on foot (multiplayer ghosts): kinematic actors, so she cannot walk through them; boards in the air are not bodies on the ground
  const peers = new Map();
  W.peerActor = (id, x, y, z, onFoot) => { if (!W.enabled) return; id = String(id); let a = peers.get(id); if (!onFoot) { if (a != null) { W.removeActor(a); peers.delete(id); } return; } if (a == null) { a = W.addActor(x, y, z, 0.7, 3.2, true, id); if (a < 0) return; peers.set(id, a); } W.setActor(a, x, y, z); };
  W.peerDrop = (id) => { id = String(id); const a = peers.get(id); if (a != null) { W.removeActor(a); peers.delete(id); } };
  // standing on a prop: its top at the character's footprint, tested with last frame's feet so a 15 fps fall cannot sink through it
  W.supportFor = (p, prevFeet) => { if (!W.enabled || !W.count() || p._ghostUntil > performance.now()) return -1e9; const s = W.supportAt(p.pos.x, p.pos.z, prevFeet, C.step, 0.35); return (s === s && s < 1e6) ? s : -1e9; };   // (v274) NaN / absurd support heights are ignored
  W.landed = (p, vy) => { if (vy < -3.5) W.emit('land', W.lastMat, p.pos.x, p.pos.y - EYE, p.pos.z, -vy); };
  // ── contact → particles / ripples / audio. Particles: one pooled Points object, CPU-simulated, no allocation.
  const NP = 160; let P = null, pn = 0;
  function mkParticles(THREE, scene) {
    const g = new THREE.BufferGeometry(), pos = new Float32Array(NP * 3), col = new Float32Array(NP * 3);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setDrawRange(0, 0);
    const PM = THREE.PointsNodeMaterial || THREE.PointsMaterial; let m; try { m = new PM({ size: 0.28, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true }); } catch (e) { m = new THREE.PointsMaterial({ size: 0.28, vertexColors: true, transparent: true, depthWrite: false }); }
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 5; pts.raycast = () => { }; pts.name = 'DMCollide_fx'; pts.userData.noBend = true; scene.add(pts);
    P = { pts, g, pos, col, vel: new Float32Array(NP * 3), life: new Float32Array(NP), c0: new Float32Array(NP * 3), g_: new Float32Array(NP), scene };
  }
  const FXC = { dust: [0.62, 0.55, 0.45, 0.6, 1], spark: [1, 0.8, 0.35, 0.9, 0.0], leaf: [0.4, 0.62, 0.25, 0.7, 0.8], thud: [0.55, 0.5, 0.45, 0.45, 1], chime: [0.8, 0.95, 1, 0.6, 0.3], splash: [0.8, 0.9, 1, 0.8, 0.5] };   // r g b life gravityScale
  function burst(fx, x, y, z, nx, ny, nz, speed) {
    if (!P) return; const c = FXC[fx]; if (!c) return; const n = Math.min(14, 3 + (speed | 0));
    for (let k = 0; k < n; k++) {
      if (pn >= NP) pn = 0; const i = pn++, o = i * 3, a = Math.random() * 6.283, s = (0.6 + Math.random()) * Math.min(5, 0.8 + speed * 0.25);
      P.pos[o] = x; P.pos[o + 1] = y + 0.05; P.pos[o + 2] = z; P.vel[o] = nx * s * 0.5 + Math.cos(a) * s * 0.6; P.vel[o + 1] = Math.abs(ny) * s * 0.6 + 0.5 + Math.random() * s * 0.5; P.vel[o + 2] = nz * s * 0.5 + Math.sin(a) * s * 0.6;
      P.life[i] = c[3] * (0.6 + Math.random() * 0.6); P.c0[o] = c[0]; P.c0[o + 1] = c[1]; P.c0[o + 2] = c[2]; P.g_[i] = c[4];
    }
  }
  W.burst = burst;
  W.on(function (e) {
    const fx = e.fx;
    if (e.type === 'splash') {   // a body entered the water: the crown + ripple ring (ui/dm-water-fx.js) or the plain ripple
      const D = root.DMWater; if (D && D.active) { try { const f = D.S && D.S.fx; if (f && f.splash) f.splash(e.x, e.z, Math.min(1.6, 0.25 + e.speed * 0.08)); else D.ripple(e.x, e.z, Math.min(1, 0.2 + e.speed * 0.05)); } catch (er) { } }
      return;
    }
    if (e.type === 'exit') { const D = root.DMWater; if (D && D.active) { try { D.ripple(e.x, e.z, 0.2); } catch (er) { } } return; }
    if (e.type === 'step') { if (e.speed > 20 && (fx === 'dust')) burst('dust', e.x, e.y, e.z, 0, 1, 0, 1); return; }
    if (e.type === 'impact' || e.type === 'land' || e.type === 'hit') { if (e.speed > 1.5) burst(fx, e.x, e.y, e.z, e.nx, e.ny, e.nz, e.speed); if (e.type === 'land' || (e.type === 'impact' && e.mat === 0 && e.speed > 3)) { const D = root.DMWater; void D; } return; }
    if (e.type === 'scrape' && fx === 'spark') burst('spark', e.x, e.y, e.z, e.nx, e.ny, e.nz, e.speed * 0.5);
  });
  // ── per-frame
  let dbg = null, dbgTried = false, lastT = 0;
  W.tick = (dt, env) => {
    if (!W.enabled) return; env = env || {}; const THREE = env.THREE || root.THREE;
    pump(env.mobile ? 1.0 : 1.6);
    if (W.bodies && W.stats.bodies) { W.setGround(root._surfHeight || null); }
    W.step(dt);
    if (THREE && env.scene) {
      if (!P && env.scene) { try { mkParticles(THREE, env.scene); } catch (e) { P = null; } } else if (P && P.scene !== env.scene) { try { P.scene.remove(P.pts); P.g.dispose(); } catch (e) { } P = null; mkParticles(THREE, env.scene); }
      if (P) {   // integrate
        let live = 0; const pos = P.pos, col = P.col;
        for (let i = 0; i < NP; i++) { const o = i * 3; if (P.life[i] > 0) { P.life[i] -= dt; const f = Math.max(0, P.life[i] * 1.6); P.vel[o + 1] -= 9.8 * P.g_[i] * dt; pos[o] += P.vel[o] * dt; pos[o + 1] += P.vel[o + 1] * dt; pos[o + 2] += P.vel[o + 2] * dt; col[o] = P.c0[o] * Math.min(1, f); col[o + 1] = P.c0[o + 1] * Math.min(1, f); col[o + 2] = P.c0[o + 2] * Math.min(1, f); live++; } else { pos[o + 1] = -1e5; } }
        P.g.setDrawRange(0, NP); if (live || P._had) { P.g.attributes.position.needsUpdate = true; P.g.attributes.color.needsUpdate = true; } P._had = live > 0;
      }
      if (Q.get('collider') === '1') {
        if (!dbg && !dbgTried) { dbgTried = true; try { dbg = Lib.attachDebug(W, THREE, env.scene, {}); } catch (e) { console.warn('[collide] debug view', e); } }
        if (dbg) { if (dbg.mesh.parent !== env.scene) env.scene.add(dbg.mesh); dbg.update(dt, env.x || 0, env.z || 0); }
      }
    }
    lastT = W.time;
  };
  W.closeWorld = () => { peers.clear(); jobs.length = 0; cur = null; W.reset(); if (P) { try { P.scene.remove(P.pts); P.g.dispose(); } catch (e) { } P = null; } if (dbg) { try { dbg.dispose(); } catch (e) { } dbg = null; dbgTried = false; } W.setGround(null); };
  W.report = () => ({ colliders: W.count(), pending: W.pendingJobs(), bodies: W.stats.bodies, actors: W.stats.actors, groups: W.stats.groups, pushes: W.stats.pushes, subSteps: W.stats.subSteps, overflow: W.stats.overflow, ms: +W.stats.ms.toFixed(3), peak: W.stats.peak });
})(typeof window !== 'undefined' ? window : globalThis);
