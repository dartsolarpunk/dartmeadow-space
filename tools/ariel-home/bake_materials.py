"""Layered PBR materials for Ariel's mansion built with Ucupaint (Blender 4.2, add-on 'bl_ext.user_default.ucupaint' 3.0.0), baked to maps.
blender -b -P tools/ariel-home/bake_materials.py -- OUTDIR [--res 2048] [--only name,name] [--preview PREVIEWDIR]
Per material a Ucupaint stack is built headlessly: base -> texture variation (image layer) -> procedural variation/bump layers (noise,
voronoi, wave, musgrave) writing Color / Roughness / Height channels.  The group's Color / Roughness / Metallic / Height outputs are baked
(Cycles EMIT) on a UV plane to <name>-{color,rough,metal,height}-raw.png.  pack_textures.py then makes them seamless, bakes the displacement
into a tangent normal map (+ the generated seed normal) and the AO, and writes the GLB tiers <name>-{color,nrm,orm}-{1k,2k}.webp (ORM: R=AO G=rough
B=metal) plus <name>-height-1k.png.  Height drives REAL displacement in the renders only."""
import bpy, sys, os, types, math
import numpy as np
argv = sys.argv[sys.argv.index('--') + 1:]
OUT = argv[0]; RES = int(argv[argv.index('--res') + 1]) if '--res' in argv else 2048
ONLY = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
TEXSRC = argv[argv.index('--src') + 1] if '--src' in argv else '/workspace/w-ariel/tmp/tex'
os.makedirs(OUT, exist_ok=True)

# name: (base rgb, rough, metal, texture-seed or None, specs)  -- specs: list of layer dicts
# layer dict: kind NOISE/VORONOI/MUSGRAVE/WAVE/IMAGE, scale (x,y,z), color(Color influence 0..1), rough, height, bump, tint rgb, blend
MATSPEC = {
    'slate': dict(base=(0.05, 0.055, 0.062), rough=0.72, metal=0.0, seed='slate', layers=[
        dict(name='texture variation', kind='IMAGE', img='slate-color', color=0.9, blend='MIX'),
        dict(name='cleavage flakes', kind='NOISE', scale=(4, 34, 4), color=0.22, blend='OVERLAY', rough=0.18, height=0.55, bump=0.7),
        dict(name='weathering', kind='NOISE', scale=(1.6, 1.6, 1.6), color=0.2, blend='MULTIPLY', rough=0.1, height=0.0)]),
    'concrete': dict(base=(0.42, 0.41, 0.395), rough=0.82, metal=0.0, seed='concrete', layers=[
        dict(name='texture variation', kind='IMAGE', img='concrete-color', color=0.8, blend='MIX'),
        dict(name='pores', kind='VORONOI', scale=(26, 26, 26), color=0.5, blend='MULTIPLY', rough=0.0, height=0.5, bump=0.8),
        dict(name='staining', kind='NOISE', scale=(2.2, 0.35, 2.2), color=0.45, blend='MULTIPLY', rough=0.1, height=0.0, bump=0.0),]),
    'rock': dict(base=(0.16, 0.155, 0.15), rough=0.9, metal=0.0, seed='rock', layers=[
        dict(name='texture variation', kind='IMAGE', img='rock-color', color=0.85, blend='MIX'),
        dict(name='strata', kind='NOISE', scale=(1.5, 1.5, 9), color=0.3, tint=(0.07, 0.065, 0.06), blend='MULTIPLY', rough=0.1, height=0.5, bump=0.5),
        dict(name='cracks', kind='VORONOI', scale=(7, 7, 7), color=0.15, tint=(0.03, 0.03, 0.03), blend='MIX', rough=0.0, height=0.6, bump=0.9),]),
    'wood': dict(base=(0.30, 0.17, 0.085), rough=0.58, metal=0.0, seed='wood', layers=[
        dict(name='texture variation', kind='IMAGE', img='wood-color', color=0.9, blend='MIX'),
        dict(name='grain', kind='WAVE', scale=(1, 40, 1), color=0.25, tint=(0.12, 0.06, 0.03), blend='MULTIPLY', rough=0.15, height=0.4, bump=0.5),]),
    'dark': dict(base=(0.03, 0.033, 0.038), rough=0.32, metal=0.95, seed=None, layers=[
        dict(name='brushed', kind='NOISE', scale=(80, 1.2, 80), color=0.5, blend='OVERLAY', rough=0.3, height=0.3, bump=0.55),
        dict(name='wear', kind='NOISE', scale=(5, 5, 5), color=0.3, blend='MULTIPLY', rough=0.25, height=0.0, bump=0.0)]),
    'leaf': dict(base=(0.07, 0.19, 0.05), rough=0.62, metal=0.0, seed=None, layers=[
        dict(name='hue variation', kind='NOISE', scale=(7, 7, 7), color=0.55, blend='OVERLAY', rough=0.08, height=0.0, bump=0.0),
        dict(name='veins', kind='VORONOI', scale=(18, 18, 18), color=0.45, blend='MULTIPLY', rough=0.0, height=0.5, bump=0.9)]),
}
CHN = ['Color', 'Roughness', 'Metallic', 'Normal', 'Height']

