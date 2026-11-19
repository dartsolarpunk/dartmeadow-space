// Clip-switch test: playing clip A and then clip B must leave EXACTLY the pose that B gives from rest (no bone keeps A's pose).
// Also asserts every clip carries an explicit rotation track for every skeleton bone.
// usage: node tools/tests/ariel-clip-switch.test.mjs [Ariel merged_Animations.glb] [three-dir]   (three-dir = a three@0.185 checkout, default ./node_modules/three)
import { readFileSync } from 'node:fs'; import { pathToFileURL } from 'node:url'; import path from 'node:path';
const glb = process.argv[2] || new URL('../../characterassests/Meshy_AI_Autumn_biped_Meshy_AI_Meshy_Merged_Animations.glb', import.meta.url).pathname;
const three = process.argv[3] || path.resolve('node_modules/three');
const THREE = await import(pathToFileURL(path.join(three, 'build/three.core.js')).href);
const { GLTFLoader } = await import(pathToFileURL(path.join(three, 'examples/jsm/loaders/GLTFLoader.js')).href);
const buf = readFileSync(glb); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
const root = gltf.scene; const bones = []; root.traverse(o => { if (o.isBone) bones.push(o); });
const restQ = bones.map(b => b.quaternion.clone()), restP = bones.map(b => b.position.clone());
const clips = gltf.animations; let fail = 0; const TOL = 0.1;   // degrees (float32 rounding of the crossfade weights is ~0.04 deg; real pose carry-over is tens of degrees)
const resetRest = () => bones.forEach((b, i) => { b.quaternion.copy(restQ[i]); b.position.copy(restP[i]); });
const snap = () => bones.map(b => b.quaternion.clone());
const maxDiff = (a, b) => { let m = 0, who = ''; a.forEach((q, i) => { const d = 2 * Math.acos(Math.min(1, Math.abs(q.dot(b[i])))) * 180 / Math.PI; if (d > m) { m = d; who = bones[i].name; } }); return [m, who]; };
// 1. explicit tracks
for (const c of clips) { const have = new Set(c.tracks.filter(t => t.name.endsWith('.quaternion')).map(t => t.name.split('.')[0]));
  const miss = bones.filter(b => b.parent && b.parent.isBone !== undefined && !have.has(b.name) && bones.includes(b) && b.name !== 'Hips' || (b.name === 'Hips' && !have.has('Hips'))).map(b => b.name);
  if (miss.length) { fail++; console.log('FAIL', c.name, 'has no rotation track for', miss.slice(0, 6).join(','), miss.length > 6 ? '...' : ''); } }
// 2. A -> B equals B from rest
const play = (m, c, t) => { m.stopAllAction(); const a = m.clipAction(c, root); a.reset(); a.setLoop(THREE.LoopRepeat, Infinity); a.play(); m.update(0); m.update(t); return a; };
const pairs = []; const names = clips.map(c => c.name);
const starters = ['Idle_Breathe_Blink', 'Running', 'Walking', 'Regular_Jump', 'climbing_up_wall', 'Swim_Forward', 'Acting_Wave_Happy', 'Crawl_Backward_inplace'].filter(n => names.includes(n));
for (const A of starters) for (const c of clips) pairs.push([clips.find(x => x.name === A), c]);
let worst = [0, '', '']; 
for (const [A, B] of pairs) {
  const m = new THREE.AnimationMixer(root);
  resetRest(); play(m, A, 0.73); play(m, B, 0.41); const p1 = snap();          // viewer flow: stopAll, then B
  m.stopAllAction(); m.uncacheRoot(root); resetRest(); const m2 = new THREE.AnimationMixer(root); play(m2, B, 0.41); const p2 = snap();
  const [d, who] = maxDiff(p1, p2); if (d > worst[0]) worst = [d, who, A.name + '->' + B.name];
  if (d > TOL) { fail++; if (fail < 12) console.log('FAIL', A.name, '->', B.name, d.toFixed(4), 'deg at', who); }
  m2.stopAllAction(); m2.uncacheRoot(root);
}
// 3. crossfade A -> B (A faded out, not stopped): after the fade B alone must match
for (const A of starters) for (const Bn of ['Idle_Breathe_Blink', 'Running', 'climbing_up_wall']) { const B = clips.find(x => x.name === Bn); const An = clips.find(x => x.name === A);
  resetRest(); const m = new THREE.AnimationMixer(root); const a = m.clipAction(An, root).reset().play(); m.update(0.5);
  const b = m.clipAction(B, root).reset().play(); a.crossFadeTo(b, 0.2, false); m.update(0.2); m.update(0.2); m.update(0.2); const p1 = snap();
  m.stopAllAction(); m.uncacheRoot(root); resetRest(); const m2 = new THREE.AnimationMixer(root); const b2 = m2.clipAction(B, root).reset().play(); m2.update(0.6); const p2 = snap();
  const [d, who] = maxDiff(p1, p2); if (d > worst[0]) worst = [d, who, 'xfade ' + A + '->' + Bn]; if (d > TOL) { fail++; console.log('FAIL xfade', A, '->', Bn, d.toFixed(4), who); }
  m2.stopAllAction(); m2.uncacheRoot(root); }
console.log(`pairs ${pairs.length}+xfade  worst diff ${worst[0].toFixed(5)} deg (${worst[1]} ${worst[2]})`);
console.log(fail ? `FAILED ${fail}` : 'ALL OK'); process.exit(fail ? 1 : 0);
