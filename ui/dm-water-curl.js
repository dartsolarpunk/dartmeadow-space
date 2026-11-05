/* DART Meadow — the breaking-wave curl: a glassy turquoise wall that curls over with the light passing through the thin lip, foam at the crest and the base,
 * a soft translucent edge, spray thrown off the lip (the look of a small plunging breaker; the maths is ours, see ui/dm-water-core.js section 13).
 *
 *   What it is   a baked cross-section (curl LUT: Ns profile samples x 8 curl amounts, half float) extruded along the shore-parallel wave fronts as ONE instanced lattice
 *                strip mesh: (segments + 1) columns x Ns rows per front, instanced per front (High 3, Ultra 5, Medium 2, phones 2; Low none: the sea alone steepens and foams).
 *   Driven by    the existing shore field: the fronts are the level sets of the eikonal travel time at t - (m + delta) Ps, i.e. exactly the crests the sea shader puts its
 *                shore-wave train on; curl amount and height come from the same shoaling ratio the sea shader computes. The sea flattens its own wave under the curl.
 *   Cost         one draw (all fronts), ~1-3 k vertices; CPU: ~0.1 ms (a few thousand grid fetches) per update, every other frame on phones; no extra pass, no screen read.
 *   Look         thin-lip subsurface transmission (thickness baked from the profile -> Beer-Lambert turquoise-to-white, backlit by the sun), refraction-lite (the refracted
 *                ray is intersected with a virtual bed / the sky and samples the baked caustic tile / sky gradient: no scene texture), lace-broken foam at the lip and base.
 *   Governor     DMWaterCore.curlDetail(S.lvl): columns and rows thin out and the translucency steps drop (3 refraction + backlit + lace -> 2 backlit -> 1 flat tint) before
 *                the frame rate does; below ~0.3 the curl is off and the sea's own shore wave takes over again.
 */
