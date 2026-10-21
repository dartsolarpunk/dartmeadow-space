# before/after preview of the bake (blender -b -P): BEFORE = albedo × flat ambient (no GI), AFTER = albedo × baked irradiance × AO
import bpy, json, numpy as np, sys, os, mathutils
a=sys.argv[sys.argv.index('--')+1:]; D, BK, OUT = a[0], a[1], a[2]; os.makedirs(OUT, exist_ok=True)
m=json.load(open(os.path.join(D,'meta.json')))
bpy.ops.wm.read_factory_settings(use_empty=True)
sc=bpy.context.scene; sc.render.engine='CYCLES'; sc.cycles.samples=8; sc.cycles.max_bounces=0; sc.render.resolution_x=960; sc.render.resolution_y=600
sc.view_settings.view_transform='Standard'
irr=bpy.data.images.load(os.path.join(BK,'irr.exr')); ao=bpy.data.images.load(os.path.join(BK,'ao.exr'))
mats={}
def mat(p,mode):
    k=(p['mat'],tuple(p['base']),tuple(p['emis']),mode)
    if k in mats: return mats[k]
    M=bpy.data.materials.new('m'); M.use_nodes=True; nt=M.node_tree; nt.nodes.clear()
    o=nt.nodes.new('ShaderNodeOutputMaterial'); e=nt.nodes.new('ShaderNodeEmission'); nt.links.new(e.outputs[0],o.inputs[0])
    base=tuple(p['base'][:3]); em=p['emis']
    if mode=='before':
        e.inputs[0].default_value=tuple(min(1,b*0.18+x) for b,x in zip(base,em))+(1,)
    else:
        uv=nt.nodes.new('ShaderNodeUVMap'); uv.uv_map='UV2'
        ti=nt.nodes.new('ShaderNodeTexImage'); ti.image=irr; ta=nt.nodes.new('ShaderNodeTexImage'); ta.image=ao
        nt.links.new(uv.outputs[0],ti.inputs[0]); nt.links.new(uv.outputs[0],ta.inputs[0])
        def vm(op):
            n=nt.nodes.new('ShaderNodeVectorMath'); n.operation=op; return n
        m1=vm('MULTIPLY'); nt.links.new(ti.outputs[0],m1.inputs[0]); m1.inputs[1].default_value=base
        m2=vm('MULTIPLY'); nt.links.new(m1.outputs[0],m2.inputs[0]); nt.links.new(ta.outputs[0],m2.inputs[1])
        ad=vm('ADD'); nt.links.new(m2.outputs[0],ad.inputs[0]); ad.inputs[1].default_value=tuple(em)
        nt.links.new(ad.outputs[0],e.inputs[0])
    mats[k]=M; return M
objs=[]
for p in m['prims']:
    d=np.load(os.path.join(D,p['file'])); pos=d['pos']; ind=d['ind'].reshape(-1,3); uv=d['uv']
    me=bpy.data.meshes.new('x'); me.vertices.add(len(pos)); me.vertices.foreach_set('co',pos.ravel())
    me.loops.add(ind.size); me.loops.foreach_set('vertex_index',ind.ravel().astype(np.int32))
    me.polygons.add(len(ind)); me.polygons.foreach_set('loop_start',np.arange(0,ind.size,3,dtype=np.int32)); me.polygons.foreach_set('loop_total',np.full(len(ind),3,np.int32))
    me.update(); L=me.uv_layers.new(name='UV2'); L.data.foreach_set('uv',uv[ind.ravel()].ravel())
    o=bpy.data.objects.new('o',me); sc.collection.objects.link(o); o['p']=p['file']; objs.append((o,p))
def g2b(v): return mathutils.Vector(v)   # raw glTF space (Y up), no root rotation here
cam=bpy.data.objects.new('cam',bpy.data.cameras.new('c')); sc.collection.objects.link(cam); sc.camera=cam; cam.data.lens=18
views=json.loads(a[3])
for name,(pp,tt) in views.items():
    cam.location=g2b(pp); d=g2b(tt)-g2b(pp); cam.rotation_euler=d.to_track_quat('-Z','Y').to_euler()
    for mode in ('before','after'):
        for o,p in objs: o.data.materials.clear(); o.data.materials.append(mat(p,mode))
        sc.render.filepath=os.path.join(OUT,f'{name}_{mode}.png'); bpy.ops.render.render(write_still=True); print('RENDERED',name,mode,flush=True)
