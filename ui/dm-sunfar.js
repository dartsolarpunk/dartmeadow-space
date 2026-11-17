/* DMSunFar (t1537) — the sun's WIDE, slow shadow layer: a second, low-cadence depth map of the key light (rocks, architecture, terrain, canopies) that
 * takes over where the crisp near map (TERRAIN.sun's own shadow, eased out inside its box by DMLight's U.sm band) ends, and fades into the haze.
 *
 *   No second light: this is a depth pass of the existing key light's direction (index.html passes the same `up` vector the near map uses, from
 *   _pwKeyDir() / DMStars), read by DMLight's sun-shadow wrapper (ui/dm-light.js) through node(): mix(far, near, wMap) instead of mix(1, near, wMap),
 *   so a roofed deck or a cliff overhang stays in shadow past the near box (the old "lit ring" past U.sm is gone on every tier, not just pushed out).
 *   Because the far layer carries the shadow past the near box, the on-foot near box can be TIGHT again (DMPolish.TIGHT_FAR = 0.62x when covers()):
 *   Low's 512 near map gets its ~1.6x texel density back without a second per-frame pass.
 *
 *   Cost model: ONE depth-only pass (scene.overrideMaterial, the casters' own positionNode / alpha test ride along; layer-filtered to castShadow meshes
 *   inside the box; the character / board are excluded: they move, the near map draws them) and only when the snapped centre moves (box/8), the key
 *   direction turns > 0.35 deg or 20 s pass — never more often than the tier's minS (x the budget ladder's shadow cadence). Standing still: ~0 passes.
 *   Receivers: a uniform branch (only past the near band, only when a map is live) with 4 (Low) / 5 taps of a manual PCF.  No per-frame allocation.
 *
 *   (t1537b) Displaced casters: r185's override carries positionNode / displacementMap / alphaTest (the planet bend, rocks), vertexNode / allowOverride=false
 *   materials are left out of the layer (their shape can't ride along); receivers are moved back into the pass's planet frame (core.bendDy: the frame
 *   re-centres every frame, the map is seconds old), and the depth bias is slope-scaled (core.slopeBias) for steep terrain.  Colour attachment R8.
 *
 *   ?sunfar=0 off (back to #269's lit-past-the-box + full box)   ?sunfar=<512|1024|1536|2048> map size   DMSunFar.status() for numbers.
 */
