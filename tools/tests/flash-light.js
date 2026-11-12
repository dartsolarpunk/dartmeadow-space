// node tools/tests/flash-light.js — the flashlight as a REAL spotlight (ui/dm-flash.js): lights + shadows + volumetric beam, tiers, flags, hooks.
// Part 1 (three.core only): flags / tiers, the cone maths (ray vs solid cone, brute-forced), shadow config (map size per tier, tight near/far through the
//   updateMatrices override, bias, PCF, only updated on request, cadence per tier, zero work while off, auto-degrade governor), cone presets, the shared
//   interface (DMFlash.cone / sceneLight / hooks / medium), no allocation in the shadow/beam helpers, and the hooks in index.html / dm-light.js /
//   dm-mansion-look.js / dm-bt-lighting.js.
// Part 2 (needs the three.webgpu build; SKIP if absent): builds the real WGSL of a shadow-receiving lit mesh and of the beam cone with a stub renderer (no GPU):
//   the spot's shadow filter sits in a uniform branch, the beam shader compiles at every tier. NOTHING here ran on a GPU.
// three.js: THREE_CORE=/path/to/three.core.js (+ THREE_WEBGPU=/path/to/three.webgpu.js for part 2), else /workspace/three185, else node_modules/three; SKIP (exit 0) if none.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const cands = [process.env.THREE_CORE, '/workspace/three185/three.core.js', path.join(root, 'node_modules/three/build/three.core.js')].filter(Boolean);
const tp = cands.find(p => fs.existsSync(p));
if (!tp) { console.log('flash-light: SKIP (no three.core.js; set THREE_CORE)'); process.exit(0); }
const wcands = [process.env.THREE_WEBGPU, '/workspace/three185/three.webgpu.js', path.join(root, 'node_modules/three/build/three.webgpu.js')].filter(Boolean);
const wp = wcands.find(p => fs.existsSync(p));
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const src = fs.readFileSync(path.join(root, 'ui/dm-flash.js'), 'utf8');
(async () => {
  const THREE = await import(tp);
  globalThis.window = globalThis; globalThis.location = { search: '' }; globalThis.THREE = THREE;
  require('../../ui/dm-flash.js'); const F = globalThis.DMFlash, S = F.S;

  // ── flags
  let f = F.readFlags('');
  ok(f.light && f.shadow && f.size === 0 && f.beam === 1 && f.tier === '' && f.bias === -0.0004, 'defaults: light, shadow, beam on; tier auto');
  ok(F.readFlags('?flashshadow=0').shadow === false && F.readFlags('?x=1&flashshadow=off').shadow === false, '?flashshadow=0 / off disables the shadow');
  ok(F.readFlags('?flashshadow=1024').size === 1024 && F.readFlags('?flashshadow=99999').size === 4096 && F.readFlags('?flashshadow=1').size === 0, '?flashshadow=<size> sets / clamps the map');
  ok(F.readFlags('?flashbeam=0').beam === 0 && F.readFlags('?flashbeam=2.5').beam === 2.5 && F.readFlags('?flashbeam=99').beam === 8, '?flashbeam=0 / k');
  ok(F.readFlags('').beamForce === false && F.readFlags('?flashbeam=auto').beamForce === false && F.readFlags('?flashbeam=1.5').beamForce === true, '?flashbeam: auto (yield to DMVLight) unless a number forces it');
  ok(F.readFlags('?flashlight=0').light === false, '?flashlight=0 turns the feature off');
  ok(F.readFlags('?flashtier=phone').tier === 'phone' && F.readFlags('?flashtier=bogus').tier === '', '?flashtier=low|phone|desktop');
  ok(F.readFlags('?flashbias=-0.001').bias === -0.001, '?flashbias=');
  // ── tiers
  ok(F.pickTier({ preset: 'low', isMobile: false }, '', '') === 'low' && F.pickTier({ preset: 'medium', isMobile: true, shadowSize: 1024 }, '', '') === 'phone' && F.pickTier({ preset: 'high', isMobile: false, shadowSize: 2048 }, '', '') === 'desktop', 'tier from the graphics preset / device');
  ok(F.pickTier(null, 'Mozilla/5.0 (Linux; Android 14; SM-X) Mobile', '') === 'phone' && F.pickTier(null, 'Mozilla/5.0 (X11; Linux x86_64)', '') === 'desktop' && F.pickTier({ isMobile: false }, 'iPhone', 'low') === 'low', 'tier from the UA when no GFX; ?flashtier wins');
  const T3 = F.TIERS; ok(T3.low.map === 512 && T3.phone.map === 1024 && T3.desktop.map === 2048, 'shadow maps: 512 low / 1024 phones / 2048 desktop');
  ok(T3.phone.every === 2 && T3.low.every === 2 && T3.desktop.every === 1, 'phones refresh the shadow at half rate');
  ok(T3.phone.far <= 100 && T3.low.far <= T3.phone.far && T3.desktop.far <= 200, 'casters distance-limited per tier (' + [T3.low.far, T3.phone.far, T3.desktop.far] + ' m)');
  ok(T3.phone.steps <= 8 && T3.phone.noise === false && T3.desktop.noise === true, 'beam: <= 8 samples and no noise on phones');
  // ── cone maths (the shader mirrors coneInterval)
  { let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; let bad = 0, hit = 0;
    for (let it = 0; it < 6000; it++) {
      const A = [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2]; let a = [rnd() - .5, rnd() - .5, rnd() - .5]; const al = Math.hypot(a[0], a[1], a[2]); a = a.map(x => x / al);
      const cosO = Math.cos(0.1 + rnd() * 0.75), L = 1 + rnd() * 50, ro = [rnd() * 80 - 40, rnd() * 80 - 40, rnd() * 80 - 40]; let rd = [rnd() - .5, rnd() - .5, rnd() - .5];
      if (it % 2) rd = [A[0] + a[0] * L * rnd() - ro[0], A[1] + a[1] * L * rnd() - ro[1], A[2] + a[2] * L * rnd() - ro[2]]; const rl = Math.hypot(rd[0], rd[1], rd[2]); rd = rd.map(x => x / rl);
      const inside = t => { const p = [ro[0] + rd[0] * t - A[0], ro[1] + rd[1] * t - A[1], ro[2] + rd[2] * t - A[2]], s = p[0] * a[0] + p[1] * a[1] + p[2] * a[2]; return s >= 0 && s <= L && s >= Math.hypot(p[0], p[1], p[2]) * cosO; };
      let lo = null, hi = null; for (let i = 0; i <= 3000; i++) { const t = i / 3000 * 120; if (inside(t)) { if (lo === null) lo = t; hi = t; } }
      const r = F.coneInterval(ro, rd, A, a, cosO, L, 1e3);
      if (lo === null) { if (r && r[1] - r[0] > 0.1 && r[0] < 120) bad++; } else { hit++; if (!r || Math.abs(r[0] - lo) > 0.1 || (r[1] < 119 && Math.abs(r[1] - hi) > 0.1)) bad++; }
    }
    ok(bad === 0 && hit > 1500, 'coneInterval = brute-force sampling of the solid cone (' + hit + ' crossing rays, ' + bad + ' mismatches)'); }
  ok(F.coneInterval([0, 0, -5], [0, 0, 1], [0, 0, 0], [0, 0, 1], Math.cos(0.6), 30, 1e3)[1] > 29.99, 'looking along the axis from behind: inside up to the cap');
  ok(F.coneInterval([1, 20, 5], [0, -1, 0], [0, 0, 0], [0, 0, 1], Math.cos(0.3), 30, 1e3) !== null && F.coneInterval([1, 20, 0.1], [0, -1, 0], [0, 0, 0], [0, 0, 1], Math.cos(0.3), 30, 1e3) === null, 'a ray across the cone near the apex misses it, further out hits');
  ok(F.phase(1) > F.phase(-1) && Math.abs(F.phase(0, 0) - 1) < 1e-9, 'forward-scatter phase (isotropic = 1)');
  ok(F.densityFor('space', 0) < F.densityFor('walk', 0) / 5 && F.densityFor('walk', 200) > F.densityFor('walk', 900) && F.densityFor('walk', 0, 2, 0.001) > F.densityFor('walk', 0), 'air density: ~nothing in space, thicker with haze, the medium hooks scale it');

  // ── lights + shadows on real three objects
  const hooks = { isMobile: false, preset: 'high', shadowSize: 2048 }; F.hooks.gfx = () => hooks;
  const mk = () => { const sc = new THREE.Scene(); const led = new THREE.Object3D(); sc.add(led); sc.updateMatrixWorld(true); return { sc, led }; };
  let A = mk(); F.adoptScene(A.sc); S.led = A.led; S.built = true;
  let L = F.sceneLight(A.sc); ok(L && L.isSpotLight && L.castShadow && L.userData.dmFlash, 'adoptScene: one shadow-casting spot, tagged dmFlash');
  ok(F.sceneLight(new THREE.Scene()) === null, 'sceneLight(unknown scene) = null (no light invented)');
  ok(L.shadow.mapSize.x === 2048 && L.shadow.mapSize.y === 2048, 'desktop: 2048 shadow map');
  ok(L.shadow.autoUpdate === false && L.shadow.needsUpdate === false, 'shadow is only rendered on request (autoUpdate false)');
  ok(L.shadow.bias < 0 && L.shadow.bias > -0.01 && L.shadow.normalBias > 0, 'bias tuned against acne (bias ' + L.shadow.bias + ', normalBias ' + L.shadow.normalBias + ')');
  ok(L.shadow.camera.near >= 0.2 && L.shadow.camera.near <= 1, 'shadow near plane tight (' + L.shadow.camera.near + ' m)');
  { L.shadow.updateMatrices(L); const cam = L.shadow.camera; ok(Math.abs(cam.far - Math.min(F.TIERS.desktop.far, F.PROF.ground.distance)) < 1e-9 && L.distance === F.PROF.ground.distance, 'shadow far = tier reach (' + cam.far + ' m) while the light keeps its own range (' + L.distance + ' m)');
    ok(Math.abs(cam.fov - 2 * L.angle * 180 / Math.PI) < 1e-6, 'shadow frustum = the cone'); }
  // off: zero work
  F.toggle(false); for (let i = 0; i < 30; i++) F.tick('walk'); ok(L.shadow.needsUpdate === false && S.shUpdates === 0 && F.cone().on === false && L.intensity === 0, 'off: no shadow update, no light (zero cost)');
  // on: desktop updates every frame
  S.t = 0; F.toggle(true); const u0 = S.shUpdates; for (let i = 0; i < 60; i++) { F.tick('walk'); L.shadow.needsUpdate = false; }   // (the renderer clears needsUpdate after rendering)
  ok(S.shUpdates - u0 === 60, 'desktop: shadow refreshed every frame (' + (S.shUpdates - u0) + '/60)');
  { const c = F.cone(); ok(c.on && c.shadow.on && Math.abs(Math.hypot(c.dir.x, c.dir.y, c.dir.z) - 1) < 1e-6 && Math.abs(c.cosOuter - Math.cos(L.angle)) < 1e-9 && c.cosInner > c.cosOuter && c.range === L.distance && c.shadow.size === 2048 && c.shadow.light === L, 'DMFlash.cone(): apex / axis / cos angles / range / shadow map for the fog / mist / atmosphere passes'); }
  // phone tier: half rate, 1024, 100 m
  hooks.isMobile = true; hooks.preset = 'medium'; hooks.shadowSize = 1024; F.toggle(false); F.tick('walk');
  let B = mk(); F.adoptScene(B.sc); const LB = F.sceneLight(B.sc); S.led = B.led;
  ok(S.tierName === 'phone' && LB.shadow.mapSize.x === 1024, 'phone tier: 1024 map');
  S.t = 0; F.toggle(true); { const u1 = S.shUpdates; for (let i = 0; i < 60; i++) { F.tick('walk'); LB.shadow.needsUpdate = false; } const d = S.shUpdates - u1; ok(d >= 30 && d <= 32, 'phone: shadow at half rate (' + d + '/60 frames)'); }
  LB.shadow.updateMatrices(LB); ok(LB.shadow.camera.far === 100, 'phone: casters limited to 100 m');
  F.tick('space'); ok(LB.distance === F.PROF.space.distance && S.shFar <= F.PROF.space.shFar && LB.shadow.camera.near === F.PROF.space.shNear, 'space profile: far light reach, short shadow range (' + S.shFar + ')');
  F.tick('walk'); ok(LB.distance === F.PROF.ground.distance && S.shFar === 100, 'back to the ground profile');
  // DMBudget can slow it down further
  globalThis.DMBudget = { on: true, shadowHalf: () => true, shadowEvery: () => 3 }; { const u2 = S.shUpdates; for (let i = 0; i < 60; i++) { F.tick('walk'); LB.shadow.needsUpdate = false; } const d = S.shUpdates - u2; ok(d >= 19 && d <= 22 && LB.shadow.mapSize.x === 512, 'DMBudget: every 3rd frame (' + d + '/60) and the map halves (512)'); } delete globalThis.DMBudget;
  // frame-time governor: slow frames -> cadence, then shadows off (cone only), then back
  S.dtEma = 60; S.t = 0; F.tick('walk'); { const u3 = S.shUpdates; for (let i = 0; i < 30; i++) { S.dtEma = 60; F.tick('walk'); LB.shadow.needsUpdate = false; } ok(S.shUpdates - u3 <= 11, 'frame > 55 ms: shadow every 3rd frame (' + (S.shUpdates - u3) + '/30)'); }
  S.slow = 100; S.dtEma = 90; F.tick('walk'); ok(S.autoOff === 1 && F.status().shadowOn === false && LB.intensity > 0, 'frame > 70 ms for 90 frames: shadows switch off, the light stays on');
  { const u4 = S.shUpdates; for (let i = 0; i < 20; i++) { S.dtEma = 90; F.tick('walk'); } ok(S.shUpdates === u4 && LB.shadow.needsUpdate === false, 'auto-off: no shadow work at all'); }
  S.fast = 600; S.dtEma = 10; F.tick('walk'); ok(S.autoOff === 0 && S.retry === 1, 'recovers after ~10 s of good frames (one retry)');
  F.setShadows(false); F.tick('walk'); ok(F.status().shadowOn === false, 'setShadows(false)'); F.setShadows(true); S.dtEma = 16;
  // cone presets
  F.toggle(true); S.cone = 0; F.setCone(0); F.tick('walk'); const deg = x => x * 180 / Math.PI; const i0 = LB.intensity;
  ok(Math.abs(deg(LB.angle) - 35) < 0.5 && LB.penumbra >= 0.7, 'wide: 35 deg half-angle, soft penumbra');
  F.setCone(1); F.tick('walk'); ok(Math.abs(deg(LB.angle) - 23.1) < 0.7 && LB.intensity > i0, 'medium ~23 deg, brighter on axis');
  F.setCone(2); F.tick('walk'); ok(Math.abs(deg(LB.angle) - 12) < 0.7 && LB.intensity > i0 * 1.5, 'spot ~12 deg'); LB.shadow.updateMatrices(LB); ok(Math.abs(LB.shadow.camera.fov - 2 * deg(LB.angle)) < 1e-6, 'the shadow frustum follows the cone preset');
  ok(F.setCone(99) === 'spot' && F.setCone(-1) === 'wide', 'cone index clamps'); F.setCone(0);
  // scene hand-over leaves nothing lit / shadowed
  S.led = A.led; F.tick('walk'); ok(F.sceneLight(A.sc).intensity > 0 && LB.intensity === 0, 'hand-over: the other scene goes dark');
  F.toggle(false); F.tick('walk'); ok(F.sceneLight(A.sc).intensity === 0 && LB.shadow.needsUpdate === false, 'off again: dark, no shadow update');
  // ?flashshadow=0 never creates a shadow
  location.search = '?flashshadow=0'; { const Z = mk(); F.adoptScene(Z.sc); const LZ = F.sceneLight(Z.sc); ok(LZ.castShadow === false, '?flashshadow=0: castShadow false (no map, no shader branch)'); }
  location.search = '?flashlight=0'; { const Z = mk(); ok(F.adoptScene(Z.sc) === false && F.sceneLight(Z.sc) === null, '?flashlight=0: no light is created'); }
  location.search = '?flashshadow=1024&flashtier=low'; { const Z = mk(); F.adoptScene(Z.sc); const LZ = F.sceneLight(Z.sc); ok(LZ.shadow.mapSize.x === 1024 && S.tierName === 'low', '?flashshadow=1024 overrides the tier size'); }
  location.search = '';

  { const Z = mk(); F.adoptScene(Z.sc); const LZ = F.sceneLight(Z.sc), n0 = S.pairs.length; ok(F.releaseScene(Z.sc) === true && F.sceneLight(Z.sc) === null && S.pairs.length === n0 - 1 && LZ.parent === null && F.releaseScene(Z.sc) === false, 'releaseScene: the closed scene\'s pair is dropped (light removed, no reference kept)'); }
  // ── no allocation in the per-frame helpers
  const body = nm => { const i = src.indexOf('function ' + nm + '('); let d = 0, j = src.indexOf('{', i); const st = j; for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } } return src.slice(st, j + 1).replace(/\/\/.*$/gm, ''); };
  for (const nm of ['governor', 'shadowStep', 'beamStep', 'darkAll', 'applyProf', 'intensityNow']) { const b = body(nm); ok(b.length > 20 && !/\bnew\s|\[\s*\]|\{\s*\}/.test(b.replace(/catch \(e\) \{ \}/g, '')), nm + '(): no new / array / object literal'); }
  ok(!/localStorage|sessionStorage|indexedDB/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'session only: no storage');

  // ── (v322) aim, shadow floor, debug flag, the material audit (which families RECEIVE the spot)
  { hooks.isMobile = false; hooks.preset = 'high'; hooks.shadowSize = 2048; location.search = ''; F.refreshTier(); const Z = mk(); F.adoptScene(Z.sc); const LZ = F.sceneLight(Z.sc); S.led = Z.led; Z.led.rotation.y = Math.PI; Z.sc.updateMatrixWorld(true); F.toggle(true); S.t = 0; F.tick('walk');
    const c = F.cone(); ok(c.dir.y < -0.12 && c.dir.y > -0.22 && Math.abs(Math.hypot(c.dir.x, c.dir.y, c.dir.z) - 1) < 1e-9 && c.dir.z < -0.9, 'on foot the beam is aimed ~10 deg DOWN from the glasses axis (dir.y ' + c.dir.y.toFixed(3) + '): a horizontal axis at head height lights the ground only as a thin wedge');
    F.tick('space'); ok(Math.abs(F.cone().dir.y) < 1e-9, 'open space: no tilt (axis = glasses forward)'); F.tick('walk');
    ok(LZ.shadow.intensity > 0.5 && LZ.shadow.intensity < 1, 'shadow intensity < 1 (' + LZ.shadow.intensity + '): a shadowed pixel keeps some light, a shadow failure can never black a surface out');
    ok(S.biasK > 0 && S.biasK < 0.05 && S.biasM > 0, 'distance-proportional shadow bias (' + S.biasK + ' x d + ' + S.biasM + ' m)');
    ok(F.readFlags('?flashdebug=1').debug === true && F.readFlags('').debug === false && F.readFlags('?flashtilt=0').tilt === 0 && Math.abs(F.readFlags('?flashtilt=20').tilt - 20 * Math.PI / 180) < 1e-9 && F.readFlags('?flashbiask=0.03').biasK === 0.03, '?flashdebug=1 / ?flashtilt=deg / ?flashbiask=k flags');
    // audit: a lit material reaches the spot through the scene list, a private list only when it holds THIS scene's spot; unlit types never
    const sc = Z.sc, mkm = (M, n) => { const m = new M(); m.name = n; return m; }, add = (m, n, rs) => { const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m); o.name = n || ''; o.receiveShadow = !!rs; sc.add(o); return o; };
    const lit = mkm(THREE.MeshStandardMaterial, 'terrain'), basic = mkm(THREE.MeshBasicMaterial, 'sky'), priv = mkm(THREE.MeshStandardMaterial, 'atlas'), stale = mkm(THREE.MeshStandardMaterial, 'oldatlas'), good = mkm(THREE.MeshStandardMaterial, 'goodatlas'), off = mkm(THREE.MeshStandardMaterial, 'nolights');
    const otherScene = mk(); F.adoptScene(otherScene.sc); const LO = F.sceneLight(otherScene.sc);
    priv.lightsNode = { getLights: () => [new THREE.AmbientLight(0xffffff, 1)] }; stale.lightsNode = { getLights: () => [LO] }; good.lightsNode = { getLights: () => [new THREE.AmbientLight(0xffffff, 1), LZ] }; off.lights = false;
    add(lit, 'a', true); add(lit, 'b', true); add(basic, 'c'); add(priv, 'd'); add(stale, 'e'); add(good, 'f'); add(off, 'g'); add(new THREE.SpriteMaterial(), 'h'); sc.add(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()));
    const R = F.audit(sc), by = {}; for (const f of R.families) by[f.family] = f;
    ok(R.spot && R.spotOn && by['MeshStandardMaterial "terrain"'] && by['MeshStandardMaterial "terrain"'].ok && by['MeshStandardMaterial "terrain"'].n === 2 && by['MeshStandardMaterial "terrain"'].receiveShadow === 2, 'audit: scene-list material receives the spot (family counted x2)');
    ok(by['MeshBasicMaterial "sky"'] && !by['MeshBasicMaterial "sky"'].ok && /unlit/.test(by['MeshBasicMaterial "sky"'].why), 'audit: MeshBasic is BLIND (unlit)');
    ok(!by['MeshStandardMaterial "atlas"'].ok && /WITHOUT/.test(by['MeshStandardMaterial "atlas"'].why), 'audit: a private list without the spot is BLIND');
    ok(!by['MeshStandardMaterial "oldatlas"'].ok && /ANOTHER scene/.test(by['MeshStandardMaterial "oldatlas"'].why), 'audit: a private list holding ANOTHER scene\'s spot (the stale mansion atlas bug) is BLIND and says so');
    ok(by['MeshStandardMaterial "goodatlas"'].ok && /includes the flashlight/.test(by['MeshStandardMaterial "goodatlas"'].why), 'audit: a private list that holds this scene\'s spot is LIT');
    ok(!by['MeshStandardMaterial "nolights"'].ok && !by['SpriteMaterial "h"'].ok && !by['PointsMaterial "?"'].ok, 'audit: lights=false / sprite / points are BLIND');
    ok(R.blind === 6 && R.lit === 3 && R.families[0].ok === false, 'audit: totals + BLIND families sorted first (' + R.lit + ' lit, ' + R.blind + ' blind)');
    const logs = []; const ci = console.info, cw = console.warn; console.info = (...a) => logs.push('I ' + a.join(' ')); console.warn = (...a) => logs.push('W ' + a.join(' ')); F.auditLog(sc, 'test'); console.info = ci; console.warn = cw;
    ok(logs.length === R.families.length + 1 && /\[flashdebug\]/.test(logs[0]) && logs.filter(l => /^W .*BLIND/.test(l)).length === R.families.filter(f => !f.ok).length, '?flashdebug console report: header + one line per family, BLIND ones as warnings');
    ok(F.audit(new THREE.Scene()) && F.audit(new THREE.Scene()).spot === false && !F.receives(lit, null, sc).ok, 'audit: a scene without a spot reports spot=false, nothing lit');
    F.toggle(false); F.tick('walk'); F.releaseScene(otherScene.sc); }
  // ── hooks in the shared files
  const rd = p => fs.readFileSync(path.join(root, p), 'utf8');
  ok(/s && s\.dmFlashShadow \? s :/.test(rd('ui/dm-light.js')) && (rd('ui/dm-light.js').match(/dmFlashShadow/g) || []).length >= 4, 'dm-light.js: the sun-visibility shadow wrapper skips the flashlight shadow (all 4 branches)');
  ok(/withFlash && o\.isSpotLight && o\.userData && o\.userData\.dmFlash/.test(rd('ui/dm-mansion-look.js')) && /lightList\(ctx, true\)/.test(rd('ui/dm-mansion-look.js')), 'dm-mansion-look.js: the atlas light list includes the flashlight (not the probe-scaled list)');
  ok(/S\.atlasLightArr/.test(rd('ui/dm-mansion-look.js')) && /l === S\.atlasLightArr\[i\]/.test(rd('ui/dm-mansion-look.js')), 'dm-mansion-look.js: the shared atlas rebuilds its light list when the world scene (and so its spot) changes');
  ok(/DMFlash\.sceneLight\(flightScene\)/.test(rd('ui/dm-bt-lighting.js')), 'dm-bt-lighting.js: Bird Temple hull + interior lists include the flashlight');
  ok(/DMFlash\.hooks\.gfx=\(\)=>GFX/.test(rd('index.html')) && /DMFlash\.hooks\.depthOK=_viewportDepthOK/.test(rd('index.html')), 'index.html: GFX / depth / log-depth hooks before the first adoptScene');
  // the TSL shadow node class stays tagged + branch-gated in source
  ok(/o\.dmFlashShadow = true/.test(src) && /TS\.If\(U\.shOn\.greaterThan\(0\.5\)/.test(src), 'dm-flash.js: shadow node tagged and its filter gated by the shOn uniform');

  // ── part 2: real WGSL with a stub renderer (no GPU)
  if (wp) {
    const NS = await import(wp); const T2 = Object.assign({}, NS); T2.TSL = NS.TSL; globalThis.THREE = T2;
    delete require.cache[require.resolve('../../ui/dm-flash.js')]; delete globalThis.DMFlash; require('../../ui/dm-flash.js');   // a fresh module bound to the webgpu build (TSL)
    const F = globalThis.DMFlash, S = F.S, hooks = { isMobile: false, preset: 'high', shadowSize: 2048 }; F.hooks.gfx = () => hooks;
    globalThis.document = { createElementNS: () => ({ style: {}, addEventListener() { }, removeEventListener() { }, getContext() { return null; }, setAttribute() { }, width: 1, height: 1 }) };
    const rer = new T2.WebGPURenderer(); rer.hasCompatibility = () => true; rer.hasFeature = () => true; rer.backend.renderer = rer; rer.shadowMap.enabled = true; rer.shadowMap.type = T2.PCFSoftShadowMap; rer.logarithmicDepthBuffer = true;
    const wgsl = (obj, scn, cam, lights) => { const b = new T2.WGSLNodeBuilder(obj, rer); b.scene = scn; b.material = obj.material; b.camera = cam; b.context.material = obj.material; b.lightsNode = NS.TSL.lights(lights); b.build(); return b.fragmentShader; };
    for (const ph of [false, true]) {
      hooks.isMobile = ph; hooks.preset = ph ? 'medium' : 'high'; hooks.shadowSize = ph ? 1024 : 2048; F.hooks.depthOK = () => true; F.hooks.logDepth = () => true;
      const sc = new T2.Scene(); sc.fog = new T2.Fog(0x888888, 40, 900); F.adoptScene(sc); const led = new T2.Object3D(); sc.add(led); sc.updateMatrixWorld(true); S.led = led; S.built = true; S.beam = undefined;
      F.toggle(true); F.tick('walk'); F.tick('walk');
      const Ls = F.sceneLight(sc), P = S.pairs[S.pairs.length - 1];
      ok(Ls.shadow.shadowNode && Ls.shadow.shadowNode.isShadowNode, (ph ? 'phone' : 'desktop') + ': custom shadow node installed on the spot');
      const cam = new T2.PerspectiveCamera(60, 1, 0.1, 5000), ground = new T2.Mesh(new T2.PlaneGeometry(10, 10), new T2.MeshStandardNodeMaterial()); ground.receiveShadow = true; sc.add(ground);
      const sun = new T2.DirectionalLight(0xffffff, 1); sun.castShadow = true; sc.add(sun); sc.updateMatrixWorld(true);
      let w = ''; try { w = wgsl(ground, sc, cam, [Ls, sun]); } catch (e) { console.log('   ' + e.message); }
      ok(w.length > 1000 && /if \( \( object\.nodeUniform\d+ > 0\.5 \) \)/.test(w) && /textureGatherCompare/.test(w), (ph ? 'phone' : 'desktop') + ': lit mesh WGSL has the spot shadow filter inside a uniform branch');
      ok(P.beam && P.beam.visible && P.beam.material.side === T2.BackSide && P.beam.material.depthTest === false && P.beam.material.blending === T2.AdditiveBlending, 'beam cone mesh made, additive, back-face, no depth test');
      let bw = ''; try { bw = wgsl(P.beam, sc, cam, [Ls]); } catch (e) { console.log('   ' + e.message); }
      ok(bw.length > 1000 && new RegExp('i < ' + F.TIERS[F.S.tierName].steps + ';').test(bw), 'beam WGSL compiles with ' + F.TIERS[F.S.tierName].steps + ' samples');
      F.toggle(false); F.tick('walk'); ok(!P.beam.visible && F.U.shOn.value === 0 && F.U.k.value === 0, 'off: beam hidden, shadow branch closed');
    }
    // ── (v322) EVERY material family gets the spot term in its real WGSL, within the 16-sampled-textures-per-stage limit.  Built with the same TSL the game uses (stub renderer, no GPU).
    //    "spot term" = the SpotLightNode cone smoothstep(coneCos, penumbraCos, .) (a point / ambient / hemisphere list never has it); negative control: a private list WITHOUT the spot.
    {
      hooks.isMobile = true; hooks.preset = 'medium'; hooks.shadowSize = 1024; location.search = ''; F.refreshTier(); F.hooks.depthOK = () => true; F.hooks.logDepth = () => true;
      const sc = new T2.Scene(); sc.fog = new T2.Fog(0x888888, 40, 900); F.adoptScene(sc); const led = new T2.Object3D(); sc.add(led); sc.updateMatrixWorld(true); S.led = led; S.built = true; F.toggle(true); F.tick('walk'); F.tick('walk');
      const Ls = F.sceneLight(sc), cam = new T2.PerspectiveCamera(60, 1, 0.1, 5000), TS = NS.TSL, amb = new T2.AmbientLight(0x6688aa, 0.5), hemi = new T2.HemisphereLight(0x88bbff, 0x222222, 0.4); sc.add(amb, hemi);
      const spotRe = /smoothstep\( render\.nodeUniform\d+, render\.nodeUniform\d+, /, texCount = w => (w.match(/var nodeUniform\d+ : texture_/g) || []).length, sampCount = w => (w.match(/var nodeUniform\d+_sampler : sampler/g) || []).length;
      const dmWrap = m => { const prev = m.receivedShadowNode; m.receivedShadowNode = prev ? (s => s && s.dmFlashShadow ? s : TS.mix(TS.float(1), prev(s), TS.float(0.7))) : (s => s && s.dmFlashShadow ? s : TS.mix(TS.float(1), s, TS.float(0.7))); return m; };
      const fam = {
        'MeshStandardNodeMaterial (terrain / props / character / board)': () => new T2.MeshStandardNodeMaterial({ roughness: 0.9 }),
        'custom colorNode (ground / brick / voxel atlases)': () => { const m = new T2.MeshStandardNodeMaterial(); m.colorNode = TS.mix(TS.vec3(0.3, 0.3, 0.2), TS.vec3(0.6, 0.5, 0.4), TS.sin(TS.positionWorld.x).mul(0.5).add(0.5)); m.normalNode = TS.normalView; return m; },
        'DMLight-wrapped (receivedShadowNode + emissive bounce + aoNode)': () => { const m = dmWrap(new T2.MeshStandardNodeMaterial()); m.emissiveNode = TS.vec3(0.01, 0.01, 0.012); m.aoNode = TS.float(0.8); return m; },
        'MeshPhysicalNodeMaterial (glass / water / hull)': () => new T2.MeshPhysicalNodeMaterial({ roughness: 0.2, metalness: 0.5, clearcoat: 0.5 }),
        'MeshLambertNodeMaterial (rings / holo)': () => new T2.MeshLambertNodeMaterial(),
        'alpha-blended double-sided (foliage cards)': () => new T2.MeshStandardNodeMaterial({ transparent: true, side: T2.DoubleSide, opacity: 0.8 }),
        'emissive-only atlas (mansion shell) with the PRIVATE list [ambient, hemi, spot]': () => { const m = new T2.MeshStandardNodeMaterial({ color: 0x000000 }); m.emissiveNode = TS.vec3(0.2, 0.2, 0.2); m.lightsNode = TS.lights([amb, hemi, Ls]); return m; },
        'Bird Temple hull / interior private list [..., spot]': () => { const m = new T2.MeshStandardNodeMaterial(); m.lightsNode = TS.lights([amb, hemi, Ls]); return m; },
      };
      for (const name of Object.keys(fam)) for (const rs of [true, false]) {
        const mesh = new T2.Mesh(new T2.PlaneGeometry(10, 10), fam[name]()); mesh.receiveShadow = rs; sc.add(mesh); sc.updateMatrixWorld(true);
        const own = !!mesh.material.lightsNode; let w = '', ww = ''; const lightsFor = own ? [] : [amb, hemi, Ls];
        try { w = wgsl(mesh, sc, cam, lightsFor.length ? lightsFor : [Ls]); } catch (e) { console.log('   ' + name + ': ' + e.message); }
        ok(w.length > 1000 && spotRe.test(w), 'WGSL "' + name + '" (receiveShadow ' + rs + '): carries the spot term');
        ok(!rs || /textureGatherCompare/.test(w), 'WGSL "' + name + '": spot shadow lookup present when it receives shadows');
        ok(texCount(w) <= 16 && sampCount(w) <= 16, 'WGSL "' + name + '" (receiveShadow ' + rs + '): ' + texCount(w) + ' sampled textures / ' + sampCount(w) + ' samplers <= 16 (WebGPU limit per stage)');
        const r = F.receives(mesh.material, Ls, sc); ok(r.ok, 'audit agrees "' + name + '": ' + r.why);
        sc.remove(mesh);
      }
      { const m = new T2.MeshStandardNodeMaterial(); m.lightsNode = TS.lights([amb, hemi]); const mesh = new T2.Mesh(new T2.PlaneGeometry(10, 10), m); mesh.receiveShadow = true; sc.add(mesh); sc.updateMatrixWorld(true);
        let w = ''; try { w = wgsl(mesh, sc, cam, [amb, hemi]); } catch (e) { console.log('   ' + e.message); }
        ok(w.length > 500 && !spotRe.test(w) && !/textureGatherCompare/.test(w), 'negative control: a private list WITHOUT the spot has no spot term in its WGSL ...'); ok(!F.receives(m, Ls, sc).ok, '... and the audit flags it BLIND'); sc.remove(mesh); }
      { const m = new T2.MeshBasicNodeMaterial({ color: 0x888888 }); const mesh = new T2.Mesh(new T2.PlaneGeometry(10, 10), m); sc.add(mesh); sc.updateMatrixWorld(true);
        let w = ''; try { w = wgsl(mesh, sc, cam, [Ls]); } catch (e) { console.log('   ' + e.message); }
        ok(w.length > 300 && !spotRe.test(w) && !F.receives(m, Ls, sc).ok, 'MeshBasicNodeMaterial never receives the spot (unlit: sky / water FX / glows by design) and the audit says so'); sc.remove(mesh); }
      // the distance-proportional bias + far fade are in the shadow lookup of the real shader (log-depth path)
      { const mesh = new T2.Mesh(new T2.PlaneGeometry(10, 10), new T2.MeshStandardNodeMaterial()); mesh.receiveShadow = true; sc.add(mesh); sc.updateMatrixWorld(true); let w = ''; try { w = wgsl(mesh, sc, cam, [Ls]); } catch (e) { console.log('   ' + e.message); }
        ok(/smoothstep\( \( render\.nodeUniform\d+ \* 0\.55 \), render\.nodeUniform\d+, \( pow\( \( render\.nodeUniform\d+ \+ 1\.0 \), max\(/.test(w), 'shadow lookup eases out over the last 45 % of the shadow reach (no hard lit / shadowed arc at the far plane)');
        ok(/max\( \( \w+ \* 0\.988 \) - 0\.03/.test(w) || /0\.988/.test(w), 'shadow lookup uses the distance-proportional bias (1.2 % of the distance + 3 cm)'); sc.remove(mesh); }
      F.toggle(false); F.tick('walk');
    }
    { hooks.isMobile = false; F.hooks.depthOK = () => true; const sc = new T2.Scene(); sc.fog = new T2.Fog(0x888888, 40, 900); F.adoptScene(sc); const led = new T2.Object3D(); sc.add(led); sc.updateMatrixWorld(true); S.led = led; S.beam = undefined;
      F.toggle(true); F.tick('walk'); const P = S.pairs[S.pairs.length - 1]; ok(P.beam && P.beam.visible, 'fogged scene without DMVLight: own cone beam');
      globalThis.DMVLight = { on: true }; sc.fogNode = {}; F.tick('walk'); ok(!P.beam.visible, 'DMVLight installed on the scene (scene.fogNode): the cone yields, no double beam');
      F.tick('space'); ok(P.beam.visible, 'open space: DMVLight is off there, the cone is the beam'); F.tick('walk');
      location.search = '?flashbeam=1'; F.refreshTier(); F.tick('walk'); ok(P.beam.visible, '?flashbeam=1 forces the cone on top of DMVLight'); location.search = ''; F.refreshTier(); delete globalThis.DMVLight; F.toggle(false); }
    // vacuum: no beam; the depth hook missing: no beam at all
    { hooks.isMobile = false; const sc = new T2.Scene(); F.adoptScene(sc); const led = new T2.Object3D(); sc.add(led); sc.updateMatrixWorld(true); S.led = led; S.beam = undefined; F.toggle(true); F.tick('space'); const P = S.pairs[S.pairs.length - 1]; ok(S.dens < 0.001, 'open space (vacuum): only a trace of dust (density ' + S.dens + ')'); F.toggle(false);
      const sc2 = new T2.Scene(); F.adoptScene(sc2); const led2 = new T2.Object3D(); sc2.add(led2); sc2.updateMatrixWorld(true); S.led = led2; S.beam = undefined; F.hooks.depthOK = () => false; F.toggle(true); F.tick('walk'); const P2 = S.pairs[S.pairs.length - 1]; ok(!P2.beam, 'no scene-depth read (multisampled WebGPU): no beam mesh (it would pour through the ground)'); F.toggle(false); }
  } else console.log('  (part 2 skipped: no three.webgpu.js; set THREE_WEBGPU)');
  console.log(fails ? 'flash-light: FAILED ' + fails + '/' + n : 'flash-light: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('flash-light: ERROR', e); process.exit(1); });
