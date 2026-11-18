// three.js (node, no browser) check: every clip binds to the skeleton of Emma_Merged_Animations.glb, evaluates NaN-free over its whole timeline.
// usage: node mixer_check.mjs Emma_Merged_Animations.glb [three-dir]
import { readFileSync } from 'node:fs'; import { pathToFileURL } from 'node:url'; import path from 'node:path';
const three = process.argv[3] || new URL('./node_modules/three/', import.meta.url).pathname;
const THREE = await import(pathToFileURL(path.join(three, 'build/three.core.js')).href);
const { GLTFLoader } = await import(pathToFileURL(path.join(three, 'examples/jsm/loaders/GLTFLoader.js')).href);
const buf = readFileSync(process.argv[2]); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
const root = gltf.scene; const bones = {}; root.traverse(o => { if (o.isBone || o.type === 'Bone' || o.name) bones[o.name] = o; });
const mixer = new THREE.AnimationMixer(root); let fails = 0, tot = 0;
for (const clip of gltf.animations) {
  const unresolved = []; for (const t of clip.tracks) { const n = THREE.PropertyBinding.parseTrackName(t.name).nodeName; if (!root.getObjectByName(n)) unresolved.push(n); }
  const a = mixer.clipAction(clip); a.reset().play(); let bad = 0, hipsMinY = 1e9, hipsMaxY = -1e9;
  for (let t = 0; t <= clip.duration + 1e-6; t += 1 / 30) { a.time = Math.min(t, clip.duration); mixer.update(0); root.updateMatrixWorld(true);
    root.traverse(o => { if (o.isBone) { for (const x of o.matrixWorld.elements) if (!Number.isFinite(x)) { bad++; break; } } });
    const h = bones.Hips; if (h) { hipsMinY = Math.min(hipsMinY, h.position.y); hipsMaxY = Math.max(hipsMaxY, h.position.y); } }
  a.stop(); tot++;
  const ok = !bad && !unresolved.length; if (!ok) fails++;
  console.log((ok ? 'ok  ' : 'FAIL'), clip.name.padEnd(38), clip.duration.toFixed(2) + 's', 'tracks', clip.tracks.length, 'hipsY', hipsMinY.toFixed(3) + '..' + hipsMaxY.toFixed(3), unresolved.length ? 'unresolved ' + unresolved.slice(0, 3) : '', bad ? 'NaN frames ' + bad : '');
}
console.log(fails ? fails + ' of ' + tot + ' FAILED' : 'all ' + tot + ' clips bind and evaluate cleanly'); process.exit(fails ? 1 : 0);
