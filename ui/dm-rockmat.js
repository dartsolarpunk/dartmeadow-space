/* DART Meadow — layered rock for every rocky world (planets, moons, asteroids). (v140 terrain-materials)
 *
 * The procedural rock-spire method ported to TSL (WGSL on WebGPU), as surface language, not towers:
 *   density (sparse MC compute) — four layers along the radial direction, added to the field so caves/overhangs survive:
 *     fBm broad shape · turbulence stretched radially (vertical joints) · inverted ridges (notches) · (h mod k)^6 ledges
 *   colour (fragment) — warm/cool zones from anisotropic noise, vertical desert-varnish streaks, iron-oxide stains,
 *     cold slate bands, fine grain; snow/ice on up-facing ground: smoothstep(0.42,0.82,n·up) × low-freq patches ×
 *     shelter mask × fine-noise edge breakup
 *   normal (fragment) — two chained bumps: triplanar Voronoi distance-to-edge fractures, then fine grain. No geometry.
 * Per-body presets. Earth: rock/cliff/slope only, no snow (Earth paint, MODIS cover and the glacier map stay authoritative).
 * Octaves scale with the graphics preset (fixed per preset; nothing changes at runtime). ?mat=0 = the old look.
 * Deterministic: seeds come from the body's existing seed value; no random stream is consumed.
 */
