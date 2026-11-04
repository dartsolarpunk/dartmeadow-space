// Headless enter/exit cycle test for the mansion's streamed assets (ui/dm-facilities.js heavy-load gate + cliff/2K texture steps, ui/dm-mansion-interior.js lazy interior).
// Simulates the world opening and closing repeatedly (exit at random moments, with loads still in flight) and counts live "GPU" objects (textures, geometries, materials) with
// tracked disposables. Invariant after every settled cycle: the live counts return to the baseline (no growth per enter/exit), the heavy queue is empty, nothing loads into a dead world.
//   node tools/tests/mansion-cycle.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const NAVJ = JSON.parse(fs.readFileSync(path.join(root, 'assets/ariel-home/ariel-home-interior-nav.json'), 'utf8'));
let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const live = { tex: 0, geo: 0, mat: 0 }, created = { tex: 0, geo: 0, mat: 0 };
const mkTex = () => { const t = { isTexture: true, dead: false, dispose() { if (!t.dead) { t.dead = true; live.tex--; } } }; live.tex++; created.tex++; return t; };
const mkGeo = () => { const g = { dead: false, dispose() { if (!g.dead) { g.dead = true; live.geo--; } } }; live.geo++; created.geo++; return g; };
const mkMat = (name, maps) => { const m = Object.assign({ name, dead: false, userData: {}, dispose() { if (!m.dead) { m.dead = true; live.mat--; } } }, maps || {}); live.mat++; created.mat++; return m; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sb = { console, Math, Float64Array, Uint8Array, Int16Array, Set, Map, Promise, JSON, Date, performance, setTimeout, clearTimeout, setInterval, clearInterval, atob: s => Buffer.from(s, 'base64').toString('binary'),
  navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', platform: 'Linux', maxTouchPoints: 5 }, document: { hidden: false }, requestAnimationFrame: f => setTimeout(f, 4), CustomEvent: function () { },
  fetch: async (u) => ({ ok: true, json: async () => (/nav/.test(u) ? NAVJ : { base: 'assets/ariel-home/cliff/', uv: [0, 0], tileM: 3, heightTierFor: {}, sets: { a: { material: 'ah_rock_a', depthM: .1 }, b: { material: 'ah_rock_b', depthM: .1 }, c: { material: 'ah_rock_c', depthM: .1 }, d: { material: 'ah_rock_d', depthM: .1 } } }) }),
  addEventListener() { }, dispatchEvent() { } };
sb.window = sb; sb.globalThis = sb;
const crumbs = []; sb.DMCrumb = { begin: (n) => crumbs.push('b:' + n), end: (n) => crumbs.push('e:' + n), mark: () => { }, live: () => { }, gpu: () => { } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-facilities.js'), 'utf8'), sb, { filename: 'dm-facilities.js' });
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-mansion-interior.js'), 'utf8'), sb, { filename: 'dm-mansion-interior.js' });
const F = sb.DMFac, D = sb.DMMansionInt, X = F._t;
// the GLB the game keeps across visits: 4 cliff materials + 5 hero materials, each with embedded maps
const mats = {};
['ah_rock_a', 'ah_rock_b', 'ah_rock_c', 'ah_rock_d', 'ah_slate', 'ah_concrete', 'ah_wood', 'ah_dark', 'ah_leaf'].forEach(n => { mats[n] = mkMat(n, { map: mkTex(), normalMap: mkTex(), roughnessMap: mkTex() }); });
X.MAN.glb = { scene: { traverse(fn) { for (const n in mats) fn({ isMesh: true, material: mats[n] }); } } };
const baseline = { tex: live.tex, geo: live.geo, mat: live.mat };
class TL { load(u, ok, _p, no) { setTimeout(() => ok(mkTex()), 5 + rnd() * 25); } }
const THREE = { TextureLoader: TL, RepeatWrapping: 1000, SRGBColorSpace: 'srgb' };
let interiorLoads = 0;
const ctx = { isMobile: () => true, tier: () => 2, shadows: () => false, THREE, PW: () => ({ renderer: { compileAsync: () => sleep(10) }, camera: {}, scene: {} }), mapTag() { },
  loadGLB: async (u) => { await sleep(15 + rnd() * 40); interiorLoads++; const g = mkGeo(), m = mkMat('int', { map: mkTex() }); return { scene: { name: '', traverse(fn) { fn(this); fn({ isMesh: true, geometry: g, material: m }); }, updateMatrixWorld() { }, parent: null } }; } };
F.bind(ctx);
let fails = 0, checks = 0; const ok = (c, m) => { checks++; if (!c) { fails++; console.log('  FAIL ' + m); } };
const settle = async () => { for (let i = 0; i < 200 && (X.HQ.q.length || X.HQ.busy); i++) await sleep(50); await sleep(100); };
(async () => {
  F.ver = 't';
  // short gaps so the test is quick (the gate waits GAP ms between steps on phones)
  const realST = sb.setTimeout; sb.setTimeout = (f, ms) => realST(f, Math.min(ms || 0, 20));
  for (let cycle = 0; cycle < 8; cycle++) {
    const scene = {}; F.scene = scene;
    const grp = { parent: scene, children: [], add(o) { o.parent = grp; this.children.push(o); }, remove(o) { o.parent = null; } };
    const rec = { group: grp, warmed: true, def: { id: 'ariel-home' } };
    D.attach(F, rec, 0, 0, 0, 0);
    X.upgradeCliff(THREE); X.upgrade2K(THREE);          // arrival: texture steps queued
    D.tick(rec, 0, 1000, false); D.tick(rec, 0, 2500, false);   // she is near: the interior load is queued behind them
    const exitAt = cycle % 3 === 2 ? 1e9 : 20 + rnd() * 400;   // every third cycle runs to completion; the others leave with loads in flight
    await sleep(exitAt === 1e9 ? 2500 : exitAt);
    if (exitAt === 1e9) await settle();
    F.close();                                           // _pwClose: before the scene is disposed
    ok(X.HQ.q.length === 0, 'cycle ' + cycle + ': heavy queue empty after close');
    ok(D.status().state === 0 && !D.status().loaded, 'cycle ' + cycle + ': interior unloaded after close');
    await settle(); await sleep(300);
    ok(live.tex === baseline.tex, 'cycle ' + cycle + ': textures back to baseline (' + live.tex + ' vs ' + baseline.tex + ')');
    ok(live.geo === 0 && live.mat === baseline.mat, 'cycle ' + cycle + ': interior geometries / materials freed (geo ' + live.geo + ', mat ' + live.mat + '/' + baseline.mat + ')');
  }
  // the last cycle ran to completion with no exit-in-flight: a final full enter must upgrade everything without growth
  F.scene = {}; const rec = { group: { add() { }, remove() { } }, warmed: true, def: { id: 'x' } }; D.attach(F, rec, 0, 0, 0, 0); X.upgradeCliff(THREE); X.upgrade2K(THREE); await settle();
  ok(live.tex === baseline.tex, 'final: textures at baseline after full upgrade (' + live.tex + ')');
  F.close(); await settle();
  ok(crumbs.filter(c => c.startsWith('b:')).length === crumbs.filter(c => c.startsWith('e:')).length, 'every breadcrumb begin has an end (' + crumbs.filter(c => c.startsWith('b:')).length + ')');
  console.log('created textures ' + created.tex + ', live ' + live.tex + ' (baseline ' + baseline.tex + '); geometries created ' + created.geo + ', live ' + live.geo + '; interior loads ' + interiorLoads);
  console.log(fails ? 'FAIL ' + fails + '/' + checks : 'mansion-cycle: all ' + checks + ' checks passed'); process.exit(fails ? 1 : 0);
})();
