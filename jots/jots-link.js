/*
 * JOTS Link — DART Meadow: Journey of the Skyboard's connection to the
 * LEATR framework (the private DART-Skyboard/leatr-ash repository and its
 * Apps Script bridge). This public file only transmits and receives; the
 * services it talks to are operated from leatr-ash.
 *
 *   • Sign in with GitHub (device flow through the same Apps Script bridge
 *     Autumn uses) or play as a guest.
 *   • Signed-in players get a private repository, jots-<username>, that
 *     keeps their saves (and their multiplayer chat) and loads them back
 *     automatically — the same pattern as Autumn's Autumn-Ash-<username>.
 *     Guests keep the existing local save / export / import.
 *   • Anonymous gameplay analytics (no names, ids, chat or positions) are
 *     batched into the LEATR live analytics maze, so the Session Cubes on
 *     dartmeadow.com, the Autumn apps and the Bird Temple show game activity.
 *   • Multiplayer: every player in multiplayer mode shares one world. State
 *     travels over the leatr-ash jots-relay when one is configured
 *     (window.JOTS_RELAY_URL), otherwise over a public MQTT broker.
 *
 * Nothing here holds a secret: the OAuth client id is public, the client
 * secret stays in the Apps Script project, and each player's GitHub token
 * stays in their own browser.
 */
