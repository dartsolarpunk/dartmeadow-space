# Character select, colours and logos

Branch `claude/character-select`. Files: `ui/dm-chars.js` (registry, profile, colour + decal data model, pure), `ui/dm-charpaint.js` (applies a look to a loaded
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

## Logos (decals)
17 original single-colour vector marks (`DMChars.LOGOS`; 16 shapes + a text logo of up to 8 letters A-Z 0-9), max 4 per item. A decal is a projection along one of four
horizontal views (front, back, left, right): the rest-pose vertices are projected into the garment's own box, size = `spot.base` metres x scale (metres from the
character's height / 1.7), per UV texel the normal must face the view (dot > 0.3). Alpha-composited over the colour into the garment's texture, once per change.
* `decals:'uv'` (Emma): her UV islands are used as they are.
* `decals:'planar'` (Ariel, no UVs): when the first decal exists the mesh is unwelded and given a generated 4-quadrant planar UV, colour is baked into the canvas and
  the material colour set to white. Reset / clearing logos restores the original geometry.
Limits: a logo on a seam is cut where the view changes; very large logos wrap onto the next view only where the surface still faces the axis; the sleeve spots are
small by design; wrinkles from the baked map are not applied over the logo.

## Adding things
* A character: one registry entry (data only); give it `ready:true` once its GLB, clip map and hair config load.
* A clothing item: add `items.<id>` (mesh regex, mode, defaultColor, optionally `spots`).
* A logo: add `{id,label,d}` to `LOGOS` (24x24 box, even-odd fill, ids unique); a test checks the path syntax.
* A spot / snap point: add to `items.<id>.spots.<view>.snaps` (x, y are fractions of the garment box in that view, y down).

## Tests
`tools/tests/chars-unit.js`, `charpaint-unit.js`, `charpaint-glb.js` (real GLBs), `chardecal-unit.js` (decal model, projection, real GLB planar UV), plus
`hud-layout.js`, `build-tag.js`, `hair-regression`.

## Not done / known
Menu rock scene and launch fly-out still show Ariel; a change made while a game is already loaded shows after the next start / reload (toast says so); no
mid-session hot-swap; no stage-tap placement (the pad is used); Ariel's cloth sim with the unwelded shirt / pants is verified headless only; WebGPU/WGSL paths,
performance on Mali-G615 / iPhone 16e and touch feel need a real device.
