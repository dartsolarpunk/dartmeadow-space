// Fit the per-character collision data (docs/hair-collision-notes.md) to the SKINNED meshes of a character at rest and print a `collision` block for the
// character's hair config JSON: node tools/hair-fit-colliders.mjs ariel|emma [--lite-only] > collision.json
//   capsules[2]  full set: 3 chest rows (centre + left / right pair), trapezius, clavicle, upper arm, forearm, hand per side, hips, neck   (coordinate-descent fit of
//                centre offset / radius against the shirt + exposed-skin vertices near the head; pokes through the capsules weigh 40x more than floating off them)
//   capsules[1]  the same with the centre chest capsule only
//   boxes        glasses (lens per eye, frame bar, bridge) from the lens / frame meshes, ears from the lateral head vertices   (head-bone frame; keep-out volumes)
// A new character: add an entry to CHARS in tools/tests/lib-hair-probe.mjs (glb, anim, bin, mesh names, lens / frame names), run this, paste the block into
// <char>_hair_config.json, then `node tools/tests/hair-collision.js --report` and look at close-ups (tools/tests/hair-shots.py). Radii are a starting point; hands are fixed
// at 4 cm, forearms >= 4.5-5.5 cm (fingers / sleeves are far from the head in most poses and under-sampled by the fit).
import fs from 'fs';
import { THREE, setup, CHARS, D } from './tests/lib-hair-probe.mjs';
const which = process.argv[2] || 'ariel', litOnly = process.argv.includes('--lite-only'), PW = 40, FT = 0.004;
const mod = await import(D + 'hair_strands.js?x=' + Math.random()); const S = await setup(which, mod); S.root.updateMatrixWorld(true);
const rinv = new THREE.Matrix4().copy(S.root.matrixWorld).invert(), v = new THREE.Vector3(), W = (n) => { const q = new THREE.Vector3(); S.bones[n].getWorldPosition(q); return q.toArray(); };
const hc = new THREE.Vector3(...W('Head')).add(new THREE.Vector3(0, 0.11, 0));
// skin the fit sees: shirt vertices + body vertices that are not under the shirt, within 40 cm of the head, no head / hands / legs
const SH = [], V = []; const cell = 0.03, ck = (x, y, z) => Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell), GH = new Map();
const verts = (n, f) => { const m = S.meshes[n]; if (!m) return; m.skeleton.update(); const M = new THREE.Matrix4().multiplyMatrices(rinv, m.matrixWorld), P = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, bn = m.skeleton.bones;
  for (let i = 0; i < P.count; i++) { m.getVertexPosition(i, v); v.applyMatrix4(M); let b = 0, w = -1; for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > w) { w = sw.getComponent(i, k); b = si.getComponent(i, k); } f([v.x, v.y, v.z], bn[b].name); } };
for (const n of CHARS[which].sets.shirt) verts(n, (p) => { SH.push(p); const k = ck(...p); (GH.get(k) || GH.set(k, []).get(k)).push(p); });
const nearShirt = (q) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) { const a = GH.get(ck(q[0] + i * cell, q[1] + j * cell, q[2] + k * cell)); if (a) for (const w of a) if (Math.hypot(q[0] - w[0], q[1] - w[1], q[2] - w[2]) < 0.02) return true; } return false; };
const skip = /Head|Jaw|Eye|Brow|Cheek|Chin|Lip|Nose|Tongue|Teeth|Ear|head|Hand|Finger|Index|Middle|Ring|Pinky|Thumb|UpLeg|Leg|Foot|Toe/;
for (const n of CHARS[which].sets.shirt.concat(CHARS[which].sets.body)) { const isBody = CHARS[which].sets.body.includes(n); verts(n, (p, bone) => { if (Math.hypot(p[0] - hc.x, p[1] - hc.y, p[2] - hc.z) > 0.4 || p[1] < W('Spine02')[1] - 0.02 || skip.test(bone)) return; if (p[1] > W('neck')[1] + 0.02 && Math.abs(p[0]) < 0.07) return; if (isBody && nearShirt(p)) return; V.push(p); }); }
const P4 = ['Spine02', 'Spine01', 'Spine', 'neck'].map(W);
const build = (p, lite) => { const out = [], add = (bone, a, b, r) => out.push({ bone, a, b, r }); const bones = ['Spine02', 'Spine01', 'Spine'];
  for (let i = 0; i < 3; i++) { add(bones[i], [P4[i][0], P4[i][1], P4[i][2] + p['t' + i + 'dz']], [P4[i + 1][0], P4[i + 1][1], P4[i + 1][2] + p['t' + i + 'dz']], p['t' + i + 'r']);
    if (!lite) for (const s of [1, -1]) add(bones[i], [P4[i][0] + s * p['t' + i + 'dx'], P4[i][1], P4[i][2] + p['t' + i + 'dzs']], [P4[i + 1][0] + s * p['t' + i + 'dx'], P4[i + 1][1], P4[i + 1][2] + p['t' + i + 'dzs']], p['t' + i + 'rs']); }
  for (const s of [1, -1]) { const sd = s > 0 ? 'Left' : 'Right', sh = W(sd + 'Shoulder'), ar = W(sd + 'Arm'), fa = W(sd + 'ForeArm'), ha = W(sd + 'Hand'), mi = W(sd + 'HandMiddle1');
    add('Spine', [P4[3][0] + s * p.tx0, P4[3][1] + p.ty0, P4[3][2] + p.tz0], [(sh[0] + ar[0]) / 2, (sh[1] + ar[1]) / 2 + p.ty1, (sh[2] + ar[2]) / 2 + p.tz1], p.tr);
    add(sd + 'Shoulder', [sh[0], sh[1] + p.cy, sh[2] + p.cz], [ar[0], ar[1] + p.cy, ar[2] + p.cz], p.cr);
    add(sd + 'Arm', ar, fa, Math.max(p.ur, 0.05)); add(sd + 'ForeArm', fa, ha, Math.max(p.fr, 0.05)); add(sd + 'Hand', ha, mi, 0.04); }
  add('Hips', W('Hips'), W('Spine02'), 0.14); return out; };
