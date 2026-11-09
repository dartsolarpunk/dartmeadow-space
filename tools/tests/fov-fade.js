// node tools/tests/fov-fade.js — (fov-fill 2, #253 follow-up to 78d0e81; Watcher NAY items a / b / c) the QUALITY FADE CHAIN fills the view to the horizon.
//  (1) ui/dm-lod.js qualityBands, for every device class from the street, the HOME deck and a low flight: every hand-off is a smoothstep band (width >= 15 %),
//      texture / lighting / shadow / prop layers chain without a gap out to the ground's dissolve or the haze end, and the prop coverage (near chunks + far
//      canopy) has NO HARD LINE anywhere between the props' old reach and groundR (max step per 1 u < 1 %, vs the old 100 % cut at the chunk draw cut).
//  (2) texture: the close-up field (worley pebbles / grit / cracks + their bump) is still gated on `fade` (0 past reach = 22-40 u): never evaluated at horizon
//      distances; the MID (5..16 reach) and FAR (to groundR) bands are cheap value noise only (no worley), each inside its own branch, and leave the sea alone.
//  (3) lighting / shadows (ui/dm-light.js): the horizon field (48 m cells, 128^2) carries the terrain sun shadow and a far AO from where the 8 m field ends to
//      the haze end from the deck on Med+; Low / mobile Medium (PRESET_CAP.mob.medium = 'low') build no march, but the shipped 512 shadow map still eases out
//      over U.sm (shadow-map-only wrapper; no square edge). The ladder sheds the horizon field; the probe hand-offs are radial.  On Solenne's real height
//      field (the coastal cliff of fov-fill.js) a low sun puts far ground in terrain shadow that had none.
//  (4) props: near chunks dissolve per pixel (shared materials, one mask) and the far canopy takes exactly their pixels (noise >= wN) to the haze end (noise <
//      wF); its fill on the real Solenne field, mobile class: every chunk inside the circle filled, nothing outside it, the near trees' rules and density,
//      its own seed (the near scatter is untouched), no per-frame allocation, and the 13 fps fill time.
//  (5) tessellation: the geometric disc still eases to flat at 0.75 half and the bump carries on past it on every preset (no cliff after the disc).
//  (6) the designed deck infinity pool stays (poolLook takes the teal); poolTrim is a no-op; measured on every mansion GLB, both ah_pool quads and the pool-room tub stay.
//  (7) cache tags: CACHE_NAME v302 (#249: main 69a9ff4 / #254 is v301, +1). dm-light.js is ?v=301 (the Low shadow-map wrapper, #254); dm-lod.js stays ?v=300;
//      dm-facilities.js is ?v=302 (past the v300b pool restore; JOTS Cliffs #249).
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const L = require(path.join(root, 'ui', 'dm-lod.js'));
const LT = require(path.join(root, 'ui', 'dm-light.js'));
const TL = require(path.join(root, 'ui', 'dm-terrain-lod.js'));
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const cut = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('marker not found: ' + a); const j = html.indexOf(b, i + a.length); if (j < 0) throw new Error('marker not found: ' + b); return html.slice(i, j); };
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ── Solenne's real height field (the same build as fov-fill.js) ──
const srcNoise = cut('function _vnoise(x,y,seed){', '// Texel generation is pure arithmetic');
const srcD = cut('const ATMO_DEG_PER_UNIT=0.008;', '// One map per planet') + cut('function _siteWorldXZ(site){', 'const LAND_PICK_RANGE');
const srcCore = cut('function _terrainCore(x,z,seed,_ws){', '// ── Shoreline water');
const srcField = cut('function _groundField(body,site,pal){', '// ── The planet\'s ground, level of detail, pole to pole');
class Col { constructor() { this.r = 0; this.g = 0; this.b = 0; } copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; } clone() { return new Col().copy(this); } lerp(c, t) { this.r += (c.r - this.r) * t; return this; } multiplyScalar(s) { return this; } setHex() { return this; } offsetHSL() { return this; } }
const E = new Function('THREE', 'window', 'DMTerrainLod', `
  ${srcNoise}
  ${srcD}
  let PW = { site: null };
  const TERRAIN = { style: 'lush' }, _worldSeed = () => 311;
  const _sbcIsEarth = () => false, _sbcC = new THREE.Color();
  let surfaceBiomeColor = () => _sbcC;
  function _smooth01(t){ t=Math.max(0,Math.min(1,t)); return t*t*(3-2*t); }
  ${srcCore}
  ${srcField}
  return { _groundField, setSite: s => { PW.site = s; } };
`)({ Color: Col }, {}, TL);
const pal = { water: true, liquidColor: 0x1a4a7a, ground: 0x3a7d34 }, site = { lat: 18, lon: 40 };
E.setSite(site); const F = E._groundField({ name: 'Solenne', type: 'Habitable', home: true }, site, pal);
let cliff = null;
for (let x = -2600; x <= 2600; x += 40) for (let z = -2600; z <= 2600; z += 40) {
  const h = F.H(x, z); if (!(h > 30)) continue; let sea = false;
  for (let a = 0; a < 8; a++) if (F.H(x + Math.cos(a * 0.785) * 150, z + Math.sin(a * 0.785) * 150) < -5) sea = true;
  if (sea && (!cliff || Math.abs(h - 60) < Math.abs(cliff.h - 60))) cliff = { x, z, h };
}
ok(!!cliff, 'a coastal cliff near the mansion site (the HOME deck height class)');
const R = 360 / 0.008 / (2 * Math.PI), eye = cliff.h + 3.3;
const RELIEF = +(html.match(/const _SKY_RELIEF=(\d+)/) || [])[1], FADE0 = +(html.match(/const _SKY_FADE0=([\d.]+)/) || [])[1];
const reachOf = h => Math.sqrt(h * (2 * R + h)) + Math.sqrt(RELIEF * (2 * R + RELIEF));
const gDeck = Math.max(1200, Math.min(Math.max(3500, reachOf(eye)), reachOf(eye))), gStreet = Math.max(1200, reachOf(1.7));

