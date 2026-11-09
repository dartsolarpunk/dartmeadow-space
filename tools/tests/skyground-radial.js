// node tools/tests/skyground-radial.js — Wave 2a: the sky ground's far edge is a CIRCLE and the distant ground stays complete.
// Runs the REAL SkyGround code extracted from index.html (same slices as terrain-lod.js / skyground-budget.js).
//  (1) _skyGroundFade (the CPU mirror of the per-pixel dither in SkyGround._radialFade): 1 inside 0.82 x viewR, 0 at viewR, smooth and a
//      function of the true distance only (radial: no tile / axis term).
//  (2) completeness: every ground point the fade keeps (distance < viewR, not just 0.9 x viewR) lies under exactly one visible tile after
//      a full build, flat and on the planet frame, from 2 m to 12 km up.  So dissolving at the circle never shows a hole: the square
//      stair-step outline of the tile set lies wholly in the dissolved band or beyond it.
//  (3) merging back: children stay drawn until the parent has a mesh again (a tile whose mesh was invalidated no longer leaves a hole).
//  (4) the coarse sea: tiles of step >= COARSE paint the sea only where the NATURAL ground (TERRAIN.Hw = F.H0, no mansion-box carve) is
//      below sea level, at the sea floor clamped to 40 m (not a 2 m shoal), with a flat normal; finer tiles keep the real seabed.
//  (5) source: maskNode wired with a uniform circle updated in update() (no allocation), COARSE 16, polar-ice removal untouched.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const TL = require(path.join(root, 'ui', 'dm-terrain-lod.js'));
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const cut = (a, b, from) => { const i = html.indexOf(a, from || 0); if (i < 0) throw new Error('marker not found: ' + a); const j = b ? html.indexOf(b, i + a.length) : i; if (b && j < 0) throw new Error('end marker not found: ' + b); return html.slice(i, b ? j : undefined); };

// ── real source slices ─────────────────────────────────────────────────────────────────────────────
const srcNoise = cut('function _vnoise(x,y,seed){', '// Texel generation is pure arithmetic');
const srcD = cut('const ATMO_DEG_PER_UNIT=0.008;', '// One map per planet') + cut('function _siteWorldXZ(site){', 'const LAND_PICK_RANGE');
const srcCore = cut('function _terrainCore(x,z,seed,_ws){', '// ── Shoreline water');
const srcField = cut('function _groundField(body,site,pal){', '// ── The planet\'s ground, level of detail, pole to pole');
const srcPWF = cut('const PWF={u:null', 'function _pwfReady()') + cut('function _pwfMap(x,y,z,out){', '// the planet\'s centre in the drawn frame') + cut('function _pwfCentre(out){', '\n') + '\n';
const srcSky = cut('function SkyGround(scene,F,pal,o){', 'SkyGround.prototype.dispose=') + 'SkyGround.prototype.dispose=function(){ this._drop([...this.roots.values()]); this.roots.clear(); if(this.group.parent) this.group.parent.remove(this.group); };\n';

// ── tiny THREE ─────────────────────────────────────────────────────────────────────────────────────
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } clone() { return new V3(this.x, this.y, this.z); }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; } add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; } dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  length() { return Math.hypot(this.x, this.y, this.z); } distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); } }
class Col { constructor() { this.r = 0; this.g = 0; this.b = 0; } copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; } lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; } multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; } }
class Attr { constructor(a, s) { this.array = a; this.itemSize = s; this.needsUpdate = false; } }
class Geo { constructor() { this.attributes = {}; this.index = null; } setAttribute(k, a) { this.attributes[k] = a; } setIndex(a) { this.index = a; } computeBoundingSphere() { } dispose() { } }
class Mesh { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V3(); this.visible = true; this.userData = {}; } }
class Grp { constructor() { this.children = []; this.parent = null; this.name = ''; } add(o) { this.children.push(o); o.parent = this; } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; } }
const THREE = { Vector3: V3, Color: Col, BufferAttribute: Attr, Uint16BufferAttribute: Attr, BufferGeometry: Geo, Mesh, Group: Grp, Frustum: class { }, Matrix4: class { }, Sphere: class { constructor() { this.center = new V3(); this.radius = 0; } } };

