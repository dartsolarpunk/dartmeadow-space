// node tools/tests/charselect-ui.test.js — v381 Articren selector / editor card UI.
// Pure node: source contracts on the real files + the exported uiMachine state machine
// (no THREE, no browser).  The machine is the only new control flow: select (wheel +
// continue pop-out) <-> editor (one taller card) <-> leave.  No eye / hide toggle.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = rd('index.html'), js = rd('ui/dm-charselect.js'), css = rd('ui/dm-charselect.css'), ui = rd('ui/dm-ui.css'), menu = rd('ui/dm-menu.css');
let n = 0, fails = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('  FAIL ' + m); } else if (process.env.VERBOSE) console.log('  ok   ' + m); };

const screen = html.slice(html.indexOf('id="screen-character"'), html.indexOf('id="screen-builder"'));

// ── contracts: reuse the main-menu card system
ok(ui.includes('.dm-card,.mm-frame') && ui.includes('clip-path:polygon(var(--cut)'), 'shared .mm-frame / .dm-card hairline lives in ui/dm-ui.css');
ok(/@keyframes mmOpenL/.test(menu) && /@keyframes mmCloseR/.test(menu), 'hinge keyframes live in ui/dm-menu.css (reused, not redeclared)');
ok(!/@keyframes mmOpenL/.test(css) && !/@keyframes mmCloseL/.test(css), 'charselect.css does not redeclare menu hinge keyframes');
ok(/animation:mmOpenB/.test(css) && /animation:mmOpenR/.test(css) && /animation:mmCloseB/.test(css) && /animation:mmCloseR/.test(css), 'selector + editor animate with mmOpen / mmClose');
ok(/class="cs-card mm-frame"/.test(js) && /cs-card-slot mm-panel/.test(js), 'character cards are mm-panel slots wrapping an mm-frame');
ok(/id="cs-continue" class="mm-panel mm-frame mm-hinge-bottom"/.test(screen), 'continue is a small mm-frame pop-out card');
ok(/id="cs-panel" class="mm-panel mm-frame mm-hinge-right"/.test(screen), 'editor is one taller mm-frame card');
ok(/id="cs-head" class="mm-panel mm-hinge-top"/.test(screen), 'header uses the same top-hinge panel as the main menu title');
ok(/id="cs-next"/.test(screen) && screen.indexOf('id="cs-continue"') < screen.indexOf('id="cs-next"') && /W\.goScreen\('builder'\)/.test(js), 'cs-next still lives in the pop-out and continues to the builder');

// ── no leftover footer VIEW button, no eye / hide toggle, never "Pilot" in the UI
ok(!/id="cs-open"/.test(html) && !/id="cs-foot"/.test(html), 'VIEW footer (#cs-open / #cs-foot) is gone');
ok(!/VIEW ARIEL|id="cs-open"/.test(js), 'JS no longer binds a VIEW button');
const uiText = screen + js + css;
ok(!/\beye\b/i.test(screen) && !/id="cs-eye"|id="cs-hide"|cs-eye|cs-hide/.test(screen + js), 'no eye or dismiss control in the Articren selector or editor');
ok(!/\bPilot\b/.test(screen) && !/\bPilot\b/.test(css), 'character screen + charselect CSS never say Pilot');
const jsNoComments = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/\bPilot\b/.test(jsNoComments), 'charselect.js runtime strings never say Pilot');
ok(/CHOOSE YOUR ARTICREN/.test(screen) && /TAP A CARD TO EDIT/.test(screen), 'selector copy names Articren and says tap a card to edit');

// ── goScreen folds the character screen like the menu
const gs = html.slice(html.indexOf('function goScreen('), html.indexOf('function goScreen(') + 9000);
ok(/cs\.classList\.add\('cs-leaving'\)/.test(gs) && /cs-leaving/.test(css), 'goScreen adds .cs-leaving so the cards fold away');
ok(/if\(name==='character'\)\{\$\('screen-character'\)\.classList\.add\('active'\)/.test(html), 'goScreen character branch is intact');
ok(/_prevScreen==='character'&&name!=='character'&&window\.DMCharSelect\) DMCharSelect.leave\(\)/.test(html), 'leaving still disposes the studio');

