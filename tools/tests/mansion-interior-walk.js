// Headless walk test for Ariel's mansion interior (ui/dm-mansion-interior.js + assets/ariel-home/ariel-home-interior-nav.json).
// Replays the game's own updateSurface step (move -> DMMansionInt.walk -> gravity -> snap to ground = F.ovr else exterior grid) at 60 Hz and 20 Hz
// and checks: she walks from the skyboard landing deck through the front door into every room, up the stairs to the loft and back, never falls
// through a floor, never passes a wall / prop, and walks back out. Pure node, no deps:  node tools/tests/mansion-interior-walk.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const NAVJ = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-interior-nav.json'), 'utf8'));
const COL = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-collide.json'), 'utf8'));
const sb = { window: null, performance: { now: () => T_NOW }, atob: s => Buffer.from(s, 'base64').toString('binary'), console, Math, Float64Array, Uint8Array, Set, Promise, fetch: () => Promise.reject(new Error('no fetch')) };
sb.window = sb; sb.globalThis = sb; let T_NOW = 1000;
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-interior.js'), 'utf8'), sb, { filename: 'dm-mansion-interior.js' });
const D = sb.DMMansionInt, X = D._test;
// exterior collision grid, same decode as ui/dm-facilities.js (mansion-local x east, y seaward; grid value/scale = height; <= sea+0.6 = nothing)
const cb = Buffer.from(COL.data, 'base64'), ch = new Int16Array(cb.buffer, cb.byteOffset, cb.length >> 1), inv = 1 / COL.scale, NEG = -1e9;
function extGround(lx, ly) { const i = Math.round((lx - COL.x0) / COL.cell), j = Math.round((ly - COL.y0) / COL.cell); if (i < 0 || j < 0 || i >= COL.nx || j >= COL.ny) return NEG; const v = ch[j * COL.nx + i] * inv; return v <= COL.sea + 0.6 ? NEG : v; }

let fails = 0, checks = 0;
function ok(c, msg) { checks++; if (!c) { fails++; console.log('  FAIL ' + msg); } }

// frame: arbitrary yaw/offset so the world<->local transform is exercised too
const PX = 4123.5, PZ = -877.25, Y0 = 311.0, TH = 0.8; X.parse(NAVJ); X.setFrame(PX, PZ, Y0, TH); X.S.F.ovr = X.ovr; X.S.rec = {};
const ct = Math.cos(TH), st = Math.sin(TH);
const toW = (lx, ly) => { const lz = -ly; return [PX + lx * ct + lz * st, PZ - lx * st + lz * ct]; };
const toL = (x, z) => { const dx = x - PX, dz = z - PZ; return [dx * ct - dz * st, -(dx * st + dz * ct)]; };
function extH(x, z) { const [lx, ly] = toL(x, z); const e = extGround(lx, ly); return e === NEG ? -1e4 : Y0 + e; }
const wrapH = (x, z) => { const o = X.S.F.ovr; if (o !== null) { const v = o(x, z); if (v === v) return v; } return extH(x, z); };   // DMFac.wrapH: ovr else exterior
function ground(x, z) { return D.ground(wrapH, x, z); }   // updateSurface: her own ground query goes through DMMansionInt.ground