const f = new Function('THREE', 'window', 'DMTerrainLod', `
  const GFX = { isMobile: false, shadows: false };
  ${srcNoise}
  ${srcD}
  ${srcPWF}
  let PW = { site: null };
  const TERRAIN = { style: 'lush' }, _worldSeed = () => 311; window.__T = TERRAIN;
  const _terrainDetailMat = () => ({}); const _sbcIsEarth = () => false;
  const _smooth01 = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  let surfaceBiomeColor = (x, z, h, slope, pal, seed, opts) => { const c = new THREE.Color(); c.r = h; c.g = slope; c.b = 0; return c; };
  const _seaIceC = () => new THREE.Color();
  const DMEarthIce = null;
  ${srcCore}
  ${srcField}
  ${srcSky}
  return { _terrainCore, _groundField, SkyGround, PWF, _pwfMap, _siteWorldXZ, D: ATMO_DEG_PER_UNIT, setSite: s => { PW.site = s; }, PW, _fbm, setPWF: (fx, fz, site) => { const lat = Math.max(-89.9, Math.min(89.9, site.lat - fz * ATMO_DEG_PER_UNIT)) * Math.PI / 180; PWF.fx = fx; PWF.fz = fz; PWF.lat = lat; PWF.sl = Math.sin(lat); PWF.cl = Math.cos(lat); PWF.g = 1; PWF.on = 1; PWF.R = 360 / ATMO_DEG_PER_UNIT / (2 * Math.PI); }, flat: () => { PWF.on = 0; }, _skyGroundFade, _SKY_FADE0, TERRAIN };
`);

const E = f(THREE, {}, TL);
const D = E.D, WX = 360 / D;
const pal = { water: true, liquidColor: 0x1a4a7a, ground: 0x3a7d34 };
const SITES = [{ lat: 18, lon: 40 }, { lat: -22, lon: 120 }];
const body = { name: 'Solenne', type: 'Habitable', home: true };

// ── (1) the fade ──
{
  const R = 5000;
  ok(E._SKY_FADE0 > 0.5 && E._SKY_FADE0 < 0.95, 'fade starts at ' + E._SKY_FADE0 + ' x viewR');
  ok(E._skyGroundFade(0, R) === 1 && E._skyGroundFade(R * E._SKY_FADE0, R) === 1, 'solid inside the fade start');
  ok(E._skyGroundFade(R, R) === 0 && E._skyGroundFade(R * 1.3, R) === 0, 'gone at and past viewR');
  let mono = true, prev = 1; for (let d = 0; d <= R * 1.1; d += R / 500) { const v = E._skyGroundFade(d, R); if (v > prev + 1e-12) mono = false; prev = v; }
  ok(mono, 'monotone with distance');
  // radial: the same at the same distance in every direction (it takes only a distance) — and a tile's corner is not special
  const v1 = E._skyGroundFade(R * 0.9, R); ok(v1 > 0 && v1 < 1, 'in the band it dissolves partly (' + v1.toFixed(3) + ')');
  ok(E._skyGroundFade.length === 2, 'fade is a function of (distance, viewR) only');
}

