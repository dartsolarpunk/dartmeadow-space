"""Bird Temple engineering office + Madison plush + Polaroid — scripted Blender build.

  blender -b --python build_office.py                # builds bt-engineering.blend + exports ../../bt-engineering/bt-engineering.glb
  blender -b --python build_office.py -- --no-export # just the .blend

Coordinates are the temple's own model frame (as in 'Bird Temple Interior.glb', Blender Z-up), so the
exported scene drops straight into the temple's glTF root in game (ui/dm-bt-engineering.js).
Placement: lower deck (deck C) engine room, port-aft corner, desk backed onto the aft bulkhead (face at y=91.5)
between the port pipe run (x≈-8.8) and the crew-quarters door (x≈-2.5). Floor top z=-22.5. Her height ≈ 4.14 units.
Nodes:  FX_BTE_Office (decor, excluded from walk collision by the FX_ prefix)
          ├ BTE_Felt / BTE_Glow / BTE_Screen / BTE_Polaroid   (one merged static mesh per material)
          └ FX_BTE_Holo                                        (wireframe planet, spun in code)
        BTE_DeskCollider (box, hidden in game, the only part added to the walk collision)
Textures: make_textures.py (atlas/screen), compose_polaroid.py (polaroid from render_selfie.py)."""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix
D = os.path.dirname(os.path.abspath(__file__)); TEX = os.path.join(D, 'tex')
OUT = os.path.normpath(os.path.join(D, '..', '..', 'bt-engineering', 'bt-engineering.glb'))
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ORIGIN = Vector((-6.5, 91.48, -22.5))     # floor, centre of the desk's back edge (aft bulkhead face, y=91.5)
PATCH = {'skin':0,'suit':1,'cyan':2,'magenta':3,'eye':4,'eyewhite':5,'lip':6,'freckle':7,'desk':8,'desktop':9,'dark':10,'steel':11,
         'mat':12,'pin':13,'white':14,'blush':15,'g_cyan':16,'g_magenta':17,'g_violet':18,'g_amber':19,'hair':24}

bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
def coll(name):
    c = bpy.data.collections.new(name); scn.collection.children.link(c); return c
C_OFF, C_PL = coll('Office'), coll('Madison')

# ── materials ──
def img(name):
    p = os.path.join(TEX, name)
    return bpy.data.images.load(p, check_existing=True) if os.path.exists(p) else None