function newPlayer(lx, ly, feet) { const [x, z] = toW(lx, ly); return { x, z, y: Y0 + feet + 3, vy: 0, pos: { x, y: Y0 + feet + 3, z } }; }
// one updateSurface step toward local target (tx,ty) at speed v for dt
function step(P, tx, ty, v, dt) {
  T_NOW += dt * 1000;
  const [lx, ly] = toL(P.pos.x, P.pos.z), dx = tx - lx, dy = ty - ly, d = Math.hypot(dx, dy); if (d > 1e-6) { const m = Math.min(d, v * dt) / d; const [wx, wz] = toW(lx + dx * m, ly + dy * m); P.pos.x = wx; P.pos.z = wz; }
  D.walk(P.pos);
  P.vy -= 9.8 * dt; P.pos.y += P.vy * dt;
  const g = ground(P.pos.x, P.pos.z), eye = g + 3.0; if (P.pos.y <= eye) { P.pos.y = eye; P.vy = 0; }
  return g;
}
// walk a polyline of local waypoints; returns {p, minClear (feet above ground, <0 would be through), maxFall, stuck}
function route(P, pts, v, dt, tag) {
  let maxDrop = 0, last = P.pos.y - 3, minTop = 1e9, tt = 0;
  for (const [tx, ty] of pts) {
    let n = 0;
    while (n++ < 4000) {
      const [lx, ly] = toL(P.pos.x, P.pos.z); if (Math.hypot(tx - lx, ty - ly) < 0.4) break;
      const g = step(P, tx, ty, v, dt); tt += dt;
      const feet = P.pos.y - 3; if (feet < g - 1e-6) ok(false, tag + ': feet below ground'); maxDrop = Math.max(maxDrop, last - feet); last = feet;
      if (feet < Y0 - 4) { ok(false, tag + ': fell off (' + feet.toFixed(1) + ') near ' + toL(P.pos.x, P.pos.z).map(q => q.toFixed(1))); return { p: P, maxDrop, stuck: true }; }
    }
    const [lx, ly] = toL(P.pos.x, P.pos.z);
    if (n >= 4000) { ok(false, tag + ': stuck going to (' + tx + ',' + ty + ') at ' + lx.toFixed(1) + ',' + ly.toFixed(1) + ' feet ' + (P.pos.y - 3 - Y0).toFixed(2)); return { p: P, maxDrop, stuck: true }; }
  }
  { const [lx, ly] = toL(P.pos.x, P.pos.z); for (let i = 0; i < 90; i++) step(P, lx, ly, 0, dt); }   // let her land (running down the stairs leaves the ramp for a moment)
  return { p: P, maxDrop, stuck: false };
}
const loc = P => { const [lx, ly] = toL(P.pos.x, P.pos.z); return { lx, ly, f: P.pos.y - 3 - Y0 }; };
const near = (P, x, y, r = 1.0) => { const l = loc(P); return Math.hypot(l.lx - x, l.ly - y) < r; };

