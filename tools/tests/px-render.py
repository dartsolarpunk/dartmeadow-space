#!/usr/bin/env python3
"""Headless renders of the parallax harnesses (software GL: for A/B pictures and shader-compile checks, NOT for frame times).

  python3 tools/tests/px-render.py <repo-dir> <three-dir> <out.png> '<harness.html?query>' [--wait 240]
  <three-dir> = a folder holding build/three.webgpu.js + build/three.tsl.js (npm 'three' 0.185.0), served at /three/
Prints a JSON line with window.ok / compileMs / frameMs / status / errors.
"""
import argparse, json, os, socket, subprocess, sys, threading, time, http.server, socketserver, functools
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('repo'); ap.add_argument('three'); ap.add_argument('out'); ap.add_argument('url'); ap.add_argument('--wait', type=int, default=240)
a = ap.parse_args()

class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split('?')[0].split('#')[0]
        if p.startswith('/three/'): return os.path.join(a.three, p[len('/three/'):])
        return os.path.join(a.repo, p.lstrip('/'))
    def log_message(self, *x): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
CHROME = next((c for c in ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'] if os.path.exists(c)), None)
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl']
errs = []
with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, args=ARGS, headless=True) if CHROME else p.chromium.launch(args=ARGS, headless=True)
    pg = br.new_page(viewport={'width': 960, 'height': 540})
    pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
    pg.on('console', lambda m: errs.append(m.text[:300]) if m.type in ('error','warning') else None)
    pg.goto('http://127.0.0.1:%d/%s' % (port, a.url.lstrip('/')))
    try: pg.wait_for_function('window.done===true', timeout=a.wait * 1000)
    except Exception as e: errs.append('timeout ' + str(e)[:100])
    info = pg.evaluate('({ok:window.ok,compileMs:window.compileMs,frameMs:window.frameMs,status:window.status,backend:window.backend,extra:window.extra||null})')
    info['errors'] = errs[:8]
    try: pg.screenshot(path=a.out, clip={'x': 0, 'y': 0, 'width': 960, 'height': 540}, timeout=180000)
    except Exception as e: info['shotErr'] = str(e)[:200]
    print(json.dumps(info)); br.close()
srv.shutdown()
