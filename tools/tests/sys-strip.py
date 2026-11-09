#!/usr/bin/env python3
"""DOM test (headless Chromium, 2000x924): bottom-right system strip + tap-to-skip of the launch fly-out + (t1472) glasses-flashlight button / lumen bar placement.
Usage: python3 -m http.server 8123 (repo root) ; python3 tools/tests/sys-strip.py [base_url]
Network is blocked except localhost (three.js never loads: the fly-out is driven with a stubbed DM_MENUSCENE)."""
import sys
from playwright.sync_api import sync_playwright
base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8123/index.html'
fails = []
def check(name, ok, info=''):
    print(('ok   ' if ok else 'FAIL ') + name, info)
    if not ok: fails.append(name)
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = b.new_context(viewport={'width': 2000, 'height': 924}, has_touch=True)
    pg = ctx.new_page()
    pg.route('**/*', lambda r: r.continue_() if 'localhost' in r.request.url else r.abort())
    pg.goto(base, wait_until='commit')
    pg.wait_for_function("document.getElementById('dm-sys')&&/%/.test(document.getElementById('dm-sys').textContent)", timeout=20000)
    t = pg.evaluate("document.getElementById('dm-sys').textContent")
    check('boot message with % in the strip', '...' in t and t.endswith('%'), t)
    r = pg.evaluate("(()=>{const e=document.getElementById('dm-sys').getBoundingClientRect();return [e.right,e.bottom,innerWidth,innerHeight,getComputedStyle(document.getElementById('dm-sys')).pointerEvents]})()")
    check('strip hugs bottom-right, pointer-events none', abs(r[0]-r[2]) < 1 and abs(r[1]-r[3]) < 1 and r[4] == 'none', r)
    check('old #toast / warm pill gone', pg.evaluate("!document.getElementById('toast')&&!document.getElementById('dm-warm-pill')"))
    pg.wait_for_function("!dmSys.loading()", timeout=20000)
    pg.evaluate("document.getElementById('loading-screen').style.display='none'")
    pg.evaluate("toast('hello',1500)"); pg.wait_for_timeout(300)
    check('toast() shim shows in strip', pg.evaluate("dmSys.text()") == 'hello')
    pg.evaluate("toast('second','warn',1500)"); pg.wait_for_timeout(100)
    check('newer message replaces text', pg.evaluate("dmSys.text()") == 'second')
    pg.wait_for_timeout(2400)
    check('auto fades', pg.evaluate("document.getElementById('dm-sys').className===''"))
    # (t1472) glasses flashlight: a custom icon button docked right of the LEFT stick of each HUD (space #jL, sky #atmo-steer-zone, ground
    # #surf-move-zone), its vertical lumen bar beside it; never over a stick / pad / button, not in the centre column (#dm-sys), stick touches untouched
    FL = """([ov,mode,act])=>{ document.getElementById('app').classList.add('vis'); const prev=[...document.querySelectorAll('.screen.active')]; document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
        document.getElementById('screen-flight').classList.add('active'); const o=ov?document.getElementById(ov):null; if(o) o.style.display='block';
        document.body.classList.toggle('pw-hud',mode!=='space');   // as _pwSetMode: the space HUD hides under the sky / ground HUD
        const d=document.getElementById('dm-sys'); d.style.transition='none'; void d.offsetWidth;
        DMFlash.tick(''); DMFlash.tick(mode); if(act==='on') DMFlash.toggle(true);
        const w=document.getElementById('dm-flash'), btn=w.querySelector('.fl-btn'), bar=w.querySelector('.fl-bar'), st=document.getElementById(DMFlash.STICK[mode]);
        const R=e=>{ const r=e.getBoundingClientRect(); return [r.left,r.top,r.right,r.bottom]; }, B=R(btn), A=R(bar), S=R(st), E=R(d), hit=[];
        const ov2=(a,b)=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1];
        for(const q of document.querySelectorAll('#screen-flight .joystick-zone,#dart-pads,#roll-row,#level-stack,#assist-row,#ship-jump-btn,#minimap,.kite-board.kb-float,#surf-move-zone,#surf-look-zone,#atmo-steer-zone,#atmo-climb-zone,#ap-btn-atmo,#atmo-level-btn,#atmo-mark-btn,#atmo-throttle,#ship-liftoff-btn,#surface-overlay button,#atmo-overlay button,#hud-mode-badge,.hud-c .kite-board')){
          if(w.contains(q)) continue; const r=q.getBoundingClientRect(); if(r.width<2||r.height<2) continue; const qr=[r.left,r.top,r.right,r.bottom];
          if(ov2(B,qr)||(getComputedStyle(bar).display!=='none'&&ov2(A,qr))) hit.push(q.id||q.className||q.tagName); }
        const sc=document.elementFromPoint((S[0]+S[2])/2,(S[1]+S[3])/2), stickOwn=!!sc&&(sc===st||st.contains(sc));
        const bc=document.elementFromPoint((B[0]+B[2])/2,(B[1]+B[3])/2), btnOwn=!!bc&&(bc===btn||btn.contains(bc));
        const out={vis:getComputedStyle(w).display, B, A, S, E, hit, stickOwn, btnOwn, barOn:getComputedStyle(bar).display, segs:bar.children.length, sysOn:d.classList.contains('on'), W:innerWidth, txt:btn.textContent.trim(), svg:!!btn.querySelector('svg')};
        if(o) o.style.display='none'; document.body.classList.remove('pw-hud'); document.getElementById('screen-flight').classList.remove('active'); prev.forEach(s=>s.classList.add('active')); d.style.transition=''; return out; }"""
    pg.evaluate("toast('in play',9000)")
    for vw, vh in ((2000, 924), (844, 390), (390, 844)):
        pg.set_viewport_size({'width': vw, 'height': vh}); pg.wait_for_timeout(150)
        for ov, mode in (('', 'space'), ('surface-overlay', 'walk'), ('atmo-overlay', 'fly')):
            g = pg.evaluate(FL, [ov, mode, 'on']); tag = 'flashlight %dx%d %s: ' % (vw, vh, mode)
            B, A, S, E = g['B'], g['A'], g['S'], g['E']
            check(tag + 'shown, icon only (svg, no text label)', g['vis'] == 'block' and g['svg'] and g['txt'] == '', (g['vis'], g['txt']))
            check(tag + 'docked right of the LEFT stick (or its level pads), bottom-aligned', 0 <= B[0] - S[2] <= 64 and abs(B[3] - S[3]) <= 2, (B, S))
            check(tag + 'lumen bar open beside the button, 5 steps, vertical', g['barOn'] == 'flex' and g['segs'] == 5 and A[0] >= B[2] and A[3]-A[1] > (A[2]-A[0]) * 2.5, A)
            check(tag + 'overlaps no stick / pad / button', not g['hit'], g['hit'])
            check(tag + 'not in the centre column: left of centre, clear of the system bar', max(B[2], A[2]) <= g['W'] / 2 and not (E[0] < A[2] and E[2] > B[0] and E[1] < max(A[3], B[3]) and E[3] > min(A[1], B[1])), (B, A, E, g['W']))
            check(tag + 'the left stick still owns its touches; the button owns its own', g['stickOwn'] and g['btnOwn'])
    # tap toggles, a segment picks the step (real touch input on the walk HUD, phone landscape)
    pg.set_viewport_size({'width': 844, 'height': 390}); pg.wait_for_timeout(150)
    pg.evaluate("DMFlash.toggle(false); DMFlash.setStep(2)")
    pg.evaluate("""()=>{ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); document.getElementById('screen-flight').classList.add('active'); document.getElementById('surface-overlay').style.display='block'; DMFlash.tick(''); DMFlash.tick('walk'); }""")
    bb = pg.evaluate("(()=>{const r=document.querySelector('#dm-flash .fl-btn').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()")
    pg.touchscreen.tap(bb[0], bb[1]); pg.wait_for_timeout(120)
    check('flashlight tap: on, bar opens', pg.evaluate("DMFlash.status().on&&getComputedStyle(document.querySelector('#dm-flash .fl-bar')).display==='flex'"))
    sg = pg.evaluate("(()=>{const r=document.querySelectorAll('#dm-flash .fl-seg')[4].getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()")
    pg.touchscreen.tap(sg[0], sg[1]); pg.wait_for_timeout(120)
    check('flashlight: top segment = 4000 lm', pg.evaluate("DMFlash.lumens()") == 4000, pg.evaluate("DMFlash.lumens()"))
    sg = pg.evaluate("(()=>{const r=document.querySelectorAll('#dm-flash .fl-seg')[0].getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()")
    pg.touchscreen.tap(sg[0], sg[1]); pg.wait_for_timeout(120)
    check('flashlight: bottom segment = 750 lm, one lit segment', pg.evaluate("DMFlash.lumens()===750&&document.querySelectorAll('#dm-flash .fl-seg.lit').length===1"))
    pg.touchscreen.tap(bb[0], bb[1]); pg.wait_for_timeout(120)
    check('flashlight tap again: off, bar closed', pg.evaluate("!DMFlash.status().on&&getComputedStyle(document.querySelector('#dm-flash .fl-bar')).display==='none'"))
    check('flashlight: left stick knob untouched by the taps', pg.evaluate("surfJoyMove.x===0&&surfJoyMove.y===0&&surfLookJoy.x===0&&surfLookJoy.y===0"))
    pg.evaluate("document.getElementById('surface-overlay').style.display='none'; document.getElementById('screen-flight').classList.remove('active'); DMFlash.tick('')")
    check('flashlight hidden outside gameplay', pg.evaluate("getComputedStyle(document.getElementById('dm-flash')).display") == 'none')
    pg.set_viewport_size({'width': 2000, 'height': 924}); pg.wait_for_timeout(150)
    pg.evaluate("dmSys.clear()")
    for kind in ('mouse', 'touch'):
        pg.evaluate("""()=>{ if(!document.getElementById('menu-scene-canvas')) document.body.appendChild(Object.assign(document.createElement('canvas'),{id:'menu-scene-canvas'}));
          window.DM_MENUSCENE={_ctx:{},failed:false,resume(){},_dispT:0,skipN:1}; INTRO.on=false; _introBegin();
          INTRO.phase='play'; INTRO.flown=false; INTRO.skip=false; dmSys.load('intro','Tap to skip'); }""")
        pg.wait_for_timeout(400)
        check(kind + ': veil is the hit target', pg.evaluate("document.elementFromPoint(1000,460).id") == 'intro-veil')
        check(kind + ': Tap to skip hint', pg.evaluate("dmSys.text()") == 'Tap to skip')
        (pg.mouse.click if kind == 'mouse' else pg.touchscreen.tap)(1000, 460); pg.wait_for_timeout(300)
        check(kind + ': tap skips fly-out to wait phase', pg.evaluate("INTRO.phase==='wait'&&INTRO.skip&&INTRO.flown"))
        pg.evaluate("clearInterval(INTRO.iv);document.getElementById('intro-veil').remove();INTRO.on=false;dmSys.done('intro');dmSys.clear()")
    b.close()
sys.exit(1 if fails else 0)
