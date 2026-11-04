#!/usr/bin/env python3
"""DOM test (headless Chromium, 2000x924): bottom-right system strip + tap-to-skip of the launch fly-out.
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
