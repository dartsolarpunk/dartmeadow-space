# Track 5 (CE-10) / t1590: VALLES RIM ANNEX — the Mars facility expansion (Blender 4.2 headless):
#   MF_OUT=/workspace/mf-out blender -b --factory-startup -P tools/mars-facility/mf_build.py [-- --no-bake]
# A walkable hangar + habitat wing on the cliff top behind the kept Valles Rim building (mars-valles, ui/dm-facilities.js buildFacility 'mars').
# Frame while modelling: METRES, x = X (along the cliff, east), y = D (metres inland from the annex front wall), z = H (annex floor = 0).
# Export frame (the facility's local three frame, u): x_u = 1.78 X, y_u(up) = 1.78 H, z_u = -(Z0 + 1.78 D)  (Z0 = 64 u: the annex front sits 64 u inland of the deck origin).
# Output: mf-annex.glb (1K maps) / mf-annex-512.glb, mf-annex.json (colliders, floors, roofs, lights, rooms, door) for ui/dm-mars-facility.js.
import bpy, bmesh, math, os, sys, json, time
import numpy as np
from mathutils import Vector, Matrix
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ariel-home', 'undercliff'))
import uc_kit as K
T0 = time.time()
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
BAKE = '--no-bake' not in ARGS
OUT = os.environ.get('MF_OUT', '/workspace/mf-out'); os.makedirs(OUT, exist_ok=True)
U = 1.78; Z0 = 64.0
MORDER = ['mf_hull', 'mf_concrete', 'mf_floor', 'mf_steel', 'mf_dark', 'mf_paint', 'mf_glass', 'mf_emit']
K.MORDER[:] = MORDER; K.MI.clear(); K.MI.update({k: i for i, k in enumerate(MORDER)}); K.TILE = 4.0

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
def coll(name):
    c = bpy.data.collections.new(name); sc.collection.children.link(c); return c
C = coll('MF')

# ── textures (procedural, original): light dust-weathered composite panels, poured concrete, hangar floor slab ──────────────
rng = np.random.default_rng(1590)
def noise(n, oct_=5, seed=0):
    r = np.random.default_rng(seed); acc = np.zeros((n, n))
    for o in range(oct_):
        s = 2 ** (o + 2); g = r.random((s + 1, s + 1)); xs = np.linspace(0, s, n, endpoint=False); i = xs.astype(int); f = xs - i; f = f * f * (3 - 2 * f)
        a = g[np.ix_(i, i)]; b = g[np.ix_(i, i + 1)]; c = g[np.ix_(i + 1, i)]; d = g[np.ix_(i + 1, i + 1)]
        top = a + (b - a) * f[None, :]; bot = c + (d - c) * f[None, :]; acc += (top + (bot - top) * f[:, None]) / (2 ** o)
    return (acc - acc.min()) / (acc.max() - acc.min() + 1e-9)
