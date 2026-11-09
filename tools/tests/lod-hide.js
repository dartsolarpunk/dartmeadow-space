// node tools/tests/lod-hide.js — (lod-hide) no square "reference tiles" on the shore or the sea, the LOD stays round, and the radius maths is
// Justin Craig Venable's Radical Circumference / ArcEdge (https://dartedge.com/radicaledge), not pi.
//  (1) ui/dm-radical-circ.js matches the documented formulas: C = sqrt((3d)^2), A = C^2, V = A^3, SSA = V x 0.25, rim centre-to-centre, half-radius,
//      1/8 balance, ArcEdge sections (x*2+1)/x and the 0.125 arc match.  No Math.PI in it.
//  (2) the teal quad: the mansion GLB's ah_pool surfaces (both GLBs) are re-lit by DMFac.poolLook when the GLB loads: no full-strength cyan emissive.
//  (3) the sea's trigger volume is never drawn (its tinted rootSize box was a square patch on the open sea).
//  (4) the sea sheet ends on a circle that lies inside the clip-map's outermost square for every focus / snap on every tier, and the sea shader fades by it.
//  (5) across the same rim the sky ground takes the sea over: sheet + ground sea share one smoothstep, so they sum to exactly 1 (no gap, no square).
//  (6) the near-ground tessellated patch is a disc: radial relief (the same at the same distance on an axis and a diagonal), flat by the rim's inner
//      edge, drawn to the rim's centre (past the coarse ground's 0.8 hole, inside its square grid).
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const RC = require(path.join(root, 'ui', 'dm-radical-circ.js'));
global.DMRadCirc = RC;
const WC = require(path.join(root, 'ui', 'dm-water-core.js'));
let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } };
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9) * Math.max(1, Math.abs(b));
const cut = (src, a, b) => { const i = src.indexOf(a); if (i < 0) throw new Error('marker not found: ' + a); const j = src.indexOf(b, i + a.length); if (j < 0) throw new Error('end marker not found: ' + b); return src.slice(i, j); };

