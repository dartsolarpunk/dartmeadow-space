/* DART Meadow — MARK LANDING SPOT (atmospheric flight). Pure logic, no THREE / DOM, so tools/tests/landmark.test.js runs the real thing.
 *   pickGround(o, d, height, opt)  a screen ray (origin o, unit direction d, [x,y,z] arrays) marched against the terrain height field -> [x,y,z] or null
 *   resolve(x, z, validate)        validate(x,z) -> {ok,x,z,moved,dist}; returns the spot to use + whether it was snapped to a clear one
 *   scaleAt(dist), fade(dist2D)    marker readability from altitude; it fades as the craft sets down
 *   create()                       the state machine: idle -> picking -> flying -> landing -> idle (cancel from picking / flying; the stick cancels; LAND / LEVEL / AUTO never fight it)
 */
(function (root) {
  'use strict';
  function pickGround(o, d, height, opt) {
    opt = opt || {}; var maxT = opt.maxT || 6000, step = opt.step || 3, grow = opt.grow || 1.08, maxStep = opt.maxStep || 40, prev = 0;
    for (var t = step; t < maxT; t += step) {
      var x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t, h = height(x, z);
      if (h === h && y <= h) { var lo = prev, hi = t; for (var i = 0; i < 12; i++) { var m = (lo + hi) / 2, hm = height(o[0] + d[0] * m, o[2] + d[2] * m); if (hm === hm && o[1] + d[1] * m <= hm) hi = m; else lo = m; } var px = o[0] + d[0] * hi, pz = o[2] + d[2] * hi; return [px, height(px, pz), pz]; }
      prev = t; step = Math.min(maxStep, step * grow);
    }
    return null;
  }
  function resolve(x, z, validate) {
    var v = validate ? validate(x, z) : null; if (!v) return { ok: true, x: x, z: z, snapped: false, dist: 0 };
    if (!v.ok) return { ok: false, x: x, z: z, snapped: false, dist: 0 };
    return { ok: true, x: v.x, z: v.z, snapped: !!v.moved && (Math.hypot(v.x - x, v.z - z) > 0.5), dist: Math.hypot(v.x - x, v.z - z) };
  }
  function scaleAt(dist) { return Math.max(1, Math.min(60, (dist || 0) / 80)); }
  function fade(d2) { var t = Math.max(0, Math.min(1, ((d2 || 0) - 6) / 40)); return t * t * (3 - 2 * t); }
  function create() {
    var S = { state: 'idle', x: 0, z: 0, snapped: false, log: [] };
    var set = function (st) { S.log.push(st); S.state = st; };
    S.toggle = function (can) { if (S.state === 'idle') { if (can === false) return 'ignored'; set('picking'); return 'picking'; } if (S.state === 'picking' || S.state === 'flying') { var was = S.state; set('idle'); return 'cancel-' + was; } return 'ignored'; };
    S.tap = function (hit, validate) { if (S.state !== 'picking') return null; if (!hit) return { ok: false, why: 'no ground' }; var r = resolve(hit[0], hit[2], validate); if (!r.ok) return { ok: false, why: 'blocked' }; S.x = r.x; S.z = r.z; S.snapped = r.snapped; set('flying'); return { ok: true, x: r.x, z: r.z, snapped: r.snapped, dist: r.dist }; };
    S.arrive = function () { if (S.state === 'flying') { set('landing'); return true; } return false; };
    S.landed = function () { if (S.state === 'landing' || S.state === 'flying') { set('idle'); return true; } return false; };
    S.cancel = function () { if (S.state !== 'idle') { set('idle'); return true; } return false; };   // the stick, the globe, leaving the sky
    return S;
  }
  var API = { pickGround: pickGround, resolve: resolve, scaleAt: scaleAt, fade: fade, create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.DMLandMark = API;
})(typeof window !== 'undefined' ? window : globalThis);
