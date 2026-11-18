/* ═══════════════════════════════════════════════════════════════════════════
   dm-necklace-sim.js - a tiny verlet / PBD solver for Ariel's necklace (ui/dm-charm.js drives it and draws it).  Pure maths: no THREE, no DOM,
   no allocation per step - the same file runs in the game and in node (tools/tests/necklace-sim.test.js).

   BODIES (all collision bodies, all tested against each other and against the body):
     chain   N point masses on a CLOSED loop (link i -> i+1, last -> 0), radius chainR, rest link length len/N.
             node 0 is the front of the loop; the charm hangs from it.
     charm   one extra particle B (the kite's tip) tied to chain node 0 by a rigid link (the kite's height) - the kite hinges on the
             chain like a bail on a chain; heavier than a link (inverse mass 1/charmMass).  The charm collides as the capsule node0-B
             (radius charmR): it pushes the chain nodes away and is pushed by them, and (as particle B + the mid point) it collides with the body.
     body    capsules (round cones: radius ra at a, rb at b, optional x stretch kx for an elliptical section) - the neck, the shoulder yoke,
             the chest and the upper back.  Supplied per call, in the sim's local space, so they follow the bones.
     self    chain node vs chain node (not within 2 links), chain node vs charm capsule, charm vs body.

   SPACE: the sim lives in the LOCAL space of a rig that is a child of a bone (ui/dm-charm.js 'ArielNeckRig').  When that frame moves the caller passes
   D = M(now)^-1 * M(previous) so positions AND previous positions stay world-consistent (world-space inertia: the chain swings when she moves);
   gravity is supplied in the same local space.  A soft tether pulls every node (not the charm tip) back toward its rest pose in that frame, so a
   violent frame (mount mirror, teleport, ragdoll) can never lose the necklace: if anything is further than resetDist from its rest after the
   transform, the whole thing snaps back to the rest pose.

   Layout of S.x / S.p / S.rest: 3 floats per particle: chain nodes 0..N-1, then the charm tip at index N.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const DEF = { N: 16, len: 0.40, chainR: 0.0016, charmLen: 0.0894, charmR: 0.006, charmMass: 4, g: 9.81,
    drag: 2.6, iters: 10, tether: 0.035, tetherTip: 0.0, skin: 0.0015, friction: 0.35, resetDist: 0.16, inertia: 0.3, maxStep: 1 / 40, hStep: 1 / 60, selfEvery: 2, selfSkip: 2 };

  function create(opt) {
    const P = Object.assign({}, DEF, opt || {}), N = P.N, M = N + 1;           // particles: chain 0..N-1, charm tip N
    const x = new Float64Array(M * 3), p = new Float64Array(M * 3), rest = new Float64Array(M * 3), w = new Float64Array(M), rad = new Float64Array(M), tk = new Float64Array(M);
    const link = P.len / N;
    for (let i = 0; i < N; i++) { w[i] = 1; rad[i] = P.chainR; tk[i] = P.tether; }
    w[N] = 1 / P.charmMass; rad[N] = P.charmR; tk[N] = P.tetherTip;
    const S = { P, N, M, x, p, rest, w, rad, tk, link, hPrev: P.hStep, hasRest: false, frames: 0, resets: 0, contacts: 0,
      cn: new Float64Array(3), cnN: 0,                                        // last body contact normal on the charm tip (the kite lies flat on the chest)
      maxPen: 0, stepsDone: 0 };

    S.setRest = function (arr) { for (let i = 0; i < M * 3; i++) { rest[i] = arr[i]; x[i] = arr[i]; p[i] = arr[i]; } S.hasRest = true; S.hPrev = P.hStep; };
    S.snapToRest = function () { for (let i = 0; i < M * 3; i++) { x[i] = rest[i]; p[i] = rest[i]; } S.hPrev = P.hStep; };

    // ── body capsule pushes (caps: Float64Array/Array of 9 numbers each: ax ay az bx by bz ra rb kx), n capsules
    function pushCaps(i, caps, nc, extra) {
      const i3 = i * 3, r0 = rad[i] + P.skin + (extra || 0); let hit = 0;
      for (let c = 0; c < nc; c++) {
        const o = c * 9, kx = caps[o + 8] || 1;
        const ax = caps[o] * kx, ay = caps[o + 1], az = caps[o + 2], bx = caps[o + 3] * kx, by = caps[o + 4], bz = caps[o + 5];
        const qx = x[i3] * kx, qy = x[i3 + 1], qz = x[i3 + 2];
        const dx = bx - ax, dy = by - ay, dz = bz - az, dd = dx * dx + dy * dy + dz * dz;
        let t = dd > 1e-12 ? ((qx - ax) * dx + (qy - ay) * dy + (qz - az) * dz) / dd : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t, r = caps[o + 6] + (caps[o + 7] - caps[o + 6]) * t + r0;
        let vx = qx - cx, vy = qy - cy, vz = qz - cz; const d2 = vx * vx + vy * vy + vz * vz;
        if (d2 >= r * r) continue;
        let d = Math.sqrt(d2); if (d < 1e-9) { vx = 0; vy = 1; vz = 0; d = 1; }
        const nx = vx / d, ny = vy / d, nz = vz / d, pen = r - d;
        const ux = nx / kx, uy = ny, uz = nz; const ul = Math.hypot(ux, uy, uz) || 1;   // normal back in unscaled space
        // move the particle out (unscaled coordinates); then its velocity (x - p): inward normal part removed (no bounce), the slip along the surface loses `friction`
        x[i3] += (cx + nx * r) / kx - x[i3]; x[i3 + 1] += cy + ny * r - x[i3 + 1]; x[i3 + 2] += cz + nz * r - x[i3 + 2];
        const nxu = ux / ul, nyu = uy / ul, nzu = uz / ul;
        let vxp = x[i3] - p[i3], vyp = x[i3 + 1] - p[i3 + 1], vzp = x[i3 + 2] - p[i3 + 2]; const vn = vxp * nxu + vyp * nyu + vzp * nzu;
        if (vn < 0) { vxp -= vn * nxu; vyp -= vn * nyu; vzp -= vn * nzu; }
        const tf = 1 - P.friction; p[i3] = x[i3] - vxp * tf; p[i3 + 1] = x[i3 + 1] - vyp * tf; p[i3 + 2] = x[i3 + 2] - vzp * tf;
        if (i === N) { S.cn[0] += nxu; S.cn[1] += nyu; S.cn[2] += nzu; S.cnN++; }
        if (pen > S.maxPen) S.maxPen = pen; hit++; S.contacts++;
      }
      return hit;
    }
    function dist(a, b) { const a3 = a * 3, b3 = b * 3; return Math.hypot(x[a3] - x[b3], x[a3 + 1] - x[b3 + 1], x[a3 + 2] - x[b3 + 2]); }
    function link2(a, b, d0) {   // PBD distance constraint with inverse masses
      const a3 = a * 3, b3 = b * 3, dx = x[b3] - x[a3], dy = x[b3 + 1] - x[a3 + 1], dz = x[b3 + 2] - x[a3 + 2], l = Math.hypot(dx, dy, dz); if (l < 1e-12) return;
      const ws = w[a] + w[b], k = (l - d0) / (l * ws), fa = k * w[a], fb = k * w[b];
      x[a3] += dx * fa; x[a3 + 1] += dy * fa; x[a3 + 2] += dz * fa; x[b3] -= dx * fb; x[b3 + 1] -= dy * fb; x[b3 + 2] -= dz * fb;
    }
    function pair(a, b, rr) {    // two spheres: push apart if closer than rr
      const a3 = a * 3, b3 = b * 3, dx = x[b3] - x[a3], dy = x[b3 + 1] - x[a3 + 1], dz = x[b3 + 2] - x[a3 + 2], d2 = dx * dx + dy * dy + dz * dz; if (d2 >= rr * rr || d2 < 1e-14) return;
      const d = Math.sqrt(d2), ws = w[a] + w[b], k = (rr - d) / (d * ws), fa = k * w[a], fb = k * w[b];
      x[a3] -= dx * fa; x[a3 + 1] -= dy * fa; x[a3 + 2] -= dz * fa; x[b3] += dx * fb; x[b3 + 1] += dy * fb; x[b3 + 2] += dz * fb;
    }
    function segPush(i) {        // chain node i vs the charm capsule (node 0 -> tip): push the node out, the charm gets its share by mass
      const i3 = i * 3, a3 = 0, b3 = N * 3, ax = x[a3], ay = x[a3 + 1], az = x[a3 + 2], dx = x[b3] - ax, dy = x[b3 + 1] - ay, dz = x[b3 + 2] - az, dd = dx * dx + dy * dy + dz * dz; if (dd < 1e-12) return;
      let t = ((x[i3] - ax) * dx + (x[i3 + 1] - ay) * dy + (x[i3 + 2] - az) * dz) / dd; t = t < 0.12 ? 0.12 : t > 1 ? 1 : t;   // not the bail end: the chain runs through it
      const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t, vx = x[i3] - cx, vy = x[i3 + 1] - cy, vz = x[i3 + 2] - cz, d2 = vx * vx + vy * vy + vz * vz, rr = rad[i] + P.charmR * 0.6;
      if (d2 >= rr * rr || d2 < 1e-14) return; const d = Math.sqrt(d2), s = (rr - d) / d, wi = w[i], wt = w[N] * t;   // the tip carries t of the push
      const ws = wi + wt; if (ws <= 0) return; x[i3] += vx * s * (wi / ws); x[i3 + 1] += vy * s * (wi / ws); x[i3 + 2] += vz * s * (wi / ws);
      const f = s * (wt / ws) * -1; x[b3] += vx * f; x[b3 + 1] += vy * f; x[b3 + 2] += vz * f;
    }

    /* one frame.  dt seconds; g = [gx,gy,gz] gravity in the sim's local space (m/s^2, already scaled); D = 16 numbers (column-major, THREE order) or null;
       caps/nc = body capsules.  Returns 'ok' | 'reset'. */
    S.step = function (dt, g, D, caps, nc) {
      if (!S.hasRest) return 'norest';
      if (!(dt > 0) || dt > 1) dt = P.hStep;
      if (dt > P.maxStep * 3) dt = P.maxStep * 3;
      S.cn[0] = S.cn[1] = S.cn[2] = 0; S.cnN = 0; S.maxPen = 0;
      // frame motion: positions AND previous positions are carried into the new local frame by D, but only `inertia` of it (the rest of the frame's move is carried rigidly, i.e. the
      // chain goes WITH the body): a loop round a neck is dragged by the neck, it does not stay behind in the world.  inertia 1 = pure world-space inertia, 0 = rigidly attached.
      if (D) { const k = P.inertia; for (let i = 0; i < M; i++) { const o = i * 3;
        for (let q = 0; q < 2; q++) { const a = q ? p : x, X = a[o], Y = a[o + 1], Z = a[o + 2];
          a[o] = X + k * (D[0] * X + D[4] * Y + D[8] * Z + D[12] - X); a[o + 1] = Y + k * (D[1] * X + D[5] * Y + D[9] * Z + D[13] - Y); a[o + 2] = Z + k * (D[2] * X + D[6] * Y + D[10] * Z + D[14] - Z); } } }
      // runaway / NaN guard: too far from the rest pose -> snap back
      let bad = false; for (let i = 0; i < M && !bad; i++) { const o = i * 3, e = Math.hypot(x[o] - rest[o], x[o + 1] - rest[o + 1], x[o + 2] - rest[o + 2]); if (!(e < (i === N ? P.resetDist * 3 : P.resetDist))) bad = true; }   // (the charm tip may hang a long way from its rest: only the loop is held to resetDist)
      if (bad) { S.snapToRest(); S.resets++; return 'reset'; }
      const n = Math.max(1, Math.ceil(dt / P.hStep - 1e-9)), h = dt / n, damp = Math.exp(-P.drag * h);
      for (let s = 0; s < n; s++) {
        const r = h / S.hPrev;                                                     // variable-step verlet
        for (let i = 0; i < M; i++) { const o = i * 3;
          for (let k = 0; k < 3; k++) { const cur = x[o + k], v = (cur - p[o + k]) * r * damp; p[o + k] = cur; x[o + k] = cur + v + g[k] * h * h; }
          const tk_ = tk[i]; if (tk_ > 0) { for (let k = 0; k < 3; k++) x[o + k] += (rest[o + k] - x[o + k]) * tk_; } }
        S.hPrev = h;
        for (let it = 0; it < P.iters; it++) {
          if (it & 1) { for (let i = N - 1; i >= 0; i--) link2(i, i + 1 === N ? 0 : i + 1, S.link); } else { for (let i = 0; i < N; i++) link2(i, i + 1 === N ? 0 : i + 1, S.link); }   // alternate sweep direction: no left/right bias
          link2(0, N, P.charmLen);
          if (it % P.selfEvery === 0) {
            for (let i = 0; i < N; i++) { const cd = Math.min(i, N - i); if (cd > P.selfSkip) segPush(i); }                 // chain node vs the charm capsule
            for (let i = 0; i < N; i++) for (let j = i + 1 + P.selfSkip; j < N; j++) { if (Math.min(j - i, N - (j - i)) <= P.selfSkip) continue; pair(i, j, rad[i] + rad[j]); }
          }
          for (let i = 0; i < N; i++) pushCaps(i, caps, nc, 0);
          pushCaps(N, caps, nc, 0);                                                 // the kite's tip
          if (nc) { const b3 = N * 3, hit = pushCapsMid(caps, nc, (x[0] + x[b3]) * 0.5, (x[1] + x[b3 + 1]) * 0.5, (x[2] + x[b3 + 2]) * 0.5);   // the kite's middle must clear the body too: lifting the tip lays the kite on the chest
            if (hit) { x[b3] += hit[0] * 2; x[b3 + 1] += hit[1] * 2; x[b3 + 2] += hit[2] * 2; } }
        }
      }
      S.frames++; S.stepsDone += n; return 'ok';
    };
    function pushCapsMid(caps, nc, mx, my, mz) {          // returns the displacement the kite's middle needs, or null
      let ox = 0, oy = 0, oz = 0, any = false; const r0 = P.charmR * 0.5 + P.skin;
      for (let c = 0; c < nc; c++) { const o = c * 9, kx = caps[o + 8] || 1;
        const ax = caps[o] * kx, ay = caps[o + 1], az = caps[o + 2], bx = caps[o + 3] * kx, by = caps[o + 4], bz = caps[o + 5], qx = mx * kx, qy = my, qz = mz;
        const dx = bx - ax, dy = by - ay, dz = bz - az, dd = dx * dx + dy * dy + dz * dz; let t = dd > 1e-12 ? ((qx - ax) * dx + (qy - ay) * dy + (qz - az) * dz) / dd : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t, r = caps[o + 6] + (caps[o + 7] - caps[o + 6]) * t + r0, vx = qx - cx, vy = qy - cy, vz = qz - cz, d2 = vx * vx + vy * vy + vz * vz;
        if (d2 >= r * r || d2 < 1e-14) continue; const d = Math.sqrt(d2), s = (r - d) / d; ox += vx * s / kx; oy += vy * s; oz += vz * s; any = true; }
      return any ? [ox, oy, oz] : null;
    }
    S.hooks = { pair, segPush, pushCaps, link2 };                    // exposed for the unit test (single constraints / contacts in isolation)
    S.maxLinkError = function () { let m = 0; for (let i = 0; i < N; i++) m = Math.max(m, Math.abs(dist(i, i + 1 === N ? 0 : i + 1) - S.link) / S.link); return m; };
    S.charmError = function () { return Math.abs(dist(0, N) - P.charmLen) / P.charmLen; };
    S.penetration = function (caps, nc) {                   // deepest overlap (m) of any chain node / the tip with any body capsule, measured the way pushCaps measures it (without skin)
      let worst = 0; for (let i = 0; i < M; i++) { const i3 = i * 3;
        for (let c = 0; c < nc; c++) { const o = c * 9, kx = caps[o + 8] || 1, ax = caps[o] * kx, ay = caps[o + 1], az = caps[o + 2], bx = caps[o + 3] * kx, by = caps[o + 4], bz = caps[o + 5];
          const qx = x[i3] * kx, qy = x[i3 + 1], qz = x[i3 + 2], dx = bx - ax, dy = by - ay, dz = bz - az, dd = dx * dx + dy * dy + dz * dz; let t = dd > 1e-12 ? ((qx - ax) * dx + (qy - ay) * dy + (qz - az) * dz) / dd : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(qx - ax - dx * t, qy - ay - dy * t, qz - az - dz * t), r = caps[o + 6] + (caps[o + 7] - caps[o + 6]) * t + rad[i]; if (r - d > worst) worst = r - d; } }
      return worst; };
    return S;
  }

  /* a first guess for the loop (before the pre-roll settles it): a ring round the neck axis, lower at the front.  centre (cx,cy,cz), radii rx (x) / rz (z), height y0 (+dy at the front).
     Out: Float64Array(M*3) with the charm tip hanging from node 0.  Node 0 is the FRONT (+z), nodes run round to the wearer's left (+x first). */
  function initialLoop(P, cx, cy, cz, rx, rz, dyFront) {
    const N = P.N, out = new Float64Array((N + 1) * 3);
    for (let i = 0; i < N; i++) { const a = i / N * Math.PI * 2, s = Math.sin(a), c = Math.cos(a), fr = Math.max(0, c);
      out[i * 3] = cx + rx * s; out[i * 3 + 1] = cy - dyFront * fr * fr; out[i * 3 + 2] = cz + rz * c; }
    out[N * 3] = out[0]; out[N * 3 + 1] = out[1] - P.charmLen; out[N * 3 + 2] = out[2] + 0.002;
    return out;
  }
  /* ── ARIEL's fit: the colliders + chain numbers, in metres on the 1.7 m Ariel GLB (characterassests/Meshy_AI_Autumn_biped_Character_output.glb), in the RIG frame
     (origin = the 'neck' bone's head = the base of the neck, x = her left, y up, z = forward).  Measured on the bind pose: the shirt collar rim is 1.462 m at the sides and 1.435 m at
     front / back, the neck is an oval 0.043 x 0.036 m at 1.48 m flaring to 0.078 wide at 1.445 m, the sternum slopes from 0.07 m forward of the neck axis at the neckline to 0.11 m at the bust.
     wa / wb = the bone -> weight table of each END, taken from the GLB's own skin weights around that spot (the neck + collar of this rig follow 'Head' by 25-55 %, not only 'Spine'),
     so ui/dm-charm.js skins the collider ends like the mesh they hug. */
  const ARIEL = {
    chain: { N: 16, len: 0.40, chainR: 0.0020, charmR: 0.005, charmMass: 4, tether: 0.035, skin: 0.0015, resetDist: 0.16 },
    colliders: [
      { name: 'neck', a: [0, 0.047, -0.004], b: [0, 0.087, -0.004], ra: 0.0546, rb: 0.030, kx: 0.70,
        wa: { Spine: 0.5, Head: 0.28, Spine01: 0.13, neck: 0.09 }, wb: { Head: 0.68, neck: 0.21, Spine: 0.11 } },
      { name: 'yoke', a: [-0.07, 0.007, 0], b: [0.07, 0.007, 0], ra: 0.062, rb: 0.062, kx: 1,
        wa: { Spine: 0.5, Head: 0.18, Spine01: 0.17, RightShoulder: 0.15 }, wb: { Spine: 0.5, Head: 0.18, Spine01: 0.17, LeftShoulder: 0.15 } },
      { name: 'chest', a: [0, 0.007, 0.012], b: [0, -0.113, 0.053], ra: 0.06, rb: 0.06, kx: 1,
        wa: { Spine: 0.57, Spine01: 0.28, LeftShoulder: 0.06, RightShoulder: 0.06, Head: 0.03 }, wb: { Spine01: 0.7, Spine: 0.13, Spine02: 0.17 } },
      { name: 'back', a: [0, 0, -0.012], b: [0, -0.12, -0.02], ra: 0.065, rb: 0.065, kx: 1,
        wa: { Spine: 0.6, Spine01: 0.26, Head: 0.1, neck: 0.04 }, wb: { Spine01: 0.62, Spine: 0.26, Spine02: 0.12 } } ] };
  /* bind-pose colliders (scaled by u) -> Float64Array of capsules in rig space */
  function bindCapsules(u) { const C = ARIEL.colliders, o = new Float64Array(C.length * 9);
    for (let i = 0; i < C.length; i++) { const c = C[i]; for (let k = 0; k < 3; k++) { o[i * 9 + k] = c.a[k] * u; o[i * 9 + 3 + k] = c.b[k] * u; } o[i * 9 + 6] = c.ra * u; o[i * 9 + 7] = c.rb * u; o[i * 9 + 8] = c.kx; }
    return o; }
  function createAriel(u, g) {   // a sim sized for a body u times the 1.7 m Ariel (g = gravity magnitude in local units, default 9.81 u); tether is switched on by settle()
    u = u || 1; const A = ARIEL.chain, kt = 0.050 * 1.7;
    return create({ N: A.N, len: A.len * u, chainR: A.chainR * u, charmLen: (kt + 0.0026 * 1.7) * u, charmR: A.charmR * u, charmMass: A.charmMass, g: g || 9.81 * u, skin: A.skin * u, resetDist: A.resetDist * u, tether: 0 }); }
  /* pre-roll the loop onto the bind-pose body until it hangs still, mirror it about x = 0 (a necklace hangs symmetrically), settle once more, adopt it as the REST pose and switch the soft tether on.
     gl = gravity in rig space.  Returns the rest array (also S.rest). */
  function settle(S, caps, nc, gl, u) {
    u = u || 1; const N = S.N, x = S.x, p = S.p, t = ARIEL.chain.tether;
    for (let i = 0; i < S.M; i++) S.tk[i] = 0;
    S.setRest(initialLoop(S.P, 0, 0.075 * u, 0, 0.05 * u, 0.04 * u, 0.02 * u));
    for (let k = 0; k < 420; k++) S.step(1 / 60, gl, null, caps, nc);
    for (let i = 0; i <= N / 2; i++) { const j = (N - i) % N, a = i * 3, b = j * 3, X = (x[a] - x[b]) * 0.5, Y = (x[a + 1] + x[b + 1]) * 0.5, Z = (x[a + 2] + x[b + 2]) * 0.5;
      if (i === 0 || i === N / 2) { x[a] = 0; x[a + 1] = Y; x[a + 2] = Z; } else { x[a] = X; x[a + 1] = Y; x[a + 2] = Z; x[b] = -X; x[b + 1] = Y; x[b + 2] = Z; } }
    x[N * 3] = 0; for (let i = 0; i < (N + 1) * 3; i++) p[i] = x[i];
    for (let k = 0; k < 120; k++) S.step(1 / 60, gl, null, caps, nc);
    for (let i = 0; i <= N / 2; i++) { const j = (N - i) % N, a = i * 3, b = j * 3, X = (x[a] - x[b]) * 0.5, Y = (x[a + 1] + x[b + 1]) * 0.5, Z = (x[a + 2] + x[b + 2]) * 0.5;   // the solver's sweep order leaves ~0.1 mm of asymmetry: mirror once more
      if (i === 0 || i === N / 2) { x[a] = 0; x[a + 1] = Y; x[a + 2] = Z; } else { x[a] = X; x[a + 1] = Y; x[a + 2] = Z; x[b] = -X; x[b + 1] = Y; x[b + 2] = Z; } }
    x[N * 3] = 0;
    const rest = Float64Array.from(x); S.setRest(rest); S.P.tether = t; for (let i = 0; i < N; i++) S.tk[i] = t; S.tk[N] = 0;   // the kite's tip is free
    return rest;
  }
  const API = { create, createAriel, initialLoop, settle, bindCapsules, ARIEL, DEF };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.DMNecklaceSim = API;
})(typeof window !== 'undefined' ? window : globalThis);