def mat(name, image=None, emissive=False, rough=0.85, metal=0.0, alpha=None, strength=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if image:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = image; t.interpolation = 'Linear'
        if emissive:
            b.inputs['Base Color'].default_value = (0, 0, 0, 1)
            nt.links.new(t.outputs['Color'], b.inputs['Emission Color']); b.inputs['Emission Strength'].default_value = strength
        else:
            nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if alpha is not None:
        b.inputs['Alpha'].default_value = alpha; m.blend_method = 'BLEND'
    return m
ATLAS = img('atlas.png')
M = {
  'felt': mat('BTE_Felt', ATLAS, rough=0.95),
  'glow': mat('BTE_Glow', ATLAS, emissive=True, strength=1.0),
  'screen': mat('BTE_Screen', img('screen.png'), emissive=True),
  'polaroid': mat('BTE_Polaroid', img('polaroid.png') or ATLAS, rough=0.5),
  'holo': mat('BTE_Holo', None, rough=1.0),
}
hb = M['holo'].node_tree.nodes['Principled BSDF']
hb.inputs['Base Color'].default_value = (0, 0, 0, 1); hb.inputs['Emission Color'].default_value = (0.3, 1.0, 0.95, 1); hb.inputs['Emission Strength'].default_value = 1.0

# ── helpers ──
def uv_to_patch(ob, patch, mode='box', span=1):
    """Project UVs (box / sphere / height) and squeeze them into one 64px atlas patch (with margin)."""
    me = ob.data; bm = bmesh.new(); bm.from_mesh(me)
    uvl = bm.loops.layers.uv.verify()
    vs = [v.co for v in bm.verts]
    mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))); mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    sz = mx - mn; sz = Vector((max(sz.x, 1e-6), max(sz.y, 1e-6), max(sz.z, 1e-6))); c = (mn + mx) / 2
    i = PATCH[patch]; px, py = (i % 8) / 8, (i // 8) / 8; w = span / 8; h = 1 / 8; m = 6 / 512
    for f in bm.faces:
        n = f.normal
        for l in f.loops:
            p = l.vert.co
            if mode == 'sphere':
                d = (p - c); u = 0.5 + math.atan2(d.y, d.x) / (2 * math.pi); v = (p.z - mn.z) / sz.z
            elif mode == 'height':
                u = ((p.x - mn.x) / sz.x * 0.6 + (p.y - mn.y) / sz.y * 0.4) % 1; v = 1 - (p.z - mn.z) / sz.z
            else:
                a = max(range(3), key=lambda k: abs(n[k]))
                ax = [(1, 2), (0, 2), (0, 1)][a]
                u = (p[ax[0]] - mn[ax[0]]) / sz[ax[0]]; v = (p[ax[1]] - mn[ax[1]]) / sz[ax[1]]
            u = min(max(u, 0), 1); v = min(max(v, 0), 1)
            l[uvl].uv = (px + m + u * (w - 2 * m), 1 - (py + m + v * (h - 2 * m)))   # image row 0 = top
    bm.to_mesh(me); bm.free()
def finish(ob, material, collection, patch=None, mode='box', span=1, smooth=False, bevel=0, seg=2):
    for c in ob.users_collection: c.objects.unlink(ob)
    collection.objects.link(ob)
    ob.data.materials.clear(); ob.data.materials.append(M[material])
    if bevel:
        bm_ = ob.modifiers.new('Bevel', 'BEVEL'); bm_.width = bevel; bm_.segments = seg; bm_.limit_method = 'ANGLE'
    if smooth:
        for p in ob.data.polygons: p.use_smooth = True
    if patch: uv_to_patch(ob, patch, mode, span)
    return ob
def box(name, size, loc, material, collection, patch, bevel=0.02, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot); o = bpy.context.object; o.name = name
    o.scale = size; bpy.ops.object.transform_apply(scale=True)
    return finish(o, material, collection, patch, bevel=bevel)
def cyl(name, r, depth, loc, material, collection, patch, verts=16, rot=(0, 0, 0), bevel=0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot); o = bpy.context.object; o.name = name
    return finish(o, material, collection, patch, mode='sphere', bevel=bevel, smooth=True)
def ball(name, r, loc, scale, material, collection, patch, seg=16, ring=10, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=ring, radius=r, location=loc, rotation=rot); o = bpy.context.object; o.name = name
    o.scale = scale; bpy.ops.object.transform_apply(scale=True, rotation=True)
    return finish(o, material, collection, patch, mode='sphere', smooth=True)
def tube(name, pts, r, material, collection, patch, res=4, cyclic=False):
    cu = bpy.data.curves.new(name, 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = r; cu.bevel_resolution = 0; cu.resolution_u = 4
    sp = cu.splines.new('POLY' if len(pts) < 3 else 'NURBS'); sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts): sp.points[i].co = (*p, 1)
    sp.use_endpoint_u = True; sp.use_cyclic_u = cyclic; sp.order_u = min(3, len(pts))
    o = bpy.data.objects.new(name, cu); scn.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.convert(target='MESH'); o = bpy.context.object
    return finish(o, material, collection, patch, mode='height' if patch == 'hair' else 'sphere', span=4 if patch == 'hair' else 1, smooth=True)
def ring_pts(c, r, axis='z', n=10, tilt=0.0):
    out = []
    for k in range(n):
        a = 2 * math.pi * k / n
        if axis == 'z': out.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a), c[2] + tilt * math.sin(a)))
        elif axis == 'x': out.append((c[0] + tilt * math.sin(a), c[1] + r * math.cos(a), c[2] + r * math.sin(a)))
        else: out.append((c[0] + r * math.cos(a), c[1] + tilt * math.sin(a), c[2] + r * math.sin(a)))
    return out
