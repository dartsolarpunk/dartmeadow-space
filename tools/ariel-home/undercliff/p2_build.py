# t1583u P2 undercliff BUILD (Blender 4.2, headless):  blender -b --factory-startup -P p2_build.py [-- --no-bake]
# Builds my rooms (living, kitchen+dining, workshop/garage), the corridors, the hangar door, the stair drop, the hangar shell, the hatch shaft and the
# scaffold stair, appends the helper's rooms (game, office, guest 1-4) from p2-rooms-b.blend (never edited), bakes the light into vertex colours (Cycles),
# then writes:  OUT/uc-interior.glb (three zone meshes, no images: materials bind to the mansion's own texture sets at run time), OUT/uc-mansion-add.glb
# (bay hall + lintel/jambs, hatch frame + grating, uc_hatch_lid, portal cards), OUT/p2-build.json (tris, obs boxes, lights, scaffold lanes), and
# UCD/p2-undercliff.blend (the render scene). Parametric: every number comes from the P1 layout (p1-layout.json) + the constants below.
import bpy, bmesh, json, math, os, sys, time
from mathutils import Vector
T0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__)); UCD = os.path.dirname(HERE)
exec(open(os.path.join(HERE, 'uc_kit.py')).read())
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
BAKE = '--no-bake' not in ARGS
OUT = os.environ.get('UC_OUT', os.path.join(UCD, 'build'))
REPO = os.environ.get('UC_REPO', '/workspace/jots-cliffs-p2')
TEX = os.path.join(REPO, 'assets/ariel-home/tex'); STRATA = '/workspace/scratch/cliff-render/tex'
HELPER = os.path.join(UCD, 'p2-rooms-b.blend')
os.makedirs(OUT, exist_ok=True)
LY = json.load(open(os.path.join(UCD, 'p1-layout.json')))
L = LY['L']; ST = LY['ST']; HG = LY['HG']; HATCH = LY['HATCH']; SHAFT = LY['SHAFT']; GH = LY['GH']
G = 0.12          # P1 box inset: wall inner faces sit 0.12 m inside the layout lines
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene; sc.unit_settings.scale_length = 1.0

# ---------------- materials (same graph as the helper's, so appended rooms look identical) ----------------
def img(path, noncolor):
    im = bpy.data.images.load(path, check_existing=True)
    if noncolor: im.colorspace_settings.name = 'Non-Color'
    return im
def pbr(name, col, nrm, orm, rough_min=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; n = nt.nodes; l = nt.links; n.clear()
    out = n.new('ShaderNodeOutputMaterial'); b = n.new('ShaderNodeBsdfPrincipled'); l.new(b.outputs[0], out.inputs[0])
    tc = n.new('ShaderNodeTexImage'); tc.image = img(col, False); to = n.new('ShaderNodeTexImage'); to.image = img(orm, True)
    tn = n.new('ShaderNodeTexImage'); tn.image = img(nrm, True); sp = n.new('ShaderNodeSeparateColor'); nm = n.new('ShaderNodeNormalMap')
    l.new(tc.outputs[0], b.inputs['Base Color']); l.new(to.outputs[0], sp.inputs[0])
    if rough_min is not None:   # rock: roughness >= 0.6, metal 0
        mx = n.new('ShaderNodeMath'); mx.operation = 'MAXIMUM'; mx.inputs[1].default_value = rough_min; l.new(sp.outputs[1], mx.inputs[0]); l.new(mx.outputs[0], b.inputs['Roughness'])
        b.inputs['Metallic'].default_value = 0.0
    else:
        l.new(sp.outputs[1], b.inputs['Roughness']); l.new(sp.outputs[2], b.inputs['Metallic'])
    l.new(tn.outputs[0], nm.inputs['Color']); l.new(nm.outputs[0], b.inputs['Normal'])
    return m
MATS = {'uc_rock': pbr('uc_rock', f"{STRATA}/strata-color-2k.png", f"{STRATA}/strata-nrm-2k.png", f"{STRATA}/strata-orm-2k.png", rough_min=0.6)}
for k in ('concrete', 'slate', 'wood', 'dark'):
    MATS['uc_' + k] = pbr('uc_' + k, f"{TEX}/{k}-color-2k.webp", f"{TEX}/{k}-nrm-2k.webp", f"{TEX}/{k}-orm-2k.webp")
em = bpy.data.materials.new('uc_emit'); em.use_nodes = True; bs = em.node_tree.nodes['Principled BSDF']
bs.inputs['Base Color'].default_value = (1, 0.85, 0.6, 1); bs.inputs['Emission Color'].default_value = (1, 0.85, 0.6, 1); bs.inputs['Emission Strength'].default_value = 4.0
MATS['uc_emit'] = em

def coll(name, parent=None):
    c = bpy.data.collections.new(name); (parent or sc.collection).children.link(c); return c
ROOT = coll('UC_P2')
ZONES = {'lower': [], 'stair': [], 'hangar': []}; ROOMTRIS = {}; OBS = []; LIGHTS = []; DOORS = {}
def obs(name, x0, x1, y0, y1, z0, z1): OBS.append(dict(n=name, b=[min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1), z0, z1]))
def light(room, kind, x, y, z, k=1.0, reach=12.0, **kw):
    LIGHTS.append(dict(room=room, kind=kind, x=x, y=y, z=z, k=k, reach_m=reach, rgb=[1, 0.85, 0.6], **kw))
def finish(key, zone, accs, cprops=None):
    c = coll('uc_' + key, ROOT); objs = []; t = 0
    for a in accs:
        if not a.f: continue
        o = a.build(c, MATS); objs.append(o); t += a.tris()
    ROOMTRIS[key] = t; ZONES[zone].extend(objs); return c

def R_(key):
    r = L[key]; return r['X'][0] + G, r['X'][1] - G, -(r['D'][1] - G), -(r['D'][0] + G), r['H'][1]    # x0, x1, y0, y1 (y = -D), Hc

# ======================= MY ROOMS =======================
DW, DH = 1.2, 2.6      # room door (spec)
# door table (P1 positions): bay back wall (D 14) doors + room/corridor doors
BAYDOORS = [('spine', 0.0, 3.76, 3.2), ('workshop', -24.3, 8.0, 4.2), ('living', 10.0, 3.0, 2.6), ('kitchen', -9.0, 3.0, 2.6)]
def std_room(key, floor_mat, rock_side, doors, Hc=None, cove=True, cell=1.0):
    """shell: floor, 4 walls (single-sided, room side), cove ceiling. doors: {side: [(centre, w, h)]}; side N = small D (y max), S = large D (y min), W = x min, E = x max."""
    x0, x1, y0, y1, hc = R_(key); Hc = Hc or hc; Ht = Hc + 0.3
    fl, wa, ce, em_ = Acc(key + '_floor'), Acc(key + '_walls'), Acc(key + '_ceil'), Acc(key + '_emit')
    floor_grid(fl, x0, x1, y0, y1, 0.0, floor_mat, cell)
    sides = {'N': ('x', y1, x0, x1, -1), 'S': ('x', y0, x0, x1, 1), 'W': ('y', x0, y0, y1, 1), 'E': ('y', x1, y0, y1, -1)}
    for sd, (ax, c_, s0, s1, inw) in sides.items():
        ops = [(c, w, h) for (c, w, h) in doors.get(sd, [])]
        wall(wa, ax, c_, s0, s1, 0.0, Ht, inw, 'uc_rock' if sd == rock_side else 'uc_concrete', ops, cell, trim='uc_dark', skirt='uc_dark')
    strips = []
    if cove: cove_ceiling(ce, em_, x0, x1, y0, y1, Hc, Ht, 'uc_concrete', 'uc_dark', 'uc_emit', cell, strips)
    else: ce.gquad((x0, y0, Ht), (x0, y1, Ht), (x1, y1, Ht), (x1, y0, Ht), 'uc_concrete', cell=cell)
    for s in strips: light(key, 'cove', s['x'], s['y'], s['z'], k=0.55, strip_len_m=s['len'], ax=s['ax'])
    return dict(x0=x0, x1=x1, y0=y0, y1=y1, Hc=Hc, Ht=Ht, fl=fl, wa=wa, ce=ce, em=em_)

def dlights(key, S, pts):
    for (x, y) in pts:
        downlight(S['ce'], x, y, S['Hc'], 'uc_dark', 'uc_emit'); light(key, 'downlight', x, y, S['Hc'] - 0.02)

# ---- furniture primitives ----
def sofa(a, x0, x1, y0, y1, back_side, mat='uc_concrete', base='uc_dark', seat_h=0.42, back_h=0.85):
    a.box(x0, x1, y0, y1, 0.0, 0.12, base, skip=('-z',))
    a.box(x0, x1, y0, y1, 0.12, seat_h, mat, skip=('-z',))
    t = 0.22
    if back_side == 'S': a.box(x0, x1, y0, y0 + t, seat_h, back_h, mat)
    if back_side == 'N': a.box(x0, x1, y1 - t, y1, seat_h, back_h, mat)
    if back_side == 'W': a.box(x0, x0 + t, y0, y1, seat_h, back_h, mat)
    if back_side == 'E': a.box(x1 - t, x1, y0, y1, seat_h, back_h, mat)
    # loose cushions (eye-level detail)
    n = max(1, int(round(max(x1 - x0, y1 - y0) / 0.9)))
    for i in range(n):
        if back_side in ('S', 'N'):
            cx0 = x0 + (x1 - x0) * i / n + 0.03; cx1 = x0 + (x1 - x0) * (i + 1) / n - 0.03
            yy = (y0 + t, y0 + t + 0.14) if back_side == 'S' else (y1 - t - 0.14, y1 - t)
            a.box(cx0, cx1, yy[0], yy[1], seat_h, seat_h + 0.38, mat, skip=('-z',))
        else:
            cy0 = y0 + (y1 - y0) * i / n + 0.03; cy1 = y0 + (y1 - y0) * (i + 1) / n - 0.03
            xx = (x0 + t, x0 + t + 0.14) if back_side == 'W' else (x1 - t - 0.14, x1 - t)
            a.box(xx[0], xx[1], cy0, cy1, seat_h, seat_h + 0.38, mat, skip=('-z',))