def enable_uc():
    try: bpy.ops.preferences.addon_enable(module='bl_ext.user_default.ucupaint')
    except Exception as e: print('addon enable', e)

def new_uc_material(name, plane):
    m = bpy.data.materials.new(name); m.use_nodes = True; plane.data.materials.append(m); plane.active_material_index = 0
    bpy.context.view_layer.objects.active = plane
    from bl_ext.user_default.ucupaint import Root
    space = types.SimpleNamespace(edit_tree=m.node_tree, id=m, cursor_location=(0, 0), type='NODE_EDITOR')
    ctx = types.SimpleNamespace(space_data=space, window_manager=bpy.context.window_manager)
    Root.YNewYPaintNode.execute(None, ctx)
    g = [n for n in m.node_tree.nodes if n.type == 'GROUP'][0]; yp = g.node_tree.yp
    for nm, tp in (('Roughness', 'VALUE'), ('Metallic', 'VALUE'), ('Height', 'VALUE')):
        bpy.ops.wm.y_add_new_ypaint_channel(name=nm, type=tp)
    return m, g, yp

def setch(ly, nm, yp, **kw):
    idx = [c.name for c in yp.channels].index(nm); ch = ly.channels[idx]
    for k, v in kw.items(): setattr(ch, k, v)
    return ch

def sync(g, yp):
    # Python writes don't always push into the layer group's input sockets: mirror them explicitly
    import re
    for ly in yp.layers:
        n = g.node_tree.nodes[ly.group_node]
        for i in n.inputs:
            mt = re.match(r'\.channels\[(\d+)\]\.(\w+)$', i.name)
            if mt:
                v = getattr(ly.channels[int(mt.group(1))], mt.group(2), None)
                if isinstance(v, (int, float)): i.default_value = v
            elif i.name == '.intensity_value': i.default_value = ly.channels[0].intensity_value * 0 + 1.0

def fix_voronoi(g, yp):
    for ly in yp.layers:
        if ly.type != 'VORONOI': continue
        lt = g.node_tree.nodes[ly.group_node].node_tree
        for l in list(lt.links):
            if l.from_node.type == 'TEX_VORONOI' and l.from_socket.name == 'Color':
                lt.links.new(l.from_node.outputs['Distance'], l.to_socket)

