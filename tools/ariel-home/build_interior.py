"""build_interior.py — Ariel's mansion interior (walkable rooms) as ONE merged mesh + a nav JSON.
Run (Blender 4.2 headless):  blender -b -P tools/ariel-home/build_interior.py -- EXTERIOR.glb ATLASDIR OUTDIR
  EXTERIOR.glb  the exterior mansion build (ariel-home.glb, LOD0 is the AO / ceiling / soffit BVH)
  ATLASDIR      interior-{color,nrm,orm}-{1k,512}.webp   (tools/ariel-home/make_interior_atlas.py)
  OUTDIR        writes ariel-home-interior.glb (1K atlas), ariel-home-interior-512.glb (512 atlas), ariel-home-interior-nav.json
Everything is authored in the mansion's Blender frame (x east, y toward the ocean, z up). Budget: < 40k tris, 3 materials, one 1K atlas."""
import bpy, sys, os, math, json, base64, time
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from interior_lib import *

EXT, ATL, OUT = sys.argv[sys.argv.index('--') + 1:][:3]
os.makedirs(OUT, exist_ok=True)
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=EXT)
def ext_bvh(excl):
    V = []; F = []
    for o in bpy.data.objects:
        if o.type != 'MESH' or 'LOD0' not in o.name: continue
        me = o.to_mesh(); Mx = o.matrix_world; n = len(V)
        V += [tuple(Mx @ v.co) for v in me.vertices]
        for p in me.polygons:
            if me.materials[p.material_index].name in excl: continue
            F.append(tuple(n + i for i in p.vertices))
    return V, F
EV, EF = ext_bvh(('ah_glass', 'ah_glow'))
EB = BVHTree.FromPolygons(EV, EF)
def up_hit(x, y, z0=0.3, lim=60):
    h = EB.ray_cast(Vector((x, y, z0)), Vector((0, 0, 1)), lim)
    return None if h[0] is None else h[0].z
def soff(x, y, z0=0.3, dflt=9.0):
    z = up_hit(x, y, z0); return dflt if z is None else z - 0.03
def horiz(cx, cy, d, z=3.0, lim=120):
    h = EB.ray_cast(Vector((cx, cy, z)), Vector(d), lim); return None if h[0] is None else (h[0].x, h[0].y)

# ── rooms: measure the real inner faces ──────────────────────────────────────────────
hx0 = horiz(0, -20, (-1, 0, 0))[0] + 0.02; hx1 = horiz(0, -20, (1, 0, 0))[0] - 0.02; hy0 = horiz(-20, -20, (0, -1, 0))[1] + 0.02   # (v3) off the court door at x 0 so the ray still meets the rear wall
HX0, HX1, HY0, HY1 = hx0, hx1, hy0, -2.75
wx0 = horiz(-30, -80, (-1, 0, 0))[0] + 0.02; wx1 = horiz(-30, -80, (1, 0, 0))[0] - 0.02; wy0 = horiz(-30, -80, (0, -1, 0))[1] + 0.02
WX0, WX1, WY0, WY1 = wx0, wx1, wy0, -69.2
print('hall', HX0, HX1, HY0, HY1, 'wing', WX0, WX1, WY0, WY1)
HF, PF, WF = 0.6, 0.1, 0.55              # hall / prow / wing interior floor tops
PROW = [(-31.0, -2.75), (31.0, -2.75), (13.2, 49.2), (0.0, 72.4), (-13.2, 49.2)]
D1 = (-57.85, -50.05); D2 = (-6.5, 6.5)     # hall front door gaps
D3 = (48.0, 56.0)                            # (v3) east deck door: hall front glass line -> pool deck
D4 = (-5.5, 5.5)                             # (v3) arrival court MAIN ENTRANCE in the hall's rear (court side) wall
DOOR_H = 6.0                                 # door head (nav units); the wall above stays
BAL = 2.0, 7.8                               # (v3) balcony door: along the prow's west glass edge from its hall-front corner (distance range, nav units)
WD = [(-65.0, -59.0), (-26.0, -10.4)]       # wing front doors (pedestrian, garage)

Me = Mesh(); nav = Nav(); EXTRA = []     # EXTRA: entrance aprons, appended AFTER every other nav patch (tests index the patch list)
PI = lambda a, b, c, d=1: (a, b, c, d)
def tint(r, g=None, b=None):
    return (r, r, r, 1) if g is None else (r, g, b, 1)
WHITE = ('s', 0); BLACK = ('s', 1); RED = ('s', 2); ORANGE = ('s', 3); YEL = ('s', 4); GREEN = ('s', 5); TEAL = ('s', 6); BLUE = ('s', 7)
PURP = ('s', 8); PINK = ('s', 9); LGREY = ('s', 10); MGREY = ('s', 11); BRASS = ('s', 12); CHROME = ('s', 13); SCREEN = ('s', 14); LWOOD = ('s', 15)
OAK, CONC, SLATE, DMETAL, PLASTER, FABC, FABW, WTILE, MOSAIC, MARBLE, WALNUT, LEATHER, HAZARD, ACOUS, DIAMOND = range(15)

def lamp(x, y, z, R=24, c=(1.0, 0.72, 0.42), k=1.0): Me.lamps.append((x, y, z, R, c, k))
def emit(x0, y0, z0, x1, y1, z1, col=(1, 0.85, 0.6, 1)): box(Me, x0, y0, z0, x1, y1, z1, WHITE, col, mat=1, skip='b')

class Fr:
    """oriented frame: local (u right, v forward) at origin (x,y), floor z; rot k*90deg CCW. local v+ is the prop's 'front'."""
    def __init__(s, x, y, z, rot=0): s.x, s.y, s.z, s.k = x, y, z, rot % 4
    def w(s, u, v):
        k = s.k; a, b = ((u, v), (-v, u), (-u, -v), (v, -u))[k]; return (s.x + a, s.y + b)
def B(fr, u0, v0, z0, u1, v1, z1, tex, tn=(1, 1, 1, 1), obs=True, mat=0, skip='', maxcell=T, uvs=1.0, zlo=None):
    """box in frame coords (heights relative to the frame floor); registers a nav obstacle when obs"""
    a = fr.w(u0, v0); b = fr.w(u1, v1)
    x0, x1 = min(a[0], b[0]), max(a[0], b[0]); y0, y1 = min(a[1], b[1]), max(a[1], b[1])
    if x1 - x0 < 1e-4 or y1 - y0 < 1e-4 or z1 - z0 < 1e-4: return
    # keep the *bottom* hidden, top/sides textured
    box(Me, x0, y0, fr.z + z0, x1, y1, fr.z + z1, tex, tn, skip=skip + 'b', mat=mat, maxcell=maxcell, uvs=uvs)
    if obs and z1 - z0 > 0.9: nav.block(x0, y0, x1, y1, fr.z + (z0 if zlo is None else zlo), fr.z + z1)
def C(fr, u, v, z0, z1, r, n, tex, tn=(1, 1, 1, 1), obs=True, mat=0, r1=None):
    x, y = fr.w(u, v); prism(Me, x, y, fr.z + z0, fr.z + z1, r, n, tex, tn, mat, r1)
    if obs and z1 - z0 > 0.9: nav.block(x - r, y - r, x + r, y + r, fr.z + z0, fr.z + z1)
def mt(v): return v * M

# ── furniture / props (units: metres * M) ───────────────────────────────────────────
def sofa(fr, w, tn=(0.55, 0.6, 0.7, 1), tex=FABC, depth=0.95):
    d = mt(depth); wm = mt(w)
    B(fr, 0, 0, 0, wm, d, mt(0.18), DMETAL, obs=False)
    B(fr, 0, 0, mt(0.18), wm, d, mt(0.42), tex, tn, obs=False)
    B(fr, 0, 0, mt(0.42), wm, mt(0.3), mt(0.95), tex, tn, obs=False)
    B(fr, 0, 0, mt(0.42), mt(0.26), d, mt(0.66), tex, tn, obs=False); B(fr, wm - mt(0.26), 0, mt(0.42), wm, d, mt(0.66), tex, tn, obs=False)
    B(fr, mt(0.28), mt(0.3), mt(0.42), wm - mt(0.28), d, mt(0.52), tex, tuple(min(1, c * 1.12) for c in tn[:3]) + (1,), obs=False)
    nav.block(*fr.w(0, 0), *fr.w(wm, d), fr.z, fr.z + mt(0.66))