def table(a, x0, x1, y0, y1, h, top='uc_wood', leg='uc_dark', t=0.05, lr=0.04):
    a.box(x0, x1, y0, y1, h - t, h, top)
    for (lx, ly) in ((x0 + 0.08, y0 + 0.08), (x1 - 0.08, y0 + 0.08), (x0 + 0.08, y1 - 0.08), (x1 - 0.08, y1 - 0.08)):
        a.box(lx - lr, lx + lr, ly - lr, ly + lr, 0.0, h - t, leg, skip=('-z', '+z'))
def chair(a, x, y, face, mat='uc_wood', leg='uc_dark'):
    s = 0.22; a.box(x - s, x + s, y - s, y + s, 0.42, 0.47, mat)
    for (lx, ly) in ((x - s + 0.03, y - s + 0.03), (x + s - 0.03, y - s + 0.03), (x - s + 0.03, y + s - 0.03), (x + s - 0.03, y + s - 0.03)):
        a.box(lx - 0.018, lx + 0.018, ly - 0.018, ly + 0.018, 0.0, 0.42, leg, skip=('-z', '+z'))
    bx = {'N': (x - s, x + s, y - s, y - s + 0.04), 'S': (x - s, x + s, y + s - 0.04, y + s), 'E': (x - s, x - s + 0.04, y - s, y + s), 'W': (x + s - 0.04, x + s, y - s, y + s)}[face]
    a.box(bx[0], bx[1], bx[2], bx[3], 0.47, 0.9, mat)
def shelf(a, x0, x1, y0, y1, h, n, mat='uc_wood', frame='uc_dark', books=True):
    a.box(x0, x1, y0, y1, 0.0, 0.06, frame, skip=('-z',))
    for (sx0, sx1, sy0, sy1) in ((x0, x0 + 0.04, y0, y1), (x1 - 0.04, x1, y0, y1)) if (x1 - x0) > (y1 - y0) else ((x0, x1, y0, y0 + 0.04), (x0, x1, y1 - 0.04, y1)):
        a.box(sx0, sx1, sy0, sy1, 0.0, h, frame, skip=('-z',))
    for i in range(1, n + 1):
        z = h * i / n; a.box(x0, x1, y0, y1, z - 0.03, z, mat)
        if books and i < n:
            along_x = (x1 - x0) > (y1 - y0); ln = (x1 - x0) if along_x else (y1 - y0); k = int(ln / 0.32)
            for j in range(k):
                if (j * 7 + i * 3) % 5 == 0: continue
                bh = h / n * (0.55 + 0.3 * ((j * 13 + i * 5) % 7) / 7)
                if along_x: bx0 = x0 + 0.06 + j * 0.32; a.box(bx0, bx0 + 0.26, y0 + 0.03, y1 - 0.05, z, z + bh, 'uc_dark' if j % 3 else 'uc_concrete', skip=('-z',))
                else: by0 = y0 + 0.06 + j * 0.32; a.box(x0 + 0.03, x1 - 0.05, by0, by0 + 0.26, z, z + bh, 'uc_dark' if j % 3 else 'uc_concrete', skip=('-z',))
def pendant(a, em_, x, y, Hc, drop=1.4, r=0.22):
    a.cyl(x, y, Hc - drop, Hc, 0.008, 4, 'uc_dark', caps=(False, False))
    a.cyl(x, y, Hc - drop - 0.22, Hc - drop, r, 16, 'uc_dark', caps=(False, True), r1=0.05)
    em_.cyl(x, y, Hc - drop - 0.225, Hc - drop - 0.2, r * 0.9, 16, 'uc_emit', caps=(True, False))

# ---- living (X 2..18, D 14..28): sofa group facing the rock feature wall, shelves, reading corner ----
S = std_room('living', 'uc_wood', 'E', {'N': [(10.0, 3.0, 2.6)], 'W': [(-21.0, 2.0, 2.6)]})
pr = Acc('living_props'); x0, x1, y0, y1 = S['x0'], S['x1'], S['y0'], S['y1']
pr.box(6.0, 16.6, -26.0, -16.5, 0.0, 0.015, 'uc_slate', skip=('-z',))                             # stone rug inset
sofa(pr, 7.0, 12.5, -26.6, -25.6, 'S'); sofa(pr, 6.0, 7.0, -25.6, -20.6, 'W'); obs('living_sofa', 6.0, 12.5, -26.6, -20.6, 0, 0.85)
sofa(pr, 7.6, 11.6, -16.7, -15.8, 'N'); obs('living_sofa2', 7.6, 11.6, -16.7, -15.8, 0, 0.85)
table(pr, 8.6, 11.4, -23.0, -20.4, 0.38, top='uc_slate'); obs('living_table', 8.6, 11.4, -23.0, -20.4, 0, 0.38)
# media credenza + screen on the rock wall (E)
pr.box(x1 - 0.55, x1 - 0.02, -24.5, -17.5, 0.0, 0.55, 'uc_wood', skip=('-z',)); pr.box(x1 - 0.12, x1 - 0.04, -23.6, -18.4, 1.0, 2.45, 'uc_dark'); obs('living_media', x1 - 0.55, x1, -24.5, -17.5, 0, 0.55)
shelf(pr, x0 + 0.02, x0 + 0.4, -27.6, -23.0, 2.6, 5); obs('living_shelf', x0, x0 + 0.4, -27.6, -23.0, 0, 2.6)
sofa(pr, 13.4, 14.4, -27.6, -26.6, 'S'); sofa(pr, 15.0, 16.0, -27.6, -26.6, 'S'); table(pr, 14.45, 14.95, -27.4, -26.9, 0.5)
pr.cyl(16.8, -27.2, 0.0, 1.55, 0.015, 6, 'uc_dark', caps=(False, False)); pr.cyl(16.8, -27.2, 1.55, 1.8, 0.2, 12, 'uc_dark', caps=(False, True), r1=0.12)
S['em'].cyl(16.8, -27.2, 1.54, 1.56, 0.17, 12, 'uc_emit', caps=(True, False)); light('living', 'floorlamp', 16.8, -27.2, 1.5)
dlights('living', S, [(6.0, -18.0), (14.0, -18.0), (6.0, -24.5), (14.0, -24.5)])
finish('living', 'lower', [S['fl'], S['wa'], S['ce'], S['em'], pr])

# ---- master kitchen + dining (X -16..-2, D 14..28): island, wall run, dining for 8 ----
S = std_room('kitchen', 'uc_slate', 'S', {'N': [(-9.0, 3.0, 2.6)], 'E': [(-21.0, 2.0, 2.6)], 'W': [(-24.0, 1.2, 2.6)]})
pr = Acc('kitchen_props'); x0, x1, y0, y1 = S['x0'], S['x1'], S['y0'], S['y1']
# wall run on the W wall: base cabinets, counter, upper cabinets, tall fridge columns
pr.box(x0 + 0.02, x0 + 0.65, -22.0, -15.0, 0.0, 0.88, 'uc_wood', skip=('-z',)); pr.box(x0 + 0.02, x0 + 0.68, -22.0, -15.0, 0.88, 0.92, 'uc_slate')
for i in range(8): yy = -22.0 + i * 0.875; pr.box(x0 + 0.65, x0 + 0.66, yy + 0.02, yy + 0.855, 0.1, 0.84, 'uc_wood', skip=('-x',))
pr.box(x0 + 0.02, x0 + 0.38, -22.0, -15.0, 1.5, 2.3, 'uc_wood', skip=()); pr.box(x0 + 0.02, x0 + 0.68, -25.0, -22.05, 0.0, 2.4, 'uc_dark', skip=('-z',))
pr.box(x0 + 0.3, x0 + 0.62, -19.2, -17.8, 1.9, 2.5, 'uc_dark'); obs('kitchen_run', x0, x0 + 0.7, -25.0, -15.0, 0, 2.4)
# island (slate top, wood body) + 4 stools
pr.box(-12.5, -9.5, -20.4, -18.8, 0.0, 0.9, 'uc_wood', skip=('-z',)); pr.box(-12.65, -9.35, -20.55, -18.65, 0.9, 0.95, 'uc_slate'); obs('kitchen_island', -12.65, -9.35, -20.55, -18.65, 0, 0.95)
for i in range(4):
    sx = -12.1 + i * 0.75; pr.cyl(sx, -18.25, 0.0, 0.7, 0.03, 6, 'uc_dark', caps=(False, False)); pr.cyl(sx, -18.25, 0.7, 0.75, 0.2, 12, 'uc_wood')
