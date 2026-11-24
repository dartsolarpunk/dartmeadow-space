# t1583u P1 undercliff BLOCKOUT + plan renders.  Run:
#   UC_VIEWS=1,2,3,4,5 blender-4.2 -b /workspace/scratch/cliff-render/cliff-preview.blend -P p1_build.py
# Base blend = mansion GLB + shards.json + 2K cliff maps; those assets are byte-identical to main 969ae0c.
# Frame: mansion Blender frame, x east (along the wall), y seaward, z up, units u (1.78 u = 1 m).
import bpy, bmesh, json, math, os
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

OUT = "/workspace/jots-t1516/cliff-renders"
UCD = "/workspace/jots-t1516/undercliff"
TOOLS = os.path.join(UCD, "tools")
VIEWS = os.environ.get("UC_VIEWS", "1,2,3,4,5").split(",")
PREVIEW = os.environ.get("UC_PREVIEW", "") == "1"
RES = (800, 450) if PREVIEW else (1600, 900)
SAMPLES = 8 if PREVIEW else 20
U = 1.78
# reuse the v347 render set's scene prep (2K rock PBR materials, ground patch, water)
exec(open('/workspace/scratch/cliff-render/ship_renders_v347.py').read().split("# cameras over the bay")[0].replace('OUT = ', 'OUT0 = '))
VIEWS = os.environ.get("UC_VIEWS", "1,2,3,4,5").split(",")
PREVIEW = os.environ.get("UC_PREVIEW", "") == "1"
RES = (800, 450) if PREVIEW else (1600, 900)
SAMPLES = 8 if PREVIEW else 20
sc = bpy.context.scene
MAN = bpy.data.objects['Mansion_LOD0_mesh']
SHARDS = [o for o in bpy.data.objects if o.name.startswith('Mansion_Shards')]
dg = bpy.context.evaluated_depsgraph_get()
BV = BVHTree.FromObject(MAN, dg)   # MAN.matrix_world is identity (checked)
def ray(p, d, far=1000): return BV.ray_cast(Vector(p), Vector(d).normalized(), far)

# ---- measured anchors ----
_fs = []
for _p in ((-40, 30), (40, 40), (-50, 50), (20, 55), (-20, 20), (45, 25), (0, 8), (-30, 8)):
    _h = ray((_p[0], _p[1], -8), (0, 0, -1)); _fs.append(round(_h[0].z, 2) if _h[0] else None)
print("DECK samples", _fs, flush=True)
_ok = sorted(z for z in _fs if z is not None); F = _ok[len(_ok) // 2]    # lower pool deck floor (median) = -18.2
Y0 = -2.9                                                                # deck back wall (ray-measured, x -40..60)
def H_of(z): return (z - F) / U
def P(X, D, H): return Vector((X * U, Y0 - D * U, F + H * U))
print("ANCHOR deck floor z", F, flush=True)

# ---- layout (metres; X east from bay centre, D depth into the cliff from the deck back wall, H up from the deck floor) ----
L = {}
L['bay'] = dict(X=(-32.6, 32.6), D=(0, 14), H=(0, 7.0), name="CARGO BAY", kind="bay")
L['spine'] = dict(X=(-2, 2), D=(14, 52), H=(0, 3.8), name="SPINE CORRIDOR", kind="corr")
L['living'] = dict(X=(2, 18), D=(14, 28), H=(0, 3.8), name="LIVING", kind="living")
L['office'] = dict(X=(2, 10), D=(31, 38), H=(0, 3.6), name="OFFICE", kind="office")
L['game'] = dict(X=(2, 16), D=(40, 52), H=(0, 3.8), name="GAME ROOM", kind="game")
L['kitchen'] = dict(X=(-16, -2), D=(14, 28), H=(0, 3.8), name="MASTER KITCHEN + DINING", kind="kitchen")
L['workshop'] = dict(X=(-32.6, -16), D=(14, 28), H=(0, 4.5), name="WORKSHOP / GARAGE", kind="workshop")
L['gcorr'] = dict(X=(-30, -2), D=(28, 31), H=(0, 3.5), name="GUEST CORRIDOR", kind="corr")
for i in range(4):
    x0 = -26 + 6 * i
    L['guest%d' % (i + 1)] = dict(X=(x0, x0 + 6), D=(31, 37.5), H=(0, 3.5), name="GUEST %d" % (i + 1), kind="guest")
ST = dict(D=(28, 31), x_top=-30.0, drop=12.0, flights=4, risers=17, tread=0.26, landing=1.2)
ST['riser'] = ST['drop'] / (ST['flights'] * ST['risers'])
ST['run'] = ST['flights'] * (ST['risers'] - 1) * ST['tread'] + (ST['flights'] - 1) * ST['landing']
ST['x_bot'] = ST['x_top'] - ST['run']
HG = dict(X=(ST['x_bot'] - 30.0, ST['x_bot']), D=(7, 47), H=(-ST['drop'], -ST['drop'] + 18.0))
HX = sum(HG['X']) / 2
HATCH = dict(X=(HX - 9.0, HX + 9.0), D=(23, 45))        # 18 m (X) x 22 m (D) clear
SHAFT = dict(X=HATCH['X'], D=(23, 47))                  # + 2 m scaffold strip behind the hatch
VTOL = dict(L=15.0, W=12.0, Ht=5.0, X=HX, D=sum(HATCH['D']) / 2)
print("LAYOUT stairs", ST, "hangar", HG, "hatch", HATCH, flush=True)

# ---- materials ----
def flat(name, rgb, emit=0.18, rough=0.8):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    o = nt.nodes.new("ShaderNodeOutputMaterial"); b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough
    b.inputs["Emission Color"].default_value = (*rgb, 1); b.inputs["Emission Strength"].default_value = emit
    nt.links.new(b.outputs[0], o.inputs[0]); m.diffuse_color = (*rgb, 1); return m
C = dict(bay=(0.95, 0.5, 0.12), living=(0.3, 0.72, 0.32), game=(0.58, 0.36, 0.86), workshop=(0.5, 0.55, 0.64),
         office=(0.25, 0.55, 0.92), kitchen=(0.96, 0.8, 0.2), guest=(0.95, 0.45, 0.62), corr=(0.86, 0.86, 0.8),
         stairs=(0.9, 0.25, 0.2), hangar=(0.2, 0.7, 0.75), shaft=(0.15, 0.45, 0.5), scaffold=(1.0, 0.82, 0.0),
         vtol=(0.92, 0.92, 0.96), nose=(0.9, 0.1, 0.1), door=(0.85, 0.1, 0.1), poche=(0.035, 0.03, 0.028),
         line=(0.05, 0.05, 0.05), deckline=(0.1, 0.35, 0.8), text=(0.02, 0.02, 0.02), textw=(1, 1, 1), backdrop=(0.62, 0.64, 0.66))
M = {k: flat("uc_" + k, v, 0.0 if k in ('poche', 'line', 'text') else (3.0 if k == 'textw' else 0.18)) for k, v in C.items()}

col = bpy.data.collections.new("UC_P1_Blockout"); sc.collection.children.link(col)
lab = bpy.data.collections.new("UC_P1_PlanLabels"); sc.collection.children.link(lab)
def mk_mesh(name, verts, faces, mat, coll=col):
    me = bpy.data.meshes.new(name); me.from_pydata([tuple(v) for v in verts], [], faces); me.update()
    o = bpy.data.objects.new(name, me); coll.objects.link(o); me.materials.append(mat); return o
BOXF = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
def box_u(name, x0, x1, y0, y1, z0, z1, mat, coll=col):
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1)); z0, z1 = sorted((z0, z1))
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    return mk_mesh(name, v, BOXF, mat, coll)
def box_m(name, X, D, H, mat, coll=col):
    a = P(X[0], D[0], H[0]); b = P(X[1], D[1], H[1])
    return box_u(name, a.x, b.x, a.y, b.y, a.z, b.z, mat, coll)
