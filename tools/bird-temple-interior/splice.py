#!/usr/bin/env python3
"""Graft interior_parts.glb into a COPY of the original Bird Temple.glb at the glTF level.

 * the original geometry, vertex colours, materials and node transforms are carried over byte-for-byte
   (a Blender round trip would drop the Nomad COLOR_0/COLOR_1 vertex colours the ship is painted with)
 * the Hull's top deck is cut open where the hatch is (triangles are split along the hole edge, attributes interpolated)
 * the new interior nodes become children of the 'Bird Temple' node, named BTI_* / IX_* / LIGHT_*
usage: splice.py original.glb interior_parts.glb out.glb
"""
import json, struct, sys, copy
import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT2': 4, 'MAT3': 9, 'MAT4': 16}

# hatch hole in Blender world coordinates (Z-up). Keep in sync with build_interior.py
HOLE_X = (-6.0, 2.0)
HOLE_Y = (111.2, 120.0)
DECK_Z = 0.5


def read_glb(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'glTF'
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack('<I', b[off:off + 4])[0]
    binc = b[off + 8:off + 8 + bl]
    return j, bytearray(binc)


def write_glb(path, j, binc):
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    binc = bytes(binc) + b'\0' * ((4 - len(binc) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binc)
    with open(path, 'wb') as f:
        f.write(b'glTF' + struct.pack('<II', 2, total))
        f.write(struct.pack('<I', len(js)) + b'JSON' + js)
        f.write(struct.pack('<I', len(binc)) + b'BIN\0' + binc)


def read_acc(j, binc, ai):
    a = j['accessors'][ai]
    bv = j['bufferViews'][a['bufferView']]
    dt = np.dtype(CT[a['componentType']]); n = NC[a['type']]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or dt.itemsize * n
    cnt = a['count']
    if stride == dt.itemsize * n:
        arr = np.frombuffer(binc, dtype=dt, count=cnt * n, offset=base).reshape(cnt, n).copy()
    else:
        arr = np.zeros((cnt, n), dt)
        for i in range(cnt):
            arr[i] = np.frombuffer(binc, dtype=dt, count=n, offset=base + i * stride)
    return arr


def add_acc(j, binc, arr, comp_type, typ, target, normalized=False, minmax=False):
    while len(binc) % 4: binc.append(0)
    off = len(binc)
    data = np.ascontiguousarray(arr.astype(CT[comp_type])).tobytes()
    binc += data
    j['bufferViews'].append(dict(buffer=0, byteOffset=off, byteLength=len(data), target=target))
    acc = dict(bufferView=len(j['bufferViews']) - 1, componentType=comp_type, count=int(arr.shape[0]), type=typ)
    if normalized: acc['normalized'] = True
    if minmax:
        acc['min'] = [float(x) for x in arr.min(axis=0)]; acc['max'] = [float(x) for x in arr.max(axis=0)]
    j['accessors'].append(acc)
    return len(j['accessors']) - 1


# ───────────────────────── hull cut ─────────────────────────
def node_matrix(n):
    if 'matrix' in n:
        return np.array(n['matrix'], float).reshape(4, 4).T
    M = np.eye(4)
    s = n.get('scale', [1, 1, 1]); t = n.get('translation', [0, 0, 0])
    M[0, 0], M[1, 1], M[2, 2] = s
    M[:3, 3] = t
    return M


def split_poly(poly, axis, val):
    """poly: list of (vertex vectors). Returns (low_polys, high_polys) split on coordinate[axis]==val where axis indexes pos."""
    low, high = [], []
    n = len(poly)
    lo_pts, hi_pts = [], []
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        da, db = a[axis] - val, b[axis] - val
        if da <= 0: lo_pts.append(a)
        if da >= 0: hi_pts.append(a)
        if (da < 0 < db) or (db < 0 < da):
            t = da / (da - db)
            c = a + (b - a) * t
            lo_pts.append(c); hi_pts.append(c)
    return lo_pts, hi_pts


def fan(poly):
    return [[poly[0], poly[i], poly[i + 1]] for i in range(1, len(poly) - 1)] if len(poly) >= 3 else []


def area2(t):
    a, b, c = t
    return np.linalg.norm(np.cross(b[:3] - a[:3], c[:3] - a[:3]))


def cut_hull(j, binc, hull_node_index, node0_T):
    hull = j['nodes'][hull_node_index]
    M = node_matrix(hull)
    # Blender world (xb,yb,zb) -> glTF world (xb, zb, -yb) -> node0-local (-T) -> hull-local (M^-1)
    def to_local(xb, yb, zb):
        w = np.array([xb, zb, -yb]) - node0_T
        return (np.linalg.inv(M) @ np.append(w, 1))[:3]
    p0 = to_local(HOLE_X[0], HOLE_Y[0], DECK_Z); p1 = to_local(HOLE_X[1], HOLE_Y[1], DECK_Z)
    x0, x1 = sorted([p0[0], p1[0]]); z0, z1 = sorted([p0[2], p1[2]])
    ytop = p0[1]
    print('hull-local hole x[%.3f,%.3f] z[%.3f,%.3f] deck y=%.3f' % (x0, x1, z0, z1, ytop))
    mesh = j['meshes'][hull['mesh']]
    removed_total = 0; split_total = 0
    for prim in mesh['primitives']:
        attrs = {k: read_acc(j, binc, v) for k, v in prim['attributes'].items()}
        meta = {k: j['accessors'][v] for k, v in prim['attributes'].items()}
        P = attrs['POSITION'].astype(np.float64)
        idx = read_acc(j, binc, prim['indices']).reshape(-1) if 'indices' in prim else np.arange(len(P))
        tris = idx.reshape(-1, 3)
        # candidate triangles: overlap hole bbox in xz and (nearly) on the deck plane
        tx = P[tris][:, :, 0]; tz = P[tris][:, :, 2]; ty = P[tris][:, :, 1]
        cand = (tx.max(1) > x0) & (tx.min(1) < x1) & (tz.max(1) > z0) & (tz.min(1) < z1) & (np.abs(ty - ytop).max(1) < 0.2)
        ci = np.where(cand)[0]
        if len(ci) == 0:
            continue
        # unify attributes into one float vector per vertex for interpolation
        order = ['POSITION'] + [k for k in attrs.keys() if k != 'POSITION']   # POSITION must be columns 0-2 for the plane splits
        widths = [attrs[k].shape[1] for k in order]
        def norm(k):
            a = attrs[k].astype(np.float64)
            m = meta[k]
            if m.get('normalized'):
                a = a / float(np.iinfo(CT[m['componentType']]).max)
            return a
        V = np.concatenate([norm(k) for k in order], axis=1)
        new_V = [V]; nv = len(V)
        out_tris = [tris[i] for i in range(len(tris)) if not cand[i]]
        extra = []
        for i in ci:
            tri = [V[tris[i][0]], V[tris[i][1]], V[tris[i][2]]]
            pieces = []
            rest = [tri]
            for axis, lo, hi in ((0, x0, x1), (2, z0, z1)):
                nxt = []
                for poly in rest:
                    l, h = split_poly(poly, axis, lo)     # below lo: keep
                    pieces += fan(l) if len(l) >= 3 else []
                    m_, r = split_poly(h, axis, hi) if len(h) >= 3 else ([], [])
                    pieces += fan(r) if len(r) >= 3 else []   # above hi: keep
                    nxt.append(m_) if len(m_) >= 3 else None
                rest = nxt
            # `rest` = inside the hole -> discarded
            pieces = [p for p in pieces if area2(p) > 1e-9]
            removed_total += 1; split_total += len(pieces)
            for t in pieces:
                ids = []
                for v in t:
                    extra.append(v); ids.append(nv + len(extra) - 1)
                out_tris.append(np.array(ids))
        if extra:
            V = np.concatenate([V, np.array(extra)], axis=0)
        out_idx = np.array(out_tris, dtype=np.int64).reshape(-1)
        # write back attributes
        col = 0
        newattrs = {}
        for k, w in zip(order, widths):
            a = V[:, col:col + w]; col += w
            m = meta[k]
            if m.get('normalized'):
                a = np.round(a * float(np.iinfo(CT[m['componentType']]).max))
            newattrs[k] = (a, m)
        for k, (a, m) in newattrs.items():
            ai = add_acc(j, binc, a, m['componentType'], m['type'], 34962, m.get('normalized', False), minmax=(k == 'POSITION'))
            prim['attributes'][k] = ai
        ct = 5125 if len(V) > 65535 else 5123
        prim['indices'] = add_acc(j, binc, out_idx.reshape(-1, 1), ct, 'SCALAR', 34963)
        print('  prim: cut %d triangles into %d, verts %d -> %d' % (len(ci), split_total, nv, len(V)))
    return removed_total


# ───────────────────────── merge interior ─────────────────────────
def remap_tex(o, base_tex):
    if isinstance(o, dict):
        for k, v in list(o.items()):
            if k == 'index' and isinstance(v, int):
                o[k] = v + base_tex
            else:
                remap_tex(v, base_tex)
    elif isinstance(o, list):
        for v in o: remap_tex(v, base_tex)


def merge(j, binc, j2, bin2, node0_index, node0_T):
    nA, nBV, nM, nMat, nT, nI, nS, nN = (len(j.get(k, [])) for k in ['accessors', 'bufferViews', 'meshes', 'materials', 'textures', 'images', 'samplers', 'nodes'])
    while len(binc) % 4: binc.append(0)
    boff = len(binc)
    binc += bin2
    for bv in j2.get('bufferViews', []):
        bv = copy.deepcopy(bv); bv['byteOffset'] = bv.get('byteOffset', 0) + boff; bv['buffer'] = 0
        j['bufferViews'].append(bv)
    for a in j2.get('accessors', []):
        a = copy.deepcopy(a)
        if 'bufferView' in a: a['bufferView'] += nBV
        j['accessors'].append(a)
    for s in j2.get('samplers', []): j.setdefault('samplers', []).append(copy.deepcopy(s))
    for im in j2.get('images', []):
        im = copy.deepcopy(im)
        if 'bufferView' in im: im['bufferView'] += nBV
        j.setdefault('images', []).append(im)
    for t in j2.get('textures', []):
        t = copy.deepcopy(t)
        if 'source' in t: t['source'] += nI
        if 'sampler' in t: t['sampler'] += nS
        j.setdefault('textures', []).append(t)
    for m in j2.get('materials', []):
        m = copy.deepcopy(m); remap_tex(m, nT); j['materials'].append(m)
    for me in j2.get('meshes', []):
        me = copy.deepcopy(me)
        for p in me['primitives']:
            p['attributes'] = {k: v + nA for k, v in p['attributes'].items()}
            if 'indices' in p: p['indices'] += nA
            if 'material' in p: p['material'] += nMat
        j['meshes'].append(me)
    new_nodes = copy.deepcopy(j2['nodes'])
    for n in new_nodes:
        if 'mesh' in n: n['mesh'] += nM
        if 'children' in n: n['children'] = [c + nN for c in n['children']]
    j['nodes'] += new_nodes
    roots = [r + nN for r in j2['scenes'][j2.get('scene', 0)]['nodes']]
    for r in roots:
        n = j['nodes'][r]
        # the interior was authored in glTF world coords; node 0 carries translation T, so subtract it
        if 'matrix' in n:
            m = np.array(n['matrix'], float).reshape(4, 4).T; m[:3, 3] -= node0_T
            n['matrix'] = [float(x) for x in m.T.reshape(-1)]
        else:
            t = np.array(n.get('translation', [0, 0, 0]), float) - node0_T
            n['translation'] = [float(x) for x in t]
    j['nodes'][node0_index].setdefault('children', []).extend(roots)
    ext = set(j.get('extensionsUsed', [])) | set(j2.get('extensionsUsed', []))
    if ext: j['extensionsUsed'] = sorted(ext)
    return roots


def compact(j, binc):
    """drop unreferenced buffer bytes (the Hull's pre-cut arrays)"""
    used_acc = set()
    for m in j['meshes']:
        for p in m['primitives']:
            used_acc |= set(p['attributes'].values())
            if 'indices' in p: used_acc.add(p['indices'])
            for t in p.get('targets', []): used_acc |= set(t.values())
    for s in j.get('skins', []):
        if 'inverseBindMatrices' in s: used_acc.add(s['inverseBindMatrices'])
    for a in j.get('animations', []):
        for sm in a['samplers']: used_acc |= {sm['input'], sm['output']}
    used_bv = {j['accessors'][i]['bufferView'] for i in used_acc if 'bufferView' in j['accessors'][i]}
    used_bv |= {im['bufferView'] for im in j.get('images', []) if 'bufferView' in im}
    newbin = bytearray(); remap = {}
    new_bvs = []
    for i, bv in enumerate(j['bufferViews']):
        if i not in used_bv: continue
        while len(newbin) % 4: newbin.append(0)
        off = len(newbin)
        newbin += binc[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        nb = dict(bv); nb['byteOffset'] = off; remap[i] = len(new_bvs); new_bvs.append(nb)
    j['bufferViews'] = new_bvs
    # keep all accessors (indices stable) but point unused ones at nothing: simplest is to drop them and remap
    acc_remap = {}; new_acc = []
    for i, a in enumerate(j['accessors']):
        if i not in used_acc: continue
        na = dict(a)
        if 'bufferView' in na: na['bufferView'] = remap[na['bufferView']]
        acc_remap[i] = len(new_acc); new_acc.append(na)
    j['accessors'] = new_acc
    for m in j['meshes']:
        for p in m['primitives']:
            p['attributes'] = {k: acc_remap[v] for k, v in p['attributes'].items()}
            if 'indices' in p: p['indices'] = acc_remap[p['indices']]
    for im in j.get('images', []):
        if 'bufferView' in im: im['bufferView'] = remap[im['bufferView']]
    j['buffers'] = [dict(byteLength=len(newbin))]
    return newbin


def main(orig, interior, out):
    j, binc = read_glb(orig)
    j2, bin2 = read_glb(interior)
    names = [n.get('name') for n in j['nodes']]
    n0 = names.index('Bird Temple'); T = np.array(node_matrix(j['nodes'][n0])[:3, 3])
    print('Bird Temple node translation', T)
    hi = names.index('Hull')
    r = cut_hull(j, binc, hi, T)
    print('hull triangles split by the hatch hole:', r)
    roots = merge(j, binc, j2, bin2, n0, T)
    newbin = compact(j, binc)
    j['asset'] = dict(j.get('asset', {}), generator='nomad 11 + bird-temple-interior splice (Claude)', version='2.0')
    write_glb(out, j, newbin)
    print('wrote', out, 'bytes', len(newbin))


if __name__ == '__main__':
    main(*sys.argv[1:4])
