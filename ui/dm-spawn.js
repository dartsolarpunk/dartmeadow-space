/* DART Meadow — DMSpawn: where a new game / a return to Sol starts, and the "never arrive inside a world's hand-off radius" rule.
 *
 * WHY: the default spawn was Low Earth Orbit (1.05 R from Earth).  _pwSpaceWatch opens (builds) a landable world within PWS_OPEN = 9 planet radii and the
 * hand-off shows it at the atmosphere perimeter (1.18 R for Solenne), so the new-game board was inside the world's LOD / atmosphere trigger on frame one and
 * the player could not get away; on a phone that also meant a planet-world build + compile right on top of the start-up warm-up (an iOS memory spike).
 * Now a new game starts in interstellar space just outside the planets' orbits, looking back at Sol, and every arrival (Sol home, quick travel, discovery return)
 * is pushed out to clearR planet radii from any landable body.  Existing saves are untouched (they carry their own position).
 *
 * Public (window.DMSpawn / module.exports):
 *   DEF                         { auOut: 45, elevDeg: 20, clearR: 11.5 }   (clearR > PWS_CLOSE = 11: neither the open (9) nor the close (11) test can fire)
 *   defaultSpawn(AU, cfg)       -> { pos:{x,y,z}, camYaw, camPitch, distSol, elevDeg }   camera aimed at Sol (origin); forward at yaw 0 / pitch 0 is -Z
 *   pushClear(pos, bodies, minR)-> true if moved.  pos {x,y,z} is mutated; bodies [{x,y,z,r}] (r = collision radius).  Pushes along the body->pos ray (away from Sol if coincident).
 *   minRadii(pos, bodies)       -> smallest distance / radius over bodies (Infinity if none)
 */
(function (root) {
  'use strict';
  const DEF = { auOut: 45, elevDeg: 20, clearR: 11.5 };
  function defaultSpawn(AU, cfg) {
    const c = Object.assign({}, DEF, cfg || {}), D = (AU > 0 ? AU : 500) * c.auOut, e = c.elevDeg * Math.PI / 180;
    // along +Z, lifted above the ecliptic: the whole system lies below and ahead, Sol dead centre
    const pos = { x: 0, y: D * Math.sin(e), z: D * Math.cos(e) };
    const L = Math.hypot(pos.x, pos.y, pos.z), fx = -pos.x / L, fy = -pos.y / L, fz = -pos.z / L;
    return { pos, camYaw: Math.atan2(-fx, -fz), camPitch: Math.asin(Math.max(-1, Math.min(1, fy))), distSol: L, elevDeg: c.elevDeg };
  }
  function minRadii(pos, bodies) {
    let m = Infinity;
    for (const b of bodies || []) { if (!b || !(b.r > 0)) continue; const d = Math.hypot(pos.x - b.x, pos.y - b.y, pos.z - b.z) / b.r; if (d < m) m = d; }
    return m;
  }
  function pushClear(pos, bodies, minR) {
    const need = minR > 0 ? minR : DEF.clearR; let moved = false;
    for (let pass = 0; pass < 6; pass++) {   // pushing out of one world can land inside the next (a moon beside its planet)
      let any = false;
      for (const b of bodies || []) {
        if (!b || !(b.r > 0)) continue;
        let dx = pos.x - b.x, dy = pos.y - b.y, dz = pos.z - b.z, d = Math.hypot(dx, dy, dz);
        if (d >= need * b.r) continue;
        if (d < 1e-6) { dx = b.x; dy = b.y; dz = b.z; d = Math.hypot(dx, dy, dz); if (d < 1e-6) { dx = 0; dy = 0; dz = 1; d = 1; } }   // coincident: out along the Sol->body ray
        const k = need * b.r * 1.001 / d;
        pos.x = b.x + dx * k; pos.y = b.y + dy * k; pos.z = b.z + dz * k; any = moved = true;
      }
      if (!any) break;
    }
    return moved;
  }
  const S = { DEF, defaultSpawn, pushClear, minRadii };
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
  if (typeof window !== 'undefined') window.DMSpawn = S;
})(typeof window !== 'undefined' ? window : globalThis);