VOL = {}
def room(key):
    r = L[key]; g = 0.12
    o = box_m("UC_" + key, (r['X'][0] + g, r['X'][1] - g), (r['D'][0] + g, r['D'][1] - g), r['H'], M[r['kind']])
    VOL[key] = (r['X'], r['D'], r['H']); return o
B = L['bay']; t = 0.4; VOL['bay'] = (B['X'], B['D'], B['H'])
box_m("UC_bay_floor", B['X'], B['D'], (-t, 0), M['bay'])
box_m("UC_bay_ceiling", B['X'], B['D'], (B['H'][1], B['H'][1] + t), M['bay'])
box_m("UC_bay_backwall", B['X'], (B['D'][1], B['D'][1] + t), B['H'], M['bay'])
box_m("UC_bay_wallW", (B['X'][0] - t, B['X'][0]), B['D'], B['H'], M['bay'])
box_m("UC_bay_wallE", (B['X'][1], B['X'][1] + t), B['D'], B['H'], M['bay'])
for k in ('spine', 'living', 'office', 'game', 'kitchen', 'workshop', 'gcorr', 'guest1', 'guest2', 'guest3', 'guest4'):
    room(k)
for nm, X, w, h in (("spine", 0, 4, 3.2), ("workshop", -24.3, 8, 4.2), ("living", 10, 3, 2.6), ("kitchen", -9, 3, 2.6)):
    box_m("UC_baydoor_" + nm, (X - w / 2, X + w / 2), (B['D'][1] - 0.15, B['D'][1] + 0.05), (0, h), M['door'] if nm == 'workshop' else M['corr'])
box_m("UC_hangar_door", (ST['x_top'] - 0.3, ST['x_top']), ST['D'], (0, 3.0), M['door'])
# stairs: real steps + landings
riser, tread = ST['riser'], ST['tread']
x = ST['x_top']; h = 0.0; n_steps = 0; landings = []
for f in range(ST['flights']):
    for k in range(ST['risers']):
        h -= riser
        if k < ST['risers'] - 1:
            box_m("UC_step_%d_%02d" % (f, k), (x - tread, x), ST['D'], (h - 0.25, h), M['stairs']); x -= tread
        elif f < ST['flights'] - 1:
            box_m("UC_landing_%d" % f, (x - ST['landing'], x), ST['D'], (h - 0.25, h), M['stairs']); landings.append((round(x, 2), round(h, 2))); x -= ST['landing']
        n_steps += 1
print("STAIRS risers", n_steps, "riser", round(riser, 4), "run", round(ST['run'], 2), "end x", round(x, 2), "end h", round(h, 2), flush=True)
VOL['stairs'] = ((ST['x_bot'], ST['x_top']), ST['D'], (-ST['drop'], 3.0))
box_m("UC_stair_ceiling", (ST['x_bot'], ST['x_top']), ST['D'], (3.0, 3.3), M['corr'])
# hangar shell
t = 0.6
X0, X1 = HG['X']; D0, D1 = HG['D']; H0, H1 = HG['H']; VOL['hangar'] = (HG['X'], HG['D'], HG['H'])
box_m("UC_hangar_floor", HG['X'], HG['D'], (H0 - t, H0), M['hangar'])
for nm, X, D in (("S", (X0, X1), (D0 - t, D0)), ("N", (X0, X1), (D1, D1 + t)), ("W", (X0 - t, X0), (D0, D1)), ("E", (X1, X1 + t), (D0, D1))):
    box_m("UC_hangar_wall" + nm, X, D, (H0, H1), M['hangar'])
sx0, sx1 = SHAFT['X']; sd0, sd1 = SHAFT['D']
for nm, X, D in (("a", (X0, X1), (D0, sd0)), ("b", (X0, sx0), (sd0, D1)), ("c", (sx1, X1), (sd0, D1))):
    box_m("UC_hangar_ceil_" + nm, X, D, (H1, H1 + t), M['hangar'])
if sd1 < D1: box_m("UC_hangar_ceil_d", (sx0, sx1), (sd1, D1), (H1, H1 + t), M['hangar'])
gz = []
for X in (HATCH['X'][0], HX, HATCH['X'][1]):
    for D in (SHAFT['D'][0], sum(SHAFT['D']) / 2, SHAFT['D'][1]):
        p = P(X, D, 0); hh = ray((p.x, p.y, 60), (0, 0, -1)); gz.append(hh[0].z if hh[0] else None)
