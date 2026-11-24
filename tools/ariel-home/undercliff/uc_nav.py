#!/usr/bin/env python3
"""uc_nav.py BUILD_DIR REPO - t1583u P3: the walk / camera data for the Solenne undercliff (ui/dm-undercliff.js).

Reads BUILD_DIR/p2-build.json (p2_build.py) and the exported zone GLBs (uc-zone-*.glb, uc-add-bay.glb, uc-add-lid.glb), writes
REPO/assets/ariel-home/ariel-home-undercliff-nav.json. Frame = the mansion GLB frame in u (x east, y seaward, z up, relative to the mansion root),
the same frame as ariel-home-interior-nav.json, so ui/dm-undercliff.js shares the interior walker's maths.

  region   [x0,y0,x1,y1]  everything the undercliff owns in plan
  roofZ    below this (feet) the region is ours; above it the exterior collision grid / the mansion interior answer (except the hatch opening)
  patches  floors: ['r',x0,y0,x1,y1,h] flat, ['s',x0,y0,x1,y1,'x'|'y',h0,h1] ramp (stairs: h0 at x0/y0, h1 at x1/y1); highest one <= feet + STEP wins
  zones    [x0,y0,x1,y1,floorZ,ceilZ,name] open volumes (rooms, corridors, bay, stair tunnel, hangar, hatch shaft): the camera clamp's ceilings; rock elsewhere
  wall     occupancy of every upright triangle (walls, door reveals, furniture sides, railings, the VTOL hull) on `cell` u cells, as up to k separate
           z intervals per cell: base64 records (Int32 cell = j*nx+i, Int16 zlo*10, Int16 zhi*10). Blocks her when her body [feet + 0.8, feet + 2.8] overlaps [zlo, zhi].
  apron    [x0,y0,x1,y1] lower-pool-deck cells under the top-level overhang (the max-height exterior grid reports the slab there): floor = the deck
  hatch    the vehicle opening: rim [x0,y0,x1,y1] + the closed lid's walk height; open = the lid patch is skipped (she can drop or take the scaffold)
  lights   warm fixtures [x,y,z,reach_u,k] for the world's 2-light pool (DMNatLights): the two nearest to her are real lights
  spawn    named spots [x,y,z]"""
import sys, os, json, math, base64
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_tool import Glb
B, R = sys.argv[1], sys.argv[2]
P = json.load(open(os.path.join(B, 'p2-build.json'))); C = P['consts']; L = P['layout']['L']
U, Y0U, FU = C['U'], C['Y0U'], C['FU']
def xu(X): return round(X * U, 3)
def yu(D): return round(Y0U - D * U, 3)          # D = metres into the cliff
def zu(H): return round(FU + H * U, 3)          # H = metres above the pool deck
def rect(X0, X1, D0, D1, H):
    return ['r', min(xu(X0), xu(X1)), min(yu(D0), yu(D1)), max(xu(X0), xu(X1)), max(yu(D0), yu(D1)), zu(H)]
patches, zones = [], []
# rooms / corridors / bay (all at the pool-deck level); the bay floor reaches 0.6 u out over the deck so the seam has no gap
for k, r in L.items():
    X0, X1 = r['X']; D0, D1 = r['D']; Hc = r['H'][1]
    d0 = D0 - (0.34 if k == 'bay' else 0.0)
    patches.append(rect(X0, X1, d0, D1, 0.0)); zones.append([xu(X0), yu(D1), xu(X1), yu(d0), zu(0), zu(Hc), k])
# lower-level stair tunnel (D 28..31) down to the hangar floor: flights are ramps along x
ST = P['layout']['ST']; sd0, sd1 = ST['D']
for s in P['stair']:
    if s['kind'] == 'flight': patches.append(['s', xu(s['x_lo']), yu(sd1), xu(s['x_hi']), yu(sd0), 'x', zu(s['h_lo']), zu(s['h_hi'])])
    else: patches.append(rect(s['x_lo'], s['x_hi'], sd0, sd1, s['h']))
