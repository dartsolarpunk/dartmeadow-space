# Rewrite TEXCOORD_0 + TANGENT of the Bird Temple EXTERIOR primitives IN PLACE (same accessors, same byte ranges).
# Geometry (POSITION/indices/colors), node names, transforms, counts are untouched; the file size does not change.
# UVs: per-vertex box projection in model space at a per-section texel density (each section = its own 2K texture set,
# a UDIM-style split: hull / temple / altar / trim). The old TEXCOORD_0 was degenerate (zero UV area) and unused.
import json, struct, sys, numpy as np
SRC, DST = sys.argv[1], sys.argv[2]
SECTION = {'hull': ['Hull', 'Ballroom', 'Upper Lounge', 'Lower lounge', 'Hull window', 'Box', 'deck'],
           'temple': ['Temple', 'Starboard obulisque', 'Port Obulisque', 'Obulisque', 'Lower maze', 'Upper maze', 'Bird Shard'],
           'altar': ['Altar', 'Gods', 'Altar Realm', 'House Angels', 'Angels', 'Human halo', 'Bird Shard halo'],
           'trim': ['Staff stuck', 'Staff amulet ring', 'Staff amulet triangle', 'Staff amulet', 'Staff base', 'dart', 'ornament', 'staff']}
TILE = {'hull': 10.0, 'temple': 6.0, 'altar': 2.5, 'trim': 1.0}   # world units (GLB root space) per texture repeat
SEC = {n: s for s, ns in SECTION.items() for n in ns}
b = bytearray(open(SRC, 'rb').read()); jl = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + jl]); B0 = 20 + jl + 8
CT = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
def loc(i):
    a = j['accessors'][i]; v = j['bufferViews'][a['bufferView']]; dt = np.dtype(CT[a['componentType']]); k = NC[a['type']]
    return B0 + v.get('byteOffset', 0) + a.get('byteOffset', 0), v.get('byteStride', 0) or k * dt.itemsize, dt, k, a['count']
def rd(i):
    o, st, dt, k, n = loc(i); raw = np.frombuffer(bytes(b[o:o + st * (n - 1) + k * dt.itemsize]), np.uint8)
    raw = np.pad(raw, (0, st * n - raw.size)).reshape(n, st)[:, :k * dt.itemsize]; return raw.copy().view(dt).reshape(n, k)
def wr(i, arr):
    o, st, dt, k, n = loc(i); assert dt == np.float32 and arr.shape == (n, k)
    for r in range(n): b[o + r * st:o + r * st + 4 * k] = arr[r].astype(np.float32).tobytes()
def mat(nd):
    if 'matrix' in nd: return np.array(nd['matrix']).reshape(4, 4).T
    t = nd.get('translation', [0, 0, 0]); r = nd.get('rotation', [0, 0, 0, 1]); s = nd.get('scale', [1, 1, 1]); x, y, z, w = r
    R = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    M = np.eye(4); M[:3, :3] = R * s; M[:3, 3] = t; return M
world = {}
def walk(i, P):
    M = P @ mat(j['nodes'][i]); world[i] = M
    for c in j['nodes'][i].get('children', []): walk(c, M)
for r in j['scenes'][j.get('scene', 0)]['nodes']: walk(r, np.eye(4))
jobs = {}   # POSITION accessor -> dict(sec, scale, tris[], uv set, tan set)
for ni, nd in enumerate(j['nodes']):
    if 'mesh' not in nd: continue
    sec = SEC.get(nd.get('name')); 
    if not sec: continue
    sc = float(np.cbrt(abs(np.linalg.det(world[ni][:3, :3]))))
    for p in j['meshes'][nd['mesh']]['primitives']:
        A = p['attributes']
        if 'TEXCOORD_0' not in A or 'TANGENT' not in A: continue
        J = jobs.setdefault(A['POSITION'], dict(sec=sec, sc=sc, tris=[], uv=set(), tan=set(), node=nd['name']))
        J['tris'].append(rd(p['indices']).reshape(-1, 3) if 'indices' in p else np.arange(j['accessors'][A['POSITION']]['count']).reshape(-1, 3))
        J['uv'].add(A['TEXCOORD_0']); J['tan'].add(A['TANGENT'])
# an accessor shared between sections would get one projection; check none is
for pa, J in jobs.items():
    P = rd(pa).astype(np.float64); T = np.concatenate(J['tris']).astype(np.int64)
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    vn = np.zeros_like(P)
    for c in range(3): np.add.at(vn, T[:, c], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    ax = np.argmax(np.abs(vn), axis=1); sg = np.sign(vn[np.arange(len(P)), ax]); sg[sg == 0] = 1
    k = J['sc'] / TILE[J['sec']]
    # box projection: X-faces (z,y), Y-faces (x,z), Z-faces (x,y); mirrored by facing sign so the print is not reversed
    u = np.where(ax == 0, -sg * P[:, 2], np.where(ax == 1, P[:, 0], sg * P[:, 0]))
    v = np.where(ax == 0, -P[:, 1], np.where(ax == 1, -sg * P[:, 2], -P[:, 1]))
    UV = np.stack([u, v], 1) * k
    # tangents (per-triangle dP/du accumulated, Gram-Schmidt vs the smooth normal, handedness in w)
    e1 = P[T[:, 1]] - P[T[:, 0]]; e2 = P[T[:, 2]] - P[T[:, 0]]; d1 = UV[T[:, 1]] - UV[T[:, 0]]; d2 = UV[T[:, 2]] - UV[T[:, 0]]
    det = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]; ok = np.abs(det) > 1e-14; r = np.where(ok, 1 / np.where(ok, det, 1), 0)[:, None]
    tf = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) * r; bf = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) * r
    tv = np.zeros_like(P); bv = np.zeros_like(P)
    for c in range(3): np.add.at(tv, T[:, c], tf); np.add.at(bv, T[:, c], bf)
    tv -= vn * np.sum(vn * tv, 1, keepdims=True); bad = np.linalg.norm(tv, axis=1) < 1e-12
    fb = np.where(np.abs(vn[:, 0:1]) < 0.9, np.array([[1., 0, 0]]), np.array([[0., 1, 0]])); fb -= vn * np.sum(vn * fb, 1, keepdims=True)
    tv[bad] = fb[bad]; tv /= np.maximum(np.linalg.norm(tv, axis=1, keepdims=True), 1e-12)
    w = np.where(np.sum(np.cross(vn, tv) * bv, 1) < 0, -1.0, 1.0)
    for a in J['uv']: wr(a, UV)
    for a in J['tan']: wr(a, np.c_[tv, w])
    for a in J['uv']:
        acc = j['accessors'][a]
        if 'min' in acc: acc['min'] = UV.min(0).tolist(); acc['max'] = UV.max(0).tolist()
    print(J['node'], J['sec'], len(P), 'verts  uv span', np.ptp(UV, 0).round(1))
# JSON chunk: only accessor min/max may change -> re-pad to the same length so every byte offset stays put
js = json.dumps(j, separators=(',', ':')).encode()
assert len(js) <= jl, (len(js), jl)
b[20:20 + jl] = js + b' ' * (jl - len(js))
open(DST, 'wb').write(b)
