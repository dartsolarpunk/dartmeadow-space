// Unit tests for ui/dm-parallax.js pure math.   node tools/tests/parallax-unit.js
const assert = require('assert'); const P = require('../../ui/dm-parallax.js'); const R = P.ref;
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const V = (deg, az) => { const t = deg * Math.PI / 180; return [Math.sin(t) * Math.cos(az || 0), Math.sin(t) * Math.sin(az || 0), Math.cos(t)]; };
// flat field h=c: hit = uv0 + Vxy/Vz*depth*(c-bias)  (closed form)
for (const c of [0.2, 0.5, 0.9]) for (const deg of [0, 30, 60]) for (const bias of [0, 0.5, 1]) {
  const v = V(deg, 0.7), d = 0.08, r = R.march(() => c, 0.3, 0.4, v, { depth: d, bias, n: 24, refine: 2 });
  const k = d / v[2] * (c - bias);   // step-free hit expectation: h + l = 1 -> l = 1-c ; uv = uv0 + P*(1-bias-l)
  ok(Math.abs(r.u - (0.3 + v[0] * k)) < 2e-3 && Math.abs(r.v - (0.4 + v[1] * k)) < 2e-3, `flat c=${c} deg=${deg} bias=${bias}: ${r.u},${r.v}`);
}
// slope field h = 0.5 + 0.4*(u-0.3): the hit lies ON the surface (residual ~0), with and without refine
const slope = (u) => Math.min(1, Math.max(0, 0.5 + 0.4 * (u - 0.3)));
for (const refine of [0, 2]) for (const deg of [10, 45, 70]) {
  const r = R.march(slope, 0.3, 0.3, V(deg, 0.2), { depth: 0.1, bias: 0.3, n: 16, refine });
  ok(Math.abs(r.err) < (refine ? 4e-3 : 1.2e-2), `slope residual deg=${deg} refine=${refine}: ${r.err}`);
}
// bump: gaussian bump; a more oblique view shifts the hit further, in the view direction side; refine never worse than linear
const bump = (u, v) => 0.15 + 0.8 * Math.exp(-(((u - .5) ** 2 + (v - .5) ** 2) / 0.01));
let prev = 0;
for (const deg of [0, 20, 40, 60]) {
  const a = R.march(bump, 0.44, 0.5, V(deg, 0), { depth: 0.12, bias: 0, n: 24, refine: 0 }), b = R.march(bump, 0.44, 0.5, V(deg, 0), { depth: 0.12, bias: 0, n: 24, refine: 2 });
  ok(Math.abs(b.err) <= Math.abs(a.err) + 1e-9 && Math.abs(b.err) < 8e-3, `bump refine deg=${deg} ${a.err} ${b.err}`);
  ok(a.u >= prev - 1e-9, 'offset grows with obliqueness'); prev = a.u;
  ok(a.iters <= 26 + 0, 'iteration bound ' + a.iters);
}
// fade 0 -> plain uv; depth fade scales linearly
const f0 = R.march(bump, 0.44, 0.5, V(50, 0), { depth: 0.12, bias: 0, n: 24, fade: 0 }); ok(Math.abs(f0.u - 0.44) < 1e-9 && Math.abs(f0.v - 0.5) < 1e-9, 'fade 0 = plain uv');
// grazing clamp: offset never exceeds maxTan*depth
const g = R.march(() => 0.0, 0, 0, V(89.9, 0), { depth: 0.1, bias: 1, n: 8, maxTan: 6 }); ok(Math.abs(g.u) <= 0.6 + 1e-9, 'grazing clamp ' + g.u);
// shadow: flat = lit; a tall wall toward the light shadows a low point; light from above = lit
ok(R.shadow(() => 0.3, .5, .5, 0.3, [0.6, 0, 0.8]) === 1, 'flat lit');
const wall = (u) => (u > 0.52 ? 1 : 0.1);
ok(R.shadow(wall, 0.5, 0.5, 0.1, [0.7, 0, 0.714], { depth: 0.1 }) < 0.5, 'wall shadows the floor');
ok(R.shadow(wall, 0.5, 0.5, 0.1, [0, 0, 1], { depth: 0.1 }) === 1, 'overhead light is unshadowed');
// distance fade + view-adaptive layers + tiers
ok(R.distFade(1, 5, 10) === 1 && R.distFade(20, 5, 10) === 0 && R.distFade(7.5, 5, 10) > 0.4, 'distFade');
ok(R.layersFor(1, 24) < R.layersFor(0.2, 24) && R.layersFor(0.2, 24) <= 24, 'adaptive layers');
const T = R.TIERS; ok(T.desktop.ultra.steps === 24 && T.desktop.medium.steps === 16 && T.mobile.medium.steps === 8 && T.mobile.ultra.steps === 16, 'tier counts');
ok(R.BOUNDS.mobile.shN === 3 && R.BOUNDS.mobile.rel === 1, 'mobile carries a 3-tap shadow and one relief step (uniform-gated)');
// the derivations are generators (time-sliced at runtime): they must yield between slices and produce exactly what the plain functions return
{ const W2 = 96, d = new Uint8Array(W2 * W2 * 4); for (let i = 0; i < W2 * W2; i++) { const x = i % W2, y = (i / W2) | 0, c = ((x >> 3) + (y >> 3)) & 1 ? 190 : 60; d[i * 4] = c; d[i * 4 + 1] = 128 + (x & 15); d[i * 4 + 2] = 255; d[i * 4 + 3] = 255; }
  for (const [g, f] of [[P.heightFromRGBAG, P.heightFromRGBA], [P.heightFromNormalsG, P.heightFromNormals]]) { const it = g(d, W2, W2, {}); let y = 0, r; do { r = it.next(); if (!r.done) y++; } while (!r.done); const e = f(d, W2, W2, {}); ok(y >= 4 && r.value.every((v, i) => v === e[i]), 'sliced == sync, yields=' + y); } }
