# Renderer memory lane (sw v292+)

Static estimates only (`node tools/mem-estimate.js`, tested by `tools/tests/mem-unit.js`). Nothing here was measured in a browser. The model assumes everything listed is resident at once, so absolute totals are higher than the logged 920 MB; trust the per-row savings more than the percentages.

## Before / after (MB, gpu+cpu), from the estimator
| Allocation | Tablet High before | after | Cut |
|---|---|---|---|
| Start-button turntable (2nd WebGPU device, latedecemberSG.glb 2.4M verts) | 269 | 0 | disposed 4 s after leaving the menu (handhelds) |
| Sparse-voxel LOD pools (2 bodies x cap 512) | 199 | 99 | 1 resident body on handhelds |
| Bird Temple Interior textures (28 images) | 113 | 17 | fit 512 px, bitmaps closed after upload |
| Mansion GLB textures (phone GLB) | 168 | 63 | re-encoded true 512 px |
| Cliff rock sets 1K | 85 | 21 | 512 unless deviceMemory >= 8 |
| Galaxy map MSAA buffer | 89 | 0 | parked 1x1 15 s after close |
| Builder MSAA buffer | 108 | 0 | parked when screen left |
| Earth decode scratch | 16 | 0 | bitmap closed (all tiers) |
Totals: tablet High 1402 -> 556 (-60%), conservative (map/builder never opened) -54%, iPhone Medium -53%, desktop unchanged except the 16 MB Earth scratch.
Leak fixes: LOD cross-fade disposes the old level's own textures; world close disposes node-held textures (three r185 info keeps a strong Map, so undisposed textures never GC).

## Left / next steps
- Biggest remaining: Bird Temple Interior geometry 140 MB (gpu+cpu, tangents included), BT PBR sets 64 MB, flight canvas + atmosphere pass ~78 MB, LOD pool 99 MB, shadows 32 MB.
- LOD/MC storage vec3 buffers cannot drop their CPU arrays (same attribute is the vertex buffer; three reads `.array` when building pipelines). Real fix: pack colour to one u32 and normal to snorm, or use vec4 attributes.
- Idea: BT interior lazy-load until the player nears the temple; decimate latedecemberSG.glb (2.4M verts for a 140 px button); KTX2/BC for BT/cliff sets; half-float/R8 for height maps.
- Verify with `?perf` logs: `census.mem.info` and `census.mem.dmmem` now report renderer split and DMMem counters.
- Unverified: turntable re-init on menu return, park/unpark on real WebGPU, 512 mansion look, shrink + dispose/re-upload path.
