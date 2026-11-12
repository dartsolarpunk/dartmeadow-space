#!/usr/bin/env node
/* Static shader / light budget check for the lighting overhaul (flashlight spot + shadow, daytime sun shadow, DMLight falloff, volumetric shafts).
 *
 *   node tools/tests/lighting-budget.js [--base origin/main] [--json]
 *
 * STATIC ONLY: it reads source text (no GPU, no frame times).  It can prove "this much is allocated / looped / flagged", never "this runs at 30 fps";
 * the phone numbers below are the BUDGET the code must stay inside, and the on-device run (docs/lighting-device-checklist.md) is the proof.
 *
 * Checks (FAIL = exit 1, WARN = printed, exit 0):
 *   1. light census    : SpotLight / Point / Directional constructions; shadow-casting spot lights <= 1.
 *   2. shadow maps     : literal shadow.mapSize.set(N,N) of a spot <= 1024; phone presets (low / medium) <= 1024; MiB per map (N*N*4 B).
 *   3. shader loops    : literal Loop(N,..) / step constants in job code vs phone cap (WARN) and hard ceiling (FAIL).
 *   4. uniforms        : scratch Float32Array bytes vs maxUniformBufferBindingSize (64 KiB); texture()/storage() site counts vs WebGPU per-stage defaults.
 *   5. GPU memory      : RenderTarget / DataTexture / Storage buffers with literal sizes, summed (MiB) vs MEM_BUDGET_MIB.
 *   6. per-frame alloc : allocations inside functions named tick/update/frame/render/onBefore* (WARN, heuristic).
 *   7. feature flags   : ?flashshadow ?sunshadow ?vlights ?light are each parsed in the sources (FAIL if not).
 *   8. dispose         : a job file that creates GPU objects has a dispose / remove path (FAIL if none).
 *   9. try/catch       : a job file touching renderer / node materials has a try block (WARN if not).
 *
 * "Job files" = ui/*.js, index.html, sw.js changed vs --base (default origin/main); the numbers for index.html count only the job's ADDED lines.
 * With no diff (e.g. run on main) it scans a fixed list in full, which is a baseline of the existing engine.
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const BASE = (argv.indexOf('--base') >= 0 ? argv[argv.indexOf('--base') + 1] : 'origin/main');
const AS_JSON = argv.includes('--json');

// phone budget (Mali-G615 tablet, iPhone 16e)
const B = {
  MAX_SHADOW_SPOTS: 1, MAX_SPOT_SHADOW_PX: 1024, MAX_PHONE_PRESET_SHADOW_PX: 1024,
  MAX_STEPS_PHONE: 24,            // ray-march / shaft steps per pixel on a phone tier
  MAX_STEPS_ANY: 64,              // hard ceiling even for desktop 'ultra'
  UNIFORM_BYTES: 65536,           // WebGPU default maxUniformBufferBindingSize
  SAMPLED_TEX_PER_STAGE: 16,      // WebGPU default maxSampledTexturesPerShaderStage
  STORAGE_BUF_PER_STAGE: 8,       // WebGPU default maxStorageBuffersPerShaderStage
  MEM_BUDGET_MIB: 24,             // new GPU memory the job may add (spot shadow map + shaft targets + data textures)
};
const FIXED = ['ui/dm-flash.js', 'ui/dm-vlight.js', 'ui/dm-light.js', 'ui/dm-atmo.js', 'ui/dm-mist.js', 'ui/dm-lamps.js', 'ui/dm-polish.js', 'index.html', 'sw.js'];
const FLAGS = [['flashshadow', 'flashlight shadow'], ['sunshadow', 'daytime sun shadow'], ['vlights', 'volumetric light shafts'], ['light', 'DMLight (off tier)'], ['lamplights', 'real lamp lights'], ['lampshadow', 'lamp light shadows'], ['lamptier', 'lamp tier override'], ['dusk', 'lamp dusk start']];

const out = { fail: [], warn: [], info: [], numbers: {} };
const FAIL = (m) => out.fail.push(m), WARN = (m) => out.warn.push(m), INFO = (m) => out.info.push(m);
const rd = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return null; } };
const sh = (c) => cp.execSync(c, { cwd: ROOT, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

let diffed = null;
try { diffed = sh('git diff --name-only ' + BASE + '...HEAD').split('\n').filter(Boolean).filter((f) => /^ui\/.*\.js$/.test(f) || f === 'index.html' || f === 'sw.js'); } catch (e) { diffed = null; }
const haveDiff = !!(diffed && diffed.length);
const files = (haveDiff ? diffed : FIXED).filter((f) => rd(f) != null);
out.numbers.jobFiles = files; out.numbers.diffAvailable = haveDiff;
if (!haveDiff) INFO('no diff vs ' + BASE + ': scanning the fixed file list in full (baseline of the existing engine, not just the job)');

function addedLines(f) { try { return sh('git diff -U0 ' + BASE + '...HEAD -- ' + f).split('\n').filter((l) => l[0] === '+' && l.slice(0, 3) !== '+++').map((l) => l.slice(1)).join('\n'); } catch (e) { return null; } }
const FULL = {}, CODE = {};
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
for (const f of files) { FULL[f] = rd(f); const a = haveDiff ? addedLines(f) : null; CODE[f] = strip(a != null ? a : FULL[f]); }

// 1. light census
{
  const c = { spot: 0, point: 0, dir: 0, hemi: 0, spotShadow: 0 }, per = {};
  for (const f of files) {
    const s = CODE[f], n = {
      spot: (s.match(/new\s+[\w.$]*SpotLight\s*\(/g) || []).length, point: (s.match(/new\s+(?:THREE\.)?PointLight\s*\(/g) || []).length,
      dir: (s.match(/new\s+(?:THREE\.)?DirectionalLight\s*\(/g) || []).length, hemi: (s.match(/new\s+(?:THREE\.)?HemisphereLight\s*\(/g) || []).length };
    if (n.spot + n.point + n.dir + n.hemi) per[f] = n;
    for (const k of Object.keys(n)) c[k] += n[k];
    const vars = []; s.replace(/([\w.$]+)\s*=\s*new\s+[\w.$]*SpotLight\s*\(/g, (m, v) => { vars.push(v); return m; });
    for (const v of vars) {
      const base = v.replace(/^this\./, '').replace(/^[\w$]+\./, '');
      const re = new RegExp('(?:^|[^\\w$])(?:[\\w$.]*\\.)?' + base.replace(/\$/g, '\\$') + '\\.castShadow\\s*=\\s*([^;\\n]+)', 'g');
      let m; while ((m = re.exec(s))) if (!/^\s*false\b/.test(m[1])) c.spotShadow++;
    }
  }
  out.numbers.lights = c; out.numbers.lightsPerFile = per;
  if (c.spotShadow > B.MAX_SHADOW_SPOTS) FAIL('light census: ' + c.spotShadow + ' shadow-casting SpotLight assignments (budget ' + B.MAX_SHADOW_SPOTS + ')');
  if (haveDiff && c.spot > 1) WARN('light census: ' + c.spot + ' new SpotLight constructions in the job (expected 1 flashlight; confirm only one is ever live)');
  INFO('lights constructed in scanned code: ' + c.spot + ' spot (' + c.spotShadow + ' shadow-casting), ' + c.point + ' point, ' + c.dir + ' directional, ' + c.hemi + ' hemisphere');
}

// 2. shadow maps
{
  let spotBytes = 0; const maps = [], tiered = new Set(files.filter((f) => /TIERS\s*=\s*\{[^;]*map:\s*\d+/.test(CODE[f] || '')));
  for (const f of files) {
    let m; const re = /([\w.$]*?)(?:shadow|sh)?\.?mapSize\.set\(\s*([^,)]+?)\s*,\s*([^)]+?)\s*\)/g;
    while ((m = re.exec(CODE[f]))) {
      const w = Number(m[2]), h = Number(m[3]), lit = Number.isFinite(w) && Number.isFinite(h);
      const isSpot = /fl|spot|torch|beam/i.test(m[1]) || /flash/i.test(f);
      maps.push({ file: f, owner: m[1] || '?', w: lit ? w : m[2], h: lit ? h : m[3], spot: isSpot });
      if (isSpot && lit) { spotBytes += w * h * 4; if (w > B.MAX_SPOT_SHADOW_PX || h > B.MAX_SPOT_SHADOW_PX) FAIL(f + ': spot shadow map ' + w + 'x' + h + ' > ' + B.MAX_SPOT_SHADOW_PX + ' on phones'); }
      else if (isSpot && tiered.has(f)) { /* size comes from the file's TIERS table, checked below */ }
      else if (isSpot) { spotBytes += 1024 * 1024 * 4; WARN(f + ': spot shadow mapSize not a literal (' + m[2] + '); counted as 1024^2; verify it is clamped <= ' + B.MAX_SPOT_SHADOW_PX + ' on phones'); }
    }
  }
  // tier tables  TIERS = { low: { map: N, .. }, phone: { map: N, ..}, desktop: {..} }  (flashlight shadow map per device class)
  for (const f of files) {
    const m = /TIERS\s*=\s*\{([^;]*)\};/.exec(CODE[f] || ''); if (!m) continue; const t = {}; m[1].replace(/(\w+):\s*\{[^}]*?map:\s*(\d+)/g, (x, k, v) => { t[k] = +v; return x; });
    if (Object.keys(t).length) { out.numbers.tierMaps = t; INFO(f + ' shadow-map tiers: ' + JSON.stringify(t) + ' (phone MiB ' + ((t.phone || 0) ** 2 * 4 / 1048576).toFixed(1) + ')'); spotBytes += (t.phone || 1024) ** 2 * 4; for (const k of ['low', 'phone']) if (t[k] > B.MAX_SPOT_SHADOW_PX) FAIL(f + ': tier ' + k + ' spot shadow map ' + t[k] + ' > ' + B.MAX_SPOT_SHADOW_PX); }
  }
  const idx = rd('index.html') || '', pre = {};
  idx.replace(/^\s*(low|medium|high|ultra):\s*\{[^}]*?shadowSize:\s*(\d+)/gm, (m, k, v) => { pre[k] = +v; return m; });
  out.numbers.presetShadowSize = pre;
  for (const k of ['low', 'medium']) if (pre[k] > B.MAX_PHONE_PRESET_SHADOW_PX) FAIL('graphics preset ' + k + ' shadowSize ' + pre[k] + ' > ' + B.MAX_PHONE_PRESET_SHADOW_PX);
  const sunMiB = (pre.medium || 1024) ** 2 * 4 / 1048576;
  out.numbers.shadowMaps = maps; out.numbers.spotShadowMiB = +(spotBytes / 1048576).toFixed(2); out.numbers.sunShadowMiBMedium = +sunMiB.toFixed(2); out._shadowBytes = spotBytes;
  INFO('shadow maps set in scanned code: ' + (maps.length ? maps.map((x) => x.file + ' ' + x.owner + ' ' + x.w + 'x' + x.h).join('; ') : 'none') + '; existing sun map at medium preset ' + sunMiB.toFixed(1) + ' MiB; spot maps ' + (spotBytes / 1048576).toFixed(1) + ' MiB');
}

