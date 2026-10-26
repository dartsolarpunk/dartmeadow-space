/* DART Meadow — local real-time liquid: APIC (FLIP/APIC blend) on a sparse grid (crunch1 fluids).
 *
 * A few small dense bricks (the "sparse grid"): brick 0 follows Ariel, the others are dropped on impact points
 * (her board hitting the sea, a dive, a hard landing) and retire after a few seconds. Each brick is a B^3 node grid
 * (collocated, MLS-MPM style APIC transfer with quadratic B-spline weights). Per step, all WebGPU compute:
 *   clear -> P2G (mass + affine momentum, fixed-point atomics) -> grid normalise -> grid forces
 *   (weakly-compressible pressure from node mass, gravity, solid bodies, impulses, ocean coupling at the brick
 *   walls and floor) -> G2P (APIC velocity + affine C, blended with FLIP by `flip`) + advection + respawn.
 * Coupling to the far ocean: the walls/floor of every brick are driven by the same wave field the sea sheet
 * draws (DMFluidCore.waveTSL), and particles that leave a brick re-enter as calm ocean water under the swell.
 * Breaking / impact regions (fast water above the swell) emit white water into DMFluidSpray (PBF).
 * Rendering: cheap instanced splats; calm water is invisible (the sea sheet shows), disturbed water shows.
 */
