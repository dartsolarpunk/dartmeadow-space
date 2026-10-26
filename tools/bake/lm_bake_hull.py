# stage 2b (blender -b -P lm_bake_hull.py -- UVDIR HR SPP OUT): re-bake ONLY the Hull/deck group into its own HR x HR atlas
# (local 'uvl' from lm_uv_hull.py), with every other object present as occluder/bounce. Larger margin (32 px) so no island is left unbaked.
# based on stage 2 (blender -b -P): Cycles path-traced bake of irradiance (diffuse direct+indirect, no albedo, no Sun: the Sun stays
# real-time) and AO into the xatlas UV2 atlas built by lm_uv.py.
import bpy, json, numpy as np, sys, os, time
a=sys.argv[sys.argv.index('--')+1:]; D=a[0]; RES=int(a[1]); SPP=int(a[2]); OUT=a[3]
m=json.load(open(os.path.join(D,'meta.json')))
bpy.ops.wm.read_factory_settings(use_empty=True)
sc=bpy.context.scene; sc.render.engine='CYCLES'; sc.cycles.device='CPU'; sc.cycles.samples=SPP; sc.render.threads_mode='FIXED'; sc.render.threads=8
sc.cycles.max_bounces=4; sc.cycles.diffuse_bounces=3
w=bpy.data.worlds.new('W'); sc.world=w; w.use_nodes=True; w.node_tree.nodes['Background'].inputs[0].default_value=(0.03,0.035,0.05,1); w.node_tree.nodes['Background'].inputs[1].default_value=1.0
img={k:bpy.data.images.new(k,RES,RES,float_buffer=True) for k in ('irr','ao')}
mats={}
def mat(p):
    k=(p['mat'],tuple(p['base']),tuple(p['emis']))
    if k in mats: return mats[k]
    M=bpy.data.materials.new(str(p['mat'])); M.use_nodes=True; nt=M.node_tree; b=nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value=tuple(p['base'][:3])+(1,); b.inputs['Roughness'].default_value=0.7
    e=p['emis']
    if max(e)>0: b.inputs['Emission Color'].default_value=tuple(e)+(1,); b.inputs['Emission Strength'].default_value=4.0 if any(s in str(p['mat']) for s in ('Neon','Glow','Led','Screen')) else 2.0
    t=nt.nodes.new('ShaderNodeTexImage'); t.name='BAKE'; nt.nodes.active=t
    mats[k]=M; return M
objs=[]
for p in m['prims']:
    d=np.load(os.path.join(D,p['file'])); pos=d['pos']; ind=d['ind'].reshape(-1,3); uv=d['uvl'] if p.get('hull') else d['uv']
    me=bpy.data.meshes.new(p['file']); me.vertices.add(len(pos)); me.vertices.foreach_set('co',pos.ravel())
    me.loops.add(ind.size); me.loops.foreach_set('vertex_index',ind.ravel().astype(np.int32))
    me.polygons.add(len(ind)); me.polygons.foreach_set('loop_start',np.arange(0,ind.size,3,dtype=np.int32)); me.polygons.foreach_set('loop_total',np.full(len(ind),3,np.int32))
    me.update(); L=me.uv_layers.new(name='UV2'); L.data.foreach_set('uv',uv[ind.ravel()].ravel())
    me.polygons.foreach_set('use_smooth',np.ones(len(ind),bool))
    # (v129) bake with the GLB's own (hard-edge aware) normals: Blender's auto-smooth across xatlas seams/boxes made the blotches
    nor=d['nor']
    if np.abs(nor).sum()>0:
        try: me.normals_split_custom_set_from_vertices([tuple(v) for v in (nor/np.maximum(np.linalg.norm(nor,axis=1,keepdims=True),1e-9))])
        except Exception as ex: print('custom normals failed',ex)
    o=bpy.data.objects.new(p['file'],me); sc.collection.objects.link(o); me.materials.append(mat(p)); objs.append(o)
# glTF is Y-up; the raw data is in glTF space — rotate the whole set to Blender Z-up via a parent (the bake is UV-space, so only lighting directions matter)
root=bpy.data.objects.new('ROOT',None); sc.collection.objects.link(root)
for o in objs: o.parent=root
root.rotation_euler=(1.5707963,0,0)
# altar light (temple Altar node, if present)
alt=[p for p in m['prims'] if p['node'] in ('Altar',)]
if alt:
    d=np.load(os.path.join(D,alt[0]['file'])); c=d['pos'].mean(0); top=d['pos'][:,1].max()
    L=bpy.data.lights.new('altar','POINT'); L.energy=400; L.color=(1,0.95,0.8); lo=bpy.data.objects.new('altar',L); sc.collection.objects.link(lo); lo.parent=root; lo.location=(c[0],top+0.6,c[2])
bpy.context.view_layer.update()
hob=[o for o,p in zip(objs,m['prims']) if p.get('hull')]
for o in objs: o.select_set(False)
for o in hob: o.select_set(True)
bpy.context.view_layer.objects.active=hob[0]
print('hull objs',len(hob),flush=True)
for k,typ in (('ao','AO'),('irr','DIFFUSE')):
    for M in mats.values(): M.node_tree.nodes['BAKE'].image=img[k]
    t0=time.time()
    if typ=='DIFFUSE': sc.render.bake.use_pass_direct=True; sc.render.bake.use_pass_indirect=True; sc.render.bake.use_pass_color=False
    sc.render.bake.margin=32; sc.render.bake.margin_type='EXTEND'; sc.render.bake.use_clear=True
    bpy.ops.object.bake(type=typ, uv_layer='UV2')
    print('BAKED',k,round(time.time()-t0,1),'s',flush=True)
    img[k].filepath_raw=os.path.join(OUT,f'{k}.exr'); img[k].file_format='OPEN_EXR'; img[k].save()
print('DONE',flush=True)
