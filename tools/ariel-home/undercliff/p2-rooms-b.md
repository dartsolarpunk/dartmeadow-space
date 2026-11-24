# p2-rooms-b: game room, office, guest 1-4 (helper build for Cliffs)

Blend: `/workspace/jots-t1516/undercliff/p2-rooms-b.blend`. Builder (re-runnable, deterministic seed): `tools-b/p2b_build.py`. Render script: `tools-b/p2b_render.py`. Raw numbers: `tools-b/p2b_report.json`. Backup copy: `/workspace/undercliff-rooms-b-backup/`.
Built to the **P2 room spec** in layout.md. p1-blockout.blend was only read, never written.

## Frame and hand-off
- Metres. x = X (east of bay centre), y = -D (into the cliff is -y), z = H (pool-deck floor = 0). This is the P1 mansion frame divided by 1.78 with the deck offsets removed: x_u = 1.78x, y_u = -2.9 + 1.78y, z_u = -18.2 + 1.78z.
- Checked against the P1 room boxes in u: the wall inner faces land exactly on the blockout boxes (e.g. game x 3.77..28.27, y -95.25..-74.31). The only things outside a box are the 0.25 m door reveals and the 0.3 m cove recess above the clear ceiling.
- One collection per room: `uc_game`, `uc_office`, `uc_guest1`..`uc_guest4`. Each object's origin is at its room's floor centre. Rotation is 0, scale is 1, and no modifiers are used. Collections carry `door_wall`, `door_centre_m` and `door_wh_m` custom properties.
- Objects per room: `<room>_floor`, `<room>_walls`, `<room>_ceil` (with the cove, LED strips and downlight rings/discs), `<room>_props` (decor, collide=0), plus `<room>_prop_*` objects with **collide=1** (beds, side tables, wardrobes, pool table, bar, card table, desk, shelving). Floor and walls also carry collide=1.
- Textures are linked by relative path, not packed: `//../../jots-cliffs/assets/ariel-home/tex/{concrete,slate,wood,dark}-{color,nrm,orm}-2k.webp` and `//../../scratch/cliff-render/tex/strata-*-2k.png`. Remap them to the repo's assets/ariel-home/tex at integration.
- **LOD1 is not in the file.** The spec says you make it at 40% at integration, so I left it to you.

## Materials (6, shared by every room; Principled BSDF only)
`uc_rock` (strata, ORM roughness min 0.69, metal 0), `uc_concrete`, `uc_slate`, `uc_wood`, `uc_dark` (ORM B ~0.95, so it reads as dark brass/metal), and `uc_emit` (1, 0.85, 0.6 at strength 4, no texture). Each image goes Base Color, then ORM through Separate Color (G = roughness, B = metallic), then Normal Map. There are no procedural nodes, transmission, SSS or clearcoat.
- UVs are world box projection. Walls, floors and ceilings are at 4 m per tile (512 px/m), so seams line up across rooms. Furniture is at 1-2 m per tile (1024-2048 px/m) with random per-piece UV offsets for variety. Rock UVs are rotated 90 degrees so the strata bands run horizontally. No new materials or images were made, and there's no game-room blue accent (it's optional and would need a 7th material).

## Kit as built
- Walls are room-side faces only, with no exterior faces. Door reveals are 0.25 m deep with a uc_dark threshold. Openings are 1.2 x 2.6 m and left empty for your portal frame.
- The back (deepest, -y) wall of every room is the carved `uc_rock` feature wall. It's a 6-row grid displaced 0-0.2 m **into the room only**, so nothing goes behind the blockout plane. A 0.16 m dark slot at its foot holds an upward uc_emit wash strip.
- Ceiling: 0.3 x 0.3 m recessed perimeter cove, with a 0.05 m uc_emit strip on the cove's drop face facing the wall. Downlights are a uc_dark ring plus a 0.15 m uc_emit disc, flush with the ceiling.
- Skirting is 0.1 m uc_dark on the concrete walls. Bevels are 0.02 m and 1 segment, only on table, counter and cushion tops. There's no subdivision.