O = ORIGIN
def W(x, y, z): return (O.x + x, O.y + y, O.z + z)     # office-local → temple frame (+y = into the locker wall)

# ── office ── (desk 3.8 × 1.45, top at 1.75 ≈ 30 in at her scale)
DESK_W, DESK_D, DESK_H = 3.8, 1.45, 1.75
TOP = DESK_H
box('Desk_Top', (DESK_W, DESK_D, 0.09), W(0, -DESK_D / 2, TOP - 0.045), 'felt', C_OFF, 'desktop', bevel=0.03)
for sx in (-1, 1):
    box('Desk_Leg', (0.1, DESK_D - 0.12, TOP - 0.09), W(sx * (DESK_W / 2 - 0.12), -DESK_D / 2, (TOP - 0.09) / 2), 'felt', C_OFF, 'desk', bevel=0.02)
box('Desk_Modesty', (DESK_W - 0.3, 0.05, 1.0), W(0, -0.18, TOP - 0.6), 'felt', C_OFF, 'desk', bevel=0.01)
box('Desk_Drawers', (0.9, DESK_D - 0.2, TOP - 0.25), W(1.3, -DESK_D / 2, (TOP - 0.25) / 2 + 0.08), 'felt', C_OFF, 'dark', bevel=0.02)
for k in range(3):
    box('Drawer_Handle', (0.4, 0.03, 0.03), W(1.3, -DESK_D + 0.08, 0.35 + k * 0.45), 'glow', C_OFF, 'g_cyan', bevel=0)
box('Desk_Neon', (DESK_W - 0.04, 0.025, 0.025), W(0, -DESK_D - 0.005, TOP - 0.06), 'glow', C_OFF, 'g_cyan', bevel=0)
box('Desk_NeonUnder', (DESK_W - 0.3, 0.02, 0.02), W(0, -DESK_D + 0.1, TOP - 0.12), 'glow', C_OFF, 'g_magenta', bevel=0)
# terminal
TX = -0.85
box('Term_Foot', (0.5, 0.35, 0.04), W(TX, -0.45, TOP + 0.02), 'felt', C_OFF, 'steel', bevel=0.01)
box('Term_Neck', (0.08, 0.06, 0.5), W(TX, -0.38, TOP + 0.27), 'felt', C_OFF, 'steel', bevel=0.01)
box('Term_Body', (1.45, 0.1, 0.92), W(TX, -0.38, TOP + 0.85), 'felt', C_OFF, 'dark', bevel=0.03, rot=(math.radians(-8), 0, 0))
bpy.ops.mesh.primitive_plane_add(size=1, location=W(TX, -0.44, TOP + 0.855), rotation=(math.radians(90 - 8), 0, 0))
scr = bpy.context.object; scr.name = 'Term_Screen'; scr.scale = (1.33, 0.82, 1); bpy.ops.object.transform_apply(scale=True, rotation=True)
finish(scr, 'screen', C_OFF)
uvs = scr.data.uv_layers.active.data   # full-texture UVs (plane default)
box('Term_Neon', (1.45, 0.02, 0.02), W(TX, -0.45, TOP + 0.37), 'glow', C_OFF, 'g_magenta', bevel=0, rot=(math.radians(-8), 0, 0))
box('Keyboard', (1.1, 0.36, 0.04), W(TX, -1.0, TOP + 0.02), 'felt', C_OFF, 'dark', bevel=0.012)
for r in range(3):
    box('Keys', (1.0, 0.07, 0.012), W(TX, -1.12 + r * 0.11, TOP + 0.045), 'glow', C_OFF, 'g_violet' if r != 1 else 'g_cyan', bevel=0)
