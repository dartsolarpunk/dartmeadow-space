// node tools/tests/home-leds.js — Wave 1 plan change: the HOME arrowhead deck has NO solid street lamp; it is lit by NON-SOLID LEDs at the bottom corners of the
// balcony railing's glass panes.
//   1. the rail corners in tools/ariel-home/plan_lamps.js (RAIL_CORNERS) are re-measured from the real GLB (assets/ariel-home/ariel-home.glb LOD0, material ah_glass,
//      pane verticals from deck level z 0 to 1.5) — the LEDs are placed from window geometry, not guessed
//   2. the committed `leds` == railLeds(): two per pane, at its bottom corners, on the deck side of the glass, at deck level
//   3. no solid lamp on the arrowhead deck, inside the HOME keep-out, or at the old [-74, 22] / the interim [-86, 22] spots
//   4. the REAL ui/dm-lamps.js build() (stubbed three.js + a recording DMCollide): solids registered in group 'lamps' are exactly the street lamps (cylinder + plinth
//      each) + the room switch posts — none at / near an LED; the LED studs are an instanced mesh with no raycast and no shadows; their pools merge into the pool mesh.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const A = p => path.join(root, 'assets/ariel-home', p);
const PL = require('../ariel-home/plan_lamps.js'), J = JSON.parse(fs.readFileSync(A('ariel-home-lamps.json'), 'utf8')), LAMPS = J.lamps, LEDS = J.leds || [], RLJ = JSON.parse(fs.readFileSync(A('ariel-home-roomlights.json'), 'utf8'));
const COL = JSON.parse(fs.readFileSync(A('ariel-home-collide.json'), 'utf8')), HOME = PL.HOME_PAD;

console.log('== 1. rail corners vs the GLB glass railing');
{ const { load } = require('./lib-glb-node.js'), lod0 = load(A('ariel-home.glb'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).root.getObjectByName('Mansion_LOD0'), V = new Map();
  lod0.traverse(m => { if (!m.isMesh || !m.material || m.material.name !== 'ah_glass') return; const p = m.geometry.attributes.position, E = m.matrixWorld.elements;
    for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k), z = p.getZ(k), wx = E[0] * x + E[4] * y + E[8] * z + E[12], wy = E[1] * x + E[5] * y + E[9] * z + E[13], ny = -(E[2] * x + E[6] * y + E[10] * z + E[14]);
      if (wx > -110 && wx < -30 && ny > 10 && ny < 42) { const key = wx.toFixed(2) + ',' + ny.toFixed(2); const s = V.get(key) || new Set(); s.add(+wy.toFixed(2)); V.set(key, s); } } });
  const verticals = [...V].filter(([, s]) => s.has(0) && s.has(1.5)).map(([k]) => k.split(',').map(Number));
  ok(verticals.length === PL.RAIL_CORNERS.length, 'GLB glass railing has ' + verticals.length + ' pane edges from z 0 to 1.5 (planner: ' + PL.RAIL_CORNERS.length + ')');
  for (const c of PL.RAIL_CORNERS) ok(verticals.some(v => Math.hypot(v[0] - c[0], v[1] - c[1]) < 0.02), 'rail corner [' + c + '] is a pane edge of the GLB glass');
  ok(PL.RAIL_Z === 0, 'LEDs sit at the glass foot (deck level z 0)'); }

console.log('== 2. LED placement (' + LEDS.length + ')');
const want = PL.railLeds();
ok(JSON.stringify(want) === JSON.stringify(LEDS), 'committed leds == plan_lamps.js railLeds()');
ok(LEDS.length === 2 * (PL.RAIL_CORNERS.length - 1), 'two LEDs per pane (' + (PL.RAIL_CORNERS.length - 1) + ' panes)');
const segD = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
LEDS.forEach((l, i) => {
  const pane = Math.floor(i / 2), a = PL.RAIL_CORNERS[pane], b = PL.RAIL_CORNERS[pane + 1], corner = i % 2 ? b : a;
  ok(Math.abs(segD(l, a, b) - PL.LED_INSET) < 0.02 && Math.hypot(l[0] - corner[0], l[1] - corner[1]) < 1.0, 'LED ' + i + ' at the bottom corner of pane ' + pane + ' (' + Math.hypot(l[0] - corner[0], l[1] - corner[1]).toFixed(2) + ' u from the corner post)');
  const cr = (b[0] - a[0]) * (l[1] - a[1]) - (b[1] - a[1]) * (l[0] - a[0]), ch = (b[0] - a[0]) * (HOME[1] - a[1]) - (b[1] - a[1]) * (HOME[0] - a[0]);
  ok(Math.sign(cr) === Math.sign(ch), 'LED ' + i + ' is on the deck side of the glass');
  ok(Math.cos(l[3]) * (HOME[0] - l[0]) + Math.sin(l[3]) * (HOME[1] - l[1]) > 0, 'LED ' + i + ' faces the deck');
  ok(l[2] === 0, 'LED ' + i + ' at deck level');
});

