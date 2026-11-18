// node tools/tests/shield-unit.js - ui/dm-hazard.js: the DMHazard registry + sensor, the exposure clock (HAZARD_TABLE), and the protection state on her Skyboard set
// (staff-crown contour glow + lighthouse LED), her chest LED and the first-person head light.  The protective ORB (and the HUD SHIELD toggle) are gone: part 1 pins that.
// Part 1 (always): pure maths, API surface, source contracts.  Part 2 (needs three.webgpu.js: THREE_WEBGPU=/path, or ~/.cache/dm-harness) runs the real tick against a stub world and
// checks what is in the scene / visible / which colour.  No GPU: nothing here was RENDERED.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');
const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'ui', 'dm-hazard.js'), 'utf8');
let bad = 0, n = 0; const ok = (c, m) => { n++; if (!c) { bad++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };

function mkWin(extra) { const evs = []; const win = Object.assign({ addEventListener() {}, dispatchEvent(e) { evs.push(e); return true; }, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  sessionStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, _m: m }; })(),
  localStorage: (() => { const m = { dm_shield_orb: '0' }; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, _m: m }; })(), location: { search: '' } }, extra || {}); win.window = win; return { win, evs }; }
function load(extra) { const { win, evs } = mkWin(extra); const timers = [], clock = { t: 1000 };
  const ctx = Object.assign({ console, Math, performance: { now: () => clock.t }, URLSearchParams, CustomEvent: win.CustomEvent,
    setInterval: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearInterval: id => { if (timers[id - 1]) timers[id - 1] = null; }, setTimeout: (f, ms) => 0 }, win); ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
  return { ctx, evs, timers, clock, H: ctx.DM_HAZ, S: ctx.DMShield, Z: ctx.DMHazard }; }
const liveTimers = t => t.filter(Boolean).length;