box('Mug', (0.0, 0, 0), W(0, 0, 0), 'felt', C_OFF, 'dark')  # placeholder removed below
bpy.data.objects.remove(bpy.data.objects['Mug'])
cyl('Mug', 0.07, 0.17, W(0.35, -1.05, TOP + 0.085), 'felt', C_OFF, 'white', verts=12)
# hologram projector + hologram
HX = 1.35
cyl('Holo_Base', 0.26, 0.08, W(HX, -0.75, TOP + 0.04), 'felt', C_OFF, 'dark', verts=20, bevel=0.015)
cyl('Holo_Ring', 0.2, 0.02, W(HX, -0.75, TOP + 0.09), 'glow', C_OFF, 'g_cyan', verts=20)
cyl('Holo_Lens', 0.07, 0.03, W(HX, -0.75, TOP + 0.105), 'glow', C_OFF, 'g_magenta', verts=12)
holo_c = Vector(W(HX, -0.75, TOP + 0.55))
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.3, location=(0, 0, 0)); hp = bpy.context.object; hp.name = 'Holo_Planet'
wm = hp.modifiers.new('Wire', 'WIREFRAME'); wm.thickness = 0.008; wm.use_replace = True
bpy.ops.object.modifier_apply(modifier='Wire')
bpy.ops.mesh.primitive_torus_add(major_radius=0.46, minor_radius=0.01, major_segments=40, minor_segments=4, location=(0, 0, 0), rotation=(math.radians(18), 0, 0))
hr = bpy.context.object; hr.name = 'Holo_PlanetRing'
bpy.ops.mesh.primitive_torus_add(major_radius=0.12, minor_radius=0.006, major_segments=20, minor_segments=3, location=(0.58, 0, 0.1), rotation=(math.radians(70), 0, 0))
hm = bpy.context.object; hm.name = 'Holo_Moon'
bpy.ops.object.select_all(action='DESELECT')
for o in (hp, hr, hm): o.select_set(True)
bpy.context.view_layer.objects.active = hp; bpy.ops.object.join(); hp.location = holo_c
hp.name = 'FX_BTE_Holo'; finish(hp, 'holo', C_OFF)
# stool
cyl('Stool_Seat', 0.36, 0.1, W(-0.6, -2.05, 1.12), 'felt', C_OFF, 'suit', verts=20, bevel=0.03)
cyl('Stool_Post', 0.05, 1.05, W(-0.6, -2.05, 0.56), 'felt', C_OFF, 'steel', verts=8)
cyl('Stool_Foot', 0.3, 0.05, W(-0.6, -2.05, 0.03), 'felt', C_OFF, 'dark', verts=16)
cyl('Stool_Neon', 0.37, 0.02, W(-0.6, -2.05, 1.07), 'glow', C_OFF, 'g_magenta', verts=20)
# floor mat + wall plaque
box('Floor_Mat', (4.2, 2.9, 0.02), W(0, -1.45, 0.01), 'felt', C_OFF, 'mat', bevel=0)
for (sx, sy, w, d) in ((0, -2.9, 4.2, 0.04), (-2.1, -1.45, 0.04, 2.9), (2.1, -1.45, 0.04, 2.9)):
    box('Mat_Neon', (w, d, 0.012), W(sx, sy, 0.026), 'glow', C_OFF, 'g_cyan', bevel=0)
box('Plaque', (1.3, 0.04, 0.26), W(-0.85, -0.03, 4.25), 'felt', C_OFF, 'dark', bevel=0.01)
box('Plaque_Glow', (1.18, 0.02, 0.05), W(-0.85, -0.055, 4.25), 'glow', C_OFF, 'g_amber', bevel=0)
box('Shelf', (1.6, 0.4, 0.06), W(-0.85, -0.2, 3.65), 'felt', C_OFF, 'desk', bevel=0.015)
for k, p in enumerate(('g_cyan', 'g_magenta', 'g_violet')):
    box('Shelf_Cell', (0.18, 0.18, 0.28), W(-1.4 + k * 0.32, -0.2, 3.82), 'glow', C_OFF, p, bevel=0.01)