## Tri counts (LOD0, triangulated)
| Collection | Shell (floor+walls+ceil) | Props | Total | Budget |
|---|---|---|---|---|
| uc_game | 374 | 2796 | **3170** | 12000 (shell <1k) |
| uc_office | 256 | 3210 | **3466** | 6000 (shell <1k) |
| uc_guest1 | 222 | 900 | **1122** | 5000 (shell <1k) |
| uc_guest2 | 222 | 900 | **1122** | 5000 (shell <1k) |
| uc_guest3 | 222 | 900 | **1122** | 5000 (shell <1k) |
| uc_guest4 | 222 | 900 | **1122** | 5000 (shell <1k) |
| **All six** | | | **11124** | 42k by spec (brief said ~60k) |

Per object:

- uc_game: `game_floor` 2, `game_walls` 258, `game_ceil` 114, `game_prop_pooltable` 498, `game_props` 1410, `game_prop_bar` 520, `game_prop_cardtable` 368
- uc_office: `office_floor` 2, `office_walls` 162, `office_ceil` 92, `office_prop_desk` 72, `office_props` 560, `office_prop_shelves` 2578
- uc_guest1: `guest1_floor` 6, `guest1_walls` 146, `guest1_ceil` 70, `guest1_props` 634, `guest1_prop_bed` 140, `guest1_prop_sidetables` 56, `guest1_prop_wardrobe` 70
- uc_guest2: `guest2_floor` 6, `guest2_walls` 146, `guest2_ceil` 70, `guest2_props` 634, `guest2_prop_bed` 140, `guest2_prop_sidetables` 56, `guest2_prop_wardrobe` 70
- uc_guest3: `guest3_floor` 6, `guest3_walls` 146, `guest3_ceil` 70, `guest3_props` 634, `guest3_prop_bed` 140, `guest3_prop_sidetables` 56, `guest3_prop_wardrobe` 70
- uc_guest4: `guest4_floor` 6, `guest4_walls` 146, `guest4_ceil` 70, `guest4_props` 634, `guest4_prop_bed` 140, `guest4_prop_sidetables` 56, `guest4_prop_wardrobe` 70

## Rooms
- **uc_game** (X 2-16, D 40-52, clear 3.8 m): door on the **west wall to the spine at D 42.0**. Pool table (slate bed, wood rails, brass pockets, rack and cue ball) at X 6, D 46.5, long axis along D, on a rug, with the linear pendant above it. The cue rack and wood batten panel are on the west wall. The east wall is the screen wall: a 5.0 x 1.8 m uc_dark slab in a wood surround, with a low media console. An L-sofa, coffee table, rug and floor lamp face it. The bar runs along the north wall from X 9.2 to 14.8: dark counter with wood top and toe-kick glow, back counter with slate top, two lit bottle shelves, and 4 stools. Also a round card table with 4 chairs at X 5.6, D 42.3, three arcade cabinets on the rock wall (warm screens) and three concrete planters.
- **uc_office** (X 2-10, D 31-38, clear 3.6 m): door on the **west wall to the spine at D 32.2**. Desk at X 6, D 35.4 (2.0 x 0.84 m) with a drawer pedestal, monitor, keyboard and desk lamp. A task chair sits behind it, facing the door. Full-height wood shelving with books runs along the east wall from D 32 to 37.2, with an under-cornice glow. Also a lounge chair and slate side table in the NE corner, a pin board on the north wall, a rug and two planters.
- **uc_guest1..4** (6 x 6.5 m, clear 3.5 m): door on the **north wall to the guest corridor**, 1.1 m in from the west wall in guests 1 and 3, mirrored east-west in guests 2 and 4. Door centres: X -24.78, -15.22, -12.78, -3.22. Each has a queen bed with its headboard (glow strip) against the rock wall, two side tables with practical lamps, a wardrobe on the side wall, a bench at the bed foot, a rug, a planter and a niche shelf. The **en-suite nook** is a 2.2 x 2.3 m slate-floored corner beside the corridor wall, behind a 2.4 m partition with a 0.9 m opening. It has a shower tray with slate wall and rain head, a floating vanity with basin, a backlit mirror (uc_dark slab) and a WC.

