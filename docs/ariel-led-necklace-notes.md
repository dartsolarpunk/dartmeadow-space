# Ariel: top-of-glasses LED strip + simulated necklace and charm (branch `claude/ariel-led-necklace`, based on v356)

## 1. LED strip (Task A)

**Files**: `characterassests/Meshy_AI_Autumn_biped_Character_output.glb` (the file `CHAR_FILES.mesh` loads; it is Ariel), `tools/ariel/add_led_strips.py` (+ `glbio.py`), `tools/tests/ariel-led-strips.test.js`.

| thing | name |
|---|---|
| node / mesh (left half = her LEFT = +x) | `LED_Top_Strip_L` |
| node / mesh (right half = -x) | `LED_Top_Strip_R` |
| materials | `LED_Top_Mat_L`, `LED_Top_Mat_R` |

* Both nodes are children of `Ariel_Armature` with `skin 0`, every vertex **100 % on the `Head` joint (index 69)**: exactly like the glasses frame `Mesh 1`. They are inserted in the armature's child list right after `Mesh.003`, so the last skinned mesh in scene order (`CHAR.skinnedMesh`) is still `Tube.023`.
* Geometry: 17.7 x 4.3 x 3.4 mm per half, 0.6 mm gap, 36 mm overall (the runtime LED casing of `ui/dm-flash.js` is 51 mm wide), 44 verts / 22 tris each, top face subdivided 3x2 and facing straight up (+y). It is measured from the frame the same way `dm-flash.js` measures it: strip bottom = casing bottom, 1.2 mm of the strip rises above the casing top, so it sits ON the casing and is still attached if the runtime casing is absent.
* Materials: `baseColorFactor` ~(0.02,0.02,0.022), metallic 0, roughness 0.55, `emissiveFactor` (0,0,0), **no `KHR_materials_unlit`** (an unlit material would ignore the emissive). Drive them like this:
  ```js
  const L = CHAR.root.getObjectByName('LED_Top_Strip_L'), R = CHAR.root.getObjectByName('LED_Top_Strip_R');
  const set = (m, hex, k) => { m.material.emissive.set(hex); m.material.emissiveIntensity = k; m.material.toneMapped = false; };   // off: set(m,0x000000,0)
  set(L, 0x00ff55, 3); set(R, 0x2a6bff, 3);        // green / blue
  ```
  three's `GLTFLoader` strips `.` and spaces from NODE names (`Tube.021` becomes `Tube021`); `LED_Top_Strip_L/R` contain neither, so `getObjectByName` finds them. Material names are not sanitised. If a node-material twin is made (DMLight.applyTree), keep `emissive` on it: the names are unchanged. Each material belongs to exactly one mesh, so setting one never colours the other.
* **How it was made**: a direct glTF patch (`python3 tools/ariel/add_led_strips.py <in.glb> <out.glb>`), not a Blender re-export, because the patch only APPENDS (2 meshes, 2 materials, 2 nodes, 12 bufferViews/accessors, +4840 bytes of BIN) and leaves every existing byte alone: verified the original BIN chunk is an exact prefix of the new one and the JSON is identical apart from the appended items (skeleton, weights, materials + KHR extensions, textures, node order/indices, hair strand files are untouched). To redo it on a new GLB run the script (it reads the glasses frame `Mesh 1` and the `Head` joint by name, refuses a file that already has the nodes). If you prefer Blender: import the GLB, add two boxes at the numbers printed by the script, give each a Principled material named as above (emissive strength 0, colour black), vertex-group 100 % `Head`, parent to the armature, export with "+Y up", keep names; compare node indices afterwards, they WILL change in a re-export.

## 2. Necklace + charm (Task B)

### What was wrong
* The GLB carries its ORIGINAL baked necklace: `Tube.021` (thin chain ring, radius ~5.2 cm round the neck base, z 1.407-1.477 m, dipping to the front) and `Charm.001` (kite, z 1.360-1.410 m, 26 x 50 mm), both bone-skinned. In the bind pose they sit just inside the shirt collar and chest top, so the shirt hides them except a speck of the charm tip and a bit of chain at the neck's side. There is no separate pre-rig sculpt or .blend of Ariel in the repos I could reach (the game repo, `DART-Skyboard/Ariel` incl. `templates/ariel-rig-viewer.html`, the local Emma work dir is another character); the baked meshes ARE the original placement and I used them as the reference.
* What you saw on v356 was the **procedural** necklace in `ui/dm-charm.js`: its anchor was `neckBone.y - 0.095 H` (= 1.23 m, below the bust) and the chain was a static tube dipping from the neck to that point, so it hung across the chest on the shirt.

### What it is now
`ui/dm-charm.js` (+ new `ui/dm-necklace-sim.js`). Node tree, all procedural, under one bone:

