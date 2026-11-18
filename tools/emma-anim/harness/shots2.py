#!/usr/bin/env python3
"""Sandbox stills at chosen clip times + hand close-ups. usage: shots2.py GAME_DIR VIEWER_HTML OUT  (spec list inside)"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(__file__)); from viewer_harness import Viewer
game, viewer, out = sys.argv[1:4]; os.makedirs(out, exist_ok=True)
specs = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
v = Viewer(game, viewer, query='character=emma', verbose=False); v.open()
v.wait_for('window.__emmaReady===true || !!window.__emmaError', timeout=600); print('emmaError', v.js('window.__emmaError||null'))
for sp in specs:   # {preset,t,view:'front'|'side'|'hand',name}
    v.js(f'(()=>{{const b=[...document.querySelectorAll("#emmapresets button")].find(b=>b.dataset.id==="{sp["preset"]}"); b.click();}})()')
    time.sleep(0.6)
    v.js('''(t)=>{const C=window.CHAR; const m=C.mixer; const acts=m._actions; for(const a of acts){ if(a.isRunning()||a.enabled){ a.paused=true; a.time=t; } } m.update(0); C.root.updateMatrixWorld(true);}''' .replace('(t)=>','(()=>').replace('{const C','{const t=%s; const C'%sp['t'],1)+')()') if False else None
    v.js('(()=>{const t=%s; const C=window.CHAR, m=C.mixer; for(const a of m._actions){ if(a.isRunning()||a.enabled){ a.paused=true; a.time=t; } } m.update(0); C.root.updateMatrixWorld(true);})()' % sp['t'])
    view = sp.get('view','front')
    v.js('''(()=>{const V=window.__viewer, C=window.CHAR, THREE=V.THREE; const hp=C.bones.Hips.getWorldPosition(new THREE.Vector3());
      const view="%s"; let tg, off;
      if(view==='hand'){ const hs=C.bones.LeftHand.getWorldPosition(new THREE.Vector3()); const hr=C.bones.RightHand.getWorldPosition(new THREE.Vector3()); tg=hs.clone(); off=new THREE.Vector3(0.55,0.0,0.25); }
      else if(view==='hand2'){ tg=C.bones.LeftHand.getWorldPosition(new THREE.Vector3()); off=new THREE.Vector3(0.0,0.1,0.7); }
      else { tg=hp.clone(); tg.y+=0.25; off= view==='side'? new THREE.Vector3(2.6,0.1,0) : new THREE.Vector3(0,0.1,2.6); }
      V.cam.position.copy(tg).add(off); V.ctl.target.copy(tg); V.ctl.update(); V.cam.lookAt(tg);})()''' % view)
    time.sleep(1.2); v.shot(os.path.join(out, sp['name'] + '.png')); print('shot', sp['name'])
print([l for l in v.logs if l[0]=='pageerror'][:3]); v.close()