for i, xx in enumerate((-12.0, -11.0, -10.0)): pendant(pr, S['em'], xx, -19.6, S['Hc'], drop=1.25, r=0.16); light('kitchen', 'pendant', xx, -19.6, S['Hc'] - 1.5)
# dining table for 8 by the rock wall (S)
table(pr, -11.0, -6.0, -26.4, -25.2, 0.76); obs('kitchen_dining', -11.3, -5.7, -26.9, -24.7, 0, 0.76)
for i in range(4):
    cx = -10.4 + i * 1.25; chair(pr, cx, -26.75, 'S'); chair(pr, cx, -24.85, 'N')
for xx in (-10.0, -8.5, -7.0): pendant(pr, S['em'], xx, -25.8, S['Hc'], drop=1.6, r=0.2); light('kitchen', 'pendant', xx, -25.8, S['Hc'] - 1.8)
shelf(pr, -4.0, -2.3, y0 + 0.02, y0 + 0.42, 2.2, 4)
dlights('kitchen', S, [(-14.0, -16.5), (-5.0, -16.5), (-14.0, -23.0), (-5.0, -21.0)])
finish('kitchen', 'lower', [S['fl'], S['wa'], S['ce'], S['em'], pr])

# ---- workshop / garage (X -32.6..-16, D 14..28): vehicle door to the bay, bench + tool wall, racks, a parked rover ----
S = std_room('workshop', 'uc_concrete', 'W', {'N': [(-24.3, 8.0, 4.2)], 'E': [(-24.0, 1.2, 2.6)], 'S': [(-20.0, 1.2, 2.6)]})
pr = Acc('workshop_props'); x0, x1, y0, y1 = S['x0'], S['x1'], S['y0'], S['y1']
for xx in (-28.3, -20.3):                                                                           # bay parking lines
    pr.box(xx - 0.06, xx + 0.06, -25.5, -15.0, 0.0, 0.006, 'uc_dark', skip=('-z',))
pr.box(-28.3, -20.3, -25.56, -25.44, 0.0, 0.006, 'uc_dark', skip=('-z',))
# rover: chassis, cab, 4 wheels, roof rack
rx, ry = -24.3, -20.0
pr.box(rx - 1.0, rx + 1.0, ry - 2.2, ry + 2.2, 0.45, 1.1, 'uc_dark'); pr.box(rx - 0.95, rx + 0.95, ry - 0.4, ry + 2.0, 1.1, 1.95, 'uc_concrete')
pr.box(rx - 0.9, rx + 0.9, ry + 1.95, ry + 2.02, 1.25, 1.85, 'uc_dark'); pr.box(rx - 0.85, rx + 0.85, ry - 0.3, ry + 1.8, 1.95, 2.02, 'uc_dark')
for (wx, wy) in ((rx - 1.05, ry - 1.4), (rx + 1.05, ry - 1.4), (rx - 1.05, ry + 1.4), (rx + 1.05, ry + 1.4)):
    pr.hcyl('x', wx - 0.16, wx + 0.16, 0.45, 16, 'uc_dark', wy, 0.45)
obs('workshop_rover', rx - 1.25, rx + 1.25, ry - 2.25, ry + 2.25, 0, 2.0)
# bench + pegboard + tools on the rock wall (W)
pr.box(x0 + 0.02, x0 + 0.8, -26.0, -18.0, 0.85, 0.92, 'uc_wood'); pr.box(x0 + 0.05, x0 + 0.75, -26.0, -18.0, 0.0, 0.78, 'uc_dark', skip=('-z',))
pr.box(x0 + 0.02, x0 + 0.06, -26.0, -18.0, 1.1, 2.4, 'uc_dark'); obs('workshop_bench', x0, x0 + 0.8, -26.0, -18.0, 0, 0.92)
for i in range(14):
    ty = -25.6 + i * 0.55; h = 0.25 + 0.2 * ((i * 7) % 3); pr.box(x0 + 0.06, x0 + 0.12, ty, ty + 0.08, 1.4 + 0.3 * (i % 3), 1.4 + 0.3 * (i % 3) + h, 'uc_concrete')
for i in range(3): pr.box(x0 + 0.1, x0 + 0.6, -25.2 + i * 2.5, -24.4 + i * 2.5, 0.92, 1.2, 'uc_concrete')
# racks with crates along S wall
for rk in range(3):
    rx0 = -31.5 + rk * 3.2
    shelf(pr, rx0, rx0 + 2.8, y0 + 0.05, y0 + 0.75, 3.0, 4, mat='uc_dark', frame='uc_dark', books=False)
    for lv in range(4):
        z = 3.0 * lv / 4
        for cx in range(3):
            if (rk + lv + cx) % 4 == 0: continue
            pr.box(rx0 + 0.1 + cx * 0.9, rx0 + 0.85 + cx * 0.9, y0 + 0.1, y0 + 0.7, z + 0.0, z + 0.45, 'uc_wood', skip=('-z',))
obs('workshop_racks', -31.5, -22.3, y0, y0 + 0.8, 0, 3.0)
pr.box(x1 - 0.7, x1 - 0.05, -17.0, -15.5, 0.0, 1.1, 'uc_dark', skip=('-z',)); obs('workshop_chest', x1 - 0.7, x1, -17.0, -15.5, 0, 1.1)
for i, xx in enumerate((-29.0, -24.3, -19.6)):
    pr.box(xx - 0.6, xx + 0.6, -21.0, -20.8, S['Hc'] - 0.6, S['Hc'] - 0.55, 'uc_dark'); pr.cyl(xx - 0.5, -20.9, S['Hc'] - 0.55, S['Hc'], 0.006, 4, 'uc_dark', caps=(False, False)); pr.cyl(xx + 0.5, -20.9, S['Hc'] - 0.55, S['Hc'], 0.006, 4, 'uc_dark', caps=(False, False))
    S['em'].box(xx - 0.58, xx + 0.58, -20.98, -20.82, S['Hc'] - 0.605, S['Hc'] - 0.6, 'uc_emit'); light('workshop', 'linear', xx, -20.9, S['Hc'] - 0.62, strip_len_m=1.16)
dlights('workshop', S, [(-30.0, -16.0), (-18.5, -16.0), (-30.0, -26.0), (-18.5, -26.0)])
finish('workshop', 'lower', [S['fl'], S['wa'], S['ce'], S['em'], pr])

# ---- corridors: spine (X -2..2, D 14..52), guest corridor (X -30..-2, D 28..31) ----
def corridor(key, x0, x1, y0, y1, Hc, doors, rock_side=None, open_sides=(), lights_every=4.0, along='y'):
    fl, wa, ce, em_ = Acc(key + '_floor'), Acc(key + '_walls'), Acc(key + '_ceil'), Acc(key + '_emit')
    floor_grid(fl, x0, x1, y0, y1, 0.0, 'uc_slate', 1.0)
    Ht = Hc + 0.25
    sides = {'N': ('x', y1, x0, x1, -1), 'S': ('x', y0, x0, x1, 1), 'W': ('y', x0, y0, y1, 1), 'E': ('y', x1, y0, y1, -1)}
    for sd, (ax, c_, s0, s1, inw) in sides.items():
        if sd in open_sides: continue
        wall(wa, ax, c_, s0, s1, 0.0, Ht, inw, 'uc_rock' if sd == rock_side else 'uc_concrete', doors.get(sd, []), 1.0, trim='uc_dark', skirt='uc_dark')
    # ceiling: a central dropped plank at Hc with linear LED slots either side, upper ceiling at Ht
    ce.gquad((x0, y0, Ht), (x0, y1, Ht), (x1, y1, Ht), (x1, y0, Ht), 'uc_concrete', cell=1.0)
    if along == 'y':
        cx = (x0 + x1) / 2; w = (x1 - x0) * 0.28
        ce.box(cx - w, cx + w, y0, y1, Hc, Ht, 'uc_wood', skip=('+z',), cell=1.0)
        for sx in (cx - w - 0.02, cx + w + 0.02): em_.box(sx - 0.015, sx + 0.015, y0 + 0.1, y1 - 0.1, Ht - 0.04, Ht - 0.01, 'uc_emit', skip=('+z',))
        n = max(1, int((y1 - y0) / lights_every))
        for i in range(n): light(key, 'linear', cx, y0 + (i + 0.5) * (y1 - y0) / n, Ht - 0.05, k=0.55, strip_len_m=(y1 - y0) / n)
    else:
        cy = (y0 + y1) / 2; w = (y1 - y0) * 0.28
        ce.box(x0, x1, cy - w, cy + w, Hc, Ht, 'uc_wood', skip=('+z',), cell=1.0)
        for sy in (cy - w - 0.02, cy + w + 0.02): em_.box(x0 + 0.1, x1 - 0.1, sy - 0.015, sy + 0.015, Ht - 0.04, Ht - 0.01, 'uc_emit', skip=('+z',))
        n = max(1, int((x1 - x0) / lights_every))
        for i in range(n): light(key, 'linear', x0 + (i + 0.5) * (x1 - x0) / n, cy, Ht - 0.05, k=0.55, strip_len_m=(x1 - x0) / n)
    return [fl, wa, ce, em_]
x0, x1, y0, y1, Hc = R_('spine')
# spine west wall: kitchen door (D 21), guest corridor opening (D 28..31 -> y -28.12..-30.88); east wall: living (D 21), office (D 32.2), game (D 42)
sp = corridor('spine', x0, x1, y0, y1, Hc, {'W': [(-21.0, 2.0, 2.6), (-29.5, 2.76, 3.4)], 'E': [(-21.0, 2.0, 2.6), (-32.2, 1.2, 2.6), (-42.0, 1.2, 2.6)]},
              rock_side='S', open_sides=('N',))
