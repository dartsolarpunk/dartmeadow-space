
## Daylight / DMLight (worker: sun + probes) - NOT verified on a device or GPU

**White follower: probable root cause (code reading, no GPU available).** DMLight adds the radiance-cache *bounce* as `emissiveNode` (ui/dm-light.js applyMaterial). Emissive is not masked by the sun shadow, and the cache window is a disc centred on the camera (shader fades `wC`/`wOut` radially round `U.cam`). The bounce was `max(E,0)`: the 4-16 ray EMA estimate is zero-mean noise on flat ground, rectified into a positive mean (test 23 shows ~0.005+ mean), plus real bounce off the mansion/cliffs at full sun intensity. Result: a pale disc that follows the player and fills in sun shadows (which is also why her shadow looked faint). Nothing else positioned at the player is on by day (lamps/LED pools hidden by day, flashlight off until toggled, planet cloud shell already removed in a7755c1).
Fix: `softBounce` (soft threshold, `U.bb`=0.02) + `bounceDayScale` (`U.bk`, eased, 1 at night -> 0.22 at noon). A/B flag: `?lightbounce=0` (off) / `1` default / `>1`. If the wash is still there with `?lightbounce=0`, the cause is NOT the bounce: then try `?light=off`, then `?nopolish`.

**Smooth falloff API (pure, exported in `DMLight.core`, tested in tools/tests/light-unit.js #23):** `smooth01(a,b,v)`, `lampFalloff(d,r)` (1 at lamp, 0 at r, C1), `softBounce(b,bias)`, `bounceDayScale(sunY,day,lo)`, `hyst(state,v,on,off)`. A flashlight/volumetric cone should use `lampFalloff`-style smoothstep for radial fade and `hyst` for on/off; CPU lamp input = `DMLight.setLamps([x,y,z,r,g,b,radius]*n)` + `setLampLevel(0..1)`. Lamp CPU occlusion is now soft (no binary switch-off behind corners).

**Lamp pools (ui/dm-lamps.js):** pool mesh nodes bordering uncovered cells (drops, water, lattice end) now fade to alpha 0 and the radial alpha is smoothstep^2 - no hard cut at ledges.

**Sun shadow:** already texel-snapped, follows the player (DMPolish.fitSun, TERRAIN.sun, PCFSoft, tier map sizes 512-4096, cadence 1-3 frames). Mansion cast shadow is OFF on phones by default (59k-tri pass, ui/dm-facilities.js): flag `?sunshadow=1` enables it on phones, `?sunshadow=0` disables it everywhere. The cheap contact blob (DMPolish.contact) is stronger (opacity 0.52 -> 0.72) as the phone fallback. Interior (ui/dm-mansion-interior.js) is baked/unlit by design: no real-time shadow indoors.

**Flags:** `?light=off|low|med|high|ultra` (exists), `?lightbounce=0..`, `?sunshadow=0|1`, `?nopolish` (exists; disables fitSun/contact).
