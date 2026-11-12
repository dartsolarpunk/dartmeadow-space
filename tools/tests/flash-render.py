#!/usr/bin/env python3
"""Render check of the REAL ui/dm-flash.js spot (headless Chromium + SwiftShader, WebGL2 backend of WebGPURenderer, log depth, ACES, PCF-soft shadows).
  python3 tools/tests/flash-render.py <three-dir> [outdir]      ONLY=off,default python3 ... runs a subset
<three-dir> = folder holding build/three.webgpu.js + build/three.tsl.js (npm three 0.185.0), served at /three/.  Prints the mean luminance (0..255) of image regions per variant;
exit 1 if a surface that must be lit (ground near/mid, wall, cube, columns) is not clearly brighter than the flashlight-OFF baseline.  Needs PIL."""
import sys, os, io, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
from PIL import Image
three = sys.argv[1]; out = sys.argv[2] if len(sys.argv) > 2 else None
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, p):
        p = p.split('?')[0].split('#')[0]
        return os.path.join(three, p[len('/three/'):]) if p.startswith('/three/') else os.path.join(REPO, p.lstrip('/'))
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); port = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl']
VARIANTS = [('off', '?off=1'), ('default', ''), ('wrap', '?wrap=1'), ('noshadow', '?flashshadow=0'), ('desktop', '?tier=desktop&wrap=1'), ('spot', '?cone=2&wrap=1'), ('beamoff', '?flashbeam=0'), ('side', '?ox=4&wrap=1'), ('sidens', '?ox=4&flashshadow=0')]
only = os.environ.get('ONLY'); VARIANTS = [v for v in VARIANTS if not only or v[0] in only.split(',')]
W, H_ = 640, 400
REG = {'groundNear': (.4, .88, .6, .98), 'groundMid': (.42, .7, .58, .78), 'groundFar': (.44, .6, .56, .64), 'wall': (.44, .4, .56, .5), 'cube': (.47, .52, .53, .56), 'colL': (.27, .45, .3, .55), 'sideGround': (.05, .88, .2, .98), 'shadowWall': (.585, .36, .605, .5), 'surround': (.26, .3, .32, .4)}
def lum(im, box):
    x0, y0, x1, y1 = [int(v * (W if i % 2 == 0 else H_)) for i, v in enumerate(box)]
    c = im.crop((x0, y0, x1, y1)).convert('RGB'); n = c.width * c.height; px = c.getdata()
    return round(sum(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px) / n, 1)
def scan(im):   # (v324) NO PERIMETER: the largest luminance step between neighbouring 8-px windows along a horizontal band over the ground (the old cone / saturation edge was a ~60-level step)
    g = im.convert('L'); w, h = g.size; worst = 0
    for y0 in (int(h * .78), int(h * .88)):
        row = [sum(g.crop((x, y0, x + 8, y0 + 4)).getdata()) / 32.0 for x in range(0, w - 8, 8)]
        worst = max(worst, max(abs(a - b) for a, b in zip(row, row[1:])))
    return round(worst, 1)
res = {}; fails = 0
with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS, headless=True)
    for name, q in VARIANTS:
        pg = br.new_page(viewport={'width': W, 'height': H_}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
        pg.on('console', lambda m: errs.append(m.text[:200]) if m.type == 'error' and '404' not in m.text else None)
        pg.goto('http://127.0.0.1:%d/tools/tests/flash-render.html%s' % (port, q))
        try: pg.wait_for_function('window.__done', timeout=150000)
        except Exception: print('FAIL', name, 'timeout', flush=True); fails += 1; pg.close(); continue
        d = pg.evaluate('window.__done')
        if not d.get('ok'): print('FAIL', name, d.get('fatal', '')[:500], flush=True); fails += 1; pg.close(); continue
        png = pg.screenshot(); im = Image.open(io.BytesIO(png))
        if out: os.makedirs(out, exist_ok=True); open(os.path.join(out, name + '.png'), 'wb').write(png)
        res[name] = {k: lum(im, b) for k, b in REG.items()}
        res[name]['maxStep'] = scan(im)
        print('%-9s' % name, ' '.join('%s=%s' % kv for kv in res[name].items()), 'shadowUpdates=%s err=%s' % (d['status'].get('shadowUpdates'), (errs + d.get('err', []))[:2]), flush=True)
        pg.close()
    br.close()
srv.shutdown()
MUST = {'default': ('groundNear', 'groundMid', 'wall', 'cube', 'surround'), 'wrap': ('groundNear', 'groundMid', 'wall', 'cube'), 'noshadow': ('groundNear', 'groundMid', 'wall', 'cube'), 'desktop': ('groundNear', 'groundMid', 'wall', 'cube'),
        'beamoff': ('groundNear', 'groundMid', 'wall', 'cube'), 'spot': ('wall', 'cube'), 'side': ('wall', 'cube', 'groundFar'), 'sidens': ('wall', 'cube', 'groundFar')}
if 'off' in res:
    for name in res:
        for k in MUST.get(name, ()):
            if res[name][k] < res['off'][k] + 8: print('FAIL %s: %s not lit (%s vs off %s)' % (name, k, res[name][k], res['off'][k])); fails += 1
for name in ('default', 'desktop'):
    if name in res:
        if res[name]['maxStep'] > 14: print('FAIL %s: a visible perimeter - the largest step between neighbouring ground windows is %s levels (> 14)' % (name, res[name]['maxStep'])); fails += 1
        else: print('ok   %s: no perimeter (largest ground step %s levels)' % (name, res[name]['maxStep']))
if 'side' in res and 'sidens' in res:
    if not res['side']['shadowWall'] < res['sidens']['shadowWall'] - 15: print('FAIL shadows: the column shadow on the wall is not darker with the shadow map on (%s vs %s without)' % (res['side']['shadowWall'], res['sidens']['shadowWall'])); fails += 1
    else: print('ok   shadow map darkens the column shadow on the wall (%s vs %s)' % (res['side']['shadowWall'], res['sidens']['shadowWall']))
print('flash-render: %s' % ('ok' if not fails else '%d FAILED' % fails)); sys.exit(1 if fails else 0)
