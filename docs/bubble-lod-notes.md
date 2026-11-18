# bubble-lod notes (branch `claude/bubble-lod`)

Scope: (1) why Mars loaded late / ran at 7 FPS, (2) one camera-centred LOD rule for every world, (3) the protective orb/bubble is REMOVED and replaced by
the LED / staff-crown protection + a hazard HUD with an exposure clock. No sw.js / `?v=` / `DM_BUILD` bump on this branch (the lead does one bump per merge).

Verification legend: **MEASURED** = observed in the headless harness (three r185, WebGL2 fallback on SwiftShader, so absolute ms are 5-20x a phone and noisy;
the ORDER and the counts are what matter). **INFERRED** = read from code, not observed. Nothing here was run on a real WebGPU device.

## 1. Mars late load / 7 FPS

| Finding | Status |
| --- | --- |
| The staged compile behind the loader took ~8.4 s (JOTS_PlanetGround, "misc") | MEASURED |
| After the loader closed, the FIRST `_trueAtmoSurface` call was one 7.6-7.8 s frame (baseline, repeated: 7756 ms, 7607 ms) | MEASURED |
| That frame = creating the surface air pass (node graph, targets, 128x128 height bake) AND rendering the whole world through the pass for the first time: the scene-to-target variant of every material is a separate pipeline from the canvas one that the staged compile warmed | MEASURED (programs 249 -> 296 in that frame) + INFERRED (the pipeline-key mechanism) |
| Her skinned materials and the hazard crown are not in the world scene until after `_pwOpen` returns, so a warm-up that ran before them still left ~47 new programs / ~8-10 s in the first frame | MEASURED (second run) |
| The shield/orb build + its compile also happened lazily on the first frames of a hostile world | INFERRED from code, MEASURED order in the harness |
| Sustained "7 FPS" after the first frame: SwiftShader gives ~0.5 fps for everything so the harness cannot say what a Mali-G615 does | NOT measurable here. Needs `?perf=1` on the tablet |

### What changed
* `_taSurfPass / _taSurfBake / _taSurfFeed` split out of `_trueAtmoSurface0` (one place builds the `sf|` key, so a warm render and the frame share a pipeline).
* `_taWarmSurface(gen)` (index.html, called from `_pwOpen` after the staged compile): builds the pass, bakes the height map, and renders once through the pass **with her attached for the warm render only** (in front of the camera, restored exactly: parent, position, scale, rotation, visible). It waits up to 12 s for her if she is still loading. `?atmowarm=0` restores the old lazy path.
* `DM_HAZ.prewarm(gen)` (ui/dm-hazard.js): on a hostile world builds and compiles the LED/crown set behind the loader and gates the per-frame hazard tick on `H.ready`, so the protection switches on in one step. It runs BEFORE the air warm so the crown is in the scene.
* Result, MEASURED headless, same Mars site: first `_trueAtmoSurface` after the loader **7.6-7.8 s -> 2.5 s** (the last 24 programs are crown/charm/props that appear after landing). The cost moved behind the loader (`_taWarmSurface` ~6-14 s headless). On a phone the loader is therefore longer by the warm time and the first visible frames should not stall; **this trade is unverified on a device**.
* Not changed: the 3.5-6 ms/frame sliced local-height bake, DMBudget tiers.

## 2. LOD centre / radius rule

**Rule:** every distance-based LOD (props, far canopy, sea sheet, vantage ring, ground quadtree, parallax, sparsevox, fades) is centred on the **camera's ground position** (x,z of the camera before the planet-frame bend, i.e. `PW._camFlat`), measured against the ground plane under the camera (`agl` = camera height above the local terrain). Orbit, third person and first person are the same rule because the camera is the centre. Radius is the tier's existing `DMLod` / `DMBudget` radius (classic default, `?lodfar=1` = the Nov-5 far set), fading with the existing radial haze/dissolve (`_SKY_FADE0 = 0.82`).

* New pure helper `DMLod.centre(cam, groundAt, driver, out)` (ui/dm-lod.js, tested in tools/tests/lod-unit.js): camera x/z, height above the ground, falls back to the driver when there is no camera.
* index.html `_pwWorldTick`: `lc = DMLod.centre(...)` (kept in `PW._lc`) now drives `_pwPropsTick` (props LOD + far canopy), `_pwSeaFollow` and the vantage ring height. `_pwPropsTick(px,pz,agl,dx,dz)`: LOD uses the camera; collider registration still uses the **driver's** chunk `(dx,dz)`.
* Already camera-based and left alone: the SkyGround quadtree (`G.update(cam)`), dm-parallax, dm-sparsevox, fov-fade.
* Deliberately left on the driver (not camera): colliders / MC patch (physics must be where she is), the sun shadow box, DMLight probes.
* NOT extended: the on-foot ground radius. The existing radial haze fade is already gradual and the tablet is fill-bound; pushing it out would cost fill rate. Not measured on a device.

## 3. Protective orb removed; LED / crown / HUD

