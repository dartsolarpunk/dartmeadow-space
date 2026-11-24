// Headless walk test for the Solenne undercliff (Track 5 / t1583u): ui/dm-undercliff.js + ui/dm-mansion-interior.js + assets/ariel-home/ariel-home-undercliff-nav.json.
// Replays the game's updateSurface step (move -> DMMansionInt.walk (the undercliff answers first where it owns the space) -> gravity -> snap to ground =
// F.ovr else the exterior collision grid) at 60 Hz and 20 Hz and checks: from the pool deck through the cargo bay into every lower-level room, the hangar door,
// the stair down to the hangar floor, round the parked VTOL, up the scaffold stair to the surface, across the closed hatch lid and out onto the plateau; walls,
// rock and the VTOL hull stop her; the hatch, once open, is a hole (she drops to the hangar floor); the rooms are gated until the level has streamed in.
// Pure node, no deps:  node tools/tests/undercliff-walk.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const NAVI = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-interior-nav.json'), 'utf8'));
const NAVU = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-undercliff-nav.json'), 'utf8'));
const COL = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-collide.json'), 'utf8'));
let T_NOW = 1000;
const sb = { performance: { now: () => T_NOW }, atob: s => Buffer.from(s, 'base64').toString('binary'), console, Math, Float64Array, Int16Array, Uint8Array, Set, Map, Promise, fetch: () => Promise.reject(new Error('no fetch')), location: { search: '' } };
sb.window = sb; sb.globalThis = sb;
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-undercliff.js'), 'utf8'), sb, { filename: 'dm-undercliff.js' });
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-interior.js'), 'utf8'), sb, { filename: 'dm-mansion-interior.js' });
const D = sb.DMMansionInt, X = D._test, UC = sb.DMUndercliff, UX = UC._test;
let fails = 0, checks = 0;
function ok(c, msg) { if (msg.startsWith('x: ')) return; checks++; if (!c) { fails++; console.log('  FAIL ' + msg); } else if (process.env.V) console.log('  ok   ' + msg); }
const cb = Buffer.from(COL.data, 'base64'), ch = new Int16Array(cb.buffer, cb.byteOffset, cb.length >> 1), inv = 1 / COL.scale, NEG = -1e9;
function extGround(lx, ly) { const i = Math.round((lx - COL.x0) / COL.cell), j = Math.round((ly - COL.y0) / COL.cell); if (i < 0 || j < 0 || i >= COL.nx || j >= COL.ny) return NEG; const v = ch[j * COL.nx + i] * inv; return v <= COL.sea + 0.6 ? NEG : v; }
const PX = -80.0, PZ = -1340.0, Y0 = 68.31, TH = 0.35;
X.parse(NAVI); X.setFrame(PX, PZ, Y0, TH); X.S.F.ovr = X.ovr; X.S.rec = {};
UX.parse(NAVU); UX.setFrame(PX, PZ, Y0, TH);
const ct = Math.cos(TH), st = Math.sin(TH), U = NAVU.U, Y0U = -2.9, FU = -18.2;
const toW = (lx, ly) => { const lz = -ly; return [PX + lx * ct + lz * st, PZ - lx * st + lz * ct]; };
const toL = (x, z) => { const dx = x - PX, dz = z - PZ; return [dx * ct - dz * st, -(dx * st + dz * ct)]; };
const M = (Xm, Dm) => [Xm * U, Y0U - Dm * U];   // layout metres (X east of the bay centre, D into the cliff) -> mansion u
const zH = Hm => FU + Hm * U;
function extH(x, z) { const [lx, ly] = toL(x, z); const e = extGround(lx, ly); return e === NEG ? -1e4 : Y0 + e; }
const wrapH = (x, z) => { const o = X.S.F.ovr; if (o !== null) { const v = o(x, z); if (v === v) return v; } return extH(x, z); };
const ground = (x, z) => D.ground(wrapH, x, z);
function player(lx, ly, feet) { const [x, z] = toW(lx, ly); return { vy: 0, pos: { x, y: Y0 + feet + 3, z } }; }
function step(P, tx, ty, v, dt) {
  T_NOW += dt * 1000;
  const [lx, ly] = toL(P.pos.x, P.pos.z), dx = tx - lx, dy = ty - ly, d = Math.hypot(dx, dy);
  if (d > 1e-6) { const m = Math.min(d, v * dt) / d; const [wx, wz] = toW(lx + dx * m, ly + dy * m); P.pos.x = wx; P.pos.z = wz; }
  D.walk(P.pos);
  P.vy -= 30 * dt; P.pos.y += P.vy * dt;
  const g = ground(P.pos.x, P.pos.z), eye = g + 3.0; if (P.pos.y <= eye) { P.pos.y = eye; P.vy = 0; }
  return g;
}
const feetL = P => P.pos.y - 3 - Y0, here = P => toL(P.pos.x, P.pos.z);
// walk to each waypoint (metres frame); a waypoint not reached within its budget = stuck
function route(P, pts, v, dt, tag) {
  UX.S.have = false;
  for (const w of pts) {
    const [tx, ty] = M(w[0], w[1]); let n = 0, best = 1e9, still = 0;
    while (n++ < 3000) {
      const [lx, ly] = here(P), dd = Math.hypot(tx - lx, ty - ly); if (dd < 0.45) break;
      if (dd < best - 0.02) { best = dd; still = 0; } else if (++still > 240) break;
      const g = step(P, tx, ty, v, dt); const f = feetL(P);
      if (f < g - Y0 - 1e-6) { ok(false, tag + ': feet below ground'); return false; }
      if (f < -60) { ok(false, tag + ': fell out of the world near ' + here(P).map(q => q.toFixed(1))); return false; }
    }
    const [lx, ly] = here(P); if (Math.hypot(tx - lx, ty - ly) >= 0.45) { ok(false, tag + ': stuck before waypoint ' + JSON.stringify(w) + ' at ' + [lx, ly].map(q => (q).toFixed(1)) + ' feet ' + feetL(P).toFixed(2)); return false; }
  }
  return true;
}
function settle(P, dt) { UX.S.have = false; for (let i = 0; i < 120; i++) { const [lx, ly] = here(P); step(P, lx, ly, 0, dt); } }
const near = (a, b, e) => Math.abs(a - b) <= e;

