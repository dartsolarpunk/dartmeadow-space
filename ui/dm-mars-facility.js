// DM Mars facility (Track 5 CE-10 / t1590) — the VALLES RIM ANNEX: a walkable hangar + habitat wing on the cliff top behind the kept Valles Rim building
// (mars-valles, ui/dm-facilities.js buildFacility 'mars').
//
// What it is (build: tools/mars-facility/mf_build.py, Blender 4.2 headless; assets/mars-facility/):
//   • HANGAR 28 x 36 m, 13 m clear, with a 20 x 10.5 m door whose leaf slides east into a pocket frame: the FUNCTION button (F / tap) opens and closes it;
//     a parked six-wheel rover, cargo containers, fuel tanks, a gantry crane, high-bay lights, a landing pad marking;
//   • HABITAT 28 x 36 m: airlock, spine corridor, control room (window onto the apron), two crew cabins, med bay, mess, workshop (vehicle door into the
//     hangar), power room with a glowing core; a personnel door mess <-> hangar;
//   • a floor-level apron across the front (foundation skirt below it), a roof kit (vents, antenna, solar strips).
// Budget rules:
//   • one GLB (ext 6.5k + int 11k tris, three 1K JPEG maps desktop / 512 phones), streamed through the facilities' serial heavy-load gate (F.heavy) once the
//     site is warmed, freed on detach. The interior meshes are only drawn within INT_D of the annex.
//   • NO scene lights are added: the interior materials get a private light list (ambient + hemisphere + the glasses flashlight + the world's 2-light pool,
//     DMNatLights, re-aimed at the two fixtures nearest to her) and the light baked into vertex colour as emissive fill. The sun is not in the interior list,
//     so it cannot leak through the roof. The exterior is lit by the world like every other facility mesh.
//   • walls / props / the door leaf are DMCollide boxes (groups 'marsfac', 'marsfacdoor'); the roofs + apron are F.solids rects (props, atmosphere and the
//     board see a solid building); her own floor query (DMMansionInt.ground) gets the annex floor while she is inside, below the roof line.
// Off switch: ?mf=0.
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const OFF = !!(G.location && /[?&]mf=0\b/.test(G.location.search || ''));
  const MFV = 'mf1', DOOR_REACH = 16, OPEN_RATE = 0.22, INT_D = 320, INT_DM = 220;
  const S = {
    F: null, rec: null, D: null, state: 0, gen: 0, root: null, failed: 0, px: 0, pz: 0, y0: 0, ct: 1, st: 0, th: 0,
    feet: -1e9, t: 0, open: 0, want: 0, leaf: null, doorId: -1, ncol: 0, solids: 0, hud: null, hudOn: false, lastLbl: '', nat: [], natT: 0,
    fill: null, mats: [], intMeshes: [], intOn: true, ovrMine: false, ramp: null, rampDrop: 0, lights: null,
  };
  let dataP = null;
  const _l = { x: 0, z: 0 };
  function toLocal(wx, wz) { const dx = wx - S.px, dz = wz - S.pz; _l.x = dx * S.ct - dz * S.st; _l.z = dx * S.st + dz * S.ct; }
  function wX(lx, lz) { return S.px + lx * S.ct + lz * S.st; }
  function wZ(lx, lz) { return S.pz - lx * S.st + lz * S.ct; }
  const inR = (r, x, z, m) => x >= r[0] - m && x <= r[2] + m && z >= r[1] - m && z <= r[3] + m;

  // ── her floor (only inside DMMansionInt.ground(), i.e. her own query) ───────────────────────────────────────────────
  function roofAt(x, z) { const R = S.D.roofs; let h = -1e9; for (let i = 0; i < R.length; i++) if (inR(R[i], x, z, 0) && R[i][4] > h) h = R[i][4]; return h; }
  // local floor height (relative to the annex floor) for feet `feet` (relative), or NaN
  function floorAt(x, z, feet) {
    const D = S.D; if (!inR(D.foot, x, z, 0)) return rampAt(x, z);
    const rf = roofAt(x, z);
    if (rf > -1e8 && feet > rf - 1.2) return rf;   // up on a roof
    return 0;
  }
  // the ramp down from the apron's front edge (only when the ground there sits more than 1 u below the floor)
  function rampAt(x, z) {
    if (!S.ramp) return NaN; const a = S.D.apron, L = S.ramp.len, z1 = a[3];
    if (x < a[0] || x > a[2] || z < z1 || z > z1 + L) return NaN;
    return -S.rampDrop * (z - z1) / L;
  }
  function ovr(x, z) {
    const MI = G.DMMansionInt; if (!S.D || !S.rec || !(MI && MI.inGround && MI.inGround())) return NaN;
    if (performance.now() - S.t > 250) return NaN;   // no fresh feet (she is not walking here)
    toLocal(x, z); const h = floorAt(_l.x, _l.z, S.feet - S.y0);
    if (h !== h) return NaN;
    if (S.ramp && !inR(S.D.foot, _l.x, _l.z, 0)) { const g = S.F.baseH ? S.F.baseH(x, z) : -1e9; const v = S.y0 + h; return g > v ? g : v; }
    return S.y0 + h;
  }
  function walk(pos) { if (!S.D || !S.rec) return false; S.feet = pos.y - 3.0; S.t = performance.now(); return false; }
  function isInside(wx, wz, feetW) { if (!S.D) return false; toLocal(wx, wz); return inR(S.D.inner[0], _l.x, _l.z, 0) && feetW - S.y0 < roofAt(_l.x, _l.z) - 1.2; }

  // ── colliders + solids ──────────────────────────────────────────────────────────────────────────────────
  function addCols() {
    const C = G.DMCollide; if (!C || !C.addBox) return; S.ncol = 0;
    for (const b of S.D.cols) { try { if (C.addBox('marsfac', wX(b[0], b[2]), S.y0 + b[1], wZ(b[0], b[2]), b[3], b[4], b[5], -S.th, b[6] || 'metal') >= 0) S.ncol++; } catch (e) { } }
    const d = S.D.door.col; try { S.doorId = C.addBox('marsfacdoor', wX(d[0], d[2]), S.y0 + d[1], wZ(d[0], d[2]), d[3], d[4], d[5], -S.th, 'metal'); } catch (e) { S.doorId = -1; }
  }
  function moveDoorCol() {
    const C = G.DMCollide; if (!C || !C.move || S.doorId < 0) return; const d = S.D.door.col, e = S.open * S.open * (3 - 2 * S.open), dx = e * S.D.door.travel;
    try { C.move(S.doorId, wX(d[0] + dx, d[2]), S.y0 + d[1], wZ(d[0] + dx, d[2]), -S.th); } catch (e2) { }
  }
  function clearCols() { const C = G.DMCollide; if (!C || !C.clearGroup) return; try { C.clearGroup('marsfac'); C.clearGroup('marsfacdoor'); } catch (e) { } S.doorId = -1; S.ncol = 0; }
  function addSolids() {
    const F = S.F; if (!F.addSolids) return; const n0 = F.solids.length, D = S.D, rel = S.y0 - S.rec.y;
    const L = [{ rect: D.foot, y: rel }].concat(D.roofs.map(r => ({ rect: r.slice(0, 4), y: rel + r[4] })));
    F.addSolids(L, S.px, S.pz, S.th, S.rec.y);
    S.solids = F.solids.length - n0; for (let i = n0; i < F.solids.length; i++) F.solids[i]._mf = 1;
  }
  function removeSolids() { const F = S.F; if (!F || !F.solids) return; for (let i = F.solids.length - 1; i >= 0; i--) if (F.solids[i] && F.solids[i]._mf) F.solids.splice(i, 1); S.solids = 0; }

  // seat the annex: the floor sits on the highest ground in its footprint (sampled on a 4 u grid), the skirt hides the rest
  function seat() {
    const F = S.F, H = F.baseH || (() => S.rec.y), f = S.D.foot; let hi = -1e9, front = -1e9;
    for (let x = f[0]; x <= f[2]; x += 4) for (let z = f[1]; z <= f[3]; z += 4) { const h = H(wX(x, z), wZ(x, z)); if (h > hi) hi = h; }
    const a = S.D.apron; for (let x = a[0]; x <= a[2]; x += 4) { const h = H(wX(x, a[3] + 1), wZ(x, a[3] + 1)); if (h > front) front = h; }
    let y = (hi > -1e8 ? hi : S.rec.y) + 0.25; if (!(y === y) || !isFinite(y)) y = S.rec.y;
    S.y0 = y; S.rampDrop = Math.max(0, y - (front > -1e8 ? front : y));
    return y;
  }
  function buildRamp(THREE, mat) {
    if (S.rampDrop < 1.0) return null;
    const a = S.D.apron, L = Math.min(60, Math.max(8, S.rampDrop / 0.42)), x0 = a[0], x1 = a[2], z1 = a[3], d = S.rampDrop + 0.6;
    const P = [x0, 0, z1, x1, 0, z1, x1, -d, z1 + L, x0, -d, z1 + L, x0, -d - 2, z1, x1, -d - 2, z1];
    const I = [0, 3, 2, 0, 2, 1, 0, 4, 3, 1, 2, 5];
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    const uv = []; for (let i = 0; i < P.length; i += 3) uv.push(P[i] / 7.12, P[i + 2] / 7.12); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(I); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.name = 'mf_ramp'; return { mesh: m, len: L };
  }

  // ── materials ───────────────────────────────────────────────────────────────────────────────────────────
  function lightList(c) {
    const PW = c.PW && c.PW(), sc = PW && PW.scene; if (!sc) return null; const a = [];
    sc.traverse(o => { if (o.isAmbientLight || o.isHemisphereLight || (o.isSpotLight && o.userData && o.userData.dmFlash) || (o.isPointLight && o.name === 'JOTS_NatPool')) a.push(o); });
    return a.length ? a : null;
  }
  function buildMats(root, c) {
    const THREE = c.THREE, T = THREE.TSL, node = !!(THREE.MeshStandardNodeMaterial && T && T.uniform && T.diffuseColor);
    if (!S.fill) S.fill = node ? T.uniform(0.7) : { value: 0.7 };
    const L = lightList(c), lights = node && L && T.lights ? T.lights(L) : null; S.lights = L;
    const made = {}, emit = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.86, 0.66).multiplyScalar(2.0) }); emit.name = 'mf_emit'; emit.userData.dmMarsFac = true; S.mats = [emit];
    S.intMeshes = [];
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const src = o.material, name = src.name || '', interior = /^mf_int/.test(o.name) || (o.parent && /^mf_int/.test(o.parent.name));
      if (interior) S.intMeshes.push(o);
      if (name === 'mf_emit') { o.material = emit; o.castShadow = false; return; }
      if (name === 'mf_glass') { src.transparent = true; src.opacity = 0.3; src.depthWrite = false; src.metalness = 0; src.roughness = 0.08; o.castShadow = false; o.renderOrder = 2; return; }
      if (!interior) { src.metalness = 0; src.roughness = Math.max(0.5, src.roughness); src.needsUpdate = true; return; }   // exterior: the world's lights (sun) as usual
      const k = name;
      if (!made[k]) {
        const m = node ? new THREE.MeshStandardNodeMaterial() : new THREE.MeshStandardMaterial();
        m.name = name + '_int'; m.vertexColors = true; m.map = src.map || null; m.color.copy(src.color); m.roughness = src.roughness; m.metalness = 0;
        if (node) { m.emissiveNode = T.diffuseColor.rgb.mul(S.fill); if (lights) m.lightsNode = lights; } else m.emissive = new THREE.Color(0.3, 0.28, 0.25);
        m.userData.dmMarsFac = true; made[k] = m; S.mats.push(m);
      }
      o.material = made[k]; o.castShadow = false;
    });
  }
  function disposeObj(o) {
    const mats = new Set(), tex = new Set();
    o.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) mats.add(n.material); });
    S.mats.forEach(m => mats.add(m));
    mats.forEach(m => { for (const k in m) { const v = m[k]; if (v && v.isTexture) tex.add(v); } m.dispose(); });
    tex.forEach(t => t.dispose());
  }

  // ── load / unload ──────────────────────────────────────────────────────────────────────────────────────
  function ensureData(F) {
    if (!dataP) dataP = fetch('assets/mars-facility/mf-annex.json?v=' + F.ver + MFV).then(r => { if (!r.ok) throw new Error('annex json ' + r.status); return r.json(); }).then(j => { S.D = j; }, e => { dataP = null; console.warn('[mars-facility] data', e); });
    return dataP;
  }
  function load() {
    const F = S.F; if (S.state) return; S.state = 1; const g = ++S.gen;
    const run = fin => {
      fin = fin || (() => { });
      const c = F.ctx, small = c.isMobile() && !(F.tabletHi && F.tabletHi());
      Promise.all([c.loadGLB('assets/mars-facility/mf-annex' + (small ? '-512' : '') + '.glb?v=' + F.ver + MFV), ensureData(F)]).then(([gl]) => {
        if (g !== S.gen || !S.rec || !S.rec.group || !S.D) { disposeObj(gl.scene); fin(); if (g === S.gen) S.state = 0; return; }
        const THREE = c.THREE, root = gl.scene; root.name = 'JOTS_MarsAnnex';
        seat();
        const mob = !!c.isMobile();
        root.traverse(n => { if (n.isMesh) { n.castShadow = !mob; n.receiveShadow = true; } });
        buildMats(root, c);
        S.leaf = root.getObjectByName('mf_door_pivot') || root.getObjectByName('mf_hangar_door');
        let extMat = null; root.traverse(n => { if (!extMat && n.isMesh && n.material && n.material.name === 'mf_concrete' && !S.intMeshes.includes(n)) extMat = n.material; });
        const rp = buildRamp(THREE, extMat || new THREE.MeshStandardMaterial({ color: 0x9a8a7a, roughness: 0.9 }));
        if (rp) { S.ramp = rp; root.add(rp.mesh); }
        root.position.set(0, S.y0 - S.rec.y, 0);   // rec.group is at (px, rec.y, pz), rotated th: the annex frame is the facility's local frame
        S.rec.group.add(root); S.root = root; root.updateMatrixWorld(true);
        addCols(); addSolids();
        if (F.ovr === null) { F.ovr = ovr; S.ovrMine = true; }
        c.mapTag(root);   // tag FIRST, compile SECOND (#239)
        const PW = c.PW(), done = () => { if (g === S.gen) S.state = 2; fin(); };
        try { if (PW && PW.renderer && PW.renderer.compileAsync && PW.camera) PW.renderer.compileAsync(root, PW.camera, PW.scene).then(done, done); else done(); } catch (e) { done(); }
      }).catch(e => { fin(); if (g !== S.gen) return; S.failed = performance.now(); S.state = 0; console.warn('[mars-facility] load failed', e); });
    };
    if (F.heavy) F.heavy('marsAnnex', () => new Promise(ok => { if (g !== S.gen || !S.rec) { ok(); return; } run(ok); }), () => { if (S.state === 1 && S.gen === g) S.state = 0; });
    else run(null);
  }
  function unload() {
    S.gen++; S.state = 0; setHud(false); releaseLights(); clearCols(); removeSolids();
    if (S.ovrMine && S.F && S.F.ovr === ovr) S.F.ovr = null; S.ovrMine = false;
    if (S.root) { if (S.root.parent) S.root.parent.remove(S.root); disposeObj(S.root); S.root = null; }
    S.mats = []; S.intMeshes = []; S.leaf = null; S.ramp = null; S.open = 0; S.want = 0; S.intOn = true;
  }

  // ── lights: the two fixtures nearest to her while she is inside ─────────────────────────────────────────────
  function releaseLights() { const N = G.DMNatLights; if (N) for (const k of S.nat) { try { N.release(k); } catch (e) { } } S.nat.length = 0; }
  const _p = { x: 0, y: 0, z: 0 };
  function aimLights(now, f, inside) {
    const N = G.DMNatLights; if (!N || !inside || S.state !== 2) { if (S.nat.length) releaseLights(); return; }
    if (now - S.natT < 330) return; S.natT = now;
    toLocal(f.x, f.z); const Lt = S.D.lights, fy = f.y - S.y0; let b0 = -1, b1 = -1, d0 = 1e18, d1 = 1e18;
    for (let i = 0; i < Lt.length; i++) { const l = Lt[i], d = (l[0] - _l.x) * (l[0] - _l.x) + (l[2] - _l.z) * (l[2] - _l.z) + (l[1] - fy) * (l[1] - fy); if (d < d0) { d1 = d0; b1 = b0; d0 = d; b0 = i; } else if (d < d1) { d1 = d; b1 = i; } }
    const THREE = S.F.ctx.THREE, best = [b0, b1];
    for (let s = 0; s < 2; s++) {
      const i = best[s]; if (i < 0) continue; const l = Lt[i]; _p.x = wX(l[0], l[2]); _p.z = wZ(l[0], l[2]); _p.y = S.y0 + l[1];
      const I = 2.2 * l[4], r = l[3];
      if (S.nat[s] === undefined) S.nat[s] = N.request(new THREE.Vector3(_p.x, _p.y, _p.z), 0xffd9a0, I, r); else N.set(S.nat[s], _p, I);
    }
  }

  // ── the FUNCTION button (hangar door) ───────────────────────────────────────────────────────────────────────
  function hud() {
    if (S.hud) return S.hud; const d = G.document; if (!d || !d.createElement) return null;
    if (!d.getElementById('dm-mfdoor-css')) { const st = d.createElement('style'); st.id = 'dm-mfdoor-css'; st.textContent = '#dm-mfdoor{position:absolute;left:22px;bottom:calc(292px + var(--safe-bot,0px));min-width:84px;height:84px;padding:0 12px;border:1.5px solid rgba(255,190,140,.85);border-radius:42px;background:radial-gradient(circle at 32% 26%,rgba(255,220,190,.45),rgba(120,60,30,.28) 60%,rgba(22,10,6,.62));color:#fff1e6;font:800 .6rem var(--font-hud,ui-monospace,monospace);letter-spacing:.12em;z-index:33;opacity:0;transform:scale(.4);pointer-events:none;transition:opacity .18s,transform .28s cubic-bezier(.2,1.5,.4,1);touch-action:none;-webkit-tap-highlight-color:transparent;box-shadow:0 0 18px rgba(255,160,110,.45)}#dm-mfdoor.on{opacity:1;transform:scale(1);pointer-events:auto}#dm-mfdoor b{display:block;font-size:1.5rem;line-height:1}#dm-mfdoor span{display:block;margin-top:2px;white-space:nowrap}@media (orientation:portrait){#dm-mfdoor{bottom:calc(396px + var(--safe-bot,0px))}}'; d.head.appendChild(st); }
    const b = d.createElement('button'); b.id = 'dm-mfdoor'; b.type = 'button'; b.setAttribute('aria-label', 'Hangar door'); b.innerHTML = '<b>F</b><span id="dm-mfdoor-t">FUNCTION</span>';
    b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('pointerup', e => { e.preventDefault(); e.stopPropagation(); use(); });
    (d.getElementById('ship-jump-btn') && d.getElementById('ship-jump-btn').parentNode || d.body).appendChild(b);
    if (!S.keyOn) { S.keyOn = true; G.addEventListener('keydown', e => { if (!S.hudOn || e.code !== 'KeyF' || e.repeat || G.DM_TERMINAL_OPEN) return; const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return; e.preventDefault(); use(); }, true); }
    S.hud = b; return b;
  }
  function setHud(on) { if (on === S.hudOn) return; S.hudOn = on; const h = on ? hud() : S.hud; if (h) h.classList.toggle('on', on); S.lastLbl = ''; }
  function use() {
    if (S.state !== 2) return; S.want = S.want ? 0 : 1;
    try { if (typeof G.toast === 'function') G.toast(S.want ? '🚀 Hangar door opening' : '🚀 Hangar door closing', 1500); } catch (e) { }
    try { if (G.dmAction) G.dmAction('marsdoor', S.want ? 'open' : 'close'); } catch (e) { }
  }
  function nearDoor(lx, lz, feet) { const r = S.D.door.rect; return inR(r, lx, lz, DOOR_REACH) && feet > -3 && feet < 8; }

  const API = {
    // ui/dm-facilities.js place(), Mars (variant 'mars') only, after the kept building is built and placed
    attach(F, rec) {
      if (S.rec) API.detach();
      S.F = F; S.rec = rec; S.px = rec.x; S.pz = rec.z; S.th = rec.th; S.ct = Math.cos(rec.th); S.st = Math.sin(rec.th); S.y0 = rec.y; S.failed = 0; S.open = 0; S.want = 0;
      if (OFF) return API; ensureData(F); return API;
    },
    // F.tick, non-mansion branch: load once the site is warmed and she is within the facility cull distance; door, interior visibility, lights, button
    tick(rec, dd, now, dt, f, mode) {
      if (OFF || rec !== S.rec) return;
      if (S.state === 0 && S.D && rec.ready && (!S.failed || now - S.failed > 30000) && dd < 2500 * 2500) load();
      if (S.state !== 2 || !f) return;
      const mob = !!(S.F.ctx.isMobile && S.F.ctx.isMobile()), ID = mob ? INT_DM : INT_D;
      toLocal(f.x, f.z); const lx = _l.x, lz = _l.z, cx = S.D.foot, ddx = Math.max(cx[0] - lx, 0, lx - cx[2]), ddz = Math.max(cx[1] - lz, 0, lz - cx[3]);
      const near = ddx * ddx + ddz * ddz < ID * ID; if (near !== S.intOn) { S.intOn = near; for (const m of S.intMeshes) m.visible = near; }
      const tgt = S.want, dO = tgt - S.open;
      if (dO !== 0) { const k = OPEN_RATE * Math.min(dt, 0.1); S.open = Math.abs(dO) <= k ? tgt : S.open + Math.sign(dO) * k; const e = S.open * S.open * (3 - 2 * S.open); if (S.leaf) S.leaf.position.x = e * S.D.door.travel; moveDoorCol(); }
      const feet = f.y - 3 - S.y0, inside = isInside(f.x, f.z, f.y - 3);
      aimLights(now, f, inside);
      const hb = mode !== 'fly' && nearDoor(lx, lz, feet); setHud(hb);
      if (hb && S.hud) { const lb = S.want ? 'CLOSE HANGAR' : 'OPEN HANGAR'; if (lb !== S.lastLbl) { S.lastLbl = lb; const t = S.hud.querySelector('#dm-mfdoor-t'); if (t) t.textContent = lb; } }
    },
    detach() { unload(); if (S.hud && S.hud.parentNode) S.hud.parentNode.removeChild(S.hud); S.hud = null; S.hudOn = false; S.rec = null; },
    walk, ovr, use,
    status() { return { state: S.state, open: +S.open.toFixed(3), want: S.want, y0: +S.y0.toFixed(2), ramp: S.ramp ? +S.rampDrop.toFixed(2) : 0, cols: S.ncol, solids: S.solids, lights: S.nat.length, interior: S.intOn, hud: S.hudOn }; },
    _test: { S, floorAt, roofAt, isInside, nearDoor, setData(j) { S.D = j; }, setFrame(px, pz, y0, th) { S.px = px; S.pz = pz; S.y0 = y0; S.th = th; S.ct = Math.cos(th); S.st = Math.sin(th); }, addCols, addSolids, seat },
  };
  G.DMMarsFac = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
