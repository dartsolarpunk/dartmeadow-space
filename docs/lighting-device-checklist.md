# Lighting overhaul: manual device checklist

For the tablet (Mali-G615) and the iPhone 16e. Everything the headless tests prove is *code paths and no exceptions*; **frame rate, real shadow
quality, banding and thermals are only verifiable here.** Run it with the build that has the overhaul (check the service worker cache name in
the in-game perf HUD or `sw.js`, `dartmeadow-engine-vNNN`, matches what was merged).

## Setup (2 minutes)

1. Open the game with `?perf=1` appended, e.g. `https://dartmeadow.space/?perf=1`. A small HUD shows FPS, frame ms (avg / p95 / worst),
   CPU ms per system and, on WebGPU, the GPU per-pass table. Tap the HUD to collapse it.
2. Sign in as usual (the perf log is uploaded to your private vault repository at `perf/<session>.json`, one snapshot every 60 s and one when you
   close or hide the tab).
3. Use a fresh app launch for each A/B below (the shader variants are chosen at boot). iPhone: close the tab fully, do not just switch away.
4. Keep the device cool and on battery saver OFF. Note the battery temperature if you can: sustained 30 fps for 5 minutes is the bar.

## URL flags (each new feature has a kill switch)

| Flag | Effect | Use it to |
|---|---|---|
| `?flashshadow=0` | flashlight stays a plain (non-shadow) spot light | see if the flashlight shadow map costs the frames |
| `?sunshadow=0` | daytime sun shadow map / follower blob off (old behaviour) | see if the sun shadow change costs the frames |
| `?vlights=0` | volumetric light shafts off (no in-scatter pass) | see if the shafts cost the frames |
| `?light=off` | DMLight (baked light cache + smooth falloff) off. Also `low` / `med` / `high` to force a tier | see if the light cache costs the frames |
| `?perf=1` | debug HUD plus perf log | always |
| `?vlights=0&flashshadow=0&sunshadow=0&light=off` | everything new off: this is your baseline | compare against |

Combine freely, for example `?perf=1&vlights=0`. A flag that is spelled wrong is ignored (the feature stays ON), so check the HUD / console.

## A. Baseline (one minute)

Open `?perf=1&vlights=0&flashshadow=0&sunshadow=0&light=off`, land on a planet, walk 30 s in daylight. Write down FPS (avg) and p95 ms.
Everything below is judged against this number on the same spot.

## B. Daytime on a planet (sun shadows, follower blob, DMLight falloff)

Open `?perf=1`.

- [ ] Walk in full daylight. Ariel's shadow is a real sun shadow (follows the sun direction), no extra white/grey disc under her feet
      except the soft follower blob, and the blob does **not** pop on and off or lag behind her when running.
- [ ] Tree / rock / building shadows are stable while you turn the camera. No shimmering or crawling edges, no light leaking under walls.
- [ ] Walk toward and away from a lamp or lit window: the light falls off smoothly with distance. No visible ring, step or hard cut-off edge.
- [ ] Fly up out of the atmosphere and back down: no flash of black or white ground, no shadow popping at the transition.
- [ ] FPS avg >= 30, p95 <= 40 ms. Compare against baseline: the sun shadow change should cost under about 2 ms.

## C. Flashlight (real spot light with shadow)

- [ ] Night side or dusk. Tap the glasses flashlight button (next to the left stick). Cone appears, ahead of her, soft edge.
- [ ] The cone is blocked by objects: a rock or wall in front throws a shadow behind it. Move the camera/head: the shadow stays attached to the object.
- [ ] Walk past a tree line: tree shadows sweep smoothly. No flicker, no acne (speckled stripes) on flat ground, no peter-panning (shadow detached from its caster).
- [ ] First person and third person both show the beam. Switching view does not hitch.
- [ ] Step through the lumen steps (750 to 4000): brightness steps up, nothing recompiles (no freeze when tapping a step).
- [ ] Toggle on and off 10 times quickly: no hitch, no stuck beam, the button stays tappable.
- [ ] Turn it on, open the map / menu, come back: still works. Turn it on and travel to another world: the beam works there, and the old world left nothing behind.
- [ ] With `?flashshadow=0` the beam still lights things but throws no shadow (that is the A/B for cost).
- [ ] HUD: GPU shadow pass for the flashlight (if listed) <= about 1.5 ms. Only ONE flashlight shadow exists at a time.

