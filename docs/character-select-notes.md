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
Emma's rig turns her 180 deg from the rest pose, so her registry entry has `decalFlip:true` (views are projected in the displayed orientation). Logo colours on Emma
read slightly tinted because her cloth material multiplies the map. Limits: a logo on a seam is cut where the view changes; very large logos wrap onto the next view only where the surface still faces the axis; the sleeve spots are
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

## Menu world (3D backdrop) and orbit camera
`ui/dm-menuworld.js` (+ `dm-menuworld.css`, scoped to `.mw-on`). Hooks in `dm-charselect.js` are small: `buildSet` tags the plain pad/rocks `userData.dmSet` (hidden when the world is on),
`openStudio` calls `DMMenuWorld.attachStudio` (null when off / failed -> the old CSS-gradient studio), `studioFrame` calls `world.update`, `closeStudio` disposes it; the card wheel
has `startCardWorld` / `stopCardWorld` (one lease on the shared renderer, canvas parked in `#cs-bg`, paused while the studio uses it, hidden while thumbnails render).
* STUDIO: turntable on a hangar-mouth platform (plates, hazard lip, pylons, ribs, LEDs, blob contact shadow) over a procedural planet (TSL fbm continents / ocean + sun glint /
  clouds / ice / terminator / atmosphere shell), sun glare quad, 3 star shells, dust motes. The sun is placed inside the frame for the stage's aspect (`sunDirFor`) and the rim
  light follows it (`lightRig`). The rim/key/hemisphere lights are the studio's own lights (no extra lights, no shadow maps).
* CARDS: observation deck (window frame, deck plates with guide lines, consoles, hologram ring) + the same sky; camera sways and pans with the wheel scroll; DOM cards get chamfered
  HUD styling, a slow `translate` bob and a scan sweep (compositor only).
* Parallax: real distances give none, so every sky layer sits on a rig (`position = -(cam - rest) * k`, `PARALLAX_K`).
* Tiers (`tierFor`): `?menuscene=off` (flat gradient, no world, no extra GPU work), `?menuscene=low`, auto = high (desktop) / mid (mobile) dropping to low under DMBudget pressure
  (>= 4 desktop mid, >= 5 mobile low, >= 8 low). Mobile: <= 600 stars, 4 planet octaves, 2 cloud octaves, 40-seg planet, no milky band, pixel ratio <= 1.25 (low: 1.0, 260 stars, 3 octaves).
* Everything is generated (no fetches, no textures); `dispose()` frees every geometry and material; the card world is disposed on `leave()`.
* Orbit camera (all tiers): drag X turns her 360 deg; drag Y swings the camera up and over her head (pitch up to +85 deg, target rises to head height) or down to her feet
  (to -75 deg, target and distance ease to knee height / 0.5x, camera never below 0.14 m so it cannot enter the floor). Two-finger drag nudges the target height, pinch / wheel zoom
  combine with it, inertia on yaw and pitch, double-tap eases back to the default view. `DMMenuWorld.orbitRig` is pure (`tools/tests/menuworld-unit.js`).
* Look check: `python3 tools/tests/menuworld-shots.py <repo> <three-dir> <out> 'scene=studio&views=0:0.35,-75:0.35,85:2'` (SwiftShader WebGL2 fallback; not WGSL, not frame times).
