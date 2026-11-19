// node tools/tests/decalflow-unit.js — the staged logo flow (ui/dm-decalflow.js, pure): pending preview, auto-update when the logo changes, APPLY commits, RESET, CANCEL,
// add another, edit, select + delete, clear a garment, limits (MAX per garment), persistence (dm_char_v1) + backwards compatibility, placement pad geometry / drag.
'use strict';
const assert = require('assert'); let n = 0; const ok = (c, m) => { n++; assert(c, m); };
const C = require('../../ui/dm-chars.js'), FLm = require('../../ui/dm-decalflow.js'), FL = FLm.make(C), P = require('../../ui/dm-charpaint.js');
const mem = () => { const o = {}; return { o, getItem: (k) => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); } }; };
const fresh = () => { const m = mem(); C._reset(m); return { m, st: FLm.newState(), def: C.get('emma'), L: () => C.look('emma') }; };

// ── start: needs a logo; a garment tap creates the PENDING decal at the default place; nothing is saved
{
  const { st, def, L, m } = fresh();
  ok(FL.pickItem(st, def, L(), 'shirt').reason === 'logo' && !st.pending, 'garment first, no logo: refused, nothing pending');
  ok(FL.pickLogo(st, 'star') === 'picked' && FL.pickLogo(st, 'nope') === 'invalid' && st.logo === 'star', 'pick a logo (unknown ids refused)');
  const r = FL.pickItem(st, def, L(), 'shirt'); ok(r.ok && r.reason === 'started' && st.pending && st.item === 'shirt' && st.spot === 'front', 'garment tap starts a pending decal on its first view');
  const d0 = FLm.defaultPlacement(def, 'shirt', 'front'); ok(st.x === d0.x && st.y === d0.y && st.scale === 1 && st.rotation === 0, 'pending starts at the default place / size 1 / turn 0');
  ok(L().decals.length === 0 && !('dm_char_v1' in m.o), 'a pending decal is NOT stored');
  const rec = FL.pendingRecord(st, def); ok(rec && rec.id === 'star' && rec.item === 'shirt' && rec.x === d0.x, 'pendingRecord is a valid stored-decal record');
  const pv = FL.previewLook(L(), st, def); ok(pv.decals.length === 1 && pv.decals[0].id === 'star' && L().decals.length === 0, 'previewLook = stored look + the pending decal, the store is untouched');
  { const l0 = L(); ok(FL.previewLook(l0, FLm.newState(), def) === l0, 'nothing pending: previewLook returns the stored look itself'); }
  ok(FL.pickItem(st, def, L(), 'shirt').reason === 'same', 'tapping the garment again while pending changes nothing');
}
// ── auto-update: another logo while pending keeps position / size / turn / colour / view
{
  const { st, def, L } = fresh(); FL.pickLogo(st, 'star'); FL.pickItem(st, def, L(), 'shirt'); FL.pickSpot(st, def, 'back');
  FL.setPlacement(st, def, { x: 0.41, y: 0.66, scale: 1.7, rotation: 40, colour: '#C0262D' });
  ok(FL.pickLogo(st, 'leaf') === 'swapped', 'a second logo while pending reports swapped');
  ok(st.logo === 'leaf' && st.item === 'shirt' && st.spot === 'back' && st.x === 0.41 && st.y === 0.66 && st.scale === 1.7 && st.rotation === 40 && st.colour === '#c0262d', 'swap keeps view, position, size, turn and colour');
  ok(FL.pendingRecord(st, def).id === 'leaf' && FL.previewLook(L(), st, def).decals[0].id === 'leaf', 'the preview shows the new logo');
  ok(FL.pickLogo(st, 'leaf') === 'picked', 'picking the same logo is not a swap');
  FL.pickLogo(st, 'text'); ok(FL.pendingRecord(st, def) === null || FL.pendingRecord(st, def).text === 'DART', 'a text logo uses the text field (default DART)');
  FL.setPlacement(st, def, { text: '' }); ok(FL.pendingRecord(st, def) === null && FL.canApply(st, def, L()).reason === 'text', 'a text logo with no text cannot be applied');
  FL.setPlacement(st, def, { text: 'dart!' }); ok(st.text === 'DART' && FL.canApply(st, def, L()).ok, 'text is cleaned (A-Z 0-9)');
  ok(FL.pickLogo(st, 'tree') === 'swapped' && st.x === 0.41 && st.scale === 1.7, 'swap away from a text logo still keeps the placement');
}
// ── placement: clamps, snap, view change keeps size / turn but takes the view's default place
{
  const { st, def, L } = fresh(); FL.pickLogo(st, 'bird'); FL.pickItem(st, def, L(), 'shirt');
  FL.setPlacement(st, def, { x: -3, y: 9, scale: 99, rotation: 450 }); ok(st.x === 0.02 && st.y === 0.98 && st.scale === 3 && st.rotation === 90, 'placement is clamped like a stored decal');
  FL.setPlacement(st, def, { scale: 0.01 }); ok(st.scale === DCmin(), 'size lower bound');
  FL.setPlacement(st, def, { x: 0.69, y: 0.31, snap: true }); ok(st.x === 0.7 && st.y === 0.3, 'a drop near a snap point snaps');
  FL.setPlacement(st, def, { x: 0.6, y: 0.45, snap: true }); ok(st.x === 0.6 && st.y === 0.45, 'far from every snap point it stays free');
  FL.setPlacement(st, def, { scale: 2, rotation: 30 }); FL.pickSpot(st, def, 'left'); const dl = FLm.defaultPlacement(def, 'shirt', 'left');
  ok(st.spot === 'left' && st.x === dl.x && st.y === dl.y && st.scale === 2 && st.rotation === 30, 'new view: default place of that view, size and turn kept');
  ok(!FL.pickSpot(st, def, 'top'), 'unknown view refused');
  function DCmin() { return C.SCALE_MIN; }
}
// ── RESET: default place / size / turn, keeps logo, garment, view, colour, text
{
  const { st, def, L } = fresh(); FL.pickLogo(st, 'text'); FL.pickItem(st, def, L(), 'pants'); FL.pickSpot(st, def, 'back');
  ok(FL.isDefaultPlacement(st, def), 'fresh pending sits at the default placement');
  FL.setPlacement(st, def, { x: 0.3, y: 0.8, scale: 2.5, rotation: -90, colour: '#3f8fd2', text: 'ABC' }); ok(!FL.isDefaultPlacement(st, def), 'moved placement is not the default');
  ok(FL.reset(st, def), 'reset runs while pending');
  const d = FLm.defaultPlacement(def, 'pants', 'back'); ok(st.x === d.x && st.y === d.y && st.scale === 1 && st.rotation === 0 && FL.isDefaultPlacement(st, def), 'reset: default position, size 1, turn 0');
  ok(st.logo === 'text' && st.item === 'pants' && st.spot === 'back' && st.colour === '#3f8fd2' && st.text === 'ABC' && st.pending, 'reset keeps logo, garment, view, colour, text and stays pending');
  FL.cancel(st); ok(!FL.reset(st, def), 'nothing to reset when nothing is pending');
}
// ── APPLY: commits through DMChars (persisted), counts, nothing pending afterwards, logo + garment stay for "add another"
{
  const { st, def, L, m } = fresh(); FL.pickLogo(st, 'star'); FL.pickItem(st, def, L(), 'shirt'); FL.setPlacement(st, def, { x: 0.35, y: 0.5, scale: 1.4, rotation: 20, colour: '#e8892a' });
  const i = FL.apply(st, def); ok(i === 0 && L().decals.length === 1, 'apply stores the decal');
  const d = L().decals[0]; ok(d.id === 'star' && d.item === 'shirt' && d.spot === 'front' && d.x === 0.35 && d.y === 0.5 && d.scale === 1.4 && d.rotation === 20 && d.colour === '#e8892a', 'stored with the placed values');
  ok(!st.pending && st.logo === 'star' && st.item === 'shirt' && FL.count(def, L(), 'shirt') === 1, 'after apply nothing is pending; logo + garment stay chosen; count 1');
  const saved = JSON.parse(m.o.dm_char_v1); ok(saved.v === 1 && saved.looks.emma.decals.length === 1 && saved.looks.emma.decals[0].id === 'star', 'persisted in dm_char_v1 (v1 shape)');
  ok(FL.apply(st, def) === -1, 'apply with nothing pending does nothing');
  // add another of the same logo: starts at the DEFAULT place again
  ok(FL.addAnother(st, def, L()).ok && st.pending && st.logo === 'star' && FL.isDefaultPlacement(st, def), 'add another: pending again, same logo, default place');
  FL.pickLogo(st, 'leaf'); ok(FL.apply(st, def) === 1 && L().decals.length === 2 && L().decals[1].id === 'leaf', 'then a different logo: multiple decals allowed');
  ok(JSON.parse(m.o.dm_char_v1).looks.emma.decals.length === 2, 'persisted again');
}
// ── limits: MAX per garment (4), per garment not global, counts shown by summary
{
  const { st, def, L } = fresh(); FL.pickLogo(st, 'star');
  for (let k = 0; k < C.MAX_DECALS; k++) { ok(FL.pickItem(st, def, L(), 'shirt').ok, 'start #' + (k + 1)); ok(FL.apply(st, def) === k, 'apply #' + (k + 1)); }
  ok(FL.summary(st, def, L()).shirt.count === C.MAX_DECALS && FL.summary(st, def, L()).shirt.full && !FL.summary(st, def, L()).pants.full, 'summary: shirt 4/4 full, pants not');
  ok(FL.pickItem(st, def, L(), 'shirt').reason === 'full' && !st.pending, 'a full garment cannot start another pending decal');
  ok(!FL.addAnother(st, def, L()).ok, 'add another refuses on a full garment');
  ok(FL.pickItem(st, def, L(), 'pants').ok && FL.apply(st, def) === 4 && FL.count(def, L(), 'pants') === 1, 'the limit is per garment');
  // pending moved from pants to the full shirt is refused and keeps the pending pants decal
  FL.pickItem(st, def, L(), 'pants'); const r = FL.pickItem(st, def, L(), 'shirt'); ok(r.reason === 'full' && st.pending && st.item === 'pants', 'tapping a full garment while pending keeps the current pending decal');
  // limit raced by another writer between preview and apply
  const { st: s2, def: d2, L: L2 } = fresh(); FL.pickLogo(s2, 'bolt'); FL.pickItem(s2, d2, L2(), 'shirt'); for (let k = 0; k < 4; k++) C.addDecal('emma', 'shirt', 'front', 'leaf');
  ok(FL.canApply(s2, d2, L2()).reason === 'full' && FL.apply(s2, d2) === -1 && s2.pending && L2().decals.length === 4, 'apply is refused when the garment filled meanwhile; the pending decal stays');
}
// ── move a pending decal to the other garment: that garment's default place
{
  const { st, def, L } = fresh(); FL.pickLogo(st, 'moon' in {} ? 'moon' : 'star'); FL.pickItem(st, def, L(), 'shirt'); FL.setPlacement(st, def, { x: 0.2, y: 0.2, scale: 2 });
  FL.pickItem(st, def, L(), 'pants'); const d = FLm.defaultPlacement(def, 'pants', 'front'); ok(st.item === 'pants' && st.x === d.x && st.y === d.y && st.scale === 1 && st.pending, 'garment change while pending: new garment, its default place');
}
// ── CANCEL
{
  const { st, def, L } = fresh(); FL.pickLogo(st, 'star'); FL.pickItem(st, def, L(), 'shirt'); const l1 = L(); ok(FL.cancel(st) && !st.pending && FL.previewLook(l1, st, def) === l1 && L().decals.length === 0, 'cancel drops the pending decal; nothing stored');
  ok(!FL.cancel(st), 'cancel with nothing pending reports false');
}
// ── EDIT an applied decal: replaces on SAVE, untouched on CANCEL, previewLook replaces (not appends)
{
  const { st, def, L } = fresh(); C.addDecal('emma', 'shirt', 'front', 'star', { x: 0.5, y: 0.3 }); C.addDecal('emma', 'shirt', 'back', 'leaf');
  ok(FL.edit(st, def, L(), 1) && st.pending && st.editIndex === 1 && st.logo === 'leaf' && st.spot === 'back', 'edit loads the applied decal into the pending slot');
  FL.setPlacement(st, def, { scale: 2, rotation: 15 }); const pv = FL.previewLook(L(), st, def); ok(pv.decals.length === 2 && pv.decals[1].scale === 2 && L().decals[1].scale === 1, 'preview replaces the edited decal, the store keeps the old one');
  ok(FL.pickItem(st, def, L(), 'pants').ok && st.editIndex === -1 && st.item === 'pants', 'tapping another garment while editing starts a fresh pending decal');
  FL.edit(st, def, L(), 1); FL.cancel(st); ok(L().decals[1].scale === 1 && !st.pending, 'cancel an edit: the applied decal is unchanged');
  FL.edit(st, def, L(), 0); FL.pickLogo(st, 'tree'); FL.setPlacement(st, def, { colour: '#1d2f6b' }); ok(FL.apply(st, def) === 0 && L().decals.length === 2 && L().decals[0].id === 'tree' && L().decals[0].colour === '#1d2f6b', 'save: the decal is replaced in place (still 2)');
  ok(!FL.edit(st, def, L(), 9), 'editing a missing decal is refused');
}
// ── select + delete, clear a garment, edit index follows deletions
{
  const { st, def, L } = fresh(); ['star', 'leaf', 'bird'].forEach((g) => C.addDecal('emma', 'shirt', 'front', g)); C.addDecal('emma', 'pants', 'front', 'bolt'); C.addDecal('emma', 'pants', 'back', 'tree');
  FL.toggleSel(st, 3); FL.toggleSel(st, 0); ok(st.sel.join() === '0,3', 'select toggles and stays sorted'); FL.toggleSel(st, 3); ok(st.sel.join() === '0', 'toggle off');
  FL.toggleSel(st, 2); ok(FL.deleteSelected(st, def) === 2 && L().decals.map((d) => d.id).join() === 'leaf,bolt,tree' && st.sel.length === 0, 'delete selected removes exactly the selected decals (descending-safe)');
  ok(FL.selectAll(st, L()).join() === '0,1,2' && FL.selectAll(st, L(), 'pants').join() === '1,2', 'select all / all on one garment');
  st.sel = []; ok(FL.clearGarment(st, def, 'pants') === 2 && L().decals.length === 1 && L().decals[0].id === 'leaf', 'clear all on this garment leaves the other garment alone');
  ok(FL.clearGarment(st, def, 'pants') === 0, 'clearing an empty garment is a no-op');
  C.addDecal('emma', 'pants', 'front', 'bolt'); FL.edit(st, def, L(), 1); st.sel = [0]; FL.deleteSelected(st, def); ok(st.editIndex === 0 && st.pending && L().decals[0].id === 'bolt', 'deleting a decal before the edited one shifts the edit index');
  st.sel = [0]; FL.deleteSelected(st, def); ok(!st.pending && st.editIndex === -1 && L().decals.length === 0, 'deleting the decal being edited ends the edit');
  st.sel = [5, 5]; ok(FL.deleteSelected(st, def) === 0, 'stale selection deletes nothing'); st.sel = [4]; FL.pruneSel(st, L()); ok(st.sel.length === 0, 'pruneSel drops stale indices');
}
// ── backwards compatibility: data saved before the staged flow loads and applies unchanged; the flow adds no persisted fields
{
  const old = { v: 1, id: 'emma', updated: 5, looks: { emma: { colors: { shirt: '#c0262d' }, decals: [{ id: 'star', item: 'shirt', spot: 'front', x: 0.5, y: 0.3, scale: 1, rotation: 0, colour: '#ecebe6' }, { id: 'text', item: 'pants', spot: 'back', x: 0.5, y: 0.2, scale: 1, rotation: 0, colour: '#ffffff', text: 'DART' }] } } };
  const m = mem(); m.setItem('dm_char_v1', JSON.stringify(old)); C._reset(m); const L = C.look('emma');
  ok(L.colors.shirt === '#c0262d' && L.decals.length === 2 && L.decals[1].text === 'DART', 'an old v1 profile still loads (colours + decals)');
  const st = FLm.newState(), def = C.get('emma'); FL.pickLogo(st, 'leaf'); FL.pickItem(st, def, L, 'shirt'); FL.apply(st, def);
  const after = JSON.parse(m.o.dm_char_v1); ok(after.v === 1 && Object.keys(after).sort().join() === 'id,looks,updated,v' && Object.keys(after.looks.emma).sort().join() === 'colors,decals', 'stored shape unchanged (v, id, updated, looks.{colors,decals})');
  ok(Object.keys(after.looks.emma.decals[2]).sort().join() === 'colour,id,item,rotation,scale,spot,x,y', 'a stored decal has the same fields as before (no flow state leaks in)');
  ok(after.looks.emma.decals[0].id === 'star' && after.looks.emma.colors.shirt === '#c0262d', 'earlier data survives');
}
// ── placement pad: geometry, hit testing, drags
{
  const def = C.get('emma'), sp = def.items.shirt.spots.front, view = { W: 0.5, H: 0.6 }, unit = 1, w = 300, h = 360;
  const live = { x: 0.5, y: 0.5, scale: 1, rotation: 0 }, g = FLm.padGeom(view, sp, unit, live, w, h);
  ok(Math.abs(g.px - sp.base * 1 * unit / view.W * w) < 1e-6 && g.cx === 150 && g.cy === 180, 'logo box width = spot.base * scale * unit / garment width, centred on x,y');
  ok(Math.abs(g.size[0] - (150 + g.half)) < 1e-6 && Math.abs(g.size[1] - (180 + g.half)) < 1e-6 && Math.abs(g.turn[0] - 150) < 1e-6 && g.turn[1] < g.cy - g.half, 'size handle on the bottom-right corner, turn knob above the top edge');
  const gr = FLm.padGeom(view, sp, unit, Object.assign({}, live, { rotation: 90 }), w, h); ok(Math.abs(gr.turn[0] - (150 + g.half + 26)) < 1e-6 && Math.abs(gr.turn[1] - 180) < 1e-6, 'handles rotate with the logo');
  ok(FLm.padHit(g, g.turn[0], g.turn[1], 22) === 'turn' && FLm.padHit(g, g.size[0] + 5, g.size[1] - 5, 22) === 'size' && FLm.padHit(g, 40, 40, 22) === 'move' && FLm.padHit(g, 150, 180, 22) === 'move', 'a touch grabs the turn knob, the size handle, or moves');
  const tiny = FLm.padGeom(view, sp, unit, Object.assign({}, live, { scale: 0.4 }), w, h); ok(tiny.px >= 10, 'the box never gets smaller than 10 px');
  let p = FLm.padDrag('move', g, live, 90, 270, w, h, [0, 0]); ok(Math.abs(p.x - 0.3) < 1e-9 && Math.abs(p.y - 0.75) < 1e-9, 'move: pointer position as a fraction of the pad');
  p = FLm.padDrag('move', g, live, 90, 270, w, h, [10, 10]); ok(Math.abs(p.x - 80 / 300) < 1e-9, 'move keeps the grab offset');
  p = FLm.padDrag('move', g, live, -50, 999, w, h, [0, 0]); ok(p.x === 0.02 && p.y === 0.98, 'move is clamped inside the pad');
  p = FLm.padDrag('turn', g, live, 250, 180, w, h); ok(p.rotation === 90, 'turn: pointer to the right of the centre = 90 deg');
  p = FLm.padDrag('turn', g, live, 150, 60, w, h); ok(p.rotation === 0, 'turn: pointer straight up = 0 deg');
  p = FLm.padDrag('turn', g, live, 150, 300, w, h); ok(Math.abs(p.rotation) === 180, 'turn: pointer straight down = 180 deg');
  p = FLm.padDrag('size', g, live, 150 + g.half * 2, 180 + g.half * 2, w, h, null, { scaleMin: 0.4, scaleMax: 3 }); ok(Math.abs(p.scale - 2) < 1e-9, 'size: dragging the corner twice as far doubles the size');
  p = FLm.padDrag('size', g, live, 151, 181, w, h, null, { scaleMin: 0.4, scaleMax: 3 }); ok(p.scale === 0.4, 'size is clamped to the minimum');
  p = FLm.padDrag('size', g, live, 9999, 9999, w, h, null, { scaleMin: 0.4, scaleMax: 3 }); ok(p.scale === 3, 'size is clamped to the maximum');
  // a drag patch goes straight through the flow
  const st = FLm.newState(); FL.pickLogo(st, 'star'); C._reset(mem()); FL.pickItem(st, def, C.look('emma'), 'shirt'); FL.setPlacement(st, def, FLm.padDrag('turn', g, live, 250, 180, w, h)); ok(st.rotation === 90, 'pad drag patches apply through setPlacement');
  ok(FLm.padGeom(null, sp, unit, live, w, h).px > 0, 'pad geometry works without a model (fallback box)');
}
// ── the garment outline for the pad (pure): triangles facing the view, in the decal's uv frame
{
  const pos = new Float32Array([0, 0, 0.1, 1, 0, 0.1, 0, 2, 0.1,   0, 0, -0.1, 1, 0, -0.1, 0, 2, -0.1]), nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
  const box = P.emptyBox(); P.growBox(box, pos); const front = P.silhouetteTris({ pos, nrm, index: null }, box, 'front'), back = P.silhouetteTris({ pos, nrm, index: null }, box, 'back');
  ok(front.length === 6 && back.length === 6, 'one triangle faces each view');
  ok(Math.max(...front) <= 1 && Math.min(...front) >= 0, 'outline uv inside 0..1 (the same frame as a decal x,y)');
  ok(front[0] === 0 && front[1] === 1 && front[2] === 1, 'front view: x grows to the right, y runs down from the top of the box');
  ok(P.silhouetteTris({ pos, nrm, index: null }, box, 'left').length === 0, 'a view nothing faces has no outline');
}
console.log('decalflow-unit OK (' + n + ' checks)');
