#!/usr/bin/env python3
"""Reproduce / regression-check the Bird Temple quick-travel path on the REAL game.
   python3 tools/dev/bird-temple-repro.py [--webgpu] [--out /tmp/bt] [--no-travel]
Boots, waits for the temple to be built + spawned, calls travelToBirdTemple(), then dumps whether it is in the scene, visible, near the
camera, and (screenshot) actually drawn. Exit code 1 if the temple is not in the scene / not visible / no meshes / never drawn / GPU errors."""
import argparse, importlib.util, json, sys, time
from pathlib import Path
spec = importlib.util.spec_from_file_location('bg', str(Path(__file__).with_name('boot-game.py'))); bg = importlib.util.module_from_spec(spec); spec.loader.exec_module(bg)

DUMP = """(()=>{ const bt=BIRD_TEMPLE, g=bt.group, cam=flightCamera; const o={};
 o.screen=STATE.screen; o.backend=(flightRenderer&&flightRenderer.backend&&flightRenderer.backend.constructor&&flightRenderer.backend.constructor.name)||'?';
 o.hasGroup=!!g; o.spawned=!!bt.spawned; o.loading=!!bt._loading; o.tries=bt._tries|0; o.gaveUp=!!bt._gaveUp; o.rebuilds=bt._rebuilds|0;
 if(g){ let r=g; while(r.parent) r=r.parent; o.inFlightScene=(r===flightScene); o.visible=g.visible; o.parentChainVisible=(()=>{let n=g,v=true;while(n){if(!n.visible)v=false;n=n.parent}return v})();
  g.updateMatrixWorld(true); const p=g.getWorldPosition(new THREE.Vector3()); o.pos=p.toArray().map(x=>+x.toFixed(1)); o.scale=g.scale.x;
  o.distToCam=+cam.position.distanceTo(p).toFixed(1); o.camFar=cam.far; o.camNear=cam.near; o.flightPos=STATE.flight.pos.toArray().map(x=>+x.toFixed(1));
  let m=0,vis=0,nan=0; g.traverse(n=>{ if(n.isMesh){ m++; if(n.visible) vis++; const s=n.geometry&&n.geometry.boundingSphere; if(s&&!isFinite(s.radius)) nan++; } });
  o.meshes=m; o.visibleMeshes=vis; o.badSphere=nan; o.drawnAgoMs=bt._drawnAt?Math.round(performance.now()-bt._drawnAt):null;
  o.hullR=(typeof _btHullR==='function')?+(_btHullR()||0).toFixed(1):null; o.R0=bt._R0; }
 try{ o.pwOpen=!!(typeof PW!=='undefined'&&PW&&(PW.open||PW.opening)); }catch(e){}
 try{ o.surfaceActive=!!surfaceActive; o.atmoActive=!!atmoActive; }catch(e){}
 try{ o.dmSys=window.dmSys&&dmSys.text&&dmSys.text(); }catch(e){}
 try{ o.crumbs=(JSON.parse(localStorage.getItem('dm_bc_v1')||'[]')||[]).slice(-12); }catch(e){}
 return o; })()"""

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--webgpu', action='store_true'); ap.add_argument('--out', default='/tmp/bt-repro'); ap.add_argument('--no-travel', action='store_true')
    ap.add_argument('--query', default='harness=1'); ap.add_argument('--boot-timeout', type=int, default=900)
    a = ap.parse_args(); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    t0 = time.time(); T = lambda m: print('T+%4.0fs %s' % (time.time() - t0, m), flush=True)
    g = bg.Game(query=a.query, webgpu=a.webgpu, verbose=True).open()
    rc = 0
    try:
        g.start_flight(a.boot_timeout); T('flight scene up')
        g.wait_for("BIRD_TEMPLE.group&&BIRD_TEMPLE.spawned", a.boot_timeout); T('temple built + spawned')
        T('before travel: ' + json.dumps(g.js(DUMP)))
        if not a.no_travel:
            g.js("travelToBirdTemple()"); T('travelToBirdTemple() called')
            for i in range(6):
                time.sleep(5); d = g.js(DUMP); T('after travel #%d: %s' % (i, json.dumps(d)))
            g.shot(out / 'after-travel.png'); T('screenshot ' + str(out / 'after-travel.png'))
            bad = [k for k, v in (('not in scene', not d.get('inFlightScene')), ('not visible', not d.get('parentChainVisible')), ('no meshes', not d.get('meshes')), ('never drawn', d.get('drawnAgoMs') is None)) if v]
            if bad: T('FAIL: ' + ', '.join(bad)); rc = 1
            else: T('OK: temple is in the scene, visible and was drawn')
        errs = [l for l in g.logs if l[1] in ('pageerror',) or 'WGSL' in l[2] or 'Error while parsing' in l[2] or 'Bird Temple' in l[2] and 'fail' in l[2].lower()]
        T('%d suspicious log lines' % len(errs)); [print('   ', k, t[:300]) for _, k, t in errs[:25]]
        if errs: rc = rc or 2
        (out / 'logs.txt').write_text('\n'.join('%s %s' % (k, t) for _, k, t in g.logs)); (out / 'net.txt').write_text('\n'.join(map(str, g.net)))
    finally:
        g.close()
    sys.exit(rc)
if __name__ == '__main__': main()
