"""interior_lib.py: mesh accumulation + nav registry + GLB writer for the Ariel mansion interior (used by build_interior.py).
Frames: all geometry is authored in the mansion's Blender frame (x east, y toward the ocean, z up) and written to glTF as
(x, z, -y), i.e. the same mansion-local frame as ariel-home.glb after its Blender export."""
import json, math, struct

T = 6.0            # world units per texture-tile repeat
INSET = 0.004      # atlas tile edge inset (uv), keeps mips from bleeding neighbours
PAL = 15           # tile id of the 4x4 colour palette
M = 1.78           # units per metre (she is 3.26 u = 1.83 m)

def tile_uv(tile, ul, vl):
    tx, ty = tile % 4, tile // 4
    return ((tx + INSET + (1 - 2 * INSET) * ul) / 4.0, (ty + INSET + (1 - 2 * INSET) * (1 - vl)) / 4.0)

def sw_uv(sw):
    return (3 / 4.0 + ((sw % 4) + 0.5) / 16.0, 3 / 4.0 + ((sw // 4) + 0.5) / 16.0)

class Mesh:
    def __init__(s):
        s.pos = [[], [], []]; s.nrm = [[], [], []]; s.uv = [[], [], []]; s.col = [[], [], []]; s.idx = [[], [], []]
        s.lamps = []        # (x,y,z,radius,(r,g,b))
    def quad(s, mat, p, uv, tint=(1, 1, 1, 1)):
        a, b, c = p[0], p[1], p[2]
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]; vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); l = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
        if l < 1e-9:   # degenerate first triple: use the other
            if len(p) < 4: return
            a, b, c = p[0], p[2], p[3]; ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]; vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); l = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
            if l < 1e-9: return
        n = (n[0] / l, n[1] / l, n[2] / l)
        P, N, U, C, I = s.pos[mat], s.nrm[mat], s.uv[mat], s.col[mat], s.idx[mat]; k = len(P)
        for i in range(len(p)): P.append(p[i]); N.append(n); U.append(uv[i]); C.append(tint)
        I += [k, k + 1, k + 2] if len(p) == 3 else [k, k + 1, k + 2, k, k + 2, k + 3]
    def tris(s): return sum(len(i) // 3 for i in s.idx)

def _unit(v):
    l = math.sqrt(sum(c * c for c in v)); return tuple(c / l for c in v)

def face(Me, mat, tex, O, U, V, w, h, tint=(1, 1, 1, 1), maxcell=T, uvs=1.0, flipu=False):
    """rectangle at origin O spanned by unit vectors U (w long) and V (h long); normal = U x V. tex: tile id (int) or ('s', swatch)."""
    if isinstance(tex, tuple):
        c = sw_uv(tex[1]); nu = nv = 1
    else:
        nu = max(1, int(math.ceil(w / maxcell - 1e-6))); nv = max(1, int(math.ceil(h / maxcell - 1e-6)))
    for i in range(nu):
        for j in range(nv):
            a0 = w * i / nu; a1 = w * (i + 1) / nu; b0 = h * j / nv; b1 = h * (j + 1) / nv
            pts = [tuple(O[k] + U[k] * a + V[k] * b for k in range(3)) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))]
            if isinstance(tex, tuple): uv = [c] * 4
            else:
                s0 = (a1 - a0) / T * uvs; t0 = (b1 - b0) / T * uvs
                # offset each cell by its own origin modulo 1 so neighbouring cells vary a little
                uv = [tile_uv(tex, min(1.0, x), min(1.0, y)) for x, y in ((0, 0), (s0, 0), (s0, t0), (0, t0))]
            Me.quad(mat, pts, uv, tint)

def box(Me, x0, y0, z0, x1, y1, z1, tex, tint=(1, 1, 1, 1), skip='', mat=0, maxcell=T, uvs=1.0):
    X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
    w, d, h = x1 - x0, y1 - y0, z1 - z0
    if 'b' not in skip: face(Me, mat, tex, (x0, y1, z0), X, (0, -1, 0), w, d, tint, maxcell, uvs)            # bottom (-z)
    if 't' not in skip: face(Me, mat, tex, (x0, y0, z1), X, Y, w, d, tint, maxcell, uvs)                      # top (+z)
    if 'n' not in skip: face(Me, mat, tex, (x0, y0, z0), X, Z, w, h, tint, maxcell, uvs)                      # -y
    if 's' not in skip: face(Me, mat, tex, (x1, y1, z0), (-1, 0, 0), Z, w, h, tint, maxcell, uvs)              # +y
    if 'w' not in skip: face(Me, mat, tex, (x0, y1, z0), (0, -1, 0), Z, d, h, tint, maxcell, uvs)              # -x
    if 'e' not in skip: face(Me, mat, tex, (x1, y0, z0), Y, Z, d, h, tint, maxcell, uvs)                      # +x

