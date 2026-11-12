// DM Mansion Rooms — pure data + logic for the room light switches of Ariel's mansion (no THREE, no DOM: loads in node for the tests).
//
// Frame: the mansion's nav frame (x east, y seaward, z up; 1.78 units = 1 m), the same as assets/ariel-home/ariel-home-interior-nav.json.
//   • ROOMS      one entry per room: id, label, floor box (x0,y0,x1,y1,z0,z1) used to tag the interior mesh's vertices, the light switch position (a slim post
//                just inside the room's door, 1.3 m plates), and the auto levels (how lit the room is by day / by night when its switch is on AUTO).
//   • classify() which room a point belongs to (-1 = none: exterior faces, glass, the water). First match wins, so the loft is listed before the kitchen below it.
//   • level()    the lightness a room is drawn at: explicit ON / OFF from its switch, else AUTO from the world's day (0 night .. 1 day).
//   • State      per-room mode ('auto' | 'on' | 'off') + eased level (0.25 s fade, no allocation), save/load of the modes (older saves simply lack the field).
// The level is a multiplier on the room's diffuse colour in the interior material (ui/dm-mansion-look.js: one uniform array, nothing is added to the scene).
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const HX0 = -66.15, HX1 = 68.75, HY0 = -37.68, HY1 = -2.75;   // hall inner faces (tools/ariel-home/build_interior.py)
  // [x0, y0, x1, y1, z0, z1]
  const ROOMS = [
    { id: 'loft', label: 'Loft bedroom', box: [HX0, HY0, -31, -22, 9.3, 40], sw: [-31.6, -33.2, 10.2], night: 0.8, day: 0.75 },
    { id: 'kitchen', label: 'Kitchen & dining', box: [HX0, HY0, -34, HY1, -5, 40], sw: [-48.6, -4.4, 0.6], night: 1, day: 0.8 },
    { id: 'living', label: 'Living room', box: [-34, HY0, 4, HY1, -5, 40], sw: [-8.6, -4.4, 0.6], night: 1, day: 0.8 },
    { id: 'office', label: 'Office', box: [4, HY0, 33.6, HY1, -5, 40], sw: [8.6, -4.4, 0.6], night: 1, day: 0.8 },
    { id: 'pool', label: 'Pool room', box: [33.6, HY0, HX1, HY1, -5, 40], sw: [35.4, -7.2, 0.6], night: 0.9, day: 0.8 },
    { id: 'music', label: 'Music studio', box: [-40, -3, -0.01, 49, -5, 40], sw: [-8.6, 1.6, 0.1], night: 1, day: 0.8 },
    { id: 'game', label: 'Game lounge', box: [-0.01, -3, 40, 49, -5, 40], sw: [8.6, 1.6, 0.1], night: 1, day: 0.8 },
    { id: 'tip', label: 'Tip lounge', box: [-40, 49, 40, 80, -5, 40], sw: [2.8, 50.4, 0.1], night: 0.85, day: 0.8 },
    { id: 'workshop', label: 'Workshop', box: [-84, -91, -34, -69, -5, 40], sw: [-57.4, -71.2, 0.55], night: 0.85, day: 0.8 },
    { id: 'garage', label: 'Garage', box: [-34, -91, 6, -69, -5, 40], sw: [-7.0, -71.2, 0.55], night: 0.85, day: 0.8 },
  ];
  const N = ROOMS.length, OFF = 0.18, FADE = 0.25;   // OFF: moonlit-window murk, never pitch black

  // which room is point (x, y, z) in? -1 = none
  function classify(x, y, z) {
    for (let i = 0; i < N; i++) { const b = ROOMS[i].box; if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && z >= b[4] && z <= b[5]) return i; }
    return -1;
  }
  // 0 night .. 1 day  ->  how much of the night lamps the room shows on AUTO (the lamps ramp in through dusk)
  function autoLevel(i, day) { const r = ROOMS[i], d = day < 0 ? 0 : day > 1 ? 1 : day; return r.night + (r.day - r.night) * d; }
  function level(i, mode, day) { return mode === 'on' ? 1 : mode === 'off' ? OFF : autoLevel(i, day); }
  // true when the room reads as lit (what the switch shows and what a tap flips)
  function lit(i, mode, day) { return level(i, mode, day) > 0.5; }

  // dusk fade shared by lamps and rooms: world day (0..1, ui/dm-sky.js) -> lamp intensity 0..1. Fully off in daylight, fully on after sunset.
  function lampLevel(day) { const d = day < 0 ? 0 : day > 1 ? 1 : day, a = (0.62 - d) / 0.5, t = a < 0 ? 0 : a > 1 ? 1 : a; return t * t * (3 - 2 * t); }

  // (dusk 2) the outdoor lights (street lamps, rail LEDs, DMLight lamp level, DMVLight fog lights) follow the SUN ELEVATION, not the saturating `day` value (that is 1 from ~8.6 deg up, so it
  // cannot tell 14 deg from 40 deg): start fading in at DUSK_START deg above the horizon (well before dark), fully on at DUSK_END deg, smoothstep between.  `?dusk=<start deg>` tunes it.
  // Hysteresis: the elevation the ramp sees only moves once the real elevation has left a +-DUSK_BAND deg dead band round it, so a jittering sun (clouds, a body's wobble, a time scrub) never flickers a lamp.
  const DUSK_START = 14, DUSK_END = 0, DUSK_BAND = 0.35;
  const smooth01 = (a, b, v) => { const t = (v - a) / (b - a), u = t < 0 ? 0 : t > 1 ? 1 : t; return u * u * (3 - 2 * u); };
  function elevDeg(sunY) { const y = sunY < -1 ? -1 : sunY > 1 ? 1 : sunY; return Math.asin(y) * 180 / Math.PI; }
  function duskLevel(sunY, start) { const s0 = start > 0.5 ? start : DUSK_START; return smooth01(s0, DUSK_END, elevDeg(sunY)); }   // pure: 0 above `start` deg, 1 at/below 0 deg
  function duskElevFromDay(day) { const d = day < 0 ? 0 : day > 1 ? 1 : day; return (d * 0.25 - 0.1) * 57.2958 * 1.0; }   // fallback when only `day` is known (saturates at 8.6 deg: no early start)
  function duskState() { return { e: NaN }; }
  function duskStep(st, sunY, start) {   // stateful (hysteresis): returns the target lamp level 0..1
    const e = elevDeg(sunY); if (!(st.e === st.e)) st.e = e; else if (e > st.e + DUSK_BAND) st.e = e - DUSK_BAND; else if (e < st.e - DUSK_BAND) st.e = e + DUSK_BAND;
    return smooth01(start > 0.5 ? start : DUSK_START, DUSK_END, st.e);
  }

  const S = { mode: new Array(N).fill('auto'), lvl: new Float32Array(N).fill(1), tgt: new Float32Array(N).fill(1), seeded: false };
  const idx = id => { for (let i = 0; i < N; i++) if (ROOMS[i].id === id) return i; return -1; };
  const State = {
    ROOMS, N, OFF, FADE, S,
    idx, classify, autoLevel, level, lit, lampLevel, duskLevel, duskStep, duskState, duskElevFromDay, DUSK_START, DUSK_END, DUSK_BAND,
    mode(i) { return S.mode[i]; },
    // flip a room: what is lit now goes dark and the other way round (explicit, remembered); mode 'auto' puts it back on the world's clock
    toggle(i, day) { S.mode[i] = lit(i, S.mode[i], day) ? 'off' : 'on'; return S.mode[i]; },
    setMode(i, m) { if (m === 'on' || m === 'off' || m === 'auto') S.mode[i] = m; },
    resetAll() { for (let i = 0; i < N; i++) S.mode[i] = 'auto'; },
    // ease every room toward its target; returns true when any level moved (the caller then writes the uniforms). No allocation.
    step(dt, day) {
      let moved = false; const k = S.seeded ? Math.min(1, dt / FADE) : 1;
      for (let i = 0; i < N; i++) {
        const t = level(i, S.mode[i], day); S.tgt[i] = t; const d = t - S.lvl[i];
        if (d > 1e-4 || d < -1e-4) { S.lvl[i] = Math.abs(d) < 0.004 ? t : S.lvl[i] + d * k; moved = true; }
      }
      S.seeded = true; return moved;
    },
    // saves: only the rooms that are not on AUTO ({v:1, m:{kitchen:'off'}}); older saves lack the field
    get() { const m = {}; let any = false; for (let i = 0; i < N; i++) if (S.mode[i] !== 'auto') { m[ROOMS[i].id] = S.mode[i]; any = true; } return { v: 1, m: any ? m : {} }; },
    set(d) { State.resetAll(); const m = d && d.m; if (m && typeof m === 'object') for (const k in m) { const i = idx(k); if (i >= 0) State.setMode(i, m[k]); } },
  };
  G.DMMansionRooms = State;
  if (typeof module !== 'undefined' && module.exports) module.exports = State;
})();