(function () {
  'use strict';
  const W = typeof window !== 'undefined' ? window : globalThis;
  const Q = (W.location && W.location.search) || '';
  const fq = (Q.match(/[?&]sunfar=(0|off|1|512|1024|1536|2048)\b/) || [])[1];
  const LAYER = 29;
  // per DMLight tier: map side, box half (u), min seconds between passes, PCF taps, receiver fade (fractions of half)
  const TIERS = {
    low:   { size: 1024, half: 110, minS: 1.5, taps: 4 },
    med:   { size: 1024, half: 170, minS: 1.0, taps: 5 },
    high:  { size: 1536, half: 260, minS: 0.7, taps: 5 },
    ultra: { size: 2048, half: 360, minS: 0.5, taps: 5 },
  };
  const FADE = [0.78, 0.95];          // the far layer is gone by 0.95 half (inside its square: no edge), into the haze
  const SNAP = 0.125;                 // centre grid = half x SNAP: a pass only when she crosses a cell
  const TURN_COS = Math.cos(0.35 * Math.PI / 180), MAX_AGE = 20000;
  const COVER = 0.42;                 // covers() while the focus is within 0.42 half of the map centre (the near box + its band always inside)

  // ── pure core (tools/tests/sun-far.js) ──
  // (t1590) what each tier does with the layer.  0 = off (no pass), 1 = the pass for the volumetric sun shafts only (ui/dm-vlight.js visAt) with NO receivers, 2 = the pass plus
  // receivers on ARCHITECTURE / overhangs (decks, roofs, the mansion: #271's covered-floor shadows).  Open terrain never receives it on any tier (ui/dm-light.js o.terrain): its
  // slope-biased 4-5 tap compare on faceted far tiles shadowed most of the ground and lit the crests (the dark-red / beige blocks and rings of Justin's v348 Mars shots, t1590).
  // Phones / tablets: off (Perf t1590: one depth pass + taps per pixel on the worst devices).  ?sunfar=1 forces mode 2 on every tier / device (A/B).
  const MODE = { low: 0, med: 1, high: 2, ultra: 2 };
  function mode(t, mobile) { if (!TIERS[t]) return 0; if (fq === '1') return 2; return mobile ? 0 : (MODE[t] | 0); }
  function tierCfg(t, mobile) { const c = TIERS[t]; if (!c) return null; const md = mode(t, !!mobile); if (!md) return null; const o = { size: c.size, half: c.half, minS: c.minS, taps: c.taps, recv: md >= 2 }; if (fq && +fq >= 512) o.size = +fq; return o; }
  function snap(v, step) { return Math.round(v / step) * step; }
  // st: { valid, cx, cz, dx, dy, dz, t }  -> 0 none, 1 = needed and allowed now, 2 = needed but held back by the cadence
  function need(st, half, minMs, fx, fz, dx, dy, dz, now) {
    const step = half * SNAP, cx = snap(fx, step), cz = snap(fz, step);
    if (!st.valid) return 1;
    const moved = cx !== st.cx || cz !== st.cz, turned = (dx * st.dx + dy * st.dy + dz * st.dz) < TURN_COS, old = now - st.t > MAX_AGE;
    if (!(moved || turned || old)) return 0;
    return now - st.t >= minMs ? 1 : 2;
  }
  function coversAt(st, half, fx, fz) { return !!st.valid && Math.abs(fx - st.cx) <= half * COVER && Math.abs(fz - st.cz) <= half * COVER; }
  function memBytes(size, r8) { return size * size * ((r8 === false ? 4 : 1) + 4); }   // the (unused) colour attachment the target needs: R8 (1 B; RGBA8 4 B on the fallback) + 32-bit float depth (4 B)
  // (t1537b) the planet frame re-centres on the focus every frame, the far map is minutes-old by comparison: a receiver drawn round today's focus Fc
  // sits higher than it was drawn round the pass's Fp by (2 s.d + |d|^2) / 2R  (s = p.xz - Fc, d = Fc - Fp; the drop of a flat point at offset s is |s|^2 / 2R).
  // Moving the receiver by that before the lookup puts it back in the frame the casters were drawn in (first order; horizontal terms are 2nd order).
  function bendDy(px, pz, fcx, fcz, fpx, fpz, iR) { const sx = px - fcx, sz = pz - fcz, dx = fcx - fpx, dz = fcz - fpz; return -(sx * dx + sz * dz + 0.5 * (dx * dx + dz * dz)) * iR; }
  // (t1537b) casters whose shape the override can't carry: three r185 copies positionNode / displacementMap / alphaTest onto scene.overrideMaterial
  // (Renderer._renderObjectDirect), so planet-bent and displaced meshes are fine; a vertexNode (view-space billboards) or allowOverride = false is not
  function shapeLost(m) { if (!m) return false; if (Array.isArray(m)) { for (let i = 0; i < m.length; i++) if (shapeLost(m[i])) return true; return false; } return !!(m.vertexNode || m.allowOverride === false || m.isShaderMaterial || m.isRawShaderMaterial); }
  // slope-scaled depth bias (steep terrain: a grazing receiver spans tan x a texel of depth inside one texel): bias + SLOPE x texel(u) x tan / range, tan clamped
  const SLOPE = 0.6, TAN_MAX = 4;
  function slopeK(half, size, range) { return SLOPE * (2 * half / size) / range; }
  function slopeBias(bias, ndl, k) { const c = Math.max(0.2, Math.min(1, Math.abs(ndl))), t = Math.min(TAN_MAX, Math.sqrt(1 - c * c) / c); return bias + k * t; }
  const core = { TIERS, MODE, mode, FADE, SNAP, TURN_COS, MAX_AGE, COVER, LAYER, SLOPE, TAN_MAX, slopeK, tierCfg, snap, need, coversAt, memBytes, bendDy, shapeLost, slopeBias };

  const S = { on: fq !== '0' && fq !== 'off', tier: '', cfg: null, U: null, rt: null, cam: null, mat: null, dt: null, built: false, valid: false,
    cx: 0, cy: 0, cz: 0, dx: 0, dy: 1, dz: 0, t: -1e9, passes: 0, held: 0, ms: 0, msMax: 0, casters: 0, err: '', fx: 0, fz: 0, ok: false };
  const D = W.DMSunFar = { core, S, on: S.on, hooks: { skip: null, bend: null } };

  // the shared uniforms + target, made once at the first material that asks (DMLight passes its tier)
  function ensure(THREE, T, tier) {
    if (S.built) return !!S.U;
    const c = tierCfg(tier, !!(W.GFX && W.GFX.isMobile)); if (!c) return false;   // tier not known yet / off: ask again later (nothing latched)
    S.built = true;
    try {
      if (!S.on || !THREE || !T || !THREE.DepthTexture || !THREE.OrthographicCamera) return false;
      const G = W.GFX; if (G && !G.shadows) return false;   // no sun shadows at all: nothing to extend
      S.cfg = c; S.tier = tier;
      // colour attachment R8 (nothing is written to it: colorWrite off) instead of RGBA8: 1024^2 = 5 MB instead of 8 MB; RGBA8 if the build has no RedFormat
      const r8 = !!THREE.RedFormat; S.r8 = r8;
      const rt = new (THREE.RenderTarget || THREE.WebGLRenderTarget)(c.size, c.size, r8 ? { depthBuffer: true, stencilBuffer: false, format: THREE.RedFormat, type: THREE.UnsignedByteType } : { depthBuffer: true, stencilBuffer: false });
      const dt = new THREE.DepthTexture(c.size, c.size); dt.type = THREE.FloatType; dt.minFilter = dt.magFilter = THREE.NearestFilter;
      rt.depthTexture = dt; rt.texture.generateMipmaps = false;
      const cam = new THREE.OrthographicCamera(-c.half, c.half, c.half, -c.half, 1, c.half * 4.4); cam.layers.set(LAYER);
      const mat = new (THREE.MeshBasicNodeMaterial || THREE.MeshBasicMaterial)(); mat.colorWrite = false; mat.fog = false; mat.side = THREE.DoubleSide; mat.name = 'dm_sunfar_depth';
      const u = T.uniform;
      S.U = { M: u(new THREE.Matrix4()), half: u(c.half), near: u(1), range: u(c.half * 4.4 - 1), on: u(0), c: u(new THREE.Vector2(0, 0)), fd: u(new THREE.Vector2(c.half * FADE[0], c.half * FADE[1])),
        texel: u(1 / c.size), bias: u(0.0009), nb: u(2 * c.half / c.size * 0.9), pcf: u(1.25),
        L: u(new THREE.Vector3(0, 1, 0)), Fc: u(new THREE.Vector2(0, 0)), Fp: u(new THREE.Vector2(0, 0)), iR: u(0), sb: u(slopeK(c.half, c.size, c.half * 4.4 - 1)) };
      S.rt = rt; S.dt = dt; S.cam = cam; S.mat = mat;
      return true;
    } catch (e) { S.err = 'ensure: ' + (e && e.message || e); S.U = null; return false; }
  }

  // core.bendDy as a node (uniforms: Fc = this frame's planet-frame focus, Fp = the pass's, iR = 1/R while the frame is bent, 0 flat)
  function bendN(T, U, p) { const sx = p.x.sub(U.Fc.x), sz = p.z.sub(U.Fc.y), dx = U.Fc.x.sub(U.Fp.x), dz = U.Fc.y.sub(U.Fp.y);
    return sx.mul(dx).add(sz.mul(dz)).add(dx.mul(dx).add(dz.mul(dz)).mul(0.5)).mul(U.iR).negate(); }

  // receiver node: 1 = lit by the key light, 0 = in the far layer's shadow. p world position, n world normal, wMap the near map's weight (skip where 1).
  D.node = function (T, p, n, wMap, tier) {
    const THREE = W.THREE; if (!ensure(THREE, T, tier) || !T.Fn || !T.If) return null;
    if (!S.cfg || !S.cfg.recv) return null;   // (t1590) shafts-only tier (Medium): no receivers
    try {
      const U = S.U, { Fn, float, vec2, vec3, vec4, texture, step, smoothstep, length, mix, dot, abs, clamp, sqrt, min } = T, tex = S.dt, taps = S.cfg.taps;
      return Fn(() => {
        const v = float(1).toVar();
        T.If(U.on.greaterThan(0.5).and(wMap.lessThan(0.999)), () => {
          const q = p.add(n.mul(U.nb)).add(vec3(0, bendN(T, U, p), 0)), vp = U.M.mul(vec4(q, 1.0)).xyz;
          const uv = vec2(vp.x.div(U.half).mul(0.5).add(0.5), float(0.5).sub(vp.y.div(U.half).mul(0.5)));   // top-left origin (three flips per backend)
          const cl = clamp(abs(dot(n, U.L)), 0.2, 1.0), tn = min(sqrt(float(1).sub(cl.mul(cl))).div(cl), TAN_MAX);   // slope-scaled bias (core.slopeBias)
          const ref = vp.z.negate().sub(U.near).div(U.range).sub(U.bias.add(U.sb.mul(tn))), r = U.texel.mul(U.pcf);
          const tap = (ox, oy) => step(ref, texture(tex, uv.add(vec2(ox, oy).mul(r))).r);
          let s = taps >= 5 ? tap(0, 0) : float(0);
          s = s.add(tap(-0.6, -1.0)).add(tap(1.0, -0.6)).add(tap(0.6, 1.0)).add(tap(-1.0, 0.6));
          s = s.div(taps >= 5 ? 5 : 4);
          const inBox = float(1).sub(step(1.0, vp.x.abs().div(U.half).max(vp.y.abs().div(U.half))));
          const fade = smoothstep(U.fd.x, U.fd.y, length(vec2(p.x.sub(U.c.x), p.z.sub(U.c.y))));
          v.assign(mix(float(1), s, inBox.mul(float(1).sub(fade))));
        });
        return v;
      })();
    } catch (e) { S.err = 'node: ' + (e && e.message || e); return null; }
  };

  // (item 3) one hard tap at a world point q (the volumetric sun shafts in ui/dm-vlight.js march a few of these along the view ray): 1 outside the box / no live map
  D.visAt = function (T, q, tier) {
    // the fog node is built when the world scene is made, before DMLight has picked its tier on the first walk tick: guess the same way DMLight does
    let tt = tier || (W.DMLight && W.DMLight.on && W.DMLight.tier);
    if (!TIERS[tt]) { try { const L = W.DMLight, c = L && L.core; tt = c && c.pickTier ? c.pickTier(W.GFX || {}, null) : 'med'; if (c && c.capTier && c.presetCap && W.GFX) tt = c.capTier(tt, c.presetCap(W.GFX.resolved || W.GFX.preset, !!W.GFX.isMobile)); } catch (e) { tt = 'med'; } }
    const THREE = W.THREE; if (!ensure(THREE, T, tt)) return null;
    try {
      const U = S.U, { float, vec2, vec3, vec4, texture, step, mix } = T, vp = U.M.mul(vec4(q.add(vec3(0, bendN(T, U, q), 0)), 1.0)).xyz;
      const uv = vec2(vp.x.div(U.half).mul(0.5).add(0.5), float(0.5).sub(vp.y.div(U.half).mul(0.5)));
      const ref = vp.z.negate().sub(U.near).div(U.range).sub(U.bias.mul(2.0));
      const inBox = float(1).sub(step(0.97, vp.x.abs().div(U.half).max(vp.y.abs().div(U.half))));
      return mix(float(1), step(ref, texture(S.dt, uv).r), inBox.mul(U.on));
    } catch (e) { S.err = 'visAt: ' + (e && e.message || e); return null; }
  };

  // caster layer: castShadow meshes inside the box, minus the moving ones (her, the board: the near map has them)
  const _c = { x: 0, z: 0, r: 0, n: 0 };
  function skipped(o) { const hk = D.hooks.skip; for (let a = o; a; a = a.parent) { if (a.userData && a.userData.dmFarSkip) return true; if (hk && hk(a)) return true; } return false; }
  function tag(o) {
    if (!(o.isMesh || o.isInstancedMesh)) return;
    let on = !!o.castShadow && !o.isSkinnedMesh && !o.isSprite && !shapeLost(o.material);
    if (on && !o.isInstancedMesh) {
      const g = o.geometry; if (g && !g.boundingSphere && g.computeBoundingSphere) { try { g.computeBoundingSphere(); } catch (e) { } }
      const bs = g && g.boundingSphere, e = o.matrixWorld.elements;
      if (bs) { const sx = Math.hypot(e[0], e[1], e[2]), sz = Math.hypot(e[8], e[9], e[10]), rr = bs.radius * Math.max(sx, sz, Math.hypot(e[4], e[5], e[6]));
        const wx = e[12] + e[0] * bs.center.x + e[4] * bs.center.y + e[8] * bs.center.z, wz = e[14] + e[2] * bs.center.x + e[6] * bs.center.y + e[10] * bs.center.z;
        if (Math.abs(wx - _c.x) > _c.r + rr || Math.abs(wz - _c.z) > _c.r + rr) on = false; }
    }
    if (on && skipped(o)) on = false;
    if (on) { o.layers.enable(LAYER); _c.n++; } else o.layers.disable(LAYER);
  }

  // per frame (index.html _pwWorldTick, after the near box fit): dir = the key light's unit direction (towards the light), f = focus
  D.tick = function (renderer, scene, dir, fx, fy, fz) {
    const U = S.U; S.fx = fx; S.fz = fz;
    if (!U || !renderer || !scene) { S.ok = false; return false; }
    let bf = null; try { const hb = D.hooks.bend; bf = hb ? hb() : null; } catch (e) { bf = null; }
    const bent = !!(bf && bf.u && bf.on && bf.R > 0); if (bent) U.Fc.value.copy(bf.u.f.value); else U.iR.value = 0;   // the receivers' frame this frame
    if (!dir || dir.y < 0.04) { U.on.value = 0; S.valid = false; S.ok = false; return false; }   // key light down / grazing: the near map + DMLight carry dusk
    const c = S.cfg, now = (W.performance ? W.performance.now() : Date.now());
    let minMs = c.minS * 1000; try { const B = W.DMBudget; if (B && B.on) { const ev = B.shadowEvery ? B.shadowEvery() : 1; if (ev > 1) minMs *= ev; if (B.shadowHalf && B.shadowHalf() && S.valid) minMs = Math.max(minMs, 8000); } } catch (e) { }
    const k = need(S, c.half, minMs, fx, fz, dir.x, dir.y, dir.z, now);
    if (k === 2) S.held++;
    if (k === 1) {
      const t0 = now;
      try {
        const step = c.half * SNAP, cx = snap(fx, step), cz = snap(fz, step), cy = fy, dist = c.half * 2.2, cam = S.cam;
        cam.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist); cam.up.set(0, 1, 0); if (Math.abs(dir.y) > 0.999) cam.up.set(0, 0, 1);
        cam.lookAt(cx, cy, cz); cam.near = 1; cam.far = dist * 2; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
        _c.x = cx; _c.z = cz; _c.r = c.half * 1.05; _c.n = 0; scene.traverse(tag); S.casters = _c.n;
        const prevRT = renderer.getRenderTarget ? renderer.getRenderTarget() : null, prevOv = scene.overrideMaterial, prevBg = scene.background;
        scene.overrideMaterial = S.mat; scene.background = null;
        try { renderer.setRenderTarget(S.rt); renderer.render(scene, cam); }
        finally { renderer.setRenderTarget(prevRT); scene.overrideMaterial = prevOv; scene.background = prevBg; }
        U.M.value.copy(cam.matrixWorldInverse); U.near.value = cam.near; U.range.value = cam.far - cam.near; U.c.value.set(cx, cz);
        U.L.value.set(dir.x, dir.y, dir.z); U.Fp.value.copy(U.Fc.value); U.iR.value = bent ? 1 / bf.R : 0;   // the frame the casters were drawn in
        S.cx = cx; S.cy = cy; S.cz = cz; S.dx = dir.x; S.dy = dir.y; S.dz = dir.z; S.t = now; S.valid = true; S.passes++;
        const ms = (W.performance ? W.performance.now() : Date.now()) - t0; S.ms = S.ms ? S.ms * 0.7 + ms * 0.3 : ms; if (ms > S.msMax) S.msMax = ms;
      } catch (e) { S.err = 'pass: ' + (e && e.message || e); S.valid = false; }
    }
    U.on.value = S.valid ? 1 : 0;
    S.ok = S.valid; return S.valid;
  };
  // the far layer covers the ground round the focus right now (DMPolish tightens the near box only then)
  D.covers = function () { return !!S.U && S.ok && !!S.cfg.recv && coversAt(S, S.cfg.half, S.fx, S.fz); };   // (t1590) only where it RECEIVES: a shafts-only pass keeps #269's full near box (DMPolish TIGHT_K)
  D.reset = function () { S.valid = false; S.ok = false; if (S.U) S.U.on.value = 0; };
  D.status = function () { const c = S.cfg; return { on: S.on, tier: S.tier, recv: !!(c && c.recv), size: c ? c.size : 0, half: c ? c.half : 0, live: S.valid, covers: D.covers(), passes: S.passes, held: S.held, ms: +S.ms.toFixed(2), msMax: +S.msMax.toFixed(2), casters: S.casters, MB: c ? +(memBytes(c.size, S.r8) / 1048576).toFixed(1) : 0, r8: !!S.r8, bend: S.U ? +S.U.iR.value.toExponential(2) : 0, err: S.err }; };
  D.dispose = function () { try { if (S.rt) S.rt.dispose(); if (S.dt) S.dt.dispose(); if (S.mat) S.mat.dispose(); } catch (e) { } };
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})();
