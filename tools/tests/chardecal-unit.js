// node tools/tests/chardecal-unit.js — logo decals: the data model (ui/dm-chars.js) and the projection maths (ui/dm-charpaint.js composite / plane frames),
// plus the real Ariel + Emma GLBs when three@0.185 is installed (front side is +z, planar UV is valid, projected decals land on the garment).
'use strict';
const path = require('path'), { pathToFileURL } = require('url');
const C = require('../../ui/dm-chars.js'), P = require('../../ui/dm-charpaint.js');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const mem = () => { const o = {}; return { getItem: (k) => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); } }; };

// ── registry: 16 logos + text, unique ids, valid paths, every item with spots validates
const real = C.LOGOS.filter((l) => !l.text);
ok(real.length >= 12 && real.length <= 16, 'logo count 12..16 (' + real.length + ')');
ok(new Set(C.LOGOS.map((l) => l.id)).size === C.LOGOS.length, 'logo ids unique');
ok(real.every((l) => /^M[\dMLHVCSQAZ.\s\-eE]+$/.test(l.d)), 'logo paths use only path commands');
ok(['tree', 'leaf', 'bird', 'star', 'planet', 'wave', 'mountain', 'diamond', 'flame', 'spiral', 'crescent', 'hexagon', 'arrow', 'eye'].every((i) => C.logoById.has(i)), 'the named logos exist');
for (const d of C.list()) { ok(C.problems(d).length === 0, d.id + ' registry entry validates (spots)'); for (const id of Object.keys(d.items)) ok(!!d.items[id].spots, d.id + '.' + id + ' has spots'); }
// ── decal model
C._reset(mem()); const D = () => C.look('emma').decals;
ok(C.addDecal('emma', 'shirt', 'front', 'star') === 0 && D()[0].x === 0.5, 'add: first snap point is the default place');
ok(C.addDecal('emma', 'shirt', 'front', 'nope') === -1 && C.addDecal('emma', 'shirt', 'nope', 'star') === -1 && C.addDecal('emma', 'hat', 'front', 'star') === -1 && C.addDecal('zed', 'shirt', 'front', 'star') === -1, 'add rejects unknown logo / spot / item / character');
ok(C.addDecal('emma', 'shirt', 'front', 'text', { text: 'x' }) === 1 && D()[1].text === 'X', 'text logo: upper-cased, A-Z 0-9 only');
ok(C.addDecal('emma', 'shirt', 'front', 'text', { text: '!!!' }) === -1, 'text logo with no valid characters is rejected');
ok(C.cleanText('dart meadow rocks') === 'DART MEA', 'text limited to 8 characters');
C.addDecal('emma', 'shirt', 'back', 'leaf'); C.addDecal('emma', 'shirt', 'back', 'tree');
ok(C.decalCount('emma', 'shirt') === 4 && C.addDecal('emma', 'shirt', 'back', 'bolt') === -1, 'max 4 decals per item');
ok(C.addDecal('emma', 'pants', 'front', 'bolt') === 4 && C.decalCount('emma', 'pants') === 1, 'the limit is per item');
ok(C.updateDecal('emma', 0, { scale: 99, rotation: 450, colour: '#ABCDEF', x: -4 }) && D()[0].scale === 3 && D()[0].rotation === 90 && D()[0].colour === '#abcdef' && D()[0].x === 0.02, 'update clamps scale / wraps rotation / lower-cases colour / clamps x');
ok(!C.updateDecal('emma', 0, { colour: 'red' }) || D()[0].colour === '#ecebe6', 'bad colour falls back to the default decal colour');
C.updateDecal('emma', 0, { x: 0.69, y: 0.31, snap: true }); ok(D()[0].x === 0.7 && D()[0].y === 0.3, 'snap pulls a drop near a snap point onto it');
C.updateDecal('emma', 0, { x: 0.6, y: 0.45, snap: true }); ok(D()[0].x === 0.6 && D()[0].y === 0.45, 'far from every snap point it stays free');
const sig = C.lookSig('emma'); C.updateDecal('emma', 0, { rotation: 10 }); ok(C.lookSig('emma') !== sig, 'lookSig changes with decals');
ok(C.removeDecal('emma', 0) && D().length === 4 && !C.removeDecal('emma', 40), 'remove');
// persistence: round trip + garbage
const raw = JSON.parse(JSON.stringify(C.exportForSave())); C._reset(mem()); C._setProfile(C.normalize(raw)); ok(C.look('emma').decals.length === 4, 'decals survive save / load');
const bad = C.normalizeLook(C.get('emma'), { decals: [{ id: 'star', item: 'shirt', spot: 'front', x: 'a', y: 2, scale: 'z' }, { id: 'zzz', item: 'shirt', spot: 'front' }, null, 5, { id: 'star', item: 'cape', spot: 'front' }] });
ok(bad.decals.length === 1 && bad.decals[0].x === 0.5 && bad.decals[0].y === 0.98 && bad.decals[0].scale === 1, 'normalizeLook drops invalid decals and repairs numbers');
const many = C.normalizeLook(C.get('ariel'), { decals: Array.from({ length: 9 }, () => ({ id: 'star', item: 'shirt', spot: 'front', x: .5, y: .5 })) }); ok(many.decals.length === 4, 'normalizeLook enforces the per-item max');
C._reset(mem()); ok(C.addDecal('ariel', 'pants', 'left', 'wave') === 0 && C.setColor('ariel', 'pants', '#112233') && C.look('ariel').decals.length === 1, 'decals + colours live in one look');
C.resetLook('ariel'); ok(C.isDefaultLook(C.look('ariel')), 'reset clears decals too');

