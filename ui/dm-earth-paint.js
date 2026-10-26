/* DMEarthPaint (v132) — the ONE way Earth's ground is painted, at every distance and on every terrain mesh
 * (far marching-cubes globe, the whole-planet map / WebGL globe, the WebGPU near patch and the CPU surface tiles).
 * There is no separate ice/snow level-of-detail layer: each mesh looks the real maps up at its own vertices, so the
 * paint follows whatever terrain LOD is drawn.
 *   ice   — DMEarthIce glacier mask (Natural Earth glaciated areas) + the Arctic sea-ice cap; nowhere else.
 *   cover — static/earth/earth-biome.png, baked by tools/bake/earth-biome.py from MODIS IGBP land cover
 *           (MOD12C1; rendering by T. Hengl, CC BY-SA 3.0): desert, bare dirt/shrub/tundra, grass/fields,
 *           temperate/boreal forest, tropical forest, as soft per-cell fractions.
 * Both maps share DMEarth's layout: u = lon/360 + 0.5, v = lat/180 + 0.5 (row 0 = south pole).
 * Cost: two texture fetches (cover + ice) and a handful of mixes, no branches; the caller's detail noise breaks
 * every cover into two tones so it reads at any distance.
 *   DMEarthPaint.cover(lat, lon, out5)            fractions [desert, dirt, grass, forest, tropical]
 *   DMEarthPaint.color(lat, lon, slope, n, nf, c) CPU colour (linear) into THREE.Color c (n, nf: 0..1 detail noise)
 *   DMEarthPaint.tsl(lat, lon, slope, n, nf, opt) the same colour as a TSL node (lat/lon in degrees, float nodes)
 *   DMEarthPaint.whenReady(ms)                    resolves once the cover map is in */