GZ = max(z for z in gz if z is not None); GH = H_of(GZ)
print("HATCH ground z samples", [round(z, 2) for z in gz], "use", round(GZ, 2), "H", round(GH, 2), flush=True)
VOL['shaft'] = (SHAFT['X'], SHAFT['D'], (H1, GH))
for nm, X, D in (("S", (sx0, sx1), (sd0 - t, sd0)), ("N", (sx0, sx1), (sd1, sd1 + t)), ("W", (sx0 - t, sx0), (sd0, sd1)), ("E", (sx1, sx1 + t), (sd0, sd1))):
    box_m("UC_shaft_wall" + nm, X, D, (H1, GH + 0.3), M['shaft'])
fr = 1.0
for nm, X, D in (("S", (sx0 - fr, sx1 + fr), (sd0 - fr, sd0)), ("N", (sx0 - fr, sx1 + fr), (sd1, sd1 + fr)),
                 ("W", (sx0 - fr, sx0), (sd0, sd1)), ("E", (sx1, sx1 + fr), (sd0, sd1))):
    box_m("UC_hatch_frame" + nm, X, D, (GH, GH + 0.5), M['shaft'])
box_m("UC_scaffold_grating", (sx0, sx1), (HATCH['D'][1], sd1), (GH + 0.35, GH + 0.45), M['scaffold'])
def leaf(nm, hinge_X, sign, ang):
    w = 9.0 * U; l = (HATCH['D'][1] - HATCH['D'][0]) * U; th = 0.5 * U
    v = [(0, 0, 0), (sign * w, 0, 0), (sign * w, -l, 0), (0, -l, 0), (0, 0, th), (sign * w, 0, th), (sign * w, -l, th), (0, -l, th)]
    o = mk_mesh("UC_hatch_leaf" + nm, v, BOXF, M['shaft'])
    o.location = P(hinge_X, HATCH['D'][0], GH + 0.5); o.rotation_euler = (0, -sign * math.radians(ang), 0); return o
LEAVES = [leaf("W", sx0, 1, 80), leaf("E", sx1, -1, 80)]
# scaffold zig-zag on the back wall of the shaft / hangar (strip behind the hatch)
SC = dict(drop=GH - H0, flights=7, risers=18, tread=0.26, landing=1.5, width=1.4)
SC['riser'] = SC['drop'] / (SC['flights'] * SC['risers'])
SC['flen'] = (SC['risers'] - 1) * SC['tread']
sd_a, sd_b = sd1 - SC['width'] - 0.1, sd1 - 0.1
xa = HX - (SC['flen'] / 2 + SC['landing']); xb = HX + SC['flen'] / 2
hh = GH
box_m("UC_scaf_top_landing", (xa, xa + SC['landing']), (sd_a, sd_b), (hh - 0.08, hh), M['scaffold'])
for f in range(SC['flights']):
    direction = 1 if f % 2 == 0 else -1
    xs = xa + SC['landing'] if direction > 0 else xb
    for k in range(SC['risers']):
        hh -= SC['riser']
        if k < SC['risers'] - 1:
            x0 = xs + k * SC['tread'] if direction > 0 else xs - (k + 1) * SC['tread']
            box_m("UC_scaf_%d_%02d" % (f, k), (x0, x0 + SC['tread']), (sd_a, sd_b), (hh - 0.06, hh), M['scaffold'])
    lx = (xb, xb + SC['landing']) if direction > 0 else (xa, xa + SC['landing'])
    box_m("UC_scaf_landing_%d" % f, lx, (sd_a, sd_b), (hh - 0.08, hh), M['scaffold'])
    for px in lx:
        box_m("UC_scaf_post_%d_%d" % (f, int(px * 10)), (px - 0.06, px + 0.06), (sd_a - 0.06, sd_a + 0.06), (hh, hh + 1.1), M['scaffold'])
print("SCAFFOLD", {k: round(v, 3) for k, v in SC.items()}, "bottom h", round(hh, 3), flush=True)
box_m("UC_VTOL", (VTOL['X'] - VTOL['W'] / 2, VTOL['X'] + VTOL['W'] / 2), (VTOL['D'] - VTOL['L'] / 2, VTOL['D'] + VTOL['L'] / 2), (H0, H0 + VTOL['Ht']), M['vtol'])
box_m("UC_VTOL_nose", (VTOL['X'] - 2, VTOL['X'] + 2), (VTOL['D'] - VTOL['L'] / 2, VTOL['D'] - VTOL['L'] / 2 + 3), (H0 + VTOL['Ht'], H0 + VTOL['Ht'] + 0.6), M['nose'])
for i, (X, D) in enumerate(((HX - 8, 15), (HX + 8, 15), (HX - 8, 37), (HX + 8, 37))):
    ld = bpy.data.lights.new("UC_hlight%d" % i, 'AREA'); ld.energy = 1500; ld.size = 6 * U; ld.color = (0.85, 0.92, 1.0)
    lo = bpy.data.objects.new("UC_hlight%d" % i, ld); col.objects.link(lo); lo.location = P(X, D, H1 - 0.5)
for i, X in enumerate((-22, 0, 22)):
    ld = bpy.data.lights.new("UC_baylight%d" % i, 'AREA'); ld.energy = 5000; ld.size = 8 * U; ld.color = (1.0, 0.85, 0.65)
    lo = bpy.data.objects.new("UC_baylight%d" % i, ld); col.objects.link(lo); lo.location = P(X, 7, B['H'][1] - 0.3)