# desk collider (game hides it and adds it to the walk collision)
box('BTE_DeskCollider', (DESK_W + 0.04, DESK_D + 0.04, TOP), W(0, -DESK_D / 2, TOP / 2), 'felt', C_OFF, 'dark', bevel=0)

# ── Madison (chibi plush), built at 1 unit = plush height, then scaled ──
PH = 0.8                            # plush height in temple units (~1 ft at her scale)
PO = Vector(W(-0.05, -0.55, TOP))    # seat point on the desk
pl = []
def P(x, y, z): return (x, y, z)
pl.append(ball('M_Body', 0.2, P(0, 0, 0.27), (1, 0.85, 1.05), 'felt', C_PL, 'suit'))
pl.append(ball('M_Head', 0.31, P(0, 0, 0.7), (1.05, 0.95, 0.92), 'felt', C_PL, 'skin', seg=20, ring=12))
for sx in (-1, 1):
    pl.append(tube('M_Leg', [P(sx * 0.1, -0.02, 0.1), P(sx * 0.11, -0.2, 0.08), P(sx * 0.12, -0.34, 0.07)], 0.075, 'felt', C_PL, 'suit'))
    pl.append(ball('M_Foot', 0.085, P(sx * 0.12, -0.36, 0.08), (1, 1.1, 1), 'felt', C_PL, 'suit', seg=10, ring=6))
    pl.append(tube('M_Arm', [P(sx * 0.17, 0, 0.42), P(sx * 0.25, -0.05, 0.3), P(sx * 0.26, -0.12, 0.2)], 0.06, 'felt', C_PL, 'suit'))
    pl.append(ball('M_Hand', 0.062, P(sx * 0.26, -0.13, 0.18), (1, 1, 1), 'felt', C_PL, 'skin', seg=10, ring=6))
    # trim: cyan cuff + magenta knee band, cyan shoulder line
    pl.append(tube('M_Cuff', ring_pts((sx * 0.26, -0.11, 0.215), 0.064, 'z', 10, 0.02), 0.012, 'glow', C_PL, 'g_cyan', cyclic=True))
    pl.append(tube('M_Knee', ring_pts((sx * 0.115, -0.22, 0.08), 0.08, 'x', 10, 0.0), 0.012, 'glow', C_PL, 'g_magenta', cyclic=True))
    pl.append(tube('M_SuitLine', [P(sx * 0.03, -0.17, 0.44), P(sx * 0.11, -0.17, 0.33), P(sx * 0.1, -0.18, 0.18), P(sx * 0.05, -0.17, 0.08)], 0.01, 'glow', C_PL, 'g_cyan'))
    pl.append(tube('M_SuitLine2', [P(sx * 0.08, -0.15, 0.45), P(sx * 0.17, -0.1, 0.36), P(sx * 0.19, -0.06, 0.22)], 0.009, 'glow', C_PL, 'g_magenta'))
    # embroidered eyes: brown oval + dark pupil stitch + white glint; little blush
    ex = sx * 0.11
    pl.append(ball('M_Eye', 0.058, P(ex, -0.27, 0.69), (0.8, 0.25, 1.05), 'felt', C_PL, 'eye', seg=12, ring=6))
    pl.append(ball('M_EyeGlint', 0.016, P(ex - sx * 0.015, -0.285, 0.715), (1, 0.4, 1), 'felt', C_PL, 'eyewhite', seg=8, ring=4))
    pl.append(tube('M_Lash', [P(ex - 0.055, -0.265, 0.74), P(ex, -0.275, 0.765), P(ex + 0.055, -0.265, 0.74)], 0.008, 'felt', C_PL, 'suit'))
    pl.append(tube('M_Brow', [P(ex - 0.05, -0.255, 0.81), P(ex, -0.265, 0.825), P(ex + 0.05, -0.258, 0.815)], 0.008, 'felt', C_PL, 'eye'))
    pl.append(ball('M_Blush', 0.04, P(sx * 0.19, -0.24, 0.62), (1, 0.3, 0.7), 'felt', C_PL, 'blush', seg=8, ring=4))
    for k, (fx, fz) in enumerate(((0.12, 0.635), (0.155, 0.645), (0.09, 0.64), (0.135, 0.615))):   # freckles
        pl.append(ball('M_Freckle', 0.008, P(sx * fx, -0.283 + abs(fx - 0.12) * 0.15, fz), (1, 0.4, 1), 'felt', C_PL, 'freckle', seg=6, ring=3))
