// ui/dm-atmo-volume.js (v385): pure core — tier selection / phone ceiling / cost ordering, wake stamping + decay + packing, side/depth rule, wisp determinism and bounds, flag parsing, create() with no GPU.
const assert = require('assert');
const A = require('../../ui/dm-atmo-volume.js'), C = A.core;
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
// tiers: scattering-only at 0, wisps only from 2, phones capped at 1 under every preset, budget stage sheds, exhaustion = 0, force wins
ok(C.TIERS[0].wake === 0 && C.TIERS[0].wisps === 0, 'tier 0 = scattering-only shell');
ok(C.TIERS[1].wisps === 0 && C.TIERS[2].wisps > 0, 'wisps start at tier 2');
for (const p of ['low', 'medium', 'high', 'ultra', 'auto', undefined]) ok(C.tierFor({ mobile: true, preset: p }).id <= 1, 'phone / tablet ceiling at tier 1 (' + p + ')');
ok(C.tierFor({ mobile: false, preset: 'ultra' }).id === 3 && C.tierFor({ mobile: false, preset: 'high' }).id === 2 && C.tierFor({ mobile: false, preset: 'low' }).id === 0, 'desktop preset ladder');
ok(C.tierFor({ mobile: false, preset: 'ultra', budgetLvl: 2 }).id === 1 && C.tierFor({ mobile: false, preset: 'ultra', budgetLvl: 9 }).id === 0, 'DMBudget atmo stage sheds tiers, never below 0');
ok(C.tierFor({ mobile: true, preset: 'medium', budgetLvl: 1 }).id === 0, 'a pressured phone is scattering-only');
ok(C.tierFor({ mobile: false, preset: 'ultra', exhausted: true }).id === 0, 'exhausted ladder = tier 0');
ok(C.tierFor({ mobile: true, preset: 'low', force: 3 }).id === 3 && C.tierFor({ force: -4 }).id === 0, '?atmotier forces (clamped)');
// cost: strictly increasing with tier, and a phone's ceiling costs far less than desktop full
const c = C.TIERS.map(t => C.cost(t)); ok(c[0] < c[1] && c[1] < c[2] && c[2] < c[3], 'cost rises with tier'); ok(c[1] < c[3] * 0.4, 'phone ceiling (tier 1) < 40% of full');
// wake strength: full in the air, fades over 3 thicknesses above it, zero when still
ok(C.wakeStrength(0.5, 1, 10, 10) === 1 && C.wakeStrength(0.5, 1, 0, 10) === 0 && C.wakeStrength(0.5, 1, 5, 10) === 0.5, 'speed scales the wake');
ok(C.wakeStrength(4, 1, 10, 10) === 0 && C.wakeStrength(2, 1, 10, 10) > 0 && C.wakeStrength(2, 1, 10, 10) < 1, 'fades out beyond the shell');
ok(C.wakeStrength(-1, 1, 10, 10) === 1, 'on the ground (below the surface datum) still stirs the air');
ok(C.wakeStrength(1, 0, 10, 10) === 0 && C.wakeStrength(1, 1, NaN, 10) === 0, 'degenerate inputs give no wake');
// wake slots: merge, replace weakest, decay, spread, pack layout
const w = C.createWake(4); w.push(1, 0, 0, 1, 0.8); ok(w.live() === 1, 'one live slot'); w.push(1.1, 0, 0, 1, 0.5); ok(w.live() === 1 && w.s[0] >= 0.8, 'a close push merges and never weakens a strong slot');
w.push(5, 0, 0, 1, 0.4); w.push(0, 5, 0, 1, 0.3); w.push(0, 0, 5, 1, 0.2); ok(w.live() === 4, 'four slots');
w.push(0, 0, -9, 1, 0.9); ok(w.live() === 4 && Math.max.apply(null, Array.from(w.s)) > 0.89 && !Array.from(w.s).some(v => Math.abs(v - 0.2) < 1e-6), 'a fifth replaces the weakest (0.2)');
const before = w.s[0], r0 = w.r[0]; w.step(1, 2.5, 0.1); ok(w.s[0] < before && Math.abs(w.s[0] - before * Math.exp(-0.4)) < 1e-6 && w.r[0] > r0, 'exponential decay + spread');
for (let i = 0; i < 40; i++) w.step(1, 2.5, 0); ok(w.live() === 0, 'everything decays to zero (slots free up)');
w.push(2, 3, 4, 0.5, 1); const out = w.pack(new Float32Array(32)); ok(out.length === 32, 'pack size 2 vec4 per slot');
const k = Array.from(w.s).indexOf(1); ok(out[k * 8] === 2 && out[k * 8 + 1] === 3 && out[k * 8 + 2] === 4 && Math.abs(out[k * 8 + 3] - 4) < 1e-6 && out[k * 8 + 4] === 1, 'pack: [x,y,z,1/r^2],[strength]');
ok(C.createWake(99).n === 4 && C.createWake(0).n === 4, 'slot count clamps to MAX_WAKE');
// shell faces: outside = front faces + depth test (ships / temples occlude it); inside = back faces, no depth test
let s = C.shellSideFor(2, 1.2); ok(!s.inside && s.side === 'front' && s.depthTest, 'outside: front + depth'); s = C.shellSideFor(1.1, 1.2); ok(s.inside && s.side === 'back' && !s.depthTest, 'inside: back, no depth test');
// coefficients: Rayleigh 1/lambda^4 (blue scatters most), explicit co passes through
const rl = C.rayleigh(1); ok(rl[2] > rl[1] && rl[1] > rl[0], 'blue > green > red'); const co = { sc: [1, 2, 3], ex: [1, 1, 1] }; ok(C.coefficients({ co }) === co, 'explicit coefficients kept'); ok(C.coefficients({}).ex.length === 3, 'default coefficients');
// wisps: deterministic, inside the air, biased to the surface
let low = 0, N = 640; for (let i = 0; i < N; i++) { const p = C.wispPos(i, 12.5, 100, 10), r = Math.hypot(p.x, p.y, p.z); ok(r >= 100 && r <= 111, 'wisp ' + i + ' inside the air (' + r + ')'); if (p.alt < 0.3) low++; }
ok(low > N * 0.4, 'wisps biased toward the surface (' + low + '/' + N + ')'); const a = C.wispPos(7, 3, 100, 10), b = C.wispPos(7, 3, 100, 10); ok(a.x === b.x && a.y === b.y, 'deterministic');
const p0 = C.wispPos(7, 0, 100, 10), p1 = C.wispPos(7, 60, 100, 10); ok(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) > 0.5, 'wisps drift over time');
// flag + no-GPU safety: off by default, ?atmo=shell on, ?atmo=0 off, create() with an empty THREE returns null (caller keeps its classic shell)
const off = A.enabled(); ok(off === false, 'off by default');
globalThis.location = { search: '?atmo=shell' }; ok(A.enabled() === true, '?atmo=shell'); globalThis.location = { search: '?x=1&atmo=0' }; ok(A.enabled() === false, '?atmo=0');
globalThis.DM_ATMO_SHELL_DEFAULT = true; globalThis.location = { search: '' }; ok(A.enabled() === true, 'default-on switch'); globalThis.location = { search: '?atmo=0' }; ok(A.enabled() === false, '?atmo=0 beats the default'); delete globalThis.DM_ATMO_SHELL_DEFAULT; delete globalThis.location;
ok(A.create({}, {}, { R: 1 }) === null && A.create(null, null) === null, 'no node material support: null, no throw');
ok(A.deviceTier().id >= 0, 'deviceTier without a window GFX');
console.log('atmo-volume-unit OK (' + n + ' checks; tiers ' + C.TIERS.map(t => t.name + ' cost ' + C.cost(t).toFixed(0)).join(', ') + ')');
