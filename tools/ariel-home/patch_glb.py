#!/usr/bin/env python3
"""patch_glb.py IN.glb OUT.glb [--image NAME=FILE ...] [--drop-material ah_x ...]
Binary edit of a GLB without Blender: swap embedded image payloads by image name (e.g. strata-color-512=assets/ariel-home/cliff/strata-color-512.webp) and/or
remove every primitive that uses a material (the orphaned accessors are compacted away). Used to re-embed new cliff maps and to drop the LOD1 glow sheets."""
import sys, json, struct
a = sys.argv[1:]; src, dst = a[0], a[1]; imgs = {}; drop = set(); i = 2
while i < len(a):
    if a[i] == '--image': k, v = a[i + 1].split('=', 1); imgs[k] = v; i += 2
    elif a[i] == '--drop-material': drop.add(a[i + 1]); i += 2
    else: raise SystemExit('bad arg ' + a[i])
d = open(src, 'rb').read(); jl = struct.unpack('<I', d[12:16])[0]; J = json.loads(d[20:20 + jl]); bo = 20 + jl + 8; bl = struct.unpack('<I', d[20 + jl:24 + jl])[0]; B = d[bo:bo + bl]
if drop:
    mi = {m['name'] for m in J['materials'] if m['name'] in drop}; ids = {k for k, m in enumerate(J['materials']) if m['name'] in mi}
    n = 0
    for me in J['meshes']:
        keep = [p for p in me['primitives'] if p.get('material') not in ids]; n += len(me['primitives']) - len(keep); me['primitives'] = keep
    print('dropped primitives', n)
# rebuild the bin chunk: every bufferView copied (images replaced), views unreferenced by any accessor / image are dropped
used = set()
for ac in J['accessors']:
    if 'bufferView' in ac: used.add(ac['bufferView'])
for me in J['meshes']:
    for p in me['primitives']:
        for k in p['attributes'].values(): pass
for im in J['images']: used.add(im['bufferView'])
live = set()
for me in J['meshes']:
    for p in me['primitives']:
        live.update(p['attributes'].values())
        if 'indices' in p: live.add(p['indices'])
for k in range(len(J['accessors'])):
    pass
keepacc = sorted(live); remap = {o: n for n, o in enumerate(keepacc)}
newacc = [J['accessors'][o] for o in keepacc]
for me in J['meshes']:
    for p in me['primitives']:
        p['attributes'] = {k: remap[v] for k, v in p['attributes'].items()}
        if 'indices' in p: p['indices'] = remap[p['indices']]
J['accessors'] = newacc
usedbv = {ac['bufferView'] for ac in newacc if 'bufferView' in ac} | {im['bufferView'] for im in J['images']}
out = bytearray(); newbv = []; bvmap = {}
for k, bv in enumerate(J['bufferViews']):
    if k not in usedbv: continue
    data = B[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
    for im in J['images']:
        if im['bufferView'] == k and im.get('name') in imgs: data = open(imgs[im['name']], 'rb').read(); print('image', im['name'], len(data))
    while len(out) % 4: out += b'\0'
    nb = dict(bv); nb['byteOffset'] = len(out); nb['byteLength'] = len(data); out += data; bvmap[k] = len(newbv); newbv.append(nb)
for ac in J['accessors']:
    if 'bufferView' in ac: ac['bufferView'] = bvmap[ac['bufferView']]
for im in J['images']: im['bufferView'] = bvmap[im['bufferView']]
J['bufferViews'] = newbv
while len(out) % 4: out += b'\0'
J['buffers'] = [{'byteLength': len(out)}]
js = json.dumps(J, separators=(',', ':')).encode()
while len(js) % 4: js += b' '
open(dst, 'wb').write(b'glTF' + struct.pack('<III', 2, 12 + 8 + len(js) + 8 + len(out), 0)[0:0] + struct.pack('<I', 2) + struct.pack('<I', 12 + 8 + len(js) + 8 + len(out)) + struct.pack('<I', len(js)) + b'JSON' + js + struct.pack('<I', len(out)) + b'BIN\0' + bytes(out))
print('wrote', dst, 12 + 8 + len(js) + 8 + len(out))