(function () {
  'use strict';

  const CFG = {
    gas: 'https://script.google.com/macros/s/AKfycbyzkQxLR5miUXP6oDw-1AR1GIjgpzlw9iLw0gO_ZTeLfL849LWbNX7WVz_kf7yLWBKA_w/exec',
    clientId: 'Ov23li2K0njEqO1WTSdD',
    scopes: 'repo,read:user',
    repoPrefix: 'jots-',
    relay: window.JOTS_RELAY_URL || '',
    mqtt: window.JOTS_MQTT_URL || 'wss://broker.emqx.io:8084/mqtt',
    mqttLib: 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js',
    topic: 'dartmeadow/jots/v1',
    room: 'world',
    stateHz: 4,
    peerTimeoutMs: 12000,
    // Each analytics write is a GitHub commit made by the Apps Script bridge's
    // token (5,000 API calls/hour shared by every app), so batch generously.
    analyticsFlushMs: 120000,
    exportMinGapMs: 300000,
    vaultAutosaveMs: 120000,
  };
  const LS = {
    consent: 'jots_consent_v1',
    identity: 'jots_identity_v1',
    token: 'jots_gh_token_v1',
  };
  const ls = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const rid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n || 8))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const unb64 = (s) => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ''))));
  const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent('jots:' + name, { detail })); } catch (e) {} };

  // ── Identity ────────────────────────────────────────────────────────
  // A random session id for multiplayer (never the GitHub id), and a name:
  // the GitHub login when signed in, otherwise Guest-xxxx.
  const identity = ls.get(LS.identity) || { kind: 'guest', name: 'Guest-' + rid(2).toUpperCase(), avatar: '' };
  const sessionId = rid(6);
  function saveIdentity() { ls.set(LS.identity, identity); }

  // ── GitHub API ──────────────────────────────────────────────────────
  let token = ls.get(LS.token);
  async function gh(method, path, body) {
    const r = await fetch('https://api.github.com' + path, {
      method,
      headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub ' + r.status);
    return r.status === 204 ? {} : r.json();
  }

  // ── Sign in: GitHub device flow via the Apps Script bridge ──────────
  const auth = {
    get signedIn() { return identity.kind === 'github' && !!token; },
    identity,
    async deviceCode() {
      // Direct first (form-encoded avoids a CORS preflight), bridge fallback.
      try {
        const r = await fetch('https://github.com/login/device/code', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'client_id=' + CFG.clientId + '&scope=' + encodeURIComponent(CFG.scopes),
        });
        const d = await r.json();
        if (d.device_code) return d;
      } catch (e) {}
      const r = await fetch(CFG.gas + '?action=devicecode');
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      return d;
    },
    // Polls until GitHub hands back a token (or the code expires).
    async waitForToken(dev, onTick) {
      const until = Date.now() + (dev.expires_in || 900) * 1000;
      let wait = Math.max(5, dev.interval || 5) * 1000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, wait));
        if (onTick) onTick();
        let d;
        try { d = await (await fetch(CFG.gas + '?action=devicepoll&device_code=' + encodeURIComponent(dev.device_code))).json(); }
        catch (e) { continue; }
        if (d.access_token) return d;
        if (d.error === 'slow_down') wait += 5000;
        else if (d.error && d.error !== 'authorization_pending') throw new Error(d.error);
      }
      throw new Error('The sign-in code expired — try again.');
    },
    async finish(d) {
      token = d.access_token;
      ls.set(LS.token, token);
      identity.kind = 'github';
      identity.name = d.username;
      identity.avatar = d.avatar_url || '';
      saveIdentity();
      emit('auth', { signedIn: true, name: identity.name });
      try { await vault.ensure(); } catch (e) { console.warn('[JOTS] vault:', e); }
      return identity;
    },
    // Re-validate a stored token on load.
    async restore() {
      if (!token || identity.kind !== 'github') return false;
      try {
        const u = await gh('GET', '/user');
        if (!u || !u.login) throw new Error('bad token');
        identity.name = u.login; identity.avatar = u.avatar_url || ''; saveIdentity();
        emit('auth', { signedIn: true, name: identity.name });
        vault.ensure().catch(() => {});
        return true;
      } catch (e) { this.signOut(true); return false; }
    },
    guest() {
      identity.kind = 'guest';
      if (!/^Guest-/.test(identity.name)) identity.name = 'Guest-' + rid(2).toUpperCase();
      identity.avatar = '';
      saveIdentity();
      emit('auth', { signedIn: false, name: identity.name });
    },
    signOut(silent) {
      token = null; ls.del(LS.token);
      vault.ready = false;
      this.guest();
      if (!silent) emit('auth', { signedIn: false, name: identity.name });
    },
  };

  // ── Vault: the player's private jots-<username> repository ─────────
  const vault = {
    ready: false,
    shas: {},
    get repo() { return identity.name ? CFG.repoPrefix + identity.name : ''; },
    async ensure() {
      if (!auth.signedIn) return false;
      const full = '/repos/' + identity.name + '/' + this.repo;
      let repo = await gh('GET', full);
      if (!repo) {
        await gh('POST', '/user/repos', {
          name: this.repo, private: true, auto_init: true,
          description: 'DART Meadow · Journey of the Skyboard — your saves and game data (private) · LEATR',
        });
        await this.put('README.md', '# Journey of the Skyboard — game data\n\nKept automatically by DART Meadow for ' + identity.name +
          '.\n\n- `saves/` — your game saves (autosave + slots)\n- `profile.json` — your pilot profile\n- `chat/` — your multiplayer chat log\n\nPrivate to you. Do not edit by hand while the game is open.\n');
        await this.putJSON('profile.json', { pilot: identity.name, created: new Date().toISOString(), game: 'jots' });
      }
      this.ready = true;
      emit('vault', { ready: true, repo: this.repo });
      return true;
    },
    async get(path) {
      const f = await gh('GET', '/repos/' + identity.name + '/' + this.repo + '/contents/' + path);
      if (!f) return null;
      this.shas[path] = f.sha;
      return unb64(f.content || '');
    },
    async put(path, text, message) {
      if (this.shas[path] === undefined) { try { await this.get(path); } catch (e) {} }
      const body = { message: message || 'jots: ' + path, content: b64(text) };
      if (this.shas[path]) body.sha = this.shas[path];
      const r = await gh('PUT', '/repos/' + identity.name + '/' + this.repo + '/contents/' + path, body);
      if (r && r.content) this.shas[path] = r.content.sha;
      return r;
    },
    putJSON(path, obj, message) { return this.put(path, JSON.stringify(obj, null, 1), message); },
    async save(data, name) {
      if (!this.ready) return false;
      await this.putJSON('saves/' + (name || 'autosave') + '.json', data, 'jots: save ' + (name || 'autosave'));
      return true;
    },
    async load(name) {
      if (!this.ready) return null;
      const t = await this.get('saves/' + (name || 'autosave') + '.json');
      return t ? JSON.parse(t) : null;
    },
    async appendChat(lines) {
      if (!this.ready || !lines.length) return;
      const day = new Date().toISOString().slice(0, 10), path = 'chat/' + day + '.json';
      let log = [];
      try { const t = await this.get(path); if (t) log = JSON.parse(t); } catch (e) {}
      await this.putJSON(path, log.concat(lines), 'jots: chat ' + day);
    },
  };

  // ── Anonymous analytics → the LEATR live maze ───────────────────────
  // Gameplay events only (what happened, never who): category jots_game,
  // a short label and an optional coarse detail (a count or a place key).
  // Batched, appended to the live maze's current chunk, and merged into
  // its latest export so every Session Cube viewer picks them up.
  const analytics = {
    queue: [],
    lastExport: 0,
    busy: false,
    track(label, detail) {
      if (!consent.get()) return;
      const e = { category: 'jots_game', label: String(label).slice(0, 40), ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
      if (detail != null && detail !== '') e.detail = String(detail).slice(0, 40);
      this.queue.push(e);
      if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
      emit('analytics', e);
    },
    async read(path) {
      const r = await fetch(CFG.gas + '?action=ashread&path=' + encodeURIComponent(path) + '&t=' + Date.now(), { cache: 'no-store' });
      const b = await r.json();
      if (b == null) return null;
      if (b.ok === false) throw new Error(b.error || 'unread');
      return b.ok === true && 'content' in b ? b.content : b;
    },
    write(path, payload, append, message) {
      // text/plain keeps it a CORS "simple request" (no preflight), like Autumn.
      return fetch(CFG.gas, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'ashwrite', path, uid: 'jots-game', append: !!append, payload, message: message || 'jots analytics' }) });
    },
    async flush() {
      if (this.busy || !this.queue.length || !consent.get()) return;
      this.busy = true;
      const batch = this.queue.splice(0, this.queue.length);
      try {
        const cfg = await this.read('ashtree/analytics-live/config.json');
        if (!cfg || !cfg.enabled || !cfg.mazeId) return;           // live feed switched off: drop quietly
        const base = 'ashtree/analytics-live/' + cfg.mazeId + '/';
        await this.write(base + 'chunk-' + (cfg.currentChunkIndex || 0) + '.json', batch, true, 'jots: chunk');
        if (Date.now() - this.lastExport < CFG.exportMinGapMs) { this.pending = (this.pending || []).concat(batch); return; }
        const merged = (this.pending || []).concat(batch); this.pending = [];
        const exp = await this.read(base + 'latest-export.json');
        if (!exp || !exp.pathIndex || !exp.pathIndex[0]) return;
        const path = exp.pathIndex[0].path || [];
        if (!path.length) return;
        // Same bucketing the Autumn apps use: spread the most recent events
        // evenly along the walked path, oldest first.
        let events = [];
        path.slice().sort((a, b) => a.order - b.order).forEach((n) => (n.events || []).forEach((e) => events.push(e)));
        events = events.concat(merged).slice(-4000);
        path.forEach((n) => { n.events = []; });
        const ordered = path.slice().sort((a, b) => a.order - b.order);
        events.forEach((e, i) => { ordered[Math.min(ordered.length - 1, Math.floor((i * ordered.length) / Math.max(events.length, 1)))].events.push(e); });
        exp.totalEvents = events.length;
        exp.exportedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        await this.write(base + 'latest-export.json', exp, false, 'jots: live export');
        this.lastExport = Date.now();
      } catch (e) {
        this.queue = batch.concat(this.queue).slice(-400);           // keep for the next try
      } finally { this.busy = false; }
    },
  };
  setInterval(() => { if (!document.hidden) analytics.flush(); }, CFG.analyticsFlushMs);

  // ── Consent (privacy policy) ────────────────────────────────────────
  const consent = {
    get() { const c = ls.get(LS.consent); return !!(c && c.agreed); },
    agree() { ls.set(LS.consent, { agreed: true, v: 1, ts: new Date().toISOString() }); emit('consent', { agreed: true }); },
    revoke() { ls.del(LS.consent); emit('consent', { agreed: false }); },
  };

  // ── Multiplayer transport ───────────────────────────────────────────
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.mqtt) return res();
      const s = document.createElement('script'); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }
  // Relay transport (leatr-ash/services/jots-relay): plain JSON frames.
  function relayTransport(url, room, onMsg, onStatus) {
    let ws = null, closed = false, retry = 1000;
    const open = () => {
      if (closed) return;
      ws = new WebSocket(url);
      ws.onopen = () => { retry = 1000; ws.send(JSON.stringify({ t: 'join', room, id: sessionId })); onStatus('online'); };
      ws.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch (e) {} };
      ws.onclose = () => { onStatus('reconnecting'); if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 15000))); };
      ws.onerror = () => {};
    };
    open();
    return {
      send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
      close() { closed = true; try { ws.close(); } catch (e) {} },
    };
  }
  // MQTT transport: one topic per player's state, one for chat, one for
  // leaves (the broker publishes our "last will" if we drop).
  async function mqttTransport(url, room, onMsg, onStatus) {
    await loadScript(CFG.mqttLib);
    const root = CFG.topic + '/' + room;
    const client = window.mqtt.connect(url, {
      clientId: 'jots_' + sessionId, clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 10000,
      will: { topic: root + '/leave', payload: JSON.stringify({ t: 'leave', id: sessionId }), qos: 0, retain: false },
    });
    client.on('connect', () => { onStatus('online'); client.subscribe(root + '/#'); });
    client.on('reconnect', () => onStatus('reconnecting'));
    client.on('offline', () => onStatus('offline'));
    client.on('message', (_t, buf) => { try { onMsg(JSON.parse(buf.toString())); } catch (e) {} });
    return {
      send(msg) { if (client.connected) client.publish(root + '/' + msg.t, JSON.stringify(msg), { qos: 0 }); },
      close() { try { client.publish(root + '/leave', JSON.stringify({ t: 'leave', id: sessionId })); client.end(true); } catch (e) {} },
    };
  }

  // ── Multiplayer session ─────────────────────────────────────────────
  // Shared world state stays deterministic on every client (seeded
  // galaxies and systems, planets from the real date); what travels is
  // each player's own ship state, chat, and — from one agreed player —
  // where the wandering Bird Temple is, so everyone meets it in one place.
  const mp = {
    active: false,
    status: 'offline',
    peers: new Map(),          // id → {id,name,kind,gal,sys,p,q,c,walk,ts,...}
    chat: [],
    chatLog: [],               // for the signed-in player's vault
    transport: null,
    _tick: null,
    getState: null,            // set by the game: () => {gal,sys,p:[..],q:[..],c,walk,bt?}
    async start() {
      if (this.active) return;
      this.active = true;
      this.setStatus('connecting');
      const onMsg = (m) => this.onMsg(m);
      const onStatus = (s) => this.setStatus(s);
      try {
        this.transport = CFG.relay ? relayTransport(CFG.relay, CFG.room, onMsg, onStatus)
                                   : await mqttTransport(CFG.mqtt, CFG.room, onMsg, onStatus);
      } catch (e) { this.setStatus('offline'); console.warn('[JOTS] multiplayer:', e); return; }
      this._tick = setInterval(() => this.sendState(), 1000 / CFG.stateHz);
      this._sweep = setInterval(() => this.sweep(), 2000);
      this._chatSave = setInterval(() => this.saveChat(), 60000);
      analytics.track('mode', 'multiplayer');
    },
    stop() {
      if (!this.active) return;
      this.active = false;
      clearInterval(this._tick); clearInterval(this._sweep); clearInterval(this._chatSave);
      this.saveChat();
      try { this.transport && this.transport.close(); } catch (e) {}
      this.transport = null;
      this.peers.clear();
      emit('peers', { peers: [] });
      this.setStatus('offline');
    },
    setStatus(s) { this.status = s; emit('mpstatus', { status: s }); },
    sendState() {
      if (!this.transport || !this.getState || document.hidden) return;
      let st; try { st = this.getState(); } catch (e) { return; }
      if (!st) return;
      this.transport.send({ t: 'state', id: sessionId, n: identity.name, k: identity.kind === 'github' ? 'h' : 'g', ts: Date.now(), ...st });
    },
    sendChat(text) {
      text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text || !this.transport) return;
      const m = { t: 'chat', id: sessionId, n: identity.name, text, ts: Date.now() };
      this.transport.send(m);
      this.onMsg(m, true);
    },
    onMsg(m, self) {
      if (!m || !m.t) return;
      if (m.t === 'state' && m.id !== sessionId) {
        const had = this.peers.has(m.id);
        this.peers.set(m.id, { ...m, seen: Date.now() });
        if (!had) { emit('peers', { peers: [...this.peers.values()] }); analytics.track('players_online', this.peers.size + 1); }
      } else if (m.t === 'leave' && m.id !== sessionId) {
        if (this.peers.delete(m.id)) emit('peers', { peers: [...this.peers.values()] });
      } else if (m.t === 'chat') {
        if (!self && m.id === sessionId) return;
        const line = { n: String(m.n || '?').slice(0, 40), text: String(m.text || '').slice(0, 200), ts: m.ts || Date.now(), me: m.id === sessionId };
        this.chat.push(line); if (this.chat.length > 50) this.chat.shift();
        this.chatLog.push(line);
        emit('chat', line);
      }
    },
    sweep() {
      const now = Date.now(); let gone = false;
      for (const [id, p] of this.peers) if (now - p.seen > CFG.peerTimeoutMs) { this.peers.delete(id); gone = true; }
      if (gone) emit('peers', { peers: [...this.peers.values()] });
    },
    async saveChat() {
      if (!this.chatLog.length || !vault.ready) return;
      const lines = this.chatLog.splice(0, this.chatLog.length);
      try { await vault.appendChat(lines); } catch (e) { this.chatLog = lines.concat(this.chatLog); }
    },
    // The Bird Temple's position comes from one agreed player: the lowest
    // session id among everyone in the home system (including us).
    templeAuthority(inSol) {
      if (!inSol) return null;
      let best = sessionId, bestPeer = null;
      for (const p of this.peers.values()) if (p.sys === 'Sol' && p.gal === 'milkyway' && p.id < best) { best = p.id; bestPeer = p; }
      return bestPeer ? bestPeer : 'me';
    },
  };

  window.JOTS = { CFG, sessionId, identity, auth, vault, analytics, consent, mp, mode: 'story' };
  // Re-validate a stored sign-in once the page settles.
  setTimeout(() => { auth.restore(); }, 1500);
})();
