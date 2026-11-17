/* DART Meadow — the sky seen from the ground and from sky flight.
 *
 * A day/night cycle on the shared world clock (DMTime — real UTC, 30× faster,
 * real tilts and seasons): the local sun (coloured by
 * its star type) rises and sets with the site's latitude/longitude. By day
 * the atmosphere scatters it (blue on Earth, butterscotch on Mars, …) with
 * a hazy horizon and warm sunsets; at night the atmosphere thins almost to
 * nothing and the interstellar sky shows through — the star field, the
 * band of the galaxy, and the brightest stars, which still show faintly by
 * day. Comets drift across now and then (day or night) and meteors burn
 * up at night. Airless worlds keep a black sky with the stars always out.
 *
 *   const sky = DMSky.create(scene, {pal, body, style, radius, atmos, starType})
 *   sky.update(camera, dt, lat, lon)   — each frame
 *   sky.sunDir                         — THREE.Vector3 toward the sun
 *   sky.day                            — 0 night … 1 day
 */
(function () {
  'use strict';
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  // (t1537) daytime share of the hemisphere / ambient fill outdoors in an atmosphere (the key light leads); ?dayfill=<0..1>
  const FILL_DAY = (() => { try { const m = (location.search || '').match(/[?&]dayfill=([0-9.]+)/); if (m) return Math.max(0, Math.min(1, +m[1])); } catch (e) { } return 0.45; })();
  const T = () => window;               // the TSL functions live on window
  const DAY_WALL_SEC = 24 * 60;         // one game day = 24 minutes on the shared clock
  const BODY_DAY = { Earth: 1, Mars: 1.03, Moon: 2.5, Mercury: 3, Venus: 4 };
  function starColor(starType) {
    const c = String(starType || 'G').trim().toUpperCase()[0];
    return ({ O: 0x9db4ff, B: 0xaabfff, A: 0xcad7ff, F: 0xf8f7ff, G: 0xfff1d8, K: 0xffd2a1, M: 0xffb27a })[c] || 0xfff1d8;
  }
  // zenith optical depth per channel (Rayleigh-ish air reddens the sun at the horizon; Mars dust dims it nearly grey, a touch warm)
  const EXT_AIR = [0.11, 0.24, 0.52], EXT_DUST = [0.30, 0.33, 0.38];
  const rnd = (s) => () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };

  function create(scene, o) {
    const THREE = window.THREE, W = T();
    const R = o.radius || 1000, atmos = o.atmos !== false;
    const sk = (window.DMWorldStyle && o.pal) ? DMWorldStyle.skyFor(o.style || 'lush', o.pal) : { top: 0x3a6ea5, bottom: 0x88bbff, haze: 0xbfd8f0, glow: 0xffe0b0 };
    const sunCol = new THREE.Color(starColor(o.starType));
    if (window.DMPolish) DMPolish.tintSun(sunCol, sk, atmos);   // the world's own tint on the star's colour (ui/dm-polish.js)
    const sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    const U = {
      top: W.uniform(new THREE.Color(sk.top)), bot: W.uniform(new THREE.Color(sk.bottom)), haze: W.uniform(new THREE.Color(sk.haze != null ? sk.haze : sk.bottom)),
      glow: W.uniform(new THREE.Color(sk.glow != null ? sk.glow : 0xffe0b0)), sun: W.uniform(sunCol.clone()),
      dir: W.uniform(sunDir.clone()), day: W.uniform(1), atm: W.uniform(atmos ? 1 : 0),
      // (v334 Cosmos) the system's real stars (ui/dm-stars.js): per star xyz = direction, w = cos(angular radius); rgb = colour x disc
      // brightness, a = sky weight x its daylight (the forward-scatter aureole); tint = the stars' blended daylight colour; ext = the air's
      // zenith optical depth per channel (the discs redden and dim toward the horizon by airmass)
      sd: [0, 1, 2].map(() => W.uniform(new THREE.Vector4(0, 1, 0, 0.9997))), sc: [0, 1, 2].map(() => W.uniform(new THREE.Vector4(0, 0, 0, 0))),
      tint: W.uniform(new THREE.Vector3(1, 1, 1)),
      ext: W.uniform(new THREE.Vector3(...(/desert|dust|mars/i.test(String(o.style || '') + ' ' + String((o.body && o.body.name) || '')) ? EXT_DUST : EXT_AIR))),
    };
    // ── the dome ──
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    mat.fog = false; mat.depthWrite = false; mat.transparent = true;   // so it can thin out as you climb out of the air (setFade)
    mat.colorNode = W.Fn(() => {
      const d = W.normalize(W.positionLocal), h = d.y;
      const sunUp = U.dir.y;
      // day sky: gradient + horizon haze
      let day = W.mix(U.bot, U.top, W.smoothstep(W.float(-0.05), W.float(0.65), h));
      day = W.mix(day, U.haze, W.exp(h.max(0).mul(-7)).mul(0.8));
      // sunset: the horizon on the sun's side warms as it gets low
      const az = W.dot(W.normalize(W.vec3(d.x, 0, d.z)), W.normalize(W.vec3(U.dir.x, 0.0001, U.dir.z))).max(0);
      const low = W.smoothstep(W.float(0.35), W.float(0.02), sunUp).mul(W.smoothstep(W.float(-0.18), W.float(0.0), sunUp));
      const warm = W.vec3(1.0, 0.45, 0.18);
      day = W.mix(day, warm, low.mul(W.pow(az, W.float(3))).mul(W.exp(h.max(0).mul(-5))).mul(0.85));
      // night: almost clear — a deep blue that fades to black overhead
      const night = W.mix(U.haze.mul(0.06), W.vec3(0.004, 0.008, 0.02), W.smoothstep(W.float(0), W.float(0.5), h));
      let c = W.mix(night, day, U.day).mul(U.atm).add(W.vec3(0, 0, 0));
      // (v334) the system's real stars, each at its true direction and angular size, coloured by its temperature, dimmed and reddened by the
      // air's optical depth along the line of sight (airmass at that elevation), with its own forward-scatter aureole (Henyey-Greenstein,
      // in its colour and weight).  This replaces the old single fixed glare (a pow(sd,48)+pow(sd,6) halo + one 1.4 deg disc).
      c = c.mul(W.mix(W.vec3(1.0), U.tint, U.atm));
      const hp = h.max(0), X = W.float(1.0).div(hp.add(W.exp(hp.mul(-11)).mul(0.025))).sub(1.0);
      const trS = W.mix(W.vec3(1.0), W.exp(U.ext.mul(X).negate()), U.atm).mul(W.smoothstep(W.float(-0.02), W.float(0.01), h));
      const g = 0.8, g2 = g * g;
      for (let k = 0; k < 3; k++) {
        const S4 = U.sd[k], C4 = U.sc[k];
        const mu = W.dot(d, S4.xyz);
        const x = W.float(1.0).sub(mu).div(W.float(1.0).sub(S4.w).max(1e-7));          // (angle / angular radius)^2
        const limb = W.sqrt(W.float(1.0).sub(x).max(0)).mul(0.6).add(0.4);               // limb darkening
        const cov = W.smoothstep(W.float(1.12), W.float(0.88), x).mul(W.smoothstep(W.float(-0.02), W.float(0.01), h));
        // the disc: star radiance x the air's transmission, hue-preserving clamp (max channel 1.2) so a reddened low sun stays a bright red disc
        // and Veyra B stays orange instead of washing to white; it covers the sky behind it (a star is opaque), plus a little sky in front
        const dc = C4.xyz.mul(trS), dm = W.max(W.max(dc.x, dc.y), W.max(dc.z, W.float(1e-4)));
        const disc = dc.mul(W.min(W.float(1.0), W.float(1.2).div(dm))).mul(limb).mul(cov);
        const ph = W.float((1 - g2) / (4 * Math.PI)).div(W.pow(W.float(1 + g2).sub(mu.mul(2 * g)), W.float(1.5)));
        c = c.mul(W.float(1.0).sub(cov.mul(0.7))).add(disc).add(C4.xyz.mul(trS).mul(ph.mul(C4.w).mul(0.05 / 30).mul(U.atm)));   // aureole: 0.05 x the star (disc radiance ~30)
      }
      // below the horizon
      return W.mix(c, U.haze.mul(U.day.mul(0.8).add(0.05)).mul(U.atm), W.smoothstep(W.float(0), W.float(-0.25), h));
    })();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 24), mat);
    dome.userData.dmSkyShell = true;   // (v137) AR passthrough hides it (ui/dm-ar-core.js)
    dome.renderOrder = -10; dome.frustumCulled = false; dome.raycast = () => {};
    scene.add(dome);

    // ── stars: a faint field, the galaxy band, and a few bright ones ──
    const seed = rnd(1234567 + Math.round(((o.lat || 0) + 90) * 7));
    const starR = R * 0.92;
    const mkPoints = (n, band, size, col) => {
      const p = new Float32Array(n * 3), cc = new Float32Array(n * 3);
      const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.05, 0.3, 0.4));
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        if (band) { // concentrated toward a great circle (the galaxy's disc)
          const a = seed() * Math.PI * 2, off = (seed() + seed() + seed() - 1.5) * 0.18;
          v.set(Math.cos(a), off, Math.sin(a)).normalize().applyQuaternion(tilt);
        } else { const z = seed() * 2 - 1, a = seed() * Math.PI * 2, r = Math.sqrt(1 - z * z); v.set(r * Math.cos(a), z, r * Math.sin(a)); }
        p.set([v.x * starR, v.y * starR, v.z * starR], i * 3);
        const b = 0.45 + seed() * 0.55, warm = seed();
        const c = new THREE.Color(col || 0xffffff).lerp(new THREE.Color(warm > 0.7 ? 0xffd8b0 : (warm < 0.25 ? 0xb8ccff : 0xffffff)), 0.6).multiplyScalar(b);
        cc.set([c.r, c.g, c.b], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
function _dmDisc(){ if(window.dmSoftDiscTex) return window.dmSoftDiscTex(); if(window._dmLocalDisc) return window._dmLocalDisc;
  const c=document.createElement('canvas'); c.width=c.height=32; const g=c.getContext('2d'); const gr=g.createRadialGradient(16,16,0,16,16,16);
  [[0,1],[0.2,.82],[.4,.5],[.6,.22],[.8,.06],[1,0]].forEach(([s,a])=>gr.addColorStop(s,'rgba(255,255,255,'+a+')')); g.fillStyle=gr; g.fillRect(0,0,32,32);
  const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; window._dmLocalDisc=t; return t; }
      const m = new THREE.PointsMaterial({ size: size * 1.6, sizeAttenuation: false, vertexColors: true, map: _dmDisc(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = -9; pts.raycast = () => {};
      pts.userData.dir = Float32Array.from(p, (x) => x / starR); pts.userData.c0 = cc.slice();   // for the horizon extinction (below)
      return pts;
    };
    const field = mkPoints(1800, false, 1.6), galaxy = mkPoints(2600, true, 1.2, 0xc8d4ff);
    const stars = new THREE.Group(); stars.add(field, galaxy);
    // bright stars: small glowing sprites (visible faintly even by day)
    const glowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,.85)'); g.addColorStop(0.5, 'rgba(255,255,255,.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const bright = [];
    for (let i = 0; i < 14; i++) {
      const z = seed() * 1.6 - 0.6, a = seed() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      const col = [0xffffff, 0xcfe0ff, 0xffe6c0, 0xbcd0ff][i % 4];
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      s.position.set(r * Math.cos(a) * starR * 0.99, z * starR * 0.99, r * Math.sin(a) * starR * 0.99);
      const k = (i < 3 ? 22 : 12) * (R / 1000); s.scale.set(k, k, 1); s.renderOrder = -8; s.userData.base = i < 3 ? 1 : 0.7; s.raycast = () => {};
      stars.add(s); bright.push(s);
    }
    scene.add(stars);

    // ── comets and meteors ──
    const fx = new THREE.Group(); fx.renderOrder = -7; scene.add(fx);
    const streakTex = (() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 16; const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 256, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.85, 'rgba(255,250,235,.55)'); g.addColorStop(1, 'rgba(255,255,255,1)');
      x.fillStyle = g; x.fillRect(0, 4, 256, 8); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const live = [];
    // (v162) streaks and comet heads come from a small pool that is built once with the sky and never disposed: a fresh
    // MeshBasicMaterial per meteor (and its dispose a second later) cost a new shader + pipeline every time one crossed
    // the view — a multi-frame freeze on WebGPU. Pooled items are visible on the first frame (opacity 0, so the warm-up
    // compile and the first frame build their pipelines up front), then hide until a spawn takes them.
    const streakGeo = new THREE.PlaneGeometry(1, 1), pool = [], heads = [];
    const mkStreak = () => {
      const m = new THREE.Mesh(streakGeo, new THREE.MeshBasicMaterial({ map: streakTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, color: 0xfff2d0, side: THREE.DoubleSide }));
      m.raycast = () => {}; m.frustumCulled = false; m.userData.busy = false;
      m.onAfterRender = () => { if (!m.userData.busy) m.visible = false; };
      fx.add(m); pool.push(m); return m;
    };
    const mkHead = () => {
      const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xe8f6ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      h.raycast = () => {}; h.frustumCulled = false; h.userData.busy = false;
      h.onAfterRender = () => { if (!h.userData.busy) h.visible = false; };
      fx.add(h); heads.push(h); return h;
    };
    for (let i = 0; i < 3; i++) mkStreak();
    mkHead();
    const take = (arr, mk) => { let o = arr.find((x) => !x.userData.busy); if (!o) o = mk(); o.userData.busy = true; o.visible = true; o.material.opacity = 0; return o; };
    const give = (o) => { o.userData.busy = false; o.visible = false; o.material.opacity = 0; };
    // events come from the shared world clock: every player under this sky
    // sees the same comet (and the same meteors) at the same moment
    function spawn(kind, id, age) {
      const r = rnd((id * 2654435761 % 2147483647 + (kind === 'comet' ? 7 : 3)) % 2147483646 + 1);
      r(); r();
      const Math = { random: r, PI: window.Math.PI, cos: window.Math.cos, sin: window.Math.sin };
      const len = kind === 'comet' ? R * (0.22 + Math.random() * 0.12) : R * (0.05 + Math.random() * 0.06);
      const m = take(pool, mkStreak);
      m.scale.set(len, kind === 'comet' ? len * 0.06 : len * 0.02, 1);
      m.material.color.setHex(kind === 'comet' ? 0xd8f0ff : 0xfff2d0);
      // a start point high in the sky and a direction across it
      const el = 0.35 + Math.random() * 0.5, az = Math.random() * Math.PI * 2;
      const start = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(R * 0.85);
      const dir = new THREE.Vector3(Math.random() - 0.5, -0.25 - Math.random() * 0.4, Math.random() - 0.5).normalize();
      const head = kind === 'comet' ? take(heads, mkHead) : null;
      if (head) { const k = 26 * R / 1000; head.scale.set(k, k, 1); }
      live.push({ m, head, kind, t: age || 0, life: kind === 'comet' ? 40 + Math.random() * 30 : 0.7 + Math.random() * 0.8, start, dir, speed: kind === 'comet' ? R * 0.004 : R * 0.45, len });
    }
    const COMET_SLOT = 240, METEOR_SLOT = 6;   // a comet window every 4 minutes, a meteor chance every 6 s
    let lastComet = null, lastMeteor = null;
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), M4 = new THREE.Matrix4(), SUNSET = new THREE.Color(0xff9a5a);

    const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
    // transmission through the air at elevation sin(alt)=y: Kasten–Young-ish airmass, k≈0.28 mag-ish per airmass
    const ext = (y) => { if (!atmos) return y > -0.02 ? 1 : 0; if (y <= -0.01) return 0; const X = 1 / (Math.max(0, y) + 0.025 * Math.exp(-11 * Math.max(0, y))); return Math.exp(-0.22 * (X - 1)); };
    const extinct = (pts) => {
      const D = pts.userData.dir, C0 = pts.userData.c0, A = pts.geometry.attributes.color, C = A.array, q = stars.quaternion;
      const x = q.x, y = q.y, z = q.z, w = q.w;
      for (let i = 0; i < D.length; i += 3) {
        const vx = D[i], vy = D[i + 1], vz = D[i + 2];
        // world-up component of q·v
        const tx = 2 * (y * vz - z * vy), tz = 2 * (x * vy - y * vx);
        const wy = vy + w * (2 * (z * vx - x * vz)) + (z * tx - x * tz);
        const t = ext(wy), red = 1 - t;
        C[i] = C0[i] * t * (1 + 0.15 * red); C[i + 1] = C0[i + 1] * t * (1 - 0.1 * red); C[i + 2] = C0[i + 2] * t * (1 - 0.35 * red);
      }
      A.needsUpdate = true;
    };
    // per-star uniforms (no allocation): one legacy star = the old disc size in the world's sun colour
    const LEG_COS = Math.cos(0.0245), _tc = { r: 1, g: 1, b: 1 };
    function setStarUniforms(S, day) {
      let tr = 0, tg = 0, tb = 0, tw = 0;
      for (let k = 0; k < 3; k++) {
        const sd = U.sd[k].value, sc = U.sc[k].value;
        if (S && k < S.count) {
          const d = S.dir[k], c = S.col[k], br = 30 * Math.max(0.3, Math.min(3, Math.pow(S.temp[k] / 5778, 2))), dk = S.dayK[k] * S.w[k];
          sd.set(d.x, d.y, d.z, Math.cos(S.angR[k])); sc.set(c.r * br, c.g * br, c.b * br, dk);
          tr += c.r * dk; tg += c.g * dk; tb += c.b * dk; tw += dk;
        } else if (!S && k === 0) {
          const day0 = Math.max(0, Math.min(1, (sunDir.y + 0.1) / 0.25));
          sd.set(sunDir.x, sunDir.y, sunDir.z, LEG_COS); sc.set(sunCol.r * 30, sunCol.g * 30, sunCol.b * 30, day0);
        } else sc.set(0, 0, 0, 0);
      }
      // the daylight colour: the stars' colours by their share of the light (Sol alone = white = the old sky)
      if (tw > 1e-6) { _tc.r = tr / tw; _tc.g = tg / tw; _tc.b = tb / tw; } else { _tc.r = _tc.g = _tc.b = 1; }
      U.tint.value.set(_tc.r, _tc.g, _tc.b);
      ctl.tint = _tc;
    }
    const ctl = {
      dome, stars, sunDir, tint: _tc, starsLive: false, ext: U.ext.value.toArray(),   // ext: the air's zenith optical depth (DMStars' transmission uses the same) day: 1, sunLight: o.sunLight || null, fade: 1,
      // a: 1 = under the sky, 0 = above it (the air's own glow from outside takes over)
      setFade(a) {
        a = Math.max(0, Math.min(1, a)); ctl.fade = a;
        mat.opacity = a; dome.visible = a > 0.003;
      },
      // (v334) S = window.DMStars after its update for this world (index.html _pwStarsTick); null = the old analytic DMTime sun
      update(camera, dt, lat, lon, S) {
        if (!camera) return;
        dt = Math.min(0.1, dt || 0.016);
        // local time of day on the shared world clock (same for everyone)
        const t = (typeof window.worldSeconds === 'function') ? window.worldSeconds() : Date.now() / 1000;
        let H, phi = (lat || 0) * Math.PI / 180;
        if (window.DMTime && o.body) {
          // the real sky: hour angle from the body's own solar day on the world
          // clock (UTC on Earth), declination from its tilt and place in its year
          DMTime.sunDir(o.body, lat, lon, sunDir); sunDir.normalize();
          H = (((DMTime.dayFraction(o.body) + (lon || 0) / 360) % 1 + 1) % 1 - 0.5) * Math.PI * 2;
        } else {
          const len = DAY_WALL_SEC * (BODY_DAY[o.body && o.body.name] || 1);
          const frac = (((t / len) + (lon || 0) / 360) % 1 + 1) % 1;
          H = (frac - 0.5) * Math.PI * 2;
          // sun on a simple equatorial path, seen from this latitude (east = +x, north = -z)
          sunDir.set(-Math.sin(H), Math.cos(H) * Math.cos(phi), Math.cos(H) * Math.sin(phi)).normalize();
        }
        const useS = !!(S && S.valid && S.count > 0);
        if (useS) sunDir.set(S.keyDir.x, S.keyDir.y, S.keyDir.z);   // the key light IS the key star (the same direction the shadows use)
        if (sunDir.y < -0.999) sunDir.y = -0.999;
        const day = useS ? S.day : Math.max(0, Math.min(1, (sunDir.y + 0.1) / 0.25));
        ctl.day = day; U.day.value = day; U.dir.value.copy(sunDir);
        ctl.starsLive = useS; setStarUniforms(useS ? S : null, day);
        dome.position.copy(camera.position); stars.position.copy(camera.position); fx.position.copy(camera.position);
        // the real night sky for this hour and season: the star sphere turns about the celestial pole (which stands
        // at the site's latitude above the north horizon) by the local sidereal angle — the sun's hour angle plus its
        // place in the year — so which stars and which stretch of the galaxy band are up depends on the hour and the season
        let yr = 0;
        try { const el = window.DMTime && o.body && DMTime.SOL && DMTime.SOL[o.body.name]; yr = (DMTime.days() / (365.25 * Math.abs((el && el.P) || 1))) % 1; } catch (e) {}
        qA.setFromAxisAngle(AX, phi - Math.PI / 2); qB.setFromAxisAngle(AY, -(H + yr * Math.PI * 2));
        stars.quaternion.copy(qA).multiply(qB);
        const vis = (atmos ? Math.pow(1 - day, 1.5) : 1) * ctl.fade;
        // atmospheric extinction: stars dim and redden toward the horizon (airmass), gone below it — CPU, 4 Hz
        ctl._extT = (ctl._extT || 0) + dt;
        if (ctl._extT > 0.25 || !ctl._extOnce) { ctl._extT = 0; ctl._extOnce = true; extinct(field); extinct(galaxy);
          bright.forEach((s) => { v1.copy(s.position).normalize().applyQuaternion(stars.quaternion); s.userData.ext = ext(v1.y); }); }
        field.visible = galaxy.visible = vis > 0.03;
        field.material.opacity = vis; galaxy.material.opacity = vis;
        field.material.color.setScalar(vis); galaxy.material.color.setScalar(vis);
        bright.forEach((s) => { s.material.opacity = s.userData.base * Math.max(atmos ? 0.22 : 1, vis) * ctl.fade * (s.userData.ext == null ? 1 : s.userData.ext); });
        stars.visible = ctl.fade > 0.003;
        // meteors at night, comets now and then
        const cs = Math.floor(t / COMET_SLOT), ms = Math.floor(t / METEOR_SLOT);
        if (cs !== lastComet) {
          if (lastComet !== null || (t - cs * COMET_SLOT) < 70) {
            // about one window in two has a comet; it starts a seeded moment into the window
            const h = ((cs * 2654435761) >>> 0) / 4294967296, start = cs * COMET_SLOT + h * 60;
            if (h < 0.55 && t >= start && t - start < 70) spawn('comet', cs, t - start);
          }
          lastComet = cs;
        }
        if (ms !== lastMeteor) {
          lastMeteor = ms;
          const h = ((ms * 2246822519) >>> 0) / 4294967296;
          if (h < 0.45 && vis > 0.35) spawn('meteor', ms, 0);
        }
        for (let i = live.length - 1; i >= 0; i--) {
          const L = live[i]; L.t += dt;
          const a = L.t / L.life;
          if (a >= 1) { give(L.m); if (L.head) give(L.head); live.splice(i, 1); continue; }
          const p = v1.copy(L.start).addScaledVector(L.dir, L.speed * L.t);
          L.m.position.copy(p).addScaledVector(L.dir, -L.len * 0.5);
          // lie along its path, facing the viewer
          const toCam = v2.copy(p).negate().normalize();
          const side = v3.crossVectors(L.dir, toCam).normalize();
          const up = v4.crossVectors(side, L.dir);
          M4.makeBasis(L.dir, side, up); L.m.quaternion.setFromRotationMatrix(M4);
          const fade = Math.sin(Math.PI * a);
          const bright0 = L.kind === 'comet' ? (0.35 + 0.65 * vis) : vis;
          L.m.material.opacity = fade * bright0;
          if (L.head) { L.head.position.copy(p); L.head.material.opacity = fade * bright0; }
        }
        // the lights follow the sun: bright by day, cool starlight at night
        if (o.sunLight) {
          const under = atmos ? (0.08 + 0.92 * day) : (sunDir.y > -0.05 ? 1 : 0.06);
          o.sunLight.intensity = (o.sunBase || 2) * (under * ctl.fade + (1 - ctl.fade));   // above the air: full sun
          o.sunLight.color.copy(sunCol).lerp(SUNSET, atmos ? (1 - day) * Math.max(0, 1 - Math.abs(sunDir.y) * 6) * 0.7 : 0);
          // (v334) a binary's key light takes the key star's colour relative to the primary (one star / primary key: unchanged)
          if (ctl.starsLive && S && S.keyIdx > 0) { const a = S.col[S.keyIdx], p = S.col[0]; o.sunLight.color.r *= a.r / p.r; o.sunLight.color.g *= a.g / p.g; o.sunLight.color.b *= a.b / p.b; }
        }
        // fill (sky light): full by day; at night only what the night sky gives — galaxy/star skylight plus moonlight,
        // set from the game each frame (ctl.nightFill, a fraction of the day fill; 0.35 when nothing sets it)
        const nf = ctl.nightFill == null ? 0.35 : ctl.nightFill;
        // (t1537) outdoors in an atmosphere the key light leads by day: the flat hemisphere / ambient fill steps down to FILL_DAY of itself at full day (it used to stay
        // at full strength and washed the sun's shadows out). ctl.outdoor (0..1, eased by the game: 0 inside the mansion, whose rooms read these lights) scales the dip.
        // Night is untouched (nf), airless worlds are untouched. ?dayfill=<0..1> overrides FILL_DAY (1 = the old fill).
        const dd = atmos ? 1 - (1 - FILL_DAY) * clamp01(day) * (ctl.outdoor == null ? 1 : clamp01(ctl.outdoor)) : 1;
        (o.fill || []).forEach((l) => { if (l.userData._base == null) l.userData._base = l.intensity; l.intensity = l.userData._base * (nf + (1 - nf) * day) * dd; });
        if (scene.fog && atmos) { if (!ctl._fogDay) ctl._fogDay = scene.fog.color.clone(); scene.fog.color.copy(ctl._fogDay); if (window.DMPolish) DMPolish.warmFog(scene.fog.color, camera, sunDir, day); scene.fog.color.multiplyScalar(0.12 + 0.88 * day); }
        if (scene.background && scene.background.isColor && atmos) { if (!ctl._bgDay) ctl._bgDay = scene.background.clone(); scene.background.copy(ctl._bgDay).multiplyScalar(0.05 + 0.95 * day); }
      },
    };
    scene.userData.sky = ctl; scene.userData.skyDome = dome;
    return ctl;
  }
  window.DMSky = { create, starColor, DAY_WALL_SEC };
})();
