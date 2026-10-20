# Bird Temple interior builder (Blender, headless).
#   python3 -I build_interior.py   ->  interior_parts.glb  (+ interior_preview.blend)
# Everything is authored in the Blender WORLD frame the original GLB imports into
# (Z up, +Y toward the stern/aft, deck surface z = 0.5, one human ~ 4.14 units tall).
# splice.py later grafts these parts into a copy of the original GLB and cuts the
# hatch hole in the Hull; the original file is never modified.
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix

bpy.ops.wm.read_factory_settings(use_empty=True)
HERE = os.path.dirname(os.path.abspath(__file__))
TEX = HERE + '/tex/'

# ───────────────────────── layout constants ─────────────────────────
DECK = 0.5                       # top deck (hull top) z
ZA, ZB, ZC = -7.5, -15.0, -22.5  # floors of decks A (navigation), B (mess), C (crew/engine)
CEIL_A = -0.3                    # underside of deck A's ceiling
X0, X1 = -12.0, 8.0              # room width (20)
Y0, Y1 = 78.0, 124.0             # room length (46)
BULK_Y = 105.5                   # bulkhead between stair hall and the main rooms
DOOR_X = (-2.5, 1.5)
SX0, SX1, SY0, SY1 = -6.0, 2.0, 111.2, 120.0   # stair shaft = hatch hole
SLAB = 0.5
EAST_DOOR = (107.0, 111.0)       # doorway in deck A's port wall (stair hall) -> cargo corridor

# ───────────────────────── materials ─────────────────────────
def img(name):
    return bpy.data.images.load(TEX + name, check_existing=True)

MATS = {}
def mat(name, base=(0.5, 0.5, 0.5), metal=0.0, rough=0.6, emit=None, estr=0.0, tex=None, etex=None, tile=1.0, alpha=None, tex_alpha=False, cull=False):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*base, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if tex:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(tex); t.interpolation = 'Linear'
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    if alpha is not None:
        bsdf.inputs['Alpha'].default_value = alpha
    if tex and tex_alpha:
        nt.links.new(t.outputs['Alpha'], bsdf.inputs['Alpha'])
    if etex:
        e = nt.nodes.new('ShaderNodeTexImage'); e.image = img(etex)
        nt.links.new(e.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = estr
    elif emit:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1)
        bsdf.inputs['Emission Strength'].default_value = estr
    m.use_backface_culling = cull
    MATS[name] = m
    return m

def build_materials():
    mat('BTI_Violet', (0.11, 0.07, 0.26), 0.25, 0.55)
    mat('BTI_VioletLight', (0.23, 0.14, 0.46), 0.25, 0.45)
    mat('BTI_Dark', (0.025, 0.025, 0.05), 0.4, 0.5)
    mat('BTI_Floor', (0.5, 0.5, 0.6), 0.3, 0.6, tex='deckplate.png')
    mat('BTI_Grille', (0.6, 0.6, 0.7), 0.3, 0.6, tex='grille.png')
    mat('BTI_Neon', (0.2, 0.2, 0.4), 0, 0.4, emit=(0.5, 0.55, 1.0), estr=6.0)
    mat('BTI_NeonCyan', (0.1, 0.3, 0.3), 0, 0.4, emit=(0.3, 1.0, 0.95), estr=5.0)
    mat('BTI_NeonAmber', (0.3, 0.2, 0.05), 0, 0.4, emit=(1.0, 0.7, 0.2), estr=4.0)
    mat('BTI_Leather', (0.14, 0.03, 0.06), 0.1, 0.4)
    mat('BTI_Steel', (0.55, 0.55, 0.65), 0.9, 0.3)
    mat('BTI_Keys', (1, 1, 1), 0.1, 0.5, tex='keys.png', etex='keys.png', estr=0.25)
    for n in ['nav_a', 'nav_b', 'nav_c', 'nav_d', 'radar', 'sector', 'menu', 'engine', 'crew']:
        mat('BTI_Holo_' + n, (0.02, 0.1, 0.12), 0, 0.3, tex='holo_%s.png' % n, etex='holo_%s.png' % n, estr=1.6)
    for n in ['A', 'B', 'C', 'TOP', 'STORE', 'ENG']:
        mat('BTI_Sign_' + n, (0.02, 0.1, 0.12), 0, 0.3, tex='sign_%s.png' % n, etex='sign_%s.png' % n, estr=1.4)
    for n, c in [('Red', (1, .25, .2)), ('Yellow', (1, .85, .2)), ('Cyan', (.2, .95, 1)), ('Green', (.3, 1, .5)), ('Pink', (1, .4, .9))]:
        mat('BTI_Led' + n, tuple(x * .3 for x in c), 0, 0.4, emit=c, estr=3.0)
    mat('BTI_Reactor', (0.1, 0.3, 0.4), 0, 0.3, emit=(0.35, 0.9, 1.0), estr=5.0)
    mat('BTI_ReactorViolet', (0.2, 0.1, 0.4), 0, 0.3, emit=(0.6, 0.4, 1.0), estr=4.0)
    mat('BTI_FabricBlue', (0.12, 0.22, 0.5), 0, 0.9)
    mat('BTI_FabricRose', (0.5, 0.18, 0.28), 0, 0.9)
    mat('BTI_FabricTeal', (0.1, 0.4, 0.4), 0, 0.9)
    mat('BTI_Table', (0.28, 0.2, 0.42), 0.2, 0.5)
    mat('BTI_Amber', (0.9, 0.6, 0.2), 0.0, 0.5, emit=(1.0, 0.6, 0.15), estr=1.2)
    mat('BTI_Hazard', (0.9, 0.7, 0.1), 0.2, 0.5)
    mat('BTI_HazardDark', (0.04, 0.04, 0.05), 0.2, 0.5)
    mat('BTI_VioletIn', (0.11, 0.07, 0.26), 0.25, 0.55, cull=True)   # skin liners: visible from inside only
    mat('BTI_Glass', (0.55, 0.85, 1.0), 0.0, 0.05, emit=(0.2, 0.5, 0.7), estr=0.15, alpha=0.20)
    for n in 'abc':
        mat('BTI_Galaxy_' + n, (0.0, 0.0, 0.0), 0, 0.5, tex='galaxy_%s.png' % n, etex='galaxy_%s.png' % n, estr=2.2, tex_alpha=True)
    for n in ['sector', 'radar', 'nav_b']:
        mat('BTI_GlassHolo_' + n, (0.0, 0.0, 0.0), 0, 0.5, tex='holopanel_%s.png' % n, etex='holopanel_%s.png' % n, estr=2.0, tex_alpha=True)
    for n in ['bay', 'conf']:
        mat('BTI_Holo_' + n, (0.02, 0.1, 0.12), 0, 0.3, tex='holo_%s.png' % n, etex='holo_%s.png' % n, estr=1.6)
    for n in ['BAY', 'CMD', 'CORR']:
        mat('BTI_Sign_' + n, (0.02, 0.1, 0.12), 0, 0.3, tex='sign_%s.png' % n, etex='sign_%s.png' % n, estr=1.4)
build_materials()

# ───────────────────────── mesh builder ─────────────────────────
class MB:
    """Collects geometry per object name; faces carry a material slot."""
    def __init__(self):
        self.parts = {}
    def part(self, name, origin=(0, 0, 0)):
        if name not in self.parts:
            self.parts[name] = dict(bm=bmesh.new(), mats=[], origin=Vector(origin))
        return self.parts[name]
    def _slot(self, p, m):
        if m not in p['mats']: p['mats'].append(m)
        return p['mats'].index(m)
    def face(self, name, m, pts, uvs=None):
        p = self.part(name); bm = p['bm']; o = p['origin']
        vs = [bm.verts.new(Vector(q) - o) for q in pts]
        try:
            f = bm.faces.new(vs)
        except ValueError:
            return
        f.material_index = self._slot(p, MATS[m])
        if uvs:
            uvl = bm.loops.layers.uv.verify()
            for l, uv in zip(f.loops, uvs): l[uvl].uv = uv
    def box(self, name, m, x0, x1, y0, y1, z0, z1, uvs=0.1, skip=()):
        if x1 < x0: x0, x1 = x1, x0
        if y1 < y0: y0, y1 = y1, y0
        if z1 < z0: z0, z1 = z1, z0
        s = uvs
        # faces (outward): -x +x -y +y -z +z
        F = {
            '-x': ([(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)], [(y1*s, z0*s), (y0*s, z0*s), (y0*s, z1*s), (y1*s, z1*s)]),
            '+x': ([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], [(y0*s, z0*s), (y1*s, z0*s), (y1*s, z1*s), (y0*s, z1*s)]),
            '-y': ([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], [(x0*s, z0*s), (x1*s, z0*s), (x1*s, z1*s), (x0*s, z1*s)]),
            '+y': ([(x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)], [(x1*s, z0*s), (x0*s, z0*s), (x0*s, z1*s), (x1*s, z1*s)]),
            '-z': ([(x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)], [(x0*s, y1*s), (x1*s, y1*s), (x1*s, y0*s), (x0*s, y0*s)]),
            '+z': ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], [(x0*s, y0*s), (x1*s, y0*s), (x1*s, y1*s), (x0*s, y1*s)]),
        }
        for k, (pts, uv) in F.items():
            if k in skip: continue
            self.face(name, m, pts, uv)
    def prism_yz(self, name, m, x0, x1, poly):
        """extrude a (y,z) polygon along x"""
        n = len(poly)
        self.face(name, m, [(x0, y, z) for y, z in poly][::-1], [(y*.1, z*.1) for y, z in poly][::-1])
        self.face(name, m, [(x1, y, z) for y, z in poly], [(y*.1, z*.1) for y, z in poly])
        for i in range(n):
            (ya, za), (yb, zb) = poly[i], poly[(i+1) % n]
            self.face(name, m, [(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)], [(0, 0), (1, 0), (1, 1), (0, 1)])
    def prism_xz(self, name, m, y0, y1, poly):
        n = len(poly)
        self.face(name, m, [(x, y0, z) for x, z in poly], [(x*.1, z*.1) for x, z in poly])
        self.face(name, m, [(x, y1, z) for x, z in poly][::-1], [(x*.1, z*.1) for x, z in poly][::-1])
        for i in range(n):
            (xa, za), (xb, zb) = poly[i], poly[(i+1) % n]
            self.face(name, m, [(xb, y0, zb), (xa, y0, za), (xa, y1, za), (xb, y1, zb)], [(0, 0), (1, 0), (1, 1), (0, 1)])
    def cyl(self, name, m, cx, cy, z0, z1, r, seg=24, r1=None):
        r1 = r if r1 is None else r1
        pts0 = [(cx + r * math.cos(2*math.pi*i/seg), cy + r * math.sin(2*math.pi*i/seg)) for i in range(seg)]
        pts1 = [(cx + r1 * math.cos(2*math.pi*i/seg), cy + r1 * math.sin(2*math.pi*i/seg)) for i in range(seg)]
        self.face(name, m, [(x, y, z1) for x, y in pts1], [(.5+.5*math.cos(2*math.pi*i/seg), .5+.5*math.sin(2*math.pi*i/seg)) for i in range(seg)])
        self.face(name, m, [(x, y, z0) for x, y in pts0][::-1])
        for i in range(seg):
            j = (i+1) % seg
            self.face(name, m, [(pts0[i][0], pts0[i][1], z0), (pts0[j][0], pts0[j][1], z0), (pts1[j][0], pts1[j][1], z1), (pts1[i][0], pts1[i][1], z1)],
                      [(i/seg, 0), ((i+1)/seg, 0), ((i+1)/seg, 1), (i/seg, 1)])
    def cyl_x(self, name, m, y, z, x0, x1, r, seg=14):
        pts = [(y + r*math.cos(2*math.pi*i/seg), z + r*math.sin(2*math.pi*i/seg)) for i in range(seg)]
        self.face(name, m, [(x1, a, b) for a, b in pts]); self.face(name, m, [(x0, a, b) for a, b in pts][::-1])
        for i in range(seg):
            j = (i+1) % seg
            self.face(name, m, [(x0, pts[i][0], pts[i][1]), (x0, pts[j][0], pts[j][1]), (x1, pts[j][0], pts[j][1]), (x1, pts[i][0], pts[i][1])])
    def cyl_y(self, name, m, x, z, y0, y1, r, seg=14):
        pts = [(x + r*math.cos(2*math.pi*i/seg), z + r*math.sin(2*math.pi*i/seg)) for i in range(seg)]
        self.face(name, m, [(a, y1, b) for a, b in pts][::-1]); self.face(name, m, [(a, y0, b) for a, b in pts])
        for i in range(seg):
            j = (i+1) % seg
            self.face(name, m, [(pts[j][0], y0, pts[j][1]), (pts[i][0], y0, pts[i][1]), (pts[i][0], y1, pts[i][1]), (pts[j][0], y1, pts[j][1])])
    def quad(self, name, m, p0, p1, p2, p3, uv=(1, 1)):
        self.face(name, m, [p0, p1, p2, p3], [(0, 0), (uv[0], 0), (uv[0], uv[1]), (0, uv[1])])
    def build(self, parent_map=None):
        objs = {}
        for name, p in self.parts.items():
            me = bpy.data.meshes.new(name); p['bm'].to_mesh(me); p['bm'].free()
            for m in p['mats']: me.materials.append(m)
            ob = bpy.data.objects.new(name, me); ob.location = p['origin']
            bpy.context.scene.collection.objects.link(ob)
            for poly in me.polygons: poly.use_smooth = False
            objs[name] = ob
        return objs

mb = MB()

# ───────────────────────── structural helpers ─────────────────────────
def slab_with_hole(name, m, x0, x1, y0, y1, z0, z1, hole=None):
    if hole is None:
        mb.box(name, m, x0, x1, y0, y1, z0, z1); return
    hx0, hx1, hy0, hy1 = hole
    mb.box(name, m, x0, hx0, y0, y1, z0, z1)
    mb.box(name, m, hx1, x1, y0, y1, z0, z1)
    mb.box(name, m, hx0, hx1, y0, hy0, z0, z1)
    mb.box(name, m, hx0, hx1, hy1, y1, z0, z1)

