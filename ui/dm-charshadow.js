// DM CharShadow (lamp-shadow pass 2) - a cheap, robust, analytic shadow of HER (character + skyboard) from every nearby lamp, on every receiver, with NO depth texture.
//
// Why: real shadow maps are scarce (WebGPU gives 16 sampled textures per stage; the sun, the flashlight and the lamps already use some) and slow on a tablet. Her shadow from a point
// light is simple enough to evaluate in the shader instead: she is a few capsules (legs, torso, head, from her bones) and the board is an oriented ellipsoid (its OBB). For a receiver
// point P and a lamp at L the visibility is the analytic soft-shadow of the segment P->L against each capsule:
//   closest approach d between the ray segment and the capsule axis (segment/segment, Ericson), t = how far along the ray (0 at P, 1 at the lamp);
//   the lamp has radius lr, so at fraction t the cone P->lamp is lr*t wide  =>  vis = smoothstep(r - w, r + w, d),  w = lr*t + small.
// Points that ARE the occluder (inside its inflated hull and facing outward) are excluded, so she never shades herself; the strength fades to 0 toward the light's range
// (no hard edge where the lamp ends), and a shadow never goes fully black (maxDark). Occluders combine as 1 - prod(1 - occ_i).
// Hook: the term is multiplied into the light's COLOUR node (AnalyticLightNode.colorNode, a three feature), so every material that runs three's light loop with that light - terrain, props,
// her, the board, the mansion atlas (private list), the Bird Temple hull - gets it with one line: DMCharShadow.attach(light, { range, radius, gate }). Must be called before the light is first
// compiled (the light node reads colorNode once). Cost per lit pixel and light: one range test (early out), then 4 capsule + 1 ellipsoid evaluations (~120 flops).
// Per frame (tick): ~14 vec4 uniform writes from bone matrices, no allocation. `en` (per light) is 0 when she is farther than range + 4 from the lamp.
// Flags: ?charshadow=0 switches the analytic term off (the colour node stays for the optional `gate`, the occlusion branch is never entered: en = 0). ?charshadow=<0..1> strength (default 0.85 max darkness). Pure maths exported in `core` (tools/tests/charshadow-unit.js).
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const q = (() => { try { return new URLSearchParams(G.location.search); } catch (e) { return new URLSearchParams(''); } })();
  const flag = q.get('charshadow');
  const MAX_DARK = flag != null && flag !== '' && +flag > 0 && +flag <= 1 ? +flag : 0.85;
  const ON = !(flag === '0' || flag === 'off' || flag === 'false');
  const NC = 4;   // capsules: left leg, right leg, torso, head
  const sstep = (a, b, v) => { const t = (v - a) / (b - a), u = t < 0 ? 0 : t > 1 ? 1 : t; return u * u * (3 - 2 * u); };

  // ── pure reference maths (numbers only; the TSL below is the same formulas) ───────────────────────────────────────────────────
  // closest approach of segment P(t) = p + t*d (t in 0..1) and segment Q(s) = a + s*e (s in 0..1). out = [dist, t, s]. Handles parallel / degenerate segments.
  function segSeg(px, py, pz, dx, dy, dz, ax, ay, az, ex, ey, ez, out) {
    const rx = px - ax, ry = py - ay, rz = pz - az, A = dx * dx + dy * dy + dz * dz, E = Math.max(ex * ex + ey * ey + ez * ez, 1e-8), F = ex * rx + ey * ry + ez * rz;
    const C = dx * rx + dy * ry + dz * rz, B = dx * ex + dy * ey + dz * ez, den = A * E - B * B, A1 = Math.max(A, 1e-8);
    let t = den > 1e-7 * A1 * E ? (B * F - C * E) / den : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    let s = (B * t + F) / E;
    if (s < 0 || s > 1) { s = s < 0 ? 0 : 1; t = (B * s - C) / A1; t = t < 0 ? 0 : t > 1 ? 1 : t; }
    const cx = px + dx * t - (ax + ex * s), cy = py + dy * t - (ay + ey * s), cz = pz + dz * t - (az + ez * s);
    out[0] = Math.sqrt(cx * cx + cy * cy + cz * cz); out[1] = t; out[2] = s; return out;
  }
  const _o = [0, 0, 0];
  // occlusion (0 = lit .. 1 = fully shadowed) of receiver P (normal n) from a lamp L (radius lr) by ONE capsule a-b radius r. self-exclusion included.
  function capsuleOcc(P, N, L, a, b, r, lr) {
    const dx = L[0] - P[0], dy = L[1] - P[1], dz = L[2] - P[2], ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    segSeg(P[0], P[1], P[2], dx, dy, dz, a[0], a[1], a[2], ex, ey, ez, _o);
    const w = lr * _o[1] + 0.06 * r + 0.01, occ = 1 - sstep(r - w, r + w, _o[0]);
    // is P the capsule itself? (inside the inflated hull and facing away from the axis)
    const E = Math.max(ex * ex + ey * ey + ez * ez, 1e-8); let sp = ((P[0] - a[0]) * ex + (P[1] - a[1]) * ey + (P[2] - a[2]) * ez) / E; sp = sp < 0 ? 0 : sp > 1 ? 1 : sp;
    const vx = P[0] - (a[0] + ex * sp), vy = P[1] - (a[1] + ey * sp), vz = P[2] - (a[2] + ez * sp), dp = Math.max(Math.sqrt(vx * vx + vy * vy + vz * vz), 1e-6);
    const out = (N[0] * vx + N[1] * vy + N[2] * vz) / dp, self = (1 - sstep(1.2 * r, 1.7 * r, dp)) * sstep(-0.1, 0.4, out);
    return occ * (1 - self);
  }
  // the board: oriented ellipsoid. c = centre, X/Y/Z = world axes divided by their semi-axis (so local = (dot(v,X), dot(v,Y), dot(v,Z)) is the unit-sphere space), mean = mean semi-axis.
  function ellipsoidOcc(P, L, c, X, Y, Z, mean, lr) {
    const vx = P[0] - c[0], vy = P[1] - c[1], vz = P[2] - c[2], dx = L[0] - P[0], dy = L[1] - P[1], dz = L[2] - P[2];
    const p0 = vx * X[0] + vy * X[1] + vz * X[2], p1 = vx * Y[0] + vy * Y[1] + vz * Y[2], p2 = vx * Z[0] + vy * Z[1] + vz * Z[2];
    const d0 = dx * X[0] + dy * X[1] + dz * X[2], d1 = dx * Y[0] + dy * Y[1] + dz * Y[2], d2 = dx * Z[0] + dy * Z[1] + dz * Z[2];
    const dd = Math.max(d0 * d0 + d1 * d1 + d2 * d2, 1e-8); let t = -(p0 * d0 + p1 * d1 + p2 * d2) / dd; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = p0 + d0 * t, qy = p1 + d1 * t, qz = p2 + d2 * t, dist = Math.sqrt(qx * qx + qy * qy + qz * qz), w = lr * t / Math.max(mean, 1e-3) + 0.05;
    const self = 1 - sstep(1.0, 1.35, Math.sqrt(p0 * p0 + p1 * p1 + p2 * p2));
    return (1 - sstep(1 - w, 1 + w, dist)) * (1 - self);
  }
  // body = { cap: [[a, b, r] x NC], board: null | { c, X, Y, Z, mean }, lr }. range = the light's reach. Returns the visibility 0..1 (1 = lit).
  function visibility(P, N, L, range, body, maxDark) {
    const dx = L[0] - P[0], dy = L[1] - P[1], dz = L[2] - P[2], D = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (D > range * 1.02 || D < 1e-4) return 1;
    let lit = 1; const lr = body.lr;
    for (let i = 0; i < body.cap.length; i++) { const c = body.cap[i]; lit *= 1 - capsuleOcc(P, N, L, c[0], c[1], c[2], lr); }
    if (body.board) lit *= 1 - ellipsoidOcc(P, L, body.board.c, body.board.X, body.board.Y, body.board.Z, body.board.mean, lr);
    const strength = (1 - sstep(0.45, 1.0, D / range)) * (maxDark == null ? MAX_DARK : maxDark);
    return 1 - strength * (1 - lit);
  }
  // exact reference (tests): the lamp is a disc of radius lr facing P, sampled n x n; each ray P -> sample is tested against the capsules (exact segment/capsule via segSeg) and the
  // ellipsoid (exact ray/ellipsoid), the visible fraction is returned. No self exclusion (test receivers are not on the occluder).
  function bruteVisibility(P, L, body, n) {
    const dx = L[0] - P[0], dy = L[1] - P[1], dz = L[2] - P[2], D = Math.sqrt(dx * dx + dy * dy + dz * dz), ux = dx / D, uy = dy / D, uz = dz / D;
    let ax = Math.abs(ux) < 0.9 ? 1 : 0, ay = ax ? 0 : 1, az = 0; let tx = uy * az - uz * ay, ty = uz * ax - ux * az, tz = ux * ay - uy * ax; const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const bx = uy * tz - uz * ty, by = uz * tx - ux * tz, bz = ux * ty - uy * tx; let vis = 0, cnt = 0; const o = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const u = (i + 0.5) / n * 2 - 1, v = (j + 0.5) / n * 2 - 1; if (u * u + v * v > 1) continue; cnt++;
      const sx = L[0] + (tx * u + bx * v) * body.lr, sy = L[1] + (ty * u + by * v) * body.lr, sz = L[2] + (tz * u + bz * v) * body.lr, rx = sx - P[0], ry = sy - P[1], rz = sz - P[2];
      let hit = false;
      for (const c of body.cap) { segSeg(P[0], P[1], P[2], rx, ry, rz, c[0][0], c[0][1], c[0][2], c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2], o); if (o[0] < c[2]) { hit = true; break; } }
      if (!hit && body.board) {
        const bd = body.board, vx = P[0] - bd.c[0], vy = P[1] - bd.c[1], vz = P[2] - bd.c[2];
        const p0 = vx * bd.X[0] + vy * bd.X[1] + vz * bd.X[2], p1 = vx * bd.Y[0] + vy * bd.Y[1] + vz * bd.Y[2], p2 = vx * bd.Z[0] + vy * bd.Z[1] + vz * bd.Z[2];
        const d0 = rx * bd.X[0] + ry * bd.X[1] + rz * bd.X[2], d1 = rx * bd.Y[0] + ry * bd.Y[1] + rz * bd.Y[2], d2 = rx * bd.Z[0] + ry * bd.Z[1] + rz * bd.Z[2];
        const A = d0 * d0 + d1 * d1 + d2 * d2, Bq = p0 * d0 + p1 * d1 + p2 * d2, Cq = p0 * p0 + p1 * p1 + p2 * p2 - 1, disc = Bq * Bq - A * Cq;
        if (disc > 0) { const t = (-Bq - Math.sqrt(disc)) / A, t2 = (-Bq + Math.sqrt(disc)) / A; if ((t >= 0 && t <= 1) || (t < 0 && t2 > 0)) hit = true; }
      }
      if (!hit) vis++;
    }
    return vis / Math.max(cnt, 1);
  }

  // ── TSL ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const S = { THREE: null, TS: null, U: null, fn: null, handles: [], frame: 0, body: false, board: false, enabled: true, dbg: { lit: 0 } };
  function ensure(THREE) {
    if (S.U) return S.U;
    const TS = THREE && THREE.TSL; if (!TS || typeof TS.uniform !== 'function' || typeof TS.Fn !== 'function' || typeof TS.If !== 'function' || !TS.positionWorld || !TS.normalWorld || typeof TS.select !== 'function') return null;
    S.THREE = THREE; S.TS = TS; const V4 = () => new THREE.Vector4(), u4 = () => { const n = TS.uniform(V4()); if (TS.renderGroup && n.setGroup) n.setGroup(TS.renderGroup); return n; };
    const U = { cA: [], cB: [], bC: u4(), bX: u4(), bY: u4(), bZ: u4(), k: TS.uniform(0), lr: TS.uniform(0.8), dark: TS.uniform(MAX_DARK) };
    for (let i = 0; i < NC; i++) { U.cA.push(u4()); U.cB.push(u4()); }
    if (TS.renderGroup) { U.k.setGroup(TS.renderGroup); U.lr.setGroup(TS.renderGroup); U.dark.setGroup(TS.renderGroup); }
    S.U = U; return U;
  }
  // the visibility node of one light: Lp = world position uniform (vec3), range = uniform float, en = uniform float (0/1)
  function visNode(Lp, range, en, lrNode) {
    const TS = S.TS, U = S.U, { Fn, If, float, vec3, dot, length, clamp, max, min, smoothstep, select, positionWorld, normalWorld } = TS;
    const sst = (a, b, v) => smoothstep(a, b, v);
    const seg = (p, d, a, e) => {   // -> vec3(dist, t, s)
      const r = p.sub(a), A = max(dot(d, d), 1e-8), E = max(dot(e, e), 1e-8), F = dot(e, r), C = dot(d, r), B = dot(d, e), den = A.mul(E).sub(B.mul(B));
      const t0 = clamp(select(den.greaterThan(A.mul(E).mul(1e-7)), B.mul(F).sub(C.mul(E)).div(max(den, 1e-12)), float(0)), 0, 1), s0 = B.mul(t0).add(F).div(E);
      const sc = clamp(s0, 0, 1), out = s0.lessThan(0).or(s0.greaterThan(1)), t1 = clamp(B.mul(sc).sub(C).div(A), 0, 1), t = select(out, t1, t0);
      return vec3(length(p.add(d.mul(t)).sub(a.add(e.mul(sc)))), t, sc);
    };
    return Fn(() => {
      const lit = float(1).toVar();
      If(en.greaterThan(0.5), () => {
        const P = positionWorld, N = normalWorld.normalize(), d = Lp.sub(P), D = length(d);
        If(D.lessThan(range.mul(1.02)).and(D.greaterThan(1e-4)).and(U.k.greaterThan(0.001)), () => {
          for (let i = 0; i < NC; i++) {
            const a = U.cA[i].xyz, r = U.cA[i].w, e = U.cB[i].xyz.sub(a), sd = seg(P, d, a, e), w = lrNode.mul(sd.y).add(r.mul(0.06)).add(0.01), occ = float(1).sub(sst(r.sub(w), r.add(w), sd.x));
            const E = max(dot(e, e), 1e-8), sp = clamp(dot(P.sub(a), e).div(E), 0, 1), v = P.sub(a.add(e.mul(sp))), dp = max(length(v), 1e-6), outw = dot(N, v).div(dp);
            const self = float(1).sub(sst(r.mul(1.2), r.mul(1.7), dp)).mul(sst(-0.1, 0.4, outw));
            lit.mulAssign(float(1).sub(occ.mul(float(1).sub(self))));
          }
          // board: unit-sphere space
          const bc = U.bC.xyz, mean = U.bC.w, v = P.sub(bc), p = vec3(dot(v, U.bX.xyz), dot(v, U.bY.xyz), dot(v, U.bZ.xyz)), dd = vec3(dot(d, U.bX.xyz), dot(d, U.bY.xyz), dot(d, U.bZ.xyz));
          const tb = clamp(dot(p, dd).negate().div(max(dot(dd, dd), 1e-8)), 0, 1), dist = length(p.add(dd.mul(tb))), wb = lrNode.mul(tb).div(max(mean, 1e-3)).add(0.05);
          const selfB = float(1).sub(sst(1.0, 1.35, length(p))), occB = float(1).sub(sst(float(1).sub(wb), float(1).add(wb), dist)).mul(float(1).sub(selfB));
          lit.mulAssign(float(1).sub(occB.mul(U.bX.w)));   // bX.w = board present (0/1)
        });
      });
      const D2 = length(Lp.sub(positionWorld)), strength = float(1).sub(sst(range.mul(0.45), range, D2)).mul(U.dark).mul(U.k);
      return float(1).sub(strength.mul(float(1).sub(lit)));
    })();
  }

  // ── lights ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // attach(light, { range (default light.distance), radius (lamp size, world units, default 0.8), gate (optional TSL float node multiplied into the colour: room masks) })
  // -> handle { light, en, range, col, pos } or false (flag off / no TSL). The light's colour (colour x intensity) and position are mirrored into uniforms by tick(): do not set
  // light.colorNode yourself. Max 8 lights.
  function attach(light, o) {
    o = o || {}; const THREE = o.THREE || G.THREE, U = ensure(THREE); if (!U || !light || S.handles.length >= 8) return false;
    const TS = S.TS, col = TS.uniform(new THREE.Color(0, 0, 0)), pos = TS.uniform(new THREE.Vector3()), range = TS.uniform(o.range || light.distance || 30), en = TS.uniform(0);
    if (TS.renderGroup) { col.setGroup(TS.renderGroup); pos.setGroup(TS.renderGroup); range.setGroup(TS.renderGroup); en.setGroup(TS.renderGroup); }
    const lrN = o.radius != null ? TS.float(o.radius) : U.lr;
    let node = col.mul(visNode(pos, range, en, lrN)); if (o.gate) node = node.mul(o.gate);
    light.colorNode = node; light.userData.dmCharShadow = true;
    const h = { light, en, range, col, pos, on: true, dist: Infinity };
    S.handles.push(h); return h;
  }
  function detach(h) { const i = S.handles.indexOf(h); if (i >= 0) S.handles.splice(i, 1); }

  // ── body (per frame) ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  const _bp = {};   // bone name -> [x,y,z] scratch
  const BN = ['Hips', 'neck', 'Head', 'LeftUpLeg', 'LeftFoot', 'RightUpLeg', 'RightFoot'];
  for (const n of BN) _bp[n] = [0, 0, 0];
  function boneP(bones, n) { const b = bones && bones[n]; if (!b || !b.matrixWorld) return null; const e = b.matrixWorld.elements, o = _bp[n]; o[0] = e[12]; o[1] = e[13]; o[2] = e[14]; return o; }
  // CPU mirror of the uniforms (tests, and the lamp code asks `body()` for the en-radius test). cap = [[a,b,r] x NC]
  const BODY = { cap: [[[0, 0, 0], [0, 0, 0], 0], [[0, 0, 0], [0, 0, 0], 0], [[0, 0, 0], [0, 0, 0], 0], [[0, 0, 0], [0, 0, 0], 0]], board: null, lr: 0.8, c: [0, 0, 0], h: 0 };
  const _B = { c: [0, 0, 0], X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], mean: 1 };
  // body from bone world positions (pure): H = total height proxy; radii scale with it.
  function bodyFromBones(P, out) {
    const hips = P.hips, neck = P.neck, head = P.head, lu = P.lu, lf = P.lf, ru = P.ru, rf = P.rf;
    const mf = [(lf[0] + rf[0]) / 2, (lf[1] + rf[1]) / 2, (lf[2] + rf[2]) / 2], H = Math.max(Math.hypot(head[0] - mf[0], head[1] - mf[1], head[2] - mf[2]), 0.3);
    const set = (i, a, b, r) => { const c = out.cap[i]; c[0][0] = a[0]; c[0][1] = a[1]; c[0][2] = a[2]; c[1][0] = b[0]; c[1][1] = b[1]; c[1][2] = b[2]; c[2] = r; };
    set(0, lu, lf, 0.085 * H); set(1, ru, rf, 0.085 * H); set(2, hips, neck, 0.125 * H);
    // head: from the neck up through the head bone, a little beyond it (the skull top)
    const hx = head[0] - neck[0], hy = head[1] - neck[1], hz = head[2] - neck[2], hl = Math.max(Math.hypot(hx, hy, hz), 1e-4), top = [head[0] + hx / hl * 0.07 * H, head[1] + hy / hl * 0.07 * H, head[2] + hz / hl * 0.07 * H];
    set(3, neck, top, 0.085 * H); out.h = H; out.c[0] = hips[0]; out.c[1] = hips[1]; out.c[2] = hips[2]; return out;
  }
  const _P = { hips: null, neck: null, head: null, lu: null, lf: null, ru: null, rf: null };
  // CHAR = the game's character record (bones, root); board = THREE.Object3D or null. Writes the uniforms. Returns true when the body is active.
  function setBody(CHAR, board) {
    const U = S.U; if (!U) return false;
    let ok = ON && S.enabled && !!(CHAR && CHAR.loaded && CHAR.root && CHAR.root.visible && CHAR.bones);
    if (ok) {
      _P.hips = boneP(CHAR.bones, 'Hips'); _P.neck = boneP(CHAR.bones, 'neck') || boneP(CHAR.bones, 'Head'); _P.head = boneP(CHAR.bones, 'Head');
      _P.lu = boneP(CHAR.bones, 'LeftUpLeg'); _P.lf = boneP(CHAR.bones, 'LeftFoot'); _P.ru = boneP(CHAR.bones, 'RightUpLeg'); _P.rf = boneP(CHAR.bones, 'RightFoot');
      ok = !!(_P.hips && _P.neck && _P.head && _P.lu && _P.lf && _P.ru && _P.rf) && isFinite(_P.hips[0] + _P.hips[1] + _P.hips[2] + _P.head[1]);
    }
    if (ok) {
      bodyFromBones(_P, BODY);
      for (let i = 0; i < NC; i++) { const c = BODY.cap[i]; U.cA[i].value.set(c[0][0], c[0][1], c[0][2], c[2]); U.cB[i].value.set(c[1][0], c[1][1], c[1][2], 0); }
    }
    S.body = ok && ON;
    let bd = false;
    if (ok && board && board.visible !== false && board.matrixWorld) bd = boardOBB(board, _B);
    if (bd) { U.bC.value.set(_B.c[0], _B.c[1], _B.c[2], _B.mean); U.bX.value.set(_B.X[0], _B.X[1], _B.X[2], 1); U.bY.value.set(_B.Y[0], _B.Y[1], _B.Y[2], 0); U.bZ.value.set(_B.Z[0], _B.Z[1], _B.Z[2], 0); BODY.board = _B; }
    else { U.bX.value.w = 0; BODY.board = null; }
    S.board = bd; U.k.value = ok && ON ? 1 : 0; return ok && ON;
  }
  // board OBB from its world matrix + a cached local box (first call measures the meshes once). Semi axes are inflated by 8 % so the ellipsoid covers most of the box.
  function boardOBB(board, out) {
    let bb = board.userData.dmCsBox;
    if (!bb) {
      try {
        const T = S.THREE; board.updateMatrixWorld(true); const inv = new T.Matrix4().copy(board.matrixWorld).invert(), box = new T.Box3(), tmp = new T.Box3(), m = new T.Matrix4();
        board.traverse(o => { if (!o.isMesh || !o.geometry) return; if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); tmp.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)); box.union(tmp); });
        if (box.isEmpty()) return false; const c = box.getCenter(new T.Vector3()), h = box.getSize(new T.Vector3()).multiplyScalar(0.5);
        bb = board.userData.dmCsBox = { c: [c.x, c.y, c.z], h: [Math.max(h.x, 0.02), Math.max(h.y, 0.02), Math.max(h.z, 0.02)] };
      } catch (e) { return false; }
    }
    const e = board.matrixWorld.elements, ax = [e[0], e[1], e[2]], ay = [e[4], e[5], e[6]], az = [e[8], e[9], e[10]], sx = Math.hypot(ax[0], ax[1], ax[2]) || 1, sy = Math.hypot(ay[0], ay[1], ay[2]) || 1, sz = Math.hypot(az[0], az[1], az[2]) || 1;
    const hx = bb.h[0] * sx * 1.08, hy = bb.h[1] * sy * 1.08, hz = bb.h[2] * sz * 1.08, cx = bb.c[0], cy = bb.c[1], cz = bb.c[2];
    out.c[0] = e[0] * cx + e[4] * cy + e[8] * cz + e[12]; out.c[1] = e[1] * cx + e[5] * cy + e[9] * cz + e[13]; out.c[2] = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
    for (let i = 0; i < 3; i++) { out.X[i] = ax[i] / sx / hx; out.Y[i] = ay[i] / sy / hy; out.Z[i] = az[i] / sz / hz; }
    out.mean = (hx + hy + hz) / 3; return isFinite(out.c[0] + out.c[1] + out.c[2] + out.mean);
  }
  const _wp = [0, 0, 0];
  // per frame, once. CHAR + the board; mirrors every attached light's colour x intensity and world position, and switches `en` by distance to her.
  function tick(CHAR, board, dt) {
    if (!S.U) return; S.frame++;
    const ok = setBody(CHAR, board);
    for (let i = 0; i < S.handles.length; i++) {
      const h = S.handles[i], L = h.light; if (!L) continue;
      const m = L.matrixWorld.elements; h.pos.value.set(m[12], m[13], m[14]);
      const I = h.on ? L.intensity : 0; h.col.value.setRGB(L.color.r * I, L.color.g * I, L.color.b * I);
      h.range.value = L.distance > 0 ? L.distance : h.range.value;
      let near = 0; if (ok && I > 0.001) { const dx = m[12] - BODY.c[0], dy = m[13] - BODY.c[1], dz = m[14] - BODY.c[2], r = h.range.value + 4 + BODY.h; near = dx * dx + dy * dy + dz * dz < r * r ? 1 : 0; }
      h.en.value = near;
    }
  }
  // DMBudget shedding (ui/dm-lamps.js lampPlan.ch): off = no body, no per-pixel work at all (the colour nodes stay, `en` = 0), no recompile
  function setEnabled(v) { S.enabled = !!v; }
  function status() { return { on: !!S.U, flag: ON, enabled: S.enabled, body: S.body, board: S.board, lights: S.handles.length, active: S.handles.filter(h => h.en.value > 0.5).length, maxDark: MAX_DARK }; }

  const API = { on: ON, ensure, attach, detach, tick, setBody, setEnabled, status, maxDark: MAX_DARK, S, BODY, _visNode: visNode,
    core: { segSeg, capsuleOcc, ellipsoidOcc, visibility, bruteVisibility, bodyFromBones, boardOBB, sstep, NC, MAX_DARK } };
  G.DMCharShadow = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
