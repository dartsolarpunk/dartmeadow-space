/* DART Meadow — DMAtmoShell: where a body's faded volumetric atmosphere ends (v297, Cosmos; for JOTS Worlds' Solenne hand-off).
 *
 * WHY: _pwSpaceWatch (index.html) opens the surface world at PWS_OPEN = 9 planet radii, far outside the glow.  The visible switch should happen at the
 * atmosphere perimeter, where the ray-marched shell has faded out.  This helper only ANSWERS where that is; it changes nothing (PWS_OPEN, _pwSpaceWatch,
 * fly-in and the pre-build at 9 R are untouched — the switch itself is Worlds' change).
 *
 * The perimeter is read from the atmosphere mesh the planet was built with (userData.jotsAtmo + planetR + atmoTop, or shellR: index.html
 * buildProceduralPlanetMesh / _buildJotsDustyAtmoShell), so it is exactly the shell that draws.  Solenne (Habitable, kind 'earth') -> _ATMO_LOOK.earth:
 * shell 1.18 R (GL fallback shell 1.16 R).  No mesh found -> the _ATMO_LOOK multiplier for the kind, else 1.10; airless (no atmosphere) -> 1.0.
 *
 * API (stable names, window.DMAtmoShell; pure core also module.exports for node, tools/tests/atmo-shell-unit.js):
 *   DMAtmoShell.radii(body, fade?)          -> perimeter in planet radii (>= 1).  fade 0..1 (default 1 = outer shell edge, fully faded; 0 = the surface).
 *   DMAtmoShell.worldR(body, bodyR, fade?)  -> the same in world units: radii x bodyR (pass _bodyR(b), the radius _pwSpaceWatch divides by).
 *   DMAtmoShell.ratio(body, pos, bodyR)     -> distance(body.mesh.position, pos) / worldR(body, bodyR): > 1 outside the glow, <= 1 inside.
 *   DMAtmoShell.forget(body)                -> drop the cached reading (after a planet / atmosphere rebuild).
 * Cost: one traverse of body.mesh on the first call per body (cached on the body object); every later call is arithmetic, no allocation.
 */
(function (root) {
  'use strict';
  const LOOK_FALLBACK = { earth: 1.18, habitable: 1.18, mars: 1.06, venus: 1.16, titan: 1.22, other: 1.10 };
  // pure: shell radius in planet radii from a mesh's userData (null when it carries none)
  function shellFromUserData(ud) {
    if (!ud || !ud.jotsAtmo) return null;
    const R = +ud.planetR; if (!(R > 0)) return null;
    if (ud.atmoTop > 0) return (R + +ud.atmoTop) / R;
    if (ud.shellR > 0) return +ud.shellR / R;
    return null;
  }
  // pure: perimeter radii with a fade in [0, 1] (1 = outer edge of the shell, 0 = the surface)
  function withFade(shell, fade) { const f = fade == null ? 1 : fade < 0 ? 0 : fade > 1 ? 1 : fade; return 1 + (shell - 1) * f; }
  function lookMul(kind, look) {
    const k = String(kind || '').toLowerCase(), L = look || null;
    const e = L && (L[k] || (k === 'habitable' ? L.earth : null) || L.other);
    if (e && e.mul > 0) return e.mul;
    return LOOK_FALLBACK[k] || LOOK_FALLBACK.other;
  }
  // pure: the largest shell found under an object tree (outer glow), via a traverse function (obj.traverse)
  function scanShell(obj) {
    let best = null; if (!obj) return null;
    const visit = (o) => { const s = shellFromUserData(o && o.userData); if (s != null && (best == null || s > best)) best = s; };
    if (typeof obj.traverse === 'function') obj.traverse(visit); else visit(obj);
    return best;
  }
  const core = { shellFromUserData, withFade, lookMul, scanShell, LOOK_FALLBACK };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;

  const W = root;
  function look() { try { return typeof _ATMO_LOOK !== 'undefined' ? _ATMO_LOOK : null; } catch (e) { return null; } }   // index.html's table (global lexical)
  function shellOf(b) {
    if (!b) return 1;
    if (b._dmAtmoShell > 0) return b._dmAtmoShell;
    let s = scanShell(b.mesh) || scanShell(b.atmo) || scanShell(b.atmosphere);
    if (s == null) {
      const airless = b.hasAtmosphere === false || b.atmosphere === false || /asteroid|comet/i.test(String(b.type || ''));
      const kind = b.type === 'Habitable' ? 'earth' : (b.kind || b.atmoKind || (b.name === 'Mars' ? 'mars' : b.name === 'Titan' ? 'titan' : 'other'));
      s = airless ? 1 : lookMul(kind, look());
      if (!b.mesh) return s;   // nothing built yet: do not cache a guess
    }
    b._dmAtmoShell = s; return s;
  }
  const A = {
    core,
    radii(b, fade) { return withFade(shellOf(b), fade); },
    worldR(b, bodyR, fade) { return withFade(shellOf(b), fade) * (bodyR > 0 ? bodyR : 1); },
    ratio(b, pos, bodyR) { if (!b || !b.mesh || !pos) return Infinity; return b.mesh.position.distanceTo(pos) / A.worldR(b, bodyR, 1); },
    forget(b) { if (b) b._dmAtmoShell = 0; },
  };
  W.DMAtmoShell = A;
})(typeof window !== 'undefined' ? window : globalThis);
