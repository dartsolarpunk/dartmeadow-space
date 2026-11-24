# DM-7 Meadowlark: parked VTOL for the Solenne undercliff hangar (t1583u, P4)

This is an original design made for Journey of the Skyboard. It is a solarpunk utility tilt-duct VTOL with four ducted fans: two large tilting wingtip ducts and two smaller fixed rear lift ducts on stub wings. It has a high wing with solar-cell inlays, a V-tail, and a wrap-around cockpit canopy. A rear cargo ramp acts as the crew/cargo door. There is also a starboard crew door panel (with a window and a cyan step light), and the landing gear is deployed (tricycle layout). The livery is ivory with a sage lower band, copper pinstripes, and a copper sun emblem. No external assets, logos or trademarks were used. Exodus served only as a quality bar.

Built procedurally in Blender 4.2.9 (headless) on Nov 17 2026, about 1:00–2:00 AM ET. The source scripts are in `src/`.

## Files
| file | what | size |
|---|---|---|
| `meadowlark.glb` | Desktop: LOD0, LOD1, LOD2, the ramp node and its animation, with 2K WebP textures embedded | see below |
| `meadowlark-1k.glb` | iOS/mobile: the same geometry with 1K WebP textures embedded | see below |
| `tex/meadowlark-{basecolor,orm,normal,emissive}-{2k,1k}.webp` | Loose texture sets, if you want to stream 2K after a 1K GLB the way the mansion does | see below |
| `renders/` | Copies of the 4 Cycles stills (the masters are in `/workspace/jots-t1516/vtol-renders/`) | |
| `src/` | build.py, bake.py, tex.py, final.py, render.py and the .blend files | |

Packaging follows the mansion (`assets/ariel-home/ariel-home.glb` / `-512.glb`): plain GLB, **EXT_texture_webp** (required), and KHR_materials_emissive_strength. There is **no Draco and no meshopt**. The shared loader (`index.html` `_getGLBLoader()`, used by `dm-facilities.js` `c.loadGLB`) does not register a Draco or Meshopt decoder. Only the bt-engineering/nova/madison modules set one up for themselves. A compressed GLB would therefore fail through the facilities path. Geometry is small anyway, about 1 MB uncompressed. If you load it through a loader that has `setMeshoptDecoder`, `gltfpack -cc` can be run later.

## Scene graph (glTF, Y-up, metres, nose toward +Z, origin = ground point under the airframe centre)
- `Meadowlark_LOD0`: the full model, including the cabin interior (liner, floor, 6 seats, crate, bulkhead light).
  - `Meadowlark_Ramp`: a child node with its pivot on the ramp hinge (glTF local position 0, 1.15, -1.4 from the LOD0 origin). Rotating it about local X opens the ramp. **Animation `RampOpen`**: 0 → 1.5 s (frames 1-37 at 24 fps), rotation about local X from 0 to −49.3° (the aft lip comes down), and the lip then touches the ground. It is exported closed, at t = 0.
- `Meadowlark_LOD1`: about 8k tris. The ramp is closed and merged in, there is no interior, and the nav lights are kept.
- `Meadowlark_LOD2`: about 1.5k tris. The ramp is closed and merged in, with no interior and no lights.
All three LOD nodes sit at the same origin. Show one at a time (the mansion uses the same pattern, `Mansion_LOD1` by name). Every node has the extra `dm_vtol: 1`.