// ── touch-friendly targets kept, ATMO_DEFAULT_AGL untouched
ok(/min-height:44px/.test(css) && /min-height:48px/.test(css), 'controls stay 44 px; continue is 48 px');
ok(/ATMO_DEFAULT_AGL\s*=\s*46/.test(html), 'ATMO_DEFAULT_AGL stays 46');

// ── state machine
const sandbox = { window: {}, document: { getElementById() { return null; }, readyState: 'complete', addEventListener() {} }, console };
sandbox.window = sandbox;
vm.runInNewContext(js, sandbox, { filename: 'dm-charselect.js' });
const M = sandbox.window.DMCharSelect;
ok(M && typeof M.uiMachine === 'function' && typeof M.uiState === 'function', 'DMCharSelect exports uiMachine + uiState');
const idle = { mode: 'idle', pickedId: null };
const entered = M.uiMachine(idle, { type: 'enter', pickedId: 'ariel' });
ok(entered.mode === 'select' && entered.pickedId === 'ariel', 'enter -> select with the picked id');
const picked = M.uiMachine(entered, { type: 'pick', id: 'emma' });
ok(picked.mode === 'select' && picked.pickedId === 'emma', 'pick updates the centred id and keeps the continue pop-out');
const editing = M.uiMachine(picked, { type: 'edit', id: 'emma' });
ok(editing.mode === 'editor' && editing.pickedId === 'emma', 'tapping the centred card enters the editor');
const ignoredPick = M.uiMachine(editing, { type: 'pick', id: 'ariel' });
ok(ignoredPick.mode === 'editor', 'a wheel pick while editing does not close the editor');
const back = M.uiMachine(editing, { type: 'back' });
ok(back.mode === 'select' && back.pickedId === 'emma', 'BACK leaves the editor on the same Articren');
const leaving = M.uiMachine(back, { type: 'leave' });
ok(leaving.mode === 'leaving' && leaving.pickedId === 'emma', 'leave starts the fold-away state');
const done = M.uiMachine(leaving, { type: 'idle' });
ok(done.mode === 'idle', 'idle after the screen is gone');
ok(M.uiState().mode === 'idle', 'uiState starts idle before enter (no DOM)');

function finishTests() {
  console.log(fails ? 'charselect-ui: ' + fails + ' FAILED of ' + n : 'charselect-ui: all ' + n + ' passed');
  process.exit(fails ? 1 : 0);
}