// ── (1) the band chain ──
const horHalf = LT.horEdge(128, LT.HOR_CELL);
const scen = [];
for (const tier of L.TIERS) {
  const viewH = tier === 'desktop' ? 1080 : 900, fov = 72;
  const cut0 = L.propCutErr(tier, 420, 0, 1, fov, viewH), ring = L.propRing(tier, cut0);   // the near props keep their OLD cut / ring (cost): PW._propFog
  for (const [name, gR, fog] of [['street', gStreet, gStreet * FADE0], ['HOME deck', gDeck, gDeck * FADE0], ['low flight', 4200, 3400]]) {
    const o = { reach: ({ low: 17.6, mobile: 24, desktop: 40 })[tier], fogEnd: Math.min(fog, gR * FADE0), groundR: gR, shadowHalf: ({ low: 28, mobile: 43, desktop: 93 })[tier], propCut: cut0, ring, horHalf };
    scen.push({ tier, name, o, B: L.qualityBands(tier, o) });
  }
}
{
  const res = L.qualityBands('mobile', scen[0].o); const again = L.qualityBands('mobile', scen[4].o, res);
  ok(again === res, 'qualityBands fills a caller-owned object (the per-tick path allocates nothing)');
  const src = fs.readFileSync(path.join(root, 'ui', 'dm-lod.js'), 'utf8'), body = src.slice(src.indexOf('function qualityBands('), src.indexOf('/* weight of a band'));
  ok(!/=>/.test(body.replace(/const B = res \|\|[^\n]*\n/, '')) && /S2\(B\.tex\.near/.test(body), 'qualityBands: no closure; only the first call (no res) builds the object');
}
const bandsOf = B => [['tex.near', B.tex.near], ['tex.mid', B.tex.mid], ['tex.far', B.tex.far], ['light.far', B.light.far], ['light.hor', B.light.hor], ['shadow.map', B.shadow.map], ['shadow.hor', B.shadow.hor], ['props.near', B.props.near], ['props.far', B.props.far]];
for (const S of scen) {
  const { B, o } = S, tag = S.tier + ' / ' + S.name;
  for (const [k, ab] of bandsOf(B)) ok(ab[0] < ab[1] && (ab[1] - ab[0]) >= 0.15 * ab[1] - 1e-9, tag + ': ' + k + ' is a band [' + ab.map(Math.round) + '], not a cut');
  // texture: near ends at reach, mid starts inside the near band's end x5 and ends inside the haze; far = the ground's own dissolve
  ok(B.tex.near[1] === o.reach && B.tex.mid[1] < B.fogEnd && B.tex.far[0] === B.fogEnd && B.tex.far[1] === B.groundR, tag + ': texture near -> mid -> far ends with the ground (' + Math.round(B.groundR) + ' u)');
  let texGap = 0; for (let d = 0; d < B.fogEnd; d += 2) { const w = Math.max(L.bandW(d, B.tex.near), L.bandW(d, B.tex.mid), L.bandW(d, B.tex.far)); if (w < 0.999) texGap++; }
  ok(texGap === 0, tag + ': a texture layer is at full weight at every distance short of the dissolve (' + texGap + ' gaps)');
  // props: no hard line between the props' reach and groundR
  let maxStep = 0, at = 0, zeroAt = -1;
  for (let d = 0; d <= B.groundR; d += 1) { const a = L.propCover(d, B), b = L.propCover(d + 1, B); if (Math.abs(b - a) > maxStep) { maxStep = Math.abs(b - a); at = d; } if (zeroAt < 0 && b <= 1e-9) zeroAt = d + 1; }
  ok(maxStep < 0.01, tag + ': prop coverage has no hard line (largest step ' + (maxStep * 100).toFixed(2) + ' % per u at ' + at + ' u)');
  ok(L.propCover(B.props.far[0] - 1, B) === 1 && zeroAt >= B.fogEnd * 0.999, tag + ': props cover the view to ' + Math.round(B.props.far[0]) + ' u and fade out at the haze end (' + Math.round(B.fogEnd) + ' u), not at the old ' + Math.round(o.propCut) + ' u');
  ok(B.props.near[1] <= Math.min(o.propCut, o.ring * 300) + 1e-9, tag + ': the near chunks fade out inside their own draw cut / streamed ring (cost unchanged)');
  // the old picture: chunks hidden at the draw cut = a 100 % step there
  // shadows: map eased out inside its box; the horizon shadow reaches the haze end on foot
  ok(B.shadow.map[1] < o.shadowHalf, tag + ': the shadow map has eased out at ' + B.shadow.map[1].toFixed(1) + ' u, inside its ' + o.shadowHalf + ' u box (no square edge)');
  if (S.name !== 'low flight') ok(B.shadow.hor[1] >= B.fogEnd * 0.999, tag + ': terrain sun shadow (horizon field) reaches the haze end (' + Math.round(B.shadow.hor[1]) + ' >= ' + Math.round(B.fogEnd) + ')');
  ok(B.light.far[1] === B.groundR, tag + ': the far lighting term lasts to the ground\'s dissolve');
}
{
  const S = scen.find(s => s.tier === 'mobile' && s.name === 'HOME deck'), B = S.B;
  let oldStep = 0; const oldCut = S.o.propCut; for (let d = 0; d < B.groundR; d++) { const a = d < oldCut ? 1 : 0, b = d + 1 < oldCut ? 1 : 0; oldStep = Math.max(oldStep, Math.abs(b - a)); }
  ok(oldStep === 1, 'the old props: a 100 % line at ' + Math.round(oldCut) + ' u in clear air (what Watcher saw)');
  console.log('  mobile, HOME deck (eye ' + eye.toFixed(1) + ' u): haze end ' + Math.round(B.fogEnd) + ', groundR ' + Math.round(B.groundR) + ' | props near [' + B.props.near.map(Math.round) + '] far canopy to [' + B.props.far.map(Math.round) + '] | tex mid [' + B.tex.mid.map(Math.round) + '] far [' + B.tex.far.map(Math.round) + '] | shadow map [' + B.shadow.map.map(x => x.toFixed(1)) + '] horizon [' + B.shadow.hor.map(Math.round) + ']');
}
// ── (2) texture: the close-up field stays close ──
{
  const M = cut('function _terrainDetailMat(opts){', '\n    // cracks shade darker');
  ok(/const reach=opts\.reach\|\|\(\{1:22,2:30,3:40\}\)\[lvl\]\*\(_lowG\?0\.8:1\);/.test(M), 'close-up reach unchanged: 22 / 30 / 40 u (x0.8 on a low Mali)');
  ok(/const fade=W\.float\(1\)\.sub\(W\.smoothstep\(W\.float\(reach\*0\.45\),W\.float\(reach\),dist\)\)\.mul\(flat\);/.test(M), 'the close-up weight is 0 past reach');
  ok(/const DETC=_gate\(fade\.greaterThan\(0\.0\)/.test(M) && /W\.If\(fade\.greaterThan\(0\.0\),\(\)=>\{ dd\.assign\(slopeOf\(\)\); \}\);/.test(M), 'the worley / grit field (colour + bump) is built only where fade > 0: never at horizon distances');
  const mid = M.slice(M.indexOf('const MIDF='), M.indexOf('const lodTint='));
  ok(mid.length > 50 && !/worley/.test(mid) && (mid.match(/mx_fractal_noise_float\(/g) || []).length === 1 && /,2,2\.0,0\.5\)/.test(mid) && (mid.match(/_n1\(/g) || []).length === 2, 'mid / far bands: one 2-octave value field + two single octaves, no worley');
  ok(/_gt\(midW\.greaterThan\(0\.0\)/.test(mid) && /_gt\(farW\.greaterThan\(0\.0\)/.test(mid), 'each inside its own branch on its weight');
  ok(/const midW=lvl>=2\?W\.float\(1\)\.sub\(W\.smoothstep\(W\.float\(reach\*5\),W\.float\(reach\*16\),dist\)\)\.mul\(flat\):W\.float\(0\);/.test(M), 'mid band [5 reach, 16 reach] = DMLod tex.mid (walkable ground only; Low: none)');
  ok(/const farW=\(_LQ\?W\.float\(1\)\.sub\(W\.smoothstep\(_LQ\.far\.x,_LQ\.far\.y,dist\)\):W\.float\(1\)\)\.mul\(_dryM\?W\.float\(1\):W\.smoothstep\(W\.float\(-0\.6\),W\.float\(0\.4\),p\.y\)\);/.test(M), 'far band ends with the ground\'s dissolve (shared uniform) and skips the sea paint (water only from the contours)');
  ok(/\.mul\(cliffTint\)\.mul\(basinTint\)\.mul\(lodTint\);/.test(html), 'the bands tint the ground colour (cliff strata untouched: Cliffs #249)');
  const Q = cut('function _lodQTick(){', '\n}\n');
  ok(/U\.far\.value\.set\(gR\*_SKY_FADE0,gR\);/.test(Q), 'the far texture band is the SkyGround dissolve band [0.82 groundR, groundR]');
  // at horizon distances the heavy weights are 0 for every preset
  for (const r of [17.6, 22, 24, 30, 40]) { const d = 0.82 * gDeck; ok(1 - ss(r * 0.45, r, d) === 0 && 1 - ss(r * 5, r * 16, d) === 0 && 1 - ss(0.82 * gDeck, gDeck, d) === 1, 'reach ' + r + ': at ' + Math.round(d) + ' u only the far tint runs'); }
}
// ── (3) lighting / shadows ──
{
  const T = LT.TIERS;
  ok(T.low.horSteps === 0 && T.low.horN === 0 && T.off.horN === 0, 'Low / off: no horizon field, no extra march (30 fps rule)');
  ok(T.med.horSteps > 0 && T.high.horSteps >= T.med.horSteps && T.ultra.horSteps >= T.high.horSteps, 'horizon steps monotone over tiers');
  for (const t of LT.TIER_ORDER) for (let l = 0; l <= 3; l++) { const e = LT.effective(t, l, true, null, 0); ok(e.horSteps <= (T[t].horSteps || 0) && (l < 3 || e.horSteps === 0), t + ' ladder ' + l + ': horizon steps ' + e.horSteps + ' (sheds, frozen at L3)'); }
  ok(LT.effective('high', 0, true, null, 1000).freeze, 'idle high above the ground (probe work frozen)');
  ok(horHalf >= 2384 && LT.HOR_MAX <= horHalf, 'the horizon field reaches ' + horHalf + ' u (the haze end from the deck is ~' + Math.round(gDeck * FADE0) + ')');
  const src = fs.readFileSync(path.join(root, 'ui', 'dm-light.js'), 'utf8'), am = src.slice(src.indexOf('D.applyMaterial = function'), src.indexOf('D.applyTree = function'));
  ok(!/dxz = max\(abs\(p\.x\.sub\(U\.cam\.x\)\)/.test(am), 'probe hand-offs are radial (no square window ring)');
  ok(/vis = mix\(vis, farVis, wOut\)/.test(am) && /If\(wOut\.greaterThan\(0\.0\)/.test(am), 'past the probes the far AO term (branch on wOut), not flat open sky');
  ok(/const wMap = float\(1\)\.sub\(smoothstep\(U\.sm\.x, U\.sm\.y/.test(am) && /mix\(float\(1\), s, wMap\)\.mul\(hfVis\)/.test(am), 'the shadow map eases out over U.sm, the height-field march carries on');
  // Low / mobile Medium: hasMarch() is false (no sun/far/horizon march), but Low still ships shadows:true at a 512 map. The wMap wrapper must still install.
  ok(T.low.sunSteps === 0 && T.low.farSteps === 0 && T.low.farN === 0 && T.low.horSteps === 0 && T.low.horN === 0, 'Low: hasMarch() is false (sunSteps / farN / horN all 0)');
  ok(/mob: \{ low: 'low', medium: 'low'/.test(src), "mobile Medium is capped to the Low light stage (PRESET_CAP.mob.medium = 'low')");
  ok(/if \(o\.shadow !== false\) \{/.test(am) && !/if \(o\.shadow !== false && hasMarch\(\)\)/.test(am), 'the shadow-map fade is not gated on hasMarch()');
  ok(/if \(hasMarch\(\)\) \{[\s\S]*mix\(float\(1\), s, wMap\)\.mul\(hfVis\)[\s\S]*\} else \{[\s\S]*m\.receivedShadowNode = prev \? \(\(s\) => mix\(float\(1\), prev\(s\), wMap\)\) : \(\(s\) => mix\(float\(1\), s, wMap\)\);/.test(am), 'Low: shadow-map-only wMap wrapper (no height-field march)');
  ok(/If\(wH\.greaterThan\(0\.0\)/.test(src) && /smoothstep\(300\.0, 450\.0, dC\)/.test(src), 'the horizon march only runs past ~300 m (a real branch: the near ground never pays)');
  const tb = LT.tierBytes('ultra'); ok((tb.cpu + tb.gpu) / 1048576 < 4, 'ultra caches < 4 MB with the horizon field (' + ((tb.cpu + tb.gpu) / 1048576).toFixed(2) + ')');
  // CPU replica of the shader's horizon march over the 48 m field on Solenne, low sun from the west: far ground that the old chain left fully lit
  const hf = LT.createHF(128, LT.HOR_CELL); hf.sampler = F.H; hf.setCenter(cliff.x, cliff.z); let fills = 0; while (hf.fill(1e9, 1e9, 0) > 0) fills++;
  const hz = (x, z) => { const c = hf.cell, fx = x / c, fz = z / c, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, g = (a, b) => hf.valid(a, b) ? hf.data[(a & hf.M) + (b & hf.M) * hf.N] : -1e9;
    return g(i, j) * (1 - u) * (1 - v) + g(i + 1, j) * u * (1 - v) + g(i, j + 1) * (1 - u) * v + g(i + 1, j + 1) * u * v; };
  const sun = [-0.95, 0.24, 0.2], sl = Math.hypot(...sun); sun.forEach((v, i) => sun[i] = v / sl);
  let far = 0, shadowed = 0;
  for (let d = 500; d < 2300; d += 60) for (let a = 0; a < 64; a++) {
    const x = cliff.x + Math.cos(a * 0.0982) * d, z = cliff.z + Math.sin(a * 0.0982) * d, y = F.H(x, z); if (!(y > 0)) continue; far++;
    let v = 1; for (let i = 1; i <= LT.TIERS.high.horSteps; i++) { const f = i / LT.TIERS.high.horSteps, t = LT.HOR_T0 + (LT.HOR_MAX - LT.HOR_T0) * f * f, qx = x + sun[0] * t, qy = y + sun[1] * t, qz = z + sun[2] * t; const dh = qy - hz(qx, qz) + 2; v = Math.min(v, Math.max(0, Math.min(1, dh / (0.09 * t * 2 + 1e-3) * 0.5 + 0.5))); }
    if (v < 0.5) shadowed++;
  }
  ok(far > 200 && shadowed > 0, 'Solenne, low sun: ' + shadowed + ' of ' + far + ' land points 500-2300 u out lie in terrain shadow from the horizon field (the 8 m field ends at ~490 u: they had none)');
  console.log('  horizon field: 128^2 x 48 m (+-' + horHalf + ' u), cold fill ' + (128 * 128) + ' height samples in 0.25 ms slices; low sun: ' + shadowed + '/' + far + ' far land points shadowed');
}
// ── (4) props: near dither + far canopy ──
{
  const dm = cut('function _propDistMask(){', '\n}\n');
  ok(/lessThan\(wN\)/.test(dm) && /W\.smoothstep\(U\.pn\.x,U\.pn\.y,W\.length\(W\.positionView\)\)/.test(dm) && /_PROP_MK\[q\]/.test(dm), 'near prop chunks: the three shared materials keep a pixel while noise < 1 - smoothstep(pn) (per pixel, no chunk line)');
  const ini = cut('function _farCanopyInit(){', '\n}\n');
  ok(/mat\.maskNode=_pwfMask\(\)\.and\(ign\.greaterThanEqual\(wN\)\)\.and\(ign\.lessThan\(wF\)\)/.test(ini), 'far canopy: exactly the near layer\'s complement (noise >= wN) up to the haze end (noise < wF): no gap, no double layer');
  ok(/im\.castShadow=false; im\.receiveShadow=false;/.test(ini) && !/DMCollide/.test(ini), 'far canopy: one draw, no shadow pass, no colliders');
  const tk = cut('function _farCanopyBand(d){', '// Leave the world');
  const hot = tk.slice(tk.indexOf('function _farCanopyWrite('));
  ok(!/new [A-Z]|\bnew\b|=>|\[\s*\]|\{\s*\}/.test(hot.replace(/\/\/[^\n]*/g, '')), 'far canopy tick / write / fill: no allocation, no closure');
  ok(/_rng32\(_chunkSeed\(i,j,\(TERRAIN\.seed\|\|1\)\)\^0x2f6b1c3d\)/.test(tk) && !/_hmChunkScatter/.test(tk), 'far canopy draws from its own seed stream (the near scatter, and so every existing world, is unchanged)');
  const gen = cut('function* _hmChunkScatterG(i,j){', 'function _disposeProps(g){'), gen0 = require('child_process').execSync('git show 78d0e81:index.html', { cwd: root, maxBuffer: 1 << 26 }).toString();
  ok(gen0.indexOf(gen) >= 0, 'the near chunk scatter is byte-identical to 78d0e81');
  // run it: stub THREE math, the real tick on Solenne, mobile class
  const tierM = (ini.match(/R=\(\{low:(\d+),mobile:(\d+),desktop:(\d+)\}\)/) || []).slice(1).map(Number), tierK = (ini.match(/K=\(\{low:(\d+),mobile:(\d+),desktop:(\d+)\}\)/) || []).slice(1).map(Number);
  class M4 { constructor() { this.s = [1, 1, 1]; this.p = [0, 0, 0]; } compose(p, q, s) { this.p = [p.x, p.y, p.z]; this.s = [s.x, s.y, s.z]; return this; } makeScale(x, y, z) { this.s = [x, y, z]; return this; } }
  class V3 { set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
  let hCalls = 0, clockT = 0; const hCost = 0.012;   // ms per height sample on a 13 fps tablet (node here is ~6x faster; measured below)
  const H = (x, z) => { hCalls++; clockT += hCost; return F.H(x, z); };
  { const t0 = process.hrtime.bigint(); for (let i = 0; i < 20000; i++) F.H(cliff.x + i * 0.37, cliff.z - i * 0.21); const us = Number(process.hrtime.bigint() - t0) / 1e3 / 20000; console.log('  Solenne H(x,z) here: ' + us.toFixed(2) + ' us / call (tablet assumed ' + (hCost * 1000).toFixed(0) + ' us)'); }
  const inst = []; const im = { visible: true, parent: null, instanceMatrix: { needsUpdate: false }, instanceColor: { needsUpdate: false }, setMatrixAt(k, m) { inst[k] = { s: m.s.slice(), p: m.p.slice() }; }, setColorAt() { } };
  const grp = {}; im.parent = grp;
  const ENV = new Function('THREE', 'performance', 'GFX', 'STATE', 'TERRAIN', 'PW', 'SURF_CHUNK', '_rng32', '_chunkSeed', '_LODQ', '_SKY_FADE0', 'window', 'location', `
    ${cut('const _FC={on:', '\n')}
    ${cut('function _farCanopyBand(d){', 'function _farCanopyTick(px,pz,agl){')}
    ${cut('function _farCanopyTick(px,pz,agl){', '// Leave the world')}
    return { _FC, _farCanopyTick, _farCanopyBand, _FC_SCALE };`);
  const rngSrc = cut('function _rng32(a){', '\n'), seedSrc = cut('const _chunkSeed=', '\n');
  const _rng32 = new Function(rngSrc + '\nreturn _rng32;')(), _chunkSeed = new Function(seedSrc + '\nreturn _chunkSeed;')();
  const C = 300, TER = { group: grp, pal, Hg: H, seed: 311 }, PWs = { scene: {}, gen: 1, _groundR: gDeck }, LQ = { B: { fogEnd: gDeck * FADE0 } };
  const X = ENV({ Matrix4: M4, Vector3: V3, Quaternion: V3, Color: Col }, { now: () => clockT }, { isMobile: true }, { settings: { particles: 'med' } }, TER, PWs, C, _rng32, _chunkSeed, LQ, FADE0, {}, { search: '' });
  const Rm = tierM[1], Km = tierK[1], nn = 2 * Rm + 1; const FC = X._FC;
  Object.assign(FC, { mesh: im, gen: 1, n: nn, K: Km, R: Rm, ci: 1e9, cj: 1e9, si: new Int32Array(nn * nn).fill(0x7ffffffe), sj: new Int32Array(nn * nn).fill(0x7ffffffe), sc: new Uint8Array(nn * nn), pos: new Float32Array(nn * nn * Km * 5), q: new Int32Array(nn * nn * 2), qn: 0, qi: 0, M: new M4(), P: new V3(), Q: new V3(), S: new V3(), C: new Col() });
  let px = cliff.x, pz = cliff.z, frames = 0;
  do { clockT += 77; X._farCanopyTick(px, pz, 0); frames++; } while (FC.qi < FC.qn && frames < 20000);
  const fe = gDeck * FADE0, Rw = Math.min(Rm, Math.ceil(fe / C + 0.5)), ci = Math.floor((px + C / 2) / C), cj = Math.floor((pz + C / 2) / C);
  let inC = 0, filled = 0, stray = 0, trees = 0, capped = 0, land = 0, badRule = 0, badBand = 0;
  for (let di = -Rm; di <= Rm; di++) for (let dj = -Rm; dj <= Rm; dj++) {
    const i = ci + di, j = cj + dj, s = (((i % nn) + nn) % nn) + (((j % nn) + nn) % nn) * nn, want = di * di + dj * dj <= (Rw + 0.5) * (Rw + 0.5);
    if (want) { inC++; if (FC.si[s] === i && FC.sj[s] === j) filled++; if (FC.sc[s] !== X._farCanopyBand(Math.hypot(di, dj) * C)) badBand++; } else if (FC.si[s] !== 0x7ffffffe) stray++;
    let k = 0; for (let q = 0; q < Km; q++) { const o = (s * Km + q) * 5; if (FC.pos[o + 3] > 0) { k++; const x = FC.pos[o], z = FC.pos[o + 2], h = F.H(x, z); if (!(h > 5 && h < 40) || Math.abs(x - i * C) > C / 2 || Math.abs(z - j * C) > C / 2) badRule++; } const m = inst[s * Km + q]; if (!want && m && m.s[0] !== 0) stray++; }
    if (want) { trees += k; if (k === Km) capped++; if (k) land++; }
  }
  ok(filled === inC && stray === 0 && badBand === 0, 'far canopy, mobile, from the cliff: ' + filled + ' / ' + inC + ' chunks in the ' + Math.round((Rw + 0.5) * C) + ' u circle filled (haze end ' + Math.round(fe) + '), none outside, every crown in its size band');
  ok(badRule === 0 && trees > 50, trees + ' crowns, all on land between the swash and 40 u, each inside its own chunk (the near trees\' rules)');
  // the same samples with no cap (the near rule's density): the cap thins only the densest chunks, and the far size bands (x1.5 / x2.2 crowns) cover more
  let cand = 0, keptA = 0, candA = 0;
  for (let di = -Rw; di <= Rw; di++) for (let dj = -Rw; dj <= Rw; dj++) {
    if (di * di + dj * dj > (Rw + 0.5) * (Rw + 0.5)) continue; const i = ci + di, j = cj + dj, rnd = _rng32(_chunkSeed(i, j, 311) ^ 0x2f6b1c3d), per = Math.round(140 * C * C / (560 * 560)); let c = 0;
    for (let t = 0; t < per; t++) { const x = i * C + (rnd() - 0.5) * C, z = j * C + (rnd() - 0.5) * C; rnd(); rnd(); rnd(); if (!((((x * 12.9898 + z * 78.233) % 1) + 1) % 1 > 0.6)) continue; const h = F.H(x, z); if (h > 5 && h < 40) c++; }
    const sc = X._FC_SCALE[X._farCanopyBand(Math.hypot(di, dj) * C)], k = Math.min(c, Km); cand += c; candA += c; keptA += k * sc * sc;
  }
  ok(keptA >= 0.9 * candA, 'the per-chunk cap (' + Km + ') keeps ' + trees + ' of ' + cand + ' near-rule trees; with the far crown sizes the canopy area is ' + (100 * keptA / candA).toFixed(0) + ' % of the near rule\'s');
  const s0 = frames;
  console.log('  far canopy (mobile): ' + trees + ' crowns in ' + land + ' wooded chunks, ' + hCalls + ' height samples, ' + s0 + ' frames at 0.6 ms (' + (s0 / 13).toFixed(1) + ' s at 13 fps, H ' + (hCost * 1000) + ' us); instances ' + nn * nn * Km);
  ok(s0 / 13 < 30, 'the far canopy fills from cold in < 30 s on a 13 fps tablet (' + (s0 / 13).toFixed(1) + ' s), never more than its 0.6 ms slice a frame');
  // walk 1.5 km east: the window follows, nothing stale is left once the queue drains
  for (let st = 0; st < 600; st++) { px += 2.5; clockT += 77; X._farCanopyTick(px, pz, 0); }
  let more = 0; do { clockT += 77; X._farCanopyTick(px, pz, 0); more++; } while (FC.qi < FC.qn && more < 20000);
  const ci2 = Math.floor((px + C / 2) / C); let ok2 = 0, tot2 = 0, stray2 = 0;
  for (let di = -Rm; di <= Rm; di++) for (let dj = -Rm; dj <= Rm; dj++) { const i = ci2 + di, j = cj + dj, s = (((i % nn) + nn) % nn) + (((j % nn) + nn) % nn) * nn, want = di * di + dj * dj <= (Rw + 0.5) * (Rw + 0.5); if (want) { tot2++; if (FC.si[s] === i && FC.sj[s] === j) ok2++; } else if (FC.si[s] !== 0x7ffffffe) stray2++; }
  ok(ok2 === tot2 && stray2 === 0, 'after a 1.5 km walk the window has followed (' + ok2 + '/' + tot2 + ', ' + stray2 + ' stale)');
  X._farCanopyTick(px, pz, 400); ok(im.visible === false, 'above 220 u (as the near props) the far canopy is not drawn');
  TER.pal = { water: false, ground: 0x8a6a40 }; im.visible = true; X._farCanopyTick(px, pz, 0); ok(im.visible === false, 'trees only on the green worlds');
}
// ── (5) tessellation hand-off ──
{
  const tt = JSON.parse(cut('const TESS_TIER=', ';\n').slice('const TESS_TIER='.length).replace(/(\w+):/g, '"$1":'));
  ok(/const _TESS_RIM=\(function\(\)\{ const RC=window\.DMRadCirc;/.test(html), 'the tess disc (Radical Circumference rim) is unchanged');
  for (const [p, lvl0] of [['low', 1], ['medium', 2], ['high', 3], ['ultra', 3]]) for (const lowG of [false, true]) {
    const lvl = Math.min(lowG ? 2 : 3, lvl0), reach = ({ 1: 22, 2: 30, 3: 40 })[lvl] * (lowG ? 0.8 : 1), flat = tt[p].half * 0.75;
    // past the disc: the bump (lvl 1: no mid grain) or the mid grain, which is at full weight from 0 to 5 reach on lvl >= 2, then the far tint (full to the haze end)
    const cover = lvl >= 2 ? reach * 5 : reach;
    ok(cover > flat, p + (lowG ? ' (low Mali)' : '') + ': relief eases flat at ' + flat + ' u (disc ' + tt[p].half + '), surface detail at full weight to ' + cover + ' u (' + (lvl >= 2 ? 'mid grain' : 'bump') + '), far tint to the haze end');
  }
}
// ── (6) the designed deck infinity pool stays; poolLook takes the teal ──
{
  const fac = fs.readFileSync(path.join(root, 'ui', 'dm-facilities.js'), 'utf8'), Fm = {};
  new Function('F', fac.slice(fac.indexOf('  F.POOL_LOOK ='), fac.indexOf('  function mansionInstance(T) {')))(Fm);
  ok(Fm.poolTrim([60, 1, -20, 61, 1, -20, 60, 1, -19], null) === null, 'a triangle inside the deck box is kept (the designed infinity pool stays)');
  ok(Fm.poolTrim([-10, 1, 20, -9, 1, 20, -10, 1, 21], null) === null && Fm.poolTrim([45, 1, -20, 47, 1, -20, 46, 1, -19], null) === null, 'triangles outside the deck box stay');
  const glb = f => { const b = fs.readFileSync(f), jl = b.readUInt32LE(12), J = JSON.parse(b.slice(20, 20 + jl).toString()), bin = b.slice(20 + jl + 8); return { J, bin }; };
  const rd = (G, ai) => { const J = G.J, a = J.accessors[ai], bv = J.bufferViews[a.bufferView], off = (bv.byteOffset || 0) + (a.byteOffset || 0), sz = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType], c = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type], st = bv.byteStride || sz * c, out = [];
    for (let i = 0; i < a.count; i++) for (let k = 0; k < c; k++) { const o = off + i * st + k * sz; out.push(a.componentType === 5126 ? G.bin.readFloatLE(o) : a.componentType === 5125 ? G.bin.readUInt32LE(o) : a.componentType === 5123 ? G.bin.readUInt16LE(o) : G.bin.readUInt8(o)); } return out; };
  const dir = path.join(root, 'assets', 'ariel-home');
  for (const g of fs.readdirSync(dir).filter(f => /\.glb$/.test(f))) {
    const G = glb(path.join(dir, g));
    G.J.meshes.forEach(me => me.primitives.forEach(p => {
      const mn = G.J.materials[p.material] && G.J.materials[p.material].name; if (!/pool|water/.test(mn || '')) return;
      const P = rd(G, p.attributes.POSITION), I = p.indices != null ? rd(G, p.indices) : null, keep = Fm.poolTrim(P, I), all = I || [...Array(P.length / 3).keys()];
      const kept = keep || all; let terrace = 0, deck = 0;
      for (let t = 0; t < kept.length; t += 3) { const v = [0, 1, 2].map(k => kept[t + k]); if (v.every(i => P[i * 3 + 1] < -18)) terrace++; if (v.every(i => P[i * 3 + 1] > -5 && P[i * 3] > 46 && P[i * 3] < 77 && P[i * 3 + 2] > -32 && P[i * 3 + 2] < -7)) deck++; }
      if (mn === 'ah_pool') ok(keep === null && terrace === 2 && deck === 2 && kept.length === all.length, g + ' ' + me.name + ': deck infinity pool kept (' + deck + ') and sea-terrace pool kept (' + terrace + ')');
      else { // the pool-room tub: interior GLB, int_water — poolTrim must keep every triangle even if it were ever run on it
        const xs = [], zs = [], ys = []; for (let i = 0; i < P.length; i += 3) { xs.push(P[i]); ys.push(P[i + 1]); zs.push(P[i + 2]); }
        ok(keep === null, g + ' ' + mn + ' (pool-room tub, y ' + Math.min(...ys).toFixed(2) + '..' + Math.max(...ys).toFixed(2) + ', x ' + Math.min(...xs) + '..' + Math.max(...xs) + ', z ' + Math.min(...zs) + '..' + Math.max(...zs) + '): nothing trimmed');
      }
    }));
  }
  ok(/ah_pool'\) F\.poolLook\(o\.material\)/.test(fac) && !/g\.setIndex\(k\)/.test(fac), 'loadMansion re-lights ah_pool and does not trim it');
}
// ── (7) cache tags: a v302 load cannot keep the v301 cliff / facilities scripts ──
{
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  ok(/const CACHE_NAME = 'dartmeadow-engine-v302';/.test(sw), 'CACHE_NAME is dartmeadow-engine-v302 (main v301 + 1, JOTS Cliffs #249)');
  ok(/<script src="ui\/dm-lod\.js\?v=300"><\/script>/.test(html), 'dm-lod.js cache tag stays v300');
  ok(/<script src="ui\/dm-light\.js\?v=301"><\/script>/.test(html), 'dm-light.js cache tag is v301 (Low shadow-map wrapper, #254)');
  ok(/<script src="ui\/dm-facilities\.js\?v=302" defer><\/script>/.test(html), 'dm-facilities.js cache tag is v302 (past the v300b pool restore; JOTS Cliffs #249)');
}

console.log(fails ? fails + ' FAILED of ' + n : 'fov-fade OK (' + n + ' checks)');
process.exit(fails ? 1 : 0);
