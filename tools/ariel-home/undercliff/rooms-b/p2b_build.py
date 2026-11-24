# p2-rooms-b builder (game room, office, guest 1-4) per layout.md "P2 room spec".
# Run: blender-4.2 -b --factory-startup -P p2b_build.py   (env P2B_RENDER=1 to render after save)
# Frame: metres. x = X (east of bay centre), y = -D (D = metres into cliff), z = H (pool-deck floor = 0).
# To P1/mansion units: x_u = 1.78*x, y_u = -2.9 + 1.78*y, z_u = -18.2 + 1.78*z.
import bpy, bmesh, math, os, json, random
from mathutils import Vector
OUTD = "/workspace/jots-t1516/undercliff"
BLEND = os.path.join(OUTD, "p2-rooms-b.blend")
REND = os.path.join(OUTD, "p2-rooms-b-renders")
TEX = "/workspace/jots-cliffs/assets/ariel-home/tex"
STRATA = "/workspace/scratch/cliff-render/tex"
G = 0.12          # P1 blockout room-box inset from the layout lines (box faces = wall inner faces)
WT = 0.25         # wall thickness (door reveal depth)
COVE = 0.3
random.seed(7)

# ---------------- reset scene ----------------
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.unit_settings.system = 'METRIC'; sc.unit_settings.scale_length = 1.0

# ---------------- materials ----------------
def img(path, noncolor):
    im = bpy.data.images.load(path, check_existing=True)
    if noncolor: im.colorspace_settings.name = 'Non-Color'
    return im
def pbr(name, col, nrm, orm):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; n = nt.nodes; l = nt.links; n.clear()
    out = n.new('ShaderNodeOutputMaterial'); out.location = (600, 0)
    b = n.new('ShaderNodeBsdfPrincipled'); b.location = (300, 0)
    l.new(b.outputs[0], out.inputs[0])
    tc = n.new('ShaderNodeTexImage'); tc.image = img(col, False); tc.location = (-400, 300)
    to = n.new('ShaderNodeTexImage'); to.image = img(orm, True); to.location = (-400, 0)
    tn = n.new('ShaderNodeTexImage'); tn.image = img(nrm, True); tn.location = (-400, -300)
    sp = n.new('ShaderNodeSeparateColor'); sp.location = (-100, 0)
    nm = n.new('ShaderNodeNormalMap'); nm.location = (-100, -300)
    l.new(tc.outputs[0], b.inputs['Base Color'])
    l.new(to.outputs[0], sp.inputs[0])
    l.new(sp.outputs[1], b.inputs['Roughness']); l.new(sp.outputs[2], b.inputs['Metallic'])
    l.new(tn.outputs[0], nm.inputs['Color']); l.new(nm.outputs[0], b.inputs['Normal'])
    return m
MATS = {}
MATS['uc_rock'] = pbr('uc_rock', f"{STRATA}/strata-color-2k.png", f"{STRATA}/strata-nrm-2k.png", f"{STRATA}/strata-orm-2k.png")
for k in ('concrete', 'slate', 'wood', 'dark'):
    MATS['uc_' + k] = pbr('uc_' + k, f"{TEX}/{k}-color-2k.webp", f"{TEX}/{k}-nrm-2k.webp", f"{TEX}/{k}-orm-2k.webp")
em = bpy.data.materials.new('uc_emit'); em.use_nodes = True
bs = em.node_tree.nodes['Principled BSDF']
bs.inputs['Base Color'].default_value = (1, 0.85, 0.6, 1)
bs.inputs['Emission Color'].default_value = (1, 0.85, 0.6, 1)
bs.inputs['Emission Strength'].default_value = 4.0
bs.inputs['Roughness'].default_value = 0.5
MATS['uc_emit'] = em
MORDER = ['uc_rock', 'uc_concrete', 'uc_slate', 'uc_wood', 'uc_dark', 'uc_emit']
MI = {k: i for i, k in enumerate(MORDER)}

# ---------------- mesh builder ----------------
class Acc:
    """Builds one object. Coordinates passed in room space (X, D, H metres); stored as world metres (X, -D, H)."""
    def __init__(s, name, origin):
        s.name = name; s.o = Vector(origin); s.bm = bmesh.new(); s.uvk = []; s.uvtab = []
    def W(s, X, D, H): return Vector((X, -D, H))
    def _uv(s, scale, off): s.uvtab.append((scale, off, None)); return len(s.uvtab) - 1
    def face(s, pts, mat, hint, scale=4.0, off=(0, 0), axis=None):
        vs = [s.bm.verts.new(p) for p in pts]
        f = s.bm.faces.new(vs); f.normal_update()
        if f.normal.dot(Vector(hint)) < 0: f.normal_flip()
        f.material_index = MI[mat]; s.uvtab.append((scale, off, axis)); s.uvk.append((f, len(s.uvtab) - 1)); return f
    def box(s, X, D, H, mat, scale=2.0, off=None, bevel=False, skip=()):
        off = off if off is not None else (random.random(), random.random())
        x0, x1 = sorted(X); d0, d1 = sorted(D); h0, h1 = sorted(H)
        p, q = s.W(x0, d0, h0), s.W(x1, d1, h1)
        a = Vector((min(p.x, q.x), min(p.y, q.y), min(p.z, q.z))); b = Vector((max(p.x, q.x), max(p.y, q.y), max(p.z, q.z)))
        r = bmesh.ops.create_cube(s.bm, size=1.0)
        vs = r['verts']
        for v in vs:
            v.co = Vector((a.x if v.co.x < 0 else b.x, a.y if v.co.y < 0 else b.y, a.z if v.co.z < 0 else b.z))
        faces = list({f for v in vs for f in v.link_faces})
        for f in faces: f.normal_update(); f.material_index = MI[mat]
        if bevel:
            top = [e for e in {e for v in vs for e in v.link_edges} if all(v.co.z > (a.z + b.z) / 2 for v in e.verts)]
            res = bmesh.ops.bevel(s.bm, geom=top, offset=min(0.02, (b.z - a.z) / 3), segments=1, affect='EDGES', profile=0.5)
            faces = list({f for v in vs if v.is_valid for f in v.link_faces} | set(res.get('faces', [])))
            for f in faces: f.material_index = MI[mat]
        kill = []
        for f in faces:
            if not f.is_valid: continue
            f.normal_update(); n = f.normal
            if ('-z' in skip and n.z < -0.9) or ('+z' in skip and n.z > 0.9) or ('-y' in skip and n.y < -0.9) or ('+y' in skip and n.y > 0.9) or ('-x' in skip and n.x < -0.9) or ('+x' in skip and n.x > 0.9):
                kill.append(f)
        if kill: bmesh.ops.delete(s.bm, geom=kill, context='FACES_ONLY')
        k = s._uv(scale, off)
        for f in faces:
            if f.is_valid: s.uvk.append((f, k))
    def cyl(s, X, D, H, r, mat, seg=8, caps=True, scale=2.0, r2=None):
        h0, h1 = H
        res = bmesh.ops.create_cone(s.bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h1 - h0)
        c = s.W(X, D, (h0 + h1) / 2)
        for v in res['verts']: v.co += c
        k = s._uv(scale, (random.random(), random.random()))
        for f in {f for v in res['verts'] for f in v.link_faces}:
            f.material_index = MI[mat]; s.uvk.append((f, k))
    def tris(s): return sum(len(f.verts) - 2 for f in s.bm.faces)
    def finish(s, coll, props=None):
        bm = s.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
        uvl = bm.loops.layers.uv.new("UVMap")
        for f, k in s.uvk:
            if not f.is_valid: continue
            scale, off, axf = s.uvtab[k]
            f.normal_update(); n = Vector(axf) if axf else f.normal; ax = max(range(3), key=lambda i: abs(n[i]))
            rock = (f.material_index == MI['uc_rock'])
            for lp in f.loops:
                p = lp.vert.co
                u, v = ((p.y, p.z) if ax == 0 else (p.x, p.z) if ax == 1 else (p.x, p.y))
                if ax == 0 and n.x < 0: u = -u
                if ax == 1 and n.y > 0: u = -u
                if rock: u, v = v, -u          # strata bands run horizontally
                lp[uvl].uv = (u / scale + off[0], v / scale + off[1])
        for v in bm.verts: v.co -= s.o            # origin at room floor centre
        me = bpy.data.meshes.new(s.name); bm.to_mesh(me); bm.free()
        used = sorted({p.material_index for p in me.polygons})
        remap = {m: i for i, m in enumerate(used)}
        for m in used: me.materials.append(MATS[MORDER[m]])
        for p in me.polygons: p.material_index = remap[p.material_index]
        for p in me.polygons: p.use_smooth = False
        ob = bpy.data.objects.new(s.name, me); ob.location = s.o; coll.objects.link(ob)
        for k, v in (props or {}).items(): ob[k] = v
        return ob

