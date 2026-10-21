"""Madison v2 — rigged felt plush doll (Blender 4.2, headless).

  python3 make_madison_textures.py
  blender -b --python build_madison.py            → madison.blend, ../../bt-engineering/madison.glb, madison_hair.bin, tex/madison_suit*.png

Doll units: standing height 1.0, facing -Y, her left = +X, feet at z=0 (the game scales/places her on the desk).
Body: skin-modifier armature mesh (subdivided), sculpted head (cheeks, nose, chin), glossy eyes with lashes,
mitten hands, chunky boots, front zipper, neon circuit piping (cyan + magenta/violet pairs) projected onto the suit.
Rig: root, Hips, Spine02, Spine01, Spine, neck, Head, L/R Shoulder/Arm/ForeArm/Hand, L/R UpLeg/Leg/Foot.
Actions: Idle, Sit, Run, Wave.  Hair: DHS1 strands for hair_strands.js (head-bone-local), see write_hair().
"""
import bpy, bmesh, math, os, sys, json, struct, random
from mathutils import Vector, Matrix, Quaternion, Euler
from mathutils.bvhtree import BVHTree
D = os.path.dirname(os.path.abspath(__file__)); TEX = os.path.join(D, 'tex')
OUTDIR = os.path.normpath(os.path.join(D, '..', '..', 'bt-engineering'))
GLB = os.path.join(OUTDIR, 'madison.glb'); HAIR = os.path.join(OUTDIR, 'madison_hair.bin')
random.seed(5)
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
def sel(*obs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]

# ───────── skeleton (also drives the skin-modifier body) ─────────
J = {  # name: (head, tail, parent)
 'Hips': ((0, 0, 0.345), (0, 0, 0.40), None), 'Spine02': ((0, 0, 0.40), (0, 0, 0.45), 'Hips'),
 'Spine01': ((0, 0, 0.45), (0, 0, 0.50), 'Spine02'), 'Spine': ((0, 0, 0.50), (0, 0, 0.545), 'Spine01'),
 'neck': ((0, 0, 0.545), (0, 0, 0.585), 'Spine'), 'Head': ((0, 0, 0.585), (0, 0, 0.98), 'neck'),
}
for s, nm in ((1, 'Left'), (-1, 'Right')):
    J[nm + 'Shoulder'] = ((s * 0.02, 0, 0.525), (s * 0.085, 0, 0.53), 'Spine')
    J[nm + 'Arm'] = ((s * 0.085, 0, 0.53), (s * 0.145, -0.005, 0.435), nm + 'Shoulder')
    J[nm + 'ForeArm'] = ((s * 0.145, -0.005, 0.435), (s * 0.175, -0.02, 0.345), nm + 'Arm')
    J[nm + 'Hand'] = ((s * 0.175, -0.02, 0.345), (s * 0.185, -0.03, 0.29), nm + 'ForeArm')
    J[nm + 'UpLeg'] = ((s * 0.052, 0, 0.345), (s * 0.058, 0, 0.2), 'Hips')
    J[nm + 'Leg'] = ((s * 0.058, 0, 0.2), (s * 0.06, 0.0, 0.075), nm + 'UpLeg')
    J[nm + 'Foot'] = ((s * 0.06, 0.0, 0.075), (s * 0.062, -0.09, 0.035), nm + 'Leg')
arm_d = bpy.data.armatures.new('MadisonRig'); rig = bpy.data.objects.new('Madison', arm_d); scn.collection.objects.link(rig)
sel(rig); bpy.ops.object.mode_set(mode='EDIT')
eb = {}
for n, (h, t, p) in J.items():
    b = arm_d.edit_bones.new(n); b.head = h; b.tail = t; eb[n] = b
for n, (h, t, p) in J.items():
    if p: eb[n].parent = eb[p]; eb[n].use_connect = (Vector(J[p][1]) - Vector(h)).length < 1e-6
bpy.ops.object.mode_set(mode='OBJECT')

# ───────── body: skin modifier on a joint graph ─────────
R = {  # joint radii (x, y)
 'pelvis': (0.095, 0.075), 'waist': (0.082, 0.066), 'chest': (0.09, 0.07), 'neckb': (0.032, 0.03), 'necktop': (0.03, 0.03),
 'sh': (0.042, 0.04), 'elb': (0.035, 0.035), 'wri': (0.031, 0.031), 'hip': (0.052, 0.05), 'knee': (0.043, 0.043), 'ank': (0.038, 0.038),
}
verts, edges, rad = [], [], []
def V(p, r):
    verts.append(p); rad.append(r); return len(verts) - 1