console.log('== the orb is gone');
{ ok(!fs.existsSync(path.join(root, 'ui', 'dm-hazardbubble.js')) && !fs.existsSync(path.join(root, 'ui', 'dm-shield.js')), 'ui/dm-hazardbubble.js and the HUD SHIELD button file are deleted');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ok(!/dm-hazardbubble|dm-shield\.js/.test(html) && /ui\/dm-hazard\.js\?v=\d+/.test(html) && /ui\/dm-hazardhud\.js\?v=\d+/.test(html), 'index.html loads dm-hazard.js + dm-hazardhud.js and nothing of the old files');
  ok(!/dm-haz-orb|S\.front|S\.back|orbMat|H\.inten|RADIUS_MUL|PROTECT_R|SH\.on\b|SH\.armed/.test(src), 'no orb mesh / material / intensity / field radius / toggle / arm state left in the source');
  const { S, H, ctx } = load();
  ok(['set', 'toggle', 'arm', 'radius', 'overrideDistance'].every(k => S[k] === undefined) && S.on === undefined && S.armed === undefined, 'DMShield has no orb toggle / arm / field radius');
  ok(ctx.localStorage.getItem('dm_shield_orb') === null, 'the old dm_shield_orb choice is cleared');
  ok(!/localStorage\.setItem/.test(src) && /sessionStorage\.setItem\('dm_shield_on'/.test(src), 'nothing is written to localStorage; only the Shield toggle\'s session flag (sessionStorage dm_shield_on) is stored');
  ok(H.a === undefined && H.R === undefined, 'DM_HAZ carries no orb state'); }

console.log('== exposure maths (pure)');
{ const { H } = load(), C = H.core, T = C.HAZARD_TABLE;
  for (const k of Object.keys(T)) { const r = T[k]; ok(r.safeSec > 0 && r.recoverSec > 0 && r.warn > 0 && r.warn < 1 && !!r.label && /^#[0-9a-f]{6}$/i.test(r.hue), 'table row "' + k + '" is complete'); }
  ok(C.rowFor('toxic', 'atmosphere') === T.toxic && C.rowFor('', 'plume') === T.plume && C.rowFor('nope', 'zzz') === T.default && C.rowFor(undefined, undefined) === T.default, 'rowFor: gas, else type, else default');
  ok(C.intensityOf(5, 10, 1, false) === 0 && C.intensityOf(0, 10, 1, false) === 0.6 && Math.abs(C.intensityOf(-10, 10, 1, false) - 1) < 1e-9 && C.intensityOf(-100, 10, 0.5, false) === 0.5, 'intensity: 0 outside, 0.6 sev at the edge, sev at the core');
  ok(C.intensityOf(99, 1, 0.5, true) === 0.5 && C.intensityOf(99, 1, undefined, true) === 1, 'a global source is always its severity (undefined = 1)');
  ok(C.markerOf(0, 10, 5, false) === 0.5 && C.markerOf(10, 10, 5, false) === 0 && C.markerOf(99, 10, 5, false) === 0 && C.markerOf(-5, 10, 5, false) === 1 && C.markerOf(0, 10, 5, true) === 1, 'marker: 0 clear / 0.5 at the edge / 1 in the core or a global source');
  let prev = 0, mono = true; for (let d = 12; d >= -6; d -= 0.5) { const m = C.markerOf(d, 10, 5, false); if (m < prev - 1e-12) mono = false; prev = m; } ok(mono, 'marker rises monotonically as she approaches and falls back as she leaves');
  const row = T.toxic; let res = 1, t = 0; while (res > 0 && t < 1000) { res = C.reserveStep(res, 1, false, 0.1, row); t += 0.1; } ok(Math.abs(t - row.safeSec) < 0.2, 'drain from full to zero at intensity 1 takes safeSec (' + t.toFixed(1) + ' s vs ' + row.safeSec + ')');
  ok(Math.abs(C.secondsLeft(1, 1, row) - row.safeSec) < 1e-9 && Math.abs(C.secondsLeft(0.5, 0.5, row) - row.safeSec) < 1e-9 && C.secondsLeft(1, 0, row) === Infinity, 'seconds left = reserve x safeSec / intensity (half the severity at half the reserve = the same clock)');
  res = 0; t = 0; while (res < 1 && t < 1000) { res = C.reserveStep(res, 0, false, 0.1, row); t += 0.1; } ok(Math.abs(t - row.recoverSec) < 0.2, 'refill from empty to full when clear takes recoverSec (' + t.toFixed(1) + ' s)');
  ok(C.reserveStep(0.5, 0, true, 1, row) - 0.5 < (C.reserveStep(0.5, 0, false, 1, row) - 0.5) * 0.51, 'the near band refills at half rate');
  ok(C.reserveStep(0.5, 0, true, 10, row) <= 1 && C.reserveStep(0.01, 5, false, 10, row) === 0, 'reserve stays in [0, 1]');
  ok(C.stateOf('off', false, false, 1, 0.35) === 'off' && C.stateOf('off', true, false, 1, 0.35) === 'alert' && C.stateOf('off', true, true, 1, 0.35) === 'protected', 'state: off / alert (near) / protected (inside)');
  ok(C.stateOf('protected', true, true, 0.3, 0.35) === 'warn' && C.stateOf('warn', true, true, 0.4, 0.35) === 'warn' && C.stateOf('warn', true, true, 0.45, 0.35) === 'protected' && C.stateOf('warn', true, true, 0, 0.35) === 'exposed', 'state: amber below warn (hysteresis +0.08), red at zero');
  ok(C.fmtClock(0) === '00:00' && C.fmtClock(83) === '01:23' && C.fmtClock(Infinity) === '--:--' && C.fmtClock(-5) === '00:00', 'clock format'); }

console.log('== pure protection helpers');
{ const { S } = load(), C = S.core;
  ok(JSON.stringify(C.shieldPlan(false, 0)) === '{"hulls":2,"led":true,"pulse":true}', 'plan: Med+ = 2 shells + LED (no fog point light any more)');
  ok(C.shieldPlan(true, 0).hulls === 1 && C.shieldPlan(true, 0).point === undefined, 'plan: Low = 1 shell, no extra light');
  ok(C.shieldPlan(false, 2).hulls === 1, 'plan: DMBudget light >= 2 sheds the outer shell');
  ok(C.shieldPlan(false, 3).hulls === 0 && C.shieldPlan(false, 3).led && !C.shieldPlan(false, 3).pulse, 'plan: DMBudget light 3 = LED only');
  const names = a => a.map(x => ({ name: x, base: '' }));
  ok(JSON.stringify(C.pickCrown(names(['hull', 'staff', 'staff head 1', 'staff head 2', 'tail shard 1']), false)) === '[2,3]', 'crown: template C "staff head" pieces');
  ok(JSON.stringify(C.pickCrown([{ name: 'deck' }, { name: 'staff' }, { name: 'arrowhead shard 1', base: 'ornament' }, { name: 'arrowhead shard 2', base: 'ornament' }], false)) === '[2,3]', 'crown: A / B arrowhead shards');
  ok(JSON.stringify(C.pickCrown([{ name: 'deck' }, { name: 'staff' }, { name: 'arrowhead shard', base: '' }], true)) === '[1]', 'crown: Ariel board -> the staff rail');
  ok(C.pickCrown([{ name: 'deck' }], false).length === 0, 'crown: nothing found -> empty (a short mast LED over the deck)');
  const a = C.fpLightParams(1.7, 1, 1), b = C.fpLightParams(1.7, 0.5, 1);
  ok(a.range > 0 && a.range < 1.7 && a.intensity > 0 && b.intensity < a.intensity && C.fpLightParams(1.7, 1, 0).intensity === 0, 'first-person light: a few feet (range < her height), faint, scales with the level, gain 0 = off'); }

console.log('== source contracts (per-frame cost, dormancy)');
{ const tick = src.slice(src.indexOf('H.tick=function'), src.indexOf('H.setOff'));
  ok(/if\(!H\.ready\) return;/.test(tick) && tick.indexOf('if(!H.ready) return;') < tick.indexOf('groupSphere('), 'a hostile world\'s protection is gated on H.ready: nothing runs or shows before the world-load warm-up finished');
  ok(/const wake=H\.hostile\|\|HZ\.near\|\|EX\.on/.test(tick) && /if\(!wake&&!dive\)\{[\s\S]*?return; \}/.test(tick) && tick.indexOf('if(!wake&&!dive)') < tick.indexOf('groupSphere('), 'safe map: the tick returns BEFORE groupSphere / exposure / shield work (one boolean test)');
  ok(/if\(PW\.body!==_gb\|\|PW\.pal!==_gp\) gateWorld\(\);/.test(tick) && !/H\.kind\(/.test(tick), 'the air kind is evaluated once per world open, not per frame');
  ok(/H\.shieldHide\(\)/.test(tick) && /H\.shieldRelease\(\)/.test(src.slice(src.indexOf('H.close=function'), src.indexOf('H.hide='))), 'protection hidden when the air mode ends, released on world close');
  const sh = src.slice(src.indexOf('function shFrame'), src.indexOf('function shOff'));
  ok(!/new [A-Z]\w*\(|\[\s*\]|\{\s*\w+\s*:/.test(sh.replace(/if\(!_M\)\{[^}]*\}/, '')), 'shFrame allocates nothing per frame (scratch made once)');
  ok(/side:THREE\.BackSide/.test(src) && /modelScale/.test(src) && /AdditiveBlending/.test(src) && /depthWrite:false/.test(src), 'crown glow = additive inverted hull, depthWrite off, scale-independent thickness');
  ok(/raycast=\(\)=>\{\}/.test(src) && /userData\.dmShield=true/.test(src), 'crown / LED meshes are never colliders or pick targets');
  ok(!/new THREE\.(Point|Spot|Directional)Light/.test(src) && /DMNatLights/.test(src) && /NL\.request/.test(src), 'no real THREE light is created: the first-person glow borrows the FIXED pooled natural light (no recompile, no shadow)');
  ok(!/DMVLight|setPoints|plan\.point|SH\.vlOn/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'NO fog point light (DMVLight) round the LED: the lit ball cut the ground in a circle');
  ok(/dmhazardzero/.test(src) && !/gameOver|game over|die\(|damage/i.test(src.replace(/no damage, no game-over|NO damage, NO game-over/gi, '')), 'zero = a warning state + one event; no damage / game-over code'); }

// ---------------------------------------------------------------- part 2: the real tick on a stub world
const cands = [process.env.THREE_WEBGPU, path.join(os.homedir(), '.cache/dm-harness/node_modules/three/build/three.webgpu.js'), '/workspace/three185/three.webgpu.js', path.join(root, 'node_modules/three/build/three.webgpu.js')].filter(Boolean);
const tp = cands.find(p => fs.existsSync(p));
(async () => {
  if (!tp) console.log('  (part 2 skipped: no three.webgpu.js; set THREE_WEBGPU)');
  else {
    const THREE = await import('file://' + tp);
    console.log('== real tick, stub world (three ' + THREE.REVISION + ')');
    const mk = (name, x, y, z, base) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial()); m.name = name; m.position.set(x, y, z); if (base) m.userData.basePart = base; return m; };
    const mkWorld = (name, L, o) => { o = o || {}; const sc = new THREE.Scene(), cm = new THREE.PerspectiveCamera(), bd = new THREE.Group(); bd.add(mk('deck', 0, 0, 0), mk('staff', -1, 0.6, 0.3), mk('staff head 1', -1, 1.3, 0.3), mk('staff head 2', -1, 1.4, 0.3)); sc.add(bd);
      const h = new THREE.Object3D(); sc.add(h); const rig = new THREE.Object3D(); h.add(rig); let upd = 0; const u0 = h.updateWorldMatrix.bind(h); h.updateWorldMatrix = (a, b) => { upd++; return u0(a, b); };
      const nat = { reqs: [], released: [], request(p, c, i, r) { this.reqs.push({ i, r, c }); return this.reqs.length; }, set(k, p, i) { this.reqs[k - 1].i = i; }, release(k) { this.released.push(k); } };
      L.ctx.THREE = THREE; L.ctx.GFX = { preset: 'high', isMobile: false }; L.ctx.CHAR = { root: h, rawHeight: 1.7 }; L.ctx.surfBoard = bd; L.ctx.atmoBoard = bd; L.ctx._lcBoardLen = () => 3;
      L.ctx.DMNatLights = nat; L.ctx.DMCharm = { built: true, rig };
      cm.position.set(0, 1.7, 0);
      L.ctx.PW = { active: true, scene: sc, camera: cm, board: bd, mode: 'walk', body: { name }, pal: o.pal || null, renderer: null };
      return { sc, bd, h, rig, nat, cm, upd: () => upd, tick: k => { for (let i = 0; i < k; i++) { L.clock.t += 1000 / 60; sc.updateMatrixWorld(true); L.H.tick(1 / 60); } } }; };
    const crown = w => w.sc.children.filter(o => o.name === 'dm-shield-crown'), led = w => w.sc.children.find(o => o.name === 'dm-shield-led'), bodyLed = w => w.rig.children.find(o => o.name === 'dm-shield-body-led');
    const colOf = w => crown(w)[0].material.colorNode.value.clone();

    // --- a toxic world (Mars): load gate, one-step switch-on, exposure clock, colours
    { const L = load(), w = mkWorld('Mars', L, { pal: { atmos: true } }), S = L.S, H = L.H, EX = H.exposure;
      L.ctx.PW.mode = null;   // loading: the world is built, no mode yet
      let pre = H.prewarm(); H.ready = false;   // (prewarm sets it; here we stop it half way to check the gate)
      w.tick(30); ok(S.stats.frames === 0 && !H.awake, 'not ready: the tick does nothing at all (no frames, not awake)');
      ok(S.available === false && H.exposure.on === false, 'not ready: no protection state, no exposure clock');
      pre.then(() => {}); H.ready = true; L.ctx.PW.mode = 'walk';
      w.h.position.set(3, 0, 0); w.bd.position.set(0, 0, 0); w.tick(240);
      ok(S.available && S.state === 'protected' && S.active && S.protected, 'toxic world on foot: protection ACTIVE (green) with the board parked');
      ok(crown(w).length === 4 && crown(w).every(m => m.visible) && led(w) && led(w).visible, 'crown contour glow (2 pieces x 2 shells) + lighthouse LED on');
      ok(!w.sc.children.some(o => /orb/.test(o.name || '')), 'no orb object anywhere in the scene');
      ok(bodyLed(w) && bodyLed(w).visible, 'a small LED on her (chest rig) is visible in third person');
      let c0 = colOf(w); ok(c0.g > c0.r && c0.g > c0.b, 'colour GREEN while protected');
      ok(EX.inside && EX.marker === 1 && Math.abs(EX.I - 1) < 1e-9 && EX.label === 'TOXIC ATMOSPHERE', 'exposure: inside a global toxic source, marker full right, intensity 1');
      const before = EX.reserve; w.tick(60); ok(EX.reserve < before && EX.sec < 90 && EX.sec > 80, 'the clock counts down while exposed (' + EX.sec.toFixed(1) + ' s left)');
      // board far away: still protected (not a field around the board any more)
      w.bd.position.set(500, 0, 0); w.tick(30); ok(S.state === 'protected' && bodyLed(w).visible, 'board parked 500 u away: protection still active (LED on her)');
      // first person: body + board hidden: a head light, no LED meshes needed
      L.ctx._surfFpHidden = true; w.h.visible = false; w.bd.visible = false; w.tick(30);
      ok(w.nat.reqs.length === 1 && w.nat.reqs[0].i > 0 && w.nat.reqs[0].r < 1.7 * 1.0, 'first person: ONE pooled light at her head, faint, a few feet (I ' + w.nat.reqs[0].i.toFixed(4) + ', range ' + w.nat.reqs[0].r.toFixed(2) + ')');
      L.ctx._surfFpHidden = false; w.h.visible = true; w.bd.visible = true; w.tick(30);
      ok(w.nat.released.length >= 1 && bodyLed(w).visible, 'back to third person: the head light is released, the chest LED shows');
      // run the reserve down: amber then red at zero, one zero event, nothing else
      let evs0 = L.evs.length; L.ctx.performance.now = () => L.clock.t;
      for (let i = 0; i < 60 * 100 && S.state !== 'warn'; i++) w.tick(1); ok(S.state === 'warn', 'reserve below the warn fraction: AMBER'); w.tick(90); c0 = colOf(w); ok(c0.r > 0.8 && c0.g > 0.5 && c0.b < 0.4, 'crown colour AMBER');
      for (let i = 0; i < 60 * 120 && !EX.zero; i++) w.tick(1); ok(EX.zero && S.state === 'exposed' && EX.reserve === 0, 'zero: state EXPOSED (red warning)'); w.tick(90); c0 = colOf(w); ok(c0.r > 0.8 && c0.g < 0.4, 'crown colour RED');
      ok(L.evs.filter(e => e.type === 'dmhazardzero').length === 1, 'ONE dmhazardzero event at the zero crossing'); w.tick(120); ok(L.evs.filter(e => e.type === 'dmhazardzero').length === 1 && EX.reserve === 0 && S.state === 'exposed', 'staying at zero: no repeat events, no damage, still just the warning state');
      const hud = L.evs.filter(e => e.type === 'dmhazardhud'); ok(hud.length > 3 && hud.length < 400, 'dmhazardhud is rate-limited (' + hud.length + ' events for the whole run)'); void evs0;
      // tiers
      ctx_tiers(L, w);
      H.close(w.sc); ok(crown(w).length === 0 && !led(w) && !bodyLed(w) && w.sc.children.filter(o => /^dm-/.test(o.name || '')).length === 0 && EX.reserve === 1 && !EX.on, 'world close: crown, LEDs removed; the clock is reset'); H.dispose(); ok(true, 'dispose ran'); }
    function ctx_tiers(L, w) { L.ctx.GFX.preset = 'low'; L.ctx.DMBudget = { on: true, lvl: () => 0 }; w.tick(60); ok(crown(w).filter(m => m.visible).length === 2, 'Low tier: one shell only');
      L.ctx.GFX.preset = 'high'; L.ctx.DMBudget = { on: true, lvl: () => 3 }; w.tick(5); ok(crown(w).filter(m => m.visible).length === 0 && led(w).visible, 'DMBudget light 3: LED only'); L.ctx.DMBudget = null;
  const calls = []; L.ctx.DMVLight = { on: true, setPoints: (k, a) => calls.push([k, a.slice()]), clear: k => calls.push(['clear', k]) }; w.tick(30);
      ok(calls.length === 0, 'Med+: nothing is ever handed to DMVLight (no fog light round the LED)'); L.ctx.GFX.preset = 'high'; }

    // --- the loader warm-up: everything built before the world is shown
    { const L = load(), w = mkWorld('Mars', L, { pal: { atmos: true } }); L.ctx.PW.mode = null;
      await L.H.prewarm(); ok(L.H.ready === true && crown(w).length === 4 && led(w) && !led(w).visible && crown(w).every(m => !m.visible), 'prewarm: crown + LED built (hidden) while the loader is up; H.ready flips true in one step');
      w.tick(5); ok(L.S.stats.frames === 0, 'mode not set yet: still nothing runs'); }
    { const L = load(), w = mkWorld('Solenne', L); L.ctx.PW.mode = null; await L.H.prewarm(); ok(L.H.ready === true && w.sc.children.length === 2, 'prewarm on a safe world: builds nothing, instantly ready'); }

    console.log('== dormancy on safe maps (home planet / mansion)');
    for (const nm of ['Solenne', 'Earth']) {
      const L = load(), w = mkWorld(nm, L); w.h.position.set(2, 0, 0); const before = w.sc.children.length, u0 = w.upd(); w.tick(300);
      const st = L.S.stats;
      ok(w.sc.children.length === before, nm + ': nothing added to the scene in 300 frames');
      ok(st.frames === 0 && st.built === false && st.gpu === false && st.awake === false, nm + ': never ticked / built / compiled a material (' + JSON.stringify(st) + ')');
      ok(w.upd() === u0, nm + ': the per-frame groupSphere maths never ran');
      ok(L.Z.count() === 0 && L.timers.length === 0 && L.Z.ticks === 0, nm + ': no hazard source, no sensor timer');
      ok(L.S.available === false && L.S.state === 'off' && !L.evs.some(e => e.type === 'dmshield'), nm + ': DMShield unavailable, no event');
      ok(L.H.hostile === false && L.H.awake === false && L.H.exposure.on === false && w.nat.reqs.length === 0, nm + ': H.hostile / H.awake / exposure off, no pooled light'); }
    { const L = load(), w = mkWorld('Solenne', L); L.ctx.JOTS_WATER = { surfaceY: 0 }; L.ctx.PW.mode = 'fly'; w.bd.position.set(0, 300, 0); w.tick(120);
      ok(w.sc.children.length === 2 && L.S.stats.frames === 0, 'home sea, flying high above the water: fully asleep'); }
    { const L = load(), w = mkWorld('Solenne', L); L.ctx.JOTS_WATER = { surfaceY: 0 }; L.ctx.PW.mode = 'fly'; L.ctx.atmoBoard = w.bd; w.h.position.set(0, -6, 0); w.bd.position.set(0, -6, 0); w.cm.position.set(0, -4, 6); w.tick(240);
      ok(L.H.wet > 0.5 && L.H.underwater, 'dive: below the surface on the board -> wet'); const tint = w.sc.children.find(o => o.name === 'dm-haz-tint'), bub = w.sc.children.find(o => o.name === 'dm-haz-bubbles');
      ok(tint && tint.visible && bub, 'dive: the underwater tint + bubble trail are built and the tint shows (no orb: ' + w.sc.children.map(o => o.name).filter(Boolean).join(',') + ')');
      ok(!w.sc.children.some(o => /orb/.test(o.name || '')) && L.S.stats.frames === 0, 'dive: no orb, no protection work (the air is safe)');
      w.h.position.set(0, 300, 0); w.bd.position.set(0, 300, 0); w.cm.position.set(0, 302, 6); w.tick(300); ok(!tint.visible && L.H.awake === false && L.H.wet < 0.05, 'surfaced / high above: tint off, asleep again'); }

    console.log('== DMHazard registry / sensor');
    { const L = load(), Z = L.Z;
      ok(Z.count() === 0 && !Z.sensorOn && liveTimers(L.timers) === 0 && Z.ticks === 0, 'no sources: no timer, nothing ticking');
      Z.register({ type: 'atmosphere', shape: 'global', gas: 'toxic' }); ok(Z.count() === 1 && liveTimers(L.timers) === 0 && Z.global, 'a global source (toxic atmosphere) needs no sensor timer');
      const id = Z.register({ type: 'vent', shape: 'sphere', x: 10, y: 0, z: 0, r: 3, gas: 'sulfur' });
      ok(Z.sensorOn && liveTimers(L.timers) === 1 && L.timers[0].ms >= 250 && L.timers[0].ms <= 500, 'first LOCAL source starts ONE ~3 Hz timer (' + L.timers[0].ms + ' ms)');
      Z.register({ type: 'vent', shape: 'sphere', x: 50, y: 0, z: 0, r: 3 }); ok(liveTimers(L.timers) === 1, 'more sources share the one timer');
      ok(Z.unregister(id) && Z.sensorOn, 'unregister keeps the timer while a local source remains');
      Z.clear(); ok(Z.count() === 0 && !Z.sensorOn && liveTimers(L.timers) === 0 && !Z.global, 'clear() (world close) removes every source and the timer');
      const C = Z.core;
      ok(C.hazardDist({ shape: 'sphere', x: 0, y: 0, z: 0, r: 5 }, 8, 0, 0) === 3 && C.hazardDist({ shape: 'sphere', x: 0, y: 0, z: 0, r: 5 }, 2, 0, 0) === -3, 'sphere: signed distance to the edge');
      const col = { shape: 'column', x: 0, z: 0, r: 4, y0: 0, y1: 20 };
      ok(C.hazardDist(col, 6, 10, 0) === 2 && C.hazardDist(col, 1, 10, 0) === -3 && Math.abs(C.hazardDist(col, 7, 24, 0) - 5) < 1e-9, 'column: horizontal / inside / above the top');
      ok(C.hazardStep(-1, 5) === 'inside' && C.hazardStep(3, 5) === 'near' && C.hazardStep(9, 5) === 'clear', 'inside / near / clear'); }

    console.log('== a local plume on a healthy planet: near -> inside -> recover');
    { const L = load(), w = mkWorld('Solenne', L), S = L.S, Z = L.Z, EX = L.H.exposure; w.h.position.set(0, 0, 0); w.bd.position.set(3, 0, 0); w.tick(30);
      const sense = () => { w.sc.updateMatrixWorld(true); Z.sense(); }; Z.register({ type: 'plume', gas: 'volcanic', shape: 'sphere', x: 40, y: 0, z: 0, r: 10, sev: 0.8 });
      ok(liveTimers(L.timers) === 1 && S.stats.frames === 0, 'a source far away: the sensor runs, the protection stays asleep');
      sense(); ok(Z.state === 'clear' && !Z.near && Z.glasses.level === 0, 'far: clear');
      w.h.position.set(22, 0, 0); sense(); ok(Z.state === 'near' && Z.near, 'within the warning margin: near');
      w.tick(60); ok(S.state === 'alert' && S.available && EX.near && !EX.inside && EX.reserve === 1 && EX.marker > 0 && EX.marker < 0.5, 'near: ALERT (amber LED), marker on the left half, no drain');
      ok(led(w) && led(w).visible && crown(w).every(m => !m.visible), 'alert: the LED lights, no crown glow');
      const mNear = EX.marker; w.h.position.set(28, 0, 0); sense(); w.tick(10); ok(EX.marker > mNear, 'closer: the marker moves right (' + mNear.toFixed(2) + ' -> ' + EX.marker.toFixed(2) + ')');
      w.h.position.set(35, 0, 0); sense(); w.tick(600); ok(EX.inside && S.state === 'protected' && EX.label === 'VOLCANIC PLUME' && EX.reserve < 1 && Math.abs(EX.I - 0.8 * (0.6 + 0.4 * 0.5)) < 0.05, 'inside the plume: protected, VOLCANIC PLUME, intensity ' + EX.I.toFixed(2) + ', clock running');
      const rIn = EX.reserve; w.h.position.set(300, 0, 0); sense(); w.tick(120); ok(Z.state === 'clear' && !EX.sensed && S.state === 'off' && EX.reserve > rIn && EX.on, 'walked away: LED off, the reserve RECOVERS, the HUD stays up until it is full');
      for (let i = 0; i < 60 * 80 && EX.on; i++) w.tick(1); w.tick(3); ok(EX.reserve === 1 && !EX.on && !L.H.awake, 'fully recovered: exposure off, the whole feature asleep again'); }
    console.log('== the Shield toggle (a state flag + gear visuals; no orb)');
    { const L = load(), H = L.H, C = H.shield.core; const G = C.COL.protected, B = C.COL.shielded, K = [0, 0, 0], same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      ok(H.core.stateOf('off', true, true, 1, 0.35, true) === 'shielded' && H.core.stateOf('off', false, false, 1, 0.35, true) === 'off' && H.core.stateOf('off', true, false, 0, 0.35, true) === 'shielded', 'state: shielded whenever a hazard is sensed and the toggle is on (clock value irrelevant)');
      let c = C.ledColours(true, false, 'protected'); ok(c.ledL === G && c.ledR === G && c.stripL === G && c.stripR === G && c.crown === G, 'hazard sensed, shield OFF: whole LED + both strip halves green, crown in the status colour');
      c = C.ledColours(true, false, 'warn'); ok(c.ledL === C.COL.warn && c.ledR === C.COL.warn && c.stripL === G && c.stripR === G, 'status colours (amber / red) drive the LED mesh; the glasses strips stay green (hazard sensed = green)');
      c = C.ledColours(true, true, 'protected'); ok(c.ledL === G && c.ledR === B && c.stripL === G && c.stripR === B && c.crown === B, 'hazard + shield ON: left half green, right half BLUE, crown BLUE');
      c = C.ledColours(false, true, 'off'); ok(same(c.ledL, K) && c.ledR === B && same(c.stripL, K) && c.stripR === B && c.crown === B, 'shield ON, no hazard: only the blue half (left dark), crown BLUE');
      c = C.ledColours(false, false, 'off'); ok(same(c.ledL, K) && same(c.ledR, K) && same(c.stripL, K) && same(c.stripR, K), 'nothing: all dark'); }
    { const store = {}, ss = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
      const L = load({ sessionStorage: ss }), H = L.H; ok(H.shieldIsOn() === false, 'shield starts OFF');
      ok(H.toggleShield() === true && H.shieldIsOn() && store.dm_shield_on === '1' && L.evs.some(e => e.type === 'dmshieldtoggle' && e.detail.on === true), 'toggle ON: flag set, persisted for the session, dmshieldtoggle event');
      const L2 = load({ sessionStorage: ss }); ok(L2.H.shieldIsOn() === true, 'a reload within the session keeps it ON');
      ok(H.setShield(false) === false && !('dm_shield_on' in store), 'toggle OFF clears the session flag'); const n = L.evs.length; H.setShield(false); ok(L.evs.length === n, 'no event when nothing changed'); }
    { const L = load(), w = mkWorld('Mars', L, { pal: { atmos: true } }), S = L.S, H = L.H, EX = H.exposure, U = () => S.core.uniforms();
      const lmesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.1), new THREE.MeshStandardMaterial({ color: 0xffffff })), rmesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.1), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      lmesh.name = 'LED_Top_Strip_L'; rmesh.name = 'LED_Top_Strip_R'; const e0 = rmesh.material.emissive.clone();
      w.h.position.set(3, 0, 0); w.tick(240);   // no strips on her yet (the GLB has not landed): everything still works, no error
      ok(S.state === 'protected' && U().cl.value.g > 0.8 && U().cr.value.g > 0.8 && U().cr.value.b < 0.5, 'shield OFF, toxic air, no glasses strips yet: the LED is WHOLE green (both halves), no error');
      ok(S.stats.strips === 0, 'strip lookup: nothing found, nothing thrown');
      w.h.add(lmesh); w.h.add(rmesh); L.clock.t += 5000; w.tick(240);
      ok(S.stats.strips === 2, 'the strips appear (her GLB landed): found by name, no restart needed');
      ok(lmesh.material !== undefined && rmesh.material.emissive.g > 0.5 && rmesh.material.emissive.b < 0.4 && lmesh.material.emissive.g > 0.5, 'shield OFF: BOTH strip halves green');
      ok(lmesh.material !== lmesh.userData.dmLed.mat ? false : true, 'each strip drives its own private material');
      H.setShield(true); const r0 = EX.reserve; EX.reserve = 0.5; w.tick(120);
      ok(S.state === 'shielded' && S.protected && EX.shield && EX.state === 'shielded', 'shield ON in the toxic air: state SHIELDED');
      ok(EX.reserve > 0.5 && EX.sec === Infinity, 'shield ON: the SAFE TIME countdown stops draining and the reserve recovers (' + EX.reserve.toFixed(2) + '), board parked or not');
      for (let i = 0; i < 60 * 60 && EX.reserve < 1; i++) w.tick(1); w.tick(5); ok(EX.reserve === 1 && !EX.zero, 'recovered to full inside the zone while shielded');
      let cc = colOf(w); ok(cc.b > 0.8 && cc.b > cc.r && cc.b > cc.g, 'the staff crown glows BLUE with the shield on');
      ok(U().cl.value.g > 0.8 && U().cl.value.b < 0.5 && U().cr.value.b > 0.8 && U().cr.value.g < 0.7, 'LED: left half green, right half blue');
      ok(lmesh.material.emissive.g > 0.5 && lmesh.material.emissive.b < 0.4 && rmesh.material.emissive.b > 0.5 && rmesh.material.emissive.g < 0.7, 'strips: LED_Top_Strip_L green, LED_Top_Strip_R blue');
      const hud = L.evs.filter(e => e.type === 'dmhazardhud').pop(); ok(hud && hud.detail.shield === true && hud.detail.state === 'shielded', 'the HUD event carries shield + state');
      // exhaust the clock without the shield: zero; with the shield on again it climbs back out and the zero state clears
      H.setShield(false); for (let i = 0; i < 60 * 130 && !EX.zero; i++) w.tick(1); ok(EX.zero && S.state === 'exposed', 'shield OFF again: the clock drains to zero (control)');
      H.setShield(true); w.tick(180); ok(!EX.zero && S.state === 'shielded' && EX.reserve > 0, 'shield ON at zero: out of OVEREXPOSED at once, recovering');
      H.setShield(false); w.tick(240); ok(rmesh.material.emissive.g > 0.25 && rmesh.material.emissive.b < rmesh.material.emissive.g * 0.7 && rmesh.material.emissive.r < rmesh.material.emissive.g, 'shield OFF: the right strip is green again');
      H.close(w.sc); ok(rmesh.material.emissive.r === e0.r && rmesh.material.emissive.g === e0.g, 'world close: the strips get their original emissive back'); H.dispose(); }
    { // safe world: the toggle works with no hazard at all, and costs nothing when off
      const L = load(), w = mkWorld('Solenne', L), S = L.S, H = L.H, U = () => S.core.uniforms(); w.h.position.set(2, 0, 0); w.tick(120);
      ok(S.stats.frames === 0 && !H.awake && w.sc.children.length === 2, 'safe world, shield OFF: fully dormant (no frames, not awake, nothing added)');
      H.setShield(true); w.tick(240);
      ok(H.awake && S.state === 'shielded' && S.available && crown(w).length === 4 && crown(w).every(m => m.visible) && led(w).visible, 'safe world, shield ON: crown + LED appear (built lazily on the toggle)');
      let cc = colOf(w); ok(cc.b > 0.8 && cc.b > cc.g && cc.b > cc.r, 'crown BLUE');
      ok(U().cl.value.r + U().cl.value.g + U().cl.value.b < 0.2 && U().cr.value.b > 0.8, 'no hazard: only the BLUE half of the LED (the left half dark)');
      ok(!H.exposure.on && L.H.exposure.reserve === 1, 'no hazard: no exposure clock, no HUD card');
      H.setShield(false); w.tick(300); ok(S.state === 'off' && !H.awake && crown(w).every(m => !m.visible) && !led(w).visible, 'shield OFF: fades out and the feature sleeps again');
      const f = S.stats.frames; w.tick(120); ok(S.stats.frames === f, 'asleep again: zero per-frame work'); H.close(w.sc); H.dispose(); }
    { const L = load({ location: { search: '?hazardzone=plume' } }), w = mkWorld('Solenne', L); w.tick(5);
      ok(L.Z.count() === 1 && L.Z.sensorOn, '?hazardzone=plume: one test plume source registered at world open'); L.H.close(w.sc); ok(L.Z.count() === 0 && !L.Z.sensorOn, 'world close unregisters it (and stops the sensor)'); }
    { const L = load({ location: { search: '?hazard=toxic' } }), w = mkWorld('Solenne', L); w.tick(5); ok(L.Z.count() === 1 && L.Z.sensorOn === false, '?hazard=toxic = one GLOBAL source (no timer)'); w.tick(100); ok(L.S.state === 'protected' && L.H.exposure.label === 'TOXIC ATMOSPHERE', '?hazard=toxic forces protection on a safe world'); }
    { const L = load({ location: { search: '?hazard=airless' } }), w = mkWorld('Solenne', L); w.tick(100); ok(L.H.exposure.label === 'NO ATMOSPHERE' && Math.abs(L.H.exposure.I - 0.5) < 1e-9 && L.H.exposure.sec > 200, '?hazard=airless: the long vacuum clock (' + L.H.exposure.sec.toFixed(0) + ' s)'); }
    { const L = load({ location: { search: '?shield=0&hazard=toxic' } }), w = mkWorld('Solenne', L); w.tick(100); ok(L.S.state === 'off' && w.sc.children.length === 2 && w.nat.reqs.length === 0 && L.H.exposure.on, '?shield=0: no LED / crown / light, the exposure clock still runs for the HUD'); }
    { const L = load({ location: { search: '?hazard=toxic' } }), w = mkWorld('Solenne', L); w.tick(60); L.ctx.DM_FAC = { bay: { inside: true } }; w.tick(60); ok(L.S.state === 'off' && !L.H.exposure.sensed, 'the pressurised Titan bay: breathable inside, nothing sensed'); }
  }
  console.log(bad ? 'shield-unit: ' + bad + ' FAILED of ' + n : 'shield-unit: ' + n + '/' + n + ' ok'); process.exit(bad ? 1 : 0);
})();
