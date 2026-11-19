/* ============================================================================
   ui/dm-charlook.js - the CHARACTER LOOK: one small module that makes a loaded character (Ariel, Emma, any registry pilot) read like the Nomad Sculpt render of
   it - smooth, soft, warm-key / cool-rim, with soft sky light and soft specular - in the game AND in the character-select studio.  No raymarching, no new draw
   calls, no new render passes, no new lights (the scene's light list never changes, so nothing recompiles when the look is switched on).

   What it does (all at load, once, budgeted; per-frame work is a handful of uniform writes at 4 Hz):
     1. smooth vertex normals: normals that were split at UV seams / hard-edge joins of a soft surface are re-averaged over co-located vertices (angle-limited, so a
        belt buckle or a box keeps its edge).  Geometry attribute is replaced in place: skinning and morph targets are not touched (a mesh with morph normals is skipped).
     2. materials -> one node twin per material (MeshStandardNodeMaterial, or the Physical one only where the GLB really carries clearcoat: the eyes) with PBR values
        by kind (skin / cloth / eye / hair / metal), and ONE emissiveNode that adds the whole look in a single pass of the fragment shader:
          - soft sky + ground light (an ANALYTIC gradient environment: no cube map, no PMREM, no texture lookup; PMREMGenerator is known broken on this build's WebGPU
            backend, see index.html buildEnvMap) as diffuse light (x albedo x AO) and as a Fresnel-weighted soft specular reflection,
          - rim: a Fresnel edge in the sun's direction (warm) and a cool sky fill on the shadow side,
          - 'high' tier, skin only: a cheap wrap-diffuse / fake subsurface term (the lit terminator is softened and warmed, red-shifted).
     3. textures: anisotropic filtering 4 (low) / 8 (high) and mipmaps on every colour / ORM / normal map; normal maps and occlusion maps are kept as the GLB has them
        (the GLTFLoader already sets the tangent-space + flipY convention; AO comes through materialAO).
     4. the env follows the scene: sun direction + colour, sky / ground colours and day-night are read from the scene's own lights (4 Hz) and eased.  The studio
        has its own env + rig (rigStudio: warm key, cool rim, fill - the same colours the env uses).
   Tiers (DMCharLook.tier()): 'off' | 'low' (smooth normals + sky env + rim) | 'high' (+ wrap / fake SSS on skin, anisotropy 8, shadow normal bias).
     ?charlook=off|low|high URL switch (wins), dm_charlook in localStorage (Profile > Admin), else Auto: the graphics preset (high / ultra and no budget pressure -> high, else low).
   Pure parts (tier choice, normal smoothing, env derivation, material classification) are exported for node tests: tools/tests/charlook-unit.js.
   ========================================================================== */
