// node tools/tests/terrain-lod.js — ONE terrain across every altitude band (Solenne / any seeded world).
// Runs the REAL code extracted from index.html (no copies): _vnoise/_fbm, _terrainCore, _siteWorldXZ, _groundField, the planet frame (_pwfMap) and the whole SkyGround quadtree.
//  (1) one function: the whole-planet map's height (orbit globe), the sky-ground tile vertices (near space .. high atmosphere) and the walking field are the same number at the same lat/lon,
//      from any site (translation invariant), across the +-180 wrap and at the poles.
//  (2) tile coverage: for cameras from 2 m to 12 km up, flat and on the planet frame, every ground point inside the drawn radius lies under exactly one visible tile
//      (no hole, no parent+child double layer) after the quadtree has been fully built; and the 8 x 4 roots cover lon -180..180, lat 90..-90 for any focus.
//  (3) cracks: where a coarse tile meets a finer one the finer edge deviates from the coarse edge's straight line; the skirt must be deeper than that deviation (checked on the
//      real terrain over thousands of edges, all LOD pairs the quadtree can produce).
//  (4) colour / slope contract: the globe map and the sky-ground colour the same terrain with the same slope definition (DMTerrainLod.groundSlope) and biome function.
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
  const TERRAIN = { style: 'lush' }, _worldSeed = () => 311;
  const _terrainDetailMat = () => ({}); const _sbcIsEarth = () => false;
  const _smooth01 = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  let surfaceBiomeColor = (x, z, h, slope, pal, seed, opts) => { const c = new THREE.Color(); c.r = h; c.g = slope; c.b = 0; return c; };
  const _seaIceC = () => new THREE.Color();
  const DMEarthIce = null;
  ${srcCore}
  ${srcField}
  ${srcSky}
  return { _terrainCore, _groundField, SkyGround, PWF, _pwfMap, _siteWorldXZ, D: ATMO_DEG_PER_UNIT, setSite: s => { PW.site = s; }, PW, _fbm, setPWF: (fx, fz, site) => { const lat = Math.max(-89.9, Math.min(89.9, site.lat - fz * ATMO_DEG_PER_UNIT)) * Math.PI / 180; PWF.fx = fx; PWF.fz = fz; PWF.lat = lat; PWF.sl = Math.sin(lat); PWF.cl = Math.cos(lat); PWF.g = 1; PWF.on = 1; PWF.R = 360 / ATMO_DEG_PER_UNIT / (2 * Math.PI); }, flat: () => { PWF.on = 0; } };