const HF = NAVJ.floor.hall, PF = NAVJ.floor.prow, WF = NAVJ.floor.wing;
for (const [hz, dt] of [[60, 1 / 60], [20, 1 / 20]]) {
  for (const [vn, v] of [['walk', 14], ['run', 30]]) {
    const tag = hz + 'Hz ' + vn;
    console.log('== ' + tag);
    // 1. landing deck (teleport spot in ui/dm-facilities.js: local x -68, y +22) -> west terrace -> front door D1 -> hall -> living -> back out
    let P = newPlayer(-68, 22, 0); D.walk(P.pos); T_NOW += 300;
    let r = route(P, [[-60, 8], [-54, 4], [-54, -2.0], [-54, -6], [-45, -14]], v, dt, tag + ' deck->D1->hall');
    ok(!r.stuck && near(P, -45, -14) && Math.abs(loc(P).f - HF) < 0.05, tag + ': ended in hall on the hall floor ' + JSON.stringify(loc(P)));
    ok(r.maxDrop < 1.0, tag + ': no drop-off on the doorway threshold (max ' + r.maxDrop.toFixed(2) + ')');
    // 2. hall -> kitchen -> up the stairs -> loft -> back down
    r = route(P, [[-45, -14], [-40, -5], [-33.2, -5], [-33.2, -8.0], [-33.2, -20], [-33.2, -28.5], [-33.2, -33], [-37, -35.2], [-45, -35.2]], v, dt, tag + ' stairs up');
    ok(!r.stuck && Math.abs(loc(P).f - NAVJ.patches[2][5]) < 0.05, tag + ': on the loft floor after the stairs ' + JSON.stringify(loc(P)));
    r = route(P, [[-45, -35.2], [-37, -35.2], [-33.2, -33], [-33.2, -28.5], [-33.2, -9], [-33.2, -5], [-40, -5]], v, dt, tag + ' stairs down');
    ok(!r.stuck && Math.abs(loc(P).f - HF) < 0.05, tag + ': back on the hall floor ' + JSON.stringify(loc(P)));
    // 3. loft rail stops her at the edge (never steps off into the kitchen from the loft front)
    route(P, [[-33.2, -8.0], [-33.2, -28.5], [-33.2, -33], [-37, -35.2], [-50, -35.2]], v, dt, tag + ' to loft');
    const before = loc(P); for (let i = 0; i < 240; i++) step(P, -50, -10, v, dt);
    ok(loc(P).f > 9.5, tag + ': loft rail held (f=' + loc(P).f.toFixed(2) + ' at ' + loc(P).lx.toFixed(1) + ',' + loc(P).ly.toFixed(1) + ')');
    // 4. hall -> pool podium via the ramp/steps -> prow doorway D2 -> music/game studio -> telescope
    P = newPlayer(-54, 4, 0); D.walk(P.pos); T_NOW += 300;
    r = route(P, [[-54, -4.5], [-20, -4.5], [0, -4.5], [0, -1], [0, 8], [0, 20], [0, 45], [0, 58]], v, dt, tag + ' hall->prow');
    ok(!r.stuck && near(P, 0, 58, 1.5) && Math.abs(loc(P).f - PF) < 0.05, tag + ': at the telescope on the prow floor ' + JSON.stringify(loc(P)));
    r = route(P, [[0, 8], [0, -1.5], [0, -4.5], [43, -4.5], [43, -10.5], [43, -14]], v, dt, tag + ' prow->podium');
    ok(!r.stuck && Math.abs(loc(P).f - 2.5) < 0.05, tag + ': on the pool podium ' + JSON.stringify(loc(P)));
    // 5. arrival wing: out the pedestrian door D... wing door (-65..-59), garage lane (-26..-10.4) both ways
    P = newPlayer(-62, -62, 0); D.walk(P.pos); T_NOW += 300;
    r = route(P, [[-60.15, -66], [-60.15, -72], [-60.15, -80], [-56, -80]], v, dt, tag + ' wing ped door');
    ok(!r.stuck && Math.abs(loc(P).f - WF) < 0.05, tag + ': in the wing on its floor ' + JSON.stringify(loc(P)));
    r = route(P, [[-60.15, -80], [-60.15, -72], [-60.15, -64]], v, dt, tag + ' wing out');
    // 6. walls: from inside the hall push into the rear / west / east walls and the glass front line: she must stay inside
    for (const [tx, ty] of [[0, -60], [-120, -20], [120, -20]]) {
      P = newPlayer(-45, -14, 0); D.walk(P.pos); T_NOW += 300;
      for (let i = 0; i < 600; i++) step(P, tx, ty, v, dt);
      const l = loc(P); ok(l.lx > NAVJ.rooms[0][1] && l.lx < NAVJ.rooms[0][3] + 2 && l.ly > NAVJ.rooms[0][2] - 2 && Math.abs(l.f - HF) < 3, tag + ': wall held toward (' + tx + ',' + ty + ') ended ' + JSON.stringify(l));
    }
    // front glass: push straight at the glass away from the door gap
    P = newPlayer(-40, -6, 0); D.walk(P.pos); T_NOW += 300; for (let i = 0; i < 300; i++) step(P, -40, 20, v, dt);
    ok(loc(P).ly < -2.0 && Math.abs(loc(P).f - HF) < 0.05, tag + ': front glass held away from the door ' + JSON.stringify(loc(P)));
  }
}
// doorway gate: before the interior meshes are in (state 0 / 1) she walks the deck and the terrace right up to the glass (no roof pop on the overhang strip) but is held out of the rooms; once it is ready (state 2) the same walk goes in
for (const st0 of [0, 1]) {
  X.S.state = st0; let P = newPlayer(-68, 22, 0); D.walk(P.pos); T_NOW += 300;
  const r = route(P, [[-60, 8], [-54, 4], [-54, -2.0]], 30, 1 / 30, 'gate state ' + st0 + ' to the door');
  ok(!r.stuck && Math.abs(loc(P).f) < 0.05, 'gate state ' + st0 + ': on the terrace at the door, floor 0 (no roof pop) ' + JSON.stringify(loc(P)));
  for (let i = 0; i < 240; i++) step(P, -54, -20, 30, 1 / 30);
  ok(loc(P).ly > -3.2 && Math.abs(loc(P).f) < 0.05, 'gate state ' + st0 + ': held at the threshold ' + JSON.stringify(loc(P)));
  X.S.state = 2; for (let i = 0; i < 240; i++) step(P, -54, -20, 30, 1 / 30);
  ok(loc(P).ly < -8 && Math.abs(loc(P).f - HF) < 0.05, 'gate lifted (state 2): she walks in ' + JSON.stringify(loc(P)));
}
X.S.state = 2;
// and back out: hall -> D1 -> terrace -> deck and on to the landing spot, no drop-off at the sill
for (const [vn, v] of [['walk', 14], ['run', 30]]) { const P = newPlayer(-45, -14, 0); D.walk(P.pos); T_NOW += 300;
  const r = route(P, [[-54, -6], [-54, -1], [-54, 4], [-60, 9], [-68, 22]], v, 1 / 60, 'out ' + vn);
  ok(!r.stuck && Math.abs(loc(P).f) < 0.05 && near(P, -68, 22, 1.0) && r.maxDrop < 1.0, 'back out (' + vn + ') on the deck ' + JSON.stringify(loc(P)) + ' maxDrop ' + r.maxDrop.toFixed(2)); }
