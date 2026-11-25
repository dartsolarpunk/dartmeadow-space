// node tools/tests/lightdir-unit.js - (v385) the key star's true direction and the planet-bounce fill.
//  1. DMLightDir maths: towardStar (star NOT at the origin), shadowLightPos, worldKeyDir (open space = true direction, incl. below the horizon; ground clamp kept), bounce (colour / phase / distance / cap / direction)
//  2. the flight shadow rig as index.html writes it, run on real three Vector3 / DirectionalLight: light travels star -> board for Sol (origin) and a star off the origin (binary barycentre)
//  3. the lit face: N . (light -> surface reversed) > 0 on the face toward the star, < 0 on the far face
//  4. DMCharLook.core.foldBounce: shade-side light tints toward the planet, bounded; no-op without bounce
//  5. source guards: the old origin assumption / the space clamp are gone; PW space uses the true direction; bounce wired once; no new light / shadow map
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
globalThis.window = globalThis; globalThis.location = { search: '' };
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);
const LD = require('../../ui/dm-lightdir.js');
// 1 -------------------------------------------------------------------------
{ const o = [0, 0, 0];
  LD.towardStar([0, 0, 0], [3, 4, 0], o); ok(near(o[0], -0.6) && near(o[1], -0.8), 'star at origin: direction = -p/|p|');
  LD.towardStar([10, 0, 0], [3, 0, 0], o); ok(near(o[0], 1) && near(o[1], 0), 'star off the origin (binary barycentre): direction is to the star, not to (0,0,0)');
  LD.towardStar([1, 1, 1], [1, 1, 1], o, [0, 2, 0]); ok(near(o[1], 1), 'on the star: the fallback');
  LD.shadowLightPos([1, 2, 3], [0, 1, 0], 20, o); ok(near(o[0], 1) && near(o[1], 12) && near(o[2], 3), 'shadow light sits toward the star, half the far plane away');
  LD.worldKeyDir({ x: 0, y: -0.9, z: 0.1 }, true, o); ok(o[1] < -0.9, 'OPEN SPACE, star below the frame horizon: true direction kept (was a fixed high light)');
  LD.worldKeyDir({ x: 1, y: -0.02, z: 0 }, true, o); ok(near(o[1], -0.02 / Math.hypot(1, 0.02)), 'OPEN SPACE, star just under the horizon: not clamped to +3.4 deg');
  ok(LD.worldKeyDir({ x: 1, y: -0.5, z: 0 }, false, o) === null, 'ground / air, sun far below the horizon: caller keeps its night fallback');
  LD.worldKeyDir({ x: 1, y: 0.0, z: 0 }, false, o); ok(near(o[1], 0.06) && near(Math.hypot(o[0], o[1], o[2]), 1, 1e-9), 'ground dusk: the 3.4 deg shallow shadow is unchanged');
  LD.worldKeyDir({ x: 0, y: 3, z: 4 }, false, o); ok(near(o[1], 0.6) && near(o[2], 0.8), 'ground daylight: unchanged');
  ok(LD.worldKeyDir(null, true, o) === null, 'no direction -> null'); }
{ const out = LD.newBounce(), star = [0, 0, 0], p = [100, 0, 0];
  const mars = { x: 130, y: 0, z: 0, r: 5, col: 0xc1440e };   // behind her (from the star): night side toward her?  planet is further from the star than p: viewer sees its lit face
  LD.bounce([mars], p, star, null, out); ok(out.I > 0 && out.rgb[0] > out.rgb[2], 'a lit rust planet adds a warm (red > blue) bounce');
  ok(near(out.dir[0], 1, 1e-9), 'bounce direction is toward the planet');
  const full = out.I;
  LD.bounce([{ x: 70, y: 0, z: 0, r: 5, col: 0xc1440e }], p, star, null, out); ok(out.I < full * 0.1, 'planet between her and the star (night face toward her): phase kills the bounce');
  LD.bounce([{ x: 160, y: 0, z: 0, r: 5, col: 0xc1440e }], p, star, null, out); ok(out.I < full, 'farther planet: weaker (r/d)^2');
  LD.bounce([{ x: 130, y: 0, z: 0, r: 5, col: 0x101010 }], p, star, null, out); ok(out.I < full * 0.3, 'dark albedo: weaker');
  LD.bounce([{ x: 101, y: 0, z: 0, r: 5, col: 0xffffff }, { x: 99, y: 3, z: 0, r: 5, col: 0xffffff }], p, star, { cap: 0.1 }, out); ok(out.I <= 0.1 + 1e-12, 'capped (low intensity: no wash)');
  LD.bounce([{ x: 100, y: 0, z: 0, r: 5, col: 0xffffff }], p, star, null, out); ok(out.I === 0, 'inside a planet: nothing');
  LD.bounce([], p, star, null, out); ok(out.I === 0 && out.n === 0, 'no bodies: zero'); }
