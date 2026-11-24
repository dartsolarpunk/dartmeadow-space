# DM-7 Meadowlark VTOL — procedural build (Blender 4.2, headless). Original design for JOTS.
# Blender axes: nose toward -Y, +Z up, ground at z=0. (glTF: nose +Z, Y up.)
import bpy, bmesh, math
import numpy as np
from mathutils import Vector, Matrix
pi = math.pi
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene

IDS = {'fus':1,'glass':2,'copper':4,'graphite':5,'rubber':6,'liner':7,'red':8,'green':9,'white':10,'cyan':11,
       'dark':12,'blade':13,'floor':14,'wing':15,'fin':16,'shroud':17,'sponson':18,'hub':19,'crate':20}
IDMAT = {}
def idmat(i):
    if i in IDMAT: return IDMAT[i]
    m = bpy.data.materials.new('id_%02d' % i); m['dm_id'] = i; IDMAT[i] = m; return m

def ss(t):
    t = min(1.0, max(0.0, t)); return t*t*(3-2*t)

def mesh_obj(name, verts, faces, fids, smooth_angle=35, part='ext'):
    me = bpy.data.meshes.new(name); me.from_pydata([tuple(v) for v in verts], [], faces); me.update()
    ob = bpy.data.objects.new(name, me); scn.collection.objects.link(ob)
    uniq = sorted(set(fids)); 
    for u in uniq: me.materials.append(idmat(u))
    for p, f in zip(me.polygons, fids): p.material_index = uniq.index(f)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces: f.smooth = True
    thr = math.radians(smooth_angle)
    for e in bm.edges:
        if len(e.link_faces) != 2 or e.calc_face_angle(0) > thr: e.smooth = False
    bm.to_mesh(me); bm.free()
    ob['part'] = part
    return ob

def loft(rings, closed=True, cap0=True, cap1=True, skip=None, fid=None):
    """rings: list of lists of 3D points (same count). fid(i,j)->id. returns verts, faces, fids"""
    n = len(rings[0]); V = [p for r in rings for p in r]; F = []; FI = []
    for i in range(len(rings)-1):
        for j in range(n if closed else n-1):
            if skip and skip(i, j): continue
            a = i*n+j; b = i*n+(j+1) % n
            F.append((a, b, b+n, a+n)); FI.append(fid(i, j))
    for ci, cap in ((0, cap0), (len(rings)-1, cap1)):
        if not cap: continue
        r = rings[ci]; c = [sum(p[k] for p in r)/n for k in range(3)]
        V.append(c); ic = len(V)-1
        for j in range(n if closed else n-1):
            F.append((ci*n+j, ci*n+(j+1) % n, ic)); FI.append(fid(min(ci, len(rings)-2), j))
    return V, F, FI

def lathe(profile, seg, center=(0,0,0), axis='Z', scale=1.0, phase=0.0):
    """profile: closed list of (r, h, id) ; revolve around axis"""
    m = len(profile); V = []; F = []; FI = []
    cx, cy, cz = center
    for s in range(seg):
        a = 2*pi*s/seg + phase; ca, sa = math.cos(a), math.sin(a)
        for (r, h, _) in profile:
            r *= scale; h *= scale
            if axis == 'Z': V.append((cx+r*ca, cy+r*sa, cz+h))
            elif axis == 'X': V.append((cx+h, cy+r*ca, cz+r*sa))
            else: V.append((cx+r*ca, cy+h, cz+r*sa))
    for s in range(seg):
        for k in range(m):
            a = s*m+k; b = s*m+(k+1) % m; s2 = ((s+1) % seg)*m
            F.append((a, b, s2+(k+1) % m, s2+k)); FI.append(profile[k][2])
    return V, F, FI

