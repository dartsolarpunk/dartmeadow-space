import numpy as np, math
from PIL import Image
D = np.load('/workspace/vtol-mdl/tex/bake_raw.npz')
P = D['P'].astype(np.float32); N = D['N'].astype(np.float32); I = D['I'].astype(np.int32); AO = D['A'].astype(np.float32); S = float(D['S'])
H, W = I.shape
x, y, z = P[...,0], P[...,1], P[...,2]; nx, ny, nz = N[...,0], N[...,1], N[...,2]; ax = np.abs(x)
valid = I > 0
def C(*rgb): return np.array(rgb, np.float32)/255.0
IVORY=C(233,227,212); SAGE=C(104,134,110); SAGED=C(70,96,78); COPPER=C(190,118,72); GRAPH=C(36,38,42); RUBBER=C(24,24,26)
LINER=C(78,82,86); DARK=C(30,32,36); BLADE=C(170,175,180); FLOOR=C(52,55,58); GLASS=C(10,15,19); CRATE=C(96,104,78)
SOLAR=C(14,24,52); SOLARL=C(150,160,175); LEMET=C(176,180,184)
EMC={8:C(255,40,30),9:C(40,255,100),10:C(255,250,236),11:C(60,228,255)}
base = np.zeros((H,W,3),np.float32); rough=np.full((H,W),0.5,np.float32); metal=np.zeros((H,W),np.float32)
emis = np.zeros((H,W,3),np.float32); hgt = np.zeros((H,W),np.float32)
def put(mask, col=None, r=None, m=None):
    if col is not None: base[mask] = col
    if r is not None: rough[mask] = r
    if m is not None: metal[mask] = m
def ssf(e0,e1,v): t=np.clip((v-e0)/(e1-e0),0,1); return t*t*(3-2*t)
def line(d, w):   # anti-aliased line mask from distance d (m), full width w
    return np.clip(1.0-(np.abs(d)-w/2)/S, 0, 1)
def sd_rrect(u, v, cu, cv, hu, hv, r):
    qx=np.abs(u-cu)-(hu-r); qy=np.abs(v-cv)-(hv-r)
    return np.hypot(np.maximum(qx,0),np.maximum(qy,0))+np.minimum(np.maximum(qx,qy),0)-r
def fill(sd): return np.clip(0.5-sd/S,0,1)
def vnoise(Pv, f, seed):
    Q=Pv*f; i=np.floor(Q).astype(np.int64); t=Q-i; t=t*t*(3-2*t)
    def h(a,b,c): return (((a*73856093) ^ (b*19349663) ^ (c*83492791) ^ seed) & 0xffff).astype(np.float32)/65535.0
    out=0
    for dx in (0,1):
        for dy in (0,1):
            for dz in (0,1):
                wgt=(t[...,0] if dx else 1-t[...,0])*(t[...,1] if dy else 1-t[...,1])*(t[...,2] if dz else 1-t[...,2])
                out=out+wgt*h(i[...,0]+dx,i[...,1]+dy,i[...,2]+dz)
    return out
noise = 0.6*vnoise(P,0.9,11)+0.3*vnoise(P,3.1,23)+0.1*vnoise(P,11.0,37)
fine = vnoise(P,40.0,5)

grooves = np.zeros((H,W),np.float32)    # 0..1 groove coverage (panel lines)
for i_ in (1,15,16,17,18): pass
paint = np.isin(I,[1,15,16,17,18])
fus = np.isin(I,[1,18])
# ---------- fuselage livery ----------
zl = 1.80 + 0.38*ssf(3.0,5.6,-y)                       # sage lower band sweeps up toward the nose
put(fus, IVORY, 0.34, 0.0)
low = fus & (z < zl); put(low, SAGE, 0.42)
pin = fus & (z > zl+0.03) & (z < zl+0.065); put(pin, COPPER, 0.3, 0.9)
# tail cone sage cap
put(fus & (y > 4.9), SAGE, 0.42)
put(fus & (y > 4.84) & (y < 4.9), COPPER, 0.3, 0.9)
# ramp inner surface (normal up when closed) -> anti-slip floor
rampin = (I==1) & (nz > 0.35) & (y > 1.35) & (y < 4.05) & (z < 2.6)
put(rampin, FLOOR, 0.55, 0.6)
rib = rampin & (line(((y-1.4) % 0.22) - 0.11, 0.05) > 0); hgt[rib] += 0.002*line(((y-1.4) % 0.22) - 0.11, 0.05)[rib]
# station seams
side = fus & ~rampin
for ys in (-4.95,-2.25,-0.95,0.55,1.4,2.95,4.02,4.87):
    grooves = np.maximum(grooves, side*line(y-ys, 0.006)*ssf(0.85,0.5,np.abs(ny)))
