/* dm-holo.js — see-through animated holographic screens + the communication relay of Ariel's mansion (the Game lounge in the prow).
 *
 * (v4) Two canvas-driven screens replace the earlier procedural boards; both float INSIDE the glass of the prow, 3+ units clear of every window plane
 * (tools/tests/mansion-holo.js checks every corner against the prow room polygon, the tower base and its floor rings too):
 *   panel A  TRIPLE SPLIT 512x288: [1] computer — spinning wireframe, scrolling traces, gauges, hex readout, clock   [2] news — headline roll + crawl ticker
 *            [3] "movie" — a looping animated film (three procedural scenes with a cross-fade, letterbox, subtitles)
 *   panel B  GAME CONSOLE 320x200: console chrome (score bar, pad glyphs) around a small looping auto-played runner game
 *   Both are drawn with the 2D canvas at LOW CADENCE (A ~10 Hz, B ~12 Hz; stretched by ui/dm-budget.js stage 'hudfx' / 'props', paused beyond 160 units,
 *   while the room is dark or the tab hidden) and shown through ONE material each (alpha = content luminance over a faint plate: you see the room through them).
 *   No render target, no extra pass, no per-frame allocation, 4 draw calls in all.  The materials are built here from scratch (no GLB material, no map from the
 *   mansion atlas): no brick / cliff / rock texture can ever be bound to them.
 *   DROP-IN VIDEO: put a file anywhere under the site and point at it —   window.DM_HOLO = { movie: 'assets/ariel-home/holo/movie.mp4', game: '…/game.mp4' }  before this
 *   script, or ?holomovie=URL / ?hologame=URL, or DMHolo.setVideo('movie'|'game', url).  Videos are muted, looped, inline and rendered see-through exactly like the
 *   procedural content (the "movie" region of A, the game area of B); they decode only while the player is near and the room lit.
 * Frame: the mansion nav frame (x east, y seaward, z up; 1.78 units = 1 m) mapped like ui/dm-lamps.js: three (x, z, -y).  Off switch: ?holo=0.
 * Node test (pure part, mock canvas): tools/tests/mansion-holo.js. */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' && window ? window : globalThis;
  const UPM = 1.78, DRAW_D2 = 300 * 300, UPD_D2 = 160 * 160;
  // [id, x, y, zBottom, w, h, yaw (about three Y, 0 = facing nav -y i.e. toward the seating), tint rgb, canvas w, canvas h, update seconds]
  const PANELS = [
    ['A', 5.2, 35.0, 3.0, 8.4, 4.725, 0.0, [0.78, 0.95, 1.0], 512, 288, 0.1],      // above the west half of the (shortened) media console, over the rug
    ['B', 12.6, 35.0, 3.0, 5.4, 3.375, 0.0, [1.0, 0.92, 0.85], 320, 200, 0.083],   // beside it: the console screen
  ];
  const RELAY = [14.0, 13.0];                                    // comm relay tower footprint (x, y): open floor between the sofas and the arcade cabinets (>= 7 units clear of glass and props)
  const RELAY_R = 2.2, RING_R = 6.0;
  const ROOM = [[-32.86, -2.5], [32.86, -2.5], [13.99, 50.29], [0, 74.42], [-13.99, 50.29]];   // the prow glass footprint (build_mansion pr[] x 1.3; same as nav 'rooms')
  const IDX = r => (r && r.idx ? r.idx('game') : -1);

  // ── pure helpers (tested in node) ────────────────────────────────────────────────────────────────────────────
  function panelQuad(p) {            // 4 corners in three-local coordinates, CCW seen from the front
    const c = Math.cos(p[6]), s = Math.sin(p[6]), hw = p[4] * 0.5, x0 = p[1], z0 = -p[2], y0 = p[3], y1 = p[3] + p[5];
    const X = u => [x0 + u * c, 0, z0 - u * s];   // yaw rotates the width axis in the x/z plane
    const a = X(-hw), b = X(hw); return [[a[0], y0, a[2]], [b[0], y0, b[2]], [b[0], y1, b[2]], [a[0], y1, a[2]]];
  }
  function distEdge(x, y, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); }
  function insidePoly(x, y) { let c = false; for (let i = 0, j = ROOM.length - 1; i < ROOM.length; j = i++) { const a = ROOM[i], b = ROOM[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
  function glassClear(x, y) {        // signed distance (nav units) from (x, y) to the nearest glass plane: > 0 inside the room
    let m = 1e9; for (let i = 0; i < ROOM.length; i++) m = Math.min(m, distEdge(x, y, ROOM[i], ROOM[(i + 1) % ROOM.length])); return insidePoly(x, y) ? m : -m;
  }
  function inRoom(x, y, margin) { return glassClear(x, y) >= (margin || 0); }
  const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  // ── drawing (2D canvas API only; pure functions of time: no state, no allocation beyond short strings) ──────────────
  const HEX = '0123456789ABCDEF';
  const NEWS = ['ORBITAL RELAY BACK ONLINE', 'SOLENNE TIDES AT SEASON HIGH', 'SKYBOARD LEAGUE: FINAL HEAT TONIGHT', 'AURORA FORECAST: STRONG OVER THE PRIME TERRACE',
    'COMET SWARM PASSES THE OORT BELT', 'MEADOW MARKETS CLOSE UP 2.4 PCT', 'NEW BIRD TEMPLE ARRIVALS AT DOCK 7', 'WIND ADVISORY: CLEAR ABOVE 400 M'];
  const CRAWL = '   //   ARIEL HOUSE NETWORK   //   KELP FUTURES +1.8   //   TRANSIT: SKYBOARD LANES OPEN   //   WEATHER: CLEAR, LIGHT SEA BREEZE   //   ';
  function rgba(r, g, b, a) { return 'rgba(' + (r * 255 | 0) + ',' + (g * 255 | 0) + ',' + (b * 255 | 0) + ',' + a + ')'; }
  function box(c, x, y, w, h, col, lw) { c.strokeStyle = col; c.lineWidth = lw || 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
  function clipRect(c, x, y, w, h) { c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); }
  const CUBE = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

  function drawComputer(c, t, X, Y, W, H) {
    clipRect(c, X, Y, W, H);
    c.fillStyle = 'rgba(8,24,40,0.9)'; c.fillRect(X, Y, W, H);
    box(c, X, Y, W, H, 'rgba(120,220,255,0.9)', 2);
    c.fillStyle = 'rgba(80,190,255,0.35)'; c.fillRect(X + 3, Y + 3, W - 6, 18);
    c.fillStyle = '#bff'; c.font = 'bold 13px monospace'; c.textBaseline = 'top'; c.fillText('ARIEL // SYSTEM CORE', X + 8, Y + 6);
    const s = (t | 0) % 86400, hh = (s / 3600 | 0) % 24, mm = (s / 60 | 0) % 60, ss = s % 60;
    c.fillText((hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss, X + W - 70, Y + 6);
    // spinning wireframe: a cube inside an octahedron-ish second cube, projected with a slow tumble
    const cx = X + 76, cy = Y + 112, ay = t * 0.9, ax = t * 0.55, sy = Math.sin(ay), cy_ = Math.cos(ay), sx = Math.sin(ax), cx_ = Math.cos(ax);
    for (let k = 0; k < 2; k++) {
      const R = k ? 20 : 36, P = [];
      for (let i = 0; i < 8; i++) { const v = CUBE[i]; let x = v[0] * R, y = v[1] * R, z = v[2] * R; const x1 = x * cy_ + z * sy, z1 = -x * sy + z * cy_; const y1 = y * cx_ - z1 * sx, z2 = y * sx + z1 * cx_; const f = 150 / (150 + z2); P.push(cx + x1 * f, cy + y1 * f); }
      c.strokeStyle = k ? 'rgba(255,200,120,0.9)' : 'rgba(120,230,255,0.95)'; c.lineWidth = 1.5; c.beginPath();
      for (let e = 0; e < 12; e++) { c.moveTo(P[EDGES[e][0] * 2], P[EDGES[e][0] * 2 + 1]); c.lineTo(P[EDGES[e][1] * 2], P[EDGES[e][1] * 2 + 1]); }
      c.stroke();
    }
    c.strokeStyle = 'rgba(120,230,255,0.4)'; c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, 58 + Math.sin(t * 2) * 2, 0, 6.2832); c.stroke();
    // two scrolling traces
    const gx = X + 150, gy = Y + 34, gw = W - 160, gh = 74;
    box(c, gx, gy, gw, gh, 'rgba(120,220,255,0.5)', 1);
    for (let s2 = 0; s2 < 2; s2++) {
      c.strokeStyle = s2 ? 'rgba(255,170,90,0.95)' : 'rgba(110,255,200,0.95)'; c.lineWidth = 1.5; c.beginPath();
      for (let i = 0; i <= 40; i++) { const u = i / 40, yy = gy + gh * 0.5 + Math.sin(u * 9 + t * (1.6 + s2)) * gh * 0.22 * Math.sin(u * 3 + t * 0.7 + s2) + Math.sin(u * 31 - t * 5) * 4 * (s2 ? 1 : 0.5); if (i) c.lineTo(gx + gw * u, yy); else c.moveTo(gx + gw * u, yy); }
      c.stroke();
    }
    c.fillStyle = 'rgba(120,230,255,0.15)'; for (let i = 1; i < 6; i++) c.fillRect(gx + gw * i / 6, gy, 1, gh);
    // gauges
    for (let g = 0; g < 3; g++) {
      const gx0 = X + 170 + g * 52, gy0 = Y + 146, a1 = -2.4 + (Math.sin(t * (0.8 + g * 0.35) + g * 2) * 0.5 + 0.5) * 4.8;
      c.strokeStyle = 'rgba(120,220,255,0.35)'; c.lineWidth = 4; c.beginPath(); c.arc(gx0, gy0, 18, -2.4, 2.4); c.stroke();
      c.strokeStyle = g === 1 ? 'rgba(255,190,100,0.95)' : 'rgba(120,255,210,0.95)'; c.beginPath(); c.arc(gx0, gy0, 18, -2.4, a1); c.stroke();
      c.fillStyle = '#cff'; c.font = '10px monospace'; c.fillText('' + ((a1 + 2.4) / 4.8 * 100 | 0), gx0 - 8, gy0 - 5);
    }
    // hex readout + progress bars
    const q = (t * 2.5) | 0; c.font = '10px monospace'; c.fillStyle = 'rgba(140,230,255,0.9)';
    for (let r = 0; r < 4; r++) { let line = ''; for (let k = 0; k < 7; k++) line += HEX[(hash(q * 7 + r * 13 + k) * 16) | 0] + HEX[(hash(q * 3 + r * 5 + k * 11) * 16) | 0] + ' '; c.fillText(line, X + 10, Y + 196 + r * 13); }
    for (let r = 0; r < 4; r++) { const w = (Math.sin(t * (0.5 + r * 0.3) + r) * 0.5 + 0.5) * 112; c.fillStyle = 'rgba(80,200,255,0.25)'; c.fillRect(X + 180, Y + 202 + r * 15, 112, 7); c.fillStyle = r === 2 ? 'rgba(255,170,90,0.95)' : 'rgba(110,255,200,0.95)'; c.fillRect(X + 180, Y + 202 + r * 15, w, 7); }
    c.restore();
  }
  function drawNews(c, t, X, Y, W, H) {
    clipRect(c, X, Y, W, H);
    c.fillStyle = 'rgba(30,10,12,0.9)'; c.fillRect(X, Y, W, H); box(c, X, Y, W, H, 'rgba(255,140,120,0.9)', 2);
    c.fillStyle = 'rgba(255,70,60,0.85)'; c.fillRect(X + 3, Y + 3, W - 6, 17);
    c.fillStyle = '#fff'; c.font = 'bold 12px monospace'; c.textBaseline = 'top'; c.fillText('LIVE NEWS', X + 22, Y + 5);
    if (((t * 1.5) | 0) % 2 === 0) { c.beginPath(); c.arc(X + 13, Y + 12, 4, 0, 6.2832); c.fill(); }
    clipRect(c, X + 3, Y + 23, W - 6, H - 23 - 18);
    const rowH = 30, total = NEWS.length * rowH, off = (t * 14) % total;
    c.font = '11px monospace';
    for (let i = 0; i < NEWS.length + 4; i++) {
      const y = Y + 23 + i * rowH - off; if (y < Y - rowH || y > Y + H) continue; const n = NEWS[i % NEWS.length];
      c.fillStyle = 'rgba(255,200,170,0.95)'; c.fillText(n.length > 24 ? n.slice(0, 24) : n, X + 8, y + 2); c.fillStyle = 'rgba(255,200,170,0.6)'; c.fillText(n.length > 24 ? n.slice(24, 48) : '', X + 8, y + 15);
    }
    c.restore();
    c.fillStyle = 'rgba(255,200,170,0.22)'; c.fillRect(X + 3, Y + H - 18, W - 6, 15);
    c.fillStyle = '#fed'; c.font = '10px monospace'; const cw = 6.1 * CRAWL.length, ox = -((t * 38) % cw);
    clipRect(c, X + 3, Y + H - 18, W - 6, 15); c.fillText(CRAWL + CRAWL, X + 3 + ox, Y + H - 15); c.restore();
    c.restore();
  }
  // scene k at local time u (seconds): returns nothing, draws into (X,Y,W,H) — procedural "film" loop of three 5 s shots
  function drawMovieScene(c, k, u, X, Y, W, H) {
    if (k === 0) {            // dusk over mountains, a ship crossing the sun
      c.fillStyle = 'rgb(60,30,70)'; c.fillRect(X, Y, W, H); c.fillStyle = 'rgb(210,90,70)'; c.fillRect(X, Y + H * 0.45, W, H * 0.3);
      c.fillStyle = 'rgb(255,200,120)'; c.beginPath(); c.arc(X + W * 0.62, Y + H * 0.52 - u * 2, 15, 0, 6.2832); c.fill();
      for (let l = 0; l < 3; l++) { c.fillStyle = 'rgb(' + (40 - l * 12) + ',' + (22 - l * 6) + ',' + (50 - l * 10) + ')'; c.beginPath(); c.moveTo(X, Y + H); for (let i = 0; i <= 12; i++) { const x = X + W * i / 12, y = Y + H * (0.62 + l * 0.1) - (Math.sin(i * 1.7 + l * 2 + u * 0.15 * (l + 1)) * 0.5 + 0.5) * H * 0.2; c.lineTo(x, y); } c.lineTo(X + W, Y + H); c.fill(); }
      const sx = X + (u / 5) * (W + 40) - 20; c.fillStyle = '#fff'; c.fillRect(sx, Y + H * 0.28, 14, 3); c.fillRect(sx + 9, Y + H * 0.28 - 3, 4, 3);
    } else if (k === 1) {     // night city, a car streaking along the skyline, windows twinkling
      c.fillStyle = 'rgb(10,14,36)'; c.fillRect(X, Y, W, H);
      for (let i = 0; i < 9; i++) { const bw = W / 9, bh = H * (0.3 + hash(i + 3) * 0.45), bx = X + i * bw; c.fillStyle = 'rgb(20,26,56)'; c.fillRect(bx, Y + H - bh, bw - 2, bh); for (let w = 0; w < 6; w++) { const on = hash(i * 7 + w + ((u * 2) | 0)) > 0.45; if (on) { c.fillStyle = 'rgb(255,220,140)'; c.fillRect(bx + 4 + (w % 2) * 9, Y + H - bh + 6 + (w / 2 | 0) * 11, 4, 5); } } }
      const cxp = X + W - (u / 5) * (W + 30); c.fillStyle = 'rgb(255,80,90)'; c.fillRect(cxp, Y + H * 0.2, 14, 3); c.fillStyle = 'rgba(255,80,90,0.35)'; c.fillRect(cxp + 14, Y + H * 0.2 + 1, 36, 1);
    } else {                  // starfield flight toward a ringed planet
      c.fillStyle = 'rgb(4,6,18)'; c.fillRect(X, Y, W, H); c.fillStyle = '#fff';
      for (let i = 0; i < 46; i++) { const a = hash(i) * 6.2832, r = ((hash(i + 50) + u * 0.22) % 1), rr = r * r * W * 0.75; c.fillRect(X + W / 2 + Math.cos(a) * rr, Y + H / 2 + Math.sin(a) * rr * 0.7, 1 + r * 1.5, 1 + r * 1.5); }
      const pr = 10 + u * 4; c.fillStyle = 'rgb(120,170,255)'; c.beginPath(); c.arc(X + W * 0.7, Y + H * 0.45, pr, 0, 6.2832); c.fill();
      c.strokeStyle = 'rgba(255,220,160,0.9)'; c.lineWidth = 2; c.beginPath(); c.ellipse(X + W * 0.7, Y + H * 0.45, pr * 1.9, pr * 0.45, -0.3, 0, 6.2832); c.stroke();
    }
  }
  const SUBS = ['"...the tide always comes back."', '"Keep the lights on, I am nearly home."', '"Engage. All lanes are clear."'];
  function drawMovie(c, t, X, Y, W, H, video) {
    clipRect(c, X, Y, W, H);
    c.fillStyle = '#000'; c.fillRect(X, Y, W, H);
    const bar = Math.round(H * 0.12), ix = X, iy = Y + bar, iw = W, ih = H - bar * 2;
    clipRect(c, ix, iy, iw, ih);
    if (video) { const vw = video.videoWidth || 16, vh = video.videoHeight || 9, s = Math.max(iw / vw, ih / vh), dw = vw * s, dh = vh * s; c.drawImage(video, ix + (iw - dw) / 2, iy + (ih - dh) / 2, dw, dh); }
    else {
      const T = t % 15, k = (T / 5) | 0, u = T - k * 5; drawMovieScene(c, k, u, ix, iy, iw, ih);
      if (u > 4.2) { c.fillStyle = 'rgba(0,0,0,' + ((u - 4.2) / 0.8).toFixed(2) + ')'; c.fillRect(ix, iy, iw, ih); } else if (u < 0.5) { c.fillStyle = 'rgba(0,0,0,' + (1 - u / 0.5).toFixed(2) + ')'; c.fillRect(ix, iy, iw, ih); }
      c.fillStyle = 'rgba(255,255,255,0.9)'; c.font = '9px monospace'; c.textBaseline = 'top'; const sub = SUBS[k]; c.fillText(sub, ix + (iw - sub.length * 5.4) / 2, iy + ih - 12);
    }
    c.restore();
    c.fillStyle = 'rgba(255,255,255,0.06)'; for (let i = 0; i < 5; i++) c.fillRect(X, Y + hash(((t * 12) | 0) + i) * H, W, 1);
    box(c, X, Y, W, H, 'rgba(255,230,160,0.9)', 2);
    c.fillStyle = 'rgba(255,230,160,0.9)'; c.font = '8px monospace'; c.fillText('REC  A.R.I.E.L CINEMA', X + 6, Y + 3);
    c.restore();
  }
  function drawA(c, t, video) {
    c.clearRect(0, 0, 512, 288);
    drawComputer(c, t, 4, 4, 322, 280); drawNews(c, t, 332, 4, 176, 136); drawMovie(c, t, 332, 146, 176, 138, video);
  }
  // game: auto-played runner, 3.2 s of obstacle pattern looping.  Everything a closed-form function of t.
  const PATTERN = [0, 34, 12, 52, 22];
  function drawB(c, t, video) {
    c.clearRect(0, 0, 320, 200);
    c.fillStyle = 'rgba(14,16,30,0.95)'; c.fillRect(0, 0, 320, 200); box(c, 0, 0, 320, 200, 'rgba(255,200,150,0.95)', 3);
    c.fillStyle = 'rgba(255,170,90,0.9)'; c.fillRect(6, 6, 308, 18); c.fillStyle = '#210'; c.font = 'bold 12px monospace'; c.textBaseline = 'top';
    c.fillText('ARCADE-X', 12, 9); const score = (t * 37) | 0; c.fillText('SCORE ' + ('000000' + score).slice(-6), 130, 9); c.fillText('x' + (3 - (((t / 20) | 0) % 3)), 280, 9);
    const gx = 10, gy = 30, gw = 300, gh = 134;
    clipRect(c, gx, gy, gw, gh);
    if (video) { const vw = video.videoWidth || 16, vh = video.videoHeight || 9, s = Math.max(gw / vw, gh / vh); c.drawImage(video, gx + (gw - vw * s) / 2, gy + (gh - vh * s) / 2, vw * s, vh * s); }
    else {
      c.fillStyle = 'rgb(18,40,80)'; c.fillRect(gx, gy, gw, gh);
      const sc = t * 110, gnd = gy + gh - 24;
      for (let l = 0; l < 2; l++) { c.fillStyle = l ? 'rgb(40,90,120)' : 'rgb(28,64,100)'; for (let i = -1; i < 7; i++) { const w = 46 + l * 20, x = gx + i * (w + 18) - ((sc * (0.2 + l * 0.25)) % (w + 18)), h = 26 + hash(i + l * 9 + Math.floor(sc * (0.2 + l * 0.25) / (w + 18))) * 26; c.fillRect(x, gnd - h - l * 6, w, h + l * 6); } }
      c.fillStyle = 'rgb(60,200,120)'; c.fillRect(gx, gnd, gw, 24); c.fillStyle = 'rgb(30,120,70)'; for (let i = 0; i < 12; i++) c.fillRect(gx + ((i * 30 - sc) % 360 + 360) % 360 - 20, gnd + 4, 14, 3);
      // obstacles + coins in world space, pattern of 5 repeating every 5*150 px
      const px = gx + 56; let py = gnd - 14;
      for (let k = Math.floor(sc / 150) - 1; k < Math.floor(sc / 150) + 3; k++) {
        const hgt = 12 + PATTERN[((k % 5) + 5) % 5] * 0.3, ox = gx + k * 150 + 90 - sc, kind = (((k % 5) + 5) % 5);
        if (kind !== 0) { c.fillStyle = 'rgb(240,90,90)'; c.fillRect(ox, gnd - hgt, 14, hgt); c.fillRect(ox - 3, gnd - hgt, 20, 4); }
        const cx = ox + 70; c.fillStyle = 'rgb(255,220,80)'; c.beginPath(); c.arc(cx, gnd - 40 - PATTERN[((k % 5) + 5) % 5] * 0.6, 4, 0, 6.2832); c.fill();
        const d = ox - px; if (kind !== 0 && d > -18 && d < 54) { const u = (54 - d) / 72; py = gnd - 14 - Math.sin(Math.max(0, Math.min(1, u)) * 3.1416) * 38; }
      }
      c.fillStyle = 'rgb(255,255,255)'; c.fillRect(px, py, 14, 14); c.fillStyle = 'rgb(30,30,60)'; c.fillRect(px + 8, py + 3, 3, 3);
    }
    c.restore();
    box(c, gx, gy, gw, gh, 'rgba(255,200,150,0.5)', 1);
    // pad glyphs
    const on = ((t * 3) | 0) % 4;
    c.fillStyle = 'rgba(200,200,230,0.6)'; c.fillRect(24, 178, 24, 6); c.fillRect(33, 169, 6, 24); if (on === 0) { c.fillStyle = '#fff'; c.fillRect(33, 169, 6, 6); }
    const bx = [250, 272, 294], bc = ['rgb(255,90,90)', 'rgb(90,200,255)', 'rgb(255,220,90)'];
    for (let i = 0; i < 3; i++) { c.fillStyle = i === on - 1 ? '#fff' : bc[i]; c.beginPath(); c.arc(bx[i], 182, 7, 0, 6.2832); c.fill(); }
    c.fillStyle = 'rgba(255,200,150,0.9)'; c.font = '9px monospace'; c.fillText(((t * 2) | 0) % 2 ? 'PRESS START' : '           ', 118, 174);
  }

  // ── runtime ──────────────────────────────────────────────────────────────────────────────────────────────────
  const Q = (G.location && G.location.search) || '';
  const qv = k => { const m = new RegExp('[?&]' + k + '=([^&]+)').exec(Q); return m ? decodeURIComponent(m[1]) : null; };
  const CFG = Object.assign({ movie: null, game: null }, G.DM_HOLO || {}); if (qv('holomovie')) CFG.movie = qv('holomovie'); if (qv('hologame')) CFG.game = qv('hologame');
  const S = { F: null, rec: null, built: false, grp: null, U: null, geos: [], mats: [], tex: [], cv: [], vid: { movie: null, game: null }, t: 0, lvl: 1, acc: [0, 0], on: !/[?&]holo=0\b/.test(Q) };

  function makeVideo(url) {
    if (!url || !G.document) return null;
    try { const v = G.document.createElement('video'); v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.src = url; return v; } catch (e) { return null; }
  }
  function videoReady(v) { return v && v.readyState >= 2 && v.videoWidth > 0 ? v : null; }

  function build(F, rec) {
    const c = F.ctx, THREE = c.THREE, T = THREE.TSL; if (!T || !T.uniform || !T.texture || !THREE.MeshBasicNodeMaterial || !G.document) return false;
    const U = S.U = { t: T.uniform(0), lvl: T.uniform(1) };
    const grp = new THREE.Group(); grp.name = 'JOTS_ArielHolo'; grp.visible = false; S.grp = grp;
    const mk = (geo, mat, name) => { const m = new THREE.Mesh(geo, mat); m.name = name; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; m.renderOrder = 5; m.userData.noCollide = true; m.userData.noParallax = true; m.raycast = () => { }; S.geos.push(geo); S.mats.push(mat); grp.add(m); return m; };
    const hmat = (blend) => { const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: blend || THREE.NormalBlending }); m.name = 'holo_mat'; m.userData.holo = true; return m; };
    const { float, vec2, vec3, vec4, sin, fract, smoothstep, min, max, step, length, uv } = T;
    PANELS.forEach((p, i) => {
      const q = panelQuad(p), P = new Float32Array(q.flat()), g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)); g.setIndex([0, 1, 2, 0, 2, 3]);
      const cv = G.document.createElement('canvas'); cv.width = p[8]; cv.height = p[9]; const cx = cv.getContext('2d', { alpha: true }); if (!cx) throw new Error('2d canvas');
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 1;
      S.tex.push(tex); S.cv.push({ cv, cx });
      (i === 0 ? drawA : drawB)(cx, 0, null); tex.needsUpdate = true;
      const m = hmat(), u = uv(), t = U.t, tint = vec3(p[7][0], p[7][1], p[7][2]);
      const px = T.texture(tex, u), rgb = px.rgb, lum = max(max(rgb.r, rgb.g), rgb.b);
      const edgeD = min(min(u.x, float(1).sub(u.x)).mul(float(p[8] / p[9])), min(u.y, float(1).sub(u.y)));
      const edge = float(1).sub(smoothstep(0.0, 0.03, edgeD));                                                                              // frame glow
      const scan = sin(u.y.mul(p[9] * 0.9).sub(t.mul(2.0))).mul(0.5).add(0.5).mul(0.18).add(0.82);                                         // scan lines drifting down
      const flick = float(0.94).add(sin(t.mul(23.0).add(float(i * 5.1))).mul(0.04)).add(sin(t.mul(7.3)).mul(0.02));
      const a = lum.mul(1.15).clamp(0.0, 1.0).mul(0.82).add(0.16).add(edge.mul(0.4)).mul(U.lvl).clamp(0.0, 0.92);                         // faint plate + content
      const col = rgb.mul(tint).mul(1.25).mul(scan).mul(flick).add(vec3(0.35, 0.8, 1.0).mul(edge.mul(0.9)));
      m.colorNode = vec4(col, a); m.fog = false;
      mk(g, m, 'holo_panel_' + p[0]);
    });
    // communication relay tower: 3 counter-rotating rings on a thin core, a rising pulse, signal arcs on the floor
    {
      const m = hmat(THREE.AdditiveBlending), g = new THREE.CylinderGeometry(RELAY_R, RELAY_R, 8.0, 48, 1, true), t = U.t, u = uv(), y = u.y;
      const rings = step(float(0.5), sin(y.mul(46.0)).mul(0.5).add(0.5)).mul(0.5).add(0.15);
      const seg = step(float(0.35), fract(u.x.mul(24.0).add(sin(y.mul(3.0)).mul(2.0)).add(t.mul(0.6)).mul(0.5))).mul(0.55).add(0.25);
      const pulse = smoothstep(0.12, 0.0, T.abs(y.sub(fract(t.mul(0.35))))).mul(0.7);
      const fade = smoothstep(0.0, 0.12, y).mul(smoothstep(1.0, 0.8, y));
      const a = rings.mul(seg).add(pulse).mul(fade).mul(U.lvl);
      m.colorNode = vec4(vec3(0.4, 0.85, 1.0).mul(a.mul(1.7)), a.mul(0.7).clamp(0.0, 0.9)); m.fog = false;
      const mesh = mk(g, m, 'holo_relay'); mesh.position.set(RELAY[0], 4.0, -RELAY[1]); S.relay = mesh;
      const m2 = hmat(THREE.AdditiveBlending), g2 = new THREE.CircleGeometry(RING_R, 48); g2.rotateX(-Math.PI / 2);
      const p2 = uv().sub(0.5).mul(2.0), r2 = length(p2), ph = fract(r2.mul(1.6).sub(t.mul(0.5)));
      const arcs = smoothstep(0.18, 0.0, ph).mul(float(1).sub(r2)).mul(step(r2, float(1.0)));
      m2.colorNode = vec4(vec3(0.35, 0.8, 1.0).mul(arcs.mul(1.5)), arcs.mul(0.55).mul(U.lvl)); m2.fog = false;
      const floor2 = mk(g2, m2, 'holo_relay_floor'); floor2.position.set(RELAY[0], 0.12, -RELAY[1]);
    }
    S.vid.movie = makeVideo(CFG.movie); S.vid.game = makeVideo(CFG.game);
    rec.group.add(grp); grp.updateMatrixWorld(true); c.mapTag(grp);
    S.built = true; return true;
  }
  function destroy() {
    try {
      if (S.grp && S.grp.parent) S.grp.parent.remove(S.grp);
      for (const g of S.geos) g.dispose(); for (const m of S.mats) m.dispose(); for (const t of S.tex) t.dispose();
      for (const k of ['movie', 'game']) { const v = S.vid[k]; if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { } S.vid[k] = null; } }
    } catch (e) { }
    S.geos.length = 0; S.mats.length = 0; S.tex.length = 0; S.cv.length = 0; S.grp = null; S.built = false; S.U = null; S.relay = null; S.acc[0] = S.acc[1] = 0;
  }
  function cadence() {   // seconds multiplier from the frame-budget controller: stage 'hudfx' (L1 = half rate) and 'props' (L2 = another step)
    const B = G.DMBudget; if (!B || !B.lvl) return 1; let k = 1; try { k += (B.lvl('hudfx') | 0) * 1.0 + ((B.lvl('props') | 0) >= 2 ? 1.0 : 0.0); } catch (e) { } return k;
  }
  function setVideo(which, url) {
    CFG[which] = url || null; if (!S.built) return;
    const old = S.vid[which]; if (old) { try { old.pause(); old.removeAttribute('src'); old.load(); } catch (e) { } }
    S.vid[which] = makeVideo(url);
  }
  const API = {
    config: CFG, setVideo,
    attach(F, rec) { if (S.built) destroy(); S.F = F; S.rec = rec; },
    detach() { destroy(); S.rec = null; S.F = null; },
    tick(rec, d2, now, dt) {
      if (!S.on || rec !== S.rec || !S.F) return;
      if (!S.built) { if (d2 > DRAW_D2 || !rec.warmed) return; try { if (!build(S.F, rec)) { S.on = false; return; } } catch (e) { console.warn('[holo] build', e); S.on = false; destroy(); return; } }
      const near = d2 < DRAW_D2; S.grp.visible = near; if (!near) return;
      S.t += dt; S.U.t.value = S.t % 600.0;
      const R = G.DMMansionRooms, i = IDX(R); const lv = i >= 0 && R.S ? R.S.lvl[i] : 1; S.lvl += (lv - S.lvl) * Math.min(1, dt * 6); const L = Math.max(0.0, Math.min(1.0, (S.lvl - 0.18) / 0.82)); S.U.lvl.value = L;
      if (S.relay) S.relay.rotation.y += dt * 0.35;
      // screens: low-cadence canvas redraw while near, lit and the page visible
      const live = d2 < UPD_D2 && L > 0.02 && !(G.document && G.document.hidden), k = cadence();
      for (const w of ['movie', 'game']) { const v = S.vid[w]; if (!v) continue; if (live) { if (v.paused) { const pr = v.play(); if (pr && pr.catch) pr.catch(() => { }); } } else if (!v.paused) v.pause(); }
      if (!live) return;
      for (let n = 0; n < PANELS.length; n++) {
        S.acc[n] += dt; const period = PANELS[n][10] * k; if (S.acc[n] < period) continue; S.acc[n] = 0;
        const o = S.cv[n]; if (n === 0) drawA(o.cx, S.t, videoReady(S.vid.movie)); else drawB(o.cx, S.t, videoReady(S.vid.game)); S.tex[n].needsUpdate = true;
      }
    },
    status() { return { built: S.built, on: S.on, t: +S.t.toFixed(1), lvl: +S.lvl.toFixed(2), cadence: cadence(), movie: !!S.vid.movie, game: !!S.vid.game }; },
    _pure: { PANELS, RELAY, RELAY_R, RING_R, ROOM, panelQuad, inRoom, glassClear, UPM, drawA, drawB, hash },
  };
  G.DMHolo = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