finish('spine', 'lower', sp)
x0, x1, y0, y1, Hc = R_('gcorr')
gdoors = [(-24.78, 1.2, 2.6), (-15.22, 1.2, 2.6), (-12.78, 1.2, 2.6), (-3.22, 1.2, 2.6)]
gc = corridor('gcorr', x0, x1, y0, y1, Hc, {'S': gdoors, 'N': [(-20.0, 1.2, 2.6)]}, open_sides=('E', 'W'), along='x')
# hangar door at the west end (X -30): heavy sliding leaf parked open in a pocket + frame (P3 can animate it)
hd = Acc('hangar_door'); hx = ST['x_top']
hd.box(hx - 0.3, hx + 0.05, y0 - 0.25, y0, 0.0, 3.25, 'uc_dark'); hd.box(hx - 0.3, hx + 0.05, y1, y1 + 0.25, 0.0, 3.25, 'uc_dark')
hd.box(hx - 0.3, hx + 0.05, y0 - 0.25, y1 + 0.25, 3.0, 3.25, 'uc_dark')
hd.box(hx - 0.22, hx - 0.08, y0 - 2.9, y0 - 0.05, 0.02, 3.0, 'uc_concrete')        # leaf, slid into the pocket on the S side
for i in range(4): hd.box(hx - 0.24, hx - 0.06, y0 - 2.8 + i * 0.7, y0 - 2.75 + i * 0.7, 0.1, 2.9, 'uc_dark')
DOORS['hangar_door'] = dict(x=hx, y=(y0 + y1) / 2, w=y1 - y0, h=3.0)
finish('gcorr', 'lower', gc + [hd])

# ======================= STAIR DROP (guest corridor -> hangar, 12 m, 4 flights) =======================
sa, sw_, ce_, em_ = Acc('stair_steps'), Acc('stair_walls'), Acc('stair_ceil'), Acc('stair_emit')
yS, yN = -(ST['D'][1] - G), -(ST['D'][0] + G)
riser, tread = ST['riser'], ST['tread']; x = ST['x_top']; h = 0.0; prof = [(x, 0.0)]; STAIR_RUNS = []
for f in range(ST['flights']):
    xs, hs = x, h
    for k in range(ST['risers']):
        sa.poly([(x, yS, h - riser), (x, yN, h - riser), (x, yN, h), (x, yS, h)][::-1], 'uc_dark')      # riser (faces -x, toward a climber coming up from the hangar)
        h -= riser
        if k < ST['risers'] - 1:
            sa.poly([(x - tread, yS, h), (x, yS, h), (x, yN, h), (x - tread, yN, h)], 'uc_slate'); sa.box(x - 0.03, x, yS, yN, h - 0.02, h + 0.005, 'uc_dark', skip=('-z',))   # tread + nosing
            x -= tread
    STAIR_RUNS.append(dict(kind='flight', x_hi=xs, x_lo=x, h_hi=hs, h_lo=h))
    prof.append((x, h))
    if f < ST['flights'] - 1:
        sa.gquad((x - ST['landing'], yS, h), (x, yS, h), (x, yN, h), (x - ST['landing'], yN, h), 'uc_slate', cell=1.0)
        STAIR_RUNS.append(dict(kind='landing', x_hi=x, x_lo=x - ST['landing'], h=h)); x -= ST['landing']; prof.append((x, h))
xb = x
# tunnel walls follow the profile (+ 3.3 m clear over the nosing), ceiling slopes with it; handrails + a warm LED rail on both walls
HC = 3.3
for yy, inw in ((yS, 1), (yN, -1)):
    for (xa, ha), (xb_, hb) in zip(prof[:-1], prof[1:]):
        lo0, lo1 = ha - 0.4, hb - 0.4; hi0, hi1 = ha + HC, hb + HC
        p = [(xb_, yy, lo1), (xa, yy, lo0), (xa, yy, hi0), (xb_, yy, hi1)]
        if inw > 0: p = [p[1], p[0], p[3], p[2]]
        n = max(1, math.ceil(abs(xa - xb_) / 1.0)); sw_.quad(*p, 'uc_rock' if (int(abs(xa)) % 7 == 0) else 'uc_concrete', nu=n, nv=4)
        rail_y = yy + 0.08 * inw
        sw_.box(min(xa, xb_), max(xa, xb_), rail_y - 0.025, rail_y + 0.025, min(ha, hb) + 0.9 + (0 if ha == hb else 0), max(ha, hb) + 0.95, 'uc_dark') if ha == hb else None
        if ha != hb:   # sloped handrail as a thin quad strip + LED strip under it
            for dz, mat, w in ((0.9, 'uc_dark', 0.05), (0.86, 'uc_emit', 0.012)):
                q = [(xb_, rail_y, hb + dz), (xa, rail_y, ha + dz), (xa, rail_y, ha + dz + w), (xb_, rail_y, hb + dz + w)]
                (em_ if mat == 'uc_emit' else sw_).quad(*([q[1], q[0], q[3], q[2]] if inw > 0 else q), mat)
for (xa, ha), (xb_, hb) in zip(prof[:-1], prof[1:]):
    p = [(xa, yS, ha + HC), (xa, yN, ha + HC), (xb_, yN, hb + HC), (xb_, yS, hb + HC)][::-1]
    ce_.quad(*p, 'uc_concrete', nu=max(1, math.ceil(abs(xa - xb_))), nv=2)
    light('stair', 'linear', (xa + xb_) / 2, (yS + yN) / 2, (ha + hb) / 2 + HC - 0.1, k=0.55, strip_len_m=abs(xa - xb_))
for (xa, ha), (xb_, hb) in zip(prof[:-1], prof[1:]):
    em_.quad((xa, (yS + yN) / 2 - 0.03, ha + HC - 0.01), (xb_, (yS + yN) / 2 - 0.03, hb + HC - 0.01), (xb_, (yS + yN) / 2 + 0.03, hb + HC - 0.01), (xa, (yS + yN) / 2 + 0.03, ha + HC - 0.01), 'uc_emit')
finish('stair', 'stair', [sa, sw_, ce_, em_])
print('STAIR bottom x', round(xb, 3), 'h', round(h, 3), flush=True)

# ======================= HANGAR SHELL + SHAFT =======================
X0, X1 = HG['X']; D0, D1 = HG['D']; H0, H1 = HG['H']; hy0, hy1 = -D1, -D0
sx0, sx1 = SHAFT['X']; sy0, sy1 = -SHAFT['D'][1], -SHAFT['D'][0]
hf, hw, hc, hp, he = Acc('hangar_floor'), Acc('hangar_walls'), Acc('hangar_ceil'), Acc('hangar_props'), Acc('hangar_emit')
floor_grid(hf, X0, X1, hy0, hy1, H0, 'uc_concrete', 2.0)
HXc = (X0 + X1) / 2; VX, VY = HXc, -(D0 + 20.0 + 7.0)         # VTOL spot: L +7 from the floor centre (D 27 + 7 = 34)
VY = -34.0
# pad markings: ring + cross, dark paint, plus warm edge lights (uc_emit studs)
for k in range(48):
    a0, a1 = 2 * math.pi * k / 48, 2 * math.pi * (k + 1) / 48; r0, r1 = 7.7, 8.0
    hp.poly([(VX + r0 * math.cos(a0), VY + r0 * math.sin(a0), H0 + 0.006), (VX + r1 * math.cos(a0), VY + r1 * math.sin(a0), H0 + 0.006),
             (VX + r1 * math.cos(a1), VY + r1 * math.sin(a1), H0 + 0.006), (VX + r0 * math.cos(a1), VY + r0 * math.sin(a1), H0 + 0.006)], 'uc_dark')
    if k % 4 == 0: he.box(VX + 8.4 * math.cos(a0) - 0.08, VX + 8.4 * math.cos(a0) + 0.08, VY + 8.4 * math.sin(a0) - 0.08, VY + 8.4 * math.sin(a0) + 0.08, H0, H0 + 0.03, 'uc_emit', skip=('-z',))
for (a, b, c_, d) in (((VX - 0.15, VY - 5), (VX + 0.15, VY - 5), (VX + 0.15, VY + 5), (VX - 0.15, VY + 5)), ((VX - 5, VY - 0.15), (VX + 5, VY - 0.15), (VX + 5, VY + 0.15), (VX - 5, VY + 0.15))):
    hp.poly([(*a, H0 + 0.006), (*b, H0 + 0.006), (*c_, H0 + 0.006), (*d, H0 + 0.006)], 'uc_dark')
# walls: concrete plinth 0..3 m, hewn rock above; E wall opening for the stair tunnel (D 28..31), 3.3 m
def hwall(ax, c_, s0, s1, inw, ops=()):
    wall(hw, ax, c_, s0, s1, H0, H0 + 3.0, inw, 'uc_concrete', ops, 2.0, trim='uc_dark')
    hi_ops = [(o[0], o[1], o[2] - 3.0) for o in ops if o[2] > 3.0]
    wall(hw, ax, c_, s0, s1, H0 + 3.0, H1 + 0.3, inw, 'uc_rock', hi_ops, 2.5)
