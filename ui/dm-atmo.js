/* DART Meadow — true volumetric planet atmospheres + ocean bodies (v98).
 *
 * Gas is bound to the planet by gravity: density is an exponential
 * (sea-level-pressure) falloff with a per-planet scale height H, measured
 * above the real surface boundary  max(terrain, sea level), modulated by a
 * low-res 3-D noise density field (dm-mist style) that a small compute pass
 * re-advects each frame (time-animated swirl: bands, shear, vortices).
 * It is NOT a shell/rim/glow: it is a single-scattering raymarch through the
 * gas that runs as a depth-aware full-screen node pass, so every nearer
 * opaque thing (ship, Ariel, hair, board, terrain) occludes it exactly.
 *
 * Collision boundaries for the ray:  scene depth, the sea-level equipotential
 * sphere (water body, shaded with depth absorption + fresnel sky reflection +
 * wave normal) and the terrain height field (no gas ever inside the planet).
 *
 * Thickness comes from extinction/opacity coefficients, not sample count:
 * Rayleigh + Mie + up to 4 coloured gas layers (ozone band, haze, methane…)
 * each with its own extinction rgb, albedo, altitude and width.
 *
 * Works with THREE.WebGPURenderer on both backends: WebGPU uses a compute
 * pass to update the density volume; WebGL2 falls back to a CPU-baked volume
 * with the same shader-side swirl.  Usage:
 *   const atmo = DMAtmo.create(THREE, TSL, {renderer, scene, camera, planet, quality});
 *   atmo.render(dt)   // instead of renderer.render(scene, camera)
 */
