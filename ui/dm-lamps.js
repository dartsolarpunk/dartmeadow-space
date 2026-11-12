// DM Lamps — property street lamps + room light switches for Ariel's mansion (night lighting that costs almost nothing).
//
// What it is (all of it hangs under the mansion root, so it moves, bends with the planet frame and is freed with the mansion):
//   • ~35 street lamps (assets/ariel-home/ariel-home-lamps.json, planned offline by tools/ariel-home/plan_lamps.js from the collision grid: court paths, the landing deck,
//     the cliff terraces, 7.9 m or more apart). Built in code, 4.4 m poles on a 1.78 units/m scale:
//       poles   one InstancedMesh (pole, plinth, arm, hood merged)         1 draw call
//       heads   one InstancedMesh (emissive luminaire slab)                1 draw call
//       glow    one InstancedMesh of camera-facing sprites (additive)      1 draw call
//       pools   ONE merged mesh of light pools: a lattice per lamp, drawn only on the cells at the lamp's own ground height (so no pool ever floats over a drop), vertex
//               alpha = falloff, additive, no depth write. The "baked" pool of an exterior lamp (the GI lightmap only covers the interior).
//     Everything is driven by ONE intensity uniform (dusk fade of the world's sun, ui/dm-sky.js `day`), eased; at full daylight the group is hidden (zero cost).
//   • (lamp lights 2) REAL lamp lights, by DMLight tier (lampPlan): a small pool of PointLights kept on the lamps nearest her, with real shadow maps on the first few. low = none
//     (the radiance cache already lights the probes from the lamps); med = 2 lights, 1 shadowed (512, every 3rd frame); high = 3 / 2 (512, every 2nd); ultra = 4 / 3 (1024, every frame).
//     Never added or removed after setup (adding one recompiles every lit material, so it happens once, when the lamps are built), intensity-faded per slot, re-aimed 3x a second with
//     hysteresis, shadow maps refreshed on a cadence and shed by DMBudget (docs/lighting-notes.md). `?lamplights=0` off, `?lamplights=N` count, `?lampshadow=0|px`, `?lamptier=`, `?lampk=`.
//   • Room switches: a slim post with a lit plate just inside each room's door (ui/dm-mansion-rooms.js). Walk up (within 2.8 m): a USE bubble (tap it, or F) flips the room;
//     hold it for AUTO again; or tap the post in the 3D view. The room's level is eased over 0.25 s and written into the interior material's uniform array
//     (DMMansionLook.setRoomLevels). Rooms start on AUTO: on at night, a touch dimmer by day. Modes persist in the save (`mansionLights`) and localStorage `dm_mansion_rooms`.
//   • (v298, Wave 1) balcony-rail LEDs (JSON `leds` [x, y, z, yaw], planned by plan_lamps.js at the bottom corners of the glass railing panes round the HOME arrowhead deck,
//     which no longer has a street lamp): small emissive studs (1 instanced draw) + a small glow (1 instanced draw, tier >= 1) + their own light pools merged into the pool
//     mesh. NOT solid: they are never registered in DMCollide (only `lamps` + room switch posts are), no raycast, no shadow, no real light, no radiance-cache lamp.
// Budget: no per-frame allocation (scratch vectors), no render passes, no shadows, nothing runs while it is day and she is outside / away, tiers: Low = no glow sprites.
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const UPM = 1.78, POLE_H = 4.4 * UPM, ARM = 1.15 * UPM, LS = 'dm_mansion_rooms';
  const DRAW_D2 = 700 * 700, SW_D2 = 320 * 320, REACH = 5.0, POOL_R = 11, POOL_Y = 0.08, EDGE_CELLS = 3;
  const LED_POOL_R = 8, LED_GAIN = 0.55, LED_GLOW = 1.1 * UPM;   // rail LEDs: pool radius (== plan_lamps.js LED_R), pool strength vs a street lamp, glow sprite size

  // ── pure geometry (also run by tools/tests/mansion-lamps.js) ─────────────────────────────────────────────
  // head position of lamp l = [x, y, z, kind, yaw]: the luminaire hangs ARM units out along yaw, at the pole's top (nav frame: x east, y seaward, z up)
  function headPos(l) { return [l[0] + Math.cos(l[4] || 0) * ARM, l[1] + Math.sin(l[4] || 0) * ARM, l[2] + POLE_H]; }
  function boxTo(P, I, N, x0, y0, z0, x1, y1, z1) {   // axis-aligned box (three frame y up) appended to the arrays, flat normals
    const f = [[[0, 0, 1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[0, 0, -1], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
      [[1, 0, 0], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [[-1, 0, 0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      [[0, 1, 0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [[0, -1, 0], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]];
    for (const q of f) { const b = P.length / 3; for (let k = 1; k <= 4; k++) { P.push(q[k][0], q[k][1], q[k][2]); N.push(q[0][0], q[0][1], q[0][2]); } I.push(b, b + 1, b + 2, b, b + 2, b + 3); }
  }
  function poleArrays() {   // local frame: x = along the arm, y up, z across. A pole, a plinth, an arm and a hood over the luminaire
    const P = [], I = [], N = [], r = 0.11 * UPM, h = POLE_H;
    boxTo(P, I, N, -0.45 * UPM, 0, -0.45 * UPM, 0.45 * UPM, 0.3 * UPM, 0.45 * UPM);                      // plinth
    boxTo(P, I, N, -r * 1.4, 0.3 * UPM, -r * 1.4, r * 1.4, 0.75 * UPM, r * 1.4);                           // collar
    boxTo(P, I, N, -r, 0.75 * UPM, -r, r, h, r);                                                            // pole
    boxTo(P, I, N, -r, h - 0.1 * UPM, -r * 0.7, ARM, h + 0.04 * UPM, r * 0.7);                              // arm
    boxTo(P, I, N, ARM - 0.55 * UPM, h + 0.04 * UPM, -0.3 * UPM, ARM + 0.55 * UPM, h + 0.17 * UPM, 0.3 * UPM);   // hood
    return { P, I, N };
  }
  function headArrays() { const P = [], I = [], N = []; boxTo(P, I, N, ARM - 0.5 * UPM, h0(), -0.26 * UPM, ARM + 0.5 * UPM, h0() + 0.07 * UPM, 0.26 * UPM); return { P, I, N }; }
  function ledArrays() { const P = [], I = [], N = []; boxTo(P, I, N, -0.07 * UPM, 0, -0.09 * UPM, 0.0, 0.05 * UPM, 0.09 * UPM); return { P, I, N }; }   // ~4 x 10 cm stud, x = toward the deck
  function h0() { return POLE_H - 0.02 * UPM; }
  function switchArrays() { const P = [], I = [], N = []; boxTo(P, I, N, -0.07 * UPM, 0, -0.07 * UPM, 0.07 * UPM, 1.05 * UPM, 0.07 * UPM); boxTo(P, I, N, -0.22 * UPM, 0.38 * UPM, -0.06 * UPM, 0.22 * UPM, 0.38 * UPM + 0.5 * UPM, 0.07 * UPM); return { P, I, N }; }
  function plateArrays() { const P = [], I = [], N = []; boxTo(P, I, N, -0.17 * UPM, 0.43 * UPM, 0.07 * UPM, 0.17 * UPM, 0.43 * UPM + 0.4 * UPM, 0.095 * UPM); return { P, I, N }; }
  // light pools: per lamp a lattice of the grid nodes (cell = 2 units) within POOL_R of the head's ground point that are land at (nearly) the lamp's own height; quads only
  // where all four nodes qualify. Returns three-frame positions (x, h+POOL_Y, -y), alpha per vertex, indices.
  function pools(col, lamps, g, led) {   // led = true: lamps are rail LEDs [x, y, z, yaw] (pool round the stud itself, LED_POOL_R, dimmer)
    const nx = col.nx, c = col.cell, P = [], A = [], I = [], PR = led ? LED_POOL_R : POOL_R, gain = led ? LED_GAIN : 1;
    for (const l of lamps) {
      const hp = led ? l : headPos(l), cx = hp[0], cy = hp[1], r = Math.ceil(PR / c), i0 = Math.round((cx - col.x0) / c), j0 = Math.round((cy - col.y0) / c), W = 2 * r + 1, id = new Int32Array(W * W).fill(-1), base = P.length / 3;   // base = first vertex of this lamp's pool
      // (lighting overhaul) a node that borders a cell the pool cannot cover (a drop, water, the lattice end) fades to 0 instead of keeping its radial alpha: the pool used to end in a hard cut at every ledge / rail
      const okN = new Uint8Array(W * W);
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nx || j >= col.ny) continue;
        const h = g[j * nx + i], d = Math.hypot(col.x0 + i * c - cx, col.y0 + j * c - cy);
        if (h <= col.sea + 0.6 || Math.abs(h - l[2]) > 0.35 || d > PR) continue; okN[(dj + r) * W + di + r] = 1;
      }
      // (follower fix 2) the fade at a border is now a smoothstep over EDGE_CELLS cells of distance from the border (was: the border node alone = one cell): a pool that ends at a rail / ledge / water edge no longer reads as a hard-edged lit shape
      const bd = new Int16Array(W * W).fill(99), qd = [];
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const q = (dj + r) * W + di + r; if (!okN[q]) continue;
        let bdr = false; for (let b = 0; b < 4; b++) { const ni = di + (b === 0 ? 1 : b === 1 ? -1 : 0), nj = dj + (b === 2 ? 1 : b === 3 ? -1 : 0); if (ni < -r || nj < -r || ni > r || nj > r || !okN[(nj + r) * W + ni + r]) bdr = true; }
        if (bdr) { bd[q] = 0; qd.push(q); } }
      for (let h = 0; h < qd.length; h++) { const q = qd[h], x = q % W, y = (q / W) | 0, v = bd[q] + 1; if (v > EDGE_CELLS) continue;   // multi-source BFS: distance (cells) to the nearest border node, only needed up to EDGE_CELLS
        if (x + 1 < W && okN[q + 1] && bd[q + 1] > v) { bd[q + 1] = v; qd.push(q + 1); } if (x > 0 && okN[q - 1] && bd[q - 1] > v) { bd[q - 1] = v; qd.push(q - 1); }
        if (y + 1 < W && okN[q + W] && bd[q + W] > v) { bd[q + W] = v; qd.push(q + W); } if (y > 0 && okN[q - W] && bd[q - W] > v) { bd[q - W] = v; qd.push(q - W); } }
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const q = (dj + r) * W + di + r; if (!okN[q]) continue; const i = i0 + di, j = j0 + dj;
        const h = g[j * nx + i], x = col.x0 + i * c, y = col.y0 + j * c, d = Math.hypot(x - cx, y - cy);
        let edge = 1; if (bd[q] < EDGE_CELLS && d > c * 1.5) { const u = bd[q] / EDGE_CELLS; edge = u * u * (3 - 2 * u); }   // keep the node under the lamp itself even on a 1-cell island
        const t = 1 - d / PR, f = t * t * (3 - 2 * t); id[q] = P.length / 3 - base; P.push(x, h + POOL_Y, -y); A.push(f * f * gain * edge);
      }
      for (let dj = 0; dj < 2 * r; dj++) for (let di = 0; di < 2 * r; di++) {
        const a = id[dj * W + di], b = id[dj * W + di + 1], d2 = id[(dj + 1) * W + di + 1], e = id[(dj + 1) * W + di]; if (a < 0 || b < 0 || d2 < 0 || e < 0) continue;
        I.push(a + base, e + base, b + base, b + base, e + base, d2 + base);
      }
    }
    return { P, A, I };
  }
  // ── real lamp lights: tier plan + nearest pick (pure, tested by tools/tests/mansion-lamps.js) ─────────────────────────────
  // n = lights kept, sh = how many of them cast a shadow map, map = side of ONE face (a point light's atlas is 4 x 2 faces: 512 -> 2048 x 1024 x 4 B = 8 MB), every = shadow refresh cadence (frames),
  // rad = PCF softness (shadow.radius).  low/off: no real lights (probe lighting only).
  const LAMP_LEVELS = { off: { n: 0, sh: 0, map: 0, every: 0, rad: 0 }, low: { n: 0, sh: 0, map: 0, every: 0, rad: 0 }, med: { n: 2, sh: 1, map: 512, every: 3, rad: 1.5 }, high: { n: 3, sh: 2, map: 512, every: 2, rad: 2 }, ultra: { n: 4, sh: 3, map: 1024, every: 1, rad: 3 } };
  // o: { n (flag, null = tier), shadow (flag: null = tier, 0 = none, px = force map side), bud: { shadow, light, every } (DMBudget levels) }.  Returns the allocation (n, sh, map, rad) and what is ACTIVE now (nOn, active, every; every 0 = frozen).
  function lampPlan(tier, o) {
    o = o || {}; const t = LAMP_LEVELS[tier] || LAMP_LEVELS.low, b = o.bud || {}; let n = t.n, sh = t.sh, map = t.map, every = t.every, rad = t.rad;
    if (o.n != null) { n = Math.max(0, Math.min(6, o.n | 0)); sh = Math.min(sh, n); }
    if (o.shadow === 0) sh = 0; else if (o.shadow > 0 && n > 0) { map = Math.max(128, Math.min(2048, o.shadow | 0)); sh = Math.max(sh, Math.min(n, 1)); if (!every) every = 3; if (!rad) rad = 1.5; }
    if (!sh) { map = 0; every = 0; }
    let active = sh, nOn = n, ev = every;
    const bs = b.shadow | 0, bl = b.light | 0;
    if (bs >= 2 || bl >= 2) active = Math.min(active, 1);          // the ladder is shedding: one shadowed lamp
    if (bs >= 3 || bl >= 3) { active = 0; nOn = Math.min(nOn, 2); } // ... then none (the lights stay, their maps freeze)
    if (b.every > ev) ev = b.every; if (bs >= 4 || ev >= 30) ev = 0;
    return { tier, n, sh, map, rad, every, nOn, active, ev: active ? ev : 0 };
  }
  // the `n` nearest of `lamps` ([x, y, z, ...], nav frame) to (x, y, z); z counts 1.5x (another terrace is farther than it looks). out: Int16Array(n) of indices, nearest first, -1 padded. No allocation but the scratch.
  const _pd = new Float64Array(128);
  function pickNearest(lamps, x, y, z, n, out) {
    const m = Math.min(lamps.length, 128); for (let i = 0; i < m; i++) { const l = lamps[i], dx = l[0] - x, dy = l[1] - y, dz = (l[2] - z) * 1.5; _pd[i] = dx * dx + dy * dy + dz * dz; }
    for (let a = 0; a < n; a++) { let bi = -1, bd = 1e18; for (let i = 0; i < m; i++) { if (_pd[i] < bd) { let dup = false; for (let b = 0; b < a; b++) if (out[b] === i) { dup = true; break; } if (!dup) { bd = _pd[i]; bi = i; } } } out[a] = bi; }
    return out;
  }
  const withYaw = lamps => lamps.map(l => l.length > 4 ? l : [l[0], l[1], l[2], l[3], 0]);   // the planner stores the arm yaw (toward the middle of the lamp's level)

  // ── runtime ────────────────────────────────────────────────────────────────────────────────────────────────
  const S = { F: null, rec: null, built: false, building: false, J: null, jp: null, grp: null, on: 0, day: 1, ct: 1, st: 0, px: 0, pz: 0, y0: 0, th: 0, sw: -1, swHold: 0, hud: null, last: 0,
    U: null, lights: [], slots: [], plan: null, casting: 0, lampK: 1, shN: 0, frame: 0, near: new Int16Array(8), nl: 0, lt: 0, tap: null, mats: [], geos: [], pending: false, pool: 0 };
  const q = (() => { try { return new URLSearchParams(G.location.search); } catch (e) { return new URLSearchParams(''); } })();
  S.duskStart = +(q.get('dusk') || 0) || 0;   // ?dusk=<deg>: elevation the lamps start fading in (default 14)
  const ST = () => G.DMMansionRooms;
  try { const j = JSON.parse(G.localStorage.getItem(LS) || 'null'); if (j && ST()) ST().set(j); } catch (e) { }
  function persist() { try { G.localStorage.setItem(LS, JSON.stringify(ST().get())); } catch (e) { } }

  function build(F, rec) {
    const c = F.ctx, THREE = c.THREE, T = THREE.TSL, R = ST(), col = F.manCol && F.manCol(); if (!R || !col || !T || !T.uniformArray || !THREE.SpriteNodeMaterial) return false;
    const lamps = withYaw(S.J.lamps), n = lamps.length, tier = c.tier ? c.tier() : 2, leds = Array.isArray(S.J.leds) ? S.J.leds : [], nL = leds.length;
    if (!col.h) return false; const g = new Float64Array(col.h.length), inv = 1 / col.scale; for (let i = 0; i < g.length; i++) g[i] = col.h[i] * inv;   // metres-of-grid heights, same decode as the facility's collision grid
    const U = S.U = { on: T.uniform(0), hp: T.uniformArray(lamps.map(l => { const h = headPos(l); return new THREE.Vector3(h[0], h[2] - 0.06 * UPM, -h[1]); }), 'vec3') };
    const grp = new THREE.Group(); grp.name = 'JOTS_ArielLamps'; S.grp = grp; grp.visible = false;
    const mk = (arr, mat, count, name) => { const gm = new THREE.BufferGeometry(); gm.setAttribute('position', new THREE.Float32BufferAttribute(arr.P, 3)); gm.setAttribute('normal', new THREE.Float32BufferAttribute(arr.N, 3)); gm.setIndex(arr.I); const m = new THREE.InstancedMesh(gm, mat, count); m.name = name; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; S.geos.push(gm); S.mats.push(mat); return m; };
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0);
    const place = (mesh, i, x, y, z, yaw) => { Q.setFromAxisAngle(UP, yaw); mesh.setMatrixAt(i, M4.compose(V.set(x, y, z), Q, SC)); };
    // poles + heads
    const poleM = new THREE.MeshStandardNodeMaterial({ color: 0x16181d, metalness: 0.7, roughness: 0.42 });
    const poles = mk(poleArrays(), poleM, n, 'lamp_poles'), onC = T.vec3(1.0, 0.8, 0.5), offC = T.vec3(0.07, 0.075, 0.085);
    const headM = new THREE.MeshBasicNodeMaterial(); headM.colorNode = T.mix(offC, onC.mul(2.4), U.on); headM.fog = false;
    const heads = mk(headArrays(), headM, n, 'lamp_heads');
    lamps.forEach((l, i) => { place(poles, i, l[0], l[2], -l[1], l[4]); place(heads, i, l[0], l[2], -l[1], l[4]); });
    poles.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true; grp.add(poles, heads);
    // rail LEDs: emissive studs (same on/off ramp as the lamp heads, cooler white), no raycast, no shadow, NOT solid (see the collision block below)
    if (nL) { const ledM = new THREE.MeshBasicNodeMaterial(); ledM.colorNode = T.mix(offC, T.vec3(1.0, 0.88, 0.7).mul(2.6), U.on); ledM.fog = false;
      const st = mk(ledArrays(), ledM, nL, 'rail_leds'); st.raycast = () => { }; leds.forEach((l, i) => place(st, i, l[0], l[2], -l[1], l[3] || 0)); st.instanceMatrix.needsUpdate = true; grp.add(st); S.ledMesh = st;
      if (tier >= 1) { const lp = T.uniformArray(leds.map(l => new THREE.Vector3(l[0], l[2] + 0.04 * UPM, -l[1])), 'vec3'); S.U.lp = lp;
        const lg = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }); lg.positionNode = lp.element(T.instanceIndex); lg.scaleNode = T.float(LED_GLOW); lg.fog = false;
        const d = T.uv().sub(0.5).length().mul(2.0), a = T.smoothstep(1.0, 0.0, d); lg.colorNode = T.vec4(T.vec3(1.0, 0.86, 0.62).mul(a.mul(a).mul(1.4).add(0.2)), a.mul(a).mul(0.6).mul(U.on));
        const gl = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), lg, nL); for (let i = 0; i < nL; i++) gl.setMatrixAt(i, M4.identity()); gl.name = 'rail_led_glow'; gl.frustumCulled = false; gl.renderOrder = 4; gl.raycast = () => { }; S.geos.push(gl.geometry); S.mats.push(lg); grp.add(gl); } }
    // glow sprites (one instanced draw): positions from the uniform array, camera facing, additive
    if (tier >= 1) {
      const gm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      gm.positionNode = U.hp.element(T.instanceIndex); gm.scaleNode = T.float(5.2 * UPM); gm.fog = false;
      const d = T.uv().sub(0.5).length().mul(2.0), a = T.smoothstep(1.0, 0.0, d), core = a.mul(a);
      gm.colorNode = T.vec4(T.vec3(1.0, 0.72, 0.4).mul(core.mul(1.5).add(0.25)), a.mul(a).mul(0.55).mul(U.on));
      const gl = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), gm, n); for (let i = 0; i < n; i++) gl.setMatrixAt(i, M4.identity()); gl.name = 'lamp_glow'; gl.frustumCulled = false; gl.renderOrder = 4; gl.raycast = () => { }; S.geos.push(gl.geometry); S.mats.push(gm); grp.add(gl);
    }
    // light pools: one merged additive mesh
    { const pl = pools(col, lamps, g), pe = pools(col, leds, g, true), o = pl.P.length / 3; for (let i = 0; i < pe.P.length; i++) pl.P.push(pe.P[i]); for (let i = 0; i < pe.A.length; i++) pl.A.push(pe.A[i]); for (let i = 0; i < pe.I.length; i++) pl.I.push(pe.I[i] + o);   // LED pools merged: no extra draw
      const gm = new THREE.BufferGeometry(); gm.setAttribute('position', new THREE.Float32BufferAttribute(pl.P, 3)); gm.setAttribute('poolA', new THREE.Float32BufferAttribute(pl.A, 1)); gm.setIndex(pl.I);
      const pm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      pm.colorNode = T.vec4(T.vec3(0.95, 0.6, 0.26).mul(T.attribute('poolA', 'float')).mul(U.on).mul(0.34), 1.0); pm.fog = false;
      const m = new THREE.Mesh(gm, pm); m.name = 'lamp_pools'; m.frustumCulled = false; m.renderOrder = 3; m.raycast = () => { }; S.geos.push(gm); S.mats.push(pm); grp.add(m); S.pool = pl.P.length / 3; }
    // room switch posts + plates (plate colour = room state, via instance colour)
    { const rs = R.ROOMS, nr = rs.length, post = mk(switchArrays(), new THREE.MeshStandardNodeMaterial({ color: 0x1b1d22, metalness: 0.6, roughness: 0.4 }), nr, 'switch_posts');
      const plateM = new THREE.MeshBasicNodeMaterial(); plateM.fog = false; const plate = mk(plateArrays(), plateM, nr, 'switch_plates'); S.plates = plate;
      rs.forEach((r, i) => { place(post, i, r.sw[0], r.sw[2], -r.sw[1], 0); place(plate, i, r.sw[0], r.sw[2], -r.sw[1], 0); plate.setColorAt(i, new THREE.Color(1, 0.8, 0.5)); });
      post.instanceMatrix.needsUpdate = true; plate.instanceMatrix.needsUpdate = true; if (plate.instanceColor) plate.instanceColor.needsUpdate = true; S.sg = new THREE.Group(); S.sg.add(post, plate); S.sg.visible = false; grp.add(S.sg); }
    rec.group.add(grp); grp.updateMatrixWorld(true); c.mapTag(grp);
    // collision: every lamp pole (+ collar + plinth) and room switch post is a solid in DMCollide (group 'lamps'), so walking, the board and dynamic bodies meet them.
    // The rail LEDs (`leds`) are deliberately NOT here: they are flush studs at the glass foot, and must never block or hitch her / the board (tools/tests/home-leds.js).
    try { const W = G.DMCollide; if (W && W.addCylinder) { W.clearGroup('lamps'); const me = grp.matrixWorld.elements, sc = Math.hypot(me[0], me[1], me[2]) || 1, wp = new THREE.Vector3(); let nc = 0;
      const solid = (lx, ly, lz) => { wp.set(lx, ly, lz); grp.localToWorld(wp); W.addCylinder('lamps', wp.x, wp.y, wp.y + POLE_H * sc, wp.z, 0.11 * UPM * 1.4 * sc, 'metal'); W.addBox('lamps', wp.x, wp.y + 0.15 * UPM * sc, wp.z, 0.45 * UPM * sc, 0.15 * UPM * sc, 0.45 * UPM * sc, 0, 'stone'); nc += 2; };
      for (const l of lamps) solid(l[0], l[2], -l[1]);
      for (const r of R.ROOMS) if (r.sw) { wp.set(r.sw[0], r.sw[2], -r.sw[1]); grp.localToWorld(wp); W.addCylinder('lamps', wp.x, wp.y, wp.y + 1.05 * UPM * sc, wp.z, 0.2 * UPM * sc, 'metal'); nc++; }
      S.nCol = nc; } } catch (e) { }
    // real lamp lights (see lampPlan): created ONCE here (a new light recompiles every lit material), intensity 0 until dusk; kept in the world scene so terrain, props, the mansion and her all light up
    { const plan = planNow(true); S.plan = plan; S.nl = plan.n;
      if (plan.n > 0) { const PW = c.PW(); const I0 = S.lampK * 80;
        for (let i = 0; i < plan.n; i++) {
          const L = new THREE.PointLight(0xffc27a, 0, 32, 1.5); L.userData.dmLamp = true; L.userData.noCollide = true; L.name = 'JOTS_LampLight' + i; L.matrixAutoUpdate = true;
          L.castShadow = i < plan.sh && !!(c.shadows && c.shadows());
          if (L.castShadow) { try { const sh = L.shadow; sh.mapSize.set(plan.map, plan.map); sh.camera.near = 0.3; sh.bias = -0.003; sh.normalBias = 0.04; sh.radius = plan.rad; sh.autoUpdate = false; sh.needsUpdate = true; const sn = lampShadowNode(L, THREE); if (sn) sh.shadowNode = sn; } catch (e) { L.castShadow = false; } }
          PW.scene.add(L); S.lights.push(L); S.slots.push({ idx: -1, cur: 0, want: 0, sh: L.castShadow, I0 });
        }
        S.casting = S.lights.filter(l => l.castShadow).length; if (S.casting) poles.castShadow = true;   // the poles shade each other / her
      } }
    S.lamps = lamps; S.leds = leds; S.built = true;
    // landing pads (patios, decks, courts, terraces) from the mansion plan: ui/dm-landzones.js; the lamps are part of the plan, so no pad has a lamp or planter in it
    try { const Z = G.DMLandZones; if (Z && G.fetch) fetch('assets/ariel-home/ariel-home-interior-nav.json?v=' + F.ver).then(r => r.json()).then(nav => {
      if (S.grp !== grp) return; const pads = Z.build(nav, lamps).concat(Z.buildGrid(nav, lamps, g, col)), me = grp.matrixWorld.elements, sc = Math.hypot(me[0], me[1], me[2]) || 1, wp = new THREE.Vector3();
      grp.updateMatrixWorld(true); Z.set(pads, (lx, ly, lz, o) => { wp.set(lx, lz, -ly); grp.localToWorld(wp); o[0] = wp.x; o[1] = wp.y; o[2] = wp.z; }, sc); }).catch(() => { }); } catch (e) { }
    try {   // (ui/dm-vlight.js) the lamps + rail LEDs light the volumetric fog / mist: world-space point lights, candela-like colour (warm sodium / cooler LED), level = the dusk fade below
      const VL = G.DMVLight; if (VL && VL.on) { grp.updateMatrixWorld(true); const V3 = new THREE.Vector3(), la = new Float32Array(n * 7), ea = new Float32Array(nL * 7);
        for (let i = 0; i < n; i++) { const h = headPos(lamps[i]); grp.localToWorld(V3.set(h[0], h[2] - 0.06 * UPM, -h[1])); la.set([V3.x, V3.y, V3.z, 380, 235, 114, 22], i * 7); }
        for (let i = 0; i < nL; i++) { const l = leds[i]; grp.localToWorld(V3.set(l[0], l[2] + 0.04 * UPM, -l[1])); ea.set([V3.x, V3.y, V3.z, 70, 58, 42, 7], i * 7); }
        VL.setPoints('lamps', la, { level: 0, gain: 1 }); VL.setPoints('leds', ea, { level: 0, gain: 1 }); }
    } catch (e) { }
    try {   // lamp heads in the world frame -> the radiance cache ([x,y,z, r,g,b, radius] each; warm sodium colour, 16 m reach)
      if (G.DMLight && G.DMLight.on) { grp.updateMatrixWorld(true); const V3 = new THREE.Vector3(), a = new Float32Array(n * 7); for (let i = 0; i < n; i++) { const h = headPos(lamps[i]); grp.localToWorld(V3.set(h[0], h[2] - 0.06 * UPM, -h[1])); a.set([V3.x, V3.y, V3.z, 14, 8.7, 4.2, 16], i * 7); } G.DMLight.setLamps(a);
        // the collision grid (terraces, decks, walls) into the height cache: sun shadows and probe rays see the property.  nav (x east, y seaward, z up) -> group local (x, z, -y) -> world
        const yref = grp.localToWorld(V3.set(0, 0, 0)).y, W3 = new THREE.Vector3();
        G.DMLight.stampGrid({ g, nx: col.nx, ny: col.ny, x0: col.x0, y0: col.y0, cell: col.cell, floor: col.sea + 0.6, wcell: 2,
          fwd: (lx, ly, lz) => { W3.set(lx, lz, -ly); grp.localToWorld(W3); return [W3.x, W3.y, W3.z]; },
          inv: (wx, wz) => { W3.set(wx, yref, wz); grp.worldToLocal(W3); return [W3.x, -W3.z]; } });
      }
    } catch (e) { }
    return true;
  }
  function destroy() {
    try { if (G.DMCollide && G.DMCollide.clearGroup) G.DMCollide.clearGroup('lamps'); if (G.DMLandZones) G.DMLandZones.clear(); } catch (e) { }
    try { if (S.grp && S.grp.parent) S.grp.parent.remove(S.grp); for (const g of S.geos) g.dispose(); for (const m of S.mats) m.dispose(); if (S.plates && S.plates.dispose) S.plates.dispose(); } catch (e) { }
    for (const L of S.lights) { try { if (L.parent) L.parent.remove(L); L.dispose && L.dispose(); } catch (e) { } }
    S.lights.length = 0; S.slots.length = 0; S.casting = 0; S.shN = 0; S.plan = null; S.dk = null; S.geos.length = 0; S.mats.length = 0; S.grp = null; S.built = false; try { if (G.DMVLight) { G.DMVLight.clear('lamps'); G.DMVLight.clear('leds'); } } catch (e) { } try { if (G.DMLight) { G.DMLight.setLamps([]); G.DMLight.setLampLevel(0); G.DMLight.clearOverlays(); } } catch (e) { } S.sg = null; S.plates = null; S.U = null; S.on = 0; hideHud();
  }

  // ── real lamp lights: runtime ───────────────────────────────────────────────────────────────────────────────
  function planNow(alloc) {
    const nf = q.get('lamplights'), sf = q.get('lampshadow'), B = G.DMBudget && G.DMBudget.on ? G.DMBudget : null, DL = G.DMLight;
    const tier = q.get('lamptier') || (DL && DL.on ? DL.tier : 'low');
    S.lampK = +(q.get('lampk') || 1) || 1;
    return lampPlan(tier, { n: nf == null || nf === '' ? null : (+nf | 0), shadow: sf == null || sf === '' ? null : (+sf | 0),
      bud: alloc || !B ? null : { shadow: B.lvl('shadow'), light: B.lvl('light'), every: B.shadowEvery ? B.shadowEvery() : 1 } });
  }
  // DMLight wraps EVERY light's shadow node in receivedShadowNode (sun-box fade + the SUN's height-field visibility); a lamp is not the sun, so its point-shadow node is tagged dmFlashShadow
  // (the same tag the flashlight spot uses, checked by the 4 wrapper branches in ui/dm-light.js) and comes through untouched: without it a lamp's shadow would be multiplied by the sun's visibility (black at night).
  function lampShadowNode(L, THREE) {
    const PSN = THREE && THREE.PointShadowNode; if (typeof PSN !== 'function') return null;
    class LampShadowNode extends PSN { setupShadow(builder) { const o = super.setupShadow(builder); try { o.dmFlashShadow = true; } catch (e) { } return o; } }
    return new LampShadowNode(L, L.shadow);
  }
  function lampLights(c, now, dt, mode, near2) {
    const slots = S.slots, N = slots.length, lamps = S.lamps; S.frame++;
    if (S.on < 0.004 || !near2) { for (let k = 0; k < N; k++) { const sl = slots[k]; sl.want = 0; sl.cur = 0; sl.idx = -1; S.lights[k].intensity = 0; } S.shN = 0; return; }   // by day / away from the property: nothing assigned, nothing lit, no map refreshed
    if (now - S.lt > 330) {   // re-plan under the budget + re-assign
      S.lt = now; const pl = planNow(false); S.plan = pl; const near = S.near, want = Math.min(N, pl.nOn);
      pickNearest(lamps, S.lx, S.ly, S.feet, want, near);
      for (let k = 0; k < N; k++) { const sl = slots[k]; sl.want = 0; if (sl.idx >= 0) { let kept = false; for (let a = 0; a < want; a++) if (near[a] === sl.idx) { sl.want = 1; near[a] = -2; kept = true; break; } if (!kept && sl.cur <= 0.01) sl.idx = -1; } }   // keep the slots whose lamp is still near
      for (let a = 0; a < want; a++) { if (near[a] < 0) continue;   // a lamp with no slot: a free (faded-out) slot, shadow slots first
        for (let k = 0; k < N; k++) { const sl = slots[k]; if (sl.idx < 0 && sl.want === 0) {
          const h = headPos(lamps[near[a]]), T3 = S.tmpV || (S.tmpV = new c.THREE.Vector3()); T3.set(h[0], h[2] - 0.2 * UPM, -h[1]); S.grp.localToWorld(T3); S.lights[k].position.copy(T3); S.lights[k].updateMatrixWorld();
          sl.idx = near[a]; sl.want = 1; if (sl.sh) S.lights[k].shadow.needsUpdate = true; break; } } }
    }
    const e = Math.min(1, dt / 0.3); let shDue = S.plan && S.plan.ev > 0 && (S.frame % S.plan.ev) === 0, act = S.plan ? S.plan.active : 0, shOn = 0;
    for (let k = 0; k < N; k++) {
      const sl = slots[k], L = S.lights[k], tgt = (mode === 'space' ? 0 : sl.want) * S.on; sl.cur += (tgt - sl.cur) * e; if (Math.abs(tgt - sl.cur) < 0.003) sl.cur = tgt;
      L.intensity = sl.I0 * sl.cur;
      if (sl.sh) { if (sl.idx >= 0 && sl.cur > 0.02 && shOn < act) { shOn++; if (shDue) L.shadow.needsUpdate = true; } }
    }
    S.shN = shOn;
  }

  // ── the USE bubble (same look as the Bird Temple's F bubble) ─────────────────────────────────────────────
  function hud() {
    if (S.hud) return S.hud; const d = G.document; if (!d) return null;
    const st = d.createElement('style'); st.textContent = '#dm-sw{position:absolute;left:22px;bottom:calc(196px + var(--safe-bot,0px));min-width:84px;height:84px;padding:0 10px;border:1.5px solid rgba(255,214,150,.85);border-radius:42px;background:radial-gradient(circle at 32% 26%,rgba(255,230,180,.5),rgba(120,80,30,.25) 60%,rgba(20,12,6,.6));color:#fff3dc;font:800 .6rem var(--font-hud,ui-monospace,monospace);letter-spacing:.12em;z-index:33;opacity:0;transform:scale(.4);pointer-events:none;transition:opacity .18s,transform .28s cubic-bezier(.2,1.5,.4,1);touch-action:none;-webkit-tap-highlight-color:transparent;box-shadow:0 0 18px rgba(255,190,110,.45)}#dm-sw.on{opacity:1;transform:scale(1);pointer-events:auto}#dm-sw b{display:block;font-size:1.5rem;line-height:1}#dm-sw span{display:block;margin-top:2px;white-space:nowrap}@media (orientation:portrait){#dm-sw{bottom:calc(300px + var(--safe-bot,0px))}}';
    d.head.appendChild(st);
    const b = d.createElement('button'); b.id = 'dm-sw'; b.type = 'button'; b.setAttribute('aria-label', 'Room light switch'); b.innerHTML = '<b>F</b><span id="dm-sw-t">LIGHTS</span>';
    let t0 = 0, hold = 0; const down = e => { e.preventDefault(); e.stopPropagation(); t0 = performance.now(); clearTimeout(hold); hold = setTimeout(() => { hold = 0; use(true); }, 650); };
    const up = e => { e.preventDefault(); e.stopPropagation(); if (hold) { clearTimeout(hold); hold = 0; use(false); } };
    b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', () => { clearTimeout(hold); hold = 0; });
    (d.getElementById('ship-jump-btn') && d.getElementById('ship-jump-btn').parentNode || d.body).appendChild(b);
    G.addEventListener('keydown', e => { if (S.sw < 0 || e.code !== 'KeyF' || e.repeat || G.DM_TERMINAL_OPEN) return; const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return; e.preventDefault(); use(false); }, true);
    S.hud = b; return b;
  }
  function hideHud() { if (S.hud) S.hud.classList.remove('on'); S.sw = -1; }
  const LBL = { on: 'ON', off: 'OFF', auto: 'AUTO' };
  function use(auto) {
    const R = ST(), i = S.sw; if (!R || i < 0) return;
    if (auto) R.setMode(i, 'auto'); else R.toggle(i, S.day);
    persist(); S.swHold = performance.now();
    try { if (typeof G.toast === 'function') G.toast((R.lit(i, R.mode(i), S.day) ? '💡 ' : '🌙 ') + R.ROOMS[i].label + ' lights: ' + (R.mode(i) === 'auto' ? 'auto (' + (R.lit(i, 'auto', S.day) ? 'on' : 'off') + ')' : LBL[R.mode(i)].toLowerCase()), 1700); } catch (e) { }
    S.dirty = true;
  }
  // tap the post itself: project the nearest switches to the screen (no raycast, no allocation)
  const _v = { x: 0, y: 0, z: 0 };
  function onTap(e) {
    if (!S.built || !S.sg || !S.sg.visible) return;
    const c = S.F && S.F.ctx, PW = c && c.PW && c.PW(), cam = PW && PW.camera, R = ST(); if (!cam || !R || !S.tapV) return;
    const d = S.tap; if (!d || performance.now() - d.t > 450 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    const W = G.innerWidth, H = G.innerHeight; let best = -1, bd = 1e9;
    for (let i = 0; i < R.N; i++) {
      const r = R.ROOMS[i]; if (Math.hypot(S.lx - r.sw[0], S.ly - r.sw[1]) > 16 || Math.abs(S.feet - r.sw[2]) > 5) continue;
      S.tapV.set(r.sw[0], r.sw[2] + 1.2 * UPM, -r.sw[1]); S.grp.localToWorld(S.tapV); S.tapV.project(cam);
      if (S.tapV.z > 1) continue; const sx = (S.tapV.x * 0.5 + 0.5) * W, sy = (-S.tapV.y * 0.5 + 0.5) * H, dd = Math.hypot(sx - e.clientX, sy - e.clientY);
      if (dd < 56 && dd < bd) { bd = dd; best = i; }
    }
    if (best >= 0) { S.sw = best; use(false); }
  }
  function bindTap() {
    if (S.tapBound || !G.addEventListener) return; S.tapBound = true;
    G.addEventListener('pointerdown', e => { S.tap = { x: e.clientX, y: e.clientY, t: performance.now() }; }, true);
    G.addEventListener('pointerup', e => { try { onTap(e); } catch (er) { } }, true);
  }

  // ── lifecycle (called by dm-facilities.js) ──────────────────────────────────────────────────────────────
  const API = {
    attach(F, rec, px, pz, y0, th) {
      if (S.built) destroy();
      S.F = F; S.rec = rec; S.px = px; S.pz = pz; S.y0 = y0; S.th = th; S.ct = Math.cos(th); S.st = Math.sin(th); S.pending = false; S.on = 0;
      if (!S.jp) S.jp = fetch('assets/ariel-home/ariel-home-lamps.json?v=' + F.ver + '.298').then(r => { if (!r.ok) throw new Error('lamps ' + r.status); return r.json(); }).then(j => { S.J = j; }, e => { S.jp = null; console.warn('[lamps] data', e); });
    },
    detach() { destroy(); S.rec = null; S.F = null; S.hud && S.hud.parentNode && S.hud.parentNode.removeChild(S.hud); S.hud = null; },
    // per mansion per frame (after the interior's own tick). f = her / the flyer's world position, mode = 'fly' | 'walk' ...
    tick(rec, d2, now, dt, f, mode) {
      const F = S.F, R = ST(); if (rec !== S.rec || !F || !R) return;
      const c = F.ctx, day = c.skyDay ? c.skyDay() : 1; S.day = day;
      if (d2 < 500 * 500 && R.step(dt, day) || S.dirty) { S.dirty = false; const LK = G.DMMansionLook; if (LK && LK.setRoomLevels) LK.setRoomLevels(R.S.lvl, R.N); }
      if (!S.built) {
        if (d2 > DRAW_D2 || !rec.warmed || !S.J || S.building) return;
        S.building = true; try { if (!build(F, rec)) { S.J = null; S.jp = null; } } catch (e) { console.warn('[lamps] build', e); S.J = null; S.jp = null; } S.building = false; if (!S.built) return;
        S.tapV = new c.THREE.Vector3(); bindTap();
      }
      // dusk fade, eased (~1.2 s) so a sunset never pops
      const sy = c.skySunY ? c.skySunY() : null, tgt = (sy != null && R.duskStep) ? R.duskStep(S.dk || (S.dk = R.duskState()), sy, S.duskStart) : R.lampLevel(day), k = Math.min(1, dt / 0.9);   // (dusk 2) by sun ELEVATION: fade-in from ~14 deg, full at 0 deg, hysteresis (ui/dm-mansion-rooms.js)
      S.sunY = sy; S.on += (tgt - S.on) * k; if (Math.abs(tgt - S.on) < 0.002) S.on = tgt;
      S.U.on.value = S.on; try { if (G.DMLight && G.DMLight.on) G.DMLight.setLampLevel(S.on); } catch (e) { }   try { if (G.DMVLight && G.DMVLight.on) { G.DMVLight.setLevel('lamps', S.on); G.DMVLight.setLevel('leds', S.on); } } catch (e) { }   // (ui/dm-vlight.js) fog shafts follow the same dusk fade   // (ui/dm-light.js) the radiance cache lights its probes from the lamps at the same eased level
      const near = d2 < DRAW_D2;
      S.grp.visible = near && (S.on > 0.004 || d2 < SW_D2);   // by day only the switches (near) stay
      // lamps (poles + heads + glow + pools) hide by day; the switch group is its own child
      for (const ch of S.grp.children) if (ch !== S.sg) ch.visible = S.on > 0.004;
      S.sg.visible = d2 < SW_D2;
      // her place in the mansion frame
      const dx = f.x - S.px, dz = f.z - S.pz; S.lx = dx * S.ct - dz * S.st; S.ly = -(dx * S.st + dz * S.ct); S.feet = f.y - 3 - S.y0;
      let best = -1, bd = 1e9;
      if (S.sg.visible && mode !== 'fly') for (let i = 0; i < R.N; i++) { const r = R.ROOMS[i]; if (Math.abs(S.feet - r.sw[2]) > 4.5) continue; const d = Math.hypot(S.lx - r.sw[0], S.ly - r.sw[1]); if (d < REACH && d < bd) { bd = d; best = i; } }
      S.near2 = S.sg.visible;
      if (best !== S.sw) { S.sw = best; const h = hud(); if (h) h.classList.toggle('on', best >= 0); S.lastLbl = ''; }
      if (S.sw >= 0 && S.hud) { const i = S.sw, lb = R.ROOMS[i].label.toUpperCase() + ': ' + (R.lit(i, R.mode(i), day) ? 'LIGHTS OFF' : 'LIGHTS ON') + (R.mode(i) === 'auto' ? '' : ' · hold = AUTO'); if (lb !== S.lastLbl) { S.lastLbl = lb; const t = S.hud.querySelector('#dm-sw-t'); if (t) t.textContent = lb; } }
      // plate colours follow the room state (instance colour, written only when it changed)
      if (S.plates && S.sg.visible && now - S.last > 120) { S.last = now; const Cc = S.plateC || (S.plateC = new c.THREE.Color()); let ch = false; for (let i = 0; i < R.N; i++) { const lv = R.S.lvl[i], key = Math.round(lv * 20) + (R.mode(i) === 'auto' ? 0 : 100); if (S.pk === undefined) S.pk = new Int16Array(R.N).fill(-1); if (S.pk[i] === key) continue; S.pk[i] = key; Cc.setRGB(0.12 + 0.88 * lv, 0.1 + 0.62 * lv, 0.08 + 0.34 * lv); if (R.mode(i) !== 'auto') Cc.b += 0.25; S.plates.setColorAt(i, Cc); ch = true; } if (ch && S.plates.instanceColor) S.plates.instanceColor.needsUpdate = true; }
      // real lamp lights (lampPlan): nearest lamps to her, re-aimed 3x a second with hysteresis (a slot keeps its lamp until that lamp leaves the nearest set, fades out, then moves)
      if (S.slots.length) lampLights(c, now, dt, mode, d2 < 150 * 150);
    },
    get() { return ST() ? ST().get() : null; }, set(d) { if (ST()) { ST().set(d); persist(); S.dirty = true; } },
    status() { return { built: S.built, on: +S.on.toFixed(3), sunY: S.sunY == null ? null : +S.sunY.toFixed(3), lamps: S.lamps ? S.lamps.length : 0, leds: S.leds ? S.leds.length : 0, poolVerts: S.pool, near: S.sw, lights: S.lights.length, casting: S.casting, shadowsActive: S.shN, plan: S.plan, slots: S.slots.map(x => [x.idx, +x.cur.toFixed(2)]) }; },
    _pure: { lampShadowNode, lampPlan, pickNearest, LAMP_LEVELS, headPos, pools, poleArrays, headArrays, switchArrays, plateArrays, ledArrays, withYaw, UPM, POLE_H, POOL_R, LED_POOL_R },
    _build: build,   // tools/tests/home-leds.js runs the real build against stubbed three + DMCollide
  };
  G.DMLamps = API;
})();
