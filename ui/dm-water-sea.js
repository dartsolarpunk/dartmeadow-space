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
    const THREE = W.THREE, T = THREE.TSL, P = S.P, U = S.U, tier = S.tier, spec = S.spec, tex = S.tex, pwf = o.pwf || null;
    const { Fn, If, float, vec2, vec3, vec4, mix, smoothstep, clamp, max, min, pow, exp, abs, dot, normalize, length, sin, cos, sqrt, floor, fract, texture, select,
      attribute, varying, positionView, cameraNear, cameraFar, viewportDepthTexture, dFdx, dFdy, reflect, cameraPosition, cameraViewMatrix, cameraWorldMatrix, faceDirection } = T;
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const nb = spec.bands.length, nl = tier.layers, F = (v) => float(v);

    /* ---------- vertex: clip-map position (per-level snap), displacement from the swell + mid tiles ---------- */
    const aPos = attribute('wpos', 'vec2'), aLvl = attribute('wlvl', 'float'), aMor = attribute('wmorph', 'vec2');
    const snap = floor(U.focus.div(aLvl)).mul(aLvl), xzV = aPos.add(snap);
    // shore field fetch (vertex: level 0)
    const shoreUV = (xz) => xz.sub(vec2(U.shoreC.x, U.shoreC.y)).div(U.shoreC.z).add(0.5);
    const shoreInside = (uv) => smoothstep(0.0, 0.07, uv.x).mul(smoothstep(0.0, 0.07, uv.y)).mul(float(1.0).sub(smoothstep(0.93, 1.0, uv.x))).mul(float(1.0).sub(smoothstep(0.93, 1.0, uv.y))).mul(U.shoreOn);
    const dDeep = Math.min(30, Math.max(6, 0.2 * P.lamS)), H0 = Math.max(0.3, P.HsS * 0.9), Ps = Math.sqrt(PI2 * P.lamS / P.g);
    const hasShore = tier.shore > 0;
    const shore = (xz, vtx) => {
      if (!hasShore) return { d: F(80), T: F(0), g: vec2(0.0, 0.0), inside: F(0), amp: F(1), blend: F(0), ratio: F(0) };
      const uv = shoreUV(xz), tx = vtx ? texture(tex.shore, uv).level(F(0)) : texture(tex.shore, uv), inside = shoreInside(uv), d = max(mix(F(80), tx.x, inside), 0.05);
      const gain = clamp(pow(F(0.5 * P.lamS).div(d), 0.25), 1.0, 2.0), waveH = min(gain.mul(H0), d.mul(0.78)), amp = clamp(waveH.div(H0), 0.0, 1.0), ratio = gain.mul(H0).div(d.mul(0.78));
      const blend = float(1.0).sub(smoothstep(U.shoreP.x.mul(0.5), U.shoreP.x.mul(1.0), d)).mul(inside);
      return { d, T: tx.y, g: vec2(tx.z, tx.w), inside, amp: mix(F(1), amp, inside), blend, ratio, waveH };
    };
    // one sea evaluation: slope (vec2), height, whitecap potential. vtx = vertex stage (level-0 fetch, swell + mid only, no footprint fade)
    const sea = (xz, vtx, fp, sh) => {
      let sl = vec2(0.0, 0.0), h = F(0), pot = F(0), unres = F(0);
      for (let bi = 0; bi < nb; bi++) {
        if (vtx && bi > 1) break;
        const b = spec.bands[bi], fade = vtx ? F(1) : float(1.0).sub(smoothstep(b.lamMin * 0.14, b.lamMin * 0.5, fp)), wt = fade.mul(U.bandAmt[bi]).mul(bi === 0 ? U.swellAmp.mul(sh.amp).mul(float(1.0).sub(sh.blend.mul(0.88))) : F(1));
        for (let L = 0; L < nl; L++) {
          const k = bi * nl + L, mm = U.bm[k], uv = vec2(mm.x.mul(xz.x).add(mm.y.mul(xz.y)), mm.z.mul(xz.x).add(mm.w.mul(xz.y))).sub(U.boff[k]), tx = vtx ? texture(tex.bands[bi], uv).level(F(0)) : texture(tex.bands[bi], uv), gg = U.bg[k];
          const g2 = tx.xy.mul(2.0).sub(1.0);
          sl = sl.add(vec2(gg.x.mul(g2.x).add(gg.y.mul(g2.y)), gg.z.mul(g2.x).add(gg.w.mul(g2.y))).mul(wt));
          h = h.add(tx.z.mul(2.0).sub(1.0).mul(U.bhw[k]).mul(wt));
          if (!vtx && L === 0) if (bi > 0 || nb === 1) pot = max(pot, tx.w.mul(wt));
        }
        if (!vtx) unres = unres.add(float(1.0).sub(fade).mul(b.smax * b.smax * 0.3));
      }
      return { sl: sl.mul(U.amp), h: h.mul(U.amp), pot, unres };
    };
    // shore waves: the swell turns into a train riding the eikonal travel time T (phase = (t - T) / period), skewed and steepened as it breaks
    const shoreWave = (sh) => {
      if (!hasShore) return { h: F(0), sl: vec2(0.0, 0.0), bore: F(0), phi: F(0) };
      const phi = U.time.sub(sh.T).div(Ps), ph = phi.mul(PI2), skew = float(0.22).add(clamp(sh.ratio.sub(0.7), 0.0, 1.0).mul(0.6));
      const A = min(sh.d.mul(0.39), F(0.5 * H0 * 1.4)).mul(0.68).mul(U.amp).mul(U.swellAmp).mul(sh.blend);
      const s = cos(ph).add(cos(ph.mul(2.0)).mul(0.35)).add(sin(ph.mul(2.0)).mul(skew)), ds = sin(ph).negate().sub(sin(ph.mul(2.0)).mul(0.7)).add(cos(ph.mul(2.0)).mul(skew.mul(2.0)));
      const h = A.mul(s), sl = sh.g.mul(A.mul(ds).mul(-PI2 / Ps));
      const fr = fract(phi), bore = pow(float(1.0).sub(fr), 2.6).mul(smoothstep(0.0, 0.05, fr));
      return { h, sl, bore, phi };
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
    const sceneZ = o.depthOK ? depthToViewZ(viewportDepthTexture().r) : null;
    const thick = o.depthOK ? clamp(positionView.z.sub(sceneZ), 0.0, 500.0) : F(40);
    const fp = max(length(dFdx(xz)), length(dFdy(xz)));
    const sh = shore(xz, false), se = sea(xz, false, fp, sh), sw = shoreWave(sh);
    let slope = se.sl.add(sw.sl), hgt = se.h.add(sw.h);
    // ripples (a real branch: costs nothing while the ring is empty)
    const rg = rippleGrad(xz), distCam = length(positionView);
    if (rg) slope = slope.add(rg.mul(float(1.0).sub(smoothstep(40.0, 70.0, distCam))));
    const nW = normalize(vec3(slope.x.negate(), F(1.0), slope.y.negate())), front = select(faceDirection.greaterThan(0.0), F(1), F(0));
    // detail tile: lace foam, pearl cells, micro slope
    const lace1 = texture(tex.detail, xz.mul(0.17).add(U.drift)), lace2 = texture(tex.detail, xz.mul(0.53).sub(U.drift.mul(1.3)).add(0.37));
    const laceV = lace1.x.mul(0.62).add(lace2.x.mul(0.38)), pearlV = lace1.y.mul(0.6).add(lace2.y.mul(0.4)), microN = vec2(lace2.z.sub(0.5), lace2.w.sub(0.5));
    const slopeMag = length(slope);
    // whitecaps: the baked Jacobian potential against the live cover, plus the steepest spots of the summed field, plus the shore bore and the surf zone
    const cov = U.wc, potT = smoothstep(float(1.0).sub(cov), float(1.0).sub(cov).add(0.3), se.pot);
    const steepF = smoothstep(0.5, 0.95, slopeMag.mul(1.0)).mul(cov.mul(1.4).add(0.15).min(1.0));
    const surfZone = hasShore ? float(1.0).sub(smoothstep(0.0, Math.max(1.5, H0 * 1.1), sh.d)).mul(sh.inside) : F(0);
    const breakF = hasShore ? smoothstep(0.8, 1.1, sh.ratio).mul(sh.inside) : F(0);
    const boreF = hasShore ? sw.bore.mul(surfZone.mul(0.6).add(breakF.mul(0.6))).mul(1.1).add(surfZone.mul(0.1)) : F(0);
    // contact foam: where the sea meets the ground or any object piercing it (scene depth), with the swash breathing the line
    let phiS = hasShore ? sw.phi : F(0); const fr = fract(phiS), swashP = select(fr.lessThan(0.22), sin(fr.div(0.22).mul(1.5708)), pow(max(float(1.0).sub(fr.sub(0.22).div(0.78)), 0.0), 1.7));
    const swell = hasShore ? swashP.mul(U.swashA) : lace2.z.mul(0.9);
    const edge = o.depthOK ? float(1.0).sub(smoothstep(0.0, 1.8, thick.sub(swell.mul(hasShore ? 1.6 : 0.9)))) : F(0);
    const contact = o.depthOK ? edge.mul(smoothstep(0.3, 0.7, laceV).mul(0.6).add(0.4)).add(float(1.0).sub(smoothstep(0.0, 0.6, thick)).mul(0.6)) : F(0);
    let foamRaw = clamp(potT.mul(1.0).add(steepF).add(boreF).add(contact.mul(0.9)), 0.0, 1.4);
    // the tile's filaments read as a fishnet when they alone gate the foam: pull them toward their mean and break them up with a slow, large-scale patchiness
    const patchV = texture(tex.detail, xz.mul(0.037).add(U.drift.mul(0.3)).add(0.61)).x;
    const laceRaw = P.foam.cell > 0 ? mix(laceV, pearlV, F(P.foam.cell * 0.85)) : laceV;
    const laceMix = mix(F(0.46), laceRaw, 0.55).mul(mix(F(0.62), F(1.3), smoothstep(0.25, 0.75, patchV)));
    const foam = smoothstep(0.16, 0.5, foamRaw.sub(float(1.0).sub(laceMix).mul(0.5))).mul(front);
    // ice slush (cold worlds): plates from the pearl cells, flat and white-blue
    let iceM = F(0);
    if (P.ice > 0.02) { const plates = texture(tex.detail, xz.mul(0.041).add(0.13)).y.mul(0.7).add(texture(tex.detail, xz.mul(0.113)).x.mul(0.3)); iceM = smoothstep(float(1.0).sub(U.ice.mul(1.1)), float(1.0).sub(U.ice.mul(1.1)).add(0.1), plates).mul(front); }
    // crust (lava): dark plates drifting over glowing melt
    const isLava = P.kind === 'lava';

    // depth colour: Beer-Lambert through the water in front of the ground / objects behind it
    const kAbs = (P.absorb[0] + P.absorb[1] + P.absorb[2]) / 3, clarity = exp(thick.mul(-kAbs * 1.25).sub(0.0));
    const body = mix(U.deep, U.shallow, clarity.mul(o.depthOK ? 1.0 : 0.0));
    let color = mix(body, U.foamCol, foam);
    if (P.ice > 0.02) color = mix(color, vec3(0.78, 0.9, 0.97), iceM.mul(0.92));
    if (isLava) color = mix(U.deep, U.foamCol, foam);
    const opBase = Math.max(0.85, o.opacity || 0.82);
    let opacity = clamp(mix(F(0.28), F(opBase), smoothstep(0.0, 9.0, thick)).add(foam.mul(0.6)), 0.0, 1.0);
    if (P.ice > 0.02) opacity = max(opacity, iceM.mul(0.97));
    if (!o.depthOK) opacity = F(Math.min(0.93, opBase)).add(foam.mul(0.07));

    // view vector, Fresnel sky reflection, subsurface crest tint, sun glint sparkle
    const nWf = nW;
    const Vd = normalize(cameraPosition.sub(vec3(flatP.x, F(0), flatP.z)));
    const nd = max(dot(nWf, Vd), 0.0), Fr = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(nd), 5.0))).mul(float(1.0).sub(foam)).mul(float(1.0).sub(iceM.mul(0.6)));
    const R = reflect(Vd.negate(), nWf), ry = clamp(R.y, 0.0, 1.0), skyC = mix(U.skyHor, U.skyTop, pow(ry, 0.45)), envOn = (o.envMap ? 0.35 : 1.0) * P.sky;
    const sunD = max(dot(R, U.sunDir), 0.0), glint = pow(sunD, 900.0).mul(60.0).add(pow(sunD, 60.0).mul(1.6)).mul(U.sunUp).mul(float(1.0).sub(foam)).mul(smoothstep(0.0, 0.35, ry.add(0.02)));
    const emissiveParts = [skyC.mul(Fr).mul(envOn), U.sunCol.mul(glint).mul(Fr.mul(0.7).add(0.3)).mul(tier.glint ? 1.0 : 0.0)];
    let sssAmt = F(0);
    if (tier.sss && P.sss > 0.05 && !isLava) {
      const Ld = normalize(U.sunDir.add(nWf.mul(0.22))), s1 = pow(clamp(dot(Vd, Ld.negate()), 0.0, 1.0), 4.0), s2 = pow(clamp(float(0.5).sub(dot(nWf, U.sunDir).mul(0.5)), 0.0, 1.0), 3.0);
      const crest = smoothstep(-0.05, 0.6, hgt.div(Math.max(0.6, P.HsTotal * 0.55))).mul(float(0.35).add(slopeMag.mul(1.6).min(0.65)));
      sssAmt = s1.add(s2.mul(0.35)).mul(crest).mul(U.sunUp.mul(0.85).add(0.15)).mul(float(1.0).sub(foam)).mul(P.sss).mul(float(1.0).sub(U.under));
      emissiveParts.push(U.scatter.mul(sssAmt).mul(1.15));
    }
    // caustics on the shallow bed: the baked tile, two scrolled copies, projected along the sun through the surface
    if (tier.caustic && o.depthOK && (typeof W.GFX === 'undefined' || W.GFX.caustics !== false)) {
      const bedV = positionView.mul(sceneZ.div(positionView.z)), bedW = cameraWorldMatrix.mul(vec4(bedV, 1.0)).xyz, dep = clamp(bedW.y.negate(), 0.0, 40.0);
      const L = U.sunDir, off = vec2(L.x, L.z).div(max(L.y, 0.3)).mul(dep.mul(0.75)), cuv = bedW.xz.add(off).add(slope.mul(dep.mul(1.2))), t = U.time;
      const ca = texture(tex.caustic, cuv.mul(0.075).add(vec2(t.mul(0.011), t.mul(0.007)))).rgb, cb = texture(tex.caustic, cuv.mul(0.052).add(vec2(t.mul(-0.009), t.mul(0.013)))).rgb;
      const cc = min(ca, cb).mul(2.1), amt = U.sunUp.mul(exp(dep.mul(-0.16))).mul(smoothstep(0.05, 0.8, dep)).mul(float(1.0).sub(foam)).mul(float(1.0).sub(opacity)).div(max(opacity, 0.28)).mul(U.lvl.mul(0.5).add(0.5));
      emissiveParts.push(cc.mul(U.sunCol).mul(amt).mul(0.7));
    }
    // glow: Solenne's bioluminescence (crests, foam edges and the wake pulse at dusk and night) and lava's melt
    if (P.glow > 0 && !isLava) {
      const pulse = U.pulse.mul(sin(laceV.mul(6.28).add(U.time.mul(P.pulseHz * 6.0 + 0.6))).mul(0.2).add(0.8));
      const rim = foam.mul(float(1.0).sub(foam)).mul(4.0).add(sssAmt.mul(1.4)).add(smoothstep(0.35, 0.7, laceMix).mul(foam).mul(0.5)), spark = pow(laceMix, 7.0).mul(0.5);
      const amt = U.night.mul(0.95).add(0.16).mul(U.glow).mul(rim.add(spark.mul(smoothstep(0.1, 0.5, hgt.add(0.3))))).mul(pulse);
      emissiveParts.push(mix(U.glowCol, U.glowCol2, clamp(laceV.mul(1.4).add(sin(xz.x.mul(0.05).add(U.time.mul(0.2))).mul(0.3)), 0.0, 1.0)).mul(amt).mul(1.8));
    }
    if (isLava) {
      const crack = smoothstep(0.3, 0.55, laceRaw.mul(0.7).add(patchV.mul(0.3))), melt = float(1.0).sub(foam).mul(crack.mul(0.92).add(0.06)), flow = smoothstep(0.25, 0.8, laceMix).mul(0.5).add(0.5);
      emissiveParts.push(mix(vec3(0.9, 0.22, 0.03), vec3(1.0, 0.65, 0.15), flow).mul(melt).mul(1.6));
    }
    let emissive = emissiveParts[0]; for (let i = 1; i < emissiveParts.length; i++) emissive = emissive.add(emissiveParts[i]);

    // from underneath: the sky through the window (Snell cone), dark teal outside it
    const under = front.lessThan(0.5);
    const win = smoothstep(0.55, 0.78, abs(Vd.y)), underCol = mix(U.deep.mul(0.45), U.scatter.mul(0.25), win.mul(0.5)), underEm = mix(U.deep.mul(0.35), skyColUnder(), win);
    function skyColUnder() { return mix(U.skyHor, U.skyTop, 0.5).mul(0.85); }
    m.colorNode = select(under, underCol, color);
    m.emissiveNode = select(under, underEm, emissive);
    m.opacityNode = select(under, F(0.93), opacity);
    const rough = clamp(float(P.rough).add(se.unres.add(0.002).sqrt().mul(1.6)).add(microN.length().mul(0.04)), 0.03, 1.0);
    m.roughnessNode = mix(rough, F(0.85), clamp(foam, 0.0, 1.0)); if (P.ice > 0.02) m.roughnessNode = mix(m.roughnessNode, F(0.5), iceM); if (isLava) m.roughnessNode = F(0.9);
    m.metalnessNode = F(0.12);
    // micro slope + ripples are in `slope`; the micro tile only roughens (cheap) - add it to the normal on High/Ultra near the camera
    const nFinal = tier.name === 'high' || tier.name === 'ultra' ? normalize(nW.add(vec3(microN.x, 0.0, microN.y).mul(float(0.22).mul(float(1.0).sub(smoothstep(8.0, 40.0, distCam))))).mul(select(under, F(-1), F(1)))) : nW.mul(select(under, F(-1), F(1)));
    if (pwf && pwf.ready()) { m.positionNode = pwf.nodeFor(posNode); m.userData._pwf = true; m.maskNode = pwf.mask(); m.normalNode = normalize(cameraViewMatrix.mul(vec4(pwf.rotN(vec3(flatP.x, F(0), flatP.z), nFinal), 0.0)).xyz); }
    else { m.positionNode = posNode; m.normalNode = normalize(cameraViewMatrix.mul(vec4(nFinal, 0.0)).xyz); }
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
