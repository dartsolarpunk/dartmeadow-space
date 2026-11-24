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