// 3. shader loops
{
  const loops = []; let maxLit = 0;
  for (const f of files) {
    const s = CODE[f]; let m;
    const re = /\bLoop\(\s*([^,({]+?)\s*,/g; while ((m = re.exec(s))) loops.push({ file: f, kind: 'Loop', bound: m[1].trim(), n: Number(m[1]) });
    const re2 = /\bLoop\(\s*\{[^}]*?end\s*:\s*([^,}]+?)\s*[,}]/g; while ((m = re2.exec(s))) loops.push({ file: f, kind: 'Loop{end}', bound: m[1].trim(), n: Number(m[1]) });
    const re3 = /(?:const|let|var)\s+([A-Z_]*(?:STEP|SAMPLE|TAP|MARCH|RAYS)[A-Z_]*)\s*=\s*(\d+)\b/g; while ((m = re3.exec(s))) loops.push({ file: f, kind: m[1], bound: m[2], n: Number(m[2]) });
  }
  out.numbers.loops = loops;
  for (const l of loops) {
    if (Number.isFinite(l.n)) {
      maxLit = Math.max(maxLit, l.n);
      if (l.n > B.MAX_STEPS_ANY) FAIL(l.file + ': ' + l.kind + ' ' + l.bound + ' > hard ceiling ' + B.MAX_STEPS_ANY);
      else if (l.n > B.MAX_STEPS_PHONE) WARN(l.file + ': ' + l.kind + ' ' + l.bound + ' > phone cap ' + B.MAX_STEPS_PHONE + ' - must be a runtime/tier bound for phones');
    } else INFO(l.file + ': ' + l.kind + ' bound not literal (' + l.bound + ') - confirm max <= ' + B.MAX_STEPS_PHONE + ' on phone tiers');
  }
  INFO('shader loops/step constants found: ' + loops.length + ', largest literal ' + maxLit);
}

// 4. uniforms / bindings
{
  let worst = 0;
  for (const f of files) {
    const s = CODE[f]; let m; const re = /new\s+Float32Array\(\s*(\d+)\s*\)/g;
    while ((m = re.exec(s))) worst = Math.max(worst, +m[1] * 4);
    const nTex = (s.match(/\btexture(?:Load|Store)?\s*\(/g) || []).length, nStor = (s.match(/\b(?:storage|instancedArray|attributeArray)\s*\(/g) || []).length;
    if (haveDiff && nTex > B.SAMPLED_TEX_PER_STAGE) WARN(f + ': ' + nTex + ' texture() sites in job code - one material must sample <= ' + B.SAMPLED_TEX_PER_STAGE + ' (WebGPU default per-stage limit)');
    if (haveDiff && nStor > B.STORAGE_BUF_PER_STAGE) WARN(f + ': ' + nStor + ' storage-buffer sites in job code (limit ' + B.STORAGE_BUF_PER_STAGE + ' per stage)');
  }
  out.numbers.maxScratchBytes = worst;
  if (worst > B.UNIFORM_BYTES) FAIL('a Float32Array of ' + worst + ' bytes exceeds the uniform buffer limit ' + B.UNIFORM_BYTES);
  INFO('largest literal Float32Array scratch ' + worst + ' B (uniform limit ' + B.UNIFORM_BYTES + ' B)');
}

// 5. GPU memory
{
  let bytes = 0; const items = [];
  for (const f of files) {
    const s = CODE[f]; let m;
    const re = /new\s+(?:THREE\.)?(RenderTarget|WebGLRenderTarget|DataTexture|StorageTexture|Data3DTexture|DataArrayTexture)\s*\(\s*(?:new\s+\w+Array\([^)]*\)\s*,\s*)?(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?/g;
    while ((m = re.exec(s))) { const b = +m[2] * +m[3] * (m[4] ? +m[4] : 1) * 8; bytes += b; items.push(f + ' ' + m[1] + ' ' + m[2] + 'x' + m[3] + (m[4] ? 'x' + m[4] : '') + ' <=' + (b / 1048576).toFixed(2) + ' MiB'); }
    const re2 = /new\s+(?:THREE\.)?Storage(?:Instanced)?BufferAttribute\(\s*(?:new\s+\w+Array\(\s*)?(\d+)\s*,\s*(\d+)/g;
    while ((m = re2.exec(s))) { const b = +m[1] * +m[2] * 4; bytes += b; items.push(f + ' storage ' + m[1] + 'x' + m[2] + ' ' + (b / 1048576).toFixed(2) + ' MiB'); }
    const dyn = (s.match(/new\s+(?:THREE\.)?(?:RenderTarget|WebGLRenderTarget)\s*\(\s*[A-Za-z_(]/g) || []).length;
    if (dyn) INFO(f + ': ' + dyn + ' RenderTarget(s) with a computed size - cannot sum statically; check the scale (shafts <= 1/2 res on phones) on device');
  }
  const total = bytes + (out._shadowBytes || 0);
  out.numbers.gpuItems = items; out.numbers.gpuMiBLiteral = +(total / 1048576).toFixed(2);
  if (total / 1048576 > B.MEM_BUDGET_MIB) FAIL('literal-size GPU memory ' + (total / 1048576).toFixed(1) + ' MiB > ' + B.MEM_BUDGET_MIB + ' MiB budget');
  INFO('literal-size GPU memory (upper bounds, RGBA16F assumed) ' + (total / 1048576).toFixed(2) + ' of ' + B.MEM_BUDGET_MIB + ' MiB over ' + items.length + ' resources + spot shadow maps');
}

// 6. per-frame allocation (heuristic)
{
  const hot = /^\s*(?:(?:async\s+)?function\s+(tick\w*|update\w*|frame\w*|onBefore\w*)\s*\(|(?:const|let|var)\s+(tick\w*|update\w*|frame\w*|onBefore\w*)\s*=\s*(?:function|\([^)]*\)\s*=>)|(tick|update|frame|onBeforeRender)\s*(?::\s*function\s*)?\()/;
  const bad = /new\s+(?:THREE\.)?(?:Vector[234]|Matrix[34]|Quaternion|Euler|Color|Box3|Sphere|Ray|Plane|Float32Array|Uint8Array|Uint16Array|Array|Map|Set)\s*\(|\.clone\(\)|\.map\(|\.filter\(|\.slice\(|=\s*\[[^\]]+\]\s*[;,]|=\s*\{[^}]+\}\s*;/;
  const lazy = /\|\|\s*\(?\s*[\w.$]+\s*=\s*new|\bif\s*\(\s*!\s*[\w.$]+\s*\)\s*[\w.$]+\s*=|\|\|=|\?\?=|=\s*[\w.$]+\s*\|\|\s*new|[\w.$]+\s*=\s*[\w.$]+\s*\|\|\s*\(/;
  let total = 0; const hits = [];
  for (const f of files) {
    const lines = CODE[f].split('\n'); let depth = 0, inHot = false, hotDepth = 0, name = '';
    for (const L of lines) {
      if (!inHot) { const m = hot.exec(L); if (m) { inHot = true; name = m[1] || m[2] || m[3]; hotDepth = depth; } }
      else if (bad.test(L) && !lazy.test(L)) { total++; if (hits.length < 40) hits.push(f + ' (' + name + '): ' + L.trim().slice(0, 110)); }
      for (const ch of L) { if (ch === '{') depth++; else if (ch === '}') { depth--; if (inHot && depth <= hotDepth) inHot = false; } }
    }
  }
  out.numbers.perFrameAllocCandidates = total; out.numbers.perFrameAllocSample = hits;
  if (total) WARN('possible per-frame allocation, ' + total + ' site(s) (heuristic, hot functions only):\n      ' + hits.join('\n      '));
  else INFO('per-frame allocation: no candidates in tick/update/frame functions of scanned code');
}

// 7. flags
{
  const all = Object.keys(FULL).map((f) => FULL[f]).join('\n');
  for (const [flag, what] of FLAGS) {
    const found = new RegExp('(?:[?&]|\\\\\\?|\\[\\?&\\])\\(?' + flag + '\\b|[?&]' + flag + '=|[\'"`]' + flag + '[\'"`]').test(all);
    out.numbers['flag_' + flag] = found;
    if (!found) FAIL('feature flag ?' + flag + ' (' + what + ') is not parsed in the scanned files');
  }
}

// 8. dispose
{
  for (const f of files) {
    if (f === 'index.html' || f === 'sw.js') continue;
    const s = CODE[f];
    const makes = (s.match(/new\s+(?:THREE\.)?(?:RenderTarget|WebGLRenderTarget|DataTexture|StorageTexture|CanvasTexture|\w+Geometry|\w+Material|SpotLight|PointLight)\s*\(/g) || []).length;
    const disposes = (s.match(/\.dispose\s*\(|\bdispose\s*[:(=]|\bteardown\b|\bdestroy\b|\.removeFromParent\(\)|\.remove\(/g) || []).length;
    if (makes && !disposes) FAIL(f + ': creates ' + makes + ' GPU object(s) but has no dispose / remove path');
    else if (makes) INFO(f + ': ' + makes + ' GPU object constructions vs ' + disposes + ' dispose/remove calls (correctness: tools/tests/lighting-robust.py)');
  }
}

// 9. try/catch
{
  for (const f of files) {
    if (f === 'index.html' || f === 'sw.js') continue;
    const s = CODE[f];
    if (/renderer|getContext|requestAdapter|\.limits\b|compileAsync|NodeMaterial/.test(s) && !/\btry\s*\{/.test(s)) WARN(f + ': touches renderer / node materials but has no try block');
  }
}

// 10. real lamp lights (ui/dm-lamps.js LAMP_LEVELS: n lights, sh shadow-casting, map = side of ONE face; a point light's depth atlas is 4 x 2 faces)
{
  const f = 'ui/dm-lamps.js', s = rd(f);
  const m = s && /LAMP_LEVELS\s*=\s*\{([^;]*)\};/.exec(s);
  if (!m) FAIL(f + ': LAMP_LEVELS table not found');
  else {
    const T = {}; m[1].replace(/(\w+):\s*\{\s*n:\s*(\d+),\s*sh:\s*(\d+),\s*map:\s*(\d+),\s*every:\s*(\d+)/g, (x, k, n, sh, map, every) => { T[k] = { n: +n, sh: +sh, map: +map, every: +every }; return x; });
    out.numbers.lampLevels = T;
    const mib = (t) => t.sh * (t.map * 4) * (t.map * 2) * 4 / 1048576;
    for (const k of Object.keys(T)) { const t = T[k]; t.MiB = +mib(t).toFixed(1); t.texSlots = t.sh;   // each shadow-casting lamp = +1 depth texture (+ sampler) in every shadow-RECEIVING lit material
      if (t.sh > t.n) FAIL('lamp tier ' + k + ': ' + t.sh + ' shadow-casting of only ' + t.n + ' lights');
      if (t.sh && (t.map < 256 || t.map > 1024)) FAIL('lamp tier ' + k + ': shadow face ' + t.map + ' px outside 256..1024 (atlas ' + t.map * 4 + 'x' + t.map * 2 + ', limit 8192)'); }
    // phones/tablets never go above DMLight tier 'med' (ui/dm-light.js PRESET_CAP.mob): that is the tier a phone can reach
    if (T.med) { if (T.med.sh > 1) FAIL('lamp tier med (the phone ceiling) has ' + T.med.sh + ' shadow-casting lamps (budget 1)'); if (T.med.MiB > 8.5) FAIL('lamp tier med (phone) shadow memory ' + T.med.MiB + ' MiB > 8.5'); if (T.med.every < 2) FAIL('lamp tier med refreshes its shadow every frame (phones: >= every 2nd)'); }
    for (const k of ['low', 'off']) if (T[k] && (T[k].n || T[k].sh)) FAIL('lamp tier ' + k + ' has real lights (low/off = probe lighting only)');
    if (T.high && T.med && (T.high.sh < T.med.sh || T.high.n < T.med.n)) FAIL('lamp tiers are not monotone med -> high');
    if (T.ultra && T.high && (T.ultra.sh < T.high.sh || T.ultra.map < T.high.map)) FAIL('lamp tiers are not monotone high -> ultra');
    // texture slots: the sun map + the flashlight map are already bound by every shadow receiver; lamps come on top
    const worst = Math.max.apply(null, Object.keys(T).map((k) => T[k].sh)) + 2;
    if (worst > 6) WARN('shadow depth textures on a fully-loaded receiver: sun + flash + ' + (worst - 2) + ' lamps = ' + worst + ' of ' + B.SAMPLED_TEX_PER_STAGE + ' sampled textures per stage; the terrain ground material is the one at risk (kill switch ?lampshadow=0)');
    INFO('lamp lights per tier: ' + Object.keys(T).map((k) => k + ' ' + T[k].n + '/' + T[k].sh + 'sh@' + T[k].map + ' ' + T[k].MiB + 'MiB').join(', ') + '; sun + flash + lamp shadow textures on a receiver: ' + Object.keys(T).map((k) => k + ' ' + (2 + T[k].sh)).join(', '));
    // never any castShadow outside the tier plan / without a cast gate
    if (!/L\.castShadow\s*=\s*i\s*<\s*plan\.sh\s*&&/.test(s)) FAIL(f + ': lamp lights must take castShadow from the tier plan (i < plan.sh && shadows enabled)');
    if (!/autoUpdate\s*=\s*false/.test(s)) FAIL(f + ': lamp shadow maps must not auto-update every frame (cadence)');
    if (/\bL\.castShadow\s*=\s*(?:true\b|!?\s*DMBudget)/.test(s.replace(/\/\/[^\n]*/g, ''))) WARN(f + ': a castShadow toggle at runtime would recompile every lit material');
  }
}

delete out._shadowBytes;
if (AS_JSON) console.log(JSON.stringify(out, null, 1));
else {
  console.log('lighting-budget (scanned: ' + files.join(', ') + (haveDiff ? '; job diff vs ' + BASE : '; full files, no diff') + ')');
  for (const l of out.info) console.log('  info  ' + l);
  for (const l of out.warn) console.log('  WARN  ' + l);
  for (const l of out.fail) console.log('  FAIL  ' + l);
  console.log(out.fail.length ? 'lighting-budget: ' + out.fail.length + ' FAIL, ' + out.warn.length + ' warn' : 'lighting-budget: ok (' + out.warn.length + ' warn) - STATIC ONLY, not a frame-time measurement');
}
process.exit(out.fail.length ? 1 : 0);
