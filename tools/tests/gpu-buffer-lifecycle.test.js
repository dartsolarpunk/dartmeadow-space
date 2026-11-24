// node tools/tests/gpu-buffer-lifecycle.test.js — t1653 Track 4 (CE-9): "[Buffer (unlabeled)] used in submit while destroyed" on the Solenne mansion deck and in space.
// A faithful miniature of three r185's WebGPU buffer lifecycle (Backend data map, WebGPUAttributeUtils.createAttribute / destroyAttribute keyed on the
// InterleavedBuffer, Attributes.delete / update, Geometries.initGeometry dispose listener + the once-only attributeCall for interleaved attributes) and a
// device whose submit() validates every buffer a draw binds, like Dawn / WebKit do.  Proves:
//   A. the root cause: unguarded, disposing ONE geometry of a GLB whose primitives share an InterleavedBuffer (every KHR_mesh_quantization / meshopt asset)
//      leaves the sibling (and the same geometry when drawn again) binding a destroyed buffer -> the error on EVERY frame;
//   B. guarded (ui/dm-gpu-defer.js): no submit ever sees a destroyed buffer, the shared buffer is released only with its last user, re-drawn geometry re-uploads;
//   C. a released buffer is NEVER destroyed before BOTH >= 4 frames AND an onSubmittedWorkDone fence issued after the release has resolved, and never inside submit;
//   D. labels name the owner; heal() repairs a stale entry named by an error; uniform buffers and the OOM path obey the same fence; re-disposed geometry is freed.
'use strict';
const D = require('../../ui/dm-gpu-defer.js');
const fs = require('fs'), path = require('path');
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };
const settle = () => new Promise((r) => setImmediate(r));

// ── three-like scene objects ──
let ids = 0;
class Emitter { constructor() { this._l = {}; } addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); } removeEventListener(t, f) { const a = this._l[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } } dispatch(t) { (this._l[t] || []).slice().forEach((f) => f({ type: t, target: this })); } }
class IB { constructor(n) { this.array = new Float32Array(n); this.version = 0; this.name = ''; this.id = ++ids; } }
const iba = (ib, itemSize, offset, count) => ({ isInterleavedBufferAttribute: true, data: ib, itemSize, offset, count, name: '' });
const ba = (count, itemSize, extra) => Object.assign({ array: new Float32Array(count * itemSize), itemSize, count, version: 0, name: '' }, extra || {});
class Geo extends Emitter { constructor(attrs, index) { super(); this.attributes = attrs; this.index = index || null; } dispose() { this.dispatch('dispose'); } }

// ── the GPU ──
function gpu() {
  const log = { submits: 0, errors: [], destroyCalls: 0, inSubmit: false, destroyedInSubmit: 0, fences: [] };
  const mkBuf = (desc) => ({ label: desc.label || '', size: desc.size, destroyed: false, destroy() { this.destroyed = true; log.destroyCalls++; if (log.inSubmit) log.destroyedInSubmit++; }, getMappedRange() { return new ArrayBuffer(desc.size); }, unmap() { } });
  const device = {
    createBuffer: (desc) => mkBuf(desc),
    queue: {
      submit(bufs) { log.inSubmit = true; log.submits++; for (const b of new Set(bufs)) if (b.destroyed) { const name = b.label ? 'Buffer "' + b.label + '"' : 'Buffer (unlabeled)'; log.errors.push('[' + name + '] used in submit while destroyed.'); } log.inSubmit = false; },
      onSubmittedWorkDone() { return new Promise((r) => log.fences.push(r)); },
    },
  };
  return { device, log };
}

