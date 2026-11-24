# t1583u P1: Solenne undercliff blockout layout

Built from main 969ae0c assets (mansion GLB, shards.json and 2K cliff maps, byte-identical to main).
- Blend: `p1-blockout.blend`. Builder: `tools/p1_build.py`. Raw numbers: `p1-layout.json`.
- Units: 1.78 u = 1 m. Mansion Blender frame: x east (along the cliff), y seaward, z up.
- Mansion is placed on Solenne at world x -80, z -1340, y0 68.31.
- **Elevations are metres relative to the lower pool deck floor** (z -18.2 u = ±0.0 m).
- D = metres into the cliff from the deck's back wall (y -2.9 u). X = metres east of the bay centre.

## VTOL interface (final)

**Hangar clear interior: 40.0 m (L) x 30.0 m (W) x 18.0 m (H).** Unchanged from the assumed 40x30x18.
- Long axis runs seaward/inland (D 7 to 47). Width runs east–west (X -80.24 to -50.24).
- Floor is at -12.0 m (z -39.56 u). Ceiling is at +6.0 m.

**Hatch clear opening: 18.0 m (east–west) x 22.0 m (seaward–inland).**
- **CHANGED from the assumed "at least 20 x 16 m".** A 20x16 opening leaves only a 14x10 m VTOL envelope at 3 m clearance, which is smaller than the 15x12 placeholder.
- Hatch rim (u): x -132.1 to -100.1, y -43.8 to -83.0.
- There are two leaves, hinged on the east and west edges, opening upward.
- A separate 2 m grated strip behind the hatch carries the scaffold stair. It is not part of the VTOL opening.

**Shaft depth**
- 4.3 m of rock and frame from the ground (+10.3 m) down to the hangar ceiling (+6.0 m).
- 22.3 m from the ground down to the hangar floor (-12.0 m). The VTOL descends this total vertical distance.

**Hangar floor origin** = centre of the hangar floor.
- Mansion frame (u): x -116.13, y -50.96, z -39.56.
- Solenne world: x -29.04, z -1223.87, y 28.75. This uses F.car ct≈0, st=1, so world x = -80 - y_u and world z = -1340 - x_u.
- Local axes: +L points inland (mansion -y, world +X), +W points east (mansion +x, world -Z), +H points up.

**VTOL parking spot**
- Centre at L +7.0 m, W 0.0 m, on the floor. This puts it directly under the hatch centre.
  - Mansion (u): x -116.13, y -63.42, z -39.56.
  - World: x -16.58, z -1223.87, y 28.75.
- **Heading: nose to the sea.** That is mansion +y, world -X, toward the hangar's seaward wall.
- The 15 x 12 x 5 placeholder sits with its 15 m length along L. It has 3.5 m clearance fore and aft and 3.0 m on each side inside the hatch footprint.

**Max VTOL envelope with about 3 m clearance on every side: 16.0 m (L) x 12.0 m (W) x 15.0 m (H).**
- The hatch limits length and width: 22 - 6 by 18 - 6.
- The hangar limits height: 18 - 3.
- The hangar floor alone would allow 34 x 24 m. The hatch is the binding limit.
- Keep the rotor disc or wingspan folded within 12 m to pass the hatch.

## Rooms (lower level, all floors at ±0.0 m = pool deck level)

| Room | X (m) | D (m) | Size W x D (m) | Clear ceiling (m) | Floor (m) |
|---|---|---|---|---|---|
| Cargo bay (full-width opening to the deck) | -32.6 to 32.6 | 0 to 14 | 65.2 x 14.0 | 7.0 | ±0.0 |
| Spine corridor | -2 to 2 | 14 to 52 | 4.0 x 38.0 | 3.8 | ±0.0 |
| Living | 2 to 18 | 14 to 28 | 16.0 x 14.0 | 3.8 | ±0.0 |
| Master kitchen + dining | -16 to -2 | 14 to 28 | 14.0 x 14.0 | 3.8 | ±0.0 |
| Workshop / garage (vehicle door to bay) | -32.6 to -16 | 14 to 28 | 16.6 x 14.0 | 4.5 | ±0.0 |
| Office | 2 to 10 | 31 to 38 | 8.0 x 7.0 | 3.6 | ±0.0 |
| Game room | 2 to 16 | 40 to 52 | 14.0 x 12.0 | 3.8 | ±0.0 |
| Guest corridor | -30 to -2 | 28 to 31 | 28.0 x 3.0 | 3.5 | ±0.0 |
| Guest 1–4 (each) | -26 to -2 | 31 to 37.5 | 6.0 x 6.5 | 3.5 | ±0.0 |
| Hangar door (end of guest corridor) | -30 | 28 to 31 | 3.0 wide x 3.0 high | n/a | ±0.0 |
| Stair run (3 m wide) | -30 to -50.24 | 28 to 31 | 20.24 run | 3 over the nosing | ±0.0 to -12.0 |
| Hangar | -80.24 to -50.24 | 7 to 47 | 30.0 x 40.0 | 18.0 | -12.0 |
| Hatch shaft (incl. 2 m scaffold strip) | -74.24 to -56.24 | 23 to 47 | 18.0 x 24.0 | open to sky | +6.0 to +10.3 |

- The lower level reaches D 52 m. The top-level workshop wing's back wall is at D 50.3 m, so the lower level runs deeper, as Justin asked.
- Other levels for reference:
  - The plateau/ground is +10.2 m.
  - The top-level hall floor is about +10.5 m.
  - The sea is -24.6 m.