# ---- bay opening in the mansion's deck back wall (full width, 7 m) + clear the GLB rock inside the bay volume ----
me = MAN.data; bm = bmesh.new(); bm.from_mesh(me)
bx0, bx1 = P(B['X'][0], 0, 0).x, P(B['X'][1], 0, 0).x; bz0, bz1 = F + 0.02, P(0, 0, B['H'][1]).z
for co, no in (((bx0, 0, 0), (1, 0, 0)), ((bx1, 0, 0), (1, 0, 0)), ((0, 0, bz0), (0, 0, 1)), ((0, 0, bz1), (0, 0, 1))):
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-4, plane_co=co, plane_no=no)
by_in = P(0, B['D'][1], 0).y
kill = [f for f in bm.faces if bx0 < f.calc_center_median().x < bx1 and bz0 < f.calc_center_median().z < bz1 and by_in - 0.5 < f.calc_center_median().y < 0.5]
mats = [m.name for m in me.materials]; km = {}
for f in kill: km[mats[f.material_index]] = km.get(mats[f.material_index], 0) + 1
bmesh.ops.delete(bm, geom=kill, context='FACES'); bm.to_mesh(me); me.update(); bm.free()
BAYCUT = dict(faces=len(kill), by_material=km)
print("BAY OPENING removed faces", len(kill), km, flush=True)
# ---- hatch hole in the plateau surface ----
bm = bmesh.new(); bm.from_mesh(me)
hx0_, hx1_ = sorted((P(SHAFT['X'][0], 0, 0).x, P(SHAFT['X'][1], 0, 0).x)); hy0_, hy1_ = sorted((P(0, SHAFT['D'][0], 0).y, P(0, SHAFT['D'][1], 0).y))
for co, no in (((hx0_, 0, 0), (1, 0, 0)), ((hx1_, 0, 0), (1, 0, 0)), ((0, hy0_, 0), (0, 1, 0)), ((0, hy1_, 0), (0, 1, 0))):
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-4, plane_co=co, plane_no=no)
kill = [f for f in bm.faces if hx0_ < f.calc_center_median().x < hx1_ and hy0_ < f.calc_center_median().y < hy1_ and -9 < f.calc_center_median().z < 3]
HATCHCUT = len(kill); print("HATCH HOLE removed faces", len(kill), flush=True)
bmesh.ops.delete(bm, geom=kill, context='FACES'); bm.to_mesh(me); me.update(); bm.free()

# ---- back terrain: the real drawn ground (index.html _groundField + F.carve, Solenne seed 475) behind the GLB ----
TJ = json.load(open(os.path.join(TOOLS, 'terrain_back.json')))
verts = []; faces = []; nxs = len(TJ['drawn'][0]); nys = len(TJ['drawn'])
J0 = 8   # rows from y -100 inland only (inside the GLB the drawn ground is carved under the plateau)
nys -= J0
for j in range(nys):
    for i in range(nxs): verts.append((TJ['x0'] + i * 5, TJ['y0'] - (j + J0) * 5, TJ['drawn'][j + J0][i]))
for j in range(nys - 1):
    for i in range(nxs - 1):
        a = j * nxs + i; faces.append((a, a + nxs, a + nxs + 1, a + 1))
gmat = bpy.data.materials.get('solenne_ground')
TERR = mk_mesh("UC_back_terrain_drawn", verts, faces, gmat or M['backdrop'], sc.collection)
TERR.data.polygons.foreach_set("use_smooth", [True] * len(TERR.data.polygons))

# ---- checks ----
BVT = BVHTree.FromPolygons(verts, faces)
bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get()
BVS = [BVHTree.FromObject(o, dg) for o in SHARDS]
BVM = BVHTree.FromObject(MAN, dg)
def vol_bvh(X, D, H, shrink=0.05):
    a = P(X[0] + shrink, D[0] + shrink, H[0] + shrink); b = P(X[1] - shrink, D[1] - shrink, H[1] - shrink)
    x0, x1 = sorted((a.x, b.x)); y0, y1 = sorted((a.y, b.y)); z0, z1 = sorted((a.z, b.z))
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    return BVHTree.FromPolygons(v, BOXF), (x0, x1, y0, y1, z0, z1)
report = {}
for k, (X, D, H) in VOL.items():
    D2 = (max(D[0], 0.4), D[1]) if k == 'bay' else D
    bv, bb = vol_bvh(X, D2, H)
    hits_m = len(bv.overlap(BVM)); hits_t = len(bv.overlap(BVT)); hits_s = sum(len(bv.overlap(s)) for s in BVS)
    inside = sum(1 for p in MAN.data.polygons if bb[0] < p.center.x < bb[1] and bb[2] < p.center.y < bb[3] and bb[4] < p.center.z < bb[5])
    cov = None
    for fx in (0.05, 0.5, 0.95):
        for fd in (0.05, 0.5, 0.95):
            p = P(X[0] + fx * (X[1] - X[0]), D[0] + fd * (D[1] - D[0]), H[1])
            for T in (BVM, BVT):
                hh_ = T.ray_cast(p, Vector((0, 0, 1)), 500)
                if hh_[0] is not None: cov = (hh_[0].z - p.z) / U if cov is None else min(cov, (hh_[0].z - p.z) / U)
    side = {}
    cx, cd, ch = sum(X) / 2, sum(D) / 2, H[0] + 0.5 * (H[1] - H[0])
    for nm, p, dv in (("sea", P(cx, D[0], ch), (0, 1, 0)), ("back", P(cx, D[1], ch), (0, -1, 0)), ("west", P(X[0], cd, ch), (-1, 0, 0)), ("east", P(X[1], cd, ch), (1, 0, 0))):
        hs = [T.ray_cast(p, Vector(dv), 800) for T in (BVM, BVT)]; ds = [x_[3] / U for x_ in hs if x_[0] is not None]
        side[nm] = round(min(ds), 1) if ds else None
    report[k] = dict(rock_to_first_surface_m=side, mansion_tri_overlaps=hits_m, terrain_overlaps=hits_t, shard_overlaps=hits_s,
                     mansion_faces_inside=inside, min_cover_above_m=None if cov is None else round(cov, 2))
    print("CHECK", k, report[k], flush=True)
lamps = json.load(open('/workspace/jots-cliffs/assets/ariel-home/ariel-home-lamps.json'))['lamps']
hx0, hx1 = sorted((P(sx0, 0, 0).x, P(sx1, 0, 0).x)); hy0, hy1 = sorted((P(0, sd0, 0).y, P(0, sd1, 0).y))
lc = min(math.hypot(max(hx0 - l[0], 0, l[0] - hx1), max(hy0 - l[1], 0, l[1] - hy1)) for l in lamps) / U
wing_gap = (hx1 - -84.72) if hx1 < -84.72 else None
report['hatch'] = dict(ground_z_samples_u=[round(z, 2) for z in gz], ground_relief_m=round((max(gz) - min(gz)) / U, 2), nearest_lamp_m=round(lc, 2),
                       rect_u=[round(hx0, 1), round(hx1, 1), round(hy0, 1), round(hy1, 1)], gap_to_workshop_wing_m=round(abs(-84.72 - hx1) / U, 2))
