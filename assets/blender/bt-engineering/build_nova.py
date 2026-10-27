"""Nova Rustveil — rigged ball-jointed art doll for the engineering office (Blender 4.2, headless).

  python3 make_nova_textures.py
  blender -b --python build_nova.py      → nova.blend, ../../bt-engineering/nova.glb

Doll units: standing height 1.0, facing -Y, her left = +X, floor at z=0 (the game scales her ×2.2 = twice Madison).
Same 20-joint rig and bone names as Madison (root, Hips, Spine02, Spine01, Spine, neck, Head, L/R Shoulder/Arm/ForeArm/
Hand, L/R UpLeg/Leg/Foot). A ball-jointed doll is rigid segments, so every part is weighted 100 % to one bone except
the leather torso (blended down the spine) and the hair cards (head → upper spine). Includes her stool (static, no bone
weights) under the root. Materials (shared): NOVA_Face, NOVA_Skin, NOVA_Wood, NOVA_Leather, NOVA_Hair, NOVA_Visor,
NOVA_Band, NOVA_Metal, NOVA_Shard, NOVA_Watch, NOVA_Stool. Actions: Sit (breathing loop), Wave.
"""
import bpy, bmesh, math, os, sys, random
from mathutils import Vector, Matrix
D = os.path.dirname(os.path.abspath(__file__)); TEX = os.path.join(D, 'tex')
OUTDIR = os.path.normpath(os.path.join(D, '..', '..', 'bt-engineering')); GLB = os.path.join(OUTDIR, 'nova.glb')
random.seed(9)
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
def sel(*obs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]

# ───────── skeleton ─────────
J = {'Hips': ((0, 0, 0.52), (0, 0, 0.58), None), 'Spine02': ((0, 0, 0.58), (0, 0, 0.65), 'Hips'),
     'Spine01': ((0, 0, 0.65), (0, 0, 0.72), 'Spine02'), 'Spine': ((0, 0, 0.72), (0, 0, 0.82), 'Spine01'),
     'neck': ((0, 0, 0.82), (0, 0, 0.865), 'Spine'), 'Head': ((0, 0, 0.865), (0, 0, 1.0), 'neck')}
SH, EL, WR = (0.098, 0, 0.795), (0.112, 0.004, 0.645), (0.12, -0.004, 0.505)
HIP, KN, AN = (0.05, 0, 0.52), (0.056, 0, 0.285), (0.058, 0.004, 0.055)
def sx(p, s): return (s * p[0], p[1], p[2])
for s, nm in ((1, 'Left'), (-1, 'Right')):
    J[nm + 'Shoulder'] = ((s * 0.02, 0, 0.79), sx(SH, s), 'Spine')
    J[nm + 'Arm'] = (sx(SH, s), sx(EL, s), nm + 'Shoulder')
    J[nm + 'ForeArm'] = (sx(EL, s), sx(WR, s), nm + 'Arm')
    J[nm + 'Hand'] = (sx(WR, s), (s * 0.124, -0.008, 0.43), nm + 'ForeArm')
    J[nm + 'UpLeg'] = (sx(HIP, s), sx(KN, s), 'Hips')
    J[nm + 'Leg'] = (sx(KN, s), sx(AN, s), nm + 'UpLeg')
    J[nm + 'Foot'] = (sx(AN, s), (s * 0.06, -0.09, 0.012), nm + 'Leg')
arm_d = bpy.data.armatures.new('NovaRig'); rig = bpy.data.objects.new('Nova', arm_d); scn.collection.objects.link(rig)
sel(rig); bpy.ops.object.mode_set(mode='EDIT'); eb = {}
for n, (h, t, p) in J.items():
    b = arm_d.edit_bones.new(n); b.head = h; b.tail = t; eb[n] = b
for n, (h, t, p) in J.items():
    if p: eb[n].parent = eb[p]; eb[n].use_connect = (Vector(J[p][1]) - Vector(h)).length < 1e-6
bpy.ops.object.mode_set(mode='OBJECT')

# ───────── materials ─────────
def img(name, nc=False):
    i = bpy.data.images.load(os.path.join(TEX, name), check_existing=True)
    if nc: i.colorspace_settings.name = 'Non-Color'
    return i