def tex_hull(n):
    P = n // 4; y, x = np.mgrid[0:n, 0:n]; px, py = x % P, y % P; e = np.minimum(np.minimum(px, py), np.minimum(P - 1 - px, P - 1 - py))
    seam = (e < max(2, n // 256)).astype(float); bevel = ((e >= max(2, n // 256)) & (e < max(4, n // 128))).astype(float)
    tint = rng.random((4, 4))[(y // P) % 4, (x // P) % 4]; nz = noise(n, 5, 3); dust = np.clip(0.15 + 0.55 * (y / n) + (nz - 0.5) * 0.5, 0, 1)
    base = np.stack([0.70 + 0.05 * tint, 0.66 + 0.04 * tint, 0.60 + 0.03 * tint], -1)        # light warm-white composite
    dustc = np.array([0.72, 0.47, 0.32])                                                        # regolith
    col = base * (1 - 0.45 * dust[..., None]) + dustc * 0.45 * dust[..., None]
    col *= (1 - 0.35 * seam - 0.08 * bevel)[..., None]; col += (nz[..., None] - 0.5) * 0.04
    rivet = (((px - P // 2) % (P // 4) == 0) & (e == max(5, n // 100))).astype(float); col *= (1 - 0.25 * rivet)[..., None]
    return np.clip(col, 0, 1)
def tex_concrete(n):
    nz = noise(n, 6, 7); nz2 = noise(n, 3, 9); y, x = np.mgrid[0:n, 0:n]
    joint = (((x % (n // 2)) < 2) | ((y % (n // 2)) < 2)).astype(float)
    v = 0.56 + 0.10 * (nz - 0.5) + 0.06 * (nz2 - 0.5); col = np.stack([v * 1.02, v * 0.98, v * 0.93], -1); col *= (1 - 0.3 * joint)[..., None]
    return np.clip(col, 0, 1)
def tex_floor(n):   # hangar / corridor floor: sealed slab, faint tyre marks, regolith tracked in
    nz = noise(n, 6, 11); y, x = np.mgrid[0:n, 0:n]; joint = (((x % (n // 4)) < 2) | ((y % (n // 4)) < 2)).astype(float)
    v = 0.48 + 0.08 * (nz - 0.5); col = np.stack([v * 1.04, v * 0.97, v * 0.9], -1); dust = np.clip(noise(n, 4, 13) - 0.45, 0, 1) * 0.7
    col = col * (1 - dust[..., None]) + np.array([0.62, 0.40, 0.27]) * dust[..., None]; col *= (1 - 0.25 * joint)[..., None]
    return np.clip(col, 0, 1)
def image(name, arr):
    n = arr.shape[0]; img = bpy.data.images.new(name, n, n, alpha=False); px = np.ones((n, n, 4), dtype=np.float32); px[..., :3] = arr[::-1]
    img.pixels.foreach_set(px.ravel()); img.file_format = 'JPEG'; img.pack(); return img
TEXN = 1024
IMG = dict(mf_hull=image('mf_hull_a', tex_hull(TEXN)), mf_concrete=image('mf_concrete_a', tex_concrete(TEXN)), mf_floor=image('mf_floor_a', tex_floor(TEXN)))
def mat(name, rgb, rough, metal=0.0, img=None, emit=None, alpha=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if img is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img; nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if emit is not None:
        b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = 4.0
    if alpha is not None:
        b.inputs['Alpha'].default_value = alpha; m.blend_method = 'BLEND'
    return m
MATS = dict(mf_hull=mat('mf_hull', (1, 1, 1), 0.78, 0, IMG['mf_hull']), mf_concrete=mat('mf_concrete', (1, 1, 1), 0.86, 0, IMG['mf_concrete']),
            mf_floor=mat('mf_floor', (1, 1, 1), 0.7, 0, IMG['mf_floor']), mf_steel=mat('mf_steel', (0.42, 0.43, 0.45), 0.55, 0.0),
            mf_dark=mat('mf_dark', (0.12, 0.12, 0.13), 0.6, 0.0), mf_paint=mat('mf_paint', (0.85, 0.62, 0.08), 0.6, 0.0),
            mf_glass=mat('mf_glass', (0.55, 0.62, 0.66), 0.08, 0.0, alpha=0.32), mf_emit=mat('mf_emit', (1, 0.9, 0.75), 0.5, 0.0, emit=(1, 0.88, 0.7)))

# ── layout (metres) ───────────────────────────────────────────────────────────────────────────────────────
W0, W1, D1 = -28.0, 28.0, 36.0          # footprint X -28..28, D 0..36
HAB_H, HAB_T = 4.0, 5.0                  # habitat clear height / roof top
HAN_H, HAN_T = 13.0, 14.2                # hangar clear height / roof top
TW = 0.3                                 # wall thickness
DOOR = dict(x0=4.0, x1=24.0, h=10.5)     # hangar door opening (front wall, X 4..24): one leaf slides east into the pocket frame X 28..49
SPINE = (-15.5, -12.5)
APRON = 12.0                             # floor-level apron in front of the whole front (D -12..0)
SKIRT = 16.0                             # foundation skirt depth below the floor (the runtime seats the floor on the highest ground in the footprint)
EXT, INT, GLS, DOR = K.Acc('mf_ext'), K.Acc('mf_int'), K.Acc('mf_glass_panes'), K.Acc('mf_hangar_door')
COLS = []        # collider boxes, metres: (cx, cy, cz, hx, hy, hz, mat)   (cy = D, cz = H)
LIGHTS = []      # (x, D, H, reach_m, k, room)
ROOMS = {}       # name -> [x0, d0, x1, d1, clear]
def col(x0, x1, y0, y1, z0, z1, m='metal'):
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1)); z0, z1 = sorted((z0, z1))
    COLS.append(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, m))
def solid_wall(axis, c, s0, s1, z1, openings=(), inner=None, outer=None, mi='mf_concrete', mo='mf_hull', z0=0.0, glass=()):
    """a TW-thick wall centred on c: skins on both sides (inner faces +dir for 'inner' = +1/-1), reveals in openings, colliders per solid span."""
    h = TW / 2
    for sgn, acc, m in ((+1, INT if inner is not None else EXT, mi if inner is not None else mo), (-1, EXT if outer is not None else INT, mo if outer is not None else mi)):
        face = (inner if sgn == +1 else outer) if (inner is not None or outer is not None) else sgn
        if face is None: face = sgn
        cc = c + h * face
        K.wall(acc, axis, cc, s0, s1, z0, z1, face, m, openings=[(o[0], o[1], o[2]) for o in openings], cell=1.0)
    # wall top cap (visible over low walls only) + reveals + colliders
    br = sorted(set([s0, s1] + [o[0] - o[1] / 2 for o in openings] + [o[0] + o[1] / 2 for o in openings]))
    for a, b in zip(br[:-1], br[1:]):
        m_ = (a + b) / 2; op = next((o for o in openings if o[0] - o[1] / 2 - 1e-6 <= m_ <= o[0] + o[1] / 2 + 1e-6), None)
        zlo = z0 + op[2] if op else z0
        if op and len(op) > 3 and op[3] == 'win':   # window: sill wall below, glass in the opening
            sill = op[4]
            if axis == 'x': col(a, b, c - h, c + h, z0, z0 + sill); col(a, b, c - h, c + h, z0 + op[2], z1)
            else: col(c - h, c + h, a, b, z0, z0 + sill); col(c - h, c + h, a, b, z0 + op[2], z1)
            continue
        if axis == 'x': col(a, b, c - h, c + h, zlo, z1)
        else: col(c - h, c + h, a, b, zlo, z1)
    for o in openings:
        oc, ow, oh = o[0], o[1], o[2]; a, b = oc - ow / 2, oc + ow / 2
        zb = z0 + (o[4] if len(o) > 3 and o[3] == 'win' else 0.0)
        if axis == 'x':
            INT.box(a, b, c - h, c + h, z0 + oh, z0 + oh + 0.001, 'mf_steel', skip=('+z', '-x', '+x', '-y', '+y'))     # head soffit
            for sx in (a, b): INT.quad((sx, c - h, zb), (sx, c + h, zb), (sx, c + h, z0 + oh), (sx, c - h, z0 + oh), 'mf_steel') if sx == b else INT.quad((sx, c + h, zb), (sx, c - h, zb), (sx, c - h, z0 + oh), (sx, c + h, z0 + oh), 'mf_steel')
            if zb > z0: INT.quad((a, c - h, zb), (b, c - h, zb), (b, c + h, zb), (a, c + h, zb), 'mf_steel')
        else:
            INT.box(c - h, c + h, a, b, z0 + oh, z0 + oh + 0.001, 'mf_steel', skip=('+z', '-x', '+x', '-y', '+y'))
            for sy in (a, b): INT.quad((c + h, sy, zb), (c - h, sy, zb), (c - h, sy, z0 + oh), (c + h, sy, z0 + oh), 'mf_steel') if sy == b else INT.quad((c - h, sy, zb), (c + h, sy, zb), (c + h, sy, z0 + oh), (c - h, sy, z0 + oh), 'mf_steel')
            if zb > z0: INT.quad((c - h, a, zb), (c - h, b, zb), (c + h, b, zb), (c + h, a, zb), 'mf_steel')
        if len(o) > 3 and o[3] == 'win':
            if axis == 'x': GLS.box(a, b, c - 0.02, c + 0.02, zb, z0 + oh, 'mf_glass', skip=('-x', '+x', '-z', '+z'))
            else: GLS.box(c - 0.02, c + 0.02, a, b, zb, z0 + oh, 'mf_glass', skip=('-y', '+y', '-z', '+z'))

# ---- floors (interior), apron + skirt (exterior) ----
K.floor_grid(INT, W0, 0, 0, D1, 0.0, 'mf_concrete', cell=1.5)
K.floor_grid(INT, 0, W1, 0, D1, 0.0, 'mf_floor', cell=2.0)
EXT.gquad((W0 - 2, -APRON, 0), (W1 + 21, -APRON, 0), (W1 + 21, 0, 0), (W0 - 2, 0, 0), 'mf_floor', cell=3.0)     # apron (faces up)
for (a, b, c_, d) in (((W0 - 2, -APRON), (W1 + 21, -APRON), None, None),):
    pass
def skirt(x0, x1, y0, y1):   # outward-facing foundation faces from the floor down SKIRT m (concrete)
    EXT.gquad((x0, y0, -SKIRT), (x1, y0, -SKIRT), (x1, y0, 0), (x0, y0, 0), 'mf_concrete', cell=4.0)          # front (faces -y)
    EXT.gquad((x1, y1, -SKIRT), (x0, y1, -SKIRT), (x0, y1, 0), (x1, y1, 0), 'mf_concrete', cell=4.0)          # back
    EXT.gquad((x0, y1, -SKIRT), (x0, y0, -SKIRT), (x0, y0, 0), (x0, y1, 0), 'mf_concrete', cell=4.0)          # west
    EXT.gquad((x1, y0, -SKIRT), (x1, y1, -SKIRT), (x1, y1, 0), (x1, y0, 0), 'mf_concrete', cell=4.0)          # east
skirt(W0 - 2, W1 + 21, -APRON, D1 + 0.15)
EXT.gquad((W0 - 2, D1 + 0.15, 0), (W1 + 21, D1 + 0.15, 0), (W1 + 21, D1 + 0.15, 0.001), (W0 - 2, D1 + 0.15, 0.001), 'mf_concrete')
EXT.gquad((W1 + 0.15, 0, 0), (W1 + 21, 0, 0), (W1 + 21, D1 + 0.15, 0), (W1 + 0.15, D1 + 0.15, 0), 'mf_floor', cell=3.0)    # east yard (under the pocket frame)
EXT.gquad((W0 - 2, 0, 0), (W0 - 0.15, 0, 0), (W0 - 0.15, D1 + 0.15, 0), (W0 - 2, D1 + 0.15, 0), 'mf_floor', cell=3.0)       # west strip
# apron markings (paint): a lead-in line to the hangar door + the door edge
for x in (DOOR['x0'] + 1.0, DOOR['x1'] - 1.0): EXT.box(x - 0.15, x + 0.15, -APRON + 0.5, -0.4, 0.0, 0.012, 'mf_paint', skip=('-z',))
EXT.box((DOOR['x0'] + DOOR['x1']) / 2 - 0.12, (DOOR['x0'] + DOOR['x1']) / 2 + 0.12, -APRON + 0.5, -0.4, 0.0, 0.012, 'mf_paint', skip=('-z',))

# ---- outer walls ----
fw_hab = [((SPINE[0] + SPINE[1]) / 2, 2.0, 2.6),                       # spine front door (airlock)
          (-22.0, 9.0, 3.2, 'win', 0.9),                              # control room window
          (-6.5, 8.0, 3.2, 'win', 0.9)]                               # mess window
solid_wall('x', 0.0, W0, 0.0, HAB_H, fw_hab, inner=+1, outer=-1)      # habitat front (inner faces +y = inland)
solid_wall('x', 0.0, 0.0, W1, HAN_H, [((DOOR['x0'] + DOOR['x1']) / 2, DOOR['x1'] - DOOR['x0'], DOOR['h'])], inner=+1, outer=-1, mi='mf_hull')
solid_wall('x', D1, W0, 0.0, HAB_H, (), inner=-1, outer=+1)
solid_wall('x', D1, 0.0, W1, HAN_H, (), inner=-1, outer=+1, mi='mf_hull')
solid_wall('y', W0, 0.0, D1, HAB_H, [(30.0, 6.0, 2.6, 'win', 1.0)], inner=+1, outer=-1)   # west wall, med-bay window
solid_wall('y', W1, 0.0, D1, HAN_H, (), inner=-1, outer=+1, mi='mf_hull')
# party wall habitat | hangar (X 0): the workshop's vehicle door + a personnel door from the mess
solid_wall('y', 0.0, 0.0, D1, HAB_H, [(19.5, 3.4, 3.0), (6.0, 1.4, 2.4)], inner=None, outer=None)
# hangar side of the party wall above the habitat roof (hangar is taller): skin facing +x (hangar) from HAB_H to HAN_H, and the outside face (-x) above the habitat roof
K.wall(INT, 'y', 0.0 + TW / 2, 0.0, D1, HAB_H, HAN_H, +1, 'mf_hull', cell=2.0); K.wall(EXT, 'y', 0.0 - TW / 2, 0.0, D1, HAB_T, HAN_T, -1, 'mf_hull', cell=2.0)
col(-TW / 2, TW / 2, 0, D1, HAB_H, HAN_H)
# outer skins above the clear height up to the roof tops (fascia) + roofs
def fascia(x0, x1, y0, y1, za, zb):
    EXT.gquad((x0, y0, za), (x1, y0, za), (x1, y0, zb), (x0, y0, zb), 'mf_hull', cell=2.0)
    EXT.gquad((x1, y1, za), (x0, y1, za), (x0, y1, zb), (x1, y1, zb), 'mf_hull', cell=2.0)
    EXT.gquad((x0, y1, za), (x0, y0, za), (x0, y0, zb), (x0, y1, zb), 'mf_hull', cell=2.0)
    EXT.gquad((x1, y0, za), (x1, y1, za), (x1, y1, zb), (x1, y0, zb), 'mf_hull', cell=2.0)
    EXT.gquad((x0, y0, zb), (x0, y1, zb), (x1, y1, zb), (x1, y0, zb), 'mf_hull', cell=3.0)     # roof top (faces up)
h = TW / 2
fascia(W0 - h, 0.0, -h, D1 + h, HAB_H, HAB_T)
fascia(0.0, W1 + h, -h, D1 + h, HAN_H, HAN_T)
col(W0 - h, 0, -h, D1 + h, HAB_H, HAB_T); col(0, W1 + h, -h, D1 + h, HAN_H, HAN_T)
# parapet + roof kit: vents, the antenna mast, a roof hatch housing, solar strip
for (x0, x1, zt) in ((W0 - h, 0.0, HAB_T), (0.0, W1 + h, HAN_T)):
    for (a, b, c_, d) in (((x0, -h), (x1, -h + 0.25), None, None), ((x0, D1 + h - 0.25), (x1, D1 + h), None, None)):
        EXT.box(a[0], b[0], a[1], b[1], zt, zt + 0.6, 'mf_hull', skip=('-z',))
for i in range(4): EXT.box(-24 + i * 5.5, -21 + i * 5.5, 22, 25, HAB_T, HAB_T + 1.1, 'mf_steel', skip=('-z',))
EXT.box(-6, -3.5, 24, 30, HAB_T, HAB_T + 0.9, 'mf_dark', skip=('-z',))
EXT.cyl(-8.0, 31.0, HAB_T, HAB_T + 9.0, 0.18, 8, 'mf_steel', caps=(False, True)); EXT.box(-8.6, -7.4, 30.4, 31.6, HAB_T + 8.6, HAB_T + 9.4, 'mf_emit')
for i in range(5): EXT.box(3 + i * 5, 6.5 + i * 5, 6, 30, HAN_T, HAN_T + 0.35, 'mf_dark', skip=('-z',))   # solar strips on the hangar roof
# vertical pilasters on the outer walls every 6 m (relief; part of the collider boxes already)
for x in np.arange(W0 + 4, W1, 6.0):
    if DOOR['x0'] - 0.5 < x < DOOR['x1'] + 0.5: continue
    zt = HAB_T if x < 0 else HAN_T; EXT.box(x - 0.25, x + 0.25, -h - 0.3, -h, 0, zt, 'mf_steel', skip=('+y', '-z'))
    EXT.box(x - 0.25, x + 0.25, D1 + h, D1 + h + 0.3, 0, zt, 'mf_steel', skip=('-y', '-z'))
# hangar door: header band, lit sign strip, floods over the doors
EXT.box(DOOR['x0'] - 0.6, DOOR['x1'] + 0.6, -h - 0.5, -h, DOOR['h'], DOOR['h'] + 1.2, 'mf_dark', skip=('+y',))
EXT.box(DOOR['x0'], DOOR['x1'], -h - 0.52, -h - 0.5, DOOR['h'] + 0.45, DOOR['h'] + 0.65, 'mf_emit')
for (x, zf) in ((DOOR['x0'] + 2, DOOR['h'] + 1.6), (DOOR['x1'] - 2, DOOR['h'] + 1.6), ((SPINE[0] + SPINE[1]) / 2, 3.3)):
    EXT.box(x - 0.5, x + 0.5, -h - 0.6, -h, zf, zf + 0.25, 'mf_dark', skip=('+y',)); EXT.box(x - 0.4, x + 0.4, -h - 0.58, -h - 0.02, zf - 0.01, zf, 'mf_emit')
# spine door canopy + airlock frame
EXT.box(SPINE[0] - 1.0, SPINE[1] + 1.0, -2.2, -h, 3.0, 3.25, 'mf_hull'); col(SPINE[0] - 1.0, SPINE[1] + 1.0, -2.2, -h, 3.0, 3.25)
# door pocket frame (east): two posts + a top rail, the leaf rolls on a floor track
for x in (W1 + 0.6, W1 + 20.8):
    EXT.box(x - 0.3, x + 0.3, -1.6, -0.9, 0, DOOR['h'] + 1.2, 'mf_steel'); col(x - 0.3, x + 0.3, -1.6, -0.9, 0, DOOR['h'] + 1.2)
EXT.box(DOOR['x0'] - 0.6, W1 + 21.1, -1.6, -0.9, DOOR['h'] + 1.2, DOOR['h'] + 1.6, 'mf_steel')
EXT.box(DOOR['x0'] - 0.6, W1 + 21.1, -1.45, -1.05, 0, 0.05, 'mf_dark', skip=('-z',))
# the leaf (its own node, slides +x by DOOR_TRAVEL): ribbed panel 20.4 x 10.4, thickness 0.35, in front of the opening
LW = DOOR['x1'] - DOOR['x0'] + 0.4
DOR.box(DOOR['x0'] - 0.2, DOOR['x1'] + 0.2, -0.85, -0.5, 0.05, DOOR['h'] + 0.05, 'mf_hull', cell=2.0)
for i in range(1, 7): DOR.box(DOOR['x0'] - 0.2, DOOR['x1'] + 0.2, -0.9, -0.85, i * 1.5 - 0.08, i * 1.5 + 0.08, 'mf_steel', skip=('+y',))
DOR.box(DOOR['x0'] - 0.2, DOOR['x1'] + 0.2, -0.47, -0.5, 1.4, 1.6, 'mf_paint', skip=('-y',))
DOOR_TRAVEL = (W1 + 20.6) - (DOOR['x1'] + 0.2)          # parks the leaf's east edge at X 48.6

# ---- habitat rooms ----
sx0, sx1 = SPINE
ROOMS.update(airlock=[sx0, 0, sx1, 5, HAB_H], spine=[sx0, 5, sx1, D1, HAB_H], control=[W0, 0, sx0, 12, HAB_H], crew=[W0, 12, sx0, 24, HAB_H], med=[W0, 24, sx0, D1, HAB_H],
             mess=[sx1, 0, 0, 13, HAB_H], workshop=[sx1, 13, 0, 26, HAB_H], power=[sx1, 26, 0, D1, HAB_H], hangar=[0, 0, W1, D1, HAN_H])
# spine walls (west = control | crew | med doors ; east = mess | workshop | power doors); airlock inner door at D 5
solid_wall('y', sx0, 0.0, D1, HAB_H, [(2.5, 1.4, 2.4), (8.0, 1.4, 2.4), (15.0, 1.2, 2.4), (21.0, 1.2, 2.4), (30.0, 1.4, 2.4)], inner=None, outer=None)
solid_wall('y', sx1, 0.0, D1, HAB_H, [(8.0, 1.6, 2.4), (19.5, 1.6, 2.4), (31.0, 1.4, 2.4)], inner=None, outer=None)
solid_wall('x', 5.0, sx0, sx1, HAB_H, [((sx0 + sx1) / 2, 1.8, 2.5)], inner=None, outer=None)
# room partitions
solid_wall('x', 12.0, W0, sx0, HAB_H, (), inner=None, outer=None)
solid_wall('x', 24.0, W0, sx0, HAB_H, (), inner=None, outer=None)
solid_wall('x', 18.0, W0, sx0, HAB_H, (), inner=None, outer=None)            # crew: two cabins (north D 12..18, south D 18..24), each off the spine
solid_wall('x', 13.0, sx1, 0.0, HAB_H, (), inner=None, outer=None)
solid_wall('x', 26.0, sx1, 0.0, HAB_H, (), inner=None, outer=None)
# the airlock's west wall to the control room has a door at D 2.5 (above) -> make the airlock a vestibule: control door from it, outer + inner doors
# ceilings (habitat) with cove LEDs + downlights, hangar ceiling with high-bays
strips = []
for rn in ('control', 'crew', 'med', 'mess', 'workshop', 'power'):
    x0, y0, x1, y1, hc = ROOMS[rn]; ix0, ix1 = x0 + h, x1 - h; iy0, iy1 = y0 + h, y1 - h
    K.cove_ceiling(INT, INT, ix0, ix1, iy0, iy1, hc - 0.25, hc, 'mf_concrete', 'mf_dark', 'mf_emit', cell=1.5)
    nx_, ny_ = max(1, round((ix1 - ix0) / 5)), max(1, round((iy1 - iy0) / 5))
    for i in range(nx_):
        for j in range(ny_):
            x = ix0 + (i + 0.5) * (ix1 - ix0) / nx_; y = iy0 + (j + 0.5) * (iy1 - iy0) / ny_
            K.downlight(INT, x, y, hc - 0.25, 'mf_dark', 'mf_emit'); LIGHTS.append((x, y, hc - 0.4, 7.5, 1.0, rn))
for rn in ('airlock', 'spine'):
    x0, y0, x1, y1, hc = ROOMS[rn]
    INT.gquad((x0 + h, y0 + h, hc - 0.4), (x0 + h, y1 - h, hc - 0.4), (x1 - h, y1 - h, hc - 0.4), (x1 - h, y0 + h, hc - 0.4), 'mf_concrete', cell=1.5)
    for y in np.arange(y0 + 2.5, y1 - 1, 5.0):
        INT.box((x0 + x1) / 2 - 0.15, (x0 + x1) / 2 + 0.15, y - 1.0, y + 1.0, hc - 0.45, hc - 0.4, 'mf_emit', skip=('+z',)); LIGHTS.append(((x0 + x1) / 2, y, hc - 0.6, 6.0, 0.8, rn))
# hangar ceiling + structure + high-bay lights
INT.gquad((h, h, HAN_H), (h, D1 - h, HAN_H), (W1 - h, D1 - h, HAN_H), (W1 - h, h, HAN_H), 'mf_hull', cell=3.0)
for y in np.arange(4.0, D1, 6.0):
    INT.box(h, W1 - h, y - 0.25, y + 0.25, HAN_H - 1.1, HAN_H, 'mf_steel', skip=('+z',))         # roof trusses (deep beams)
for x in (7.0, 14.0, 21.0):
    for y in (7.0, 19.0, 31.0):
        INT.box(x - 1.1, x + 1.1, y - 0.3, y + 0.3, HAN_H - 1.5, HAN_H - 1.1, 'mf_dark'); INT.box(x - 1.0, x + 1.0, y - 0.25, y + 0.25, HAN_H - 1.52, HAN_H - 1.5, 'mf_emit', skip=('+z',))
        LIGHTS.append((x, y, HAN_H - 1.8, 16.0, 1.6, 'hangar'))
# gantry crane rails along the hangar side walls + a bridge
for x in (1.0, W1 - 1.0): INT.box(x - 0.3, x + 0.3, 1.0, D1 - 1.0, 9.0, 9.6, 'mf_paint')
INT.box(1.0, W1 - 1.0, 21.5, 22.5, 9.6, 10.4, 'mf_paint'); INT.box(13.4, 14.6, 21.4, 22.6, 7.4, 9.6, 'mf_dark')
# hangar floor markings: landing pad H + bay outline
cx_, cy_ = 14.0, 19.0
for (a, b, c_, d) in ((cx_ - 6, cx_ + 6, cy_ - 6, cy_ - 5.7), (cx_ - 6, cx_ + 6, cy_ + 5.7, cy_ + 6), (cx_ - 6, cx_ - 5.7, cy_ - 6, cy_ + 6), (cx_ + 5.7, cx_ + 6, cy_ - 6, cy_ + 6),
                      (cx_ - 2, cx_ - 1.4, cy_ - 3, cy_ + 3), (cx_ + 1.4, cx_ + 2, cy_ - 3, cy_ + 3), (cx_ - 1.4, cx_ + 1.4, cy_ - 0.3, cy_ + 0.3)):
    INT.box(a, b, c_, d, 0, 0.01, 'mf_paint', skip=('-z',))
# hangar props (colliders): cargo containers, fuel tanks, a parked rover, tool carts
def prop_box(x0, x1, y0, y1, z0, z1, m='mf_hull', c=True, cm='metal'):
    INT.box(x0, x1, y0, y1, z0, z1, m, skip=('-z',)) if z0 <= 0.001 else INT.box(x0, x1, y0, y1, z0, z1, m)
    if c: col(x0, x1, y0, y1, z0, z1, cm)
for i, y in enumerate((26.0, 28.6)):
    prop_box(22.0, 27.4, y, y + 2.4, 0, 2.6, 'mf_paint' if i else 'mf_steel')
prop_box(22.4, 26.8, 31.5, 33.9, 0, 2.6, 'mf_steel'); prop_box(22.6, 27.0, 26.2, 28.4, 2.6, 5.0, 'mf_hull', cm='metal')
for x in (2.2, 4.6):
    INT.cyl(x, 32.5, 0, 4.2, 1.0, 14, 'mf_hull', caps=(False, True)); col(x - 1.0, x + 1.0, 31.5, 33.5, 0, 4.2)
# rover (six-wheel, parked by the workshop door)
rx, ry = 8.0, 18.5
INT.box(rx - 1.4, rx + 1.4, ry - 2.6, ry + 2.6, 0.9, 2.3, 'mf_hull'); INT.box(rx - 1.2, rx + 1.2, ry - 2.4, ry + 0.4, 2.3, 3.0, 'mf_glass'); INT.box(rx - 1.3, rx + 1.3, ry + 0.4, ry + 2.5, 2.3, 2.6, 'mf_steel')
for wy in (ry - 1.9, ry, ry + 1.9):
    for wx in (rx - 1.55, rx + 1.55): INT.hcyl('x', wx - 0.25, wx + 0.25, 0.55, 12, 'mf_dark', wy, 0.55)
col(rx - 1.8, rx + 1.8, ry - 2.7, ry + 2.7, 0, 3.0)
for (x, y) in ((10.0, 33.0), (17.5, 33.0)):
    prop_box(x - 0.6, x + 0.6, y - 0.9, y + 0.9, 0, 1.0, 'mf_paint')
# ---- room furniture (colliders for the solid pieces) ----
# control room: a curved console bank facing the window, two operator seats, a wall display (emit)
for i in range(4):
    x = -26.0 + i * 2.6; prop_box(x, x + 2.2, 1.2, 2.2, 0, 1.0, 'mf_dark'); INT.box(x + 0.1, x + 2.1, 1.25, 1.95, 1.0, 1.04, 'mf_emit')
prop_box(-27.5, -16.5, 11.2, 11.65, 1.0, 2.6, 'mf_dark', c=False); INT.box(-27.2, -16.8, 11.15, 11.2, 1.2, 2.4, 'mf_emit')
prop_box(-23.5, -20.5, 5.5, 7.5, 0, 0.8, 'mf_steel')
# crew cabins: bunks + lockers
for (y0_, y1_) in ((12.0, 18.0), (18.0, 24.0)):
    prop_box(W0 + 0.3, W0 + 4.5, y0_ + 0.4, y0_ + 2.4, 0, 0.6, 'mf_hull'); prop_box(W0 + 0.3, W0 + 4.5, y0_ + 0.4, y0_ + 2.4, 1.7, 1.9, 'mf_hull', c=False)
    prop_box(W0 + 0.3, W0 + 2.4, y1_ - 1.0, y1_ - 0.25, 0, 2.2, 'mf_steel')
# med bay: two beds + a scanner arch + a cabinet wall
for x in (-26.2, -21.4): prop_box(x, x + 1.2, 27.0, 29.4, 0, 0.8, 'mf_hull'); INT.box(x - 0.1, x + 1.3, 27.6, 27.8, 0.8, 2.6, 'mf_steel')
prop_box(-27.7, -16.2, 35.0, 35.7, 0, 2.2, 'mf_hull')
# mess: two long tables with benches, a galley counter
for y in (4.0, 8.5):
    prop_box(-10.5, -3.5, y - 0.5, y + 0.5, 0.7, 0.78, 'mf_hull', c=False); col(-10.5, -3.5, y - 0.5, y + 0.5, 0, 0.78)
    for yy in (y - 1.1, y + 0.8): prop_box(-10.2, -3.8, yy, yy + 0.3, 0, 0.45, 'mf_steel', c=False)
    for xx in (-10.2, -3.9): INT.box(xx, xx + 0.12, y - 0.4, y + 0.4, 0, 0.7, 'mf_dark')
prop_box(-10.0, -1.5, 11.9, 12.7, 0, 0.95, 'mf_steel'); INT.box(-10.0, -1.5, 11.9, 12.7, 0.95, 1.0, 'mf_concrete')   # galley counter on the back wall
# workshop: benches along the walls, a tool wall (emit strip), a press
prop_box(-10.0, -2.0, 13.4, 14.2, 0, 0.9, 'mf_steel'); prop_box(-10.0, -2.0, 25.0, 25.7, 0, 0.9, 'mf_steel')
INT.box(-10.0, -2.0, 25.78, 25.83, 1.6, 3.2, 'mf_dark'); INT.box(-10.0, -2.0, 25.7, 25.78, 3.25, 3.3, 'mf_emit')   # tool wall over the back bench
prop_box(-6.0, -4.4, 15.5, 17.1, 0, 2.2, 'mf_dark')
# power room: reactor cabinets + a glowing core column (emit, behind a cage)
for y in (27.0, 29.2, 31.4, 33.6): prop_box(-1.4, -0.4, y, y + 1.8, 0, 2.6, 'mf_dark'); INT.box(-1.45, -1.4, y + 0.3, y + 1.5, 1.6, 1.8, 'mf_emit')
INT.cyl(-6.5, 31.0, 0, HAB_H - 0.25, 0.6, 16, 'mf_emit', caps=(False, False)); INT.cyl(-6.5, 31.0, 0, HAB_H - 0.25, 1.0, 16, 'mf_steel', caps=(False, False))
col(-7.5, -5.5, 30.0, 32.0, 0, HAB_H - 0.25); LIGHTS.append((-6.5, 31.0, 2.0, 6.0, 0.6, 'power'))
# objects
def build(acc):
    return acc.build(C, MATS)
OE, OI, OG, OD = build(EXT), build(INT), build(GLS), build(DOR)
BASE = {OE: 'mf_ext', OI: 'mf_int', OG: 'mf_glass_panes', OD: 'mf_hangar_door'}
for o, n in BASE.items(): o.name = n + '_src'; o.data.name = n + '_src'
print('TRIS ext', EXT.tris(), 'int', INT.tris(), 'glass', GLS.tris(), 'door', DOR.tris(), flush=True)

# ── bake the interior light into vertex colours (Cycles; fixtures as lights, black world) ─────────────────────────────
BL = coll('MF_bake_lights')
def lamp(t, loc, energy, size=None):
    ld = bpy.data.lights.new('bl', t); ld.energy = energy; ld.color = (1, 0.88, 0.72)
    if t == 'AREA': ld.shape = 'RECTANGLE'; ld.size, ld.size_y = size
    else: ld.shadow_soft_size = 0.15
    o = bpy.data.objects.new('bl', ld); BL.objects.link(o); o.location = loc; o.rotation_euler = (0, 0, 0) if t != 'AREA' else (math.pi, 0, 0); return o
for (x, y, z, r, k, rn) in LIGHTS:
    if rn == 'hangar': lamp('AREA', (x, y, z + 0.25), 900 * k, (2.0, 0.5))
    else: lamp('POINT', (x, y, z), 70 * k)
for c_ in strips: pass
if BAKE:
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = int(os.environ.get('MF_SAMPLES', '24'))
    sc.cycles.max_bounces = 3; sc.cycles.diffuse_bounces = 2; sc.cycles.glossy_bounces = 0; sc.cycles.transmission_bounces = 0
    w = bpy.data.worlds.new('mf_w'); sc.world = w; w.use_nodes = True; bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.9, 0.62, 0.45, 1); bg.inputs[1].default_value = 0.0
    OG.hide_render = True; OD.hide_render = False
    me = OI.data; ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER'); me.color_attributes.active_color = ca
    for o in bpy.data.objects: o.select_set(False)
    OI.select_set(True); bpy.context.view_layer.objects.active = OI
    t = time.time(); bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, target='VERTEX_COLORS', use_clear=True, margin=0); print('BAKE', round(time.time() - t, 1), 's', flush=True)
    n = len(me.loops); c = np.zeros(n * 4, dtype=np.float32); ca.data.foreach_get('color', c); c = c.reshape(-1, 4)
    vi = np.zeros(n, dtype=np.int64); me.loops.foreach_get('vertex_index', vi); nv = len(me.vertices); acc = np.zeros((nv, 3)); cnt = np.zeros(nv)
    np.add.at(acc, vi, c[:, :3]); np.add.at(cnt, vi, 1); avg = acc / np.maximum(cnt, 1)[:, None]
    co = np.zeros(nv * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    flo = np.abs(co[:, 2]) < 0.02; med = float(np.median(avg[flo].mean(axis=1))) if flo.any() else 1.0
    v = np.clip(avg[vi] * (0.85 / max(med, 1e-4)), 0.05, 1.7)
    mi = np.zeros(len(me.polygons), dtype=np.int64); me.polygons.foreach_get('material_index', mi); ls = np.zeros(len(me.polygons), dtype=np.int64); me.polygons.foreach_get('loop_start', ls); lt = np.zeros(len(me.polygons), dtype=np.int64); me.polygons.foreach_get('loop_total', lt)
    for pi in np.nonzero(mi == MORDER.index('mf_emit'))[0]: v[ls[pi]:ls[pi] + lt[pi]] = 1.0
    out = np.ones((n, 4), dtype=np.float32); out[:, :3] = v; ca.data.foreach_set('color', out.ravel()); print('BAKE floor median', med, flush=True)
for o in (OE, OG, OD):   # outdoor parts: lit by the world at runtime (no COLOR_0)
    pass
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'mf-annex.blend'), compress=True)

# ── export (u frame) ─────────────────────────────────────────────────────────────────────────────────────
MU = Matrix.Translation((0, Z0, 0)) @ Matrix.Diagonal((U, U, U, 1))          # Blender y = D -> y_u = Z0 + 1.78 D (glTF z = -y_u)
def export(fname, texn):
    for im in IMG.values():
        if im.size[0] != texn: im.scale(texn, texn)
    for o in bpy.data.objects: o.select_set(False)
    dup = []
    for o in (OE, OI, OG):
        d = o.copy(); d.data = o.data.copy(); sc.collection.objects.link(d); d.data.transform(MU); d.name = BASE[o]; d.data.name = BASE[o]; d.select_set(True); dup.append(d)
    dp = bpy.data.objects.new('mf_door_pivot', None); sc.collection.objects.link(dp); dp.select_set(True)
    d = OD.copy(); d.data = OD.data.copy(); sc.collection.objects.link(d); d.data.transform(MU); d.parent = dp; d.name = 'mf_hangar_door'; d.data.name = 'mf_hangar_door'; d.select_set(True); dup += [d, dp]
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, fname), export_format='GLB', use_selection=True, export_image_format='JPEG', export_jpeg_quality=82, export_materials='EXPORT',
                              export_vertex_color='ACTIVE', export_yup=True, export_apply=False, export_extras=True, export_animations=False, export_normals=True, export_texcoords=True)
    for d in dup: bpy.data.objects.remove(d, do_unlink=True)
export('mf-annex.glb', 1024)
export('mf-annex-512.glb', 512)

# ── runtime data (u, the facility's local frame: x, y up, z seaward; relative to the annex floor) ─────────────────────────
def P(x, D, H): return [round(x * U, 3), round(H * U, 3), round(-(Z0 + D * U), 3)]
cols = [P(c[0], c[1], c[2]) + [round(c[3] * U, 3), round(c[5] * U, 3), round(c[4] * U, 3), c[6]] for c in COLS]     # [x, y, z, hx, hy, hz, mat]
def R(r): return [round(r[0] * U, 3), round(-(Z0 + r[3] * U), 3), round(r[2] * U, 3), round(-(Z0 + r[1] * U), 3)]  # [x0, z0, x1, z1]
foot = [W0 - 2, -APRON, W1 + 21, D1 + 0.15]
data = dict(v=1, about='Valles Rim annex (Track 5 / t1590): hangar + habitat wing behind the kept Valles Rim building; frame = facility local (u), y relative to the annex floor',
            U=U, Z0=Z0, foot=R([foot[0], foot[1], foot[2], foot[3]]), apron=R([W0 - 2, -APRON, W1 + 21, 0]),
            roofs=[R([W0 - h, -h, 0, D1 + h]) + [round(HAB_T * U, 3)], R([0, -h, W1 + h, D1 + h]) + [round(HAN_T * U, 3)]],
            inner=[R([W0 - h, -h, W1 + h, D1 + h])], clear=dict(hab=round(HAB_H * U, 3), hangar=round(HAN_H * U, 3)),
            cols=cols, lights=[P(l[0], l[1], l[2]) + [round(l[3] * U, 2), l[4], l[5]] for l in LIGHTS],
            rooms={k: R(v) + [round(v[4] * U, 3)] for k, v in ROOMS.items()},
            door=dict(rect=R([DOOR['x0'], -1.0, DOOR['x1'], 0.4]), h=round(DOOR['h'] * U, 3), travel=round(DOOR_TRAVEL * U, 3), col=P((DOOR['x0'] + DOOR['x1']) / 2, -0.675, DOOR['h'] / 2) + [round(LW / 2 * U, 3), round(DOOR['h'] / 2 * U, 3), round(0.175 * U, 3)]),
            spawn=dict(apron=P(14.0, -6.0, 0), hangar=P(14.0, 12.0, 0), spine=P(-14.0, 8.0, 0), control=P(-21.0, 8.0, 0)),
            tris=dict(ext=EXT.tris(), int=INT.tris(), glass=GLS.tris(), door=DOR.tris()))
json.dump(data, open(os.path.join(OUT, 'mf-annex.json'), 'w'), separators=(',', ':'))
print('DONE', round(time.time() - T0, 1), 's', json.dumps(data['tris']), 'cols', len(cols), 'lights', len(LIGHTS), flush=True)