(function (root) {
  'use strict';
  const STEPS = { low: 10, medium: 16, high: 24, ultra: 36, auto: 16, custom: 20 };
  const VOX = 32;

  // Baseline look = the current in-game JOTS_PlanetAtmo / dusty shell (Lague-style):
  // shell thickness ~0.18R, density falloff 5.5 over the shell, Rayleigh (400/λ)^4 × scatter.
  // Coefficients here are per atmosphere-thickness ("top") so the look is scale-free.
  function lagueRayleigh(scatter) { return [Math.pow(400 / 700, 4) * scatter, Math.pow(400 / 530, 4) * scatter, Math.pow(400 / 440, 4) * scatter]; }
  function presetEarth(R) {
    const top = R * 0.10;
    return {
      radius: R, seaLevel: 0, heightScale: R * 0.012, top, scaleHeight: top / 3.2,
      gravity: 9.81, surfacePressure: 1.0,
      rayleigh: lagueRayleigh(1.25), mie: 0.02, mieG: 0.8, hazeAmount: 0.05, hazeHeight: R * 0.0012,
      cloud: { amount: 0.3, height: R * 0.022, width: R * 0.004, ext: 25, freq: 3.2 },
      // mostly clear, with the odd regional / hemisphere storm system drifting through
      weather: { coverage: 0.3, scale: 0.9, speed: 0.004, ext: 40, albedo: [0.82, 0.84, 0.88], alt: R * 0.02, width: R * 0.007 },
      layers: [{ ext: [0.010, 0.030, 0.0015], albedo: 0.0, alt: top * 0.15, width: top * 0.08, amount: 1.0 }], // ozone (Chappuis band)
      storm: { swirl: 0.25, bands: 3.0, speed: 0.02 },
      water: { absorb: [0.45, 0.09, 0.05], deep: [0.0, 0.05, 0.09], waveAmp: 0.18, waveFreq: 400 },
      sunIntensity: 7
    };
  }
  // desert world (Mars-like): thin CO2 air, butterscotch dust haze, occasional regional dust storms
  function presetDesert(R) {
    const P = presetEarth(R); const top = R * 0.06;
    Object.assign(P, { top, scaleHeight: top / 3.2, rayleigh: [0.55, 0.42, 0.32], mie: 0.25, mieG: 0.65, hazeAmount: 0.08,
      cloud: null, layers: [{ ext: 0.35, albedo: [0.78, 0.52, 0.32], alt: top * 0.12, width: top * 0.15, amount: 1.0 }],
      weather: { coverage: 0.15, scale: 1.1, speed: 0.006, ext: 30, albedo: [0.80, 0.55, 0.33], alt: top * 0.08, width: top * 0.12 },
      water: null, seaLevel: null, sunIntensity: 6 });
    return P;
  }
  function presetGasGiant(R) {
    return {
      radius: R * 0.92, seaLevel: null, heightScale: 0, top: R * 0.11, scaleHeight: R * 0.02,
      gravity: 24.8, surfacePressure: 3.0,
      rayleigh: [0.25, 0.5, 1.1], mie: 0.6, mieG: 0.6, hazeAmount: 0, hazeHeight: 1,
      cloud: null,
      layers: [
        { ext: 1.2, albedo: [0.78, 0.40, 0.17], alt: R * 0.045, width: R * 0.03, amount: 1.0, banded: 1, belt: 1 },  // NH4SH belts (orange-brown)
        { ext: 1.0, albedo: [0.96, 0.90, 0.78], alt: R * 0.05, width: R * 0.03, amount: 1.0, banded: 1, belt: 0 },   // NH3-ice zones (cream)
        { ext: [0.25, 0.06, 0.03], albedo: 0.0, alt: R * 0.085, width: R * 0.02, amount: 1.0 }                     // methane haze: absorbs red
      ],
      storm: { swirl: 1.0, bands: 7.0, speed: 0.04, vortex: [0.45, -0.38, 0.8] },
      water: null,
      sunIntensity: 5
    };
  }

  // ── seamless value-noise fbm for the CPU volume (WebGL fallback) ───────
  function bakeVolumeCPU(THREE, seed) {
    const N = VOX, d = new Uint8Array(N * N * N);
    let s = (seed >>> 0) || 7; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const lat = []; for (let o = 0; o < 4; o++) { const P = 4 << o, a = new Float32Array(P * P * P); for (let i = 0; i < a.length; i++) a[i] = rnd(); lat.push([P, a]); }
    const sm = (t) => t * t * (3 - 2 * t);
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let v = 0, amp = 0.5;
      for (const [P, a] of lat) {
        const fx = x / N * P, fy = y / N * P, fz = z / N * P, ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
        const tx = sm(fx - ix), ty = sm(fy - iy), tz = sm(fz - iz), g = (i, j, k) => a[((i % P) * P + (j % P)) * P + (k % P)];
        const l = (i, j) => g(ix + i, iy + j, iz) * (1 - tz) + g(ix + i, iy + j, iz + 1) * tz;
        const r0 = l(0, 0) * (1 - ty) + l(0, 1) * ty, r1 = l(1, 0) * (1 - ty) + l(1, 1) * ty;
        v += amp * (r0 * (1 - tx) + r1 * tx); amp *= 0.5;
      }
      d[(z * N + y) * N + x] = Math.max(0, Math.min(255, v / 0.9375 * 255));
    }
    const t = new THREE.Data3DTexture(d, N, N, N);
    t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.needsUpdate = true; return t;
  }

  // ── equirect height map of the solid surface (units above radius) ──────
  function bakeHeight(THREE, heightFn, W, Hh) {
    W = W || 512; Hh = Hh || 256;
    const d = new Uint16Array(W * Hh);
    for (let j = 0; j < Hh; j++) {
      const lat = ((j + 0.5) / Hh - 0.5) * Math.PI, cy = Math.sin(lat), cr = Math.cos(lat);
      for (let i = 0; i < W; i++) {
        const lon = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
        d[j * W + i] = THREE.DataUtils.toHalfFloat(heightFn(cr * Math.cos(lon), cy, cr * Math.sin(lon)));
      }
    }
    const t = new THREE.DataTexture(d, W, Hh, THREE.RedFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true; return t;
  }

  // baked global height maps shared between passes (e.g. Earth's relief, prebaked in idle time at load)
  const HCACHE = new Map();
  function prebakeHeight(THREE, key, heightFn, heightScale) {
    if (HCACHE.has(key)) return HCACHE.get(key);
    const t = bakeHeight(THREE, (x, y, z) => heightFn(x, y, z) / Math.max(heightScale, 1e-6)); HCACHE.set(key, t); return t;
  }
  function create(THREE, TSL, opt) {
    const { renderer, scene } = opt; let camera = opt.camera;
    const P = Object.assign({}, opt.planet);
    const T = TSL;
    const { Fn, float, vec2, vec3, vec4, uniform, texture, texture3D, screenUV, Loop, If, Break, exp, max, min, sqrt, dot, normalize, length,
      mix, clamp, smoothstep, pow, atan, asin, sin, cos, fract, abs, mx_noise_float, pass, logarithmicDepthToViewZ, perspectiveDepthToViewZ } = T;
    const isWebGPU = !!(renderer.backend && renderer.backend.isWebGPUBackend);
    const logDepth = !!opt.logarithmicDepth;

    const U = {
      center: uniform(new THREE.Vector3().copy(P.center || new THREE.Vector3())),
      camPos: uniform(new THREE.Vector3()), invProj: uniform(new THREE.Matrix4()), camWorld: uniform(new THREE.Matrix4()),
      near: uniform(0.1), far: uniform(1000), sun: uniform(new THREE.Vector3(1, 0.3, 0.2).normalize()),
      time: uniform(0), frame: uniform(0), planetRot: uniform(0),
      R0: uniform(P.radius), sea: uniform(P.seaLevel == null ? 0 : P.seaLevel), hScale: uniform(P.heightScale),
      top: uniform(P.top), H: uniform(P.scaleHeight),
      betaR: uniform(new THREE.Vector3(...P.rayleigh)), mie: uniform(P.mie), mieG: uniform(P.mieG),
      haze: uniform(P.hazeAmount), hazeH: uniform(P.hazeHeight), sunI: uniform(P.sunIntensity),
      exposureScale: uniform(1 / P.top), // coefficients are per "top" length so they are scale-free
      rot: uniform(new THREE.Matrix4()),       // world -> planet-local rotation (terrain map + storms turn with the planet)
      locC: uniform(new THREE.Vector3(0, 0, 1)), locOn: uniform(0), // local LOD height map: centre x,z (world) + span
      histK: uniform(0), skyW: uniform(1), aerialW: uniform(1)  // weights: rays that reach empty sky / that hit geometry
    };
    const hasSea = P.seaLevel != null && !!P.water;
    const steps = STEPS[opt.quality] || STEPS.medium;

    const cachedH = P.heightKey && HCACHE.get(P.heightKey);
    const heightTex = cachedH ? cachedH : P.heightFn ? bakeHeight(THREE, (x, y, z) => P.heightFn(x, y, z) / Math.max(P.heightScale, 1e-6)) : (() => {
      const t = new THREE.DataTexture(new Uint16Array([0]), 1, 1, THREE.RedFormat, THREE.HalfFloatType); t.needsUpdate = true; return t; })();

    // density volume: compute-advected on WebGPU, CPU-baked on WebGL
    let volTex, computeNode = null;
    if (isWebGPU && THREE.Storage3DTexture && T.textureStore && T.instanceIndex) {
      try {
        volTex = new THREE.Storage3DTexture(VOX, VOX, VOX);
        volTex.format = THREE.RGBAFormat; volTex.type = THREE.HalfFloatType; // rgba16float: storage-capable + filterable in core WebGPU
        volTex.minFilter = volTex.magFilter = THREE.LinearFilter; volTex.wrapS = volTex.wrapT = volTex.wrapR = THREE.RepeatWrapping;
        const { instanceIndex, uvec3, textureStore, uint } = T;
        computeNode = Fn(() => {
          const i = instanceIndex, x = i.mod(VOX), y = i.div(VOX).mod(VOX), z = i.div(VOX * VOX);
          const p = vec3(float(x), float(y), float(z)).div(VOX).mul(6.2831853);
          // periodic domain (torus embedding) so the volume tiles; curl-ish advection by time
          const q = vec3(sin(p.x), sin(p.y), sin(p.z)).mul(1.3).add(vec3(cos(p.y), cos(p.z), cos(p.x)).mul(1.1));
          const w = vec3(mx_noise_float(q.add(U.time.mul(0.05))), mx_noise_float(q.add(7.1)), mx_noise_float(q.sub(3.3).add(U.time.mul(0.03)))).mul(0.8);
          const n = mx_noise_float(q.mul(1.0).add(w)).mul(0.5).add(mx_noise_float(q.mul(2.1).add(w.mul(1.7))).mul(0.25)).add(mx_noise_float(q.mul(4.3)).mul(0.125));
          textureStore(volTex, uvec3(x, y, z), vec4(n.mul(0.7).add(0.5), 0, 0, 1)).toWriteOnly();
        })().compute(VOX * VOX * VOX, [64]);
      } catch (e) { console.warn('[DMAtmo] compute volume unavailable, CPU fallback', e); computeNode = null; volTex = null; }
    }
    if (!volTex) volTex = bakeVolumeCPU(THREE, opt.seed || 1337);

    // fine local height map round the camera/focus (the near LOD of the real ground), world x/z
    const LOC_N = opt.localRes || 128;
    const locData = new Uint16Array(LOC_N * LOC_N);
    const locTex = new THREE.DataTexture(locData, LOC_N, LOC_N, THREE.RedFormat, THREE.HalfFloatType);
    locTex.minFilter = locTex.magFilter = THREE.LinearFilter; locTex.wrapS = locTex.wrapT = THREE.ClampToEdgeWrapping; locTex.needsUpdate = true;

    const pp = new (THREE.RenderPipeline || THREE.PostProcessing)(renderer);
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode('output');
    const sceneDepth = scenePass.getTextureNode('depth');
    // optional background layer (open space / sky drawn by another scene+camera): world composited over it by alpha
    const skyPass = opt.skyScene ? pass(opt.skyScene, opt.skyCamera || camera) : null;
    const skyColor = skyPass ? skyPass.getTextureNode('output') : null;

    const raySphere = (ro, rd, r) => { // returns vec2(tNear, tFar); no hit => (1e20, -1e20)
      const b = dot(ro, rd), c = dot(ro, ro).sub(r.mul(r)), h = b.mul(b).sub(c);
      const s = sqrt(max(h, 0.0));
      return h.lessThan(0.0).select(vec2(1e20, -1e20), vec2(b.negate().sub(s), b.negate().add(s)));
    };
    const dirUV = (d) => vec2(atan(d.z, d.x).div(6.2831853).add(0.5), asin(clamp(d.y, -1.0, 1.0)).div(3.14159265).add(0.5));
    const toLocal = (d) => U.rot.mul(vec4(d, 0.0)).xyz;
    const globalH = (d) => texture(heightTex, dirUV(toLocal(d))).r.mul(U.hScale);
    // ground height above the reference radius at relative point p (dir up): local LOD map where it covers, global map elsewhere
    const groundAt = (p, up) => {
      const wxz = vec2(p.x.add(U.center.x), p.z.add(U.center.z));
      const luv = wxz.sub(U.locC.xy).div(U.locC.z).add(0.5);
      const edge = min(min(luv.x, luv.y), min(float(1.0).sub(luv.x), float(1.0).sub(luv.y)));
      const w = smoothstep(0.0, 0.08, edge).mul(U.locOn);
      const hl = texture(locTex, clamp(luv, 0.0, 1.0)).r;
      return mix(globalH(up), hl, w);
    };
    const terrainH = globalH;

    // planet-rotated sample of the density volume with storm swirl (differential rotation => bands, vortex warp)
    const S = P.storm || { swirl: 0, bands: 1, speed: 0 };
    const vort = S.vortex ? new THREE.Vector3(...S.vortex) : null;
    // storm field: differential (latitude-banded) rotation + one long-lived vortex, both time-animated
    const warpDir = (dir) => {
      const lat = asin(clamp(dir.y, -1.0, 1.0));
      const ang = U.time.mul(S.speed).mul(sin(lat.mul(S.bands))).mul(S.swirl);
      const c = cos(ang), s = sin(ang);
      let d = vec3(dir.x.mul(c).sub(dir.z.mul(s)), dir.y, dir.x.mul(s).add(dir.z.mul(c)));
      if (vort) {
        const vc = normalize(vec3(vort.x, vort.y, vort.z)); const dd = d.sub(vc.mul(dot(d, vc)));
        const r2 = dot(dd, dd);
        const tw = exp(r2.mul(-1.0 / (vort.z > 0 ? 0.012 : 0.01))).mul(2.6).mul(U.time.mul(0.05).add(1.0)).mul(S.swirl);
        const cr = vec3(vc.y.mul(d.z).sub(vc.z.mul(d.y)), vc.z.mul(d.x).sub(vc.x.mul(d.z)), vc.x.mul(d.y).sub(vc.y.mul(d.x)));
        d = normalize(d.mul(cos(tw)).add(cr.mul(sin(tw))).add(vc.mul(dot(d, vc).mul(float(1.0).sub(cos(tw))))));
      }
      return d;
    };
    const gasNoise = (dir, alt, freq) => {
      const d = warpDir(toLocal(dir));
      const p = d.mul(freq).add(vec3(0.0, alt.mul(U.exposureScale).mul(2.0), 0.0));
      const n1 = texture3D(volTex, p, 0).r, n2 = texture3D(volTex, p.mul(2.7).add(0.37), 0).r;
      return n1.mul(0.65).add(n2.mul(0.35));
    };

    const build = (mode, gasTex) => Fn(() => {
      const uv = screenUV;
      const ndc = vec2(uv.x.mul(2.0).sub(1.0), opt.flipY ? uv.y.mul(2.0).sub(1.0) : uv.y.mul(-2.0).add(1.0));
      const vdh = U.invProj.mul(vec4(ndc, 1.0, 1.0));
      const vdir = normalize(vdh.xyz.div(vdh.w));
      const rd = normalize(U.camWorld.mul(vec4(vdir, 0.0)).xyz);
      const ro = U.camPos.sub(U.center);
      const dRaw = sceneDepth.sample(uv).r;
      const vz = logDepth ? logarithmicDepthToViewZ(dRaw, U.near, U.far) : perspectiveDepthToViewZ(dRaw, U.near, U.far);
      const sceneDist = dRaw.greaterThanEqual(0.99999).select(float(1e20), vz.div(vdir.z)).toVar();
      const wc = sceneColor.sample(uv);
      const base = (skyColor ? mix(skyColor.sample(uv).rgb, wc.rgb, clamp(wc.a, 0.0, 1.0)) : wc.rgb).toVar();

      const Rsea = U.R0.add(U.sea), Rtop = U.R0.add(U.top);
      const sun = normalize(U.sun);
      const mu = dot(rd, sun);
      const tEnd = sceneDist.toVar();

      // ── ocean body: sea-level equipotential, a collision boundary for gas ──
      const dbgV = vec3(0.0).toVar();
      if (hasSea) {
        const W = P.water;
        const ts = raySphere(ro, rd, Rsea);
        if (opt.debug === 4) dbgV.assign(vec3(ts.x.div(200.0), sceneDist.div(200.0), terrainH(normalize(ro.add(rd.mul(ts.x)))).div(U.hScale).negate()));
        If(ts.x.greaterThan(0.0).and(ts.x.lessThan(sceneDist)), () => {
          const pw = ro.add(rd.mul(ts.x)), nUp = normalize(pw);
          const ground = groundAt(pw, nUp);
          If(ground.lessThan(U.sea), () => {
            const depthAlong = min(sceneDist.sub(ts.x), U.top.mul(4.0));
            const vert = U.sea.sub(ground); // column depth (for colour), path length for absorption
            const path = max(depthAlong, vert);
            const k = vec3(...W.absorb).mul(U.exposureScale).mul(60.0);
            const trans = exp(k.mul(path).negate());
            const deep = vec3(...W.deep);
            const sunUp = clamp(dot(nUp, sun).mul(3.0).add(0.15), 0.0, 1.0);
            const wcol = base.mul(trans).add(deep.mul(sunUp).mul(vec3(1.0).sub(trans)));
            // gentle wave normal
            const wp = pw.mul(W.waveFreq / P.radius).add(vec3(U.time.mul(0.3), 0.0, U.time.mul(0.2)));
            const e = 0.05;
            const n0 = mx_noise_float(wp), nx = mx_noise_float(wp.add(vec3(e, 0, 0))), nz = mx_noise_float(wp.add(vec3(0, 0, e)));
            const tA = normalize(vec3(nUp.z.negate(), 0.0, nUp.x).add(vec3(0.0, 1e-4, 0.0)));
            const tB = normalize(vec3(nUp.y.mul(tA.z).sub(nUp.z.mul(tA.y)), nUp.z.mul(tA.x).sub(nUp.x.mul(tA.z)), nUp.x.mul(tA.y).sub(nUp.y.mul(tA.x))));
            const nW = normalize(nUp.sub(tA.mul(nx.sub(n0).div(e).mul(W.waveAmp * 0.1))).sub(tB.mul(nz.sub(n0).div(e).mul(W.waveAmp * 0.1))));
            const cosI = clamp(dot(nW, rd.negate()), 0.0, 1.0);
            const fres = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(cosI), 5.0)));
            const refl = rd.sub(nW.mul(dot(rd, nW).mul(2.0)));
            // sky colour seen in reflection: rayleigh tint * sun elevation + horizon whitening
            const sunEl = dot(nUp, sun);
            const skyDay = U.betaR.div(33.1).mul(0.35).mul(smoothstep(-0.15, 0.25, sunEl));
            const horizon = vec3(1.0, 0.55, 0.3).mul(exp(abs(sunEl).mul(-8.0))).mul(0.25);
            const skyC = skyDay.add(horizon).mul(smoothstep(-0.05, 0.4, dot(refl, nUp)).mul(0.6).add(0.4));
            const spec = pow(clamp(dot(refl, sun), 0.0, 1.0), 400.0).mul(U.sunI).mul(smoothstep(-0.02, 0.05, sunEl));
            if (mode !== 'gas') base.assign(mix(wcol, skyC, fres).add(spec));
            tEnd.assign(ts.x);
          });
        });
      }

      // ── never fill the interior: hard stop at the deepest solid radius ──
      const tIn = raySphere(ro, rd, U.R0.add(min(U.sea, 0.0)).sub(U.hScale.mul(0.5)));
      If(tIn.x.greaterThan(0.0), () => { tEnd.assign(min(tEnd, tIn.x)); });

      const tt = raySphere(ro, rd, Rtop);
      const t0 = max(tt.x, 0.0), t1 = min(tt.y, tEnd);
      const Ltot = vec3(0.0).toVar(), Tr = vec3(1.0).toVar();
      if (mode !== 'composite') If(t1.greaterThan(t0), () => {
        const ds = t1.sub(t0).div(steps);
        // interleaved-gradient jitter, rotated per frame (pairs with TAA / temporal blend)
        const px = uv.mul(vec2(1920.0, 1080.0));
        const jit = fract(fract(dot(px.add(U.frame.mul(5.588238)), vec2(0.06711056, 0.00583715))).mul(52.9829189));
        const g = U.mieG;
        const phR = mu.mul(mu).add(1.0).mul(3.0 / (16.0 * Math.PI));
        const phM = float(1.0).sub(g.mul(g)).div(pow(g.mul(g).add(1.0).sub(g.mul(mu).mul(2.0)), 1.5)).mul(1.0 / (4.0 * Math.PI));
        const inv = U.exposureScale; // coefficients are per unit "top"
        Loop(steps, ({ i }) => {
          const t = t0.add(ds.mul(float(i).add(jit)));
          const p = ro.add(rd.mul(t)), r = length(p), up = p.div(r);
          const solid = U.R0.add(max(groundAt(p, up), U.sea));   // gas boundary = max(terrain, water)
          const alt = r.sub(solid);
          If(alt.greaterThan(0.0), () => {
            const hSea = r.sub(Rsea);
            const fadeTop = smoothstep(Rtop, Rtop.sub(U.top.mul(0.25)), r);
            const rhoR = exp(hSea.negate().div(U.H)).mul(fadeTop);
            const rhoM = exp(hSea.negate().div(U.H.mul(0.25))).mul(fadeTop).add(exp(alt.negate().div(U.hazeH)).mul(U.haze));
            const n = gasNoise(up, hSea, 3.0);
            let ext = U.betaR.mul(rhoR).add(vec3(U.mie).mul(rhoM).mul(n.mul(1.2).add(0.4)));
            let scat = U.betaR.mul(rhoR).mul(phR).add(vec3(U.mie).mul(rhoM).mul(phM).mul(n.mul(1.2).add(0.4)));
            // clouds / coloured gas layers: gaussian in altitude × noise, thickness = extinction coefficient
            const C = P.cloud;
            if (C) {
              const nc = gasNoise(up, hSea.mul(0.3), C.freq);
              const band = exp(hSea.sub(C.height).div(C.width).pow(2.0).negate());
              const cd = smoothstep(float(1.0 - C.amount * 0.6), float(1.0 - C.amount * 0.6 + 0.25), nc).mul(band).mul(fadeTop);
              ext = ext.add(vec3(C.ext).mul(cd));
              scat = scat.add(vec3(C.ext * 0.9).mul(cd).mul(phM.mul(0.5).add(0.06)));
            }
            const Wx = P.weather;
            if (Wx) {
              // storm systems: a slowly drifting low-frequency mask over the planet (regional/hemisphere scale)
              const ld = toLocal(up);
              const q = ld.mul(Wx.scale).add(vec3(U.time.mul(Wx.speed), 0.0, U.time.mul(Wx.speed * 0.6)));
              const mask = smoothstep(float(1.0 - Wx.coverage), float(1.0 - Wx.coverage + 0.12), texture3D(volTex, q, 0).r.mul(0.6).add(texture3D(volTex, q.mul(0.37).add(0.21), 0).r.mul(0.4)));
              const band = exp(hSea.sub(Wx.alt).div(Wx.width).pow(2.0).negate());
              const wd2 = mask.mul(band).mul(gasNoise(up, hSea, 4.0).mul(1.5).add(0.25)).mul(fadeTop);
              const e3 = vec3(Wx.ext).mul(wd2);
              ext = ext.add(e3);
              scat = scat.add(e3.mul(vec3(...Wx.albedo)).mul(phM.mul(0.4).add(0.05)));
            }
            for (const Ly of (P.layers || [])) {
              const band = exp(hSea.sub(Ly.alt).div(Ly.width).pow(2.0).negate()).mul(Ly.amount);
              let m = band;
              if (Ly.banded) {
                const wd = warpDir(toLocal(up));
                const lat = asin(clamp(wd.y, -1.0, 1.0));
                const zb = sin(lat.mul(S.bands * 2.0).add(gasNoise(up, hSea, 0.9).sub(0.5).mul(5.0))).mul(0.5).add(0.5);
                m = band.mul(Ly.belt ? smoothstep(0.35, 0.65, zb) : smoothstep(0.65, 0.35, zb)).mul(gasNoise(up, hSea, 5.0).mul(1.4).add(0.3));
              }
              // thickness/colour from the layer's extinction coefficient + single-scattering albedo, not extra samples
              const e3 = (Array.isArray(Ly.ext) ? vec3(...Ly.ext) : vec3(Ly.ext)).mul(m).mul(8.0);
              const alb = Array.isArray(Ly.albedo) ? vec3(...Ly.albedo) : vec3(Ly.albedo);
              ext = ext.add(e3);
              scat = scat.add(e3.mul(alb).mul(phM.mul(0.3).add(1.0 / (4 * Math.PI))));
            }
            // sun visibility: planet shadow + airmass-scaled extinction toward the sun (no secondary march)
            const muS = dot(up, sun);
            const muH = sqrt(max(float(1.0).sub(Rsea.mul(Rsea).div(r.mul(r))), 0.0)).negate();
            const vis = smoothstep(muH.sub(0.015), muH.add(0.02), muS);
            const am = float(1.0).div(max(muS.sub(muH), 0.0).add(sqrt(U.H.div(r)).mul(0.45)));
            const sunT = exp(ext.mul(inv).mul(U.H).mul(am).mul(1.6).negate()).mul(vis);
            const e = ext.mul(inv), sd = e.mul(ds);
            const a = exp(sd.negate());
            Ltot.addAssign(Tr.mul(scat.mul(inv)).mul(sunT).mul(vec3(1.0).sub(a)).div(max(e, vec3(1e-6))));
            Tr.mulAssign(a);
          });
        });
      });
      if (opt.debug === 4) return vec4(dbgV, 1.0);
      if (opt.debug === 5) return vec4(length(ro).sub(1000.0).div(30.0), Rsea.sub(1000.0).div(30.0).add(0.5), raySphere(ro, rd, Rsea).x.div(100.0), 1.0);
      if (opt.debug === 1) return vec4(base, 1.0);
      if (opt.debug === 2) return vec4(Tr, 1.0);
      if (opt.debug === 3) return vec4(sceneDist.div(5000.0), t0.div(5000.0), t1.div(5000.0), 1.0);
      // NaN / runaway guard: a broken sample never paints the screen (falls back to the scene as drawn)
      const Lraw = Ltot.mul(U.sunI);
      if (mode === 'gas') {
        const sL = dot(Lraw, vec3(1.0)), ok = sL.equal(sL).and(sL.lessThan(1e6));
        return ok.select(vec4(Lraw, dot(Tr, vec3(1.0 / 3.0))), vec4(0.0, 0.0, 0.0, 1.0));
      }
      let Lf = Lraw, Tf = Tr;
      if (mode === 'composite') { const g = gasTex.sample(uv); Lf = g.rgb; Tf = vec3(g.a); }
      const wgt = sceneDist.greaterThanEqual(1e19).select(U.skyW, U.aerialW);
      const outC = mix(base, base.mul(Tf).add(Lf), wgt);
      const sC = dot(outC, vec3(1.0));
      return sC.equal(sC).and(sC.lessThan(1e6)).select(vec4(outC, 1.0), vec4(base, 1.0));
    })();
    // half-resolution gas (mobile under Auto): march at half res, composite + water at full res
    let gasRT = null;
    if (opt.halfRes && T.rtt) {
      gasRT = T.rtt(build('gas'), null, null, { type: THREE.HalfFloatType });
      if (gasRT.setResolutionScale) gasRT.setResolutionScale(opt.gasScale > 0 && opt.gasScale < 1 ? opt.gasScale : 0.5);
    }
    const atmo = gasRT ? build('composite', gasRT) : build('full');

    pp.outputNode = atmo;
    let frame = 0;
    function syncCamera(cam) {
      camera = cam || camera; scenePass.camera = camera;
      camera.updateMatrixWorld();
      U.camPos.value.setFromMatrixPosition(camera.matrixWorld);
      U.invProj.value.copy(camera.projectionMatrixInverse);
      U.camWorld.value.copy(camera.matrixWorld);
      U.near.value = camera.near; U.far.value = camera.far;
    }
    return {
      uniforms: U, params: P, isWebGPU, usesCompute: !!computeNode, steps,
      setSun(v) { U.sun.value.copy(v).normalize(); },
      setCenter(v) { U.center.value.copy(v); },
      setWeights(sky, aerial) { U.skyW.value = sky; U.aerialW.value = aerial == null ? 1 : aerial; },
      // planet orientation (quaternion of the planet group in world space)
      setRotation(q) { U.rot.value.makeRotationFromQuaternion(q).invert(); },
      // bake the near LOD height map: fn(x,z) -> height above sea (units), centred at world (cx,cz), span units
      setLocalHeight(cx, cz, span, fn) {
        if (!fn) { U.locOn.value = 0; return; }
        const N = LOC_N, toH = THREE.DataUtils.toHalfFloat;
        for (let j = 0; j < N; j++) { const z = cz + ((j + 0.5) / N - 0.5) * span;
          for (let i = 0; i < N; i++) { let h = fn(cx + ((i + 0.5) / N - 0.5) * span, z); if (!isFinite(h)) h = 0; locData[j * N + i] = toH(h); } }
        locTex.needsUpdate = true; U.locC.value.set(cx, cz, span); U.locOn.value = 1;
      },
      render(dt, cam) {
        U.time.value += dt || 0; U.frame.value = (frame++) % 64;
        syncCamera(cam);
        if (computeNode && (frame % 2 === 1)) renderer.compute(computeNode);
        if (skyPass) {
          if (opt.skyCamera) skyPass.camera = opt.skyCamera;
          const ca = renderer.getClearAlpha(); renderer.setClearAlpha(0);
          try { pp.render(); } finally { renderer.setClearAlpha(ca); }
        } else pp.render();
      },
      async renderAsync(dt, cam) {
        U.time.value += dt || 0; U.frame.value = (frame++) % 64; syncCamera(cam);
        if (computeNode) await renderer.computeAsync(computeNode);
        pp.render();
      },
      dispose() { try { pp.dispose(); volTex.dispose(); locTex.dispose(); if (!cachedH) heightTex.dispose(); } catch (e) {} }
    };
  }

  root.DMAtmo = { create, prebakeHeight, presetEarth, presetDesert, presetGasGiant, STEPS, version: 'v98' };
})(typeof window !== 'undefined' ? window : globalThis);
