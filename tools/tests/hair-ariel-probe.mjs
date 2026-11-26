// (v379) Ariel real-GLB probe: the skin-following head field (WARP) is opt-in (params.skinWarp === true, Emma's config only), so Ariel's real
// Autumn GLB + groom builds none (stats.skinWarp == null) at every collision tier, and her ribbon hash after 90 animated CPU steps equals main's
// at tiers 0 and 1.  Tier 2 is EXPECTED to differ from main: the x3 head-SDF refine at tier 2 (approved by Justin 2026-11-24) changes the field.
// Golden hashes: tools/tests/fixtures/ariel-probe-golden.json (tiers 0/1 written from origin/main 0aa5b76 with --write-golden there).
// node tools/tests/hair-ariel-probe.mjs [--write-golden]
import fs from 'fs'; import path from 'path'; import crypto from 'crypto'; import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const L = await import(pathToFileURL(path.join(ROOT, 'tools/tests/lib-hair-probe.mjs')).href).catch((e) => { console.log('SKIP:', e.message); process.exit(0); });
const mod = await import(pathToFileURL(path.join(ROOT, 'hair_strands.js')).href);
const GOLD = path.join(ROOT, 'tools/tests/fixtures/ariel-probe-golden.json'), write = process.argv.includes('--write-golden');
const hash = (a) => crypto.createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex').slice(0, 16);
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
const out = {};
for (const tier of [0, 1, 2]) {
  const S = await L.setup('ariel', mod, { params: { collisionTier: tier } });
  L.play(S, L.CHARS.ariel.idle, 0);
  for (let i = 0; i < 90; i++) { S.mixer.update(1 / 60); S.root.updateMatrixWorld(true); S.H.update(1 / 60); }
  out[tier] = hash(S.H.ribbonArrays.pos);
  if (!write) ok(S.H.stats.skinWarp == null, 'ariel tier ' + tier + ': no skin-following field (stats.skinWarp ' + JSON.stringify(S.H.stats.skinWarp) + ')');
}
if (write) { const prev = fs.existsSync(GOLD) ? JSON.parse(fs.readFileSync(GOLD, 'utf8')) : {}; fs.writeFileSync(GOLD, JSON.stringify({ from: prev.from || 'origin/main 0aa5b76', tiers: prev.tiers || out, v385: { 0: out[0], 1: out[1], 2: out[2] } }, null, 1) + '\n'); console.log('wrote', GOLD, JSON.stringify(out)); process.exit(0); }
const J = JSON.parse(fs.readFileSync(GOLD, 'utf8')), G = J.tiers, N = J.v385 || {};
// (v385, intentional, approved by Justin 2026-11-25) Ariel now runs: the x3 (1.67 mm) head field at every tier, tipsCollide, maxStretch, the closing head pass (tiers 0-2), the tier 0 / 1 chord sample, the static ear sheets.
// Proof that NOTHING ELSE moved: with those switches off (and main's golden field refine 1 / 2 / 2) every tier hashes like main (tiers 0 / 1 / 2 from origin/main 0aa5b76).
const OFF = { tipsCollide: false, maxStretch: 0, headClose: false, midHead1: false, dynStatic: false };
for (const [t, f] of [[0, 1], [1, 2], [2, 2]]) {
  const S = await L.setup('ariel', mod, { sdfFine: f, params: Object.assign({ collisionTier: t }, OFF) }); L.play(S, L.CHARS.ariel.idle, 0);
  for (let i = 0; i < 90; i++) { S.mixer.update(1 / 60); S.root.updateMatrixWorld(true); S.H.update(1 / 60); }
  const h = hash(S.H.ribbonArrays.pos); ok(h === G[t], 'ariel tier ' + t + ' with the v385 switches off + main field (x' + f + '): ribbon hash equals main (' + h + ' / ' + G[t] + ')');
}
for (const t of [0, 1, 2]) ok(out[t] === N[t], 'ariel tier ' + t + ' v385 golden: ' + out[t] + ' / ' + N[t]);
console.log(fails ? fails + ' FAILED' : 'ALL OK'); process.exit(fails ? 1 : 0);
