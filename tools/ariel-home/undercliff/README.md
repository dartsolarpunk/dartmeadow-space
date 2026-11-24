# Solenne undercliff (Track 5 / t1583u): build tools

These tools rebuild the level carved into the Solenne mansion cliff behind the lower pool deck. The runtime that uses the output is `ui/dm-undercliff.js`.

The level has:
- a full-width cargo bay;
- living room, master kitchen and dining, workshop/garage, office, game room, and guest rooms 1–4;
- a hangar door and a 12 m stair down to a 40 × 30 × 18 m hangar;
- a two-leaf vehicle hatch on the plateau, with a scaffold stair inside it;
- the DM-7 Meadowlark VTOL, parked in the hangar.

## Sources
- `p1-layout.json`, `layout.md`: P1 blockout numbers in layout metres. X runs east of the bay centre, D runs into the cliff from the deck back wall, and H is height above the lower pool deck (z −18.2 u). 1 m = 1.78 u.
- `p1_build.py`: the P1 blockout. It anchors the layout to the mansion GLB and cuts the bay.
- `p2_build.py` + `uc_kit.py`: the P2 build. It makes the rooms, corridors, stair, hangar, shaft, hatch frame, lid and scaffold, and bakes the light into vertex colour. The helper rooms (game room, office, guests) come from `rooms-b/p2-rooms-b.blend`, built by `rooms-b/*.py`.
- `vtol/`: the Meadowlark VTOL sources (LOD0/1/2 and the RampOpen clip). See `vtol/README.md`.
- `uc_package.py` + `glb_tool.py`: writes the GLBs into `assets/ariel-home/`:
  - cuts the bay and hatch into `ariel-home.glb` / `ariel-home-512.glb`;
  - adds the bay hall, hatch frame, lid leaves and portal cards to them;
  - writes `ariel-home-undercliff.glb` / `-512.glb` (the zones plus the VTOL at 2K / 1K).
- `uc_nav.py`: writes `assets/ariel-home/ariel-home-undercliff-nav.json` (patches, zones, deck apron, hatch, multi-interval wall grid, light fixtures, spawns).

## Rebuild

Use Blender 4.2. Keep the output out of folders named `build`/`dist`, because the box wipes them.

```sh
BL=/home/box/apps/blender-4.2.3-linux-x64/blender
OUT=/workspace/jots-t1516/undercliff/p2-out
REPO=$(git rev-parse --show-toplevel)
UC_OUT=$OUT UC_REPO=$REPO $BL -b --factory-startup -P tools/ariel-home/undercliff/p2_build.py
python3 tools/ariel-home/undercliff/uc_package.py $OUT $REPO   # takes the pristine mansion GLBs from $OUT/orig
python3 tools/ariel-home/undercliff/uc_nav.py $OUT $REPO
node tools/tests/undercliff-walk.js                              # A* planner + 60/20 Hz walk through every room, hangar, scaffold, lid
```

`p2_build.py` still has the original `/workspace/jots-t1516/undercliff` paths as defaults. Override them with `UC_OUT` / `UC_REPO`; it expects the helper blend at `$UC_DIR/p2-rooms-b.blend`.

When the mansion GLB changes, bump `F.manVer` in `ui/dm-facilities.js`. When the nav or undercliff GLB changes, bump `UCV` in `ui/dm-undercliff.js`.
