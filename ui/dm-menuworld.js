/* ============================================================================
   ui/dm-menuworld.js — the 3D world behind the character select (card wheel) and the character studio (turntable).

   STUDIO: the turntable is the lip of a cargo-bay platform on a base hovering over a planet.  Floor plates, hazard-striped edge, pylons, ribs, rim lights, blue / amber
   LEDs in the foreground; out of the open bay: a procedural planet (TSL: continents, ocean with a sun glint, clouds, atmosphere rim), a sun with glare, a 3D star field.
   CARDS: the same universe seen from an observation deck (window frame, deck plates with guide lines, consoles, a hologram ring); the DOM cards float in front of it.

   Budget: tiers from ?menuscene=low|off, GFX.isMobile and the DMBudget pressure (tierFor).  Mobile: fewer stars, planet with fewer noise octaves + a coarser sphere, no band
   shader, pixel-ratio cap, a blob contact shadow only (no shadow maps, no extra lights).  Everything is generated here (no fetches, nothing to fail offline), and dispose()
   frees every geometry / material the world made (it makes no textures).  The orbit camera maths (orbitRig) is pure and also lives here so ?menuscene=off keeps it.

   API: DMMenuWorld.mode() · .tier() · .attachStudio(THREE, X, o) · .cardWorld(o) · .orbitRig(...) · pure core (module.exports for node: tools/tests/menuworld-unit.js)
   ========================================================================== */