def mat(name, color=(1, 1, 1), rough=0.5, metal=0.0, tex=None, alpha_tex=False, emit=None, emit_s=0.0, alpha=None, coat=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    b.inputs['Coat Weight'].default_value = coat
    if tex:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(tex); nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
        if alpha_tex:
            nt.links.new(t.outputs['Alpha'], b.inputs['Alpha']); m.blend_method = 'CLIP'; m.alpha_threshold = 0.45
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = emit_s
    if alpha is not None:
        b.inputs['Alpha'].default_value = alpha; m.blend_method = 'BLEND'
    return m
M = {
 'face': mat('NOVA_Face', tex='nova_face.png', rough=0.55),
 'skin': mat('NOVA_Skin', (0.84, 0.56, 0.42), rough=0.55),
 'wood': mat('NOVA_Wood', tex='nova_wood.png', rough=0.38, coat=0.5),
 'torso': mat('NOVA_Torso', tex='nova_torso.png', rough=0.36, coat=0.45),
 'leather': mat('NOVA_Leather', (0.018, 0.016, 0.016), rough=0.32, coat=0.6),
 'hair': mat('NOVA_Hair', tex='nova_hair.png', alpha_tex=True, rough=0.45),
 'visor': mat('NOVA_Visor', (0.75, 0.85, 0.95), rough=0.04, alpha=0.22),
 'band': mat('NOVA_Band', (0.01, 0.01, 0.012), rough=0.25),
 'metal': mat('NOVA_Metal', (0.9, 0.9, 0.92), rough=0.22, metal=1.0),
 'shard': mat('NOVA_Shard', (0.7, 0.02, 0.03), rough=0.08, emit=(1.0, 0.06, 0.04), emit_s=1.6),
 'watch': mat('NOVA_Watch', (0.92, 0.92, 0.9), rough=0.35),
 'stool': mat('NOVA_Stool', (0.36, 0.22, 0.13), rough=0.5),
}
M['hair'].use_backface_culling = False; M['visor'].use_backface_culling = False

# ───────── geometry helpers (each part: (object, bone or None)) ─────────
PARTS = []
def UVL(bm): return bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
def new_obj(name, bm, material, bone):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); o = bpy.data.objects.new(name, me); scn.collection.objects.link(o)
    me.materials.append(M[material])
    for p in me.polygons: p.use_smooth = True
    PARTS.append((o, bone)); return o
def ellipsoid(name, c, r, material, bone, seg=16, ring=10):
    bm = bmesh.new(); UVL(bm); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=ring, radius=1.0, calc_uvs=True)
    for v in bm.verts: v.co = Vector((v.co.x * r[0], v.co.y * r[1], v.co.z * r[2])) + Vector(c)
    return new_obj(name, bm, material, bone)
def tube(name, a, b, ra, rb, material, bone, seg=12, rings=4, sq=(1, 1)):
    a, b = Vector(a), Vector(b); ax = (b - a); L = ax.length; ax.normalize()
    u = ax.cross(Vector((0, 1, 0)) if abs(ax.y) < 0.9 else Vector((1, 0, 0))).normalized(); w = ax.cross(u)
    bm = bmesh.new(); rows = []
    for i in range(rings + 1):
        t = i / rings; r = ra + (rb - ra) * t; bulge = 1 + 0.08 * math.sin(t * math.pi); row = []
        for k in range(seg):
            q = k / seg * 2 * math.pi
            row.append(bm.verts.new(a + ax * (L * t) + (u * math.cos(q) * sq[0] + w * math.sin(q) * sq[1]) * r * bulge))
        rows.append(row)
    uvl = UVL(bm)
    for i in range(rings):
        for k in range(seg):
            f = bm.faces.new((rows[i][k], rows[i][(k + 1) % seg], rows[i + 1][(k + 1) % seg], rows[i + 1][k]))
            for l, uv in zip(f.loops, ((k / seg, i / rings), ((k + 1) / seg, i / rings), ((k + 1) / seg, (i + 1) / rings), (k / seg, (i + 1) / rings))): l[uvl].uv = uv
    for f in (bm.faces.new(rows[0][::-1]), bm.faces.new(rows[-1])):
        for l in f.loops: l[uvl].uv = (0.5, 0.5)
    return new_obj(name, bm, material, bone)

