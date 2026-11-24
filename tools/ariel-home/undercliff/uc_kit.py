# t1583u P2 undercliff kit: geometry accumulator + room shell / cove / downlight / furniture helpers.
# Frame (shared with the helper's p2b_build.py): METRES, x = X (east of bay centre), y = -D (D = metres into the cliff), z = H (pool-deck floor = 0).
# To the mansion GLB frame (u): x_u = 1.78 x, y_u = -2.9 + 1.78 y, z_u = -18.2 + 1.78 z.
import bpy, bmesh, math
from mathutils import Vector

U = 1.78; Y0U = -2.9; FU = -18.2
MORDER = ['uc_rock', 'uc_concrete', 'uc_slate', 'uc_wood', 'uc_dark', 'uc_emit']
MI = {k: i for i, k in enumerate(MORDER)}
TILE = 4.0          # 512 px/m: one 2K tile per 4 m, world-aligned box mapping (seams line up across rooms)

def to_u(x, y, z): return (x * U, Y0U + y * U, FU + z * U)

class Acc:
    """One mesh object. Faces carry a material key; UVs are world box-projected at TILE m (per-face dominant axis)."""
    def __init__(s, name, tile=TILE):
        s.name = name; s.v = []; s.f = []; s.m = []; s.uvoff = []; s.tile = tile; s.vmap = {}
    def vid(s, p):
        k = (round(p[0], 4), round(p[1], 4), round(p[2], 4))
        i = s.vmap.get(k)
        if i is None: i = len(s.v); s.v.append(k); s.vmap[k] = i
        return i
    def poly(s, pts, mat, uvo=(0, 0)):
        s.f.append([s.vid(p) for p in pts]); s.m.append(mat); s.uvoff.append(uvo)
    def quad(s, p0, p1, p2, p3, mat, nu=1, nv=1, uvo=(0, 0)):
        p0, p1, p2, p3 = Vector(p0), Vector(p1), Vector(p2), Vector(p3)
        for i in range(nu):
            for j in range(nv):
                a, b = i / nu, (i + 1) / nu; c, d = j / nv, (j + 1) / nv
                def L(u, v): return (p0.lerp(p1, u)).lerp(p3.lerp(p2, u), v)
                s.poly([tuple(L(a, c)), tuple(L(b, c)), tuple(L(b, d)), tuple(L(a, d))], mat, uvo)
    def gquad(s, p0, p1, p2, p3, mat, cell=1.0, uvo=(0, 0)):
        """quad subdivided to <= cell m (bake resolution for vertex-baked light)."""
        P = [Vector(p) for p in (p0, p1, p2, p3)]
        nu = max(1, math.ceil(max((P[1] - P[0]).length, (P[2] - P[3]).length) / cell - 1e-6))
        nv = max(1, math.ceil(max((P[3] - P[0]).length, (P[2] - P[1]).length) / cell - 1e-6))
        s.quad(p0, p1, p2, p3, mat, nu, nv, uvo)
    def box(s, x0, x1, y0, y1, z0, z1, mat, skip=(), cell=None, uvo=(0, 0)):
        x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1)); z0, z1 = sorted((z0, z1))
        q = s.gquad if cell else (lambda *a, **k: s.quad(*a[:5], uvo=k.get('uvo', (0, 0))))
        kw = dict(uvo=uvo)
        if cell: kw['cell'] = cell
        F = {'-z': ((x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)), '+z': ((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)),
             '-y': ((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)), '+y': ((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)),
             '-x': ((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)), '+x': ((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1))}
        for k, pts in F.items():
            if k in skip: continue
            if cell: s.gquad(*pts, mat, cell=cell, uvo=uvo)
            else: s.quad(*pts, mat, uvo=uvo)
    def cyl(s, cx, cy, z0, z1, r, n, mat, caps=(True, True), r1=None):
        r1 = r if r1 is None else r1
        ring0 = [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n), z0) for k in range(n)]
        ring1 = [(cx + r1 * math.cos(2 * math.pi * k / n), cy + r1 * math.sin(2 * math.pi * k / n), z1) for k in range(n)]
        for k in range(n):
            k2 = (k + 1) % n; s.poly([ring0[k], ring0[k2], ring1[k2], ring1[k]], mat)
        if caps[0]: s.poly(list(reversed(ring0)), mat)
        if caps[1]: s.poly(ring1, mat)
    def hcyl(s, ax, c0, c1, r, n, mat, ca, cb):
        """horizontal cylinder along axis 'x' or 'y' from c0 to c1, centred at (ca, cb) = (other horizontal coord, z)."""
        def P(t, ang):
            o = (ca + r * math.cos(ang), cb + r * math.sin(ang))
            return (t, o[0], o[1]) if ax == 'x' else (o[0], t, o[1])
        for k in range(n):
            a0, a1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
            s.poly([P(c0, a0), P(c1, a0), P(c1, a1), P(c0, a1)], mat)
        s.poly([P(c0, 2 * math.pi * k / n) for k in range(n)], mat); s.poly([P(c1, 2 * math.pi * k / n) for k in reversed(range(n))], mat)
    def tris(s): return sum(len(f) - 2 for f in s.f)
    def build(s, coll, mats, props=None):
        me = bpy.data.meshes.new(s.name); me.from_pydata([tuple(v) for v in s.v], [], s.f); me.validate(clean_customdata=False); me.update()
        o = bpy.data.objects.new(s.name, me); coll.objects.link(o)
        for k in MORDER: me.materials.append(mats[k])
        me.polygons.foreach_set('material_index', [MI[k] for k in s.m])
        uv = me.uv_layers.new(name='UVMap')
        for pi, p in enumerate(me.polygons):
            n = p.normal; ax = max(range(3), key=lambda a: abs(n[a])); ox, oy = s.uvoff[pi]
            for li in p.loop_indices:
                co = me.vertices[me.loops[li].vertex_index].co
                if ax == 2: u_, v_ = co.x, co.y * (1 if n.z > 0 else -1)
                elif ax == 0: u_, v_ = co.y * (-1 if n.x > 0 else 1), co.z
                else: u_, v_ = co.x * (1 if n.y < 0 else -1), co.z
                uv.data[li].uv = (u_ / s.tile + ox, v_ / s.tile + oy)
        me.update()
        if props:
            for k, v in props.items(): o[k] = v
        return o