(function (root, factory) {
  const core = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = core.api;
  else root.DMCharLook = core.api;
})(typeof window !== 'undefined' ? window : this, function (W) {
  'use strict';
  const LS = 'dm_charlook', TIERS = ['off', 'low', 'high'];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ───────── pure: tier ───────── */
  const norm = (s) => { s = String(s == null ? '' : s).toLowerCase(); return s === '0' || s === 'false' || s === 'no' ? 'off' : s === '1' || s === 'true' ? 'low' : TIERS.indexOf(s) >= 0 ? s : null; };
  // search: location.search; stored: localStorage value ('auto' / '' = none); preset: GFX preset ('low'|'medium'|'high'|'ultra'|'custom'); pressure: DMBudget pressure (0 = none)
  function pickTier(o) {
    o = o || {}; const m = /[?&]charlook=([^&#]*)/.exec(o.search || ''), q = m ? norm(decodeURIComponent(m[1])) : null; if (q) return q;
    const st = norm(o.stored); if (st) return st;
    const p = String(o.preset || '').toLowerCase(), press = o.pressure | 0;
    if ((p === 'high' || p === 'ultra') && press < 6 && !o.legacy) return 'high';
    return 'low';
  }

  /* ───────── pure: normal smoothing ─────────
     pos, nrm: Float32Array xyz per vertex (bind pose).  Vertices that share a position (to eps) form a group; each vertex's new normal is the normalised sum of the group's
     normals that lie within `angleDeg` of its own (so a hard edge survives).  Returns { nrm: Float32Array|null, groups, changed }: null when nothing needed to change. */
  function smoothNormals(pos, nrm, opts) {
    opts = opts || {}; const n = (pos.length / 3) | 0, cosT = Math.cos((opts.angleDeg == null ? 62 : opts.angleDeg) * Math.PI / 180);
    if (!n || !nrm || nrm.length < n * 3) return { nrm: null, groups: 0, changed: 0 };
    let mnx = 1e30, mny = 1e30, mnz = 1e30, mxx = -1e30, mxy = -1e30, mxz = -1e30;
    for (let i = 0; i < n; i++) { const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z; }
    const ext = Math.max(mxx - mnx, mxy - mny, mxz - mnz, 1e-9), inv = 1 / (opts.eps == null ? ext * 1e-5 : opts.eps), buckets = new Map(), qx = new Int32Array(n), qy = new Int32Array(n), qz = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      qx[i] = Math.round(pos[i * 3] * inv); qy[i] = Math.round(pos[i * 3 + 1] * inv); qz[i] = Math.round(pos[i * 3 + 2] * inv);
      const h = ((qx[i] * 73856093) ^ (qy[i] * 19349663) ^ (qz[i] * 83492791)) | 0, b = buckets.get(h); if (b) b.push(i); else buckets.set(h, [i]);
    }
    let out = null, groups = 0, changed = 0;
    for (const b of buckets.values()) {
      if (b.length < 2) continue;
      // one bucket can hold several distinct quantised positions (hash collision): split by exact key
      const sub = b.length === 2 || (qx[b[0]] === qx[b[1]] && qy[b[0]] === qy[b[1]] && qz[b[0]] === qz[b[1]] && b.every((i) => qx[i] === qx[b[0]] && qy[i] === qy[b[0]] && qz[i] === qz[b[0]])) ? [b] : splitExact(b, qx, qy, qz);
      for (const g of sub) {
        if (g.length < 2) continue; groups++;
        for (let a = 0; a < g.length; a++) {
          const i = g[a], ix = nrm[i * 3], iy = nrm[i * 3 + 1], iz = nrm[i * 3 + 2]; let sx = 0, sy = 0, sz = 0;
          for (let c = 0; c < g.length; c++) { const j = g[c], jx = nrm[j * 3], jy = nrm[j * 3 + 1], jz = nrm[j * 3 + 2]; if (ix * jx + iy * jy + iz * jz >= cosT) { sx += jx; sy += jy; sz += jz; } }
          const l = Math.hypot(sx, sy, sz); if (l < 1e-9) continue; sx /= l; sy /= l; sz /= l;
          if (Math.abs(sx - ix) + Math.abs(sy - iy) + Math.abs(sz - iz) < 1e-4) continue;
          if (!out) out = Float32Array.from(nrm.subarray ? nrm.subarray(0, n * 3) : nrm); out[i * 3] = sx; out[i * 3 + 1] = sy; out[i * 3 + 2] = sz; changed++;
        }
      }
    }
    return { nrm: out, groups, changed };
  }
  function splitExact(b, qx, qy, qz) { const m = new Map(); for (const i of b) { const k = qx[i] + ',' + qy[i] + ',' + qz[i], a = m.get(k); if (a) a.push(i); else m.set(k, [i]); } return [...m.values()]; }
  // how split a mesh's normals are: fraction of co-located vertex pairs whose normals differ by more than `deg` (the seam metric tools/tests/charlook-unit.js reports on the real GLBs)
  function seamStats(pos, nrm, deg) {
    const r = smoothNormals(pos, nrm, { angleDeg: 180 }); if (!r.nrm) return { groups: r.groups, split: 0, maxDeg: 0 };
    const n = (pos.length / 3) | 0; let split = 0, maxDeg = 0; const c = Math.cos((deg == null ? 2 : deg) * Math.PI / 180);
    for (let i = 0; i < n; i++) { const d = nrm[i * 3] * r.nrm[i * 3] + nrm[i * 3 + 1] * r.nrm[i * 3 + 1] + nrm[i * 3 + 2] * r.nrm[i * 3 + 2]; if (d < c) split++; maxDeg = Math.max(maxDeg, Math.acos(clamp(d, -1, 1)) * 180 / Math.PI); }
    return { groups: r.groups, split, maxDeg };
  }

  /* ───────── pure: env colours from the scene's lights ─────────
     src: { sun:{dir:[x,y,z] toward the sun, color:[r,g,b] linear, intensity}|null, hemi:{sky,ground,intensity}|null, amb:{color,intensity}|null, moon:{color,intensity}|null, day:0..1 }
     -> { dir, key, rim, fill, skyTop, skyHor, ground, lit }  (colours in LIGHT UNITS: colour x intensity, what the scene's own lights add, so the look is exactly as bright as the scene) */
  const mul3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k], add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const lum3 = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  function deriveEnv(src) {
    src = src || {}; const day = src.day == null ? 1 : clamp(src.day, 0, 1), sun = src.sun, hemi = src.hemi, amb = src.amb, moon = src.moon;
    let dir = sun && sun.dir ? sun.dir.slice() : [0.5, 0.75, 0.25]; const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1; dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    const sc = sun && sun.color ? sun.color : [1, 0.95, 0.86], si = sun ? (sun.intensity == null ? 1 : sun.intensity) : 0;
    // the key keeps its own warmth; a low sun reddens it a little more (elevation dir[1])
    const warm = clamp(1 - dir[1] * 1.6, 0, 1), key = mul3(mix3(sc, [1.0, 0.62, 0.38], warm * 0.45), si * day);
    const hs = hemi && hemi.sky ? hemi.sky : [0.55, 0.62, 0.85], hg = hemi && hemi.ground ? hemi.ground : [0.2, 0.15, 0.12], hi = hemi ? (hemi.intensity == null ? 1 : hemi.intensity) : 0.5;
    const ac = amb && amb.color ? amb.color : [0.05, 0.06, 0.1], ai = amb ? (amb.intensity == null ? 0 : amb.intensity) : 0.2;
    const moonK = moon ? lum3(moon.color || [1, 1, 1]) * (moon.intensity || 0) : 0;
    // sky: the hemisphere sky colour + ambient, with a cool floor so shade never goes neutral grey; zenith deeper than the horizon, the horizon warmed by the sun
    let top = add3(mul3(hs, hi), mul3(ac, ai)); top = add3(top, mul3([0.55, 0.7, 1.0], moonK * 0.4));
    const ambFloor = Math.max(0.02, lum3(top)); top = mix3(top, mul3([0.55, 0.68, 1.0], ambFloor), 0.25);
    const hor = add3(mix3(top, mul3([1.0, 0.78, 0.58], Math.max(0.05, lum3(top))), 0.28 * warm + 0.12), mul3(sc, si * 0.04 * day));
    const ground = add3(mul3(hg, hi), mul3(ac, ai * 0.4));
    // the shadow-side fill: cool, from the sky; the rim: the key's own colour (the sun reaching round the edge), both softened at night
    const fill = mul3(mix3(top, [0.5, 0.65, 1.0], 0.5), 0.9), rim = mul3(mix3(key, [1, 0.9, 0.78], 0.3), 1);
    return { dir, key, rim, fill, skyTop: top, skyHor: hor, ground, lit: clamp(lum3(key) / 1.2 + lum3(top) / 0.6, 0, 1) };
  }
  // the studio's fixed rig (key warm from the upper front-left, rim cool from behind, warm bounce from below): the same numbers rigStudio puts on its three lights and the studio env reads
  const STUDIO = { dir: [-0.5, 0.7, 0.62], key: [2.6, 2.18, 1.72], rim: [0.8, 1.05, 1.9], rimDir: [0.78, 0.45, -0.7], fill: [0.5, 0.3, 0.22], skyTop: [0.5, 0.56, 0.84], skyHor: [0.62, 0.58, 0.66], ground: [0.55, 0.3, 0.18] };   // a soft warm-key studio: big key upper front-left, cool rim behind-right, warm bounce from below

  /* ───────── pure: what kind of material is it ─────────
     p: { name, meshName, metalness, roughness, hasMap, hasOrm, vertexColors, clearcoat, sheen:[r,g,b]|null, transparent, opacity, emissiveLum, isHair }  -> 'skin'|'cloth'|'eye'|'glass'|'hair'|'metal'|'other' */
  function classify(p) {
    const nm = (String(p.name || '') + ' ' + String(p.meshName || '')).toLowerCase();
    if (p.isHair || /hair|strand/.test(nm)) return 'hair';
    if (/brow|lash/.test(nm)) return 'hair';
    if (p.transparent && (p.opacity == null || p.opacity < 0.6)) return 'glass';
    if (/cornea|lens|glass(?!es)/.test(nm)) return 'glass';
    if ((p.clearcoat || 0) > 0.5 || /(^|[^a-z])eye(?!lash|brow)/.test(nm) && p.hasMap) return 'eye';
    if (/teeth|tooth/.test(nm)) return 'other';
    if (/skin|body|face|scalp|head/.test(nm)) return 'skin';
    // the sheen the Meshy / Emma skins carry in the GLB (warm rose sheen colour) marks a skin
    if (p.sheen && p.sheen[0] > 0.6 && p.sheen[1] > 0.3 && p.sheen[1] < 0.8 && p.sheen[2] < 0.6 && (p.metalness || 0) < 0.2) return 'skin';
    if (/shirt|pants|cloth|fabric|jacket|trouser|shorts|jeans|hoodie|dress|belt/.test(nm)) return /belt/.test(nm) ? 'other' : 'cloth';
    if ((p.metalness || 0) >= 0.4) return 'metal';
    return 'other';
  }
  // PBR targets by kind and tier: min / max clamps for roughness (a GLB value outside is pulled in; a roughness MAP is kept and only offset), specular intensity, rim / wrap strength
  function kindParams(kind, tier) {
    const hi = tier === 'high';
    switch (kind) {
      case 'skin':  return { rMin: 0.5, rMax: 0.62, f0: 0.028, spec: 1.0, rim: 1.0, fuzz: 0.5, wrap: hi ? 1 : 0, amb: 1.0 };
      case 'cloth': return { rMin: 0.62, rMax: 0.92, f0: 0.04, spec: 0.55, rim: 0.7, fuzz: 1.0, wrap: 0, amb: 1.0 };
      case 'eye':   return { rMin: 0.0, rMax: 0.35, f0: 0.04, spec: 1.6, rim: 0.2, fuzz: 0, wrap: 0, amb: 0.8 };
      case 'metal': return { rMin: 0.25, rMax: 0.7, f0: 0.04, spec: 1.0, rim: 0.4, fuzz: 0, wrap: 0, amb: 0.8 };
      case 'hair':  return { rMin: 0, rMax: 1, f0: 0.04, spec: 0, rim: 0, fuzz: 0, wrap: 0, amb: 0 };   // hair untouched
      case 'glass': return { rMin: 0, rMax: 1, f0: 0.04, spec: 0, rim: 0, fuzz: 0, wrap: 0, amb: 0 };
      default:      return { rMin: 0.35, rMax: 0.9, f0: 0.04, spec: 0.8, rim: 0.5, fuzz: 0.3, wrap: 0, amb: 1.0 };
    }
  }
  const ANISO = { off: 1, low: 4, high: 8 };


  /* ───────── pure: env source choice + matcap ─────────
     envKind: 'analytic' (default: gradient sky + two soft boxes, no texture) | 'matcap' (a 128 px view-space matcap only: one blurred + one glossy lookup, the cheap mobile alternative)
     | 'both' (analytic + the matcap at a low weight).  ?charenv=... wins, then dm_charenv in localStorage.  The matcap is generated here, procedurally (no image file, no network, no third-party asset). */
  function pickEnvKind(o) { o = o || {}; const m = /[?&]charenv=([a-z]+)/.exec(o.search || ''); const v = m ? m[1] : String(o.stored || ''); return v === 'matcap' || v === 'both' || v === 'analytic' ? v : 'analytic'; }
  const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v), sstep = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  // radiance (light units) of the matcap ball at view-space normal n (z toward the viewer).  P: { key, rim, bounce, top, hor, ground } rgb arrays.  Soft warm key upper front-left, cool rim round the
  // edge (strongest top-right / behind), warm bounce from below, sky gradient between.
  function matcapPixel(nx, ny, nz, P, out) {
    out = out || [0, 0, 0]; const kd = [-0.42, 0.55, 0.72], kl = Math.hypot(kd[0], kd[1], kd[2]), kdot = sat((nx * kd[0] + ny * kd[1] + nz * kd[2]) / kl);
    const up = sstep(-0.35, 0.45, ny), edge = Math.pow(1 - sat(nz), 2.2), rimSide = sat(0.55 + nx * 0.45 + ny * 0.25), low = sat(-ny * 1.2) * sat(0.4 + nz);
    for (let c = 0; c < 3; c++) {
      const sky = lerp(P.hor[c], P.top[c], sat(ny)), base = lerp(P.ground[c], sky, up);
      out[c] = base * 0.85 + P.key[c] * 0.3 * Math.pow(kdot, 1.6) + P.key[c] * 0.08 * kdot + P.rim[c] * 0.5 * edge * rimSide + P.bounce[c] * 0.35 * low;
    }
    return out;
  }
  // fill an RGBA8 buffer (size x size, row 0 = ny -1) with matcapPixel / SCALE (decode x SCALE in the shader); a little dither so the soft gradients do not band
  const MATCAP_SCALE = 4;
  function matcapBytes(size, P, buf) {
    buf = buf || new Uint8Array(size * size * 4); const c = [0, 0, 0]; let s = 12345;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size * 2 - 1, y = (j + 0.5) / size * 2 - 1; let r2 = x * x + y * y, nx = x, ny = y; if (r2 > 0.98) { const l = Math.sqrt(r2 / 0.98); nx /= l; ny /= l; r2 = 0.98; }
      const nz = Math.sqrt(Math.max(0, 1 - r2)); matcapPixel(nx, ny, nz, P, c); s = (s * 1664525 + 1013904223) >>> 0; const d = (s / 4294967296 - 0.5);
      const o = (j * size + i) * 4; for (let k = 0; k < 3; k++) buf[o + k] = clamp(Math.round(c[k] / MATCAP_SCALE * 255 + d), 0, 255); buf[o + 3] = 255;
    }
    return buf;
  }
  const matcapPalette = (e) => ({ key: e.key, rim: e.rim, bounce: [e.ground[0] * 1.1 + 0.05, e.ground[1] * 0.9 + 0.02, e.ground[2] * 0.7], top: e.skyTop, hor: e.skyHor, ground: e.ground });

  /* ───────── pure: chunked normal smoothing driver (time-sliced so a load never hitches) ───────── */
  // runs smoothNormals in slices of at most `maxVerts` vertices' work is not splittable cheaply, so the slicing is per mesh: meshes above `capVerts` are skipped, the rest are
  // queued and run one at a time with a yield in between (the caller awaits).  Returns the list of {mesh, nrm} the caller writes back.
  const CAP_VERTS = 90000;

  /* ───────── browser part ───────── */
  const S = { THREE: null, envs: {}, roots: new Set(), acc: 0, last: 0, shadowSeen: new WeakSet(), stats: { mats: 0, meshesSmoothed: 0, vertsChanged: 0, smoothMs: 0, applied: 0, matcapGens: 0 }, tier: null, envKind: null, lastSrcKey: '' };
  const D = typeof document !== 'undefined' ? document : null;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { } };
  function search() { try { return location.search; } catch (e) { return ''; } }
  function liveTier() {
    let preset = null, pressure = 0, legacy = false;
    try { preset = typeof W.resolvePreset === 'function' ? W.resolvePreset() : (W.GFX && W.GFX.preset); } catch (e) { }
    try { const b = W.DMBudget; if (b && b.on && b.stats) { const st = b.stats(); pressure = (st && st.p) | 0; } } catch (e) { }
    try { legacy = !!(W.GFX && W.GFX.deviceMem > 0 && W.GFX.deviceMem <= 3); } catch (e) { }
    return pickTier({ search: search(), stored: lsGet(LS), preset, pressure, legacy });
  }
  function tier() { if (!S.tier) S.tier = liveTier(); return S.tier; }
  function envKind() { if (!S.envKind) S.envKind = pickEnvKind({ search: search(), stored: lsGet('dm_charenv') }); return S.envKind; }

  // an env = the shared uniforms one group of characters reads (the game's, the studio's).  Colours are light units; /pi happens in the shader (scene lights are divided by pi in the BRDF).
  function makeEnv(THREE, name) {
    const T = THREE.TSL, u = T.uniform, v3 = (x) => u(new THREE.Vector3(x[0], x[1], x[2])), E = { name, THREE };
    const d = deriveEnv({ sun: { dir: [0.4, 0.7, 0.5], color: [1, 0.95, 0.86], intensity: 2.0 }, hemi: { sky: [0.55, 0.65, 0.9], ground: [0.25, 0.2, 0.15], intensity: 0.4 }, amb: { color: [0.4, 0.5, 0.65], intensity: 0.5 }, day: 1 });
    E.cur = { dirA: d.dir, colA: mul3(d.key, 0.14), dirB: [-d.dir[0], 0.25, -d.dir[2]], colB: mul3(d.fill, 0.5), top: d.skyTop, hor: d.skyHor, gnd: d.ground, key: d.key, rim: d.rim, fill: d.fill, L: d.dir };
    E.tgt = JSON.parse(JSON.stringify(E.cur));
    E.u = { dirA: v3(E.cur.dirA), colA: v3(E.cur.colA), dirB: v3(E.cur.dirB), colB: v3(E.cur.colB), top: v3(E.cur.top), hor: v3(E.cur.hor), gnd: v3(E.cur.gnd), key: v3(E.cur.key), rim: v3(E.cur.rim), fill: v3(E.cur.fill), L: v3(E.cur.L),
      kAmb: u(0.6), kSpec: u(1), kRim: u(1), kWrap: u(0), kMat: u(0), kMatD: u(0) };
    E.mat = null; E.matTex = null; E.matSig = '';
    return E;
  }
  function envFor(THREE, which) { return typeof which === 'object' && which ? which : (S.envs[which || 'game'] || (S.envs[which || 'game'] = makeEnv(THREE, which || 'game'))); }
  const V3 = ['dirA', 'colA', 'dirB', 'colB', 'top', 'hor', 'gnd', 'key', 'rim', 'fill', 'L'];
  function writeEnv(E) { for (const k of V3) E.u[k].value.set(E.cur[k][0], E.cur[k][1], E.cur[k][2]); }
  // strengths by tier / env kind (live: a tier switch is a uniform write, no recompile; the wrap branch only exists in shaders built at 'high')
  function strengths(E) {
    const t = tier(), k = envKind(), on = t !== 'off', mat = on && (k === 'matcap' || k === 'both');
    const studio = E.name === 'studio';
    E.u.kAmb.value = on && k !== 'matcap' ? (studio ? 0.5 : 0.6) : 0; E.u.kSpec.value = on && k !== 'matcap' ? 1 : 0; E.u.kRim.value = on ? 1 : 0; E.u.kWrap.value = t === 'high' ? 1 : 0;
    E.u.kMat.value = mat ? (k === 'matcap' ? 0.85 : 0.22) : 0; E.u.kMatD.value = mat ? (k === 'matcap' ? 0.8 : 0.2) : 0;
  }
  function ensureMatcap(E, force) {
    const THREE = E.THREE, k = envKind(); if (k === 'analytic' || tier() === 'off') return;
    const P = matcapPalette(E.tgt.key ? { key: E.tgt.key, rim: E.tgt.rim, ground: E.tgt.gnd, skyTop: E.tgt.top, skyHor: E.tgt.hor } : E.cur), sig = [].concat(P.key, P.rim, P.top, P.ground).map((x) => Math.round(x * 8)).join(',');
    if (!force && sig === E.matSig && E.matTex) return;
    const SZ = 128; if (!E.matTex) { E.mat = new Uint8Array(SZ * SZ * 4); E.matTex = new THREE.DataTexture(E.mat, SZ, SZ, THREE.RGBAFormat, THREE.UnsignedByteType); E.matTex.colorSpace = THREE.NoColorSpace; E.matTex.minFilter = THREE.LinearMipmapLinearFilter; E.matTex.magFilter = THREE.LinearFilter; E.matTex.generateMipmaps = true; E.matTex.wrapS = E.matTex.wrapT = THREE.ClampToEdgeWrapping; E.matTex.flipY = false; }
    matcapBytes(SZ, P, E.mat); E.matTex.needsUpdate = true; E.matSig = sig; S.stats.matcapGens++;
  }

  /* the one emissive node that is the whole look.  base = whatever the material emitted before (its own emissive colour / map, Ariel's skin floor). */
  function lookNode(THREE, E, m, kind, tierNow, base, kindK) {
    const T = THREE.TSL, { Fn, float, vec3, vec2, dot, normalize, saturate, pow, mix, reflect, max, smoothstep, positionWorld, cameraPosition, normalWorld, normalView, diffuseColor, roughness, metalness, materialAO, texture } = T;
    const P = kindK, U = E.u, INV_PI = 1 / Math.PI, useMat = envKind() !== 'analytic', useAna = envKind() !== 'matcap', wrap = tierNow === 'high' && P.wrap > 0;
    return Fn(() => {
      const N = normalize(normalWorld), Vv = normalize(cameraPosition.sub(positionWorld)), ndv = saturate(dot(N, Vv)), alb = diffuseColor.rgb, r = roughness;
      const occ = m.aoNode ? m.aoNode : (m.aoMap ? materialAO : float(1)), L = normalize(U.L);
      const f0 = mix(vec3(P.f0), alb, metalness), one = float(1).sub(ndv), f5 = pow(one, 5.0);
      const F = f0.add(max(vec3(float(1).sub(r)), f0).sub(f0).mul(f5));
      let out = base;
      const kd = alb.mul(float(1).sub(metalness));
      if (useAna) {
        const up = N.y, skyN = mix(U.hor, U.top, saturate(up)), irr = mix(U.gnd, skyN, smoothstep(-0.4, 0.4, up));
        const boxA = U.colA.mul(saturate(dot(N, normalize(U.dirA))).mul(0.5).add(0.15)), boxB = U.colB.mul(saturate(dot(N, normalize(U.dirB))).mul(0.5).add(0.1));
        out = out.add(kd.mul(irr.add(boxA).add(boxB)).mul(occ).mul(U.kAmb.mul(P.amb * INV_PI)));
        const R = reflect(Vv.negate(), N), blur = r.mul(r), sky = mix(U.hor, U.top, pow(saturate(R.y), 0.6)), below = mix(U.hor, U.gnd, saturate(R.y.negate().mul(2.0)));
        let rad = mix(below, sky, smoothstep(-0.12, 0.12, R.y));
        const lo = mix(float(0.7), float(0.1), blur), bA = smoothstep(lo, float(1.0), dot(R, normalize(U.dirA))), bB = smoothstep(lo, float(1.0), dot(R, normalize(U.dirB)));
        rad = rad.add(U.colA.mul(bA)).add(U.colB.mul(bB));
        rad = mix(rad, irr, blur.mul(0.7));
        out = out.add(rad.mul(F).mul(saturate(occ.mul(0.5).add(ndv.mul(0.6)))).mul(U.kSpec.mul(P.spec * INV_PI)));
      }
      if (useMat) {
        const uv = vec2(normalView.x, normalView.y).mul(0.5).add(0.5), sd = texture(E.matTex, uv).level(float(5.0)).rgb.mul(MATCAP_SCALE), sg = texture(E.matTex, uv).level(r.mul(4.0)).rgb.mul(MATCAP_SCALE);
        out = out.add(kd.mul(sd).mul(occ).mul(U.kMatD.mul(P.amb * INV_PI))).add(sg.mul(F).mul(U.kMat.mul(P.spec * INV_PI)));
      }
      if (P.rim > 0) {
        const nl = dot(N, L), back = saturate(float(0.5).sub(dot(Vv, L).mul(0.5))), fres = pow(one, 3.0), albK = alb.mul(0.7).add(0.3);
        const rimSun = U.rim.mul(fres.mul(back).mul(saturate(nl.mul(0.6).add(0.4)))).mul(albK), cool = U.fill.mul(pow(one, 2.2).mul(saturate(float(0.5).sub(nl.mul(0.5))))).mul(albK);
        out = out.add(rimSun.mul(3.6).add(cool.mul(2.0)).mul(U.kRim.mul(P.rim * INV_PI)));
        if (P.fuzz > 0) out = out.add(mix(U.hor, U.top, 0.5).mul(pow(one, 2.0)).mul(albK).mul(U.kRim.mul(P.fuzz * 0.6 * INV_PI)));
      }
      if (wrap) {
        const nl = dot(N, L), w = 0.5, wr = saturate(nl.add(w).div(1 + w)), extra = max(wr.sub(saturate(nl)), 0.0).mul(float(1).sub(smoothstep(0.1, 0.6, nl)));
        out = out.add(alb.mul(vec3(1.0, 0.42, 0.26)).mul(U.key).mul(extra).mul(U.kWrap.mul(INV_PI)));
      }
      return out;
    })();
  }

  const slot = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
  function tuneTextures(m, t) {
    const an = ANISO[t] || 1;
    for (const k of slot) { const x = m[k]; if (!x || !x.isTexture) continue; if (x.anisotropy < an) x.anisotropy = an; if (x.generateMipmaps !== false && (x.minFilter === 1003 || x.minFilter === 1006)) { x.minFilter = 1008; x.needsUpdate = true; } }
  }
  function matProps(m, meshName) {
    const sh = m.sheen && m.sheenColor ? [m.sheenColor.r, m.sheenColor.g, m.sheenColor.b] : null;
    return { name: m.name, meshName, metalness: m.metalness, roughness: m.roughness, hasMap: !!m.map, hasOrm: !!m.metalnessMap, vertexColors: !!m.vertexColors, clearcoat: m.clearcoat || 0, sheen: sh && (m.sheen > 0 || m.sheen === undefined) ? sh : null, transparent: !!m.transparent, opacity: m.opacity, isHair: !!(m.userData && m.userData.isHair) };
  }
  const SKIP = { uuid: 1, id: 1, type: 1, version: 1 };
  function twin(THREE, m, kind) {
    if (m.isNodeMaterial) return m;
    if (m.userData && m.userData.dmCLTwin) return m.userData.dmCLTwin;
    const Cls = (m.clearcoat || 0) > 0.5 && THREE.MeshPhysicalNodeMaterial ? THREE.MeshPhysicalNodeMaterial : THREE.MeshStandardNodeMaterial; if (!Cls || !m.isMeshStandardMaterial) return m;
    const n = new Cls();
    for (const k in m) { if (SKIP[k] || k[0] === '_' || /^is[A-Z]/.test(k)) continue; const v = m[k]; try { n[k] = v && v.isColor ? v.clone() : v && v.isVector2 ? v.clone() : v; } catch (e) { } }
    n.userData = Object.assign({}, m.userData); m.userData = m.userData || {}; m.userData.dmCLTwin = n; n.needsUpdate = true; return n;
  }
  // one material: twin + PBR values + the look node.  Returns the (possibly new) material.
  function lookMaterial(THREE, E, m, meshName, tierNow) {
    if (!m || (m.userData && m.userData.dmCharLook && m.userData.dmCharLook.tier === tierNow)) return m;
    const kind = classify(matProps(m, meshName)), P = kindParams(kind, tierNow);
    if (kind === 'hair' || kind === 'glass') { tuneTextures(m, tierNow); return m; }   // hair untouched; glass keeps the GLB's transparency values
    const t = twin(THREE, m, kind); if (!t || !t.isNodeMaterial) return m;
    if (!t.roughnessMap && t.roughness !== undefined) t.roughness = clamp(t.roughness, P.rMin, P.rMax);
    if (kind === 'skin' && !t.metalnessMap) t.metalness = 0;
    t.userData = t.userData || {};
    const prev = t.userData.dmCharLook;
    if (!(prev && prev.base !== undefined)) t.userData.dmCLBase = t.emissiveNode || null;
    const base = t.userData.dmCLBase || T3(THREE).materialEmissive;
    t.emissiveNode = lookNode(THREE, E, t, kind, tierNow, base, P);
    t.userData.dmCharLook = { tier: tierNow, kind, base: 1 }; tuneTextures(t, tierNow); t.needsUpdate = true; S.stats.mats++;
    return t;
  }
  const T3 = (THREE) => THREE.TSL;

  function eachMesh(rootObj, f) { rootObj.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.material && o.geometry) f(o); }); }
  // materials -> look.  Synchronous (so the caller's next step, e.g. DMLight.applyTree, sees node materials).
  function applyMaterials(rootObj, THREE, E, tierNow) {
    const swapped = new Map();
    eachMesh(rootObj, (o) => {
      const one = (m) => { if (!m) return m; if (swapped.has(m)) return swapped.get(m); const r = lookMaterial(THREE, E, m, o.name, tierNow); swapped.set(m, r); return r; };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    });
    return swapped.size;
  }
  // time-sliced normal smoothing: one mesh per slice, yielding between meshes (a mesh above CAP_VERTS is skipped)
  async function smoothMeshes(rootObj, THREE, budgetMs) {
    if (/[?&]charsmooth=0\b/.test(search())) return;   // debug / A-B switch
    const list = []; eachMesh(rootObj, (o) => { const g = o.geometry; if (!g.attributes.normal || !g.attributes.position || g.userData.dmSmoothed || (g.morphAttributes && g.morphAttributes.normal)) return; list.push(g); });
    const seen = new Set(); let t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    for (const g of list) {
      if (seen.has(g)) continue; seen.add(g); g.userData.dmSmoothed = true;
      const pa = g.attributes.position, na = g.attributes.normal; if (!(pa.array instanceof Float32Array) || !(na.array instanceof Float32Array) || pa.itemSize !== 3 || na.itemSize !== 3 || pa.isInterleavedBufferAttribute || na.isInterleavedBufferAttribute || pa.count > CAP_VERTS) continue;
      const a0 = performance.now(), r = smoothNormals(pa.array, na.array, {}); S.stats.smoothMs += performance.now() - a0;
      if (r.nrm) { g.setAttribute('normal', new THREE.BufferAttribute(r.nrm, 3)); S.stats.meshesSmoothed++; S.stats.vertsChanged += r.changed; }
      if (performance.now() - t0 > (budgetMs || 8)) { await new Promise((res) => setTimeout(res, 0)); t0 = performance.now(); }
    }
  }
  function apply(rootObj, o) {
    o = o || {}; const THREE = o.THREE || W.THREE; if (!rootObj || !THREE || !THREE.TSL) return Promise.resolve(false);
    const t = o.tier || tier(); S.THREE = THREE; if (t === 'off') return Promise.resolve(false);
    const E = envFor(THREE, o.env || 'game'); strengths(E); ensureMatcap(E, false); writeEnv(E);
    S.roots.add(rootObj); rootObj.userData = rootObj.userData || {}; rootObj.userData.dmCharLookEnv = E;
    try { applyMaterials(rootObj, THREE, E, t); } catch (e) { try { console.warn('[charlook] materials', e); } catch (_) { } }
    S.stats.applied++;
    return smoothMeshes(rootObj, THREE, o.budgetMs).then(() => true).catch((e) => { try { console.warn('[charlook] normals', e); } catch (_) { } return false; });
  }
  // after DMCharPaint cloned / swapped materials: anything without our marker is looked again (a clone of a node material keeps its nodes, so this mostly finds a reverted original)
  function refresh(rootObj) {
    try { if (!rootObj || !rootObj.userData || !rootObj.userData.dmCharLookEnv) return 0; const t = tier(); if (t === 'off') return 0; return applyMaterials(rootObj, S.THREE || W.THREE, rootObj.userData.dmCharLookEnv, t); } catch (e) { return 0; }
  }
  function forget(rootObj) { S.roots.delete(rootObj); }

  // studio rig: warm key upper front-left, cool rim behind, warm bounce below; the studio env reads the same numbers.  Returns the lights (the studio owns / disposes them).
  function rigStudio(scene, THREE, o) {
    const T = THREE, E = envFor(T, 'studio'), St = STUDIO, rig = {};
    const hemi = new T.HemisphereLight(0x8c97c8, 0x5a3322, 0.55), key = new T.DirectionalLight(0xffd9b0, 2.4), rim = new T.DirectionalLight(0x7090ff, 1.6), fill = new T.DirectionalLight(0xffa078, 0.35);
    key.position.set(St.dir[0] * 4, St.dir[1] * 4, St.dir[2] * 4); rim.position.set(St.rimDir[0] * 4, St.rimDir[1] * 4, St.rimDir[2] * 4); fill.position.set(0.6, -0.8, 1.4);
    [hemi, key, rim, fill].forEach((l) => scene.add(l)); Object.assign(rig, { hemi, key, rim, fill, env: E });
    const k = St.key, d = St.dir; E.tgt = E.cur = { dirA: d, colA: mul3(k, 0.22), dirB: St.rimDir, colB: mul3(St.rim, 0.28), top: St.skyTop, hor: St.skyHor, gnd: St.ground, key: [k[0] * 0.8, k[1] * 0.8, k[2] * 0.8], rim: mul3(St.rim, 0.5), fill: St.fill, L: d };
    writeEnv(E); strengths(E); ensureMatcap(E, true); return rig;
  }

  // the menu world (ui/dm-menuworld.js) re-aims / re-colours the studio's key + rim to its own sun after the rig is built: the studio env follows those two lights (call once after it)
  function syncStudio(X) {
    try {
      if (!X || !X.key || !S.envs.studio) return; const E = S.envs.studio, c = (l) => [l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity], dn = (l) => normalize3([l.position.x, l.position.y, l.position.z]);
      const kc = c(X.key), kd = dn(X.key); E.cur.dirA = kd; E.cur.L = kd; E.cur.colA = mul3(kc, 0.22); E.cur.key = mul3(kc, 0.8);
      if (X.rim) { const rc = c(X.rim); E.cur.dirB = dn(X.rim); E.cur.colB = mul3(rc, 0.28); E.cur.rim = mul3(rc, 0.5); }
      E.tgt = E.cur; writeEnv(E);
    } catch (e) { }
  }

  // per-frame: at 4 Hz read the scene's own lights, derive the env, ease towards it (uniform writes only).  ctx: { scene, dt, sunDir?:Vector3 (toward the sun), day?, sunLight?:PointLight (flight), pos?:Vector3 (the character) }
  function tick(dt, ctx) {
    try {
      if (!S.THREE || !ctx || !ctx.scene) return; const t = tier(); const E = S.envs.game; if (!E || t === 'off') return;
      const now = typeof performance !== 'undefined' ? performance.now() : 0; if (now - S.last < 8) return; S.last = now;
      S.acc += dt || 0.016; if (S.acc >= 0.25 || !S.srcDone) { S.acc = 0; S.srcDone = true; gather(E, ctx); ensureMatcapSlow(E, now); }
      const k = 1 - Math.exp(-(dt || 0.016) * 3.2), a = E.cur, b = E.tgt; for (const key of V3) for (let i = 0; i < 3; i++) a[key][i] += (b[key][i] - a[key][i]) * k; writeEnv(E);
    } catch (e) { if (!S.warned) { S.warned = 1; try { console.warn('[charlook] tick', e); } catch (_) { } } }
  }
  function ensureMatcapSlow(E, now) { if (envKind() === 'analytic' || now - (E.matAt || 0) < 3000) return; E.matAt = now; ensureMatcap(E, false); }
  function gather(E, ctx) {
    let sun = null, hemi = null, amb = null, moon = null; const col = (c) => [c.r, c.g, c.b];
    for (const o of ctx.scene.children) {
      if (!o.isLight || o.visible === false) continue;
      if (o.isDirectionalLight) { if (o.userData && o.userData.shadowOnlyLight) continue; if (/moon/i.test(o.name || '')) { moon = { color: col(o.color), intensity: o.intensity }; continue; } if (!sun || (o.userData && o.userData.shadowKey)) { const tg = o.target ? o.target.position : { x: 0, y: 0, z: 0 }; sun = { dir: [o.position.x - tg.x, o.position.y - tg.y, o.position.z - tg.z], color: col(o.color), intensity: o.intensity }; } }
      else if (o.isHemisphereLight) hemi = { sky: col(o.color), ground: col(o.groundColor), intensity: o.intensity };
      else if (o.isAmbientLight) amb = amb ? { color: add3(mul3(amb.color, amb.intensity), mul3(col(o.color), o.intensity)), intensity: 1 } : { color: col(o.color), intensity: o.intensity };
    }
    if (!sun && ctx.sunLight && ctx.pos) { const sp = ctx.sunLight.position, d = [sp.x - ctx.pos.x, sp.y - ctx.pos.y, sp.z - ctx.pos.z], dist = Math.hypot(d[0], d[1], d[2]) || 1; sun = { dir: d, color: col(ctx.sunLight.color), intensity: Math.min(3, ctx.sunLight.intensity * Math.pow(Math.max(dist, 1e-3), -(ctx.sunLight.decay == null ? 2 : ctx.sunLight.decay))) }; }
    if (ctx.sunDir) { const sd = [ctx.sunDir.x, ctx.sunDir.y, ctx.sunDir.z]; sun = sun ? Object.assign({}, sun, { dir: sd }) : { dir: sd, color: [1, 0.95, 0.86], intensity: 1.5 }; }
    const d = deriveEnv({ sun, hemi, amb, moon, day: ctx.day == null ? 1 : ctx.day });
    E.tgt = { dirA: d.dir, colA: mul3(d.key, 0.14), dirB: normalize3([-d.dir[0], 0.25, -d.dir[2]]), colB: mul3(d.fill, 0.5), top: d.skyTop, hor: d.skyHor, gnd: d.ground, key: d.key, rim: d.rim, fill: d.fill, L: d.dir };
    // anti-acne for the shadow-only light the board + character use (it ships with a bias but no normal bias: curved skin self-shadows into bands)
    for (const o of ctx.scene.children) if (o.isDirectionalLight && o.userData && o.userData.shadowOnlyLight && o.shadow && !S.shadowSeen.has(o)) { S.shadowSeen.add(o); if (!(o.shadow.normalBias >= 0.02)) o.shadow.normalBias = 0.02; }
  }
  const normalize3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  function setTier(t) {   // 'auto' clears the stored pick.  Uniform-only: wrap is only compiled into materials built at 'high'.
    const v = norm(t); if (!v) { lsSet(LS, null); S.tier = null; } else { lsSet(LS, v); S.tier = v; }
    S.tier = S.tier || liveTier(); for (const k of Object.keys(S.envs)) { strengths(S.envs[k]); ensureMatcap(S.envs[k], false); }
    return S.tier;
  }
  const status = () => ({ tier: tier(), envKind: envKind(), stored: lsGet(LS), roots: S.roots.size, ...S.stats });

  const api = { tier, setTier, envKind, apply, refresh, forget, rigStudio, syncStudio, tick, status, S, envFor,
    pickTier, pickEnvKind, norm, smoothNormals, seamStats, deriveEnv, classify, kindParams, matcapPixel, matcapBytes, matcapPalette, MATCAP_SCALE, STUDIO, ANISO, TIERS };
  api.core = { pickTier, pickEnvKind, norm, smoothNormals, seamStats, deriveEnv, classify, kindParams, matcapPixel, matcapBytes, matcapPalette, MATCAP_SCALE, STUDIO, ANISO, TIERS };
  return { api };
});
