#!/usr/bin/env python3
"""measure_density.py GLB [--height-m H] [--match REGEX] [--node REGEX]
Offline texel-density / tessellation census of a GLB (no Blender): per material, triangle count, world surface area, median edge
length (m), and base-colour texel density px/m = sqrt(UV-area x texW x texH / world-area) using TEXCOORD_0 and the material's
KHR_texture_transform-free UVs. --height-m rescales the asset so its bounding-box height is H metres (characters exported in
arbitrary units). Node transforms are applied (TRS / matrix); skinning is ignored (bind pose).
Used for the JOTS Cliffs comparison (cliff rock vs Ariel vs the mansion's non-rock materials)."""
import sys, json, struct, re, io
import numpy as np
from PIL import Image
a = sys.argv[1:]; src = a[0]
H = float(a[a.index('--height-m') + 1]) if '--height-m' in a else None
MATCH = re.compile(a[a.index('--match') + 1]) if '--match' in a else None
NODE = re.compile(a[a.index('--node') + 1]) if '--node' in a else None
d = open(src, 'rb').read(); jl = struct.unpack('<I', d[12:16])[0]; J = json.loads(d[20:20 + jl]); bo = 20 + jl + 8
CT = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8, 5122: np.int16, 5120: np.int8}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
def acc(i):
    A = J['accessors'][i]; bv = J['bufferViews'][A['bufferView']]; dt = np.dtype(CT[A['componentType']]); n = NC[A['type']]
    off = bo + bv.get('byteOffset', 0) + A.get('byteOffset', 0); st = bv.get('byteStride', dt.itemsize * n)
    raw = np.frombuffer(d, np.uint8, count=(A['count'] - 1) * st + dt.itemsize * n, offset=off)
    out = np.lib.stride_tricks.as_strided(raw, shape=(A['count'], dt.itemsize * n), strides=(st, 1)).copy().view(dt).reshape(A['count'], n)
    if A.get('normalized'): out = out.astype(np.float32) / np.iinfo(dt).max
    return out.astype(np.float64)
def local(n):
    if 'matrix' in n: return np.array(n['matrix']).reshape(4, 4).T
    t = n.get('translation', [0, 0, 0]); x, y, z, w = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4); M[:3, :3] = R * np.array(s)[None, :]; M[:3, 3] = t; return M
imsz = {}
def texsize(ti):
    if ti in imsz: return imsz[ti]
    T_ = J['textures'][ti]; src_ = T_.get('source', next((v.get('source') for v in T_.get('extensions', {}).values() if 'source' in v), None)); im = J['images'][src_]; bv = J['bufferViews'][im['bufferView']]
    b = d[bo + bv.get('byteOffset', 0): bo + bv.get('byteOffset', 0) + bv['byteLength']]
    imsz[ti] = Image.open(io.BytesIO(b)).size; return imsz[ti]
rows = {}
allP = []
def walk(i, M, path):
    n = J['nodes'][i]; M = M @ local(n); nm = n.get('name', ''); path = path + '/' + nm
    if 'mesh' in n and (NODE is None or NODE.search(path)):
        for p in J['meshes'][n['mesh']]['primitives']:
            mat = J['materials'][p['material']] if 'material' in p else {'name': '?'}; mn = mat.get('name', '?')
            if MATCH and not MATCH.search(mn): continue
            P = acc(p['attributes']['POSITION']); P = (np.c_[P, np.ones(len(P))] @ M.T)[:, :3]; allP.append(P)
            I = acc(p['indices']).astype(np.int64).reshape(-1, 3) if 'indices' in p else np.arange(len(P)).reshape(-1, 3)
            uv = acc(p['attributes']['TEXCOORD_0']) if 'TEXCOORD_0' in p['attributes'] else None
            bc = mat.get('pbrMetallicRoughness', {}).get('baseColorTexture'); tw = th = 0
            if bc: tw, th = texsize(bc['index'])
            r = rows.setdefault((path.split('/')[1] if NODE else '', mn), dict(tris=0, area=0.0, uva=0.0, edges=[], tex=(tw, th)))
            A_, B_, C_ = P[I[:, 0]], P[I[:, 1]], P[I[:, 2]]
            r['tris'] += len(I); r['area'] += 0.5 * np.linalg.norm(np.cross(B_ - A_, C_ - A_), axis=1).sum()
            r['edges'].append(np.linalg.norm(B_ - A_, axis=1)); r['edges'].append(np.linalg.norm(C_ - B_, axis=1))
            if uv is not None:
                a_, b_, c_ = uv[I[:, 0]], uv[I[:, 1]], uv[I[:, 2]]
                r['uva'] += 0.5 * np.abs((b_[:, 0] - a_[:, 0]) * (c_[:, 1] - a_[:, 1]) - (c_[:, 0] - a_[:, 0]) * (b_[:, 1] - a_[:, 1])).sum()
    for c in n.get('children', []): walk(c, M, path)
for s in J['scenes'][J.get('scene', 0)]['nodes']: walk(s, np.eye(4), '')
k = 1.0
if H and allP:
    Pa = np.vstack(allP); k = H / (Pa[:, 1].max() - Pa[:, 1].min())
print(f'{src}  scale {k:.4f}' + (f' (bbox height -> {H} m)' if H else ''))
print(f"{'node':14s} {'material':22s} {'tris':>8s} {'area m2':>10s} {'med edge m':>10s} {'tex':>10s} {'px/m':>7s}")
for (nd, mn), r in sorted(rows.items()):
    e = np.median(np.concatenate(r['edges'])) * k if r['edges'] else 0; area = r['area'] * k * k
    pxm = np.sqrt(r['uva'] * r['tex'][0] * r['tex'][1] / area) if area > 0 and r['tex'][0] else 0
    print(f"{nd[:14]:14s} {mn[:22]:22s} {r['tris']:8d} {area:10.1f} {e:10.3f} {str(r['tex'][0])+'x'+str(r['tex'][1]):>10s} {pxm:7.0f}")
