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
    const st = { frame: 0, inFlight: false, deferred: 0, destroyed: 0, batches: 0 };
    au.destroyAttribute = function (attribute) {
      let data = null;
      try { data = be.get(this._getBufferAttribute ? this._getBufferAttribute(attribute) : attribute); } catch (e) { data = null; }
      const dev = be.device;
      if (!data || !data.buffer || !dev || !dev.queue || typeof data.buffer.destroy !== 'function') return orig.call(this, attribute);
      Q.push(data.buffer, st.frame); st.deferred++;
      be.delete(attribute);   // three forgets it now, as before; only the GPU-side destroy waits
    };
    function destroyList(list) { for (let i = 0; i < list.length; i++) { try { list[i].destroy(); st.destroyed++; } catch (e) {} } }
    const now = () => (root && root.performance && root.performance.now ? root.performance.now() : Date.now());
    function tick() {
      st.frame++; st.last = now();
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
    function uninstall() { if (idle != null && root && root.clearInterval) root.clearInterval(idle); au.destroyAttribute = orig; delete au.__dmDefer; flush(); }
    const api = { tick, flush, uninstall, stats: st, pending: () => Q.size(), idleTick: () => { if (Q.size() > 0) { st.idleTicks++; tick(); } } };
    au.__dmDefer = api;
    return api;
  }

  const DMGpuDefer = { createQueue, install };
  if (typeof module !== 'undefined' && module.exports) module.exports = DMGpuDefer;
  if (root) root.DMGpuDefer = DMGpuDefer;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
