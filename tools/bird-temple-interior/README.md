# Bird Temple interior — build tools

`Bird Temple Interior.glb` = the original `Bird Temple.glb` with the interior spliced in at the glTF level
(the original file is untouched and its vertex colours are preserved).

1. `python3 textures.py`        → generates the deck-plate / sign textures into `tex/`
2. `python3 -I build_interior.py` → Blender (bpy module) builds the decks, stairs, hatch, switches → `interior_parts.glb`
3. `python3 -I splice.py "Bird Temple.glb" interior_parts.glb "Bird Temple Interior.glb"` → grafts the parts in and cuts the hatch hole in the hull

Runtime behaviour (hatch, switches, animated screens, F button, low-light mode) is in `ui/dm-birdtemple.js`;
it reads the glTF extras (`ix`, `light`, `group`) written by `build_interior.py`.

## v96 additions
- **Cargo bay** (port hull): Boolean cut through the skin, floor/ceiling flush with the decks, no doors; fly-in capture
  (`BTI.bayCapture`) auto-lands on the pad and steps off; lift-off from inside plays a cinematic exit (`BTI.runBayOut`).
- **Corridor** from the bay (stern door) up a ramp to the stair hall on deck A (clips the hull fin that crossed it).
- **Forecastle command room** (bow, left of the bay) with a big glass window in the tapered bow skin, conference screens and spinning galaxy holograms (`FX_Galaxy_*` `spin` extra).
- **Crew bunks**: 12 full-length berths (5.2 long x 2.5 wide mattress for a ~4.1-tall avatar).
- The hull skin model used for all liners is `min(38.65+0.5z, 50.81+0.4483y-0.1971z)` (measured; max error 0.15).
- `splice.py` gains plan-view / box clips (`layout.json`: `plan`, `cor_clip`) to remove hull sheets that cross the new rooms.
