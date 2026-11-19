/* ============================================================================
   ui/dm-decalflow.js — the staged logo (decal) flow of the character studio, as PURE logic (no DOM, no three.js; node test: tools/tests/decalflow-unit.js).

   The flow:   pick a logo  ->  tap a garment  ->  a PENDING decal appears on the character (preview only, nothing saved)  ->  move / size / turn it  ->  APPLY (saved, counted)
     * picking another logo while a decal is pending swaps the logo and KEEPS the placement (position, size, turn, colour, spot)
     * RESET puts the pending placement back to the spot's default place / size 1 / turn 0 (logo, garment and colour are kept)
     * CANCEL drops the pending decal; APPLY commits it through DMChars.addDecal (or updateDecal when an applied logo is being EDITED)
     * after APPLY the logo / garment stay chosen, so "add another" is one tap; the same logo or a different one
     * applied decals can be selected in a list and deleted (selection set, "clear all on this garment")
   The preview is a look: previewLook(storedLook, state) = the stored look plus the pending decal (or with the edited decal replaced), which the studio hands to
   DMCharPaint.apply — the stored profile (dm_char_v1) is only written by apply / remove, so a pending decal never reaches a save and a closed studio forgets it.

   Also the placement pad geometry (where the logo box, size handle and turn knob sit, which one a touch hits, what a drag changes), so the pad and its tests share one source.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DMDecalFlow = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const DEF_COLOUR = '#ecebe6', DEF_TEXT = 'DART';
  const wrapDeg = (r) => Math.round(((+r || 0) % 360 + 540) % 360 - 180);

  function newState() {
    return { logo: null, text: DEF_TEXT, colour: DEF_COLOUR, item: null, spot: null, x: 0.5, y: 0.5, scale: 1, rotation: 0, pending: false, editIndex: -1, sel: [] };
  }
  const spotOf = (def, item, spot) => def && def.items && def.items[item] && def.items[item].spots && def.items[item].spots[spot] || null;
  const firstSpot = (def, item) => { const s = def && def.items && def.items[item] && def.items[item].spots; return s ? Object.keys(s)[0] : null; };
  // the default place of a spot: its first snap point, size 1, no turn
  function defaultPlacement(def, item, spot) {
    const sp = spotOf(def, item, spot); if (!sp) return null; const sn = sp.snaps[0]; return { x: sn.x, y: sn.y, scale: 1, rotation: 0 };
  }

  function make(DC) {
    const MAX = DC.MAX_DECALS, SMIN = DC.SCALE_MIN, SMAX = DC.SCALE_MAX;
    const count = (def, look, item) => ((look && look.decals) || []).filter((d) => d.item === item).length;

    // ── choosing
    // pick a logo.  Pending: the pending decal changes logo and keeps everything else (the auto-update).  Returns 'swapped' | 'picked'.
    function pickLogo(st, logoId) {
      if (!DC.logoById.has(logoId)) return 'invalid';
      const was = st.logo; st.logo = logoId; return st.pending && was !== logoId ? 'swapped' : 'picked';
    }
    // tap a garment: starts a pending decal there (or moves a pending one onto the new garment with that garment's default place).  Returns {ok, reason}
    function pickItem(st, def, look, item) {
      if (!st.logo) return { ok: false, reason: 'logo' };
      if (!spotOf(def, item, firstSpot(def, item))) return { ok: false, reason: 'item' };
      const editing = st.editIndex >= 0;
      if (st.pending && !editing && st.item === item) return { ok: true, reason: 'same' };   // already placing on it: nothing changes
      if (count(def, look, item) >= MAX && !(editing && look.decals[st.editIndex] && look.decals[st.editIndex].item === item)) return { ok: false, reason: 'full' };
      const spot = firstSpot(def, item), p = defaultPlacement(def, item, spot);
      st.editIndex = -1; st.item = item; st.spot = spot; st.x = p.x; st.y = p.y; st.scale = p.scale; st.rotation = p.rotation; st.pending = true; return { ok: true, reason: 'started' };
    }
    // change the view (front / back / sleeve ...): the place goes to that view's default, size and turn are kept
    function pickSpot(st, def, spot) {
      if (!st.pending || !spotOf(def, st.item, spot)) return false; const p = defaultPlacement(def, st.item, spot); st.spot = spot; st.x = p.x; st.y = p.y; return true;
    }
    // patch {x,y,scale,rotation,colour,text}; everything is clamped like a stored decal.  snap:true pulls a drop near a snap point onto it.
    function setPlacement(st, def, patch) {
      if (!st.pending || !patch) return false;
      if (patch.x != null && isFinite(+patch.x)) st.x = clamp(+patch.x, 0.02, 0.98);
      if (patch.y != null && isFinite(+patch.y)) st.y = clamp(+patch.y, 0.02, 0.98);
      if (patch.scale != null && isFinite(+patch.scale)) st.scale = Math.round(clamp(+patch.scale, SMIN, SMAX) * 100) / 100;
      if (patch.rotation != null && isFinite(+patch.rotation)) st.rotation = wrapDeg(patch.rotation);
      if (patch.colour != null && DC.isHex(patch.colour)) st.colour = String(patch.colour).toLowerCase();
      if (patch.text != null) st.text = DC.cleanText(patch.text);
      if (patch.snap) { const sn = DC.snapPoint(def, st.item, st.spot, st.x, st.y, patch.snapRadius); if (sn) { st.x = sn.x; st.y = sn.y; } }
      st.x = Math.round(st.x * 1000) / 1000; st.y = Math.round(st.y * 1000) / 1000; return true;
    }
    // RESET: the pending placement back to default (place / size / turn).  The logo, garment, view, colour and text stay.
    function reset(st, def) {
      if (!st.pending) return false; const p = defaultPlacement(def, st.item, st.spot); if (!p) return false; st.x = p.x; st.y = p.y; st.scale = p.scale; st.rotation = p.rotation; return true;
    }
    const isDefaultPlacement = (st, def) => { const p = st.pending && defaultPlacement(def, st.item, st.spot); return !!p && st.x === p.x && st.y === p.y && st.scale === p.scale && st.rotation === p.rotation; };
    function cancel(st) { const was = st.pending; st.pending = false; st.editIndex = -1; return was; }

    // ── the pending decal as a stored-decal record (or null: no logo / text logo without text / bad spot)
    function pendingRecord(st, def) {
      if (!st.pending || !st.logo) return null;
      return DC.normalizeDecal(def, { id: st.logo, item: st.item, spot: st.spot, x: st.x, y: st.y, scale: st.scale, rotation: st.rotation, colour: st.colour, text: st.text });
    }
    // the look the studio paints: stored look + the pending decal (appended; or replacing the edited one).  No pending -> the same object back.
    function previewLook(look, st, def) {
      const rec = pendingRecord(st, def); if (!rec) return look;
      const decals = (look.decals || []).slice(); if (st.editIndex >= 0 && decals[st.editIndex]) decals[st.editIndex] = rec; else decals.push(rec);
      return { colors: look.colors || {}, decals };
    }
    // can APPLY run now?  {ok, reason}
    function canApply(st, def, look) {
      if (!st.pending) return { ok: false, reason: 'nothing' };
      const rec = pendingRecord(st, def); if (!rec) return { ok: false, reason: st.logo && DC.logoById.get(st.logo).text ? 'text' : 'invalid' };
      if (st.editIndex < 0 && count(def, look, st.item) >= MAX) return { ok: false, reason: 'full' };
      if (st.editIndex >= 0 && !(look.decals || [])[st.editIndex]) return { ok: false, reason: 'gone' };
      return { ok: true, reason: '' };
    }
    // APPLY: commit through DMChars.  Returns the index in look.decals or -1.  Afterwards nothing is pending; logo / garment / view stay chosen so "add another" is one tap,
    // and the next pending decal starts from the default place (not from where the last one went).
    function apply(st, def) {
      const look = DC.look(def.id), c = canApply(st, def, look); if (!c.ok) return -1;
      const rec = pendingRecord(st, def); let idx;
      if (st.editIndex >= 0) idx = DC.updateDecal(def.id, st.editIndex, rec) ? st.editIndex : -1;
      else idx = DC.addDecal(def.id, st.item, st.spot, st.logo, { x: rec.x, y: rec.y, scale: rec.scale, rotation: rec.rotation, colour: rec.colour, text: rec.text });
      if (idx < 0) return -1;
      st.pending = false; st.editIndex = -1; st.sel = []; const p = defaultPlacement(def, st.item, st.spot); if (p) { st.x = p.x; st.y = p.y; st.scale = p.scale; st.rotation = p.rotation; } return idx;
    }
    // "add another": a new pending decal of the chosen logo on the chosen garment (default place).  {ok, reason}
    function addAnother(st, def, look) { return st.item ? (st.pending ? { ok: true, reason: 'same' } : pickItem(st, def, look, st.item)) : { ok: false, reason: 'item' }; }

    // ── applied decals: edit / select / delete
    // load an applied decal into the pending slot (it is replaced on APPLY, untouched on CANCEL)
    function edit(st, def, look, index) {
      const d = (look.decals || [])[index]; if (!d) return false;
      st.logo = d.id; st.item = d.item; st.spot = d.spot; st.x = d.x; st.y = d.y; st.scale = d.scale; st.rotation = d.rotation; st.colour = d.colour; if (d.text) st.text = d.text; st.pending = true; st.editIndex = index; st.sel = []; return true;
    }
    function toggleSel(st, index) { const i = st.sel.indexOf(index); if (i >= 0) st.sel.splice(i, 1); else st.sel.push(index); st.sel.sort((a, b) => a - b); return st.sel.slice(); }
    function selectAll(st, look, item) { st.sel = (look.decals || []).map((d, i) => (!item || d.item === item ? i : -1)).filter((i) => i >= 0); return st.sel.slice(); }
    // a pending EDIT follows its decal when others are removed before it, and ends when the edited decal itself goes
    function _afterRemove(st, removed) {
      if (st.editIndex >= 0) { if (removed.includes(st.editIndex)) { st.pending = false; st.editIndex = -1; } else st.editIndex -= removed.filter((i) => i < st.editIndex).length; }
      st.sel = [];
    }
    // delete the selected applied decals; returns how many went
    function deleteSelected(st, def) {
      const idx = st.sel.filter((i, k, a) => a.indexOf(i) === k).sort((a, b) => b - a); let n = 0, done = [];
      for (const i of idx) if (DC.removeDecal(def.id, i)) { n++; done.push(i); }
      _afterRemove(st, done); return n;
    }
    // clear every applied decal on one garment ("clear all on this shirt"); returns how many went
    function clearGarment(st, def, item) {
      const before = DC.look(def.id).decals, gone = before.map((d, i) => (d.item === item ? i : -1)).filter((i) => i >= 0); if (!gone.length) return 0;
      DC.clearDecals(def.id, item); _afterRemove(st, gone); return gone.length;
    }
    // drop selection indices that no longer exist (the look changed elsewhere)
    function pruneSel(st, look) { st.sel = st.sel.filter((i) => i < (look.decals || []).length); }

    // text for the buttons and the list
    function summary(st, def, look) {
      const items = Object.keys(def.items || {}).filter((i) => def.items[i].spots), out = {};
      for (const i of items) out[i] = { count: count(def, look, i), max: MAX, full: count(def, look, i) >= MAX };
      return out;
    }

    return { pickLogo, pickItem, pickSpot, setPlacement, reset, isDefaultPlacement, cancel, pendingRecord, previewLook, canApply, apply, addAnother, edit, toggleSel, selectAll, deleteSelected, clearGarment, pruneSel, summary, count };
  }

  /* ───────── placement pad geometry (pixels of the pad canvas, y down) ─────────
     view: {W,H} metres of the garment's box in this view (or null), spot: registry spot, unit: root units per metre, live: {x,y,scale,rotation}, w,h: pad size in px.
     The logo box is `px` wide (>= 10); the SIZE handle sits on its bottom-right corner, the TURN knob 26 px above its top edge (both rotate with the logo). */
  function padGeom(view, spot, unit, live, w, h) {
    const fw = view ? (spot.base * live.scale * unit) / view.W : 0.3, px = Math.max(10, fw * w), half = px / 2, th = live.rotation * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    const cx = live.x * w, cy = live.y * h, rot = (lx, ly) => [cx + lx * c - ly * s, cy + lx * s + ly * c], KN = 26;
    return { cx, cy, px, half, th, size: rot(half, half), turn: rot(0, -half - KN), corners: [rot(-half, -half), rot(half, -half), rot(half, half), rot(-half, half)], tip: rot(0, -half) };
  }
  // what a touch at (x,y) grabs: 'turn' knob, 'size' handle, or 'move' (anywhere else on the pad).  R = hit radius in px (22 -> 44 px touch target)
  function padHit(g, x, y, R) {
    R = R || 22; const d = (p) => Math.hypot(p[0] - x, p[1] - y);
    const dt = d(g.turn), ds = d(g.size); if (dt <= R && dt <= ds) return 'turn'; if (ds <= R) return 'size'; return 'move';
  }
  // the patch a drag to (x,y) makes, given the grab mode and the geometry at pointer-down.  move keeps the grab offset (off = [dx,dy] px from the logo centre at pointer-down).
  function padDrag(mode, g, live, x, y, w, h, off, opt) {
    opt = opt || {}; const SMIN = opt.scaleMin || 0.4, SMAX = opt.scaleMax || 3;
    if (mode === 'turn') { const a = Math.atan2(y - g.cy, x - g.cx) * 180 / Math.PI + 90, st = opt.turnStep || 5; return { rotation: wrapDeg(Math.round(a / st) * st) }; }
    if (mode === 'size') { const r0 = Math.hypot(g.size[0] - g.cx, g.size[1] - g.cy) || 1, r1 = Math.hypot(x - g.cx, y - g.cy); return { scale: Math.round(clamp(live.scale * r1 / r0, SMIN, SMAX) * 20) / 20 }; }
    const o = off || [0, 0]; return { x: clamp((x - o[0]) / w, 0.02, 0.98), y: clamp((y - o[1]) / h, 0.02, 0.98) };
  }

  return { make, newState, defaultPlacement, padGeom, padHit, padDrag, DEF_COLOUR, DEF_TEXT };
});
