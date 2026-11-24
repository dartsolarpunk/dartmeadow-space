// dm-gpu-defer.js (v332, hardened t1653 Track 4 / CE-9) — safe destruction of WebGPU vertex / index / storage / uniform buffers.
//
// three's WebGPU backend destroys an attribute's GPUBuffer the moment its geometry is disposed (WebGPUAttributeUtils.destroyAttribute). The engine disposes
// geometry in the middle of live work: LOD swaps and cross-fades, the Bird Temple rebuild, sparse-LOD bodies whose compute batches are still in flight, system
// clears. When a command buffer that still names such a buffer is submitted afterwards, WebGPU raises "[Buffer (unlabeled)] used in submit while destroyed".
//
// (t1653 Track 4) ROOT CAUSE of the banner that kept firing on v372/v373 (mansion deck AND space near Veyra, 3-4 fps while it fired):
//   three r185 keys the GPU buffer of an InterleavedBufferAttribute on its shared InterleavedBuffer, but destroyAttribute() destroys that shared buffer and then
//   deletes the backend entry of the *attribute* - the InterleavedBuffer's entry keeps pointing at the destroyed GPUBuffer. createAttribute() then sees
//   `buffer !== undefined` and never makes a new one, and Geometries.updateAttribute() only ever updates an interleaved attribute ONCE (attributeCall === undefined),
//   so every later draw of ANY mesh reading that InterleavedBuffer (a sibling primitive of the same GLB bufferView, a clone, the same geometry drawn again) binds a
//   destroyed buffer -> the whole command buffer is rejected -> error + dropped work EVERY frame. Our GLBs are full of them: every KHR_mesh_quantization /
//   meshopt asset (the 75 assets/places + assets/creatures GLBs, bt-engineering / madison / nova) has interleaved (byteStride) accessors, and GLTFLoader shares one
//   InterleavedBuffer per bufferView across primitives. Deferring the destroy (v332) only moved the failure MIN frames later.
//
// What this module does now:
//   1. Every buffer three wants destroyed is PARKED, stamped with the frame it was released on. It is destroyed only at the top of the flight loop (tick(), never
//      inside a submit) once BOTH  >= MIN frames (default 4) have passed  AND  a queue.onSubmittedWorkDone() fence issued AFTER the release has resolved.
//   2. Interleaved buffers are reference-counted per InterleavedBuffer (every attribute uploaded on it); the shared GPUBuffer is parked only when the LAST attribute
//      using it is released, and then the InterleavedBuffer's backend entry is dropped and the attributes' once-only update stamp is cleared, so a geometry that is
//      drawn again re-uploads a fresh buffer instead of binding the dead one.
//   3. A parked buffer that three still names (backend entry of its key still holds it) is never destroyed (a leak is recoverable, a dead buffer is not).
//   4. STORAGE attributes: a cached GPUBindGroup that still names a released storage buffer is rebuilt once (bugfix-1119).
//   5. Uniform buffers (destroyUniformBuffer) go through the same park + fence.
//   6. Every attribute buffer gets a label "dm:<kind>#<serial>:<name>:<itemSize>x<count>" so a future WebGPU error names its owner instead of "(unlabeled)";
//      heal(message) re-creates the named buffer if it was one we destroyed (self-repair after one bad frame instead of a broken session).
//   7. A disposed geometry that is drawn again gets its dispose listener back (three r185 registers it only once), so its buffers are freed on the next dispose.
(function (root) {
  'use strict';

  // Pure FIFO of (buffer, frame, key) — node-testable.  take(frame, out[, fenceDone]): every entry released >= MIN frames before `frame` and, when fenceDone is
  // given, released BEFORE the frame at which the last resolved onSubmittedWorkDone fence was issued (release frame < fenceDone).
  function createQueue(minFrames) {
    const MIN = Math.max(1, minFrames | 0);
    const bufs = [], frames = [], keys = [];
    let head = 0;
    return {
      minFrames: MIN,
      push(buf, frame, key) { if (buf) { bufs.push(buf); frames.push(frame); keys.push(key === undefined ? null : key); } },
      size() { return bufs.length - head; },
      take(frame, out, fenceDone, outKeys) {
        out.length = 0; if (outKeys) outKeys.length = 0;
        while (head < bufs.length && frame - frames[head] >= MIN && (fenceDone === undefined || frames[head] < fenceDone)) {
          out.push(bufs[head]); if (outKeys) outKeys.push(keys[head]); bufs[head] = null; keys[head] = null; head++;
        }
        if (head === bufs.length) { bufs.length = 0; frames.length = 0; keys.length = 0; head = 0; }
        else if (head > 64 && head * 2 > bufs.length) { bufs.splice(0, head); frames.splice(0, head); keys.splice(0, head); head = 0; }
        return out.length;
      },
      oldest() { return head < bufs.length ? frames[head] : -1; },
      // everything still parked (page teardown)
      drainAll(out) { out.length = 0; for (let i = head; i < bufs.length; i++) out.push(bufs[i]); bufs.length = 0; frames.length = 0; keys.length = 0; head = 0; return out.length; },
    };
  }

  const LABEL_RE = /\[Buffer "?(dm:[a-z]+#(\d+)[^"\]]*)"?\]/;

  function install(renderer, opts) {
    opts = opts || {};
    const be = renderer && renderer.backend, au = be && be.attributeUtils;
    if (!be || !au || typeof au.destroyAttribute !== 'function' || typeof be.get !== 'function') return null;
    if (au.__dmDefer) return au.__dmDefer;
    const Q = createQueue(opts.minFrames || 4), due = [], dueKeys = [];
    const orig = au.destroyAttribute, origCreate = au.createAttribute;
    const st = { frame: 0, fencePending: false, fenceDone: 0, fences: 0, deferred: 0, destroyed: 0, batches: 0, rebound: 0, keptLive: 0, sharedKept: 0, ibReleased: 0,
      unknownShared: 0, labeled: 0, healed: 0, uniformDeferred: 0, geoReinit: 0 };
    const has = (k) => { try { return typeof be.has === 'function' ? be.has(k) : false; } catch (e) { return false; } };
    const dead = (typeof WeakSet === 'function') ? new WeakSet() : null;   // buffers WE destroyed (heal() checks against it)
    const geos = renderer._geometries, attrsDM = renderer._attributes;
    const callMap = () => (geos && geos.attributeCall && typeof geos.attributeCall.delete === 'function') ? geos.attributeCall : null;
    // forget everything three keeps for an attribute so its next draw re-creates its GPU buffer
    function forgetAttr(a) { try { const cm = callMap(); if (cm) cm.delete(a); } catch (e) { } try { if (attrsDM && attrsDM.data && attrsDM.data.delete) attrsDM.data.delete(a); } catch (e) { } }

    // ── (2) interleaved reference counts + (6) labels ──
    const ibRefs = new WeakMap();   // InterleavedBuffer -> Set<InterleavedBufferAttribute> uploaded on it
    const reg = new Map(); let serial = 0;   // serial -> WeakRef(key)  (heal)
    const hasWeakRef = typeof WeakRef === 'function';
    const kindOf = (a, usage) => (a.isInterleavedBufferAttribute ? 'ivb' : (usage & 0x10) ? 'idx' : (a.isStorageBufferAttribute || a.isStorageInstancedBufferAttribute || a.isIndirectStorageBufferAttribute || (usage & 0x80)) ? 'sto' : 'vtx');
    if (typeof origCreate === 'function') {
      au.createAttribute = function (attribute, usage) {
        const r = origCreate.apply(this, arguments);
        try {
          const key = this._getBufferAttribute ? this._getBufferAttribute(attribute) : attribute;
          if (attribute && attribute.isInterleavedBufferAttribute) { let s = ibRefs.get(key); if (!s) { s = new Set(); ibRefs.set(key, s); } s.add(attribute); }
          const d = be.get(key), b = d && d.buffer;
          if (b && !b.__dmL) {   // (three labels a buffer only with attribute.name: usually '' -> "(unlabeled)"; a name is kept inside ours)
            const id = ++serial, nm = String(attribute.name || key.name || b.label || '').replace(/[^\w.-]/g, '').slice(0, 24);
            try { b.label = 'dm:' + kindOf(attribute, usage | 0) + '#' + id + (nm ? ':' + nm : '') + ':' + (attribute.itemSize | 0) + 'x' + (attribute.count | 0); } catch (e) { }
            b.__dmL = id; st.labeled++;
            if (hasWeakRef) { reg.set(id, new WeakRef(key)); if (reg.size > 8192) for (const [k, w] of reg) { if (!w.deref()) reg.delete(k); } }
          }
        } catch (e) { }
        return r;
      };
    }

    // ── (1) park instead of destroy ──
    const gen = new WeakMap(); let epoch = 0;
    const isStorage = (a) => !!a && (a.isStorageBufferAttribute || a.isStorageInstancedBufferAttribute || a.isIndirectStorageBufferAttribute);
    const keyOf = (a) => { try { return au._getBufferAttribute ? au._getBufferAttribute(a) : a; } catch (e) { return a; } };
    function park(buf, key) { Q.push(buf, st.frame, key); st.deferred++; }
    au.destroyAttribute = function (attribute) {
      if (isStorage(attribute)) { const k = keyOf(attribute); gen.set(k, (gen.get(k) || 0) + 1); epoch++; }
      const dev = be.device;
      if (attribute && attribute.isInterleavedBufferAttribute) {
        const key = keyOf(attribute), s = ibRefs.get(key);
        try { be.delete(attribute); } catch (e) { }
        try { const cm = callMap(); if (cm) cm.delete(attribute); } catch (e) { }   // three updates an interleaved attribute only once ever: let it re-upload if drawn again
        if (!s) { st.unknownShared++; return; }                 // never seen uploaded here: siblings may still draw from it - keep it (no destroy)
        s.delete(attribute);
        if (s.size > 0) { st.sharedKept++; return; }            // other live attributes still read this InterleavedBuffer
        ibRefs.delete(key); st.ibReleased++;
        let d = null; try { d = has(key) ? be.get(key) : null; } catch (e) { d = null; }
        if (d && d.buffer && dev && dev.queue && typeof d.buffer.destroy === 'function') park(d.buffer, key);
        try { be.delete(key); } catch (e) { }                    // the InterleavedBuffer's entry no longer names a buffer that will die
        return;
      }
      let data = null;
      try { data = be.get(this._getBufferAttribute ? this._getBufferAttribute(attribute) : attribute); } catch (e) { data = null; }
      if (!data || !data.buffer || !dev || !dev.queue || typeof data.buffer.destroy !== 'function') return orig.call(this, attribute);
      park(data.buffer, keyOf(attribute));
      be.delete(attribute);   // three forgets it now, as before; only the GPU-side destroy waits
    };
    // (5) uniform buffers
    const origUB = be.destroyUniformBuffer;
    if (typeof origUB === 'function') {
      be.destroyUniformBuffer = function (ub) {
        let d = null; try { d = this.get(ub); } catch (e) { }
        if (!d || !d.buffer || typeof d.buffer.destroy !== 'function' || !this.device) return origUB.call(this, ub);
        park(d.buffer, null); st.uniformDeferred++; this.delete(ub);
      };
    }
    // (4) storage bind groups that still name a released buffer
    const B = renderer._bindings, origUpdate = B && B._update;
    if (typeof origUpdate === 'function' && typeof be.updateBindings === 'function') {
      B._update = function (bindGroup, bindings) {
        origUpdate.call(this, bindGroup, bindings);
        if (epoch === 0) return;                                   // nothing storage-backed was ever released: zero work per call
        let gd = null; try { gd = be.get(bindGroup); } catch (e) { return; }
        if (!gd || gd._dmEp === epoch) return;                    // verified since the last release
        let stale = false; const bs = bindGroup.bindings;
        for (let i = 0; i < bs.length; i++) {
          const b = bs[i]; if (!b.isStorageBuffer || !b.attribute) continue;
          const g = gen.get(keyOf(b.attribute)) || 0, bd = be.get(b);
          if (g !== (bd._dmGen || 0)) { bd._dmGen = g; stale = true; }
        }
        gd._dmEp = epoch;
        if (stale) { try { gd.groups = undefined; gd.versions = undefined; be.updateBindings(bindGroup, bindings, 0, 0); st.rebound++; } catch (e) { } }   // (groups / versions = three's per-texture-state group cache: it holds the old group too)
      };
    }
    // (7) a disposed geometry that is drawn again: three r185 removed its dispose listener and never re-adds it (initialized stays true) -> its re-uploaded
    // buffers would never be freed.  Drop the geometry's entry after its dispose so the next draw re-initialises it (listener back, buffers tracked).
    const origInit = geos && geos.initGeometry;
    if (typeof origInit === 'function' && typeof geos.delete === 'function') {
      geos.initGeometry = function (renderObject) {
        origInit.call(this, renderObject);
        const g = renderObject && renderObject.geometry; if (!g || typeof g.addEventListener !== 'function') return;
        const self = this, f = function () { try { g.removeEventListener('dispose', f); } catch (e) { } try { if (geos.initGeometry !== origInit) { self.delete(g); st.geoReinit++; } } catch (e) { } };
        g.addEventListener('dispose', f);
      };
    }
    // (t1644 Track 1) createBuffer OOM guard.  A mappedAtCreation buffer that cannot be allocated THROWS (RangeError) inside three's attribute upload; three then keeps
    // a half-built attribute whose bind group is invalid for the rest of the session ("Invalid BindGroup", then a device loss on iPhone / Mali).  Wrapped once per device:
    //  1. on a throw, the parked buffers that are already safe (MIN frames old AND fenced) are destroyed now (memory back), and the create is retried;
    //  2. if a MAPPED create still throws, the buffer is created UNMAPPED (+ COPY_DST) and its getMappedRange() / unmap() are served from a CPU ArrayBuffer that unmap()
    //     uploads with queue.writeBuffer - the caller's code path is unchanged and the buffer is valid.  Steady state: one extra call frame per createBuffer, no allocation.
    function wrapDevice() {
      const dev = be.device; if (!dev || dev.__dmCB || typeof dev.createBuffer !== 'function') return;
      const origCB = dev.createBuffer; dev.__dmCB = origCB; st.oomRetry = 0; st.oomShadow = 0;
      const COPY_DST = (root && root.GPUBufferUsage && root.GPUBufferUsage.COPY_DST) || 0x0008;
      dev.createBuffer = function (desc) {
        try { return origCB.call(this, desc); } catch (e1) {
          if (!desc || !(e1 && (e1.name === 'RangeError' || /memory|alloc/i.test(String(e1.message || ''))))) throw e1;
          st.oomRetry++;
          try { destroyDue(); } catch (e) { }
          try { return origCB.call(this, desc); } catch (e2) {
            if (!desc.mappedAtCreation) throw e2;
            const MAPRW = ((root && root.GPUBufferUsage) ? (root.GPUBufferUsage.MAP_READ | root.GPUBufferUsage.MAP_WRITE) : 0x0003);
            if ((desc.usage | 0) & MAPRW) throw e2;   // (Watcher #278) COPY_DST is invalid with MAP_READ / MAP_WRITE: no shadow fallback for a mappable buffer
            const d2 = Object.assign({}, desc, { mappedAtCreation: false, usage: (desc.usage | 0) | COPY_DST });
            const buf = origCB.call(this, d2), q = this.queue, ranges = [];
            buf.getMappedRange = function (off, size) { off = off | 0; const n = size == null ? desc.size - off : size; const ab = new ArrayBuffer(n); ranges.push(off, ab); return ab; };
            buf.unmap = function () { for (let i = 0; i < ranges.length; i += 2) { try { q.writeBuffer(buf, ranges[i], ranges[i + 1]); } catch (e) { } } ranges.length = 0; };
            st.oomShadow++;
            return buf;
          }
        }
      };
    }
    wrapDevice();
    function destroyOne(b) { try { b.destroy(); st.destroyed++; if (dead) dead.add(b); } catch (e) { } }
    // (3) destroy only what is due (frames + fence) and no longer named by three
    function destroyDue() {
      if (Q.size() === 0 || Q.take(st.frame, due, st.fenceDone, dueKeys) === 0) return 0;
      st.batches++;
      for (let i = 0; i < due.length; i++) {
        const b = due[i], k = dueKeys[i];
        let live = false; if (k && has(k)) { try { live = be.get(k).buffer === b; } catch (e) { } }
        if (live) { st.keptLive++; continue; }
        destroyOne(b);
      }
      const n = due.length; due.length = 0; dueKeys.length = 0; return n;
    }
    function fence() {
      if (st.fencePending || Q.size() === 0) return;
      const dev = be.device; if (!dev || !dev.queue || typeof dev.queue.onSubmittedWorkDone !== 'function') return;
      const tag = st.frame; st.fencePending = true; st.fences++;
      const done = () => { if (tag > st.fenceDone) st.fenceDone = tag; st.fencePending = false; };
      try { dev.queue.onSubmittedWorkDone().then(done, () => { st.fencePending = false; }); } catch (e) { st.fencePending = false; }
    }
    const now = () => (root && root.performance && root.performance.now ? root.performance.now() : Date.now());
    // top of the flight loop: count the frame, destroy what is safe, then fence everything submitted so far (one fence in flight; none while nothing is parked)
    function tick() {
      st.frame++; st.last = now();
      if (be.device && !be.device.__dmCB) wrapDevice();
      if (Q.size() === 0) return;
      destroyDue();
      fence();
    }
    function flush() { const all = []; Q.drainAll(all); for (let i = 0; i < all.length; i++) destroyOne(all[i]); }
    // (6) heal: "[Buffer "dm:vtx#12:..."] used in submit while destroyed" -> if #12 is a buffer WE destroyed and three still names it, make three forget it
    function heal(msg) {
      const m = LABEL_RE.exec(String(msg || '')); if (!m || !/destroyed/i.test(String(msg))) return false;
      const w = reg.get(+m[2]), key = w && w.deref && w.deref(); if (!key || !has(key)) return false;
      let d = null; try { d = be.get(key); } catch (e) { return false; }
      if (!d || !d.buffer || !(dead && dead.has(d.buffer))) return false;
      try { be.delete(key); } catch (e) { }
      forgetAttr(key); const s = ibRefs.get(key); if (s) { s.forEach(forgetAttr); ibRefs.delete(key); }
      st.healed++; return true;
    }
    // (v334) idle flush: only the flight loop calls tick(); when no loop is ticking (menus, the ship / other render loops, a paused tab)
    // parked buffers would wait forever.  Every 0.5 s, if nothing ticked for 0.45 s and buffers are waiting, tick once from here (the same
    // frame counting + fence, so it is exactly as safe).  No allocation while the queue is empty.
    st.last = now(); st.idleTicks = 0;
    const idle = (root && typeof root.setInterval === 'function') ? root.setInterval(() => { if (Q.size() > 0 && now() - st.last > 450) { st.idleTicks++; tick(); } }, 500) : null;
    if (idle && typeof idle.unref === 'function') idle.unref();
    function uninstall() {
      if (idle != null && root && root.clearInterval) root.clearInterval(idle);
      au.destroyAttribute = orig; if (typeof origCreate === 'function') au.createAttribute = origCreate; if (typeof origUB === 'function') be.destroyUniformBuffer = origUB;
      if (B && origUpdate) B._update = origUpdate; if (typeof origInit === 'function') geos.initGeometry = origInit;
      try { const dv = be.device; if (dv && dv.__dmCB) { dv.createBuffer = dv.__dmCB; delete dv.__dmCB; } } catch (e) { }
      delete au.__dmDefer; flush();
    }
    const api = { tick, flush, uninstall, heal, stats: st, minFrames: Q.minFrames, pending: () => Q.size(), idleTick: () => { if (Q.size() > 0) { st.idleTicks++; tick(); } } };
    au.__dmDefer = api;
    return api;
  }

  const DMGpuDefer = { createQueue, install, LABEL_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = DMGpuDefer;
  if (root) root.DMGpuDefer = DMGpuDefer;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