zones.append([xu(-50.24 - 0.3), yu(sd1), xu(ST['x_top']), yu(sd0), zu(-12.0), zu(3.2), 'stair'])
# hangar floor + shaft
HG = P['layout']['HG']; hx0, hx1 = HG['X']; hd0, hd1 = HG['D']
patches.append(rect(hx0, hx1, hd0, hd1, -12.0)); zones.append([xu(hx0), yu(hd1), xu(hx1), yu(hd0), zu(-12.0), zu(6.0), 'hangar'])
SH = P['layout']['SHAFT']; zones.append([xu(SH['X'][0]), yu(SH['D'][1]), xu(SH['X'][1]), yu(SH['D'][0]), zu(-12.0), 1e4, 'shaft'])
# scaffold stair: landings + flights (high end = 'hi' along the axis; for ax 'y' the coordinate is -D)
for l in P['lanes']:
    if l['kind'] == 'landing': patches.append(rect(l['x0'], l['x1'], l['d0'], l['d1'], l['h'])); continue
    if l['ax'] == 'x':
        x0, x1 = xu(min(l['x0'], l['x1'])), xu(max(l['x0'], l['x1'])); hiAtX1 = abs(l['hi'] - max(l['x0'], l['x1'])) < 1e-6
        h0, h1 = (zu(l['h_lo']), zu(l['h_hi'])) if hiAtX1 else (zu(l['h_hi']), zu(l['h_lo']))
        patches.append(['s', x0, min(yu(l['d0']), yu(l['d1'])), x1, max(yu(l['d0']), yu(l['d1'])), 'x', h0, h1])
    else:
        # y_u = Y0U - D*U; 'hi' is -D of the high end
        Dhi = -l['hi']; y_lo_end, y_hi_end = yu(-l['lo']), yu(Dhi)
        y0, y1 = min(y_lo_end, y_hi_end), max(y_lo_end, y_hi_end)
        h0, h1 = (zu(l['h_hi']), zu(l['h_lo'])) if abs(y_hi_end - y0) < 1e-6 else (zu(l['h_lo']), zu(l['h_hi']))
        patches.append(['s', xu(l['x0']), y0, xu(l['x1']), y1, 'y', h0, h1])
# the hatch frame's walkable tops: the 1 m curb round the rim and the grating over the 2 m scaffold strip (up-facing quads of uc-add-frame.glb at grating level)
fr = Glb(os.path.join(B, 'uc-add-frame.glb')); seen = set()
for me in fr.J['meshes']:
    for p in me['primitives']:
        Pp = fr.acc[p['attributes']['POSITION']].astype(np.float64); I = fr.acc[p['indices']].reshape(-1, 3).astype(np.int64); V = Pp[I]
        nn = np.cross(V[:, 1] - V[:, 0], V[:, 2] - V[:, 0]); up = nn[:, 1] / np.maximum(np.linalg.norm(nn, axis=1), 1e-12)
        for t in V[up > 0.9]:
            bx, by, bz = t[:, 0], -t[:, 2], t[:, 1]
            if not (0.3 < bz.mean() < 1.3): continue
            k = (round(bx.min(), 2), round(by.min(), 2), round(bx.max(), 2), round(by.max(), 2), round(bz.mean(), 3))
            if k in seen or (k[2] - k[0]) < 0.2 or (k[3] - k[1]) < 0.2: continue
            seen.add(k); patches.append(['r', k[0], k[1], k[2], k[3], k[4]])
# hatch (lid) - from the lid GLB bounds
lid = Glb(os.path.join(B, 'uc-add-lid.glb')); mx = -1e9
for me in lid.J['meshes']:
    for p in me['primitives']:
        a = lid.J['accessors'][p['attributes']['POSITION']]; mx = max(mx, a['max'][1])