`);
const E = f(THREE, {}, TL);
const D = E.D, WX = 360 / D;
const pal = { water: true, liquidColor: 0x1a4a7a, ground: 0x3a7d34 };
const SITES = [{ lat: 18, lon: 40 }, { lat: -22, lon: 120 }, { lat: 0, lon: 179.9 }, { lat: 60, lon: -170 }, { lat: -85, lon: 10 }];   // the mansion, the ocean city, the date line, high north, near the south pole
const body = { name: 'Solenne', type: 'Habitable', home: true };

// ── (1) one function ───────────────────────────────────────────────────────────────────────────────
{
  const seed = 311;
  const worldH = (lat, lon) => E._terrainCore(lon / D, -lat / D, seed, 'lush');   // exactly what worldMapFor.heightAt does for a lush world
  ok(/_terrainCore\(lon\/D,-lat\/D,seed,ws\)/.test(html), 'worldMapFor.heightAt still evaluates _terrainCore(lon/D,-lat/D,seed,ws) (the same function as the ground)');
  let maxd = 0, cnt = 0;
  for (const site of SITES) {
    const F = E._groundField(body, site, pal), sw = F.sw;
    ok(Math.abs(sw.x - site.lon / D) < 1e-9 && Math.abs(sw.z + site.lat / D) < 1e-9, 'site -> world xz');
    for (let i = 0; i < 400; i++) {
      const lat = Math.max(-89.8, Math.min(89.8, -90 + 180 * ((i * 0.6180339887) % 1))), lon = -180 + 360 * ((i * 0.7548776662 + 0.1) % 1);
      const lx = lon / D - sw.x, lz = -lat / D - sw.z;                 // that lat/lon in this site's flat frame
      const a = worldH(lat, lon), b = F.H(lx, lz);
      maxd = Math.max(maxd, Math.abs(a - b)); cnt++;
      // wrap: the same point one revolution east / west is the same height
      const c = F.H(lx + WX, lz), c2 = F.H(lx - WX, lz); maxd = Math.max(maxd, Math.abs(a - c), Math.abs(a - c2));
    }
  }
  ok(maxd < 1e-6, 'map height == ground height from every site, across the wrap (max diff ' + maxd + ' over ' + cnt + ' points)');
  // poles: the ground stops at 89.9 deg, the map's last row is at 89.77 (768 x 384) - both inside the clamp, so the same function again
  const F = E._groundField(body, SITES[0], pal);
  ok(Math.abs(F.H(0, (-89.95 / D) - F.sw.z) - F.H(0, (-89.9 / D) - F.sw.z)) < 1e-9, 'beyond the pole clamp the ground is flat (no void past 89.9)');
  ok(isFinite(F.H(1e6, 1e6)) && isFinite(F.H(-1e6, -1e6)), 'finite far outside any generated region');
  // continuity of the field itself (no hole / step where the old "generated region" would end): max step per metre over a long line
  let worst = 0; for (let x = -30000; x < 30000; x += 3) worst = Math.max(worst, Math.abs(F.H(x + 3, 500) - F.H(x, 500)) / 3);
  ok(worst < 6, 'terrain has no cliff-wall discontinuity along a 60 km line (steepest ' + worst.toFixed(2) + ' m/m)');
}

// ── (2) tile coverage ──────────────────────────────────────────────────────────────────────────────
function fullBuild(site, cam, viewR, frame) {
  E.setSite(site); const F = E._groundField(body, site, pal);
  const fx = cam.x, fz = cam.z; E.setPWF(fx, fz, site); if (frame !== 'planet') E.flat();
  const G = new E.SkyGround(new Grp(), F, pal, { budget: 1e9 }); G.viewR = viewR;
  const c = { position: new V3(cam.x, cam.y, cam.z) };
  // the camera lives in the DRAWN frame
  if (frame === 'planet') E._pwfMap(cam.x, cam.y, cam.z, c.position);
  let guard = 0; while (G.update(c, 1e9) > 0 && guard++ < 12);
  G.update(c, 1e9);
  return { G, F, c };
}
function visibleTiles(G) { const out = []; const walk = n => { if (n.mesh && n.mesh.visible) out.push(n); if (n.kids) n.kids.forEach(walk); }; for (const r of G.roots.values()) walk(r); return out; }
function covered(tiles, x, z) { let k = 0; for (const t of tiles) if (x >= t.x0 && x <= t.x0 + t.size && z >= t.z0 && z <= t.z0 + t.size) k++; return k; }
{
  const site = SITES[0];
  // roots: any focus, 8 x 4 columns/rows cover the whole sphere exactly once
  for (const fx of [0, 1234.5, -20000, 22500, 51234]) {
    E.setSite(site); E.flat(); const F = E._groundField(body, site, pal); E.setPWF(fx, 0, site);
    const G = new E.SkyGround(new Grp(), F, pal, {}); E.PWF.fx = fx; G.update({ position: new V3(fx, 1e5, 0) }, 0);
    const keys = [...G.roots.values()]; ok(keys.length === 32, 'roots: 8 x 4 = 32 (' + keys.length + ')');
    const xs = keys.map(r => r.x0).sort((a, b) => a - b), zs = [...new Set(keys.map(r => r.z0))].sort((a, b) => a - b);
    const span = xs[xs.length - 1] + keys[0].size - xs[0]; ok(Math.abs(span - WX) < 1e-6, 'roots span exactly 360 deg of longitude (' + span + ' vs ' + WX + ')');
    ok(Math.abs(zs[0] - (site.lat - 90) / D) < 1e-6 && Math.abs(zs[3] + keys[0].size - (site.lat + 90) / D) < 1e-6, 'roots span lat 90..-90');
    const uniq = new Set(xs.map(x => x.toFixed(4))); ok(uniq.size === 8, 'no duplicate root columns');
  }
  const cases = [];
  for (const frame of ['flat', 'planet']) for (const [alt, vr] of [[2, 1200], [60, 2800], [500, 4700], [3000, 9000], [12000, 30000]]) cases.push({ frame, alt, vr });
  let holes = 0, doubles = 0, samples = 0, tilesN = 0;
  for (const cs of cases) {
    const { G, c } = fullBuild(site, { x: 0, y: cs.alt, z: 0 }, cs.vr, cs.frame);
    const tiles = visibleTiles(G); tilesN += tiles.length; if (process.env.DBG) { const sz = {}; tiles.forEach(t => sz[Math.round(t.size)] = (sz[Math.round(t.size)] || 0) + 1); console.log(cs.frame, cs.alt, JSON.stringify(sz), "origin tile:", tiles.filter(t => 0 >= t.x0 && 0 <= t.x0 + t.size && 0 >= t.z0 && 0 <= t.z0 + t.size).map(t => [t.size, t.x0, t.z0].join("/"))); }
    // sample points on rings around the focus, inside 0.9 x the drawn radius (flat frame coordinates ~ planet frame ones to first order)
    for (let i = 0; i < 1500; i++) {
      const a = i * 2.399963, r = cs.vr * 0.9 * Math.sqrt((i + 0.5) / 1500), x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) > 3 * (180 / 4 / D)) continue;   // the roots keep >= 3 columns (135 deg) either side of the focus: past that is beyond any horizon
      if (z < (site.lat - 90) / D + 1 || z > (site.lat + 90) / D - 1) continue;   // past a pole: not part of the world
      if (cs.frame === 'planet') {   // only what the camera can see: inside the drawn radius (true 3-D distance) and above the sea-level horizon
        const p = E._pwfMap(x, 0, z, new V3()), C = new V3(E.PWF.fx, -E.PWF.R, E.PWF.fz), cv = c.position.clone().sub(C), pv = p.clone().sub(C);
        if (p.distanceTo(c.position) > cs.vr * 0.9 || Math.acos(Math.min(1, cv.dot(pv) / (cv.length() * pv.length()))) > Math.acos(E.PWF.R / cv.length()) - 0.02) continue;
      }
      const k = covered(tiles, x, z); samples++;
      if (k === 0) { holes++; if (holes < 3 && process.env.DBG) { const w = (n, d) => { const o = [n.size.toFixed(0) + '@' + n.x0.toFixed(0) + ',' + n.z0.toFixed(0) + ' d=' + (n._d | 0) + ' vis=' + n._vis + ' hid=' + n._hidden + ' mesh=' + !!n.mesh + ' vm=' + (n.mesh && n.mesh.visible)]; (n.kids || []).forEach(k => { if (x >= k.x0 && x <= k.x0 + k.size && z >= k.z0 && z <= k.z0 + k.size) o.push(...w(k)); }); return o; }; for (const r of G.roots.values()) if (x >= r.x0 && x <= r.x0 + r.size && z >= r.z0 && z <= r.z0 + r.size) console.log(w(r).join(' | ')); }
      if (holes < 6) console.log('  hole', cs.frame, 'alt', cs.alt, 'viewR', cs.vr, 'at', x.toFixed(0), z.toFixed(0), 'r', r.toFixed(0)); }
      // a point on a shared tile edge may count 2 (inclusive bounds): only interior doubles count
      else if (k > 1) { const interior = tiles.filter(t => x > t.x0 + 1e-6 && x < t.x0 + t.size - 1e-6 && z > t.z0 + 1e-6 && z < t.z0 + t.size - 1e-6).length; if (interior > 1) doubles++; }
    }
    G.dispose();
  }
  ok(holes === 0, 'no uncovered ground inside the drawn radius (' + holes + ' holes of ' + samples + ' samples, ' + tilesN + ' tiles)');
  ok(doubles === 0, 'no parent + child drawn on the same ground (' + doubles + ')');
}

// ── (3) cracks between LOD levels ──────────────────────────────────────────────────────────────────
{
  // A tile of size S has step S/32 and hangs its skirt max(4, 2 x step) below its edge.  Its finer neighbour (S/2, step/2) puts a vertex in the middle of every coarse edge segment;
  // the coarse tile's edge is the straight line between its vertices, so the opening between the two is |H(mid) - (H(a)+H(b))/2|.  The skirt of EITHER tile must reach across it.
  const site = SITES[0], F = E._groundField(body, site, pal), H = F.H;
  const TOP = 180 / 4 / D, SEG = 32; let worstRatio = 0, edges = 0, bad = 0, worst = null;
  for (let lvl = 0; lvl <= 7; lvl++) {
    const S = TOP / Math.pow(2, lvl), st = S / SEG;
    for (let i = 0; i < 700; i++) {
      const x = -180 / D - F.sw.x + (i * 0.6180339887 % 1) * WX, z = -88 / D - F.sw.z + (i * 0.7548776662 % 1) * (176 / D);
      const a = H(x, z), b = H(x + st, z), m = H(x + st / 2, z);   // one coarse segment, along x
      const a2 = H(x, z + st), m2 = H(x, z + st / 2);
      for (const dev of [Math.abs(m - (a + b) / 2), Math.abs(m2 - (a + a2) / 2)]) {
        edges++;
        const drop = TL.skirtDrop(st), dropF = TL.skirtDrop(st / 2);
        const ratio = dev / Math.max(drop, dropF); if (ratio > worstRatio) { worstRatio = ratio; worst = { lvl, st, dev, drop }; }
        if (dev > Math.max(drop, dropF)) bad++;
      }
    }
  }
  ok(bad === 0, 'every LOD crack is shallower than the skirt (' + bad + ' of ' + edges + ' edges; worst ratio ' + worstRatio.toFixed(3) + ' ' + JSON.stringify(worst) + ')');
  ok(/const drop=Math\.max\(4,step\*2\)/.test(html) || /const drop=\(window\.DMTerrainLod/.test(html), 'SkyGround skirt drop line is the audited one');
}

// ── (4) the shared slope / colour contract ─────────────────────────────────────────────────────────
{
  // the sky-ground normal is (h[-1]-h[+1], 2 step, ...) and its slope is (1 - ny) x 1.6; the map must use the same definition at its own cell size
  const step = 58.6;
  for (const [hx, hz] of [[0, 0], [5, 0], [20, -10], [100, 80], [400, 300], [-60, 220]]) {
    let nx = hx, ny = 2 * step, nz = hz; const L = Math.hypot(nx, ny, nz); ny /= L;
    const ref = Math.min(1, Math.max(0, 1 - ny) * 1.6);
    ok(Math.abs(TL.groundSlope(hx, hz, step) - ref) < 1e-12, 'groundSlope == the sky-ground (1-ny)*1.6 at ' + hx + ',' + hz);
  }
  ok(/\(1-ny\)\*1\.6/.test(html) || /Math\.max\(0,1-ny\)\*1\.6/.test(html), 'surfaceBiomeColor callers still pass (1-ny)*1.6');
  // the old map definition (tan x 1.5) says "rock" on a 12 degree hillside that the ground paints as grass: guard the gap this module closes
  const hx = 2 * 58.6 * Math.tan(12 * Math.PI / 180), oldMap = Math.min(1, Math.hypot(hx / (2 * 58.6), 0) * 1.5), now = TL.groundSlope(hx, 0, 58.6);
  ok(oldMap > 0.3 && now < 0.1, 'a 12 degree slope: old map slope ' + oldMap.toFixed(2) + ' vs ground ' + now.toFixed(3));
  ok(/DMTerrainLod/.test(html), 'index.html uses DMTerrainLod');
  ok(/dm-terrain-lod\.js/.test(html), 'index.html loads ui/dm-terrain-lod.js');
}
console.log((fails ? 'FAILED ' + fails + ' of ' : 'ok — ') + n + ' checks');
process.exit(fails ? 1 : 0);
