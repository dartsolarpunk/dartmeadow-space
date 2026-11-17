// node tools/tests/shield-unit.js — DMShield (ui/dm-hazardbubble.js, HUD button ui/dm-shield.js): the orb toggle, the board-group protection field,
// the staff-crown status glow + LED. Part 1 (always): pure core (hysteresis, plan, crown picker), API + events, source contracts (the orb is fully off
// on safe worlds / when toggled off; nothing allocated per frame). Part 2 (needs three.webgpu.js: THREE_WEBGPU=/path, or ~/.cache/dm-harness): runs the real
// tick against a stub world and checks what is in the scene / visible / which colour. No GPU: nothing here was RENDERED.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');
const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'ui', 'dm-hazardbubble.js'), 'utf8');
let bad = 0, n = 0; const ok = (c, m) => { n++; if (!c) { bad++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };

function mkWin(extra) { const evs = []; const win = Object.assign({ addEventListener() {}, dispatchEvent(e) { evs.push(e); return true; }, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })(), location: { search: '' } }, extra || {}); win.window = win; return { win, evs }; }
function load(extra) { const { win, evs } = mkWin(extra); const timers = [], clock = { t: 1000 };
  const ctx = Object.assign({ console, Math, performance: { now: () => clock.t }, URLSearchParams, CustomEvent: win.CustomEvent,
    setInterval: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearInterval: id => { if (timers[id - 1]) timers[id - 1] = null; } }, win); ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
  return { ctx, evs, timers, clock, H: ctx.DM_HAZ, S: ctx.DMShield, Z: ctx.DMHazard }; }
const liveTimers = t => t.filter(Boolean).length;

console.log('== pure core');
{ const { S } = load(), C = S.core, R = 100;
  ok(C.RADIUS_MUL === 15 && S.RADIUS_MUL === 15, 'protection radius = 15 x her height by default');
  ok(C.stepStatus('protected', 0, R) === 'protected' && C.stepStatus('protected', 79, R) === 'protected', 'inside 0.8 R: protected (green)');
  ok(C.stepStatus('protected', 85, R) === 'warn' && C.stepStatus('protected', 100, R) === 'warn', '0.8 R .. R: warn (amber)');
  ok(C.stepStatus('protected', 101, R) === 'exposed', 'beyond R: exposed (red)');
  ok(C.stepStatus('warn', 78, R) === 'warn' && C.stepStatus('warn', 73, R) === 'protected', 'warn -> protected only inside 0.74 R (hysteresis)');
  ok(C.stepStatus('exposed', 95, R) === 'exposed' && C.stepStatus('exposed', 91, R) === 'warn' && C.stepStatus('exposed', 70, R) === 'protected', 'exposed -> back only inside 0.92 R');
  let st = 'protected', flips = 0; for (let i = 0; i < 400; i++) { const d = 100 + 3 * Math.sin(i * 0.7); const s2 = C.stepStatus(st, d, R); if (s2 !== st) flips++; st = s2; }
  ok(flips <= 2, 'jitter of +-3 % at the edge does not flicker (' + flips + ' changes in 400 frames)');
  ok(C.stepStatus('exposed', NaN, R) === 'protected' && C.stepStatus('warn', 5, 0) === 'protected', 'degenerate inputs never throw / never red');
  ok(JSON.stringify(C.shieldPlan(false, 0)) === '{"hulls":2,"point":true,"led":true,"pulse":true}', 'plan: Med+ = 2 shells + fake point light + LED');
  ok(C.shieldPlan(true, 0).hulls === 1 && C.shieldPlan(true, 0).point === false, 'plan: Low = 1 shell, NO extra light');
  ok(C.shieldPlan(false, 2).hulls === 1 && !C.shieldPlan(false, 2).point, 'plan: DMBudget light >= 2 sheds the outer shell + the point light');
  ok(C.shieldPlan(false, 3).hulls === 0 && C.shieldPlan(false, 3).led && !C.shieldPlan(false, 3).pulse, 'plan: DMBudget light 3 = LED only');
  const names = a => a.map((x, i) => ({ name: x, base: '' }));
  ok(JSON.stringify(C.pickCrown(names(['hull', 'staff', 'staff head 1', 'staff head 2', 'tail shard 1']), false)) === '[2,3]', 'crown: template C "staff head" pieces');
  ok(JSON.stringify(C.pickCrown([{ name: 'deck' }, { name: 'staff' }, { name: 'arrowhead shard 1', base: 'ornament' }, { name: 'arrowhead shard 2', base: 'ornament' }], false)) === '[2,3]', 'crown: A / B arrowhead shards');
  ok(JSON.stringify(C.pickCrown([{ name: 'deck' }, { name: 'staff' }, { name: 'arrowhead shard', base: '' }], true)) === '[1]', 'crown: Ariel board -> the staff rail (its arrowhead is the nose)');
  ok(C.pickCrown([{ name: 'deck' }], false).length === 0, 'crown: nothing found -> empty (a short mast LED over the deck)'); }