# ───────── torso (leather top + pants, V-neck to skin) via skin modifier ─────────
chain = [((0, 0.002, 0.47), (0.07, 0.05)), ((0, 0, 0.53), (0.082, 0.058)), ((0, 0, 0.6), (0.064, 0.047)), ((0, 0, 0.65), (0.058, 0.044)),
         ((0, -0.006, 0.725), (0.07, 0.06)), ((0, 0, 0.775), (0.082, 0.048)), ((0, 0, 0.81), (0.06, 0.04)), ((0, 0, 0.84), (0.024, 0.024))]
me = bpy.data.meshes.new('Torso'); me.from_pydata([c for c, r in chain], [(i, i + 1) for i in range(len(chain) - 1)], [])
torso = bpy.data.objects.new('Torso', me); scn.collection.objects.link(torso)
sk = torso.modifiers.new('Skin', 'SKIN')
for i, (c, r) in enumerate(chain): me.skin_vertices[0].data[i].radius = r
me.skin_vertices[0].data[0].use_root = True
torso.modifiers.new('Sub', 'SUBSURF').levels = 2
sel(torso); bpy.ops.object.modifier_apply(modifier='Skin'); bpy.ops.object.modifier_apply(modifier='Sub')
me = torso.data; me.materials.append(M['torso'])
me.uv_layers.new(name='UVMap'); uvd = me.uv_layers['UVMap'].data
for poly in me.polygons:   # cylindrical: u = azimuth (front at .5), v = height (painted by make_nova_textures.py)
    us = []
    for li in poly.loop_indices:
        c = me.vertices[me.loops[li].vertex_index].co
        us.append([0.5 + math.atan2(c.x, -c.y) / (2 * math.pi), (c.z - 0.44) / 0.42])
    if max(u[0] for u in us) - min(u[0] for u in us) > 0.5:
        for u in us:
            if u[0] < 0.5: u[0] += 1
    for li, u in zip(poly.loop_indices, us): uvd[li].uv = u
def is_skin(c):
    ax = abs(c.x)
    if c.z > 0.818: return True                                       # neck stub
    if c.y < 0 and c.z > 0.695 + ax * 2.1 and ax < 0.05: return True  # V-neck
    if ax > 0.058 and c.z > 0.765: return True                        # armholes / bare shoulders
    if c.y > 0 and c.z > 0.79: return True                            # back neckline
    return False
for p in me.polygons: p.use_smooth = True
PARTS.append((torso, 'TORSO'))
for s in ():  ellipsoid('Bust', (s * 0.032, -0.03, 0.735), (0.032, 0.03, 0.03), 'leather', 'Spine', 14, 9)
# belt + buckle
tube('Belt', (0, 0, 0.555), (0, 0, 0.575), 0.0815, 0.08, 'leather', 'Hips', 24, 1, (1.0, 0.73))
bm = bmesh.new(); UVL(bm); bmesh.ops.create_cube(bm, size=1)
for v in bm.verts: v.co = Vector((v.co.x * 0.024, v.co.y * 0.006, v.co.z * 0.02)) + Vector((0, -0.062, 0.565))
new_obj('Buckle', bm, 'metal', 'Hips')
# neck
tube('Neck', (0, 0.003, 0.81), (0, 0.004, 0.885), 0.022, 0.02, 'skin', 'neck', 12, 2)

# ───────── head (adult proportions, sculpted sphere, equirect UV in the left half) ─────────
HC = Vector((0, -0.004, 0.93)); HR = 0.062
bm = bmesh.new(); UVL(bm); bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=26, radius=HR)
for v in bm.verts:
    d = v.co.normalized(); az = math.degrees(math.atan2(d.x, -d.y)); el = math.degrees(math.asin(max(-1, min(1, d.z))))
    p = Vector((v.co.x * 0.9, v.co.y * 1.02, v.co.z * 1.14))
    if el < 0:   # jaw taper toward a soft pointed chin
        t = min(1, -el / 80); p.x *= 1 - 0.32 * t; p.y *= 1 - 0.12 * t * (1 if d.y > 0 else 0.5)
    k = 1.0 + 0.09 * math.exp(-((az / 7) ** 2 + ((el + 10) / 8) ** 2))      # nose
    k += 0.02 * math.exp(-((az / 14) ** 2 + ((el + 22) / 4) ** 2))           # lips
    for s in (-1, 1): k -= 0.03 * math.exp(-(((az - s * 17) / 9) ** 2 + ((el - 1) / 7) ** 2))   # eye sockets
    k += 0.025 * math.exp(-(((abs(az) - 32) / 14) ** 2 + ((el + 8) / 10) ** 2))  # cheekbones
    v.co = HC + p * k
