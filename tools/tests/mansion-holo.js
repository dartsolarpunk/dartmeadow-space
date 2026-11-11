// node tools/tests/mansion-holo.js : the holographic screens of the game lounge (pure part of ui/dm-holo.js)
//  - every panel corner, the relay tower base and its floor rings stand >= 3 units INSIDE the prow glass (every window plane), clear of tall props
//  - the 2D drawing code runs on a mock canvas: balanced save/restore, every primitive inside its canvas, deterministic per t, animated over t, <= a few hundred ops
'use strict';
const fs = require('fs'), path = require('path');
const P = require('../../ui/dm-holo.js')._pure, NAV = JSON.parse(fs.readFileSync(path.join(__dirname, '../../assets/ariel-home/ariel-home-interior-nav.json'), 'utf8'));
let bad = 0, n = 0; const ok = (c, m) => { n++; if (!c) { bad++; console.log('FAIL', m); } };
const MARGIN = 3.0;
// the glass polygon here must be the one the interior nav was built from
const NR = NAV.rooms[2][1]; ok(NR.length === P.ROOM.length && NR.every((v, i) => Math.abs(v[0] - P.ROOM[i][0]) < 0.05 && Math.abs(v[1] - P.ROOM[i][1]) < 0.05), 'ROOM polygon equals nav rooms[2]');
P.PANELS.forEach((p, i) => {
  const q = P.panelQuad(p);
  for (const v of q) ok(P.glassClear(v[0], -v[2]) >= MARGIN, 'panel ' + p[0] + ' corner (' + v[0].toFixed(1) + ',' + (-v[2]).toFixed(1) + ') is ' + P.glassClear(v[0], -v[2]).toFixed(1) + ' >= ' + MARGIN + ' units inside the glass');
  ok(-q[0][2] <= 35.4, 'panel ' + p[0] + ' stays in front of the media console (y <= 35.4)');
  ok(p[3] >= 2.6, 'panel ' + p[0] + ' hovers above the furniture (bottom ' + p[3] + ')');
  ok(Math.abs(p[4] / p[5] - p[8] / p[9]) < 0.02, 'panel ' + p[0] + ' aspect matches its canvas');
  for (let j = i + 1; j < P.PANELS.length; j++) { const a = P.panelQuad(p), b = P.panelQuad(P.PANELS[j]); const ov = Math.min(Math.max(...a.map(v => v[0])), Math.max(...b.map(v => v[0]))) - Math.max(Math.min(...a.map(v => v[0])), Math.min(...b.map(v => v[0]))); ok(ov < 0, 'panels ' + p[0] + ' and ' + P.PANELS[j][0] + ' do not overlap (' + ov.toFixed(2) + ')'); }
  // tall nav obstacles (top above the panel bottom) must not intersect its footprint
  for (const o of NAV.obs) if (o[5] > p[3] - 0.2 && o[4] < p[3] + p[5]) { const xs = q.map(v => v[0]), y = -q[0][2]; ok(!(Math.max(...xs) > o[0] - 0.5 && Math.min(...xs) < o[2] + 0.5 && y > o[1] - 0.5 && y < o[3] + 0.5), 'panel ' + p[0] + ' clear of tall obstacle ' + JSON.stringify(o)); }
});
const R = P.RELAY; for (const [dx, dy, r, nm] of [[0, 0, P.RELAY_R, 'tower'], [1, 0, P.RING_R, 'ring E'], [-1, 0, P.RING_R, 'ring W'], [0, 1, P.RING_R, 'ring N'], [0, -1, P.RING_R, 'ring S']]) ok(P.glassClear(R[0] + dx * r, R[1] + dy * r) >= MARGIN, 'relay ' + nm + ' inside the glass by >= ' + MARGIN);
for (const o of NAV.obs) { const dx = Math.max(o[0] - R[0], 0, R[0] - o[2]), dy = Math.max(o[1] - R[1], 0, R[1] - o[3]); ok(Math.hypot(dx, dy) > P.RELAY_R + 1.0, 'relay tower clear of obstacle ' + JSON.stringify(o)); }
// mock 2D context
function mock(w, h) {
  const c = { ops: 0, depth: 0, clipD: 0, clips: [], maxDepth: 0, oob: 0, sig: 0, w, h, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: '' };
  const clipped = () => c.clips.some(Boolean);
  const num = (...a) => { for (const v of a) { c.sig = (c.sig * 31 + Math.round(v * 8)) | 0; if (!isFinite(v)) c.oob += 1000; } };
  const rect = (x, y, ww, hh) => { c.ops++; num(x, y, ww, hh); if (!clipped() && (x < -2 || y < -2 || x + ww > w + 2 || y + hh > h + 2)) c.oob++; };
  for (const k of ['fillRect', 'strokeRect', 'clearRect', 'rect']) c[k] = rect;
  for (const k of ['beginPath', 'stroke', 'fill']) c[k] = () => { c.ops++; };
  c.clip = () => { c.ops++; c.clips[c.depth] = true; };
  for (const k of ['moveTo', 'lineTo']) c[k] = (x, y) => { c.ops++; num(x, y); if (!clipped() && (x < -80 || y < -80 || x > w + 80 || y > h + 80)) c.oob++; };
  c.arc = (x, y, r, a, b) => { c.ops++; num(x, y, r, a, b); if (!clipped() && (x < -r || y < -r || x > w + r || y > h + r)) c.oob++; };
  c.ellipse = (x, y, rx, ry) => { c.ops++; num(x, y, rx, ry); };
  c.fillText = (s, x, y) => { c.ops++; num(x, y, s.length); };
  c.drawImage = () => { c.ops++; };
  c.save = () => { c.depth++; c.clips[c.depth] = false; c.maxDepth = Math.max(c.maxDepth, c.depth); }; c.restore = () => { c.clips[c.depth] = false; c.depth--; };
  return c;
}
for (const [nm, fn, w, h] of [['A', P.drawA, 512, 288], ['B', P.drawB, 320, 200], ['Engine', P.drawEngine, 512, 320]]) {
  const sigs = []; let maxOps = 0;
  for (let k = 0; k < 40; k++) { const t = k * 0.7; const c = mock(w, h); fn(c, t, null); const c2 = mock(w, h); fn(c2, t, null); ok(c.sig === c2.sig && c.ops === c2.ops, 'draw' + nm + ' deterministic at t=' + t.toFixed(1)); ok(c.depth === 0, 'draw' + nm + ' save/restore balanced at t=' + t.toFixed(1) + ' (' + c.depth + ')'); ok(c.oob === 0, 'draw' + nm + ' keeps every primitive inside its canvas at t=' + t.toFixed(1) + ' (' + c.oob + ' outside)'); sigs.push(c.sig); maxOps = Math.max(maxOps, c.ops); }
  ok(new Set(sigs).size > 30, 'draw' + nm + ' is animated (' + new Set(sigs).size + ' distinct frames of 40)');
  ok(maxOps < 900, 'draw' + nm + ' costs ' + maxOps + ' canvas ops per redraw (< 900)');
  // the film/game loop: A's movie region repeats every 15 s, B's pattern every 5*150/110 s
}
console.log(bad ? 'FAILED ' + bad + '/' + n : 'OK holo ' + n + ' checks (' + P.PANELS.length + ' panels, relay at ' + R.join(',') + ')');
process.exit(bad ? 1 : 0);
