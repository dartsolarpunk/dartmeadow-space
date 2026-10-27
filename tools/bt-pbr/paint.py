# Blender (headless) layered procedural paint for the Bird Temple exterior -> tileable 2K channel bakes.
# blender -b -P tools/bt-pbr/paint.py -- OUTDIR
# Layers per section: base paint -> panel lines (2 scales) -> metallic trim bands -> edge wear (bare metal) -> grime.
# Bakes EMIT passes: color, roughness, metalness, height (tileable by construction: 4D torus noise + integer grids).
import bpy, sys, math
OUT = sys.argv[sys.argv.index('--') + 1]
RES = 2048
SETS = {   # base paint, trim metal, bare-metal wear, grime, panel grid, roughness(paint, trim), metal(paint)
  'hull':   dict(paint=(0.80,0.84,0.88), paint2=(0.62,0.70,0.78), trim=(0.92,0.80,0.52), bare=(0.85,0.86,0.88), grime=(0.18,0.17,0.16), grid=4, rp=0.42, rt=0.22, mp=0.35),
  'temple': dict(paint=(0.90,0.87,0.80), paint2=(0.78,0.74,0.66), trim=(0.95,0.78,0.42), bare=(0.90,0.88,0.84), grime=(0.22,0.19,0.15), grid=3, rp=0.50, rt=0.20, mp=0.15),
  'altar':  dict(paint=(0.98,0.82,0.50), paint2=(0.88,0.66,0.34), trim=(0.97,0.92,0.80), bare=(1.0,0.90,0.62), grime=(0.30,0.20,0.10), grid=2, rp=0.28, rt=0.14, mp=0.95),
  'trim':   dict(paint=(0.62,0.65,0.70), paint2=(0.42,0.45,0.50), trim=(0.96,0.84,0.55), bare=(0.92,0.93,0.95), grime=(0.12,0.12,0.13), grid=6, rp=0.30, rt=0.18, mp=0.92),
}
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene; sc.render.engine = 'CYCLES'; sc.cycles.samples = 4; sc.cycles.device = 'CPU'
bpy.ops.mesh.primitive_plane_add(size=2); ob = bpy.context.active_object
img = bpy.data.images.new('bake', RES, RES, float_buffer=True); img.colorspace_settings.name = 'Non-Color'
mat = bpy.data.materials.new('paint'); mat.use_nodes = True; ob.data.materials.append(mat)
nt = mat.node_tree; N = nt.nodes; L = nt.links
def node(t, **kw):
    n = N.new(t)
    for k, v in kw.items(): setattr(n, k, v)
    return n
def math_(op, a, b=None, clamp=False):
    n = node('ShaderNodeMath', operation=op, use_clamp=clamp)
    for i, x in enumerate([a, b]):
        if x is None: continue
        if isinstance(x, (int, float)): n.inputs[i].default_value = x
        else: L.new(x, n.inputs[i])
    return n.outputs[0]
def mix(f, a, b):   # color lerp
    n = node('ShaderNodeMix', data_type='RGBA')
    L.new(f, n.inputs['Factor'])
    for sock, x in (('A', a), ('B', b)):
        if isinstance(x, tuple): n.inputs[sock].default_value = (*x, 1)
        else: L.new(x, n.inputs[sock])
    return n.outputs['Result']
def lerp(f, a, b):  # scalar lerp
    return math_('ADD', math_('MULTIPLY', math_('SUBTRACT', 1, f), a), math_('MULTIPLY', f, b))
tc = node('ShaderNodeTexCoord'); sep = node('ShaderNodeSeparateXYZ'); L.new(tc.outputs['UV'], sep.inputs[0])
U, V = sep.outputs[0], sep.outputs[1]
TAU = 2 * math.pi
def torus(scale):   # tileable 4D coordinate
    cu, su = math_('COSINE', math_('MULTIPLY', U, TAU)), math_('SINE', math_('MULTIPLY', U, TAU))
    cv, sv = math_('COSINE', math_('MULTIPLY', V, TAU)), math_('SINE', math_('MULTIPLY', V, TAU))
    comb = node('ShaderNodeCombineXYZ'); L.new(cu, comb.inputs[0]); L.new(su, comb.inputs[1]); L.new(cv, comb.inputs[2])
    vs = node('ShaderNodeVectorMath', operation='SCALE'); L.new(comb.outputs[0], vs.inputs[0]); vs.inputs['Scale'].default_value = scale
    return vs.outputs[0], math_('MULTIPLY', sv, scale)
def noise(scale, detail=6, rough=0.55, seed=0.0):
    v, w = torus(scale); n = node('ShaderNodeTexNoise', noise_dimensions='4D')
    n.inputs['Detail'].default_value = detail; n.inputs['Roughness'].default_value = rough
    L.new(v, n.inputs['Vector']); L.new(math_('ADD', w, seed), n.inputs['W']); return n.outputs['Fac']
