"""Madison's hair groom → DHS1 strands for hair_strands.js (+ a ribbon preview mesh in madison.blend for renders).
  blender -b madison.blend --python build_madison_hair.py      (after build_madison.py exported madison.glb)
Writes ../../bt-engineering/madison_hair.bin: positions in the glTF 'Head' joint frame (read from madison.glb), roots on
the scalp cap, long wavy royal-blue hair with violet ends/streaks (meta.gradient), and capsule colliders for her head,
neck/torso and shoulders (meta.colliders, bone-local) so the solver keeps the strands off her head and body."""
import bpy, bmesh, math, os, json, struct, random
from mathutils import Vector, Matrix, Quaternion
D = os.path.dirname(os.path.abspath(bpy.data.filepath)); OUT = os.path.normpath(os.path.join(D, '..', '..', 'bt-engineering'))
GLB = os.path.join(OUT, 'madison.glb'); BIN = os.path.join(OUT, 'madison_hair.bin')
HC = Vector((0, -0.005, 0.765)); HR = 0.205; CAP = Vector((1.06, 0.98, 0.97)) * 1.035     # same as build_madison.py
N, K, G = 1400, 14, 350
rnd = random.Random(21)

def dirn(az, el):
    a, e = math.radians(az), math.radians(el)
    return Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
def on_scalp(az, el):
    if abs(az) < 62: return el > 30 - 16 * (abs(az) / 62) ** 2
    if abs(az) < 100: return el > -8 + (100 - abs(az)) * 0.5
    return el > -40
def capP(d, extra=0.0): return HC + Vector((d.x * CAP.x, d.y * CAP.y, d.z * CAP.z)) * HR + d * extra
def slerp(a, b, t):
    q = a.rotation_difference(b); ax, ang = q.to_axis_angle(); return (Quaternion(ax, ang * t) @ a).normalized()

# roots: Fibonacci directions on the cap, shuffled (any prefix = uniform subset, as the solver expects)
roots = []; M_ = 9000
for i in range(M_):
    z = 1 - 2 * (i + 0.5) / M_; r = math.sqrt(1 - z * z); ph = i * math.pi * (3 - math.sqrt(5))
    d = Vector((r * math.cos(ph), r * math.sin(ph), z)); az = math.degrees(math.atan2(d.x, -d.y)); el = math.degrees(math.asin(z))
    if on_scalp(az, el): roots.append((d, az, el))
rnd.shuffle(roots); roots = roots[:N]
strands = []
for (d0, az, el) in roots:
    side = 1 if az > 0 else -1
    if abs(az) < 1.5: side = rnd.choice((-1, 1))
    # exit direction: front/top strands are combed away from the centre part, past the temples; back ones straight down
    if abs(az) < 120:
        az_e = side * max(abs(az) + 25, 78 + 30 * (1 - min(1, abs(az) / 120)) * rnd.random())
    else:
        az_e = az + rnd.uniform(-8, 8)
    de = dirn(az_e, -14 + rnd.uniform(-6, 4))
    L = rnd.uniform(0.52, 0.66) * (0.92 if abs(az) < 60 else 1.0)
    wav_a = rnd.uniform(0.018, 0.034); wav_f = rnd.uniform(1.8, 2.8); wav_p = rnd.uniform(0, 6.3)
    vol = rnd.uniform(0.07, 0.15)
    pts = []
    exit_t = 0.28
    Pe = None
    for k in range(K):
        s = (k / (K - 1)) ** 1.25 * L                    # root-dense spacing
        if s <= exit_t:
            t = s / exit_t; dd = slerp(d0, de, t)
            p = capP(dd, 0.002 + 0.03 * t * t)
            if k == 0: p = capP(d0, 0.003)
            pts.append(p); Pe = p
        else:
            u = (s - exit_t) / (L - exit_t)
            out = Vector((de.x, de.y, 0)).normalized()
            tang = Vector((-out.y, out.x, 0))
            p = Pe + Vector((0, 0, -(s - exit_t))) + out * (vol * u ** 0.8) + tang * (wav_a * u * math.sin(wav_f * u * 6.28 + wav_p)) \
                + out * (wav_a * 0.6 * u * math.cos(wav_f * u * 6.28 + wav_p))
            pts.append(p)
    strands.append(pts)

