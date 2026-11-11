// node tools/tests/spawn.js — the default spawn (interstellar, facing Sol) and the arrival push-out from every world's hand-off radius (ui/dm-spawn.js + the REAL
// placeSolSpawn / _dmClearOfWorlds / _dmApplySpawnAim from index.html).  Also checks the wiring: initFlightScene and the Sol-home rebuild use the new spawn,
// and the thresholds the policy must clear (PWS_OPEN / PWS_CLOSE, the atmosphere shell) are read from the page, not hard-coded here.
'use strict';
const fs = require('fs'), vm = require('vm');
const S = require('../../ui/dm-spawn.js'), H = require('../../ui/dm-pw-handoff.js');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const src = fs.readFileSync(__dirname + '/../../index.html', 'utf8');
const num = (re) => { const m = re.exec(src); if (!m) throw new Error(String(re)); return +m[1]; };
const AU = num(/const AU_UNITS = (\d+)/), VIS = num(/const PLANET_VIS_SCALE = (\d+)/), OPEN = num(/const PWS_OPEN=(\d+)/), CLOSE = num(/PWS_CLOSE=(\d+)/), NEP = num(/const NEP_ORBIT_AU = ([\d.]+)/);
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } }
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } }
// a Sol-like system in scene units: [name, orbit AU, angle, vis radius, landable]
const SYS = [['Mercury', .387, 1, 2.3, 1], ['Venus', .723, 2, 5.7, 1], ['Earth', 1, 3, 6, 1], ['Moon', 1, 3.002, 1.6, 1], ['Mars', 1.52, 4, 3.2, 1], ['Jupiter', 5.2, 5, 66, 0], ['Saturn', 9.58, 6, 55, 0], ['Uranus', 19.2, 0.4, 24, 0], ['Neptune', NEP, 1.3, 23, 0]];
const bodies = SYS.map(([name, au, a, r, land]) => ({ name, landable: land, collisionRadius: r, mesh: { position: new V3(Math.cos(a) * au * AU, 0, Math.sin(a) * au * AU) } }));
bodies.push({ name: 'Sun', type: 'Star', collisionRadius: 160, mesh: { position: new V3() } });
const ctx = { window: { DMSpawn: S }, THREE: { Vector3: V3 }, console, Math, AU_UNITS: AU, PLANET_VIS_SCALE: VIS, celestialBodies: bodies, STATE: { flight: { camYaw: 0, camPitch: 0, quat: 'x' } },
  isProximityLandEligible: (b) => b.name !== 'Sun' && b.type !== 'Star' && !!b.landable, _bodyR: (b) => b.collisionRadius || VIS, placeSolLeoOffset: () => new V3(1, 1, 1) };
ctx.window.window = ctx.window; vm.createContext(ctx);
vm.runInContext(['placeSolSpawn', '_dmClearOfWorlds', '_dmApplySpawnAim'].map(fn).join('\n'), ctx);
const run = (c) => vm.runInContext(c, ctx);
const landable = bodies.filter((b) => b.landable), toR = (p) => Math.min(...landable.map((b) => Math.hypot(p.x - b.mesh.position.x, p.y - b.mesh.position.y, p.z - b.mesh.position.z) / b.collisionRadius));

// 1. the default spawn
const p = run('placeSolSpawn()'), aim = ctx.window._dmSpawnAim;
ok(p instanceof V3 && isFinite(p.x + p.y + p.z), 'spawn is a finite Vector3');
ok(S.DEF.clearR > CLOSE && CLOSE > OPEN, 'clearR ' + S.DEF.clearR + ' R is past PWS_CLOSE ' + CLOSE + ' R and PWS_OPEN ' + OPEN + ' R');
ok(toR(p) > CLOSE * 20, 'spawn is ' + toR(p).toFixed(0) + ' planet radii from the nearest landable world (> 20x the close radius)');
const sh = DMshell(); ok(toR(p) > sh * 100, 'and ' + (toR(p) / sh).toFixed(0) + 'x the faded atmosphere perimeter (' + sh + ' R)');
function DMshell() { const A = require('../../ui/dm-atmo-shell.js'); const r = A.radii ? A.radii({ name: 'Solenne' }) : null; return Math.max(1.18, r && r.shell || 1); }
const dS = Math.hypot(p.x, p.y, p.z); ok(dS > NEP * AU && dS < 72 * AU, 'beyond Neptune (' + (dS / AU).toFixed(1) + ' AU > ' + NEP + ') and inside the Oort shell the sky builds (72 AU)');
ok(p.y > 0, 'above the ecliptic (whole system in view)');
// the camera faces Sol: forward from yaw/pitch (forward at 0,0 = -Z; pitch = asin(f.y); f = (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch))
const fwd = { x: -Math.sin(aim.yaw) * Math.cos(aim.pitch), y: Math.sin(aim.pitch), z: -Math.cos(aim.yaw) * Math.cos(aim.pitch) };
ok(fwd.x * -p.x / dS + fwd.y * -p.y / dS + fwd.z * -p.z / dS > 0.999999, 'camera forward points at Sol');
run('_dmApplySpawnAim()'); ok(Math.abs(ctx.STATE.flight.camPitch - aim.pitch) < 1e-12 && ctx.STATE.flight.quat === null && ctx.window._dmSpawnAim === null, 'aim applied once, quat reset');
// a planet on every side stays clear for any phase of the year (Earth at any angle)
for (let a = 0; a < 6.28; a += 0.1) { const ear = bodies[2].mesh.position; ear.set(Math.cos(a) * AU, 0, Math.sin(a) * AU); bodies[3].mesh.position.set(ear.x + 12, 0, ear.z); ok(toR(p) > CLOSE * 20, 'clear at Earth angle ' + a.toFixed(1)); }
// the hand-off policy itself says "no pre-build" at the spawn
{ const st = H.make(); H.step(st, toR(p), 1.18, VIS * 1); ok(!st.prebuild && !st.visible && st.reveal === 0, 'DMPwHandoff: no pre-build / no show at the spawn'); }
// fall back: no DMSpawn -> the old LEO placement (never throws)
ctx.window.DMSpawn = undefined; ok(run('placeSolSpawn()').x === 1, 'falls back to LEO if DMSpawn is missing'); ctx.window.DMSpawn = S;

