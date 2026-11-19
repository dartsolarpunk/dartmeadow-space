# Emma animation tooling
`python3 tools/emma-anim/build_emma_anims.py ARIEL_MERGED_ANIMS.glb EMMA_SKINNED.glb OUT_DIR ARIEL_CHARACTER.glb`
Retargets Ariel's clips (same bone names) to Emma by world-space delta + per-bone rest-direction swing, hips travel scaled by hip-height ratio, ground lock for locomotion; derives Emma_* clips (jump start/loop/fall/land, climb hang, in-place swim, pivot turns, idle).
Checks: `verify_fk.py`, `contact_sheet.py` (needs matplotlib), `node mixer_check.mjs OUT.glb` (three@0.185), `node tools/tests/emma-assets.test.js`, `harness/test_emma.py` (Playwright smoke test of the Ariel Rig Viewer).

## Shoulder, loop and relaxed-hand post-processing (Emma v2)
- `retarget.py CLAV_KEEP=0.15`: only 15% of the retargeted clavicle motion is kept (Ariel's clavicle rest-delta is not valid on Emma's forward T-pose). Arm world swing is unchanged, so shoulder-pivot drift vs the chest drops from up to 18 cm to <= 3 cm.
- `postfx.py loopify()`: net root travel removed, last 0.5 s crossfaded into the first pose -> `Emma_*_Loop` variants (swing, climb, climb side, ladder, grab bar) and loop-closed Talk/Think/Swim in place. Game clip names are untouched.
- `presets/relaxed_hand.json` + `postfx.apply_relaxed_hand()`: reusable relaxed-hand finger pose (15 bones/hand, progressive curl, mirrored from rest geometry), blended in per frame only while the wrist hangs below hip height; grabbing/climbing clips excluded by name.
- `harness/shots2.py`: sandbox stills at chosen clip times/views (incl. hand close-ups).

## v360 follow-up (hands, explicit tracks, jump)
- Free-hand clips get idle's exact wrist + 15 finger local rotations (constant); grabbing/climbing clips (`GRAB_CLIPS`, Emma_Climb*/loops) get `presets/grip_hand.json` fingers and keep a roll-cleaned wrist.
- `write_animation_glb(explicit_all=True)`: every clip carries a rotation track for every skeleton bone.
- `fix_jump`: Regular_Jump's ~40 deg hip yaw reduced to 20%, neck/head low-passed.
- Test: `node tools/tests/emma-clip-switch.test.mjs [glb] [three-dir]` (A then B == B from rest, crossfade, explicit tracks).
