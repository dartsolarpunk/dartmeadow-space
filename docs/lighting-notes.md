# Lighting overhaul - shared notes (branch `lighting-overhaul`)

One job, one update: daytime/mansion lighting (DMLight, sun/shadows), the flashlight spot, the volumetric light, QA/perf. Append short sections; read the others before touching shared code.
The integrator does the single sw.js / `?v=` bump at the end - do not bump on this branch.

## Daylight / DMLight (worker: sun + probes) - NOT verified on a device or GPU

**White follower: probable root cause (code reading, no GPU available).** DMLight adds the radiance-cache *bounce* as `emissiveNode` (ui/dm-light.js applyMaterial). Emissive is not masked by the sun shadow, and the cache window is a disc centred on the camera (shader fades `wC`/`wOut` radially round `U.cam`). The bounce was `max(E,0)`: the 4-16 ray EMA estimate is zero-mean noise on flat ground, rectified into a positive mean (test 23 shows ~0.005+ mean), plus real bounce off the mansion/cliffs at full sun intensity. Result: a pale disc that follows the player and fills in sun shadows (which is also why her shadow looked faint). Nothing else positioned at the player is on by day (lamps/LED pools hidden by day, flashlight off until toggled, planet cloud shell already removed in a7755c1).
Fix: `softBounce` (soft threshold, `U.bb`=0.02) + `bounceDayScale` (`U.bk`, eased, 1 at night -> 0.22 at noon). A/B flag: `?lightbounce=0` (off) / `1` default / `>1`. If the wash is still there with `?lightbounce=0`, the cause is NOT the bounce: then try `?light=off`, then `?nopolish`.

