// Measure Emma scalp (and body) strand crossings over the get-up + walk-to-board + mount sequence.
// node tools/tests/hair-emma-boardwalk.mjs [--tier 2]
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const L = await import(pathToFileURL(path.join(ROOT, 'tools/tests/lib-hair-probe.mjs')).href);
const { THREE } = L;
if (!THREE) { console.log('SKIP: no three harness'); process.exit(0); }
const tier = +((process.argv.includes('--tier') && process.argv[process.argv.indexOf('--tier') + 1]) || 2);
const mod = await import(pathToFileURL(path.join(ROOT, 'hair_strands.js')).href + '?x=' + Date.now());
const S = await L.setup('emma', mod, { params: { collisionTier: tier } });
const H = S.H, head = S.bones.Head;
const hinv = new THREE.Matrix4(), mid = new THREE.Vector3();

function resInfo() {
  const st = H.stats || {}, m = H.meta || {};
  const cell0 = m.sdf && m.sdf.cell, fine = m.sdfFine || 1;
  const cell = cell0 ? cell0 / fine : (st.sdfBand && st.sdfBand.cell);
  return {
    tier: st.tier, requested: tier,
    sdfFileCellMm: cell0 ? +(cell0 * 1000).toFixed(2) : null,
    sdfFine: fine,
    sdfRuntimeCellMm: cell ? +(cell * 1000).toFixed(2) : null,
    sdfBandOn: !!m.sdfBandOn,
    sdfBand: st.sdfBand || null,
    skinWarp: st.skinWarp || null,
    scalpMesh: !!(S.meshes.Emma_Scalp),
    bodyMesh: !!(S.meshes.Emma_Body),
    points: m.points, strands: st.strands, drawn: st.drawn
  };
}

function region(hx, hy, hz) {
  if (hz < -0.01 && hy < 0.09) return 'nape';
  if (Math.abs(hx) > 0.055 && hy < 0.12) return 'side';
  if (hy > 0.12) return 'crown';
  if (hz > 0.02) return 'hairline';
  return 'other';
}

function measureScalp() {
  const surf = L.surfaces(S, ['scalp', 'body']);
  const r = L.measure(S, surf, 0.0025, 1);
  // region breakdown for scalp crossings: midpoint of each crossing segment in Head space
  const pos = H.ribbonArrays.pos, K = H.meta.points, NR = H.stats.drawn;
  const regs = { nape: 0, side: 0, crown: 0, hairline: 0, other: 0 };
  hinv.copy(head.matrixWorld).invert();
  const GS = surf.scalp;
  for (let s = 0; s < NR; s++) {
    const P = [];
    for (let k = 0; k < K; k++) {
      const o = (s * K + k) * 6;
      P.push([(pos[o] + pos[o + 3]) / 2, (pos[o + 1] + pos[o + 4]) / 2, (pos[o + 2] + pos[o + 5]) / 2]);
    }
    for (let k = 2; k < K; k++) {
      const a = P[k - 1], b = P[k];
      if (!L.crosses(GS, a[0], a[1], a[2], b[0], b[1], b[2])) continue;
      mid.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2).applyMatrix4(hinv);
      regs[region(mid.x, mid.y, mid.z)]++;
    }
  }
  return { scalp: r.scalp.cross, scalpStrands: r.scalp.strandsX, body: r.body.cross, bodyStrands: r.body.strandsX, regs };
}

function play(clip, t0 = 0) { return L.play(S, clip, t0); }

const phases = [
  { name: 'idle-settle', clip: 'Emma_Idle', frames: 45 },
  { name: 'get-up (Emma_Land)', clip: 'Emma_Land', frames: 48 },
  { name: 'walk-to-board (Walking)', clip: 'Walking', frames: 120 },
  { name: 'mount (Mount_Step)', clip: 'Mount_Step', frames: 70 }
];

console.log('RESOLUTION', JSON.stringify(resInfo(), null, 2));
const samples = [];
const peaks = {};
const ends = {};
for (const ph of phases) {
  H.reset();
  const clip = play(ph.clip, 0);
  const dur = clip.duration;
  let peak = { scalp: 0, body: 0, at: 0, regs: null };
  let last = null;
  for (let i = 0; i < ph.frames; i++) {
    S.mixer.setTime((i / Math.max(1, ph.frames - 1)) * dur);
    S.root.updateMatrixWorld(true);
    H.update(1 / 60);
    if (i % 15 === 0 || i === ph.frames - 1) {
      last = measureScalp();
      last.phase = ph.name; last.frame = i; last.t = +((i / Math.max(1, ph.frames - 1)) * dur).toFixed(3);
      samples.push(last);
      if (last.scalp > peak.scalp) peak = { scalp: last.scalp, body: last.body, at: last.t, regs: last.regs };
      console.log(' ', ph.name, 't=' + last.t, 'scalp', last.scalp, 'strands', last.scalpStrands, 'body', last.body, 'regs', JSON.stringify(last.regs));
    }
  }
  peaks[ph.name] = peak;
  ends[ph.name] = last;
}

