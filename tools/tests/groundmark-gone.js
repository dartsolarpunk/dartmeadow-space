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
console.log('== kept');
ok(/const BOARD_CALL=\{rejoin:0,parked:false,parkPos:null/.test(html), 'BOARD_CALL (parked / rejoin) kept');
ok(/function parkSkyboard\(/.test(html) && /function summonSkyboard\(/.test(html), 'park + summon gameplay functions kept');
ok(/class="kb-btn kb-park"/.test(html) && /kb-call/.test(html) && /_kbTap\(w\.querySelector\('\.kb-park'\),parkSkyboard\)/.test(html), 'kite park / call buttons kept and wired');
ok(/toast\('🛹 Skyboard follows you again',1600\)/.test(html), '"Skyboard follows you again" toast kept');
ok(/\.kite-board\.kb-float:not\(\.kb-ship\)\{z-index:3510;\}/.test(rd('ui/dm-hud.css')), 'floating kite z-index 3510 kept');
ok(ex('ui/dm-cgroup.js') && ex('ui/dm-localcollide.js') && /<script src="ui\/dm-cgroup\.js\?v=\d+" defer><\/script>/.test(html) && /<script src="ui\/dm-localcollide\.js\?v=\d+" defer><\/script>/.test(html), 'character-group collision tessellation (dm-cgroup + dm-localcollide) kept and loaded');
ok(/DMCGroup\.groundAt/.test(html) && /function _lcPatch\(/.test(html), 'cgroup ground + local collide patches still used');
ok(ex('ui/dm-holo.js') && /dm-holo\.js/.test(html), 'unrelated holos kept');
console.log(fails ? 'groundmark-gone: FAILED ' + fails + '/' + n : 'groundmark-gone: all ' + n + ' checks passed'); process.exit(fails ? 1 : 0);
