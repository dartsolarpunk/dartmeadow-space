# Valles Rim annex (Track 5 / t1590): Mars facility expansion

The annex is a walkable hangar and habitat wing on the cliff top. It sits 64 u inland of the kept Valles Rim building (mars-valles). The runtime is `ui/dm-mars-facility.js`; the assets are in `assets/mars-facility/`.

- **Hangar:** 28 × 36 m, with 13 m clear height.
  - The door is 20 × 10.5 m. Its leaf slides east into a pocket frame and opens with the FUNCTION button (F key or tap).
  - Inside: a rover, cargo containers, fuel tanks, a gantry crane, high-bay lights and a pad marking.
- **Habitat:** 28 × 36 m, with 4 m clear height.
  - Rooms: airlock, spine corridor, control room, two crew cabins, med bay, mess, workshop and power room.
  - The workshop has a vehicle door into the hangar. The mess has a personnel door into the hangar.
- **Outside:** a floor-level apron and a 16 m foundation skirt. The runtime seats the floor on the highest ground in the footprint and adds a ramp when the front drops away. There is also a roof kit.

## Rebuild

```sh
BL=/home/box/apps/blender-4.2.3-linux-x64/blender
MF_OUT=/workspace/mf-out $BL -b --factory-startup -P tools/mars-facility/mf_build.py        # add "-- --no-bake" for a quick geometry pass
cp /workspace/mf-out/mf-annex{.glb,-512.glb,.json} assets/mars-facility/
$BL -b /workspace/mf-out/mf-annex.blend -P tools/mars-facility/mf_render.py -- /workspace/mf-out   # preview stills (optional)
node tools/tests/mars-facility.js
```

## How the build works

- `mf_build.py` reuses the undercliff kit (`tools/ariel-home/undercliff/uc_kit.py`).
- The textures are procedural and original, at 1K (desktop) and 512 (phones). They are a light, dust-weathered composite, concrete and a floor slab, and every material is dielectric.
- Light is baked into vertex colour for the interior only (Cycles).
- The colliders, roofs, rooms, light fixtures and door data go into `mf-annex.json`.

When the GLB or JSON changes, bump `MFV` in `ui/dm-mars-facility.js`.
