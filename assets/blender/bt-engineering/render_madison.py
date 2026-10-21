"""Turntable/pose renders of madison.blend (Cycles CPU).
  blender -b madison.blend --python render_madison.py -- <out.png> <azimuth_deg> <action|none> <frame> [samples] [--hair]"""
import bpy, sys, math, os
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
out, az, act, fr = a[0], float(a[1]), a[2], int(a[3]); spp = int(a[4]) if len(a) > 4 and a[4].isdigit() else 64
s = bpy.context.scene; rig = bpy.data.objects['Madison']
if act == 'none':
    rig.animation_data.action = None
    for p in rig.pose.bones: p.rotation_quaternion = (1, 0, 0, 0); p.location = (0, 0, 0)
else: rig.animation_data.action = bpy.data.actions[act]
s.frame_set(fr)
D = os.path.dirname(bpy.data.filepath)
hp = os.path.join(D, 'madison_hair_preview.py')
for o in bpy.data.objects:
    if o.name == 'MadisonHairPreview': o.hide_render = '--nohair' in a
tgt = Vector((0, 0, 0.55))
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); s.collection.objects.link(cam); s.camera = cam
r = 2.2; cam.location = tgt + Vector((math.sin(math.radians(az)) * r, -math.cos(math.radians(az)) * r, 0.25))
cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler(); cam.data.lens = 70
w = bpy.data.worlds.new('w'); s.world = w; w.use_nodes = True; bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.012, 0.012, 0.03, 1)
def L(n, col, e, off, size=1.0):
    o = bpy.data.objects.new(n, bpy.data.lights.new(n, 'AREA')); o.data.energy = e; o.data.color = col; o.data.size = size
    s.collection.objects.link(o); o.location = tgt + Vector(off); o.rotation_euler = (tgt - o.location).to_track_quat('-Z', 'Y').to_euler()
L('key', (1, 0.9, 0.8), 120, (1.2, -1.6, 1.2)); L('rimC', (0.3, 0.6, 1), 140, (-1.4, 1.2, 0.8)); L('rimM', (0.8, 0.3, 1), 90, (1.4, 1.0, 0.3)); L('fill', (0.7, 0.75, 1), 30, (-1.5, -1.2, 0.2), 2)
bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, 0)); fl = bpy.context.object
fm = bpy.data.materials.new('floor'); fm.use_nodes = True; fb = fm.node_tree.nodes['Principled BSDF']; fb.inputs['Base Color'].default_value = (0.02, 0.02, 0.025, 1); fb.inputs['Roughness'].default_value = 0.25; fl.data.materials.append(fm)
for o in bpy.data.objects:
    if o.name.startswith('MadisonCollider'): o.hide_render = True
s.render.engine = 'CYCLES'; s.cycles.samples = spp; s.cycles.use_denoising = True; s.render.resolution_x = 800; s.render.resolution_y = 1000
s.view_settings.view_transform = 'AgX'; s.view_settings.look = 'AgX - Medium High Contrast'
s.render.filepath = out; bpy.ops.render.render(write_still=True)