def armchair(fr, tn=(0.55, 0.32, 0.2, 1), tex=LEATHER):
    sofa(fr, 1.0, tn, tex, 0.95)
def table(fr, w, d, h=0.75, top=WALNUT, tn=(1, 1, 1, 1), legs=DMETAL):
    wm, dm = mt(w), mt(d)
    B(fr, 0, 0, mt(h) - mt(0.05), wm, dm, mt(h), top, tn, obs=False, uvs=1.0)
    for (u, v) in ((0.05, 0.05), (w - 0.1, 0.05), (0.05, d - 0.1), (w - 0.1, d - 0.1)): B(fr, mt(u), mt(v), 0, mt(u + 0.05), mt(v + 0.05), mt(h) - mt(0.05), legs, obs=False)
    nav.block(*fr.w(0, 0), *fr.w(wm, dm), fr.z, fr.z + mt(h))
def chair(fr, tn=(0.3, 0.3, 0.32, 1), tex=FABC, h=0.45):
    B(fr, 0, 0, mt(h) - mt(0.05), mt(0.45), mt(0.45), mt(h), tex, tn, obs=False)
    B(fr, 0, 0, mt(h), mt(0.45), mt(0.06), mt(0.9), tex, tn, obs=False)
    for (u, v) in ((0, 0), (0.4, 0), (0, 0.4), (0.4, 0.4)): B(fr, mt(u), mt(v), 0, mt(u + 0.05), mt(v + 0.05), mt(h) - mt(0.05), DMETAL, obs=False)
    nav.block(*fr.w(0, 0), *fr.w(mt(0.45), mt(0.45)), fr.z, fr.z + mt(0.9))
def stool(fr, u, v, h=0.68):
    C(fr, u, v, 0, mt(h) - 0.05, mt(0.045), 6, DMETAL, obs=False); C(fr, u, v, mt(h) - 0.12, mt(h), mt(0.19), 8, LEATHER, (0.5, 0.35, 0.25, 1), obs=False)
    x, y = fr.w(u, v); nav.block(x - mt(0.2), y - mt(0.2), x + mt(0.2), y + mt(0.2), fr.z, fr.z + mt(h))
def rug(fr, w, d, tex=FABC, tn=(0.6, 0.65, 0.75, 1)):
    B(fr, 0, 0, 0.0, mt(w), mt(d), 0.06, tex, tn, obs=False, skip='')
def plant(fr, u, v, h=1.0, pot=BLACK):
    x, y = fr.w(u, v)
    prism(Me, x, y, fr.z, fr.z + mt(0.4), mt(0.2), 6, pot, (0.5, 0.5, 0.5, 1), r1=mt(0.25))
    for k in range(5):                                 # crossed leaf cards
        a = k * 2.399; r = mt(0.25 + 0.1 * (k % 3)); hz = mt(h) * (0.65 + 0.35 * ((k * 37) % 10) / 10)
        for s in (0, 1):
            dx, dy = math.cos(a + s * 1.57) * r, math.sin(a + s * 1.57) * r
            Me.quad(0, [(x - dx * 0.3, y - dy * 0.3, fr.z + mt(0.4)), (x + dx, y + dy, fr.z + mt(0.4) + hz * 0.5), (x + dx * 0.4, y + dy * 0.4, fr.z + mt(0.4) + hz), (x - dx * 0.3, y - dy * 0.3, fr.z + mt(0.4) + hz * 0.6)],
                    [sw_uv(5)] * 4, (0.45 + 0.1 * (k % 2), 0.8, 0.45, 1))
    nav.block(x - mt(0.25), y - mt(0.25), x + mt(0.25), y + mt(0.25), fr.z, fr.z + mt(h))
def monitor(fr, u, v, w=0.6, h=0.35, z=0.85, tilt=0.0, glow=(0.35, 0.6, 1.0, 1)):
    wm, hm = mt(w), mt(h)
    B(fr, u - mt(0.03), v - mt(0.02), mt(z) - mt(0.05), u + mt(0.03), v + mt(0.02), mt(z), DMETAL, obs=False)
    B(fr, u - wm / 2 - 0.05, v - 0.05, mt(z), u + wm / 2 + 0.05, v + 0.1, mt(z) + hm + 0.05, BLACK, obs=False, skip='')
    ff = fr.w(0, 0)
    # screen quad on the front (+v) face, emissive
    a = fr.w(u - wm / 2, v + 0.11); b = fr.w(u + wm / 2, v + 0.11)
    Me.quad(1, [(a[0], a[1], fr.z + mt(z) + 0.03), (b[0], b[1], fr.z + mt(z) + 0.03), (b[0], b[1], fr.z + mt(z) + hm), (a[0], a[1], fr.z + mt(z) + hm)], [sw_uv(14)] * 4, glow)
def lampbulb(x, y, z, r=0.35, R=26, k=1.0, c=(1.0, 0.72, 0.42)):
    emit(x - r, y - r, z - r, x + r, y + r, z + r, (1, 0.88, 0.62, 1)); lamp(x, y, z - 0.6, R, c, k)
def pendant(x, y, ztop, zbulb, k=1.0, R=24):
    box(Me, x - 0.05, y - 0.05, zbulb, x + 0.05, y + 0.05, ztop, BLACK, skip='tb'); prism(Me, x, y, zbulb - 0.2, zbulb + 0.45, 0.2, 8, BRASS, r1=0.75 if False else 0.75)
    emit(x - 0.3, y - 0.3, zbulb - 0.3, x + 0.3, y + 0.3, zbulb - 0.2); lamp(x, y, zbulb - 0.8, R, (1.0, 0.72, 0.42), k)
def bookshelf(fr, w, h, d=0.35, rows=None, seed=1):
    wm, hm, dm = mt(w), mt(h), mt(d)
    B(fr, 0, 0, 0, wm, dm, hm, WALNUT, (0.8, 0.7, 0.6, 1), obs=True)
    n = int(h / 0.38)
    import random; R = random.Random(seed)
    for i in range(n):
        z = mt(0.12 + i * 0.38)
        u = mt(0.06)
        while u < wm - mt(0.1):
            bw = mt(0.03 + R.random() * 0.03); bh = mt(0.2 + R.random() * 0.12); col = R.choice([(0.8, 0.2, 0.15), (0.2, 0.4, 0.75), (0.9, 0.8, 0.3), (0.25, 0.6, 0.4), (0.85, 0.85, 0.8), (0.55, 0.3, 0.7), (0.9, 0.5, 0.2), (0.2, 0.2, 0.25)])
            if R.random() < 0.12: u += mt(0.12); continue
            a = fr.w(u, dm + 0.02); b = fr.w(u + bw, dm + 0.02)
            Me.quad(0, [(a[0], a[1], fr.z + z), (b[0], b[1], fr.z + z), (b[0], b[1], fr.z + z + bh), (a[0], a[1], fr.z + z + bh)], [sw_uv(0)] * 4, col + (1,))
            u += bw + mt(0.01)

# ── GLASS rail helper ─────────────────────────────────────────────────────────────────
def rail(ax, ay, bx, by, z0, h=2.2, zlo=None, zhi=None, obs=True):
    L = math.hypot(bx - ax, by - ay); dx, dy = (bx - ax) / L, (by - ay) / L
    Me.quad(2, [(ax, ay, z0), (bx, by, z0), (bx, by, z0 + h), (ax, ay, z0 + h)], [(0, 0)] * 4, (0.75, 0.9, 0.95, 0.22))
    Me.quad(2, [(bx, by, z0), (ax, ay, z0), (ax, ay, z0 + h), (bx, by, z0 + h)], [(0, 0)] * 4, (0.75, 0.9, 0.95, 0.22))
    box(Me, min(ax, bx) - 0.08, min(ay, by) - 0.08, z0 + h, max(ax, bx) + 0.08, max(ay, by) + 0.08, z0 + h + 0.12, BRASS)
    if obs: nav.wall(ax, ay, bx, by, z0 - 0.2 if zlo is None else zlo, z0 + h + 0.12 if zhi is None else zhi)

