// node tools/tests/sun-far.js — t1537 items 2+3: the key light's wide, slow shadow layer (ui/dm-sunfar.js), its hook into DMLight's sun wrapper, the tight
// near box it allows (ui/dm-polish.js TIGHT_FAR), the daytime fill dip (ui/dm-sky.js FILL_DAY) and the volumetric shafts (ui/dm-vlight.js), plus the budget rules.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const F = require(path.join(root, 'ui/dm-sunfar.js')), C = F.core;

console.log('== far layer: tiers, cadence, coverage (pure)');
ok(C.tierCfg('off') === null && C.tierCfg('bogus') === null, 'no layer for the off tier');
// (t1590) tiers: Low and every phone / tablet run no pass; Medium desktop runs it for the shafts only (no receivers); High / Ultra desktop receive on architecture
ok(C.tierCfg('low') === null && C.tierCfg('low', true) === null, 't1590: Low has no far layer');
for (const t of ['low', 'med', 'high', 'ultra']) ok(C.tierCfg(t, true) === null, 't1590: ' + t + ' on a phone / tablet: no far pass');
ok(C.tierCfg('med').recv === false, 't1590: Medium desktop: pass for the shafts only, no receivers');
ok(C.tierCfg('high').recv === true && C.tierCfg('ultra').recv === true, 't1590: High / Ultra desktop receive (architecture / overhangs)');
for (const t of ['med', 'high', 'ultra']) {
  const c = C.tierCfg(t); ok(c && c.size >= 1024 && c.half >= 100, t + ': map ' + c.size + ', half ' + c.half);
  ok(C.memBytes(c.size) <= 32 * 1048576, t + ': <= 32 MB (' + (C.memBytes(c.size) / 1048576).toFixed(0) + ' MB)');
  ok(c.minS >= 0.5, t + ': at most 2 passes a second (minS ' + c.minS + ')');
  // the far layer starts inside the near band of the TIGHT near box and reaches well past the third-person camera
  const near = ({ low: 45, med: 70, high: 110, ultra: 110 })[t] * 0.62;
  ok(c.half * C.FADE[0] > near * 0.97 * 3, t + ': far layer holds to ' + (c.half * C.FADE[0]).toFixed(0) + ' u (>= 3x the tight near box edge ' + (near * 0.97).toFixed(0) + ')');
  ok(c.half * C.COVER > near, t + ': covers() radius (' + (c.half * C.COVER).toFixed(0) + ' u) is past the tight near box (' + near.toFixed(0) + ' u)');
}
ok(C.FADE[1] < 1, 'far layer gone inside its own square (no edge)');
{ const st = { valid: false }; ok(C.need(st, 170, 1000, 0, 0, 0, 1, 0, 0) === 1, 'first pass is due'); }
{ const st = { valid: true, cx: 0, cz: 0, dx: 0, dy: 1, dz: 0, t: 0 }, step = 170 * C.SNAP;
  ok(C.need(st, 170, 1000, step * 0.4, -step * 0.4, 0, 1, 0, 500) === 0, 'standing in the same cell, same sun: no pass');
  ok(C.need(st, 170, 1000, step * 0.6, 0, 0, 1, 0, 500) === 2, 'new cell but inside minS: held');
  ok(C.need(st, 170, 1000, step * 0.6, 0, 0, 1, 0, 1200) === 1, 'new cell after minS: pass');
  const a = 0.5 * Math.PI / 180; ok(C.need(st, 170, 1000, 0, 0, Math.sin(a), Math.cos(a), 0, 1500) === 1, 'sun turned 0.5 deg: pass');
  const b = 0.2 * Math.PI / 180; ok(C.need(st, 170, 1000, 0, 0, Math.sin(b), Math.cos(b), 0, 1500) === 0, 'sun turned 0.2 deg: no pass');
  ok(C.need(st, 170, 1000, 0, 0, 0, 1, 0, C.MAX_AGE + 1) === 1, 'refreshed at least every ' + C.MAX_AGE / 1000 + ' s');
  ok(C.coversAt(st, 170, 170 * C.COVER - 1, 0) && !C.coversAt(st, 170, 170 * C.COVER + 1, 0) && !C.coversAt({ valid: false }, 170, 0, 0), 'covers() only near the live map centre');
}
// walking at 6 u/s for a minute on Medium: passes stay rare
{ const st = { valid: false }, c = C.tierCfg('med'); let passes = 0; for (let t = 0; t <= 60000; t += 16) { const x = t * 0.006; if (C.need(st, c.half, c.minS * 1000, x, 0, 0, 1, 0, t) === 1) { passes++; const s = c.half * C.SNAP; Object.assign(st, { valid: true, cx: C.snap(x, s), cz: 0, dx: 0, dy: 1, dz: 0, t }); } }
  ok(passes <= 20, 'walking a minute on Medium: ' + passes + ' far passes (<= 20)'); }

