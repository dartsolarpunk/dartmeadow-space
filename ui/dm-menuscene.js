/* ============================================================================
   dm-menuscene.js — the real-time main-menu scene.

   Ariel (the actual character file, rig and strand-hair solver the game uses)
   sits on a procedural Martian boulder in a pool of key / rim light, with the
   animated 3D star scene (#menu-bg-canvas) showing behind her.  Everything you
   see is generated here at load time:

     • ground  – polar heightfield (dense near the boulder), craters, far ridges
     • boulder – displaced sphere (3 octaves of ridged + billow noise)
     • rubble  – ~500 instanced rocks in three shapes, scaled by distance
     • surface – one shader for ground / boulder / rocks: rust albedo from
                 triplanar noise, dust settled by surface slope, a second finer
                 dust layer sitting ON the dust, sparkle grains, and bump
                 derived from the same height (so lit grazing light shows it)
     • light   – warm low key spot with shadows, cool rim from the galaxy side,
                 red bounce, and panel glow that ramps up when the menus open
     • Ariel   – seated pose solved on her rig (two-bone IK for legs, aimed arms,
                 spine/neck/head), idle loop: breathing, head wandering toward the
                 menus, weight shift, a periodic reach toward the menu, live
                 strand hair with a little wind

   Fails soft: if anything is unavailable the canvas is removed and the star
   scene alone remains.
   API: DM_MENUSCENE.start() · .menuOpen() · .pause() · .resume() · .dispose()
   ========================================================================== */
