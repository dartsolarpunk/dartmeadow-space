// ui/dm-atmo-shell.js (v297): the faded atmosphere perimeter helper for the Solenne hand-off.  Pure core + browser glue under a fake window.
const assert = require('assert'), path = require('path');
const C = require('../../ui/dm-atmo-shell.js');
// userData readings: planetR + atmoTop (procedural / dusty shells), shellR fallback, non-atmosphere meshes ignored
assert(Math.abs(C.shellFromUserData({ jotsAtmo: true, planetR: 100, atmoTop: 18 }) - 1.18) < 1e-9);
assert(Math.abs(C.shellFromUserData({ jotsAtmo: true, planetR: 50, shellR: 58 }) - 1.16) < 1e-9);
assert.strictEqual(C.shellFromUserData({ planetR: 100, atmoTop: 18 }), null); assert.strictEqual(C.shellFromUserData(null), null); assert.strictEqual(C.shellFromUserData({ jotsAtmo: true }), null);
// fade: 1 = outer edge, 0 = surface, clamped
assert.strictEqual(C.withFade(1.18, 1), 1.18); assert.strictEqual(C.withFade(1.18, 0), 1); assert(Math.abs(C.withFade(1.2, 0.5) - 1.1) < 1e-9); assert.strictEqual(C.withFade(1.18, 7), 1.18); assert.strictEqual(C.withFade(1.18), 1.18);
// look table: Solenne (Habitable -> earth) 1.18, unknown kind -> other
const LOOK = { earth: { mul: 1.18 }, mars: { mul: 1.06 }, other: { mul: 1.10 } };
assert.strictEqual(C.lookMul('earth', LOOK), 1.18); assert.strictEqual(C.lookMul('habitable', LOOK), 1.18); assert.strictEqual(C.lookMul('zzz', LOOK), 1.10); assert.strictEqual(C.lookMul('titan', null), 1.22);
// scan: the outer shell wins when a planet carries two (GL fallback 1.16 + ray-marched 1.18)
const tree = (uds) => ({ traverse(f) { f({ userData: {} }); for (const u of uds) f({ userData: u }); } });
assert(Math.abs(C.scanShell(tree([{ jotsAtmo: true, planetR: 10, shellR: 11.6 }, { jotsAtmo: true, planetR: 10, atmoTop: 1.8 }])) - 1.18) < 1e-9);
assert.strictEqual(C.scanShell(tree([])), null);
// glue: radii / worldR / ratio, cache + forget, nothing built -> no cached guess, airless -> 1
globalThis.window = globalThis; globalThis._ATMO_LOOK = LOOK; delete require.cache[path.resolve(__dirname, '../../ui/dm-atmo-shell.js')]; require('../../ui/dm-atmo-shell.js');
const A = globalThis.DMAtmoShell, P = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); } });
let n = 0; const solenne = { type: 'Habitable', mesh: { position: P(0, 0, 0), traverse(f) { n++; f({ userData: { jotsAtmo: true, planetR: 500, atmoTop: 90 } }); } } };
assert(Math.abs(A.radii(solenne) - 1.18) < 1e-9); A.radii(solenne); assert.strictEqual(n, 1, 'one traverse, then cached');
assert(Math.abs(A.worldR(solenne, 2000) - 2360) < 1e-6); assert(A.ratio(solenne, P(0, 0, 9 * 2000), 2000) > 7, 'PWS_OPEN (9 R) is far outside the glow'); assert(A.ratio(solenne, P(0, 2300, 0), 2000) < 1, 'inside the shell');
A.forget(solenne); A.radii(solenne); assert.strictEqual(n, 2);
const bare = { type: 'Habitable' }; assert.strictEqual(A.radii(bare), 1.18); assert(!bare._dmAtmoShell, 'no mesh: not cached');
assert.strictEqual(A.radii({ type: 'Asteroid', mesh: { position: P(0, 0, 0), traverse() { } } }), 1); assert.strictEqual(A.ratio(null, P(0, 0, 0), 1), Infinity);
console.log('atmo-shell-unit OK (Solenne perimeter 1.18 R; PWS_OPEN 9 R = ' + A.ratio(solenne, P(0, 0, 18000), 2000).toFixed(2) + 'x the shell)');