// ── projection maths (synthetic)
{
  const box = { minx: -0.2, maxx: 0.2, miny: 1, maxy: 1.5, minz: -0.1, maxz: 0.1 };
  const R = P.planeRange(box, 'front'), u = P.planeUV(R, 0.2, 1.5, 0), r = P.planeRange(box, 'back'), ub = P.planeUV(r, 0.2, 1.5, 0);
  ok(Math.abs(u[0] - 1) < 1e-9 && Math.abs(u[1]) < 1e-9, 'front view: +x is screen right, top of the box is v=0');
  ok(Math.abs(ub[0]) < 1e-9, 'back view mirrors x');
  const rl = P.planeRange(box, 'left'), ul = P.planeUV(rl, 0, 1.25, -0.1); ok(Math.abs(ul[0] - 1) < 1e-9 && Math.abs(ul[1] - 0.5) < 1e-9, 'left view (looking along -x): -z is screen right');
  ok(P.viewOf(0, 1) === 'front' && P.viewOf(0, -1) === 'back' && P.viewOf(1, 0.2) === 'left' && P.viewOf(-1, 0.2) === 'right', 'viewOf picks the dominant horizontal axis');
  // one quad facing +z covering the whole texture; a solid 8x8 mask
  const size = 64, pos = new Float32Array([-0.2, 1.5, 0, 0.2, 1.5, 0, 0.2, 1, 0, -0.2, 1, 0]), nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), index = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const mask = { res: 8, data: new Uint8Array(64).fill(255) }, item = { spots: { front: { base: 0.2 }, back: { base: 0.2 } } };
  const px = new Float32Array(size * size * 4).fill(0); for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const hit = P.composite(px, size, [{ pos, nrm, uv, index }], [{ id: 'star', item: 'shirt', spot: 'front', x: 0.5, y: 0.5, scale: 1, rotation: 0, colour: '#ff0000' }], item, box, 1, [mask]);
  const at = (x, y) => px[(y * size + x) * 4];
  ok(hit > 0 && at(32, 32) === 255 && at(2, 2) === 0, 'a decal covers its square only (hit ' + hit + ')');
  // the square is 0.2 m on a 0.4 x 0.5 m box: 0.5 of the width (32 px of 64), 0.4 of the height; the bilinear mask edge of an 8 px mask trims 1/8
  let cols = 0, rows = 0; for (let x = 0; x < size; x++) if (at(x, 32) === 255) cols++; for (let y = 0; y < size; y++) if (at(32, y) === 255) rows++;
  ok(Math.abs(cols - 28) <= 3 && Math.abs(rows - 22.4) <= 3, 'decal size = base x scale in metres (' + cols + ' x ' + rows + ' px)');
  const px2 = new Float32Array(size * size * 4); P.composite(px2, size, [{ pos, nrm: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]), uv, index }], [{ id: 'star', item: 'shirt', spot: 'front', x: .5, y: .5, scale: 1, rotation: 0, colour: '#ff0000' }], item, box, 1, [mask]);
  ok(!px2.some((v) => v !== 0), 'a surface facing away from the spot is never painted');
  const mk = (rot, x, y) => { const p = new Float32Array(size * size * 4); P.composite(p, size, [{ pos, nrm, uv, index }], [{ id: 'a', item: 'shirt', spot: 'front', x, y, scale: 1, rotation: rot, colour: '#ff0000' }], item, box, 1, [mask]); let c = 0; for (let i = 0; i < p.length; i += 4) if (p[i] > 128) c++; return c; };
  ok(mk(0, 0.5, 0.5) > 0 && Math.abs(mk(45, 0.5, 0.5) - mk(0, 0.5, 0.5)) / mk(0, 0.5, 0.5) < 0.1, 'rotating a square keeps its area');
  ok(mk(0, 0.98, 0.5) < mk(0, 0.5, 0.5) * 0.8, 'a decal at the edge is cut off by the garment');
}

