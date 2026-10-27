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
  P.fitSun = function (sun, dir, tx, ty, tz, tight) {
    if (!P.on || !sun || !sun.shadow || !dir) return false;
    const sh = sun.shadow, cam = sh.camera, size = (sh.mapSize && sh.mapSize.x) || 1024;
    // wanted half-extent, eased (so a mode change swims instead of popping); `wide` = the tier's own box (_sunShadowFit)
    const wide = ({ 512: 45, 1024: 70, 2048: 110, 4096: 150 })[size] || 90;
    const want = wide * (tight ? 0.62 : 1);
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
     from the sun, thins out with height (jumps) and with the light (night, overcast), and is gone in water. */
  let _up = null, _q = null, _n = null;
  function makeBlob() {
    const T = THREE, N = 96, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const g = cv.getContext('2d'), r = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    r.addColorStop(0, 'rgba(0,0,0,0.85)'); r.addColorStop(0.35, 'rgba(0,0,0,0.5)'); r.addColorStop(0.7, 'rgba(0,0,0,0.14)'); r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, N, N);
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
    const geo = new T.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const mat = new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const m = new T.Mesh(geo, mat);
    m.name = 'DMContactShadow'; m.frustumCulled = false; m.renderOrder = 3; m.visible = false;
    m.userData.noBend = true; m.userData._gfxShadow = true; m.raycast = () => {};   // drawn flat, like her (no planet bend)
    return m;
  }
  P.contact = function (scene, x, y, z, n, height, air, vis, sky) {
    if (!P.on || !scene || !window.THREE) return;
    let m = scene.userData._dmContact;
    if (m === undefined) {
      try { m = scene.userData._dmContact = makeBlob(); scene.add(m); _up = new THREE.Vector3(0, 1, 0); _q = new THREE.Quaternion(); _n = new THREE.Vector3(); }
      catch (e) { scene.userData._dmContact = null; return; }
    }
    if (!m) return;
    const day = sky && sky.day != null ? sky.day : 1;
    // fades with height above the ground (a jump) and with the sun (night: the moon throws almost none)
    const k = vis ? Math.max(0, 1 - air / (height * 0.5)) * (0.18 + 0.82 * day) : 0;
    if (k < 0.01) { m.visible = false; return; }
    const r = height * 0.2 * (1 + Math.min(1, air / height) * 0.6);   // wider and fainter as she leaves the ground
    let nx = 0, ny = 1, nz = 0;
    if (n && isFinite(n.x + n.y + n.z)) { nx = n.x; ny = n.y; nz = n.z; }
    if (ny < 0.35) { m.visible = false; return; }                     // a wall / climb, not a floor
    _n.set(nx, ny, nz); _q.setFromUnitVectors(_up, _n);
    m.quaternion.copy(_q);
    let ox = 0, oz = 0;
    const sd = sky && sky.sunDir;
    if (sd && sd.y > 0.05) { const f = 1 / Math.max(0.3, Math.hypot(sd.x, sd.z)); ox = -sd.x * f * r * 0.12; oz = -sd.z * f * r * 0.12; }   // leans away from the sun
    m.position.set(x + ox, y + 0.05 + r * 0.04, z + oz);
    m.scale.set(r * 2.2, 1, r * 2.2);
    m.material.opacity = 0.52 * k;
    m.visible = true;
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
