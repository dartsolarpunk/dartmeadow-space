# Shield / LED / hazard HUD / LOD horizon (branch claude/shield-led-lod)

Based on v356. No sw cache, `?v=` or DM_BUILD bump (lead does one per merge). The characterassests GLBs are untouched.

## 1. The orb culprit
`ui/dm-hazard.js`, the `shFrame` block calling `VL.setPoints('shield', ...)` (range `g.h*2.6`, intensity 46). It is a DMVLight fog in-scatter point light: a sphere of range that intersects the ground as a circle. It was active only when `!lowTier() && DMBudget light < 2`, so it did not reproduce in headless (low preset). **Removed.** Nothing in the hazard code draws a sphere or ring any more, shield on or off.

Kept (legitimate, may look like rings): shadow-box ring, tess patch, pebble band, probes, atmosphere/sky, the DMHazard sensor. A mesh census near the character found no ring or sphere mesh.

## 2. Shield model
The shield is a state flag plus gear visuals (`DM_HAZ.shieldIsOn / setShield / toggleShield`, sessionStorage `dm_shield_on`, event `dmshieldtoggle`).
- Sub-button of the left stick cluster (`ui/dm-flash.js`), inline SVG diamond, stacked above the flashlight button. Toggles any time, hazard or not.
- LED: hazard and shield OFF = whole strip green. Shield ON = half green / half blue. Shield ON with no hazard = blue half only (chosen so the state is visible; the green half means "hazard sensed").
- `LED_Top_Strip_L` / `LED_Top_Strip_R` are looked up by name: L green whenever a hazard is sensed, R blue when shielded else green. Absent meshes fall back silently; the existing LED mesh logic is unchanged. NOT verified (GLB not landed).
- Staff crown glows blue when shielded (no extra lights).
- Shielded: the SAFE TIME clock stops draining and recovers, parked or not.
- Exposure stays data driven (`HAZARD_TABLE`). Mars: one `global` toxic source over the whole planet. Habitable (breathable) worlds register nothing; `H.tick` returns on one boolean (`wake`), so there is no per-frame cost.

## 3. HUD
`ui/dm-hazardhud.js`: narrow drop-down tab under the top-left header; extends on hazard, retracts when clear. Type, band marker and safe-time countdown kept. `tools/tests/hud-layout.js` checks overlap (header, music controls, tablet landscape and phone).

## 4. Round button at lower left
It is the genuine flashlight (`ui/dm-flash.js`). Kept.

## 5. LOD to the horizon (`ui/dm-lod.js`, index.html `_pwWorldTick`)
Rule: the LOD centre is the ground point at the view centre (forward ray against the ground plane, secant-refined on terrain heights) and the horizon/reach are those of a camera standing level on the ground there (her eye height). A level or upward camera keeps its own point. Pure geometry, no per-world radius. Elevated terrain past the geometric horizon is not culled by the plane: the horizon is extended by the seen relief. Horizon opening is weighted by tier and DMBudget.
Flags: `?lodhorizon=off` kill switch. Other flags: `?shield=0`, `?hazardhud=0`, `?hazard=`, `?hazardzone=`, `?ledfp=`.

## 6. Performance (Mars 4-7 fps)
Headless data only, NOT a device result. Heavy triangle and draw-call load (about 615k triangles in the main scene: hair 147k, Ariel 70k+43k, SkyGround 192k). The hazard tick is negligible. The removed fog light was one of the per-frame costs on high tiers.

## Verified headless vs needs a device
Headless: node tests (shield-unit, hud-layout, shield-button, lod-unit, fov-fill), Mars renders in `/home/claude/shield-lod-shots` (HUD tab, diamond button, shield-on state, no ring).
Device needed: fps, whether the removed light was the exact ring seen, blue LED/crown look, strips, HUD placement, horizon opening cost on Mali/iPhone (history: t1590 saw 3-11 fps when the horizon opened on foot).

## Not done
Far-band smoothing (diagnosed only), quadtree distance centred on the view point (still camera based), parallax/sparsevox changes, a triangle-load perf fix.
Pre-existing failing tests (also on v356): fov-fade, lighting-budget, mem-unit.
