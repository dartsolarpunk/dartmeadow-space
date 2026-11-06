// node tools/tests/collide-census.js — census of everything the game spawns, and whether it is a collision body.
//  (1) runs the REAL chunk scatter generator (extracted from index.html) on a synthetic world, registers its instanced props, and checks: every instanced mesh declares a collider spec,
//      nothing interpenetrates (rock/rock, trunk/rock, crown/crown), nothing leaks out of its chunk box, neighbouring chunks never overlap, and the output is deterministic;
//  (2) scans the sources for every InstancedMesh creation site and requires each to be classified in CENSUS below (collider / own-collision / exempt+reason / gap): a new spawner fails
//      this test until someone decides what it collides with.
'use strict';
const fs = require('fs'), path = require('path'); const root = path.join(__dirname, '..', '..');
globalThis.window = undefined; require('../../ui/dm-collide.js'); const L = globalThis.DMCollideLib;
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };

// ── (1) the real scatter generator ──────────────────────────────────────────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const a = html.indexOf('const SURF_CHUNK=300;'), b = html.indexOf('function _disposeProps');
ok(a > 0 && b > a, 'found the scatter section in index.html'); const src = html.slice(a, b);
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class Q4 { setFromEuler() { return this; } } class Eul { set() { return this; } }
class M4 { constructor() { this.elements = new Float32Array(16); this.elements[0] = this.elements[5] = this.elements[10] = this.elements[15] = 1; } decompose(p, q, s) { const e = this.elements; p.x = e[12]; p.y = e[13]; p.z = e[14]; s.x = e[0]; s.y = e[5]; s.z = e[10]; return this; } compose(p, q, s) { const e = this.elements; e.fill(0); e[0] = s.x; e[5] = s.y; e[10] = s.z; e[15] = 1; e[12] = p.x; e[13] = p.y; e[14] = p.z; return this; } }
class Col { constructor() { this.h = 0; this.s = 0; this.l = 0; } setHSL(h, s, l) { this.h = h; this.s = s; this.l = l; return this; } getHSL(o) { o.h = this.h; o.s = this.s; o.l = this.l; return o; } offsetHSL() { return this; } }
class Grp { constructor() { this.children = []; this.userData = {}; } add(o) { this.children.push(o); } traverse(f) { f(this); this.children.forEach(c => c.traverse ? c.traverse(f) : f(c)); } }
class IM { constructor(g, m, cap) { this.isInstancedMesh = true; this.count = cap; this.instanceMatrix = { array: new Float32Array(16 * cap), needsUpdate: false }; this.instanceColor = { needsUpdate: false }; this.userData = {}; this.geometry = g; }
  setMatrixAt(i, M) { this.instanceMatrix.array.set(M.elements, i * 16); } getMatrixAt(i, M) { M.elements.set(this.instanceMatrix.array.subarray(i * 16, i * 16 + 16)); }
  setColorAt() { } getColorAt() { } computeBoundingSphere() { } traverse(f) { f(this); } }
const mkTHREE = () => ({ Vector3: V3, Quaternion: Q4, Euler: Eul, Matrix4: M4, Color: Col, Group: Grp, InstancedMesh: IM, DodecahedronGeometry: class { }, CylinderGeometry: class { constructor() { this.userData = {}; } }, ConeGeometry: class { constructor() { this.userData = {}; } },
  MeshStandardMaterial: class { constructor() { this.userData = {}; } }, MeshStandardNodeMaterial: class { constructor() { this.userData = {}; } } });