def build(name, spec, plane):
    m, g, yp = new_uc_material('uc_' + name, plane)
    names = [c.name for c in yp.channels]
    # 1. base layer: colour, roughness, metallic as solid values
    bpy.ops.wm.y_new_layer(type='COLOR', name='base', solid_color=tuple(spec['base']))
    ly = yp.layers[0]
    for nm in names:
        ch = setch(ly, nm, yp, enable=nm in ('Color', 'Roughness', 'Metallic'))
    setch(ly, 'Roughness', yp, override=True, override_value=spec['rough']); setch(ly, 'Metallic', yp, override=True, override_value=spec['metal'])
    for L in spec['layers']:
        kind = L['kind']
        if kind == 'IMAGE':
            p = f"{TEXSRC}/{L['img']}-2k.webp"
            if not os.path.exists(p): p = f"{TEXSRC}/{L['img']}-1k.webp"
            bpy.ops.wm.y_open_image_to_layer.__call__ if False else None
            bpy.ops.wm.y_new_layer(type='IMAGE', name=f"{name}-{L['name']}", width=1024, height=1024)
        else:
            bpy.ops.wm.y_new_layer(type=kind, name=f"{name}-{L['name']}")
        ly = yp.layers[0]
        if 'scale' in L: ly.scale = L['scale']
        if kind == 'IMAGE':
            im = bpy.data.images.load(p); im.colorspace_settings.name = 'Non-Color' if 'nrm' in L['img'] else 'sRGB'
            g.node_tree.nodes[ly.group_node].node_tree.nodes[ly.source].image = im
        for nm in names: setch(ly, nm, yp, enable=False)
        if 'color' in L:
            if kind == 'IMAGE': setch(ly, 'Color', yp, enable=True, intensity_value=L['color'], blend_type=L.get('blend', 'MIX'))
            else: setch(ly, 'Color', yp, enable=True, intensity_value=L['color'], blend_type=L.get('blend', 'MIX'))
        if L.get('rough'): setch(ly, 'Roughness', yp, enable=True, intensity_value=L['rough'], blend_type='ADD')
        if L.get('height'): setch(ly, 'Height', yp, enable=True, intensity_value=L['height'], blend_type='ADD')
    sync(g, yp); fix_voronoi(g, yp)
    return m, g, yp

def bake_all(name, m, g, res, plane):
    nt = m.node_tree; out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    bsdf = [n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED']
    emit = nt.nodes.new('ShaderNodeEmission'); imn = nt.nodes.new('ShaderNodeTexImage')
    res_imgs = {}
    sc = bpy.context.scene; sc.render.engine = 'CYCLES'; sc.cycles.samples = 4; sc.cycles.device = 'CPU'
    sc.render.bake.use_pass_direct = False; sc.render.bake.use_pass_indirect = False; sc.render.bake.margin = 4
    bpy.context.view_layer.objects.active = plane; plane.select_set(True)
    def go(label, sock, typ='EMIT', cs='Non-Color'):
        im = bpy.data.images.new(f'{name}-{label}', res, res, float_buffer=(label == 'height')); im.colorspace_settings.name = cs
        imn.image = im; nt.nodes.active = imn
        if typ == 'EMIT':
            nt.links.new(g.outputs[sock], emit.inputs['Color']); nt.links.new(emit.outputs[0], out.inputs['Surface'])
            bpy.ops.object.bake(type='EMIT')
        else:
            nt.links.new(g.outputs['Normal'], bsdf[0].inputs['Normal']) if bsdf else None
            bpy.ops.object.bake(type='NORMAL')
        return im
    for lab, sock, cs in (('color', 'Color', 'sRGB'), ('rough', 'Roughness', 'Non-Color'), ('metal', 'Metallic', 'Non-Color'), ('height', 'Height', 'Non-Color')):
        res_imgs[lab] = go(lab, sock, cs=cs)
    return res_imgs, nt, out, imn, g

def px(im):
    a = np.array(im.pixels[:], dtype=np.float32).reshape(im.size[1], im.size[0], 4); return a

def seamless(a):
    n = a.shape[0]; t = np.abs(np.linspace(-1, 1, n)); w = 1 - t; w = (w ** 1.0)[:, None, None] * w[None, :, None]
    sh = np.roll(np.roll(a, n // 2, 0), n // 2, 1)
    # offset-blend: centre of a is untouched, edges come from the shifted copy (whose edges are its centre)
    return a * w + sh * (1 - w)

def main():
    enable_uc()
    bpy.ops.wm.read_factory_settings(use_empty=True); enable_uc()
    for name, spec in MATSPEC.items():
        if ONLY and name not in ONLY: continue
        bpy.ops.mesh.primitive_plane_add(size=2); plane = bpy.context.active_object   # UV 0..1
        m, g, yp = build(name, spec, plane)
        imgs, nt, outn, imn, g = bake_all(name, m, g, RES, plane)
        sc = bpy.context.scene; sc.render.image_settings.file_format = 'PNG'
        for lab, im in imgs.items():
            sc.render.image_settings.color_depth = '16' if lab == 'height' else '8'
            im.save_render(f'{OUT}/{name}-{lab}-raw.png', scene=sc)
main()
