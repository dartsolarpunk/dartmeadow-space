// node tools/tests/radial-falloff.js — t1590: the ground has ONE radial falloff and no hard ring anywhere.  Runs the REAL helpers cut from index.html.
// Band radii by Justin Craig Venable's Radical Circumference / ArcEdge rim (ui/dm-radical-circ.js).  Pins:
//  (1) the near detail fade (_skyDetailFall) is a continuous smoothstep over ~0.56 .. 1.5 reach: no value step, slope bounded (no "sharp disc"), radial
//  (2) on open ground on foot the drawn radius is the walk radius and the haze is at full density by 0.82 R, inside the rim; the sky / a vantage opens it continuously
//  (3) the dissolve dither steps aside below 0.8 of the chosen resolution; the #259 colour mix is opt-in (?skyhaze=1)
//  (4) source: one rim function feeds the bands, the world she stands on keeps its orbit globe hidden after a rebuild on foot, tablets keep >= 0.75 render scale
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
const html = rd('index.html'), RC = require(path.join(root, 'ui', 'dm-radical-circ.js'));
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } else if (process.env.VERBOSE) console.log('  ok', m); };
const cut = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('marker ' + a); const j = html.indexOf(b, i + a.length); if (j < 0) throw new Error('end ' + b); return html.slice(i, j); };
const src = 'const _SKY_FADE0=0.82;\n' + cut('const _SKY_HAZE_RIM=', 'SkyGround.prototype._hazeInit=') + cut('function _skyGroundR(', '// the haze far distance') + cut('function _skyFillFog(', '\n') + '\n';
const E = new Function('window', src + '\nreturn {_SKY_FADE0,_skyHazeBand,_skyFalloff,_skyDetailFall,_skyDitherOk,_SKY_DITHER_MIN,_skyGroundR,_skyGroundOpen,_skyFillFog};')({ DMRadCirc: RC });
const sm = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// (1) near detail: continuous, wide, radial
for (const reach of [22, 30, 40]) {
  const f = E._skyDetailFall(reach, [0, 0]), r = RC.rim(reach * 1.5);
  ok(f[1] === reach * 1.5 && Math.abs(f[0] - RC.halfRadius(r.inner)) < 1e-9, 'reach ' + reach + ': detail rim [' + f[0].toFixed(1) + ', ' + f[1].toFixed(1) + '] = half-radius of the rim inner edge .. rim outer edge');
  ok(f[1] - f[0] >= reach * 0.9, 'reach ' + reach + ': the fade spans ' + (f[1] - f[0]).toFixed(1) + ' u (>= 0.9 reach; was 0.55 reach, the sharp disc)');
  let prev = 1, maxStep = 0; const N = 6000;
  for (let i = 0; i <= N; i++) { const d = f[1] * 1.2 * i / N, w = 1 - sm(f[0], f[1], d); ok(w <= prev + 1e-12, 'monotone'); maxStep = Math.max(maxStep, prev - w); prev = w; }
  const bound = 1.5 * (f[1] * 1.2 / N) / (f[1] - f[0]) + 1e-9;
  ok(maxStep <= bound, 'reach ' + reach + ': no hard ring (largest step ' + maxStep.toFixed(5) + ' <= ' + bound.toFixed(5) + ' per ' + (f[1] * 1.2 / N).toFixed(3) + ' u)');
  // old edge for the record: the same metric on 0.45 .. 1.0 reach is ~1.8x steeper
  const oldSlope = 1.5 / (reach * 0.55), newSlope = 1.5 / (f[1] - f[0]); ok(newSlope < oldSlope * 0.65, 'reach ' + reach + ': peak fade slope ' + newSlope.toFixed(3) + '/u vs the old ' + oldSlope.toFixed(3) + '/u');
}
{ const a = E._skyDetailFall(30), b = E._skyDetailFall(30); ok(a === b, 'the default output array is reused (no allocation)'); }

