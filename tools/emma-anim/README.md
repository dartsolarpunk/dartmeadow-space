# Emma animation tooling
`python3 tools/emma-anim/build_emma_anims.py ARIEL_MERGED_ANIMS.glb EMMA_SKINNED.glb OUT_DIR ARIEL_CHARACTER.glb`
Retargets Ariel's clips (same bone names) to Emma by world-space delta + per-bone rest-direction swing, hips travel scaled by hip-height ratio, ground lock for locomotion; derives Emma_* clips (jump start/loop/fall/land, climb hang, in-place swim, pivot turns, idle).
Checks: `verify_fk.py`, `contact_sheet.py` (needs matplotlib), `node mixer_check.mjs OUT.glb` (three@0.185), `node tools/tests/emma-assets.test.js`, `harness/test_emma.py` (Playwright smoke test of the Ariel Rig Viewer).
