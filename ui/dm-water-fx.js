/* DART Meadow — water effects: spray / splash / mist sprites, the skyboard wake, footstep + landing ripples, shore-break spray, underwater fog + light shafts.
 *
 *   Registered by ui/dm-water.js as S.fx (tick(dt, ctx, S), dispose()); everything is built lazily on the first tick after the sea exists, on the scene the sea lives in.
 *   ?waterfx=0 switches the lot off (the sea itself stays).
 *
 *   Cost   spray   : ONE instanced draw (a billboard quad x tier.spray, 192 on High, 320 Ultra, 96 Medium, x0.6 on phones); the look is one 512x512 lossless sheet
 *                    (assets/water/spray-sheet.webp, 1.3 MB on the GPU): R = looping spray fan, G = one-shot crown splash, B = looping mist puff. Frames are blended
 *                    two at a time. CPU: a ballistic pool step + a compaction into two preallocated attribute arrays (no allocation in the tick).
 *            wake    : ONE draw, a 5-wide ribbon (<= 72 history points) on the surface; foam breakup from the baked detail tile.
 *            shafts  : ONE draw of 12 additive quads, only while the camera is under the surface; fog is the scene fog recoloured (no extra pass).
 *   Low tier: no spray / wake / shafts (the sea alone, plus the ripple ring); Medium: spray 96 + wake.
 *   The sheet goes through the serial heavy-load queue (DMFac.heavy) with a DMCrumb breadcrumb; until it lands, nothing is drawn.
 *
 *   Techniques: Kelvin wake angle (19.47 deg) for the arms of the ribbon; ballistic droplets under the PLANET's gravity (low-g worlds hang longer); the sprite sheet is a
 *   baked 2-D particle sim (tools/water/sheets.js) in the manner of flipbook-driven VFX sprites. Inspired by the look of Disney's Moana (Splash) and Weta's Avatar water,
 *   never by their assets.
 */
