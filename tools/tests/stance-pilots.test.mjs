// Per-pilot skyboard stance (t1644u): runs index.html's real BOARD_STANCE solver block (BOARD_STANCE .. _boardStanceClip) on the real Ariel and Emma rigs
// (three@0.185 headless) and checks:
//  1. feet planted: each ankle reaches its rest (standing) height, i.e. her soles are on the deck (Emma used Ariel's 12.8 cm ankle height = floating 3 cm)
//  2. knees keep a similar soft bend on both pilots
//  3. Emma rides with her IDLE hands: every finger joint of the stance clip equals Emma_Idle frame 0 (the pose her walk / run carry)
//  4. swapping pilots re-measures the limbs (the solver used to keep the dropped pilot's bones)
//  5. the reverse swap (Emma -> Ariel) leaves none of Emma's override-only keys (handsFrom: 'idle') or values on Ariel's effective stance
// usage: node tools/tests/stance-pilots.test.mjs   (SKIP when three@0.185 is not installed in ~/.cache/dm-harness)
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
const L = await import(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), 'lib-hair-probe.mjs')).href);
if (!L.HAVE_THREE) { console.log('SKIP: three@0.185.0 not installed'); process.exit(0); }
const { THREE } = L, require = createRequire(import.meta.url), DMChars = require(path.join(L.D, 'ui/dm-chars.js'));
const html = fs.readFileSync(path.join(L.D, 'index.html'), 'utf8');
const a = html.indexOf('const BOARD_STANCE = window.BOARD_STANCE'), bEnd = html.indexOf('// mount: crossfade to the stance', a);
if (a < 0 || bEnd < 0) { console.log('FAIL stance block not found'); process.exit(1); }
const src = html.slice(a, bEnd) + '\n;({_boardStanceClip,_bsReady,_boardStancePose,_bsP,BOARD_STANCE,get bs(){return _bs;}})';
let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
const ang = (p, q) => 2 * Math.acos(Math.min(1, Math.abs(p.dot(q)))) * 180 / Math.PI;
const CHAR = {}; const window = { DMChars }; const ctx = vm.createContext({ THREE, CHAR, window, DMChars, Math, Object, console });
const API = vm.runInContext(src, ctx);
async function load(id) {
  const C = L.CHARS[id], g = await L.loadGLB(L.D + C.glb), ag = await L.loadGLB(L.D + C.anim), root = g.scene, bones = {}, restPose = {};
  root.traverse((o) => { if (o.isBone) { bones[o.name] = o; restPose[o.name] = { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }; } });
  return { id, root, bones, restPose, clips: ag.animations, def: DMChars.get(id) };
}
function use(P) { for (const k of Object.keys(CHAR)) delete CHAR[k]; Object.assign(CHAR, { root: P.root, bones: P.bones, restPose: P.restPose, charId: P.id }); }
const rp = (P, n) => { const v = new THREE.Vector3(); let o = P.bones[n]; while (o && o !== P.root) { v.multiply(o.scale).applyQuaternion(o.quaternion).add(o.position); o = o.parent; } return v; };
const res = {};
for (const id of ['ariel', 'emma']) {
  const P = await load(id); use(P);
  const walk = P.clips.find((c) => c.name === P.def.clipMap.walk), idle = P.clips.find((c) => c.name === P.def.studio.idle);
  const restAnkle = rp(P, 'LeftFoot').y;
  const clip = API._boardStanceClip(walk, idle); ok(!!clip, `${id}: stance clip builds`); res[id + 'Clip'] = clip;
  for (const n in P.bones) { const r = P.restPose[n]; P.bones[n].position.copy(r.p); P.bones[n].quaternion.copy(r.q); }
  const mx = new THREE.AnimationMixer(P.root); mx.clipAction(clip).play(); mx.update(0);
  const yL = rp(P, 'LeftFoot').y, yR = rp(P, 'RightFoot').y;
  const lift = Math.max(Math.abs(yL - restAnkle), Math.abs(yR - restAnkle)); res[id + 'lift'] = lift;
  ok(lift < 0.02, `${id}: both soles on the deck (ankles ${yL.toFixed(3)} / ${yR.toFixed(3)} vs standing ${restAnkle.toFixed(3)}; IK reach clamp leaves ≤ 2 cm, the deck mount absorbs it)`);
  const hip = rp(P, 'LeftUpLeg'), knee = rp(P, 'LeftLeg'), ank = rp(P, 'LeftFoot'), bend = knee.clone().sub(hip).angleTo(ank.clone().sub(knee)) * 180 / Math.PI;
  res[id] = bend;
  if (P.def.stance && P.def.stance.handsFrom === 'idle') {
    let worst = 0, n = 0; for (const tr of idle.tracks) { const bn = tr.name.split('.')[0]; if (!/Hand(Index|Middle|Ring|Pinky)\d$/.test(bn) || !tr.name.endsWith('.quaternion')) continue;
      const q = new THREE.Quaternion().fromArray(tr.createInterpolant().evaluate(0)); worst = Math.max(worst, ang(q, P.bones[bn].quaternion)); n++; }
    ok(n >= 24 && worst < 0.5, `${id}: riding fingers = idle fingers (${n} joints, worst ${worst.toFixed(2)}°)`);
  }
  res[id + 'P'] = P;
}
ok(Math.abs(res.emmalift - res.ariellift) < 0.006, `Emma's feet sit like Ariel's (lift ${(res.emmalift * 100).toFixed(1)} vs ${(res.ariellift * 100).toFixed(1)} cm)`);
ok(Math.abs(res.ariel - res.emma) < 10, `soft knees on both pilots; Ariel's numbers locked Emma's legs at ~4° (Ariel ${res.ariel.toFixed(0)}°, Emma ${res.emma.toFixed(0)}° knee flexion)`);
use(res.arielP); API._bsReady(); const aBone = API.bs.limb.armL.U; use(res.emmaP); API._bsReady();
ok(aBone === res.arielP.bones.LeftArm && API.bs.limb.armL.U === res.emmaP.bones.LeftArm, 'pilot swap re-measures the limbs (no stale Ariel bones on Emma)');
const pE = API._bsP(); ok(pE.handsFrom === 'idle' && pE.hips[1] === res.emmaP.def.stance.hips[1], "Emma's effective stance carries her overrides (handsFrom idle, own hips)");
use(res.arielP); API._bsReady(); const pA = API._bsP(), BS = API.BOARD_STANCE;
ok(!('handsFrom' in pA) && pA.wristRelax === BS.wristRelax && pA.handGrip === BS.handGrip && pA.hips === BS.hips && pA.ankleL === BS.ankleL, 'reverse swap Emma -> Ariel: no handsFrom / wristRelax / handGrip / hips leak onto Ariel (defaults restored)');
ok(API.bs.limb.armL.U === res.arielP.bones.LeftArm && API._bsP() === pE, 'reverse swap re-measures back to Ariel limbs; the effective object is reused (no allocation)');
{ const walk = res.arielP.clips.find((c) => c.name === res.arielP.def.clipMap.walk), idle = res.arielP.clips.find((c) => c.name === res.arielP.def.studio.idle);
  const c2 = API._boardStanceClip(walk, idle), key = (c) => c.tracks.filter((t) => /(Hand|Hand(Thumb|Index|Middle|Ring|Pinky)\d)\.quaternion$/.test(t.name)).map((t) => t.name + ':' + Array.from(t.values.slice(0, 4)).map((v) => v.toFixed(5)).join(',')).sort().join('|');
  ok(!!c2 && key(c2) === key(res.arielClip) && key(c2).length > 0, "Ariel's stance clip after Emma -> Ariel: wrists / fingers identical to her clip before Emma was ever loaded"); }
console.log(fails ? `\n${fails} FAILED` : '\nstance-pilots: all ok'); process.exit(fails ? 1 : 0);
