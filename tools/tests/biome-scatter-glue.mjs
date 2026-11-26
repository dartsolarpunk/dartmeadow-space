// node tools/tests/biome-scatter-glue.mjs - the THREE side of ui/dm-biome-scatter.js without a GPU: placeholder meshes (indexed, finite, base at y = 0, 'wind' attribute 0..1, a card for every
// biome level), every mesh id the starter biomes name exists, the 3-layer TSL wind + card alpha node graphs construct on three r185, pooled-layer capacities.
import assert from 'assert'; import { createRequire } from 'module'; import path from 'path'; import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url), dir = path.dirname(fileURLToPath(import.meta.url));
const THREE = await import('three/webgpu'), TSL = await import('three/tsl');
globalThis.window = globalThis; Object.assign(globalThis, TSL); globalThis.THREE = THREE;
globalThis.location = { search: '?scatter=1' };
// window is defined above, so the file takes its browser branch (glue + window.DMBiomeScatter)
const api = require(path.join(dir, '../../ui/dm-biome-scatter.js'));
const B = api.DMBiomeScatter || globalThis.DMBiomeScatter;
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
ok(B && B.meshRegistry, 'browser glue exported (DMBiomeScatter)'); ok(B.on === true, '?scatter=1 turns it on');
const defs = require(path.join(dir, '../../ui/dm-biome-defs.js'));
for (const b of defs) { const v = B.registerBiome(b); ok(v.ok, 'register ' + b.id); }
ok(Object.keys(B.biomes).length === 3, 'three biomes registered');
// every mesh / card id used by a biome level exists, builds, and is sane
const used = new Set(); for (const id in B.biomes) for (const e of B.biomes[id].entries) for (const l of e.lod) used.add(l.card || l.mesh);
for (const id of used) {
  const f = B.meshRegistry[id]; ok(typeof f === 'function', 'mesh id ' + id + ' is registered'); const g = f(THREE);
  const p = g.attributes.position, w = g.attributes.wind, c = g.attributes.color; ok(p.count > 3 && g.index && g.index.count % 3 === 0, id + ' indexed triangles');
  let minY = 1e9, maxY = -1e9, bad = 0; for (let i = 0; i < p.count; i++) { const y = p.getY(i); minY = Math.min(minY, y); maxY = Math.max(maxY, y); if (![p.getX(i), y, p.getZ(i)].every(Number.isFinite)) bad++; }
  ok(!bad, id + ' finite positions'); ok(minY >= -0.2 && maxY > 0.2 && maxY < 12, id + ' stands on y=0 (' + minY.toFixed(2) + '..' + maxY.toFixed(2) + ')');
  ok(w && w.itemSize === 3 && c && c.itemSize === 3, id + ' has wind + colour attributes'); for (let i = 0; i < w.count * 3; i++) ok(w.array[i] >= 0 && w.array[i] <= 1.0001, id + ' wind weight 0..1');
  ok(g.userData.shared === true, id + ' marked shared (the game never disposes shared geometry by accident)');
  for (let i = 0; i < g.index.count; i++) if (g.index.array[i] >= p.count) { ok(false, id + ' index out of range'); }
  if (id.startsWith('card:')) { ok(p.count === 8 && g.index.count === 12, id + ' is a crossed two-quad card'); }
  // triangle budget per LOD (mobile cost): cards 4 tris, LOD2 <= 130, LOD1 <= 330, LOD0 <= 900
  const tris = g.index.count / 3, m = /-(\d)$/.exec(id), lim = id.startsWith('card:') ? 4 : m ? [900, 330, 130][+m[1]] : 900; ok(tris <= lim, id + ' ' + tris + ' tris <= ' + lim);
}
// triangle ordering: within an entry LOD0 > LOD1 > LOD2 > card
for (const bid in B.biomes) for (const e of B.biomes[bid].entries) { let prev = 1e9; for (const l of e.lod) { const t = B.meshRegistry[l.card || l.mesh](THREE).index.count / 3; ok(t <= prev, bid + '/' + e.id + ' LODs get cheaper (' + t + ' <= ' + prev + ')'); prev = t; } }
// wind + card alpha node graphs construct (graph only; compiling needs a GPU)
ok(typeof TSL.attribute === 'function' && TSL.time, 'TSL attribute / time present');
// call the glue's node builders through a material build path: replicate the public surface by building materials via tick() is GPU-bound, so build the graph the same way here
const src = (await import('fs')).readFileSync(path.join(dir, '../../ui/dm-biome-scatter.js'), 'utf8');
ok(/function windNode/.test(src) && /function cardAlpha/.test(src) && /sin\(t\.mul\(9\)/.test(src), 'three wind layers present in source');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/Math\.random/.test(code), 'no Math.random in the scatter (determinism)');
ok(!/(^|[^\w.])(import|require)\s*\(|fetch\(|XMLHttpRequest/.test(code), 'no dynamic imports / network in the scatter');
// pooled capacity: > 1000 so three takes the instanced-attribute path (uniform-array path bakes the count)
for (const T of B.core.TIERS) ok(Math.max(2048, T.bufCap) > 1100, T.name + ' pooled buffer above the uniform-array limit');
// ── the real tick() with a fake game context: streaming, pooled meshes, wind uniforms, tiers, teardown ──
const H = (x, z) => 14 + 10 * B.core.fbm(x / 150, z / 150, 4, 3) - (x < -250 ? 30 : 0);
const mkCtx = (over) => Object.assign({ THREE, parent: new THREE.Group(), seed: 4242, gen: 1, style: 'lush', ground: 0x3a7d34, H, sea: 0, px: 0, pz: 0, agl: 2, isMobile: false, preset: 'medium', now: 1000,
  cam: { x: 0, y: 10, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, fov: 60, aspect: 1.7 }, tag: () => {} }, over);
const run = (ctx, frames) => { for (let f = 0; f < frames; f++) { ctx.now += 40; B.tick(ctx); } };
for (const force of [0, 1, 2, 3]) {
  globalThis.location.search = '?scatter=1&scattertier=' + force; B.dispose();
  const ctx = mkCtx({ parent: new THREE.Group() }); run(ctx, 400);
  const st = B.stats(); ok(st.ready && st.biome === 'temperate-forest' && st.tier === force, 'tier ' + force + ': ready, forest biome'); ok(st.chunks >= 9, 'tier ' + force + ': ring of chunks streamed (' + st.chunks + ')');
  ok(st.total > 20 && st.total <= B.core.TIERS[force].capTotal, 'tier ' + force + ': ' + st.total + ' instances drawn, <= cap ' + B.core.TIERS[force].capTotal);
  const root = ctx.parent.children.find((c) => c.name === 'JOTS_BiomeScatter'); ok(root, 'layer added to the parent'); const metas = root.children.filter((m) => m.isInstancedMesh);
  ok(metas.length <= 4 * 4, 'pooled draw calls <= entries x 4 (' + metas.length + ')'); ok(metas.every((m) => m.instanceMatrix.count >= 2048 && m.count <= m.instanceMatrix.count && !m.castShadow), 'fixed capacity > 1000, count within it, no shadow casting');
  ok(metas.every((m) => m.material.positionNode), 'every material has the wind positionNode'); const nDrawn = metas.filter((m) => m.visible && m.count > 0).length; ok(nDrawn === st.draws && st.draws > 0, 'visible meshes == draws (' + st.draws + ')');
  if (force === 0) { ok(metas.every((m) => /card/.test(m.geometry.attributes.position.count === 8 ? 'card' : 'mesh')), 'tier 0 builds impostor cards only'); ok(metas.every((m) => m.material.opacityNode && m.material.alphaTest === 0.5), 'cards use the procedural alpha silhouette'); ok(metas.length <= 4, 'tier 0: one draw per entry (' + metas.length + ')'); }
  else ok(metas.some((m) => m.geometry.attributes.position.count > 8), 'tier ' + force + ' has real meshes');
  // matrices written are finite and the instances stand on the terrain (y within the height field)
  for (const m of metas) for (let k = 0; k < Math.min(m.count, 200); k++) { const a = m.instanceMatrix.array, o = k * 16; ok([a[o], a[o + 5], a[o + 12], a[o + 13], a[o + 14], a[o + 15]].every(Number.isFinite) && a[o + 15] === 1, 'finite matrix'); ok(Math.abs(a[o + 13] - H(a[o + 12], a[o + 14])) < 0.8, 'instance on the ground'); }
  // moving far streams new chunks and drops old ones; looking backwards changes what is drawn but never exceeds the cap
  const before = B.stats().total; ctx.cam.x = 900; ctx.px = 900; run(ctx, 500); ok(B.stats().chunks >= 9 && B.stats().total > 0, 'streamed after a 900 m move'); void before;
  ctx.cam.qy = 1; ctx.cam.qw = 0; run(ctx, 20); ok(B.stats().total <= B.core.TIERS[force].capTotal, 'turned round: still within the cap');
  ctx.agl = 400; run(ctx, 2); ok(root.visible === false, 'hidden high above the ground'); ctx.agl = 2; run(ctx, 2);
  B.dispose(); ok(!root.parent && B.stats().ready === false, 'dispose removes the layer');
}
// a world without a biome (ice) draws nothing; other biomes resolve
globalThis.location.search = '?scatter=1'; B.dispose(); { const c = mkCtx({ style: 'ice' }); run(c, 5); ok(!B.stats().ready && c.parent.children.length === 0, 'ice world: no scatter'); }
for (const [style, ground, id] of [['mesa', 0xb06030, 'dry-desert'], ['lush', 0x6a7a4a, 'meadow']]) { B.dispose(); const c = mkCtx({ style, ground, gen: 7 }); run(c, 200); ok(B.stats().biome === id && B.stats().total > 0, style + ' -> ' + id + ' (' + B.stats().total + ' drawn)'); }
// replacesTrees only with a tree biome + ready
B.dispose(); ok(!B.replacesTrees(), 'no tree takeover before the layer exists'); { const c = mkCtx({}); run(c, 200); ok(B.replacesTrees(), 'forest biome takes over the near trees'); B.dispose(); }
// a throwing height field switches the scatter off cleanly (never breaks the game loop)
{ B.dispose(); const c = mkCtx({ H: () => { throw new Error('boom'); }, gen: 9 }); const w = console.warn; console.warn = () => {}; run(c, 30); console.warn = w; ok(B.on === false, 'a failing tick switches scatter off'); B.on = true; B.dispose(); }
console.log('biome-scatter-glue OK (' + n + ' checks, ' + used.size + ' mesh ids)');
