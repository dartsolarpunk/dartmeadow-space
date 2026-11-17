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

# t1516 (sw v332): live/local divergence, radial horizon blend, Mars ripples, cliff contract

## Live vs local divergence (root cause)
Every file served by dartmeadow.space is byte-identical to `main` (all 96 page scripts and 148 referenced assets compared with `curl`, all HTTP 200, exact case),
so it is not a path, case, MIME or missing-file problem. The difference is the **backend**: the dev harness and local WebGL serves draw planets as canvas-textured
spheres (`buildWebGLRichPlanetGroup`), while live devices on **real WebGPU** draw the near world as the per-brick cluster LOD mesh (`_svLodPlanetMesh`, the
"nanite"-style bricks, `_svLodAllowed()` needs real WebGPU). When the world map ("world engine": `_terrainCore` -> `worldMapFor`) arrived,
`_applyWorldMapToFlightBody` put it on that mesh as a **new plain material**. That threw away (1) the per-brick fade (`opacityNode` from `fadeNode[slot]`, and the
stream's `alphaHash` switch on `ctl.mat`), so on every LOD change the coarse and the fine bricks drew together at full opacity (stacked shells, z-fight, dead slots
held solid, pop-in), and (2) the DMRock layered-rock bump + roughness (Mars' PBR relief from the air). Fix: `_wmCarry` keeps those nodes on the map material,
`_wmLodBind` points the stream at the drawn material (`tools/tests/worldmap-lod-carry.js`). Also: seven scripts had changed since their `?v=` tag was set
(dm-atmo, dm-fluid-world, dm-menuscene, dm-perf, dm-stack, dm-theme, dm-worldstyle): retagged `?v=332` so the service worker's cache-first rule cannot serve a stale copy.

## Radial horizon blend
`SkyGround._hazeInit`: the ground's final lit output (textures, lighting, shadows, fog) blends to the scene haze colour between the Radical Circumference rim's inner
edge (0.75 R) and its centre (0.875 R) of the drawn radius R (Justin Craig Venable, `ui/dm-radical-circ.js`), then the existing dither dissolve (0.82 R -> R) removes
pixels that are already sky-coloured. `?skyhaze=0` = dissolve only. Airless worlds: dissolve only. Test: `tools/tests/radial-lod-blend.js`.

## Cliff placement contract (t1516)
What the terrain side assumes about the mansion cliffs (Solenne). Pinned by `tools/tests/cliff-contract.js`:
- **Anchor**: the mansion site (px, pz) chosen by `ui/dm-facilities.js` `place()`; heading th = atan2(-dx, -dz) (local +Z inland, local -Z / Blender +y seaward).
- **Height**: y0 = max of the NATURAL ground (F.baseH) at the centre and the probes (0,40) (-30,40) (30,40) (0,80) (-60,0) (60,0), + 0.3 m. Seeds and the natural field are not changed by terrain work.
- **Footprint**: box x in [-196, 196] along the wall, y in [-121, 121] seaward (Blender frame), GLB cliff sweep x +-200, y +-125. Inside the box the DRAWN ground
  (SkyGround, tessellation, MC patch, props) is lowered to y0 - 128 with a 14 m smoothstep feather from the box edge, so the GLB's own shard-rock cliff/plateau is
  what shows; WALKING inside the box = collision grid (R 230 m) / interior floor. Outside the box drawn = walking = natural ground.
- Cliffs owns the cliff mesh, textures, strata and `_terrainDetailMat` cliff shading. If the cliff needs the natural ground outside the box lower / flatter (an apron),
  that is a change to this contract (and to walking heights), to be agreed before either side ships it.
