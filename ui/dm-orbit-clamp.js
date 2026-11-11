// DMOrbitClamp — keeps the on-foot ORBIT camera inside small spaces (mansion rooms, caves, under a roof).
// Pure maths against an injected probe: ray(ox,oy,oz,dx,dy,dz,maxD) -> distance to the first solid, or -1 (index.html wires DMCollide.raycast + DMMansionInt.ray).
// Outdoors it does NOTHING: no overhead geometry -> update() returns the wanted camera position untouched (zero clamp rays; only a 5 Hz overhead probe).
// Enclosed (a ceiling straight above the head AND >= 2 of 4 cone rays also hit) -> the camera is cut back along head->wanted to the first hit minus a margin,
// pulled in at once never past the wall, eased back out. 'Enclosed' enters on the first positive probe and leaves only after EXIT_T of clear probes (hysteresis).
// Verified headless only (tools/tests/orbit-enclosed.js, mock room); see the report for what is not verified in a browser.
(function (root) {
  'use strict';
  const EVAL_DT = 0.2, EXIT_T = 0.8, UP_LEN = 4.5, CONE_TAN = 0.7, MARGIN = 0.35, MIN_D = 0.15, PULL_IN = 22, EASE_OUT = 5, RAY_R = 0.2;
  function create() { return { enclosed: false, clearT: 0, evalT: -1, d: null, hitD: -1, rays: 0, lastRays: 0 }; }
  function reset(st) { st.enclosed = false; st.clearT = 0; st.evalT = -1; st.d = null; st.hitD = -1; }
  // overhead probe: 1 straight up + 4 tilted ~35 deg around the head. returns {up, cone}. While already enclosed the band is wider (hysteresis).
  function probeOver(st, h, ray, u, wide) {
    const len = UP_LEN * u * (wide ? 1.3 : 1), r = RAY_R * u; let cone = 0, up = ray(h.x, h.y, h.z, 0, 1, 0, len, r) >= 0; st.rays++;
    const k = CONE_TAN, n = 1 / Math.sqrt(1 + k * k), a = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < 4; i++) { st.rays++; if (ray(h.x, h.y, h.z, a[i][0] * k * n, n, a[i][1] * k * n, len, r) >= 0) cone++; }
    return { up, cone };
  }
  // st: create(); head/want: {x,y,z}; dt seconds; ray: probe; o: { unit (world units per metre, default 1), near (camera near plane), force (re-evaluate now) }
  // returns { x, y, z, enclosed, clamped }
  function update(st, head, want, dt, ray, o) {
    o = o || {}; const u = o.unit || 1, near = o.near || 0; st.lastRays = st.rays; st.rays = 0;
    const dx = want.x - head.x, dy = want.y - head.y, dz = want.z - head.z, D = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(D > 1e-6)) return { x: want.x, y: want.y, z: want.z, enclosed: st.enclosed, clamped: false };
    st.evalT -= dt;
    if (st.evalT <= 0 || o.force) {
      st.evalT = EVAL_DT; const p = probeOver(st, head, ray, u, st.enclosed), yes = p.up && p.cone >= (st.enclosed ? 1 : 2);
      if (yes) { st.enclosed = true; st.clearT = 0; } else if (st.enclosed) { st.clearT += (o.force ? EXIT_T : EVAL_DT); if (st.clearT >= EXIT_T) { st.enclosed = false; st.clearT = 0; } }
    }
    if (!st.enclosed && st.d === null) return { x: want.x, y: want.y, z: want.z, enclosed: false, clamped: false };   // open sky: the existing orbit, untouched
    const ux = dx / D, uy = dy / D, uz = dz / D, mg = MARGIN * u + near * 1.5;
    st.rays++; const h = ray(head.x, head.y, head.z, ux, uy, uz, D + mg, RAY_R * u); st.hitD = h;
    const hard = h >= 0 && h < D + mg ? Math.max(MIN_D * u, h - Math.min(mg, 0.5 * h)) : D;     // never beyond (wall - a sliver)
    const goal = h >= 0 && h < D + mg ? Math.max(MIN_D * u, h - mg) : D;                           // where it settles: wall - margin
    if (st.d === null) st.d = Math.min(D, hard);
    const dtp = Math.max(0, dt);
    if (goal < st.d) st.d += (goal - st.d) * (1 - Math.exp(-PULL_IN * dtp)); else st.d += (goal - st.d) * (1 - Math.exp(-EASE_OUT * dtp));
    if (st.d > hard) st.d = hard;                       // pulled in at once past the wall, whatever the smoothing says
    if (!st.enclosed && st.d >= D - 1e-3) st.d = null;  // released: back to the plain orbit
    const d = st.d === null ? D : st.d;
    return { x: head.x + ux * d, y: head.y + uy * d, z: head.z + uz * d, enclosed: st.enclosed, clamped: d < D - 1e-4 };
  }
  const API = { create, reset, update, _k: { EVAL_DT, EXIT_T, UP_LEN, MARGIN, MIN_D } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; root.DMOrbitClamp = API;
})(typeof window !== 'undefined' ? window : globalThis);