report['bay_cut'] = BAYCUT; report['hatch_hole_faces'] = HATCHCUT
print("CHECK hatch", report['hatch'], flush=True)
os.makedirs(UCD, exist_ok=True)
json.dump(dict(F=F, Y0=Y0, U=U, L=L, ST=ST, HG=HG, HATCH=HATCH, SHAFT=SHAFT, VTOL=VTOL, SC=SC, GZ=GZ, GH=GH, landings=landings, report=report),
          open(os.path.join(UCD, "p1-layout.json"), "w"), indent=1)

# ---- plan outlines (existing top level, lower deck, pools) + plan labels ----
def outline(name, pts, z, w, mat, closed=True):
    vs = []; fs = []; n = len(pts) if closed else len(pts) - 1
    for i in range(n):
        a = Vector((*pts[i], z)); b = Vector((*pts[(i + 1) % len(pts)], z)); d = (b - a).normalized(); nrm = Vector((-d.y, d.x, 0)) * w / 2
        k = len(vs); vs += [a - nrm, b - nrm, b + nrm, a + nrm]; fs.append((k, k + 1, k + 2, k + 3))
    return mk_mesh(name, vs, fs, mat, lab)
ZL = 40.0
def rect(x0, y0, x1, y1): return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
outline("UCL_hall", rect(-67.95, -39.48, 70.55, -2.5), ZL, 0.5, M['line'])
outline("UCL_wing", rect(-84.72, -92.52, 6.72, -68.95), ZL, 0.5, M['line'])
outline("UCL_prow", [(-32.86, -2.5), (32.86, -2.5), (13.99, 50.29), (0.0, 74.42), (-13.99, 50.29)], ZL, 0.4, M['line'])
outline("UCL_homedeck", rect(-81.0, -2.85, -29.2, 13.1), ZL, 0.4, M['line'])
outline("UCL_lowerdeck", [(-58, -2.9), (60, -2.9), (58, 30), (60, 44), (38, 62), (0, 74), (-50, 62), (-62, 44), (-56, 30)], ZL - 1, 0.6, M['deckline'])
outline("UCL_lowerpool", rect(-31.2, 26.0, 26.0, 46.8), ZL - 1, 0.6, M['deckline'])
outline("UCL_upperpool", rect(46.8, 7.8, 76.7, 31.2), ZL, 0.4, M['line'])
outline("UCL_plateau_edge", [(-200, -106), (200, -106)], ZL, 0.8, M['nose'], closed=False)
outline("UCL_hatch", rect(hx0, P(0, HATCH['D'][0], 0).y, hx1, P(0, HATCH['D'][1], 0).y), ZL - 0.5, 0.6, M['nose'])
outline("UCL_scale", [(60, -80), (60 + 10 * U, -80)], ZL, 0.8, M['line'], closed=False)
def text(name, body, loc, size, mat, rot=(0, 0, 0), coll=lab, align='CENTER'):
    cu = bpy.data.curves.new(name, 'FONT'); cu.body = body; cu.size = size; cu.align_x = align; cu.align_y = 'CENTER'
    o = bpy.data.objects.new(name, cu); coll.objects.link(o); o.location = loc; o.rotation_euler = rot
    cu.materials.append(mat); o.visible_shadow = False; return o
def fm(v): return ("%.1f" % v).replace("-0.0", "0.0")
for k, r in L.items():
    if k == 'bay': continue
    w = r['X'][1] - r['X'][0]; d = r['D'][1] - r['D'][0]; c = P(sum(r['X']) / 2, sum(r['D']) / 2, 0)
    if k == 'spine': text("UCT_" + k, "SPINE 4 m", (c.x, P(0, 46, 0).y, ZL + 1), 1.6, M['text'], rot=(0, 0, math.radians(90))); continue
    if k == 'gcorr': text("UCT_" + k, "GUEST CORRIDOR 3 m", (P(-16, 0, 0).x, c.y, ZL + 1), 1.2, M['text']); continue
    sz = 2.2 if w * d > 100 else 1.5
    nm_ = {'kitchen': "MASTER\nKITCHEN +\nDINING", 'workshop': "WORKSHOP /\nGARAGE"}.get(k, r['name'])
    body = "%s\n%s x %s m\nclg %s m" % (nm_, fm(w), fm(d), fm(r['H'][1]))
    if k in ('kitchen', 'workshop'): sz = 1.6
    if k.startswith('guest'): body = "G%s\n6x6.5" % k[-1]; sz = 1.2
    text("UCT_" + k, body, (c.x, c.y, ZL + 1), sz, M['text'])
c = P(ST['x_top'] - ST['run'] / 2, 29.5, 0)
text("UCT_stairs", "STAIRS DOWN 12 m\n68 x 0.176 m risers", (c.x, P(0, 25.2, 0).y, ZL + 1), 1.3, M['text'])
text("UCT_hdoor", "HANGAR DOOR", (P(ST['x_top'] - 1.0, 0, 0).x, P(0, 32.6, 0).y, ZL + 1), 1.2, M['nose'])
c = P(HX, 14, 0); text("UCT_hangar", "HANGAR  40 x 30 m, 18 m clear\nfloor -12.0 m", (c.x, c.y, ZL + 1), 2.4, M['text'])
c = P(HX, VTOL['D'], 0); text("UCT_vtol", "VTOL 15 x 12 x 5\n(placeholder)\nnose -> sea", (c.x, c.y, ZL + 1.2), 1.7, M['text'])
c = P(HX, HATCH['D'][0] + 1.6, 0); text("UCT_hatch", "SURFACE HATCH 18 x 22 m (red outline)", (c.x, c.y, ZL + 1), 1.3, M['nose'])
c = P(HX, 46, 0); text("UCT_scaf", "scaffold stair, 7 flights, 22.3 m", (c.x, c.y, ZL + 1), 1.2, M['text'])
c = P(0, 7, 0); text("UCT_bay", "CARGO BAY  65.2 m wide x 14 m deep, 7.0 m clear\nopens full width onto the lower pool deck (FL +/-0.0)", (c.x, c.y, ZL + 1), 2.4, M['text'])
text("UCT_upper1", "top-level hall\n(above)", (52, -33, ZL + 1), 1.5, M['line'])
text("UCT_upper2", "top-level workshop wing (above)", (-40, -95.5, ZL + 1), 1.6, M['line'])
text("UCT_deck", "lower pool deck", (0, 58, ZL + 1), 2.2, M['deckline'])
text("UCT_pool", "lower pool", (-2, 36, ZL + 1), 2.0, M['deckline'])
text("UCT_edge", "GLB plateau back edge (ground drops 20-25 m behind)", (10, -110, ZL + 1), 1.6, M['nose'])
text("UCT_sea", "SEA ^", (95, 12, ZL + 1), 3.0, M['deckline'])
text("UCT_scale", "10 m", (60 + 5 * U, -77.5, ZL + 1), 1.6, M['line'])
text("UCT_title", "P1 BLOCKOUT - LOWER LEVEL PLAN  (elevations from the lower pool deck = +/-0.0 m)", (-95, 15, ZL + 1), 1.9, M['line'])
for o in lab.objects: o.hide_render = True; o.hide_viewport = False

