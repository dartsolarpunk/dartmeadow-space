/* DART Meadow - starter BIOMES for ui/dm-biome-scatter.js (plain JSON-compatible data; format in docs/biome-scatter.md).
 * Meshes are the procedural placeholders ("proc:..." / "card:..."); a Blender -> GLB asset replaces an id by registering a mesh factory, the biome JSON then names the new ids.
 * Units: density per m2 at full mask weight, scale = multiplier of the placeholder's nominal size, slope in degrees, elevation in metres above the sea (0), distances in metres.
 * Authored for this project; the entry model (density / scale / slope / elevation / noise masks / clusters / LODs) is the common scatter-biome idea, no third-party data. */
(function (root) {
  'use strict';
  const BIOMES = [
    { id: 'temperate-forest', name: 'Temperate forest', version: 1, entries: [
      { id: 'conifer', kind: 'tree', density: 0.0050, scale: [0.8, 1.5], scaleBias: 1.4, footprint: 1.1, jitter: 0.85, sink: 0.15,
        slope: { max: 30, soft: 8 }, elevation: { min: 6, max: 70, soft: 10 }, noise: { scale: 170, octaves: 3, threshold: 0.52, soft: 0.1, seedOffset: 1 }, waterDistance: { min: 10, soft: 14 },
        cluster: { radius: 26, strength: 0.45, occupancy: 0.7 }, wind: { trunk: 1, branch: 1, leaf: 0.6 },
        lod: [{ mesh: 'proc:conifer-0', maxDist: 55 }, { mesh: 'proc:conifer-1', maxDist: 130 }, { mesh: 'proc:conifer-2', maxDist: 280 }, { card: 'card:conifer', maxDist: 520 }] },
      { id: 'broadleaf', kind: 'tree', density: 0.0035, scale: [0.8, 1.35], footprint: 1.6, jitter: 0.85, sink: 0.15, avoid: [{ entry: 'conifer', extra: 0.6 }],
        slope: { max: 24, soft: 8 }, elevation: { min: 4, max: 45, soft: 8 }, noise: { scale: 210, octaves: 3, threshold: 0.5, soft: 0.1, seedOffset: 2, invert: true }, waterDistance: { min: 6, soft: 10 },
        cluster: { radius: 22, strength: 0.35, occupancy: 0.6 }, wind: { trunk: 1, branch: 1, leaf: 1 },
        lod: [{ mesh: 'proc:broadleaf-0', maxDist: 55 }, { mesh: 'proc:broadleaf-1', maxDist: 130 }, { mesh: 'proc:broadleaf-2', maxDist: 280 }, { card: 'card:broadleaf', maxDist: 520 }] },
      { id: 'shrub', kind: 'bush', density: 0.018, scale: [0.6, 1.3], footprint: 0.7, jitter: 0.9, avoid: [{ entry: 'conifer', extra: 0.2 }, { entry: 'broadleaf', extra: 0.2 }],
        slope: { max: 34, soft: 10 }, elevation: { min: 4, max: 55, soft: 8 }, noise: { scale: 60, octaves: 3, threshold: 0.45, soft: 0.12, seedOffset: 3 }, waterDistance: { min: 4, soft: 8 },
        cluster: { radius: 9, strength: 0.7, occupancy: 0.55 }, wind: { trunk: 0.6, branch: 1, leaf: 1 },
        lod: [{ mesh: 'proc:shrub-0', maxDist: 40 }, { mesh: 'proc:shrub-1', maxDist: 90 }, { mesh: 'proc:shrub-2', maxDist: 170 }, { card: 'card:shrub', maxDist: 300 }] },
      { id: 'grass', kind: 'grass', density: 0.22, scale: [0.7, 1.4], footprint: 0.15, jitter: 1, maxPerChunk: 5000, tintVar: 0.25, avoid: [{ entry: 'conifer', extra: -0.4 }],
        slope: { max: 38, soft: 10 }, elevation: { min: 3, max: 60, soft: 6 }, noise: { scale: 38, octaves: 2, threshold: 0.35, soft: 0.2, seedOffset: 4 }, waterDistance: { min: 2, soft: 5 },
        cluster: { radius: 7, strength: 0.5, occupancy: 0.8 }, wind: { trunk: 0, branch: 0.6, leaf: 1 },
        lod: [{ mesh: 'proc:grass-0', maxDist: 22 }, { mesh: 'proc:grass-1', maxDist: 55 }, { card: 'card:grass', maxDist: 95 }] },
    ] },
    { id: 'meadow', name: 'Flower meadow', version: 1, entries: [
      { id: 'grass', kind: 'grass', density: 0.35, scale: [0.8, 1.6], footprint: 0.15, jitter: 1, maxPerChunk: 7000, tintVar: 0.3,
        slope: { max: 34, soft: 10 }, elevation: { min: 3, max: 55, soft: 6 }, noise: { scale: 55, octaves: 2, threshold: 0.3, soft: 0.2, seedOffset: 1 }, waterDistance: { min: 2, soft: 5 },
        cluster: { radius: 10, strength: 0.35, occupancy: 0.85 }, wind: { trunk: 0, branch: 0.7, leaf: 1 },
        lod: [{ mesh: 'proc:grass-0', maxDist: 24 }, { mesh: 'proc:grass-1', maxDist: 60 }, { card: 'card:grass', maxDist: 110 }] },
      { id: 'flowers', kind: 'flower', density: 0.12, scale: [0.8, 1.3], footprint: 0.12, jitter: 1, maxPerChunk: 3500, tintVar: 0.35,
        slope: { max: 28, soft: 8 }, elevation: { min: 3, max: 45, soft: 6 }, noise: { scale: 45, octaves: 2, threshold: 0.5, soft: 0.15, seedOffset: 2 }, waterDistance: { min: 3, soft: 6 },
        cluster: { radius: 5, strength: 0.95, occupancy: 0.6, cell: 28 }, wind: { trunk: 0, branch: 0.6, leaf: 1 },
        lod: [{ mesh: 'proc:flower-0', maxDist: 22 }, { mesh: 'proc:flower-1', maxDist: 55 }, { card: 'card:flower', maxDist: 90 }] },
      { id: 'shrub', kind: 'bush', density: 0.004, scale: [0.7, 1.4], footprint: 0.8, jitter: 0.9,
        slope: { max: 30, soft: 8 }, elevation: { min: 4, max: 45, soft: 8 }, waterDistance: { min: 5, soft: 8 }, cluster: { radius: 14, strength: 0.6, occupancy: 0.4 }, wind: { trunk: 0.6, branch: 1, leaf: 1 },
        lod: [{ mesh: 'proc:shrub-0', maxDist: 45 }, { mesh: 'proc:shrub-1', maxDist: 100 }, { mesh: 'proc:shrub-2', maxDist: 190 }, { card: 'card:shrub', maxDist: 330 }] },
      { id: 'lone-oak', kind: 'tree', density: 0.0004, scale: [1, 1.6], footprint: 1.8, jitter: 0.9, sink: 0.15, avoid: [{ entry: 'shrub', extra: 0.5 }],
        slope: { max: 18, soft: 6 }, elevation: { min: 5, max: 40, soft: 6 }, waterDistance: { min: 8, soft: 10 }, wind: { trunk: 1, branch: 1, leaf: 1 },
        lod: [{ mesh: 'proc:broadleaf-0', maxDist: 60 }, { mesh: 'proc:broadleaf-1', maxDist: 140 }, { mesh: 'proc:broadleaf-2', maxDist: 300 }, { card: 'card:broadleaf', maxDist: 560 }] },
    ] },
    { id: 'dry-desert', name: 'Dry scrub and desert', version: 1, entries: [
      { id: 'cactus', kind: 'cactus', density: 0.0009, scale: [0.7, 1.5], scaleBias: 1.3, footprint: 0.5, jitter: 0.9, sink: 0.1,
        slope: { max: 22, soft: 6 }, elevation: { min: 2, max: 60, soft: 6 }, noise: { scale: 130, octaves: 3, threshold: 0.45, soft: 0.12, seedOffset: 1 }, waterDistance: { min: 8, soft: 10 },
        cluster: { radius: 16, strength: 0.6, occupancy: 0.5 }, wind: { trunk: 0, branch: 0, leaf: 0 },
        lod: [{ mesh: 'proc:cactus-0', maxDist: 60 }, { mesh: 'proc:cactus-1', maxDist: 140 }, { mesh: 'proc:cactus-2', maxDist: 280 }, { card: 'card:cactus', maxDist: 480 }] },
      { id: 'deadbush', kind: 'bush', density: 0.0045, scale: [0.7, 1.4], footprint: 0.5, jitter: 0.9, avoid: [{ entry: 'cactus', extra: 0.3 }],
        slope: { max: 30, soft: 8 }, elevation: { min: 2, max: 70, soft: 8 }, noise: { scale: 80, octaves: 3, threshold: 0.4, soft: 0.15, seedOffset: 2 }, waterDistance: { min: 5, soft: 8 },
        cluster: { radius: 12, strength: 0.6, occupancy: 0.6 }, wind: { trunk: 0.4, branch: 1, leaf: 0.8 },
        lod: [{ mesh: 'proc:deadbush-0', maxDist: 45 }, { mesh: 'proc:deadbush-1', maxDist: 110 }, { card: 'card:deadbush', maxDist: 260 }] },
      { id: 'drygrass', kind: 'grass', density: 0.07, scale: [0.8, 1.5], footprint: 0.15, jitter: 1, maxPerChunk: 4000, tintVar: 0.3,
        slope: { max: 32, soft: 10 }, elevation: { min: 2, max: 60, soft: 6 }, noise: { scale: 45, octaves: 2, threshold: 0.5, soft: 0.2, seedOffset: 3 }, waterDistance: { min: 3, soft: 8 },
        cluster: { radius: 8, strength: 0.7, occupancy: 0.7 }, wind: { trunk: 0, branch: 0.6, leaf: 1 },
        lod: [{ mesh: 'proc:drygrass-0', maxDist: 22 }, { mesh: 'proc:drygrass-1', maxDist: 55 }, { card: 'card:drygrass', maxDist: 100 }] },
      { id: 'scatter-rock', kind: 'rock', density: 0.0025, scale: [0.5, 1.8], scaleBias: 2, footprint: 0.6, jitter: 1, sink: 0.12, tintVar: 0.2,
        slope: { max: 50, soft: 10 }, elevation: { min: 1, soft: 2 }, wind: { trunk: 0, branch: 0, leaf: 0 },
        lod: [{ mesh: 'proc:rock-0', maxDist: 70 }, { mesh: 'proc:rock-1', maxDist: 200 }] },
    ] },
  ];
  root.DM_BIOME_DEFS = BIOMES;
  if (typeof module !== 'undefined' && module.exports) module.exports = BIOMES;
  if (root.DMBiomeScatter && root.DMBiomeScatter.registerBiome) for (const b of BIOMES) root.DMBiomeScatter.registerBiome(b);
})(typeof window !== 'undefined' ? window : globalThis);
