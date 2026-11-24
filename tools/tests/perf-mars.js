// perf-mars: node test of the Mars performance pass (ui/dm-lod.js additions, the budget ladder at tablet frame rates, the sun-shadow cadence wiring in index.html).
//   node tools/tests/perf-mars.js
const assert = require('assert'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'ui/dm-lod.js'));
const B = require(path.join(ROOT, 'ui/dm-budget.js'));
let n = 0; const ok = (c, m) => { n++; assert(c, m); };

// 1. split scale: per class, monotone in class and in the ladder's ground reach, never above 1 (a tile never splits MORE than before), desktop unchanged
{
  const t = ['low', 'mobile', 'desktop'];
  for (const gk of [1, 0.8, 0.6]) { const v = t.map(x => L.splitScale(x, gk)); ok(v[0] <= v[1] && v[1] <= v[2], 'splitScale monotone across classes gk=' + gk); v.forEach(x => ok(x > 0.3 && x <= 1, 'splitScale range ' + x)); }
  for (const x of t) { ok(L.splitScale(x, 0.6) <= L.splitScale(x, 0.8) && L.splitScale(x, 0.8) <= L.splitScale(x, 1), 'splitScale monotone in gk (' + x + ')'); }
  ok(L.splitScale('desktop', 1) === 1, 'desktop at ladder 0 is exactly the old K');
  ok(L.splitScale('low', 1) < L.splitScale('mobile', 1), 'low sheds more than mobile');
  ok(L.validate().length === 0, 'DMLod table validates: ' + L.validate().join('; '));
}

// 2. ground tile count model (the SkyGround split rule: split while distance < K x size, relief boost off): the low / mobile K gives clearly fewer tiles than K = 1.8
{
  const MIN = 44;
  function tiles(K, viewR) {   // count tiles drawn on a flat plane round a camera at the origin, whole-quadtree walk (square tiles, nearest-point distance), 8 levels
    let drawn = 0;
    (function walk(x0, z0, size) {
      const dx = Math.max(x0 - 0, 0 - (x0 + size), 0), dz = Math.max(z0 - 0, 0 - (z0 + size), 0), d = Math.hypot(dx, dz);
      if (d > viewR) return;
      if (size > MIN && d < size * K) { const h = size / 2; walk(x0, z0, h); walk(x0 + h, z0, h); walk(x0, z0 + h, h); walk(x0 + h, z0 + h, h); } else drawn++;
    })(-45056, -45056, 90112);
    return drawn;
  }
  const base = tiles(1.8, 1500), low = tiles(1.8 * L.splitScale('low', 1), 1500), mob = tiles(1.8 * L.splitScale('mobile', 1), 1500), lad2 = tiles(1.8 * L.splitScale('low', 0.6), 1500);
  console.log('ground tiles (flat model, viewR 1500): K 1.8 -> ' + base + ', mobile ' + mob + ', low ' + low + ', low + ladder ground L2 ' + lad2);
  ok(mob <= base && low < mob && lad2 <= low, 'never more tiles per class / ladder step, fewer on low');
  ok(low <= base * 0.8, 'low class cuts >= 20 % of the tiles (' + low + ' vs ' + base + ')');
}

