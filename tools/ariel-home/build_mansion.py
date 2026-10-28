"""Ariel's cliff mansion (V3 rebuild) - Blender 4.2 headless.
blender -b -P tools/ariel-home/build_mansion.py -- TEXDIR OUTDIR [--render RENDERDIR]
Z-up here (glTF exporter converts to Y-up).  +Y = ocean, -Y = inland.  Plateau top is z=0, ocean surface z=-62.
Writes ariel-home.glb (nodes Mansion_LOD0 / Mansion_LOD1, 1K webp textures embedded), ariel-home-collide.json
(top-down walkable height grid) and meta.  Everything is procedural; no external assets."""
import bpy, bmesh, sys, os, math, json, base64, random
import numpy as np
from mathutils import Vector, noise
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
TEX, OUT = argv[0], argv[1]
RENDER = argv[argv.index('--render') + 1] if '--render' in argv else None
os.makedirs(OUT, exist_ok=True)
random.seed(3141)
SEA = -62.0

# ───────────────────────── mesh builder ─────────────────────────
MATS = ['slate', 'concrete', 'wood', 'rock', 'glass', 'warm', 'pool', 'neon', 'dark', 'glow']
TILE = {'slate': 4.0, 'concrete': 4.0, 'wood': 3.0, 'rock': 14.0}

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
    def prism(s, poly, z0, z1, side, top=None, bot=None):
        """extrude CCW plan polygon [(x,y)..]"""
        n = len(poly)
        top = top or side; bot = bot or side
        for i in range(n):
            a, b = poly[i], poly[(i + 1) % n]
            s.quad((a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1), side)
        if top != 'none': s.face([(p[0], p[1], z1) for p in poly], top)
        if bot != 'none': s.face([(p[0], p[1], z0) for p in reversed(poly)], bot)
    def strip(s, A, Bp, mat):
        """quads between two equal-length 3D polylines"""
        for i in range(len(A) - 1): s.quad(A[i], A[i + 1], Bp[i + 1], Bp[i], mat)

def rotpts(pts, cx, cy, rz):
    c, sn = math.cos(rz), math.sin(rz)
    return [(cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c) for x, y in pts]

# ───────────────────────── cliff / rock mesa ─────────────────────────
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

def rock_h(x, y):
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
def facet_roof(b, L, Rg, Rt, zl, zr, mat='slate', soffit=True, th=0.5):
    """two pitched facets folded on a ridge: L/Rt eave polylines (plan), Rg ridge polyline (plan, higher)"""
    A = [(p[0], p[1], zl) for p in L]; Rd = [(p[0], p[1], zr) for p in Rg]; C = [(p[0], p[1], zl) for p in Rt]
    b.strip(A, Rd, mat); b.strip(Rd, C, mat)
    if soffit:
        A2 = [(p[0], p[1], zl - th) for p in L]; R2 = [(p[0], p[1], zr - th) for p in Rg]; C2 = [(p[0], p[1], zl - th) for p in Rt]
        b.strip(R2, A2, 'wood'); b.strip(C2, R2, 'wood')      # warm timber soffit (reverse order = faces down)
        # fascia
        for i in range(len(L) - 1):
            b.quad(A[i], A[i + 1], A2[i + 1], A2[i], 'dark'); b.quad(C[i + 1], C[i], C2[i], C2[i + 1], 'dark')
        b.quad(A[0], Rd[0], R2[0], A2[0], 'dark'); b.quad(Rd[0], C[0], C2[0], R2[0], 'dark')
        b.quad(Rd[-1], A[-1], A2[-1], R2[-1], 'dark'); b.quad(C[-1], Rd[-1], R2[-1], C2[-1], 'dark')

