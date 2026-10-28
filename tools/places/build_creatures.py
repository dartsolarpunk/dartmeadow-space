#!/usr/bin/env python3
"""Stage the JOTS creature pack for the game: assets/creatures/{*.glb,manifest-creatures.json}.
Uses /workspace/jots-towns/creatures/manifest-creatures.json when the asset worker has written it; otherwise derives
the manifest from the @creature(...) registry in creatures/src/sp_*.py plus the built GLBs (clip names read from the GLB)."""
import json, os, re, shutil, struct, sys, glob
SRC = os.environ.get('JOTS_CREATURES', '/workspace/jots-towns/creatures')
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'creatures')
os.makedirs(OUT, exist_ok=True)
def glb_info(path):
    b = open(path, 'rb').read(); n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + n])
    return dict(clips=[a['name'] for a in j.get('animations', [])], bytes=len(b))
SPEED = {'flyer_small': 9, 'flyer_raptor': 11, 'flyer_glider': 10, 'flyer_insect': 2.2, 'crawler': 0.5, 'hopper_small': 3.2, 'hopper_insect': 2.4,
         'walker_small': 2.6, 'walker_large': 2.4, 'villager': 1.2, 'elder': 0.8, 'child': 1.6, 'traveler': 1.4, 'merchant': 1.0, 'engineer': 1.2, 'bartender': 0, 'patron': 0}
SCALE = {'critter': 1, 'small': 1, 'large': 1, 'npc': 1}
GROUP = {'flyer_small': 5, 'flyer_insect': 3}
mf = os.path.join(SRC, 'manifest-creatures.json')
if os.path.exists(mf):
    man = json.load(open(mf)); src = 'asset-worker'
else:
    reg = []
    for f in sorted(glob.glob(os.path.join(SRC, 'src', 'sp_*.py'))):
        for m in re.finditer(r"@creature\('([^']+)',\s*'([^']+)'((?:,\s*\w+=(?:'[^']*'|True|False|\d+))*)\)", open(f).read()):
            kw = dict((k, v.strip("'")) for k, v in re.findall(r"(\w+)=('[^']*'|True|False|\d+)", m.group(3)))
            reg.append((m.group(1), m.group(2), kw))
    ents = []
    for cid, cat, kw in reg:
        g = os.path.join(SRC, 'glb', cid + '.glb')
        if not os.path.exists(g): continue
        info = glb_info(g); ai = kw.get('ai', ''); e = dict(id=cid, file=cid + '.glb', cat=cat, biome=kw.get('biome', 'any'), size=kw.get('size', ''), ai=ai,
            speed=SPEED.get(ai, 2), group=GROUP.get(ai, 1), flock=kw.get('flock') == 'True', glow=kw.get('glow') == 'True', clips=info['clips'], bytes=info['bytes'])
        if kw.get('role'): e['role'] = kw['role']
        ents.append(e)
    man = dict(version=1, source='registry-fallback', creatures=ents); src = 'registry'
n = 0; tot = 0
for e in man.get('creatures', man if isinstance(man, list) else []):
    g = os.path.join(SRC, 'glb', e.get('file') or (e['id'] + '.glb'))
    if os.path.exists(g): shutil.copy2(g, os.path.join(OUT, os.path.basename(g))); n += 1; tot += os.path.getsize(g)
json.dump(man, open(os.path.join(OUT, 'manifest-creatures.json'), 'w'), indent=0)
print('creatures manifest from', src, '-', n, 'glb', round(tot / 1e6, 1), 'MB')
