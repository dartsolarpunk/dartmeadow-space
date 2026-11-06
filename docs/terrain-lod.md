# One terrain across every altitude band (Solenne audit, sw v290)

Test: `node tools/tests/terrain-lod.js` (runs the real `_terrainCore`, `_groundField`, planet frame and the whole `SkyGround` quadtree extracted from index.html; 44 checks).

## What is drawn where, and what it samples
| band | drawn by | height source | colour source |
|---|---|---|---|
| orbit / near space | flight-body sphere (MC mesh, generic noise relief ~1.2 % R, shading only) + whole-planet map texture (`worldMapFor`, 256x128 then 768x384) | map = `_terrainCore(lon/D,-lat/D)` | `_worldMapTexture` |
| high atmosphere .. ground | `SkyGround` quadtree, 8x4 roots pole to pole, 45 deg .. 44 u tiles, geomorph + skirts | `_groundField.H` = same `_terrainCore` at the site offset | `surfaceBiomeColor` (coarse sea flat, tinted) |
| near ground | MC patch / tessellation / props | `TERRAIN.H` (+ mansion carve box) | `surfaceBiomeColor` + ground shader |

## Verified by test (node, real code)
- Height is ONE function: map height == ground height from any site, across the +-180 wrap, to the 89.9 deg pole clamp, finite and continuous far outside any "generated" area (no void, no wall).
- Coverage: any focus gives 32 roots spanning exactly 360 x 180 deg; at 2 m .. 12 km, flat and planet frame, every ground point inside the drawn radius is under exactly one visible tile (0 holes, 0 parent+child double layers after a full build).
- Cracks: over thousands of edges at every LOD level the opening between a coarse and a finer tile is shallower than the skirt (`max(4, 2 step)`).

## Gaps found and fixed
1. **Orbit colour != landing colour.** The map used slope = tan x 1.5, the ground uses (1 - ny) x 1.6; a 12 deg hillside was rock from orbit and grass on the ground (0.55 vs 0.03). The map also lacked the dirt band, used different rock/sand thresholds and wrote linear values as sRGB bytes. For Solenne (`body.habitable`) the map now calls `surfaceBiomeColor` itself (`opts.flat` = noise at its mean, since a map pixel is ~60 m), slope from `DMTerrainLod.groundSlope` at the map cell, sea tint linear like the coarse tiles (`seaT`), bytes sRGB-encoded. Other worlds are unchanged.
2. **Placeholder planet until 30 R.** Solenne wore the generic placeholder colouring until 30 radii away (Earth: 90 R). Habitable home worlds now request the map at 90 R.

## Not changed / unverified (no GPU here)
- Nothing rendered. The map colour change and the sRGB assumption (map bytes are decoded as an sRGB texture, the ground's vertex colours are linear) are by reading the code; check Solenne from orbit vs the same coast on landing.
- The orbit sphere's own geometric relief is generic 3-D noise, not `_terrainCore`; it only shapes light/silhouette (1.2 % R). Displacing it from the map heights (like Earth's ETOPO texture) needs a mesh rebuild after the map arrives; not done.
- Mansion GLB cliff box edge vs natural ground (carve feather 14 m) belongs to the mansion lane; relief-aware split and ladder are the far-LOD worker's (`docs/far-lod.md` Part 3) and were not duplicated.
- "Dimension-map area" was read as the mansion/generated patch; no tile or height discontinuity outside it exists in code.
