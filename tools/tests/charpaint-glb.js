// node tools/tests/charpaint-glb.js — the look code against the REAL character GLBs and grooms (three@0.185 headless, no renderer):
//  * every registry item resolves to exactly one skinned mesh by its mesh regex (Ariel: Shirt001 / Pants_Reach_Pose001; Emma: Emma_Shirt / Emma_Pants), flat items carry a colour
//  * baked items have UVs and their UV islands are disjoint (shirt vs pants inside Emma's shared cloth atlas) so they recolour independently
//  * H.setTint on the real grooms: tinted cluster -> chosen mean colour, others untouched, null restores the groomed colours bit for bit, per-strand variation survives
// Skips (exit 0) when three@0.185 is not installed.
'use strict';
const path = require('path'), { pathToFileURL } = require('url');
(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, 'lib-hair-probe.mjs')).href);
  if (!L.HAVE_THREE) { console.log('SKIP: three@0.185.0 not installed'); process.exit(0); }
  const { THREE } = L, C = require('../../ui/dm-chars.js'), P = require('../../ui/dm-charpaint.js');
  const mod = await import(pathToFileURL(path.join(L.D, 'hair_strands.js')).href + '?t=' + Math.random());
  let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
  for (const d of C.list()) {
    const S = await L.setup(d.id, mod);
    for (const id of Object.keys(d.items)) {
      const it = d.items[id], ms = []; S.root.traverse((o) => { if (o.isSkinnedMesh && new RegExp(it.mesh, 'i').test(o.name)) ms.push(o); });
      ok(ms.length === 1, d.id + '.' + id + ' matches exactly one mesh by /' + it.mesh + '/ (' + ms.map((m) => m.name).join(',') + ')');
      if (it.mode === 'flat') ok(ms[0] && ms[0].material.color && !ms[0].geometry.attributes.uv, d.id + '.' + id + ' flat item: plain colour material, no UVs needed');
      if (it.mode === 'baked') ok(ms[0] && ms[0].geometry.attributes.uv && ms[0].geometry.index, d.id + '.' + id + ' baked item has UVs + index');
    }
    // the baked items of one atlas must not share texels (otherwise recolouring the shirt would paint the pants)
    const baked = Object.entries(d.items).filter(([, it]) => it.mode === 'baked');
    if (baked.length > 1) {
      const size = 512, sets = baked.map(([id, it]) => { const set = new Set(); S.root.traverse((o) => { if (o.isSkinnedMesh && new RegExp(it.mesh, 'i').test(o.name)) P.raster(o.geometry.attributes.uv.array, o.geometry.index.array, size, (t) => set.add(t), 0); }); return [id, set]; });
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { let shared = 0; for (const t of sets[i][1]) if (sets[j][1].has(t)) shared++; ok(shared <= 0.002 * Math.min(sets[i][1].size, sets[j][1].size), d.id + ': ' + sets[i][0] + ' and ' + sets[j][0] + ' UV islands are disjoint (' + shared + ' shared of ' + sets[i][1].size + '/' + sets[j][1].size + ')'); ok(sets[i][1].size > 2000, d.id + '.' + sets[i][0] + ' island covers texels (' + sets[i][1].size + ')'); }
    }
    // hair: setTint
    const H = S.H, col = H.mesh.geometry.getAttribute('color'), base = Float32Array.from(col.array), names = H.groupNames();
    const want = d.hair.groups.flatMap((g) => g.clusters); ok(JSON.stringify(names.slice().sort()) === JSON.stringify(want.slice().sort()), d.id + ' solver groups = registry hair groups (' + names.join(',') + ')');
    const lin = P.hexToLinear('#c9a25a'), lum = (a, o) => 0.2126 * a[o] + 0.7152 * a[o + 1] + 0.0722 * a[o + 2];
    const grp = new Uint8Array(0); const K = H.meta.points;   // vertex -> strand -> group is inside the solver; use the cluster size ratio instead: tint 'bangs' only
    ok(H.setTint({ bangs: lin }) === true, d.id + ' setTint accepts a cluster map');
    let changed = 0, same = 0; for (let i = 0; i < base.length; i += 3) { if (col.array[i] !== base[i] || col.array[i + 1] !== base[i + 1] || col.array[i + 2] !== base[i + 2]) changed++; else same++; }
    ok(changed > 0 && same > changed, d.id + ' only the tinted cluster changes (' + changed + ' of ' + (changed + same) + ' vertices)');
    // mean luminance of the changed vertices ~ the chosen colour's luminance; variation (min < mean < max) kept
    let sum = 0, cnt = 0, mn = 1e9, mx = -1e9; for (let i = 0; i < base.length; i += 3) if (col.array[i] !== base[i]) { const l = lum(col.array, i); sum += l; cnt++; mn = Math.min(mn, l); mx = Math.max(mx, l); }
    const target = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    ok(Math.abs(sum / cnt - target) < target * 0.12, d.id + ' tinted cluster mean luminance ' + (sum / cnt).toFixed(4) + ' ~ chosen ' + target.toFixed(4));
    ok(mx > mn * 1.2, d.id + ' per-strand light/dark variation survives (' + mn.toFixed(4) + '..' + mx.toFixed(4) + ')');
    ok(col.version > 0, d.id + ' colour attribute flagged for upload');
    H.setTint(null); let diff = 0; for (let i = 0; i < base.length; i++) if (col.array[i] !== base[i]) diff++;
    ok(diff === 0, d.id + ' setTint(null) restores the groomed colours exactly');
    H.setTint({ nosuchcluster: lin }); diff = 0; for (let i = 0; i < base.length; i++) if (col.array[i] !== base[i]) diff++; ok(diff === 0, d.id + ' an unknown cluster name changes nothing');
    // every registry group tints
    const all = {}; for (const g of d.hair.groups) for (const c of g.clusters) all[c] = lin; H.setTint(all); let ch = 0; for (let i = 0; i < base.length; i += 3) if (col.array[i] !== base[i]) ch++; ok(ch > base.length / 3 * 0.95, d.id + ' tinting every group recolours the whole groom (' + ch + ' vertices)');
    H.setTint(null);
  }
  console.log(fails ? fails + ' FAILED of ' + n : 'charpaint-glb OK (' + n + ' checks)'); process.exit(fails ? 1 : 0);
})();
