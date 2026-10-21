/* dm-bt-cargocam.js — camera collision for the Bird Temple cargo-bay auto-land (and the lift-off back out).
 *
 * dm-birdtemple's bayLandTick / bayOutTick only translated the camera by the board's step, so the trailing camera kept
 * its outside offset and swept straight through the hull as she flew deep into the bay. This wraps both ticks (no
 * temple code changed) and, after the original tick has moved the board:
 *   - FOLLOW view: eases the camera's offset toward "behind the board along the landing path, a little above", and
 *     aims at Ariel + board every frame, so it pans with them from the first frame instead of waiting for the end.
 *   - ORBIT view (charOrbitActive): his angle and distance are kept; only the collision below is applied.
 *   - Collision: 5 rays (centre + 4 at the camera-sphere radius, a cheap sphere-cast) from the target to the wanted
 *     camera spot through the existing TCOL grid (_shipCamClear → _tcolRayHit, the same baked temple soup the walk and
 *     the v97 board collision use; nothing rebuilt). The camera is pulled to the nearest hit minus a margin: in fast,
 *     out slowly. Inside the bay every wall, the ceiling and the deck are in TCOL, so it stays inside.
 * Cost: ≤5 grid rays per frame, only while the auto-land / lift-off sequence runs. Tuning: window.BTCAM.cfg.
 */
(function () {
  'use strict';
  const cfg = { back: 0.85, up: 0.55, follow: 3.5, margin: 0.12, radius: 0.10, minDist: 0.35, inK: 18, outK: 2.5, aimUp: 0.35 };
  const S = { cfg, dist: null, on: false, rays: 0 };
  window.BTCAM = S;
  let V = null;
  function vecs() { const T = window.THREE; V = { tgt: new T.Vector3(), want: new T.Vector3(), rel: new T.Vector3(), dir: new T.Vector3(), a: new T.Vector3(), b: new T.Vector3(), up: new T.Vector3(0, 1, 0), rel0: null }; }
  function clearDist(from, dir, d) {   // nearest TCOL hit along a thin sphere sweep from the target, world units
    let best = (typeof _shipCamClear === 'function') ? _shipCamClear(from, dir, d) : d; S.rays = 1;
    const a = V.a.copy(Math.abs(dir.y) < 0.9 ? V.up : V.a.set(1, 0, 0)).cross(dir).normalize(), b = V.b.copy(dir).cross(a).normalize();
    const r = cfg.radius;
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = V.want.copy(from).addScaledVector(a, x * r).addScaledVector(b, y * r);
      const h = _shipCamClear(o, dir, d); S.rays++; if (h < best) best = h;
    }
    return best;
  }
  function apply(dt, landing) {
    const cam = (typeof flightCamera !== 'undefined') && flightCamera, sp = window.STATE && STATE.flight;
    if (!cam || !sp || !sp.pos || typeof BIRD_TEMPLE === 'undefined' || !BIRD_TEMPLE.group) return;
    if (!V) vecs();
    if (!(dt > 0 && dt < 0.5)) dt = 1 / 60;
    // the target: Ariel standing on the board (board origin + a little up in the board's frame)
    const up = V.up.set(0, 1, 0); try { if (typeof _camUp !== 'undefined' && _camUp && _camUp.lengthSq() > 0.5) up.copy(_camUp).normalize(); } catch (e) { }
    const tgt = V.tgt.copy(sp.pos).addScaledVector(up, cfg.aimUp);
    const orbit = (typeof charOrbitActive !== 'undefined') && charOrbitActive;
    const rel = V.rel.copy(cam.position).sub(tgt);
    if (!orbit) {
      // behind the board along its heading (the landing yaw), slightly above, at the follow camera's distance
      const o = (typeof CAM_OFFSETS !== 'undefined' && CAM_OFFSETS[camMode]) || { back: 2.9, up: 1.15 };
      const fwd = V.dir.set(0, 0, -1); try { fwd.applyQuaternion(spQuat(sp)); } catch (e) { }
      const want = V.want.copy(fwd).multiplyScalar(-o.back * cfg.back).addScaledVector(up, o.up * cfg.up);
      rel.lerp(want, Math.min(1, dt * cfg.follow));
    }
    let d = rel.length(); if (d < 1e-4) return;
    const dir = V.dir.copy(rel).divideScalar(d);
    const free = Math.max(cfg.minDist * 0.3, clearDist(tgt, dir, d + cfg.margin) - cfg.margin);
    const lim = Math.min(d, free);
    if (S.dist == null) S.dist = lim;
    S.dist += (lim - S.dist) * Math.min(1, dt * (lim < S.dist ? cfg.inK : cfg.outK));
    S.dist = Math.min(S.dist, free);                       // never sit behind the hit, even mid-ease
    cam.position.copy(tgt).addScaledVector(dir, S.dist);
    cam.up.copy(up); cam.lookAt(tgt); cam.updateMatrixWorld(true);
    try { if (typeof _camRel !== 'undefined' && _camRel) _camRel.copy(cam.position).sub(sp.pos); } catch (e) { }   // flight takes over seamlessly
    S.on = true;
  }
  function hook() {
    const B = window.BTI; if (!B || !B.bayLandTick || B._camHooked) return !!(B && B._camHooked);
    B._camHooked = true;
    const land = B.bayLandTick, out = B.bayOutTick;
    B.bayLandTick = function (dt) { const r = land.apply(this, arguments); try { if (typeof SHIP_LAND !== 'undefined' && SHIP_LAND) apply(dt, true); else S.dist = null; } catch (e) { if (!S._err) { S._err = 1; console.warn('[BTCAM]', e); } } return r; };
    B.bayOutTick = function (dt) { const r = out.apply(this, arguments); try { if (B._bayOut) apply(dt, false); else S.dist = null; } catch (e) { if (!S._err) { S._err = 1; console.warn('[BTCAM]', e); } } return r; };
    return true;
  }
  // dm-birdtemple defines bayLandTick inside its bay init; hook on its ready signal, or the first time a landing begins
  if (!hook()) {
    window.addEventListener('bti:bay', hook);
    document.addEventListener('DOMContentLoaded', hook);
    window.addEventListener('load', hook);
  }
  S.hook = hook;
})();