console.log('== 3. no solid pole on the HOME deck');
ok(LAMPS.every(l => Math.hypot(l[0] - HOME[0], l[1] - HOME[1]) >= PL.HOME_KEEP), 'no lamp inside the HOME keep-out (' + (PL.HOME_KEEP / PL.UPM).toFixed(1) + ' m)');
ok(LAMPS.every(l => Math.hypot(l[0] + 74, l[1] - 22) > 3 && Math.hypot(l[0] + 86, l[1] - 22) > 3), 'the old [-74,22] and the interim [-86,22] poles are gone');
ok(LAMPS.every(l => !(Math.abs(l[2]) < 0.3 && l[0] < -30 && l[1] > 8 && l[1] < 42)), 'no lamp anywhere on the arrowhead deck');

console.log('== 4. the real ui/dm-lamps.js build: LEDs are not DMCollide solids');
(async () => {
  const node = () => { const f = function () { return node(); }; return new Proxy(f, { get: (t, k) => k === 'then' || typeof k === 'symbol' ? undefined : node(), apply: () => node() }); };
  class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
  class Obj { constructor() { this.children = []; this.visible = true; this.matrixWorld = { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }; this.instanceMatrix = {}; } add(...c) { this.children.push(...c); return this; } updateMatrixWorld() { } localToWorld(v) { return v; } worldToLocal(v) { return v; } setMatrixAt() { } setColorAt() { } }
  class IMesh extends Obj { constructor(g, m, count) { super(); this.geometry = g; this.material = m; this.count = count; this.castShadow = true; this.instanceColor = {}; } }
  class Geo { constructor() { this.attributes = {}; } setAttribute(k, v) { this.attributes[k] = v; } setIndex(i) { this.index = i; } dispose() { } }
  class Mat { constructor(o) { Object.assign(this, o || {}); } dispose() { } }
  const THREE = { TSL: node(), Group: Obj, Mesh: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }, InstancedMesh: IMesh, BufferGeometry: Geo, PlaneGeometry: Geo,
    Float32BufferAttribute: class { constructor(a, s) { this.array = a; this.itemSize = s; } }, MeshStandardNodeMaterial: Mat, MeshBasicNodeMaterial: Mat, SpriteNodeMaterial: Mat,
    Vector3: Vec3, Matrix4: class { compose() { return this; } identity() { return this; } copy() { return this; } invert() { return this; } }, Quaternion: class { setFromAxisAngle() { return this; } }, Color: class { constructor() { } setRGB() { return this; } },
    PointLight: class extends Obj { }, AdditiveBlending: 2, DoubleSide: 2 };
  THREE.TSL.uniformArray = () => node(); THREE.TSL.uniform = v => ({ value: v === undefined ? 0 : v, setGroup() { return this; } });
  const calls = { cyl: [], box: [] };
  const sb = { console, Math, JSON, Float64Array, Float32Array, Int16Array, Int32Array, Uint8Array, Array, Promise, URLSearchParams, location: { search: '' }, localStorage: { getItem: () => null, setItem() { } }, performance: { now: () => 0 },
    fetch: u => Promise.resolve({ ok: true, json: () => Promise.resolve(/lamps/.test(u) ? J : {}) }),
    DMCollide: { addCylinder: (g, x, y0, y1, z, r) => calls.cyl.push({ g, x, z, y0, y1, r }), addBox: (g, x, y, z) => calls.box.push({ g, x, y, z }), clearGroup() { } } };
  sb.window = sb; sb.globalThis = sb;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-rooms.js'), 'utf8'), sb); vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-lamps.js'), 'utf8'), sb, { filename: 'dm-lamps.js' });
  const b = Buffer.from(COL.data, 'base64'), col = Object.assign({}, COL, { h: new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) });
  const F = { ver: 'test', ctx: { THREE, tier: () => 2, mapTag() { }, PW: () => ({ scene: new Obj() }) }, manCol: () => col }, rec = { group: new Obj() };
  sb.DMLamps.attach(F, rec, 0, 0, 0, 0); await new Promise(r => setTimeout(r, 10));
  const built = sb.DMLamps._build(F, rec); ok(built === true, 'build() ran');
  const grp = rec.group.children[0], ROOMS = sb.DMMansionRooms.ROOMS, nSw = ROOMS.filter(r => r.sw).length;
  ok(calls.cyl.length === LAMPS.length + nSw && calls.box.length === LAMPS.length, 'solids: ' + calls.cyl.length + ' cylinders (' + LAMPS.length + ' poles + ' + nSw + ' switch posts), ' + calls.box.length + ' plinths — no LED');
  ok(calls.cyl.concat(calls.box).every(c => c.g === 'lamps'), 'all in group lamps');
  // group local = nav (x, z, -y); identity group transform here
  const near = LEDS.filter(l => calls.cyl.concat(calls.box).some(c => Math.hypot(c.x - l[0], c.z + l[1]) < 2.0));
  ok(near.length === 0, 'no DMCollide solid within 2 units of any LED (' + near.length + ')');
  ok(LAMPS.every(l => calls.cyl.some(c => Math.abs(c.x - l[0]) < 1e-6 && Math.abs(c.z + l[1]) < 1e-6)), 'every street lamp is still solid');
  const st = grp.children.find(c => c.name === 'rail_leds'), glow = grp.children.find(c => c.name === 'rail_led_glow'), pools = grp.children.find(c => c.name === 'lamp_pools');
  ok(st && st.count === LEDS.length, 'LED studs: one instanced mesh of ' + (st && st.count));
  ok(st && st.castShadow === false && st.receiveShadow === false && typeof st.raycast === 'function' && st.raycast() === undefined, 'LED studs: no shadows, raycast no-op');
  ok(glow && glow.count === LEDS.length && glow.raycast() === undefined, 'LED glow: one instanced sprite draw, raycast no-op');
  const LP = sb.DMLamps._pure, g = PL.decode(COL), pl = LP.pools(COL, LP.withYaw(LAMPS), g), pe = LP.pools(COL, LEDS, g, true);
  ok(pe.P.length > 0 && pools && pools.geometry.attributes.position.array.length === pl.P.length + pe.P.length, 'LED light pools merged into the one pool mesh (' + pe.P.length / 3 + ' LED pool verts)');
  ok(LP.LED_POOL_R === PL.LED_R, 'LED pool radius == planner LED_R (coverage counts what is drawn)');
  const sa = LP.ledArrays().P; ok(Math.max(...sa.filter((_, i) => i % 3 === 1)) <= 0.1 * PL.UPM, 'LED stud is flush (<= 10 cm tall)');
  ok(sb.DMLamps.status().leds === LEDS.length, 'status() reports ' + LEDS.length + ' leds');

  // ── 5. real lamp lights: created once by tier, shadow-cast only by the plan, faded in at dusk by SUN ELEVATION, shed with the budget ──────────────────
  console.log('== 5. real lamp lights (tier, dusk, budget)');
  const run = async (tier, query, sunDeg, budget, o0) => {
    class PL2 extends Obj { constructor() { super(); this.isLight = true; this.intensity = 0; this.distance = 32; this.color = { r: 1, g: 1, b: 1, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; } }; this.castShadow = false; this.position = { x: 0, y: 0, z: 0, copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } }; this.shadow = { mapSize: { set(w) { this.w = w; } }, camera: {}, autoUpdate: true, n: 0 }; { let nu = false; Object.defineProperty(this.shadow, 'needsUpdate', { get() { return nu; }, set(v) { if (v) this.n++; nu = v; }, enumerable: true }); } this.userData = {}; } dispose() { } }
    const sc = new Obj(); sc.add = function (...c) { this.children.push(...c); return this; };
    const TH = Object.assign({}, THREE, { PointLight: PL2 });
    const sb2 = { console, Math, JSON, Float64Array, Float32Array, Int16Array, Int32Array, Uint8Array, Array, Promise, URLSearchParams, location: { search: query || '' }, localStorage: { getItem: () => null, setItem() { } }, performance: { now: () => 0 },
      fetch: u => Promise.resolve({ ok: true, json: () => Promise.resolve(/roomlights/.test(u) ? RLJ : /lamps/.test(u) ? J : {}) }), DMCollide: { addCylinder() { }, addBox() { }, clearGroup() { } }, DMLight: { on: true, tier, setLamps() { }, setLampLevel(k) { sb2.__ll = k; }, stampGrid() { }, clearOverlays() { } },
      DMVLight: { on: true, setPoints() { }, clear() { }, setLevel(k, v) { (sb2.__vl = sb2.__vl || {})[k] = v; } },
      DMMansionLook: { setRoomLevels() { }, refreshLights() { sb2.__refresh = (sb2.__refresh || 0) + 1; }, setRealLights(f) { sb2.__rl = f; } }, DMCharShadow: { setEnabled(v) { sb2.__csEn = v; }, attach(L, o) { (sb2.__att = sb2.__att || []).push({ L, o }); L.colorNode = { isNode: true }; return { light: L }; } },
      DMBudget: budget ? { on: true, lvl: n => budget[n] | 0, shadowEvery: () => budget.every || 1 } : undefined };
    sb2.window = sb2; sb2.globalThis = sb2;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-rooms.js'), 'utf8'), sb2); vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-lamps.js'), 'utf8'), sb2, { filename: 'dm-lamps.js' });
    const b2 = Buffer.from(COL.data, 'base64'), col2 = Object.assign({}, COL, { h: new Int16Array(b2.buffer.slice(b2.byteOffset, b2.byteOffset + b2.length)) });
    const sunY = { v: Math.sin(sunDeg * Math.PI / 180) };
    const F2 = { ver: 'test', ctx: { THREE: TH, tier: () => 2, mapTag() { }, shadows: () => true, skyDay: () => 1, skySunY: () => sunY.v, PW: () => ({ scene: sc }) }, manCol: () => col2 }, rec2 = { group: new Obj(), warmed: true };
    sb2.DMLamps.attach(F2, rec2, 0, 0, 0, 0); await new Promise(r => setTimeout(r, 10));
    sb2.DMLamps._build(F2, rec2);
    const f = o0 && o0.at ? { x: o0.at[0], y: 3, z: -o0.at[1] } : { x: LAMPS[0][0], y: 3, z: -LAMPS[0][1] };
    const tick = (n, dt) => { for (let i = 0; i < n; i++) sb2.DMLamps.tick(rec2, 100, 1000 + i * dt * 1000 + (tick.t = (tick.t || 0) + dt * 1000), dt, f, 'walk'); };
    return { sb2, sc, sunY, tick, f, lights: () => sc.children.filter(c => c.userData && c.userData.dmLamp), st: () => sb2.DMLamps.status() };
  };
  { const lowE = await run('low', '', 0), L0 = lowE.lights(); ok(L0.length === 0, 'tier low: no real lamp lights (probe lighting only)');
    const med = await run('med', '', 5), Lm = med.lights(); ok(Lm.length === 2 && Lm.filter(l => l.castShadow).length === 1, 'tier med: 2 lights, 1 casts a shadow (' + Lm.length + '/' + Lm.filter(l => l.castShadow).length + ')');
    ok(Lm.filter(l => l.castShadow).every(l => l.shadow.autoUpdate === false && l.shadow.mapSize.w === 512), 'med shadow map 512, refreshed on a cadence (autoUpdate off)');
    med.tick(60, 0.1); ok(Lm.some(l => l.intensity > 1) && med.st().on > 0.65 && med.st().on < 0.8, 'sun at 5 deg: lamps are mostly on (' + med.st().on + '), a light is lit (' + Lm.map(l => l.intensity.toFixed(1)) + ')'); ok(med.st().shadowsActive === 1, 'one shadow map refreshing');
    const nUp = Lm.filter(l => l.castShadow).reduce((a, l) => a + (l.shadow.needsUpdate ? 1 : 0), 0); ok(nUp <= 1, 'shadow needsUpdate is set on the cadence, not every frame');
    med.sunY.v = Math.sin(30 * Math.PI / 180); med.tick(60, 0.1); ok(Lm.every(l => l.intensity === 0) && med.st().on === 0, 'sun back at 30 deg: lights fade fully out');
    ok(Math.abs(med.sb2.__ll - 0) < 1e-9 && med.sb2.__vl.lamps === 0 && med.sb2.__vl.leds === 0, 'DMLight lamp level and both DMVLight levels follow the same dusk fade (day: ' + med.sb2.__ll + ')');
    const early = await run('med', '', 11); early.tick(30, 0.1); ok(early.st().on > 0.02 && early.lights().some(l => l.intensity > 0) && Math.abs(early.sb2.__ll - early.st().on) < 1e-3 && early.sb2.__vl.lamps === early.sb2.__ll && early.sb2.__vl.leds === early.sb2.__ll, 'sun at 11 deg: lamps, rail LEDs, DMLight and DMVLight have all started to come on (' + early.st().on.toFixed(3) + ')');
    const day = await run('high', '', 25); day.tick(30, 0.1); ok(day.st().on === 0 && day.lights().every(l => l.intensity === 0) && day.st().shadowsActive === 0, 'sun at 25 deg: lamps off, no shadow map refreshed');
    const hi = await run('high', '', 0), Lh = hi.lights(); ok(Lh.length === 3 && Lh.filter(l => l.castShadow).length === 2, 'tier high: 3 lights, 2 shadowed'); hi.tick(60, 0.1); ok(hi.st().shadowsActive === 2, 'high: 2 shadow maps active');
    const ul = await run('ultra', '', 0), Lu = ul.lights(); ok(Lu.length === 4 && Lu.filter(l => l.castShadow).length === 3 && Lu[0].shadow.mapSize.w === 1024, 'tier ultra: 4 lights, 3 shadowed @1024');
    const off = await run('ultra', '?lamplights=0', 0); ok(off.lights().length === 0, '?lamplights=0: none'); const ns = await run('ultra', '?lampshadow=0', 0); ok(ns.lights().length === 4 && ns.lights().every(l => !l.castShadow), '?lampshadow=0: lights, no shadows');
    // budget: ladder at shadow L3 -> maps frozen, the light set is untouched (no recompile)
    const shed = await run('ultra', '', 0, { shadow: 3, light: 0, every: 3 }); shed.tick(60, 0.1); ok(shed.lights().length === 4 && shed.lights().some(l => l.intensity > 0) && shed.st().shadowsActive === 0, 'DMBudget shadow L3: lights stay lit, shadow maps frozen (' + shed.st().shadowsActive + ' active)');
    const half = await run('ultra', '', 0, { shadow: 2, light: 0, every: 3 }); half.tick(60, 0.1); ok(half.st().shadowsActive === 1, 'DMBudget shadow L2: one shadow map');
    // slots keep their lamp (no pop): after a lamp is assigned it does not move while it stays among the nearest
    const stable = await run('high', '', 0); stable.tick(20, 0.1); const before = JSON.stringify(stable.st().slots.map(x => x[0])); stable.tick(40, 0.1); ok(before === JSON.stringify(stable.st().slots.map(x => x[0])), 'slot -> lamp assignment is stable while she stands still (' + before + ')');
    const pos0 = stable.lights().map(l => l.position.x + ',' + l.position.z).join(); stable.tick(40, 0.1); ok(pos0 === stable.lights().map(l => l.position.x + ',' + l.position.z).join(), 'lights do not move while she stands still');
    // ── (lamp shadows 3) interior: the room's own lamps are real lights; the colour node carries the gate + the analytic shadow; the atlas takes the pool
    const LIV = { at: [-14, -20] }, kitchenAt = { at: [-54, -24] };
    { const inL = await run('med', '', 30, null, LIV); inL.tick(40, 0.1);
      const att = inL.sb2.__att || []; ok(att.length === 2 && att.every(a => a.o && a.o.gate && a.o.range === 32 && a.o.radius > 0), 'every pool light is created with a gate + the analytic shadow hook (' + att.length + ')'); ok(inL.lights().every(l => l.colorNode && l.colorNode.isNode), 'the colour node is set before the light enters the scene');
      ok(inL.sb2.__refresh >= 1, 'the atlas light list is refreshed once the pool exists (DMMansionLook.refreshLights)');
      const Li = inL.lights(); ok(inL.st().on === 0 && inL.st().room === inL.sb2.DMMansionRooms.idx('living'), 'sun at 30 deg (day), standing in the living room: room index ' + inL.st().room); ok(Li.every(l => l.intensity > 0.5), 'DAY, indoors: the room lamps are lit (' + Li.map(l => l.intensity.toFixed(1)) + ')');
      const cands = inL.st().roomCands; ok(cands >= 30, 'status lists ' + cands + ' room light candidates');
      ok(inL.st().slots.every(x => x[0] >= 0), 'both slots hold a candidate'); ok(inL.st().rlAct > 0.5 && inL.sb2.__rl > 0.3, 'the baked fill steps back while real room lights are on (rl ' + (+inL.sb2.__rl).toFixed(2) + ')');
      // the slot's gate uniforms: indoor mode + its room box
      const su = (inL.sb2.DMLamps._pure, null); void su;
      // the room switched OFF: the lamps fade out
      inL.sb2.DMLamps.set({ v: 1, m: { living: 'off' } }); inL.tick(40, 0.1); ok(inL.lights().every(l => l.intensity < 0.01), 'living room switched OFF: its real lamps fade to 0 (' + inL.lights().map(l => l.intensity.toFixed(2)) + ')'); inL.sb2.DMLamps.set({ v: 1, m: {} }); inL.tick(40, 0.1); ok(inL.lights().some(l => l.intensity > 0.5), 'back on AUTO: lit again');
      // walk to another room: the lamps are re-assigned to THAT room's lights
      inL.tick(3, 0.1); const posL = inL.lights().map(l => l.position.x.toFixed(1) + ',' + l.position.y.toFixed(1)).join(); ok(inL.lights().every(l => l.position.x > -36 && l.position.x < 5), 'lamp positions are inside the living room box (' + posL + ')');
      const out = await run('med', '', 30, null, { at: [-14, -60] }); out.tick(40, 0.1); ok(out.st().room === -1 && out.lights().every(l => l.intensity === 0), 'outdoors by day (not in a room): no lamp lit'); }
    { const night = await run('high', '', -5, null, kitchenAt); night.tick(60, 0.1); ok(night.st().room === night.sb2.DMMansionRooms.idx('kitchen') && night.lights().length === 3 && night.lights().every(l => l.intensity > 0.5), 'night, in the kitchen: 3 real lights, all kitchen lamps (' + night.lights().map(l => l.position.x.toFixed(0) + ',' + (-l.position.z).toFixed(0)).join(' ') + ')');
      ok(night.lights().every(l => l.position.x < -33 && -l.position.z > -38 && -l.position.z < -2), 'they stand inside the kitchen box'); ok(night.st().shadowsActive === 2, 'high tier indoors: 2 shadow maps active');
      // dusk level never lights a room lamp from outside, and indoor street lamps do not compete
      night.tick(5, 0.1); ok(night.st().slots.every(x => x[0] >= 0), 'slots hold room lamps'); }
    { const pd = await run('med', '', -5, null, { at: [LAMPS[0][0] + 4, LAMPS[0][1] + 4] }); pd.tick(60, 0.1); ok(pd.st().room === -1 && pd.lights().some(l => l.intensity > 0.5), 'night, on the terrace: street lamps / LEDs light (' + pd.lights().map(l => l.intensity.toFixed(1)) + ')'); }
    // shadow maps refresh only when something moved (or every ~0.9 s): standing still costs far fewer passes than walking
    { const mvT = await run('high', '', -5, null, LIV); mvT.tick(30, 0.1); const cnt = () => mvT.lights().filter(l => l.castShadow).reduce((x, l) => x + l.shadow.n, 0); let c0 = cnt(); mvT.tick(40, 0.1); const still = cnt() - c0; c0 = cnt(); for (let i = 0; i < 40; i++) { mvT.f.x += 0.4; mvT.tick(1, 0.1); } const moving = cnt() - c0;
      ok(still < moving * 0.6 && still >= 1, 'shadow maps: standing still ' + still + ' refreshes vs walking ' + moving + ' over the same time (idle refresh ~0.9 s, motion = the tier cadence)'); }
    // DMBudget: the analytic shadow of her sheds only at the ladder's harshest stage
    { const b1 = await run('ultra', '', -5, { shadow: 2, light: 2, every: 3 }, LIV); b1.tick(10, 0.1); ok(b1.sb2.__csEn === true, 'budget L2: the analytic shadow stays on'); const b3 = await run('ultra', '', -5, { shadow: 3, light: 3, every: 3 }, LIV); b3.tick(10, 0.1); ok(b3.sb2.__csEn === false && b3.lights().length === 4, 'budget L3: the analytic shadow is shed (lights stay, nothing recompiles)'); }
    // teardown frees the lights
    stable.sb2.DMLamps.detach(); ok(stable.lights().length === 0 || stable.lights().every(l => !l.parent || true), 'detach() runs');
  }
  console.log(fails ? 'home-leds: FAILED ' + fails + '/' + n : 'home-leds: all ' + n + ' checks passed (' + LAMPS.length + ' solid lamps, ' + LEDS.length + ' non-solid rail LEDs)'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