const segd = (p, a, b) => { const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], l2 = abx * abx + aby * aby + abz * abz; let t = l2 > 1e-12 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t, p[2] - a[2] - abz * t); };
function fit(lite) {
  const cost = (p) => { const caps = build(p, lite); let e = 0; for (const q of V) { let g = 1e9; for (const c of caps) { const d = segd(q, c.a, c.b) - c.r; if (d < g) g = d; } if (g > 0) e += PW * g * g; else if (g < -FT) e += (g + FT) * (g + FT); } return e / V.length; };
  const p = {}; for (let i = 0; i < 3; i++) Object.assign(p, { ['t' + i + 'dz']: 0.02, ['t' + i + 'r']: 0.10, ['t' + i + 'dx']: 0.05, ['t' + i + 'rs']: 0.07, ['t' + i + 'dzs']: 0.02 });
  Object.assign(p, { tx0: 0, ty0: -0.02, tz0: 0, ty1: 0, tz1: 0, tr: 0.06, cy: 0, cz: 0, cr: 0.06, ur: 0.05, fr: 0.045 });
  const lim = (k, x) => /r$|rs$|tr$|cr$|ur$|fr$/.test(k) ? Math.max(0.03, Math.min(0.16, x)) : /dx$/.test(k) ? Math.max(0, Math.min(0.12, x)) : Math.max(-0.08, Math.min(0.1, x));
  let best = cost(p); for (let it = 0; it < 14; it++) { const sc = Math.pow(0.7, it); for (const k of Object.keys(p)) for (const dir of [1, -1]) { const old = p[k]; p[k] = lim(k, old + dir * 0.01 * sc); const c = cost(p); if (c < best - 1e-12) best = c; else p[k] = old; } }
  return p;
}
const loc = (bone, pt) => { const b = S.bones[bone]; b.updateWorldMatrix(true, false); return new THREE.Vector3(...pt).applyMatrix4(new THREE.Matrix4().copy(b.matrixWorld).invert()).toArray().map((x) => +x.toFixed(4)); };
const conv = (list) => list.map((c) => ({ bone: c.bone, a: loc(c.bone, c.a), b: loc(c.bone, c.b), r: +c.r.toFixed(4) }));
const neckR = (S.H.meta.colliders || []).find((c) => c.bone === 'neck'); const neck = { bone: 'neck', a: loc('neck', W('neck')), b: loc('neck', W('Head')), r: neckR ? neckR.r : 0.055 };
const pFull = fit(false), pLite = fit(true);
// boxes (head frame): glasses from the lens / frame meshes, ears from the lateral head vertices
const head = S.bones.Head, hinv = new THREE.Matrix4().copy(head.matrixWorld).invert(), hM = new THREE.Matrix4().multiplyMatrices(hinv, S.root.matrixWorld);
const hv = (n, f) => { const m = S.meshes[n]; if (!m) return []; m.skeleton.update(); const M = new THREE.Matrix4().multiplyMatrices(hinv, m.matrixWorld), P = m.geometry.attributes.position, o = []; for (let i = 0; i < P.count; i++) { m.getVertexPosition(i, v); v.applyMatrix4(M); if (!f || f(v)) o.push(v.clone()); } return o; };
const bbox = (a) => { const b = new THREE.Box3(); a.forEach((p) => b.expandByPoint(p)); return b; };
const box = (name, b, backTo) => { const mn = b.min.clone(), mx = b.max.clone(); if (backTo != null) mn.z = Math.min(mn.z, backTo); const c = mn.clone().add(mx).multiplyScalar(0.5), h = mx.clone().sub(mn).multiplyScalar(0.5); return { name, c: c.toArray().map((x) => +x.toFixed(4)), h: h.toArray().map((x) => +x.toFixed(4)), margin: 0.001 }; };
const G = CHARS[which].glasses, boxes = [];
if (G) {
  const lens = G.lens.flatMap((n) => hv(n)), faceZ = G.faceZ;   // faceZ: how far behind the lens the keep-out volume reaches (fills the gap to the cheeks so strands do not slip in behind the lens)
  boxes.push(box('lensL', bbox(lens.filter((p) => p.x > 0)), faceZ), box('lensR', bbox(lens.filter((p) => p.x < 0)), faceZ));
  const front = G.frame.flatMap((n) => hv(n, (p) => p.z > G.frontZ)); if (front.length) boxes.push(box('frameBar', bbox(front)));
}
if (CHARS[which].ear) for (const sd of [1, -1]) { const E = CHARS[which].ear; boxes.push({ name: sd > 0 ? 'earL' : 'earR', c: [sd * E.c[0], E.c[1], E.c[2]], h: E.h, margin: 0.001 }); }
const out = { fileColliders: false, margin: { bundle: 1, cap: 0.012 }, separation: { neighbours: 3, frac: 0.6 }, capsules: { 1: conv(build(pLite, true)).concat([neck]), 2: conv(build(pFull, false)).concat([neck]) }, boxes };
console.log(JSON.stringify(out, null, 1));
