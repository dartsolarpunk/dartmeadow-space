// node tools/tests/temple-arrival.js — QUICK TRAVEL TO TEMPLE: the arrival is VERIFIED before "Arrived at the Bird Temple" is shown (v329).
// Runs the REAL _btHullR / _btArrivalPlace / _btArrivalCheck / _btQtJump / travelToBirdTemple from index.html (real three.js math) against synthetic temples.
// Regression for the v328 iPad report ("Arrived" toast, ALT 1 222 187 km, an empty star field and a ~50 px speck):
//   the hull radius used for the arrival distance was cached from the SPAWN frame, when the temple's children (BTE_Engineering is matrixAutoUpdate=false) still had
//   their pre-move world matrices: a "hull" the size of half the ship's distance from the Sun (310 u at 612 u out, 3754 u at 7500 u out vs the real 15 u).
// three.js: THREE_CORE=/path/to/three.core.js (r185 ESM build), else /workspace/three185/three.core.js or node_modules/three; SKIP (exit 0) if none.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), url = require('url');
const root = path.join(__dirname, '..', '..');
const cands = [process.env.THREE_CORE, '/workspace/three185/three.core.js', path.join(root, 'node_modules/three/build/three.core.js')].filter(Boolean);
const tp = cands.find(p => fs.existsSync(p));
if (!tp) { console.log('temple-arrival: SKIP (no three.core.js; set THREE_CORE)'); process.exit(0); }
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const line = re => { const m = src.match(re); if (!m) throw new Error('missing ' + re); return m[0]; };
(async () => {
  const THREE = await import(url.pathToFileURL(tp).href);
  // a temple like the real one: hull meshes + a matrixAutoUpdate=false office sub-tree (as ui/dm-bt-engineering.js freezes it), built at the ORIGIN, then
  // moved far away by the spawn code WITHOUT any matrixWorld refresh.  Returns {g, R, far}
  function makeTemple(rnd, dist) {
    const g = new THREE.Group(), h = 10 + rnd() * 6;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2 * h, h * 0.6, 2 * h)));
    const office = new THREE.Group(); office.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))); office.children[0].position.set(h * 0.2, 0, 0); g.add(office);
    g.scale.setScalar(0.11); g.updateMatrixWorld(true);
    office.traverse(o => { o.matrixAutoUpdate = false; });            // frozen local matrices, like BTE_Engineering
    const R = new THREE.Box3().setFromObject(g).getBoundingSphere(new THREE.Sphere()).radius;
    g.position.set(dist * 0.8, 40, -dist * 0.6);                        // the spawn move: no updateMatrixWorld afterwards
    return { g, R, office };
  }
  function mkCtx(g, R0, extra) {
    const toasts = [], says = [], closed = [];
    const ctx = Object.assign({ THREE, Math, isFinite, console, performance, toasts, says, closed, toast: m => toasts.push(m), _btSay: m => says.push(m), closeTempleHub: () => closed.push(1), updateAssistButtons() { }, takeMouseLook: () => ({ x: 0, y: 0 }),
      surfaceActive: false, atmoActive: false, SHIP_WALK: { active: false }, boardFlight: { position: new THREE.Vector3() }, flightInited: true, pend: [], ensured: [], clearTimeout() { }, clearInterval() { },
      flightScene: new THREE.Scene(), flightCamera: new THREE.PerspectiveCamera(60, 1, 0.1, 3e5), _btEnsure: r => { ctx.ensured.push(r); return true; }, _btLoadModel() { }, _btCrumb() { }, _dmCompileObject() { }, _disposeObject3D() { }, dmAction() { },
      setTimeout: f => ctx.pend.push(f), atmoExitToSpace() { }, exitSurface() { } }, extra || {});
    vm.createContext(ctx);
    vm.runInContext(['_btFixCull', '_btMeshCount', '_btProbe', '_btDist', '_btVerify', '_btArrive', '_btRebuild', '_btQtWaitForTemple', 'spQuat', 'spForward', 'spUp', 'spRight', 'spAimQuat', 'spSyncLegacy', 'disengageAssist', '_btHullR', '_btNote',
      '_btArrivalPlace', '_btArrivalCheck', '_btTravelNote', '_btQtJump', 'travelToBirdTemple'].map(fn).join('\n') + '\n' + line(/const _BT_QT_DIR=\[[^\]]+\];/) + '\n' + line(/const BT_ARRIVE_K=[^;]+;/) + '\nconst BT_KEEP_R=20000, BT_RETRY_MAX=3;' +
      '\nlet _btQtBusy=false, _btQtWait=0; const _clamp=(v,a,b)=>Math.max(a,Math.min(b,v)); let _sV0=new THREE.Vector3(),_sV1=new THREE.Vector3(),_sV2=new THREE.Vector3(),_sV3=new THREE.Vector3(),_sV4=new THREE.Vector3(),_sM1=new THREE.Matrix4(),_sQ1=new THREE.Quaternion(),_sQ2=new THREE.Quaternion(),_sQ3=new THREE.Quaternion();' +
      '\nlet _followInit=true,_bfcPrevW=new THREE.Vector3(1,2,3),_bfcPrevL=new THREE.Vector3(4,5,6);' +
      '\nconst ASSIST={mode:"focus",target:{name:"Mars"},orbitOffset:null,homeOffset:null,lockOffset:new THREE.Vector3(),_homeAfterArrive:false};' +
      '\nconst STATE={screen:"flight",flight:{pos:new THREE.Vector3(5e4,-3e3,2e4),vel:new THREE.Vector3(9,9,9),quat:new THREE.Quaternion()}};' +
      '\nconst BIRD_TEMPLE={group:null,spawned:false,_R0:0,_s0:0,_gaveUp:false,_loading:false,_retryT:0};', ctx);
    ctx.__g = g; ctx.flightScene.add(g);
    vm.runInContext('BIRD_TEMPLE.group=__g; BIRD_TEMPLE.spawned=true; BIRD_TEMPLE._R0=' + R0 + '; BIRD_TEMPLE._s0=__g.scale.x;', ctx);
    return ctx;
  }
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(11);
  const arrived = t => t.some(m => /Arrived at the Bird Temple/.test(m)), failed = t => t.find(m => /Could not reach the Bird Temple/.test(m));
  for (const dist of [612, 3055, 7500, 15000]) {
    const { g, R } = makeTemple(rnd, dist);
    // the premise: measured naively right after the move the "hull" is about half the distance from the origin (this is the bug the arrival used to inherit)
    const naive = new THREE.Box3().setFromObject(g).getBoundingSphere(new THREE.Sphere()).radius;
    ok(naive > 5 * R || process.env.VERBOSE, 'd' + dist + ': premise (stale children inflate a naive hull: ' + naive.toFixed(0) + ' vs ' + R.toFixed(1) + ')');
    const ctx = mkCtx(g, R);
    const hull = vm.runInContext('_btHullR()', ctx);
    ok(hull > 0.9 * R && hull < 1.3 * R, 'd' + dist + ': the hull radius is the ship\'s (' + hull.toFixed(1) + ' vs ' + R.toFixed(1) + '), not the distance from the origin');
    vm.runInContext('travelToBirdTemple()', ctx);
    const c = g.getWorldPosition(new THREE.Vector3()), sp = vm.runInContext('STATE.flight', ctx), d = sp.pos.distanceTo(c);
    ok(d >= 2.4 * R * 0.99 && d <= 4 * R, 'd' + dist + ': arrives ' + (d / R).toFixed(2) + 'R from the ship (units ' + d.toFixed(1) + '), in plain sight');
    ok(sp.pos.length() > 0.5 * dist, 'd' + dist + ': and that is at the ship, not near the origin');
    ok(arrived(ctx.toasts) && !failed(ctx.toasts), 'd' + dist + ': announced only after the checks pass');
    const chk = vm.runInContext('_btArrivalCheck()', ctx); ok(chk.ok && chk.info.inScene && chk.info.visible && chk.info.facingDot > 0.99, 'd' + dist + ': check: in scene, visible, facing it ' + JSON.stringify(chk.fails));
    ok(vm.runInContext('BIRD_TEMPLE._travel.length', ctx) === 1, 'd' + dist + ': one attempt recorded for btDiag');
  }
  { // a stray far-away child that really is far (not a stale matrix) must not become the "hull" either
    const { g, R } = makeTemple(rnd, 800); g.updateMatrixWorld(true); const stray = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); stray.position.set(0, 0, 40000); g.add(stray); g.updateMatrixWorld(true);
    const ctx = mkCtx(g, R); const hull = vm.runInContext('_btHullR(true)', ctx); ok(hull <= 1.01 * R, 'stray decor 4000 u out: hull falls back to the model radius (' + hull.toFixed(1) + ')');
    vm.runInContext('travelToBirdTemple()', ctx); const d = vm.runInContext('STATE.flight', ctx).pos.distanceTo(g.getWorldPosition(new THREE.Vector3())); ok(d < 4 * R && arrived(ctx.toasts), 'stray decor: arrival still ' + (d / R).toFixed(1) + 'R');
  }
  { // not in the active scene / hidden: repaired, then announced
    const { g, R } = makeTemple(rnd, 3055); const ctx = mkCtx(g, R); ctx.flightScene.remove(g); g.visible = false;
    vm.runInContext('travelToBirdTemple()', ctx); ok(g.parent === ctx.flightScene && g.visible && arrived(ctx.toasts), 'detached + hidden ship is put back in the scene, shown, then announced');
  }
  { // the ship cannot be drawn (no size): never announced, the toast names the failing check, a second (safe-spawn) attempt was made, btDiag has both
    const { g, R } = makeTemple(rnd, 3055); const ctx = mkCtx(g, R); g.scale.setScalar(1e-9);
    vm.runInContext('travelToBirdTemple()', ctx);
    ok(!arrived(ctx.toasts) && /no size/.test(failed(ctx.toasts) || '') && /btDiag/.test(failed(ctx.toasts) || ''), 'unusable ship: no "Arrived"; the message names the failing check: ' + (failed(ctx.toasts) || '').slice(0, 90));
    ok(ctx.says.length === 1 && vm.runInContext('BIRD_TEMPLE._travel.length', ctx) === 2 && vm.runInContext('BIRD_TEMPLE._travel[1].K', ctx) > 2.4, 'retried once with a roomier safe point; both attempts recorded; one system message');
  }
  { // an open world that draws only its own scene (skyK 1) is closed on the retry
    const { g, R } = makeTemple(rnd, 3055); let closes = 0; const PW = { active: true, opening: false, mode: 'fly', skyK: 1, sp: null };
    const ctx = mkCtx(g, R, { PW, _pwCloseToSpace() { closes++; PW.active = false; } });
    vm.runInContext('_btQtJump()', ctx); ok(closes === 1 && arrived(ctx.toasts), 'a world that hides space: closed on the retry, then announced');
    const PW2 = { active: true, opening: false, mode: 'fly', skyK: 1, sp: null }; const ctx2 = mkCtx(g, R, { PW: PW2, _pwCloseToSpace() { } });
    vm.runInContext('_btQtJump()', ctx2); ok(!arrived(ctx2.toasts) && /planet world/.test(failed(ctx2.toasts) || ''), 'a world that will not close: not announced, says why');
  }
  { // 'space'-mode world (neither walk nor fly): closed BEFORE the jump, with a re-open cool-down
    const { g, R } = makeTemple(rnd, 3055); let closes = 0; const PW = { active: true, opening: false, mode: 'space', skyK: 0, sp: { out: true }, _spaceCool: 0 };
    const ctx = mkCtx(g, R, { PW, _pwCloseToSpace() { closes++; PW.active = false; } });
    vm.runInContext('travelToBirdTemple()', ctx); ok(closes === 1 && PW._spaceCool > 0 && arrived(ctx.toasts), 'space-mode world: closed cleanly before the jump (cool-down set), then announced');
  }
  console.log(fails ? 'temple-arrival: FAILED ' + fails + '/' + n : 'temple-arrival: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
