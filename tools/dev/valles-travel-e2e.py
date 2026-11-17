#!/usr/bin/env python3
"""(v336) Real-game headless check for the Travel LAND confirm + the Valles Rim arrival (tools/dev/boot-game.py, SwiftShader/WebGL2).
  (a) DMArielHome.visit('mars-valles') with the galaxy map CLOSED shows #ft-dialog; GO is visible and is the element under its own centre
      (so a tap lands on it), and a real mouse click on it runs the LAND.
  (b) after GO: the Mars world opens, the facility is placed, she is set down on its deck (TERRAIN.H under her == deck height,
      inside the deck polygon) and the DMCollide 'facility' bodies exist.
  python3 tools/dev/valles-travel-e2e.py [--skip-b] [--timeout 1500]     exit 0 = pass, 1 = fail, 2 = harness/browser problem
"""
import importlib.util, json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bg', os.path.join(HERE, 'boot-game.py')); bg = importlib.util.module_from_spec(spec); spec.loader.exec_module(bg)
skip_b = '--skip-b' in sys.argv
TO = int(sys.argv[sys.argv.index('--timeout') + 1]) if '--timeout' in sys.argv else 1500
def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)
res = {'a': None, 'b': None}
try:
    g = bg.Game(query='harness=1&places=0', webgpu=False, viewport=(640, 400), save={'dm_gfx_v2': json.dumps({'chosen': True, 'aaV': 2, 'preset': 'low'})})
    g.open(); log('page open')
    g.start_flight(timeout=900); log('flight up')
except Exception as e:
    log('HARNESS/BROWSER FAILED:', repr(e)[:400]); sys.exit(2)
fails = []
# (a) the confirm, with the map closed
g.js("(()=>{ try{ closeGalaxyMap(); }catch(e){} _ah().visit('mars-valles'); })()")
time.sleep(1.5)
A_JS = """(()=>{ const d=document.getElementById('ft-dialog'), b=document.getElementById('ft-go'), r=b.getBoundingClientRect();
  const top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
  return {mapOpen:document.getElementById('galaxy-map').classList.contains('open'), dlgVisible:d.checkVisibility(), goVisible:b.checkVisibility(),
          w:r.width, h:r.height, cx:r.left+r.width/2, cy:r.top+r.height/2, topIsGo: top===b||b.contains(top), title:document.getElementById('ft-title').textContent, parent:d.parentElement.tagName+'#'+d.parentElement.id,
          stack:document.elementsFromPoint(r.left+r.width/2, r.top+r.height/2).slice(0,4).map(e=>e.tagName+'#'+e.id+'.'+(e.className&&e.className.baseVal===undefined?e.className:''))}; })()"""
a = None
for _ in range(10):                      # a sys line / transient overlay may sit over it for a moment: retry for ~10 s
    a = g.js(A_JS)
    if a['topIsGo']: break
    log('GO covered by', a['stack']); time.sleep(1)
log('a:', a)
res['a'] = a
if a['mapOpen'] or not (a['dlgVisible'] and a['goVisible'] and a['w'] > 20 and a['h'] > 10 and a['topIsGo']): fails.append('a: GO not visible/tappable')
g.page.mouse.click(a['cx'], a['cy']); log('clicked GO')
time.sleep(1)
if g.js("document.getElementById('ft-dialog').style.display") != 'none': fails.append('a: dialog did not close on GO')
if not skip_b:
    try:
        t0 = time.time()
        while time.time() - t0 < TO:
            pr = g.js("({pw:!!PW.active, opening:!!PW.opening, body:PW.body&&PW.body.name, mode:PW.mode||null, pend:!!(DMArielHome.landPending&&DMArielHome.landPending()), arrive:(window.DM_FAC||{}).arriveAt||null, fac:DMFac.status(), screen:STATE.screen, sys:_ttCurSysName()})")
            log('progress', pr)
            if pr['pw'] and pr['body'] == 'Mars' and not pr['opening']: break
            time.sleep(20)
        g.wait_for("PW.active && PW.body && PW.body.name==='Mars'", timeout=5); log('Mars world open, mode', g.js('PW.mode'))
        g.wait_for("(()=>{ const r=DMFac.sites.get('mars-valles'); return !!(r&&r.ready&&r.teleported); })()", timeout=TO); log('facility placed + teleported')
        # landing: let the sky set her down (bounded), then read where she is relative to the deck
        t0 = time.time(); last = None
        while time.time() - t0 < TO:
            last = g.js("""(()=>{ const r=DMFac.sites.get('mars-valles'), p=(PW.mode==='walk'&&surfPlayer)?surfPlayer.pos:(atmoState&&atmoState.pos); if(!p) return null;
              const dx=p.x-r.x, dz=p.z-r.z, ct=Math.cos(r.th), st=Math.sin(r.th), lx=dx*ct-dz*st, lz=dx*st+dz*ct;
              const poly=[[-24,-8],[24,-8],[30,16],[0,56],[-30,16]]; let c=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const a=poly[i],b=poly[j]; if(((a[1]>lz)!==(b[1]>lz))&&(lx<(b[0]-a[0])*(lz-a[1])/(b[1]-a[1])+a[0])) c=!c; }
              return {mode:PW.mode, lx, lz, y:p.y, deckY:r.y, groundUnder:TERRAIN.H(p.x,p.z), onDeckXZ:c, colN:r.colN|0, landing:!!(atmoState&&atmoState.landing)}; })()""")
            if last and last['mode'] == 'walk': break
            log('landing', last); time.sleep(10)
        log('b:', last)
        res['b'] = last
        if not last or not last['onDeckXZ'] or abs(last['groundUnder'] - last['deckY']) > 0.5 or last['colN'] < 6: fails.append('b: not on the facility deck')
        if last and last['mode'] != 'walk': log('note: still', last['mode'], 'when the time ran out (landing not finished)')
        try: g.shot('/tmp/valles-e2e.png'); log('shot /tmp/valles-e2e.png')
        except Exception as e: log('shot failed', e)
    except Exception as e:
        log('b FAILED:', repr(e)[:300]); fails.append('b: ' + repr(e)[:120])
errs = [l for l in g.logs if 'pageerror' in str(l[0] if isinstance(l, (list, tuple)) else l)]
log('pageerrors:', errs[-8:])
log('RESULT', 'PASS' if not fails else 'FAIL ' + '; '.join(fails)); print(json.dumps(res))
try: g.close()
except Exception: pass
sys.exit(0 if not fails else 1)