uvl = UVL(bm)
for f in bm.faces:
    us = []
    for l in f.loops:
        d = (l.vert.co - HC).normalized(); az = math.degrees(math.atan2(d.x, -d.y)); el = math.degrees(math.asin(max(-1, min(1, d.z / 1.0))))
        us.append([0.5 + az / 360, 0.5 + el / 180])
    if max(u[0] for u in us) - min(u[0] for u in us) > 0.5:
        for u in us:
            if u[0] < 0.5: u[0] += 1
    for l, u in zip(f.loops, us): l[uvl].uv = (min(u[0], 0.999) * 0.5, u[1])
head = new_obj('Head', bm, 'face', 'Head')
for s in (1, -1): ellipsoid('Ear', HC + Vector((s * HR * 0.9, 0.006, -0.004)), (0.007, 0.012, 0.017), 'skin', 'Head', 8, 6)
def hdir(az, el, r=1.0):
    a, e = math.radians(az), math.radians(el)
    return HC + Vector((math.sin(a) * math.cos(e) * HR * 0.9 * r, -math.cos(a) * math.cos(e) * HR * 1.02 * r, math.sin(e) * HR * 1.14 * r))

# ───────── hair: scalp cap + long strand cards ─────────
bm = bmesh.new(); UVL(bm); bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=18, radius=1.0)
uvl = UVL(bm)
def on_scalp(d):
    az = abs(math.degrees(math.atan2(d.x, -d.y))); el = math.degrees(math.asin(max(-1, min(1, d.z))))
    if az < 55: return el > 30 - 10 * (az / 55)
    if az < 100: return el > 10 - (az - 55) * 0.6
    return el > -40
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not on_scalp(v.co.normalized())], context='VERTS')
for v in bm.verts: v.co = HC + Vector((v.co.x * HR * 0.97, v.co.y * HR * 1.09, v.co.z * HR * 1.2 + 0.002))
for f in bm.faces:
    for l in f.loops: l[uvl].uv = (0.47 + 0.06 * random.random(), 0.2 + 0.6 * random.random())
new_obj('Scalp', bm, 'hair', 'Head')
CARDS = []   # list of point lists
def body_push(p):   # keep hair outside the torso/shoulders
    if p.z < 0.84:
        rx, ry = (0.1 if p.z > 0.76 else 0.085), 0.062
        e = (p.x / rx) ** 2 + (p.y / ry) ** 2
        if e < 1: k = 1 / math.sqrt(max(e, 1e-4)); p = Vector((p.x * k, p.y * k, p.z))
    return p
def card(az, el, length, out=0.01, sway=0.0, front=False):
    r0 = hdir(az, el, 1.06); n = (r0 - HC).normalized(); pts = [r0]; p = r0.copy()
    dirv = (n * 0.6 + Vector((0, 0, -1))).normalized(); seg = 9; step = length / seg
    for i in range(seg):
        g = min(1, (i + 1) / 3)
        dv = (dirv * (1 - g) + Vector((math.sin(math.radians(az)) * 0.12 + sway, (0.05 if not front else -0.18), -1)).normalized() * g).normalized()
        p = p + dv * step
        q = p - HC
        if p.z > HC.z - HR * 1.3:   # stay outside the head while falling past it
            hn = Vector((q.x / (HR * 1.0), q.y / (HR * 1.12), q.z / (HR * 1.25)))
            if hn.length < 1.05: p = HC + Vector((q.x, q.y, q.z)) * (1.05 / max(hn.length, 1e-3))
        p = body_push(p); pts.append(p.copy())
    CARDS.append((pts, front))
for i in range(30):   # back + sides: to mid-back
    az = -180 + (i + 0.5) * 360 / 30
    if abs(az) < 70: continue
    card(az + random.uniform(-4, 4), random.uniform(15, 45), random.uniform(0.33, 0.4), sway=random.uniform(-0.05, 0.05))
