/* DART Meadow — DMPwHandoff: when a world's surface takes over from the orbit globe (v299, JOTS Worlds Wave 2b).
 *
 * WHY: _pwSpaceWatch (index.html) opened the surface world at PWS_OPEN = 9 planet radii and dissolved it in from 8.6 R to 7 R, far outside the
 * atmosphere glow (Solenne's faded shell is 1.18 R, ui/dm-atmo-shell.js); the space minimap globe came up at the approach range (3.5 R).
 * Now the world still OPENS (builds + compiles, hidden) at PWS_OPEN so the switch does not hitch, and keeps building its ground while hidden;
 * it is only SHOWN at the faded atmosphere perimeter.  Until then the flight body (sphere + map + clouds) is the planet.
 *
 * Policy (all radii are distance / planet radius, `shell` from DMAtmoShell.radii(body)):
 *   openR   = PWS_OPEN (9)   — the world may start pre-building (hidden).         closeR = PWS_CLOSE (11) — the hidden world is disposed.
 *   showR   = max(shell, floorR + minBand)  — the visible switch: the dissolve starts here (0 outside).  floorR = 1 + floor/R (airless worlds).
 *   downR   = clamp(showR - bandK*(showR-1), floorR, 1 + downMax/R) — dissolve complete; the board moves into the ground's frame here.
 *   hideR   = showR + max(hystMin, hystK*(showR-1)) — on the way out the visible latch (minimap globe) drops only past this.
 *   reveal  = smoothstep((showR - dr) / (showR - downR)), 0 at/outside showR, 1 at downR.
 * step() writes into the state object it is given (no allocation): {prebuild, close, visible, reveal, showR, downR, hideR, downAlt, shell}.
 * window.DMPwHandoff in the page; module.exports for node (tools/tests/pw-handoff.js).
 */
(function (root) {
  'use strict';
  const DEF = { open: 9, close: 11, downMax: 2600, floor: 300, bandK: 0.4, minBand: 0.01, hystK: 0.25, hystMin: 0.01 };
  const sm = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
  // thresholds for a shell (planet radii) on a world of flat radius R (_planetR(), world units); writes into `o`
  function thresholds(shell, R, o, cfg) {
    const c = cfg || DEF, Rr = R > 0 ? R : 1;
    const s = shell > 1 ? shell : 1;
    const floorR = 1 + c.floor / Rr, maxDownR = 1 + c.downMax / Rr;
    const showR = Math.max(s, floorR + c.minBand);
    let downR = showR - c.bandK * (showR - 1);
    if (downR < floorR) downR = floorR;
    if (downR > maxDownR) downR = maxDownR;
    if (downR > showR - c.minBand * 0.5) downR = showR - c.minBand * 0.5;
    o.shell = s; o.showR = showR; o.downR = downR; o.hideR = showR + Math.max(c.hystMin, c.hystK * (showR - 1));
    o.downAlt = (downR - 1) * Rr; o.openR = c.open; o.closeR = c.close;
    return o;
  }
  // one frame of the policy at distance dr (planet radii); the visible latch uses showR going in and hideR going out
  function step(st, dr, shell, R, cfg) {
    thresholds(shell, R, st, cfg);
    st.prebuild = dr < st.openR;
    st.close = dr > st.closeR;
    st.reveal = sm((st.showR - dr) / (st.showR - st.downR));
    st.visible = st.visible ? dr <= st.hideR : dr <= st.showR;
    return st;
  }
  function make() { return { prebuild: false, close: false, visible: false, reveal: 0, shell: 1, showR: 1, downR: 1, hideR: 1, downAlt: 0, openR: DEF.open, closeR: DEF.close }; }
  function reset(st) { st.visible = false; st.reveal = 0; st.prebuild = false; st.close = false; return st; }
  const H = { DEF, thresholds, step, make, reset, smooth: sm };
  if (typeof module !== 'undefined' && module.exports) module.exports = H;
  if (typeof window !== 'undefined') window.DMPwHandoff = H;
})(typeof window !== 'undefined' ? window : globalThis);
