# JOTS Cliffs (sw v302): cliffside mansion rock + terrain cliffs round the site

Cache versions: `sw.js` dartmeadow-engine-v302, `index.html` dm-facilities.js?v=302, `ui/dm-facilities.js` F.ver 302 (main 69a9ff4, Worlds #254, is sw v301;
this branch merges main through #253 and #254 with normal merges, no rebase or force-push; the cache key is main + 1 at push time). The file keeps its v298 name to avoid churn; v298 below refers to the first #249 sweep only.
Worlds #253 is kept intact: FOV-to-horizon fill, square shore/sea markers hidden, deck infinity-pool restyle, `F.poolTrim` a no-op, `lodTint` / mid-grain in
`_terrainDetailMat` (colorNode multiplies cliffTint * basinTint * lodTint).

## Shard-rock pass (ships as sw v302, merged with main 69a9ff4 / Worlds #254 sw v301)
Direction (Justin): the cliffs around the mansion are a rock structure of **straight angular shards**. Real-world habit only: geode / cave crystal-shard clusters,
dogtooth spar, columnar basalt (Giant's Causeway, Devils Tower), cleaved slate / granite joint faces, rebuilt as **opaque weathered rock, not crystal** (no
transmission, no gem colour, no emissive, roughness >= 0.6). Exodus *Liberating the Kay* is a quality bar only (lighting, facet language, groove shadow density,
read at character scale): no geometry, texture, layout or asset was copied, and no Exodus or live screenshot is committed.

| | main fb70e22 | #249 head bcf5f27 (v298 sweep) | **shard pass** |
|---|---|---|---|
| LOD0 rock tris desktop (`ariel-home.glb`) | 75.4k (LOD0 90.6k) | 233.1k (LOD0 248.3k) | **211.4k** (LOD0 226.6k) |
| LOD0 rock verts desktop (split normals on shard edges) | 42.8k | 127.9k | 137.6k |
| LOD0 rock tris phone (`ariel-home-512.glb`) | 30.9k | 69.7k | 68.6k |
| LOD1 rock tris (impostor source) | 4.2k | 9.9k | 9.9k (same grid, full macro shard layer) |
| desktop GLB / phone GLB | 5.79 / 3.93 MB | 11.13 / 5.25 MB | **10.74 / 5.64 MB** |
| hi face spacing median rows / cols (core upper wall) | | 0.67 / 0.80 (0.53 / 0.65) u | 0.65 / 0.78 (0.49 / 0.60) u |

- `tools/ariel-home/cliff_mesh.py`: the organic fabric (wavy beds, buttress ribs, gullies, shelves, exfoliation domes, fbm roughness) is replaced by two
  piecewise-planar shard layers. **Macro shards** (every tier, so LOD1 / the runtime impostor stay angular): vertical slots 4.5-15 u, stacked into 5-18 u tiles by
  straight sloped cleavage cuts (linear 1.2-3 u chamfers); every tile is a **world plane** anchored on the sweep (yawed / pitched, -1.8..+2 u proud), often a prism
  (two planes on a vertical ridge), V-grooves on some seams. **Fine splinters** (hi, mob at 60 %, not LOD1): 0.9-3.4 u vertical splinters, 8-30 u long, stepped
  +-0.55 u. **Talus**: angular planar blocks over planar scree cones. Slot seams are vertical lines in x, the grid columns are too, so every seam / ridge / groove
  sits on a column: crisp at any tier, no zig-zag. Only the rows are [1 2 1]-filtered (not across columns); fold-over guard now ignores the shard side faces
  (60-85 deg by design) and only fixes real flips (686 -> 0 hi, 113 -> 0 mob, 8 -> 0 lod1; the sweep's own 96 degenerate carve-wall quads are untouched).
  Lip guard: within z > -6 nothing rises above the plateau and recesses are capped at 0.8 u at the lip. UV u = world x (straight vertical grain), v = macro arclength.
  Tiers: hi rows 226 -> 196, core_ds 0.5 -> 0.58, far 5 -> 8 (plateau / sea floor), far_x 6 -> 3.2 (the shoreline flanks seen from the decks now carry whole
  shards); mob rows 132 -> 124, ds 1.1 -> 1.15, core_ds 0.9 -> 0.95, far 7 -> 9, far_x 8 -> 5, fine 0.5 -> 0.6.
- `tools/ariel-home/build_mansion.py`: face profile (d > 0 only) loses the sawtooth "strata steps" below the first band and 70 % of the ridged jag away from the
  lip; the lip band keeps the v298 profile, clamped so it never rises above the rounded plateau lip (that rim bump varied per column and sheared the rows: the
  chevron band at x ~ +100..115 is gone). Plateau, carves, sea floor, `edge_y` unchanged; the lamp plan (`plan_lamps.js` on the new collision) is byte-identical.
  Rock shading: smooth inside a facet, sharp edges > 28 deg (`set_sharp_from_angle`), so seam side faces do not shade as rounded bevels.
- `tools/ariel-home/gen_cliff_textures.py`: set names / material slots unchanged, content rebuilt in the shard language: `strata` = cleaved slab faces (straight
  vertical slabs at offset depths, tilted planar facets, sloped cleavage cuts with chamfers, 130 tight straight vertical grooves, pale chipped proud edges),
  `columnar` = angular prism shards (two facets on a ridge, deep V seams), `sheet` = joint-face pavement (planar plates on straight joints) for the plateau /
  benches, `talus` = angular blocks. Domain warp cut from 10-30 px to 1.5-3 px so lines stay straight. Still 3 m tiles, 512 / 1K / 2K, no 4K, same phone gates.
- `index.html` terrain `cliff()`: cleavage beds are near-planar dipping slabs (fixed dip + 25 % of the warp) instead of wandering graded lines; caps get a crisp
  chamfered foot, recessed beds one planar slope (no laminae); joints are tall worley prisms (crisp seam on each straight cell border + a linear facet rise).
  Same noise evaluations per call; no W.pow; boulder scatter untouched.
- Rebuilt with `rebuild_all.sh` (Blender 4.2.9): both GLBs, collision (same 2 u top-down grid, reproducible byte-for-byte across two builds), interior GLBs
  (COLOR_0 only), lamps + nav unchanged, GI re-baked (573 s, gain 1.5176, mean irradiance 0.15501).
- Renders (Cycles CPU, 16 spp, `cliffs-v298-shard-before-after.jpg`: base / #249 head / shard pass; `cliffs-v298-shard-clay-lod1.jpg`: untextured geometry + LOD1;
  `cliffs-v298-shard-textures.jpg`: the four sets). Nothing measured on a GPU or in a browser; no fps claims.
- Risks: the terrain `cliff()` change is syntax-checked only (no GPU here). A few cliff-edge collision cells at the far flanks / x ~ +110..136 now hit the face
  0.5-1 cell further out (edge cells, not paths); the inland embankment (y ~ -90) is ~0.4 u lower (shards there too). Phone GLB +0.39 MB from split normals.
  Overhangs are still not solid. Residual soft spots: where a tile's plane leaves the sweep by > 3.4 u it falls back to a relative facet (2 % of the face).

## v298 sweep (the first #249 pass, kept for reference)

Scope: Ariel's mansion cliff (GLB LOD0 / phone LOD0 / LOD1, the runtime impostor built from LOD1), its collision grid and the interior GI that uses the exterior
as occluder, the cliff PBR sets, and the procedural terrain cliff shader (index.html `cliff()`) so the planet cliffs round the site match the mansion rock.
Units: mansion / scene units (1.78 u = 1 m, `ariel-home-lamps.json` upm). References: Zion / Dolomites / Yosemite / Giant's Causeway (real formations only;
nothing was copied from any game, Exodus is a quality bar only). All geometry and textures are procedural (Blender 4.2.9 LTS headless + numpy).

## Measured (tools/ariel-home/measure_density.py, cliff_mesh dumps)
| | main 29456d8 | v298 |
|---|---|---|
| hi face spacing, median rows / cols | 0.98 / 1.54 u | 0.67 / 0.80 u |
| hi core upper wall (x -95..105, z > -22: decks, landing, facility) | 1.03 / 1.20 u | **0.53 / 0.65 u** |
| refined ground next to her (TESS_TIER high / ultra) | 0.45 / 0.40 u | (unchanged, the target) |
| displacement range D | -2.2 .. 2.4 u | -3.2 .. 3.6 u (buttress ribs, thicker shelves, broad bulges) |
| LOD0 rock tris desktop (`ariel-home.glb`) | 75.4k (LOD0 total 91.6k) | **233.1k** (LOD0 total 249k) |
| LOD0 rock tris phone (`ariel-home-512.glb`) | ~31k | 69.7k (LOD0 total 85.9k) |
| LOD1 rock tris (dx 5 -> 3.2, 36 -> 58 rows, full macro relief) | 4.2k (LOD1 16.1k) | 9.9k (LOD1 21.8k) |
| desktop GLB / phone GLB | 5.79 MB / 3.93 MB | **11.13 MB** / 5.25 MB |

Texel density (base colour, px per u): cliff 2K 683 nominal (measured 147-167 on the embedded 512 = x4), 1K 341, 512 171; mansion 2K concrete 512, slate 504,
wood 674, dark 1016; ground atlas 43-114 (tile 4 u, 96-256 texels); Ariel 6-8k (a character, not a comparable target). The cliff maps already out-resolve the ground
and match the mansion, so no 4K: the gaps were mesh density, macro relief and 3 m tiling.

## What changed
- `tools/ariel-home/cliff_mesh.py`: core frontage tier (0.5 u columns in x -95..105, 0.5 u rows on the upper wall, same density in every column so rows don't
  shear); macro relief split from the fine fabric (buttress ribs 1.5-3.4 u, recesses, bulges, thicker caps / deeper undercuts) and kept at full strength in LOD1;
  planar fracture facets at the fine tier; continuous exfoliation terraces (the old floor() step became chevrons at 0.5 u); fabric box-filtered per cell;
  displacement along the macro normal with most of its vertical part removed on walls; shear-aware smoothing; fold-over guard; UV v from the macro profile.
- `tools/ariel-home/gen_cliff_textures.py`: granite sheet set rebuilt (3 spalled shells, crisp risers only where spalled, biotite / K-feldspar grain, no lone contour
  line); a detail-normal layer (1.5-6 mm grain, normal map only, the POM height is unchanged) on all four sets. Columnar / strata / talus colour + height are
  byte-identical (deterministic generator).
- Rebuilt with `tools/ariel-home/rebuild_all.sh`: both exterior GLBs, `ariel-home-collide.json` (same 2 u top-down grid; overhangs are still not solid, as before),
  interior GLBs (one vertex colour differs), lamps + nav unchanged, GI re-baked (`bake_gi.js` defaults: 626 s, gain 1.52181, mean irradiance 0.15504).
- `index.html` terrain `cliff()`: hard / soft beds per bed hash (caps proud with chamfered foot, soft beds recessed with laminae) instead of one even ledge rhythm,
  and the fracture term is a vertical joint network (F2-F1 borders of tall worley cells) instead of dots at the cell centres. Same noise count per call.
  The boulder scatter (index.html ~25494) is untouched (it would change prop RNG streams).
- `ui/dm-facilities.js` F.ver 292 -> 298 (asset cache key), `index.html` dm-facilities.js?v=298, `sw.js` dartmeadow-engine-v298 at the time; now superseded by v302 (see top).
- `tools/tests/mansion-cycle.js`: sandbox `location` stub (the test threw on main before any check).

## Not done / risks
- **Desktop GLB 11.1 MB and LOD0 rock ~233k tris (3.1x)**: a 30 fps / memory risk on low-tier desktops; check in Watcher / device runs. Phones load the 512 GLB
  (69.7k rock tris). Easy fallback: lower `TIERS['hi']` (core_dx / core_ds) and re-run `rebuild_all.sh`.
- KTX2 / BC for phones deferred; phones keep the existing gates (512 maps unless deviceMemory >= 8 etc.).
- The impostor is still the runtime vertex-cluster built from the new LOD1; `tools/lod-chain/bake.mjs` is not consumed.
- Residual zig-zag at a few lips / one flank band (x ~ +105..120) where the macro profile itself is sheared by the deck carves (also on main, finer now).
- Nothing was run on a GPU or in a browser: Cycles CPU renders only (`cliffs-v298-before-after.jpg`, mesh final, textures pre-regeneration; `cliffs-v298-textures.jpg`).
  No fps measured.