lidNode = [n for n in lid.J['nodes'] if n.get('name', '').startswith('uc_hatch_lid')][0]; lidTop = round(lidNode['translation'][1] + mx * 0 + 0.0, 3)
hx = C['hatch']   # [x0, x1, y0(m, -D), y1]
rim = [xu(hx[0]), round(Y0U + hx[2] * U, 3), xu(hx[1]), round(Y0U + hx[3] * U, 3)]
rim = [min(rim[0], rim[2]), min(rim[1], rim[3]), max(rim[0], rim[2]), max(rim[1], rim[3])]
# walk height of the closed lid = the top of the leaves (measured from the leaf meshes, in the lid's frame)
leafTop = -1e9
for nd in lid.J['nodes']:
    if 'mesh' in nd:
        for p in lid.J['meshes'][nd['mesh']]['primitives']:
            leafTop = max(leafTop, lid.J['accessors'][p['attributes']['POSITION']]['max'][1] + (nd.get('translation') or [0, 0, 0])[1])
lidZ = round(lidNode['translation'][1] + leafTop, 3)
hatch = dict(rim=rim, z=lidZ, frame=[xu(C['frame'][0]), round(Y0U + C['frame'][2] * U, 3), xu(C['frame'][1]), round(Y0U + C['frame'][3] * U, 3)])
hatch['frame'] = [min(hatch['frame'][0], hatch['frame'][2]), min(hatch['frame'][1], hatch['frame'][3]), max(hatch['frame'][0], hatch['frame'][2]), max(hatch['frame'][1], hatch['frame'][3])]
# the walls grid
xs = [z[0] for z in zones] + [z[2] for z in zones]; ys = [z[1] for z in zones] + [z[3] for z in zones]
reg = [math.floor(min(xs)) - 2, math.floor(min(ys)) - 2, math.ceil(max(xs)) + 2, round(max(ys), 3)]   # seaward edge = the bay floor's lip over the deck exactly (the deck beyond is the interior walker's)
CELL = 0.25; nx = int(math.ceil((reg[2] - reg[0]) / CELL)); ny = int(math.ceil((reg[3] - reg[1]) / CELL))
FLIGHTS = [(p[1], p[2], p[3], p[4], 1 if p[5] == 'y' else 0, p[6], p[7]) for p in patches if p[0] == 's']
ZB0, ZBS, NZB = -46.0, 0.25, 260                 # occupancy bins in z (u): -46 .. +19
occ = np.zeros((nx * ny, NZB), dtype=bool)
def raster(path, skip_nodes=()):
    g = Glb(path); n = 0
    # node -> mesh with its translation (the zone files are baked in the mansion frame; the VTOL sits under uc_vtol with T/R/S)
    def walk(ni, M):
        nonlocal n
        nd = g.J['nodes'][ni]; name = nd.get('name', '')
        skipMesh = any(name.startswith(s) for s in skip_nodes)   # the node's own mesh is skipped; its children are still visited
        T = np.eye(4)
        if 'translation' in nd: T[:3, 3] = nd['translation']
        if 'rotation' in nd:
            x, y, z, w = nd['rotation']; T[:3, :3] = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]) @ T[:3, :3]
        if 'scale' in nd: T[:3, :3] = T[:3, :3] @ np.diag(nd['scale'])
        M2 = M @ T
        if 'mesh' in nd and not skipMesh:
            for p in g.J['meshes'][nd['mesh']]['primitives']:
                Pp = g.acc[p['attributes']['POSITION']].astype(np.float64); I = g.acc[p['indices']].reshape(-1, 3).astype(np.int64)
                Pw = (M2[:3, :3] @ Pp.T).T + M2[:3, 3]; V = Pw[I]   # glTF frame: (x, z_u, -y_u)
                nrm = np.cross(V[:, 1] - V[:, 0], V[:, 2] - V[:, 0]); ln = np.linalg.norm(nrm, axis=1); ok = ln > 1e-9
                up = np.abs(nrm[:, 1]) / np.maximum(ln, 1e-12); sel = ok & (up < 0.7)
                for t in V[sel]:
                    a, b, c = t; e = max(np.linalg.norm(b - a), np.linalg.norm(c - a), np.linalg.norm(c - b)); st = min(60, int(math.ceil(e / (CELL * 0.6))) + 1)
                    u = np.arange(st + 1) / st; uu, vv = np.meshgrid(u, u); m = (uu + vv) <= 1.0 + 1e-9; uu, vv = uu[m], vv[m]
                    pts = a + np.outer(uu, b - a) + np.outer(vv, c - a)
                    bx, by, bz = pts[:, 0], -pts[:, 2], pts[:, 1]
                    ix = np.floor((bx - reg[0]) / CELL).astype(int); iy = np.floor((by - reg[1]) / CELL).astype(int)
                    k = (ix >= 0) & (iy >= 0) & (ix < nx) & (iy < ny)
                    for f in FLIGHTS:   # stair / scaffold risers: anything within a flight's plan below the tread line + 0.7 u is a step, not a wall (the ramp patch is the floor)
                        x0, y0, x1, y1, ax, h0, h1 = f
                        inf = (bx >= x0 - 0.3) & (bx <= x1 + 0.3) & (by >= y0 - (0.3 if ax else 0)) & (by <= y1 + (0.3 if ax else 0)) if ax else (bx >= x0 - 0.3) & (bx <= x1 + 0.3) & (by >= y0) & (by <= y1)
                        if not inf.any(): continue
                        u_ = np.clip(((by - y0) / (y1 - y0)) if ax else ((bx - x0) / (x1 - x0)), 0, 1); rh = h0 + (h1 - h0) * u_
                        k &= ~(inf & (bz < rh + 0.7))
                    idx = iy[k] * nx + ix[k]
                    iz = np.clip(np.floor((bz[k] - ZB0) / ZBS).astype(int), 0, NZB - 1); occ[idx, iz] = True; n += 1
        for ch in nd.get('children', []): walk(ch, M2)
    for r0 in g.J['scenes'][g.J.get('scene', 0)]['nodes']: walk(r0, np.eye(4))
    return n
