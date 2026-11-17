/* DMSpaceShafts (t1537) — the key star's light in open space: a soft glare round the key star (DMStars' brightest apparent star, Veyra binary aware:
 * the second star adds its own, dimmer glare + scatter), interplanetary dust forward-scattering it near the sun direction, and the nearest world's
 * shadow cut out of that dust analytically, so with the star behind a planet the light wraps past the limb in a thin bright rim and the planet's
 * shadow cone runs dark through the glow.  Ships / the temple / the planet itself occlude it through the depth test (they write depth; this doesn't).
 *
 *   No light is added and no sun is re-aimed: the directions come from DMStars (the same star bodies the key light follows; in open space through
 *   DMStars.fromPoint(camera) = the key from where the camera is, on a world DMStars.keyDir via _pwKeyDir()).  One camera-centred back-face shell
 *   (additive, no depth write, no shadows, noBend), one fragment pass over the sky pixels only:
 *     glare  = k_g * pow(cos, P) * vis(camera -> star)             (analytic sphere test, soft limb)
 *     scatter= k_d * HG(cos, g) * avg_i vis(x_i -> star)            (N jittered samples along the view ray, analytic sphere shadow per sample)
 *   pixels > ~78 deg off the star skip the march (HG there is < 2 % of its peak).  Nothing allocates per frame.
 *
 *   Quality gate (DMLight tier picker, the same one DMSunFar / DMVLight use):  low = OFF (Low is the 30 fps floor on the weakest GPUs and open space
 *   is already its heaviest scene: the star sprite's own bloom-less disc stays), med = 3 samples, high = 5, ultra = 7.  DMBudget light level >= 2,
 *   the fast guard >= 2 or a frame EMA > 40 ms fades it out (and back in, 1 s ease).  Hidden inside a world's air (DMAtmo / DMVLight own that sky).
 *
 *   ?spaceshafts=0 off   ?spaceshafts=<k> strength (default 1)   DMSpaceShafts.status() for numbers.
 */
