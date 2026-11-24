// Head-spin regression (t1644u): the Pilot Editor look offset must never accumulate.  A real three@0.185 AnimationMixer plays a clip whose Head/neck
// tracks are CONSTANT (like Emma's v360 clips), so PropertyMixer.apply skips setValue after the first frame.  300 studio frames with the look held at
// its maximum: the head may turn at most the clamped look (≤ 45°) from the clip pose, never more (the old multiply() reached 360° in < 2 s).
// Also checks the same guard used by index.html applySkyboardHeadOverride (exact "bone still holds what we wrote" detection).
// usage: node tools/tests/head-spin.test.mjs   (three: env DM_HARNESS_NODE or ~/.cache/dm-harness; SKIP when missing)
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = [process.env.DM_HARNESS_NODE && path.join(process.env.DM_HARNESS_NODE, 'node_modules/three'), path.join(process.env.HOME || '/root', '.cache/dm-harness/node_modules/three')].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'build/three.core.js')));
if (!T) { console.log('SKIP: three@0.185.0 not installed (npm i three@0.185.0 in ~/.cache/dm-harness)'); process.exit(0); }
const THREE = await import(pathToFileURL(path.join(T, 'build/three.core.js')).href);
// load ui/dm-charselect.js against a tiny DOM stub and take its pure look helpers
const stubEl = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stubEl()), apply: () => stubEl(), set: () => true });
const win = { THREE, addEventListener() {}, removeEventListener() {}, location: { search: '' }, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }), requestAnimationFrame: () => 0, performance };
win.window = win; win.document = stubEl(); win.navigator = { userAgent: 'node' };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'ui/dm-charselect.js'), 'utf8'), Object.assign(win, { console, setTimeout, clearTimeout, URL }));
const CS = win.DMCharSelect; let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
ok(CS && typeof CS.lookApply === 'function' && typeof CS.lookState === 'function', 'DMCharSelect exports lookApply / lookState');
const ang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI;
function rig() {
  const root = new THREE.Object3D(), hips = new THREE.Bone(), neck = new THREE.Bone(), head = new THREE.Bone(); hips.name = 'Hips'; neck.name = 'neck'; head.name = 'Head';
  root.add(hips); hips.add(neck); neck.add(head); neck.position.y = 1.4; head.position.y = 0.12;
  const qn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, 0, 0)), qh = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.05, 0.02, 0));
  const tr = (n, q) => new THREE.QuaternionKeyframeTrack(n + '.quaternion', [0, 1, 2], [...q.toArray(), ...q.toArray(), ...q.toArray()]);
  const clip = new THREE.AnimationClip('Emma_Idle_const', 2, [tr('neck', qn), tr('Head', qh), new THREE.VectorKeyframeTrack('Hips.position', [0, 2], [0, 1, 0, 0, 1.01, 0])]);
  const mixer = new THREE.AnimationMixer(root); const a = mixer.clipAction(clip); a.play();
  return { root, neck, head, mixer, qn, qh };
}
// 1. Pilot Editor path (CS.lookApply)
{
  const R = rig(), st = CS.lookState(THREE), e = new THREE.Euler(), oh = new THREE.Quaternion(), on = new THREE.Quaternion(); let worst = 0, worstN = 0;
  for (let f = 0; f < 300; f++) {
    R.mixer.update(1 / 30); const look = CS.clampLook(5);   // drag held far right: clamps to 0.7
    CS.lookApply(st.head, R.head, oh.setFromEuler(e.set(look * 0.05, look * 0.6, 0))); CS.lookApply(st.neck, R.neck, on.setFromEuler(e.set(0, look * 0.35, 0)));
    worst = Math.max(worst, ang(R.head.quaternion, R.qh)); worstN = Math.max(worstN, ang(R.neck.quaternion, R.qn));
  }
  ok(worst < 45 && worst > 20, `Pilot Editor head stays within the clamped look over 300 constant-track frames (max ${worst.toFixed(1)}°)`);
  ok(worstN < 45, `Pilot Editor neck stays clamped (max ${worstN.toFixed(1)}°)`);
  // look returns to centre -> pose returns to the clip pose exactly
  for (let f = 0; f < 5; f++) { R.mixer.update(1 / 30); CS.lookApply(st.head, R.head, oh.identity()); CS.lookApply(st.neck, R.neck, on.identity()); }
  ok(ang(R.head.quaternion, R.qh) < 0.01, 'look back to 0 restores the clip pose (no drift)');
  // control: the old cumulative multiply really does spin on this clip (proves the test exercises the bug)
  const C = rig(); let spun = 0; for (let f = 0; f < 300; f++) { C.mixer.update(1 / 30); C.head.quaternion.multiply(oh.setFromEuler(e.set(0, 0.42, 0))); spun = Math.max(spun, ang(C.head.quaternion, C.qh)); }
  ok(spun > 170, `control: the pre-fix multiply() spins on a constant-track clip (${spun.toFixed(0)}°)`);
}
// 2. in-game guard (index.html applySkyboardHeadOverride uses the same exact-match restore): source check
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), i = html.indexOf('function applySkyboardHeadOverride(){'), body = html.slice(i, html.indexOf('function _applySkyboardHeadOverride1', i));
  ok(/_same\(b\.Head\.quaternion,H\.wh\)\) b\.Head\.quaternion\.copy\(H\.ch\)/.test(body) && /H\.wh\.copy\(b\.Head\.quaternion\); H\.wok=true/.test(body), 'applySkyboardHeadOverride restores the clip base when the mixer skipped the bone');
}
console.log(fails ? `\n${fails} FAILED` : '\nhead-spin: all ok'); process.exit(fails ? 1 : 0);
