#!/usr/bin/env python3
"""Headless harness: boots the REAL DART Meadow game in Chromium (SwiftShader).
See docs/dev-harness.md.  Usage:  python3 tools/dev/boot-game.py [--eval JS] [--shot out.png] ..."""
import argparse, json, os, subprocess, sys, threading, time, http.server, socketserver, functools, mimetypes
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
NODE = Path(os.environ.get('DM_HARNESS_NODE', Path.home() / '.cache' / 'dm-harness'))
THREE_VER = '0.185.0'
CDN_RE = 'https://cdn.jsdelivr.net/npm/three@' + THREE_VER + '/'

def find_chrome():
    for c in sorted(Path('/opt/pw-browsers').glob('chromium-*/chrome-linux64/chrome')) + [Path('/usr/bin/google-chrome')]:
        if c.exists(): return str(c)
    raise RuntimeError('no full chrome binary found for --webgpu')

def ensure_three():
    p = NODE / 'node_modules' / 'three' / 'build' / 'three.webgpu.js'
    if not p.exists():
        NODE.mkdir(parents=True, exist_ok=True)
        (NODE / 'package.json').write_text('{"name":"dm-harness","private":true}')
        subprocess.check_call(['npm', 'install', 'three@' + THREE_VER, '--no-audit', '--no-fund'], cwd=NODE)
    return NODE / 'node_modules' / 'three'

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache'); super().end_headers()
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.glb': 'model/gltf-binary', '.js': 'text/javascript', '.mjs': 'text/javascript'}

def serve(port=0):
    h = functools.partial(QuietHandler, directory=str(ROOT))
    class S(socketserver.ThreadingTCPServer):
        allow_reuse_address = True; daemon_threads = True
    s = S(('127.0.0.1', port), h)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, s.server_address[1]

class Game:
    """Boots the game. g.page is a Playwright page; g.logs collects console/page errors; g.net the failed requests."""
    def __init__(self, query='debug=1', save=None, viewport=(480, 300), headless=True, webgpu=False, verbose=False, block_external=True, lite=True):
        self.logs = []; self.net = []; self.verbose = verbose
        self.three = ensure_three()
        self.srv, self.port = serve()
        self.pw = sync_playwright().start()
        args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--no-sandbox', '--autoplay-policy=no-user-gesture-required']
        kw = {}
        if webgpu:   # REAL WebGPU (WGSL) on SwiftShader: needs the full chrome binary in --headless=new (the old headless shell has no navigator.gpu)
            args += ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-webgpu-adapter=swiftshader']
            kw['executable_path'] = find_chrome()
        self.browser = self.pw.chromium.launch(headless=headless, args=args, **kw)
        self.ctx = self.browser.new_context(viewport={'width': viewport[0], 'height': viewport[1]}, service_workers='block')
        if save:   # dict of localStorage key -> string, set before any page script runs
            self.ctx.add_init_script('(()=>{try{const s=%s;for(const k in s)localStorage.setItem(k,s[k]);}catch(e){}})()' % json.dumps(save))
        if lite:   # stub the menu scene (Ariel + hair + shadows): it eats all the CPU under SwiftShader and is irrelevant to flight tests
            self.ctx.add_init_script("window.DM_MENUSCENE={ready:false,failed:true,started:true,paused:true,disposed:true,start(){},pause(){},resume(){},menuOpen(){},dispose(){}};")
        self.ctx.route('**/*', self._route)
        self.page = self.ctx.new_page()
        self.page.on('console', lambda m: self._log('console.' + m.type, m.text))
        self.page.on('pageerror', lambda e: self._log('pageerror', str(e)))
        self.page.on('requestfailed', lambda r: self.net.append(('FAILED', r.url, r.failure)))
        self.page.on('response', lambda r: self.net.append((r.status, r.url, '')) if r.status >= 400 else None)
        self.block_external = block_external
        self.url = 'http://127.0.0.1:%d/index.html?%s' % (self.port, query)

    def _log(self, kind, text):
        self.logs.append((time.time(), kind, text))
        if self.verbose: print('[%s] %s' % (kind, text[:300]), flush=True)

    def _route(self, route):
        url = route.request.url
        if url.startswith('http://127.0.0.1'):
            return route.continue_()
        if url.startswith(CDN_RE):
            f = self.three / url[len(CDN_RE):].split('?')[0]
            if '/examples/jsm/' in url or '/build/' in url:
                f = self.three / url[len(CDN_RE):].split('?')[0]
            if f.exists():
                return route.fulfill(path=str(f), content_type='text/javascript', headers={'access-control-allow-origin': '*'})
            self.net.append(('NOT-IN-NPM', url, ''))
            return route.fulfill(status=404, body='')
        # every other external host (fonts, geojson, analytics): the sandbox has no internet; answer fast & empty
        if self.block_external:
            self.net.append(('EXT-BLOCKED', url, ''))
            return route.fulfill(status=404, body='', headers={'access-control-allow-origin': '*'})
        return route.continue_()

    def open(self):
        self.page.goto(self.url, wait_until='domcontentloaded'); return self
    def js(self, expr, arg=None):
        return self.page.evaluate(expr, arg) if arg is not None else self.page.evaluate(expr)
    def wait_for(self, expr, timeout=120, poll=0.5):
        t = time.time()
        while time.time() - t < timeout:
            try:
                v = self.page.evaluate(expr)
                if v: return v
            except Exception: pass
            time.sleep(poll)
        raise TimeoutError('wait_for timed out: ' + expr)
    def start_flight(self, timeout=600):
        """Skip the menu: enterApp() + launchFlight() (what NEW GAME does, minus the consent/mode dialogs) and wait for the flight scene."""
        self.wait_for("window.__THREE_READY__ && typeof enterApp==='function'", 180)
        self.js("enterApp()"); self.js("launchFlight()")
        return self.wait_for("typeof flightInited!=='undefined'&&flightInited&&STATE.screen==='flight'", timeout, poll=2)
    def shot(self, path):
        self.page.screenshot(path=str(path), timeout=120000); return path
    def close(self):
        try: self.browser.close(); self.pw.stop(); self.srv.shutdown()
        except Exception: pass

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--query', default='debug=1'); ap.add_argument('--eval', action='append', default=[])
    ap.add_argument('--shot'); ap.add_argument('--wait', type=float, default=20); ap.add_argument('--webgpu', action='store_true')
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()
    g = Game(query=a.query, webgpu=a.webgpu, verbose=a.verbose).open()
    try:
        time.sleep(a.wait)
        for e in a.eval: print(json.dumps(g.js(e), indent=1, default=str))
        if a.shot: g.shot(a.shot)
        print('--- net problems'); [print(n) for n in g.net[:40]]
        print('--- logs (%d)' % len(g.logs)); [print(k, t[:300]) for _, k, t in g.logs[-40:]]
    finally: g.close()
if __name__ == '__main__': main()
