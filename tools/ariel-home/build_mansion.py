"""Ariel's cliff mansion (V3 rebuild) - Blender 4.2 headless.
blender -b -P tools/ariel-home/build_mansion.py -- TEXDIR OUTDIR [--render RENDERDIR] [--audit REPORT.txt] [--export STANDALONE.glb]
Z-up here (glTF exporter converts to Y-up).  +Y = ocean, -Y = inland.  Plateau top is z=0, ocean surface z=-62.
Writes ariel-home.glb (nodes Mansion_LOD0 / Mansion_LOD1, 1K webp textures embedded), ariel-home-collide.json (top-down
walkable height grid) and meta.  Everything is procedural; no external assets.

Clipping model (v214 clip fix): every wall / glass / mullion / fin / pier is built *against* the roof and deck registry:
panel tops are ray-sampled onto the roof soffit (the result of a Boolean INTERSECT with the roof underside), piers are
trimmed to the underside of whatever they carry, roof-vs-roof overlaps and pool basins are real Blender Exact Boolean
DIFFERENCEs, and the rock mesa is carved (heightfield DIFFERENCE) wherever a deck / wing would otherwise penetrate it."""
import bpy, bmesh, sys, os, math, json, base64, random
import numpy as np
from mathutils import Vector, noise
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
TEX, OUT = argv[0], argv[1]
RENDER = argv[argv.index('--render') + 1] if '--render' in argv else None
AUDIT = argv[argv.index('--audit') + 1] if '--audit' in argv else None
EXPORT = argv[argv.index('--export') + 1] if '--export' in argv else None
os.makedirs(OUT, exist_ok=True)
random.seed(3141)
SEA = -62.0
SC = 1.3

# ───────────────────────── mesh builder ─────────────────────────
MATS = ['slate', 'concrete', 'wood', 'rock', 'glass', 'warm', 'pool', 'neon', 'dark', 'glow', 'leaf']
TILE = {'slate': 4.0, 'concrete': 4.0, 'wood': 3.0, 'rock': 14.0, 'dark': 2.0, 'leaf': 1.5}
MATS_BPY = []

class B:
    def __init__(s): s.v = []; s.f = []; s.m = []
    def vert(s, p): s.v.append(tuple(p)); return len(s.v) - 1
    def face(s, pts, mat):
        ids = [s.vert(p) for p in pts]
        if len(ids) == 4:                      # split to tris on the shorter diagonal (keeps facets crisp)
            a, b, c, d = [Vector(p) for p in pts]
            if (a - c).length <= (b - d).length: tr = [(0, 1, 2), (0, 2, 3)]
            else: tr = [(0, 1, 3), (1, 2, 3)]
            for t in tr: s.f.append(tuple(ids[i] for i in t)); s.m.append(MATS.index(mat))
        else:
            for i in range(1, len(ids) - 1): s.f.append((ids[0], ids[i], ids[i + 1])); s.m.append(MATS.index(mat))
    def quad(s, a, b, c, d, mat): s.face([a, b, c, d], mat)
    def tri(s, a, b, c, mat): s.face([a, b, c], mat)
    def box(s, cx, cy, cz, sx, sy, sz, mats, rz=0.0):
        """axis box rotated about Z. mats = str or dict(top,bot,side,front,back,l,r)"""
        if isinstance(mats, str): mats = dict(top=mats, bot=mats, side=mats)
        g = lambda k: mats.get(k, mats.get('side', mats.get('top')))
        c, sn = math.cos(rz), math.sin(rz)
        def P(x, y, z): return (cx + (x * c - y * sn), cy + (x * sn + y * c), cz + z)
        hx, hy = sx / 2, sy / 2
        z0, z1 = 0, sz
        s.quad(P(-hx, -hy, z1), P(hx, -hy, z1), P(hx, hy, z1), P(-hx, hy, z1), g('top'))
        s.quad(P(-hx, hy, z0), P(hx, hy, z0), P(hx, -hy, z0), P(-hx, -hy, z0), g('bot'))
        s.quad(P(hx, -hy, z0), P(hx, hy, z0), P(hx, hy, z1), P(hx, -hy, z1), g('r'))
        s.quad(P(-hx, hy, z0), P(-hx, -hy, z0), P(-hx, -hy, z1), P(-hx, hy, z1), g('l'))
        s.quad(P(hx, hy, z0), P(-hx, hy, z0), P(-hx, hy, z1), P(hx, hy, z1), g('front'))
        s.quad(P(-hx, -hy, z0), P(hx, -hy, z0), P(hx, -hy, z1), P(-hx, -hy, z1), g('back'))
    def prism(s, poly, z0, z1, side, top=None, bot=None, reg=None):
        """extrude CCW plan polygon [(x,y)..]; reg=tag registers top/underside surfaces for later clipping"""
        n = len(poly)
        top = top or side; bot = bot or side
        for i in range(n):
            a, b = poly[i], poly[(i + 1) % n]
            s.quad((a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1), side)
        if top != 'none': s.face([(p[0], p[1], z1) for p in poly], top)
        if bot != 'none': s.face([(p[0], p[1], z0) for p in reversed(poly)], bot)
        if reg:
            reg_poly('top', reg, [(p[0], p[1], z1) for p in poly]); reg_poly('under', reg, [(p[0], p[1], z0) for p in poly])
    def strip(s, A, Bp, mat):
        """quads between two equal-length 3D polylines"""
        for i in range(len(A) - 1): s.quad(A[i], A[i + 1], Bp[i + 1], Bp[i], mat)
    def append(s, o):
        off = len(s.v); s.v += o.v; s.f += [tuple(i + off for i in f) for f in o.f]; s.m += o.m

def rotpts(pts, cx, cy, rz):
    c, sn = math.cos(rz), math.sin(rz)
    return [(cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c) for x, y in pts]

def inpoly(p, poly):
    x, y = p; c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c

def polydist(p, poly):
    d = 1e9
    for i in range(len(poly)):
        a, b = Vector(poly[i]), Vector(poly[(i + 1) % len(poly)]); q = Vector(p)
        ab = b - a; t = max(0.0, min(1.0, (q - a).dot(ab) / max(ab.length_squared, 1e-9))); d = min(d, (q - (a + ab * t)).length)
    return d

# ───────────────────── surface registry (roof tops / soffits / deck faces) ─────────────────────
REG = {}; _BV = {}
def reg_tris(kind, tag, tris): REG.setdefault((kind, tag), []).extend(tris); _BV.pop((kind, tag), None)
def reg_poly(kind, tag, pts): reg_tris(kind, tag, [(pts[0], pts[i], pts[i + 1]) for i in range(1, len(pts) - 1)])
def reg_from_B(o, tag):
    """register up-facing faces as 'top' and down-facing faces as 'under' (steep faces ignored)"""
    top, und = [], []
    for f in o.f:
        P = [Vector(o.v[i]) for i in f]; n = (P[1] - P[0]).cross(P[2] - P[0])
        if n.length < 1e-9: continue
        n.normalize(); t = tuple(tuple(p) for p in P)
        if n.z > 0.35: top.append(t)
        elif n.z < -0.35: und.append(t)
    reg_tris('top', tag, top); reg_tris('under', tag, und)
