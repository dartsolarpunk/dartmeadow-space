/* DART Meadow — DMVLight: lights that light the VOLUMETRIC fog / mist / dust (light shafts, visible beams).  (lighting overhaul)
 *
 * IDEA.  No new screen pass.  The surface scene's fog is a THREE.Fog; the node renderer lets a scene own `scene.fogNode`, which every fogged material
 * runs per fragment with the fragment's VIEW-space position (so the camera is the origin and the ray is simply normalize(positionView)).  DMVLight
 * installs a fogNode = the stock range fog + single-scattering from a SMALL LIGHT LIST integrated along that camera->fragment ray:
 *   • light list: the N nearest/brightest lights (N = 3 / 5 / 8 by tier), packed into 3 vec4 each (uniformArray, view space):
 *         A = (pos.xyz, range)   B = (colour*intensity.rgb, cosOuter)   C = (axis.xyz, 1/(cosInner-cosOuter))   axis = 0 -> point light, else spot cone
 *     slot weights fade in/out (0.25 s) so a light entering/leaving the top-N never pops.
 *   • per light the ray is clipped to its range sphere, then EQUI-ANGULAR sampled (Kulla-Fajardo): s = tc + H tan(a), so the 1/r^2 of the light cancels
 *     and 2..4 jittered samples are enough; each sample carries smooth range window (1-(r/range)^2)^2, spot cone smoothstep, Henyey-Greenstein phase and
 *     exp(-sigma (s + r)) transmittance.  For a point light with window = 1 and no cone this is the exact closed form (I/H)(atan b - atan a); the test
 *     tools/tests/vlight-unit.js checks the sampled form against brute-force integration.
 *   • medium: sigma(y) = sigma0 * (haze + mist * exp(-(y - groundY)/mistH)) * slow patchy modulation, taken at the ray midpoint — local fog/mist density.
 *   • sun: only when it is LOW (uSunOn > 0, CPU-gated by elevation): 1-2 DMLight.sunVisNode samples along the ray modulate a forward-scattered sun term, so
 *     shafts exist where the low sun is partly occluded.  High sun / open sky: uSunOn = 0 -> the branch is skipped (uniform branch, no cost).
 *   Open sky pixels are not fogged geometry, so they cost nothing (sky domes have fog=false).
 * Everything after install() is a uniform write: no recompile on toggling lights, tiers, budget steps or flashlight on/off.
 *
 * PUBLIC (window.DMVLight; the pure core is also module.exports for node, tools/tests/vlight-unit.js):
 *   install(scene, {THREE, tier})        once per scene right after scene.fog exists (installing later recompiles the fogged materials once)
 *   tick(dt, {camera, scene, sunDir, day, groundY, walk})   per frame, no allocation
 *   setPoints(key, Float32Array[x,y,z, r,g,b, range]*n, {level, gain})   static/occasional point lights (lamps, rail LEDs); colour is candela-like
 *   setLevel(key, 0..1) · setSpot(key, {x,y,z,dx,dy,dz,angle,penumbra,r,g,b,range,on,gain}) · clear(key)
 *   setMedium({density, mist, mistH, haze, patchy, gain})   status()
 *   Any material with fog=true (terrain, props, mist sprites that keep the scene fog) gets the shafts for free through scene.fogNode.
 *   Flashlight: if nobody calls setSpot('flash', ...), tick() reads DMFlash.S.light (position, target, angle, penumbra, intensity) itself.
 * FLAGS  ?vlights=0|off disables (nothing installed)   ?vlights=low|med|high forces a tier   ?vlgain=1.5   ?vldens=0.03
 * BUDGET DMBudget stage 'light' L1 -> half the lights, L2 -> 2 lights + no sun, L3 (or emaMs > 45) -> fades out to off; recovers the same way.
 * NOT VERIFIED on a GPU or device (the authoring sandbox has none): the shader builds from TSL names that exist in three 0.185, the maths is unit-tested in node. */
