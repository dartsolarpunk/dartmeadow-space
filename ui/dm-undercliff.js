// DM Undercliff (t1583u / Track 5 CE-10) — the level carved into the Solenne mansion cliff, behind the lower pool deck.
//
// What it is (layout and build: tools/ariel-home/undercliff/, Blender 4.2 headless p2_build.py + uc_package.py + uc_nav.py):
//   • a full-width CARGO BAY opening across the back of the lower pool deck (cut into the mansion GLB: uc_bay_hall under Mansion_LOD0/LOD1);
//   • the lower level behind it: living room, master kitchen + dining, workshop / garage, office, game room, guest rooms 1-4, spine + guest corridors;
//   • a hangar door at the end of the guest corridor and a 4-flight stair 12 m DOWN to a deep, tall HANGAR (40 x 30 x 18 m) where the DM-7 Meadowlark VTOL is parked;
//   • a vehicle HATCH on the plateau behind the top-level workshop (18 x 22 m, two leaves): the FUNCTION button (F / tap) opens and closes it, and a
//     scaffold staircase (7 flights) runs down the shaft wall to the hangar floor.
//
// Budget rules (same as ui/dm-mansion-interior.js, which this file plugs into):
//   • the undercliff GLB (3 zone meshes + the VTOL LODs, light baked into vertex colour) streams in through the mansion's serial heavy-load gate (F.heavy) only
//     while she is near, and is fully disposed when she leaves. It carries NO textures of its own: its five surface materials re-use the mansion's own texture
//     sets (concrete / wood / slate / dark / rock), so it adds no texture memory. The VTOL brings its own 2K (desktop) / 1K (phones) set.
//   • NO lights are added to the scene (a changed light set recompiles every world material). The materials get a private light list: the world's ambient +
//     hemisphere lights, the glasses flashlight and the world's existing 2-light pool (DMNatLights), re-aimed at the two fixtures nearest to her. The sun is not
//     in the list, so daylight cannot leak through 20 m of rock; the rooms read lamp-lit from the bake (emissive = albedo x baked light x fill).
//   • walking: one call per frame from DMMansionInt.walk (this module answers first where it owns the space), allocation-free; the floor comes from the nav
//     patches (assets/ariel-home/ariel-home-undercliff-nav.json), walls / doorways / furniture / railings / the VTOL hull from its occupancy grid.
// Off switch: ?uc=0.
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const OFF = !!(G.location && /[?&]uc=0\b/.test(G.location.search || ''));
  const STEP = 1.5, BODY = 3.2, RAD = 0.7, WALL_UP = 4.5, TELE = 24, MAXSUB = 48, KNEE = 0.8;
  const LOAD_D = 300, DROP_D = 420, LOAD_DM = 230, DROP_DM = 320;   // from the mansion root; the hangar's far corner is ~170 u away
  const HATCH_REACH = 9, OPEN_RATE = 0.28, OPEN_ANG = 1.62;        // u from the rim; full travel in ~3.6 s; leaves stop just past vertical (93 deg)
  const UCV = 'uc1';                                               // asset key (ariel-home.glb carries the bay + hatch cut since this version)
  const MATMAP = { uc_concrete: 'ah_concrete', uc_wood: 'ah_wood', uc_slate: 'ah_slate', uc_dark: 'ah_dark', uc_rock: 'ah_rock' };
  const S = {
    F: null, rec: null, state: 0 /* 0 idle · 1 loading · 2 ready */, gen: 0, root: null, failed: 0, queued: false,
    px: 0, pz: 0, y0: 0, ct: 1, st: 0, live: false, t: 0, feet: 0, have: false, lx: 0, ly: 0, nearAt: 0, farAt: 0, inside: false,
    open: 0, want: 0, leafE: null, leafW: null, cards: null, hud: null, hudOn: false, mats: [], src: {}, fill: null, lightsArr: null,
    nat: [], natT: 0, vtol: null, lodK: -1, cast: false,
  };
  let NAV = null, navP = null, _wall = false;

  // ── nav parse ────────────────────────────────────────────────────────────────────────────────────────────
  function shape(a) {
    const o = { t: 0, x0: a[1], y0: a[2], x1: a[3], y1: a[4], h0: 0, h1: 0, ax: 0 };
    if (a[0] === 's') { o.t = 2; o.ax = a[5] === 'y' ? 1 : 0; o.h0 = a[6]; o.h1 = a[7]; } else o.h0 = a[5];
    return o;
  }
  function parseNav(j) {
    const n = { patches: j.patches.map(shape), region: j.region, roofZ: j.roofZ, deckZ: j.deckZ, hangarZ: j.hangarZ, hatch: j.hatch, spawn: j.spawn, apronCeil: j.apronCeil || 0 };
    n.apron = new Float64Array((j.apron || []).length * 4); (j.apron || []).forEach((a, i) => { for (let k = 0; k < 4; k++) n.apron[i * 4 + k] = a[k]; });
    n.zones = new Float64Array(j.zones.length * 6); j.zones.forEach((z, i) => { for (let k = 0; k < 6; k++) n.zones[i * 6 + k] = z[k]; });
    n.zoneName = j.zones.map(z => z[6]);
    n.shaft = j.zones.find(z => z[6] === 'shaft'); n.hangar = j.zones.find(z => z[6] === 'hangar'); n.bay = j.zones.find(z => z[6] === 'bay');
    // walls: sparse (cell, zlo, zhi) records -> a dense grid of up to K z intervals per cell (0x7fff = empty)
    const w = j.wall, K = w.k || 4, bin = typeof atob === 'function' ? atob(w.data) : Buffer.from(w.data, 'base64').toString('binary'), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dv = new DataView(u8.buffer), d = new Int16Array(w.nx * w.ny * K * 2).fill(0x7fff), used = new Uint8Array(w.nx * w.ny);
    for (let o = 0; o + 8 <= u8.length; o += 8) {
      const c = dv.getInt32(o, true), m = used[c]; if (m >= K) continue;
      d[(c * K + m) * 2] = dv.getInt16(o + 4, true); d[(c * K + m) * 2 + 1] = dv.getInt16(o + 6, true); used[c] = m + 1;
    }
    n.wall = { x0: w.x0, y0: w.y0, c: w.cell, nx: w.nx, ny: w.ny, K, d };
    n.lights = new Float64Array(j.lights.length * 5); j.lights.forEach((l, i) => { for (let k = 0; k < 5; k++) n.lights[i * 5 + k] = l[k]; });
    return n;
  }

  // ── geometry queries (allocation-free; mansion frame u: x east, y seaward, z up, relative to the mansion root) ─────────────────────
  const inR = (r, x, y, m) => x >= r[0] - m && x <= r[2] + m && y >= r[1] - m && y <= r[3] + m;
  function lidClosed() { return S.open < 0.04; }
  // does the undercliff answer at (x,y) for feet `feet`? Below the roof line anywhere in its plan; at the plateau only over the hatch shaft.
  // the deck apron: lower-pool-deck cells under the top-level overhang (the exterior grid reports the slab above there)
  function inApron(x, y) {
    const A = NAV.apron;
    for (let i = 0; i < A.length; i += 4) if (x >= A[i] && x <= A[i + 2] && y >= A[i + 1] && y <= A[i + 3]) return true;
    return false;
  }
  function owns(x, y, feet) {
    if (NAV === null) return false;
    const R = NAV.region; if (x < R[0] || x > R[2] || y < R[1] || y > R[3]) return feet < NAV.roofZ && feet > NAV.deckZ - 6 && inApron(x, y);
    if (feet < NAV.roofZ) return true;
    const fr = NAV.hatch.frame; return feet < NAV.hatch.z + 8 && x >= fr[0] && x <= fr[2] && y >= fr[1] && y <= fr[3];   // the hatch frame: curb, lid / opening, scaffold grating
  }
  function patchH(p, x, y) {
    if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) return NaN;
    if (p.t === 2) { const u = p.ax ? (y - p.y0) / (p.y1 - p.y0) : (x - p.x0) / (p.x1 - p.x0); return p.h0 + (p.h1 - p.h0) * u; }
    return p.h0;
  }
  // floor height under (x,y) for a body whose feet are at `feet`: the highest patch not more than STEP above them. Sets _wall in rock.
  function surf(x, y, feet) {
    _wall = false;
    const P = NAV.patches, lim = feet + STEP; let best = NaN;
    for (let i = 0; i < P.length; i++) { const h = patchH(P[i], x, y); if (h <= lim && (best !== best || h > best)) best = h; }
    if (lidClosed() && inR(NAV.hatch.rim, x, y, 0) && NAV.hatch.z <= lim && (best !== best || NAV.hatch.z > best)) best = NAV.hatch.z;   // the closed lid is walkable ground
    if (best === best) return best;
    if (feet < NAV.roofZ) { _wall = true; return feet + WALL_UP; }   // solid rock
    return NaN;
  }
  function wallAt(x, y, lo, hi) {
    const W = NAV.wall, i = Math.floor((x - W.x0) / W.c), j = Math.floor((y - W.y0) / W.c);
    if (i < 0 || j < 0 || i >= W.nx || j >= W.ny) return false;
    const K = W.K, D = W.d, b = (j * W.nx + i) * K * 2, L = lo * 10, H = hi * 10;
    for (let m = 0; m < K; m++) { const a = D[b + m * 2]; if (a === 0x7fff) return false; if (a < H && D[b + m * 2 + 1] > L) return true; }
    return false;
  }
  function inBay(x, y) { const b = NAV.bay; return x >= b[0] && x <= b[2] && y >= b[1] - 0.5 && y <= b[3] + 2; }
  function blocked(x, y, feet) {
    if (S.state !== 2 && feet < NAV.roofZ && !inBay(x, y) && !inApron(x, y)) return true;   // doorway gate: the rooms are not streamed in yet, the bay's back-wall cards hold her out
    surf(x, y, feet); if (_wall) return true;
    const lo = feet + KNEE, hi = feet + BODY - 0.4;
    return wallAt(x, y, lo, hi) || wallAt(x - RAD, y, lo, hi) || wallAt(x + RAD, y, lo, hi) || wallAt(x, y - RAD, lo, hi) || wallAt(x, y + RAD, lo, hi)
      || wallAt(x - RAD * 0.7, y - RAD * 0.7, lo, hi) || wallAt(x + RAD * 0.7, y - RAD * 0.7, lo, hi) || wallAt(x - RAD * 0.7, y + RAD * 0.7, lo, hi) || wallAt(x + RAD * 0.7, y + RAD * 0.7, lo, hi);
  }
  function toLocal(wx, wz) { const dx = wx - S.px, dz = wz - S.pz; S._lx = dx * S.ct - dz * S.st; S._ly = -(dx * S.st + dz * S.ct); }

  // ── engine hooks (called by ui/dm-mansion-interior.js) ──────────────────────────────────────────────────────────────
  // walk(pos): true = the undercliff owns her position this frame (it swept the move; the interior walker stands down)
  function walk(pos) {
    if (OFF || NAV === null || S.rec === null) { S.live = false; return false; }
    toLocal(pos.x, pos.z); const lx = S._lx, ly = S._ly, feet = pos.y - 3.0 - S.y0;
    if (!owns(lx, ly, feet)) { S.live = false; S.have = false; S.inside = false; return false; }
    S.feet = feet; S.live = true; S.t = performance.now(); S.inside = feet < NAV.roofZ;
    if (!S.have || Math.abs(lx - S.lx) > TELE || Math.abs(ly - S.ly) > TELE) { S.lx = lx; S.ly = ly; S.have = true; return true; }
    const mx = lx - S.lx, my = ly - S.ly, dist = Math.abs(mx) + Math.abs(my);
    if (dist < 1e-6) return true;
    if (blocked(S.lx, S.ly, feet)) { S.lx = lx; S.ly = ly; return true; }   // already inside something (spawned, landed on a prop): let her walk out
    const n = Math.min(MAXSUB, Math.ceil(dist / 0.5)), sx = mx / n, sy = my / n; let cx = S.lx, cy = S.ly;
    for (let i = 0; i < n; i++) {
      if (!blocked(cx + sx, cy + sy, feet)) { cx += sx; cy += sy; }
      else if (sx !== 0 && !blocked(cx + sx, cy, feet)) cx += sx;
      else if (sy !== 0 && !blocked(cx, cy + sy, feet)) cy += sy;
      else break;
    }
    const ex = cx - lx, ey = cy - ly;
    if (ex * ex + ey * ey > 1e-10) { pos.x += ex * S.ct - ey * S.st; pos.z += -ex * S.st - ey * S.ct; }
    S.lx = cx; S.ly = cy;
    return true;
  }
  // ovr(x,z): her floor (world y) while she is in the undercliff, else NaN. Only consulted inside DMMansionInt.ground() (her own ground query).
  function ovr(x, z) {
    if (!S.live || NAV === null) return NaN;
    toLocal(x, z); if (!owns(S._lx, S._ly, S.feet)) return NaN;
    const h = surf(S._lx, S._ly, S.feet); return h === h ? S.y0 + h : NaN;
  }
  // ray(...): distance to the first wall / ceiling / rock along a world ray, or -1. Only while she is inside (the orbit camera clamp).
  function ray(ox, oy, oz, dx, dy, dz, maxD) {
    if (NAV === null || !S.live || !S.inside) return -1;
    const ns = Math.min(160, Math.ceil(maxD / 0.3)), Z = NAV.zones, nz = Z.length / 6;
    for (let i = 1; i <= ns; i++) {
      const d = i * maxD / ns; toLocal(ox + dx * d, oz + dz * d); const lx = S._lx, ly = S._ly, hz = oy + dy * d - S.y0;
      if (wallAt(lx, ly, hz - 0.15, hz + 0.15)) return d;
      let inZ = false;
      for (let k = 0; k < nz; k++) { const b = k * 6; if (lx >= Z[b] && lx <= Z[b + 2] && ly >= Z[b + 1] && ly <= Z[b + 3] && hz >= Z[b + 4] - 0.4 && hz <= Z[b + 5]) { inZ = true; break; } }
      if (!inZ && hz >= NAV.deckZ - 0.4 && hz <= NAV.apronCeil && inApron(lx, ly)) inZ = true;
      if (!inZ) { const R = NAV.region; if (lx >= R[0] && lx <= R[2] && ly >= R[1] && ly <= R[3] - 1 && hz < NAV.hatch.z) return d; }
    }
    return -1;
  }

  // ── the FUNCTION button (same bubble look as the room-light switch) ────────────────────────────────────────────────
  function hud() {
    if (S.hud) return S.hud; const d = G.document; if (!d || !d.createElement) return null;
    const st = d.createElement('style'); st.textContent = '#dm-hatch{position:absolute;left:22px;bottom:calc(292px + var(--safe-bot,0px));min-width:84px;height:84px;padding:0 12px;border:1.5px solid rgba(150,220,255,.85);border-radius:42px;background:radial-gradient(circle at 32% 26%,rgba(190,235,255,.45),rgba(30,80,120,.28) 60%,rgba(6,14,22,.62));color:#e6f6ff;font:800 .6rem var(--font-hud,ui-monospace,monospace);letter-spacing:.12em;z-index:33;opacity:0;transform:scale(.4);pointer-events:none;transition:opacity .18s,transform .28s cubic-bezier(.2,1.5,.4,1);touch-action:none;-webkit-tap-highlight-color:transparent;box-shadow:0 0 18px rgba(110,190,255,.45)}#dm-hatch.on{opacity:1;transform:scale(1);pointer-events:auto}#dm-hatch b{display:block;font-size:1.5rem;line-height:1}#dm-hatch span{display:block;margin-top:2px;white-space:nowrap}@media (orientation:portrait){#dm-hatch{bottom:calc(396px + var(--safe-bot,0px))}}';
    d.head.appendChild(st);
    const b = d.createElement('button'); b.id = 'dm-hatch'; b.type = 'button'; b.setAttribute('aria-label', 'Hangar hatch'); b.innerHTML = '<b>F</b><span id="dm-hatch-t">FUNCTION</span>';
    b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('pointerup', e => { e.preventDefault(); e.stopPropagation(); use(); });
    (d.getElementById('ship-jump-btn') && d.getElementById('ship-jump-btn').parentNode || d.body).appendChild(b);
    G.addEventListener('keydown', e => {
      if (!S.hudOn || e.code !== 'KeyF' || e.repeat || G.DM_TERMINAL_OPEN) return; const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
      try { if (G.DMLamps && G.DMLamps.status && G.DMLamps.status().near >= 0) return; } catch (er) { }   // a room-light switch in reach takes F first
      e.preventDefault(); use();
    }, true);
    S.hud = b; return b;
  }
  function setHud(on) { if (on === S.hudOn) return; S.hudOn = on; const h = on ? hud() : S.hud; if (h) h.classList.toggle('on', on); S.lastLbl = ''; }
  function use() {
    if (S.state !== 2 || !S.leafE) return;
    S.want = S.want ? 0 : 1;
    try { if (typeof G.toast === 'function') G.toast(S.want ? '🛩 Hangar hatch opening' : '🛩 Hangar hatch closing', 1500); } catch (e) { }
    try { if (G.dmAction) G.dmAction('hatch', S.want ? 'open' : 'close'); } catch (e) { }
  }
  function nearHatch(lx, ly, feet) {
    const H = NAV.hatch, r = H.rim; if (!inR(r, lx, ly, HATCH_REACH)) return false;
    if (Math.abs(feet - H.z) < 5) return true;                                          // on the plateau / the lid
    return feet < NAV.roofZ && inR(NAV.hangar, lx, ly, 0) && inR(r, lx, ly, 2);          // under it, on the hangar floor
  }

  // ── materials: the mansion's own texture sets, a private light list, the baked light as emissive fill ───────────────────
  function lightList(c) {
    const PW = c.PW && c.PW(), sc = PW && PW.scene; if (!sc) return null; const a = [];
    sc.traverse(o => { if (o.isAmbientLight || o.isHemisphereLight || (o.isSpotLight && o.userData && o.userData.dmFlash) || (o.isPointLight && o.name === 'JOTS_NatPool')) a.push(o); });
    return a.length ? a : null;
  }
  function liveSrc(name) {   // the mansion mesh's CURRENT material (2K upgrade / parallax twins swap it; never keep a texture the mansion has disposed)
    const m = S.src[name]; return m && m.material ? m.material : null;
  }
  function syncMaps() {
    for (let i = 0; i < S.mats.length; i++) {
      const e = S.mats[i], s = liveSrc(e.src); if (!s) continue; const m = e.m;
      if (m.map !== s.map || m.normalMap !== s.normalMap || m.roughnessMap !== s.roughnessMap) { m.map = s.map || null; m.normalMap = s.normalMap || null; m.roughnessMap = s.roughnessMap || null; m.metalnessMap = e.rock ? null : (s.metalnessMap || null); m.needsUpdate = true; }
    }
  }
  function buildMats(root, c) {
    const THREE = c.THREE, T = THREE.TSL, node = !!(THREE.MeshStandardNodeMaterial && T && T.uniform && T.diffuseColor);
    S.src = {}; S.rec.group.traverse(o => { if (o.isMesh && o.material && o.material.name && !S.src[o.material.name] && /^ah_(concrete|wood|slate|dark|rock)$/.test(o.material.name)) S.src[o.material.name] = o; });
    if (!S.fill) S.fill = node ? T.uniform(0.62) : { value: 0.62 };
    const L = lightList(c); S.lightsArr = L; const lights = node && L && T.lights ? T.lights(L) : null;
    const made = {}; S.mats = [];
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const name = o.material.name || '';
      if (MATMAP[name]) {
        if (!made[name]) {
          const s = liveSrc(MATMAP[name]), rock = name === 'uc_rock';
          const m = node ? new THREE.MeshStandardNodeMaterial() : new THREE.MeshStandardMaterial();
          m.name = name; m.vertexColors = true; m.side = THREE.FrontSide;
          m.roughness = rock ? 0.9 : (s ? s.roughness : 0.8); m.metalness = rock ? 0 : (s ? Math.min(s.metalness, 0.2) : 0);
          if (s) { m.map = s.map || null; m.normalMap = s.normalMap || null; if (s.normalScale) m.normalScale = s.normalScale.clone(); m.roughnessMap = s.roughnessMap || null; m.metalnessMap = rock ? null : (s.metalnessMap || null); }
          if (node) { m.emissiveNode = T.diffuseColor.rgb.mul(S.fill); if (lights) m.lightsNode = lights; }
          else { m.emissive = new THREE.Color(0.35, 0.33, 0.3); }
          m.userData.dmUndercliff = true; made[name] = m; S.mats.push({ m, src: MATMAP[name], rock });
        }
        o.material = made[name];
      } else if (name === 'uc_emit') {
        if (!made.uc_emit) { const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.85, 0.6).multiplyScalar(2.2) }); m.name = 'uc_emit'; m.toneMapped = true; m.userData.dmUndercliff = true; made.uc_emit = m; S.mats.push({ m, src: null }); }
        o.material = made.uc_emit;
      } else if (name === 'meadowlark_body') {
        const m = o.material; if (!m.userData.dmUcLit) { m.userData.dmUcLit = true; if (node && lights && 'lightsNode' in m) m.lightsNode = lights; if (node && 'emissiveNode' in m && T.materialEmissive) m.emissiveNode = T.materialEmissive.add(T.diffuseColor.rgb.mul(S.fill).mul(0.42)); }
      }
    });
  }

  // ── lazy load / dispose ──────────────────────────────────────────────────────────────────────────────────
  function disposeObj(o) {
    const mats = new Set(), tex = new Set();
    o.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => mats.add(m)); });
    mats.forEach(m => {
      if (m.userData && m.userData.dmUndercliff) { m.dispose(); return; }   // ours: the maps belong to the mansion, never dispose them here
      for (const k in m) { const v = m[k]; if (v && v.isTexture) tex.add(v); } m.dispose();
    });
    tex.forEach(t => t.dispose());
  }
  function releaseLights() { const N = G.DMNatLights; if (N) for (const k of S.nat) { try { N.release(k); } catch (e) { } } S.nat.length = 0; }
  function unload() {
    S.gen++; S.state = 0; S.live = false; S.have = false; S.queued = false; S.inside = false; setHud(false); releaseLights();
    if (S.root) { if (S.root.parent) S.root.parent.remove(S.root); disposeObj(S.root); S.root = null; }
    S.mats = []; S.vtol = null; S.lodK = -1; S.cast = false;
    if (S.cards) S.cards.visible = true;
    S.want = 0;   // the hatch closes with the level (a stream-out never leaves an open hole with no hangar under it)
  }
  function ensureNav(F) {
    if (!navP) navP = fetch('assets/ariel-home/ariel-home-undercliff-nav.json?v=' + F.ver + UCV).then(r => { if (!r.ok) throw new Error('nav ' + r.status); return r.json(); }).then(j => { NAV = parseNav(j); }, e => { navP = null; console.warn('[undercliff] nav', e); });
    return navP;
  }
  function load() {
    const F0 = S.F;
    if (!(F0 && F0.heavy)) { loadNow(null); return; }
    if (S.queued) return; S.queued = true; S.state = 1; const g = S.gen;
    F0.heavy('undercliff', () => new Promise(ok => { S.queued = false; if (S.gen !== g || !S.rec || !S.rec.group || S.state !== 1) { ok(); return; } loadNow(ok); }),
      () => { S.queued = false; if (S.state === 1 && S.gen === g) S.state = 0; });
  }
  function loadNow(fin) {
    fin = fin || (() => { });
    const F = S.F, c = F.ctx, gen = ++S.gen; S.state = 1;
    const small = c.isMobile() && !(F.tabletHi && F.tabletHi());
    ensureNav(F);
    Promise.all([c.loadGLB('assets/ariel-home/ariel-home-undercliff' + (small ? '-512' : '') + '.glb?v=' + F.ver + UCV), navP]).then(([gl]) => {
      if (gen !== S.gen || !S.rec || !S.rec.group || NAV === null) { disposeObj(gl.scene); fin(); if (NAV === null && gen === S.gen) { S.failed = performance.now(); S.state = 0; } return; }
      const root = gl.scene; root.name = 'JOTS_Undercliff';
      root.traverse(n => { if (n.isMesh) { n.castShadow = false; n.receiveShadow = !(n.material && n.material.name === 'uc_emit'); n.matrixAutoUpdate = false; n.updateMatrix(); } });
      buildMats(root, c);
      const v = root.getObjectByName('uc_vtol');
      if (v) { S.vtol = { l0: root.getObjectByName('Meadowlark_LOD0'), l1: root.getObjectByName('Meadowlark_LOD1'), l2: root.getObjectByName('Meadowlark_LOD2'), ramp: root.getObjectByName('Meadowlark_Ramp') }; setLod(0); }
      S.rec.group.add(root); S.root = root; root.updateMatrixWorld(true);
      c.mapTag(root);   // tag FIRST, compile SECOND (#239)
      const PW = c.PW(), done = () => { if (gen === S.gen) { S.state = 2; if (S.cards) S.cards.visible = false; } fin(); };
      try { if (PW && PW.renderer && PW.renderer.compileAsync && PW.camera) PW.renderer.compileAsync(root, PW.camera, PW.scene).then(done, done); else done(); } catch (e) { done(); }
    }).catch(e => { fin(); if (gen !== S.gen) return; S.failed = performance.now(); S.state = 0; console.warn('[undercliff] load failed', e); });
  }
  function setLod(k) {
    const V = S.vtol; if (!V || k === S.lodK) return; S.lodK = k;
    if (V.l0) V.l0.visible = k === 0; if (V.ramp) V.ramp.visible = k === 0; if (V.l1) V.l1.visible = k === 1; if (V.l2) V.l2.visible = k === 2;
  }
  // the two real lights: the fixtures nearest to her in the undercliff (re-aimed ~3x a second, no allocation after the first request)
  const _p = { x: 0, y: 0, z: 0 }, _best = [-1, -1], _bd = [0, 0];
  function aimLights(now) {
    const N = G.DMNatLights; if (!N || !S.inside || S.state !== 2) { if (S.nat.length) releaseLights(); return; }
    if (now - S.natT < 330) return; S.natT = now;
    const Lt = NAV.lights, n = Lt.length / 5; _best[0] = _best[1] = -1; _bd[0] = _bd[1] = 1e18;
    for (let i = 0; i < n; i++) {
      const b = i * 5, dz = Lt[b + 2] - (S.feet + 2.5); if (Math.abs(dz) > 14) continue;
      const d = (Lt[b] - S.lx) * (Lt[b] - S.lx) + (Lt[b + 1] - S.ly) * (Lt[b + 1] - S.ly) + dz * dz;
      if (d < _bd[0]) { _bd[1] = _bd[0]; _best[1] = _best[0]; _bd[0] = d; _best[0] = i; } else if (d < _bd[1]) { _bd[1] = d; _best[1] = i; }
    }
    const THREE = S.F.ctx.THREE;
    for (let s = 0; s < 2; s++) {
      const i = _best[s]; if (i < 0) continue; const b = i * 5, lx = Lt[b], ly = Lt[b + 1], lz = Lt[b + 2];
      _p.x = S.px + lx * S.ct - ly * S.st; _p.z = S.pz - lx * S.st - ly * S.ct; _p.y = S.y0 + lz - 0.3;   // mansion frame -> world (inverse of toLocal)
      const I = 2.4 * Lt[b + 4] * S.fill.value / 0.62, r = Lt[b + 3];
      if (S.nat[s] === undefined) S.nat[s] = N.request(new THREE.Vector3(_p.x, _p.y, _p.z), 0xffd9a0, I, r); else N.set(S.nat[s], _p, I);
    }
  }

  const API = {
    attach(F, rec, px, pz, y0, th) {
      if (S.state) unload();
      S.F = F; S.rec = rec; S.px = px; S.pz = pz; S.y0 = y0; S.ct = Math.cos(th); S.st = Math.sin(th); S.nearAt = S.farAt = 0; S.failed = 0; S.open = 0; S.want = 0;
      if (OFF) return; ensureNav(F);
      const g = rec.group; S.leafE = g.getObjectByName('uc_hatch_leaf_e'); S.leafW = g.getObjectByName('uc_hatch_leaf_w'); S.cards = g.getObjectByName('uc_portal_cards');
      for (const l of [S.leafE, S.leafW]) if (l) { l.matrixAutoUpdate = true; l.rotation.z = 0; }
      if (S.cards) S.cards.visible = true;
    },
    // F.tick, per mansion, after the interior: stream in when she is near (and the exterior is warmed), drop when she has gone; hatch + lights + LOD upkeep
    tick(rec, d2, now, dt, f, mode, arriving) {
      if (OFF || rec !== S.rec) return;
      const mob = !!(S.F.ctx.isMobile && S.F.ctx.isMobile()), LD = mob ? LOAD_DM : LOAD_D, DD = mob ? DROP_DM : DROP_D;
      if (S.live && now - S.t > 200) { S.live = false; S.have = false; S.inside = false; }
      if (S.state === 0) {
        if (d2 < LD * LD && rec.warmed && !arriving && NAV !== null) { if (!S.nearAt) S.nearAt = now; if (now - S.nearAt > 900 && (!S.failed || now - S.failed > 30000)) load(); }
        else S.nearAt = 0;
      } else if (d2 > DD * DD) { if (!S.farAt) S.farAt = now; if (now - S.farAt > 3000) { unload(); S.nearAt = S.farAt = 0; } } else S.farAt = 0;
      if (S.state === 2) syncMaps();
      // hatch leaves (eased; the lid stops being ground the moment it starts to lift)
      const tgt = S.want, dOpen = tgt - S.open;
      if (dOpen !== 0) {
        const stepK = OPEN_RATE * Math.min(dt, 0.1); S.open = Math.abs(dOpen) <= stepK ? tgt : S.open + Math.sign(dOpen) * stepK;
        const e = S.open * S.open * (3 - 2 * S.open), a = e * OPEN_ANG;
        if (S.leafE) S.leafE.rotation.z = -a; if (S.leafW) S.leafW.rotation.z = a;
      }
      // FUNCTION button: on foot, in reach of the hatch, level streamed in
      let hb = false;
      if (S.state === 2 && NAV !== null && mode !== 'fly' && f) { toLocal(f.x, f.z); hb = nearHatch(S._lx, S._ly, f.y - 3 - S.y0); }
      setHud(hb);
      if (hb && S.hud) { const lb = S.want ? 'CLOSE HATCH' : 'OPEN HATCH'; if (lb !== S.lastLbl) { S.lastLbl = lb; const t = S.hud.querySelector('#dm-hatch-t'); if (t) t.textContent = lb; } }
      if (S.state === 2) {
        aimLights(now);
        // VTOL LOD by camera distance (LOD0 near, LOD1 mid, LOD2 far)
        if (S.vtol && f) { const vp = NAV.spawn.vtol, vd = Math.hypot(f.x - (S.px + vp[0] * S.ct - vp[1] * S.st), f.z - (S.pz - vp[0] * S.st - vp[1] * S.ct)); setLod(vd < 90 ? 0 : vd < 220 ? 1 : 2); }
        // desktop: while she is inside, the level casts into the sun's near shadow box (the ceilings shade her; the rock above does not cast)
        const want = S.inside && !mob; if (want !== S.cast && S.root) { S.cast = want; S.root.traverse(n => { if (n.isMesh && n.material && n.material.name !== 'uc_emit') n.castShadow = want; }); }
      }
    },
    detach() { unload(); releaseLights(); if (S.hud && S.hud.parentNode) S.hud.parentNode.removeChild(S.hud); S.hud = null; S.hudOn = false; S.leafE = S.leafW = S.cards = null; S.rec = null; S.F = null; },
    walk, ovr, ray, owns: (x, y, feet) => owns(x, y, feet), use,
    isLive() { return S.live; }, isInside() { return S.live && S.inside; },
    status() { return { state: S.state, live: S.live, inside: S.inside, loaded: !!S.root, open: +S.open.toFixed(3), want: S.want, hud: S.hudOn, feet: +S.feet.toFixed(2), lx: +S.lx.toFixed(2), ly: +S.ly.toFixed(2), lights: S.nat.length, vtolLod: S.lodK }; },
    spawn() { return NAV ? NAV.spawn : null; },
    _test: { parse: j => { NAV = parseNav(j); }, surf, blocked, owns, wallAt, setFrame(px, pz, y0, th) { S.px = px; S.pz = pz; S.y0 = y0; S.ct = Math.cos(th); S.st = Math.sin(th); S.state = 2; S.rec = {}; }, setOpen(v) { S.open = v; }, nav: () => NAV, S },
  };
  G.DMUndercliff = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
