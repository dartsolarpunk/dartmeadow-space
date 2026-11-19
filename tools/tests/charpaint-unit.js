// node tools/tests/charpaint-unit.js — colour application logic (Phase 2): registry regions, colour model, sRGB helpers, the baked-atlas raster + colour transfer,
// hair group -> cluster tints, and the hair_strands.js setTint contract (per-cluster base colour replaced, per-strand variation kept, null restores).  Pure node.
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);
const C = require('../../ui/dm-chars.js'), P = require('../../ui/dm-charpaint.js');
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };

// ── regions + colour model
for (const d of C.list()) {
  const R = C.regions(d); ok(R.length >= 3, d.id + ' declares hair + clothing regions');
  ok(R.some((r) => r.kind === 'hair') && R.some((r) => r.id === 'shirt') && R.some((r) => r.id === 'pants'), d.id + ' has hair, shirt, pants');
  ok(new Set(R.map((r) => r.id)).size === R.length, d.id + ' region ids unique');
  for (const it of Object.values(d.items)) ok(C.isHex(it.defaultColor), d.id + ' default colour is #rrggbb');
}
{
  C._reset(mem());
  ok(C.setColor('ariel', 'shirt', '#C0262D') && C.look('ariel').colors.shirt === '#c0262d', 'set colour (lower-cased)');
  ok(C.setColor('ariel', 'nope', '#c0262d') === false, 'a region the registry does not declare is refused');
  ok(C.setColor('ariel', 'shirt', 'red') === false && C.setColor('ariel', 'shirt', '#fff') === false && C.setColor('ariel', 'shirt', 42) === false, 'only #rrggbb accepted');
  ok(C.setColor('ghost', 'shirt', '#c0262d') === false, 'unknown character refused');
  ok(!C.isDefaultLook(C.look('ariel')) && C.isDefaultLook(C.look('emma')), 'default-look detection');
  const sig1 = C.lookSig('ariel'); C.setColor('ariel', 'pants', '#1d2f6b'); ok(C.lookSig('ariel') !== sig1, 'the look signature changes with the look (thumbnail refresh)');
  C.setColor('ariel', 'shirt', null); C.setColor('ariel', 'pants', ''); ok(C.isDefaultLook(C.look('ariel')) && !('ariel' in C.profile().looks), 'clearing every colour drops the look (back to the shipped one)');
  C.setColor('emma', 'hair.main', '#c9a25a'); C.setColor('ariel', 'shirt', '#a8501f');
  ok(C.resetLook('ariel') && C.isDefaultLook(C.look('ariel')) && C.look('emma').colors['hair.main'] === '#c9a25a', 'reset affects one character only');
  // persistence + migration: colours round trip, junk is filtered through the registry
  const st = mem(); C._reset(st); C.setSelected('emma'); C.setColor('emma', 'shirt', '#1f8a8a'); C._reset(st);
  ok(C.selectedId() === 'emma' && C.look('emma').colors.shirt === '#1f8a8a', 'colours persist across a reload');
  const s2 = mem(); s2.setItem(C.KEY, JSON.stringify({ v: 1, id: 'emma', updated: 5, looks: { emma: { colors: { shirt: '#123456', hat: '#123456', pants: 'blue', 'hair.main': '#ABCDEF' }, decals: 'x' }, ariel: 7 } })); C._reset(s2);
  ok(JSON.stringify(C.look('emma').colors) === JSON.stringify({ shirt: '#123456', 'hair.main': '#abcdef' }) && Array.isArray(C.look('emma').decals) && C.isDefaultLook(C.look('ariel')), 'unknown regions / bad colours dropped on load');
  // a save carries the look; the newest side wins
  C._reset(mem()); C.setColor('ariel', 'shirt', '#a8501f'); const exp = C.exportForSave(); C._reset(mem());
  ok(C.importFromSave(exp) && C.look('ariel').colors.shirt === '#a8501f', 'colours travel inside the save');
}

