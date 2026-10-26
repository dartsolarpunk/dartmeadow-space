# (v129) baked glass reflections: one Cycles equirect panorama per room (+ 'out' above the top deck), rendered from the
# lightmap scene (lm_uv.py output) with the altar light, the emissives and the room lamps at their default (auto) level.
# Also the room's box (6 axis rays against the scene) for box-projected lookups at runtime. glTF space throughout.
# Output: OUT/bt-refl-<room>.png + OUT/rooms.json.   blender -b -P lm_cubes.py -- UVDIR rooms.json OUT W SPP
import bpy, json, numpy as np, sys, os, math, mathutils
a = sys.argv[sys.argv.index('--') + 1:]; D, RJ, OUT = a[0], a[1], a[2]; W = int(a[3]); SPP = int(a[4])
os.makedirs(OUT, exist_ok=True)
m = json.load(open(os.path.join(D, 'meta.json'))); R = json.load(open(RJ))
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene; sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = SPP; sc.cycles.use_denoising = True
sc.render.threads_mode = 'FIXED'; sc.render.threads = int(os.environ.get('BT_THREADS', '8'))
sc.cycles.max_bounces = 4; sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs[0].default_value = (0.012, 0.014, 0.022, 1)
B = lambda p: (p[0], -p[2], p[1])          # glTF (Y-up) -> Blender (Z-up)
mats = {}
def mat(p):
    k = (p['mat'], tuple(p['base']), tuple(p['emis']))
    if k in mats: return mats[k]
    M = bpy.data.materials.new(str(p['mat'])); M.use_nodes = True; b = M.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = tuple(p['base'][:3]) + (1,); b.inputs['Roughness'].default_value = 0.55
    if p['mat'] and any(s in p['mat'] for s in ('Steel', 'Hull', 'Grille')): b.inputs['Metallic'].default_value = 0.6; b.inputs['Roughness'].default_value = 0.35
    e = p['emis']
    if max(e) > 0: b.inputs['Emission Color'].default_value = tuple(e) + (1,); b.inputs['Emission Strength'].default_value = 4.0 if any(s in str(p['mat']) for s in ('Neon', 'Glow', 'Led', 'Screen')) else 2.0
    mats[k] = M; return M
for p in m['prims']:
    d = np.load(os.path.join(D, p['file'])); pos = d['pos']; ind = d['ind'].reshape(-1, 3)
    bp = np.c_[pos[:, 0], -pos[:, 2], pos[:, 1]]
    me = bpy.data.meshes.new(p['file']); me.from_pydata(bp.tolist(), [], ind.tolist()); me.update()
    me.polygons.foreach_set('use_smooth', np.ones(len(ind), bool))
    o = bpy.data.objects.new(p['file'], me); sc.collection.objects.link(o); me.materials.append(mat(p))
for L in R['lamps']:
    c = L['color'].lstrip('#'); rgb = tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))
    ld = bpy.data.lights.new(L['name'], 'POINT'); ld.color = rgb; ld.energy = 60.0; ld.shadow_soft_size = 0.4
    lo = bpy.data.objects.new(L['name'], ld); sc.collection.objects.link(lo); lo.location = B(L['pos'])
bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get()
allp = np.concatenate([np.load(os.path.join(D, p['file']))['pos'] for p in m['prims']]); mn, mx = allp.min(0), allp.max(0)
rooms = dict(R['rooms']); rooms['out'] = dict(c=[float((mn[0] + mx[0]) / 2), float(mx[1] + 6.0), float((mn[2] + mx[2]) / 2)])
cd = bpy.data.cameras.new('C'); cd.type = 'PANO'
try: cd.panorama_type = 'EQUIRECTANGULAR'
except Exception: cd.cycles.panorama_type = 'EQUIRECTANGULAR'
cam = bpy.data.objects.new('C', cd); sc.collection.objects.link(cam); sc.camera = cam; cam.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
sc.render.resolution_x = W; sc.render.resolution_y = W // 2; sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_depth = '8'
outr = {}
for k, r in rooms.items():
    c = list(r['c'])
    if k != 'out': c[1] -= 2.4   # the lamps hang at the ceiling: the probe sits at head height
    o = mathutils.Vector(B(c)); ext = []
    for ax in range(3):
        for s in (-1, 1):
            dv = [0, 0, 0]; dv[ax] = s; dbl = mathutils.Vector(B(dv))
            hit, loc, *_ = sc.ray_cast(dg, o, dbl, distance=200.0)
            ext.append((loc - o).length if hit else 60.0)
    # ext in glTF axes order: -x,+x,-y,+y,-z,+z
    bmin = [c[0] - ext[0], c[1] - ext[2], c[2] - ext[4]]; bmax = [c[0] + ext[1], c[1] + ext[3], c[2] + ext[5]]
    cam.location = o; sc.render.filepath = os.path.join(OUT, f'bt-refl-{k}.png'); bpy.ops.render.render(write_still=True)
    outr[k] = dict(c=c, bmin=bmin, bmax=bmax); print('ROOM', k, [round(x, 2) for x in c], [round(x, 1) for x in ext], flush=True)
json.dump(dict(v=1, map='equirect u=0.5+atan2(z,x)/2pi v=0.5+asin(y)/pi (glTF root space)', rooms=outr), open(os.path.join(OUT, 'rooms.json'), 'w'), indent=1)
print('DONE', flush=True)