pel = V((0, 0, 0.34), R['pelvis']); wai = V((0, 0, 0.42), R['waist']); che = V((0, 0, 0.5), R['chest'])
nb = V((0, 0, 0.55), R['neckb']); nt = V((0, 0, 0.6), R['necktop'])
edges += [(pel, wai), (wai, che), (che, nb), (nb, nt)]
for s in (1, -1):
    sh = V((s * 0.085, 0, 0.525), R['sh']); el = V((s * 0.145, -0.005, 0.435), R['elb']); wr = V((s * 0.175, -0.02, 0.35), R['wri'])
    edges += [(che, sh), (sh, el), (el, wr)]
    hp = V((s * 0.05, 0, 0.33), R['hip']); kn = V((s * 0.058, 0, 0.2), R['knee']); an = V((s * 0.06, 0, 0.09), R['ank'])
    edges += [(pel, hp), (hp, kn), (kn, an)]
me = bpy.data.meshes.new('Body'); me.from_pydata(verts, edges, []); body = bpy.data.objects.new('Body', me); scn.collection.objects.link(body)
sk = body.modifiers.new('Skin', 'SKIN'); sk.use_smooth_shade = True
for i, r in enumerate(rad): me.skin_vertices[0].data[i].radius = r
me.skin_vertices[0].data[pel].use_root = True
ss = body.modifiers.new('Sub', 'SUBSURF'); ss.levels = 2; ss.render_levels = 2
sel(body); bpy.ops.object.modifier_apply(modifier='Skin'); bpy.ops.object.modifier_apply(modifier='Sub')
# mittens + boots + head (separate parts, joined later)
def sphere(name, r, loc, scale=(1, 1, 1), seg=24, ring=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=ring, radius=r, location=loc); o = bpy.context.object; o.name = name
    o.scale = scale; bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for p in o.data.polygons: p.use_smooth = True
    return o
parts = [body]
for s in (1, -1):
    parts.append(sphere('Mitten', 0.042, (s * 0.182, -0.028, 0.31), (0.95, 0.9, 1.15), 20, 12))
    parts.append(sphere('Thumb', 0.018, (s * 0.165, -0.05, 0.325), (1, 1, 1.2), 12, 8))
    bt = sphere('Boot', 0.06, (s * 0.062, -0.03, 0.05), (0.95, 1.55, 0.85), 28, 16)
    bm = bmesh.new(); bm.from_mesh(bt.data)                     # flat sole
    for v in bm.verts:
        if v.co.z < 0.012: v.co.z = 0.012 - (0.012 - v.co.z) * 0.15
    bm.to_mesh(bt.data); bm.free(); parts.append(bt)
    parts.append(sphere('BootCuff', 0.047, (s * 0.06, -0.005, 0.105), (1, 1, 0.55), 24, 10))
# zipper: tape + pull
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.071, 0.47)); zp = bpy.context.object; zp.name = 'Zip'
zp.scale = (0.008, 0.006, 0.16); bpy.ops.object.transform_apply(scale=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.08, 0.535)); zt = bpy.context.object; zt.name = 'ZipPull'
zt.scale = (0.01, 0.006, 0.02); bpy.ops.object.transform_apply(scale=True)
# conform the zipper tape onto the chest curve (closest point)
bvb = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
for o in (zp, zt):
    for v in o.data.vertices:
        hit = bvb.find_nearest(Vector((0, -0.2, v.co.z)) if False else Vector((v.co.x, v.co.y, v.co.z)))
        loc, nrm = hit[0], hit[1]
        front = v.co.y < (zp.location.y if o is zp else zt.location.y) - 0.0
        v.co = loc + nrm * (0.0015 if o is zp else 0.006) + Vector((v.co.x, 0, 0)) * 0 + nrm * (0.003 if v.co.y < -0.073 else 0)

# ───────── head (sculpted sphere) ─────────
HC = Vector((0, -0.005, 0.765)); HR = 0.205
head = sphere('Head', HR, HC, (1.06, 0.98, 0.97), 64, 40)
def dirn(az, el):   # direction from head centre, az 0 = front (-Y), + = her left (+X)
    a, e = math.radians(az), math.radians(el)
    return Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
