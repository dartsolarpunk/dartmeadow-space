// node tools/tests/menu-widgets.test.js — bugfix-1119: the flashlight button hung over the pilot-select / studio / menu screens.
// Root cause: #dm-flash is a body-level widget (outside every .screen).  Its only menu rule was `body:has(#screen-menu.active)` / `#screen-builder.active`, so the
// new #screen-character was never covered, and F.tick() (the only thing that re-sets data-m) stops with the flight loop: after leaving a game the button kept the last game
// mode's data-m and stayed on top of the menu.  Fix: goScreen() stamps body[data-dm-screen]; CSS hides every in-game body-level widget unless it is "flight"; the flashlight
// also un-docks (DMFlash.hide).  Static checks on the real files + the real CSS selector semantics evaluated by a tiny matcher.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), flash = fs.readFileSync(path.join(root, 'ui', 'dm-flash.js'), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };

// screens that exist
const screens = [...html.matchAll(/<div id="screen-([a-z]+)" class="screen"/g)].map((m) => m[1]);
ok(['menu', 'character', 'builder', 'flight'].every((s) => screens.includes(s)) && screens.length === 4, 'the four screens: ' + screens.join(','));

// goScreen stamps the attribute and un-docks the flashlight for every non-flight screen
const gs = html.slice(html.indexOf('function goScreen('), html.indexOf('function goScreen(') + 9000);
ok(/STATE\.screen=name;\s*\n\s*try\{ document\.body\.setAttribute\('data-dm-screen',name\); if\(name!=='flight'&&window\.DMFlash&&DMFlash\.hide\) DMFlash\.hide\(\); \}catch\(e\)\{\}/.test(gs), 'goScreen stamps body[data-dm-screen] and calls DMFlash.hide() off the flight screen');

// the CSS
const rule = html.match(/body\[data-dm-screen\]:not\(\[data-dm-screen="flight"\]\) #dm-flash,[^{]*\{display:none !important;\}/);
ok(!!rule, 'index.html carries the generic hide rule');
const widgets = ['#dm-flash', '#dm-hazhud', '#dm-globe', '.kite-board.kb-float', '#land-pick'];
ok(rule && widgets.every((w) => rule[0].includes('[data-dm-screen="flight"]) ' + w)), 'it covers the body-level in-game widgets: ' + widgets.join(' '));
ok(/body\[data-dm-screen\]:not\(\[data-dm-screen="flight"\]\) #dm-flash\{display:none !important;\}/.test(flash), 'dm-flash.js carries its own copy of the rule (works without index.html css)');
ok(/body:has\(#screen-character\.active\) #dm-flash/.test(flash), 'and the :has rule for the character screen');
ok(/F\.hide = function \(\) \{ S\.mode = ''; S\.dirty = true; S\.wait = 0; S\.docked = false; if \(S\.ui && S\.ui\.w\) S\.ui\.w\.setAttribute\('data-m', ''\); \};/.test(flash), 'DMFlash.hide clears data-m and the docked flag');
ok(/else if \(!S\.docked && mode && !S\.dirty\)/.test(flash), 'F.tick re-docks on the first tick back in a game (not after the ~2 s re-check)');
// each widget id/class exists in the code base (a typo would silently hide nothing)
const code = [html, ...fs.readdirSync(path.join(root, 'ui')).filter((f) => /\.(js|css)$/.test(f)).map((f) => fs.readFileSync(path.join(root, 'ui', f), 'utf8'))].join('\n');
ok(/id = 'dm-hazhud'|id="dm-hazhud"/.test(code) && /id = 'dm-flash'|id="dm-flash"/.test(code) && /#dm-globe/.test(code) && /kite-board kb-float/.test(code) && /id='land-pick'/.test(code), 'every id / class in the rule is a real widget');

// selector semantics: a minimal evaluator of  body[data-dm-screen]:not([data-dm-screen="flight"]) <anything>
const hidden = (attr) => attr !== undefined && attr !== 'flight';
ok(hidden('menu') && hidden('character') && hidden('builder'), 'menu / character / builder hide the widgets');
ok(!hidden('flight'), 'flight shows them');
ok(!hidden(undefined), 'before the first goScreen (attribute absent) the rule is inert (boot is unchanged)');

// the real dock() already refused to place the button outside a game screen: the new rule is what keeps it hidden when data-m is stale
ok(/not in a game screen \(menu \/ builder \/ between worlds\)/.test(flash), 'dock() still un-docks when #screen-flight is not active');
console.log(fails ? 'menu-widgets: ' + fails + ' FAILED of ' + n : 'menu-widgets: all ' + n + ' passed'); process.exit(fails ? 1 : 0);
