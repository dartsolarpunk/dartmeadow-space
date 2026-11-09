/* DART Meadow — water shaders (TSL): the sea material and the ground's shore hook. See ui/dm-water.js for the cost model and flags.
 *
 *   DMWater.material(o)       the sea: baked band tiles (2 scrolled layers each) -> normal + vertex displacement, whitecaps from the baked Jacobian
 *                             potential + a steepness term + the lace tile, shoaling / shore waves / bore foam from the shore field, subsurface crest tint,
 *                             Fresnel sky + sun glint, Beer-Lambert depth colour from the scene depth, contact foam, caustics on the shallow bed, ripples
 *   DMWater.receiveShore(m,c) wet-sand darkening that outlives the wave, the swash film and its foam front (ground materials, only below the run-up height)
 *   DMWater.rippleGrad(xz)    the ripple ring's surface gradient as a TSL node (puddles in ui/dm-groundlib.js use it)
 */
(function (root) {
  'use strict';
  const W = root, D = () => W.DMWater;
  const PI2 = Math.PI * 2;

  function T3() { const T = W.THREE.TSL; return T; }

  // ripple ring gradient (mirror of DMWaterCore.Ripples.profile). xz: vec2 node. Returns vec2 node.
  function rippleGrad(xz) {
    const S = D().S, T = T3(), { Fn, If, Loop, float, vec2, length, exp, sqrt, cos, sin, abs, smoothstep } = T, U = S.U;
    if (!U || !U.rip) return null;
    return Fn(() => {
      const g = vec2(0.0, 0.0).toVar();
      If(U.nRip.greaterThan(0), () => {
        Loop(U.nRip, ({ i }) => {
          const r = U.rip.element(i), dv = xz.sub(r.xy), d = length(dv).add(1e-4), age = r.z, amp = r.w, c = float(1.1).add(amp.mul(0.9));
          const u = d.sub(c.mul(age)), w = float(0.32).add(sqrt(age.max(0.0)).mul(0.55));
          If(amp.greaterThan(0.0).and(abs(u).lessThan(w.mul(3.2))), () => {
            const kw = PI2 / 0.62, e0 = amp.mul(exp(age.mul(-1.15))).mul(float(1.0).sub(smoothstep(2.6, 3.4, age))), q = float(1.0).add(d.mul(2.2)), E = e0.div(sqrt(q)), dE = e0.mul(-1.1).div(q.mul(sqrt(q)));
            const ga = exp(u.mul(u).div(w.mul(w)).negate()), cs = cos(u.mul(kw)), sn = sin(u.mul(kw));
            const dh = dE.mul(ga).mul(cs).add(E.mul(ga).mul(u.mul(-2.0).div(w.mul(w)).mul(cs).sub(sn.mul(kw))));
            g.addAssign(dv.div(d).mul(dh));
          });
        });
      });
      return g;
    })();
  }

  function material(o) {
    const DW = D(), S = DW.S; if (!S.active || !S.U || !W.THREE || !W.THREE.TSL) return null;
    o = o || {};
    const THREE = W.THREE, T = THREE.TSL, P = S.P, U = S.U, tier = S.tier, spec = S.spec, tex = S.tex, pwf = o.pwf || null; S.pwf = pwf;
    const { Fn, If, Loop, float, vec2, vec3, vec4, mix, smoothstep, clamp, max, min, pow, exp, abs, dot, normalize, length, sin, cos, sqrt, floor, fract, texture, select,
      attribute, varying, step, positionView, cameraNear, cameraFar, viewportDepthTexture, dFdx, dFdy, reflect, cameraPosition, cameraViewMatrix, cameraWorldMatrix, faceDirection } = T;
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const nb = spec.bands.length, nl = tier.layers, F = (v) => float(v);

    /* ---------- vertex: clip-map position (per-level snap), displacement from the swell + mid tiles ---------- */
    const aPos = attribute('wpos', 'vec2'), aLvl = attribute('wlvl', 'float'), aMor = attribute('wmorph', 'vec2');
    const snap = floor(U.focus.div(aLvl)).mul(aLvl), xzV = aPos.add(snap);
    // shore field fetch (vertex: level 0)
    const shoreUV = (xz) => xz.sub(vec2(U.shoreC.x, U.shoreC.y)).div(U.shoreC.z).add(0.5);
    const shoreInside = (uv) => smoothstep(0.0, 0.16, uv.x).mul(smoothstep(0.0, 0.16, uv.y)).mul(float(1.0).sub(smoothstep(0.84, 1.0, uv.x))).mul(float(1.0).sub(smoothstep(0.84, 1.0, uv.y))).mul(U.shoreOn);
    const dDeep = Math.min(30, Math.max(6, 0.2 * P.lamS)), H0 = Math.max(0.3, P.HsS * 0.9), Ps = Math.sqrt(PI2 * P.lamS / P.g);
    const hasShore = tier.shore > 0;
    const shore = (xz, vtx) => {
      if (!hasShore) return { raw: F(0), win: F(0), d: F(80), T: F(0), g: vec2(0.0, 0.0), inside: F(0), amp: F(1), blend: F(0), ratio: F(0) };
      const uv = shoreUV(xz), tx = vtx ? texture(tex.shore, uv).level(F(0)) : texture(tex.shore, uv), inside = shoreInside(uv).mul(smoothstep(-2.5, -0.6, tx.x)), d = max(mix(F(80), tx.x, inside), 0.05);
      const gain = clamp(pow(F(0.5 * P.lamS).div(d), 0.25), 1.0, 2.0), waveH = min(gain.mul(H0), d.mul(0.78)), amp = clamp(waveH.div(H0), 0.0, 1.0), ratio = gain.mul(H0).div(d.mul(0.78));
      const blend = float(1.0).sub(smoothstep(U.shoreP.x.mul(0.5), U.shoreP.x.mul(1.0), d)).mul(inside);
      return { d, T: tx.y, g: vec2(tx.z, tx.w), inside, amp: mix(F(1), amp, inside), blend, ratio, waveH, raw: tx.x, win: shoreInside(uv) };
    };
    // one sea evaluation: slope (vec2), height, whitecap potential. vtx = vertex stage (level-0 fetch, swell + mid only, no footprint fade)
    let regMod = null;      // world-space gust-patch modulation of the shorter bands (set in the fragment stage before the sea is evaluated)
    const layerBoost = Math.hypot(0.78, 0.62) / 0.78;   // energy of the two incoherent layers over layer 0 alone (LAYERS weights in dm-water-core.js)
    const sea = (xz, vtx, fp, sh) => {
      let unres = F(0);
      const bandW = (bi, fade) => fade.mul(U.bandAmt[bi]).mul(bi === 0 ? U.swellAmp.mul(sh.amp).mul(float(1.0).sub(sh.blend.mul(0.88))) : (!vtx && regMod ? regMod : F(1)));
      const tap = (bi, L, xz2, lvl0) => {
        const k = bi * nl + L, mm = U.bm[k], uv = vec2(mm.x.mul(xz2.x).add(mm.y.mul(xz2.y)), mm.z.mul(xz2.x).add(mm.w.mul(xz2.y))).sub(U.boff[k]), tx = lvl0 ? texture(tex.bands[bi], uv).level(F(0)) : texture(tex.bands[bi], uv), gg = U.bg[k];
        const g2 = tx.xy.mul(2.0).sub(1.0);
        return { sl: vec2(gg.x.mul(g2.x).add(gg.y.mul(g2.y)), gg.z.mul(g2.x).add(gg.w.mul(g2.y))), h: tx.z.mul(2.0).sub(1.0).mul(U.bhw[k]), pot: tx.w, k };
      };
      if (vtx) {      // vertex stage: level-0 fetches, swell + mid only, every layer (cheap: few vertices)
        let sl = vec2(0.0, 0.0), h = F(0);
        for (let bi = 0; bi < Math.min(nb, 2); bi++) { const wt = bandW(bi, F(1)); for (let L = 0; L < nl; L++) { const r = tap(bi, L, xz, true); sl = sl.add(r.sl.mul(wt)); h = h.add(r.h.mul(wt)); } }
        return { sl: sl.mul(U.amp), h: h.mul(U.amp), pot: F(0), unres };
      }
      // fragment stage: a band whose weight has faded out (finer than a pixel, or the governor switched it off) costs NOTHING (a real branch on a coherent value), and the
      // second layer of each band is only fetched near the camera (it exists to break the repeat of the first; beyond ~U.layerFar the footprint averages it out anyway)
      const dcam = length(positionView), lyW = float(1.0).sub(smoothstep(U.layerFar.mul(0.62), U.layerFar, dcam));
      const acc = Fn(() => {
        const a = vec4(0.0, 0.0, 0.0, 0.0).toVar();
        for (let bi = 0; bi < nb; bi++) {
          const b = spec.bands[bi], fade = float(1.0).sub(smoothstep(b.lamMin * 0.14, b.lamMin * 0.5, fp)), wt = bandW(bi, fade);
          If(wt.greaterThan(0.004), () => {
            for (let L = 0; L < nl; L++) {
              // layer 0 always; the others ease out with distance (their weight falls to nothing, layer 0 takes up the energy) so no ring marks where they stop
              const body = (gw) => { const r = tap(bi, L, xz, false), w2 = gw ? wt.mul(gw) : wt; a.x.addAssign(r.sl.x.mul(w2)); a.y.addAssign(r.sl.y.mul(w2)); a.z.addAssign(r.h.mul(w2)); if (L === 0 && (bi > 0 || nb === 1)) a.w.assign(max(a.w, r.pot.mul(wt))); };
              if (L === 0) { if (nl > 1) body(mix(F(layerBoost), F(1.0), lyW)); else body(); } else If(lyW.greaterThan(0.004), () => body(lyW));
            }
          });
          unres = unres.add(float(1.0).sub(fade).mul(b.smax * b.smax * 0.3));
        }
        return a;
      })();
      return { sl: vec2(acc.x, acc.y).mul(U.amp), h: acc.z.mul(U.amp), pot: acc.w, unres };
    };
    // shore waves: the swell turns into a train riding the eikonal travel time T (phase = (t - T) / period), skewed and steepened as it breaks
    const shoreWave = (sh) => {
      if (!hasShore) return { h: F(0), sl: vec2(0.0, 0.0), bore: F(0), phi: F(0), cm: F(0) };
      const phi = U.time.sub(sh.T).div(Ps), ph = phi.mul(PI2), skew = float(0.22).add(clamp(sh.ratio.sub(0.7), 0.0, 1.0).mul(0.6));
      // the breaking-wave curl (ui/dm-water-curl.js) draws the crest of a wave that is about to plunge: flatten the sea's own shore wave right under it
      let cm = F(0);
      if (tier.curl) {
        const cr = smoothstep(0.8, 1.05, sh.ratio).mul(float(1.0).sub(smoothstep(2.2, 3.3, sh.ratio))).mul(sh.inside), pd = abs(fract(phi.add(0.5)).sub(0.5)), cdist = pd.mul(Ps).mul(sqrt(sh.d.mul(P.g))), hw = max(sh.waveH, 0.3);
        cm = cr.mul(float(1.0).sub(smoothstep(0.8, 2.6, cdist.div(hw)))).mul(U.curlOn);
      }
      const A = min(sh.d.mul(0.39), F(0.5 * H0 * 1.4)).mul(0.68).mul(U.amp).mul(U.swellAmp).mul(sh.blend).mul(float(1.0).sub(cm.mul(0.88)));
      const s = cos(ph).add(cos(ph.mul(2.0)).mul(0.35)).add(sin(ph.mul(2.0)).mul(skew)), ds = sin(ph).negate().sub(sin(ph.mul(2.0)).mul(0.7)).add(cos(ph.mul(2.0)).mul(skew.mul(2.0)));
      const h = A.mul(s), sl = sh.g.mul(A.mul(ds).mul(-PI2 / Ps));
      const fr = fract(phi), bore = pow(float(1.0).sub(fr), 2.6).mul(smoothstep(0.0, 0.05, fr));
      return { h, sl, bore, phi, cm };
    };

    // vertex displacement (High / Ultra): the swell + mid trains within `disp` units, faded to nothing past it so the level seams stay flat there
    let posNode;
    if (tier.disp > 0) {
      const R = tier.disp, hz = (xz) => { const sh = shore(xz, true), s = sea(xz, true, F(0), sh), sw = shoreWave(sh); return vec3(s.sl.x.add(sw.sl.x), s.h.add(sw.h), s.sl.y.add(sw.sl.y)); };
      const step = aLvl.mul(0.5), e = vec2(aMor.x.mul(step), aMor.y.mul(step)), isEdge = aMor.x.add(aMor.y), vc = hz(xzV);
      const va = hz(xzV.add(e)), vb = hz(xzV.sub(e)), avg = va.add(vb).mul(0.5), v = mix(vc, avg, isEdge);   // outer-edge odd nodes ride the average of their even neighbours: no cracks
      const dist = length(xzV.sub(U.focus)), wgt = float(1.0).sub(smoothstep(R * 0.55, R, dist)).mul(U.disp), chopQ = P.chop * (1 - 0.8 * P.ice);
      const kb = 1.0 / Math.max(0.02, 2 * Math.PI / spec.bands[0].lamMean);
      const dx = v.x.mul(chopQ * 0.5 * kb), dz = v.z.mul(chopQ * 0.5 * kb);   // Gerstner: horizontal push = (Q/k) * slope (toward the crest)
      posNode = vec3(xzV.x.add(dx.mul(wgt)), v.y.mul(wgt), xzV.y.add(dz.mul(wgt)));
    } else posNode = vec3(xzV.x, F(0), xzV.y);
    const flatP = varying(vec3(xzV.x, F(0), xzV.y));
    const xz = vec2(flatP.x, flatP.z);

    /* ---------- fragment ---------- */
    const depthToViewZ = (d) => (o.logDepth ? W.logarithmicDepthToViewZ(d, cameraNear, cameraFar) : W.perspectiveDepthToViewZ(d, cameraNear, cameraFar));
    const vDepth = o.depthOK ? viewportDepthTexture().r : null, sceneZ = o.depthOK ? depthToViewZ(vDepth) : null;
    // an unwritten texel of the depth copy (resized after a render-scale change, or a region not yet copied) reads 0 = 'surface at the near plane': that made contact foam paint a white rectangle. Treat it as open water.
    const thickRaw = o.depthOK ? select(vDepth.lessThan(0.000001), F(500), clamp(positionView.z.sub(sceneZ), 0.0, 500.0)) : F(40);
    const fp = max(length(dFdx(xz)), length(dFdy(xz)));
    // the scene depth is only trustworthy near the camera (a depth buffer's resolution is metres at a kilometre: blocky false shorelines and a patchwork of opacity), so everything it drives eases out with distance
    const depthTrust = float(1.0).sub(smoothstep(110.0, 420.0, length(positionView)));
    const thick = o.depthOK ? mix(F(40), thickRaw, depthTrust) : thickRaw;
    /* ---------- breaking up the repeats: nothing here is sampled on a single lattice ---------- */
    // every tile is sampled through its own rotation and an incommensurate scale (the band layers 0 / 0.61 rad at 1 / 1.37, the detail layers 0 / 0.64 rad at 0.17 / 0.5413, the
    // caustic copies 0 / 0.9 rad), the foam tile through a stochastic hex blend near the camera, and the foam density, the gust patches and the shorter bands ride world-space noise
    const rot = (v, a) => { const c = Math.cos(a), s2 = Math.sin(a); return vec2(v.x.mul(c).sub(v.y.mul(s2)), v.x.mul(s2).add(v.y.mul(c))); };
    const dcam0 = length(positionView), Vd0 = normalize(cameraPosition.sub(vec3(xz.x, F(0), xz.y)));
    const regA = texture(tex.detail, rot(xz, 0.83).mul(0.0031).add(U.drift.mul(0.12)).add(0.21)).x, regB = texture(tex.detail, rot(xz, -0.47).mul(0.0083).sub(U.drift.mul(0.25)).add(0.55)).x;
    const regD = smoothstep(0.22, 0.78, regA.mul(0.65).add(regB.mul(0.35)));                 // gust-patch density, 0..1 (drifts with the wind, ~100-300 u across)
    regMod = mix(F(0.8), F(1.2), regD);
    const hash2 = (p) => fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))).mul(43758.5453));
    const hexTap = (tx, uv) => {         // stochastic tiling (Mikkelsen): three offset taps blended on a triangle lattice, so no two neighbouring cells show the same patch
      const st = uv.mul(3.4641016), sk = vec2(st.x, st.x.mul(-0.57735027).add(st.y.mul(1.15470054))), base = floor(sk), f = fract(sk), z = float(1.0).sub(f.x).sub(f.y), up = z.greaterThan(0.0);
      const w = select(up, vec3(z, f.y, f.x), vec3(z.negate(), float(1.0).sub(f.y), float(1.0).sub(f.x)));
      const v1 = select(up, base, base.add(vec2(1.0, 1.0))), v2 = select(up, base.add(vec2(0.0, 1.0)), base.add(vec2(1.0, 0.0))), v3 = select(up, base.add(vec2(1.0, 0.0)), base.add(vec2(0.0, 1.0)));
      const wn = w.mul(w), ws = wn.x.add(wn.y).add(wn.z), q = wn.div(ws);
      return texture(tx, uv.add(hash2(v1))).mul(q.x).add(texture(tx, uv.add(hash2(v2))).mul(q.y)).add(texture(tx, uv.add(hash2(v3))).mul(q.z));
    };
    const sh = shore(xz, false), se = sea(xz, false, fp, sh), sw = shoreWave(sh);
    // water coverage: nothing over ground well above the sea. Far field from the coarse coverage mask (lowest natural ground per cell, bilinear), near field from the shore field's exact
    // depth; both fade smoothly. Outside either grid (or before they are built) the water is simply drawn.
    const COVER_LAND = W.DMWaterCore.COVER_LAND, COVER_FADE = W.DMWaterCore.COVER_FADE;
    const cUV = xz.sub(vec2(U.coverC.x, U.coverC.y)).div(U.coverC.z).add(0.5), cIn = step(0.0, cUV.x).mul(step(cUV.x, 1.0)).mul(step(0.0, cUV.y)).mul(step(cUV.y, 1.0)).mul(U.coverOn);
    const coarseCover = mix(F(1.0), float(1.0).sub(smoothstep(COVER_LAND - 4, COVER_LAND + COVER_FADE - 4, texture(tex.cover, cUV).x)), cIn);
    const nearCover = hasShore ? mix(F(1.0), smoothstep(-3.5, -2.5, sh.raw), sh.win) : F(1.0);
    // (lod-hide) the sheet's outer edge is a circle round the focus (DMWaterCore.sheetRim, Radical Circumference rim): it dissolves across the rim and the
    // sky-ground tiles paint the sea over the same band, so the clip-map's square never shows on the far sea
    const rimK = float(1.0).sub(smoothstep(U.seaRim.x, U.seaRim.y, length(xz.sub(U.focus))));
    const cover = min(min(coarseCover, nearCover), rimK);
    let slope = se.sl.add(sw.sl), hgt = se.h.add(sw.h), foamLaceMix = null, foamLaceRaw = null, foamPatch = null, lavaHeat = null;
    // detail tile first (the foam, the capillary ripples and the ice read it): lace foam, pearl cells, micro slope
    const uvA = xz.mul(0.17).add(U.drift);
    const lace1 = (tier.name === 'high' || tier.name === 'ultra') ? Fn(() => { const r = vec4(0.0, 0.0, 0.0, 0.0).toVar(); const hw = float(1.0).sub(smoothstep(U.hexFar.mul(0.6), U.hexFar, dcam0)); r.assign(texture(tex.detail, uvA)); If(hw.greaterThan(0.004), () => { r.assign(mix(r, hexTap(tex.detail, uvA), hw)); }); return r; })() : texture(tex.detail, uvA);
    // parallax relief on the foam (High / Ultra): the second foam layer is read through a view-dependent shift by the first layer's height, so lace and bubbles have depth
    const par = (tier.name === 'high' || tier.name === 'ultra') ? vec2(Vd0.x, Vd0.z).div(max(Vd0.y, 0.2)).mul(lace1.x.sub(0.5).mul(0.11)).mul(float(1.0).sub(smoothstep(60.0, 160.0, dcam0))) : vec2(0.0, 0.0);
    const lace2 = texture(tex.detail, rot(xz, 0.64).mul(0.5413).sub(U.drift.mul(1.3)).add(0.37).add(par));
    const laceV = lace1.x.mul(0.62).add(lace2.x.mul(0.38)), pearlV = lace1.y.mul(0.6).add(lace2.y.mul(0.4)), microN = rot(vec2(lace2.z.sub(0.5), lace2.w.sub(0.5)), -0.64);
    // ripples (a real branch: costs nothing while the ring is empty)
    const rg = rippleGrad(xz), distCam = length(positionView);
    if (rg) slope = slope.add(rg.mul(float(1.0).sub(smoothstep(40.0, 70.0, distCam))));
    const slopeMag = length(slope);                                         // the sea's own slope: foam, SSS and glints read this, not the fine ripples below
    // capillary ripples (low surface tension: methane, ammonia): a fine gravity-capillary chop everywhere near the camera, two scales of the micro-slope tile
    const CAP = (P.capillary || 0) * (tier.name === 'low' ? 0 : 1);
    if (CAP > 0.05) {
      const c1 = texture(tex.detail, rot(xz, 1.1).mul(1.37).add(U.drift.mul(1.6))), c2 = texture(tex.detail, rot(xz, -0.7).mul(3.1).sub(U.drift.mul(2.2)).add(0.23));
      const capS = rot(vec2(c1.z.sub(0.5), c1.w.sub(0.5)), -1.1).add(rot(vec2(c2.z.sub(0.5), c2.w.sub(0.5)), 0.7).mul(0.7)).mul(CAP * 0.6).mul(float(1.0).sub(smoothstep(14.0, 70.0, distCam)));
      slope = slope.add(capS);
    }
    // ice: the swell is damped hard (calm pack) - lift its contrast a little so the pack still visibly heaves
    const slopeN = P.ice > 0.02 ? slope.mul(1.0 + 1.6 * P.ice) : slope;
    const nW = normalize(vec3(slopeN.x.negate(), F(1.0), slopeN.y.negate())), front = select(faceDirection.greaterThan(0.0), F(1), F(0));
    // whitecaps: the baked Jacobian potential against the live cover, plus the steepest spots of the summed field, plus the shore bore and the surf zone
    const FINE = P.foam.fine || 0, isFine = FINE > 0.05;
    const cov = clamp(U.wc.mul(mix(F(0.3), F(1.7), regD)), 0.0, 1.0), potW = se.pot.add(laceV.sub(0.5).mul(isFine ? 0.55 : 0.34));     // the lace rags the edge of the baked blobs (a tile texel is metres wide on a low-g world)
    const potT = smoothstep(float(1.0).sub(cov), float(1.0).sub(cov).add(0.3), potW);
    const steepF = smoothstep(0.5, 0.95, slopeMag.mul(1.0)).mul(cov.mul(1.4).add(0.15).min(1.0)).mul(isFine ? 0.5 : 1.0);
    const surfZone = hasShore ? float(1.0).sub(smoothstep(0.0, Math.max(1.5, H0 * 1.1), sh.d)).mul(sh.inside) : F(0);
    const breakF = hasShore ? smoothstep(0.8, 1.1, sh.ratio).mul(sh.inside) : F(0);
    const boreF = hasShore ? sw.bore.mul(surfZone.mul(0.6).add(breakF.mul(0.6))).mul(1.1).add(surfZone.mul(0.1)).mul(float(1.0).sub(sw.cm.mul(0.7))) : F(0);
    // contact foam: where the sea meets the ground or any object piercing it (scene depth), with the swash breathing the line
    let phiS = hasShore ? sw.phi : F(0); const fr = fract(phiS), swashP = select(fr.lessThan(0.22), sin(fr.div(0.22).mul(1.5708)), pow(max(float(1.0).sub(fr.sub(0.22).div(0.78)), 0.0), 1.7));
    const swell = hasShore ? swashP.mul(U.swashA) : lace2.z.mul(0.9);
    const edge = o.depthOK ? float(1.0).sub(smoothstep(0.0, 1.8, thick.sub(swell.mul(hasShore ? 1.6 : 0.9)))).mul(depthTrust) : F(0);
    const contact = o.depthOK ? edge.mul(smoothstep(0.3, 0.7, laceV).mul(0.6).add(0.4)).add(float(1.0).sub(smoothstep(0.0, 0.6, thick)).mul(0.6).mul(depthTrust)) : F(0);
    const isLava = P.kind === 'lava';
    let foam;
    if (isFine) {
      // low surface tension: small bubbles that pop at once. Fine speckle from the tile at two small scales, each speck blinking out on its own clock; no large-scale
      // patch term, no persistent trail (the band tiles are baked without one), the shore bore only broken up a little.
      const f1 = texture(tex.detail, rot(xz, 0.4).mul(1.9).add(U.drift.mul(2.1)).add(0.17)), f2 = texture(tex.detail, rot(xz, -1.0).mul(4.3).sub(U.drift.mul(3.0)).add(0.41));
      const life = sin(U.time.mul(2.3).add(f2.x.mul(6.283)).add(f1.x.mul(3.0))).mul(0.5).add(0.5);
      const speck = smoothstep(0.5, 0.76, f1.x.mul(0.5).add(f1.y.mul(0.3)).add(f2.y.mul(0.2))).mul(smoothstep(0.1, 0.7, life)), speckC = mix(float(1.0), speck, 0.6);
      const raw = clamp(potT.mul(0.8).add(steepF).mul(speck).add(boreF.add(contact.mul(0.9)).mul(speckC)), 0.0, 1.4);
      foam = smoothstep(0.12, 0.5, raw).mul(0.85).mul(front);
    } else {
      // the tile's filaments read as a fishnet when they alone gate the foam: pull them toward their mean and break them up with a slow, large-scale patchiness
      // (domain-warped by the lace so its blobs have no straight edges); the lace also eats holes into the body of a whitecap so it is never a flat white blob
      const patchV = texture(tex.detail, rot(xz, 2.1).mul(0.037).add(U.drift.mul(0.3)).add(0.61).add(vec2(lace2.x.sub(0.5), lace2.y.sub(0.5)).mul(0.12))).x;
      const laceRaw = P.foam.cell > 0 ? mix(laceV, pearlV, F(P.foam.cell * 0.85)) : laceV;
      const laceMix = mix(F(0.46), laceRaw, 0.55).mul(mix(F(0.74), F(1.24), smoothstep(0.25, 0.75, patchV)));
      let foamRaw = clamp(potT.add(steepF).mul(mix(F(0.5), F(1.3), laceMix.mul(1.6))).add(boreF).add(contact.mul(0.9)), 0.0, 1.4);
      foam = smoothstep(0.16, 0.5, foamRaw.sub(float(1.0).sub(laceMix).mul(0.5))).mul(front);
      foamLaceMix = laceMix; foamLaceRaw = laceRaw; foamPatch = patchV;
    }
    if (isLava) foam = F(0);
    // seen from altitude the baked whitecap tile is stretched into long repeating white streaks: thin the foam with distance (the sparkle of the far sea is left to the sun glint)
    else foam = foam.mul(mix(float(1.0), float(0.4), smoothstep(350.0, 1800.0, dcam0)));
    const laceMix = foamLaceMix || mix(F(0.46), laceV, 0.55);

    // plate network of the cells tile (ice floes, lava crust): two scales of coarse plates (one rotated) picked by a broad noise, so floes are neither one size nor a lattice
    const cellNet = (drf) => {
      const a = texture(tex.cells, xz.mul(0.0165).add(drf.mul(0.15)).add(0.07)), rx = xz.x.mul(0.8776).sub(xz.y.mul(0.4794)), rz = xz.x.mul(0.4794).add(xz.y.mul(0.8776));
      const c = texture(tex.cells, vec2(rx, rz).mul(0.0098).add(0.43).sub(drf.mul(0.1))), mk = smoothstep(0.42, 0.58, texture(tex.cells, xz.mul(0.0043).add(0.77)).w);
      return { edge: mix(a.x, c.x, mk), id: mix(a.y, c.y, mk), dust: mix(a.w, c.w, 0.5) };
    };
    // ice (cold worlds): floes, leads, brash, snow - from the cells tile (coarse plates + fine crazing + dust) and the detail tile's pearl cells (brash granules)
    let iceM = F(0), iceCol = null, iceBlue = null, iceRough = null;
    if (P.ice > 0.02 && tex.cells) {
      const IL = P.iceLook, net = cellNet(U.drift), cB = texture(tex.cells, xz.mul(0.0495).sub(U.drift.mul(0.3)).add(0.31)), gran = texture(tex.detail, xz.mul(0.62).add(0.19));
      const tone = fract(net.id.mul(7.31)), tone2 = fract(net.id.mul(3.7)), plateOn = float(1.0).sub(smoothstep(IL.cover - 0.05, IL.cover + 0.05, net.id)).max(IL.cover > 0.93 ? 1.0 : 0.0);
      const dN = smoothstep(0.34, 0.66, net.dust.mul(0.7).add(cB.w.mul(0.3)));                       // the fbm sits near 0.5: stretch it so patches have edges
      // lead width varies plate to plate and along the crack: some borders are hairlines, some are open
      const wv = float(0.35).add(fract(net.id.mul(13.7)).mul(0.6)).add(smoothstep(0.3, 0.7, cB.w).mul(0.7)), leadW = wv.mul(IL.lead * 0.42);
      const leadM = float(1.0).sub(smoothstep(leadW.mul(0.55), leadW, net.edge)), rimM = clamp(float(1.0).sub(smoothstep(leadW, leadW.add(0.2), net.edge)).sub(leadM), 0.0, 1.0);
      const craze = float(1.0).sub(smoothstep(0.04, 0.1, cB.z)).mul(float(1.0).sub(smoothstep(30.0, 110.0, distCam))), snowM = smoothstep(0.55, 0.85, dN).mul(IL.snow);
      // brash / slush patches (granular, grey-blue), thickest where the sea is just freezing
      const slushM = smoothstep(float(1.0).sub(IL.slush).mul(0.8), float(1.0).sub(IL.slush).mul(0.8).add(0.3), dN.mul(0.8).add(cB.w.mul(0.2))).mul(float(0.5).add(gran.y.mul(0.5)));
      const swSh = clamp(slope.x.mul(U.sunDir.x).add(slope.y.mul(U.sunDir.z)).mul(2.6 * IL.swell * (1.0 + 1.6 * P.ice)), -0.16, 0.16);
      let plate = mix(vec3(0.46, 0.55, 0.62), vec3(0.3, 0.46, 0.58), tone.mul(0.5));
      plate = mix(plate, vec3(0.74, 0.8, 0.86), snowM).mul(float(0.88).add(tone2.mul(0.2))).mul(float(1.0).sub(craze.mul(0.2))).mul(float(1.0).add(swSh));
      plate = mix(plate, vec3(0.2, 0.46, 0.64).mul(float(0.8).add(tone2.mul(0.3))), rimM.mul(IL.blueEdge));       // translucent blue rim where a plate thins toward its crack
      const leadOpen = mix(U.deep.mul(0.5), vec3(0.012, 0.08, 0.16), 0.6), leadIce = mix(leadOpen, vec3(0.09, 0.36, 0.54).mul(float(0.75).add(net.dust.mul(0.5))), IL.refrozen);
      const slushCol = mix(vec3(0.36, 0.44, 0.5), vec3(0.62, 0.68, 0.73), gran.x.mul(0.7)).mul(float(1.0).add(swSh));
      const inner = plateOn.mul(float(1.0).sub(leadM));
      let ice = mix(leadIce, plate, inner);
      const slushW = slushM.mul(float(1.0).sub(inner.mul(0.75)));
      ice = mix(ice, slushCol, slushW);
      iceM = clamp(inner.add(leadM.mul(plateOn).mul(IL.refrozen)).add(rimM.mul(plateOn)).add(slushW), 0.0, 1.0).mul(front);
      iceCol = ice;
      iceBlue = vec3(0.03, 0.16, 0.3).mul(leadM.mul(0.5).add(rimM.mul(0.32)).add(craze.mul(0.06))).mul(IL.leadBlue).mul(plateOn.mul(0.6).add(0.4));
      iceRough = mix(mix(F(0.46), F(0.85), slushW), F(0.14), leadM.mul(float(1.0).sub(slushW)).mul(0.7));
      foam = foam.mul(float(1.0).sub(iceM));
    }

    // depth colour: Beer-Lambert through the water in front of the ground / objects behind it
    const kAbs = (P.absorb[0] + P.absorb[1] + P.absorb[2]) / 3, clarity = exp(thick.mul(-kAbs * 1.25).sub(0.0));
    const body = mix(U.deep, U.shallow, clarity.mul(o.depthOK ? 1.0 : 0.0));
    let color = mix(body, U.foamCol, foam);
    if (iceCol) color = mix(color, iceCol, iceM);
    if (isLava) {
      // crust: dark plates (the cells tile: two scales of big plates, fine crazing) over glowing melt; the cracks are the light, some plates are thin and hot
      const net = cellNet(U.drift.mul(1.6)), cB = texture(tex.cells, xz.mul(0.043).sub(U.drift.mul(0.6)).add(0.31));
      const hot = fract(net.id.mul(5.3)), wv = float(0.4).add(smoothstep(0.3, 0.7, cB.w).mul(0.9)), crackW = float(0.04).add(hot.mul(0.09)).mul(wv).add(distCam.mul(0.00035));
      const core0 = float(1.0).sub(smoothstep(0.0, crackW, net.edge)), halo = float(1.0).sub(smoothstep(0.0, crackW.mul(4.5), net.edge));
      const craze = float(1.0).sub(smoothstep(0.03, 0.09, cB.z)).mul(float(0.25).add(hot.mul(0.6))).mul(float(1.0).sub(smoothstep(25.0, 90.0, distCam))), broad = float(0.62).add(smoothstep(0.3, 0.75, cB.w).mul(0.6));
      const thin = smoothstep(0.86, 0.97, hot).mul(0.42).mul(broad);                                      // a thin plate: the melt shows through as a dull red glow
      const heat = clamp(max(core0, craze.mul(0.55)).add(halo.mul(0.3)).mul(broad).add(thin), 0.0, 1.3).mul(float(0.88).add(sin(U.time.mul(0.9).add(net.id.mul(40.0))).mul(0.12)));
      lavaHeat = heat;
      color = mix(vec3(0.045, 0.037, 0.034), vec3(0.1, 0.08, 0.07), net.dust).mul(float(1.0).sub(heat.min(1.0).mul(0.8)));
    }
    const opBase = Math.max(0.85, o.opacity || 0.82);
    let opacity = clamp(mix(F(0.28), F(opBase), smoothstep(0.0, 9.0, thick)).add(foam.mul(0.6)), 0.0, 1.0).mul(cover);
    if (P.ice > 0.02) opacity = max(opacity, iceM.mul(0.97));
    if (!o.depthOK) opacity = F(Math.min(0.93, opBase)).add(foam.mul(0.07));

    // view vector, Fresnel sky reflection, subsurface crest tint, sun glint sparkle
    let sunUpL = U.sunUp; try { const DL = W.DMLight, sv = DL && DL.on && DL.sunVisNode ? DL.sunVisNode(T.positionWorld) : null; if (sv) sunUpL = U.sunUp.mul(sv); } catch (e) { }   // (ui/dm-light.js) mountain / cliff / building shadows fall on the sea: glint, subsurface and caustics follow the height-cache sun visibility
    const nWf = nW;
    const Vd = normalize(cameraPosition.sub(vec3(flatP.x, F(0), flatP.z)));
    const nd = max(dot(nWf, Vd), 0.0), Fr = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(nd), 5.0))).mul(float(1.0).sub(foam)).mul(float(1.0).sub(iceM.mul(0.6)));
    const R = reflect(Vd.negate(), nWf), ry = clamp(R.y, 0.0, 1.0), skyC = mix(U.skyHor, U.skyTop, pow(ry, 0.45)), envOn = (o.envMap ? 0.35 : 1.0) * P.sky;
    const sunD = max(dot(R, U.sunDir), 0.0), glint = pow(sunD, 900.0).mul(60.0).add(pow(sunD, 60.0).mul(1.6)).mul(sunUpL).mul(float(1.0).sub(foam)).mul(float(1.0).sub(iceM.mul(0.7))).mul(smoothstep(0.0, 0.35, ry.add(0.02)));
    const emissiveParts = [skyC.mul(Fr).mul(envOn), U.sunCol.mul(glint).mul(Fr.mul(0.7).add(0.3)).mul(tier.glint ? 1.0 : 0.0)];
    emissiveParts.push(U.foamCol.mul(foam).mul(U.sunUp.mul(0.4).add(0.14)));     // foam is lit by the whole sky, not just the key light
    let sssAmt = F(0);
    if (tier.sss && P.sss > 0.05 && !isLava) {
      const Ld = normalize(U.sunDir.add(nWf.mul(0.22))), s1 = pow(clamp(dot(Vd, Ld.negate()), 0.0, 1.0), 4.0), s2 = pow(clamp(float(0.5).sub(dot(nWf, U.sunDir).mul(0.5)), 0.0, 1.0), 3.0);
      const crest = smoothstep(-0.05, 0.6, hgt.div(Math.max(0.6, P.HsTotal * 0.55))).mul(float(0.35).add(slopeMag.mul(1.6).min(0.65)));
      sssAmt = s1.add(s2.mul(0.35)).mul(crest).mul(sunUpL.mul(0.85).add(0.15)).mul(float(1.0).sub(foam)).mul(P.sss).mul(float(1.0).sub(U.under));
      emissiveParts.push(U.scatter.mul(sssAmt).mul(1.15));
    }
    // caustics on the shallow bed: the baked tile, two scrolled copies, projected along the sun through the surface
    if (tier.caustic && o.depthOK && (typeof W.GFX === 'undefined' || W.GFX.caustics !== false)) {
      const bedV = positionView.mul(sceneZ.div(positionView.z)), bedW = cameraWorldMatrix.mul(vec4(bedV, 1.0)).xyz, dep = clamp(bedW.y.negate(), 0.0, 40.0);
      const L = U.sunDir, off = vec2(L.x, L.z).div(max(L.y, 0.3)).mul(dep.mul(0.75)), cuv = bedW.xz.add(off).add(slope.mul(dep.mul(1.2))), t = U.time;
      const ca = texture(tex.caustic, cuv.mul(0.075).add(vec2(t.mul(0.011), t.mul(0.007)))).rgb, cb = texture(tex.caustic, rot(cuv, 0.9).mul(0.0521).add(vec2(t.mul(-0.009), t.mul(0.013)))).rgb;
      const cc = min(ca, cb).mul(2.1), amt = sunUpL.mul(exp(dep.mul(-0.16))).mul(smoothstep(0.05, 0.8, dep)).mul(float(1.0).sub(foam)).mul(float(1.0).sub(opacity)).div(max(opacity, 0.28)).mul(U.lvl.mul(0.5).add(0.5)).mul(mix(F(0.7), F(1.3), regD));
      emissiveParts.push(cc.mul(U.sunCol).mul(amt).mul(0.7));
    }
    // glow: Solenne's bioluminescence (crests, foam edges and the wake pulse at dusk and night) and lava's melt
    if (P.glow > 0 && !isLava) {
      const pulse = U.pulse.mul(sin(laceV.mul(6.28).add(U.time.mul(P.pulseHz * 6.0 + 0.6))).mul(0.2).add(0.8));
      const rim = foam.mul(float(1.0).sub(foam)).mul(4.0).add(sssAmt.mul(1.4)).add(smoothstep(0.35, 0.7, laceMix).mul(foam).mul(0.5)), spark = pow(laceMix, 7.0).mul(0.5);
      const amt = U.night.mul(0.95).add(0.16).mul(U.glow).mul(rim.add(spark.mul(smoothstep(0.1, 0.5, hgt.add(0.3))))).mul(pulse);
      emissiveParts.push(mix(U.glowCol, U.glowCol2, clamp(laceV.mul(1.4).add(sin(xz.x.mul(0.05).add(U.time.mul(0.2))).mul(0.3)), 0.0, 1.0)).mul(amt).mul(1.8));
    }
    if (isLava && lavaHeat) {   // blackbody ramp: dull red halo -> orange -> yellow-white at the core of a crack
      const h = lavaHeat, ramp = mix(mix(vec3(0.3, 0.035, 0.01), vec3(1.0, 0.36, 0.04), smoothstep(0.15, 0.6, h)), vec3(1.0, 0.86, 0.42), smoothstep(0.75, 1.15, h));
      emissiveParts.push(ramp.mul(smoothstep(0.05, 0.4, h)).mul(1.9));
    }
    if (iceBlue) emissiveParts.push(iceBlue.mul(U.sunUp.mul(0.6).add(0.4)));       // subsurface blue glowing out of the cracks and thin edges
    let emissive = emissiveParts[0]; for (let i = 1; i < emissiveParts.length; i++) emissive = emissive.add(emissiveParts[i]);

    // from underneath: the sky through the window (Snell cone), dark teal outside it
    const under = front.lessThan(0.5);
    const win = smoothstep(0.55, 0.78, abs(Vd.y)), underCol = mix(U.deep.mul(0.45), U.scatter.mul(0.25), win.mul(0.5)), underEm = mix(U.deep.mul(0.35), skyColUnder(), win);
    function skyColUnder() { return mix(U.skyHor, U.skyTop, 0.5).mul(0.85); }
    m.colorNode = select(under, underCol, color);
    m.emissiveNode = select(under, underEm, emissive);
    m.opacityNode = select(under, F(0.93).mul(cover), opacity);
    const rough = clamp(float(P.rough).add(se.unres.add(0.002).sqrt().mul(1.6)).add(microN.length().mul(0.04)), 0.03, 1.0);
    m.roughnessNode = mix(rough, F(0.85), clamp(foam, 0.0, 1.0)); if (iceRough) m.roughnessNode = mix(m.roughnessNode, iceRough, iceM); if (isLava) m.roughnessNode = F(0.9);
    m.metalnessNode = F(0.12);
    // micro slope + ripples are in `slope`; the micro tile only roughens (cheap) - add it to the normal on High/Ultra near the camera
    const nFinal = tier.name === 'high' || tier.name === 'ultra' || (P.ice > 0.02 && tier.name === 'medium') ? normalize(nW.add(vec3(microN.x, 0.0, microN.y).mul(float(0.22).mul(float(1.0).sub(smoothstep(8.0, 40.0, distCam))))).mul(select(under, F(-1), F(1)))) : nW.mul(select(under, F(-1), F(1)));
    if (pwf && pwf.ready()) { m.positionNode = pwf.nodeFor(posNode); m.userData._pwf = true; m.maskNode = pwf.mask().and(cover.greaterThan(0.02)); m.normalNode = normalize(cameraViewMatrix.mul(vec4(pwf.rotN(vec3(flatP.x, F(0), flatP.z), nFinal), 0.0)).xyz); }
    else { m.maskNode = cover.greaterThan(0.02); m.positionNode = posNode; m.normalNode = normalize(cameraViewMatrix.mul(vec4(nFinal, 0.0)).xyz); }
    if (o.envMap) m.envMap = o.envMap;
    if (W.__WDBG) { const d = W.__WDBG, v = d === 'h' ? vec3(hgt.mul(0.25).add(0.5)) : d === 'foam' ? vec3(foam) : d === 'bore' ? vec3(boreF) : d === 'phi' ? vec3(fract(sw.phi)) : d === 'pot' ? vec3(se.pot) : d === 'd' ? vec3(sh.d.div(20.0)) : d === 'blend' ? vec3(sh.blend) : d === 'ratio' ? vec3(sh.ratio.div(3.0)) : d === 'slope' ? vec3(slope.x.mul(2.0).add(0.5), slope.y.mul(2.0).add(0.5), 0.5) : vec3(0.0); m.colorNode = vec3(0.0, 0.0, 0.0); m.emissiveNode = v; m.opacityNode = F(1.0); m.lightsNode = null; try { m.lights = false; } catch (e) { } }
    m.userData.dmWater = true; S.mats++; S.matCache = m; S.matBuilt = true;
    return m;
  }

  // ground hook: wet sand darkening (outlives the wave), swash film and its foam front. m: a ground NodeMaterial; c: { p (flat world point node) }
  function receiveShore(m, c) {
    const DW = D(), S = DW.S; if (!S.active || !S.U || !S.tier.shore || !m || !m.isNodeMaterial || !c || !c.p) return false;
    try {
      const T = T3(), { Fn, If, float, vec2, vec3, mix, smoothstep, clamp, pow, sin, fract, select, texture, max } = T, U = S.U, P = S.P, tex = S.tex, p = c.p, Ps = Math.sqrt(PI2 * P.lamS / P.g);
      const top = U.wetTop.add(U.swashA).add(0.7);
      const R = Fn(() => {   // (wetMemory, film, front, 0)
        const o = T.vec4(0.0, 0.0, 0.0, 0.0).toVar();
        If(U.shoreOn.greaterThan(0.5).and(p.y.lessThan(top)).and(p.y.greaterThan(-0.6)), () => {
          const uv = p.xz.sub(vec2(U.shoreC.x, U.shoreC.y)).div(U.shoreC.z).add(0.5), tx = texture(tex.shore, uv), ph = fract(U.time.sub(tx.y).div(Ps));
          const run = U.swashA.mul(select(ph.lessThan(0.22), sin(ph.div(0.22).mul(1.5708)), pow(max(float(1.0).sub(ph.sub(0.22).div(0.78)), 0.0), 1.7))).mul(smoothstep(-0.6, 0.0, p.y.negate().add(U.swashA)));
          const lace = texture(tex.detail, p.xz.mul(0.31).add(U.drift.mul(0.5))), wob = texture(tex.detail, p.xz.mul(0.043)).x;
          const wetTopL = U.wetTop.mul(float(0.7).add(wob.mul(0.6))), wet = float(1.0).sub(smoothstep(wetTopL.sub(0.16), wetTopL.add(0.03), p.y)).max(float(1.0).sub(smoothstep(-0.2, 0.0, p.y.negate().sub(0.0)).mul(0.0))).max(p.y.lessThan(0.05).select(float(1.0), float(0.0)));
          const film = float(1.0).sub(smoothstep(run.sub(0.05), run, p.y)).mul(p.y.greaterThan(-0.05).select(float(1.0), float(0.0)));
          const frontF = smoothstep(run.sub(0.26), run, p.y).mul(film).mul(smoothstep(0.25, 0.7, lace.x.mul(0.7).add(lace.y.mul(0.3))).mul(0.7).add(0.3));
          o.assign(T.vec4(wet, film, frontF, 0.0));
        });
        return o;
      })().toVar();
      const wet = R.x, film = R.y, front = R.z, col = m.colorNode, rgh = m.roughnessNode;
      let c1 = mix(col, col.mul(0.62), wet.mul(0.9)); c1 = mix(c1, c1.mul(0.7).add(U.deep.mul(0.18)), film.mul(0.6)); c1 = mix(c1, U.foamCol, front.mul(0.85));
      m.colorNode = c1; m.roughnessNode = mix(mix(rgh, float(0.3), wet.mul(0.85)), float(0.05), film);
      m.emissiveNode = (m.emissiveNode || vec3(0.0, 0.0, 0.0)).add(mix(U.skyHor, U.skyTop, 0.3).mul(film.mul(0.22).add(wet.mul(0.03))).mul(U.sunUp.mul(0.7).add(0.3)));
      if (P.glow > 0) m.emissiveNode = m.emissiveNode.add(U.glowCol.mul(front.mul(U.night.mul(0.9).add(0.12)).mul(U.glow).mul(1.2)));
      m.userData.dmShore = true; return true;
    } catch (e) { try { console.warn('[water] shore hook', e); } catch (_) { } return false; }
  }

  const DW = W.DMWater; if (DW) { DW.material = material; DW.receiveShore = receiveShore; DW.rippleGrad = rippleGrad; }
})(typeof window !== 'undefined' ? window : globalThis);