const maxScalp = Math.max(...samples.map(s => s.scalp));
const sumScalp = samples.reduce((a, s) => a + s.scalp, 0);
console.log('\nSUMMARY');
console.log(JSON.stringify({ info: resInfo(), ends, peaks, maxScalp, sampleSumScalp: sumScalp, samples: samples.length }, null, 2));

// Regression guard for Emma boardwalk crossings (tier 2, 6000 strands).
// V380 = 2.5 mm file + band (the original baseline). AFTER_11604F4 = the v382 1.7 mm
// full-field rebake already on this branch. Limits are max(v380, 11604f4) so this
// test fails only on a regression, and the log still prints both comparisons.
// t=0 peaks after H.reset() are ignored; mid = max in-clip sample with t>0 (not the end).
const V380_BASELINE = {
  'idle-settle': { end: 202, napeEnd: 17 },
  'get-up (Emma_Land)': { mid: 777, napeMid: 666, end: 422, napeEnd: 373 },
  'walk-to-board (Walking)': { mid: 271, end: 62 },
  'mount (Mount_Step)': { mid: 811, napeMid: 676, end: 1060, napeEnd: 508 }
};
const AFTER_11604F4 = {
  'idle-settle': { end: 167, napeEnd: 8 },
  'get-up (Emma_Land)': { mid: 762, napeMid: 658, end: 433, napeEnd: 378 },
  'walk-to-board (Walking)': { mid: 256, end: 111 },
  'mount (Mount_Step)': { mid: 841, napeMid: 691, end: 1082, napeEnd: 513 }
};
// v383: exact inverse skin-warp lookup (per-node affine inverse, 3 seeds), skin-motion contact gates, child re-sample + segment midpoint, tipsCollide.
// Measured (tier 2): idle end 56 / nape 0; get-up mid 167 / nape 66, end 3; walk mid 99, end 33; mount mid 155 / nape 109, end 11 / nape 7.
// Limits = the v383 numbers + ~15 % (a regression guard at the new level).
const V383 = {
  'idle-settle': { end: 65, napeEnd: 5 },
  'get-up (Emma_Land)': { mid: 192, napeMid: 76, end: 10, napeEnd: 10 },
  'walk-to-board (Walking)': { mid: 114, end: 40 },
  'mount (Mount_Step)': { mid: 178, napeMid: 125, end: 15, napeEnd: 10 }
};
function lim(ph, key) { return (V383[ph] || {})[key]; }
let failed = 0;
for (const ph of phases) {
  const mid = samples.filter(s => s.phase === ph.name && s.t > 0 && s.frame !== ph.frames - 1);
  const midBest = mid.reduce((a, s) => (!a || s.scalp > a.scalp) ? s : a, null);
  const end = ends[ph.name];
  const chk = (label, key, got, v380) => {
    if (got == null) return;
    const cap = lim(ph.name, key);
    if (cap == null) return;
    const ok = got <= cap;
    const v = (v380 != null) ? (', v380 ' + v380) : '';
    console.log('  THRESHOLD', ph.name, label, got, ok ? '<=' : '>', cap, ok ? 'PASS' : 'FAIL' + v);
    if (!ok) failed++;
  };
  const b380 = V380_BASELINE[ph.name] || {};
  if (midBest) {
    chk('mid scalp', 'mid', midBest.scalp, b380.mid);
    chk('mid nape', 'napeMid', midBest.regs && midBest.regs.nape, b380.napeMid);
  }
  chk('end scalp', 'end', end && end.scalp, b380.end);
  chk('end nape', 'napeEnd', end && end.regs && end.regs.nape, b380.napeEnd);
}
console.log(failed ? 'hair-emma-boardwalk: FAILED ' + failed + ' threshold(s) (regression vs v383)' : 'hair-emma-boardwalk: all thresholds passed (regression vs v383)');
if (failed) process.exit(1);
