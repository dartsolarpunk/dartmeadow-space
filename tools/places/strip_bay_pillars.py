#!/usr/bin/env python3
"""(v380) Remove the structural pillars that stood inside the cargo-bay door opening
from an already-built menu_cargobay.glb (no Blender needed), in place.

The builder (build_menu_cargobay.py) joins every static box per material, so the
pillar boxes (Pillar / PillarCap / PillarBase / PillarLed / PillarMark at
x = +-2.15, +-5.4, z = OPEN_Z + 0.55) live inside the Bay_* meshes.  A triangle
is dropped when all three of its world-space vertices lie inside one pillar's
footprint box; the index accessor is compacted in place (vertex data untouched).
No Collide_* body ever covered the pillars, so collision is unchanged.

  python3 tools/places/strip_bay_pillars.py assets/places/menu_cargobay.glb
"""
import json, struct, sys
import numpy as np

OPEN_Z, H = -8.0, 10.0
PX = (-5.4, -2.15, 2.15, 5.4)
HALF = 0.31 + 0.02           # widest pillar part (cap / base 0.62) + eps
Z0, Z1 = OPEN_Z + 0.55 - HALF, OPEN_Z + 0.55 + HALF   # col / cap / base
ZL0 = OPEN_Z + 0.28 - 0.06                            # LED (z 0.30) / marker (z 0.28) on the inner face


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def local(n):
    M = np.eye(4)
    S = np.diag(n.get('scale', [1, 1, 1]))
    M[:3, :3] = qmat(n.get('rotation', [0, 0, 0, 1])) @ S
    M[:3, 3] = n.get('translation', [0, 0, 0])
    return M


def main(path):
    b = bytearray(open(path, 'rb').read())
    jl = struct.unpack_from('<I', b, 12)[0]
    J = json.loads(bytes(b[20:20 + jl]))
    bin_off = 20 + jl + 8
    parent = {}
    for i, n in enumerate(J['nodes']):
        for c in n.get('children', []):
            parent[c] = i

    def world(i):
        M = local(J['nodes'][i])
        while i in parent:
            i = parent[i]
            M = local(J['nodes'][i]) @ M
        return M

    def view(acc_i, dtype, ncomp):
        a = J['accessors'][acc_i]
        bv = J['bufferViews'][a['bufferView']]
        off = bin_off + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        return off, np.frombuffer(bytes(b[off:off + a['count'] * ncomp * np.dtype(dtype).itemsize]), dtype).reshape(-1, ncomp) if ncomp > 1 else None

    total = 0
    for i, n in enumerate(J['nodes']):
        nm = n.get('name') or ''
        if n.get('mesh') is None or not nm.startswith('Bay_'):
            continue
        M = world(i)
        for p in J['meshes'][n['mesh']]['primitives']:
            _, P = view(p['attributes']['POSITION'], '<f4', 3)
            Wp = (M[:3, :3] @ P.T).T + M[:3, 3]
            ia = J['accessors'][p['indices']]
            dt = {5123: '<u2', 5125: '<u4'}[ia['componentType']]
            bv = J['bufferViews'][ia['bufferView']]
            ioff = bin_off + bv.get('byteOffset', 0) + ia.get('byteOffset', 0)
            I = np.frombuffer(bytes(b[ioff:ioff + ia['count'] * np.dtype(dt).itemsize]), dt).reshape(-1, 3)
            T = Wp[I]                                         # (tris, 3, 3)
            x, y, z = T[..., 0], T[..., 1], T[..., 2]
            inside = np.zeros(len(I), bool)
            for px in PX:
                inx = (np.abs(x - px) <= HALF).all(1)
                iny = ((y >= -0.02) & (y <= H + 0.02)).all(1)
                inz = ((z >= ZL0) & (z <= Z1)).all(1)
                # the sill's lip LEDs (LipLed_*: y 0.10-0.14, z OPEN_Z + 0.19..0.25) share the pillars' footprint at deck level: kept
                lip = ((y >= 0.09) & (y <= 0.15)).all(1) & (z <= OPEN_Z + 0.26).all(1)
                inside |= inx & iny & inz & ~lip
            k = int(inside.sum())
            if not k:
                continue
            keep = I[~inside].astype(dt)
            raw = keep.tobytes()
            b[ioff:ioff + len(raw)] = raw
            b[ioff + len(raw):ioff + ia['count'] * np.dtype(dt).itemsize] = bytes(ia['count'] * np.dtype(dt).itemsize - len(raw))
            ia['count'] = int(keep.size)
            total += k
            print(f'{nm}: removed {k} triangles')
    js = json.dumps(J, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    out = bytearray(b[:12]) + struct.pack('<I', len(js)) + b'JSON' + js + b[20 + jl:]
    struct.pack_into('<I', out, 8, len(out))
    open(path, 'wb').write(out)
    print('removed', total, 'triangles ->', path)
    return total


if __name__ == '__main__':
    sys.exit(0 if main(sys.argv[1]) > 0 else 1)