console.log('== API + events');
{ const { S, evs, ctx } = load();
  ok(S.available === false && S.on === true && S.state === 'off' && S.protected === true, 'default: orb on, not available on a world that was never hazardous');
  S.toggle(); ok(S.on === false && evs.length === 1 && evs[0].type === 'dmshield' && evs[0].detail.on === false, 'toggle() flips + fires dmshield {on:false}');
  S.set(false); ok(evs.length === 1, 'no event when nothing changed');
  S.set(true); ok(S.on === true && evs.length === 2, 'set(true) -> on');
  ok(ctx.localStorage.getItem('dm_shield_orb') === '1', 'choice kept per viewer (localStorage, try/catch)');
  const b = load({ localStorage: { getItem: () => '0', setItem() {} } }); ok(b.S.on === false, 'remembered OFF choice is restored');
  const off = load({ location: { search: '?shield=0' } }); off.S.set(false); ok(off.S.on === true && off.S.available === false, '?shield=0 : feature off, orb stays as before, no button');
  const r = load({ location: { search: '?shieldr=30' } }); ok(r.S.RADIUS_MUL === 30, '?shieldr= sets the radius multiplier');
  const f = load({ location: { search: '?hazard=toxic' } }); ok(f.H.kind({ name: 'Solenne' }, null) === 'toxic', '?hazard=toxic forces toxic air on any world');
  const sf = load({ location: { search: '?hazard=safe' } }); ok(sf.H.kind({ name: 'Mars' }, null) === 'breathable', '?hazard=safe forces breathable air');
  const nm = load(); ok(nm.H.kind({ name: 'Solenne' }, null) === 'breathable' && nm.H.kind({ name: 'Earth' }, null) === 'breathable' && nm.H.kind({ name: 'Mars' }, { atmos: true }) === 'toxic' && nm.H.kind({ name: 'Moon' }, null) === 'airless', 'default air kinds: home planet + Earth safe, Mars toxic, Moon airless'); }

