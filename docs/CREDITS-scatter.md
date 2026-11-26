# Credits: biome scatter (ui/dm-biome-scatter.js, ui/dm-biome-defs.js)

The procedural biome scatter is an **independent implementation**. These are sources of *ideas* only. No code, data, node graph, mesh or texture from any of them is in this repository, and no add-on code was copied or translated (Secret Paint is GPL-3.0-or-later; nothing derived from it is included, so nothing here is bound by that licence).

## Inspiration (concepts only)

- **Secret Paint** - orencloud, <https://orencloud.art/secretpaint>, GPL-3.0-or-later. A biome as a list of plant entries with density, scale and slope / elevation / noise masks; a procedural noise distribution that stays non-destructive and can be baked to manual instances; the same biome applied to many terrains; a viewport mask so only what is seen is paid for. The scatter's JSON biome format, seed-based non-destructive placement, "bake" (the resident chunk arrays are plain data, see docs/biome-scatter.md) and the view wedge follow those ideas, written from scratch for a WebGPU / three.js engine.
- **Geo-Scatter, Plant Library, Biome Reader** - BD3D, <https://geoscatter.com>. The biome ecosystem model: reusable biomes made of library plants, each with its own masks, clustering and LOD versions.
- **Arboris** - Cgi Lab (Superhive). Procedural trees with layered wind (trunk sway, branch gust, leaf flutter) and LOD0-3. The three wind layers and the four-level LOD ladder in the scatter are an independent TSL implementation of the same layering idea.

## Assets

- The starter biomes use **procedural placeholder meshes generated in code** (cones, tubes, blobs, blades, crossed cards). No external asset is used.
- **Poly Haven** (<https://polyhaven.com>, CC0): *not used* in this branch (no HDRI / forest-leaves texture is loaded). If a Poly Haven HDRI, texture or model is added later, credit it here and in the in-game list (MENU > ABOUT, `CREDITS` in index.html) even though CC0 does not require it.

The same entry is in the in-game credits list (`CREDITS` in index.html, MENU > ABOUT) and in CREDITS.md.
