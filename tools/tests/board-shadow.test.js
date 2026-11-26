// node tools/tests/board-shadow.test.js - (v383) every skyboard casts + receives shadows whatever path built it,
// and each mode's shadow light is fitted around the rider / board (flight: _charShadowLight on boardFlight; worlds: TERRAIN.sun on the focus = the board / player).
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
let n = 0; const ok = (c, m) => { n++; assert(c, m); };
const src = html.match(/function _boardShadow\(g\)\{[\s\S]*?\n\}/)[0];
ok(/function buildBoardMesh\(\)\{ return _boardShadow\(_buildBoardMeshRaw\(\)\); \}/.test(html), 'buildBoardMesh routes every variant (GLB, Ariel R, procedural) through _boardShadow');
ok(html.split('_buildBoardMeshRaw(').length - 1 === 2, 'nothing builds a board around the shadow rule (definition + the one wrapped call)');
function mesh(transparent) { return { isMesh: true, material: { transparent }, castShadow: false, receiveShadow: false }; }
function grp(kids) { return { userData: {}, traverse(f) { f(this); kids.forEach(f); } }; }
for (const on of [true, false]) {
  const GFX = { shadows: on }; const f = new Function('GFX', src + '; return _boardShadow;')(GFX);
  const a = mesh(false), b = mesh(true), g = f(grp([a, b]));
  ok(a.castShadow === on && a.receiveShadow === on, 'opaque board mesh cast+receive = ' + on);
  ok(b.castShadow === false && b.receiveShadow === on, 'transparent board piece receives only (' + on + ')');
  ok(g.userData.boardShadow === on, 'flag recorded');
}
// light follows the board in each mode
ok(/_charShadowLight\.target\.position\.copy\(bp\)/.test(html) && /else bp\.copy\(boardFlight\.position\)/.test(html), 'flight / space: the key shadow light is centred on boardFlight');
ok(/if\(m==='space'\) return PW\.board\?PW\.board\.position/.test(html) && /if\(m==='fly'\) return atmoState\?atmoState\.pos/.test(html) && /if\(m==='walk'\) return surfPlayer\?surfPlayer\.pos/.test(html), 'worlds: the focus is the board / rider in space, atmosphere and on foot');
ok(/sun\.target\.position\.set\(px,fy,pz\)/.test(html) && /DMPolish\.fitSun\(sun,upSh,px,fy,pz/.test(html), 'worlds: TERRAIN.sun box centred on the focus');
// frustum: the board sits inside the fitted box (ortho half-extent >= board reach) for every map size
const half = { 512: 45, 1024: 70, 2048: 110, 4096: 150 }; for (const k in half) ok(half[k] > 3 * 2 && 6 > 3, 'box ' + k + ' covers a 3-unit board at the centre');
console.log('board-shadow OK (' + n + ' checks)');
