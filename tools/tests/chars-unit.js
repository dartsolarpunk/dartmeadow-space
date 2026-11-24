// node tools/tests/chars-unit.js — character registry + profile persistence + character-select wiring (pure node: no THREE, no browser).
//  1. registry: every entry validates, files exist, clip maps cover the game's clip keys and exist inside the animation GLB, ready flag semantics
//  2. persistence: no data -> Ariel default, garbage -> default, save/load round trip, unknown id -> Ariel, not-ready -> Ariel + fellBack, newest-wins merge with saves,
//     older saves (no `character`) change nothing, storage failures never throw
//  3. wiring in index.html: flow main menu -> character -> builder, goScreen branch, save/load hooks, loader uses the registry and keeps Ariel's URLs
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..', '..'), rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m }; };
const C = require('../../ui/dm-chars.js');
const html = rd('index.html');
function glbJson(f) { const b = fs.readFileSync(path.join(root, f)), jl = b.readUInt32LE(12); return JSON.parse(b.slice(20, 20 + jl).toString()); }

// ── 1. registry
ok(C.list().length >= 2, 'at least Ariel and Emma');
ok(C.get('ariel') && C.get('emma') && C.FALLBACK === 'ariel', 'ariel + emma registered, fallback is ariel');
for (const d of C.list()) {
  ok(C.problems(d).length === 0, d.id + ' validates: ' + C.problems(d).join(','));
  ok(fs.existsSync(path.join(root, d.mesh)), d.id + ' mesh exists');
  ok(fs.existsSync(path.join(root, d.anims)), d.id + ' anims exist');
  const noQ = (u) => u.split('?')[0];   // (v379) cache-busting ?v= tags on the groom / config URLs are not part of the file path
  ok(fs.existsSync(path.join(root, noQ(d.hair.url))), d.id + ' hair groom exists');
  if (d.hair.configUrl) { ok(fs.existsSync(path.join(root, noQ(d.hair.configUrl))), d.id + ' hair config exists'); JSON.parse(rd(noQ(d.hair.configUrl))); }
  const clips = glbJson(d.anims).animations.map((a) => a.name);
  for (const [k, v] of Object.entries(d.clipMap)) ok(clips.includes(v), d.id + ' clip ' + k + ' -> ' + v + ' exists in its animation GLB');
  ok(clips.includes(d.studio.idle), d.id + ' studio idle clip exists');
  for (const x of d.studio.extras || []) ok(clips.includes(x), d.id + ' studio clip ' + x + ' exists');
  const skins = glbJson(d.mesh); ok(skins.skins && skins.skins.length >= 1, d.id + ' mesh has a skin');
}
// the game's own CHAR_CLIP_NAMES (index.html) and Ariel's registry map are the same thing: the default path stays byte for byte what it was
{
  const m = html.match(/const CHAR_CLIP_NAMES = \{([\s\S]*?)\n\};/); ok(m, 'CHAR_CLIP_NAMES found');
  const game = {}; for (const mm of m[1].matchAll(/^\s*(\w+):\s*'([^']+)'/gm)) game[mm[1]] = mm[2];
  ok(Object.keys(game).length >= 11, 'parsed the game clip map');
  for (const d of C.list()) for (const k of Object.keys(game)) ok(d.clipMap[k] === game[k], d.id + ' clipMap.' + k + ' matches the game map');
  const f = html.match(/const CHAR_FILES = \{[\s\S]*?mesh: '([^']+)'[\s\S]*?animSrc: '([^']+)'/); ok(f, 'CHAR_FILES found');
  ok(C.get('ariel').mesh === 'characterassests/' + f[1] && C.get('ariel').anims === 'characterassests/' + f[2], "Ariel's registry URLs equal the game's hard-coded ones");
  ok(C.get('ariel').hair.url === 'characterassests/ariel_hair_strands.bin' && !C.get('ariel').hair.configUrl, "Ariel keeps the loader's built-in hair config");
}
ok(C.get('ariel').accessories.necklace && C.get('ariel').accessories.glassesLed && C.get('ariel').accessories.cloth, 'Ariel keeps necklace / glasses LED / cloth');
ok(C.get('emma').accessories.necklace === false && C.get('emma').accessories.glassesLed === false && C.get('emma').accessories.cloth === false, 'Emma skips the Ariel-only accessories');
// adding a character is one entry
{
  const before = C.list().length;
  C.register({ id: 'zed', name: 'Zed', ready: false, mesh: 'characterassests/zed.glb', anims: 'characterassests/zed_anims.glb', clipMap: { walk: 'W', run: 'R' }, studio: { idle: 'I' }, hair: { url: 'characterassests/zed.bin' }, accessories: {} });
  ok(C.list().length === before + 1 && C.get('zed'), 'register() adds one entry');
  assert.throws(() => C.register({ id: 'Bad Id' }), /bad registry entry/); n++;
  C._reset(mem()); C.setSelected('zed'); const r = C.resolveForGame(); ok(r.id === 'ariel' && r.fellBack && r.wanted === 'zed', 'a ready:false entry falls back to Ariel (fellBack, wanted)');
  ok(C.unregister('zed') && !C.get('zed') && C.list().length === before, 'unregister removes it again (the fallback cannot be removed)'); ok(C.unregister('ariel') === false, 'ariel stays');
}

// ── 2. persistence
{
  const st = mem(); C._reset(st);
  ok(C.selectedId() === 'ariel' && C.resolveForGame().id === 'ariel' && !C.resolveForGame().fellBack, 'no stored data -> Ariel default, nothing falls back');
  ok(JSON.stringify(C.profile().looks) === '{}' && C.profile().v === 1, 'default profile shape');
  ok(C.setSelected('emma') === true && C.selectedId() === 'emma', 'select Emma');
  ok(st.getItem(C.KEY) && JSON.parse(st.getItem(C.KEY)).id === 'emma', 'persisted to ' + C.KEY);
  C._reset(st); ok(C.selectedId() === 'emma', 'reload from storage -> Emma');
  ok(C.setSelected('nobody') === false && C.selectedId() === 'emma', 'unknown id rejected');
  for (const bad of ['{not json', '123', '"x"', '[]', JSON.stringify({ id: 'ghost', looks: { ghost: { colors: { a: 1 } } } }), JSON.stringify({ id: 5, updated: 'x' })]) {
    const s2 = mem(); s2.setItem(C.KEY, bad); C._reset(s2); ok(C.selectedId() === 'ariel', 'garbage storage (' + bad.slice(0, 14) + ') -> Ariel');
  }
  // storage that throws never breaks selection
  C._reset({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } });
  ok(C.selectedId() === 'ariel' && C.setSelected('emma') && C.selectedId() === 'emma', 'throwing storage: still works for the session');
  // migration: a profile from before anything existed (the key absent) is Ariel; a save without `character` leaves a pick alone
  C._reset(mem()); C.setSelected('emma');
  ok(C.importFromSave(undefined) === false && C.importFromSave(null) === false && C.selectedId() === 'emma', 'older save (no character key) changes nothing');
  // newest wins
  const t = C.profile().updated;
  ok(C.importFromSave({ v: 1, id: 'ariel', updated: t - 1000 }) === false && C.selectedId() === 'emma', 'an older save does not undo the fresh pick');
  ok(C.importFromSave({ v: 1, id: 'ariel', updated: t + 1000 }) === true && C.selectedId() === 'ariel', 'a newer save is adopted');
  ok(JSON.parse(JSON.stringify(C.exportForSave())).id === 'ariel', 'exportForSave is JSON-safe');
  let seen = 0; const off = C.onChange(() => seen++); C.setSelected('emma'); ok(seen === 1, 'onChange fires on selection'); off(); C.setSelected('ariel'); ok(seen === 1, 'unsubscribed');
}

