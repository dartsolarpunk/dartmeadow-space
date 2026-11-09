// node tools/tests/skyground-budget.js — Wave 1: SkyGround.update honours its per-frame build budget.
// Runs the REAL SkyGround code extracted from index.html (same slices as terrain-lod.js) under a fake clock in which each _build costs a set number of ms:
//  (1) the pure policy _skyGroundGate: budget honoured, focus cap, one emergency build only while the ground under her is bare, non-focus never past budget
//  (2) a frame never starts a build past its budget except the single emergency one; focus builds per frame <= 2 (handheld) / 4 (desktop)
//  (3) the ground under her is never bare after the first frame; a frame with no budget at all still builds the one tile under her
//  (4) an explicit one-off bulk budget (world-open prime / cruise-skip jump) keeps the budget but not the cap
//  (5) walking / flying across tile edges converges to the same fully built quadtree as an unthrottled build
//  (6) update() / _build() source carries none of the per-frame allocations Wave 1 removed
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const TL = require(path.join(root, 'ui', 'dm-terrain-lod.js'));
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const cut = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('marker not found: ' + a); const j = html.indexOf(b, i + a.length); if (j < 0) throw new Error('marker not found: ' + b); return html.slice(i, j); };
const srcNoise = cut('function _vnoise(x,y,seed){', '// Texel generation is pure arithmetic');
const srcD = cut('const ATMO_DEG_PER_UNIT=0.008;', '// One map per planet') + cut('function _siteWorldXZ(site){', 'const LAND_PICK_RANGE');
const srcCore = cut('function _terrainCore(x,z,seed,_ws){', '// ── Shoreline water');
const srcField = cut('function _groundField(body,site,pal){', '// ── The planet\'s ground, level of detail, pole to pole');
const srcPWF = cut('const PWF={u:null', 'function _pwfReady()') + cut('function _pwfMap(x,y,z,out){', '// the planet\'s centre in the drawn frame') + cut('function _pwfCentre(out){', '\n') + '\n';
const srcSky = cut('function SkyGround(scene,F,pal,o){', 'SkyGround.prototype.dispose=');

class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } clone() { return new V3(this.x, this.y, this.z); }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; } add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; } dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  length() { return Math.hypot(this.x, this.y, this.z); } distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); } }
class Col { constructor() { this.r = 0; this.g = 0; this.b = 0; } copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; } lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; } multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; } }
class Attr { constructor(a, s) { this.array = a; this.itemSize = s; this.needsUpdate = false; } }
class Geo { constructor() { this.attributes = {}; this.index = null; } setAttribute(k, a) { this.attributes[k] = a; } setIndex(a) { this.index = a; } computeBoundingSphere() { } dispose() { } }
class Mesh { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V3(); this.visible = true; this.userData = {}; } }
class Grp { constructor() { this.children = []; this.parent = null; this.name = ''; } add(o) { this.children.push(o); o.parent = this; } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; } }
const THREE = { Vector3: V3, Color: Col, BufferAttribute: Attr, Uint16BufferAttribute: Attr, BufferGeometry: Geo, Mesh, Group: Grp, Frustum: class { }, Matrix4: class { }, Sphere: class { constructor() { this.center = new V3(); this.radius = 0; } } };
const clock = { t: 0 }, performance = { now: () => clock.t };
const f = new Function('THREE', 'window', 'DMTerrainLod', 'performance', `
  const GFX = { isMobile: false, shadows: false };
  ${srcNoise}
  ${srcD}
  ${srcPWF}
  let PW = { site: null };
  const TERRAIN = { style: 'lush' }, _worldSeed = () => 311;
  const _terrainDetailMat = () => ({}); const _sbcIsEarth = () => false;
  const _sbcC = new THREE.Color();
  let surfaceBiomeColor = (x, z, h, slope, pal, seed, opts) => { _sbcC.r = h; _sbcC.g = slope; _sbcC.b = opts.siteLat; return _sbcC; };
  ${srcCore}
  ${srcField}
  ${srcSky}
  return { _groundField, SkyGround, _skyGroundGate, PWF, GFX, setSite: s => { PW.site = s; }, flatAt: (fx, fz) => { PWF.on = 0; PWF.fx = fx; PWF.fz = fz; PWF.g = 1; } };
`);
const E = f(THREE, {}, TL, performance);
const pal = { water: true, liquidColor: 0x1a4a7a, ground: 0x3a7d34 };
const body = { name: 'Solenne', type: 'Habitable', home: true }, site = { lat: 18, lon: 40 };
const gate = E._skyGroundGate;