def wall(acc, axis, c, s0, s1, z0, z1, inward, mat, openings=(), cell=1.0, trim=None, skirt=None):
    """Single-sided wall facing `inward` (+1/-1 along the wall's normal axis). axis 'x': wall runs along x at y = c; axis 'y': runs along y at x = c.
    openings: (centre, width, height) from z0. trim: material for a 0.08 m door frame. skirt: material for a 0.1 m skirting strip."""
    br = sorted(set([s0, s1] + [o[0] - o[1] / 2 for o in openings] + [o[0] + o[1] / 2 for o in openings]))
    br = [b for b in br if s0 - 1e-6 <= b <= s1 + 1e-6]
    def P(sv, z):
        return (sv, c, z) if axis == 'x' else (c, sv, z)
    flip = (inward > 0) if axis == 'x' else (inward < 0)
    def panel(a, b, za, zb):
        if zb - za < 1e-4 or b - a < 1e-4: return
        p = [P(a, za), P(b, za), P(b, zb), P(a, zb)]
        if flip: p = [p[1], p[0], p[3], p[2]]
        acc.gquad(*p, mat, cell=cell)
    for a, b in zip(br[:-1], br[1:]):
        m = (a + b) / 2; op = next((o for o in openings if o[0] - o[1] / 2 - 1e-6 <= m <= o[0] + o[1] / 2 + 1e-6), None)
        if op: panel(a, b, z0 + op[2], z1)
        else:
            panel(a, b, z0, z1)
            if skirt:   # 0.1 m skirting, 0.02 proud
                d = 0.02 * inward
                if axis == 'x': acc.box(a, b, c, c + d, z0, z0 + 0.1, skirt, skip=('-z', '-y' if inward > 0 else '+y'))
                else: acc.box(c, c + d, a, b, z0, z0 + 0.1, skirt, skip=('-z', '-x' if inward > 0 else '+x'))
    if trim:
        for (oc, ow, oh) in openings:
            t = 0.08; d = 0.06 * inward
            for sv in (oc - ow / 2 - t, oc + ow / 2):
                if axis == 'x': acc.box(sv, sv + t, c, c + d, z0, z0 + oh + t, trim, skip=('-z',))
                else: acc.box(c, c + d, sv, sv + t, z0, z0 + oh + t, trim, skip=('-z',))
            if axis == 'x': acc.box(oc - ow / 2, oc + ow / 2, c, c + d, z0 + oh, z0 + oh + t, trim)
            else: acc.box(c, c + d, oc - ow / 2, oc + ow / 2, z0 + oh, z0 + oh + t, trim)