def rib(name, y, x0, x1, zf, zc, ch=1.6, t=0.7, depth=0.8, m='BTI_VioletLight'):
    """chamfered structural arch (wall -> chamfer -> ceiling), like the reference bridge"""
    path = [(x0, zf), (x0, zc - ch), (x0 + ch, zc), (x1 - ch, zc), (x1, zc - ch), (x1, zf)]
    for i in range(len(path) - 1):
        (ax, az), (bx, bz) = path[i], path[i+1]
        dx, dz = bx - ax, bz - az; L = math.hypot(dx, dz)
        nx, nz = -dz / L, dx / L          # inward normal for this winding is (+) toward room
        if nx * ((x0 + x1) / 2 - ax) + nz * ((zf + zc) / 2 - az) < 0: nx, nz = -nx, -nz
        poly = [(ax, az), (bx, bz), (bx + nx*t, bz + nz*t), (ax + nx*t, az + nz*t)]
        mb.prism_xz(name, m, y - depth/2, y + depth/2, poly)

def neon_x(name, m, x, y0, y1, z, w=0.22, h=0.12):
    mb.box(name, m, x - w/2, x + w/2, y0, y1, z, z + h)
def neon_y(name, m, y, x0, x1, z, w=0.22, h=0.12):
    mb.box(name, m, x0, x1, y - w/2, y + w/2, z, z + h)

def stair_level(zt, zb, ys=SY1):
    """switchback flight from floor zt down to floor zb, inside the shaft rect. Solid treads."""
    N = 16
    rise = (zt - zb) / N
    n1 = N // 2           # landing tread index
    L1 = 0.8 * (n1 - 1)
    lane1 = (SX0, -2.4); lane2 = (-1.6, SX1)
    nm = 'BTI_Stairs'
    for i in range(1, n1):                         # flight 1 : y decreasing from ys
        top = zt - rise * i
        y_hi = ys - 0.8 * (i - 1); y_lo = ys - 0.8 * i
        mb.box(nm, 'BTI_Steel', lane1[0], lane1[1], y_lo, y_hi, top - 0.4, top)     # hollow underside: the flight below starts under it
        mb.box(nm, 'BTI_NeonCyan', lane1[0], lane1[1], y_lo - 0.0, y_lo + 0.14, top - 0.02, top + 0.03)
    land_top = zt - rise * n1
    mb.box(nm, 'BTI_Steel', SX0, SX1, ys - L1 - 3.2, ys - L1, land_top - 0.5, land_top)
    for j in range(1, N - n1):                     # flight 2 : y increasing from the landing
        top = land_top - rise * j
        y_lo = ys - L1 + 0.8 * (j - 1); y_hi = ys - L1 + 0.8 * j
        mb.box(nm, 'BTI_Steel', lane2[0], lane2[1], y_lo, y_hi, zb, top)
        mb.box(nm, 'BTI_NeonCyan', lane2[0], lane2[1], y_hi - 0.14, y_hi, top - 0.02, top + 0.03)
    # guard rails: outer sides of each flight + landing back
    rl = 'BTI_Rails'
    def rail_x(x, ya, yb, za, zb2, hh=1.7):
        mb.box(rl, 'BTI_Dark', x - 0.08, x + 0.08, min(ya, yb), max(ya, yb), 0, 0)  # placeholder (kept empty)
    # slanted outer rails (prisms in y-z)
    def slope_rail(x, ya, za, yb, zb2, hh=1.7, w=0.16, m='BTI_Dark'):
        poly = [(ya, za), (yb, zb2), (yb, zb2 + hh), (ya, za + hh)]
        mb.prism_yz(rl, m, x - w/2, x + w/2, poly)
    ztop1 = zt - rise * 1; zend1 = zt - rise * (n1 - 1)
    slope_rail(SX0 + 0.1, ys, zt, ys - L1, land_top + rise)
    slope_rail(-2.4 + 0.0, ys, zt, ys - L1, land_top + rise)
    slope_rail(SX1 - 0.1, ys - L1, land_top, ys, zb + rise)
    slope_rail(-1.6, ys - L1, land_top, ys, zb + rise)
    mb.box(rl, 'BTI_Dark', SX0, SX1, ys - L1 - 3.2, ys - L1 - 3.0, land_top, land_top + 1.7)
    mb.box(rl, 'BTI_Neon', SX0, SX1, ys - L1 - 3.2, ys - L1 - 3.0, land_top + 1.66, land_top + 1.74)

def hole_rails(zf, with_lane1_gate=True):
    """railing round a slab hole at floor zf so nobody walks into the shaft"""
    rl = 'BTI_Rails'; h = 1.6
    def bar(x0, x1, y0, y1):
        mb.box(rl, 'BTI_Dark', x0, x1, y0, y1, zf, zf + h)
        mb.box(rl, 'BTI_Neon', x0, x1, y0, y1, zf + h - 0.06, zf + h + 0.04)
    bar(SX0 - 0.15, SX0 + 0.05, SY0, SY1)
    bar(SX1 - 0.05, SX1 + 0.15, SY0, SY1)
    bar(SX0, SX1, SY0 - 0.15, SY0 + 0.05)
    # stern edge is left open on purpose: lane 1 goes down, lane 2 comes up

# ───────────────────────── room shell ─────────────────────────
def room_shell(tag, zf, zc, ribs_y, ceil_mat_top=None, east_door=None):
    nm = 'BTI_Shell_' + tag
    # side + end walls (outer faces dark, inner violet)
    mb.box(nm, 'BTI_Violet', X0 - 0.5, X0, Y0 - 0.5, Y1 + 0.5, zf, zc)
    if east_door:
        da, db = east_door
        mb.box(nm, 'BTI_Violet', X1, X1 + 0.5, Y0 - 0.5, da, zf, zc)
        mb.box(nm, 'BTI_Violet', X1, X1 + 0.5, db, Y1 + 0.5, zf, zc)
        mb.box(nm, 'BTI_Violet', X1, X1 + 0.5, da, db, zf + 5.7, zc)
        for yy in (da, db):
            mb.box(nm, 'BTI_VioletLight', X1 - 0.2, X1 + 0.7, yy - .25, yy + .25, zf, zf + 5.8)
        mb.box(nm, 'BTI_VioletLight', X1 - 0.2, X1 + 0.7, da, db, zf + 5.55, zf + 5.95)
        for yy in (da + 0.12, db - 0.12):
            mb.box('BTI_NeonLine_' + tag, 'BTI_NeonCyan', X1 - .26, X1 - .2, yy - .05, yy + .05, zf + .1, zf + 5.55)
        mb.box('BTI_NeonLine_' + tag, 'BTI_NeonCyan', X1 - .26, X1 - .2, da, db, zf + 5.55, zf + 5.69)
    else:
        mb.box(nm, 'BTI_Violet', X1, X1 + 0.5, Y0 - 0.5, Y1 + 0.5, zf, zc)
    mb.box(nm, 'BTI_Violet', X0, X1, Y0 - 0.5, Y0, zf, zc)
    mb.box(nm, 'BTI_Violet', X0, X1, Y1, Y1 + 0.5, zf, zc)
    # skirting + ceiling coves
    mb.box(nm, 'BTI_Dark', X0, X0 + 0.5, Y0, Y1, zf, zf + 0.9)
    for (sa, sb) in (([(Y0, east_door[0] - 0.3), (east_door[1] + 0.3, Y1)]) if east_door else [(Y0, Y1)]):       # (the east skirting / floor neon stop short of the doorway)
        mb.box(nm, 'BTI_Dark', X1 - 0.5, X1, sa, sb, zf, zf + 0.9)
    for y in ribs_y:
        rib(nm, y, X0, X1, zf, zc)
    # floor-edge and ceiling neon (video look)
    neon_x('BTI_NeonLine_' + tag, 'BTI_Neon', X0 + 0.55, Y0 + 0.2, Y1 - 0.2, zf + 0.95)
    for (sa, sb) in (([(Y0 + 0.2, east_door[0] - 0.4), (east_door[1] + 0.4, Y1 - 0.2)]) if east_door else [(Y0 + 0.2, Y1 - 0.2)]):
        neon_x('BTI_NeonLine_' + tag, 'BTI_Neon', X1 - 0.55, sa, sb, zf + 0.95)
    neon_x('BTI_NeonLine_' + tag, 'BTI_Neon', X0 + 1.9, Y0 + 0.5, Y1 - 0.5, zc - 0.5, w=0.3)
    neon_x('BTI_NeonLine_' + tag, 'BTI_Neon', X1 - 1.9, Y0 + 0.5, Y1 - 0.5, zc - 0.5, w=0.3)
    neon_x('BTI_NeonLine_' + tag, 'BTI_Neon', (X0 + X1) / 2, Y0 + 0.5, SY0 - 0.3, zc - 0.12, w=0.35)
    neon_x('BTI_NeonLine_' + tag, 'BTI_Neon', (X0 + X1) / 2, SY1 + 0.3, Y1 - 0.5, zc - 0.12, w=0.35)
    # ceiling grille panels (under the slab above / the hull top)
    ceil_hole = (SX0, SX1, SY0, SY1)
    for (a, b, c, d) in [(X0, SX0, Y0, Y1), (SX1, X1, Y0, Y1), (SX0, SX1, Y0, SY0), (SX0, SX1, SY1, Y1)]:
        mb.quad('BTI_Ceiling_' + tag, 'BTI_Grille', (a, d, zc - 0.02), (b, d, zc - 0.02), (b, c, zc - 0.02), (a, c, zc - 0.02), uv=((b - a) / 3, (d - c) / 3))
    # bulkhead between stair hall and main room, with a doorway
    bz0, bz1 = zf, zc
    mb.box(nm, 'BTI_Violet', X0, DOOR_X[0], BULK_Y, BULK_Y + 0.5, bz0, bz1)
    mb.box(nm, 'BTI_Violet', DOOR_X[1], X1, BULK_Y, BULK_Y + 0.5, bz0, bz1)
    mb.box(nm, 'BTI_Violet', DOOR_X[0], DOOR_X[1], BULK_Y, BULK_Y + 0.5, zf + 5.6, bz1)
    # door frame (chamfered neon outline like the video's left doorway)
    for x in DOOR_X:
        mb.box(nm, 'BTI_VioletLight', x - 0.25, x + 0.25, BULK_Y - 0.15, BULK_Y + 0.65, zf, zf + 5.7)
    mb.box(nm, 'BTI_VioletLight', DOOR_X[0], DOOR_X[1], BULK_Y - 0.15, BULK_Y + 0.65, zf + 5.45, zf + 5.95)
    neon_y('BTI_NeonLine_' + tag, 'BTI_Neon', BULK_Y - 0.18, DOOR_X[0] - 0.3, DOOR_X[0] - 0.12, zf + 0.2, w=0.1)
    for x in (DOOR_X[0] - 0.12, DOOR_X[1] + 0.12):
        mb.box('BTI_NeonLine_' + tag, 'BTI_Neon', x - 0.07, x + 0.07, BULK_Y - 0.22, BULK_Y - 0.16, zf + 0.1, zf + 5.55)
    mb.box('BTI_NeonLine_' + tag, 'BTI_Neon', DOOR_X[0] - 0.12, DOOR_X[1] + 0.12, BULK_Y - 0.22, BULK_Y - 0.16, zf + 5.55, zf + 5.69)

def floor_slab(tag, zf, hole=True):
    slab_with_hole('BTI_Floor_' + tag, 'BTI_Floor', X0 - 0.5, X1 + 0.5, Y0 - 0.5, Y1 + 0.5, zf - SLAB, zf,
                   (SX0, SX1, SY0, SY1) if hole else None)

# ───────────────────────── furniture ─────────────────────────
def chair(nm, x, y, z, face=-1, big=False):
    """face: -1 looks toward -y. Reclined bridge seat: star base, pedestal, cushion, tilted back + headrest, arms."""
    s = 1.25 if big else 1.0
    back = -face                      # direction (in y) the backrest sits relative to the seat centre
    mb.cyl(nm, 'BTI_Steel', x, y, z, z + 0.25, 0.75 * s, 10, r1=0.35 * s)
    mb.cyl(nm, 'BTI_Dark', x, y, z + 0.25, z + 1.3, 0.16 * s, 8)
    mb.box(nm, 'BTI_Leather', x - .72 * s, x + .72 * s, y - .72 * s, y + .72 * s, z + 1.3, z + 1.75)
    mb.box(nm, 'BTI_Dark', x - .5 * s, x + .5 * s, y - .5 * s, y + .5 * s, z + 1.2, z + 1.3)
    # backrest: slanted slab (prism in y-z)
    y0 = y + back * .72 * s; y1 = y + back * (.72 + .22) * s
    lean = back * .75 * s
    poly = [(y0, z + 1.75), (y1, z + 1.75), (y1 + lean, z + 4.1 * s), (y0 + lean, z + 4.1 * s)]
    mb.prism_yz(nm, 'BTI_Leather', x - .66 * s, x + .66 * s, poly)
    hy0 = y0 + lean; hy1 = y1 + lean
    mb.prism_yz(nm, 'BTI_Leather', x - .38 * s, x + .38 * s, [(hy0, z + 4.15 * s), (hy1, z + 4.15 * s), (hy1 + back * .15 * s, z + 4.95 * s), (hy0 + back * .15 * s, z + 4.95 * s)])
    for sx in (-1, 1):
        mb.box(nm, 'BTI_Dark', x + sx * .8 * s - .09, x + sx * .8 * s + .09, y - .55 * s, y + .75 * s * (-back if False else 1) * 0 + .55 * s, z + 2.35, z + 2.5)
        mb.box(nm, 'BTI_Dark', x + sx * .8 * s - .07, x + sx * .8 * s + .07, y + back * .45 * s - .07, y + back * .45 * s + .07, z + 1.75, z + 2.4)