for s in (1, -1):   # long side locks falling in front of the shoulders to the chest
    for k in range(5):
        card(s * (80 + k * 6), 10 + k * 5, 0.27 + 0.02 * k, sway=s * 0.12, front=True)
for k in range(5):   # side-swept fringe across her right (−X) brow, down past the cheek
    card(-4 - k * 10, 62 - k * 2, 0.055 + 0.012 * k, sway=-0.3, front=False)
for k in range(4):
    card(12 + k * 12, 60, 0.05, sway=0.3, front=False)
bm = bmesh.new(); uvl = UVL(bm); dl = bm.verts.layers.deform.verify()
HAIR_W = []
for pts, front in CARDS:
    rows = []
    for i, p in enumerate(pts):
        t = i / (len(pts) - 1)
        tang = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        rad = (Vector((p.x, p.y, 0)) if p.z < 0.88 else (p - HC)); rad = rad.normalized() if rad.length > 1e-5 else Vector((0, 1, 0))
        side = tang.cross(rad).normalized(); w = 0.028 * (1 - 0.45 * t)
        rows.append((bm.verts.new(p - side * w), bm.verts.new(p + side * w), t))
    for i in range(len(rows) - 1):
        a, b, ta = rows[i]; c, d_, tb = rows[i + 1]
        f = bm.faces.new((a, b, d_, c))
        for l, uv in zip(f.loops, ((0, 1 - ta), (1, 1 - ta), (1, 1 - tb), (0, 1 - tb))): l[uvl].uv = uv
hair = new_obj('HairCards', bm, 'hair', 'HAIR')

# ───────── visor glasses + band ─────────
def arc_band(name, az0, az1, el0, el1, r, material, seg=14):
    bm = bmesh.new(); UVL(bm); rows = []
    for i in range(seg + 1):
        az = az0 + (az1 - az0) * i / seg
        rows.append((bm.verts.new(hdir(az, el0, r)), bm.verts.new(hdir(az, el1, r))))
    for i in range(seg): bm.faces.new((rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]))
    o = new_obj(name, bm, material, 'Head'); return o
arc_band('Visor', -42, 42, -9, 11, 1.2, 'visor', 16)
arc_band('VisorRim', -43, 43, 10, 13.5, 1.21, 'band', 16)
arc_band('BandL', 40, 178, 4, 12, 1.12, 'band', 12)
arc_band('BandR', -178, -40, 4, 12, 1.12, 'band', 12)

# ───────── arms: wooden segments + ball joints (shoulder, elbow, wrist) ─────────
for s, nm in ((1, 'Left'), (-1, 'Right')):
    sh, el, wr = Vector(sx(SH, s)), Vector(sx(EL, s)), Vector(sx(WR, s))
    ellipsoid('BallShoulder', sh + Vector((s * 0.004, 0, -0.004)), (0.026, 0.026, 0.026), 'wood', nm + 'Arm', 14, 9)
    tube('UpperArm', sh + (el - sh) * 0.12, el - (el - sh).normalized() * 0.012, 0.022, 0.017, 'wood', nm + 'Arm', 12, 3)
    ellipsoid('BallElbow', el, (0.0165, 0.0165, 0.0165), 'wood', nm + 'ForeArm', 12, 8)
    tube('ForeArm', el + (wr - el).normalized() * 0.012, wr - (wr - el).normalized() * 0.009, 0.0165, 0.0115, 'wood', nm + 'ForeArm', 12, 3)
    ellipsoid('BallWrist', wr, (0.0115, 0.0115, 0.0115), 'wood', nm + 'Hand', 10, 7)
    # hand: palm + four fingers + thumb (relaxed)
    pc = wr + Vector((s * 0.002, -0.002, -0.032))
    ellipsoid('Palm', pc, (0.008, 0.019, 0.022), 'wood', nm + 'Hand', 10, 7)
    for f in range(4):
        y0 = -0.012 + f * 0.008; base = pc + Vector((0, y0, -0.02))
        tube('Finger', base, base + Vector((-s * 0.004, -0.002, -0.026 + abs(f - 1.5) * 0.003)), 0.0036, 0.0029, 'wood', nm + 'Hand', 6, 1)
    tb = pc + Vector((-s * 0.004, -0.017, 0.004))
    tube('Thumb', tb, tb + Vector((-s * 0.006, -0.008, -0.016)), 0.004, 0.0032, 'wood', nm + 'Hand', 6, 1)
    if s == 1:   # white smartwatch on her left wrist
        wa = wr + (el - wr).normalized() * 0.016
        tube('WatchBand', wa - (el - wr).normalized() * 0.004, wa + (el - wr).normalized() * 0.004, 0.0135, 0.0135, 'watch', nm + 'ForeArm', 14, 1)
        bm = bmesh.new(); UVL(bm); bmesh.ops.create_cube(bm, size=1)
        for v in bm.verts: v.co = Vector((v.co.x * 0.006, v.co.y * 0.016, v.co.z * 0.019)) + wa + Vector((0.013, -0.002, 0))
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.0015, segments=1, affect='EDGES')
        new_obj('WatchCase', bm, 'watch', nm + 'ForeArm')
        bm = bmesh.new(); UVL(bm); bmesh.ops.create_cube(bm, size=1)
        for v in bm.verts: v.co = Vector((v.co.x * 0.001, v.co.y * 0.012, v.co.z * 0.015)) + wa + Vector((0.0165, -0.002, 0))
        new_obj('WatchFace', bm, 'band', nm + 'ForeArm')
