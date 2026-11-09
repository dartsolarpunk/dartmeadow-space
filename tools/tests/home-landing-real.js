// node tools/tests/home-landing-real.js — HOME landing on the REAL arrowhead deck (Wave 1: "the HOME landing lamp is in the way").
// Unlike landing-safe.js (synthetic lamps at 100,100 on flat ground) this drives the REAL landing code from index.html (_landSafe, _landSteer, the
// atmo landing frame block, _atmoTouchdown, _landWatchTick / _landForce, _riderEvent) against REAL data:
//   • the mansion shell colliders rasterised from assets/ariel-home/ariel-home.glb LOD0 exactly as ui/dm-mansion-collide.js registers them (glass railings, planters, walls)
//   • every lamp in the committed assets/ariel-home/ariel-home-lamps.json + every room switch post, registered exactly as ui/dm-lamps.js does (pole cylinder + plinth box)
//   • the planned landing pads (ui/dm-landzones.js build + buildGrid on the real nav + lamps + collision grid)
//   • the ground = the real exterior collision grid (assets/ariel-home/ariel-home-collide.json), sea at its water line
// at the HOME teleport target (ui/dm-facilities.js teleport(): mansion-local x -68 / y 22, board 8 units up, facing the mansion) in 4 world yaws x 2 board sizes x 2 frame rates.
// Asserts: no lamp within the planner keep-out of the pad; the pad is clear as-is (no steering / touchdown move needed); the landing cycle reaches enterSurface by itself
// (no landForce from the 16 s / 7 s watchdog); her feet are set exactly on the deck (ground + feetOffset), level with the ground under her own spot (not over a step or drop);
// her capsule and the board footprint are clear of every real solid.       LAMPS_JSON=path overrides the lamp file (diagnostics: compare against an older plan).
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..');
globalThis.window = globalThis; globalThis.location = { search: '' };
require('../../ui/dm-collide.js'); require('../../ui/dm-collide-game.js'); const W = globalThis.DMCollide;
const { load } = require('./lib-glb-node.js'), MC = require('../../ui/dm-mansion-collide.js'), PL = require('../../tools/ariel-home/plan_lamps.js'), Z = require('../../ui/dm-landzones.js');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const A = p => path.join(root, 'assets/ariel-home', p);
const COL = JSON.parse(fs.readFileSync(A('ariel-home-collide.json'), 'utf8')), NAV = JSON.parse(fs.readFileSync(A('ariel-home-interior-nav.json'), 'utf8'));
const LAMPS = JSON.parse(fs.readFileSync(process.env.LAMPS_JSON || A('ariel-home-lamps.json'), 'utf8')).lamps, G = PL.decode(COL);
// ui/dm-lamps.js pure constants + room switch posts (ui/dm-mansion-rooms.js) — the same solids the game registers in group 'lamps'
const sbL = { window: null, console, Math, Float64Array, Int32Array, Uint8Array, Promise, URLSearchParams, fetch: () => Promise.reject(new Error('no net')), location: { search: '' } }; sbL.window = sbL; sbL.globalThis = sbL;
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-rooms.js'), 'utf8'), sbL); vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-lamps.js'), 'utf8'), sbL, { filename: 'dm-lamps.js' });
const LP = sbL.DMLamps._pure, UPM = LP.UPM, POLE_H = LP.POLE_H, ROOMS = sbL.DMMansionRooms ? sbL.DMMansionRooms.ROOMS : require('../../ui/dm-mansion-rooms.js').ROOMS;
const HOME = PL.HOME_PAD, KEEP = PL.HOME_KEEP;

console.log('== lamp plan vs the HOME pad (' + LAMPS.length + ' lamps)');
const deckLamps = LAMPS.filter(l => Math.abs(l[2]) < 0.3 && Math.hypot(l[0] - HOME[0], l[1] - HOME[1]) < 40);
let nearest = 1e9; for (const l of LAMPS) nearest = Math.min(nearest, Math.hypot(l[0] - HOME[0], l[1] - HOME[1]));
ok(nearest >= KEEP, 'nearest lamp to the HOME pad is ' + (nearest / UPM).toFixed(1) + ' m away (keep-out ' + (KEEP / UPM).toFixed(1) + ' m)');
ok(deckLamps.length === 0, 'no solid street lamp on the arrowhead deck (' + deckLamps.map(l => '[' + l[0] + ',' + l[1] + ']').join(' ') + ')');
const LEDS = JSON.parse(fs.readFileSync(process.env.LAMPS_JSON || A('ariel-home-lamps.json'), 'utf8')).leds || [];
ok(process.env.LAMPS_JSON || LEDS.length >= 12, 'the deck is lit by ' + LEDS.length + ' non-solid rail LEDs (not registered as solids below, exactly like ui/dm-lamps.js)');