hwall('x', hy1, X0, X1, -1); hwall('x', hy0, X0, X1, 1); hwall('y', X0, hy0, hy1, 1)
hwall('y', X1, hy0, hy1, -1, [(-29.5, 2.76, 3.3)])
for (yy, inw) in ((hy1, -1), (hy0, 1)):     # plinth cap (dark) band
    hw.box(X0, X1, yy, yy + 0.08 * inw, H0 + 2.95, H0 + 3.05, 'uc_dark', skip=())
# ceiling (rock) at H1 with the shaft opening; steel trusses + high-bay lights
for (a0, a1, b0, b1) in ((X0, X1, hy0, sy0), (X0, X1, sy1, hy1), (X0, sx0, sy0, sy1), (sx1, X1, sy0, sy1)):
    if a1 - a0 > 1e-3 and b1 - b0 > 1e-3: hc.gquad((a0, b0, H1), (a0, b1, H1), (a1, b1, H1), (a1, b0, H1), 'uc_rock', cell=2.5)
def truss(xa, xb_, y, zt, depth=1.6):
    hp.box(xa, xb_, y - 0.15, y + 0.15, zt - 0.12, zt, 'uc_dark'); hp.box(xa, xb_, y - 0.15, y + 0.15, zt - depth, zt - depth + 0.12, 'uc_dark')
    n = int((xb_ - xa) / 1.6)
    for i in range(n + 1):
        xx = xa + i * (xb_ - xa) / n; hp.box(xx - 0.05, xx + 0.05, y - 0.08, y + 0.08, zt - depth, zt, 'uc_dark', skip=('-z', '+z'))
        if i < n:
            x2 = xa + (i + 1) * (xb_ - xa) / n; a, b = (xx, zt - depth + 0.1), (x2, zt - 0.1)
            if i % 2: a, b = (xx, zt - 0.1), (x2, zt - depth + 0.1)
            hp.quad((a[0], y, a[1] - 0.04), (b[0], y, b[1] - 0.04), (b[0], y, b[1] + 0.04), (a[0], y, a[1] + 0.04), 'uc_dark')
for D in (10.5, 16.5, 22.0):
    truss(X0, X1, -D, H1)
    for xx in (X0 + 5, HXc - 5, HXc + 5, X1 - 5):
        hp.box(xx - 1.2, xx + 1.2, -D - 0.35, -D + 0.35, H1 - 1.75, H1 - 1.62, 'uc_dark'); he.box(xx - 1.1, xx + 1.1, -D - 0.25, -D + 0.25, H1 - 1.765, H1 - 1.75, 'uc_emit', skip=('+z',))
        light('hangar', 'highbay', xx, -D, H1 - 1.8, k=1.0, reach=26.0)
for xx in (X0 + 2.5, X1 - 2.5):
    hp.box(xx - 0.15, xx + 0.15, -D1 + 0.2, -23.0, H1 - 1.2, H1, 'uc_dark')
    for D in (28.0, 35.0, 42.0):
        he.box(xx - 0.25, xx + 0.25, -D - 1.1, -D + 1.1, H1 - 1.215, H1 - 1.2, 'uc_emit', skip=('+z',)); light('hangar', 'highbay', xx, -D, H1 - 1.25, k=1.0, reach=26.0)
# wall wash lights along the plinth cap (warm), every 6 m on the long walls
for (yy, inw) in ((hy1, -1), (hy0, 1)):
    for i in range(5):
        xx = X0 + 3 + i * 6; he.box(xx - 0.6, xx + 0.6, yy + 0.05 * inw, yy + 0.09 * inw, H0 + 3.06, H0 + 3.1, 'uc_emit'); light('hangar', 'wash', xx, yy + 0.3 * inw, H0 + 3.1, k=0.55, strip_len_m=1.2)
# shaft walls (rock, +6 m to the ground) incl. the 2 m scaffold strip; frame + lid + grating are mansion additions
sh = Acc('shaft_walls')
wall(sh, 'x', sy1, sx0, sx1, H1, GH + 0.05, -1, 'uc_rock', (), 2.0); wall(sh, 'x', sy0, sx0, sx1, H1, GH + 0.05, 1, 'uc_rock', (), 2.0)
wall(sh, 'y', sx0, sy0, sy1, H1, GH + 0.05, 1, 'uc_rock', (), 2.0); wall(sh, 'y', sx1, sy0, sy1, H1, GH + 0.05, -1, 'uc_rock', (), 2.0)
finish('hangar', 'hangar', [hf, hw, hc, hp, he, sh])

# ======================= SCAFFOLD STAIR (surface -> hangar floor, 7 flights) =======================
# Lane A along the shaft's inland wall (D 45.6..47) from the top landing (E end of the strip) going W; corner landing in the hangar's NW corner;
# lane B down the hangar's W wall (X -80.24..-78.84) going seaward to the floor. No two flights overlap in plan, so every flight has full headroom.
SCW = 1.4; HTOP = GH + 0.35; NR = 18; NF = 7; RIS = (HTOP - H0) / (NR * NF); TRD = 0.26; FL = (NR - 1) * TRD; LND = 1.5
aD0, aD1 = SHAFT['D'][1] - SCW, SHAFT['D'][1]            # lane A: D 45.6..47
bX0, bX1 = X0, X0 + SCW                                    # lane B: X -80.24..-78.84
LANES = []; sc_ = Acc('scaffold'); h = HTOP
def grate(a, x0_, x1_, y0_, y1_, z):
    a.box(x0_, x1_, y0_, y1_, z - 0.05, z, 'uc_dark', skip=())
def post(a, x, y, z0, z1): a.box(x - 0.03, x + 0.03, y - 0.03, y + 0.03, z0, z1, 'uc_dark', skip=('-z', '+z'))
xA = sx1 - 0.0
LANES.append(dict(kind='landing', lane='A', x0=xA - LND, x1=xA, d0=aD0, d1=aD1, h=h)); grate(sc_, xA - LND, xA, -aD1, -aD0, h); x = xA - LND
for f in range(3):                     # lane A, westward
    xs, hs = x, h
    for k in range(NR):
        h -= RIS
        if k < NR - 1: grate(sc_, x - TRD, x, -aD1, -aD0, h); x -= TRD
    LANES.append(dict(kind='flight', lane='A', ax='x', x0=x, x1=xs, d0=aD0, d1=aD1, h_lo=h, h_hi=hs, lo=x, hi=xs))
    for (xx, z) in ((xs, hs), (x, h)): post(sc_, xx, -aD0, z, z + 1.05)
    sc_.quad((x, -aD0 + 0.02, h + 1.0), (xs, -aD0 + 0.02, hs + 1.0), (xs, -aD0 + 0.02, hs + 1.06), (x, -aD0 + 0.02, h + 1.06), 'uc_dark')        # handrail
    sc_.quad((x, -aD0 + 0.02, h - 0.35), (xs, -aD0 + 0.02, hs - 0.35), (xs, -aD0 + 0.02, hs - 0.05), (x, -aD0 + 0.02, h - 0.05), 'uc_dark')      # stringer
    if f < 2:
        LANES.append(dict(kind='landing', lane='A', x0=x - LND, x1=x, d0=aD0, d1=aD1, h=h)); grate(sc_, x - LND, x, -aD1, -aD0, h); x -= LND
# corner landing: lane A end -> hangar W wall
LANES.append(dict(kind='landing', lane='C', x0=X0, x1=x, d0=aD0, d1=aD1, h=h)); grate(sc_, X0, x, -aD1, -aD0, h)
for xx in (X0 + SCW, x): post(sc_, xx, -aD0, h, h + 1.05)
sc_.box(X0 + SCW, x, -aD0 - 0.02, -aD0 + 0.02, h + 1.0, h + 1.06, 'uc_dark')
# corner landing needs the bit of lane B under it too
y = -aD0
for f in range(4):                     # lane B, seaward (D decreasing -> y increasing)
    ys, hs = y, h
    for k in range(NR):
        h -= RIS
        if k < NR - 1: grate(sc_, bX0, bX1, y, y + TRD, h); y += TRD
    LANES.append(dict(kind='flight', lane='B', ax='y', x0=bX0, x1=bX1, d0=-y, d1=-ys, h_lo=h, h_hi=hs, lo=y, hi=ys))
    for (yy, z) in ((ys, hs), (y, h)): post(sc_, bX1, yy, z, z + 1.05)
    sc_.quad((bX1 - 0.02, ys, hs + 1.0), (bX1 - 0.02, y, h + 1.0), (bX1 - 0.02, y, h + 1.06), (bX1 - 0.02, ys, hs + 1.06), 'uc_dark')
    sc_.quad((bX1 - 0.02, ys, hs - 0.35), (bX1 - 0.02, y, h - 0.35), (bX1 - 0.02, y, h - 0.05), (bX1 - 0.02, ys, hs - 0.05), 'uc_dark')
    if f < 3:
        LANES.append(dict(kind='landing', lane='B', x0=bX0, x1=bX1, d0=-(y + LND), d1=-y, h=h)); grate(sc_, bX0, bX1, y, y + LND, h); y += LND
# wall brackets every landing + diagonal bracing to the wall (reads as a bolted scaffold)
for Ln in LANES:
    if Ln['kind'] != 'landing': continue
    if Ln['lane'] in ('A', 'C'):
        for xx in (Ln['x0'] + 0.1, Ln['x1'] - 0.1): sc_.box(xx - 0.04, xx + 0.04, -aD1, -aD0, Ln['h'] - 0.5, Ln['h'] - 0.05, 'uc_dark', skip=('+z',))
    else:
        for yy in (-Ln['d1'] + 0.1, -Ln['d0'] - 0.1): sc_.box(bX0, bX1, yy - 0.04, yy + 0.04, Ln['h'] - 0.5, Ln['h'] - 0.05, 'uc_dark', skip=('+z',))
