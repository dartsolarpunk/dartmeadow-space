/* DART Meadow — mansion LANDING ZONES. Pure maths (no THREE / DOM) + a tiny registry.
 * The mansion plan (assets/ariel-home/ariel-home-interior-nav.json: floor patches, furniture boxes `obs`, thin walls `seg`, room boxes `rooms`; and the lamp plan
 * assets/ariel-home/ariel-home-lamps.json) is read once; every OPEN-AIR patch (outside every room box: patios, decks, balconies, courts, terraces, the prow) yields
 * one or more landing PADS: {x,y,z,r,patch,kind,app} in the mansion-local nav frame (x east, y seaward, z up). A pad is the centre of the largest empty disc on the patch
 * (clearance to the patch edge, planters / furniture, walls and lamp plinths), r = that clear radius, z = the surface height, app = approach clearance (the disc is clear
 * all the way up: nothing is registered above a patch). build() is pure; set(pads, toWorld, sc) stores world copies the landing search prefers. */
(function (root) {
  'use strict';
  function dRect(px, py, x0, y0, x1, y1) { var dx = Math.max(x0 - px, 0, px - x1), dy = Math.max(y0 - py, 0, py - y1); return Math.hypot(dx, dy); }
  function dSeg(px, py, ax, ay, bx, by) { var vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy, t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0; return Math.hypot(px - ax - vx * t, py - ay - vy * t); }
  function inPoly(px, py, P) { var c = false; for (var i = 0, j = P.length - 1; i < P.length; j = i++) { if (((P[i][1] > py) !== (P[j][1] > py)) && (px < (P[j][0] - P[i][0]) * (py - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0])) c = !c; } return c; }
  function polyEdge(px, py, P) { var m = 1e9; for (var i = 0, j = P.length - 1; i < P.length; j = i++) m = Math.min(m, dSeg(px, py, P[i][0], P[i][1], P[j][0], P[j][1])); return m; }
  function obClear(nav, lamps, x, y, z, c, minC) {   // clearance c reduced by furniture, walls and lamp plinths on this level
    var i; for (i = 0; i < (nav.obs || []).length && c >= minC; i++) { var b = nav.obs[i]; if (Math.abs(b[4] - z) > 2.5 && b[5] < z + 0.2) continue; c = Math.min(c, dRect(x, y, b[0], b[1], b[2], b[3])); }
    for (i = 0; i < (nav.seg || []).length && c >= minC; i++) { var s = nav.seg[i]; if (Math.abs((s[4] || 0) - z) > 2.5) continue; c = Math.min(c, dSeg(x, y, s[0], s[1], s[2], s[3])); }
    for (i = 0; i < (lamps || []).length && c >= minC; i++) { var l = lamps[i]; if (Math.abs(l[2] - z) > 2.5) continue; c = Math.min(c, Math.hypot(x - l[0], y - l[1]) - 0.9); }
    return c;
  }
  function roomTest(nav) { var rooms = (nav.rooms || []).filter(function (r) { return r[0] === 'r'; }); return function (x, y) { for (var i = 0; i < rooms.length; i++) { var r = rooms[i]; if (x >= r[1] && x <= r[3] && y >= r[2] && y <= r[4]) return true; } return false; }; }
  // the cliff terraces and the outdoor plateau, from the collision grid: g = heights in local units (Float64, nx*ny, row-major, <-900 = no data), col = {x0,y0,cell,nx,ny,sea}
  function buildGrid(nav, lamps, g, col, o) {
    o = o || {}; var minC = o.minClear || 3.4, tol = o.tol || 0.25, kmax = o.kmax || 4, gap = o.gap || 14, max = o.max || 20, inRoom = roomTest(nav), nx = col.nx, ny = col.ny, cell = col.cell, cand = [];
    for (var j = kmax; j < ny - kmax; j++) for (var i = kmax; i < nx - kmax; i++) {
      var h0 = g[j * nx + i]; if (!(h0 > col.sea + 3) || h0 < -900) continue; var x = col.x0 + i * cell, y = col.y0 + j * cell; if (inRoom(x, y)) continue;
      var k = 0; for (k = 1; k <= kmax; k++) { var bad = false; for (var dj = -k; dj <= k && !bad; dj++) for (var di = -k; di <= k; di++) { if (Math.max(Math.abs(di), Math.abs(dj)) !== k || di * di + dj * dj > k * k + 1) continue; var h = g[(j + dj) * nx + i + di]; if (!(Math.abs(h - h0) <= tol)) { bad = true; break; } } if (bad) break; }
      k--; if (k < 1) continue; var c = obClear(nav, lamps, x, y, h0, k * cell, minC); if (c >= minC && !inRoom(x + c, y) && !inRoom(x - c, y) && !inRoom(x, y + c) && !inRoom(x, y - c)) cand.push({ x: x, y: y, z: h0, r: c, patch: -1, kind: 'terrace', app: c });
    }
    cand.sort(function (a, b) { return b.r - a.r; }); var out = [];
    for (var m = 0; m < cand.length && out.length < max; m++) { var q = cand[m], far = true; for (var t = 0; t < out.length; t++) if (Math.hypot(q.x - out[t].x, q.y - out[t].y) < gap + out[t].r + q.r) { far = false; break; } if (far) out.push(q); }
    return out;
  }
  // nav: parsed nav json, lamps: lamps array [[x,y,z,kind,yaw]...] (local frame); o: {minClear (local units), step, maxPer}
  function build(nav, lamps, o) {
    o = o || {}; var minC = o.minClear || 3.4, step = o.step || 2, maxPer = o.maxPer || 4, out = [], inRoom = roomTest(nav);
    (nav.patches || []).forEach(function (p, pi) {
      if (p[0] !== 'r' && p[0] !== 'p') return;
      var poly = p[0] === 'p' ? p[1] : null, z = p[0] === 'p' ? p[2] : p[5 - 0];
      var x0, y0, x1, y1; if (poly) { x0 = 1e9; y0 = 1e9; x1 = -1e9; y1 = -1e9; poly.forEach(function (q) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }); } else { x0 = p[1]; y0 = p[2]; x1 = p[3]; y1 = p[4]; }
      if (x1 - x0 < 2 * minC || y1 - y0 < 2 * minC) return;
      var kind = poly ? 'prow' : (z > 5 ? 'terrace' : (y0 < -60 ? 'court' : 'deck')), cand = [];
      for (var y = y0; y <= y1; y += step) for (var x = x0; x <= x1; x += step) {
        var edge = poly ? (inPoly(x, y, poly) ? polyEdge(x, y, poly) : -1) : Math.min(x - x0, x1 - x, y - y0, y1 - y); if (edge < minC) continue;
        if (inRoom(x, y)) continue;
        var c = obClear(nav, lamps, x, y, z, edge, minC);
        if (c >= minC) cand.push({ x: x, y: y, c: c });
      }
      cand.sort(function (a, b) { return b.c - a.c; });
      var taken = [];
      for (var k = 0; k < cand.length && taken.length < maxPer; k++) { var q = cand[k], far = true; for (var t = 0; t < taken.length; t++) if (Math.hypot(q.x - taken[t].x, q.y - taken[t].y) < taken[t].r + q.c) { far = false; break; } if (far) { taken.push({ x: q.x, y: q.y, z: z, r: q.c, patch: pi, kind: kind, app: q.c }); } }
      taken.forEach(function (t) { out.push(t); });
    });
    return out;
  }
  var REG = { pads: [], world: [] };
  // toWorld(lx, ly, lz, out[3]) maps the nav frame to world; sc = world units per local unit (clear radius scales with it)
  function set(pads, toWorld, sc) { var v = [0, 0, 0]; sc = sc || 1; REG.pads = pads || []; REG.world = REG.pads.map(function (p) { toWorld(p.x, p.y, p.z, v); return { x: v[0], y: v[1], z: v[2], r: p.r * sc, app: p.app * sc, kind: p.kind, patch: p.patch }; }); }
  function clear() { REG.pads = []; REG.world = []; }
  // nearest pad within maxD (world, horizontal), skipping `skip` indices already found blocked
  function nearest(x, z, maxD, skip) { var best = null, bd = maxD * maxD; for (var i = 0; i < REG.world.length; i++) { if (skip && skip.indexOf(i) >= 0) continue; var p = REG.world[i], d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z); if (d < bd) { bd = d; best = i; } } return best === null ? null : { i: best, pad: REG.world[best], dist: Math.sqrt(bd) }; }
  var API = { build: build, buildGrid: buildGrid, set: set, clear: clear, nearest: nearest, list: function () { return REG.world; }, count: function () { return REG.world.length; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.DMLandZones = API;
})(typeof window !== 'undefined' ? window : globalThis);
