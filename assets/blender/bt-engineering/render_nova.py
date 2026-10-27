"""Preview renders of nova.blend (EEVEE).
  blender -b nova.blend --python render_nova.py -- <out.png> <azimuth_deg> <action|none> <frame> [close]"""
import bpy, sys, math
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
out, az, act, fr = a[0], float(a[1]), a[2], int(a[3]); close = 'close' in a
s = bpy.context.scene; rig = bpy.data.objects['Nova']
if act == 'none':
    rig.animation_data.action = None
    for p in rig.pose.bones: p.rotation_quaternion = (1, 0, 0, 0); p.location = (0, 0, 0)
else: rig.animation_data.action = bpy.data.actions[act]
s.frame_set(fr)
tgt = Vector((0, 0, 0.62 if close else 0.4)) if act != 'none' else Vector((0, 0, 0.85 if close else 0.5))
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); s.collection.objects.link(cam); s.camera = cam
r = 0.9 if close else 2.4; cam.location = tgt + Vector((math.sin(math.radians(az)) * r, -math.cos(math.radians(az)) * r, 0.05))
cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler(); cam.data.lens = 70
w = bpy.data.worlds.new('w'); s.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs[0].default_value = (0.05, 0.05, 0.08, 1)
def L(n, col, e, off, size=1.0):
    o = bpy.data.objects.new(n, bpy.data.lights.new(n, 'AREA')); o.data.energy = e; o.data.color = col; o.data.size = size
    s.collection.objects.link(o); o.location = tgt + Vector(off); o.rotation_euler = (tgt - o.location).to_track_quat('-Z', 'Y').to_euler()
L('key', (1, 0.88, 0.75), 150, (1.0, -1.6, 1.2)); L('rim', (0.4, 0.6, 1), 120, (-1.4, 1.2, 0.8)); L('fill', (0.8, 0.8, 1), 40, (-1.5, -1.2, 0.2), 2)
s.render.engine = 'BLENDER_EEVEE_NEXT'; s.render.resolution_x = 480; s.render.resolution_y = 600
s.view_settings.view_transform = 'AgX'
s.render.filepath = out; bpy.ops.render.render(write_still=True)