## Hangar
- 40 x 30 m floor with 18 m clear height. Floor is at -12.0 m, ceiling at +6.0 m.
- At least 4.15 m of rock above it, outside the shaft.

## Stair drop (lower level to hangar)
- **12.0 m drop** in 4 flights of 17 risers: 68 risers of 0.1765 m.
- Treads are 0.26 m. There are 3 landings of 1.2 m.
- Total run is 20.24 m. The stair is 3 m wide in a tunnel.

## Scaffold stair (surface to hangar floor)
- 22.3 m drop in a zig-zag of 7 flights of 18 risers: 126 risers of 0.177 m.
- Treads are 0.26 m, landings are 1.5 m, and the stair is 1.4 m wide.
- It runs on the back (inland) wall of the shaft and hangar, in the 2 m strip behind the hatch opening, so the VTOL path stays clear.
- The top landing is at ground level beside the hatch rim.

## Hatch
- **18 x 22 m clear opening** (see VTOL interface). The frame/curb is 1 m and the leaves are 0.5 m thick.
- It sits on the open GLB plateau west of the top-level workshop wing, 8.6 m from the wing's west wall.
- The ground under the hatch varies by 0.31 m. Nearest existing lamp: path lamp at (-94, -80) u, 3.4 m from the rim.

## P2 room spec (shared kit, all rooms; helper builds game/office/guest 1-4 in p2-rooms-b.blend)

Units and frame
- Model in metres in Blender; export scale is applied at integration (1 m = 1.78 u). Floor at Z 0 = pool-deck level. Use the P1 blockout room boxes in p1-blockout.blend as the exact shell. Don't move walls or doors.
- One collection per room, named `uc_<room>` (uc_game, uc_office, uc_guest1..4). Origin at the room's floor centre. Apply all transforms. No modifiers left unapplied at hand-off.
- Doors: 1.2 x 2.6 m openings on the corridor wall, at the P1 positions. Leave the opening empty; I add the door/portal frame at integration.

Materials (reuse existing mansion textures only, no new texture sets; paths are under assets/ariel-home/tex/, all 2K WebP, colour/nrm/orm)
- `uc_rock`: the exposed cliff rock on the back wall of each room, or as a feature wall. Uses the cliff strata maps (/workspace/scratch/cliff-render/tex/strata-*-2k.png). Roughness >= 0.6, metal 0, no emissive.
- `uc_concrete`: the main walls and ceilings, using concrete-*-2k.
- `uc_slate`: floors for the wet areas, kitchen and bath nooks, using slate-*-2k.
- `uc_wood`: the floor in the living, game, office and guest rooms, plus trim and joinery, using wood-*-2k.
- `uc_dark`: frames, fixtures and furniture bases, using dark-*-2k.
- `uc_emit`: the light strips only. It's an emissive warm white (1.0, 0.85, 0.60) at strength 4, with no texture. This matches the mansion's int_emit.
- Furniture uses the same 5 materials with a UV offset or scale for variety. Don't add a new material or image.
- Principled BSDF only: Base Color, Roughness/Metallic from ORM (G=rough, B=metal), Normal map. No transmission, SSS, clearcoat or procedural nodes; it must export cleanly to glTF.

Texel density
- Wall, floor and ceiling surfaces: 512 px/m, so one 2K tile covers 4 m. Use world-aligned box-mapped UVs (Cube Projection, size 4 m), so the seams between rooms line up.
- Furniture: 512–1024 px/m. No lightmap UV needed; I'll add UV2 at bake.

Kit
- Walls are 0.25 m thick on the room side only. The rock is behind them, so no exterior faces.
- Each ceiling has a 0.3 m recessed perimeter cove, with a uc_emit strip, 0.05 m tall, inside the cove.
- The floor gets a 0.1 m uc_dark skirting.
- Bevels are 0.02 m and 1 segment at most, and only on edges at eye level.
- Floor, walls and ceiling are separate mesh objects per room: `<room>_floor`, `<room>_walls`, `<room>_ceil`, `<room>_props`.

Tri budget per room (LOD0; I make the LOD1 at 40% at integration)
- Game room: 12k (pool table, sofa, bar, wall screen as a uc_dark slab).
- Office: 6k (desk, chair, shelving).
- Each guest room: 5k (bed, side tables, wardrobe, rug as geometry).
- Shell (floor, walls and ceiling including the cove) stays under 1k per room. No subdivision surface. No hidden faces against the rock.

Lighting fixtures (style)
- The main light is the warm cove LED strip around every ceiling perimeter.
- Each room also gets 2–4 recessed downlights: a uc_dark ring plus a uc_emit disc 0.15 m across, flush with the ceiling.
- The game room also gets one pendant over the table. The office gets one desk lamp.
- No point or area lamps in the .blend for the runtime. Instead, add an empty named `L_<room>_<n>` at each fixture, with custom properties rgb=[1,0.85,0.6], reach_m=12 and k=1 (k=0.55 for the coves). I convert those to the roomlights.json format.
- Mood is warm, dim and cosy: no cold white and no coloured LEDs, except an optional 1-strip accent in the game room at (0.55, 0.75, 1.0).

Collision
- Model nothing for this. I generate the collision boxes from `<room>_floor`, `<room>_walls` and any props tagged with custom property collide=1 (use it on beds, tables and the bar).

Hand-off
- Save /workspace/jots-t1516/undercliff/p2-rooms-b.blend with textures linked by relative path, not packed.
- Write a short p2-rooms-b.md listing each collection, its tri count, its materials, and the light empties.
