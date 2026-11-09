// node tools/tests/temple-travel.js — QUICK TRAVEL TO TEMPLE (index.html travelToBirdTemple), the camera / arrival fix.
// Runs the REAL travelToBirdTemple + spAimQuat / spQuat / spSyncLegacy / spForward / spUp / spRight / disengageAssist from index.html with real three.js
// math, against a temple group at random positions / orientations / scales:
//   refused while the temple is not spawned (nothing moves); arrival OUTSIDE the hull (>= 1.6x its radius) and above the deck plane in the temple's
//   own frame; the board nose aims at the temple; FOCUS / autopilot released; the panel closed; follow cam re-seated; hull sweep state reset; toast.
// three.js: THREE_CORE=/path/to/three.core.js (r185 ESM build), else /workspace/three185/three.core.js or node_modules/three; SKIP (exit 0) if none.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), url = require('url');
const root = path.join(__dirname, '..', '..');
const cands = [process.env.THREE_CORE, '/workspace/three185/three.core.js', path.join(root, 'node_modules/three/build/three.core.js')].filter(Boolean);
const tp = cands.find(p => fs.existsSync(p));
if (!tp) { console.log('temple-travel: SKIP (no three.core.js; set THREE_CORE)'); process.exit(0); }
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function fn(name) { const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error(name); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const line = re => { const m = src.match(re); if (!m) throw new Error('missing ' + re); return m[0]; };
(async () => {
  const THREE = await import(url.pathToFileURL(tp).href);
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
  for (let trial = 0; trial < 24; trial++) {
    const toasts = [], closed = [];
    const ctx = { THREE, Math, isFinite, console, toast: (m) => toasts.push(m), closeTempleHub: () => closed.push(1), updateAssistButtons() { }, takeMouseLook: () => ({ x: 0, y: 0 }),
      surfaceActive: false, atmoActive: false, SHIP_WALK: { active: false }, boardFlight: { position: new THREE.Vector3() } };
    vm.createContext(ctx);
    vm.runInContext(['spQuat', 'spForward', 'spUp', 'spRight', 'spAimQuat', 'spSyncLegacy', 'disengageAssist', '_btHullR', 'travelToBirdTemple'].map(fn).join('\n') + '\n' + line(/const _BT_QT_DIR=\[[^\]]+\];/) +
      '\nconst _clamp=(v,a,b)=>Math.max(a,Math.min(b,v)); let _sV0=new THREE.Vector3(),_sV1=new THREE.Vector3(),_sV2=new THREE.Vector3(),_sV3=new THREE.Vector3(),_sV4=new THREE.Vector3(),_sM1=new THREE.Matrix4(),_sQ1=new THREE.Quaternion(),_sQ2=new THREE.Quaternion(),_sQ3=new THREE.Quaternion();' +
      '\nlet _followInit=true,_bfcPrevW=new THREE.Vector3(1,2,3),_bfcPrevL=new THREE.Vector3(4,5,6);' +
      '\nconst ASSIST={mode:"focus",target:{name:"Mars"},orbitOffset:null,homeOffset:null,lockOffset:new THREE.Vector3(),_homeAfterArrive:false};' +
      '\nconst STATE={flight:{pos:new THREE.Vector3(5e4,-3e3,2e4),vel:new THREE.Vector3(9,9,9),quat:new THREE.Quaternion()}};' +
      '\nconst BIRD_TEMPLE={group:null,spawned:false,_R0:0};', ctx);
    const run = c => vm.runInContext(c, ctx);
    // a temple: random pose / scale, a hull ~ a box of half-size h (local); its world bounding radius is what _btHullR measures
    const g = new THREE.Group(), h = 8 + rnd() * 30, sc = 0.5 + rnd() * 3;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2 * h, h * 0.6, 2 * h)));
    g.position.set((rnd() - 0.5) * 1e5, (rnd() - 0.5) * 1e4, (rnd() - 0.5) * 1e5); g.quaternion.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.8, rnd() * 6.28, (rnd() - 0.5) * 0.8)); g.scale.setScalar(sc); g.updateMatrixWorld(true);
    ctx.__g = g;
    // refused before the temple is spawned / loaded
    const p0 = run('STATE.flight.pos.clone()');
    run('BIRD_TEMPLE.group=null'); run('travelToBirdTemple()'); run('BIRD_TEMPLE.group=__g; BIRD_TEMPLE.spawned=false'); run('travelToBirdTemple()');
    ok(run('STATE.flight.pos').equals(p0) && run('ASSIST.mode') === 'focus' && closed.length === 0, 't' + trial + ': refused while not spawned (nothing moved)');
    const R0 = new THREE.Box3().setFromObject(g).getBoundingSphere(new THREE.Sphere()).radius * (0.8 + rnd() * 0.4);
    run('BIRD_TEMPLE.spawned=true; BIRD_TEMPLE._R0=' + R0 + '; BIRD_TEMPLE._bsR=0;');
    run('travelToBirdTemple()');
    const sp = run('STATE.flight'), c = g.getWorldPosition(new THREE.Vector3()), hullR = run('_btHullR()'), d = sp.pos.distanceTo(c);
    ok(d >= 1.6 * R0 - 1e-6 && d >= 1.6 * hullR - 1e-6, 't' + trial + ': arrives outside the hull: ' + (d / Math.max(R0, hullR)).toFixed(2) + 'x its radius');
    const loc = g.worldToLocal(sp.pos.clone());
    ok(loc.y > h * 0.3 + 0.2 * Math.hypot(loc.x, loc.z), 't' + trial + ': above the deck in the temple frame (local y ' + loc.y.toFixed(1) + ', deck top ' + (h * 0.3).toFixed(1) + ')');
    const box = new THREE.Box3().setFromObject(g); ok(!box.containsPoint(sp.pos), 't' + trial + ': not inside the hull box');
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sp.quat), to = c.clone().sub(sp.pos).normalize();
    ok(fwd.dot(to) > 0.9999, 't' + trial + ': nose aimed at the temple (cos ' + fwd.dot(to).toFixed(6) + ')');
    ok(Math.abs(sp.camYaw - Math.atan2(-fwd.x, -fwd.z)) < 1e-9 && Math.abs(sp.camPitch - Math.asin(fwd.y)) < 1e-9, 't' + trial + ': legacy yaw/pitch synced');
    ok(sp.vel.lengthSq() === 0 && ctx.boardFlight.position.equals(sp.pos), 't' + trial + ': stopped, board moved with her');
    ok(run('ASSIST.mode') === 'manual' && run('ASSIST.target') === null && run('ASSIST.lockOffset') === null, 't' + trial + ': FOCUS / autopilot released');
    ok(closed.length === 1, 't' + trial + ': temple panel closed');
    ok(run('_followInit') === false && run('_bfcPrevW') === null && run('_bfcPrevL') === null, 't' + trial + ': follow cam re-seats, hull sweep reset');
    ok(/Arrived at the Bird Temple/.test(toasts[toasts.length - 1] || ''), 't' + trial + ': toast');
    // aboard: refused
    run('SHIP_WALK.active=true'); const p1 = run('STATE.flight.pos.clone()'); run('STATE.flight.pos.x+=1'); const p2 = run('STATE.flight.pos.clone()'); run('travelToBirdTemple()');
    ok(run('STATE.flight.pos').equals(p2) && !p1.equals(p2), 't' + trial + ': refused while walking aboard');
  }
  console.log(fails ? 'temple-travel: FAILED ' + fails + '/' + n : 'temple-travel: all ' + n + ' checks passed (three ' + path.basename(path.dirname(tp)) + ')'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