# ramp outline seams
grooves = np.maximum(grooves, side*(y>1.35)*(y<4.05)*line(np.abs(x) - 0.0, 0.0)*0)
# portside crew door, starboard hatch, nose access panels
sideface = fus & (np.abs(nx) > 0.45)
door = sideface & (x < 0)
sdd = sd_rrect(y, z, -1.65, 2.22, 0.50, 0.80, 0.12)
grooves = np.maximum(grooves, door*line(sdd, 0.009))
dwin = door & (sd_rrect(y, z, -1.65, 2.58, 0.22, 0.20, 0.07) < 0); put(dwin, GLASS, 0.04, 0.0)
grooves = np.maximum(grooves, door*line(sd_rrect(y, z, -1.65, 2.58, 0.22, 0.20, 0.07), 0.006))
hnd = door & (sd_rrect(y, z, -1.25, 2.05, 0.06, 0.025, 0.01) < 0); put(hnd, GRAPH, 0.5, 0.6); hgt[hnd] -= 0.004
stepl = door & (sd_rrect(y, z, -1.65, 1.50, 0.38, 0.012, 0.01) < 0); emis[stepl] = EMC[11]
hatch = sideface & (x > 0); grooves = np.maximum(grooves, hatch*line(sd_rrect(y, z, -1.2, 2.15, 0.30, 0.25, 0.05), 0.006))
grooves = np.maximum(grooves, sideface*line(sd_rrect(y, z, -3.35, 2.0, 0.35, 0.25, 0.05), 0.006))
grooves = np.maximum(grooves, sideface*line(sd_rrect(y, z, 3.45, 2.75, 0.22, 0.14, 0.03), 0.006))
# cabin windows
for yc in (-0.35, 0.45, 1.25, 2.05):
    sdw = sd_rrect(y, z, yc, 2.50, 0.23, 0.20, 0.08)
    w_ = sideface & (sdw < 0); put(w_, GLASS, 0.04, 0.0)
    grooves = np.maximum(grooves, sideface*line(sdw-0.02, 0.006))
# cyan side light strip
strip = sideface & (np.abs(z-2.90) < 0.012) & (y > -2.3) & (y < 3.7)
emis[strip] = EMC[11]; put(strip, C(200,240,250), 0.2)
# belly: centre keel seam
grooves = np.maximum(grooves, fus*(nz < -0.6)*line(x, 0.006)*(y < 1.4))
# sun emblem on both sides aft of the windows
for sx in (-1,1):
    m = sideface & (np.sign(x)==sx)
    dy, dz = y-3.0, z-2.45; rr = np.hypot(dy, dz); ang = np.arctan2(dz, dy)
    em = m & (rr < 0.13); put(em, COPPER, 0.3, 0.9)
    ray = m & (rr > 0.17) & (rr < 0.27) & (np.abs(((ang/(2*np.pi)*12) % 1)-0.5) > 0.32); put(ray, COPPER, 0.3, 0.9)
    leaf = m & (rr > 0.13) & (rr < 0.155); put(leaf, SAGED, 0.4, 0.0)