## Light empties (`L_<room>_<n>`, all rgb=[1,0.85,0.6], reach_m=12; k=1 point fixtures, k=0.55 strips/coves)
Positions are in metres (X, D, H). Strip empties carry `strip_len_m`, and every empty has a `kind`.

- **game**: `L_game_1` downlight (5.0, 44.0, 3.79) k=1.0; `L_game_2` downlight (5.0, 49.0, 3.79) k=1.0; `L_game_3` downlight (11.5, 44.0, 3.79) k=1.0; `L_game_4` downlight (11.5, 49.0, 3.79) k=1.0; `L_game_5` pendant (6.0, 46.5, 2.53) k=1.0; `L_game_6` floorlamp (10.3, 48.9, 1.6) k=1.0; `L_game_7` shelf_strip (12.0, 40.32, 1.43) k=0.55; `L_game_8` arcade_screens (12.4, 50.98, 1.35) k=0.55; `L_game_9` rock_wash (9.0, 51.76, 0.1) k=0.55; `L_game_10` cove (9.0, 40.42, 4.03) k=0.55; `L_game_11` cove (9.0, 51.58, 4.03) k=0.55; `L_game_12` cove (2.42, 46.0, 4.03) k=0.55; `L_game_13` cove (15.58, 46.0, 4.03) k=0.55
- **office**: `L_office_1` downlight (4.4, 33.4, 3.59) k=1.0; `L_office_2` downlight (7.6, 33.4, 3.59) k=1.0; `L_office_3` downlight (6.0, 36.2, 3.59) k=1.0; `L_office_4` desklamp (5.25, 35.05, 1.12) k=1.0; `L_office_5` shelf_strip (9.48, 34.6, 2.56) k=0.55; `L_office_6` rock_wash (6.0, 37.76, 0.1) k=0.55; `L_office_7` cove (6.0, 31.42, 3.83) k=0.55; `L_office_8` cove (6.0, 37.58, 3.83) k=0.55; `L_office_9` cove (2.42, 34.5, 3.83) k=0.55; `L_office_10` cove (9.58, 34.5, 3.83) k=0.55
- **guest1**: `L_guest1_1` downlight (-24.0, 32.6, 3.49) k=1.0; `L_guest1_2` downlight (-23.0, 35.4, 3.49) k=1.0; `L_guest1_3` vanity (-20.22, 32.82, 1.6) k=0.55; `L_guest1_4` bedside (-24.63, 37.08, 0.85) k=1.0; `L_guest1_5` bedside (-22.17, 37.08, 0.85) k=1.0; `L_guest1_6` rock_wash (-23.0, 37.26, 0.1) k=0.55; `L_guest1_7` cove (-23.0, 31.42, 3.73) k=0.55; `L_guest1_8` cove (-23.0, 37.08, 3.73) k=0.55; `L_guest1_9` cove (-25.58, 34.25, 3.73) k=0.55; `L_guest1_10` cove (-20.42, 34.25, 3.73) k=0.55
- **guest2**: `L_guest2_1` downlight (-16.0, 32.6, 3.49) k=1.0; `L_guest2_2` downlight (-17.0, 35.4, 3.49) k=1.0; `L_guest2_3` vanity (-19.78, 32.82, 1.6) k=0.55; `L_guest2_4` bedside (-17.83, 37.08, 0.85) k=1.0; `L_guest2_5` bedside (-15.37, 37.08, 0.85) k=1.0; `L_guest2_6` rock_wash (-17.0, 37.26, 0.1) k=0.55; `L_guest2_7` cove (-17.0, 31.42, 3.73) k=0.55; `L_guest2_8` cove (-17.0, 37.08, 3.73) k=0.55; `L_guest2_9` cove (-19.58, 34.25, 3.73) k=0.55; `L_guest2_10` cove (-14.42, 34.25, 3.73) k=0.55
- **guest3**: `L_guest3_1` downlight (-12.0, 32.6, 3.49) k=1.0; `L_guest3_2` downlight (-11.0, 35.4, 3.49) k=1.0; `L_guest3_3` vanity (-8.22, 32.82, 1.6) k=0.55; `L_guest3_4` bedside (-12.63, 37.08, 0.85) k=1.0; `L_guest3_5` bedside (-10.17, 37.08, 0.85) k=1.0; `L_guest3_6` rock_wash (-11.0, 37.26, 0.1) k=0.55; `L_guest3_7` cove (-11.0, 31.42, 3.73) k=0.55; `L_guest3_8` cove (-11.0, 37.08, 3.73) k=0.55; `L_guest3_9` cove (-13.58, 34.25, 3.73) k=0.55; `L_guest3_10` cove (-8.42, 34.25, 3.73) k=0.55
- **guest4**: `L_guest4_1` downlight (-4.0, 32.6, 3.49) k=1.0; `L_guest4_2` downlight (-5.0, 35.4, 3.49) k=1.0; `L_guest4_3` vanity (-7.78, 32.82, 1.6) k=0.55; `L_guest4_4` bedside (-5.83, 37.08, 0.85) k=1.0; `L_guest4_5` bedside (-3.37, 37.08, 0.85) k=1.0; `L_guest4_6` rock_wash (-5.0, 37.26, 0.1) k=0.55; `L_guest4_7` cove (-5.0, 31.42, 3.73) k=0.55; `L_guest4_8` cove (-5.0, 37.08, 3.73) k=0.55; `L_guest4_9` cove (-7.58, 34.25, 3.73) k=0.55; `L_guest4_10` cove (-2.42, 34.25, 3.73) k=0.55