// ── r185 internals (WebGPU backend path only) ──
function three(dev) {
  class DataMap { constructor() { this.data = new WeakMap(); } get(o) { let m = this.data.get(o); if (m === undefined) { m = {}; this.data.set(o, m); } return m; } delete(o) { let r = null; if (this.data.has(o)) { r = this.data.get(o); this.data.delete(o); } return r; } has(o) { return this.data.has(o); } }
  const be = new DataMap(); be.device = dev;
  const getBA = (a) => (a.isInterleavedBufferAttribute ? a.data : a);
  const au = {
    backend: be, _getBufferAttribute: getBA,
    createAttribute(attribute, usage) { const key = getBA(attribute), d = be.get(key); if (d.buffer === undefined) d.buffer = dev.createBuffer({ label: key.name, size: key.array.byteLength, usage, mappedAtCreation: true }); },
    destroyAttribute(attribute) { const d = be.get(getBA(attribute)); d.buffer.destroy(); be.delete(attribute); },   // r185 verbatim: deletes the ATTRIBUTE key
  };
  be.attributeUtils = au;
  be.createAttribute = (a) => au.createAttribute(a, 0x20 | 0x04 | 0x08);
  be.createIndexAttribute = (a) => au.createAttribute(a, 0x10 | 0x04 | 0x08);
  be.destroyAttribute = (a) => au.destroyAttribute(a);
  be.destroyUniformBuffer = function (ub) { const d = this.get(ub); d.buffer.destroy(); this.delete(ub); };
  class Attributes extends DataMap {
    delete(a) { const d = super.delete(a); if (d !== null) be.destroyAttribute(a); return d; }
    update(a, type) { const d = this.get(a); if (d.version === undefined) { if (type === 'index') be.createIndexAttribute(a); else be.createAttribute(a); d.version = getBA(a).version; } }
  }
  const attributes = new Attributes(); let calls = 0;
  class Geometries extends DataMap {
    constructor() { super(); this.attributeCall = new WeakMap(); }
    has(ro) { return super.has(ro.geometry) && this.get(ro.geometry).initialized === true; }
    initGeometry(ro) {
      const g = ro.geometry; this.get(g).initialized = true;
      const onDispose = () => { if (g.index) attributes.delete(g.index); for (const k in g.attributes) attributes.delete(g.attributes[k]); g.removeEventListener('dispose', onDispose); };
      g.addEventListener('dispose', onDispose);
    }
    updateAttribute(a, type) {
      if (!a.isInterleavedBufferAttribute) { if (this.attributeCall.get(a) !== calls) { attributes.update(a, type); this.attributeCall.set(a, calls); } }
      else if (this.attributeCall.get(a) === undefined) { attributes.update(a, type); this.attributeCall.set(a, calls); }   // r185: ONCE per interleaved attribute, ever
    }
    updateForRender(ro) { if (this.has(ro) === false) this.initGeometry(ro); for (const k in ro.geometry.attributes) this.updateAttribute(ro.geometry.attributes[k], 'vertex'); if (ro.geometry.index) this.updateAttribute(ro.geometry.index, 'index'); }
  }
  const geometries = new Geometries();
  const renderer = { backend: be, _attributes: attributes, _geometries: geometries };
  // render(list): one render call = one command buffer; every draw binds be.get(vertexBuffer).buffer (WebGPUBackend.draw: setVertexBuffer(i, this.get(vertexBuffer).buffer))
  renderer.render = (geos) => {
    calls++; const bound = [];
    for (const g of geos) { const ro = { geometry: g }; geometries.updateForRender(ro);
      for (const k in g.attributes) { const b = be.get(getBA(g.attributes[k])).buffer; if (!b) throw new Error('draw with no buffer'); bound.push(b); }
      if (g.index) bound.push(be.get(g.index).buffer); }
    dev.queue.submit(bound);
  };
  return renderer;
}

// a quantized GLB: two primitives (hull + trim) whose position/normal live in ONE interleaved bufferView (GLTFLoader caches the InterleavedBuffer per bufferView)
function glb() {
  const ib = new IB(64);
  const hull = new Geo({ position: iba(ib, 3, 0, 8), normal: iba(ib, 3, 4, 8) }, ba(12, 1, { isIndex: true }));
  const trim = new Geo({ position: iba(ib, 3, 0, 8), normal: iba(ib, 3, 4, 8) }, ba(6, 1));
  return { ib, hull, trim };
}

