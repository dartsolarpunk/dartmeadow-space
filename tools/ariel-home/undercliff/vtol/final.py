import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Matrix, Vector
TEX='/workspace/vtol-mdl/tex/'; OUTD='/workspace/vtol-mdl/out/'
scn=bpy.context.scene
def img(name, nc):
    im=bpy.data.images.load(TEX+name); im.colorspace_settings.name='Non-Color' if nc else 'sRGB'; return im
def make_mat(res):
    m=bpy.data.materials.new('meadowlark_body'); m.use_backface_culling=True; m.use_nodes=True; nt=m.node_tree; nt.nodes.clear()
    out=nt.nodes.new('ShaderNodeOutputMaterial'); b=nt.nodes.new('ShaderNodeBsdfPrincipled'); nt.links.new(b.outputs[0], out.inputs[0])
    tb=nt.nodes.new('ShaderNodeTexImage'); tb.name='T_bc'; tb.image=img('meadowlark-basecolor-%s.png'%res, False)
    to=nt.nodes.new('ShaderNodeTexImage'); to.name='T_orm'; to.image=img('meadowlark-orm-%s.png'%res, True)
    tn=nt.nodes.new('ShaderNodeTexImage'); tn.name='T_nrm'; tn.image=img('meadowlark-normal-%s.png'%res, True)
    te=nt.nodes.new('ShaderNodeTexImage'); te.name='T_em'; te.image=img('meadowlark-emissive-%s.png'%res, False)
    sp=nt.nodes.new('ShaderNodeSeparateColor'); nm=nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tb.outputs[0], b.inputs['Base Color']); nt.links.new(to.outputs[0], sp.inputs[0])
    nt.links.new(sp.outputs[1], b.inputs['Roughness']); nt.links.new(sp.outputs[2], b.inputs['Metallic'])
    nt.links.new(tn.outputs[0], nm.inputs['Color']); nt.links.new(nm.outputs[0], b.inputs['Normal'])
    nt.links.new(te.outputs[0], b.inputs['Emission Color']); b.inputs['Emission Strength'].default_value=4.0
    g=bpy.data.node_groups.get('glTF Material Output')
    if g is None:
        g=bpy.data.node_groups.new('glTF Material Output','ShaderNodeTree'); g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    gn=nt.nodes.new('ShaderNodeGroup'); gn.node_tree=g; nt.links.new(sp.outputs[0], gn.inputs[0])
    return m
M2=make_mat('2k')
obs=[o for o in scn.objects if o.type=='MESH']
for o in obs:
    o.data.materials.clear(); o.data.materials.append(M2)
def dup(o):
    c=o.copy(); c.data=o.data.copy(); scn.collection.objects.link(c); return c
def join(objs, name):
    for o in scn.objects: o.select_set(False)
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active=objs[0]; bpy.ops.object.join(); j=bpy.context.view_layer.objects.active; j.name=name; j.data.name=name
    return j
def tris(o): return sum(len(p.vertices)-2 for p in o.data.polygons)
def decimate(o, target):
    md=o.modifiers.new('dec','DECIMATE'); md.ratio=target/tris(o); md.use_collapse_triangulate=True
    bpy.context.view_layer.objects.active=o; bpy.ops.object.modifier_apply(modifier='dec')
byname={o.name:o for o in obs}
ramp0=byname['Ramp']
ramp0.data.transform(Matrix.Translation((0,-1.4,-1.15))); ramp0.location=(0,1.4,1.15)
vs=[v.co.copy() for v in ramp0.data.vertices]; ang=0
for a in np.linspace(0,1.2,241):
    R=Matrix.Rotation(-a,3,'X'); zmin=min((R@v).z for v in vs)+1.15
    if zmin<=0.02: ang=a; break
print('RAMP_OPEN_DEG', math.degrees(ang))
ext=['Fuselage','Wing','Ducts','Stubs','Fins','Sponsons','Gear','Lights']
def ramp_closed_copy():
    c=dup(ramp0); c.data.transform(Matrix.Translation((0,1.4,1.15))); c.location=(0,0,0); return c
l1=join([dup(byname[n]) for n in ext]+[ramp_closed_copy()], 'Meadowlark_LOD1'); decimate(l1, 8000)
l2=join([dup(byname[n]) for n in ext if n not in ('Lights',)]+[ramp_closed_copy()], 'Meadowlark_LOD2'); decimate(l2, 1500)
l0=join([byname[n] for n in ext+['Liner','Interior']], 'Meadowlark_LOD0')
ramp0.name='Meadowlark_Ramp'; ramp0.data.name='Meadowlark_Ramp'; ramp0.parent=l0
ramp0.animation_data_create(); act=bpy.data.actions.new('RampOpen'); ramp0.animation_data.action=act
ramp0.rotation_euler=(0,0,0); ramp0.keyframe_insert('rotation_euler', index=0, frame=1)
ramp0.rotation_euler=(-ang,0,0); ramp0.keyframe_insert('rotation_euler', index=0, frame=37)
ramp0.rotation_euler=(0,0,0); scn.frame_set(1)
for o in (l0,l1,l2,ramp0): o['dm_vtol']=1
print('TRIS LOD0', tris(l0)+tris(ramp0), '(ramp', tris(ramp0), ') LOD1', tris(l1), 'LOD2', tris(l2))
bb=np.array([(o.matrix_world@v.co)[:] for o in (l0,ramp0) for v in o.data.vertices]); print('BBOX', bb.min(0), bb.max(0), bb.max(0)-bb.min(0))
scn['ramp_open']=ang
bpy.ops.wm.save_as_mainfile(filepath='/workspace/vtol-mdl/vtol_final.blend')
def export(path, res):
    if res!='2k':
        for k,n in (('T_bc','basecolor'),('T_orm','orm'),('T_nrm','normal'),('T_em','emissive')):
            M2.node_tree.nodes[k].image=img('meadowlark-%s-%s.png'%(n,res), k in ('T_orm','T_nrm'))
    for o in scn.objects: o.select_set(o.name.startswith('Meadowlark_'))
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_image_format='WEBP', export_image_quality=82,
        export_apply=True, export_animations=True, export_yup=True, export_extras=True, export_texcoords=True, export_normals=True, export_tangents=False)
export(OUTD+'meadowlark.glb','2k'); export(OUTD+'meadowlark-1k.glb','1k')
print('EXPORTED')