# ---------- wing ----------
wing = I==15
s_ = ax/3.85; ch = 2.45-0.75*s_; le = -1.55+0.25*s_; f = (y-le)/ch
put(wing, IVORY, 0.34, 0.0)
ledge = wing & (f < 0.055); put(ledge, LEMET, 0.3, 1.0)
tipb = wing & (ax > 3.52); put(tipb, SAGE, 0.42)
put(wing & (ax > 3.44) & (ax < 3.52), COPPER, 0.3, 0.9)
solar = wing & (nz > 0.5) & (ax > 1.38) & (ax < 3.38) & (f > 0.13) & (f < 0.78)
cu = (x % 0.156)/0.156; cv = (f*ch % 0.156)/0.156
cell_id = np.floor(x/0.156)*31 + np.floor(f*ch/0.156)
gap = (np.minimum(cu,1-cu)*0.156 < 0.004) | (np.minimum(cv,1-cv)*0.156 < 0.004)
bus = (np.abs(cu-0.33)*0.156 < 0.0012) | (np.abs(cu-0.66)*0.156 < 0.0012)
sc = SOLAR[None,:]*(0.85+0.3*((np.sin(cell_id*12.9898)*43758.5453) % 1))[...,None]
base[solar] = sc[solar]; rough[solar] = 0.14; metal[solar] = 0.25
put(solar & bus, SOLARL, 0.3, 0.8); put(solar & gap, C(200,205,210), 0.35, 0.9)
hgt[solar & gap] -= 0.0008
frame = wing & (nz > 0.5) & ~solar & (ax > 1.33) & (ax < 3.43) & (f > 0.11) & (f < 0.80); put(frame, C(190,192,195), 0.3, 0.9)
for fl in (0.82,):
    grooves = np.maximum(grooves, wing*(ax>1.35)*(ax<3.45)*line((f-fl)*ch, 0.008))
for xl in (1.3, 2.4, 3.48):
    grooves = np.maximum(grooves, wing*line(ax-xl, 0.006)*((f>0.82) | (xl!=2.4)))
# ---------- fins ----------
fin = I==16
put(fin, SAGE, 0.42, 0.0)
tip = fin & (z > 4.18); put(tip, IVORY, 0.34)
put(fin & (z > 4.14) & (z <= 4.18), COPPER, 0.3, 0.9)
yh = 5.25 + 0.2*(z-3.30)/1.06
grooves = np.maximum(grooves, fin*line(y-yh, 0.007))
for sx in (-1,1):
    L=0.62; c3=np.array([sx*(0.22+L*math.sin(math.radians(38))), 4.92, 3.30+L*math.cos(math.radians(38))],np.float32)
    rr = np.linalg.norm(P-c3, axis=-1); m = fin & (np.sign(x)==sx)
    put(m & (np.abs(rr-0.17) < 0.022), COPPER, 0.3, 0.9); put(m & (rr < 0.075), IVORY, 0.34, 0.0)