// ── real GLBs
(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, 'lib-hair-probe.mjs')).href);
  if (!L.HAVE_THREE) { console.log('SKIP real GLBs: three@0.185.0 not installed'); return; }
  const { THREE } = L, mod = await import(pathToFileURL(path.join(L.D, 'hair_strands.js')).href + '?t=' + Math.random());
  for (const d of C.list()) {
    const S = await L.setup(d.id, mod); S.root.updateMatrixWorld(true);
    for (const id of Object.keys(d.items)) {
      const it = d.items[id], ms = []; S.root.traverse((o) => { if (o.isSkinnedMesh && new RegExp(it.mesh, 'i').test(o.name)) ms.push(o); });
      const I = P._impl.restOf(S.root, ms[0], ms[0].geometry, THREE, !!d.decalFlip), box = P.growBox(P.emptyBox(), I.pos);
      // the front of a garment (+z) must hold more +z facing area than -z facing on the chest / front, and the box must be a sane human size
      ok(box.maxy - box.miny > 0.2 && box.maxy - box.miny < 2.5, d.id + '.' + id + ' box height ' + (box.maxy - box.miny).toFixed(2) + ' (root units)');
      let fz = 0, bz = 0; for (let i = 0; i < I.nrm.length; i += 3) { if (I.nrm[i + 2] > 0.3) fz++; else if (I.nrm[i + 2] < -0.3) bz++; }
      ok(fz > 0 && bz > 0, d.id + '.' + id + ' has front and back facing normals (' + fz + '/' + bz + ')');
      const unit = P._impl.unitOf(S.root, THREE); ok(unit > 0.5 && unit < 3, d.id + ' unit ' + unit.toFixed(2));
      let infos, mbox = P.emptyBox();
      if (it.decals === 'planar') {
        const pl = P._impl.planarize(S.root, ms[0], box, THREE, !!d.decalFlip), uv = pl.geo.attributes.uv.array; infos = [pl.info]; ok(!pl.geo.index && pl.geo.attributes.position.count === uv.length / 2, d.id + '.' + id + ' planar geometry is unwelded with a uv per vertex');
        ok(pl.geo.attributes.skinIndex && pl.geo.attributes.skinWeight, d.id + '.' + id + ' keeps skin attributes');
        let mn = 9, mx = -9; for (const v of uv) { mn = Math.min(mn, v); mx = Math.max(mx, v); } ok(mn >= 0.019 && mx <= 0.981, d.id + '.' + id + ' planar uv inside the atlas');
        // the four quadrants must all be populated for a garment (front, back, sides)
        const q = [0, 0, 0, 0]; for (let i = 0; i < uv.length; i += 6) q[(uv[i] >= 0.5 ? 1 : 0) + (uv[i + 1] >= 0.5 ? 2 : 0)]++; ok(q.every((c) => c > 20), d.id + '.' + id + ' all four view quadrants used (' + q.join('/') + ')');
      } else { infos = [I]; }
      infos.forEach((x) => P.growBox(mbox, x.pos));
      const size = 256, px = new Float32Array(size * size * 4), mask = { res: 4, data: new Uint8Array(16).fill(255) };
      const sn = it.spots.front.snaps[0], hit = P.composite(px, size, infos, [{ id: 'star', item: id, spot: 'front', x: sn.x, y: sn.y, scale: 1.5, rotation: 0, colour: '#ffffff' }], it, mbox, unit, [mask]);
      ok(hit > 30, d.id + '.' + id + ' a front decal at its first snap point lands on the garment (' + hit + ' texels at 256 px)');
      const hb = P.composite(new Float32Array(size * size * 4), size, infos, [{ id: 'star', item: id, spot: 'back', x: 0.5, y: 0.4, scale: 1.5, rotation: 0, colour: '#ffffff' }], it, mbox, unit, [mask]);
      ok(hb > 30, d.id + '.' + id + ' a back decal lands on the garment (' + hb + ')');
    }
  }
})().then(() => { console.log(fails ? 'FAILED ' + fails + ' of ' + n : 'chardecal-unit OK (' + n + ' checks)'); process.exit(fails ? 1 : 0); }, (e) => { console.error(e); process.exit(1); });