# ---------- glTF frames (read back from the exported GLB: Head joint world matrix at rest) ----------
b = open(GLB, 'rb').read(); g = json.loads(b[20:20 + struct.unpack('<I', b[12:16])[0]]); nodes = g['nodes']; par = {}
for i, n in enumerate(nodes):
    for c in n.get('children', []): par[c] = i
def world(name):
    i = [k for k, n in enumerate(nodes) if n.get('name') == name][0]; M = Matrix.Identity(4)
    while i is not None:
        n = nodes[i]
        if 'matrix' in n: Mn = Matrix([n['matrix'][r::4] for r in range(4)])
        else:
            t = n.get('translation', [0, 0, 0]); r = n.get('rotation', [0, 0, 0, 1]); sc = n.get('scale', [1, 1, 1])
            Mn = Matrix.Translation(t) @ Quaternion((r[3], r[0], r[1], r[2])).to_matrix().to_4x4() @ Matrix.Diagonal((*sc, 1))
        M = Mn @ M; i = par.get(i)
    return M
Z2Y = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))     # Blender world → glTF scene
Hinv = world('Head').inverted()
def head_local(p): return Hinv @ (Z2Y @ p)
def bone_local(bn, p): return world(bn).inverted() @ (Z2Y @ Vector(p))
rest = []
for pts in strands:
    for p in pts: rest += list(head_local(p))