def glass_wall(b, p0, p1, z0, z1, fins=0.0, mullion=2.4):
    """floor-to-ceiling glazing between plan points, dark mullions, warm interior glow card behind"""
    (x0, y0), (x1, y1) = p0, p1
    L = math.hypot(x1 - x0, y1 - y0)
    b.quad((x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1), 'glass')
    b.quad((x1, y1, z0), (x0, y0, z0), (x0, y0, z1), (x1, y1, z1), 'glass')
    nx_, ny_ = (y1 - y0) / L, -(x1 - x0) / L            # outward-ish normal
    inset = 1.2
    b.quad((x1 - nx_ * inset, y1 - ny_ * inset, z0 + .05), (x0 - nx_ * inset, y0 - ny_ * inset, z0 + .05),
           (x0 - nx_ * inset, y0 - ny_ * inset, z1 - .1), (x1 - nx_ * inset, y1 - ny_ * inset, z1 - .1), 'glow')
    n = max(1, int(L / mullion))
    for i in range(n + 1):
        t = i / n; x = x0 + (x1 - x0) * t; y = y0 + (y1 - y0) * t
        b.box(x, y, z0, 0.22, 0.22, z1 - z0, 'dark', rz=math.atan2(y1 - y0, x1 - x0))
        if fins: b.box(x + nx_ * 0.4, y + ny_ * 0.4, z0, 0.12, fins, z1 - z0 + 0.6, 'slate', rz=math.atan2(y1 - y0, x1 - x0) + math.pi / 2)

def deck(b, poly, z, th, pool=None, rail=True, side='concrete'):
    b.prism(poly, z - th, z, side, top='concrete', bot='concrete')
    if pool:
        px0, py0, px1, py1, depth = pool
        # sunken infinity pool: slate lining + water that spills over the seaward edge
        b.quad((px0, py0, z + .01), (px1, py0, z + .01), (px1, py1, z + .01), (px0, py1, z + .01), 'dark')
        b.quad((px0, py0, z - depth), (px1, py0, z - depth), (px1, py1, z - depth), (px0, py1, z - depth), 'pool')
        b.quad((px0, py0, z - 0.18), (px1, py0, z - 0.18), (px1, py1, z - 0.18), (px0, py1, z - 0.18), 'pool')
        b.box((px0 + px1) / 2, py0 - .15, z - depth, px1 - px0 + .6, .3, depth + .05, 'dark')
        b.box(px0 - .15, (py0 + py1) / 2, z - depth, .3, py1 - py0, depth + .05, 'dark')
        b.box(px1 + .15, (py0 + py1) / 2, z - depth, .3, py1 - py0, depth + .05, 'dark')
        b.box((px0 + px1) / 2, py1 + .22, z - depth - .1, px1 - px0 + .9, .45, depth + .1, 'dark')   # catch trough lip
    if rail:
        n = len(poly)
        for i in range(n):
            a, c = poly[i], poly[(i + 1) % n]
            if (c[1] - a[1]) > 0.6 * abs(c[0] - a[0]) and a[1] > 5 and False: continue
        # glass balustrade on seaward edges (those whose midpoint y is largest); posts as dark slivers
        for i in range(n):
            a, c = poly[i], poly[(i + 1) % n]
            if (a[1] + c[1]) / 2 < max(p[1] for p in poly) - 20: continue
            Ln = math.hypot(c[0] - a[0], c[1] - a[1]); k = max(1, int(Ln / 5))
            b.quad((a[0], a[1], z), (c[0], c[1], z), (c[0], c[1], z + 1.15), (a[0], a[1], z + 1.15), 'glass')
            b.quad((c[0], c[1], z), (a[0], a[1], z), (a[0], a[1], z + 1.15), (c[0], c[1], z + 1.15), 'glass')
            for q in range(k + 1):
                t = q / k; b.box(a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, z, .1, .1, 1.2, 'dark')

