// node tools/tests/hazard-bubble-look.js — t1590: the toxic-air breathing orb (ui/dm-hazardbubble.js) is a thin screen-blended glow:
// clear in the middle of a first-person view, glow toward the edges; thin fresnel shell from outside; additive (screen) blend, no depth write;
// sparkles off on Low; nothing allocated per frame.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'dm-hazardbubble.js'), 'utf8');
let bad = 0, n = 0; const ok = (c, m) => { n++; if (!c) { bad++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const win = { addEventListener() {} }; const ctx = { window: win, console, Math }; vm.createContext(ctx); vm.runInContext(src, ctx);
const H = win.DM_HAZ, C = H.core, K = C.K;

console.log('== first person (camera inside the orb)');
const inC = C.look(0.0, 0.6, 1, 1, 0.0, 0.5, 0), inMid = C.look(0.0, 0.6, 1, 1, 0.5, 0.5, 0), inEdge = C.look(0.0, 0.6, 1, 1, 1.2, 0.5, 0);
ok(inC < 0.02, 'centre of the view nearly clear even at full swirl + wave + sparkle (I = ' + inC.toFixed(3) + ')');
ok(inEdge > 0.25 && inEdge > inC * 15, 'edge of vision carries the glow (I = ' + inEdge.toFixed(3) + ')');
ok(inMid > inC && inMid < inEdge, 'monotonic falloff centre -> edge (' + inC.toFixed(3) + ' / ' + inMid.toFixed(3) + ' / ' + inEdge.toFixed(3) + ')');
console.log('== third person (outside)');
const outC = C.look(0.0, 0.3, 0, 0, 0, 3, 0), outRim = C.look(1.0, 0.3, 0, 0, 0, 3, 0);
ok(outC < 0.06, 'thin: low centre intensity from outside (' + outC.toFixed(3) + ')');
ok(outRim > 0.45 && outRim <= K.max, 'clear fresnel rim (' + outRim.toFixed(3) + ', ceiling ' + K.max + ')');
ok(C.look(1, 1, 1, 1, 0, 3, 0) <= K.max + 1e-9, 'never past the ceiling');
console.log('== first person on foot: the orb stays, her body stays hidden');
{ const P = C.present, hid = { visible: false }, vis = { visible: true };
  ctx._surfFpHidden = true; vm.runInContext('var _surfFpHidden = true;', ctx);
  ok(P(hid, 'walk', true) === true, 'toxic air, on foot, first person (body hidden by _surfFpBody): the orb stays');
  ok(P(hid, 'walk', false) === false, 'airless / breathable: unchanged (fades with the hidden body)');
  ok(P(hid, 'fly', true) === false, 'board flight: unchanged');
  ok(P(vis, 'walk', false) === true && P(vis, 'fly', true) === true, 'visible body: always present (as before)');
  vm.runInContext('_surfFpHidden = false;', ctx);
  ok(P(hid, 'walk', true) === false, 'body hidden for any other reason (not first person): unchanged');
  ok(!/root\.visible\s*=(?!=)/.test(src) && !/_surfFpHidden\s*=(?!=)/.test(src), 'the orb never shows her body or touches the first-person hide (body stays hidden)');
  ok(/g=groupSphere\(mode,cam,kind==='toxic'\)/.test(src), 'tick passes "toxic" to the presence test');
}
console.log('== blend: screen (soft additive), never an opaque fill');
ok(C.screen(0.5, 0) === 0.5 && C.screen(1, 0.6) === 1 && Math.abs(C.screen(0.2, K.max) - (0.2 + K.max * 0.8)) < 1e-12, 'screen: dst + src (1 - dst), saturates at 1');
ok(/m\.blending=THREE\.CustomBlending/.test(src) && /m\.blendSrc=THREE\.OneFactor/.test(src) && /m\.blendDst=THREE\.OneMinusSrcColorFactor/.test(src), 'orb blend One / OneMinusSrcColor (screen)');
ok(/m\.premultipliedAlpha=true/.test(src) && /m\.colorNode=col; m\.opacityNode=I/.test(src), 'premultiplied (col x I) output');
ok(/function orbMat\(side\)\{\s*const m=new THREE\.MeshBasicNodeMaterial\(\{transparent:true,depthTest:true,depthWrite:false,side\}\)/.test(src), 'depthWrite off, depth-tested (no full-screen pass)');
ok(/T\.screenUV/.test(src) && /mix\(float\(1\),vig,ins\)/.test(src), 'shader: screen-radius vignette weighted by "inside"');
console.log('== Low cost');
ok(/NS=low\?2:4/.test(src), 'mist march 2 samples on Low (was 3), 4 above (was 5)');
ok(/if\(!low\)\{\s*\/\/ sparkles/.test(src), 'sparkles compiled out on Low');
console.log('== tick: no allocation, same appearance logic');
const tick = src.slice(src.indexOf('H.tick=function'), src.indexOf('H.setOff='));
ok(!/new [A-Z]\w*\(|\[\s*\]|\{\s*\w+\s*:/.test(tick.replace(/S\.fogObj=new THREE\.Fog\([^)]*\)/, '')), 'tick allocates nothing (beyond the one-time fog object it already had)');
ok(/u\.asp\.value=\(window\.innerWidth\|\|1\)/.test(tick), 'aspect is a uniform write');
ok(/if\(kind==='toxic'\) tgt=1; else if\(kind==='airless'\) tgt=0\.42;/.test(tick), 'when the orb appears is unchanged (toxic 1, airless 0.42)');
console.log(bad ? 'hazard-bubble-look: ' + bad + ' FAILED of ' + n : 'hazard-bubble-look: ' + n + '/' + n + ' ok'); process.exit(bad ? 1 : 0);
