// Simulated device check for ui/dm-governor.js against the old _dynRes ladder.   node tools/tests/governor-sim.js
// Model: frame = vsync * ceil(max(cpu, gpu1*k^2) / vsync)  (fill-bound GPU, vsync-quantised), ±4% noise, a 700 ms hitch every 35 s,
// and the scene getting 1.6x heavier at t=90 s (e.g. flying into an atmosphere) and light again at t=150 s.
const fs = require('fs'), path = require('path'), vm = require('vm');
function rng(seed){ let s=seed>>>0; return ()=>{ s^=s<<13; s>>>=0; s^=s>>>17; s^=s<<5; s>>>=0; return s/4294967296; }; }
const DEVICES = [
  { name: 'Android tablet, Ultra (gpu 120 ms @1.0, 60 Hz)', gpu1: 120, cpu: 9, vs: 16.67, mobile: true, preset: 'ultra', dpr: 1.5 },
  { name: 'iPhone, Ultra (gpu 38 ms @1.0, 60 Hz)',            gpu1: 38,  cpu: 12, vs: 16.67, mobile: true, preset: 'ultra', dpr: 2 },
  { name: 'iPhone, Auto (gpu 38 ms @1.0, 60 Hz)',             gpu1: 38,  cpu: 12, vs: 16.67, mobile: true, preset: 'auto', dpr: 2 },
  { name: 'Phone, fast (gpu 11 ms, 60 Hz)',                   gpu1: 11,  cpu: 8,  vs: 16.67, mobile: true, preset: 'high', dpr: 2 },
  { name: 'iPhone low-power (30 Hz cap, gpu 14 ms)',          gpu1: 14,  cpu: 9,  vs: 33.33, mobile: true, preset: 'ultra', dpr: 2 },
  { name: 'Desktop/laptop power-saver (30 Hz cap, gpu 14 ms)', gpu1: 14, cpu: 5, vs: 33.33, mobile: false, preset: 'ultra', dpr: 1 },
  { name: 'Desktop 144 Hz (gpu 20 ms @1.0)',                  gpu1: 20,  cpu: 3,  vs: 6.94,  mobile: false, preset: 'ultra', dpr: 1 },
];
function run(dev, which, seconds = 210) {
  const win = { performance: { _t: 0, now() { return this._t; } }, document: { hidden: false }, devicePixelRatio: dev.dpr, innerWidth: 1280,
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = v; } }, _dmWarming: false };
  const ctx = vm.createContext({ window: win, performance: win.performance, Date, Math, JSON, Float32Array, document: win.document });
  ctx.window.window = win;
  const src = fs.readFileSync(path.join(__dirname, '../../ui/dm-governor.js'), 'utf8');
  vm.runInContext(src, ctx);
  const gfx = { isMobile: dev.mobile, preset: dev.preset, dynamicRes: undefined };
  const basePR = Math.min(dev.dpr, 2);
  const r = { pr: basePR, resizes: 0, setPixelRatio(p) { this.pr = p; this.resizes++; } , _dr: null };
  const rnd = rng(7); let t = 0, nextHitch = 35000; const log = [];
  // old ladder (copied from index.html; in production it only runs on Auto, so on a chosen preset 'before' is a fixed scale)
  const old = { d: null };
  function oldDyn() {
    if (gfx.preset !== 'auto') return;
    const now = win.performance.now(); const d = old.d || (old.d = { t: now, ema: 16.7, k: 1, hold: 0, cool: 0 });
    const ms = Math.min(250, now - d.t); d.t = now; if (ms <= 0) return; d.ema += (ms - d.ema) * 0.06;
    const target = gfx.isMobile ? (gfx.preset === 'auto' ? 33.4 : 21.0) : 18.0; d.cool = Math.max(0, d.cool - ms); if (d.cool > 0) return;
    let k = d.k; const floor = gfx.preset === 'auto' ? 0.6 : 0.72;
    if (k < floor) k = floor; else if (d.ema > target * 1.25 && k > floor) k = Math.max(floor, Math.round((k - 0.14) * 100) / 100);
    else if (d.ema < target * 0.62 && k < 1) { d.hold += ms; if (d.hold > 9000) { k = Math.min(1, Math.round((k + 0.14) * 100) / 100); d.hold = 0; } } else d.hold = 0;
    if (k !== d.k) { d.k = k; d.cool = 5000; r.setPixelRatio(basePR * k); }
  }
  let sec = 0, acc = [], worstStep = 0, lastPR = r.pr, lastResizeT = -1e9, minGap = 1e9;
  while (t < seconds * 1000) {
    const k = r.pr / basePR; const heavy = (t > 90000 && t < 150000) ? 1.6 : 1;
    let c = Math.max(dev.cpu, dev.gpu1 * heavy * k * k) * (1 + (rnd() - 0.5) * 0.08);
    let ft = dev.vs * Math.ceil(c / dev.vs - 1e-6);
    if (t >= nextHitch) { ft += 700; nextHitch += 35000; }
    t += ft; win.performance._t = t; acc.push(ft);
    const before = r.pr; if (which === 'new') win.DMGov.frame(r, gfx, basePR); else oldDyn();
    if (process.env.TRACE && r.pr !== before) console.log('t=' + (t/1000).toFixed(1) + ' ft=' + ft.toFixed(0) + ' k ' + (before/basePR).toFixed(2) + ' -> ' + (r.pr/basePR).toFixed(2));
    if (r.pr !== before) { worstStep = Math.max(worstStep, Math.abs(r.pr - before) / basePR); minGap = Math.min(minGap, t - lastResizeT); lastResizeT = t; }
    if (t >= (sec + 1) * 1000) { sec++; if (sec % 15 === 0) { const w = acc.slice(); const fps = 1000 / (w.reduce((a, b) => a + b, 0) / w.length); log.push([sec, +fps.toFixed(1), +(r.pr / basePR).toFixed(2)]); } if (sec % 15 === 0) acc = []; }
  }
  return { log, resizes: r.resizes, worstStep: +worstStep.toFixed(2), minGapMs: Math.round(minGap), final: +(r.pr / basePR).toFixed(2) };
}
let fail = 0; if (process.env.ONLY) { const dev = DEVICES[+process.env.ONLY]; const b = run(dev, "new"); process.exit(0); }
for (const dev of DEVICES) {
  const a = run(dev, 'old'), b = run(dev, 'new');
  const line = (x) => x.log.map(l => `${l[1]}fps@${l[2]}`).join('  ');
  console.log('\n' + dev.name);
  console.log('  old  resizes=' + a.resizes + ' maxStep=' + a.worstStep + ' final k=' + a.final + '\n       ' + line(a));
  console.log('  new  resizes=' + b.resizes + ' maxStep=' + b.worstStep + ' final k=' + b.final + '\n       ' + line(b));
  const lastFps = (x, from) => { const v = x.log.filter(l => l[0] >= from).map(l => l[1]); return v.reduce((s, y) => s + y, 0) / v.length; };
  const nA = lastFps(a, 60), nB = lastFps(b, 60);
  console.log('  avg fps t>=60s  old ' + nA.toFixed(1) + '  new ' + nB.toFixed(1));
  if (nB < nA * 0.97) { console.log('  FAIL: new governor slower than old'); fail++; }
  if (dev.vs >= 33 && b.resizes > 3) { console.log('  FAIL: resolution pumping on a 30 Hz-capped display (' + b.resizes + ' resizes)'); fail++; }
  if (b.worstStep > 0.101) { console.log('  FAIL: step too large'); fail++; }
}
// AR active: the governor must not touch the renderer at all (ui/dm-ar-core.js owns the pixel ratio)
{
  const win = { performance: { _t: 0, now() { return this._t; } }, document: { hidden: false }, devicePixelRatio: 2, innerWidth: 1280, localStorage: { getItem() { return null; }, setItem() {} }, DMAR: { active: true } };
  const ctx = vm.createContext({ window: win, performance: win.performance, Date, Math, JSON, Float32Array, document: win.document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../ui/dm-governor.js'), 'utf8'), ctx);
  const r = { calls: 0, setPixelRatio() { this.calls++; }, _dr: null }, gfx = { isMobile: true, preset: 'ultra' };
  for (let i = 0; i < 3000; i++) { win.performance._t += 50; win.DMGov.frame(r, gfx, 2); }
  console.log('\nAR active: setPixelRatio calls = ' + r.calls + ', governor state created = ' + !!r._dr);
  if (r.calls || r._dr) { console.log('  FAIL: governor acted during AR'); fail++; }
}
process.exit(fail ? 1 : 0);
