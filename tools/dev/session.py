#!/usr/bin/env python3
"""Long-lived harness session: boots the game once, then evaluates JS you drop into a directory (no reboot between experiments).
   python3 tools/dev/session.py [--dir /tmp/dm-session] [--webgpu] [--flight]   (run it in the background, log to a file)
   echo 'STATE.screen' > /tmp/dm-session/in/1.js ; cat /tmp/dm-session/out/1.json     (name = anything; processed in name order)
   echo shot:/tmp/x.png > .../in/2.js  takes a screenshot;  echo quit > .../in/3.js  closes."""
import argparse, importlib.util, json, time, traceback
from pathlib import Path
spec = importlib.util.spec_from_file_location('bg', str(Path(__file__).with_name('boot-game.py'))); bg = importlib.util.module_from_spec(spec); spec.loader.exec_module(bg)
ap = argparse.ArgumentParser(); ap.add_argument('--dir', default='/tmp/dm-session'); ap.add_argument('--webgpu', action='store_true'); ap.add_argument('--flight', action='store_true'); ap.add_argument('--query', default='harness=1')
a = ap.parse_args(); d = Path(a.dir); (d / 'in').mkdir(parents=True, exist_ok=True); (d / 'out').mkdir(exist_ok=True)
g = bg.Game(query=a.query, webgpu=a.webgpu, verbose=True).open()
(d / 'ready').write_text('booted page')
if a.flight: g.start_flight(900); (d / 'flight').write_text('flight up')
seen = 0
while True:
    for f in sorted((d / 'in').glob('*')):
        src = f.read_text().strip(); f.unlink()
        out = d / 'out' / (f.stem + '.json')
        try:
            if src == 'quit': g.close(); raise SystemExit
            if src.startswith('shot:'): g.shot(src[5:]); res = 'ok'
            elif src == 'logs': res = [[k, t[:300]] for _, k, t in g.logs[seen:]]; seen = len(g.logs)
            elif src == 'net': res = g.net
            else: res = g.js(src)
            out.write_text(json.dumps(res, default=str, indent=1))
        except SystemExit: raise
        except Exception as e: out.write_text(json.dumps({'error': str(e)[:600]}))
    time.sleep(0.3)
