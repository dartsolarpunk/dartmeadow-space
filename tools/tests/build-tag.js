// node tools/tests/build-tag.js — cache-delivery guard (v353).
//  1. index.html declares window.DM_BUILD before the first ui script, and it is not behind the service worker's CACHE_NAME (bump both per release)
//  2. every local <script src> / <link href> in index.html carries a numeric ?v= tag, and every file it names exists
//  3. sw.js: the immutable ?v= path fetches same-origin misses with cache:'no-cache' (no stale Safari HTTP-cache copy under an old tag); navigations stay network-first
//  4. the visible build tag + refresh action exist and the refresh is the player-tapped, allow-listed reload (no new reload path)
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
const bm = html.match(/window\.DM_BUILD='v(\d+)'/), sm = sw.match(/CACHE_NAME = 'dartmeadow-engine-v(\d+)'/);
ok(bm && sm, 'DM_BUILD and CACHE_NAME found');
ok(+bm[1] >= +sm[1], 'DM_BUILD v' + bm[1] + ' is behind sw CACHE_NAME v' + sm[1] + ' (bump DM_BUILD with the cache name)');
ok(html.indexOf("window.DM_BUILD=") < html.indexOf('src="ui/dm-time.js'), 'DM_BUILD is set before the first ui script');
const tags = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="((?:ui|jots|static)\/[^"#]+)"/g)].map((m) => m[1]).filter((u) => /\.(js|css)(\?|$)/.test(u));
ok(tags.length > 40, 'scan found the local script/link tags (' + tags.length + ')');
const bad = tags.filter((u) => !/\?v=\d+$/.test(u)); ok(!bad.length, 'local files without a numeric ?v= tag: ' + bad.join(', '));
const missing = tags.filter((u) => !fs.existsSync(path.join(root, u.split('?')[0]))); ok(!missing.length, 'tags naming missing files: ' + missing.join(', '));
ok(/new Request\(req, \{ cache: 'no-cache' \}\)/.test(sw) && /new URL\(url\)\.origin === self\.location\.origin/.test(sw), "sw: same-origin immutable miss uses cache:'no-cache'");
ok(/req\.mode === 'navigate'[\s\S]{0,200}no-cache/.test(sw), 'sw: the page itself is network-first with no-cache');
ok(/skipWaiting\(\)/.test(sw) && /clients\.claim\(\)/.test(sw) && /caches\.delete\(k\)/.test(sw), 'sw: skipWaiting + claim + old caches deleted');
ok(/id="menu-build"[^>]*onclick="dmBuildInfo\(\)"/.test(html), 'menu footer build tag taps through to dmBuildInfo');
ok(/function dmBuildInfo\(\)[\s\S]{0,600}adminClearCacheReload\(\)/.test(html), 'dmBuildInfo only refreshes through the confirmed adminClearCacheReload');
ok(/id="pf-q-reset"/.test(html) && /function dmQualityReset/.test(html), 'profile > admin has RESET QUALITY');
console.log('build-tag OK (' + n + ' checks, DM_BUILD v' + bm[1] + ', sw v' + sm[1] + ', ' + tags.length + ' tagged files)');