(function () {
  'use strict';
  if (window.DM_MENUSCENE) return;
  const MS = window.DM_MENUSCENE = { ready: false, failed: false, started: false, paused: false, disposed: false };
  const info = (...a) => { try { console.info('[menuscene]', ...a); } catch (e) {} };
  const CHAR_URL = 'characterassests/Meshy_AI_Autumn_biped_Character_output.glb';
  const HAIR_URL = 'characterassests/ariel_hair_strands.bin';

  /* ───────────────────────── CPU noise ───────────────────────── */
  function h3(ix, iy, iz, s) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1274126177) ^ Math.imul(s | 0, 1013904223);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vn(x, y, z, s) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const a = h3(ix, iy, iz, s), b = h3(ix + 1, iy, iz, s), c = h3(ix, iy + 1, iz, s), d = h3(ix + 1, iy + 1, iz, s);
    const e = h3(ix, iy, iz + 1, s), f = h3(ix + 1, iy, iz + 1, s), g = h3(ix, iy + 1, iz + 1, s), h = h3(ix + 1, iy + 1, iz + 1, s);
    const x1 = a + (b - a) * u, x2 = c + (d - c) * u, x3 = e + (f - e) * u, x4 = g + (h - g) * u;
    const y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v;
    return y1 + (y2 - y1) * w;
  }
  function fbm(x, y, z, oct, s) {
    let a = 0.5, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) { sum += a * vn(x * f, y * f, z * f, (s | 0) + i * 17); norm += a; f *= 2.03; a *= 0.5; }
    return sum / norm;                       // 0..1
  }
  const ridged = (x, y, z, oct, s) => { let a = 0.5, f = 1, sum = 0, norm = 0; for (let i = 0; i < oct; i++) { const n = 1 - Math.abs(vn(x * f, y * f, z * f, (s | 0) + i * 31) * 2 - 1); sum += a * n * n; norm += a; f *= 2.1; a *= 0.5; } return sum / norm; };
  const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  let _seed = 1337; const rnd = () => { _seed = (Math.imul(_seed, 1664525) + 1013904223) | 0; return ((_seed >>> 0) / 4294967296); };

  /* ground height (world x,z) — flat under the boulder, rubble-rolling beyond, ridges far out */
  const CRATERS = [[-9, 7, 3.2, 0.55], [11, 5, 4.5, 0.7], [5, -10, 5.5, 0.9], [-14, -6, 6.5, 1.0], [16, -12, 7, 1.1], [-6, 15, 4, 0.6]];
  function groundH(x, z) {
    const r = Math.hypot(x, z);
    const near = sstep(1.6, 11, r);
    let h = (fbm(x * 0.11, 0, z * 0.11, 4, 7) - 0.5) * 1.5 * near;
    h += (fbm(x * 0.9, 3, z * 0.9, 3, 11) - 0.5) * 0.11 * (0.35 + 0.65 * near);
    h += (fbm(x * 3.7, 9, z * 3.7, 2, 13) - 0.5) * 0.035;
    for (const c of CRATERS) {                       // bowl + raised rim
      const d = Math.hypot(x - c[0], z - c[1]) / c[2];
      if (d < 1.6) h += -c[3] * Math.pow(Math.max(0, 1 - d * d), 1.2) * 0.8 + c[3] * 0.28 * Math.exp(-Math.pow((d - 1.05) * 3.2, 2));
    }
    const far = sstep(16, 46, r);                    // distant ridges / mounds, left & right heavier than behind
    const ang = Math.atan2(z, x);
    const side = 0.65 + 0.35 * Math.abs(Math.cos(ang));
    h += far * side * (ridged(x * 0.05, 2, z * 0.05, 4, 21) * 6.5 + fbm(x * 0.02, 5, z * 0.02, 3, 5) * 5.5);
    return h;
  }

  /* ───────────────────────── helpers ───────────────────────── */
  function makeNoiseTexture(THREE) {                 // tileable RGBA noise atlas used by the surface shader
    const N = 256, data = new Uint8Array(N * N * 4);
    const lat = (L, seed) => { _seed = seed; const g = new Float32Array(L * L); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g; };
    const sm = t => t * t * (3 - 2 * t);
    const pn = (u, v, L, g) => { const fx = u * L, fy = v * L; const ix = Math.floor(fx), iy = Math.floor(fy); const tx = sm(fx - ix), ty = sm(fy - iy);
      const w = (a) => ((a % L) + L) % L; const a = g[w(iy) * L + w(ix)], b = g[w(iy) * L + w(ix + 1)], c = g[w(iy + 1) * L + w(ix)], d = g[w(iy + 1) * L + w(ix + 1)];
      return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty; };
    const G = { r: [lat(4, 11), lat(8, 12), lat(16, 13), lat(32, 14)], g: [lat(8, 21), lat(16, 22), lat(32, 23)], b: [lat(8, 31), lat(16, 32), lat(32, 33), lat(64, 34)], a: lat(N, 41) };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, i = (y * N + x) * 4;
      let r = 0, wsum = 0, A = 0.5; for (let k = 0; k < 4; k++) { r += A * pn(u, v, [4, 8, 16, 32][k], G.r[k]); wsum += A; A *= 0.55; } r /= wsum;
      let g = 0; wsum = 0; A = 0.5; for (let k = 0; k < 3; k++) { g += A * pn(u, v, [8, 16, 32][k], G.g[k]); wsum += A; A *= 0.5; } g /= wsum;
      let b = 0; wsum = 0; A = 0.5; for (let k = 0; k < 4; k++) { const n = 1 - Math.abs(pn(u, v, [8, 16, 32, 64][k], G.b[k]) * 2 - 1); b += A * n * n; wsum += A; A *= 0.5; } b /= wsum;
      const a = G.a[y * N + x] * 0.6 + pn(u, v, 128, lat(128, 51 + (x === 0 && y === 0 ? 0 : 0))) * 0; // white-ish grain
      data[i] = Math.max(0, Math.min(255, r * 255 * 1.15 - 18)); data[i + 1] = Math.max(0, Math.min(255, g * 255 * 1.15 - 18));
      data[i + 2] = Math.max(0, Math.min(255, b * 255 * 1.25 - 20)); data[i + 3] = Math.min(255, a * 255 + 50);
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true; return t;
  }

  /* one shader for ground / boulder / rocks */
  function surfaceMaterial(THREE, noiseTex, o) {
    const T = THREE.TSL;
    const { float, vec3, mix, smoothstep, positionWorld, normalWorld, positionView, normalView, dFdx, dFdy, cross, dot, normalize, sign, abs, length, cameraPosition, texture, pow, max, clamp } = T;
    const pw = positionWorld, nw = normalWorld;
    const w3 = pow(abs(nw), vec3(4.0)); const ws = w3.div(w3.x.add(w3.y).add(w3.z));
    const tri = (s) => { const p = pw.mul(s); return texture(noiseTex, p.yz).mul(ws.x).add(texture(noiseTex, p.xz).mul(ws.y)).add(texture(noiseTex, p.xy).mul(ws.z)); };
    const dist = length(cameraPosition.sub(pw));
    const lf = float(1).sub(smoothstep(9.0, 30.0, dist));          // mid detail fades with distance
    const hf = float(1).sub(smoothstep(3.5, 12.0, dist));          // fine grain / dust grain fades sooner
    const m1 = tri(0.17), m2 = tri(0.83), m3 = tri(3.9), m4 = tri(17.0), m5 = tri(63.0), m6 = tri(150.0), m7 = tri(470.0);
    const vhf = float(1).sub(smoothstep(1.4, 6.0, dist));          // micro grain only right around her
    // height (metres-ish): big form + strata + rubble + grain
    const h0 = m1.r.sub(0.5).mul(1.0).add(m2.b.sub(0.5).mul(0.6)).add(m3.g.sub(0.5).mul(0.34).mul(lf)).add(m4.a.sub(0.5).mul(0.26).mul(hf)).add(m5.a.sub(0.5).mul(0.2).mul(hf)).add(m6.a.sub(0.5).mul(0.2).mul(vhf)).add(m7.a.sub(0.5).mul(0.12).mul(vhf));
    // cracks (thin dark seams from the ridged channel at two scales), flakes (plate edges), micro grain
    const cracks = smoothstep(0.80, 0.93, m2.b).mul(0.75).add(smoothstep(0.84, 0.95, m3.b).mul(0.6).mul(lf)).min(1.0);
    const crackFine = smoothstep(0.86, 0.96, m4.b).mul(hf).mul(0.8).add(smoothstep(0.88, 0.97, m6.b).mul(vhf).mul(0.7));
    const flakeEdge = smoothstep(0.58, 0.64, m4.g).mul(float(1).sub(smoothstep(0.64, 0.70, m4.g))).mul(hf).add(smoothstep(0.58, 0.64, m6.g).mul(float(1).sub(smoothstep(0.64, 0.70, m6.g))).mul(vhf));
    // albedo: rust / iron-oxide base, darker basalt streaks, lighter weathered patches
    const cDark = vec3(o.dark[0], o.dark[1], o.dark[2]), cMid = vec3(o.mid[0], o.mid[1], o.mid[2]), cLight = vec3(o.light[0], o.light[1], o.light[2]), cBasalt = vec3(0.13, 0.085, 0.08);
    let rock = mix(cDark, cMid, smoothstep(0.30, 0.72, m1.r.mul(0.7).add(m2.g.mul(0.5))));
    rock = mix(rock, cLight, smoothstep(0.55, 0.9, m2.g.mul(0.6).add(m3.r.mul(0.4))).mul(0.55));
    rock = mix(rock, cBasalt, smoothstep(0.62, 0.95, m2.b).mul(0.6).mul(o.basalt));
    rock = rock.mul(float(1).sub(cracks.mul(0.6)).sub(crackFine.mul(0.45))).mul(float(1).add(flakeEdge.mul(0.32)));
    // dust settles on up-facing surface and in noise-driven drifts
    const up = nw.y;
    const dust1 = smoothstep(0.18, 0.82, up.mul(0.85).add(m1.g.sub(0.5).mul(0.9)).add(o.dustBias)).mul(o.dust);
    const dustCol = mix(vec3(0.34, 0.16, 0.09), vec3(0.46, 0.235, 0.14), m3.r);
    // dust ON dust: finer, paler wind-sorted layer riding the first one, plus bright mica-like grains
    const dust2 = smoothstep(0.50, 0.86, m3.g.mul(0.55).add(m4.r.mul(0.45))).mul(dust1).mul(lf);
    const dust2Col = vec3(0.56, 0.32, 0.20);
    const grains = smoothstep(0.86, 1.0, m5.a).mul(hf).mul(dust1);
    let alb = mix(rock, dustCol, dust1);
    alb = mix(alb, dust2Col, dust2.mul(0.55));
    alb = mix(alb, alb.mul(0.45), cracks.mul(0.5).add(crackFine.mul(0.4)).mul(dust1.mul(0.5).add(0.5)));   // seams show through the dust too
    alb = alb.add(vec3(0.9, 0.62, 0.42).mul(grains).mul(0.18));
    alb = alb.mul(float(0.82).add(m4.r.mul(0.36).mul(hf)).add(m3.a.sub(0.5).mul(0.18)));
    // bump: dust fills the cavities (smoother), the second layer ripples a little
    const hF = h0.sub(cracks.mul(0.55)).sub(crackFine.mul(0.28)).add(flakeEdge.mul(0.22));
    const hh = mix(hF, hF.mul(0.45), dust1.mul(0.55)).add(dust2.mul(m4.g.sub(0.5)).mul(0.12)).mul(o.bump);
    const sX = normalize(dFdx(positionView)), sY = normalize(dFdy(positionView)), N = normalView;
    const R1 = cross(sY, N), R2 = cross(N, sX), det = dot(sX, R1);
    const grad = sign(det).mul(dFdx(hh).mul(R1).add(dFdy(hh).mul(R2)));
    const nBump = normalize(abs(det).mul(N).sub(grad));
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0 });
    mat.colorNode = alb;
    const glint = smoothstep(0.90, 1.0, m6.a).mul(vhf).mul(float(1).sub(dust1.mul(0.6))).add(grains);
    mat.roughnessNode = float(0.97).sub(dust2.mul(0.1)).sub(glint.mul(0.5)).sub(flakeEdge.mul(0.18).mul(float(1).sub(dust1)));
    mat.metalnessNode = glint.mul(0.45).add(flakeEdge.mul(0.12));
    mat.normalNode = nBump;
    if (o.fadeRadius) { mat.transparent = true; mat.opacityNode = float(1).sub(smoothstep(o.fadeRadius[0], o.fadeRadius[1], length(pw.xz))); mat.depthWrite = true; }
    return mat;
  }

  /* ───────────────────────── scene content ───────────────────────── */
  function buildGroundMesh(THREE) {
    const NR = 150, NS = 220, R = 72;
    const pos = new Float32Array((NR + 1) * NS * 3), idx = [];
    for (let i = 0; i <= NR; i++) {
      const r = R * Math.pow(i / NR, 2.0);
      for (let j = 0; j < NS; j++) {
        const a = j / NS * Math.PI * 2, x = r * Math.cos(a), z = r * Math.sin(a), o = (i * NS + j) * 3;
        pos[o] = x; pos[o + 1] = groundH(x, z); pos[o + 2] = z;
      }
    }
    for (let i = 0; i < NR; i++) for (let j = 0; j < NS; j++) {
      const a = i * NS + j, b = i * NS + (j + 1) % NS, c = (i + 1) * NS + j, d = (i + 1) * NS + (j + 1) % NS;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  const BOULDER = { rx: 1.12, ry: 0.72, rz: 0.84, cx: 0, cy: -0.06, cz: 0 };
  function buildBoulderGeo(THREE) {
    const g = new THREE.SphereGeometry(1, 220, 150); g.rotateZ(Math.PI / 2);
    const p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).normalize();
      const big = (fbm(v.x * 1.5 + 4, v.y * 1.5, v.z * 1.5 - 2, 3, 3) - 0.5) * 0.34;
      const crag = (ridged(v.x * 3.4, v.y * 3.4 + 7, v.z * 3.4, 3, 9) - 0.35) * 0.16;
      const fine = (fbm(v.x * 12, v.y * 12, v.z * 12 + 5, 3, 15) - 0.5) * 0.045;
      const strata = Math.sin((v.y * 9.0 + fbm(v.x * 2, v.y * 2, v.z * 2, 2, 19) * 3) * 3.1) * 0.012;
      const r = 1 + big + crag + fine + strata;
      let y = v.y * BOULDER.ry * r; if (y < -0.28) y = -0.28 + (y + 0.28) * 0.2;       // flat-ish buried base
      p.setXYZ(i, BOULDER.cx + v.x * BOULDER.rx * r, BOULDER.cy + y, BOULDER.cz + v.z * BOULDER.rz * r);
    }
    g.computeVertexNormals(); return g;
  }
  function buildRocks(THREE, mat, group) {
    const geos = [];
    for (let k = 0; k < 3; k++) {
      const g = new THREE.IcosahedronGeometry(1, 3), p = g.attributes.position, v = new THREE.Vector3(), nrm = [];
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).normalize();
        const r = 0.72 + fbm(v.x * 2.2 + k * 5, v.y * 2.2, v.z * 2.2, 3, 41 + k) * 0.55 + (ridged(v.x * 3 + k, v.y * 3, v.z * 3, 2, 51) - 0.3) * 0.25;
        p.setXYZ(i, v.x * r * (1 + 0.25 * k), Math.max(v.y, -0.25) * r * 0.72, v.z * r * (1.1 - 0.12 * k)); nrm.push(v.x, v.y * 1.2, v.z);
      }
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); geos.push(g);
    }
    const counts = [190, 170, 150], dummy = new THREE.Object3D(), out = [];
    _seed = 9001;
    counts.forEach((n, k) => {
      const im = new THREE.InstancedMesh(geos[k], mat, n); im.castShadow = true; im.receiveShadow = true;
      for (let i = 0; i < n; i++) {
        let x, z, r;
        for (let tries = 0; tries < 30; tries++) {
          r = 1.6 + Math.pow(rnd(), 1.5) * 52; const a = rnd() * Math.PI * 2; x = r * Math.cos(a); z = r * Math.sin(a);
          const bx = (x - BOULDER.cx) / (BOULDER.rx * 1.35), bz = (z - BOULDER.cz) / (BOULDER.rz * 1.35);
          if (bx * bx + bz * bz > 1) break;                         // keep clear of the boulder + her feet
        }
        let s = 0.03 + Math.pow(rnd(), 3.6) * (0.16 + r * 0.008);
        if (r > 12 && rnd() < 0.07) s = 0.9 + rnd() * 2.2;           // far mounds / tors
        dummy.position.set(x, groundH(x, z) + s * 0.1, z);
        dummy.rotation.set((rnd() - 0.5) * 0.5, rnd() * 6.28, (rnd() - 0.5) * 0.5);
        dummy.scale.set(s * (1 + rnd() * 0.8), s * (0.7 + rnd() * 0.5), s * (1 + rnd() * 0.8));
        dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; group.add(im); out.push(im);
    });
    // fine gravel + flakes scattered close in (the camera sees these as the 'grit' of the soil)
    {
      const pg = new THREE.IcosahedronGeometry(1, 1), pp = pg.attributes.position, pv = new THREE.Vector3(), pn = [];
      for (let i = 0; i < pp.count; i++) { pv.fromBufferAttribute(pp, i).normalize(); const r = 0.75 + fbm(pv.x * 3, pv.y * 3, pv.z * 3, 2, 77) * 0.5; pp.setXYZ(i, pv.x * r, Math.max(pv.y, -0.2) * r * 0.55, pv.z * r); pn.push(pv.x, pv.y * 1.3, pv.z); }
      pg.setAttribute('normal', new THREE.Float32BufferAttribute(pn, 3));
      const NP = 1400, im = new THREE.InstancedMesh(pg, mat, NP); im.receiveShadow = true; _seed = 4242;
      for (let i = 0; i < NP; i++) {
        let x, z; for (let tries = 0; tries < 20; tries++) { const r = 0.8 + Math.pow(rnd(), 1.4) * 7.5, a = rnd() * 6.283; x = r * Math.cos(a); z = r * Math.sin(a);
          const bx = (x - BOULDER.cx) / (BOULDER.rx * 1.2), bz = (z - BOULDER.cz) / (BOULDER.rz * 1.2); if (bx * bx + bz * bz > 1) break; }
        const s = 0.008 + Math.pow(rnd(), 2.5) * 0.05;
        dummy.position.set(x, groundH(x, z) + s * 0.1, z); dummy.rotation.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28);
        dummy.scale.set(s * (1 + rnd()), s * (0.5 + rnd() * 0.6), s * (1 + rnd())); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; group.add(im); out.push(im);
    }
    return { geos, meshes: out };
  }

  /* ───────────────────────── Ariel pose solver (ported from the game's board-stance solver) ───────────────────────── */
  function makePoser(THREE, C) {
    const b = C.bones, R = C.rest, root = C.root;
    const Q = () => new THREE.Quaternion(), V = () => new THREE.Vector3();
    const S = { e: new THREE.Euler(0, 0, 0, 'YZX'), q: [Q(), Q(), Q(), Q(), Q(), Q(), Q()], v: Array.from({ length: 20 }, V), limb: {}, ax: V() };
    const Y = new THREE.Vector3(0, 1, 0);
    function RQ(bone, out) { out.copy(bone.quaternion); let o = bone.parent; while (o && o !== root) { out.premultiply(o.quaternion); o = o.parent; } return out; }
    function RP(bone, out) { out.set(0, 0, 0); let o = bone; while (o && o !== root) { out.multiply(o.scale).applyQuaternion(o.quaternion).add(o.position); o = o.parent; } return out; }
    function limbRest(U, L, E, hinge) {
      const u0 = new THREE.Quaternion(), q = new THREE.Quaternion();
      u0.copy(R[U.name].q); let o = U.parent; while (o && o !== root) { u0.premultiply(R[o.name] ? R[o.name].q : o.quaternion); o = o.parent; }
      const lRel = R[L.name].q.clone();
      const du0 = R[L.name].p.clone().multiply(R[U.name].s).normalize().applyQuaternion(u0);
      q.copy(u0).multiply(lRel);
      const dl0 = R[E.name].p.clone().multiply(R[L.name].s).normalize().applyQuaternion(q);
      const h0 = hinge ? hinge.clone() : new THREE.Vector3().crossVectors(du0, dl0).normalize();
      return { U, L, E, u0, lRel, du0, dl0, h0, l1: R[L.name].p.length() * R[U.name].s.x, l2: R[E.name].p.length() * R[L.name].s.x };
    }
    function setRQ(bone, target, w) {
      const p = S.q[5]; RQ(bone.parent, p); p.invert().multiply(target);
      if (w >= 0.999) bone.quaternion.copy(p); else bone.quaternion.slerp(p, w);
    }
    function limb(Lb, du, dl, w, pro) {
      const q1 = S.q[0], qt = S.q[1], ur = S.q[2], lr = S.q[3], tmp = S.q[4], h1 = S.v[0], hd = S.v[1], dlc = S.v[2];
      q1.setFromUnitVectors(Lb.du0, du);
      h1.copy(Lb.h0).applyQuaternion(q1); h1.addScaledVector(du, -h1.dot(du));
      hd.crossVectors(du, dl); hd.addScaledVector(du, -hd.dot(du));
      qt.identity();
      if (hd.lengthSq() > 1e-8 && h1.lengthSq() > 1e-8) { h1.normalize(); hd.normalize();
        const ang = Math.atan2(S.ax.crossVectors(h1, hd).dot(du), h1.dot(hd)); qt.setFromAxisAngle(du, ang); }
      ur.copy(qt).multiply(q1).multiply(Lb.u0);
      setRQ(Lb.U, ur, w); RQ(Lb.U, ur);
      lr.copy(ur).multiply(Lb.lRel);
      dlc.copy(Lb.dl0).applyQuaternion(tmp.copy(ur).multiply(S.q[5].copy(Lb.u0).invert()));
      tmp.setFromUnitVectors(dlc.normalize(), dl); lr.premultiply(tmp);
      if (pro) lr.premultiply(S.q[6].setFromAxisAngle(S.v[16].copy(Lb.E.position).normalize().applyQuaternion(lr), pro));
      setRQ(Lb.L, lr, w);
    }
    function rot(name, yaw, pitch, roll, w) {
      const bone = b[name]; if (!bone || !R[name]) return;
      S.e.set(pitch * Math.PI / 180, yaw * Math.PI / 180, roll * Math.PI / 180, 'YZX');
      const t = S.q[4].setFromEuler(S.e), r = S.q[3].copy(R[name].q); let o = bone.parent;
      while (o && o !== root) { r.premultiply(R[o.name] ? R[o.name].q : o.quaternion); o = o.parent; }
      t.multiply(r); setRQ(bone, t, w == null ? 1 : w);
    }
    function leg(Lb, T, pole, w) {
      const H = S.v[8], n = S.v[9], m = S.v[10], K = S.v[11], du = S.v[12], dl = S.v[13];
      RP(Lb.U, H); n.subVectors(T, H); let d = n.length(); n.multiplyScalar(1 / (d || 1));
      const L = Lb.l1 + Lb.l2; d = Math.max(L * 0.55, Math.min(L * 0.985, d));
      const a = (Lb.l1 * Lb.l1 - Lb.l2 * Lb.l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, Lb.l1 * Lb.l1 - a * a));
      m.copy(pole).addScaledVector(n, -pole.dot(n)).normalize();
      K.copy(H).addScaledVector(n, a).addScaledVector(m, h);
      du.subVectors(K, H).normalize(); dl.copy(H).addScaledVector(n, d).sub(K).normalize();
      limb(Lb, du, dl, w == null ? 1 : w);
    }
    function ready() {
      if (S.ok) return true;
      const need = ['Hips', 'Spine02', 'Spine01', 'Spine', 'neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
      if (!need.every(n => b[n] && R[n])) return false;
      const lat = new THREE.Vector3(1, 0, 0);
      S.limb.armL = limbRest(b.LeftArm, b.LeftForeArm, b.LeftHand);
      S.limb.armR = limbRest(b.RightArm, b.RightForeArm, b.RightHand);
      S.limb.legL = limbRest(b.LeftUpLeg, b.LeftLeg, b.LeftFoot, lat);
      S.limb.legR = limbRest(b.RightUpLeg, b.RightLeg, b.RightFoot, lat);
      S.ok = true; return true;
    }
    // relaxed fingers: every joint a little curled toward the palm (solved from the rest, straight hand)
    function fingers(curl, spread) {
      const rp = n => RP(b[n], V()), q = Q(), r = Q(), ax = V(); const cl = (v, a) => Math.max(-a, Math.min(a, v || 0)) * Math.PI / 180;
      for (const side of ['Left', 'Right']) {
        const H = side + 'Hand', n = f => H + f; if (!b[H] || !b[n('Middle1')] || !b[n('Index1')] || !b[n('Pinky1')]) continue;
        const hAx = rp(n('Middle1')).sub(rp(H)).normalize(), lat = rp(n('Index1')).sub(rp(n('Pinky1'))).normalize();
        // palm normal from the rest hand: Left = axis × (index→pinky reversed), Right = mirrored. (Checked on this rig's reach-pose rest: it points into the palm — thumb-up, palm toward the body.)
        const np = side === 'Left' ? new THREE.Vector3().crossVectors(hAx, lat).normalize() : new THREE.Vector3().crossVectors(lat, hAx).normalize();
        np.negate();   // measured on screen: this cross product points at the BACK of the hand — the palm is the opposite side
        for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) for (let k = 1; k <= 3; k++) {
          const bn = n(f + k), cn = n(f + (k + 1)); if (!b[bn] || !R[bn]) continue;
          const d = b[cn] ? rp(cn).sub(rp(bn)).normalize() : hAx.clone();
          r.setFromAxisAngle(ax.crossVectors(d, np).normalize(), Math.max(0, Math.min(55, (curl[k - 1] || 0) * ({ Index: 1, Middle: 1.12, Ring: 1.26, Pinky: 1.4 }[f]))) * Math.PI / 180);   // the two hands' palm normals come out mirrored on this rig: Left bone +, Right bone −
          if (k === 1 && spread) r.multiply(q.setFromAxisAngle(ax.crossVectors(d, lat).normalize(), cl(spread[f], 15)));
          RQ(b[bn], q); const loc = q.clone().invert().multiply(r).multiply(q);
          b[bn].quaternion.copy(R[bn].q).multiply(loc);
        }
      }
    }
    return { S, ready, rot, leg, limb, RP, RQ, fingers, Y };
  }

  /* ───────────────────────── start ───────────────────────── */
  MS.start = function () {
    if (MS._p) return MS._p;
    MS.started = true;
    MS._p = (async function () {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 300 && !(window.THREE && window.THREE.WebGPURenderer && window.THREE.GLTFLoader && window.THREE.TSL); i++) await sleep(100);
      const THREE = window.THREE;
      if (!(THREE && THREE.WebGPURenderer && THREE.GLTFLoader && THREE.TSL)) throw new Error('three not available');
      const host = document.getElementById('screen-menu'); if (!host) throw new Error('no #screen-menu');
      let cv = document.getElementById('menu-scene-canvas');
      if (!cv) { cv = document.createElement('canvas'); cv.id = 'menu-scene-canvas'; const star = document.getElementById('menu-bg-canvas'); star && star.nextSibling ? host.insertBefore(cv, star.nextSibling) : host.appendChild(cv); }
      const G = (typeof GFX !== 'undefined' && GFX) ? GFX : {};
      const mobile = !!G.isMobile || /Android|iPhone|iPad/i.test(navigator.userAgent || '');
      const lowTier = G.preset === 'low' || (mobile && G.preset === 'auto');
      const sc = { pr: Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2) * (G.resScale && G.resScale < 1 ? G.resScale : 1), shadow: lowTier ? 1024 : (mobile ? 1536 : 2048), hair: lowTier ? 0.55 : (mobile ? 0.8 : 1), hairTier: (lowTier || mobile) ? 1 : 2 };   // (v379, follows the game default approved by Justin 2026-11-24) menu hair collision: phones / tablets / low tier 1, desktop tier 2; was 0 / 1. The frame-budget ladder still drops hair to tier 0 under load
      const q = location.search || ''; const qs = (k, d) => { const m = q.match(new RegExp('[?&]' + k + '=([^&]*)')); return m ? decodeURIComponent(m[1]) : d; };
      if (qs('msq', '')) sc.pr = Math.min(sc.pr, parseFloat(qs('msq', '1')) || 1);
      // (t1644u) DUO: Ariel AND Emma sit on the rock together and both fly out on the launch (?intro=solo or ?menuduo=0 = the single-pilot scene / intro)
      const DUO_WANT = qs('intro', '') !== 'solo' && qs('menuduo', '1') !== '0' && !!(window.DMChars && DMChars.get && DMChars.get('emma') && DMChars.get('emma').ready);
      let B = null;   // the second pilot (built below when she loaded)
      let duoWide = DUO_WANT;   // frame the rock for two from the first frame (Emma mounts when her GLB lands); false again if she never does

      /* renderer */
      const forceGL = qs('msgl', '') === '1' || !!window.__MS_FORCE_GL;
      if (forceGL || window.__MS_DEBUG) { sc.pr = Math.min(sc.pr, 1); sc.shadow = Math.min(sc.shadow, 512); sc.hair = Math.min(sc.hair, 0.55); sc.hairTier = 0; }
      const renderer = new THREE.WebGPURenderer({ canvas: cv, antialias: !lowTier && !forceGL, alpha: true, forceWebGL: forceGL, powerPreference: 'high-performance', preserveDrawingBuffer: !!(forceGL || window.__MS_DEBUG) });
      await renderer.init();
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      let pr = sc.pr;
      const fit = () => {
        const w = Math.max(2, cv.clientWidth || window.innerWidth), h = Math.max(2, cv.clientHeight || window.innerHeight);
        renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
        camera.aspect = w / h; frame(); camera.updateProjectionMatrix();
      };

      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x2a0e08, 0.012);
      const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 400);
      const TARGET = new THREE.Vector3(0.0, 0.95, 0.0);
      let camBase = new THREE.Vector3();
      function frame() {                             // keep boulder + her in frame whatever the aspect
        const asp = camera.aspect, tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const needH = 2.45, needW = (B || duoWide) ? 4.3 : 3.5;   // (t1644u) two pilots on the rock: a little wider
        const dist = Math.max(needH / (2 * tanH), needW / (2 * tanH * asp));
        camBase.set(0.55, 1.15, dist); camera.position.copy(camBase); camera.lookAt(TARGET);
      }

      /* materials + terrain */
      await sleep(60);
      const noiseTex = makeNoiseTexture(THREE);
      await sleep(60);
      const groundMat = surfaceMaterial(THREE, noiseTex, { dark: [0.13, 0.05, 0.03], mid: [0.27, 0.105, 0.058], light: [0.40, 0.18, 0.10], dust: 0.8, dustBias: 0.12, basalt: 0.5, bump: 1.7, fadeRadius: [46, 66] });
      const rockMat = surfaceMaterial(THREE, noiseTex, { dark: [0.17, 0.07, 0.05], mid: [0.36, 0.15, 0.085], light: [0.52, 0.25, 0.14], dust: 0.8, dustBias: -0.05, basalt: 0.9, bump: 2.2 });
      const boulderMat = surfaceMaterial(THREE, noiseTex, { dark: [0.17, 0.068, 0.045], mid: [0.37, 0.15, 0.085], light: [0.55, 0.26, 0.145], dust: 0.72, dustBias: -0.12, basalt: 0.85, bump: 1.5 });
      const ground = new THREE.Mesh(buildGroundMesh(THREE), groundMat); ground.receiveShadow = true; ground.frustumCulled = false; scene.add(ground);
      await sleep(60);
      const boulder = new THREE.Mesh(buildBoulderGeo(THREE), boulderMat); boulder.castShadow = true; boulder.receiveShadow = true; scene.add(boulder);
      const rocks = buildRocks(THREE, rockMat, scene);
      /* (v379) camera collision for the launch pan: bounding spheres of every rock instance big enough to swallow the lens (+ the boulder as an
         ellipsoid, + the ground).  Built once here; duoCamera pushes the lens out of them each frame (no per-frame allocation).  Justin saw the pan
         fly through a rock and show its hollow inside. */
      const CAMCOL = (() => {
        const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc3 = new THREE.Vector3(), out = [];
        rocks.meshes.slice(0, 3).forEach((im, k) => { const g = rocks.geos[k]; if (!g.boundingSphere) g.computeBoundingSphere(); const gr = g.boundingSphere.radius, gc = g.boundingSphere.center;
          for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m4); m4.decompose(p, q, sc3); const r = gr * Math.max(sc3.x, sc3.y, sc3.z); if (r < 0.12 || Math.hypot(p.x, p.z) > 30) continue;
            p.add(sc3.multiply(gc)); out.push(p.x, p.y, p.z, r); } });
        return { s: new Float32Array(out), n: out.length / 4 };
      })();
      const camAvoid = (c) => {
        const S = CAMCOL.s, PAD = 0.45;
        for (let it = 0; it < 2; it++) {
          for (let i = 0; i < CAMCOL.n; i++) { const o = i * 4, dx = c.x - S[o], dy = c.y - S[o + 1], dz = c.z - S[o + 2], rr = S[o + 3] + PAD, d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < rr * rr) { const d = Math.sqrt(d2) || 1e-6, k = rr / d; c.x = S[o] + dx * k; c.y = S[o + 1] + dy * k; c.z = S[o + 2] + dz * k; } }
          // the boulder (ellipsoid, a little inflated) and the ground
          const ex = (c.x - BOULDER.cx) / (BOULDER.rx * 1.25 + PAD), ey = (c.y - BOULDER.cy) / (BOULDER.ry * 1.25 + PAD), ez = (c.z - BOULDER.cz) / (BOULDER.rz * 1.25 + PAD), e2 = ex * ex + ey * ey + ez * ez;
          if (e2 < 1) { const k = 1 / (Math.sqrt(e2) || 1e-6); c.x = BOULDER.cx + (c.x - BOULDER.cx) * k; c.y = BOULDER.cy + (c.y - BOULDER.cy) * k; c.z = BOULDER.cz + (c.z - BOULDER.cz) * k; }
          const gy = groundH(c.x, c.z) + PAD; if (c.y < gy) c.y = gy;
        }
      };
      scene.updateMatrixWorld(true);

      /* horizon haze behind everything (glows red where the star sky meets the ridges) */
      {
        const T = THREE.TSL, hm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
        const y = T.uv().y;
        hm.colorNode = T.mix(T.vec3(0.55, 0.14, 0.05), T.vec3(0.30, 0.06, 0.09), T.smoothstep(0.0, 0.55, y));
        // fade before the plane's top edge so it reads as a horizon glow, not a hard red bar / gradient banding across the upper sky
        hm.opacityNode = T.pow(T.float(1).sub(T.smoothstep(0.0, 0.7, y)), T.float(2.6)).mul(0.45);
        const haze = new THREE.Mesh(new THREE.PlaneGeometry(220, 22, 1, 24), hm); haze.position.set(0, 5.2, -88); haze.renderOrder = -5; scene.add(haze);
      }

      /* lights: warm low key (shadowed) + cool rim from the galaxy side + red bounce + panel glow */
      const hemi = new THREE.HemisphereLight(0x2a2048, 0x4a1608, 0.4); scene.add(hemi);
      const key = new THREE.SpotLight(0xff9a62, 5.2, 0, 0.62, 0.85, 0); key.position.set(-4.6, 5.4, 5.0); key.target.position.set(0, 0.55, 0);
      key.castShadow = true; key.shadow.mapSize.set(sc.shadow, sc.shadow); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.025; key.shadow.camera.near = 2; key.shadow.camera.far = 20;
      scene.add(key, key.target);
      const rim = new THREE.DirectionalLight(0x7a9cff, 2.2); rim.position.set(5.5, 3.2, -6.0); scene.add(rim);
      const fill = new THREE.DirectionalLight(0xffc7a0, 0.9); fill.position.set(2.0, 1.6, 7.0); scene.add(fill);
      const bounce = new THREE.DirectionalLight(0xff6a38, 0.75); bounce.position.set(0.5, -1.0, 3.5); scene.add(bounce);
      const glowL = new THREE.PointLight(0xff5a2a, 0, 11, 1.4), glowR = new THREE.PointLight(0xff5a2a, 0, 11, 1.4);
      glowL.position.set(-3.4, 1.7, 1.2); glowR.position.set(3.4, 1.7, 1.2); scene.add(glowL, glowR);

      /* drifting dust motes in the light */
      const NM = lowTier ? 160 : 320, mp = new Float32Array(NM * 3), mv = new Float32Array(NM * 3);
      for (let i = 0; i < NM; i++) { mp[i * 3] = (Math.random() - 0.5) * 12; mp[i * 3 + 1] = Math.random() * 3.6; mp[i * 3 + 2] = (Math.random() - 0.5) * 8; mv[i * 3] = 0.12 + Math.random() * 0.25; mv[i * 3 + 1] = (Math.random() - 0.5) * 0.04; mv[i * 3 + 2] = (Math.random() - 0.5) * 0.08; }
      const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
      const motes = new THREE.Points(mg, new THREE.PointsMaterial({ size: 0.022, color: 0xffb98a, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      motes.frustumCulled = false; scene.add(motes);
      /* board dust trail (departure only): a small ring of additive grains emitted at the board's tail; emission scales with speed and with how low the
         board is, so it starts forming as she picks up speed near the ground and thins out as she climbs. Hidden and untouched until the lift-off. */
      const NT = lowTier ? 90 : 160, tpos = new Float32Array(NT * 3), tcol = new Float32Array(NT * 3), tvel = new Float32Array(NT * 3), tage = new Float32Array(NT).fill(9), tlife = new Float32Array(NT).fill(1);
      const tgeo = new THREE.BufferGeometry(); tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3)); tgeo.setAttribute('color', new THREE.BufferAttribute(tcol, 3));
      const trail = new THREE.Points(tgeo, new THREE.PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      trail.frustumCulled = false; trail.visible = false; scene.add(trail);
      let tHead = 0, tAcc = 0, tAlive = 0;
      /* (v379) board jet streams = the GAME's skyboard wake (index.html _makeWake / updateBoardWake), ported 1:1: WAKE_N instanced thin streaks
         (two crossed quads, bright at the head, fading to the tail) in the board's OWN frame, emitted from the four tail corners (upper pair / lower
         pair), each living 0.35-0.8 s, length 15-50 % of the board, thickness 0.9 % of its length.  Replaces the v378 4-lane ribbons (too thick / wide).
         Colours = the game's trail palette when the launch hands it in (o.trail: the four wisp colours), else the game's default glow tones.
         Everything is allocated here, once per board; tick() writes instance matrices / colours in place (zero per-frame allocation). */
      const WAKE_N = 110, WAKE_DEF = ['#5ce8ff', '#9b7dff', '#d8ecff', '#3ad6b8'];
      const mkJets = (board, cols) => {
        const P = [], Cc = [];
        const quad = (ax) => { const q = ax === 'y' ? [[-1, -.5, 0], [0, -.5, 0], [0, .5, 0], [-1, -.5, 0], [0, .5, 0], [-1, .5, 0]] : [[-1, 0, -.5], [0, 0, -.5], [0, 0, .5], [-1, 0, -.5], [0, 0, .5], [-1, 0, .5]];
          q.forEach((v) => { P.push(v[0], v[1], v[2]); const c = v[0] < -0.5 ? 0 : 1; Cc.push(c, c, c); }); };
        quad('y'); quad('z');
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
        const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: false });
        const mesh = new THREE.InstancedMesh(g, mat, WAKE_N); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.name = 'board-jets';
        // board-local bounds (nose -X, tail +X), measured once
        const box = new THREE.Box3(), tb = new THREE.Box3(), mm = new THREE.Matrix4(); board.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(board.matrixWorld).invert();
        board.traverse((o) => { if (!o.isMesh || !o.geometry) return; if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); tb.copy(o.geometry.boundingBox).applyMatrix4(mm.multiplyMatrices(inv, o.matrixWorld)); box.union(tb); });
        if (box.isEmpty()) box.set(new THREE.Vector3(-1.5, -0.1, -0.4), new THREE.Vector3(1.5, 0.1, 0.4));
        const L = Math.max(0.2, box.max.x - box.min.x), hy = (box.max.y - box.min.y) * 0.5, cy = (box.max.y + box.min.y) * 0.5, hz = (box.max.z - box.min.z) * 0.5, cz = (box.max.z + box.min.z) * 0.5, th = L * 0.009;
        const life = new Float32Array(WAKE_N), age = new Float32Array(WAKE_N).fill(1), pp = new Float32Array(WAKE_N * 3), vv = new Float32Array(WAKE_N), sl = new Float32Array(WAKE_N);
        const tint = [], pal = (Array.isArray(cols) && cols.length ? cols : WAKE_DEF);
        const glow = (hex) => { const c = new THREE.Color(hex), h = {}; c.getHSL(h); return h.s < 0.08 ? c.setHSL(h.h, h.s, Math.min(0.85, Math.max(0.62, h.l))) : c.setHSL(h.h, Math.max(0.6, h.s), Math.min(0.78, Math.max(0.6, h.l))); };
        for (let i = 0; i < WAKE_N; i++) { let c; try { c = glow(pal[i & 3] || WAKE_DEF[i & 3]); } catch (e) { c = new THREE.Color(WAKE_DEF[i & 3]); } tint.push(c); mesh.setColorAt(i, new THREE.Color(0, 0, 0)); }
        const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
        let emit = 0;
        const grp = mesh;   // callers treat .group as the scene node (parented next to the board, never as its child)
        const tick = (b, speed, dt) => {
          if (!b) return;
          const k = Math.max(0, Math.min(1.4, (speed - 0.45) / 6));   // menu board speed (m/s) -> the game's wake intensity (0..1)
          b.updateMatrixWorld(true); mesh.matrix.copy(b.matrixWorld);
          if (mesh.parent && mesh.parent.matrixWorld && !mesh.parent.isScene) mesh.matrix.premultiply(mm.copy(mesh.parent.matrixWorld).invert());
          mesh.matrixWorldNeedsUpdate = true;
          if (k > 0.02) {
            emit += dt * WAKE_N * 1.6 * Math.min(1, k);
            for (let i = 0; i < WAKE_N && emit >= 1; i++) {
              if (age[i] < life[i]) continue; emit -= 1; const lane = i & 3;
              pp[i * 3] = box.max.x - L * 0.05;
              pp[i * 3 + 1] = cy + (lane < 2 ? 0.6 : -0.3) * hy + (Math.random() - 0.5) * hy * 0.5;
              pp[i * 3 + 2] = cz + ((lane & 1) ? 0.75 : -0.75) * hz + (Math.random() - 0.5) * hz * 0.35;
              vv[i] = L * (1.1 + Math.random() * 1.4) * (0.7 + 0.5 * Math.min(1, k)); sl[i] = L * (0.15 + Math.random() * 0.35) * (0.5 + 0.6 * Math.min(1, k));
              life[i] = 0.35 + Math.random() * 0.45; age[i] = 0;
            }
            emit = Math.min(emit, 4);
          }
          let any = false;
          for (let i = 0; i < WAKE_N; i++) {
            let a = 0;
            if (age[i] < life[i]) { age[i] += dt; pp[i * 3] += vv[i] * dt; const t = age[i] / life[i]; a = t < 1 ? Math.sin(Math.PI * Math.min(1, t)) * 0.32 * Math.min(1, k + 0.25) : 0; any = true; }
            _p.set(pp[i * 3], pp[i * 3 + 1], pp[i * 3 + 2]); _s.set(a > 0 ? -sl[i] : 1e-4, th, th); _m.compose(_p, _q, _s); mesh.setMatrixAt(i, _m);
            _c.copy(tint[i]).multiplyScalar(a); mesh.setColorAt(i, _c);
          }
          mesh.visible = any; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        };
        const reset = () => { age.fill(1); life.fill(0); emit = 0; };
        const dispose = () => { try { if (mesh.parent) mesh.parent.remove(mesh); } catch (e) {} try { g.dispose(); mat.dispose(); mesh.dispose && mesh.dispose(); } catch (e) {} };
        return { group: grp, tick, dispose, reset, mesh };
      };

      /* Ariel */
      const holder = new THREE.Object3D(); scene.add(holder);
      const gltfP = (url) => new Promise((res, rej) => new THREE.GLTFLoader().load(url, res, undefined, rej));
      // (t1644u) the second pilot downloads alongside Ariel; if she is not in within 14 s (slow link) the scene starts with Ariel alone (solo intro)
      const pBdef = DUO_WANT ? DMChars.get('emma') : null;
      const pB = pBdef ? Promise.race([gltfP(pBdef.mesh), new Promise((_, rej) => setTimeout(() => rej(new Error('companion timeout')), 14000))]).catch((e) => { info('second pilot not loaded:', e && e.message); return null; }) : Promise.resolve(null);
      const gltf = await gltfP(CHAR_URL);
      if (MS.disposed) return;
      const root = gltf.scene; holder.add(root);
      const bones = {}; root.traverse(o => { if (o.isBone) bones[o.name] = o; if (o.isSkinnedMesh || o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (!m) return; if (m.metalness > 0.5) m.metalness = 0.08; if (m.roughness > 0.9) m.roughness = 0.6; if (m.emissiveIntensity === undefined) m.emissiveIntensity = 1; m.needsUpdate = true; }); } });
      const rest = {}; Object.keys(bones).forEach(n => { const bn = bones[n]; rest[n] = { p: bn.position.clone(), q: bn.quaternion.clone(), s: bn.scale.clone() }; });
      const C = { root, bones, rest, mixer: new THREE.AnimationMixer(root) };
      const P = makePoser(THREE, C);
      if (!P.ready()) throw new Error('rig bones missing');
      P.fingers([22, 32, 17], { Index: 5, Middle: 0, Ring: -3, Pinky: -8 });

      /* seat: hips settle on the boulder; yaw her so she faces screen-left */
      // (t1644u) no wait for the second pilot: Ariel paints at once in the duo seat (left half of the rock) and Emma is mounted beside her the moment her
      // GLB is in (pB below); if Emma never arrives (failed / 14 s timeout) Ariel moves back to the solo seat.
      let duoSeat = !!pBdef;
      const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
      const surfY = (x, z, extra) => { ray.set(new THREE.Vector3(x, 6, z), down); const hits = ray.intersectObjects(extra || [boulder, ground], false); return hits.length ? hits[0].point.y : 0; };
      let SEAT_X = 0.2;
      const hipsRoot = new THREE.Vector3(0, 0.80, -0.04);
      const place = () => { holder.updateMatrixWorld(true); const wp = holder.localToWorld(hipsRoot.clone()); holder.position.x += SEAT_X - wp.x; holder.position.z += 0 - wp.z;
        holder.position.y += (surfY(SEAT_X, 0, [boulder]) + 0.115) - wp.y; holder.updateMatrixWorld(true); };
      const toRoot = (wx, wz, lift) => { const y = Math.max(surfY(wx, wz, [boulder]), surfY(wx, wz, [ground]) ) + lift; return holder.worldToLocal(new THREE.Vector3(wx, y, wz)); };
      // foot targets (root space): near (her left) foot up on the boulder's front slope, far foot lower & further out
      const fwd = (f, s) => { const w = holder.localToWorld(new THREE.Vector3(s, 0, f)); return [w.x, w.z]; };
      // (duo) both feet stay ON the rock: the reach is shortened until the point is over the boulder (a target past its edge dropped the foot to the
      // ground and the shin ran through the rock)
      const onRock = (fw, f, sd, to, lift) => { let x = 0, z = 0; for (let ff = f; ff >= 0.22; ff -= 0.03) { [x, z] = fw(ff, sd); if (surfY(x, z, [boulder]) > surfY(x, z, [ground]) + 0.14) break; } return to(x, z, lift); };
      const ankleL = new THREE.Vector3(), ankleR = new THREE.Vector3();
      const seatA = (duo) => {   // character +Z (forward) -> world -X; duo: left half of the rock, turned a little more to the camera
        duoSeat = duo; holder.position.set(0, 0, 0); holder.rotation.y = duo ? -Math.PI * 0.14 : -Math.PI * 0.22; SEAT_X = duo ? -0.36 : 0.2;
        place(); place();
        ankleL.copy(duo ? onRock(fwd, 0.34, 0.14, toRoot, 0.105) : (() => { const [x, z] = fwd(0.34, 0.14); return toRoot(x, z, 0.105); })());
        ankleR.copy(duo ? onRock(fwd, 0.62, -0.16, toRoot, 0.105) : (() => { const [x, z] = fwd(0.72, -0.16); return toRoot(x, z, 0.105); })());
      };
      seatA(duoSeat);


      const SEAT_COL = [
        { bone: 'Spine02', a: [0, 0.02, 0.09], b: [0, 0.14, 0.11], r: 0.17 },
        { bone: 'Spine01', a: [0, 0.0, 0.10], b: [0, 0.12, 0.11], r: 0.16 },
        { bone: 'LeftShoulder', a: [0, 0.02, 0.05], b: [0, 0.13, 0.06], r: 0.11 },
        { bone: 'RightShoulder', a: [0, 0.02, 0.05], b: [0, 0.13, 0.06], r: 0.11 },
        { bone: 'Spine02', a: [0.085, 0.02, 0.08], b: [0.085, 0.13, 0.10], r: 0.12 },
        { bone: 'Spine02', a: [-0.085, 0.02, 0.08], b: [-0.085, 0.13, 0.10], r: 0.12 }
      ];
      const bindSeatCols = (X, H) => {
        if (!X || !H || !H.addCollider || X._seatCol) return;
        X._seatCol = SEAT_COL.map((c) => {
          const bn = X.bones[c.bone]; if (!bn) return null;
          const h = H.addCollider({ center: new THREE.Vector3(), end: new THREE.Vector3(), radius: c.r });
          h._bone = bn; h._a = new THREE.Vector3().fromArray(c.a); h._b = new THREE.Vector3().fromArray(c.b); h._r = c.r; return h;
        }).filter(Boolean);
      };
      const tickSeatCols = (X) => {
        if (!X || !X._seatCol) return;
        X._seatCol.forEach((h) => { h._bone.updateWorldMatrix(true, false); h.center.copy(h._a).applyMatrix4(h._bone.matrixWorld); h.end.copy(h._b).applyMatrix4(h._bone.matrixWorld); h.radius = h._r; });
      };
      const clearSeatCols = (X) => {
        if (!X || !X._seatCol) return;
        X._seatCol.forEach((h) => { h.radius = 0; });   // drop seated capsules so they are not left at the rock while she stands / walks
      };
      const clearAllSeatCols = () => { clearSeatCols(A); if (B) clearSeatCols(B); };
      /* hair: build via buildHair directly so nothing leaks into window.DART_HAIR */
      let hair = null;
      (async () => { try {
        const [mod, buf] = await Promise.all([import('../hair_strands.js'), fetch(HAIR_URL).then(r => { if (!r.ok) throw new Error('hair ' + r.status); return r.arrayBuffer(); })]);
        if (MS.disposed) return;
        hair = mod.buildHair({ root, bones, mixer: C.mixer }, THREE, buf, { getStrandFraction: () => sc.hair, getGravityScale: () => 1, getCollisionTier: () => sc.hairTier, params: { windGust: 0.15 } });
        try { if (window.DMMenuWorld && DMMenuWorld.protectHair) DMMenuWorld.protectHair(root); } catch (e) {}
        if (A) { bindSeatCols(A, hair); A.hair = hair; } info('strand hair attached');
      } catch (e) { info('hair not attached:', e && e.message); } })();

      /* pose + idle loop */
      const v3 = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
      const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpW = new THREE.Vector3(), tmpC = new THREE.Vector3();
      const poleL = v3(0, 1, 0.55), poleR = v3(0, 0.35, 1);
      const Rest = { upL: v3(0.22, -0.92, 0.30), foreL: v3(0.02, -0.38, 0.93), upR: v3(-0.20, -0.94, 0.26), foreR: v3(-0.06, -0.40, 0.92) };
      const Reach = { upL: v3(0.30, -0.20, 0.93), foreL: v3(0.16, -0.06, 0.985) };
      const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      const reachAt = (t) => { const ph = (t % 26) / 26; return smooth(0.50, 0.58, ph) * (1 - smooth(0.72, 0.82, ph)); };   // one slow reach per 26 s
      const Hp = new THREE.Vector3();
      /* face: her rig has mouth-corner, lip, cheek and brow bones (no eyelid bones), so a smile is real and a wink is a cheek-lift squint with the brow dropping */
      const FACE = {}; { const D = (n, x, y, z) => [n, x, y, z];
        const defs = [D('LeftMouthCorner', 0.010, 0.012, -0.004), D('RightMouthCorner', -0.010, 0.012, -0.004), D('LeftCheek', 0.004, 0.008, 0.003), D('RightCheek', -0.004, 0.008, 0.003),
          D('LeftUpperLip', 0.002, 0.003, 0), D('RightUpperLip', -0.002, 0.003, 0), D('LeftLowerLip', 0.004, 0.004, 0), D('RightLowerLip', -0.004, 0.004, 0)];
        root.updateMatrixWorld(true);
        const loc = (n, d) => { const bn = bones[n]; if (!bn || !bn.parent) return null; const inv = bn.parent.matrixWorld.clone().invert(), o = new THREE.Vector3().setFromMatrixPosition(bn.parent.matrixWorld);
          return d.clone().add(o).applyMatrix4(inv).sub(o.clone().applyMatrix4(inv)); };
        defs.forEach(([n, x, y, z]) => { const l = loc(n, new THREE.Vector3(x, y, z)); if (l) FACE[n] = { smile: l, wink: null }; });
        // wink (her right eye): cheek rises into a squint, brow drops, corner lifts a touch more
        [['RightCheek', 0, 0.011, 0.002], ['RightBrowMid', 0, -0.008, 0], ['RightBrowInner', 0.002, -0.007, 0], ['RightBrowOuter', 0, -0.006, 0], ['RightMouthCorner', 0, 0.005, 0]].forEach(([n, x, y, z]) => { const l = loc(n, new THREE.Vector3(x, y, z)); if (l) { (FACE[n] = FACE[n] || { smile: null, wink: null }).wink = l; } });
      }
      const fs = { smile: 0, wink: 0, t0: -99, auto: 6 };   // t0 = when the last expression started; auto = next idle one
      const ease = k => { k = Math.max(0, Math.min(1, k)); return k * k * (3 - 2 * k); };
      const face = (t) => {
        // idle: a soft smile every ~12 s; with a wink in the middle about every third time
        if (t > fs.auto && fs.t0 < t - 5) { fs.t0 = t; fs.auto = t + 11 + Math.random() * 4; fs.wk = Math.random() < 0.45; }
        const u = t - fs.t0;
        let sm = ease(u / 0.9) * (1 - ease((u - 3.4) / 1.4)), wk = 0;
        if (fs.wk || fs.force) { const w = u - 1.3; wk = ease(w / 0.16) * (1 - ease((w - 0.55) / 0.22)); }
        if (MS._face) { sm = MS._face.smile; wk = MS._face.wink; }
        fs.smile = sm; fs.wink = wk;
        for (const n in FACE) { const bn = bones[n], r = rest[n], f = FACE[n]; if (!bn || !r) continue; bn.position.copy(r.p);
          if (f.smile) bn.position.addScaledVector(f.smile, sm * 1.5); if (f.wink) bn.position.addScaledVector(f.wink, wk * 2.2); }
      };
      const FOC = { phase: 0, t0: 0, from: 0, w: 0 };   // close-up reaction: 0 idle · 1 in · 2 hold · 3 out
      const headW = new THREE.Vector3(), closeP = new THREE.Vector3(), tgtW = new THREE.Vector3();
      // hands: roll each wrist so the palm lies DOWN on the leg with the thumb on the inside (the curl itself was set at rest)
      const _ha = new THREE.Vector3(), _hl = new THREE.Vector3(), _hn = new THREE.Vector3(), _ht = new THREE.Vector3(), _hp = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _DN = new THREE.Vector3(0, -1, 0);
      const handDown = (bones, side, k) => {
        if (!handDown._p) handDown._p = {};
        const H = bones[side + 'Hand'], M = bones[side + 'HandMiddle1'], I = bones[side + 'HandIndex1'], K = bones[side + 'HandPinky1']; if (!H || !M || !I || !K) return;
        H.updateWorldMatrix(true, true);
        H.getWorldPosition(_hp); M.getWorldPosition(_ha).sub(_hp).normalize(); I.getWorldPosition(_hl); K.getWorldPosition(_ht); _hl.sub(_ht).normalize();
        if (side === 'Left') _hn.crossVectors(_ha, _hl); else _hn.crossVectors(_hl, _ha); _hn.normalize().negate();   // (cross = back of hand; palm is opposite)
        _ht.copy(_DN).addScaledVector(_ha, -_ha.dot(_DN));
        if (_ht.lengthSq() < 1e-6) return; _ht.normalize();                 // down, flattened across the hand's own axis (skip a near-singular frame)
        _hl.crossVectors(_hn, _ht);
        let phi = Math.atan2(_ha.dot(_hl), _hn.dot(_ht)) * k;
        if (!isFinite(phi)) return;
        const key = side + 'Phi', prev = handDown._p[key];
        if (prev != null) { if (phi - prev > Math.PI) phi -= Math.PI * 2; else if (prev - phi > Math.PI) phi += Math.PI * 2; phi = prev + (phi - prev) * 0.28; }  // damp + unwrap: kills the wrist twitch
        handDown._p[key] = phi;
        _q1.setFromAxisAngle(_ha, Math.max(-2.2, Math.min(2.2, phi)));
        H.parent.getWorldQuaternion(_q2); H.quaternion.premultiply(_q2.clone().invert().multiply(_q1).multiply(_q2));
      };
      // (t1644u) the seated pose is per pilot: X = { holder, P (poser), bones, hipsRoot, ankleL/R, mir (+1 = Ariel's layout, -1 = mirrored for the pilot on
      // the other side of the rock), handDown, hands (idle-clip hand locals, optional) }.  Mirroring swaps which leg is up on the rock / which arm reaches and
      // negates every yaw / roll, so the second pilot sits as Ariel's mirror image and glances toward the camera from her side.
      const _mv = new THREE.Vector3(), _mv2 = new THREE.Vector3();
      const mirX = (v, m, out) => out.set(v.x * m, v.y, v.z);
      function poseSeated(X, t) {
        const P = X.P, bones = X.bones, holder = X.holder, m = X.mir || 1;
        const br = Math.sin(t * 1.35), br2 = Math.sin(t * 0.67 + 1.1);
        const rw = reachAt(t);
        // weight shift + hips (seat is fixed, tiny sway)
        Hp.copy(X.hipsRoot); Hp.x += 0.004 * Math.sin(t * 0.31) * m; Hp.y += 0.003 * br;
        tmpW.copy(Hp).applyMatrix4(holder.matrixWorld); const par = bones.Hips.parent; par.updateWorldMatrix(true, false); par.worldToLocal(tmpW); bones.Hips.position.copy(tmpW);
        P.rot('Hips', m * (8 + 1.5 * br2), 3 + 0.5 * br, m * 1.0 * br2);
        const lean = 6 + 2.2 * Math.sin(t * 0.21) - rw * 4, twist = 4 + 5 * Math.sin(t * 0.13) + rw * 8;   // toward the camera / menu
        P.rot('Spine02', m * (8 + twist * 0.25), 1 + lean * 0.3 + 0.6 * br, 0);
        P.rot('Spine01', m * (8 + twist * 0.5), 2 + lean * 0.55 + 0.8 * br, 0);
        P.rot('Spine', m * (8 + twist * 0.8), 3 + lean * 0.85 + 0.9 * br, 0);
        const sweep = Math.sin(t * 0.21) + 0.45 * Math.sin(t * 0.53 + 0.8), lookYaw0 = 12 + 17 * sweep + 4 * Math.sin(t * 1.1) - rw * 14, lookYaw = lookYaw0, lookPitch0 = -9 + 9 * Math.sin(t * 0.17 + 2.0) + 2.5 * Math.sin(t * 0.43) + 1.2 * br, lookPitch = lookPitch0;   // slow sweeps: away toward the menu / up at the stars / round to the camera
        P.rot('neck', m * (8 + lookYaw * 0.35), lookPitch * 0.4, m * 0.8 * Math.sin(t * 0.19));
        P.rot('Head', m * (8 + lookYaw * 0.9), lookPitch, m * 1.2 * Math.sin(t * 0.19 + 0.5));
        // legs: IK to planted feet, knee up on the near side (mirrored: the other leg is the one up on the rock)
        const legUp = m > 0 ? P.S.limb.legL : P.S.limb.legR, legDown = m > 0 ? P.S.limb.legR : P.S.limb.legL;
        P.leg(legUp, X.ankleUp, poleL, 1); P.rot(m > 0 ? 'LeftFoot' : 'RightFoot', 0, -10, 0);
        P.leg(legDown, X.ankleDown, poleR, 1); P.rot(m > 0 ? 'RightFoot' : 'LeftFoot', 0, -38, 0);
        // arms: far arm rests on the thigh, near arm on the knee → reaches toward the menu now and then
        const yaw = THREE.MathUtils.degToRad(m * (8 + twist * 0.8));
        const dir = (a, out) => out.copy(a).applyAxisAngle(P.Y, yaw);
        const sw = 0.012 * br;
        const upL = tmpA.copy(Rest.upL).lerp(Reach.upL, rw).normalize(), foL = tmpB.copy(Rest.foreL).lerp(Reach.foreL, rw).normalize();
        upL.y += sw; foL.y += sw * 0.5; upL.normalize(); foL.normalize();
        if (m > 0) {
          P.limb(P.S.limb.armL, dir(upL, P.S.v[17]), dir(foL, P.S.v[18]), 1, 0);
          P.limb(P.S.limb.armR, dir(Rest.upR, P.S.v[17]), dir(Rest.foreR, P.S.v[18]), 1, 0);
        } else {
          P.limb(P.S.limb.armR, dir(mirX(upL, -1, _mv), P.S.v[17]), dir(mirX(foL, -1, _mv2), P.S.v[18]), 1, 0);
          P.limb(P.S.limb.armL, dir(mirX(Rest.upR, -1, _mv), P.S.v[17]), dir(mirX(Rest.foreR, -1, _mv2), P.S.v[18]), 1, 0);
        }
        if (X.hands) { for (const n in X.hands) { const bn = bones[n]; if (bn) bn.quaternion.copy(X.hands[n]); } }
        else if (X.handDown !== false) { handDown(bones, 'Left', 1); handDown(bones, 'Right', 1); }
        return rw;
      }
      const A = { id: 'ariel', holder, root, bones, rest, C, P, hipsRoot, ankleUp: ankleL, ankleDown: ankleR, mir: 1, handDown: true, hair: null };
      if (hair) { bindSeatCols(A, hair); A.hair = hair; }
      const pose = (t) => poseSeated(A, t);
      pose(0); root.updateMatrixWorld(true);

      /* (t1644u) the second pilot (Emma) on the right half of the rock: her own GLB / rig / groom, the same seated poser mirrored (her right leg up on the
         rock, she glances toward the camera from her side).  Her hands use her idle clip's wrist + finger locals once her clips are in (see loadClips). */
      function buildCompanion(g, def) {
        const h = new THREE.Object3D(); scene.add(h);
        const r = g.scene; h.add(r);
        const bn = {}; r.traverse(o => { if (o.isBone) bn[o.name] = o; if (o.isSkinnedMesh || o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
        const rs = {}; Object.keys(bn).forEach(n => { const b = bn[n]; rs[n] = { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }; });
        const Cb = { root: r, bones: bn, rest: rs, mixer: new THREE.AnimationMixer(r) };
        const Pb = makePoser(THREE, Cb); if (!Pb.ready()) throw new Error('rig bones missing');
        Pb.fingers([22, 32, 17], { Index: 5, Middle: 0, Ring: -3, Pinky: -8 });
        h.rotation.y = Math.PI * 0.14;
        const seatX = 0.5, hr = new THREE.Vector3(0, 0.79, -0.02);   // her hips sit 1 cm lower than Ariel's
        const placeB = () => { h.updateMatrixWorld(true); const wp = h.localToWorld(hr.clone()); h.position.x += seatX - wp.x; h.position.z += 0 - wp.z;
          h.position.y += (surfY(seatX, 0, [boulder]) + 0.115) - wp.y; h.updateMatrixWorld(true); };
        placeB(); placeB();
        const toR = (wx, wz, lift) => { const y = Math.max(surfY(wx, wz, [boulder]), surfY(wx, wz, [ground])) + lift; return h.worldToLocal(new THREE.Vector3(wx, y, wz)); };
        const fw = (f, sd) => { const w = h.localToWorld(new THREE.Vector3(sd, 0, f)); return [w.x, w.z]; };
        const up = onRock(fw, 0.34, -0.14, toR, 0.095);   // her ankles are 9.5 cm (Ariel 10.5 with the shoe); both feet on the rock (see onRock)
        const dn = onRock(fw, 0.62, 0.16, toR, 0.095);
        const X = { id: def.id, def, holder: h, root: r, bones: bn, rest: rs, C: Cb, P: Pb, hipsRoot: hr, ankleUp: up, ankleDown: dn, mir: -1, handDown: false, hair: null };
        (async () => { try {
          const [mod, buf, cfg] = await Promise.all([import('../hair_strands.js'), fetch(def.hair.url).then(rr => { if (!rr.ok) throw new Error('hair ' + rr.status); return rr.arrayBuffer(); }),
            def.hair.configUrl ? fetch(def.hair.configUrl).then(rr => rr.ok ? rr.json() : null).catch(() => null) : Promise.resolve(null)]);
          if (MS.disposed || B !== X) return;
          X.hair = mod.buildHair({ root: r, bones: bn, mixer: Cb.mixer }, THREE, buf, { config: cfg || undefined, character: true, getStrandFraction: () => sc.hair, getGravityScale: () => 1, getCollisionTier: () => sc.hairTier, params: { windGust: 0.15 } });
          try { if (window.DMMenuWorld && DMMenuWorld.protectHair) DMMenuWorld.protectHair(r); } catch (e) {}
          bindSeatCols(X, X.hair); info('second pilot hair attached');
        } catch (e) { info('second pilot hair not attached:', e && e.message); } })();
        return X;
      }
      A.def = (window.DMChars && DMChars.get && DMChars.get('ariel')) || null;
      // each pilot's own walk / Mount_Step / idle clips for the duo launch, fetched in idle time once the scene is up (the game loads the chosen pilot's
      // clips from the same URL, so one of the two is usually a cache hit).  Until both are in, a press plays the single-pilot intro.
      const loadClips = async (X) => {
        if (!X || !X.def || X.clips || X._clipP) return X && X._clipP;
        X._clipP = gltfP(X.def.anims).then((ag) => {
          if (MS.disposed) return;
          const f = (n) => ag.animations.find((a) => a.name === n) || null, cm = X.def.clipMap || {};
          X.clips = { walk: f(cm.walk || 'Walking'), step: f(cm.step || 'Mount_Step'), idle: f((X.def.studio && X.def.studio.idle) || '') };
          if (X !== A && X.clips.idle) {   // her idle hands (wrist + fingers) for the seated pose too: the same pose her walk / run / ride carry
            const hands = {}; for (const tr of X.clips.idle.tracks) { const i = tr.name.lastIndexOf('.'), n = tr.name.slice(0, i); if (tr.name.slice(i + 1) !== 'quaternion' || !/^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)?\d?$/.test(n) || !X.bones[n]) continue;
              hands[n] = new THREE.Quaternion().fromArray(tr.createInterpolant().evaluate(0)); }
            X.hands = hands;
          }
        }).catch((e) => { info('clips for', X.id, 'failed:', e && e.message); });
        return X._clipP;
      };
      // mount Emma whenever her GLB lands (never in the middle of a launch: then she is simply left out and the single-pilot intro plays)
      pB.then((gB) => {
        if (MS.disposed) return;
        if (gB && !IN.on && !window.__JOTS_INTRO) {
          try { B = buildCompanion(gB, pBdef); poseSeated(B, 7.3); B.root.updateMatrixWorld(true); info('second pilot on the rock:', pBdef.name); } catch (e) { info('second pilot failed:', e && e.message); B = null; }
        }
        if (!B) { if (duoSeat && !IN.on) { duoWide = false; seatA(false); pose(t); root.updateMatrixWorld(true); fit(); } return; }
        setTimeout(() => { if (!MS.disposed) { loadClips(A); loadClips(B); } }, 2500);
      });
      // a first look at the hip pose so shoulders sit sensibly even before the first frame
      /* camera + render loop */
      const clock = new THREE.Clock(); let t = 0, last = performance.now(), ema = 16, adj = 0, menuT = -1, framesSeen = 0;
      // iOS reports the new size late after a rotation: refit now and again as it settles; the loop also refits whenever the canvas box differs from what was last applied
      let lw = 0, lh = 0, settle = [];
      const onResize = () => { fit(); lw = cv.clientWidth; lh = cv.clientHeight; settle.forEach(clearTimeout); settle = [120, 350, 800, 1600].map(ms => setTimeout(() => { if (!MS.disposed) { fit(); lw = cv.clientWidth; lh = cv.clientHeight; } }, ms)); adj = -120; ema = 16; };
      window.addEventListener('resize', onResize); window.addEventListener('orientationchange', onResize); if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
      fit();
      const par = { x: 0, y: 0, tx: 0, ty: 0 };
      const onPtr = (e) => { const p = e.touches ? e.touches[0] : e; if (!p) return; par.tx = (p.clientX / window.innerWidth - 0.5); par.ty = (p.clientY / window.innerHeight - 0.5); };
      window.addEventListener('pointermove', onPtr, { passive: true });
      const startFocus = () => { if (IN.on || window.__JOTS_INTRO) return; if (FOC.phase === 1 || FOC.phase === 2) { if (FOC.phase === 2) FOC.t0 = t; return; } FOC.from = FOC.w; FOC.phase = 1; FOC.t0 = t; };
      const okTarget = (el) => !(el && el.closest && el.closest('.mm-panel,button,a,input,select,textarea,.modal,.modal-box,#account-chip,[onclick]'));
      let gx = 0, gy = 0, gOk = false, gDone = false;
      const onDown = (e) => { const p = e.touches ? e.touches[0] : e; gx = p.clientX; gy = p.clientY; gOk = okTarget(e.target); gDone = false; };
      const onMove = (e) => { if (!gOk || gDone) return; const p = e.touches ? e.touches[0] : e; if (!p) return; if (Math.hypot(p.clientX - gx, p.clientY - gy) > 22 && (e.buttons || e.touches)) { gDone = true; startFocus(); } };
      const onUp = (e) => { if (gOk && !gDone && okTarget(e.target)) { gDone = true; startFocus(); } };
      window.addEventListener('pointerdown', onDown, { passive: true }); window.addEventListener('pointermove', onMove, { passive: true }); window.addEventListener('pointerup', onUp, { passive: true });
      /* launch intro (v151): her skyboard flies over, she steps up onto it and lifts off into space.
         The game hands in its own board mesh (her saved style) and its step + stance clips; nothing is shared back. */
      const IN = { on: false, t: 0, board: null };
      const introStart = (o) => {
        if (IN.on || !o || !o.board) return false;
        if (DUO_WANT && !o.solo && DUO_READY()) { try { return duoStart(o); } catch (e) { info('duo launch failed, single-pilot intro:', e && e.message); try { duoReset(); } catch (_) {} } }
        if (o.board2 && o.board2 !== o.board) { const b2 = o.board2; o.board2 = null; try { b2.traverse(m => { try { m.geometry && m.geometry.dispose(); } catch (e) {} (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => { if (!mt) return; if (!o.sharedTex2) for (const k in mt) { const v = mt[k]; if (v && v.isTexture) try { v.dispose(); } catch (e) {} } try { mt.dispose(); } catch (e) {} }); }); } catch (e) {} }   // the single-pilot intro: the companion's board is not used
        const b = o.board; const warm = (b === IN.parked && IN.warmed === b); if (b === IN.parked) IN.parked = null; b.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(b), sz = bb.getSize(new THREE.Vector3());
        // gameplay proportion: in flight she wears CHAR.scaleForBoard inside the board's frame, so board = her ÷ scaleForBoard (o.scale)
        holder.updateMatrixWorld(true); const hs = Math.abs(holder.getWorldScale(new THREE.Vector3()).x) || 1;
        // size from what's actually on screen: her bone-chain height here × the gameplay board:rider ratio (37 ft : 6 ft) over the
        // board's own world length. CHAR.scaleForBoard is measured in the board's LOCAL frame (GLB templates bake a ~0.08-0.1 node
        // scale), so 1/scaleForBoard × holder only matched the procedural board / pre-flight fallback; once flight init derived it
        // from a GLB board (iOS waits for flightInited in the hold) the intro board came out ~1/10 size.
        const herH = (() => { const v = (n) => bones[n] ? bones[n].getWorldPosition(new THREE.Vector3()) : null;
          root.updateMatrixWorld(true); const H = v('Hips'), Hd = v('Head'), U = v('LeftUpLeg'), K = v('LeftLeg'), F = v('LeftFoot');
          if (H && Hd && U && K && F) return (H.distanceTo(Hd) + U.distanceTo(K) + K.distanceTo(F)) * 1.1;
          const rs = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()); return isFinite(rs.y) ? rs.y : 0; })();
        const len0 = Math.max(sz.x, sz.z), ratio = o.ratio > 0 ? o.ratio : 37 / 6;
        const k = herH > 0.05 && len0 > 1e-4 ? herH * ratio / len0 : (o.scale > 0 ? Math.min(o.scale, 12) * hs : 1.6 / Math.max(0.2, len0));
        b.scale.multiplyScalar(k); IN.sizeK = k; IN._n = 0; IN._s = 0; MS.half = false; IN.herH = herH; IN.bScale = b.scale.clone();   // re-asserted every frame (a later heal/reset can't shrink it)
        b.traverse(m => { if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
        b.updateMatrixWorld(true); const bl = new THREE.Box3().setFromObject(b).getSize(new THREE.Vector3());
        const Lb = Math.max(bl.x, bl.z); IN.Lb = Lb; const Wb = Math.max(0.3, Math.min(bl.x, bl.z));
        const rb = new THREE.Box3().setFromObject(boulder);
        // (menu-perf) the highest surface anywhere in the scene (rock top / ground bounds): a board whose lowest footprint point is above it
        // cannot touch anything, so the per-frame collision lift (up to 169 raycasts per patch rebuild) is skipped in flight
        IN.yClear = Math.max(rb.max.y, new THREE.Box3().setFromObject(ground).max.y) + 0.05;
        const gY = surfY(rb.min.x - 3, 0, [ground]);
        // parked to the rock's left, nose toward the viewer, its nose end level with the rock's front: it pulls up from behind
        const N = new THREE.Vector3(0.12, 0, 1).normalize();
        IN.phi = Math.atan2(-N.z, N.x);
        // v176: the board model's nose is its local -X, so every pose below is turned 180 deg about the board's own up (same path,
        // same bank/pitch): the nose now leads the fly-in, points at the viewer when parked, and she steps on facing it
        IN.qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        // place from its real bounds at the parked pose (GLB pivots aren't centred): right side 0.7 m off the rock, nose end level with the rock's front
        const H = new THREE.Vector3(0, gY + 0.32, 0); b.position.copy(H); b.rotation.set(0, IN.phi, 0); b.quaternion.multiply(IN.qFlip); b.updateMatrixWorld(true);
        const a = b.userData.deckAnchor || { x: 0, y: 0, z: 0 };
        const pb = new THREE.Box3().setFromObject(b), ac = b.localToWorld(new THREE.Vector3(a.x, a.y, a.z));
        H.x += (rb.min.x - 0.7) - pb.max.x; H.z += (rb.min.z + rb.max.z) * 0.5 - ac.z;   // beside the rock: deck centre level with the rock's middle
        IN.H = H; IN.N = N; IN.rideYaw = Math.atan2(N.x, N.z) + (o.yawOff || 0);
        // flight: in from the front-right high, sweep across in front of the rock, swing round behind, then straight up the line to the stop
        IN.P0 = new THREE.Vector3(9, 5, -6); IN.P1 = new THREE.Vector3(2.5, 2.4, 3.5);
        IN.P2 = new THREE.Vector3(H.x - Lb * 0.8, 2.0, H.z - Lb * 1.6); IN.P3 = H.clone().addScaledVector(N, -Lb * 1.1); IN.P3.y += 0.5;
        IN.L = new THREE.Vector3(0, 1, 0).addScaledVector(N, -0.35).normalize();
        // where she boards: the deck beside the rock (local point under world z≈0 at the final pose)
        b.position.copy(H); b.rotation.set(0, IN.phi, 0); b.quaternion.multiply(IN.qFlip); b.updateMatrixWorld(true); pb.setFromObject(b);
        IN.Dl = new THREE.Vector3(a.x, a.y, a.z);                       // she boards and rides on the deck centre
        ac.set(a.x, a.y, a.z); b.localToWorld(ac);
        IN.W = new THREE.Vector3(pb.max.x + 0.3, 0, ac.z);
        IN.W.y = surfY(IN.W.x, IN.W.z);
        // v176: fine local collision patch under the board (rock + ground resampled at ~1/8 board length) so it never dips into them
        if (window.DMLocalCollide && !IN.lc) { const o6 = new THREE.Vector3(), tg = [boulder, ground], hs6 = [];
          IN.lc = DMLocalCollide.create(THREE, { n: 12, sample: (x, z) => { o6.set(x, 8, z); ray.set(o6, down); hs6.length = 0; ray.intersectObjects(tg, false, hs6); return hs6.length ? hs6[0].point.y : NaN; } }); }
        if (IN.lc) { IN.lc.setCell(Lb / 8); const q0 = b.quaternion.clone(), p0 = b.position.clone(); b.position.set(0, 0, 0); b.quaternion.identity(); IN.lc.footprint(b); b.position.copy(p0); b.quaternion.copy(q0); b.updateMatrixWorld(true); }
        IN.D = new THREE.Vector3(); IN.F = new THREE.Vector3(); IN.FT = new THREE.Vector3(); IN.rel = null; IN.tmp = new THREE.Vector3(); IN.qa = new THREE.Quaternion(); IN.qb = new THREE.Quaternion();
        IN.seatPos = holder.position.clone(); IN.seatQ = holder.quaternion.clone(); IN.rideQ = new THREE.Quaternion().setFromAxisAngle(P.Y, IN.rideYaw);
        // feet start under her seat (world), walk to W
        IN.S0 = new THREE.Vector3(SEAT_X + 0.35, 0, 0.35); IN.S0.y = surfY(IN.S0.x, IN.S0.z);
        const wd = IN.W.clone().sub(IN.S0).setY(0); IN.walkQ = new THREE.Quaternion().setFromAxisAngle(P.Y, Math.atan2(wd.x, wd.z));
        // (choreography) slow and natural: the board glides in (3.6 s) while she is still on the rock; she gets up over ~1.5 s, walks at ~1 m/s, steps on,
        // settles into the standing ride over ~1.4 s, and only then departs (see introPre / DMLaunch.departure)
        IN.T_FLY = 3.6; IN.T_WALK = 3.0; IN.walkDur = Math.max(1.8, Math.min(4.5, wd.length() / 1.0));
        // the rebaked Mount_Step clip (~1.15 s) plays at ~1x: the step window follows the clip instead of squeezing it
        IN.stepDur = o.jump ? Math.max(0.62, Math.min(1.1, o.jump.duration * 0.88)) : 0.62;
        IN.T_STAND = 1.5; IN.T_STEP = IN.T_WALK + IN.T_STAND + IN.walkDur; IN.T_LAND = IN.T_STEP + IN.stepDur; IN.T_LIFT = IN.T_LAND + 1.4;
        IN.T_DEP = 9; IN.Ls = Math.min(Math.max(camBase.z, 3), 6.5);
        IN.dep = (window.DMLaunch && window.DMLaunch.departure) ? window.DMLaunch.departure({ L: IN.Ls, psi0: IN.phi, theta: -2.9, T: IN.T_DEP, vmax: 2.2 * IN.Ls, gmax: 0.3, bank: 0.42 }) : null;
        b.rotation.order = 'YZX';   // yaw, then pitch about the board's own lateral axis, then bank about its own nose axis
        IN.list = Object.keys(bones).map(n => bones[n]); IN.sq = IN.list.map(bn => bn.quaternion.clone()); IN.sp = IN.list.map(bn => bn.position.clone());
        IN.keep = IN.list.map(bn => [bn.position.clone(), bn.quaternion.clone()]);
        IN.walk = o.walk ? C.mixer.clipAction(o.walk) : null;
        IN.jump = o.jump ? C.mixer.clipAction(o.jump) : null; IN.ride = o.ride ? C.mixer.clipAction(o.ride) : null;
        if (IN.jump) { IN.jump.setLoop(THREE.LoopOnce, 1); IN.jump.clampWhenFinished = true; IN.jump.timeScale = Math.max(0.6, Math.min(2.4, o.jump.duration / (IN.stepDur * 1.15))); }
        IN.sharedTex = !!o.sharedTex; IN.onFly = o.onFlyOff; IN.flew = false; IN.t = 0; IN.w = 0; IN.walked = IN.jumped = IN.rode = false; IN.lockM = null; IN.lift = false;
        b.position.copy(IN.P0); b.visible = false; scene.add(b); IN.board = b;
        // (menu-perf) compileAsync collects only VISIBLE objects: with the board hidden (as it was) nothing of it was compiled and its pipelines
        // were built on the first real draw, i.e. the first fly-in frames. Visible for the synchronous collect only (nothing draws in between),
        // hidden again at once; when introPrecompile already did this during the loader hold, this is a cache hit.
        // (launch) when the idle-time precompile already finished for this very board (introPrecompile: pipelines, buffers, textures, bind groups,
        // two real frames), nothing is left to compile: the fly-out starts THIS frame instead of after another compile round-trip
        if (warm) { IN.warmed = null; b.visible = true; IN.on = true; clearAllSeatCols(); return Promise.resolve(true); }
        let pc = null; b.visible = true; try { pc = renderer.compileAsync(scene, camera); } catch (e) { pc = null; } finally { b.visible = false; }
        return Promise.resolve(pc).catch(() => {}).then(() => { if (!IN.board) return; b.visible = true; IN.on = true; clearAllSeatCols(); });
      };
      /* ───────────── (t1644u) DUO launch: both pilots, both boards, then the interstellar cargo-bay arrival ─────────────
         Timeline (s, intro clock): 0-3.4 the two boards come in from behind the camera, one past each side of the rock, and settle hovering behind it; each
         pilot's head follows HER board as it passes (Ariel looks left, Emma right) · ~3 both rise off the rock · each walks round her side of the rock to her
         board · Mount_Step onto the deck · the STANDING skyboard stance (index.html BOARD_STANCE solved on her own rig + her DMChars stance overrides; never the
         seated pose) · both lift off together toward the horizon while the camera pans up after them · warp flash · the cargo bay: both fly in through the lit
         bay doors and settle over the deck · onFlyOff (index.html fades to the loader / the game with the chosen pilot).  Tap-to-skip stays index.html's.
         Per-frame work reuses preallocated vectors / quaternions and clip interpolants; everything is built in duoStart.  ?intro=solo = the v151 intro. */
      const BS_FALLBACK = { hips: [0.0, 0.93, -0.04], ankleL: [0.07, 0.128, -0.37], ankleR: [-0.04, 0.128, 0.28], yawHips: 80, pitchHips: 5, yawChest: -15, pitchChest: 3, yawHead: -45, pitchHead: -4,
        footYawL: 95, footYawR: 45, kneeOut: 0.25, upL: [0.636, -0.711, -0.3], foreL: [0.438, -0.852, -0.286], proL: -19, upR: [-0.601, -0.654, 0.46], foreR: [-0.389, -0.753, 0.531], proR: 60, wristShare: 0.7,
        sway: { shift: 0.020, side: 0.010, bob: 0.010, roll: 2.6, yaw: 2.0, chest: 0.75, arm: 5.0, periods: [4.3, 5.9, 3.7, 6.6] } };
      const BS_FWD = [0, 0, 1];
      let DU = null;
      const _dq = { q: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(), v: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), d1: new THREE.Vector3(), d2: new THREE.Vector3(), d3: new THREE.Vector3(), t: new THREE.Vector3(), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1), m: new THREE.Matrix4(), s: new THREE.Vector3() };
      const DUO_READY = () => !!(B && A.clips && B.clips && A.clips.walk && B.clips.walk && A.clips.step && B.clips.step && qs('intro', '') !== 'solo');
      // clip sampler: evaluates a clip's tracks at a time and writes them over the current pose with weight w (no AnimationMixer: three's PropertyMixer skips
      // a track whose mixed value did not change, which would leave the seated pose under Emma's constant hand tracks)
      function mkSampler(clip, bones) {
        const tr = [];
        for (const t of clip.tracks) { const i = t.name.lastIndexOf('.'), bn = bones[t.name.slice(0, i)], pr = t.name.slice(i + 1); if (!bn) continue;
          if (pr === 'quaternion') tr.push({ bn, q: 1, it: t.createInterpolant() }); else if (pr === 'position' && bn.name === 'Hips') tr.push({ bn, q: 0, it: t.createInterpolant() }); }
        return { dur: clip.duration, apply(time, w) {
          if (w <= 0.001) return; const tt = ((time % clip.duration) + clip.duration) % clip.duration;
          for (let i = 0; i < tr.length; i++) { const e = tr[i], r = e.it.evaluate(tt);
            if (e.q) { _dq.q.fromArray(r); if (w >= 0.999) e.bn.quaternion.copy(_dq.q); else e.bn.quaternion.slerp(_dq.q, w); }
            else { _dq.v.fromArray(r); if (w >= 0.999) e.bn.position.copy(_dq.v); else e.bn.position.lerp(_dq.v, w); } } },
          applyClamped(time, w) { this.apply(Math.min(Math.max(0, time), clip.duration - 1e-4), w); } };
      }
      // the standing skyboard stance on a menu rig (port of index.html _boardStancePose onto makePoser; BOARD_STANCE is read live, the pilot's DMChars
      // `stance` overrides layered on top: Emma's own hip / ankle heights)
      function stanceParams(X) { const base = window.BOARD_STANCE || BS_FALLBACK, o = X.def && X.def.stance, out = X.bsP || (X.bsP = {}); for (const k in base) out[k] = base[k]; if (o) for (const k in o) out[k] = o[k]; if (!out.sway) out.sway = BS_FALLBACK.sway; return out; }
      const bsDir = (out, a, yaw, roll) => { out.set(a[0], a[1], a[2]); if (roll) out.applyAxisAngle(_dq.Z, roll * Math.PI / 180); return out.applyAxisAngle(_dq.Y, yaw * Math.PI / 180).normalize(); };
      const bsPro = (d) => Math.max(-60, Math.min(60, d || 0)) * Math.PI / 180;
      function standPose(X, t, w) {
        if (w <= 0.001) return;
        const P = X.P, S = P.S, b = X.bones, Bp = stanceParams(X), Wd = Bp.sway, Pd = Wd.periods || BS_FALLBACK.sway.periods, T2 = Math.PI * 2, ws = Math.max(0, Math.min(0.8, Bp.wristShare || 0));
        const s1 = Math.sin(T2 * t / Pd[0]), s2 = Math.sin(T2 * t / Pd[1] + 1.3), s3 = Math.sin(T2 * t / Pd[2] + 0.4), s4 = Math.sin(T2 * t / Pd[3] + 2.1);
        const roll = Wd.roll * s1, yaw = Wd.yaw * s4;
        _dq.t.set(Bp.hips[0] + Wd.side * s2, Bp.hips[1] - Wd.bob * (0.5 + 0.5 * s3), Bp.hips[2] + Wd.shift * s1);
        if (w >= 0.999) b.Hips.position.copy(_dq.t); else b.Hips.position.lerp(_dq.t, w);
        const yH = Bp.yawHips + yaw; P.rot('Hips', yH, Bp.pitchHips, roll, w);
        const cr = -roll * Wd.chest, cy = -yaw * Wd.chest;
        P.rot('Spine02', yH + cy / 3 + Bp.yawChest / 3, Bp.pitchHips + Bp.pitchChest / 3, roll + cr / 3, w);
        P.rot('Spine01', yH + cy * 2 / 3 + Bp.yawChest * 2 / 3, Bp.pitchHips + Bp.pitchChest * 2 / 3, roll + cr * 2 / 3, w);
        P.rot('Spine', yH + cy + Bp.yawChest, Bp.pitchHips + Bp.pitchChest, roll + cr, w);
        const yC = Bp.yawHips + Bp.yawChest;
        P.rot('neck', yC + Bp.yawHead * 0.4, (Bp.pitchHips + Bp.pitchChest) * 0.3 + Bp.pitchHead * 0.4, 0, w);
        P.rot('Head', yC + Bp.yawHead, Bp.pitchHead, 0, w);
        const ya = yH + cy + Bp.yawChest, ar = -roll * Wd.arm / Wd.roll * 0.5, sw2 = Wd.arm * 0.4 * s2;
        P.limb(S.limb.armL, bsDir(_dq.d1, Bp.upL, ya + sw2, ar), bsDir(_dq.d2, Bp.foreL, ya + sw2, ar), w, bsPro(Bp.proL) * (1 - ws));
        P.limb(S.limb.armR, bsDir(_dq.d1, Bp.upR, ya + sw2, ar), bsDir(_dq.d2, Bp.foreR, ya + sw2, ar), w, -bsPro(Bp.proR) * (1 - ws));
        const pole = bsDir(_dq.d3, BS_FWD, Bp.yawHips, 0);
        pole.z -= Bp.kneeOut; P.leg(S.limb.legL, _dq.t.set(Bp.ankleL[0], Bp.ankleL[1], Bp.ankleL[2]), pole, w); P.rot('LeftFoot', Bp.footYawL, 0, 0, w);
        pole.z += 2 * Bp.kneeOut; P.leg(S.limb.legR, _dq.t.set(Bp.ankleR[0], Bp.ankleR[1], Bp.ankleR[2]), pole, w); P.rot('RightFoot', Bp.footYawR, 0, 0, w);
      }
      // her head (and neck) follow a world point: yaw about world up, clamped to ±75°, split neck 40 % / head 60 %, weight w; idempotent (the pose under it is
      // re-solved every frame, nothing accumulates)
      const _lq = { pw: new THREE.Quaternion(), pi: new THREE.Quaternion(), r: new THREE.Quaternion(), hw: new THREE.Quaternion(), h: new THREE.Vector3(), f: new THREE.Vector3() };
      function yawBoneWorld(bone, ang) { bone.parent.getWorldQuaternion(_lq.pw); _lq.pi.copy(_lq.pw).invert(); _lq.r.setFromAxisAngle(_dq.Y, ang); bone.quaternion.premultiply(_lq.pw).premultiply(_lq.r).premultiply(_lq.pi); bone.updateMatrixWorld(true); }
      function lookAtPoint(X, target, w) {
        const H = X.bones.Head, N = X.bones.neck; if (!H || w <= 0.001 || !X.headFwd) return;
        X.root.updateMatrixWorld(true); H.getWorldPosition(_lq.h); H.getWorldQuaternion(_lq.hw);
        _lq.f.copy(X.headFwd).applyQuaternion(_lq.hw);
        let err = Math.atan2(target.x - _lq.h.x, target.z - _lq.h.z) - Math.atan2(_lq.f.x, _lq.f.z); err = Math.atan2(Math.sin(err), Math.cos(err));
        err = Math.max(-1.31, Math.min(1.31, err)) * w;
        if (N) yawBoneWorld(N, err * 0.4); yawBoneWorld(H, N ? err * 0.6 : err);
      }
      function headForward(X) {   // head-local forward = her rest +z (root) through the rest chain of the Head bone
        const R = X.rest, q = new THREE.Quaternion(); let o = X.bones.Head; if (!o) return null;
        q.identity(); const chain = []; while (o && o !== X.root) { chain.push(o); o = o.parent; }
        for (let i = chain.length - 1; i >= 0; i--) q.multiply(R[chain[i].name] ? R[chain[i].name].q : chain[i].quaternion);
        return new THREE.Vector3(0, 0, 1).applyQuaternion(q.invert()).normalize();
      }
      const boardQ = (N, out) => { out.setFromAxisAngle(_dq.Y, Math.atan2(-N.z, N.x)); return out.multiply(IN.qFlip); };
      const smoothE = (a, b, x) => smooth(a, b, x);
      // the cargo bay: one procedural hangar (deck, ribbed walls, light strips, landing chevrons, door frame + force field, a planet and stars outside), lit with
      // the SAME light types / counts as the rock scene (hemi, shadowed spot, 3 directional, 2 point; exp fog) so the pilots' and boards' pipelines carry over
      function buildBay(Lb, Wb) {
        const S = new THREE.Scene(); S.fog = new THREE.FogExp2(0x05070c, 0.004);
        const Lz = Math.max(26, Lb * 3.2), Wx = Math.max(14, Wb * 2 + Lb * 0.9), Hy = Math.max(8, Lb * 0.8), owned = [];
        const own = (o) => { owned.push(o); return o; };
        const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
          g.fillStyle = '#23272e'; g.fillRect(0, 0, 256, 256); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const v = 32 + ((i * 7 + j * 13) % 5) * 4; g.fillStyle = 'rgb(' + v + ',' + (v + 3) + ',' + (v + 8) + ')'; g.fillRect(i * 64 + 2, j * 64 + 2, 60, 60); }
          g.strokeStyle = '#0e1014'; g.lineWidth = 3; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 256); g.stroke(); g.beginPath(); g.moveTo(0, i * 64); g.lineTo(256, i * 64); g.stroke(); }
          const t = own(new THREE.CanvasTexture(c)); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; })();
        const deckT = tex.clone(); deckT.repeat.set(Wx / 4, Lz / 4); deckT.needsUpdate = true; own(deckT);
        const wallT = tex.clone(); wallT.repeat.set(Lz / 6, Hy / 6); wallT.needsUpdate = true; own(wallT);
        const metal = own(new THREE.MeshStandardMaterial({ color: 0x9aa3ad, map: deckT, metalness: 0.55, roughness: 0.42 }));
        const wallM = own(new THREE.MeshStandardMaterial({ color: 0x5d6672, map: wallT, metalness: 0.55, roughness: 0.6 }));
        const deck = new THREE.Mesh(own(new THREE.PlaneGeometry(Wx, Lz)), metal); deck.rotation.x = -Math.PI / 2; deck.receiveShadow = true; S.add(deck);
        const box = own(new THREE.BoxGeometry(1, 1, 1));
        const wall = (x, y, z, sx, sy, sz) => { const m = new THREE.Mesh(box, wallM); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.receiveShadow = true; S.add(m); return m; };
        wall(-Wx / 2 - 0.3, Hy / 2, 0, 0.6, Hy, Lz); wall(Wx / 2 + 0.3, Hy / 2, 0, 0.6, Hy, Lz); wall(0, Hy + 0.3, 0, Wx + 1.2, 0.6, Lz); wall(0, Hy / 2, Lz / 2 + 0.3, Wx + 1.2, Hy, 0.6);
        // ribs: columns on both walls + ceiling beams
        const NR = 9, ribM = own(new THREE.MeshStandardMaterial({ color: 0x5b636e, metalness: 0.7, roughness: 0.35 })), ribs = new THREE.InstancedMesh(box, ribM, NR * 3), dm = new THREE.Object3D();
        for (let i = 0; i < NR; i++) { const z = -Lz / 2 + (i + 0.5) * Lz / NR;
          dm.position.set(-Wx / 2 + 0.2, Hy / 2, z); dm.scale.set(0.5, Hy, 0.6); dm.updateMatrix(); ribs.setMatrixAt(i * 3, dm.matrix);
          dm.position.set(Wx / 2 - 0.2, Hy / 2, z); dm.updateMatrix(); ribs.setMatrixAt(i * 3 + 1, dm.matrix);
          dm.position.set(0, Hy - 0.25, z); dm.scale.set(Wx, 0.5, 0.6); dm.updateMatrix(); ribs.setMatrixAt(i * 3 + 2, dm.matrix); }
        ribs.instanceMatrix.needsUpdate = true; ribs.castShadow = false; ribs.receiveShadow = true; S.add(ribs);
        // light strips (unlit, toned bright): ceiling edges + deck edges, and the landing chevrons (pulse toward the pads)
        const stripM = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.85, 1.0).multiplyScalar(2.2), fog: false }));
        const strips = new THREE.InstancedMesh(box, stripM, 4);
        [[-Wx / 2 + 0.55, Hy - 0.6], [Wx / 2 - 0.55, Hy - 0.6], [-Wx / 2 + 0.6, 0.04], [Wx / 2 - 0.6, 0.04]].forEach(([x, y], i) => { dm.position.set(x, y, 0); dm.scale.set(0.08, 0.05, Lz * 0.98); dm.updateMatrix(); strips.setMatrixAt(i, dm.matrix); });
        strips.instanceMatrix.needsUpdate = true; S.add(strips);
        const chevM = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.55, 0.12), fog: false })), NC = 7, chev = new THREE.InstancedMesh(box, chevM, NC * 2);
        for (let i = 0; i < NC; i++) for (let s2 = 0; s2 < 2; s2++) { dm.position.set((s2 ? 1 : -1) * 0.7, 0.012, -Lz / 2 + 2 + i * (Lz * 0.45 / NC)); dm.rotation.set(0, (s2 ? -1 : 1) * 0.6, 0); dm.scale.set(1.3, 0.02, 0.18); dm.updateMatrix(); chev.setMatrixAt(i * 2 + s2, dm.matrix); }
        chev.instanceMatrix.needsUpdate = true; dm.rotation.set(0, 0, 0); S.add(chev);
        // door frame (amber) + force field
        const frameM = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.62, 0.2).multiplyScalar(1.6), fog: false }));
        [[-Wx / 2, Hy / 2, 0.25, Hy], [Wx / 2, Hy / 2, 0.25, Hy], [0, Hy, Wx, 0.25], [0, 0.02, Wx, 0.1]].forEach(([x, y, sx, sy]) => { const m = new THREE.Mesh(box, frameM); m.position.set(x, y, -Lz / 2); m.scale.set(sx, sy, 0.3); S.add(m); });
        const field = null, fieldM = null;   // no 2D force-field / gradient plane over the opening
        // light shafts under the ceiling lamps (additive cones)
        const shaftM = own(new THREE.MeshBasicMaterial({ color: 0xbfe4ff, transparent: true, opacity: 0.028, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
        const cone = own(new THREE.ConeGeometry(Wx * 0.16, Hy * 0.95, 24, 1, true)); cone.translate(0, -Hy * 0.475, 0);
        for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(cone, shaftM); m.position.set((i % 2 ? 1 : -1) * Wx * 0.22, Hy - 0.5, -Lz * 0.22 + Math.floor(i / 2) * Lz * 0.3); m.renderOrder = 2; S.add(m); }
        // outside: stars + a lit planet below the door line
        const NS = lowTier ? 900 : 1800, sp = new Float32Array(NS * 3); for (let i = 0; i < NS; i++) { const u = Math.random() * 2 - 1, a = Math.random() * 6.283, r = 260, q = Math.sqrt(1 - u * u); sp[i * 3] = r * q * Math.cos(a); sp[i * 3 + 1] = r * u; sp[i * 3 + 2] = -Math.abs(r * q * Math.sin(a)) - Lz; }
        const sg = own(new THREE.BufferGeometry()); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
        S.add(new THREE.Points(sg, own(new THREE.PointsMaterial({ size: 1.1, color: 0xdfe8ff, sizeAttenuation: true, fog: false, depthWrite: false }))));
        let planet = null, solenne = null;
        try {
          const MW = window.DMMenuWorld;
          if (MW && MW.buildSolenne && THREE.TSL) {
            const tName = (MW.tier && MW.tier().name) || (lowTier ? 'low' : 'high');
            solenne = MW.buildSolenne(THREE, { r: 96, position: [-70, -78, -Lz / 2 - 170], seg: tName === 'low' ? 48 : tName === 'mid' ? 56 : 128, oct: tName === 'low' ? 4 : tName === 'mid' ? 5 : 7, cloudOct: tName === 'low' ? 2 : tName === 'mid' ? 3 : 5, sun: [-0.52, 0.32, -0.78] });
            if (solenne && solenne.group) { S.add(solenne.group); planet = solenne.sky && solenne.sky.planet; (solenne.owned || []).forEach(own); }
          }
        } catch (e) { info('solenne failed', e && e.message); }
        if (!planet) {
          planet = new THREE.Mesh(own(new THREE.SphereGeometry(96, 96, 72)), own(new THREE.MeshStandardMaterial({ color: 0x2a6a4a, roughness: 0.86, metalness: 0, emissive: 0x041018, emissiveIntensity: 0.25, fog: false })));
          planet.position.set(-70, -78, -Lz / 2 - 170); S.add(planet);
        }
        // lights (same rig types as the rock scene)
        const hemi2 = new THREE.HemisphereLight(0x8fb4ff, 0x20242c, 0.38); S.add(hemi2);
        const spot2 = new THREE.SpotLight(0xfff2dc, 18, Hy * 3.2, 0.58, 0.75, 1.4); spot2.position.set(0, Hy - 0.4, -Lz * 0.06); spot2.target.position.set(0, 0, -Lz * 0.08);
        spot2.castShadow = true; spot2.shadow.mapSize.set(sc.shadow, sc.shadow); spot2.shadow.bias = -0.0004; spot2.shadow.normalBias = 0.025; spot2.shadow.camera.near = 1; spot2.shadow.camera.far = Hy * 3; S.add(spot2, spot2.target);
        const sun2 = new THREE.DirectionalLight(0xfff0dc, 0.55); sun2.position.set(-30, 20, -80); S.add(sun2);
        const fill2 = new THREE.DirectionalLight(0x9cc8ff, 0.28); fill2.position.set(4, 6, 20); S.add(fill2);
        const bnc2 = new THREE.DirectionalLight(0xffa860, 0.35); bnc2.position.set(0, -2, 4); S.add(bnc2);
        const pA = new THREE.PointLight(0x7fd0ff, 6, Lz * 0.5, 1.8), pB2 = new THREE.PointLight(0xffb070, 14, Lz * 0.5, 1.6);
        pA.position.set(0, Hy * 0.85, 0); pB2.position.set(0, 1.2, -Lz / 2 + 0.6); S.add(pA, pB2);
        // swap the box hangar for the Blender-built PBR bay when it is already in memory (graceful no-op if the GLB is missing / still loading)
        const mountG = () => {
          try {
            const MW = window.DMMenuWorld; if (!MW || !MW.instanceBay || !MW._bayGltf) return null;
            const inst = MW.instanceBay(THREE, 'launch', { w: Wx, d: Lz, h: Hy, openZ: -Lz / 2 }); if (!inst) return null;
            MW.setBayDoors(inst, 0); S.add(inst);
            [deck, ribs, strips, chev].forEach((o) => { if (o) o.visible = false; });
            S.traverse((o) => { if (o.isMesh && (o.material === wallM || o.material === metal || o.material === ribM || o.material === stripM)) o.visible = false; });
            const hooks = [], shafts = []; inst.updateMatrixWorld(true);
            inst.traverse((o) => { if (/^Light_\d+/.test(o.name)) hooks.push(o); });
            S.traverse((o) => { if (o.isMesh && o.material === shaftM) shafts.push(o); });
            hooks.forEach((h, i) => { if (!shafts[i]) return; const wp = new THREE.Vector3(); h.getWorldPosition(wp); shafts[i].position.copy(wp); });
            return inst;
          } catch (e) { info('bay glb mount failed:', e && e.message); return null; }
        };
        let glbBay = mountG();
        if (!glbBay && window.DMMenuWorld && window.DMMenuWorld.loadBayGLB) {
          try { window.DMMenuWorld.loadBayGLB(THREE).then(() => { if (MS.disposed) return; if (!glbBay) glbBay = mountG(); }); } catch (e) { }
        }
        const cam = new THREE.PerspectiveCamera(42, camera.aspect, 0.1, 900);
        const deckY = 0;
        return { scene: S, cam, Lz, Wx, Hy, deckY, field, chevM, fieldM, owned, planet, solenne, glb: () => glbBay,
          tick(t) { const k = 0.6 + 0.4 * Math.max(0, Math.sin(t * 5.0)); chevM.color.setRGB(1.0 * k, 0.55 * k, 0.12 * k); if (solenne && solenne.update) { solenne.update(t); if (solenne.sync) solenne.sync(); } else if (planet) planet.rotation.y += 0.0004; },
          dispose() { owned.forEach(o => { try { o.dispose(); } catch (e) {} }); try { ribs.dispose(); strips.dispose(); chev.dispose(); } catch (e) {} } };
      }
      const duoStart = (o) => {
        const now0 = performance.now();
        const ratio = o.ratio > 0 ? o.ratio : 37 / 6, pilot = o.pilot === 'emma' ? 'emma' : 'ariel';
        const bA = pilot === 'ariel' ? o.board : (o.board2 || null), bB = pilot === 'emma' ? o.board : (o.board2 || null);
        const shareA = pilot === 'ariel' ? !!o.sharedTex : !!o.sharedTex2, shareB = pilot === 'emma' ? !!o.sharedTex : !!o.sharedTex2;
        const clone = (b) => { const c = b.clone(true); c.userData = Object.assign({}, b.userData, { duoClone: true }); return c; };   // no companion board handed in: a clone of hers (shares geometry / materials; never disposed)
        const boards = [bA || clone(bB || o.board), bB || clone(bA || o.board)];
        if (o.board === IN.parked) IN.parked = null; if (IN.warmed === o.board) IN.warmed = null;
        IN.qFlip = IN.qFlip || new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        const rb = new THREE.Box3().setFromObject(boulder), gY = surfY(rb.min.x - 3, 0, [ground]);
        IN.yClear = Math.max(rb.max.y, new THREE.Box3().setFromObject(ground).max.y) + 0.05;
        DU = { _bb: new THREE.Box3(), rb: rb.clone(), t: 0, P: [], boards, share: [shareA, shareB], inBay: false, bay: null, flew: false, warp: null, scene, camLook: new THREE.Vector3().copy(TARGET), camPos: new THREE.Vector3(), mid: new THREE.Vector3(), Hmid: new THREE.Vector3() };
        const NOSE = new THREE.Vector3(0, 0, -1), rideYaw = Math.atan2(NOSE.x, NOSE.z);
        [A, B].forEach((X, i) => {
          const side = i === 0 ? -1 : 1, b = boards[i], d = {};
          X.headFwd = X.headFwd || headForward(X);
          X.root.updateMatrixWorld(true);
          // board size from what is on screen: her bone-chain height x the gameplay board:rider ratio over the board's own world length (as the v151 intro)
          b.updateMatrixWorld(true); const len0 = (() => { const sz = new THREE.Box3().setFromObject(b).getSize(new THREE.Vector3()); return Math.max(sz.x, sz.z); })();
          const herH = (() => { const v = (n) => X.bones[n] ? X.bones[n].getWorldPosition(new THREE.Vector3()) : null; const H = v('Hips'), Hd = v('Head'), U = v('LeftUpLeg'), K = v('LeftLeg'), F = v('LeftFoot');
            return (H && Hd && U && K && F) ? (H.distanceTo(Hd) + U.distanceTo(K) + K.distanceTo(F)) * 1.1 : 1.6; })();
          const k = len0 > 1e-4 ? herH * ratio / len0 : 1; b.scale.multiplyScalar(k); d.bScale = b.scale.clone();
          b.traverse(m => { if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
          b.rotation.order = 'XYZ'; boardQ(NOSE, b.quaternion); b.position.set(0, gY + 0.32, 0); b.updateMatrixWorld(true);
          let pb = new THREE.Box3().setFromObject(b); const sz = pb.getSize(new THREE.Vector3()), Lb = Math.max(sz.x, sz.z), Wb = Math.max(0.3, Math.min(sz.x, sz.z)); d.Lb = Lb; d.Wb = Wb;
          const edge = side < 0 ? rb.min.x : rb.max.x, lane = edge + side * 0.38;
          // parked: beside her side of the rock, behind it, nose away (toward the horizon), tail end just behind the rock's back
          b.position.x += side < 0 ? (edge - 0.75) - pb.max.x : (edge + 0.75) - pb.min.x;
          b.position.z += (rb.min.z + 0.35) - pb.max.z; b.updateMatrixWorld(true); pb = new THREE.Box3().setFromObject(b);
          // keep the deck clearly above the rock / ground (the approach used to slide through the boulder)
          { const midX = (pb.min.x + pb.max.x) * 0.5, midZ = (pb.min.z + pb.max.z) * 0.5;
            const yNeed = Math.max(surfY(midX, midZ, [boulder, ground]), surfY(pb.min.x, pb.min.z, [boulder, ground]), surfY(pb.max.x, pb.max.z, [boulder, ground]), gY) + 0.38;
            b.position.y += yNeed - pb.min.y; b.updateMatrixWorld(true); pb = new THREE.Box3().setFromObject(b); }
          d.H = b.position.clone(); d.Q = b.quaternion.clone();
          const a = b.userData.deckAnchor || { x: 0, y: 0, z: 0 }, ac = b.localToWorld(new THREE.Vector3(a.x, a.y, a.z));
          // where she rides: a little toward the tail and toward the rock-side edge (a shorter walk and a single step up), on the deck
          const Rw = ac.clone(); Rw.z += Lb * 0.2; Rw.x += -side * Wb * 0.22; d.Dl = b.worldToLocal(Rw.clone()); d.Dl.y += 0.03 / Math.max(1e-4, Math.abs(b.getWorldScale(_dq.s).y));
          // walk: from in front of her seat, round her side of the rock, to the deck's rock-side edge
          const Sx = X.holder.localToWorld(X.ankleDown.clone()); Sx.y = surfY(Sx.x, Sx.z, [ground]);
          const Wp = new THREE.Vector3(lane, 0, Math.min(Rw.z, rb.min.z - 0.4));
          const pts = [Sx, new THREE.Vector3(lane, 0, Math.max(rb.min.z + 0.2, Math.min(0.15, Sx.z - 0.3))), new THREE.Vector3(lane, 0, rb.min.z - 0.05), Wp].map(p => { p.y = surfY(p.x, p.z, [ground]); return p; });
          d.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal'); d.len = d.curve.getLength();
          const ys = new Float32Array(33); for (let j = 0; j <= 32; j++) { d.curve.getPointAt(j / 32, _dq.v); ys[j] = surfY(_dq.v.x, _dq.v.z, [ground]); } d.ys = ys;
          d.walkDur = Math.max(2.0, Math.min(6.0, d.len / 1.25));
          d.stepDur = X.clips.step ? Math.max(0.7, Math.min(1.15, X.clips.step.duration * 0.85)) : 0.9;
          // timeline
          d.dl = i === 0 ? 0 : 0.35; d.TF = 3.4;
          d.tR0 = 3.0 + d.dl * 0.6; d.tR1 = d.tR0 + 1.4; d.tW0 = d.tR1 - 0.15; d.tW1 = d.tW0 + d.walkDur; d.tS0 = d.tW1; d.tL = d.tS0 + d.stepDur;
          // fly-in from behind the camera, past her side of the rock, decelerating into the hover
          const cw = camera.position;
          // (v379) the boards DESCEND out of the sky over the lens and settle at GROUND level beside her side of the rock (deck a short step up), the
          // original composition.  v378 clamped the whole approach + hover to IN.yClear = the highest point of the entire ground mesh (far hills,
          // ~10.9 m), so the boards parked 10 m up, out of frame, and the riders 'stepped' all the way up to them.  The floor is now LOCAL:
          // the ground under the board's footprint (+ the boulder's top only where the footprint overlaps it), see the per-frame lift below.
          const yClear = gY + 0.12;
          d.P0 = new THREE.Vector3(cw.x + side * (Wb * 0.35 + 1.1), d.H.y + 6.5, Math.min(cw.z * 0.55, 2.2));   // high over the lens: dropping in from the sky
          d.P1 = new THREE.Vector3(edge + side * (0.75 + Wb * 0.45 + 0.4), d.H.y + 2.4, Math.max(0.4, cw.z * 0.25));
          d.P2 = d.H.clone().add(new THREE.Vector3(0, 0.45, Lb * 0.2)); d.P3 = d.H.clone();
          d.yClear = yClear;
          d.seatPos = X.holder.position.clone(); d.seatQ = X.holder.quaternion.clone();
          d.walkQ0 = new THREE.Quaternion(); d.curve.getTangentAt(0.02, _dq.v); d.walkQ0.setFromAxisAngle(_dq.Y, Math.atan2(_dq.v.x, _dq.v.z));
          d.faceQ = new THREE.Quaternion().setFromAxisAngle(_dq.Y, Math.atan2(Rw.x - Wp.x, Rw.z - Wp.z));
          d.rideQ = new THREE.Quaternion().setFromAxisAngle(_dq.Y, rideYaw);
          d.Wp = Wp; d.Rw = Rw; d.hq = new THREE.Quaternion(); d.hp = new THREE.Vector3();
          d.walk = mkSampler(X.clips.walk, X.bones); d.step = mkSampler(X.clips.step, X.bones);
          d.keep = Object.keys(X.bones).map(n => [X.bones[n], X.bones[n].position.clone(), X.bones[n].quaternion.clone()]);
          d.lockM = null; d.lockW = new THREE.Matrix4(); d.lockS = new THREE.Vector3();
          d.side = side; d.wR = 0; d.board = b;
          b.position.copy(d.P0); b.visible = false; scene.add(b);
          d.jets = mkJets(b, o.trail); d.jets.group.visible = false; scene.add(d.jets.group);
          X.du = d; DU.P.push(X);
        });
        DU.tDep = Math.max(A.du.tL, B.du.tL) + 1.3; DU.tBay = DU.tDep + 5.2; DU.tFly = DU.tBay + 5.0;
        DU.Hmid.copy(A.du.H).add(B.du.H).multiplyScalar(0.5);
        DU.dep = DU.P.map(() => ({ s: 0, v: 0 }));
        // clean dark cross-dissolve (full-frame, never a 2D white elliptical gradient)
        try { const wv = document.createElement('div'); wv.className = 'ms-dissolve'; wv.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;z-index:1;background:#05070c';
          (cv.parentNode || document.body).insertBefore(wv, cv.nextSibling); DU.warp = wv; } catch (e) { DU.warp = null; }
        IN.duo = true; IN.t = 0; IN.w = 0; IN.onFly = o.onFlyOff; IN.flew = false; IN.board = boards[0]; IN.sharedTex = true; IN.lift = false; IN.dep = null; IN.list = null; IN._n = 0; IN._s = 0; MS.half = false;
        // compile both boards (and, a moment later and off the critical path, the bay) before the first fly-in frame
        boards.forEach(b => { b.visible = true; });
        let pc = null; try { pc = renderer.compileAsync(scene, camera); } catch (e) { pc = null; } finally { boards.forEach(b => { b.visible = false; }); }
        return Promise.resolve(pc).catch(() => {}).then(() => {
          if (!DU) return;
          boards.forEach(b => { b.visible = true; }); IN.on = true; clearAllSeatCols(); info('duo launch on (' + Math.round(performance.now() - now0) + ' ms)');
          // (v379) the bay AND the riders are compiled for the bay's lights before the switch: v378 compiled only the empty bay, so on a phone both riders'
          // materials (+ shadow variants) compiled on their first bay frame, the boards flew in empty and the riders popped on ~3 s later (Justin's recording)
          const buildBaySoon = () => { if (!DU || DU.bay) return; try { DU.bay = buildBay(Math.max(A.du.Lb, B.du.Lb), Math.max(A.du.Wb, B.du.Wb)); DU.bay.cam.position.set(0, DU.bay.Hy * 0.5, DU.bay.Lz * 0.4); DU.bay.cam.lookAt(0, 1, 0);
            const D0 = DU, bs = DU.bay.scene, bc = DU.bay.cam, pr = [];
            if (renderer.compileAsync) { const c = (o, tgt) => { try { pr.push(Promise.resolve(tgt ? renderer.compileAsync(o, bc, tgt) : renderer.compileAsync(o, bc)).catch(() => {})); } catch (e) {} };
              c(bs); DU.P.forEach((X) => { c(X.holder, bs); c(X.du.board, bs); if (X.du.jets) c(X.du.jets.group, bs); }); }
            Promise.all(pr).then(() => { if (DU === D0) { DU.bayReady = true; info('cargo bay + riders compiled'); } }); } catch (e) { info('bay build failed:', e && e.message); } };
          if (o.syncBay || window.__MS_DEBUG) buildBaySoon(); else setTimeout(buildBaySoon, 1200);
        });
      };
      // boards + holders for this frame (before the poses)
      const duoPre = (dt) => {
        IN.t += dt; DU.t = IN.t; const t = IN.t;
        // dip-to-black dissolve around the scene switch (peak at tBay)
        // (v379) hold at the dark peak only while the bay / riders are still compiling (<= 1.5 s, then go anyway); a short dip (0.35 s in, 0.45 s out)
        if (!DU.inBay && t >= DU.tBay && !(DU.bay && DU.bayReady) && (DU._wait || 0) < 1.5) { DU._wait = (DU._wait || 0) + dt; DU.tBay += dt; DU.tFly += dt; }
        if (DU.warp) { const tb = t - DU.tBay, op = (tb < -0.35 ? 0 : tb < 0 ? smooth(-0.35, 0, tb) : 1 - smooth(0.0, 0.45, tb)); if (op !== DU._wop) { DU.warp.style.opacity = op.toFixed(3); DU._wop = op; } }
        if (!DU.inBay && t >= DU.tBay && DU.bay) duoEnterBay();
        if (DU.inBay && DU.bay) {
          DU.doorK = smooth(0, 1.6, t - DU.tBay);
          try { const inst = DU.bay.glb && DU.bay.glb(); if (inst && window.DMMenuWorld) DMMenuWorld.setBayDoors(inst, DU.doorK); } catch (e) {}
        }
        for (let i = 0; i < DU.P.length; i++) {
          const X = DU.P[i], d = X.du, b = d.board, h = X.holder;
          if (d.bScale && !b.scale.equals(d.bScale)) b.scale.copy(d.bScale);
          if (DU.inBay) duoBayBoard(X, i, t - DU.tBay);
          else if (t < DU.tDep + i * 0.3) {
            const tf = t - d.dl;
            if (tf < 0) { b.visible = false; }
            else if (tf < d.TF) {   // in from behind the camera, past her side, easing into the hover
              b.visible = true; const u = tf / d.TF, e = 1 - Math.pow(1 - u, 3);
              bez3(d.P0, d.P1, d.P2, d.P3, e, b.position); if (d.yClear && b.position.y < d.yClear) b.position.y = d.yClear; bez3(d.P0, d.P1, d.P2, d.P3, Math.min(1, e + 0.01), _dq.v);
              _dq.v.sub(b.position); _dq.v.y = 0; if (_dq.v.lengthSq() < 1e-10) _dq.v.set(0, 0, -1); _dq.v.normalize();
              const head = _dq.v2.copy(_dq.v).lerp(_dq.v3.set(0, 0, -1), smooth(0.75, 1, u)).normalize(); boardQ(head, b.quaternion);
              b.quaternion.premultiply(_dq.q.setFromAxisAngle(head, d.side * 0.38 * Math.sin(Math.PI * Math.min(1, u * 1.15))));
            } else {               // hover
              b.position.copy(d.H); b.position.y += 0.03 * Math.sin(t * 2.6 + i) * (1 - smooth(DU.tDep - 0.9, DU.tDep, t)) - (t > d.tL ? 0.05 * smooth(d.tL, d.tL + 0.15, t) * (1 - smooth(d.tL + 0.15, d.tL + 1.0, t)) : 0);
              b.quaternion.copy(d.Q);
            }
          } else {                 // together toward the horizon: eased speed, a gentle climb, a little weave and bank
            const D = DU.dep[i], ds = Math.min(dt, 0.05), tt = t - DU.tDep - i * 0.3; D.v = 12 * smooth(0, 2.2, tt); D.s += D.v * ds;
            b.position.set(d.H.x + d.side * 0.55 * Math.sin(tt * 0.9) * smooth(0, 1.5, tt), d.H.y + 0.34 * D.s * smooth(0.3, 2.0, tt) + 0.25 * smooth(0, 2.4, tt), d.H.z - D.s);   // (v379) lift off from the ground and climb ~19 deg (the camera pans up after them), clear of the rocks / far ridges
            b.quaternion.copy(d.Q).premultiply(_dq.q.setFromAxisAngle(_dq.v.set(1, 0, 0), 0.22 * smooth(0, 1.4, tt))).premultiply(_dq.q2.setFromAxisAngle(_dq.v2.set(0, 0, -1), d.side * 0.12 * Math.cos(tt * 0.9) * smooth(0, 1.5, tt)));
          }
          if (!DU.inBay && d.yClear) {   // (v379) local floor: ground under the footprint (analytic groundH, no raycast) + the boulder top where it overlaps
            const bb = DU._bb; b.updateMatrixWorld(true); bb.setFromObject(b);
            let need = Math.max(groundH(bb.min.x, bb.min.z), groundH(bb.max.x, bb.max.z), groundH(bb.min.x, bb.max.z), groundH(bb.max.x, bb.min.z), groundH((bb.min.x + bb.max.x) * 0.5, (bb.min.z + bb.max.z) * 0.5)) + 0.12;
            const R = DU.rb; if (bb.max.x > R.min.x && bb.min.x < R.max.x && bb.max.z > R.min.z && bb.min.z < R.max.z) need = Math.max(need, R.max.y + 0.06);
            const lift = need - bb.min.y; if (lift > 0) b.position.y += lift;
          }
          b.updateMatrixWorld(true);
          if (d.jets) {
            const spd = DU.inBay ? 8 * Math.max(0, 1 - (t - DU.tBay) / 4.2) : (t >= DU.tDep + i * 0.3 ? (DU.dep[i] && DU.dep[i].v) || 0 : 0);
            b.userData._jetLb = d.Lb; b.userData._jetWb = d.Wb;
            if (d.jets.group.parent !== b.parent && b.parent) { try { if (d.jets.group.parent) d.jets.group.parent.remove(d.jets.group); b.parent.add(d.jets.group); } catch (e) {} }
            d.jets.tick(b, spd, dt);
          }
          // her: seated -> rise -> walk round the rock -> step onto the deck -> ride (locked to the board)
          if (d.lockM) { d.lockW.multiplyMatrices(b.matrixWorld, d.lockM); d.lockW.decompose(h.position, h.quaternion, d.lockS); h.updateMatrixWorld(true); continue; }
          d.wR = smooth(d.tR0, d.tR1, t);
          if (t < d.tR0) continue;
          if (t < d.tW0 + 0.15) {   // rise off the rock onto her feet in front of it, turning toward her walk
            d.curve.getPointAt(0, _dq.v); h.position.lerpVectors(d.seatPos, _dq.v, d.wR); h.quaternion.slerpQuaternions(d.seatQ, d.walkQ0, d.wR);
          } else if (t < d.tW1) {   // walk (arc length, ground height sampled at setup), facing along the path, turning to the board at the end
            const u = Math.min(1, (t - d.tW0) / d.walkDur); d.curve.getPointAt(u, h.position); const f = u * 32, j = Math.min(31, Math.floor(f)); h.position.y = d.ys[j] + (d.ys[j + 1] - d.ys[j]) * (f - j);
            { const ua = Math.min(0.995, Math.max(0, u - 0.004)); d.curve.getPointAt(ua, _dq.v2); d.curve.getPointAt(ua + 0.005, _dq.v); _dq.v.sub(_dq.v2); }   // tangent without Curve.getTangent's two temp vectors
            _dq.q.setFromAxisAngle(_dq.Y, Math.atan2(_dq.v.x, _dq.v.z));
            _dq.q.slerp(d.faceQ, smooth(d.tW1 - 0.5, d.tW1, t)); h.quaternion.slerp(_dq.q, Math.min(1, dt * 8));
          } else if (t < d.tL) {    // step up onto the deck
            const k = (t - d.tS0) / d.stepDur, ks = k * k * (3 - 2 * k); d.hp.copy(d.Dl); b.localToWorld(d.hp);
            h.position.lerpVectors(d.Wp, d.hp, ks); h.position.y = d.Wp.y + (d.hp.y - d.Wp.y) * smooth(0.1, 0.75, k) + Math.sin(Math.PI * k) * 0.06;
            h.quaternion.slerpQuaternions(d.faceQ, d.rideQ, smooth(0.35, 1, k));
          } else {                  // planted on the deck: from now on she rides the board's transform rigidly
            d.hp.copy(d.Dl); b.localToWorld(d.hp); h.position.copy(d.hp); h.quaternion.copy(d.rideQ); h.updateMatrixWorld(true);
            d.lockM = new THREE.Matrix4().copy(b.matrixWorld).invert().multiply(h.matrixWorld);
          }
          h.updateMatrixWorld(true);
        }
        if (!IN.flew && t >= DU.tFly) { IN.flew = true; try { IN.onFly && IN.onFly(); } catch (e) {} }
      };
      // poses on top of the seated pose: rise (seated -> walk frame), walk, Mount_Step, the standing stance; heads follow the boards on the fly-in
      const duoPost = () => {
        const t = IN.t;
        for (let i = 0; i < DU.P.length; i++) {
          const X = DU.P[i], d = X.du;
          if (d.wR > 0) d.walk.apply(t < d.tW0 ? 0 : (t - d.tW0) * 1.0, d.wR);
          const wS = smooth(d.tS0 - 0.12, d.tS0 + 0.12, t); if (wS > 0 && t < d.tL + 1.0) d.step.applyClamped((t - d.tS0) * (d.step.dur * 0.98 / d.stepDur), wS * (1 - smooth(d.tL, d.tL + 0.9, t)));
          const wT = smooth(d.tL - 0.15, d.tL + 0.85, t); if (wT > 0) standPose(X, t, wT);
          const wl = smooth(d.dl + 0.4, d.dl + 1.3, t) * (1 - smooth(d.tR0 + 0.4, d.tR0 + 1.5, t));
          if (wl > 0.001 && !DU.inBay) { X.root.updateMatrixWorld(true); lookAtPoint(X, d.board.position, wl); }
          X.root.updateMatrixWorld(true);
        }
      };
      const duoCamera = () => {
        const t = IN.t;
        if (DU.inBay) {
          const bay = DU.bay, tb = t - DU.tBay, c = bay.cam;
          if (c.aspect !== camera.aspect) { c.aspect = camera.aspect; c.updateProjectionMatrix(); }
          const k = smooth(0, 6, tb); c.position.set(0.6 * Math.sin(tb * 0.2), bay.Hy * (0.5 - 0.1 * k), bay.Lz * (0.42 - 0.1 * k));
          DU.mid.copy(A.du.board.position).add(B.du.board.position).multiplyScalar(0.5); DU.mid.y += 0.8;
          DU.camLook.lerp(DU.mid, tb < 0.1 ? 1 : 0.06); c.lookAt(DU.camLook); bay.tick(tb); return;
        }
        // dolly back so walks and step-ons stay in frame; after lift-off follow from behind/above without pitching into empty sky
        const k1 = smooth(2.4, Math.min(A.du.tW0, B.du.tW0) + 1.2, t), kd = smooth(DU.tDep, DU.tDep + 4.2, t);
        camera.position.x += 0; camera.position.y += 0.55 * k1 + 0.85 * kd; camera.position.z += 2.6 * k1 + 1.4 * kd;
        _dq.v.copy(TARGET); _dq.v.y += 0.15 * k1;
        if (k1 > 0) { DU.mid.set(0, TARGET.y + 0.2, 0); _dq.v.lerp(DU.mid, 0.35 * k1); }
        if (kd > 0) { DU.mid.copy(A.du.board.position).add(B.du.board.position).multiplyScalar(0.5); DU.mid.y += 0.35; _dq.v.lerp(DU.mid, 0.75 * kd); }
        camAvoid(camera.position);
        DU.camLook.lerp(_dq.v, 0.12); camera.lookAt(DU.camLook);
      };
      // the switch to the cargo bay (at the warp flash's peak): pilots and boards move into the bay scene
      const duoEnterBay = () => {
        DU.inBay = true; const bay = DU.bay; DU.doorK = 0;
        try { const inst = bay.glb && bay.glb(); if (inst && window.DMMenuWorld) DMMenuWorld.setBayDoors(inst, 0); } catch (e) {}
        DU.P.forEach((X, i) => { const d = X.du; scene.remove(d.board); bay.scene.add(d.board); scene.remove(X.holder); bay.scene.add(X.holder);
          if (!d.lockM) { d.hp.copy(d.Dl); d.board.updateMatrixWorld(true); d.board.localToWorld(d.hp); X.holder.position.copy(d.hp); X.holder.quaternion.copy(d.rideQ); X.holder.updateMatrixWorld(true); d.lockM = new THREE.Matrix4().copy(d.board.matrixWorld).invert().multiply(X.holder.matrixWorld); }
          d.bayIn = new THREE.Vector3(d.side * (d.Wb * 0.5 + 1.6), bay.Hy * 0.55, -bay.Lz / 2 - d.Lb * 1.4); d.bayPark = new THREE.Vector3(d.side * (d.Wb * 0.5 + 0.9), bay.deckY + 0.6, -bay.Lz * 0.06);
          d.bayQ = boardQ(new THREE.Vector3(0, 0, 1), new THREE.Quaternion()); });
        try { hair && hair.reset && hair.reset(); B && B.hair && B.hair.reset && B.hair.reset(); } catch (e) {}   // the heads jumped scenes: re-seed the strands, no whip
        info('cargo bay arrival');
      };
      const duoBayBoard = (X, i, tb) => {
        const d = X.du, b = d.board, u = Math.min(1, Math.max(0, (tb - 0.7 - i * 0.25) / 4.0)), e = 1 - Math.pow(1 - u, 3);
        b.position.lerpVectors(d.bayIn, d.bayPark, e); b.position.y += Math.sin(Math.PI * e) * 0.6 + (u >= 1 ? 0.03 * Math.sin(tb * 2.4 + i) : 0);
        b.quaternion.copy(d.bayQ).premultiply(_dq.q.setFromAxisAngle(_dq.v.set(1, 0, 0), -0.18 * (1 - e))).premultiply(_dq.q2.setFromAxisAngle(_dq.v2.set(0, 0, 1), -d.side * 0.25 * Math.sin(Math.PI * e)));
        // live door / wall / floor / ceiling collision: meshes cached at bay load, AABBs updated in place once per frame when doorK changes
        const inst = DU.bay && DU.bay.glb && DU.bay.glb();
        if (inst && window.DMMenuWorld && DMMenuWorld.bayColliders && DMMenuWorld.separateBay) {
          if (DU._colRoot !== inst) {
            DU._colRoot = inst;
            DU._cols = DMMenuWorld.cacheBayColliders ? DMMenuWorld.cacheBayColliders(inst) : DMMenuWorld.bayColliders(THREE, inst);
            DU._colDoorK = undefined;
          }
          const dk = DU.doorK || 0;
          if (DU._colDoorK !== dk) { DMMenuWorld.bayColliders(THREE, inst); DU._colDoorK = dk; }
          DMMenuWorld.separateBay(b.position, (d.Lb || 4) * 0.42, 0.22, (d.Wb || 0.8) * 0.42, DU._cols);
        }
      };
      const duoReset = () => {
        const D = DU; DU = null; IN.duo = false; IN.on = false; IN.board = null; IN.flew = false;
        if (!D) return;
        try { if (D.warp) D.warp.remove(); } catch (e) {}
        D.P.forEach((X, i) => { const d = X.du; if (!d) return;
          try { if (d.jets) d.jets.dispose(); } catch (e) {}
          try { if (d.board.parent) d.board.parent.remove(d.board); } catch (e) {}
          if (X.holder.parent !== scene) { try { if (X.holder.parent) X.holder.parent.remove(X.holder); scene.add(X.holder); } catch (e) {} }
          d.keep.forEach(([bn, p, q]) => { bn.position.copy(p); bn.quaternion.copy(q); });
          X.holder.position.copy(d.seatPos); X.holder.quaternion.copy(d.seatQ); X.holder.updateMatrixWorld(true); X.du = null;
          if (!d.board.userData.duoClone) d.board.traverse(m => { if (!m.geometry && !m.material) return; try { m.geometry && m.geometry.dispose(); } catch (e) {}
            (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => { if (!mt) return; if (!D.share[i]) for (const k in mt) { const v = mt[k]; if (v && v.isTexture) try { v.dispose(); } catch (e) {} } try { mt.dispose(); } catch (e) {} }); }); });
        try { if (D.bay) D.bay.dispose(); } catch (e) {}
      };
      const bez3 = (a, b1, c, d, u, out) => { const v = 1 - u; return out.set(0, 0, 0).addScaledVector(a, v * v * v).addScaledVector(b1, 3 * v * v * u).addScaledVector(c, 3 * v * u * u).addScaledVector(d, u * u * u); };
      // board + her placement for this frame (before the bones are posed)
      const introPre = (dt) => {
        const b = IN.board; if (IN.bScale && !b.scale.equals(IN.bScale)) b.scale.copy(IN.bScale); IN.t += dt; const t = IN.t, TF = IN.T_FLY, T_STEP = IN.T_STEP, T_LAND = IN.T_LAND, T_LIFT = IN.T_LIFT;
        if (t < TF) {           // swoop in, round behind
          const u = Math.min(1, t / TF), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
          bez3(IN.P0, IN.P1, IN.P2, IN.P3, e, b.position); bez3(IN.P0, IN.P1, IN.P2, IN.P3, Math.min(1, e + 0.01), IN.tmp);
          const dx = IN.tmp.x - b.position.x, dz = IN.tmp.z - b.position.z;
          const ty = dx * dx + dz * dz > 1e-8 ? Math.atan2(-dz, dx) : IN.phi;
          let dy = IN.phi - ty; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          b.rotation.set(0, ty + dy * smooth(0.8, 1, u), -0.5 * Math.sin(Math.PI * u)); b.quaternion.multiply(IN.qFlip);
        } else if (t < T_LIFT) { // pull up from behind to the stop, then hover
          const u = Math.min(1, (t - TF) / 1.1), e = 1 - Math.pow(1 - u, 3);
          b.position.lerpVectors(IN.P3, IN.H, e); b.rotation.set(0, IN.phi, 0.06 * (1 - e)); b.quaternion.multiply(IN.qFlip);
          // hover bob fades out before the departure so the board leaves from rest (no velocity step at the hand-over)
          b.position.y += 0.03 * Math.sin(t * 2.6) * smooth(0.7, 1, u) * (1 - smooth(T_LIFT - 0.9, T_LIFT, t)) - (t > T_LAND ? 0.06 * smooth(T_LAND, T_LAND + 0.15, t) * (1 - smooth(T_LAND + 0.15, T_LIFT, t)) : 0);
        } else {                 // calm departure: a wide climbing turn-around (DMLaunch.departure: C1 path, eased speed, small pitch, banking)
          const s = t - T_LIFT, d = IN.dep, ds = Math.min(dt, 0.05);
          if (!IN.lift) { IN.lift = true; IN.depStart = 0; }
          if (d) { d.step(ds); b.position.set(IN.H.x + d.st.x, IN.H.y + d.st.y, IN.H.z + d.st.z); b.rotation.set(d.roll(d.st.s), d.heading(d.st.s), d.pitch(d.st.s)); b.quaternion.multiply(IN.qFlip); }
          else { b.position.y += 1.2 * ds; }
          if (!IN.flew && s > IN.T_DEP - 1.6) { IN.flew = true; try { IN.onFly && IN.onFly(); } catch (e) {} }
        }
        b.updateMatrixWorld(true);
        if (IN.lc) {
          // (menu-perf) lowest world-y of the contact footprint (<= 288 points, a few dot products): above every surface -> nothing to lift,
          // and the patch is not (re)sampled; it rebuilds by itself on the way back down (same lift() as before, only called when it can matter)
          let lo = 1e9; const pts = IN.lc.pts, e = b.matrixWorld.elements;
          if (pts && IN.lc.np && IN.yClear != null) { for (let k = 0; k < IN.lc.np * 3; k += 3) { const wy = e[1] * pts[k] + e[5] * pts[k + 1] + e[9] * pts[k + 2] + e[13]; if (wy < lo) lo = wy; } }
          if (lo > (IN.yClear == null ? 1e9 : IN.yClear) + 0.4) { /* airborne */ }
          else { const up = IN.lc.lift(b, 0.02); if (up > 0) { b.position.y += up; b.updateMatrixWorld(true); } }
        }
IN.D.copy(IN.Dl); b.localToWorld(IN.D); IN.D.y += 0.03;
        // her: stand + walk over, step on, ride
        if (t >= IN.T_WALK - 0.1 && IN.walk && !IN.walked) { IN.walked = true; IN.walk.reset().play(); IN.walk.timeScale = 0.9; }
        if (t >= T_STEP && IN.jump && !IN.jumped) { IN.jumped = true; IN.jump.reset().play(); if (IN.walk) IN.walk.crossFadeTo(IN.jump, 0.18, false); }
        if (t >= T_LAND - 0.2 && IN.ride && !IN.rode) { IN.rode = true; IN.ride.reset().play(); if (IN.jump) IN.jump.crossFadeTo(IN.ride, 0.9, false); }
        if (IN.rode && !IN.cleaned && t > T_LAND + 1.0) { IN.cleaned = true; try { if (IN.walk) IN.walk.stop(); if (IN.jump) IN.jump.stop(); } catch (e) {} }   // only the standing ride stance is left   // the ride stance eases in under the landing: no snap to it
        IN.w = smooth(IN.T_WALK - 0.1, IN.T_WALK + IN.T_STAND - 0.1, t);   // stand up: the seated pose eases into the walk over ~1 s
        const uw = smooth(IN.T_WALK + 1.0, T_STEP, t);            // along the walk
        const k = Math.min(1, Math.max(0, (t - T_STEP) / IN.stepDur)), ks = k * k * (3 - 2 * k);
        IN.FT.lerpVectors(IN.S0, IN.W, uw); IN.FT.y = surfY(IN.FT.x, IN.FT.z);
        if (k > 0) { IN.FT.lerp(IN.D, ks); IN.FT.y += Math.sin(Math.PI * k) * 0.08; }   // the clip carries the step up; only a hint of root lift
        if (t >= T_LIFT && IN.lockM) {   // planted on the deck: ride the board's transform rigidly
          IN.lockW.multiplyMatrices(b.matrixWorld, IN.lockM); IN.lockW.decompose(holder.position, holder.quaternion, IN.lockS);
          holder.updateMatrixWorld(true); return;
        }
        if (IN.rel) { IN.tmp.copy(IN.FT).add(IN.rel); holder.position.lerpVectors(IN.seatPos, IN.tmp, IN.w); }
        if (k > 0) holder.quaternion.slerpQuaternions(IN.walkQ, IN.rideQ, ks); else holder.quaternion.slerpQuaternions(IN.seatQ, IN.walkQ, IN.w);
        holder.updateMatrixWorld(true);
        if (t >= T_LIFT - 0.02 && !IN.lockM) {   // last grounded frame: remember her pose in the board's frame
          IN.lockM = new THREE.Matrix4(); IN.lockW = new THREE.Matrix4(); IN.lockS = new THREE.Vector3();
          IN.lockM.copy(b.matrixWorld).invert().multiply(holder.matrixWorld);
        }
      };
      // blend the seated pose (already solved this frame, snapshot into sq/sp) toward the clip pose
      const introPost = () => {
        const w = IN.w;
        if (w > 0) for (let i = 0; i < IN.list.length; i++) { const bn = IN.list[i]; IN.qa.copy(bn.quaternion); bn.quaternion.slerpQuaternions(IN.sq[i], IN.qa, w); IN.tmp.copy(bn.position); bn.position.lerpVectors(IN.sp[i], IN.tmp, w); }
        root.updateMatrixWorld(true);
        if (IN.w > 0.04 && !IN.lockM && bones.LeftFoot && bones.RightFoot) {    // holder offset that puts her feet on the deck
          bones.LeftFoot.getWorldPosition(IN.F); bones.RightFoot.getWorldPosition(IN.tmp); IN.F.add(IN.tmp).multiplyScalar(0.5);
          IN.F.y = Math.min(IN.F.y, IN.tmp.y); const r = holder.position.clone().sub(IN.F);
          if (!IN.rel) IN.rel = r; else IN.rel.lerp(r, IN.t > IN.T_LAND ? 0.25 : 0.5);
        } else if (!IN.rel && IN.w > 0) { /* first frames of the step: hold seat */ }
      };
      const introSnap = () => { for (let i = 0; i < IN.list.length; i++) { IN.sq[i].copy(IN.list[i].quaternion); IN.sp[i].copy(IN.list[i].position); } };
      const disposeBoard = (b) => { scene.remove(b);   // never disposes textures: a parked board that introStart never took may share the game board's template textures
        b.traverse(m => { if (!m.geometry && !m.material) return; try { m.geometry && m.geometry.dispose(); } catch (e) {}
          (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => { if (!mt) return;
            try { mt.dispose(); } catch (e) {} }); }); };
      // (menu-perf) Called by index.html while the loader hold is up and the world compiles: the intro board is added to the scene VISIBLE and
      // parked far below the floor (frustumCulled off, so it is submitted and clipped by the GPU) for the compile and two real frames, which builds its
      // pipelines (incl. the shadow-caster variant), uploads its buffers / textures and creates its bind groups; then hidden and parked until
      // introStart picks it up. Nothing is visible on screen at any point.
      const introPrecompile = (b) => {
        if (IN.on || IN.board || IN.parked || !b) return Promise.resolve(false);
        IN.parked = b; b.position.set(0, -400, 0); b.traverse(m => { if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
        scene.add(b); b.updateMatrixWorld(true);
        let pc = null; b.visible = true; try { pc = renderer.compileAsync(scene, camera); } catch (e) { pc = null; }
        return Promise.resolve(pc).catch(() => {}).then(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))).then(() => { if (IN.parked === b) { b.visible = false; IN.warmed = b; } return true; });
      };
      const introReset = () => {
        if (DU || IN.duo) { duoReset(); MS.half = false; return; }
        if (IN.parked && !IN.board) { const pb = IN.parked; IN.parked = null; try { disposeBoard(pb); } catch (e) {} }
        if (IN.board) { // the intro board is its own instance (GLB clones own geometry+materials); textures of a GLB template stay with the game's cache
          const b = IN.board; scene.remove(b); IN.board = null;
          b.traverse(m => { if (!m.geometry && !m.material) return; try { m.geometry && m.geometry.dispose(); } catch (e) {}
            (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => { if (!mt) return;
              if (!IN.sharedTex) for (const k in mt) { const v = mt[k]; if (v && v.isTexture) try { v.dispose(); } catch (e) {} }
              try { mt.dispose(); } catch (e) {} }); });
        }
        MS.half = false; trailClear(); IN.cleaned = false; IN.dep = null;
        if (!IN.list) return; IN.on = false;
        try { [IN.walk, IN.jump, IN.ride].forEach(a => { if (a) a.stop(); }); if (IN.walk) C.mixer.uncacheAction(IN.walk.getClip()); if (IN.jump) C.mixer.uncacheAction(IN.jump.getClip()); if (IN.ride) C.mixer.uncacheAction(IN.ride.getClip()); } catch (e) {}
        IN.list.forEach((bn, i) => { bn.position.copy(IN.keep[i][0]); bn.quaternion.copy(IN.keep[i][1]); });
        holder.position.copy(IN.seatPos); holder.quaternion.copy(IN.seatQ); holder.updateMatrixWorld(true);
        IN.list = null; IN.rel = null; IN.lockM = null; IN.lift = false; IN.walked = IN.jumped = IN.rode = false; IN.walk = null;
      };
      const trailTick = (dt) => {
        const d = IN.dep, b = IN.board;
        if (IN.on && IN.lift && d && b) {
          const vr = d.speed(d.st.s) / d.D.vmax, alt = Math.max(0, b.position.y - IN.H.y);
          const low = 1 - 0.7 * smooth(0.3, 6 * IN.Ls / 4.6, alt);                       // thins out with altitude
          tAcc += 90 * smooth(0.04, 0.7, vr) * low * dt;                                   // forms with speed
          const psi = d.heading(d.st.s), cg = Math.cos(d.pitch(d.st.s)), fx = Math.cos(psi) * cg, fz = -Math.sin(psi) * cg;
          while (tAcc >= 1) {
            tAcc -= 1; const i = tHead, o = i * 3; tHead = (tHead + 1) % NT;
            tpos[o] = b.position.x - fx * IN.Lb * 0.45 + (Math.random() - 0.5) * 0.2; tpos[o + 1] = b.position.y - 0.05 + (Math.random() - 0.5) * 0.08; tpos[o + 2] = b.position.z - fz * IN.Lb * 0.45 + (Math.random() - 0.5) * 0.2;
            tvel[o] = -fx * 0.25 + (Math.random() - 0.5) * 0.3; tvel[o + 1] = 0.05 + Math.random() * 0.12; tvel[o + 2] = -fz * 0.25 + (Math.random() - 0.5) * 0.3;
            tage[i] = 0; tlife[i] = 1.2 + Math.random() * 1.1;
          }
        }
        let alive = 0;
        for (let i = 0; i < NT; i++) {
          const o = i * 3; if (tage[i] >= tlife[i]) { if (tcol[o] !== 0) { tcol[o] = tcol[o + 1] = tcol[o + 2] = 0; } continue; }
          tage[i] += dt; alive++; const k = 1 - tage[i] / tlife[i], f = k * k * 0.5;
          tpos[o] += tvel[o] * dt; tpos[o + 1] += tvel[o + 1] * dt; tpos[o + 2] += tvel[o + 2] * dt; tvel[o] *= 0.97; tvel[o + 2] *= 0.97;
          tcol[o] = 0.86 * f; tcol[o + 1] = 0.64 * f; tcol[o + 2] = 0.44 * f;
        }
        if (alive || tAlive) { tgeo.attributes.position.needsUpdate = true; tgeo.attributes.color.needsUpdate = true; }
        tAlive = alive; trail.visible = alive > 0;
      };
      const trailClear = () => { tage.fill(9); tcol.fill(0); tAcc = 0; tAlive = 0; trail.visible = false; };
      let raf = 0; const wind = new THREE.Vector3();
      const loop = (now) => {
        raf = requestAnimationFrame(loop); MS._raf = raf;
        if (MS.paused || document.hidden) { last = now; return; }
        // (menu-perf) Behind the launch loader the scene is decoration while the game world compiles on the same GPU: draw every skipN-th frame
        // (dt keeps accumulating, capped as always, so the pose does not slow; the intro itself is never throttled). Set by index.html's intro tick.
        // (launch) a fly-out that cannot hold 60 on this device (measured over its first 30 frames: average 20-36 ms) is paced at a steady
        // 30 fps instead (every second vsync, dt integrates): even pacing reads smoother than 22-45 ms alternating, and halves the GPU / hair /
        // shadow work per second. Nothing is lowered in quality; a device that holds 60 never enters this.
        if (IN.on && MS.half) { MS._hk = !MS._hk; if (MS._hk) return; }
        if (MS.skipN > 1 && !IN.on) { MS._sk = ((MS._sk | 0) + 1) % MS.skipN; if (MS._sk) return; }
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        if (window._dmWarming || MS.skipN > 1) { ema = 16; adj = 0; } else ema += (dt * 1000 - ema) * 0.04;
        if (++adj > 90) { adj = 0; if (ema > 36 && pr > sc.pr * 0.5) { pr = Math.max(0.5, pr - 0.15); fit(); } else if (ema < 20 && pr < sc.pr) { pr = Math.min(sc.pr, pr + 0.1); fit(); } }
        if (IN.on) { IN._n = (IN._n | 0) + 1; if (IN._n > 6 && IN._n <= 36) IN._s = (IN._s || 0) + dt; if (IN._n === 36) { const av = IN._s / 30 * 1000; MS.half = av > 20 && av < 36; } }
        simFrame(dt);
      };
      const simFrame = (dt, draw) => {
        dt = Math.min(0.05, dt);
        t += dt;
        if (IN.on) { if (IN.duo) { if (DU) duoPre(dt); } else introPre(dt); }
        if (IN.on || tAlive) trailTick(dt);
        C.mixer.update(dt); if (B) B.C.mixer.update(dt);
        if (!IN.on || IN.duo) pose(t);
        if (IN.on) { face(t); if (!IN.duo) introSnap(); }
        else { face(t); if (B) poseSeated(B, t + 7.3); }
        root.updateMatrixWorld(true);
        if (B) { if (IN.on) poseSeated(B, t + 7.3); B.root.updateMatrixWorld(true); }
        if (!IN.on) { tickSeatCols(A); if (B) tickSeatCols(B); }
        if (IN.duo && DU) duoPost();
        if (hair) { wind.set(IN.on ? (0.35 + 0.25 * Math.sin(t * 0.37)) : (0.08 + 0.05 * Math.sin(t * 0.31)), 0.01, IN.on ? (0.15 + 0.2 * Math.sin(t * 0.53 + 1)) : (0.04 + 0.03 * Math.sin(t * 0.47))); hair.params.wind.copy(wind); }
        if (B && B.hair && B.hair.params) { wind.set(IN.on ? (0.35 + 0.25 * Math.sin(t * 0.37 + 0.6)) : (0.08 + 0.05 * Math.sin(t * 0.31 + 0.6)), 0.01, IN.on ? (0.15 + 0.2 * Math.sin(t * 0.53 + 1.7)) : (0.04 + 0.03 * Math.sin(t * 0.47 + 0.8))); B.hair.params.wind.copy(wind); }
        if (IN.on && !IN.duo) introPost();
        for (let i = 0; i < NM; i++) { const o = i * 3; mp[o] += mv[o] * dt; mp[o + 1] += mv[o + 1] * dt + Math.sin(t * 0.7 + i) * 0.0008; mp[o + 2] += mv[o + 2] * dt; if (mp[o] > 6) mp[o] = -6; if (mp[o + 1] > 3.6) mp[o + 1] = 0; if (mp[o + 1] < 0) mp[o + 1] = 3.6; }
        mg.attributes.position.needsUpdate = true;
        key.intensity = 5.2 * (1 + 0.012 * Math.sin(t * 1.3));
        if (menuT >= 0) { const k = Math.min(1, (t - menuT) / 1.6); const e = k * k * (3 - 2 * k); glowL.intensity = glowR.intensity = 14 * e; }
        par.x += (par.tx - par.x) * 0.04; par.y += (par.ty - par.y) * 0.04;
        if (!IN.on || !IN.duo) camera.position.set(camBase.x + par.x * 0.35 + Math.sin(t * 0.13) * 0.12, camBase.y - par.y * 0.18 + Math.sin(t * 0.17) * 0.04, camBase.z + Math.sin(t * 0.09) * 0.08);
        else camera.position.set(camBase.x, camBase.y, camBase.z);
        if (FOC.phase === 1) { const k = Math.min(1, (t - FOC.t0) / 1.15); FOC.w = FOC.from + (1 - FOC.from) * (k * k * (3 - 2 * k)); if (k >= 1) { FOC.phase = 2; FOC.t0 = t; fs.t0 = t - 0.2; fs.wk = true; fs.auto = t + 12; } }
        else if (FOC.phase === 2) { FOC.w = 1; if (t - FOC.t0 > 3.0) { FOC.phase = 3; FOC.t0 = t; } }
        else if (FOC.phase === 3) { const k = Math.min(1, (t - FOC.t0) / 1.5); FOC.w = 1 - (k * k * (3 - 2 * k)); if (k >= 1) { FOC.phase = 0; FOC.w = 0; } }
        if (FOC.w > 0.001) {
          bones.Head.getWorldPosition(headW); tgtW.copy(headW); tgtW.y += 0.02;
          const dk = Math.max(1, Math.min(2.4, 1.0 / Math.max(0.3, camera.aspect)));
          tmpA.copy(camBase).sub(headW).setY(0).normalize();
          tmpC.set(-tmpA.z, 0, tmpA.x);
          closeP.copy(headW).addScaledVector(tmpA, 1.35 * dk).addScaledVector(tmpC, 1.0 * dk); closeP.y = headW.y + 0.17 * dk;
          const e = FOC.w, arc = Math.sin(Math.PI * e);
          camera.position.lerp(closeP, e); camera.position.y += arc * 0.28; camera.position.addScaledVector(tmpC, arc * 0.18);
          tgtW.copy(headW); tgtW.y -= 0.03; tgtW.addScaledVector(tmpC, -0.12);
          camera.lookAt(tmpB.lerpVectors(TARGET, tgtW, e));
        } else if (IN.on && IN.duo && DU) {
          duoCamera();
        } else if (IN.on) {
          const k = smooth(IN.T_WALK - 0.3, IN.T_STEP, IN.t);
          camera.position.x -= 2.2 * k; camera.position.y += 0.6 * k; camera.position.z += 3.4 * k;
          tmpA.set(TARGET.x - 2.3 * k, TARGET.y - 0.2 * k, TARGET.z - 1.2 * k);
          if (IN.t > IN.T_LIFT - 0.5) { bones.Hips.getWorldPosition(tmpC); tmpA.lerp(tmpC, 0.92 * smooth(0, 4.5, IN.t - (IN.T_LIFT - 0.5))); }
          camera.lookAt(tmpA);
        } else camera.lookAt(TARGET);
        if (MS._dbg) { camera.position.copy(MS._dbg.pos); camera.lookAt(MS._dbg.target); }
        if (cv.clientWidth !== lw || cv.clientHeight !== lh) { lw = cv.clientWidth; lh = cv.clientHeight; if (lw > 1) { fit(); adj = -120; ema = 16; } }
        if (draw !== false) { if (DU && DU.inBay && DU.bay) renderer.render(DU.bay.scene, DU.bay.cam); else renderer.render(scene, camera); }
        if (++framesSeen === 3 && !MS.ready) { MS.ready = true; cv.classList.add('ms-in'); document.dispatchEvent(new CustomEvent('menuscene-ready')); try { const mv = document.querySelector('.menu-version'); if (mv && !/scene b/.test(mv.textContent)) mv.textContent += ' · scene b7'; } catch (e) {} info('ready (' + (renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2') + ', pr ' + pr.toFixed(2) + ')'); }
      };
      raf = requestAnimationFrame(loop);
      MS._debugGrab = function () {
        try { if (DU && DU.inBay && DU.bay) renderer.render(DU.bay.scene, DU.bay.cam); else renderer.render(scene, camera); } catch (e) {}
        return cv.toDataURL("image/png");
      };
      MS._seek = function (tAbs) {
        if (!IN.on || !IN.duo || !DU) return { ok: false, reason: 'not-duo' };
        MS.paused = true;
        if (tAbs + 1e-4 < IN.t) return { ok: false, t: IN.t, reason: 'backward' };
        if (DU) DU.bayReady = true;   // seek is synchronous: the compile promise cannot resolve inside it (the hold is a real-time-only guard)
        if (DU && !DU.bay && tAbs >= (DU.tBay || 0) - 0.2) {
          try { DU.bay = buildBay(Math.max(A.du.Lb, B.du.Lb), Math.max(A.du.Wb, B.du.Wb)); DU.bay.cam.position.set(0, DU.bay.Hy * 0.5, DU.bay.Lz * 0.4); DU.bay.cam.lookAt(0, 1, 0); } catch (e) { info('seek bay', e && e.message); }
        }
        const step = 1 / 20; let n = 0;
        while (IN.t < tAbs - 1e-4 && n < 2400) {
          const sl = Math.min(step, tAbs - IN.t);
          const last = (IN.t + sl >= tAbs - 1e-4) || n >= 2399;
          simFrame(sl, last);
          n++;
        }
        const jets = !!(A && A.du && A.du.jets && A.du.jets.group && A.du.jets.group.visible);
        return { ok: true, t: IN.t, tDep: DU.tDep, tBay: DU.tBay, tFly: DU.tFly, tL: A && A.du && A.du.tL, inBay: !!DU.inBay, doorK: DU.doorK || 0, dissolve: DU._wop || 0, jets: jets };
      };
      MS._debugLaunch = async function (opt) {
        opt = opt || {};
        window.__MS_DEBUG = true; MS.paused = false;
        if (!MS.ready) {
          await MS.start();
          await new Promise((res) => { if (MS.ready) return res(); const to = setTimeout(res, 180000); document.addEventListener('menuscene-ready', () => { clearTimeout(to); res(); }, { once: true }); });
        }
        if (MS._ctx && MS._ctx.loadClips) await MS._ctx.loadClips();
        const t0 = performance.now();
        while (!(MS._ctx && MS._ctx.duoReady && MS._ctx.duoReady()) && performance.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 200));
        if (!(MS._ctx && MS._ctx.duoReady && MS._ctx.duoReady())) return { ok: false, reason: 'duo-not-ready' };
        const normalizeMenuBoard = (root) => {
          const drop = []; root.traverse((o) => { if (o.isLight || o.isCamera) drop.push(o); }); drop.forEach((o) => { if (o.parent) o.parent.remove(o); });
          root.updateMatrixWorld(true);
          root.traverse((o) => { if (o.isMesh && o.geometry) { o.geometry = o.geometry.clone(); o.geometry.applyMatrix4(o.matrixWorld); } });
          root.traverse((o) => { o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); });
          root.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
          const bakeRot = new THREE.Matrix4();
          if (size.y >= size.x && size.y >= size.z) bakeRot.makeRotationZ(Math.PI / 2);
          else if (size.z >= size.x) bakeRot.makeRotationY(-Math.PI / 2);
          const fullMat = bakeRot.multiply(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -ctr.z));
          root.traverse((o) => { if (o.isMesh && o.geometry) { o.geometry.applyMatrix4(fullMat); o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); } });
          root.updateMatrixWorld(true);
          const size2 = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
          root.scale.setScalar(3.0 / Math.max(size2.x, size2.y, size2.z, 0.001));   // BOARD_FALLBACK_GAME_LEN; menu intro then scales by herH * 37/6 / len0
          root.updateMatrixWorld(true);
          const deck = new THREE.Box3().setFromObject(root);
          root.userData.deckAnchor = { x: (deck.min.x + deck.max.x) / 2, y: deck.max.y, z: (deck.min.z + deck.max.z) / 2 };
          root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
          return root;
        };
        const cloneBoard = (src) => {
          const c = src.clone(true);
          c.traverse((o) => { if (!o.isMesh) return; try { if (o.geometry) o.geometry = o.geometry.clone(); } catch (e) {} try { if (Array.isArray(o.material)) o.material = o.material.map((m) => m && m.clone ? m.clone() : m); else if (o.material && o.material.clone) o.material = o.material.clone(); } catch (e) {} });
          c.userData.deckAnchor = src.userData.deckAnchor ? Object.assign({}, src.userData.deckAnchor) : src.userData.deckAnchor;
          return c;
        };
        const loadReal = async () => {
          const url = (opt && opt.boardUrl) || '/skyboard_B.glb';
          try {
            const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load(url, res, undefined, rej));
            return normalizeMenuBoard(gltf.scene);
          } catch (e) { info('debugLaunch board', e && e.message); return null; }
        };
        const mkFallback = () => {
          const g = new THREE.Group();
          const deck = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.08, 0.62), new THREE.MeshStandardMaterial({ color: 0x9a1c24, roughness: 0.42, metalness: 0.25 }));
          deck.castShadow = true; deck.receiveShadow = true; g.add(deck);
          const nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 5), new THREE.MeshBasicMaterial({ color: 0x5ce8ff, toneMapped: false })); nose.rotation.z = -Math.PI / 2; nose.position.x = 1.72; g.add(nose);
          g.userData.procFallback = true; g.userData.deckAnchor = { x: 0, y: 0.04, z: 0 }; return g;
        };
        let real = opt && opt.board ? opt.board : await loadReal();
        if (!real) real = mkFallback();
        const boardA = real, boardB = cloneBoard(real);
        const started = MS.introStart({ board: boardA, board2: boardB, syncBay: true, sharedTex: false, sharedTex2: false, ratio: 37 / 6, onFlyOff: function () {} });
        if (started && started.then) await started;
        MS.paused = true;
        return { ok: !!IN.on && !!IN.duo, tDep: DU && DU.tDep, tBay: DU && DU.tBay, tFly: DU && DU.tFly, tL: A && A.du && A.du.tL };
      };
      MS._ctx = { introStart, introReset, introPrecompile, intro: IN, duo: () => DU, pilots: () => [A, B], duoReady: () => { try { return DUO_READY(); } catch (e) { return false; } }, loadClips: () => Promise.all([loadClips(A), loadClips(B)]), focus: startFocus, FOC, renderer, scene, camera, hair: () => hair, pose, setMenuOpen: () => { menuT = t; }, cv, holder, root, boulder, ground, P, bones, seek: (...a) => MS._seek && MS._seek(...a), debugLaunch: (...a) => MS._debugLaunch && MS._debugLaunch(...a) };
      MS.dispose = function () {
        MS.disposed = true; MS.ready = false; cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize); window.removeEventListener('pointermove', onPtr); window.removeEventListener('pointerdown', onDown); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
        try { if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize); } catch (e) {}
        try { hair && hair.dispose && hair.dispose(); } catch (e) {}
        try { if (B && B.hair && B.hair.dispose) B.hair.dispose(); } catch (e) {}
        try { if (DU) duoReset(); } catch (e) {}
        try { scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose && m.dispose()); }); noiseTex.dispose(); renderer.dispose(); } catch (e) {}
        try { cv.remove(); } catch (e) {}
        MS._p = null; MS._ctx = null; MS.started = false;
      };
    })().catch(function (e) {
      MS.failed = true; console.warn('[menuscene] unavailable — star scene only:', e && e.message ? e.message : e);
      try { const c = document.getElementById('menu-scene-canvas'); c && c.remove(); } catch (_) {}
      document.dispatchEvent(new CustomEvent('menuscene-failed'));
    });
    return MS._p;
  };
  MS.menuOpen = function () { try { MS._ctx && MS._ctx.setMenuOpen(); } catch (e) { } MS._menuOpenWanted = true; };
  MS.introStart = function (o) { const c = MS._ctx; return c && c.introStart ? c.introStart(o) : false; };
  MS.seek = function (tAbs) { return MS._seek ? MS._seek(tAbs) : { ok: false, reason: 'not-started' }; };
  MS.debugGrab = function () { return MS._debugGrab ? MS._debugGrab() : null; };
  MS.debugLaunch = async function (opt) { await MS.start(); if (MS._debugLaunch) return MS._debugLaunch(opt); return { ok: false, reason: 'no-hook' }; };
  MS.introPrecompile = function (b) { const c = MS._ctx; return c && c.introPrecompile ? c.introPrecompile(b) : Promise.resolve(false); };
  MS.introReset = function () { try { MS._ctx && MS._ctx.introReset(); } catch (e) { } };
  MS.pause = function () { MS.paused = true; };
  MS.resume = function () { if (MS._resetT) { clearTimeout(MS._resetT); MS._resetT = 0; try { MS.introReset(); } catch (e) { } } MS.paused = false; if (MS.disposed) { MS.disposed = false; MS._p = null; MS.start(); } };
})();
