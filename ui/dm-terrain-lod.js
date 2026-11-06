/* DART Meadow — one terrain across every altitude band (pure helpers, node-tested: tools/tests/terrain-lod.js).
 * The height/continent/biome source is already one function (_terrainCore).  What differed between bands was how it was COLOURED and where it was CACHED:
 *   groundSlope(hx, hz, step)  the slope the sky-ground tiles feed surfaceBiomeColor: normal (h[-1]-h[+1], 2 step, h[-1]-h[+1]) -> (1 - ny) x 1.6.  The globe map used tan x 1.5, so a
 *                              12 degree hillside was "rock" from orbit and grass on landing; the map now uses this at its own cell size.
 *   skirtDrop(step)            how far a sky-ground tile's skirt hangs below its edge (the crack between LOD levels must be shallower than this).
 *   seaColour(h, deep, shal, out)  the flat-sea tint of coarse tiles and of the globe: linear in depth over 40 m, same on both.
 */
(function (root) {
  'use strict';
  function groundSlope(hx, hz, step) {
    const ny = 2 * step, L = Math.hypot(hx, ny, hz) || 1;
    return Math.min(1, Math.max(0, 1 - ny / L) * 1.6);
  }
  function skirtDrop(step) { return Math.max(4, step * 2); }
  function seaT(h) { return Math.min(1, Math.max(0, -h / 40)); }
  const api = { groundSlope, skirtDrop, seaT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DMTerrainLod = api;
})(typeof window !== 'undefined' ? window : globalThis);
