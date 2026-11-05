/* DART Meadow — water (runtime half): the baked sea, its material, the shore field and the ground hook. Pure maths lives in ui/dm-water-core.js.
 *
 * Where it plugs in (index.html):  DMWater.begin() beside DMGround.beginWorld  ·  _shoreWaterMaterial() asks DMWater.material() first (old shader stays as the fallback)
 *   ·  the sea sheet takes DMWater.attachSea() (clip-map grid)  ·  _pwSeaFollow -> DMWater.follow()  ·  DMWater.tick() once per world frame (replaces updateCaustics' CPU texture)
 *   ·  _terrainDetailMat ends with DMWater.receiveShore() (wet sand, swash film)  ·  world close -> DMWater.end().  ui/dm-water-fx.js adds spray / wake / curl / underwater.
 *
 * COST MODEL (the frame rate is the budget):
 *   bake    : 1-3 band tiles + detail + caustic tile, CPU, ONCE per world, 2-3 ms slices (DMWaterCore generators), RGBA8 + mips, 0.1-1.1 MB by tier
 *   per frame, CPU : ~6 vec4 + 6 vec2 uniform writes, a governor probe, the shore field slice (<= 0.8 ms, only near a coast, only every few seconds)
 *   per pixel      : 2 taps x (1-3) bands + 2 detail + 1 shore + (caustic: 2 taps, shallow only) - no noise functions, no loops (ripples: a real branch)
 *   per vertex     : (High/Ultra, within ~110-140 u of the camera) 2 bands x 2 layers x 3 morph evaluations of one RGBA fetch; 0 elsewhere
 *   uniforms-only governor (render scale from ui/dm-governor.js + a frame-time probe) lowers band weights / displacement / pools without recompiling.
 * Flags: ?water=0 off (the old sea) · ?water=low|medium|high|ultra forces a tier · ?waterfx=0 no spray/wake/curl · ?waterdbg=1 breadcrumb logging.
 */
