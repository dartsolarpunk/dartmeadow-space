#!/usr/bin/env python3
"""Headless close-ups of strand hair (WebGL2 backend of WebGPURenderer on SwiftShader: the game's ribbon shader; look only, NOT frame times).
  python3 tools/tests/hair-shots.py <repo> <three-dir> <outprefix> '<query: char=emma&clip=Emma_Idle&headturn=1&views=front,side,back&tier=2>' [--wait 300] [--hair-dir DIR]
--hair-dir DIR serves DIR/hair_strands.js at /__alt/hair_strands.js (use query hair=/__alt/hair_strands.js) to compare against another version of the solver.
Writes <outprefix>_<view>.png per view."""
import argparse, base64, json, os, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('three'); ap.add_argument('out'); ap.add_argument('query'); ap.add_argument('--wait', type=int, default=300); ap.add_argument('--hair-dir', default=None)
a = ap.parse_args()
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.glb': 'model/gltf-binary', '.js': 'text/javascript', '.mjs': 'text/javascript', '.bin': 'application/octet-stream', '.json': 'application/json'}
    def translate_path(self, path):
        p = path.split('?')[0].split('#')[0]
        if p.startswith('/three/'): return os.path.join(a.three, p[len('/three/'):])
        if a.hair_dir and p.startswith('/__alt/'): return os.path.join(a.hair_dir, p[len('/__alt/'):])
        return os.path.join(a.repo, p.lstrip('/'))
    def log_message(self, *x): pass
    def end_headers(self): self.send_header('Cache-Control', 'no-store'); super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
CHROME = next((c for c in ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'] if os.path.exists(c)), None)
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl', '--no-sandbox']
errs = []
with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, args=ARGS, headless=True) if CHROME else p.chromium.launch(args=ARGS, headless=True)
    pg = br.new_page(viewport={'width': 640, 'height': 640})
    pg.on('pageerror', lambda e: errs.append(str(e)[:300])); pg.on('console', lambda m: errs.append(m.text[:300]) if m.type in ('error', 'warning') else None)
    pg.goto('http://127.0.0.1:%d/tools/tests/hair-shots-harness.html?%s' % (port, a.query))
    try: pg.wait_for_function('window.done===true', timeout=a.wait * 1000)
    except Exception as e: errs.append('timeout ' + str(e)[:100])
    info = pg.evaluate('({stats:window.hairStats||null})')
    for k, v in (pg.evaluate('window.shots||{}')).items(): open('%s_%s.png' % (a.out, k), 'wb').write(base64.b64decode(v.split(',')[1]))
    info['errors'] = errs[:6]; print(json.dumps(info)); br.close()
srv.shutdown()