def _bvh(kind, tag):
    k = (kind, tag)
    if k not in _BV:
        tr = REG.get(k)
        if not tr: _BV[k] = None
        else:
            vs = []; fs = []
            for t in tr: i = len(vs); vs.extend(Vector(p) for p in t); fs.append((i, i + 1, i + 2))
            _BV[k] = BVHTree.FromPolygons(vs, fs)
    return _BV[k]
JIT = [(0, 0), (0.013, 0.007), (-0.011, 0.012), (0.02, -0.017)]
def up_hit(x, y, z0, tags, kind='under'):
    best = None
    for t in tags:
        bv = _bvh(kind, t)
        if bv is None: continue
        for jx, jy in JIT:
            h = bv.ray_cast(Vector((x + jx, y + jy, z0)), Vector((0, 0, 1)), 300.0)
            if h[0] is not None:
                if best is None or h[0].z < best: best = h[0].z
                break
    return best
def down_hit(x, y, tags, kind='top', z1=250.0):
    best = None
    for t in tags:
        bv = _bvh(kind, t)
        if bv is None: continue
        for jx, jy in JIT:
            h = bv.ray_cast(Vector((x + jx, y + jy, z1)), Vector((0, 0, -1)), 600.0)
            if h[0] is not None:
                if best is None or h[0].z > best: best = h[0].z
                break
    return best

# ───────────────────── Blender Exact booleans on closed solids ─────────────────────
def mk_tmp(b, name):
    me = bpy.data.meshes.new(name); me.from_pydata(b.v, [], b.f); me.update()
    for m in MATS_BPY: me.materials.append(m)
    me.polygons.foreach_set('material_index', b.m)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob); return ob

def from_mesh(me):
    o = B(); o.v = [tuple(v.co) for v in me.vertices]
    me.calc_loop_triangles()
    for lt in me.loop_triangles: o.f.append(tuple(lt.vertices)); o.m.append(me.polygons[lt.polygon_index].material_index)
    return o

def bool_apply(A, cutters, op='DIFFERENCE'):
    oa = mk_tmp(A, 'bA'); cs = [mk_tmp(c, 'bC%d' % i) for i, c in enumerate(cutters)]
    for c in cs:
        md = oa.modifiers.new('bool', 'BOOLEAN'); md.operation = op; md.operand_type = 'OBJECT'; md.object = c
        md.solver = 'EXACT'; md.use_self = True
    dg = bpy.context.evaluated_depsgraph_get(); ev = oa.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev); out = from_mesh(me)
    for o in [oa] + cs:
        m = o.data; bpy.data.objects.remove(o, do_unlink=True); bpy.data.meshes.remove(m)
    bpy.data.meshes.remove(me)
    return out

def under_volume(tris, zbase, mat='slate'):
    """closed solid = everything below a heightfield (top triangles) down to zbase, vertical walls on the outline"""
    bm = bmesh.new()
    for t in tris:
        vs = [bm.verts.new(p) for p in t]
        try: bm.faces.new(vs)
        except ValueError: pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bnd = [e for e in bm.edges if e.is_boundary]
    ret = bmesh.ops.extrude_edge_only(bm, edges=bnd)
    for g in ret['geom']:
        if isinstance(g, bmesh.types.BMVert): g.co.z = zbase
    be = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMEdge) and all(abs(v.co.z - zbase) < 1e-6 for v in g.verts)]
    bmesh.ops.holes_fill(bm, edges=be, sides=0)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = B(); o.v = [tuple(v.co) for v in bm.verts]; idx = {v: i for i, v in enumerate(bm.verts)}
    for f in bm.faces: o.f.append(tuple(idx[v] for v in f.verts)); o.m.append(MATS.index(mat))
    bm.free(); return o

def top_tris(o):
    r = []
    for f in o.f:
        P = [Vector(o.v[i]) for i in f]; n = (P[1] - P[0]).cross(P[2] - P[0])
        if n.length > 1e-9 and n.normalized().z > 0.35: r.append(tuple(tuple(p) for p in P))
    return r

# ───────────────────────── cliff / rock mesa ─────────────────────────
CARVES = []     # (plan polygon in world coords, z below which the rock must be removed) - filled by the house build
def edge_poly():
    rnd = random.Random(77); pts = []
    x = -200
    while x <= 200:
        pts.append((x, 24 + 9 * math.sin(x * 0.028) + rnd.uniform(-16, 16) + (14 if abs(x) < 70 else 0) * math.cos(x * 0.045)))
        x += rnd.uniform(11, 19)
    return pts
EP = edge_poly()
def edge_y(x):
    for i in range(len(EP) - 1):
        if EP[i][0] <= x <= EP[i + 1][0]:
            t = (x - EP[i][0]) / (EP[i + 1][0] - EP[i][0]); return EP[i][1] * (1 - t) + EP[i + 1][1] * t
    return EP[-1][1]
def sstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)

def carve_it(h, x, y, carve, n2):
    # terrace cut for the lower glazed wing (flat floor at -30 inside |x|<52, ramping out)
    if carve > 0 and y > -3: return min(h, h * (1 - carve) + (-30.0 + 5 * n2) * carve)
    return h

def rock_raw(x, y):
    d = y - edge_y(x)
    n1 = noise.noise(Vector((x * 0.03, y * 0.03, 1.7)))
    n2 = noise.noise(Vector((x * 0.09, y * 0.09, 4.2)))
    ridge = 1 - abs(noise.noise(Vector((x * 0.05, y * 0.05, 9.1))))
    carve = 1.0 - sstep(52, 70, abs(x))
    if d < 0:
        h = 0.25 * n1
        # embankment toward the inland / lateral borders (merges with surrounding terrain)
        bx = max(0, abs(x) - 150) / 80.0; by = max(0, -(y) - 85) / 40.0
        h -= 58 * sstep(0, 1, max(bx, by)) ** 1.4
        # rounded lip
        h -= 2.2 * sstep(-6, 0, d)
        return carve_it(h, x, y, carve, n2)
    t = min(1.0, d / 34.0)
    face = -(SEA * -1.0) * (1 - (1 - t) ** 2.6)          # 0 -> -62, steep first
    jag = 15.0 * (ridge ** 2) * t * (1 - t) * 4 + 6.0 * n2 * t * (1 - t) * 4
    h = face - jag * 0.9 + 1.8 * n1
    # layered strata steps
    h -= 1.6 * ((h / 5.5) % 1.0)
    if d > 34:
        h = SEA - 3 - 0.18 * (d - 34) + 4 * n1                # sea floor falling away
    bx = max(0, abs(x) - 150) / 80.0
    h -= 70 * sstep(0, 1, bx) ** 1.3
    return carve_it(h, x, y, carve, n2)

def rock_h(x, y):
    h = rock_raw(x, y)
    for poly, bb, zb in CARVES:      # Boolean DIFFERENCE of the rock against every deck / wing solid (heightfield form)
        if bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3] and h > zb and inpoly((x, y), poly): h = zb
    return h