(function () {
  'use strict';
  const W = typeof window !== 'undefined' ? window : globalThis;
  const Q = (W.location && W.location.search) || '';
  const fq = (Q.match(/[?&]spaceshafts=([0-9.]+|off|low|med|high|ultra)\b/) || [])[1];
  const OFF = fq === '0' || fq === 'off';
  const GAIN = fq && /^[0-9.]+$/.test(fq) && +fq > 0 ? Math.min(4, +fq) : 1;
  const TIERS = { low: 0, med: 3, high: 5, ultra: 7 };   // march samples per sky pixel (0 = off)
  const K = { glare: 0.07, dust: 0.012, P: 64, g: 0.72, skipCos: 0.2, limb: [0.985, 1.035], airIn: [1.06, 1.18], ease: 1.0, emaOff: 40 };

  // ── pure core (tools/tests/space-shafts.js) ──
  function tierN(t) { if (fq && TIERS[fq] != null) return TIERS[fq]; return TIERS[t] != null ? TIERS[t] : TIERS.med; }
  function hg(c, g) { const g2 = g * g; return (1 - g2) / (4 * Math.PI * Math.pow(1 + g2 - 2 * g * c, 1.5)); }
  // visibility of the star from point x (camera-relative) past a sphere (centre P, radius r): 1 lit, 0 shadow, soft at the limb
  function vis(x, L, P, r) {
    const ox = x[0] - P[0], oy = x[1] - P[1], oz = x[2] - P[2], b = ox * L[0] + oy * L[1] + oz * L[2], c = ox * ox + oy * oy + oz * oz;
    if (c < r * r) return 0;
    if (b >= 0) return 1;
    const d = Math.sqrt(Math.max(c - b * b, 0)), t = Math.max(0, Math.min(1, (d / r - K.limb[0]) / (K.limb[1] - K.limb[0])));
    return t * t * (3 - 2 * t);
  }
  // budget gate: wanted on (1) / off (0)
  function wantOn(lvl, fast, ema) { return !(lvl >= 2 || fast >= 2 || ema > K.emaOff); }
  const core = { TIERS, K, tierN, hg, vis, wantOn };

  const S = { on: !OFF, built: false, err: '', tier: '', n: 0, mesh: null, U: null, k: 0, want: 0, best: null, scanT: 0, frames: 0, shown: false, why: '' };
  const D = W.DMSpaceShafts = { core, S, on: S.on };

  function pickTier() {
    let t = null; try { t = W.DMLight && W.DMLight.tier; } catch (e) { }
    if (TIERS[t] == null) { try { const L = W.DMLight, c = L && L.core; t = c && c.pickTier ? c.pickTier(W.GFX || {}, null) : 'med'; if (c && c.capTier && c.presetCap && W.GFX) t = c.capTier(t, c.presetCap(W.GFX.resolved || W.GFX.preset, !!W.GFX.isMobile)); } catch (e) { t = 'med'; } }
    return TIERS[t] != null ? t : 'med';
  }

  function build(THREE, scene) {
    S.built = true;
    try {
      const T = THREE.TSL || W.THREE_TSL || W; if (!T || !T.Fn || !THREE.MeshBasicNodeMaterial) { S.err = 'no TSL'; return false; }
      S.tier = pickTier(); S.n = tierN(S.tier); if (!S.n) { S.why = 'tier ' + S.tier + ': off'; return false; }
      const { Fn, If, float, vec3, vec4, uniform, normalize, dot, max, min, sqrt, pow, smoothstep, clamp, positionWorld, cameraPosition } = T;
      const U = S.U = { L: uniform(new THREE.Vector3(0, 1, 0)), L2: uniform(new THREE.Vector3(0, 1, 0)), c1: uniform(new THREE.Color(0, 0, 0)), c2: uniform(new THREE.Color(0, 0, 0)),
        P: uniform(new THREE.Vector3(0, -1e9, 0)), r: uniform(1), len: uniform(1), pOn: uniform(0), k: uniform(0) };
      const n = S.n, g = K.g, g2 = g * g, hgK = (1 - g2) / (4 * Math.PI), ign = T.interleavedGradientNoise && T.screenCoordinate ? T.interleavedGradientNoise(T.screenCoordinate.xy) : float(0.5);
      // soft analytic sphere visibility (same as core.vis)
      const visN = (x, L) => {
        const o = x.sub(U.P), b = dot(o, L), c = dot(o, o), r = U.r;
        const d = sqrt(max(c.sub(b.mul(b)), 0.0)).div(r), soft = smoothstep(K.limb[0], K.limb[1], d);
        const lit = b.greaterThanEqual(0.0).select(float(1), soft);
        return c.lessThan(r.mul(r)).select(float(0), lit).mul(U.pOn).add(float(1).sub(U.pOn));
      };
      const hgN = (cth) => float(hgK).div(pow(float(1 + g2).sub(cth.mul(2 * g)), 1.5));
      const col = Fn(() => {
        const v = normalize(positionWorld.sub(cameraPosition)), c1 = dot(v, U.L), c2 = dot(v, U.L2);
        const out = vec3(0).toVar();
        If(U.k.greaterThan(0.001).and(max(c1, c2).greaterThan(K.skipCos)), () => {
          // the view ray ends at the world (analytic hit), else runs the dust length
          const o = U.P.negate(), b = dot(o, v), cc = dot(o, o).sub(U.r.mul(U.r)), disc = b.mul(b).sub(cc);
          const hit = disc.greaterThan(0.0).and(b.lessThan(0.0)).and(U.pOn.greaterThan(0.5)), tEnd = hit.select(min(U.len, b.negate().sub(sqrt(max(disc, 0.0)))), U.len);
          const dt = tEnd.div(n), a1 = float(0).toVar(), a2 = float(0).toVar();
          for (let i = 0; i < n; i++) { const x = v.mul(dt.mul(ign.add(i))); a1.addAssign(visN(x, U.L)); a2.addAssign(visN(x, U.L2)); }
          const fr = tEnd.div(U.len);   // the share of the dust column in front of the world
          const z = vec3(0), cam = z;
          const g1 = pow(clamp(c1, 0.0, 1.0), K.P).mul(K.glare).mul(visN(cam, U.L)), g2v = pow(clamp(c2, 0.0, 1.0), K.P).mul(K.glare).mul(visN(cam, U.L2));
          const s1 = hgN(c1).mul(K.dust).mul(a1.div(n)).mul(fr), s2 = hgN(c2).mul(K.dust).mul(a2.div(n)).mul(fr);
          out.assign(vec3(U.c1).mul(g1.add(s1)).add(vec3(U.c2).mul(g2v.add(s2))).mul(U.k));
        });
        return vec4(out, 1.0);
      })();
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.BackSide });
      mat.colorNode = col; mat.fog = false; mat.name = 'dm_spaceshafts'; mat.lights = false;
      const geo = new THREE.SphereGeometry(1, 32, 16), mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'dm_spaceshafts'; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 9990; mesh.visible = false; mesh.matrixAutoUpdate = true;
      mesh.userData.noBend = true; mesh.userData.dmFarSkip = true; mesh.userData.noDMLight = true;
      scene.add(mesh); S.mesh = mesh; S.scene = scene;
      return true;
    } catch (e) { S.err = 'build: ' + (e && e.message || e); S.mesh = null; S.U = null; return false; }
  }

  const _sd = [null, null, null], _sw = new Float64Array(3), _c = { x: 0, y: 0, z: 0 };
  // nearest world (the registry index.html's true atmosphere uses): rescanned every ~0.5 s, its centre read each frame
  function nearest(reg, cam, v) {
    let best = null, bd = Infinity;
    for (let i = 0; i < reg.length; i++) { const e = reg[i], m = e && e.mesh; if (!m || !m.parent || !m.userData.planetR) continue; m.getWorldPosition(v); const d = v.distanceTo(cam.position) / m.userData.planetR; if (d < bd) { bd = d; best = m; } }
    return bd <= 400 ? best : null;
  }

  // per frame (index.html renderWithPostFX, before the draw): cam = the flight camera, scene = the flight scene, o = { reg, pw, atmos, keyDir, dt }
  D.tick = function (THREE, scene, cam, o) {
    if (!S.on || !THREE || !scene || !cam) return;
    if (!S.built) build(THREE, scene);
    const U = S.U, m = S.mesh; if (!U || !m) return;
    if (m.parent !== scene) scene.add(m);
    const dt = Math.min(0.1, (o && o.dt) || 1 / 60), St = W.DMStars;
    // budget: fade out under pressure
    let lvl = 0, fast = 0, ema = 0; try { const B = W.DMBudget; if (B && B.on) { lvl = B.lvl ? B.lvl('light') | 0 : 0; fast = B.fast ? B.fast() | 0 : 0; ema = B.emaMs ? B.emaMs() : 0; } } catch (e) { }
    let want = wantOn(lvl, fast, ema) ? 1 : 0; S.why = want ? '' : 'budget';
    if (!St || !St.count) { want = 0; S.why = 'no stars'; }
    if (o && o.pw && o.atmos) { want = 0; S.why = 'in air'; }
    // key star (+ the second star of a binary) from where the camera is
    if (want) {
      if (!_sd[0]) for (let i = 0; i < 3; i++) _sd[i] = new THREE.Vector3();
      let key = 0, oth = -1;
      if (o && o.pw && o.keyDir) { U.L.value.copy(o.keyDir); key = St.keyIdx | 0; _sw[key] = 1; for (let i = 0; i < St.count; i++) if (i !== key) { if (St.dir && St.dir[i]) U.L2.value.copy(St.dir[i]); _sw[i] = St.w ? St.w[i] : 0; oth = i; break; } }
      else { key = St.fromPoint(cam.position, _sd, _sw); U.L.value.copy(_sd[key]); for (let i = 0; i < St.count; i++) if (i !== key) { oth = i; U.L2.value.copy(_sd[i]); break; } }
      const ck = St.col[key], wk = Math.max(0.35, _sw[key] / Math.max(1e-6, _sw[key] + (oth >= 0 ? _sw[oth] : 0)));
      U.c1.value.setRGB(ck.r * wk, ck.g * wk, ck.b * wk);
      if (oth >= 0) { const c2 = St.col[oth], w2 = (1 - wk) * 0.8; U.c2.value.setRGB(c2.r * w2, c2.g * w2, c2.b * w2); } else U.c2.value.setRGB(0, 0, 0);
      // the nearest world casts the shadow (off on a world's own surface: the ground already hides the sky below the horizon)
      U.pOn.value = 0;
      if (!(o && o.pw) && o && o.reg) {
        S.scanT -= dt; if (S.scanT <= 0 || (S.best && !S.best.parent)) { S.scanT = 0.5; S.best = nearest(o.reg, cam, U.P.value); }
        const b = S.best;
        if (b) {
          b.getWorldPosition(U.P.value); U.P.value.sub(cam.position);
          const r = b.userData.planetR, d = U.P.value.length() / r; U.r.value = r; U.pOn.value = 1; U.len.value = Math.max(4 * r, U.P.value.length() + 2.5 * r);
          if (d < K.airIn[1] && b.userData.atmoTop > 0) { const t = Math.max(0, Math.min(1, (d - K.airIn[0]) / (K.airIn[1] - K.airIn[0]))); if (t <= 0) { want = 0; S.why = 'in air'; } else want *= t; }
        } else U.len.value = 1;
      }
    }
    S.want = want;
    const step = dt / K.ease; S.k = S.k < want ? Math.min(want, S.k + step) : Math.max(want, S.k - step);
    U.k.value = S.k * GAIN;
    const show = S.k > 0.001; m.visible = show; S.shown = show;
    if (show) { const R = Math.max(10, (cam.far || 1e5) * 0.9); m.scale.setScalar(R); m.position.copy(cam.position); }
    S.frames++;
  };
  D.status = function () { const U = S.U; return { on: S.on, tier: S.tier, n: S.n, built: !!S.mesh, shown: S.shown, k: +S.k.toFixed(3), want: +(+S.want).toFixed(2), why: S.why, planet: U ? U.pOn.value : 0, err: S.err }; };
  D.dispose = function () { try { if (S.mesh) { if (S.mesh.parent) S.mesh.parent.remove(S.mesh); S.mesh.geometry.dispose(); S.mesh.material.dispose(); } } catch (e) { } S.mesh = null; S.U = null; S.built = false; };
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})();