// hitches: one huge frame (dt 0.25 at run) must not tunnel through the west wall / a loft rail
{ const P = newPlayer(-60, -10, 0); D.walk(P.pos); T_NOW += 300; for (let i = 0; i < 40; i++) step(P, -140, -10, 30, 0.25); const l = loc(P); ok(l.lx > -92 && Math.abs(l.f - HF) < 0.05, 'hitch frames: wall held ' + JSON.stringify(l)); }
// leaving: she walks away from the footprint, walk() goes idle and ovr answers NaN (exterior grid is back in charge)
{ const P = newPlayer(-54, 4, 0); D.walk(P.pos); const [wx, wz] = toW(-54, 400); P.pos.x = wx; P.pos.z = wz; D.walk(P.pos); T_NOW += 300; ok(!(ground(wx, wz) === ground(wx, wz)) || ground(wx, wz) === extH(wx, wz), 'far away: exterior grid in charge'); ok(D.status().live === false, 'far away: walk() idle'); }
// F.ovr is narrow: only her ground query (DMMansionInt.ground) sees the interior floor; every other height lookup through the same wrapped path (board, camera probes, trees) does not
{ const P = newPlayer(-30, -10, 0.6); D.walk(P.pos); T_NOW += 50; D.walk(P.pos); ok(D.status().live === true, 'narrow: live indoors');
  const [wx, wz] = toW(-20, -10);   // hall, away from props
  const her = ground(wx, wz), other = wrapH(wx, wz);
  ok(Math.abs(her - (Y0 + 0.6)) < 0.05, 'narrow: her ground query = interior hall floor ' + (her - Y0).toFixed(2));
  ok(other === extH(wx, wz) && Math.abs(other - her) > 0.05, 'narrow: a plain lookup (board/camera/tree) is untouched by F.ovr ' + (other - Y0).toFixed(2));
  ok(X.ovr(wx, wz) !== X.ovr(wx, wz), 'narrow: F.ovr answers NaN outside ground()');
  let threw = false; try { D.ground(() => { throw new Error('x'); }, wx, wz); } catch (e) { threw = true; } ok(threw && X.ovr(wx, wz) !== X.ovr(wx, wz), 'narrow: flag cleared even when the lookup throws');
  ok(D.ground(wrapH, wx, wz) === her && wrapH(wx, wz) === other, 'narrow: repeat calls stay consistent (no leaked state)'); }
console.log((fails ? 'FAILED ' : 'OK ') + (checks - fails) + '/' + checks + ' checks');
process.exit(fails ? 1 : 0);
