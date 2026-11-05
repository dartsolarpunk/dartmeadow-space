#!/usr/bin/env node
'use strict';
/* plan_lamps.js: offline, deterministic placement of the property lamps of Ariel's mansion (street-lamp style poles).
 *
 *   node tools/ariel-home/plan_lamps.js            writes assets/ariel-home/ariel-home-lamps.json
 *   node tools/ariel-home/plan_lamps.js --check    exits 1 when the committed JSON differs from what this would write
 *
 * Input: the exterior collision grid (assets/ariel-home/ariel-home-collide.json, 2-unit cells, mansion frame x east / y seaward, 1.78 units = 1 m) and the interior nav
 * (door aprons, rooms). Output: lamps [x, y, groundZ, kind, armYaw] in the same frame. Kinds: 0 path (court, between the doors), 1 deck / terrace edge (cliff levels), 2 facade.
 *
 * Method (cheap enough to read in one sitting):
 *   1. flat cells = land cells whose land neighbours are within 0.12 of them or a real step (> 1.2) away; connected same-height flats form LEVELS (court, decks, lower
 *      terraces, landing disc). Roofs (h > 5), 1-cell ledges (< 6 cells across) and the side meadows outside the property are dropped.
 *   2. TARGET cells to light: for a small level its cliff edges, facade edges and a few cells round its middle; for the big court only the strips along the facade and along
 *      the walking paths between the doors (A* over walkable cells with steps <= 0.6) and the landing disc.
 *   3. greedy cover: repeatedly drop the lamp that lights the most uncovered target cells (radius 12 units ~ 6.7 m), never closer than 14 units (~ 7.9 m) to another lamp,
 *      standing on a flat cell that is not on a lip. Ties break by cell order, so the output is identical on every run. */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const UPM = 1.78, RC = 18, MINSEP = 32, CAP = 18;

function load(file) { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
function decode(col) {
  const b = Buffer.from(col.data, 'base64'), h = new Int16Array(b.buffer, b.byteOffset, b.length >> 1), inv = 1 / col.scale, g = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) g[i] = h[i] * inv;
  return g;
}

