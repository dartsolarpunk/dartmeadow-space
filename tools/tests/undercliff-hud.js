// undercliff-hud — the hatch FUNCTION button survives leave/re-enter of Solenne without stacking
// a second window keydown listener or a second <style> (one F press must call use() exactly once).
// Run: node tools/tests/undercliff-hud.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
let checks = 0, fails = 0;
function ok(c, msg) { checks++; if (!c) { fails++; console.log('  FAIL ' + msg); } else if (process.env.V) console.log('  ok   ' + msg); }
const byId = {}, styles = [], keyL = [];
function el(tag) {
  const e = { tagName: tag.toUpperCase(), children: [], parentNode: null, _id: '', textContent: '', innerHTML: '',
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    setAttribute() { }, addEventListener() { }, querySelector() { return null },
    appendChild(c) { c.parentNode = this; this.children.push(c); if (c._id) byId[c._id] = c; if (c.tagName === 'STYLE') styles.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; if (c._id && byId[c._id] === c) delete byId[c._id]; return c; } };
  Object.defineProperty(e, 'id', { get() { return this._id; }, set(v) { this._id = v; } });
  return e;
}
const doc = { createElement: el, getElementById: id => byId[id] || null, head: el('head'), body: el('body') };
const sb = { performance: { now: () => 1000 }, console, Math, Float64Array, Int16Array, Uint8Array, Set, Map, Promise, document: doc,
  atob: s => Buffer.from(s, 'base64').toString('binary'), fetch: () => Promise.reject(new Error('no fetch')), location: { search: '' },
  addEventListener(t, fn, cap) { if (t === 'keydown') keyL.push(fn); }, removeEventListener() { } };
sb.window = sb; sb.globalThis = sb;
vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/dm-undercliff.js'), 'utf8'), sb, { filename: 'dm-undercliff.js' });
const UC = sb.DMUndercliff, UX = UC._test;
ok(typeof UX.setHud === 'function', '_test.setHud exposed');
let uses = 0; const S = UX.S;
function press() { uses = 0; const before = S.want; for (const fn of keyL) fn({ code: 'KeyF', repeat: false, target: null, preventDefault() { } }); return S.want !== before ? 1 : 0; }
for (let visit = 1; visit <= 3; visit++) {
  UX.setHud(true);
  ok(!!byId['dm-hatch'], 'visit ' + visit + ': hatch button mounted');
  ok(keyL.length === 1, 'visit ' + visit + ': exactly 1 window keydown listener (got ' + keyL.length + ')');
  ok(styles.length === 1 && byId['dm-hatch-css'] === styles[0], 'visit ' + visit + ': exactly 1 #dm-hatch-css style (got ' + styles.length + ')');
  ok(doc.body.children.filter(c => c._id === 'dm-hatch').length === 1, 'visit ' + visit + ': exactly 1 hatch button');
  try { UC.detach(); } catch (e) { ok(false, 'visit ' + visit + ': detach threw ' + e.message); }
  ok(!byId['dm-hatch'] && S.hud === null && S.hudOn === false, 'visit ' + visit + ': detach removed the button');
}
// with the HUD off the surviving listener is inert
const w0 = S.want; for (const fn of keyL) fn({ code: 'KeyF', repeat: false, target: null, preventDefault() { } });
ok(S.want === w0, 'F with the hatch HUD off does nothing');
const src = fs.readFileSync(path.join(root, 'ui/dm-undercliff.js'), 'utf8');
ok(/if \(!S\.keyOn\) \{ S\.keyOn = true; G\.addEventListener\('keydown'/.test(src), 'keydown listener guarded by S.keyOn');
ok(/getElementById\('dm-hatch-css'\)/.test(src) && /st\.id = 'dm-hatch-css'/.test(src), 'style guarded by #dm-hatch-css');
console.log(fails ? fails + ' FAILED of ' + checks : 'undercliff-hud: all ' + checks + ' checks passed');
process.exit(fails ? 1 : 0);
