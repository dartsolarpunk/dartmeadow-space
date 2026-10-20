/* dm-birdtemple.js — Bird Temple interior (hatch, decks, switches, animated screens, F action bubble).
 *
 * Everything lives here so index.html only needs: the GLB name, one <script> tag, and two
 * tiny material exemptions. The ship model carries glTF "extras" on named nodes:
 *   IX_Hatch   { ix:'hatch',  prompt, radius, openAngle, wheelTurns }   (children: IX_Hatch_Lid > IX_Hatch_Wheel)
 *   IX_Switch_<room> { ix:'switch', group:'nav'|'mess'|'crew'|'store'|'engine', prompt, radius }
 *   IX_NavButton { ix:'button', action:'alert', prompt, radius }
 *   LIGHT_*    { light:'#rrggbb', group }  (empties → small point lights, DIM by default, switchable)
 * Nodes named IX_* are left out of the walking collision (they move); the closed hatch lid is
 * added back as a floor patch below.
 *
 * Tuning knobs are on window.BTI.cfg (live, e.g. BTI.cfg.low.nav = 1.0).
 */
(function () {
  'use strict';
  const cfg = {
    // point-light candela per room group: DIM (night mode) and BRIGHT (switch flipped)
    low:  { nav: 0.42, mess: 0.42, crew: 0.36, store: 0.4, engine: 0.55, hall: 0.34 },
    high: { nav: 2.6,  mess: 2.8,  crew: 2.4,  store: 2.6, engine: 2.8, hall: 0.9 },
    dist: 3.4,              // world units of light reach (the ship is ~20 world units long)
    outsideGlobalK: 1.0,
    insideGlobalK: 0.10,    // multiplier on every non-interior scene light once she's below deck
    fade: 0.9,              // seconds for a light group to change level
  };
  const BTI = { cfg, ready: false, ix: [], lights: [], screens: {}, state: { groups: {}, alert: false }, cur: null };
  window.BTI = BTI;

  const $ = id => document.getElementById(id);
  const T = () => window.THREE;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = k => k * k * (3 - 2 * k);

  // ───────────────────────── tiny synth sounds (no assets) ─────────────────────────
  let _ac = null;
  function _audio() { try { if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)(); if (_ac.state === 'suspended') _ac.resume(); return _ac; } catch (e) { return null; } }
  function tone(f0, f1, dur, type, vol) {
    const ac = _audio(); if (!ac) return;
    try {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
      o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(vol || 0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { }
  }
  function noise(dur, vol, hp) {
    const ac = _audio(); if (!ac) return;
    try {
      const n = Math.floor(ac.sampleRate * dur), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = b; f.type = 'highpass'; f.frequency.value = hp || 1200; g.gain.value = vol || 0.05;
      s.connect(f); f.connect(g); g.connect(ac.destination); s.start();
    } catch (e) { }
  }
  const sfx = {
    click() { tone(1800, 900, 0.05, 'square', 0.04); noise(0.04, 0.05, 3000); },
    clunk() { tone(110, 50, 0.25, 'triangle', 0.12); noise(0.18, 0.06, 400); },
    servo(up) { tone(up ? 140 : 260, up ? 260 : 140, 1.4, 'sawtooth', 0.025); },
    hiss() { noise(0.9, 0.05, 2500); },
    alarm() { tone(880, 880, 0.18, 'square', 0.05); setTimeout(() => tone(660, 660, 0.18, 'square', 0.05), 220); },
    chirp() { tone(900, 1500, 0.12, 'sine', 0.05); },
  };
  BTI.sfx = sfx;

  // ───────────────────────── wraps of the game's own walk functions ─────────────────────────
  function _isIX(o, root) {
    for (let p = o; p && p !== root; p = p.parent) if (/^(IX_|FX_)/.test(p.name || '')) return true;
    return false;
  }
  function hook() {
    if (typeof _shipWalkMeshes === 'function' && !_shipWalkMeshes.__bti) {
      const orig = _shipWalkMeshes;
      _shipWalkMeshes = function () { const g = BIRD_TEMPLE.group; return orig().filter(o => !_isIX(o, g)); };
      _shipWalkMeshes.__bti = true;
    }
    if (typeof _shipGroundHeight === 'function' && !_shipGroundHeight.__bti) {
      const orig = _shipGroundHeight;
      _shipGroundHeight = function (wx, wz, fromY, fromAbove) {
        const r = orig(wx, wz, fromY, fromAbove);
        return BTI.ready ? lidFloor(wx, wz, fromY, fromAbove, r) : r;
      };
      _shipGroundHeight.__bti = true;
    }
    if (typeof updateShipWalk === 'function' && !updateShipWalk.__bti) {
      const orig = updateShipWalk;
      updateShipWalk = function (dt) { orig(dt); try { BTI.update(dt); } catch (e) { if (!BTI._err) { BTI._err = 1; console.warn('[BTI]', e); } } };
      updateShipWalk.__bti = true;
    }
    if (typeof enterShipWalk === 'function' && !enterShipWalk.__bti) {
      const orig = enterShipWalk;
      enterShipWalk = function () { orig(); BTI.onEnter(); };
      enterShipWalk.__bti = true;
    }
    if (typeof exitShipWalk === 'function' && !exitShipWalk.__bti) {
      const orig = exitShipWalk;
      exitShipWalk = function () { orig(); BTI.onExit(); };
      exitShipWalk.__bti = true;
    }
  }

  // The closed lid is a moving part (IX_), so it is not in the walking collision; stand on it here.
  function lidFloor(wx, wz, fromY, fromAbove, r) {
    const h = BTI.hatch;
    if (!h || h.p > 0.5) return r;                  // lid is up: the hole is open
    const g = BIRD_TEMPLE.group, p = g.worldToLocal(new (T().Vector3)(wx, fromAbove ? fromY + 50 : fromY, wz));
    const b = h.rect;
    if (p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ) return r;
    if (!fromAbove && p.y < b.top - 1.5) return r;   // beneath the lid (on the stairs): not the lid
    const wy = g.localToWorld(new (T().Vector3)(p.x, b.top, p.z)).y;
    return (r === null || r < wy) ? wy : r;
  }

  // ───────────────────────── init once the ship is in the scene ─────────────────────────
  function init() {
    const THREE = T(), g = BIRD_TEMPLE.group;
    g.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const local = o => g.worldToLocal(o.getWorldPosition(v.set(0, 0, 0)).clone());

    // materials: the game's self-light rebuild is skipped for BTI_ (see index.html), so tidy here
    const mats = new Set();
    g.traverse(o => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m && /^BTI_/.test(m.name || '')) mats.add(m); });
    });
    g.traverse(o => { if (o.isMesh && o.material && !Array.isArray(o.material) && /^BTI_/.test(o.material.name || '')) { o.castShadow = false; o.receiveShadow = false; } });
    mats.forEach(m => { m.vertexColors = false; if ('envMapIntensity' in m) m.envMapIntensity = 0.12; m.needsUpdate = true; });

    // interactables + light markers
    const lightMarks = [];
    g.traverse(o => {
      const u = o.userData || {};
      if (u.ix) BTI.ix.push({ obj: o, type: u.ix, prompt: u.prompt || 'Use', radius: (+u.radius || 5) * (u.ix === 'hatch' ? 2.25 : 1), group: u.group, action: u.action, ud: u });
      if (u.light && /^LIGHT_/.test(o.name)) lightMarks.push(o);
    });
    BTI.ix.forEach(it => {
      let ref = it.obj;
      if (it.type === 'hatch') ref = g.getObjectByName('IX_Hatch_Wheel') || it.obj;
      it.pos = local(ref);
    });

    // hatch
    const hat = BTI.ix.find(i => i.type === 'hatch');
    if (hat) {
      const lid = g.getObjectByName('IX_Hatch_Lid'), wheel = g.getObjectByName('IX_Hatch_Wheel');
      const box = new THREE.Box3().setFromObject(lid || hat.obj);
      const c = [], mn = new THREE.Vector3(1e9, 1e9, 1e9), mx = new THREE.Vector3(-1e9, -1e9, -1e9);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const p = g.worldToLocal(new THREE.Vector3(x, y, z)); mn.min(p); mx.max(p);
      }
      BTI.hatch = {
        node: hat, lid, wheel, p: 0, target: 0,
        q0: lid ? lid.quaternion.clone() : null, w0: wheel ? wheel.quaternion.clone() : null,
        openAngle: +hat.ud.openAngle || 1.75, turns: +hat.ud.wheelTurns || 2,
        rect: { minX: mn.x, maxX: mx.x, minZ: mn.z, maxZ: mx.z, top: mx.y },
        deckY: mn.y,
      };
    }

    // interior volume (for fading the outside world's lights once she is below deck)
    const grp = g.getObjectByName('BTI_Interior');
    if (grp) {
      const b = new THREE.Box3().setFromObject(grp);
      const pts = [];
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) pts.push(g.worldToLocal(new THREE.Vector3(x, y, z)));
      const mn = new THREE.Vector3(1e9, 1e9, 1e9), mx = new THREE.Vector3(-1e9, -1e9, -1e9);
      pts.forEach(p => { mn.min(p); mx.max(p); });
      BTI.vol = { mn, mx };
    }

    // point lights from the markers
    lightMarks.forEach(o => {
      const grpName = o.userData.group || 'hall';
      const col = new THREE.Color(o.userData.light || '#aabbff');
      const L = new THREE.PointLight(col, cfg.low[grpName] || 0.5, cfg.dist, 2);
      L.userData.bti = true; L.castShadow = false; L.visible = false;   // only lit (and counted by the renderer) while she is aboard
      o.add(L);
      BTI.lights.push({ L, group: grpName, base: col.clone(), level: 0 });
      if (!(grpName in BTI.state.groups)) BTI.state.groups[grpName] = { target: 0, k: 0 };
    });

    // switch levers start down (dim)
    BTI.ix.filter(i => i.type === 'switch').forEach(i => { i.obj.rotation.x = 0.5; i.k = 0; });

    buildScreens(mats);
    buildHud();
    BTI.ready = true;
    console.log('[BTI] interior ready:', BTI.ix.length, 'interactables,', BTI.lights.length, 'lights,', Object.keys(BTI.screens).length, 'screens');
  }

  // ───────────────────────── animated vector screens ─────────────────────────
  const COL = { bg: '#04121a', cy: '#6ff7ea', vi: '#b4a0ff', am: '#ffc266', rd: '#ff5a6a', gn: '#7dffa8', dim: 'rgba(111,247,234,.28)' };
  function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
  const STARS = (() => { const r = rng(7); return Array.from({ length: 70 }, () => ({ x: r(), y: r(), z: 0.2 + r() * 0.8 })); })();
  const BLIPS = (() => { const r = rng(11); return Array.from({ length: 9 }, () => ({ a: r() * 6.283, d: 0.2 + r() * 0.75, w: 0.1 + r() * 0.4 })); })();
  function shipInfo(t) {
    const g = BIRD_TEMPLE.group, p = g.position;
    const AU = (typeof AU_UNITS === 'number' && AU_UNITS > 0) ? AU_UNITS : 1;
    const hd = ((g.rotation.y * 180 / Math.PI) % 360 + 360) % 360;
    const s = BTI._speed || 0;
    return { x: p.x / AU, y: p.y / AU, z: p.z / AU, hd, spd: s, au: AU };
  }
  function txt(c, s, x, y, col, size, align) { c.fillStyle = col || COL.cy; c.font = (size || 16) + 'px ui-monospace,Menlo,Consolas,monospace'; c.textAlign = align || 'left'; c.fillText(s, x, y); }
  function frame(c, w, h, title, t) {
    c.fillStyle = COL.bg; c.fillRect(0, 0, w, h);
    c.strokeStyle = COL.dim; c.lineWidth = 1;
    for (let x = 0; x < w; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y < h; y += 32) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.strokeStyle = COL.cy; c.lineWidth = 3; c.strokeRect(4, 4, w - 8, h - 8);
    c.fillStyle = COL.cy; c.fillRect(4, 4, w - 8, 26); txt(c, title, 12, 24, '#04121a', 17);
    txt(c, (t % 60).toFixed(1).padStart(4, '0') + 's', w - 12, 24, '#04121a', 15, 'right');
    if (BTI.state.alert && Math.floor(t * 2) % 2 === 0) { c.fillStyle = 'rgba(255,60,80,.18)'; c.fillRect(0, 0, w, h); txt(c, '! RED ALERT !', w / 2, h - 14, COL.rd, 22, 'center'); }
  }
  const DRAW = {
    nav_a(c, w, h, t, I) {   // star chart + compass
      frame(c, w, h, 'NAV · STAR CHART', t);
      STARS.forEach(s => { const x = ((s.x * w - t * 6 * s.z) % w + w) % w, y = 36 + s.y * (h - 44); c.fillStyle = `rgba(200,240,255,${0.35 + s.z * 0.6})`; c.fillRect(x, y, 1 + s.z * 1.8, 1 + s.z * 1.8); });
      const cx = w * 0.5, cy = h * 0.55, R = Math.min(w, h) * 0.3;
      c.strokeStyle = COL.vi; c.lineWidth = 2;
      for (let k = 1; k <= 3; k++) { c.beginPath(); c.arc(cx, cy, R * k / 3, 0, 6.283); c.stroke(); }
      for (let a = 0; a < 360; a += 15) { const r = a * Math.PI / 180 - I.hd * Math.PI / 180; const l = a % 90 === 0 ? 16 : 8; c.beginPath(); c.moveTo(cx + Math.sin(r) * R, cy - Math.cos(r) * R); c.lineTo(cx + Math.sin(r) * (R + l), cy - Math.cos(r) * (R + l)); c.stroke(); }
      c.strokeStyle = COL.am; c.lineWidth = 3; c.beginPath(); c.moveTo(cx, cy - R - 20); c.lineTo(cx - 8, cy - R - 4); c.lineTo(cx + 8, cy - R - 4); c.closePath(); c.stroke();
      c.fillStyle = COL.cy; c.beginPath(); c.arc(cx, cy, 5, 0, 6.283); c.fill();
      txt(c, 'POS X ' + I.x.toFixed(4), 14, 56, COL.cy, 15); txt(c, '    Y ' + I.y.toFixed(4), 14, 74, COL.cy, 15); txt(c, '    Z ' + I.z.toFixed(4), 14, 92, COL.cy, 15);
      txt(c, 'HDG ' + I.hd.toFixed(0).padStart(3, '0') + '°', w - 14, 56, COL.am, 17, 'right');
    },
    nav_b(c, w, h, t, I) {   // telemetry traces
      frame(c, w, h, 'NAV · TELEMETRY', t);
      const traces = [['THRUST', COL.cy, 1.3, 0], ['DRIFT', COL.vi, 0.7, 2], ['BUOY', COL.am, 2.1, 4]];
      traces.forEach(([n, col, f, ph], i) => {
        const y0 = 70 + i * ((h - 90) / 3), hh = (h - 110) / 6;
        c.strokeStyle = col; c.lineWidth = 2; c.beginPath();
        for (let x = 0; x <= w - 24; x += 4) { const u = (x / 60 + t * 0.9 * f); const y = y0 + Math.sin(u + ph) * hh * 0.6 + Math.sin(u * 2.7 + ph) * hh * 0.25; x ? c.lineTo(12 + x, y) : c.moveTo(12 + x, y); }
        c.stroke(); txt(c, n, 14, y0 - hh + 6, col, 13);
        txt(c, (50 + 40 * Math.sin(t * f + ph)).toFixed(1), w - 14, y0 - hh + 6, col, 13, 'right');
      });
    },
    nav_c(c, w, h, t, I) {   // signal scope + coordinate list
      frame(c, w, h, 'NAV · ARC EDGE SIGNAL', t);
      for (let L = 0; L < 3; L++) {
        c.strokeStyle = [COL.cy, COL.vi, COL.gn][L]; c.globalAlpha = 0.85 - L * 0.2; c.lineWidth = 2; c.beginPath();
        for (let x = 0; x <= w - 24; x += 3) { const u = x / (40 + L * 25) - t * (1.2 + L * .5); const y = h * 0.46 + Math.sin(u) * (38 - L * 8) * Math.sin(x / 90 + t * .5 + L); x ? c.lineTo(12 + x, y) : c.moveTo(12 + x, y); }
        c.stroke();
      }
      c.globalAlpha = 1;
      const wp = [['WPT-A', 0.18, 0.62], ['WPT-B', -0.31, 0.12], ['WPT-C', 0.44, -0.27]];
      wp.forEach(([n, a, b], i) => txt(c, `${n}  ${(I.x + a).toFixed(3)} ${(I.z + b).toFixed(3)}  ${(1.2 + i * .7 + Math.sin(t + i) * .05).toFixed(2)}AU`, 14, h - 62 + i * 18, COL.dim.replace('.28', '.9'), 14));
    },
    nav_d(c, w, h, t, I) {   // bar array
      frame(c, w, h, 'NAV · SYSTEMS', t);
      const labels = ['THR', 'SHD', 'BUO', 'GRV', 'RFX', 'PWR', 'COM', 'LEA'];
      const bw = (w - 40) / labels.length;
      labels.forEach((n, i) => {
        const v = 0.45 + 0.4 * Math.sin(t * (0.8 + i * .23) + i * 1.7) * Math.sin(t * .37 + i);
        const x = 20 + i * bw, bh = (h - 100) * clamp(v, 0.08, 1), col = v > 0.8 ? COL.am : COL.cy;
        c.fillStyle = 'rgba(111,247,234,.12)'; c.fillRect(x + 6, 50, bw - 14, h - 100);
        c.fillStyle = col; c.fillRect(x + 6, h - 50 - bh, bw - 14, bh);
        txt(c, n, x + bw / 2 - 2, h - 28, COL.vi, 13, 'center');
      });
    },
    radar(c, w, h, t, I) {   // sweep scope
      frame(c, w, h, 'RADAR · LONG RANGE', t);
      const cx = w / 2, cy = h / 2 + 12, R = Math.min(w, h) / 2 - 34;
      c.strokeStyle = COL.dim.replace('.28', '.6'); c.lineWidth = 1.5;
      for (let k = 1; k <= 4; k++) { c.beginPath(); c.arc(cx, cy, R * k / 4, 0, 6.283); c.stroke(); }
      c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
      const sw = t * 1.6 % 6.283;
      for (let i = 0; i < 30; i++) { c.strokeStyle = `rgba(111,247,234,${(1 - i / 30) * 0.5})`; c.lineWidth = 3; const a = sw - i * 0.03; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); c.stroke(); }
      BLIPS.forEach((b, i) => {
        const a = b.a + t * 0.02 * (i % 2 ? 1 : -1), d = ((sw - a) % 6.283 + 6.283) % 6.283, fade = clamp(1 - d / 4.5, 0, 1);
        if (fade > 0) { c.fillStyle = `rgba(255,194,102,${fade})`; c.beginPath(); c.arc(cx + Math.cos(a) * R * b.d, cy + Math.sin(a) * R * b.d, 3 + b.w * 5, 0, 6.283); c.fill(); }
      });
      c.fillStyle = COL.gn; c.beginPath(); c.arc(cx, cy, 4, 0, 6.283); c.fill();
    },
    sector(c, w, h, t, I) {  // orbital sector map
      frame(c, w, h, 'SECTOR MAP ' + String(Math.floor(Math.abs(I.x * 7 + I.z * 3)) % 90 + 10) + '-' + 'ABCDEFGH'[Math.floor(Math.abs(I.y * 100 + I.x * 50)) % 8], t);
      const cx = w * 0.35, cy = h * 0.58;
      [28, 52, 82, 118, 160].forEach((r, i) => {
        c.strokeStyle = COL.dim.replace('.28', '.55'); c.lineWidth = 1.5; c.beginPath(); c.ellipse(cx, cy, r * 1.5, r * 0.62, 0, 0, 6.283); c.stroke();
        const a = t * (0.5 / (i + 1)) + i * 1.3; c.fillStyle = [COL.am, COL.vi, COL.cy, COL.gn, COL.am][i]; c.beginPath(); c.arc(cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r * 0.62, 4 + (i === 2 ? 3 : 0), 0, 6.283); c.fill();
      });
      c.fillStyle = COL.am; c.beginPath(); c.arc(cx, cy, 9, 0, 6.283); c.fill();
      c.setLineDash([6, 6]); c.strokeStyle = COL.gn; c.lineWidth = 2; c.beginPath(); c.moveTo(cx - 130, cy + 60); c.lineTo(w - 40, 70); c.stroke(); c.setLineDash([]);
      c.strokeStyle = COL.rd; c.lineWidth = 2; const px = cx - 130 + ((t * 14) % 200) * 0.0, py = cy + 60; c.strokeRect(px - 8, py - 8, 16, 16);
      txt(c, 'TEMPLE', px + 14, py + 4, COL.rd, 13);
    },
    menu(c, w, h, t, I) {    // galley menu
      frame(c, w, h, 'GALLEY · TODAY', t);
      const items = ['NOODLE BOWL', 'ROOT STEW', 'BREAD + HONEY', 'SEA GREENS', 'TEA / WATER', 'MOON PEARS'];
      items.forEach((s, i) => { const on = Math.floor(t / 2) % items.length === i; txt(c, (on ? '> ' : '  ') + s, 24, 66 + i * 30, on ? COL.am : COL.cy, 20); });
      txt(c, 'CREW 24 · SEATS 32', 24, h - 18, COL.vi, 15); txt(c, 'STORE ' + (92 - Math.floor(t / 30) % 3) + '%', w - 20, h - 18, COL.gn, 15, 'right');
    },
    engine(c, w, h, t, I) {  // reactor
      frame(c, w, h, 'ENGINEERING · CORE', t);
      [0, 1, 2].forEach(i => {
        const cx = 80 + i * 100, cy = 100, v = 0.7 + 0.25 * Math.sin(t * (1 + i * .4) + i);
        c.strokeStyle = 'rgba(180,160,255,.25)'; c.lineWidth = 10; c.beginPath(); c.arc(cx, cy, 34, 0, 6.283); c.stroke();
        c.strokeStyle = [COL.cy, COL.vi, COL.am][i]; c.beginPath(); c.arc(cx, cy, 34, -1.57, -1.57 + 6.283 * v); c.stroke();
        txt(c, 'RING ' + 'ABC'[i], cx, cy + 5, COL.cy, 13, 'center');
      });
      c.strokeStyle = COL.gn; c.lineWidth = 2; c.beginPath();
      for (let x = 0; x < w - 30; x += 3) { const y = h - 70 + Math.sin(x / 14 + t * 4) * 12 * (0.6 + 0.4 * Math.sin(x / 60 + t)); x ? c.lineTo(15 + x, y) : c.moveTo(15 + x, y); }
      c.stroke();
      txt(c, 'CORE STABLE   OUTPUT 100%   FLUX ' + (0.8 + 0.04 * Math.sin(t * 3)).toFixed(2), 16, h - 20, COL.cy, 15);
    },
    crew(c, w, h, t, I) {    // lights + status roster
      frame(c, w, h, 'CREW · SHIP STATUS', t);
      const G = BTI.state.groups, rows = [['NAV', 'nav'], ['MESS', 'mess'], ['STORE', 'store'], ['CREW', 'crew'], ['ENGINE', 'engine']];
      rows.forEach(([n, k], i) => { const on = G[k] && G[k].target > 0.5; txt(c, n.padEnd(7) + 'LIGHTS ' + (on ? 'BRIGHT' : 'DIM'), 20, 62 + i * 28, on ? COL.am : COL.cy, 18); });
      txt(c, 'ALERT  ' + (BTI.state.alert ? 'ON' : 'OFF'), 20, h - 40, BTI.state.alert ? COL.rd : COL.gn, 18);
      txt(c, 'CREW 24 ABOARD', 20, h - 14, COL.vi, 15);
    },
  };
  function buildScreens(mats) {
    const THREE = T();
    mats.forEach(m => {
      const mm = /^BTI_Holo_(.+)$/.exec(m.name || ''); if (!mm || !DRAW[mm[1]] || BTI.screens[mm[1]]) return;
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 320;
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 4;
      m.map = tex; m.emissiveMap = tex; m.needsUpdate = true;
      BTI.screens[mm[1]] = { cv, ctx: cv.getContext('2d'), tex, mat: m };
    });
  }
  function drawScreens(t) {
    const I = shipInfo(t);
    for (const k in BTI.screens) {
      const s = BTI.screens[k]; try { DRAW[k](s.ctx, 512, 320, t, I); s.tex.needsUpdate = true; } catch (e) { }
    }
  }

  // ───────────────────────── F action bubble (HUD) ─────────────────────────
  function buildHud() {
    if ($('bti-f')) return;
    const css = document.createElement('style');
    css.textContent = `
#bti-f{position:absolute;left:22px;bottom:calc(196px + var(--safe-bot,0px));width:84px;height:84px;border:0;padding:0;background:none;z-index:33;
  pointer-events:none;opacity:0;transform:scale(.4);transition:opacity .18s,transform .28s cubic-bezier(.2,1.5,.4,1);touch-action:none;-webkit-tap-highlight-color:transparent;}
#bti-f.on{opacity:1;transform:scale(1);pointer-events:auto;}
@media (orientation:portrait){#bti-f{bottom:calc(300px + var(--safe-bot,0px));}}
#bti-f .bb{position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(circle at 32% 26%,rgba(190,255,250,.55),rgba(60,120,200,.18) 42%,rgba(20,10,60,.55) 78%);
  border:1.5px solid rgba(150,255,245,.8);box-shadow:0 0 18px rgba(80,255,235,.45),inset 0 0 22px rgba(120,100,255,.4);}
#bti-f svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}
#bti-f .spin{transform-origin:42px 42px;animation:btiSpin 6s linear infinite;}
#bti-f .spin2{transform-origin:42px 42px;animation:btiSpin 9s linear infinite reverse;}
@keyframes btiSpin{to{transform:rotate(360deg)}}
#bti-f .f{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--font-hud,ui-monospace,monospace);font-weight:800;font-size:2.15rem;
  color:#eafffd;text-shadow:0 0 6px #6ff7ea,0 0 16px #6ff7ea,0 0 30px #8a6bff;letter-spacing:0;}
#bti-f:active .bb{transform:scale(.93);box-shadow:0 0 30px rgba(80,255,235,.9),inset 0 0 26px rgba(180,150,255,.7);}
#bti-f .bb{transition:transform .08s,box-shadow .12s;}
#bti-f .tag{position:absolute;left:50%;bottom:-24px;transform:translateX(-50%);white-space:nowrap;font-family:var(--font-hud,ui-monospace,monospace);
  font-size:.55rem;letter-spacing:.14em;color:#04121a;background:#6ff7ea;padding:3px 8px;border-radius:8px;box-shadow:0 0 12px rgba(111,247,234,.7);}
#bti-f .tag:before{content:"";position:absolute;left:50%;top:-4px;margin-left:-4px;border:4px solid transparent;border-top:0;border-bottom-color:#6ff7ea;}
`;
    document.head.appendChild(css);
    const b = document.createElement('button');
    b.id = 'bti-f'; b.type = 'button'; b.setAttribute('aria-label', 'Interact');
    b.innerHTML = `<div class="bb"></div>
<svg viewBox="0 0 84 84"><g class="spin"><circle cx="42" cy="42" r="38" fill="none" stroke="#6ff7ea" stroke-width="2" stroke-dasharray="26 14 6 14" opacity=".95"/></g>
<g class="spin2"><circle cx="42" cy="42" r="33" fill="none" stroke="#b4a0ff" stroke-width="1.4" stroke-dasharray="3 7" opacity=".9"/></g>
<path d="M10 22 L10 10 L22 10 M62 10 L74 10 L74 22 M74 62 L74 74 L62 74 M22 74 L10 74 L10 62" fill="none" stroke="#ffc266" stroke-width="2"/></svg>
<div class="f">F</div><div class="tag" id="bti-tag">USE</div>`;
    const jb = $('ship-jump-btn'); const host = (jb && jb.parentNode) || document.body; host.appendChild(b);
    const fire = e => { e.preventDefault(); e.stopPropagation(); BTI.act(); };
    b.addEventListener('touchstart', fire, { passive: false });
    b.addEventListener('mousedown', fire);
    window.addEventListener('keydown', e => { if (e.code === 'KeyF' && !e.repeat && BTI.cur && SHIP_WALK.active) { e.preventDefault(); BTI.act(); } });
  }
  function showHud(it) {
    const b = $('bti-f'); if (!b) return;
    if (!it) { b.classList.remove('on'); return; }
    let label = it.prompt;
    if (it.type === 'hatch') label = BTI.hatch && BTI.hatch.target ? 'CLOSE HATCH' : 'OPEN HATCH';
    else if (it.type === 'switch') label = (BTI.state.groups[it.group] && BTI.state.groups[it.group].target ? 'LIGHTS DIM' : 'LIGHTS BRIGHT');
    else if (it.type === 'button') label = BTI.state.alert ? 'STAND DOWN' : 'RED ALERT';
    const tag = $('bti-tag'); if (tag && tag.textContent !== label) tag.textContent = label;
    b.classList.add('on');
  }

  // ───────────────────────── actions ─────────────────────────
  BTI.act = function () {
    const it = BTI.cur; if (!it) return;
    if (it.type === 'hatch') {
      const h = BTI.hatch; if (!h) return;
      if (h.target === 0) { h.target = 1; sfx.clunk(); setTimeout(() => sfx.servo(true), 450); toast('⚙ Turning the wheel — hatch opening', 2200); }
      else {
        const p = SHIP_WALK.localPos, r = h.rect;
        if (p.x > r.minX && p.x < r.maxX && p.z > r.minZ && p.z < r.maxZ && p.y > r.top - 1.5) { toast('Step off the hatch first', 1600); return; }
        h.target = 0; sfx.servo(false); toast('⚙ Closing the hatch', 1800);
      }
    } else if (it.type === 'switch') {
      const G = BTI.state.groups[it.group]; if (!G) return;
      G.target = G.target ? 0 : 1; sfx.click();
      toast(G.target ? '💡 ' + it.group.toUpperCase() + ' lights: bright' : '🌙 ' + it.group.toUpperCase() + ' lights: dim', 1600);
    } else if (it.type === 'button') {
      BTI.state.alert = !BTI.state.alert; (BTI.state.alert ? sfx.alarm : sfx.chirp)();
      toast(BTI.state.alert ? '🚨 RED ALERT' : '✅ Alert cleared', 1800);
      const nb = it.obj; nb.position.y += BTI.state.alert ? -0.12 : 0.12;   // button presses in / pops out
    }
  };

  // ───────────────────────── per-frame ─────────────────────────
  const _lastP = { v: null, t: 0 };
  const _gl = new Map();   // global scene lights → {base, applied}
  let _glScan = 0;
  BTI.update = function (dt) {
    if (!BTI.ready) return;
    const THREE = T(), t = (BTI._t = (BTI._t || 0) + dt);
    const P = SHIP_WALK.localPos, g = BIRD_TEMPLE.group;
    // ship speed readout (world units/s)
    if (!_lastP.v) _lastP.v = g.position.clone();
    else if (dt > 0) { BTI._speed = g.position.distanceTo(_lastP.v) / dt; _lastP.v.copy(g.position); }
    // nearest interactable
    let best = null, bd = 1e9;
    for (const it of BTI.ix) {
      const dx = P.x - it.pos.x, dz = P.z - it.pos.z;
      let d;
      if (it.type === 'hatch') { if (Math.abs(P.y - it.pos.y) > 3) continue; d = Math.hypot(dx, dz); }
      else d = Math.hypot(dx, dz, P.y + 2.5 - it.pos.y);   // from about chest height, so the deck above/below never counts
      if (d <= it.radius && d < bd) { bd = d; best = it; }
    }
    if (best !== BTI.cur) { BTI.cur = best; if (best) sfx.chirp(); }
    showHud(BTI.cur);
    // hatch animation (wheel first, then lid)
    const h = BTI.hatch;
    if (h) {
      const sp = dt / 3.2; h.p = h.target > h.p ? Math.min(h.target, h.p + sp) : Math.max(h.target, h.p - sp);
      const wk = ease(clamp(h.p / 0.45, 0, 1)), lk = ease(clamp((h.p - 0.4) / 0.6, 0, 1));
      if (h.wheel && h.w0) h.wheel.quaternion.copy(h.w0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), wk * h.turns * 6.2832));
      if (h.lid && h.q0) h.lid.quaternion.copy(h.q0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lk * h.openAngle));
      if (h._prev !== undefined && h._prev < 0.99 && h.p >= 0.99) sfx.hiss();
      h._prev = h.p;
    }
    // light groups
    const kf = Math.min(1, dt / cfg.fade);
    for (const k in BTI.state.groups) { const G = BTI.state.groups[k]; G.k += (G.target - G.k) * kf; }
    const al = BTI.state.alert, pulse = 0.5 + 0.5 * Math.sin(t * 5);
    for (const l of BTI.lights) {
      const G = BTI.state.groups[l.group], lo = cfg.low[l.group] || 0.5, hi = cfg.high[l.group] || 2;
      let I = lo + (hi - lo) * (G ? G.k : 0);
      if (al && (l.group === 'nav' || l.group === 'hall')) { I = Math.max(I, 1.2) * (0.5 + pulse); l.L.color.setRGB(1, 0.12 + 0.1 * pulse, 0.15); }
      else l.L.color.copy(l.base);
      l.L.intensity = I;
    }
    // lever tilt
    for (const it of BTI.ix) if (it.type === 'switch') {
      const G = BTI.state.groups[it.group], want = G && G.target ? -0.5 : 0.5;
      it.obj.rotation.x += (want - it.obj.rotation.x) * Math.min(1, dt * 14);
    }
    // below deck: fade the outside world's lights so the interior reads as night
    let depth = 0;
    const V = BTI.vol, hh = BTI.hatch;
    if (V && hh && P.x > V.mn.x - 2 && P.x < V.mx.x + 2 && P.z > V.mn.z - 2 && P.z < V.mx.z + 2) depth = clamp((hh.deckY - 0.8 - P.y) / 6, 0, 1);
    BTI._depth = BTI._depth === undefined ? depth : BTI._depth + (depth - BTI._depth) * Math.min(1, dt * 3);
    applyGlobalDim(1 + (cfg.insideGlobalK - 1) * ease(BTI._depth), t);
    // screens ~10 fps, only while she is near / inside the interior
    BTI._sc = (BTI._sc || 0) + dt;
    if (BTI._sc > 0.1 && (depth > 0 || BTI.cur)) { BTI._sc = 0; drawScreens(t); }
  };
  function applyGlobalDim(k, t) {
    if (typeof flightScene === 'undefined' || !flightScene) return;
    if (t - _glScan > 2.5 || !_gl.size) { _glScan = t; flightScene.traverse(o => { if (o.isLight && !(o.userData && o.userData.bti) && !_gl.has(o)) _gl.set(o, { base: o.intensity, applied: o.intensity }); }); }
    for (const [l, r] of _gl) {
      if (l.intensity !== r.applied) r.base = l.intensity;            // the game rewrote it: that is the new base
      if (k >= 0.999 && r.applied === r.base) continue;
      l.intensity = r.base * k; r.applied = l.intensity;
    }
  }
  BTI.onEnter = function () { _glScan = -99; BTI.lights.forEach(l => { l.L.visible = true; }); };
  BTI.onExit = function () {
    showHud(null); BTI.cur = null; BTI.lights.forEach(l => { l.L.visible = false; });
    for (const [l, r] of _gl) { if (l.intensity === r.applied) l.intensity = r.base; r.applied = l.intensity; }
    BTI._depth = 0;
  };

  // ───────────────────────── boot ─────────────────────────
  let tries = 0;
  const boot = setInterval(() => {
    tries++;
    try {
      if (typeof BIRD_TEMPLE !== 'undefined' && BIRD_TEMPLE.group && window.THREE && typeof SHIP_WALK !== 'undefined') {
        hook();
        let found = false; BIRD_TEMPLE.group.traverse(o => { if (o.userData && o.userData.ix) found = true; });
        clearInterval(boot);
        if (found) init(); else console.log('[BTI] this Bird Temple model has no interior nodes — module idle');
      } else if (typeof _shipWalkMeshes === 'function') hook();
    } catch (e) { console.warn('[BTI] init', e); clearInterval(boot); }
    if (tries > 600) clearInterval(boot);
  }, 500);
})();