def build_rock(b, nx, ny, x0=-200, x1=200, y0=-125, y1=125):
    xs = np.linspace(x0, x1, nx); ys = np.linspace(y0, y1, ny)
    H = np.zeros((ny, nx))
    for j, y in enumerate(ys):
        for i, x in enumerate(xs): H[j, i] = rock_h(x, y)
    for j in range(ny - 1):
        for i in range(nx - 1):
            p = lambda ii, jj: (xs[ii], ys[jj], H[jj, ii])
            a, c_, d_, e = p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)
            b.quad(a, c_, d_, e, 'rock')
    return H, xs, ys

# ───────────────────────── the house ─────────────────────────
def facet_roof(b, L, Rg, Rt, zl, zr, mat='slate', th=0.5):
    """two pitched facets folded on a ridge: L/Rt eave polylines (plan), Rg ridge polyline (plan, higher). Closed shell."""
    A = [(p[0], p[1], zl) for p in L]; Rd = [(p[0], p[1], zr) for p in Rg]; C = [(p[0], p[1], zl) for p in Rt]
    b.strip(A, Rd, mat); b.strip(Rd, C, mat)
    A2 = [(p[0], p[1], zl - th) for p in L]; R2 = [(p[0], p[1], zr - th) for p in Rg]; C2 = [(p[0], p[1], zl - th) for p in Rt]
    b.strip(R2, A2, 'wood'); b.strip(C2, R2, 'wood')      # warm timber soffit (reverse order = faces down)
    for i in range(len(L) - 1):
        b.quad(A[i], A[i + 1], A2[i + 1], A2[i], 'dark'); b.quad(C[i + 1], C[i], C2[i], C2[i + 1], 'dark')
    b.quad(A[0], Rd[0], R2[0], A2[0], 'dark'); b.quad(Rd[0], C[0], C2[0], R2[0], 'dark')
    b.quad(Rd[-1], A[-1], A2[-1], R2[-1], 'dark'); b.quad(C[-1], Rd[-1], R2[-1], C2[-1], 'dark')

def tri_plate(b, P, th, top='slate'):
    """closed thin triangular plate: P = three (x,y,z) corners; slate top, timber underside, dark edge"""
    A, Bp, C = P
    D = lambda p: (p[0], p[1], p[2] - th)
    b.tri(A, Bp, C, top); b.tri(D(C), D(Bp), D(A), 'wood')
    for P0, P1 in ((A, Bp), (Bp, C), (C, A)): b.quad(P0, P1, D(P1), D(P0), 'dark')

def sample_top(x, y, z0, tags, cap, gap):
    h = up_hit(x, y, z0 + 0.05, tags) if tags else None
    return None if h is None else min(cap, h - gap)

def fill_tops(zs, cap):
    if all(z is None for z in zs): return [cap] * len(zs)
    out = list(zs); last = None
    for i, z in enumerate(out):
        if z is None: out[i] = last
        else: last = z
    last = None
    for i in range(len(out) - 1, -1, -1):
        if out[i] is None: out[i] = last
        else: last = out[i]
    return out

def sheet(b, p0, p1, z0, cap, mat, tags, gap=0.03, step=0.6, two=True):
    """vertical panel whose top edge follows the roof underside (ray-sampled: Boolean INTERSECT with the soffit)"""
    L = math.hypot(p1[0] - p0[0], p1[1] - p0[1]); n = max(1, int(math.ceil(L / step)))
    pts = [(p0[0] + (p1[0] - p0[0]) * i / n, p0[1] + (p1[1] - p0[1]) * i / n) for i in range(n + 1)]
    zs = fill_tops([sample_top(x, y, z0, tags, cap, gap) for x, y in pts], cap)
    for i in range(n):
        za, zb = zs[i], zs[i + 1]
        if za - z0 < 0.03 and zb - z0 < 0.03: continue
        A = (pts[i][0], pts[i][1], z0); Bq = (pts[i + 1][0], pts[i + 1][1], z0)
        Cq = (pts[i + 1][0], pts[i + 1][1], max(z0 + .01, zb)); D = (pts[i][0], pts[i][1], max(z0 + .01, za))
        b.quad(A, Bq, Cq, D, mat)
        if two: b.quad(Bq, A, D, Cq, mat)

def wall_box(b, p0, p1, th, z0, mat, tags, cap, gap=0.0, step=0.6, bot=True):
    """solid wall of thickness th between plan points; each face's top is clipped to the soffit above THAT face"""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]; L = math.hypot(dx, dy); nx_, ny_ = -dy / L, dx / L
    n = max(1, int(math.ceil(L / step))); h = th / 2
    C = [(p0[0] + dx * i / n, p0[1] + dy * i / n) for i in range(n + 1)]
    Lp = [(x + nx_ * h, y + ny_ * h) for x, y in C]; Rp = [(x - nx_ * h, y - ny_ * h) for x, y in C]
    zL = fill_tops([sample_top(x, y, z0, tags, cap, gap) for x, y in Lp], cap)
    zR = fill_tops([sample_top(x, y, z0, tags, cap, gap) for x, y in Rp], cap)
    for i in range(n):
        for P, Z, flip in ((Lp, zL, False), (Rp, zR, True)):
            q = [(P[i][0], P[i][1], z0), (P[i + 1][0], P[i + 1][1], z0), (P[i + 1][0], P[i + 1][1], Z[i + 1]), (P[i][0], P[i][1], Z[i])]
            b.quad(*(q[::-1] if flip else q), mat)
        b.quad((Lp[i][0], Lp[i][1], zL[i]), (Lp[i + 1][0], Lp[i + 1][1], zL[i + 1]), (Rp[i + 1][0], Rp[i + 1][1], zR[i + 1]), (Rp[i][0], Rp[i][1], zR[i]), mat)
        if bot: b.quad((Rp[i][0], Rp[i][1], z0), (Rp[i + 1][0], Rp[i + 1][1], z0), (Lp[i + 1][0], Lp[i + 1][1], z0), (Lp[i][0], Lp[i][1], z0), mat)
    for P, sgn in ((0, 1), (n, -1)):
        q = [(Lp[P][0], Lp[P][1], z0), (Rp[P][0], Rp[P][1], z0), (Rp[P][0], Rp[P][1], zR[P]), (Lp[P][0], Lp[P][1], zL[P])]
        b.quad(*(q if sgn > 0 else q[::-1]), mat)

def post_up(b, cx, cy, sx, sy, z0, tags, cap, mat, rz=0.0, gap=0.0):
    """box column from z0 up to the underside of whatever is above (trimmed pier / mullion / fin)"""
    zt = sample_top(cx, cy, z0, tags, cap, gap) if tags else cap
    zt = cap if zt is None else zt
    if zt - z0 > 0.05: b.box(cx, cy, z0, sx, sy, zt - z0, mat, rz=rz)

def post_on(b, poly, ztop, tags, mat, sink=0.12):
    """column standing ON a sloped roof: each bottom corner is seated at the roof top (a hair embedded)"""
    gz = [down_hit(x, y, tags) for x, y in poly]; gz = [ztop - 2 if g is None else g for g in gz]
    n = len(poly)
    for i in range(n):
        a, c = poly[i], poly[(i + 1) % n]
        b.quad((a[0], a[1], gz[i] - sink), (c[0], c[1], gz[(i + 1) % n] - sink), (c[0], c[1], ztop), (a[0], a[1], ztop), mat)
    b.face([(p[0], p[1], ztop) for p in poly], mat)