def voro(scale, seed=0.0):
    v, w = torus(scale); n = node('ShaderNodeTexVoronoi', voronoi_dimensions='4D', feature='F1')
    L.new(v, n.inputs['Vector']); L.new(math_('ADD', w, seed), n.inputs['W']); return n.outputs['Distance']
def gridline(g, width, stagger=0.0):
    # distance to nearest panel seam on a g x g grid (rows staggered per column; integer -> tileable)
    gu = math_('MULTIPLY', U, g)
    col = math_('FLOOR', gu)
    gv = math_('ADD', math_('MULTIPLY', V, g), math_('MULTIPLY', math_('FRACT', math_('MULTIPLY', col, 0.5)), 2 * stagger))
    du = math_('ABSOLUTE', math_('SUBTRACT', math_('FRACT', gu), 0.5)); dv = math_('ABSOLUTE', math_('SUBTRACT', math_('FRACT', gv), 0.5))
    d = math_('SUBTRACT', 0.5, math_('MAXIMUM', du, dv))   # 0 at seam
    return d, math_('SUBTRACT', 1, math_('SMOOTHSTEP' if False else 'GREATER_THAN', d, width))
def smooth(x, a, b):
    m = node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP'); L.new(x, m.inputs[0])
    m.inputs[1].default_value = a; m.inputs[2].default_value = b; return m.outputs[0]
emit = node('ShaderNodeEmission'); out = node('ShaderNodeOutputMaterial'); L.new(emit.outputs[0], out.inputs[0])
tex = node('ShaderNodeTexImage', image=img); N.active = tex
for name, S in SETS.items():
    for n in list(N):
        if n not in (emit, out, tex, tc, sep): N.remove(n)
    g = S['grid']
    d1, _ = gridline(g, 0.0, 0.5); d2, _ = gridline(g * 2, 0.0, 0.0)
    seam = math_('MAXIMUM', smooth(d1, 0.012, 0.0), math_('MULTIPLY', smooth(d2, 0.006, 0.0), 0.55))     # panel lines
    trimband = math_('MULTIPLY', smooth(d1, 0.045, 0.03), smooth(d1, 0.012, 0.02))                        # raised metal trim strip along major seams
    n_big = noise(1.5, 4, 0.5, 3.1); n_mid = noise(6.0, 6, 0.55, 7.7); n_fine = noise(40.0, 3, 0.6, 1.3)
    plate = math_('GREATER_THAN', voro(float(g), 11.0), 0.0)   # per-panel tint variation via torus voronoi
    tint = smooth(noise(float(g) * 0.75, 1, 0.3, 5.5), 0.35, 0.65)
    edge = smooth(d1, 0.06, 0.012)                                                                        # near seams
    wear = math_('MULTIPLY', edge, smooth(math_('ADD', n_mid, math_('MULTIPLY', n_fine, 0.35)), 0.62, 0.72))   # chipped edges -> bare metal
    grime = math_('MINIMUM', math_('ADD', math_('MULTIPLY', smooth(d1, 0.09, 0.0), 0.7), math_('MULTIPLY', smooth(n_big, 0.45, 0.8), 0.6)), 1.0)
    grime = math_('MULTIPLY', grime, smooth(n_mid, 0.3, 0.7))
    # colour layers
    c = mix(tint, S['paint'], S['paint2'])
    c = mix(math_('MULTIPLY', n_fine, 0.12), c, (0.5, 0.5, 0.5))
    c = mix(trimband, c, S['trim'])
    c = mix(wear, c, S['bare'])
    c = mix(math_('MULTIPLY', grime, 0.55), c, S['grime'])
    c = mix(math_('MULTIPLY', seam, 0.85), c, (0.05, 0.05, 0.06))
    rough = lerp(trimband, S['rp'], S['rt']); rough = lerp(wear, rough, 0.25); rough = lerp(math_('MULTIPLY', grime, 0.6), rough, 0.85)
    rough = math_('ADD', rough, math_('MULTIPLY', math_('SUBTRACT', n_fine, 0.5), 0.12))
    metal = lerp(trimband, S['mp'], 1.0); metal = lerp(wear, metal, 1.0); metal = lerp(math_('MULTIPLY', grime, 0.5), metal, 0.0)
    height = math_('SUBTRACT', math_('ADD', math_('MULTIPLY', trimband, 0.5), math_('MULTIPLY', n_fine, 0.08)), math_('ADD', seam, math_('MULTIPLY', wear, 0.15)))
    height = math_('MULTIPLY', math_('ADD', height, 1.2), 0.4)
    for ch, sock in (('color', c), ('rough', rough), ('metal', metal), ('height', height)):
        L.new(sock, emit.inputs['Color'])
        bpy.ops.object.bake(type='EMIT', margin=0)
        img.filepath_raw = f'{OUT}/{name}_{ch}.exr'; img.file_format = 'OPEN_EXR'; img.save()
        print('baked', name, ch, flush=True)
