#!/usr/bin/env python3
"""Headless stills for the character look (WebGL2 fallback under SwiftShader: LOOK only, not frame times).
  python3 tools/tests/charlook-shots.py <repo> <three-dir> <outdir> who=ariel,emma looks=off,low,high [scene=studio] [env=analytic] [views=front,q3,face] [hair=1]"""
import sys, os, json, base64, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
repo, three, out = sys.argv[1:4]; kv = dict(a.split('=', 1) for a in sys.argv[4:])
whos = kv.get('who', 'ariel,emma').split(','); looks = kv.get('looks', 'off,high').split(',')
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, p):
        p = p.split('?')[0]; return os.path.join(three, p[len('/three/'):]) if p.startswith('/three/') else os.path.join(repo, p.lstrip('/'))
    def log_message(self, *x): pass
    def end_headers(self): self.send_header('Cache-Control', 'no-store'); super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); port = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
CH = next((c for c in ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'] if os.path.exists(c)), None)
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl']
os.makedirs(out, exist_ok=True)
with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CH, args=ARGS, headless=True) if CH else p.chromium.launch(args=ARGS, headless=True)
    for w in whos:
        for lk in looks:
            pg = br.new_page(viewport={'width': 640, 'height': 800}); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)[:300])); pg.on('console', lambda m: errs.append(m.text[:300]) if m.type in ('error', 'warning') else None)
            q = 'who=%s&look=%s&scene=%s&env=%s&views=%s&hair=%s' % (w, lk, kv.get('scene', 'studio'), kv.get('env', 'analytic'), kv.get('views', 'front,q3,face'), kv.get('hair', '0'))
            pg.goto('http://127.0.0.1:%d/tools/tests/charlook-harness.html?%s&charenv=%s&charlook=%s%s' % (port, q, kv.get('env', 'analytic'), lk, kv.get('extra', '')))
            try: pg.wait_for_function('window.done===true', timeout=280000)
            except Exception as e: errs.append('timeout')
            st = pg.evaluate('({s:window.stat||null,ta:window.t_apply})')
            for k, v in pg.evaluate('window.shots||{}').items():
                open('%s/%s_%s_%s_%s%s.png' % (out, w, kv.get('scene', 'studio'), lk, k, '' if kv.get('env', 'analytic') == 'analytic' else '_' + kv['env']), 'wb').write(base64.b64decode(v.split(',')[1]))
            print(w, lk, json.dumps(st), [e for e in errs if 'GPU stall' not in e][:4]); pg.close()
    br.close()
srv.shutdown()
