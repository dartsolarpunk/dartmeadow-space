# Planet air as world geometry (`ui/dm-atmo-volume.js`, v385, `?atmo=shell`)

## Sandbox findings (dartsolarpunk/dm-jots-sandbox, `index.html`, single commit)
* The sandbox atmosphere is NOT a post-process. It is one `SphereGeometry(HALF*1.06)` mesh, `BackSide`, additive, `depthTest:false`, whose
  `MeshBasicNodeMaterial.colorNode` ray-marches single-scattering Rayleigh per fragment: view ray vs the shell sphere (`raySphere`), 10 view samples
  x 5 sun samples, density `exp(-h01*5.5)*(1-h01)`, coefficients `(400/lambda)^4 * 2.2`, transmittance `exp(-coeff*(sunOD+viewOD))`.
  Opacity = clamp(sum(rgb)*0.6). The only "scene" input is an independent depth pre-pass (`RenderTarget` + `DepthTexture`, terrain only, one extra
  `renderAsync` per frame) that stops the primary march at the solid surface. Per frame it updates one uniform (`sunDirUniform`).
* "Interactive" = the sun uniform follows the animated light + `window.ATMO_DEBUG` recolours the clamp. There are NO gas particles in the sandbox
  atmosphere; its only particles are the 2600-particle SPH **ocean** (storage buffers, compute density/force passes, `PointsNodeMaterial`).
* Cost: per shell fragment 10 x (5 + 1) ray-sphere / density evaluations; one extra full scene render (depth) per frame; the SPH ocean is O(N^2)
  compute (2600 x 2600) but only when the tides tab is up.
* Stability comes from: analytic planet-sphere clamp instead of reading the scene, no feedback loop, no per-frame allocation.

## Audit of the game (v384): where it is screen-space
| Where | What | Kind |
|---|---|---|
| `ui/dm-atmo.js` (`DMAtmo.create` / `_trueAtmoRender` / `_trueAtmoSurface`, index.html ~20170-20460) | full-screen node pass: scene -> RT, gas ray-marched over scene depth, composited | **post-process** (on by default, `trueAtmo`) |
| `_buildJotsDustyAtmoShell`, `JOTS_PlanetAtmo` (index.html ~7755 / ~8590) | world-space sphere + the sandbox march (`_jotsShellAtmoColor`) | world geometry, but hidden by `_taHideShells` while the post pass is on |
| `_pwAtmoShell` (index.html ~26674) | sphere mesh, BackSide, additive, march in squeezed frame, optional `viewportDepthTexture` clamp | world geometry (scene-depth read) + `_trueAtmoSurface` on top |
| `_styledSky` (index.html ~5499) | `makeSkyDomeMaterial` gradient dome following the camera | camera-locked dome (backdrop, not gas) |
| `ui/dm-sky.js` | ground/flight sky: sun, stars, scatter colours, comets | camera-locked screen sky |
| `ui/dm-menuworld.js` `buildSky` | planet + a BackSide shell whose glow is "closest approach of the view ray to the centre" | faked glow (no march) |
| `ui/dm-globe.js` | 2D canvas minimap globe; "atmosphere rim glow" is a CSS/canvas ring | 2D UI, not the world |
| `ui/dm-fluid-world.js` | APIC liquid, PBF spray, smoke volumes near the player | real fluid, local to the player, not planet-wide |

## What v385 adds
`DMAtmoVolume.create(THREE, TSL, {R, top, co, falloff, tint, sunDirU, kind})` -> `{group, shell, wisps, wake, update, disturb, setTier, setSun, dispose}`.
1. **Shell** (all tiers): sandbox march in the shell's own material; centre/scale from its world matrix; front faces + depth test outside, back faces inside.
2. **Wake** (tier >= 1): 4 decaying/spreading disturbance slots (uniform array, CPU `createWake`) thin the density along the view march and push/swirl the wisps.
   Fed from the camera/ship motion in `update()`, or explicitly with `disturb(worldPos, radius, strength)` (landings, skims, impacts).
3. **Wisps** (tier >= 2): <= 640 instanced camera-facing soft puffs, positions closed-form in the vertex stage (no storage buffers, no compute), so identical on
   WebGPU and the WebGL2 fallback; depth-tested, additive, thinning with height, lit by the sun.
4. **Tiers**: 0 scattering only (4x3 samples), 1 +wake (6x3), 2 +192 wisps (8x4), 3 +640 wisps (10x5). Phones/tablets are capped at 1 and fall to 0 when the DMBudget
   `atmo` stage sheds or the ladder is exhausted; the tier is re-read every 2 s. `?atmotier=0..3` forces.

Wired (flag `?atmo=shell`, default OFF): `_buildJotsDustyAtmoShell` + procedural-planet `JOTS_PlanetAtmo` (every body in the space scene, so flight approach, the
space -> surface hand-off and orbit), `ui/dm-menuworld.js` (studio + cards planet), per-frame `DMAtmoVolume.frame` before the space render; the space post pass,
its warm-up and `_taHideShells` stand down. Name note: `ui/dm-atmo-shell.js` (v297) is the unrelated perimeter *helper*; this module is `dm-atmo-volume.js`.

## Not done (phase 2)
* Ground / sky-flight levels still use `_pwAtmoShell` + `_trueAtmoSurface` (clouds, weather, terrain-bound gas need the ground height field and the squeezed E-W frame).
  Next: build `DMAtmoVolume` in that frame (`ax` squeeze) with a scene-depth clamp, then retire the surface post pass.
* Stateful gas (compute advection / SPH-style, as the sandbox ocean) for the wisps; needs a WebGPU-only path + budget gate.
* On-device verification (Mali-G615 tablet, iPhone). Only headless WebGL2/SwiftShader look + compile checks were possible.
