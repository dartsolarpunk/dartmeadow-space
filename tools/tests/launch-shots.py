#!/usr/bin/env python3
"""Deterministic stills of the duo launch via DM_MENUSCENE.seek (not real-time)."""
import argparse, json, os, threading, http.server, socketserver
from pathlib import Path
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('repo')
ap.add_argument('three')
ap.add_argument('outdir')
ap.add_argument('--w', type=int, default=800)
ap.add_argument('--h', type=int, default=450)
ap.add_argument('--wait', type=int, default=300)
a = ap.parse_args()
out = Path(a.outdir); out.mkdir(parents=True, exist_ok=True)

class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split('?')[0].split('#')[0]
        return os.path.join(a.three, p[len('/three/'):]) if p.startswith('/three/') else os.path.join(a.repo, p.lstrip('/'))
    def log_message(self, *x): pass

socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
CHROME = next((c for c in ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'] if os.path.exists(c)), None)
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--enable-webgl']
errs = []

def P(*x): print(*x, flush=True)

with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, args=ARGS, headless=True) if CHROME else p.chromium.launch(args=ARGS, headless=True)
    pg = br.new_page(viewport={'width': a.w, 'height': a.h})
    pg.set_default_timeout(120000)
    pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
    pg.on('console', lambda m: P('console', m.type, m.text[:240]) if m.type in ('error', 'warning', 'log') else None)
    pg.goto('http://127.0.0.1:%d/tools/tests/launch-harness.html?msgl=1&msq=1' % port, wait_until='domcontentloaded')
    try:
        pg.wait_for_function('window.doneReady===true', timeout=a.wait * 1000)
    except Exception as e:
        errs.append('timeout ' + str(e)[:120])
    info = pg.evaluate('({info:window.launchInfo, errs:window.errs})')
    P('launch', json.dumps(info))
    if not (info and info.get('info') and info['info'].get('ok')):
        pg.screenshot(path=str(out / 'launch_failed.png'), timeout=120000, animations='disabled')
        P('FAILED', info)
        br.close(); srv.shutdown(); raise SystemExit(2)
    times = info['info']
    tDep = float(times.get('tDep') or 10)
    tBay = float(times.get('tBay') or (tDep + 5.2))
    tL = float(times.get('tL') or (tDep - 1.3))
    # 6 required beats + a peak-dissolve check
    import os as _os
    FPS = float(_os.environ.get('LAUNCH_FPS', '0') or 0)
    if FPS > 0:
        T1 = float(_os.environ.get('LAUNCH_T1', '0') or 0) or (tBay + 3.2)
        beats = [('v%04d' % i, round(0.05 + i / FPS, 4)) for i in range(int((T1 - 0.05) * FPS) + 1)]
    else:
      beats = [
        ('00_descent', 1.2),
        ('01_approach', 2.45),
        ('01b_landed', 4.6),
        ('02a_stepon', max(0.4, tL - 1.0)),
        ('02_boarding', max(0.4, tL - 0.35)),
        ('02c_liftoff', tDep + 1.0),
        ('03_jets', tDep + 2.55),
        ('03b_midflight', min(tBay - 0.8, tDep + 3.45)),
        ('04_dissolve', tBay - 0.22),
        ('05_doors', tBay + 0.75),
        ('06_arrival', tBay + 2.4),
      ]
    def grab(path):
        """Prefer canvas pixels + optional .ms-dissolve composite (SwiftShader page.screenshot can hang)."""
        import base64, io
        data = pg.evaluate("""() => {
          const el = document.querySelector('.ms-dissolve');
          let overlay = null;
          if (el) {
            const s = getComputedStyle(el);
            overlay = {opacity: parseFloat(s.opacity||'0'), bg: s.backgroundColor, img: s.backgroundImage,
                       display: s.display, w: el.offsetWidth, h: el.offsetHeight};
          }
          const png = (typeof window.grabPng==='function' && window.grabPng()) || (document.querySelector('canvas')&&document.querySelector('canvas').toDataURL('image/png'));
          return {png, overlay};
        }""")
        if not data or not data.get('png'):
            pg.screenshot(path=str(path), timeout=120000, animations='disabled')
            return {'via': 'page', 'overlay': data and data.get('overlay')}
        raw = base64.b64decode(data['png'].split(',', 1)[1])
        ov = data.get('overlay') or {}
        try:
            from PIL import Image, ImageDraw, ImageColor
            im = Image.open(io.BytesIO(raw)).convert('RGBA')
            op = float(ov.get('opacity') or 0)
            if op > 0.02 and ov.get('display') != 'none':
                bg = ov.get('bg') or 'rgb(5,7,12)'
                try:
                    col = ImageColor.getrgb(bg)
                except Exception:
                    col = (5, 7, 12)
                layer = Image.new('RGBA', im.size, (*col[:3], int(round(op * 255))))
                im = Image.alpha_composite(im, layer)
            im.convert('RGB').save(path, 'PNG')
        except Exception as e:
            Path(path).write_bytes(raw)
            P('grab-fallback-raw', e)
        return {'via': 'canvas', 'overlay': ov}

    PROBE_JS = '''() => { const C = window.DM_MENUSCENE && window.DM_MENUSCENE._ctx; if (!C) return null; const D = C.duo(); if (!D) return null;
      const T = window.DM_MENUSCENE.THREE || (D.mid && D.mid.constructor && null); const out = [];
      C.pilots().forEach((X, i) => { const d = X.du; if (!d || !d.board) return; const b = d.board, B = X.bones; b.updateMatrixWorld(true); X.root.updateMatrixWorld(true);
        const V = D.mid.constructor, w = (n) => B[n] ? B[n].getWorldPosition(new V()) : null, L = (v) => v ? b.worldToLocal(v.clone()) : null;
        const hip = w('Hips'), ul = w('LeftUpLeg'), ur = w('RightUpLeg'), fl = w('LeftFoot'), fr = w('RightFoot'), hd = w('Head');
        const lat = ul.clone().sub(ur), up = hd.clone().sub(hip), fwd = new V().crossVectors(lat, up).normalize();
        const bs = b.getWorldScale(new V()), o = b.localToWorld(new V()), fl0 = b.localToWorld(new V(0, 0, 0)), fwdL = b.worldToLocal(fl0.clone().add(fwd)).sub(b.worldToLocal(fl0.clone()));
        const r = (v) => v ? [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] : null;
        const a = b.userData.deckAnchor || {x:0,y:0,z:0};
        out.push({ id: X.id, anchor: [a.x, a.y, a.z], hipsL: r(L(hip)), footL: r(L(fl)), footR: r(L(fr)), chestFwdBoardLocal: r(fwdL.normalize()), chestFwdWorld: r(fwd) }); });
      return out; }'''
    results = []
    for name, t in beats:
        st = pg.evaluate('(t) => window.seek(t)', t)
        P('seek', name, t, st)
        if _os.environ.get('LAUNCH_PROBE'):   # (v380) rider stance probe: hips / feet / chest-forward in each board's local frame
            P('probe', name, pg.evaluate(PROBE_JS))
        path = out / ('launch_%s.png' % name)
        meta = grab(path)
        P('shot', path, path.stat().st_size, meta)
        results.append({'name': name, 't': t, 'state': st, 'bytes': path.stat().st_size, 'grab': meta})
    (out / 'launch_times.json').write_text(json.dumps({'info': times, 'beats': results, 'errors': errs[:20]}, indent=2))
    br.close()
srv.shutdown()
P('DONE', out)
