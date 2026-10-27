/* (v193) Edge warm: no hitch when a map-level object (the Bird Temple first of all) crosses the screen edge.
 *   Why: three's WebGPU renderer only (re)builds an object's render object — node graph, bindings, pipeline, and the GPU
 *   upload of any texture it has not drawn yet — inside the first frame that object passes the frustum test. The flight
 *   warm-up and the temple warm-up compile everything once, culling off. But the ship's materials keep changing after
 *   that while it is off-screen: baked light/AO maps arrive on approach (DMBtBake), the reflection set loads (BTL.loadRefl),
 *   BTL.recheck() bumps materials whose texture set changed, the layered PBR maps land (DMBtPbr), and the light-list
 *   node is reassigned. Each of those sets material.needsUpdate / a new texture, and nothing is rebuilt until the ship is
 *   on screen again — so the cost lands in the exact frame it slides in from the edge (the iPhone hitch).
 *   What: every ~0.4 s, off the frame loop, a cheap signature (material version, its textures' versions, light list,
 *   geometry) of each visible mesh under the map-level roots is compared with the last one compiled. Changed or new meshes
 *   get their new textures uploaded (renderer.initTexture, a few per tick) and are compiled with renderer.compileAsync
 *   (the mesh alone, culling off for that one synchronous call, lit by the flight scene), a few per tick — so they are
 *   ready before they are seen. Nothing about how anything looks changes; no top-level THREE allocations.
 *   Bounds: every mesh under the roots gets its bounding sphere computed here, at idle, instead of lazily inside the
 *   first frame's frustum test; meshes whose bounds are missing or smaller than their vertices get them recomputed.
 */