def lathe_open(profile, seg, center, axis, scale=1.0):
    """open profile (no wrap between last and first point)"""
    m = len(profile); V = []; F = []; FI = []
    cx, cy, cz = center
    for s in range(seg):
        a = 2*pi*s/seg; ca, sa = math.cos(a), math.sin(a)
        for (r, h, _) in profile:
            r *= scale; h *= scale
            if axis == 'Z': V.append((cx+r*ca, cy+r*sa, cz+h))
            elif axis == 'X': V.append((cx+h, cy+r*ca, cz+r*sa))
            else: V.append((cx+r*ca, cy+h, cz+r*sa))
    for s in range(seg):
        for k in range(m-1):
            a = s*m+k; b = a+1; s2 = ((s+1) % seg)*m
            F.append((a, b, s2+k+1, s2+k)); FI.append(profile[k][2])
    return V, F, FI

def box(c, size, rot=None, fid=5):
    cx, cy, cz = c; sx, sy, sz = [s/2 for s in size]
    V = [(cx+x*sx, cy+y*sy, cz+z*sz) for x in (-1,1) for y in (-1,1) for z in (-1,1)]
    if rot is not None:
        V = [tuple(Vector(c) + rot @ (Vector(v)-Vector(c))) for v in V]
    F = [(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]
    return V, F, [fid]*6

def cyl(p0, p1, r, seg=12, fid=5, caps=True):
    p0, p1 = Vector(p0), Vector(p1); d = (p1-p0); L = d.length; d.normalize()
    up = Vector((0,0,1)) if abs(d.z) < 0.9 else Vector((1,0,0))
    u = d.cross(up).normalized(); v = d.cross(u)
    rings = [[tuple(p + r*(math.cos(2*pi*k/seg)*u + math.sin(2*pi*k/seg)*v)) for k in range(seg)] for p in (p0, p1)]
    return loft(rings, cap0=caps, cap1=caps, fid=lambda i,j: fid)

def merge(*parts):
    V=[];F=[];FI=[]
    for (v,f,fi) in parts:
        o=len(V); V+=list(v); F+=[tuple(x+o for x in ff) for ff in f]; FI+=list(fi)
    return V,F,FI

def sphere(c, r, fid, seg=10, rings=6):
    prof = [(r*math.sin(pi*k/rings), -r*math.cos(pi*k/rings), fid) for k in range(rings+1)]
    return lathe_open(prof, seg, c, 'Z')

# ---------------- fuselage ----------------
Y0, Y1 = -6.0, 5.7
RAMP0, RAMP1 = 1.4, 4.0
N = 64
def fus(y):
    if y < -2.4: f=(y-Y0)/3.6; w=2.5*max(0,(1-(1-f)**2.0))**0.5
    elif y < 3.0: w=2.5
    else: w=2.5-1.85*ss((y-3.0)/(Y1-3.0))
    if y < -2.0: f=(y-Y0)/4.0; zt=2.05+1.40*(1-(1-f)**2.2)
    elif y < 2.6: zt=3.45
    else: zt=3.45-0.15*ss((y-2.6)/(Y1-2.6))
    if y < -3.4: f=(y-Y0)/2.6; zb=2.05-0.90*(1-(1-f)**2)
    elif y < RAMP0: zb=1.15
    else: zb=1.15+1.95*ss((y-RAMP0)/(Y1-RAMP0))
    p = 2.0 + 0.75*ss((y-Y0)/3.0)
    return w, zb, zt, p

def ring(y, inset=0.0, n=N):
    w, zb, zt, p = fus(y); zc=(zb+zt)/2; hh=(zt-zb)/2; hw=w/2
    pts=[]
    for k in range(n):
        t=2*pi*k/n; s,c=math.sin(t),math.cos(t)
        x=hw*math.copysign(abs(s)**(2/p),s); z=hh*math.copysign(abs(c)**(2/p),c)
        if inset:
            r=math.hypot(x,z); 
            if r>1e-6: f=max(0.0,1-inset/r); x*=f; z*=f
        pts.append((x, y, zc+z))
    return pts

ys = list(np.concatenate([Y0+0.02+ (np.linspace(0,1,14)**1.8)*3.5, np.linspace(-2.45,RAMP0,16)[1:], np.linspace(RAMP0,RAMP1,11)[1:], np.linspace(RAMP1,Y1,13)[1:]]))
ys = [float(v) for v in ys]
rings = [ring(y) for y in ys]
BOT = list(range(24, 40))   # quad j indices in bottom arc (k 24..40)
def in_ramp(i): return ys[i] >= RAMP0-1e-6 and ys[i+1] <= RAMP1+1e-6
def fus_fid(i, j):
    ym = (ys[i]+ys[min(i+1,len(ys)-1)])/2
    a = (j+0.5)/N*360; a = a if a <= 180 else a-360   # angle from top
    if -4.75 < ym < -3.35 and abs(a) < 82 and not (abs(a) < 4):
        return IDS['glass']                      # wrap-around windshield, thin centre post
    if -3.15 < ym < -2.2 and 34 < abs(a) < 82:
        return IDS['glass']                      # cockpit side windows behind the bow frame
    return IDS['fus']
V,F,FI = loft(rings, skip=lambda i,j: in_ramp(i) and j in BOT, fid=fus_fid)
fuselage = mesh_obj('Fuselage', V, F, FI, smooth_angle=50)

# ramp (thick shell strip) hinge at y=RAMP0
ri = [i for i,y in enumerate(ys) if RAMP0-1e-6 <= y <= RAMP1+1e-6]
outer = [[ring(ys[i], inset=-0.006)[k] for k in range(24, 41)] for i in ri]
inner = [[ring(ys[i], inset=0.07)[k] for k in range(24, 41)] for i in ri]
nr, nk = len(ri), 17
Vr = [p for r in outer for p in r] + [p for r in inner for p in r]; off = nr*nk; Fr=[]
for i in range(nr-1):
    for k in range(nk-1):
        a=i*nk+k; Fr.append((a, a+1, a+nk+1, a+nk)); Fr.append((off+a+nk, off+a+nk+1, off+a+1, off+a))
for i in range(nr-1):  # side edges
    for k in (0, nk-1):
        a=i*nk+k; b=(i+1)*nk+k; Fr.append((a, b, off+b, off+a))
for i in (0, nr-1):
    for k in range(nk-1):
        a=i*nk+k; Fr.append((a, off+a, off+a+1, a+1))
ramp = mesh_obj('Ramp', Vr, Fr, [IDS['fus']]*len(Fr), smooth_angle=50, part='ramp')
# interior floor stripes on ramp inner face are handled in texture (liner region by normal)

# interior liner (inward), floor, seats, crate
yl = [y for y in ys if -2.0 <= y <= RAMP1+1e-6]; yl = [-2.0] + [y for y in yl if y > -1.99]
lr = [ring(y, inset=0.07) for y in yl]
def liner_skip(i,j): return yl[i] >= RAMP0-1e-6 and yl[i+1] <= RAMP1+1e-6 and j in BOT
V,F,FI = loft(lr, skip=liner_skip, cap1=False, fid=lambda i,j: IDS['liner'])
# rear partial bulkhead: fan over the non-bottom ring points at RAMP1
r = lr[-1]; n=len(r); top=[k for k in range(n) if not (24 < k < 40)]
c = tuple(sum(r[k][q] for k in top)/len(top) for q in range(3)); o=len(V); V=list(V)+list(r)+[c]
seq=[k for k in range(40, n)]+[k for k in range(0, 25)]
for a,b in zip(seq[:-1], seq[1:]): F.append((o+a, o+b, o+n)); FI.append(IDS['liner'])
liner = mesh_obj('Liner', V, F, FI, smooth_angle=50, part='int')
bm=bmesh.new(); bm.from_mesh(liner.data)
for f in bm.faces: f.normal_flip()
bm.to_mesh(liner.data); bm.free()
# floor
parts=[box((0, (-1.95+RAMP0)/2, 1.31), (1.42, RAMP0+1.95, 0.04), fid=IDS['floor'])]
for sx in (-1,1):
    for yy in (-1.25, -0.45, 0.35):
        parts.append(box((sx*0.80, yy, 1.70), (0.46, 0.48, 0.10), fid=IDS['graphite']))
        parts.append(box((sx*1.00, yy, 2.12), (0.08, 0.46, 0.80), rot=Matrix.Rotation(-sx*0.12,3,'Y'), fid=IDS['graphite']))
        parts.append(box((sx*0.80, yy, 1.52), (0.06, 0.06, 0.36), fid=IDS['graphite']))
parts.append(box((0.0, 0.95, 1.63), (0.8, 0.7, 0.6), fid=IDS['crate']))
parts.append(box((0.0, -1.98, 2.25), (0.9, 0.02, 0.5), fid=IDS['cyan']))   # bulkhead light panel
V,F,FI = merge(*parts); interior = mesh_obj('Interior', V, F, FI, smooth_angle=20, part='int')

# ---------------- wing ----------------
def airfoil(npts=12, t=0.13, m=0.02, pcam=0.4):
    xs=[0.5*(1-math.cos(pi*k/npts)) for k in range(npts+1)]
    def yt(x): return 5*t*(0.2969*math.sqrt(x)-0.1260*x-0.3516*x*x+0.2843*x**3-0.1036*x**4)
    def yc(x): return m/pcam**2*(2*pcam*x-x*x) if x<pcam else m/(1-pcam)**2*((1-2*pcam)+2*pcam*x-x*x)
    up=[(x, yc(x)+yt(x)) for x in reversed(xs)]; lo=[(x, yc(x)-yt(x)) for x in xs[1:-1]]
    return up+lo
AF = airfoil()
SPAN = 3.85
def wing_sec(x):
    s=abs(x)/SPAN; c=2.45-0.75*s; le=-1.55+0.25*s; zc=3.58+0.06*s
    return [(x, le+u*c, zc+v*c) for (u,v) in AF]
wx = [-3.85,-3.2,-2.5,-1.8,-1.2,-0.6,0,0.6,1.2,1.8,2.5,3.2,3.85]
V,F,FI = loft([wing_sec(x) for x in wx], fid=lambda i,j: IDS['wing'])
wing = mesh_obj('Wing', V, F, FI, smooth_angle=40)

# ---------------- ducts ----------------
DUCT = [(1.0,-0.42,12),(1.0,-0.2,12),(0.995,0.05,12),(1.0,0.22,11),(1.02,0.34,4),(1.06,0.405,4),(1.11,0.43,4),(1.16,0.41,4),
        (1.18,0.36,17),(1.18,0.15,17),(1.17,-0.1,17),(1.14,-0.3,17),(1.08,-0.42,4),(1.04,-0.435,12)]
HUB = [(0.0,0.30,4),(0.11,0.27,4),(0.19,0.19,4),(0.22,0.06,5),(0.22,-0.30,5),(0.12,-0.40,5),(0.0,-0.42,5)]
def blade(c, sc, k, nb, z):
    a0=2*pi*k/nb; secs=[]
    for rr,ch,tw in ((0.20,0.20,38),(0.45,0.19,30),(0.72,0.16,22),(0.97,0.13,15)):
        tw=math.radians(tw); pts=[]
        for (u,v) in ((-0.5,0),(0,0.012),(0.5,0),(0,-0.012)):
            px=u*ch*math.cos(tw); pz=u*ch*math.sin(tw)+v
            # local blade frame: radial along (cos a0, sin a0), chord tangential
            rx,ry=math.cos(a0),math.sin(a0); tx,ty=-ry,rx
            pts.append((c[0]+sc*(rr*rx+px*tx), c[1]+sc*(rr*ry+px*ty), c[2]+sc*(z+pz)))
        secs.append(pts)
    return loft(secs, fid=lambda i,j: IDS['blade'])
def duct(c, sc, seg, inboard_sign):
    parts=[lathe(DUCT, seg, c, 'Z', sc, phase=pi/seg)]
    parts.append(lathe_open(HUB, 16, c, 'Z', sc))
    for k in range(9): parts.append(blade(c, sc, k, 9, 0.12))
    for a in (pi/2, 3*pi/2, (pi if inboard_sign>0 else 0)+0.0):
        p0=(c[0]+sc*0.2*math.cos(a), c[1]+sc*0.2*math.sin(a), c[2]-0.22*sc); p1=(c[0]+sc*1.0*math.cos(a), c[1]+sc*1.0*math.sin(a), c[2]-0.22*sc)
        parts.append(cyl(p0,p1,0.035*sc,6,IDS['graphite']))
    return merge(*parts)
FD = (4.85, -0.9, 3.64); FS = 0.9; RD = (2.6, 3.65, 2.95); RS = 0.68
ductparts=[]
for sx in (-1,1):
    ductparts.append(duct((sx*FD[0],FD[1],FD[2]), FS, 48, -sx))
    ductparts.append(cyl((sx*3.62,FD[1],FD[2]), (sx*3.88,FD[1],FD[2]), 0.18, 16, IDS['copper']))     # pivot collar
    ductparts.append(cyl((sx*3.95,FD[1],FD[2]-0.2), (sx*4.67,FD[1],FD[2]-0.2), 0.055, 8, IDS['graphite']))  # inboard stator/spindle
    ductparts.append(duct((sx*RD[0],RD[1],RD[2]), RS, 36, -sx))
V,F,FI = merge(*ductparts); ducts = mesh_obj('Ducts', V, F, FI, smooth_angle=40)

# rear stub wings + front pylon fairing
def stub(x0,x1,yc,zc,ch,t):
    secs=[[(x, yc-ch/2+u*ch, zc+v*ch) for (u,v) in airfoil(8,t,0.0)] for x in (x0,(x0+x1)/2,x1)]
    return loft(secs, fid=lambda i,j: IDS['fus'])
V,F,FI = merge(stub(-1.95,-0.9,RD[1],RD[2],0.85,0.14), stub(0.9,1.95,RD[1],RD[2],0.85,0.14))
stubs = mesh_obj('Stubs', V, F, FI, smooth_angle=40)

# ---------------- V tail ----------------
def fin(sx):
    cant=math.radians(38); secs=[]
    for s,(y0,ch) in ((0,(4.25,1.45)),(0.5,(4.75,1.05)),(1.0,(5.05,0.72))):
        L=s*1.35; pts=[]
        for (u,v) in airfoil(8,0.09,0.0):
            lx = v*ch   # thickness across
            px = sx*(0.22 + L*math.sin(cant)) + lx*math.cos(cant)
            pz = 3.30 + L*math.cos(cant) - sx*lx*math.sin(cant)
            pts.append((px, y0+u*ch, pz))
        secs.append(pts)
    return loft(secs, fid=lambda i,j: IDS['fin'])
V,F,FI = merge(fin(-1), fin(1)); fins = mesh_obj('Fins', V, F, FI, smooth_angle=40)

# ---------------- sponsons ----------------
def sponson(sx):
    secs=[]
    for y in np.linspace(-0.1, 2.7, 10):
        s=math.sin(pi*(y+0.1)/2.8)**0.45; w=0.62*s+0.02; h=0.78*s+0.02
        p=2.4; pts=[]
        for k in range(24):
            t=2*pi*k/24; a,b=math.sin(t),math.cos(t)
            pts.append((sx*1.30+w/2*math.copysign(abs(a)**(2/p),a), float(y), 1.50+h/2*math.copysign(abs(b)**(2/p),b)))
        secs.append(pts)
    return loft(secs, fid=lambda i,j: IDS['sponson'])
V,F,FI = merge(sponson(-1), sponson(1)); sponsons = mesh_obj('Sponsons', V, F, FI, smooth_angle=50)

# ---------------- landing gear ----------------
TIRE = [(0.62,-0.5,6),(0.86,-0.5,6),(0.97,-0.38,6),(1.0,0.0,6),(0.97,0.38,6),(0.86,0.5,6),(0.62,0.5,6),(0.60,0.3,5),(0.30,0.32,5),(0.15,0.15,4),(0.15,-0.15,4),(0.30,-0.32,5),(0.60,-0.3,5)]
def wheel(c, R, W):
    prof=[(r*R, h*W, i) for (r,h,i) in TIRE]
    return lathe(prof, 24, c, 'X', 1.0)
gp=[]
for sx in (-1,1):
    gp.append(wheel((sx*1.64, 1.45, 0.42), 0.42, 0.30))
    gp.append(cyl((sx*1.40,1.45,1.25),(sx*1.40,1.45,0.62),0.085,12,IDS['graphite']))
    gp.append(cyl((sx*1.40,1.45,0.66),(sx*1.40,1.45,0.40),0.055,10,IDS['copper']))
    gp.append(cyl((sx*1.38,1.45,0.42),(sx*1.66,1.45,0.42),0.05,10,IDS['graphite']))
    gp.append(cyl((sx*1.12,1.0,1.25),(sx*1.40,1.42,0.75),0.04,8,IDS['graphite']))
    gp.append(cyl((sx*1.12,1.9,1.25),(sx*1.40,1.48,0.75),0.04,8,IDS['graphite']))
    gp.append(box((sx*0.33,-3.95,0.98),(0.03,0.95,0.42),fid=IDS['fus']))   # nose gear doors
for sx in (-1,1): gp.append(wheel((sx*0.17,-3.95,0.33),0.33,0.17))
gp.append(cyl((0,-3.95,1.30),(0,-3.95,0.62),0.07,12,IDS['graphite']))
gp.append(cyl((0,-3.95,0.66),(0,-3.95,0.33),0.045,10,IDS['copper']))
gp.append(cyl((-0.27,-3.95,0.33),(0.27,-3.95,0.33),0.04,10,IDS['graphite']))
gp.append(box((0,-3.80,0.80),(0.06,0.26,0.06),rot=Matrix.Rotation(0.5,3,'X'),fid=IDS['graphite']))
V,F,FI = merge(*gp); gear = mesh_obj('Gear', V, F, FI, smooth_angle=40)

# ---------------- lights & small details ----------------
lp=[sphere((5.925,FD[1],FD[2]),0.06,IDS['red']), sphere((-5.925,FD[1],FD[2]),0.06,IDS['green']),
    sphere((0,5.72,3.20),0.06,IDS['white']), sphere((0,1.9,3.47),0.08,IDS['red']),
    sphere((0,-5.05,1.47),0.09,IDS['white']), sphere((0,-4.6,1.30),0.13,IDS['graphite'])]
for sx in (-1,1):
    L=1.35; cant=math.radians(38)
    lp.append(sphere((sx*(0.22+L*math.sin(cant)), 5.40, 3.30+L*math.cos(cant)),0.05,IDS['white']))
V,F,FI = merge(*lp); lights = mesh_obj('Lights', V, F, FI, smooth_angle=80)

for o in scn.objects: o.select_set(False)
tris = sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in scn.objects)
print('PARTS', [(o.name, sum(len(p.vertices)-2 for p in o.data.polygons)) for o in scn.objects])
print('TOTAL_TRIS', tris)
bb=np.array([v.co[:] for o in scn.objects for v in o.data.vertices])
print('BBOX min', bb.min(0), 'max', bb.max(0), 'size', bb.max(0)-bb.min(0))
bpy.ops.wm.save_as_mainfile(filepath='/workspace/vtol-mdl/vtol_build.blend')