# warm step lights on lane landings
for Ln in LANES:
    if Ln['kind'] == 'landing':
        cx = (Ln['x0'] + Ln['x1']) / 2; cy = -(Ln['d0'] + Ln['d1']) / 2
        sc_.box(cx - 0.3, cx + 0.3, cy - 0.03, cy + 0.03, Ln['h'] + 2.2, Ln['h'] + 2.25, 'uc_emit'); light('scaffold', 'step', cx, cy, Ln['h'] + 2.2, k=0.55, reach=8.0)
finish('scaffold', 'hangar', [sc_])
print('SCAFFOLD riser', round(RIS, 4), 'bottom h', round(h, 3), 'lanes', len(LANES), flush=True)

# ======================= HELPER ROOMS (append, never edit their blend) =======================
HELPER_ROOMS = ['uc_game', 'uc_office', 'uc_guest1', 'uc_guest2', 'uc_guest3', 'uc_guest4']
helper_ok = False; HELP_INFO = {}
if os.path.exists(HELPER):
    with bpy.data.libraries.load(HELPER, link=False) as (src, dst):
        dst.collections = [c for c in src.collections if c in HELPER_ROOMS]
    for c in dst.collections:
        if c is None: continue
        ROOT.children.link(c); t = 0
        for o in list(c.all_objects):
            if o.type == 'MESH':
                # helper meshes share my material set: remap uc_x.001 -> uc_x
                for i, m in enumerate(o.data.materials):
                    if m and m.name.split('.')[0] in MATS: o.data.materials[i] = MATS[m.name.split('.')[0]]
                # bake resolution: split shell faces down to <= 1.2 m edges (props keep their own density)
                if any(o.name.endswith(s) for s in ('_floor', '_walls', '_ceil')):
                    bm = bmesh.new(); bm.from_mesh(o.data)
                    for it in range(5):
                        long_e = [e for e in bm.edges if e.calc_length() > 1.2]
                        if not long_e: break
                        bmesh.ops.subdivide_edges(bm, edges=long_e, cuts=1, use_grid_fill=True)
                    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4]); bm.to_mesh(o.data); bm.free()
                if o.get('collide') == 1 or o.get('collide') == 1.0:
                    bb = [o.matrix_world @ Vector(v) for v in o.bound_box]
                    obs(o.name, min(v.x for v in bb), max(v.x for v in bb), min(v.y for v in bb), max(v.y for v in bb), min(v.z for v in bb), max(v.z for v in bb))
                t += sum(len(p.vertices) - 2 for p in o.data.polygons); ZONES['lower'].append(o)
            elif o.type == 'EMPTY' and o.name.startswith('L_'):
                w = o.matrix_world.translation; kw = {k: (list(o[k]) if hasattr(o[k], '__len__') and not isinstance(o[k], str) else o[k]) for k in o.keys() if k not in ('rgb', 'k', 'reach_m', 'kind')}
                light(c.name[3:], o.get('kind', 'downlight'), w.x, w.y, w.z, k=float(o.get('k', 1.0)), reach=float(o.get('reach_m', 12.0)), **{k: v for k, v in kw.items() if isinstance(v, (int, float, str))})
        ROOMTRIS[c.name[3:]] = t; HELP_INFO[c.name] = t
    helper_ok = len(HELP_INFO) == len(HELPER_ROOMS)
print('HELPER rooms', HELP_INFO, 'ok', helper_ok, flush=True)

# ======================= MANSION ADDITIONS (always loaded with the mansion GLB) =======================
# bay hall + lintel/jambs: ONE material (the mansion's own ah_concrete), light baked into COLOR_0 (dark falloff into the spine)
MADD = coll('UC_mansion_add')
mc = pbr('ah_concrete', f"{TEX}/concrete-color-2k.webp", f"{TEX}/concrete-nrm-2k.webp", f"{TEX}/concrete-orm-2k.webp")
md = pbr('ah_dark', f"{TEX}/dark-color-2k.webp", f"{TEX}/dark-nrm-2k.webp", f"{TEX}/dark-orm-2k.webp")
AMATS = {'ah_concrete': mc, 'ah_dark': md}
def abuild(acc, mat, c=MADD):
    me = bpy.data.meshes.new(acc.name); me.from_pydata([tuple(v) for v in acc.v], [], acc.f); me.update()
    o = bpy.data.objects.new(acc.name, me); c.objects.link(o); me.materials.append(AMATS[mat])
    uv = me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        n = p.normal; ax = max(range(3), key=lambda a: abs(n[a]))
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u_, v_ = (co.x, co.y) if ax == 2 else ((co.y, co.z) if ax == 0 else (co.x, co.z))
            uv.data[li].uv = (u_ / 4.0, v_ / 4.0)
    return o
B = L['bay']; bx0, bx1 = B['X']; bH = B['H'][1]; byB = -B['D'][1]
bay = Acc('uc_bay_hall')
floor_grid(bay, bx0, bx1, byB, 0.0, 0.0, 'c', 1.5)
bay.box(bx0, bx1, -0.15, 0.15, 0.0, 0.02, 'c', skip=('-z',))                  # threshold strip over the deck seam
wall(bay, 'y', bx0, byB, 0.0, 0.0, bH, 1, 'c', (), 1.5); wall(bay, 'y', bx1, byB, 0.0, 0.0, bH, -1, 'c', (), 1.5)
wall(bay, 'x', byB, bx0, bx1, 0.0, bH, 1, 'c', [(c_, w, h) for (_, c_, w, h) in BAYDOORS], 1.0, trim='c')
# ceiling with four recessed light troughs (running east-west)
TR = [-2.2, -5.6, -9.0, -12.2]; tw = 0.5
ys_ = sorted(set([byB, 0.0] + [t - tw / 2 for t in TR] + [t + tw / 2 for t in TR]))
for a, b in zip(ys_[:-1], ys_[1:]):
    if any(abs((a + b) / 2 - t) < tw / 2 for t in TR):
        bay.box(bx0 + 1.0, bx1 - 1.0, a, b, bH, bH + 0.25, 'c', skip=('-z',))      # trough (open below)
        bay.gquad((bx0, a, bH), (bx0, b, bH), (bx0 + 1.0, b, bH), (bx0 + 1.0, a, bH), 'c', cell=1.5); bay.gquad((bx1 - 1.0, a, bH), (bx1 - 1.0, b, bH), (bx1, b, bH), (bx1, a, bH), 'c', cell=1.5)
    else: bay.gquad((bx0, a, bH), (bx0, b, bH), (bx1, b, bH), (bx1, a, bH), 'c', cell=1.5)
for t in TR:
    for i in range(6): light('bay', 'trough', bx0 + 1.0 + (i + 0.5) * (bx1 - bx0 - 2.0) / 6, t, bH + 0.2, k=1.0, reach=16.0, strip_len_m=(bx1 - bx0 - 2.0) / 6)
# lintel + jambs (cover the cut edge of the GLB rock face around the opening)
LIN = dict(x0=bx0 - 1.8, x1=bx1 + 1.8, y0=-0.4, y1=0.8, z0=bH - 0.8, z1=bH + 1.4)
bay.box(LIN['x0'], LIN['x1'], LIN['y0'], LIN['y1'], LIN['z0'], LIN['z1'], 'c', cell=1.5)
for (j0, j1) in ((bx0 - 1.8, bx0), (bx1, bx1 + 1.8)):
    bay.box(j0, j1, LIN['y0'], LIN['y1'], 0.0, LIN['z0'], 'c', skip=('-z',), cell=1.5)
    bay.box(j0 - 0.15, j1 + 0.15, LIN['y0'] - 0.1, LIN['y1'] + 0.1, 0.0, 0.5, 'c', skip=('-z',))     # plinth
for k in range(1, 4):       # shadow-line reveals on the lintel face
    zz = LIN['z0'] + k * (LIN['z1'] - LIN['z0']) / 4; bay.box(LIN['x0'] + 0.3, LIN['x1'] - 0.3, LIN['y1'], LIN['y1'] + 0.04, zz - 0.03, zz + 0.03, 'c', skip=('-y',))
BAYO = abuild(bay, 'ah_concrete')
# hatch: frame (curb) + grating strip with the stair-well opening (ah_dark); lid = two leaves on hinge pivots (separate nodes)
HTOP = GH + 0.35; hx0, hx1 = HATCH['X']; hy0_, hy1_ = -HATCH['D'][1], -HATCH['D'][0]; fy0 = -SHAFT['D'][1]
fr = Acc('uc_hatch_frame'); FW = 1.0; ZB = GH - 0.6
OX0, OX1, OY0, OY1 = sx0 - FW, sx1 + FW, fy0 - FW, hy1_ + FW
for (a0, a1, b0, b1) in ((OX0, OX1, OY0, fy0), (OX0, OX1, hy1_, OY1), (OX0, sx0, fy0, hy1_), (sx1, OX1, fy0, hy1_)):
    fr.box(a0, a1, b0, b1, ZB, HTOP, 'd', skip=('-z',))
