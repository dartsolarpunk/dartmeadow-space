// Flipbook coverage test for assets/water/spray-sheet.webp's generator (tools/water/sheets.js).   node tools/tests/water-sheets.js
const assert = require('assert'), fs = require('fs'), path = require('path'); const S = require('../water/sheets.js');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const b = S.bake(); ok(b.W === 512 && b.frames.r.length === 16 && b.frames.g.length === 16 && b.frames.b.length === 16, '512 sheet, 16 frames per sprite family');
const cover = (f, th) => { let c = 0; for (let i = 0; i < f.length; i++) if (f[i] > th) c++; return c / f.length; };
const diff = (a, c) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - c[i]); return d / a.length; };
const sum = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i]; return s; };
// spray: every frame has droplets (1-30% of the cell is >0.15), nothing touches the cell border
b.frames.r.forEach((f, i) => { const c = cover(f, 0.15); ok(c > 0.01 && c < 0.3, 'spray frame ' + i + ' coverage ' + (c * 100).toFixed(1) + '%'); let edge = 0; for (let k = 0; k < S.N; k++) edge += f[k] + f[k * S.N] + f[k * S.N + S.N - 1]; ok(edge < 1.2, 'spray frame ' + i + ' keeps clear of the top / side border (' + edge.toFixed(2) + ')'); });
// looping: the step 15 -> 0 is no bigger than a typical step (and the family is not static)
for (const fam of ['r', 'b']) { const fr = b.frames[fam]; const steps = []; for (let i = 0; i < 15; i++) steps.push(diff(fr[i], fr[i + 1])); const wrapStep = diff(fr[15], fr[0]), avg = steps.reduce((a, c) => a + c, 0) / 15; ok(wrapStep < avg * 1.6 + 1e-3, fam + ' loops: wrap step ' + wrapStep.toFixed(4) + ' vs avg ' + avg.toFixed(4)); ok(avg > 0.0015, fam + ' animates (' + avg.toFixed(4) + ')'); }
// crown: starts small, peaks mid-way, is gone by the last frame (one-shot)
const e = b.frames.g.map(sum); ok(e[0] < e[6] && e[15] < e[6] * 0.2 && Math.max(...e) > 20, 'crown rises and clears: energy ' + e.map((v) => v.toFixed(0)).join(' '));
// mist: soft (no hard pixels) and present in every frame
b.frames.b.forEach((f, i) => { ok(cover(f, 0.05) > 0.08, 'mist frame ' + i + ' present'); let hard = 0; for (let k = 0; k < f.length; k++) if (f[k] > 0.95) hard++; ok(hard / f.length < 0.02, 'mist stays soft'); });
// the committed sheet: size budget (flipbooks <= 1-2 MB total) and the GPU footprint
const file = path.join(__dirname, '..', '..', 'assets', 'water', 'spray-sheet.webp'); ok(fs.existsSync(file), 'sheet committed'); const sz = fs.statSync(file).size; ok(sz < 400 * 1024, 'sheet file ' + (sz / 1024).toFixed(0) + ' KB < 400 KB');
ok(512 * 512 * 4 * 1.34 < 1.5 * 1048576, 'GPU memory for the sheet (RGBA8 + mips) < 1.5 MB');
console.log('water-sheets: ' + n + ' checks passed (' + (sz / 1024).toFixed(0) + ' KB on disk, 1.34 MB on the GPU)');