(function () {
  const W = 720, H = 360;
  let cov = null, ready = false, covTex = null, iceTex = null, rs = null;
  const readyP = new Promise((r) => { rs = r; });
  // two tones per cover for the detail noise (hex, converted to linear once THREE is up)
  const P = {
    ice: [0xeef3f8, 0xcfe0ef], desert: [0xd9b47c, 0xc4955c], dirt: [0x8c7052, 0x6c5842],
    grass: [0x8d9c3e, 0x627e2f], field: [0xa9a04e, 0x7f9a3a], forest: [0x2e4a21, 0x40602b],
    boreal: [0x1c3418, 0x27431f], tropic: [0x1d4d18, 0x2c6322], rock: [0x6f675c, 0x857b6c]
  };
  const L = {};
  function lin() {
    if (L.ok || !window.THREE) return L.ok;
    for (const k in P) L[k] = P[k].map((h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; });
    return (L.ok = true);
  }
  const sm = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  function cover(lat, lon, o) {
    o = o || [0, 0, 1, 0, 0];
    if (!cov) { o[0] = o[1] = o[3] = o[4] = 0; o[2] = 1; return o; }
    const fx = ((((lon + 180) / 360) % 1 + 1) % 1) * W - 0.5, fy = Math.max(0, Math.min(H - 1.001, (lat + 90) / 180 * H - 0.5));
    let x0 = Math.floor(fx); const y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0; x0 = (x0 + W) % W; const x1 = (x0 + 1) % W;
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const a = cov[(y0 * W + x0) * 4 + k], b = cov[(y0 * W + x1) * 4 + k], c = cov[((y0 + 1) * W + x0) * 4 + k], d = cov[((y0 + 1) * W + x1) * 4 + k];
      o[k] = ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / 255; s += o[k];
    }
    o[4] = Math.max(0, 1 - s);   // tropical forest is the remainder
    // IGBP 'barren' poleward of ~50° is tundra rock and gravel, not sand: paint it as bare dirt
    const pb = sm(48, 58, Math.abs(lat)) * o[0]; o[0] -= pb; o[1] += pb;
    return o;
  }
  const _o = [0, 0, 0, 0, 0];
  // (v135) allocation-free: the CPU ground tiles call this once per vertex (tens of thousands per tile on Ultra);
  // the v132 version built ~12 small arrays per call and looked the glacier mask up twice — GC churn on the main thread
  const _c = [0, 0, 0];
  const mx = (A, t, k) => A[0][k] + (A[1][k] - A[0][k]) * t;
  function ice(lat, lon) { return window.DMEarthIce ? DMEarthIce.at(lat, lon) : 0; }
  function color(lat, lon, slope, n, nf, c) {
    lin(); const w = cover(lat, lon, _o);
    const fb = sm(45, 58, Math.abs(lat)), tr = sm(0.42, 0.8, slope) * 0.85 * (1 - 0.85 * Math.min(1, w[3] + w[4]));
    const iw = ice(lat, lon); api.lastIce = iw;
    const ti = iw > 0 ? iw * (1 - slope * 0.35) : 0, it = nf * 0.6 + slope * 0.4;
    for (let k = 0; k < 3; k++) {
      // fields: two tones by the caller's noise so farmland reads as a patchwork; boreal taiga darker than temperate forest
      const gf = mx(L.grass, n, k) * 0.55 + mx(L.field, nf, k) * 0.45, ft = mx(L.forest, n, k);
      let v = mx(L.desert, n, k) * w[0] + mx(L.dirt, nf, k) * w[1] + gf * w[2] + (ft + (mx(L.boreal, n, k) - ft) * fb) * w[3] + mx(L.tropic, nf, k) * w[4];
      v += (mx(L.rock, nf, k) - v) * tr;          // forest keeps its canopy on slopes: rock only through bare/open cover
      if (ti > 0) v += (mx(L.ice, it, k) - v) * ti;
      _c[k] = v;
    }
    return c ? (c.setRGB(_c[0], _c[1], _c[2]), c) : [_c[0], _c[1], _c[2]];
  }
  function dataTex(px) {
    const t = new THREE.DataTexture(px, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  }
  // R = glacier weight, G = Arctic sea-ice weight (same layout as the cover map)
  function iceTexture() {
    if (iceTex || !window.THREE || !window.DMEarthIce) return iceTex;
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) { const lat = -90 + (y + 0.5) / H * 180;
      for (let x = 0; x < W; x++) { const lon = -180 + (x + 0.5) / W * 360, i = (y * W + x) * 4;
        px[i] = Math.round(DMEarthIce.at(lat, lon) * 255); px[i + 1] = Math.round(DMEarthIce.seaIce(lat, lon) * 255); px[i + 3] = 255; } }
    return (iceTex = dataTex(px));
  }
  function coverTexture() {
    if (covTex || !window.THREE) return covTex;
    const px = new Uint8Array(W * H * 4);
    if (cov) px.set(cov); else for (let i = 0; i < W * H; i++) px[i * 4 + 2] = 255;
    return (covTex = dataTex(px));
  }
  function tsl(lat, lon, slope, n, nf, opt) {
    const { texture, vec2, vec3, mix, float, smoothstep } = (window.THREE && THREE.TSL) || window;
    lin(); const ct = coverTexture(), it = iceTexture();
    const uv = vec2(lon.div(360).add(0.5), lat.div(180).add(0.5));
    const cw = texture(ct, uv).level(0), iw = it ? texture(it, uv).level(0) : vec3(0, 0, 0);
    const V = (a) => vec3(a[0], a[1], a[2]);
    const T2 = (k, t) => mix(V(L[k][0]), V(L[k][1]), t);
    const gf = mix(T2('grass', n), T2('field', nf), 0.45);
    const trop = float(1).sub(cw.r).sub(cw.g).sub(cw.b).sub(cw.a).max(0.0);
    const pb = smoothstep(48, 58, lat.abs()).mul(cw.r), dsr = cw.r.sub(pb), drt = cw.g.add(pb);
    let c = T2('desert', n).mul(dsr).add(T2('dirt', nf).mul(drt)).add(gf.mul(cw.b)).add(mix(T2('forest', n), T2('boreal', n), smoothstep(45, 58, lat.abs())).mul(cw.a)).add(T2('tropic', nf).mul(trop));
    c = mix(c, T2('rock', nf), smoothstep(0.42, 0.8, slope).mul(0.85).mul(float(1).sub(cw.a.add(trop).min(1).mul(0.85))));
    let ic = iw.r; if (opt && opt.seaIce) ic = ic.max(iw.g.mul(opt.seaIce));
    c = mix(c, mix(V(L.ice[0]), V(L.ice[1]), nf.mul(0.6).add(slope.mul(0.4))), ic.mul(float(1).sub(slope.mul(0.35))));
    return c;
  }
  function decode(img) {
    const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, W * 2, H).data, a = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) { const sy = H - 1 - y;   // PNG row 0 = north; ours row 0 = south
      for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, l = (sy * W * 2 + x) * 4, r = (sy * W * 2 + W + x) * 4;
        a[i] = d[l]; a[i + 1] = d[l + 1]; a[i + 2] = d[l + 2]; a[i + 3] = d[r]; } }
    cov = a; ready = true; api.ready = true;
    if (covTex) { covTex.image.data.set(a); covTex.needsUpdate = true; }
    rs(true); try { window.dispatchEvent(new CustomEvent('dm:earth-paint-ready')); } catch (e) {}
  }
  function load() {
    if (!window.fetch || !window.createImageBitmap) { rs(false); return; }
    fetch('static/earth/earth-biome.png?v=132b').then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
      .then(decode).catch((e) => { console.warn('[earth-paint] cover map', e); rs(false); });
  }
  const api = { ready: false, lastIce: 0, cover, color, tsl, ice, iceTexture, coverTexture, P,
    whenReady(ms) { return ready ? Promise.resolve(true) : Promise.race([readyP, new Promise((r) => setTimeout(() => r(false), ms || 6000))]); } };
  window.DMEarthPaint = api;
  load();
})();