// ── (2) completeness up to the circle ──
function fullBuild(site, cam, viewR, frame) {
  E.setSite(site); const F = E._groundField(body, site, pal);
  E.setPWF(cam.x, cam.z, site); if (frame !== 'planet') E.flat();
  const G = new E.SkyGround(new Grp(), F, pal, { budget: 1e9 }); G.viewR = viewR;
  const c = { position: new V3(cam.x, cam.y, cam.z) };
  if (frame === 'planet') E._pwfMap(cam.x, cam.y, cam.z, c.position);
  let guard = 0; while (G.update(c, 1e9) > 0 && guard++ < 12);
  G.update(c, 1e9);
  return { G, F, c };
}
function visibleTiles(G) { const out = []; const walk = n => { if (n.mesh && n.mesh.visible) out.push(n); if (n.kids) n.kids.forEach(walk); }; for (const r of G.roots.values()) walk(r); return out; }
function covered(tiles, x, z) { let k = 0; for (const t of tiles) if (x >= t.x0 && x <= t.x0 + t.size && z >= t.z0 && z <= t.z0 + t.size) k++; return k; }
{
  let holes = 0, samples = 0, band = 0, beyond = 0;
  for (const site of SITES) for (const frame of ['flat', 'planet']) for (const [alt, vr] of [[2, 1200], [60, 2800], [500, 4700], [3000, 9000], [12000, 30000]]) {
    const { G, c } = fullBuild(site, { x: 0, y: alt, z: 0 }, vr, frame);
    const tiles = visibleTiles(G);
    for (let i = 0; i < 2400; i++) {
      const a = i * 2.399963, r = vr * 0.999 * Math.sqrt((i + 0.5) / 2400), x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) > 3 * (180 / 4 / D)) continue;
      if (z < (site.lat - 90) / D + 1 || z > (site.lat + 90) / D - 1) continue;
      let d = r;
      if (frame === 'planet') {
        const p = E._pwfMap(x, 0, z, new V3()), C = new V3(E.PWF.fx, -E.PWF.R, E.PWF.fz), cv = c.position.clone().sub(C), pv = p.clone().sub(C);
        d = p.distanceTo(c.position);
        if (Math.acos(Math.min(1, cv.dot(pv) / (cv.length() * pv.length()))) > Math.acos(E.PWF.R / cv.length()) - 0.02) continue;
      } else d = Math.hypot(x, alt, z);
      if (E._skyGroundFade(d, vr) <= 0) { beyond++; continue; }   // dissolved: nothing to cover
      samples++; if (d > vr * E._SKY_FADE0) band++;
      if (covered(tiles, x, z) === 0) { holes++; if (holes < 5) console.log('  hole', frame, alt, vr, x.toFixed(0), z.toFixed(0), 'd', d.toFixed(0)); }
    }
    G.dispose();
  }
  ok(samples > 10000 && band > 1000, 'sampled ' + samples + ' kept points (' + band + ' in the dissolve band, ' + beyond + ' past it)');
  ok(holes === 0, 'every point the radial fade keeps is under a visible tile (' + holes + ' holes)');
}

// ── (3) merging back keeps the children until the parent can stand in ──
{
  const site = SITES[0]; const { G, c } = fullBuild(site, { x: 0, y: 60, z: 0 }, 2800, 'flat');
  // the root column under the camera and its deepest split chain
  let n = null; for (const r of G.roots.values()) if (r.kids && 0 >= r.x0 && 0 < r.x0 + r.size && 0 >= r.z0 && 0 < r.z0 + r.size) n = r;
  ok(!!n && !!n.kids, 'found a split tile under the camera');
  // invalidate its mesh (what _dmGroundDirty does), then fly far up so it no longer splits; give the frame no budget at all
  G.group.remove(n.mesh); n.mesh = null;
  const far = { position: new V3(0, 2e5, 0) }; G.viewR = 1e9;
  const kidsBefore = n.kids; G.update(far, 0);
  ok(n.kids === kidsBefore, 'children kept while the parent has no mesh');
  const vis = visibleTiles(G); const under = vis.filter(t => 0 >= t.x0 && 0 <= t.x0 + t.size && 0 >= t.z0 && 0 <= t.z0 + t.size);
  ok(under.length >= 1, 'the ground under the camera is still drawn (' + under.length + ' tile)');
  let g = 0; while (G.update(far, 1e9) > 0 && g++ < 8); G.update(far, 1e9);
  ok(!!n.mesh && !n.kids, 'once the parent is rebuilt the children are let go');
  G.dispose();
}

