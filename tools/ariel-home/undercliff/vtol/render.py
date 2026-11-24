import bpy, math, sys
from mathutils import Vector, Matrix
argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
SHOTS=argv[0].split(',') if argv else ['front','side','rear','hangar']
SAMPLES=int(argv[1]) if len(argv)>1 else 128
RES=float(argv[2]) if len(argv)>2 else 1.0
OUT=argv[3] if len(argv)>3 else '/workspace/vtol-mdl/renders/'
scn=bpy.context.scene
for n in ('Meadowlark_LOD1','Meadowlark_LOD2'): bpy.data.objects[n].hide_render=True
OPEN=scn['ramp_open']
scn.render.engine='CYCLES'; scn.cycles.device='CPU'; scn.cycles.samples=SAMPLES; scn.cycles.use_denoising=True
scn.cycles.max_bounces=6; scn.cycles.caustics_reflective=False; scn.cycles.caustics_refractive=False
scn.render.threads_mode='FIXED'; scn.render.threads=6
scn.render.resolution_x=int(1600*RES); scn.render.resolution_y=int(900*RES); scn.render.resolution_percentage=100
scn.view_settings.view_transform='AgX'; scn.view_settings.look='AgX - Medium High Contrast'
def mat(name, col, rough=0.5, metal=0.0, emit=None, es=0):
    m=bpy.data.materials.new(name); m.use_nodes=True; b=m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value=(*col,1); b.inputs['Roughness'].default_value=rough; b.inputs['Metallic'].default_value=metal
    if emit: b.inputs['Emission Color'].default_value=(*emit,1); b.inputs['Emission Strength'].default_value=es
    return m
def add_mesh(name, verts, faces, m):
    me=bpy.data.meshes.new(name); me.from_pydata(verts,[],faces); me.update(); o=bpy.data.objects.new(name,me); scn.collection.objects.link(o); me.materials.append(m); return o
def concrete(name, tint=(0.36,0.36,0.35), scale=0.6, pad=False):
    m=bpy.data.materials.new(name); m.use_nodes=True; nt=m.node_tree; b=nt.nodes['Principled BSDF']
    tc=nt.nodes.new('ShaderNodeTexCoord'); nz=nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value=scale; nz.inputs['Detail'].default_value=8
    nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
    ramp_=nt.nodes.new('ShaderNodeValToRGB'); ramp_.color_ramp.elements[0].color=(*[c*0.75 for c in tint],1); ramp_.color_ramp.elements[1].color=(*[c*1.15 for c in tint],1)
    nt.links.new(nz.outputs['Fac'], ramp_.inputs[0]); col=ramp_.outputs[0]
    if pad:
        sep=nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(tc.outputs['Object'], sep.inputs[0])
        vl=nt.nodes.new('ShaderNodeVectorMath'); vl.operation='LENGTH'; c2=nt.nodes.new('ShaderNodeCombineXYZ')
        nt.links.new(sep.outputs[0], c2.inputs[0]); nt.links.new(sep.outputs[1], c2.inputs[1]); nt.links.new(c2.outputs[0], vl.inputs[0])
        def band(r0,r1):
            a=nt.nodes.new('ShaderNodeMath'); a.operation='GREATER_THAN'; a.inputs[1].default_value=r0; nt.links.new(vl.outputs['Value'], a.inputs[0])
            b_=nt.nodes.new('ShaderNodeMath'); b_.operation='LESS_THAN'; b_.inputs[1].default_value=r1; nt.links.new(vl.outputs['Value'], b_.inputs[0])
            mm=nt.nodes.new('ShaderNodeMath'); mm.operation='MULTIPLY'; nt.links.new(a.outputs[0], mm.inputs[0]); nt.links.new(b_.outputs[0], mm.inputs[1]); return mm.outputs[0]
        mx=nt.nodes.new('ShaderNodeMath'); mx.operation='MAXIMUM'; nt.links.new(band(8.3,8.6), mx.inputs[0]); nt.links.new(band(9.0,9.12), mx.inputs[1])
        mix=nt.nodes.new('ShaderNodeMix'); mix.data_type='RGBA'; mix.inputs['B'].default_value=(0.75,0.55,0.08,1)
        nt.links.new(mx.outputs[0], mix.inputs['Factor']); nt.links.new(col, mix.inputs['A']); col=mix.outputs['Result']
        br=nt.nodes.new('ShaderNodeTexBrick'); br.inputs['Scale'].default_value=0.25; br.inputs['Mortar Size'].default_value=0.004; br.offset=0.0
        br.inputs['Color1'].default_value=(1,1,1,1); br.inputs['Color2'].default_value=(1,1,1,1); br.inputs['Mortar'].default_value=(0.55,0.55,0.55,1)
        nt.links.new(tc.outputs['Object'], br.inputs['Vector'])
        mul=nt.nodes.new('ShaderNodeMix'); mul.data_type='RGBA'; mul.blend_type='MULTIPLY'; mul.inputs['Factor'].default_value=1
        nt.links.new(col, mul.inputs['A']); nt.links.new(br.outputs['Color'], mul.inputs['B']); col=mul.outputs['Result']
    nt.links.new(col, b.inputs['Base Color'])
    rr=nt.nodes.new('ShaderNodeMapRange'); rr.inputs[3].default_value=0.55; rr.inputs[4].default_value=0.85; nt.links.new(nz.outputs['Fac'], rr.inputs[0]); nt.links.new(rr.outputs[0], b.inputs['Roughness'])
    return m