# ---- save the blend (blockout state, no per-view cuts) ----
for o in list(bpy.data.objects):
    if o.type == 'CAMERA' and o.name[:2] in ('01', '02', '03', '04'): bpy.data.objects.remove(o, do_unlink=True)
if os.environ.get("UC_NO_SAVE", "") != "1":
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(UCD, "p1-blockout.blend"), compress=True, copy=True)
    print("SAVED blend", flush=True)

# ======================= RENDERS =======================
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = SAMPLES; sc.cycles.use_denoising = True
sc.cycles.denoiser = "OPENIMAGEDENOISE"; sc.cycles.use_adaptive_sampling = True; sc.cycles.adaptive_threshold = 0.05
sc.cycles.max_bounces = 4; sc.cycles.diffuse_bounces = 2; sc.cycles.glossy_bounces = 1
sc.render.resolution_x, sc.render.resolution_y = RES; sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"; sc.render.image_settings.color_mode = "RGB"
BLK = list(col.objects); LABS = list(lab.objects)
SEA = bpy.data.objects.get('SeaPlane'); GSK = bpy.data.objects.get('SolenneGroundSkirt')
CONTEXT = [MAN] + SHARDS + [o for o in (SEA, GSK, TERR) if o]
def look_at(cam, loc, target, up=Vector((0, 0, 1))):
    d = (Vector(target) - Vector(loc)).normalized(); z = -d; x = up.cross(z)
    if x.length < 1e-6: x = Vector((1, 0, 0))
    x.normalize(); y = z.cross(x).normalized(); m = Matrix((x, y, z)).transposed().to_4x4(); m.translation = Vector(loc); cam.matrix_world = m
def camera(name, loc, tgt, lens=24, ortho=None, up=(0, 0, 1)):
    cd = bpy.data.cameras.get(name) or bpy.data.cameras.new(name); c = bpy.data.objects.get(name)
    if c is None: c = bpy.data.objects.new(name, cd); sc.collection.objects.link(c)
    look_at(c, loc, tgt, Vector(up)); cd.lens = lens; cd.clip_start = 0.5; cd.clip_end = 3000
    cd.type = 'ORTHO' if ortho else 'PERSP'
    if ortho: cd.ortho_scale = ortho
    return c
TMP = []
def tmp_text(body, loc, size, mat, cam, align='CENTER'):
    o = text("UCX_%d" % len(TMP), body, Vector(loc), size, mat, coll=sc.collection, align=align)
    o.rotation_euler = cam.matrix_world.to_euler(); TMP.append(o); return o
def cut_copy(o, plane_co, plane_no):
    me2 = o.data.copy(); bm = bmesh.new(); bm.from_mesh(me2); bm.transform(o.matrix_world)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-4, plane_co=plane_co, plane_no=plane_no, clear_outer=True)
    bm.to_mesh(me2); bm.free(); c = bpy.data.objects.new(o.name + "_cut", me2); sc.collection.objects.link(c); TMP.append(c); return c
VOLU = []
for k, (X, D, H) in VOL.items():
    a = P(X[0], D[0], H[0]); b = P(X[1], D[1], H[1]); VOLU.append((min(a.x, b.x), max(a.x, b.x), min(a.y, b.y), max(a.y, b.y), min(a.z, b.z), max(a.z, b.z)))
def solid(p):
    for v in VOLU:
        if v[0] - 0.6 <= p.x <= v[1] + 0.6 and v[2] - 0.6 <= p.y <= v[3] + 0.6 and v[4] - 0.6 <= p.z <= v[5] + 0.6: return False
    if p.y < Y0 - 0.5:                               # inland of the deck wall: inside the rock if the first surface inland is a back face
        hy = BVM.ray_cast(p, Vector((0, -1, 0)), 600)
        if hy[0] is not None: return hy[1].y < -0.2
    best = None
    for T in (BVM, BVT):
        hz = T.ray_cast(p, Vector((0, 0, 1)), 400)
        if hz[0] is not None and (best is None or hz[3] < best[3]): best = hz
    return best is not None and best[1].z > 0.2
def poche(axis, at, lo, hi, zlo, zhi, toward, step=0.4 * U):
    """Section poche (rock cut face) in the plane axis=at, merged row quads, offset toward the camera."""
    vs = []; fs = []; z = zlo
    while z < zhi:
        u = lo; run = None
        while u <= hi + 1e-6:
            pc = Vector((at, u + step / 2, z + step / 2)) if axis == 'x' else Vector((u + step / 2, at, z + step / 2))
            s_ = solid(pc)
            if s_ and run is None: run = u
            if (not s_ or u + step > hi) and run is not None:
                u1 = u if not s_ else u + step; k = len(vs)
                if axis == 'x': vs += [(at + toward, run, z), (at + toward, u1, z), (at + toward, u1, z + step), (at + toward, run, z + step)]
                else: vs += [(run, at + toward, z), (u1, at + toward, z), (u1, at + toward, z + step), (run, at + toward, z + step)]
                fs.append((k, k + 1, k + 2, k + 3)); run = None
            u += step
        z += step
    o = mk_mesh("UC_poche", vs, fs, M['poche'], sc.collection); TMP.append(o); print("POCHE quads", len(fs), flush=True); return o
def show(objs_on):
    on = set(o.name for o in objs_on)
    for o in list(sc.objects):
        if o.type in ('MESH', 'FONT'): o.hide_render = o.name not in on
        elif o.type == 'LIGHT' and o.name.startswith('UC_'): o.hide_render = o.name not in on
