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
const PL = require('../ariel-home/plan_lamps.js'), J = JSON.parse(fs.readFileSync(A('ariel-home-lamps.json'), 'utf8')), LAMPS = J.lamps, LEDS = J.leds || [];
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
    Vector3: Vec3, Matrix4: class { compose() { return this; } identity() { return this; } }, Quaternion: class { setFromAxisAngle() { return this; } }, Color: class { constructor() { } setRGB() { return this; } },
    PointLight: class extends Obj { }, AdditiveBlending: 2, DoubleSide: 2 };
  THREE.TSL.uniformArray = () => node(); THREE.TSL.uniform = () => ({ value: 0 });
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
  console.log(fails ? 'home-leds: FAILED ' + fails + '/' + n : 'home-leds: all ' + n + ' checks passed (' + LAMPS.length + ' solid lamps, ' + LEDS.length + ' non-solid rail LEDs)'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