## Dimensions (gear down, parked). The final size fits Cliffs' 'VTOL interface (final)'
The envelope from `/workspace/jots-t1516/undercliff/layout.md` is **≤ 16 m long × 12 m wide × 15 m high** (3 m clearance in the 22 × 18 m hatch and the 40 × 30 × 18 m hangar). The model is 1:1 metres, so **do not scale it**. Instead, the wingtip ducts were pulled inboard and shrunk to 0.9× to meet the 12 m width.
- Width (span, duct tip to duct tip, including nav lights): **11.97 m**
- Length (nose to tail light): **11.78 m**
- Height (to the V-tail tips): **4.41 m**
- Clearance under the 22 × 18 hatch when parked at its centre, length along L: **5.1 m fore and aft, 3.0 m each side**. In the 18 m-high hangar there is 13.6 m headroom.
- Front duct diameter is 2.12 m, rear ducts 1.6 m.
- Cabin: the floor is at 1.32 m. It has about 2.0 m headroom and is about 1.4 m wide at the floor. Ramp opening: about 1.9 m wide, 2.6 m deep. The open ramp reaches about 2.9 m aft of the hinge, which is still inside the 16 m envelope (the tail ends 4.4 m aft of the hinge).
- Gear (glTF coords): nose twin wheels at z = +3.95, mains at x = ±1.64, z = −1.45. All wheels touch y = 0.

## Placement (from layout.md)
- Parking spot (on the hangar floor): world **x −16.58, z −1223.87, y 28.75** (mansion u: −116.13, −63.42, −39.56). That is L +7.0 / W 0.0 from the hangar floor origin, right under the hatch centre.
- Heading: **nose toward world −X** (the sea, mansion +y). The GLB nose points along local **+Z**, so the yaw is rotation.y = **−π/2** (local +Z → world −X), assuming the parent group has no other rotation.
- The model origin is the ground point under the airframe centre. Put it at the parking spot with y = floor height (28.75), and the wheels sit on the floor.
- The ramp then opens toward world +X (inland, toward the stairs and lower-level door side). Keep about 3 m of floor clear there.

## Triangles
| LOD | tris |
|---|---|
| LOD0 | **22,856** (22,112 body + 744 ramp; interior about 3.1k) |
| LOD1 | **7,999** |
| LOD2 | **1,447** (as exported) |

## Material and textures
One material, `meadowlark_body`, is used on every LOD. It is single-sided (backface culled) and metal/rough PBR:
- `baseColor` (sRGB): livery, panel-line darkening, cabin and side windows, solar cells, crevice grime
- `ORM` (linear): R = baked AO (from Cycles, 48 spp), G = roughness, B = metalness. Glass is about 0.04 rough, paint 0.34-0.42, copper and leading edges are metallic.
- `normal` (tangent space, OpenGL +Y as glTF expects): panel seams, door outlines, solar cell gaps, ramp anti-slip ribs, floor grating, tyre tread
- `emissive` (sRGB) × emissiveStrength 4: red port / green starboard / white tail and fin-tip nav lights, the red top beacon, the white landing light, a cyan side LED strip and door step light, cyan LED rings inside the duct inlets, warm cabin ceiling strips, the bulkhead panel
- One shared UV atlas at about 1.03 cm/texel at 2K (2.1 cm at 1K).

| set | resolution | in GLB (WebP q82) | loose WebP |
|---|---|---|---|
| desktop | 2048² ×4 | GLB total 1.71 MB | 0.66 MB |
| iOS | 1024² ×4 | GLB total 1.31 MB | 0.26 MB |

GPU memory once decoded (RGBA8 + mips): about **85 MB for 2K** and about **21 MB for 1K**. The iOS download is about 1.3 MB, well inside the 20 MB budget. On the GPU it sits at about 21 MB because the textures are uncompressed RGBA. If that is too much on low iPhones, drop the emissive map: lights can be a vertex-colour or second material, which saves about 5 MB. Another option is a 512 set like `ariel-home-512.glb`.

## Notes and limits
- Collision is not included. Cliffs or HUD should use a box, roughly the fuselage (2.5 × 11 × 2.3 m) plus the gear, or the LOD2 mesh as data.
- The rotors are static (fans are part of LOD0). Spinning them would need the fan blades split into their own nodes, which is cheap to add if flight lands later.
- Duct tilt (cruise mode) is not rigged. The front ducts are placed vertically for VTOL/parked use.
- The cockpit interior is not modelled. The canopy glass is opaque dark reflective glass (by design, for cost).
- Decimated LODs have some UV stretching on small parts. That is fine at the distances they would be used.