console.log('== source pins');
const sf = rd('ui/dm-sunfar.js'), lt = rd('ui/dm-light.js'), pol = rd('ui/dm-polish.js'), sky = rd('ui/dm-sky.js'), vl = rd('ui/dm-vlight.js'), html = rd('index.html');
ok(!/new THREE\.(Directional|Spot|Point|Hemisphere|Ambient)Light/.test(sf), 'dm-sunfar adds no light (no second sun)');
ok(/scene\.overrideMaterial = S\.mat/.test(sf) && /cam\.layers\.set\(LAYER\)/.test(sf), 'one depth-only pass of the castShadow layer');
ok(/o\.isSkinnedMesh/.test(sf) && /dmFarSkip/.test(sf) && /DMSunFar\.hooks\.skip=\(a\)=>/.test(html), 'moving casters (her, the board) are kept out of the slow layer');
{ const tick = sf.slice(sf.indexOf('D.tick = function'), sf.indexOf('D.covers')); ok(!/new [A-Z]|\[\s*\]|=\s*\{\s*\}|=>/.test(tick.replace(/\/\/.*$/gm, '')), 'D.tick allocates nothing (no new / [] / {} / closures)'); }
ok(/const farV = \(!o\.terrain && W\.DMSunFar && W\.DMSunFar\.node\)/.test(lt) && (lt.match(/mix\(farV, /g) || []).length === 4, 'dm-light: all four sun-wrapper branches hand off to the far layer, except on open terrain (t1590: lit past the near box)');
ok(/const farVis = o\.terrain \? \(FAR_AVG \? U\.vAvg : float\(1\)\)/.test(lt), 'dm-light (t1590/t1644): open terrain past the probes takes no 0.78 slope darkening; it fades to the window average sky visibility (no bubble; ?lightfar=0 = plain open sky)');
ok(/terrain:!opts\.noTerrainLight/.test(html), 'index.html (t1590): the ground material is marked terrain for DMLight');
ok(/!!S\.cfg\.recv && coversAt/.test(sf) && /if \(!S\.cfg \|\| !S\.cfg\.recv\) return null;/.test(sf), 'dm-sunfar (t1590): covers() / receivers only on a receiving tier (TIGHT_FAR follows it)');
ok(/DMSunFar\.tick\(flightRenderer,scene,up,px,fy,pz\)/.test(html), 'index.html: the far layer is fitted with the same key direction `up` as the near box (_pwKeyDir)');
ok(/let d=_pwKeyDir\(\), up=null/.test(html), 'index.html: `up` still comes from _pwKeyDir()');
ok(/P\.TIGHT_FAR = 0\.62/.test(pol) && /DMSunFar\.covers\(\)/.test(pol) && /P\.TIGHT_K = 1/.test(pol), 'dm-polish: tight near box only while the far layer covers her, #269 full box otherwise');
ok(/const FILL_DAY = /.test(sky) && /\* dd; \}\);/.test(sky) && /sky\.outdoor=/.test(html), 'dm-sky: daytime fill dip outdoors (ctl.outdoor from the game)');
ok(/SHAFTS && cfg\.name !== 'low'/.test(vl) && /U\.hfOn\.greaterThan\(0\.5\)/.test(vl), 'dm-vlight: shafts Medium+ only; the costly terrain march stays low-sun only');
ok(/<script src="ui\/dm-sunfar\.js\?v=\d+"><\/script>/.test(html), 'index.html loads ui/dm-sunfar.js');

console.log('== polish: tight box with the far layer, full box without');
{ const win = {}; const ctx = { window: win, location: { search: '' }, performance: { now: () => 0 }, console, Math }; vm.createContext(ctx); vm.runInContext(rd('ui/dm-polish.js'), ctx);
  const P = win.DMPolish, v = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
  const mk = s => ({ shadow: { mapSize: { x: s, y: s }, camera: { left: -1, right: 1, top: 1, bottom: -1, updateProjectionMatrix() {} }, bias: 0, normalBias: 0 }, position: v(), target: { position: v(), updateMatrixWorld() {} } });
  const dir = { x: 0, y: 1, z: 0 };
  for (const cov of [false, true]) { win.DMSunFar = { covers: () => cov }; P._S.half = 0; const s = mk(512); for (let i = 0; i < 400; i++) P.fitSun(s, dir, 0, 0, 0, true);
    ok(Math.abs(s.shadow.camera.right - (cov ? 45 * 0.62 : 45)) <= 0.5, '512 on foot, far layer ' + (cov ? 'live' : 'absent') + ': box ' + s.shadow.camera.right); }
}
console.log('== sky: fill dip');
{ const m = sky.match(/const dd = atmos \? 1 - \(1 - FILL_DAY\) \* clamp01\(day\) \* \(ctl\.outdoor == null \? 1 : clamp01\(ctl\.outdoor\)\) : 1;/); ok(!!m, 'dip = 1 - (1 - FILL_DAY) x day x outdoor, airless worlds untouched');
  const fd = +((sky.match(/return (0\.\d+); \}\)\(\);/) || [])[1]); ok(fd >= 0.3 && fd <= 0.6, 'FILL_DAY ' + fd + ' (the fill is still there, it just does not wash out the key light)'); }
console.log('sun-far: ' + (n - fails) + '/' + n + ' ok');
if (fails) process.exit(1);
