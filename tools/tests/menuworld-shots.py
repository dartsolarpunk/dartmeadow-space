#!/usr/bin/env python3
"""Headless stills of the menu world (WebGL2 fallback under SwiftShader: a LOOK check, not frame times, not WGSL).
  python3 tools/tests/menuworld-shots.py <repo> <three-dir> <outprefix> '<query>'   e.g. 'scene=studio&views=0:0.35,-75:0.35,85:2'  |  'scene=cards&w=800&h=450'  (+ &menuscene=low)"""
import argparse, base64, json, os, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('three'); ap.add_argument('out'); ap.add_argument('query'); ap.add_argument('--wait', type=int, default=300)
a = ap.parse_args()
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split('?')[0].split('#')[0]
        return os.path.join(a.three, p[len('/three/'):]) if p.startswith('/three/') else os.path.join(a.repo, p.lstrip('/'))
    def log_message(self, *x): pass
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); port = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
CHROME = next((c for c in ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'] if os.path.exists(c)), None)
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl']
errs = []
with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, args=ARGS, headless=True) if CHROME else p.chromium.launch(args=ARGS, headless=True)
    pg = br.new_page(viewport={'width': 1000, 'height': 700})
    pg.on('pageerror', lambda e: errs.append(str(e)[:300])); pg.on('console', lambda m: print('console', m.type, m.text[:240], flush=True) if m.type in ('error', 'warning', 'log') else None); pg.on('crash', lambda: print('PAGE CRASH', flush=True))
    pg.goto('http://127.0.0.1:%d/tools/tests/menuworld-harness.html?%s' % (port, a.query))
    try: pg.wait_for_function('window.done===true', timeout=a.wait * 1000)
    except Exception as e: errs.append('timeout ' + str(e)[:100])
    info = pg.evaluate('({tier:window.tier,world:window.world,cw:window.cw,calls:window.calls,tris:window.tris,ms:window.ms,errs:window.errs,frames:window.frames})')
    for k, v in (pg.evaluate('window.shots||{}')).items(): open('%s_%s.png' % (a.out, k), 'wb').write(base64.b64decode(v.split(',')[1]))
    info['errors'] = errs[:30]; print(json.dumps(info)); br.close()
srv.shutdown()
