#!/usr/bin/env python3
"""Headless harness for the Ariel Rig Viewer (Playwright + Chromium + SwiftShader / WebGL2, no internet).
 - serves GAME_DIR (a checkout of dartsolarpunk/dartmeadow-space, optionally with the Emma assets) at http://127.0.0.1:P/
 - serves the viewer html at /__viewer/ariel-rig-viewer.html
 - answers https://cdn.jsdelivr.net/npm/three@0.185.0/... from node_modules/three (npm i three@0.185.0)
 - everything else external (fonts, api.github.com) -> 404 immediately
usage: python3 viewer_harness.py GAME_DIR VIEWER_HTML OUT_DIR [--emma]"""
import sys, os, json, time, threading, http.server, socketserver, functools, argparse
from pathlib import Path
from playwright.sync_api import sync_playwright

NODE = Path(os.environ.get('DM_HARNESS_NODE', '/home/claude/emma-work/anim/node'))
CDN = 'https://cdn.jsdelivr.net/npm/three@0.185.0/'

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self): self.send_header('Cache-Control','no-cache'); self.send_header('Access-Control-Allow-Origin','*'); super().end_headers()
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.glb':'model/gltf-binary', '.js':'text/javascript', '.bin':'application/octet-stream', '.json':'application/json'}

class Viewer:
    def __init__(self, game_dir, viewer_html, query='', size=(900, 700), verbose=True):
        self.logs = []; self.net = []; self.verbose = verbose
        game_dir = Path(game_dir).resolve(); vdir = Path(viewer_html).resolve()
        class S(socketserver.ThreadingTCPServer): allow_reuse_address = True; daemon_threads = True
        outer = self
        class Handler(H):
            def translate_path(self, path):
                p = path.split('?')[0]
                if p.startswith('/__viewer/'): return str(vdir.parent / p[len('/__viewer/'):])
                return str(game_dir / p.lstrip('/'))
        self.srv = S(('127.0.0.1', 0), Handler); self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.vname = vdir.name
        self.pw = sync_playwright().start()
        args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--no-sandbox']
        self.browser = self.pw.chromium.launch(headless=True, args=args)
        self.ctx = self.browser.new_context(viewport={'width': size[0], 'height': size[1]}, service_workers='block')
        self.page = self.ctx.new_page()
        self.page.on('console', lambda m: self._log('console.'+m.type, m.text))
        self.page.on('crash', lambda: self._log('CRASH','page crashed'))
        self.page.on('pageerror', lambda e: self._log('pageerror', str(e)))
        self.page.route('**/*', self._route)
        self.base = f'http://127.0.0.1:{self.port}/'
        self.url = f'{self.base}__viewer/{self.vname}?base={self.base}&webgl=1' + (('&'+query) if query else '')
    def _log(self, k, t):
        self.logs.append((k, t))
        if self.verbose and (k != 'console.log' or 'viewer' in t.lower() or 'emma' in t.lower()): print('[%s] %s' % (k, t[:300]), flush=True)
    def _route(self, route):
        u = route.request.url
        if u.startswith(CDN):
            f = NODE/'node_modules'/'three'/u[len(CDN):].split('?')[0]
            if f.exists():
                route.fulfill(status=200, body=f.read_bytes(), headers={'Content-Type':'text/javascript','Access-Control-Allow-Origin':'*'}); return
            self.net.append(('404 three', u)); route.fulfill(status=404, body=''); return
        if u.startswith(f'http://127.0.0.1:{self.port}/') or u.startswith('data:') or u.startswith('blob:'):
            route.continue_(); return
        self.net.append(('blocked', u)); route.fulfill(status=404, body='')
    def open(self): self.page.goto(self.url, wait_until='domcontentloaded')
    def js(self, expr, timeout=120000):
        return self.page.evaluate(expr)
    def wait_for(self, expr, timeout=300):
        self.page.wait_for_function(expr, timeout=timeout*1000, polling=500)
    def shot(self, path, clip_stage=True):
        box = self.page.evaluate('(()=>{const r=document.getElementById("stage").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()')
        self.page.screenshot(path=path, timeout=180000, clip=box, animations='allow', caret='initial')
    def close(self):
        try: self.browser.close(); self.pw.stop(); self.srv.shutdown()
        except Exception: pass

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('game'); ap.add_argument('viewer'); ap.add_argument('out')
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    v = Viewer(a.game, a.viewer); v.open()
    v.wait_for('window.__viewerReady===true', timeout=400)
    print(v.js('document.getElementById("status").textContent'))
    v.shot(os.path.join(a.out, 'baseline_ariel.png')); print('net', v.net); v.close()