(function (root) {
  'use strict';

  /* ───────────────────────── pure core ───────────────────────── */
  const PI = Math.PI, EPS = 0.35, STRIDE = 12;
  const SUN_NEAR0 = 30, SUN_NEAR1 = 110;   // metres of view distance: the low-sun scatter term is 0 inside SUN_NEAR0 and full beyond SUN_NEAR1 (smoothstep^2)
  const TIERS = { low: { n: 3, k: 2, sun: 1 }, med: { n: 5, k: 3, sun: 1 }, high: { n: 8, k: 4, sun: 2 } };
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const smooth01 = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  // smooth range window: 1 at the light, exactly 0 (with zero slope) at range -> no hard edge
  function rangeWindow(r, range) { if (!(range > 0) || r >= range) return 0; const q = 1 - (r * r) / (range * range); return q * q; }
  // spot cone: smoothstep between cosOuter and cosInner
  function coneFactor(cosA, cosOuter, invRange) { return smooth01((cosA - cosOuter) * invRange); }
  // Henyey-Greenstein; c = cos(angle between light travel and the direction to the camera) (1 = looking into the light)
  function hg(c, g) { const g2 = g * g; return (1 - g2) / (4 * PI * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5)); }

  // one light, one ray (origin 0, unit dir d, length L): in-scatter radiance (scalar, multiply by colour).  Mirrors the shader line for line.
  // light = {x,y,z (relative to the camera), dx,dy,dz (axis, 0 = point), range, cosOuter, invR}; jit(k) -> 0..1 sample jitter.
  function lightScatter(li, d, L, sigma, g, K, jit) {
    const wx = li.x, wy = li.y, wz = li.z, tc = wx * d[0] + wy * d[1] + wz * d[2], h2 = Math.max(wx * wx + wy * wy + wz * wz - tc * tc, 0), R2 = li.range * li.range - h2;
    if (!(R2 > 0)) return 0;
    const R = Math.sqrt(R2), s0 = Math.max(tc - R, 0), s1 = Math.min(tc + R, L); if (!(s1 > s0)) return 0;
    const H = Math.sqrt(h2 + EPS * EPS), a0 = Math.atan((s0 - tc) / H), a1 = Math.atan((s1 - tc) / H), da = a1 - a0, spot = li.dx * li.dx + li.dy * li.dy + li.dz * li.dz > 0.25;
    let acc = 0;
    for (let k = 0; k < K; k++) {
      const u = (k + 0.5) / K + ((jit ? jit(k) : 0.5) - 0.5) / K, ang = a0 + da * u, s = tc + H * Math.tan(ang);
      const lx = d[0] * s - wx, ly = d[1] * s - wy, lz = d[2] * s - wz, r2 = lx * lx + ly * ly + lz * lz, r = Math.sqrt(r2), ir = 1 / Math.max(r, 1e-4);
      const wnd = rangeWindow(r, li.range), cone = spot ? coneFactor((lx * li.dx + ly * li.dy + lz * li.dz) * ir, li.cosOuter, li.invR) : 1;
      const ph = hg(-(lx * d[0] + ly * d[1] + lz * d[2]) * ir, g), tr = Math.exp(-sigma * (s + r));
      acc += wnd * cone * ph * tr;
    }
    return acc * da / (K * H) * sigma;
  }
  // brute-force reference of the same integrand (for tests): f(s) = window * cone * phase * T / (r^2 + eps^2)
  function lightScatterBrute(li, d, L, sigma, g, n) {
    const spot = li.dx * li.dx + li.dy * li.dy + li.dz * li.dz > 0.25; let acc = 0; const ds = L / n;
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * ds, lx = d[0] * s - li.x, ly = d[1] * s - li.y, lz = d[2] * s - li.z, r2 = lx * lx + ly * ly + lz * lz, r = Math.sqrt(r2), ir = 1 / Math.max(r, 1e-4);
      const cone = spot ? coneFactor((lx * li.dx + ly * li.dy + lz * li.dz) * ir, li.cosOuter, li.invR) : 1;
      acc += rangeWindow(r, li.range) * cone * hg(-(lx * d[0] + ly * d[1] + lz * d[2]) * ir, g) * Math.exp(-sigma * (s + r)) / (r2 + EPS * EPS) * ds;
    }
    return acc * sigma;
  }

  // ── light list packing: 12 floats per slot, view space.  m = column-major 4x4 world->view.  w = slot weight (fade) multiplies the colour.
  function packLight(out, slot, m, x, y, z, dx, dy, dz, r, g, b, w, range, cosOuter, cosInner) {
    const o = slot * STRIDE;
    out[o] = m[0] * x + m[4] * y + m[8] * z + m[12]; out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]; out[o + 3] = range;
    out[o + 4] = r * w; out[o + 5] = g * w; out[o + 6] = b * w; out[o + 7] = cosOuter;
    const sp = dx * dx + dy * dy + dz * dz > 1e-6;
    if (sp) { const il = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz); dx *= il; dy *= il; dz *= il; out[o + 8] = m[0] * dx + m[4] * dy + m[8] * dz; out[o + 9] = m[1] * dx + m[5] * dy + m[9] * dz; out[o + 10] = m[2] * dx + m[6] * dy + m[10] * dz; out[o + 11] = 1 / Math.max(cosInner - cosOuter, 1e-3); }
    else { out[o + 8] = out[o + 9] = out[o + 10] = 0; out[o + 11] = 1; }
    return out;
  }
  function clearSlot(out, slot) { out.fill(0, slot * STRIDE, slot * STRIDE + STRIDE); }

  // ── top-N picker (no allocation): push(id, score) keeps the N best, sorted descending
  function createPicker(n) { return { n, size: 0, id: new Int32Array(n), score: new Float32Array(n) }; }
  function pickReset(p) { p.size = 0; }
  function pickPush(p, id, score) {
    if (p.size >= p.n && score <= p.score[p.size - 1]) return;
    let i = p.size < p.n ? p.size++ : p.size - 1;
    while (i > 0 && p.score[i - 1] < score) { p.score[i] = p.score[i - 1]; p.id[i] = p.id[i - 1]; i--; }
    p.score[i] = score; p.id[i] = id;
  }
  // importance of a point-like source for ranking: power / (d^2 + 4), zero beyond range + pad
  function lightScore(lum, level, dist, range, pad) { return dist > range + pad || !(level > 0) ? 0 : lum * level / (dist * dist + 4); }

  // ── slots: a light keeps its slot while it is in the target set; leaving ones fade out and free the slot, entering ones take a free slot and fade in
  function createSlots(n) { return { n, id: new Int32Array(n).fill(-1), w: new Float32Array(n) }; }
  function stepSlots(S, target, nT, dt, rate) {
    const dw = Math.min(1, dt * rate);
    for (let i = 0; i < S.n; i++) {
      if (S.id[i] < 0) continue; let keep = false; for (let j = 0; j < nT; j++) if (target[j] === S.id[i]) { keep = true; break; }
      if (keep) S.w[i] = Math.min(1, S.w[i] + dw); else { S.w[i] -= dw; if (S.w[i] <= 0) { S.w[i] = 0; S.id[i] = -1; } }
    }
    for (let j = 0; j < nT; j++) {
      let has = false; for (let i = 0; i < S.n; i++) if (S.id[i] === target[j]) { has = true; break; } if (has) continue;
      for (let i = 0; i < S.n; i++) if (S.id[i] < 0) { S.id[i] = target[j]; S.w[i] = 0; break; }
    }
    return S;
  }
  // budget ladder -> {n, sun, on} (pure)
  function budgetPlan(maxN, lvl, emaMs) {
    if (lvl >= 3 || emaMs > 60) return { n: 0, sun: false };
    if (lvl === 2 || emaMs > 45) return { n: Math.min(maxN, 2), sun: false };
    if (lvl === 1) return { n: Math.max(1, Math.ceil(maxN / 2)), sun: true };
    return { n: maxN, sun: true };
  }
  function sunNearK(L) { const t = smooth01((L - SUN_NEAR0) / (SUN_NEAR1 - SUN_NEAR0)); return t * t; }   // CPU mirror of the shader's near fade of the low-sun term (tested)
  const core = { sunNearK, SUN_NEAR0, SUN_NEAR1, EPS, STRIDE, TIERS, rangeWindow, coneFactor, hg, lightScatter, lightScatterBrute, packLight, clearSlot, createPicker, pickReset, pickPush, lightScore, createSlots, stepSlots, budgetPlan, smooth01 };

  if (typeof module !== 'undefined' && module.exports) { module.exports = core; if (typeof window === 'undefined') return; }

  /* ───────────────────────── runtime ───────────────────────── */
  if (root.DMVLight) return;
  const q = (() => { try { return new URLSearchParams(root.location.search); } catch (e) { return new URLSearchParams(''); } })();
  const FLAG = (q.get('vlights') || '').toLowerCase();
  const V = { core, on: !/^(0|off|false|no)$/.test(FLAG) };
  root.DMVLight = V;
  const S = { tier: null, cfg: null, U: null, node: null, installed: false, failed: null, groups: [], spots: [], byKey: {}, flashAuto: null, k: 0, want: 0,
    plan: { n: 0, sun: false }, fade: null, pick: null, slots: null, tgt: null, buf: null, m: new Float32Array(16), medium: { density: 0.02, mist: 1, mistH: 7, haze: 0.18, patchy: 0.3, gain: 0.5 }, time: 0, nLive: 0 };
  V.S = S;
  const gain0 = parseFloat(q.get('vlgain')), dens0 = parseFloat(q.get('vldens'));
  if (gain0 > 0) S.medium.gain = gain0; if (dens0 > 0) S.medium.density = dens0;

  function pickTier() {
    if (/^(low|med|high)$/.test(FLAG)) return FLAG;
    let t = null; try { t = root.DMLight && root.DMLight.tier; } catch (e) { }
    const mobile = (() => { try { return /Android|iPhone|iPad|iPod|Mobile/i.test(root.navigator.userAgent) || (root.matchMedia && root.matchMedia('(pointer:coarse)').matches); } catch (e) { return false; } })();
    if (mobile) return 'low';
    return t === 'high' || t === 'ultra' ? 'high' : t === 'med' ? 'med' : t === 'low' ? 'low' : 'med';
  }

  // ── sources
  function group(key) { let g = S.byKey[key]; if (!g) { g = S.byKey[key] = { key, gi: S.groups.length, kind: 'points', data: null, n: 0, level: 1, gain: 1, off: false }; S.groups.push(g); } return g; }
  V.setPoints = function (key, arr, o) { const g = group(key); g.kind = 'points'; g.data = arr instanceof Float32Array ? arr : new Float32Array(arr); g.n = (g.data.length / 7) | 0; if (o) { if (o.level != null) g.level = o.level; if (o.gain != null) g.gain = o.gain; } g.off = false; return g.n; };
  V.setLevel = function (key, k) { const g = S.byKey[key]; if (g) g.level = k < 0 ? 0 : k > 1 ? 1 : k; };
  V.setSpot = function (key, o) {
    const g = group(key); g.kind = 'spot'; const s = g.spot || (g.spot = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, r: 1, g: 1, b: 1, range: 60, cosOuter: 0.9, cosInner: 0.95 }); g.n = 1;
    const on = o.on !== false; g.level = on ? 1 : 0; if (o.gain != null) g.gain = o.gain; g.off = false;
    s.x = o.x; s.y = o.y; s.z = o.z; s.dx = o.dx; s.dy = o.dy; s.dz = o.dz; s.r = o.r; s.g = o.g; s.b = o.b; s.range = Math.min(o.range || 60, 80);
    const a = o.angle != null ? o.angle : 0.5, p = o.penumbra != null ? o.penumbra : 0.5; s.cosOuter = Math.cos(a); s.cosInner = Math.cos(a * (1 - p));
  };
  V.clear = function (key) { const g = S.byKey[key]; if (g) { g.n = 0; g.level = 0; g.data = null; g.off = true; } };
  V.setMedium = function (o) { Object.assign(S.medium, o || {}); };

  // the flashlight when nobody set it explicitly: DMFlash's SpotLight (in the scene root: its position / target are world coordinates)
  const _tmp = { x: 0, y: 0, z: 0 };
  function autoFlash(scene) {
    const g = S.byKey.flash; if (g && !g.off && g.kind === 'spot' && g !== S.flashAuto) return;   // explicit wins
    const F = root.DMFlash, L = F && F.S && F.S.light, T = F && F.S && F.S.target;
    if (!L || !T || !L.parent || L.parent !== scene || !(L.intensity > 0)) { if (S.flashAuto) S.flashAuto.level = 0; return; }
    const a = S.flashAuto || (S.flashAuto = group('flash')); if (a.kind !== 'spot') a.kind = 'spot';
    const c = L.color, I = L.intensity;
    V.setSpot('flash', { x: L.position.x, y: L.position.y, z: L.position.z, dx: T.position.x - L.position.x, dy: T.position.y - L.position.y, dz: T.position.z - L.position.z,
      angle: L.angle, penumbra: Math.max(L.penumbra, 0.6), r: c.r * I, g: c.g * I, b: c.b * I, range: Math.min(L.distance || 60, 70), gain: 1 });
  }

  // ── shader
  function build(T, cfg, U) {
    const { Fn, float, vec3, vec4, Loop, If, select, positionView, positionWorld, cameraPosition, normalize, length, dot, max, min, clamp: clampN, exp, atan, tan, sqrt, sin, pow, mix, smoothstep, fog, rangeFogFactor, interleavedGradientNoise, screenCoordinate } = T;
    const K = cfg.k, G = 0.45, G2 = G * G, HG = (c, g2, g) => float(1 - g2).div(float(4 * PI).mul(pow(max(float(1 + g2).sub(c.mul(2 * g)), 1e-4), 1.5)));
    const sigmaAt = (dW, Leff) => {   // local fog / mist density at the ray midpoint
      const mid = cameraPosition.add(dW.mul(Leff.mul(0.5))), hgt = max(mid.y.sub(U.groundY), 0.0);
      const patch = float(1).add(U.patchy.mul(sin(mid.x.mul(0.11).add(U.time.mul(0.17))).mul(sin(mid.z.mul(0.087).sub(U.time.mul(0.11))))));
      return U.sigma.mul(U.haze.add(U.mist.mul(exp(hgt.negate().div(U.mistH))))).mul(patch);
    };
    const scatter = (d, Lraw, dW) => {
      const Leff = min(Lraw, U.maxD), sigma = sigmaAt(dW, Leff), acc = vec3(0).toVar(), jit0 = interleavedGradientNoise(screenCoordinate.xy);
      Loop(cfg.n, ({ i }) => {
        const A = U.A.element(i), B = U.B.element(i), C = U.C.element(i), wv = A.xyz, range = A.w, ax = C.xyz;
        const tc = dot(wv, d), h2 = max(dot(wv, wv).sub(tc.mul(tc)), 0.0), R2 = range.mul(range).sub(h2);
        If(R2.greaterThan(0.0).and(B.x.add(B.y).add(B.z).greaterThan(1e-4)), () => {
          const R = sqrt(max(R2, 0.0)), s0 = max(tc.sub(R), 0.0), s1 = min(tc.add(R), Leff);
          If(s1.greaterThan(s0), () => {
            const H = sqrt(h2.add(EPS * EPS)), a0 = atan(s0.sub(tc).div(H)), a1 = atan(s1.sub(tc).div(H)), da = a1.sub(a0), spot = dot(ax, ax).greaterThan(0.25), ls = float(0).toVar();
            for (let k = 0; k < K; k++) {
              const jt = jit0.add(k * 0.618034).fract(), u = float((k + 0.5) / K).add(jt.sub(0.5).mul(0.6 / K)), s = tc.add(H.mul(tan(a0.add(da.mul(u))))), lv = d.mul(s).sub(wv);
              const r2 = dot(lv, lv), r = sqrt(max(r2, 1e-8)), q1 = clampN(float(1).sub(r2.div(range.mul(range))), 0.0, 1.0), wnd = q1.mul(q1);
              const t = clampN(dot(lv, ax).div(r).sub(B.w).mul(C.w), 0.0, 1.0), cone = select(spot, t.mul(t).mul(float(3).sub(t.mul(2))), float(1));
              const ph = HG(dot(lv, d).div(r).negate(), G2, G), tr = exp(sigma.mul(s.add(r)).negate());
              ls.addAssign(wnd.mul(cone).mul(ph).mul(tr));
            }
            acc.addAssign(B.xyz.mul(ls.mul(da).div(H.mul(K))));
          });
        });
      });
      return acc.mul(sigma);
    };
    const sunTerm = (d, dW, Lraw) => {   // low sun only: forward-scattered sun, modulated by the sun visibility along the ray (DMLight height-cache march)
      const out = vec3(0).toVar();
      If(U.sunOn.greaterThan(0.002), () => {
        const Ls = min(Lraw, U.sunMaxD), sigma = sigmaAt(dW, Ls), ph = HG(dot(U.sunV, d), 0.49, 0.7);
        let vis = float(1);
        try {
          const L = root.DMLight, p1 = cameraPosition.add(dW.mul(Ls.mul(0.4))), v1 = L && L.sunVisNode ? L.sunVisNode(p1) : null;
          if (v1) { vis = v1; if (cfg.sun > 1) { const v2 = L.sunVisNode(cameraPosition.add(dW.mul(Ls.mul(0.8)))); if (v2) vis = v1.add(v2).mul(0.5); } }
        } catch (e) { }
        // (follower fix) the forward-scattered sun is a sky-sized glow round the sun's direction: on the ground a few metres from the camera it shows up as a pale, hard-edged disc (the HG lobe's edge,
        // cut by the occluders' straight edges through `vis`) that follows the view - "a lamp following me" on the balcony at dusk.  It belongs to DISTANT air (aerial perspective), so it is
        // faded in between SUN_NEAR0 and SUN_NEAR1 metres of view distance: nothing within ~SUN_NEAR0 m of the player, full strength only on far terrain.
        const nearK = smoothstep(SUN_NEAR0, SUN_NEAR1, Lraw);
        out.assign(U.sunCol.mul(ph.mul(float(1).sub(exp(sigma.mul(Ls).negate()))).mul(vis).mul(U.sunOn).mul(nearK.mul(nearK))));
      });
      return out;
    };
    const color = Fn(() => {
      const base = fog(U.fogCol, rangeFogFactor(U.near, U.far)), Lraw = length(positionView), d = positionView.div(max(Lraw, 1e-4)), dW = normalize(positionWorld.sub(cameraPosition));
      const add = vec3(0).toVar();
      If(U.k.greaterThan(0.002), () => {
        const s = scatter(d, Lraw, dW).add(sunTerm(d, dW, Lraw)).mul(U.gain).mul(U.k);
        add.assign(s.div(float(1).add(s.mul(0.35))));   // soft knee: a beam never blows out to white
      });
      return vec4(base.rgb.add(add), base.a);
    });
    return color();
  }

  V.install = function (scene, o) {
    try {
      if (!V.on || !scene) return false; const THREE = (o && o.THREE) || root.THREE, T = THREE && THREE.TSL;
      if (!T || !T.fog || !T.rangeFogFactor || !T.uniformArray || !T.interleavedGradientNoise || !T.screenCoordinate) { S.failed = 'tsl'; return false; }
      if (!scene.fog) return false;
      if (!S.installed) {
        const tier = (o && o.tier) || pickTier(), cfg = Object.assign({ name: tier }, TIERS[tier] || TIERS.med); S.tier = tier; S.cfg = cfg;
        const u = T.uniform, V4 = () => { const a = []; for (let i = 0; i < cfg.n; i++) a.push(new THREE.Vector4()); return a; };
        const U = S.U = { A: T.uniformArray(V4(), 'vec4'), B: T.uniformArray(V4(), 'vec4'), C: T.uniformArray(V4(), 'vec4'),
          fogCol: u(new THREE.Color(0x334455)), near: u(40), far: u(900), k: u(0), gain: u(0.5), sigma: u(0.02), mist: u(1), mistH: u(7), haze: u(0.18), patchy: u(0.3), groundY: u(0), time: u(0), maxD: u(120),
          sunOn: u(0), sunV: u(new THREE.Vector3(0, 1, 0)), sunCol: u(new THREE.Color(1.0, 0.82, 0.55)), sunMaxD: u(260) };
        S.vec = { A: U.A.array || U.A.value, B: U.B.array || U.B.value, C: U.C.array || U.C.value };
        S.node = build(T, cfg, U);
        S.buf = new Float32Array(cfg.n * STRIDE); S.pick = createPicker(cfg.n); S.slots = createSlots(cfg.n); S.tgt = new Int32Array(cfg.n);
        S.installed = true;
      }
      const fg = scene.fog, U = S.U; U.fogCol.value.copy(fg.color); U.near.value = fg.near; U.far.value = fg.far;
      scene.fogNode = S.node; return true;   // (no scene reference kept: a closed world must stay garbage-collectable)
    } catch (e) { S.failed = String(e && e.message || e); try { console.warn('[vlight] install', e); } catch (x) { } return false; }
  };

  // world teardown: drop our fog node from the scene and fade out; no scene is retained either way
  V.release = function (scene) { try { if (scene && scene.fogNode === S.node) scene.fogNode = null; } catch (e) { } S.k = 0; S.nLive = 0; if (S.U) S.U.k.value = 0; if (S.slots) { S.slots.id.fill(-1); S.slots.w.fill(0); } V.clear('flash'); S.flashAuto = null; };

  // ── per frame
  const _col = [0, 0, 0];
  V.tick = function (dt, o) {
    if (!S.installed || !o || !o.camera || !o.scene) return;
    dt = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt || 0.016; const U = S.U, cfg = S.cfg, scene = o.scene;
    if (scene.fog) { if (scene.fogNode !== S.node && !scene.fogNode) scene.fogNode = S.node; } else if (scene.fogNode === S.node) { scene.fogNode = null; return; }
    if (scene.fogNode !== S.node) return;
    // budget
    let lvl = 0, ema = 0; try { const B = root.DMBudget; if (B && B.on) { lvl = B.lvl('light') | 0; const st = B.stats && B.stats(); ema = st && st.emaMs || 0; } } catch (e) { }
    const plan = S.plan = budgetPlan(cfg.n, lvl, ema), want = V.on && o.walk !== false && plan.n > 0 && S.medium.gain > 0 ? 1 : 0;
    S.k += clamp(want - S.k, -dt * 1.5, dt * 1.5); U.k.value = S.k < 0.002 ? 0 : S.k * S.k * (3 - 2 * S.k);
    const fg = scene.fog; U.fogCol.value.copy(fg.color); U.near.value = fg.near; U.far.value = fg.far;   // the stock fog is ours now: always follow scene.fog
    if (U.k.value === 0 && !want) { S.nLive = 0; return; }
    // medium
    const m = S.medium, day = o.day == null ? 0 : o.day;
    S.time += dt; U.time.value = S.time; U.gain.value = m.gain * (1 - 0.55 * clamp(day, 0, 1)); U.sigma.value = m.density; U.mist.value = m.mist; U.mistH.value = m.mistH; U.haze.value = m.haze; U.patchy.value = m.patchy; U.groundY.value = o.groundY || 0;
    // view matrix from the live camera (not last frame's matrixWorldInverse)
    const cam = o.camera; cam.updateMatrixWorld(); const mw = cam.matrixWorld.elements, M = S.m;   // invert a rigid transform: R^T, -R^T t
    M[0] = mw[0]; M[1] = mw[4]; M[2] = mw[8]; M[3] = 0; M[4] = mw[1]; M[5] = mw[5]; M[6] = mw[9]; M[7] = 0; M[8] = mw[2]; M[9] = mw[6]; M[10] = mw[10]; M[11] = 0;
    M[12] = -(mw[0] * mw[12] + mw[1] * mw[13] + mw[2] * mw[14]); M[13] = -(mw[4] * mw[12] + mw[5] * mw[13] + mw[6] * mw[14]); M[14] = -(mw[8] * mw[12] + mw[9] * mw[13] + mw[10] * mw[14]); M[15] = 1;
    const cx = mw[12], cy = mw[13], cz = mw[14];
    // sun: low only
    const sd = o.sunDir; let sunOn = 0;
    if (sd && plan.sun && day > 0.02) { const il = 1 / (Math.hypot(sd.x, sd.y, sd.z) || 1), sx = sd.x * il, sy = sd.y * il, sz = sd.z * il;
      sunOn = (1 - smooth01((sy - 0.05) / 0.5)) * smooth01((sy + 0.12) / 0.14) * clamp(day * 1.6, 0, 1);
      if (sunOn > 0) { U.sunV.value.set(M[0] * sx + M[4] * sy + M[8] * sz, M[1] * sx + M[5] * sy + M[9] * sz, M[2] * sx + M[6] * sy + M[10] * sz); } }
    U.sunOn.value = sunOn * 0.6;
    // gather the lights
    autoFlash(scene);
    const P = S.pick; pickReset(P);
    for (let gi = 0; gi < S.groups.length; gi++) {
      const g = S.groups[gi]; if (g.off || !(g.level > 0) || !g.n) continue;
      if (g.kind === 'spot') { pickPush(P, (gi << 16) | 0, 1e9); continue; }   // the flashlight / explicit spots always rank first
      const d = g.data;
      for (let i = 0; i < g.n; i++) { const o7 = i * 7, dx = d[o7] - cx, dy = d[o7 + 1] - cy, dz = d[o7 + 2] - cz, dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const sc = lightScore(d[o7 + 3] + d[o7 + 4] + d[o7 + 5], g.level * g.gain, dist, d[o7 + 6], 60); if (sc > 0) pickPush(P, (gi << 16) | i, sc); }
    }
    const nT = Math.min(P.size, plan.n); for (let j = 0; j < nT; j++) S.tgt[j] = P.id[j];
    stepSlots(S.slots, S.tgt, nT, dt, 4);
    const buf = S.buf; let live = 0;
    for (let sI = 0; sI < cfg.n; sI++) {
      const id = S.slots.id[sI], w = S.slots.w[sI]; if (id < 0 || w <= 0) { clearSlot(buf, sI); continue; }
      const g = S.groups[id >> 16]; if (!g || g.off || !g.n) { clearSlot(buf, sI); continue; } const i = id & 0xffff, kk = g.level * g.gain * w;
      if (g.kind === 'spot') { const s = g.spot; packLight(buf, sI, M, s.x, s.y, s.z, s.dx, s.dy, s.dz, s.r, s.g, s.b, kk, s.range, s.cosOuter, s.cosInner); }
      else { const d = g.data, o7 = i * 7; if (o7 + 6 >= d.length) { clearSlot(buf, sI); continue; } packLight(buf, sI, M, d[o7], d[o7 + 1], d[o7 + 2], 0, 0, 0, d[o7 + 3], d[o7 + 4], d[o7 + 5], kk, d[o7 + 6], 0, 0); }
      live++;
    }
    S.nLive = live; const vA = S.vec.A, vB = S.vec.B, vC = S.vec.C;
    for (let i = 0; i < cfg.n; i++) { const o12 = i * STRIDE; vA[i].set(buf[o12], buf[o12 + 1], buf[o12 + 2], buf[o12 + 3]); vB[i].set(buf[o12 + 4], buf[o12 + 5], buf[o12 + 6], buf[o12 + 7]); vC[i].set(buf[o12 + 8], buf[o12 + 9], buf[o12 + 10], buf[o12 + 11]); }
  };

  V.status = function () { return { on: V.on, installed: S.installed, tier: S.tier, lights: S.nLive, k: +S.k.toFixed(3), plan: S.plan, groups: S.groups.map(g => ({ key: g.key, kind: g.kind, n: g.n, level: g.level })), medium: S.medium, failed: S.failed }; };
})(typeof window !== 'undefined' ? window : globalThis);