def look(cam, pos, tgt, lens):
    cam.location=pos; cam.rotation_euler=(Vector(tgt)-Vector(pos)).to_track_quat('-Z','Y').to_euler(); cam.data.lens=lens
cam=bpy.data.objects.new('cam',bpy.data.cameras.new('cam')); scn.collection.objects.link(cam); scn.camera=cam
def sky_world(strength=1.0, elev=28, rot=215):
    w=bpy.data.worlds.new('sky'); w.use_nodes=True; nt=w.node_tree; sk=nt.nodes.new('ShaderNodeTexSky'); sk.sky_type='NISHITA'
    sk.sun_elevation=math.radians(elev); sk.sun_rotation=math.radians(rot); sk.altitude=200; sk.air_density=1.2; sk.dust_density=1.5; sk.sun_intensity=0.6
    bg=nt.nodes['Background']; bg.inputs[1].default_value=strength; nt.links.new(sk.outputs[0], bg.inputs[0]); scn.world=w
def figure(pos, yaw=0.0):
    fm=mat('fig',(0.55,0.42,0.30),0.6); parts=[]
    def capsule(p0,p1,r):
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=(Vector(p1)-Vector(p0)).length, vertices=16, location=((Vector(p0)+Vector(p1))/2))
        o=bpy.context.object; d=(Vector(p1)-Vector(p0)).normalized(); o.rotation_euler=d.to_track_quat('Z','Y').to_euler(); parts.append(o)
        for p in (p0,p1):
            bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=p, segments=16, ring_count=8); parts.append(bpy.context.object)
    capsule((0.10,0,0.08),(0.10,0,0.82),0.065); capsule((-0.10,0,0.08),(-0.10,0,0.82),0.065)
    capsule((0,0,0.92),(0,0,1.36),0.16)
    capsule((0.24,0,1.40),(0.27,0.02,0.86),0.045); capsule((-0.24,0,1.40),(-0.27,0.02,0.86),0.045)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.105, location=(0,0,1.595), segments=20, ring_count=10); parts.append(bpy.context.object)
    capsule((0,0,1.40),(0,0,1.50),0.05)
    for o in parts: o.data.materials.append(fm); o.select_set(True)
    bpy.context.view_layer.objects.active=parts[0]; bpy.ops.object.join(); f=bpy.context.object
    bpy.ops.object.shade_smooth(); f.location=pos; f.rotation_euler=(0,0,yaw); f.name='Figure_1m70'; return f
def ground():
    bpy.ops.mesh.primitive_plane_add(size=400); g=bpy.context.object; g.data.materials.append(concrete('pad',(0.42,0.42,0.40),0.35,pad=True)); return g
def sun(energy, rot):
    s=bpy.data.objects.new('sun',bpy.data.lights.new('sun','SUN')); s.data.energy=energy; s.data.angle=math.radians(1.5); s.rotation_euler=rot; scn.collection.objects.link(s); return s
def render(name):
    scn.render.filepath=OUT+name; bpy.ops.render.render(write_still=True); print('WROTE', OUT+name, flush=True)
ext_set=False
def exterior():
    global ext_set
    if ext_set: return
    ext_set=True; ground(); sky_world(0.35, 26, 215); sun(2.2,(math.radians(62),0,math.radians(-35)))