# ---------------- shell ----------------
def rock_grid(A, mat_pts, nu, nv, inward, amp=0.2):
    """mat_pts(u,v)->Vector world point on wall plane, u,v in [0,1]. Inward = room-pointing normal."""
    P = {}
    for i in range(nu + 1):
        for j in range(nv + 1):
            p = mat_pts(i / nu, j / nv)
            if 0 < i < nu and 0 < j < nv:
                d = amp * (0.3 + 0.7 * random.random()) * (0.55 + 0.45 * math.sin(j * 2.1 + i * 0.35)) * (1.0 if j % 2 else 0.55)
                p = p + Vector(inward) * d
            P[i, j] = p
    for i in range(nu):
        for j in range(nv):
            a, b, c, d = P[i, j], P[i + 1, j], P[i + 1, j + 1], P[i, j + 1]
            A.face([a, b, c], 'uc_rock', inward, axis=inward); A.face([a, c, d], 'uc_rock', inward, axis=inward)

def shell(key, R, coll, door, rock_side, floor_regions=None):
    """R: dict X,D,H (layout lines). door: (side, centre_along, width, height). side in W,E,N,S (N = small D, S = large D)."""
    x0, x1 = R['X'][0] + G, R['X'][1] - G; d0, d1 = R['D'][0] + G, R['D'][1] - G; Hc = R['H'][1]; Ht = Hc + COVE
    O = (sum(R['X']) / 2, -sum(R['D']) / 2, 0.0)
    # floor
    F = Acc(f"{key}_floor", O)
    regs = floor_regions or [((x0, x1), (d0, d1), 'uc_wood')]
    for (X, D, m) in regs:
        F.face([F.W(X[0], D[0], 0), F.W(X[1], D[0], 0), F.W(X[1], D[1], 0), F.W(X[0], D[1], 0)], m, (0, 0, 1))
    # door threshold strip in the reveal
    side, c, w, h = door
    # walls
    Wl = Acc(f"{key}_walls", O)
    walls = {  # side: (fixed coord, along range, inward normal, point fn)
        'W': (lambda a, z: Wl.W(x0, a, z), (d0, d1), (1, 0, 0)),
        'E': (lambda a, z: Wl.W(x1, a, z), (d0, d1), (-1, 0, 0)),
        'N': (lambda a, z: Wl.W(a, d0, z), (x0, x1), (0, -1, 0)),   # N: D=d0, room is toward +D = -y
        'S': (lambda a, z: Wl.W(a, d1, z), (x0, x1), (0, 1, 0)),
    }
    for sd, (pf, (a0, a1), nrm) in walls.items():
        if sd == rock_side:
            rock_grid(Wl, lambda u, v: pf(a0 + (a1 - a0) * u, Ht * v), max(6, int((a1 - a0) / 0.75)), 6, nrm)
            continue
        def q(aa, ab, za, zb):
            Wl.face([pf(aa, za), pf(ab, za), pf(ab, zb), pf(aa, zb)], 'uc_concrete', nrm)
        if sd == side:
            u0, u1 = c - w / 2, c + w / 2
            q(a0, u0, 0, Ht); q(u1, a1, 0, Ht); q(u0, u1, h, Ht)
            out = Vector(nrm) * -WT
            for (pa, pb) in ((pf(u0, 0), pf(u0, h)), (pf(u1, 0), pf(u1, h))):
                cen = (pf(u0, 0) + pf(u1, 0)) / 2
                Wl.face([pa, pb, pb + out, pa + out], 'uc_concrete', (cen - pa).normalized())
            Wl.face([pf(u0, h), pf(u1, h), pf(u1, h) + out, pf(u0, h) + out], 'uc_concrete', (0, 0, -1))
            Wl.face([pf(u0, 0), pf(u1, 0), pf(u1, 0) + out, pf(u0, 0) + out], 'uc_dark', (0, 0, 1))  # threshold
        else:
            q(a0, a1, 0, Ht)
        # skirting 0.1 m (front face + top), skipped across the door
        segs = [(a0, a1)] if sd != side else [(a0, c - w / 2), (c + w / 2, a1)]
        if sd != rock_side:
            for (sa, sb) in segs:
                n = Vector(nrm) * 0.015
                Wl.face([pf(sa, 0) + n, pf(sb, 0) + n, pf(sb, 0.1) + n, pf(sa, 0.1) + n], 'uc_dark', nrm, 1.0)
                Wl.face([pf(sa, 0.1), pf(sb, 0.1), pf(sb, 0.1) + n, pf(sa, 0.1) + n], 'uc_dark', (0, 0, 1), 1.0)
    # rock wall foot: dark skirting strip (a slot in front of the rock)
    pf, (a0, a1), nrm = walls[rock_side]
    n = Vector(nrm) * 0.16
    Wl.face([pf(a0, 0) + n, pf(a1, 0) + n, pf(a1, 0.1) + n, pf(a0, 0.1) + n], 'uc_dark', nrm, 1.0)
    Wl.face([pf(a0, 0.1), pf(a1, 0.1), pf(a1, 0.1) + n * 0.7, pf(a0, 0.1) + n * 0.7], 'uc_dark', (0, 0, 1), 1.0)
    Wl.face([pf(a0, 0.1) + n * 0.7, pf(a1, 0.1) + n * 0.7, pf(a1, 0.1) + n * 0.85, pf(a0, 0.1) + n * 0.85], 'uc_emit', (0, 0, 1), 1.0)   # rock-foot uplight strip
    Wl.face([pf(a0, 0.1) + n * 0.85, pf(a1, 0.1) + n * 0.85, pf(a1, 0.1) + n, pf(a0, 0.1) + n], 'uc_dark', (0, 0, 1), 1.0)
    # ceiling with 0.3 m recessed perimeter cove + 0.05 m LED strip
    C = Acc(f"{key}_ceil", O)
    i0, i1, j0, j1 = x0 + COVE, x1 - COVE, d0 + COVE, d1 - COVE
    C.face([C.W(i0, j0, Hc), C.W(i1, j0, Hc), C.W(i1, j1, Hc), C.W(i0, j1, Hc)], 'uc_concrete', (0, 0, -1))
    ring_o = [(x0, d0), (x1, d0), (x1, d1), (x0, d1)]; ring_i = [(i0, j0), (i1, j0), (i1, j1), (i0, j1)]
    for k in range(4):
        (ax, ad), (bx, bd) = ring_o[k], ring_o[(k + 1) % 4]; (cx, cd), (dx, dd) = ring_i[k], ring_i[(k + 1) % 4]
        C.face([C.W(ax, ad, Ht), C.W(bx, bd, Ht), C.W(dx, dd, Ht), C.W(cx, cd, Ht)], 'uc_concrete', (0, 0, -1))
        # cove drop face (faces the wall), lip
        out = (C.W((cx + dx) / 2, (cd + dd) / 2, 0) - C.W(sum(R['X']) / 2, sum(R['D']) / 2, 0)); out.z = 0
        ax_ = max(range(2), key=lambda i: abs(out[i])); on = Vector((0, 0, 0)); on[ax_] = math.copysign(1, out[ax_])
        C.face([C.W(cx, cd, Hc), C.W(dx, dd, Hc), C.W(dx, dd, Ht), C.W(cx, cd, Ht)], 'uc_concrete', on)
        # LED strip: 0.05 m tall, 0.01 proud of the drop face, top of the cove
        e = on * 0.01
        C.face([C.W(cx, cd, Ht - 0.09) + e, C.W(dx, dd, Ht - 0.09) + e, C.W(dx, dd, Ht - 0.04) + e, C.W(cx, cd, Ht - 0.04) + e], 'uc_emit', on, 1.0)
    return dict(F=F, W=Wl, C=C, O=O, x0=x0, x1=x1, d0=d0, d1=d1, Hc=Hc, Ht=Ht)