def console(nm, cx, cy, zf, facing, width=5.6, screen='nav_a', depth=3.2, ix=None):
    """facing: direction the OPERATOR looks, as a unit (dx,dy). Consoles sit against a wall behind them... the
    operator looks at the console, so the console's screen faces the room opposite the wall."""
    fx, fy = facing                     # operator looks along (fx,fy); console is in front of them
    # local axes: u = across, v = from wall toward operator (opposite facing)
    vx, vy = -fx, -fy
    ux, uy = -vy, vx
    def W(u, v, z): return (cx + ux * u + vx * v, cy + uy * u + vy * v, z)
    hw = width / 2
    # body: wedge (v 0..depth), slanted keyboard top
    profile = [(0.0, 0.0), (0.0, 2.9), (0.9, 2.9), (depth, 1.45), (depth, 0.0)]
    # build as hull of 2 rows by extruding along u manually
    def prof_pts(u): return [W(u, v, zf + z) for v, z in profile]
    a = prof_pts(-hw); b = prof_pts(hw)
    n = len(profile)
    mb.face(nm, 'BTI_VioletLight', a[::-1]); mb.face(nm, 'BTI_VioletLight', b)
    for i in range(n):
        j = (i + 1) % n
        mb.face(nm, 'BTI_VioletLight', [a[i], b[i], b[j], a[j]])
    # keyboard (on slanted top)
    k0 = W(-hw + .35, 1.0, zf + 2.9 - (1.0 - .9) * (1.45 / (depth - .9)) - 0.03 + 0.07)
    def top_z(v): return zf + 2.9 - (v - 0.9) * (1.45 / (depth - 0.9)) + 0.03
    mb.quad(nm + '_Keys', 'BTI_Keys', W(-hw + .3, 1.1, top_z(1.1)), W(hw - .3, 1.1, top_z(1.1)), W(hw - .3, depth - .25, top_z(depth - .25)), W(-hw + .3, depth - .25, top_z(depth - .25)), uv=(1, 1))
    # tilted display above the back of the console, dark bezel behind
    sh = 2.7
    p_bot = (0.15, zf + 2.95); p_top = (-0.35 if False else 0.0, zf + 2.95 + sh)
    mb.quad(nm + '_Bezel', 'BTI_Dark', W(-hw + .15, 0.02, zf + 2.9), W(hw - .15, 0.02, zf + 2.9), W(hw - .15, 0.02, zf + 2.9 + sh + .25), W(-hw + .15, 0.02, zf + 2.9 + sh + .25))
    mb.quad(nm + '_Screen', 'BTI_Holo_' + screen, W(-hw + .3, 0.06, zf + 3.05), W(hw - .3, 0.06, zf + 3.05), W(hw - .3, 0.06, zf + 2.9 + sh), W(-hw + .3, 0.06, zf + 2.9 + sh))