console.log('== source contracts');
{ const tick = src.slice(src.indexOf('H.tick=function'), src.indexOf('H.setOff='));
  ok(/if\(!SH\.on\) tgt=0;/.test(tick), 'orb toggled off -> orb target 0 (no orb)');
  ok(/if\(tOrb\*\(1-H\.dis\)<0\.001&&H\.a<0\.02\) H\.a=0;/.test(tick), 'the orb fade snaps to exactly 0 (not an asymptote)');
  ok(/if\(!S\.scene&&kind==='breathable'&&!SH\.armed&&!\(W&&mode==='fly'\)\)\{[^}]*return;\s*\}/.test(tick) && tick.indexOf("kind==='breathable'&&!SH.armed") < tick.indexOf('attach(PW.scene'), 'safe dry worlds (Ariel mansion / home planet): the orb is never attached to the scene');
  ok(/const wake=H\.hostile\|\|SH\.armed\|\|HZ\.near/.test(tick) && /if\(!wake&&!dive\)\{[\s\S]*?return; \}/.test(tick) && tick.indexOf('if(!wake&&!dive)') < tick.indexOf('groupSphere('), 'safe map: the tick returns BEFORE groupSphere / shield / orb work (one boolean test)');
  ok(/if\(PW\.body!==_gb\|\|PW\.pal!==_gp\) gateWorld\(\);/.test(tick), 'the air kind is evaluated once per world open (body / palette identity), not per frame');
  ok(!/H\.kind\(/.test(tick), 'no H.kind() call in the per-frame tick');
  ok(/S\.front\.visible=S\.back\.visible=vis/.test(tick), 'orb meshes are visible only while H.a > 0.01 (hidden = not in any render list)');
  ok(/m\.position\.set\(0,-1e7,0\); m\.scale\.setScalar\(1e-3\)/.test(src), 'the compile dummy is a speck under the world (never a disc over the ground)');
  ok(/H\.shieldHide\(\)/.test(tick) && /H\.shieldRelease\(\)/.test(src.slice(src.indexOf('H.close=function'), src.indexOf('H.hide='))), 'shield hidden when the air mode ends, released on world close');
  const sh = src.slice(src.indexOf('function shFrame'), src.indexOf('function shOff'));
  ok(!/new [A-Z]\w*\(|\[\s*\]|\{\s*\w+\s*:/.test(sh.replace(/if\(!_M\)\{[^}]*\}/, '')), 'shFrame allocates nothing per frame (scratch made once)');
  ok(/side:THREE\.BackSide/.test(src) && /modelScale/.test(src) && /AdditiveBlending/.test(src) && /depthWrite:false/.test(src), 'crown glow = additive inverted hull, depthWrite off, scale-independent thickness');
  ok(/raycast=\(\)=>\{\}/.test(src) && /userData\.dmShield=true/.test(src), 'crown / LED meshes are never colliders or pick targets');
  ok(/VL\.setPoints\('shield'/.test(src) && /plan\.point/.test(src), 'the LED light is a DMVLight point (no real light: no material recompile)');
  ok(!/new THREE\.(Point|Spot)Light/.test(src), 'no real THREE light is created'); }

// ---------------------------------------------------------------- part 2: the real tick on a stub world
const cands = [process.env.THREE_WEBGPU, path.join(os.homedir(), '.cache/dm-harness/node_modules/three/build/three.webgpu.js'), '/workspace/three185/three.webgpu.js', path.join(root, 'node_modules/three/build/three.webgpu.js')].filter(Boolean);
const tp = cands.find(p => fs.existsSync(p));
(async () => {
  if (!tp) console.log('  (part 2 skipped: no three.webgpu.js; set THREE_WEBGPU)');
  else {
    const THREE = await import('file://' + tp);
    console.log('== real tick, stub world (three ' + THREE.REVISION + ')');
    const { ctx, evs, H, S } = load();
    ctx.THREE = THREE; ctx.GFX = { preset: 'high', isMobile: false };
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(); cam.position.set(0, 3, 8);
    const mk = (name, x, y, z, base) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial()); m.name = name; m.position.set(x, y, z); if (base) m.userData.basePart = base; return m; };
    const board = new THREE.Group(); board.add(mk('deck', 0, 0, 0), mk('staff', -1, 0.6, 0.3), mk('staff head 1', -1, 1.3, 0.3), mk('staff head 2', -1, 1.4, 0.3)); scene.add(board);
    const her = new THREE.Object3D(); scene.add(her); const H_ = 1.7;
    ctx.CHAR = { root: her, rawHeight: H_ }; ctx.surfBoard = board; ctx.atmoBoard = board; ctx._lcBoardLen = () => 3;
    ctx.PW = { active: true, scene, camera: cam, board, mode: 'walk', body: { name: 'Mars', mcHasAtm: true }, pal: { atmos: true }, renderer: null };
    const step = (k, dt) => { for (let i = 0; i < (k || 1); i++) { scene.updateMatrixWorld(true); H.tick(dt || 1 / 60); } };
    const crownMeshes = () => scene.children.filter(o => o.name === 'dm-shield-crown'), led = () => scene.children.find(o => o.name === 'dm-shield-led');
    const orbVis = () => scene.children.filter(o => o.name === 'dm-haz-orb' && o.visible).length;
    board.position.set(0, 0, 0); her.position.set(3, 0, 0);
    step(240);
    ok(S.available === true && S.state === 'orb', 'toxic world on foot: available, orb mode');
    ok(orbVis() === 2, 'orb ON: both orb meshes drawn');
    ok(crownMeshes().length === 4 && crownMeshes().every(m => !m.visible) && led() && !led().visible, 'orb ON: crown hulls (2 pieces x 2 shells) built, hidden; LED hidden');
    S.set(false); step(200);
    ok(orbVis() === 0, 'orb OFF: no orb mesh is visible (not drawn at all)');
    ok(S.status === 'protected' && crownMeshes().filter(m => m.visible).length === 4 && led().visible, 'orb OFF, parked board within the field: crown glow + LED on, status protected');
    const rr = S.radius(); ok(Math.abs(rr - H_ * 15) < 1e-6, 'radius = 15 x her height (' + rr.toFixed(1) + ' u)');
    ok(S.protected === true, 'DMShield.protected true inside the field');
    const colOf = () => { const m = crownMeshes()[0].material.colorNode; return m.value.clone(); };
    let c0 = colOf(); ok(c0.g > c0.r && c0.g > c0.b, 'crown colour is GREEN while protected (' + [c0.r, c0.g, c0.b].map(v => v.toFixed(2)) + ')');
    her.position.set(rr * 0.9, 0, 0); step(120); ok(S.status === 'warn', 'walking toward the edge: amber warning'); c0 = colOf(); ok(c0.r > 0.8 && c0.g > 0.5 && c0.b < 0.4, 'crown colour is AMBER');
    her.position.set(rr * 1.3, 0, 0); step(120); ok(S.status === 'exposed' && S.protected === false, 'outside the field: exposed, not protected'); c0 = colOf(); ok(c0.r > 0.8 && c0.g < 0.4, 'crown colour is RED');
    ok(crownMeshes().every(m => m.visible) && led().visible, 'still shows the status (red) outside the field');
    // summon: the board flies to her; protected again once it is inside the field
    board.position.set(rr * 0.2, 0, 0.5); step(60); ok(S.status === 'exposed', 'the board is still on its way (1.1 R away): not yet green');
    board.position.set(rr * 1.3 - 2, 0, 0); step(120); ok(S.status === 'protected', 'summoned board reaches her: protected again');
    // orb back ON: crown + LED off, the orb is back
    S.set(true); step(240); ok(crownMeshes().every(m => !m.visible) && !led().visible, 'orb back ON: crown glow + LED turn OFF');
    ok(orbVis() === 2, 'orb back ON: she is back inside the orb');
    // tiers
    S.set(false); ctx.GFX.preset = 'low'; ctx.DMBudget = { on: true, lvl: () => 0 }; step(120);
    ok(crownMeshes().filter(m => m.visible).length === 2, 'Low tier: one shell only (2 meshes)'); ctx.GFX.preset = 'high';
    ctx.DMBudget = { on: true, lvl: () => 2 }; step(5); ok(crownMeshes().filter(m => m.visible).length === 2, 'DMBudget light 2: outer shell shed');
    ctx.DMBudget = { on: true, lvl: () => 3 }; step(5); ok(crownMeshes().filter(m => m.visible).length === 0 && led().visible, 'DMBudget light 3: LED only');
    ctx.DMBudget = null;
    // fake light
    const calls = []; ctx.DMVLight = { on: true, setPoints: (k, a, o) => calls.push([k, a.slice(), o]), clear: k => calls.push(['clear', k]) };
    board.position.set(0, 0, 0); her.position.set(1, 0, 0); step(60);
    const pt = calls.filter(c => c[0] === 'shield'); ok(pt.length > 0 && pt[pt.length - 1][1][6] > 0 && pt[pt.length - 1][1][4] > pt[pt.length - 1][1][3], 'Med+: a DMVLight point at the LED in the status colour');
    ctx.GFX.preset = 'low'; calls.length = 0; step(10); ok(!calls.some(c => c[0] === 'shield'), 'Low tier: no extra light');
    ctx.GFX.preset = 'high';
    // safe world: nothing at all
    ctx.PW.body = { name: 'Solenne' }; ctx.PW.pal = null; step(200);
    ok(S.available === false && crownMeshes().every(m => !m.visible) && !led().visible && orbVis() === 0, 'safe world (Solenne): shield unavailable, crown / LED / orb all hidden');
    ok(scene.children.filter(o => o.name === 'dm-haz-orb').length === 2, '(a world that WAS toxic keeps its orb objects attached but hidden)');
    // a fresh scene on the home planet: the orb is never attached at all
    const scene2 = new THREE.Scene(), b2 = new THREE.Group(); b2.add(mk('staff', 0, 1, 0)); scene2.add(b2); H.close(scene);
    ctx.PW = { active: true, scene: scene2, camera: cam, board: b2, mode: 'walk', body: { name: 'Solenne' }, pal: null, renderer: null }; ctx.JOTS_WATER = null;
    for (let i = 0; i < 120; i++) { scene2.updateMatrixWorld(true); H.tick(1 / 60); }
    ok(scene2.children.length === 1, 'home planet / mansion: NOTHING of the orb or the shield is added to the scene (' + scene2.children.map(o => o.name).join(',') + ')');
    // close
    ctx.PW = { active: true, scene, camera: cam, board, mode: 'walk', body: { name: 'Mars', mcHasAtm: true }, pal: { atmos: true }, renderer: null };
    for (let i = 0; i < 120; i++) { scene.updateMatrixWorld(true); H.tick(1 / 60); }
    ok(crownMeshes().length === 4, 'back on a toxic world: rebuilt');
    H.close(scene); ok(crownMeshes().length === 0 && !led() && scene.children.filter(o => /^dm-/.test(o.name)).length === 0, 'world close: crown, LED and orb removed from the scene');
    ok(calls.length >= 0, 'closed'); H.dispose(); ok(true, 'dispose ran');

    // ───────── DMHazard: registry + sensor + dormancy + local-source flow ─────────
    console.log('== DMHazard registry / sensor');
    { const L = load(), Z = L.Z;
      ok(Z.count() === 0 && !Z.sensorOn && liveTimers(L.timers) === 0 && Z.ticks === 0, 'no sources: no timer, nothing ticking');
      const g = Z.register({ type: 'atmosphere', shape: 'global', gas: 'toxic' }); ok(Z.count() === 1 && liveTimers(L.timers) === 0, 'a global source (toxic atmosphere) needs no sensor timer');
      const id = Z.register({ type: 'vent', shape: 'sphere', x: 10, y: 0, z: 0, r: 3, gas: 'sulfur' });
      ok(Z.sensorOn && liveTimers(L.timers) === 1 && L.timers[0].ms >= 250 && L.timers[0].ms <= 500, 'first LOCAL source starts ONE ~3 Hz timer (' + L.timers[0].ms + ' ms)');
      Z.register({ type: 'vent', shape: 'sphere', x: 50, y: 0, z: 0, r: 3 }); ok(liveTimers(L.timers) === 1, 'more sources share the one timer');
      ok(Z.unregister(id) && Z.sensorOn, 'unregister keeps the timer while a local source remains');
      Z.clear(); ok(Z.count() === 0 && !Z.sensorOn && liveTimers(L.timers) === 0, 'clear() (world close) removes every source and the timer');
      const C = Z.core;
      ok(C.hazardDist({ shape: 'sphere', x: 0, y: 0, z: 0, r: 5 }, 8, 0, 0) === 3 && C.hazardDist({ shape: 'sphere', x: 0, y: 0, z: 0, r: 5 }, 2, 0, 0) === -3, 'sphere: signed distance to the edge');
      const col = { shape: 'column', x: 0, z: 0, r: 4, y0: 0, y1: 20 };
      ok(C.hazardDist(col, 6, 10, 0) === 2 && C.hazardDist(col, 1, 10, 0) === -3 && Math.abs(C.hazardDist(col, 7, 24, 0) - 5) < 1e-9, 'column: horizontal / inside / above the top');
      ok(C.hazardStep(-1, 5) === 'inside' && C.hazardStep(3, 5) === 'near' && C.hazardStep(9, 5) === 'clear', 'inside / near / clear'); }

    console.log('== dormancy on safe maps (home planet / mansion)');
    const mkWorld = (name, L) => { const THREE_ = THREE, sc = new THREE.Scene(), cm = new THREE.PerspectiveCamera(), bd = new THREE.Group(); bd.add(mk('deck', 0, 0, 0), mk('staff', -1, 0.6, 0.3), mk('arrowhead shard 1', -1, 1.3, 0.3, 'ornament')); sc.add(bd);
      const h = new THREE.Object3D(); sc.add(h); let upd = 0; const u0 = h.updateWorldMatrix.bind(h); h.updateWorldMatrix = (a, b) => { upd++; return u0(a, b); };
      L.ctx.THREE = THREE; L.ctx.GFX = { preset: 'high', isMobile: false }; L.ctx.CHAR = { root: h, rawHeight: 1.7 }; L.ctx.surfBoard = bd; L.ctx.atmoBoard = bd; L.ctx._lcBoardLen = () => 3;
      L.ctx.PW = { active: true, scene: sc, camera: cm, board: bd, mode: 'walk', body: { name }, pal: null, renderer: null };
      return { sc, bd, h, upd: () => upd, tick: k => { for (let i = 0; i < k; i++) { sc.updateMatrixWorld(true); L.H.tick(1 / 60); } } }; };
    for (const nm of ['Solenne', 'Earth']) {   // Solenne = Ariel's home planet + the mansion deck
      const L = load(), w = mkWorld(nm, L); w.h.position.set(2, 0, 0); const before = w.sc.children.length, u0 = w.upd(); w.tick(300);
      const st = L.S.stats;
      ok(w.sc.children.length === before, nm + ': nothing added to the scene in 300 frames');
      ok(st.frames === 0 && st.built === false && st.gpu === false && st.awake === false, nm + ': shield never ticked / built / compiled a material (' + JSON.stringify(st) + ')');
      ok(w.upd() === u0, nm + ': the per-frame sphere maths (groupSphere) never ran');
      ok(L.Z.count() === 0 && L.timers.length === 0 && L.Z.ticks === 0, nm + ': no hazard source, no sensor timer');
      ok(L.S.available === false && L.S.state === 'off' && L.evs.length === 0, nm + ': DMShield unavailable, state off, no event fired');
      ok(L.H.hostile === false && L.H.awake === false, nm + ': H.hostile / H.awake false'); }
    { const L = load(), w = mkWorld('Solenne', L); L.ctx.JOTS_WATER = { surfaceY: 0 }; L.ctx.PW.mode = 'fly'; w.bd.position.set(0, 300, 0); w.tick(120);
      ok(w.sc.children.length === 2 && L.S.stats.frames === 0, 'mansion / home sea, flying high above the water: still fully asleep');
      w.bd.position.set(0, 5, 0); w.tick(240); ok(w.sc.children.filter(o => o.name === 'dm-haz-orb').length === 2 && L.S.stats.frames === 0 && L.S.stats.built === false, 'low over the sea (dive path, existing feature): the blue orb wakes, the SHIELD still does not');
      w.bd.position.set(0, 300, 0); w.tick(300); ok(L.H.awake === false, 'back up in the air: asleep again (orb faded out)'); }

    console.log('== local hazard source on a healthy planet (alert -> prompt -> arm -> protect)');
    { const L = load({ location: { search: '' } }), w = mkWorld('Solenne', L), S = L.S, Z = L.Z; w.h.position.set(0, 0, 0); w.bd.position.set(3, 0, 0); w.tick(30);
      const sense = () => { w.sc.updateMatrixWorld(true); Z.sense(); }; const id = Z.register({ type: 'plume', gas: 'volcanic', shape: 'sphere', x: 40, y: 0, z: 0, r: 10, sev: 0.8 });
      ok(liveTimers(L.timers) === 1 && S.stats.frames === 0, 'a source far away: the sensor runs, the shield stays asleep');
      sense(); ok(Z.state === 'clear' && !Z.near && Z.glasses.level === 0, 'far: clear');
      w.h.position.set(22, 0, 0); sense(); ok(Z.state === 'near' && Z.near && Z.glasses.level > 0.4, 'within the warning margin: near (glasses hook level ' + Z.glasses.level + ')');
      ok(L.evs.some(e => e.type === 'dmhazard' && e.detail.state === 'near' && e.detail.gas === 'volcanic'), 'dmhazard event with state / gas');
      w.tick(200); ok(S.state === 'alert' && S.available && S.stats.frames > 0, 'near: the shield wakes in ALERT');
      const led = w.sc.children.find(o => o.name === 'dm-shield-led'), cr = w.sc.children.filter(o => o.name === 'dm-shield-crown');
      ok(led && led.visible && cr.every(m => !m.visible), 'alert: the LED housing lights, no crown glow, no orb');
      ok(w.sc.children.filter(o => o.name === 'dm-haz-orb').length === 0, 'alert: no orb object even attached');
      const lc = cr[0].material.colorNode.value; ok(lc.r > 0.8 && lc.g > 0.5 && lc.b < 0.3, 'alert LED colour is amber');
      ok(S.protected === false, 'alert: not protected yet');
      S.toggle(); ok(S.armed === true, 'HUD button in alert = arm the shield (accept)'); w.tick(240);
      ok(S.state === 'orb' && w.sc.children.filter(o => o.name === 'dm-haz-orb' && o.visible).length === 2 && !led.visible, 'armed: orb ON, the LED goes out');
      S.set(false); w.tick(240); ok(S.state === 'board' && led.visible && cr.some(m => m.visible), 'armed, orb off: the board group protects her (crown + LED)');
      w.h.position.set(300, 0, 0); sense(); ok(Z.state === 'clear', 'walked far away'); L.clock.t += 9000; sense(); ok(S.armed === false, 'armed shield drops after 8 s clear of every source');
      w.tick(300); ok(S.state === 'off' && !led.visible, 'then fully asleep again'); S.set(true);
      // cooldown
      ok(Z.cooling === false, 'no cooldown yet'); Z.dismiss(); ok(Z.cooling === true, 'DISMISS starts the prompt cooldown'); L.clock.t += 121000; ok(Z.cooling === false, 'cooldown ends after 2 min'); }
    { const L = load({ location: { search: '?hazardzone=plume' } }), w = mkWorld('Solenne', L); w.tick(5);
      ok(L.Z.count() === 1 && L.Z.sensorOn, '?hazardzone=plume: one test plume source registered at world open'); L.H.close(w.sc); ok(L.Z.count() === 0 && !L.Z.sensorOn, 'world close unregisters it (and stops the sensor)'); }
    { const L = load({ location: { search: '?hazard=toxic' } }), w = mkWorld('Solenne', L); w.tick(5); ok(L.Z.count() === 1 && L.Z.sensorOn === false, 'toxic atmosphere = one GLOBAL source (no timer)'); w.tick(100); ok(L.S.state === 'orb' && L.S.stats.frames > 0, 'global source: protection starts with the orb (as before, no prompt)'); }
    ok(evs.some(e => e.detail && e.detail.status === 'exposed') && evs.some(e => e.detail && e.detail.available === true), 'dmshield events carried status + availability');
  }
  console.log(bad ? 'shield-unit: ' + bad + ' FAILED of ' + n : 'shield-unit: ' + n + '/' + n + ' ok'); process.exit(bad ? 1 : 0);
})();
