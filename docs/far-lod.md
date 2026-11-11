# Far-range level of detail

> **Planet cloud shell removed (sw v315).** The white, swirling, visibly repeating layer over every world's terrain (and the white glaze from orbit) was `DMMist.planetClouds` (`ui/dm-mist.js`): a ray-marched noise-cloud sphere at 1.004-1.024 R added to every atmosphere-bearing world (Earth/Venus/Mars/Titan looks, the white one being Earth's). It is deleted with its materials, per-frame update and precompile/warm step. Terrain, its LOD, the volumetric atmosphere (`ui/dm-atmo.js`), foliage and asteroid fumes are untouched.

## CURRENT DEFAULT (sw v309): the classic LOD
The Nov 5 far-range work (sw v277-v289) read worse than the LOD before it: a drawn radius that opened and closed from a vantage, outer prop rings that streamed in late, a chunk fade-in, relief-driven tile splits (more tile builds), a mip bias that softened the distance, a mansion impostor level.  The default is now the table that shipped **before** it; the Nov 5 set stays in the code as a second table, off unless `?lodfar=1`.

| | classic (default) | `?lodfar=1` (Nov 5) |
|---|---|---|
| prop draw cut | old formula: min(fog x 1.05, agl > 60 ? fog x .85 : 1400) x ladder | 700 / 1000 / 1400 cap, error-driven (px size of a 1.0-1.4 m prop) |
| prop streaming | the 3x3 chunks round you, keep set = load set | rings 1 / 2 / 3 (pre-roll on the heavy gate), keep set one wider |
| prop chunk appearance | shown by `_propsLod` | screen-door fade-in (`prop.fadeS`) |
| prop shadows | 110 (phones) / 170 | 90 / 110 / 170 |
| mansion cull / landmarks | 5200 / 6000 all classes | 4200 / 5200, 4800 / 6000 |
| vantage draw radius + haze | none (walking radius only) | 1.8 / 2.8 / 4.5 km eased by `_vtK` |
| ground tile split | distance only (`K` x size) | + relief boost up to x1.7 |
| texture mip bias at the far end of a band | 0 | 1.0 / 0.8 / 0.5 |
| mansion impostor (LOD2) | not built | built on the heavy gate, error-driven switch |

