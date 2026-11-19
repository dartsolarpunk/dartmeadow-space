/* ============================================================================
   ui/dm-chars.js — the playable-character REGISTRY + the character profile (selection, colours, logos).
   Pure data and logic: no THREE, no DOM (node tests: tools/tests/chars-unit.js).  The UI is ui/dm-charselect.js, the in-game / studio painting is
   ui/dm-charpaint.js.  Adding a third character = ONE entry in REGISTRY below (see docs/character-select-notes.md).

   Profile (the player's pick), kept per device in localStorage 'dm_char_v1' AND carried inside every save (buildSaveData().character), so the
   existing private-repo sync (vault / autosave) takes it along - no new sync channel:
     { v:1, id:'ariel'|'emma'|..., updated:<ms>, looks:{ <charId>:{ colors:{<region>:'#rrggbb'}, decals:[...] } } }
   Newest wins when a save is loaded (save.character.updated vs the local one), so an old autosave never undoes a fresh pick.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMChars = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const KEY = 'dm_char_v1', VERSION = 1, FALLBACK = 'ariel';

  /* ───────── the registry ─────────
     id / name / tag         card text
     ready                   false = listed but not selectable for the game: resolveForGame() falls back to Ariel (the UI shows a toast)
     mesh / anims            GLB paths (the game and the studio load exactly these)
     clipMap                 game state -> clip name inside `anims` (the same keys as CHAR_CLIP_NAMES in index.html)
     studio                  idle clip + the occasional extra clips (wave / expression) the studio plays
     hair                    url = the DHS1 groom, configUrl = optional cluster config JSON (null: the loader's built-in default),
                             groups = [{id,label,clusters:[cluster names]}]: the tintable hair regions (setTint works per cluster)
     items                   tintable clothing: { id:{label, mesh:'<regex on the mesh node name>', mode:'flat'|'baked', atlas:<shared-map key, baked only>, defaultColor,
                             decals:'planar'|'uv' (planar = the mesh has no UVs: a 4-view atlas is generated; uv = use its UV islands),
                             spots:{ front|back|left|right:{label?, base:<logo size in metres>, snaps:[{id,label,x,y}]} } } }
     accessories             false = skip safely: necklace (DMCharm), glassesLed (DMFlash), cloth (Ariel's garment cloth solver)
     materialFix             'meshy' = apply the Meshy-export material fixes (metalness default, skin emissive floor); omit for proper PBR materials
   The logo editor (decals) is driven by items[*].spots and the LOGOS list below. */
  // Logo spots: a decal is projected onto the garment along one of four horizontal axes (the character faces +z, her left is +x).  Spot ids are shared by every
  // character; each item lists the spots it offers with their snap points (x, y as fractions of the garment's own bounding box in that view, y down) and a
  // base logo size in metres (scale 1 = base).
  const SPOT_AXES = { front: { label: 'Front', n: [0, 0, 1] }, back: { label: 'Back', n: [0, 0, -1] }, left: { label: 'Left side', n: [1, 0, 0] }, right: { label: 'Right side', n: [-1, 0, 0] } };
  const REGISTRY = [
    {
      id: 'ariel', name: 'Ariel', tag: 'PILOT', ready: true,
      mesh: 'characterassests/Meshy_AI_Autumn_biped_Character_output.glb',
      anims: 'characterassests/Meshy_AI_Autumn_biped_Meshy_AI_Meshy_Merged_Animations.glb',
      clipMap: { walk: 'Walking', run: 'Running', jump: 'Regular_Jump', climbLoop: 'climbing_up_wall', step: 'Mount_Step', stepOff: 'Dismount_Step', swim: 'Swim_Forward',
        crouch: 'Crouch_Walk_Right_with_Torch_inplace', prone: 'Crawl_Backward_inplace', rope: 'Swing_on_Rope_to_Ground', cliff: 'Grab_Bar_and_Swing_Forward' },
      studio: { idle: 'Idle_Breathe_Blink', extras: ['Acting_Wave_Happy', 'Acting_Surprised', 'Acting_Thinking'] },
      hair: { url: 'characterassests/ariel_hair_strands.bin', configUrl: null,
        groups: [{ id: 'main', label: 'Hair', clusters: ['back', 'sideburns', 'top'] }, { id: 'fringe', label: 'Fringe', clusters: ['bangs'] }] },
      // tintable clothing: plain colour factors (no baked paint), so the material colour is the whole story
      items: {
        // decals: her garments have no UV layout, so the first logo on an item gives it a planar 4-view atlas (front / back / left / right, built once at load)
        shirt: { label: 'Shirt', mesh: '^Shirt', mode: 'flat', defaultColor: '#292929', decals: 'planar', spots: {
          front: { base: 0.14, snaps: [{ id: 'chest', label: 'Chest', x: 0.5, y: 0.3 }, { id: 'chestL', label: 'Chest left', x: 0.7, y: 0.3 }, { id: 'chestR', label: 'Chest right', x: 0.3, y: 0.3 }, { id: 'belly', label: 'Belly', x: 0.5, y: 0.62 }] },
          back: { base: 0.18, snaps: [{ id: 'upper', label: 'Upper back', x: 0.5, y: 0.3 }, { id: 'centre', label: 'Centre', x: 0.5, y: 0.55 }] },
          left: { label: 'Left sleeve', base: 0.06, snaps: [{ id: 'sleeve', label: 'Sleeve', x: 0.4, y: 0.2 }] },
          right: { label: 'Right sleeve', base: 0.06, snaps: [{ id: 'sleeve', label: 'Sleeve', x: 0.4, y: 0.2 }] } } },
        pants: { label: 'Pants', mesh: '^Pants', mode: 'flat', defaultColor: '#272727', decals: 'planar', spots: {
          front: { base: 0.1, snaps: [{ id: 'thighL', label: 'Left thigh', x: 0.72, y: 0.3 }, { id: 'thighR', label: 'Right thigh', x: 0.28, y: 0.3 }, { id: 'shinL', label: 'Left shin', x: 0.72, y: 0.65 }, { id: 'shinR', label: 'Right shin', x: 0.28, y: 0.65 }] },
          back: { base: 0.12, snaps: [{ id: 'pocketL', label: 'Left pocket', x: 0.28, y: 0.14 }, { id: 'pocketR', label: 'Right pocket', x: 0.72, y: 0.14 }] },
          left: { label: 'Left side', base: 0.09, snaps: [{ id: 'thigh', label: 'Thigh', x: 0.5, y: 0.3 }, { id: 'shin', label: 'Shin', x: 0.5, y: 0.65 }] },
          right: { label: 'Right side', base: 0.09, snaps: [{ id: 'thigh', label: 'Thigh', x: 0.5, y: 0.3 }, { id: 'shin', label: 'Shin', x: 0.5, y: 0.65 }] } } },
      },
      accessories: { necklace: true, glassesLed: true, cloth: true },
      materialFix: 'meshy',   // her Meshy export needs the metalness / skin-floor fixes loadCharacterAssets applies (a pilot with proper PBR materials leaves this out)
    },
    {
      id: 'emma', name: 'Emma', tag: 'ENGINEER', ready: true,
      mesh: 'characterassests/emma/Emma_Character.glb',
      anims: 'characterassests/emma/Emma_Merged_Animations.glb',
      clipMap: { walk: 'Walking', run: 'Running', jump: 'Regular_Jump', climbLoop: 'climbing_up_wall', step: 'Mount_Step', stepOff: 'Dismount_Step', swim: 'Swim_Forward',
        crouch: 'Crouch_Walk_Right_with_Torch_inplace', prone: 'Crawl_Backward_inplace', rope: 'Swing_on_Rope_to_Ground', cliff: 'Grab_Bar_and_Swing_Forward' },
      studio: { idle: 'Emma_Idle', extras: ['Acting_Wave_Happy', 'Acting_Surprised', 'Acting_Thinking'] },
      hair: { url: 'characterassests/emma/emma_hair_strands.bin', configUrl: 'characterassests/emma/emma_hair_config.json',
        groups: [{ id: 'main', label: 'Hair', clusters: ['back', 'sideburns', 'top', 'underlayer'] }, { id: 'fringe', label: 'Fringe', clusters: ['bangs'] }] },
      // shirt and pants share ONE baked cloth atlas: the item's UV islands are recoloured inside a canvas copy of it (detail kept)
      items: {
        // decals are projected into the same atlas (her UV islands are used as they are)
        shirt: { label: 'Shirt', mesh: '^Emma_Shirt$', mode: 'baked', atlas: 'cloth', defaultColor: '#212020', decals: 'uv', spots: {
          front: { base: 0.14, snaps: [{ id: 'chest', label: 'Chest', x: 0.5, y: 0.3 }, { id: 'chestL', label: 'Chest left', x: 0.7, y: 0.3 }, { id: 'chestR', label: 'Chest right', x: 0.3, y: 0.3 }, { id: 'belly', label: 'Belly', x: 0.5, y: 0.62 }] },
          back: { base: 0.18, snaps: [{ id: 'upper', label: 'Upper back', x: 0.5, y: 0.3 }, { id: 'centre', label: 'Centre', x: 0.5, y: 0.55 }] },
          left: { label: 'Left sleeve', base: 0.06, snaps: [{ id: 'sleeve', label: 'Sleeve', x: 0.4, y: 0.2 }] },
          right: { label: 'Right sleeve', base: 0.06, snaps: [{ id: 'sleeve', label: 'Sleeve', x: 0.4, y: 0.2 }] } } },
        pants: { label: 'Pants', mesh: '^Emma_Pants$', mode: 'baked', atlas: 'cloth', defaultColor: '#212020', decals: 'uv', spots: {
          front: { base: 0.1, snaps: [{ id: 'thighL', label: 'Left thigh', x: 0.72, y: 0.3 }, { id: 'thighR', label: 'Right thigh', x: 0.28, y: 0.3 }, { id: 'shinL', label: 'Left shin', x: 0.72, y: 0.65 }, { id: 'shinR', label: 'Right shin', x: 0.28, y: 0.65 }] },
          back: { base: 0.12, snaps: [{ id: 'pocketL', label: 'Left pocket', x: 0.28, y: 0.14 }, { id: 'pocketR', label: 'Right pocket', x: 0.72, y: 0.14 }] },
          left: { label: 'Left side', base: 0.09, snaps: [{ id: 'thigh', label: 'Thigh', x: 0.5, y: 0.3 }, { id: 'shin', label: 'Shin', x: 0.5, y: 0.65 }] },
          right: { label: 'Right side', base: 0.09, snaps: [{ id: 'thigh', label: 'Thigh', x: 0.5, y: 0.3 }, { id: 'shin', label: 'Shin', x: 0.5, y: 0.65 }] } } },
      },
      accessories: { necklace: false, glassesLed: false, cloth: false },
    },
  ];

  const byId = new Map();
  function spotsValid(it) {
    if (it.decals !== 'planar' && it.decals !== 'uv') return false;
    const ks = Object.keys(it.spots); if (!ks.length || ks.length > 4) return false;
    return ks.every((k) => SPOT_AXES[k] && it.spots[k].base > 0.01 && it.spots[k].base < 0.6 && Array.isArray(it.spots[k].snaps) && it.spots[k].snaps.length > 0 &&
      it.spots[k].snaps.every((sn) => /^[a-zA-Z]\w*$/.test(sn.id || '') && sn.label && sn.x >= 0 && sn.x <= 1 && sn.y >= 0 && sn.y <= 1));
  }
  const problems = (d) => {   // registry validation (also used by the unit test and by register())
    const p = [], s = (v) => typeof v === 'string' && v.length > 0;
    if (!d || typeof d !== 'object') return ['not an object'];
    if (!s(d.id) || !/^[a-z][a-z0-9_]*$/.test(d.id)) p.push('id');
    if (!s(d.name)) p.push('name');
    if (typeof d.ready !== 'boolean') p.push('ready');
    if (!s(d.mesh) || !/\.glb$/i.test(d.mesh)) p.push('mesh');
    if (!s(d.anims) || !/\.glb$/i.test(d.anims)) p.push('anims');
    if (!d.clipMap || typeof d.clipMap !== 'object' || !d.clipMap.walk || !d.clipMap.run) p.push('clipMap');
    if (!d.studio || !s(d.studio.idle)) p.push('studio.idle');
    if (!d.hair || !s(d.hair.url)) p.push('hair.url');
    if (!d.accessories || typeof d.accessories !== 'object') p.push('accessories');
    if (d.hair && d.hair.groups) { if (!Array.isArray(d.hair.groups) || d.hair.groups.some((g) => !g || !/^[a-z]\w*$/.test(g.id || '') || !g.label || !Array.isArray(g.clusters) || !g.clusters.length)) p.push('hair.groups'); }
    if (d.items) for (const id of Object.keys(d.items)) { const it = d.items[id]; if (!/^[a-z]\w*$/.test(id) || !it || !it.label || typeof it.mesh !== 'string' || (it.mode !== 'flat' && it.mode !== 'baked') || !isHex(it.defaultColor) || (it.mode === 'baked' && !it.atlas) || (it.spots && !spotsValid(it))) p.push('items.' + id); else { try { new RegExp(it.mesh); } catch (e) { p.push('items.' + id + '.mesh'); } } }
    return p;
  };
  function register(def) {
    const pr = problems(def); if (pr.length) throw new Error('[DMChars] bad registry entry ' + (def && def.id) + ': ' + pr.join(', '));
    const i = REGISTRY.findIndex((r) => r.id === def.id); if (i >= 0) REGISTRY[i] = def; else REGISTRY.push(def);
    byId.set(def.id, def); return def;
  }
  function unregister(id) { const i = REGISTRY.findIndex((r) => r.id === id); if (i >= 0 && id !== FALLBACK) { REGISTRY.splice(i, 1); byId.delete(id); return true; } return false; }
  REGISTRY.forEach((d) => byId.set(d.id, d));
  const list = () => REGISTRY.slice();
  const get = (id) => byId.get(id) || null;
  const readyIds = () => REGISTRY.filter((d) => d.ready).map((d) => d.id);

  /* ───────── profile: normalise / migrate ───────── */
  const isHex = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
  function emptyLook() { return { colors: {}, decals: [] }; }
  function defaultProfile() { return { v: VERSION, id: FALLBACK, updated: 0, looks: {} }; }
  // anything -> a valid profile.  No data / garbage / a future shape -> the default (Ariel).  Unknown character ids are kept in `looks` only if registered.
  function normalize(raw) {
    const P = defaultProfile();
    if (!raw || typeof raw !== 'object') return P;
    if (typeof raw.id === 'string' && byId.has(raw.id)) P.id = raw.id;
    if (typeof raw.updated === 'number' && isFinite(raw.updated) && raw.updated > 0) P.updated = Math.floor(raw.updated);
    const L = raw.looks && typeof raw.looks === 'object' ? raw.looks : {};
    for (const id of Object.keys(L)) { if (byId.has(id)) P.looks[id] = normalizeLook(byId.get(id), L[id]); }
    return P;
  }
  // ── regions: what the registry lets the player recolour.  ids: 'hair.<group id>' and '<item id>'
  function regions(def) {
    const out = [];
    for (const g of (def && def.hair && def.hair.groups) || []) out.push({ id: 'hair.' + g.id, kind: 'hair', label: g.label, clusters: g.clusters });
    for (const id of Object.keys((def && def.items) || {})) out.push({ id, kind: 'item', label: def.items[id].label, mode: def.items[id].mode, defaultColor: def.items[id].defaultColor });
    return out;
  }
  const regionIds = (def) => regions(def).map((r) => r.id);
  // a look from anything: only registry-declared regions survive, colours must be #rrggbb (lower-cased)
  function normalizeLook(def, raw) {
    const out = emptyLook(); if (!raw || typeof raw !== 'object') return out;
    const ids = new Set(regionIds(def)), c = raw.colors && typeof raw.colors === 'object' ? raw.colors : {};
    for (const k of Object.keys(c)) if (ids.has(k) && isHex(c[k])) out.colors[k] = c[k].toLowerCase();
    return out;
  }
  const isDefaultLook = (L) => !L || (!Object.keys(L.colors || {}).length && !(L.decals || []).length);
  // a short stable string for a character's look: thumbnails are re-captured when it changes
  function lookSig(id) { const L = lookOf(load(), id); return JSON.stringify([Object.keys(L.colors).sort().map((k) => k + L.colors[k]), (L.decals || []).length]); }
  // palettes: the player picks from these (plus a free colour picker in the UI); 'default' is no override
  const PALETTE_CLOTH = ['#15151a', '#3a3d46', '#ecebe6', '#c9b48a', '#a8501f', '#c0262d', '#e8892a', '#e2b33c', '#6b7a3a', '#2f8f5b', '#1f8a8a', '#3f8fd2', '#1d2f6b', '#6d4bb5', '#c43d8f', '#ff6b57'];
  const PALETTE_HAIR = ['#0d0b0b', '#2b1a10', '#4a2c17', '#6b3b1e', '#7a2f17', '#b4521e', '#c9a25a', '#e1d3b0', '#8c8c92', '#e9e7e2', '#2b4fd6', '#1fb5a3', '#e0559a', '#7b3fc4', '#3fae55', '#b3202a'];
  const lookOf = (P, id) => P.looks[id] || emptyLook();

  /* ───────── persistence ───────── */
  let _store = null;
  const storage = () => { if (_store) return _store; try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } };
  let PROFILE = null; const listeners = new Set();
  function load() {
    if (PROFILE) return PROFILE;
    let raw = null; try { const s = storage(); if (s) raw = JSON.parse(s.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    PROFILE = normalize(raw); return PROFILE;
  }
  function persist() { try { const s = storage(); if (s) s.setItem(KEY, JSON.stringify(PROFILE)); } catch (e) { /* private mode / quota: the pick still holds for this session and rides in the next save */ } }
  function touch(emit) { PROFILE.updated = Date.now(); persist(); if (emit !== false) listeners.forEach((f) => { try { f(PROFILE); } catch (e) { } }); }
  const profile = () => load();
  const selectedId = () => load().id;
  function setSelected(id) {
    if (!byId.has(id)) return false; load(); if (PROFILE.id === id) return true; PROFILE.id = id; touch(); return true;
  }
  const look = (id) => lookOf(load(), id || load().id);
  function ensureLook(id) { load(); if (!PROFILE.looks[id]) PROFILE.looks[id] = emptyLook(); return PROFILE.looks[id]; }
  // hex = '#rrggbb' sets, null / '' clears (back to the shipped colour).  Only registry-declared regions are accepted.
  function setColor(id, region, hex) {
    const d = byId.get(id); if (!d || !regionIds(d).includes(region)) return false;
    if (hex && !isHex(hex)) return false; const L = ensureLook(id);
    if (hex) L.colors[region] = hex.toLowerCase(); else delete L.colors[region];
    if (isDefaultLook(L)) delete PROFILE.looks[id]; touch(); return true;
  }
  function resetLook(id) { load(); if (!PROFILE.looks[id]) return false; delete PROFILE.looks[id]; touch(); return true; }
  // what the game loads RIGHT NOW: the chosen character if its registry entry is ready, otherwise Ariel (the UI / game raise the toast from fellBack)
  function resolveForGame() {
    const P = load(); let id = P.id, fellBack = false;
    const d = byId.get(id);
    if (!d || !d.ready) { id = FALLBACK; fellBack = true; }
    return { id, def: byId.get(id), look: lookOf(P, id), fellBack, wanted: P.id };
  }

  /* ───────── save / load (the profile travels inside the save) ───────── */
  const exportForSave = () => JSON.parse(JSON.stringify(load()));
  // data.character absent (older save) -> nothing changes; present and NEWER than this device's pick -> adopted; older -> ignored.  Returns true when adopted.
  function importFromSave(sv) {
    if (!sv || typeof sv !== 'object') return false;
    const inc = normalize(sv); load();
    if (!(inc.updated > PROFILE.updated)) return false;
    PROFILE = inc; persist(); listeners.forEach((f) => { try { f(PROFILE); } catch (e) { } }); return true;
  }
  const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

  const DM = { KEY, VERSION, FALLBACK, REGISTRY, register, unregister, problems, list, get, readyIds, isHex, emptyLook, defaultProfile, normalize, normalizeLook,
    regions, regionIds, setColor, resetLook, isDefaultLook, lookSig, PALETTE_CLOTH, PALETTE_HAIR,
    profile, selectedId, setSelected, look, resolveForGame, exportForSave, importFromSave, onChange, load, persist, touch,
    _reset(storageObj) { _store = storageObj || null; PROFILE = null; listeners.clear(); },
    _lookOf: lookOf, _setProfile(P) { PROFILE = P; } };
  return DM;
});