def neon_strip(b, a, c, z, w=0.12):
    b.box((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, z, math.hypot(c[0] - a[0], c[1] - a[1]), w, w, 'warm', rz=math.atan2(c[1] - a[1], c[0] - a[0]))

def build_house(b, detail=1.0):
    # ── podium / terrace slab on the plateau (the "entry court") ──
    b.box(0, -38, -0.0, 150, 90, 0.35, 'concrete')              # court, flush with plateau
    # skyboard landing disc inland-east, glowing ring
    N = 28; r = 9.5; cx, cy = 62, -55
    disc = [(cx + r * math.cos(2 * math.pi * i / N), cy + r * math.sin(2 * math.pi * i / N)) for i in range(N)]
    b.prism(disc, 0.0, 0.5, 'dark', top='concrete', bot='none')
    ring = [(cx + (r - .6) * math.cos(2 * math.pi * i / N), cy + (r - .6) * math.sin(2 * math.pi * i / N)) for i in range(N)]
    for i in range(N):
        a, c = ring[i], ring[(i + 1) % N]; neon_strip(b, a, c, 0.5, .22)
    # ── 1. arrival wing (inland, long low gunmetal block, flat roof with upstand) ──
    b.box(-30, -62, 0.3, 70, 18, 7.2, dict(top='slate', bot='concrete', side='concrete', front='concrete'))
    b.box(-30, -62, 7.5, 74, 22, .55, dict(top='slate', bot='wood', side='dark'))
    glass_wall(b, (-62, -52.9), (2, -52.9), 0.5, 7.0, fins=0.5, mullion=3.2)
    # ── 2. main hall: long, parallel to the cliff, folded delta roof ──
    hx0, hx1, hy0, hy1 = -52, 54, -30, -2
    glass_wall(b, (hx0 + 3, hy1), (hx1 - 3, hy1), 0.3, 11.2, fins=0.9)
    b.box(hx0, (hy0 + hy1) / 2, 0.3, 2.2, hy1 - hy0, 11, 'concrete')          # end walls
    b.box(hx1, (hy0 + hy1) / 2, 0.3, 2.2, hy1 - hy0, 11, 'concrete')
    b.box((hx0 + hx1) / 2, hy0, 0.3, hx1 - hx0, 2.0, 11, 'concrete')           # rear wall
    b.box((hx0 + hx1) / 2, (hy0 + hy1) / 2, 0.3 - .05, hx1 - hx0, hy1 - hy0, .1, 'wood')   # warm floor
    # roof: ridge runs diagonally to a prow tip over the sea
    nL = [(-62, -38), (-20, -37), (14, -35), (50, -33), (66, -32)]
    nR = [(-62, 9), (-20, 10), (14, 14), (50, 20), (66, 26)]
    nG = [(-62, -14), (-20, -12), (14, -9), (50, -3), (66, 0)]
    facet_roof(b, nL, nG, nR, 11.4, 18.5)
    # blade tower: tall triangular monolith (the pointed accent)
    tri = [(-48, -44), (-38, -44), (-44, -30)]
    b.prism(tri, 0, 30, 'slate', top='slate')
    neon_strip(b, (-48, -44), (-44, -30), 29.4, .18)
    # ── 3. prow wing: arrowhead cantilevered over the cliff ──
    pr = [(-24, hy1), (24, hy1), (10, 38), (0, 56), (-10, 38)]
    b.prism(pr, -1.3, -0.1, 'concrete', top='concrete', bot='concrete')
    for i in range(len(pr) - 1):
        a, c = pr[i], pr[(i + 1) % len(pr)]
        if i == 0: continue
        glass_wall(b, a, c, -0.1, 9.0, fins=0.0 if detail < 1 else 0.7, mullion=2.6)
    # prow roof: three-facet pyramid sloping DOWN to the tip (stealth planform)
    zt = 4.2
    tip = (0, 58, zt); r0 = [(-25, hy1 - 1, 10.5), (25, hy1 - 1, 10.5)]
    corners = [(-25, -3, 10.5), (-12.5, 39, 7.2), (0, 58, zt), (12.5, 39, 7.2), (25, -3, 10.5)]
    ridge_top = (0, 20, 15.5)
    for i in range(len(corners) - 1):
        b.tri(corners[i], corners[i + 1], ridge_top, 'slate')
        c0 = corners[i]; c1 = corners[i + 1]
        b.tri((c1[0], c1[1], c1[2] - .5), (c0[0], c0[1], c0[2] - .5), (ridge_top[0], ridge_top[1], ridge_top[2] - .5), 'wood')
        b.quad(c0, c1, (c1[0], c1[1], c1[2] - .5), (c0[0], c0[1], c0[2] - .5), 'dark')
    b.tri((-25, -3, 10.5), ridge_top, (25, -3, 10.5), 'slate')
    # ── 4. upper guest wing, yawed 14 degrees, with its own folded roof ──
    yaw = math.radians(14)
    up = rotpts([(-34, -26), (30, -26), (30, -9), (-34, -9)], 0, -18, yaw)
    b.prism(up, 18.5, 19.4, 'concrete', top='concrete', bot='concrete')   # slab sits on the main roof ridge zone (reads as a floating plate)
    b.prism(rotpts([(-30, -26), (-26, -26), (-26, -9), (-30, -9)], 0, -18, yaw), 11.4, 18.5, 'concrete')
    b.prism(rotpts([(24, -26), (28, -26), (28, -9), (24, -9)], 0, -18, yaw), 11.4, 18.5, 'concrete')
    gw0 = rotpts([(-34, -9)], 0, -18, yaw)[0]; gw1 = rotpts([(30, -9)], 0, -18, yaw)[0]
    glass_wall(b, gw0, gw1, 19.4, 27.5, fins=0.6)
    uL = rotpts([(-40, -32), (-8, -31.5), (30, -31), (38, -30.5)], 0, -18, yaw)
    uG = rotpts([(-40, -17), (-8, -16), (30, -14), (38, -13)], 0, -18, yaw)
    uR = rotpts([(-40, -3), (-8, 1), (30, 4), (38, 6)], 0, -18, yaw)
    facet_roof(b, uL, uG, uR, 27.8, 33.5)
    # upper cantilevered pointed deck + infinity pool
    udk = rotpts([(-30, -9), (30, -9), (22, 14), (4, 34), (-14, 14)], 0, -18, yaw)
    deck(b, udk, 19.4, 1.1, pool=None)
    # ── 5. cantilevered pointed decks off the main hall + infinity pool ──
    d1 = [(-46, hy1), (46, hy1), (58, 20), (30, 40), (0, 52), (-30, 40), (-58, 20)]
    # main deck: lies in front of the glass wall, east pointing slab (the prow sits over it)
    ldk = [(24, hy1), (56, hy1), (74, 22), (62, 40), (46, 50), (30, 28)]
    deck(b, ldk, 0.0, 1.5, pool=(36, 6, 62, 24, 1.6))
    wdk = [(-24, hy1), (-26, 12), (-52, 30), (-76, 14), (-52, hy1)]
    deck(b, wdk, 0.0, 1.3, pool=None)
    # lower terrace stepped down the cliff, long pool
    lw = [(-40, 4), (36, 4), (50, 30), (26, 52), (-20, 56), (-52, 36)]
    deck(b, lw, -14.0, 1.4, pool=(-24, 20, 20, 36, 1.5))
    b.box(0, 3, -22, 70, 14, 8, dict(top='concrete', bot='concrete', side='concrete'))    # lower glazed wing, set into the cliff
    glass_wall(b, (-34, 10.1), (34, 10.1), -21.5, -15.4, fins=0.0, mullion=3.0)
    b.box(0, 3, -15.0, 76, 18, .6, dict(top='slate', bot='wood', side='dark'))
    # structural piers down to the rock under the cantilevers
    for (x, y) in [(-40, 30), (-14, 46), (22, 34), (40, 14), (58, 30)]:
        top = -1.5 if y < 40 else -1.3
        b.prism([(x - .9, y - .9), (x + .9, y - .9), (x + .9, y + .9), (x - .9, y + .9)], -66, top, 'concrete')
    for (x, y) in [(-44, 40), (-10, 52), (24, 46)]:
        b.prism([(x - .7, y - .7), (x + .7, y - .7), (x + .7, y + .7), (x - .7, y + .7)], -66, -14.5, 'concrete')
    # ── 6. slate retaining fins running down the cliff face + warm uplights ──
    if detail >= 1:
        for x in range(-50, 52, 12):
            yy = max(8, edge_y(x) - 2)
            b.prism([(x, yy), (x + 1.2, yy), (x + .6, yy + 6)], -50, -2, 'slate')
        for (a, c) in [((-52, hy1 - .2), (52, hy1 - .2)), ((-24, 53), (24, 53))]:
            neon_strip(b, (a[0], a[1], 0), (c[0], c[1], 0), 11.0, .14)
        # long warm light line along the eave of the main hall
        neon_strip(b, (-60, 10.6), (62, 26), 17.7, .14)
    # ── 7. roof rim lights (cool accent strips) ──
    neon_strip(b, (-25, -3), (-12.5, 39), 9.4, .12) if detail >= 1 else None

# ───────────────────────── Blender plumbing ─────────────────────────
def tex_node(nt, path, cs):
    n = nt.nodes.new('ShaderNodeTexImage'); n.image = bpy.data.images.load(path)
    n.image.colorspace_settings.name = cs; n.interpolation = 'Smart'; return n

def make_mat(name):
    m = bpy.data.materials.new('ah_' + name); m.use_nodes = True
    nt = m.node_tree; bsdf = nt.nodes['Principled BSDF']
    if name in TILE:
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
        if n[2] >= n[0] and n[2] >= n[1]: u, v = P[:, 0], P[:, 1]
        elif n[0] >= n[1]: u, v = P[:, 1], P[:, 2]
        else: u, v = P[:, 0], P[:, 2]
        for li, k in zip(p.loop_indices, range(len(idx))): uv[li] = (u[k] / tile, v[k] / tile)
    uvl.data.foreach_set('uv', uv.ravel())
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002); bm.to_mesh(me); bm.free()
    for pgn in me.polygons: pgn.use_smooth = False
    return ob

