// dm-gpu-defer.js (v332) — deferred destruction of WebGPU vertex / storage buffers.
//
// three's WebGPU backend destroys an attribute's GPUBuffer the moment its geometry is disposed
// (WebGPUAttributeUtils.destroyAttribute). The engine disposes geometry in the middle of live work: LOD swaps and
// cross-fades, the Bird Temple rebuild, sparse-LOD bodies whose compute batches are still in flight (not awaited by the
// loop), system clears. When a command buffer that still names such a buffer is submitted afterwards — a compute
// bind group three caches and never rebuilds, or a pass encoded before the dispose — WebGPU raises
// "[Buffer (unlabeled)] used in submit while destroyed" (unlabeled: attribute buffers carry no label).
//
// Here every attribute buffer three wants destroyed is parked instead, stamped with the frame it was released on.
// tick() (top of the render loop) hands buffers at least MIN_FRAMES old to the device once all work submitted so far
// is done (queue.onSubmittedWorkDone), then destroys them. three's own bookkeeping is dropped immediately, exactly as
// before, so nothing else changes. No allocation while the queue is empty (the steady state); one batch in flight.
(function (root) {
  'use strict';

  // Pure FIFO of (buffer, frame) — node-testable.
  function createQueue(minFrames) {
    const MIN = Math.max(1, minFrames | 0);
    const bufs = [], frames = [];
    let head = 0;
    return {
      minFrames: MIN,
      push(buf, frame) { if (buf) { bufs.push(buf); frames.push(frame); } },
      size() { return bufs.length - head; },
      // moves every buffer released at least MIN frames before `frame` into `out` (cleared first); returns the count
      take(frame, out) {
        out.length = 0;
        while (head < bufs.length && frame - frames[head] >= MIN) { out.push(bufs[head]); bufs[head] = null; head++; }
        if (head === bufs.length) { bufs.length = 0; frames.length = 0; head = 0; }
        else if (head > 64 && head * 2 > bufs.length) { bufs.splice(0, head); frames.splice(0, head); head = 0; }
        return out.length;
      },
      // everything still parked (page teardown)
      drainAll(out) { out.length = 0; for (let i = head; i < bufs.length; i++) out.push(bufs[i]); bufs.length = 0; frames.length = 0; head = 0; return out.length; },
    };
  }

  function install(renderer, opts) {
    opts = opts || {};
    const be = renderer && renderer.backend, au = be && be.attributeUtils;
    if (!be || !au || typeof au.destroyAttribute !== 'function' || typeof be.get !== 'function') return null;
    if (au.__dmDefer) return au.__dmDefer;
    const Q = createQueue(opts.minFrames || 3), batch = [];
    const orig = au.destroyAttribute;
    const st = { frame: 0, inFlight: false, deferred: 0, destroyed: 0, batches: 0, rebound: 0 };
    // (bugfix-1119) STORAGE attributes are also bound by compute nodes / render objects, and three keeps their GPUBindGroup. Disposing the attribute (a geometry.dispose(),
    // a resized pool) makes three forget the buffer and create a NEW one on the next update, but the cached bind group still names the OLD buffer: Bindings._update only
    // rebuilds a group when `binding.attribute` is a different OBJECT, never when the same object got a new GPUBuffer. Deferring the destroy only moved the failure a few
    // frames later ("[Buffer (unlabeled)] used in submit while destroyed" once the parked buffer died). So: count the releases per attribute (gen), and when a group's storage
    // binding was released since the group was built, rebuild that group once (backend.updateBindings with cacheIndex 0 = a fresh GPUBindGroup on the current buffers).
    const gen = new WeakMap(); let epoch = 0;
    const isStorage = (a) => !!a && (a.isStorageBufferAttribute || a.isStorageInstancedBufferAttribute || a.isIndirectStorageBufferAttribute);
    const keyOf = (a) => { try { return au._getBufferAttribute ? au._getBufferAttribute(a) : a; } catch (e) { return a; } };
    au.destroyAttribute = function (attribute) {
      if (isStorage(attribute)) { const k = keyOf(attribute); gen.set(k, (gen.get(k) || 0) + 1); epoch++; }
      let data = null;
      try { data = be.get(this._getBufferAttribute ? this._getBufferAttribute(attribute) : attribute); } catch (e) { data = null; }
      const dev = be.device;
      if (!data || !data.buffer || !dev || !dev.queue || typeof data.buffer.destroy !== 'function') return orig.call(this, attribute);
      Q.push(data.buffer, st.frame); st.deferred++;
      be.delete(attribute);   // three forgets it now, as before; only the GPU-side destroy waits
    };
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
    // (t1644 Track 1) createBuffer OOM guard.  A mappedAtCreation buffer that cannot be allocated THROWS (RangeError) inside three's attribute upload; three then keeps
    // a half-built attribute whose bind group is invalid for the rest of the session ("Invalid BindGroup", then a device loss on iPhone / Mali).  Wrapped once per device:
    //  1. on a throw, the parked buffers whose release frame is old enough are destroyed now (memory back), and the create is retried;
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
          try { const due = []; Q.take(st.frame, due); if (!st.inFlight) destroyList(due); else for (let i = 0; i < due.length; i++) Q.push(due[i], st.frame); } catch (e) { }
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
    function destroyList(list) { for (let i = 0; i < list.length; i++) { try { list[i].destroy(); st.destroyed++; } catch (e) {} } }
    const now = () => (root && root.performance && root.performance.now ? root.performance.now() : Date.now());
    function tick() {
      st.frame++; st.last = now();
      if (be.device && !be.device.__dmCB) wrapDevice();
      if (st.inFlight || Q.size() === 0) return;
      if (Q.take(st.frame, batch) === 0) return;
      const list = batch.slice();   // only when something is due
      st.inFlight = true; st.batches++;
      const fin = () => { destroyList(list); st.inFlight = false; };
      try { be.device.queue.onSubmittedWorkDone().then(fin, fin); } catch (e) { fin(); }
    }
    function flush() { const all = []; Q.drainAll(all); destroyList(all); }
    // (v334) idle flush: only the flight loop calls tick(); when no loop is ticking (menus, the ship / other render loops, a paused tab)
    // parked buffers would wait forever.  Every 0.5 s, if nothing ticked for 0.45 s and buffers are waiting, tick once from here (the same
    // frame counting + onSubmittedWorkDone fence, so it is exactly as safe).  No allocation while the queue is empty.
    st.last = now(); st.idleTicks = 0;
    const idle = (root && typeof root.setInterval === 'function') ? root.setInterval(() => { if (Q.size() > 0 && now() - st.last > 450) { st.idleTicks++; tick(); } }, 500) : null;
    if (idle && typeof idle.unref === 'function') idle.unref();
    function uninstall() { if (idle != null && root && root.clearInterval) root.clearInterval(idle); au.destroyAttribute = orig; if (B && origUpdate) B._update = origUpdate; try { const dv = be.device; if (dv && dv.__dmCB) { dv.createBuffer = dv.__dmCB; delete dv.__dmCB; } } catch (e) { } delete au.__dmDefer; flush(); }
    const api = { tick, flush, uninstall, stats: st, pending: () => Q.size(), idleTick: () => { if (Q.size() > 0) { st.idleTicks++; tick(); } } };
    au.__dmDefer = api;
    return api;
  }

  const DMGpuDefer = { createQueue, install };
  if (typeof module !== 'undefined' && module.exports) module.exports = DMGpuDefer;
  if (root) root.DMGpuDefer = DMGpuDefer;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
