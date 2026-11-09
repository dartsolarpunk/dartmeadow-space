# JOTS Cliffs (sw v296): cliffside mansion rock + terrain cliffs round the site

Scope: Ariel's mansion cliff (GLB LOD0 / phone LOD0 / LOD1, the runtime impostor built from LOD1), its collision grid and the interior GI that uses the exterior
as occluder, the cliff PBR sets, and the procedural terrain cliff shader (index.html `cliff()`) so the planet cliffs round the site match the mansion rock.
Units: mansion / scene units (1.78 u = 1 m, `ariel-home-lamps.json` upm). References: Zion / Dolomites / Yosemite / Giant's Causeway (real formations only;
nothing was copied from any game, Exodus is a quality bar only). All geometry and textures are procedural (Blender 4.2.9 LTS headless + numpy).

## Measured (tools/ariel-home/measure_density.py, cliff_mesh dumps)
| | main 29456d8 | v296 |
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
- `ui/dm-facilities.js` F.ver 292 -> 296 (asset cache key), `index.html` dm-facilities.js?v=296, `sw.js` dartmeadow-engine-v296.
- `tools/tests/mansion-cycle.js`: sandbox `location` stub (the test threw on main before any check).

## Not done / risks
- **Desktop GLB 11.1 MB and LOD0 rock ~233k tris (3.1x)**: a 30 fps / memory risk on low-tier desktops; check in Watcher / device runs. Phones load the 512 GLB
  (69.7k rock tris). Easy fallback: lower `TIERS['hi']` (core_dx / core_ds) and re-run `rebuild_all.sh`.
- KTX2 / BC for phones deferred; phones keep the existing gates (512 maps unless deviceMemory >= 8 etc.).
- The impostor is still the runtime vertex-cluster built from the new LOD1; `tools/lod-chain/bake.mjs` is not consumed.
- Residual zig-zag at a few lips / one flank band (x ~ +105..120) where the macro profile itself is sheared by the deck carves (also on main, finer now).
- Nothing was run on a GPU or in a browser: Cycles CPU renders only (`cliffs-v296-before-after.jpg`, mesh final, textures pre-regeneration; `cliffs-v296-textures.jpg`).
  No fps measured.
