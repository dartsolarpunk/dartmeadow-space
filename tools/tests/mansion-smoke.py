#!/usr/bin/env python3
"""Mansion arrival smoke: menu -> guest start -> flight -> HOME quick travel to Ariel's mansion deck.
Samples JS heap, renderer.info (geometries/textures/programs/draw calls), process RSS and page errors every second and
prints a JSON report (and a compact table). Exit 0 = reached the deck with zero page errors / crashes.

  python3 tools/tests/mansion-smoke.py <repo-dir> [--engine chromium|webkit] [--device desktop|iphone] [--query 'a=b'] [--out report.json]
  (WebKit needs: export GST_PLUGIN_PATH=/workspace/jots-tools/wklibs/gst GST_PLUGIN_SYSTEM_PATH_1_0=/workspace/jots-tools/wklibs/gst)
No GPU on the box: the numbers are for A/B (before/after) comparison on the same engine, not absolute phone numbers.
"""
import argparse, asyncio, json, os, re, socket, subprocess, sys, time
from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument('dir'); ap.add_argument('--engine', default='chromium'); ap.add_argument('--device', default='desktop')
ap.add_argument('--query', default=''); ap.add_argument('--out', default=''); ap.add_argument('--arrive-s', type=int, default=420)
ap.add_argument('--soak-s', type=int, default=30); ap.add_argument('--target', default='home', help="home = HOME quick travel; control = same planet, far from the mansion")
a = ap.parse_args()
CHROME = '/usr/bin/google-chrome'
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info']
SAMPLER = r"""
(function(){ if(window.__ms) return; const ms=window.__ms={s:[],errs:[],t0:performance.now()};
 window.addEventListener('error',e=>ms.errs.push(String(e.message||e).slice(0,240)));
 window.addEventListener('unhandledrejection',e=>ms.errs.push('rej '+String(e.reason&&e.reason.message||e.reason).slice(0,240)));
 setInterval(()=>{ const g=(f,d)=>{try{const v=f();return v===undefined?d:v}catch(e){return d}};
  const pm=performance.memory, r=g(()=>flightRenderer,null), i=r&&r.info;
  ms.s.push({t:+((performance.now()-ms.t0)/1000).toFixed(1), heap:pm?+(pm.usedJSHeapSize/1048576).toFixed(1):null,
   geo:i&&i.memory?i.memory.geometries:null, tex:i&&i.memory?i.memory.textures:null, progs:i&&i.programs?i.programs.length:null,
   calls:i&&i.render?i.render.calls:null, tris:i&&i.render?i.render.triangles:null,
   pw:g(()=>!!PW.active,false), atmo:g(()=>!!atmoActive,false), surf:g(()=>!!surfaceActive,false), body:g(()=>PW.body&&PW.body.name,''),
   man:g(()=>{const s=DMFac.status().find(x=>x.id==='home-mansion');return s?(s.ready?'ready':s.searching?'search':'wait'):'-'},'-'),
   mob:g(()=>!!(window.GFX&&GFX.isMobile),false)}); },1000);
})();"""

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
def rss(engine):
    pat = r'chrome.*(--type=renderer|--type=gpu-process)' if engine == 'chromium' else r'WPEWebProcess|WebKitWebProces|MiniBrowser|pw_run'
    o = subprocess.run("ps -eo rss,args | grep -E '%s' | grep -v grep | awk '{print $1}'" % pat, shell=True, capture_output=True, text=True).stdout.split()
    v = [int(x) for x in o if x.isdigit()]; return round(sum(v) / 1024), round(max(v) / 1024) if v else 0