for v in head.data.vertices:
    p = v.co - HC; d = p.normalized()
    az = math.degrees(math.atan2(d.x, -d.y)); el = math.degrees(math.asin(max(-1, min(1, d.z))))
    k = 1.0
    if el < -5: k += 0.05 * math.exp(-((abs(az) - 40) / 30) ** 2) * min(1, (-5 - el) / 25)          # chubby cheeks
    if el < -35: k -= 0.06 * min(1, (-35 - el) / 30) * math.exp(-(az / 50) ** 2) * 0.5               # soft chin
    k += 0.065 * math.exp(-((az / 6.5) ** 2 + ((el + 11) / 7) ** 2))                                   # nose
    k += 0.012 * math.exp(-((az / 14) ** 2 + ((el + 25) / 4) ** 2))                                    # lips
    for s in (-1, 1): k -= 0.035 * math.exp(-(((az - s * 26) / 11) ** 2 + ((el + 3) / 10) ** 2))       # eye sockets
    v.co = HC + p * k
# UV: equirect, front at u=.5 (matches make_madison_textures.py)
bm = bmesh.new(); bm.from_mesh(head.data); uvl = bm.loops.layers.uv.verify()
for f in bm.faces:
    us = []
    for l in f.loops:
        d = (l.vert.co - HC).normalized(); az = math.degrees(math.atan2(d.x, -d.y)); el = math.degrees(math.asin(max(-1, min(1, d.z))))
        us.append([0.5 + az / 360, 0.5 + el / 180])
    if max(u[0] for u in us) - min(u[0] for u in us) > 0.5:      # back seam
        for u in us:
            if u[0] < 0.5: u[0] += 1
    for l, u in zip(f.loops, us): l[uvl].uv = u
bm.to_mesh(head.data); bm.free()
for s in (1, -1):   # ears
    parts.append(sphere('Ear', 0.03, HC + dirn(s * 92, -6) * HR * 1.0, (0.45, 0.8, 1.0), 12, 8))
# eyes: big glossy domes set into the sockets
eyes = []
for s in (1, -1):
    c = HC + dirn(s * 26, -4) * (HR * 0.88)
    e = sphere('Eye', 0.056, c, (1.0, 0.75, 1.05), 32, 20)
    n = dirn(s * 26, -4)
    bm = bmesh.new(); bm.from_mesh(e.data); uvl = bm.loops.layers.uv.verify()
    tx = Vector((n.y, -n.x, 0)).normalized() * -1 if s > 0 else Vector((n.y, -n.x, 0)).normalized() * -1
    tz = n.cross(tx).normalized() * -1
    for f in bm.faces:
        for l in f.loops:
            p = l.vert.co - c; l[uvl].uv = (0.5 + p.dot(tx) / 0.13, 0.5 + p.dot(Vector((0, 0, 1))) / 0.14)
    bm.to_mesh(e.data); bm.free(); eyes.append(e)
    # upper lid rim + lashes (tapered cards fanning out), lower lashes
    lash = []
    for k in range(22):
        t = k / 21; a = s * (26 + (t - 0.5) * 30); el = 2.0 + 6 * math.sin(t * math.pi)
        root = HC + dirn(a, el) * (HR * 0.93)
        out = (root - HC).normalized(); up = Vector((0, 0, 1))
        side = Vector((s * (t - 0.5) * 1.6, 0, 0))
        tip = root + out * 0.026 + up * (0.022 + 0.01 * math.sin(t * math.pi)) + side * 0.035
        lash.append((root, tip))
    for k in range(7):
        t = k / 6; a = s * (26 + (t - 0.5) * 22); el = -12.5 - 2 * math.sin(t * math.pi)
        root = HC + dirn(a, el) * (HR * 0.92); out = (root - HC).normalized()
        lash.append((root, root + out * 0.01 - Vector((0, 0, 0.008))))
    lm = bpy.data.meshes.new('Lash'); vv, ff = [], []
    for (r0, r1) in lash:
        w = (r1 - r0).cross(Vector((0, -1, 0))).normalized() * 0.0034
        i = len(vv); vv += [r0 - w, r0 + w, r1 + w * 0.2, r1 - w * 0.2]; ff.append((i, i + 1, i + 2, i + 3))
    lm.from_pydata(vv, [], ff); lo = bpy.data.objects.new('Lash', lm); scn.collection.objects.link(lo); parts.append(lo)
    # lid rim (dark felt arc above the eye)
    pts = [HC + dirn(s * (26 + (t - 0.5) * 34), 3 + 6.5 * math.sin(t * math.pi)) * (HR * 0.915) for t in [i / 16 for i in range(17)]]
    cu = bpy.data.curves.new('Lid', 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = 0.0062; cu.bevel_resolution = 1
    sp = cu.splines.new('POLY'); sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts): sp.points[i].co = (*p, 1)
    lo = bpy.data.objects.new('Lid', cu); scn.collection.objects.link(lo); sel(lo); bpy.ops.object.convert(target='MESH'); parts.append(bpy.context.object)