// ── (1) the pure policy ───────────────────────────────────────────────────────────────────────────
ok(gate(0, 4, false, 0, 2, false, false) === 1, 'non-focus inside budget: build');
ok(gate(4, 4, false, 0, 2, false, false) === 0, 'non-focus at budget: stop');
ok(gate(9, 4, false, 0, 2, true, false) === 0, 'non-focus over budget never builds, even with the ground under her bare');
ok(gate(1, 4, true, 0, 2, false, false) === 1 && gate(1, 4, true, 1, 2, false, false) === 1, 'focus inside budget and under the cap: build');
ok(gate(1, 4, true, 2, 2, false, false) === 3, 'handheld cap: 3rd focus tile in a frame is skipped (budget left for the rest)');
ok(gate(1, 7, true, 3, 4, false, false) === 1 && gate(1, 7, true, 4, 4, false, false) === 3, 'desktop cap: 4 focus tiles, the 5th skipped');
ok(gate(5, 4, true, 0, 2, false, false) === 0, 'focus over budget with ground already drawn: stop (no more bypass)');
ok(gate(5, 4, true, 0, 2, true, false) === 2, 'focus over budget, nothing under her drawable: the one emergency build');
ok(gate(5, 4, true, 1, 2, true, true) === 0, 'emergency already spent this frame: stop');
ok(gate(1, 4, true, 2, 2, true, false) === 2 && gate(1, 4, true, 2, 2, true, true) === 3, 'over the cap while bare: one emergency, then skip');
ok(gate(0, 0, true, 0, 2, true, false) === 2 && gate(0, 0, true, 0, 2, false, false) === 0, 'zero budget: only the emergency tile under her');
ok(gate(10, 500, true, 40, Infinity, false, false) === 1, 'bulk budget (no cap): focus builds while the budget lasts');

// ── harness: a SkyGround on a flat frame, each _build costs `cost` ms of the fake clock ───────────────
function mk(mobile, cost) {
  E.GFX.isMobile = mobile; E.setSite(site); const F = E._groundField(body, site, pal);
  E.flatAt(0, 0);
  const G = new E.SkyGround(new Grp(), F, pal, {}); G.viewR = 6000;
  const real = G._build; const log = [];
  G._build = function (nd) { log.push({ el: clock.t - G._t0, foc: !!nd._foc }); real.call(this, nd); clock.t += cost; };
  const frame = (cam, budget) => { log.length = 0; clock.t += 16; G._t0 = clock.t; const left = G.update({ position: cam }, budget); return { left, log: log.slice(), st: Object.assign({}, G.stat) }; };
  return { G, F, frame };
}
const camAt = (F, x, z, agl) => new V3(x, (F.H(x, z) || 0) + agl, z);

