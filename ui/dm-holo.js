/* dm-holo.js — animated holographic panels + communication systems of Ariel's mansion (the Game lounge) and the skyboard landing court.
 *
 * Replaces the old static warm "glow" sheets (flat orange planes that floated through walls and windows at both LODs; removed from ariel-home*.glb, see
 * tools/ariel-home/patch_glb.py).  Everything here is free-standing, never touches a wall: panels hover on a projector post in clear floor space, the comm
 * relay is a ring tower in the middle of a rug-free corner.  One shared uniform block (time, room level), 6 draw calls total, no per-frame allocation,
 * hidden beyond 300 m or while the room's lights are OFF (the holo dims with the room switch, ui/dm-mansion-rooms.js, 'game').
 *
 *   panel kinds   0 mission board (scan lines + scrolling data bars)   1 comms waveform (voice trace + signal bars)   2 radar sweep (rings + rotating beam + blips)
 *   comm relay    a 3-ring tower: counter-rotating rings, upward pulse sweep, expanding signal arcs on the floor
 * Frame: the mansion nav frame (x east, y seaward, z up; 1.78 units = 1 m) mapped like ui/dm-lamps.js: three (x, z, -y).
 * Tunables / off switch: ?holo=0.  Node test (pure part): tools/tests/mansion-holo.js. */