def led_cluster(nm, cx, cy, zf, facing, width, n=8):
    fx, fy = facing; vx, vy = -fx, -fy; ux, uy = -vy, vx
    cols = ['BTI_LedRed', 'BTI_LedYellow', 'BTI_LedCyan', 'BTI_LedGreen', 'BTI_LedPink']
    for i in range(n):
        u = width / 2 - 0.5 - (i % 4) * 0.3; v = 1.8 + (i // 4) * 0.4
        x = cx + ux * u + vx * v; y = cy + uy * u + vy * v
        mb.box(nm + '_Leds', cols[i % 5], x - .1, x + .1, y - .1, y + .1, zf + 2.2, zf + 2.32, uvs=.5)

def wall_screen(nm, x0, x1, y, z0, z1, tex, face=+1):
    """large wall-mounted holographic panel facing +y (face=+1) or -y"""
    if face > 0:
        mb.quad(nm, 'BTI_Dark', (x1 + .15, y + .03, z0 - .15), (x0 - .15, y + .03, z0 - .15), (x0 - .15, y + .03, z1 + .15), (x1 + .15, y + .03, z1 + .15))
        mb.quad(nm + '_Face', 'BTI_Holo_' + tex, (x1, y + .06, z0), (x0, y + .06, z0), (x0, y + .06, z1), (x1, y + .06, z1))
    else:
        mb.quad(nm, 'BTI_Dark', (x0 - .15, y - .03, z0 - .15), (x1 + .15, y - .03, z0 - .15), (x1 + .15, y - .03, z1 + .15), (x0 - .15, y - .03, z1 + .15))
        mb.quad(nm + '_Face', 'BTI_Holo_' + tex, (x0, y - .06, z0), (x1, y - .06, z0), (x1, y - .06, z1), (x0, y - .06, z1))

def wall_screen_x(nm, x, y0, y1, z0, z1, tex, face=+1):
    """panel on a side wall: face=+1 looks toward +x"""
    if face > 0:
        mb.quad(nm + '_Face', 'BTI_Holo_' + tex, (x + .06, y0, z0), (x + .06, y1, z0), (x + .06, y1, z1), (x + .06, y0, z1))
        mb.quad(nm, 'BTI_Dark', (x + .03, y0 - .15, z0 - .15), (x + .03, y1 + .15, z0 - .15), (x + .03, y1 + .15, z1 + .15), (x + .03, y0 - .15, z1 + .15))
    else:
        mb.quad(nm + '_Face', 'BTI_Holo_' + tex, (x - .06, y1, z0), (x - .06, y0, z0), (x - .06, y0, z1), (x - .06, y1, z1))
        mb.quad(nm, 'BTI_Dark', (x - .03, y1 + .15, z0 - .15), (x - .03, y0 - .15, z0 - .15), (x - .03, y0 - .15, z1 + .15), (x - .03, y1 + .15, z1 + .15))

def sign_plate(nm, key, cx, y, z, face=+1, w=5.0, h=1.5):
    if face > 0:
        mb.quad(nm, 'BTI_Sign_' + key, (cx + w/2, y + .08, z), (cx - w/2, y + .08, z), (cx - w/2, y + .08, z + h), (cx + w/2, y + .08, z + h))
    else:
        mb.quad(nm, 'BTI_Sign_' + key, (cx - w/2, y - .08, z), (cx + w/2, y - .08, z), (cx + w/2, y - .08, z + h), (cx - w/2, y - .08, z + h))

# ───────────────────────── DECK A : navigation room ─────────────────────────
def deck_nav():
    zf = ZA; zc = CEIL_A
    floor_slab('A', zf)
    room_shell('A', zf, zc, ribs_y=[84, 90, 96, 102, 108, 123.2], east_door=EAST_DOOR)
    # stair hall sign + hole rails
    hole_rails(zf)
    sign_plate('BTI_Sign_A_hall', 'A', -2.0, Y1 - 0.02, zf + 3.4, face=-1)
    # forward console bank (three consoles under three large screens) — the "video" bridge
    cx = [-8.6, -2.0, 4.6]
    scr = ['nav_a', 'radar', 'nav_b']
    for x, s in zip(cx, scr):
        console('BTI_Console_N', x, Y0 + 0.6, zf, (0, -1), width=6.1, screen=s)
        led_cluster('BTI_Console_N', x, Y0 + 0.6, zf, (0, -1), 6.1)
    for x, s in zip(cx, ['nav_c', 'sector', 'nav_d']):
        wall_screen('BTI_WallScreen_N', x - 2.7, x + 2.7, Y0 + 0.05, zf + 4.7, zf + 6.8, s, face=+1)
    # side-wall consoles
    for y, s in [(86.5, 'nav_b'), (93.5, 'nav_a')]:
        console('BTI_Console_N', X0 + 0.3, y, zf, (-1, 0), width=5.2, screen=s)
        console('BTI_Console_N', X1 - 0.3, y, zf, (1, 0), width=5.2, screen=s)
    for y, t in [(86.5, 'nav_d'), (93.5, 'sector')]:
        wall_screen_x('BTI_WallScreen_N', X0 + 0.05, y - 2.5, y + 2.5, zf + 4.7, zf + 6.7, t, face=+1)
        wall_screen_x('BTI_WallScreen_N', X1 - 0.05, y - 2.5, y + 2.5, zf + 4.7, zf + 6.7, t, face=-1)
    # holo chart table (centre, behind the captain)
    cxm = (X0 + X1) / 2
    mb.cyl('BTI_ChartTable', 'BTI_VioletLight', cxm, 97.5, zf, zf + 1.9, 1.6, 6, r1=1.9)
    mb.cyl('BTI_ChartTable', 'BTI_Dark', cxm, 97.5, zf + 1.9, zf + 2.05, 2.0, 24)
    mb.quad('BTI_ChartTable_Face', 'BTI_Holo_radar', (cxm + 1.8, 97.5 - 1.8, zf + 2.08), (cxm + 1.8, 97.5 + 1.8, zf + 2.08), (cxm - 1.8, 97.5 + 1.8, zf + 2.08), (cxm - 1.8, 97.5 - 1.8, zf + 2.08))
    # command seats
    chair('BTI_Seat_N', -2.0, 87.0, zf, face=-1, big=True)
    chair('BTI_Seat_N', -8.6, 85.6, zf, face=-1)
    chair('BTI_Seat_N', 4.6, 85.6, zf, face=-1)
    chair('BTI_Seat_N', X0 + 4.0, 86.5, zf, face=-1)
    chair('BTI_Seat_N', X1 - 4.0, 93.5, zf, face=-1)
    sign_plate('BTI_Sign_A_door', 'A', (DOOR_X[0] + DOOR_X[1]) / 2, BULK_Y - 0.2, zf + 6.0, face=-1, w=3.6, h=1.05)
    # vertical neon at the room's far corners
    for xx in (X0 + 0.6, X1 - 0.6):
        mb.box('BTI_NeonLine_A', 'BTI_NeonCyan', xx - .08, xx + .08, Y0 + 0.1, Y0 + .2, zf + 0.9, zc - 0.7)

# ───────────────────────── DECK B : mess hall + galley ─────────────────────────
def deck_mess():
    zf = ZB; zc = ZA - SLAB
    floor_slab('B', zf)
    room_shell('B', zf, zc, ribs_y=[84, 90, 96, 102, 108, 123.2])
    hole_rails(zf)
    sign_plate('BTI_Sign_B_hall', 'B', -2.0, Y1 - 0.02, zf + 3.4, face=-1)
    sign_plate('BTI_Sign_B_door', 'B', (DOOR_X[0] + DOOR_X[1]) / 2, BULK_Y - 0.2, zf + 6.0, face=-1, w=3.6, h=1.05)
    # galley counter along the forward wall with warmers and a pass-through
    mb.box('BTI_Galley', 'BTI_VioletLight', X0 + 1.2, X1 - 1.2, Y0 + 0.5, Y0 + 3.6, zf, zf + 3.1)
    mb.box('BTI_Galley', 'BTI_Steel', X0 + 1.0, X1 - 1.0, Y0 + 0.4, Y0 + 3.8, zf + 3.1, zf + 3.35)
    for i in range(5):
        xa = X0 + 2.0 + i * 3.4
        mb.box('BTI_Galley', 'BTI_Steel', xa, xa + 2.4, Y0 + 1.0, Y0 + 2.6, zf + 3.35, zf + 4.2)
        mb.box('BTI_Galley_Glow', 'BTI_Amber', xa + .15, xa + 2.25, Y0 + 2.6, Y0 + 2.66, zf + 3.5, zf + 4.0)
        mb.box('BTI_Galley_Glow', 'BTI_LedGreen', xa + 1.0, xa + 1.2, Y0 + 2.62, Y0 + 2.72, zf + 3.2, zf + 3.3, uvs=.5)
    mb.box('BTI_Galley', 'BTI_Dark', X0 + 1.2, X1 - 1.2, Y0, Y0 + 0.5, zf + 3.8, zf + 6.4)       # hood back
    mb.box('BTI_Galley', 'BTI_Steel', X0 + 1.0, X1 - 1.0, Y0 + 0.3, Y0 + 2.8, zf + 5.2, zf + 5.5)   # extractor hood
    mb.box('BTI_Galley_Glow', 'BTI_Neon', X0 + 1.0, X1 - 1.0, Y0 + 2.7, Y0 + 2.9, zf + 5.15, zf + 5.2)
    wall_screen('BTI_WallScreen_B', -9.0, -4.2, Y0 + 0.05, zf + 4.6, zf + 6.5, 'menu', face=+1)
    wall_screen('BTI_WallScreen_B', 1.0, 5.8, Y0 + 0.05, zf + 4.6, zf + 6.5, 'nav_a', face=+1)
    # long mess tables with benches
    for tc in (-8.0, -2.0, 4.0):
        ye = {-8.0: 95.5, -2.0: 98.0}.get(tc, 102.0)
        mb.box('BTI_Mess', 'BTI_Table', tc - 1.1, tc + 1.1, 84.0, ye, zf + 1.7, zf + 1.95)
        for lx in (84.8, ye - 0.8):
            mb.box('BTI_Mess', 'BTI_Dark', tc - .9, tc + .9, lx - .15, lx + .15, zf, zf + 1.7)
        neon = 'BTI_NeonLine_B'
        mb.box(neon, 'BTI_NeonCyan', tc - .06, tc + .06, 84.1, ye - 0.1, zf + 1.95, zf + 2.0)
        for bx in (tc - 1.8, tc + 1.8):
            mb.box('BTI_Mess', 'BTI_FabricBlue' if tc != -2.0 else 'BTI_FabricTeal', bx - .4, bx + .4, 84.0, ye, zf + 1.0, zf + 1.2)
            for ly in (85.0, ye - 1.0):
                mb.box('BTI_Mess', 'BTI_Dark', bx - .3, bx + .3, ly - .12, ly + .12, zf, zf + 1.0)
        # trays and cups
        for ty in [t for t in (86.2, 90.0, 93.8, 97.6, 100.2) if t < ye - 0.8]:
            for sx in (-0.7, 0.7):
                mb.box('BTI_Mess_Trays', 'BTI_Steel', tc + sx - .35, tc + sx + .35, ty - .5, ty + .5, zf + 1.95, zf + 2.02, uvs=.5)
                mb.box('BTI_Mess_Trays', 'BTI_LedPink' if int(ty) % 2 else 'BTI_Amber', tc + sx - .12, tc + sx + .12, ty - .12, ty + .12, zf + 2.02, zf + 2.3, uvs=.5)
    # drink / ration dispensers along the east wall
    for y in (88.0, 93.5, 99.0):
        mb.box('BTI_Dispenser', 'BTI_VioletLight', X1 - 1.6, X1 - 0.05, y - 1.2, y + 1.2, zf, zf + 5.2)
        mb.quad('BTI_Dispenser_Face', 'BTI_Holo_crew' if y > 90 else 'BTI_Holo_menu', (X1 - 1.62, y - .9, zf + 2.6), (X1 - 1.62, y + .9, zf + 2.6), (X1 - 1.62, y + .9, zf + 4.7), (X1 - 1.62, y - .9, zf + 4.7))
        mb.box('BTI_Dispenser', 'BTI_Steel', X1 - 1.9, X1 - 1.6, y - .5, y + .5, zf + 1.2, zf + 1.4)
    # west wall: shelving with supplies
    for y in (86.0, 92.0):
        mb.box('BTI_Shelf', 'BTI_Dark', X0 + 0.05, X0 + 1.1, y - 2.0, y + 2.0, zf + 1.4, zf + 1.55)
        mb.box('BTI_Shelf', 'BTI_Dark', X0 + 0.05, X0 + 1.1, y - 2.0, y + 2.0, zf + 3.4, zf + 3.55)
        for k in range(5):
            mb.box('BTI_Shelf_Goods', ['BTI_FabricRose', 'BTI_FabricTeal', 'BTI_Amber'][k % 3], X0 + 0.25, X0 + 0.9, y - 1.8 + k * 0.75, y - 1.3 + k * 0.75, zf + 1.55, zf + 2.3 + (k % 2) * 0.4, uvs=.5)

# ───────────────────────── DECK C : crew quarters + engineering ─────────────────────────
ENG_Y = 91.5   # bulkhead between crew quarters (aft) and engineering (forward)
def deck_crew():
    zf = ZC; zc = ZB - SLAB
    floor_slab('C', zf, hole=False)
    room_shell('C', zf, zc, ribs_y=[84, 90, 96, 102, 108, 123.2])
    sign_plate('BTI_Sign_C_hall', 'C', -2.0, Y1 - 0.02, zf + 3.4, face=-1)
    sign_plate('BTI_Sign_C_door', 'C', (DOOR_X[0] + DOOR_X[1]) / 2, BULK_Y - 0.2, zf + 6.0, face=-1, w=3.6, h=1.05)
    # internal bulkhead crew | engineering
    mb.box('BTI_Shell_C', 'BTI_Violet', X0, DOOR_X[0], ENG_Y, ENG_Y + 0.5, zf, zc)
    mb.box('BTI_Shell_C', 'BTI_Violet', DOOR_X[1], X1, ENG_Y, ENG_Y + 0.5, zf, zc)
    mb.box('BTI_Shell_C', 'BTI_Violet', DOOR_X[0], DOOR_X[1], ENG_Y, ENG_Y + 0.5, zf + 5.6, zc)
    for x in DOOR_X:
        mb.box('BTI_Shell_C', 'BTI_VioletLight', x - .25, x + .25, ENG_Y - .15, ENG_Y + .65, zf, zf + 5.7)
    mb.box('BTI_Shell_C', 'BTI_VioletLight', DOOR_X[0], DOOR_X[1], ENG_Y - .15, ENG_Y + .65, zf + 5.45, zf + 5.95)
    for x in (DOOR_X[0] - 0.12, DOOR_X[1] + 0.12):
        mb.box('BTI_NeonLine_C', 'BTI_Neon', x - .07, x + .07, ENG_Y + .65, ENG_Y + .71, zf + .1, zf + 5.55)
    mb.box('BTI_NeonLine_C', 'BTI_Neon', DOOR_X[0] - .12, DOOR_X[1] + .12, ENG_Y + .65, ENG_Y + .71, zf + 5.55, zf + 5.69)
    sign_plate('BTI_Sign_C_eng', 'C', (DOOR_X[0] + DOOR_X[1]) / 2, ENG_Y + 0.55 + .05, zf + 6.05, face=+1, w=3.6, h=1.05)
    # bunks both walls: FULL-LENGTH berths (she is ~4.1 tall -> 5.0 mattress), 3 levels, 2 berths per wall = 12 beds
    BL = 2.6                                   # half-length of a berth
    for k, y in enumerate((96.9, 102.4)):
        for side in (-1, 1):
            xw = X0 if side < 0 else X1
            xa, xb = (xw + 0.0, xw + 2.5) if side < 0 else (xw - 2.5, xw)
            frame = 'BTI_Bunk'
            for lvl, hz in enumerate((1.0, 2.9, 4.8)):
                mb.box(frame, 'BTI_Dark', xa, xb, y - BL, y + BL, zf + hz - 0.3, zf + hz)
                mb.box(frame + '_Bed', ['BTI_FabricBlue', 'BTI_FabricRose', 'BTI_FabricTeal'][(k + lvl + (1 if side > 0 else 0)) % 3], xa + .05, xb - .05, y - BL + .1, y + BL - .1, zf + hz, zf + hz + 0.3, uvs=.5)
                mb.box(frame + '_Bed', 'BTI_Steel', xa + .15, xb - .15, y - BL + .15, y - BL + .85, zf + hz + .3, zf + hz + .52, uvs=.5)   # pillow
                mb.box('BTI_NeonLine_C', 'BTI_NeonAmber', (xa + xb) / 2 - .5, (xa + xb) / 2 + .5, y - .05, y + .05, zf + hz + 1.15, zf + hz + 1.23)   # reading light
            for yy in (y - BL, y + BL):
                mb.box(frame, 'BTI_Dark', xa, xb, yy - .08, yy + .08, zf, zf + 6.1)
            # outer rail posts + a short ladder rung set on the aisle side
            ax = xb if side < 0 else xa
            for hz in (1.0, 2.9, 4.8):
                mb.box(frame, 'BTI_Dark', ax - .05, ax + .05, y - BL, y + BL, zf + hz + 0.3, zf + hz + 0.5)
    # lockers + a wall display
    for x in (X0 + 1.0, X1 - 1.0):
        mb.box('BTI_Lockers', 'BTI_VioletLight', x - 1.0, x + 1.0, ENG_Y + 0.8, ENG_Y + 2.2, zf, zf + 5.0)
        for z in (1.6, 3.3):
            mb.box('BTI_Lockers', 'BTI_Dark', x - .8, x + .8, ENG_Y + 2.18 - 0.02, ENG_Y + 2.22, zf + z, zf + z + .25, uvs=.5)
    wall_screen('BTI_WallScreen_C', -9.0, -4.0, Y1 - 0.05, zf + 3.6, zf + 5.6, 'crew', face=-1)
    # ── engineering ──
    cxe, cye = -2.0, 84.3
    mb.cyl('BTI_Reactor_Base', 'BTI_VioletLight', cxe, cye, zf, zf + 0.7, 3.6, 24, r1=3.2)
    mb.cyl('BTI_Reactor_Base', 'BTI_Dark', cxe, cye, zf + .7, zf + .85, 3.3, 24)
    mb.cyl('BTI_Reactor_Core', 'BTI_Reactor', cxe, cye, zf + 0.85, zc - 0.3, 1.1, 20)
    for z, r in ((zf + 2.0, 1.9), (zf + 3.8, 1.7), (zf + 5.4, 1.5)):
        mb.cyl('BTI_Reactor_Rings', 'BTI_ReactorViolet', cxe, cye, z, z + .28, r, 24)
        mb.cyl('BTI_Reactor_Rings', 'BTI_Steel', cxe, cye, z - .15, z, r - .35, 24)
    for a in range(8):
        ang = a * math.pi / 4; px, py = cxe + 3.0 * math.cos(ang), cye + 3.0 * math.sin(ang)
        mb.cyl('BTI_Reactor_Rails', 'BTI_Dark', px, py, zf + .85, zf + 2.2, .08, 6)
    # conduits along the ceiling and wall
    for xx in (X0 + 3.0, X1 - 3.0):
        mb.cyl_y('BTI_Pipes', 'BTI_Steel', xx, zc - 0.7, Y0 + 0.2, ENG_Y - 0.2, 0.35)
        mb.cyl_y('BTI_Pipes', 'BTI_VioletLight', xx + .9, zc - 0.55, Y0 + 0.2, ENG_Y - 0.2, 0.2)
    for z in (zf + 1.5, zf + 3.0):
        mb.cyl_y('BTI_Pipes', 'BTI_Steel', X0 + .5, z, Y0 + .2, ENG_Y - .2, .22)
        mb.cyl_y('BTI_Pipes', 'BTI_Steel', X1 - .5, z, Y0 + .2, ENG_Y - .2, .22)
    # engineering consoles on the side walls
    console('BTI_Console_E', X0 + 0.3, 85.5, zf, (-1, 0), width=5.2, screen='engine')
    console('BTI_Console_E', X1 - 0.3, 85.5, zf, (1, 0), width=5.2, screen='engine')
    led_cluster('BTI_Console_E', X0 + 0.3, 85.5, zf, (-1, 0), 5.2); led_cluster('BTI_Console_E', X1 - 0.3, 85.5, zf, (1, 0), 5.2)
    wall_screen('BTI_WallScreen_E', -5.0, 1.0, Y0 + 0.05, zf + 3.8, zf + 6.4, 'engine', face=+1)


# ───────────────────────── food store (deck B, aft-west corner off the mess) ─────────────────────────
STORE = dict(x0=X0, x1=-4.4, y0=97.4, y1=BULK_Y)
def food_store():
    zf = ZB; zc = ZA - SLAB; nm = 'BTI_Shell_Store'
    sx1, sy0 = STORE['x1'], STORE['y0']
    mb.box(nm, 'BTI_Violet', X0, sx1 + 0.4, sy0 - 0.4, sy0, zf, zc)                    # south wall
    d0, d1 = 99.4, 103.0                                                              # doorway in the east wall
    mb.box(nm, 'BTI_Violet', sx1, sx1 + 0.4, sy0, d0, zf, zc)
    mb.box(nm, 'BTI_Violet', sx1, sx1 + 0.4, d1, BULK_Y, zf, zc)
    mb.box(nm, 'BTI_Violet', sx1, sx1 + 0.4, d0, d1, zf + 5.6, zc)
    for y in (d0, d1):
        mb.box(nm, 'BTI_VioletLight', sx1 - 0.2, sx1 + 0.6, y - .25, y + .25, zf, zf + 5.7)
    mb.box(nm, 'BTI_VioletLight', sx1 - 0.2, sx1 + 0.6, d0, d1, zf + 5.45, zf + 5.95)
    for y in (d0 + 0.12, d1 - 0.12):
        mb.box('BTI_NeonLine_B', 'BTI_Neon', sx1 + .6, sx1 + .66, y - .05, y + .05, zf + .1, zf + 5.55)
    mb.box('BTI_NeonLine_B', 'BTI_Neon', sx1 + .6, sx1 + .66, d0, d1, zf + 5.55, zf + 5.69)
    # STORE sign above the door (faces +x into the mess)
    zs = zf + 6.0; xs = sx1 + 0.66
    mb.quad('BTI_Sign_Store', 'BTI_Sign_STORE', (xs, d0, zs), (xs, d1, zs), (xs, d1, zs + 1.05), (xs, d0, zs + 1.05))
    # ceiling neon + floor edge line
    mb.box('BTI_NeonLine_B', 'BTI_Neon', X0 + 0.6, sx1 - 0.6, 101.0, 101.3, zc - 0.5, zc - 0.38)
    mb.box('BTI_NeonLine_B', 'BTI_NeonCyan', X0 + 0.6, sx1 - 0.2, sy0 + 0.1, sy0 + 0.2, zf + 0.95, zf + 1.07)
    # west-wall shelving (3 levels) stocked with crates, jars and sacks
    cols = ['BTI_FabricRose', 'BTI_FabricTeal', 'BTI_Amber', 'BTI_FabricBlue']
    for lvl, hz in enumerate((1.4, 2.9, 4.4)):
        mb.box('BTI_Shelf', 'BTI_Dark', X0 + 0.05, X0 + 1.5, sy0 + 0.6, BULK_Y - 0.4, zf + hz, zf + hz + 0.14)
        for k in range(7):
            y = sy0 + 1.0 + k * 1.05
            mb.box('BTI_Shelf_Goods', cols[(k + lvl) % 4], X0 + 0.25, X0 + 1.3, y, y + 0.8, zf + hz + 0.14, zf + hz + 0.14 + 0.7 + ((k * 7 + lvl) % 3) * 0.2, uvs=.5)
    for y in (sy0 + 0.6, BULK_Y - 0.5):
        mb.box('BTI_Shelf', 'BTI_Dark', X0 + 0.05, X0 + 1.5, y - 0.07, y + 0.07, zf, zf + 5.8)
    # south-wall dry-goods racks
    for lvl, hz in enumerate((1.4, 3.1)):
        mb.box('BTI_Shelf', 'BTI_Dark', X0 + 2.2, sx1 - 0.4, sy0 + 0.05, sy0 + 1.4, zf + hz, zf + hz + 0.14)
        for k in range(5):
            x = X0 + 2.5 + k * 1.1
            mb.box('BTI_Shelf_Goods', cols[(k + lvl * 2) % 4], x, x + 0.85, sy0 + 0.25, sy0 + 1.2, zf + hz + 0.14, zf + hz + 0.9, uvs=.5)
    # centre island: stacked crates and barrels (leaves a walkway from the door)
    for i, (cx, cy) in enumerate([(-8.6, 100.0), (-8.6, 101.6), (-8.6, 103.2)]):
        mb.box('BTI_Crates', 'BTI_Steel', cx - .8, cx + .8, cy - .7, cy + .7, zf, zf + 1.3, uvs=.3)
        mb.box('BTI_Crates', cols[i % 4], cx - .7, cx + .7, cy - .6, cy + .6, zf + 1.3, zf + 2.2, uvs=.5)
        if i != 1: mb.box('BTI_Crates', 'BTI_Dark', cx - .6, cx + .6, cy - .5, cy + .5, zf + 2.2, zf + 2.9, uvs=.5)
    for (bx, by) in [(-6.2, 98.6), (-6.2, 99.7), (-5.5, 99.15)]:
        mb.cyl('BTI_Barrels', 'BTI_VioletLight', bx, by, zf, zf + 1.7, .45, 12)
        mb.cyl('BTI_Barrels', 'BTI_NeonAmber', bx, by, zf + 1.0, zf + 1.12, .47, 12)
    # cold locker on the bulkhead with a frosted window
    cx0, cx1, cy0 = -10.2, -7.4, BULK_Y - 1.5
    mb.box('BTI_ColdLocker', 'BTI_VioletLight', cx0, cx1, cy0, BULK_Y, zf, zf + 5.4)
    mb.box('BTI_ColdLocker', 'BTI_Steel', cx0 + .2, cx1 - .2, cy0 - .06, cy0, zf + .4, zf + 5.0, uvs=.3)
    mb.box('BTI_ColdLocker_Glow', 'BTI_NeonCyan', cx0 + .6, cx1 - .6, cy0 - .1, cy0 - .06, zf + 2.2, zf + 4.4)
    mb.box('BTI_ColdLocker', 'BTI_Dark', cx0 + .1, cx0 + .3, cy0 - .12, cy0 - .06, zf + 1.6, zf + 2.6, uvs=.5)
    # inventory screen on the south wall
    wall_screen('BTI_WallScreen_B', -9.2, -5.4, sy0 + 0.0, zf + 3.4, zf + 5.4, 'menu', face=+1)

# ───────────────────────── wall light switches (interactive) ─────────────────────────
SWITCHES = []     # (group, pivot xyz)
def wall_switch(group, x, y, zf):
    """plate on a wall that faces -y at coordinate y; the lever sticks out toward -y and tilts about X"""
    zc0 = zf + 3.6
    mb.box('BTI_SwitchPlate', 'BTI_Dark', x - .55, x + .55, y - .14, y, zc0 - .85, zc0 + .85, uvs=.5)
    mb.box('BTI_SwitchPlate', 'BTI_Neon', x - .6, x + .6, y - .16, y - .12, zc0 + .85, zc0 + .93, uvs=.5)
    mb.box('BTI_SwitchPlate', 'BTI_Neon', x - .6, x + .6, y - .16, y - .12, zc0 - .93, zc0 - .85, uvs=.5)
    mb.box('BTI_SwitchLed', 'BTI_LedGreen', x - .12, x + .12, y - .2, y - .14, zc0 + .55, zc0 + .7, uvs=.5)
    pv = (x, y - .14, zc0)
    nm = 'IX_Switch_' + group
    mb.part(nm, origin=pv)
    mb.box(nm, 'BTI_Steel', x - .09, x + .09, y - .14 - .62, y - .14, zc0 - .09, zc0 + .09, uvs=.5)
    mb.box(nm, 'BTI_NeonAmber', x - .16, x + .16, y - .14 - .82, y - .14 - .6, zc0 - .16, zc0 + .16, uvs=.5)
    SWITCHES.append((group, pv))

# ───────────────────────── top-deck hatch (animated) ─────────────────────────
HATCH_HINGE_Y = SY0 - 0.8          # hinge edge (forward), so the lid stands up away from the stair entry
LID = dict(x0=SX0 - 0.8, x1=SX1 + 0.8, y0=SY0 - 0.8, y1=SY1 + 0.8)

def hatch():
    # coaming ring (static) sits on the hull top
    zc0, zc1 = DECK, DECK + 0.25     # low coaming: a clean step down onto the first tread
    nm = 'BTI_Coaming'
    t = 0.6
    mb.box(nm, 'BTI_VioletLight', SX0 - t, SX0, SY0 - t, SY1 + t, zc0, zc1)
    mb.box(nm, 'BTI_VioletLight', SX1, SX1 + t, SY0 - t, SY1 + t, zc0, zc1)
    mb.box(nm, 'BTI_VioletLight', SX0, SX1, SY0 - t, SY0, zc0, zc1)
    mb.box(nm, 'BTI_VioletLight', SX0, SX1, SY1, SY1 + t, zc0, zc1)
    mb.box('BTI_NeonLine_Top', 'BTI_Neon', SX0 - t - .05, SX0 - t + .1, SY0 - t, SY1 + t, zc0, zc1 + .02)
    mb.box('BTI_NeonLine_Top', 'BTI_Neon', SX1 + t - .1, SX1 + t + .05, SY0 - t, SY1 + t, zc0, zc1 + .02)
    mb.box('BTI_NeonLine_Top', 'BTI_Neon', SX0 - t, SX1 + t, SY0 - t - .05, SY0 - t + .1, zc0, zc1 + .02)
    mb.box('BTI_NeonLine_Top', 'BTI_Neon', SX0 - t, SX1 + t, SY1 + t - .1, SY1 + t + .05, zc0, zc1 + .02)
    # inner shaft walls from deck to deck A slab (stops the hole looking into the hull void)
    for (a, b, c, d) in [(SX0 - .2, SX0, SY0 - .2, SY1 + .2), (SX1, SX1 + .2, SY0 - .2, SY1 + .2), (SX0, SX1, SY0 - .2, SY0), (SX0, SX1, SY1, SY1 + .2)]:
        mb.box('BTI_ShaftWalls', 'BTI_Violet', a, b, c, d, CEIL_A - 0.02, DECK)
    # lid: origin at the hinge line so the game just rotates about X
    hx = (LID['x0'] + LID['x1']) / 2
    piv = (hx, LID['y0'], zc1)
    mb.part('IX_Hatch_Lid', origin=piv)
    zl0, zl1 = zc1, zc1 + 0.3
    mb.box('IX_Hatch_Lid', 'BTI_VioletLight', LID['x0'], LID['x1'], LID['y0'], LID['y1'], zl0, zl1)
    # raised hazard-stripe chevrons + inset neon frame
    mb.box('IX_Hatch_Lid', 'BTI_Neon', LID['x0'] + .25, LID['x1'] - .25, LID['y0'] + .25, LID['y0'] + .4, zl1, zl1 + .05)
    mb.box('IX_Hatch_Lid', 'BTI_Neon', LID['x0'] + .25, LID['x1'] - .25, LID['y1'] - .4, LID['y1'] - .25, zl1, zl1 + .05)
    mb.box('IX_Hatch_Lid', 'BTI_Neon', LID['x0'] + .25, LID['x0'] + .4, LID['y0'] + .25, LID['y1'] - .25, zl1, zl1 + .05)
    mb.box('IX_Hatch_Lid', 'BTI_Neon', LID['x1'] - .4, LID['x1'] - .25, LID['y0'] + .25, LID['y1'] - .25, zl1, zl1 + .05)
    for k in range(6):
        yy = LID['y0'] + 1.0 + k * 1.5
        mb.box('IX_Hatch_Lid', 'BTI_Hazard', LID['x0'] + .6, LID['x0'] + 1.5, yy, yy + .5, zl1, zl1 + .04)
        mb.box('IX_Hatch_Lid', 'BTI_Hazard', LID['x1'] - 1.5, LID['x1'] - .6, yy, yy + .5, zl1, zl1 + .04)
    # hinges (stay with the pivot, on the hull)
    for hxx in (LID['x0'] + 1.2, LID['x1'] - 1.2):
        mb.box('BTI_Hinges', 'BTI_Steel', hxx - .5, hxx + .5, LID['y0'] - .5, LID['y0'] + .4, zc1 - .1, zc1 + .5)
    # sign on the deck in front of the hatch (stern side where you walk up)
    mb.quad('BTI_Sign_Top', 'BTI_Sign_TOP', (hx + 3.0, SY1 + t + 2.2, DECK + .03), (hx - 3.0, SY1 + t + 2.2, DECK + .03), (hx - 3.0, SY1 + t + 1.2, DECK + .03), (hx + 3.0, SY1 + t + 1.2, DECK + .03))
    # wheel: ring + 6 spokes + hub; origin at the wheel's centre, rotates about local Z
    wc = (hx, (LID['y0'] + LID['y1']) / 2, zl1 + .05)
    mb.part('IX_Hatch_Wheel', origin=wc)
    mb.cyl('IX_Hatch_Wheel', 'BTI_Steel', wc[0], wc[1], wc[2], wc[2] + .22, .55, 18)
    R, r = 1.7, .17
    seg = 28
    for i in range(seg):
        a0 = 2 * math.pi * i / seg; a1 = 2 * math.pi * (i + 1) / seg
        pts = []
        for a, rr in ((a0, R - r), (a1, R - r), (a1, R + r), (a0, R + r)):
            pts.append((wc[0] + rr * math.cos(a), wc[1] + rr * math.sin(a)))
        mb.face('IX_Hatch_Wheel', 'BTI_Steel', [(x, y, wc[2] + .05) for x, y in pts][::-1] if False else [(x, y, wc[2] + .32) for x, y in pts])
        mb.face('IX_Hatch_Wheel', 'BTI_Steel', [(pts[0][0], pts[0][1], wc[2] + .05), (pts[1][0], pts[1][1], wc[2] + .05), (pts[1][0], pts[1][1], wc[2] + .32), (pts[0][0], pts[0][1], wc[2] + .32)])
        mb.face('IX_Hatch_Wheel', 'BTI_Steel', [(pts[3][0], pts[3][1], wc[2] + .32), (pts[2][0], pts[2][1], wc[2] + .32), (pts[2][0], pts[2][1], wc[2] + .05), (pts[3][0], pts[3][1], wc[2] + .05)])
        mb.face('IX_Hatch_Wheel', 'BTI_Steel', [(pts[1][0], pts[1][1], wc[2] + .05), (pts[2][0], pts[2][1], wc[2] + .05), (pts[2][0], pts[2][1], wc[2] + .32), (pts[1][0], pts[1][1], wc[2] + .32)])
        mb.face('IX_Hatch_Wheel', 'BTI_Steel', [(pts[3][0], pts[3][1], wc[2] + .05), (pts[0][0], pts[0][1], wc[2] + .05), (pts[0][0], pts[0][1], wc[2] + .32), (pts[3][0], pts[3][1], wc[2] + .32)])
    for s in range(6):
        a = math.pi * s / 3
        dx, dy = math.cos(a), math.sin(a); nx, ny = -dy, dx; w = .11
        for sgn in (1,):
            p = [(wc[0] + nx * w, wc[1] + ny * w), (wc[0] + dx * (R - r) + nx * w, wc[1] + dy * (R - r) + ny * w), (wc[0] + dx * (R - r) - nx * w, wc[1] + dy * (R - r) - ny * w), (wc[0] - nx * w, wc[1] - ny * w)]
            mb.face('IX_Hatch_Wheel', 'BTI_Steel', [(x, y, wc[2] + .3) for x, y in p])
            p2 = [(2 * wc[0] - x, 2 * wc[1] - y) for x, y in p]
            mb.face('IX_Hatch_Wheel', 'BTI_Steel', [(x, y, wc[2] + .3) for x, y in p2])
    mb.cyl('IX_Hatch_Wheel', 'BTI_NeonAmber', wc[0], wc[1], wc[2] + .22, wc[2] + .4, .22, 12)
    for s in range(6):                                  # grips
        a = math.pi * s / 3 + 0.0
        gx, gy = wc[0] + (R + r + .05) * math.cos(a), wc[1] + (R + r + .05) * math.sin(a)
        mb.cyl('IX_Hatch_Wheel', 'BTI_NeonAmber', gx, gy, wc[2] + .0, wc[2] + .5, .13, 8)
    return piv, wc

# ───────────────────────── interactive nav button + light markers ─────────────────────────
NAV_BTN = (-2.0, Y0 + 0.6 + 2.4, ZA + 2.55)
def interactables():
    p = NAV_BTN
    mb.part('IX_NavButton', origin=p)
    mb.box('IX_NavButton', 'BTI_LedRed', p[0] - .45, p[0] + .45, p[1] - .45, p[1] + .45, p[2], p[2] + .22, uvs=.5)
    mb.box('BTI_NavButtonBase', 'BTI_Dark', p[0] - .6, p[0] + .6, p[1] - .6, p[1] + .6, p[2] - .06, p[2], uvs=.5)

# ═════════════════ CARGO BAY (port hull) · CORRIDOR TO DECK A · FORECASTLE COMMAND ROOM ═════════════════
# All three share the bay level: floor top BF, ceiling underside BC (the underside of the top deck).
BF, BC = -10.5, -0.3
BCS = BC + 0.5                                   # ceiling slab top
def skin_x(z, y=None):                           # port hull skin = min(mid-ship slope P6, bow plane P7)  (measured, max dev 0.15)
    p6 = 38.65 + 0.5 * z
    if y is None: return p6
    return min(p6, 50.81 + 0.4483 * y - 0.1971 * z)
BAY = dict(x0=-20.0, y0=-36.0, y1=34.0)          # inner faces: starboard wall, bow wall, stern wall
BAY_OPEN = [(-36.0, BF), (32.0, BF), (32.0, -1.5), (-30.0, -1.5)]   # opening in the skin (y,z), CCW; the front edge leans back
PAD = (9.0, 0.0)                                 # landing pad centre (x, y)
Yf = -77.6                                       # flat front plate of the forecastle
GZ0, GZ1 = -7.7, -1.6                            # the panoramic window band (z)
WY0, XF = -48.0, 15.2                            # windows start at y=WY0 on both flanks; front window half-width
PLAT = -8.0                                      # observation platform floor in the bow; ramp up from y=-60 to y=-67
CMD = dict(x0=-20.0, y0=Yf, y1=-36.5)         # forecastle command room (stern wall = the bay's bow wall)
GLASS_P = [(Yf + 0.6, GZ0), (WY0, GZ0), (WY0, GZ1), (Yf + 0.6, GZ1)]       # (y,z): port + starboard flank windows
GLASS_F = [(-XF, GZ0), (XF, GZ0), (XF, GZ1), (-XF, GZ1)]                   # (x,z): front window
GLASS_POLY = GLASS_P
CMD_DOOR = (11.0, 17.0)                          # doorway bay -> command room (in the bay's bow wall)
COR = dict(x0=9.0, x1=15.0, y0=34.5, y1=112.0, ramp_y1=50.0)       # corridor interior (floor top: BF at y0 rising to ZA at ramp_y1)
BAY_DOOR = (9.0, 15.0)                           # doorway bay <-> corridor in the stern wall

def sk(y, z, off=0.0): return (skin_x(z, y) + off, y, z)
def skin_poly(nm, m, poly, off=-0.12, inward=False):
    pts = [sk(y, z, off) for y, z in poly]
    mb.face(nm, m, pts[::-1] if inward else pts)
def skin_rect(nm, m, ya, yb, za, zb, off=-0.12, inward=False, step=1.5):
    n = max(1, int(math.ceil((yb - ya) / step))); k = max(1, int(math.ceil((zb - za) / 4.0)))
    for i in range(n):
        for q in range(k):
            y0_ = ya + (yb - ya) * i / n; y1_ = ya + (yb - ya) * (i + 1) / n
            z0_ = za + (zb - za) * q / k; z1_ = za + (zb - za) * (q + 1) / k
            pts = [sk(y0_, z0_, off), sk(y1_, z0_, off), sk(y1_, z1_, off), sk(y0_, z1_, off)]
            mb.face(nm, m, pts[::-1] if inward else pts)
def slab_strips(nm, m, xs, ya, yb, z0, z1, inset=0.2, step=1.0, uvs=.1):
    n = int(math.ceil((yb - ya) / step))
    for i in range(n):
        a = ya + (yb - ya) * i / n; b = ya + (yb - ya) * (i + 1) / n
        xe = min(skin_x(z, yy) for z in (z0, z1) for yy in (a, b)) - inset
        mb.box(nm, m, xs, xe, a, b, z0, z1, uvs=uvs)
def lip_strips(nm, m, ya, yb, step=1.0):
    n = int(math.ceil((yb - ya) / step))
    for i in range(n):
        a = ya + (yb - ya) * i / n; b = ya + (yb - ya) * (i + 1) / n
        xa = min(skin_x(BF - SLAB, yy) for yy in (a, b)); xb = min(skin_x(BF, yy) for yy in (a, b))
        mb.prism_xz(nm, m, a, b, [(xa - 1.5, BF - SLAB), (xa, BF - SLAB), (xb, BF), (xb - 1.5, BF)])
def ceil_grille(nm, xs, ya, yb, step=2.0, inset=0.35):
    n = int(math.ceil((yb - ya) / step))
    for i in range(n):
        a = ya + (yb - ya) * i / n; b = ya + (yb - ya) * (i + 1) / n
        xe = min(skin_x(BC, a), skin_x(BC, b)) - inset
        mb.quad(nm, 'BTI_Grille', (xs, b, BC - .02), (xe, b, BC - .02), (xe, a, BC - .02), (xs, a, BC - .02), uv=((xe - xs) / 3, (b - a) / 3))
def skin_frame(nm, m, poly, w, off):
    n = len(poly)
    for i in range(n):
        (y0, z0), (y1, z1) = poly[i], poly[(i + 1) % n]
        dy, dz = y1 - y0, z1 - z0; L = math.hypot(dy, dz); ny, nz = dz / L, -dy / L
        mb.face(nm, m, [sk(y, z, off) for y, z in [(y0, z0), (y1, z1), (y1 + ny * w, z1 + nz * w), (y0 + ny * w, z0 + nz * w)]])

def wall_y_skin(nm, y, th, xs, zf, zc, doors=(), m='BTI_Violet'):
    """wall across the room at y..y+th running from x=xs out to the port skin, with doorways"""
    cur = xs
    for (xa, xb) in sorted(doors):
        mb.box(nm, m, cur, xa, y, y + th, zf, zc)
        mb.box(nm, m, xa, xb, y, y + th, zf + 5.7, zc)
        cur = xb
    mb.prism_xz(nm, m, y, y + th, [(cur, zf), (skin_x(zf, y) - 0.15, zf), (skin_x(zc, y) - 0.15, zc), (cur, zc)])

def door_frame_y(nm, xa, xb, y, th, zf, neon='BTI_NeonCyan'):
    for x in (xa, xb):
        mb.box(nm, 'BTI_VioletLight', x - .25, x + .25, y - .15, y + th + .15, zf, zf + 5.8)
    mb.box(nm, 'BTI_VioletLight', xa, xb, y - .15, y + th + .15, zf + 5.55, zf + 5.95)
    for yy in (y - .2, y + th + .2):
        for x in (xa + .27, xb - .27):
            mb.box('BTI_NeonLine_Bay', neon, x - .05, x + .05, yy - .03, yy + .03, zf + .1, zf + 5.55)
        mb.box('BTI_NeonLine_Bay', neon, xa, xb, yy - .03, yy + .03, zf + 5.55, zf + 5.69)

def ring_flat(nm, m, cx, cy, z, r0, r1, seg=40, a0=0.0, a1=2 * math.pi):
    for i in range(seg):
        t0 = a0 + (a1 - a0) * i / seg; t1 = a0 + (a1 - a0) * (i + 1) / seg
        mb.face(nm, m, [(cx + r0 * math.cos(t0), cy + r0 * math.sin(t0), z), (cx + r1 * math.cos(t0), cy + r1 * math.sin(t0), z),
                        (cx + r1 * math.cos(t1), cy + r1 * math.sin(t1), z), (cx + r0 * math.cos(t1), cy + r0 * math.sin(t1), z)])

def crate(nm, x0, x1, y0, y1, z0, h, col, uv=.4):
    mb.box(nm, 'BTI_Steel', x0, x1, y0, y1, z0, z0 + h, uvs=.3)
    mb.box(nm + '_Panel', col, x0 + .12, x1 - .12, y0 + .12, y1 - .12, z0 + .05, z0 + h + .02, uvs=uv)
    mb.box(nm, 'BTI_Dark', x0 - .03, x1 + .03, y0 - .03, y1 + .03, z0 + h * .45, z0 + h * .55, uvs=.3)

def cargo_bay():
    nm = 'BTI_Shell_Bay'
    xs = BAY['x0']; y0, y1 = BAY['y0'] - 0.5, BAY['y1'] + 0.5
    # floor (deck plate) + hazard lip that ends flush with the hull skin at the opening
    mb.box('BTI_Floor_Bay', 'BTI_Floor', xs - 0.5, 33.0, y0, y1, BF - SLAB, BF, uvs=.1)
    mb.prism_xz('BTI_BayLip', 'BTI_HazardDark', BAY['y0'], BAY_OPEN[1][0], [(33.0, BF - SLAB), (skin_x(BF - SLAB), BF - SLAB), (skin_x(BF), BF), (33.0, BF)])
    # ceiling slab (underside of the top deck) + grille panels
    slab_strips('BTI_Floor_Bay_ceiling', 'BTI_Violet', xs - 0.5, y0, y1, BC, BCS, inset=0.3, step=2.0)
    ceil_grille('BTI_Ceiling_Bay', xs, y0 + 0.5, y1 - 0.5)
    # starboard (far) wall, bow wall (door to the command room), stern wall (door to the corridor)
    mb.box(nm, 'BTI_Violet', xs - 0.5, xs, y0, y1, BF, BC)
    wall_y_skin(nm, BAY['y0'] - 0.5, 0.5, xs - 0.5, BF, BC, doors=[CMD_DOOR])
    wall_y_skin(nm, BAY['y1'], 0.5, xs - 0.5, BF, BC, doors=[BAY_DOOR])
    door_frame_y(nm, CMD_DOOR[0], CMD_DOOR[1], BAY['y0'] - 0.5, 0.5, BF)
    door_frame_y(nm, BAY_DOOR[0], BAY_DOOR[1], BAY['y1'], 0.5, BF)
    # port skin liners (the hull skin is one-sided): everything round the opening
    for poly in ([(-36.5, -1.5), (34.5, -1.5), (34.5, BC), (-36.5, BC)],
                 [(32.0, BF), (34.5, BF), (34.5, -1.5), (32.0, -1.5)],
                 [(-36.5, BF), (-36.0, BF), (-30.0, -1.5), (-36.5, -1.5)]):
        skin_poly(nm, 'BTI_VioletIn', poly, inward=True)
    # opening trim: dark surround + amber neon edge on the skin, floor-edge guide lights
    skin_frame('BTI_BayFrame', 'BTI_HazardDark', BAY_OPEN, 0.9, 0.06)
    skin_frame('BTI_BayFrame_Neon', 'BTI_NeonAmber', BAY_OPEN, 0.28, 0.1)
    skin_frame('BTI_BayFrame_In', 'BTI_Neon', BAY_OPEN, -0.22, 0.04)
    for k in range(-5, 5):
        yy = k * 6.4 + 1.2
        mb.box('BTI_BayGuide', 'BTI_LedGreen', skin_x(BF) - 1.3, skin_x(BF) - 0.9, yy - .25, yy + .25, BF, BF + .14, uvs=.5)
    # hazard stripes just inside the lip, landing pad rings + lead-in lanes
    n = 28
    for i in range(n):
        ya = BAY['y0'] + i * 2.5
        if ya > 31.0: break
        mb.box('BTI_BayHazard', 'BTI_Hazard' if i % 2 == 0 else 'BTI_HazardDark', 29.2, 31.4, ya, ya + 2.5, BF, BF + .03, uvs=.5)
    ring_flat('BTI_PadRing', 'BTI_NeonCyan', PAD[0], PAD[1], BF + .03, 6.2, 6.55)
    ring_flat('BTI_PadRing', 'BTI_NeonAmber', PAD[0], PAD[1], BF + .03, 3.9, 4.05, seg=36)
    mb.box('BTI_PadRing', 'BTI_NeonCyan', PAD[0] - 6.55, PAD[0] + 6.55, PAD[1] - .1, PAD[1] + .1, BF, BF + .03)
    mb.box('BTI_PadRing', 'BTI_NeonCyan', PAD[0] - .1, PAD[0] + .1, PAD[1] - 6.55, PAD[1] + 6.55, BF, BF + .03)
    for sy in (-3.4, 3.4):
        mb.box('BTI_PadLane', 'BTI_NeonCyan', PAD[0] + 6.8, 29.0, PAD[1] + sy - .09, PAD[1] + sy + .09, BF, BF + .03)
    for cx in (12.0, 16.5, 21.0, 25.5):
        mb.prism_xz('BTI_PadLane', 'BTI_NeonAmber', PAD[1] - 2.2, PAD[1] + 2.2, [(cx, BF + .03), (cx + 1.8, BF + .03), (cx + .9, BF + .03)]) if False else None
    # ribs across the ceiling (beams) + pilasters on the far wall
    for yy in range(-30, 34, 10):
        mb.box(nm + '_Beam', 'BTI_VioletLight', xs, 38.0, yy - .4, yy + .4, BC - .7, BC)
        mb.box('BTI_NeonLine_Bay', 'BTI_Neon', xs + 1.0, 36.5, yy - .08, yy + .08, BC - .76, BC - .7)
        mb.box(nm + '_Pil', 'BTI_VioletLight', xs, xs + .8, yy - .5, yy + .5, BF, BC)
    mb.box('BTI_NeonLine_Bay', 'BTI_Neon', xs + 0.05, xs + 0.15, BAY['y0'] + .3, BAY['y1'] - .3, BF + 0.95, BF + 1.07)
    mb.box('BTI_NeonLine_Bay', 'BTI_Neon', xs + 0.05, xs + 0.15, BAY['y0'] + .3, BAY['y1'] - .3, BC - 0.8, BC - .68)
    # cargo: crates + drums along the far wall and in the stern-far corner (pad and both door lanes stay clear)
    cols = ['BTI_FabricRose', 'BTI_FabricTeal', 'BTI_Amber', 'BTI_FabricBlue']
    for i, yy in enumerate([-31.0, -25.0, -19.0, -13.0]):
        crate('BTI_Crates', xs + 0.3, xs + 5.3, yy, yy + 4.4, BF, 3.4, cols[i % 4])
        if i % 2 == 0: crate('BTI_Crates', xs + 0.5, xs + 4.8, yy + .2, yy + 4.2, BF + 3.4, 2.7, cols[(i + 1) % 4])
    for i, yy in enumerate([-3.0, 3.0]):
        crate('BTI_Crates', xs + 0.3, xs + 5.0, yy, yy + 4.2, BF, 2.6, cols[(i + 2) % 4])
    crate('BTI_Crates', xs + 0.3, xs + 9.5, 26.0, 33.4, BF, 4.4, cols[0])
    crate('BTI_Crates', xs + 0.6, xs + 9.2, 26.4, 33.0, BF + 4.4, 2.4, cols[2])
    crate('BTI_Crates', xs + 10.0, xs + 15.0, 29.0, 33.4, BF, 3.4, cols[1])
    for (bx, by) in [(-1.5, 30.5), (0.3, 31.4), (-1.0, 32.4), (1.2, 30.0)]:
        mb.cyl('BTI_Barrels', 'BTI_VioletLight', bx, by, BF, BF + 2.5, .65, 12)
        mb.cyl('BTI_Barrels', 'BTI_NeonAmber', bx, by, BF + 1.4, BF + 1.55, .67, 12)
    # bay control console + screens by the stern door, signs, switch
    console('BTI_Console_Bay', -1.0, BAY['y1'] - 0.6, BF, (0, 1), width=5.6, screen='bay')
    led_cluster('BTI_Console_Bay', -1.0, BAY['y1'] - 0.6, BF, (0, 1), 5.6)
    chair('BTI_Seat_Bay', -1.0, BAY['y1'] - 3.3, BF, face=+1)
    wall_screen('BTI_WallScreen_Bay', -4.0, 2.0, BAY['y1'] - 0.0, BF + 4.8, BF + 7.0, 'bay', face=-1)
    wall_screen('BTI_WallScreen_Bay', -16.0, -7.0, BAY['y1'] - 0.0, BF + 3.2, BF + 8.2, 'sector', face=-1)
    wall_screen_x('BTI_WallScreen_Bay', xs, -16.0, -4.0, BF + 3.2, BF + 8.0, 'nav_a', face=+1)
    wall_screen_x('BTI_WallScreen_Bay', xs, 4.0, 16.0, BF + 3.2, BF + 8.0, 'radar', face=+1)
    sign_plate('BTI_Sign_Bay', 'BAY', 12.0, BAY['y1'] - 0.0, BF + 6.3, face=-1, w=5.6, h=1.45)
    sign_plate('BTI_Sign_BayCmd', 'CMD', 14.0, BAY['y0'] - 0.0, BF + 6.3, face=+1, w=5.6, h=1.45)

def corridor():
    nm = 'BTI_Shell_Corr'
    x0, x1, y0, y1 = COR['x0'], COR['x1'], COR['y0'], COR['y1']
    ry = COR['ramp_y1']
    # floor: ramp (BF -> ZA) then flat; slab prism extruded along x
    mb.prism_yz('BTI_Floor_Corr', 'BTI_Violet', x0 - 0.5, x1 + 0.5, [(y0, BF - SLAB), (ry, ZA - SLAB), (y1 + 0.5, ZA - SLAB), (y1 + 0.5, ZA), (ry, ZA), (y0, BF)])
    # deck-plate top: ramp and flat quads
    mb.quad('BTI_Floor_Corr_Top', 'BTI_Floor', (x0, y0, BF + .01), (x1, y0, BF + .01), (x1, ry, ZA + .01), (x0, ry, ZA + .01), uv=(2, 5))
    mb.quad('BTI_Floor_Corr_Top', 'BTI_Floor', (x0, ry, ZA + .01), (x1, ry, ZA + .01), (x1, y1, ZA + .01), (x0, y1, ZA + .01), uv=(2, 26))
    # ceiling
    mb.box('BTI_Floor_Corr_ceiling', 'BTI_Violet', x0 - 0.5, x1 + 0.5, y0, y1 + 0.5, BC, BCS)
    mb.quad('BTI_Ceiling_Corr', 'BTI_Grille', (x0, y1, BC - .02), (x1, y1, BC - .02), (x1, y0, BC - .02), (x0, y0, BC - .02), uv=(2, 26))
    # walls: west (doorway to the stair hall at EAST_DOOR), east, south cap
    da, db = EAST_DOOR
    zlo = BF
    def wall_poly(x_a, x_b, ya, yb):     # a wall face-strip following the floor ramp: prism in y-z, extruded in x
        pts = []
        def fl(y): return BF + (ZA - BF) * min(1, max(0, (y - y0) / (ry - y0)))
        yy = [ya]
        if ya < ry < yb: yy.append(ry)
        yy.append(yb)
        bot = [(y, fl(y)) for y in yy]; top = [(y, BC) for y in reversed(yy)]
        mb.prism_yz(nm, 'BTI_Violet', x_a, x_b, bot + top)
    wall_poly(x0 - 0.5, x0, y0, da); wall_poly(x0 - 0.5, x0, db, y1)
    mb.box(nm, 'BTI_Violet', x0 - 0.5, x0, da, db, ZA + 5.7, BC)
    wall_poly(x1, x1 + 0.5, y0, y1)
    mb.box(nm, 'BTI_Violet', x0 - 0.5, x1 + 0.5, y1, y1 + 0.5, ZA, BC)
    for yy_ in (da, db):
        mb.box(nm, 'BTI_VioletLight', x0 - 0.7, x0 + 0.2, yy_ - .25, yy_ + .25, ZA, ZA + 5.8)
    mb.box(nm, 'BTI_VioletLight', x0 - 0.7, x0 + 0.2, da, db, ZA + 5.55, ZA + 5.95)
    # ribs, neon, wall stripe
    def fl2(y): return BF + (ZA - BF) * min(1, max(0, (y - y0) / (ry - y0)))
    for yy_ in range(40, 112, 8):
        z0_ = fl2(yy_)
        rib(nm + '_Rib', yy_, x0, x1, z0_, BC, ch=1.2, t=0.5, depth=0.7)
    mb.box('BTI_NeonLine_Corr', 'BTI_Neon', (x0 + x1) / 2 - .17, (x0 + x1) / 2 + .17, y0 + 1, y1 - 1, BC - .06, BC + .02)
    for xx in (x0 + 0.06, x1 - 0.06):
        segs = [(y0, y1 - .2)] if xx > x0 + 1 else [(y0, da - 0.4), (db + 0.4, y1 - .2)]      # the west strip stops short of the hall doorway
        for (sa, sb) in segs:
            ya_ = [sa] + ([ry] if sa < ry < sb else []) + [sb]
            lo = [(yy, BF + (ZA - BF) * min(1, max(0, (yy - y0) / (ry - y0))) + .95) for yy in ya_]
            hi = [(yy, z + .12) for yy, z in reversed(lo)]
            mb.prism_yz('BTI_NeonLine_Corr', 'BTI_Neon', xx - .04, xx + .04, lo + hi)
    sign_plate('BTI_Sign_CorrEnd', 'CORR', (x0 + x1) / 2, y1 - 0.0, ZA + 3.6, face=-1, w=5.0, h=1.5)
    sign_plate('BTI_Sign_CorrBay', 'BAY', (x0 + x1) / 2, y0 + 0.0, BF + 4.2, face=+1, w=4.6, h=1.3) if False else None

# ── wrap-around forecastle: surface helpers (side +1 port skin, -1 starboard skin, 2 front plate) ──
def S_pt(side, a, b, off=0.0):
    if side == 2: return (a, Yf - off, b)                         # front plate: (x, z); off<0 = inward (+y)
    return (side * (skin_x(b, a) + off), a, b)                     # flanks: (y, z)
def S_face(nm, m, side, poly, off=-0.12, inward=False):
    pts = [S_pt(side, a, b, off) for a, b in poly]
    flip = inward != (side == -1)
    mb.face(nm, m, pts[::-1] if flip else pts)
def S_rect(nm, m, side, a0, a1, b0, b1, off=-0.12, inward=True, step=1.5):
    n = max(1, int(math.ceil((a1 - a0) / step))); k = max(1, int(math.ceil((b1 - b0) / 4.0)))
    for i in range(n):
        for q in range(k):
            x0_ = a0 + (a1 - a0) * i / n; x1_ = a0 + (a1 - a0) * (i + 1) / n
            z0_ = b0 + (b1 - b0) * q / k; z1_ = b0 + (b1 - b0) * (q + 1) / k
            S_face(nm, m, side, [(x0_, z0_), (x1_, z0_), (x1_, z1_), (x0_, z1_)], off, inward)
def S_frame(nm, m, side, poly, w, off):
    n = len(poly)
    for i in range(n):
        (a0, b0), (a1, b1) = poly[i], poly[(i + 1) % n]
        da, db = a1 - a0, b1 - b0; L = math.hypot(da, db); na, nb = db / L, -da / L
        quad = [(a0, b0), (a1, b1), (a1 + na * w, b1 + nb * w), (a0 + na * w, b0 + nb * w)]
        pts = [S_pt(side, a, b, off) for a, b in quad]
        mb.face(nm, m, pts[::-1] if side == -1 else pts)

def sk_edge(a, b, z0, z1): return min(skin_x(z, y) for z in (z0, z1) for y in (a, b))
def strips_cmd(nm, m, ya, yb, z0, z1, inset=0.15, step=1.0, ramp=None, uvs=.1):
    """floor / ceiling slab for y in [ya, yb] (ya<yb), between the starboard wall/skin and the port skin"""
    n = int(math.ceil((yb - ya) / step))
    for i in range(n):
        a = ya + (yb - ya) * i / n; b = ya + (yb - ya) * (i + 1) / n
        xr = sk_edge(a, b, z0, z1) - inset
        xl = (CMD['x0'] - 0.5) if (a + b) / 2 > WY0 else -(sk_edge(a, b, z0, z1)) + inset
        if ramp:   # sloped slab: ramp(y) -> top z
            ta, tb = ramp(a), ramp(b)
            mb.prism_yz(nm, m, xl, xr, [(a, ta - SLAB), (b, tb - SLAB), (b, tb), (a, ta)])
        else:
            mb.box(nm, m, xl, xr, a, b, z0, z1, uvs=uvs)
def ceil_cmd(nm, ya, yb, step=2.0, inset=0.35):
    n = int(math.ceil((yb - ya) / step))
    for i in range(n):
        a = ya + (yb - ya) * i / n; b = ya + (yb - ya) * (i + 1) / n
        xr = sk_edge(a, b, BC, BC) - inset
        xl = (CMD['x0']) if (a + b) / 2 > WY0 else -sk_edge(a, b, BC, BC) + inset
        mb.quad(nm, 'BTI_Grille', (xl, b, BC - .02), (xr, b, BC - .02), (xr, a, BC - .02), (xl, a, BC - .02), uv=((xr - xl) / 3, (b - a) / 3))
def cmd_floor_z(y):
    if y >= -60.0: return BF
    if y <= -67.0: return PLAT
    return BF + (PLAT - BF) * (-60.0 - y) / 7.0

def command_room():
    nm = 'BTI_Shell_Cmd'
    xs = CMD['x0']; y1 = CMD['y1']; yf = Yf + 0.2
    # floors: bay-level deck, ramp, observation platform; ceiling slab + grille
    strips_cmd('BTI_Floor_Cmd', 'BTI_Floor', -60.0, y1, BF - SLAB, BF)
    strips_cmd('BTI_Floor_Cmd', 'BTI_Floor', -67.0, -60.0, BF - SLAB, PLAT, ramp=cmd_floor_z)
    strips_cmd('BTI_Floor_Cmd', 'BTI_Floor', yf, -67.0, PLAT - SLAB, PLAT)
    lip_strips('BTI_CmdLip', 'BTI_Dark', -48.0, y1)
    strips_cmd('BTI_Floor_Cmd_ceiling', 'BTI_Violet', yf, y1, BC, BCS, inset=0.3, step=2.0)
    ceil_cmd('BTI_Ceiling_Cmd', yf, y1)
    # walls: starboard wall + the cross wall that closes the notch behind the starboard window, stern wall = the bay's bow wall
    mb.box(nm, 'BTI_Violet', xs - 0.5, xs, WY0 - 0.5, y1, BF, BC)
    xl0, xl1 = -skin_x(BF, WY0) + 0.15, -skin_x(BC, WY0) + 0.15
    mb.prism_xz(nm, 'BTI_Violet', WY0 - 0.5, WY0, [(xl0, BF), (xs - 0.5, BF), (xs - 0.5, BC), (xl1, BC)])
    # liners (the hull skin is one-sided): sills, lintels, corner posts, the solid port flank behind the window
    for side in (1, -1):
        ya = Yf + 0.0; yb = y1 if side == 1 else WY0
        S_rect(nm, 'BTI_VioletIn', side, ya, yb, BF, GZ0)
        S_rect(nm, 'BTI_VioletIn', side, ya, yb, GZ1, BC)
        S_rect(nm, 'BTI_VioletIn', side, ya, Yf + 0.6, GZ0, GZ1)
    S_rect(nm, 'BTI_VioletIn', 1, WY0, y1, GZ0, GZ1)
    xc = lambda z: skin_x(z, Yf)
    for sgn in (1, -1):    # front plate: corner posts, sill, lintel
        S_face(nm, 'BTI_VioletIn', 2, [(sgn * XF, GZ0), (sgn * xc(GZ0), GZ0), (sgn * xc(GZ1), GZ1), (sgn * XF, GZ1)] if sgn > 0 else
               [(-xc(GZ0), GZ0), (-XF, GZ0), (-XF, GZ1), (-xc(GZ1), GZ1)], inward=True)
    S_face(nm, 'BTI_VioletIn', 2, [(-xc(PLAT), PLAT), (xc(PLAT), PLAT), (xc(GZ0), GZ0), (-xc(GZ0), GZ0)], inward=True)
    S_face(nm, 'BTI_VioletIn', 2, [(-xc(GZ1), GZ1), (xc(GZ1), GZ1), (xc(BC), BC), (-xc(BC), BC)], inward=True)
    # glass: 3 panes per flank, 3 across the front, mullions between, frames + a cyan edge light
    def panes(side, a0, a1, n, b0=GZ0, b1=GZ1, gap=0.8):
        pw = ((a1 - a0) - gap * (n - 1)) / n
        for i in range(n):
            u = a0 + i * (pw + gap)
            S_face('BTI_Glass_Pane', 'BTI_Glass', side, [(u, b0), (u + pw, b0), (u + pw, b1), (u, b1)], off=0.0)
            if i < n - 1:
                for off_ in (0.08, -0.08):
                    S_face('BTI_GlassFrame', 'BTI_Dark', side, [(u + pw - .02, b0 - .3), (u + pw + gap + .02, b0 - .3), (u + pw + gap + .02, b1 + .3), (u + pw - .02, b1 + .3)], off=off_)
    panes(1, GLASS_P[0][0], WY0, 4); panes(-1, GLASS_P[0][0], WY0, 4); panes(2, -XF, XF, 5)
    for side, poly in ((1, GLASS_P), (-1, GLASS_P), (2, GLASS_F)):
        S_frame('BTI_GlassFrame', 'BTI_Dark', side, poly, 0.7, 0.08)
        S_frame('BTI_GlassFrame_Neon', 'BTI_NeonCyan', side, poly, 0.14, 0.12)
        S_frame('BTI_GlassFrame', 'BTI_Dark', side, poly, -0.4, -0.08)
    # ceiling beams + neon
    for yy in (-44.0, -52.0, -60.0, -68.0, -74.0):
        xr = skin_x(BC, yy) - 1.5; xl = (xs + 0.0) if yy > WY0 else -xr
        mb.box(nm + '_Beam', 'BTI_VioletLight', xl, xr, yy - .4, yy + .4, BC - .7, BC)
        mb.box('BTI_NeonLine_Cmd', 'BTI_NeonCyan', xl + 1.0, xr - 1.0, yy - .08, yy + .08, BC - .76, BC - .7)
    mb.box('BTI_NeonLine_Cmd', 'BTI_Neon', xs + 0.05, xs + 0.15, WY0 + .3, y1 - .3, BF + 0.95, BF + 1.07)
    mb.box('BTI_NeonLine_Cmd', 'BTI_Neon', xs + 0.05, xs + 0.15, WY0 + .3, y1 - .3, BC - 0.8, BC - .68)
    door_frame_y(nm, CMD_DOOR[0], CMD_DOOR[1], y1, 0.0, BF)
    # big conference screens on the stern wall (face the bow), nav panels on the starboard wall
    wall_screen('BTI_WallScreen_Cmd', -19.0, -8.0, y1 - 0.0, BF + 3.4, BF + 9.2, 'sector', face=-1)
    wall_screen('BTI_WallScreen_Cmd', -6.5, 4.5, y1 - 0.0, BF + 3.4, BF + 9.2, 'conf', face=-1)
    wall_screen('BTI_WallScreen_Cmd', 19.0, 30.0, y1 - 0.0, BF + 3.4, BF + 9.2, 'radar', face=-1)
    wall_screen_x('BTI_WallScreen_Cmd', xs, -46.0, -39.0, BF + 3.2, BF + 8.2, 'nav_a', face=+1)
    # conference table with a holo emitter on the centre line
    tx0, tx1, ty0, ty1 = -8.0, 22.0, -49.4, -45.6
    mb.box('BTI_ConfTable', 'BTI_Table', tx0, tx1, ty0, ty1, BF + 1.7, BF + 1.95)
    for lx in (tx0 + 1.5, (tx0 + tx1) / 2, tx1 - 1.5):
        mb.box('BTI_ConfTable', 'BTI_Dark', lx - .5, lx + .5, ty0 + .6, ty1 - .6, BF, BF + 1.7)
    mb.box('BTI_NeonLine_Cmd', 'BTI_NeonCyan', tx0 + .2, tx1 - .2, (ty0 + ty1) / 2 - .06, (ty0 + ty1) / 2 + .06, BF + 1.95, BF + 2.0)
    for cx in range(-5, 22, 5):
        chair('BTI_Seat_Cmd', cx, ty1 + 1.9, BF, face=-1)
        chair('BTI_Seat_Cmd', cx, ty0 - 1.9, BF, face=+1)
    # observation platform: command chair + console bank facing the front window
    chair('BTI_Seat_Cmd', 0.0, -70.0, PLAT, face=-1, big=True)
    # floating AR glass panels in front of the window (no solid consoles blocking the view)
    for x, t in ((-9.0, 'sector'), (0.0, 'nav_b'), (9.0, 'radar')):
        yb_, yt_ = Yf + 5.0, Yf + 6.2
        z0_, z1_ = PLAT + 1.9, PLAT + 5.1
        hw_ = 3.3
        mb.cyl('BTI_HoloPuck', 'BTI_VioletLight', x, yb_ - 0.2, PLAT, PLAT + 0.5, 0.9, 16, r1=0.6)
        mb.cyl('BTI_HoloPuck', 'BTI_NeonCyan', x, yb_ - 0.2, PLAT + 0.5, PLAT + 0.56, 0.5, 16)
        mb.box('BTI_HoloPost', 'BTI_Dark', x - .07, x + .07, yb_ - .27, yb_ - .13, PLAT + .5, z0_)
        P = [(x + hw_, yb_, z0_), (x - hw_, yb_, z0_), (x - hw_, yt_, z1_), (x + hw_, yt_, z1_)]
        mb.quad('BTI_HoloPanel_Cmd', 'BTI_GlassHolo_' + t, *P)
        mb.quad('BTI_HoloPanel_Cmd', 'BTI_GlassHolo_' + t, P[1], P[0], P[3], P[2])
    # three holo emitters with spinning galaxies
    cy_ = (ty0 + ty1) / 2
    for (ex, sz, gname) in ((7.0, 9.0, 'a'), (-2.0, 5.0, 'b'), (16.0, 5.0, 'c')):
        mb.cyl('BTI_Emitter', 'BTI_VioletLight', ex, cy_, BF + 1.95, BF + 2.35, 1.0, 16, r1=0.8)
        mb.cyl('BTI_Emitter', 'BTI_Reactor', ex, cy_, BF + 2.35, BF + 2.42, 0.62, 16)
        ring_flat('BTI_Emitter', 'BTI_NeonCyan', ex, cy_, BF + 2.45, 0.9, 1.05, seg=20)
        zc_ = BF + 2.6 + sz * 0.36 + 1.2
        pn = 'FX_Galaxy_' + gname
        mb.part(pn, origin=(ex, cy_, zc_))
        tilt = math.radians(16)
        for dz in (-0.45, 0.0, 0.45):
            pts = []
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                x = sx * sz / 2; y = sy * sz / 2
                pts.append((ex + x, cy_ + y * math.cos(tilt), zc_ + y * math.sin(tilt) + dz))
            mb.face(pn, 'BTI_Galaxy_' + gname, pts, [(0, 0), (1, 0), (1, 1), (0, 1)])
    sign_plate('BTI_Sign_Cmd', 'CMD', 14.0, y1 - 0.0, BF + 6.3, face=-1, w=5.6, h=1.45)


build_materials()
deck_nav(); deck_mess(); deck_crew(); food_store()
cargo_bay(); corridor(); command_room()
wall_switch('nav', 3.6, BULK_Y - 0.0, ZA)
wall_switch('mess', 3.6, BULK_Y - 0.0, ZB)
wall_switch('crew', 3.6, BULK_Y - 0.0, ZC)
wall_switch('store', -5.7, BULK_Y - 0.0, ZB)
wall_switch('engine', 3.6, ENG_Y - 0.0, ZC)
wall_switch('bay', 6.4, BAY['y1'], BF)
wall_switch('cmd', 8.0, CMD['y1'], BF)
# ceiling slab of deck A (just under the hull top) with the shaft hole, grille already placed by room_shell
slab_with_hole('BTI_Floor_A_ceiling', 'BTI_Violet', X0 - 0.5, X1 + 0.5, Y0 - 0.5, Y1 + 0.5, CEIL_A, DECK - 0.05, (SX0, SX1, SY0, SY1))
# stairs: top deck -> A -> B -> C
stair_level(DECK, ZA); stair_level(ZA, ZB); stair_level(ZB, ZC)
piv, wc = hatch()
interactables()

objs = mb.build()

# ───────────────────────── empties: pivots, interaction, light markers ─────────────────────────
def empty(name, loc, props=None, parent=None):
    e = bpy.data.objects.new(name, None); e.empty_display_type = 'PLAIN_AXES'; e.empty_display_size = 1.0
    e.location = loc
    bpy.context.scene.collection.objects.link(e)
    if parent:
        e.parent = parent; e.location = Vector(loc) - parent.location if parent.type != 'EMPTY' or True else loc
    for k, v in (props or {}).items(): e[k] = v
    return e

grp = bpy.data.objects.new('BTI_Interior', None); bpy.context.scene.collection.objects.link(grp)
hatch_root = empty('IX_Hatch', piv, dict(ix='hatch', prompt='Turn the wheel', radius=8.0, openAngle=1.75, hingeAxis='x', wheelTurns=2.0))
lid = objs['IX_Hatch_Lid']; lid.parent = hatch_root; lid.location = (0, 0, 0)
wheel = objs['IX_Hatch_Wheel']; wheel.parent = lid; wheel.location = Vector(wc) - Vector(piv)
btn = objs['IX_NavButton']; btn['ix'] = 'button'; btn['prompt'] = 'Press the button'; btn['action'] = 'alert'; btn['radius'] = 9.0
LIGHTS = [  # world positions of interior light markers (the game turns these into small point lights)
    ('LIGHT_Nav', (-2.0, 92.0, ZA + 5.5), '#9fb0ff', 'nav'), ('LIGHT_NavFront', (-2.0, 84.0, ZA + 5.5), '#66fff0', 'nav'),
    ('LIGHT_NavAft', (-2.0, 101.0, ZA + 5.5), '#9fb0ff', 'nav'),
    ('LIGHT_Mess', (-2.0, 94.0, ZB + 5.5), '#ffd9a0', 'mess'), ('LIGHT_MessGalley', (-2.0, 82.5, ZB + 5.5), '#ffb766', 'mess'),
    ('LIGHT_MessAft', (-2.0, 101.0, ZB + 5.5), '#ffd9a0', 'mess'),
    ('LIGHT_Store', (-8.2, 101.5, ZB + 5.5), '#bfe9ff', 'store'),
    ('LIGHT_Crew', (-2.0, 98.0, ZC + 5.5), '#b69cff', 'crew'), ('LIGHT_CrewAft', (-2.0, 103.0, ZC + 5.5), '#b69cff', 'crew'),
    ('LIGHT_Engine', (-2.0, 84.3, ZC + 3.5), '#66e0ff', 'engine'), ('LIGHT_EngineTop', (-2.0, 86.0, ZC + 5.5), '#66e0ff', 'engine'),
    ('LIGHT_Shaft', (-2.0, 115.6, ZA + 4.0), '#9fb0ff', 'hall'), ('LIGHT_ShaftLow', (-2.0, 115.6, ZB + 4.0), '#9fb0ff', 'hall'),
    ('LIGHT_Hall', (-2.0, 115.0, ZC + 5.0), '#9fb0ff', 'hall'),
    ('LIGHT_Bay1', (10.0, -17.0, BF + 8.2), '#ffd9a0', 'bay'), ('LIGHT_Bay2', (10.0, 17.0, BF + 8.2), '#ffd9a0', 'bay'), ('LIGHT_Bay3', (-10.0, 0.0, BF + 8.2), '#9fb0ff', 'bay'),
    ('LIGHT_Corr1', (12.0, 100.0, ZA + 5.2), '#9fb0ff', 'hall'), ('LIGHT_Corr2', (12.0, 70.0, ZA + 5.2), '#9fb0ff', 'hall'), ('LIGHT_Corr3', (12.0, 44.0, BF + 7.0), '#9fb0ff', 'hall'),
    ('LIGHT_Cmd1', (8.0, -47.5, BF + 8.6), '#66fff0', 'cmd'), ('LIGHT_Cmd2', (-8.0, -55.0, BF + 8.6), '#b69cff', 'cmd'), ('LIGHT_Cmd3', (14.0, -58.0, BF + 8.6), '#b69cff', 'cmd'), ('LIGHT_Cmd4', (0.0, -72.0, PLAT + 6.5), '#66fff0', 'cmd'),
]
for n, loc, col, grpn in LIGHTS:
    e = empty(n, loc, dict(light=col, group=grpn)); e.parent = grp; e.location = Vector(loc)
for g, pv in SWITCHES:
    o = objs['IX_Switch_' + g]; o['ix'] = 'switch'; o['group'] = g; o['prompt'] = 'Flip the light switch'; o['radius'] = 5.0
for gname, sp_ in (('a', 0.30), ('b', -0.45), ('c', 0.55)):
    o = objs['FX_Galaxy_' + gname]; o['spin'] = sp_
import json as _json
def _pl(y, z=-5.0, inset=0.1): return skin_x(z, y) - inset
_xl = lambda y: -_pl(y)
PLAN = [[(_xl(Yf + 0.1), Yf + 0.1), (_pl(Yf + 0.1), Yf + 0.1), (_pl(WY0), WY0), (_xl(WY0), WY0)],                      # bow trapezoid
        [(CMD['x0'] - 0.5, WY0), (_pl(WY0), WY0), (_pl(CMD['y1']), CMD['y1']), (CMD['x0'] - 0.5, CMD['y1'])],         # stern part
        [(_pl(Yf + 0.6) , Yf + 0.6), (_pl(Yf + 0.6) + 0.9, Yf + 0.6), (_pl(WY0) + 0.9, WY0), (_pl(WY0), WY0)],           # port skin sliver (window zone)
        [(_xl(Yf + 0.6) - 0.9, Yf + 0.6), (_xl(Yf + 0.6), Yf + 0.6), (_xl(WY0), WY0), (_xl(WY0) - 0.9, WY0)],            # starboard sliver
        [(-XF, Yf - 0.9), (XF, Yf - 0.9), (XF, Yf + 0.1), (-XF, Yf + 0.1)]]                                              # front sliver
LAYOUT = dict(cor_clip=dict(plan=[(COR['x0'] - 0.6, COR['y0'] - 0.6), (COR['x1'] + 0.6, COR['y0'] - 0.6), (COR['x1'] + 0.6, 52.0), (COR['x0'] - 0.6, 52.0)], z=[BF - SLAB - 0.05, BCS + 0.05]), plan=PLAN, plan_z=[GZ0 - 0.05, GZ1 + 0.05], glass_f=GLASS_F, box_clip=dict(plan=[(-30.0, -64.0), (-12.0, -64.0), (-12.0, -42.0), (-30.0, -42.0)], z=[-6.5, BC]), bf=BF, bc=BC, skin=[38.65, 0.5], bay=BAY, open=BAY_OPEN, pad=PAD, cmd=CMD, glass=GLASS_POLY, cmd_door=CMD_DOOR, bay_door=BAY_DOOR, cor=COR, east_door=EAST_DOOR, za=ZA)
open(HERE + '/layout.json', 'w').write(_json.dumps(LAYOUT))
bayroot = empty('BTI_Bay', (PAD[0], PAD[1], BF), dict(layout=_json.dumps(LAYOUT)))
bayroot.parent = grp; bayroot.location = Vector((PAD[0], PAD[1], BF))
# parent every structural mesh to the group so the export has one clean subtree
for name, ob in objs.items():
    if ob.parent is None: ob.parent = grp

# ───────────────────────── export ─────────────────────────
out = HERE + '/interior_parts.glb'
try:
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=False, export_yup=True, export_apply=False,
                              export_extras=True, export_cameras=False, export_lights=False, export_animations=False)
except TypeError as e:
    print('export args', e)
bpy.ops.wm.save_as_mainfile(filepath=HERE + '/interior_preview.blend')
print('EXPORTED', out, os.path.getsize(out))