// ── (1) the helper ──
{
  const src = fs.readFileSync(path.join(root, 'ui', 'dm-radical-circ.js'), 'utf8');
  ok(!/Math\.PI|\bPI2\b|6\.283|3\.1415/.test(src.replace(/\/\*[\s\S]*?\*\//, '')), 'no pi in the Radical Circumference helper');
  ok(/Justin Craig Venable/.test(src) && /dartedge\.com\/radicaledge/.test(src), 'helper credits Justin Craig Venable and dartedge.com/radicaledge');
  // the reference formulas (ariel-site arcedge.html venableCircumference / venableArea / venableVolume / venableSSA; arcedge.py doc_circumference = d * 3)
  const vC = d => Math.sqrt(Math.pow(d * 3, 2)), vA = d => Math.pow(vC(d), 2), vV = d => Math.pow(vA(d), 3), vS = d => vV(d) * 0.25;
  for (const d of [0.25, 1, 2, 3.5, 10, 64, 128.5, 2048, 4096]) {
    ok(near(RC.circumference(d), vC(d)) && near(RC.circumference(d), d * 3), 'circumference(' + d + ') = sqrt((3d)^2) = 3d');
    ok(near(RC.area(d), vA(d)), 'area(' + d + ') = (sqrt((3d)^2))^2');
    ok(near(RC.sphereVolume(d), vV(d)), 'sphereVolume(' + d + ') = ((sqrt((3d)^2))^2)^3');
    ok(near(RC.sphereSurface(d), vS(d)), 'sphereSurface(' + d + ') = volume x 0.25');
    ok(near(RC.eighth(d), d / 8), 'eighth(' + d + ') = d / 8');
    ok(near(RC.balance(d, d), d / 8) && near(RC.balance(-d, d), -d / 8) && near(RC.balance(d / 16, d), d / 16), 'balance clamps to +-1/8 of the diameter (' + d + ')');
    ok(near(RC.arcEighth(d), d), '0.125 arc match: the matched circle\'s eighth is the piece itself (' + d + ')');
    ok(near(RC.circumference(RC.arcMatchD(d)) * 0.125, d), 'arcMatchD: circumference / 8 of the matched diameter = ' + d);
  }
  ok(near(RC.rimCentre(30, 40), 35), 'rim measured centre-to-centre of the rim material');
  ok(near(RC.halfRadius(40), 20), 'half-radius circle');
  const r = RC.rim(40); ok(r.outer === 40 && near(r.inner, 30) && near(r.centre, 35), 'rim(40) = outer 40, inner 40 - 80/8, centre 35');
  const o = { inner: 0, outer: 0, centre: 0 }; ok(RC.rim(10, o) === o, 'rim reuses the caller\'s object (no allocation per frame)');
  ok(near(RC.sectionRatio(1), 3) && near(RC.sectionRatio(2), 2.5) && near(RC.sectionRatio(4), 2.25), 'ArcEdge sections 1-3: (x*2+1)/x');
  ok(near(RC.quarterShift(40, 1), 10) && near(RC.quarterShift(40, 4), 40), 'shift every quarter radius');
  ok(RC.radialFade(5, 10, 20) === 1 && RC.radialFade(25, 10, 20) === 0 && near(RC.radialFade(15, 10, 20), 0.5), 'radial fade');
  ok(/<script src="ui\/dm-radical-circ\.js\?v=\d+"><\/script>[\s\S]*<script src="ui\/dm-water-core\.js/.test(html), 'index.html loads dm-radical-circ.js before the water core');
}

// ── (2) the teal quad: ah_pool ──
{
  const fac = fs.readFileSync(path.join(root, 'ui', 'dm-facilities.js'), 'utf8');
  const F = {}; new Function('F', cut(fac, 'F.POOL_LOOK =', '  function mansionInstance(T) {'))(F);
  ok(typeof F.poolLook === 'function', 'DMFac.poolLook exists');
  ok(/MAN\.glb = gl;[^\n]*\n[^\n]*ah_pool'\) F\.poolLook\(o\.material\)/.test(fac), 'loadMansion re-lights every ah_pool material as the GLB arrives (before any clone / impostor)');
  const col = (r, g, b) => ({ r, g, b, setRGB(a, c, d) { this.r = a; this.g = c; this.b = d; return this; } });
  for (const g of ['ariel-home.glb', 'ariel-home-512.glb']) {
    const d = fs.readFileSync(path.join(root, 'assets', 'ariel-home', g)), jl = d.readUInt32LE(12), J = JSON.parse(d.slice(20, 20 + jl).toString('utf8'));
    const P = J.materials.filter(m => m.name === 'ah_pool');
    ok(P.length === 1, g + ': one ah_pool material');
    for (const pm of P) {
      const e = pm.emissiveFactor || [0, 0, 0], b = (pm.pbrMetallicRoughness || {}).baseColorFactor || [1, 1, 1, 1];
      const m = { name: 'ah_pool', color: col(b[0], b[1], b[2]), emissive: col(e[0], e[1], e[2]), roughness: 0.05, metalness: 0, emissiveIntensity: 1 };
      F.poolLook(m);
      const em = Math.max(m.emissive.r, m.emissive.g, m.emissive.b) * m.emissiveIntensity, base = Math.max(m.color.r, m.color.g, m.color.b);
      ok(em < 0.02, g + ': pool emissive after poolLook ' + em.toFixed(3) + ' (shipped ' + Math.max(...e).toFixed(2) + ': a glowing teal quad at night)');
      ok(base < 0.1, g + ': pool base colour is deep water, not saturated cyan (' + base.toFixed(3) + ')');
      ok(m.roughness < 0.2 && m.metalness > 0.1, g + ': pool stays glossy and takes reflections');
    }
    // the pool primitives really are flat quads (what read as an LOD "reference tile")
    let quads = 0; J.meshes.forEach(me => me.primitives.forEach(p => { if (J.materials[p.material] && J.materials[p.material].name === 'ah_pool') { const a = J.accessors[p.attributes.POSITION]; if (a.count === 8 && Math.abs(a.max[1] - a.min[1]) > 1) quads++; } }));
    ok(quads >= 1, g + ': ah_pool primitives are flat quads (2 per LOD)');
  }
}

// ── (3) the sea's trigger volume is never drawn ──
{
  const s = cut(html, "const vol=new THREE.Mesh(new THREE.BoxGeometry(SZ,depth,SZ", 'PW.scene.add(vol);');
  ok(/vol\.material\.visible=false;/.test(s), 'the water volume box (square tinted patch on the open sea) is not drawn');
  ok(/vol\.userData\.waterVolume=true/.test(s) && /vol\.userData\.bounds=/.test(s), 'the swim trigger keeps its userData / bounds');
}

// ── (4) the sea sheet's circular rim ──
{
  for (const name of ['low', 'medium', 'high', 'ultra']) {
    const g = WC.TIERS[name].grid, want = 4096, levels = Math.min(9, WC.levelsFor(g.n, g.c0, want)), cm = WC.clipmap(g.n, g.c0, levels, Math.max(2, g.n / 8));
    const cOut = g.c0 * Math.pow(2, levels - 1), q = 2 * cOut, rim = WC.sheetRim(cm.half, cOut);
    ok(rim.outer + q <= cm.half + 1e-9, name + ': rim ' + rim.outer + ' + one snap ' + q + ' inside the outer square half ' + cm.half);
    ok(near(rim.inner, rim.outer - 2 * rim.outer / 8) && near(rim.centre, (rim.inner + rim.outer) / 2), name + ': rim band = outer less 1/8 of the diameter, measured to its centre');
    // every point of the circle lies inside the outermost level's (snapped) square, whatever the focus
    let inside = true;
    for (let k = 0; k < 400 && inside; k++) {
      const fx = (k * 7919.37) % 9000 - 4500, fz = (k * 104.729 * 31) % 9000 - 4500, sx = Math.floor(fx / q) * q, sz = Math.floor(fz / q) * q;
      for (let a = 0; a < 64; a++) { const u = a / 64 * 6, cx = Math.cos(u) * rim.outer, cz = Math.sin(u) * rim.outer, x = fx + cx, z = fz + cz;
        if (Math.abs(x - sx) > cm.half || Math.abs(z - sz) > cm.half) { inside = false; break; } }
    }
    ok(inside, name + ': the circle never reaches the square edge (400 foci)');
  }
  const sea = fs.readFileSync(path.join(root, 'ui', 'dm-water-sea.js'), 'utf8'), wj = fs.readFileSync(path.join(root, 'ui', 'dm-water.js'), 'utf8');
  ok(/const rimK = float\(1\.0\)\.sub\(smoothstep\(U\.seaRim\.x, U\.seaRim\.y, length\(xz\.sub\(U\.focus\)\)\)\);/.test(sea), 'sea shader: rim fade by the true distance from the focus');
  ok(/const cover = min\(min\(coarseCover, nearCover\), rimK\);/.test(sea), 'sea shader: the rim joins the coverage (opacity + mask)');
  ok(/seaRim: uniform\(new THREE\.Vector2\(1e9, 2e9\)\)/.test(wj), 'rim uniform defaults far out (nothing changes before a sheet)');
  ok(/S\.rim = core\.sheetRim\(cm\.half, g\.c0 \* Math\.pow\(2, levels - 1\), S\.rim \|\| null\); if \(S\.U && S\.U\.seaRim\) S\.U\.seaRim\.value\.set\(S\.rim\.inner, S\.rim\.outer\);/.test(wj), 'attachSea sets the rim once');
  ok(/function seaRim\(\) \{ return S\.active && S\.mesh && S\.rim \? S\.rim : null; \}/.test(wj), 'DMWater.seaRim() returns the one rim object');
}

// ── (5) the sky ground takes the sea over across the same rim ──
{
  const take = new Function(cut(html, 'function _skySeaTake(', 'SkyGround.prototype._seaRimInit') + 'return _skySeaTake;')();
  const rim = WC.sheetRim(2048, 64), sheetK = d => { const t = Math.min(1, Math.max(0, (d - rim.inner) / (rim.outer - rim.inner))); return 1 - t * t * (3 - 2 * t); };
  let sum1 = true, mono = true, prev = -1;
  for (let d = 0; d <= rim.outer * 1.3; d += 3.7) { const g = take(d, -5, rim); if (Math.abs(g + sheetK(d) - 1) > 1e-12) sum1 = false; if (g < prev - 1e-12) mono = false; prev = g; }
  ok(sum1, 'sheet + ground sea sum to 1 at every distance (no uncovered seabed, no seam)');
  ok(mono, 'the ground takes the sea over monotonically outward');
  ok(take(rim.inner * 0.5, -5, rim) === 0 && take(rim.outer * 1.01, -5, rim) === 1, 'inside: the sheet; outside: the painted sea');
  ok(take(rim.outer * 1.2, 3, rim) === 0, 'land stays land (only ground below the sea level takes the sea colour: continent / lake contours)');
  ok(take(rim.outer * 1.2, -5, null) === 0, 'no sheet, no change');
  const sk = cut(html, 'SkyGround.prototype._seaRimInit=function(){', '// (Wave 1) may the tile at the head of the queue be built now?');
  ok(/W\.smoothstep\(U\.r\.x,U\.r\.y,W\.distance\(W\.vec2\(p\.x,p\.z\),U\.c\)\)/.test(sk), 'ground shader: the same smoothstep(inner, outer, true distance) as the sea');
  ok(/U\.c\.value\.set\(DW\.S\.focus\[0\],DW\.S\.focus\[1\]\); U\.r\.value\.set\(rim\.inner,rim\.outer\);/.test(sk), 'the rim follows the sheet focus each frame (set, no allocation)');
  ok(/this\._seaRimTick\(\);/.test(cut(html, 'SkyGround.prototype.update=function(cam,budgetMs){', 'SkyGround.prototype._rootKeep')), 'update() ticks the rim');
}

// ── (6) the tessellated patch is a disc ──
{
  const src = cut(html, 'const _TESS_RIM=', '// the disc mask of the refined patch');
  const E = new Function('window', src + 'return {_TESS_RIM,_tessW};')({ DMRadCirc: RC });
  const R = E._TESS_RIM, T = { cx: 100, cz: -40, half: 40 };
  ok(near(R.full, 0.5) && near(R.flat, 0.75) && near(R.keep, 0.875), 'disc radii: half-radius 0.5, rim inner 0.75, rim centre 0.875 (x half)');
  ok(R.keep > 0.8 && R.keep < 1, 'drawn past the coarse ground\'s hole (0.8) and inside the grid square (1)');
  ok(R.flat <= R.keep, 'flat (plain height field) before the drawn edge: the disc edge meets the coarse ground exactly');
  let radial = true;
  for (let e = 0; e <= 1.2; e += 0.01) { const ax = E._tessW(T.cx + e * T.half, T.cz, T), dg = E._tessW(T.cx + e * T.half * Math.SQRT1_2, T.cz + e * T.half * Math.SQRT1_2, T); if (Math.abs(ax - dg) > 1e-9) radial = false; }
  ok(radial, 'relief weight is radial: same on the axis and the diagonal (a square metric would differ)');
  ok(E._tessW(T.cx + 0.3 * T.half, T.cz - 0.3 * T.half, T) === 1, 'full relief inside the half-radius circle');
  ok(E._tessW(T.cx + 0.6 * T.half, T.cz + 0.6 * T.half, T) === 0, 'a grid corner (0.85 half out) is flat: no square corner of relief');
  const job = cut(html, 'function* _tessJob(cx,cz,half,slot){', '// height of the refined surface inside area T');
  ok(/_tessKeepMask\(TERRAIN\.tessMat\);/.test(job), 'the patch material gets the disc mask');
  const mk = cut(html, 'function _tessKeepMask(m){', 'function _tessFree(m)');
  ok(/lessThan\(h\.r\.mul\(k\)\)/.test(mk) && /keep\.or\(inS\)/.test(mk), 'disc mask: inside any slot\'s keep radius');
  ok(/const _tessAreaAt=|function _tessAreaAt\(x,z\)\{[^\n]*Math\.hypot\(x-T\.cx,z-T\.cz\)<T\.half\*0\.8/.test(html), 'walking reads the patch inside 0.8 half (radial), where it is drawn');
}

// guards: ATMO stays 46
ok(/ATMO_DEFAULT_AGL=46\b/.test(html), 'ATMO_DEFAULT_AGL stays 46');

if (fails) { console.log('lod-hide FAILED', fails, 'of', n); process.exit(1); }
console.log('lod-hide OK (' + n + ' checks)');