```
Spine (bone)                         <- upper spine: the neck / collar / chest-top all follow it (weights Spine 0.5-0.6)
 └ ArielNeckRig                      origin = neck bone head (base of the neck), axes right / up / forward; sim space
    └ ArielNecklace
       ├ ArielNecklaceChain          closed tube, 16 links x 2 rings x 5 sides, positions + normals rewritten each frame
       └ ArielKiteCharm              the kite, hinged on chain node 0
          ├ (bail torus)
          └ ArielCharmGlow           unchanged blue glow (shells + shards), still child of the kite
Spine02 (bone) > ArielCharmRig       KEPT where it was (old chest anchor), empty now: ui/dm-hazard.js parents her chest LED to DMCharm.rig
```
* The baked `Charm001` / `Tube021` meshes are hidden (`visible=false`) on attach; no GLB edit.
* Rest pose = the loop pre-rolled onto the bind-pose colliders (420 steps + mirror + 120 steps + mirror, ~30 ms once at load): it lies round the neck base on the shoulder yoke, front node on the neckline (3.2 cm above the neck bone head, 7 cm forward), the kite on the upper chest (tip 5 cm lower). Chain 0.40 m, r 2 mm; kite and glow unchanged in size.
* **Collision bodies** (`DMNecklaceSim.ARIEL.colliders`, rig frame, metres on the 1.7 m body, round cones, each END skinned with a bone -> weight table measured from the GLB's skin weights so they move exactly where her skin / shirt move):

  | name | a -> b | radius | note |
  |---|---|---|---|
  | `neck` | (0,.047,-.004) -> (0,.087,-.004) | .0546 -> .030, x-stretch .70 | oval neck + trapezius flare; follows Head 28-68 % |
  | `yoke` | (-.07,.007,0) -> (.07,.007,0) | .062 | shoulder ridge (collar top 1.462 at the sides, 1.436 front/back like the shirt rim) |
  | `chest` | (0,.007,.012) -> (0,-.113,.053) | .06 | sternum, outer shirt surface (0.07 forward at the neckline, 0.11 at the bust) |
  | `back` | (0,0,-.012) -> (0,-.12,-.02) | .065 | so the loop can never slip behind her |

* **Sim bodies**: 16 chain nodes (closed loop, PBD links, per-link radius), the charm = capsule from chain node 0 to a free tip particle (rigid link = kite height, 4x heavier than a link), body capsules, self-collision chain-chain (not within 2 links), chain-vs-charm capsule, charm tip + middle vs the body (the contact normal lays the kite flat on the chest: `placeKite` turns it to face along it). Verlet, variable-step, 10 PBD iterations, <= 3 sub-steps, friction on contacts, soft tether (3.5 %/step) to the rest pose (not the tip), runaway/NaN/teleport guard (snaps to rest).
* **Inertia** is measured relative to her ROOT (`inv(root) * rig`), 30 % of it applied: walking, turning, the riding mirror (`scale.z < 0`) and the root scale (3.26 world / 1.7 m) are NOT inertia for a chain on her neck, only her own bone motion is; gravity is the world's down expressed in the rig (`9.81 * H/1.7`), so prone / climbing / upside-down all hang correctly. Hidden body (first person) = asleep, snaps home when visible again.
* Cost: ~0.03 ms/frame in node, 0.07-0.14 ms in headless Chromium (software) for sim + tube rebuild; 2-3 bone chains of `updateWorldMatrix` per frame. Nothing allocated per frame.
* Kill switches: `?charm=0` (all), `?neckphys=0` (static rest pose, no solver). Without `ui/dm-necklace-sim.js` it falls back to the same shape, static.
* Retuning: chain length / radius / charm mass / tether / inertia in `DMNecklaceSim.ARIEL.chain` and `DEF`; collider table above. Re-measure with Blender (`bpy`): import the GLB, slice the `Shirt` + body verts per height (front depth from the neck axis, rim height by angle), and rerun `tools/tests/necklace-sim.test.js` and the shots (below).

### Where it hooks in (for the lead's `?v=` wiring)
* `index.html` line ~1086: NEW `<script src="ui/dm-necklace-sim.js?v=356" defer>` right BEFORE `ui/dm-charm.js?v=234`. The repo's `build-tag.js` test requires a numeric `?v=` on every local script, so the new tag carries the current build `356`: set both it and `dm-charm.js` to the new build when you bump. No other index.html change.
* `index.html` already calls `DMCharm.attach(CHAR)` after the GLB loads (line ~22200) and `_charmTick(dt)` -> `DMCharm.tick(dt, returning)` every frame in both loops (lines ~7232, ~19963): the physics step runs at the top of `DMCharm.tick`, regardless of the glow. No change needed.
* GLB changed (`Meshy_AI_Autumn_biped_Character_output.glb`, loaded without a `?v=`): its URL has no tag; the sw / HTTP cache needs the usual bump for a changed asset.
* NOT touched: `sw.js`, `DM_BUILD`, any other `?v=`, `ui/dm-hazard.js`, `ui/dm-hazardhud.js`, LOD.

## 3. Verification
Headless only (Node 22, Chromium + SwiftShader WebGL2 fallback, real three r185, real GLB, real `dm-charm.js`):
* `node tools/tests/ariel-led-strips.test.js` (28 checks: names, skin, geometry, structure untouched), `node tools/tests/necklace-sim.test.js` (48 checks), existing `glasses-flash.js` (70), `shield-unit.js` (118), `hair-regression.js`, `emma-assets.test.js`, `build-tag.js` all pass.
* `tools/tests/ariel-shots.py` + `ariel-shots-harness.html` render stills and run animation clips (`&anim=Running&times=0.6`) through the REAL `DMCharm.tick`: Walking, Running, Regular_Jump, Crawl, Crouch, climbing, Grab_Bar after warm-up: 0 body penetration, 0 resets, link stretch <= 29 % (worst in Grab_Bar), also with the root scaled 1.92x, turned and mirrored (identical numbers).
* Shots in `/home/claude/ariel-led-shots/` (`A_*` LED before / after / lit, `B_*` necklace before / after / poses).
* NOT verified: a real device / WebGPU path, the full game boot (`tools/dev/boot-game.py`), the cloth solver on the shirt (`ui/dm-ariel-cloth.js` displaces the shirt on the GPU; the colliders are fit to the SKINNED shirt, the cloth drape can lift it a few mm), the board stance, first-person, frame time on a phone, and how the green/blue LED looks in the live lighting.