(function (root) {
  'use strict';
  const W = root, D = () => W.DMWater, C = () => W.DMWaterCore;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const rnd = Math.random;
  const flagOff = () => { try { return /[?&]waterfx=0\b/.test(W.location.search); } catch (e) { return false; } };
  const sheetURL = () => W.DM_WATER_SHEET || 'assets/water/spray-sheet.webp';
  const crumb = (...a) => { try { const c = W.DMCrumb; if (c) { const k = a[0]; if (k === 'begin' && c.begin) c.begin(a[1]); else if (k === 'end' && c.end) c.end(a[1]); else if (k === 'live' && c.live) c.live(a[1], a[2]); } } catch (e) { } };

  function create(S) {
    const THREE = W.THREE, T = THREE.TSL, tier = S.tier, core = C();
    const { Fn, float, vec2, vec3, vec4, mix, smoothstep, clamp: tclamp, pow, abs, sin, cos, floor, fract, texture, select, attribute, varying, step,
      positionGeometry, positionWorld, cameraViewMatrix, cameraProjectionMatrix, uv } = T;
    const U = S.U, P = S.P, tx = S.tex;
    const fx = { built: false, dead: false, sheetOK: false, lastFlag: 0 };
    const seaBase = () => (S.mesh ? S.mesh.position.y : 0);
    const surfY = (x, z) => seaBase() + D().heightAt(x, z);

    /* ───────────── spray / splash / mist pool (one instanced draw) ───────────── */
    const NS = tier.spray | 0;
    let spray = null, sprayMesh = null, sheetTex = null, iposA = null, imetaA = null;
    if (NS > 0) {
      spray = new core.Spray(NS);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      iposA = new THREE.InstancedBufferAttribute(new Float32Array(NS * 4), 4); imetaA = new THREE.InstancedBufferAttribute(new Float32Array(NS * 4), 4);
      iposA.setUsage(THREE.DynamicDrawUsage); imetaA.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('ipos', iposA); g.setAttribute('imeta', imetaA); g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      const ph = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType); ph.needsUpdate = true; ph.colorSpace = THREE.NoColorSpace;
      fx.sheetU = { value: ph };
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const ip = attribute('ipos', 'vec4'), im = attribute('imeta', 'vec4');
      // billboard: the quad is offset in VIEW space around the instance centre (rot tilts it), anchored a little above its bottom edge (the jet's root)
      const q = positionGeometry.xy, rot = im.z, cs = cos(rot), sn = sin(rot), qy = q.y.sub(0.04);
      const off = vec2(q.x.mul(cs).sub(qy.mul(sn)), q.x.mul(sn).add(qy.mul(cs))).mul(ip.w);
      const vc = cameraViewMatrix.mul(vec4(ip.xyz, 1.0));
      m.vertexNode = cameraProjectionMatrix.mul(vec4(vc.x.add(off.x), vc.y.add(off.y), vc.z, 1.0));
      const age = im.x, ty = im.y, vAge = varying(age, 'vAge'), vTy = varying(ty, 'vTy'), vA = varying(im.w, 'vA'), vQ = varying(vec2(q.x.add(0.5), q.y), 'vQ');
      const isCrown = step(abs(vTy.sub(1.0)), 0.5), isMist = step(abs(vTy.sub(2.0)), 0.5), isR = float(1.0).sub(isCrown).sub(isMist);
      const sheet = texture(fx.sheetU.value);
      const frame = (f) => {                                               // f: 0..15 integer-ish; returns the channel-selected coverage
        const col = floor(f.mod(4.0)), row = floor(f.div(4.0)), tuv = vec2(col.add(vQ.x.mul(0.96).add(0.02)).mul(0.25), row.add(float(1.0).sub(vQ.y).mul(0.96).add(0.02)).mul(0.25));
        const s = sheet.sample(tuv); return s.x.mul(isR).add(s.y.mul(isCrown)).add(s.z.mul(isMist));
      };
      const ff = vAge.mul(15.999), f0 = floor(ff), fr = ff.sub(f0), f1 = mix(f0.add(1.0).mod(16.0), f0.add(1.0).min(15.0), isCrown);
      const cov = mix(frame(f0), frame(f1), fr);
      const fade = smoothstep(0.0, 0.05, vAge).mul(float(1.0).sub(smoothstep(0.82, 1.0, vAge)));
      const light = U.sunUp.mul(0.5).add(0.5);
      const foam = U.foamCol.mul(light).add(U.sunCol.mul(0.16).mul(U.sunUp)), mistC = mix(foam, U.skyHor.mul(0.9), 0.5);
      const glow = U.glowCol.mul(U.glow).mul(U.night).mul(0.8).mul(float(0.5).add(cov.mul(0.5)));
      m.colorNode = mix(foam, mistC, isMist).add(glow);
      m.opacityNode = cov.mul(fade).mul(vA).mul(mix(float(0.92), float(0.5), isMist));
      m.fog = true;
      sprayMesh = new THREE.Mesh(g, m); sprayMesh.frustumCulled = false; sprayMesh.renderOrder = 4; sprayMesh.visible = false; sprayMesh.name = 'dmWaterSpray';
      fx.sprayMat = m; fx.sheetNode = sheet;
    }

    /* ───────────── wake ribbon (one draw) ───────────── */
    const NW = tier.wake ? 72 : 0;
    let wake = null, wakeMesh = null, wposA = null, wattA = null, wakeVerts = null;
    if (NW) {
      wake = new core.Wake(NW); wakeVerts = new Float32Array(NW * 5 * 5);
      const g = new THREE.BufferGeometry();
      wposA = new THREE.BufferAttribute(new Float32Array(NW * 5 * 3), 3); wattA = new THREE.BufferAttribute(new Float32Array(NW * 5 * 3), 3);
      wposA.setUsage(THREE.DynamicDrawUsage); wattA.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', wposA); g.setAttribute('wk', wattA);
      const idx = []; for (let k = 0; k < NW - 1; k++) for (let c = 0; c < 4; c++) { const a = k * 5 + c, b = a + 1, a2 = a + 5, b2 = b + 5; idx.push(a, b, b2, a, b2, a2); }
      g.setIndex(idx); g.setDrawRange(0, 0); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const wk = attribute('wk', 'vec3'), vu = varying(wk.x, 'wU'), vv = varying(wk.y, 'wV'), vi = varying(wk.z, 'wI');
      const lace = texture(tx.detail, positionWorld.xz.mul(0.09).add(vec2(U.time.mul(0.012), U.time.mul(-0.009)))).x;
      const lace2 = texture(tx.detail, positionWorld.xz.mul(0.31).add(vec2(0.37, U.time.mul(0.02)))).y;
      const across = abs(vu), core0 = float(1.0).sub(smoothstep(0.0, 0.5, across)), arm = smoothstep(0.55, 0.85, across).mul(float(1.0).sub(smoothstep(0.9, 1.0, across)));
      const pat = core0.mul(0.9).add(arm.mul(0.55)).add(0.1);
      const brk = lace.mul(0.6).add(lace2.mul(0.4));
      const a = smoothstep(0.18, 0.62, brk.add(vi.mul(0.75)).sub(0.28)).mul(pat).mul(vi).mul(smoothstep(0.0, 0.03, vv)).mul(0.92);
      const light = U.sunUp.mul(0.55).add(0.45);
      m.colorNode = U.foamCol.mul(light).add(U.glowCol.mul(U.glow).mul(U.night).mul(0.9)).mul(float(0.82).add(lace2.mul(0.2)));
      m.opacityNode = tclamp(a, 0.0, 0.94); m.fog = true;
      wakeMesh = new THREE.Mesh(g, m); wakeMesh.frustumCulled = false; wakeMesh.renderOrder = 3; wakeMesh.visible = false; wakeMesh.name = 'dmWaterWake';
    }

    /* ───────────── underwater: light shafts (additive, 12 quads) ───────────── */
    let shaftMesh = null;
    if (tier.under && tier.caustic) {
      const NQ = 12, pos = [], uvs = [], idx = [], len = 46;
      for (let i = 0; i < NQ; i++) {
        const a = (i / NQ) * Math.PI * 2 + (i % 3) * 0.4, r = 4 + (i * 7 % 17) * 1.6, wd = 1.5 + (i * 5 % 7) * 0.55, cx = Math.cos(a) * r, cz = Math.sin(a) * r, yw = a * 1.7 + i;
        const dx = Math.cos(yw) * wd, dz = Math.sin(yw) * wd, b = pos.length / 3;
        pos.push(cx - dx, 0, cz - dz, cx + dx, 0, cz + dz, cx + dx, -len, cz + dz, cx - dx, -len, cz - dz); uvs.push(0, 0, 1, 0, 1, 1, 0, 1); idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(idx);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      fx.shaftU = { amt: T.uniform(0), sh: T.uniform(new THREE.Vector3(0, -1, 0)) };
      const u2 = uv(), across = abs(u2.x.mul(2.0).sub(1.0)), prof = pow(float(1.0).sub(across), 1.6), down = pow(float(1.0).sub(u2.y), 1.4).mul(smoothstep(0.0, 0.04, u2.y));
      const cz = texture(tx.caustic, positionWorld.xz.mul(0.045).add(vec2(U.time.mul(0.02), 0.0)).add(positionWorld.y.mul(0.012))).x;
      m.colorNode = U.scatter.mul(0.9).add(U.sunCol.mul(0.25)).mul(prof.mul(down).mul(float(0.65).add(cz.mul(0.6))).mul(fx.shaftU.amt));
      m.opacityNode = float(1.0); m.fog = false;
      shaftMesh = new THREE.Mesh(g, m); shaftMesh.frustumCulled = false; shaftMesh.renderOrder = 5; shaftMesh.visible = false; shaftMesh.name = 'dmWaterShafts';
      // shafts follow the light: a vertical quad sheared along the refracted sun ray (done on the CPU as a rotation of the mesh's matrix, no per-vertex work)
    }

    /* ───────────── state ───────────── */
    const st = fx.st = { px: 0, pz: 0, py: 0, have: false, vx: 0, vz: 0, spd: 0, contact: false, wasContact: false, stride: 0, bowAcc: 0, mistAcc: 0, shoreAcc: 0, shoreBurst: 0, wakeAcc: 0,
      fogSaved: false, fogCol: null, fogNear: 0, fogFar: 0, lastSet: null, vy: 0, riding: false, wading: false };
    const seaYAt = (x, z) => surfY(x, z);
    const gSpray = () => (P.spray && P.spray.g) || 17.5;

    function loadSheet() {
      if (!spray) return;
      const url = sheetURL(), load = async (alive) => {
        crumb('begin', 'water:sheet');
        try {
          const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status); const blob = await res.blob(); if (alive && alive() === false) return;
          const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          const t = new THREE.Texture(bmp); t.colorSpace = THREE.NoColorSpace; t.flipY = false; t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
          if (fx.dead) { t.dispose(); try { bmp.close && bmp.close(); } catch (e) { } return; }
          sheetTex = t; fx.sheetNode.value = t; fx.sheetOK = true; S.sprayTex = t; D()._log('spray sheet', bmp.width + 'x' + bmp.height);
        } catch (e) { try { console.warn('[water] spray sheet', e); } catch (_) { } fx.sheetFail = true; }
        crumb('end', 'water:sheet');
      };
      const F = W.DMFac;
      if (F && F.heavy) F.heavy('water:sheet', load, () => { }); else load();
    }

    function build(scene) {
      if (fx.built || !scene) return; fx.built = true; fx.scene = scene;
      [sprayMesh, wakeMesh, shaftMesh].forEach((o) => { if (o) scene.add(o); });
      loadSheet(); D()._log('fx built', 'spray', NS, 'wake', NW, 'shafts', !!shaftMesh);
    }

    /* ───────────── emitters ───────────── */
    function sprayAt(x, y, z, vx, vy, vz, size, life, type, rot) { if (spray) spray.spawn(x, y, z, vx, vy, vz, size, life, type, rot || 0); }
    function splash(x, z, strength) {              // a crown + droplets + a ripple (entering, landing, a hard footfall)
      const y = surfY(x, z), s = clamp(strength, 0.2, 1.6), hang = P.spray.hang || 1, g = gSpray();
      if (spray) {
        sprayAt(x, y + 0.05, z, 0, 0, 0, 2.2 + 3.2 * s, (0.55 + 0.25 * s) * hang, 1, 0);
        const n = Math.round(3 + 7 * s);
        for (let i = 0; i < n; i++) { const a = rnd() * 6.283, sp = (1.2 + rnd() * 2.6) * (0.5 + s), up = (2.5 + rnd() * 4) * (0.5 + 0.6 * s) * Math.sqrt(g / 17.5) ; sprayAt(x + Math.cos(a) * 0.3, y + 0.1, z + Math.sin(a) * 0.3, Math.cos(a) * sp, up, Math.sin(a) * sp, 0.55 + rnd() * 0.7, (0.5 + rnd() * 0.5) * hang, 3, (rnd() - 0.5) * 0.5); }
        for (let i = 0; i < 2; i++) sprayAt(x + (rnd() - 0.5), y + 0.3, z + (rnd() - 0.5), (rnd() - 0.5) * 0.6, 0.5, (rnd() - 0.5) * 0.6, 2.2 + 2.4 * s, 1.1 * hang, 2, rnd() * 6.283);
      }
      D().ripple(x, z, clamp(0.25 + 0.5 * s, 0.2, 1.0));
    }

    function bowSpray(dt, x, z, dx, dz, spd, y) {          // dx,dz unit forward
      if (!spray) return;
      const hang = P.spray.hang || 1, k = clamp((spd - 3.0) / 14.0, 0, 1.4), rate = (P.spray.rate || 0.6) * k * Math.min(70, NS * 0.34);
      st.bowAcc += rate * dt;
      const sx = -dz, sz = dx, sy = surfY(x, z);
      while (st.bowAcc >= 1) {
        st.bowAcc -= 1; const side = rnd() < 0.5 ? -1 : 1, lat = (0.5 + rnd() * 1.1) * side, fwd = 0.6 + rnd() * 1.6;
        const px = x + dx * fwd + sx * lat * 0.5, pz = z + dz * fwd + sz * lat * 0.5;
        sprayAt(px, sy + 0.1, pz, sx * lat * (1.5 + k * 1.2) + dx * spd * 0.25, (1.6 + rnd() * 2.8) * (0.6 + k * 0.5) * Math.sqrt(gSpray() / 17.5), sz * lat * (1.5 + k * 1.2) + dz * spd * 0.25, 0.9 + rnd() * 1.2 + k * 0.7, (0.55 + rnd() * 0.45) * hang, rnd() < 0.7 ? 3 : 0, side * (0.15 + rnd() * 0.25));
      }
      st.mistAcc += rate * 0.22 * dt;
      while (st.mistAcc >= 1) { st.mistAcc -= 1; sprayAt(x - dx * (0.5 + rnd() * 2.4) + (rnd() - 0.5) * 1.6, sy + 0.4, z - dz * (0.5 + rnd() * 2.4) + (rnd() - 0.5) * 1.6, -dx * 0.5 + (rnd() - 0.5) * 0.6, 0.35, -dz * 0.5 + (rnd() - 0.5) * 0.6, 3.2 + rnd() * 2.8 + k * 1.5, (1.4 + rnd() * 0.9) * hang, 2, rnd() * 6.283); }
    }

    // spray + mist thrown off the breaking line: random shore-field cells at the depth where the sea shader breaks the wave, when the wave phase passes them
    function shoreSpray(dt, px, pz) {
      const sh = S.shore; if (!spray || !sh || !sh.has || !sh.depth || !sh.T) return;
      const wcov = clamp(P.whitecap * 1.2 + 0.25, 0.15, 1), Ps = Math.sqrt(2 * Math.PI * P.lamS / P.g), dB = Math.max(0.5, 1.15 * P.HsS), N = sh.N, cell = sh.cell, hang = P.spray.hang || 1;
      st.shoreAcc += dt * (tier.mobile ? 5 : 8) * wcov;
      let tries = 0;
      while (st.shoreAcc >= 1 && tries++ < 30) {
        const k = (rnd() * N * N) | 0, d = sh.depth[k]; if (d < dB * 0.45 || d > dB * 1.05) continue;
        const i = k % N, j = (k / N) | 0, x = sh.cx - sh.R + cell * 0.5 + i * cell, z = sh.cz - sh.R + cell * 0.5 + j * cell, dd = Math.hypot(x - px, z - pz); if (dd > 90) continue;
        const ph = ((S.t - sh.T[k]) / Ps); const f = ph - Math.floor(ph); if (f > 0.16) continue;      // only while the crest passes
        st.shoreAcc -= 1; const gx = sh.T[Math.min(N * N - 1, k + 1)] - sh.T[Math.max(0, k - 1)], gz = sh.T[Math.min(N * N - 1, k + N)] - sh.T[Math.max(0, k - N)], gl = Math.hypot(gx, gz) || 1, vx = gx / gl, vz = gz / gl; // direction of travel
        const y = seaBase() + 0.5;
        sprayAt(x, y, z, vx * (1.5 + rnd() * 2), (2 + rnd() * 3.5) * Math.sqrt(gSpray() / 17.5), vz * (1.5 + rnd() * 2), 1.4 + rnd() * 1.6 + 0.3 * Math.sqrt(P.HsS), (0.6 + rnd() * 0.5) * hang, 0, (rnd() - 0.5) * 0.3);
        if (rnd() < 0.5) sprayAt(x, y + 0.4, z, vx * 0.8, 0.5, vz * 0.8, 3 + rnd() * 3, (1.6 + rnd()) * hang, 2, rnd() * 6.283);
      }
      if (st.shoreAcc > 4) st.shoreAcc = 4;
    }

    /* ───────────── underwater ───────────── */
    function underwater(dt, ctx) {
      const u = S.under, cam = ctx.camera, sc = ctx.scene || fx.scene, fog = sc && sc.fog;
      if (shaftMesh) {
        const on = u > 0.04 && U.sunUp.value > 0.05;
        shaftMesh.visible = on;
        if (on && cam) {
          fx.shaftU.amt.value = clamp(u, 0, 1) * U.sunUp.value * 0.42 * (0.7 + 0.3 * Math.sin(S.t * 0.6));
          // refracted sun ray (Snell, n = 1.33): the shafts lean along it; the mesh is sheared by a basis change (x,z lean as the ray's horizontal part per unit depth)
          const sd = U.sunDir.value, sinI = Math.sqrt(Math.max(0, 1 - sd.y * sd.y)), sinR = sinI / 1.33, cosR = Math.sqrt(1 - sinR * sinR), hl = Math.hypot(sd.x, sd.z) || 1;
          const lx = -sd.x / hl * (sinR / cosR), lz = -sd.z / hl * (sinR / cosR);          // horizontal offset per unit of depth (the light goes away from the sun)
          // shear: x' = x + lx*(-y), z' = z + lz*(-y)  (y is negative below the surface)
          const e = shaftMesh.matrix; shaftMesh.matrixAutoUpdate = false;
          e.set(1, -lx, 0, Math.round(cam.position.x / 4) * 4,   0, 1, 0, seaBase() + 0.0,   0, -lz, 1, Math.round(cam.position.z / 4) * 4,   0, 0, 0, 1);
          shaftMesh.matrixWorldNeedsUpdate = true; shaftMesh.updateMatrixWorld(true);
        }
      }
      // fog: the sea's own colour, short reach (Beer-Lambert-ish: far ~ 1 / absorption)
      if (fog && fog.color) {
        if (u > 0.02) {
          if (!st.fogSaved) { st.fogCol = st.fogCol || new THREE.Color(); st.lastSet = st.lastSet || new THREE.Color(); st.fogCol.copy(fog.color); st.fogSaved = true; }
          const a = u * u * (3 - 2 * u), l = 0.25 + 0.75 * U.sunUp.value;
          const dc = U.deep.value, sc2 = U.scatter.value; fog.color.setRGB(st.fogCol.r, st.fogCol.g, st.fogCol.b).lerp(st.lastSet.setRGB((dc.r * 0.6 + sc2.r * 0.4) * l, (dc.g * 0.6 + sc2.g * 0.4) * l, (dc.b * 0.6 + sc2.b * 0.4) * l), a);
          st.lastSet.copy(fog.color);
          fog.near = fog.near * (1 - a) + 0.5 * a; fog.far = Math.exp(Math.log(Math.max(60, fog.far)) * (1 - a) + Math.log(64) * a);
        } else if (st.fogSaved) { if (fog.color.equals(st.lastSet)) fog.color.copy(st.fogCol); st.fogSaved = false; }
      }
    }

    /* ───────────── per-frame ───────────── */
    fx.tick = function (dt, ctx, SS) {
      if (fx.dead) return; ctx = ctx || {};
      if (!fx.built) { const sc = ctx.scene || (S.mesh && S.mesh.parent); if (S.ready >= 1 && sc) build(sc); else return; }
      const px = ctx.x, pz = ctx.z, mode = ctx.mode;
      // player kinematics
      if (px != null) {
        const py = ctx.y != null ? ctx.y : (ctx.camera ? ctx.camera.position.y : 0);
        if (st.have && dt > 1e-4) { const vx = (px - st.px) / dt, vz = (pz - st.pz) / dt, vy = (py - st.py) / dt; if (Math.abs(vx) + Math.abs(vz) > 400) { st.vx = st.vz = st.vy = 0; } else { const k = Math.min(1, dt * 10); st.vx += (vx - st.vx) * k; st.vz += (vz - st.vz) * k; st.vy += (vy - st.vy) * k; } }
        st.px = px; st.pz = pz; st.py = py; st.have = true; st.spd = Math.hypot(st.vx, st.vz);
        const H = ctx.H, hg = H ? H(px, pz) : -1e3, dep = seaBase() - hg, ys = surfY(px, pz), hAbove = py - ys;
        const fly = mode === 'fly', walk = mode === 'walk';
        st.wasContact = st.contact;
        const rideNow = fly && dep > 0.3 && hAbove < 2.6 && hAbove > -3; const wadeNow = walk && dep > 0.06 && hAbove < 0.9;
        st.contact = rideNow || wadeNow; st.riding = rideNow; st.wading = wadeNow;
        if (st.contact && !st.wasContact && Math.abs(st.vy) > 1.5) splash(px, pz, clamp(Math.abs(st.vy) * 0.09, 0.3, 1.5));
        else if (st.contact && !st.wasContact && wadeNow) splash(px, pz, 0.35);
        if (st.contact && st.spd > 0.4) {
          const dx = st.vx / st.spd, dz = st.vz / st.spd;
          if (rideNow) {
            bowSpray(dt, px, pz, dx, dz, st.spd, py);
            if (wake) {
              const gap = clamp(st.spd * 0.06, 0.6, 2.5), lx = wake.count ? wake.p[((wake.head - 1 + wake.n) % wake.n) * 5] : 1e9, lz = wake.count ? wake.p[((wake.head - 1 + wake.n) % wake.n) * 5 + 1] : 1e9;
              if (Math.hypot(px - lx, pz - lz) > gap) wake.push(px - dx * 0.6, pz - dz * 0.6, S.t, st.spd, 1.5);
            }
          } else if (wadeNow) {
            st.stride += st.spd * dt; const sl = clamp(1.1 + st.spd * 0.16, 1.4, 3.2);
            if (st.stride > sl) { st.stride = 0; const a = clamp(0.2 + st.spd * 0.05, 0.2, 0.55); D().ripple(px + dx * 0.4, pz + dz * 0.4, a); if (spray && st.spd > 2.5) { const hang = P.spray.hang || 1; for (let i = 0; i < 3; i++) sprayAt(px + dx * 0.5 + (rnd() - 0.5) * 0.6, ys + 0.1, pz + dz * 0.5 + (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 1.2 + dx * st.spd * 0.2, 1.2 + rnd() * 1.8, (rnd() - 0.5) * 1.2 + dz * st.spd * 0.2, 0.5 + rnd() * 0.5, 0.5 * hang, 3, 0); } }
          }
        } else if (walk && !st.contact && st.spd > 0.8 && W.DMGround && W.DMGround.wetAt) {                 // puddle footfalls on wet ground
          st.stride += st.spd * dt; const sl = clamp(1.4 + st.spd * 0.14, 1.6, 3.4);
          if (st.stride > sl) { st.stride = 0; const wt = W.DMGround.wetAt(px, pz); if (wt > 0.35) { D().ripple(px + st.vx / st.spd * 0.4, pz + st.vz / st.spd * 0.4, clamp(0.1 + (wt - 0.35) * 0.4 + st.spd * 0.02, 0.1, 0.32)); } }
        }
        if (spray && px != null) shoreSpray(dt, px, pz);
      }
      // pools
      if (spray) {
        const live = spray.step(dt, gSpray(), 0.9, seaYAt);
        let n = 0; const p = spray.p, m = spray.m, ia = iposA.array, ma = imetaA.array;
        for (let i = 0; i < spray.n; i++) {
          const o = i * 4; const life = m[o + 1]; if (life <= 0) continue;
          const u = m[o] / life, ty = m[o + 2]; ia[n * 4] = p[o]; ia[n * 4 + 1] = p[o + 1]; ia[n * 4 + 2] = p[o + 2]; ia[n * 4 + 3] = p[o + 3] * (ty === 2 ? 0.7 + 0.9 * u : ty === 1 ? 0.8 + 0.4 * u : 0.8 + 0.5 * u);
          ma[n * 4] = u; ma[n * 4 + 1] = ty; ma[n * 4 + 2] = m[o + 3]; ma[n * 4 + 3] = 1; n++;
        }
        sprayMesh.geometry.instanceCount = n; sprayMesh.visible = n > 0 && fx.sheetOK;
        if (n) { iposA.needsUpdate = true; imetaA.needsUpdate = true; iposA.addUpdateRange && 0; }
        fx.live = live;
      }
      if (wake) {
        const pts = wake.count ? wake.ribbon(wakeVerts, S.t, 9.0) : 0;
        if (pts >= 2) {
          const pa = wposA.array, aa = wattA.array, sb = seaBase();
          for (let v = 0; v < pts * 5; v++) { const o = v * 5, x = wakeVerts[o], z = wakeVerts[o + 1]; pa[v * 3] = x; pa[v * 3 + 1] = sb + D().heightAt(x, z) + 0.06; pa[v * 3 + 2] = z; aa[v * 3] = wakeVerts[o + 2]; aa[v * 3 + 1] = wakeVerts[o + 3]; aa[v * 3 + 2] = wakeVerts[o + 4]; }
          wposA.needsUpdate = true; wattA.needsUpdate = true; wakeMesh.geometry.setDrawRange(0, (pts - 1) * 24); wakeMesh.visible = true;
        } else wakeMesh.visible = false;
      }
      underwater(dt, ctx);
    };

    fx.dispose = function () {
      fx.dead = true;
      [sprayMesh, wakeMesh, shaftMesh].forEach((o) => { if (!o) return; try { if (o.parent) o.parent.remove(o); o.geometry.dispose(); o.material.dispose(); } catch (e) { } });
      try { if (sheetTex) sheetTex.dispose(); if (fx.sheetU && fx.sheetU.value) fx.sheetU.value.dispose(); } catch (e) { }
      if (st.fogSaved && fx.scene && fx.scene.fog && fx.scene.fog.color.equals(st.lastSet)) fx.scene.fog.color.copy(st.fogCol);
      S.sprayTex = null; crumb('live', 'waterFx', 0);
    };
    fx.status = () => ({ built: fx.built, sheet: fx.sheetOK, live: fx.live | 0, wake: wake ? wake.count : 0, contact: st.contact, spd: +st.spd.toFixed(1) });
    crumb('live', 'waterFx', NS);
    return fx;
  }

  W.DMWaterFX = { create, enabled: () => !flagOff() };
})(typeof window !== 'undefined' ? window : globalThis);