# ---------------- fixtures ----------------
LIGHTS = {}
def lamp_empty(coll, room, n, X, D, H, kind, k=1.0, extra=None):
    e = bpy.data.objects.new(f"L_{room}_{n}", None); e.empty_display_type = 'SPHERE'; e.empty_display_size = 0.12
    e.location = (X, -D, H); coll.objects.link(e)
    e['rgb'] = [1.0, 0.85, 0.6]; e['reach_m'] = 12.0; e['k'] = k; e['kind'] = kind
    for a, b in (extra or {}).items(): e[a] = b
    LIGHTS.setdefault(room, []).append((e.name, kind, round(X, 2), round(D, 2), round(H, 2), k))
def downlight(S, X, D):
    C = S['C']; H = S['Hc']
    # dark ring (8-seg annulus, 0.005 below ceiling) + emit disc 0.15 m
    ro, ri, n = 0.12, 0.075, 8
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p = lambda r, a: C.W(X + r * math.cos(a), D + r * math.sin(a), H - 0.005)
        C.face([p(ri, a0), p(ro, a0), p(ro, a1), p(ri, a1)], 'uc_dark', (0, 0, -1), 0.5)
    C.face([C.W(X + ri * math.cos(2 * math.pi * i / n), D + ri * math.sin(2 * math.pi * i / n), H - 0.004) for i in range(n)], 'uc_emit', (0, 0, -1), 1.0)
def coves(coll, room, S, start):
    xm, dm = (S['x0'] + S['x1']) / 2, (S['d0'] + S['d1']) / 2; z = S['Ht'] - 0.065; n = start
    lamp_empty(coll, room, n, xm, S['d1'] - 0.12, 0.1, 'rock_wash', 0.55, {'strip_len_m': round(S['x1'] - S['x0'], 2), 'aim': 'up'}); n += 1
    for (X, D, L) in ((xm, S['d0'] + COVE, S['x1'] - S['x0']), (xm, S['d1'] - COVE, S['x1'] - S['x0']), (S['x0'] + COVE, dm, S['d1'] - S['d0']), (S['x1'] - COVE, dm, S['d1'] - S['d0'])):
        lamp_empty(coll, room, n, X, D, z, 'cove', 0.55, {'strip_len_m': round(L - 2 * COVE, 2)}); n += 1
    return n

# ---------------- furniture kit ----------------
def sofa(A, X0, X1, D0, D1, back_side, seats=3):
    """Low modern sofa: wood plinth, concrete-textured upholstery (reads as grey woven fabric), separate seat cushions."""
    A.box((X0, X1), (D0, D1), (0, 0.12), 'uc_wood', 1.0, skip=('-z',))
    A.box((X0 + 0.02, X1 - 0.02), (D0 + 0.02, D1 - 0.02), (0.12, 0.30), 'uc_concrete', 1.5, skip=('-z',))
    t = 0.22
    if back_side in ('S', 'N'):
        bd = (D1 - t, D1) if back_side == 'S' else (D0, D0 + t)
        A.box((X0, X1), bd, (0.30, 0.78), 'uc_concrete', 1.5, bevel=True, skip=('-z',))
        sd = (D0, D1 - t) if back_side == 'S' else (D0 + t, D1)
        A.box((X0, X0 + 0.2), sd, (0.30, 0.62), 'uc_concrete', 1.5, skip=('-z',)); A.box((X1 - 0.2, X1), sd, (0.30, 0.62), 'uc_concrete', 1.5, skip=('-z',))
        w = (X1 - X0 - 0.4) / seats
        for i in range(seats):
            A.box((X0 + 0.2 + i * w + 0.01, X0 + 0.2 + (i + 1) * w - 0.01), sd, (0.30, 0.45), 'uc_concrete', 1.5, bevel=True, skip=('-z',))
    else:
        bx = (X1 - t, X1) if back_side == 'E' else (X0, X0 + t)
        A.box(bx, (D0, D1), (0.30, 0.78), 'uc_concrete', 1.5, bevel=True, skip=('-z',))
        sx = (X0, X1 - t) if back_side == 'E' else (X0 + t, X1)
        A.box(sx, (D0, D0 + 0.2), (0.30, 0.62), 'uc_concrete', 1.5, skip=('-z',)); A.box(sx, (D1 - 0.2, D1), (0.30, 0.62), 'uc_concrete', 1.5, skip=('-z',))
        w = (D1 - D0 - 0.4) / seats
        for i in range(seats):
            A.box(sx, (D0 + 0.2 + i * w + 0.01, D0 + 0.2 + (i + 1) * w - 0.01), (0.30, 0.45), 'uc_concrete', 1.5, bevel=True, skip=('-z',))