### Removed (no per-frame logic left)
`ui/dm-hazardbubble.js`, `ui/dm-shield.js`, `tools/tests/hazard-bubble-look.js`, the orb/board tiers, `?shieldr`, the radius multiplier, the arm/dismiss/cooling logic, the toggle UI and the `dm_shield_orb` localStorage key (cleared once with `removeItem`). The atmosphere / sky / `PW.atmo` shell were not touched.
* **Flag for the lead:** the blue underwater "mist orb" clear-zone was part of the bubble and is gone; the underwater tint, fog, caustic and bubble trail, and `waterDrag` were kept (lazily built only on a dive).
* **Kept:** `DMHazard` registry + 3 Hz sensor (only while a local source exists), habitability (`H.habitable/tag/kind`), `dmhazard` event.

### New: ui/dm-hazard.js (replaces dm-hazardbubble.js)
* **LED + crown:** green LED casing on the lighthouse housing and the staff-crown contour glow on the Skyboard set (inverted-hull shells, same materials). The chest LED is parented to the chest bone (`DMCharm.rig`). On when toxicity is sensed at her, parked board or not.
* **First person:** a small pooled point light from `DMNatLights` (FP_I 0.05, FP_R 0.9 units; `?ledfp=` gain) tints the immediate surroundings within a few feet. No extra shadow-casting light, no new light object, no shader recompile (the pool of 2 already exists). **Her arms/hands are not drawn in first person in this build** (body hidden), so only surroundings are tinted.
* Third person / orbit: the LED/crown are visible on her.
* Safe maps: dormant (`wake = H.hostile || HZ.near || EX.on`, or a dive).

### New: exposure clock (data driven)
`HAZARD_TABLE` (commented table in ui/dm-hazard.js): per hazard `safeSec` (seconds she can stay at full intensity), `recoverSec`, `warn` fraction, label, hue. `intensity = severity x (0.6..1.0 by depth in the zone)`. `reserve` runs 1 -> 0 while exposed and back to 1 while clear (snaps to 1 at >= 0.999). States: `off / alert / protected / warn / exposed` with +0.08 hysteresis on the amber threshold. Events: `dmhazardhud` (<= 4 Hz), `dmhazardzero` (once per exposure).

**What happens at zero:** nothing punitive. The state goes red, the HUD says "OVEREXPOSED - LEAVE THE ZONE", and a one-time `dmhazardzero` event fires. No damage, no game over, no control change. **Decision for the lead:** whether zero should do anything (slow, fade, respawn at the board) is open; hook the `dmhazardzero` event.

### New: ui/dm-hazardhud.js
Card `#dm-hazhud`, fixed at `top: calc(126px + safe-area)`, centred, `min(86vw, 232px)`, `pointer-events:none`, z-index 3550, only in `#screen-flight.active`. Appears only when a hazard is sensed; gradient band with an eased marker that tracks proximity and falls back as she leaves; hazard type; "SAFE TIME mm:ss" counting down while exposed, "RECOVERING mm:ss" when leaving, "NEAR THE ZONE - NOT EXPOSED YET" when close but outside; reserve bar; hides when fully clear. Listens only to `dmhazardhud` (no timer, no rAF). tools/tests/hud-layout.js checks it does not overlap other HUD.

## Flags / knobs
| Flag | Effect |
| --- | --- |
| `?shield=0` | no LED / crown / first-person light; the clock and HUD still run |
| `?hazardhud=0` | no HUD card |
| `?hazard=toxic\|airless\|safe` | force the world's hazard class |
| `?hazardzone=plume` | place a local plume source (near / inside / recover flow) |
| `?ledfp=<gain>` | first-person LED light gain |
| `?atmowarm=0` | disable the world-load air-pass warm-up (old lazy path) |
| `?lod=` / `?lodfar=1` | existing LOD table / Nov-5 far set |

## Tests
`shield-unit.js` 118/118 (stub-world tick incl. load gate, prewarm, tiers, dormancy, dive, plume flow, flags), `hud-layout.js` 50/50, `lod-unit.js` (lodCentre), `atmo-warm-keys.js` 20/20 (the `sf|` key is built in one place), `fov-fill.js` 98/98. Full-suite diff against the v355 baseline: no new failures (known-failing before: fov-fade, ground-unit, light-glue-sim, lighting-budget, mem-unit; `light-unit` is timing-flaky).

## Screenshots (headless, SwiftShader/WebGL2): /home/claude/bubble-lod-shots/
`base-*` (v355) vs `new-*`. Horizon (low) and distant-terrain (pitched up, turned) views. The baseline shows the green orb round her; the new set does not. The new shots were taken at a different Mars time of day (18:5x dusk vs 10:5x), so brightness differs for that reason, not from the change. Not a perf comparison (about 0.5 fps either way).

## Needs a real device
Hard reload; Profile > Admin > Reset quality; `?perf=1` on Mali-G615 and iPhone 16e for frame time and loader duration; real-WebGPU WGSL compile of the new crown/LED materials; first-person LED intensity tuning; whether the warm render flashes a frame over the orbit view; the 7 FPS claim itself.
