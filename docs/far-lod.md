# Far-range level of detail (sw v279)

Goal: the highest detail near you, a graceful decay with distance, no pop-in, no missing faces; from the mansion deck a far cliff still reads, and up close it has the fine texture. Frame rate first (>= 15 fps on the Galaxy Tab and the iPhone 16e); `ui/dm-budget.js` and `ui/dm-governor.js` stay the authority.

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

## Tests
`node tools/tests/lod-unit.js` — table validity, class monotonicity, `propCut` equals the legacy formula, ring bounds (a chunk entering the wanted set is >= cut x hysteresis away), hysteresis has no flip-flop under jitter and exactly two transitions out and back, `fade` shape, vantage monotone in vt / ladder / class and never below the walk radius, glue class detection and ladder scaling in a sandbox.

## Not done / unverified (no headless GPU in this lane)
- Nothing here was run in a browser. The code paths are syntax-checked and the pure maths is tested; the frame cost of the 25 / 49-chunk pre-roll and of the vantage tile count on Mali-G615 / A18 is **unmeasured** (watch `chunks` and the tile count in the perf log; the ladder sheds via `props` and `ground`).
- Props still become visible by chunk (hidden behind fog), not by a per-prop dither: a per-chunk opacity needs a per-chunk material (a pipeline per chunk), and an `alphaHash` always-on costs hidden-surface removal on Apple GPUs.
- The mansion LOD0 <-> LOD1 swap is still a hard swap with hysteresis (cliff/mansion lane owns it; `DMLod.fade` is there for a dither cross-fade when that lane wants one).
- Baked distant cliff impostors (overhang faces a height field cannot hold) and texture mip/LOD bias by distance are not implemented; far cliffs are the quadtree surface with the cliff strata colour. Cliff 2K maps keep trilinear mips + anisotropy 4/8.
