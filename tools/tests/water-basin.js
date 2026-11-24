// node tools/tests/water-basin.js — (t1644 CE-7) contour-bounded water, probe far-field fallback, PR #111 split cadence, star registry.
//  1. ui/dm-water-basin.js: oceans / lakes flood-filled from the height grid (wraps east-west), the 3x3 conservative low field, world <-> map mapping, box tests
//  2. ui/dm-water-core.js coverBoxWet / tilesWet: outside the near grid the basin answers (no more "outside = wet"); without one the old rule holds
//  3. ui/dm-light.js cascadeAvg: the far-field fallback is the window's own average (untraced columns skipped)
//  4. ui/dm-lod.js: DMLod.splitK() is 1 by default on every class (PR #111), the perf-mars scale only with ?splitk=legacy
//  5. source pins: the sheet, swim volume, world map, resume wait and star registry are wired
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL ' + m); } };
const B = require(path.join(root, 'ui', 'dm-water-basin.js'));
const D = 0.008;
// ── (1) a 64 x 32 world: one ocean that crosses the date line, one inland lake, one continent
{
  const W = 64, H = 32, h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 30;                                      // land
    if (x < 10 || x >= 56) v = -40;                  // ocean across +-180 (wraps)
    if (y === 0 || y === H - 1) v = -40;             // polar sea joins it
    if (x >= 30 && x <= 32 && y >= 14 && y <= 16) v = -5;   // a 3 x 3 lake inland
    h[y * W + x] = v;
  }
  const b = B.fromGrid(h, W, H, 0);
  ok(b.oceans === 1, 'one ocean (wraps east-west and joins the polar sea): ' + b.oceans);
  ok(b.lakes === 1, 'one enclosed lake: ' + b.lakes);
  ok(b.cls[15 * W + 31] === B.LAKE && b.cls[15 * W + 2] === B.OCEAN && b.cls[15 * W + 20] === B.LAND, 'cells classified lake / ocean / land');
  ok(b.low[15 * W + 29] < 0 && b.low[15 * W + 27] > 0, 'the low field is the 3x3 minimum: one cell of coast allowance, no more');
  // world <-> map: x = lon / D, z = -lat / D
  const lonOf = (i) => (i + 0.5) / W * 360 - 180, latOf = (j) => 90 - (j + 0.5) / H * 180;
  ok(B.wetAt(b, lonOf(2) / D, -latOf(15) / D, D, 0.5), 'mid-ocean point is wet');
  ok(!B.wetAt(b, lonOf(20) / D, -latOf(15) / D, D, 0.5), 'continent interior is dry (no water under land)');
  ok(B.wetAt(b, lonOf(31) / D, -latOf(15) / D, D, 0.5), 'the lake is wet');
  ok(B.wetAt(b, (lonOf(63) + 360) / D, -latOf(15) / D, D, 0.5), 'longitude wraps (x + 360 deg)');
  const cell = 180 / H / D;
  ok(!B.boxWet(b, lonOf(18) / D, lonOf(24) / D, -latOf(12) / D, -latOf(18) / D, D, 14), 'a box over the continent is dry');
  ok(B.boxWet(b, lonOf(26) / D, lonOf(35) / D, -latOf(12) / D, -latOf(18) / D, D, 14), 'a box that contains the lake is wet (lattice never coarser than a map cell: ' + cell.toFixed(0) + ' u)');
  // windowInto: the far cover window
  const out = new Float32Array(16 * 16); B.windowInto(b, out, 16, cell, lonOf(20) / D, -latOf(15) / D, 0, 0, D);
  ok(out.every(v => v > 0), 'a far window centred on the continent is all land');
  B.windowInto(null, out, 16, cell, 0, 0, 0, 0, D); ok(out.every(v => v === -10), 'no basin: the window is wet (the old conservative rule)');
  // site offset: local = world - site
  const sx = lonOf(20) / D, sz = -latOf(15) / D;
  ok(!B.wetAt(b, 0 + sx, 0 + sz, D) && B.wetAt(b, (lonOf(2) / D - sx) + sx, sz, D), 'site offset round-trips');
}
// ── (2) cover core with the far fallback
{
  global.window = undefined;
  const C = require(path.join(root, 'ui', 'dm-water-core.js'));
  const N = 4, cell = 100, mask = new Float32Array(N * N).fill(50);   // near grid: all high ground
  ok(C.coverBoxWet(mask, N, cell, 0, 0, 5000, 5100, 5000, 5100) === true, 'no far answer: outside the grid is wet (unchanged)');
  ok(C.coverBoxWet(mask, N, cell, 0, 0, 5000, 5100, 5000, 5100, () => false) === false, 'far answer: outside the grid follows the basin (dry)');
  ok(C.coverBoxWet(null, N, cell, 0, 0, 0, 10, 0, 10, () => false) === false, 'before the near grid exists the basin answers');
  ok(C.coverBoxWet(mask, N, cell, 0, 0, -10, 10, -10, 10, () => true) === false, 'inside the grid the exact near mask wins');
  const tiles = [{ q: 1, x0: -20, x1: 20, z0: -20, z1: 20 }, { q: 1, x0: 4000, x1: 4100, z0: 0, z1: 100 }], flags = new Uint8Array(2);
  const kept = C.tilesWet(tiles, [0, 0], mask, N, cell, 0, 0, flags, (x0) => x0 < 4050 ? false : true);
  ok(kept === 0 && flags[0] === 0 && flags[1] === 0, 'tilesWet passes the far answer: a far tile over land is dropped');
}
// ── (3) DMLight cascade average
{
  const L = require(path.join(root, 'ui', 'dm-light.js'));
  const c = L.createCascade(4, 2, 3, 2.5), out = [0, 0, 0, 0];
  ok(L.cascadeAvg(c, out) === 0, 'an untraced cascade has no average (the uniform keeps its last value)');
  for (let col = 0; col < 16; col++) { c.si[col] = 0; c.sj[col] = 0; for (let l = 0; l < 2; l++) { L.neutralProbe(c.data, (col * 2 + l) * 16); } }
  // put a uniform bounce of 0.3 (SH c0 = 0.3 / Y0) in the bottom layer and half sky visibility
  for (let col = 0; col < 16; col++) { const o = col * 2 * 16; c.data[o] = 0.5 / L.Y0; for (let k = 4; k < 16; k += 4) c.data[o + k] = 0.3 / L.Y0; }
  const m = L.cascadeAvg(c, out);
  ok(m === 16 && Math.abs(out[0] - 0.5) < 1e-6 && Math.abs(out[1] - 0.3) < 1e-6 && Math.abs(out[3] - 0.3) < 1e-6, 'average vis / bounce of the bottom layer: ' + out.map(v => v.toFixed(3)).join(','));
  const src = fs.readFileSync(path.join(root, 'ui', 'dm-light.js'), 'utf8');
  ok(/bounce = mix\(bounce, farB, wOut\)/.test(src) && /lightfar=0/.test(src), 'past the probe window the bounce fades to the window average (not 0); ?lightfar=0 A/B');
  ok(!/new [A-Z]\w*\(/.test(src.slice(src.indexOf('if (FAR_AVG && casc.length && U)'), src.indexOf('lightParams(); const day'))), 'the average refresh allocates nothing per frame');
}
// ── (4) DMLod split cadence
{
  const code = fs.readFileSync(path.join(root, 'ui', 'dm-lod.js'), 'utf8');
  const mk = (search, gfx) => { const win = { location: { search }, GFX: gfx, DMBudget: { on: true, groundReach: () => 0.6, propsK: () => 1 } }; win.window = win; const ctx = vm.createContext({ window: win, globalThis: win, self: win, console, Math, Object, Array, Set, Map, Float32Array, Uint8Array, Int32Array }); try { vm.runInContext(code, ctx); } catch (e) { } return win.DMLod; };
  for (const g of [{ isMobile: false }, { isMobile: true, score: 37 }, { isMobile: true, score: 70, deviceMem: 8 }]) {
    const L = mk('', g); if (!L) { ok(false, 'DMLod loads'); continue; } L.refresh && L.refresh();
    ok(L.splitK() === 1, 'PR #111 split cadence: splitK 1 on ' + L.tier + ' even at ladder ground reach 0.6');
    const Lg = mk('?splitk=legacy', g); Lg.refresh && Lg.refresh(); ok(Lg.splitK() <= 1 && (Lg.tier === 'desktop' ? Lg.splitK() < 1 : Lg.splitK() < 0.8), '?splitk=legacy restores the perf-mars scale (' + Lg.tier + ' ' + Lg.splitK().toFixed(2) + ')');
  }
}
// ── (5) source pins
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), wsrc = fs.readFileSync(path.join(root, 'ui', 'dm-water.js'), 'utf8'), sea = fs.readFileSync(path.join(root, 'ui', 'dm-water-sea.js'), 'utf8'), sb = fs.readFileSync(path.join(root, 'ui', 'dm-starbubble.js'), 'utf8');
  ok(/<script src="ui\/dm-water-basin\.js\?v=\d+"><\/script>/.test(html), 'dm-water-basin.js is loaded');
  ok(/DMWaterBasin\.fromGrid\(hs,W,Hh,0\); DMWaterBasin\.put\(body\.name,m\.basin\)/.test(html), 'every world-map pass publishes the world\'s basins (every seeded world)');
  ok(/DMWater\.setBasin\(body&&body\.name,F\.sw\.x,F\.sw\.z,ATMO_DEG_PER_UNIT\)/.test(html), 'the surface build points the sea at its world\'s basins (site offset)');
  ok(/return _wetCol\?_wetCol\(x,z,_Hw,WATER_SURFACE_Y\):true;/.test(html), 'the swim / buoyancy volume holds only inside a basin');
  ok(/farTick\(ctx\);/.test(wsrc) && /S\.farFn = farBoxWet/.test(wsrc) && /coverFOn: uniform\(0\), coverFC: uniform\(V3\(\)\)/.test(wsrc), 'DMWater: far window + far tile test wired');
  ok(/const coarseCover = mix\(farCover,/.test(sea), 'the sea fragment past the near grid reads the basin window');
  ok(/if\(fin>768\) await pass\(fin,fin\/2\)/.test(html) && /function _wmFinalSize\(\)/.test(html), 'crisp orbit maps: a 1-2K final pass');
  ok(/if\(\(y&7\)===7\) yield;/.test(html), 'the map colouring yields (no long frame)');
  ok(/_resumeWaitBody\.add\(w\)/.test(html) && /Date\.now\(\)-tw<45000/.test(html), 'resume waits for the world\'s mesh before warning');
  ok(/DMStarBubble\.registerStar\(\{mesh:sb\.group/.test(html) && /DMStarBubble\.clearStars\(\)/.test(html), 'binary companions are registered; the registry is per system');
  ok(/SB\.registerStar=function/.test(sb) && /distantSystems/.test(sb) && !/V3\.clone\(\)/.test(sb.slice(sb.indexOf('function nearestStar'), sb.indexOf('const eob'))), 'the bubble picks from every star (registry + distant stars), no per-frame clone');
}
console.log(fails ? 'water-basin: ' + fails + ' FAILED of ' + n : 'water-basin: all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