def table4(A, X, D, H, top_mat='uc_wood', leg=0.05, inset=0.08, top=0.04, legmat='uc_dark'):
    A.box(X, D, (H - top, H), top_mat, 1.5, bevel=True)
    for (x, d) in ((X[0] + inset, D[0] + inset), (X[1] - inset, D[0] + inset), (X[1] - inset, D[1] - inset), (X[0] + inset, D[1] - inset)):
        A.box((x - leg / 2, x + leg / 2), (d - leg / 2, d + leg / 2), (0, H - top), legmat, 1.0, skip=('-z', '+z'))
def books(A, X0, X1, D0, D1, H0, horizontal_x=True):
    x = X0
    while x < X1 - 0.05:
        w = random.uniform(0.025, 0.06); h = random.uniform(0.18, 0.3)
        if random.random() < 0.12: x += random.uniform(0.08, 0.2); continue
        m = random.choice(['uc_wood', 'uc_dark', 'uc_concrete', 'uc_slate'])
        A.box((x, min(x + w, X1)), (D0, D0 + random.uniform(0.15, D1 - D0)), (H0, H0 + h), m, 0.6, skip=('-z',))
        x += w + 0.004
def stool(A, X, D, h=0.75):
    A.cyl(X, D, (0, h - 0.05), 0.025, 'uc_dark', 6, caps=False)
    A.cyl(X, D, (0, 0.02), 0.2, 'uc_dark', 8)
    A.cyl(X, D, (0.28, 0.3), 0.16, 'uc_dark', 8, caps=False)       # footring
    A.cyl(X, D, (h - 0.05, h), 0.19, 'uc_wood', 10)
def rug(A, X, D, mat='uc_concrete', t=0.012):
    A.box(X, D, (0, t), mat, 1.2, skip=('-z',))
def planter(A, X, D):
    A.cyl(X, D, (0, 0.55), 0.24, 'uc_concrete', 10, r2=0.2, scale=1.0)

# ---------------- rooms ----------------
LAY = {
 'game':   dict(X=(2, 16), D=(40, 52), H=(0, 3.8)),
 'office': dict(X=(2, 10), D=(31, 38), H=(0, 3.6)),
}
for i in range(4):
    LAY['guest%d' % (i + 1)] = dict(X=(-26 + 6 * i, -20 + 6 * i), D=(31, 37.5), H=(0, 3.5))
DOORS = {}
REPORT = {}
def new_coll(name):
    c = bpy.data.collections.new(name); sc.collection.children.link(c); return c

