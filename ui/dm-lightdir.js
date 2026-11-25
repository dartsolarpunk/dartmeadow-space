/* DART Meadow - DMLightDir: where the key star is, and the cheap planet-bounce fill (v385).  Pure maths, no THREE, no allocation per call (callers pass scratch arrays).
 *
 *   towardStar(star, p, out)            unit vector from point p to the key star (star = [x,y,z] WORLD position; the star is NOT assumed to sit at the origin:
 *                                        Veyra's two stars swing round their barycentre).  Falls back to `fallback` when p is on the star.
 *   shadowLightPos(p, dir, far, out)    where the character's directional shadow light sits: from p, towards the star, half the shadow far plane.
 *   worldKeyDir(d, space, out)          the key direction for a planet world's sun shadow box.  On the ground / in the air a sun far below the horizon is clamped
 *                                        (a shallow dusk shadow; a fixed high light under ~-5 deg).  In OPEN SPACE there is no horizon: the star's true direction is used
 *                                        whatever its sign (the clamp lit the board from "above" while the star was below / behind it: the lit face was the far face).
 *   bounce(bodies, p, star, opt, out)   planet-bounce fill: Sum over the lit planets near p of colour x albedo x phase x (r/d)^2, as ONE low-intensity colour + direction
 *                                        (towards the brightest contributions).  Used as an extra ambient term on boards and a second soft key on characters: no light,
 *                                        no shadow map, no recompile.
 */
(function (root) {
  'use strict';
  const L = {};
  L.towardStar = function (star, p, out, fallback) {
    const x = star[0] - p[0], y = star[1] - p[1], z = star[2] - p[2], l = Math.hypot(x, y, z);
    if (l < 1e-6) { const f = fallback || [1, 0.3, 0.2], fl = Math.hypot(f[0], f[1], f[2]) || 1; out[0] = f[0] / fl; out[1] = f[1] / fl; out[2] = f[2] / fl; return out; }
    out[0] = x / l; out[1] = y / l; out[2] = z / l; return out;
  };
  L.shadowLightPos = function (p, dir, far, out) { const h = far * 0.5; out[0] = p[0] + dir[0] * h; out[1] = p[1] + dir[1] * h; out[2] = p[2] + dir[2] * h; return out; };
  L.worldKeyDir = function (d, space, out) {
    if (!d) return null;
    const dx = d.x !== undefined ? d.x : d[0], dy = d.y !== undefined ? d.y : d[1], dz = d.z !== undefined ? d.z : d[2];
    const l = Math.hypot(dx, dy, dz) || 1, x = dx / l, y = dy / l, z = dz / l;
    if (space || y > 0.05) { out[0] = x; out[1] = y; out[2] = z; return out; }
    if (y > -0.08) { const hl = Math.hypot(x, z) || 1, k = Math.sqrt(1 - 0.06 * 0.06) / hl; out[0] = x * k; out[1] = 0.06; out[2] = z * k; return out; }
    return null;   // ground / air, sun well below the horizon: the caller's fixed fallback (night)
  };
  const lin = (c) => Math.pow(c / 255, 2.2);
  L.hexToLin = function (hex, out) { out[0] = lin((hex >> 16) & 255); out[1] = lin((hex >> 8) & 255); out[2] = lin(hex & 255); return out; };
  /* bodies: [{ x,y,z, r, col:hex }] (planets / moons, NOT stars).  p, star: [x,y,z].  opt: { k (strength, default 0.9), cap (max summed intensity, default 0.1), minRatio }
     out: { rgb:[r,g,b] (light units: colour x intensity), dir:[x,y,z] unit, I, n } */
  const _c = [0, 0, 0];
  L.bounce = function (bodies, p, star, opt, out) {
    opt = opt || {}; const K = opt.k == null ? 0.9 : opt.k, CAP = opt.cap == null ? 0.1 : opt.cap;
    let sr = 0, sg = 0, sb = 0, dx = 0, dy = 0, dz = 0, I = 0, n = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]; if (!b || !(b.r > 0)) continue;
      const px = b.x - p[0], py = b.y - p[1], pz = b.z - p[2], d = Math.hypot(px, py, pz); if (d <= b.r * 1.02) continue;   // inside / on it: not a bounce (the surface worlds light themselves)
      const w = Math.min(0.5, (b.r / d) * (b.r / d)); if (w < 1e-5) continue;
      // phase: the fraction of the planet's disc that is lit as seen from p = (1 + cos) / 2 with cos between the planet->sun and planet->p directions
      const sx = star[0] - b.x, sy = star[1] - b.y, sz = star[2] - b.z, sl = Math.hypot(sx, sy, sz) || 1;
      const cosA = (sx * -px + sy * -py + sz * -pz) / (sl * d), phase = (1 + cosA) / 2, ph2 = phase * phase;
      L.hexToLin(b.col == null ? 0x888888 : b.col, _c);
      const lum = 0.2126 * _c[0] + 0.7152 * _c[1] + 0.0722 * _c[2], alb = Math.min(0.9, Math.max(0.06, lum * 1.5 + 0.05));
      const e = K * alb * w * ph2 * (b.gain == null ? 1 : b.gain); if (e <= 1e-6) continue;
      const m = Math.max(_c[0], _c[1], _c[2], 1e-4);   // hue only (normalised); the energy is e
      sr += _c[0] / m * e; sg += _c[1] / m * e; sb += _c[2] / m * e; I += e; n++;
      dx += px / d * e; dy += py / d * e; dz += pz / d * e;
    }
    if (I > CAP) { const s = CAP / I; sr *= s; sg *= s; sb *= s; I = CAP; }
    out.rgb[0] = sr; out.rgb[1] = sg; out.rgb[2] = sb; out.I = I; out.n = n;
    const dl = Math.hypot(dx, dy, dz); if (dl > 1e-9) { out.dir[0] = dx / dl; out.dir[1] = dy / dl; out.dir[2] = dz / dl; } else { out.dir[0] = 0; out.dir[1] = -1; out.dir[2] = 0; }
    return out;
  };
  L.newBounce = function () { return { rgb: [0, 0, 0], dir: [0, -1, 0], I: 0, n: 0 }; };
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  if (root) root.DMLightDir = L;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