// 3. far colour smoothing: a hard stair-step edge becomes a gradient; flat fields and the mean are preserved; passes by sample spacing
{
  ok(L.blurPasses(1.4) === 0 && L.blurPasses(2.75) === 0 && L.blurPasses(5.5) === 1 && L.blurPasses(11) === 2 && L.blurPasses(44) === 2, 'blur passes by step');
  const N = 12, a = new Float32Array(N * N * 3);
  for (let r = 0; r < N; r++) for (let q = 0; q < N; q++) { const v = q < 6 ? 0 : 1; for (let c = 0; c < 3; c++) a[(r * N + q) * 3 + c] = v; }
  const step0 = 1, b = L.blurRGB(Float32Array.from(a), N, 2);
  let maxJump0 = 0, maxJump1 = 0; for (let q = 1; q < N; q++) { maxJump0 = Math.max(maxJump0, Math.abs(a[(5 * N + q) * 3] - a[(5 * N + q - 1) * 3])); maxJump1 = Math.max(maxJump1, Math.abs(b[(5 * N + q) * 3] - b[(5 * N + q - 1) * 3])); }
  ok(maxJump0 === 1 && maxJump1 < 0.45, 'edge softened: jump ' + maxJump0 + ' -> ' + maxJump1.toFixed(3) + ' per cell'); void step0;
  const f = new Float32Array(N * N * 3).fill(0.37); L.blurRGB(f, N, 2); ok(f.every(x => Math.abs(x - 0.37) < 1e-6), 'a flat field stays flat (edges clamp)');
  const m0 = a.reduce((s, x) => s + x, 0), m1 = b.reduce((s, x) => s + x, 0); ok(Math.abs(m0 - m1) / m0 < 0.02, 'mean preserved');
  ok(b.every(x => x >= -1e-6 && x <= 1 + 1e-6), 'stays in range');
  // two neighbouring tiles that share a border column compute the same colour on it when the filter reads the shared border cells (same samples): the seam check the glue relies on
  const W = 9, field = (r, q) => Math.sin(q * 0.9) * Math.cos(r * 0.7) * 0.5 + 0.5, g1 = new Float32Array(W * W * 3), g2 = new Float32Array(W * W * 3);
  for (let r = 0; r < W; r++) for (let q = 0; q < W; q++) { g1[(r * W + q) * 3] = field(r, q); g2[(r * W + q) * 3] = field(r, q + 4); }   // tile 2 starts 4 cells right of tile 1
  L.blurRGB(g1, W, 1); L.blurRGB(g2, W, 1);
  let seam = 0; for (let r = 1; r < W - 1; r++) seam = Math.max(seam, Math.abs(g1[(r * W + 5) * 3] - g2[(r * W + 1) * 3])); ok(seam < 1e-6, 'shared interior column agrees (' + seam + ')');
}

// 4. shadow casters: an Ariel-shaped list (her real bind-pose extents, taken from the GLB in the headless run) drops the small accessories on phones / tablets, the scalp cap at ladder >= 1, nothing on desktop
{
  const E = { Ariel_Reach_ext007: 0.08, Ariel_Reach001: 3.22, Belt001: 0.59, Box_4001: 0.08, Box002: 0.08, Charm001: 0.06, Cone001: 0.07, Mesh_1: 0.4, Mesh_2: 0.27, Mesh003: 0.04, LED_L: 0.03, LED_R: 0.03, Pants: 1.74, Scalp: 0.38, Shirt: 0.92, Shoes: 0.5, Sphere002: 0.21, Tube_4001: 0.25, Tube021: 0.2, Tube022: 0.1, Tube023: 0.1 };
  const T = { Ariel_Reach_ext007: 696, Ariel_Reach001: 70281, Belt001: 2399, Box_4001: 2698, Box002: 2700, Charm001: 1800, Cone001: 749, Mesh_1: 4799, Mesh_2: 3600, Mesh003: 3668, LED_L: 22, LED_R: 22, Pants: 10798, Scalp: 42655, Shirt: 10654, Shoes: 5809, Sphere002: 8999, Tube_4001: 4199, Tube021: 4999, Tube022: 1971, Tube023: 1971 };
  const names = Object.keys(E), ext = names.map(k => E[k]), tris = names.map(k => T[k]), sum = a => a.reduce((s, x, i) => s + (x ? tris[i] : 0), 0);
  const all = sum(names.map(() => true)), d = L.casterSet(ext, 0, 0), m0 = L.casterSet(ext, 0.1, 0), m1 = L.casterSet(ext, 0.1, 1);
  ok(d.every(Boolean), 'desktop: every piece casts');
  console.log('her shadow casters (skinned tris): all ' + all + ', phone/tablet ' + sum(m0) + ' (-' + Math.round(100 * (1 - sum(m0) / all)) + ' %), ladder >= 1 ' + sum(m1) + ' (-' + Math.round(100 * (1 - sum(m1) / all)) + ' %)');
  ok(m0[names.indexOf('Ariel_Reach001')] && m0[names.indexOf('Pants')] && m0[names.indexOf('Shirt')] && m0[names.indexOf('Shoes')] && m0[names.indexOf('Belt001')], 'body / clothes / shoes / belt always cast');
  ok(!m0[names.indexOf('Sphere002')] && !m0[names.indexOf('Tube021')] && !m0[names.indexOf('Charm001')], 'small accessories do not');
  ok(m0[names.indexOf('Scalp')] && !m1[names.indexOf('Scalp')], 'scalp cap casts until the ladder asks for more');
  ok(sum(m0) <= all * 0.85 && sum(m1) <= all * 0.65, 'savings');
  ok(L.casterSet([], 0.1, 1).length === 0 && L.casterSet([0.001], 0.1, 1)[0] === true, 'never an empty set');
}