def glass_wall(b, p0, p1, z0, cap, tags, fins=0.0, mullion=2.4, detail=1.0):
    """floor-to-roof glazing; every panel, mullion and fin is clipped to the soffit above it"""
    (x0, y0), (x1, y1) = p0, p1
    L = math.hypot(x1 - x0, y1 - y0)
    sheet(b, p0, p1, z0, cap, 'glass', tags, gap=0.04)
    nx_, ny_ = (y1 - y0) / L, -(x1 - x0) / L            # outward-ish normal
    inset = 1.2
    sheet(b, (x0 - nx_ * inset, y0 - ny_ * inset), (x1 - nx_ * inset, y1 - ny_ * inset), z0 + .05, cap, 'glow', tags, gap=0.2, two=False, step=1.0)
    n = max(1, int(L / mullion)); rz = math.atan2(y1 - y0, x1 - x0)
    for i in range(n + 1):
        t = i / n; x = x0 + (x1 - x0) * t; y = y0 + (y1 - y0) * t
        post_up(b, x, y, 0.22, 0.22, z0, tags, cap, 'dark', rz=rz, gap=0.03)
        if fins: post_up(b, x + nx_ * 0.4, y + ny_ * 0.4, 0.12, fins, z0, tags, cap, 'slate', rz=rz + math.pi / 2, gap=0.05)

POOLS = []
def deck(b, poly, z, th, pool=None, rail=True, side='concrete', tag='deck', norail=()):
    """slab with a real sunken pool basin (Exact Boolean DIFFERENCE), registered for pier / column trimming; rock is carved under it"""
    d = B(); d.prism(poly, z - th, z, side, top='concrete', bot='concrete')
    if pool:
        px0, py0, px1, py1, depth = pool; depth = min(depth, th - 0.25)
        cut = B(); cut.prism([(px0, py0), (px1, py0), (px1, py1), (px0, py1)], z - depth, z + 1.0, 'dark', top='dark', bot='dark')
        d = bool_apply(d, [cut])
        d.quad((px0, py0, z - 0.2), (px1, py0, z - 0.2), (px1, py1, z - 0.2), (px0, py1, z - 0.2), 'pool')
        POOLS.append(((px0, py0, px1, py1), z))
    b.append(d); reg_from_B(d, tag)
    CARVES.append(([(x * SC, y * SC) for x, y in poly], (min(x * SC for x, _ in poly), min(y * SC for _, y in poly), max(x * SC for x, _ in poly), max(y * SC for _, y in poly)), (z - th) * SC - 0.05))
    if rail:
        mxy = max(p[1] for p in poly); n = len(poly); done = set()
        for i in range(n):
            a, c = poly[i], poly[(i + 1) % n]
            if (a[1] + c[1]) / 2 < mxy - 20: continue
            Ln = math.hypot(c[0] - a[0], c[1] - a[1]); k = max(1, int(Ln / 5))
            for q in range(k):
                t0, t1 = q / k, (q + 1) / k
                pa = (a[0] + (c[0] - a[0]) * t0, a[1] + (c[1] - a[1]) * t0); pc = (a[0] + (c[0] - a[0]) * t1, a[1] + (c[1] - a[1]) * t1)
                if any(inpoly(((pa[0] + pc[0]) / 2, (pa[1] + pc[1]) / 2), nr) or polydist(((pa[0] + pc[0]) / 2, (pa[1] + pc[1]) / 2), nr) < 0.6 for nr in norail): continue
                b.quad((pa[0], pa[1], z), (pc[0], pc[1], z), (pc[0], pc[1], z + 1.15), (pa[0], pa[1], z + 1.15), 'glass')
                b.quad((pc[0], pc[1], z), (pa[0], pa[1], z), (pa[0], pa[1], z + 1.15), (pc[0], pc[1], z + 1.15), 'glass')
                for p in (pa, pc):
                    kk = (round(p[0], 2), round(p[1], 2), z)
                    if kk not in done: done.add(kk); b.box(p[0], p[1], z, .1, .1, 1.2, 'dark')

def ribbon(b, pts, w, tags=None, z=None, lift=0.03, mat='warm', step=0.8):
    """flat light line lying ON a surface (ray-sampled onto the registered tops, or at fixed z) - never a floating rod"""
    S = []
    for i in range(len(pts) - 1):
        L = math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); n = max(1, int(math.ceil(L / step)))
        for k in range(n + (1 if i == len(pts) - 2 else 0)):
            t = k / n; S.append((pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t))
    Z = [z if z is not None else down_hit(x, y, tags) for x, y in S]
    for i in range(len(S) - 1):
        if Z[i] is None or Z[i + 1] is None: continue
        dx, dy = S[i + 1][0] - S[i][0], S[i + 1][1] - S[i][1]; L = math.hypot(dx, dy) or 1; nx_, ny_ = -dy / L * w / 2, dx / L * w / 2
        zz = lambda k: Z[k] + lift
        b.quad((S[i][0] - nx_, S[i][1] - ny_, zz(i)), (S[i + 1][0] - nx_, S[i + 1][1] - ny_, zz(i + 1)),
               (S[i + 1][0] + nx_, S[i + 1][1] + ny_, zz(i + 1)), (S[i][0] + nx_, S[i][1] + ny_, zz(i)), mat)

