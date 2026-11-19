# Character select, colours and logos

Branch `claude/character-select`. Files: `ui/dm-chars.js` (registry, profile, colour + decal data model, pure), `ui/dm-decalflow.js` (staged logo flow, pure), `ui/dm-charpaint.js` (applies a look to a loaded
character: hair tint, flat / baked colour, logo projection), `ui/dm-charselect.js` + `.css` (menu wheel, 3D studio, panels), loader hooks in `index.html`
(`loadCharacterAssets`, `goScreen`, `buildSaveData` / `loadSaveData`), `hair_strands.js` (`setTint`, `groupNames`).

## Flow
Main menu "PILOT & SKYBOARD" -> `#screen-character` (card wheel) -> tap a card (or OPEN) -> studio (turntable, COLOURS, LOGOS) -> SELECT / CONTINUE -> Skyboard
builder -> game. The back arrow returns to the main menu. If the character screen is never opened the profile defaults to Ariel and the start flow is unchanged.

## Cost rules
One WebGPURenderer for thumbnails and studio, on a fresh canvas, leased and disposed about 0.9 s after the last lease. Thumbnails (200x250 webp) are rendered once,
cached in memory and `localStorage` (`dm_char_thumb_v1`), and re-rendered only when the character's look changes. Studio loop is 30 fps and stops when the studio
closes or the screen is left. Colours / logos are baked into a canvas once per change (never per frame); the game applies the look once at load.

## Registry entry (`DMChars.register({...})`)
```
id, name, tag, ready            ready:false = card shown "COMING SOON", the game falls back to Ariel with a toast
mesh, anims, clips (clip map)   GLB paths, clip-name map used by game and studio
materialFix                     'meshy' = the Meshy metalness / skin-emissive fixes (Ariel only; PBR characters leave it out)
accessories                     { necklace, glasses, chest, cloth } false = skipped safely
hair { url, config, groups }    groups = [{id,label,clusters:[solver cluster names]}], tinted with H.setTint
items { id:{ label, mesh:'<regex on sanitised node name>', mode:'flat'|'baked', atlas, defaultColor,
            decals:'planar'|'uv', spots:{ front|back|left|right:{label?, base:<metres>, snaps:[{id,label,x,y}]} } } }
```
Only declared regions are offered; `problems()` validates an entry. GLTFLoader sanitises names (`Shirt.001` -> `Shirt001`): write the regex for the sanitised name.

## Persistence
`localStorage dm_char_v1` = `{v:1,id,updated,looks:{<charId>:{colors:{'hair.<group>'|'<item>':'#rrggbb'},decals:[{id,item,spot,x,y,scale,rotation,colour,text?}]}}}`.
Rides in the save object as `character` (same autosave / vault sync as everything else; the newest `updated` wins on load). Missing / corrupt / future data -> Ariel,
default look. Unknown ids, regions, colours and decals are dropped on load.

## How colours are applied (limits)
* hair: per cluster, base hue replaced, per-strand light/dark and root->tip gradient kept (`H.setTint`, vertex colours rewritten once).
* flat items (Ariel shirt / pants): `material.color`.
* baked items (Emma shirt + pants share one cloth map): the item's UV islands are rasterised into a 1024 px copy of the map, colour replaced, baked detail kept
  (luminance ratio to the island mean, clamped 0.55..1.8). Very dark or very saturated targets lose some wrinkle contrast. Everything not in a declared region
  (skin, LED emissive, boots, glasses) is untouched.

## Shirt / pants: DEFAULT texture or a solid colour
Items with a shipped texture (`mode:'baked'`, or a flat item declaring `texture:true`) have two modes, shown in COLOURS:
* DEFAULT TEXTURE (first swatch, one tap): no colour is stored for the item, the shipped material and map are untouched (no canvas, byte for byte the shipped look).
* a colour swatch (or the custom picker): the colour overrides the texture. `colourMode:'solid'` (Emma: shirt and pants) replaces every texel of the item's UV islands by the
  flat colour; `colourMode:'tint'` replaces the base hue and keeps the baked light / dark detail (the older behaviour, the default when the key is missing). A flat item
  with `texture:true` has its material `map` set to null while a colour is chosen and restored by DEFAULT / revert / dispose.