# ---------- ducts ----------
front = (y < 1.5) & (ax > 3.5)
dcx = np.where(front, 4.85*np.sign(x), 2.6*np.sign(x)); dcy = np.where(front, -0.9, 3.65); dcz = np.where(front, 3.64, 2.95); dsc = np.where(front, 0.9, 0.68)
lr = np.hypot(x-dcx, y-dcy)/dsc; lz = (z-dcz)/dsc; lang = np.arctan2(y-dcy, x-dcx)
shroud = I==17
put(shroud, SAGE, 0.42, 0.0)
put(shroud & (lz > 0.05) & (lz < 0.09), COPPER, 0.3, 0.9)
put(shroud & (lz > 0.09) & (lz < 0.36), IVORY, 0.34, 0.0)
grooves = np.maximum(grooves, shroud*line(((lang/(2*np.pi)*8) % 1 - 0.5)*2*np.pi*1.18*dsc/8, 0.006))
# chevron warning band on the inner duct wall
dk = I==12; put(dk, DARK, 0.5, 0.3)
chev = dk & (lz < -0.25) & (lz > -0.36) & ((((lang*1.18*dsc/0.12) + lz*dsc/0.12) % 1) < 0.5); put(chev, C(200,160,60), 0.5, 0.0)
bl = I==13; put(bl, BLADE, 0.28, 0.9); put(bl & (lr > 0.88), COPPER, 0.3, 0.9)
# ---------- misc ids ----------
put(I==4, COPPER, 0.3, 0.95); put(I==5, GRAPH, 0.45, 0.6); put(I==6, RUBBER, 0.88, 0.0)
tread = (I==6) & (((np.arctan2(z-np.where(y<-2,0.33,0.42), y-np.where(y<-2,-3.95,1.45))*24/np.pi) % 1) < 0.25); hgt[tread] -= 0.004; rough[tread]=0.95
put(I==2, GLASS, 0.04, 0.0)
liner = I==7; put(liner, LINER, 0.62, 0.0)
frm = liner & (line(((y+2.0) % 0.55)-0.275, 0.06) > 0); put(frm, C(60,63,67)); hgt[frm] += 0.003
ceil = liner & (nz < -0.6) & (np.abs(ax-0.42) < 0.03) & (y > -1.9) & (y < 3.9)
emis[ceil] = C(255,236,205); put(ceil, C(240,235,225), 0.3)
fl = I==14; put(fl, FLOOR, 0.5, 0.65)
grat = fl & ((np.minimum((x%0.1),(0.1-x%0.1)) < 0.008) | (np.minimum((y%0.1),(0.1-y%0.1)) < 0.008)); hgt[grat] += 0.002; put(grat, C(80,84,88))
cr = I==20; put(cr, CRATE, 0.6, 0.0)
edge = cr & ((np.minimum(np.abs(np.abs(x)-0.4), 9) < 0.05) | (np.abs(z-1.93) < 0.05) | (np.abs(z-1.33) < 0.05) | (np.abs(y-0.6)<0.05) | (np.abs(y-1.3)<0.05))
put(edge, C(60,66,52), 0.5, 0.3)
for k,v in EMC.items():
    m = I==k; base[m] = v; emis[m] = v; rough[m] = 0.2
# nav lights by side (Blender/glTF: port = +X, starboard = -X)
nav = np.isin(I,[8,9]) & (ax > 4.5)
for m_,v in ((nav & (x > 0), EMC[8]), (nav & (x < 0), EMC[9])):
    base[m_] = v; emis[m_] = v
# ---------- grooves -> colour, roughness, height ----------
g = grooves*paint
base *= (1 - 0.45*g)[...,None]; rough += 0.18*g; hgt -= 0.0022*g
# wear & grime
gr = paint | np.isin(I,[4,5,13,14,7])
base[gr] *= (1 - 0.07*noise[gr] - 0.05*fine[gr]*0.5)[...,None]
rough[gr] += 0.10*(noise[gr]-0.5) + 0.04*(fine[gr]-0.5)
base *= (1 - 0.14*(1-np.clip(AO,0,1)))[...,None]
# underside soot near ducts
soot = paint & (nz < -0.3); base[soot] *= 0.93
rough = np.clip(rough, 0.03, 1.0); metal = np.clip(metal, 0, 1)
# ---------- normal from height ----------
hp = np.pad(hgt, 1, mode='edge')
du = (hp[1:-1,2:]-hp[1:-1,:-2])/(2*S); dv = (hp[2:,1:-1]-hp[:-2,1:-1])/(2*S)
nrm = np.stack([-du, -dv, np.ones_like(du)], -1); nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
# Blender buffers are bottom-up; images on disk are top-down
def save(a, name, mode='RGB'):
    a = np.flipud(np.clip(a,0,1)); im = Image.fromarray((a*255+0.5).astype(np.uint8), mode); return im
out='/workspace/vtol-mdl/tex/'
bc = save(base, 'bc'); orm = save(np.stack([np.clip(AO,0,1)*0.85+0.15, rough, metal],-1),'orm'); nm = save(nrm*0.5+0.5,'nrm'); em = save(emis,'em')
for im,n in ((bc,'basecolor'),(orm,'orm'),(nm,'normal'),(em,'emissive')):
    im.save(out+'meadowlark-%s-2k.png'%n)
    im.resize((1024,1024), Image.LANCZOS).save(out+'meadowlark-%s-1k.png'%n)
print('ok', S)