async def main():
    port = free_port()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=a.dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    rep = {'engine': a.engine, 'device': a.device, 'target': a.target, 'stages': [], 'crash': False, 'console': [], 'rss': []}
    T0 = time.time()
    async with async_playwright() as p:
        bt = getattr(p, a.engine)
        br = await (bt.launch(executable_path=CHROME, args=ARGS, headless=True) if a.engine == 'chromium' else bt.launch(headless=True))
        kw = {'service_workers': 'block'}
        if a.device == 'iphone':
            d = dict(p.devices['iPhone 15 landscape']); d.pop('default_browser_type', None); kw.update(d)
        else: kw['viewport'] = {'width': 960, 'height': 540}
        ctx = await br.new_context(**kw); await ctx.add_init_script(SAMPLER)
        # three r185 is served from a local copy when the box can't reach the CDN
        def route(r):
            u = r.request.url; f = None
            m = re.search(r'three@0\.185\.0/build/([\w.]+\.js)$', u)
            if m: f = '/workspace/three185/' + m.group(1)
            m = re.search(r'three@0\.185\.0/examples/jsm/(.+\.js)$', u)
            if m: f = '/workspace/vend/package/examples/jsm/' + m.group(1)
            if f and os.path.exists(f): asyncio.ensure_future(r.fulfill(path=f, content_type='text/javascript', headers={'access-control-allow-origin': '*'}))
            else: asyncio.ensure_future(r.continue_())
        await ctx.route('**/cdn.jsdelivr.net/npm/three@0.185.0/**', route)
        pg = await ctx.new_page()
        pg.on('console', lambda m: rep['console'].append(m.type + ': ' + m.text[:300]) if m.type in ('error',) or 'ariel-home' in m.text or 'facilities' in m.text else None)
        pg.on('pageerror', lambda e: rep['console'].append('pageerror: ' + str(e)[:300]))
        pg.on('crash', lambda *_: rep.update(crash=True))
        async def ev(js, d=None, to=60):
            try: return await asyncio.wait_for(pg.evaluate(js), to)
            except Exception as e: return d
        async def wait(js, to, every=1.0):
            t = time.time()
            while time.time() - t < to:
                if rep['crash']: return False
                if await ev(js, False, 30): return True
                await asyncio.sleep(every)
            return False
        async def rl():
            while True:
                rep['rss'].append([round(time.time() - T0, 1)] + list(await asyncio.get_event_loop().run_in_executor(None, rss, a.engine))); await asyncio.sleep(1)
        rt = asyncio.create_task(rl())
        url = f'http://127.0.0.1:{port}/index.html?perf=1&gl=1&dmtest=1' + ('&' + a.query if a.query else '')
        await pg.goto(url, wait_until='domcontentloaded', timeout=120000)
        def st(n, ok):
            rep['stages'].append({'stage': n, 'ok': bool(ok), 't': round(time.time() - T0, 1)})
            print('STAGE', n, 'ok' if ok else 'FAIL', round(time.time() - T0, 1), 's', flush=True)
        st('load', await wait("()=>!!document.getElementById('ls-enter')&&typeof THREE!=='undefined'", 90))
        await asyncio.sleep(12)   # the loading screen needs ~12 s before enterApp() takes (same wait as wk-smoke)
        await ev("()=>{try{enterApp()}catch(e){console.error(e)}}")
        await asyncio.sleep(3)
        # first launch shows the graphics-setup screen; apply it, then make sure the real menu state is set (STATE.screen==='menu')
        await ev("()=>{try{const g=document.getElementById('gfx-screen');if(g&&getComputedStyle(g).display!=='none'&&typeof applyGfxScreen==='function')applyGfxScreen()}catch(e){}}")
        await asyncio.sleep(2)
        await ev("()=>{try{if(STATE.screen!=='menu'){document.getElementById('app').classList.add('vis');goScreen('menu')}}catch(e){console.error(e)}}")
        await asyncio.sleep(2)
        ok = await ev("()=>STATE.screen==='menu'", False)
        st('menu', ok)
        await ev("()=>startGame()"); await asyncio.sleep(2.5)
        await ev("()=>{const b=document.getElementById('jots-mode-story');if(b&&b.offsetParent!==null)b.click()}")
        st('flight', await wait("()=>typeof flightInited!=='undefined'&&flightInited&&STATE.screen==='flight'", 300, 2))
        await wait("()=>window._dmWarming===false||window._dmWarming===undefined", 120, 2)
        await wait("()=>!window._jotsIntro||!window._jotsIntro.on", 90, 1)
        await asyncio.sleep(5)
        rep['t_go'] = round(time.time() - T0, 1)
        if a.target == 'home':
            await ev("()=>{window.DM_FAC=window.DM_FAC||{};DMArielHome.homeNow()}")
            ok = await wait("()=>{const s=(typeof DMFac!=='undefined')&&DMFac.status().find(x=>x.id==='home-mansion');return !!(s&&s.ready)&&typeof atmoActive!=='undefined'&&atmoActive&&PW.active&&!PW.opening&&!(window.DM_FAC&&DM_FAC.arriveAt)}", a.arrive_s, 2)
            st('arrive-mansion', ok)
        else:   # control: Solenne, far from the mansion site (no landmark)
            await ev("()=>{const a=DMArielHome;GALAXY_DB.current='lumenreach';fastTravelToSystem(a.system,'lumenreach')}"); await asyncio.sleep(8)
            await wait("()=>typeof celestialBodies!=='undefined'&&celestialBodies.some(b=>b.name==='Solenne'&&b.mesh)", 120, 2)
            await ev("()=>{const b=celestialBodies.find(x=>x.name==='Solenne');enterAtmosphericFlight(b,{lat:-60,lon:-100})}")
            st('arrive-control', await wait("()=>typeof atmoActive!=='undefined'&&atmoActive&&PW.active&&!PW.opening", a.arrive_s, 2))
        await asyncio.sleep(a.soak_s)
        rep['samples'] = await ev("()=>window.__ms&&window.__ms.s", []) or []; rep['errs'] = await ev("()=>window.__ms&&window.__ms.errs", []) or []
        rt.cancel()
        try: await br.close()
        except Exception: pass
    srv.terminate()
    S = rep['samples']
    def mx(k): v = [x[k] for x in S if x.get(k) is not None]; return max(v) if v else None
    rep['summary'] = {'heap_max_mb': mx('heap'), 'geo_max': mx('geo'), 'tex_max': mx('tex'), 'progs_max': mx('progs'), 'rss_peak_total_mb': max([x[1] for x in rep['rss']] or [0]), 'rss_peak_proc_mb': max([x[2] for x in rep['rss']] or [0]),
                      'errors': len(rep['errs']) + sum(1 for c in rep['console'] if c.startswith(('error', 'pageerror'))), 'crash': rep['crash']}
    print('t     heap   geo  tex progs calls    tris  man    pw atmo surf body')
    for x in S[::max(1, len(S) // 40)]: print('%-6s%-7s%-5s%-5s%-6s%-7s%-8s%-7s%-3d%-5d%-5d%s' % (x['t'], x['heap'], x['geo'], x['tex'], x['progs'], x['calls'], x['tris'], x['man'], x['pw'], x['atmo'], x['surf'], x['body']))
    print('STAGES', json.dumps(rep['stages'])); print('SUMMARY', json.dumps(rep['summary']))
    for c in rep['console'][:20]: print('CONSOLE', c)
    for e in rep['errs'][:10]: print('PAGEERR', e)
    if a.out: json.dump(rep, open(a.out, 'w'))
    sys.exit(0 if rep['stages'] and all(s['ok'] for s in rep['stages']) and not rep['crash'] and rep['summary']['errors'] == 0 else 1)
asyncio.run(main())