for shot in SHOTS:
    if shot in ('front','side','rear'): exterior()
    if shot=='front':
        scn.frame_set(1); look(cam,(-11.5,-14.0,4.2),(0.3,-0.6,2.1),34); scn.view_settings.exposure=-1.2
        render('01-meadowlark-3q-front.png')
    if shot=='side':
        scn.frame_set(1); scn.view_settings.exposure=-1.2; look(cam,(-23.0,-0.3,2.6),(0,-0.3,2.15),50); render('02-meadowlark-side-starboard.png')
    if shot=='rear':
        scn.frame_set(37); scn.view_settings.exposure=-1.0
        sn=bpy.data.objects['sun']; sn.rotation_euler=(math.radians(58),0,math.radians(150))
        pl=bpy.data.objects.new('cabin',bpy.data.lights.new('cabin','POINT')); pl.data.energy=120; pl.data.color=(1,0.9,0.78); pl.data.shadow_soft_size=0.3; pl.location=(0,0.2,2.8); scn.collection.objects.link(pl)
        look(cam,(5.2,13.5,2.4),(0,1.2,1.9),36); render('03-meadowlark-rear-ramp-open.png')
        sn.rotation_euler=(math.radians(62),0,math.radians(-35)); bpy.data.objects.remove(pl, do_unlink=True)
    if shot=='hangar':
        for o in list(scn.objects):
            if o.name in ('Plane','sun'): bpy.data.objects.remove(o, do_unlink=True)
        scn.frame_set(37)
        X,Yh,Z=15,20,18
        wall=concrete('rockwall',(0.13,0.11,0.10),0.25); flr=concrete('floor',(0.16,0.165,0.17),0.5,pad=True)
        add_mesh('Floor',[(-X,-Yh,0),(X,-Yh,0),(X,Yh,0),(-X,Yh,0)],[(0,1,2,3)],flr)
        add_mesh('Walls',[(-X,-Yh,0),(X,-Yh,0),(X,Yh,0),(-X,Yh,0),(-X,-Yh,Z),(X,-Yh,Z),(X,Yh,Z),(-X,Yh,Z)],[(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)],wall)
        hx0,hx1,hy0,hy1=-9,9,-11,11
        add_mesh('Roof',[(-X,-Yh,Z),(X,-Yh,Z),(X,Yh,Z),(-X,Yh,Z),(hx0,hy0,Z),(hx1,hy0,Z),(hx1,hy1,Z),(hx0,hy1,Z)],[(3,2,6,7),(2,1,5,6),(0,3,7,4)],wall)
        steel=mat('steel',(0.12,0.13,0.14),0.4,0.8)
        for yb in range(-18,19,4):
            bpy.ops.mesh.primitive_cube_add(size=1,location=(0,yb,Z-0.5)); b=bpy.context.object; b.scale=(30,0.35,1.0); b.data.materials.append(steel)
        lamp=mat('lamp',(1,1,1),0.3,0,(1.0,0.93,0.82),18)
        for xl in (-12,-6,6,12):
            for yl in (-16,14):
                bpy.ops.mesh.primitive_plane_add(size=1,location=(xl,yl,Z-1.05)); p=bpy.context.object; p.scale=(4.0,0.6,1); p.rotation_euler=(math.pi,0,0); p.data.materials.append(lamp)
        led=mat('led',(0.2,0.9,1.0),0.3,0,(0.25,0.85,1.0),8)
        for sx in (-1,1):
            bpy.ops.mesh.primitive_cube_add(size=1,location=(sx*(X-0.05),0,0.25)); b=bpy.context.object; b.scale=(0.05,40,0.06); b.data.materials.append(led)
        for k in range(8):
            bpy.ops.mesh.primitive_cube_add(size=1,location=(-12+k*1.2,-19.2,1.0+k*2.0)); b=bpy.context.object; b.scale=(1.4,1.2,0.08); b.data.materials.append(steel)
        for k in range(9):
            bpy.ops.mesh.primitive_cylinder_add(radius=0.06,depth=18,location=(-12.5+k*1.2,-18.6,9)); bpy.context.object.data.materials.append(steel)
        sky_world(0.55, 55, 200)
        s=sun(4.0,(math.radians(22),0,math.radians(-20)))
        a=bpy.data.objects.new('fill',bpy.data.lights.new('fill','AREA')); a.data.energy=2500; a.data.size=14; a.location=(0,2,16.5); scn.collection.objects.link(a)
        figure((2.6,-4.6,0), math.radians(-30))
        look(cam,(-9.5,-11.5,2.4),(0.8,-0.5,2.3),24); scn.view_settings.exposure=-0.3
        render('04-meadowlark-in-hangar-mockup.png')