# ───────── legs: leather pants, knee joint, ankle boots ─────────
for s, nm in ((1, 'Left'), (-1, 'Right')):
    hp, kn, an = Vector(sx(HIP, s)), Vector(sx(KN, s)), Vector(sx(AN, s))
    tube('Thigh', hp + Vector((0, 0, 0.015)), kn + Vector((0, 0, 0.01)), 0.046, 0.032, 'leather', nm + 'UpLeg', 14, 4)
    ellipsoid('Knee', kn, (0.031, 0.031, 0.03), 'leather', nm + 'Leg', 12, 8)
    tube('Shin', kn, an + Vector((0, 0, 0.03)), 0.03, 0.022, 'leather', nm + 'Leg', 12, 3)
    tube('BootShaft', an + Vector((0, 0, 0.04)), an + Vector((0, 0, -0.03)), 0.025, 0.023, 'band', nm + 'Leg', 12, 1)
    ellipsoid('Boot', an + Vector((0, -0.028, -0.036)), (0.024, 0.052, 0.02), 'band', nm + 'Foot', 14, 8)

# ───────── necklace: thin silver chain + red double-ended obelisk shard ─────────
CH0 = Vector((0, -0.064, 0.738))
pts = []
for i in range(25):
    t = i / 24; a = (t - 0.5) * 2 * math.pi * 0.98
    p = Vector((math.sin(a) * 0.027, -math.cos(a) * 0.022 + 0.004, 0.83))
    if p.y < 0: p = p.lerp(Vector((p.x * 0.3, CH0.y, CH0.z + 0.01)), (math.cos(a)) ** 1.5 * 0.95 if math.cos(a) > 0 else 0)
    pts.append(p)
