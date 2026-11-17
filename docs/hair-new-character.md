# Adding a new character's strand hair

`hair_strands.js` is data-driven: one solver, any number of clusters per character. Ariel's values are the built-in default
(`HAIR_DEFAULT_CONFIG`) and her hair is verified bit-identical by `node tools/tests/hair-regression.js`.

## 1. The groom file (`characterassests/<char>/<char>_hair_strands.bin`, "DHS1")
Header JSON + arrays, written by a Blender builder (see `assets/blender/bt-engineering/build_madison_hair.py` for a procedural one).
* `count` strands, `points` K per strand (same K for the whole file; a short cluster just has shorter segments), `guides` simulated strands
  (every strand follows its nearest guide; shuffle strand order so any prefix is a uniform subset: that is what "Auto" graphics uses).
* `group[]` (uint8): the cluster id of every strand. `groups: ["name", ...]` in the header names them. Up to 255 clusters, any strand count per cluster.
* positions are in the **Head bone** frame (header `headBone`, default `Head`); optional head SDF (v2) and `colliders`.
* `color` / `gradient` / `roughness` / `fuzz`: character-wide look.

## 2. The config (cluster parameters)
Put it in the header as `config`, or pass `opts.config` from the host (opts wins). Everything is optional:
```json
{ "name": "Emma", "character": true,
  "clusters": [
    { "name": "back",  "color": [0.30,0.17,0.08], "colorJitter": [0.8,1.4], "widthScale": 1.0 },
    { "name": "bangs", "stiffBoost": 1.6, "widthScale": 0.8, "clearance": {"min": 0.001, "max": 0.01} },
    { "name": "braid", "gradient": {"root":[0.3,0.17,0.08], "tip":[0.6,0.4,0.2], "tipStart": 0.4}, "stiffBoost": 2.0, "bendBoost": 1.2 } ],
  "params": { "gravity": 6, "damping": 0.965, "widthRoot": 0.0046 },
  "body":   [["Spine01","Spine",0.11], ["Hips","Spine02",0.13]] }
```
* `clusters[i]` is group id `i`. Per cluster: `stiffBoost` (shape stiffness, default 1), `bendBoost` (default = stiffBoost), `widthScale`, `color` or `gradient`,
  `colorJitter` [lo,hi], `clearance` {min,max,scale} from the head. Missing ids/fields fall back to the defaults.
* `params`: character-wide solver params (gravity, damping, iterations, widths ...); `opts.params` still overrides.
* `body`: capsules [bone, child|null, radius] strands collide with (default: Ariel's torso / arm list).
* `name` gives the mesh name `<name>HairStrands`; `character:true` lets a character without an Ariel/Scalp mesh attach.

Not per cluster (kept per character to keep the solver light on phones): gravity, damping, wind, iterations.

## 3. Wire it
Game: `attachHairStrands(CHAR, THREE, { url, character: true, ...hostGetters })`. Rig Viewer: drop `<char>_hair_strands.bin` (+ optional config in its header) next to the model.
Check: `node tools/tests/hair-regression.js` (Ariel unchanged, multi-cluster config loads and stays finite).