(function (root) {
  'use strict';
  const W = root, Q = (() => { try { return W.location.search || ''; } catch (e) { return ''; } })();
  const FLAG_OFF = /[?&]water=0\b/.test(Q), FORCE = (Q.match(/[?&]water=(low|medium|high|ultra)\b/) || [])[1] || null, DBG = /[?&]waterdbg=1\b/.test(Q);
  const C = () => W.DMWaterCore;
  const now = () => (W.performance && W.performance.now ? W.performance.now() : Date.now());
  const crumb = (m, n, i) => { try { W.DMCrumb && W.DMCrumb[m](n, i); } catch (e) { } };
  const log = (...a) => { if (DBG) { try { console.info('[water]', ...a); } catch (e) { } } };
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  const S = {
    on: false, failed: false, active: false, tier: null, P: null, spec: null, model: null, tex: null, U: null, job: null, jobMs: 0, t: 0, ready: 0, bakeWall: 0, t0: 0, epoch: 0,
    lvl: 1, lvlT: 0, slow: 0, fast: 0, ema: 16.7, under: 0, mesh: null, geo: null, seaSpan: 0, focus: [0, 0], shore: null, mats: 0, body: null, pal: null, opts: null, seed: 0
  };
  const isMobile = () => { try { return !!(W.GFX && W.GFX.isMobile); } catch (e) { return false; } };
  function presetName() { try { const p = (typeof W.resolvePreset === 'function') ? W.resolvePreset() : 'medium'; return p === 'custom' || p === 'auto' ? 'medium' : p; } catch (e) { return 'medium'; } }

  /* ───────────────────────── textures ───────────────────────── */
  function mkTex(THREE, data, w, h, mips) {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.generateMipmaps = !!mips; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; return t;
  }
  function allocTextures(THREE, tier, spec) {
    const tex = { bands: [], data: [], detail: null, detailData: null, caustic: null, causticData: null, shore: null, shoreData: null, bytes: 0 };
    spec.bands.forEach((b) => {
      const d = new Uint8Array(b.T * b.T * 4); for (let i = 0; i < b.T * b.T; i++) { d[i * 4] = 128; d[i * 4 + 1] = 128; d[i * 4 + 2] = 128; d[i * 4 + 3] = 0; d[i * 4 + 3] = 0; }
      tex.data.push(d); tex.bands.push(mkTex(THREE, d, b.T, b.T, true)); tex.bytes += b.T * b.T * 4 * 1.34;
    });
    const dT = tier.detailT; tex.detailData = new Uint8Array(dT * dT * 4); for (let i = 0; i < dT * dT; i++) { tex.detailData[i * 4] = 110; tex.detailData[i * 4 + 1] = 90; tex.detailData[i * 4 + 2] = 128; tex.detailData[i * 4 + 3] = 128; }
    tex.detail = mkTex(THREE, tex.detailData, dT, dT, true); tex.bytes += dT * dT * 4 * 1.34;
    const cT = tier.causticT || 8; tex.causticData = new Uint8Array(cT * cT * 4); for (let i = 0; i < cT * cT; i++) { tex.causticData[i * 4] = tex.causticData[i * 4 + 1] = tex.causticData[i * 4 + 2] = 60; tex.causticData[i * 4 + 3] = 255; }
    tex.caustic = mkTex(THREE, tex.causticData, cT, cT, true); tex.bytes += cT * cT * 4 * 1.34;
    const sN = tier.shore || 8; tex.shoreData = new Uint16Array(sN * sN * 4);
    const h = THREE.DataUtils.toHalfFloat; for (let i = 0; i < sN * sN; i++) { tex.shoreData[i * 4] = h(60); tex.shoreData[i * 4 + 1] = h(0); tex.shoreData[i * 4 + 2] = h(0); tex.shoreData[i * 4 + 3] = h(0); }
    const st = new THREE.DataTexture(tex.shoreData, sN, sN, THREE.RGBAFormat, THREE.HalfFloatType);
    st.wrapS = st.wrapT = THREE.ClampToEdgeWrapping; st.magFilter = st.minFilter = THREE.LinearFilter; st.generateMipmaps = false; st.colorSpace = THREE.NoColorSpace; st.needsUpdate = true;
    tex.shore = st; tex.bytes += sN * sN * 8;
    return tex;
  }
  function disposeTextures() {
    const t = S.tex; if (!t) return;
    try { t.bands.forEach((x) => x.dispose()); t.detail.dispose(); t.caustic.dispose(); t.shore.dispose(); } catch (e) { }
    crumb('gpu', 'water:tex', 0); S.tex = null;
  }

  /* ───────────────────────── uniforms ───────────────────────── */
  function makeUniforms(THREE, T, P, spec, tier) {
    const { uniform } = T, V2 = () => new THREE.Vector2(), V3 = () => new THREE.Vector3(), Cc = (a) => new THREE.Color().setRGB(a[0], a[1], a[2], THREE.SRGBColorSpace), Raw = (a) => new THREE.Color().setRGB(a[0], a[1], a[2], THREE.LinearSRGBColorSpace);
    const U = {
      focus: uniform(V2()), lvl: uniform(1), disp: uniform(1), wc: uniform(P.whitecap), amp: uniform(1), swellAmp: uniform(1), drift: uniform(V2()), night: uniform(0), sunUp: uniform(1),
      sunDir: uniform(new THREE.Vector3(0.3, 0.8, 0.3).normalize()), sunCol: uniform(new THREE.Color(1, 0.96, 0.88)), skyTop: uniform(Cc(P.colors.skyTop)), skyHor: uniform(Cc(P.colors.skyHor)),
      deep: uniform(Cc(P.colors.deep)), shallow: uniform(Cc(P.colors.shallow)), scatter: uniform(Cc(P.colors.scatter)), foamCol: uniform(Cc(P.colors.foam)), absorb: uniform(Raw(P.absorb)),
      glowCol: uniform(Cc(P.glowCol)), glowCol2: uniform(Cc(P.glowCol2)), glow: uniform(P.glow), pulse: uniform(1), ice: uniform(P.ice), steam: uniform(P.steam),
      under: uniform(0), time: uniform(0), nRip: uniform(0, 'int'), shoreOn: uniform(0), shoreC: uniform(V3()), shoreP: uniform(V3()), wetTop: uniform(0), swashA: uniform(P.swash), swashT: uniform(0),
      bandAmt: [], bm: [], bg: [], boff: [], bhw: []
    };
    spec.bands.forEach((b, i) => {
      U.bandAmt.push(uniform(0));
      for (let L = 0; L < tier.layers; L++) { U.bm.push(uniform(new THREE.Vector4())); U.bg.push(uniform(new THREE.Vector4())); U.boff.push(uniform(V2())); U.bhw.push(uniform(0)); }
    });
    U.rip = T.uniformArray(Array.from({ length: Math.max(1, tier.ripples) }, () => new THREE.Vector4(0, 0, 99, 0)), 'vec4');
    return U;
  }

  /* ───────────────────────── begin / bake ───────────────────────── */
  function enabled() { return !FLAG_OFF && !S.failed && !!(W.THREE && W.THREE.TSL && W.DMWaterCore); }
  // o: { body, pal, seed, lat }. Builds the identity, allocates (neutral) textures + uniforms, starts the sliced bake. Returns the identity or null.
  function begin(o) {
    if (!enabled() || !o || !o.pal || !o.pal.water) { S.active = false; return null; }
    try {
      end(true);
      const THREE = W.THREE, T = THREE.TSL, core = C(), mobile = isMobile();
      const tier = core.tierFor(FORCE || presetName(), mobile);
      const P = core.identityFor(o.body, o.pal, { seed: o.seed, lat: o.lat, t: 0 });
      S.tier = tier; S.P = P; S.body = o.body; S.pal = o.pal; S.opts = o; S.seed = P.seed;
      S.spec = core.buildSpectrum(P, tier);
      S.tex = allocTextures(THREE, tier, S.spec); S.U = makeUniforms(THREE, T, P, S.spec, tier);
      S.model = { bands: S.spec.bands.map((b, i) => ({ band: b, tile: S.tex.data[i], T: b.T })), layers: tier.layers, windRot: 0, amp: 1 };
      S.t = 0; S.ready = 0; S.epoch++; S.t0 = now(); S.jobMs = 0; S.shore = null; S.active = true; S.on = true; S.lvl = 1; S.under = 0;
      S.job = bakeJob(); S.deliver = null; S.rip = new core.Ripples(Math.max(1, tier.ripples)); S.wetTop = 0;
      hookOcean();
      try { if (W.DMWaterFX && W.DMWaterFX.enabled()) S.fx = W.DMWaterFX.create(S); } catch (e) { S.fx = null; try { console.warn('[water] fx', e); } catch (_) { } }
      crumb('gpu', 'water:tex', S.tex.bytes); crumb('live', 'water', tier.name);
      pumpLater(30);
      log('begin', P.name || P.type, tier.name, 'lamS', P.lamS.toFixed(0), 'HsTot', P.HsTotal.toFixed(2), 'bytes', Math.round(S.tex.bytes));
      try { W.dispatchEvent(new CustomEvent('dm:water', { detail: { tier: tier.name, kind: P.kind, sig: P.sig } })); } catch (e) { }
      return P;
    } catch (e) { S.failed = true; S.active = false; try { console.warn('[water] off:', e); } catch (_) { } return null; }
  }
  // the CPU mirror other systems already use (fluid core, board): serve the baked sea once it exists, the old layers otherwise
  function hookOcean() {
    const O = W.DMOcean; if (!O || O._dmw) return; O._dmw = true; const h0 = O.heightAt, s0 = O.slopeAt;
    O.heightAt = function (x, z, t) { return (S.active && S.ready >= 1 && S.model) ? (O.seaY || 0) + C().heightAt(S.model, x, z, S.t) : h0.call(O, x, z, t); };
    O.slopeAt = function (x, z, t) { return (S.active && S.ready >= 1 && S.model) ? C().slopeAt(S.model, x, z, S.t) : s0.call(O, x, z, t); };
  }
  // a ripple on the surface (footfall, splash, landing): amp ~0.2 (toe) .. 1 (hard landing). Speed matches the shader (1.1 + 0.9 amp).
  function ripple(x, z, amp) { if (!S.active || !S.rip) return; S.rip.spawn(x, z, clamp(amp == null ? 0.4 : amp, 0.05, 1.2), S.t, 1.1 + 0.9 * clamp(amp == null ? 0.4 : amp, 0.05, 1.2)); }
  function packRipples() {
    const U = S.U, R = S.rip; if (!U || !R) return; let n = 0, a = U.rip.array; if (!a) return;
    for (let i = 0; i < R.n; i++) { const amp = R.d[i * 4 + 3], age = S.t - R.d[i * 4 + 2]; if (amp > 0 && age >= 0 && age < 3.4) { a[n].set(R.d[i * 4], R.d[i * 4 + 1], age, amp); n++; } else if (amp > 0 && age >= 3.4) R.d[i * 4 + 3] = 0; }
    for (let i = n; i < a.length; i++) a[i].set(0, 0, 99, 0); U.nRip.value = n;
  }
  function* bakeJob() {
    const core = C(), tier = S.tier, P = S.P, rows = tier.bakeMs >= 3 ? 12 : 8;
    for (let i = 0; i < S.spec.bands.length; i++) {
      const b = S.spec.bands[i], gen = core.bakeBand(b, b.T, S.tex.data[i], rows, { foamTaps: tier.foamTaps, trail: P.foam.trail });
      let r; while (!(r = gen.next()).done) yield;
      S.tex.bands[i].needsUpdate = true; S.U.bandAmt[i].value = 0; S.ready = i + 1; S.bandDoneAt = S.bandDoneAt || []; S.bandDoneAt[i] = S.t; yield;
    }
    { const g = core.bakeDetail(tier.detailT, S.tex.detailData, P.seed, rows); while (!g.next().done) yield; S.tex.detail.needsUpdate = true; yield; }
    if (tier.causticT) { const g = core.bakeCaustics(tier.causticT, S.tex.causticData, P.seed, rows); while (!g.next().done) yield; S.tex.caustic.needsUpdate = true; }
  }
  let pumpT = 0;
  function pump(budget) {
    if (!S.job) return false; const t0 = now(); budget = budget || 3;
    try { do { const r = S.job.next(); if (r.done) { S.job = null; S.bakeWall = now() - S.t0; crumb('end', 'water:bake', Math.round(S.bakeWall)); log('baked in', S.jobMs.toFixed(0), 'ms CPU', S.bakeWall.toFixed(0), 'ms wall'); S.jobMs += now() - t0; return false; } } while (now() - t0 < budget); }
    catch (e) { S.job = null; try { console.warn('[water] bake', e); } catch (_) { } return false; }
    S.jobMs += now() - t0; return true;
  }
  function pumpLater(delay) {
    if (pumpT || !S.job) return;
    if (!S.bakeBegun) { S.bakeBegun = true; crumb('begin', 'water:bake', S.tier && S.tier.name); }
    pumpT = setTimeout(() => { pumpT = 0; if (W._dmWarming) { pumpLater(80); return; } const more = pump(S.tier && S.tier.mobile ? 2 : 3); if (more) pumpLater(S.tier && S.tier.mobile ? 36 : 22); }, delay == null ? 16 : delay);
  }
  // used by the node/browser harnesses: finish the bake now
  function bakeNow() { let n = 0; while (S.job && n++ < 100000) { if (!pump(1e9)) break; } return S.ready; }

  /* ───────────────────────── per-frame tick (uniform writes only) ───────────────────────── */
  function governor(dt) {
    S.ema += (dt * 1000 - S.ema) * 0.05;
    S.lvlT += dt; if (S.lvlT < 0.5) return; S.lvlT = 0;
    let k = 1; try { const rr = (typeof flightRenderer !== 'undefined') ? flightRenderer : null; k = (rr && rr._dr && rr._dr.k) || 1; } catch (e) { k = 1; }
    const ref = (S.opts && S.opts.refMs) || 16.7;
    if (S.ema > ref * 1.55) { S.slow++; S.fast = 0; } else if (S.ema < ref * 1.18) { S.fast++; S.slow = 0; } else { S.slow = 0; S.fast = 0; }
    let want = S.lvl;
    if (S.slow >= 3) { want = Math.max(0.15, S.lvl - 0.28); S.slow = 0; } else if (S.fast >= 10) { want = Math.min(1, S.lvl + 0.15); S.fast = 0; }
    let cap = k >= 0.9 ? 1 : k >= 0.75 ? 0.75 : k >= 0.62 ? 0.45 : 0.2; try { const B = W.DMBudget; if (B && B.on && B.waterCap) cap = Math.min(cap, B.waterCap()); } catch (e) { }   // (v256) frame-budget ladder (ui/dm-budget.js): water stages 1-3 lower this cap
    S.lvl = Math.min(want, cap);
    if (S.U) { S.U.lvl.value = S.lvl; S.U.disp.value = S.lvl >= 0.45 ? 1 : 0; }
  }
  function sunPoll(U) {
    try {
      const TR = (typeof TERRAIN !== 'undefined') ? TERRAIN : null; const sun = TR && TR.sun; let el = 0.6;
      if (sun && sun.position && sun.target) { const dx = sun.position.x - sun.target.position.x, dy = sun.position.y - sun.target.position.y, dz = sun.position.z - sun.target.position.z, l = Math.hypot(dx, dy, dz) || 1; U.sunDir.value.set(dx / l, dy / l, dz / l); el = dy / l; if (sun.color) U.sunCol.value.copy(sun.color).multiplyScalar(Math.min(1.4, (sun.intensity || 2.5) / 2.2)); }
      S.sunEl = el; U.sunUp.value = clamp(el * 2.2, 0, 1); U.night.value = clamp(0.35 - el * 1.6, 0, 1);
    } catch (e) { }
  }
  function tick(dt, ctx) {
    if (!S.active || !S.U) return; ctx = ctx || {};
    dt = Math.min(dt || 0.016, 0.1); S.t += dt; const U = S.U, core = C(), P = S.P, tier = S.tier, spec = S.spec;
    governor(dt);
    // wind: the world's own wind recipe; the baked sea turns with it (a slow rotation of the sampling frame) and swells with gusts
    const w = core.windFor(S.seed, S.t), base = P.wind.ang, d = Math.atan2(Math.sin(w.ang - base), Math.cos(w.ang - base)), wr = clamp(d, -0.5, 0.5);
    const gust = clamp(0.86 + 0.14 * (w.s / Math.max(1, P.wind.s0)), 0.8, 1.3);
    const breathe = 1 + P.pulse * Math.sin(S.t * Math.PI * 2 * P.pulseHz), calmIce = 1 - 0.8 * P.ice;
    S.model.windRot = wr; S.model.amp = gust * calmIce;
    U.amp.value = S.model.amp; U.swellAmp.value = breathe * 1.0; U.pulse.value = 0.78 + 0.22 * Math.sin(S.t * 2.1 + 1.0);
    U.wc.value = clamp(P.whitecap * Math.pow(w.s / Math.max(1, P.wind.s0), 1.6) + P.steam * 0.28, 0, 1) * (1 - P.ice * 0.8);
    U.time.value = S.t; U.drift.value.set(-w.x * S.t * 0.03 * (1 + 0.5 * P.mu * 0), -w.z * S.t * 0.03);
    const cr = Math.cos(wr), sr = Math.sin(wr);
    let k = 0;
    spec.bands.forEach((b, bi) => {
      // fade each band in 1.5 s after its tile lands
      const done = S.bandDoneAt && S.bandDoneAt[bi]; const a = done == null ? 0 : clamp((S.t - done) / 1.5, 0, 1); U.bandAmt[bi].value = a * (bi === 2 ? (S.lvl >= 0.3 ? 1 : 0) : 1);
      for (let L = 0; L < tier.layers; L++, k++) {
        const ly = core.LAYERS[L], c2 = Math.cos(ly.rot), s2 = Math.sin(ly.rot), Sg = b.S * ly.s;
        const m00 = c2 * cr - s2 * sr, m01 = -c2 * sr - s2 * cr, m10 = s2 * cr + c2 * sr, m11 = -s2 * sr + c2 * cr;
        U.bm[k].value.set(m00 / Sg, m01 / Sg, m10 / Sg, m11 / Sg);
        const gk = b.smax * ly.w / ly.s; U.bg[k].value.set(m00 * gk, m10 * gk, m01 * gk, m11 * gk);
        const sc = b.c * ly.f * S.t / Sg, ox = (c2 * b.dir[0] - s2 * b.dir[1]) * sc, oz = (s2 * b.dir[0] + c2 * b.dir[1]) * sc;
        U.boff[k].value.set(ox - Math.floor(ox), oz - Math.floor(oz)); U.bhw[k].value = b.hmax * ly.w;
      }
    });
    S.sunT = (S.sunT || 0) + dt; if (S.sunT > 0.3) { S.sunT = 0; sunPoll(U); }
    if (ctx.camera && ctx.camera.position) {   // below the sea? (the camera is in the drawn frame, which equals the flat frame at the focus)
      const cp = ctx.camera.position, hs = heightAt(cp.x, cp.z), u = clamp((hs - cp.y) / 0.6 + 0.5, 0, 1); S.under += (u - S.under) * Math.min(1, dt * 8); U.under.value = S.under;
    }
    packRipples();
    if (S.fx) S.fx.tick(dt, ctx, S);
    if (tier.shore && ctx.H) shoreTick(dt, ctx);
    wetTick(dt);
  }

  /* ───────────────────────── CPU mirror (the board, swimmers, spray ride the surface the GPU draws) ───────────────────────── */
  function heightAt(x, z, t) { if (!S.active || !S.ready) return 0; const m = S.model; return C().heightAt(m, x, z, t == null ? S.t : t) * (S.shoreAmpAt ? S.shoreAmpAt(x, z) : 1); }
  function slopeAt(x, z, t) { if (!S.active || !S.ready) return { sx: 0, sz: 0 }; return C().slopeAt(S.model, x, z, t == null ? S.t : t); }

  /* ───────────────────────── shore field ───────────────────────── */
  // N x N half-float texture around the player: R depth (sea level - ground, units), G wave travel time (s), B/A gradient of the travel time. Built in slices.
  function shoreTick(dt, ctx) {
    const tier = S.tier, N = tier.shore, R = tier.name === 'medium' ? 110 : 96, cell = 2 * R / N, sh = S.shore || (S.shore = { job: null, cx: 1e9, cz: 1e9, wait: 0, depth: new Float32Array(N * N), T: new Float32Array(N * N), has: false, cell, R, N, tAge: 0, minD: 99, nearest: null, ver: 0 });
    sh.wait -= dt; sh.tAge += dt;
    const px = ctx.x, pz = ctx.z; if (px == null) return;
    if (!sh.job) {
      const moved = Math.hypot(px - sh.cx, pz - sh.cz);
      if (sh.wait <= 0 && (moved > R * 0.38 || sh.tAge > (sh.has ? 12 : 5))) {
        const cx = Math.round(px / cell) * cell, cz = Math.round(pz / cell) * cell; sh.job = shoreJob(sh, cx, cz, ctx.H); sh.tAge = 0;
      }
    }
    if (sh.job) { const t0 = now(), budget = tier.mobile ? 0.7 : 1.1; let n = 0; try { while (now() - t0 < budget) { const r = sh.job.next(); n++; if (r.done) { sh.job = null; break; } } } catch (e) { sh.job = null; sh.wait = 5; try { console.warn('[water] shore', e); } catch (_) { } } if (W.DMPerf) W.DMPerf.mark('water.shore', now() - t0); }
  }
  function* shoreJob(sh, cx, cz, H) {
    const core = C(), N = sh.N, cell = sh.cell, d = sh.depth, seaY = 0, x0 = cx - sh.R + cell * 0.5, z0 = cz - sh.R + cell * 0.5;
    let t0 = now(), minD = 99, maxD = -99;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) { const h = H(x0 + i * cell, z0 + j * cell); const v = seaY - h; d[j * N + i] = v; if (v < minD) minD = v; if (v > maxD) maxD = v; }
      if (now() - t0 > 0.8) { yield; t0 = now(); }
    }
    const P = S.P, dDeep = Math.max(1.5, Math.min(clamp(0.2 * P.lamS, 6, 30), maxD * 0.9)), T = sh.T;
    core.eikonal(d, N, cell, P.g, dDeep, T); yield;
    // pack: depth, T, dT/dx, dT/dz  (half floats)
    const th = W.THREE.DataUtils.toHalfFloat, out = S.tex.shoreData;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, ia = i > 0 ? k - 1 : k, ib = i < N - 1 ? k + 1 : k, ja = j > 0 ? k - N : k, jb = j < N - 1 ? k + N : k;
      const gx = (T[ib] - T[ia]) / (cell * ((i > 0 ? 1 : 0) + (i < N - 1 ? 1 : 0)) || 1), gz = (T[jb] - T[ja]) / (cell * ((j > 0 ? 1 : 0) + (j < N - 1 ? 1 : 0)) || 1);
      out[k * 4] = th(clamp(d[k], -30, 120)); out[k * 4 + 1] = th(clamp(T[k], 0, 90)); out[k * 4 + 2] = th(clamp(gx, -4, 4)); out[k * 4 + 3] = th(clamp(gz, -4, 4));
    }
    S.tex.shore.needsUpdate = true; sh.dDeep = dDeep; sh.cx = cx; sh.cz = cz; sh.minD = minD; sh.maxD = maxD; sh.ver++;
    // is there a coast in range at all? (sea and land both present, or shallow water): otherwise the shore terms are switched off and the refresh backs off
    sh.has = minD < 3 && maxD > -1; sh.wait = sh.has ? 0.5 : 4;
    if (S.U) { S.U.shoreC.value.set(cx, cz, 2 * sh.R); S.U.shoreP.value.set(dDeep, 0, 0); S.U.shoreOn.value = sh.has ? 1 : 0; }
    // CPU mirror for the swash phase: nearest shoreline cell to the player
    let best = 1e9, bi = -1; for (let k = 0; k < N * N; k++) { if (Math.abs(d[k]) < 0.7) { const i = k % N, j = (k / N) | 0, dx = x0 + i * cell - (S.focus[0]), dz = z0 + j * cell - (S.focus[1]), dd = dx * dx + dz * dz; if (dd < best) { best = dd; bi = k; } } }
    sh.nearest = bi >= 0 ? { x: x0 + (bi % N) * cell, z: z0 + ((bi / N) | 0) * cell, T: T[bi], dist: Math.sqrt(best) } : null;
    // grade of the beach around the nearest shoreline cell (units of height per unit of distance), for the swash and wet band
    log('shore field', sh.has ? 'coast' : 'no coast', 'min', minD.toFixed(1), 'max', maxD.toFixed(1));
  }
  // swash + wet-sand memory (CPU: one number each; the ground shader reads them as uniforms)
  function wetTick(dt) {
    const sh = S.shore, U = S.U, P = S.P, core = C(); if (!U) return;
    const Ps = Math.sqrt(2 * Math.PI * P.lamS / P.g); U.swashT.value = Ps;
    let runup = 0;
    if (sh && sh.has && sh.nearest) { const ph = (S.t - sh.nearest.T) / Ps; runup = P.swash * 0.9 * core.swashProfile(ph) * clamp(1.3 - sh.nearest.dist / 70, 0.2, 1) * (P.Hs + P.HsS > 0.1 ? 1 : 0.3); }
    S.wetTop = core.wetStep(S.wetTop || 0, runup, dt, 26); U.wetTop.value = S.wetTop; U.swashA.value = P.swash * 0.9;
  }

  /* ───────────────────────── clip-map mesh ───────────────────────── */
  function attachSea(mesh, span) {
    if (!S.active || !mesh || !W.THREE) return false;
    const THREE = W.THREE, core = C(), g = S.tier.grid, want = Math.max(4096, span || 4096), levels = Math.min(9, core.levelsFor(g.n, g.c0, want)), cm = core.clipmap(g.n, g.c0, levels);
    const geo = new THREE.BufferGeometry();
    const pos3 = new Float32Array(cm.pos.length / 2 * 3); for (let i = 0; i < cm.pos.length / 2; i++) { pos3[i * 3] = cm.pos[i * 2]; pos3[i * 3 + 2] = cm.pos[i * 2 + 1]; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos3, 3)); geo.setAttribute('wpos', new THREE.BufferAttribute(cm.pos, 2)); geo.setAttribute('wlvl', new THREE.BufferAttribute(cm.lvl, 1)); geo.setAttribute('wmorph', new THREE.BufferAttribute(cm.morph, 2));
    geo.setIndex(new THREE.BufferAttribute(cm.index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), cm.half * 1.5); geo.boundingBox = new THREE.Box3(new THREE.Vector3(-cm.half, -10, -cm.half), new THREE.Vector3(cm.half, 10, cm.half));
    if (mesh.geometry) mesh.geometry.dispose(); mesh.geometry = geo; mesh.rotation.set(0, 0, 0); mesh.position.set(0, mesh.position.y, 0); mesh.frustumCulled = false; mesh.userData.dmWater = true;
    S.mesh = mesh; S.seaSpan = want; S.levels = levels; crumb('live', 'waterVerts', cm.pos.length / 2);
    log('sea mesh', levels, 'levels', cm.pos.length / 2, 'verts', cm.index.length / 3, 'tris', 'half', cm.half);
    return true;
  }
  function follow(x, z) { S.focus[0] = x; S.focus[1] = z; if (S.U) S.U.focus.value.set(x, z); }

  /* ───────────────────────── end ───────────────────────── */
  function end(keepFlags) {
    if (S.fx) { try { S.fx.dispose(); } catch (e) { } S.fx = null; }
    if (pumpT) { clearTimeout(pumpT); pumpT = 0; }
    if (S.bakeBegun) { crumb('end', 'water:bake'); S.bakeBegun = false; }
    S.job = null; S.active = false; S.on = false; S.mesh = null; S.shore = null; S.matBuilt = false; S.wetTop = 0; S.bandDoneAt = null; S.sprayTex = null;
    disposeTextures(); S.U = null; S.model = null;
    if (S.matCache) { try { S.matCache.dispose && S.matCache.dispose(); } catch (e) { } S.matCache = null; }
    crumb('live', 'water', 0);
  }

  W.DMWater = {
    S, enabled, begin, end, tick, follow, attachSea, bakeNow, pump, heightAt, slopeAt, ripple,
    get active() { return S.active; }, get tier() { return S.tier; }, get identity() { return S.P; }, get ready() { return S.ready; },
    status: () => ({ active: S.active, tier: S.tier && S.tier.name, ready: S.ready, bands: S.spec && S.spec.bands.length, jobMs: +S.jobMs.toFixed(0), wallMs: +S.bakeWall.toFixed(0), lvl: S.lvl, bytes: S.tex ? Math.round(S.tex.bytes) : 0, kind: S.P && S.P.kind, sig: S.P && S.P.sig, mats: S.mats, shore: S.shore ? { has: S.shore.has, minD: S.shore.minD, ver: S.shore.ver } : null }),
    _crumb: crumb, _log: log
  };
})(typeof window !== 'undefined' ? window : globalThis);
