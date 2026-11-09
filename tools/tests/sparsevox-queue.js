// node tools/tests/sparsevox-queue.js — Wave 2a: per-brick planet LOD (ui/dm-sparsevox.js) is radial, and its stream QUEUES instead of dropping.
//  (a) lodSelect's refine test is isotropic: a node whose centre is at Euclidean distance D from the camera is refined (or not) the same
//      whether the camera sits along an axis or along a face / body diagonal.  The old metric (distance to the node's axis-aligned box)
//      reached k + 0.5 node-sizes from the centre along an axis but k + 0.87 along a body diagonal: cube-biased shells.
//  (b) LodStream.step never throws pending bricks away when the pool is full: they stay queued (in order) and are built once slots come
//      back (a fade-out ends / slots return to the free list, stale bricks are recycled); a recycled stale slot is not also cleared in the
//      same step (that clear job raced the build on the same slot).
//  (c) the index.html side: one-winding skirts (6 verts a face cell), the evicted pool drains (_svDrain), the evicted body is rebuilt static
//      (_svEvicted), a farther pool that is still loading is waited for, and none of it allocates per frame in _svLodWants.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const SV = require(path.join(root, 'ui', 'dm-sparsevox.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };

// ── (a) isotropic refine decision ───────────────────────────────────────────────────────────────
{
  // root level 1 over [-1,1]^3, B=4: the root node has w = 2, centre at the origin; it is refined iff its distance < k * w
  const B = 4, half = 1, k = 2.5, w = 2;
  const refined = (cam) => SV.lodSelect({ B, rootLevel: 1, half, rMin: 0, rMax: 10, cam, k, coarsest: 1, maxBricks: 1e9 }).leaves.length > 1;
  const dirs = [[1, 0, 0], [0, 0, -1], [Math.SQRT1_2, Math.SQRT1_2, 0], [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], [0.36, 0.48, 0.8]];
  let mismatch = 0, checked = 0;
  for (let D = 4.0; D < 8.0; D += 0.05) {
    const ref = refined(dirs[0].map((v) => v * D));
    for (const d of dirs) { checked++; if (refined(d.map((v) => v * D)) !== ref) mismatch++; }
  }
  ok(mismatch === 0, 'same refine decision along axis / face diagonal / body diagonal / any direction at the same distance (' + mismatch + ' of ' + checked + ')');
  // the threshold itself: centre distance (k + 0.5) node-sizes, i.e. the old reach along an axis (no extra bricks)
  ok(refined([(k + 0.5) * w - 0.01, 0, 0]) && !refined([(k + 0.5) * w + 0.01, 0, 0]), 'axis reach is k + 0.5 node-sizes from the centre (as before)');
  const s = 1 / Math.sqrt(3), Dd = (k + 0.6) * w;
  ok(!refined([s * Dd, s * Dd, s * Dd]), 'body diagonal no longer reaches farther than the axis (old metric refined out to k + 0.87)');
  // the real quadtree on a planet shell: fewer or equal bricks than the cube-biased metric would select, and leaves stay nearest-first
  const cam = [0.31, -0.22, 0.47], r = SV.lodSelect({ B: 4, rootLevel: 6, half: 1, rMin: 0.55, rMax: 0.62, cam, k: 2.5, coarsest: 4, maxBricks: 4096 });
  let cover = 0; const vol = (l) => Math.pow(4 * (1 << l.L) * r.base, 3); for (const l of r.leaves) cover += vol(l);
  ok(r.leaves.length > 50 && r.leaves.every((l) => l.L >= 0 && l.L <= 6), 'shell selection produces a sane leaf set (' + r.leaves.length + ')');
  const keys = new Set(r.leaves.map((l) => l.key)); ok(keys.size === r.leaves.length, 'no duplicate leaves');
  // no overlap: leaves are disjoint octree cells
  let overlap = 0; const L = r.leaves;
  for (let i = 0; i < L.length && overlap === 0; i += 7) for (let j = i + 1; j < L.length; j++) {
    const a = L[i], b = L[j], wa = 4 * (1 << a.L), wb = 4 * (1 << b.L);
    if (a.ox < b.ox + wb && b.ox < a.ox + wa && a.oy < b.oy + wb && b.oy < a.oy + wa && a.oz < b.oz + wb && b.oz < a.oz + wa) { overlap++; break; }
  }
  ok(overlap === 0, 'leaves are disjoint');
}

