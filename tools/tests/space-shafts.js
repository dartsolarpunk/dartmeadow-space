// node tools/tests/space-shafts.js — t1537 follow-up: (1) the open-space key-star glare / dust scatter / planet-shadow shafts (ui/dm-spaceshafts.js),
// (2) the far shadow layer's displaced-caster + planet-frame fixes and its real memory (ui/dm-sunfar.js).
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const SS = require(path.join(root, 'ui/dm-spaceshafts.js')), C = SS.core;
const F = require(path.join(root, 'ui/dm-sunfar.js')), FC = F.core;

console.log('== space shafts: gate, phase, analytic planet shadow (pure)');
ok(C.tierN('low') === 0, 'off on Low (0 samples)');
ok(C.tierN('med') > 0 && C.tierN('med') <= 4 && C.tierN('high') > C.tierN('med') && C.tierN('ultra') <= 8, 'Med ' + C.tierN('med') + ' / High ' + C.tierN('high') + ' / Ultra ' + C.tierN('ultra') + ' samples (<= 8)');
ok(C.hg(C.K.skipCos, C.K.g) / C.hg(1, C.K.g) < 0.02, 'the march is skipped only where the phase is < 2 % of its peak (' + (100 * C.hg(C.K.skipCos, C.K.g) / C.hg(1, C.K.g)).toFixed(2) + ' %)');
{ const P = [0, 0, -100], r = 10, L = [0, 0, -1];   // star straight behind the planet
  ok(C.vis([0, 0, 0], L, P, r) === 0, 'camera in the planet\'s shadow: no glare');
  ok(C.vis([0, 0, -150], L, P, r) === 1, 'dust past the planet (star side) is lit');
  ok(C.vis([20, 0, 0], L, P, r) === 1, 'dust well off the shadow cone is lit');
  const v = C.vis([10, 0, 0], L, P, r); ok(v > 0 && v < 1, 'soft at the limb (' + v.toFixed(2) + ')');
  ok(C.vis([0, 0, -100], L, P, r) === 0, 'inside the planet: dark'); }
ok(C.wantOn(0, 0, 16) && !C.wantOn(2, 0, 16) && !C.wantOn(0, 2, 16) && !C.wantOn(0, 0, 45), 'budget: off at light level >= 2, fast guard >= 2 or EMA > 40 ms');