**Smooth falloff API (pure, exported in `DMLight.core`, tested in tools/tests/light-unit.js #23):** `smooth01(a,b,v)`, `lampFalloff(d,r)` (1 at lamp, 0 at r, C1), `softBounce(b,bias)`, `bounceDayScale(sunY,day,lo)`, `hyst(state,v,on,off)`. A flashlight/volumetric cone should use `lampFalloff`-style smoothstep for radial fade and `hyst` for on/off; CPU lamp input = `DMLight.setLamps([x,y,z,r,g,b,radius]*n)` + `setLampLevel(0..1)`. Lamp CPU occlusion is now soft (no binary switch-off behind corners).

**Lamp pools (ui/dm-lamps.js):** pool mesh nodes bordering uncovered cells (drops, water, lattice end) now fade to alpha 0 and the radial alpha is smoothstep^2 - no hard cut at ledges.

**Sun shadow:** already texel-snapped, follows the player (DMPolish.fitSun, TERRAIN.sun, PCFSoft, tier map sizes 512-4096, cadence 1-3 frames). Mansion cast shadow is OFF on phones by default (59k-tri pass, ui/dm-facilities.js): flag `?sunshadow=1` enables it on phones. `?sunshadow=0` (read once as `window.DM_SUNSHADOW` in ui/dm-polish.js) restores the old behaviour for the changes made here: contact blob opacity back to 0.52, mansion phone default. It does not touch TERRAIN.sun / fitSun (unchanged old code; `?nopolish` disables fitSun+blob) nor the bounce fix (`?lightbounce`). The cheap contact blob (DMPolish.contact) is stronger (opacity 0.52 -> 0.72) as the phone fallback. Interior (ui/dm-mansion-interior.js) is baked/unlit by design: no real-time shadow indoors.

**Flags:** `?light=off|low|med|high|ultra` (exists), `?lightbounce=0..`, `?sunshadow=0|1`, `?nopolish` (exists; disables fitSun/contact).

## Volumetric fog lighting / DMVLight (worker: light shafts) - NOT verified on a device; shader compiles + renders in SwiftShader only

**What it is.** `ui/dm-vlight.js` (new, sync script after dm-light.js). No screen pass: it installs `scene.fogNode` = stock range fog + single-scattering from a small light list, integrated along the camera->fragment ray in every fogged material. Open sky costs nothing (sky domes have `fog=false`), so a beam shows against terrain/props/walls, NOT against the bare night sky (limitation of doing it in the fog node).
- **Light list** (uniformArray, view space, N = 3/5/8 by tier): `A=(pos,range) B=(rgb*intensity,cosOuter) C=(axis,1/(cosInner-cosOuter))`, axis 0 = point. Top-N by `power/(d^2+4)`, flashlight always first; slots fade in/out 0.25 s (no pop).
- **Integral:** ray clipped to the light's range sphere, equi-angular sampling (`s = tc + H tan a`, K = 2/3/4 jittered samples) with smooth `(1-(r/range)^2)^2` window, spot cone smoothstep, Henyey-Greenstein g=0.45, `exp(-sigma(s+r))`. Point light with window 1 = exact `atan` closed form (tested). Soft knee on the result (never blows out).
- **Medium:** `sigma = density * (haze + mist*exp(-(y-groundY)/mistH)) * patchy`, evaluated at the ray midpoint (local fog/mist density). `DMVLight.setMedium({density:0.02, mist:1, mistH:7, haze:0.18, patchy:0.3, gain:0.5})`; gain is eased down 55 % by day.
- **Sun:** only when low (`sunOn` from elevation, 0 above ~0.55 sin-elevation): 1-2 `DMLight.sunVisNode` samples along the ray modulate a forward-scattered sun term -> shafts where a low sun is occluded. High sun: uniform branch skipped.

**Interface (flashlight worker / anyone).** Default: `tick()` reads `DMFlash.S.light` (SpotLight: position, `S.target` position, angle, penumbra, intensity*color, distance capped at 70 m) when it is in the scene and `intensity > 0` - nothing to do. To own the cone instead: `DMVLight.setSpot('flash', {on, x,y,z, dx,dy,dz (axis, need not be unit), angle (outer half-angle rad), penumbra (0..1), r,g,b (colour*intensity, candela-like), range, gain})` every frame, `DMVLight.clear('flash')` when off. Static lights: `setPoints(key, Float32Array[x,y,z, r,g,b, range]*n, {level, gain})` + `setLevel(key, 0..1)`; wired in ui/dm-lamps.js for `'lamps'` (poles, level = dusk fade) and `'leds'` (balcony rail LEDs). Any new emissive thing = one `setPoints` call. World-space coordinates, no per-frame allocation.

**Flags:** `?vlights=0` (nothing installed), `?vlights=low|med|high` forces a tier (default: phones/coarse pointer = low, desktop follows DMLight tier), `?vlgain=` (default 0.5), `?vldens=` (default 0.02 /m). Hooks in index.html: `DMVLight.install(scene,{THREE})` right after `scene.fog` is created (installing later would recompile every fogged material once), `DMVLight.tick(...)` right after `DMLight.tick`.

**Perf / budget:** per fogged pixel: one uniform branch (off = free), else N lights x (clip test, 1 atan x2, K samples of tan/sqrt/exp/pow). Light with no overlap with the ray early-outs. Budget: `DMBudget.lvl('light')` 1 -> half the lights, 2 -> 2 lights + no sun, 3 (or emaMs > 45/60) -> fade to off (1.5 s ramp), recovers the same way; all uniform writes, no recompile. `uMaxD` 120 m caps the integrated path, sun 260 m.

**Tests:** `node tools/tests/vlight-unit.js` (packing, picker, slot fading, window/cone smoothness, point + spot vs 40k-step brute force: median 1.5 % / worst 13 % rel err at K=4 in narrow-window cases, atan closed form 1e-8, finite on 4000 random rays, budget plan). `tools/tests/vlight-harness.html` renders the real fogNode (`?gl=1&side=1&vlights=high&sun=1`); it built and rendered with no errors on WebGL2/SwiftShader for low/med/high + sun. Colours/gains are untuned guesses.

**Open issues:** (1) beams are invisible against bare sky/background by design; (2) K=3 jitter shows faint grain at the cone edge on large flat ground (IGN noise, amplitude 0.6/K) - raise tier or soften the spot penumbra; (3) DMLight sun visibility needs `DMLight.on` + a march tier, else the low-sun term is un-occluded haze toward the sun; (4) dm-atmo.js (planet-scale gas, units of planet radii) and dm-mist.js (asteroid fume sprites in space, `fog=false`) are deliberately NOT lit by local lamps - metres vs planet radii; fog-true materials get shafts automatically; (5) the lamps/LED intensities (380/235/114 @22 m, 70/58/42 @7 m) are guesses to tune on a device with `?vlgain=`; (6) scene fog is now owned by the fogNode: anything that replaces `scene.fog` with a different object is followed via `tick` (colour/near/far copied each frame), a scene without `scene.fog` gets `fogNode = null`.

**DMVLight teardown (QA finding):** `S.scene` removed (it kept the last world scene alive); `DMVLight.release(scene)` is called from `_pwClose` (drops `scene.fogNode`, fades out, clears slots and the auto flash spot). tick() no longer remembers scenes.

## Flashlight spot + shadows + beam (ui/dm-flash.js) - flashlight worker

Nothing below ran on a GPU. Node tests build the real WGSL with a stub renderer (tools/tests/flash-light.js part 2) but no frame was ever rendered.

### How it works
- One `SpotLight` per scene she can be in (`flightScene`, each world scene), created by `DMFlash.adoptScene` before the first compile, intensity 0 while off. Tagged `userData.dmFlash`. Every lit material gets it through three's own light loop (terrain, props, character, board, foliage: they all use the scene light list).
- Materials with a PRIVATE light list needed one hook each: mansion atlas (`ui/dm-mansion-look.js` `lightList(ctx, true)`, kept out of the probe-scaled list) and Bird Temple hull/interior (`ui/dm-bt-lighting.js` `lightSets`, via `DMFlash.sceneLight(flightScene)`). The `_lcNode` world lists (index.html) already include every non-excluded scene light.
- DMLight: `m.receivedShadowNode` wraps EVERY light's shadow node (sun-box fade + sun height-field visibility). That would have dimmed the spot at night / outside the sun box, so the spot's shadow node is tagged `dmFlashShadow` and the 4 wrapper branches in `ui/dm-light.js` return it untouched. Nothing else in DMLight changed (AO only touches indirect light; the spot is direct light, so it is not dimmed by day sun, sky visibility or AO).
- Shadow: `light.shadow.shadowNode` = a `ShadowNode` subclass whose PCF filter sits in `If(U.shOn > 0.5)`: when the flashlight is off (or shadows are throttled off) the pixel shader skips the map taps. `shadow.autoUpdate=false`; `tick()` sets `needsUpdate` on the tier's cadence. `shadow.updateMatrices` is wrapped so the shadow far plane = `min(tier.far, mode.shFar, light.distance)` (the light keeps its 260 m reach, casters beyond the shadow reach are never drawn into the map; beyond it the surface is lit unshadowed). Log-depth safe (the project's renderer uses a logarithmic depth buffer; three's `setupShadowCoord` has a branch for it, bias is added in log-depth units).
- Beam: one additive back-face cone mesh per scene (`jots_flash_beam`, renderOrder 52, hidden while off). Fragment shader: analytic ray/solid-cone interval (`DMFlash.coneInterval`, brute-force tested), stopped by the scene depth (same technique as `_pwAtmoShell`), 6/8/14 samples (tier), interleaved-gradient jitter, density x angular smoothstep (penumbra) x length fade x near falloff x Henyey-Greenstein forward phase, desktop adds `mx_noise_float` dust. **Yields to DMVLight**: while `DMVLight.on` and the scene has a `fogNode` (on foot / flying) the cone hides itself so the shaft is not counted twice (DMVLight already scatters `DMFlash.S.light` through the fog; it reads `S.light`/`S.target`, which the spot pairs keep current). The cone is the beam in open space, in fog-less scenes and with `?vlights=0`; `?flashbeam=<k>` forces it on top. No beam when the scene depth cannot be bound (multisampled WebGPU, `_viewportDepthOK()`), because it would pour through the ground.

### Interface for the other passes
- `DMFlash.cone()` (preallocated, valid after `tick`): `{on, mode, pos{x,y,z}, dir{x,y,z}, angle, penumbra, cosOuter, cosInner, range, intensity, lumens, cone, shadow{on, light, map, matrix, near, far, bias, size, every}}`.
- `DMFlash.U` (TSL uniform nodes, `null` until the first spot is made on a TSL build): `A` apex, `a` axis, `cosO`, `cosI`, `len` (visible shaft length), `k` (beam gain, 0 when off), `dens`, `col`, `shOn`. A fog / mist / atmosphere pass can read these to add its own in-scatter.
- `DMFlash.medium = {mul, add}`: scale/offset of the beam's air density (per metre). Base: 0.010 on the ground x clamp(520/fog.far, 0.5, 3); 0.0006 in space. A volumetric-light pass that knows the real fog/mist density should set these instead of guessing from `scene.fog`.
- `DMFlash.sceneLight(scene)`, `DMFlash.hooks = {gfx, depthOK, logDepth}` (set in index.html before the first `adoptScene`).

### Tiers (`?flashtier=low|phone|desktop`, else from GFX / UA)
| tier | shadow map | refresh | shadow reach | beam samples | noise |
|---|---|---|---|---|---|
| low (Low preset / shadowSize<=512) | 512 | every 2nd frame | 60 m | 6 | no |
| phone (isMobile) | 1024 | every 2nd frame | 100 m | 8 | no |
| desktop | 2048 | every frame | 180 m | 14 | yes |
Also: map side capped by `GFX.shadowSize`; `DMBudget.shadowEvery()` / `shadowHalf()` honoured; frame-time EMA > 38 ms -> every 2nd, > 55 ms -> every 3rd, > 72 ms for 90 frames -> shadows off (cone + light stay), retried after ~10 s of < 42 ms (2 retries, then off for the session). Space mode: light reach 1500 units, shadow range 140 units.

### Flags
`?flashlight=0` (no light created at all, button stays) - `?flashshadow=0|512|1024|2048` - `?flashbeam=auto|0|k` - `?flashtier=` - `?flashbias=-0.0004`. Session only; nothing in localStorage. Beam width: long-press the light button or tap the cone key atop the brightness bar (wide 35 deg / medium 23 / spot 12; same lumens, narrower = brighter).

### Approximations / known gaps
- The visible shaft is NOT occluded by objects inside the cone (only by the scene depth). Real shadow-map-occluded shafts would need the spot's depth map bound into the beam shader.
- Shadow map refresh at half rate on phones: a fast head turn drags the shadow edge for a frame.
- The spot is evaluated (direct BRDF) for every lit fragment even at intensity 0 (as before); only the shadow taps are branch-gated. `?flashlight=0` removes even that.
- Sampled-texture budget: each shadow-RECEIVING material now binds one more depth texture (+ sampler). If a material is already at WebGPU's 16 sampled textures per stage (terrain with DMLight cascades + sun shadow + atlases is the suspect) its pipeline will fail to create. Unverified. Kill switch: `?flashshadow=0`. Suspect to check first on a device: terrain/ground atlas materials with `userData.dmLight`.
- Shadow bias/normalBias (-0.0004 / 0.06 m) are first guesses for a log-depth 1024-2048 map; tune with `?flashbias=`.
- Tests: `node tools/tests/glasses-flash.js`, `node tools/tests/flash-light.js` (set THREE_CORE, optionally THREE_WEBGPU).
