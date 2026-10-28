#!/usr/bin/env python3
"""cgroup bench: boot the game headless (WebKit), enter surface walk on a body, hold W, measure frame pace + hair/cgroup stats.
usage: cgroup-bench.py PORT LABEL [query-suffix] [body]   (shots -> /workspace/cgroup-shots/)"""
import asyncio,sys,json,os
from playwright.async_api import async_playwright
PORT=sys.argv[1]; LABEL=sys.argv[2]; Q=sys.argv[3] if len(sys.argv)>3 else ''; BODY=sys.argv[4] if len(sys.argv)>4 else 'Earth'; ENG=os.environ.get('ENG','webkit')
os.makedirs('/workspace/cgroup-shots',exist_ok=True)
PACE="""async(n)=>{const a=[];let l=performance.now();await new Promise(z=>{const f=t=>{a.push(t-l);l=t;if(a.length<n)requestAnimationFrame(f);else z()};requestAnimationFrame(f)});a.shift();const s=a.slice().sort((x,y)=>x-y);const m=a.reduce((x,y)=>x+y,0)/a.length;return {n:a.length,mean:+m.toFixed(1),med:+s[s.length>>1].toFixed(1),p95:+s[Math.floor(s.length*.95)].toFixed(1),max:+s[s.length-1].toFixed(1),fps:+(1000/m).toFixed(2)}}"""
async def main():
  async with async_playwright() as p:
    bt=getattr(p,ENG); b=await (bt.launch(executable_path='/usr/bin/google-chrome',args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']) if ENG=='chromium' else bt.launch()); ctx=await b.new_context(viewport={'width':int(os.environ.get('VW',1024)),'height':int(os.environ.get('VH',700))}); pg=await ctx.new_page()
    pg.on('pageerror',lambda e: print('PAGEERR',str(e)[:300],flush=True))
    pg.on('console',lambda m: print(m.type,m.text[:240],flush=True) if (m.type=='error' or 'cgroup' in m.text or 'hair' in m.text or 'cloth' in m.text) else None)
    await pg.goto(f'http://localhost:{PORT}/index.html?perf=1&dmtest=1{Q}'); await pg.wait_for_timeout(14000)
    for js in ["enterApp()","applyGfxScreen()","(()=>{const c=document.getElementById('jots-agree'),b=document.getElementById('jots-guest-btn');if(c&&b){c.click();b.disabled=false;b.click();}})()","startGame()"]:
      await pg.evaluate("()=>{try{"+js+"}catch(e){console.error('step',e)}}"); await pg.wait_for_timeout(5000)
    await pg.evaluate("()=>document.getElementById('jots-mode-story').click()")
    for i in range(30):
      await pg.wait_for_timeout(5000); await pg.keyboard.press('Escape')
      st=await pg.evaluate("()=>(typeof flightInited!=='undefined'&&flightInited)+' warming='+window._dmWarming+' char='+(typeof CHAR!=='undefined'&&CHAR.loaded)")
      print('t',i,st,flush=True)
      if 'warming=false' in st and 'char=true' in st: break
    r=await pg.evaluate("async(n)=>{const b=__dmTest.bodies.find(x=>x.name===n); try{ await __dmTest.enterSurface(b); }catch(e){ return 'err '+e; } return 'ok'}",BODY); print('enterSurface',r,flush=True)
    for i in range(30):
      await pg.wait_for_timeout(3000)
      st=await pg.evaluate("()=>PW.active+' '+surfaceActive+' '+atmoActive+' op='+PW.opening+' mounted='+CHAR.mounted"); print('S',st,flush=True)
      if st.startswith('true true') and 'op=false' in st: break
    await pg.wait_for_timeout(6000)
    print('IDLE',json.dumps(await pg.evaluate(PACE,int(os.environ.get('NI',90)))),flush=True)
    await pg.screenshot(path=f'/workspace/cgroup-shots/{LABEL}-surface-idle.png')
    await pg.keyboard.down('w')
    await pg.wait_for_timeout(5000)
    print('WALK',json.dumps(await pg.evaluate(PACE,int(os.environ.get('NW',150)))),flush=True)
    await pg.screenshot(path=f'/workspace/cgroup-shots/{LABEL}-surface-walk.png')
    print('HAIR',await pg.evaluate("()=>{const H=window.DART_HAIR; return H?JSON.stringify({ms:H.stats.ms,sim:H.stats.simMs,mode:H.stats.mode,il:H.stats.interleave,it:H.params.iterations,k:H.stats.intensity}):'nohair'}"),flush=True)
    print('CLOTH',await pg.evaluate("()=>{const C=window.DART_CLOTH; return C?JSON.stringify({cell:C.cell,garments:C.subs.map(x=>x.stats)}):'none'}"),flush=True)
    print('CG',await pg.evaluate("()=>window.DMCGroup?JSON.stringify(DMCGroup.stats()):'none'"),flush=True)
    await pg.keyboard.up('w')
    await b.close()
asyncio.run(main())