(function (root) {
  'use strict';
  const W = root, C = () => W.DMWaterCore;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const rnd = Math.random;

  function create(S, fx) {
    const THREE = W.THREE, T = THREE.TSL, tier = S.tier, core = C(), U = S.U, P = S.P;
    if (!tier.curl || !tier.shore) return null;
    const { float, vec2, vec3, vec4, mix, smoothstep, clamp: tclamp, pow, exp, max, min, dot, normalize, sin, texture, select, attribute, varying, refract, reflect, cameraPosition,
      cameraViewMatrix, faceDirection } = T;
    const Nl = tier.curlSeg, K = tier.curl, NC = core.CURL_NC, lut = core.curlLUT(tier.curlProf, NC), Ns = lut.Ns, NL1 = Nl + 1;
    const cu = { on: 0, trans: 3, seg: 1, prof: 1, built: false, dead: false, count: 0, acc: 0, tick: 0, dir: null, ms: 0 };
    const f2h = THREE.DataUtils.toHalfFloat;

    /* ───────── textures: the profile LUT (static) and the per-front data (rewritten each update) ───────── */
    const lh = new Uint16Array(lut.data.length); for (let i = 0; i < lh.length; i++) lh[i] = f2h(lut.data[i]);
    const lutTex = new THREE.DataTexture(lh, Ns, 2 * NC, THREE.RGBAFormat, THREE.HalfFloatType);
    lutTex.minFilter = lutTex.magFilter = THREE.LinearFilter; lutTex.wrapS = lutTex.wrapT = THREE.ClampToEdgeWrapping; lutTex.generateMipmaps = false; lutTex.colorSpace = THREE.NoColorSpace; lutTex.needsUpdate = true;
    const fdata = new Float32Array(NL1 * 2 * K * 4);
    const frontTex = new THREE.DataTexture(fdata, NL1, 2 * K, THREE.RGBAFormat, THREE.FloatType);
    frontTex.minFilter = frontTex.magFilter = THREE.NearestFilter; frontTex.wrapS = frontTex.wrapT = THREE.ClampToEdgeWrapping; frontTex.generateMipmaps = false; frontTex.colorSpace = THREE.NoColorSpace; frontTex.needsUpdate = true;
    // lip tip (u, y) per curl row: where the spray leaves the wave
    const tipU = new Float32Array(NC), tipY = new Float32Array(NC); for (let r = 0; r < NC; r++) { const a = (r * Ns + lut.cnt.nb + lut.cnt.no - 1) * 4; tipU[r] = lut.data[a]; tipY[r] = lut.data[a + 1]; }

    /* ───────── geometry: one lattice, instanced per front; three index sets (full / half / quarter) ───────── */
    const geo = new THREE.InstancedBufferGeometry(), nV = NL1 * Ns, cuv = new Float32Array(nV * 2);
    for (let i = 0; i < NL1; i++) for (let j = 0; j < Ns; j++) { const v = i * Ns + j; cuv[v * 2] = i; cuv[v * 2 + 1] = j; }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nV * 3), 3)); geo.setAttribute('cuv', new THREE.BufferAttribute(cuv, 2));
    geo.setAttribute('crow', new THREE.InstancedBufferAttribute(Float32Array.from({ length: K }, (_, k) => k), 1));
    const tipI = lut.cnt.nb + lut.cnt.no - 1;
    const mkIndex = (ss, ps) => {
      const js = []; for (let j = 0; j < Ns; j++) if (j % ps === 0 || j === tipI || j === tipI + 1 || j === Ns - 1) js.push(j);
      const idx = []; for (let i = 0; i < Nl; i += ss) for (let k = 0; k < js.length - 1; k++) {
        const a = i * Ns + js[k], b = (i + ss) * Ns + js[k], c = i * Ns + js[k + 1], d = (i + ss) * Ns + js[k + 1];
        idx.push(a, b, c, b, d, c);                                                      // (i,j) (i+1,j) (i,j+1): air side is the front face (see the maths note in core)
      }
      return new THREE.BufferAttribute(nV > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1);
    };
    const idxSets = { '1,1': mkIndex(1, 1), '2,1': mkIndex(2, 1), '2,2': mkIndex(4 > Nl ? 2 : 2, 2), '4,2': mkIndex(4, 2) };
    let idxKey = '1,1'; geo.setIndex(idxSets[idxKey]); geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7); geo.boundingBox = null;

    /* ───────── material ───────── */
    cu.ct = T.uniform(3);
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const aUV = attribute('cuv', 'vec2'), aRow = attribute('crow', 'float');
    const fu = aUV.x.add(0.5).div(NL1), d0 = texture(frontTex, vec2(fu, aRow.mul(2.0).add(0.5).div(2 * K))).level(float(0)), d1 = texture(frontTex, vec2(fu, aRow.mul(2.0).add(1.5).div(2 * K))).level(float(0));
    const Hh = d1.x, cc = tclamp(d1.y, 0.0, 1.0), cr = cc.mul(NC - 1), lx = aUV.y.add(0.5).div(Ns);
    const p0 = texture(lutTex, vec2(lx, cr.add(0.5).div(2 * NC))).level(float(0)), p1 = texture(lutTex, vec2(lx, cr.add(NC + 0.5).div(2 * NC))).level(float(0));
    const wpos = vec3(d0.x.add(d0.z.mul(p0.x).mul(Hh)), p0.y.mul(Hh).sub(Hh.mul(0.04)), d0.y.add(d0.w.mul(p0.x).mul(Hh)));
    const nLocal = normalize(vec3(d0.z.mul(p1.x), p1.y, d0.w.mul(p1.x)));
    const vPos = varying(vec3(wpos.x, 0.0, wpos.z), 'cP'), vThick = varying(p0.z.mul(Hh), 'cT'), vFade = varying(p0.w.mul(smoothstep(0.015, 0.2, cc)).mul(smoothstep(0.02, 0.15, Hh)), 'cF'),
      vN = varying(nLocal, 'cN'), vTip = varying(p1.z, 'cL'), vBase = varying(p1.w, 'cB'), vC = varying(cc, 'cC'), vS = varying(vec2(aUV.x.mul(0.05).add(aRow.mul(0.37)), aUV.y.mul(0.083).add(aUV.x.mul(0.02))), 'cS');
    const pwf = S.pwf && S.pwf.ready && S.pwf.ready() ? S.pwf : null;
    m.positionNode = pwf ? pwf.nodeFor(wpos) : wpos;
    const Nn = normalize(vN.mul(select(faceDirection.greaterThan(0.0), float(1.0), float(-1.0))));
    const V = normalize(cameraPosition.sub(vec3(vPos.x, float(0.0), vPos.z))), nd = max(dot(Nn, V), 0.0), Fr = float(0.03).add(float(0.97).mul(pow(float(1.0).sub(nd), 5.0)));
    const ct = cu.ct, thick = vThick;
    // light through the water: Beer-Lambert with a stylised, stronger coefficient (thin lip = pale, the wall = deep turquoise), scattered turquoise in-light
    const trans = exp(U.absorb.mul(thick.mul(2.6)).negate()), ambient = U.sunUp.mul(0.55).add(0.3), insc = U.scatter.mul(ambient).mul(vec3(1.0).sub(trans)).mul(0.95);
    // refraction-lite: bend the view ray into the wall, hit a virtual bed (the baked caustic tile as the sand ripples) or leave through the lip to the sky
    const r = refract(V.negate(), Nn, 0.752), tB = float(1.7).add(thick).div(max(r.y.negate(), 0.14)), bxz = vec2(vPos.x.add(r.x.mul(tB)), vPos.z.add(r.z.mul(tB)));
    const ca = texture(S.tex.caustic, bxz.mul(0.045).add(vec2(U.time.mul(0.011), U.time.mul(0.007)))).rgb, bedCol = U.shallow.mul(float(0.55).add(ca.mul(0.7))).mul(U.sunUp.mul(0.6).add(0.4));
    const skyR = mix(U.skyHor, U.skyTop, pow(tclamp(r.y, 0.0, 1.0), 0.5)).add(U.sunCol.mul(pow(max(dot(r, U.sunDir), 0.0), 160.0)).mul(5.0).mul(U.sunUp));
    const seenFull = mix(bedCol, skyR, smoothstep(-0.06, 0.12, r.y)), seenFlat = mix(U.deep.mul(0.8), U.shallow, 0.5).mul(ambient);
    const seen = select(ct.greaterThan(2.5), seenFull, seenFlat);
    const back = U.sunCol.mul(U.scatter).mul(pow(tclamp(dot(V, U.sunDir.negate()), 0.0, 1.0), 2.5)).mul(U.sunUp).mul(exp(thick.mul(-1.3))).mul(1.7).mul(select(ct.greaterThan(1.5), float(1.0), float(0.0)));
    const Rr = reflect(V.negate(), Nn), skyC = mix(U.skyHor, U.skyTop, pow(tclamp(Rr.y, 0.0, 1.0), 0.45)), refl = skyC.mul(Fr).mul(P.sky);
    // foam: the lip's edge and the base of the wall, broken by the baked lace tile (a lace-free flat fringe at translucency step 1)
    const lace = texture(S.tex.detail, vS.add(vec2(U.time.mul(0.013), U.time.mul(-0.007)))).x, laceW = select(ct.greaterThan(1.5), lace, float(0.55));
    const fm = tclamp(vTip.mul(smoothstep(0.2, 0.9, vC)).mul(1.1).add(vBase.mul(0.75).mul(smoothstep(0.1, 0.7, vC))), 0.0, 1.3), foamA = smoothstep(0.3, 0.75, fm.mul(float(0.4).add(laceW.mul(0.95))));
    const foamC = U.foamCol.mul(U.sunUp.mul(0.5).add(0.5)).add(U.sunCol.mul(0.12).mul(U.sunUp));
    const through = seen.mul(trans).add(insc);
    m.colorNode = vec3(0.02, 0.05, 0.05);
    m.emissiveNode = mix(through.add(back).add(refl), foamC, foamA).add(U.glowCol.mul(U.glow).mul(U.night).mul(0.5).mul(foamA.add(0.2)));
    const lipSoft = smoothstep(0.0, 0.07, thick.add(laceW.sub(0.5).mul(0.05)));                      // the lip dissolves into a soft translucent edge
    m.opacityNode = tclamp(mix(float(0.62), float(0.95), smoothstep(0.0, 0.5, thick)).mul(vFade).mul(mix(float(0.35), float(1.0), lipSoft)).add(foamA.mul(0.45).mul(vFade)), 0.0, 1.0).mul(select(faceDirection.greaterThan(0.0), float(1.0), float(0.4)));
    m.roughnessNode = mix(float(0.05), float(0.7), foamA); m.metalnessNode = float(0.0);
    m.normalNode = pwf ? normalize(cameraViewMatrix.mul(vec4(pwf.rotN(vec3(vPos.x, float(0.0), vPos.z), Nn), 0.0)).xyz) : normalize(cameraViewMatrix.mul(vec4(Nn, 0.0)).xyz);
    m.fog = true;
    const mesh = new THREE.Mesh(geo, m); mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.visible = false; mesh.name = 'dmWaterCurl';

    /* ───────── per-update: find the fronts, fill the data texture ───────── */
    const scratch = core.curlScratch(K, Nl), PT = core.CURL_PT;
    const Ps = Math.sqrt(2 * Math.PI * P.lamS / P.g), H0 = Math.max(0.3, P.HsS * 0.9), spacing = tier.name === 'medium' ? 5.0 : tier.mobile ? 4.2 : tier.name === 'ultra' ? 3.2 : 3.6;
    function waveDir(sh) {                                       // mean travel direction of the shore waves around the focus (unit grad T where there is water to shoal in)
      const f = S.focus, N = sh.N, cell = sh.cell, x0 = sh.cx - sh.R + cell * 0.5, z0 = sh.cz - sh.R + cell * 0.5; let sx = 0, sz = 0, w = 0;
      for (let a = 0; a < 12; a++) {
        const ang = a / 12 * Math.PI * 2, rr = a % 2 ? 14 : 30, x = f[0] + Math.cos(ang) * rr, z = f[1] + Math.sin(ang) * rr, d = core.gridSample(sh.depth, N, cell, x0, z0, x, z); if (d < 0.2 || d > 60) continue;
        const e = cell * 0.8, gx = core.gridSample(sh.T, N, cell, x0, z0, x + e, z) - core.gridSample(sh.T, N, cell, x0, z0, x - e, z), gz = core.gridSample(sh.T, N, cell, x0, z0, x, z + e) - core.gridSample(sh.T, N, cell, x0, z0, x, z - e);
        if (Math.abs(gx) > 1e8 || Math.abs(gz) > 1e8) continue; const l = Math.hypot(gx, gz); if (l < 1e-5) continue; const k = 1 / (1 + d * 0.05); sx += gx / l * k; sz += gz / l * k; w += k;
      }
      if (w < 0.01) return cu.dir; const l = Math.hypot(sx, sz) || 1, nd = [sx / l, sz / l];
      if (!cu.dir) cu.dir = nd; else { const a = 0.15; let dx = cu.dir[0] * (1 - a) + nd[0] * a, dz = cu.dir[1] * (1 - a) + nd[1] * a; const dl = Math.hypot(dx, dz) || 1; cu.dir = [dx / dl, dz / dl]; }
      return cu.dir;
    }
    function setIndex(seg, prof) { const k = seg + ',' + prof; if (k === idxKey) return; idxKey = k; geo.setIndex(idxSets[k] || idxSets['1,1']); }
    function update(dt, ctx) {
      const det = core.curlDetail(S.lvl, tier), sh = S.shore;
      cu.seg = det.seg; cu.prof = det.prof; cu.trans = det.trans; cu.ct.value = det.trans; setIndex(det.seg, det.prof);
      const ok = det.on && sh && sh.has && sh.depth && sh.T && S.ready >= 1;
      if (!ok || S.under > 0.5) { mesh.visible = false; geo.instanceCount = 0; U.curlOn.value = 0; cu.count = 0; return; }
      const dir = waveDir(sh); if (!dir) { mesh.visible = false; U.curlOn.value = 0; return; }
      const t0 = W.performance ? W.performance.now() : 0, cell = sh.cell;
      const field = { N: sh.N, cell, x0: sh.cx - sh.R + cell * 0.5, z0: sh.cz - sh.R + cell * 0.5, depth: sh.depth, T: sh.T };
      const cnt = core.curlFronts(field, { t: S.t, Ps, delta: 0.03, lamS: P.lamS, H0, dir, focus: S.focus, n: Nl, spacing, reach: Math.min(sh.R * 0.9, 85), maxFronts: K, hScale: 1.0, cMax: 1 }, scratch);
      fdata.fill(0);
      for (let k = 0; k < cnt; k++) {
        const F = scratch.fronts[scratch.order[k]], pts = F.pts;
        // columns with no crossing keep the position of the nearest good column (height 0): a sliver to (0,0) would otherwise streak across the sea
        let last = -1; for (let i = 0; i < NL1; i++) { if (pts[i * PT + 7]) last = i; else if (last >= 0) { for (let q = 0; q < 4; q++) pts[i * PT + q] = pts[last * PT + q]; } }
        last = -1; for (let i = NL1 - 1; i >= 0; i--) { if (pts[i * PT + 7]) last = i; else if (last >= 0 && !pts[i * PT] && !pts[i * PT + 1]) { for (let q = 0; q < 4; q++) pts[i * PT + q] = pts[last * PT + q]; } }
        for (let i = 0; i < NL1; i++) {
          const b = i * PT, a0 = (2 * k * NL1 + i) * 4, a1 = ((2 * k + 1) * NL1 + i) * 4, c = pts[b + 5];
          fdata[a0] = pts[b]; fdata[a0 + 1] = pts[b + 1]; fdata[a0 + 2] = pts[b + 2]; fdata[a0 + 3] = pts[b + 3];
          fdata[a1] = c > 0.01 ? pts[b + 4] : 0; fdata[a1 + 1] = c; fdata[a1 + 2] = pts[b + 6]; fdata[a1 + 3] = pts[b + 7];
        }
      }
      frontTex.needsUpdate = true; cu.count = cnt; geo.instanceCount = cnt; mesh.visible = cnt > 0; U.curlOn.value = 1;
      mesh.position.set(0, S.mesh ? S.mesh.position.y : 0, 0);
      if (W.DMPerf && W.performance) { cu.ms = W.performance.now() - t0; W.DMPerf.mark('water.curl', cu.ms); }
    }
    // spray off the lip of the curling fronts (the existing pool: droplets that fall back in die; a few mist puffs)
    function lipSpray(dt) {
      if (!fx.sprayAt || !cu.count) return;
      const hang = P.spray.hang || 1, g = (P.spray.g || 17.5), by = (S.mesh ? S.mesh.position.y : 0), mob = tier.mobile ? 0.5 : 1;
      for (let k = 0; k < cu.count; k++) {
        const F = scratch.fronts[scratch.order[k]], pts = F.pts; let nEm = F.sumC * 0.9 * mob * dt * (tier.name === 'ultra' ? 1.3 : 1); cu.acc += nEm;
        let tries = 0; while (cu.acc >= 1 && tries++ < 6) {
          cu.acc -= 1; const i = (rnd() * (NL1 - 1)) | 0, b = i * PT, c = pts[b + 5]; if (c < 0.45) continue;
          const row = clamp(c, 0, 1) * (NC - 1), r0 = Math.floor(row), r1 = Math.min(NC - 1, r0 + 1), f = row - r0, tu = tipU[r0] + (tipU[r1] - tipU[r0]) * f, ty = tipY[r0] + (tipY[r1] - tipY[r0]) * f, H = pts[b + 4];
          const x = pts[b] + pts[b + 2] * tu * H, z = pts[b + 1] + pts[b + 3] * tu * H, y = by + ty * H, sp = 1.1 + rnd() * 1.6, up = (0.2 + rnd() * 1.6) * Math.sqrt(g / 17.5);
          fx.sprayAt(x, y, z, pts[b + 2] * sp + (rnd() - 0.5) * 0.5, up, pts[b + 3] * sp + (rnd() - 0.5) * 0.5, 0.5 + rnd() * 0.6, (0.45 + rnd() * 0.45) * hang, rnd() < 0.82 ? 3 : 0, (rnd() - 0.5) * 0.4);
          if (rnd() < 0.18) fx.sprayAt(x, y + 0.2, z, pts[b + 2] * 0.5, 0.4, pts[b + 3] * 0.5, 2.2 + rnd() * 1.6, (1.0 + rnd() * 0.8) * hang, 2, rnd() * 6.283);
        }
      }
      if (cu.acc > 3) cu.acc = 3;
    }
    cu.build = (scene) => { if (cu.built || !scene) return; cu.built = true; scene.add(mesh); };
    cu.tick = (dt, ctx) => {
      if (cu.dead) return; cu.fr = (cu.fr || 0) + 1;
      if (!tier.mobile || (cu.fr & 1) === 0) update(dt, ctx);
      lipSpray(dt);
    };
    cu.status = () => ({ on: U.curlOn.value, fronts: cu.count, seg: cu.seg, prof: cu.prof, trans: cu.trans, ms: +cu.ms.toFixed(3), verts: nV, rows: Ns, cols: NL1 });
    cu.dispose = () => { cu.dead = true; try { if (mesh.parent) mesh.parent.remove(mesh); geo.dispose(); m.dispose(); lutTex.dispose(); frontTex.dispose(); } catch (e) { } U.curlOn.value = 0; };
    cu.mesh = mesh; cu.lut = lut;
    return cu;
  }

  W.DMWaterCurl = { create };
})(typeof window !== 'undefined' ? window : globalThis);