def blob(b, x, y, z, rx, rz, seed, mat='leaf'):
    """low-poly foliage mass: jittered icosahedron squashed to a shrub"""
    r = random.Random(seed); t = (1 + 5 ** .5) / 2
    V = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    F = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
         (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    P = []
    for v in V:
        l = math.sqrt(sum(c * c for c in v)); j = 0.78 + 0.4 * r.random()
        P.append((x + v[0] / l * rx * j, y + v[1] / l * rx * j, z + max(0.0, v[2] / l + 0.35) * rz * j))
    for f in F: b.tri(P[f[0]], P[f[1]], P[f[2]], mat)

def planter(b, x, y, z, w, d, h, n=3, seed=0, rz=0.0):
    b.box(x, y, z, w, d, h, dict(top='dark', bot='concrete', side='concrete'), rz=rz)
    r = random.Random(seed)
    for i in range(n):
        u = (i - (n - 1) / 2) * (w / max(n, 1)) * 0.8
        blob(b, x + u * math.cos(rz) + r.uniform(-.2, .2), y + u * math.sin(rz) + r.uniform(-.2, .2), z + h - 0.05, 0.55 + 0.2 * r.random(), 0.9 + 0.5 * r.random(), seed * 10 + i)

def build_house(b, detail=1.0):
    REG.clear(); _BV.clear(); CARVES.clear(); POOLS.clear()
    # ── podium / terrace slab on the plateau (the "entry court") ──
    b.box(0, -42.5, -0.0, 150, 81, 0.35, 'concrete')              # court, flush with plateau
    # skyboard landing disc inland-east, glowing ring
    N = 28; r = 9.5; cx, cy = 62, -55
    disc = [(cx + r * math.cos(2 * math.pi * i / N), cy + r * math.sin(2 * math.pi * i / N)) for i in range(N)]
    b.prism(disc, 0.0, 0.5, 'dark', top='concrete', bot='none')
    ring = [(cx + (r - .6) * math.cos(2 * math.pi * i / N), cy + (r - .6) * math.sin(2 * math.pi * i / N)) for i in range(N)]
    ribbon(b, ring + [ring[0]], .22, z=0.5, lift=0.02, step=9)
    # ── 1. arrival wing (inland, long low gunmetal block, flat roof with upstand) ──
    b.box(-30, -62, 0.3, 70, 18, 7.2, dict(top='slate', bot='concrete', side='concrete', front='concrete'))
    b.box(-30, -62, 7.5, 74, 22, .55, dict(top='slate', bot='wood', side='dark'))
    glass_wall(b, (-62, -52.9), (2, -52.9), 0.5, 7.45, (), fins=0.5, mullion=3.2)
    # ── 2. main hall: long, parallel to the cliff, folded delta roof ──
    hx0, hx1, hy0, hy1 = -52, 54, -30, -2
    nL = [(-62, -38), (-20, -37), (14, -35), (50, -33), (66, -32)]
    nR = [(-62, 9), (-20, 10), (14, 14), (50, 20), (66, 26)]
    nG = [(-62, -14), (-20, -12), (14, -9), (50, -3), (66, 0)]
    main = B(); facet_roof(main, nL, nG, nR, 11.4, 18.5)
    # ── 3. prow roof: three-facet pyramid sloping DOWN to the tip (stealth planform) - closed solid ──
    zt = 4.2; th = 0.5
    corners = [(-25, -3, 10.5), (-12.5, 39, 7.2), (0, 58, zt), (12.5, 39, 7.2), (25, -3, 10.5)]
    ridge_top = (0, 20, 15.5)
    prow = B()
    D = lambda p: (p[0], p[1], p[2] - th)
    for i in range(4):
        c0, c1 = corners[i], corners[i + 1]
        prow.tri(c0, c1, ridge_top, 'slate'); prow.tri(D(c1), D(c0), D(ridge_top), 'wood'); prow.quad(c0, c1, D(c1), D(c0), 'dark')
    prow.tri(corners[0], ridge_top, corners[4], 'slate'); prow.tri(D(corners[4]), D(ridge_top), D(corners[0]), 'wood'); prow.quad(corners[4], corners[0], D(corners[0]), D(corners[4]), 'dark')
    # canopy plate (the stealth-fighter wing over the east deck)
    wing = [(14, -3), (84, 8), (58, 70)]; wz = [15.0, 11.0, 4.6]
    WA, WB, WC = [(p[0], p[1], z) for p, z in zip(wing, wz)]
    canopy = B(); tri_plate(canopy, (WA, WB, WC), 0.55)
    # Boolean the roof planes against each other: they form a valley, nothing pokes through its neighbour
    mt, pt = top_tris(main), top_tris(prow)
    cut_by_prow = under_volume(pt, -2.0); cut_by_main = under_volume(mt, -2.0)
    main_c = bool_apply(main, [cut_by_prow]); prow_c = bool_apply(prow, [cut_by_main]); canopy_c = bool_apply(canopy, [cut_by_main, cut_by_prow])
    for o, tag in ((main_c, 'main'), (prow_c, 'prow'), (canopy_c, 'canopy')): b.append(o); reg_from_B(o, tag)
    # hall walls / glass follow the roof contour
    glass_wall(b, (hx0 + 3, hy1), (hx1 - 3, hy1), 0.35, 24, ('main',), fins=0.9, detail=detail)
    wall_box(b, (hx0, hy0), (hx0, hy1), 2.2, 0.35, 'concrete', ('main',), 24, gap=0.05)             # end walls (gabled to the roof)
    wall_box(b, (hx1, hy0), (hx1, hy1), 2.2, 0.35, 'concrete', ('main',), 24, gap=0.05)
    wall_box(b, (hx0, hy0), (hx1, hy0), 2.0, 0.35, 'concrete', ('main',), 24, gap=0.05)             # rear wall
    b.box((hx0 + hx1) / 2, (hy0 + hy1 - 0.1) / 2 , 0.35, hx1 - hx0 - 2.4, hy1 - hy0 - 2.2, .03, 'wood')   # warm floor, sits on the court
    # blade tower: tall triangular monolith, standing CLEAR of the roof eave (was piercing it)
    tri = [(-48, -46), (-38, -46), (-44, -39.5)]
    b.prism(tri, 0, 30, 'slate', top='slate')
    ribbon(b, [(-46.9, -45.2), (-44.4, -41.0)], .18, z=30.0, lift=0.02)
    # ── 3b. prow wing: arrowhead cantilevered over the cliff ──
    pr = [(-24, hy1), (24, hy1), (10, 38), (0, 56), (-10, 38)]
    b.prism(pr, -1.3, -0.1, 'concrete', top='concrete', bot='concrete', reg='deck')
    for i in range(1, 5):
        a, c = pr[i], pr[(i + 1) % len(pr)]      # all four outer edges (west edge was missing), tops follow the roofs above
        glass_wall(b, a, c, -0.1, 14, ('prow', 'main'), fins=0.0 if detail < 1 else 0.7, mullion=2.6, detail=detail)
    ribbon(b, [(-23.5, 0.5), (-11.8, 37.5), (-0.3, 54.6)], .12, tags=('prow',), lift=0.03)
    ribbon(b, [(23.5, 0.5), (11.8, 37.5), (0.3, 54.6)], .12, tags=('prow',), lift=0.03)
    # ── 4. upper guest wing, yawed 14 degrees, with its own folded roof ──
    yaw = math.radians(14); UZ = 19.8
    up = rotpts([(-34, -26), (30, -26), (30, -9), (-34, -9)], 0, -18, yaw)
    b.prism(up, UZ - 0.9, UZ, 'concrete', top='concrete', bot='concrete', reg='deck')
    guest = B()
    uL = rotpts([(-40, -32), (-8, -31.5), (30, -31), (38, -30.5)], 0, -18, yaw)
    uG = rotpts([(-40, -17), (-8, -16), (30, -14), (38, -13)], 0, -18, yaw)
    uR = rotpts([(-40, -3), (-8, 1), (30, 4), (38, 6)], 0, -18, yaw)
    facet_roof(guest, uL, uG, uR, 27.8, 33.5); b.append(guest); reg_from_B(guest, 'guest')
    for xa, xb in ((-30, -26), (24, 28)):     # guest-wing piers seat ON the main roof (were hanging through it)
        post_on(b, rotpts([(xa, -26), (xb, -26), (xb, -9), (xa, -9)], 0, -18, yaw), UZ - 0.9, ('main',), 'concrete')
    gw0 = rotpts([(-34, -9)], 0, -18, yaw)[0]; gw1 = rotpts([(30, -9)], 0, -18, yaw)[0]
    glass_wall(b, gw0, gw1, UZ, 40, ('guest',), fins=0.6, detail=detail)
    # needle cantilever: long triangular deck knifing out of the upper wing; guest deck + rails stop where it takes over
    nd = rotpts([(-12, -9), (12, -9), (0, 64)], 0, -18, yaw)
    udk = rotpts([(-30, -9), (30, -9), (22, 14), (4, 34), (-14, 14)], 0, -18, yaw)
    deck(b, udk, UZ, 1.1, pool=None, norail=[nd])
    b.prism(nd, UZ - 1.0, UZ - 0.02, 'concrete', top='concrete', bot='concrete', reg='deck')
    ribbon(b, rotpts([(0, 38), (0, 58)], 0, -18, yaw), 0.9, z=UZ - 0.02, lift=0.03)
    # ── 5. cantilevered pointed decks off the main hall + infinity pools ──
    ldk = [(24, hy1), (56, hy1), (74, 22), (62, 40), (46, 50), (30, 28)]
    deck(b, ldk, 0.0, 1.5, pool=(36, 6, 59, 24, 1.6))
    wdk = [(-24, hy1), (-26, 12), (-52, 30), (-76, 14), (-52, hy1)]
    deck(b, wdk, 0.0, 1.3, pool=None)
    # lower terrace stepped down the cliff, long pool; lower glazed wing tucked beneath it
    lw = [(-40, 4), (36, 4), (50, 30), (26, 52), (-20, 56), (-52, 36)]
    deck(b, lw, -14.0, 1.4, pool=(-24, 20, 20, 36, 1.5), tag='deck')
    b.box(0, 4, -22, 70, 12, 6.5, dict(top='concrete', bot='concrete', side='concrete'))    # lower glazed wing, set into the cliff (top below the terrace slab)
    CARVES.append(([(-35 * SC, -2 * SC), (35 * SC, -2 * SC), (35 * SC, 10 * SC), (-35 * SC, 10 * SC)], (-35 * SC, -2 * SC, 35 * SC, 10 * SC), -22 * SC - 0.05))
    glass_wall(b, (-34, 10.1), (34, 10.1), -21.5, -15.35, ('deck',), fins=0.0, mullion=3.0, detail=detail)
    b.box(0, 1, -15.5, 76, 6, .6, dict(top='slate', bot='wood', side='dark'))               # roof plate stops where the terrace slab takes over
    # ── 5b. wing canopy: columns now stand inside the deck and run up to the plate's underside ──
    ribbon(b, [(WA[0] + 6, WA[1] + 2.5), (WC[0] - 4, WC[1] - 4)], .12, tags=('canopy',), lift=0.03)
    for (x, y) in [(64, 28), (50, 44)]:
        post_up(b, x, y, 1.6, 1.6, -0.05, ('canopy',), 20, 'dark', gap=0.0)
    # ── 5d. second delta: west side triangular roof over the lower terrace, pointing seaward-west ──
    dl = [(-60, 6), (-30, 8), (-62, 52)]; dz = [-6.0, -6.0, -9.5]
    delta = B(); tri_plate(delta, [(p[0], p[1], z) for p, z in zip(dl, dz)], 0.5); b.append(delta); reg_from_B(delta, 'delta2')
    # structural piers: only where a slab sits overhead, trimmed to its underside (they used to run through the decks)
    for (x, y) in [(-40, 40), (-14, 50), (22, 46), (44, 26), (-44, 28), (66, 30), (60, 36), (-60, 24), (-5, 46)]:
        for hw in (0.9,):
            zt_ = up_hit(x, y, -66, ('deck',))
            if zt_ is None: continue
            b.prism([(x - hw, y - hw), (x + hw, y - hw), (x + hw, y + hw), (x - hw, y + hw)], -66, zt_ + 0.05, 'concrete')
    # ── 6. slate retaining fins running down the cliff face + warm uplights ──
    if detail >= 1:
        for x in range(-50, 52, 12):
            yy = max(8, edge_y(x) - 2)
            ztop = min(-2.0, rock_raw(x * SC + .6, (yy + 5) * SC) / SC + 1.2)       # rib tops follow the rock instead of standing proud of it
            b.prism([(x, yy), (x + 1.2, yy), (x + .6, yy + 6)], -50, ztop, 'slate')
        # long warm light line along the main roof's seaward eave (lies ON the roof, was a rod floating 6 m above it)
        ribbon(b, [(x, y - 0.8) for (x, y) in nR], .14, tags=('main',), lift=0.03)
    # ── 7. planters + foliage on decks, court and cliff edge ──
    pools = [p for p, _ in POOLS]
    def ok(x, y, poly, margin=1.8):
        if not inpoly((x, y), poly) or polydist((x, y), poly) < margin: return False
        return not any(p[0] - 1.5 < x < p[2] + 1.5 and p[1] - 1.5 < y < p[3] + 1.5 for p in pools)
    spots = [(ldk, 0.0, [(32, 2), (50, 3), (60, 33), (50, 44.5), (38, 30)]), (wdk, 0.0, [(-31, 3), (-42, 12), (-60, 14), (-46, 20)]),
             (lw, -14.0, [(-34, 8), (-12, 8), (10, 8), (28, 12), (-40, 28), (30, 26), (-6, 46), (16, 44)]),
             (udk, UZ, [(-16, -3.5), (16, -5), (-8, 8), (20, 1)])]
    for poly, z, pts in spots:
        for k, (x, y) in enumerate(pts):
            if poly is udk: x, y = rotpts([(x, y)], 0, -18, yaw)[0]
            if ok(x, y, poly) and (poly is not udk or not inpoly((x, y), nd)) and not any(math.hypot(x - cx_, y - cy_) < 3 for cx_, cy_ in [(64, 28), (50, 44)]):
                planter(b, x, y, z, 2.6, 1.2, 0.9, n=3, seed=int(abs(x * 7 + y * 3)) + k)
    for k, (x, y) in enumerate([(-72, -30), (-72, -12), (71, -22), (71, -36), (-20, -8.5), (24, -8.5)]):
        planter(b, x, y, 0.35, 2.6, 1.2, 0.9, n=3, seed=100 + k)
    return b

def plants_world(b):
    """cliff-edge shrub clusters in world (unscaled) coordinates on the plateau lip, outside the house footprint"""
    r = random.Random(555)
    for k in range(34):
        x = r.choice([-1, 1]) * r.uniform(104, 146); y = edge_y(x) - r.uniform(1.0, 5.0)
        z = rock_h(x, y)
        for j in range(r.randint(2, 4)): blob(b, x + r.uniform(-1.4, 1.4), y + r.uniform(-1.4, 1.4), z - 0.25, 0.9 + r.random() * 0.7, 1.1 + r.random() * 0.9, 900 + k * 7 + j)

# ───────────────────────── Blender plumbing ─────────────────────────
def tex_node(nt, path, cs):
    n = nt.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(path)
    n.image.colorspace_settings.name = cs; n.interpolation = 'Smart'; return n

def make_mat(name):
    m = bpy.data.materials.new('ah_' + name); m.use_nodes = True
    nt = m.node_tree; bsdf = nt.nodes['Principled BSDF']
    if name in TILE and os.path.exists(f'{TEX}/{name}-color-1k.webp'):
        c = tex_node(nt, f'{TEX}/{name}-color-1k.webp', 'sRGB'); o = tex_node(nt, f'{TEX}/{name}-orm-1k.webp', 'Non-Color')
        nr = tex_node(nt, f'{TEX}/{name}-nrm-1k.webp', 'Non-Color')
        nt.links.new(c.outputs['Color'], bsdf.inputs['Base Color'])
        sp = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(o.outputs['Color'], sp.inputs['Color'])
        nt.links.new(sp.outputs['Green'], bsdf.inputs['Roughness']); nt.links.new(sp.outputs['Blue'], bsdf.inputs['Metallic'])
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 1.0
        nt.links.new(nr.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    elif name == 'glass':
        bsdf.inputs['Base Color'].default_value = (0.06, 0.12, 0.14, 1); bsdf.inputs['Roughness'].default_value = 0.04
        bsdf.inputs['Metallic'].default_value = 0.0; bsdf.inputs['Alpha'].default_value = 0.26
        bsdf.inputs['IOR'].default_value = 1.5; m.blend_method = 'BLEND'
        try: bsdf.inputs['Specular IOR Level'].default_value = 1.0
        except Exception: pass
    elif name == 'warm':
        bsdf.inputs['Base Color'].default_value = (0.9, 0.5, 0.2, 1)
        bsdf.inputs['Emission Color'].default_value = (1.0, 0.58, 0.26, 1); bsdf.inputs['Emission Strength'].default_value = 3.2
    elif name == 'glow':
        bsdf.inputs['Base Color'].default_value = (0.35, 0.2, 0.1, 1)
        bsdf.inputs['Emission Color'].default_value = (1.0, 0.5, 0.2, 1); bsdf.inputs['Emission Strength'].default_value = 0.9
    elif name == 'pool':
        bsdf.inputs['Base Color'].default_value = (0.08, 0.5, 0.58, 1); bsdf.inputs['Roughness'].default_value = 0.05
        bsdf.inputs['Emission Color'].default_value = (0.1, 0.7, 0.8, 1); bsdf.inputs['Emission Strength'].default_value = 0.9
    elif name == 'neon':
        bsdf.inputs['Base Color'].default_value = (0.4, 0.2, 1, 1)
        bsdf.inputs['Emission Color'].default_value = (0.5, 0.3, 1.0, 1); bsdf.inputs['Emission Strength'].default_value = 4.0
    elif name == 'dark':
        bsdf.inputs['Base Color'].default_value = (0.03, 0.035, 0.04, 1); bsdf.inputs['Roughness'].default_value = 0.4; bsdf.inputs['Metallic'].default_value = 0.6
    elif name == 'leaf':
        bsdf.inputs['Base Color'].default_value = (0.10, 0.22, 0.07, 1); bsdf.inputs['Roughness'].default_value = 0.7
    return m

def make_obj(name, b, mats):
    me = bpy.data.meshes.new(name)
    me.from_pydata(b.v, [], b.f)
    me.update()
    for m in mats: me.materials.append(m)
    me.polygons.foreach_set('material_index', b.m)
    # box-projected UVs (world) at the material's tile size
    uvl = me.uv_layers.new(name='UVMap'); verts = np.array(b.v, dtype=np.float32)
    uv = np.zeros((len(me.loops), 2), dtype=np.float32)
    for pi, p in enumerate(me.polygons):
        idx = list(p.vertices); P = verts[idx]; n = np.abs(np.array(p.normal))
        tile = TILE.get(MATS[b.m[pi]], 4.0)
        if n[2] >= n[0] and n[2] >= n[1] or (MATS[b.m[pi]] == 'rock' and n[2] > 0.55): u, v = P[:, 0], P[:, 1]
        elif n[0] >= n[1]: u, v = P[:, 1], P[:, 2]
        else: u, v = P[:, 0], P[:, 2]
        for li, k in zip(p.loop_indices, range(len(idx))): uv[li] = (u[k] / tile, v[k] / tile)
    uvl.data.foreach_set('uv', uv.ravel())
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002); bm.to_mesh(me); bm.free()
    sm = {MATS.index('rock'), MATS.index('leaf')}      # smooth rock/foliage -> shared vertices (GLB size) and softer shading
    for pi, pgn in enumerate(me.polygons): pgn.use_smooth = int(b.m[pi]) in sm
    return ob

def house_scaled(detail):
    h = B(); build_house(h, detail)
    h.v = [(x * SC, y * SC, z * SC) for x, y, z in h.v]
    return h

def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = [make_mat(n) for n in MATS]; MATS_BPY[:] = mats
    root0 = bpy.data.objects.new('Mansion_LOD0', None); root1 = bpy.data.objects.new('Mansion_LOD1', None)
    bpy.context.collection.objects.link(root0); bpy.context.collection.objects.link(root1)
    # LOD0: house first (fills CARVES), then the rock is carved under it
    h0 = house_scaled(1.0)
    b0 = B(); H0, xs0, ys0 = build_rock(b0, 150, 100); b0.append(h0); plants_world(b0)
    if AUDIT:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from audit import audit; audit(b0, MATS, AUDIT)
    o0 = make_obj('Mansion_LOD0_mesh', b0, mats); o0.parent = root0
    # LOD1: coarser rock, simplified house
    h1 = house_scaled(0.0)
    b1 = B(); build_rock(b1, 50, 34); b1.append(h1)
    o1 = make_obj('Mansion_LOD1_mesh', b1, mats); o1.parent = root1
    print('TRIS LOD0', len(b0.f), 'LOD1', len(b1.f))
    # collision grid: top-down hits on everything but glass / pool surface / neon / foliage
    solid = [i for i, m in enumerate(b0.m) if MATS[m] not in ('glass', 'pool', 'neon', 'warm', 'leaf')]
    bv = BVHTree.FromPolygons([Vector(v) for v in b0.v], [b0.f[i] for i in solid])
    cs = 2.0; gx0, gx1, gy0, gy1 = -170.0, 170.0, -130.0, 120.0
    nx = int((gx1 - gx0) / cs) + 1; ny = int((gy1 - gy0) / cs) + 1
    G = np.full((ny, nx), -999.0)
    for j in range(ny):
        for i in range(nx):
            hit = bv.ray_cast(Vector((gx0 + i * cs, gy0 + j * cs, 160.0)), Vector((0, 0, -1)), 400.0)
            if hit[0] is not None: G[j, i] = hit[0].z
    q = np.clip(np.round(G * 20), -32000, 32000).astype('<i2')
    json.dump({'x0': gx0, 'y0': gy0, 'cell': cs, 'nx': nx, 'ny': ny, 'scale': 20, 'plateau': 0.0, 'sea': SEA,
               'data': base64.b64encode(q.tobytes()).decode()}, open(f'{OUT}/ariel-home-collide.json', 'w'), separators=(',', ':'))
    bpy.ops.object.select_all(action='DESELECT')
    for o in (root0, root1, o0, o1): o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=f'{OUT}/ariel-home.glb', export_format='GLB', use_selection=True, export_image_format='WEBP',
                              export_yup=True, export_apply=True, export_materials='EXPORT', export_cameras=False, export_lights=False,
                              export_extras=False)
    print('GLB', os.path.getsize(f'{OUT}/ariel-home.glb'))
    # desktop tier: swap every embedded map to its 2K bake (same names, '-2k'); used for the standalone export and the renders
    for im in bpy.data.images:
        if im.filepath and '-1k.' in im.filepath:
            im.filepath = im.filepath.replace('-1k.', '-2k.'); im.reload()
    if EXPORT:
        os.makedirs(os.path.dirname(EXPORT), exist_ok=True)
        bpy.ops.object.select_all(action='DESELECT')
        for o in (root0, o0): o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=EXPORT, export_format='GLB', use_selection=True, export_image_format='WEBP',
                                  export_yup=True, export_apply=True, export_materials='EXPORT', export_cameras=False, export_lights=False,
                                  export_extras=False)
        print('EXPORT', os.path.getsize(EXPORT))
    if RENDER: do_render(root0, root1, o0)