# ═════════════════════════════════════════════════════════════════════════════════════════
# HALL
# ═════════════════════════════════════════════════════════════════════════════════════════
CREAM = (0.95, 0.92, 0.88, 1)
# floors
rect_floor(Me, HX0, HY0, -34.0, HY1, HF, CONC, (0.93, 0.9, 0.85, 1))            # kitchen / dining
rect_floor(Me, -34.0, HY0, 33.6, HY1, HF, OAK, (0.95, 0.9, 0.85, 1))             # living / office
rect_floor(Me, 33.6, -12.0, HX1, HY1, HF, MARBLE, (0.95, 0.95, 0.95, 1))          # pool deck apron
# walls
hall_top = lambda x, y: soff(x, y, HF + 0.2)
wall(Me, (HX0, HY0), (HX1, HY0), HF, hall_top, PLASTER, -1, CREAM, gaps=[(D4[0] - HX0, D4[1] - HX0)], gap_h=HF + DOOR_H)                  # rear (court entrance gap, lintel above)
wall(Me, (HX0, HY1), (HX0, HY0), HF, hall_top, PLASTER, -1, CREAM)                  # west
wall(Me, (HX1, HY0), (HX1, HY1), HF, hall_top, PLASTER, -1, CREAM)                  # east
# ceiling (follows the roof underside)
fill(Me, 0, PLASTER, [(HX0, HY0), (HX1, HY0), (HX1, HY1), (HX0, HY1)], lambda x, y: soff(x, y, HF + 0.2), False, (0.88, 0.88, 0.9, 1), 3.0)
nav.rect(HX0, HY0, HX1, HY1 + 0.15, HF)
nav.wall(HX0, HY0, D4[0], HY0, 0, 40); nav.wall(D4[1], HY0, HX1, HY0, 0, 40); EXTRA.append(('r', D4[0] - 2.0, HY0 - 9.9, D4[1] + 2.0, HY0 + 0.2, 0.45))   # court apron out beyond the eave (the top-down grid reads the eave as ground there); nav.wall(HX0, HY1, HX0, HY0, 0, 40); nav.wall(HX1, HY0, HX1, HY1, 0, 40)
# front glass line: closed except D1; D2 is the opening into the prow
for (a, b) in ((HX0, D1[0]), (D1[1], D2[0]), (D2[1], D3[0]), (D3[1], HX1)): nav.wall(a, HY1 + 0.1, b, HY1 + 0.1, 0, 40)
EXTRA.append(('r', D3[0] - 2.0, HY1 - 0.3, D3[1] + 2.0, HY1 + 12.0, 0.1))   # east deck apron
# ceiling light cove: warm strip along the rear wall top
for x in range(-60, 66, 9): lampbulb(x, HY0 + 1.2, 6.5, 0.0, 22, 0.55)

# ── terrace (covered, in front of D1; the existing deck floor is at 0) ────────────────
nav.rect(-81.0, HY1 - 0.1, -29.2, 13.1, 0.0)   # to 13.1: the roof overhang edge in the exterior collision grid is ~13 (a 1.6 m strip past 11.4 used to snap her onto the roof)

# ── KITCHEN / DINING (x -66..-36) ─────────────────────────────────────────────────────
LO = 10.2   # loft floor
# loft slab (underside = kitchen ceiling), closed fascia
LX1, LY1 = -36.0, -22.0
box(Me, HX0, HY0, LO - 0.9, LX1, LY1, LO, PLASTER, (0.9, 0.9, 0.9, 1), skip='t')
box(Me, LX1, HY0, LO - 0.9, -31.0, -30.0, LO, PLASTER, (0.9, 0.9, 0.9, 1), skip='t')
rect_floor(Me, HX0, HY0, LX1, LY1, LO, OAK, (0.92, 0.88, 0.84, 1))
rect_floor(Me, LX1, HY0, -31.0, -30.0, LO, OAK, (0.92, 0.88, 0.84, 1))
nav.rect(HX0, HY0, LX1, LY1, LO); nav.rect(LX1, HY0, -31.0, -29.0, LO)
# loft ceiling already = hall ceiling; loft rails
rail(HX0 + 0.2, LY1, LX1, LY1, LO, 2.2, LO - 0.9, LO + 3.0)
rail(LX1, LY1, LX1, -30.0, LO, 2.2, LO - 0.9, LO + 3.0)
rail(-31.0, -30.0, -31.0, HY0 + 0.1, LO, 2.2, LO - 0.9, LO + 3.0)
nav.wall(HX0, HY0, -31.0, HY0, LO - 1, LO + 4)
# staircase: 18 risers up the wall of the kitchen (north), x[-35.2,-31.2]
SX0, SX1, SY0, NS, RISE, RUN = -35.2, -31.2, -9.0, 18, (LO - HF) / 18.0, 1.15
for i in range(NS):
    ytop = SY0 - i * RUN; ybot = SY0 - (i + 1) * RUN
    box(Me, SX0, ybot, HF, SX1, ytop, HF + RISE * (i + 1), WALNUT, (0.85, 0.8, 0.75, 1), skip='b', uvs=1.0)
nav.ramp(SX0, SY0 - NS * RUN, SX1, SY0, 'y', LO, HF)
for sx in (SX0 - 0.05, SX1 + 0.05):                                    # stair rails
    Me.quad(2, [(sx, SY0, HF + 0.1), (sx, SY0 - NS * RUN, LO + 0.1), (sx, SY0 - NS * RUN, LO + 2.4), (sx, SY0, HF + 2.4)], [(0, 0)] * 4, (0.75, 0.9, 0.95, 0.22))
    Me.quad(2, [(sx, SY0 - NS * RUN, HF + 0.1 + (LO - HF)), (sx, SY0, HF + 0.1), (sx, SY0, HF + 2.4), (sx, SY0 - NS * RUN, LO + 2.4)], [(0, 0)] * 4, (0.75, 0.9, 0.95, 0.22))
    nav.wall(sx, SY0 + 0.4, sx, SY0 - NS * RUN, 0, LO + 4)
nav.wall(SX0 - 0.05, SY0 + 0.4, SX1 + 0.05, SY0 + 0.4, 0, 0.0)          # (no front cap: open bottom)
# kitchen run along the rear wall (under the loft)
fk = Fr(0, 0, HF)
cab = (0.82, 0.78, 0.72, 1)
B(fk, -64.4, -37.6, 0, -40.0, -36.3, mt(0.9), WALNUT, (0.9, 0.85, 0.8, 1)); B(fk, -64.4, -37.6, mt(0.9), -40.0, -36.2, mt(0.9) + 0.12, MARBLE, obs=False)
B(fk, -66.0, -37.6, 0, -64.4, -35.8, mt(2.1), CHROME, (0.85, 0.85, 0.88, 1))                      # fridge
B(fk, -57.5, -37.6, mt(0.9), -52.5, -36.4, mt(0.9) + 0.05, BLACK, obs=False)                       # cooktop
B(fk, -58.0, -37.6, 6.0, -52.0, -36.6, 7.4, CHROME, (0.8, 0.8, 0.85, 1), obs=False)                # hood
B(fk, -50.0, -37.6, 5.0, -42.0, -36.8, 7.4, WALNUT, (0.9, 0.85, 0.8, 1), obs=False)                # uppers
B(fk, -64.0, -37.6, 5.0, -60.0, -36.8, 7.4, WALNUT, (0.9, 0.85, 0.8, 1), obs=False)
for x in (-63, -56, -48, -43): emit(x - 1.5, -36.3, 4.85, x + 1.5, -36.2, 4.95, (1, 0.85, 0.6, 1))   # under-cabinet LEDs
lamp(-52, -34, 4.6, 14, (1, 0.75, 0.5), 0.7)
# island + stools + pendants
B(fk, -61.0, -30.5, 0, -47.0, -27.7, mt(0.9), WALNUT, (0.55, 0.5, 0.46, 1)); B(fk, -61.3, -30.8, mt(0.9), -46.7, -27.4, mt(0.9) + 0.14, MARBLE, obs=False)
for i, x in enumerate((-58.5, -54.0, -49.5)): stool(fk, x, -26.7); pendant(x, -29.1, 9.4 - 0.001, 6.6, 0.8, 18)
# dining
rug(Fr(-57.0, -23.5, HF), 4.2, 3.2 if False else 3.2, FABW, (0.55, 0.4, 0.3, 1))
rug(Fr(-58.0, -22.0, HF), 4.4, 3.4, FABW, (0.55, 0.42, 0.34, 1))
table(Fr(-55.5, -20.5, HF), 2.6, 1.0, 0.75, WALNUT, (0.8, 0.7, 0.62, 1))
for i in range(3):
    chair(Fr(-54.5 + i * 3.6, -23.6, HF, 0)); chair(Fr(-54.0 + i * 3.6, -13.8, HF, 2))