def prism(Me, cx, cy, z0, z1, r, n, tex, tint=(1, 1, 1, 1), mat=0, r1=None, cap=True):
    """n-sided prism / frustum (r at z0, r1 at z1)"""
    r1 = r if r1 is None else r1
    A = [(cx + r * math.cos(2 * math.pi * i / n + math.pi / n), cy + r * math.sin(2 * math.pi * i / n + math.pi / n)) for i in range(n)]
    B = [(cx + r1 * math.cos(2 * math.pi * i / n + math.pi / n), cy + r1 * math.sin(2 * math.pi * i / n + math.pi / n)) for i in range(n)]
    sw = isinstance(tex, tuple)
    for i in range(n):
        j = (i + 1) % n
        p = [(A[i][0], A[i][1], z0), (A[j][0], A[j][1], z0), (B[j][0], B[j][1], z1), (B[i][0], B[i][1], z1)]
        if sw: uv = [sw_uv(tex[1])] * 4
        else:
            s = math.hypot(A[j][0] - A[i][0], A[j][1] - A[i][1]) / T; t = (z1 - z0) / T
            uv = [tile_uv(tex, min(1, x), min(1, y)) for x, y in ((0, 0), (s, 0), (s, t), (0, t))]
        Me.quad(mat, p, uv, tint)
    if cap:
        for (R, z, up) in ((B, z1, True), (A, z0, False)):
            if (R is B and r1 < 1e-6) or (R is A and r < 1e-6): continue
            pts = [(x, y, z) for x, y in R]
            if not up: pts = pts[::-1]
            c = sw_uv(tex[1]) if sw else tile_uv(tex, 0.5, 0.5)
            for k in range(1, n - 1):
                Me.quad(mat, [pts[0], pts[k], pts[k + 1]], [c] * 3, tint)

def clip_poly_rect(poly, x0, y0, x1, y1):
    def clip(pts, inside, inter):
        out = []
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            ia, ib = inside(a), inside(b)
            if ia and ib: out.append(b)
            elif ia and not ib: out.append(inter(a, b))
            elif not ia and ib: out.append(inter(a, b)); out.append(b)
        return out
    def ix(xv):
        return lambda a, b: (xv, a[1] + (b[1] - a[1]) * (xv - a[0]) / (b[0] - a[0]))
    def iy(yv):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (yv - a[1]) / (b[1] - a[1]), yv)
    p = list(poly)
    for ins, it in ((lambda q: q[0] >= x0, ix(x0)), (lambda q: q[0] <= x1, ix(x1)), (lambda q: q[1] >= y0, iy(y0)), (lambda q: q[1] <= y1, iy(y1))):
        if not p: return []
        p = clip(p, ins, it)
    return p

def fill(Me, mat, tex, poly, zf, up=True, tint=(1, 1, 1, 1), cell=3.0, uvs=1.0):
    """fill a convex polygon (x,y list) with cell-sized pieces at height zf(x,y); up=True faces +z"""
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]; X0, Y0 = min(xs), min(ys)
    nx = int(math.ceil((max(xs) - X0) / cell - 1e-6)); ny = int(math.ceil((max(ys) - Y0) / cell - 1e-6))
    for i in range(nx):
        for j in range(ny):
            cx0, cy0 = X0 + i * cell, Y0 + j * cell
            pc = clip_poly_rect(poly, cx0, cy0, cx0 + cell, cy0 + cell)
            if len(pc) < 3: continue
            # dedupe consecutive
            q = [pc[0]]
            for p in pc[1:]:
                if abs(p[0] - q[-1][0]) > 1e-6 or abs(p[1] - q[-1][1]) > 1e-6: q.append(p)
            if len(q) < 3: continue
            if not up: q = q[::-1]
            ox, oy = (i % 2) * cell / T, (j % 2) * cell / T
            for k in range(1, len(q) - 1):
                tri = [q[0], q[k], q[k + 1]]
                pts = [(p[0], p[1], zf(p[0], p[1])) for p in tri]
                if isinstance(tex, tuple): uv = [sw_uv(tex[1])] * 3
                else: uv = [tile_uv(tex, min(1, ox + (p[0] - cx0) / T * uvs), min(1, oy + (p[1] - cy0) / T * uvs)) for p in tri]
                Me.quad(mat, pts, uv, tint)

