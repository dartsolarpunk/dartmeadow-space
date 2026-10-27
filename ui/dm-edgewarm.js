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
  const W = window.DMEdgeWarm = { on: !/[?&]edgewarm=0\b/.test(location.search), roots: [], stats: { ticks: 0, meshes: 0, compiled: 0, textures: 0, bounds: 0, lastMs: 0, log: [] } };
  const TEX = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap', 'envMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'sheenColorMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'anisotropyMap', 'specularIntensityMap', 'specularColorMap'];
  const sig = new WeakMap();     // mesh -> last compiled signature
  const texSeen = new WeakMap(); // texture -> version uploaded
  const bndSeen = new WeakSet(); // geometry already audited
  let busy = false; const batch = []; let hist = new WeakMap(); let histAt = 0;
  W.add = function (root) { if (root && W.roots.indexOf(root) < 0) W.roots.push(root); };
  function R() { return (typeof flightRenderer !== 'undefined' && flightRenderer) || null; }
  function scene() { return (typeof flightScene !== 'undefined' && flightScene) || null; }
  function cam() { return (typeof flightCamera !== 'undefined' && flightCamera) || null; }
  function rootsNow() {
    const out = [];
    try { if (typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group && BIRD_TEMPLE.group.parent) out.push(BIRD_TEMPLE.group); } catch (e) {}
    try { if (typeof BT_CUBES !== 'undefined' && BT_CUBES.root && BT_CUBES.root.parent) out.push(BT_CUBES.root); } catch (e) {}
    for (const r of W.roots) if (r && r.parent) out.push(r);
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
  async function warmOne(r, sc, cm, o, s) {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    // 1) textures first, so the compile below finds them on the GPU (mipmaps included)
    const ts = []; for (const m of ms) if (m) texList(m, ts);
    for (const t of ts) {
      if (!t.image && !t.isRenderTargetTexture && !t.isDataTexture) continue;   // not loaded yet: next tick
      if (texSeen.get(t) === t.version) continue;
      try { r.initTexture(t); texSeen.set(t, t.version); W.stats.textures++; } catch (e) {}
      await new Promise(res => setTimeout(res, 0));   // one upload per task: a 2K map never shares a frame with another
    }
    // 2) its programs/pipelines/bindings, culling off for this one synchronous projection only
    const fc = o.frustumCulled; let p = null;
    o.frustumCulled = false;
    try { p = r.compileAsync(o, cm, sc); } catch (e) { p = null; }
    finally { o.frustumCulled = fc; }
    try { if (p) await p; } catch (e) {}
    // 3) compileAsync builds at callDepth 0 in the canvas context, but with true atmosphere the
    //    real frame draws the scene inside the atmo pass (callDepth 1, pass render target), and a
    //    transmission material's backSide pass only exists in a real draw. Measured in WebKit: those
    //    render objects (ctx3, pbackSide) were still created on first edge entry. So let this one mesh
    //    ride ONE real frame unculled while off-screen (the GPU clips it; visibility is never touched),
    //    which builds exactly the render objects the on-screen frame will use.
    if (o.visible && o.frustumCulled) batch.push(o);   // the real-context draw happens for the whole batch at once, below
    sig.set(o, s);
    const h = hist.get(o) || 0; hist.set(o, h + 1); W.stats.compiled++;
  }
  async function tick() {
    if (!W.on || busy) return; W.stats.left = 0;
    const r = R(), sc = scene(), cm = cam();
    if (!r || !sc || !cm || !r.compileAsync || !r.initTexture || r._initialized === false) return;
    if (window._warmupMs == null || (typeof _btiWarmed !== 'undefined' && !_btiWarmed && typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group)) return;   // after the flight + temple warm-ups (they compile everything once)
    if (window._dmWarming || document.hidden || (window.DMAR && DMAR.active)) return;
    busy = true; const t0 = performance.now();
    try {
      if (t0 - histAt > 60000) { hist = new WeakMap(); histAt = t0; }
      const list = pending(); W.stats.ticks++; W.stats.meshes = list.length;
      let n = 0; let work = 0;
      for (const [o, s] of list) {
        const a = performance.now();
        await warmOne(r, sc, cm, o, s);
        work += performance.now() - a;
        if (++n >= 16 || work > 12) break;   // amortized: <=12 ms of main-thread work per tick, the rest next tick
        await new Promise(res => setTimeout(res, 0));
      }
      if (batch.length) {   // ONE real frame with the batch unculled (GPU-clipped off-screen): atmo-pass + backSide render objects
        const fc = batch.map(o => o.frustumCulled); for (const o of batch) o.frustumCulled = false;
        await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        for (let i = 0; i < batch.length; i++) batch[i].frustumCulled = fc[i];
        batch.length = 0;
      }
      W.stats.left = list.length - n;
      if (n) { W.stats.log.push(new Date().toLocaleTimeString() + ' warmed ' + n + '/' + list.length); if (W.stats.log.length > 40) W.stats.log.shift(); }
    } catch (e) { W.stats.err = String(e).slice(0, 120); }
    finally { busy = false; W.stats.lastMs = Math.round(performance.now() - t0); }
  }
  W.tick = tick;
  // drain fast while there is work (next tick in 60 ms), idle-poll at 400 ms otherwise
  (function loop() { tick().finally(() => setTimeout(loop, (W.stats.left > 0) ? 60 : 400)); })();
})();