// 2. arrivals are pushed out of every hand-off radius
const e = bodies[2].mesh.position; e.set(AU, 0, 0); bodies[3].mesh.position.set(AU + 14, 0, 0);
for (const [lbl, v] of [['inside Earth LEO', new V3(AU + 6.3, 0, 0)], ['5.5 R above Earth', new V3(AU + 33, 0, 0)], ['between Earth and its Moon', new V3(AU + 7, 0, 0)], ['at Earth centre', new V3(AU, 0, 0)], ['9 R (open edge)', new V3(AU + 54, 0, 0)], ['11 R (close edge)', new V3(AU + 66, 0, 0)]]) {
  const before = toR(v); ctx._v = v; run('_dmClearOfWorlds(_v)');
  ok(toR(v) >= S.DEF.clearR - 1e-6, lbl + ': ' + before.toFixed(2) + ' R -> ' + toR(v).toFixed(2) + ' R (>= ' + S.DEF.clearR + ')');
  ok(isFinite(v.x + v.y + v.z), lbl + ': finite');
}
{ const far = new V3(30000, 100, -5000), c = { x: far.x, y: far.y, z: far.z }; ctx._v = far; run('_dmClearOfWorlds(_v)'); ok(far.x === c.x && far.y === c.y && far.z === c.z, 'an arrival that is already clear is not moved'); }
{ const sv = ctx.celestialBodies; ctx.celestialBodies = []; const v = new V3(1, 2, 3); ctx._v = v; run('_dmClearOfWorlds(_v)'); ok(v.x === 1 && v.z === 3, 'no bodies: untouched'); ctx.celestialBodies = null; ctx._v = v; ok(run('_dmClearOfWorlds(_v)') === v, 'null bodies: no throw'); ctx.celestialBodies = sv; }
// a discovery / system arrival a few radii off a procedural planet (24 u from a 6 u world = 4 R) used to pre-build it
{ const w = { name: 'Veyra b', landable: 1, collisionRadius: 6, mesh: { position: new V3(2000, 0, 0) } }; ctx.celestialBodies = [w]; const v = new V3(2000 - 24, 0, 0); ctx._v = v; run('_dmClearOfWorlds(_v)'); ok(Math.hypot(v.x - 2000, v.y, v.z) / 6 >= S.DEF.clearR - 1e-6, 'discovery approach 24 u from a world is pushed out to clearR'); ctx.celestialBodies = bodies; }

// 3. wiring in the page
ok(/const leo=placeSolSpawn\(\);\s*\/\/ \(v314\)/.test(src), 'initFlightScene spawns with placeSolSpawn');
ok(/const leo=placeSolSpawn\(\);\s*\/\/ \(v314\) Sol home/.test(src), 'the Sol-home rebuild uses placeSolSpawn');
ok(/_dmClearOfWorlds\(STATE\.flight\.pos\)/.test(src) && (src.match(/_dmClearOfWorlds\(STATE\.flight\.pos\)/g) || []).length >= 3, 'system rebuilds + same-system discovery arrivals call _dmClearOfWorlds');
ok(/<script src="ui\/dm-spawn\.js\?v=\d+"><\/script>/.test(src), 'dm-spawn.js is loaded (synchronous, before the flight code)');
ok(!/const leo=placeSolLeoOffset\(\);\s*\n\s*flightCamera/.test(src), 'no default LEO spawn left in initFlightScene');
console.log(fails ? 'spawn: ' + fails + ' FAILED of ' + n : 'spawn: all ' + n + ' checks passed (spawn ' + (dS / AU).toFixed(1) + ' AU out, ' + toR(p).toFixed(0) + ' R from the nearest world)');
process.exit(fails ? 1 : 0);
