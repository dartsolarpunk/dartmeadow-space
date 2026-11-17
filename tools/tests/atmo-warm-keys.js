// node tools/tests/atmo-warm-keys.js - (v341) the warm-up must build its pipelines under EXACTLY the keys the frame pass looks up, or the
// frame compiles them again mid-flight (the multi-second freeze the warm-up exists to prevent).
//   sp| (space true-atmosphere pass): _taWarm and _trueAtmoRender each compute the key: same expression, incl. the #265 star-count suffix (nSt>1?'|'+nSt:'')
//   sf| (surface pass): built in ONE place only (_trueAtmoSurface0, key ...|PW.gen|nSt), so any warm render of it goes through the frame's own key
//   GalSky single compile (#264 / v338): the galaxy step compiles the GalSky subtree against flightScene + flightCamera, the scene / camera render() uses
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const IDX = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const cut = (s, a, b) => { const i = s.indexOf(a); if (i < 0) throw new Error('missing ' + a); const j = s.indexOf(b, i + a.length); if (j < 0) throw new Error('missing ' + b); return s.slice(i, j); };

const frame = cut(IDX, 'function _trueAtmoRender(r,scene,cam){', 'async function _taWarm(');
const warm = cut(IDX, 'async function _taWarm(r,scene,cam){', 'function _trueAtmoSurface(');
const nStRe = /const nSt=(_taStarN\(\)|Math\.max\(1,Math\.min\(3,\(window\.DMStars&&DMStars\.count\)\|0\)\));/;   // #267: Low/weak devices march only the key star via _taStarN()
const spKey = (src) => { const m = src.match(/key='sp\|'\+(best\.mesh\.uuid[^;\n]*?)(?=;|\n|$)/); return m && m[1].replace(/\s+$/, ''); };
const fN = (frame.match(nStRe) || [])[1], wN = (warm.match(nStRe) || [])[1], fK = spKey(frame), wK = spKey(warm);
ok(!!fN && fN === wN, 'sp: _taWarm counts the stars exactly like the frame (' + wN + ')');
ok(!!fK && fK === wK, 'sp: _taWarm key expression === _trueAtmoRender key expression');
ok(/\(nSt>1\?'\|'\+nSt:''\)$/.test(fK || '') && /\(nSt>1\?'\|'\+nSt:''\)$/.test(wK || ''), 'sp: both keep the #265 star-count suffix (nSt>1?\'|\'+nSt:\'\')');
// evaluate both expressions: single star / binary / triple / no DMStars -> identical strings, suffix only for > 1 star
const ev = (nExpr, kExpr, stars) => { const ctx = { window: stars == null ? {} : { DMStars: { count: stars } }, best: { mesh: { uuid: 'U1' } }, _taQ: () => 'high', E: { ready: true }, Math };
  ctx._taStarN = () => Math.max(1, Math.min(3, (ctx.window.DMStars && ctx.window.DMStars.count) | 0));   // the high-preset path of index.html's _taStarN (Low = 1 is covered by system-stars-unit)
  ctx.DMStars = ctx.window.DMStars; vm.createContext(ctx); return vm.runInContext('(()=>{ const nSt=' + nExpr + '; return \'sp|\'+' + kExpr + '; })()', ctx); };
for (const s of [null, 1, 2, 3, 5]) {
  const a = ev(fN, fK, s), b = ev(wN, wK, s);
  ok(a === b, 'sp key equal with ' + (s == null ? 'no DMStars' : s + ' star(s)') + ': ' + a);
  ok(s > 1 ? /\|[23]$/.test(a) : a === 'sp|U1|high|1', '  suffix ' + (s > 1 ? 'present' : 'absent') + ' (' + a + ')');
}
// sf: one constructor only, with |nSt, so a warm render uses the frame's own key
const sfMakers = IDX.match(/key='sf\|'[^;]*;/g) || [];
ok(sfMakers.length === 1 && /\+'\|'\+nSt;$/.test(sfMakers[0]), 'sf: the key is built in one place, ending |nSt (' + sfMakers.join(' ') + ')');
ok(sfMakers.length === 1 && cut(IDX, 'function _trueAtmoSurface0(', '_taPrune(\'sf|\'').includes(sfMakers[0]) && nStRe.test(cut(IDX, 'function _trueAtmoSurface0(', '_taPrune(\'sf|\'')), 'sf: that place is _trueAtmoSurface0, with the same star count');
ok(!/key='sf\|'/.test(warm), 'sf: _taWarm builds no surface pipeline of its own (no second key to drift)');
// GalSky single compile: same scene / camera as render(), so the pipeline cache keys are the frame's
const rest = cut(IDX, 'function _gsPrecompileRest(){', '\n}');
ok(/flightRenderer\.compileAsync\(galSkyRoot,flightCamera,flightScene\)/.test(rest), 'GalSky: the warm step compiles galSkyRoot with flightCamera + flightScene (render()\'s camera / scene)');
ok(/\['galaxy',\(\)=>galSky&&galSky\.ready&&_gsPrecompileRest\(\)\]/.test(IDX) && /onCompile:_gsMarkWarm/.test(IDX), 'GalSky: the world step marks what it compiled, the galaxy step compiles only the rest');
console.log(fails ? 'atmo-warm-keys: ' + fails + ' of ' + n + ' checks FAILED' : 'atmo-warm-keys: all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
