/* DART Meadow — true-fluid smoke, dust and gas: stable fluids on a low-res grid, raymarched (crunch1 fluids).
 *
 * A small N^3 grid (16..32 per preset) inside a box: velocity + density in a pair of rgba16float 3-D storage
 * textures, pressure in storage buffers. Per step, WebGPU compute (Stam's stable fluids):
 *   semi-Lagrangian advection of velocity and density (A -> B) with buoyancy, wind, emitters, dissipation and a
 *   grid shift (the box can follow the player without the gas jumping)
 *   -> divergence -> Jacobi pressure iterations (budget per preset) -> projection (B, p -> A).
 * Drawn by a box whose fragment raymarches the density with a FIXED step budget (10..24 per preset), one
 * shadow tap toward the sun, clipped by the scene depth where the depth texture can be read.
 *
 *   DMFluidSmoke.create(parent, { budget, size:[x,y,z], color, glow, buoy, diss, mode })
 *     .emit(k, ux,uy,uz, r, vx,vy,vz, rate)   uvw space (0..1), up to 4 emitters
 *     .wind(vx,vy,vz, k) / .shift(dx,dy,dz cells) / .step(renderer, dt) / .setSun(dir) / .dispose()
 */
(function () {
  'use strict';
  const W = window;

  function create(parent, o) {
    const T = W, THREE = W.THREE, C = W.DMFluidCore;
    const { Fn, If, Break, Loop, float, int, uint, vec3, vec4, uniform, uniformArray, instancedArray, instanceIndex,
      texture3D, textureStore, uvec3, max, min, clamp, dot, length, normalize, mix, exp, smoothstep, select, mx_noise_float,
      positionLocal, cameraPosition, modelWorldMatrixInverse, modelWorldMatrix, cameraViewMatrix } = T;
    const bud = o.budget, N = bud.smoke | 0, N3 = N * N * N, MAXS = 32;
    const mk = () => {
      const t = new THREE.Storage3DTexture(N, N, N);
      t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType;
      t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
      return t;
    };
    const A = mk(), Bt = mk();
    const div = instancedArray(N3, 'float'), p0 = instancedArray(N3, 'float'), p1 = instancedArray(N3, 'float');
    const em = [], emV = [];
    for (let i = 0; i < 4; i++) { em.push(new THREE.Vector4(0, 0, 0, 0)); emV.push(new THREE.Vector4()); }
    const U = {
      dt: uniform(1 / 60), t: uniform(0), em: uniformArray(em, 'vec4'), emV: uniformArray(emV, 'vec4'),
      wind: uniform(new THREE.Vector3()), windK: uniform(0.0), buoy: uniform(o.buoy != null ? o.buoy : 0.15),
      diss: uniform(o.diss != null ? o.diss : 0.12), shift: uniform(new THREE.Vector3()), turb: uniform(o.turb != null ? o.turb : 0.25),
      steps: uniform(bud.steps, 'int'), dens: uniform(o.dens != null ? o.dens : 6.0), color: uniform(new THREE.Color(o.color != null ? o.color : 0xd8c8a8)),
      glow: uniform(o.glow || 0), sun: uniform(new THREE.Vector3(0.3, 0.8, 0.2).normalize()), light: uniform(1.0), fade: uniform(1.0)
    };
    const inv = 1 / N;
    const cell = (i) => { const x = i.mod(N), y = i.div(N).mod(N), z = i.div(N * N); return { x, y, z, uvw: vec3(float(x), float(y), float(z)).add(0.5).mul(inv) }; };
    const sA = (uvw) => texture3D(A, uvw, float(0));
    const sB = (uvw) => texture3D(Bt, uvw, float(0));

    // advect A -> B (+ forces, emitters)
    const kAdvect = Fn(() => {
      const c = cell(instanceIndex);
      const here = sA(c.uvw.add(U.shift.mul(inv)));
      const back = c.uvw.add(U.shift.mul(inv)).sub(here.xyz.mul(U.dt));
      const s = sA(back);
      const d = s.w.mul(max(float(0.0), float(1.0).sub(U.diss.mul(U.dt)))).toVar();
      const v = s.xyz.toVar();
      v.y.addAssign(U.buoy.mul(d).mul(U.dt));
      v.assign(mix(v, U.wind, clamp(U.windK.mul(U.dt), 0.0, 1.0)));
      // a little resolved turbulence (noise forcing; the solver keeps it divergence-free)
      const q = c.uvw.mul(4.0).add(vec3(U.t.mul(0.13), 0.0, U.t.mul(0.07)));
      v.addAssign(vec3(mx_noise_float(q), mx_noise_float(q.add(17.3)), mx_noise_float(q.add(41.7))).mul(U.turb.mul(U.dt).mul(d.min(1.0))));
      for (let k = 0; k < 4; k++) {
        const E = U.em.element(k), EV = U.emV.element(k);
        const f = smoothstep(E.w, E.w.mul(0.2), length(c.uvw.sub(E.xyz))).mul(select(E.w.greaterThan(0.0), float(1.0), float(0.0)));
        d.addAssign(EV.w.mul(U.dt).mul(f));
        v.assign(mix(v, EV.xyz, f.mul(0.5)));
      }
      const wall = c.x.equal(0).or(c.y.equal(0)).or(c.z.equal(0)).or(c.x.equal(N - 1)).or(c.y.equal(N - 1)).or(c.z.equal(N - 1));
      d.assign(select(wall, d.mul(0.5), min(d, 4.0)));
      textureStore(Bt, uvec3(c.x, c.y, c.z), vec4(v, d)).toWriteOnly();
    })().compute(N3, [64]);

    const at = (buf, x, y, z) => buf.element(clamp(z, int(0), int(N - 1)).mul(N * N).add(clamp(y, int(0), int(N - 1)).mul(N)).add(clamp(x, int(0), int(N - 1))));
    const kDiv = Fn(() => {
      const i = instanceIndex, c = cell(i);
      const o1 = vec3(inv, 0, 0), o2 = vec3(0, inv, 0), o3 = vec3(0, 0, inv);
      const dv = sB(c.uvw.add(o1)).x.sub(sB(c.uvw.sub(o1)).x).add(sB(c.uvw.add(o2)).y.sub(sB(c.uvw.sub(o2)).y)).add(sB(c.uvw.add(o3)).z.sub(sB(c.uvw.sub(o3)).z)).mul(0.5 * N);
      div.element(i).assign(dv); p0.element(i).assign(0.0);
    })().compute(N3, [64]);
    const jac = (src, dst) => Fn(() => {
      const i = instanceIndex, c = cell(i), x = int(c.x), y = int(c.y), z = int(c.z);
      const s = at(src, x.add(1), y, z).add(at(src, x.sub(1), y, z)).add(at(src, x, y.add(1), z)).add(at(src, x, y.sub(1), z)).add(at(src, x, y, z.add(1))).add(at(src, x, y, z.sub(1)));
      dst.element(i).assign(s.sub(div.element(i).mul(inv * inv)).div(6.0));
    })().compute(N3, [64]);
    const kJ01 = jac(p0, p1), kJ10 = jac(p1, p0);
    const kProject = Fn(() => {
      const i = instanceIndex, c = cell(i), x = int(c.x), y = int(c.y), z = int(c.z);
      const g = vec3(at(p0, x.add(1), y, z).sub(at(p0, x.sub(1), y, z)), at(p0, x, y.add(1), z).sub(at(p0, x, y.sub(1), z)), at(p0, x, y, z.add(1)).sub(at(p0, x, y, z.sub(1)))).mul(0.5 * N);
      const s = sB(c.uvw);
      textureStore(A, uvec3(c.x, c.y, c.z), vec4(s.xyz.sub(g), s.w)).toWriteOnly();
    })().compute(N3, [64]);

    // ── raymarch, fixed step budget ──
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: !!o.depthTest, side: THREE.BackSide });
    mat.fog = false;
    let depthClip = null;
    try {
      if (typeof _viewportDepthOK === 'function' && _viewportDepthOK() && T.viewportDepthTexture && o.depthClip !== false) {
        const r = C.renderer();
        const toZ = (r && r.logarithmicDepthBuffer) ? T.logarithmicDepthToViewZ : T.perspectiveDepthToViewZ;
        depthClip = toZ(T.viewportDepthTexture().r, T.cameraNear, T.cameraFar);
      }
    } catch (e) { depthClip = null; }
    mat.fragmentNode = Fn(() => {
      const ro = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz;
      const rd = normalize(positionLocal.sub(ro));
      const ird = vec3(1.0).div(rd);
      const t1 = vec3(-0.5).sub(ro).mul(ird), t2 = vec3(0.5).sub(ro).mul(ird);
      const tn = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
      const tf = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
      const ta = max(tn, 0.0);
      const dtm = tf.sub(ta).div(float(U.steps));
      const Tr = float(1.0).toVar(), col = vec3(0.0).toVar();
      const jit = T.interleavedGradientNoise ? T.interleavedGradientNoise(T.screenCoordinate.xy) : float(0.5);
      const sunL = normalize(modelWorldMatrixInverse.mul(vec4(U.sun, 0.0)).xyz);
      Loop(MAXS, ({ i }) => {
        If(int(i).greaterThanEqual(U.steps).or(Tr.lessThan(0.02)), () => { Break(); });
        const p = ro.add(rd.mul(ta.add(dtm.mul(float(i).add(jit)))));
        if (depthClip) {
          const vz = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(p, 1.0))).z;
          If(vz.lessThan(depthClip), () => { Break(); });
        }
        // clamp to the inner half texel and fade the outer 1.5 texels: no edge sheet / step-aliased dashes at the faces
        const uvw = clamp(p.add(0.5), 0.5 * inv, 1.0 - 0.5 * inv);
        const e3 = min(uvw, vec3(1.0).sub(uvw)), em = min(min(e3.x, e3.y), e3.z);
        const dd = texture3D(A, uvw).w.max(0.0).mul(smoothstep(0.5 * inv, 2.0 * inv, em));
        const sig = dd.mul(U.dens).mul(U.fade);
        If(sig.greaterThan(0.002), () => {
          const sh = texture3D(A, uvw.add(sunL.mul(2.0 * inv))).w.max(0.0);
          const lit = exp(sh.mul(U.dens).mul(-1.5)).mul(U.light).add(0.25);
          const a = float(1.0).sub(exp(sig.mul(dtm).mul(-1.0)));
          const c = vec3(U.color).mul(lit).add(vec3(U.color).mul(U.glow).mul(dd.min(2.0)));
          col.addAssign(c.mul(a).mul(Tr));
          Tr.mulAssign(float(1.0).sub(a));
        });
      });
      const alpha = float(1.0).sub(Tr);
      return vec4(col.div(max(alpha, 1e-3)), alpha);
    })();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    const sz = o.size || [64, 24, 64];
    box.scale.set(sz[0], sz[1], sz[2]);
    box.frustumCulled = false; box.renderOrder = o.renderOrder != null ? o.renderOrder : 3; box.name = 'DMFluid_Smoke';
    box.userData.noBend = true; box.raycast = () => {};
    if (parent) parent.add(box);

    let shiftOnce = false;
    return {
      N, U, mesh: box, A,
      emit(k, ux, uy, uz, r, vx, vy, vz, rate) { if (k < 4) { U.em.array[k].set(ux, uy, uz, r); U.emV.array[k].set(vx || 0, vy || 0, vz || 0, rate || 0); } },
      wind(vx, vy, vz, k) { U.wind.value.set(vx, vy, vz); U.windK.value = k || 0; },
      shift(dx, dy, dz) { U.shift.value.set(dx, dy, dz); shiftOnce = true; },
      setSun(v) { if (v) U.sun.value.copy(v).normalize(); },
      step(renderer, dt, scale) {
        dt = Math.min(Math.max(dt, 1 / 240), 1 / 20);
        U.dt.value = dt; U.t.value = C.clock();
        const s = scale == null ? 1 : scale;
        U.steps.value = Math.max(6, Math.min(MAXS, Math.round(bud.steps * (0.5 + 0.5 * s))));
        C.mark('fluid:smoke');
        renderer.compute(kAdvect);
        if (shiftOnce) { U.shift.value.set(0, 0, 0); shiftOnce = false; }
        renderer.compute(kDiv);
        const it = Math.max(2, Math.round(bud.jac * (0.5 + 0.5 * s)) & ~1);
        for (let j = 0; j < it; j += 2) { renderer.compute(kJ01); renderer.compute(kJ10); }
        renderer.compute(kProject);
      },
      setVisible(v) { box.visible = !!v; },
      dispose() { try { if (box.parent) box.parent.remove(box); box.geometry.dispose(); mat.dispose(); A.dispose(); Bt.dispose(); } catch (e) {} }
    };
  }
  W.DMFluidSmoke = { create };
})();
