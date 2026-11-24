#!/usr/bin/env python3
"""glb_tool.py - small byte-level glTF 2.0 (GLB) toolkit for the t1583u undercliff packaging (no Blender needed).
Load a GLB into numpy accessors + raw images, cut triangles out of primitives, append meshes / nodes / whole scenes from another GLB
(materials can be re-bound by name onto the base GLB's own), and re-pack every buffer view 4-byte aligned. Sparse accessors are not supported (none are used)."""
import json, struct, copy
import numpy as np
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

class Glb:
    def __init__(s, path=None):
        s.J = None; s.acc = []; s.img = []
        if path: s.load(path)
    def load(s, path):
        d = open(path, 'rb').read(); assert d[:4] == b'glTF'
        jl = struct.unpack('<I', d[12:16])[0]; J = json.loads(d[20:20 + jl]); off = 20 + jl
        B = b''
        if off < len(d): bl = struct.unpack('<I', d[off:off + 4])[0]; B = d[off + 8:off + 8 + bl]
        s.J = J; s.acc = []
        for a in J.get('accessors', []):
            assert 'sparse' not in a
            bv = J['bufferViews'][a['bufferView']]; dt = np.dtype(CT[a['componentType']]); n = NC[a['type']]
            st = bv.get('byteStride', 0) or dt.itemsize * n; o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
            if st == dt.itemsize * n: arr = np.frombuffer(B, dtype=dt, count=a['count'] * n, offset=o).reshape(a['count'], n).copy()
            else:
                raw = np.frombuffer(B, dtype=np.uint8, count=st * (a['count'] - 1) + dt.itemsize * n, offset=o)
                arr = np.stack([np.frombuffer(raw[i * st:i * st + dt.itemsize * n].tobytes(), dtype=dt) for i in range(a['count'])])
            s.acc.append(arr)
        s.img = []
        for im in J.get('images', []):
            bv = J['bufferViews'][im['bufferView']]; o = bv.get('byteOffset', 0); s.img.append(B[o:o + bv['byteLength']])
        return s
    # ---- helpers ----
    def add_acc(s, arr, like=None, ctype=None, typ=None, normalized=None):
        arr = np.ascontiguousarray(arr); a = dict(like) if like else {}
        for k in ('bufferView', 'byteOffset', 'min', 'max', 'sparse'): a.pop(k, None)
        a['componentType'] = ctype or a.get('componentType') or {np.dtype(np.float32): 5126, np.dtype(np.uint32): 5125, np.dtype(np.uint16): 5123, np.dtype(np.uint8): 5121}[arr.dtype]
        a['type'] = typ or a.get('type') or {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4'}[arr.shape[1]]
        if normalized is not None: a['normalized'] = normalized
        a['count'] = int(arr.shape[0]); s.J.setdefault('accessors', []).append(a); s.acc.append(arr.astype(CT[a['componentType']]).reshape(arr.shape[0], -1)); return len(s.acc) - 1
    def tri_centroids_u(s, prim):
        """triangle centroids in the mansion Blender frame (u): bx = gx, by = -gz, bz = gy"""
        P = s.acc[prim['attributes']['POSITION']].astype(np.float64); I = s.acc[prim['indices']].reshape(-1, 3).astype(np.int64)
        c = P[I].mean(axis=1); return np.stack([c[:, 0], -c[:, 2], c[:, 1]], axis=1), I
    def cut(s, prim, keep_mask):
        I = s.acc[prim['indices']].reshape(-1, 3)[keep_mask]
        like = s.J['accessors'][prim['indices']]
        dt = np.uint32 if I.max(initial=0) > 65535 else np.uint16
        prim['indices'] = s.add_acc(I.reshape(-1, 1).astype(dt), like, ctype=5125 if dt == np.uint32 else 5123, typ='SCALAR')
    def mat_index(s, name):
        for i, m in enumerate(s.J.get('materials', [])):
            if m.get('name') == name: return i
        return None
    # ---- import a whole other GLB (meshes, materials, textures, images, samplers, animations); returns {old node idx: new idx}, root list ----
    def append(s, o, mat_by_name=False, drop_images=False):
        J = s.J; OJ = copy.deepcopy(o.J)
        for k in ('nodes', 'meshes', 'materials', 'textures', 'images', 'samplers', 'animations', 'accessors'): J.setdefault(k, [])
        accmap = {}
        def A(i):
            if i not in accmap: accmap[i] = s.add_acc(o.acc[i], OJ['accessors'][i])
            return accmap[i]
        sm = {i: len(J['samplers']) + i for i in range(len(OJ.get('samplers', [])))}; J['samplers'] += OJ.get('samplers', [])
        im0 = len(J['images'])
        for i, im in enumerate(OJ.get('images', [])):
            im = dict(im); im.pop('bufferView', None); J['images'].append(im); s.img.append(o.img[i])
        tx0 = len(J['textures'])
        for t in OJ.get('textures', []):
            t = copy.deepcopy(t)
            if 'source' in t: t['source'] += im0
            for e in t.get('extensions', {}).values():
                if 'source' in e: e['source'] += im0
            if 'sampler' in t: t['sampler'] = sm[t['sampler']]
            J['textures'].append(t)
        for e in OJ.get('extensionsUsed', []):
            if e not in J.setdefault('extensionsUsed', []): J['extensionsUsed'].append(e)
        for e in OJ.get('extensionsRequired', []):
            if e not in J.setdefault('extensionsRequired', []): J['extensionsRequired'].append(e)
        mm = {}
        def fixtex(x):
            if isinstance(x, dict):
                for k, v in x.items():
                    if k == 'index' and isinstance(v, int) and 'texCoord' in x or (k == 'index' and isinstance(v, int)): x[k] = v + tx0
                    else: fixtex(v)
            elif isinstance(x, list):
                for v in x: fixtex(v)
        for i, m in enumerate(OJ.get('materials', [])):
            if mat_by_name and s.mat_index(m.get('name')) is not None: mm[i] = s.mat_index(m['name']); continue
            m = copy.deepcopy(m); fixtex(m); J['materials'].append(m); mm[i] = len(J['materials']) - 1
        me0 = len(J['meshes'])
        for me in OJ.get('meshes', []):
            me = copy.deepcopy(me)
            for p in me['primitives']:
                p['attributes'] = {k: A(v) for k, v in p['attributes'].items()}
                if 'indices' in p: p['indices'] = A(p['indices'])
                if 'material' in p: p['material'] = mm[p['material']]
                if 'targets' in p: p['targets'] = [{k: A(v) for k, v in t.items()} for t in p['targets']]
            J['meshes'].append(me)
        n0 = len(J['nodes'])
        for nd in OJ.get('nodes', []):
            nd = copy.deepcopy(nd)
            if 'mesh' in nd: nd['mesh'] += me0
            if 'children' in nd: nd['children'] = [c + n0 for c in nd['children']]
            J['nodes'].append(nd)
        for an in OJ.get('animations', []):
            an = copy.deepcopy(an)
            for sp in an['samplers']: sp['input'] = A(sp['input']); sp['output'] = A(sp['output'])
            for ch in an['channels']: ch['target']['node'] += n0
            J['animations'].append(an)
        roots = [r + n0 for r in OJ['scenes'][OJ.get('scene', 0)]['nodes']]
        return roots
    def add_node(s, node, parent=None):
        s.J.setdefault('nodes', []).append(node); i = len(s.J['nodes']) - 1
        if parent is None: s.J['scenes'][s.J.get('scene', 0)]['nodes'].append(i)
        else: s.J['nodes'][parent].setdefault('children', []).append(i)
        return i
    def node_index(s, name):
        for i, n in enumerate(s.J['nodes']):
            if n.get('name') == name: return i
        return None
    # ---- repack ----
    def save(s, path):
        J = s.J; live = set()
        for me in J.get('meshes', []):
            for p in me['primitives']:
                live.update(p['attributes'].values())
                if 'indices' in p: live.add(p['indices'])
                for t in p.get('targets', []): live.update(t.values())
        for an in J.get('animations', []):
            for sp in an['samplers']: live.add(sp['input']); live.add(sp['output'])
        for sk in J.get('skins', []):
            if 'inverseBindMatrices' in sk: live.add(sk['inverseBindMatrices'])
        order = sorted(live); remap = {o: i for i, o in enumerate(order)}
        blob = bytearray(); views = []; accs = []
        def push(b, target=None):
            while len(blob) % 4: blob.append(0)
            v = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(b)}
            if target: v['target'] = target
            blob.extend(b); views.append(v); return len(views) - 1
        for o in order:
            a = dict(J['accessors'][o]); arr = s.acc[o]; a.pop('byteOffset', None)
            is_idx = any(p.get('indices') == o for me in J['meshes'] for p in me['primitives'])
            a['bufferView'] = push(arr.astype(CT[a['componentType']]).tobytes(), 34963 if is_idx else (34962 if not any(o in (sp['input'], sp['output']) for an in J.get('animations', []) for sp in an['samplers']) else None))
            a['count'] = int(arr.shape[0])
            if a['type'] != 'SCALAR' or not is_idx:
                pass
            if any(p['attributes'].get('POSITION') == o for me in J['meshes'] for p in me['primitives']):
                a['min'] = [float(v) for v in arr.min(axis=0)]; a['max'] = [float(v) for v in arr.max(axis=0)]
            elif 'min' in J['accessors'][o] and any(o == sp['input'] for an in J.get('animations', []) for sp in an['samplers']):
                a['min'] = [float(v) for v in arr.min(axis=0)]; a['max'] = [float(v) for v in arr.max(axis=0)]
            else: a.pop('min', None); a.pop('max', None)
            accs.append(a)
        for me in J.get('meshes', []):
            for p in me['primitives']:
                p['attributes'] = {k: remap[v] for k, v in p['attributes'].items()}
                if 'indices' in p: p['indices'] = remap[p['indices']]
                if 'targets' in p: p['targets'] = [{k: remap[v] for k, v in t.items()} for t in p['targets']]
        for an in J.get('animations', []):
            for sp in an['samplers']: sp['input'] = remap[sp['input']]; sp['output'] = remap[sp['output']]
        for sk in J.get('skins', []):
            if 'inverseBindMatrices' in sk: sk['inverseBindMatrices'] = remap[sk['inverseBindMatrices']]
        for i, im in enumerate(J.get('images', [])): im['bufferView'] = push(s.img[i])
        while len(blob) % 4: blob.append(0)
        J['accessors'] = accs; J['bufferViews'] = views; J['buffers'] = [{'byteLength': len(blob)}]
        s.acc = [s.acc[o] for o in order]
        if not J.get('images'): J.pop('images', None)
        js = json.dumps(J, separators=(',', ':')).encode()
        while len(js) % 4: js += b' '
        out = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack('<I', len(js)) + b'JSON' + js + struct.pack('<I', len(blob)) + b'BIN\x00' + bytes(blob)
        open(path, 'wb').write(out); return len(out)
    def tris(s, mesh_idx=None):
        t = 0
        for i, me in enumerate(s.J['meshes']):
            if mesh_idx is not None and i != mesh_idx: continue
            for p in me['primitives']: t += s.J['accessors'][p['indices']]['count'] // 3 if 'indices' in p else 0
        return t
