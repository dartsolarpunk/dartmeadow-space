// (v336) Valles Rim + Travel LAND unit test (no browser):
//  1. ui/dm-arielhome.js LAND from another world's sky / the Bird Temple deck / a space-mode world: it leaves first, then lands, and
//     DM_FAC.arriveAt is still set when enterAtmosphericFlight runs (it used to be cleared by _pwRestoreSpace, or the call returned silently).
//  2. ui/dm-facilities.js mars-valles: placed on a cliff, PBR materials swapped in, roof surface, six DMCollide bodies in the right place
//     (yaw convention checked by point tests), arrival = landing on the deck (land=true), teardown frees the bodies.
//   node tools/tests/valles-unit.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
let fails = 0, checks = 0; const ok = (c, m) => { checks++; if (!c) { fails++; console.log('  FAIL ' + m); } };
// ── a tiny THREE (build-time API only) ──
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class Obj { constructor() { this.children = []; this.position = new V3(); this.rotation = { x: 0, y: 0, z: 0 }; this.userData = {}; this.parent = null; this.visible = true; }
  add(o) { o.parent = this; this.children.push(o); } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; }
  traverse(f) { f(this); for (const c of this.children.slice()) c.traverse(f); } lookAt() { } updateMatrixWorld() { } }
class Mesh extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; this.isMesh = true; } }
class Geo { rotateX() { return this; } rotateY() { return this; } translate() { return this; } dispose() { } }
class Mat { constructor(o) { Object.assign(this, o || {}); } clone() { return new this.constructor(this); } }
class Tex { constructor(img) { this.image = img; this.repeat = { set() { } }; this.offset = { x: 0, y: 0 }; } clone() { return new Tex(this.image); } }
const THREE = { Group: Obj, Mesh, BoxGeometry: Geo, ExtrudeGeometry: Geo, RingGeometry: Geo, PlaneGeometry: Geo, Shape: class { moveTo() { } lineTo() { } },
  MeshStandardMaterial: class extends Mat { }, MeshBasicMaterial: class extends Mat { }, CanvasTexture: Tex, Vector2: class { constructor(x, y) { this.x = x; this.y = y; } },
  RepeatWrapping: 1000, SRGBColorSpace: 'srgb', DoubleSide: 2 };
const canvas = () => ({ width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() { }, createRadialGradient: () => ({ addColorStop() { } }), fillRect() { }, set fillStyle(v) { } }) });
const timers = []; const fakeTimeout = (f, ms) => { timers.push(f); return timers.length; };
const flush = (n = 400) => { for (let i = 0; i < n && timers.length; i++) timers.shift()(); };
const boxes = []; let cleared = 0;
let fakeNow = 1000; const perf = { now: () => fakeNow };
const sb = { console, Math, Float64Array, Float32Array, Uint8Array, Uint8ClampedArray, Int16Array, Set, Map, Promise, JSON, Date, performance: perf, setTimeout: fakeTimeout, clearTimeout() { },
  navigator: { userAgent: 'node' }, document: { hidden: false, createElement: canvas }, location: { search: '' }, CustomEvent: function () { }, addEventListener() { }, dispatchEvent() { },
  DMCrumb: { begin() { }, end() { }, mark() { }, live() { }, gpu() { } },
  DMCollide: { addBox: (g, x, y, z, hx, hy, hz, yaw, m) => { boxes.push({ g, x, y, z, hx, hy, hz, yaw, m }); return boxes.length - 1; }, addCylinder: () => 0, clearGroup: (g) => { if (g === 'facility') { cleared++; boxes.length = 0; } } } };
sb.window = sb; sb.globalThis = sb;
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-arielhome.js'), 'utf8'), sb, { filename: 'dm-arielhome.js' });
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-facilities.js'), 'utf8'), sb, { filename: 'dm-facilities.js' });
const A = sb.DMArielHome, F = sb.DMFac;
const site = A.site('mars-valles'); ok(site && site.variant === 'mars' && site.body === 'Mars', 'mars-valles site row');