WELL = dict(x0=sx1 - 5.26, x1=sx1, y0=fy0, y1=fy0 + SCW)        # grating opening over the scaffold's top landing + first flight
for (a0, a1, b0, b1) in ((sx0, WELL['x0'], fy0, hy0_), (WELL['x0'], sx1, WELL['y1'], hy0_)):
    fr.box(a0, a1, b0, b1, HTOP - 0.1, HTOP, 'd')
    n = int((a1 - a0) / 0.35)
    for i in range(n): xx = a0 + (i + 0.5) * (a1 - a0) / n; fr.box(xx - 0.02, xx + 0.02, b0, b1, HTOP - 0.25, HTOP - 0.1, 'd', skip=('+z',))
for xx in (WELL['x0'], ):       # well guard rail (W end + S side)
    fr.box(xx - 0.03, xx + 0.03, WELL['y0'], WELL['y1'], HTOP, HTOP + 1.05, 'd', skip=('-z',))
fr.box(WELL['x0'], WELL['x1'] - 1.5, WELL['y1'] - 0.03, WELL['y1'] + 0.03, HTOP + 1.0, HTOP + 1.05, 'd')
for xx in (WELL['x0'] + 1.25, WELL['x0'] + 2.5, WELL['x1'] - 1.5): fr.box(xx - 0.03, xx + 0.03, WELL['y1'] - 0.03, WELL['y1'] + 0.03, HTOP, HTOP + 1.0, 'd', skip=('-z',))
FRO = abuild(fr, 'ah_dark')
LID = bpy.data.objects.new('uc_hatch_lid', None); MADD.objects.link(LID); LID.location = ((hx0 + hx1) / 2, (hy0_ + hy1_) / 2, HTOP)
LEAVES = []
for nm, hinge, sgn in (('uc_hatch_leaf_w', hx0, 1), ('uc_hatch_leaf_e', hx1, -1)):
    a = Acc(nm); w = (hx1 - hx0) / 2 - 0.01
    a.box(0.0, sgn * w, hy0_ - (hy0_), hy1_ - hy0_, -0.3, 0.0, 'd')
    for i in range(6):
        yy = (i + 0.5) * (hy1_ - hy0_) / 6; a.box(0.3 * sgn, (w - 0.3) * sgn, yy - 0.08, yy + 0.08, 0.0, 0.04, 'd', skip=('-z',))
    a.box(0.05 * sgn, 0.3 * sgn, 0.2, hy1_ - hy0_ - 0.2, 0.0, 0.08, 'd', skip=('-z',))        # hinge knuckle strip
    o = abuild(a, 'ah_dark'); o.parent = LID; o.location = (hinge - LID.location.x, hy0_ - LID.location.y, 0.0)
    o['dm_hinge'] = 'local Y (mansion D axis); opens by rotating %s about it' % ('-' if sgn > 0 else '+'); LEAVES.append(o)
LID['dm_lid'] = 1
# portal cards: black cards in the bay's back-wall doorways and under the grating well, hidden by the streamer once the undercliff is in
pc = Acc('uc_portal_cards')
for (_, c_, w, h) in BAYDOORS: pc.quad((c_ + w / 2, byB - 0.3, 0.0), (c_ - w / 2, byB - 0.3, 0.0), (c_ - w / 2, byB - 0.3, h), (c_ + w / 2, byB - 0.3, h), 'd')
pc.quad((WELL['x0'], WELL['y0'], HTOP - 0.6), (WELL['x1'], WELL['y0'], HTOP - 0.6), (WELL['x1'], WELL['y1'], HTOP - 0.6), (WELL['x0'], WELL['y1'], HTOP - 0.6), 'd')
PCO = abuild(pc, 'ah_dark')
print('MANSION ADD tris bay', bay.tris(), 'frame', fr.tris(), 'portal', pc.tris(), flush=True)

# ======================= VTOL (render / bake occluder only; the GLB is merged byte-exact at packaging) =======================
VT = dict(x=HXc, y=VY, z=H0)
vcoll = coll('UC_vtol')
try:
    before = set(bpy.data.objects); bpy.ops.import_scene.gltf(filepath='/workspace/jots-t1516/vtol/meadowlark.glb')
    newo = [o for o in bpy.data.objects if o not in before]
    for o in newo:
        for c in list(o.users_collection): c.objects.unlink(o)
        vcoll.objects.link(o)
    roots = [o for o in newo if o.parent is None]
    piv = bpy.data.objects.new('UC_vtol_pivot', None); vcoll.objects.link(piv); piv.location = (VT['x'], VT['y'], VT['z']); piv.rotation_euler = (0, 0, math.pi)
    for o in roots: o.parent = piv
    for o in newo:
        if 'LOD1' in o.name or 'LOD2' in o.name: o.hide_render = True; o.hide_set(True)
    # collision: loose parts of LOD2 that reach below 2 m -> boxes (m-frame)
    bpy.context.view_layer.update()
    l2 = [o for o in newo if o.type == 'MESH' and 'LOD2' in o.name]
    for o in l2:
        bm = bmesh.new(); bm.from_mesh(o.data); bm.transform(o.matrix_world); bm.verts.ensure_lookup_table()
        seen = set(); parts = []
        for v in bm.verts:
            if v.index in seen: continue
            stack = [v]; comp = []
            while stack:
                q = stack.pop()
                if q.index in seen: continue
                seen.add(q.index); comp.append(q.co.copy()); stack.extend(e.other_vert(q) for e in q.link_edges)
            parts.append(comp)
        for i, comp in enumerate(parts):
            zmin = min(p.z for p in comp) - H0
            if zmin > 1.9: continue
            obs('vtol_%d' % i, min(p.x for p in comp), max(p.x for p in comp), min(p.y for p in comp), max(p.y for p in comp), zmin + H0, max(p.z for p in comp))
        bm.free()
    VT['ok'] = True
except Exception as e:
    print('VTOL import failed', e, flush=True); VT['ok'] = False

# ======================= BAKE LIGHTS (Cycles only; the runtime gets the result as COLOR_0) =======================
BL = coll('UC_bake_lights')
def lamp(kind, loc, energy, size=(0.2, 0.2), rot=(0, 0, 0), spot=None, color=(1, 0.85, 0.6)):
    t = 'SPOT' if spot else ('AREA' if kind == 'area' else 'POINT')
    ld = bpy.data.lights.new('bl', t); ld.energy = energy; ld.color = color
    if t == 'AREA': ld.shape = 'RECTANGLE'; ld.size, ld.size_y = size
    elif t == 'SPOT': ld.spot_size = math.radians(spot); ld.spot_blend = 0.55; ld.shadow_soft_size = 0.06
    else: ld.shadow_soft_size = 0.12
    o = bpy.data.objects.new('bl_' + kind, ld); BL.objects.link(o); o.location = loc; o.rotation_euler = rot; return o
for Lt in LIGHTS:
    k = Lt['kind']; p = (Lt['x'], Lt['y'], Lt['z']); ln = float(Lt.get('strip_len_m', 1.0)); ax = Lt.get('ax', 'x')
    if k == 'downlight': lamp('spot', p, 55, spot=105)
    elif k == 'cove':
        sz = (max(0.2, ln - 0.3), 0.05) if ax == 'x' else (0.05, max(0.2, ln - 0.3)); lamp('area', p, 9 * ln, sz, rot=(math.pi, 0, 0))
    elif k in ('linear', 'shelf_strip', 'vanity', 'rock_wash'): lamp('area', p, 10 * max(ln, 0.5), (max(0.2, ln - 0.2), 0.08) if ax == 'x' else (0.08, max(0.2, ln - 0.2)), rot=(0, 0, 0) if k != 'rock_wash' else (math.pi, 0, 0))
    elif k == 'highbay': lamp('area', p, 420, (2.2, 0.5))
    elif k == 'wash': lamp('area', p, 60, (1.2, 0.1), rot=(math.pi, 0, 0))
    elif k == 'trough': lamp('area', p, 26 * ln, (ln - 0.3, 0.3))
    elif k == 'pendant': lamp('point', p, 30)
    elif k == 'step': lamp('point', p, 12)
    else: lamp('point', p, 14)       # floor / desk / bedside lamps
BL.hide_render = False

def bake_vc(objs, world_rgb, world_k, samples, tag):
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = samples
    sc.cycles.max_bounces = 4; sc.cycles.diffuse_bounces = 3; sc.cycles.glossy_bounces = 0; sc.cycles.transmission_bounces = 0
    w = bpy.data.worlds.get('uc_w') or bpy.data.worlds.new('uc_w'); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (*world_rgb, 1); bg.inputs[1].default_value = world_k
    for o in bpy.data.objects: o.select_set(False)
    for o in objs:
        me = o.data
        for a in list(me.color_attributes): me.color_attributes.remove(a)
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER'); me.color_attributes.active_color = ca; me.color_attributes.render_color_index = 0
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    t = time.time()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, target='VERTEX_COLORS', use_clear=True, margin=0)
    print('BAKE', tag, len(objs), 'objs', round(time.time() - t, 1), 's', flush=True)