pl.append(tube('M_Mouth', [P(-0.035, -0.278, 0.585), P(0, -0.286, 0.575), P(0.035, -0.278, 0.585)], 0.011, 'felt', C_PL, 'lip'))
pl.append(tube('M_Collar', ring_pts((0, 0, 0.45), 0.1, 'z', 12, 0.0), 0.016, 'glow', C_PL, 'g_cyan', cyclic=True))
pl.append(tube('M_Belt', ring_pts((0, 0, 0.2), 0.205, 'z', 14, 0.0), 0.011, 'glow', C_PL, 'g_magenta', cyclic=True))
# yarn hair: cap + strands falling past the shoulders (blue at the crown → purple at the tips)
pl.append(ball('M_HairCap', 0.325, P(0, 0.03, 0.74), (1.05, 0.98, 0.9), 'felt', C_PL, 'hair', seg=18, ring=10))
cap = pl[-1]   # trim the cap's face side so the face shows
bm = bmesh.new(); bm.from_mesh(cap.data)
bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y < -0.14 and v.co.z < 0.86], context='VERTS')
bm.to_mesh(cap.data); bm.free(); uv_to_patch(cap, 'hair', 'height', 4)
import random; random.seed(11)
N = 26
for k in range(N):
    a = math.radians(-120 + 240 * k / (N - 1))            # around the back, ear to ear
    wav = 0.025 + random.random() * 0.02; ln = 0.5 + random.random() * 0.14
    x0, y0 = 0.3 * math.sin(a), 0.3 * math.cos(a) * 0.95 + 0.04
    pts = []
    for s in range(6):
        t = s / 5; r = 1 + 0.18 * t
        pts.append(P(x0 * r + wav * math.sin(t * 9 + k), y0 * r + 0.05 * t + wav * math.cos(t * 7 + k), 0.86 - 0.12 * (1 - abs(math.cos(a))) - ln * t))
    pts.insert(0, P(x0 * 0.4, y0 * 0.4, 1.0))
    pl.append(tube('M_Yarn', pts, 0.028, 'felt', C_PL, 'hair'))
for k in range(7):    # bangs
    x = -0.2 + 0.4 * k / 6
    pl.append(tube('M_Bang', [P(x * 0.4, -0.05, 1.0), P(x * 0.95, -0.24, 0.93), P(x * 1.15 + 0.03, -0.29, 0.83)], 0.026, 'felt', C_PL, 'hair'))
# place the plush on the desk, slightly turned toward the room / chair
mad = bpy.data.objects.new('Madison', None); C_PL.objects.link(mad)
for o in pl: o.parent = mad
mad.scale = (PH, PH, PH); mad.location = PO; mad.rotation_euler = (0, 0, math.radians(-14))