// ── 1. LAND flow ──
function world(state) {
  const log = [];
  const c = { toast: () => { }, closeQuickTravel: () => log.push('closeQT'), GALAXY_DB: { current: 'milkyway' }, curGalaxy: () => state.gal, curSysName: () => state.sys,
    get flightInited() { return true; }, STATE: { get screen() { return 'flight'; } }, get atmoActive() { return state.atmo; }, get surfaceActive() { return state.surf; },
    get PW() { return state.pw; }, get sysBusy() { return false; }, celestialBodies: [{ name: 'Mars', mesh: {} }, { name: 'Solenne', mesh: {} }],
    shipWalk: () => state.deck, exitShipWalk: () => { log.push('exitShipWalk'); state.deck = false; },
    atmoExitToSpace: () => { log.push('atmoExit'); state.atmo = false; state.pw = { active: false }; }, exitSurface: () => { log.push('exitSurface'); state.surf = false; state.pw = { active: false }; },
    closeWorld: () => { log.push('closeWorld'); state.pw = { active: false }; sb.DM_FAC.arriveAt = null; },   // like _pwCloseToSpace -> _pwRestoreSpace
    fastTravelToSystem: (sys, gal) => { log.push('ft:' + gal); state.gal = gal; state.sys = 'Sol'; },
    enterAtmosphericFlight: (b, s) => { log.push('enter:' + b.name + ':' + sb.DM_FAC.arriveAt); if (state.atmo && !(state.pw.body && state.pw.body.name === b.name)) log.push('SILENT'); },
    openFastTravel: (t, sub, go) => { log.push('dlg:' + t); state.go = go; } };
  A.bind(c); return log;
}
const cases = [
  ['in another world\'s sky (Solenne, Veyra)', { gal: 'lumenreach', sys: 'Veyra', atmo: true, surf: false, deck: false, pw: { active: true, body: { name: 'Solenne' } } }, ['atmoExit', 'ft:milkyway']],
  ['on another world\'s ground (Earth, Sol)', { gal: 'milkyway', sys: 'Sol', atmo: false, surf: true, deck: false, pw: { active: true, body: { name: 'Earth' } } }, ['exitSurface']],
  ['on the Bird Temple deck near Veyra', { gal: 'lumenreach', sys: 'Veyra', atmo: false, surf: false, deck: true, pw: { active: false } }, ['exitShipWalk', 'ft:milkyway']],
  ['near Mars, world open in space mode', { gal: 'milkyway', sys: 'Sol', atmo: false, surf: false, deck: false, pw: { active: true, body: { name: 'Mars' } } }, ['closeWorld']],
  ['already in the Mars sky (stays: fly there + set down)', { gal: 'milkyway', sys: 'Sol', atmo: true, surf: false, deck: false, pw: { active: true, body: { name: 'Mars' } } }, []]
];
for (const [name, st, must] of cases) {
  sb.DM_FAC.arriveAt = null; const log = world(st);
  A.visit('mars-valles'); ok(log.includes('closeQT') && log.some(l => /^dlg:LAND — VALLES RIM FACILITY/.test(l)), name + ': confirm dialog opened');
  st.go(); flush();
  for (const m of must) ok(log.includes(m), name + ': ' + m + ' (' + log.join(',') + ')');
  const en = log.find(l => l.startsWith('enter:'));
  ok(en === 'enter:Mars:mars-valles', name + ': enterAtmosphericFlight(Mars) with arriveAt still set (' + log.join(',') + ')');
  ok(!log.includes('SILENT'), name + ': not the silent other-sky return');
  if (must.length === 0) ok(!log.includes('atmoExit') && !log.includes('closeWorld'), name + ': did not leave its own sky');
}

// ── 2. the facility ──
const H = (x, z) => z < 0 ? 60 : (z > 40 ? 2 : 60 - z * 1.45);   // a cliff: plateau inland (-z), drop to the floor seaward (+z)
const scene = new Obj(); const st = { pos: new V3(), vel: new V3(), yaw: 0, pitch: 0 }; let landed = null;
const PW = { active: true, scene, body: { name: 'Mars' } }, TERRAIN = { H: null };
F.bind({ THREE, PW: () => PW, TERRAIN: () => TERRAIN, atmoState: () => st, atmoXZ: () => ({ x: 0, z: 10 }), mapTag() { }, curSysName: () => 'Sol', skyDay: () => 1, skySunY: () => 1,
  shadows: () => false, isMobile: () => true, tier: () => 1, loadGLB: () => Promise.reject(new Error('n/a')), afterTeleport: (land) => { landed = land; } });
