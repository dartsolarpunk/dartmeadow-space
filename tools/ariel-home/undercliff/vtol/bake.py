import bpy, bmesh, math, os, time
import numpy as np
W = 2048
OUT = '/workspace/vtol-mdl/tex'; os.makedirs(OUT, exist_ok=True)
scn = bpy.context.scene
obs = [o for o in scn.objects if o.type == 'MESH']
# ---- UV atlas (one shared atlas for every part) ----
for o in obs: o.select_set(True)
bpy.context.view_layer.objects.active = obs[0]
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.uv.pack_islands(rotate=True, margin=0.003)
bpy.ops.object.mode_set(mode='OBJECT')
# texel size
Aw = 0; Au = 0
for o in obs:
    me = o.data; uv = me.uv_layers.active.data
    for p in me.polygons:
        Aw += p.area
        pts = [uv[li].uv for li in p.loop_indices]
        a = 0
        for k in range(1, len(pts)-1):
            a += abs((pts[k].x-pts[0].x)*(pts[k+1].y-pts[0].y)-(pts[k+1].x-pts[0].x)*(pts[k].y-pts[0].y))/2
        Au += a
S = math.sqrt(Aw/(Au*W*W)); print('AREA world', Aw, 'uv', Au, 'm/px@2k', S)

# ---- bake setup ----
scn.render.engine = 'CYCLES'; scn.cycles.device = 'CPU'
scn.render.bake.margin = 6; scn.render.bake.margin_type = 'EXTEND'
w = bpy.data.worlds.new('w'); scn.world = w; w.light_settings.distance = 1.2
imgs = {k: bpy.data.images.new('bk_'+k, W, W, float_buffer=True, alpha=True) for k in ('pos','nrm','id','ao')}
for im in imgs.values(): im.colorspace_settings.name = 'Non-Color'
mats = [m for m in bpy.data.materials if 'dm_id' in m]
for m in mats:
    m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); em = nt.nodes.new('ShaderNodeEmission'); em.name = 'EM'
    geo = nt.nodes.new('ShaderNodeNewGeometry'); geo.name = 'GEO'
    vm = nt.nodes.new('ShaderNodeVectorMath'); vm.name='VM'; vm.operation = 'MULTIPLY_ADD'
    nt.links.new(em.outputs[0], out.inputs[0])
    it = nt.nodes.new('ShaderNodeTexImage'); it.name = 'TGT'; nt.nodes.active = it
def mode(k):
    for m in mats:
        nt = m.node_tree; em = nt.nodes['EM']; geo = nt.nodes['GEO']; vm = nt.nodes['VM']; nt.nodes['TGT'].image = imgs[k]
        for l in list(em.inputs[0].links): nt.links.remove(l)
        if k == 'pos':
            vm.inputs[1].default_value = (1/20,)*3; vm.inputs[2].default_value = (0.5,)*3
            nt.links.new(geo.outputs['Position'], vm.inputs[0]); nt.links.new(vm.outputs[0], em.inputs[0])
        elif k == 'nrm':
            vm.inputs[1].default_value = (0.5,)*3; vm.inputs[2].default_value = (0.5,)*3
            nt.links.new(geo.outputs['Normal'], vm.inputs[0]); nt.links.new(vm.outputs[0], em.inputs[0])
        else:
            em.inputs[0].default_value = (m['dm_id']/32.0, 0, 0, 1)
for k in ('pos','nrm','id'):
    mode(k); scn.cycles.samples = 1; t=time.time()
    bpy.ops.object.bake(type='EMIT', margin=6); print('baked', k, time.time()-t)
mode('ao'); scn.cycles.samples = 48; t=time.time()
bpy.ops.object.bake(type='AO', margin=6); print('baked ao', time.time()-t)
def arr(im):
    a = np.empty(W*W*4, np.float32); im.pixels.foreach_get(a); return a.reshape(W, W, 4)
Pa = arr(imgs['pos']); Na = arr(imgs['nrm']); Ia = arr(imgs['id']); Aa = arr(imgs['ao'])
np.savez_compressed(OUT+'/bake_raw.npz', P=((Pa[...,:3]-0.5)*20).astype(np.float32), N=(Na[...,:3]*2-1).astype(np.float16),
                    I=np.rint(Ia[...,0]*32).astype(np.int8), A=Aa[...,0].astype(np.float16), valid=(Ia[...,3]>0.5), S=np.float32(S))
for o in obs: o.select_set(False)
bpy.ops.wm.save_as_mainfile(filepath='/workspace/vtol-mdl/vtol_uv.blend')
print('DONE')
