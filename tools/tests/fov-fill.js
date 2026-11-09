// node tools/tests/fov-fill.js — (fov-fill) standing on the HOME deck the ground fills the field of view to the horizon, and no teal polygon sits on the walkway.
//  (1) _skyHorizonReach is the horizon on the sphere (sqrt(h (2R + h)) for the camera plus the same for the tallest land past it): no pi, monotone in height.
//  (2) _skyGroundR opens the drawn ground radius to that reach (never below viewR, never past the sky's radius); _skyFillFog puts the haze's far end exactly
//      where the ground starts to dissolve on foot (the dissolving edge is always in full haze: no rim, no dither), and leaves the flight haze alone.
//  (3) wiring in the frame: SkyGround.viewR = groundR, far clip and the fallback sea follow it, the fog gets the fill, props keep the haze without it (cost).
//  (4) the REAL SkyGround on Solenne's real height field, planet frame on, eye on a coastal cliff 64 u above the sea (the HOME deck's height class):
//      once settled, every ground point that the camera can see (not behind the planet) out to the dissolve radius lies under a visible tile — the whole
//      field of view, to the horizon — and the far ring adds only a few dozen coarse tiles over the old vantage radius.
//  (5) SETTLE: standing still with tiles waiting, the per-frame budget is _SKY_SETTLE.k x the normal one (still a time budget: no build starts past it but the
//      one emergency); the queue drains in fewer frames; moving drops it back at once; update() still allocates nothing per frame.
//  (6) the walkway teal polygon: the deck-level ah_pool quad (y -0.26, x 46.8..76.7, z -31.2..-7.8) of both mansion GLBs is dropped by DMFac.poolTrim when the GLB
//      loads; the sea-terrace pool stays; ah_pool is the only cyan material in every mansion GLB, so nothing teal is left on the deck.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const TL = require(path.join(root, 'ui', 'dm-terrain-lod.js'));
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9) * Math.max(1, Math.abs(b));
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
class Col { constructor() { this.r = 0; this.g = 0; this.b = 0; } copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; } clone() { return new Col().copy(this); } lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; } multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; } }
class Attr { constructor(a, s) { this.array = a; this.itemSize = s; this.needsUpdate = false; } }
class Geo { constructor() { this.attributes = {}; this.index = null; } setAttribute(k, a) { this.attributes[k] = a; } setIndex(a) { this.index = a; } computeBoundingSphere() { } dispose() { } }
class Mesh { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V3(); this.visible = true; this.userData = {}; } }
class Grp { constructor() { this.children = []; this.parent = null; this.name = ''; } add(o) { this.children.push(o); o.parent = this; } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; } }
const THREE = { Vector3: V3, Color: Col, BufferAttribute: Attr, Uint16BufferAttribute: Attr, BufferGeometry: Geo, Mesh, Group: Grp, Frustum: class { }, Matrix4: class { }, Sphere: class { constructor() { this.center = new V3(); this.radius = 0; } } };
const clock = { t: 0 }, performance = { now: () => clock.t };
const E = new Function('THREE', 'window', 'DMTerrainLod', 'performance', `
  const GFX = { isMobile: true, shadows: false };
  ${srcNoise}
  ${srcD}
  ${srcPWF}
  let PW = { site: null };
  const TERRAIN = { style: 'lush' }, _worldSeed = () => 311;
  const _terrainDetailMat = () => ({}); const _sbcIsEarth = () => false;
  const _sbcC = new THREE.Color();
  let surfaceBiomeColor = (x, z, h, slope, pal, seed, opts) => { _sbcC.r = h; _sbcC.g = slope; _sbcC.b = opts.siteLat; return _sbcC; };
  function _smooth01(t){ t=Math.max(0,Math.min(1,t)); return t*t*(3-2*t); }
  ${srcCore}
  ${srcField}
  ${srcSky}
  // the planet frame as index.html _pwfSet sets it (minus the shader uniforms)
  function pwfOn(fx,fz,alt,s){ const lat=Math.max(-89.9,Math.min(89.9,s.lat-fz*ATMO_DEG_PER_UNIT))*Math.PI/180, w=1-_smooth01((alt-1500)/4500), gMax=Math.min(1/Math.max(1e-3,Math.cos(lat)),5.8);
    PWF.fx=fx; PWF.fz=fz; PWF.lat=lat; PWF.sl=Math.sin(lat); PWF.cl=Math.cos(lat); PWF.g=1+(gMax-1)*w; PWF.on=1; PWF.R=360/ATMO_DEG_PER_UNIT/(2*Math.PI); }
  return { _groundField, SkyGround, PWF, GFX, pwfOn, _skyHorizonReach, _skyGroundR, _skyFillFog, _skySettleBudget, _SKY_SETTLE, _SKY_FADE0, _SKY_RELIEF, _skyGroundGate,
    setSite: s => { PW.site = s; } };
`)(THREE, {}, TL, performance);