function plan(col, nav) {
  const nx = col.nx, ny = col.ny, c = col.cell, g = decode(col), land = new Uint8Array(nx * ny);
  const X = i => col.x0 + i * c, Y = j => col.y0 + j * c, id = (i, j) => j * nx + i;
  for (let k = 0; k < g.length; k++) land[k] = g[k] > col.sea + 0.6 ? 1 : 0;
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const inb = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny;
  // 1. flat cells + levels
  const flat = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = id(i, j); if (!land[k]) continue; let ok = 1;
    for (const [di, dj] of N4) { const a = i + di, b = j + dj; if (!inb(a, b) || !land[id(a, b)]) continue; const d = Math.abs(g[id(a, b)] - g[k]); if (d > 0.12 && d < 1.2) ok = 0; }
    flat[k] = ok;
  }
  const lab = new Int32Array(nx * ny).fill(-1), comps = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k0 = id(i, j); if (!flat[k0] || lab[k0] >= 0) continue;
    const n = comps.length, st = [k0], cells = []; lab[k0] = n;
    while (st.length) {
      const k = st.pop(); cells.push(k); const ci = k % nx, cj = (k - ci) / nx;
      for (const [di, dj] of N4) { const a = ci + di, b = cj + dj; if (!inb(a, b)) continue; const q = id(a, b); if (flat[q] && lab[q] < 0 && Math.abs(g[q] - g[k]) <= 0.12) { lab[q] = n; st.push(q); } }
    }
    let i0 = 1e9, i1 = -1, j0 = 1e9, j1 = -1, sh = 0, sx = 0;
    for (const k of cells) { const ci = k % nx, cj = (k - ci) / nx; i0 = Math.min(i0, ci); i1 = Math.max(i1, ci); j0 = Math.min(j0, cj); j1 = Math.max(j1, cj); sh += g[k]; sx += X(ci); }
    comps.push({ n, cells, h: sh / cells.length, w: i1 - i0 + 1, d: j1 - j0 + 1, cx: sx / cells.length, area: cells.length });
  }
  const levels = comps.filter(L => L.area >= 40 && Math.min(L.w, L.d) >= 6 && L.h < 5 && Math.abs(L.cx) <= 100);
  const levelOf = new Int32Array(nx * ny).fill(-1); levels.forEach((L, n) => { for (const k of L.cells) levelOf[k] = n; });
  // interior footprints (roofs / floors live there): no lamps inside them
  const rooms = nav.rooms.map(r => r[0] === 'r' ? { x0: r[1], y0: r[2], x1: r[3], y1: r[4] } : { pts: r[1] });
  const inRoom = (x, y, m) => rooms.some(r => r.pts ? pip(r.pts, x, y) : x >= r.x0 - m && x <= r.x1 + m && y >= r.y0 - m && y <= r.y1 + m);
  function pip(p, x, y) { let o = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) o = !o; } return o; }

  // 2. targets
  const target = new Uint8Array(nx * ny), et = new Uint8Array(nx * ny), edgeKind = new Uint8Array(nx * ny);   // edgeKind 1 = drop, 2 = facade
  const big = L => L.area > 1000;
  levels.forEach((L, n) => {
    for (const k of L.cells) {
      const i = k % nx, j = (k - i) / nx; let e = 0;
      for (const [di, dj] of N4) { const a = i + di, b = j + dj; if (!inb(a, b) || !land[id(a, b)]) { e = Math.max(e, 1); continue; } if (levelOf[id(a, b)] === n) continue; const d = g[id(a, b)] - g[k]; if (d < -1.5) e = Math.max(e, 1); else if (d > 1.5) e = 2; }
      edgeKind[k] = e;
    }
  });
  const dist = (k, m) => { const i = k % nx, j = (k - i) / nx, a = m % nx, b = (m - a) / nx; return Math.hypot(i - a, j - b) * c; };
  levels.forEach((L, n) => {
    const edges = L.cells.filter(k => edgeKind[k] && !(big(L) && edgeKind[k] === 1));
    // mark every cell within 2 cells (4 units) of an edge of interest
    for (const k of edges) { const i = k % nx, j = (k - i) / nx; for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { if (!inb(i + di, j + dj)) continue; const q = id(i + di, j + dj); if (levelOf[q] === n && !inRoom(X(i + di), Y(j + dj), 1.5)) (big(L) ? et : target)[q] = 1; } }
    if (!big(L)) {   // the middle of a deck / terrace: cells nearest its centroid
      let mx = 0, my = 0; for (const k of L.cells) { mx += k % nx; my += (k - (k % nx)) / nx; } mx /= L.cells.length; my /= L.cells.length;
      for (const k of L.cells) { const i = k % nx, j = (k - i) / nx; if (Math.hypot(i - mx, j - my) * c <= 5) target[k] = 1; }
    }
  });
  // paths: A* between points of interest over walkable cells (steps <= 0.6), strips of 3 cells either side
  const snap = (x, y) => { const i0 = Math.round((x - col.x0) / c), j0 = Math.round((y - col.y0) / c); let best = -1, bd = 1e9; for (let r = 0; r < 25; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { const a = i0 + di, b = j0 + dj; if (!inb(a, b) || !land[id(a, b)] || levelOf[id(a, b)] < 0) continue; const d = di * di + dj * dj; if (d < bd) { bd = d; best = id(a, b); } } return best; };
  function astar(s, t) {
    const gs = new Float64Array(nx * ny).fill(1e18), from = new Int32Array(nx * ny).fill(-1), open = [[0, s]]; gs[s] = 0;
    const hf = k => Math.hypot((k % nx) - (t % nx), Math.floor(k / nx) - Math.floor(t / nx));
    const closed = new Uint8Array(nx * ny);
    while (open.length) {
      let bi = 0; for (let q = 1; q < open.length; q++) if (open[q][0] < open[bi][0] || (open[q][0] === open[bi][0] && open[q][1] < open[bi][1])) bi = q;
      const k = open.splice(bi, 1)[0][1]; if (k === t) break; if (closed[k]) continue; closed[k] = 1;
      const i = k % nx, j = (k - i) / nx;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const a = i + di, b = j + dj; if (!inb(a, b)) continue; const q = id(a, b);
        if (!land[q] || Math.abs(g[q] - g[k]) > 0.6 || inRoom(X(a), Y(b), 0)) continue;
        const cost = gs[k] + Math.hypot(di, dj) * (edgeKind[q] === 1 ? 3 : 1) + (flat[q] ? 0 : 0.5);
        if (cost < gs[q]) { gs[q] = cost; from[q] = k; open.push([cost + hf(q), q]); }
      }
    }
    const out = []; for (let k = t; k >= 0 && (k === s || from[k] >= 0); k = from[k]) { out.push(k); if (k === s) break; }
    return out.length && out[out.length - 1] === s ? out : [];
  }
  const pa = nav.patches.filter(p => p[0] === 'r' && Math.abs(p[5] - 0.45) < 1e-6);   // the two wing door aprons (pedestrian, garage)
  const terrace = nav.patches.find(p => p[0] === 'r' && p[5] === 0 && p[1] < -70);   // the covered terrace in front of the hall's west door
  const disc = levels.find(L => L.h > 0.4 && L.area < 150 && L.cx > 60), deck = levels.filter(L => Math.abs(L.h) < 0.2 && L.cx < -30 && L.area < 400)[0];
  const poi = [];
  for (const p of pa) poi.push(snap((p[1] + p[3]) / 2, p[4] + 2));
  if (disc) poi.push(snap(X(disc.cells[0] % nx) + 0, Y(Math.floor(disc.cells[Math.floor(disc.cells.length / 2)] / nx))));
  if (deck) poi.push(snap(-68, 22));
  if (terrace) poi.push(snap((terrace[1] + terrace[3]) / 2, (terrace[2] + terrace[4]) / 2 + 6));
  poi.push(snap(-88, -12), snap(86, -12));   // the court's west and east rims by the cliff lips (the court does not connect down to the west deck: it is a drop)
  const legs = [[0, 1], [1, 2], [0, 5], [2, 6], [3, 4]].filter(([a, b]) => poi[a] >= 0 && poi[b] >= 0 && poi[a] !== undefined && poi[b] !== undefined);
  const pathCells = new Uint8Array(nx * ny);
  for (const [a, b] of legs) for (const k of astar(poi[a], poi[b])) { const i = k % nx, j = (k - i) / nx; for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) { if (!inb(i + di, j + dj)) continue; const q = id(i + di, j + dj); if (land[q] && levelOf[q] >= 0 && !inRoom(X(i + di), Y(j + dj), 1.5)) { target[q] = 1; pathCells[q] = 1; } } }
  // facade strips of the big court only where a path runs past them (not round the back of the wing)
  { const pc = []; for (let k = 0; k < pathCells.length; k++) if (pathCells[k]) pc.push(k);
    for (let k = 0; k < et.length; k++) if (et[k] && pc.some(q => dist(k, q) <= 14)) target[k] = 1; }
  if (disc) for (const k of disc.cells) if (dist(k, disc.cells[Math.floor(disc.cells.length / 2)]) <= 6) target[k] = 1;

  // 3. greedy cover
  const cand = [];
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = id(i, j); if (!flat[k] || levelOf[k] < 0 || inRoom(X(i), Y(j), 1.5)) continue;
    let ok = true, lip = 0; for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1; di++) { const q = id(i + di, j + dj); if (!land[q] || Math.abs(g[q] - g[k]) > 0.12) { ok = false; break; } }
    if (!ok) continue;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { if (!inb(i + di, j + dj)) continue; const q = id(i + di, j + dj); if (edgeKind[q]) lip = Math.max(lip, edgeKind[q]); }
    cand.push({ k, i, j, x: X(i), y: Y(j), edge: lip });
  }
  const tcells = []; for (let k = 0; k < target.length; k++) if (target[k]) tcells.push(k);
  const covered = new Uint8Array(nx * ny), lamps = [], rr = Math.ceil(RC / c);
  let left = tcells.length;
  while (left > 0 && lamps.length < CAP) {
    let best = null, bg = 0;
    for (const cd of cand) {
      if (lamps.some(l => Math.hypot(l[0] - cd.x, l[1] - cd.y) < MINSEP)) continue;
      let gain = 0; for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) { const a = cd.i + di, b = cd.j + dj; if (!inb(a, b)) continue; const q = id(a, b); if (target[q] && !covered[q] && levelOf[q] === levelOf[cd.k] && Math.hypot(di, dj) * c <= RC) gain++; }
      const sc = gain + (cd.edge ? 0.5 : 0) + (cd.edge === 2 ? 0.25 : 0);
      if (gain > 0 && sc > bg) { bg = sc; best = cd; }
    }
    if (!best) break;
    for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) { const a = best.i + di, b = best.j + dj; if (!inb(a, b)) continue; const q = id(a, b); if (target[q] && !covered[q] && levelOf[q] === levelOf[best.k] && Math.hypot(di, dj) * c <= RC) { covered[q] = 1; left--; } }
    const L = levels[levelOf[best.k]]; let mx = 0, my = 0; for (const k of L.cells) { mx += X(k % nx); my += Y(Math.floor(k / nx)); } mx /= L.cells.length; my /= L.cells.length;
    lamps.push([best.x, best.y, +g[best.k].toFixed(2), best.edge === 1 ? 1 : best.edge === 2 ? 2 : 0, +Math.atan2(my - best.y, mx - best.x).toFixed(3)]);   // arm yaw: toward the middle of the level
  }
  return { lamps, uncovered: left, targets: tcells.length, levels: levels.map(L => ({ h: +L.h.toFixed(1), area: L.area, w: L.w * c, d: L.d * c })) };
}

function build() {
  const col = load('assets/ariel-home/ariel-home-collide.json'), nav = load('assets/ariel-home/ariel-home-interior-nav.json'), p = plan(col, nav);
  return { json: JSON.stringify({ v: 1, upm: UPM, frame: 'mansion nav frame: x east, y seaward, z up (units; 1.78 = 1 m)', kinds: ['path', 'edge', 'facade'], lamps: p.lamps }) + '\n', plan: p };
}
module.exports = { plan, decode, build, UPM, RC, MINSEP };
if (require.main === module) {
  const out = path.join(root, 'assets/ariel-home/ariel-home-lamps.json'), r = build();
  if (process.argv.includes('--check')) { const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''; if (cur !== r.json) { console.error('ariel-home-lamps.json is out of date: run node tools/ariel-home/plan_lamps.js'); process.exit(1); } console.log('ok', r.plan.lamps.length, 'lamps'); }
  else { fs.writeFileSync(out, r.json); console.log('wrote', out, r.plan.lamps.length, 'lamps; uncovered targets', r.plan.uncovered, '/', r.plan.targets, JSON.stringify(r.plan.levels)); }
}
