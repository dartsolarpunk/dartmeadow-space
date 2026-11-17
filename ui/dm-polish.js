/* DMPolish — small, isolated lighting / shadow helpers for the terrain (Planet World) scene.
 * Everything here is allocation-free per frame (scratch values are made once) and every entry point
 * is optional: index.html / dm-sky.js call it behind `if(window.DMPolish)` and fall back to their old
 * behaviour, so a failed load only loses the polish.
 *
 *   DMPolish.tintSun(color, skyStyle, atmos)       once per world: the star's colour x the world's own tint
 *   DMPolish.fitSun(sun, dir, x, y, z, tight) per frame: texel-snapped, mode-sized sun shadow box
 *   DMPolish.contact(scene, x, y, z, n, h, air, vis, sky)  per frame: soft contact shadow under her
 *   DMPolish.warmFog(fogColor, camera, sunDir, day) per frame: sun-side aerial perspective at low sun
 */
(function () {
  'use strict';
  // ?sunshadow=0|1 (shared, read once): 0 = the daytime shadow changes of the lighting overhaul are OFF (old contact blob 0.52, mansion shadow as before = off on phones); 1 = mansion also casts on phones; absent = overhaul defaults
  window.DM_SUNSHADOW = (function () { try { const m = location.search.match(/[?&]sunshadow=(0|1)\b/); return m ? +m[1] : undefined; } catch (e) { return undefined; } })();
  const P = window.DMPolish = { version: 1, on: !/[?&]nopolish\b/.test(location.search) };
  const sm = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

  /* ── sun colour per world ──
     dm-sky already colours the sun by the star's spectral class; the world's own style (dm-worldstyle skyFor().sun)
     was never applied to the light. Through a dusty or thick air the sun reads warmer (Mars butterscotch, Sahara
     amber); with no air at all it is the star's bare colour, pulled toward white (nothing scatters the blue out).  */
  let _tint = null;
  P.tintSun = function (col, sk, atmos) {
    if (!P.on || !col || !window.THREE) return col;
    try {
      if (!_tint) _tint = new THREE.Color();
      if (sk && sk.sun != null) { _tint.set(sk.sun); col.multiply(_tint); }
      if (atmos === false) col.lerp(_tint.set(0xffffff), 0.3);
    } catch (e) {}
    return col;
  };

  /* ── sun shadow box ──
     Was: a fixed box that slid with her in continuous steps, so every shadow edge crawled/shimmered as she walked.
     Now: the box centre is snapped to whole shadow texels along the light's right/up axes, and on foot the box is
     tightened (about 0.62x) so the texels she actually looks at are ~1.6x denser at the same map size and the same
     draw cost — the near cascade of a two-cascade setup without a second shadow pass. Flying keeps the wide box.  */
  const S = { right: [0, 0, 0], up: [0, 0, 0], half: 0, mode: 1 };
  P.TIGHT_K = 1;   // (t1537) on-foot box factor (was 0.62)
  P._S = S;
  P.fitSun = function (sun, dir, tx, ty, tz, tight) {
    if (!P.on || !sun || !sun.shadow || !dir) return false;
    P._sunReal = (typeof performance !== 'undefined' ? performance.now() : Date.now());   // (v324) a real sun shadow map is being fitted: the contact blob steps aside
    const sh = sun.shadow, cam = sh.camera, size = (sh.mapSize && sh.mapSize.x) || 1024;
    // wanted half-extent, eased (so a mode change swims instead of popping); `wide` = the tier's own box (_sunShadowFit)
    const wide = ({ 512: 45, 1024: 70, 2048: 110, 4096: 150 })[size] || 90;
    // (t1537) on foot the box is NOT tightened any more (was 0.62x: a 28 u box on a 512 map). The map eases out inside its own box (DMLight U.sm), and past that
    // nothing shadows a roofed floor, so the tight box drew a lit ring ~17-26 u round her: the "bright circle that follows her" (deck-wide.jpg). Full box = TIGHT_K 1.
    const want = wide * (tight ? P.TIGHT_K : 1);
    if (!(S.half > 0) || Math.abs(S.half - want) > wide) S.half = want;
    S.half += (want - S.half) * 0.04;
    const hq = Math.round(S.half * 2) / 2;                       // half-metre steps: a re-fit only when it changed visibly
    if (Math.abs(cam.right - hq) > 0.01) {
      cam.left = -hq; cam.right = hq; cam.top = hq; cam.bottom = -hq; cam.updateProjectionMatrix();
      const texel = 2 * hq / size;
      sh.normalBias = Math.max(0.012, texel * 0.3);
      sh.bias = tight ? -0.00025 : -0.0004;
    }
    // light-space axes (three looks from the light to its target with up = +Y: right = up x dir)
    let rx = dir.z, rz = -dir.x;                                 // cross((0,1,0), dir)
    const rl = Math.hypot(rx, rz);
    if (rl < 1e-4) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
    // up = dir x right  (right.y = 0)
    const uX = dir.y * rz, uY = dir.z * rx - dir.x * rz, uZ = -dir.y * rx;
    const ul = Math.hypot(uX, uY, uZ) || 1;
    const texelW = 2 * hq / size;
    const a = tx * rx + tz * rz, b = (tx * uX + ty * uY + tz * uZ) / ul;
    const sa = Math.round(a / texelW) * texelW - a, sb = Math.round(b / texelW) * texelW - b;
    const nx = tx + rx * sa + (uX / ul) * sb, ny = ty + (uY / ul) * sb, nz = tz + rz * sa + (uZ / ul) * sb;
    sun.target.position.set(nx, ny, nz);
    sun.position.set(nx + dir.x * 160, ny + dir.y * 160, nz + dir.z * 160);
    sun.target.updateMatrixWorld();
    return true;
  };

  /* ── soft contact shadow ──
     One pre-built flat blob under the character group (the map's PCF edge is ~10 cm and leaves her feet
     floating; the blob is the ambient-occlusion a real foot has). Sits on the ground normal, shifts a little away
     from the sun, thins out with height (jumps) and with the light (night, overcast), and is gone in water.
     (v324) ONLY a fallback for when there is no real shadow map: it is hidden while the sun shadow is fitted (P._sunReal, set by fitSun) or the flashlight's shadow map is live
     (DMFlash.S.shadowOn).  Always a flat, neutral-black radial falloff (no colour, no ring, no animation: pinned by the ground-mark removal test). */
  let _up = null, _q = null, _n = null;
  // (t1536) the contact blob is GONE (Justin: no disc / circle under her or the board on any map, "as if never added"). The hook stays as a no-op so the game's call
  // sites keep working; a blob left in a scene by an older build (scene.userData._dmContact) is taken out and freed the first time it is seen.
  P.contact = function (scene) {
    const m = scene && scene.userData ? scene.userData._dmContact : null;
    if (m) { try { if (m.parent) m.parent.remove(m); if (m.geometry) m.geometry.dispose(); if (m.material) { if (m.material.map) m.material.map.dispose(); m.material.dispose(); } } catch (e) { } scene.userData._dmContact = null; }
  };

  /* ── aerial perspective: the haze goes amber on the sun's side at dawn / dusk, the way the dome's horizon does
     (the dome warms its sun-side horizon but the fog stayed the same blue-grey, so the far ground did not match
     the sky it fades into). Camera-forward is a cheap stand-in for the per-pixel view direction.  */
  let _wc = null, _cd = null;
  P.warmFog = function (color, camera, sunDir, day) {
    if (!P.on || !camera || !sunDir || !window.THREE) return;
    if (!_wc) { _wc = new THREE.Color(1.0, 0.56, 0.3); _cd = new THREE.Vector3(); }
    const sy = sunDir.y;
    const low = sm(0.35, 0.02, sy) * sm(-0.18, 0.0, sy);        // same window the dome uses for its sunset band
    if (low < 0.005) return;
    camera.getWorldDirection(_cd);
    const fl = Math.hypot(_cd.x, _cd.z), sl = Math.hypot(sunDir.x, sunDir.z);
    if (fl < 1e-3 || sl < 1e-3) return;
    const az = Math.max(0, (_cd.x * sunDir.x + _cd.z * sunDir.z) / (fl * sl));
    color.lerp(_wc, 0.55 * low * az * az * (0.35 + 0.65 * day));
  };
})();
