// node tools/tests/radial-lod-blend.js — t1516: the sky ground's far edge blends to the horizon haze (texture + lighting + shadows: the whole lit output)
// before it dissolves, with band radii from Justin Craig Venable's Radical Circumference / ArcEdge rim (ui/dm-radical-circ.js).  Runs the REAL helpers
// cut from index.html.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const RC = require(path.join(root, 'ui', 'dm-radical-circ.js'));
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const cut = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('marker ' + a); const j = html.indexOf(b, i + a.length); if (j < 0) throw new Error('end ' + b); return html.slice(i, j); };
const src = cut('const _SKY_FADE0=', 'SkyGround.prototype._radialFade=') + cut('const _SKY_HAZE_RIM=', 'SkyGround.prototype._hazeInit=');
const E = new Function('window', src + '\nreturn {_SKY_FADE0,_skyGroundFade,_skyHazeBand,_skyHazeW,_SKY_HAZE_RIM};')({ DMRadCirc: RC });
const E0 = new Function('window', src + '\nreturn {_skyHazeBand};')({});   // no DMRadCirc loaded: same numbers from the fallback
for (const R of [300, 1200, 2800, 4500, 12000, 1e5]) {
  const b = E._skyHazeBand(R, {}), r = RC.rim(R);
  ok(b.outer === R && b.inner === r.inner && b.centre === r.centre, 'band = Radical Circumference rim of R=' + R);
  ok(Math.abs(b.inner - (R - R * 2 * 0.125)) < 1e-9 && Math.abs(b.centre - (b.inner + R) / 2) < 1e-9, 'inner = R - 1/8 diameter, centre = centre-to-centre of the rim');
  const f = E0._skyHazeBand(R, {}); ok(Math.abs(f.inner - b.inner) < 1e-9 && Math.abs(f.centre - b.centre) < 1e-9, 'fallback equals the module');
  ok(b.centre <= R * 0.9 && b.centre > R * E._SKY_FADE0, 'the haze is complete (' + (b.centre / R) + ' R) before most of the dissolve band');
  ok(b.inner < R * E._SKY_FADE0, 'the blend starts before any pixel dissolves');
  // monotone, smooth, radial: weight depends on distance only and never steps
  let prev = -1, maxStep = 0;
  for (let i = 0; i <= 4000; i++) { const d = R * i / 4000, w = E._skyHazeW(d, b.inner, b.centre); ok(w >= prev - 1e-12 && w >= 0 && w <= 1, 'monotone in [0,1]'); if (prev >= 0) maxStep = Math.max(maxStep, w - prev); prev = w; }
  ok(maxStep <= 1.5 * (R / 4000) / (b.centre - b.inner) + 1e-9, 'no visible step anywhere in the band (max step ' + maxStep.toFixed(5) + ')');
  ok(E._skyHazeW(b.inner, b.inner, b.centre) === 0 && E._skyHazeW(b.centre, b.inner, b.centre) === 1, 'ends exact');
  // what is still drawn (dissolve keep) is already haze: the product of "lit ground left" and "pixel kept" is tiny past the rim centre
  let worst = 0; for (let d = b.centre; d <= R; d += R / 500) worst = Math.max(worst, (1 - E._skyHazeW(d, b.inner, b.centre)) * E._skyGroundFade(d, R));
  ok(worst === 0, 'past the rim centre no un-hazed ground is drawn');
  // directions: same distance, any bearing -> same weight (a circle, not a tile square)
  for (let a = 0; a < 16; a++) { const th = a * 0.3927, d = R * 0.8, x = Math.cos(th) * d, z = Math.sin(th) * d; ok(Math.abs(E._skyHazeW(Math.hypot(x, z), b.inner, b.centre) - E._skyHazeW(d, b.inner, b.centre)) < 1e-12, 'radial'); }
}
// source wiring
const init = cut('SkyGround.prototype._hazeInit=', 'SkyGround.prototype._hazeTick=');
const tick = cut('SkyGround.prototype._hazeTick=', '// (lod-hide) the far sea has no square.');
ok(/m\.outputNode=W\.vec4\(W\.mix\(W\.output\.rgb,U\.c,w\),W\.output\.a\)/.test(init), 'blends three\'s final lit output (texture + lighting + shadows + fog), not just albedo');
ok(/smoothstep\(U\.r\.x,U\.r\.y,W\.length\(W\.positionView\)\)/.test(init), 'true view distance (radial)');
ok(/_SKY_SMOOTH\?!\/\[\?&\]skyhaze=0\\b\/\.test\(q\):\/\[\?&\]skyhaze=1\\b\/\.test\(q\)/.test(init), '(t1644) the smooth haze blend is ON by default (?skyhaze=0 off; ?skyfade=dither = the t1590 opt-in)');
ok(!/new THREE|\{[a-z]+:/.test(tick.replace(/^[^\n]*\n/, '')), 'tick allocates nothing');
ok(/U\.c\.value\.copy\(fog\.color\)/.test(tick) && /U\.on\.value=0/.test(tick), 'haze colour follows the scene fog; airless worlds (no fog) keep the dissolve only');
ok(/const hz=!!\(this\._hazeU&&this\._hazeU\.on\.value\), dz=hz\|\|_skyDitherOk\(_skyResScale\(\)\), e0=hz\?_SKY_EDGE0:_SKY_FADE0; this\._fadeU\.a\.value=dz\?this\.viewR\*e0:1e9; this\._fadeU\.b\.value=dz\?this\.viewR:2e9; this\._hazeTick\(\);/.test(html), 'update() moves the haze band with viewR (t1644: smooth haze + hairline dither; t1590: no dither below 0.8 resolution without haze)');
ok(/Justin Craig Venable/.test(cut('// (t1516) RADIAL LOD BLEND', 'const _SKY_HAZE_RIM')), 'credited');
console.log(fails ? 'radial-lod-blend: ' + fails + ' FAILED of ' + n : 'radial-lod-blend: all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
