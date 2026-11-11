#!/usr/bin/env python3
"""Robustness of the lighting overhaul (headless Chromium + SwiftShader: correctness / leaks / flags, NOT frame times).

  python3 tools/tests/lighting-robust.py <three-dir> [--cycles 12] [--wait 240]
  <three-dir> = a folder holding build/three.webgpu.js + build/three.tsl.js + three.core.js (npm 'three' 0.185.0), served at /three/
Runs tools/tests/lighting-robust.html on WebGL2 (and WebGPU if the headless browser has an adapter) for: default flags, ?vlights=0, and low/high tiers.
Exit 1 on any failed check."""
import argparse, json, os, sys, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('three'); ap.add_argument('--cycles', type=int, default=12); ap.add_argument('--wait', type=int, default=240); ap.add_argument('--gpu', action='store_true', help='also try the WebGPU backend')
a = ap.parse_args()
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split('?')[0].split('#')[0]
        if p.startswith('/three/'): return os.path.join(a.three, p[len('/three/'):])
        return os.path.join(REPO, p.lstrip('/'))
    def log_message(self, *x): pass
    def end_headers(self): self.send_header('Cache-Control', 'no-store'); super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
CHROME = next((c for c in ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'] if os.path.exists(c)), None)
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl', '--js-flags=--expose-gc']
runs = [('webgl2 default', '?gl=1&cycles=%d' % a.cycles), ('webgl2 ?vlights=0', '?gl=1&vlights=0'), ('webgl2 ?vlights=low', '?gl=1&vlights=low&cycles=6'), ('webgl2 ?vlights=high', '?gl=1&vlights=high&cycles=4')]
if a.gpu: runs.append(('webgpu default', '?cycles=6'))
fails = 0
with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, args=ARGS, headless=True) if CHROME else p.chromium.launch(args=ARGS, headless=True)
    for name, q in runs:
        pg = br.new_page(viewport={'width': 400, 'height': 260}); pg.on('pageerror', lambda e: print('   pageerror', str(e)[:200]))
        pg.goto('http://127.0.0.1:%d/tools/tests/lighting-robust.html%s' % (port, q))
        try: pg.wait_for_function('window.__done', timeout=a.wait * 1000)
        except Exception as e: print('FAIL %s: timeout' % name); fails += 1; pg.close(); continue
        d = pg.evaluate('window.__done'); print('== %s (%s)' % (name, d.get('backend')))
        if d.get('fatal'): print('FAIL fatal', d['fatal'][:300]); fails += 1
        for r in d['results']:
            print(('ok   ' if r['ok'] else 'FAIL ') + r['name'], r['info'][:240] if (not r['ok'] or 'flat' in r['name']) else '')
            if not r['ok']: fails += 1
        pg.close()
    br.close()
srv.shutdown()
print('lighting-robust: %s' % ('all passed' if not fails else '%d FAILED' % fails)); sys.exit(1 if fails else 0)