DISP = {'slate': 0.07, 'concrete': 0.05, 'rock': 0.8, 'wood': 0.03, 'dark': 0.012, 'leaf': 0.04}   # metres at height=1 (midlevel .5)

def render_materials(o0):
    """renders only: REAL displacement from the Ucupaint height bakes (adaptive simple subdivision), clear reflective glass"""
    sc = bpy.context.scene; sc.cycles.feature_set = 'EXPERIMENTAL'; sc.cycles.dicing_rate = 4.0; sc.cycles.offscreen_dicing_scale = 16.0; sc.cycles.preview_dicing_rate = 8
    for n, sc_m in DISP.items():
        m = bpy.data.materials.get('ah_' + n); hp = f'{TEX}/{n}-height-1k.png'
        if not m or not os.path.exists(hp): continue
        nt = m.node_tree; out = [x for x in nt.nodes if x.type == 'OUTPUT_MATERIAL'][0]
        t = tex_node(nt, hp, 'Non-Color'); d = nt.nodes.new('ShaderNodeDisplacement'); d.inputs['Scale'].default_value = sc_m; d.inputs['Midlevel'].default_value = 0.5
        # same UVs as the colour map: copy its vector link
        for l in list(nt.links):
            if l.to_node.type == 'TEX_IMAGE' and l.to_socket.name == 'Vector' and l.to_node != t: nt.links.new(l.from_socket, t.inputs['Vector']); break
        nt.links.new(t.outputs['Color'], d.inputs['Height']); nt.links.new(d.outputs['Displacement'], out.inputs['Displacement'])
        m.displacement_method = 'BOTH'
    g = bpy.data.materials['ah_glass']; b = g.node_tree.nodes['Principled BSDF']
    b.inputs['Alpha'].default_value = 1.0; g.blend_method = 'OPAQUE'
    b.inputs['Transmission Weight'].default_value = 0.92; b.inputs['Roughness'].default_value = 0.02; b.inputs['Base Color'].default_value = (0.55, 0.7, 0.75, 1)
    b.inputs['Specular IOR Level'].default_value = 1.0; b.inputs['IOR'].default_value = 1.45
    o0.modifiers.new('subd', 'SUBSURF'); md = o0.modifiers['subd']; md.subdivision_type = 'SIMPLE'; md.levels = 0; md.render_levels = 0
    o0.cycles.use_adaptive_subdivision = True