(function () {
  'use strict';
  const G = typeof window !== 'undefined' ? window : globalThis;
  const UPM = 1.78, DRAW_D2 = 300 * 300;
  // [kind, x, y, zBottom, w, h, yaw (about three Y, 0 = facing nav -y i.e. toward the seating), tint rgb]
  const PANELS = [
    [0, 8.2, 33.4, 3.4, 9.6, 5.4, 0.0, [0.35, 0.75, 1.0]],     // left of the media console (over the rug, clear of the table at y 29-31.5 and the console at y 36)
    [1, 18.4, 33.4, 3.4, 9.6, 5.4, 0.0, [0.55, 0.95, 0.8]],    // right of it
    [2, 30.0, 33.0, 2.6, 6.4, 6.4, -0.55, [1.0, 0.62, 0.3]],   // radar, angled toward the sofas, beside the arcade
  ];
  const RELAY = [33.0, 22.0];                                    // comm relay tower footprint (x, y): free floor between the sofas and the arcade cabinets
  const IDX = r => (r && r.idx ? r.idx('game') : -1);

  // pure helpers (tested in node)
  function panelQuad(p) {            // 4 corners in three-local coordinates, CCW seen from the front
    const c = Math.cos(p[6]), s = Math.sin(p[6]), hw = p[4] * 0.5, x0 = p[1], z0 = -p[2], y0 = p[3] * 1.0, y1 = p[3] + p[5];
    const X = u => [x0 + u * c, 0, z0 - u * s];   // yaw rotates the width axis in the x/z plane
    const a = X(-hw), b = X(hw); return [[a[0], y0, a[2]], [b[0], y0, b[2]], [b[0], y1, b[2]], [a[0], y1, a[2]]];
  }
  function inRoom(x, y) { return x >= 0.5 && x <= 39.5 && y >= -2 && y <= 48.5; }

  const S = { F: null, rec: null, built: false, grp: null, U: null, mats: [], geos: [], t: 0, lvl: 1, on: !/[?&]holo=0\b/.test((G.location && G.location.search) || '') };

  function build(F, rec) {
    const c = F.ctx, THREE = c.THREE, T = THREE.TSL; if (!T || !T.uniform || !THREE.MeshBasicNodeMaterial) return false;
    const U = S.U = { t: T.uniform(0), lvl: T.uniform(1) };
    const grp = new THREE.Group(); grp.name = 'JOTS_ArielHolo'; grp.visible = false; S.grp = grp;
    const mk = (geo, mat, name) => { const m = new THREE.Mesh(geo, mat); m.name = name; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; m.renderOrder = 5; m.raycast = () => { }; S.geos.push(geo); S.mats.push(mat); grp.add(m); return m; };
    const hmat = () => new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const { float, vec2, vec3, vec4, sin, cos, fract, floor, smoothstep, abs, min, step, length, atan, uv } = T;
    const TAU = 6.2831853;
    PANELS.forEach((p, i) => {
      const q = panelQuad(p), P = new Float32Array(q.flat()), g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)); g.setIndex([0, 1, 2, 0, 2, 3]);
      const m = hmat(), u = uv(), t = U.t, tint = vec3(p[7][0], p[7][1], p[7][2]);
      const edge = float(1).sub(smoothstep(0.0, 0.035, min(min(u.x, float(1).sub(u.x)), min(u.y, float(1).sub(u.y)).mul(0.6))));          // frame glow
      const scan = sin(u.y.mul(150.0).sub(t.mul(3.0))).mul(0.5).add(0.5).mul(0.35).add(0.65);                                              // scan lines drifting down
      const flick = float(0.92).add(sin(t.mul(23.0).add(float(i * 5.1))).mul(0.05)).add(sin(t.mul(7.3)).mul(0.03));
      let body;
      if (p[0] === 0) {          // mission board: rows of data bars scrolling up at different speeds + a header strip
        const row = floor(u.y.mul(14.0)), rr = fract(sin(row.mul(12.9898)).mul(43758.5453)), sp = rr.mul(0.25).add(0.08);
        const x = fract(u.x.add(t.mul(sp))), len = rr.mul(0.55).add(0.15), bar = step(x, len).mul(step(float(0.18), fract(u.y.mul(14.0))));
        const hdr = step(float(0.9), u.y).mul(0.55);
        body = bar.mul(0.55).add(hdr).add(smoothstep(0.02, 0.0, abs(u.x.sub(fract(t.mul(0.21))))).mul(0.5));
      } else if (p[0] === 1) {   // comms: voice trace (sum of travelling sines) over signal-strength bars
        const y = float(0.62).add(sin(u.x.mul(26.0).sub(t.mul(5.0))).mul(0.10).mul(sin(u.x.mul(5.0).add(t.mul(1.7))).mul(0.5).add(0.5))).add(sin(u.x.mul(61.0).add(t.mul(9.0))).mul(0.025));
        const trace = smoothstep(0.022, 0.0, abs(u.y.sub(y)));
        const bi = floor(u.x.mul(16.0)), lv = sin(t.mul(2.2).add(bi.mul(1.7))).mul(0.5).add(0.5).mul(0.28).add(0.05), bars = step(u.y, lv).mul(step(fract(u.x.mul(16.0)), float(0.7))).mul(step(u.y, float(0.4)));
        body = trace.mul(1.2).add(bars.mul(0.6)).add(smoothstep(0.03, 0.0, abs(u.y.sub(0.45))).mul(0.12));
      } else {                    // radar: range rings + a sweeping beam with a fading tail + three drifting blips
        const d = vec2(u.x.sub(0.5), u.y.sub(0.5)).mul(2.0), r = length(d), ang = atan(d.y, d.x), sw = t.mul(1.4), da = fract(sw.sub(ang).div(TAU));
        const ring = smoothstep(0.02, 0.0, abs(fract(r.mul(3.0)).sub(0.5)).sub(0.47)).mul(step(r, float(1.0))).mul(0.35).add(smoothstep(0.03, 0.0, abs(r.sub(1.0))).mul(0.9));
        const beam = float(1).sub(da).pow(5.0).mul(step(r, float(1.0))).mul(0.9);
        const bl = (k) => { const a = t.mul(0.15).add(float(k * 2.1)), c0 = vec2(cos(a).mul(0.55), sin(a.mul(1.3)).mul(0.5)); return smoothstep(0.07, 0.0, length(d.sub(c0))).mul(float(1).sub(da.mul(0.8))); };
        body = ring.add(beam).add(bl(0)).add(bl(1)).add(bl(2)).mul(step(r, float(1.02)));
      }
      const a = body.mul(scan).mul(flick).add(edge.mul(0.9)).add(0.06).mul(U.lvl);
      m.colorNode = vec4(tint.mul(a.mul(1.6)), a.mul(0.75).clamp(0.0, 0.92)); m.fog = false;
      mk(g, m, 'holo_panel_' + i);
    });
    // communication relay tower: 3 counter-rotating rings on a thin core, a rising pulse, signal arcs on the floor
    {
      const m = hmat(), g = new THREE.CylinderGeometry(2.2, 2.2, 8.0 * 1.0, 48, 1, true), t = U.t, u = uv(), y = u.y;
      const rings = step(float(0.5), sin(y.mul(46.0)).mul(0.5).add(0.5)).mul(0.5).add(0.15);
      const seg = step(float(0.35), fract(u.x.mul(24.0).add(sin(y.mul(3.0)).mul(2.0)).add(t.mul(0.6)).mul(0.5))).mul(0.55).add(0.25);
      const pulse = smoothstep(0.12, 0.0, abs(y.sub(fract(t.mul(0.35))))).mul(0.7);
      const fade = smoothstep(0.0, 0.12, y).mul(smoothstep(1.0, 0.8, y));
      const a = rings.mul(seg).add(pulse).mul(fade).mul(U.lvl);
      m.colorNode = vec4(vec3(0.4, 0.85, 1.0).mul(a.mul(1.7)), a.mul(0.7).clamp(0.0, 0.9)); m.fog = false;
      const mesh = mk(g, m, 'holo_relay'); mesh.position.set(RELAY[0], 4.0, -RELAY[1]); S.relay = mesh;
      // signal arcs: concentric expanding rings on a floor disc
      const m2 = hmat(), g2 = new THREE.CircleGeometry(7.5, 48); g2.rotateX(-Math.PI / 2);
      const p2 = uv().sub(0.5).mul(2.0), r2 = length(p2), ph = fract(r2.mul(1.6).sub(t.mul(0.5)));
      const arcs = smoothstep(0.18, 0.0, ph).mul(float(1).sub(r2)).mul(step(r2, float(1.0)));
      m2.colorNode = vec4(vec3(0.35, 0.8, 1.0).mul(arcs.mul(1.5)), arcs.mul(0.55).mul(U.lvl)); m2.fog = false;
      const floor2 = mk(g2, m2, 'holo_relay_floor'); floor2.position.set(RELAY[0], 0.12, -RELAY[1]);
    }
    rec.group.add(grp); grp.updateMatrixWorld(true); c.mapTag(grp);
    S.built = true; return true;
  }
  function destroy() {
    try { if (S.grp && S.grp.parent) S.grp.parent.remove(S.grp); for (const g of S.geos) g.dispose(); for (const m of S.mats) m.dispose(); } catch (e) { }
    S.geos.length = 0; S.mats.length = 0; S.grp = null; S.built = false; S.U = null; S.relay = null;
  }
  const API = {
    attach(F, rec) { if (S.built) destroy(); S.F = F; S.rec = rec; },
    detach() { destroy(); S.rec = null; S.F = null; },
    tick(rec, d2, now, dt) {
      if (!S.on || rec !== S.rec || !S.F) return;
      if (!S.built) { if (d2 > DRAW_D2 || !rec.warmed) return; try { if (!build(S.F, rec)) { S.on = false; return; } } catch (e) { console.warn('[holo] build', e); S.on = false; return; } }
      const near = d2 < DRAW_D2; S.grp.visible = near; if (!near) return;
      S.t += dt; S.U.t.value = S.t % 600.0;
      const R = G.DMMansionRooms, i = IDX(R); const lv = i >= 0 && R.S ? R.S.lvl[i] : 1; S.lvl += (lv - S.lvl) * Math.min(1, dt * 6); S.U.lvl.value = Math.max(0.0, Math.min(1.0, (S.lvl - 0.18) / 0.82));
      if (S.relay) S.relay.rotation.y += dt * 0.35;
    },
    status() { return { built: S.built, on: S.on, t: +S.t.toFixed(1), lvl: +S.lvl.toFixed(2) }; },
    _pure: { PANELS, RELAY, panelQuad, inRoom, UPM },
  };
  G.DMHolo = API;
})();
