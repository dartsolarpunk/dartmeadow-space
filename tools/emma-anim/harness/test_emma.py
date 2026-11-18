#!/usr/bin/env python3
"""Sandbox smoke test: ?character=emma boots Emma, presets play, screenshots to OUT. usage: test_emma.py GAME_DIR VIEWER_HTML OUT [prefix]"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(__file__)); from viewer_harness import Viewer
game, viewer, out = sys.argv[1:4]; pre = sys.argv[4] if len(sys.argv) > 4 else 'sandbox'
os.makedirs(out, exist_ok=True)
v = Viewer(game, viewer, query='character=emma'); v.open()
v.wait_for('window.__emmaReady===true || !!window.__emmaError', timeout=600)
err = v.js('window.__emmaError||null'); print('emmaError', err)
print(v.js('document.getElementById("status").textContent'))
print('presets', v.js('[...document.querySelectorAll("#emmapresets button")].map(b=>b.dataset.id)'))
res = {}
for pid in ['idle', 'walk', 'run', 'jump_loop', 'climb_hang', 'swim', 'turn_left']:
    ok = v.js(f'(()=>{{const b=[...document.querySelectorAll("#emmapresets button")].find(b=>b.dataset.id==="{pid}"); if(!b) return false; b.click(); return true;}})()')
    if not ok: print('missing preset', pid); continue
    time.sleep(2.5)
    chk = v.js('''(()=>{const C=window.CHAR, bad=[]; C.root.traverse(o=>{ if(o.isBone){ const e=o.matrixWorld.elements; for(let i=0;i<16;i++) if(!isFinite(e[i])){bad.push(o.name);break;} } });
      const a=window.__viewer.CHAR.mixer; const hips=C.bones.Hips; return {nanBones:bad.length, hipsY:hips.position.y, time:C.mixer.time}})()''')
    res[pid] = chk; print(pid, chk)
    v.shot(os.path.join(out, f'{pre}_{pid}.png'))
print(json.dumps(res)); print('net', v.net[:6]); errs=[l for l in v.logs if l[0] in ('pageerror',)]; print('pageerrors', errs[:5])
v.close()
