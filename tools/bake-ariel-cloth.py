#!/usr/bin/env python3
"""Bake Ariel's cloth sim over a walk cycle into a preview GLB.

Uses the same model as ui/dm-ariel-cloth.js (voxel-clustered particles at GARMENT res, verlet + PBD
distance constraints, tether to the skinned rest, bone capsules, Earth gravity, sea-level air drag),
runs on the CPU with numpy, and writes the result as per-frame morph targets on the Shirt / Pants
meshes (deltas inverse-skinned into bind space) plus a weights track synced with the walk clip.
usage: python3 tools/bake-ariel-cloth.py [out.glb] [clip]
"""
import json, struct, sys, os, numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(ROOT, 'characterassests')
CHARP = os.path.join(A, 'Meshy_AI_Autumn_biped_Character_output.glb')
ANIMP = os.path.join(A, 'Meshy_AI_Autumn_biped_Meshy_AI_Meshy_Merged_Animations.glb')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'ariel-cloth-walk.glb')
CLIP = sys.argv[2] if len(sys.argv) > 2 else 'Walking_Woman'
GARMENTS = [dict(name='shirt', prefix='Shirt', res=.35, pinY=1.30, hang=.035),
            dict(name='pants', prefix='Pants', res=.30, pinY=0.93, hang=.012)]
CAPS = [('Hips', 'Spine02', .125), ('Spine02', 'Spine01', .12), ('Spine01', 'Spine', .115), ('LeftUpLeg', 'LeftLeg', .075),
        ('RightUpLeg', 'RightLeg', .075), ('LeftLeg', 'LeftFoot', .055), ('RightLeg', 'RightFoot', .055),
        ('LeftArm', 'LeftForeArm', .045), ('RightArm', 'RightForeArm', .045), ('LeftForeArm', 'LeftHand', .038), ('RightForeArm', 'RightHand', .038)]
G = np.array([0, -9.80665, 0]); DRAG = 0.5 * 1.225 * 1.2 / 0.20; FPS = 30; SUB = 4; ITERS = 6
SAMPLE_FPS = 15  # morph target rate (linear weights blend between them)

def load(p):
    f = open(p, 'rb').read(); l = struct.unpack('<I', f[12:16])[0]; j = json.loads(f[20:20 + l]); b = f[20 + l + 8:]
    def acc(i):
        a = j['accessors'][i]; v = j['bufferViews'][a['bufferView']]
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
        dt = {5126: np.float32, 5123: np.uint16, 5121: np.uint8, 5125: np.uint32}[a['componentType']]
        off = v.get('byteOffset', 0) + a.get('byteOffset', 0); st = v.get('byteStride', 0); isz = np.dtype(dt).itemsize * n
        if st and st != isz: raw = np.frombuffer(b, np.uint8, a['count'] * st, off).reshape(-1, st)[:, :isz].copy().view(dt)
        else: raw = np.frombuffer(b, dt, a['count'] * n, off).copy()
        r = raw.reshape(a['count'], n) if n > 1 else raw
        if a.get('normalized') and dt != np.float32: r = r.astype(np.float32) / np.iinfo(dt).max
        return r
    return j, b, acc

def qmat(q):
    x, y, z, w = q
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
def trs(n):
    if 'matrix' in n: return np.array(n['matrix']).reshape(4, 4).T
    M = np.eye(4); R = qmat(n.get('rotation', [0, 0, 0, 1])); M[:3, :3] = R * np.array(n.get('scale', [1, 1, 1])); M[:3, 3] = n.get('translation', [0, 0, 0]); return M

cj, cb, cacc = load(CHARP); aj, ab, aacc = load(ANIMP)
clip = next(a for a in aj['animations'] if a['name'] == CLIP)
name2i = {n['name']: i for i, n in enumerate(cj['nodes']) if 'mesh' not in n}
tracks = []
for ch in clip['channels']:
    s = clip['samplers'][ch['sampler']]; nm = aj['nodes'][ch['target']['node']]['name']
    if nm in name2i: tracks.append((name2i[nm], ch['target']['path'], aacc(s['input']), aacc(s['output'])))
