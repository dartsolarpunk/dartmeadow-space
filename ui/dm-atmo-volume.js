/* DART Meadow — ui/dm-atmo-volume.js (v385): the planet's air as WORLD GEOMETRY, not a camera-space effect.
 *
 * What it builds round any planet body (group-local, so it rides the body through space, flight, transitions and the menu):
 *   1. SHELL   a sphere mesh at R + top whose OWN material ray-marches single-scattering Rayleigh per fragment (the sandbox's
 *              method: view ray -> exp. density falloff -> per-sample sun ray -> 1/lambda^4 coefficients; the game's energy-
 *              conserving (1-e^-dTau) form).  Depth-tested like any other mesh, so ships / temples / moons occlude it by the
 *              ordinary depth buffer.  No full-screen pass, no scene-colour read, no render target.
 *   2. WAKE    up to 4 disturbance slots (uniform array).  A body moving through the air (the ship, the board, the camera
 *              rig) stamps a decaying, spreading cavity: the shell's density is thinned there and the wisps are pushed aside
 *              and swirled.  Decay + spread are CPU-side and allocation free.
 *   3. WISPS   volumetric gas particles: instanced camera-facing soft quads whose positions are a closed-form function of
 *              the instance id and time (differential rotation, altitude bias toward the surface), displaced by the same wake
 *              slots.  Depth-tested, additive, no storage buffers, no compute: it runs identically on WebGPU and the WebGL2
 *              fallback.  (A stateful SPH / compute gas is the phase-2 upgrade; see docs/atmo-volume.md.)
 *
 * Tiers (DMAtmoVolume.core.TIERS): 0 = shell scattering only (what phones get under pressure), 1 = + wake in the density,
 * 2 = + wisps, 3 = full.  Phones / tablets (Mali-G615, iPhone) are CAPPED at tier 1 and fall to 0 as the DMBudget 'atmo' stage
 * sheds; desktop ultra is 3.  Everything pure lives in `core` and is unit-tested under node (tools/tests/atmo-volume-unit.js).
 *
 * Flag: ?atmo=shell turns it on (index.html swaps the space post-process pass and the menu's glow shell for this);
 *       ?atmo=0 off; ?atmotier=0..3 forces a tier.  Any build error returns null and the caller keeps its classic shell.
 *
 *   const vol = DMAtmoVolume.create(THREE, THREE.TSL, { R, top, co:{sc:[..],ex:[..]}, falloff:5.5, tint:0x6688cc, sunDirU });
 *   parentGroup.add(vol.group); vol.update(dt, camera);   // or DMAtmoVolume.frame(camera, dt) for every live volume
 */
