// node tools/tests/gpu-defer.test.js — ui/dm-gpu-defer.js (bugfix-1119): the "[Buffer (unlabeled)] used in submit while destroyed" family.
//  (1) FIFO queue: a released buffer waits MIN frames.
//  (2) three's own sequence, simulated: a STORAGE attribute is released (geometry.dispose()), three creates a NEW GPUBuffer on the next Bindings._update, but the cached
//      GPUBindGroup still names the old one (three only rebuilds a group when binding.attribute is a different OBJECT).  Without the guard the parked buffer's
//      destroy turns that into a failing submit a few frames later; with it the group is rebuilt once on the new buffer, then nothing more is done per call.
//  (3) vertex attributes (no bind group) and the steady state cost nothing extra: no gen bookkeeping touches the backend while nothing storage-backed was released.
// No three.js, no GPU: the fakes mirror r185's Attributes.delete / Bindings._update / WebGPUBindingUtils.createBindings (cacheIndex 0 = a fresh bind group).
'use strict';
const D = require('../../ui/dm-gpu-defer.js');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };

// ── (1) queue ──
{
  const q = D.createQueue(3), out = []; q.push('a', 10); q.push('b', 11);
  ok(q.take(12, out) === 0, 'nothing due before MIN frames');
  ok(q.take(13, out) === 1 && out[0] === 'a', 'a due at +3');
  ok(q.take(14, out) === 1 && out[0] === 'b' && q.size() === 0, 'b due at +3, queue empty');
}

