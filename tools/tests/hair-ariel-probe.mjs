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
if (write) { const prev = fs.existsSync(GOLD) ? JSON.parse(fs.readFileSync(GOLD, 'utf8')) : {}; fs.writeFileSync(GOLD, JSON.stringify({ from: prev.from || 'origin/main 0aa5b76', tiers: prev.tiers || out, v385: { 1: out[1], 2: out[2] } }, null, 1) + '\n'); console.log('wrote', GOLD, JSON.stringify(out)); process.exit(0); }
const G = JSON.parse(fs.readFileSync(GOLD, 'utf8')).tiers;
ok(out[0] === G[0], 'ariel tier 0: ribbon hash equals main (' + out[0] + ' / ' + G[0] + ')');
{ // (v385, intentional) tiers 1 / 2 now run the closing head pass (and tier 2 the static ear sheet) for Ariel too: with params.headClose:false / dynStatic:false they must still equal main's tier 1 hash
  const S = await L.setup('ariel', mod, { params: { collisionTier: 1, headClose: false, dynStatic: false } }); L.play(S, L.CHARS.ariel.idle, 0);
  for (let i = 0; i < 90; i++) { S.mixer.update(1 / 60); S.root.updateMatrixWorld(true); S.H.update(1 / 60); }
  const h = hash(S.H.ribbonArrays.pos); ok(h === G[1], 'ariel tier 1 with headClose:false: ribbon hash equals main (' + h + ' / ' + G[1] + ')');
  const N = JSON.parse(fs.readFileSync(GOLD, 'utf8')).v385 || {}; ok(out[1] === N[1], 'ariel tier 1 (v385 golden, closing head pass): ' + out[1] + ' / ' + N[1]);
}
{ // the ONLY tier-2 difference is the refine: tier 2 with main's x2 field must hash like main's tier 2
  const S = await L.setup('ariel', mod, { sdfFine: 2, params: { collisionTier: 2, headClose: false, dynStatic: false } }); L.play(S, L.CHARS.ariel.idle, 0);
  for (let i = 0; i < 90; i++) { S.mixer.update(1 / 60); S.root.updateMatrixWorld(true); S.H.update(1 / 60); }
  const h = hash(S.H.ribbonArrays.pos); ok(h === G[2], 'ariel tier 2 with sdfFine 2 (main refine): ribbon hash equals main (' + h + ' / ' + G[2] + ')');
}
console.log('info ariel tier 2 ribbon hash ' + out[2] + ' (main ' + G[2] + '; expected to differ: x3 refine at tier 2)');
console.log(fails ? fails + ' FAILED' : 'ALL OK'); process.exit(fails ? 1 : 0);