def rect_floor(Me, x0, y0, x1, y1, z, tex, tint=(1, 1, 1, 1), cell=3.0, mat=0, uvs=1.0):
    fill(Me, mat, tex, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], lambda x, y: z, True, tint, cell, uvs)

def wall(Me, a, b, z0, ztop, tex, normal_side, tint=(1, 1, 1, 1), cell=3.0, gaps=(), gap_h=0.0, mat=0):
    """vertical panel along (ax,ay)->(bx,by); normal_side=+1 faces left of a->b. ztop: number or f(x,y). gaps: [(s0,s1)] distance ranges along the wall left open below gap_h"""
    L = math.hypot(b[0] - a[0], b[1] - a[1]); dx, dy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    br = set([0.0, L]); k = cell
    while k < L - 1e-6: br.add(k); k += cell
    for g in gaps: br.add(g[0]); br.add(g[1])
    br = sorted(br)
    top = ztop if callable(ztop) else (lambda x, y: ztop)
    for s0, s1 in zip(br[:-1], br[1:]):
        if s1 - s0 < 1e-4: continue
        mid = (s0 + s1) / 2; zb = z0
        for g in gaps:
            if g[0] - 1e-6 <= mid <= g[1] + 1e-6: zb = max(zb, gap_h)
        p0 = (a[0] + dx * s0, a[1] + dy * s0); p1 = (a[0] + dx * s1, a[1] + dy * s1)
        t0, t1 = top(*p0), top(*p1)
        if min(t0, t1) - zb < 0.05: continue
        n = max(1, int(math.ceil((max(t0, t1) - zb) / cell - 1e-6)))
        for r in range(n):
            f0, f1 = r / n, (r + 1) / n
            z00, z01 = zb + (t0 - zb) * f0, zb + (t0 - zb) * f1; z10, z11 = zb + (t1 - zb) * f0, zb + (t1 - zb) * f1
            pts = [(p0[0], p0[1], z00), (p1[0], p1[1], z10), (p1[0], p1[1], z11), (p0[0], p0[1], z01)]
            if normal_side < 0: pts = pts[::-1]
            if isinstance(tex, tuple): uv = [sw_uv(tex[1])] * 4
            else:
                u0 = ((s0 % T) / T); u1 = u0 + (s1 - s0) / T; v0 = ((z00 % T) / T); v1 = v0 + (z01 - z00) / T
                uv = [tile_uv(tex, min(1, u0), min(1, v0)), tile_uv(tex, min(1, u1), min(1, v0)), tile_uv(tex, min(1, u1), min(1, v1)), tile_uv(tex, min(1, u0), min(1, v1))]
                if normal_side < 0: uv = uv[::-1]
            Me.quad(mat, pts, uv, tint)

# ── nav registry ───────────────────────────────────────────────────────────────────
class Nav:
    def __init__(s):
        s.patches = []; s.obs = []; s.seg = []; s.rooms = []
    def rect(s, x0, y0, x1, y1, h): s.patches.append(['r', r2(x0), r2(y0), r2(x1), r2(y1), r2(h)])
    def poly(s, pts, h): s.patches.append(['p', [[r2(x), r2(y)] for x, y in pts], r2(h)])
    def ramp(s, x0, y0, x1, y1, axis, h0, h1): s.patches.append(['s', r2(x0), r2(y0), r2(x1), r2(y1), axis, r2(h0), r2(h1)])
    def block(s, x0, y0, x1, y1, zlo, zhi): s.obs.append([r2(min(x0, x1)), r2(min(y0, y1)), r2(max(x0, x1)), r2(max(y0, y1)), r2(zlo), r2(zhi)])
    def wall(s, ax, ay, bx, by, zlo, zhi): s.seg.append([r2(ax), r2(ay), r2(bx), r2(by), r2(zlo), r2(zhi)])
def r2(v): return round(float(v), 2)

