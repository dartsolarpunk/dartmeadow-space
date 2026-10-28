#!/usr/bin/env python3
"""cgroup-intro.py PORT LABEL — boot the game in Chromium (swiftshader), start story mode and grab frames of the loading-screen
intro (stand up -> walk -> mount -> ride stance) every ~0.5 s of INTRO time -> /workspace/cgroup-shots/intro-LABEL/"""
import asyncio,sys,json,os
from playwright.async_api import async_playwright
PORT,LABEL=sys.argv[1],sys.argv[2]; Q=sys.argv[3] if len(sys.argv)>3 else ''; OUT='/workspace/cgroup-shots/intro-'+LABEL; os.makedirs(OUT,exist_ok=True)
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']); ctx=await b.new_context(viewport={'width':640,'height':400}); pg=await ctx.new_page()
    pg.on('pageerror',lambda e: print('PAGEERR',str(e)[:300],flush=True))
    pg.on('console',lambda m: print(m.type,m.text[:200],flush=True) if (m.type=='error' or 'intro' in m.text or 'cgroup' in m.text) else None)
    await pg.goto(f'http://localhost:{PORT}/index.html?dmtest=1{Q}'); await pg.wait_for_timeout(14000)
    for js in ["enterApp()","applyGfxScreen()","(()=>{const c=document.getElementById('jots-agree'),b=document.getElementById('jots-guest-btn');if(c&&b){c.click();b.disabled=false;b.click();}})()","startGame()"]:
      await pg.evaluate("()=>{try{"+js+"}catch(e){console.error('step',e)}}"); await pg.wait_for_timeout(4000)
    await pg.evaluate("()=>document.getElementById('jots-mode-story').click()")
    nxt=0.0; n=0; seen=False
    for i in range(1500):
      await pg.wait_for_timeout(200)
      st=json.loads(await pg.evaluate("()=>{const c=window.DM_MENUSCENE&&DM_MENUSCENE._ctx; return JSON.stringify({ph:typeof INTRO!=='undefined'?INTRO.phase:null,t:c&&c.intro?+c.intro.t.toFixed(2):null})}"))
      if i%25==0: print(i,st,flush=True)
      if st['ph']=='play': seen=True
      if st['ph']=='play' and st['t'] is not None and st['t']>=nxt:
        await pg.screenshot(path=f'{OUT}/t{n:02d}_{st["t"]:.1f}.png'); n+=1; nxt=st['t']+0.5
      if seen and st['ph'] in ('out',None): break
    print('frames',n,flush=True); await b.close()
asyncio.run(main())