console.log('== space shafts: source pins');
const ss = rd('ui/dm-spaceshafts.js'), html = rd('index.html');
ok(!/new THREE\.(Directional|Point|Spot|Hemisphere|Ambient)Light/.test(ss), 'adds no light');
ok(/spaceshafts=/.test(ss) && /fq === '0'/.test(ss), '?spaceshafts=0 kill switch');
ok(/fromPoint\(cam\.position/.test(ss) && /keyDir/.test(ss), 'key star from DMStars (fromPoint in open space, keyDir on a world); no direction of its own');
ok(/U\.L2/.test(ss) && /c2/.test(ss), 'binary aware: the second star glares / scatters too');
ok(/depthWrite: false/.test(ss) && /castShadow = false/.test(ss) && /noBend = true/.test(ss) && /dmFarSkip = true/.test(ss), 'shell: no depth write, no shadows, no planet bend, not in the far layer');
const tick = ss.slice(ss.indexOf('D.tick = function'), ss.indexOf('D.status = function'));
ok(!/new THREE\.|\bnew [A-Z]\w*\(|\[\s*\]|\{\s*\w+\s*:/.test(tick.replace(/new THREE\.Vector3\(\)/, '')), 'tick allocates nothing per frame (the 3 star vectors are made once)');
ok(/_sd\[0\]\) for/.test(tick), 'star vectors are made once (guarded)');
ok(/<script src="ui\/dm-spaceshafts\.js\?v=/.test(html) && /DMSpaceShafts\.tick\(THREE,flightScene,flightCamera,_ss\)/.test(html), 'index.html loads it and ticks it before the draw');
ok(/_ssO\|\|\(_ssO=/.test(html), 'index.html reuses one options object');

console.log('== far layer: displaced casters, planet frame, bias, memory');
ok(FC.shapeLost({ vertexNode: {} }) && FC.shapeLost({ allowOverride: false }) && FC.shapeLost([{}, { vertexNode: {} }]) && !FC.shapeLost({ positionNode: {} }) && !FC.shapeLost({}), 'vertexNode / allowOverride=false casters leave the layer; positionNode ones stay (the override carries positionNode in r185)');
ok(/!shapeLost\(o\.material\)/.test(rd('ui/dm-sunfar.js')), 'tag() checks it');
{ // the exact planet frame (index.html _pwfMap) vs the first-order correction
  const R = 360 / 0.008 / (2 * Math.PI), D = 0.008 * Math.PI / 180, lat0 = 0.3;
  const map = (x, y, z, fx, fz) => { const dp = -(z - fz) * D, dl = (x - fx) * D, phi = lat0 + dp, cp = Math.cos(phi), rh = R + y, s2 = Math.sin(dl * 0.5), hl = 2 * s2 * s2, s3 = Math.sin(dp * 0.5), hp = 2 * s3 * s3;
    return [fx + rh * cp * Math.sin(dl), y - rh * (hp + cp * Math.cos(lat0) * hl), fz - rh * (Math.sin(dp) + cp * Math.sin(lat0) * hl)]; };
  let worst = 0, raw = 0;
  for (const [x, z] of [[300, 0], [0, -300], [210, 210], [-250, 120]]) {
    const fp = [0, 0], fc = [40, -25], a = map(x, 5, z, fp[0], fp[1]), b = map(x, 5, z, fc[0], fc[1]);
    const corr = b[1] + FC.bendDy(b[0], b[2], fc[0], fc[1], fp[0], fp[1], 1 / R);
    raw = Math.max(raw, Math.abs(b[1] - a[1])); worst = Math.max(worst, Math.abs(corr - a[1]));
  }
  ok(raw > 0.5 && worst < raw * 0.2 && worst < 0.35, 'focus moved 47 u since the pass, receiver 300 u out: ' + raw.toFixed(2) + ' u drift -> ' + worst.toFixed(2) + ' u after the correction');
}
{ const c = FC.tierCfg('low'), range = c.half * 4.4 - 1, k = FC.slopeK(c.half, c.size, range), b0 = 0.0009, w = x => (x * range).toFixed(2);
  ok(FC.slopeBias(b0, 1, k) === b0 && FC.slopeBias(b0, 0.5, k) > b0 && FC.slopeBias(b0, 0, k) <= b0 + k * FC.TAN_MAX + 1e-12 && (FC.slopeBias(b0, 0.5, k) - b0) * range < 0.25,
    'slope-scaled bias (Low): flat ' + w(b0) + ' u, 60 deg ' + w(FC.slopeBias(b0, 0.5, k)) + ' u, clamped at ' + w(b0 + k * FC.TAN_MAX) + ' u'); }
ok(FC.memBytes(1024) === 5 * 1048576 && FC.memBytes(1024, false) === 8 * 1048576, 'real memory: 1024^2 = 5 MB (R8 colour + 32-bit depth), 8 MB on the RGBA8 fallback');
const sf = rd('ui/dm-sunfar.js');
ok(/bendN\(T, U, p\)/.test(sf) && /bendN\(T, U, q\)/.test(sf), 'the receiver node and the shaft tap both use the frame correction');
ok(/U\.bias\.add\(U\.sb\.mul\(tn\)\)/.test(sf), 'the receiver node uses the slope bias');
ok(/DMSunFar\.hooks\.bend=\(\)=>\{ try\{ return PWF; \}/.test(html), 'index.html hands the planet frame to the far layer');
const ft = sf.slice(sf.indexOf('D.tick = function'), sf.indexOf('D.covers = function'));
ok(!/new [A-Z]\w*\(|\[\s*\]|\{\s*\w+\s*:/.test(ft), 'far tick still allocates nothing');

console.log(fails ? 'space-shafts: ' + fails + ' FAILED of ' + n : 'space-shafts: ' + n + '/' + n + ' ok'); process.exit(fails ? 1 : 0);