pendant(-51.0, -17.8, 9.4, 6.4, 1.0, 22); pendant(-46.5, -17.8, 9.4, 6.4, 1.0, 22)
plant(Fr(-64.5, -10.0, HF), 0, 0, 2.2); plant(Fr(-64.5, -3.8, HF), 0, 0, 1.6)
B(Fr(0, 0, HF), -65.9, -26.0, 0, -64.8, -20.0, mt(0.8), WALNUT, (0.7, 0.6, 0.5, 1))                    # sideboard

# ── LOFT: bedroom ──────────────────────────────────────────────────────────────────────
fl = Fr(0, 0, LO)
rug(Fr(-64.0, -35.0, LO), 5.5, 4.0, FABW, (0.7, 0.5, 0.4, 1))
# bed: head to the west wall
B(fl, -66.0, -33.0, 0, -65.3, -26.6, mt(1.2), WALNUT, (0.6, 0.5, 0.45, 1))                           # headboard
B(fl, -65.3, -32.6, 0, -57.8, -27.0, mt(0.4), WALNUT, (0.4, 0.35, 0.3, 1))                           # frame
B(fl, -65.3, -32.5, mt(0.4), -58.0, -27.1, mt(0.62), FABW, (0.9, 0.88, 0.85, 1), obs=False)           # mattress
B(fl, -61.6, -32.5, mt(0.62), -58.0, -27.1, mt(0.68), FABW, (0.35, 0.45, 0.55, 1), obs=False)         # duvet
B(fl, -65.2, -32.0, mt(0.62), -63.9, -30.2, mt(0.78), FABW, (0.95, 0.95, 0.95, 1), obs=False)         # pillows
B(fl, -65.2, -29.4, mt(0.62), -63.9, -27.6, mt(0.78), FABW, (0.95, 0.95, 0.95, 1), obs=False)
for yy in (-35.0, -24.7):
    B(fl, -65.9, yy - 0.9, 0, -64.4, yy + 0.9, mt(0.55), WALNUT, (0.65, 0.55, 0.5, 1)); lampbulb(-65.2, yy, mt(0.55) + LO + 1.2, 0.3, 16, 0.9)
B(fl, -52.0, -37.5, 0, -41.0, -36.0, 6.2, WALNUT, (0.55, 0.5, 0.46, 1))                              # wardrobe
for x in range(-52, -41, 3): box(Me, x + 1.4, -36.05, LO + 2.4, x + 1.6, -36.0, LO + 4.0, BRASS, skip='b')
armchair(Fr(-43.0, -31.5, LO, 1), (0.3, 0.45, 0.55, 1), FABC); table(Fr(-40.5, -33.0, LO), 1.4 * 0.5, 0.5, 0.55, WALNUT)
plant(fl, -37.0, -36.5, 1.5); plant(fl, -66.0 + 1.0, -22.8 - 0.1, 1.3)
lamp(-60, -30, LO + 5.5, 26, (1, 0.7, 0.45), 0.9)

# ── LIVING ──────────────────────────────────────────────────────────────────────────────
rug(Fr(-26.0, -17.0, HF), 6.0, 4.4, FABC, (0.45, 0.55, 0.7, 1))
sofa(Fr(-23.0, -16.0, HF, 0), 4.2, (0.5, 0.6, 0.75, 1))
sofa(Fr(-23.0, -9.8, HF, 3), 2.0, (0.5, 0.6, 0.75, 1))                      # chaise on the west side
B(Fr(-15.0, -13.0, HF), 0, 0, 0, mt(1.5), mt(0.85), mt(0.4), MARBLE, obs=True)
armchair(Fr(-9.0, -11.0, HF, 1), (0.6, 0.35, 0.2, 1)); armchair(Fr(-9.0, -8.0, HF, 1), (0.55, 0.32, 0.18, 1))
plant(Fr(-31.0, -6.0, HF), 0, 0, 2.6)
# rear wall unit with a fireplace and books
bookshelf(Fr(-31.0, -37.5, HF, 0), 3.5, 3.6, 0.35, seed=3); bookshelf(Fr(-22.5, -37.5, HF, 0), 3.5, 3.6, 0.35, seed=4)   # (v3) moved off the new court entrance
B(Fr(-17.0, -37.5, HF), 0, 0, 0, mt(2.4), mt(0.4), mt(1.25), CONC, (0.55, 0.55, 0.58, 1))
emit(-14.5, -37.0, HF + 0.4, -10.5, -36.8, HF + 1.5, (1, 0.5, 0.15, 1)); lamp(-12.5, -35.5, HF + 1.0, 16, (1, 0.5, 0.2), 1.0)
armchair(Fr(-21.0, -31.0, HF, 2), (0.3, 0.45, 0.55, 1)); armchair(Fr(-16.0, -31.0, HF, 2), (0.3, 0.45, 0.55, 1))
lampbulb(-24.0, -12.0, HF + 5.0, 0.35, 26, 0.8)
lampbulb(-5.0, -8.0, HF + 5.0, 0.35, 26, 0.8)

# ── OFFICE / HER DESK ────────────────────────────────────────────────────────────────────
fd = Fr(0, 0, HF)
rug(Fr(4.0, -37.0, HF), 9.0, 5.2, FABC, (0.3, 0.32, 0.38, 1))
B(fd, 6.0, -37.4, 0, 23.0, -34.2, mt(0.75), WALNUT, (0.6, 0.55, 0.5, 1), obs=False); B(fd, 6.0, -37.4, mt(0.72), 23.0, -34.2, mt(0.77), LWOOD, (0.9, 0.85, 0.8, 1))
B(fd, 20.0, -34.2, 0, 23.0, -29.0, mt(0.75), WALNUT, (0.6, 0.55, 0.5, 1), obs=False); B(fd, 20.0, -34.2, mt(0.72), 23.0, -29.0, mt(0.77), LWOOD, (0.9, 0.85, 0.8, 1))
fm = Fr(0, 0, HF + mt(0.77))
monitor(Fr(0, 0, HF + mt(0.77), 0), 10.5, -36.6, 0.7, 0.4, 0.15, 0, (0.3, 0.5, 1, 1)); monitor(Fr(0, 0, HF + mt(0.77), 0), 14.0, -36.4, 0.8, 0.45, 0.15, 0, (0.4, 0.8, 1, 1))
monitor(Fr(0, 0, HF + mt(0.77), 0), 17.5, -36.6, 0.7, 0.4, 0.15, 0, (0.9, 0.5, 1, 1))
B(Fr(0, 0, HF + mt(0.77)), 7.0, -37.0, 0, 8.4, -35.2, 2.2, DMETAL, (0.5, 0.5, 0.55, 1), obs=False); emit(7.1, -35.25, HF + mt(0.77) + 0.3, 8.3, -35.15, HF + mt(0.77) + 2.0, (0.2, 0.9, 1.0, 1))   # PC with neon
chair(Fr(13.0, -31.0, HF, 2), (0.15, 0.15, 0.18, 1), LEATHER, 0.5)
lampbulb(22.0, -36.5, HF + mt(0.77) + 1.5, 0.25, 16, 0.6)
# shelves, whiteboard, printer
bookshelf(Fr(25.0, -37.5, HF, 0), 3.0, 3.4, 0.35, seed=7)
Me.quad(0, [(6, -37.55, HF + 4.5), (18, -37.55, HF + 4.5), (18, -37.55, HF + 8.5), (6, -37.55, HF + 8.5)], [sw_uv(0)] * 4, (0.95, 0.95, 0.95, 1)) if False else None
box(Me, 6, -37.6, HF + 4.6, 18, -37.45, HF + 8.6, WHITE, (0.95, 0.95, 0.97, 1), skip='bn')
B(fd, 27.0, -36.0, 0, 30.5, -33.0, mt(0.8), DMETAL, (0.6, 0.6, 0.62, 1)); B(fd, 27.5, -35.6, mt(0.8), 30.0, -33.4, mt(1.25), WHITE, (0.9, 0.9, 0.92, 1), obs=False); emit(28.0, -33.45, HF + mt(0.95), 29.5, -33.4, HF + mt(1.2), (1, 0.55, 0.2, 1))
plant(fd, 31.5, -36.5, 1.8)

