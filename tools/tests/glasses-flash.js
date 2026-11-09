// node tools/tests/glasses-flash.js — t1472 glasses flashlight (ui/dm-flash.js) with REAL three.js (r185 core) and the REAL character GLB data:
// the glasses frame ('Mesh 1', skinned 100 % to 'Head') and the Head bone's inverse bind matrix are read from
// characterassests/Meshy_AI_Autumn_biped_Character_output.glb (not edited). Asserts: the LED bar is a runtime mesh parented to the Head bone, sits on
// the top rim of the glasses over the bridge, ~1/3 of the frame width and only a few mm tall (black casing + white LED strip); it is NOT a collision
// solid (DMCollide count unchanged, raycast ignores it); toggle on/off; discrete lumen steps 750 / 1250 / 2000 / 3000 / 4000 with clamping; the beam
// is a shadowless spot created once (kept at intensity 0 when off), carried in her top-level scene along the glasses' forward axis; tick allocates
// nothing; session only (no storage). UI placement is tools/tests/sys-strip.py (Chromium).
// three.js: THREE_CORE=/path/to/three.core.js, else /workspace/three185/three.core.js or node_modules/three; SKIP (exit 0) if none.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const cands = [process.env.THREE_CORE, '/workspace/three185/three.core.js', path.join(root, 'node_modules/three/build/three.core.js')].filter(Boolean);
const tp = cands.find(p => fs.existsSync(p));
if (!tp) { console.log('glasses-flash: SKIP (no three.core.js; set THREE_CORE)'); process.exit(0); }
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
(async () => {
  const THREE = await import(tp);
  globalThis.window = globalThis; globalThis.location = { search: '' }; globalThis.THREE = THREE;
  require('../../ui/dm-collide.js'); require('../../ui/dm-collide-game.js'); const W = globalThis.DMCollide;
  // ── the real GLB: Mesh 1 bind-pose positions + Head inverse bind matrix
  const b = fs.readFileSync(path.join(root, 'characterassests/Meshy_AI_Autumn_biped_Character_output.glb')), jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), bo = 20 + jl + 8;
  const acc = i => { const a = J.accessors[i], v = J.bufferViews[a.bufferView], nc = { SCALAR: 1, VEC3: 3, MAT4: 16 }[a.type]; if (a.componentType !== 5126) throw new Error('float only'); const st = v.byteStride || nc * 4, out = new Float32Array(a.count * nc); for (let k = 0; k < a.count; k++) for (let c = 0; c < nc; c++) out[k * nc + c] = b.readFloatLE(bo + (v.byteOffset || 0) + (a.byteOffset || 0) + k * st + c * 4); return out; };
  const ni = J.nodes.findIndex(x => x.name === 'Mesh 1'); ok(ni >= 0 && J.nodes[ni].skin === 0, "GLB: glasses frame node 'Mesh 1' (skinned)");
  const prim = J.meshes[J.nodes[ni].mesh].primitives[0], pos = acc(prim.attributes.POSITION);
  const skin = J.skins[0], hj = skin.joints.findIndex(j => J.nodes[j].name === 'Head'); ok(hj >= 0, 'GLB: Head joint');
  const ibm = acc(skin.inverseBindMatrices).slice(hj * 16, hj * 16 + 16);
  // frame metrics straight from the vertices (independent of the module): front face, top over the bridge, front width
  let zf = -1e9; for (let i = 0; i < pos.length; i += 3) zf = Math.max(zf, pos[i + 2]);
  let x0 = 1e9, x1 = -1e9, top = -1e9; for (let i = 0; i < pos.length; i += 3) { if (pos[i + 2] < zf - 0.027) continue; x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]); if (Math.abs(pos[i]) < 0.02) top = Math.max(top, pos[i + 1]); }
  const fw = x1 - x0;
  // a rig like GLTFLoader's: CHAR.root > Head bone (bind pose) ; SkinnedMesh 'Mesh_1' bound with the GLB inverse bind matrix
  const rootG = new THREE.Group(), head = new THREE.Bone(); head.name = 'Head';
  new THREE.Matrix4().fromArray(ibm).invert().decompose(head.position, head.quaternion, head.scale); rootG.add(head);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const cnt = pos.length / 3; geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(cnt * 4), 4)); const sw = new Float32Array(cnt * 4); for (let i = 0; i < cnt; i++) sw[i * 4] = 1; geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial()); mesh.name = 'Mesh_1'; rootG.add(mesh);
  rootG.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([head], [new THREE.Matrix4().fromArray(ibm)]), new THREE.Matrix4());
  const scene = new THREE.Scene(); scene.add(rootG); rootG.scale.setScalar(1.92);   // her terrain size (any scale: the bar rides the bone)
  require('../../ui/dm-flash.js'); const F = globalThis.DMFlash;
  const before = W.count(); const regs = []; const _ro = W.regObject; W.regObject = (...a) => { regs.push(a[0]); return _ro.apply(W, a); };
  ok(F.attach({ root: rootG, bones: { Head: head } }) === true, 'attach() on the real glasses mesh / Head bone');
  ok(F.attach({ root: rootG }) === false, 'attach() is once per character');
  const g = F.S.led; ok(g && g.name === 'jots_glasses_led' && g.parent === head, "LED group 'jots_glasses_led' is a child of the Head bone (the glasses' bone)");
  ok(F.S.casing.name === 'jots_glasses_led_casing' && F.S.strip.name === 'jots_glasses_led_strip', 'casing + strip meshes');
  ok(F.S.casing.material.color.getHex() <= 0x101010 && F.S.strip.material.color.r > 0.1 && F.S.strip.material.toneMapped === false, 'black casing, white (unlit, not tone-mapped) LED strip');
  const D = F.S.dims;
  ok(Math.abs(D.frame.width - fw) < 1e-4 && Math.abs(D.frame.top - top) < 1e-4 && Math.abs(D.frame.front - zf) < 1e-4, 'proportions measured from the GLB frame itself (width ' + fw.toFixed(4) + ' m, top ' + top.toFixed(4) + ', front ' + zf.toFixed(4) + ')');
  ok(Math.abs(D.len - fw / 3) < 1e-6 && D.len > 0.04 && D.len < 0.06, 'bar length ~1/3 of the frame width (' + (D.len * 1000).toFixed(1) + ' mm of ' + (fw * 1000).toFixed(1) + ' mm) — the marked line');
  ok(D.h >= 0.002 && D.h <= 0.004 && D.dep <= 0.007, 'very narrow: ' + (D.h * 1000).toFixed(1) + ' mm tall, ' + (D.dep * 1000).toFixed(1) + ' mm deep (rim band ' + (D.frame.band * 1000).toFixed(1) + ' mm)');
  // in the bind pose the bar sits on the top rim, centred over the bridge, flush with the front face (mesh space = CHAR.root local)
  rootG.scale.setScalar(1); rootG.updateMatrixWorld(true);
  const wp = new THREE.Vector3(); g.getWorldPosition(wp);
  ok(Math.abs(wp.x) < 1e-4 && Math.abs(wp.y - (top + D.h / 2)) < 2e-4 && Math.abs(wp.z - (zf - D.dep / 2 + 0.0006)) < 2e-4, 'on the top rim over the bridge: (' + wp.x.toFixed(4) + ', ' + wp.y.toFixed(4) + ', ' + wp.z.toFixed(4) + ')');
  const bx = new THREE.Box3().setFromObject(g); ok(bx.max.z <= zf + 0.0012 && bx.min.y >= top - 1e-4, 'does not sink into the frame or stick out in front of it');
  // NOT a collision solid
  ok(W.count() === before && regs.length === 0, 'DMCollide: nothing registered (' + before + ' -> ' + W.count() + ')');
  const code = fs.readFileSync(path.join(root, 'ui/dm-flash.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/DMCollide|regObject|regChunk|addBox|addStatic/.test(code), 'dm-flash.js code never touches DMCollide');
  ok(g.userData.noCollide && F.S.casing.userData.noCollide && F.S.strip.userData.noCollide, 'userData.noCollide on every part');
  const rc = new THREE.Raycaster(new THREE.Vector3(0, wp.y, 1), new THREE.Vector3(0, 0, -1)); ok(rc.intersectObject(g, true).length === 0, 'raycasts (camera / ground probes) pass through it');
  // toggle + discrete lumen steps
  ok(!F.S.on && F.S.light === null, 'starts off, no light yet (nothing added to any scene)');
  ok(JSON.stringify(F.STEPS) === '[750,1250,2000,3000,4000]', 'lumen steps 750 / 1250 / 2000 / 3000 / 4000');
  ok(F.toggle() === true && F.S.light && F.S.light.isSpotLight, 'tap: on -> one SpotLight');
  const L = F.S.light; ok(L.castShadow === false, 'no shadow (any tier)'); ok(L.angle < 0.3 && L.angle > 0.1 && L.penumbra > 0, 'narrow beam (' + (L.angle * 180 / Math.PI).toFixed(0) + ' deg half-angle, soft edge)');
  ok(F.lumens() === 2000 && Math.abs(L.intensity - 2000 * F.LM_K) < 1e-9, 'default 2000 lm');
  const seen = []; for (let i = 0; i < 5; i++) { F.setStep(i); seen.push([F.lumens(), L.intensity]); }
  ok(seen.map(s => s[0]).join() === '750,1250,2000,3000,4000' && seen.every((s, i) => !i || s[1] > seen[i - 1][1]), 'every step sets its lumens, brighter each step');
  ok(Math.abs(seen[0][1] / seen[4][1] - 750 / 4000) < 1e-9, 'intensity proportional to lumens (750 : 4000)');
  ok(F.setStep(-3) === 750 && F.setStep(99) === 4000 && F.setStep(2.7) === 2000, 'steps clamp / truncate (no in-between values)'); F.setStep(4);
  ok(F.toggle() === false && L.intensity === 0 && F.S.light === L, 'tap: off -> intensity 0, the same light kept (no light-count change = no recompile)');
  ok(F.toggle(true) === true && F.S.light === L && L.intensity === 4000 * F.LM_K, 'on again: same light, last step kept');
  // tick: the beam rides in her top-level scene along the glasses' forward axis
  rootG.rotation.y = 0.9; head.rotation.x += 0.2; scene.updateMatrixWorld(true);
  F.tick('walk'); ok(L.parent === scene && F.S.target.parent === scene, 'beam lives in her top-level scene (first person hides her body, not the beam)');
  g.getWorldPosition(wp); ok(L.position.distanceTo(wp) < 1e-6, 'beam origin = the LED bar');
  const fwd = new THREE.Vector3(0, 0, 1).transformDirection(g.matrixWorld), dir = F.S.target.position.clone().sub(L.position).normalize();
  ok(dir.distanceTo(fwd) < 1e-6, 'aimed along the glasses forward axis (follows the head bone)');
  ok(fwd.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(rootG.quaternion)) > 0.8, 'forward = the way her face points');
  // tick allocates nothing (counted constructions while ticking)
  const src = fs.readFileSync(path.join(root, 'ui/dm-flash.js'), 'utf8'), tb = src.slice(src.indexOf('F.tick = function'), src.indexOf('// ── UI'));
  ok(!/new\s|\[\s*\]|\{\s*\}|=>/.test(tb.replace(/\/\/.*$/gm, '')), 'tick(): no new / array / object / closure (no per-frame allocation)');
  ok(!/localStorage|sessionStorage|indexedDB|dm_save|SAVE_KEY|setItem/.test(code), 'session only: no storage, no save keys');
  F.toggle(false); F.tick('walk'); ok(L.intensity === 0, 'off: tick leaves it dark');
  // index.html hooks
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ok(/<script src="ui\/dm-flash\.js\?v=302" defer><\/script>/.test(html), 'script tag (?v=302, the JOTS Cliffs #249 tree)');
  ok(html.indexOf('DMFlash.attach(CHAR)') > html.indexOf('DMCharm.attach(CHAR)') && html.indexOf('DMFlash.attach(CHAR)') > 0, 'attached right after the charm on character load');
  ok(/DMFlash\.tick\('space'\)/.test(html) && /DMFlash\.tick\(PW\.mode\)/.test(html), 'ticked in open space and in the world (walk / fly / space)');
  ok(F.STICK.space === 'jL' && F.STICK.fly === 'atmo-steer-zone' && F.STICK.walk === 'surf-move-zone', 'docks by the LEFT stick of each HUD');
  ok(!/>[^<]*[A-Za-z]{3,}[^<]*<\/button>/.test(src.slice(src.indexOf('const ICON'), src.indexOf('const CSS'))), 'icon only (custom SVG, no text label)');
  console.log(fails ? 'glasses-flash: FAILED ' + fails + '/' + n : 'glasses-flash: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('glasses-flash: ERROR', e); process.exit(1); });
