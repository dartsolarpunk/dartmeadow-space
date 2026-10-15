/* DM Mist — volumetric cloud, mist and dust for the world engine (WebGPU / TSL).

   planetClouds(radius, kind)  a ray-marched cloud layer round a world: noise-shaped
                               density between two shells, wind-scrolled, lit by the
                               star with a short march toward the light for self-shadow
                               (the volumetric shadows and shafts through the deck) and a
                               forward-scattering phase, so thin edges glow against the sun.
                               Each world has its own air: Earth's water cloud, Venus'
                               fast sulphur deck, Mars' thin dust-and-ice wisps, Titan's
                               orange methane haze — different colour, speed, scale, turbulence.
                               Fly into the layer and the same march is the mist you are in.
   beltDust(parent, opts)      streams of fine dust shed by asteroids along the belt, in
                               different colours, some glowing; they trail along the orbit.
   frame(cam, dt)              per frame: which side of the layer you are on, dust drift.

   Phones get fewer steps and octaves (the build is told `low`). */
(function(){
  'use strict';
  const W = window;
  const TSL = () => (W.THREE && W.THREE.TSL) || null;
  const live = new Set();       // cloud layers
  const dusts = new Set();      // belt dust systems (retired: too dense near the Sun — see asteroidFumes)

  /* each world's air: shell = [bottom, top] as multiples of the radius, cover 0..1, scale = how many
     cloud cells round the globe, wind = scroll speed, shear = how much the wind varies with latitude,
     col = sunlit colour, dark = shadowed colour, dens = optical thickness, turb = how much the flow is whipped up */
  const LOOKS = {
    earth: { shell: [1.004, 1.024], cover: 0.50, scale: 7.0, wind: 0.012, shear: 0.5, turb: 0.28, col: [1.0, 1.0, 1.0], dark: [0.50, 0.58, 0.72], dens: 5.0 },
    venus: { shell: [1.006, 1.040], cover: 0.78, scale: 3.4, wind: 0.060, shear: 0.15, turb: 0.35, col: [1.0, 0.90, 0.55], dark: [0.62, 0.42, 0.16], dens: 7.5 },
    mars:  { shell: [1.002, 1.014], cover: 0.34, scale: 8.0, wind: 0.030, shear: 0.5, turb: 0.55, col: [0.95, 0.68, 0.46], dark: [0.46, 0.27, 0.18], dens: 2.4 },
    titan: { shell: [1.006, 1.044], cover: 0.70, scale: 3.0, wind: 0.010, shear: 0.3, turb: 0.40, col: [1.0, 0.62, 0.26], dark: [0.40, 0.18, 0.05], dens: 5.5 },
  };
  function lookFor(kind) {
    const k = String(kind || '').toLowerCase();
    for (const n in LOOKS) if (k.indexOf(n) >= 0) return LOOKS[n];
    return null;
  }

  /* ───────────── planet cloud layer ───────────── */
  function cloudMaterial(T, U, R, L, low, side) {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side });
    const { float, vec3, sin, exp, dot, normalize, mix, smoothstep, time, select } = T;
    const Rb = R * L.shell[0], Rt = R * L.shell[1], thick = Rt - Rb;
    const ro = T.cameraPosition.sub(U.center), rd = normalize(T.positionWorld.sub(T.cameraPosition));
    const b = dot(ro, rd), c = dot(ro, ro).sub(Rt * Rt);
    const disc = b.mul(b).sub(c).max(0.0).sqrt();
    const t0 = b.negate().sub(disc).max(0.0);
    let t1 = b.negate().add(disc);
    // the planet is solid: stop where the ray meets the bottom of the layer's globe
    const cb = dot(ro, ro).sub(Rb * Rb), db = b.mul(b).sub(cb);
    const hitB = b.negate().sub(db.max(0.0).sqrt());
    t1 = select(db.greaterThan(0.0).and(hitB.greaterThan(t0)), hitB, t1);
    const steps = low ? 5 : 9, lsteps = low ? 1 : 2;
    const dt = t1.sub(t0).max(0.0).div(steps);
    const Ls = U.sunDir;
    const wind = time.mul(L.wind);
    const dens = (p) => {
      const r = p.length(), n = p.div(r);
      const h = r.sub(Rb).div(thick).clamp(0.0, 1.0);
      const prof = smoothstep(0.0, 0.18, h).mul(float(1).sub(smoothstep(0.45, 1.0, h)));
      // wind: scrolls the field, faster or slower with latitude (the bands), whipped by a slow warp (turbulence)
      const band = sin(n.y.mul(7.0)).mul(L.shear).add(1.0);
      let q = n.mul(L.scale).add(U.seed);
      q = q.add(vec3(wind.mul(band), wind.mul(0.3), wind.mul(band).mul(0.6)).mul(8.0));
      q = q.add(vec3(sin(q.y.mul(1.7).add(wind.mul(9.0))), sin(q.z.mul(1.5).sub(wind.mul(7.0))), sin(q.x.mul(1.9).add(wind.mul(8.0)))).mul(L.turb * 0.5));
      let nz;
      if (T.mx_fractal_noise_float) nz = T.mx_fractal_noise_float(q, low ? 2 : 3, 2.1, 0.5).mul(0.5).add(0.5);
      else nz = sin(q.x.mul(2.3)).mul(sin(q.y.mul(2.1))).mul(sin(q.z.mul(2.5))).mul(0.5).add(0.5);
      const cov = smoothstep(float(1.08 - L.cover), float(1.08 - L.cover + 0.26), nz);
      return cov.mul(prof);
    };
    const col = new THREE.Color(L.col[0], L.col[1], L.col[2]), dark = new THREE.Color(L.dark[0], L.dark[1], L.dark[2]);
    const colU = vec3(col.r, col.g, col.b), darkU = vec3(dark.r, dark.g, dark.b);
    let Tr = float(1), acc = vec3(0, 0, 0);
    const k = L.dens / (thick * 2.0);
    for (let i = 0; i < steps; i++) {
      const p = ro.add(rd.mul(t0.add(dt.mul(i + 0.5))));
      const d = dens(p);
      // march toward the sun: the cloud casts its own shadow (and its neighbours')
      let od = float(0);
      for (let j = 1; j <= lsteps; j++) od = od.add(dens(p.add(Ls.mul(thick * 0.9 * j / lsteps))));
      const lightT = exp(od.mul(-L.dens * 0.55));
      const n = p.normalize();
      const lit = smoothstep(-0.12, 0.22, dot(n, Ls));                           // night side goes dark
      const cosT = dot(rd, Ls);                                                   // forward scatter: thin edges glow toward the sun
      const phase = float(0.8).add(exp(cosT.sub(1.0).mul(5.0)).mul(1.6));
      const light = lightT.mul(lit).mul(phase);
      const sc = mix(darkU.mul(0.35), colU, light.clamp(0.0, 1.0)).add(colU.mul(lightT.mul(lit).mul(0.25)));
      const sig = d.mul(k).mul(dt);
      const stepT = exp(sig.negate());
      acc = acc.add(sc.mul(Tr).mul(float(1).sub(stepT)));
      Tr = Tr.mul(stepT);
    }
    const alpha = float(1).sub(Tr);
    m.colorNode = acc.div(alpha.max(1e-3));
    m.opacityNode = alpha.mul(U.fade);
    m.toneMapped = false;
    return m;
  }

  function planetClouds(radius, kind, opts) {
    const T = TSL(); const L = lookFor(kind);
    if (!T || !L || !W.THREE.MeshBasicNodeMaterial) return null;
    opts = opts || {};
    const low = !!opts.low, R = radius;
    const U = { center: T.uniform(new THREE.Vector3()), sunDir: T.uniform(new THREE.Vector3(1, 0.3, 0.2).normalize()), seed: T.uniform(new THREE.Vector3((opts.seed || 3) * 1.3 % 7, (opts.seed || 3) * 2.1 % 7, (opts.seed || 3) * 0.7 % 7)), fade: T.uniform(1) };
    const group = new THREE.Group(); group.name = 'JOTS_MistClouds';
    const geo = new THREE.SphereGeometry(R * L.shell[1], low ? 40 : 64, low ? 28 : 44);
    const out = new THREE.Mesh(geo, cloudMaterial(T, U, R, L, low, THREE.FrontSide));    // from space
    const inn = new THREE.Mesh(geo, cloudMaterial(T, U, R, L, low, THREE.BackSide));     // from inside the layer: the mist you fly through
    out.renderOrder = inn.renderOrder = 3; out.frustumCulled = inn.frustumCulled = false; inn.visible = false;
    group.add(out, inn);
    const h = { group, out, inn, U, R, L, mesh: out, planetCenterU: U.center, sunDirU: U.sunDir };
    live.add(h);
    return h;
  }

  /* ───────────── belt dust ───────────── */
  let puffTex = null;
  function puffTexture() {
    if (puffTex) return puffTex;
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const x = cv.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.55)'); g.addColorStop(0.6, 'rgba(255,255,255,0.14)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    puffTex = new THREE.CanvasTexture(cv); return puffTex;
  }
  const STREAMS = [   // colour, glow (0..1), how it reads: rock dust, rust, ice, sulphur, carbon-dark, metal
    [0.62, 0.55, 0.42, 0.0], [0.80, 0.42, 0.26, 0.15], [0.55, 0.72, 0.95, 0.5], [0.95, 0.82, 0.38, 0.55], [0.36, 0.33, 0.32, 0.0], [0.70, 0.74, 0.80, 0.25], [0.88, 0.50, 0.36, 0.3],
  ];
  function beltDust(parent, o) {
    if (!W.THREE) return null;
    o = o || {};
    const R = o.R || 100, wid = o.width || R * 0.35, low = !!o.low, rnd = o.rand || Math.random;
    const nStreams = low ? 8 : 14, per = low ? 16 : 30, N = nStreams * per;
    const m = new THREE.MeshBasicMaterial({ map: puffTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), m, N);
    mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.name = 'JOTS_BeltDust';
    const srcs = [];
    for (let i = 0; i < nStreams; i++) {
      const st = STREAMS[Math.floor(rnd() * STREAMS.length)];
      srcs.push({ a: rnd() * Math.PI * 2, r: R + (rnd() - 0.5) * wid, y: (rnd() - 0.5) * wid * 0.08, col: st, len: 0.04 + rnd() * 0.07, spread: wid * (0.02 + rnd() * 0.04), sz: wid * (0.06 + rnd() * 0.09), ph: rnd() * 6.28 });
    }
    const off = new Float32Array(N * 3); for (let i = 0; i < N * 3; i++) off[i] = rnd() - 0.5;
    const M4 = new THREE.Matrix4(), PV = new THREE.Vector3(), SC = new THREE.Vector3(), Q = new THREE.Quaternion(), CL = new THREE.Color();
    const d = { mesh, srcs, per, N, R, t: 0 };
    d.tick = function (cam, dt) {
      d.t += dt;
      if (cam) Q.copy(cam.quaternion);
      for (let s = 0; s < srcs.length; s++) {
        const sr = srcs[s], a0 = sr.a + d.t * 0.0015 / Math.max(0.2, (sr.r / R) ** 1.5);          // slow Kepler-ish drift
        for (let j = 0; j < per; j++) {
          const i = s * per + j, u = j / per;                                                       // along the stream, source → tail
          const a = a0 - u * sr.len;
          const sp = sr.spread * (0.3 + u * 1.7);                                                   // the plume widens as it trails
          const wob = Math.sin(d.t * 0.2 + sr.ph + u * 5.0) * sp * 0.6;                             // turbulence curls the tail
          const rr = sr.r + off[i * 3] * sp * 2 + wob, yy = sr.y + off[i * 3 + 1] * sp;
          PV.set(Math.cos(a) * rr, yy, Math.sin(a) * rr);
          const fade = (1 - u) * Math.min(1, u * 6 + 0.25);
          const sz = sr.sz * (0.7 + u * 1.5);
          M4.compose(PV, Q, SC.setScalar(sz));
          mesh.setMatrixAt(i, M4);
          const g = 0.55 * fade * (1 + sr.col[3] * (0.8 + 0.4 * Math.sin(d.t * 0.9 + i)));       // glowing ones breathe
          mesh.setColorAt(i, CL.setRGB(sr.col[0] * g, sr.col[1] * g, sr.col[2] * g));
        }
      }
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    d.tick(null, 0);
    if (parent) parent.add(mesh);
    dusts.add(d);
    return d;
  }


  /* ───────────── asteroid fumes ─────────────
     A few asteroids smoke: coloured gas venting from the rock itself — sulphur yellow, copper green, rust,
     ice blue, ash — like a chemical eating into sulphur. Each plume is a few dozen ragged, noisy puffs born
     on the asteroid's surface, curling out and thinning as they go, so the rock stays in plain view. */
  let smokeTex = null;
  function smokeTexture() {
    if (smokeTex) return smokeTex;
    const N = 128, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const x = cv.getContext('2d'), img = x.createImageData(N, N);
    const hash = (i, j) => { let h = (i * 374761393 + j * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
    const vn = (px, py) => { const i = Math.floor(px), j = Math.floor(py), fx = px - i, fy = py - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v; };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const dx = (i - N / 2) / (N / 2), dy = (j - N / 2) / (N / 2), r = Math.sqrt(dx * dx + dy * dy);
      let n = 0, a = 0.55, f = 3.0; for (let o = 0; o < 5; o++) { n += a * vn(i / N * f + 7.3, j / N * f + 2.1); a *= 0.5; f *= 2.05; }   // ragged, noisy edge
      const edge = Math.max(0, 1 - r), al = Math.max(0, Math.min(1, (0.25 + (n - 0.22) * 1.9) * Math.pow(edge, 0.85) * 1.25 - 0.08 * (1 - edge)));   // filled body, ragged edge
      const k = (j * N + i) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = Math.round(al * 255);
    }
    x.putImageData(img, 0, 0); smokeTex = new THREE.CanvasTexture(cv); return smokeTex;
  }
  const FUME_COLS = [   // r,g,b, additive?
    [0.95, 0.85, 0.22, 1], [0.30, 0.85, 0.52, 1], [0.86, 0.38, 0.20, 1], [0.48, 0.72, 1.00, 1], [0.62, 0.42, 1.00, 1], [0.34, 0.31, 0.29, 0],
  ];
  const fumes = new Set();
  /* asteroidFumes(group, rad, opts): vents on `group` (the asteroid, radius rad). opts.col = index into FUME_COLS,
     opts.rand = seeded random, opts.low = fewer puffs */
  function asteroidFumes(group, rad, o) {
    if (!W.THREE || !group) return null;
    o = o || {}; const rnd = o.rand || Math.random, col = FUME_COLS[(o.col != null ? o.col : Math.floor(rnd() * FUME_COLS.length)) % FUME_COLS.length];
    const vents = o.low ? 2 : 3, per = o.low ? 20 : 34, N = vents * per;
    const m = new THREE.MeshBasicMaterial({ map: smokeTexture(), transparent: true, depthWrite: false, toneMapped: false,
      blending: col[3] ? THREE.AdditiveBlending : THREE.NormalBlending });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), m, N);
    mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.name = 'JOTS_AsteroidFume';
    const V = [];
    for (let v = 0; v < vents; v++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1), dir = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
      const side = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(dir, side);
      V.push({ dir, side, up, len: rad * (3.0 + rnd() * 2.5), rate: 0.05 + rnd() * 0.04, ph: rnd() * 10, sw: 0.5 + rnd() });
    }
    const rot = new Float32Array(N), seed = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { rot[i] = rnd() * 6.283; seed[i * 2] = rnd() * 6.283; seed[i * 2 + 1] = rnd() * 6.283; }
    const M4 = new THREE.Matrix4(), PV = new THREE.Vector3(), SC = new THREE.Vector3(), Q = new THREE.Quaternion(), QZ = new THREE.Quaternion(), CL = new THREE.Color();
    const ZA = new THREE.Vector3(0, 0, 1), PQ = new THREE.Quaternion();
    const d = { mesh, group, rad, t: rnd() * 100 };
    d.tick = function (cam, dt) {
      d.t += dt;
      group.getWorldQuaternion(PQ); PQ.invert();
      if (cam) Q.copy(cam.quaternion).premultiply(PQ);      // face the camera, in the asteroid's own frame
      for (let v = 0; v < vents; v++) {
        const vt = V[v];
        for (let j = 0; j < per; j++) {
          const i = v * per + j, u = (((d.t * vt.rate + j / per + vt.ph) % 1) + 1) % 1;       // 0 at the rock → 1 thin and far
          const s1 = seed[i * 2], s2 = seed[i * 2 + 1];
          const curl = rad * (0.12 + 1.0 * u * u);
          const cx = Math.sin(d.t * 0.9 * vt.sw + s1 + u * 7.0) * curl + Math.sin(d.t * 2.3 + s2 + u * 15.0) * curl * 0.35;   // slow sweep + fine turbulence
          const cy = Math.cos(d.t * 0.8 * vt.sw + s2 + u * 6.0) * curl + Math.cos(d.t * 2.7 + s1 + u * 13.0) * curl * 0.35;
          PV.copy(vt.dir).multiplyScalar(rad * 0.92 + vt.len * u * (0.6 + 0.4 * u)).addScaledVector(vt.side, cx).addScaledVector(vt.up, cy);
          const sz = rad * (0.30 + 0.85 * u);
          QZ.setFromAxisAngle(ZA, rot[i] + d.t * 0.12 * (i % 2 ? 1 : -1));
          M4.compose(PV, Q.clone().multiply(QZ), SC.setScalar(sz));
          mesh.setMatrixAt(i, M4);
          const g = Math.min(1, u * 9) * Math.pow(1 - u, 1.2) * (col[3] ? 0.62 : 0.8);
          mesh.setColorAt(i, CL.setRGB(col[0] * g, col[1] * g, col[2] * g));
        }
      }
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    d.tick(null, 0);
    group.add(mesh); fumes.add(d);
    return d;
  }

  /* ───────────── per frame ───────────── */
  const _v = new THREE.Vector3();
  // compile both cloud shells (seen-from-space and inside-the-layer) once, off the frame they first appear
  function precompile(h, cam) {
    try {
      const r = (typeof flightRenderer !== 'undefined' && flightRenderer); if (!r || !r.compileAsync) return;
      const sc = (typeof flightScene !== 'undefined' && flightScene); if (!sc) return;
      const hid = []; h.group.traverse(o => { if (!o.visible) { hid.push(o); o.visible = true; } });
      let p = null;
      try { p = r.compileAsync(sc, cam); if (p && p.catch) p.catch(() => {}); }
      finally { for (const o of hid) o.visible = false; }
      return p;
    } catch (e) {}
  }
  function frame(cam, dt) {
    if (!cam) return;
    for (const h of live) {
      if (!h.group.parent) { live.delete(h); continue; }
      if (!h.pre) { h.pre = true; precompile(h, cam); }
      h.group.getWorldPosition(_v);
      const dist = cam.position.distanceTo(_v);
      const inside = dist < h.R * h.L.shell[1] && dist > h.R * h.L.shell[0] * 0.98;
      h.out.visible = !inside && dist < h.R * 70;
      h.inn.visible = inside;
      h.U.fade.value = 1;
    }
    for (const f of fumes) {   // asteroid fumes: only animate while you are within sight of the rock
      if (!f.group.parent) { fumes.delete(f); continue; }
      f.group.getWorldPosition(_v);
      const fd = cam.position.distanceTo(_v), near = fd < f.rad * 260;
      f.mesh.visible = near;
      if (near) f.tick(cam, Math.min(0.1, dt || 1 / 60));
    }
    for (const d of dusts) {
      if (!d.mesh.parent) { dusts.delete(d); continue; }
      d.mesh.parent.getWorldPosition(_v);
      const dist = cam.position.distanceTo(_v.set(0, 0, 0));
      d.mesh.visible = true;
      d.tick(cam, Math.min(0.1, dt || 1 / 60));
    }
  }
  // load-time warm-up: compile the cloud shells now (resolves when the GPU has them)
  function warm(cam) {
    const ps = []; for (const h of live) { if (!h.group.parent) continue; h.pre = true; const p = precompile(h, cam); if (p && p.then) ps.push(p); }
    return Promise.all(ps);
  }
  W.DMMist = { planetClouds, beltDust, asteroidFumes, frame, warm, LOOKS };
})();