# ── POOL ROOM (east zone), raised podium + sunken tub ────────────────────────────────────
PD = 2.5; PX0, PY1 = 33.6, -12.0
TUB = (40.0, -34.0, 64.0, -20.0)
box(Me, PX0, HY0, HF, HX1, PY1, PD, CONC, (0.75, 0.75, 0.78, 1), skip='tb')   # podium block (top added around the tub)
rect_floor(Me, PX0, TUB[3], HX1, PY1, PD, MARBLE, (0.95, 0.95, 0.95, 1), 3.0)
rect_floor(Me, PX0, HY0, TUB[0], TUB[3], PD, MARBLE, (0.95, 0.95, 0.95, 1), 3.0)
rect_floor(Me, TUB[2], HY0, HX1, TUB[3], PD, MARBLE, (0.95, 0.95, 0.95, 1), 3.0)
rect_floor(Me, TUB[0], HY0, TUB[2], TUB[1], PD, MARBLE, (0.95, 0.95, 0.95, 1), 3.0)
PB = 0.65                                                                    # tub bottom
rect_floor(Me, TUB[0], TUB[1], TUB[2], TUB[3], PB, MOSAIC, (0.85, 1, 1, 1), 3.0)
wall(Me, (TUB[0], TUB[1]), (TUB[2], TUB[1]), PB, PD, MOSAIC, -1, (0.85, 1, 1, 1))    # inner faces (face into the tub)
wall(Me, (TUB[2], TUB[3]), (TUB[0], TUB[3]), PB, PD, MOSAIC, -1, (0.85, 1, 1, 1))
wall(Me, (TUB[0], TUB[3]), (TUB[0], TUB[1]), PB, PD, MOSAIC, -1, (0.85, 1, 1, 1))
wall(Me, (TUB[2], TUB[1]), (TUB[2], TUB[3]), PB, PD, MOSAIC, -1, (0.85, 1, 1, 1))
WZ = 2.15
Me.quad(2, [(TUB[0], TUB[1], WZ), (TUB[2], TUB[1], WZ), (TUB[2], TUB[3], WZ), (TUB[0], TUB[3], WZ)], [(0, 0)] * 4, (0.1, 0.65, 0.75, 0.55))
emit(TUB[0] + 0.1, TUB[1] + 0.12, 1.5, TUB[2] - 0.1, TUB[1] + 0.2, 1.62, (0.25, 0.95, 1.0, 1)); emit(TUB[0] + 0.1, TUB[3] - 0.2, 1.5, TUB[2] - 0.1, TUB[3] - 0.12, 1.62, (0.25, 0.95, 1.0, 1))
lamp((TUB[0] + TUB[2]) / 2, (TUB[1] + TUB[3]) / 2, 2.5, 26, (0.3, 0.85, 1.0), 0.8)
nav.rect(PX0 + 0.1, HY0, HX1, PY1, PD); nav.ramp(38.0, PY1, 48.0, -8.1, 'y', PD, HF)
nav.block(TUB[0] - 0.1, TUB[1] - 0.1, TUB[2] + 0.1, TUB[3] + 0.1, PD - 0.5, PD + 20)   # tub (fenced; deep end)
for (x0, y0, x1, y1) in ((PX0, PY1, 38.0, PY1), (48.0, PY1, HX1, PY1), (PX0, HY0, PX0, PY1)): nav.wall(x0, y0, x1, y1, 0, PD)
for i in range(3):                                                           # steps (visual)
    box(Me, 38.0, PY1, HF, 48.0, PY1 + 1.3 * (i + 1), HF + 0.475 * (3 - i) if False else 0.0 + HF + 0.475 * (3 - i) - 0.0, MARBLE, (0.9, 0.9, 0.9, 1), skip='bt') if False else None
for i in range(1, 4):
    box(Me, 38.0, PY1, HF, 48.0, PY1 + 1.3 * (4 - i), HF + 0.475 * i, MARBLE, (0.92, 0.92, 0.92, 1), skip='b')
# loungers, towels, plants on the deck
for x in (44.0, 52.0, 60.0):
    fr = Fr(x, -17.5, PD)
    B(fr, 0, 0, mt(0.15), mt(0.7), mt(1.9), mt(0.35), WTILE, (0.95, 0.95, 0.95, 1)); B(fr, 0, mt(1.5), mt(0.35), mt(0.7), mt(1.9), mt(0.6), WTILE, (0.95, 0.95, 0.95, 1), obs=False)
    B(fr, mt(0.05), mt(0.1), mt(0.35), mt(0.65), mt(1.4), mt(0.42), FABW, (0.3, 0.7, 0.75, 1), obs=False)
plant(Fr(0, 0, PD), 66.5, -36.3, 2.8); plant(Fr(0, 0, PD), 36.5, -36.3, 2.4); plant(Fr(0, 0, PD), 66.5, -14.0, 2.0)
lampbulb(50.0, -14.0, PD + 5.5, 0.35, 28, 0.8); lampbulb(58.0, -30.0, PD + 5.0, 0.3, 24, 0.6)

# ═════════════════════════════════════════════════════════════════════════════════════════
# PROW: music + game studio
# ═════════════════════════════════════════════════════════════════════════════════════════
prow_top = lambda x, y: soff(x, y, PF + 0.2, 8.0)
fill(Me, 0, OAK, PROW, lambda x, y: PF, True, (0.66, 0.6, 0.55, 1), 3.0)
fill(Me, 0, PLASTER, PROW, prow_top, False, (0.8, 0.82, 0.88, 1), 3.0)
nav.poly(PROW, PF)
for i in range(len(PROW)):
    a, b = PROW[i], PROW[(i + 1) % len(PROW)]
    if i == 0: continue
    if i == len(PROW) - 1:       # (v3) west glass edge: balcony door onto the west deck (gap measured from b = the hall-front corner)
        L = math.hypot(b[0] - a[0], b[1] - a[1]); P = lambda s: (b[0] + (a[0] - b[0]) * s / L, b[1] + (a[1] - b[1]) * s / L)
        p0, p1 = P(BAL[0]), P(BAL[1]); nav.wall(a[0], a[1], p1[0], p1[1], 0, 40); nav.wall(p0[0], p0[1], b[0], b[1], 0, 40)
        EXTRA.append(('r', p0[0] - 3.6, p0[1] - 1.4, p1[0] - 0.4, p1[1] + 1.6, 0.05))   # threshold apron out onto the deck
        continue
    nav.wall(a[0], a[1], b[0], b[1], 0, 40)
# lighting strips along the glass
for (x, y) in ((-24, 12), (-17, 30), (-9, 44), (24, 12), (17, 30), (9, 44)): lampbulb(x, y, 6.5, 0.0, 22, 0.55)
fp = Fr(0, 0, PF)
# ── music studio (west half) ──
rug(Fr(-21.0, 13.0, PF), 6.5, 5.0, FABC, (0.4, 0.25, 0.5, 1))
B(fp, -17.0, 22.0, 0, -4.5, 24.8, mt(0.75), BLACK, (0.5, 0.5, 0.55, 1), obs=True); B(fp, -17.0, 22.0, mt(0.72), -4.5, 24.8, mt(0.77), DMETAL, (0.5, 0.5, 0.55, 1), obs=False)
mz = Fr(0, 0, PF + mt(0.77))
monitor(Fr(0, 0, PF + mt(0.77), 2), -8.0, 23.3, 0.7, 0.4, 0.15, 0, (0.5, 0.8, 1, 1)); monitor(Fr(0, 0, PF + mt(0.77), 2), -12.0, 23.4, 0.8, 0.45, 0.15, 0, (0.7, 0.5, 1, 1)) if False else None
for (xx, col) in ((-8.0, (0.5, 0.8, 1, 1)), (-12.5, (0.8, 0.5, 1, 1))):
    a = (xx - 1.0, 24.9); b = (xx + 1.0, 24.9)
    box(Me, xx - 1.1, 24.5, PF + mt(0.77), xx + 1.1, 24.8, PF + mt(0.77) + 1.4, BLACK, skip='b')
    Me.quad(1, [(xx - 1.0, 24.49, PF + mt(0.77) + 0.15), (xx + 1.0, 24.49, PF + mt(0.77) + 0.15), (xx + 1.0, 24.49, PF + mt(0.77) + 1.3), (xx - 1.0, 24.49, PF + mt(0.77) + 1.3)], [sw_uv(14)] * 4, col)