(function () {
  'use strict';
  const W = window.DMEdgeWarm = { on: !/[?&]edgewarm=0\b/.test(location.search), roots: [], templeOnly: /[?&]edgewarm=bt\b/.test(location.search), stats: { ticks: 0, meshes: 0, compiled: 0, textures: 0, bounds: 0, lastMs: 0, log: [] } };
  const TEX = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap', 'envMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'sheenColorMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'anisotropyMap', 'specularIntensityMap', 'specularColorMap'];
  const sig = new WeakMap();     // mesh -> last compiled signature
  const texSeen = new WeakMap(); // texture -> version uploaded
  const bndSeen = new WeakSet(); // geometry already audited
  let busy = false; const batch = [], proms = [], later = new Set(); let hist = new WeakMap(); let histAt = 0;
  // (v193) the real-context batch frame draws its meshes unculled. On mobile that frame is capped (BATCH_MOBILE) and only
  // takes meshes inside a widened view cone (about to cross an edge); the rest wait in `later` and ride a later frame
  // when they come near the view. Scratch vectors are created lazily (no top-level THREE allocations).
  const BATCH_MOBILE = 6, BATCH_DESK = 24; let _v0 = null, _v1 = null;
  function mobile() { try { return !!(typeof GFX !== 'undefined' && GFX.isMobile); } catch (e) { return false; } }
  function nearView(o, cm) {
    try {
      const T = window.THREE; if (!T) return true;
      const c = _v0 || (_v0 = new T.Vector3()), f = _v1 || (_v1 = new T.Vector3());
      const g = o.geometry; if (!g || !g.boundingSphere) return true;
      c.copy(g.boundingSphere.center).applyMatrix4(o.matrixWorld);
      const r = g.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis();
      cm.getWorldPosition(f); c.sub(f); const d = c.length(); if (d <= r) return true;
      cm.getWorldDirection(f);
      const half = (cm.fov || 60) * Math.PI / 360, hx = Math.atan(Math.tan(half) * (cm.aspect || 1));
      const cone = Math.min(Math.PI, Math.hypot(half, hx) * 1.6);   // diagonal half-angle, widened 60%
      const ang = Math.acos(Math.max(-1, Math.min(1, c.dot(f) / d))) - Math.asin(Math.min(1, r / d));
      return ang < cone;
    } catch (e) { return true; }
  }
  W.add = function (root) { if (root && W.roots.indexOf(root) < 0) W.roots.push(root); };
  function R() { return (typeof flightRenderer !== 'undefined' && flightRenderer) || null; }
  function scene() { return (typeof flightScene !== 'undefined' && flightScene) || null; }
  function cam() { return (typeof flightCamera !== 'undefined' && flightCamera) || null; }
  function rootsNow() {
    const out = [];
    try { if (typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group && BIRD_TEMPLE.group.parent) out.push(BIRD_TEMPLE.group); } catch (e) {}
    try { if (typeof BT_CUBES !== 'undefined' && BT_CUBES.root && BT_CUBES.root.parent) out.push(BT_CUBES.root); } catch (e) {}
    for (const r of W.roots) if (r && r.parent) out.push(r);
    // (v193) and every other map-level object in the flight scene (planets, galaxies, comets, water, wind): the probe saw
    // those built on edge entry too. Direct children only, minus the roots above (traverseVisible covers the rest).
    try { const sc = scene(); if (sc && !W.templeOnly) for (const c of sc.children) if (c.visible && out.indexOf(c) < 0 && !(typeof BIRD_TEMPLE !== 'undefined' && c === BIRD_TEMPLE.group)) out.push(c); } catch (e) {}
    return out;
  }
  function texList(m, out) {
    for (const k of TEX) { const t = m[k]; if (t && t.isTexture) out.push(t); }
    return out;
  }
  // Structural key, NOT material.version: DMBtPbr.tick / BTL.recheck set needsUpdate every few seconds as a no-op, and
  // reacting to the bare version made us recompile the same meshes forever. Only what changes the shader or its inputs
  // counts: node slots, flags, light list and the textures (id + version).
  const NODES = ['colorNode', 'normalNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'positionNode', 'aoNode', 'lightsNode', 'envNode', 'outputNode', 'fragmentNode', 'vertexNode', 'transmissionNode', 'iridescenceNode', 'clearcoatNode'];
  function matSig(m) {
    let s = m.id + ':' + m.type + (m.transparent ? 't' : '') + m.side + '.' + m.blending + (m.alphaTest > 0 ? 'a' : '') + (m.vertexColors ? 'v' : '') + (m.flatShading ? 'f' : '') + (m.transmission > 0 ? 'T' : '') + (m.depthWrite ? 'w' : '');
    for (const k of NODES) { const n = m[k]; if (n) s += k[0] + (n.id != null ? n.id : 1); }
    for (const k of TEX) { const t = m[k]; if (t && t.isTexture) s += '|' + k + t.id + '.' + t.version + (t.image ? 1 : 0); }
    return s;
  }
  function meshSig(o) {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    let s = (o.geometry ? o.geometry.id : 0) + ':' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0);
    for (const m of ms) if (m) s += '/' + matSig(m);
    return s;
  }
  // bounds: computed at idle (not inside a frame's frustum test); corrected when smaller than the vertices
  function fixBounds(o) {
    const g = o.geometry; if (!g || bndSeen.has(g) || o.isInstancedMesh || o.isSkinnedMesh) return;
    bndSeen.add(g);
    const p = g.attributes && g.attributes.position; if (!p || p.count === 0) return;
    const bs0 = g.boundingSphere;
    if (!bs0) { g.computeBoundingSphere(); W.stats.bounds++; return; }
    const c = bs0.center, r2 = bs0.radius * bs0.radius * 1.0001 + 1e-9; let bad = false;
    const step = Math.max(1, Math.floor(p.count / 4096));
    for (let i = 0; i < p.count; i += step) { const dx = p.getX(i) - c.x, dy = p.getY(i) - c.y, dz = p.getZ(i) - c.z; if (dx * dx + dy * dy + dz * dz > r2) { bad = true; break; } }
    if (bad) { g.computeBoundingSphere(); W.stats.bounds++; W.stats.log.push('bounds ' + (o.name || g.name || o.id)); if (W.stats.log.length > 40) W.stats.log.shift(); }
  }
  function pending() {
    const out = [];
    for (const root of rootsNow()) {
      root.traverseVisible(o => {
        if (!(o.isMesh || o.isLine || o.isPoints) || !o.material) return;
        fixBounds(o);
        const s = meshSig(o);
        if (sig.get(o) !== s && (hist.get(o) || 0) < 4) out.push([o, s]);   // >4 changes in a minute = a ticking material: leave it (guard against a recompile loop)
      });
    }
    return out;
  }
  function warmOne(r, sc, cm, o, s) {   // synchronous part only; returns the compile promise
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    // 1) textures first, so the compile below finds them on the GPU (mipmaps included)
    const ts = []; for (const m of ms) if (m) texList(m, ts);
    for (const t of ts) {
      if (t.isRenderTargetTexture || (!t.image && !t.isDataTexture)) continue;   // RT textures are the renderer's own (re-created on resize): never pre-upload   // not loaded yet: next tick
      if (texSeen.get(t) === t.version) continue;
      try { r.initTexture(t); texSeen.set(t, t.version); W.stats.textures++; } catch (e) {}
    }
    // 2) its programs/pipelines/bindings, culling off for this one synchronous projection only
    const fc = o.frustumCulled; let p = null;
    o.frustumCulled = false;
    try { p = r.compileAsync(o, cm, sc); } catch (e) { p = null; }
    finally { o.frustumCulled = fc; }
    // 3) compileAsync only builds the default pass. A transmission material's backSide pass (and any secondary
    //    pass the frame runs) only exists in a real draw; the WebKit probe saw those (energy rings, shards: pbackSide)
    //    still created on first edge entry. So the batch rides ONE real frame unculled while off-screen (GPU-clipped;
    //    .visible is never touched), building exactly the render objects the on-screen frame will use.
    if (o.visible && o.frustumCulled) later.add(o);   // the real-context draw happens for the whole batch at once, below
    sig.set(o, s);
    const h = hist.get(o) || 0; hist.set(o, h + 1); W.stats.compiled++;
    return p;
  }
  let drained = false, lastB = 0, drainT0 = 0;
  // (v197) play has started: the fly-in finished with the board mounted (INTRO.on went true then false), or the first
  // input while in flight. (STATE.screen alone is not a signal: launchFlight sets 'flight' before the scene is built.)
  let introSeen = false, flewInput = false;
  ['keydown', 'pointerdown', 'touchstart'].forEach((ev) => addEventListener(ev, () => { try { if (!flewInput && typeof STATE !== 'undefined' && STATE.screen === 'flight' && typeof boardFlight !== 'undefined' && boardFlight) flewInput = true; } catch (e) {} }, { capture: true, passive: true }));
  const introIv = setInterval(() => { try { if (typeof INTRO !== 'undefined' && INTRO.on) { introSeen = true; clearInterval(introIv); } } catch (e) {} }, 200);
  function playing() {
    if (flewInput) return true;
    try { if (typeof INTRO === 'undefined') return false; if (INTRO.on) { introSeen = true; return false; } return introSeen && typeof boardFlight !== 'undefined' && !!boardFlight; } catch (e) { return false; }
  }
  async function tick() {
    if (!W.on || busy) return; W.stats.left = 0;
    const r = R(), sc = scene(), cm = cam();
    if (!r || !sc || !cm || !r.compileAsync || !r.initTexture || r._initialized === false) return;
    if (window._warmupMs == null || (typeof _btiWarmed !== 'undefined' && !_btiWarmed && typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group)) return;   // after the flight + temple warm-ups (they compile everything once)
    if (window._dmWarming || document.hidden || (window.DMAR && DMAR.active)) return;
    busy = true; const t0 = performance.now();
    // (v197) the uncapped first drain ends when play starts (see playing()) or 45 s after it began
    if (!drained) { if (!drainT0) drainT0 = t0; if (t0 - drainT0 > 45000 || playing()) drained = true; }
    try {
      if (t0 - histAt > 60000) { hist = new WeakMap(); histAt = t0; }
      const list = pending(); W.stats.ticks++; W.stats.meshes = list.length;
      let n = 0; let work = 0;
      for (const [o, s] of list) {
        const a = performance.now();
        const p = warmOne(r, sc, cm, o, s); if (p) proms.push(p.catch(() => {}));   // pipelines compile in parallel, off the frame
        work += performance.now() - a;
        if (++n >= 24 || work > 12) break;   // amortized: <=12 ms of synchronous main-thread work per tick, the rest next tick
      }
      if (proms.length) { await Promise.all(proms); proms.length = 0; }
      { const cap = !drained ? Infinity : (mobile() ? BATCH_MOBILE : BATCH_DESK), mob = drained && mobile();   // (v193) the initial drain is uncapped (it runs before play); the cap applies after
        for (const o of later) { if (batch.length >= cap) break; if (!o.parent || !o.visible) { later.delete(o); continue; } if (!mob || nearView(o, cm)) { batch.push(o); later.delete(o); } } }
      lastB = batch.length;
      if (batch.length) {   // ONE real frame with the batch unculled (GPU-clipped off-screen): atmo-pass + backSide render objects
        const fc = batch.map(o => o.frustumCulled); for (const o of batch) o.frustumCulled = false;
        await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        for (let i = 0; i < batch.length; i++) batch[i].frustumCulled = fc[i];
        batch.length = 0;
      }
      W.stats.left = list.length - n; W.stats.later = later.size;
      if (!drained && !W.stats.left && !later.size) drained = true;
      if (n) { W.stats.log.push(new Date().toLocaleTimeString() + ' warmed ' + n + '/' + list.length); if (W.stats.log.length > 40) W.stats.log.shift(); }
    } catch (e) { W.stats.err = String(e).slice(0, 120); }
    finally { busy = false; W.stats.lastMs = Math.round(performance.now() - t0); }
  }
  W.tick = tick;
  // drain fast while there is work (next tick in 60 ms), idle-poll at 400 ms otherwise
  (function loop() { tick().finally(() => setTimeout(loop, (W.stats.left > 0 || (later.size && lastB)) ? 60 : 400)); })();
})();
