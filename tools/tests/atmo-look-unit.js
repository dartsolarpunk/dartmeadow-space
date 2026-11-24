// (v332) atmosphere shells: centred / sized on the body, Mars haze not green, surface air on the stretched ground, GPU buffer deferral.
// Pulls index.html's own look table + coefficient helpers (no copy), marches a CPU port of _jotsShellAtmoColor, and drives
// ui/dm-gpu-defer.js with a fake WebGPU backend.  node tools/tests/atmo-look-unit.js
const assert = require('assert'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = html.indexOf('const _ATMO_LOOK={'), b = html.indexOf('// (v332) ONE ray-march');
assert(a > 0 && b > a, 'look table block found');
const L = new Function(html.slice(a, b) + '\nreturn {_ATMO_LOOK,_atmoLookKey,_atmoLook,_atmoCoeffs};')();
const SHELL = require('../../ui/dm-atmo-shell.js');

// 1. size: every look's shell radius is the hand-off's documented perimeter, and the WebGPU shell uses radius x mul (not the MC grid half-extent)
for (const k of ['earth', 'mars', 'venus', 'titan', 'other']) assert.strictEqual(L._ATMO_LOOK[k].mul, SHELL.LOOK_FALLBACK[k], k + ' mul matches DMAtmoShell');
for (const [k, to] of [['habitable', 'earth'], ['ocean', 'earth'], ['desert', 'mars'], ['methane', 'titan'], ['volcanic', 'venus'], ['MARS', 'mars'], ['zzz', 'other'], ['', 'other']]) {
  assert.strictEqual(L._atmoLookKey(k), to, k); assert.strictEqual(SHELL.lookMul(k, L._ATMO_LOOK), L._ATMO_LOOK[to].mul, 'DMAtmoShell alias ' + k);
}
assert(/const ATMO_R=radius\*atmoMul;/.test(html), 'JOTS_PlanetAtmo shell = radius x look.mul');
assert(!/const ATMO_R=HALF\*atmoMul/.test(html), 'no shell sized on the marching-cubes half-extent');
assert(/_jotsShellAtmoColor\(radius,ATMO_R,/.test(html) && /_jotsShellAtmoColor\(R,ATMO_R,co,/.test(html), 'both shells share one march');
assert(/modelWorldMatrix\.mul\(vec4\(0,0,0,1\)\)/.test(html.slice(b, b + 4000)), 'shell centre read from its own world matrix');

// 2. colour: CPU port of _jotsShellAtmoColor (same steps / units / green cap)
const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]], dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2], add = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]], mul = (p, s) => [p[0] * s, p[1] * s, p[2] * s];
const rs = (rad, ro, rd) => { const b2 = 2 * dot(ro, rd), c = dot(ro, ro) - rad * rad, d = b2 * b2 - 4 * c; if (d < 0) return [0, 0, 0]; const s = Math.sqrt(d), n = (-b2 - s) / 2, f = (-b2 + s) / 2; if (f < 0) return [0, 0, 0]; const ds = Math.max(n, 0); return [ds, f - ds, 1]; };
function march(R, AR, co, cam, dir, sun, cap, VIEW = 4, SUN = 3, fall = 5.5) {
  const ex = co.ex.map(v => Math.max(1e-4, v)), ratio = co.sc.map((v, i) => v / ex[i]), iH = 1 / (AR - R);
  const dens = p => { const h01 = Math.min(1, Math.max(0, (Math.hypot(...p) - R) * iH)); return Math.exp(-h01 * fall) * (1 - h01); };
  const od = (ro, rd, rl) => { const st = rl / SUN; let p = ro.slice(), t = 0; for (let i = 0; i < SUN; i++) { t += dens(p) * st; p = add(p, mul(rd, st)); } return t; };
  const hit = rs(AR, cam, dir), surf = rs(R, cam, dir), len = surf[2] > 0.5 ? Math.min(hit[1], Math.max(0, surf[0] - hit[0])) : hit[1];
  const acc = [0, 0, 0]; if (hit[2] < 0.5) return acc;
  const st = len / VIEW; let p = add(cam, mul(dir, hit[0])), tv = 0;
  for (let i = 0; i < VIEW; i++) {
    const dT = dens(p) * st * iH, ts = od(p, sun, rs(AR, p, sun)[1]) * iH;
    for (let c = 0; c < 3; c++) acc[c] += (1 - Math.exp(-ex[c] * dT)) * ratio[c] * Math.exp(-ex[c] * (tv + ts));
    tv += dT; p = add(p, mul(dir, st));
  }
  return cap ? [acc[0], Math.min(acc[1], Math.max(acc[0], acc[2])), acc[2]] : acc;
}
function views(R, AR, co, cap) {   // limb from orbit + the sky from inside the air (atmospheric flight), sun overhead-ish
  const out = [], sun = [0, 0.6, 0.8].map(v => v / Math.hypot(0, 0.6, 0.8));
  const cam = [0, 0, 4 * R]; for (const bb of [0.95, 1.01, 1.03, 1.05]) { const d = sub([bb * R, 0, 0], cam), n = Math.hypot(...d); out.push(march(R, AR, co, cam, mul(d, 1 / n), sun, cap)); }
  for (const alt of [1.003, 1.02]) { const c2 = [0, R * alt, 0]; for (const el of [0, 5, 20, 60]) { const r = el * Math.PI / 180; out.push(march(R, AR, co, c2, [Math.cos(r), Math.sin(r), 0], [0, 1, 0], cap)); } }
  return out.filter(v => v[0] + v[1] + v[2] > 1e-4);
}
const R = 3.2, hue = v => v.map(x => x.toFixed(3)).join('/');
for (const k of ['mars', 'venus', 'titan']) {
  const look = L._ATMO_LOOK[k], vs = views(R, R * look.mul, L._atmoCoeffs(look), false);
  assert(vs.length >= 6, k + ' shell visible');
  for (const v of vs) { assert(v[0] >= v[1] && v[1] >= v[2], k + ' haze warm R>=G>=B (uncapped): ' + hue(v)); }
}
{ const look = L._ATMO_LOOK.earth, vs = views(R, R * look.mul, L._atmoCoeffs(look), true);
  for (const v of vs) assert(v[2] >= v[0] && v[1] <= Math.max(v[0], v[2]) + 1e-12, 'earth blue, never green: ' + hue(v)); }
{ const vs = views(R, R * 1.09, L._atmoCoeffs({}, 1.45, [0.8, 0.6, 0.4]), true);   // a giant: Rayleigh + palette tint
  for (const v of vs) assert(v[1] <= Math.max(v[0], v[2]) + 1e-12, 'giant: no green: ' + hue(v)); }
