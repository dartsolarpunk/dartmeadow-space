"""Polaroid 'selfie' of Ariel (the game's own character GLB) with the Madison plush, rendered in the office.
  blender -b bt-engineering.blend --python render_selfie.py      → tex/selfie.png  (then compose_polaroid.py)"""
import bpy, os, math
from mathutils import Vector, Euler
D = os.path.dirname(os.path.abspath(bpy.data.filepath)); REPO = os.path.normpath(os.path.join(D, '..', '..', '..'))
s = bpy.context.scene
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=os.path.join(REPO, 'characterassests', 'Meshy_AI_Autumn_biped_Character_output.glb'))
new = [o for o in bpy.data.objects if o not in before]
for o in new:
    if o.name.startswith('Icosphere'): o.hide_render = True
arm = [o for o in new if o.type == 'ARMATURE'][0]

def add_hair(arm, every=2):
    """Her real groom: characterassests/ariel_hair_strands.bin (DHS1, head-bone-local, glTF y-up) → curves on the Head bone."""
    import struct, json
    from mathutils import Quaternion, Matrix
    raw = open(os.path.join(REPO, 'characterassests', 'ariel_hair_strands.bin'), 'rb').read()
    jl = struct.unpack('<I', raw[4:8])[0]; meta = json.loads(raw[12:12 + jl]); off = 12 + jl
    N, Kp = meta['count'], meta['points']
    pts = struct.unpack('<%df' % (N * Kp * 3), raw[off:off + N * Kp * 12])
    glb = open(os.path.join(REPO, 'characterassests', 'Meshy_AI_Autumn_biped_Character_output.glb'), 'rb').read()
    g = json.loads(glb[20:20 + struct.unpack('<I', glb[12:16])[0]]); nodes = g['nodes']; par = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []): par[c] = i
    i = [k for k, n in enumerate(nodes) if n.get('name') == 'Head'][0]; Mh = Matrix.Identity(4)
    while i is not None:
        n = nodes[i]; t = n.get('translation', [0, 0, 0]); r = n.get('rotation', [0, 0, 0, 1]); sc = n.get('scale', [1, 1, 1])
        Mn = Matrix.Translation(t) @ Quaternion((r[3], r[0], r[1], r[2])).to_matrix().to_4x4() @ Matrix.Diagonal((*sc, 1))
        Mh = Mn @ Mh; i = par.get(i)
    Y2Z = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    M = arm.matrix_world @ Y2Z @ Mh
    cu = bpy.data.curves.new('ArielHair', 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = 0.0011; cu.bevel_resolution = 0
    for sidx in range(0, N, every):
        sp = cu.splines.new('POLY'); sp.points.add(Kp - 1)
        for k in range(Kp):
            o = (sidx * Kp + k) * 3; p = M @ Vector(pts[o:o + 3]); sp.points[k].co = (*p, 1)
            sp.points[k].radius = 1.0 - 0.7 * k / (Kp - 1)
    ob = bpy.data.objects.new('ArielHair', cu); s.collection.objects.link(ob)
    hm = bpy.data.materials.new('ArielHairMat'); hm.use_nodes = True; b = hm.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.012, 0.012, 0.016, 1); b.inputs['Roughness'].default_value = 0.45
    cu.materials.append(hm)
    ob.parent = arm; ob.parent_type = 'BONE'; ob.parent_bone = 'Head'
    bpy.context.view_layer.update()
    ob.matrix_parent_inverse = (arm.matrix_world @ arm.pose.bones['Head'].matrix @ Matrix.Translation((0, arm.data.bones['Head'].length, 0))).inverted()
    return ob
add_hair(arm)
root = [o for o in new if o.parent is None]
K = 4.14 / 1.7                                       # her in-game height in temple units
spot = Vector((-5.3, 88.75, -22.5))                    # standing in front of the desk
for o in root:
    o.scale = (K, K, K); o.location = spot; o.rotation_euler = (0, 0, math.radians(200))
bpy.context.view_layer.update()
bpy.context.view_layer.objects.active = arm; bpy.ops.object.mode_set(mode='POSE')
pb = arm.pose.bones
def rot(b, x=0, y=0, z=0):
    pb[b].rotation_mode = 'XYZ'; pb[b].rotation_euler = Euler((math.radians(x), math.radians(y), math.radians(z)))
rot('LeftArm', 0, 0, 0); rot('RightArm', 0, 0, 0)
import sys
A = [float(v) for v in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])] or [0, 0, 88, 0, 0, -88]
rot('LeftArm', A[0], A[1], A[2]); rot('RightArm', A[3], A[4], A[5])
if len(A) > 6: rot('LeftForeArm', A[6], A[7], A[8]); rot('RightForeArm', A[9], A[10], A[11])
if len(A) > 12: rot('Head', A[12], A[13], A[14])
bpy.ops.object.mode_set(mode='OBJECT'); bpy.context.view_layer.update()
head = arm.matrix_world @ pb['Head'].head
lsh = arm.matrix_world @ pb['LeftArm'].head; rsh = arm.matrix_world @ pb['RightArm'].head
# Madison sits on her shoulder (the one nearer the camera's left)
mad = bpy.data.objects['Madison']
sh = lsh if lsh.x < rsh.x else rsh
mad.location = sh + Vector((0, 0, -0.06)); mad.rotation_euler = (0, 0, math.radians(200 - 180 + 8))
# camera at arm's length, slightly above, looking at both faces
mid = (head + mad.location + Vector((0, 0, 0.45))) / 2 + Vector((0, 0, 0.1))
cam = bpy.data.objects.new('SelfieCam', bpy.data.cameras.new('SelfieCam')); s.collection.objects.link(cam); s.camera = cam
fwd = Vector((math.sin(math.radians(200)) * -1, math.cos(math.radians(200)) * -1, 0))   # her facing direction
fwd = (Matrix := None) or Vector((-math.sin(math.radians(200)), math.cos(math.radians(200)), 0))
camp = mid - fwd * 1.55 + Vector((0.12, 0, 0.25))
camp = mid + Vector((0.18, -1.05, 0.22))
cam.location = camp; cam.rotation_euler = (mid - camp).to_track_quat('-Z', 'Y').to_euler(); cam.data.lens = 30
w = bpy.data.worlds.new('w'); s.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs[0].default_value = (0.02, 0.03, 0.06, 1)
def light(name, col, e, off, size=1.2):
    L = bpy.data.objects.new(name, bpy.data.lights.new(name, 'AREA')); L.data.energy = e; L.data.size = size; L.data.color = col
    s.collection.objects.link(L); L.location = mid + Vector(off); L.rotation_euler = (mid - L.location).to_track_quat('-Z', 'Y').to_euler()
light('Key', (1, 0.92, 0.85), 260, (0.6, -1.8, 0.9))           # phone-flash-ish key
light('RimC', (0.3, 1, 0.95), 420, (-1.6, 0.8, 0.6))
light('RimM', (1, 0.3, 0.85), 420, (1.6, 0.9, 0.4))
s.render.engine = 'CYCLES'; s.cycles.samples = int(os.environ.get('BTE_SAMPLES', '96')); s.cycles.device = 'CPU'; s.cycles.use_denoising = True
s.render.resolution_x = 560; s.render.resolution_y = 560
s.view_settings.view_transform = 'AgX'; s.view_settings.look = 'AgX - Medium High Contrast'
s.render.filepath = os.path.join(D, 'tex', 'selfie.png'); bpy.ops.render.render(write_still=True)
print('[bte] selfie', head, mad.location)