// ── (4) the coarse sea reads the natural ground ──
{
  const site = SITES[1]; E.setSite(site); E.flat(); const F = E._groundField(body, site, pal);
  const G = new E.SkyGround(new Grp(), F, pal, { budget: 1e9 });
  ok(G.COARSE === 16, 'COARSE 16 (sea painted from 703-unit tiles out)');
  // find a stretch of deep sea and of land near the origin
  let sea = null, land = null; for (let i = 0; i < 40000 && !(sea && land); i++) { const x = (i % 200) * 211 - 21000, z = Math.floor(i / 200) * 211 - 21000, h = F.H(x, z); if (!sea && h < -5 && F.H(x + 300, z + 300) < -2 && F.H(x - 300, z - 300) < -2) sea = [x, z]; if (h > 30 && !land) land = [x, z]; }
  ok(!!sea && !!land, 'found sea and land');
  const tile = (x0, z0, size) => { const nn = G._node(x0, z0, size, null); G._build(nn); return nn; };
  const S1 = G.SEG + 1;
  const check = (nn, paint) => {
    const P = nn.mesh.geometry.attributes.position.array, N = nn.mesh.geometry.attributes.normal.array, step = nn.size / G.SEG; let bad = 0, wet = 0;
    for (let r = 0; r < S1; r++) for (let q = 0; q < S1; q++) {
      const k = r * S1 + q, x = nn.x0 + q * step, z = nn.z0 + r * step, h0 = (F.H0 || F.H)(x, z), y = P[k * 3 + 1];
      const flat = N[k * 3] === 0 && N[k * 3 + 2] === 0;
      if (paint && h0 < 0) { wet++; if (Math.abs(y - Math.max(F.H(x, z), -40)) > 1e-6 || !flat) bad++; }
      else if (Math.abs(y - F.H(x, z)) > 1e-6) bad++;
    }
    return { bad, wet };
  };
  // coarse (step 22) tile over the sea: painted at max(h, -40), flat; fine (step 11) tile: the real seabed
  const c1 = check(tile(sea[0] - 351, sea[1] - 351, 703.125), true); ok(c1.wet > 20 && c1.bad === 0, 'step-22 tile paints the sea at the floor clamped to 40 m (' + c1.wet + ' wet verts, ' + c1.bad + ' wrong)');
  const n2 = G._node(sea[0] - 175, sea[1] - 175, 351.5625, null); n2.parent = null; G._build(n2);
  const c2 = check(n2, false); ok(c2.bad === 0, 'step-11 tile keeps the real seabed (under the sea sheet) (' + c2.bad + ' wrong)');
  // a carve: the drawn ground is sunk below the sea in a box on LAND; the natural ground is not -> no sea painted there
  const H0 = F.H; F.H0 = H0; const bx = land[0], bz = land[1];
  const inBox = (x, z) => Math.abs(x - bx) < 400 && Math.abs(z - bz) < 400;
  F.H = (x, z) => inBox(x, z) ? -150 : H0(x, z);
  E.TERRAIN.exBox = inBox;
  const nn = tile(bx - 351, bz - 351, 703.125); const P = nn.mesh.geometry.attributes.position.array, step = nn.size / G.SEG; let painted = 0, inside = 0;
  for (let r = 0; r < S1; r++) for (let q = 0; q < S1; q++) { const x = nn.x0 + q * step, z = nn.z0 + r * step; if (inBox(x, z) && H0(x, z) >= 0) { inside++; if (Math.abs(P[(r * S1 + q) * 3 + 1] - (-40)) < 1e-6) painted++; } }
  ok(inside > 100 && painted === 0, 'mansion-box carve below sea level is NOT painted as sea (' + painted + ' of ' + inside + ')');
  E.TERRAIN.exBox = null; F.H = H0; delete F.H0;
}

// ── (5) source ──
{
  const sky = html.slice(html.indexOf('function SkyGround(scene,F,pal,o){'), html.indexOf('SkyGround.prototype.dispose='));
  ok(/m\.maskNode=m\.maskNode\?m\.maskNode\.and\(keep\):keep;/.test(sky), 'the dissolve is AND-ed into the ground material\'s existing mask (planet reveal kept)');
  ok(/W\.interleavedGradientNoise\(W\.screenCoordinate\.xy\)\.lessThan\(k\)/.test(sky), 'screen-door dither (no blending, no new discard path)');
  const up = sky.slice(sky.indexOf('SkyGround.prototype.update=function'), sky.indexOf('SkyGround.prototype._rootKeep='));
  ok(/this\._fadeU\.a\.value=this\.viewR\*_SKY_FADE0; this\._fadeU\.b\.value=this\.viewR;/.test(up), 'update() moves the circle with viewR by writing uniform values');
  ok(!/new [A-Z]|\[\]|\{\}|=>/.test(up.replace(/\/\/[^\n]*/g, '')), 'update() still allocates nothing per frame');
  ok(!/TERRAIN\.exBox=/.test(sky), 'SkyGround only reads TERRAIN.exBox');
  ok(!/snowDrop|dm-earth-ice|DMEarthIce\./.test(sky), 'no polar ice back in the sky ground');
  ok(/const ATMO_DEFAULT_AGL=46/.test(html), 'ATMO_DEFAULT_AGL 46');
}
console.log((fails ? 'FAILED ' + fails + ' of ' : 'skyground-radial OK (') + n + ' checks' + (fails ? '' : ')'));
process.exit(fails ? 1 : 0);