// ── (1) horizon reach ──
const R = 360 / 0.008 / (2 * Math.PI);
{
  const src = cut('function _skyHorizonReach(', '\n');
  ok(!/Math\.PI|acos|asin|atan/.test(src), 'horizon reach: Pythagoras on the sphere, no pi / trig');
  for (const h of [0, 3, 20, 64, 150, 400]) {
    ok(near(E._skyHorizonReach(R, h, 0), Math.sqrt((R + h) * (R + h) - R * R), 1e-12), 'camera horizon at ' + h + ' u = tangent length sqrt((R+h)^2 - R^2)');
    ok(near(E._skyHorizonReach(R, h), Math.sqrt(h * (2 * R + h)) + Math.sqrt(E._SKY_RELIEF * (2 * R + E._SKY_RELIEF))), 'plus the horizon of the tallest land (' + h + ')');
    ok(E._skyHorizonReach(R, h + 1) > E._skyHorizonReach(R, h), 'monotone in height (' + h + ')');
  }
  ok(E._skyHorizonReach(R, -50) === E._skyHorizonReach(R, 0), 'below the sea counts as at the sea');
}
// ── (2) radius and haze ──
{
  for (const [v, hz, s] of [[1200, 2888, 3500], [4500, 2137, 4500], [1200, 9000, 3500], [3000, 1000, 1e9]]) {
    const g = E._skyGroundR(v, hz, s);
    ok(g >= v && g <= Math.max(v, s) && (hz > v ? near(g, Math.min(s, hz)) : g === v), 'groundR(' + [v, hz, s] + ') = ' + g + ': opened to the horizon, never below viewR, never past the sky');
  }
  for (const [far, gR] of [[420, 2888], [1736, 2160], [2790, 4500], [3800, 3500]]) {
    ok(near(E._skyFillFog(far, gR, 1), gR * E._SKY_FADE0), 'on foot the haze ends where the ground starts to dissolve (' + far + ', ' + gR + ')');
    ok(E._skyFillFog(far, gR, 0) === far, 'high in the sky the flight haze is untouched');
    const mid = E._skyFillFog(far, gR, 0.5); ok(mid >= Math.min(far, gR * E._SKY_FADE0) - 1e-9 && mid <= Math.max(far, gR * E._SKY_FADE0) + 1e-9, 'eases between the two');
  }
  // the old picture from the deck (vantage ~0.02, a 13 fps tablet's ladder at 0.6): haze ~430 u, nothing drawn past ~1.2 km; the sea horizon is 958 u out
  const eye = 64.1, seaH = E._skyHorizonReach(R, eye, 0), hz = E._skyHorizonReach(R, eye), gR = E._skyGroundR(1200, hz, Math.max(3500, hz));
  ok(E._skyFillFog(430, gR, 1) > seaH * 1.5, 'from the deck the haze now ends ' + Math.round(E._skyFillFog(430, gR, 1)) + ' u out, well past the sea horizon (' + Math.round(seaH) + ' u); it was ~430');
}
// ── (3) wiring ──
{
  const tick = cut('function _pwWorldTick(dt){', 'function _pwSeaFollow(');
  ok(/const groundR=\(scene\.fog&&!space\)\?_skyGroundR\(viewR,_skyHorizonReach\(R,alt\),skyR\):viewR;\s*\n\s*const G=PW\.ground; G\.viewR=groundR;/.test(tick), 'SkyGround draws to groundR (horizon reach on a world with haze)');
  ok(/Math\.max\(1200,groundR\*1\.15\)/.test(tick) && /_pwSeaFollow\(px,pz,Math\.min\(groundR,16384\)\)/.test(tick), 'far clip and the fallback sea follow groundR');
  ok(/fillF=\(scene\.fog&&!space\)\?_skyFillFog\(far,groundR,1-k\)-far:0/.test(tick) && /scene\.fog\.far=far\+fillF;/.test(tick), 'the haze gets the fill (eased out with the flight blend k)');
  ok(/PW\._propFog=far;[^\n]*\n\s*if\(scene\.fog\)\{ scene\.fog\.far=far\+fillF/.test(tick), 'props see the haze without the fill');
  ok((html.match(/PW\._propFog\|\|\(PW\.scene&&PW\.scene\.fog\?PW\.scene\.fog\.far:900\)/g) || []).length === 2, 'both prop paths (ring + cut) read PW._propFog: the prop cost does not grow with the clearer air');
  ok(/const ATMO_DEFAULT_AGL\s*=\s*46\b/.test(html), 'ATMO_DEFAULT_AGL stays 46');
}
// ── (4) the real ground from a coastal cliff on Solenne ──
const pal = { water: true, liquidColor: 0x1a4a7a, ground: 0x3a7d34 }, body = { name: 'Solenne', type: 'Habitable', home: true }, site = { lat: 18, lon: 40 };
E.setSite(site); const F = E._groundField(body, site, pal);
let cliff = null;
for (let x = -2600; x <= 2600; x += 40) for (let z = -2600; z <= 2600; z += 40) {
  const h = F.H(x, z); if (!(h > 30)) continue; let sea = false;
  for (let a = 0; a < 8; a++) if (F.H(x + Math.cos(a * 0.785) * 150, z + Math.sin(a * 0.785) * 150) < -5) sea = true;
  if (sea && (!cliff || Math.abs(h - 60) < Math.abs(cliff.h - 60))) cliff = { x, z, h };
}
ok(!!cliff, 'a coastal cliff near the mansion site');
const eye = cliff.h + 3.3, cam = new V3(cliff.x, eye, cliff.z);
function settle(viewR, cost, opts) {
  opts = opts || {}; E.GFX.isMobile = true; E.pwfOn(cliff.x, cliff.z, eye, site);
  const G = new E.SkyGround(new Grp(), F, pal, {}); G.viewR = viewR;
  const real = G._build, log = []; let t0 = 0;
  G._build = function (nd) { log.push(clock.t - t0); real.call(this, nd); clock.t += cost; };
  let fr = 0, left, past = 0, settled = 0; const c = opts.cam || cam;
  do { clock.t += 77; t0 = clock.t; log.length = 0; left = G.update({ position: c }); fr++; const B = G.stat.settle ? G.budget * E._SKY_SETTLE.k : G.budget; past += Math.max(0, log.filter(e => e >= B).length - G.stat.emerg); settled += G.stat.settle; if (opts.walk) { c.x += 2.5; E.pwfOn(c.x, c.z, eye, site); } } while (left > 0 && fr < (opts.max || 20000));
  for (let i = 0; i < 20 && !opts.walk; i++) { clock.t += 77; G.update({ position: c }); }
  return { G, fr, past, settled };
}
const vis = G => { const out = []; const w = nd => { if (nd.mesh && nd.mesh.visible) out.push(nd); if (nd.kids) nd.kids.forEach(w); }; G.roots.forEach(w); return out; };
function coverage(G, rMax) {
  let need = 0, miss = 0, behind = 0;
  const find = (x, z) => { for (const r of G.roots.values()) if (x >= r.x0 && x < r.x0 + r.size && z >= r.z0 && z < r.z0 + r.size) return r; return null; };
  for (let d = 30; d < rMax; d *= 1.12) for (let a = 0; a < 48; a++) {
    const x = cliff.x + Math.cos(a * 0.1309) * d, z = cliff.z + Math.sin(a * 0.1309) * d;
    let nd = find(x, z), covered = false, hidden = false;
    while (nd) { if (nd._vis === false) { hidden = true; break; } if (nd.mesh && nd.mesh.visible) { covered = true; break; } if (!nd.kids) break; const h = nd.size / 2; nd = nd.kids[(x >= nd.x0 + h ? 1 : 0) + (z >= nd.z0 + h ? 2 : 0)]; }
    if (hidden) { behind++; continue; } need++; if (!covered) miss++;
  }
  return { need, miss, behind };
}
{
  const hz = E._skyHorizonReach(R, eye), gR = E._skyGroundR(1200, hz, Math.max(3500, hz));
  const oldR = 1200 + (1800 - 1200) * 0.6;   // the old drawn radius on a low tablet with the ladder's ground stage at 2
  const A = settle(gR, 1.5), B = settle(oldR, 1.5);
  const cv = coverage(A.G, gR * E._SKY_FADE0), cvOld = coverage(B.G, gR * E._SKY_FADE0);
  ok(cv.need > 500 && cv.miss === 0, 'settled from the cliff: every visible ground point out to ' + Math.round(gR * E._SKY_FADE0) + ' u is under a visible tile (' + cv.need + ' points, ' + cv.miss + ' bare, ' + cv.behind + ' behind the planet)');
  ok(cvOld.miss > 0, 'the old ' + Math.round(oldR) + ' u radius left ' + cvOld.miss + ' of ' + cvOld.need + ' visible ground points out to the same reach undrawn');
  const tA = vis(A.G).length, tB = vis(B.G).length;
  ok(tA - tB <= 60, 'the horizon ring costs ' + (tA - tB) + ' coarse tiles over the old radius (' + tB + ' -> ' + tA + ')');
  console.log('  cliff ' + cliff.x + ',' + cliff.z + ' eye ' + eye.toFixed(1) + ': horizon reach ' + Math.round(hz) + ' u (sea ' + Math.round(E._skyHorizonReach(R, eye, 0)) + '), ' + tB + ' -> ' + tA + ' tiles, ' + cvOld.miss + ' -> ' + cv.miss + ' bare points');
}
// ── (5) settle ──
{
  ok(E._skySettleBudget(4, true, 10) === 4 * E._SKY_SETTLE.k && E._skySettleBudget(4, true, 0) === 4 && E._skySettleBudget(4, false, 10) === 4, 'settle budget: only standing still with tiles waiting');
  ok(E._SKY_SETTLE.k > 1 && E._SKY_SETTLE.k <= 2, 'settle raises the budget by at most 2x (still a time budget)');
  const hz = E._skyHorizonReach(R, eye), gR = E._skyGroundR(1200, hz, Math.max(3500, hz));
  const k0 = E._SKY_SETTLE.k;
  const S = settle(gR, 6); E._SKY_SETTLE.k = 1; const N = settle(gR, 6); E._SKY_SETTLE.k = k0;
  console.log('  settle: still ' + N.fr + ' -> ' + S.fr + ' frames to fill (6 ms tiles, 4 ms budget, ' + (N.fr / 13).toFixed(0) + ' -> ' + (S.fr / 13).toFixed(0) + ' s at 13 fps)');
  ok(S.past === 0, 'settled frames never start a build past the settle budget (but the one emergency)');
  ok(S.settled > 0 && S.fr < N.fr * 0.8, 'standing still on a 13 fps tablet (6 ms tiles, 4 ms budget): ' + N.fr + ' frames (' + (N.fr / 13).toFixed(0) + ' s) -> ' + S.fr + ' frames (' + (S.fr / 13).toFixed(0) + ' s)');
  const W = settle(gR, 6, { walk: true, cam: new V3(cliff.x, eye, cliff.z), max: 300 });
  ok(W.settled === 0, 'walking: never settled (normal budget)');
  const up = cut('SkyGround.prototype.update=function', 'SkyGround.prototype._rootKeep=');
  ok(!/new\s+(Set|Map|Array|THREE)/.test(up) && !/=>/.test(up), 'update(): still no per-frame allocation or closure');
  ok(/this\._anc=new THREE\.Vector3\(/.test(cut('function SkyGround(scene,F,pal,o){', 'const _SKY_FADE0')), 'the settle anchor is allocated once, in the constructor');
}
// ── (6) the walkway teal polygon ──
{
  const fac = fs.readFileSync(path.join(root, 'ui', 'dm-facilities.js'), 'utf8');
  const Fm = {}; new Function('F', fac.slice(fac.indexOf('  F.POOL_LOOK ='), fac.indexOf('  function mansionInstance(T) {')))(Fm);
  ok(typeof Fm.poolTrim === 'function', 'DMFac.poolTrim exists');
  ok(/F\.poolLook\(o\.material\)[^\n]*\n[^\n]*ah_pool' && o\.geometry\)[^\n]*F\.poolTrim\(g\.attributes\.position, g\.index \? g\.index\.array : null\); if \(k\) g\.setIndex\(k\)/.test(fac), 'loadMansion trims every ah_pool geometry as the GLB arrives (before any clone / impostor)');
  const glb = f => { const b = fs.readFileSync(f), jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), bin = b.slice(20 + jl + 8); return { J, bin }; };
  const rd = (G, ai) => { const J = G.J, a = J.accessors[ai], bv = J.bufferViews[a.bufferView], off = (bv.byteOffset || 0) + (a.byteOffset || 0), sz = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType], c = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type], st = bv.byteStride || sz * c, out = [];
    for (let i = 0; i < a.count; i++) for (let k = 0; k < c; k++) { const o = off + i * st + k * sz; out.push(a.componentType === 5126 ? G.bin.readFloatLE(o) : a.componentType === 5125 ? G.bin.readUInt32LE(o) : a.componentType === 5123 ? G.bin.readUInt16LE(o) : G.bin.readUInt8(o)); } return out; };
  const dir = path.join(root, 'assets', 'ariel-home');
  for (const g of fs.readdirSync(dir).filter(f => /\.glb$/.test(f))) {
    const G = glb(path.join(dir, g));
    G.J.materials.forEach(m => { const p = m.pbrMetallicRoughness || {}, c = p.baseColorFactor || [1, 1, 1, 1], e = m.emissiveFactor || [0, 0, 0];
      const cyan = (c[1] > 0.3 && c[2] > 0.3 && c[0] < c[1] * 0.6) || (e[1] > 0.2 && e[2] > 0.2 && e[0] < e[1] * 0.6);
      ok(!cyan || m.name === 'ah_pool', g + ': ' + m.name + ' is not a cyan material (only ah_pool is, and it is trimmed / re-lit)'); });
    let pools = 0;
    G.J.meshes.forEach(me => me.primitives.forEach(p => { if (!G.J.materials[p.material] || G.J.materials[p.material].name !== 'ah_pool') return; pools++;
      const P = rd(G, p.attributes.POSITION), I = p.indices != null ? rd(G, p.indices) : null, keep = Fm.poolTrim(P, I);
      ok(Array.isArray(keep) && keep.length === (I ? I.length : P.length / 3) - 6, g + ' ' + me.name + ': poolTrim drops exactly the deck quad (2 triangles)');
      let deck = 0, sea = 0; for (let t = 0; t < keep.length; t += 3) { const ys = [0, 1, 2].map(k => P[keep[t + k] * 3 + 1]); if (ys.every(y => y > -5)) deck++; if (ys.every(y => y < -18)) sea++; }
      ok(deck === 0 && sea === 2, g + ' ' + me.name + ': no deck-level pool triangle left, the sea-terrace pool kept (' + sea + ')');
      const dropped = []; const ks = new Set(); for (let t = 0; t < keep.length; t += 3) ks.add(keep.slice(t, t + 3).join(','));
      const all = I || P.map((_, i) => i).filter(i => i < P.length / 3);
      for (let t = 0; t < all.length; t += 3) if (!ks.has([all[t], all[t + 1], all[t + 2]].join(','))) for (let k = 0; k < 3; k++) dropped.push(all[t + k]);
      const xs = dropped.map(i => P[i * 3]), zs = dropped.map(i => P[i * 3 + 2]);
      ok(Math.min(...xs) > 46 && Math.max(...xs) < 77 && Math.min(...zs) > -32 && Math.max(...zs) < -7, g + ': the dropped quad is the one by the seaward rail of the HOME deck (x 46.8..76.7, z -31.2..-7.8)'); }));
    if (G.J.materials.some(m => m.name === 'ah_pool')) ok(pools === 2, g + ': ah_pool in both LODs (' + pools + ')');
  }
  ok(Fm.poolTrim(null, null) === null && Fm.poolTrim([0, -20, 0, 1, -20, 0, 0, -20, 1], null) === null, 'nothing to drop: geometry left as it is');
}
console.log(fails ? fails + ' FAILED of ' + n : 'fov-fill OK (' + n + ' checks)');
process.exit(fails ? 1 : 0);