// ── (2)(3) per-frame limits while walking / flying across tile edges ───────────────────────────────
for (const [mobile, cap, B] of [[true, 2, 4], [false, 4, 7]]) {
  for (const cost of [0.4, 1.5, 6]) {
    const { G, F, frame } = mk(mobile, cost);
    let maxFoc = 0, maxB = 0, pastBudget = 0, emerg = 0, bareFrames = 0, frames = 0, built = 0;
    for (let i = 0; i < 600; i++) {
      const x = i * 2.2, z = Math.sin(i / 90) * 400;   // ~130 m/s along x, weaving in z: crosses many tile edges
      E.PWF.fx = x; E.PWF.fz = z;
      const r = frame(camAt(F, x, z, i % 300 < 150 ? 3 : 120), undefined); frames++; built += r.st.built;
      const foc = r.log.filter(e => e.foc).length; maxFoc = Math.max(maxFoc, foc); maxB = Math.max(maxB, r.log.length);
      // a build that STARTS at or past the budget is only allowed as the frame's single emergency
      pastBudget += Math.max(0, r.log.filter(e => e.el >= B).length - r.st.emerg); emerg += r.st.emerg;
      if (G._bareUnder()) bareFrames++;
    }
    const tag = (mobile ? 'handheld' : 'desktop') + ' cost ' + cost + ' ms';
    ok(maxFoc <= cap + 1, tag + ': focus builds per frame <= cap+1 emergency (max ' + maxFoc + ')');
    ok(pastBudget === 0, tag + ': no build starts past the budget except the emergency one (' + pastBudget + ')');
    ok(bareFrames === 0, tag + ': the chain under her has a drawable tile at the end of every frame (' + bareFrames + ' bare)');
    ok(maxB <= Math.ceil(B / cost) + 1, tag + ': builds per frame bounded by the budget (max ' + maxB + ', bound ' + (Math.ceil(B / cost) + 1) + ')');
    console.log('  ' + tag + ': ' + frames + ' frames, ' + built + ' builds, max ' + maxB + '/frame, max focus ' + maxFoc + '/frame, emergencies ' + emerg);
  }
}
// zero budget, fresh world: exactly the one tile under her, then nothing until there is budget again
{
  const { G, F, frame } = mk(true, 2);
  E.PWF.fx = 100; E.PWF.fz = 100;
  ok(G._bareUnder() === true, 'fresh ground: nothing under her yet');
  const r = frame(camAt(F, 100, 100, 3), 0);
  ok(r.st.built === 1 && r.st.emerg === 1 && r.log[0].foc, 'zero budget: one emergency build, a focus tile (' + r.st.built + ')');
  ok(G._bareUnder() === false, 'after it the ground under her can draw');
  const r2 = frame(camAt(F, 100, 100, 3), 0);
  ok(r2.st.built === 0 && r2.st.emerg === 0, 'next zero-budget frame: no emergency once a focus mesh exists');
  // one slow tile (12 ms) eats the budget: the first focus build happens, then the frame stops
  const s = mk(true, 12); E.PWF.fx = 100; E.PWF.fz = 100;
  const r3 = s.frame(camAt(s.F, 100, 100, 3), undefined);
  ok(r3.st.built === 1 && r3.st.emerg === 0, 'slow tile: 1 build, then the budget stops the frame (' + r3.st.built + ')');
}
// ── (4) bulk prime keeps the budget, drops the cap ─────────────────────────────────────────────────
{
  const { F, frame } = mk(true, 1); E.PWF.fx = 0; E.PWF.fz = 0;
  const r = frame(camAt(F, 0, 0, 3), 500);
  const foc = r.log.filter(e => e.foc).length;
  ok(foc > 4, 'bulk 500 ms prime: focus chain not capped (' + foc + ' focus builds)');
  ok(r.log.every(e => e.el < 500), 'bulk prime: every build started inside the 500 ms');
  const r2 = mk(true, 1); E.PWF.fx = 0; E.PWF.fz = 0;
  const q = r2.frame(camAt(r2.F, 0, 0, 3), 11);   // landing budget (7 / 11 ms) is per-frame: capped
  ok(q.log.filter(e => e.foc).length <= 2, 'landing budget 11 ms on a handheld: still capped at 2 focus builds');
}
// ── (5) throttled == unthrottled once settled ──────────────────────────────────────────────────────
{
  const sig = G => { const out = []; const walk = nd => { out.push([nd.x0, nd.z0, nd.size, !!nd.mesh, nd.mesh ? nd.mesh.visible : null].join(',')); if (nd.kids) nd.kids.forEach(walk); }; for (const r of G.roots.values()) walk(r); return out.sort().join('|'); };
  const a = mk(true, 1.5), b = mk(true, 0);
  E.PWF.fx = 2500; E.PWF.fz = -700; const cA = camAt(a.F, 2500, -700, 3);
  let g = 0; while (a.frame(cA, undefined).left > 0 && g++ < 5000);
  let g2 = 0; while (b.frame(cA, 1e9).left > 0 && g2++ < 20);
  for (let i = 0; i < 80; i++) { a.frame(cA, undefined); b.frame(cA, 1e9); }   // let every geomorph finish (0.7 s) on both
  ok(g < 5000, 'throttled build settles (' + g + ' frames)');
  ok(sig(a.G) === sig(b.G), 'throttled and unthrottled builds end in the same quadtree and the same visible tiles');
  // identical geometry for a tile built either way
  let same = true, cnt = 0; const ta = [], tb = [];
  const coll = (G, arr) => { const walk = nd => { if (nd.mesh) arr.push(nd); if (nd.kids) nd.kids.forEach(walk); }; for (const r of G.roots.values()) walk(r); };
  coll(a.G, ta); coll(b.G, tb); const key = nd => nd.x0 + ',' + nd.z0 + ',' + nd.size; const mb = new Map(tb.map(nd => [key(nd), nd]));
  // full-detail data (a tile still waiting to be shown keeps its geomorph start in the buffers; its target lives in .morph)
  const full = nd => { const g = nd.mesh.geometry.attributes, M = nd.morph, V = 33 * 33, y = new Float32Array(V); for (let k = 0; k < V; k++) y[k] = M ? M.fY[k] : g.position.array[k * 3 + 1];
    return [y, M ? M.fN : g.normal.array.subarray(0, V * 3), M ? M.fC : g.color.array.subarray(0, V * 3), g.position.array.filter((v, i) => i % 3 !== 1)]; };
  for (const nd of ta) { const o = mb.get(key(nd)); if (!o) { same = false; continue; } cnt++; const A = full(nd), Bf = full(o); for (let k = 0; k < A.length; k++) { const x = A[k], y = Bf[k]; if (x.length !== y.length) same = false; else for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { same = false; break; } } }
  ok(same && cnt > 0, 'same vertex data per tile throttled vs unthrottled (' + cnt + ' tiles)');
  // index: a fresh copy per tile, never the shared scratch, and in range
  const ix = ta[0].mesh.geometry.index.array;
  ok(ix instanceof Uint16Array && ix !== a.G._sb.idx && ix !== ta[1].mesh.geometry.index.array, 'each tile owns its index array (shared scratch is copied, not handed out)');
  const vc = ta[0].mesh.geometry.attributes.position.array.length / 3; ok(ix.every(v => v < vc) && ix.length === 32 * 32 * 6 + 128 * 12, 'index in range, quads + skirts');
}
// ── (6) the per-frame allocations are gone from the source ─────────────────────────────────────────
{
  const body = (name, end) => cut('SkyGround.prototype.' + name + '=function', end);
  const up = body('update', 'SkyGround.prototype._rootKeep=');
  ok(!/new\s+(Set|Map|Array|THREE)/.test(up), 'update(): no new Set/Map/Array/THREE per frame');
  ok(!/=>/.test(up), 'update(): no closures (has / comparator / iterator lambdas)');
  ok(!/\+'_'\+/.test(up), 'update(): no string root keys');
  ok(/keep\.clear\(\)/.test(up) && /\.sort\(SkyGround\.prototype\._qcmp\)/.test(up), 'update(): reused keep set, stable prototype comparator');
  ok(!/GFX\.isMobile\?16:48/.test(html), 'the 16 / 48 focus bypass is gone');
  const bd = body('_build', '// write the tile\'s vertices at morph amount w');
  ok(!/idx\.push|const idx=\[\]|Object\.assign\(\{\}|new THREE\.Color|=>/.test(bd), '_build(): no JS index array, copt copy, Color or closure per tile');
  ok(!/forEach\(\(/.test(body('_applyMorph', 'SkyGround.prototype._morphTick=')), '_applyMorph(): no closure per morphing tile per frame');
}
console.log(fails ? fails + ' FAILED of ' + n : 'skyground-budget OK (' + n + ' checks)');
process.exit(fails ? 1 : 0);
