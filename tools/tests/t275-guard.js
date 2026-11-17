// node tools/tests/t275-guard.js — Perf's frame-rate guard on #275 (t1590u), behaviour tests, not source matches:
//  F1  a remembered render scale below the tablet floor never applies on a tablet (boot / prime), phones and desktops keep theirs; a slide-show never goes below 0.75 either
//  F2  Mali-class tablets end the near-detail fade at 1.25 x reach (was 1.5 x), everyone else 1.5 x
//  F3  a tablet AT the floor with the budget ladder exhausted sheds the terrain detail reach (U.reachK) instead of holding a slide-show, and gets it back; phones never shed here
//  +   index.html's crack/bump detail fade honours U.reachK (a reach shrink moves it too)
//  F4  the Safari slow slice runs every 100-150 ms
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..'), rd = p => fs.readFileSync(path.join(root, p), 'utf8');
const html = rd('index.html');
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } else if (process.env.VERBOSE) console.log('  ok', m); };
const cut = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('marker ' + a); const j = html.indexOf(b, i + a.length); if (j < 0) throw new Error('end ' + b); return html.slice(i, j); };

// ── F1: the real ui/dm-governor.js in a vm
function gov(dev, savedK) {
  const win = { performance: { _t: 1000, now() { return this._t; } }, document: { hidden: false }, devicePixelRatio: dev.dpr, innerWidth: dev.w, innerHeight: dev.h, screen: { width: dev.w, height: dev.h },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = v; } }, _dmWarming: false };
  const ctx = vm.createContext({ window: win, performance: win.performance, Date, Math, JSON, Float32Array, document: win.document });
  ctx.window.window = win;
  const gfx = { isMobile: dev.mobile, preset: 'medium', dynamicRes: undefined };
  const key = 'medium|' + (dev.mobile ? 'm' : 'd') + '|' + Math.round(dev.dpr * 10) + '|' + Math.round(dev.w / 100);
  if (savedK != null) win.localStorage._m.dm_gov_v1 = JSON.stringify({ key, k: savedK, t: Date.now() });
  vm.runInContext(rd('ui/dm-governor.js'), ctx);
  const basePR = Math.min(dev.dpr, 2), r = { pr: basePR, setPixelRatio(p) { this.pr = p; }, _dr: null };
  return { win, gfx, r, basePR, G: win.DMGov };
}
const TABLET = { mobile: true, dpr: 1.5, w: 1280, h: 800 }, PHONE = { mobile: true, dpr: 3, w: 390, h: 844 }, DESK = { mobile: false, dpr: 1, w: 1920, h: 1080 };
{ const g = gov(TABLET, 0.42); const k = g.G.prime(g.r, g.gfx, g.basePR);
  ok(k >= 0.75 && g.r.pr / g.basePR >= 0.75 - 1e-9, 'F1 tablet, saved 0.42: boot scale ' + (g.r.pr / g.basePR).toFixed(2) + ' (>= 0.75, never the saved 0.42)'); }
{ const g = gov(TABLET, 0.42); let min = 1;   // boot through frame() too, then a slide-show (250 ms frames) for 3 minutes
  for (let i = 0; i < 720; i++) { g.win.performance._t += 250; g.G.frame(g.r, g.gfx, g.basePR); min = Math.min(min, g.r.pr / g.basePR); }
  ok(min >= 0.75 - 1e-9, 'F1 tablet, saved 0.42 + 4 fps slide-show: lowest scale ' + min.toFixed(2) + ' (>= 0.75 at every frame, boot included)'); }
{ const g = gov(TABLET, 0.9); g.G.prime(g.r, g.gfx, g.basePR); ok(Math.abs(g.r.pr / g.basePR - 0.9) < 1e-9, 'F1 tablet, saved 0.9 above the floor: applied as saved'); }
{ const g = gov(PHONE, 0.42); g.G.prime(g.r, g.gfx, g.basePR); ok(Math.abs(g.r.pr / g.basePR - 0.42) < 1e-9, 'F1 phone, saved 0.42: unchanged (applied)'); }
{ const g = gov(DESK, 0.42); g.G.prime(g.r, g.gfx, g.basePR); ok(Math.abs(g.r.pr / g.basePR - 0.42) < 1e-9, 'F1 desktop, saved 0.42: unchanged (applied)'); }
{ const g = gov(TABLET, null); g.G.prime(g.r, g.gfx, g.basePR); ok(g.r.pr === g.basePR, 'F1 tablet, nothing saved: full scale'); }