# scalp cap (hair-coloured, under the strands): front hairline + centre part
scalp = sphere('Scalp', HR * 1.035, HC, (1.06, 0.98, 0.97), 48, 28)
bm = bmesh.new(); bm.from_mesh(scalp.data)
def on_scalp(d):
    az = math.degrees(math.atan2(d.x, -d.y)); el = math.degrees(math.asin(max(-1, min(1, d.z))))
    if abs(az) < 62: return el > 30 - 16 * (abs(az) / 62) ** 2 and el > 22 - 0 * az   # hairline frames the face (forehead open)
    if abs(az) < 100: return el > -8 + (100 - abs(az)) * 0.5
    return el > -40
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not on_scalp((v.co - HC).normalized())], context='VERTS')
bm.to_mesh(scalp.data); bm.free()

# ───────── neon circuit piping, projected onto the suit ─────────
dg = bpy.context.evaluated_depsgraph_get()
tmp = [body] + [p for p in parts if p.name.startswith(('Boot', 'BootCuff'))]
def bvh_of(objs):
    vs, fs = [], []
    for o in objs:
        m = o.data; off = len(vs); vs += [o.matrix_world @ v.co for v in m.vertices]; fs += [[off + i for i in p.vertices] for p in m.polygons]
    return BVHTree.FromPolygons(vs, fs)
BVH = bvh_of(tmp)
def project(pts, lift=0.0035, n=6):
    out = []
    for a, b in zip(pts[:-1], pts[1:]):
        for k in range(n):
            p = Vector(a).lerp(Vector(b), k / n); hit = BVH.find_nearest(p)
            out.append(hit[0] + hit[1] * lift)
    hit = BVH.find_nearest(Vector(pts[-1])); out.append(hit[0] + hit[1] * lift)
    return out
NEON = []   # (points, colour index 0=cyan 1=magenta)
def pair(pts, off=(0.0065, 0, 0), first=1):
    NEON.append((project(pts), first)); NEON.append((project([tuple(Vector(p) + Vector(off)) for p in pts]), 1 - first))
for s in (1, -1):
    # chest: from the collar down in an angular circuit to the waist
    pair([(s * 0.03, -0.06, 0.545), (s * 0.028, -0.075, 0.51), (s * 0.05, -0.07, 0.48), (s * 0.05, -0.075, 0.44), (s * 0.03, -0.075, 0.41), (s * 0.03, -0.07, 0.37)], (s * 0.009, 0, 0))
    pair([(s * 0.07, -0.05, 0.53), (s * 0.06, -0.06, 0.5), (s * 0.072, -0.055, 0.46)], (s * 0.008, 0, 0), 0)
    # arms: shoulder → outer forearm → wrist cuff
    pair([(s * 0.07, -0.03, 0.548), (s * 0.115, -0.03, 0.5), (s * 0.15, -0.03, 0.44), (s * 0.17, -0.035, 0.39), (s * 0.18, -0.04, 0.36)], (0, 0, -0.008))
    # legs: hip → front thigh, kink at the knee → shin
    pair([(s * 0.075, -0.06, 0.36), (s * 0.06, -0.05, 0.3), (s * 0.07, -0.045, 0.24), (s * 0.06, -0.04, 0.2), (s * 0.075, -0.04, 0.16), (s * 0.065, -0.035, 0.12)], (s * 0.008, 0, 0))
    # boots: cuff ring + toe line
    ring = [(s * 0.06 + 0.05 * math.cos(a), -0.005 + 0.05 * math.sin(a), 0.112) for a in [i / 16 * 2 * math.pi for i in range(17)]]
    NEON.append((project(ring, 0.003, 2), 0))
    toe = [(s * 0.062 + 0.058 * math.cos(a), -0.03 + 0.092 * math.sin(a), 0.03) for a in [math.pi * (1 + i / 12) for i in range(13)]]
    NEON.append((project(toe, 0.003, 2), 1))
    pair([(s * 0.1, -0.03, 0.09), (s * 0.095, -0.08, 0.07), (s * 0.075, -0.12, 0.055)], (0, 0, 0.01))
ncu = bpy.data.curves.new('Neon', 'CURVE'); ncu.dimensions = '3D'; ncu.bevel_depth = 0.0019; ncu.bevel_resolution = 0
ncu.materials.append(None); ncu.materials.append(None)   # slots first, so spline.material_index sticks (filled below)
for pts, ci in NEON:
    sp = ncu.splines.new('POLY'); sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts): sp.points[i].co = (*p, 1)
    sp.material_index = ci
