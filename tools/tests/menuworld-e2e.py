#!/usr/bin/env python3
"""Real-game integration check (headless SwiftShader, WebGL2 fallback): main menu -> character select (card world) -> studio (studio world, orbit drag, double tap)
-> leave (everything disposed).  python3 tools/tests/menuworld-e2e.py <outdir> [query]   (e.g. 'menuscene=low' or 'menuscene=off')"""
import importlib.util, json, sys, time
spec = importlib.util.spec_from_file_location('bg', 'tools/dev/boot-game.py'); bg = importlib.util.module_from_spec(spec); spec.loader.exec_module(bg)
out = sys.argv[1]; q = 'harness=1' + ('&' + sys.argv[2] if len(sys.argv) > 2 else '')
g = bg.Game(query=q, webgpu=False, verbose=False, viewport=(900, 520)); g.open()
def P(*a): print(*a, flush=True)
g.wait_for("typeof goScreen==='function' && window.DMCharSelect && DMCharSelect.ready && window.DMMenuWorld", timeout=240)
P('booted', g.js("DMMenuWorld.tier().name"))
g.js("goScreen('character')"); time.sleep(1)
g.wait_for("DMCharSelect._CW && (DMCharSelect._CW.w || '"+('off' in q and 'x' or '')+"'==='x' || DMCharSelect._CW.leased===false)", timeout=120)
t0 = time.time(); g.wait_for("!DMCharSelect._CW.w || DMCharSelect._CW.w.frames>=2", timeout=240); P('card frames after', round(time.time()-t0,1), g.js("({cw:!!DMCharSelect._CW.w, frames:DMCharSelect._CW.w&&DMCharSelect._CW.w.frames, cls:document.getElementById('screen-character').className, st:DMCharSelect.status(), live:DMMenuWorld.stats.live})"))
try: g.wait_for("DMChars.list().filter(d=>d.ready).every(d=>DMCharSelect.status().thumbs.includes(d.id)) && !DMCharSelect.status().loop && DMCharSelect._R.leases===1", timeout=300)
except Exception as e: P('thumbs not settled', e)
time.sleep(2); g.shot(out + '/e2e_cards.png'); P('canvas visibility', g.js("DMCharSelect._R.canvas&&DMCharSelect._R.canvas.style.visibility"), 'bg size', g.js("[document.getElementById('cs-bg').clientWidth, DMCharSelect._R.canvas&&DMCharSelect._R.canvas.width]"))
g.js("DMCharSelect.openStudio(DMChars.list()[0].id)")
g.wait_for("DMCharSelect._studio.M && DMCharSelect._studio.raf", timeout=420); time.sleep(4)
P('studio', g.js("({world:!!DMCharSelect._studio.X.world, cls:document.getElementById('cs-studio').className, st:DMCharSelect.status(), live:DMMenuWorld.stats.live})"))
g.shot(out + '/e2e_studio.png')
# orbit by synthetic pointer events: drag up (camera over her head), then a double tap resets
g.js("""(()=>{const st=document.getElementById('cs-stage'),r=st.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height*0.7,ev=(t,yy)=>st.dispatchEvent(new PointerEvent(t,{pointerId:1,clientX:x,clientY:yy,button:0,bubbles:true}));
 ev('pointerdown',y); for(let i=1;i<=12;i++)ev('pointermove',y-i*22); ev('pointerup',y-264); window._p0=DMCharSelect._studio.pitch;})()""")
time.sleep(3); P('pitch after drag up', g.js("DMCharSelect._studio.pitch"), 'cam y', g.js("DMCharSelect._studio.cam.position.y"))
g.shot(out + '/e2e_studio_top.png')
g.js("""(()=>{const st=document.getElementById('cs-stage'),r=st.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,ev=(t)=>st.dispatchEvent(new PointerEvent(t,{pointerId:2,clientX:x,clientY:y,button:0,bubbles:true}));
 ev('pointerdown');ev('pointerup');ev('pointerdown');ev('pointerup');})()""")
time.sleep(4); P('after double tap pitch', g.js("DMCharSelect._studio.pitch"), 'home', g.js("DMCharSelect._studio.home"))
g.js("DMCharSelect.closeStudio()"); time.sleep(2)
P('studio closed', g.js("({st:DMCharSelect.status(), live:DMMenuWorld.stats.live, cw:!!DMCharSelect._CW.w})"))
g.shot(out + '/e2e_cards2.png')
g.js("goScreen('menu')")
for _ in range(40):
    time.sleep(1)
    if g.js("DMCharSelect._R.leases===0 && !DMCharSelect._R.r"): break
P('left', g.js("({st:DMCharSelect.status(), live:DMMenuWorld.stats.live, cw:!!DMCharSelect._CW.w, cs:!!document.getElementById('cs-bg').firstChild})"))
P('errors', [l[2][:200] for l in g.logs if l[1] in ('pageerror',) or ('menuworld' in l[2] or 'charselect' in l[2]) and 'fail' in l[2].lower()][:8])
g.close()