// ── F2 + crack/bump fade: the real helpers cut from index.html
const RC = require(path.join(root, 'ui', 'dm-radical-circ.js'));
const E = new Function('window', cut('const _SKY_HAZE_RIM=', 'SkyGround.prototype._hazeInit=') + '\nreturn {_skyDetailFall,_SKY_DET_END_LOWG};')({ DMRadCirc: RC });
for (const reach of [22, 30]) {
  const a = E._skyDetailFall(reach, [0, 0], 0), m = E._skyDetailFall(reach, [0, 0], E._SKY_DET_END_LOWG);
  ok(a[1] === reach * 1.5 && m[1] === reach * 1.25 && m[0] < m[1] && m[1] - m[0] >= reach * 0.75, 'F2 reach ' + reach + ': fade end ' + a[1] + ' u (default) / ' + m[1] + ' u (Mali-class), still soft [' + m[0].toFixed(1) + '..' + m[1] + ']');
}
ok(/const _df=_skyDetailFall\(reach,\[0,0\],_lowG\?_SKY_DET_END_LOWG:0\);/.test(html), 'F2 _terrainDetailMat passes the Mali end only on _lowG');
// the crack/bump fade lines, run on a numeric stand-in for the TSL nodes
{ const body = cut('    const _rk=(window.DMGround&&DMGround.reachU)', '    // the detail height at a ground point');
  const N = v => ({ v, mul: o => N(() => v() * (typeof o === 'number' ? o : o.v())), sub: o => N(() => v() - (typeof o === 'number' ? o : o.v())) });
  const W = { float: x => (typeof x === 'number' ? N(() => x) : x), smoothstep: (a, b, x) => N(() => { const t = Math.max(0, Math.min(1, (x.v() - a.v()) / (b.v() - a.v()))); return t * t * (3 - 2 * t); }) };
  let K = 1, D = 0; const rkNode = N(() => K), dist = N(() => D), flat = N(() => 1), _df = [16.9, 45];
  const fade = new Function('W', 'window', 'DMGround', 'dist', 'flat', '_df', body + '\nreturn fade;')(W, { DMGround: { reachU: () => rkNode } }, { reachU: () => rkNode }, dist, flat, _df);
  const at = (k, d) => { K = k; D = d; return fade.v(); };
  let same = true; for (let d = 0; d <= 50; d += 0.5) if (Math.abs(at(0.5, d) - at(1, d * 2)) > 1e-12) same = false;
  ok(same && at(1, 30) > 0 && at(0.5, 30) === 0, 'crack/bump fade honours U.reachK: at reachK 0.5 it is the reachK 1 fade at half the distance (30 u: ' + at(1, 30).toFixed(2) + ' -> ' + at(0.5, 30) + ')');
  const fade0 = new Function('W', 'window', 'DMGround', 'dist', 'flat', '_df', body + '\nreturn fade;')(W, {}, undefined, dist, flat, _df);
  D = 30; ok(Math.abs(fade0.v() - at(1, 30)) < 1e-12, 'without the ground library the fade is the plain rim fade'); }

// ── F3: the real ui/dm-groundlib.js in a vm, tablet shed on the 600 ms poll
function glib(dev, exhausted, k) {
  const win = { setInterval() { return 1; }, setTimeout() { return 1; }, clearTimeout() {}, Math, screen: { width: dev.w, height: dev.h } };
  win.THREE = { TSL: { uniform: v => ({ value: v }) }, Color: function () { this.r = this.g = this.b = 0; this.copy = () => this; this.multiplyScalar = () => this; this.lerp = () => this; } };
  win.DMBudget = { on: true, groundReach: () => 1, groundDual: () => 1, isExhausted: () => exhausted.v };
  win.flightRenderer = { _dr: { k } }; win.GFX = { isMobile: dev.mobile };
  win._dmTabletFloor = gx => (gx && gx.isMobile && Math.min(dev.w, dev.h) >= 600) ? 0.75 : 0;
  const ctx = vm.createContext(win); ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInContext(rd('ui/dm-groundlib.js'), ctx);
  const D = ctx.DMGround, u = D.reachU(); return { D, u, win };
}
{ const ex = { v: true }, g = glib(TABLET, ex, 0.75); let lo = 1;
  ok(g.u && g.u.value === 1, 'F3 reachU() is the shared uniform (1 at rest)');
  for (let i = 0; i < 20; i++) { g.D._pollSky(); lo = Math.min(lo, g.u.value); }
  ok(Math.abs(lo - g.D.TAB_SHED.min) < 1e-9, 'F3 tablet at the 0.75 floor, ladder exhausted: reachK sheds to ' + lo.toFixed(2));
  ex.v = false; for (let i = 0; i < 20; i++) g.D._pollSky();
  ok(g.u.value === 1, 'F3 pressure gone: reachK back to 1'); }
{ const ex = { v: true }, g = glib(TABLET, ex, 0.9); for (let i = 0; i < 20; i++) g.D._pollSky(); ok(g.u.value === 1, 'F3 tablet above the floor (the governor still has resolution to give): no shed'); }
{ const ex = { v: true }, g = glib(PHONE, ex, 0.42); for (let i = 0; i < 20; i++) g.D._pollSky(); ok(g.u.value === 1, 'F3 phone: never sheds here'); }
{ const ex = { v: false }, g = glib(TABLET, ex, 0.75); for (let i = 0; i < 20; i++) g.D._pollSky(); ok(g.u.value === 1, 'F3 tablet at the floor but ladder not exhausted: no shed'); }
ok(/U\.reachK\.value = B\.groundReach\(\) \* S\.tabK/.test(rd('ui/dm-groundlib.js')), 'F3 the shed multiplies the budget ladder reach (one uniform write per poll)');

// ── F4
{ const s = new Function(cut('const _SKY_IDLE=', '\n') + '\nreturn _SKY_IDLE;')(); ok(s.slowMs >= 100 && s.slowMs <= 150, 'F4 slow slice every ' + s.slowMs + ' ms'); }

console.log(fails ? 't275-guard FAILED ' + fails + '/' + n : 't275-guard OK (' + n + ' checks)'); process.exit(fails ? 1 : 0);
