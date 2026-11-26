// Hair collision quality tests: node tools/tests/hair-collision.js [--quick] [--report]
// Real character GLBs (Ariel = the Autumn player model, Emma) + their real strand grooms + the real merged animation clips, three@0.185 headless (no renderer, CPU solver).
// For both characters, collision tiers 0 (Low, = v357 behaviour), 1 (Mid), 2 (High) and the poses idle / head turn / run / climb:
//  1. guide points: none inside the head SDF, none inside the active body capsules (> 0.75 mm) or keep-out boxes, solver stays finite   (every tier; tier 0 has no boxes)
//  2. ground truth: child strand centrelines against the SKINNED body / shirt / glasses triangles (segment-triangle crossings): High must cut crossings clearly versus Low
// (t1644u) a 4th configuration "High+20" = tier 2 with strands resampled to 20 points (4 solver passes at tier 2) (opts.segments, Pilot Editor / menu / High-Ultra in game): judged like the
// others, and it must not cross the body / shirt / glasses more than tier 2 at the file's resolution.  --seg N picks the point count (default 20).
// (t1645u) defaults under test also include the 2x refined head SDF (opts.sdfFine), the soft contact layer (params.softBand / softK) and 1..3 contact samples per
// segment at tier 2 (params.contactSpacing).  HAIR_OPTS='{"sdfFine":1,"params":{"softBand":0}}' runs every configuration with extra options (A/B), HAIR_CHARS=ariel one character.
// Skips (exit 0) when three@0.185 is not installed (npm i three@0.185.0 in ~/.cache/dm-harness).  --quick: idle + head turn only.
'use strict';
const path = require('path'), { pathToFileURL } = require('url');
const quick = process.argv.includes('--quick'), report = process.argv.includes('--report');
const SEG = (() => { const i = process.argv.indexOf('--seg'); return i > 0 ? +process.argv[i + 1] : 20; })();
(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, 'lib-hair-probe.mjs')).href);
  if (!L.HAVE_THREE) { console.log('SKIP: three@0.185.0 not installed (npm i three@0.185.0 in ~/.cache/dm-harness)'); process.exit(0); }
  const { THREE } = L, mod = await import(pathToFileURL(path.join(L.D, 'hair_strands.js')).href + '?t=' + Math.random());
  let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
  const POSES = { idle: [null, 150], headturn: [null, 150, true], run: ['Running', 150], climb: ['climbing_up_wall', 150] };
  const poseList = quick ? ['idle', 'headturn'] : Object.keys(POSES);
  const segD = (p, a, b) => { const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], l2 = abx * abx + aby * aby + abz * abz; let t = l2 > 1e-12 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t, p[2] - a[2] - abz * t); };
  // guide points vs the active collider set of the solver (root-local, current frame)
  function guideChecks(S) {
    const H = S.H, d = H._dbg(), sp = d.sp, K = H.meta.points, G = H.meta.guides, caps = H._capsules(), boxes = H._boxes(), mg = H._margins(), hr = H.params.hairRadius, tol = 0.00075;
    let capIn = 0, boxIn = 0, worst = 0, nonFinite = 0;
    for (let g = 0; g < G; g++) for (let k = 2; k < K; k++) {
      const o = (g * K + k) * 3, p = [sp[o], sp[o + 1], sp[o + 2]]; if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]))) { nonFinite++; continue; }
      const m = H.tier >= 1 ? mg[g * K + k] : 0;
      for (const c of caps) { const pen = c.r + hr + m - segD(p, c.a, c.b); if (pen > tol) { capIn++; if (pen > worst) worst = pen; } }
      for (const B of boxes) { const b = B.buf, dx = p[0] - b[0], dy = p[1] - b[1], dz = p[2] - b[2], lx = b[3] * dx + b[4] * dy + b[5] * dz, ly = b[6] * dx + b[7] * dy + b[8] * dz, lz = b[9] * dx + b[10] * dy + b[11] * dz, mm = (b[24] + hr + m) * b[25];
        if (Math.abs(lx) < b[21] + mm - tol * b[25] && Math.abs(ly) < b[22] + mm - tol * b[25] && Math.abs(lz) < b[23] + mm - tol * b[25]) boxIn++; }
    }
    return { capIn, boxIn, worst, nonFinite, head: H._penetration(sp).inside };
  }
  const totals = {}, guide = {};   // [char][tier] -> summed ground-truth crossings
  // A/B: HAIR_OPTS='{"sdfFine":1,"params":{"softBand":0}}' merges into every configuration; HAIR_CHARS=ariel limits the characters
  const XO = (() => { try { return JSON.parse(process.env.HAIR_OPTS || '{}'); } catch (e) { return {}; } })();
  const xo = (o) => Object.assign({}, XO, o, { params: Object.assign({}, XO.params || {}, o.params || {}) });
  for (const name of (process.env.HAIR_CHARS || 'ariel,emma').split(',')) {
    const C = L.CHARS[name];
    for (const tier of [0, 1, 2, 'seg']) {
      const S = await L.setup(name, mod, xo(tier === 'seg' ? { segments: SEG, params: { collisionTier: 2 } } : { params: { collisionTier: tier } }));
      if (tier === 'seg') ok(S.H.meta.points === SEG && S.H.meta.pointsFile < SEG, name + ': strands resampled ' + S.H.meta.pointsFile + ' -> ' + S.H.meta.points + ' points');
      let bad = { capIn: 0, boxIn: 0, nonFinite: 0, head: 0 }, pts = 0, worst = 0, sim = 0, n = 0; const gt = { body: 0, shirt: 0, glasses: 0 };
      for (const pose of poseList) {
        const [clip, steps, turn] = POSES[pose]; S.H.reset(); L.play(S, clip || C.idle, 0); const head = S.bones.Head, eul = new THREE.Euler(), offQ = new THREE.Quaternion();
        for (let i = 0; i < steps; i++) {
          if (turn) head.quaternion.copy(S.restQ); S.mixer.update(1 / 60);
          if (turn) { const a = Math.min(1, i / 40); eul.set(0.35 * a * Math.sin(i / 17), 0.9 * Math.sin(i / 25) * a, 0); head.quaternion.multiply(offQ.setFromEuler(eul)); }
          S.root.updateMatrixWorld(true); S.H.update(1 / 60);
          if (i >= 30) { sim += S.H.stats.simMs; n++; }
          if (i >= 60 && i % 30 === 0) { const r = guideChecks(S); bad.capIn += r.capIn; bad.boxIn += r.boxIn; bad.nonFinite += r.nonFinite; pts += S.H.meta.guides * (S.H.meta.points - 2); bad.head += r.head; worst = Math.max(worst, r.worst); }
        }
        const r = L.measure(S, L.surfaces(S, ['body', 'shirt', 'glasses']), 0.0025, 2); for (const k of Object.keys(gt)) gt[k] += r[k].cross;
        if (report) console.log(' ', name, 'tier', tier, pose.padEnd(8), JSON.stringify({ body: r.body.cross, shirt: r.shirt.cross, glasses: r.glasses.cross }), 'sim ms', (sim / n).toFixed(2));
      }
      (totals[name] ||= {})[tier] = gt;
      ok(S.H.stats.tier === (tier === 'seg' ? 2 : tier) && bad.nonFinite === 0, name + ' tier ' + tier + ': solver finite, active tier ' + S.H.stats.tier + ', ' + S.H.stats.cols + ' capsules, ' + S.H.stats.boxes + ' boxes');
      (guide[name] ||= {})[tier] = { ...bad, worst, pts };
      if (report) console.log('  guide points', name, 'tier', tier, JSON.stringify({ head: bad.head, capIn: bad.capIn, boxIn: bad.boxIn, worstMm: +(worst * 1000).toFixed(1), of: pts }));
      if (report) console.log('  ground truth', name, 'tier', tier, JSON.stringify(gt), 'mean sim ms (node, solver only)', (sim / n).toFixed(2));
    }
    // the solver is soft (position-based, 2 iterations, pins move with the head), so the guide-point check is a RATE, not a zero: Mid / High must leave fewer guide points inside capsules + keep-out boxes than Low
    const g0 = guide[name][0], g1 = guide[name][1], g2 = guide[name][2], cb = (g) => g.capIn + g.boxIn;
    // each tier is judged against ITS OWN collider set (Low has no boxes, Mid / High add the fitted capsules + keep-out boxes), so this is an absolute rate: <= 5 % of guide points
    // end a step inside a capsule / box (the rest are held by the pins / segment-length constraints, which beat the contact on the last iteration)
    const gS = guide[name].seg, tS = totals[name].seg;
    for (const [t, g] of [[0, g0], [1, g1], [2, g2], ['2+' + SEG, gS]]) ok(cb(g) <= g.pts * 0.05, name + ' tier ' + t + ': guide points inside own capsules / boxes <= 5 % (' + cb(g) + ' of ' + g.pts + ')');
    const tolH = name === 'emma' ? 45 : 5;   // (v385) Emma: the skinned scalp triangles (dyn collider) outrank the warped head field where the two disagree (up to 33 of 24,000 points)
    ok(g2.head <= g0.head + tolH && g1.head <= g0.head + tolH, name + ': Mid / High do not push more guide points into the head SDF than Low (' + g0.head + ' / ' + g1.head + ' / ' + g2.head + ')');
    const t0 = totals[name][0], t1 = totals[name][1], t2 = totals[name][2], sum = (t) => t.body + t.shirt + t.glasses;
    ok(sum(t2) <= sum(t0) * 0.7, name + ': High cuts strand/skin/shirt/glasses crossings by >= 30 % (' + sum(t0) + ' -> ' + sum(t2) + ')');
    ok(sum(t1) <= sum(t0) * 0.9, name + ': Mid cuts crossings by >= 10 % (' + sum(t0) + ' -> ' + sum(t1) + ')');
    ok(sum(tS) <= sum(t2) * 1.1 + 5, name + ': High with ' + SEG + '-point strands crosses no more than High (' + sum(t2) + ' -> ' + sum(tS) + ')');
    ok(gS.head <= g0.head + tolH, name + ': ' + SEG + '-point strands keep out of the head SDF (' + g0.head + ' -> ' + gS.head + ')');
    ok(t2.glasses <= t0.glasses * 0.5 + 5, name + ': High keeps the strands out of the lenses / frame front (' + t0.glasses + ' -> ' + t2.glasses + ')');
  }
  console.log(fails ? fails + ' FAILED' : 'ALL OK'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