// ── the real landing code from index.html
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
function block(a, b) { const i = src.indexOf(a); if (i < 0) throw new Error('anchor ' + a); const j = src.indexOf(b, i); if (j < 0) throw new Error('anchor ' + b); return src.slice(i, j + b.length); }
// the per-frame landing branch of the atmo controller (terrain floor, settle + _landSteer, floor clamp, touchdown trigger), verbatim
const LAND_FRAME = block('  const groundH=_atmoHeight?_atmoHeight(s.pos.x,s.pos.z):0;', 'setTimeout(_atmoTouchdown,0);\n  }');
const MACH = src.match(/atmoMach=THREE\.MathUtils\.lerp\(atmoMach,landing\?0:atmoThrottle\*cap,landing\?Math\.min\(1,dt\*2\.2\):0\.04\);/);
if (!MACH) throw new Error('landing brake line moved');
const CONST = ['CHAR_TERRAIN_BOARD_SIDE', 'CHAR_TERRAIN_HEIGHT'].map(k => { const m = src.match(new RegExp('const ' + k + ' = ([0-9.]+);')); if (!m) throw new Error(k); return 'const ' + k + '=' + m[1] + ';'; }).join('');

class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } clone() { return new V3(this.x, this.y, this.z); } }
const mkObj = () => ({ parent: null, visible: true, userData: {}, position: new V3(), scale: { x: 1, setScalar(a) { this.x = a; }, set(a) { this.x = a; } }, rotation: { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } } });

