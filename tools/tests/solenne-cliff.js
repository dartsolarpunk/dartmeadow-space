// node tools/tests/solenne-cliff.js — (t1516) Ariel's shard-rock cliff on Solenne actually SHOWS: placed on the real world, not sunk in a trench, the sea at its foot,
// the macro shard layer in both LOD bands with the cliff's own rock materials, honest texture tiers, walking / landing heights on the decks unchanged.
// Drives the REAL code: index.html _terrainCore/_groundField/_worldSeed (Solenne @ Veyra, seed 475, lush), ui/dm-worldstyle.js, ui/dm-facilities.js F.tick (search ->
// place -> carve / apron -> shard layer), the committed collision grid + shards.json.  Before / after numbers: the same field with F.seaCut bypassed = main v329.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
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
  const g = rec.group, u = g.userData; let inScene = g.parent === scene;
  ok(inScene && g.visible, 'the mansion root is in the world scene and visible');
  // ── materials: rock, not crystal ──
  for (const m of ['ah_rock', 'ah_rockc', 'ah_rocks', 'ah_rockt']) ok(MATS[m].metalness === 0 && MATS[m].emissiveIntensity === 0, m + ': metalness 0, no emissive (dielectric weathered rock)');
  // ── the shard layer ──
  const J = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/cliff/shards.json'), 'utf8'));
  for (const L of ['lod0', 'lod1']) {
    const sh = u[L].children.filter(c => c.userData.dmShards);
    ok(sh.length === 2, L + ': 2 shard meshes (columnar + talus) under Mansion_' + L.toUpperCase());
    ok(sh.every(c => c.material === MATS[c.name.replace('Mansion_Shards_', '')]), L + ': the shard meshes share the GLB\'s own ah_rockc / ah_rockt materials (the 1K/2K + parallax upgrades reach them)');
  }
  ok(u.shardTris > 2500 && u.shardTris <= 4500, 'shard layer budget ' + u.shardTris + ' triangles (2.5k..4.5k)');
  ok(u.lod0.children.filter(c => c.userData.dmShards)[0].geometry === u.lod1.children.filter(c => c.userData.dmShards)[0].geometry, 'LOD0 and LOD1 share one shard geometry (no extra memory)');
  let bad = 0, unit = 0, maxTop = -1e9;
  for (const gm of rec.shardGeos) { const P = gm.attributes.position.array, N = gm.attributes.normal.array; for (let i = 0; i < P.length; i++) if (!isFinite(P[i])) bad++; for (let i = 0; i < N.length; i += 3) if (Math.abs(Math.hypot(N[i], N[i + 1], N[i + 2]) - 1) > 1e-4) unit++; }
  for (const q of J.shards) if (!q[14]) maxTop = Math.max(maxTop, q[2] + q[3]);
  ok(bad === 0 && unit === 0, 'every shard vertex finite, every facet normal unit (flat-shaded planes)');
  ok(maxTop <= -4, 'every sea / face shard top stays >= 4 u under the plateau (max ' + maxTop.toFixed(1) + '): nothing on a deck or the HOME pad');
  ok(cyl.length > 60, cyl.length + ' shard colliders registered (group facility)');
  // the shard flat normals face outward (a facet's normal points away from its prism axis)
  // ── the sea at the cliff foot (before: main v329 = seaCut bypassed) ──
  const c = F.car, W = (bx, by) => [c.px + bx * c.ct - by * c.st, c.pz - bx * c.st - by * c.ct];
  const real = F.seaCut; const drawnMain = (x, z) => F.carve(x, z, Fd.H0(x, z));
  const ED = []; for (let bx = -180; bx <= 180; bx += 20) ED.push(bx);
  let bankMain = -1e9, bankNow = -1e9, dryMain = 0, dryNow = 0, cells = 0, inv = 0;
  for (const bx of ED) for (let by = 123; by <= 121 + 170 * 0.4; by += 6) {
    const [x, z] = W(bx, by); cells++;
    bankMain = Math.max(bankMain, drawnMain(x, z) - c.y0); bankNow = Math.max(bankNow, Fd.H(x, z) - c.y0);
    if (Fd.H0(x, z) >= 0) dryMain++; if (Hw(x, z) >= 0) dryNow++;
    if (Math.abs(Hwalk(x, z) - Fd.H(x, z)) > 1e-6) inv++;
  }
  console.log('  apron (box edge .. +68 u, |bx| <= 180): ground max rel. plateau main ' + bankMain.toFixed(1) + ' -> now ' + bankNow.toFixed(1) + ' u; dry water-field cells main ' + dryMain + '/' + cells + ' -> now ' + dryNow + '/' + cells);
  ok(bankMain > -50, 'main v329 had a bank in front of the face (ground ' + bankMain.toFixed(1) + ' u rel. plateau, the GLB sea floor is ~-74)');
  ok(bankNow <= -60, 'now the ground in front of the face holds at the GLB sea floor (max ' + bankNow.toFixed(1) + ' u rel. plateau)');
  ok(dryNow === 0, 'the water field (TERRAIN.Hw) is sea over the whole apron hold (' + dryNow + ' dry cells)');
  ok(inv === 0, 'walking ground == drawn ground in the apron (no invisible floor; ' + inv + ' mismatches)');
  // inside the box: the GLB's sea cells are sea for the water and the walk
  const col = X.MAN.col; let seaCells = 0, seaWet = 0, walkOK = 0;
  for (let j = 0; j < col.ny; j += 3) for (let i = 0; i < col.nx; i += 3) { const v = col.h[j * col.nx + i] / col.scale, bx = col.x0 + i * col.cell, by = col.y0 + j * col.cell; if (v > col.sea + 0.6 || Math.abs(bx) > 190 || by < -115) continue;
    const [x, z] = W(bx, by); seaCells++; if (Hw(x, z) <= c.y0 + v + 1e-6) seaWet++; if (Math.abs(Hwalk(x, z) - (Math.min(Fd.H0(x, z), c.y0 + v))) < 1e-6) walkOK++; }
  ok(seaCells > 200 && seaWet === seaCells, 'every GLB sea cell reads as the GLB sea floor in the water field (' + seaWet + '/' + seaCells + ')');
  ok(walkOK === seaCells, 'walking over a GLB sea cell = its sea floor (no natural ground 20-40 u over it) (' + walkOK + '/' + seaCells + ')');
  // decks unchanged: every non-sea cell of the collision grid walks exactly as main (max(natural, grid))
  let deckSame = 0, deckN = 0;
  for (let j = 0; j < col.ny; j += 2) for (let i = 0; i < col.nx; i += 2) { const v = col.h[j * col.nx + i] / col.scale; if (v <= col.sea + 0.6) continue; const bx = col.x0 + i * col.cell, by = col.y0 + j * col.cell, [x, z] = W(bx, by);
    deckN++; const mainH = Math.max(Fd.H0(x, z), F.heightAt(x, z)); if (Math.abs(Hwalk(x, z) - mainH) < 1e-6) deckSame++; }
  ok(deckSame === deckN, 'every deck / plateau / roof cell walks exactly as on main (' + deckSame + '/' + deckN + ')');
  { const [x, z] = W(-68, 22), v = F.heightAt(x, z); ok(Math.abs(Hwalk(x, z) - Math.max(Fd.H0(x, z), v)) < 1e-9 && v > c.y0 - 1, 'HOME pad (bx -68, by 22) walking height unchanged (' + (Hwalk(x, z) - c.y0).toFixed(2) + ' rel.)'); }
  // far from the mansion nothing changes
  { let d = 0; for (let k = 0; k < 400; k++) { const x = c.px + 600 + k * 7, z = c.pz - 900 + k * 3; if (Fd.H(x, z) !== Fd.H0(x, z) || Hw(x, z) !== Fd.H0(x, z)) d++; } ok(d === 0, 'outside box + apron the ground / water fields are untouched'); }
  // ── the face is SEEN: rays from seaward vantage points to the face (lip .. foot), against the drawn ground ──
  function vis(Hd) { let seen = 0, tot = 0; for (const vb of [-120, 0, 120]) for (const vy of [6, 30]) for (const tb of [-150, -75, 0, 75, 150]) for (const ty of [-8, -24, -40, -56]) {
    const [ex, ez] = W(vb, 520), ey = vy, [tx, tz] = W(tb, 66), ty2 = c.y0 + ty; tot++; let hid = false;
    for (let s = 0.02; s < 0.97; s += 0.01) { const x = ex + (tx - ex) * s, z = ez + (tz - ez) * s, y = ey + (ty2 - ey) * s; if (Hd(x, z) > y) { hid = true; break; } }
    if (!hid) seen++; } return seen / tot; }
  const vMain = vis(drawnMain), vNow = vis(Fd.H);
  console.log('  face visibility from the sea (3 x 2 vantages, 20 face points): main ' + (vMain * 100).toFixed(0) + '% -> now ' + (vNow * 100).toFixed(0) + '%');
  ok(vNow >= 0.9 && vNow > vMain, 'the cliff face is visible from the sea (' + (vNow * 100).toFixed(0) + '% of sight lines, main ' + (vMain * 100).toFixed(0) + '%)');
  // ── the blend interface for JOTS Worlds ──
  const fp = F.footprint(); ok(fp && fp.box.length === 4 && fp.apron.length === 4 && fp.baseRing.length >= 14 && fp.baseRing.every(r => r.y < c.y0 - 60), 'F.footprint(): box, apron, base-height ring (all under the waterline) for JOTS Worlds');
  // ── texture tiers ──
  const R = X.cliffRes; const T = [[0, false, false, false, undefined, false, null], [1, false, false, false, undefined, false, '1k'], [2, false, false, false, undefined, false, '2k'], [3, false, false, false, undefined, false, '2k'],
    [2, true, false, true, undefined, false, '1k'], [3, true, false, false, undefined, false, null], [2, true, true, false, undefined, false, null], [3, true, true, false, undefined, false, '1k'], [3, true, true, false, undefined, true, null], [3, true, false, true, '512', false, null], [1, true, false, true, '1k', false, null]];
  for (const t of T) ok(R(t[0], t[1], t[2], t[3], t[4], t[5]) === t[6], 'cliff tier ' + JSON.stringify(t.slice(0, 6)) + ' -> ' + t[6]);
  // ── cache stamps + standing rules ──
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const swV = +((sw.match(/CACHE_NAME = 'dartmeadow-engine-v(\d+)'/) || [])[1] || 0), facV = +((html.match(/ui\/dm-facilities\.js\?v=(\d+)/) || [])[1] || 0);
  ok(swV >= 333, 'sw CACHE_NAME is past main v332 (v' + swV + '; CE assigns the final number at merge)');
  ok(facV >= 333 && facV <= swV && F.shardVer === String(facV), 'dm-facilities.js?v= and the shards.json key (F.shardVer) agree, at v333 or later and never past CACHE_NAME (v' + facV + ', ' + F.shardVer + ', sw v' + swV + ')');   // (t1516) >= check: a later branch's sw bump does not have to re-key the shards
  ok(F.ver === '302', 'the unchanged mansion GLB / cliff maps keep F.ver 302 (no 10 MB re-download)');
  ok(/const ATMO_DEFAULT_AGL\s*=\s*46\b/.test(html), 'ATMO_DEFAULT_AGL stays 46');
  ok(/TERRAIN\.Hw=\(\(\)=>\{ const h0=F\.H0\|\|H; try\{ const f=_fac\(\); return f&&f\.seaField\?f\.seaField\(h0\):h0;/.test(html), 'index.html: TERRAIN.Hw = DMFac.seaField(natural ground)');
  // ── teardown frees the shard geometry ──
  const live0 = geoLive; F.close(); ok(geoLive === live0 - 2 && F.car === null, 'world close disposes the 2 shard geometries and clears the carve');
  console.log(fails ? fails + ' FAILED of ' + n : 'solenne-cliff: all ' + n + ' checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