// the v329 Mars shell (Earth Rayleigh, world-unit linear depth, 1.378 R) DID read green-teal from inside: the regression this guards
{ const ray = [Math.pow(400 / 700, 4), Math.pow(400 / 530, 4), Math.pow(400 / 440, 4)].map(x => x * 1.55), AR = R * 1.3 * 1.06;
  const dens = p => { const h01 = Math.min(1, Math.max(0, (Math.hypot(...p) - R) / (AR - R))); return Math.exp(-h01 * 5.5) * (1 - h01); };
  const cam = [0, R * 1.003, 0], dir = [1, 0, 0], hit = rs(AR, cam, dir), st = hit[1] / 4; let p = add(cam, mul(dir, hit[0])), tv = 0; const o = [0, 0, 0];
  for (let i = 0; i < 4; i++) { const d = dens(p); tv += d * st; let ts = 0, q = p.slice(); const sl = rs(AR, p, [0, 1, 0])[1] / 3; for (let j = 0; j < 3; j++) { ts += dens(q) * sl; q = add(q, [0, sl, 0]); } for (let c = 0; c < 3; c++) o[c] += d * Math.exp(-ray[c] * (ts + tv)) * ray[c] * st; p = add(p, mul(dir, st)); }
  assert(o[1] > o[0], 'old Mars horizon was green-dominant (' + hue(o) + ')');
  const now = march(R, R * 1.06, L._atmoCoeffs(L._ATMO_LOOK.mars), cam, dir, [0, 1, 0], true); assert(now[0] > now[1] && now[1] > now[2], 'new Mars horizon butterscotch: ' + hue(now)); }

