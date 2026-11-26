# Hair collision resolution (tiers) - notes

Branch `claude/hair-collision`. Solver: `hair_strands.js` (shared by the game, the menu scene, Madison, the Rig Viewer). Tests: `tools/tests/hair-collision.js`,
`tools/tests/hair-regression.js`. Close-up renders: `tools/tests/hair-shots.py`. Fit tool: `tools/hair-fit-colliders.mjs`.

## How the solver works (what was there, v357)

* Position-based dynamics on the **CPU**, one chain per *guide* (Ariel 1,415 guides x 14 points, Emma 1,500 x 16); every other strand (5,665 / 6,000 drawn) is its guide's
  rest groom plus the guide's deflection. Points 0 and 1 are pinned to the skinned scalp (Head bone frame). Per frame: 1 substep (2 when dt > 1/60, 3 at physics intensity 3),
  `iterations` = 2 constraint passes (bend, segment length), friction 0.35.
* Head: one signed-distance field in the Head-bone frame (groom file, **5 mm cells**, trilinear, int16), clearance per point = 70 % of the groom's own distance (2 mm .. 2 cm).
  Children are pushed out of it again in the ribbon vertex shader (`collide()` in the TSL ribbon graph; CPU twin in `_update`).
* Body: capsules (bone -> direct child bone + radius, plus the three capsules stored in the groom file), **last iteration only**, broad phase per 4-point chunk.
  Capsules are inflated by `hairRadius` (6 mm). **Children are not tested against capsules at all**: they ride on their guide's deflection.
* The optional GPU guide solver (`?hairgpu=1`, off by default, WebGPU only) is a line-for-line copy of this CPU step and only knows tier 0.
* Cost: `stats.simMs` is the guide solve (the ribbons are a vertex shader on the GPU path). `DMBudget` sheds it by running the solver every 3rd frame (`hairEvery`).

## What was wrong (measured against the skinned meshes, see "Verification")

* Capsules were fitted by eye: the torso capsules are centred on the spine axis, the shirt is 3-5 cm forward of it (bust), the shoulder / trapezius slope is not covered at all
  (hair rested on the capsule 6 mm above it and **inside the shirt** at the back of the shoulders), forearm / hand capsules are thin, there is no ear.
* The 5 mm SDF cannot hold an ear (a 3-5 mm sheet) - hair passes through the ears. The bun / fringe / lens problem is the same: nothing at all knows about the glasses.
* Children are not collided with capsules: a child sits up to ~1 cm from its guide, so the strand that carries the clump touches the shirt while the 7 children around it are inside it.
* Capsule pushes happen once, after the last length constraint (no relaxation afterwards), and segments are only tested at their end points.

## What changed

### Quality tiers (`params.collisionTier` > host `opts.getCollisionTier()` > 0)

| tier | name | when | what runs |
|---|---|---|---|
| 0 | Low | preset `low`, **and whenever `DMBudget.lvl('hair') >= 1`** (the budget ladder drops the tier before it slows the solver) | the v357 solver, bit-identical (Ariel golden in `hair-regression.js` passes) |
| 1 | Mid | presets `medium` / `custom` | fitted capsules (shirt / bust / shoulder / upper arm following the skinned bones), keep-out boxes (lens x2, frame bar, ears; Emma + bridge), per-point margin from the child bundle, capsules + boxes on the last iteration |
| 2 | High | presets `high` / `ultra` | Mid + capsules and boxes on **every** iteration (relaxation order), mid-segment tests (tessellation) on the last iteration, neighbour-guide separation (3 neighbours, >= 0.6 of the rest distance) |

`index.html` maps the preset in the `getCollisionTier` option of `attachHairStrands`. The GPU guide solver (`?hairgpu=1`) stays tier 0 only (it is opt-in and a line-for-line twin of the CPU step); it is skipped at tier >= 1.