B(Fr(0, 0, PF + mt(0.77)), -16.2, 22.4, 0, -14.4, 23.6, 0.35, DMETAL, (0.3, 0.3, 0.32, 1), obs=False)                       # mixer
for i in range(16): emit(-16.2 + i * 0.11, 22.45, PF + mt(0.77) + 0.35, -16.12 + i * 0.11, 22.8, PF + mt(0.77) + 0.4, (0.3 + 0.04 * i, 1 - 0.04 * i, 0.4, 1))
for xx in (-19.0, -2.0): B(fp, xx, 23.0, 0, xx + 1.0, 24.0, mt(1.2), DMETAL, (0.15, 0.15, 0.17, 1)); box(Me, xx + 0.1, 22.97, PF + 0.9, xx + 0.9, 23.0, PF + 1.7, BLACK, skip='b')          # monitor speakers on stands
chair(Fr(-11.0, 19.5, PF, 0), (0.12, 0.12, 0.15, 1), LEATHER, 0.5)
# keyboards / synth
B(fp, -23.0, 11.0, 0, -19.5, 14.5, mt(0.75), DMETAL, (0.25, 0.25, 0.28, 1)); B(fp, -23.0, 11.0, mt(0.75), -19.8, 13.8, mt(0.8), WHITE, obs=False)
for i in range(7): box(Me, -22.8 + i * 0.44, 11.1, PF + mt(0.8), -22.6 + i * 0.44, 12.0, PF + mt(0.84), BLACK, skip='b')
B(fp, -22.0, 14.0, mt(0.8), -20.0, 14.5, mt(1.8), DMETAL, (0.35, 0.3, 0.3, 1), obs=False)
for i in range(6): emit(-21.8 + i * 0.3, 13.98, PF + mt(1.0), -21.6 + i * 0.3, 14.0, PF + mt(1.0) + 0.25, (1, 0.4 + 0.1 * i, 0.2, 1))
# drum kit
for (u, v, r, h) in ((-11.0, 33.0, 0.7, 0.45), (-9.2, 34.2, 0.55, 0.9), (-13.0, 34.2, 0.55, 0.9), (-14.2, 31.5, 0.8, 0.55), (-7.8, 31.5, 0.5, 0.5)):
    C(fp, u, v, mt(h) - 0.1, mt(h) + 0.1 if False else mt(h), r, 8, BRASS if r < 0.6 and h > 0.8 else WHITE, (1, 1, 1, 1), obs=False)
    C(fp, u, v, 0.4, mt(h) - 0.1, 0.05, 4, CHROME, obs=False)
C(fp, -11.0, 32.0, 0.0, mt(0.7), 1.0, 10, RED, (0.8, 0.8, 0.8, 1), obs=True)
stool(fp, -11.0, 28.5, 0.5)
# guitars on stands + amp
for i in range(3):
    u = -23.5 + i * 1.6
    B(fp, u, 4.0, 0, u + 0.15, 4.15, mt(0.9), DMETAL, obs=False); prism(Me, *fp.w(u + 0.3, 4.1), PF + mt(0.25), PF + mt(0.65), mt(0.18), 6, [RED, BLUE, YEL][i], (1, 1, 1, 1), r1=mt(0.16)); B(fp, u + 0.25, 4.05, mt(0.65), u + 0.35, 4.15, mt(1.1), WALNUT, (0.5, 0.35, 0.25, 1), obs=False)
B(fp, -19.5, 6.0, 0, -17.0, 7.2, mt(0.7), BLACK, (0.3, 0.3, 0.32, 1)); box(Me, -19.3, 7.2, PF + 0.4, -17.2, 7.22, PF + mt(0.55), DMETAL, skip='b')
# acoustic panels + beanbags
for (x0, y0, x1, y1) in ((-24.5, 20.0, -24.3, 27.0), (-22.0, 36.0, -16.0, 36.2), (-7.0, 40.0, -3.5, 40.2)):
    B(fp, x0, y0, 0.0, x1, y1, 7.0 if (x1 - x0) < 1 else 6.0, ACOUS, (0.9, 0.9, 1, 1)) if False else B(fp, x0, y0, 0.0, x1, y1, 6.0, ACOUS, (0.9, 0.9, 1, 1), uvs=2.0)
for (u, v, col) in ((-22.0, 18.0, (0.8, 0.25, 0.25, 1)), (-20.0, 20.0, (0.25, 0.5, 0.8, 1))):
    C(fp, u, v, 0, mt(0.55), mt(0.45), 7, LEATHER, col, obs=True, r1=mt(0.35))
# ── game lounge (east half) ──
rug(Fr(8.0, 22.0, PF), 12.0, 9.0, FABC, (0.2, 0.2, 0.3, 1))
B(fp, 6.0, 36.0, 0, 20.0, 37.2, mt(0.55), DMETAL, (0.25, 0.25, 0.28, 1))                          # media console
box(Me, 6.5, 36.2, PF + mt(0.55) + 0.1, 19.5, 36.6, PF + mt(0.55) + 7.2, BLACK, skip='b')
Me.quad(1, [(6.8, 36.19, PF + mt(0.55) + 0.4), (19.2, 36.19, PF + mt(0.55) + 0.4), (19.2, 36.19, PF + mt(0.55) + 6.9), (6.8, 36.19, PF + mt(0.55) + 6.9)], [sw_uv(14)] * 4, (0.45, 0.55, 0.95, 1))
lamp(13, 33, PF + 5, 22, (0.45, 0.55, 1.0), 0.9)
sofa(Fr(8.0, 24.0, PF, 0), 5.5, (0.25, 0.28, 0.4, 1), FABC, 1.0)
sofa(Fr(18.5, 24.5, PF, 1), 2.6, (0.25, 0.28, 0.4, 1), FABC, 1.0)
B(fp, 11.0, 29.0, 0, 15.0, 31.5, mt(0.42), MARBLE, (0.4, 0.4, 0.45, 1), obs=True)
for (u, v, col) in ((9.0, 27.8, (0.9, 0.4, 0.2, 1)), (16.0, 28.2, (0.2, 0.7, 0.6, 1)), (19.0, 20.0, (0.8, 0.25, 0.5, 1))): C(fp, u, v, 0, mt(0.55), mt(0.42), 7, LEATHER, col, obs=True, r1=mt(0.33))
for i, col in enumerate(((1, 0.3, 0.5, 1), (0.3, 1, 0.9, 1))):                                      # arcade cabinets on the east side
    fa = Fr(23.0, 10.0 + i * 3.3, PF, 3)
    B(fa, 0, 0, 0, mt(0.8), mt(0.9), mt(1.75), BLACK, (0.2, 0.2, 0.28, 1)); Me.quad(1, [fa.w(0.2, mt(0.9) + 0.02) + (PF + mt(1.0),), fa.w(mt(0.8) - 0.2, mt(0.9) + 0.02) + (PF + mt(1.0),), fa.w(mt(0.8) - 0.2, mt(0.9) + 0.02) + (PF + mt(1.55),), fa.w(0.2, mt(0.9) + 0.02) + (PF + mt(1.55),)], [sw_uv(14)] * 4, col)
    lamp(*fa.w(mt(0.4), mt(1.3)), PF + mt(1.2), 10, col[:3], 0.5)
B(fp, 19.0, 6.0, 0, 21.5, 8.0, mt(0.9), CHROME, (0.8, 0.8, 0.85, 1))                                  # bar fridge
emit(3.2, 4.0, PF + 0.05, 3.5, 40.0, PF + 0.12, (0.8, 0.3, 1.0, 1))                                    # aisle neon strips
emit(-3.5, 4.0, PF + 0.05, -3.2, 40.0, PF + 0.12, (0.2, 0.8, 1.0, 1))
# ── tip lounge: telescope + bench ──
C(fp, 0.0, 60.0, 0.0, mt(1.3), 0.12, 6, DMETAL, (0.4, 0.4, 0.45, 1), obs=True, r1=0.4)
prism(Me, *fp.w(0.0, 60.0)[:2], PF + mt(1.3), PF + mt(1.5), 0.18, 8, CHROME)
box(Me, -0.2, 60.0, PF + mt(1.3), 0.2, 64.0, PF + mt(1.3) + 0.4, WHITE, (0.9, 0.9, 0.95, 1), skip='b')
for xx in (-4.0, 4.0): B(fp, xx - 0.9, 55.0, 0, xx + 0.9, 57.5, mt(0.45), LEATHER, (0.5, 0.45, 0.4, 1))
lamp(0, 58, 5.0, 20, (1.0, 0.8, 0.55), 0.7)