cnt = {}
for z in ('lower', 'stair', 'hangar'): cnt[z] = raster(os.path.join(B, 'uc-zone-%s.glb' % z))
cnt['bay'] = raster(os.path.join(B, 'uc-add-bay.glb'))
cnt['frame'] = raster(os.path.join(B, 'uc-add-frame.glb'))
# the VTOL hull (LOD2: 1.4k tris is plenty for a walk blocker) from the packaged undercliff GLB
cnt['vtol'] = raster(os.path.join(R, 'assets/ariel-home/ariel-home-undercliff.glb'), skip_nodes=('uc_zone', 'Meadowlark_LOD0', 'Meadowlark_LOD1', 'Meadowlark_Ramp'))
# per cell: the occupied z intervals (a gap > GAP u splits them, so a stair flight under / over another or a lintel over a doorway stay separate), at most WK
GAP, WK = 0.75, 4
has = occ.any(axis=1); recs = []; merged = 0
for c in np.nonzero(has)[0]:
    b = np.nonzero(occ[c])[0]; iv = [[b[0], b[0]]]
    for z in b[1:]:
        if (z - iv[-1][1]) * ZBS > GAP: iv.append([z, z])
        else: iv[-1][1] = z
    while len(iv) > WK:   # merge the closest pair
        g = min(range(len(iv) - 1), key=lambda t: iv[t + 1][0] - iv[t][1]); iv[g][1] = iv[g + 1][1]; del iv[g + 1]; merged += 1
    for a, e in iv: recs.append((int(c), int(math.floor((ZB0 + a * ZBS) * 10)), int(math.ceil((ZB0 + (e + 1) * ZBS) * 10))))