DUR = max(t[2][-1] for t in tracks)
parent = {}
for i, n in enumerate(cj['nodes']):
    for c in n.get('children', []): parent[c] = i
order = []; seen = set()
def visit(i):
    if i in seen: return
    if i in parent: visit(parent[i])
    seen.add(i); order.append(i)
for i in range(len(cj['nodes'])): visit(i)

def pose(t):
    loc = {i: dict(translation=n.get('translation', [0, 0, 0]), rotation=n.get('rotation', [0, 0, 0, 1]), scale=n.get('scale', [1, 1, 1])) for i, n in enumerate(cj['nodes'])}
    for ni, path, T, V in tracks:
        if path not in loc[ni]: continue
        k = int(np.clip(np.searchsorted(T, t) - 1, 0, len(T) - 2)) if len(T) > 1 else 0
        u = 0 if len(T) < 2 else float(np.clip((t - T[k]) / max(1e-9, T[k + 1] - T[k]), 0, 1))
        a = V[k]; b2 = V[min(k + 1, len(V) - 1)]
        if path == 'rotation':
            if np.dot(a, b2) < 0: b2 = -b2
            v = a * (1 - u) + b2 * u; v = v / np.linalg.norm(v)
        else: v = a * (1 - u) + b2 * u
        loc[ni][path] = list(v)
    W = {}
    for i in order:
        n = cj['nodes'][i]; M = trs(n) if 'matrix' in n else trs(loc[i])
        W[i] = W[parent[i]] @ M if i in parent else M
    return W

