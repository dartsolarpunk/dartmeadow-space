// node tools/tests/mansion-holo.js : the holographic panels of the game lounge stand in clear room space (pure part of ui/dm-holo.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const sb = { console, Math, Float32Array }; sb.window = sb; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'ui/dm-holo.js'), 'utf8'), sb);
const P = sb.DMHolo._pure; let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log('FAIL', m); } };
P.PANELS.forEach((p, i) => {
  const q = P.panelQuad(p); ok(q.length === 4, 'quad ' + i);
  for (const v of q) { ok(P.inRoom(v[0], -v[2]), 'panel ' + i + ' corner inside the game lounge ' + v); ok(-v[2] < 35.2, 'panel ' + i + ' stays in front of the media console (y < 35.2)'); }
  ok(p[3] >= 2.2, 'panel ' + i + ' hovers above the table / furniture');
  P.PANELS.forEach((o, j) => { if (j > i) { const a = P.panelQuad(p), b = P.panelQuad(o); const ax = [Math.min(...a.map(v => v[0])), Math.max(...a.map(v => v[0]))], bx = [Math.min(...b.map(v => v[0])), Math.max(...b.map(v => v[0]))]; ok(ax[1] <= bx[0] + 0.01 || bx[1] <= ax[0] + 0.01 || Math.abs(a[0][2] - b[0][2]) > 4, 'panels ' + i + '/' + j + ' do not overlap'); } });
});
ok(P.inRoom(P.RELAY[0] - 2.2, P.RELAY[1]) && P.inRoom(P.RELAY[0] + 2.2, P.RELAY[1]), 'relay tower inside the room');
console.log(bad ? 'FAILED ' + bad : 'OK holo ' + P.PANELS.length + ' panels');
process.exit(bad ? 1 : 0);
