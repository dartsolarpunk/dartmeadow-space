# Biome scatter (v385, opt-in `?scatter=1`)

Procedural foliage / rock scatter for the planet worlds: `ui/dm-biome-scatter.js` (engine), `ui/dm-biome-defs.js` (three starter biomes as JSON-compatible data).
Tests: `node tools/tests/biome-scatter.js` (pure core, ~11 k checks) and `node tools/tests/biome-scatter-glue.mjs` (THREE side + the real `tick()` with a fake game context, ~10 k checks, no GPU).
Credits: `docs/CREDITS-scatter.md`.

## 1. Where it plugs into the terrain (findings)

| piece | what it is | use here |
|---|---|---|
| `_terrainCore(x,z,seed,ws)` -> `_groundField` -> `TERRAIN.Hg` / `TERRAIN.H` | one height function in the flat planet frame (metres, sea at 0). Same function drives the globe map, the SkyGround quadtree and the marching-cubes patch near the player | the ONLY terrain input: `ctx.H(x,z)`. Scatter never reads meshes, so it is stable under terrain LOD streaming and works on any terrain |
| `PW` / `_pwFrame` -> `_pwPropsTick(px,pz,agl)` | per-frame near-ground tick; streams 300 m `SURF_CHUNK` prop chunks round the LOD centre; hides above 220 m | one call at its end (`_scatterTick`, index.html) |
| planet frame (`PWF`, `_pwMapTag`) | curvature bend + reveal mask added to every material in the scene by `positionNode` | the scatter's pooled materials are tagged once; their wind `positionNode` is the base the bend wraps, so wind and curvature compose |
| `DMBudget` (`props` stage, `fast()`), `DMLod.tier` | frame-time ladder, device class (`low` / `mobile` / `desktop`) | tier choice and run-time pressure (below) |
| `TERRAIN.style`, `TERRAIN.pal.ground` | world style (`lush`, `mesa`, `dunes`, `ice`, ...) and ground colour | `biomeFor(style, groundHex)` picks the biome |

Cheapest integration = a self-contained module with its own chunk stream keyed to the same 300 m grid, driven by a single call from the existing props tick, parenting its pooled meshes to `TERRAIN.group`. It does not touch the existing prop generator, except: with `?scatter=1` and a biome that has tree entries, the old near-tree block in `_hmChunkScatterG` is skipped so trees are not doubled. The far canopy (`_farCanopyTick`) is unchanged.
Rejected: adding scatter instances into the existing per-chunk groups (one InstancedMesh set per chunk x entry x LOD = hundreds of draw calls on a Mali tablet) and compute placement (not needed: placement is cheap, time-sliced and cached; a WebGPU-compute variant would have to read back counts for LOD binning anyway).

## 2. Biome format (JSON)

```json
{ "id": "temperate-forest", "name": "...", "version": 1, "seed": "optional string (default = id)",
  "entries": [{
    "id": "conifer", "kind": "tree|bush|grass|flower|rock|cactus",
    "density": 0.005,                  // plants per m2 at full mask weight
    "scale": [0.8, 1.5], "scaleBias": 1.4, "yScale": [1, 1], "sink": 0.15, "tintVar": 0.15,
    "jitter": 0.85, "footprint": 1.1,  // jitter inside the cell 0..1; footprint = radius (m) per unit scale, for avoidance
    "maxPerChunk": 6000,               // candidate cap per 300 x 300 m (grass-like entries)
    "slope":       { "min": 0, "max": 30, "soft": 8 },      // degrees
    "elevation":   { "min": 6, "max": 70, "soft": 10 },     // metres above the sea (0)
    "waterDistance": { "min": 10, "soft": 14 },             // metres from the shore (saturates at 60)
    "noise":   { "scale": 170, "octaves": 3, "threshold": 0.52, "soft": 0.1, "seedOffset": 1, "invert": false },
    "cluster": { "radius": 26, "strength": 0.45, "occupancy": 0.7, "cell": 104 },
    "avoid":   [{ "entry": "conifer", "extra": 0.6 }],       // earlier entries only (priority order)
    "wind":    { "trunk": 1, "branch": 1, "leaf": 0.6 },    // per-layer multipliers
    "lod": [ { "mesh": "proc:conifer-0", "maxDist": 55 }, { "mesh": "proc:conifer-1", "maxDist": 130 },
             { "mesh": "proc:conifer-2", "maxDist": 280 }, { "card": "card:conifer", "maxDist": 520 } ] }] }
```

