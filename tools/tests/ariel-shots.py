#!/usr/bin/env python3
"""Headless stills of Ariel with real three.js r185 (WebGL2 fallback under SwiftShader; for LOOK checks, not frame times).
  python3 tools/tests/ariel-shots.py <repo> <three-dir> <outprefix> '<query, e.g. glb=characterassests/x.glb&views=front,top>' [--wait 240]
<three-dir> holds build/three.webgpu.js + build/three.tsl.js + examples/jsm (npm 'three' 0.185.0), served at /three/.
Writes <outprefix>_<view>.png per view and prints window.meshNames / flashOK / errors as JSON."""
import argparse, base64, json, os, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('three'); ap.add_argument('out'); ap.add_argument('query'); ap.add_argument('--wait', type=int, default=240)
a = ap.parse_args()
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split('?')[0].split('#')[0]
        return os.path.join(a.three, p[len('/three/'):]) if p.startswith('/three/') else os.path.join(a.repo, p.lstrip('/'))
    def log_message(self, *x): pass
    def end_headers(self): self.send_header('Cache-Control', 'no-store'); super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
CHROME = next((c for c in ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'] if os.path.exists(c)), None)
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl']
errs = []
with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, args=ARGS, headless=True) if CHROME else p.chromium.launch(args=ARGS, headless=True)
    pg = br.new_page(viewport={'width': 720, 'height': 720})
    pg.on('pageerror', lambda e: errs.append(str(e)[:300])); pg.on('console', lambda m: errs.append(m.text[:300]) if m.type in ('error',) else None)
    pg.goto('http://127.0.0.1:%d/tools/tests/ariel-shots-harness.html?%s' % (port, a.query))
    try: pg.wait_for_function('window.done===true', timeout=a.wait * 1000)
    except Exception as e: errs.append('timeout ' + str(e)[:100])
    info = pg.evaluate('({flash:window.flashOK,flashErr:window.flashErr,attached:window.attached,stats:window.charmStats||null,names:(window.meshNames||[]).length,pose:window.poseStats||null,clips:window.clipNames||null,simErr:window.simErr||null,trace:(window.trace||[]).filter((x,i)=>i%3==0).slice(0,40),dm:(window.DMCharm&&DMCharm.stats&&DMCharm.stats())||null})')
    for k, v in (pg.evaluate('window.shots||{}')).items():
        open('%s_%s.png' % (a.out, k), 'wb').write(base64.b64decode(v.split(',')[1]))
    info['errors'] = errs[:6]; print(json.dumps(info)); br.close()
srv.shutdown()