(function (root) {
  'use strict';
  const D2R = Math.PI / 180, TAU = Math.PI * 2;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);

  /* ───────────────────────── pure core ───────────────────────── */
  function parseMode(search) {   // 'off' | 'low' | 'auto'
    const m = /[?&]menuscene=([a-z0-9]+)/i.exec(search || ''); if (!m) return 'auto';
    const v = m[1].toLowerCase(); return v === 'off' || v === '0' || v === 'false' ? 'off' : v === 'low' ? 'low' : 'auto';
  }
  const TIERS = {
    off: { name: 'off', on: false },
    low: { name: 'low', on: true, stars: 260, motes: 24, planetSeg: 28, planetOct: 3, cloudOct: 2, prCap: 1.0, band: false, fps: 24 },
    mid: { name: 'mid', on: true, stars: 600, motes: 50, planetSeg: 40, planetOct: 4, cloudOct: 2, prCap: 1.25, band: false, fps: 30 },
    high: { name: 'high', on: true, stars: 1500, motes: 90, planetSeg: 64, planetOct: 5, cloudOct: 3, prCap: 1.5, band: true, fps: 30 },
  };
  // o: { mode, isMobile, pressure }.  Mobile starts at 'mid'; the frame-budget pressure (DMBudget.p) or ?menuscene=low drops a tier.
  function tierFor(o) {
    o = o || {}; if (o.mode === 'off') return TIERS.off; if (o.mode === 'low') return TIERS.low;
    const p = +o.pressure || 0; let n = o.isMobile ? 'mid' : 'high';
    if (p >= 8 || (o.isMobile && p >= 5)) n = 'low'; else if (p >= 4 && n === 'high') n = 'mid';
    return TIERS[n];
  }
  function rng(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  // stars on spherical shells: layers = [{n, dist, ang:[min,max] radians | size:[min,max] metres}]  ->  [{x,y,z (unit),dist,size,r,g,b,a,layer}]
  function starfield(layers, seed, o) {
    const R = rng(seed || 1), out = []; o = o || {};
    layers.forEach((L, li) => {
      for (let i = 0; i < L.n; i++) {
        const z = R() * 2 - 1, th = R() * TAU, s = Math.sqrt(1 - z * z); let x = s * Math.cos(th), y = s * Math.sin(th), zz = z;
        if (o.hemi) { zz = -(0.25 + Math.abs(z) * 0.75); const q = Math.sqrt(Math.max(0, 1 - zz * zz)) / (s || 1); x *= q; y *= q; }   // a forward-facing cap (cards)
        const mag = Math.pow(R(), 3);                           // many dim, few bright
        const ang = L.ang ? lerp(L.ang[0], L.ang[1], mag) : 0, size = L.size ? lerp(L.size[0], L.size[1], mag) : ang * L.dist;
        const t = R(), r = lerp(0.72, 1.0, t), g = lerp(0.8, 0.95, 1 - Math.abs(t - 0.5) * 2), b = lerp(1.0, 0.7, t);   // blue-white .. warm
        out.push({ x, y, z: zz, dist: L.dist, size, r, g, b, a: lerp(0.35, 1, mag), layer: li });
      }
    });
    return out;
  }
  // quads facing the origin for a star list -> typed arrays (position, uv, aStar rgba, index).  Star position = unit dir * dist.
  function starQuads(stars) {
    const n = stars.length, pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), col = new Float32Array(n * 16), idx = new Uint32Array(n * 6);
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < n; i++) {
      const s = stars[i], len = Math.hypot(s.x, s.y, s.z) || 1, dx = s.x / len, dy = s.y / len, dz = s.z / len;
      let rx = dz, ry = 0, rz = -dx, rl = Math.hypot(rx, ry, rz); if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; } rx /= rl; ry /= rl; rz /= rl;
      const ux = dy * rz - dz * ry, uy = dz * rx - dx * rz, uz = dx * ry - dy * rx, h = s.size * 0.5, cx = dx * s.dist, cy = dy * s.dist, cz = dz * s.dist;
      for (let k = 0; k < 4; k++) {
        const a = c[k][0] * h, b = c[k][1] * h, o3 = i * 12 + k * 3;
        pos[o3] = cx + rx * a + ux * b; pos[o3 + 1] = cy + ry * a + uy * b; pos[o3 + 2] = cz + rz * a + uz * b;
        uv[i * 8 + k * 2] = c[k][0] * 0.5 + 0.5; uv[i * 8 + k * 2 + 1] = c[k][1] * 0.5 + 0.5;
        const o4 = i * 16 + k * 4; col[o4] = s.r; col[o4 + 1] = s.g; col[o4 + 2] = s.b; col[o4 + 3] = s.a;
      }
      const v = i * 4; idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    return { pos, uv, col, idx };
  }
  // axis-aligned boxes merged into one geometry's arrays.  box: {c:[x,y,z], s:[w,h,d], ph?:0..1}
  function mergeBoxes(list) {
    const n = list.length, pos = new Float32Array(n * 72), nrm = new Float32Array(n * 72), uv = new Float32Array(n * 48), ph = new Float32Array(n * 24), idx = new Uint32Array(n * 36);
    const F = [[[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]], [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
      [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]], [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
      [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]]];
    const U = [[0, 0], [1, 0], [1, 1], [0, 1]];
    list.forEach((b, i) => {
      F.forEach((f, fi) => {
        for (let k = 0; k < 4; k++) {
          const v = i * 24 + fi * 4 + k, c = f[1][k];
          pos[v * 3] = b.c[0] + c[0] * b.s[0] / 2; pos[v * 3 + 1] = b.c[1] + c[1] * b.s[1] / 2; pos[v * 3 + 2] = b.c[2] + c[2] * b.s[2] / 2;
          nrm[v * 3] = f[0][0]; nrm[v * 3 + 1] = f[0][1]; nrm[v * 3 + 2] = f[0][2]; uv[v * 2] = U[k][0]; uv[v * 2 + 1] = U[k][1]; ph[v] = b.ph || 0;
        }
        const v0 = i * 24 + fi * 4; idx.set([v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3], i * 36 + fi * 6);
      });
    });
    return { pos, nrm, uv, ph, idx };
  }
  // the sun is placed inside the frame whatever the stage aspect: `frac` of the half horizontal FOV to one side (side -1 left / +1 right), elevation in degrees
  function sunDirFor(aspect, fovDeg, side, elevDeg, frac) {
    const hf = Math.atan(Math.tan(fovDeg * D2R / 2) * Math.max(0.3, aspect)), az = (side || -1) * hf * (frac == null ? 0.62 : frac), el = (elevDeg == null ? 9 : elevDeg) * D2R;
    const x = Math.sin(az) * Math.cos(el), y = Math.sin(el), z = -Math.cos(az) * Math.cos(el), l = Math.hypot(x, y, z); return [x / l, y / l, z / l];
  }
  // lights that match the sky: rim = the sun (from behind, a little above), key = the bay lamp from the front-right, hemisphere ground = planet shine from below
  function lightRig(sun) {
    const k = [0.55, 0.5, 0.67], kl = Math.hypot(k[0], k[1], k[2]);
    return { rim: { dir: [sun[0] * 6, 1.1 + sun[1] * 5, sun[2] * 6], color: 0xfff1d6, intensity: 2.3 }, key: { dir: [k[0] / kl * 3, k[1] / kl * 3, k[2] / kl * 3], color: 0xffd9b0, intensity: 2.0 },
      hemi: { sky: 0x8aa0d8, ground: 0x2a5f9a, intensity: 0.8 } };
  }
  const swayAt = (t, amp) => ({ x: Math.sin(t * 0.23) * amp + Math.sin(t * 0.071) * amp * 0.6, y: Math.sin(t * 0.31 + 1.3) * amp * 0.25 });
  // layers sit on a parallax rig: layer.position = -(camera - rest) * k.  k = how many times nearer the layer behaves than it really is (real distances give no visible parallax)
  const parallaxOffset = (cam, rest, k) => [-(cam[0] - rest[0]) * k, -(cam[1] - rest[1]) * k, -(cam[2] - rest[2]) * k];
  const PARALLAX_K = { planet: 14, starsFar: 30, starsMid: 55, starsNear: 90 };

  // pitch -> orbit target height / distance / camera height + radius.  pitch in radians: 0 level, + camera swings up over her head (top view), - camera low toward her feet.
  const PITCH_MIN = -75 * D2R, PITCH_MAX = 85 * D2R;
  function orbitRig(pitch, H, baseDist, zoom, tyOff, o) {
    o = o || {}; const floorY = o.floorY || 0, margin = o.margin == null ? 0.14 : o.margin;
    const p = clamp(pitch || 0, PITCH_MIN, PITCH_MAX), z = zoom || 1; let ty, d, camY, camR;
    if (p >= 0) { const s = ease(p / PITCH_MAX); ty = H * (0.5 + 0.34 * s); d = baseDist * z * (1 + 0.04 * s); camY = ty + Math.sin(p) * d; camR = Math.cos(p) * d; }
    else {
      const s = ease(p / PITCH_MIN); ty = H * (0.5 - 0.31 * s); d = baseDist * z * (1 - 0.5 * s);
      camY = Math.max(floorY + margin, ty + Math.sin(p) * d); const dy = camY - ty; camR = Math.sqrt(Math.max(0.04, d * d - dy * dy));
    }
    ty = clamp(ty + (tyOff || 0) * H * 0.35, floorY + 0.05, floorY + H * 1.05);
    if (camY < floorY + margin) camY = floorY + margin;
    return { ty, dist: d, camY, camR, pitch: p };
  }
  // pure frame-time governor for the menu world: step(ms) -> true when the pixel-ratio scale just dropped
  function makeGovernor() {
    const g = { scale: 1, ema: 33, bad: 0, steps: 0, step(ms) {
      g.ema += (Math.min(250, ms) - g.ema) * 0.08; if (g.ema > 45) g.bad += ms; else g.bad = Math.max(0, g.bad - ms);
      if (g.bad > 1500 && g.scale > 0.6) { g.scale = Math.max(0.6, g.scale * 0.8); g.bad = 0; g.ema = 33; g.steps++; return true; } return false; } };
    return g;
  }
  const nearestYaw = (yaw, home) => home + Math.round((yaw - home) / TAU) * TAU;

  const core = { parseMode, tierFor, TIERS, rng, starfield, starQuads, mergeBoxes, sunDirFor, lightRig, swayAt, parallaxOffset, PARALLAX_K, orbitRig, PITCH_MIN, PITCH_MAX, nearestYaw, makeGovernor, clamp, ease };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }

  /* ───────────────────────── browser: the world ───────────────────────── */
  const W = root, Q = (W.location && W.location.search) || '';
  const MW = W.DMMenuWorld = Object.assign({ core }, core);
  const info = (...a) => { try { console.info('[menuworld]', ...a); } catch (e) { } };
  MW.mode = () => parseMode(Q);
  MW.tier = () => { const g = W.GFX || {}, b = W.DMBudget; return tierFor({ mode: parseMode(Q), isMobile: !!g.isMobile, pressure: b && b.on ? b.p : 0 }); };
  MW.active = () => MW.tier().on;
  // the menu's own governor: the budget controller (DMBudget) does not sample menu screens, so the world watches its own frame time (EMA of the 30 fps loop) and, when it runs
  // slower than ~22 fps for ~1.5 s, lowers its pixel-ratio scale one step (x0.8, floor 0.6).  The scale is kept for the session.
  MW.gov = makeGovernor();
  MW.govern = (ms) => MW.gov.step(ms);
  MW.prCap = () => { const t = MW.tier(); return t.on ? t.prCap * MW.gov.scale : 0; };
  MW.stats = { worlds: 0, live: 0 };

  function trackDispose(list) {
    return function () { list.forEach((o) => { try { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); } catch (e) { } }); list.length = 0; };
  }
  function geo(THREE, m, withPh) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3)); g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    if (withPh) g.setAttribute('aPh', new THREE.BufferAttribute(m.ph, 1)); g.setIndex(new THREE.BufferAttribute(m.idx, 1)); g.computeBoundingSphere(); return g;
  }
  function quadGeo(THREE, q) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(q.pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(q.uv, 2)); g.setAttribute('aStar', new THREE.BufferAttribute(q.col, 4));
    g.setIndex(new THREE.BufferAttribute(q.idx, 1)); g.computeBoundingSphere(); return g;
  }

  /* materials ---------------------------------------------------------- */
  function mats(THREE) {
    const T = THREE.TSL;
    return {
      steel(o) {   // dark panelled hull metal, darker low, lighter high
        const { float, vec3, mix, positionWorld, smoothstep, fract, floor, dot, sin, abs } = T;
        const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.1 });
        const p = positionWorld, cell = floor(p.mul(vec3(1.2, 1.0, 1.2))), hv = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
        const seam = smoothstep(0.44, 0.5, abs(fract(p.y.mul(0.8)).sub(0.5)));
        m.colorNode = mix(vec3(o.a[0], o.a[1], o.a[2]), vec3(o.b[0], o.b[1], o.b[2]), hv).mul(float(1).sub(seam.mul(0.4))).mul(mix(float(0.75), float(1.1), smoothstep(-0.5, 4.5, p.y)));
        return m;
      },
      floor(o) {   // deck plates: 1 m plates, seams, per-plate tint, glowing guide lines pulsing toward the edge
        const { float, vec2, vec3, mix, positionWorld, smoothstep, fract, floor, dot, sin, abs, min, time, mx_fractal_noise_float } = T;
        const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.0 });
        const p = positionWorld.xz.mul(o.plate || 1), cell = floor(p), f = fract(p), hv = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
        const e = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y))), seam = float(1).sub(smoothstep(0.0, 0.035, e));
        let col = mix(vec3(0.05, 0.06, 0.08), vec3(0.1, 0.11, 0.13), hv);
        if (o.noise) col = col.mul(float(0.88).add(mx_fractal_noise_float(positionWorld.mul(7.0), 2, 2.0, 0.5).mul(0.12)));
        col = col.mul(float(1).sub(seam.mul(0.75)));
        const emis = (o.guides || []).reduce((acc, gx) => { const d = abs(positionWorld.x.sub(gx)); return acc.add(smoothstep(0.04, 0.0, d).mul(0.5)).add(smoothstep(0.012, 0.0, d)); }, float(0));
        m.colorNode = col; m.emissiveNode = vec3(0.1, 0.55, 1.0).mul(emis).mul(float(0.7).add(sin(positionWorld.z.mul(0.9).sub(time.mul(1.4))).mul(0.3))).mul(o.glow == null ? 1.2 : o.glow);
        return m;
      },
      hazard() {
        const { vec3, mix, positionWorld, fract, step } = T;
        const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.15 }), s = step(0.5, fract(positionWorld.x.add(positionWorld.z).mul(2.2)));
        m.colorNode = mix(vec3(0.03, 0.03, 0.035), vec3(0.95, 0.66, 0.06), s); m.emissiveNode = vec3(0.9, 0.5, 0.05).mul(s).mul(0.18); return m;
      },
      led(rgb, speed) {   // emissive, blinking by the per-box phase
        const { float, vec3, attribute, sin, time, step, mix } = T;
        const m = new THREE.MeshBasicNodeMaterial({ toneMapped: false }), ph = attribute('aPh', 'float');
        m.colorNode = vec3(rgb[0], rgb[1], rgb[2]).mul(mix(float(0.35), float(1.0), step(0.0, sin(time.mul(speed).add(ph.mul(6.28))))));
        return m;
      },
      glow(rgb) { const m = new THREE.MeshBasicNodeMaterial({ toneMapped: false }); m.colorNode = T.vec3(rgb[0], rgb[1], rgb[2]); return m; },
      points(gain) {   // additive soft dots from the aStar attribute (rgb, brightness) and the quad uv
        const { float, attribute, uv, length, pow, clamp: tc, sin, time, positionLocal, vec3, dot } = T;
        const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), a = attribute('aStar', 'vec4');
        const fall = pow(float(1).sub(tc(length(uv().sub(0.5)).mul(2.0), 0, 1)), 2.2), tw = float(0.88).add(sin(time.mul(1.3).add(dot(positionLocal, vec3(0.013, 0.0071, 0.0097)))).mul(0.12));
        m.colorNode = a.xyz.mul(fall).mul(a.w).mul(tw).mul(gain); m.opacityNode = float(1); return m;
      },
    };
  }

  /* sky: stars + planet + sun + atmosphere ----------------------------- */
  function buildSky(THREE, group, tier, o, own) {
    const T = THREE.TSL, { float, vec3, uniform, mix, smoothstep, positionLocal, positionWorld, normalWorld, cameraPosition, normalize, dot, pow, max, clamp: tc, mx_fractal_noise_float, uv, length, sin, cos, exp, abs } = T;
    const M = mats(THREE), U = { sun: uniform(new THREE.Vector3(o.sun[0], o.sun[1], o.sun[2])), cloud: uniform(0) }, parts = {};
    const mk = (mesh) => { mesh.frustumCulled = false; own.push(mesh); return mesh; };
    // sky sphere: faint glow round the sun, a milky band on the high tier
    const skyMat = (() => {
      const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: false }), d = normalize(positionLocal), sd = max(dot(d, normalize(U.sun)), 0);
      let c = vec3(0.004, 0.006, 0.016).add(vec3(0.06, 0.045, 0.03).mul(pow(sd, 14.0))).add(vec3(0.002, 0.003, 0.009).mul(pow(sd, 3.0)));
      if (tier.band) { const n = normalize(vec3(0.35, 0.85, 0.25)), w = exp(dot(d, n).mul(dot(d, n)).mul(-16.0)), nz = mx_fractal_noise_float(d.mul(5.0), 3, 2.0, 0.5).mul(0.5).add(0.5); c = c.add(vec3(0.012, 0.016, 0.03).mul(w).mul(nz.mul(nz)).mul(1.4)); }
      m.colorNode = c; return m;
    })();
    const sk = mk(new THREE.Mesh(new THREE.SphereGeometry(4600, 24, 16), skyMat)); sk.renderOrder = -20; group.add(sk);
    // stars on three shells, each its own parallax layer
    const K = PARALLAX_K, defs = o.starLayers || [
      { n: Math.round(tier.stars * 0.5), dist: 2600, ang: [0.0022, 0.0055], k: K.starsFar }, { n: Math.round(tier.stars * 0.35), dist: 1500, ang: [0.0022, 0.006], k: K.starsMid }, { n: Math.round(tier.stars * 0.15), dist: 900, ang: [0.0028, 0.007], k: K.starsNear }];
    const starsMat = M.points(3.6); own.push({ material: starsMat });
    parts.layers = defs.map((d, i) => {
      const g = quadGeo(THREE, starQuads(starfield([d], 11 + i * 7, { hemi: !!o.hemi }))), grp = new THREE.Group(), me = mk(new THREE.Mesh(g, starsMat)); me.renderOrder = -10; grp.add(me); group.add(grp); return { grp, k: d.k };
    });
    // planet: continents / ocean / ice caps / clouds / sun glint / terminator / atmosphere rim, all in one fragment shader
    const pc = o.planet, R = pc.r, planetMat = (() => {
      const m = new THREE.MeshBasicNodeMaterial({}), dl = normalize(positionLocal), N = normalize(normalWorld), L = normalize(U.sun), V = normalize(cameraPosition.sub(positionWorld));
      const cs = cos(U.cloud), sn = sin(U.cloud), dc = vec3(dl.x.mul(cs).sub(dl.z.mul(sn)), dl.y, dl.x.mul(sn).add(dl.z.mul(cs)));
      const h = mx_fractal_noise_float(dl.mul(2.1).add(vec3(3.0, 1.0, 7.0)), tier.planetOct, 2.0, 0.5).mul(0.5).add(0.5), e = h.sub(0.52);
      const land = smoothstep(0.0, 0.012, e), moist = mx_fractal_noise_float(dl.mul(3.1).add(vec3(9.0, 4.0, 2.0)), 2, 2.0, 0.5).mul(0.5).add(0.5);
      let ter = mix(vec3(0.14, 0.27, 0.1), vec3(0.45, 0.38, 0.2), smoothstep(0.35, 0.6, float(1).sub(moist).sub(abs(dl.y).mul(0.5))));
      ter = mix(ter, vec3(0.32, 0.29, 0.26), smoothstep(0.1, 0.22, e)); const ice = smoothstep(0.8, 0.9, abs(dl.y).add(h.sub(0.5).mul(0.14)));
      ter = mix(ter, vec3(0.9, 0.93, 0.97), ice);
      const ocean = mix(vec3(0.01, 0.06, 0.2), vec3(0.03, 0.3, 0.45), smoothstep(-0.07, 0.0, e)), surf = mix(ocean, ter, land);
      const cl = smoothstep(0.5, 0.74, mx_fractal_noise_float(dc.mul(3.6).add(vec3(5.0, 8.0, 1.0)), tier.cloudOct, 2.0, 0.5).mul(0.5).add(0.5)).mul(0.92);
      const ndl = dot(N, L), lit = max(ndl, 0), day = smoothstep(-0.28, 0.2, ndl), Hh = normalize(L.add(V)), nh = max(dot(N, Hh), 0);
      const sp = pow(nh, 110.0).mul(2.4).add(pow(nh, 14.0).mul(0.18)), oceanMask = float(1).sub(land), sunC = vec3(1.0, 0.95, 0.86);
      let col = mix(surf, vec3(1.0, 1.0, 1.0), cl).mul(sunC).mul(lit.mul(1.25).mul(day)).add(mix(surf, vec3(0.8, 0.85, 0.9), cl).mul(vec3(0.05, 0.075, 0.14))).add(sunC.mul(sp).mul(oceanMask).mul(float(1).sub(cl)).mul(day));
      col = col.add(vec3(1.0, 0.42, 0.18).mul(exp(ndl.mul(ndl).mul(-22.0)).mul(0.22)).mul(float(1).sub(ice.mul(0.5))));
      col = col.add(vec3(0.22, 0.5, 1.0).mul(pow(float(1).sub(max(dot(N, V), 0)), 3.0)).mul(day.mul(0.9).add(0.12)).mul(1.2));
      m.colorNode = col; return m;
    })();
    const planet = mk(new THREE.Mesh(new THREE.SphereGeometry(R, tier.planetSeg, Math.round(tier.planetSeg * 0.75)), planetMat)); planet.rotation.z = 0.35;
    const pg = new THREE.Group(); pg.position.set(pc.x, pc.y, pc.z); pg.add(planet); group.add(pg);
    // atmosphere: back faces of a larger shell, glow from the closest approach of the view ray to the planet centre
    const atmMat = (() => {
      const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      const cN = uniform(new THREE.Vector3()), rd = normalize(positionWorld.sub(cameraPosition)), t = dot(cN.sub(cameraPosition), rd), cp = cameraPosition.add(rd.mul(t)), b = length(cp.sub(cN)).div(R);
      const a = pow(float(1).sub(tc(b.sub(1.0).div(0.07), 0, 1)), 3.0), dd = dot(normalize(cp.sub(cN)), normalize(U.sun)), day = smoothstep(-0.35, 0.5, dd);
      m.colorNode = mix(vec3(1.0, 0.5, 0.25), vec3(0.2, 0.5, 1.0), smoothstep(-0.05, 0.45, dd)).mul(a).mul(day.mul(1.3).add(0.05)); m.opacityNode = float(1); parts.atmCenter = cN; return m;
    })();
    const atm = mk(new THREE.Mesh(new THREE.SphereGeometry(R * 1.07, Math.max(20, tier.planetSeg), Math.round(tier.planetSeg * 0.7)), atmMat)); atm.renderOrder = -5; pg.add(atm);
    // sun with glare (additive, never depth-hidden: it is far behind everything)
    const sunQ = mk(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), (() => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), p = uv().sub(0.5).mul(2.0), r = length(p);
      const core = smoothstep(0.075, 0.0, r).mul(6.0), halo = float(1).div(float(1).add(r.mul(r).mul(400.0))).mul(0.45), streak = exp(abs(p.y).mul(-70.0)).mul(exp(abs(p.x).mul(-2.8))).mul(0.4);
      m.colorNode = vec3(1.0, 0.93, 0.8).mul(core.add(halo)).add(vec3(0.6, 0.75, 1.0).mul(streak)).mul(smoothstep(1.0, 0.7, r)); m.opacityNode = float(1); return m;
    })())); sunQ.renderOrder = -4; group.add(sunQ);
    parts.sunDist = 3200;
    parts.setSun = (d) => { U.sun.value.set(d[0], d[1], d[2]); sunQ.position.set(d[0] * parts.sunDist, d[1] * parts.sunDist, d[2] * parts.sunDist); sunQ.scale.set(2200, 2200, 1); sunQ.lookAt(0, 0, 0); }; parts.setSun(o.sun);
    parts.placePlanet = (v) => pg.position.set(pc.x + v[0], pc.y + v[1], pc.z + v[2]);
    parts.planetGroup = pg; parts.planet = planet; parts.sunQ = sunQ;
    parts.syncAtm = () => { parts.atmCenter.value.copy(pg.position); };
    parts.update = (t) => { U.cloud.value = t * 0.006; planet.rotation.y = t * 0.0026; };
    return parts;
  }
  function motesMesh(THREE, count, gen, seed, M, own, group) {
    const r = rng(seed), st = []; for (let i = 0; i < count; i++) st.push(gen(r));
    const me = new THREE.Mesh(quadGeo(THREE, starQuads(st)), M.points(1.4)); me.frustumCulled = false; own.push(me); group.add(me); return me;
  }

  /* STUDIO -------------------------------------------------------------- */
  MW.attachStudio = function (THREE, X, o) {
    o = o || {}; const tier = MW.tier(); if (!tier.on) return null;
    const own = [], dispose = trackDispose(own), T = THREE.TSL, M = mats(THREE), scene = X.scene, group = new THREE.Group(); group.name = 'menuworld-studio';
    const fov = 30, sun0 = sunDirFor(o.aspect || 1.2, fov, -1, 9, 0.62);
    const sky = buildSky(THREE, group, tier, { sun: sun0, planet: { x: 140, y: -700, z: -1250, r: 760 } }, own); sky.syncAtm();
    scene.traverse((ob) => { if (ob.userData && ob.userData.dmSet) ob.visible = false; });   // the plain pad / ring / rocks give way to the bay
    const rig = lightRig(sun0);
    const setRim = (s) => { if (X.rim) { const r = lightRig(s).rim; X.rim.position.set(r.dir[0], r.dir[1], r.dir[2]); X.rim.color.setHex(r.color); X.rim.intensity = r.intensity; } };
    scene.traverse((ob) => { if (ob.isHemisphereLight) { ob.color.setHex(rig.hemi.sky); ob.groundColor.setHex(rig.hemi.ground); ob.intensity = rig.hemi.intensity; } });
    if (X.key) { X.key.color.setHex(rig.key.color); X.key.intensity = rig.key.intensity; X.key.position.set(rig.key.dir[0], rig.key.dir[1], rig.key.dir[2]); }
    setRim(sun0);
    const R = rng(5), steelB = [], strips = [], ledB = [], ledA = [], floorB = [{ c: [0, -0.2, 2.8], s: [6.8, 0.4, 10.4] }], hazB = [{ c: [0, 0.006, -2.2], s: [6.8, 0.014, 0.4] }];
    const box = (arr, cx, cy, cz, w, h, d, ph) => arr.push({ c: [cx, cy, cz], s: [w, h, d], ph: ph == null ? R() : ph });
    box(steelB, 0, -3.2, -2.35, 9, 6, 0.5, 0); box(steelB, 0, -4.2, 3, 11, 7.4, 12, 0);                      // the base's hull under the lip
    for (const sx of [-1, 1]) {
      box(steelB, sx * 2.25, 2.3, -1.5, 0.45, 4.6, 0.45, 0); box(steelB, sx * 3.45, 2.0, 3, 0.3, 4.0, 10.4, 0); box(strips, sx * 2.0, 2.3, -1.25, 0.04, 4.2, 0.1, 0); box(ledA, sx * 2.25, 4.75, -1.5, 0.26, 0.2, 0.26);
      for (let i = 0; i < 9; i++) box(i % 3 === 0 ? ledA : ledB, sx * 2.0, 0.5 + i * 0.5, -1.2, 0.07, 0.07, 0.07);
      for (let i = 0; i < 6; i++) { const z = -0.6 + i * 1.7; box(steelB, sx * 3.3, 2.1, z, 0.3, 4.2, 0.26, 0); if (i % 2 === 0) box(ledB, sx * 3.12, 0.9, z, 0.05, 0.05, 0.05); box(ledA, sx * 3.12, 3.7, z, 0.05, 0.05, 0.05); }
      box(strips, sx * 3.28, 0.06, 3, 0.04, 0.04, 10.2, 0);
    }
    box(steelB, 0, 4.75, -1.5, 4.6, 0.45, 0.45, 0); box(strips, 0, 4.5, -1.5, 4.0, 0.04, 0.06, 0);
    for (let i = 0; i < 4; i++) box(steelB, 0, 4.5, 1 + i * 2.2, 6.6, 0.18, 0.18, 0);
    box(strips, 0, 0.02, -2.43, 6.8, 0.03, 0.03, 0);
    for (let i = 0; i < 22; i++) box(i % 4 === 3 ? ledA : ledB, -3.2 + i * 0.3, -0.18, -2.62, 0.06, 0.05, 0.03);   // lip LEDs
    box(steelB, 5.4, -1.0, -30, 1.0, 1.0, 56, 0); for (let i = 0; i < 8; i++) box(ledA, 5.4, -0.4, -12 - i * 7, 0.2, 0.2, 0.2);   // far gantries leaving the hull, and a mast on one
    box(steelB, -5.4, -1.0, -30, 1.0, 1.0, 56, 0); box(steelB, -5.4, 6.5, -42, 0.8, 14, 0.8, 0); box(ledA, -5.4, 13.8, -42, 0.6, 0.6, 0.6); box(ledB, -5.4, 8, -41.6, 0.3, 0.3, 0.3);
    const mesh = (m, mat, ph) => { const me = new THREE.Mesh(geo(THREE, mergeBoxes(m), ph), mat); me.frustumCulled = false; own.push(me); group.add(me); return me; };
    const floorM = M.floor({ plate: 1, guides: [-1.9, 1.9], noise: tier.name === 'high' }), hazM = M.hazard(), steelM = M.steel({ a: [0.07, 0.08, 0.1], b: [0.13, 0.14, 0.17] });
    mesh(floorB, floorM); mesh(hazB, hazM); mesh(steelB, steelM); mesh(strips, M.glow([0.25, 0.8, 1.7]));
    mesh(ledB, M.led([0.2, 0.7, 2.0], 3.1), true); mesh(ledA, M.led([2.0, 1.1, 0.2], 2.3), true);
    // turntable disc (turns with her), ring light, contact blob
    const { vec3, atan, positionLocal, length, step, fract, smoothstep, float, uv } = T;
    const discMat = (() => { const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 }), ang = atan(positionLocal.x, positionLocal.z).div(6.2832).add(0.5), rr = length(positionLocal.xz);
      const tick = step(0.82, fract(ang.mul(36))).mul(step(1.05, rr)), ring = smoothstep(0.02, 0.0, rr.sub(1.0).abs());
      m.colorNode = vec3(0.045, 0.05, 0.065).add(vec3(0.025, 0.03, 0.04).mul(step(0.5, fract(rr.mul(7.0))))); m.emissiveNode = vec3(0.15, 0.7, 1.6).mul(tick.add(ring.mul(0.7))); return m; })();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.28, 0.02, 56), discMat); disc.position.y = -0.002; disc.frustumCulled = false; own.push(disc); group.add(disc);
    const ringM = new THREE.Mesh(new THREE.RingGeometry(1.29, 1.34, 64), M.glow([0.2, 0.75, 1.9])); ringM.rotation.x = -Math.PI / 2; ringM.position.y = 0.012; ringM.frustumCulled = false; own.push(ringM); group.add(ringM);
    const blobMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false }); blobMat.colorNode = vec3(0, 0, 0); blobMat.opacityNode = float(1).sub(smoothstep(0.0, 1.0, length(uv().sub(0.5)).mul(2.0))).mul(0.6);
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.75, 28), blobMat); blob.rotation.x = -Math.PI / 2; blob.position.y = 0.014; blob.renderOrder = 2; own.push(blob); group.add(blob);
    // near-field dust motes: real parallax at real distance
    const motes = tier.motes ? motesMesh(THREE, tier.motes, (r) => { const a = r() * TAU, d = 3 + r() * 9; return { x: Math.cos(a) * d * 0.6, y: r() * 5 - 0.5, z: -Math.abs(Math.sin(a)) * d - 1.5, dist: 1, size: 0.018 + r() * 0.03, r: 0.6, g: 0.8, b: 1, a: 0.3 + r() * 0.5 }; }, 77, M, own, group) : null;
    scene.add(group);
    const rest = [null, null, null], Wd = { group, tier, sun: sun0, aspect: o.aspect || 1.2, sky, disc };
    Wd.prepCamera = (cam) => { if (cam.far < 6000) { cam.near = 0.08; cam.far = 6000; cam.updateProjectionMatrix(); } };
    Wd.setAspect = (a) => { if (Math.abs(a - Wd.aspect) < 0.03) return; Wd.aspect = a; Wd.sun = sunDirFor(a, fov, -1, 9, 0.62); sky.setSun(Wd.sun); setRim(Wd.sun); };
    Wd.update = (t, dt, cam, yaw, target, dragging) => {   // t in ms; after the camera pose is set, before render
      const ts = t / 1000; sky.update(ts); disc.rotation.y = yaw || 0; Wd.rescale = MW.govern(dt * 1000);   // true = the pixel ratio just dropped: the caller re-lays out
      if (rest[0] == null) { rest[0] = cam.position.x; rest[1] = cam.position.y; rest[2] = cam.position.z; }
      const sw = swayAt(ts, dragging ? 0.02 : 0.06); cam.position.x += sw.x; cam.position.y = Math.max(0.1, cam.position.y + sw.y); if (target) cam.lookAt(target); cam.updateMatrixWorld(true);
      const c = [cam.position.x, cam.position.y, cam.position.z], set = (g, k) => { const v = parallaxOffset(c, rest, k); g.position.set(v[0], v[1], v[2]); };
      sky.placePlanet(parallaxOffset(c, rest, PARALLAX_K.planet)); sky.layers.forEach((L) => set(L.grp, L.k)); sky.syncAtm();
      if (motes) motes.position.y = Math.sin(ts * 0.12) * 0.25;
    };
    Wd.dispose = () => { try { scene.remove(group); } catch (e) { } dispose(); MW.stats.live = Math.max(0, MW.stats.live - 1); };
    MW.stats.worlds++; MW.stats.live++; info('studio world', tier.name);
    return Wd;
  };

  /* CARDS: observation deck -------------------------------------------- */
  MW.cardWorld = function (o) {
    const THREE = o.THREE || W.THREE, tier = MW.tier(); if (!tier.on || !THREE) return null;
    const own = [], dispose = trackDispose(own), T = THREE.TSL, M = mats(THREE), scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group); scene.background = new THREE.Color(0x02030a);
    const fov = 50, cam = new THREE.PerspectiveCamera(fov, 1.6, 0.1, 6500), R = rng(9); let sun = sunDirFor(1.6, fov, 1, 13, 0.55), sunA = 1.6;
    const sky = buildSky(THREE, group, tier, { sun, hemi: true, planet: { x: -300, y: -1050, z: -1500, r: 1180 }, starLayers: [
      { n: Math.round(tier.stars * 0.45), dist: 2600, ang: [0.0016, 0.0042], k: PARALLAX_K.starsFar }, { n: Math.round(tier.stars * 0.35), dist: 1500, ang: [0.0016, 0.0046], k: PARALLAX_K.starsMid }, { n: Math.round(tier.stars * 0.2), dist: 900, ang: [0.002, 0.0055], k: PARALLAX_K.starsNear }] }, own); sky.syncAtm();
    const hemi = new THREE.HemisphereLight(0x8aa0d8, 0x1a3050, 1.0), dl = new THREE.DirectionalLight(0xffe8cc, 1.6); dl.position.set(4, 6, 3); scene.add(hemi, dl);
    const steelB = [], strips = [], ledB = [], ledA = [], floorB = [{ c: [0, -0.3, -0.5], s: [24, 0.6, 17] }], hazB = [{ c: [0, 0.006, -8.7], s: [24, 0.014, 0.6] }];
    const box = (arr, cx, cy, cz, w, h, d, ph) => arr.push({ c: [cx, cy, cz], s: [w, h, d], ph: ph == null ? R() : ph });
    box(steelB, 0, -3, -9.2, 24, 6, 0.8, 0); box(strips, 0, 0.03, -9.0, 24, 0.04, 0.05, 0);
    for (const sx of [-1, 1]) {
      box(steelB, sx * 11, 5, -9.2, 1.6, 12, 1.2, 0); box(strips, sx * 10.1, 5, -8.55, 0.06, 10, 0.08, 0); box(steelB, sx * 7.0, 5, -9.2, 0.5, 12, 0.5, 0);
      for (let i = 0; i < 10; i++) box(i % 3 === 0 ? ledA : ledB, sx * 10.1, 0.6 + i * 1.0, -8.5, 0.12, 0.12, 0.08);
      box(steelB, sx * 7, 0.5, -4, 3.4, 1.0, 2.6, 0); box(strips, sx * 7, 1.02, -4, 3.0, 0.03, 2.2, 0); for (let i = 0; i < 5; i++) box(i % 2 ? ledA : ledB, sx * 5.4, 0.7, -5 + i * 0.5, 0.08, 0.08, 0.04);
      box(steelB, sx * 12, 2, 0, 1, 4, 16, 0); box(strips, sx * 11.45, 0.06, 0, 0.04, 0.04, 15, 0);
    }
    box(steelB, 0, 9.6, -9.2, 24, 1.2, 1.2, 0); box(strips, 0, 8.95, -8.55, 22, 0.05, 0.05, 0);
    for (let i = 0; i < 6; i++) { box(steelB, 0, 8.6, -6 + i * 3.2, 24, 0.3, 0.3, 0); box(strips, 0, 8.4, -6 + i * 3.2, 20, 0.04, 0.04, 0); }
    for (let i = 0; i < 24; i++) box(i % 4 === 3 ? ledA : ledB, -11 + i * 0.95, -0.2, -9.63, 0.1, 0.07, 0.03);
    box(steelB, -9, -1.5, -50, 1.5, 1.5, 80, 0); for (let i = 0; i < 10; i++) box(ledA, -9, -0.6, -14 - i * 8, 0.3, 0.3, 0.3);
    const mesh = (m, mat, ph) => { const me = new THREE.Mesh(geo(THREE, mergeBoxes(m), ph), mat); me.frustumCulled = false; own.push(me); group.add(me); return me; };
    mesh(floorB, M.floor({ plate: 0.8, guides: [-3.2, -1.1, 1.1, 3.2], glow: 1.5, noise: tier.name === 'high' })); mesh(hazB, M.hazard()); mesh(steelB, M.steel({ a: [0.06, 0.07, 0.09], b: [0.12, 0.13, 0.16] })); mesh(strips, M.glow([0.25, 0.8, 1.7]));
    mesh(ledB, M.led([0.2, 0.7, 2.0], 3.1), true); mesh(ledA, M.led([2.0, 1.1, 0.2], 2.3), true);
    // hologram ring on the deck under the cards
    const { vec3, atan, length, step, fract, smoothstep, float, uv, time } = T;
    const ringMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const rp = uv().sub(0.5).mul(2.0), rr = length(rp), ang = atan(rp.x, rp.y).div(6.2832).add(0.5), sweep = fract(ang.sub(time.mul(0.08)));
    ringMat.colorNode = vec3(0.15, 0.7, 1.8).mul(smoothstep(0.02, 0.0, rr.sub(0.96).abs()).mul(0.9).add(smoothstep(0.015, 0.0, rr.sub(0.8).abs()).mul(0.5)).add(step(0.8, fract(ang.mul(60))).mul(step(0.86, rr)).mul(step(rr, 0.95)).mul(0.8)).add(sweep.mul(sweep).mul(sweep).mul(smoothstep(0.9, 0.5, rr)).mul(0.07)));
    ringMat.opacityNode = float(1);
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.03, -2.2); ring.frustumCulled = false; own.push(ring); group.add(ring);
    const motes = motesMesh(THREE, tier.motes * 2, (r) => ({ x: (r() - 0.5) * 18, y: r() * 8, z: -r() * 12 + 2, dist: 1, size: 0.03 + r() * 0.05, r: 0.6, g: 0.8, b: 1, a: 0.25 + r() * 0.5 }), 31, M, own, group);
    const C = { scene, cam, tier, raf: 0, last: 0, running: false, paused: false, scroll: 0.5, rest: [0, 1.55, 7.5], w: 0, h: 0, frames: 0 };
    const size = () => {
      const host = o.host, r = o.renderer; if (!host || !r) return; const w = Math.max(10, host.clientWidth), h = Math.max(10, host.clientHeight), pr = Math.min(W.devicePixelRatio || 1, MW.prCap());
      const sz = r.getSize(new THREE.Vector2());
      if (Math.abs(sz.x - w) > 0.5 || Math.abs(sz.y - h) > 0.5 || r.getPixelRatio() !== pr) { r.setPixelRatio(pr); r.setSize(w, h, false); r._csW = 0; r._csH = 0; }
      if (C.w !== w || C.h !== h) { C.w = w; C.h = h; cam.aspect = w / h; cam.updateProjectionMatrix(); if (Math.abs(cam.aspect - sunA) > 0.05) { sunA = cam.aspect; sun = sunDirFor(sunA, fov, 1, 13, 0.55); sky.setSun(sun); } }
    };
    const stepFrame = (t, force) => {
      if (!force) { if (C.paused || (W.document && W.document.hidden) || (o.busy && o.busy())) { C.last = 0; return; } if (C.last && t - C.last < 1000 / tier.fps - 2) return; }
      const dt = C.last ? Math.min(0.1, (t - C.last) / 1000) : 0.03; C.last = t; const ts = t / 1000;
      MW.govern(dt * 1000); size(); const wh = o.wheel; if (wh && wh.scrollWidth > wh.clientWidth) C.scroll += (wh.scrollLeft / (wh.scrollWidth - wh.clientWidth) - C.scroll) * Math.min(1, dt * 5);
      const sw = swayAt(ts, 0.16), x = sw.x + (C.scroll - 0.5) * 2.4, y = 1.55 + sw.y;
      cam.position.set(x, y, 7.5); cam.lookAt(x * 0.35, 2.15, -30); cam.updateMatrixWorld(true);
      const c = [x, y, 7.5], set = (g, k) => { const v = parallaxOffset(c, C.rest, k); g.position.set(v[0], v[1], v[2]); };
      sky.update(ts); sky.placePlanet(parallaxOffset(c, C.rest, PARALLAX_K.planet)); sky.layers.forEach((L) => set(L.grp, L.k)); sky.syncAtm(); ring.rotation.z = ts * 0.12; motes.position.y = Math.sin(ts * 0.15) * 0.4;
      o.renderer.render(scene, cam); C.frames++;
    };
    const frame = (t) => { if (!C.running) return; C.raf = requestAnimationFrame(frame); stepFrame(t, false); };
    C.renderOnce = (t) => stepFrame(t, true);   // one frame now, no throttling (tests / screenshots)
    C.start = () => { if (C.running) return; C.running = true; C.last = 0; C.raf = requestAnimationFrame(frame); };
    C.stop = () => { C.running = false; if (C.raf) cancelAnimationFrame(C.raf); C.raf = 0; };
    C.pause = (b) => { C.paused = !!b; C.last = 0; C.w = 0; };
    C.dispose = () => { C.stop(); try { scene.remove(group); hemi.dispose && hemi.dispose(); dl.dispose && dl.dispose(); } catch (e) { } dispose(); MW.stats.live = Math.max(0, MW.stats.live - 1); };
    MW.stats.worlds++; MW.stats.live++; info('card world', tier.name);
    return C;
  };
})(typeof window !== 'undefined' ? window : globalThis);