neon = bpy.data.objects.new('Neon', ncu); scn.collection.objects.link(neon)

# ───────── UVs for the suit: one shared layout (body + boots), island borders become stitched seams ─────────
suit_objs = [body] + [p for p in parts if p.name.startswith(('Boot', 'BootCuff'))]
sel(*suit_objs); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(52), island_margin=0.012); bpy.ops.object.mode_set(mode='OBJECT')
for o in [p for p in parts if p.name.startswith(('Mitten', 'Thumb'))]:
    sel(o); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.02); bpy.ops.object.mode_set(mode='OBJECT')
segs = []
for o in suit_objs:
    bm = bmesh.new(); bm.from_mesh(o.data); uvl = bm.loops.layers.uv.active
    for e in bm.edges:
        lf = e.link_loops
        def uvpair(l): return (tuple(l[uvl].uv), tuple(l.link_loop_next[uvl].uv))
        if len(lf) != 2: segs.append(uvpair(lf[0])); continue
        a0, a1 = uvpair(lf[0]); b0, b1 = uvpair(lf[1])
        if (Vector(a0) - Vector(b1)).length > 1e-4 or (Vector(a1) - Vector(b0)).length > 1e-4:
            segs.append((a0, a1)); segs.append((b0, b1))
    bm.free()
json.dump(segs, open(os.path.join(TEX, 'madison_seams.json'), 'w'))
import subprocess; subprocess.run(['python3', os.path.join(D, 'make_madison_textures.py'), '--seams'], check=True)
# ───────── materials ─────────
def img(n): return bpy.data.images.load(os.path.join(TEX, n), check_existing=True)
def felt(name, col=None, image=None, sheen=0.6, rough=0.95, nscale=6.0, nmap='madison_felt_n.png'):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough
    b.inputs['Sheen Weight'].default_value = sheen; b.inputs['Sheen Roughness'].default_value = 0.45
    if image:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = image; nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    else: b.inputs['Base Color'].default_value = col
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img(nmap); tn.image.colorspace_settings.name = 'Non-Color'
    mp = nt.nodes.new('ShaderNodeMapping'); tc = nt.nodes.new('ShaderNodeTexCoord'); mp.inputs['Scale'].default_value = (nscale, nscale, 1)
    nt.links.new(tc.outputs['UV'], mp.inputs['Vector']); nt.links.new(mp.outputs['Vector'], tn.inputs['Vector'])
    nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 0.8 if nscale > 1 else 0.4
    nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return m
def emit(name, col, s=2.6):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = col; b.inputs['Emission Color'].default_value = col; b.inputs['Emission Strength'].default_value = s
    return m
M_SUIT = felt('MAD_Suit', (0.012, 0.012, 0.014, 1), sheen=0.9, nscale=1.0, nmap='madison_suit_n.png')
M_SKIN = felt('MAD_Skin', image=img('madison_face.png'), sheen=0.5, nscale=8)
M_MIT = felt('MAD_Mitten', (0.82, 0.55, 0.42, 1), sheen=0.6)
M_HAIRCAP = felt('MAD_Scalp', (0.006, 0.016, 0.26, 1), sheen=0.1)
M_EYE = bpy.data.materials.new('MAD_Eye'); M_EYE.use_nodes = True
eb_ = M_EYE.node_tree.nodes['Principled BSDF']; et = M_EYE.node_tree.nodes.new('ShaderNodeTexImage'); et.image = img('madison_eye.png')
M_EYE.node_tree.links.new(et.outputs['Color'], eb_.inputs['Base Color']); eb_.inputs['Roughness'].default_value = 0.04; eb_.inputs['Coat Weight'].default_value = 1.0
M_LASH = felt('MAD_Lash', (0.02, 0.012, 0.01, 1), sheen=0.2)
M_ZIP = felt('MAD_Zip', (0.06, 0.06, 0.07, 1), sheen=0.3, rough=0.5)
M_NC = emit('MAD_NeonCyan', (0.1, 0.85, 1.0, 1)); M_NM = emit('MAD_NeonMagenta', (0.85, 0.15, 1.0, 1))
def setmat(o, m):
    o.data.materials.clear(); o.data.materials.append(m)
setmat(body, M_SUIT); setmat(head, M_SKIN); setmat(scalp, M_HAIRCAP); setmat(zp, M_ZIP); setmat(zt, M_ZIP)
for o in parts:
    if o.name.startswith(('Mitten', 'Thumb', 'Ear')): setmat(o, M_MIT if not o.name.startswith('Ear') else M_SKIN)
    elif o.name.startswith(('Boot',)): setmat(o, M_SUIT)
    elif o.name.startswith(('Lash', 'Lid')): setmat(o, M_LASH)
