#!/usr/bin/env python3
"""Headless look/compile check of ui/dm-atmo-volume.js (WebGL2 fallback under SwiftShader: a LOOK + shader-compile check, not frame times).
  python3 tools/tests/atmo-volume-shots.py <repo> <three-dir> <outprefix> 'tier=3&view=orbit'"""
import argparse, base64, json, os, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('repo'); ap.add_argument('three'); ap.add_argument('out'); ap.add_argument('query'); ap.add_argument('--wait', type=int, default=240)
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
    pg = br.new_page(viewport={'width': 820, 'height': 520})
    pg.on('pageerror', lambda e: errs.append(str(e)[:300])); pg.on('console', lambda m: print('console', m.type, m.text[:300], flush=True) if m.type in ('error', 'warning') else None)
    pg.goto('http://127.0.0.1:%d/tools/tests/atmo-volume-harness.html?%s' % (port, a.query))
    try: pg.wait_for_function('window.done===true', timeout=a.wait * 1000)
    except Exception as e: errs.append('timeout ' + str(e)[:100])
    info = pg.evaluate('({volOK:window.volOK,tier:window.tierName,wisps:window.wispCount,live:window.live,ms:window.ms,errs:window.errs})')
    for k, v in (pg.evaluate('window.shots||{}')).items(): open('%s_%s.png' % (a.out, k), 'wb').write(base64.b64decode(v.split(',')[1]))
    info['errors'] = errs[:30]; print(json.dumps(info)); br.close()
srv.shutdown()