# ── Polaroid + pushpin on the locker face, beside the terminal ──
PW_, PHt = 0.44, 0.53
pol_c = Vector(W(0.62, -0.01, 3.05))
bpy.ops.mesh.primitive_cube_add(size=1, location=pol_c)
po = bpy.context.object; po.name = 'Polaroid'; po.scale = (PW_, 0.006, PHt); po.rotation_euler = (0, math.radians(4), 0)   # pinned slightly askew
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
finish(po, 'polaroid', C_OFF)
bm = bmesh.new(); bm.from_mesh(po.data); uvl = bm.loops.layers.uv.verify()
for f in bm.faces:
    front = f.normal.y < -0.5
    for l in f.loops:
        p = l.vert.co - pol_c
        l[uvl].uv = ((p.x / PW_ + 0.5), (p.z / PHt + 0.5)) if front else (0.97, 0.03)   # back/edges: the white border
bm.to_mesh(po.data); bm.free()
pc = Vector(W(0.62, -0.03, 3.05 + PHt / 2 - 0.05))
ball('Pin_Head', 0.035, pc + Vector((0, -0.04, 0)), (1, 0.8, 1), 'felt', C_OFF, 'pin', seg=12, ring=6)
cyl('Pin_Neck', 0.012, 0.05, pc + Vector((0, -0.012, 0)), 'felt', C_OFF, 'steel', verts=6, rot=(math.radians(90), 0, 0))

# v2: Madison is her own rigged GLB now (build_madison.py → madison.glb, ui/dm-bt-madison.js). The v1 primitive plush
# stays scripted above for reference; it is only kept in the office export with BTE_LEGACY_PLUSH=1.
if not os.environ.get('BTE_LEGACY_PLUSH'):
    for o in list(C_PL.objects): bpy.data.objects.remove(o)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(D, 'bt-engineering.blend'))
print('[bte] blend saved')

# ── export: bake modifiers, merge static parts per material, keep the holo + collider separate ──
if '--no-export' not in ARGS:
    bpy.ops.object.select_all(action='DESELECT')
    for o in list(scn.objects):
        if o.type == 'MESH':
            bpy.context.view_layer.objects.active = o
            for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
    # world-space bake (parents cleared, transforms applied)
    for o in list(scn.objects):
        if o.type == 'MESH':
            mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
    bpy.ops.object.select_all(action='DESELECT')
    for o in scn.objects:
        if o.type == 'MESH': o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    root = bpy.data.objects.new('FX_BTE_Office', None); scn.collection.objects.link(root)
    keep = {'FX_BTE_Holo', 'BTE_DeskCollider'}
    groups = {}
    for o in list(scn.objects):
        if o.type != 'MESH' or o.name in keep: continue
        groups.setdefault(o.data.materials[0].name, []).append(o)
    for mname, obs in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in obs: o.select_set(True)
        bpy.context.view_layer.objects.active = obs[0]; bpy.ops.object.join()
        j = bpy.context.object; j.name = mname; j.parent = root
    hol = scn.objects['FX_BTE_Holo']; hol.parent = root
    for o in [o for o in scn.objects if o.type == 'EMPTY' and o is not root]: bpy.data.objects.remove(o)
    tris = sum(len(p.vertices) - 2 for o in scn.objects if o.type == 'MESH' for p in o.data.polygons)
    print('[bte] meshes:', [o.name for o in scn.objects if o.type == 'MESH'], 'tris:', tris)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    RAW = OUT.replace('.glb', '.raw.glb')
    bpy.ops.export_scene.gltf(filepath=RAW, export_format='GLB', export_image_format='WEBP', export_image_quality=82,
                              export_apply=True, export_yup=True, export_cameras=False, export_lights=False,
                              export_draco_mesh_compression_enable=False, export_extras=False)
    # meshopt + quantization (keeps node/material names and the webp images): npx gltfpack
    import subprocess, shutil
    try:
        subprocess.run(['npx', '-y', 'gltfpack', '-i', RAW, '-o', OUT, '-cc', '-kn', '-km', '-vp', '14'], check=True, timeout=300)
        os.remove(RAW)
    except Exception as e:
        print('[bte] gltfpack unavailable (%s): shipping the uncompressed export' % e); shutil.move(RAW, OUT)
    print('[bte] exported', OUT, os.path.getsize(OUT), 'bytes')
