#!/usr/bin/env python3
"""ui3d mesh HUD retry check (v204): forced foreignObject failures + a 404 <img>.
Asserts a failing panel does NOT re-raster every frame (backoff), 'img not ready' gives up after ~4 tries and the
panel paints without the image, and foFails resets after a good paint.
usage: python3 tools/tests/ui3d-backoff.py <http-base> [webkit|chromium]   (serve the repo root first)"""
import asyncio,sys,json
from playwright.async_api import async_playwright
BASE=sys.argv[1].rstrip('/'); ENG=sys.argv[2] if len(sys.argv)>2 else 'webkit'
INIT="""(()=>{ window.__rast=[]; window.__foFail=0; const d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
 Object.defineProperty(HTMLImageElement.prototype,'src',{set(v){ if(typeof v==='string'&&v.startsWith('data:image/svg+xml')){ console.log('[UI3D-T] rast '+Math.round(performance.now())); window.__rast.push(1);
   if(window.__foFail>0){ window.__foFail--; v='data:image/png;base64,AAAA'; } } d.set.call(this,v); },get(){ return d.get.call(this); },configurable:true}); })()"""
async def main():
  fails=[]
  def chk(c,m):
    print(('PASS ' if c else 'FAIL ')+m,flush=True)
    if not c: fails.append(m)
  async with async_playwright() as p:
    if ENG=='webkit': b=await p.webkit.launch(); dev=p.devices['iPhone 13']
    else: b=await p.chromium.launch(args=['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-features=Vulkan','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']); dev={'viewport':{'width':1280,'height':800},'device_scale_factor':1.5,'is_mobile':True,'has_touch':True,'user_agent':'Mozilla/5.0 (Linux; Android 13; SM-X900) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'}
    ctx=await b.new_context(**dev); await ctx.add_init_script(INIT); pg=await ctx.new_page(); logs=[]
    pg.on('console',lambda m: logs.append(m.text) if 'UI3D' in m.text else None)
    await pg.add_init_script("window.__foFail=5")   # the first 5 foreignObject rasters fail (< 6 per panel would not latch box2d only if spread over panels)
    await pg.goto(BASE+'/index.html?ui3dgl=1&dmtest=1')
    for _ in range(40):
      await pg.wait_for_timeout(500)
      s=await pg.evaluate("()=>window.DMUI3DMesh?DMUI3DMesh._stats():null")
      if s and s['n'] and s['ready_n']==s['n']: break
    r=[int(l.split()[-1]) for l in logs if l.startswith('[UI3D-T] rast')]; t0=r[0] if r else 0
    per_s={}
    for t in r: per_s[(t-t0)//1000]=per_s.get((t-t0)//1000,0)+1
    print('raster attempt times:',r,flush=True)
    chk(len(r)>0 and max(per_s.values())<=40,'forced FO failures: raster attempts/second stay bounded (backoff), max=%s'%(max(per_s.values()) if per_s else None))
    chk(any('retry in' in l for l in logs),'failed rasters log a growing retry delay')
    rdy=await pg.evaluate("()=>{const s=DMUI3DMesh._stats();return [s.painter,s.ready_n,s.n]}")
    print('painter/ready/total',rdy,flush=True)
    chk(rdy[0]=='foreignObject','painter stays foreignObject after transient failures (foFails not latched)')
    chk(rdy[1]>0 and rdy[1]==rdy[2],'every panel eventually paints (%s/%s)'%(rdy[1],rdy[2]))
    # 404 image: into every real-id panel (<img> panels get a 404 src, others get a nested 404 <img>)
    mark=len(logs)
    ids=await pg.evaluate("""()=>{const o=[];DMUI3DMesh._stats().panels.forEach(x=>{const el=document.getElementById(x.id); if(!el) return; o.push(x.id);
      if(el.tagName==='IMG'){ el.src='/definitely-404.png'; el.style.marginLeft='1px'; } else { const im=new Image(); im.src='/definitely-404-b.png'; im.style.cssText='width:48px;height:24px;display:block'; el.appendChild(im); } }); window.__t404=o; return o}""")
    print('404 injected into',ids,flush=True)
    for _ in range(80):
      await pg.wait_for_timeout(500)
      if await pg.evaluate("()=>DMUI3DMesh._stats().panels.filter(x=>window.__t404.includes(x.id)).every(x=>x.ready)") and len([l for l in logs[mark:] if 'img not ready' in l])>=4: break
    await pg.wait_for_timeout(1500)
    r=[int(l.split()[-1]) for l in logs[mark:] if l.startswith('[UI3D-T] rast')]
    nimg=len([l for l in logs[mark:] if 'img not ready' in l])
    print('after 404 img: raster attempts',len(r),'img-not-ready warnings',nimg,flush=True)
    print('\n'.join(logs[-25:]),flush=True)
    chk(nimg>0,'404 images were retried at least once (%d)'%nimg)
    chk(nimg<=4*max(1,len(ids))+2,'img not ready retries are capped (%d)'%nimg)
    chk(len(r)<=12*max(1,len(ids)),'no per-frame re-raster with a 404 image (%d rasters until settled)'%len(r))
    ok=await pg.evaluate("()=>{return DMUI3DMesh._stats().panels.filter(x=>window.__t404.includes(x.id)).every(x=>x.ready)}")
    chk(ok,'panel with the 404 image still paints (without it)')
    await pg.wait_for_timeout(3000); r2=len([l for l in logs[mark:] if l.startswith('[UI3D-T] rast')])
    chk(r2-len(r)<=3,'settled: no further rasters once painted (%d extra in 3 s)'%(r2-len(r)))
    await b.close()
  print('RESULT','FAIL' if fails else 'PASS'); sys.exit(1 if fails else 0)
asyncio.run(main())
