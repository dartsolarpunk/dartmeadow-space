# Mansion LOD / "cliff builds over the windows" - evidence and fixes

Renders: `lod0-vs-lod1-facade.png` (left LOD0, right LOD1, same camera 100 m off the facade), `lod0-vs-lod1-deck.png` (deck view: LOD0 | LOD1 | LOD0 without rock).

1. LOD1 draws flat orange "glow" sheets where LOD0 has mullioned glass (glass_wall glow=detail<1; LOD0 walls with a walkable interior drop the sheet because the
   interior GLB provides the room). The interior GLB loaded at 260 m but the LOD0 swap happened at 420 m, so between 420 and 260 m the windows were empty glass and the
   lit sheets were gone. Fix: swap with hysteresis (400 in / 470 out, phones 300 / 360), interior requested at 440 m (phones 340).
2. TERRAIN.H = wrapH = max(planet ground, mansion collision grid). The marching-cubes patch, refined tessellation, sky-ground quadtree, atmosphere local height and prop
   scatter all sampled it, so each one extruded a solid column up to every roof/deck/overhang as soon as it generated near the mansion (rooms filled, windows buried,
   rocks on pier tops over the sea). Fix: F.carve (ui/dm-facilities.js) lowers the DRAWN planet ground under the GLB inside the mansion box (14 m feather);
   TERRAIN.Hg = carved field for every drawn consumer, TERRAIN.H (walking) unchanged, TERRAIN.exBox routes _pwGroundAt/Fast/Normal to the collision grid inside the box.
3. Cache: F.ver (the ?v= of the GLB / cliff json / textures) is bumped with the script (the service worker serves ?v=N cache-first forever).
