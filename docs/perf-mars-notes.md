# Mars performance pass (branch claude/perf-mars)

All numbers are HEADLESS (SwiftShader/WebGL2 backend, low preset, Valles, 640x400). They are triangle/draw-call
counts, NOT device fps. Real WebGPU on Mali-G615 / iPhone 16e was not tested.

## Measured
- Before: ~315 draws, ~912k tris/frame. Shadow pass 42 draws / 206k tris EVERY frame. 106 SkyGround tiles (271k tris),
  Ariel 186k tris (21 skinned casters), hair 147k (not touched), MC patch 63k, board 14k.
- After (tier low): 82 tiles (210k), 7 casters (147k), shadow pass 27 draws/164k only every 2nd frame
  (every 30th at ladder L4). Averaged: ~240 draws / ~727k tris (-24% draws, -20% tris).
- No sea/canopy/cloud meshes are drawn on Mars, so the ladder never had triangles to remove there.

## Root causes (measured)
- Shadow cadence never worked: WebGPURenderer ignores renderer.shadowMap.autoUpdate/needsUpdate; ShadowNode reads
  light.shadow.autoUpdate/needsUpdate. Cadence is now driven on the light.
- Governor at 4-7 fps: big-stride threshold sev2>4 meant 143 ms (3.97x budget) took 12.6 s to reach shadow L4; now 2.3 s.

## Changes
- index.html: SkyGround split K scaled by DMLod.splitK; shadow cadence on light; sun box not refit on stale-map frames;
  caster trim; half-res air pass default on mobile; far colour/normal smoothing in _build.
- ui/dm-lod.js: rows terrain.splitK [0.78,0.88,1], shadow.minExt [0.1,0.1,0]; splitScale, blurPasses, blurRGB, casterSet.
- ui/dm-budget.js: big-stride threshold 4 -> 3. tools/tests/budget-glue-sim.js adjusted (t.run(6,120)).
- ui/dm-charm.js + ui/dm-hazard.js: chest LED anchored beside the charm (cm.chestLed).
- tools/tests/perf-mars.js: 48 checks.

## Knobs
?shadowcad=0 (old every-frame shadows), ?shadowcast=all, ?farsmooth=0, ?atmohalf=0|1, ?lod=low|mobile|desktop|off.

## Findings not fixed / inferred
- Far-band stair-steps: NOT vertex colour or normals (blurring them changed nothing in the shot) and not trueAtmo.
  DMLight horizon march is off at the low tier (horSteps 0), so it is unlikely on low too. Unresolved; needs a
  device capture (try ?lod=off, ?farsmooth=0, and flat-colour terrain to bisect). Smoothing kept (cheap, no geometry change).
- Day/night: DMTime SCALE=30 -> Mars day ~49.3 min real time. Deliberate, left unchanged. Not reproduced as 1 min.
- Chest LED position (0.055 H left of charm) is from rig math, not re-verified visually after the last tweak.
- Glasses LED strips: ariel-led-strips.test passes (name regex/material match); not rendered headless with real GLB.
- Ariel 186k-tri main-pass mesh needs a LOD asset (not done). Hair belongs to another worker.
