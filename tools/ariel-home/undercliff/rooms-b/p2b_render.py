# Render-only: adds temporary Cycles lamps at the L_* empties + cameras. Never saves the blend.
import bpy, json, os, math, sys
from mathutils import Vector
OUTD = "/workspace/jots-t1516/undercliff"; REND = os.path.join(OUTD, "p2-rooms-b-renders")
PREV = os.environ.get("PREV") == "1"; ONLY = os.environ.get("ONLY", "")
R = json.load(open(os.path.join(OUTD, "tools-b", "p2b_report.json")))
sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
sc.cycles.samples = 24 if PREV else int(os.environ.get("SAMPLES", "64")); sc.cycles.use_denoising = True
sc.cycles.max_bounces = 6; sc.cycles.diffuse_bounces = 3; sc.cycles.glossy_bounces = 2
sc.render.resolution_x, sc.render.resolution_y = (800, 450) if PREV else (1600, 900)
sc.render.resolution_percentage = 100
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'AgX - Medium High Contrast'
sc.view_settings.exposure = float(os.environ.get("EXPO", "0.0"))
sc.render.image_settings.file_format = 'PNG'
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.02, 0.016, 0.012, 1); w.node_tree.nodes['Background'].inputs[1].default_value = 1.0
# temp lamps
for o in list(bpy.data.objects):
    if o.type == 'EMPTY' and o.name.startswith('L_'):
        kind = o.get('kind', '')
        if kind == 'cove': continue
        if kind == 'rock_wash':
            ld = bpy.data.lights.new("tmp_" + o.name, 'AREA'); ld.shape = 'RECTANGLE'; ld.size = o['strip_len_m'] - 0.3; ld.size_y = 0.03
            ld.energy = 14 * o['strip_len_m']; ld.color = (1, 0.85, 0.6)
            lo = bpy.data.objects.new("tmp_" + o.name, ld); lo.location = o.location; lo.location.z += 0.01; lo.rotation_euler = (0, 0, 0)
            sc.collection.objects.link(lo); continue            # coves are lit by the emissive strip geometry itself
        ld = bpy.data.lights.new("tmp_" + o.name, 'SPOT' if kind == 'downlight' else 'AREA' if kind == 'pendant' else 'POINT')
        ld.color = (1, 0.85, 0.6)
        if kind == 'downlight':
            ld.energy = 140; ld.spot_size = math.radians(85); ld.spot_blend = 0.6; ld.shadow_soft_size = 0.07
        elif kind == 'pendant':
            ld.shape = 'RECTANGLE'; ld.size = 0.18; ld.size_y = 1.8; ld.energy = 260
        elif kind in ('shelf_strip', 'vanity', 'arcade_screens'):
            ld.energy = 25; ld.shadow_soft_size = 0.3
        else:
            ld.energy = 30; ld.shadow_soft_size = 0.1
        lo = bpy.data.objects.new("tmp_" + o.name, ld); lo.location = o.location; lo.rotation_euler = (0, 0, 0) if kind not in ('downlight',) else (0, 0, 0); sc.collection.objects.link(lo)
# cove helpers: area lamps along each cove (strip geometry is the true source; this just reduces noise)
for nm, b in R.items():
    S = b['S']; H = S['Ht'] - 0.06
    for (X, D, ax, L) in (((S['x0'] + S['x1']) / 2, S['d0'] + 0.15, 'x', S['x1'] - S['x0']), ((S['x0'] + S['x1']) / 2, S['d1'] - 0.15, 'x', S['x1'] - S['x0']),
                          (S['x0'] + 0.15, (S['d0'] + S['d1']) / 2, 'y', S['d1'] - S['d0']), (S['x1'] - 0.15, (S['d0'] + S['d1']) / 2, 'y', S['d1'] - S['d0'])):
        ld = bpy.data.lights.new("tmpcove", 'AREA'); ld.shape = 'RECTANGLE'
        ld.size, ld.size_y = (L - 0.4, 0.05) if ax == 'x' else (0.05, L - 0.4); ld.energy = 18 * L; ld.color = (1, 0.85, 0.6)
        lo = bpy.data.objects.new("tmpcove", ld); lo.location = (X, -D, H); lo.rotation_euler = (math.pi, 0, 0); sc.collection.objects.link(lo)