// 2 / 3 ---------------------------------------------------------------------
(async () => {
  let THREE = null; try { THREE = await import(path.join(root, 'node_modules', 'three', 'build', 'three.module.js')); } catch (e) { console.log('  (three not available: rig checks skipped)'); }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (THREE) {
    // the exact statements of the flight loop
    const code = html.match(/const _sp=_dmStarW[\s\S]*?_charShadowLight\.position\.copy\(bp\)\.addScaledVector\(dir,\(sc\.far\*0\.5\)\);/)[0];
    const rig = new Function('THREE', 'sunMesh', '_sunLight', '_charShadowLight', 'bp', 'sc', '_csDirV', '_dmStarW', code.replace(/^const _sp=_dmStarW\|\|\(_dmStarW=new THREE\.Vector3\(\)\)/, 'const _sp=(_dmStarW=new THREE.Vector3())') + '; return {dir,_sp};');
    for (const star of [[0, 0, 0], [40, -10, 25], [-300, 120, 9]]) for (const board of [[500, 20, -70], [-80, 300, 40], [0, -999, 3]]) {
      const grp = new THREE.Group(); grp.position.set(...star); const mesh = new THREE.Mesh(); grp.add(mesh); const scene = new THREE.Scene(); scene.add(grp); scene.updateMatrixWorld(true);
      const light = new THREE.DirectionalLight(0xffffff, 1); light.shadow.camera.far = 20; scene.add(light, light.target);
      const sl = new THREE.PointLight(0xffffff, 1); scene.add(sl);
      const bp = new THREE.Vector3(...board); rig(THREE, mesh, sl, light, bp, light.shadow.camera, null, null);
      light.target.position.copy(bp); scene.updateMatrixWorld(true);
      const travel = new THREE.Vector3().subVectors(light.target.getWorldPosition(new THREE.Vector3()), light.getWorldPosition(new THREE.Vector3())).normalize();   // the way the light travels
      const starToBoard = new THREE.Vector3().subVectors(bp, new THREE.Vector3(...star)).normalize();
      ok(travel.dot(starToBoard) > 0.99999, 'light travels star -> board, star ' + star + ' board ' + board);
      ok(sl.position.distanceTo(new THREE.Vector3(...star)) < 1e-9, 'the star point light follows the star');
      // lit face: a face whose normal points at the star is lit (N . -travel > 0), the far face is not
      const toStar = starToBoard.clone().negate();
      ok(toStar.dot(travel.clone().negate()) > 0.99999, 'sun-facing normal is lit'); ok(toStar.clone().negate().dot(travel.clone().negate()) < -0.99999, 'far face is in shade');
      // the shadow falls away from the star: a caster at bp, a receiver behind it along the travel
      const recv = bp.clone().addScaledVector(travel, 3); ok(recv.distanceTo(new THREE.Vector3(...star)) > bp.distanceTo(new THREE.Vector3(...star)), 'shadow lands on the side away from the star');
    }
  }
  // 4 -------------------------------------------------------------------------
  { globalThis.performance = globalThis.performance || { now: () => 0 }; const CL = require('../../ui/dm-charlook.js'); const core = CL.core || CL;
    ok(typeof core.foldBounce === 'function', 'foldBounce exported');
    const base = () => ({ dirB: [0, 0.2, -1], colB: [0.1, 0.1, 0.12] });
    const t0 = core.foldBounce(base(), null); ok(JSON.stringify(t0) === JSON.stringify(base()), 'no bounce: no change');
    const t1 = core.foldBounce(base(), { dir: [0, -1, 0], rgb: [0.08, 0.03, 0.01], I: 0.1 }); ok(t1.colB[0] > 0.1 && t1.colB[0] > t1.colB[2], 'warm bounce tints the shade fill'); ok(t1.dirB[1] < 0.2, 'fill direction eases toward the planet');
    ok(Math.hypot(...t1.dirB) > 0.999 && Math.hypot(...t1.dirB) < 1.001, 'direction stays unit');
    ok(t1.colB[0] < 0.5, 'low intensity: no wash'); }
  // 5 -------------------------------------------------------------------------
  ok(!/addScaledVector\(dir,-\(sc\.far\*0\.5\)\)/.test(html), 'the origin-assuming shadow rig is gone');
  ok(/mode==='space'&&d\)\{ const sv=TERRAIN\._shSp/.test(html) && /DMPolish\.fitSun\(sun,upSh,/.test(html), 'PW open space: the shadow box uses the true star direction');
  ok(/dm-lightdir\.js\?v=\d+/.test(html), 'dm-lightdir.js is loaded with a ?v= tag');
  ok((html.match(/_dmBounceTick\(/g) || []).length === 3, 'bounce computed by one helper, called from the flight loop and the character-look tick');
  ok(!/new THREE\.(Point|Spot|Hemisphere|Directional)Light/.test(html.match(/function _dmBounceTick[\s\S]*?\n\}\n/)[0]), 'the bounce adds no light / shadow map');
  console.log('lightdir-unit OK (' + n + ' checks)');
})().catch((e) => { console.error(e); process.exit(1); });