cu = bpy.data.curves.new('Chain', 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = 0.0008; cu.bevel_resolution = 0
sp = cu.splines.new('POLY'); sp.points.add(len(pts) - 1); sp.use_cyclic_u = True
for i, p in enumerate(pts): sp.points[i].co = (*p, 1)
co = bpy.data.objects.new('Chain', cu); scn.collection.objects.link(co); sel(co); bpy.ops.object.convert(target='MESH')
co = bpy.context.object; co.data.materials.clear(); co.data.materials.append(M['metal']); PARTS.append((co, 'Spine'))
bm = bmesh.new(); UVL(bm); top = CH0 + Vector((0, -0.001, 0.0)); L, Wd = 0.034, 0.0058
ring = [bm.verts.new(top + Vector((math.cos(a) * Wd, math.sin(a) * Wd * 0.7 - 0.003, -L * 0.42))) for a in [k / 4 * 2 * math.pi + math.pi / 4 for k in range(4)]]
ring2 = [bm.verts.new(top + Vector((math.cos(a) * Wd * 0.9, math.sin(a) * Wd * 0.63 - 0.003, -L * 0.62))) for a in [k / 4 * 2 * math.pi + math.pi / 4 for k in range(4)]]
vt = bm.verts.new(top + Vector((0, -0.003, -0.002))); vb = bm.verts.new(top + Vector((0, -0.003, -L)))
for k in range(4):
    bm.faces.new((vt, ring[k], ring[(k + 1) % 4])); bm.faces.new((ring[(k + 1) % 4], ring[k], ring2[k], ring2[(k + 1) % 4]))
    bm.faces.new((ring2[(k + 1) % 4], ring2[k], vb))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
sh = new_obj('Shard', bm, 'shard', 'Spine')
for p in sh.data.polygons: p.use_smooth = False

# ───────── stool (static) ─────────
STOOL_H = 0.235
tube('StoolSeat', (0, 0, STOOL_H - 0.03), (0, 0, STOOL_H), 0.085, 0.085, 'stool', None, 20, 1)
for k in range(3):
    a = k / 3 * 2 * math.pi + 0.3
    tube('StoolLeg', (math.cos(a) * 0.055, math.sin(a) * 0.055, STOOL_H - 0.03), (math.cos(a) * 0.075, math.sin(a) * 0.075, 0), 0.008, 0.007, 'stool', None, 6, 1)
tube('StoolRing', (0, 0, 0.08), (0, 0, 0.088), 0.066, 0.066, 'metal', None, 16, 1)

# ───────── join + weights ─────────
UV_FIX = []
for o, b in PARTS:   # parts without UVs get one (glTF wants a consistent layout)
    if not o.data.uv_layers: o.data.uv_layers.new()
skinned = [(o, b) for o, b in PARTS if b is not None]; static = [o for o, b in PARTS if b is None]
for o, b in skinned:
    for n in J: o.vertex_groups.new(name=n)
    for v in o.data.vertices:
        if b == 'TORSO':
            z = v.co.z; ax = abs(v.co.x)
            def lin(z0, z1): return max(0, min(1, (z - z0) / (z1 - z0)))
            w = {'Hips': 1 - lin(0.56, 0.62), 'Spine02': lin(0.56, 0.62) * (1 - lin(0.64, 0.7)), 'Spine01': lin(0.64, 0.7) * (1 - lin(0.71, 0.76)),
                 'Spine': lin(0.71, 0.76) * (1 - lin(0.815, 0.84)), 'neck': lin(0.815, 0.84)}
            if z < 0.52 and ax > 0.03:   # crotch/hip edge follows the thighs a little
                side = 'LeftUpLeg' if v.co.x > 0 else 'RightUpLeg'; k = min(1, (0.52 - z) / 0.05) * min(1, (ax - 0.03) / 0.03) * 0.8
                for kk in w: w[kk] *= 1 - k
                w[side] = k
            for n, x in w.items():
                if x > 1e-3: o.vertex_groups[n].add([v.index], x, 'REPLACE')
        elif b == 'HAIR':
            z = v.co.z; k = max(0, min(1, (0.87 - z) / 0.06))
            o.vertex_groups['Head'].add([v.index], 1 - k * 0.85, 'REPLACE')
            if k > 0: o.vertex_groups['Spine'].add([v.index], k * 0.85, 'REPLACE')
        else:
            o.vertex_groups[b].add([v.index], 1.0, 'REPLACE')
sel(*[o for o, b in skinned]); bpy.ops.object.join(); body = bpy.context.object; body.name = 'NovaBody'
sel(*static); bpy.ops.object.join(); stool = bpy.context.object; stool.name = 'NovaStool'
mod = body.modifiers.new('Armature', 'ARMATURE'); mod.object = rig; body.parent = rig
stool.parent = rig
# merge duplicate material slots (join keeps one slot per object)
def dedupe(o):
    me = o.data; names = [m.name for m in me.materials]; uniq = list(dict.fromkeys(names))
    idx = [uniq.index(names[p.material_index]) for p in me.polygons]
    mats = [bpy.data.materials[n] for n in uniq]; me.materials.clear()
    for m in mats: me.materials.append(m)
    for p, i in zip(me.polygons, idx): p.material_index = i
dedupe(body); dedupe(stool)
tris = sum(len(p.vertices) - 2 for p in body.data.polygons) + sum(len(p.vertices) - 2 for p in stool.data.polygons)
print('[nova] tris', tris, 'materials', [m.name for m in body.data.materials])

# ───────── actions ─────────
rig.animation_data_create(); PB = rig.pose.bones; ORDER = list(J.keys())
for p in PB: p.rotation_mode = 'QUATERNION'
def N(*v): return Vector(v).normalized()
def mirror(d): return {(k.replace('Left', '#').replace('Right', 'Left').replace('#', 'Right')): Vector((-v.x, v.y, v.z)) for k, v in d.items()}
DROP = KN[2] - AN[2] + 0.04   # seated: hips come down to knee height (thighs level on the stool)
def apply_pose(d, drop=0.0):
    for n in ORDER:
        pb = PB[n]; pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
    bpy.context.view_layer.update()
    if drop:
        pb = PB['Hips']; Mx = pb.matrix.copy(); Mx.translation = Mx.translation + Vector((0, 0, -drop)); pb.matrix = Mx; bpy.context.view_layer.update()
    for n in ORDER:
        if n not in d: continue
        pb = PB[n]; bpy.context.view_layer.update()
        Mx = pb.matrix.copy(); R = Mx.to_3x3(); h = Mx.to_translation()
        q = (R @ Vector((0, 1, 0))).normalized().rotation_difference(d[n].normalized())
        pb.matrix = Matrix.Translation(h) @ (q.to_matrix() @ R).to_4x4()
    bpy.context.view_layer.update()
def key(frame):
    for p in PB: p.keyframe_insert('rotation_quaternion', frame=frame); p.keyframe_insert('location', frame=frame)
def action(name, frames, fn):
    act = bpy.data.actions.new(name); rig.animation_data.action = act
    for f in frames:
        d, drop = fn(f); apply_pose(d, drop); key(f)
    act.use_fake_user = True; return act
SIT = {'LeftUpLeg': N(0.12, -1, -0.02), 'LeftLeg': N(0.03, -0.12, -1), 'LeftFoot': N(0.04, -1, -0.15),
       'LeftArm': N(0.18, -0.38, -1), 'LeftForeArm': N(-0.12, -1, -0.32), 'LeftHand': N(-0.05, -0.55, -1)}
SIT.update(mirror(SIT))
SIT['RightLeg'] = N(-0.06, -0.3, -1); SIT['RightFoot'] = N(-0.06, -1, -0.1)   # one foot a little forward: relaxed, not mirrored
def sit(f):
    t = f / 96 * 2 * math.pi; d = dict(SIT)
    d.update({'Spine01': N(0, -0.04 * math.sin(t) - 0.03, 1), 'Spine': N(0, 0.02, 1), 'Head': N(0.04 * math.sin(t / 2), -0.06, 1)})
    return d, DROP
def wave(f):
    t = f / 32 * 2 * math.pi; d = dict(SIT)
    d.update({'RightArm': N(-1, -0.3, 0.25), 'RightForeArm': N(-0.25 + 0.45 * math.sin(t), -0.25, 1), 'RightHand': N(-0.2 + 0.3 * math.sin(t), -0.1, 1),
              'Head': N(-0.06, -0.04, 1), 'Spine01': N(0.03, -0.03, 1)})
    return d, DROP
A_SIT = action('Sit', range(0, 97, 8), sit)
A_WAVE = action('Wave', range(0, 33, 4), wave)
rig.animation_data.action = A_SIT
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(D, 'nova.blend'))
if '--no-export' not in sys.argv:
    os.makedirs(OUTDIR, exist_ok=True)
    rig.animation_data.action = None
    for p in PB: p.rotation_quaternion = (1, 0, 0, 0); p.location = (0, 0, 0)
    raw = GLB.replace('.glb', '.raw.glb'); sel(rig, body, stool)
    bpy.ops.export_scene.gltf(filepath=raw, export_format='GLB', use_selection=True, export_yup=True, export_skins=True,
        export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True, export_frame_step=2,
        export_image_format='WEBP', export_image_quality=85, export_cameras=False, export_lights=False, export_apply=False)
    import subprocess, shutil
    try:
        subprocess.run(['npx', '-y', 'gltfpack', '-i', raw, '-o', GLB, '-cc', '-kn', '-km', '-vp', '14', '-at', '12', '-ar', '12'], check=True, timeout=300); os.remove(raw)
    except Exception as e:
        print('[nova] gltfpack unavailable (%s)' % e); shutil.move(raw, GLB)
    print('[nova] exported', GLB, os.path.getsize(GLB))