## D. Volumetric light shafts

- [ ] Dusk or a low sun, look toward the sun through trees or past a cliff: soft shafts / in-scatter visible, not a hard-edged cone.
- [ ] Flashlight on in fog / mist / dusty air (night, mansion, Bird Temple): the beam is visible as a soft volume, brighter near the lens, fading out. It does not make a full-screen haze.
- [ ] Lamps (mansion, street lamps) have a faint glow volume. It does not strobe, band in visible rings, or "swim" when you rotate the camera.
- [ ] No black or white rectangle edges (the low-resolution buffer being upscaled): check around bright lights and silhouettes.
- [ ] Underwater / in a cave / in the mansion: no shafts where there is no air, nothing leaking through the walls.
- [ ] `?vlights=0` removes all of it cleanly with no leftover haze. Cost of shafts (HUD pass or the FPS delta vs `?vlights=0`) <= about 3 ms on the tablet.

## E. Scene changes and robustness (these catch leaks and exceptions)

Do each of these once, with the flashlight ON and `?perf=1`:

- [ ] Planet -> space -> another planet -> back. Look at the HUD "mem" / the perf log: GPU/JS memory should settle and not climb on each trip.
- [ ] Enter and leave the mansion 5 times. No white/black flash, no frozen frame, no light that stays behind in the hallway.
- [ ] Enter and leave the Bird Temple. Same.
- [ ] Rotate the device (portrait <-> landscape) with shafts and the flashlight on: no black frame, no layout break, no stretched buffer.
- [ ] Background the app 30 s and come back: rendering resumes, no console error loop.
- [ ] Open and close the planet world 10 times: memory in the HUD stays flat after the first two or three.
- [ ] Nothing throws in the console (Safari: Web Inspector over USB; Android: chrome://inspect). Search for `dm-flash`, `vlight`, `DMLight`.

## F. Low-end / fallback behaviour

- [ ] Graphics preset Low: no flashlight shadow, no shafts (or a much lighter version), sun shadow still looks plausible; 30 fps.
- [ ] Graphics preset Medium (the default for phones): flashlight shadow works at <= 1024 and does not cost more than ~2 ms.
- [ ] iPhone in Low Power Mode: the game stays playable, features degrade (the thermal / budget ladder in `ui/dm-budget.js` may drop quality).

## What to send back

1. For A, B, C, D (and each flag you toggled): avg FPS and p95 ms from the HUD, device, preset.
2. The perf log: `tools/pull-perf.sh -l` lists your sessions (newest first); `tools/pull-perf.sh -n 1 > session.json` prints the newest one,
   `tools/pull-perf.sh -n 3 -o perf-out/` saves the newest three. Needs the `gh` CLI signed in with access to your `jots-<user>` vault repository.
   Look at `summary.<screen>.avgFps / minFps / worstMs`, `gpuPasses` (per-pass GPU ms) and `hitches`.
3. Anything in section E that failed, with the exact steps and a screenshot.

## What is NOT covered by the automated tests

The node tests and headless Chromium (SwiftShader software GL, no real WebGPU timings) check: that flags parse and disable features, that
modules construct and dispose without exceptions, resource counts across repeated open/close cycles, and static budgets (light count, shadow map
size, loop bounds, literal memory). They **cannot** tell you the frame rate on the Mali or Apple GPU, how the shadow bias looks, whether the
shafts band, or thermals. Those are exactly what this checklist is for.