// ── a tiny three: backend data store, attribute utils, bindings ──
function world() {
  const store = new Map(), calls = { get: 0 };
  const mk = (label) => ({ label, destroyed: false, destroy() { this.destroyed = true; } });
  const be = {
    device: { queue: { onSubmittedWorkDone: () => Promise.resolve() } },
    get(o) { calls.get++; let d = store.get(o); if (!d) { d = {}; store.set(o, d); } return d; },
    delete(o) { store.delete(o); },
    // WebGPUBindingUtils.createBindings(.., cacheIndex 0): a fresh GPUBindGroup that names the CURRENT buffers
    updateBindings(bg) { const gd = be.get(bg); gd.group = { bufs: bg.bindings.filter((b) => b.isStorageBuffer).map((b) => be.get(b.attribute).buffer) }; gd.rebuilds = (gd.rebuilds || 0) + 1; },
  };
  const au = {
    _getBufferAttribute: (a) => a,
    destroyAttribute(a) { const d = be.get(a); d.buffer.destroy(); be.delete(a); },   // r185: immediate
  };
  be.attributeUtils = au;
  const renderer = { backend: be, _bindings: {
    // r185 Bindings._update: attributes.update() re-creates a released storage buffer; the group is rebuilt only when binding.attribute changed OBJECT
    _update(bg) {
      let need = false;
      for (const b of bg.bindings) if (b.isStorageBuffer) {
        const d = be.get(b.attribute); if (!d.buffer) d.buffer = mk('new');
        const bd = be.get(b); if (bd.attribute !== b.attribute) { bd.attribute = b.attribute; need = true; }
      }
      if (need) be.updateBindings(bg);
    } } };
  // submit(): WebGPU validation — every buffer named by the cached bind group must be alive
  const submit = (bg) => { const g = be.get(bg).group; if (g.bufs.some((b) => b.destroyed)) throw new Error('[Buffer (unlabeled)] used in submit while destroyed'); };
  return { be, au, renderer, mk, submit, calls };
}
function attr(w, storage) { const a = storage ? { isStorageBufferAttribute: true } : {}; w.be.get(a).buffer = w.mk('old'); return a; }
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  // ── (2) the bug, then the fix ──
  {
    const w = world(), A = attr(w, true), G = { bindings: [{ isStorageBuffer: true, attribute: A }] };   // WITHOUT the guard: r185 as shipped (immediate destroy)
    w.renderer._bindings._update(G); w.submit(G);
    w.au.destroyAttribute(A);                    // geometry.dispose()
    w.renderer._bindings._update(G);             // new buffer created, group NOT rebuilt
    let threw = false; try { w.submit(G); } catch (e) { threw = /used in submit while destroyed/.test(e.message); }
    ok(threw, 'baseline: the unguarded sequence reproduces "used in submit while destroyed"');
  }
  {
    const w = world(), A = attr(w, true), G = { bindings: [{ isStorageBuffer: true, attribute: A }] };
    const api = D.install(w.renderer, { minFrames: 3 });
    ok(!!api && w.au.__dmDefer === api, 'installs on the attribute utils');
    ok(D.install(w.renderer) === api, 'a second install returns the same instance');
    w.renderer._bindings._update(G); w.submit(G);
    const old = w.be.get(A).buffer;
    w.au.destroyAttribute(A);
    ok(!old.destroyed && api.pending() === 1, 'the released buffer is parked, not destroyed');
    w.renderer._bindings._update(G);
    ok(api.stats.rebound === 1, 'the group naming the released buffer is rebuilt once');
    ok(w.be.get(G).group.bufs[0] === w.be.get(A).buffer && w.be.get(A).buffer !== old, 'the rebuilt group names the NEW buffer');
    for (let i = 0; i < 5; i++) { api.tick(); await settle(); await settle(); }
    ok(old.destroyed, 'the parked buffer is destroyed once frames passed and the queue drained');
    let threw = false; try { w.submit(G); } catch (e) { threw = true; } ok(!threw, 'submit after the destroy is valid (no stale bind group)');
    const r = api.stats.rebound; for (let i = 0; i < 10; i++) w.renderer._bindings._update(G);
    ok(api.stats.rebound === r && w.be.get(G).rebuilds === 2, 'steady state: no further rebuilds (1 create + 1 rebuild)');
    const b2 = w.be.get(A).buffer; w.au.destroyAttribute(A); w.renderer._bindings._update(G);
    ok(api.stats.rebound === 2 && w.be.get(G).group.bufs[0] !== b2 && !b2.destroyed, 'a second release rebuilds again; the old one is still parked');
    const A2 = attr(w, true), G2 = { bindings: [{ isStorageBuffer: true, attribute: A2 }] }; w.renderer._bindings._update(G2);
    const rb2 = w.be.get(G2).rebuilds; w.au.destroyAttribute(A); w.renderer._bindings._update(G2);
    ok(w.be.get(G2).rebuilds === rb2, 'an unrelated group is not rebuilt');
    api.uninstall(); ok(!w.au.__dmDefer, 'uninstall restores');
  }
  // ── (3) cost: no release -> the wrapper does no backend lookups; a released VERTEX attribute does not trigger verification ──
  {
    const w = world(), V = attr(w, false), A = attr(w, true), G = { bindings: [{ isStorageBuffer: true, attribute: A }] };
    const api = D.install(w.renderer, { minFrames: 3 }); w.renderer._bindings._update(G);
    const g0 = w.calls.get; w.renderer._bindings._update(G); const perCall = w.calls.get - g0;   // what the fake's own _update does
    for (let i = 0; i < 100; i++) w.renderer._bindings._update(G);
    ok(w.calls.get - g0 === perCall * 101, 'steady state: the guard adds no backend lookups per call (epoch 0)');
    w.au.destroyAttribute(V);
    const c = w.calls.get; w.renderer._bindings._update(G);
    ok(w.calls.get - c === perCall, 'a released VERTEX attribute does not trigger group verification');
    ok(api.pending() === 1, 'the vertex buffer is parked too');
    api.uninstall();
  }
  { const fs = require('fs'), path = require('path'), src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    ok(/DMGpuDefer\.install\(flightRenderer/.test(src), 'index.html installs the guard on the flight renderer'); }
  console.log(fails ? 'gpu-defer: ' + fails + ' FAILED of ' + n : 'gpu-defer: all ' + n + ' passed'); process.exit(fails ? 1 : 0);
})();