# render-only corridor stand-ins behind each door opening (Cliffs' corridors aren't in this file)
dk = bpy.data.materials['uc_concrete']
for nm, b in R.items():
    S = b['S']; side, c, w, h = b['door']
    if side in ('W', 'E'):
        x = S['x0'] - 1.6 if side == 'W' else S['x1'] + 1.6
        bpy.ops.mesh.primitive_plane_add(size=1, location=(x, -c, 1.5), rotation=(0, math.pi / 2, 0)); o = bpy.context.object; o.scale = (3.2, 4, 1)
    else:
        d = S['d0'] - 1.6 if side == 'N' else S['d1'] + 1.6
        bpy.ops.mesh.primitive_plane_add(size=1, location=(c, -d, 1.5), rotation=(math.pi / 2, 0, 0)); o = bpy.context.object; o.scale = (4, 3.2, 1)
    o.name = 'tmpcorr_' + nm; o.data.materials.append(dk)
    for cl in o.users_collection: cl.objects.unlink(o)
    bpy.data.collections['uc_' + nm].objects.link(o)
def cam(name, loc, tgt, lens=14):
    cd = bpy.data.cameras.new(name); cd.lens = lens; cd.clip_start = 0.05
    c = bpy.data.objects.new(name, cd); sc.collection.objects.link(c); c.location = loc
    c.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler(); return c
def only(colls):
    for c in bpy.data.collections:
        c.hide_render = c.name not in colls
SHOTS = []
def W(X, D, H): return (X, -D, H)
SHOTS.append(("p2b-01-game-room.png", ['uc_game'], W(2.6, 40.6, 1.65), W(10.5, 49.0, 1.0), 13))
SHOTS.append(("p2b-02-game-room-bar.png", ['uc_game'], W(15.3, 49.9, 1.6), W(7.5, 42.5, 0.9), 14))
SHOTS.append(("p2b-03-office.png", ['uc_office'], W(2.5, 31.5, 1.6), W(8.0, 36.5, 0.9), 13))
SHOTS.append(("p2b-04-office-desk.png", ['uc_office'], W(9.3, 32.0, 1.45), W(4.0, 37.0, 0.9), 14))
for i in range(1, 5):
    b = R['guest%d' % i]; S = b['S']; mir = (i % 2 == 0)
    X0 = S['x0'] - 0.12; X1 = S['x1'] + 0.12
    mx = (lambda x: X0 + X1 - x) if mir else (lambda x: x)
    SHOTS.append(("p2b-%02d-guest%d.png" % (4 + i, i), ['uc_guest%d' % i], W(mx(X0 + 1.45), 31.35, 1.65), W(mx(X0 + 3.3), 37.3, 0.85), 12))
SHOTS.append(("p2b-09-guest1-ensuite.png", ['uc_guest1'], W(-21.6, 36.9, 1.6), W(-21.0, 31.8, 1.0), 14))
names = [s for s in SHOTS if not ONLY or any(k in s[0] for k in ONLY.split(','))]
for (fn, colls, loc, tgt, lens) in names:
    only(colls); c = cam(fn, loc, tgt, lens); sc.camera = c
    sc.render.filepath = os.path.join(REND, fn.replace('.png', '-prev.png') if PREV else fn)
    bpy.ops.render.render(write_still=True); print("RENDERED", sc.render.filepath, flush=True)
# plan: all six, ceilings hidden, ortho top-down
if not ONLY or 'plan' in ONLY:
    for c in bpy.data.collections: c.hide_render = False
    for o in bpy.data.objects:
        if o.name.endswith('_ceil'): o.hide_render = True
    for o in bpy.data.objects:
        if o.name.startswith(('tmpcove', 'tmpcorr')): o.hide_render = True
    sun = bpy.data.lights.new("tmpsun", 'SUN'); sun.energy = 1.2; sun.color = (1, 0.9, 0.75)
    so = bpy.data.objects.new("tmpsun", sun); so.rotation_euler = (math.radians(25), math.radians(10), 0); sc.collection.objects.link(so)
    cd = bpy.data.cameras.new("plan"); cd.type = 'ORTHO'; cd.ortho_scale = 46
    c = bpy.data.objects.new("plan", cd); sc.collection.objects.link(c); c.location = (-5, -41.5, 40); sc.camera = c
    sc.render.filepath = os.path.join(REND, "p2b-10-plan-all-rooms" + ("-prev" if PREV else "") + ".png")
    bpy.ops.render.render(write_still=True); print("RENDERED", sc.render.filepath, flush=True)