def vc_post(objs, scale, lo=0.03, hi=1.6, emit_one=True):
    import numpy as np
    for o in objs:
        me = o.data; ca = me.color_attributes['Col']; n = len(me.loops)
        c = np.zeros(n * 4, dtype=np.float32); ca.data.foreach_get('color', c); c = c.reshape(-1, 4)
        vi = np.zeros(n, dtype=np.int64); me.loops.foreach_get('vertex_index', vi)
        nv = len(me.vertices); acc = np.zeros((nv, 3)); cnt = np.zeros(nv)
        np.add.at(acc, vi, c[:, :3]); np.add.at(cnt, vi, 1); avg = acc / np.maximum(cnt, 1)[:, None]
        # one ring of neighbour smoothing over the edge graph (bake noise), weighted 50 %
        ev = np.zeros(len(me.edges) * 2, dtype=np.int64); me.edges.foreach_get('vertices', ev); ev = ev.reshape(-1, 2)
        nb = np.zeros((nv, 3)); nc = np.zeros(nv); np.add.at(nb, ev[:, 0], avg[ev[:, 1]]); np.add.at(nb, ev[:, 1], avg[ev[:, 0]]); np.add.at(nc, ev[:, 0], 1); np.add.at(nc, ev[:, 1], 1)
        sm = 0.5 * avg + 0.5 * nb / np.maximum(nc, 1)[:, None]; sm[nc == 0] = avg[nc == 0]
        v = np.clip(sm[vi] * scale, lo, hi)
        if emit_one:
            mi = np.zeros(len(me.polygons), dtype=np.int64); me.polygons.foreach_get('material_index', mi)
            ls = np.zeros(len(me.polygons), dtype=np.int64); me.polygons.foreach_get('loop_start', ls); lt = np.zeros(len(me.polygons), dtype=np.int64); me.polygons.foreach_get('loop_total', lt)
            em_i = [i for i, m in enumerate(me.materials) if m and m.name.startswith('uc_emit')]
            for pi in np.nonzero(np.isin(mi, em_i))[0]: v[ls[pi]:ls[pi] + lt[pi]] = 1.0
        out = np.ones((n, 4), dtype=np.float32); out[:, :3] = v; ca.data.foreach_set('color', out.ravel())

def floor_median(objs, z_of_floor=None):
    import numpy as np
    vals = []
    for o in objs:
        if not o.name.endswith('_floor'): continue
        me = o.data; ca = me.color_attributes['Col']; c = np.zeros(len(me.loops) * 4, dtype=np.float32); ca.data.foreach_get('color', c); vals.append(c.reshape(-1, 4)[:, :3].mean(axis=1))
    return float(np.median(np.concatenate(vals))) if vals else 1.0

INTERIOR = [o for z in ZONES.values() for o in z]
STATS = {}
if BAKE:
    BAYO.hide_render = True; FRO.hide_render = False; PCO.hide_render = True
    for o in LEAVES: o.hide_render = False
    bake_vc(INTERIOR, (0, 0, 0), 0.0, int(os.environ.get('UC_SAMPLES', '48')), 'interior')
    med = floor_median(INTERIOR); s_int = 0.8 / max(med, 1e-4); STATS['bake_interior_floor_median'] = med; STATS['bake_interior_scale'] = s_int
    vc_post(INTERIOR, s_int)
    # bay hall: sky from the sea through the mouth + the four ceiling troughs; normalised so the mouth floor = 1.0 (the deck's own COLOR_0 level, matched at packaging)
    BAYO.hide_render = False
    for o in INTERIOR: o.hide_render = False
    for o in BL.objects: o.hide_render = not o.name.startswith('bl_area') or True
    for o in BL.objects:
        if o.data.type == 'AREA' and abs(o.location.z - (bH + 0.2)) < 0.05 and o.location.y > byB: o.hide_render = False
    bake_vc([BAYO], (0.75, 0.8, 0.9), 1.0, 32, 'bay')
    import numpy as np
    me = BAYO.data; ca = me.color_attributes['Col']; c = np.zeros(len(me.loops) * 4, dtype=np.float32); ca.data.foreach_get('color', c); c = c.reshape(-1, 4)
    vi = np.zeros(len(me.loops), dtype=np.int64); me.loops.foreach_get('vertex_index', vi); co = np.array([me.vertices[i].co[:] for i in range(len(me.vertices))])
    mouth = (np.abs(co[vi][:, 2]) < 0.05) & (co[vi][:, 1] > -1.5) & (co[vi][:, 1] < -0.3)
    m0 = float(np.median(c[mouth, :3].mean(axis=1))) if mouth.any() else 1.0; STATS['bake_bay_mouth'] = m0
    vc_post([BAYO], 1.0 / max(m0, 1e-4), lo=0.06, hi=2.2, emit_one=False)
    for o in BL.objects: o.hide_render = False
    PCO.hide_render = False
    pcm = PCO.data; ca = pcm.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER'); ca.data.foreach_set('color', [0.0, 0.0, 0.0, 1.0] * len(pcm.loops))
    for o in [FRO] + LEAVES:   # frame / lid: outdoor, lit by the world: neutral COLOR_0
        me = o.data; ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER'); ca.data.foreach_set('color', [0.85, 0.85, 0.85, 1.0] * len(me.loops))
print('BAKE done', round(time.time() - T0, 1), 's', flush=True)

# ======================= SAVE the render scene, then EXPORT =======================
def tri_count(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
for k in list(ROOMTRIS):
    c = bpy.data.collections.get('uc_' + k)
    if c: ROOMTRIS[k] = sum(tri_count(o) for o in c.all_objects if o.type == 'MESH')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(UCD, 'p2-undercliff.blend'), compress=True)
print('SAVED blend', flush=True)

MU = __import__('mathutils').Matrix.Translation((0, Y0U, FU)) @ __import__('mathutils').Matrix.Diagonal((U, U, U, 1))
def export_set(objs, fname, join_name=None):
    for o in bpy.data.objects: o.select_set(False)
    dup = []
    for o in objs:
        d = o.copy(); d.data = o.data.copy(); sc.collection.objects.link(d); d.parent = None; d.matrix_world = o.matrix_world.copy(); dup.append(d)
    if join_name and len(dup) > 1:
        for d in dup: d.select_set(True)
        bpy.context.view_layer.objects.active = dup[0]; bpy.ops.object.join(); dup = [bpy.context.view_layer.objects.active]
    for d in dup:
        d.data.transform(MU @ d.matrix_world); d.matrix_world = __import__('mathutils').Matrix.Identity(4)
        if join_name: d.name = join_name; d.data.name = join_name
        d.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, fname), export_format='GLB', use_selection=True, export_image_format='NONE', export_materials='EXPORT',
                              export_vertex_color='ACTIVE', export_yup=True, export_apply=False, export_extras=True, export_animations=False, export_normals=True, export_texcoords=True)
    tris = sum(tri_count(d) for d in dup)
    for d in dup: bpy.data.objects.remove(d, do_unlink=True)
    return tris
def strip_unused_mats(o):
    used = set(p.material_index for p in o.data.polygons)
    return used
ZT = {}
for zn, objs in ZONES.items():
    ZT[zn] = export_set(objs, 'uc-zone-%s.glb' % zn, 'uc_zone_' + zn)
ZT['bay_hall'] = export_set([BAYO], 'uc-add-bay.glb', 'uc_bay_hall')
ZT['hatch_frame'] = export_set([FRO], 'uc-add-frame.glb', 'uc_hatch_frame')
ZT['portal_cards'] = export_set([PCO], 'uc-add-portal.glb', 'uc_portal_cards')
# lid: keep the hierarchy (pivots), so export the empty + leaves with their transforms in the u frame
for o in bpy.data.objects: o.select_set(False)
lidd = LID.copy(); sc.collection.objects.link(lidd); lidd.parent = None; lidd.matrix_world = MU @ LID.matrix_world; lidd.scale = (1, 1, 1); lidd.location = MU @ LID.location
for o in LEAVES:
    d = o.copy(); d.data = o.data.copy(); sc.collection.objects.link(d); d.data.transform(__import__('mathutils').Matrix.Diagonal((U, U, U, 1)))
    d.parent = lidd; d.matrix_parent_inverse = __import__('mathutils').Matrix.Identity(4); d.location = Vector(o.location) * U; d.name = o.name; d.data.name = o.name; d.select_set(True)
lidd.name = 'uc_hatch_lid'; lidd.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'uc-add-lid.glb'), export_format='GLB', use_selection=True, export_image_format='NONE', export_materials='EXPORT',
                          export_vertex_color='ACTIVE', export_yup=True, export_extras=True, export_animations=False)
ZT['hatch_lid'] = sum(tri_count(o) for o in LEAVES)

rep = dict(rooms=ROOMTRIS, zones=ZT, interior_total=sum(ZT[z] for z in ('lower', 'stair', 'hangar')), helper=dict(integrated=helper_ok, rooms=HELP_INFO, file=HELPER),
           obs=OBS, lights=LIGHTS, lanes=LANES, stair=STAIR_RUNS, doors=DOORS, baydoors=BAYDOORS, well=WELL, vtol=VT, lintel=LIN,
           consts=dict(U=U, Y0U=Y0U, FU=FU, G=G, GH=GH, HTOP=HTOP, H0=H0, H1=H1, SCW=SCW, RIS=RIS, NR=NR, NF=NF, stair_bottom_x=xb, frame=[OX0, OX1, OY0, OY1], hatch=[hx0, hx1, hy0_, hy1_], shaft=[sx0, sx1, fy0, hy1_]),
           layout=dict(L=L, ST=ST, HG=HG, HATCH=HATCH, SHAFT=SHAFT), stats=STATS, secs=round(time.time() - T0, 1))
json.dump(rep, open(os.path.join(OUT, 'p2-build.json'), 'w'), indent=1)
print('DONE', json.dumps(dict(rooms=ROOMTRIS, zones=ZT, total=rep['interior_total'])), flush=True)