(function () {
  'use strict';
  const W = window;

  function create(scene, o) {
    const T = W, THREE = W.THREE, C = W.DMFluidCore;
    const { Fn, If, Return, float, int, uint, vec3, vec4, uniform, uniformArray, instancedArray, instanceIndex,
      atomicAdd, atomicStore, atomicLoad, floor, max, min, clamp, dot, length, normalize, mix, exp, smoothstep, select, uv } = T;
    const bud = o.budget;
    const B = bud.B, B3 = B * B * B, NB = Math.max(1, bud.bricks), h = bud.h;
    const wetCells = B * B * Math.round(B * 0.55);
    const PER = Math.ceil(wetCells * bud.ppc / 64) * 64;   // particles per brick
    const N = PER * NB, NG = B3 * NB;
    const SM = 65536.0, SP = 4096.0;    // fixed-point scales: mass, momentum

    // packed to stay under 8 storage buffers per stage (mobile limit): particle = 5 vec4, node = 4 ints / 3 vec4
    const pD = instancedArray(N * 5, 'vec4');
    const gA = instancedArray(NG * 4, 'int').toAtomic();
    const gG = instancedArray(NG * 3, 'vec4');
    const pf = (i, k) => pD.element(uint(i).mul(uint(5)).add(uint(k)));
    const pPos = { element: (i) => pf(i, 0) }, pVel = { element: (i) => pf(i, 1) };
    const pC0 = { element: (i) => pf(i, 2) }, pC1 = { element: (i) => pf(i, 3) }, pC2 = { element: (i) => pf(i, 4) };
    const ga = (k) => ({ element: (i) => gA.element(uint(i).mul(uint(4)).add(uint(k))) });
    const gM = ga(0), gX = ga(1), gY = ga(2), gZ = ga(3);
    const gg = (k) => ({ element: (i) => gG.element(uint(i).mul(uint(3)).add(uint(k))) });
    const gV = gg(0), gO = gg(1), gW = gg(2);

    const origins = [], bodies = [], bodyV = [], imps = [], impA = [];
    for (let i = 0; i < NB; i++) origins.push(new THREE.Vector4(0, 0, 0, 0));
    for (let i = 0; i < 3; i++) { bodies.push(new THREE.Vector4(0, -1e6, 0, 0)); bodyV.push(new THREE.Vector4()); }
    for (let i = 0; i < 4; i++) { imps.push(new THREE.Vector4(0, -1e6, 0, 0)); impA.push(new THREE.Vector4()); }
    const U = {
      origin: uniformArray(origins, 'vec4'), body: uniformArray(bodies, 'vec4'), bodyV: uniformArray(bodyV, 'vec4'),
      imp: uniformArray(imps, 'vec4'), impA: uniformArray(impA, 'vec4'),
      dt: uniform(1 / 60), t: uniform(0), frame: uniform(0, 'uint'), seaY: uniform(o.seaY || 0),
      flip: uniform(0.85), stiff: uniform(6.0), m0: uniform(bud.ppc * 1.0), g: uniform(-9.81),
      active: uniform(N, 'uint'), emit: uniform(0.35), tint: uniform(new THREE.Color(o.color != null ? o.color : 0x1a4a7a))
    };
    const spray = o.spray || null;

    const brickOf = (i) => int(uint(i).div(uint(PER)));
    const gidx = (b, ix, iy, iz) => b.mul(B3).add(iz.mul(B * B)).add(iy.mul(B)).add(ix);
    const wave = (x, z) => C.waveTSL(x, z, U.t);

    // K0 clear
    const kClear = Fn(() => {
      atomicStore(gA.element(instanceIndex), int(0));
    })().compute(NG * 4, [64]);

    const weights = (fx) => [
      fx.oneMinus().add(0.5).pow(2).mul(0.5),                     // 0.5 (1.5 - fx)^2
      float(0.75).sub(fx.sub(1.0).pow(2)),                        // 0.75 - (fx - 1)^2
      fx.sub(0.5).pow(2).mul(0.5)                                 // 0.5 (fx - 0.5)^2
    ];

    // K1 P2G
    const kP2G = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(U.active), () => { Return(); });
      const P = pPos.element(i);
      If(P.w.lessThan(0.5), () => { Return(); });
      const b = brickOf(i), org = U.origin.element(b);
      If(org.w.lessThan(0.5), () => { Return(); });
      const x = P.xyz.sub(org.xyz).div(h);
      const base = clamp(floor(x.sub(0.5)), vec3(0.0), vec3(B - 3)).toVar();
      const fx = x.sub(base).toVar();
      const w = weights(fx);
      const v = pVel.element(i).xyz.toVar();
      const c0 = pC0.element(i).xyz.toVar(), c1 = pC1.element(i).xyz.toVar(), c2 = pC2.element(i).xyz.toVar();
      const bi = int(base.x), bj = int(base.y), bk = int(base.z);
      for (let a = 0; a < 3; a++) for (let bb = 0; bb < 3; bb++) for (let c = 0; c < 3; c++) {
        const wt = w[a].x.mul(w[bb].y).mul(w[c].z);
        const dp = vec3(a, bb, c).sub(fx).mul(h);
        const mv = v.add(vec3(dot(c0, dp), dot(c1, dp), dot(c2, dp))).mul(wt);
        const gi = gidx(b, bi.add(a), bj.add(bb), bk.add(c));
        atomicAdd(gM.element(gi), int(floor(wt.mul(SM).add(0.5))));
        atomicAdd(gX.element(gi), int(floor(mv.x.mul(SP).add(0.5))));
        atomicAdd(gY.element(gi), int(floor(mv.y.mul(SP).add(0.5))));
        atomicAdd(gZ.element(gi), int(floor(mv.z.mul(SP).add(0.5))));
      }
    })().compute(N, [64]);

    // K2 grid normalise: momentum -> velocity (keeps the pre-force copy for FLIP)
    const kNorm = Fn(() => {
      const i = instanceIndex;
      const m = float(atomicLoad(gM.element(i))).div(SM);
      const mom = vec3(float(atomicLoad(gX.element(i))), float(atomicLoad(gY.element(i))), float(atomicLoad(gZ.element(i)))).div(SP);
      const v = select(m.greaterThan(1e-4), mom.div(max(m, 1e-4)), vec3(0.0));
      gV.element(i).assign(vec4(v, m)); gO.element(i).assign(vec4(v, m));
    })().compute(NG, [64]);

    // K3 grid forces + boundaries (reads gV, writes gW)
    const kForce = Fn(() => {
      const i = instanceIndex;
      const b = int(uint(i).div(uint(B3))), r = int(uint(i).mod(uint(B3)));
      const ix = r.mod(B), iy = r.div(B).mod(B), iz = r.div(B * B);
      const org = U.origin.element(b);
      const g = gV.element(i);
      const v = g.xyz.toVar(), m = g.w;
      const pAt = (jx, jy, jz) => {
        const mm = gV.element(gidx(b, clamp(jx, int(0), int(B - 1)), clamp(jy, int(0), int(B - 1)), clamp(jz, int(0), int(B - 1)))).w;
        return max(mm.div(U.m0).sub(1.0), -0.05).mul(U.stiff);
      };
      If(m.greaterThan(1e-4), () => {
        const grad = vec3(pAt(ix.add(1), iy, iz).sub(pAt(ix.sub(1), iy, iz)),
          pAt(ix, iy.add(1), iz).sub(pAt(ix, iy.sub(1), iz)),
          pAt(ix, iy, iz.add(1)).sub(pAt(ix, iy, iz.sub(1)))).div(2.0 * h);
        const rho = max(m.div(U.m0), 0.5);
        v.addAssign(grad.div(rho).negate().mul(U.dt));
        v.y.addAssign(U.g.mul(U.dt));
        const wp = org.xyz.add(vec3(float(ix), float(iy), float(iz)).mul(h));
        // solid bodies (her, the board): no flow into them
        for (let k = 0; k < 3; k++) {
          const S = U.body.element(k), SV = U.bodyV.element(k).xyz;
          const d = wp.sub(S.xyz), dl = length(d);
          If(dl.lessThan(S.w), () => {
            const n = d.div(max(dl, 1e-3)), rel = v.sub(SV), vn = dot(rel, n);
            If(vn.lessThan(0.0), () => { v.subAssign(n.mul(vn)); });
            v.assign(mix(v, SV, 0.25)).addAssign(n.mul(S.w.sub(dl).mul(12.0)));
          });
        }
        // impulses: downwash under the board, crowns from impacts
        for (let k = 0; k < 4; k++) {
          const I = U.imp.element(k), A = U.impA.element(k);
          const d = wp.sub(I.xyz), dh = vec3(d.x, 0.0, d.z), dl = length(d);
          const fall = smoothstep(I.w, I.w.mul(0.25), dl);
          v.addAssign(normalize(dh.add(vec3(1e-4, 0, 0))).mul(A.x).add(vec3(0.0, A.y, 0.0)).mul(fall).mul(U.dt));
        }
      });
      // ocean coupling: walls and floor follow the sea's own orbital motion
      const edge = min(min(min(ix, iz), min(int(B - 1).sub(ix), int(B - 1).sub(iz))), iy);
      If(edge.lessThan(3), () => {
        const wp = org.xyz.add(vec3(float(ix), float(iy), float(iz)).mul(h));
        const wv = wave(wp.x, wp.z), depth = min(wp.y.sub(U.seaY), 0.0);
        const ov = wv.vel.mul(exp(depth.mul(0.25)));
        const k = select(edge.lessThan(2), float(1.0), float(0.5));
        v.assign(mix(v, ov, k));
      });
      gW.element(i).assign(vec4(v, m));
    })().compute(NG, [64]);

    // K4 G2P + advect + respawn + white-water emission
    const kG2P = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(U.active), () => { Return(); });
      const b = brickOf(i), org = U.origin.element(b);
      const P = pPos.element(i), V = pVel.element(i);
      If(org.w.lessThan(0.5), () => { P.w.assign(0.0); Return(); });
      const x = P.xyz.sub(org.xyz).div(h);
      const alive = P.w.greaterThan(0.5);
      const base = clamp(floor(x.sub(0.5)), vec3(0.0), vec3(B - 3)).toVar();
      const fx = x.sub(base).toVar();
      const w = weights(fx);
      const vp = vec3(0).toVar(), dv = vec3(0).toVar();
      const c0 = vec3(0).toVar(), c1 = vec3(0).toVar(), c2 = vec3(0).toVar();
      const bi = int(base.x), bj = int(base.y), bk = int(base.z);
      for (let a = 0; a < 3; a++) for (let bb = 0; bb < 3; bb++) for (let c = 0; c < 3; c++) {
        const wt = w[a].x.mul(w[bb].y).mul(w[c].z);
        const dp = vec3(a, bb, c).sub(fx).mul(h);
        const gi = gidx(b, bi.add(a), bj.add(bb), bk.add(c));
        const gw = gW.element(gi).xyz, go = gO.element(gi).xyz;
        const wv = gw.mul(wt);
        vp.addAssign(wv); dv.addAssign(gw.sub(go).mul(wt));
        c0.addAssign(dp.mul(wv.x)); c1.addAssign(dp.mul(wv.y)); c2.addAssign(dp.mul(wv.z));
      }
      const Dinv = 4.0 / (h * h);
      const vn = mix(vp, V.xyz.add(dv), U.flip).toVar();
      const vmax = float(h * 0.9).div(max(U.dt, 1e-3));
      const sp = length(vn);
      If(sp.greaterThan(vmax), () => { vn.mulAssign(vmax.div(sp)); });
      const np = P.xyz.add(vn.mul(U.dt)).toVar();
      const nx = np.sub(org.xyz).div(h);
      const out = nx.x.lessThan(1.2).or(nx.y.lessThan(1.2)).or(nx.z.lessThan(1.2))
        .or(nx.x.greaterThan(B - 2.2)).or(nx.y.greaterThan(B - 2.2)).or(nx.z.greaterThan(B - 2.2))
        .or(alive.not()).or(sp.notEqual(sp));
      const wv = wave(np.x, np.z);
      If(out, () => {
        // re-enter as calm ocean under the swell
        const s = uint(i).mul(uint(3)).add(U.frame.mul(uint(7919)));
        const r1 = C.hashTSL(s), r2 = C.hashTSL(s.add(uint(1))), r3 = C.hashTSL(s.add(uint(2)));
        const lx = mix(float(2.0), float(B - 3), r1), lz = mix(float(2.0), float(B - 3), r3);
        const wx = org.x.add(lx.mul(h)), wz = org.z.add(lz.mul(h));
        const w2 = wave(wx, wz);
        const top = min(U.seaY.add(w2.h).sub(org.y).div(h).sub(0.3), float(B - 3));
        const ly = mix(float(2.0), max(top, 2.1), r2.sqrt());
        P.assign(vec4(wx, org.y.add(ly.mul(h)), wz, 1.0));
        V.assign(vec4(w2.vel, 0.0));
        pC0.element(i).assign(vec4(0)); pC1.element(i).assign(vec4(0)); pC2.element(i).assign(vec4(0));
      }).Else(() => {
        const ex = length(vn.sub(wv.vel));                       // how far from the calm sea's own motion
        const above = np.y.sub(U.seaY.add(wv.h));
        const energy = mix(V.w, clamp(ex.mul(0.35).add(above.mul(0.8)), 0.0, 1.0), 0.25);
        P.assign(vec4(np, 1.0));
        V.assign(vec4(vn, energy));
        pC0.element(i).assign(vec4(c0.mul(Dinv), 0)); pC1.element(i).assign(vec4(c1.mul(Dinv), 0)); pC2.element(i).assign(vec4(c2.mul(Dinv), 0));
        if (spray) {
          // breaking / impact water: fast, above the swell, rising or thrown -> white water (PBF spray)
          const r = C.hashTSL(uint(i).add(U.frame.mul(uint(104729))));
          If(above.greaterThan(0.15).and(ex.greaterThan(2.2)).and(r.lessThan(U.emit.mul(U.dt).mul(ex.mul(0.4)))), () => {
            const k0 = atomicAdd(spray.counter.element(0), uint(1)).toVar('sprayK');
            const k = k0.mod(uint(spray.N));
            const j = C.hashTSL(uint(i).add(U.frame.mul(uint(31))));
            spray.pos.element(k).assign(vec4(np, float(1.4).add(j.mul(1.6))));
            spray.vel.element(k).assign(vec4(vn.mul(1.1).add(vec3(j.sub(0.5), j.mul(1.2), float(0.5).sub(j)).mul(1.5)), 0.0));
          });
        }
      });
    })().compute(N, [64]);

    // ── render: instanced splats, only where the water is disturbed ──
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const pR = T.storage(pD.value, 'vec4', N * 5).toReadOnly();
    const P = pR.element(instanceIndex.mul(5)), VA = pR.element(instanceIndex.mul(5).add(1));
    mat.positionNode = P.xyz;
    mat.scaleNode = float(h * 1.35);
    const d = uv().sub(0.5).length().mul(2.0);
    const soft = smoothstep(1.0, 0.35, d);
    const en = clamp(VA.w, 0.0, 1.0);
    mat.colorNode = vec4(mix(vec3(U.tint).mul(1.3).add(vec3(0.05, 0.12, 0.14)), vec3(0.92, 0.96, 1.0), en.mul(en)), 1.0);
    const lo = P.xyz.sub(U.origin.element(int(instanceIndex.div(PER))).xyz).div(h);
    const ed = min(min(min(lo.x, lo.z), float(B).sub(lo.x)), float(B).sub(lo.z));
    mat.opacityNode = soft.mul(smoothstep(0.18, 0.6, en)).mul(P.w).mul(smoothstep(2.0, 5.0, ed)).mul(0.85);
    mat.fog = false;
    const sprite = new THREE.Sprite(mat);
    sprite.count = N; sprite.frustumCulled = false; sprite.renderOrder = 4; sprite.name = 'DMFluid_APIC';
    sprite.userData.noBend = true; sprite.raycast = () => {};
    scene.add(sprite);

    const t0 = performance.now();
    let frame = 0;
    const api = {
      N, NB, B, h, PER, U, mesh: sprite, _pD: pD,
      setBrick(k, x, y, z, on) {
        if (k >= NB) return;
        const s = B * h, ox = Math.round((x - s / 2) / h) * h, oy = Math.round((y - s * 0.6) / h) * h, oz = Math.round((z - s / 2) / h) * h;
        U.origin.array[k].set(ox, oy, oz, on ? 1 : 0);
      },
      setBody(k, x, y, z, r, vx, vy, vz) { if (k < 3) { U.body.array[k].set(x, y, z, r); U.bodyV.array[k].set(vx || 0, vy || 0, vz || 0, 0); } },
      setImpulse(k, x, y, z, r, radial, up) { if (k < 4) { U.imp.array[k].set(x, y, z, r); U.impA.array[k].set(radial || 0, up || 0, 0, 0); } },
      step(renderer, dt, scale) {
        dt = Math.min(Math.max(dt, 1 / 240), 1 / 30);
        U.dt.value = dt; U.t.value = C.clock(); U.frame.value = (++frame) >>> 0;
        U.active.value = Math.max(64, Math.floor(N * (scale == null ? 1 : scale)));
        sprite.count = U.active.value;
        C.mark('fluid:apic');
        renderer.compute(kClear); renderer.compute(kP2G); renderer.compute(kNorm); renderer.compute(kForce); renderer.compute(kG2P);
      },
      setVisible(v) { sprite.visible = !!v; },
      dispose() { try { scene.remove(sprite); mat.dispose(); } catch (e) {} for (const k of [pD, gA, gG]) { try { k.value && k.value.dispose && k.value.dispose(); } catch (e) {} } }
    };
    return api;
  }
  W.DMFluidAPIC = { create };
})();