skin = cj['skins'][0]; joints = skin['joints']; IBM = cacc(skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
jname = {cj['nodes'][j]['name']: k for k, j in enumerate(joints)}

class Garment:
    def __init__(s, cfg, node_i):
        s.cfg = cfg; s.node = node_i; mi = cj['nodes'][node_i]['mesh']; s.mesh = mi; prim = cj['meshes'][mi]['primitives'][0]; s.prim = prim
        P = cacc(prim['attributes']['POSITION']).astype(np.float64); s.P = P; nV = len(P)
        s.J = cacc(prim['attributes']['JOINTS_0']).astype(np.int64); s.Wt = cacc(prim['attributes']['WEIGHTS_0']).astype(np.float64)
        s.Wt /= np.maximum(1e-9, s.Wt.sum(1, keepdims=True))
        idx = cacc(prim['indices']).astype(np.int64).reshape(-1, 3)
        y0 = P[:, 1].min(); pinY = cfg['pinY']; span = max(1e-3, pinY - y0)
        target = max(4, round(nV * cfg['res'])); lo, hi = .001, .2
        for _ in range(22):
            cell = .5 * (lo + hi); keys = np.floor(P / cell).astype(np.int64); u, inv = np.unique(keys, axis=0, return_inverse=True)
            if len(u) > target: lo = cell
            else: hi = cell
        inv = inv.reshape(-1); n = len(u); s.n = n; s.vPart = inv
        cen = np.zeros((n, 3)); np.add.at(cen, inv, P); cnt = np.bincount(inv, minlength=n)[:, None]; cen /= cnt
        d = ((P - cen[inv]) ** 2).sum(1); rep = np.full(n, -1); best = np.full(n, 1e9)
        for v in range(nV):
            p = inv[v]
            if d[v] < best[p]: best[p] = d[v]; rep[p] = v
        s.rep = rep; ht = np.clip((pinY - cen[:, 1]) / span, 0, 1); s.hang = cfg['hang'] * ht; s.free = ht > 0
        s.vW = np.clip((pinY - P[:, 1]) / span * 4, 0, 1)
        e = np.concatenate([idx[:, [0, 1]], idx[:, [1, 2]], idx[:, [2, 0]]]); pe = inv[e]; pe = pe[pe[:, 0] != pe[:, 1]]; pe = np.unique(np.sort(pe, 1), axis=0)
        s.E = pe; s.pos = None
        print(f"[bake] {cfg['name']}: {nV} verts -> {n} particles (res {n/nV:.3f}), {len(pe)} edges")
    def skinmats(s, W):
        Mj = np.stack([W[j] for j in joints]) @ IBM  # (J,4,4)
        return np.einsum('vk,vkab->vab', s.Wt, Mj[s.J])
    def rest(s, W):
        S = s.skinmats(W); r = s.rep; Pr = np.c_[s.P[r], np.ones(len(r))]
        return np.einsum('vab,vb->va', S[r], Pr)[:, :3]
    def step(s, rest, prev_rest, caps, dt, first):
        if first:
            s.pos = rest.copy(); s.prev = rest.copy(); s.L = np.linalg.norm(rest[s.E[:, 0]] - rest[s.E[:, 1]], axis=1); s.rd = None
        for k in range(SUB):
            a = (k + 1) / SUB; R = prev_rest * (1 - a) + rest * a; h = dt / SUB
            v = (s.pos - s.prev); s.prev = s.pos.copy()
            v *= np.exp(-DRAG * h * 0.05)  # drag on the relative motion (scaled; skin-relative, matches JS)
            s.pos = s.pos + v + G * h * h
            s.pos[~s.free] = R[~s.free]
            for _ in range(ITERS):
                d = s.pos[s.E[:, 1]] - s.pos[s.E[:, 0]]; l = np.linalg.norm(d, axis=1) + 1e-9
                c = (0.5 * (l - s.L) / l)[:, None] * d * 0.9; acc = np.zeros_like(s.pos); cnt = np.zeros(len(s.pos))
                np.add.at(acc, s.E[:, 0], c); np.add.at(acc, s.E[:, 1], -c); np.add.at(cnt, s.E[:, 0], 1); np.add.at(cnt, s.E[:, 1], 1)
                s.pos += acc / np.maximum(1, cnt)[:, None] * s.free[:, None]
                for a0, b0, r in caps:  # body capsules: push out to the rest's own depth (never deeper than rest)
                    ab_ = b0 - a0; t = np.clip(((s.pos - a0) @ ab_) / max(1e-9, ab_ @ ab_), 0, 1); q = a0 + t[:, None] * ab_
                    dv = s.pos - q; dl = np.linalg.norm(dv, axis=1) + 1e-9
                    tr = np.clip(((R - a0) @ ab_) / max(1e-9, ab_ @ ab_), 0, 1); rr = np.minimum(r, np.linalg.norm(R - (a0 + tr[:, None] * ab_), axis=1))
                    m = (dl < rr) & s.free; s.pos[m] = q[m] + dv[m] / dl[m, None] * rr[m, None]
                off = s.pos - R; ol = np.linalg.norm(off, axis=1) + 1e-9; m = ol > s.hang
                s.pos[m] = R[m] + off[m] / ol[m, None] * s.hang[m, None]
        return s.pos - rest

gar = []
for cfg in GARMENTS:
    ni = next(i for i, n in enumerate(cj['nodes']) if 'mesh' in n and cj['meshes'][n['mesh']]['name'].startswith(cfg['prefix']))
    gar.append(Garment(cfg, ni))

def caps_at(W):
    out = []
    for a, b2, r in CAPS:
        if a in name2i and b2 in name2i: out.append((W[name2i[a]][:3, 3], W[name2i[b2]][:3, 3], r))
    return out

# settle 2 loops of the clip, record the 3rd
nF = int(round(DUR * FPS)); dt = 1 / FPS; frames = {g.cfg['name']: [] for g in gar}
W0 = pose(0); prev = {g.cfg['name']: g.rest(W0) for g in gar}; first = True
# initial drape: 120 static steps (settled drape = default pose)
for _ in range(120):
    for g in gar: g.step(prev[g.cfg['name']], prev[g.cfg['name']], caps_at(W0), dt, first)
    first = False
samp_every = FPS // SAMPLE_FPS
for loop in range(3):
    for f in range(nF):
        t = f / FPS; W = pose(t); C = caps_at(W)
        for g in gar:
            r = g.rest(W); off = g.step(r, prev[g.cfg['name']], C, dt, False); prev[g.cfg['name']] = r
            if loop == 2 and f % samp_every == 0:
                S = g.skinmats(W); Sinv = np.linalg.inv(S[:, :3, :3])
                dv = off[g.vPart] * g.vW[:, None]; frames[g.cfg['name']].append(np.einsum('vab,vb->va', Sinv, dv).astype(np.float32))
    print(f'[bake] loop {loop+1}/3 done')

# ---- write GLB: character + clip (remapped) + morph targets + weights track
bin_ = bytearray(cb); J = cj
def add(arr, typ, comp=5126, mm=False):
    arr = np.ascontiguousarray(arr); pad = (-len(bin_)) % 4; bin_.extend(b'\0' * pad); off = len(bin_); bin_.extend(arr.tobytes())
    J['bufferViews'].append(dict(buffer=0, byteOffset=off, byteLength=arr.nbytes)); a = dict(bufferView=len(J['bufferViews']) - 1, componentType=comp, count=len(arr), type=typ)
    if mm: a['min'] = arr.reshape(len(arr), -1).min(0).tolist(); a['max'] = arr.reshape(len(arr), -1).max(0).tolist()
    J['accessors'].append(a); return len(J['accessors']) - 1
anim = dict(name=CLIP + '_cloth', samplers=[], channels=[])
for ch in clip['channels']:
    s = clip['samplers'][ch['sampler']]; nm = aj['nodes'][ch['target']['node']]['name']
    if nm not in name2i: continue
    ti = add(aacc(s['input']).astype(np.float32), 'SCALAR', mm=True); vo = aacc(s['output']).astype(np.float32)
    oi = add(vo, {1: 'SCALAR', 3: 'VEC3', 4: 'VEC4'}[vo.shape[1] if vo.ndim > 1 else 1])
    anim['samplers'].append(dict(input=ti, output=oi, interpolation=s.get('interpolation', 'LINEAR'))); anim['channels'].append(dict(sampler=len(anim['samplers']) - 1, target=dict(node=name2i[nm], path=ch['target']['path'])))
for g in gar:
    fr = frames[g.cfg['name']]; nT = len(fr); m = J['meshes'][g.mesh]
    for p in m['primitives']: p['targets'] = [dict(POSITION=add(d, 'VEC3', mm=True)) for d in fr]
    m['weights'] = [0.0] * nT; m.setdefault('extras', {})['targetNames'] = [f'cloth_{i}' for i in range(nT)]
    times = np.arange(nT + 1, dtype=np.float32) / SAMPLE_FPS; times[-1] = min(times[-1], DUR); W_ = np.zeros((nT + 1, nT), np.float32)
    for i in range(nT): W_[i, i] = 1
    W_[nT, 0] = 1
    anim['samplers'].append(dict(input=add(times, 'SCALAR', mm=True), output=add(W_.reshape(-1), 'SCALAR'), interpolation='LINEAR'))
    anim['channels'].append(dict(sampler=len(anim['samplers']) - 1, target=dict(node=g.node, path='weights')))
J['animations'] = [anim]; J['buffers'] = [dict(byteLength=len(bin_))]
J.setdefault('asset', {})['generator'] = 'dartmeadow tools/bake-ariel-cloth.py'
js = json.dumps(J, separators=(',', ':')).encode(); js += b' ' * ((-len(js)) % 4); bin_.extend(b'\0' * ((-len(bin_)) % 4))
with open(OUT, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_))); f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js); f.write(struct.pack('<II', len(bin_), 0x004E4942)); f.write(bin_)
print('[bake] wrote', OUT, os.path.getsize(OUT) // 1024, 'KB', {k: len(v) for k, v in frames.items()}, 'targets, clip', round(DUR, 3), 's')