def build_game():
    R = LAY['game']; key = 'game'; coll = new_coll('uc_game')
    door = ('W', 42.0, 1.2, 2.6)       # west wall onto the spine corridor
    DOORS[key] = door
    S = shell(key, R, coll, door, 'S')
    x0, x1, d0, d1 = S['x0'], S['x1'], S['d0'], S['d1']
    # rock-wall LED washer at the foot + concrete feature wainscot on the east screen wall
    for (X, D) in ((5.0, 44.0), (5.0, 49.0), (11.5, 44.0), (11.5, 49.0)):
        downlight(S, X, D)
    n = 1
    for (X, D) in ((5.0, 44.0), (5.0, 49.0), (11.5, 44.0), (11.5, 49.0)):
        lamp_empty(coll, key, n, X, D, S['Hc'] - 0.01, 'downlight'); n += 1
    # --- pool table (collide) ---
    T = Acc('game_prop_pooltable', S['O']); cx, cd = 6.0, 46.5   # long axis along D
    L2, W2 = 1.42, 0.79
    T.box((cx - 0.55, cx + 0.55), (cd - 1.0, cd - 0.6), (0, 0.62), 'uc_dark', 1.0, skip=('-z',))
    T.box((cx - 0.55, cx + 0.55), (cd + 0.6, cd + 1.0), (0, 0.62), 'uc_dark', 1.0, skip=('-z',))
    T.box((cx - 0.12, cx + 0.12), (cd - 0.6, cd + 0.6), (0.1, 0.5), 'uc_dark', 1.0)
    T.box((cx - W2 + 0.06, cx + W2 - 0.06), (cd - L2 + 0.06, cd + L2 - 0.06), (0.62, 0.74), 'uc_wood', 1.5)   # apron
    T.box((cx - W2 + 0.14, cx + W2 - 0.14), (cd - L2 + 0.14, cd + L2 - 0.14), (0.74, 0.79), 'uc_slate', 2.0, skip=('-z',))  # bed
    for (X, D) in (((cx - W2, cx - W2 + 0.14), (cd - L2, cd + L2)), ((cx + W2 - 0.14, cx + W2), (cd - L2, cd + L2)),
                   ((cx - W2 + 0.14, cx + W2 - 0.14), (cd - L2, cd - L2 + 0.14)), ((cx - W2 + 0.14, cx + W2 - 0.14), (cd + L2 - 0.14, cd + L2))):
        T.box(X, D, (0.70, 0.83), 'uc_wood', 1.0, bevel=True)
    for (X, D) in ((cx - W2 + 0.1, cd - L2 + 0.1), (cx + W2 - 0.1, cd - L2 + 0.1), (cx - W2 + 0.1, cd), (cx + W2 - 0.1, cd), (cx - W2 + 0.1, cd + L2 - 0.1), (cx + W2 - 0.1, cd + L2 - 0.1)):
        T.cyl(X, D, (0.80, 0.835), 0.065, 'uc_dark', 8, caps=True)  # brass pocket rims
    # balls (low-poly, dark/concrete/wood variety) racked + cue on table
    for i, (dx, dd) in enumerate([(0, 0), (-0.03, 0.055), (0.03, 0.055), (-0.06, 0.11), (0, 0.11), (0.06, 0.11)]):
        T.cyl(cx + dx, cd + 0.6 + dd, (0.79, 0.85), 0.028, random.choice(['uc_concrete', 'uc_wood', 'uc_dark']), 8)
    T.cyl(cx, cd - 0.7, (0.79, 0.85), 0.028, 'uc_concrete', 8)
    # --- pendant over table (linear, dark body, emit underside) ---
    P = Acc('game_props', S['O'])
    P.box((cx - 0.12, cx + 0.12), (cd - 0.95, cd + 0.95), (2.55, 2.63), 'uc_dark', 1.0)
    P.box((cx - 0.09, cx + 0.09), (cd - 0.9, cd + 0.9), (2.545, 2.55), 'uc_emit', 1.0, skip=('+z',))
    for dd in (-0.8, 0.8):
        P.cyl(cx, cd + dd, (2.63, S['Hc']), 0.006, 'uc_dark', 4, caps=False)
    lamp_empty(coll, key, n, cx, cd, 2.53, 'pendant', 1.0, {'len_m': 1.9}); n += 1
    # --- cue rack on the west wall ---
    P.box((x0, x0 + 0.08), (46.0, 47.6), (0.9, 1.0), 'uc_wood', 1.0)
    P.box((x0, x0 + 0.08), (46.0, 47.6), (1.75, 1.85), 'uc_wood', 1.0)
    for i in range(6):
        P.cyl(x0 + 0.05, 46.15 + i * 0.25, (0.95, 1.8), 0.013, 'uc_wood', 5, caps=False, r2=0.008)
    # --- screen wall (east), uc_dark slab with wood surround + low media console ---
    P.box((x1 - 0.05, x1), (43.2, 48.8), (0.55, 2.95), 'uc_wood', 2.0, skip=('+x',))
    P.box((x1 - 0.09, x1 - 0.05), (43.5, 48.5), (0.9, 2.7), 'uc_dark', 4.0, skip=('+x',))
    P.box((x1 - 0.45, x1), (43.6, 48.4), (0, 0.42), 'uc_wood', 1.5, bevel=True, skip=('-z', '+x'))
    for dd in (44.6, 46.0, 47.4):
        P.box((x1 - 0.452, x1 - 0.44), (dd - 0.6, dd + 0.6), (0.06, 0.36), 'uc_dark', 1.0)
    # --- sofa group facing the screen ---
    sofa(P, 9.8, 10.8, 43.6, 48.4, 'W', seats=3)
    sofa(P, 10.8, 13.0, 48.4, 49.4, 'S', seats=2)
    table4(P, (11.5, 12.6), (44.8, 47.2), 0.4, 'uc_wood', inset=0.1)
    rug(P, (9.6, 14.6), (43.2, 49.8))
    lamp_empty(coll, key, n, 10.3, 48.9, 1.6, 'floorlamp', 1.0); n += 1
    P.cyl(10.3, 48.9, (0, 0.03), 0.18, 'uc_dark', 8)
    P.cyl(10.3, 48.9, (0.03, 1.45), 0.015, 'uc_dark', 6, caps=False)
    P.cyl(10.3, 48.9, (1.45, 1.75), 0.2, 'uc_wood', 12, caps=False, r2=0.14)
    P.cyl(10.3, 48.9, (1.47, 1.49), 0.17, 'uc_emit', 10, caps=True)
    # --- planters along rock wall (concrete pots; greenery comes at integration if Cliffs allows leaf) ---
    for X in (3.2, 8.8, 14.6):
        planter(P, X, d1 - 0.5)
    # --- bar (collide) along the north wall, east half, with back shelving ---
    B = Acc('game_prop_bar', S['O'])
    B.box((9.2, 14.8), (d0 + 0.9, d0 + 1.5), (0, 1.0), 'uc_dark', 2.0, skip=('-z',))
    B.box((9.15, 14.85), (d0 + 0.85, d0 + 1.6), (1.0, 1.06), 'uc_wood', 2.0, bevel=True)
    B.box((9.2, 14.8), (d0 + 1.5, d0 + 1.55), (0.06, 0.1), 'uc_emit', 1.0, skip=('-z',))       # toe-kick glow
    B.box((9.2, 14.8), (d0, d0 + 0.6), (0, 0.9), 'uc_wood', 2.0, skip=('-z', '-y'))            # back counter
    B.box((9.2, 14.8), (d0, d0 + 0.62), (0.9, 0.94), 'uc_slate', 2.0, bevel=True)
    for h in (1.45, 1.95):
        B.box((9.4, 14.6), (d0, d0 + 0.28), (h, h + 0.04), 'uc_wood', 1.5, bevel=True)
        for i in range(10):
            xb = 9.6 + i * 0.5 + random.uniform(-0.1, 0.1)
            B.cyl(xb, d0 + 0.14, (h + 0.04, h + 0.04 + random.uniform(0.2, 0.32)), 0.035, random.choice(['uc_dark', 'uc_slate', 'uc_wood']), 6)
    B.box((9.4, 14.6), (d0, d0 + 0.02), (1.42, 1.45), 'uc_emit', 1.0)
    for i in range(4):
        stool(P, 10.0 + i * 1.4, d0 + 2.0)
    lamp_empty(coll, key, n, 12.0, d0 + 0.2, 1.43, 'shelf_strip', 0.55, {'strip_len_m': 5.2}); n += 1
    # --- side wall art: wood batten panel on the west wall ---
    for i in range(14):
        P.box((x0, x0 + 0.04), (48.4 + i * 0.2, 48.48 + i * 0.2), (0.6, 3.1), 'uc_wood', 2.0, skip=('-x',))
    rug(P, (4.2, 7.8), (44.3, 48.7), 'uc_concrete', 0.01)
    # arcade cabinets on the rock wall (dark body, wood cheeks, warm screen)
    for X in (11.4, 12.4, 13.4):
        P.box((X - 0.36, X + 0.36), (d1 - 0.95, d1 - 0.3), (0, 0.95), 'uc_dark', 1.0, skip=('-z',))
        P.box((X - 0.36, X + 0.36), (d1 - 0.75, d1 - 0.3), (0.95, 1.85), 'uc_dark', 1.0)
        for sx in (-0.38, 0.36):
            P.box((X + sx, X + sx + 0.02), (d1 - 0.98, d1 - 0.28), (0, 1.9), 'uc_wood', 1.0, skip=('-z',))
        P.box((X - 0.28, X + 0.28), (d1 - 0.765, d1 - 0.75), (1.1, 1.6), 'uc_emit', 1.0)
        P.box((X - 0.3, X + 0.3), (d1 - 1.0, d1 - 0.75), (0.95, 1.0), 'uc_wood', 1.0, bevel=True)
    lamp_empty(coll, key, n, 12.4, d1 - 0.9, 1.35, 'arcade_screens', 0.55, {'strip_len_m': 2.6}); n += 1
    # round card table + 4 chairs (collide)
    Ct = Acc('game_prop_cardtable', S['O']); tx, td = 5.6, 42.3
    Ct.cyl(tx, td, (0.72, 0.76), 0.6, 'uc_wood', 16, scale=1.5)
    Ct.cyl(tx, td, (0.02, 0.72), 0.06, 'uc_dark', 8, caps=False)
    Ct.cyl(tx, td, (0, 0.02), 0.32, 'uc_dark', 10)
    for k in range(4):
        a = k * math.pi / 2; X, D = tx + 0.85 * math.cos(a), td + 0.85 * math.sin(a)
        Ct.box((X - 0.22, X + 0.22), (D - 0.22, D + 0.22), (0.43, 0.47), 'uc_wood', 1.0, bevel=True)
        for (lx_, ld_) in ((-0.18, -0.18), (0.18, -0.18), (0.18, 0.18), (-0.18, 0.18)):
            Ct.box((X + lx_ - 0.018, X + lx_ + 0.018), (D + ld_ - 0.018, D + ld_ + 0.018), (0, 0.43), 'uc_dark', 1.0, skip=('-z', '+z'))
        bx_, bd_ = X + 0.24 * math.cos(a), D + 0.24 * math.sin(a)
        Ct.box((bx_ - 0.2 * abs(math.sin(a)) - 0.02, bx_ + 0.2 * abs(math.sin(a)) + 0.02), (bd_ - 0.2 * abs(math.cos(a)) - 0.02, bd_ + 0.2 * abs(math.cos(a)) + 0.02), (0.47, 0.85), 'uc_wood', 1.0)
    n = coves(coll, key, S, n)
    return coll, S, [T, P, B, Ct], {'game_prop_pooltable': 1, 'game_prop_bar': 1, 'game_prop_cardtable': 1}