function scenario(TH, boardHalf, boardHalfW, fps) {
  const PX = 4123.5, PZ = -877.25, Y0 = 311.0, ct = Math.cos(TH), st = Math.sin(TH);
  const toW = (lx, ly) => { const lz = -ly; return [PX + lx * ct + lz * st, PZ - lx * st + lz * ct]; };
  const toL = (x, z) => { const dx = x - PX, dz = z - PZ; return [dx * ct - dz * st, -(dx * st + dz * ct)]; };
  W.clearGroup('mansion'); W.clearGroup('lamps'); Z.clear();
  // mansion shell, exactly like DMMansionCol.attach (root at (PX,Y0,PZ), rotation.y = TH)
  const base = [ct, 0, -st, 0, 0, 1, 0, 0, st, 0, ct, 0, PX, Y0, PZ, 1], lod0 = load(A('ariel-home.glb'), base).root.getObjectByName('Mansion_LOD0');
  MC._pure.prepare(lod0); const nb = W.runGen(W.fromMeshGen('mansion', lod0, MC._pure.OPTS, 400));
  // lamps + switch posts, exactly like DMLamps.attach (nav (x,y,z) -> group local (x, z, -y) -> world)
  for (const l of LAMPS) { const [x, z] = toW(l[0], l[1]), y = Y0 + l[2]; W.addCylinder('lamps', x, y, y + POLE_H, z, 0.11 * UPM * 1.4, 'metal'); W.addBox('lamps', x, y + 0.15 * UPM, z, 0.45 * UPM, 0.15 * UPM, 0.45 * UPM, 0, 'stone'); }
  for (const r of ROOMS) if (r.sw) { const [x, z] = toW(r.sw[0], r.sw[1]), y = Y0 + r.sw[2]; W.addCylinder('lamps', x, y, y + 1.05 * UPM, z, 0.2 * UPM, 'metal'); }
  // the walking height near the mansion = the collision grid (F.solids grid in place()), the sea below it
  const SEA = Y0 + COL.sea;
  const ground = (x, z) => { const [bx, by] = toL(x, z), i = Math.round((bx - COL.x0) / COL.cell), j = Math.round((by - COL.y0) / COL.cell); if (i < 0 || j < 0 || i >= COL.nx || j >= COL.ny) return SEA - 2; const v = G[j * COL.nx + i]; return v <= COL.sea + 0.6 ? SEA - 2 : Y0 + v; };
  W.setGround(ground); W.setWater(() => SEA, null);
  const pads = Z.build(NAV, LAMPS).concat(Z.buildGrid(NAV, LAMPS, G, COL)); Z.set(pads, (lx, ly, lz, o) => { const [x, z] = toW(lx, ly); o[0] = x; o[1] = Y0 + lz; o[2] = z; }, 1);

  let clock = 1000; const events = [], raf = [], timers = [], entered = [], dismount = [];
  const ctx = { console: { warn() { }, log() { } }, Math, isFinite, document: { hidden: false }, performance: { now: () => clock },
    window: { DMCollide: W, DMLandZones: Z, DMCrumb: { mark: (a, b) => events.push([a, b]) }, dmPerfLog: { event: (a, b) => events.push([a, b]) } },
    THREE: { Vector3: V3, MathUtils: { lerp: (a, b, t) => a + (b - a) * t } }, requestAnimationFrame: f => raf.push(f), setTimeout: f => timers.push(f), setInterval: () => 0, toast() { }, setCharState() { }, _forceCharVisible() { },
    SURF_BOARD_WAIST: 1, CHAR_MOUNT_YAW_OFFSET: 0, CHAR_TERRAIN_YAW_EXTRA: 0, _surfBoardDims: b => ({ half: boardHalf * Math.abs(b.scale.x), halfW: boardHalfW * Math.abs(b.scale.x) }), _surfBoardSide: () => 2.7,
    _surfHeight: ground, _atmoHeight: ground };
  ctx.DMCrumb = ctx.window.DMCrumb; ctx.dmPerfLog = ctx.window.dmPerfLog; ctx.DMLandZones = Z;
  const scene = { children: [], add(o) { if (o.parent) o.parent.remove(o); o.parent = this; this.children.push(o); }, remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; } };
  const board = mkObj(); board.scale.x = 2.2;   // the sky board is bigger; it eases to walking size while it lands
  ctx.PW = { active: true, body: {}, site: {}, scene, board, gen: 7, pal: { grav: 9 }, camera: { position: new V3() } };
  ctx.CHAR = { loaded: true, root: mkObj(), _transitioning: false, mounted: true, feetOffset: 0.93, scaleForTerrain: 1.1 };
  ctx.BOARD_CALL = { parked: false, parkPos: null, parkLocal: null, summon: null, summonAt: 0 }; ctx._boardCallReset = () => { };
  ctx.enterSurface = (b, s, o) => { entered.push({ o, t: clock }); ctx.__surf = true; };
  ctx.boardDismountSequence = (sc, feetY, cb, o) => { dismount.push({ feetY, o, bx: o.board.position.x, by: o.board.position.y, bz: o.board.position.z }); cb(); };
  vm.createContext(ctx);
  vm.runInContext(CONST + ['_riderEvent', '_terrainBoardSideWorld', '_landSafe', '_surfPlaceAt', '_surfInSolid', '_landSteer', '_boardUnstick', '_landForce', '_landWatchTick', '_atmoTouchdown'].map(fn).join('\n') +
    '\nlet _riderFixN=0,_landTok=0,_landWd={sink:0,stuck:0,trans:0,tdAt:0}; let surfaceActive=false,atmoActive=true,atmoState=null,surfPlayer=null,surfBoard=null,atmoBoard=PW.board,atmoMach=0,atmoThrottle=0,cap=1;' +
    '\nfunction __frame(s,dt){ const landing=s.landing; ' + MACH[0] + '\n' + LAND_FRAME + '\n if(!s.touchdown) atmoBoard.position.copy(s.pos); { const want=(landing||s.touchdown)?1:2.2, bs=atmoBoard.scale.x; if(Math.abs(want-bs)>1e-3) atmoBoard.scale.setScalar(bs+(want-bs)*Math.min(1,dt*1.6)); } }', ctx);
  const run = c => vm.runInContext(c, ctx);
  // ui/dm-facilities.js teleport(): HOME = local (-68, lz -22) = nav (-68, 22), board 8 units over the deck origin, facing the mansion; afterTeleport(land): landing, throttle 0
  const [tx, tz] = toW(HOME[0], HOME[1]), fx = PX - tx, fz = PZ - tz, yaw = Math.atan2(-fx, -fz);
  ctx.__init = { tx, ty: Y0 + 8, tz, yaw };
  run('atmoState={pos:new THREE.Vector3(__init.tx,__init.ty,__init.tz),vel:new THREE.Vector3(),yaw:__init.yaw,pitch:-0.08,landing:true,takeoff:0,auto:null,touchdown:false}; atmoMach=0;');
  const tag = 'yaw ' + TH.toFixed(1) + ' board ' + boardHalf + 'x' + boardHalfW + ' @' + fps + 'fps: ';
  // the pad as-is: clear for her capsule + the board footprint, no steering needed
  const r0 = run('_landSafe(' + tx + ',' + tz + ',' + yaw + ')');
  ok(r0.ok && !r0.moved, tag + 'the HOME pad itself is clear (' + nb + ' shell boxes, ' + W.groupCount('lamps') + ' lamp solids)');
  // fly the landing frame by frame; the 2 Hz watchdog runs too and must never need to force anything
  const dt = 1 / fps; let t = 0, nextWd = 500;
  while (!entered.length && t < 20000) {
    clock += dt * 1000; t += dt * 1000;
    if (run('atmoActive') && !ctx.__surf) run('__frame(atmoState,' + dt + ')');
    while (timers.length) timers.shift()();
    const q = raf.splice(0); q.forEach(f => f());
    if (t >= nextWd) { nextWd += 500; run('_landWatchTick()'); }
  }
  const forced = events.filter(e => /landForce|landNoSpot/.test(e[1] && e[1].why || ''));
  ok(entered.length === 1, tag + 'the landing cycle completes (enterSurface after ' + (t / 1000).toFixed(2) + ' s)');
  ok(t < 7000, tag + 'well inside the watchdog windows (16 s landing / 7 s touchdown): ' + (t / 1000).toFixed(2) + ' s');
  ok(forced.length === 0, tag + 'no watchdog force / no-spot event (' + forced.map(e => e[1].why).join(',') + ')');
  ok(!events.some(e => e[1] && e[1].why === 'landMove'), tag + 'the touchdown did not have to move off the pad');
  if (!dismount.length) { ok(false, tag + 'dismount ran'); return; }
  const d = dismount[0], gB = ground(d.bx, d.bz), size = ctx.CHAR.scaleForTerrain;
  ok(Math.abs(d.feetY - (gB + ctx.CHAR.feetOffset * size)) < 1e-9, tag + 'her feet are set at the deck height + feetOffset (not floating / sunk)');
  ok(Math.abs(gB - Y0) < 0.3, tag + 'the board set down on the deck level (' + (gB - Y0).toFixed(2) + ' over the mansion origin)');
  ok(Math.abs(d.by - (gB + 0.08)) < 1e-6, tag + 'the board rests on the deck (+0.08)');
  const [bl, by] = toL(d.bx, d.bz); ok(Math.hypot(bl - HOME[0], by - HOME[1]) < 1.5, tag + 'touchdown at the HOME pad (' + bl.toFixed(1) + ',' + by.toFixed(1) + ')');
  // her own spot beside the board (the same side offset _landSafe validates): level with the board's ground, capsule clear, nothing on top of her
  const sd = Math.min(d.o.sideOffset, 1.4), rx = Math.cos(yaw), rz = -Math.sin(yaw), hx = d.bx - rx * sd, hz = d.bz - rz * sd, gH = ground(hx, hz);
  ok(Math.abs(gH - gB) < 0.15, tag + 'her feet are level with the board (ground step ' + (gH - gB).toFixed(2) + ')');
  ok(W.pushOut(hx, gH, hz, 0.7, 3.1, 0.6, [0, 0]) < 1e-3, tag + 'her capsule is clear of every lamp, planter, railing and wall');
  let hit = 0; const ux = -Math.sin(yaw), uz = -Math.cos(yaw); for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) { const qx = d.bx + ux * boardHalf * i * 0.5 - uz * boardHalfW * j, qz = d.bz + uz * boardHalf * i * 0.5 + ux * boardHalfW * j; if (W.sphereOut(qx, ground(qx, qz) + 0.7, qz, 0.8) > 0.02) hit++; }
  ok(hit === 0, tag + 'the board footprint is clear');
  let lampD = 1e9; for (const l of LAMPS) { const [lx, lz] = toW(l[0], l[1]); lampD = Math.min(lampD, Math.hypot(lx - hx, lz - hz), Math.hypot(lx - d.bx, lz - d.bz)); }
  ok(lampD / UPM >= 8, tag + 'nearest lamp pole to her / the board: ' + (lampD / UPM).toFixed(1) + ' m');
  // a hand-flown LAND anywhere round the pad (rider + board footprint ring, any heading) also sets down without a detour
  let moved = 0, tried = 0; for (let a = 0; a < 8; a++) for (const rr of [0, 2, 4]) for (let hy = 0; hy < 4; hy++) { tried++; const [x, z] = toW(HOME[0] + rr * Math.cos(a * Math.PI / 4), HOME[1] + rr * Math.sin(a * Math.PI / 4)); const r = run('_landSafe(' + x + ',' + z + ',' + (hy * Math.PI / 2) + ')'); if (!r.ok || r.moved) moved++; }
  ok(moved === 0, tag + 'LAND within 4 units (2.2 m) of the pad, 4 headings: ' + (tried - moved) + '/' + tried + ' clear in place');
}

console.log('== landing on the HOME pad (real shell + lamps + pads + grid)');
for (const TH of [0, 0.8, 2.5, 4.0]) for (const [bh, bw] of [[1.5, 0.4], [2.2, 0.6]]) for (const fps of [60, 15]) scenario(TH, bh, bw, fps);
console.log(fails ? 'home-landing-real: FAILED ' + fails + '/' + n : 'home-landing-real: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