# ═════════════════════════════════════════════════════════════════════════════════════════
# ARRIVAL WING: workshop / garage
# ═════════════════════════════════════════════════════════════════════════════════════════
wing_top = lambda x, y: soff(x, y, WF + 0.2, 9.5)
rect_floor(Me, WX0, WY0, WX1, WY1, WF, CONC, (0.55, 0.57, 0.6, 1), 3.0)
rect_floor(Me, WD[1][0] - 1.0, WY0 + 2, WD[1][1] + 1.0, WY1, WF + 0.02, HAZARD, (0.9, 0.9, 0.9, 1), 3.0) if False else None
for (x0, x1) in ((WD[1][0] - 1.4, WD[1][0] - 0.2), (WD[1][1] + 0.2, WD[1][1] + 1.4)): rect_floor(Me, x0, WY0 + 3.0, x1, WY1 - 0.3, WF + 0.02, HAZARD, (0.95, 0.95, 0.95, 1), 3.0)
rect_floor(Me, -80.0, -89.0, -66.0, -78.0, WF + 0.02, DIAMOND, (0.75, 0.75, 0.78, 1), 3.0)
wall(Me, (WX0, WY1), (WX0, WY0), WF, wing_top, CONC, -1, (0.62, 0.64, 0.68, 1))
wall(Me, (WX0, WY0), (WX1, WY0), WF, wing_top, CONC, -1, (0.62, 0.64, 0.68, 1))
wall(Me, (WX1, WY0), (WX1, WY1), WF, wing_top, CONC, -1, (0.62, 0.64, 0.68, 1))
fill(Me, 0, PLASTER, [(WX0, WY0), (WX1, WY0), (WX1, WY1), (WX0, WY1)], lambda x, y: wing_top(x, y), False, (0.75, 0.77, 0.82, 1), 3.0)
nav.rect(WX0, WY0, WX1, WY1 + 0.1, WF)
for (a, b, c, d) in ((WX0, WY0, WX1, WY0), (WX0, WY1, WX0, WY0), (WX1, WY0, WX1, WY1)): nav.wall(a, b, c, d, 0, 40)
gp = [WX0] + [v for g in WD for v in g] + [WX1]
for i in range(0, len(gp), 2): nav.wall(gp[i], WY1 + 0.1, gp[i + 1], WY1 + 0.1, 0, 40)
for g in WD: nav.rect(g[0], WY1 - 0.4, g[1], WY1 + 4.2, WF - 0.1)           # door aprons out to the court
fw = Fr(0, 0, WF)
# overhead rails + LED tubes
for y in (-86.0, -78.0, -72.5):
    box(Me, WX0, y - 0.3, 8.4, WX1, y + 0.3, 8.9, DMETAL, (0.35, 0.35, 0.38, 1), skip='b')
    emit(WX0 + 3, y - 0.12, 8.2, WX1 - 3, y + 0.12, 8.38, (0.95, 0.97, 1.0, 1))
    for x in range(-76, 4, 14): lamp(x, y, 7.2, 24, (0.85, 0.92, 1.0), 0.85)
# back wall benches
B(fw, -80.0, -90.3, 0, -34.0, -87.3, mt(0.95), DMETAL, (0.55, 0.57, 0.6, 1)); B(fw, -80.0, -90.3, mt(0.95), -34.0, -87.1, mt(0.95) + 0.12, LWOOD, (0.8, 0.7, 0.55, 1), obs=False)
box(Me, -80.0, -90.35, WF + 3.0, -34.0, -90.2, WF + 8.0, DMETAL, (0.25, 0.28, 0.3, 1), skip='bn')       # pegboard
for i, x in enumerate(range(-78, -36, 4)):
    box(Me, x, -90.2, WF + 3.6 + (i % 3) * 1.2, x + 0.3, -90.0, WF + 4.4 + (i % 3) * 1.2, [RED, YEL, BLUE, GREEN][i % 4][0] and BRASS if i % 2 else CHROME, skip='b')
for (x, kind) in ((-77.5, 'p'), (-71.0, 'p'), (-60.0, 'e'), (-50.0, 'e')):
    fb = Fr(0, 0, WF + mt(0.95) + 0.12)
    if kind == 'p':      # 3D printer: frame + glowing window
        B(fb, x, -90.0, 0, x + 4.0, -87.6, 3.4, DMETAL, (0.2, 0.2, 0.22, 1), obs=False); emit(x + 0.4, -87.62, WF + mt(0.95) + 0.6, x + 3.6, -87.58, WF + mt(0.95) + 2.6, (1, 0.6, 0.25, 1))
    else:
        monitor(Fr(0, 0, WF + mt(0.95) + 0.12), x, -88.8, 0.7, 0.4, 0.2, 0, (0.4, 1.0, 0.7, 1)); monitor(Fr(0, 0, WF + mt(0.95) + 0.12), x + 3.0, -88.8, 0.7, 0.4, 0.2, 0, (0.5, 0.7, 1.0, 1))
# machine tools (west)
B(fw, -82.0, -77.0, 0, -76.0, -71.0, mt(1.9), DMETAL, (0.25, 0.28, 0.35, 1)); emit(-76.05, -75.5, WF + 1.4, -76.0, -72.5, WF + 3.2, (0.4, 0.9, 1, 1))   # CNC mill
B(fw, -82.0, -86.0, 0, -71.0, -82.0, mt(1.0), RED, (0.8, 0.8, 0.8, 1)); B(fw, -82.0, -86.0, mt(1.0), -71.0, -82.0, mt(1.0) + 0.08, DIAMOND, obs=False)      # lathe bench
C(fw, -78.0, -84.0, mt(1.0), mt(1.0) + 3.0, 0.7, 8, DMETAL, (0.4, 0.4, 0.45, 1), obs=False)
for x in (-68.0, -64.0): B(fw, x, -90.2, 0, x + 3.0, -87.5, mt(1.2), RED, (0.9, 0.9, 0.9, 1))              # tool chests
B(fw, -64.0, -76.5, 0, -61.5, -73.0, mt(0.95), DMETAL, (0.35, 0.37, 0.4, 1)); C(fw, -62.7, -74.7, mt(0.95), mt(1.7), 0.45, 8, DMETAL, (0.4, 0.4, 0.45, 1), obs=False)  # drill press
# garage lane: skyboard service cradle
gx = (WD[1][0] + WD[1][1]) / 2
B(fw, gx - 6.0, -84.0, 0, gx - 5.0, -76.0, mt(0.5), DMETAL, (0.3, 0.3, 0.33, 1)); B(fw, gx + 5.0, -84.0, 0, gx + 6.0, -76.0, mt(0.5), DMETAL, (0.3, 0.3, 0.33, 1))
prism(Me, gx, -80.0, WF + mt(0.55), WF + mt(0.62), 5.5, 8, BLACK, (0.15, 0.15, 0.2, 1), r1=5.0) if False else None
box(Me, gx - 4.5, -85.0, WF + mt(0.55), gx + 4.5, -75.0, WF + mt(0.62), BLACK, (0.2, 0.2, 0.26, 1), skip='b')
emit(gx - 4.3, -84.8, WF + mt(0.55) - 0.05, gx + 4.3, -75.2, WF + mt(0.55), (0.3, 0.8, 1.0, 1)); lamp(gx, -80, WF + 1.5, 20, (0.3, 0.8, 1.0), 0.8)
box(Me, gx - 0.4, -87.0, WF, gx + 0.4, -86.2, WF + mt(1.3), RED, skip='b')
# east: engineering desk / drafting
B(fw, -8.0, -89.8, 0, 3.0, -86.0, mt(0.77), WALNUT, (0.55, 0.5, 0.45, 1)); B(fw, -8.0, -89.8, mt(0.74), 3.0, -86.0, mt(0.79), LWOOD, (0.9, 0.85, 0.8, 1), obs=False)
for x in (-6.0, -2.5, 1.0): monitor(Fr(0, 0, WF + mt(0.79)), x, -88.8, 0.7, 0.4, 0.15, 0, [(0.4, 0.8, 1, 1), (0.5, 1, 0.6, 1), (1, 0.7, 0.4, 1)][int(x) % 3])
chair(Fr(-3.0, -85.3, WF, 2), (0.15, 0.15, 0.18, 1), LEATHER, 0.5)
box(Me, 3.9, -86.0, WF + 3.0, 4.0, -76.0, WF + 8.0, WHITE, (0.95, 0.95, 0.97, 1), skip='e')            # whiteboard east wall
bookshelf(Fr(-0.8, -76.0, WF, 3), 3.0, 3.2, 0.35, seed=11)
for i, x in enumerate((-8.0, -5.4, -2.8)): B(fw, 1.6, -81.0 + i * 0.0, 0, 3.8, -79.0, 0.0, WHITE, obs=False) if False else None
C(fw, 2.0, -73.0, 0.0, mt(1.2), 1.0, 8, RED, (0.85, 0.85, 0.85, 1), obs=True)                             # compressor tank
B(fw, -40.0, -75.0, 0, -34.0, -72.5, mt(0.95), DMETAL, (0.55, 0.57, 0.6, 1)); B(fw, -33.0, -75.0, 0, -31.0, -72.5, mt(0.7), YEL, (0.9, 0.9, 0.9, 1))     # parts + cart
plant(Fr(-9.0, -71.0, WF), 0, 0, 1.6)