function scatterFactory(DM) {
  const THREE = mkTHREE(); const TERRAIN = { seed: 7, pal: { rock: 0x777777, ground: 0x3a7d34, water: 0 }, H: (x, z) => 12 + 9 * Math.sin(x * 0.011) * Math.cos(z * 0.013) + 4 * Math.sin(x * 0.05 + z * 0.03), rockGeo: null };
  const GFX = { shadows: false, shadowSize: 0 }, STATE = { settings: { particles: 'high' } }; globalThis.window = { DMCollide: DM };
  const f = new Function('THREE', 'TERRAIN', 'GFX', 'STATE', 'window', src + '\nreturn {gen:_hmChunkScatterG, C:SURF_CHUNK};');
  return f(THREE, TERRAIN, GFX, STATE, { DMCollide: DM });
}
const DM = L.create({ capacity: 8192 }); const S = scatterFactory(DM), C = S.C;
function chunk(i, j) { const it = S.gen(i, j); let r, y = 0; while (!(r = it.next()).done) y++; return { g: r.value, yields: y }; }
function registerAll(g, key) { let tot = 0; g.traverse(o => { if (o.isInstancedMesh && o.userData.col) { tot += DM.runGen(DM.fromInstancedGen(key, o.instanceMatrix.array, o.count, o.userData.col, 24)); } }); return tot; }
const raw = DM._raw; let overlaps = 0, outside = 0, rocks = 0, trunks = 0, crowns = 0, uncovered = 0;
const keys = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0]];
const sig = [];
for (const [i, j] of keys) {
  const { g, yields } = chunk(i, j); const key = 'chunk#' + i + '_' + j;
  g.traverse(o => { if (o.isInstancedMesh) { let real = 0; for (let k = 0; k < o.count; k++) if (o.instanceMatrix.array[k * 16] > 0) real++; if (real && !o.userData.col) uncovered++; } });
  const before = DM.count(); const reg = registerAll(g, key); ok(DM.count() - before === reg, 'chunk ' + i + ',' + j + ' registered ' + reg); ok(yields >= 1, 'scatter is sliced (' + yields + ' yields)');
  sig.push(reg + ':' + g.children.map(c => c.instanceMatrix.array.slice(0, 16).join(',')).join('|').length);
}
ok(uncovered === 0, 'every populated instanced mesh declares a collider spec (' + uncovered + ' without)');
// pairwise overlap among all registered (rocks = ellipsoid/rock, trunks = cyl/wood, crowns = ellipsoid/foliage soft)
const ids = []; for (let k = 0; k < 8192; k++) if (raw.flg[k] & 1) ids.push(k);
const kind = (k) => (raw.typ[k] === 3 ? 'trunk' : (raw.flg[k] & 2) ? 'crown' : 'rock');
for (const k of ids) { const t = kind(k); if (t === 'rock') rocks++; else if (t === 'trunk') trunks++; else crowns++; }
console.log('census: rocks', rocks, 'trunks', trunks, 'crowns', crowns, 'colliders', ids.length, 'in', keys.length, 'chunks');
ok(rocks > 100 && trunks > 5 && crowns > 5, 'a populated world (rocks ' + rocks + ', trunks ' + trunks + ', crowns ' + crowns + ')');
for (let p = 0; p < ids.length; p++) for (let q = p + 1; q < ids.length; q++) {
  const A = ids[p], B = ids[q], ta = kind(A), tb = kind(B); if (ta === 'crown' && tb !== 'crown') continue; if (tb === 'crown' && ta !== 'crown') continue;   // a crown over a rock is above it; crown/crown must not touch
  const d = Math.hypot(raw.px[A] - raw.px[B], raw.pz[A] - raw.pz[B]), ra = raw.ea[A], rb = raw.ea[B]; const rr = (ta === 'crown' ? ra / 0.7 * 0.7 : ra) + (tb === 'crown' ? rb : rb);
  if (d < rr - 1e-3) { overlaps++; console.log('  overlap', ta, tb, d.toFixed(3), rr.toFixed(3), raw.px[A].toFixed(1), raw.pz[A].toFixed(1), raw.px[B].toFixed(1), raw.pz[B].toFixed(1)); }
}
ok(overlaps === 0, 'no rock/trunk/crown pair interpenetrates (' + overlaps + ' overlaps)');
for (const [i, j] of keys) { /* leakage: every collider of a chunk lies within its box */ }
for (const k of ids) { const cx = Math.round(raw.px[k] / C), cz = Math.round(raw.pz[k] / C); if (raw.px[k] - raw.ea[k] < cx * C - C / 2 - 1e-3 || raw.px[k] + raw.ea[k] > cx * C + C / 2 + 1e-3 || raw.pz[k] - raw.ea[k] < cz * C - C / 2 - 1e-3 || raw.pz[k] + raw.ea[k] > cz * C + C / 2 + 1e-3) outside++; }
ok(outside === 0, 'every collider is inside its own chunk box (' + outside + ' leak)');
{ const DM2 = L.create({ capacity: 8192 }); const S2 = scatterFactory(DM2); const g = (() => { const it = S2.gen(0, 0); let r; while (!(r = it.next()).done); return r.value; })(); let s2 = 0; g.traverse(o => { if (o.isInstancedMesh && o.userData.col) s2 += DM2.runGen(DM2.fromInstancedGen('x', o.instanceMatrix.array, o.count, o.userData.col, 24)); }); ok(sig[0].startsWith(s2 + ':'), 'deterministic: chunk 0,0 registers the same count twice'); }
// walking through the generated world: a sweep across it never ends inside any collider that blocks
{ const W = DM; const c = W.makeChar({ x: -140, y: 0, z: 0, ground: () => 0 }); let inside = 0; for (let f = 0; f < 600; f++) { W._dt = 1 / 15; W.walk(c, 2.0, Math.sin(f * 0.07) * 0.6); const n = W.query(c.x - 1, c.z - 1, c.x + 1, c.z + 1); for (let q = 0; q < n; q++) { const k = W.results[q]; if ((raw.flg[k] & 2) || raw.typ[k] === 5) continue; if (raw.typ[k] === 2) { const top = raw.py[k] + raw.eb[k]; if (top <= c.y + c.step + 1e-3) continue; } const d = Math.hypot(c.x - raw.px[k], c.z - raw.pz[k]); const mid = raw.py[k]; if (c.y + c.step < raw.py[k] + raw.eb[k] && d < 0.25 * raw.ea[k]) inside++; } }
  ok(inside === 0, 'a 600-frame run at 15 fps through the generated world never ends inside a solid (' + inside + ')'); }