(function (root) {
  'use strict';
  const TWO_PI = Math.PI * 2;

  /* ───────────────────────── pure core ───────────────────────── */
  const TIERS = [
    { id: 0, name: 'scatter', view: 4, sun: 3, wake: 0, wisps: 0 },
    { id: 1, name: 'wake',    view: 6, sun: 3, wake: 2, wisps: 0 },
    { id: 2, name: 'wisps',   view: 8, sun: 4, wake: 3, wisps: 192 },
    { id: 3, name: 'full',    view: 10, sun: 5, wake: 4, wisps: 640 },
  ];
  const MAX_WAKE = 4;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // base tier from the device class + graphics preset, then shed by the DMBudget 'atmo' stage level (0..2) and exhaustion.
  // o: { mobile, preset ('low'|'medium'|'high'|'ultra'|'auto'), budgetLvl, exhausted, force (0..3 or null) }
  function tierFor(o) {
    o = o || {};
    if (o.force != null && isFinite(o.force)) return TIERS[clamp(o.force | 0, 0, 3)];
    const p = o.preset || 'medium';
    let base = p === 'low' ? 0 : p === 'medium' ? 1 : p === 'high' ? 2 : p === 'ultra' ? 3 : 1;
    if (o.mobile) base = Math.min(base, 1);                    // phones + tablets: never any wisps (Mali-G615 / iPhone frame-rate floor)
    let t = base - (o.budgetLvl | 0);
    if (o.exhausted) t = 0;
    return TIERS[clamp(t, 0, 3)];
  }
  // fragment-sample cost model of one shell pixel (relative units; used by the tests to pin the ordering and the phone ceiling)
  function cost(t) { return t.view * (t.sun + 1) + t.view * t.wake + (t.wisps ? Math.min(t.wisps, 640) * 0.02 : 0); }

  // wake strength 0..1 of a body at `alt` (height above the surface), `top` = air thickness: full inside the air, none beyond 3 tops
  function wakeStrength(alt, top, speed, refSpeed) {
    if (!(top > 0) || !(speed > 0)) return 0;
    const k = clamp(speed / Math.max(1e-6, refSpeed), 0, 1);
    const out = alt > top ? (alt - top) / top : 0;      // 0 inside, 1 per top above the shell
    const inside = clamp(1 - out / 3, 0, 1);
    return k * inside;
  }

  // fixed-size decaying disturbance set (no allocation after construction).  Positions are planet-centre relative (group-local).
  function createWake(n) {
    n = clamp(n | 0 || MAX_WAKE, 1, MAX_WAKE);
    const s = { n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), r: new Float32Array(n), s: new Float32Array(n), cool: 0 };
    s.push = function (x, y, z, r, str) {
      let k = -1, best = Infinity, merged = false;
      for (let i = 0; i < n; i++) {                                  // merge into a live slot that is close, else take the weakest
        if (s.s[i] > 0.02) { const d = Math.hypot(s.x[i] - x, s.y[i] - y, s.z[i] - z); if (d < 0.5 * Math.max(s.r[i], r)) { k = i; merged = true; break; } }
      }
      if (k < 0) for (let i = 0; i < n; i++) if (s.s[i] < best) { best = s.s[i]; k = i; }
      if (k < 0) return -1;
      const keep = merged;                                            // a merged slot is refreshed, never weakened; a replaced one starts fresh
      s.x[k] = x; s.y[k] = y; s.z[k] = z; s.r[k] = keep ? Math.max(s.r[k], r) : r; s.s[k] = Math.max(keep ? s.s[k] : 0, str);
      return k;
    };
    s.step = function (dt, tau, spread) {                          // exponential decay, slow spreading
      const f = Math.exp(-dt / (tau || 2.5));
      for (let i = 0; i < n; i++) { s.s[i] *= f; if (s.s[i] < 0.01) s.s[i] = 0; else s.r[i] += (spread || 0) * dt; }
    };
    // pack for a uniformArray(vec4 x 2n): [x,y,z,1/r^2] , [strength,0,0,0]
    s.pack = function (out) {
      for (let i = 0; i < n; i++) {
        const r = Math.max(1e-6, s.r[i]);
        out[i * 8] = s.x[i]; out[i * 8 + 1] = s.y[i]; out[i * 8 + 2] = s.z[i]; out[i * 8 + 3] = 1 / (r * r);
        out[i * 8 + 4] = s.s[i]; out[i * 8 + 5] = 0; out[i * 8 + 6] = 0; out[i * 8 + 7] = 0;
      }
      return out;
    };
    s.live = function () { let c = 0; for (let i = 0; i < n; i++) if (s.s[i] > 0.01) c++; return c; };
    return s;
  }

  // the mesh side / depth test for a camera at `dist` from the planet centre (inside the shell: back faces, no depth test)
  function shellSideFor(dist, shellR) { const inside = dist < shellR * 1.002; return { inside, side: inside ? 'back' : 'front', depthTest: !inside }; }

  // Rayleigh default coefficients (400/lambda)^4 x scatter, the same table the game's shells use
  function rayleigh(scatter) { const k = scatter == null ? 1 : scatter; return [Math.pow(400 / 700, 4) * k, Math.pow(400 / 530, 4) * k, Math.pow(400 / 440, 4) * k]; }
  function coefficients(o) { o = o || {}; if (o.co && o.co.sc && o.co.ex) return o.co; const ex = rayleigh(o.scatter == null ? 1.0 : o.scatter).map(v => v * 0.7); return { sc: ex.slice(), ex }; }

  // deterministic wisp hash (the shader uses the same fract(sin()) form): returns 0..1
  function hash(i, k) { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); }
  // closed-form wisp placement (group-local) at time t — the CPU twin of the vertex shader, used by the tests and for LOD bounds
  function wispPos(i, t, R, top) {
    const lon = hash(i, 1) * TWO_PI + t * (0.015 + 0.04 * hash(i, 5)) * (1 - 0.5 * Math.pow(hash(i, 3), 1.7));
    const sl = hash(i, 2) * 2 - 1, cl = Math.sqrt(1 - sl * sl), alt = Math.pow(hash(i, 3), 1.7) * 0.85 + 0.04;
    const rr = R + top * (alt + 0.03 * Math.sin(t * 0.3 + hash(i, 6) * TWO_PI));
    return { x: Math.cos(lon) * cl * rr, y: sl * rr, z: Math.sin(lon) * cl * rr, alt };
  }

  const core = { TIERS, MAX_WAKE, tierFor, cost, wakeStrength, createWake, shellSideFor, rayleigh, coefficients, hash, wispPos };

  /* ───────────────────────── runtime ───────────────────────── */
  const live = new Set();
  const Q = () => { try { return root.location ? root.location.search : ''; } catch (e) { return ''; } };
  function enabled() {
    const q = Q(); if (/[?&]atmo=0\b/.test(q)) return false; if (/[?&]atmo=shell\b/.test(q)) return true;
    try { if (root.DM_ATMO_SHELL_DEFAULT === true) return true; } catch (e) { }
    return false;
  }
  function deviceTier() {
    const g = root.GFX || {}, b = root.DMBudget, q = Q(), m = q.match(/[?&]atmotier=(\d)/);
    let preset = 'medium'; try { preset = (typeof root.resolvePreset === 'function' && root.resolvePreset()) || g.preset || 'medium'; } catch (e) { }
    return tierFor({ mobile: !!g.isMobile, preset, budgetLvl: b && b.on ? b.lvl('atmo') : 0, exhausted: !!(b && b.on && b.isExhausted && b.isExhausted()), force: m ? +m[1] : null });
  }

  function create(THREE, T, o) {
    o = o || {};
    try {
      if (!THREE || !T || !THREE.MeshBasicNodeMaterial || !T.Fn || !T.uniformArray) return null;
      const { Fn, float, vec3, vec4, uniform, uniformArray, exp, Loop, If, select, mix, smoothstep, clamp: tc, max, min, normalize, dot, cross, length, sqrt, fract, sin, cos, instanceIndex,
        positionWorld, positionLocal, cameraPosition, modelWorldMatrix, modelViewMatrix, cameraProjectionMatrix, uv } = T;
      const R = Math.max(1e-3, o.R || 1), top = Math.max(R * 0.01, o.top || R * 0.1), shellR = R + top;
      const co = coefficients(o), falloff = o.falloff != null ? o.falloff : 5.5;
      const sunDirU = o.sunDirU || uniform(new THREE.Vector3(1, 0.3, 0.2).normalize());
      const tint = new THREE.Color(o.tint != null ? o.tint : 0x6688cc);
      let tier = o.tier != null ? TIERS[clamp(o.tier | 0, 0, 3)] : deviceTier();
      const group = new THREE.Group(); group.name = 'DMAtmoVolume';

      // wake state + the uniform array that carries it (2 vec4 per slot)
      const wake = createWake(MAX_WAKE), packed = new Float32Array(MAX_WAKE * 8);
      const WU = uniformArray(Array.from({ length: MAX_WAKE * 2 }, () => new THREE.Vector4()), 'vec4');
      const syncWake = () => { wake.pack(packed); for (let i = 0; i < MAX_WAKE * 2; i++) WU.array[i].set(packed[i * 4], packed[i * 4 + 1], packed[i * 4 + 2], packed[i * 4 + 3]); };

      /* ── shell material ── */
      const buildShellColor = (view, sunN, nWake) => {
        const ex = co.ex.map(v => Math.max(1e-4, v)), ratio = co.sc.map((v, i) => v / ex[i]);
        const EX = vec3(ex[0], ex[1], ex[2]), RATIO = vec3(ratio[0], ratio[1], ratio[2]);
        const ctr = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz, ws = modelWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz.length();
        const Rw = float(R).mul(ws), ARw = float(shellR).mul(ws), iH = float(1 / top).div(ws);
        const raySphere = Fn(([rad, ro, rd]) => {
          const off = ro.sub(ctr), b = off.dot(rd).mul(2.0), c = off.dot(off).sub(rad.mul(rad)), disc = b.mul(b).sub(c.mul(4.0)), res = vec3(0, 0, 0).toVar();
          If(disc.greaterThanEqual(0.0), () => { const s = disc.sqrt(), near = b.negate().sub(s).div(2.0), far = b.negate().add(s).div(2.0);
            If(far.greaterThanEqual(0.0), () => { const d0 = near.max(0.0); res.assign(vec3(d0, far.sub(d0), 1.0)); }); });
          return res;
        });
        const baseDensity = (sp) => { const h01 = sp.sub(ctr).length().sub(Rw).mul(iH).clamp(0.0, 1.0); return exp(h01.negate().mul(falloff)).mul(float(1.0).sub(h01)); };
        // the wake thins the air where a body just went through (view samples only: the sun rays stay cheap)
        const wakeFactor = (sp) => {
          if (!nWake) return float(1.0);
          const rel = sp.sub(ctr).div(ws), cut = float(0).toVar();
          for (let k = 0; k < nWake; k++) { const A = WU.element(k * 2), S = WU.element(k * 2 + 1), d = rel.sub(A.xyz); cut.addAssign(S.x.mul(exp(dot(d, d).mul(A.w).negate()))); }
          return float(1.0).sub(cut.mul(0.8).clamp(0.0, 0.85));
        };
        const opticalDepth = Fn(([ro, rd, rl]) => { const st = rl.div(sunN), p = ro.toVar(), tot = float(0).toVar(); Loop(sunN, () => { tot.addAssign(baseDensity(p).mul(st)); p.addAssign(rd.mul(st)); }); return tot; });
        return Fn(() => {
          const ro = cameraPosition, rd = positionWorld.sub(cameraPosition).normalize();
          const hit = raySphere(ARw, ro, rd), surf = raySphere(Rw, ro, rd);
          const mStart = hit.x, mLen = select(surf.z.greaterThan(0.5), hit.y.min(surf.x.sub(mStart).max(0.0)), hit.y), acc = vec3(0, 0, 0).toVar();
          If(hit.z.greaterThan(0.5), () => {
            const st = mLen.div(view), p = ro.add(rd.mul(mStart)).toVar(), tauV = float(0).toVar();
            Loop(view, () => {
              const dTau = baseDensity(p).mul(wakeFactor(p)).mul(st).mul(iH), sh = raySphere(ARw, p, sunDirU), tauS = opticalDepth(p, sunDirU, sh.y).mul(iH);
              const Tr = exp(EX.negate().mul(tauV.add(tauS)));
              acc.addAssign(float(1.0).sub(exp(EX.negate().mul(dTau))).mul(RATIO).mul(Tr));
              tauV.addAssign(dTau); p.addAssign(rd.mul(st));
            });
          });
          return vec3(acc.x, min(acc.y, max(acc.x, acc.z)), acc.z);
        })();
      };
      const shellMat = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.FrontSide, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending });
      let shellKey = '';
      const applyShell = () => {
        const key = tier.view + '|' + tier.sun + '|' + tier.wake; if (key === shellKey) return; shellKey = key;
        const c = buildShellColor(tier.view, tier.sun, tier.wake);
        shellMat.colorNode = c; shellMat.opacityNode = tc(c.r.add(c.g).add(c.b).mul(o.opacityScale != null ? o.opacityScale : 0.55), 0.0, 1.0); shellMat.needsUpdate = true;
      };
      applyShell();
      const shell = new THREE.Mesh(new THREE.SphereGeometry(shellR, o.segW || 48, o.segH || 32), shellMat);
      shell.name = 'JOTS_DustyAtmo'; shell.renderOrder = 2; shell.frustumCulled = false; shell.raycast = () => { };
      Object.assign(shell.userData, { jotsAtmo: true, shellR, planetR: R, atmoTop: top, atmoKind: o.kind || 'other', dmAtmoVolume: true, flipSide: true });
      group.add(shell);

      /* ── wisps: closed-form instanced gas puffs, wake displaced ── */
      let wisps = null;
      const buildWisps = () => {
        const N = TIERS[3].wisps, geo = new THREE.PlaneGeometry(1, 1);
        const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
        const tU = uniform(0), gainU = uniform(1), tintV = vec3(tint.r, tint.g, tint.b).mul(0.55).add(vec3(0.45, 0.5, 0.6));
        const h = (i, k) => fract(sin(i.mul(12.9898).add(k * 78.233)).mul(43758.5453));
        const i = float(instanceIndex), lon = h(i, 1).mul(TWO_PI).add(tU.mul(h(i, 5).mul(0.04).add(0.015)).mul(float(1).sub(h(i, 3).pow(1.7).mul(0.5))));
        const sl = h(i, 2).mul(2).sub(1), cl = sqrt(max(float(1).sub(sl.mul(sl)), 0.0)), alt = h(i, 3).pow(1.7).mul(0.85).add(0.04);
        const rr = float(R).add(float(top).mul(alt.add(sin(tU.mul(0.3).add(h(i, 6).mul(TWO_PI))).mul(0.03))));
        const p0 = vec3(cos(lon).mul(cl).mul(rr), sl.mul(rr), sin(lon).mul(cl).mul(rr));
        // the wake pushes puffs away from each disturbance and swirls them round the local up axis; .w = how stirred (0..)
        const stir = Fn(([q]) => {
          const off = vec3(0, 0, 0).toVar(), push = float(0).toVar(), up = normalize(q);
          for (let k = 0; k < MAX_WAKE; k++) {
            const A = WU.element(k * 2), S = WU.element(k * 2 + 1), d = q.sub(A.xyz), w = S.x.mul(exp(dot(d, d).mul(A.w).negate())), dn = normalize(d.add(vec3(1e-4, 1e-4, 1e-4)));
            off.addAssign(dn.mul(w).mul(top * 0.9).add(cross(dn, up).mul(w).mul(top * 0.6))); push.addAssign(w);
          }
          return vec4(off, push);
        });
        const st = stir(p0), pw = p0.add(st.xyz), vPush = T.varying ? T.varying(st.w) : st.w, vAlt = T.varying ? T.varying(alt) : alt, vNrm = T.varying ? T.varying(normalize(pw)) : normalize(pw);
        const P = { p: pw, alt: vAlt, push: vPush, i }, size = float(top).mul(h(i, 4).mul(0.5).add(0.18));
        mat.vertexNode = Fn(() => { const mv = modelViewMatrix.mul(vec4(P.p, 1.0)), off = positionLocal.mul(size); return cameraProjectionMatrix.mul(vec4(mv.x.add(off.x), mv.y.add(off.y), mv.z, mv.w)); })();
        const nrm = vNrm, lit = smoothstep(-0.15, 0.25, dot(nrm, sunDirU)), d = uv().sub(0.5).length().mul(2.0);
        mat.colorNode = tintV.mul(lit.mul(0.8).add(0.12));
        // thin with height; the soft fall-off is the puff; a cleared (wake-pushed) puff brightens a little as it is stirred
        mat.opacityNode = smoothstep(1.0, 0.1, d).mul(float(1).sub(P.alt.mul(0.6))).mul(float(0.09).add(P.push.mul(0.1))).mul(gainU).mul(lit.mul(0.85).add(0.15));
        const mesh = new THREE.InstancedMesh(geo, mat, N); mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.raycast = () => { }; mesh.name = 'DMAtmoWisps';
        const id = new THREE.Matrix4(); for (let i = 0; i < N; i++) mesh.setMatrixAt(i, id); mesh.instanceMatrix.needsUpdate = true;
        return { mesh, tU, gainU, mat };
      };
      const applyWisps = () => {
        if (tier.wisps > 0 && !wisps) { try { wisps = buildWisps(); group.add(wisps.mesh); } catch (e) { wisps = null; try { console.warn('[atmo-volume] wisps off:', e); } catch (_) { } tier = TIERS[Math.min(tier.id, 1)]; } }
        if (wisps) { wisps.mesh.count = tier.wisps; wisps.mesh.visible = tier.wisps > 0; }
      };
      applyWisps();

      /* ── per-frame ── */
      const wp = new THREE.Vector3(), prev = new THREE.Vector3(); let havePrev = false, clock = 0, emitCool = 0;
      const vol = {
        group, shell, pinned: o.tier != null, get wisps() { return wisps && wisps.mesh; }, wake, R, top, shellR, get tier() { return tier; }, sunDirU,
        setSun(v) { if (sunDirU.value && v) sunDirU.value.copy(v); },
        setTier(n) { tier = TIERS[clamp(n | 0, 0, 3)]; applyShell(); applyWisps(); },
        // camera / body at world position `cam` (a THREE.Camera or a Vector3); dt seconds.  Stamps its wake and advances the gas.
        update(dt, cam) {
          dt = clamp(dt || 0, 0, 0.25); clock += dt;
          const cpos = cam && cam.isCamera ? cam.position : cam; if (!cpos) return;
          group.updateWorldMatrix(true, false);
          const ws = group.matrixWorld.getMaxScaleOnAxis() || 1;
          // inside / outside the shell: which faces cover the pixels, and whether depth hides them
          wp.setFromMatrixPosition(group.matrixWorld); const dist = cpos.distanceTo(wp), sd = shellSideFor(dist / ws, shellR);
          const side = sd.inside ? THREE.BackSide : THREE.FrontSide; if (shellMat.side !== side || shellMat.depthTest !== sd.depthTest) { shellMat.side = side; shellMat.depthTest = sd.depthTest; shellMat.needsUpdate = true; }
          // wake from the body's own motion
          if (tier.wake > 0) {
            if (havePrev && dt > 1e-4) {
              emitCool -= dt;
              const spd = prev.distanceTo(cpos) / dt / ws;
              if (emitCool <= 0) {
                const rel = group.worldToLocal(wp.copy(cpos)), alt = rel.length() - R, st = wakeStrength(alt, top, spd, o.refSpeed || top * 1.5);
                if (st > 0.02) { wake.push(rel.x, rel.y, rel.z, top * 0.22, st); emitCool = 0.12; }
              }
            }
            prev.copy(cpos); havePrev = true;
            wake.step(dt, 2.6, top * 0.05); syncWake();
          } else if (wake.live()) { wake.step(dt, 0.6, 0); syncWake(); }
          if (wisps) { wisps.tU.value = clock; }
        },
        // an explicit disturbance (an explosion, a landing, a skim): world position, world radius, 0..1
        disturb(worldPos, radius, strength) { const ws = group.matrixWorld.getMaxScaleOnAxis() || 1, rel = group.worldToLocal(wp.copy(worldPos)); wake.push(rel.x, rel.y, rel.z, (radius || top * 0.25) / ws, clamp(strength == null ? 1 : strength, 0, 1)); syncWake(); },
        setTime(t) { clock = t || 0; if (wisps) wisps.tU.value = clock; },   // callers with their own clock (the menu world)
        setGain(g) { if (wisps) wisps.gainU.value = g; },
        dispose() { live.delete(vol); try { group.removeFromParent(); } catch (e) { } try { shell.geometry.dispose(); shellMat.dispose(); if (wisps) { wisps.mesh.geometry.dispose(); wisps.mat.dispose(); } } catch (e) { } },
      };
      live.add(vol);
      return vol;
    } catch (e) { try { console.warn('[atmo-volume] build failed, classic shell kept:', e); } catch (_) { } return null; }
  }

  // advance every live volume (the game calls this once per frame from the space frame; harmless when none exist)
  let _tierT = 0;
function frame(cam, dt) {
  _tierT += dt || 0;
  if (_tierT > 2) { _tierT = 0; try { const t = deviceTier(); for (const v of live) if (!v.pinned && v.tier.id !== t.id) v.setTier(t.id); } catch (e) { } }   // DMBudget sheds / restores the tier live
  for (const v of live) { try { if (v.group.parent) v.update(dt, cam); } catch (e) { } } }

  const API = { core, create, frame, enabled, deviceTier, live: () => live.size, version: 385 };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.DMAtmoVolume = API;
})(typeof window !== 'undefined' ? window : globalThis);