// height derivation: colour with a dark crack grid -> cracks low, plates high; deterministic
const W = 64, rgba = new Uint8Array(W * W * 4);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const c = (x % 16 < 2 || y % 16 < 2) ? 40 : 170; const i = (y * W + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = c; rgba[i + 3] = 255; }
const h1 = P.heightFromRGBA(rgba, W, W), h2 = P.heightFromRGBA(rgba, W, W);
ok(h1.length === W * W && h1.every((v, i) => v === h2[i]), 'deterministic');
ok(h1[8 * W + 8] > h1[0 * W + 8] + 60, 'plate higher than crack: ' + h1[8 * W + 8] + ' vs ' + h1[8]);
// normals -> height: encode the normals of a smooth bump, integrate, correlate
const NW = 64, nm = new Uint8Array(NW * NW * 4), truth = new Float32Array(NW * NW);
for (let y = 0; y < NW; y++) for (let x = 0; x < NW; x++) {
  const u = x / NW - .5, v = y / NW - .5, s2 = 0.02, hv = Math.exp(-(u * u + v * v) / s2), gx = 2 * u / s2 * hv * 0.06, gy = 2 * v / s2 * hv * 0.06;
  const l = Math.hypot(gx, gy, 1), i = (y * NW + x) * 4; nm[i] = (gx / l * .5 + .5) * 255; nm[i + 1] = (gy / l * .5 + .5) * 255; nm[i + 2] = (1 / l * .5 + .5) * 255; nm[i + 3] = 255; truth[y * NW + x] = hv;
}
const hn = P.heightFromNormals(nm, NW, NW); let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0; const N2 = NW * NW;
for (let i = 0; i < N2; i++) { sa += truth[i]; sb += hn[i]; } sa /= N2; sb /= N2;
for (let i = 0; i < N2; i++) { sab += (truth[i] - sa) * (hn[i] - sb); saa += (truth[i] - sa) ** 2; sbb += (hn[i] - sb) ** 2; }
const corr = sab / Math.sqrt(saa * sbb); ok(corr > 0.75, 'normal->height correlation ' + corr.toFixed(3));
// tiles: tileable, joints low, stones high
const tile = P.makeTile('cobble', 128, 7), tile2 = P.makeTile('cobble', 128, 7); ok(tile.every((v, i) => v === tile2[i]), 'tile deterministic');
let mn = 255, mx = 0; tile.forEach(v => { mn = Math.min(mn, v); mx = Math.max(mx, v); }); ok(mn < 40 && mx > 180, `tile range ${mn}..${mx}`);
console.log('parallax-unit: OK (' + n + ' checks), normal->height corr ' + corr.toFixed(3));