def build_office():
    R = LAY['office']; key = 'office'; coll = new_coll('uc_office')
    door = ('W', 32.2, 1.2, 2.6); DOORS[key] = door
    S = shell(key, R, coll, door, 'S')
    x0, x1, d0, d1 = S['x0'], S['x1'], S['d0'], S['d1']
    n = 1
    for (X, D) in ((4.4, 33.4), (7.6, 33.4), (6.0, 36.2)):
        downlight(S, X, D); lamp_empty(coll, key, n, X, D, S['Hc'] - 0.01, 'downlight'); n += 1
    # desk (collide): faces the door / spine, back to the rock wall
    Dk = Acc('office_prop_desk', S['O']); cx, cd = 6.0, 35.4
    Dk.box((cx - 1.0, cx + 1.0), (cd - 0.42, cd + 0.42), (0.72, 0.76), 'uc_wood', 2.0, bevel=True)
    Dk.box((cx - 0.98, cx - 0.92), (cd - 0.4, cd + 0.4), (0, 0.72), 'uc_dark', 1.0, skip=('-z', '+z'))
    Dk.box((cx + 0.4, cx + 0.96), (cd - 0.38, cd + 0.38), (0, 0.72), 'uc_wood', 1.5, skip=('-z', '+z'))   # drawer pedestal
    for h in (0.24, 0.48):
        Dk.box((cx + 0.39, cx + 0.97), (cd - 0.39, cd - 0.38), (h - 0.006, h + 0.006), 'uc_dark', 1.0)
    Dk.box((cx - 0.92, cx + 0.4), (cd - 0.39, cd - 0.36), (0.3, 0.72), 'uc_dark', 1.0)            # modesty panel
    P = Acc('office_props', S['O'])
    # monitor + keyboard
    P.box((cx - 0.38, cx + 0.38), (cd - 0.3, cd - 0.27), (0.92, 1.36), 'uc_dark', 2.0)
    P.box((cx - 0.03, cx + 0.03), (cd - 0.36, cd - 0.3), (0.76, 0.95), 'uc_dark', 1.0)
    P.box((cx - 0.12, cx + 0.12), (cd - 0.4, cd - 0.24), (0.76, 0.77), 'uc_dark', 1.0, skip=('-z',))
    P.box((cx - 0.22, cx + 0.22), (cd + 0.06, cd + 0.2), (0.76, 0.78), 'uc_dark', 1.0, skip=('-z',))
    # desk lamp (brass/dark arm, emit under shade)
    lx, ld = cx - 0.75, cd - 0.05
    P.cyl(lx, ld, (0.76, 0.785), 0.08, 'uc_dark', 8)
    P.cyl(lx, ld, (0.785, 1.25), 0.008, 'uc_dark', 5, caps=False)
    P.box((lx - 0.008, lx + 0.008), (ld - 0.3, ld), (1.24, 1.256), 'uc_dark', 1.0)
    P.cyl(lx, ld - 0.3, (1.12, 1.25), 0.08, 'uc_dark', 10, caps=False, r2=0.035)
    P.cyl(lx, ld - 0.3, (1.13, 1.135), 0.075, 'uc_emit', 10)
    lamp_empty(coll, key, n, lx, ld - 0.3, 1.12, 'desklamp', 1.0, {'reach_m_note': 'task lamp'}); n += 1
    # chair: behind desk (sitter faces -D / the door wall)
    ch, chd = cx, cd + 0.85
    P.cyl(ch, chd, (0.06, 0.42), 0.03, 'uc_dark', 6, caps=False)
    for i in range(5):
        a = 2 * math.pi * i / 5
        P.box((ch + 0.3 * math.cos(a) - 0.025, ch + 0.3 * math.cos(a) + 0.025), (chd + 0.3 * math.sin(a) - 0.025, chd + 0.3 * math.sin(a) + 0.025), (0, 0.06), 'uc_dark', 1.0, skip=('-z',))
        P.box((min(ch, ch + 0.3 * math.cos(a)) - 0.015, max(ch, ch + 0.3 * math.cos(a)) + 0.015), (min(chd, chd + 0.3 * math.sin(a)) - 0.015, max(chd, chd + 0.3 * math.sin(a)) + 0.015), (0.05, 0.08), 'uc_dark', 1.0, skip=('-z',))
    P.box((ch - 0.26, ch + 0.26), (chd - 0.25, chd + 0.25), (0.42, 0.5), 'uc_concrete', 1.0, bevel=True, skip=('-z',))
    P.box((ch - 0.24, ch + 0.24), (chd + 0.22, chd + 0.3), (0.5, 1.05), 'uc_concrete', 1.0, bevel=True)
    for s in (-1, 1):
        P.box((ch + s * 0.26 - 0.02, ch + s * 0.26 + 0.02), (chd - 0.15, chd + 0.15), (0.62, 0.66), 'uc_wood', 1.0)
        P.box((ch + s * 0.26 - 0.015, ch + s * 0.26 + 0.015), (chd + 0.08, chd + 0.12), (0.45, 0.62), 'uc_dark', 1.0, skip=('-z', '+z'))
    # shelving along the east wall: 3 bays, wood carcass, books + objects
    Sh = Acc('office_prop_shelves', S['O'])
    sx0, sx1 = x1 - 0.38, x1
    Sh.box((sx0, sx1), (32.0, 37.2), (0, 0.08), 'uc_dark', 1.0, skip=('-z',))
    for dd in (32.0, 33.75, 35.5, 37.2):
        Sh.box((sx0, sx1), (dd - 0.02, dd + 0.02), (0.08, 2.6), 'uc_wood', 1.5, skip=('+x',))
    for h in (0.08, 0.5, 0.95, 1.4, 1.85, 2.3, 2.6):
        Sh.box((sx0, sx1), (32.0, 37.2), (h, h + 0.03), 'uc_wood', 1.5, bevel=(h > 1.3), skip=('+x',))
    for h in (0.53, 0.98, 1.43, 1.88, 2.33):
        for (a, b) in ((32.03, 33.72), (33.78, 35.47), (35.53, 37.17)):
            if random.random() < 0.2:
                Sh.cyl(sx0 + 0.18, (a + b) / 2, (h, h + 0.22), 0.07, random.choice(['uc_concrete', 'uc_slate']), 8); continue
            # books stand along D: build as boxes with x/D swapped
            d = a
            while d < b - 0.06:
                w = random.uniform(0.025, 0.06); hh = random.uniform(0.18, min(0.34, 0.42))
                if random.random() < 0.1: d += 0.15; continue
                Sh.box((sx1 - random.uniform(0.17, 0.3), sx1 - 0.02), (d, min(d + w, b)), (h, h + hh), random.choice(['uc_wood', 'uc_dark', 'uc_concrete', 'uc_slate']), 0.6, skip=('-z', '+x'))
                d += w + 0.004
    Sh.box((sx0 - 0.005, sx0), (32.0, 37.2), (2.57, 2.6), 'uc_emit', 1.0)   # under-cornice glow strip
    lamp_empty(coll, key, n, sx0 - 0.02, 34.6, 2.56, 'shelf_strip', 0.55, {'strip_len_m': 5.2}); n += 1
    # lounge chair + side table near the front, rug, planter
    sofa(P, 7.9, 9.2, 31.25, 32.15, 'N', seats=1)
    table4(P, (7.2, 7.7), (31.4, 31.9), 0.5, 'uc_slate', inset=0.05)
    rug(P, (4.4, 7.6), (34.0, 37.2))
    planter(P, 9.2, d1 - 0.5)
    planter(P, 2.8, d1 - 0.5)
    # cork/pin board: wood panel on the north wall
    P.box((3.4, 6.8), (d0, d0 + 0.03), (1.0, 2.2), 'uc_wood', 1.5, skip=('+y',))
    n = coves(coll, key, S, n)
    return coll, S, [Dk, P, Sh], {'office_prop_desk': 1, 'office_prop_shelves': 1}

