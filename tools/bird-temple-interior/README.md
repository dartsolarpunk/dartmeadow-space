# Bird Temple interior — build tools

`Bird Temple Interior.glb` = the original `Bird Temple.glb` with the interior spliced in at the glTF level
(the original file is untouched and its vertex colours are preserved).

1. `python3 textures.py`        → generates the deck-plate / sign textures into `tex/`
2. `python3 -I build_interior.py` → Blender (bpy module) builds the decks, stairs, hatch, switches → `interior_parts.glb`
3. `python3 -I splice.py "Bird Temple.glb" interior_parts.glb "Bird Temple Interior.glb"` → grafts the parts in and cuts the hatch hole in the hull

Runtime behaviour (hatch, switches, animated screens, F button, low-light mode) is in `ui/dm-birdtemple.js`;
it reads the glTF extras (`ix`, `light`, `group`) written by `build_interior.py`.