A range `{min,max,soft}` is a hard window with a smooth ramp of width `soft` inside each bound. Everything is validated (`DMBiomeScatter.core.validateBiome`) with explicit errors; `DMBiomeScatter.registerBiome(json)` adds a biome at run time (a file can be fetched and registered; no network code is in the module).

## 3. Placement: deterministic, stable under LOD streaming, non-destructive

* One candidate per square cell of side `1/sqrt(density x tierDensity)`, jittered inside the cell. Every random number is `hash(worldSeed, biomeSeed, entry, cellX, cellZ)`; there is no `Math.random` and no state. A cell always gives the same plant.
* A candidate belongs to the chunk box that contains its position, so chunk size, load order and which neighbours exist do not change anything. Tests: re-run identical; after streaming other chunks identical; two adjacent chunks == one box over both (no plant doubled or lost on a seam, including `avoid` across the border).
* Masks, cheapest first: noise -> cluster -> probabilistic thinning by the weight product (soft edges) -> coarse height grid (elevation prefilter, shore distance by chamfer distance transform, 10 / 15 m cells, 60 m margin) -> exact height + elevation -> exact slope (two extra height reads) -> avoidance (re-evaluates the earlier entry's own pure acceptance around the candidate, memoised). Cost at tier 0 is ~2.5 k height reads + a 1.8 k-cell grid per chunk, time-sliced at 2 ms (mobile) / 4 ms a frame like the existing prop generator.
* "Bake to manual": the resident chunk data is plain `Float32Array` records (`x,y,z,scale,yaw,tint,sy,rank`, stride 8), so exporting a region to a list of instances is a copy; the procedural recipe stays the source of truth (non-destructive).
* "Same biome on many terrains": a biome only needs a height function and a sea level; it is selected per world by `biomeFor(style, groundHex)` or `?scatterbiome=`.

## 4. Draw model, LOD, culling

* One pooled `InstancedMesh` per (entry, LOD level), fixed capacity (>= 2048, so three keeps its instanced-attribute path; a count baked into a uniform array would force a pipeline rebuild), never reallocated. Draw calls <= entries x 4 (tier 0: one per entry; the starter forest at tier 0 draws 4).
* Resident chunks hold the instances; a **re-bin** (every 120-330 ms, only when the camera moved > 4 m / turned, a chunk arrived or the budget changed) walks chunks nearest-first, drops instances outside a conservative horizontal view wedge (always keeps anything within 24 m) and past the entry's last distance, picks the LOD level by 3-D distance (`lod[].maxDist`, with the tier / pressure multipliers), writes matrices + tint straight into the pooled buffers and sets `mesh.count`. The GPU only ever sees visible, correctly-levelled instances. The last 12 % of an entry's range shrinks the plant to zero instead of popping.
* LOD0-3 per entry: tier 3 uses all four, tier 2 skips LOD0, tier 1 uses LOD2 + card, tier 0 uses only the crossed-card impostor (procedural alpha silhouette in TSL, no texture, 4 triangles).
* No shadow casting; shadows are received only on tier >= 2 meshes (not cards). No colliders in v1.
* The layer hides above 260 m (the far canopy / map take over).

## 5. Wind (TSL, three layers; `?scatterwind=0` off)

Vertex attribute `wind = (trunk, branch, leaf)` weights per vertex (authored by the placeholder generators; the future pipeline exports the same attribute). `positionNode` adds, on top of the instanced position:
1. **trunk sway**: slow lean downwind + slow oscillation, weight ~ height^2, amplitude 0.35 m;
2. **branch gust**: a gust field travelling with the wind (two sines of world position / time), mid frequency, along + across the wind, amplitude 0.28 m;
3. **leaf flutter**: fast per-vertex jitter from the geometry position, scaled by the gust, amplitude 0.06 m.
Per-entry multipliers (`wind.trunk/branch/leaf`), global strength / direction uniforms drift slowly. Tier 0 runs layers 1 and half of 2 (cards), tier 1 adds a half-strength layer 3, tiers 2-3 run all. Uniform writes only; no recompile.

## 6. Budget tiers and run-time pressure

| tier | who | LOD levels | density x | distance x | ring (chunks) | instances cap |
|---|---|---|---|---|---|---|
| 0 phone | `DMLod.tier` `low` / `mobile` (phones AND tablets) | cards only | 0.40 | 0.65 | 1 | 3000 |
| 1 tablet | `?scattertier=1` | LOD2 + card | 0.60 | 0.80 | 2 | 6000 |
| 2 desktop | `desktop` | LOD1-3 | 1.0 | 1.0 | 2 | 24000 |
| 3 high | desktop + `ultra` | LOD0-3 | 1.0 | 1.15 | 3 | 48000 |

`DMBudget` `props` level (0..2) plus 1 when the fast guard is up gives `dyn` 0..3: density x [1, .7, .45, .25] by **rank** (each instance carries a fixed random rank, so the kept set is a nested subset and nothing is regenerated), distance x [1, .85, .7, .5], and the cheapest allowed LOD moves up by 0 / 0 / 1 / 2. Caps are enforced in the re-bin (nearest first). `?scattertier=N` forces a tier.

## 7. Flags and debugging

`?scatter=1` on . `?scatterbiome=meadow|dry-desert|temperate-forest` . `?scattertier=0..3` . `?scatterwind=0` . `?scatterhud=1` (stats JSON to the console every 20 re-bins) . `DMBiomeScatter.stats()` . a failing tick switches scatter off for the visit and warns once (never breaks the frame loop).

## 8. Future asset pipeline: Blender -> GLB with LODs -> game

1. **Model** each plant in Blender at real size (1 unit = 1 m), origin at the ground contact point, +Y up on export. Name the objects `<plant>_LOD0`, `_LOD1`, `_LOD2`; the card is `<plant>_CARD` (a crossed quad or one quad with an alpha-tested texture baked from LOD0).
2. **Wind weights**: paint three vertex-colour layers (or one RGB layer) = trunk / branch / leaf stiffness 0..1 (trunk grows with height; branches from the crown base; leaf = outer leaves). Export as glTF vertex colours and map `COLOR_1` -> the `wind` attribute (the loader step renames it).
3. **Budgets**: LOD0 <= 900 tris, LOD1 <= 330, LOD2 <= 130, card 4 (what `biome-scatter-glue.mjs` asserts for the placeholders; the same assertion can gate real assets). Share one material / atlas per plant so every (entry, level) stays one draw call.
4. **Export** one GLB per plant (all LODs as separate meshes) -> `assets/scatter/<plant>.glb`. Atlas textures as KTX2 if used.
5. **Register**: a small loader (to write) walks the GLB, builds a `BufferGeometry` per LOD and calls `DMBiomeScatter.registerMesh('glb:oak/lod1', () => geometry)`; the biome JSON then names `glb:oak/lod0` ... instead of `proc:*`. Biome JSON files live in `assets/biomes/*.json` and are fetched + `registerBiome`d on world entry.
6. **Optional bake**: a Blender-side exporter of a region's instances (positions from the same hash cells) lets a level designer move individual plants; manual instances would be a second per-chunk list merged before the re-bin.
7. **Licensing**: only assets the project owns or CC0 (Poly Haven) go in; credit in `docs/CREDITS-scatter.md` and the in-game list.

## 9. Not done / untested on a device

* Nothing has been rendered: the sandbox has no GPU. Untested on the Mali-G615 tablet and iPhone: real frame cost of the pooled draws, the wind / card-alpha shaders actually compiling on WebGPU (the node graphs construct and the meshes / materials are built in node, but nothing is compiled), the look of the procedural placeholders, the planet-frame bend on the instanced wind positions, the fixed-capacity instanced-attribute path and partial buffer uploads (`addUpdateRange`, only the used part: a few hundred KB per re-bin at tier 0-2) through three's interleaved-matrix sync, chunk-generation hitching under real Mali timings.
* Per-instance trunk sway ignores instance scale (amplitude is in metres); fine for placeholders, revisit with assets.
* No shadows from scatter, no colliders, no collision with the existing rocks (rocks and scatter can overlap), the far canopy still draws its own trees beyond the near ring, no night / lighting tuning, no per-biome blending between regions (one biome per world visit).
* Tier 0 shows flat crossed cards at all distances including close up; if that looks wrong on device, allow LOD2 for `kind: grass|bush` within ~10 m.