// (2) on foot: the walk radius, haze dense inside the rim; the sky / vantage open it continuously
for (const viewR of [1200, 1500, 3000]) {
  const open = viewR * 1.8, rim = E._skyFalloff(viewR, {});
  ok(E._skyGroundOpen(viewR, open, 0, 0) === viewR, 'R=' + viewR + ': on foot on open ground the drawn radius is the walk radius');
  ok(E._skyGroundOpen(viewR, open, 1, 0) === open && E._skyGroundOpen(viewR, open, 0, 1) === open, 'R=' + viewR + ': the climb / a full vantage open it to the horizon reach');
  let prev = viewR, maxJ = 0; for (let i = 0; i <= 1000; i++) { const g = E._skyGroundOpen(viewR, open, i / 1000, 0); ok(g >= prev - 1e-9, 'monotone in k'); maxJ = Math.max(maxJ, g - prev); prev = g; }
  ok(maxJ <= (open - viewR) / 1000 + 1e-6, 'R=' + viewR + ': opening is continuous (no switch)');
  const fog = E._skyFillFog(420, viewR, 1);
  ok(Math.abs(fog - viewR * E._SKY_FADE0) < 1e-9 && fog < rim.centre && fog > rim.inner, 'R=' + viewR + ': haze at full density by ' + (fog / viewR).toFixed(2) + ' R, inside the rim (' + (rim.inner / viewR) + '-' + (rim.centre / viewR) + ' R): the dissolve band is never seen');
  ok(rim.inner === RC.rim(viewR).inner && rim.centre === RC.rim(viewR).centre, 'R=' + viewR + ': the falloff IS the Radical Circumference rim');
}
// (3) dither floor
ok(E._skyDitherOk(1) && E._skyDitherOk(0.8) && !E._skyDitherOk(0.79) && !E._skyDitherOk(0.42), 'dissolve dither only at >= ' + E._SKY_DITHER_MIN + ' of the chosen resolution');
ok(/!\/\[\?&\]skyhaze=1\\b\/\.test\(location\.search\)\) return;/.test(cut('SkyGround.prototype._hazeInit=', 'SkyGround.prototype._hazeTick=')), 'the #259 colour mix is off by default (?skyhaze=1 A/B)');
// (4) source pins
ok(/Justin Craig Venable/.test(cut('// (t1590) ONE RADIAL FALLOFF', 'function _skyFalloff')), 'credited: Radical Circumference / ArcEdge (Justin Craig Venable)');
ok(/function _skyFalloff\(R,out\)\{ return _skyHazeBand\(R,out\); \}/.test(html), 'one rim function (_skyHazeBand -> DMRadCirc.rim) feeds the bands');
ok(/fall:_df/.test(html) && /ctx\.fall \? smoothstep\(float\(ctx\.fall\[0\]\)/.test(rd('ui/dm-groundlib.js')), 'the ground library (82e25cd) fades on the same detail rim, not its own 0.5 .. 1.0 reach edge');
ok(/const _pwHid=!!\(typeof PW!=='undefined'&&PW\.active&&PW\.body===b&&oldGroup&&oldGroup\.visible===false\);/.test(html) && /if\(_pwHid&&PW\.active&&PW\.body===b&&b\.mesh===newGroup\) newGroup\.visible=false;/.test(html), 'a planet rebuild that finishes on foot keeps the orbit globe hidden (no brick shell through the ground)');
ok(/_SKY_SETTLE=\{after:300,anchor:6,/.test(html), 'settle anchor 6 u');
{ const gv = rd('ui/dm-governor.js'), bd = rd('ui/dm-budget.js'); ok(/const TABLET_FLOOR = 0\.75;/.test(gv) && /if \(k < tf\) k = tf;/.test(gv) && /if \(cap < tf\) cap = tf;/.test(bd), 'tablets keep >= 0.75 render scale (governor + budget enforcer)'); }
{ const up = cut('SkyGround.prototype.update=', 'SkyGround.prototype._rootKeep='); ok(!/new [A-Z]|\[\s*\]|=>/.test(up.replace(/\/\/[^\n]*/g, '')), 'update() allocates nothing'); }
ok(/const ATMO_DEFAULT_AGL\s*=\s*46\b/.test(html), 'ATMO_DEFAULT_AGL stays 46');
console.log(fails ? 'radial-falloff: ' + fails + ' FAILED of ' + n : 'radial-falloff: all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