(function () {
  const W = window;
  const on = !/[?&]mat=0\b/.test(location.search);
  const T = (n) => W[n];
  const C = (a) => ({ r: a[0], g: a[1], b: a[2] });
  const BASE = {
    warm: [0.56, 0.46, 0.36], cool: [0.40, 0.42, 0.45], varn: [0.15, 0.10, 0.07], varnAmt: 0.45,
    oxide: [0.58, 0.27, 0.12], oxAmt: 0.25, slate: [0.30, 0.33, 0.37], slateAmt: 0.3, grain: 0.12,
    snow: 0.35, ice: false, snowC: [0.93, 0.95, 0.97], disp: 0.35, strata: 6, rough: 0.9, tint: 0.45, bump: 1.0, earth: false,
  };
  const P = {
    rocky: {},
    earth: { earth: true, snow: 0, disp: 0, tint: 0, varnAmt: 0.35, oxAmt: 0.15 },
    mars: { warm: [0.64, 0.34, 0.18], cool: [0.46, 0.31, 0.23], varn: [0.22, 0.10, 0.05], varnAmt: 0.3, oxide: [0.72, 0.28, 0.10], oxAmt: 0.6,
      slate: [0.40, 0.31, 0.27], slateAmt: 0.18, snow: 0.07, snowC: [0.92, 0.90, 0.88], tint: 0.35 },
    moon: { warm: [0.53, 0.52, 0.51], cool: [0.40, 0.40, 0.41], varnAmt: 0, oxAmt: 0, slate: [0.31, 0.31, 0.33], slateAmt: 0.22, grain: 0.18,
      snow: 0, disp: 0.3, strata: 4, rough: 0.96, tint: 0.3 },
    ice: { warm: [0.82, 0.80, 0.77], cool: [0.62, 0.69, 0.76], varn: [0.42, 0.30, 0.20], varnAmt: 0.2, oxide: [0.55, 0.38, 0.25], oxAmt: 0.25,
      slate: [0.55, 0.62, 0.70], slateAmt: 0.2, snow: 0.75, ice: true, snowC: [0.78, 0.88, 0.97], disp: 0.25, rough: 0.55, tint: 0.4 },
    volcanic: { warm: [0.80, 0.70, 0.30], cool: [0.45, 0.40, 0.22], varn: [0.12, 0.09, 0.05], varnAmt: 0.35, oxide: [0.70, 0.35, 0.08], oxAmt: 0.5,
      slate: [0.22, 0.20, 0.17], slateAmt: 0.3, snow: 0.15, snowC: [0.92, 0.90, 0.70], tint: 0.5 },
    asteroid: { warm: [0.42, 0.39, 0.35], cool: [0.33, 0.33, 0.34], varnAmt: 0, oxAmt: 0.1, slateAmt: 0.25, grain: 0.2, snow: 0,
      disp: 0.5, strata: 3, rough: 0.97, tint: 0.4, bump: 1.3 },
  };
  function catalogType(name) {
    try { const c = (typeof SOL_CATALOG !== 'undefined') ? SOL_CATALOG : null; const e = c && c.find((x) => x.name === name); return e ? e.type : null; } catch (e) { return null; }
  }
  function presetFor(kind) {
    const k = String(kind || '').toLowerCase(), t = String(catalogType(kind) || kind || '').toLowerCase();
    let key = 'rocky';
    if (k === 'earth' || t === 'habitable') key = 'earth';
    else if (k === 'mars') key = 'mars';
    else if (k === 'moon' || k === 'mercury' || t === 'barren moon') key = 'moon';
    else if (t === 'ice' || t === 'methane') key = 'ice';
    else if (t === 'volcanic' || k === 'io' || k === 'venus') key = 'volcanic';
    else if (t === 'asteroid' || t === 'comet') key = 'asteroid';
    return Object.assign({ key }, BASE, P[key]);
  }
  function tier() { try { return (typeof resolvePreset === 'function') ? resolvePreset() : 'medium'; } catch (e) { return 'medium'; } }
  // detail octaves per preset — fixed, never reduced at runtime
  function oct() { return ({ low: 2, medium: 3, high: 4, ultra: 5, custom: 3 })[tier()] || 3; }
  const v3 = (a) => T('vec3')(a[0], a[1], a[2]);

  // ── density: rock displacement in units of the world's relief scale (≈ -1..1 × pr.disp). p = local position. ──
  function displaceTSL(p, radius, reliefScale, pr, seedU) {
    const { float, vec3, mx_fractal_noise_float: fbm, smoothstep } = W;
    if (!pr.disp) return float(0);
    const o = oct(), q = p.div(radius), up = q.normalize(), rad = q.dot(up), tang = q.sub(up.mul(rad));
    const s = vec3(seedU, seedU.mul(0.37), seedU.mul(1.91));
    const broad = fbm(q.mul(9.0).add(s), o, 2.0, 0.5);
    // turbulence, stretched along the radial direction (low radial frequency) → vertical joints
    const tj = fbm(tang.mul(34.0).add(up.mul(rad.mul(5.0))).add(s).add(vec3(3.1, 7.7, 1.3)), Math.max(1, o - 1), 2.0, 0.5).abs();
    const joints = smoothstep(0.0, 0.18, tj).sub(1.0).mul(0.5);
    const rdg = float(1).sub(fbm(q.mul(17.0).add(s).add(vec3(11.0, 2.0, 5.0)), Math.max(1, o - 1), 2.0, 0.5).abs());
    const inv = rdg.pow(4.0).mul(-0.45);
    const h = q.length().sub(1.0).mul(radius / reliefScale);           // height in relief units
    const fr = h.mul(pr.strata).fract();
    const ledge = fr.pow(6.0).mul(0.35);                                // (h mod k)^6
    const mask = smoothstep(-0.25, 0.35, fbm(q.mul(3.0).add(s).add(vec3(5.0, 9.0, 1.0)), 2, 2.0, 0.5));
    return broad.mul(0.5).add(joints).add(inv).add(ledge).mul(mask).mul(pr.disp);
  }
  function displacePad(pr) { return 1.3 * (pr.disp || 0); }   // |displaceTSL| ≤ ~1.3·disp relief units (band padding)

  // patch (metres, y up): cliff-only rock relief, carve ≤ ~6 m, add ≤ ~1.5 m. slope = |∇h|.
  function patchDisplaceTSL(p, slope, pr, seedU) {
    const { float, vec3, mx_fractal_noise_float: fbm, smoothstep } = W;
    const o = Math.min(3, oct()), s = vec3(seedU.mul(0.7), seedU.mul(0.13), seedU);
    const m = smoothstep(0.55, 1.3, slope);
    const tj = fbm(vec3(p.x.mul(0.22), p.y.mul(0.03), p.z.mul(0.22)).add(s), o, 2.0, 0.5).abs();
    const joints = smoothstep(0.0, 0.16, tj).sub(1.0).mul(3.5);
    const rdg = float(1).sub(fbm(p.mul(0.08).add(s).add(vec3(4.0, 1.0, 7.0)), 2, 2.0, 0.5).abs());
    const ledge = p.y.div(3.2 + pr.strata * 0.3).fract().pow(6.0).mul(1.5);
    const broad = fbm(p.mul(0.035).add(s), 2, 2.0, 0.5).mul(2.0);
    return broad.add(joints).add(rdg.pow(4.0).mul(-2.5)).add(ledge).mul(m).clamp(-6.0, 1.5);
  }

  // ── colour layers (fragment). q = position scaled to the detail frequency, up = radial unit, ndu = n·up ──
  function layersTSL(q, up, ndu, base, pr, seedU, F) {
    const { float, vec3, mix, mx_fractal_noise_float: fbm, smoothstep, sin } = W;
    const o = oct(), s = vec3(seedU.mul(1.3), seedU, seedU.mul(0.71));
    const rad = q.dot(up), tang = q.sub(up.mul(rad));
    // warm/cool zones: stretched along the strata (high radial, low tangential frequency)
    const z = fbm(tang.mul(0.6 * F).add(up.mul(rad.mul(2.2 * F))).add(s), Math.max(2, o - 1), 2.0, 0.5).mul(0.5).add(0.5);
    let warm = v3(pr.warm), cool = v3(pr.cool);
    if (pr.tint > 0) { warm = mix(warm, base, pr.tint); cool = mix(cool, base.mul(0.8), pr.tint); }
    let c = mix(cool, warm, smoothstep(0.3, 0.7, z));
    // vertical desert-varnish streaks: high tangential, low radial frequency, darker on steep faces
    if (pr.varnAmt > 0) {
      const st = fbm(tang.mul(9.0 * F).add(up.mul(rad.mul(0.8 * F))).add(s).add(vec3(7, 1, 3)), Math.max(1, o - 1), 2.0, 0.5).mul(0.5).add(0.5);
      const steep = float(1).sub(ndu).clamp(0, 1);
      c = mix(c, v3(pr.varn), smoothstep(0.55, 0.8, st).mul(steep.mul(1.4).min(1)).mul(pr.varnAmt));
    }
    if (pr.oxAmt > 0) {
      const ox = fbm(q.mul(3.1 * F).add(s).add(vec3(2, 9, 4)), Math.max(1, o - 1), 2.0, 0.5).mul(0.5).add(0.5);
      c = mix(c, v3(pr.oxide), smoothstep(0.55, 0.85, ox).mul(pr.oxAmt));
    }
    if (pr.slateAmt > 0) {
      const b = sin(rad.mul(7.0 * F).add(fbm(q.mul(1.3 * F).add(s), 2, 2.0, 0.5).mul(3.0))).mul(0.5).add(0.5);
      c = mix(c, v3(pr.slate), smoothstep(0.82, 0.96, b).mul(pr.slateAmt));
    }
    const g = fbm(q.mul(40.0 * F).add(s), Math.min(2, o), 2.0, 0.5);
    return c.mul(float(1).add(g.mul(pr.grain)));
  }
  function snowTSL(q, ndu, shelter, pr, seedU, F) {
    const { float, vec3, mx_fractal_noise_float: fbm, smoothstep } = W;
    if (!pr.snow) return float(0);
    const s = vec3(seedU, seedU.mul(2.1), seedU.mul(0.4));
    const patches = smoothstep(0.35, 0.65, fbm(q.mul(0.7 * F).add(s), 2, 2.0, 0.5).mul(0.5).add(0.5).add(pr.snow - 0.5));
    const edge = fbm(q.mul(60.0 * F).add(s), 2, 2.0, 0.5).mul(0.08);
    return smoothstep(0.42, 0.82, ndu.add(edge)).mul(patches).mul(shelter);
  }
  // two chained bumps: triplanar Voronoi distance-to-edge fractures, then fine grain
  function bumpHeightTSL(q, nrm, pr, seedU, F) {
    const { float, abs, mx_worley_noise_vec2: wv, mx_fractal_noise_float: fbm, smoothstep, vec3 } = W;
    let w = abs(nrm).pow(4.0); w = w.div(w.x.add(w.y).add(w.z).add(1e-5));
    const fr = (uv) => { const f = wv(uv, 1.0, 0); return smoothstep(0.0, 0.07, f.y.sub(f.x)); };
    const qs = q.mul(6.0 * F).add(vec3(seedU, seedU, seedU).mul(0.1));
    const frac = fr(qs.yz).mul(w.x).add(fr(qs.xz).mul(w.y)).add(fr(qs.xy).mul(w.z));
    const grain = fbm(q.mul(55.0 * F), Math.min(2, oct()), 2.0, 0.5);
    return frac.mul(0.7).add(grain.mul(0.18)).mul(pr.bump);
  }

  // planet / moon / asteroid MC mesh material (local space = body centre)
  function applyPlanet(mat, kind, radius, seedVal) {
    if (!on || !mat || !W.Fn || !W.positionLocal) return false;
    try {
      const { float, vec3, mix, smoothstep, positionLocal, normalLocal, vertexColor, uniform } = W;
      const pr = presetFor(kind), seedU = uniform(+seedVal || 0), F = 1.0;
      const q = positionLocal.div(radius).mul(90.0);             // detail frequency: ~90 cycles per radius × layer freq
      const up = positionLocal.normalize(), n = normalLocal.normalize(), ndu = n.dot(up);
      const base = vertexColor();
      const slope = float(1).sub(ndu).clamp(0, 1);
      const rockMask = pr.earth ? smoothstep(0.12, 0.3, slope) : smoothstep(0.0, 0.18, slope).mul(0.55).add(0.45);
      const rock = layersTSL(q, up, ndu, base, pr, seedU, F);
      // Earth: the paint stays authoritative — rock only modulates it on cliffs/slopes
      let c = pr.earth ? mix(base, base.mul(rock.div(vec3(0.5, 0.45, 0.4)).clamp(0.6, 1.4)), rockMask) : mix(base, rock, rockMask);
      if (!pr.earth && pr.snow) {
        const shelter = smoothstep(-0.2, 0.5, W.mx_fractal_noise_float(q.mul(0.25), 2, 2.0, 0.5));
        c = mix(c, v3(pr.snowC), snowTSL(q, ndu, shelter, pr, seedU, F));
      }
      mat.colorNode = c;
      mat.roughnessNode = float(pr.rough);
      if (typeof W.bumpMap === 'function') mat.normalNode = W.bumpMap(bumpHeightTSL(q, n, pr, seedU, F).mul(rockMask), float(0.6));
      mat.userData.dmRock = pr.key;
      mat.needsUpdate = true;
      return true;
    } catch (e) { console.warn('[rockmat] planet material:', e); return false; }
  }
  // ground patch (metres, y up): rock layers on cliffs over the patch's own colour
  function patchColor(col, p, nW, kind, seedVal) {
    if (!on) return col;
    try {
      const { float, vec3, mix, smoothstep, uniform } = W;
      const pr = presetFor(kind), seedU = uniform(+seedVal || 0);
      const up = vec3(0, 1, 0), ndu = nW.y, q = p.mul(0.06);
      const cliff = smoothstep(0.82, 0.55, ndu);
      const rock = layersTSL(q, up, ndu, col, pr, seedU, 1.0);
      return pr.earth ? mix(col, col.mul(rock.div(vec3(0.5, 0.45, 0.4)).clamp(0.6, 1.4)), cliff) : mix(col, rock, cliff.mul(0.85));
    } catch (e) { return col; }
  }
  W.DMRock = { on, presetFor, oct, displaceTSL, displacePad, patchDisplaceTSL, applyPlanet, patchColor, layersTSL, snowTSL, bumpHeightTSL };
})();
