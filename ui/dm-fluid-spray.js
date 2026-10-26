/* DART Meadow — white water and spray: Position Based Fluids particles (crunch1 fluids).
 *
 * Spawned by the APIC liquid (ui/dm-fluid-apic.js) wherever its water breaks or is thrown (fast and above the
 * swell), and by impacts. Each frame, WebGPU compute:
 *   clear density grid -> predict (gravity, air drag) + splat counts into a hash grid round the focus
 *   -> PBF density constraint (C = rho/rho0 - 1, evaluated on the grid: lambda from the counts, the correction
 *      along -grad rho) + sea-surface collision (spray landing on the swell turns into foam that rides the
 *      ocean's orbital motion and fades) -> velocity from the corrected positions (PBF update v = (x* - x)/dt).
 * Rendered as cheap instanced splats (white, size by state). One constraint iteration per frame (prototype).
 */
(function () {
  'use strict';
  const W = window;

  function create(scene, o) {
    const T = W, THREE = W.THREE, C = W.DMFluidCore;
    const { Fn, If, Return, float, int, uint, vec3, vec4, uniform, instancedArray, instanceIndex,
      atomicAdd, atomicStore, atomicLoad, floor, max, min, clamp, length, normalize, mix, smoothstep, select, uv } = T;
    const N = Math.max(256, (o.budget.spray | 0) || 2048);
    const G = 32, G3 = G * G * G, cs = 0.4;   // density grid: 32^3 cells of 0.4 units round the focus
    const pos = instancedArray(N, 'vec4'), vel = instancedArray(N, 'vec4'), prd = instancedArray(N, 'vec4');
    const counter = instancedArray(1, 'uint').toAtomic();
    const grid = instancedArray(G3, 'int').toAtomic();
    const U = {
      dt: uniform(1 / 60), t: uniform(0), seaY: uniform(o.seaY || 0), center: uniform(new THREE.Vector3()),
      rho0: uniform(2.0), drag: uniform(0.35), g: uniform(-9.81), active: uniform(N, 'uint')
    };
    const cellOf = (p) => {
      const q = floor(p.sub(U.center).div(cs).add(G / 2));
      return q;
    };
    const inG = (q) => q.x.greaterThanEqual(0.0).and(q.y.greaterThanEqual(0.0)).and(q.z.greaterThanEqual(0.0))
      .and(q.x.lessThan(G)).and(q.y.lessThan(G)).and(q.z.lessThan(G));
    const gi = (q) => int(q.z).mul(G * G).add(int(q.y).mul(G)).add(int(q.x));
    const cnt = (q) => select(inG(q), float(atomicLoad(grid.element(gi(clamp(q, vec3(0.0), vec3(G - 1)))))), float(0.0));

    const kClear = Fn(() => { atomicStore(grid.element(instanceIndex), int(0)); })().compute(G3, [64]);

    const kPredict = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(U.active), () => { Return(); });
      const P = pos.element(i), V = vel.element(i);
      If(P.w.lessThanEqual(0.0), () => { Return(); });
      const v = V.xyz.toVar();
      const foam = V.w.greaterThan(0.5);
      If(foam, () => {
        const wv = C.waveTSL(P.x, P.z, U.t);
        v.assign(mix(v, vec3(wv.vel.x, 0.0, wv.vel.z), 0.2));
      }).Else(() => {
        v.y.addAssign(U.g.mul(U.dt));
        v.mulAssign(float(1.0).sub(U.drag.mul(U.dt)));
      });
      const p = P.xyz.add(v.mul(U.dt));
      prd.element(i).assign(vec4(p, P.w));
      const q = cellOf(p);
      If(inG(q), () => { atomicAdd(grid.element(gi(q)), int(1)); });
    })().compute(N, [64]);

    const kSolve = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(U.active), () => { Return(); });
      const P = pos.element(i), V = vel.element(i);
      If(P.w.lessThanEqual(0.0), () => { Return(); });
      const p = prd.element(i).xyz.toVar();
      const q = cellOf(p);
      // PBF density constraint on the grid
      const rho = cnt(q);
      const grad = vec3(cnt(q.add(vec3(1, 0, 0))).sub(cnt(q.sub(vec3(1, 0, 0)))),
        cnt(q.add(vec3(0, 1, 0))).sub(cnt(q.sub(vec3(0, 1, 0)))),
        cnt(q.add(vec3(0, 0, 1))).sub(cnt(q.sub(vec3(0, 0, 1))))).mul(0.5);
      const Cc = max(rho.div(U.rho0).sub(1.0), 0.0);
      const gl = length(grad);
      const lambda = Cc.div(gl.mul(gl).add(1.0));
      p.subAssign(select(gl.greaterThan(1e-3), grad.div(gl).mul(min(lambda.mul(cs * 0.5), cs * 0.5)), vec3(0.0)));
      // the sea: spray landing on the swell becomes foam
      const wv = C.waveTSL(p.x, p.z, U.t);
      const sea = U.seaY.add(wv.h);
      const isFoam = V.w.greaterThan(0.5).or(p.y.lessThan(sea)).toVar();
      If(isFoam, () => { p.y.assign(sea.add(0.03)); });
      const v = p.sub(P.xyz).div(max(U.dt, 1e-4));
      const life = P.w.sub(U.dt.mul(select(isFoam, float(0.55), float(1.0))));
      P.assign(vec4(p, life));
      V.assign(vec4(select(isFoam, vec3(v.x, 0.0, v.z), v), select(isFoam, float(1.0), float(0.0))));
    })().compute(N, [64]);

    // render
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const PA = pos.toAttribute(), VA = vel.toAttribute();
    const foamA = VA.w;
    mat.positionNode = PA.xyz;
    mat.scaleNode = mix(float(0.22), float(0.45), foamA).mul(clamp(PA.w.mul(1.5), 0.3, 1.0));
    const d = uv().sub(0.5).length().mul(2.0);
    mat.colorNode = vec4(0.95, 0.97, 1.0, 1.0);
    mat.opacityNode = smoothstep(1.0, 0.2, d).mul(clamp(PA.w, 0.0, 1.0)).mul(mix(float(0.75), float(0.5), foamA)).mul(select(PA.w.greaterThan(0.0), float(1.0), float(0.0)));
    mat.fog = false;
    const sprite = new THREE.Sprite(mat);
    sprite.count = N; sprite.frustumCulled = false; sprite.renderOrder = 5; sprite.name = 'DMFluid_Spray';
    sprite.userData.noBend = true; sprite.raycast = () => {};
    scene.add(sprite);

    const t0 = performance.now();
    return {
      N, pos, vel, counter, U, mesh: sprite,
      step(renderer, dt, cx, cy, cz, scale) {
        dt = Math.min(Math.max(dt, 1 / 240), 1 / 30);
        U.dt.value = dt; U.t.value = C.clock(); U.center.value.set(cx, cy, cz);
        U.active.value = Math.max(64, Math.floor(N * (scale == null ? 1 : scale)));
        sprite.count = U.active.value;
        C.mark('fluid:pbf');
        renderer.compute(kClear); renderer.compute(kPredict); renderer.compute(kSolve);
      },
      setVisible(v) { sprite.visible = !!v; },
      dispose() { try { scene.remove(sprite); mat.dispose(); } catch (e) {} }
    };
  }
  W.DMFluidSpray = { create };
})();