def build_guest(i):
    key = 'guest%d' % i; R = LAY[key]; coll = new_coll('uc_' + key)
    X0, X1 = R['X']; mir = (i % 2 == 0)          # guests 2 and 4 are mirrored east-west for variety
    def mx(x): return (X0 + X1 - x) if mir else x
    def MX(a, b): return tuple(sorted((mx(a), mx(b))))
    x0g, x1g = X0 + G, X1 - G; d0, d1 = R['D'][0] + G, R['D'][1] - G
    door_c = mx(X0 + G + 1.1)
    door = ('N', door_c, 1.2, 2.6); DOORS[key] = door
    # en-suite nook in the front corner opposite the door: slate floor 2.2 x 2.3 m
    nx = MX(X1 - G - 2.2, X1 - G); nd = (d0, d0 + 2.3)
    # floor regions: wood everywhere except the nook
    regs = [((nx[0], nx[1]), nd, 'uc_slate')]
    if mir: regs += [((nx[1], x1g), (d0, d1), 'uc_wood'), ((x0g, nx[1]), (nd[1], d1), 'uc_wood')]
    else:   regs += [((x0g, nx[0]), (d0, d1), 'uc_wood'), ((nx[0], x1g), (nd[1], d1), 'uc_wood')]
    S = shell(key, R, coll, door, 'S', regs)
    n = 1
    for (X, D) in ((mx(X0 + 2.0), 32.6), (mx(X0 + 3.0), 35.4)):
        downlight(S, X, D); lamp_empty(coll, key, n, X, D, S['Hc'] - 0.01, 'downlight'); n += 1
    W = S['W']
    # nook partition (2.4 m tall, 0.1 thick) along the room side of the nook, with an opening
    pin = nx[0] if not mir else nx[1]         # x of the partition parallel to D
    sgn = -1 if not mir else 1                # room side direction in x
    p0, p1 = pin + sgn * 0.0, pin + sgn * 0.1
    W.box(tuple(sorted((p0, p1))), (nd[0], nd[1] - 0.9), (0, 2.4), 'uc_concrete', 4.0, skip=('-z', '+z' if False else 'none'))
    W.box(tuple(sorted((p0, p1))), (nd[0], nd[1] - 0.9), (2.4, 2.42), 'uc_wood', 1.0, skip=('-z',))
    W.box(nx, (nd[1] - 0.1, nd[1]), (0, 2.4), 'uc_concrete', 4.0, skip=('-z',)) if False else None
    # nook contents
    N = Acc(key + '_props', S['O'])
    # shower tray + slate wall panel at the back of the nook (against the corridor wall side)
    sx = MX(nx[1] - 1.0, nx[1]) if not mir else MX(nx[0], nx[0] + 1.0)
    sx = tuple(sorted((mx(X1 - G - 1.0), mx(X1 - G))))
    N.box(sx, (d0, d0 + 1.1), (0, 0.05), 'uc_slate', 1.0, skip=('-z',))
    wall_x = X1 - G if not mir else X0 + G
    N.box(tuple(sorted((wall_x, wall_x - sgn * -0.02 if False else wall_x + (-0.02 if not mir else 0.02)))), (d0, d0 + 1.1), (0.05, 2.2), 'uc_slate', 2.0)
    N.cyl(mx(X1 - G - 0.5), d0 + 0.55, (2.18, 2.2), 0.12, 'uc_dark', 8)           # rain head
    N.cyl(mx(X1 - G - 0.5), d0 + 0.55, (2.2, 2.6), 0.01, 'uc_dark', 4, caps=False)
    N.box(tuple(sorted((mx(X1 - G - 1.02), mx(X1 - G - 1.0)))), (d0, d0 + 1.0), (0.05, 2.0), 'uc_dark', 1.0)   # screen frame (open glassless screen: frame only)
    # vanity: floating wood unit + slate top + basin, mirror (dark slab, emit backlight) on the partition wall
    vx = tuple(sorted((mx(X1 - G - 0.55), mx(X1 - G))))
    N.box(vx, (d0 + 1.25, d0 + 2.15), (0.45, 0.85), 'uc_wood', 1.5, bevel=True)
    N.box(vx, (d0 + 1.23, d0 + 2.17), (0.85, 0.88), 'uc_slate', 1.5, bevel=True)
    N.cyl(mx(X1 - G - 0.28), d0 + 1.7, (0.88, 1.0), 0.18, 'uc_concrete', 10, r2=0.16)
    N.cyl(mx(X1 - G - 0.05), d0 + 1.7, (0.88, 1.08), 0.01, 'uc_dark', 4, caps=False)
    mxw = tuple(sorted((mx(X1 - G), mx(X1 - G - 0.03))))
    N.box(mxw, (d0 + 1.35, d0 + 2.05), (1.15, 1.95), 'uc_dark', 1.0)
    N.box(tuple(sorted((mx(X1 - G - 0.035), mx(X1 - G - 0.03)))), (d0 + 1.33, d0 + 2.07), (1.13, 1.15), 'uc_emit', 1.0)
    lamp_empty(coll, key, n, mx(X1 - G - 0.1), d0 + 1.7, 1.6, 'vanity', 0.55, {'strip_len_m': 0.7}); n += 1
    # wc (simple concrete bowl + cistern panel)
    N.box(tuple(sorted((mx(X1 - G - 2.15), mx(X1 - G - 1.55)))), (d0, d0 + 0.18), (0, 1.0), 'uc_concrete', 1.0, skip=('-z',))
    N.cyl(mx(X1 - G - 1.85), d0 + 0.45, (0, 0.42), 0.19, 'uc_concrete', 10, r2=0.2)
    # bed (collide), headboard against the rock wall
    Bd = Acc(key + '_prop_bed', S['O'])
    bxc = mx(X0 + 2.6); bw = 1.7
    BX = (bxc - bw / 2, bxc + bw / 2)
    Bd.box((BX[0] - 0.05, BX[1] + 0.05), (d1 - 2.15, d1 - 0.12), (0.1, 0.3), 'uc_wood', 2.0, bevel=True)
    Bd.box((BX[0] + 0.1, BX[1] - 0.1), (d1 - 2.05, d1 - 0.22), (0, 0.1), 'uc_dark', 1.0, skip=('-z',))
    Bd.box(BX, (d1 - 2.1, d1 - 0.15), (0.3, 0.52), 'uc_concrete', 1.2, bevel=True)                   # mattress
    Bd.box((BX[0] - 0.02, BX[1] + 0.02), (d1 - 1.6, d1 - 0.9), (0.4, 0.545), 'uc_wood', 1.0, bevel=True)  # throw (wood-tone woven)
    for s in (-1, 1):
        Bd.box((bxc + s * 0.42 - 0.33, bxc + s * 0.42 + 0.33), (d1 - 0.6, d1 - 0.2), (0.52, 0.66), 'uc_concrete', 0.7, bevel=True)
    Bd.box((BX[0] - 0.4, BX[1] + 0.4), (d1 - 0.12, d1 - 0.04), (0.1, 1.25), 'uc_wood', 2.0, bevel=True)   # headboard
    Bd.box((BX[0] - 0.4, BX[1] + 0.4), (d1 - 0.145, d1 - 0.12), (1.22, 1.24), 'uc_emit', 1.0, skip=('+y',))  # headboard glow strip
    # side tables (collide) + practical lamps
    St = Acc(key + '_prop_sidetables', S['O'])
    for s in (-1, 1):
        sxc = bxc + s * (bw / 2 + 0.38)
        St.box((sxc - 0.25, sxc + 0.25), (d1 - 0.5, d1 - 0.12), (0.2, 0.55), 'uc_wood', 1.5, bevel=True)
        St.box((sxc - 0.03, sxc + 0.03), (d1 - 0.34, d1 - 0.28), (0, 0.2), 'uc_dark', 1.0, skip=('-z', '+z'))
        N.cyl(sxc, d1 - 0.3, (0.55, 0.58), 0.07, 'uc_dark', 8)
        N.cyl(sxc, d1 - 0.3, (0.58, 0.9), 0.008, 'uc_dark', 4, caps=False)
        N.cyl(sxc, d1 - 0.3, (0.82, 1.0), 0.13, 'uc_wood', 10, caps=False, r2=0.1)
        N.cyl(sxc, d1 - 0.3, (0.85, 0.86), 0.11, 'uc_emit', 8)
        lamp_empty(coll, key, n, sxc, d1 - 0.3, 0.85, 'bedside', 1.0, {'reach_m_note': 'practical'}); n += 1
    # wardrobe (collide) on the far side wall
    Wd = Acc(key + '_prop_wardrobe', S['O'])
    wx = tuple(sorted((mx(X0 + G), mx(X0 + G + 0.62))))
    Wd.box(wx, (d0 + 1.6, d0 + 3.6), (0, 2.5), 'uc_wood', 2.0, skip=('-z',))
    face_x = mx(X0 + G + 0.62); fdir = 1 if not mir else -1
    for dd in (d0 + 2.1, d0 + 2.6, d0 + 3.1):
        Wd.box(tuple(sorted((face_x, face_x + fdir * 0.006))), (dd - 0.006, dd + 0.006), (0.05, 2.45), 'uc_dark', 1.0)
    for dd in (d0 + 2.55, d0 + 2.65):
        Wd.box(tuple(sorted((face_x, face_x + fdir * 0.03))), (dd - 0.01, dd + 0.01), (0.9, 1.5), 'uc_dark', 1.0)
    # rug as geometry, bench at bed foot, writing ledge + stool, planter
    rug(N, (BX[0] - 0.5, BX[1] + 0.5), (d1 - 3.2, d1 - 0.8))
    N.box((BX[0] + 0.1, BX[1] - 0.1), (d1 - 2.55, d1 - 2.2), (0.32, 0.44), 'uc_wood', 1.5, bevel=True)
    for s in (0.15, bw - 0.15):
        N.box((BX[0] + s - 0.03, BX[0] + s + 0.03), (d1 - 2.5, d1 - 2.25), (0, 0.32), 'uc_dark', 1.0, skip=('-z', '+z'))
    planter(N, mx(X1 - G - 0.4), d1 - 0.45)
    # wall niche shelf beside the nook partition
    N.box(tuple(sorted((mx(X1 - G), mx(X1 - G - 0.3)))), (d1 - 2.8, d1 - 1.4), (1.1, 1.14), 'uc_wood', 1.0, bevel=True)
    books(N, mx(X1 - G - 0.28) if not mir else mx(X1 - G), mx(X1 - G - 0.28) + 0.25 if not mir else mx(X1 - G) + 0.25, d1 - 2.7, d1 - 2.4, 1.14) if False else None
    for k in range(5):
        N.cyl(mx(X1 - G - 0.15), d1 - 2.6 + k * 0.25, (1.14, 1.14 + random.uniform(0.08, 0.25)), random.uniform(0.04, 0.07), random.choice(['uc_concrete', 'uc_slate', 'uc_dark']), 8)
    n = coves(coll, key, S, n)
    return coll, S, [N, Bd, St, Wd], {key + '_prop_bed': 1, key + '_prop_sidetables': 1, key + '_prop_wardrobe': 1}

