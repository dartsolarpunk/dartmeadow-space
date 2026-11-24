# t1583u — Solenne mansion undercliff expansion (Justin, Nov 17 2026 12:56 AM ET)

Justin's words, condensed (in order):
1. The mansion looks cool, but there are TOO MANY SHARDS. Cut the shard count down, especially the lone spires and crystal-looking tips. It must read as rock.
2. LOWER DECK (the pool deck): the cliff wall behind it is blank. Open the whole back wall of that deck like a CARGO BAY, running the full width of the deck.
3. Behind the bay, carve an UNDERGROUND LOWER LEVEL into the cliff, with rooms off the bay: living spaces, game room, workshop/garage, office, master kitchen and dining, guest rooms. It runs deeper back than the top-level workshop.
4. Beyond the guest rooms, kitchen and dining, deeper still: a BIG, TALL HANGAR / underground warehouse. From the lower level you go through a hangar door, then DOWN STEPS deeper into the cliff to the hangar floor.
5. SURFACE ACCESS: on the ground level, out back behind the top-level workshop, add a HATCH big enough for a vehicle to fly in. As the player approaches, the FUNCTION button appears; activating it opens the hatch. A SCAFFOLD STAIRCASE along the hatch shaft wall leads down against the cliff wall to the hangar floor, so she can walk in from the surface.
6. A VTOL parked in the hangar: designed and textured nicely. (Being flyable is a later phase unless it's cheap.)
7. Do it in BLENDER on the latest cliff and mansion, keeping the current textures in place, and add the new rooms with lighting and textures.

## Standing rules
- No touching fly-in, sticks, seeds, saves, sign-in, the Bird Temple GLB, or walk/collision/controller code (t1536u). New collision for the rooms goes through the existing collision path as data and meshes, not by rewriting the controller.
- The deleted HOME-deck street lamp stays deleted, and the balcony LEDs stay.
- Every preset holds 30 fps. Interiors load and stream behind the bay or hatch with portal-style culling, so the outdoor view pays nothing for them. LODs, iOS 1K maps and memory budget follow #260's approach.
- Bird Temple bake atlases stay full quality.
- Exodus is the quality bar only; copy no assets.
- Version stamp is main+1 at merge, in an isolated commit. Watcher YAY on the exact SHA. One PR per phase.
- Show Justin progress renders (Blender stills) in chat at every phase.

## Suggested phases
- P0: fewer shards plus the darker, warmer rock tone (the in-flight tone PR, extended with a shard-count cut).
- P1: Blender blockout of the lower-deck cargo bay, room layout, hangar volume, stairs, surface hatch and scaffold, plus plan renders for Justin to approve layout before detailing.
- P2: Detailed rooms (PBR, lighting via real lamps and LEDs, the sun through the bay), collision, LOD and streaming.
- P3: Hangar, hatch open/close animation and FUNCTION-button interaction (coordinate with HUD for the button), scaffold stairs walkable.
- P4: VTOL model, textured and parked. Flight later.