# guides: every 4th strand of the shuffled list; children follow the nearest guide root
guides = list(range(0, N, N // G))[:G]
groot = [strands[i][0] for i in guides]
guideOf = []
for st in strands:
    r0 = st[0]; guideOf.append(min(range(G), key=lambda j: (groot[j] - r0).length_squared))
cols = [
    {'bone': 'Head', 'a': list(bone_local('Head', HC + Vector((0, 0.01, 0)))), 'b': list(bone_local('Head', HC + Vector((0, 0.01, 0)))), 'r': HR * 1.0},
    {'bone': 'neck', 'a': list(bone_local('neck', (0, 0, 0.53))), 'b': list(bone_local('neck', (0, 0, 0.6))), 'r': 0.045},
    {'bone': 'Spine01', 'a': list(bone_local('Spine01', (0, 0, 0.36))), 'b': list(bone_local('Spine01', (0, 0, 0.5))), 'r': 0.095},
    {'bone': 'Spine', 'a': list(bone_local('Spine', (-0.12, 0, 0.525))), 'b': list(bone_local('Spine', (0.12, 0, 0.525))), 'r': 0.05},
    {'bone': 'LeftArm', 'a': list(bone_local('LeftArm', (0.085, 0, 0.53))), 'b': list(bone_local('LeftArm', (0.145, -0.005, 0.435))), 'r': 0.045},
    {'bone': 'RightArm', 'a': list(bone_local('RightArm', (-0.085, 0, 0.53))), 'b': list(bone_local('RightArm', (-0.145, -0.005, 0.435))), 'r': 0.045},
]
meta = {'version': 2, 'count': N, 'points': K, 'guides': G, 'headBone': 'Head', 'space': 'head-local, glTF y-up, doll units (height 1.0)',
        'color': [0.02, 0.05, 0.5], 'roughness': 0.6, 'groups': ['hair'], 'colliders': cols,
        'headCenter': list(head_local(HC)),
        'gradient': {'root': [0.006, 0.018, 0.33], 'tip': [0.09, 0.02, 0.36], 'tipStart': 0.6, 'streak': [0.30, 0.06, 0.62], 'streakFrac': 0.3, 'streakStart': 0.3},
        'note': 'Madison plush (dm-bt-engineering.js). Built by assets/blender/bt-engineering/build_madison_hair.py'}
js = json.dumps(meta).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
with open(BIN, 'wb') as f:
    f.write(b'DHS1'); f.write(struct.pack('<II', len(js), 0)); f.write(js)
    f.write(struct.pack('<%df' % len(rest), *rest))
    f.write(bytes(N)); f.write(b'\0' * (((N + 3) & ~3) - N))
    f.write(struct.pack('<%dI' % N, *guideOf)); f.write(struct.pack('<%dI' % G, *guides))
print('[hair] wrote', BIN, os.path.getsize(BIN), 'strands', N, 'guides', G)

# ---------- preview ribbons in the .blend (renders only; not exported) ----------
if 'MadisonHairPreview' in bpy.data.objects: bpy.data.objects.remove(bpy.data.objects['MadisonHairPreview'])
me = bpy.data.meshes.new('MadisonHairPreview'); vs, fs, uvs = [], [], []
cam_side = Vector((1, 0, 0))
for si, pts in enumerate(strands):
    streak = rnd.random() < 0.3
    for k, p in enumerate(pts):
        tg = (pts[min(k + 1, K - 1)] - pts[max(k - 1, 0)]).normalized(); w = tg.cross((p - HC).normalized()).normalized() * (0.0065 - 0.0035 * k / (K - 1))
        vs += [p - w, p + w]; uvs += [(1.0 if streak else 0.0, k / (K - 1))] * 2
    o = si * K * 2
    for k in range(K - 1): fs.append((o + 2 * k, o + 2 * k + 1, o + 2 * k + 3, o + 2 * k + 2))
me.from_pydata(vs, [], fs); uvl = me.uv_layers.new()
for poly in me.polygons:
    for li in poly.loop_indices: uvl.data[li].uv = uvs[me.loops[li].vertex_index]
ob = bpy.data.objects.new('MadisonHairPreview', me); bpy.context.scene.collection.objects.link(ob)
rig = bpy.data.objects['Madison']; ob.parent = rig; ob.parent_type = 'BONE'; ob.parent_bone = 'Head'
bpy.context.view_layer.update()
ob.matrix_parent_inverse = (rig.matrix_world @ rig.pose.bones['Head'].matrix @ Matrix.Translation((0, rig.data.bones['Head'].length, 0))).inverted()
m = bpy.data.materials.new('HairPreview'); m.use_nodes = True; nt = m.node_tree; bs = nt.nodes['Principled BSDF']
tc = nt.nodes.new('ShaderNodeTexCoord'); sp = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(tc.outputs['UV'], sp.inputs[0])
r1 = nt.nodes.new('ShaderNodeValToRGB'); r1.color_ramp.elements[0].color = (0.006, 0.018, 0.33, 1); r1.color_ramp.elements[0].position = 0.5; r1.color_ramp.elements[1].color = (0.10, 0.035, 0.42, 1)
r2 = nt.nodes.new('ShaderNodeValToRGB'); r2.color_ramp.elements[0].color = (0.006, 0.018, 0.33, 1); r2.color_ramp.elements[0].position = 0.3; r2.color_ramp.elements[1].color = (0.30, 0.06, 0.62, 1)
nt.links.new(sp.outputs['Y'], r1.inputs[0]); nt.links.new(sp.outputs['Y'], r2.inputs[0])
mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; nt.links.new(sp.outputs['X'], mx.inputs['Factor'])
nt.links.new(r1.outputs['Color'], mx.inputs[6]); nt.links.new(r2.outputs['Color'], mx.inputs[7]); nt.links.new(mx.outputs[2], bs.inputs['Base Color'])
bs.inputs['Roughness'].default_value = 0.55; bs.inputs['Sheen Weight'].default_value = 0.15
me.materials.append(m)
bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
print('[hair] preview saved')