BUILT = {}
for nm, fn in (('game', build_game), ('office', build_office)) + tuple(('guest%d' % i, (lambda i=i: build_guest(i))) for i in range(1, 5)):
    coll, S, props, coll_tags = fn()
    tri = {}
    for A in (S['F'], S['W'], S['C']) + tuple(props):
        tri[A.name] = A.tris()
    objs = []
    for A in (S['F'], S['W'], S['C']):
        objs.append(A.finish(coll, {'collide': 1} if A.name.endswith(('_floor', '_walls')) else {}))
    for A in props:
        objs.append(A.finish(coll, {'collide': 1} if A.name in coll_tags else {'collide': 0}))
    coll['room'] = nm; coll['door_wall'] = DOORS[nm][0]; coll['door_centre_m'] = float(DOORS[nm][1]); coll['door_wh_m'] = [1.2, 2.6]
    BUILT[nm] = dict(coll=coll.name, tri=tri, objs=[o.name for o in objs], S={k: S[k] for k in ('x0', 'x1', 'd0', 'd1', 'Hc', 'Ht')}, O=list(S['O']))

# exact triangle counts from the real meshes
for nm, b in BUILT.items():
    t = {}
    for on in b['objs']:
        me = bpy.data.objects[on].data; me.calc_loop_triangles(); t[on] = len(me.loop_triangles)
    b['tri'] = t
    b['shell'] = sum(v for k, v in t.items() if k.endswith(('_floor', '_walls', '_ceil')))
    b['props'] = sum(v for k, v in t.items() if not k.endswith(('_floor', '_walls', '_ceil')))
    b['total'] = b['shell'] + b['props']
    b['mats'] = sorted({m.name for on in b['objs'] for m in bpy.data.objects[on].data.materials})
    b['lights'] = LIGHTS.get(nm, [])
    b['door'] = DOORS[nm]
    print("ROOM", nm, "shell", b['shell'], "props", b['props'], "total", b['total'], b['mats'], flush=True)
json.dump(BUILT, open(os.path.join(OUTD, "tools-b", "p2b_report.json"), "w"), indent=1, default=str)

# relative texture paths, not packed
for im in bpy.data.images:
    if im.filepath: im.filepath = bpy.path.relpath(bpy.path.abspath(im.filepath), start=OUTD)
sc.render.engine = 'CYCLES'
bpy.ops.wm.save_as_mainfile(filepath=BLEND, relative_remap=True, compress=True)
print("SAVED", BLEND, flush=True)