TERRAIN.H = F.wrapH(H);
sb.DM_FAC.arriveAt = 'mars-valles';
for (let i = 0; i < 4000; i++) { fakeNow += 16; F.tick(1 / 60, { x: 0, y: 120, z: 10 }, 'fly'); const r = F.sites.get('mars-valles'); if (r && r.teleported) break; }
const rec = F.sites.get('mars-valles');
ok(rec && rec.ready && !rec.failed, 'facility placed');
ok(rec && rec.teleported && sb.DM_FAC.arriveAt === null, 'arrival consumed');
ok(landed === true, 'arrival is a landing (land=true), not a hover 120 m off');
if (rec) {
  const ct = Math.cos(rec.th), sn = Math.sin(rec.th), loc = (x, z) => { const dx = x - rec.x, dz = z - rec.z; return [dx * ct - dz * sn, dx * sn + dz * ct]; };
  const [lx, lz] = loc(st.pos.x, st.pos.z);
  ok(Math.abs(lx) < 1 && Math.abs(lz - 30) < 1, 'set down over the landing pad (local ' + lx.toFixed(1) + ', ' + lz.toFixed(1) + ')');
  ok(Math.abs(TERRAIN.H(st.pos.x, st.pos.z) - rec.y) < 1e-6, 'the ground under her is the deck top (' + TERRAIN.H(st.pos.x, st.pos.z).toFixed(2) + ' vs ' + rec.y.toFixed(2) + ')');
  ok(st.pos.y > rec.y + 5 && st.pos.y < rec.y + 12, 'starts a few metres above the deck');
  // roof surface
  const W = (lx, lz) => [rec.x + lx * ct + lz * sn, rec.z - lx * sn + lz * ct];
  const rf = W(0, -20); ok(Math.abs(TERRAIN.H(rf[0], rf[1]) - (rec.y + 9)) < 1e-6 || TERRAIN.H(rf[0], rf[1]) > rec.y + 9, 'roof is a standing surface (never inside the block)');
  // materials
  const mv = F._mv.MV; let hull = 0, deck = 0, flat = 0;
  rec.group.traverse(o => { if (!o.isMesh) return; if (o.material === mv.hull) hull++; if (o.material === mv.deck) deck++; if (o.material && o.material.color === 0x1d1613) flat++; });
  ok(hull >= 4 && deck >= 1 && flat === 0, 'PBR hull/deck materials swapped in (hull ' + hull + ', deck ' + deck + ', flat left ' + flat + ')');
  ok(mv.hull.map && mv.hull.normalMap && mv.hull.roughnessMap && mv.deck.map && mv.deck.normalMap, 'albedo + normal + roughness maps');
  // collision bodies: DMCollide's own local transform (lx = c*dx + s*dz, lz = -s*dx + c*dz) must agree with the facility frame
  ok(boxes.length === 6 && rec.colN === 6 && boxes.every(b => b.g === 'facility'), 'six facility bodies (' + boxes.length + ')');
  const inside = (b, x, y, z) => { const c = Math.cos(b.yaw), s = Math.sin(b.yaw), dx = x - b.x, dz = z - b.z, l1 = c * dx + s * dz, l2 = -s * dx + c * dz; return Math.abs(l1) <= b.hx && Math.abs(l2) <= b.hz && Math.abs(y - b.y) <= b.hy; };
  const at = (lx, ly, lz) => { const w = W(lx, lz); return [w[0], rec.y + ly, w[1]]; };
  const hit = (p) => boxes.some(b => inside(b, p[0], p[1], p[2]));
  ok(hit(at(25, 3, -8)) && hit(at(-25, 3, -34)), 'block corners are solid');
  ok(!hit(at(0, 1, 30)) && !hit(at(15, 1, 10)), 'the pad and the deck walkway are open');
  ok(hit(at(-27, 2, 25)) && hit(at(27, 2, 0)), 'glass fins are walls');
  ok(hit(at(19, 20, -30)), 'mast is solid');
  // blade (rotated 0.35 in the facility frame): a point along its rotated long axis is inside, the unrotated corner is not
  const bl = (u, v) => { const c = Math.cos(0.35), s = Math.sin(0.35); return at(-14 + u * c + v * s, 18, -24 - u * s + v * c); };
  const blade = boxes[2]; const p1 = bl(6.5, 7.5), p2 = bl(7.4, -8.6);
  ok(inside(blade, p1[0], p1[1], p1[2]) && !inside(blade, p2[0], p2[1], p2[2]), 'blade body follows its own 0.35 rad rotation');
}
// teardown frees the bodies
PW.active = false; F.tick(1 / 60, { x: 0, y: 0, z: 0 }, 'fly');
ok(cleared >= 1 && boxes.length === 0 && F.sites.size === 0, 'teardown clears the facility bodies');
// no per-frame work: a second placement reuses the cached materials
const mv0 = F._mv.MV; PW.active = true; sb.DM_FAC.arriveAt = 'mars-valles';
for (let i = 0; i < 4000; i++) { fakeNow += 16; F.tick(1 / 60, { x: 0, y: 120, z: 10 }, 'fly'); const r = F.sites.get('mars-valles'); if (r && r.teleported) break; }
ok(F._mv.MV === mv0, 'PBR set is built once and reused on the next visit');
console.log(fails ? 'valles-unit: ' + fails + ' of ' + checks + ' checks FAILED' : 'valles-unit: all ' + checks + ' checks passed');
process.exit(fails ? 1 : 0);