// 3. surface view: the PW frame stretches the ground east-west by g; marched with x / g the ground IS the sphere about _pwfCentre
{ const D = 0.008 * Math.PI / 180, RP = 360 / 0.008 / (2 * Math.PI);
  const map = (x, y, z, lat, g) => { const dp = -z * D, dl = x * D, phi = lat + dp, cp = Math.cos(phi), rh = RP + y, sl = Math.sin(lat), cl = Math.cos(lat), s2 = Math.sin(dl * 0.5), hl = 2 * s2 * s2, s3 = Math.sin(dp * 0.5), hp = 2 * s3 * s3;
    return [rh * cp * Math.sin(dl) * g, y - rh * (hp + cp * cl * hl), -rh * (Math.sin(dp) + cp * sl * hl)]; };
  for (const latd of [30, 60]) { const lat = latd * Math.PI / 180, g = 1 / Math.cos(lat);
    for (const [x, z] of [[3000, 0], [-3000, 0], [0, 3000], [2000, 2000]]) {
      const p = map(x, 0, z, lat, g), plain = Math.hypot(p[0], p[1] + RP, p[2]) - RP, sq = Math.hypot(p[0] / g, p[1] + RP, p[2]) - RP;
      assert(Math.abs(sq) < 2, `lat ${latd} (${x},${z}): ground on the squeezed sphere (${sq.toFixed(2)})`);
      if (x && latd === 60) assert(Math.abs(plain) > 100, 'unsqueezed, the air floor missed the ground by ' + plain.toFixed(0));
    } } }
assert(/A\.setAniso\(1\/_pwfAnisoG\(\)\)/.test(html) && /U\.ax\.value=1\/g/.test(html), 'surface passes take the stretch every frame');

// 4. ui/dm-gpu-defer.js (t1653 Track 4): parked, then destroyed at the top of a frame once >= MIN frames passed AND a fence issued after the release resolved; nothing allocated while idle
{ const G = require('../../ui/dm-gpu-defer.js');
  const q = G.createQueue(3), out = []; q.push('a', 0); q.push('b', 1); q.push(null, 1);
  assert.strictEqual(q.size(), 2); assert.strictEqual(q.take(2, out), 0); assert.strictEqual(q.take(3, out), 1); assert.deepStrictEqual(out, ['a']); assert.strictEqual(q.take(9, out), 1); assert.strictEqual(q.size(), 0);
  let destroyed = [], waits = [], data = new Map(), deleted = [];
  const buf = (n) => ({ n, destroy() { destroyed.push(n); } });
  const be = { device: { queue: { onSubmittedWorkDone() { return new Promise(r => waits.push(r)); } } }, get(k) { if (!data.has(k)) data.set(k, {}); return data.get(k); }, has(k) { return data.has(k); }, delete(k) { deleted.push(k); data.delete(k); } };
  const au = { backend: be, _getBufferAttribute(a) { return a.isInterleavedBufferAttribute ? a.data : a; }, destroyAttribute(a) { const d = be.get(this._getBufferAttribute(a)); d.buffer.destroy(); be.delete(a); } };
  const api = G.install({ backend: Object.assign(be, { attributeUtils: au }) }, { minFrames: 3 });
  assert(api && G.install({ backend: be }) === api, 'installs once');
  const A1 = {}, A2 = {}; be.get(A1).buffer = buf('A1'); be.get(A2).buffer = buf('A2');
  au.destroyAttribute(A1); assert.deepStrictEqual(destroyed, [], 'not destroyed on dispose'); assert.deepStrictEqual(deleted, [A1], 'three forgets it at once');
  api.tick(); assert.strictEqual(waits.length, 1, 'a fence is issued after the release');
  api.tick(); api.tick(); assert.strictEqual(waits.length, 1, 'one fence in flight at a time');
  au.destroyAttribute(A2); api.tick(); api.tick();
  assert.deepStrictEqual(destroyed, [], 'MIN frames passed but the fence has not resolved: nothing destroyed');
  waits[0]();
  setTimeout(() => {
    assert.deepStrictEqual(destroyed, [], 'fence resolved: still only destroyed at the top of a frame (tick), never from the promise');
    api.tick(); assert.deepStrictEqual(destroyed, ['A1'], 'destroyed after frames + fence; A2 (released after that fence) waits');
    assert.strictEqual(waits.length, 2); waits[1]();
    setTimeout(() => {
      api.tick(); api.tick();
      assert.deepStrictEqual(destroyed, ['A1', 'A2']); assert.strictEqual(api.pending(), 0);
      const w = waits.length; for (let i = 0; i < 50; i++) api.tick(); assert.strictEqual(waits.length, w, 'idle: no work');
      assert.throws(() => au.destroyAttribute({}), /destroy/, 'no buffer: falls through to three\'s own path unchanged');
      const mk = L._ATMO_LOOK.mars, mv = views(R, R * mk.mul, L._atmoCoeffs(mk), true);
      console.log('atmo-look-unit OK (Mars limb ' + hue(mv[1]) + ', shells radius x mul, surface air squeezed by 1/g, GPU buffers deferred)');
    }, 0);
  }, 0);
}