Items without a texture (Ariel's flat shirt / pants) keep the plain `DEF` swatch and `material.color`. Stored data is unchanged: `colors[item]` present = colour, absent = default.
When the new Emma GLB ships with its own baked shirt texture: keep (or add) `mode:'baked'` with an `atlas` key (a separate map = its own atlas key, e.g. `atlas:'shirt'`), and
the mesh regex; the DEFAULT / solid logic, the decal bake and the UV overlap test (charpaint-glb) apply as they are. Nothing else here depends on that GLB.

## Logos (decals): the staged flow
`ui/dm-decalflow.js` (pure, tested by `tools/tests/decalflow-unit.js`) holds the logic, the LOGOS panel is only the view:
1. pick a logo; 2. tap a garment: a PENDING decal appears on the pilot (preview, a look = stored look + the pending decal handed to DMCharPaint, nothing is stored);
3. place it on the pad: drag the logo (snap dots), the corner handle is SIZE, the top knob is TURN (also SIZE / TURN steppers, view chips, logo colour);
   picking another logo while pending swaps the logo and keeps view, position, size, turn and colour;
4. APPLY stores it (`DMChars.addDecal`, dm_char_v1 unchanged), max 4 per garment with n/4 on the garment chips; afterwards the logo and garment stay chosen
   (+ ADD ANOTHER, or pick another logo);
RESET = default place / size 1 / turn 0 (logo, garment, view, colour kept); CANCEL drops the pending decal (also dropped, and left out of the card still, when the studio closes).
APPLIED LOGOS list: tap rows to select, DELETE SELECTED, SELECT ALL / NONE, CLEAR ALL ON <garment>; EDIT loads an applied logo into the pending slot (the stored one changes
only on SAVE). The pad shows the garment outline of the view (from the rest pose triangles facing it), a thirds grid, the other applied logos faintly, snap dots and the
pending logo with its box. Handle hit radius is 24 px (48 px target). Bakes happen on release (debounced 90 ms), never per frame.

### Logos, projection details
17 original single-colour vector marks (`DMChars.LOGOS`; 16 shapes + a text logo of up to 8 letters A-Z 0-9), max 4 per item. A decal is a projection along one of four
horizontal views (front, back, left, right): the rest-pose vertices are projected into the garment's own box, size = `spot.base` metres x scale (metres from the
character's height / 1.7), per UV texel the normal must face the view (dot > 0.3). Alpha-composited over the colour into the garment's texture, once per change.
* `decals:'uv'` (Emma): her UV islands are used as they are.
* `decals:'planar'` (Ariel, no UVs): when the first decal exists the mesh is unwelded and given a generated 4-quadrant planar UV, colour is baked into the canvas and
  the material colour set to white. Reset / clearing logos restores the original geometry.
Emma's rig turns her 180 deg from the rest pose, so her registry entry has `decalFlip:true` (views are projected in the displayed orientation). Logo colours on Emma
read slightly tinted because her cloth material multiplies the map. Limits: a logo on a seam is cut where the view changes; very large logos wrap onto the next view only where the surface still faces the axis; the sleeve spots are
small by design; wrinkles from the baked map are not applied over the logo.

## Adding things
* A character: one registry entry (data only); give it `ready:true` once its GLB, clip map and hair config load.
* A clothing item: add `items.<id>` (mesh regex, mode, defaultColor, optionally `spots`).
* A logo: add `{id,label,d}` to `LOGOS` (24x24 box, even-odd fill, ids unique); a test checks the path syntax.
* A spot / snap point: add to `items.<id>.spots.<view>.snaps` (x, y are fractions of the garment box in that view, y down).

## Tests
`tools/tests/chars-unit.js`, `charpaint-unit.js` (incl. default-texture / solid colour with fake three), `charpaint-glb.js` (real GLBs), `chardecal-unit.js` (decal model, projection, real GLB planar UV + pad outline), `decalflow-unit.js` (pending / apply / reset / auto-update / delete / pad geometry), plus
`hud-layout.js`, `build-tag.js`, `hair-regression`.

## Not done / known
Menu rock scene and launch fly-out still show Ariel; a change made while a game is already loaded shows after the next start / reload (toast says so); no
mid-session hot-swap; no stage-tap placement (the pad is used); the pad / handles / thumb feel on touch is untested on a real device; Ariel's cloth sim with the unwelded shirt / pants is verified headless only; WebGPU/WGSL paths,
performance on Mali-G615 / iPhone 16e and touch feel need a real device.