## Renders (1600x900 Cycles, 64 spp + OIDN, AgX, exposure +1.2) in `p2-rooms-b-renders/`
p2b-01-game-room, p2b-02-game-room-bar, p2b-03-office, p2b-04-office-desk, p2b-05..08-guest1..4, p2b-09-guest1-ensuite, p2b-10-plan-all-rooms (top-down, ceilings hidden).
The render script adds temporary spot, point and area lamps at the empties, cove helper area lamps, and a concrete stand-in plane behind each doorway. **None of these are saved to the .blend**, which has 0 lights.

## Conflicts and notes for Cliffs
1. **Door positions.** layout.md says "doors at the P1 positions", but p1-blockout.blend has no door openings for the office, game room or guest rooms. It only has the bay doors and the hangar door. I picked the positions above (office and game on the spine wall X=2, guests on the corridor wall D=31). Please confirm, or move the opening in `<room>_walls` (it's a simple cut).
2. **Wall thickness vs. adjacent rooms.** Wall inner faces sit on the P1 boxes (layout line ±0.12 m), so the partition between neighbouring guest rooms, and between a guest room and the guest corridor, is 0.24 m, not 0.25 + 0.25. Door reveals are 0.25 m deep, so they overlap the corridor's own wall plane by 0.01 m.
3. **Clear height.** The clear ceiling matches P1 (3.8, 3.6 and 3.5 m). The cove recess goes 0.3 m above that into rock. Cover above is 4.25 m or more everywhere, per p1-layout.json.
4. **Rock wall** is on the deepest wall in every room. In the game room that's D 52, which has only 3.5 m of rock behind it (p1 report), so the relief stays inside the room.
5. Upholstery and fabric use `uc_concrete` (grey woven read) and the pool bed uses `uc_slate`, because the spec allows no fabric or felt material.
6. Tris land well under budget (~11.1k of a 42k cap). There's headroom if you want more detail; tell me which rooms.
7. The textures resolve through `/workspace/jots-cliffs/...` (your checkout, on 969ae0c, where wood-color is byte-identical to jots-cliffs-p2). If that folder is reset, the links break until remapped.