// ── Watcher NAY contracts (v381 fix)
const mw = rd('ui/dm-menuworld.css');
ok(/transform-style:\s*preserve-3d/.test(css), '3D carousel: .cs-card-slot keeps preserve-3d so rotateY reaches the wheel perspective');
ok(!/#cs-panel\{[^}]*background:\s*transparent/.test(css), '#cs-panel does not set background:transparent (would kill the .mm-frame ring and fill)');
ok(!/#cs-panel\{[^}]*background:/.test(css), '#cs-panel does not set a competing background (mm-frame owns the ring and fill)');
ok(/#cs-studio \.cs-sw::before[\s\S]{0,400}clip-path:polygon\(var\(--cut\)/.test(css) && /#cs-studio \.cs-sw\.on[\s\S]{0,180}--lc:var\(--cyan\)/.test(css), 'editor swatches are chamfered framed buttons with a lit cyan selected state');
ok(/#cs-studio \.cs-sw,#cs-studio \.cs-lg\{[^}]*filter:drop-shadow/.test(css) && !/#cs-studio \.cs-sw,#cs-studio \.cs-lg\{[^}]*clip-path:/.test(css), 'swatch/logo drop-shadow is on the host, not under clip-path');
ok(/#cs-studio #cs-tabs button\{[\s\S]{0,360}background:rgba\(var\(--acc-rgb\),\.06\)/.test(css) && /#cs-studio \.cs-btn\{[\s\S]{0,360}background:rgba\(var\(--acc-rgb\),\.06\)/.test(css), 'editor tabs and Back/Select reuse the menu-row glass');

ok(!/#screen-character\.mw-on \.cs-card\{[^}]*clip-path:/.test(mw) && !/#screen-character\.mw-on \.cs-card\{[^}]*background:/.test(mw), 'mw-on .cs-card does not override mm-frame clip-path or background');
ok(/\.cs-card-slot:nth-child\(2n\) \.cs-card\{animation-duration:7\.7s/.test(mw) && /\.cs-card-slot:nth-child\(3n\) \.cs-card\{animation-duration:8\.9s/.test(mw), 'mw-on bob stagger is keyed off .cs-card-slot:nth-child (the wheel children)');
ok(/cur && cur\.ready/.test(js) && /W\.DMChars\.get\(W\.DMChars\.selectedId\(\)\)/.test(js), 'Continue names the centred card only when it is ready, otherwise the saved pick');
ok(/clearTimeout\(closeStudio\._t\)/.test(js) && /openStudio[\s\S]{0,250}clearTimeout\(closeStudio\._t\)/.test(js), 'openStudio clears the closeStudio finish timer before reopening');
ok(/studio && !CS\.studioOpen[\s\S]{0,80}classList\.remove\('open', 'leaving'\)/.test(js), 'CS.enter strips leftover .open / .leaving when the studio is not open');
ok(/sc\.classList\.remove\('cs-leaving'\)/.test(js), 'CS.enter clears .cs-leaving');

// ── stuck-editor regressions: leave with the editor open then re-enter; reopen during the 550 ms close
function makeDom() {
  const byId = {};
  const mkClass = (init) => {
    const s = new Set((init || '').split(/\s+/).filter(Boolean));
    return {
      add(...c) { c.forEach((x) => s.add(x)); },
      remove(...c) { c.forEach((x) => s.delete(x)); },
      contains(c) { return s.has(c); },
      toggle(c, on) { if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (on) s.add(c); else s.delete(c); },
    };
  };
  const el = (id, className) => {
    const rec = {
      id, className: className || '', style: {}, hidden: false, textContent: '', innerHTML: '',
      children: [], dataset: {}, parentNode: null, _bound: false,
      classList: mkClass(className),
      addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
      appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
      querySelector() { return { textContent: '', style: {}, classList: mkClass(''), className: 'cs-thumb empty' }; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0, right: 0, bottom: 0, left: 0, width: 200, height: 200 }; },
      offsetWidth: 200, offsetHeight: 250, offsetLeft: 0, clientWidth: 800, scrollLeft: 0,
      scrollTo() {},
    };
    if (id) byId[id] = rec;
    return rec;
  };
  const studio = el('cs-studio', 'open');
  const screen = el('screen-character', 'screen active');
  const wheel = el('cs-wheel');
  const next = el('cs-next');
  const stage = el('cs-stage');
  el('cs-head'); el('cs-back'); el('cs-sback'); el('cs-sselect'); el('cs-continue');
  el('cs-pname'); el('cs-ptag'); el('cs-load'); el('cs-turn'); el('cs-panel');
  el('cs-tabs'); el('cs-pbody'); el('cs-dots'); el('cs-bg'); el('cs-list'); el('cs-hint');
  const els = { studio, screen, wheel, next, stage, byId };
  const createElement = (tag) => {
    const rec = el(null, tag === 'button' ? 'cs-card-slot mm-panel' : '');
    rec.tagName = String(tag).toUpperCase();
    rec.type = ''; rec.textContent = '';
    const q = {};
    rec.innerHTML = '';
    rec.querySelector = (sel) => {
      if (!q[sel]) q[sel] = { textContent: '', style: { display: '' }, classList: mkClass(sel.includes('thumb') ? 'cs-thumb empty' : ''), className: sel.includes('thumb') ? 'cs-thumb empty' : '', setAttribute() {}, getAttribute() { return ''; } };
      return q[sel];
    };
    rec.addEventListener = () => {};
    return rec;
  };
  return { els, createElement, byId };
}

function loadSelect(dom, chars) {
  const box = {
    window: {},
    document: {
      readyState: 'complete',
      getElementById: (id) => dom.byId[id] || null,
      addEventListener() {},
      createElement: dom.createElement,
      querySelector(sel) { return null; },
      querySelectorAll(sel) {
        if (sel === '#cs-wheel .cs-card-slot') return dom.els.wheel.children;
        if (sel === '#cs-dots i') return [];
        return [];
      },
    },
    console,
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    performance: { now: () => Date.now() },
    innerWidth: 800, innerHeight: 600,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    STATE: { screen: 'character' },
  };
  box.window = box;
  box.DMChars = chars;
  vm.runInNewContext(js, box, { filename: 'dm-charselect.js' });
  return box;
}

const ariel = { id: 'ariel', name: 'Ariel', tag: 'READY', ready: true };
const soon = { id: 'soon', name: 'Nova', tag: 'SOON', ready: false };
const chars = {
  list: () => [ariel, soon],
  get: (id) => [ariel, soon].find((d) => d.id === id) || null,
  selectedId: () => 'ariel',
  lookSig: () => '1',
  onChange() { return () => {}; },
  setSelected() {},
  regions: () => [],
  look: () => ({ colors: {} }),
  isDefaultLook: () => true,
  resolveForGame: () => ({ def: ariel, wanted: 'ariel', fellBack: false }),
};

{
  const dom = makeDom();
  const box = loadSelect(dom, chars);
  const CS = box.window.DMCharSelect;
  CS.studioOpen = true;
  box.STATE.screen = 'menu';   // goScreen already left the character screen
  CS.leave();
  ok(!CS.studioOpen, 'leave with the editor open clears studioOpen');
  ok(!dom.els.studio.classList.contains('open') && !dom.els.studio.classList.contains('leaving'), 'leave strips #cs-studio .open / .leaving (no stuck empty editor)');
}

{
  const dom = makeDom();
  const box = loadSelect(dom, chars);
  const CS = box.window.DMCharSelect;
  // leftover chrome from a previous leave that failed to finish(), then re-enter
  CS.studioOpen = false;
  dom.els.studio.classList.add('open', 'leaving');
  dom.els.screen.classList.add('cs-leaving');
  box.STATE.screen = 'character';
  CS.enter();
  ok(!dom.els.studio.classList.contains('open') && !dom.els.studio.classList.contains('leaving'), 're-enter strips a leftover empty editor when studioOpen is false');
  ok(!dom.els.screen.classList.contains('cs-leaving'), 're-enter clears .cs-leaving');
  ok(CS.uiState().mode === 'select', 're-enter lands in select mode');
}

const reopenP = (() => {
  const dom = makeDom();
  const box = loadSelect(dom, chars);
  const CS = box.window.DMCharSelect;
  CS.studioOpen = true;
  box.STATE.screen = 'character';
  CS.closeStudio({ thumb: false });   // animated close: finish() is scheduled for 550 ms
  ok(!CS.studioOpen, 'closeStudio clears studioOpen immediately');
  ok(dom.els.studio.classList.contains('leaving') || dom.els.studio.classList.contains('open'), 'animated close starts with the editor still visible');
  ok(!!CS.closeStudio._t, 'animated close scheduled finish()');
  const p = CS.openStudio('ariel');
  ok(!CS.closeStudio._t, 'reopen during close clears the finish timer');
  return Promise.resolve(p).then(() => new Promise((r) => setTimeout(r, 650))).then(() => {
    ok(dom.els.studio.classList.contains('open'), 'reopen during close is not hidden by a late finish()');
    ok(!dom.els.studio.classList.contains('leaving'), 'reopened editor is not stuck in .leaving');
    ok(CS.studioOpen, 'reopen leaves studioOpen true');
  });
})();

reopenP.then(finishTests, (e) => { console.log(e && e.stack || e); fails++; finishTests(); });