def do_render(root0, root1, o0):
    sc = bpy.context.scene
    render_materials(o0)
    for o in root1.children: o.hide_render = True
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 40; sc.cycles.use_denoising = True; sc.cycles.device = 'CPU'
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.42, 0.46, 0.52, 1); bg.inputs[1].default_value = 1.1
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 2.4; sun.angle = math.radians(25)
    so = bpy.data.objects.new('sun', sun); bpy.context.collection.objects.link(so); so.rotation_euler = (math.radians(58), 0, math.radians(-25))
    # overcast sea plane
    bpy.ops.mesh.primitive_plane_add(size=2000, location=(0, 0, SEA))
    sea = bpy.context.object; sm = bpy.data.materials.new('sea'); sm.use_nodes = True
    sm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.05, 0.10, 0.13, 1)
    sm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.12; sea.data.materials.append(sm)
    cam = bpy.data.cameras.new('c'); cam.lens = 24; co = bpy.data.objects.new('c', cam); bpy.context.collection.objects.link(co); sc.camera = co
    shots = {'front': ((40, 240, -14), (0, 10, -8)), 'threeq': ((-200, 190, 20), (0, 20, -8)), 'aerial': ((150, 150, 110), (0, 15, -10)), 'low': ((180, 150, -45), (0, 25, -10)),
             'closeup': ((60, 95, 40), (10, 20, 12))}
    ONLY = argv[argv.index('--shots') + 1].split(',') if '--shots' in argv else None
    for k, (p, t) in shots.items():
        if ONLY and k not in ONLY: continue
        co.location = p; co.data.lens = 24 if k != 'closeup' else 42
        d = Vector(t) - Vector(p); co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = f'{RENDER}/mansion-{k}.png'; bpy.ops.render.render(write_still=True)
    if '--macros' not in argv: return
    # material close-ups: the largest exterior-facing patch of each material, 4 m away at 50 mm
    me = o0.data; mi = {m.name: i for i, m in enumerate(me.materials)}
    sc.render.resolution_x, sc.render.resolution_y = 1000, 700; co.data.lens = 50; sc.cycles.dicing_rate = 1.5
    want = {'slate': lambda n: n.z > 0.5, 'concrete': lambda n: abs(n.z) < 0.3 and n.y > 0.5, 'dark': lambda n: abs(n.z) < 0.3 and n.y > 0.5,
            'rock': lambda n: n.z > 0.4, 'leaf': lambda n: n.z > 0.3, 'glass': lambda n: abs(n.z) < 0.3 and n.y > 0.5, 'wood': lambda n: n.z < -0.5}
    bvh = BVHTree.FromObject(o0, bpy.context.evaluated_depsgraph_get())
    sc.cycles.dicing_rate = 3.0; sc.cycles.offscreen_dicing_scale = 64.0; sc.view_settings.exposure = 0.4
    fill = bpy.data.lights.new('fill', 'AREA'); fill.energy = 220; fill.size = 4; fo = bpy.data.objects.new('fill', fill); bpy.context.collection.objects.link(fo)
    for k, ok in want.items():
        if ONLY and k not in ONLY: continue
        best = None
        for pg in me.polygons:
            if pg.material_index != mi['ah_' + k] or not ok(pg.normal): continue
            c = pg.center
            if not (-60 < c.x < 70 and -20 < c.y < 80 and c.z > (-8 if k == 'dark' else -45)) and k != 'rock': continue
            dist = 3.2 if k not in ('rock', 'wood', 'leaf') else 5.5
            p0 = c + pg.normal * dist; h = bvh.ray_cast(p0, (c - p0).normalized(), dist * 1.1)
            if h[0] is None or (h[0] - c).length > 0.6: continue          # occluded
            if best is None or pg.area > best[0]: best = (pg.area, c.copy(), pg.normal.copy(), dist)
        if not best: print('no macro for', k); continue
        _, c, n, dist = best; p0 = c + n * dist + Vector((0, 0, 0.6 if abs(n.z) < 0.5 else 0))
        co.location = p0; co.rotation_euler = (c - p0).to_track_quat('-Z', 'Y').to_euler()
        fo.location = p0 + Vector((1.5, 0, 2.0)); fo.rotation_euler = co.rotation_euler
        sc.render.filepath = f'{RENDER}/mansion-m-{k}.png'; bpy.ops.render.render(write_still=True)
main()