// ── (b) queue, never drop ─────────────────────────────────────────────────────────────────────────
const leaf = (i, L = 0) => ({ key: L + ':' + i, L, ox: i, oy: 0, oz: 0 });
{
  // pool of 4, 6 wanted (more than fit): the old step emptied the todo list once the pool was full
  const S = new SV.LodStream(4);
  S.desire([0, 1, 2, 3, 4, 5].map((i) => leaf(i)));
  const st = S.step(99);
  ok(st.build.length === 4 && st.pending === 2 && S.todo.length === 2, 'pool full: 4 built, 2 still QUEUED (pending ' + st.pending + ')');
  ok(S.todo[0].key === '0:4' && S.todo[1].key === '0:5', 'queued in order (nearest first as lodSelect gave them)');
  const st2 = S.step(99); ok(st2.build.length === 0 && st2.pending === 2, 'still full: nothing built, nothing dropped');
  // the camera moves: bricks 0,1 leave the set -> their slots are recycled for 4,5
  S.desire([2, 3, 4, 5].map((i) => leaf(i)));
  const st3 = S.step(99);
  ok(st3.build.length === 2 && st3.pending === 0, 'stale bricks recycled: the queued bricks complete (' + st3.build.map((b) => b.key) + ')');
  const slots3 = new Set(st3.build.map((b) => b.slot));
  ok(st3.clear.every((c) => !slots3.has(c)), 'a recycled slot is not also cleared in the same step (no build/clear race)');
  ok(S.resident.size === 4 && [2, 3, 4, 5].every((i) => S.resident.has('0:' + i)), 'resident = exactly the wanted set');
}
{
  // every free slot held off the free list while it fades out (index.html batch(): fadeOut / deadSlots), no stale left: the old step dropped the queue here
  const S = new SV.LodStream(4);
  S.desire([0, 1, 2, 3].map((i) => leaf(i))); S.step(99);
  S.desire([0, 1, 2, 3, 4, 5].map((i) => leaf(i, i < 4 ? 0 : 1)));
  // simulate two bricks that left an earlier set and are fading out: their slots were released and taken off the free list
  S.resident.delete('0:2'); S.resident.delete('0:3'); S.pool.release('0:2'); S.pool.release('0:3');
  const held = S.pool.free.splice(0); S.todo = S.todo.concat([leaf(2), leaf(3)]); S.stale = [];
  const a = S.step(99);
  ok(a.build.length === 0 && S.todo.length === 4, 'pool full mid-fade, no stale: queue kept (' + S.todo.length + ' pending), not dropped');
  // fades end: the slots come back
  for (const sl of held) S.pool.free.push(sl);
  const b = S.step(99);
  ok(b.build.length === 2 && S.todo.length === 2, 'slots back: queued bricks build in order (' + b.build.map((x) => x.key) + '), rest still queued');
  ok(b.build[0].key === '1:4' && b.build[1].key === '1:5', 'oldest queued first');
  // a body released: everything back -> completes
  S.desire([leaf(2), leaf(3)]); const c = S.step(99);
  ok(c.build.length === 2 && c.pending === 0 && S.todo.length === 0, 'after the set changes again every wanted brick completes');
}
{
  // a long random walk: the stream always converges to resident == wanted, and never loses a wanted brick
  const S = new SV.LodStream(16); let lost = 0; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 400; t++) {
    const want = []; const base = (t * 3) % 40; for (let i = 0; i < 16; i++) want.push(leaf(base + Math.floor(rnd() * 24)));
    const uniq = [...new Map(want.map((l) => [l.key, l])).values()];
    S.desire(uniq);
    let g = 0; while ((S.todo.length || S.stale.length) && g++ < 50) S.step(1 + Math.floor(rnd() * 3));
    if (!uniq.every((l) => S.resident.has(l.key))) lost++;
  }
  ok(lost === 0, 'random walk (400 re-selects, pool 16): every wanted brick resident each time (' + lost + ' incomplete)');
}
{
  const src = fs.readFileSync(path.join(root, 'ui', 'dm-sparsevox.js'), 'utf8');
  ok(!/this\.todo\.length\s*=\s*0/.test(src), 'dm-sparsevox.js no longer empties the todo list');
}

// ── (c) index.html wiring ─────────────────────────────────────────────────────────────────────────
{
  ok(/const VPS=C3\*15\+FC\*6,/.test(html), 'brick slot = C3*15 + FC*6 verts (one-winding skirts)');
  ok(/add\(r\.mul\(uint\(6\)\)\)/.test(html) && /triA=\[pa,pb,pb2, pa,pb2,pa2\], triB=\[pa,pb2,pb, pa,pa2,pb2\]/.test(html), 'skirt kernel writes 6 verts, one winding chosen by the brick\'s outward face');
  ok(!/const tri=\[pa,pb,pb2, pa,pb2,pa2, pa,pb2,pb, pa,pa2,pb2\]/.test(html), 'no double-winding skirts');
  ok(/far\._svDrain=far\._svLod;/.test(html) && /far\._svEvicted=true;/.test(html), 'evicted pool drains and the body is marked for a static rebuild');
  ok(/if\(b\._svLod\|\|b\._svDrain\)continue;/.test(html), 'a body still draining is not rebuilt under its own pool');
  ok(/if\(ev&&_MC_TIER_RANK\[tier\]<1\) tier='med';/.test(html) && /if\(!ev&&_MC_TIER_RANK\[tier\]<=_MC_TIER_RANK\[b\.mcTier\]\)continue;/.test(html), 'evicted body bypasses the monotonic tier rule (it is always replaced)');
  ok(/_svLodWants\(b\)===true;/.test(html) && /_svLodWants\(b\)==='wait'\) continue;/.test(html), 'a farther pool still loading is waited for, not evicted half-built');
  const w = html.slice(html.indexOf('function _svLodWants(b){'), html.indexOf('// at most SV_LOD.maxBodies worlds hold a brick pool'));
  ok(w.length > 50 && !/\.filter\(|\.map\(|\.some\(|=>/.test(w), '_svLodWants allocates nothing (asked every frame while a world waits)');
  ok(/unsettled\(\)\{/.test(html) && /async drain\(budgetMs\)\{/.test(html) && /settle\(\)\{/.test(html), 'controller has unsettled / drain / settle');
  ok(/const SV_LOD=\{B:4,DMAX:64,K:2\.5,/.test(html), 'SV_LOD constants unchanged (B 4, K 2.5)');
  ok(/const SV_LOD_PRESET=\{low:\{bodies:1,cap:256\},medium:\{bodies:1,cap:256\},high:\{bodies:2,cap:512\},ultra:\{bodies:2,cap:512\}\};/.test(html), 'pool presets unchanged');
}
console.log((fails ? 'FAILED ' + fails + ' of ' : 'sparsevox-queue OK (') + n + ' checks' + (fails ? '' : ')'));
process.exit(fails ? 1 : 0);