// ── sRGB / transfer / raster
ok(near(P.s2l(0), 0) && near(P.s2l(1), 1) && near(P.l2s(P.s2l(0.37)), 0.37, 1e-9), 'sRGB <-> linear round trip');
ok(JSON.stringify(P.hexToRgb('#c0262d')) === '[192,38,45]' && P.hexToRgb('c0262d') && P.hexToRgb('#12') === null && P.hexToRgb(null) === null, 'hexToRgb');
ok(P.hexToLinear('#ffffff').every((v) => near(v, 1)) && near(P.hexToLinear('#808080')[0], 0.2158605, 1e-5), 'hexToLinear');
{ // transfer keeps detail: a texel as bright as the island mean becomes the target, a lighter one a lighter target, a darker one a darker target, clamped
  const T = [200, 40, 40];
  const mid = P.transfer(80, 80, 80, 80 / 255, T), hi = P.transfer(160, 160, 160, 80 / 255, T), lo = P.transfer(20, 20, 20, 80 / 255, T);
  ok(near(mid[0], 200, 1e-6) && near(mid[1], 40, 1e-6), 'mean texel -> exactly the chosen colour');
  ok(hi[0] > mid[0] && hi[1] > mid[1] && lo[0] < mid[0], 'lighter baked detail stays lighter, darker stays darker');
  ok(hi[0] <= 255 && P.transfer(255, 255, 255, 0.05, T).every((v) => v <= 255), 'clamped to 255');
  ok(near(P.transfer(0, 0, 0, 0.3, T)[0], 200 * 0.55), 'floor of the ratio keeps black texels from going black');
  ok(P.transfer(50, 50, 50, 0, T)[0] === 200, 'a degenerate island (mean 0) falls back to the plain colour');
}
{ // raster: two triangles forming a square cover its texels once, outside stays untouched, the margin closes seams
  const size = 16, uv = new Float32Array([0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.25, 0.75, 0.75, 0.25, 0.75]);
  const hit = new Uint8Array(size * size); P.raster(uv, null, size, (t) => { hit[t]++; }, 0);
  let inside = 0, outside = 0; for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const v = hit[y * size + x], inn = x >= 4 && x < 12 && y >= 4 && y < 12; if (inn && v) inside++; if (!inn && v) outside++; }
  ok(inside === 64 && outside === 0, 'square covered exactly (' + inside + ' inside, ' + outside + ' outside)');
  const h2 = new Uint8Array(size * size); P.raster(uv, null, size, (t) => { h2[t]++; }, 0.75); let cnt = 0; for (const v of h2) if (v) cnt++; ok(cnt > 64 && cnt < 64 + 4 * 8 * 2, 'a 0.75 px margin adds a thin ring (' + cnt + ' texels)');
  const idx = new Uint16Array([0, 1, 2]); const h3 = new Uint8Array(size * size); P.raster(uv, idx, size, (t) => { h3[t]++; }, 0); let c3 = 0; for (const v of h3) if (v) c3++; ok(c3 > 20 && c3 < 40, 'indexed triangle (' + c3 + ' texels)');
  const w = []; P.raster(uv, null, size, (t, tri, a, b, c) => { w.push(a + b + c); }, 0); ok(w.every((s) => near(s, 1, 1e-9)), 'barycentric weights sum to 1');
}
// island recolour end to end on a synthetic atlas (what paintAtlas does, minus the canvas)
{
  const size = 8, px = new Uint8ClampedArray(size * size * 4); for (let i = 0; i < size * size; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = i % 2 ? 60 : 100; px[i * 4 + 3] = 255; }
  const uv = new Float32Array([0, 0, 0.5, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0.5]), texels = []; P.raster(uv, null, size, (t) => texels.push(t), 0);
  const list = [...new Set(texels)]; let sum = 0; for (const t of list) sum += (0.299 * px[t * 4] + 0.587 * px[t * 4 + 1] + 0.114 * px[t * 4 + 2]) / 255; const ref = sum / list.length;
  for (const t of list) { const c = P.transfer(px[t * 4], px[t * 4 + 1], px[t * 4 + 2], ref, [200, 30, 30]); px[t * 4] = c[0]; px[t * 4 + 1] = c[1]; px[t * 4 + 2] = c[2]; }
  ok(list.length === 16 && list.every((t) => px[t * 4] > px[t * 4 + 1] * 3), 'the island is recoloured (red) ...');
  ok(px[(7 * size + 7) * 4] === 100 || px[(7 * size + 7) * 4] === 60, '... texels outside the island keep the baked image');
  const reds = new Set(list.map((t) => Math.round(px[t * 4]))); ok(reds.size === 2, '... and the baked light/dark pattern survives (2 levels)');
}

// ── hair: group -> cluster tints (the registry declares the groups)
for (const d of C.list()) {
  const names = d.hair.groups.flatMap((g) => g.clusters); ok(new Set(names).size === names.length, d.id + ' hair group clusters do not overlap');
  const bin = fs.readFileSync(path.join(root, d.hair.url)), jl = bin.readUInt32LE(4), meta = JSON.parse(bin.slice(12, 12 + jl).toString());
  ok(names.every((c) => meta.groups.includes(c)) && meta.groups.every((c) => names.includes(c)), d.id + ' hair groups cover exactly the groom\'s clusters (' + meta.groups.join(',') + ')');
}
{
  const d = C.get('emma'), look = { colors: { 'hair.fringe': '#e0559a' } }, T = P.hairTints(d, look);
  ok(JSON.stringify(Object.keys(T)) === '["bangs"]' && T.bangs.every((v) => v >= 0 && v <= 1), 'fringe colour tints only the bangs cluster, linear');
  ok(P.hairTints(d, { colors: {} }) === null && P.hairTints(d, null) === null, 'no hair colour -> null (the groom is untouched)');
  const T2 = P.hairTints(d, { colors: { 'hair.main': '#c9a25a' } }); ok(Object.keys(T2).sort().join() === 'back,sideburns,top,underlayer', 'main hair colour tints every non-fringe cluster');
  ok(P.applyHair({ setTint() { } }, d, look) === true && P.applyHair({}, d, look) === false && P.applyHair(null, d, look) === false, 'applyHair is safe without a solver / old solver');
}
// the hair_strands.js setTint contract, checked on the source text (the solver itself needs THREE): colBase copy, per-group mean, ratio clamp, null restores
{
  const s = fs.readFileSync(path.join(root, 'hair_strands.js'), 'utf8');
  ok(/const colBase = new Float32Array\(col\)/.test(s) && /function setTint\(map\)/.test(s) && /setStrandFraction, setTint/.test(s), 'hair_strands.js exposes H.setTint over a copy of the groomed colours');
  ok(/if \(!t \|\| !\(m > 1e-6\)\) \{ col\[o\] = colBase\[o\]/.test(s), 'unlisted / null groups restore the groomed colour');
  ok(/colAttr\.needsUpdate = true/.test(s), 'one upload per change');
}
console.log('charpaint-unit OK (' + n + ' checks)');
