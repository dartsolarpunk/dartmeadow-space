// node tools/tests/cliff-contract.js — t1516: the terrain <-> JOTS Cliffs placement contract the world engine assumes around Ariel's mansion (Solenne), as published
// by JOTS Cliffs (#260) through DMFac.footprint() / F.seaCut / F.seaField.  Runs the REAL ui/dm-facilities.js; if Cliffs changes the contract this fails, so the
// terrain side is revisited together.  See docs/terrain-lod.md "Cliff placement contract".
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const facSrc = fs.readFileSync(path.join(root, 'ui', 'dm-facilities.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const doc = fs.readFileSync(path.join(root, 'docs', 'terrain-lod.md'), 'utf8');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);
// ── source: anchor + height rule (place())
ok(/const th = Math\.atan2\(-d\[0\], -d\[1\]\), px = b\.x, pz = b\.z/.test(facSrc), 'anchor: (px, pz) = the site, heading th = atan2(-dx, -dz) (local +Z inland)');
ok(/for \(const \[lx, lz\] of \[\[0, 40\], \[-30, 40\], \[30, 40\], \[0, 80\], \[-60, 0\], \[60, 0\]\]\)/.test(facSrc) && /y0 \+= 0\.3;/.test(facSrc), 'height: y0 = max ground at the centre + 6 inland/side probes, + 0.3');
// ── the three fields agree (index.html): drawn = carve(seaCut(natural)), walking = wrapH (seaCut + solids), water = seaField(natural)
ok(/\.carveField\(F\)/.test(html), 'drawn ground goes through the carve-wrapped F.H');
ok(/TERRAIN\.Hw=\(\(\)=>\{ const h0=F\.H0\|\|H; try\{ const f=_fac\(\); return f&&f\.seaField\?f\.seaField\(h0\):h0; \}catch\(e\)\{ return h0; \} \}\)\(\);/.test(html), 'water / shore field = F.seaField(natural ground)');
ok(/return f\?f\.wrapH\(F\.H0\|\|H\):H;/.test(html), 'walking ground = F.wrapH(natural ground)');
// ── runtime: the real module, a placed mansion, footprint()
const sb = { console, Math, Float32Array, Float64Array, Uint8Array, Int16Array, Set, Map, Promise, JSON, Date, setTimeout, clearTimeout, performance: { now: () => Date.now() },
  atob: s => Buffer.from(s, 'base64').toString('binary'), navigator: { userAgent: 'node', platform: 'Linux', maxTouchPoints: 0 }, document: { hidden: false },
  requestAnimationFrame: f => setTimeout(f, 1), CustomEvent: function () { }, addEventListener() { }, dispatchEvent() { }, location: { search: '', href: 'http://localhost/' } };
sb.window = sb; sb.globalThis = sb;
vm.runInNewContext(facSrc, sb, { filename: 'dm-facilities.js' });
const F = sb.DMFac;
ok(F && typeof F.footprint === 'function' && typeof F.seaCut === 'function' && typeof F.seaField === 'function' && typeof F.carveField === 'function', 'DMFac exposes footprint / seaCut / seaField / carveField');
ok(F.footprint() === null, 'footprint is null until the mansion is placed');
for (const th of [0, 0.7, 2.4, -1.9]) {
  const px = -80, pz = -1340, y0 = 68.306; F.car = { px, pz, ct: Math.cos(th), st: Math.sin(th), y0 };
  const fp = F.footprint();
  ok(fp && fp.y0 === y0 && fp.seaRel === -62 && fp.feather === 14 && fp.apronLen === 170, 'footprint: y0, seaRel -62, feather 14, apronLen 170 (th ' + th + ')');
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  ok(fp.box.length === 4 && near(d(fp.box[0], fp.box[1]), 392, 1e-6) && near(d(fp.box[1], fp.box[2]), 242, 1e-6), 'box 392 x 242 m (x +-196 along the wall, y +-121 seaward)');
  const cx = (fp.box[0][0] + fp.box[2][0]) / 2, cz = (fp.box[0][1] + fp.box[2][1]) / 2; ok(near(cx, px, 1e-6) && near(cz, pz, 1e-6), 'box centred on the anchor');
  ok(fp.apron.length === 4 && near(d(fp.apron[0], fp.apron[1]), 392 + 2 * fp.apronLat, 1e-6) && near(d(fp.apron[1], fp.apron[2]), 170, 1e-6), 'apron: in front of the face, 170 m deep, the box width + ' + fp.apronLat + ' m each side');
  ok(near(Math.hypot(fp.seaward[0], fp.seaward[1]), 1, 1e-9), 'seaward is a unit direction');
  ok(Array.isArray(fp.baseRing) && fp.baseRing.length === 15 && fp.baseRing.every(r => isFinite(r.y) && r.xz.length === 2), 'baseRing: 15 base heights along the seaward edge (every 28 m)');
  // the walking / water / drawn fields all apply the same seaCut
  const H0 = (x, z) => 90 + 0 * x * z, Fd = { H: H0 }; F.carveField(Fd); const Hw = F.seaField(H0), Hwalk = F.wrapH(H0);
  const ap = [(fp.apron[0][0] + fp.apron[1][0]) / 2 + fp.seaward[0] * 30, (fp.apron[0][1] + fp.apron[1][1]) / 2 + fp.seaward[1] * 30];
  ok(Hw(ap[0], ap[1]) < 90 && near(Hw(ap[0], ap[1]), Hwalk(ap[0], ap[1]), 1e-9) && near(Fd.H(ap[0], ap[1]), Hw(ap[0], ap[1]), 1e-9), 'in the apron water = walking = drawn (all sea-cut below the natural ground)');
  const far = [px + fp.seaward[0] * 900, pz + fp.seaward[1] * 900]; ok(Hw(far[0], far[1]) === 90 && Fd.H(far[0], far[1]) === 90, 'outside box + apron the natural ground is untouched');
}
F.car = null; F.solids.length = 0;
// ── our t1516 code never samples _terrainCore directly (drawn ground: carve-wrapped F.H, water: TERRAIN.Hw, walking: TERRAIN.H)
const ours = ['function _wmCarry(prev,mat){', 'function _wmLodBind(mesh,mat){', 'const _SKY_HAZE_RIM=', 'SkyGround.prototype._hazeInit=', 'SkyGround.prototype._hazeTick=', "if(TERRAIN.style==='mesa'){ const mw="];
for (const a of ours) { const i = html.indexOf(a); ok(i >= 0, 'found ' + a); const body = html.slice(i, html.indexOf('\n', i + a.length + 200)); ok(!/_terrainCore|TERRAIN\.H[wg]?\(|\.H0\(/.test(body), a + ' samples no terrain height'); }
ok(/## Cliff placement contract \(t1516\)/.test(doc) && /footprint\(\)/.test(doc), 'contract documented');
console.log(fails ? 'cliff-contract: ' + fails + ' FAILED of ' + n : 'cliff-contract: all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
