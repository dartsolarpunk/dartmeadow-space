/* dm-facilities.js — landmarks built into the planet world (PW.scene): cliffside aerospace facilities (Earth ×2, Mars, Titan),
 * the ocean cities, and Ariel's cliff mansion on Solenne.
 *
 * Everything is placed by SAMPLING THE WORLD'S OWN HEIGHT FIELD (a coarse, time-sliced search for the steepest / coastal spot
 * near each landmark's lat/lon), so it works on any seeded terrain and is the same for every player. Nothing here draws from a
 * world random stream. Terrain is never edited: the structures carry their own foundations, and a height hook
 * (DMFac.wrapH → TERRAIN.H / _atmoHeight) lets the board and her feet stand on decks, landing pads and the mansion.
 *
 * Titan's facility has an enclosed hangar behind a haze-filled airlock membrane. Hook for the hazard-orb worker:
 *   window 'dm:bay' CustomEvent  detail {id:'titan', inside:bool, membrane:0..1}     (on inside flips + while crossing, ≤12 Hz)
 *   window.DM_FAC.bay = {inside, membrane}                                         (kept current every frame, no allocation)
 * membrane is 0 outside the airlock skin, rises to 1 as the character group crosses it, and `inside` is true in the bay.
 */
(function () {
  'use strict';
  const F = window.DMFac = { ctx: null, sites: new Map(), solids: [], scene: null, ver: '292' };
  const DM = window.DM_FAC = window.DM_FAC || {};
  DM.bay = DM.bay || { inside: false, membrane: 0 };
  F.bind = c => { F.ctx = c; };
  const SEA = 0;                       // the sea sheet sits at y = 0 in the planet frame
  let M = null, TX = null;             // shared materials / textures (made on first build, kept)

  // ── materials ────────────────────────────────────────────────────────────────────────────────────────────
  function noiseTex(THREE, seed, tint) {       // tileable soft blotches (haze / cloud) — drawn once
    const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d');
    let s = seed >>> 0; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 46; i++) {
      const x = rnd() * S, y = rnd() * S, r = 10 + rnd() * 26, a = 0.10 + rnd() * 0.22;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, 'rgba(' + tint + ',' + a.toFixed(3) + ')'); gr.addColorStop(1, 'rgba(' + tint + ',0)');
        g.fillStyle = gr; g.fillRect(0, 0, S, S);
      }
    }
    const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function stripeTex(THREE) {                  // lit window bands for the glass towers (emissive map)
    const cv = document.createElement('canvas'); cv.width = 8; cv.height = 64; const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 8, 64);
    for (let y = 4; y < 64; y += 8) { g.fillStyle = (y / 8) % 3 ? '#ffe0a8' : '#9fd0ff'; g.fillRect(0, y, 8, 3); }
    const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function mats(THREE) {
    if (M) return M;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    TX = { haze: noiseTex(THREE, 77, '230,170,100'), cloud: noiseTex(THREE, 913, '245,248,255'), win: stripeTex(THREE) };
    M = {
      comp: std({ color: 0x15171d, metalness: 0.75, roughness: 0.38 }),
      compMars: std({ color: 0x1d1613, metalness: 0.7, roughness: 0.45 }),
      deck: std({ color: 0x0d0f15, metalness: 0.6, roughness: 0.10 }),
      trim: std({ color: 0x2a2e38, metalness: 0.8, roughness: 0.3 }),
      glass: std({ color: 0x1b3a58, metalness: 0.25, roughness: 0.04, transparent: true, opacity: 0.40, depthWrite: false }),
      neonP: new THREE.MeshBasicMaterial({ color: 0xa25cff, toneMapped: false }),
      neonB: new THREE.MeshBasicMaterial({ color: 0x3aa8ff, toneMapped: false }),
      neonC: new THREE.MeshBasicMaterial({ color: 0x55e8ff, toneMapped: false }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xffe2b0, toneMapped: false }),
      haze: new THREE.MeshBasicMaterial({ map: TX.haze, color: 0xffc27a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
      tower: std({ color: 0xb4dcf2, metalness: 0.85, roughness: 0.08, emissive: 0xffffff, emissiveMap: TX.win, emissiveIntensity: 0.9 }),
      island: std({ color: 0x3e6c48, roughness: 0.95 }),
      cliff: std({ color: 0x6b6558, roughness: 0.95 }),
      paving: std({ color: 0x9aa3ad, roughness: 0.7 }),
      sand: std({ color: 0xc8b88e, roughness: 1 }),
      cable: std({ color: 0xd6dde8, metalness: 0.8, roughness: 0.3 }),
      cloud: new THREE.MeshBasicMaterial({ map: TX.cloud, color: 0xeef3fa, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide })
    };
    return M;
  }

  // ── geometry helpers (build-time only) ──────────────────────────────────────────────────────────────────
  const G = {
    box(T, g, mat, w, h, d, x, y, z, ry) { const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); if (ry) m.rotation.y = ry; g.add(m); return m; },
    // a slab from an (x,z) polygon: top at y0+h, bottom at y0
    slab(T, g, mat, pts, y0, h) {
      const sh = new T.Shape(); pts.forEach((p, i) => i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]));
      const ge = new T.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false }); ge.rotateX(Math.PI / 2); ge.translate(0, y0 + h, 0);
      const m = new T.Mesh(ge, mat); g.add(m); return m;
    },
    // a prism from a side profile (z,y) extruded across x (centred)
    prof(T, g, mat, pts, width, x) {
      const sh = new T.Shape(); pts.forEach((p, i) => i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]));
      const ge = new T.ExtrudeGeometry(sh, { depth: width, bevelEnabled: false }); ge.rotateY(-Math.PI / 2); ge.translate(width / 2 + (x || 0), 0, 0);
      const m = new T.Mesh(ge, mat); g.add(m); return m;
    },
    strut(T, g, mat, a, b, t) {      // a thin raked beam from point a to b
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz);
      const m = new T.Mesh(new T.BoxGeometry(t, t, L), mat); m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      m.lookAt(b[0], b[1], b[2]); g.add(m); return m;
    },
    edge(T, g, mat, poly, y, w) {     // neon strip along each edge of a polygon, just inside it
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
        const m = new T.Mesh(new T.BoxGeometry(L - 0.6, 0.16, w || 0.32), i % 2 ? M.neonB : mat);
        m.position.set((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2); m.rotation.y = -Math.atan2(dz, dx); g.add(m);
      }
    }
  };
  const inPoly = (poly, x, z) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if (((a[1] > z) !== (b[1] > z)) && (x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0])) c = !c; } return c; };

  // ── the cliff facility ──────────────────────────────────────────────────────────────────────────────────
  // local frame: origin at the cliff lip at deck level, +Z seaward (down the slope), +Y up. Returns {group, solids, bay}.
  function buildFacility(T, variant) {
    const m = mats(T), g = new T.Group(), sol = [];
    const mars = variant === 'mars', titan = variant === 'titan', mir = variant === 'earth-b' ? -1 : 1;
    const hull = mars ? m.compMars : m.comp;
    const X = x => x * mir;
    // deck — a polished arrowhead pad that juts over the drop
    const deckPoly = [[-24, -8], [24, -8], [30, 16], [0, 56], [-30, 16]].map(p => [X(p[0]), p[1]]);
    if (mir < 0) deckPoly.reverse();
    G.slab(T, g, m.deck, deckPoly, -1.5, 1.5);
    G.edge(T, g, m.neonP, deckPoly, 0.08, 0.34);
    G.edge(T, g, m.neonB, deckPoly.map(p => [p[0] * 0.98, p[1] * 0.98]), -1.55, 0.5);
    const ring = new T.Mesh(new T.RingGeometry(8.2, 8.9, 48), m.neonB); ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.05, 28); g.add(ring);
    const ring2 = new T.Mesh(new T.RingGeometry(3.4, 3.8, 32), m.neonP); ring2.rotation.x = -Math.PI / 2; ring2.position.set(0, 0.05, 28); g.add(ring2);
    sol.push({ poly: deckPoly, y: 0 });
    // foundation block + raked struts into the cliff
    G.box(T, g, hull, 56, 80, 36, 0, -41, -22);
    for (const sx of [-18, 0, 18]) G.strut(T, g, m.trim, [X(sx), -1.5, 34], [X(sx * 0.7), -70, -2], 1.6);
    for (const sx of [-22, 22]) G.strut(T, g, m.trim, [X(sx), -1.5, 14], [X(sx), -60, -6], 1.2);
    if (!titan) {
      // main block, glass band, sloped roof, upper blade, mast
      G.box(T, g, hull, 56, 9, 30, 0, 4.5, -21);
      G.box(T, g, m.glass, 50, 5, 0.5, X(0), 4.4, -5.8);
      G.box(T, g, m.neonB, 50, 0.16, 0.3, X(0), 7.1, -5.6); G.box(T, g, m.neonP, 50, 0.16, 0.3, X(0), 1.8, -5.6);
      G.prof(T, g, hull, [[-36, 9], [-6, 9], [-6, 10.2], [-36, 18]], 56, 0);
      G.box(T, g, hull, 14, 13, 16, X(-14), 15.5, -24, 0.35 * mir); G.box(T, g, m.glass, 14.2, 3.4, 0.4, X(-14), 17, -15.9, 0.35 * mir);
      G.box(T, g, m.trim, 0.7, 16, 0.7, X(19), 17, -30); G.box(T, g, m.neonP, 1.1, 0.8, 1.1, X(19), 25.5, -30);
      // hangar door on the deck side: a lit angled canopy
      G.prof(T, g, m.trim, [[-6, 9], [10, 7.4], [10, 8.2], [-6, 10.2]], 30, X(-4));
      G.box(T, g, m.lamp, 26, 0.12, 0.5, X(-4), 7.2, 9.9);
    }
    let bay = null;
    if (titan) {
      // an enclosed hangar: floor continues inside, walls + roof, a wide opening toward the sea behind a haze membrane
      const W = 40, Lh = 44, Hh = 14;
      G.box(T, g, m.deck, W + 4, 1.5, Lh + 6, 0, -0.75, -(Lh + 6) / 2 + 3);
      G.box(T, g, hull, 2, Hh + 2, Lh, -(W / 2 + 1), Hh / 2, -Lh / 2 - 4);           // side walls
      G.box(T, g, hull, 2, Hh + 2, Lh, (W / 2 + 1), Hh / 2, -Lh / 2 - 4);
      G.box(T, g, hull, W + 4, Hh + 2, 2, 0, Hh / 2, -Lh - 5);                          // back wall
      G.prof(T, g, hull, [[-Lh - 5, Hh], [-3, Hh], [-3, Hh + 2.4], [-Lh - 5, Hh + 9]], W + 4, 0);   // roof wedge
      G.box(T, g, hull, 8, Hh, 2.4, -(W / 2 - 3.5), Hh / 2, -4.2); G.box(T, g, hull, 8, Hh, 2.4, (W / 2 - 3.5), Hh / 2, -4.2);   // door piers
      G.box(T, g, hull, W, 3.4, 2.4, 0, Hh - 1.7, -4.2);                               // lintel
      G.box(T, g, m.neonC, W - 1, 0.2, 0.3, 0, Hh - 3.55, -2.9);                       // door-frame neon
      G.box(T, g, m.neonC, 0.2, Hh - 3.4, 0.3, -(W / 2 - 7.4), (Hh - 3.4) / 2, -2.9); G.box(T, g, m.neonC, 0.2, Hh - 3.4, 0.3, (W / 2 - 7.4), (Hh - 3.4) / 2, -2.9);
      G.box(T, g, m.lamp, W - 8, 0.12, 2.2, 0, Hh - 0.1, -22); G.box(T, g, m.lamp, W - 8, 0.12, 2.2, 0, Hh - 0.1, -34);   // ceiling light panels
      G.box(T, g, m.neonB, 0.3, 0.14, Lh - 4, -(W / 2 - 3), 0.08, -Lh / 2 - 4); G.box(T, g, m.neonB, 0.3, 0.14, Lh - 4, (W / 2 - 3), 0.08, -Lh / 2 - 4);   // floor guide strips
      G.box(T, g, m.trim, 1, 22, 1, X(24), 21, -20); G.box(T, g, m.neonP, 1.4, 0.8, 1.4, X(24), 32.4, -20);   // mast
      // the airlock membrane: a haze skin across the opening, two softer skins behind it
      const hw = (W - 16) / 2 + 0.1, hh = Hh - 3.4;
      const mem = [];
      for (let i = 0; i < 3; i++) {
        const mt = m.haze.clone(); mt.map = TX.haze.clone(); mt.map.needsUpdate = true; mt.map.repeat.set(2 - i * 0.3, 1.2); mt.opacity = [0.46, 0.30, 0.22][i];
        const p = new T.Mesh(new T.PlaneGeometry(hw * 2, hh, 8, 4), mt); p.position.set(0, hh / 2, -3.4 - i * 1.7); p.renderOrder = 3 + i; g.add(p); mem.push(p);
      }
      // haze that fills the bay (depth layers, drifting)
      for (let i = 0; i < 4; i++) {
        const mt = m.haze.clone(); mt.map = TX.haze.clone(); mt.map.needsUpdate = true; mt.map.repeat.set(2.4, 1); mt.opacity = 0.10;
        const p = new T.Mesh(new T.PlaneGeometry(W - 2, Hh - 1, 6, 3), mt); p.position.set(0, (Hh - 1) / 2, -13 - i * 8); p.renderOrder = 2; g.add(p); mem.push(p);
      }
      sol.push({ rect: [-W / 2, -Lh - 4, W / 2, 0.5], y: 0 });
      // volumes in local coords: x ±hw, y 0..hh, membrane z -3.4-1.7*2-0.6 .. -2.8 ; interior beyond
      bay = { id: 'titan', hw, hh, zOut: -2.8, zIn: -3.4 - 1.7 * 2 - 0.6, zBack: -Lh - 4, meshes: mem };
    }
    // glass fins on every variant (a tinted canopy over the landing side)
    G.box(T, g, m.glass, 0.5, 6, 30, X(-27), 2.7, 12, 0); G.box(T, g, m.glass, 0.5, 6, 30, X(27), 2.7, 12, 0);
    return { group: g, solids: sol, bay };
  }

  // ── ocean city ───────────────────────────────────────────────────────────────────────────────────────────
  function buildCity(T, seed) {
    const m = mats(T), g = new T.Group(), sol = [];
    let s = seed >>> 0; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const isl = [{ x: 0, z: 0, r: 64 }];
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2 + 0.4, d = 215 + rnd() * 50; isl.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 36 + rnd() * 16 }); }
    isl.push({ x: -380, z: 120, r: 30 });
    const treeN = 220, trees = new T.InstancedMesh(new T.ConeGeometry(1.4, 5, 5), m.island, treeN), mt4 = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), ps = new T.Vector3();
    let tn = 0;
    isl.forEach((o, k) => {
      const ce = new T.Mesh(new T.CylinderGeometry(o.r + 4, o.r + 9, 46, 36, 1, true), m.cliff); ce.position.set(o.x, -20, o.z); g.add(ce);
      const beach = new T.Mesh(new T.CylinderGeometry(o.r + 4, o.r + 4, 1.4, 36), m.sand); beach.position.set(o.x, 2.3, o.z); g.add(beach);
      const top = new T.Mesh(new T.CylinderGeometry(o.r, o.r + 1, 1.2, 36), m.island); top.position.set(o.x, 2.9, o.z); g.add(top);
      const pave = new T.Mesh(new T.RingGeometry(o.r * 0.28, o.r * 0.34, 36), m.paving); pave.rotation.x = -Math.PI / 2; pave.position.set(o.x, 3.55, o.z); g.add(pave);
      sol.push({ circle: [o.x, o.z, o.r + 3], y: 3.5 });
      const nT = k === 0 ? 3 : (k % 2 ? 2 : 1);
      for (let t = 0; t < nT; t++) {
        const a = rnd() * 6.283 + t * 2.1, rr = k === 0 ? (t ? 30 : 0) : (nT > 1 ? 14 : 0), H = 150 + rnd() * 130 * (k === 0 ? 1.25 : 1);
        const prof = [[0.01, 0], [8, 0], [6.8, H * 0.2], [5.4, H * 0.46], [7.6, H * 0.74], [11.5, H * 0.97], [9, H], [0.01, H]].map(p => new T.Vector2(p[0], p[1]));
        const lg = new T.LatheGeometry(prof, 22), tw = new T.Mesh(lg, m.tower);
        tw.position.set(o.x + Math.cos(a) * rr, 3.5, o.z + Math.sin(a) * rr); g.add(tw);
        sol.push({ col: 'cyl', x: tw.position.x, z: tw.position.z, y0: 3.5, y1: 3.5 + H, r: 6.5, mat: 'stone' });   // (landfix) the tower is a solid column for DMCollide
        const cap = new T.Mesh(new T.CylinderGeometry(0.25, 0.25, 22, 6), m.trim); cap.position.set(tw.position.x, 3.5 + H + 10, tw.position.z); g.add(cap);
        const tip = new T.Mesh(new T.SphereGeometry(0.7, 8, 6), m.neonP); tip.position.set(tw.position.x, 3.5 + H + 21, tw.position.z); g.add(tip);
      }
      const n = Math.min(treeN - tn, 34);
      for (let i = 0; i < n; i++) {
        const a = rnd() * 6.283, rr = o.r * (0.45 + rnd() * 0.5), h = 0.8 + rnd() * 1.1;
        ps.set(o.x + Math.cos(a) * rr, 3.5 + 2.5 * h, o.z + Math.sin(a) * rr); sc.set(h, h, h); mt4.compose(ps, q, sc); trees.setMatrixAt(tn++, mt4);
        sol.push({ col: 'cyl', x: ps.x, z: ps.z, y0: 3.5, y1: 3.5 + 5 * h, r: 0.55 * h + 0.15, mat: 'wood' });   // (landfix) island trees are solid trunks (cone: the trunk core, not the crown base)
      }
    });
    trees.count = tn; trees.instanceMatrix.needsUpdate = true; g.add(trees);
    // suspension bridges: centre to each ring island, ring neighbours, one long span
    const links = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [3, 4], [5, 6]];
    for (const [ia, ib] of links) {
      const a = isl[ia], b = isl[ib], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
      const x0 = a.x + ux * (a.r + 4), z0 = a.z + uz * (a.r + 4), x1 = b.x - ux * (b.r + 4), z1 = b.z - uz * (b.r + 4), len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(z1 - z0, x1 - x0);
      const deck = new T.Mesh(new T.BoxGeometry(len, 1.1, 8), m.deck); deck.position.set((x0 + x1) / 2, 5.4, (z0 + z1) / 2); deck.rotation.y = -ang; g.add(deck);
      const edge = new T.Mesh(new T.BoxGeometry(len, 0.14, 0.3), m.neonB); edge.position.copy(deck.position); edge.position.y = 6.05; edge.position.x -= -uz * 3.8; edge.position.z -= ux * 3.8; edge.rotation.y = -ang; g.add(edge);
      const edge2 = edge.clone(); edge2.position.x = deck.position.x + -uz * 3.8; edge2.position.z = deck.position.z + ux * 3.8; g.add(edge2);
      sol.push({ obb: [(x0 + x1) / 2, (z0 + z1) / 2, len / 2, 4.2, ang], y: 6 });
      // pylons at each end, cables between their tops (a sagging tube each side)
      const pyl = [[x0, z0], [x1, z1]], tops = [];
      for (const p of pyl) for (const side of [-1, 1]) {
        const px = p[0] + -uz * 4.4 * side, pz = p[1] + ux * 4.4 * side;
        const pm = new T.Mesh(new T.BoxGeometry(1.8, 44, 1.8), m.trim); pm.position.set(px, 5.4 + 22, pz); g.add(pm); tops.push([px, 5.4 + 44, pz]);
      }
      for (const side of [0, 1]) {
        const A = tops[side], B = tops[2 + side], pts = [];
        for (let i = 0; i <= 14; i++) { const t = i / 14, sag = 4 * t * (1 - t); pts.push(new T.Vector3(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t - sag * 30, A[2] + (B[2] - A[2]) * t)); }
        g.add(new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 28, 0.22, 4), m.cable));
        for (let i = 1; i < 14; i += 2) { const p = pts[i], h = p.y - 6.0; const hg = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, h, 3), m.cable); hg.position.set(p.x, 6.0 + h / 2, p.z); g.add(hg); }
      }
    }
    // the mid-height cloud layer (stacked, drifting) — towers pierce it
    const clouds = [];
    for (let i = 0; i < 4; i++) {
      const mt = m.cloud.clone(); mt.map = TX.cloud.clone(); mt.map.needsUpdate = true; mt.map.repeat.set(3 + i, 3 + i); mt.opacity = [0.55, 0.42, 0.34, 0.26][i];
      const p = new T.Mesh(new T.PlaneGeometry(1900, 1900, 20, 20), mt); p.rotation.x = -Math.PI / 2; p.position.set(60, 120 + i * 17, 40); p.renderOrder = 4; p.userData.v = [0.004, -0.003, 0.0025, -0.002][i]; g.add(p); clouds.push(p);
    }
    return { group: g, solids: sol, clouds };
  }

  // (stability) HEAVY-LOAD GATE. Arriving at the mansion used to start, in the same second: the exterior GLB, the interior GLB + GI maps, the 2K hero set and every cliff
  // texture set (each three 1-2K images decoding + uploading + a material recompile). On an iPhone that is the moment the tab is killed. Every GPU-heavy asset step of the
  // mansion now goes through this ONE serial queue: a step starts only when the page is visible, the last step finished >= GAP ms ago (1.6 s phones, 0.4 s desktop) and a
  // requestAnimationFrame gap just measured is under 90 ms (the page is keeping up). Steps report to the crash breadcrumbs (DMCrumb) so a kill names the step it died in.
  const HQ = { q: [], busy: false, last: 0, n: 0, epoch: 0 };   // epoch: bumped when the world closes; a step queued or running under an older epoch is dropped / disposes what it loaded
  const crumb = (m, n, i) => { try { window.DMCrumb && window.DMCrumb[m](n, i); } catch (e) { } };
  const isIOS = (() => { try { return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); } catch (e) { return false; } })();
  const recentKill = () => { try { const a = window._dmPrevAlive; return !!(a && a.clean === false && !a.hidden && Date.now() - a.t < 600000); } catch (e) { return false; } };
  function rafGap() { return new Promise(ok => { const t0 = performance.now(); requestAnimationFrame(() => { const t1 = performance.now(); requestAnimationFrame(() => ok(performance.now() - t1 + 0 * t0)); }); }); }
  function hqPump() {
    if (HQ.busy || !HQ.q.length) return;
    const gap = (F.ctx && F.ctx.isMobile && F.ctx.isMobile()) ? 1600 : 400, wait = gap - (performance.now() - HQ.last);
    if (document.hidden || wait > 0) { setTimeout(hqPump, Math.max(200, wait)); return; }
    HQ.busy = true;
    rafGap().then(g => {
      if (g > 90 && HQ.n++ < 40) { HQ.busy = false; setTimeout(hqPump, 700); return; }   // the page is struggling: wait (bounded, so a permanently slow device still finishes)
      HQ.n = 0; const job = HQ.q.shift();
      if (job.epoch !== HQ.epoch) { if (job.stale) job.stale(); HQ.busy = false; hqPump(); return; }
      crumb('begin', 'fac:' + job.name);
      let p; try { p = Promise.resolve(job.fn(() => job.epoch === HQ.epoch)); } catch (e) { p = Promise.reject(e); }
      p.catch(e => console.warn('[facilities] heavy', job.name, e)).then(() => { if (job.epoch !== HQ.epoch && job.stale) job.stale(); crumb('end', 'fac:' + job.name); HQ.last = performance.now(); HQ.busy = false; crumb('live', 'facQueue', HQ.q.length); hqPump(); });
    });
  }
  F.heavy = function (name, fn, stale) { HQ.q.push({ name, fn, stale, epoch: HQ.epoch }); crumb('live', 'facQueue', HQ.q.length); hqPump(); };

  // ── Ariel's mansion (GLB + collision grid) ───────────────────────────────────────────────────────────────
  const MAN = { glb: null, col: null, loading: false, failed: false };
  F.manCol = () => MAN.col;   // the exterior collision grid (ui/dm-lamps.js plans light pools on it)
  function loadMansion() {
    if (MAN.glb || MAN.loading || MAN.failed) return;
    MAN.loading = true; const c = F.ctx;
    // (v223) phones/tablets load the half-size-map mansion (≈75 MB less graphics memory)
    Promise.all([c.loadGLB('assets/ariel-home/' + (c.isMobile() ? 'ariel-home-512.glb' : 'ariel-home.glb') + '?v=' + F.ver + (c.isMobile() ? 'm292' : '')), fetch('assets/ariel-home/ariel-home-collide.json?v=' + F.ver).then(r => r.json())]).then(([gl, col]) => {
      const bin = atob(col.data), n = bin.length >> 1, a = new Int16Array(n);
      for (let i = 0; i < n; i++) { const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); a[i] = v > 32767 ? v - 65536 : v; }
      col.h = a; MAN.col = col; MAN.glb = gl; MAN.loading = false;
      try { gl.scene.traverse(o => { if (o.isMesh && o.material && o.material.name === 'ah_pool') F.poolLook(o.material); }); } catch (e) { console.warn('[ariel-home] pool look', e); }
      try { gl.scene.traverse(o => { if (o.isMesh && o.material && o.material.name === 'ah_pool' && o.geometry) { const g = o.geometry, k = F.poolTrim(g.attributes.position, g.index ? g.index.array : null); if (k) g.setIndex(k); } }); } catch (e) { console.warn('[ariel-home] pool trim', e); }
    }).catch(e => { MAN.failed = true; MAN.loading = false; console.warn('[ariel-home] load failed', e); });
  }
  // (lod-hide) the two pool surfaces of the GLB (ah_pool: one quad under the pool-room roof, one 57 x 21 u quad on the lower sea terrace) shipped with a
  // full-strength cyan EMISSIVE (0.09, 0.63, 0.72) and no lighting response: at night the terrace pool was a flat, saturated teal rectangle by the shore,
  // the brightest thing on screen, read as an LOD "reference tile".  Water is lit, not lit-up: a deep, dark, glossy surface that takes the sky / lamp light
  // like the sea does, with only a trace of its own glow.  Shared by every clone (one material), set once when the GLB arrives.  Pure: node-tested.
  F.POOL_LOOK = { color: [0.012, 0.05, 0.062], emissive: [0.0, 0.006, 0.008], roughness: 0.06, metalness: 0.3 };
  F.poolLook = function (m) {
    if (!m) return m; const L = F.POOL_LOOK;
    if (m.color && m.color.setRGB) m.color.setRGB(L.color[0], L.color[1], L.color[2]);
    if (m.emissive && m.emissive.setRGB) m.emissive.setRGB(L.emissive[0], L.emissive[1], L.emissive[2]);
    m.emissiveIntensity = 1; m.roughness = L.roughness; m.metalness = L.metalness; m.userData = m.userData || {}; m.userData.dmPoolLook = true; m.needsUpdate = true;
    return m;
  };
  // (fov-fill) the DECK-level ah_pool quad (GLB local x 46.8..76.7, z -7.8..-31.2, y -0.26: a 30 x 23 u sheet flush with the HOME deck, by the seaward rail)
  // was the bright teal polygon on the walkway in daylight (base 0.08/0.50/0.58 + the shipped emissive, sunlit).  It is not a pool anyone swims in: it sits
  // 0.26 u under the deck over a dark ah_dark basin (-0.5 / -1.1 / -1.6), and read as a cyan reference tile on the deck.  Its two triangles are dropped from
  // the shared index when the GLB arrives (every clone and the impostor bake see the same geometry); the lower sea-terrace pool (y -18.46, re-lit by poolLook)
  // stays.  Pure: P = position attribute (getY) or a flat xyz array, idx = index array or null.  Returns the kept index (a plain array) or null to keep all.
  F.POOL_DECK_Y = -5;
  F.poolTrim = function (P, idx) {
    if (!P) return null; const n = P.count != null ? P.count : (P.length / 3) | 0, y = i => (P.getY ? P.getY(i) : P[i * 3 + 1]);
    const m = idx ? idx.length : n, out = []; let drop = 0;
    for (let t = 0; t + 2 < m; t += 3) {
      const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
      if (y(a) > F.POOL_DECK_Y && y(b) > F.POOL_DECK_Y && y(c) > F.POOL_DECK_Y) { drop++; continue; }
      out.push(a, b, c);
    }
    return drop ? out : null;
  };
  function mansionInstance(T) {
    const root = new T.Group(); root.name = 'JOTS_ArielMansion';
    const sc = MAN.glb.scene.clone(true);      // materials stay shared with the loaded scene on purpose (one set of textures)
    const lod0 = sc.getObjectByName('Mansion_LOD0'), lod1 = sc.getObjectByName('Mansion_LOD1');
    root.add(sc); root.userData.lod0 = lod0; root.userData.lod1 = lod1;
    const sh = F.ctx.shadows() && !F.ctx.isMobile();   // (v223) the mansion casts no shadows on phones/tablets: saves a 59k-triangle shadow pass
    sc.traverse(o => { if (o.isMesh) { o.frustumCulled = false; const n = o.material && o.material.name; if (sh && lod0 && o.parent === lod0 || sh && lod0 && lod0.getObjectById(o.id)) { o.castShadow = !/^ah_rock/.test(n) && n !== 'ah_glass'; o.receiveShadow = true; } } });
    return root;
  }
  // ── far-range LOD (ui/dm-lod.js, ui/dm-impostor.js): three levels with a screen-door cross-fade ──────────────────────────────────────────────────────────────────
  // LOD0 (interior-grade) < nIn/nOut < LOD1 (15k tris) < lod2In < IMPOSTOR (one draw call, ~2.6k tris, colours baked) < far cull.  A level change no longer swaps: the levels trade
  // places over xfade.s seconds through the planet mask every material already carries (DMLod.fadeMask), each object drawing its own interval of the screen noise, so a pixel belongs
  // to exactly one level.  Without fade-capable materials (?lodfade=0, mask not there yet) dur = 0 and it snaps exactly like before.
  function kickLod2(T) {
    MAN.lod2Tried = true;
    F.heavy('lod2:build', async () => {
      const src = MAN.glb && MAN.glb.scene.getObjectByName('Mansion_LOD1'); if (!src) return;
      const r = DMImpostor.build(src, T, { tris: DMLod.get('impostor.tris') });
      if (r) { MAN.lod2 = r; r.err = r.cell * 0.9; crumb('mark', 'lod2', r.tris + 'tris/' + Math.round(r.ms) + 'ms'); } else console.warn('[ariel-home] impostor: nothing to build');
    }, () => { MAN.lod2Tried = false; });
  }
  function attachLod2(rec, T) {
    const src = rec.group && rec.group.userData.lod1, IM = MAN.lod2; if (!src || !src.parent || !IM) return;
    const g = new T.Group(); g.name = 'Mansion_LOD2'; g.position.copy(src.position); g.quaternion.copy(src.quaternion); g.scale.copy(src.scale);
    const m = new T.Mesh(IM.geometry, IM.material); m.name = 'Mansion_LOD2_mesh'; m.frustumCulled = false; g.add(m); g.visible = false;
    src.parent.add(g); rec.group.userData.lod2 = g; rec.lod2 = g;
    F.ctx.mapTag(g); DMLod.fadeMask(g);
    try {   // build its pipeline now, off to the side (a never-drawn material is a stall the first frame it shows)
      const PW = F.ctx.PW(); if (PW && PW.renderer && PW.renderer.compileAsync && PW.camera) { g.visible = true; try { PW.renderer.compileAsync(g, PW.camera, PW.scene); } finally { g.visible = false; } }
    } catch (e) { }
  }
  function lodBands(rec, u, near, far, d1, dt, T) {
    const D = window.DMLod && DMLod.on ? DMLod : null;
    if (!D) { if (u.lod0) u.lod0.visible = near && !far; if (u.lod1) u.lod1.visible = !near && !far; return; }
    let target = near ? 0 : 1;
    if (rec.lod2) {   // LOD1 -> impostor where the impostor's own error (its clustering cell) projects to <= tau px (DMLod.lod2Dist), recomputed ~2x a second: follows render scale, fov and the ladder
      if (!rec.l2T || (rec.l2N = (rec.l2N || 0) + 1) % 30 === 0) { const PW = F.ctx.PW(), cam = PW && PW.camera, el = PW && PW.renderer && PW.renderer.domElement; rec.l2T = D.lod2Dist(MAN.lod2.err, cam && cam.fov, el && el.height); }
      const l2 = rec.l2T; rec.far2 = rec.far2 === undefined ? d1 > l2 : (rec.far2 ? d1 >= l2 * 0.92 : d1 > l2); if (!near && rec.far2) target = 2; }
    const X = rec.xf || (rec.xf = D.createXfade(3, 0)), objs = [u.lod0, u.lod1, u.lod2];
    if ((rec.fmT = (rec.fmT || 0) + 1) % 90 === 1) rec.fadeOK = D.fadeMask(rec.group) > 0;   // (re)wraps materials that appeared since (parallax twins, the impostor)
    X.dur = rec.fadeOK ? D.get('xfade.s') : 0;
    // (v289) SIZE FADE.  The cliff mansion spans ~400 m on a world whose walking radius is ~7.2 km (360 deg / ATMO_DEG_PER_UNIT), so from altitude it is a huge landmark on a small ball.  Its bounding sphere's
    // projected diameter (DMLod.billboardPx) drives a screen-door fade [goneDiam .. fullDiam] px, and the last 15 % of the far cull is a fade too (no pop at 5.2 km).  Gone = not drawn.
    // Without fade-capable materials (rec.fadeOK false) it is a plain hide below the half-way size.
    let szA = 1;
    if (D.sizeFade) {
      if (!rec.rad) { try { const bb = new T.Box3().setFromObject(u.lod1 || u.lod0 || rec.group), sp = bb.getBoundingSphere(new T.Sphere()); rec.rad = sp.radius > 20 ? sp.radius : 250; } catch (e) { rec.rad = 250; } }
      if (!rec.szT || (rec.szN = (rec.szN || 0) + 1) % 20 === 0) { const PW = F.ctx.PW(), cam = PW && PW.camera, el = PW && PW.renderer && PW.renderer.domElement; rec.szT = { fov: (cam && cam.fov) || 60, h: (el && el.height) || 1080 }; }
      const SZ = D.mansionSize(), px = D.billboardPx(rec.rad, Math.max(1, d1), rec.szT.fov, rec.szT.h);
      szA = Math.min(D.sizeFade(px, SZ.gone, SZ.full), rec.farM ? D.fade(d1, rec.farM * 0.85, rec.farM) : 1);
      if (!rec.fadeOK) szA = szA >= 0.5 ? 1 : 0;
      if (szA < 0.004) far = true;
    }
    rec.szA = szA;
    if (far) { X.snap(target); for (const o of objs) if (o) o.visible = false; return; }
    X.set(target); X.step(dt);
    const iv = [0, 0];
    for (let i = 0; i < 3; i++) { const o = objs[i]; if (!o) continue; o.visible = X.w[i] > 0.001; if (o.visible) { X.interval(i, iv); D.setFade(o, iv[0] * szA, iv[1] * szA); } else D.setFade(o, 0, 2); }
    // the renderer reads the interval per drawn mesh (frame.object): hand each level's interval down to its meshes while a fade runs (and once more when it ends, to clear them)
    if (X.fading || rec.fdPrev || szA < 1 || rec.szPrev) {
      for (let i = 0; i < 3; i++) { const o = objs[i]; if (!o) continue; const f = o.userData.dmFade; o.traverse(c => { if (c !== o && c.isMesh) { if (f) { const cf = c.userData.dmFade || (c.userData.dmFade = [0, 1.0001]); cf[0] = f[0]; cf[1] = f[1]; } else if (c.userData.dmFade) c.userData.dmFade = null; } }); }
    }
    rec.fdPrev = X.fading; rec.szPrev = szA < 1;
  }
  let hiTried = false;
  function upgrade2K(T) {       // desktop only: swap the 1K maps for the 2K hero set once she's near
    const c = F.ctx; if (hiTried || c.isMobile() || c.tier() < 2 || !MAN.glb) return; hiTried = true;
    const L = new T.TextureLoader(), load = u => new Promise((ok, no) => L.load(u, ok, undefined, no));
    const byName = {}; MAN.glb.scene.traverse(o => { if (o.isMesh && o.material && /^ah_(slate|concrete|wood|dark|leaf)$/.test(o.material.name)) byName[o.material.name] = o.material; });
    Object.keys(byName).forEach(k => F.heavy('2k:' + k, async (alive) => {   // one material per step, one 2K image decoded at a time (never three at once)
      const n = k.slice(3), mat = byName[k], base = 'assets/ariel-home/tex/' + n, got = [];
      try { for (const t of ['color', 'nrm', 'orm']) got.push(await load(base + '-' + t + '-2k.webp?v=' + F.ver)); } catch (e) { console.warn('[ariel-home] 2K', n, e); got.forEach(t => t.dispose && t.dispose()); return; }
      if (!alive()) { got.forEach(t => t.dispose && t.dispose()); return; }   // the world closed while the images were loading: nothing to apply them to
      const [a, b, o] = got;
      for (const t of [a, b, o]) { t.flipY = false; t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 8; }
      a.colorSpace = T.SRGBColorSpace;
      // (parallax) slate / concrete / wood / dark: relief from a height map integrated once from the normal map (512 px, cached R8), tile sizes from build_mansion.py TILE
      let tgt = mat; const PXD = { slate: [4, 0.04], concrete: [4, 0.012], wood: [3, 0.02], dark: [2, 0.012] }[n];
      if (PXD && window.DMParallax && DMParallax.on && !/[?&]manpx=0\b/.test(location.search)) { try { const rts = [MAN.glb.scene].concat(Array.from(F.sites.values()).filter(r => r.mansion && r.group).map(r => r.group)); rts.forEach(rt => { tgt = DMParallax.adopt(rt, mat); }); } catch (e) { tgt = mat; } }
      const old = [tgt.map, tgt.normalMap, tgt.roughnessMap];
      tgt.map = a; tgt.normalMap = b; tgt.roughnessMap = o; tgt.metalnessMap = o; tgt.needsUpdate = true;
      old.forEach(x => { if (x && x.dispose && x !== a && x !== b && x !== o) x.dispose(); });   // the 1K maps the GLB shipped with go once the 2K ones are on the material
      if (PXD && tgt.isNodeMaterial) { try { const hg = await DMParallax.deriveHeightAsync('man|' + n, b, 'nrm', DMParallax.tierRow(DMParallax.tierName()).hMax); if (hg && alive() && !DMParallax.structure(tgt, { tex: { map: a, nrm: b, orm: o }, height: hg, hSize: hg.image.width, tileM: PXD[0], depthM: PXD[1], rot: 'flip', macro: 0.16, stain: 0.18, lichen: n === 'slate' ? 0.1 : 0, near: 10, far: 30, cavity: 0.6 })) { /* stays on the plain maps */ } } catch (e) { console.warn('[ariel-home] mansion parallax', n, e); } }
    }, () => { hiTried = false; }));
  }

  // (v256) Parallax on the mansion materials at EVERY tier. Desktop tier >= 2 gets it with the 2K set above; everyone else (phones / tablets, desktop Low-Medium) keeps the maps
  // the GLB shipped with (1K desktop, 512 phone GLB) and gets the same shared march on them: the height map is derived once from the embedded normal map (time-sliced, capped
  // at the tier's hMax: Low 256 px ... Ultra 1024), one material per queue step. Numbers per tier (steps, depth, reach) are shared uniforms in ui/dm-parallax.js.
  const MAN_PXD = { slate: [4, 0.04], concrete: [4, 0.012], wood: [3, 0.02], dark: [2, 0.012] };   // [tileM, depthM] (tile sizes from build_mansion.py TILE)
  let manPxTried = false;
  function mansionPx(T) {
    const c = F.ctx; if (manPxTried || !MAN.glb || !window.DMParallax || !DMParallax.on || /[?&]manpx=0\b/.test(location.search)) return;
    if (!c.isMobile() && c.tier() >= 2) return;      // upgrade2K adds it with the 2K maps
    manPxTried = true;
    const byName = {}; MAN.glb.scene.traverse(o => { if (o.isMesh && o.material && /^ah_(slate|concrete|wood|dark)$/.test(o.material.name)) byName[o.material.name] = o.material; });
    Object.keys(byName).forEach(k => F.heavy('mpx:' + k, async (alive) => {
      const n = k.slice(3), PXD = MAN_PXD[n], mat = byName[k]; if (!PXD || !alive()) return;
      try {
        const rts = [MAN.glb.scene].concat(Array.from(F.sites.values()).filter(r => r.mansion && r.group).map(r => r.group));
        let tgt = mat; rts.forEach(rt => { tgt = DMParallax.adopt(rt, mat); });
        if (!tgt || !tgt.isNodeMaterial || !tgt.map || !tgt.normalMap) return;
        const hg = await DMParallax.deriveHeightAsync('man|' + n, tgt.normalMap, 'nrm', DMParallax.tierRow(DMParallax.tierName()).hMax);
        if (hg && alive()) DMParallax.structure(tgt, { tex: { map: tgt.map, nrm: tgt.normalMap, orm: tgt.roughnessMap }, height: hg, hSize: hg.image.width, tileM: PXD[0], depthM: PXD[1], rot: 'flip', macro: 0.16, stain: 0.18, lichen: n === 'slate' ? 0.1 : 0, near: 10, far: 30, cavity: 0.6 });
      } catch (e) { console.warn('[ariel-home] mansion parallax', n, e); }
    }, () => { manPxTried = false; }));
  }

  // Cliff rock sets (tools/ariel-home/gen_cliff_textures.py + cliff_mesh.py): 4 tileable 3 m sets (strata / columnar / sheet / talus), each colour + normal + ORM + height.
  // The GLB embeds the 512 tier (low preset stays on it); tier >= 1 desktop gets 1K, tier >= 2 desktop 2K (683 px/m), phones/tablets 1K from tier 2. Sets stream in one at a time
  // (spreads the GPU uploads), old 512 maps are disposed. mat.userData.dmCliff carries the height-map URL + tile/depth for the parallax-occlusion helper (ui/dm-parallax.js).
  let cliffTried = false;
  function upgradeCliff(T) {
    const c = F.ctx; if (cliffTried || !MAN.glb) return; cliffTried = true;
    // (stability) phones: 1K at most, and only when the last session was not killed; iPhone/iPad (no deviceMemory to ask, the tab limit is tight) 1K only from tier 3. Otherwise
    // the 512 maps the GLB embeds stay (they are the look the low preset already ships).
    // (memory lane) the 1K rock sets are 4 sets x (colour + normal + ORM + height) = 16 mipped RGBA8 maps = ~90 MB against ~22 MB for the embedded 512 ones; phones/tablets only take them when the browser
    // reports >= 8 GB (Chrome caps navigator.deviceMemory at 8) and has not killed the tab lately.  ?cliff=1k forces them, ?cliff=512 forbids them.
    const _cq = (location.search.match(/[?&]cliff=(1k|512)\b/) || [])[1], _mem8 = (navigator.deviceMemory || 0) >= 8;
    const t = c.tier(), mob = c.isMobile(), res = mob ? ((t >= 2 && !recentKill() && (!isIOS || t >= 3) && (_mem8 || _cq === '1k') && _cq !== '512') ? '1k' : null) : (t >= 2 ? '2k' : t >= 1 ? '1k' : null);
    crumb('mark', 'cliffRes', res || '512');
    const byName = {}; MAN.glb.scene.traverse(o => { if (o.isMesh && o.material && /^ah_rock/.test(o.material.name)) byName[o.material.name] = o.material; });
    fetch('assets/ariel-home/cliff/cliff-materials.json?v=' + F.ver).then(r => r.json()).then(J => {
      const L = new T.TextureLoader(), load = u => new Promise((ok, no) => L.load(u, ok, undefined, no)), aniso = mob ? 4 : 8, ids = Object.keys(J.sets);
      const pxRes = res || '512', hp = J.heightTierFor ? J.heightTierFor[pxRes] : pxRes;
      // (parallax) real relief on the cliff: each rock material is adopted into a node twin (ui/dm-parallax.js) that marches the set's height map, sharing the ground's
      // governor/preset uniforms (uniform writes only). (v256) EVERY tier: where no bigger set streams in (Low, phones below the memory gates) the 512 maps the GLB embeds
      // stay on the material and only the 512 height map (8-22 KB each) is fetched; the tier table scales steps / depth / fade band. Only ?px=0 / ?cliffpx=0 turn it off.
      const pxOn = !!(window.DMParallax && DMParallax.on && !/[?&]cliffpx=0\b/.test(location.search));
      const pxRoots = () => [MAN.glb.scene].concat(Array.from(F.sites.values()).filter(r => r.mansion && r.group).map(r => r.group));
      if (pxOn) ids.forEach(id => { const S = J.sets[id], m0 = byName[S.material]; if (!m0) return; let tw = m0; pxRoots().forEach(rt => { tw = DMParallax.adopt(rt, m0); }); byName[S.material] = tw; });
      ids.forEach(id => { const S = J.sets[id], mat = byName[S.material]; if (mat) mat.userData.dmCliff = { set: id, tileM: J.tileM, depthM: S.depthM, height: J.base + id + '-height-' + hp + '.webp?v=' + F.ver, uvOrigin: J.uv }; });
      if (!res) {   // 512 maps stay; the height map joins them (one set per serial queue step, same gate as the texture sets)
        if (pxOn) ids.forEach(id => F.heavy('cliffpx:' + id + ':512', async (alive) => {
          const S = J.sets[id], mat = byName[S.material]; if (!mat || !mat.isNodeMaterial || !mat.map || !mat.normalMap) return;
          try {
            const ht = await load(J.base + id + '-height-' + hp + '.webp?v=' + F.ver); ht.flipY = false; ht.wrapS = ht.wrapT = T.RepeatWrapping; ht.anisotropy = 1; ht.colorSpace = T.NoColorSpace;
            if (!alive()) { ht.dispose(); return; }
            if (!DMParallax.structure(mat, { tex: { map: mat.map, nrm: mat.normalMap, orm: mat.roughnessMap }, height: ht, hSize: ht.image && ht.image.width, tileM: J.tileM, depthM: S.depthM, rot: 'flip', macro: 0.3, stain: 0.5, lichen: 0.35, near: (J.parallax && J.parallax.fadeStartM) || 14, far: (J.parallax && J.parallax.fadeEndM) || 40 })) ht.dispose();
          } catch (e) { console.warn('[ariel-home] cliff parallax 512', id, e); }
        }, () => { cliffTried = false; }));
        return;
      }
      ids.forEach(id => F.heavy('cliff:' + id + ':' + res, async (alive) => {   // one set per queue step (>= GAP ms apart, only while the page keeps up); its three images load one after the other
        const S = J.sets[id], mat = byName[S.material]; if (!mat) return;
        const base = J.base + id + '-', got = [];
        try { for (const k of ['color', 'nrm', 'orm']) got.push(await load(base + k + '-' + res + '.webp?v=' + F.ver)); } catch (e) { console.warn('[ariel-home] cliff', id, e); got.forEach(t => t.dispose && t.dispose()); return; }
        if (!alive()) { got.forEach(t => t.dispose && t.dispose()); return; }
        const [a, b, o] = got;
        for (const x of [a, b, o]) { x.flipY = false; x.wrapS = x.wrapT = T.RepeatWrapping; x.anisotropy = aniso; }
        a.colorSpace = T.SRGBColorSpace;
        const old = [mat.map, mat.normalMap, mat.roughnessMap];
        mat.map = a; mat.normalMap = b; mat.roughnessMap = o; mat.metalnessMap = o; mat.needsUpdate = true;
        old.forEach(x => { if (x && x.dispose && x !== a && x !== b && x !== o) x.dispose(); });   // the embedded 512 maps go as soon as the new ones are on the material
        if (pxOn && mat.isNodeMaterial) {   // (parallax) the set's height map (8-bit, 1 = proud), marched in the 14..40 m fade band from cliff-materials.json
          try {
            const ht = await load(J.base + id + '-height-' + hp + '.webp?v=' + F.ver); ht.flipY = false; ht.wrapS = ht.wrapT = T.RepeatWrapping; ht.anisotropy = 2; ht.colorSpace = T.NoColorSpace;
            if (!alive()) { ht.dispose(); return; }
            if (!DMParallax.structure(mat, { tex: { map: a, nrm: b, orm: o }, height: ht, hSize: ht.image && ht.image.width, tileM: J.tileM, depthM: S.depthM, rot: 'flip', macro: 0.3, stain: 0.5, lichen: 0.35, near: (J.parallax && J.parallax.fadeStartM) || 14, far: (J.parallax && J.parallax.fadeEndM) || 40 })) ht.dispose();
          } catch (e) { console.warn('[ariel-home] cliff parallax', id, e); }
        }
      }, () => { cliffTried = false; }));
    }).catch(e => console.warn('[ariel-home] cliff set', e));
  }

  // ── search: time-sliced sampling of the world's height field ─────────────────────────────────────────────
  const DIRS = []; for (let i = 0; i < 8; i++) DIRS.push([Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
  function newSearch(kind, cx, cz, R, step) {
    const cells = []; for (let z = -R; z <= R; z += step) for (let x = -R; x <= R; x += step) cells.push([cx + x, cz + z, x * x + z * z]);
    cells.sort((a, b) => a[2] - b[2]);
    return { kind, cells, i: 0, best: null, score: -1e9, R };
  }
  function evalCliff(H, x, z) {        // steepest drop with a plateau behind it
    const h = H(x, z); let best = null, bs = -1e9;
    for (let k = 0; k < 8; k++) {
      const d = DIRS[k], hf = H(x + d[0] * 70, z + d[1] * 70), hb = H(x - d[0] * 40, z - d[1] * 40);
      const px = -d[1], pz = d[0], hs = Math.abs(H(x + px * 36, z + pz * 36) - h) + Math.abs(H(x - px * 36, z - pz * 36) - h);
      const sc = (h - hf) - 0.8 * Math.max(0, Math.abs(hb - h) - 4) - 0.35 * hs;
      if (sc > bs) { bs = sc; best = { dx: d[0], dz: d[1] }; }
    }
    return best ? { s: bs, dir: best, h } : null;
  }
  function evalCoast(H, x, z) {        // plateau 35..95 m above a sea that is reached within 260 m
    const h = H(x, z); if (h < 35 || h > 95) return null; let best = null, bs = -1e9;
    for (let k = 0; k < 8; k++) {
      const d = DIRS[k]; let hit = -1;
      for (let r = 50; r <= 260; r += 50) if (H(x + d[0] * r, z + d[1] * r) < 4) { hit = r; break; }
      if (hit < 0) continue;
      const hb = H(x - d[0] * 50, z - d[1] * 50), px = -d[1], pz = d[0], hs = Math.abs(H(x + px * 60, z + pz * 60) - h) + Math.abs(H(x - px * 60, z - pz * 60) - h);
      if (hb < h - 8 || hb > h + 30) continue;
      const sc = -Math.abs(h - 62) * 0.6 - hit * 0.05 - 0.25 * hs - Math.max(0, hb - h) * 0.2;
      if (sc > bs) { bs = sc; best = { dx: d[0], dz: d[1] }; }
    }
    return best ? { s: bs, dir: best, h } : null;
  }
  function evalSea(H, x, z) {
    if (H(x, z) > -22) return null; let s = 0;
    for (let k = 0; k < 8; k++) { const d = DIRS[k]; s += H(x + d[0] * 280, z + d[1] * 280) < -12 ? 1 : 0; }
    return s >= 8 ? { s, dir: { dx: 1, dz: 0 }, h: SEA } : null;
  }
  function stepSearch(sr, H, ms) {
    const t0 = performance.now(), fn = sr.kind === 'coast' ? evalCoast : sr.kind === 'sea' ? evalSea : evalCliff;
    while (sr.i < sr.cells.length) {
      const c = sr.cells[sr.i++], r = fn(H, c[0], c[1]);
      if (r && r.s > sr.score) { sr.score = r.s; sr.best = { x: c[0], z: c[1], dx: r.dir.dx, dz: r.dir.dz, h: r.h, s: r.s }; if (sr.kind === 'sea') { sr.i = sr.cells.length; break; } }
      if ((sr.i & 15) === 0 && performance.now() - t0 > ms) return false;
    }
    return true;
  }

  // ── height hook ─────────────────────────────────────────────────────────────────────────────────────────
  const NEG = -1e9;
  function solidAt(s, x, z) {
    if (s.rect) { const r = s.rect; return x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3] ? s.y : NEG; }
    if (s.circle) { const c = s.circle, dx = x - c[0], dz = z - c[1]; return dx * dx + dz * dz <= c[2] * c[2] ? s.y : NEG; }
    if (s.obb) { const o = s.obb, dx = x - o[0], dz = z - o[1], ca = Math.cos(o[4]), sa = Math.sin(o[4]), u = dx * ca + dz * sa, v = -dx * sa + dz * ca; return Math.abs(u) <= o[2] && Math.abs(v) <= o[3] ? s.y : NEG; }
    if (s.poly) return inPoly(s.poly, x, z) ? s.y : NEG;
    if (s.grid) return s.grid(x, z);
    return NEG;
  }
  F.heightAt = function (x, z) {
    let h = NEG; const L = F.solids;
    for (let i = 0; i < L.length; i++) { const s = L[i]; if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue; const v = solidAt(s, x, z); if (v > h) h = v; }
    return h;
  };
  // F.ovr (ui/dm-mansion-interior.js): while she walks inside the mansion it answers with the exact interior floor height (or NaN), bypassing the max-with-base below.
  F.ovr = null;
  // ── EXCLUSION VOLUME of the mansion (stability: "the cliff builds over the windows as I get close") ──────────────────────────────────────
  // Root cause (measured, see docs/ariel-home/lod-evidence.md): TERRAIN.H is wrapH() = max(planet ground, mansion collision grid). The marching-cubes patch (streams in
  // within ~100 m), the refined tessellation, the sky ground quadtree (sharpening as she dives), the prop scatter and the atmosphere's local height all sampled THAT, so the
  // moment each of them generated near the mansion it extruded a solid column up to every roof / deck / overhang (rooms filled, windows buried, boulders on pier tops over the sea).
  // Now every DRAWN-ground consumer samples F.carve(): inside the mansion box (the GLB's own cliff + plateau + sea floor cover it) the planet ground is lowered under the GLB with a
  // 14 m feather at the box edge; the WALKING height inside the box stays exactly the old wrapH (collision grid, interior override) via TERRAIN.exBox.
  F.car = null;          // { px, pz, ct, st, y0 } once the mansion is placed
  const BOX = { x0: -196, x1: 196, y0: -121, y1: 121, feather: 14, deep: 128 };   // mansion Blender frame: x along the wall, y seaward (= -local z); the GLB cliff sweep spans x +-200, y +-125
  function boxD(x, z) {      // metres inside the box (<= 0 outside)
    const c = F.car; if (!c) return 0;
    const dx = x - c.px, dz = z - c.pz; if (dx > 330 || dx < -330 || dz > 330 || dz < -330) return 0;
    const lx = dx * c.ct - dz * c.st, lz = dx * c.st + dz * c.ct, bx = lx, by = -lz;
    return Math.min(bx - BOX.x0, BOX.x1 - bx, by - BOX.y0, BOX.y1 - by);
  }
  F.exBox = (x, z) => F.car !== null && boxD(x, z) > 0;
  F.carve = function (x, z, h) {
    const d = boxD(x, z); if (d <= 0) return h;
    const t = Math.min(1, d / BOX.feather), w = t * t * (3 - 2 * t), deep = F.car.y0 - BOX.deep;
    return h > deep ? h + (deep - h) * w : h;
  };
  F.carveField = function (Fd) { if (Fd.H0) return; const H0 = Fd.H; Fd.H0 = H0; Fd.H = (x, z) => { const h = H0(x, z); return F.car === null ? h : F.carve(x, z, h); }; };
  function carveActivate(px, pz, ct, st, y0) {
    F.car = { px, pz, ct, st, y0 };
    try { if (window._dmGroundDirty) window._dmGroundDirty(px - 340, pz - 340, px + 340, pz + 340); } catch (e) { console.warn('[facilities] ground dirty', e); }
  }
  F.wrapH = function (H) { F.baseH = H; return (x, z) => { const o = F.ovr; if (o !== null) { const v = o(x, z); if (v === v) return v; } const h = H(x, z); if (!F.solids.length) return h; const s = F.heightAt(x, z); return s > h ? s : h; }; };
  // world-space solids from a landmark's local ones (rotation θ about Y at (px,pz), local y0 offset)
  function addSolids(list, px, pz, th, y0, flip) {
    const ct = Math.cos(th), st = Math.sin(th);
    const W = (lx, lz) => [px + lx * ct + lz * st, pz - lx * st + lz * ct];
    for (const s of list) {
      if (s.col) { try { const D = window.DMCollide, w = W(s.x, s.z); if (D && D.addCylinder) D.addCylinder('facility', w[0], y0 + s.y0, y0 + s.y1, w[1], s.r, s.mat || 'stone'); } catch (e) { } continue; }
      if (s.circle) { const w = W(s.circle[0], s.circle[1]); F.solids.push({ circle: [w[0], w[1], s.circle[2]], y: y0 + s.y, x0: w[0] - s.circle[2], x1: w[0] + s.circle[2], z0: w[1] - s.circle[2], z1: w[1] + s.circle[2], _own: 1 }); }
      else if (s.obb) { const o = s.obb, w = W(o[0], o[1]), R = Math.hypot(o[2], o[3]); F.solids.push({ obb: [w[0], w[1], o[2], o[3], o[4]], y: y0 + s.y, x0: w[0] - R, x1: w[0] + R, z0: w[1] - R, z1: w[1] + R }); }
      else if (s.rect) { const r = s.rect, c4 = [W(r[0], r[1]), W(r[2], r[1]), W(r[2], r[3]), W(r[0], r[3])]; F.solids.push({ poly: c4, y: y0 + s.y, x0: Math.min(...c4.map(p => p[0])), x1: Math.max(...c4.map(p => p[0])), z0: Math.min(...c4.map(p => p[1])), z1: Math.max(...c4.map(p => p[1])) }); }
      else if (s.poly) { const p4 = s.poly.map(p => W(p[0], p[1])); F.solids.push({ poly: p4, y: y0 + s.y, x0: Math.min(...p4.map(p => p[0])), x1: Math.max(...p4.map(p => p[0])), z0: Math.min(...p4.map(p => p[1])), z1: Math.max(...p4.map(p => p[1])) }); }
    }
  }

  // ── landmark lifecycle ──────────────────────────────────────────────────────────────────────────────────
  const hashS = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  function dispose(o) { o.traverse(n => { if (n.geometry) n.geometry.dispose(); }); }
  function teardown() {
    crumb('begin', 'fac:teardown');
    HQ.epoch++; const dropped = HQ.q.splice(0); dropped.forEach(j => { try { j.stale && j.stale(); } catch (e) { } }); crumb('live', 'facQueue', 0);   // queued texture / interior steps belong to the world that is gone
    if (window.DMMansionCol) { try { DMMansionCol.detach(); } catch (e) { } }
    if (window.DMHolo) { try { DMHolo.detach(); } catch (e) { } }
    if (window.DMLamps) { try { DMLamps.detach(); } catch (e) { } }
    if (window.DMMansionInt) { try { DMMansionInt.detach(); } catch (e) { } }
    for (const r of F.sites.values()) { if (r.group && r.group.parent) r.group.parent.remove(r.group); if (r.group && !r.mansion) dispose(r.group); }
    try { if (window.DMCollide && DMCollide.clearGroup) DMCollide.clearGroup('facility'); } catch (e) { }
    F.car = null; F.sites.clear(); F.solids.length = 0; F.bay = null; DM.bay.inside = false; DM.bay.membrane = 0;
    crumb('end', 'fac:teardown');
  }
  // called by index.html _pwClose BEFORE the world scene is disposed: the interior and every queued step go first, so nothing loads into / touches a scene that is being freed
  F.close = function () { try { if (F.scene || F.sites.size) { teardown(); } F.scene = null; } catch (e) { console.warn('[facilities] close', e); } };
  function place(rec, T, PW, TERRAIN) {
    const H = F.baseH || TERRAIN.H, site = rec.def, b = rec.best, d = [b.dx, b.dz];
    if (site.kind === 'city') {
      const built = buildCity(T, hashS(site.id)); rec.group = built.group; rec.clouds = built.clouds;
      rec.group.position.set(b.x, 0, b.z); PW.scene.add(rec.group); F.ctx.mapTag(rec.group);
      addSolids(built.solids, b.x, b.z, 0, 0); rec.solidN = built.solids.length; rec.ready = true; rec.x = b.x; rec.z = b.z; rec.y = 0; rec.th = 0; return;
    }
    if (site.kind === 'mansion') {
      if (!MAN.glb) return;     // wait for the asset
      const th = Math.atan2(-d[0], -d[1]), px = b.x, pz = b.z, ct = Math.cos(th), st = Math.sin(th);
      let y0 = H(px, pz); for (const [lx, lz] of [[0, 40], [-30, 40], [30, 40], [0, 80], [-60, 0], [60, 0]]) { y0 = Math.max(y0, H(px + lx * ct + lz * st, pz - lx * st + lz * ct)); }   // local +Z is inland
      y0 += 0.3;
      const root = mansionInstance(T); root.position.set(px, y0, pz); root.rotation.y = th; root.updateMatrixWorld(true);
      PW.scene.add(root);
      // (v227) Tag FIRST, compile SECOND. mapTag gives every material its planet-frame positionNode/maskNode and flips needsUpdate, so compiling
      // before it (the v224 order) built pipelines that the first real draw threw away and rebuilt, a second compile storm in the arrival frame.
      F.ctx.mapTag(root);
      if (window.DMLod && DMLod.on) { try { DMLod.fadeMask(root); } catch (e) { } }   // (far-range) the cross-fade test joins the planet mask BEFORE the warm-up compile, so it is not compiled twice
      // Warm only the LOD that will be seen: on the HOME deck that is lod0 (she lands inside 420 m); otherwise the far one. Never both.
      const u0 = root.userData, homeNear = !!(DM.homeDeck && DM.arriveAt === site.id);
      if (u0.lod0) u0.lod0.visible = homeNear; if (u0.lod1) u0.lod1.visible = !homeNear;
      rec.placedAt = performance.now(); rec.warmed = false;
      try {
        if (PW.renderer && PW.renderer.compileAsync && PW.camera) PW.renderer.compileAsync(root, PW.camera, PW.scene).then(() => { rec.warmed = true; }, () => { rec.warmed = true; });
        else rec.warmed = true;
      } catch (e) { rec.warmed = true; }
      carveActivate(px, pz, ct, st, y0);
      rec.group = root; rec.mansion = true; rec.x = px; rec.z = pz; rec.y = y0; rec.th = th; rec.ready = true;
      if (window.DMMansionInt) { try { DMMansionInt.attach(F, rec, px, pz, y0, th); } catch (e) { console.warn('[mansion-interior] attach', e); } }
      if (window.DMMansionCol) { try { DMMansionCol.attach(F, rec); } catch (e) { console.warn('[mansion-collide] attach', e); } }
      if (window.DMHolo) { try { DMHolo.attach(F, rec); } catch (e) { console.warn('[holo] attach', e); } }
      if (window.DMLamps) { try { DMLamps.attach(F, rec, px, pz, y0, th); } catch (e) { console.warn('[lamps] attach', e); } }
      const col = MAN.col, nx = col.nx, ny = col.ny, inv = 1 / col.scale, cell = col.cell, hh = col.h;
      const R = 230;
      F.solids.push({ x0: px - R, x1: px + R, z0: pz - R, z1: pz + R, grid: (x, z) => {
        const dx = x - px, dz = z - pz, lx = dx * ct - dz * st, lz = dx * st + dz * ct, bx = lx, by = -lz;
        const i = Math.round((bx - col.x0) / cell), j = Math.round((by - col.y0) / cell); if (i < 0 || j < 0 || i >= nx || j >= ny) return NEG;
        const v = hh[j * nx + i] * inv; return v <= col.sea + 0.6 ? NEG : y0 + v;
      } });
      return;
    }
    // facility: deck level = the highest ground under the building, so nothing is buried
    const th = Math.atan2(d[0], d[1]), px = b.x, pz = b.z, ct = Math.cos(th), st = Math.sin(th);
    let y0 = H(px, pz);
    for (const [lx, lz] of [[-24, -6], [24, -6], [0, -14], [-20, -30], [20, -30], [0, -40], [-30, 0], [30, 0]]) y0 = Math.max(y0, H(px + lx * ct + lz * st, pz - lx * st + lz * ct));
    y0 = Math.max(y0 + 0.2, SEA + 1.5);
    const built = buildFacility(T, site.variant); rec.group = built.group; rec.group.position.set(px, y0, pz); rec.group.rotation.y = th;
    PW.scene.add(rec.group); F.ctx.mapTag(rec.group); rec.x = px; rec.z = pz; rec.y = y0; rec.th = th; rec.ready = true; rec.bay = built.bay;
    addSolids(built.solids, px, pz, th, y0);
    if (built.bay) { F.bay = rec; }
  }
  function teleport(rec) {
    const c = F.ctx, st = c.atmoState(); if (!st || !rec.ready || DM.arriveAt !== rec.def.id) return;
    DM.arriveAt = null;
    let tx, tz, ty, fx, fz, land = false;
    if (rec.def.kind === 'city') { tx = rec.x + 330; tz = rec.z + 80; ty = 70; fx = rec.x - tx; fz = rec.z - tz; }
    else if (rec.mansion && DM.homeDeck) {   // HOME: set her down on the arrowhead skyboard deck (collision-grid flat patch, local x≈-68, 22 m off the lip)
      const ct = Math.cos(rec.th), sn = Math.sin(rec.th), lx = -68, lz = -22;
      tx = rec.x + lx * ct + lz * sn; tz = rec.z - lx * sn + lz * ct; ty = rec.y + 8; fx = rec.x - tx; fz = rec.z - tz; land = true;
    }
    else if (rec.mansion) { const sd = [rec.best.dx, rec.best.dz]; tx = rec.x + sd[0] * 260; tz = rec.z + sd[1] * 260; ty = Math.max(SEA, rec.y - 62) + 55; fx = rec.x - tx; fz = rec.z - tz; }
    else { const sd = [rec.best.dx, rec.best.dz]; tx = rec.x + sd[0] * 120; tz = rec.z + sd[1] * 120; ty = rec.y + 22; fx = rec.x - tx; fz = rec.z - tz; }
    st.pos.set(tx, ty, tz); st.vel.set(0, 0, 0); st.yaw = Math.atan2(-fx, -fz); st.pitch = -0.08;
    DM.homeDeck = false;
    try { c.afterTeleport(land); } catch (e) { }
  }

  let lastScan = 0, mlastEv = 0, lastM = -1, lastIn = false;
  F.status = () => Array.from(F.sites.values()).map(r => ({ id: r.def.id, ready: !!r.ready, x: r.x, y: r.y, z: r.z, score: r.sr && r.sr.score, searching: !r.ready && !!r.sr && r.sr.i < r.sr.cells.length }));

  F.tick = function (dt, f, mode) {
    const c = F.ctx; if (!c) return;
    const PW = c.PW(), TERRAIN = c.TERRAIN(), T = c.THREE;
    if (!PW || !PW.active || !PW.scene || !TERRAIN || !TERRAIN.H) { if (F.scene) { teardown(); F.scene = null; } return; }
    if (F.scene !== PW.scene) { const bh = F.baseH; teardown(); F.scene = PW.scene; F.baseH = bh; }
    if (!F.baseH) return;         // set by wrapH (index.html wraps right where the ground is built)
    const now = performance.now(), sysName = c.curSysName(), body = PW.body && PW.body.name;
    // which landmarks belong to this world; start a search when she's within reach of one
    if (now - lastScan > 700) {
      lastScan = now;
      for (const s of window.DMArielHome ? DMArielHome.SITES : []) {
        if (s.body !== body || (s.sys || 'Sol') !== sysName || F.sites.has(s.id)) continue;
        const ce = c.atmoXZ(s.lat, s.lon), dd = Math.hypot(ce.x - f.x, ce.z - f.z);
        if (dd > 7000 && DM.arriveAt !== s.id) continue;
        const R = s.kind === 'mansion' ? 2600 : s.kind === 'city' ? 1400 : 440, step = s.kind === 'mansion' ? 90 : s.kind === 'city' ? 120 : 44;
        const rec = { def: s, sr: newSearch(s.kind === 'mansion' ? 'coast' : s.kind === 'city' ? 'sea' : 'cliff', ce.x, ce.z, R, step), ready: false, t0: now };
        F.sites.set(s.id, rec); if (s.kind === 'mansion') loadMansion();
      }
    }
    for (const rec of F.sites.values()) {
      if (rec.ready) continue;
      // (perf) the search result does not depend on how it is sliced (cells are visited in the same order), so the per-frame slice follows the frame:
      // the full 4 ms only while an arrival is waiting on it; otherwise 2 ms, 1 ms on a slow frame (dt > 40 ms) - it used to cost 4 ms of EVERY frame
      // (a 3.4k-cell mansion coast search of 8 rays x 5 height-field samples each) on a 15 fps tablet, and nobody is waiting for a landmark 7 km away.
      if (rec.sr.i < rec.sr.cells.length) { stepSearch(rec.sr, F.baseH, DM.arriveAt === rec.def.id ? 4 : (dt > 0.04 ? 1 : 2)); }
      if (rec.sr.i >= rec.sr.cells.length) {
        if (!rec.best) { rec.best = rec.sr.best || { x: rec.sr.cells[0][0], z: rec.sr.cells[0][1], dx: 0, dz: 1, h: F.baseH(rec.sr.cells[0][0], rec.sr.cells[0][1]), s: -1 }; }
        if (rec.def.kind === 'mansion' && !MAN.glb) { if (MAN.failed) { rec.ready = true; rec.failed = true; } continue; }
        try { place(rec, T, PW, TERRAIN); } catch (e) { console.warn('[facilities] place', rec.def.id, e); rec.ready = true; rec.failed = true; }
      }
    }
    // per-landmark upkeep: LOD, 2K, drift, bay hook
    for (const rec of F.sites.values()) {
      if (!rec.ready || !rec.group) continue;
      // (v227) hold the arrival until the mansion's pipelines are built (or 9 s, whichever first), so landing, surface setup and the first
      // mansion draw no longer all hit the same frame (the iPhone Safari reload). Free flight is unaffected.
      if (rec.teleported !== true && DM.arriveAt === rec.def.id && (!rec.mansion || rec.warmed || now - rec.placedAt > 9000)) { teleport(rec); rec.teleported = true; }
      const dx = f.x - rec.x, dz = f.z - rec.z, d2 = dx * dx + dz * dz;
      if (rec.mansion) {
        // (LOD) hysteresis (enter 400 m / leave 470 m; phones 300 / 360) so a hover on the boundary cannot flip the two meshes frame to frame, and the interior (ui/dm-mansion-interior.js
        // LOAD_D) is requested BEFORE the swap to LOD0 so the windows are never "lit sheets" at LOD1 and empty glass at LOD0.
        const u = rec.group.userData, mob = F.ctx.isMobile(), LD = window.DMLod && DMLod.on ? DMLod.mansion() : null, nIn = LD ? LD.nIn : mob ? 300 : 400, nOut = LD ? LD.nOut : mob ? 360 : 470, farM = LD ? LD.far : 5200, dyA = f.y - rec.y, d3sq = d2 + (dyA === dyA && isFinite(dyA) ? dyA * dyA : 0), d1 = Math.sqrt(d3sq);   // (v289) 3-D distance: altitude counts, so a mansion 20 km below you is far, not 'near' (it used to be measured on the ground plane only)
        rec.farM = farM;   // distances: ui/dm-lod.js table (same 300/360 phone, 400/470 desktop)
        if (rec.lodNear === undefined) rec.lodNear = d1 < nIn; else if (rec.lodNear && d1 > nOut) rec.lodNear = false; else if (!rec.lodNear && d1 < nIn) rec.lodNear = true;
        const inR = rec.inRange === undefined ? d1 < farM : (rec.inRange ? d1 <= farM * 1.04 : d1 < farM); rec.inRange = inR;   // 4 % hysteresis at the cull
        const near = rec.lodNear, far = !inR;
        lodBands(rec, u, near, far, d1, dt, T);
        if (MAN.glb && !MAN.lod2Tried && window.DMImpostor && window.DMLod && DMLod.on) kickLod2(T);
        if (MAN.lod2 && !rec.lod2) attachLod2(rec, T);
        if (d3sq < 1100 * 1100) { upgrade2K(T); mansionPx(T); upgradeCliff(T); }
        if (window.DMMansionInt) DMMansionInt.tick(rec, d3sq, now, DM.arriveAt === rec.def.id);
        if (window.DMHolo) { try { DMHolo.tick(rec, d3sq, now, dt); } catch (e) { if (!rec.holoWarn) { rec.holoWarn = 1; console.warn('[holo] tick', e); } } }
        if (window.DMLamps) { try { DMLamps.tick(rec, d3sq, now, dt, f, mode); } catch (e) { if (!rec.lampWarn) { rec.lampWarn = 1; console.warn('[lamps] tick', e); } } }   // street lamps + room switches (a failure here must never stop the facility upkeep)
      } else { const fc = window.DMLod && DMLod.on ? DMLod.get('facility.cull') : 6000; const dyB = f.y - rec.y; rec.group.visible = d2 + (dyB === dyB && isFinite(dyB) ? dyB * dyB : 0) < fc * fc; }   // (v289) altitude counts here too
      if (rec.clouds) for (const p of rec.clouds) { const t = p.material.map; t.offset.x += p.userData.v * dt; t.offset.y += p.userData.v * 0.6 * dt; }
      if (rec.bay) {
        const bm = rec.bay.meshes; for (let i = 0; i < bm.length; i++) { const t = bm[i].material.map; t.offset.x += (0.012 + i * 0.004) * dt; t.offset.y += 0.006 * dt; }
      }
    }
    // the Titan bay: where is the character group relative to the membrane volume?
    const br = F.bay;
    if (br && br.ready && br.bay) {
      const B = br.bay, ct = Math.cos(br.th), st = Math.sin(br.th), dx = f.x - br.x, dz = f.z - br.z;
      const lx = dx * ct - dz * st, lz = dx * st + dz * ct, ly = f.y - br.y;
      let inside = false, mem = 0;
      if (Math.abs(lx) <= B.hw && ly >= -1 && ly <= B.hh + 2 && lz <= B.zOut && lz >= B.zBack) {
        if (lz > B.zIn) mem = Math.min(1, Math.max(0, (B.zOut - lz) / (B.zOut - B.zIn))); else { mem = 1; inside = true; }
      }
      const bay = DM.bay; bay.inside = inside; bay.membrane = mem;
      if (inside !== lastIn || (Math.abs(mem - lastM) > 0.04 && now - mlastEv > 80) || ((mem === 0) !== (lastM === 0))) {
        lastIn = inside; lastM = mem; mlastEv = now;
        try { window.dispatchEvent(new CustomEvent('dm:bay', { detail: { id: B.id, inside, membrane: mem } })); } catch (e) { }
      }
    } else if (DM.bay.inside || DM.bay.membrane) { DM.bay.inside = false; DM.bay.membrane = 0; if (lastIn || lastM > 0) { lastIn = false; lastM = 0; try { window.dispatchEvent(new CustomEvent('dm:bay', { detail: { id: 'titan', inside: false, membrane: 0 } })); } catch (e) { } } }
  };
  F._t = { get upgradeCliff() { return upgradeCliff; }, get upgrade2K() { return upgrade2K; }, MAN, HQ };   // test hooks (tools/tests/mansion-cycle.js)
})();
