# Arctic ice removal and mansion/planet scale (sw v290)

## 1. What the white streaky layer was
The "Arctic ice regions" of the earliest world-engine/Earth work. It lived in several places, all latitude driven, none a real cloud layer:
- `ui/dm-earth-ice.js` (`DMEarthIce`): Natural Earth glacier mask + `seaIce()` Arctic pack, fed into `DMEarthPaint` (CPU colour, TSL, ice texture), the map, the near patch and the CPU surface tiles. **Deleted.**
- `snowDrop` (snow line lowered by latitude, down to ~2 m at 80 deg, so the whole polar band went white with noise streaks) in: the near-patch TSL colour (`colorFor`), `surfaceBiomeColor`, `ui/dm-planet.js biome()`, the world map (`_wmLush`/dry branches). Replaced by a fixed altitude snow line.
- Hard polar caps: `la>78` / `la>72` snow in the map, `|lat|>78` + fbm cap and Mars `marsIce` in the WebGL fallback planet texture. Removed.
- The far marching-cube LOD colour (`_colorAt`) weighted peak snow by latitude (0.55+0.45*lat); now altitude only.
Kept on purpose: altitude (mountain) snow, the per-planet `ice` world style (`ui/dm-worldstyle.js`, ground library `snowCrust`), snow/rain particles, real atmospheric clouds, water. No dead flags remain; `lod-unit` greps the source so the generator cannot return unnoticed. A new Arctic system is to be designed later.
Side effect: Earth no longer shows Antarctica/Greenland white (same module); expected until the new system exists.

## 2. Scale
Every world's walking sphere is `360 deg / ATMO_DEG_PER_UNIT(0.008)` = 45 000 u circumference, radius ~7.16 km, whatever the body's `radius`. The mansion + cliff (GLB bounds 401 x 163 x 250 m, bounding sphere ~250 m) is ~3.5 % of that radius. Changing the shared constant would move every site, collider and nav grid, so it is not touched; the mansion is not rescaled (doors/collision/GI unchanged).
Fix (ui/dm-facilities.js, ui/dm-lod.js, index.html `_propsLod`):
- All LOD distances were measured on the ground plane, so a mansion 20 km straight below you was "near" (LOD0, interior, lamps). Now 3-D (altitude counts) for mansion LOD0/1/impostor, cull, interior/holo/lamps ticks, other landmarks, and prop chunks.
- Size fade: bounding-sphere projected diameter (`DMLod.billboardPx`) -> `DMLod.sizeFade`, screen-door fade through the existing `dmFade` interval (levels' intervals scaled by the factor). Gone at <= 56/48/40 px (low/mobile/desktop), full at >= 96/84/70 px; the last 15 % of `mansion.far` is a fade too (no pop). Rows `mansion.goneDiam`, `mansion.fullDiam`. With a 1080 px buffer and 60 deg fov: fully drawn out to ~4 km, gone beyond ~10 km (desktop); from the deck or the sea it is unchanged.
Not done: enlarging planet radius / gravity scale (high regression risk, see above).

## Unverified
No browser/GPU here: node tests only (`node tools/tests/lod-unit.js`). Unverified: that the white bands are gone on a real Solenne render, the screen-door size fade on device, Earth colour without the glacier layer.
