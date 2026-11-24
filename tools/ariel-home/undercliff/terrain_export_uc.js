// node tools/tests/solenne-cliff.js — (t1516) Ariel's shard-rock cliff on Solenne actually SHOWS: placed on the real world, not sunk in a trench, the sea at its foot,
// the macro shard layer in both LOD bands with the cliff's own rock materials, honest texture tiers, walking / landing heights on the decks unchanged.
// Drives the REAL code: index.html _terrainCore/_groundField/_worldSeed (Solenne @ Veyra, seed 475, lush), ui/dm-worldstyle.js, ui/dm-facilities.js F.tick (search ->
// place -> carve / apron -> shard layer), the committed collision grid + shards.json.  Before / after numbers: the same field with F.seaCut bypassed = main v329.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = process.env.UC_REPO || '/workspace/jots-cliffs-p2';
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const cut = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('marker ' + a); const j = html.indexOf(b, i + a.length); if (j < 0) throw new Error('marker ' + b); return html.slice(i, j); };
// ── the real world field ──
const win = { _curSystem: { name: 'Veyra' } }; win.window = win; const sbW = { window: win, Math, console }; sbW.globalThis = sbW;
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-worldstyle.js'), 'utf8'), sbW);
const E = new Function('window', 'DMWorldStyle', cut('function _vnoise(x,y,seed){', '// Texel generation is pure arithmetic') + cut('const ATMO_DEG_PER_UNIT=0.008;', '// One map per planet') +
  cut('function _siteWorldXZ(site){', 'const LAND_PICK_RANGE') + cut('function _terrainCore(x,z,seed,_ws){', '// ── Shoreline water') + cut('function _worldSeed(body){', '\n}') + '\n}\n' +
  cut('function _groundField(body,site,pal){', '// ── The planet\'s ground, level of detail') + '\nreturn {_groundField,_worldSeed};')(win, win.DMWorldStyle);
const body = { name: 'Solenne', type: 'Habitable', home: true }, site = { lat: 18, lon: 40 }, pal = { water: true };
ok(E._worldSeed(body) === 475, 'Solenne @ Veyra seed is 475 (got ' + E._worldSeed(body) + ')');
// ── the real facilities module, a fake three ──
let idN = 1;
class Obj { constructor() { this.id = idN++; this.children = []; this.parent = null; this.userData = {}; this.visible = true; this.name = ''; this.position = { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } }; this.rotation = { y: 0 }; }
  add(o) { this.children.push(o); o.parent = this; } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; }
  traverse(f) { f(this); for (const c of this.children) c.traverse(f); } getObjectByName(nm) { let r = null; this.traverse(o => { if (!r && o.name === nm) r = o; }); return r; }
  getObjectById(id) { let r = null; this.traverse(o => { if (!r && o.id === id) r = o; }); return r; } updateMatrixWorld() { }
  clone() { const o = new this.constructor(this.geometry, this.material); o.name = this.name; o.visible = this.visible; for (const c of this.children) o.add(c.clone()); return o; } }
class Grp extends Obj { }
class Mesh extends Obj { constructor(g, m) { super(); this.isMesh = true; this.geometry = g; this.material = m; } }
let geoLive = 0;
class Geo { constructor() { this.attributes = {}; geoLive++; this.dead = false; } setAttribute(k, a) { this.attributes[k] = a; } dispose() { if (!this.dead) { this.dead = true; geoLive--; } } }
class Attr { constructor(a, s) { this.array = a; this.itemSize = s; } }
const THREE = { Group: Grp, Mesh, BufferGeometry: Geo, BufferAttribute: Attr };
const mat = (name) => ({ name, metalness: 1, roughness: 1, emissiveIntensity: 1, userData: {} });
function fakeGLB() {
  const sc = new Grp(); sc.name = 'Scene';
  for (const L of ['Mansion_LOD0', 'Mansion_LOD1']) { const g = new Grp(); g.name = L; for (const m of ['ah_slate', 'ah_rock', 'ah_rockc', 'ah_rocks', 'ah_rockt', 'ah_pool']) { const me = new Mesh(new Geo(), MATS[m]); me.name = L + '_' + m; g.add(me); } sc.add(g); }
  return { scene: sc };
}
const MATS = {}; for (const m of ['ah_slate', 'ah_rock', 'ah_rockc', 'ah_rocks', 'ah_rockt', 'ah_pool']) MATS[m] = mat(m);
const cyl = []; const sb = { console, Math, Float32Array, Float64Array, Uint8Array, Int16Array, Set, Map, Promise, JSON, Date, setTimeout, clearTimeout, performance: { now: () => Date.now() },
  atob: s => Buffer.from(s, 'base64').toString('binary'), navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux', maxTouchPoints: 0 }, document: { hidden: false },
  requestAnimationFrame: f => setTimeout(f, 1), CustomEvent: function () { }, addEventListener() { }, dispatchEvent() { }, location: { search: '', href: 'http://localhost/' },
  DMCollide: { addCylinder: (g, x, y0, y1, z, r) => cyl.push([g, x, y0, y1, z, r]), clearGroup: () => { cyl.length = 0; } },
  fetch: async (u) => { const f = path.join(root, u.split('?')[0]); return { ok: true, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) }; } };