SC = 1.3
def add_house(b, detail):
    h = B(); build_house(h, detail)
    off = len(b.v)
    b.v += [(x * SC, y * SC, z * SC) for x, y, z in h.v]
    b.f += [tuple(i + off for i in f) for f in h.f]; b.m += h.m

def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = [make_mat(n) for n in MATS]
    root0 = bpy.data.objects.new('Mansion_LOD0', None); root1 = bpy.data.objects.new('Mansion_LOD1', None)
    bpy.context.collection.objects.link(root0); bpy.context.collection.objects.link(root1)
    # LOD0
    b0 = B(); H0, xs0, ys0 = build_rock(b0, 150, 100); add_house(b0, 1.0)
    o0 = make_obj('Mansion_LOD0_mesh', b0, mats); o0.parent = root0
    # LOD1: coarser rock, simplified house
    b1 = B(); build_rock(b1, 50, 34); add_house(b1, 0.0)
    o1 = make_obj('Mansion_LOD1_mesh', b1, mats); o1.parent = root1
    print('TRIS LOD0', len(b0.f), 'LOD1', len(b1.f))
    # collision grid: top-down hits on everything but glass / pool surface / neon
    solid = [i for i, m in enumerate(b0.m) if MATS[m] not in ('glass', 'pool', 'neon', 'warm')]
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
    # sun for renders / export
    bpy.ops.object.select_all(action='DESELECT')
    for o in (root0, root1, o0, o1): o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=f'{OUT}/ariel-home.glb', export_format='GLB', use_selection=True, export_image_format='WEBP',
                              export_yup=True, export_apply=True, export_materials='EXPORT', export_cameras=False, export_lights=False,
                              export_extras=False)
    print('GLB', os.path.getsize(f'{OUT}/ariel-home.glb'))
    if RENDER: do_render(root0, root1)

def do_render(root0, root1):
    sc = bpy.context.scene
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
    shots = {'front': ((40, 240, -14), (0, 10, -8)), 'threeq': ((-200, 190, 20), (0, 20, -8)), 'aerial': ((150, 150, 110), (0, 15, -10)), 'low': ((180, 150, -45), (0, 25, -10))}
    for k, (p, t) in shots.items():
        co.location = p
        d = Vector(t) - Vector(p); co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = f'{RENDER}/mansion-{k}.png'; bpy.ops.render.render(write_still=True)
main()