def cleanup():
    for o in TMP:
        try: bpy.data.objects.remove(o, do_unlink=True)
        except Exception: pass
    TMP.clear()
def render(cam, fname):
    sc.camera = cam; fp = os.path.join(OUT, fname); sc.render.filepath = fp
    print("RENDERING", fname, flush=True); bpy.ops.render.render(write_still=True); print("WROTE", fp, os.path.getsize(fp), flush=True); return fp
def blk(exclude=()): return [o for o in BLK if not any(o.name.startswith(e) for e in exclude)]
world = sc.world
def bg(strength):
    for n in world.node_tree.nodes:
        if n.type == 'BACKGROUND': n.inputs['Strength'].default_value = strength
def set_emit(v):
    for k, m in M.items():
        if k in ('poche', 'line', 'text'): continue
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED': n.inputs['Emission Strength'].default_value = (3.0 if k == 'textw' else v)
def flatmode(on_):
    sc.view_settings.view_transform = 'Standard' if on_ else 'AgX'; sc.view_settings.look = 'None' if on_ else 'AgX - Base Contrast'
    sc.view_settings.exposure = 0.0 if on_ else 0.15
flatmode(False)

if "1" in VIEWS:   # plan, orthographic top-down, cliff hidden, flat colour
    cx, cy = P(-25, 0, 0).x, P(0, 26, 0).y
    cam = camera("p1-01-plan-top-down", (cx, cy, 300), (cx, cy, 0), ortho=245, up=(0, 1, 0))
    bd = box_u("UC_backdrop", cx - 200, cx + 200, cy - 120, cy + 120, -80, -79, M['backdrop'], sc.collection); TMP.append(bd)
    on = blk(("UC_hangar_ceil", "UC_shaft_wall", "UC_hatch_leaf", "UC_stair_ceiling", "UC_bay_ceiling", "UC_scaffold_grating", "UC_hatch_frame", "UC_hlight", "UC_baylight")) + LABS + [bd]
    for o in LABS:
        o.hide_render = False
        if o.type == 'FONT': o.data.size *= 1.7
    show(on); bg(0.0); set_emit(1.0); flatmode(True)
    hidden = [o for o in sc.objects if o.type == 'LIGHT' and not o.hide_render]
    for o in hidden: o.hide_render = True
    render(cam, "p1-01-plan-top-down.png"); cleanup()
    for o in hidden: o.hide_render = False
    for o in LABS:
        o.hide_render = True
        if o.type == 'FONT': o.data.size /= 1.7
    set_emit(0.18); flatmode(False); bg(0.9)

if "2" in VIEWS:   # two stacked ortho sections, composited to 1600x900 afterwards
    sc.render.resolution_x, sc.render.resolution_y = RES[0], RES[1] // 2
    xa_ = 0.0
    cam = camera("p1-02a-section", (300, P(0, 18, 0).y, P(0, 0, 1.2).z), (0, P(0, 18, 0).y, P(0, 0, 1.2).z), ortho=107 * U)
    on = [cut_copy(o, (xa_ + 0.01, 0, 0), (1, 0, 0)) for o in CONTEXT if o.type == 'MESH']
    on += [cut_copy(o, (xa_, 0, 0), (1, 0, 0)) for o in BLK if o.type == 'MESH'] + [o for o in BLK if o.type == 'LIGHT']
    on.append(poche('x', xa_, P(0, 72, 0).y, P(0, -36, 0).y, P(0, 0, -14.5).z, P(0, 0, 16.5).z, 0.05))
    def tA(body, D, H, size=1.3, mat=M['textw']):
        o = text("UCX_%d" % len(TMP), body, P(0.5, D, H) + Vector((2, 0, 0)), size * 2.3, mat, coll=sc.collection)
        o.rotation_euler = cam.matrix_world.to_euler(); TMP.append(o); on.append(o)
    tA("SECTION A - cut at X = 0 through the cargo bay and the spine, looking west (sea on the right)", 18, 14.6, 0.95)
    tA("CARGO BAY\n7.0 m clear", 7, 3.5, 1.1, M['text'])
    tA("SPINE 3.8 m", 34, 1.9, 0.9, M['text'])
    tA("lower level ends D 52 m\n(top workshop back wall D 50.3 m)", 52, 7.0, 0.75)
    tA("POOL DECK +/-0.0 m", -12, 1.0, 0.9, M['deckline'])
    tA("ground +%.1f m" % H_of(0), 64, 11.4, 0.9)
    tA("<- inland      D = metres into the cliff from the deck back wall      sea ->", 18, -12.6, 0.8)
    for d_ in (0, 14, 28, 52): tA("D %d" % d_, d_, -10.6, 0.75)
    show(on); bg(0.45); set_emit(0.3)
    render(cam, "_p1-02a.png"); cleanup()
    yb = P(0, 29.5, 0).y
    cam = camera("p1-02b-section", (P(-31.5, 0, 0).x, 300, P(0, 0, 1.2).z), (P(-31.5, 0, 0).x, yb, P(0, 0, 1.2).z), ortho=107 * U)
    on = [cut_copy(o, (0, yb - 0.01, 0), (0, 1, 0)) for o in CONTEXT if o.type == 'MESH']
    on += [cut_copy(o, (0, yb, 0), (0, 1, 0)) for o in BLK if o.type == 'MESH' and not o.name.startswith('UC_VTOL')] + [o for o in BLK if o.name.startswith('UC_VTOL') or o.type == 'LIGHT']
    on.append(poche('y', yb, P(-86, 0, 0).x, P(23, 0, 0).x, P(0, 0, -14.5).z, P(0, 0, 16.5).z, 0.05))
    def tB(body, X, H, size=1.3, mat=M['textw']):
        o = text("UCX_%d" % len(TMP), body, P(X, 29.5, H) + Vector((0, 2, 0)), size * 2.3, mat, coll=sc.collection)
        o.rotation_euler = cam.matrix_world.to_euler(); TMP.append(o); on.append(o)
    tB("SECTION B - cut at D = 29.5 m: guest corridor, hangar door, stairs, hangar and hatch shaft, looking inland (west on the right)", -31.5, 15.0, 0.85)
    tB("GUEST CORRIDOR", -16, 1.75, 0.8, M['text'])
    tB("HANGAR\nDOOR", -27.2, 1.5, 0.75, M['nose'])
    tB("STAIRS -12.0 m\n68 x 0.176 m risers\n3 landings", -38, -3.0, 0.8)
    tB("HANGAR 30 m wide, 18 m clear", HX, 2.0, 1.0, M['text'])
    tB("floor -12.0 m", HX - 9, -10.6, 0.8, M['text'])
    tB("HATCH 18 m clear (leaves open)", HX, 13.6, 0.85)
    tB("ground +%.1f m" % GH, -20, 11.6, 0.8)
    tB("OFFICE", 6, 1.8, 0.8, M['text'])
    show(on); bg(0.45); set_emit(0.3)
    render(cam, "_p1-02b.png"); cleanup()
    sc.render.resolution_x, sc.render.resolution_y = RES