(async () => {
  // ── A. root cause, unguarded ──
  {
    const { device, log } = gpu(), R = three(device), { hull, trim } = glb();
    R.render([hull, trim]); ok(log.errors.length === 0, 'A: first frame is clean');
    hull.dispose();                                   // LOD / rebuild / cleanup disposes one primitive
    for (let f = 0; f < 5; f++) R.render([trim]);
    ok(log.errors.length === 5 && /Buffer \(unlabeled\)\] used in submit while destroyed/.test(log.errors[0]), 'A: unguarded r185 -> the sibling binds the destroyed shared buffer on EVERY frame (' + log.errors.length + ' errors / 5 frames)');
    const e0 = log.errors.length; R.render([hull]); ok(log.errors.length === e0 + 1, 'A: the disposed geometry drawn again never re-uploads (once-only interleaved update) -> error');
  }
  // ── B. guarded: no destroyed buffer is ever submitted ──
  {
    const { device, log } = gpu(), R = three(device), api = D.install(R, { minFrames: 4 }), { ib, hull, trim } = glb();
    ok(api && api.minFrames === 4, 'B: installed with MIN 4 frames');
    R.render([hull, trim]);
    const shared = R.backend.get(ib).buffer;
    ok(/^dm:ivb#\d+:3x8$/.test(shared.label), 'B: the shared interleaved buffer is labeled (' + shared.label + ')');
    ok(/^dm:idx#\d+:1x12$/.test(R.backend.get(hull.index).buffer.label), 'B: index buffers are labeled');
    hull.dispose();
    ok(api.pending() === 1 && !shared.destroyed, 'B: only hull\'s own index buffer is parked; the shared buffer is kept (trim still reads it)');
    ok(api.stats.sharedKept === 2, 'B: both of hull\'s interleaved attributes saw a live sibling');
    for (let f = 0; f < 30; f++) { api.tick(); R.render([trim]); await settle(); log.fences.splice(0).forEach((r) => r()); await settle(); }
    ok(log.errors.length === 0, 'B: 30 frames drawing the sibling: zero "used in submit while destroyed"');
    ok(!shared.destroyed, 'B: the shared buffer is alive while any attribute uses it');
    R.render([hull]); ok(log.errors.length === 0, 'B: the disposed hull drawn again is valid');
    trim.dispose(); hull.dispose();
    ok(api.stats.ibReleased >= 1 && R.backend.has(ib) === false, 'B: last user released -> the InterleavedBuffer\'s backend entry is dropped (no dead buffer left behind)');
    for (let f = 0; f < 8; f++) { api.tick(); await settle(); log.fences.splice(0).forEach((r) => r()); await settle(); }
    ok(shared.destroyed, 'B: ...and its GPU buffer is destroyed once safe');
    R.render([trim]);
    ok(log.errors.length === 0 && R.backend.get(ib).buffer !== shared && !R.backend.get(ib).buffer.destroyed, 'B: a geometry drawn again after its last release re-uploads a FRESH buffer');
    ok(log.destroyedInSubmit === 0, 'B: nothing was destroyed inside a submit');
    api.uninstall();
  }
  // ── C. never before BOTH >= 4 frames AND a post-release fence ──
  {
    const { device, log } = gpu(), R = three(device), api = D.install(R, { minFrames: 4 });
    const g = new Geo({ position: ba(8, 3) }); R.render([g]); const buf = R.backend.get(g.attributes.position).buffer;
    // a fence issued BEFORE the release must not count
    const g0 = new Geo({ position: ba(4, 3) }); R.render([g0]); g0.dispose(); api.tick(); const early = log.fences.splice(0);
    g.dispose(); ok(!buf.destroyed && api.pending() === 2, 'C: dispose parks, does not destroy');
    early.forEach((r) => r()); await settle();
    for (let f = 0; f < 12; f++) { api.tick(); R.render([]); await settle(); }
    ok(!buf.destroyed, 'C: 12 frames but no fence issued after the release has resolved -> still alive (a pre-release fence does not count)');
    ok(log.fences.length === 1, 'C: exactly one fence in flight');
    log.fences.splice(0).forEach((r) => r()); await settle();
    ok(!buf.destroyed, 'C: fence resolved -> still not destroyed from the promise callback (only at the top of a frame)');
    api.tick(); ok(buf.destroyed, 'C: destroyed on the next tick (frames + fence satisfied)');
    // frames gate: fence resolves at once, but < 4 frames
    const g2 = new Geo({ position: ba(8, 3) }); R.render([g2]); const b2 = R.backend.get(g2.attributes.position).buffer; g2.dispose();
    for (let f = 0; f < 3; f++) { api.tick(); await settle(); log.fences.splice(0).forEach((r) => r()); await settle(); }
    ok(!b2.destroyed, 'C: fence resolved but only 3 frames elapsed -> alive');
    api.tick(); await settle(); log.fences.splice(0).forEach((r) => r()); await settle(); api.tick();
    ok(b2.destroyed, 'C: destroyed once 4+ frames AND a post-release fence');
    // a buffer three still names is never destroyed
    const g3 = new Geo({ position: ba(8, 3) }); R.render([g3]); const k3 = g3.attributes.position, b3 = R.backend.get(k3).buffer; g3.dispose();
    R.backend.get(k3).buffer = b3;   // something re-pointed three at it
    for (let f = 0; f < 8; f++) { api.tick(); await settle(); log.fences.splice(0).forEach((r) => r()); await settle(); }
    ok(!b3.destroyed && api.stats.keptLive === 1, 'C: a parked buffer three still names is kept, not destroyed');
    // idle steady state: no fences, no allocation
    const f0 = api.stats.fences; for (let f = 0; f < 50; f++) api.tick(); ok(api.stats.fences === f0 && api.pending() === 0, 'C: nothing parked -> no fence per frame');
    api.uninstall();
  }
  // ── D. labels / heal / uniforms / OOM / re-disposed geometry ──
  {
    const { device, log } = gpu(), R = three(device), api = D.install(R, { minFrames: 4 });
    const g = new Geo({ position: ba(8, 3, { name: 'hull pos' }) }); R.render([g]); const a = g.attributes.position, old = R.backend.get(a).buffer;
    ok(/^dm:vtx#\d+:hullpos:3x8$/.test(old.label), 'D: vertex buffer label names its owner (' + old.label + ')');
    g.dispose(); for (let f = 0; f < 8; f++) { api.tick(); await settle(); log.fences.splice(0).forEach((r) => r()); await settle(); }
    ok(old.destroyed, 'D: destroyed when safe');
    // a stale cache somewhere still names it: the error carries the label, heal() makes three re-create it
    R.backend.get(a).buffer = old; R._attributes.get(a).version = 0;
    R.render([g]); const msg = log.errors[log.errors.length - 1] || '';
    ok(/\[Buffer "dm:vtx#\d+:hullpos:3x8"\] used in submit while destroyed/.test(msg), 'D: the error names the labeled buffer, not "(unlabeled)"');
    ok(api.heal(msg) === true && api.stats.healed === 1, 'D: heal() recognises a buffer we destroyed');
    const e0 = log.errors.length; R.render([g]); ok(log.errors.length === e0 && R.backend.get(a).buffer !== old, 'D: after heal the next draw re-uploads a valid buffer');
    ok(api.heal('[Buffer "bindingBuffer3_x"] used in submit while destroyed.') === false, 'D: heal ignores buffers that are not ours');
    // uniform buffers go through the same fence
    const ub = {}; R.backend.get(ub).buffer = device.createBuffer({ label: 'u', size: 16 }); const ubuf = R.backend.get(ub).buffer;
    R.backend.destroyUniformBuffer(ub); ok(!ubuf.destroyed && api.stats.uniformDeferred === 1, 'D: a uniform buffer is parked, not destroyed');
    for (let f = 0; f < 8; f++) { api.tick(); await settle(); log.fences.splice(0).forEach((r) => r()); await settle(); }
    ok(ubuf.destroyed, 'D: ...and destroyed after frames + fence');
    // the re-disposed geometry frees its re-uploaded buffers (three r185 drops the dispose listener after the first dispose)
    const g4 = new Geo({ position: ba(8, 3) }); R.render([g4]); g4.dispose(); R.render([g4]); const b4 = R.backend.get(g4.attributes.position).buffer; const p0 = api.pending();
    g4.dispose(); ok(api.pending() === p0 + 1 && api.stats.geoReinit >= 1, 'D: a geometry disposed, drawn again and disposed again releases its new buffer too');
    // OOM path obeys the fence: a createBuffer that throws RangeError retries after destroying ONLY safe buffers
    ok(typeof device.createBuffer === 'function' && !!device.__dmCB, 'D: device.createBuffer is wrapped');
    api.uninstall(); ok(!device.__dmCB, 'D: uninstall restores createBuffer');
    let thrown = 0;
    // fresh install over a device whose createBuffer throws once
    const { device: d2, log: l2 } = gpu(); let first = true; const cb = d2.createBuffer; d2.createBuffer = function (desc) { if (first && desc.size === 999) { first = false; thrown++; throw new RangeError('Out of memory'); } return cb.call(this, desc); };
    const R2 = three(d2), api2 = D.install(R2, { minFrames: 4 });
    const g6 = new Geo({ position: ba(8, 3) }); R2.render([g6]); const b6 = R2.backend.get(g6.attributes.position).buffer; g6.dispose();
    for (let f = 0; f < 6; f++) api2.tick();
    d2.createBuffer({ size: 999, usage: 0x20 });
    ok(thrown === 1 && !b6.destroyed, 'D: OOM retry does not destroy a buffer whose fence has not resolved');
    l2.fences.splice(0).forEach((r) => r()); await settle(); first = true; d2.createBuffer({ size: 999, usage: 0x20 });
    ok(thrown === 2 && b6.destroyed, 'D: OOM retry frees buffers that are safe (frames + fence)');
    api2.uninstall();
  }
  // ── E. wiring ──
  {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    ok(/DMGpuDefer\.install\(flightRenderer,\{minFrames:4\}\)/.test(src), 'E: index.html installs with minFrames:4');
    ok(/uncapturederror[\s\S]{0,900}_dmGpuDefer\.heal\(m\)/.test(src), 'E: the uncaptured-error listener heals labeled destroyed buffers');
    ok(/_gpuRepeat/.test(src), 'E: a repeating GPU error is coalesced (not logged per frame)');
    const pl = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'dm-places.js'), 'utf8');
    ok(/recountRefs\(\);/.test(pl) && !/S\.cache\.forEach\(a=>\{ a\.refs=0; \}\);\n\s*if\(root\.DMCreatures/.test(pl), 'E: places world-close recounts refs (space clones keep their templates)');
  }
  console.log(fails ? 'gpu-buffer-lifecycle: ' + fails + ' FAILED of ' + n : 'gpu-buffer-lifecycle: all ' + n + ' passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
