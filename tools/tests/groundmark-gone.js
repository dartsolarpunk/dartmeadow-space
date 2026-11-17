// node tools/tests/groundmark-gone.js — t1472: the ground-projector circles are deleted ENTIRELY (Ariel's red footprint disc, the board's blue frame,
// the park / summon split + rejoin projector animation): ui/dm-groundmark.js + ui/dm-projector.js + their hooks, script tags and tests, with no dead
// ?groundmark=0 path left. Kept: park / summon gameplay (BOARD_CALL parked / rejoin, the kite park + call buttons, the "Skyboard follows you again"
// toast, the floating kite at z-index 3510), the character-group collision tessellation (ui/dm-cgroup.js + ui/dm-localcollide.js), unrelated holos
// and the Bird Temple projectors.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8'), ex = p => fs.existsSync(path.join(root, p));
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const html = rd('index.html');
console.log('== ground projectors gone');
for (const f of ['ui/dm-groundmark.js', 'ui/dm-projector.js', 'tools/tests/groundmark-pending.test.js', 'tools/gm-harness.html']) ok(!ex(f), f + ' deleted');
const RX = /DMGroundMark|DMProjector|dm-groundmark|dm-projector|groundmark|groundMark|gm-harness/;
ok(!RX.test(html), 'index.html: no DMGroundMark / DMProjector / groundMark hook, script tag or ?groundmark switch');
const scan = d => fs.readdirSync(path.join(root, d)).filter(f => /\.(js|css|html|py|json)$/.test(f)).map(f => d + '/' + f);
const files = scan('ui').concat(scan('tools/tests').filter(f => !/groundmark-gone\.js$/.test(f)), ['sw.js']).filter(ex);
// fov-fade.js compares the chunk scatter to the 78d0e81 baseline with the deleted receiver tag stripped: that baseline-normalising line is the one
// allowed mention (it removes the tag, it does not use it)
const hits = files.filter(f => RX.test(rd(f).split('\n').filter(l => !(f.endsWith('fov-fade.js') && /gen0\.replace\(/.test(l))).join('\n'))); ok(!hits.length, 'no reference left in ui/, tools/tests/, sw.js (' + hits.join(', ') + ')');
ok(!/function _pwMapTag\(root,gm\)/.test(html) && /function _pwMapTag\(root\)\{/.test(html), '_pwMapTag lost its ground-mark opt-in parameter');
ok(!/userData\.groundMark/.test(html), 'no mesh is tagged as a projector receiver any more');
// ── (v324) NO RING / DISC / BLOB UNDER THE CHARACTER OR THE BOARD, for good.  Justin: the animated blue / red rings projected under Ariel and the Skyboard were to be removed "entirely, never even
// thought of again".  Beyond the deleted projector files above this pins the rest: (1) every ring-like geometry (Ring / Torus / Circle) in ui/*.js and index.html sits in a REVIEWED place
// (a fixed world fixture, a menu / builder / map marker, the board's own deck art) - a new one anywhere else fails here and must be reviewed against "is it under her / the board?";
// (2) the only ground disc that may ever follow her is the DMPolish contact blob: a neutral-black radial falloff, not animated, not coloured, hidden whenever a real shadow map works.
console.log('== no ring / disc under the character or the board');
const RGX = /RingGeometry|TorusGeometry|CircleGeometry/g;
const UI_OK = { 'ui/dm-ar-core.js': 1,   // AR-session reticle (AR only, not in the world)
  'ui/dm-charm.js': 1,                    // the kite charm's 4 mm chain bail (part of the charm model)
  'ui/dm-holo.js': 1 };                   // the relay tower's floor arcs at a fixed world position
const uiHits = {}; for (const f of fs.readdirSync(path.join(root, 'ui')).filter(f => /\.js$/.test(f))) { const n = (rd('ui/' + f).match(RGX) || []).length; if (n) uiHits['ui/' + f] = n; }
for (const f of Object.keys(uiHits)) ok(UI_OK[f] === uiHits[f], f + ': ' + uiHits[f] + ' ring-like geometry call(s), reviewed allowance ' + (UI_OK[f] || 0) + ' - a new Ring / Torus / Circle mesh must be checked against "is it under the character or the board?" and added here only if it is a fixed fixture');
// index.html: allowed by ENCLOSING FUNCTION (journal beacons, quick-travel / galaxy / planet-ring maps, the board BUILDER, the board's own deck art, landing marker, prop models)
const IDX_OK = new Set(['_jnBeacon', 'rMat', '_qtYouAreHere', 'opac', 'JUP', '_buildArielBoard', 'buildBoardMesh', 'buildGalaxySolarTier', 'buildSunMarker', 'ringGroup', '_landMarkerAt', '_mkGeometry']);
{ const L = html.split('\n'); const bad = [];
  L.forEach((l, i) => { if (!/RingGeometry|TorusGeometry|CircleGeometry/.test(l)) return; let j = i; while (j > 0 && !/^\s*(async\s+)?function\s+\w+|^\s*(const|let)\s+\w+\s*=\s*(async\s*)?(\(|function)/.test(L[j])) j--; const m = L[j].match(/function\s+(\w+)|(?:const|let)\s+(\w+)/), name = m ? (m[1] || m[2]) : '?'; if (!IDX_OK.has(name)) bad.push((i + 1) + ' in ' + name); });
  ok(!bad.length, 'index.html: ring-like geometry only in reviewed functions (unreviewed: ' + bad.join(', ') + ')'); }
// the board's own deck art is the ONLY "energy ring" mesh, flush ON the deck of the board model; none is created per frame / follows the ground
ok((html.match(/name='energy ring '/g) || []).length === 1 && /function _buildArielBoard/.test(html), "exactly one 'energy ring' mesh definition (Ariel's board deck art, inside _buildArielBoard)");
ok(!/(groundRing|footRing|footprintRing|underRing|boardRing|energyRingGround|projectorRing|shadowDisc|groundDisc|probeDisc|hoverRing)/i.test(html + files.map(rd).join('\n')), 'no ground / foot / under-board ring or disc by any of the old names');
// (t1536) the contact blob (ui/dm-polish.js) is GONE: P.contact is a no-op that only removes + frees a blob an older build left in a scene
{ const pol = rd('ui/dm-polish.js'), ct = (pol.match(/P\.contact = function[\s\S]*?\n  \};/) || [''])[0];
  ok(!/function makeBlob/.test(pol) && !/DMContactShadow/.test(pol) && !/PlaneGeometry|CanvasTexture|createRadialGradient/.test(pol), 'dm-polish.js: no contact blob mesh / texture is built any more');
  ok(ct && /m\.parent\.remove\(m\)/.test(ct) && /dispose\(\)/.test(ct) && !/scene\.add/.test(ct), 'dm-polish.js: P.contact only removes + frees a leftover blob (never adds one)'); }
// (t1536) the mansion / facility deck rings (blue + violet neon pad rings, island paving ring) and the translucent core disc in the board's energy rings are gone
ok(!/RingGeometry|CircleGeometry|TorusGeometry/.test(rd('ui/dm-facilities.js')), 'dm-facilities.js: no neon pad rings / paving ring (she lands on those pads)');
{ const ab = (html.match(/function _buildArielBoard[\s\S]*?\n\}/) || [''])[0]; ok(ab && !/CircleGeometry/.test(ab) && !/coreMat/.test(ab), "_buildArielBoard: no translucent core disc inside the energy rings"); }
// DMLight / DMVLight / DMFlash: nothing disc-like is drawn at the player (lights are lights; DMFlash only owns the LED bar on her glasses, the spot, the beam cone)
ok(!/RingGeometry|CircleGeometry|TorusGeometry/.test(rd('ui/dm-flash.js') + rd('ui/dm-light.js') + rd('ui/dm-vlight.js') + rd('ui/dm-lamps.js')), 'dm-flash / dm-light / dm-vlight / dm-lamps: no ring / disc geometry');
console.log('== kept');
ok(/\{k:'park',t:/.test(rd('ui/dm-globe.js')) && /\{k:'call',t:'CALL'/.test(rd('ui/dm-globe.js')) && /parkSkyboard\(\)/.test(rd('ui/dm-globe.js')) && /summonSkyboard\(\)/.test(rd('ui/dm-globe.js')), '(t1536) PARK / CALL bubbles on the map globe (every world, on foot)');
ok(/const BOARD_CALL=\{rejoin:0,parked:false,parkPos:null/.test(html), 'BOARD_CALL (parked / rejoin) kept');
ok(/function parkSkyboard\(/.test(html) && /function summonSkyboard\(/.test(html), 'park + summon gameplay functions kept');
ok(/class="kb-btn kb-park"/.test(html) && /kb-call/.test(html) && /_kbTap\(w\.querySelector\('\.kb-park'\),parkSkyboard\)/.test(html), 'kite park / call buttons kept and wired');
ok(/toast\('🛹 Skyboard follows you again',1600\)/.test(html), '"Skyboard follows you again" toast kept');
ok(/\.kite-board\.kb-float:not\(\.kb-ship\)\{z-index:3510;\}/.test(rd('ui/dm-hud.css')), 'floating kite z-index 3510 kept');
ok(ex('ui/dm-cgroup.js') && ex('ui/dm-localcollide.js') && /<script src="ui\/dm-cgroup\.js\?v=\d+" defer><\/script>/.test(html) && /<script src="ui\/dm-localcollide\.js\?v=\d+" defer><\/script>/.test(html), 'character-group collision tessellation (dm-cgroup + dm-localcollide) kept and loaded');
ok(/DMCGroup\.groundAt/.test(html) && /function _lcPatch\(/.test(html), 'cgroup ground + local collide patches still used');
ok(ex('ui/dm-holo.js') && /dm-holo\.js/.test(html), 'unrelated holos kept');
console.log(fails ? 'groundmark-gone: FAILED ' + fails + '/' + n : 'groundmark-gone: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