if "3" in VIEWS:   # exterior from the pool deck, mansion textures intact
    cam = camera("p1-03-exterior-bay-from-pool-deck", (6, 64, F + 1.7 * U), (0, -10, F + 4.6 * U), lens=15)
    on = CONTEXT + blk(("UC_hlight",))
    on.append(tmp_text("CARGO BAY - full deck width 65.2 m, 7.0 m clear", P(0, 13.5, 5.6), 3.4, M['textw'], cam))
    on.append(tmp_text("spine to the lower level", P(0, 13.5, 3.6), 2.0, M['textw'], cam))
    on.append(tmp_text("workshop / garage door", P(-24.3, 13.5, 4.8), 2.0, M['textw'], cam))
    show(on); bg(0.9); set_emit(0.18)
    render(cam, "p1-03-exterior-bay-from-pool-deck.png"); cleanup()

if "4" in VIEWS:   # cutaway: hatch, shaft, scaffold, hangar, VTOL
    yc = P(0, 27.0, 0).y
    tgt = P(HX, 33, -1.5)
    cam = camera("p1-04-hatch-and-scaffold-into-hangar", (tgt.x - 40, tgt.y + 112, tgt.z + 62), tgt, lens=26)
    on = [cut_copy(o, (0, yc + 0.01, 0), (0, 1, 0)) for o in CONTEXT if o.type == 'MESH']
    on += [cut_copy(o, (0, yc, 0), (0, 1, 0)) for o in BLK if o.type == 'MESH' and not o.name.startswith('UC_VTOL')]
    on += [o for o in BLK if o.name.startswith('UC_VTOL') or o.type == 'LIGHT']
    on.append(poche('y', yc, P(-98, 0, 0).x, P(-44, 0, 0).x, P(0, 0, -16).z, P(0, 0, 12.5).z, 0.05))
    on.append(tmp_text("SURFACE HATCH 18 x 22 m clear (leaves open)", P(HX, 35, GH + 9.5), 3.4, M['text'], cam))
    on.append(tmp_text("ground +%.1f m" % GH, P(HX - 22, 30, GH + 1.5), 2.2, M['text'], cam))
    on.append(tmp_text("SHAFT 4.3 m to hangar ceiling", P(HX + 16.5, 30, 8.2), 2.1, M['text'], cam))
    on.append(tmp_text("SCAFFOLD STAIR\n7 flights x 18 risers (0.177 m)\n22.3 m, on the back wall", P(HX + 22, 44, -2), 2.1, M['text'], cam))
    on.append(tmp_text("HANGAR 40 x 30 m, 18 m clear\nfloor -12.0 m", P(HX - 2, 28, 3.0), 2.8, M['text'], cam))
    on.append(tmp_text("VTOL placeholder 15 x 12 x 5 m, nose to sea", P(HX, 27, -5.0), 2.1, M['text'], cam))
    on.append(tmp_text("stairs from the lower level\n(hangar door at 0.0 m)", P(-44, 29.5, -3.5), 1.8, M['text'], cam))
    on.append(tmp_text("top-level workshop wing", Vector((-60, -80, 14)), 2.2, M['text'], cam))
    show(on); bg(0.7); set_emit(0.08); sc.view_settings.exposure = -0.8
    render(cam, "p1-04-hatch-and-scaffold-into-hangar.png"); cleanup(); sc.view_settings.exposure = 0.15

if "5" in VIEWS:   # isometric cutaway, everything above the lower level removed
    zc = P(0, 0, 7.8).z
    tgt = P(-24, 25, -2)
    d = Vector((-0.55, 1.0, 0.95)).normalized()
    cam = camera("p1-05-isometric-cutaway", tgt + d * 600, tgt, ortho=270)
    on = [cut_copy(o, (0, 0, zc), (0, 0, 1)) for o in CONTEXT if o.type == 'MESH']
    on += blk(("UC_hangar_ceil", "UC_bay_ceiling", "UC_stair_ceiling", "UC_hlight"))
    for k, (X, D, H) in VOL.items():
        if k in ('gcorr', 'spine', 'shaft') or k.startswith('guest'): continue
        nm = {'bay': "CARGO BAY", 'stairs': "STAIRS -12 m", 'hangar': "HANGAR 40x30x18 m"}.get(k, L.get(k, {}).get('name', k))
        on.append(tmp_text(nm, P(sum(X) / 2, sum(D) / 2, H[1] + 1.5), 3.6 if k in ('bay', 'hangar') else 2.7, M['text'], cam))
    on.append(tmp_text("GUEST 1-4", P(-14, 34, 5.5), 2.4, M['text'], cam))
    on.append(tmp_text("SURFACE HATCH + scaffold", P(HX, HATCH['D'][1] + 4, GH + 3), 2.8, M['text'], cam))
    on.append(tmp_text("VTOL", P(HX, VTOL['D'], -4.5), 2.5, M['text'], cam))
    on.append(tmp_text("lower pool deck", P(0, -16, 1.5), 3.1, M['text'], cam))
    show(on); bg(0.9); set_emit(0.22); sc.view_settings.exposure = -0.7
    render(cam, "p1-05-isometric-cutaway.png"); cleanup()

if os.environ.get("UC_SAVE_FINAL", "") == "1":
    for o in sc.objects:
        if o.type in ('MESH', 'LIGHT') and not o.name.startswith('UCL_'): o.hide_render = False
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(UCD, "p1-blockout.blend"), compress=True, copy=True)
    print("SAVED final blend with cameras", flush=True)
print("ALL DONE", flush=True)
