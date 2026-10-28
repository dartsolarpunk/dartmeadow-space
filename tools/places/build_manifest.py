#!/usr/bin/env python3
"""Fallback registry for the placement system: reads the asset-pack registry
(the @asset(...) decorators in jots-towns/src/kits_*.py) and the per-asset stats
JSON, writes assets/places/manifest.json in the shape ui/dm-places-core.js's
normalizeManifest() reads.  When jots-towns/manifest.json exists, pass it with
--manifest and it is used as-is (copied), with stats merged in.

  python3 tools/places/build_manifest.py [--src /workspace/jots-towns] [--out assets/places]
"""
import ast, glob, json, os, shutil, sys, argparse
ap = argparse.ArgumentParser()
ap.add_argument('--src', default='/workspace/jots-towns')
ap.add_argument('--out', default='assets/places')
ap.add_argument('--manifest', default=None, help='authoritative manifest.json (wins over the registry)')
a = ap.parse_args()
if a.manifest is None and os.path.exists(os.path.join(a.src,'manifest.json')): a.manifest = os.path.join(a.src,'manifest.json')
os.makedirs(a.out, exist_ok=True)
reg = {}
for f in sorted(glob.glob(os.path.join(a.src, 'src', 'kits_*.py'))):
    tree = ast.parse(open(f).read())
    for n in ast.walk(tree):
        if isinstance(n, ast.FunctionDef):
            for d in n.decorator_list:
                if isinstance(d, ast.Call) and getattr(d.func, 'id', '') == 'asset':
                    try:
                        args = [ast.literal_eval(x) for x in d.args]
                        kw = {k.arg: ast.literal_eval(k.value) for k in d.keywords}
                    except Exception:
                        continue
                    name, body, kind = args[:3]
                    reg[name] = dict(id=name, body=body, kind=kind, slope=kw.get('slope', 8), alt=list(kw.get('alt', (-500, 2000))),
                                     theme=kw.get('theme') or body, desc=kw.get('desc', ''), place=kw.get('place', ''))
man = None
if a.manifest and os.path.exists(a.manifest):
    man = json.load(open(a.manifest))
    items = man if isinstance(man, list) else (man.get('assets') or man.get('places') or man.get('items') or [])
    for it in items:
        k = it.get('id') or it.get('name')
        if k: reg.setdefault(k, {}).update(it)
out = []
for name, e in reg.items():
    g = os.path.join(a.src, 'glb', name + '.glb')
    if not os.path.exists(g):
        continue                      # only assets that were actually built ship
    st = {}
    sp = os.path.join(a.src, '_work', 'stats', name + '.json')
    if os.path.exists(sp): st = json.load(open(sp))
    e = dict(e)
    e['glb'] = name + '.glb'
    e['bytes'] = os.path.getsize(g)
    for k in ('radius', 'bbox', 'lod0', 'lod1'):
        if k in st: e.setdefault(k, st[k])
    shutil.copyfile(g, os.path.join(a.out, name + '.glb'))
    out.append(e)
json.dump({'version': 1, 'base': 'assets/places/', 'assets': out}, open(os.path.join(a.out, 'manifest.json'), 'w'), indent=1)
print(len(out), 'assets;', sum(e['bytes'] for e in out), 'bytes')
