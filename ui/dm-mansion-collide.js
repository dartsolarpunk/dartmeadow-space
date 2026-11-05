/* dm-mansion-collide.js — registers Ariel's mansion SHELL with the collision world (DMCollide, ui/dm-collide-game.js) as group 'mansion'.
 *
 * What is registered: the LOD0 triangles that stand upright (walls, glass, columns, rails, posts, fins) rasterised onto 0.5 m cells by DMCollide.regObject(mode 'walls'),
 * from the lowest foundation up to 14 units above the mansion origin (roofs are not solid: she walks under them).  Cliff rock, foliage, pool water and the warm glow
 * mesh are skipped (the climb system owns cliffs; the others are not solid).  Doorways are real gaps in the geometry (door frames + lintels clear 4.4+ units against
 * her 3.1 height, verified headless by tools/tests/mansion-collide-doors.js), so the raster leaves them open.  Interior furniture is NOT registered here: the interior GLB is
 * a single merged mesh (a 'boxes' registration would be one giant box), its props are already blocked by DMMansionInt's nav obstacles (ariel-home-interior-nav.json).
 * Slots are pooled: detach() = DMCollide.dropChunk('mansion').   Off switch: ?collide=0 (DMCollide itself) or ?mcol=0 (this shell only).
 * Pure part exported for node: DMMansionCol._pure = { OPTS, SKIP, prepare }. */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' && window ? window : globalThis;
  const SKIP = /^ah_(rock|rockc|rocks|rockt|leaf|pool|warm)$/;
  const OPTS = { mode: 'walls', cell: 0.5, layer: 0.5, mat: 'stone', wallNy: 0.7, maxBoxes: 3800, maxTris: 200000, yMin: -0.2, yMax: 8, glass: m => !!(m.material && m.material.name === 'ah_glass') };
  const S = { on: !/[?&]mcol=0\b/.test((G.location && G.location.search) || ''), key: 'mansion', rec: null, state: 'idle' };
  function prepare(lod0) { let n = 0; lod0.traverse(o => { if (o.isMesh && o.material) { const sk = SKIP.test(o.material.name || ''); o.userData.noCollide = sk; if (!sk) n++; } }); return n; }
  G.DMMansionCol = {
    attach(F, rec) {
      S.rec = rec; S.state = 'idle'; if (!S.on) return;
      const C = G.DMCollide, lod0 = rec && rec.group && rec.group.userData && rec.group.userData.lod0;
      if (!C || !C.regObject || !lod0) { S.state = 'no-collide'; return; }
      try { C.dropChunk(S.key); prepare(lod0); C.regObject(S.key, lod0, OPTS); S.state = 'queued'; } catch (e) { S.state = 'error'; console.warn('[mansion-collide] attach', e); }
    },
    detach() { try { if (G.DMCollide && G.DMCollide.dropChunk) G.DMCollide.dropChunk(S.key); } catch (e) { } S.rec = null; S.state = 'idle'; },
    status() { return { on: S.on, state: S.state, boxes: G.DMCollide && G.DMCollide.groupCount ? G.DMCollide.groupCount(S.key) : -1 }; },
    _pure: { OPTS, SKIP, prepare },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = G.DMMansionCol;
})();