for e in eyes: setmat(e, M_EYE)
ncu.materials[0] = M_NC; ncu.materials[1] = M_NM
sel(neon); bpy.ops.object.convert(target='MESH'); neon = bpy.context.object
# ear UVs: sample face skin
for o in parts:
    if o.name.startswith('Ear'):
        uvd = o.data.uv_layers.active.data
        for l in uvd: l.uv = (0.25, 0.5)

# ───────── weights ─────────
head_parts = [head, scalp] + eyes + [p for p in parts if p.name.startswith(('Ear', 'Lash', 'Lid'))]
acc = [zp, zt, neon] + [p for p in parts if p.name.startswith(('Mitten', 'Thumb', 'Boot', 'BootCuff'))]
sel(body, rig); bpy.context.view_layer.objects.active = rig; bpy.ops.object.parent_set(type='ARMATURE_AUTO')
RIGID = {'Mitten': 'Hand', 'Thumb': 'Hand', 'BootCuff': 'Leg', 'Boot': 'Foot'}
for o in list(acc):   # rigid felt parts ride one bone
    pre = next((k for k in RIGID if o.name.startswith(k)), None)
    if not pre: continue
    side = 'Left' if sum(v.co.x for v in o.data.vertices) > 0 else 'Right'
    g_ = o.vertex_groups.new(name=side + RIGID[pre]); g_.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
for o in acc:   # copy the body's skin weights onto everything else worn on it (piping, zipper)
    if any(o.name.startswith(k) for k in RIGID): continue
    for vg_ in body.vertex_groups: o.vertex_groups.new(name=vg_.name)
    dt = o.modifiers.new('W', 'DATA_TRANSFER'); dt.object = body; dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}; dt.vert_mapping = 'POLYINTERP_NEAREST'
    dt.layers_vgroup_select_src = 'ALL'; dt.layers_vgroup_select_dst = 'NAME'
    sel(o); bpy.ops.object.modifier_apply(modifier='W')
sel(body, *acc); bpy.context.view_layer.objects.active = body; bpy.ops.object.join(); body = bpy.context.object
sel(*head_parts); bpy.context.view_layer.objects.active = head; bpy.ops.object.join(); head = bpy.context.object; head.name = 'MadisonHead'
vg = head.vertex_groups.new(name='Head'); vg.add(list(range(len(head.data.vertices))), 1.0, 'REPLACE')
sel(body, head); bpy.context.view_layer.objects.active = body; bpy.ops.object.join(); body = bpy.context.object; body.name = 'MadisonDoll'
# collision proxy (hidden in game): head sphere + torso capsule + hips, as a simple low-poly hull, weighted to bones
proxy = []
for nm, c, r in (('Head', HC, HR * 1.02), ('Spine01', (0, 0, 0.47), 0.085), ('Hips', (0, 0, 0.35), 0.09)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=r, location=c); o = bpy.context.object; o.name = 'MadisonCollider_' + nm
    vg = o.vertex_groups.new(name=nm); vg.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE'); proxy.append(o)
sel(*proxy); bpy.ops.object.join(); col = bpy.context.object; col.name = 'MadisonCollider'
sel(col, rig); bpy.context.view_layer.objects.active = rig; bpy.ops.object.parent_set(type='ARMATURE_NAME')
col.data.materials.append(M_SUIT)
tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
print('[mad] doll tris', tris)