# ── GLB writer ─────────────────────────────────────────────────────────────────────
def write_glb(path, Me, images, ao_cols=None):
    """images: dict name->bytes (webp) for normal, color, orm in that order. Mesh = 3 primitives (atlas PBR, unlit emissive, blended water/glass)."""
    import numpy as np
    bin_ = bytearray(); views = []; acc = []
    def add_view(data, target=None, stride=None):
        while len(bin_) % 4: bin_.append(0)
        v = {'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(data)}
        if target: v['target'] = target
        if stride: v['byteStride'] = stride
        bin_.extend(data); views.append(v); return len(views) - 1
    prims = []
    for m in range(3):
        P = np.array(Me.pos[m], dtype='<f4').reshape(-1, 3)
        if len(P) == 0: continue
        N = np.array(Me.nrm[m], dtype='<f4').reshape(-1, 3); U = np.array(Me.uv[m], dtype='<f4').reshape(-1, 2)
        C = np.array([[int(round(max(0, min(1, c)) * 255)) for c in col] for col in (ao_cols[m] if ao_cols else Me.col[m])], dtype=np.uint8).reshape(-1, 4)
        I = np.array(Me.idx[m], dtype=np.uint32)
        # drop degenerate triangles (the 1-tri quads repeat an index)
        I = I.reshape(-1, 3); keep = (I[:, 0] != I[:, 1]) & (I[:, 1] != I[:, 2]) & (I[:, 0] != I[:, 2]); I = I[keep].ravel()
        # glTF: y-up (x, z, -y)
        P2 = np.stack([P[:, 0], P[:, 2], -P[:, 1]], 1).astype('<f4'); N2 = np.stack([N[:, 0], N[:, 2], -N[:, 1]], 1).astype('<f4')
        it = np.uint16 if len(P) < 65535 else np.uint32
        att = {}
        for nm, arr, typ, ct, norm in (('POSITION', P2, 'VEC3', 5126, False), ('NORMAL', N2, 'VEC3', 5126, False), ('TEXCOORD_0', U, 'VEC2', 5126, False), ('COLOR_0', C, 'VEC4', 5121, True)):
            vi = add_view(arr.tobytes(), 34962)
            a = {'bufferView': vi, 'componentType': ct, 'count': int(len(arr)), 'type': typ}
            if norm: a['normalized'] = True
            if nm == 'POSITION': a['min'] = [float(x) for x in P2.min(0)]; a['max'] = [float(x) for x in P2.max(0)]
            acc.append(a); att[nm] = len(acc) - 1
        vi = add_view(I.astype(it).tobytes(), 34963)
        acc.append({'bufferView': vi, 'componentType': 5123 if it == np.uint16 else 5125, 'count': int(len(I)), 'type': 'SCALAR'})
        prims.append({'attributes': att, 'indices': len(acc) - 1, 'material': m, 'mode': 4})
    imgs = []; tex = []
    for k, (nm, data) in enumerate(images):
        vi = add_view(data); imgs.append({'bufferView': vi, 'mimeType': 'image/webp', 'name': nm})
        tex.append({'extensions': {'EXT_texture_webp': {'source': k}}, 'sampler': 0})
    mats = [
        {'name': 'int_atlas', 'pbrMetallicRoughness': {'baseColorTexture': {'index': 1}, 'metallicRoughnessTexture': {'index': 2}, 'metallicFactor': 1.0, 'roughnessFactor': 1.0}, 'normalTexture': {'index': 0}},
        {'name': 'int_emit', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 1}, 'extensions': {'KHR_materials_unlit': {}}},
        {'name': 'int_water', 'alphaMode': 'BLEND', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 0.05}},
    ]
    j = {'asset': {'version': '2.0', 'generator': 'jots build_interior.py'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
         'nodes': [{'name': 'MansionInterior', 'mesh': 0}], 'meshes': [{'name': 'MansionInterior_mesh', 'primitives': prims}],
         'materials': mats, 'textures': tex, 'images': imgs, 'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
         'accessors': acc, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}],
         'extensionsUsed': ['EXT_texture_webp', 'KHR_materials_unlit'], 'extensionsRequired': ['EXT_texture_webp']}
    js = json.dumps(j, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    while len(bin_) % 4: bin_.append(0)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total)); f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(bin_), 0x004E4942)); f.write(bytes(bin_))
    return total
