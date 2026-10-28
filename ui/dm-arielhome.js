/* dm-arielhome.js — Ariel's home: the Lumenreach galaxy, the Veyra binary system, the world Solenne, "Return Home",
 * and the landmark list (cliff facilities, the mansion, the ocean city) for the travel tree + Quick Travel.
 *
 * Data only + a few gated hooks that index.html calls (nothing here runs unless the Veyra system is the one flying):
 *   getGalaxySystems(...)       -> DMArielHome.patch(g)           (galaxy 'lumenreach' only: slot 0 is the fixed home system)
 *   rebuildFlightForSystem(sys) -> buildStars / buildMoons / arrive (system.ariel only; bd.orbitAU overrides the orbit radius)
 *   updateBodies()              -> tick()                          (binary stars swing round the barycentre; no allocation)
 *   travel tree / Quick Travel  -> treeKids / siteNodes / rootNode / goHome / visit
 * Existing galaxies and seeds are untouched: this only adds one galaxy id and never draws from an existing random stream.
 */
(function () {
  'use strict';
  const A = window.DMArielHome = { ctx: null, active: false, KEY: 'lumenreach', NAME: 'Lumenreach', SYS: 'Veyra', HOME: 'Solenne' };

  // ── the galaxy (VISITABLE_GALAXIES / GS_VISIT_CATALOG rows live in index.html; this is the one fixed system) ──
  // Two stars round a common barycentre (≈60 game days). Every planet circles BOTH (circumbinary), well outside the
  // 3× separation stability limit. Solenne sits in the habitable band of the pair.
  const BIN = { sep: 560, massA: 0.62, periodDays: 60, rA: 118, rB: 78 };
  const BODIES = [
    { name: 'Cinder', type: 'Volcanic', color: 0xaa3322, landable: true, gravity: 0.9, radius: 0.8, orbitAU: 2.3, moons: 0 },
    { name: 'Solenne', type: 'Habitable', color: 0x2a7a44, landable: true, gravity: 1.0, radius: 1.12, orbitAU: 3.2, hasAtm: true, habitable: true, home: true, moons: 2,
      moonList: [
        { name: 'Aure', type: 'Barren Moon', color: 0xb9b3a6, landable: true, gravity: 0.17, radius: 0.27, dist: 15, days: 11, inc: 0.08, hasAtm: false },
        { name: 'Vesper', type: 'Ice', color: 0xc9dbe8, landable: true, gravity: 0.1, radius: 0.19, dist: 24, days: 27, inc: 0.3, hasAtm: false }] },
    { name: 'Marrow', type: 'Desert', color: 0xcaa050, landable: true, gravity: 0.7, radius: 0.95, orbitAU: 4.4, moons: 0 },
    { name: 'Tessaly', type: 'Gas Giant', color: 0xd9b280, landable: false, gravity: 2.4, radius: 3.4, orbitAU: 6.1, hasRings: true, moons: 0 },
    { name: 'Hollin', type: 'Ice', color: 0xaaccdd, landable: true, gravity: 0.5, radius: 0.8, orbitAU: 8.2, moons: 0 },
    { name: 'Wend', type: 'Methane', color: 0x6a8a5a, landable: true, gravity: 0.14, radius: 0.6, orbitAU: 10.4, moons: 0 }
  ];
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  A.system = { name: 'Veyra', starType: 'G yellow', ariel: true, binary: BIN, bodies: BODIES, ang: 0.62, rad: 0.38, seed: hash('sys:Veyra:lumenreach:home'),
    star2: 'K orange', starK: 5000, starK2: 3900, starR: BIN.rA, starNote: 'Veyra A (G) + Veyra B (K), 60-day binary' };
  A.bodyDef = n => BODIES.find(b => b.name === n) || null;
  A.patch = function (g) { if (g && Array.isArray(g.systems)) g.systems[0] = A.system; return g; };

  // ── landmarks (the visit rows). lat/lon is where the fly-in starts; the facility module snaps to the steepest nearby cliff ──
  A.SITES = [
    { id: 'earth-bigsur', body: 'Earth', sys: null, gal: 'milkyway', lat: 36.27, lon: -121.81, label: 'Big Sur Cliff Facility', kind: 'facility', variant: 'earth-a', icon: '🛰️', meta: 'Cliffside aerospace facility' },
    { id: 'earth-moher', body: 'Earth', sys: null, gal: 'milkyway', lat: 52.97, lon: -9.43, label: 'Moher Cliff Facility', kind: 'facility', variant: 'earth-b', icon: '🛰️', meta: 'Cliffside aerospace facility' },
    { id: 'earth-city', body: 'Earth', sys: null, gal: 'milkyway', lat: 12.0, lon: -145.0, label: 'Pelagia Ocean City', kind: 'city', icon: '🏙️', meta: 'Towers, bridges, cloud layer' },
    { id: 'mars-valles', body: 'Mars', sys: null, gal: 'milkyway', lat: -13.9, lon: -59.2, label: 'Valles Rim Facility', kind: 'facility', variant: 'mars', icon: '🛰️', meta: 'Cliffside aerospace facility' },
    { id: 'titan-kraken', body: 'Titan', sys: null, gal: 'milkyway', lat: 68.0, lon: -35.0, label: 'Kraken Bay Hangar', kind: 'facility', variant: 'titan', icon: '🛰️', meta: 'Enclosed bay · haze membrane' },
    { id: 'home-mansion', body: 'Solenne', sys: 'Veyra', gal: 'lumenreach', lat: 18.0, lon: 40.0, label: "Ariel's Mansion", kind: 'mansion', icon: '🏠', meta: 'Cliff estate over the sea' },
    { id: 'home-city', body: 'Solenne', sys: 'Veyra', gal: 'lumenreach', lat: -22.0, lon: 120.0, label: 'Aurelis Ocean City', kind: 'city', icon: '🏙️', meta: 'Towers, bridges, cloud layer' }
  ];
  A.site = id => A.SITES.find(s => s.id === id) || null;

  // ── context from index.html (functions are hoisted there; state arrives through getters) ──
  A.bind = function (c) { A.ctx = c; };
  const C = () => A.ctx;

  // ── the stars ──
  const S = { b: null, aMesh: null, aGroup: null, kA: 0, kB: 0 };
  A.buildStars = function (system, star, starK) {
    const c = C(), THREE = c.THREE;
    // Star A is already built at BIN.rA (index.html passes system.starR). Both stars are built at their real radius, never
    // by scaling the group: the corona/fume shaders bake the build radius into their ray-march, so a scaled star showed
    // a hard-edged shell and stacked halo rings.
    S.aGroup = star.group;
    const kB = system.starK2 || c.DMStar.tempFor(system.star2 || 'K orange');
    const sb = c.DMStar.build({ radius: BIN.rB, temp: kB, seed: (system.seed % 997) + 7 });
    sb.group.name = 'JOTS_StarB';
    c.flightScene.add(sb.group); c.trackExtra(sb.group); S.b = sb.group;
    A.active = true; A.tick();
    return sb;
  };
  A.tick = function () {
    if (!A.active || !S.aGroup || !S.b) return;
    const c = C(), days = window.DMTime ? DMTime.days() : 0;
    const ang = Math.PI * 2 * days / BIN.periodDays, ca = Math.cos(ang), sa = Math.sin(ang);
    const fA = BIN.sep * (1 - BIN.massA), fB = BIN.sep * BIN.massA;     // barycentre at the origin
    S.aGroup.position.set(-fA * ca, 0, -fA * sa);
    S.b.position.set(fB * ca, 0, fB * sa);
  };
  A.stop = function () { A.active = false; S.aGroup = null; S.b = null; };

  // ── moons: same fields as the Sol catalog moons (updateBodies' orbitParent branch drives them) ──
  A.buildMoons = async function (system, hash2) {
    const c = C(), THREE = c.THREE, out = [];
    for (const bd of system.bodies) {
      if (!bd.moonList) continue;
      const p = c.celestialBodies.find(b => b.name === bd.name); if (!p) continue;
      for (const m of bd.moonList) {
        const r = Math.max(0.9, m.radius * c.PLANET_VIS_SCALE), seed = hash(system.name + ':' + m.name);
        let g;
        try { g = await c.buildProceduralPlanetMesh(r, seed, m.color, !!m.hasAtm, undefined, m.name); }
        catch (e) { g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.SphereGeometry(r, 24, 24), new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.9 }))); }
        g.position.copy(p.mesh.position); c.flightScene.add(g);
        const b = { mesh: g, name: m.name, type: m.type, temp: '150 K', collisionRadius: r, gravity: m.gravity, landable: true, hasTerrain: true, isProcedural: true,
          mcRadius: r, mcSeed: seed, mcColor: m.color, mcHasAtm: !!m.hasAtm, mcKind: m.name, mcRes: c.lowRes(), mcTier: 'low',
          orbitParent: p, orbitDist: Math.max(m.dist, p.collisionRadius * 2.4), orbitDays: m.days, orbitInc: m.inc, orbitPhase: (seed % 3600) / 3600 * Math.PI * 2, moons: 0 };
        p.moons = (p.moons | 0) + 1; c.celestialBodies.push(b); out.push(b);
      }
    }
    return out;
  };
  A.arrive = function () {      // arrive in the lee of Solenne (not inside a star)
    const c = C(), p = c.celestialBodies.find(b => b.name === A.HOME); if (!p) return false;
    const r = p.collisionRadius || 6, m = p.mesh.position, k = Math.hypot(m.x, m.z) || 1;
    c.STATE.flight.pos.set(m.x - m.x / k * r * 5.5, r * 0.4, m.z - m.z / k * r * 5.5);
    if (c.boardFlight) c.boardFlight.position.copy(c.STATE.flight.pos);
    return true;
  };

  // ── travel: Return Home + landmark visits ──
  A.goHome = function () {
    const c = C(); if (!c) return;
    c.closeQuickTravel();
    c.openFastTravel('RETURN HOME — SOLENNE', 'Travel to Lumenreach and the Veyra binary, and arrive above Solenne, Ariel\'s home world?', () => {
      c.GALAXY_DB.current = A.KEY; c.fastTravelToSystem(A.system, A.KEY);
    });
  };
  A.inHome = () => { const c = C(); return !!(c && c.curGalaxy() === A.KEY && c.curSysName() === A.SYS); };
  A.rootNode = function () {
    return { id: 'home:ariel', icon: '🏠', label: 'Return Home', meta: 'Solenne · Veyra · Lumenreach', go: () => A.goHome(), kids: null };
  };
  // after a jump: poll until the system's bodies are built, then land at the landmark
  let pend = null;
  function pollLand() {
    const c = C(); if (!pend) return;
    const s = pend, sysOk = (s.sys || 'Sol') === c.curSysName() && c.curGalaxy() === s.gal;
    const b = sysOk && c.celestialBodies.find(x => x.name === s.body && x.mesh);
    if (b && !c.PW.opening) { pend = null; try { window.DM_FAC = window.DM_FAC || {}; window.DM_FAC.arriveAt = s.id; window.DM_FAC.homeDeck = !!s.deck; c.enterAtmosphericFlight(b, { lat: s.lat, lon: s.lon }); } catch (e) { console.warn('[home] land', e); } return; }
    if (++s.tries > 80) { pend = null; return; }
    setTimeout(pollLand, 600);
  }
  // HOME button: Quick Travel straight to Ariel's mansion deck, from space, the sky or the ground (no confirm — the button IS the intent)
  let homing = false;
  A.homeNow = function () {
    const c = C(), s = A.site('home-mansion'); if (!c || !s || homing) return;
    c.closeQuickTravel();
    window.DM_FAC = window.DM_FAC || {};
    const onHome = A.inHome() && c.PW && c.PW.active && c.PW.body && c.PW.body.name === A.HOME;
    if (c.atmoActive && onHome) { window.DM_FAC.homeDeck = true; window.DM_FAC.arriveAt = s.id; c.toast('🏠 Home — heading for the mansion deck', 2200); return; }
    const go = () => {
      const here = A.inHome() && c.flightInited;
      pend = { id: s.id, body: s.body, sys: s.sys, gal: s.gal, lat: s.lat, lon: s.lon, tries: 0, deck: true };
      c.toast('🏠 Home — Quick Travel to ' + s.label, 2400);
      if (!here) { c.GALAXY_DB.current = s.gal; c.fastTravelToSystem(A.system, s.gal); }
      setTimeout(pollLand, here ? 100 : 2200);
    };
    if (c.atmoActive || c.surfaceActive) {     // leave the world first (the same exits as TO SPACE / LIFTOFF), then travel
      homing = true; c.toast('🏠 Home — leaving this world first…', 2400);
      try { c.atmoActive ? c.atmoExitToSpace() : c.exitSurface(); } catch (e) { }
      let n = 0;
      (function wait() {
        const st = c.STATE && c.STATE.screen;
        if (!c.atmoActive && !c.surfaceActive && st === 'flight' && c.flightInited) { homing = false; go(); return; }
        if (++n > 240) { homing = false; return; }
        setTimeout(wait, 500);
      })();
      return;
    }
    go();
  };
  A.visit = function (id) {
    const c = C(), s = A.site(id); if (!c || !s) return;
    c.closeQuickTravel();
    const here = c.curGalaxy() === s.gal && c.curSysName() === (s.sys || 'Sol') && c.flightInited;
    openLand(s, here);
  };
  function openLand(s, here) {
    const c = C();
    c.openFastTravel('LAND — ' + s.label.toUpperCase(), (here ? 'Descend to ' : 'Jump to ' + (s.sys || 'Sol') + ' and descend to ') + s.label + ' on ' + s.body + '?', () => {
      pend = { id: s.id, body: s.body, sys: s.sys, gal: s.gal, lat: s.lat, lon: s.lon, tries: 0 };
      if (!here) { c.GALAXY_DB.current = s.gal; c.fastTravelToSystem(s.sys ? A.system : null, s.gal); }
      setTimeout(pollLand, here ? 100 : 2200);
    });
  }
  const siteNode = s => ({ id: 'site:' + s.id, icon: s.icon, label: s.label, meta: s.meta, go: () => A.visit(s.id), kids: null });
  A.siteNodes = function (bodyName, sysName) { return A.SITES.filter(s => s.body === bodyName && (s.sys || 'Sol') === (sysName || 'Sol')).map(siteNode); };

  // The Veyra rows for the travel tree: the pair, then each world (moons + landmarks nested under it).
  A.treeKids = function (gal, e, goBody) {
    const sys = e.sys, out = [];
    out.push({ id: 'sys:' + gal + ':Veyra:*', icon: '⭐', label: 'Veyra A + B', meta: 'Binary · G + K', body: sys.name, go: () => goBody(gal, e.name, sys, e.name, 'Veyra'), kids: null });
    sys.bodies.forEach(bd => {
      const moons = (bd.moonList || []).map(m => ({ id: 'sys:' + gal + ':' + m.name, icon: '🌙', label: m.name, meta: 'Moon of ' + bd.name + ' · landable', body: m.name, go: () => goBody(gal, e.name, sys, m.name), kids: null }));
      const kids = moons.concat(A.siteNodes(bd.name, e.name));
      const n = { id: 'sys:' + gal + ':' + bd.name, icon: bd.home ? '🏠' : bd.landable ? '🪐' : '🟠', label: bd.name,
        meta: (bd.type || 'Planet') + (bd.home ? ' · Ariel\'s home' : '') + (bd.landable ? ' · landable' : ''), body: bd.name, go: () => goBody(gal, e.name, sys, bd.name), kids: kids.length ? () => kids : null };
      if (kids.length) n.count = kids.length;
      out.push(n);
    });
    return out;
  };
})();