// ── (2) spawner census ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// status: 'collider' (registered in DMCollide), 'own' (an engine-specific collision already covers it), 'exempt' (not a solid: effect / sky / space / menu), 'gap' (known, owner named)
const CENSUS = [
  { file: 'index.html', pat: /InstancedMesh\(geo,_propKit\(\)\.rock/, id: 'scatter rocks / boulders', status: 'collider', proof: /col=\{kind:'ellipsoid',mat:'rock'/ },
  { file: 'index.html', pat: /InstancedMesh\(K\.tGeo/, id: 'scatter tree trunks', status: 'collider', proof: /col=\{kind:'cyl',mat:'wood'/ },
  { file: 'index.html', pat: /InstancedMesh\(K\.cGeo/, id: 'scatter tree crowns (soft)', status: 'collider', proof: /kind:'ellipsoid',mat:'foliage'/ },
  { file: 'ui/dm-places.js', pat: /InstancedMesh\(o\.geometry/, id: 'settlement props', status: 'collider', proof: /kind:'bbox'/ },
  { file: 'index.html', pat: /InstancedMesh\(rockGeo,rockMat,count\)/, id: 'space asteroids / boulders (flight scene)', status: 'own', proof: /Bounding-sphere collision against celestial bodies/ },
  { file: 'ui/dm-facilities.js', pat: /InstancedMesh\(new T\.ConeGeometry\(1\.4/, id: 'Ariel island trees (mansion area)', status: 'collider', proof: /col: 'cyl', x: ps\.x/ },
  { file: 'ui/dm-lamps.js', pat: /InstancedMesh\(new THREE\.PlaneGeometry/, id: 'lamp glow sprites', status: 'exempt', why: 'light sprites' },
  { file: 'ui/dm-lamps.js', pat: /const mk = \(arr, mat, count, name\)/, id: 'Ariel street-lamp poles and heads (mansion area)', status: 'collider', proof: /W\.addCylinder\('lamps'/ },
  { file: 'ui/dm-marine.js', pat: /InstancedMesh\(geo,mat,cap\)/, id: 'marine life (fish)', status: 'exempt', why: 'swim-through ambient life in the water volume' },
  { file: 'ui/dm-fluid.js', pat: /JOTS_FluidDrops|JOTS_FluidFoam/, id: 'fluid drops / foam', status: 'exempt', why: 'effect particles (they collide with the fluid solver itself)' },
  { file: 'ui/dm-hazardbubble.js', pat: /S\.bub=new THREE\.InstancedMesh/, id: 'hazard bubble', status: 'exempt', why: 'effect volume' },
  { file: 'ui/dm-mist.js', pat: /InstancedMesh\(new THREE\.PlaneGeometry/, id: 'mist sprites', status: 'exempt', why: 'effect sprites' },
  { file: 'ui/dm-star.js', pat: /InstancedMesh\(new THREE\.PlaneGeometry/, id: 'star sprites', status: 'exempt', why: 'sky' },
  { file: 'ui/dm-menuscene.js', pat: /InstancedMesh\(geos\[k\]|InstancedMesh\(pg,/, id: 'menu scene rocks / particles', status: 'exempt', why: 'menu scene, no player body' },
  { file: 'index.html', pat: /InstancedMesh\((star\?|_gsStarGeo|g,mat,WAKE_N|geo,mat,count\)|geo,mat,n\)|geo,\(look|new THREE\.PlaneGeometry\(2,2\)|geo,mat,items|G\.traveler|G\.halo)/, id: 'galaxy / space-map / wake sprites', status: 'exempt', why: 'map and sky layers, flight wake ribbons' },
];
const files = ['index.html'].concat(fs.readdirSync(path.join(root, 'ui')).filter(f => f.endsWith('.js')).map(f => 'ui/' + f));
const sites = []; for (const f of files) { const t = fs.readFileSync(path.join(root, f), 'utf8'); const lines = t.split('\n'); lines.forEach((ln, i) => { if (/new (THREE\.|T\.)?InstancedMesh\(/.test(ln) && !/^\s*\/\//.test(ln)) sites.push({ f, i: i + 1, ln }); }); }
let unclassified = 0; const used = new Set();
for (const s of sites) { if (/ui\/dm-(collide|collide-game)\.js/.test(s.f)) continue; const hit = CENSUS.findIndex(c => c.file === s.f && c.pat.test(s.ln)); if (hit < 0) { unclassified++; console.log('  UNCLASSIFIED spawner', s.f + ':' + s.i, s.ln.trim().slice(0, 110)); } else used.add(hit); }
ok(unclassified === 0, 'every InstancedMesh spawner is classified in the census (' + unclassified + ' new)');
for (const [k, c] of CENSUS.entries()) { ok(used.has(k) || c.pat.test(fs.readFileSync(path.join(root, c.file), 'utf8')), 'census entry still matches the code: ' + c.id); if (c.proof) ok(c.proof.test(fs.readFileSync(path.join(root, c.file), 'utf8')) || c.proof.test(html), 'collider proof present for ' + c.id); }
const gaps = CENSUS.filter(c => c.status === 'gap'); const by = {}; CENSUS.forEach(c => { by[c.status] = (by[c.status] || 0) + 1; });
ok(gaps.length === 0, 'no census gaps remain (' + gaps.map(g => g.id).join(', ') + ')');
console.log('spawner census:', JSON.stringify(by), gaps.map(g => 'GAP ' + g.id + ' -> ' + g.owner).join('; '));
// non-instanced spawners and the characters / structures, with the code that gives each a body
const OTHER = [
  ['planet terrain (marching cubes / tess / height field)', 'index.html', /_pwGroundAt/], ['Ariel mansion exterior grid + interior walk', 'ui/dm-mansion-interior.js', /walk/],
  ['Bird Temple walking (TCOL) + step events', 'index.html', /W\.shipStride/], ['Bird Temple flight hull', 'index.html', /_btFlightCollide/], ['settlement walls (LOD0 GLB)', 'ui/dm-places.js', /regObject\(key,rec\.lod0/],
  ['creatures / NPCs', 'ui/dm-creatures.js', /npcStep/], ['other pilots (on foot / riding)', 'index.html', /DMCollide\.peerActor/], ['local rider on the board', 'index.html', /DMCollide\.riderActor\(true/],
  ['companion board', 'index.html', /_DCb\.pushOut/], ['parked board', 'index.html', /DMCollide\.parkedBoard/], ['board in low flight', 'index.html', /W\.sweepSphere\(_cx0/], ['water surface bodies', 'ui/dm-collide-game.js', /setWater\(/],
  ['landing finds a clear footprint (her capsule + board)', 'index.html', /function _landSafe[\s\S]*findClear/], ['landing steers + re-validates', 'index.html', /_landSteer\(s,dt\)/], ['touchdown moves to the safe spot', 'index.html', /_landSafe\(board\.position\.x/],
  ['walk start pushes her out of solids', 'index.html', /_riderEvent\('landMove',\['walkStart'/], ['board unstick after summon', 'index.html', /_boardUnstick\(b\)/], ['landing watchdog forces completion', 'index.html', /_landForce\('timeout'\)/], ['Ariel lamp poles', 'ui/dm-lamps.js', /addCylinder\('lamps'/], ['Ariel island trees + towers', 'ui/dm-facilities.js', /addCylinder\('facility'/],
  ['hair / cloth / fluid particles', 'ui/dm-cgroup.js', /DC\.sphereOut/], ['the local character', 'index.html', /DMCollide\.surfWalk/], ['scatter chunk registration + drop', 'index.html', /DMCollide\.dropChunk\('chunk#'/],
];
for (const [name, f, re] of OTHER) ok(re.test(fs.readFileSync(path.join(root, f), 'utf8')), 'has a body: ' + name);
console.log(fails ? fails + ' FAILED of ' + n : 'collide-census: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
