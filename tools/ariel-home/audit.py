# interpenetration audit: weld -> islands -> BVH overlap pairs between different islands
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
def audit(b, mats, path, skip_tags=('rock',), top=60):
    V = np.array(b.v); F = b.f; M = b.m
    # weld by rounding
    key = {}; remap = []
    for p in V:
        k = tuple(np.round(p, 3)); remap.append(key.setdefault(k, len(key)))
    parent = list(range(len(key)))
    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    F2 = [tuple(remap[i] for i in f) for f in F]
    for f in F2:
        a = find(f[0])
        for i in f[1:]:
            c = find(i)
            if c != a: parent[c] = a
    isl = np.array([find(f[0]) for f in F2])
    verts = np.zeros((len(key), 3))
    for i, r in enumerate(remap): verts[r] = V[i]
    bv = BVHTree.FromPolygons([Vector(v) for v in verts], F2)
    ov = bv.overlap(bv)
    from collections import Counter
    pairs = Counter()
    def tri(i): return verts[list(F2[i])]
    def side(T, n, d0, eps=0.01):
        s = (T - T[0] if False else T) @ n - d0
        return (s > eps).any() and (s < -eps).any()
    def crosses(Ta, Tb):
        na = np.cross(Ta[1] - Ta[0], Ta[2] - Ta[0]); la = np.linalg.norm(na)
        nb = np.cross(Tb[1] - Tb[0], Tb[2] - Tb[0]); lb = np.linalg.norm(nb)
        if la < 1e-9 or lb < 1e-9: return False
        na /= la; nb /= lb
        if not side(Tb, na, float(Ta[0] @ na)) or not side(Ta, nb, float(Tb[0] @ nb)): return False
        # overlap of the two intervals on the intersection line
        d = np.cross(na, nb); dl = np.linalg.norm(d)
        if dl < 1e-6: return False
        d /= dl
        def interval(T, n, d0):
            s = T @ n - d0; pr = T @ d; pts = []
            for i in range(3):
                j = (i + 1) % 3
                if (s[i] > 0) != (s[j] > 0) and abs(s[i] - s[j]) > 1e-12: pts.append(pr[i] + (pr[j] - pr[i]) * s[i] / (s[i] - s[j]))
            return (min(pts), max(pts)) if len(pts) >= 2 else None
        ia_ = interval(Ta, nb, float(Tb[0] @ nb)); ib_ = interval(Tb, na, float(Ta[0] @ na))
        if ia_ is None or ib_ is None: return False
        return min(ia_[1], ib_[1]) - max(ia_[0], ib_[0]) > 0.02
    for a, c in ov:
        ia, ic = isl[a], isl[c]
        if ia == ic: continue
        if mats[M[a]] == 'leaf' and mats[M[c]] == 'leaf': continue
        if not crosses(tri(a), tri(c)): continue
        pairs[(min(ia, ic), max(ia, ic))] += 1
    info = {}
    for fi, i in enumerate(isl):
        d = info.setdefault(i, dict(n=0, lo=np.full(3, 1e9), hi=np.full(3, -1e9), mats=Counter()))
        d['n'] += 1; P = verts[list(F2[fi])]; d['lo'] = np.minimum(d['lo'], P.min(0)); d['hi'] = np.maximum(d['hi'], P.max(0)); d['mats'][mats[M[fi]]] += 1
    def desc(i):
        d = info[i]; return f"[{d['mats'].most_common(1)[0][0]} n={d['n']} x{d['lo'][0]:.0f}..{d['hi'][0]:.0f} y{d['lo'][1]:.0f}..{d['hi'][1]:.0f} z{d['lo'][2]:.0f}..{d['hi'][2]:.0f}]"
    out = []
    for (a, c), n in sorted(pairs.items(), key=lambda kv: -kv[1]):
        if info[a]['n'] > 5000 or info[c]['n'] > 5000: tag = 'ROCK'
        else: tag = ''
        out.append(f"{n:5d} {tag:4s} {desc(a)}  X  {desc(c)}")
    open(path, 'w').write(f"islands={len(info)} pairs={len(pairs)}\n" + "\n".join(out) + "\n")
    print('AUDIT', path, 'islands', len(info), 'pairs', len(pairs))