Kept in both (not behind the flag): the SkyGround budget gate / settle / allocation work, queue-not-drop in sparsevox, the radial `_skyGroundFade` horizon dissolve (`?skyfade=0` turns it off), the radial sparsevox node metric (`?svmetric=box` is the old box metric), the conservative prop-chunk wedge cull (`?lodcull=0` off; fewer draw calls, no visual change), the mansion screen-size fade and LOD0/LOD1 cross-fade, the fov-fill quality chain (its prop band uses the loaded 3x3's reach in classic).  The SkyGround quadtree measures from the tile centre (`_measure`), so its shells are already circles; there are no tile/box debug overlays in the LOD code (the square shore/sea markers were removed in #253).

`?farbump=1` (default off, shader only): a **directed degradation** tier for the ground - past the bump's reach the far macro field (the 60 u / 260 u noises the far tint already evaluates) also tilts the shading normal by its screen-space gradient (Mikkelsen bump from `dFdx/dFdy`, the pattern of the board material), so a coarse far tile keeps a lit relief instead of going flat.  No geometry, no extra noise taps.  Unverified on a GPU, hence the flag.

From nanite-webgpu (MIT) only efficiency ideas are used: per-instance conservative frustum culling (the chunk wedge cull) and screen-space-error selection (far set only).  Its software rasterizer / meshlet visuals are not used.

---

# Far-range level of detail (sw v280)

Goal: the highest detail near you, a graceful decay with distance, no pop-in, no missing faces; from the mansion deck a far cliff still reads, and up close it has the fine texture. Frame rate first: a steady 30 fps on every preset and device (v297: `ui/dm-budget.js` sheds under ~27.8 fps, 36 ms; legacy devices with <= 3 GB memory keep the 15 fps floor, 68 ms); `ui/dm-budget.js` and `ui/dm-governor.js` stay the authority.

## One table: `ui/dm-lod.js`
Device class (same test as the budget's `classBase`): `low` (low GPU / score < 55 / <= 3 GB), `mobile`, `desktop`. `?lod=low|mobile|desktop` forces one, `?lod=off` returns every caller to its old constant. Pure core (`DMLod.core`, node-tested) plus a thin glue that applies the ladder: prop distances x `DMBudget.propsK()`, the vantage extension x `DMBudget.groundReach()`.

| key | low | mobile | desktop | used by |
|---|---|---|---|---|
| prop.cutMax / cutMin | 700 / 260 | 1000 / 260 | 1400 / 260 | `_propsLod` chunk draw cut (still bounded by 1.05 x fog) |
| prop.shadow | 90 | 110 | 170 | chunks that cast into the sun map |
| prop.ring (chunks) | 1 | 2 | 3 | prop streaming radius ceiling |
| mansion.in / out / far | 300/360/4200 | 300/360/5200 | 400/470/5200 | LOD1<->LOD0 hysteresis, cull (4 % hysteresis) |
| facility.cull | 4800 | 6000 | 6000 | other landmarks |
| vantage.reach | 1800 | 2800 | 4500 | draw radius from a high vantage (walk radius floor 1200) |
| water.minH | 4 | 4 | 4 | no prop below this height (water worlds) |

Desktop values equal the previous hard-coded numbers (test: `propCut` == the old formula), so nothing changes there except what is listed below.

## What changed behaviourally
1. **Props never pop inside the haze.** Chunks stream in rings, `ring = ceil(cut x 1.06 / 300 m)` (capped by class and by the ladder's props stage), nearest chunk first, so a chunk is built while its nearest rock is still beyond the draw cut (fully fogged). New chunks start hidden and are shown by `_propsLod` (they used to show for up to 6 frames before the first LOD pass). The keep set is one ring wider than the load set, so walking over a chunk border does not drop and rebuild the chunk behind you. Colliders (`DMCollide.regChunk`) are registered only for chunks within one chunk of the walker.
2. **No props in the ocean.** The shore margin comes from the table; a rock/tree candidate near the shore also needs dry ground 4 m to each side (the old test let a rim half in the surf stay).
3. **Far view from a vantage.** `b562b33` thinned the haze but capped the drawn radius at 1080 m. Now the walking draw radius (`walkR`, which sizes the geomorphing quadtree's `viewR`) opens, eased by the existing `_vtK`, toward `vantage.reach` (1.8 / 2.8 / 4.5 km); the haze far distance opens toward 0.62 x reach but never past 0.92 x the drawn radius. The far ring is drawn by the existing coarse tiles (skirted, geomorphed), i.e. it costs tiles, not detail. The ladder's ground stage scales the extension (x1 / .8 / .6).
4. Mansion LOD0/LOD1 enter/leave and the cull, and the landmark cull, read the table (same numbers as before on phone and desktop; low class is a little shorter).

## Part 2 (sw v280): cross-fade, impostor, mips, error-driven LOD, culling
- **Screen-door cross-fade without per-object materials.** Every planet material already has a `maskNode` (the planet-reveal dither, a discard on interleaved-gradient noise). `DMLod.fadeMask(root)` ANDs one more test into it: the pixel survives when the noise falls inside the object's interval `[lo, hi)` read from `object.userData.dmFade` through a per-object uniform node (`onObjectUpdate`, the pattern three uses for `modelNormalMatrix`). Levels get complementary intervals (`createXfade`: weights always sum to exactly 1, also when the target changes mid-fade), so a pixel is drawn by one level: no hole, no double layer, no sorting, no new discard, no per-chunk or per-LOD material. Mobile and desktop use the same path. `?lodfade=0` snaps as before.
- **Mansion: LOD0 / LOD1 / impostor.** `ui/dm-impostor.js` merges the LOD1 geometry into one mesh and re-meshes it by vertex clustering (grid cell x normal octant, so thin walls and cliff tops/fronts stay separate), with the base-colour map sampled into vertex colours: one draw call, 1.6 / 2.6 / 4.2 k triangles (low / mobile / desktop), built once on the `F.heavy` queue, pipeline pre-compiled off to the side. LOD1 -> impostor switches where the impostor's own error (its cell) projects to `lod.tauPx` pixels (`DMLod.lod2Dist`: follows render scale, fov and the budget ladder; clamped to 1.5 x LOD0-leave .. 0.9 x cull; hysteresis 8 %). LOD0 <-> LOD1 stays distance + hysteresis (the interior is tied to it).
- **Props.** A newly shown chunk fades in over `prop.fadeS` through the same mask (three shared prop materials, no per-chunk material). Outer pre-roll rings (more than one chunk from you) are built one chunk per step on the `F.heavy` serial gate; the inner 3x3 still streams inline. Chunks outside a conservative horizontal wedge of the camera are not drawn (`chunkCulled`, flat frame; the planet frame had switched three's frustum culling off for them). `?lodcull=0` off.
- **Mips.** Ground atlas and parallax taps add `mip.bias` mips (1.0 / 0.8 / 0.5) toward the far end of their detail band, so the tile detail averages out instead of shimmering as it fades. Cliff / mansion GLB maps are sampled with hardware derivatives (trilinear + anisotropy 4 / 8) and were left alone.
- **From nanite-webgpu (MIT, credited in CREDITS.md; no code copied):** error-in-pixels LOD selection (`projErrPx`, `errDist`, `levelByError`, used for the impostor switch); the 12-view billboard selector and dither weight (`billboardViews`, `billboardPx`, `billboard.px`) as tested groundwork; nothing of the software rasterizer / `atomic<u64>` (0.36 fps on the Mali tablet).

### Answers to the open questions
- **GPU instance culling + previous-frame depth pyramid:** not built. The prop scene has a few hundred instances in 25-49 chunks, so a compute cull + readback/indirect draw costs more than it saves, and a hi-Z pyramid needs a depth copy per frame (the tablet is fill-bound). The chunk wedge test above takes the CPU share for free. Where it could pay: far impostor *fields* (thousands of trees); revisit then, gated to real WebGPU and the budget ladder.
- **Can the pyramid double as an occlusion source for parallax / ocean?** Not usefully. Parallax and the ocean are per-pixel work behind the hardware depth test; the ocean already reads the scene depth copy (`viewportDepthTexture`) for its contact foam, and a coarse mip would only add a conservative per-tile early-out for the march, which the existing near/far fade bands already cover. Not implemented.
- **Meshlet / cluster LOD from meshoptimizer, baked in tools/:** not done. The impostor above is a runtime-clustered level with a known error; a proper offline chain (meshopt simplify + error per level, packed in the GLB) for the cliff and mansion needs a bake step in `tools/` and an asset re-export, which is the cliff/mansion lane's pipeline. `levelByError` already takes such a chain.
- **Billboards for props / Bird Temple:** the selector and tests are in; the view baker (render 12 views to an atlas) and the atlas material are not, since they are untestable shader code here.

## Part 3 (sw v289)
- **Relief-aware ground tiles (ordinary terrain cliffs / coast scarps).** A far ground tile that holds relief splits farther out (`DMLod.reliefBoost`, up to x1.7 by class 0.4 / 0.7 / 1.0 and the ladder's ground stage, 12 % hysteresis for finished splits), so a drop keeps its edge at range instead of becoming a 50 m ramp. A height field still cannot hold a true overhang: those exist only in the near marching-cubes patch.
- **Prop chunk cut and pre-roll ring are error-driven** (`propCutErr`): the fog-bound cut is capped where a typical prop (1.0-1.4 m) projects to 1.4-2.2 px, so a smaller drawing buffer or a narrower view draws fewer chunks and streams fewer rings.
- **`tools/lod-chain/bake.mjs`** (offline; meshoptimizer MIT + gltf-transform): adds `<node>_E<k>` siblings sharing the source vertex buffers with shorter index buffers and `extras.dmError` (metres). Run on `ariel-home-512.glb` LOD1 (15,156 tris): 11.6k / 9.4k / 8.1k tris at 0.6 / 1.6 / 4.0 m. NOT shipped and NOT consumed at runtime yet (no re-exported GLB, no visual check); `levelByError` is the intended selector.
- **Billboard baker: deliberately not built.** Rocks are 36-tri dodecahedra and trees ~24 tris, drawn as 3 instanced meshes per chunk: billboards would not be cheaper. It only pays for high-poly props (Bird Temple, places).

## Tests
`node tools/tests/lod-unit.js` — table validity, class monotonicity, `propCut` equals the legacy formula, ring bounds (a chunk entering the wanted set is >= cut x hysteresis away), hysteresis has no flip-flop under jitter and exactly two transitions out and back, `fade` shape, vantage monotone in vt / ladder / class and never below the walk radius, glue class detection and ladder scaling in a sandbox.

## Not done / unverified (no headless GPU in this lane)
- **Nothing here was run in a browser.** Syntax-checked and the pure maths tested (`tools/tests/lod-unit.js`, 70k checks). Unverified on a GPU: the fade-mask shader graph (a compile error would show as the mansion / props missing; `?lodfade=0` returns to snapping), the impostor colour bake (texture sampling through a canvas), the one-time recompile of the 12 mansion + 3 prop materials when the mask is wrapped, the frame cost of the pre-roll rings and of the vantage tiles on Mali-G615 / A18.
- Baked distant cliff impostors for terrain (overhang faces a height field cannot hold) are not implemented: only the mansion + its cliff have an impostor.
- Texture mip bias for the cliff / mansion GLB maps is not applied (hardware mips + anisotropy only).