rec = np.zeros(len(recs), dtype=[('i', '<i4'), ('lo', '<i2'), ('hi', '<i2')])
for k, r in enumerate(recs): rec[k] = r
print('wall cells', int(has.sum()), 'intervals', len(recs), 'merged', merged)
lights = []
for Lt in P['lights']:
    if Lt['kind'] in ('cove',): continue   # coves are the bake's job; real light goes to downlights / pendants / high-bays / lamps
    reach = float(Lt.get('reach_m', 12)) * U * (1.6 if Lt['kind'] == 'highbay' else 1.0)
    lights.append([xu(Lt['x']), round(Y0U + Lt['y'] * U, 3), zu(Lt['z']), round(reach, 2), float(Lt.get('k', 1)), Lt['room'], Lt['kind']])
# the deck APRON: the lower pool deck under the top level / prow overhang. The exterior collision grid is a max-height map, so there it reports the slab /
# roof above and she could never stand on the deck in front of the bay; the undercliff owns those cells below roofZ (floor = the deck, camera ceiling 9 m).
COLG = json.load(open(os.path.join(R, 'assets/ariel-home/ariel-home-collide.json')))
cg = np.frombuffer(base64.b64decode(COLG['data']), dtype=np.int16).reshape(COLG['ny'], COLG['nx']) / COLG['scale']
DECK = [(-58, -2.9), (60, -2.9), (58, 30), (60, 44), (38, 62), (0, 74), (-50, 62), (-62, 44), (-56, 30)]   # p1_build UCL_lowerdeck outline (u)
def inpoly(x, y, P):
    c = False
    for i in range(len(P)):
        (x1, y1), (x2, y2) = P[i], P[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
apron, gc = [], COLG['cell']
for j in range(COLG['ny']):
    yc = COLG['y0'] + j * gc
    if yc < -3.0 or yc > 76: continue
    run = None
    for i in range(COLG['nx'] + 1):
        xc = COLG['x0'] + i * gc
        on = i < COLG['nx'] and inpoly(xc, max(yc, -2.8), DECK) and cg[j, i] > FU + 3.0
        if on and run is None: run = xc
        if not on and run is not None:
            apron.append([round(run - gc / 2, 3), round(max(yc - gc / 2, Y0U), 3), round(xc - gc / 2, 3), round(yc + gc / 2, 3)]); run = None
mg = []
for a in sorted(apron, key=lambda a: (a[0], a[2], a[1])):
    if mg and mg[-1][0] == a[0] and mg[-1][2] == a[2] and abs(mg[-1][3] - a[1]) < 1e-6: mg[-1][3] = a[3]
    else: mg.append(list(a))
apron = mg
for a in apron: patches.append(['r', a[0], a[1], a[2], a[3], zu(0)])
vt = P['vtol']
out = dict(v=1, about=__doc__.split('\n')[0], frame='mansion GLB frame (u): x east, y seaward, z up, rel. the mansion root; 1 m = %.2f u' % U, U=U,
           region=reg, roofZ=zu(7.0) + 1.0, deckZ=zu(0), hangarZ=zu(-12.0), patches=patches, zones=zones, hatch=hatch, apron=apron, apronCeil=zu(9.0),
           wall=dict(x0=reg[0], y0=reg[1], cell=CELL, nx=nx, ny=ny, k=WK, fmt='sparse i32 cell, i16 zlo*10, i16 zhi*10', data=base64.b64encode(rec.tobytes()).decode()), lights=lights,
           spawn=dict(bay=[0.0, yu(5.0), zu(0)], hangar=[xu(-60.0), yu(14.0), zu(-12.0)], scaffoldTop=[xu(-57.0), yu(46.3), zu(10.647)], vtol=[xu(vt['x']), Y0U + vt['y'] * U, zu(-12.0)]),
           stats=dict(cells=int(has.sum()), tris=cnt, patches=len(patches), zones=len(zones), apron=len(apron), lights=len(lights)))
dst = os.path.join(R, 'assets/ariel-home/ariel-home-undercliff-nav.json')
json.dump(out, open(dst, 'w'), separators=(',', ':'))
print(json.dumps(dict(out['stats'], bytes=os.path.getsize(dst), region=reg, hatch=hatch, roofZ=out['roofZ'])))
