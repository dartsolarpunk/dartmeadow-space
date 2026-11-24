#!/usr/bin/env python3
"""menu-duo-shots.py PORT LABEL [QUERY] - (t1644u) boot the game in Chromium (swiftshader), wait until the menu's duo launch is ready (both pilots on
the rock, both clip sets loaded), press Story and grab one frame per step of INTRO time (the intro clock is advanced to each step, so swiftshader's slow
frames do not matter): boards fly in, heads follow, rise, walk round the rock, step on, stance, departure, warp, cargo bay, hand-off to the loader.
Frames -> /workspace/duo-shots/LABEL/.  Serve the repo first: python3 -m http.server PORT.  QUERY e.g. '&intro=solo' for the single-pilot A/B."""
import asyncio,sys,json,os
from playwright.async_api import async_playwright
PORT,LABEL=sys.argv[1],sys.argv[2]; Q=sys.argv[3] if len(sys.argv)>3 else ''; OUT='/workspace/duo-shots/'+LABEL; os.makedirs(OUT,exist_ok=True)
TS=[0.4,1.2,2.0,2.8,3.6,4.4,5.2,6.0,7.0,8.0,9.0,10.0,11.0,12.0,13.0,14.0,15.0,16.0,17.0,18.0,19.0,20.0,21.0,22.0,23.0,24.0,25.0,26.0]
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']); ctx=await b.new_context(viewport={'width':800,'height':500}); pg=await ctx.new_page()
    pg.on('pageerror',lambda e: print('PAGEERR',str(e)[:300],flush=True))
    pg.on('console',lambda m: print(m.type,m.text[:240],flush=True) if (m.type=='error' or 'menuscene' in m.text or '[intro]' in m.text) else None)
    await pg.goto(f'http://localhost:{PORT}/index.html?dmtest=1{Q}'); await pg.wait_for_timeout(16000)
    for js in ["enterApp()","applyGfxScreen()","(()=>{const c=document.getElementById('jots-agree'),b=document.getElementById('jots-guest-btn');if(c&&b){c.click();b.disabled=false;b.click();}})()"]:
      await pg.evaluate("()=>{try{"+js+"}catch(e){console.error('step',e)}}"); await pg.wait_for_timeout(5000)
    for i in range(60):
      r=await pg.evaluate("()=>{const c=window.DM_MENUSCENE&&DM_MENUSCENE._ctx;return c&&c.duoReady?c.duoReady():null}")
      if r: break
      await pg.wait_for_timeout(1000)
    print('duoReady',r,flush=True)
    await pg.screenshot(path=f'{OUT}/menu.png')
    await pg.evaluate("()=>{try{startGame()}catch(e){console.error(e)}}"); await pg.wait_for_timeout(3000)
    await pg.evaluate("()=>document.getElementById('jots-mode-story').click()")
    for i in range(300):
      st=json.loads(await pg.evaluate("()=>{const c=window.DM_MENUSCENE&&DM_MENUSCENE._ctx;return JSON.stringify({ph:typeof INTRO!=='undefined'?INTRO.phase:null,t:c&&c.intro?c.intro.t:null,duo:!!(c&&c.duo&&c.duo())})}"))
      if st['duo'] and st['t'] and st['t']>0: break
      await pg.wait_for_timeout(500)
    print('start',st,flush=True)
    for T in TS:
      st=json.loads(await pg.evaluate("(T)=>{const c=DM_MENUSCENE._ctx;const D=c.duo&&c.duo();if(!D)return JSON.stringify({gone:true,ph:INTRO.phase});if(c.intro.t<T)c.intro.t=T-0.06;return JSON.stringify({t:c.intro.t,bay:D.inBay,tDep:D.tDep,tBay:D.tBay,tFly:D.tFly,ph:INTRO.phase})}",T))
      if st.get('gone'): print('gone',st,flush=True); break
      await pg.wait_for_timeout(2500)
      await pg.screenshot(path=f'{OUT}/t{T:04.1f}.png'); print(T,st,flush=True)
    await b.close()
asyncio.run(main())