// ── A* planner over the undercliff's own collision (0.5 u cells x 0.5 u feet levels): the walk below follows real door-to-door paths, so a room that the
// planner cannot reach = a collision bug (a door blocked by furniture, a stair cut by a lintel, ...), and the walk replays the path through the game's step.
const PC = 0.25, PX0 = NAVU.region[0] - 1, PY0 = NAVU.region[1] - 1, PNX = Math.ceil((NAVU.region[2] + 2 - PX0) / PC), PNY = Math.ceil((80 - PY0) / PC), LZ0 = -42, PNL = 100;
function plan(from, to, toFeet) {   // from [lx,ly,feet], to [lx,ly] (+ feet level), mansion u; returns [[lx,ly,feet],...] or null
  UX.S.state = 2;
  const ci = x => Math.round((x - PX0) / PC), cj = y => Math.round((y - PY0) / PC), lv = f => Math.round((f - LZ0) / 0.5);
  const seen = new Uint8Array(PNX * PNY * PNL), par = new Map(), H = [], ti = ci(to[0]), tj = cj(to[1]);
  const key = (i, j, l) => (l * PNY + j) * PNX + i;
  const push = (f, k, i, j, ft) => { H.push([f, k, i, j, ft]); let n = H.length - 1; while (n > 0) { const p = (n - 1) >> 1; if (H[p][0] <= H[n][0]) break; [H[p], H[n]] = [H[n], H[p]]; n = p; } };
  const pop = () => { const top = H[0], last = H.pop(); if (H.length) { H[0] = last; let n = 0; for (;;) { const a = 2 * n + 1, b = a + 1; let m = n; if (a < H.length && H[a][0] < H[m][0]) m = a; if (b < H.length && H[b][0] < H[m][0]) m = b; if (m === n) break; [H[m], H[n]] = [H[n], H[m]]; n = m; } } return top; };
  const i0 = ci(from[0]), j0 = cj(from[1]), k0 = key(i0, j0, lv(from[2])); push(0, k0, i0, j0, from[2]); const g = new Map([[k0, 0]]); par.set(k0, null);
  let n = 0;
  while (H.length && n++ < 3000000) {
    const [, k, i, j, ft] = pop(); if (seen[k]) continue; seen[k] = 1;
    if (i === ti && j === tj && (toFeet === undefined || Math.abs(ft - toFeet) < 0.6)) { const out = []; let q = k; while (q !== null) { const e = par.get(q); out.push(e ? e[1] : [from[0], from[1], from[2]]); q = e ? e[0] : null; } out.reverse(); out.push([to[0], to[1], ft]); return out; }
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue; const ni = i + di, nj = j + dj, x = PX0 + ni * PC, y = PY0 + nj * PC;
      if (!UX.owns(x, y, ft) || UX.blocked(x, y, ft)) continue;
      if (di && dj && (UX.blocked(PX0 + ni * PC, PY0 + j * PC, ft) || UX.blocked(PX0 + i * PC, PY0 + nj * PC, ft))) continue;   // no corner cutting
      const nf = UX.surf(x, y, ft); if (nf !== nf || nf > ft + 0.9) continue;   // the game allows 1.5 u: leave the walker slack
      const nk = key(ni, nj, lv(nf)); if (seen[nk]) continue;
      const ng = g.get(k) + Math.hypot(di, dj) * PC; if (g.has(nk) && g.get(nk) <= ng) continue;
      g.set(nk, ng); par.set(nk, [k, [x, y, nf]]); push(ng + Math.hypot(PX0 + ti * PC - x, PY0 + tj * PC - y) + (toFeet === undefined ? 0 : Math.abs(nf - toFeet)), nk, ni, nj, nf);
    }
  }
  return null;
}
// walk a planned path (u) through the game step
function follow(P, path, v, dt, tag) {
  if (!path) { ok(false, tag + ': no path'); return false; }
  UX.S.have = false;   // one walker at a time: forget the previous test body's last spot
  for (let w = 1; w < path.length; w++) {
    const [tx, ty] = path[w]; let n = 0, best = 1e9, still = 0;
    while (n++ < 2000) {
      const [lx, ly] = here(P), dd = Math.hypot(tx - lx, ty - ly); if (dd < 0.3) break;
      if (dd < best - 0.01) { best = dd; still = 0; } else if (++still > 120) break;
      const g = step(P, tx, ty, v, dt); const f = feetL(P);
      if (f < g - Y0 - 1e-6) { ok(false, tag + ': feet below ground'); return false; }
    }
    const [lx, ly] = here(P); if (Math.hypot(tx - lx, ty - ly) >= 0.6) { ok(false, tag + ': stuck at ' + [lx, ly].map(q => q.toFixed(1)) + ' feet ' + feetL(P).toFixed(2) + ' (path ' + w + '/' + path.length + ')'); return false; }
  }
  return true;
}
const zoneC = name => { const z = NAVU.zones.find(q => q[6] === name); return [(z[0] + z[2]) / 2, (z[1] + z[3]) / 2]; };
function freeNear(c, feet) { for (let r = 0; r < 30; r++) for (let a = 0; a < 16; a++) { const x = c[0] + r * 0.5 * Math.cos(a * Math.PI / 8), y = c[1] + r * 0.5 * Math.sin(a * Math.PI / 8); if (UX.owns(x, y, feet) && !UX.blocked(x, y, feet) && Math.abs(UX.surf(x, y, feet) - feet) < 0.05) return [x, y]; } return null; }
const ROOMS = ['living', 'kitchen', 'workshop', 'office', 'game', 'guest1', 'guest2', 'guest3', 'guest4'];
const PLANS = {}; let cur = [...M(0, 6), FU];
UX.setOpen(0);
const TGT = { workshop: M(-19.5, 21) };   // the parked rover fills the workshop's centre
for (const r of ROOMS) { const t = freeNear(TGT[r] || zoneC(r), FU); ok(!!t, 'a free floor spot in ' + r); PLANS[r] = t && plan(cur, t, FU); ok(!!PLANS[r], 'planner reaches ' + r + ' from the bay'); }
const hT = freeNear(M(-58, 20), NAVU.hangarZ); PLANS.hangar = plan([...M(0, 6), FU], hT, NAVU.hangarZ); ok(!!PLANS.hangar, 'planner: bay -> hangar door -> stair -> hangar floor');
const sT = NAVU.spawn.scaffoldTop; PLANS.scaffold = PLANS.hangar && plan([hT[0], hT[1], NAVU.hangarZ], [sT[0], sT[1]], sT[2]); ok(!!PLANS.scaffold, 'planner: hangar floor -> scaffold stair -> top landing');
const lidC = [(NAVU.hatch.rim[0] + NAVU.hatch.rim[2]) / 2, (NAVU.hatch.rim[1] + NAVU.hatch.rim[3]) / 2];
PLANS.lid = PLANS.scaffold && plan([sT[0], sT[1], sT[2]], lidC, NAVU.hatch.z); ok(!!PLANS.lid, 'planner: top landing -> closed lid');