// ── 3. wiring
ok(/<button class="menu-btn" onclick="goScreen\('character'\)">/.test(html), 'main menu button opens the character screen');
ok(!/class="menu-btn" onclick="goScreen\('builder'\)"/.test(html), 'main menu no longer jumps straight to the builder');
ok(/id="cs-next"/.test(html) && /W\.goScreen\('builder'\)/.test(rd('ui/dm-charselect.js')), 'character screen continues to the builder');
ok(/id="cs-back"/.test(html) && /\$\('cs-back'\)\.addEventListener\('click', \(\) => W\.goScreen\('menu'\)\)/.test(rd('ui/dm-charselect.js')), 'character screen can go back to the main menu');
ok(/goScreen\('character'\)" title="Back to the Articren select">/.test(html) && /<button class="launch-btn gold" onclick="launchFlight\(\)">/.test(html), 'builder: back to Articren, back to menu, launch');
ok(html.indexOf('id="screen-character"') < html.indexOf('id="screen-builder"') && html.indexOf('id="screen-character"') > html.indexOf('id="screen-menu"'), 'screen order: menu, character, builder');
ok(/else if\(name==='builder'\)/.test(html) && /if\(name==='character'\)\{\$\('screen-character'\)\.classList\.add\('active'\)/.test(html), 'goScreen has the character branch');
ok(/_prevScreen==='character'&&name!=='character'&&window\.DMCharSelect\) DMCharSelect\.leave\(\)/.test(html), 'leaving the screen disposes the studio');
ok(/character:\(window\.DMChars\?window\.DMChars\.exportForSave\(\):null\)/.test(html) && /window\.DMChars\.importFromSave\(data\.character\)/.test(html), 'the pick rides in buildSaveData / loadSaveData');
ok(/<script src="ui\/dm-chars\.js\?v=\d+" defer><\/script>/.test(html) && html.indexOf('ui/dm-chars.js') < html.indexOf('ui/dm-charselect.js'), 'registry loads before the select UI');
ok(/function _charFiles\(\)/.test(html) && /gltfLoader\.load\(_cfiles\.mesh, res,/.test(html) && /gltfLoader\.load\(_cfiles\.anims, res,/.test(html), 'the loader takes mesh + anims from the registry');
ok(/_cd&&_cd\.fellBack/.test(html), 'a not-ready pick falls back to Ariel with a toast');
ok(/_acc\.necklace!==false/.test(html) && /_acc\.glassesLed!==false/.test(html) && /_cdef\.accessories\.cloth!==false/.test(html), 'necklace / glasses LED / cloth are gated by the registry');
ok(/_arielMats=!_cdef\|\|_cdef\.materialFix==='meshy'/.test(html) && C.get('ariel').materialFix === 'meshy' && !C.get('emma').materialFix, "Ariel's material fixes are Ariel-only");
{ const s = rd('ui/dm-charselect.js'); ok(!/['"]ariel['"]|['"]emma['"]/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')), 'the select UI never names a character (registry-driven)'); }
// ── default texture / solid colour model (shirt + pants)
{
  const E = C.get('emma'), A = C.get('ariel'), R = (d, id) => C.regions(d).find((r) => r.id === id);
  ok(R(E, 'shirt').texture === true && R(E, 'pants').texture === true, 'Emma shirt + pants declare a shipped texture (DEFAULT TEXTURE swatch)');
  ok(R(A, 'shirt').texture === false && R(A, 'pants').texture === false && R(E, 'hair.main').texture === undefined, 'Ariel garments are plain colours; hair has no texture mode');
  ok(E.items.shirt.colourMode === 'solid' && E.items.pants.colourMode === 'solid', 'Emma colours replace the texture (solid)');
  const bad = JSON.parse(JSON.stringify(E)); bad.id = 'badmode'; bad.items.shirt.colourMode = 'glitter'; ok(C.problems(bad).includes('items.shirt'), 'an unknown colourMode fails registry validation');
  const bad2 = JSON.parse(JSON.stringify(A)); bad2.id = 'badtex'; bad2.items.shirt.texture = 'yes'; ok(C.problems(bad2).includes('items.shirt'), 'texture must be a boolean');
  const good = JSON.parse(JSON.stringify(A)); good.id = 'goodtex'; good.items.shirt.texture = true; good.items.shirt.colourMode = 'tint'; ok(C.problems(good).length === 0 && C.regions(good).find((r) => r.id === 'shirt').texture, 'a flat item may declare texture:true + colourMode');
  // DEFAULT = no colour stored (the swatch clears the colour), a colour = stored, both survive a save round trip
  C._reset(mem2()); C.setColor('emma', 'shirt', '#c0262d'); ok(C.look('emma').colors.shirt === '#c0262d', 'a colour overrides the texture'); C.setColor('emma', 'shirt', null); ok(!('shirt' in C.look('emma').colors) && C.isDefaultLook(C.look('emma')), 'DEFAULT TEXTURE clears the colour (back to the shipped texture)');
  function mem2() { const o = {}; return { getItem: (k) => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); } }; }
}
ok(/<script src="ui\/dm-decalflow\.js\?v=\d+" defer><\/script>/.test(html) && html.indexOf('ui/dm-decalflow.js') < html.indexOf('ui/dm-charselect.js'), 'the staged-logo logic loads before the select UI');
console.log('chars-unit OK (' + n + ' checks)');