### Colliders from data
`config.collision` (merged like the other config blocks, defaults = Ariel's fitted block in `HAIR_DEFAULT_CONFIG.collision`, Emma's in `emma_hair_config.json`):
`fileColliders` (false: drop the capsules stored in the groom file at tier >= 1), `margin {bundle, cap}`, `separation {neighbours, frac}`, `capsules {"1": [...], "2": [...]}`
(`{bone, a, b, r}`, bone-local, metres; or `[bone, childBone, r]` as the legacy list) and `boxes [{name, c, h, margin}]` (Head-bone frame, half extents). Per strand group:
`clusters[].collisionMargin` (scales the bundle margin) and `collisionExtra` (metres, added). The margin per guide point is `min(cap = 12 mm, widest child offset x bundle x collisionMargin) + collisionExtra`,
so a clump with fat children (Emma's fringe) is kept off the surface by its real width, and the single-width Ariel bun is not.
The fit tool (`tools/hair-fit-colliders.mjs`) prints a `collision` block from the skinned meshes; I hand-tuned the printed numbers once for both characters.

### Not changed
Head SDF resolution (5 mm): resampling a 5 mm field to a finer grid adds no information and a finer field would need a new sidecar file; the thin parts it cannot hold (ears) are boxes now.
Guide count, GLBs, `.bin` files, GPU solver, sw / `?v=` / `DM_BUILD`.

## Cost (node 22, x86 V8, `stats.simMs` = solver only, mean over idle / head turn / run / climb, 4 runs on a busy box: +-15 %)

| | Low | Mid | High |
|---|---|---|---|
| Ariel (1,415 x 14) | 4.8 ms | 5.9 ms (+22 %) | 12.1 ms (2.5x) |
| Emma (1,500 x 16) | 8.7 ms | 10.6 ms (+22 %) | 18.9 ms (2.2x) |

Breakdown (Ariel): capsules on every iteration ~ +3 ms, mid-segment ~ +1.3, separation ~ +0.3, margins + boxes + shortlist ~ +1. Mid is therefore the cost we can afford on a phone; High is for desktop /
"ultra" and is not meant for Mali-G615 / iPhone 16e. `DMBudget` hair level >= 1 returns to Low (and every 3rd frame) as before. These are x86 numbers: re-measure on the devices.

## Verification

Headless only (node + three@0.185 + real GLBs, real merged clips; SwiftShader for pictures). Nothing here was run on a device.

* `node tools/tests/hair-regression.js`: ALL OK, Ariel Low golden bit-identical.
* `node tools/tests/hair-collision.js [--quick] [--report]` (about 90 s full): per character, tiers 0 / 1 / 2, poses idle, head turn, run, climb (`climbing_up_wall`):
  solver finite; at most 5 % of guide points end a step inside their own capsules / boxes; no more guide points inside the head SDF than Low; and a **ground-truth** check: child centrelines vs the *skinned* body, shirt and glasses triangles
  (segment-triangle crossings), High -30 % or better, Mid -10 % or better, glasses cut by half. A hard "zero guide points inside" is *not* achievable with a soft 2-iteration PBD whose pins move with the head, so the test is a rate.
* Ground truth, summed over the four poses (segments crossing body + shirt + glasses): Ariel 6,872 -> 3,036 (Mid) -> 1,547 (High); Emma 8,403 -> 2,168 -> 963. Emma's fringe-through-glasses: 641 -> 29 at High.

Needs a real device: the GPU ribbon path (the shots use WebGL2 on SwiftShader), real frame times on Mali-G615 / iPhone 16e, and a look at the head-turn and run in the game camera.

## Known limits
* Emma's rest groom has roots 2-3 mm off a low-resolution scalp mesh; the remaining "scalp" crossings at rest are the data, not the solver (cannot be changed without editing the `.bin`).
* Children still ride on the guide; the margin makes the guide keep the bundle off the surface, a lone child can still brush a surface. Climb (head down the wall, shoulders up) is the worst pose at Mid.
* The boxes are Head-frame OBBs: they follow the head, not the glasses mesh itself. Fitted to the current GLBs.

## Close-ups (SwiftShader, WebGL2 ribbon path; look only)
`/home/claude/hair-collision-shots/` (not in the repo): `before_*`, `after_mid_*`, `after_high_*` for Ariel and Emma, idle front / side / back / three-quarter, head turn and run front / side / back.
Seen by eye: Emma's fringe no longer hangs across her eyes and lenses at High (it did before); Ariel's face-front strands are pushed off the lenses a little. Side effect at High: the hair outline on both characters
is rougher / more flared at the sides (neighbour separation + capsule pushes on every iteration spread the bundles), so High trades smoothness for fewer intersections. Not tuned further; worth a look on device before making High the default.

## v385: the scalp as a real collision body (branch `claude/scalp-collision-1125`)

### What was missing (measured with `tools/tests/hair-scalp.js`, skinned scalp triangles of the same frame as ground truth)
* Emma's head field (SDF in the Head frame + skin warp) is NOT the drawn scalp once the neck moves: through Emma_Land / Mount_Step 55-95 scalp vertices are 5-85 mm off the field, and 10 % of Emma_Scalp's
  vertices (neck / shoulder weighted, y < -20 mm head-local) lie below the SDF box (no scalp collision at all, even at rest). The solver's own count said 0 points inside while 60-110 guide segments crossed the mesh.
  `hair-emma-boardwalk.mjs` PASSED because it only guards a regression band (60-190 crossings) of CHILD centrelines sampled every 15 frames; guides and the ears were never measured.
* Ears (3-5 mm sheets): strand chords pass through them with both end points clear (both characters' ear keep-out boxes are tier >= 1 and point-sampled).
* Ariel's tier 1/2 solve had no closing head pass (only Emma's skin-warp branch did): points were left inside her scalp after the length / capsule passes (Running tier 1: 265 guide points behind the sheet).
* The GPU ribbon shader (the path the game really runs, WebGPU) collides children with the pre-v383 first-order warp inverse and no skin-motion gate, i.e. not what the CPU twin (and every test) does for Emma. NOT fixed here (needs a device to validate a TSL port): children now also get the guide's tangent plane on the skinned scalp, which does not depend on that inverse.

### Changes
1. `DYN` (hair_strands.js): triangles of the scalp mesh with a non-Head-weighted vertex (Emma 1,712 tris; Ariel 0) plus the scalp triangles inside the groom's `ear*` boxes (static; Ariel too) are CPU-skinned each frame from the bone matrices,
   binned in a 6 mm grid (reach 7 mm, `params.dynReach`), and every guide point (>= 1 contact gate shared with the SDF: `near()`) is pushed out of the real triangles (closest point, smooth-normal sign, one-sided rim) with the SAME clearance, soft cushion and friction as the head SDF, on the closing pass of every step, all tiers; tier 2 also tests two samples per segment.
   Each guide point stores the tangent plane it rests on; children (CPU ribbon loop and the GPU ribbon shader, same dot product) are pushed to their clearance from it. Ariel: no skinned triangles, static ears only at tier 2.
2. Closing head pass (`headOut`) now also runs with the rigid field for grooms without a skin warp at tier >= 1 (`params.headClose:false` = v379). **Intentional Ariel change** at tiers 1 / 2 (tier 0 and the v357 solve untouched): golden `v385` hashes in `ariel-probe-golden.json`, and the probe proves tier 1 with `headClose:false` is still bit-identical to main.
3. Versions: DM_BUILD / sw CACHE_NAME / hair_strands.js `?v=` -> 385. Test hooks `_fieldAt`, `_sdfBox`, `_dyn`.

### Numbers (peak crossing segments over the sampled frames of a pose; guides / children), Emma tier 2: main -> v385
idle 52 / 52 -> 23 / 66 (v384 main sample: guide 67), Running 63 / 75 -> 24 / 51, climb 95 / 206 -> 64 / 228, Mount_Step 65 / 128 -> 14 / 63, Emma_Land 97 / 202 -> 16 / 85, Emma_Climb_Hang 73 / 113 -> 39 / 102.
Boardwalk (children, tier 2) mid-motion: get-up 167 -> 108 (nape 66 -> 18), mount 155 -> 24 (nape 109 -> 3); walk-to-board is slightly WORSE (mid 99 -> 116, end 33 -> 52: side / ear region). Ariel tier 1 Running guide 401 -> 152, tier 2 128 -> 48.
Cost (x86 node, this loaded box is ~3x slower than the doc box; `stats.simMs`): Emma tier 1 32.7 -> 45.3 ms (+39 %), tier 2 52.7 -> 62.4 (+18 %); Ariel tier 1 7.5 -> 8.7 (+16 %), tier 2 17.5 -> 19.9 (+14 %). Re-measure on device.

### Still open
Emma tiers 0 / 1 children cross the ear sheets (static ears are tier 2 only; ~240-290 child segments at idle), tiers 0 / 1 are far from zero in motion for both characters (Ariel climb childX 917-1052), the GPU shader's first-order warp inverse (above), walk-to-board side crossings, and no on-device frame times.
