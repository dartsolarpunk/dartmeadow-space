/* (v134) Bird Temple room lights — switchable colour modes for every room, persisted in the save.
 *   Every room switch (IX_Switch_<room>: nav, mess, crew, store, engine, bay, cmd) now cycles
 *     AUTO (the existing dim/auto behaviour) → BRIGHT → WARM → COOL → NIGHT (pink-red, like nav's red-alert light) → OFF → AUTO.
 *   Hallways (group 'hall') keep their automatic lights. No lights are added: the room's existing virtual lamps change
 *   colour/level and the two BTL reading fills pick that up (ui/dm-bt-lighting.js setFill reads userData.btMinFill/btFillK).
 *   Engine room: toned down by default (it was the brightest room: low .55 + the 1.4 fill floor + reactor glow).
 *   Persistence: window.DMBtRoomLights.get()/set() — buildSaveData/loadSaveData carry it as an optional `btLights` field
 *   (older saves simply lack it), mirrored in localStorage 'dm_bt_lights' so it also survives a reload without a save.
 */
(function () {
  'use strict';
  const MODES = ['auto', 'bright', 'warm', 'cool', 'night', 'off'];
  const LABEL = { auto: 'AUTO', bright: 'BRIGHT', warm: 'WARM', cool: 'COOL', night: 'NIGHT', off: 'OFF' };
  const ICON = { auto: '🔆', bright: '💡', warm: '🕯', cool: '❄', night: '🌙', off: '⚫' };
  // [target (0 dim … 1 bright), colour or null = lamp's own, fill floor, fill scale]
  const SPEC = { bright: [1, null, 1.4, 1], warm: [0.7, [1.0, 0.66, 0.38], 1.1, 1], cool: [0.7, [0.62, 0.8, 1.0], 1.1, 1], night: [0.32, [1.0, 0.16, 0.2], 0.45, 0.7], off: [0, null, 0, 0] };
  const ENGINE = { low: 0.24, high: 1.5, minFill: 0.5, reactorK: 0.55 };
  const LS = 'dm_bt_lights';
  const RL = window.DMBtRoomLights = { modes: {}, MODES, ENGINE, applied: false };
  try { const j = JSON.parse(localStorage.getItem(LS) || 'null'); if (j && j.modes) RL.modes = clean(j.modes); } catch (e) {}
  function clean(m) { const o = {}; if (m && typeof m === 'object') for (const k in m) if (/^[a-z]{2,12}$/.test(k) && MODES.includes(m[k]) && k !== 'hall') o[k] = m[k]; return o; }
  RL.get = function () { const o = {}; for (const k in RL.modes) if (RL.modes[k] !== 'auto') o[k] = RL.modes[k]; return { v: 1, modes: o }; };
  RL.set = function (d) { RL.modes = clean(d && d.modes); persist(); syncTargets(); };
  function persist() { try { localStorage.setItem(LS, JSON.stringify(RL.get())); } catch (e) {} }
  function modeOf(g) { return RL.modes[g] || 'auto'; }
  function syncTargets() {
    const B = window.BTI; if (!B || !B.ready) return;
    for (const g in B.state.groups) { const m = modeOf(g); if (m !== 'auto') B.state.groups[g].target = SPEC[m][0]; else if (RL._wasSet && RL._wasSet[g]) B.state.groups[g].target = 0; }
    RL._wasSet = {}; for (const g in RL.modes) RL._wasSet[g] = true;
  }
  let reactorMats = null;
  function engineTone(B) {
    B.cfg.low.engine = ENGINE.low; B.cfg.high.engine = ENGINE.high;
    if (!reactorMats && window.BIRD_TEMPLE && BIRD_TEMPLE.group) { reactorMats = new Set();
      BIRD_TEMPLE.group.traverse(o => { const ms = o.isMesh ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) if (m && /^BTI_Reactor/.test(m.name || '') && !m.userData.btRlTone) { m.userData.btRlTone = true; if ('emissiveIntensity' in m) m.emissiveIntensity *= ENGINE.reactorK; reactorMats.add(m); } }); }
  }
  function hook() {
    const B = window.BTI; if (!B || !B.act || B._rlHooked) return !!(B && B._rlHooked);
    B._rlHooked = true;
    const act0 = B.act, upd0 = B.update;
    B.act = function () {
      const it = B.cur;
      if (it && it.type === 'switch' && it.group && it.group !== 'hall') {
        const G = B.state.groups[it.group]; if (!G) return act0.apply(this, arguments);
        const nx = MODES[(MODES.indexOf(modeOf(it.group)) + 1) % MODES.length];
        if (nx === 'auto') delete RL.modes[it.group]; else RL.modes[it.group] = nx;
        G.target = nx === 'auto' ? 0 : SPEC[nx][0];
        try { B.sfx && B.sfx.click && B.sfx.click(); } catch (e) {}
        try { if (typeof toast === 'function') toast(ICON[nx] + ' ' + it.group.toUpperCase() + ' lights: ' + LABEL[nx].toLowerCase(), 1600); } catch (e) {}
        persist(); return;
      }
      return act0.apply(this, arguments);
    };
    B.update = function (dt) {
      const r = upd0.apply(this, arguments);
      if (!B.ready) return r;
      if (!RL.applied) { RL.applied = true; engineTone(B); syncTargets(); }
      const al = B.state.alert;
      for (const l of B.lights) {
        const ud = l.L.userData || (l.L.userData = {}), m = modeOf(l.group);
        if (l.group === 'engine') { ud.btMinFill = ENGINE.minFill; ud.btFillK = 0.8; } else { delete ud.btMinFill; delete ud.btFillK; }
        if (m === 'auto') continue;
        const S = SPEC[m];
        if (al && (l.group === 'nav' || l.group === 'hall')) continue;   // red alert wins
        if (S[1]) l.L.color.setRGB(S[1][0], S[1][1], S[1][2]);
        if (m === 'off') l.L.intensity = 0;
        ud.btMinFill = S[2] * (l.group === 'engine' ? 0.6 : 1); ud.btFillK = S[3];
      }
      // HUD: the switch label names the NEXT mode
      const it = B.cur;
      if (it && it.type === 'switch' && it.group !== 'hall') { const tag = document.getElementById('bti-tag'), nx = MODES[(MODES.indexOf(modeOf(it.group)) + 1) % MODES.length], lb = 'LIGHTS: ' + LABEL[modeOf(it.group)] + ' → ' + LABEL[nx]; if (tag && tag.textContent !== lb) tag.textContent = lb; }
      return r;
    };
    return true;
  }
  RL.hook = hook;
  (function wait(n) { if (hook() || n > 600) return; setTimeout(() => wait(n + 1), 500); })(0);
})();
