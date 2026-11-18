// node tools/tests/shield-button.js - the SHIELD sub-button of the left stick cluster (ui/dm-flash.js dock): a vector diamond icon stacked on the flashlight button, same dock / slot
// logic, toggles DM_HAZ.toggleShield().  Static contracts + the dock's free-slot maths with the taller cluster.  No browser, no GPU.
// three.js (only for loading dm-flash.js): THREE_CORE=/path/to/three.core.js, else ~/.cache/dm-harness, /workspace/three185, node_modules/three; SKIP (exit 0) if none.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'ui/dm-flash.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };

console.log('== the sub-button (static)');
ok(/const SH_ICON = '<svg viewBox="0 0 24 24"[^']*<path d="M12 2\.6l7\.6 9\.4-7\.6 9\.4-7\.6-9\.4z"/.test(src), 'icon: an inline SVG DIAMOND (4-point rhombus path), no image / font / network');
ok(/sb\.className = 'sh-btn'/.test(src) && /w\.appendChild\(b\); w\.appendChild\(sb\); w\.appendChild\(bar\)/.test(src), 'the button is a child of the SAME #dm-flash wrapper the flashlight button lives in (one dock, one slot logic)');
ok(/#dm-flash \.sh-btn\{[^}]*bottom:40px[^}]*width:34px;height:34px;border-radius:50%/.test(src), 'sits one slot (34 px + 6 px gap) above the flashlight button, same size / shape / look');
ok(/DM_HAZ\.toggleShield/.test(src) && /addEventListener\('dmshieldtoggle'/.test(src) && /aria-pressed/.test(src), 'toggles DM_HAZ.toggleShield(); follows dmshieldtoggle; aria-pressed');
ok(/\[b, bar, sb\]/.test(src) && /touchstart/.test(src.slice(src.indexOf('[b, bar, sb]'), src.indexOf('[b, bar, sb]') + 220)), 'taps on it never reach the game (same stopPropagation guards as the flashlight)');
ok(/#dm-flash\[data-m="space"\] \.sh-btn\{display:none;\}/.test(src), 'hidden in open space (the protection only matters in a world)');
ok(/const TH = S\.mode === 'space' \? SZ : SZ \* 2 \+ GAP/.test(src) && /free\(cand\[i\]\[0\], cand\[i\]\[1\], obs, W, H, TH\)/.test(src), 'the dock looks for a free slot for the whole two-button cluster');
ok(!/<img|url\(|fetch\(|XMLHttpRequest/.test(src.slice(src.indexOf('const SH_ICON'), src.indexOf('const CSS'))), 'the icon costs nothing: no assets');
ok(!/shield-btn|dm-shield-btn|id="shield/.test(html) && /ui\/dm-flash\.js\?v=\d+/.test(html), 'index.html: no separate shield button file; dm-flash.js is the loader of the cluster');

const cands = [process.env.THREE_CORE, path.join(os.homedir(), '.cache/dm-harness/node_modules/three/build/three.core.js'), '/workspace/three185/three.core.js', path.join(root, 'node_modules/three/build/three.core.js')].filter(Boolean);
const tp = cands.find(p => fs.existsSync(p));
(async () => {
  if (!tp) console.log('  (dock maths skipped: no three.core.js)');
  else {
    console.log('== dock free-slot maths with the taller cluster');
    const THREE = await import(tp); globalThis.window = globalThis; globalThis.location = { search: '' }; globalThis.THREE = THREE; require('../../ui/dm-flash.js');
    const F = globalThis.DMFlash, free = F._free, W = 800, H = 450;
    ok(typeof free === 'function', 'F._free exported');
    ok(free(100, 20, [], W, H) === true && free(100, 20, [], W, H, 74) === true, 'empty screen: the single button and the cluster both fit');
    const obs = [{ left: 90, right: 150, top: H - 20 - 34 - 20, bottom: H - 20 - 34 - 2 }];   // a control 2..20 px above the flashlight button's top edge
    ok(free(100, 20, obs, W, H) === true && free(100, 20, obs, W, H, 74) === false, 'a control just above the button: the button alone fits, the cluster (button + shield) does not - the dock moves on');
    ok(free(100, H - 60, [], W, H, 74) === false && free(100, H - 60, [], W, H) === true, 'near the top edge: the taller cluster is kept on screen');
    ok(free(100, 20, [], W, H, 10) === free(100, 20, [], W, H), 'a th smaller than the button is ignored (default size)');
  }
  console.log(fails ? 'shield-button: ' + fails + ' FAILED of ' + n : 'shield-button: ' + n + '/' + n + ' ok'); process.exit(fails ? 1 : 0);
})();