# ───────── v2: merge to an atlas — MAD_Felt (one felt material), MAD_Neon (2-texel emissive), MAD_Eye ─────────
import subprocess
subprocess.run(['python3', os.path.join(D, 'make_madison_textures.py'), '--atlas'], check=True)
A_COL, A_N = img('madison_atlas.png'), img('madison_atlas_n.png'); A_N.colorspace_settings.name = 'Non-Color'
M_FELT = bpy.data.materials.new('MAD_Felt'); M_FELT.use_nodes = True; nt = M_FELT.node_tree; bsdf = nt.nodes['Principled BSDF']
tcol = nt.nodes.new('ShaderNodeTexImage'); tcol.image = A_COL; nt.links.new(tcol.outputs['Color'], bsdf.inputs['Base Color'])
tn_ = nt.nodes.new('ShaderNodeTexImage'); tn_.image = A_N; nmap = nt.nodes.new('ShaderNodeNormalMap'); nmap.inputs['Strength'].default_value = 0.55
nt.links.new(tn_.outputs['Color'], nmap.inputs['Color']); nt.links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
bsdf.inputs['Roughness'].default_value = 0.92; bsdf.inputs['Sheen Weight'].default_value = 0.7; bsdf.inputs['Sheen Roughness'].default_value = 0.5
bsdf.inputs['Sheen Tint'].default_value = (1.0, 0.82, 0.7, 1)
nt.links.new(tcol.outputs['Color'], bsdf.inputs['Emission Color']); bsdf.inputs['Emission Strength'].default_value = 0.0   # game sets warmth
M_NEON = bpy.data.materials.new('MAD_Neon'); M_NEON.use_nodes = True; nn = M_NEON.node_tree; nb = nn.nodes['Principled BSDF']
tne = nn.nodes.new('ShaderNodeTexImage'); tne.image = img('madison_neon.png'); tne.interpolation = 'Closest'
nn.links.new(tne.outputs['Color'], nb.inputs['Base Color']); nn.links.new(tne.outputs['Color'], nb.inputs['Emission Color']); nb.inputs['Emission Strength'].default_value = 1.4
eyb = M_EYE.node_tree.nodes['Principled BSDF']; eyb.inputs['Coat Weight'].default_value = 1.0; eyb.inputs['Coat Roughness'].default_value = 0.02
PATCH_I = {'MAD_Mitten': 0, 'MAD_Zip': 1, 'MAD_Lash': 2, 'MAD_Scalp': 3}
me_ = body.data; uvd = me_.uv_layers.active.data
slot = [s_.material.name if s_.material else '' for s_ in body.material_slots]
for poly in me_.polygons:
    mn_ = slot[poly.material_index]
    for li in poly.loop_indices:
        u, v = uvd[li].uv
        if mn_ == 'MAD_Suit': uvd[li].uv = (u * 0.5, v)
        elif mn_ == 'MAD_Skin': uvd[li].uv = (0.5 + min(max(u, 0), 1) * 0.5, 0.5 + min(max(v, 0), 1) * 0.5)
        elif mn_ in PATCH_I:
            i = PATCH_I[mn_]; uu = (u % 1.0) if mn_ != 'MAD_Lash' else 0.5; vv = (v % 1.0) if mn_ != 'MAD_Lash' else 0.5
            uvd[li].uv = (0.5 + (i + 0.06 + 0.88 * uu) * 0.125, 0.03 + 0.44 * vv)
        elif mn_ == 'MAD_NeonCyan': uvd[li].uv = (0.25, 0.5)
        elif mn_ == 'MAD_NeonMagenta': uvd[li].uv = (0.75, 0.5)
newmats = [M_FELT, M_NEON, M_EYE]
remap = {i: (2 if n == 'MAD_Eye' else 1 if n.startswith('MAD_Neon') else 0) for i, n in enumerate(slot)}
idx = [remap[p.material_index] for p in me_.polygons]
me_.materials.clear()
for m in newmats: me_.materials.append(m)
for p, i in zip(me_.polygons, idx): p.material_index = i
col.data.materials.clear(); col.data.materials.append(M_FELT)
print('[mad] materials:', [m.name for m in me_.materials])

# ───────── actions (poses authored as armature-space bone directions) ─────────
rig.animation_data_create()
PB = rig.pose.bones; ORDER = list(J.keys())
for p in PB: p.rotation_mode = 'QUATERNION'
def N(*v): return Vector(v).normalized()
def mirror(d): return {(k.replace('Left', '#').replace('Right', 'Left').replace('#', 'Right')): (Vector((-v.x, v.y, v.z)) if isinstance(v, Vector) else v) for k, v in d.items()}
def apply_pose(d, loc=(0, 0, 0)):
    for n in ORDER:
        pb = PB[n]; pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
    PB['Hips'].location = loc
    bpy.context.view_layer.update()
    for n in ORDER:
        if n not in d: continue
        pb = PB[n]; bpy.context.view_layer.update()
        M = pb.matrix.copy(); R = M.to_3x3(); h = M.to_translation()
        q = (R @ Vector((0, 1, 0))).normalized().rotation_difference(d[n].normalized())
        pb.matrix = Matrix.Translation(h) @ (q.to_matrix() @ R).to_4x4()
    bpy.context.view_layer.update()
def key(frame):
    for p in PB: p.keyframe_insert('rotation_quaternion', frame=frame); p.keyframe_insert('location', frame=frame)
def lerpd(a, b, t): return {k: a[k].lerp(b[k], t) for k in a}
def action(name, frames, fn):
    act = bpy.data.actions.new(name); rig.animation_data.action = act
    for f in frames:
        d, loc = fn(f); apply_pose(d, loc); key(f)
    act.use_fake_user = True
    return act