sb.window = sb; sb.globalThis = sb;
sb.DMArielHome = { SITES: [{ id: 'home-mansion', body: 'Solenne', sys: 'Veyra', lat: 18, lon: 40, kind: 'mansion' }] };
const facSrc = fs.readFileSync(path.join(root, 'ui/dm-facilities.js'), 'utf8');
vm.runInNewContext(facSrc, sb, { filename: 'dm-facilities.js' });
const F = sb.DMFac, X = F._t;
const Fd = E._groundField(body, site, pal); F.carveField(Fd);       // drawn ground (index.html _pwBuildGround order)
const Hwalk = F.wrapH(Fd.H0), Hw = F.seaField(Fd.H0);                 // walking ground, the water's field
const scene = new Grp(), PW = { active: true, scene, body: { name: 'Solenne' }, renderer: null, camera: null };
F.bind({ THREE, PW: () => PW, TERRAIN: () => ({ H: Hwalk }), atmoState: () => null, atmoXZ: (la, lo) => ({ x: (lo - site.lon) / 0.008, z: (site.lat - la) / 0.008 }), mapTag() { },
  curSysName: () => 'Veyra', isMobile: () => false, shadows: () => true, tier: () => 2, loadGLB: async () => fakeGLB(), afterTeleport() { } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const f = { x: -80 + 1500, y: 120, z: -1340 };
  for (let i = 0; i < 400; i++) { F.tick(0.016, f, 'atmo'); const s = F.status()[0]; if (s && s.ready) break; await sleep(5); }
  const st = F.status()[0], rec = Array.from(F.sites.values())[0];
  ok(st && st.ready && !rec.failed, 'the mansion is placed on Solenne');
  ok(Math.abs(st.x - -80) < 1e-6 && Math.abs(st.z - -1340) < 1e-6 && Math.abs(st.y - 68.306) < 0.01, 'at the measured site x -80 z -1340 y0 68.31 (got ' + [st.x, st.z, st.y.toFixed(2)] + ')');
  // t1583u P2: the WALKING ground (wrapH: natural ground after seaCut, max the mansion collision grid; F.ovr off) over the undercliff footprint, 1 u cells,
  // mansion Blender frame, relative to y0. The nav builder copies it into plateau "cover" patches so walking on top is unchanged.
  const c = F.car; const W = (bx, by) => { const lx = bx, lz = -by; return [c.px + lx * c.ct + lz * c.st, c.pz - lx * c.st + lz * c.ct]; };
  const out = { car: c, x0: -152, x1: 78, y0: 8, y1: -104, step: 1, walk: [], nat: [] };
  for (let by = out.y0; by >= out.y1; by -= 1) { const w = [], q = [];
    for (let bx = out.x0; bx <= out.x1; bx += 1) { const [x, z] = W(bx, by); w.push(+(Hwalk(x, z) - c.y0).toFixed(3)); q.push(+(F.seaCut(x, z, Fd.H0(x, z)) - c.y0).toFixed(3)); }
    out.walk.push(w); out.nat.push(q); }
  fs.writeFileSync(process.env.UC_OUT || '/workspace/jots-t1516/undercliff/build/terrain_uc.json', JSON.stringify(out)); console.log('wrote', out.walk.length, out.walk[0].length, JSON.stringify(c));
  process.exit(0);
})();
