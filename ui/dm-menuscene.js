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
      const sc = { pr: Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2) * (G.resScale && G.resScale < 1 ? G.resScale : 1), shadow: lowTier ? 1024 : (mobile ? 1536 : 2048), hair: lowTier ? 0.55 : (mobile ? 0.8 : 1) };
      const q = location.search || ''; const qs = (k, d) => { const m = q.match(new RegExp('[?&]' + k + '=([^&]*)')); return m ? decodeURIComponent(m[1]) : d; };
      if (qs('msq', '')) sc.pr = Math.min(sc.pr, parseFloat(qs('msq', '1')) || 1);

      /* renderer */
      const renderer = new THREE.WebGPURenderer({ canvas: cv, antialias: !lowTier, alpha: true, powerPreference: 'high-performance' });
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
        const needH = 2.45, needW = 3.5;
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
      scene.updateMatrixWorld(true);

      /* horizon haze behind everything (glows red where the star sky meets the ridges) */
      {
        const T = THREE.TSL, hm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
        const y = T.uv().y;
        hm.colorNode = T.mix(T.vec3(0.55, 0.14, 0.05), T.vec3(0.30, 0.06, 0.09), T.smoothstep(0.0, 0.6, y));
        hm.opacityNode = T.pow(T.float(1).sub(T.smoothstep(0.0, 1.0, y)), T.float(2.2)).mul(0.62);
        const haze = new THREE.Mesh(new THREE.PlaneGeometry(260, 34), hm); haze.position.set(0, 9, -88); haze.renderOrder = -5; scene.add(haze);
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

      /* Ariel */
      const holder = new THREE.Object3D(); scene.add(holder);
      const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load(CHAR_URL, res, undefined, rej));
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
      const YAW = -Math.PI * 0.22;                      // character +Z (forward) → world −X
      holder.rotation.y = YAW;
      const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
      const surfY = (x, z, extra) => { ray.set(new THREE.Vector3(x, 6, z), down); const hits = ray.intersectObjects(extra || [boulder, ground], false); return hits.length ? hits[0].point.y : 0; };
      const SEAT_X = 0.2;
      const hipsRoot = new THREE.Vector3(0, 0.80, -0.04);
      const place = () => { holder.updateMatrixWorld(true); const wp = holder.localToWorld(hipsRoot.clone()); holder.position.x += SEAT_X - wp.x; holder.position.z += 0 - wp.z;
        holder.position.y += (surfY(SEAT_X, 0, [boulder]) + 0.115) - wp.y; holder.updateMatrixWorld(true); };
      place(); place();
      const toRoot = (wx, wz, lift) => { const y = Math.max(surfY(wx, wz, [boulder]), surfY(wx, wz, [ground]) ) + lift; return holder.worldToLocal(new THREE.Vector3(wx, y, wz)); };
      // foot targets (root space): near (her left) foot up on the boulder's front slope, far foot lower & further out
      const fwd = (f, s) => { const w = holder.localToWorld(new THREE.Vector3(s, 0, f)); return [w.x, w.z]; };
      const ankleL = (() => { const [x, z] = fwd(0.34, 0.14); return toRoot(x, z, 0.105); })();
      const ankleR = (() => { const [x, z] = fwd(0.72, -0.16); return toRoot(x, z, 0.105); })();

      /* hair: build via buildHair directly so nothing leaks into window.DART_HAIR */
      let hair = null;
      (async () => { try {
        const [mod, buf] = await Promise.all([import('../hair_strands.js'), fetch(HAIR_URL).then(r => { if (!r.ok) throw new Error('hair ' + r.status); return r.arrayBuffer(); })]);
        if (MS.disposed) return;
        hair = mod.buildHair({ root, bones, mixer: C.mixer }, THREE, buf, { getStrandFraction: () => sc.hair, getGravityScale: () => 1, params: { windGust: 0.5 } });
        info('strand hair attached');
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
      const handDown = (side, k) => {
        const H = bones[side + 'Hand'], M = bones[side + 'HandMiddle1'], I = bones[side + 'HandIndex1'], K = bones[side + 'HandPinky1']; if (!H || !M || !I || !K) return;
        H.updateWorldMatrix(true, true);
        H.getWorldPosition(_hp); M.getWorldPosition(_ha).sub(_hp).normalize(); I.getWorldPosition(_hl); K.getWorldPosition(_ht); _hl.sub(_ht).normalize();
        if (side === 'Left') _hn.crossVectors(_ha, _hl); else _hn.crossVectors(_hl, _ha); _hn.normalize().negate();   // (cross = back of hand; palm is opposite)
        _ht.copy(_DN).addScaledVector(_ha, -_ha.dot(_DN)).normalize();                 // down, flattened across the hand's own axis
        const phi = Math.atan2(_ha.dot(_ht.clone().crossVectors(_hn, _ht)), _hn.dot(_ht)) * k;
        _q1.setFromAxisAngle(_ha, Math.max(-2.2, Math.min(2.2, phi)));
        H.parent.getWorldQuaternion(_q2); H.quaternion.premultiply(_q2.clone().invert().multiply(_q1).multiply(_q2));
      };
      function pose(t) {
        const br = Math.sin(t * 1.35), br2 = Math.sin(t * 0.67 + 1.1);
        const rw = reachAt(t);
        // weight shift + hips (seat is fixed, tiny sway)
        Hp.copy(hipsRoot); Hp.x += 0.004 * Math.sin(t * 0.31); Hp.y += 0.003 * br;
        tmpW.copy(Hp).applyMatrix4(holder.matrixWorld); const par = bones.Hips.parent; par.updateWorldMatrix(true, false); par.worldToLocal(tmpW); bones.Hips.position.copy(tmpW);
        P.rot('Hips', 8 + 1.5 * br2, 3 + 0.5 * br, 1.0 * br2);
        const lean = 6 + 2.2 * Math.sin(t * 0.21) - rw * 4, twist = 4 + 5 * Math.sin(t * 0.13) + rw * 8;   // toward the camera / menu
        P.rot('Spine02', 8 + twist * 0.25, 1 + lean * 0.3 + 0.6 * br, 0);
        P.rot('Spine01', 8 + twist * 0.5, 2 + lean * 0.55 + 0.8 * br, 0);
        P.rot('Spine', 8 + twist * 0.8, 3 + lean * 0.85 + 0.9 * br, 0);
        const sweep = Math.sin(t * 0.21) + 0.45 * Math.sin(t * 0.53 + 0.8), lookYaw0 = 12 + 17 * sweep + 4 * Math.sin(t * 1.1) - rw * 14, lookYaw = lookYaw0, lookPitch0 = -9 + 9 * Math.sin(t * 0.17 + 2.0) + 2.5 * Math.sin(t * 0.43) + 1.2 * br, lookPitch = lookPitch0;   // slow sweeps: away toward the menu / up at the stars / round to the camera
        P.rot('neck', 8 + lookYaw * 0.35, lookPitch * 0.4, 0.8 * Math.sin(t * 0.19));
        P.rot('Head', 8 + lookYaw * 0.9, lookPitch, 1.2 * Math.sin(t * 0.19 + 0.5));
        // legs: IK to planted feet, knee up on the near side
        P.leg(P.S.limb.legL, ankleL, poleL, 1); P.rot('LeftFoot', 0, -10, 0);
        P.leg(P.S.limb.legR, ankleR, poleR, 1); P.rot('RightFoot', 0, -38, 0);
        // arms: far arm rests on the thigh, near arm on the knee → reaches toward the menu now and then
        const yaw = THREE.MathUtils.degToRad(8 + twist * 0.8);
        const dir = (a, out) => out.copy(a).applyAxisAngle(P.Y, yaw);
        const sw = 0.012 * br;
        const upL = tmpA.copy(Rest.upL).lerp(Reach.upL, rw).normalize(), foL = tmpB.copy(Rest.foreL).lerp(Reach.foreL, rw).normalize();
        upL.y += sw; foL.y += sw * 0.5;
        P.limb(P.S.limb.armL, dir(upL.normalize(), P.S.v[17]), dir(foL.normalize(), P.S.v[18]), 1, 0);
        P.limb(P.S.limb.armR, dir(Rest.upR, P.S.v[17]), dir(Rest.foreR, P.S.v[18]), 1, 0);
        handDown('Left', 1); handDown('Right', 1);
        return rw;
      }
      pose(0); root.updateMatrixWorld(true);
      // a first look at the hip pose so shoulders sit sensibly even before the first frame
      /* camera + render loop */
      const clock = new THREE.Clock(); let t = 0, last = performance.now(), ema = 16, adj = 0, menuT = -1, framesSeen = 0;
      const onResize = () => fit();
      window.addEventListener('resize', onResize); if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
      fit();
      const par = { x: 0, y: 0, tx: 0, ty: 0 };
      const onPtr = (e) => { const p = e.touches ? e.touches[0] : e; if (!p) return; par.tx = (p.clientX / window.innerWidth - 0.5); par.ty = (p.clientY / window.innerHeight - 0.5); };
      window.addEventListener('pointermove', onPtr, { passive: true });
      const startFocus = () => { if (FOC.phase === 1 || FOC.phase === 2) { if (FOC.phase === 2) FOC.t0 = t; return; } FOC.from = FOC.w; FOC.phase = 1; FOC.t0 = t; };
      const okTarget = (el) => !(el && el.closest && el.closest('.mm-panel,button,a,input,select,textarea,.modal,.modal-box,#account-chip,#float-music,[onclick]'));
      let gx = 0, gy = 0, gOk = false, gDone = false;
      const onDown = (e) => { const p = e.touches ? e.touches[0] : e; gx = p.clientX; gy = p.clientY; gOk = okTarget(e.target); gDone = false; };
      const onMove = (e) => { if (!gOk || gDone) return; const p = e.touches ? e.touches[0] : e; if (!p) return; if (Math.hypot(p.clientX - gx, p.clientY - gy) > 22 && (e.buttons || e.touches)) { gDone = true; startFocus(); } };
      const onUp = (e) => { if (gOk && !gDone && okTarget(e.target)) { gDone = true; startFocus(); } };
      window.addEventListener('pointerdown', onDown, { passive: true }); window.addEventListener('pointermove', onMove, { passive: true }); window.addEventListener('pointerup', onUp, { passive: true });
      let raf = 0; const wind = new THREE.Vector3();
      const loop = (now) => {
        raf = requestAnimationFrame(loop); MS._raf = raf;
        if (MS.paused || document.hidden) { last = now; return; }
        const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
        ema += (dt * 1000 - ema) * 0.04;
        if (++adj > 90) { adj = 0; if (ema > 36 && pr > sc.pr * 0.5) { pr = Math.max(0.5, pr - 0.15); fit(); } else if (ema < 20 && pr < sc.pr) { pr = Math.min(sc.pr, pr + 0.1); fit(); } }
        pose(t); face(t); root.updateMatrixWorld(true);
        if (hair) { wind.set(0.35 + 0.25 * Math.sin(t * 0.37), 0.02, 0.15 + 0.2 * Math.sin(t * 0.53 + 1)); hair.params.wind.copy(wind); }
        C.mixer.update(dt);
        // dust motes drift on the wind
        for (let i = 0; i < NM; i++) { const o = i * 3; mp[o] += mv[o] * dt; mp[o + 1] += mv[o + 1] * dt + Math.sin(t * 0.7 + i) * 0.0008; mp[o + 2] += mv[o + 2] * dt; if (mp[o] > 6) mp[o] = -6; if (mp[o + 1] > 3.6) mp[o + 1] = 0; if (mp[o + 1] < 0) mp[o + 1] = 3.6; }
        mg.attributes.position.needsUpdate = true;
        // light life + menu glow ramp
        key.intensity = 5.2 * (1 + 0.012 * Math.sin(t * 1.3));
        if (menuT >= 0) { const k = Math.min(1, (t - menuT) / 1.6); const e = k * k * (3 - 2 * k); glowL.intensity = glowR.intensity = 14 * e; }
        // camera: slow breathing orbit + pointer parallax
        par.x += (par.tx - par.x) * 0.04; par.y += (par.ty - par.y) * 0.04;
        camera.position.set(camBase.x + par.x * 0.35 + Math.sin(t * 0.13) * 0.12, camBase.y - par.y * 0.18 + Math.sin(t * 0.17) * 0.04, camBase.z + Math.sin(t * 0.09) * 0.08);
        // close-up reaction: ease in on her face, hold ~3 s while she looks up at the stars, ease back out
        if (FOC.phase === 1) { const k = Math.min(1, (t - FOC.t0) / 1.15); FOC.w = FOC.from + (1 - FOC.from) * (k * k * (3 - 2 * k)); if (k >= 1) { FOC.phase = 2; FOC.t0 = t; fs.t0 = t - 0.2; fs.wk = true; fs.auto = t + 12; } }
        else if (FOC.phase === 2) { FOC.w = 1; if (t - FOC.t0 > 3.0) { FOC.phase = 3; FOC.t0 = t; } }
        else if (FOC.phase === 3) { const k = Math.min(1, (t - FOC.t0) / 1.5); FOC.w = 1 - (k * k * (3 - 2 * k)); if (k >= 1) { FOC.phase = 0; FOC.w = 0; } }
        if (FOC.w > 0.001) {
          bones.Head.getWorldPosition(headW); tgtW.copy(headW); tgtW.y += 0.02;
          // swoop: lift up and sweep in from her right (screen-left), looking down across her eyes; the stars stay behind her
          const dk = Math.max(1, Math.min(2.4, 1.0 / Math.max(0.3, camera.aspect)));   // tall phone screens: stand further back so her whole head fits
          tmpA.copy(camBase).sub(headW).setY(0).normalize();            // out toward the viewer
          tmpC.set(-tmpA.z, 0, tmpA.x);                                  // screen-left of that
          closeP.copy(headW).addScaledVector(tmpA, 1.35 * dk).addScaledVector(tmpC, 1.0 * dk); closeP.y = headW.y + 0.17 * dk;
          const e = FOC.w, arc = Math.sin(Math.PI * e);
          camera.position.lerp(closeP, e); camera.position.y += arc * 0.28; camera.position.addScaledVector(tmpC, arc * 0.18);
          tgtW.copy(headW); tgtW.y -= 0.03; tgtW.addScaledVector(tmpC, -0.12);
          camera.lookAt(tmpB.lerpVectors(TARGET, tgtW, e));
        } else camera.lookAt(TARGET);
        if (MS._dbg) { camera.position.copy(MS._dbg.pos); camera.lookAt(MS._dbg.target); }
        renderer.render(scene, camera);
        if (++framesSeen === 3 && !MS.ready) { MS.ready = true; cv.classList.add('ms-in'); document.dispatchEvent(new CustomEvent('menuscene-ready')); try { const mv = document.querySelector('.menu-version'); if (mv && !/scene b/.test(mv.textContent)) mv.textContent += ' · scene b6'; } catch (e) {} info('ready (' + (renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2') + ', pr ' + pr.toFixed(2) + ')'); }
      };
      raf = requestAnimationFrame(loop);
      MS._ctx = { focus: startFocus, FOC, renderer, scene, camera, hair: () => hair, pose, setMenuOpen: () => { menuT = t; }, cv, holder, root, boulder, ground, P, bones };
      MS.dispose = function () {
        MS.disposed = true; MS.ready = false; cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); window.removeEventListener('pointermove', onPtr); window.removeEventListener('pointerdown', onDown); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
        try { if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize); } catch (e) {}
        try { hair && hair.dispose && hair.dispose(); } catch (e) {}
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
  MS.pause = function () { MS.paused = true; };
  MS.resume = function () { MS.paused = false; if (MS.disposed) { MS.disposed = false; MS._p = null; MS.start(); } };
})();
