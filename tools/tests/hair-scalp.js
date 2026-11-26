// Scalp collision probe (v385): is the scalp a real collision body for BOTH characters, for guides AND children, in motion?
//   node tools/tests/hair-scalp.js [--quick] [--tiers 0,1,2] [--chars ariel,emma] [--report]
// Real GLBs + grooms + merged clips, three@0.185 headless, CPU solver (the CPU child loop is the twin of the GPU ribbon shader: same plane / SDF maths).
// For a pose sweep (idle, run, climb, mount, back jump, crawl, surprised, walk; Emma also get-up + climb-hang) the strands are sampled MID-MOTION (every 10th frame of the clip (--full: all ten poses),
// not only at its end) and compared with the SKINNED Scalp / Emma_Scalp triangles of that frame:
//   guideX  = guide segments (points 1..K) that cross the scalp sheet          childX = child ribbon centreline segments that cross it
//   guideIn = guide points (k >= 2) behind the sheet within 8 mm of it (sign from the nearest face; > 8 mm is ambiguous on an open sheet and not counted)
//   fieldGap = scalp vertices where the solver's own head field is > 2 mm off the skinned mesh (the field the solver trusts vs the surface that is drawn)
// Thresholds (see TH) are the measured values + ~25 % at the time of writing: a regression guard, not a "zero" claim; the table printed with --report is the audit.
// Skips (exit 0) when three@0.185 is not installed (npm i three@0.185.0).
'use strict';
const path = require('path'), { pathToFileURL } = require('url');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const quick = process.argv.includes('--quick'), report = process.argv.includes('--report');
const TIERS = (arg('--tiers', quick ? '2' : '0,1,2')).split(',').map(Number), CHARS = arg('--chars', 'ariel,emma').split(',');
(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, 'lib-hair-probe.mjs')).href);
  if (!L.HAVE_THREE) { console.log('SKIP: three@0.185.0 not installed'); process.exit(0); }
  const { THREE } = L, mod = await import(pathToFileURL(process.env.DM_HAIR_JS || path.join(L.D, 'hair_strands.js')).href + '?t=' + Math.random());   // DM_HAIR_JS=/path/to/old/hair_strands.js: A/B against another version (needs only buildHair; hooks _fieldAt / stats.dyn are optional)
  let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
  const POSES = [['idle', null, 1], ['Running', 'Running', 1], ['climbing_up_wall', 'climbing_up_wall', 1], ['Mount_Step', 'Mount_Step', 1], ['Back_Jump', 'Back_Jump', 1], ['Crawl_Backward_inplace', 'Crawl_Backward_inplace', 1],
    ['Acting_Surprised', 'Acting_Surprised', 1], ['Walking', 'Walking', 1], ['Emma_Land', 'Emma_Land', 0], ['Emma_Climb_Hang', 'Emma_Climb_Hang', 0]];
  const only = arg('--poses', ''), full = process.argv.includes('--full'), poseList = POSES.filter((p) => only ? only.split(',').includes(p[0]) : quick ? ['idle', 'Mount_Step', 'Emma_Land'].includes(p[0]) : (full || ['idle', 'Running', 'climbing_up_wall', 'Mount_Step', 'Emma_Land', 'Emma_Climb_Hang'].includes(p[0])));
  // measured (this branch, peak over all sampled poses) + ~25 %: peak over the sampled frames of a pose, [guideX, childX]; tier 0 / 1 are looser (fewer contact passes)
  const TH = {
    ariel: { 0: [20, 130], 1: [20, 160], 2: [95, 125] },
    emma: { 0: [140, 480], 1: [90, 160], 2: [55, 115] }
  };

  const res = [], t0all = Date.now();
  for (const name of CHARS) for (const tier of TIERS) {
    const S = await L.setup(name, mod, { params: { collisionTier: tier }, getIntensity: () => 1 });
    const H = S.H, K = H.meta.points, G = H.meta.guides, C = L.CHARS[name];
    for (const [pname, clipName, both] of poseList) {
      if (!both && name !== 'emma') continue;
      const clipN = clipName || C.idle, cl = S.clips.find((c) => c.name === clipN); if (!cl) continue;
      L.play(S, C.idle, 0); for (let i = 0; i < 40; i++) { S.mixer.setTime(0); S.root.updateMatrixWorld(true); H.update(1 / 60); }
      L.play(S, clipN, 0); H.reset();
      const nf = Math.min(60, Math.max(30, Math.round(cl.duration * 60))), R = { name, tier, pose: pname, gX: 0, cX: 0, gIn: 0, gXmax: 0, cXmax: 0, gInMax: 0, n: 0, ms: 0, msN: 0, dynOn: 0, fieldGap: 0, fieldGapMax: 0 };
      for (let f = 0; f < nf; f++) {
        S.mixer.setTime(Math.min(cl.duration, f / 60)); S.root.updateMatrixWorld(true);
        const t0 = performance.now(); H.update(1 / 60); R.ms += performance.now() - t0; R.msN++;
        if (H.stats.dyn && H.stats.dyn.on) R.dynOn++;
        if (f < 4 || f % 10 !== 4) continue;
        const surf = L.surfaces(S, ['scalp']).scalp, sp = H._dbg().sp; let gX = 0, gIn = 0;
        for (let g = 0; g < G; g++) for (let k = 2; k < K; k++) {
          const a = (g * K + k - 1) * 3, b = a + 3; gX += L.crosses(surf, sp[a], sp[a + 1], sp[a + 2], sp[b], sp[b + 1], sp[b + 2]) ? 1 : 0;
          const r = L.nearest(surf, sp[b], sp[b + 1], sp[b + 2], 0.008); if (r && r.d < -0.0005 && r.d > -0.008) gIn++;
        }
        const m = L.measure(S, { scalp: surf }, 0.0025, 1).scalp, cX = m.cross;
        // the field the solver collides with vs the drawn skin (scalp vertices): > 2 mm off (not FAR = outside the field box, those are counted separately in the report)
        let gap = 0; { const sc = S.meshes[C.sets.scalp[0]], v = new THREE.Vector3(), M = new THREE.Matrix4().copy(S.root.matrixWorld).invert().multiply(sc.matrixWorld); sc.skeleton.update();
          const stride = name === 'ariel' ? 8 : 1; for (let q = 0; q < sc.geometry.attributes.position.count; q += stride) { sc.getVertexPosition(q, v).applyMatrix4(M); const d = H._fieldAt ? H._fieldAt(v.x, v.y, v.z, -1, 0) : 1e9; if (d < 1e8 && d > 0.002) gap++; } }
        R.gX += gX; R.cX += cX; R.gIn += gIn; R.n++; R.gXmax = Math.max(R.gXmax, gX); R.cXmax = Math.max(R.cXmax, cX); R.gInMax = Math.max(R.gInMax, gIn); R.fieldGap += gap; R.fieldGapMax = Math.max(R.fieldGapMax, gap);
      }
      R.ms = R.ms / Math.max(1, R.msN); res.push(R);
      console.log(`${name} tier ${tier} ${pname.padEnd(22)} guideX peak ${String(R.gXmax).padStart(4)} mean ${(R.gX / R.n).toFixed(1).padStart(6)} | childX peak ${String(R.cXmax).padStart(4)} mean ${(R.cX / R.n).toFixed(1).padStart(6)} | guideIn peak ${String(R.gInMax).padStart(4)} | fieldGap>2mm peak ${String(R.fieldGapMax).padStart(3)} | dyn on ${R.dynOn}/${R.msN} | update ${R.ms.toFixed(1)} ms`);
    }
    const st = H.stats.dyn;
    if (!H._fieldAt) continue;   // A/B run against an older solver
    if (name === 'emma') ok(!!st && st.tris > 0, `emma tier ${tier}: dynamic skinned-scalp collider built (${st ? st.tris + ' triangles, ' + st.verts + ' vertices' : 'MISSING'})`);
    else ok(!st || st.tris === st.staticTris, `ariel tier ${tier}: no skinned (non-Head-weighted) scalp triangles, only the static ear sheets (${st ? st.staticTris : 0}); scalp is 100 % Head-weighted, rigid SDF is exact`);
  }
  for (const R of res) {
    const th = TH[R.name][R.tier]; if (!th) continue;
    ok(R.gXmax <= th[0], `${R.name} tier ${R.tier} ${R.pose}: guide segments through the scalp peak ${R.gXmax} <= ${th[0]}`);
    ok(R.cXmax <= th[1], `${R.name} tier ${R.tier} ${R.pose}: child segments through the scalp peak ${R.cXmax} <= ${th[1]}`);
  }
  // Emma's scalp must actually be an active body in motion (the v384 failure: the head-frame field alone, 0 "inside" by its own count while 60-110 guide segments crossed the mesh)
  for (const R of res.filter((r) => r.name === 'emma' && /Mount|Land|climb/i.test(r.pose))) ok(R.dynOn > 0, `emma tier ${R.tier} ${R.pose}: skinned-scalp collider switched on while the neck moves (${R.dynOn}/${R.msN} frames)`);
  // identical settings: both characters' scalp collision runs the same clearance / cushion / tier path; the only difference allowed is the data (rigid vs skinned)
  console.log(`done in ${((Date.now() - t0all) / 1000).toFixed(0)} s`);
  if (report) console.log(JSON.stringify(res));
  console.log(fails ? fails + ' FAILED' : 'ALL OK'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