for (const [dt, v, tag] of [[1 / 60, 9, '60Hz walk'], [1 / 20, 9, '20Hz walk'], [1 / 20, 22, '20Hz run']]) {
  console.log('== ' + tag);
  UX.setOpen(0); UX.S.want = 0; UX.S.state = 2;
  // deck (under the top level's overhang: the undercliff's apron) -> bay
  const P = player(...M(0, -4), zH(0)); settle(P, dt);
  ok(near(feetL(P), zH(0), 0.05) && UC.isLive(), tag + ': on the pool deck under the overhang (' + feetL(P).toFixed(2) + ')');
  ok(route(P, [[0, 6]], v, dt, tag + ' deck->bay'), tag + ': walks off the pool deck into the cargo bay');
  ok(UC.isInside() && near(feetL(P), zH(0), 0.05), tag + ': the bay floor is the undercliff\'s, at deck level (' + feetL(P).toFixed(2) + ')');
  // every room, out and back
  for (const r of ROOMS) {
    if (!PLANS[r]) continue;
    ok(follow(P, PLANS[r], v, dt, tag + ' ' + r), tag + ': bay -> ' + r);
    ok(near(feetL(P), FU, 0.05) && UC.isInside(), tag + ': standing in the ' + r + ' (' + feetL(P).toFixed(2) + ')');
    ok(follow(P, PLANS[r].slice().reverse(), v, dt, tag + ' ' + r + ' back'), tag + ': ' + r + ' -> bay');
  }
  // walls / rock stop her
  { const Q = player(...M(10, 19), zH(0)); settle(Q, dt); const s0 = fails; route(Q, [[40, 19]], v, dt, 'x'); fails = s0; const [lx] = here(Q); ok(lx < 18 * U, tag + ': the living room\'s east wall / the rock stops her (X ' + (lx / U).toFixed(2) + ' m)'); }
  { const Q = player(...M(0, 45), zH(0)); settle(Q, dt); const s0 = fails; route(Q, [[0, 70]], v, dt, 'x'); fails = s0; const [, ly] = here(Q); ok((Y0U - ly) / U < 52.2, tag + ': the spine\'s end wall stops her (D ' + ((Y0U - ly) / U).toFixed(2) + ' m)'); }
  { const Q = player(...M(12, 20), zH(0)); settle(Q, dt); const s0 = fails; route(Q, [[12, 35]], v, dt, 'x'); fails = s0; const [, ly] = here(Q); ok((Y0U - ly) / U < 28.1, tag + ': living -> office through the rock is blocked (D ' + ((Y0U - ly) / U).toFixed(2) + ' m)'); }
  { const Q = player(...M(-9, 10), zH(0)); settle(Q, dt); const s0 = fails; route(Q, [[-9, 40]], v, dt, 'x'); fails = s0; const [, ly] = here(Q); ok((Y0U - ly) / U < 14.1 || (Y0U - ly) / U < 28.1, tag + ': walls hold her on the way inland (D ' + ((Y0U - ly) / U).toFixed(2) + ' m)'); }
  // hangar door -> stair -> hangar floor
  if (PLANS.hangar) { ok(follow(P, PLANS.hangar, v, dt, tag + ' hangar'), tag + ': bay -> hangar door -> stair down'); ok(near(feetL(P), zH(-12), 0.05), tag + ': on the hangar floor 12 m down (' + ((feetL(P) - FU) / U).toFixed(2) + ' m)'); }
  // the VTOL hull blocks her (fuselage along D at X -65.24)
  { const Q = player(...M(-65.2, 20), zH(-12)); settle(Q, dt); const s0 = fails; route(Q, [[-65.2, 46]], v, dt, 'x'); fails = s0; const [, ly] = here(Q); const Dq = (Y0U - ly) / U; ok(Dq < 30, tag + ': the parked VTOL\'s hull stops her (D ' + Dq.toFixed(2) + ' m)'); }
  // scaffold up to the surface, over the closed lid, onto the plateau
  if (PLANS.scaffold) { ok(follow(P, PLANS.scaffold, v, dt, tag + ' scaffold'), tag + ': scaffold stair from the hangar floor to the top landing'); ok(near(feetL(P), sT[2], 0.1), tag + ': top landing at the surface (' + feetL(P).toFixed(2) + ' u)'); }
  if (PLANS.lid) { ok(follow(P, PLANS.lid, v, dt, tag + ' lid'), tag + ': steps onto the closed hatch lid'); ok(near(feetL(P), NAVU.hatch.z, 0.05), tag + ': standing on the lid (' + feetL(P).toFixed(2) + ' u)'); }
  ok(route(P, [[-65, 30], [-48, 30], [-44, 30]], v, dt, tag + ' plateau'), tag + ': walks off the lid onto the plateau');
  ok(!UC.isLive() && Math.abs(feetL(P) - extGround(...here(P))) < 0.6, tag + ': the plateau is the exterior grid\'s again (' + feetL(P).toFixed(2) + ' vs ' + extGround(...here(P)).toFixed(2) + ')');
  // open hatch = a hole
  { const Q = player(...lidC, NAVU.hatch.z); settle(Q, dt); ok(near(feetL(Q), NAVU.hatch.z, 0.05), tag + ': closed lid holds her'); UX.setOpen(1); for (let i = 0; i < 200; i++) step(Q, ...here(Q), 0, dt); ok(near(feetL(Q), zH(-12), 0.05), tag + ': open hatch: she drops to the hangar floor (' + ((feetL(Q) - FU) / U).toFixed(2) + ' m)'); UX.setOpen(0); }
  // doorway gate while the level is not streamed in
  { UX.S.state = 0; const Q = player(...M(0, 6), zH(0)); settle(Q, dt); const s0 = fails; route(Q, [[0, 20]], v, dt, 'x'); fails = s0; const [, ly] = here(Q); ok((Y0U - ly) / U < 14.7, tag + ': rooms gated until streamed in (D ' + ((Y0U - ly) / U).toFixed(2) + ' m)'); UX.S.state = 2; }
}
// static data checks
ok(NAVU.patches.length >= 30 && NAVU.zones.length >= 14, 'nav: ' + NAVU.patches.length + ' floor patches, ' + NAVU.zones.length + ' zones');
ok(['bay', 'living', 'kitchen', 'workshop', 'office', 'game', 'guest1', 'guest2', 'guest3', 'guest4', 'spine', 'gcorr', 'stair', 'hangar', 'shaft'].every(n => NAVU.zones.some(z => z[6] === n)), 'nav: every room of the brief (living, game, workshop/garage, office, kitchen+dining, guests) + bay, stair, hangar, shaft');
ok(NAVU.lights.length > 40, 'nav: ' + NAVU.lights.length + ' fixtures for the 2-light pool');
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
ok(/<script src="ui\/dm-undercliff\.js\?v=\d+" defer><\/script>\n?/.test(idx) && idx.indexOf('ui/dm-undercliff.js') > idx.indexOf('ui/dm-mansion-interior.js') && idx.indexOf('ui/dm-undercliff.js') < idx.indexOf('ui/dm-facilities.js'), 'index.html loads dm-undercliff.js after the interior, before facilities');
console.log(fails ? fails + ' FAILED of ' + checks : 'OK ' + checks + '/' + checks + ' checks');
process.exit(fails ? 1 : 0);
