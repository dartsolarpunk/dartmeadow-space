#!/usr/bin/env python3
"""DOM test (headless Chromium): the glasses flashlight button (ui/dm-flash.js) exists and is VISIBLE + tappable in every game HUD:
on foot / landed (walk), atmosphere flight (fly), space, in landscape (844x390) and portrait (390x844); it never overlaps the on-foot buttons
(CLIMB / JUMP / RUN / sticks), it is shown even when its stick cannot be measured (fixed fallback slot), and it is hidden on the menu.
Usage: python3 -m http.server 8123 (repo root) ; python3 tools/tests/flash-hud.py [base_url]   (three.js never loads offline: the HUD is driven directly)"""
import sys
from playwright.sync_api import sync_playwright
base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8123/index.html'
fails = []
def check(name, ok, info=''):
    print(('ok   ' if ok else 'FAIL ') + name, info)
    if not ok: fails.append(name)
SETUP = """(m)=>{document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById('screen-flight').classList.add('active');
document.getElementById('app').style.display='block';document.body.classList.add('pw-hud');const l=document.getElementById('loading-screen');if(l)l.style.display='none';
document.getElementById('surface-overlay').style.display=m==='walk'?'block':'none';document.getElementById('atmo-overlay').style.display=m==='fly'?'block':'none';
const w=document.getElementById('dm-flash');w.setAttribute('data-m','');for(let i=0;i<80;i++)DMFlash.tick(m);}"""
RECT = """()=>{const w=document.getElementById('dm-flash'),b=w.querySelector('.fl-btn'),r=b.getBoundingClientRect(),cs=getComputedStyle(w),bs=getComputedStyle(b);
const e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
return {m:w.dataset.m,disp:cs.display,vis:bs.visibility,l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,hit:!!(e&&e.closest('#dm-flash')),W:innerWidth,H:innerHeight}}"""
OVER = """(ids)=>{const b=document.querySelector('#dm-flash .fl-btn').getBoundingClientRect(),o=[];for(const id of ids){const e=document.getElementById(id);if(!e)continue;const q=e.getBoundingClientRect();
if(q.width>1&&q.left<b.right&&q.right>b.left&&q.top<b.bottom&&q.bottom>b.top)o.push(id)}return o}"""
with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    for (W, H, tag) in [(844, 390, 'landscape 844x390'), (390, 844, 'portrait 390x844')]:
        pg = br.new_context(viewport={'width': W, 'height': H}, has_touch=True).new_page()
        pg.route('**/*', lambda r: r.continue_() if 'localhost' in r.request.url else r.abort())
        pg.goto(base, wait_until='commit')
        pg.wait_for_function("window.DMFlash&&document.getElementById('surf-move-zone')", timeout=30000)
        for m in ['walk', 'fly', 'space']:
            pg.evaluate(SETUP, m); r = pg.evaluate(RECT)
            check(f'{tag} {m}: button shown (data-m, display, size)', r['m'] == m and r['disp'] == 'block' and r['w'] >= 30 and r['vis'] == 'visible', r)
            check(f'{tag} {m}: fully on screen', r['l'] >= 0 and r['t'] >= 0 and r['r'] <= W and r['b'] <= H, r)
            if m == 'walk':
                check(f'{tag} walk: tappable (nothing above it)', r['hit'], r)
                ov = pg.evaluate(OVER, ['surf-move-zone', 'surf-look-zone', 'surf-jump-btn', 'surf-run-btn', 'surf-climb-btn', 'surf-view-btn'])
                check(f'{tag} walk: clear of the stick / CLIMB / JUMP / RUN / 1ST PERSON', ov == [], ov)
                pg.screenshot(path=f'/tmp/flash-hud-walk-{W}x{H}.png')
        # toggle by tap, in walk mode
        pg.evaluate(SETUP, 'walk')
        pg.evaluate("document.querySelector('#dm-flash .fl-btn').click()")
        check(f'{tag} tap toggles on / off', pg.evaluate("DMFlash.S.on===true") and pg.evaluate("document.getElementById('dm-flash').classList.contains('on')"))
        pg.evaluate("document.querySelector('#dm-flash .fl-btn').click()"); check(f'{tag} second tap = off', pg.evaluate("DMFlash.S.on===false"))
        # its stick cannot be measured (hidden) -> still shown in a fixed slot
        pg.evaluate("document.getElementById('surf-move-zone').style.display='none';document.getElementById('surf-look-zone').style.display='none'")
        pg.evaluate(SETUP.replace("document.getElementById('app')", "document.getElementById('app')"), 'walk')
        pg.evaluate("for(let i=0;i<200;i++)DMFlash.tick('walk')"); r = pg.evaluate(RECT)
        check(f'{tag} no stick laid out: still visible (fixed fallback slot)', r['m'] == 'walk' and r['disp'] == 'block' and r['l'] >= 0 and r['r'] <= W and r['b'] <= H, r)
        # menu: hidden
        pg.evaluate("document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById('screen-menu').classList.add('active')")
        check(f'{tag} hidden on the menu', pg.evaluate("getComputedStyle(document.getElementById('dm-flash')).display")=='none')
        pg.context.close()
    br.close()
print('flash-hud: FAILED %d' % len(fails) if fails else 'flash-hud: all checks passed'); sys.exit(1 if fails else 0)
