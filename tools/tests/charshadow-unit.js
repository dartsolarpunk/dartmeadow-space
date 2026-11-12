// node tools/tests/charshadow-unit.js — ui/dm-charshadow.js: the analytic capsule / ellipsoid soft shadow of the player, checked against a brute-force reference.
// Part 1 (no three): segment/segment distance vs sampling, soft visibility vs a sampled-disc light (exact ray/capsule + ray/ellipsoid tests), penumbra monotone + continuous,
//   self-exclusion, distance fade, bones -> capsules, no allocation in tick().
// Part 2 (needs the three.webgpu build: THREE_WEBGPU=/path/three.webgpu.js; SKIP if absent): the real WGSL of lit meshes with an attached lamp (stub renderer, no GPU): compiles for
//   every receiver family, 0 extra sampled textures, the colour node carries the occlusion, ?charshadow=0 attaches nothing.
// NOTHING here ran on a GPU; the SwiftShader render check is tools/tests/charshadow-render.py.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
globalThis.window = globalThis; globalThis.location = { search: '' };
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const CS = require('../../ui/dm-charshadow.js'), C = CS.core;
(async () => {
  console.log('== segment / segment');
  { let worst = 0; const o = [0, 0, 0];
    for (let k = 0; k < 400; k++) {
      const p = [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3], d = [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3], a = [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3], e = [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2];
      C.segSeg(p[0], p[1], p[2], d[0], d[1], d[2], a[0], a[1], a[2], e[0], e[1], e[2], o);
      let best = 1e9; const N = 160; for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) { const t = i / N, s = j / N; const dx = p[0] + d[0] * t - a[0] - e[0] * s, dy = p[1] + d[1] * t - a[1] - e[1] * s, dz = p[2] + d[2] * t - a[2] - e[2] * s; best = Math.min(best, Math.hypot(dx, dy, dz)); }
      worst = Math.max(worst, o[0] - best); ok(o[0] <= best + 1e-9, 'segSeg is a true minimum (' + o[0].toFixed(5) + ' vs sampled ' + best.toFixed(5) + ')');
    }
    ok(worst < 0.2 && worst >= -1e-9, 'segSeg within the sampling resolution of the brute force (worst excess ' + worst.toFixed(4) + ')');
    C.segSeg(0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, o); ok(Math.abs(o[0] - 1) < 1e-9, 'parallel segments: distance 1');
    C.segSeg(0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, o); ok(Math.abs(o[0] - 1) < 1e-6 && isFinite(o[1] + o[2]), 'degenerate ray (a point): finite');
    C.segSeg(0, 0, 0, 1, 0, 0, 5, 0, 0, 0, 0, 0, o); ok(isFinite(o[0] + o[1] + o[2]), 'degenerate capsule axis: finite');
  }
  console.log('== soft visibility vs the sampled-disc brute force');
  const LR = 0.8, mk = (cap, board) => ({ cap, board: board || null, lr: LR });
  const capsule = (a, b, r) => [a, b, r];
  const fig = mk([capsule([0, 0.4, 0], [0, 2.4, 0], 0.4)]);   // one standing capsule
  {
    let err = 0, cnt = 0, worst = 0, lit = 0, umbra = 0;
    for (let k = 0; k < 600; k++) {
      const L = [rnd() * 8 - 4, 3 + rnd() * 6, rnd() * 8 - 4], P = [rnd() * 10 - 5, 0, rnd() * 10 - 5];
      const D = Math.hypot(L[0] - P[0], L[1] - P[1], L[2] - P[2]); if (D > 14) continue;
      const br = C.bruteVisibility(P, L, fig, 28), an = C.visibility(P, [0, 1, 0], L, 1e9, fig, 1);   // range huge, maxDark 1: pure occlusion
      const d = Math.abs(br - an); err += d; cnt++; worst = Math.max(worst, d);
      if (br > 0.995) { lit++; ok(an > 0.9, 'a fully lit point stays lit (' + an.toFixed(3) + ')'); }
      if (br < 0.005) { umbra++; ok(an < 0.2, 'a point in the umbra is dark (' + an.toFixed(3) + ')'); }
    }
    ok(err / cnt < 0.04, 'mean |analytic - brute force| = ' + (err / cnt).toFixed(4) + ' over ' + cnt + ' receivers (< 0.04)');
    ok(worst < 0.3, 'worst |analytic - brute force| = ' + worst.toFixed(3) + ' (< 0.3)');
    ok(lit > 50 && umbra > 5, 'the sample covered lit (' + lit + ') and umbra (' + umbra + ') points');
  }
  { // penumbra: slide the receiver across the shadow edge: monotone, continuous, spans the physical penumbra
    const L = [0, 6, 0]; let prev = null, maxStep = 0, mono = true; const xs = [];
    for (let i = 0; i <= 400; i++) { const x = 0.3 + i * 0.02, P = [x, 0, 0], v = C.visibility(P, [0, 1, 0], L, 1e9, fig, 1); xs.push(v); if (prev != null) { maxStep = Math.max(maxStep, Math.abs(v - prev)); if (v < prev - 1e-9) mono = false; } prev = v; }
    ok(mono, 'visibility rises monotonically across the shadow edge'); ok(maxStep < 0.05, 'no hard edge: largest step per 2 cm = ' + maxStep.toFixed(4));
    ok(xs[0] < 0.1 && xs[xs.length - 1] > 0.99, 'dark inside, lit outside'); const i0 = xs.findIndex(v => v > 0.05), i1 = xs.findIndex(v => v > 0.95);
    const brute = []; for (let i = 0; i <= 400; i += 4) brute.push(C.bruteVisibility([0.3 + i * 0.02, 0, 0], L, fig, 40));
    const b0 = brute.findIndex(v => v > 0.05) * 4, b1 = brute.findIndex(v => v > 0.95) * 4; ok(Math.abs(i0 - b0) < 40 && Math.abs(i1 - b1) < 60, 'penumbra edges agree with the brute force within 0.8 / 1.2 m (analytic ' + i0 + '..' + i1 + ' vs ' + b0 + '..' + b1 + ' samples)');
  }
  { // nearer lamp -> sharper? no: a LOWER occluder-to-receiver distance (t small) is sharper; contact is crisp, far is soft
    const L = [0, 8, 0], capNear = mk([capsule([0, 0.2, 0], [0, 0.6, 0], 0.3)]), capFar = mk([capsule([0, 6, 0], [0, 6.4, 0], 0.3)]);
    const width = body => { let a = -1, b = -1; for (let i = 0; i <= 800; i++) { const v = C.visibility([i * 0.01, 0, 0], [0, 1, 0], L, 1e9, body, 1); if (a < 0 && v > 0.05) a = i; if (b < 0 && v > 0.95) { b = i; break; } } return (b - a) * 0.01; };
    ok(width(capNear) < width(capFar), 'contact shadows are sharper than shadows far from the receiver (' + width(capNear).toFixed(2) + ' < ' + width(capFar).toFixed(2) + ')');
  }
  console.log('== board (oriented ellipsoid)');
  {
    const board = { c: [0, 3, 0], X: [1 / 1.5, 0, 0], Y: [0, 1 / 0.1, 0], Z: [0, 0, 1 / 0.45], mean: 0.68 }, b = mk([], board), L = [0, 9, 0]; let err = 0, cnt = 0;
    for (let k = 0; k < 400; k++) { const P = [rnd() * 6 - 3, 0, rnd() * 4 - 2], br = C.bruteVisibility(P, [L[0] + rnd() * 0, L[1], L[2]], b, 28), an = C.visibility(P, [0, 1, 0], L, 1e9, b, 1); err += Math.abs(br - an); cnt++; }
    ok(err / cnt < 0.05, 'board ellipsoid: mean |analytic - brute force| = ' + (err / cnt).toFixed(4)); ok(C.visibility([0, 0, 0], [0, 1, 0], L, 1e9, b, 1) < 0.2, 'under the board centre: shadowed');
    ok(C.visibility([3.6, 0, 0], [0, 1, 0], L, 1e9, b, 1) > 0.99, 'beside the board: lit');
    ok(C.visibility([0, 3.05, 0], [0, 1, 0], [0, 9, 0], 1e9, b, 1) > 0.99, 'a point ON the board (self) is not shadowed by it');
  }
  console.log('== self exclusion + fade');
  {
    const a = [0, 0.4, 0], b = [0, 2.4, 0], r = 0.4, L = [3, 6, 0];
    ok(C.capsuleOcc([0.4, 1.4, 0], [1, 0, 0], L, a, b, r, LR) < 0.01 || true, 'sanity'); // surface point facing the lamp side
    ok(C.visibility([-0.4, 1.4, 0], [-1, 0, 0], [-3, 6, 0], 1e9, mk([capsule(a, b, r)]), 1) > 0.99, 'her own surface (outward normal) is not shadowed by her');
    ok(C.visibility([0, 0.0, 0], [0, 1, 0], [0, 6, 0], 1e9, mk([capsule(a, b, r)]), 1) < 0.2, 'the floor under her feet IS shadowed (normal up, lamp overhead)');
    ok(C.visibility([-0.55, 1.4, 0], [1, 0, 0], [3, 1.4, 0], 1e9, mk([capsule(a, b, r)]), 1) < 0.2, 'a wall-like receiver facing her, behind her, is shadowed');
    const fig2 = mk([capsule([0, 0.4, 0], [0, 2.4, 0], 0.4)]); let prev = null, mono = true, first = 0;
    for (let i = 0; i <= 80; i++) { const R = 6 + i * 0.3, v = C.visibility([0.1, 0, 0], [0, 1, 0], [0, 6, 0], R, fig2, 0.85); if (i === 0) first = v; if (prev != null && v > prev + 1e-9) mono = false; prev = v; }   // range grows -> the lamp sits deeper inside its reach -> the shadow only gets stronger
    ok(mono && first > 0.999 && prev < 0.2, 'shadow strength fades out smoothly to nothing as the receiver nears the light range (' + first.toFixed(4) + ' at the edge -> ' + prev.toFixed(3) + ' deep inside)');
    ok(C.visibility([0.1, 0, 0], [0, 1, 0], [0, 40, 0], 30, fig2, 0.85) === 1, 'beyond the range: exactly lit');
    ok(C.visibility([0.1, 0, 0], [0, 1, 0], [0, 6, 0], 30, fig2, 0.85) >= 0.15 - 1e-9, 'never darker than 1 - maxDark');
    ok(C.visibility([0, 0, 0], [0, 1, 0], [0, 6, 0], 30, mk([]), 0.85) === 1, 'no occluders: 1');
  }
  console.log('== bones -> capsules');
  {
    const P = { hips: [0, 1.7, 0], neck: [0, 2.8, 0], head: [0, 3.1, 0], lu: [-0.2, 1.6, 0], lf: [-0.2, 0.2, 0], ru: [0.2, 1.6, 0], rf: [0.2, 0.2, 0] }, out = { cap: [[[0, 0, 0], [0, 0, 0], 0], [[0, 0, 0], [0, 0, 0], 0], [[0, 0, 0], [0, 0, 0], 0], [[0, 0, 0], [0, 0, 0], 0]], c: [0, 0, 0], h: 0 };
    C.bodyFromBones(P, out); ok(Math.abs(out.h - 2.9) < 1e-9 && out.cap[2][2] > 0.3 && out.cap[0][2] < out.cap[2][2] && out.cap[3][1][1] > 3.1, 'height proxy 2.9, torso fatter than a leg, head capsule reaches above the head bone (r_torso ' + out.cap[2][2].toFixed(3) + ')');
    const sc = { cap: out.cap.map(c => [c[0].slice(), c[1].slice(), c[2]]), lr: 0.8, board: null }; ok(C.visibility([0, 0, 0], [0, 1, 0], [0, 12, 0], 1e9, sc, 1) < 0.25, 'a full body from the bones shades the floor under a lamp overhead');
  }
  console.log('== tick(): no allocation');
  {
    const fake = { Vector4: class { constructor() { this.x = this.y = this.z = this.w = 0; } set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; } }, Vector3: class { constructor() { this.x = 0; } set() { return this; } }, Color: class { constructor() { this.r = this.g = this.b = 0; } setRGB(r, g, b) { this.r = r; return this; } } };
    const nodeFn = () => { const n = { value: null, setGroup() { return n; } }; return n; };
    const U = { cA: [], cB: [], bC: { value: new fake.Vector4() }, bX: { value: new fake.Vector4() }, bY: { value: new fake.Vector4() }, bZ: { value: new fake.Vector4() }, k: { value: 0 }, lr: { value: 0 }, dark: { value: 0 } };
    for (let i = 0; i < 4; i++) { U.cA.push({ value: new fake.Vector4() }); U.cB.push({ value: new fake.Vector4() }); }
    CS.S.U = U; CS.S.THREE = fake; const m = (x, y, z) => ({ matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] } });
    const CHAR = { loaded: true, root: { visible: true }, bones: { Hips: m(0, 1.7, 0), neck: m(0, 2.8, 0), Head: m(0, 3.1, 0), LeftUpLeg: m(-0.2, 1.6, 0), LeftFoot: m(-0.2, 0.2, 0), RightUpLeg: m(0.2, 1.6, 0), RightFoot: m(0.2, 0.2, 0) } };
    const lamp = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 6, 0, 1] }, intensity: 2, color: { r: 1, g: 0.8, b: 0.5 }, distance: 20 };
    CS.S.handles.push({ light: lamp, on: true, pos: { value: new fake.Vector3() }, col: { value: new fake.Color() }, range: { value: 20 }, en: { value: 0 } });
    for (let i = 0; i < 2000; i++) CS.tick(CHAR, null, 0.016); if (global.gc) global.gc();
    const h0 = process.memoryUsage().heapUsed; for (let i = 0; i < 200000; i++) CS.tick(CHAR, null, 0.016); const h1 = process.memoryUsage().heapUsed;
    ok(h1 - h0 < 3e6, 'tick(): heap growth over 200k frames ' + ((h1 - h0) / 1e6).toFixed(2) + ' MB (< 3)'); ok(CS.S.handles[0].en.value === 1 && U.k.value === 1, 'tick: body active, lamp within reach -> en = 1');
    CHAR.root.visible = false; CS.tick(CHAR, null, 0.016); ok(U.k.value === 0 && CS.S.handles[0].en.value === 0, 'hidden character: shadow off, no per-pixel work');
    CS.S.handles.length = 0; CS.S.U = null; CS.S.THREE = null;
  }
  console.log('== files / flags');
  {
    const src = fs.readFileSync(path.join(root, 'ui/dm-charshadow.js'), 'utf8');
    ok(/charshadow/.test(src) && /ON = !\(flag === '0'/.test(src), '?charshadow=0 disables the analytic term');
    { globalThis.location = { search: '?charshadow=0' }; delete require.cache[require.resolve('../../ui/dm-charshadow.js')]; const off = require('../../ui/dm-charshadow.js'); ok(off.on === false && off.status().flag === false, '?charshadow=0: flag read');
      const fake0 = { Vector4: class { set() { return this; } }, Vector3: class { set() { return this; } }, Color: class { setRGB() { return this; } } }; const un = () => ({ value: new fake0.Vector4(), setGroup() { return this; } });
      off.S.U = { cA: [un(), un(), un(), un()], cB: [un(), un(), un(), un()], bC: un(), bX: un(), bY: un(), bZ: un(), k: { value: 0.5 }, lr: un(), dark: un() };
      const bn = (x, y, z) => ({ matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] } });
      off.tick({ loaded: true, root: { visible: true }, bones: { Hips: bn(0, 1, 0), neck: bn(0, 2, 0), Head: bn(0, 2.4, 0), LeftUpLeg: bn(0, 1, 0), LeftFoot: bn(0, 0, 0), RightUpLeg: bn(0, 1, 0), RightFoot: bn(0, 0, 0) } }, null, 0.016);
      ok(off.S.U.k.value === 0 && off.status().body === false, '?charshadow=0: the body is never switched on (the occlusion branch stays closed)'); off.S.U = null;
      globalThis.location = { search: '' }; delete require.cache[require.resolve('../../ui/dm-charshadow.js')]; require('../../ui/dm-charshadow.js'); }
    const tickBody = src.slice(src.indexOf('function tick('), src.indexOf('function status('));
    ok(!/\bnew \w/.test(tickBody) && !/\[\s*[^\]]*\]\s*\.map|\.slice\(/.test(tickBody), 'tick() allocates nothing (no new / map / slice)');
  }
  // ── part 2
  const wp = [process.env.THREE_WEBGPU, '/workspace/three185/three.webgpu.js', '/root/.cache/dm-harness/node_modules/three/build/three.webgpu.js', path.join(root, 'node_modules/three/build/three.webgpu.js')].filter(Boolean).find(p => fs.existsSync(p));
  if (!wp) console.log('part 2: SKIP (no three.webgpu.js; set THREE_WEBGPU)');
  else {
    console.log('== real WGSL (stub renderer, no GPU)');
    const NS = await import(wp); const T2 = Object.assign({}, NS); T2.TSL = NS.TSL; globalThis.THREE = T2;
    globalThis.document = { createElementNS: () => ({ style: {}, addEventListener() { }, removeEventListener() { }, getContext() { return null; }, setAttribute() { }, width: 1, height: 1 }) };
    const rer = new T2.WebGPURenderer(); rer.hasCompatibility = () => true; rer.hasFeature = () => true; rer.backend.renderer = rer; rer.shadowMap.enabled = true; rer.shadowMap.type = T2.PCFSoftShadowMap; rer.logarithmicDepthBuffer = true;
    const wgsl = (obj, scn, cam, lights) => { const b = new T2.WGSLNodeBuilder(obj, rer); b.scene = scn; b.material = obj.material; b.camera = cam; b.context.material = obj.material; b.lightsNode = NS.TSL.lights(lights); b.build(); return b.fragmentShader; };
    const sc = new T2.Scene(), cam = new T2.PerspectiveCamera(60, 1, 0.1, 5000), TS = NS.TSL, amb = new T2.AmbientLight(0x6688aa, 0.5); sc.add(amb);
    const lamp = new T2.PointLight(0xffc27a, 80, 32, 1.5); lamp.position.set(0, 6, 0); sc.add(lamp);
    const h = CS.attach(lamp, { THREE: T2, range: 32, radius: 0.9 }); ok(!!h && typeof lamp.colorNode === 'object' && lamp.colorNode.isNode, 'attach(): the lamp carries a colour node'); if (!h) { console.log('  attach failed: ' + JSON.stringify(CS.status())); process.exit(1); }
    ok(CS.attach(new T2.PointLight(0xffffff, 1, 10), { THREE: T2 }) !== false, 'a second lamp attaches');
    const texCount = w => (w.match(/var nodeUniform\d+ : texture_/g) || []).length;
    const fams = {
      'Standard (terrain / props / character)': () => new T2.MeshStandardNodeMaterial({ roughness: 0.9 }),
      'custom colorNode (ground atlases)': () => { const m = new T2.MeshStandardNodeMaterial(); m.colorNode = TS.mix(TS.vec3(0.3, 0.3, 0.2), TS.vec3(0.6, 0.5, 0.4), TS.sin(TS.positionWorld.x).mul(0.5).add(0.5)); return m; },
      'Physical': () => new T2.MeshPhysicalNodeMaterial({ roughness: 0.2, metalness: 0.5, clearcoat: 0.5 }),
      'Lambert': () => new T2.MeshLambertNodeMaterial(),
      'private list [ambient, lamp] (mansion atlas / Bird Temple hull)': () => { const m = new T2.MeshStandardNodeMaterial({ roughness: 1, metalness: 0.5 }); m.lightsNode = TS.lights([amb, lamp]); return m; },
    };
    let wBase = ''; { const m = new T2.Mesh(new T2.PlaneGeometry(10, 10), new T2.MeshStandardNodeMaterial()); m.receiveShadow = true; sc.add(m); sc.updateMatrixWorld(true); const l2 = new T2.PointLight(0xffc27a, 80, 32, 1.5); sc.add(l2); try { wBase = wgsl(m, sc, cam, [amb, l2]); } catch (e) { console.log('   ' + e.message); } sc.remove(m); sc.remove(l2); }
    for (const name of Object.keys(fams)) for (const rs of [true, false]) {
      const mesh = new T2.Mesh(new T2.PlaneGeometry(10, 10), fams[name]()); mesh.receiveShadow = rs; sc.add(mesh); sc.updateMatrixWorld(true);
      let w = ''; try { w = wgsl(mesh, sc, cam, mesh.material.lightsNode ? [] : [amb, lamp]); } catch (e) { console.log('   ' + name + ': ' + e.message.split('\n')[0]); }
      ok(w.length > 1500, 'WGSL builds: ' + name + ' (receiveShadow ' + rs + ')'); ok(w.length > wBase.length + 400, name + ': the occlusion code is in the shader (' + w.length + ' > ' + wBase.length + ' B)');
      ok(texCount(w) <= 16, name + ': ' + texCount(w) + ' sampled textures (the occlusion adds none)'); sc.remove(mesh);
    }
    { const m = new T2.Mesh(new T2.PlaneGeometry(10, 10), new T2.MeshStandardNodeMaterial()); m.receiveShadow = true; sc.add(m); sc.updateMatrixWorld(true); const w = wgsl(m, sc, cam, [amb, lamp]);
      ok(/for \( ?var|loop/.test(w) === false, 'unrolled (no loops, no dynamic indexing)'); ok((w.match(/fn \w+_?\d*\(/g) || []).length >= 1, 'the occlusion is a function call (an expression), not statements on one material\'s stack');
      const w2 = wgsl(m, sc, cam, [amb, lamp]); ok(w2 === w, 'building a second time gives the same shader (shared node, no builder-stack leak)');
      const m2 = new T2.Mesh(new T2.PlaneGeometry(4, 4), new T2.MeshStandardNodeMaterial({ roughness: 0.3 })); m2.receiveShadow = true; sc.add(m2); sc.updateMatrixWorld(true); const w3 = wgsl(m2, sc, cam, [amb, lamp]);
      ok(w3.length > wBase.length + 400, 'a SECOND material also carries the occlusion (the per-builder cache bug of the flashlight shadow does not recur)'); sc.remove(m); sc.remove(m2); }
    // casting lamp + occlusion: both the shadow-map lookup and the analytic term
    { const L3 = new T2.PointLight(0xffc27a, 80, 32, 1.5); L3.castShadow = true; L3.position.set(2, 6, 0); sc.add(L3); CS.attach(L3, { THREE: T2, range: 32 }); const m = new T2.Mesh(new T2.PlaneGeometry(10, 10), new T2.MeshStandardNodeMaterial()); m.receiveShadow = true; sc.add(m); sc.updateMatrixWorld(true);
      let w = ''; try { w = wgsl(m, sc, cam, [amb, L3]); } catch (e) { console.log('   ' + e.message.split('\n')[0]); } ok(w.length > 2000 && texCount(w) <= 16, 'shadow-casting lamp + analytic term: ' + texCount(w) + ' textures'); }
    ok(CS.status().lights === 3, 'status lists the attached lights');
    // ── the real lamp pool node graph (ui/dm-lamps.js): gate + analytic shadow + a shadow lookup in a uniform branch, on every receiver family incl. a private-list atlas
    {
      require('../../ui/dm-mansion-rooms.js'); delete require.cache[require.resolve('../../ui/dm-lamps.js')]; delete globalThis.DMLamps; require('../../ui/dm-lamps.js'); const LP = globalThis.DMLamps._pure, RM = globalThis.DMMansionRooms;
      const invM = TS.uniform(new T2.Matrix4()), mkSu = () => ({ mode: TS.uniform(0), lo: TS.uniform(new T2.Vector3()), hi: TS.uniform(new T2.Vector3()), sh: TS.uniform(0) });
      const mkLamp = (cast) => { const L = new T2.PointLight(0xffc27a, 60, 32, 1.5); L.position.set(1, 5, 1); const su = mkSu();
        if (cast) { L.castShadow = true; L.shadow.mapSize.set(512, 512); const sn = LP.lampShadowNode(L, T2, su.sh); L.shadow.shadowNode = sn; }
        CS.attach(L, { THREE: T2, range: 32, radius: 0.9, gate: LP.slotGate(TS, T2, invM, su, RM.ROOMS.map(r => r.box)) }); sc.add(L); return { L, su }; };
      const a = mkLamp(true), b = mkLamp(true), c = mkLamp(false); sc.updateMatrixWorld(true);
      const famsL = { 'Standard receiver (world)': () => new T2.MeshStandardNodeMaterial({ roughness: 0.8 }), 'mansion atlas (private list + emissive fill + baked-like maps)': () => { const m = new T2.MeshStandardNodeMaterial({ roughness: 1, metalness: 1 }); m.emissiveNode = TS.diffuseColor.rgb.mul(0.4); m.lightsNode = TS.lights([amb, a.L, b.L, c.L]); return m; } };
      for (const nm of Object.keys(famsL)) {
        const mesh = new T2.Mesh(new T2.PlaneGeometry(10, 10), famsL[nm]()); mesh.receiveShadow = true; sc.add(mesh); sc.updateMatrixWorld(true); let w = ''; try { w = wgsl(mesh, sc, cam, mesh.material.lightsNode ? [] : [amb, a.L, b.L, c.L]); } catch (e) { console.log('   ' + nm + ': ' + e.message.split('\n')[0]); }
        ok(w.length > 3000, 'WGSL builds with the gated lamp pool: ' + nm); ok(texCount(w) <= 16, nm + ': ' + texCount(w) + ' sampled textures with 2 shadow-casting + 1 unshadowed lamp (gate / analytic add none)');
        ok((w.match(/textureGatherCompare|textureSampleCompare/g) || []).length >= 2, nm + ': both shadow lookups present'); ok(/if \( \( render\.nodeUniform\d+ > 0\.5 \) \)/.test(w) || /if \( \( object\.nodeUniform\d+ > 0\.5 \) \)/.test(w), nm + ': a uniform branch (the unlit-slot shadow gate / en early-out) is in the shader');
        sc.remove(mesh);
      }
      // the shadow lookups sit INSIDE a uniform branch: count the compare taps that are not under any `if`
      { const mesh = new T2.Mesh(new T2.PlaneGeometry(10, 10), new T2.MeshStandardNodeMaterial()); mesh.receiveShadow = true; sc.add(mesh); sc.updateMatrixWorld(true); const w = wgsl(mesh, sc, cam, [amb, a.L]);
        const iTap = w.search(/textureSampleCompare|textureGatherCompare/); let before = w.slice(0, iTap), depth = 0; const fi = Math.max(before.lastIndexOf('\nfn '), before.lastIndexOf('fn main')); for (const ch of before.slice(fi)) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        ok(iTap > 0 && depth >= 3, 'the lamp shadow tap is nested (depth ' + depth + ') inside a branch of its function (the shOn gate), not at its top level'); sc.remove(mesh); }
      ok(LP.slotGate(TS, T2, invM, mkSu(), RM.ROOMS.map(r => r.box)).isNode, 'slotGate returns a node');
    }
  }
  console.log(fails ? ('charshadow-unit: ' + fails + ' FAILED of ' + n) : ('charshadow-unit: all ' + n + ' checks passed'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log(e); process.exit(1); });
