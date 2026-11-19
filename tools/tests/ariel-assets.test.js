// Ariel_JOTS (pilot) asset contract (same checks as emma-assets plus tri/size/material/rest-pose guards), pure node (no three.js, no browser):  node tools/tests/emma-assets.test.js [dir]
//  - characterassests/emma/Emma_Character.glb: one skin, every bone the game's _fbxBoneMap() needs is a joint, joint names unique
//  - characterassests/emma/Emma_Merged_Animations.glb: every clip the game maps in CHAR_CLIP_NAMES exists (Ariel's clip names, so the game
//    and the Ariel Rig Viewer's K.buildActions() pick them up unchanged), tracks target joints of Emma's skeleton, no NaN/Inf, unit quaternions,
//    strictly increasing times, Hips translation only
//  - emma_clips.json presets reference existing clips; every file < 100 MB (GitHub limit)
'use strict';
const fs = require('fs'), path = require('path');
const dir = process.argv[2] || path.join(__dirname, '..', '..', 'characterassests');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
function glb(f) {
  const b = fs.readFileSync(f), jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), bo = 20 + jl + 8;
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const acc = i => { const a = J.accessors[i], v = J.bufferViews[a.bufferView], n = NC[a.type]; if (a.componentType !== 5126) throw new Error('animation accessor not float');
    const off = bo + (v.byteOffset || 0) + (a.byteOffset || 0); return new Float32Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + a.count * n * 4)); };
  return { J, acc, size: b.length };
}
const BONES = ['Hips', 'Spine', 'Spine01', 'Spine02', 'neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
const CLIPS = { walk: 'Walking', run: 'Running', jump: 'Regular_Jump', climbLoop: 'climbing_up_wall', step: 'Mount_Step', stepOff: 'Dismount_Step', swim: 'Swim_Forward',
  crouch: 'Crouch_Walk_Right_with_Torch_inplace', prone: 'Crawl_Backward_inplace', rope: 'Swing_on_Rope_to_Ground', cliff: 'Grab_Bar_and_Swing_Forward' };
const cf = path.join(dir, 'Meshy_AI_Autumn_biped_Character_output.glb'), af = path.join(dir, 'Meshy_AI_Autumn_biped_Meshy_AI_Meshy_Merged_Animations.glb'), mf = path.join(dir, '__none__.json');
for (const f of fs.readdirSync(dir).filter(f => /\.glb$/.test(f))) ok(fs.statSync(path.join(dir, f)).size < 100e6, f + ' < 100 MB (' + (fs.statSync(path.join(dir, f)).size / 1e6).toFixed(1) + ' MB)');
const C = glb(cf); ok(C.J.skins && C.J.skins.length >= 1, 'character has a skin');
const jn = C.J.skins[0].joints.map(i => C.J.nodes[i].name); ok(new Set(jn).size === jn.length, 'joint names unique (' + jn.length + ' joints)');
BONES.forEach(n => ok(jn.includes(n), 'character joint ' + n));
// Ariel_JOTS guards
{ let tris = 0; for (const m of C.J.meshes) for (const p of m.primitives) tris += C.J.accessors[p.indices].count / 3;
  ok(tris <= 160000, 'total triangles <= 160k (' + tris + ')'); ok(C.size <= 8.0e6 * 1.15, 'character GLB <= old 8.0 MB + 15% (' + (C.size / 1e6).toFixed(2) + ' MB)');
  const nn = C.J.nodes.map(n => n.name || ''); ['Shirt.001', 'Pants Reach Pose.001', 'Belt.001', 'Charm.001', 'Tube.021', 'Tube.023', 'Scalp', 'Mesh 1', 'LED_Top_Strip_L', 'LED_Top_Strip_R'].forEach(n => ok(nn.includes(n), 'node ' + n + ' kept'));
  ok(jn.length === 172 && jn[0] === 'Hips', '172 joints, Hips first');
  const mats = C.J.materials; const shirt = mats.find(m => m.name === 'shirt'), pants = mats.find(m => m.name === 'Material_34.001');
  ok(shirt && shirt.pbrMetallicRoughness.baseColorTexture && shirt.normalTexture, 'shirt: baked colour + normal'); ok(pants && pants.pbrMetallicRoughness.baseColorTexture && pants.normalTexture, 'pants: baked colour + normal');
  // relaxed rest pose: both wrists hang below the shoulders (the old rest pose had the hands raised)
  const nodes = C.J.nodes, par = {}; nodes.forEach((n, i) => (n.children || []).forEach(c => par[c] = i));
  const wy = i => { let m = [0, 0, 0], x = i, y = 0; const chain = []; while (x !== undefined) { chain.push(x); x = par[x]; } let M = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
    const mul = (a, b) => a.map((r, i) => b[0].map((_, j) => r.reduce((s, _, k) => s + a[i][k] * b[k][j], 0)));
    const loc = n => { const q = n.rotation || [0,0,0,1], t = n.translation || [0,0,0], [x,y,z,w] = q; return [[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),t[0]],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),t[1]],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y),t[2]],[0,0,0,1]]; };
    chain.reverse().forEach(c => { M = mul(M, nodes[c].matrix ? [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]] : loc(nodes[c])); }); return M[1][3]; };
  const idx = n => nodes.findIndex(x => x.name === n);
  ['Left', 'Right'].forEach(s => ok(wy(idx(s + 'Hand')) < wy(idx(s + 'Arm')) - 0.3, s + ' hand hangs well below the shoulder in the rest pose'));
}
const A = glb(af); const aj = A.J.skins[0].joints.map(i => A.J.nodes[i].name);
ok(jn.length === aj.length && jn.every(n => aj.includes(n)), 'animation file skeleton has the same joints as the character');
const clips = {}; for (const a of A.J.animations) clips[a.name] = a;
for (const [k, n] of Object.entries(CLIPS)) ok(!!clips[n], 'game clip "' + n + '" for state ' + k);
let nan = 0, nonunit = 0, badt = 0, badtarget = 0, transl = [];
for (const a of A.J.animations) for (const ch of a.channels) {
  const nm = A.J.nodes[ch.target.node].name; if (!jn.includes(nm)) badtarget++;
  const s = a.samplers[ch.sampler], t = A.acc(s.input), v = A.acc(s.output);
  for (let i = 1; i < t.length; i++) if (!(t[i] > t[i - 1])) badt++;
  for (const x of v) if (!Number.isFinite(x)) nan++;
  if (ch.target.path === 'rotation') for (let i = 0; i < v.length; i += 4) { const l = Math.hypot(v[i], v[i + 1], v[i + 2], v[i + 3]); if (Math.abs(l - 1) > 1e-3) nonunit++; }
  if (ch.target.path === 'translation' && nm !== 'Hips') transl.push(nm);
  if (ch.target.path === 'scale') badtarget++;
}
ok(!badtarget, 'every track targets a joint (no scale tracks): ' + badtarget); ok(!nan, 'no NaN/Inf in animation data'); ok(!nonunit, 'unit quaternions'); ok(!badt, 'strictly increasing times'); ok(!transl.length, 'translation only on Hips');
if (fs.existsSync(mf)) { const M = JSON.parse(fs.readFileSync(mf)); M.presets.forEach(p => ok(!!clips[p.clip], 'preset ' + p.id + ' -> ' + p.clip)); }
console.log(fails ? fails + ' FAILED' : 'ALL OK'); process.exit(fails ? 1 : 0);