# ═════════════════════════════════════════════════════════════════════════════════════════
# lighting bake (vertex AO + lamp tint), triangle accounting, outputs
# ═════════════════════════════════════════════════════════════════════════════════════════
ntris = Me.tris()
print('INTERIOR TRIS', ntris, 'verts', sum(len(p) for p in Me.pos), 'build s', round(time.time() - t0, 1))
# BVH: exterior opaque + interior opaque (mat 0 & 1 only)
IV = []; IF = []
for m in (0, 1):
    n = len(IV); IV += Me.pos[m]; I = Me.idx[m]
    IF += [(n + I[i], n + I[i + 1], n + I[i + 2]) for i in range(0, len(I), 3)]
nE = len(EV)
AB = BVHTree.FromPolygons(EV + IV, EF + [(nE + a, nE + b, nE + c) for (a, b, c) in IF])
import random
rng = random.Random(7)
NR = 12
# fixed cosine-ish hemisphere sample directions in tangent space
dirs = []
for i in range(NR):
    u = (i + 0.5) / NR; ph = i * 2.399963; r = math.sqrt(u); dirs.append((r * math.cos(ph), r * math.sin(ph), math.sqrt(1 - u)))
def frame(n):
    nx, ny, nz = n
    a = (1, 0, 0) if abs(nx) < 0.9 else (0, 1, 0)
    tx, ty, tz = ny * a[2] - nz * a[1], nz * a[0] - nx * a[2], nx * a[1] - ny * a[0]; l = math.sqrt(tx * tx + ty * ty + tz * tz); t = (tx / l, ty / l, tz / l)
    b = (ny * t[2] - nz * t[1], nz * t[0] - nx * t[2], nx * t[1] - ny * t[0]); return t, b
ao_cols = [[], [], []]
AMB = (0.95, 0.97, 1.0)
for m in range(3):
    P = Me.pos[m]; N = Me.nrm[m]; Cc = Me.col[m]; out = ao_cols[m]
    for vi in range(len(P)):
        p = P[vi]; n = N[vi]; tn = Cc[vi]
        if m == 1:                     # unlit emissive: colour as authored
            out.append(tn); continue
        if m == 2:
            out.append(tn); continue
        # ambient occlusion
        o = (p[0] + n[0] * 0.04, p[1] + n[1] * 0.04, p[2] + n[2] * 0.04); org = Vector(o)
        t, b = frame(n); occ = 0.0; sky = 0
        for d in dirs:
            dv = Vector((t[0] * d[0] + b[0] * d[1] + n[0] * d[2], t[1] * d[0] + b[1] * d[1] + n[1] * d[2], t[2] * d[0] + b[2] * d[1] + n[2] * d[2]))
            h = AB.ray_cast(org, dv, 50.0)
            if h[0] is None: sky += 1
            else:
                dist = h[3]; occ += max(0.0, 1.0 - dist / 12.0)
        occ /= NR; sky /= NR
        f = max(0.42, 1.0 - 0.8 * occ) * (0.82 + 0.18 * sky)
        r = AMB[0] * f; g = AMB[1] * f; bl = AMB[2] * f
        for (lx, ly, lz, R, c, k) in Me.lamps:
            dx, dy, dz = lx - p[0], ly - p[1], lz - p[2]; d2 = dx * dx + dy * dy + dz * dz
            if d2 > R * R: continue
            d = math.sqrt(d2) + 1e-6; nl = (dx * n[0] + dy * n[1] + dz * n[2]) / d
            if nl <= 0: continue
            a = (1 - d / R); a = a * a * nl * k * 0.6 * (0.5 + 0.5 * f)
            r += c[0] * a; g += c[1] * a; bl += c[2] * a
        out.append((min(1.0, r * tn[0]), min(1.0, g * tn[1]), min(1.0, bl * tn[2]), 1.0))
print('AO done', round(time.time() - t0, 1))

def rd(n): return open(os.path.join(ATL, n), 'rb').read()
for tag in ('1k', '512'):
    imgs = [('interior-nrm-' + tag, rd('interior-nrm-%s.webp' % tag)), ('interior-color-' + tag, rd('interior-color-%s.webp' % tag)), ('interior-orm-' + tag, rd('interior-orm-%s.webp' % tag))]
    nb = write_glb(os.path.join(OUT, 'ariel-home-interior.glb' if tag == '1k' else 'ariel-home-interior-512.glb'), Me, imgs, ao_cols)
    print('GLB', tag, nb)

# soffit grid (2 u cells, x[-90,72) y[-96,76)) so a floor is only walkable when she is under the roof
GX0, GY0, GC = -90.0, -96.0, 2.0; GNX, GNY = 81, 86
soffg = bytearray(GNX * GNY)
for j in range(GNY):
    for i in range(GNX):
        x, y = GX0 + (i + 0.5) * GC, GY0 + (j + 0.5) * GC
        z = up_hit(x, y, 1.0, 60)
        soffg[j * GNX + i] = 255 if z is None else int(min(254, max(0, round(z * 10))))
rooms = [['r', HX0 - 1.8, HY0 - 1.8, HX1 + 1.8, HY1 + 0.25], ['r', WX0 - 1.8, WY0 - 1.8, WX1 + 1.8, WY1 + 0.25]]
cx, cy = 0.0, 22.0
rooms.append(['p', [[round(cx + (x - cx) * 1.08 + 0.0, 2), round(cy + (y - cy) * 1.06, 2)] for (x, y) in PROW[1:]] + [[round(cx + (PROW[0][0] - cx) * 1.08, 2), round(cy + (PROW[0][1] - cy) * 1.0 + 0.25, 2)]]])
rooms[2][1] = [[round(cx + (x - cx) * 1.06, 2), round(cy + (y - cy) * 1.04, 2)] for (x, y) in PROW]
rooms[2][1][0][1] = HY1 + 0.25; rooms[2][1][1][1] = HY1 + 0.25
for e in EXTRA: nav.rect(*e[1:])
nj = {'v': 1, 'frame': 'mansion blender: x east, y seaward, z up', 'floor': {'hall': HF, 'prow': PF, 'wing': WF},
      'patches': nav.patches, 'obs': nav.obs, 'seg': nav.seg, 'rooms': rooms,
      'soff': {'x0': GX0, 'y0': GY0, 'cell': GC, 'nx': GNX, 'ny': GNY, 'data': base64.b64encode(bytes(soffg)).decode()},
      'bbox': [-92.0, -96.0, 74.0, 76.0], 'tris': ntris, 'spawn': {'x': -54.0, 'y': 5.0, 'z': 0.0}}
json.dump(nj, open(os.path.join(OUT, 'ariel-home-interior-nav.json'), 'w'), separators=(',', ':'))
print('NAV', len(nav.patches), 'patches', len(nav.obs), 'obstacles', len(nav.seg), 'segments', os.path.getsize(os.path.join(OUT, 'ariel-home-interior-nav.json')), 'B; total s', round(time.time() - t0, 1))
