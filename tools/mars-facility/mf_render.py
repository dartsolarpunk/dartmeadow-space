# preview stills of the Valles Rim annex (Blender 4.2 headless, EEVEE):  blender -b /workspace/mf-out/mf-annex.blend -P tools/mars-facility/mf_render.py -- OUTDIR
import bpy, sys, os, math
from mathutils import Vector
out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else '/workspace/mf-out'
sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE_NEXT'; sc.render.resolution_x, sc.render.resolution_y = 1280, 720
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True; bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.85, 0.62, 0.48, 1); bg.inputs[1].default_value = 0.6
bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 20, -0.02)); g = bpy.context.object; m = bpy.data.materials.new('ground'); m.use_nodes = True
m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.55, 0.3, 0.18, 1); g.data.materials.append(m)
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sc.collection.objects.link(sun); sun.data.energy = 3.0; sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
# interior: show the baked vertex light (multiply base colour by Col) like the runtime's emissive fill
oi = bpy.data.objects.get('mf_int_src')
if oi and oi.data.color_attributes:
    for mt in oi.data.materials:
        if not mt or not mt.use_nodes or mt.name == 'mf_emit': continue
        nt = mt.node_tree; b = nt.nodes['Principled BSDF']; ca = nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name = 'Col'
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs[0].default_value = 1.0
        src = b.inputs['Base Color'].links[0].from_socket if b.inputs['Base Color'].links else None
        if src: nt.links.new(src, mix.inputs[6])
        else: mix.inputs[6].default_value = b.inputs['Base Color'].default_value
        nt.links.new(ca.outputs['Color'], mix.inputs[7]); nt.links.new(mix.outputs[2], b.inputs['Emission Color']); b.inputs['Emission Strength'].default_value = 0.7
def shot(name, loc, look, lens=24, sun_on=True):
    cam = bpy.data.objects.get('cam') or bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    if cam.name not in sc.collection.objects: sc.collection.objects.link(cam)
    cam.location = loc; d = Vector(look) - Vector(loc); cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler(); cam.data.lens = lens; sc.camera = cam
    sun.hide_render = not sun_on; bg.inputs[1].default_value = 0.6 if sun_on else 0.02
    sc.render.filepath = os.path.join(out, name); bpy.ops.render.render(write_still=True)
shot('mf-ext-front.png', (-30, -55, 18), (6, 12, 4), 22)
shot('mf-ext-door.png', (40, -40, 10), (14, 10, 5), 24)
shot('mf-int-hangar.png', (24, 3, 3), (6, 30, 4), 18, sun_on=False)
shot('mf-int-spine.png', (-14, 6, 1.7), (-14, 34, 1.5), 20, sun_on=False)
shot('mf-int-mess.png', (-1.5, 1.5, 2.2), (-10, 10, 0.8), 18, sun_on=False)
shot('mf-int-control.png', (-17, 10.5, 2.0), (-24, 1, 1.2), 18, sun_on=False)