def cove_ceiling(acc, emit_acc, x0, x1, y0, y1, Hc, Ht, mat, dark, emit, cell=1.0, strips=None):
    """Ceiling at Hc with a 0.3 m perimeter cove recessed up to Ht; a 0.05 m emit strip on the cove's inner lip (lights the cove)."""
    cv = 0.3; ix0, ix1, iy0, iy1 = x0 + cv, x1 - cv, y0 + cv, y1 - cv
    acc.gquad((ix0, iy0, Hc), (ix0, iy1, Hc), (ix1, iy1, Hc), (ix1, iy0, Hc), mat, cell=cell)      # faces down
    # cove top (Ht) ring, facing down
    for a, b, c_, d in (((x0, y0), (x0, y1), (ix0, y1), (ix0, y0)), ((ix1, y0), (ix1, y1), (x1, y1), (x1, y0)),
                        ((ix0, y0), (ix0, iy0), (ix1, iy0), (ix1, y0)), ((ix0, iy1), (ix0, y1), (ix1, y1), (ix1, iy1))):
        acc.gquad((*a, Ht), (*b, Ht), (*c_, Ht), (*d, Ht), mat, cell=cell)
    # lip faces (vertical, Hc..Ht, facing the wall)
    acc.gquad((ix0, iy1, Hc), (ix0, iy0, Hc), (ix0, iy0, Ht), (ix0, iy1, Ht), mat, cell=cell)
    acc.gquad((ix1, iy0, Hc), (ix1, iy1, Hc), (ix1, iy1, Ht), (ix1, iy0, Ht), mat, cell=cell)
    acc.gquad((ix0, iy0, Hc), (ix1, iy0, Hc), (ix1, iy0, Ht), (ix0, iy0, Ht), mat, cell=cell)
    acc.gquad((ix1, iy1, Hc), (ix0, iy1, Hc), (ix0, iy1, Ht), (ix1, iy1, Ht), mat, cell=cell)
    # LED strip on the lip's outer face, top 0.05 m, 0.01 proud
    e = 0.012; z0, z1 = Hc + 0.06, Hc + 0.11
    emit_acc.box(ix0 - e, ix0, iy0, iy1, z0, z1, emit, skip=('+x', '-z', '+z'))
    emit_acc.box(ix1, ix1 + e, iy0, iy1, z0, z1, emit, skip=('-x', '-z', '+z'))
    emit_acc.box(ix0, ix1, iy0 - e, iy0, z0, z1, emit, skip=('+y', '-z', '+z'))
    emit_acc.box(ix0, ix1, iy1, iy1 + e, z0, z1, emit, skip=('-y', '-z', '+z'))
    if strips is not None:
        L = [((ix0 + ix1) / 2, iy0, 'x', ix1 - ix0), ((ix0 + ix1) / 2, iy1, 'x', ix1 - ix0), (ix0, (iy0 + iy1) / 2, 'y', iy1 - iy0), (ix1, (iy0 + iy1) / 2, 'y', iy1 - iy0)]
        for cx, cy, ax, ln in L: strips.append(dict(kind='cove', x=cx, y=cy, z=(z0 + z1) / 2, ax=ax, len=ln, k=0.55))

def downlight(acc, x, y, Hc, dark, emit):
    acc.cyl(x, y, Hc - 0.012, Hc, 0.12, 12, dark, caps=(True, False))
    acc.cyl(x, y, Hc - 0.016, Hc - 0.012, 0.075, 12, emit, caps=(True, False))

def floor_grid(acc, x0, x1, y0, y1, z, mat, cell=1.0, uvo=(0, 0)):
    acc.gquad((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), mat, cell=cell, uvo=uvo)