REST_ARM = {'LeftArm': N(0.55, -0.05, -1), 'LeftForeArm': N(0.3, -0.25, -1), 'RightArm': N(-0.55, -0.05, -1), 'RightForeArm': N(-0.3, -0.25, -1)}
def idle(f):
    t = f / 72 * 2 * math.pi
    d = dict(REST_ARM); d.update({'Spine01': N(0.02 * math.sin(t / 2), -0.02 * math.sin(t), 1), 'Head': N(0.06 * math.sin(t / 2), -0.04 * math.sin(t + 1), 1),
              'LeftArm': N(0.55, -0.05 + 0.04 * math.sin(t), -1), 'RightArm': N(-0.55, -0.05 - 0.04 * math.sin(t), -1)})
    return d, (0, 0, 0.003 * math.sin(t))
SIT = {'LeftUpLeg': N(0.12, -1, -0.04), 'LeftLeg': N(0.02, -0.25, -1), 'LeftFoot': N(0.05, -1, -0.2),
       'LeftArm': N(0.45, -0.55, -0.75), 'LeftForeArm': N(0.1, -1, -0.35)}
SIT.update(mirror(SIT))
def sit(f):
    t = f / 96 * 2 * math.pi; d = dict(SIT)
    d.update({'Spine01': N(0, -0.03 * math.sin(t), 1), 'Head': N(0.07 * math.sin(t / 2), -0.08 - 0.03 * math.sin(t + 1), 1)})
    return d, (0, 0, 0)
RUN_A = {'Spine01': N(0, -0.22, 1), 'Head': N(0, -0.05, 1),
         'LeftUpLeg': N(0.08, -0.85, -0.55), 'LeftLeg': N(0.03, 0.1, -1), 'LeftFoot': N(0, -1, -0.15),
         'RightUpLeg': N(-0.06, 0.55, -0.85), 'RightLeg': N(-0.03, 1, -0.35), 'RightFoot': N(0, 0.2, -1),
         'LeftArm': N(0.35, 0.65, -0.7), 'LeftForeArm': N(0.2, 0.15, -1),
         'RightArm': N(-0.3, -0.75, -0.55), 'RightForeArm': N(-0.15, -0.85, 0.45)}
RUN_B = mirror(RUN_A)
def run(f):
    ph = f / 20; t = 0.5 - 0.5 * math.cos(ph * 2 * math.pi)        # A → B → A
    return lerpd(RUN_A, RUN_B, t), (0, 0, 0.018 * abs(math.sin(ph * 2 * math.pi)))
def wave(f):
    t = f / 32 * 2 * math.pi; d = dict(REST_ARM)
    d.update({'RightArm': N(-1, -0.25, 0.2), 'RightForeArm': N(-0.2 + 0.45 * math.sin(t), -0.2, 1), 'Head': N(-0.08, -0.05, 1)})
    return d, (0, 0, 0)
A_IDLE = action('Idle', range(0, 73, 6), idle)
A_SIT = action('Sit', range(0, 97, 8), sit)
A_RUN = action('Run', range(0, 21, 2), run)
A_WAVE = action('Wave', range(0, 33, 4), wave)
RUN_POSE = (RUN_A, (0, 0, 0.01))
rig.animation_data.action = A_SIT
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(D, 'madison.blend'))
print('[mad] saved blend')

# ───────── export ─────────
if '--no-export' not in sys.argv:
    os.makedirs(OUTDIR, exist_ok=True)
    rig.animation_data.action = None
    for p in PB: p.rotation_quaternion = (1, 0, 0, 0); p.location = (0, 0, 0)
    raw = GLB.replace('.glb', '.raw.glb')
    sel(rig, body, col)
    bpy.ops.export_scene.gltf(filepath=raw, export_format='GLB', use_selection=True, export_yup=True, export_skins=True,
        export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True, export_frame_step=2,
        export_image_format='WEBP', export_image_quality=85, export_cameras=False, export_lights=False, export_apply=False)
    import subprocess, shutil
    try:
        subprocess.run(['npx', '-y', 'gltfpack', '-i', raw, '-o', GLB, '-cc', '-kn', '-km', '-vp', '14', '-at', '12', '-ar', '12'], check=True, timeout=300); os.remove(raw)
    except Exception as e:
        print('[mad] gltfpack unavailable (%s)' % e); shutil.move(raw, GLB)
    print('[mad] exported', GLB, os.path.getsize(GLB))