// 5. the budget ladder at the tablet's measured 4-7 fps (the user's Mars on v356 / v357): it reaches the floor within seconds with the production 36 ms budget, climbs in ladder order,
//    and the shadow stage is below the render-scale stages (so the sun-shadow cadence, now real, is shed before resolution)
{
  const { createController, LADDER, MAX } = B;
  for (const fps of [4, 5, 7]) {
    const c = createController({ budgetMs: 36 }); c.seed(4, 0);   // a tablet seeds at the low-GPU class base (p 4)
    const ms = 1000 / fps; let t = 0, tShadow4 = -1, tFloor = -1, last = c.p;
    while (t < 60000) { t += ms; c.sample(ms, t); if (c.lv.shadow >= 4 && tShadow4 < 0) tShadow4 = t; if (c.p >= MAX && tFloor < 0) tFloor = t; if (c.p < last) throw new Error('went DOWN while over budget'); last = c.p; }
    console.log(fps + ' fps, seed p4: shadow stage 4 at ' + (tShadow4 / 1000).toFixed(1) + ' s, floor p' + c.p + ' at ' + (tFloor / 1000).toFixed(1) + ' s');
    ok(tShadow4 > 0 && tShadow4 < 12000, fps + ' fps: shadow L4 within 12 s (' + tShadow4 + ')'); ok(tFloor > 0 && tFloor < 20000, fps + ' fps: floor within 20 s (' + tFloor + ')');
  }
  const idx = (s, l) => LADDER.findIndex(x => x[0] === s && x[1] === l); ok(idx('shadow', 1) < idx('res', 1) && idx('shadow', 4) < idx('res', 1), 'shadow stages precede the render-scale stages');
  // a 30 fps-locked tablet that has been pushed down is NOT latched there: the meets-target recovery gives steps back (v353), checked here with the real core
  const c = createController({ budgetMs: 36, okFloor: 4 }); c.seed(4, 0); let t = 0; const slow = 1000 / 5; while (t < 6000) { t += slow; c.sample(slow, t); } const peak = c.p; ok(peak > 8, 'pushed down (' + peak + ')');
  while (t < 200000) { t += 33.3; c.sample(33.3, t); } ok(c.p < peak && c.p >= 4, 'a 30 fps-locked device recovers toward its class base: ' + peak + ' -> ' + c.p);
}

// 6. wiring in index.html: the sun's cadence is driven on the LIGHT (three r185 WebGPURenderer ignores renderer.shadowMap.autoUpdate / needsUpdate), SkyGround uses the class split scale, the colour blur and the half-res air are in
{
  const h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(/sl\.autoUpdate=false; if\(TERRAIN\._shRef\|\|!TERRAIN\._shInit\)\{ sl\.needsUpdate=true/.test(h), 'sun cadence drives TERRAIN.sun.shadow');
  ok(/const sl=TERRAIN\.sun&&TERRAIN\.sun\.shadow; if\(sl&&!\/\[\?&\]shadowcad=0/.test(h), '?shadowcad=0 kill switch');
  ok(/this\.K0=o\.k\|\|1\.8; this\.K=this\.K0;/.test(h) && /this\.K=this\.K0\*\(\(window\.DMLod&&DMLod\.on&&DMLod\.splitK\)\?DMLod\.splitK\(\):1\)/.test(h), 'SkyGround K scaled by DMLod.splitK');
  ok(/DMLod\.core\.blurRGB\(ext,GC,bpass,etmp\)/.test(h) && /DMLod\.blurPasses\(step\)/.test(h), 'far colour blur in SkyGround._build');
  ok(/DMLod\.applyCasters\(CHAR\.root/.test(h), 'caster policy applied in the world tick');
  ok(/atmohalf=0/.test(h) && /if\(GFX\.isMobile\)\{ let tab=false;[^\n]*tab=m>=600;[^\n]*return !tab; \}/.test(h), 'half-res air on PHONES only (t1644: tablets + desktops full-res)');
  ok(/const _fitNow=/.test(h), 'sun box held on stale-map frames');
}
console.log('perf-mars OK (' + n + ' checks)');
