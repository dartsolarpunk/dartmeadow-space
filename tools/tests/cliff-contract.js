// node tools/tests/cliff-contract.js — t1516: the terrain <-> JOTS Cliffs placement contract the world engine assumes around Ariel's mansion (Solenne).
// If Cliffs (or the mansion lane) changes any of these, this fails, so the terrain side is revisited together.  See docs/terrain-lod.md "Cliff placement contract".
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const fac = fs.readFileSync(path.join(root, 'ui', 'dm-facilities.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const doc = fs.readFileSync(path.join(root, 'docs', 'terrain-lod.md'), 'utf8');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
ok(/const BOX = \{ x0: -196, x1: 196, y0: -121, y1: 121, feather: 14, deep: 128 \};/.test(fac), 'footprint: box x +-196 (along the wall), y +-121 (seaward = -local z), 14 m feather, ground lowered 128 m under y0');
ok(/const th = Math\.atan2\(-d\[0\], -d\[1\]\), px = b\.x, pz = b\.z/.test(fac), 'anchor: (px, pz) = the site, heading th = atan2(-dx, -dz) (local +Z inland)');
ok(/for \(const \[lx, lz\] of \[\[0, 40\], \[-30, 40\], \[30, 40\], \[0, 80\], \[-60, 0\], \[60, 0\]\]\)/.test(fac) && /y0 \+= 0\.3;/.test(fac), 'height: y0 = max natural ground at the centre + 6 inland/side probes, + 0.3');
ok(/const R = 230;/.test(fac), 'mansion collision grid reach 230 m');
ok(/\.carveField\(F\)/.test(html) && /TERRAIN\.Hw=(F\.H0\|\|H|\(\(\)=>\{ const h0=F\.H0\|\|H;)/.test(html), 'drawn ground = carved field; walking = natural field + solids; sea = natural field (JOTS Cliffs #260 may wrap it in F.seaField)');
ok(/## Cliff placement contract \(t1516\)/.test(doc), 'contract documented');
console.log(fails ? 'cliff-contract: ' + fails + ' FAILED of ' + n : 'cliff-contract: all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
