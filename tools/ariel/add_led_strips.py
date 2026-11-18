#!/usr/bin/env python3
"""Add the two top-of-glasses LED half-strips to Ariel's character GLB by patching the glTF directly.

  python3 tools/ariel/add_led_strips.py <in.glb> <out.glb>

Why a direct patch and not a Blender re-export: every existing byte of the file (skeleton, skin weights, materials + their
KHR extensions, textures, node names / order, all accessors) stays exactly as it was; the patch only APPENDS 2 meshes, 2
materials, 2 nodes, 12 accessors/bufferViews and splices the 2 nodes into the armature's child list (after 'Mesh.003', so the
last skinned mesh the game sees - CHAR.skinnedMesh - is unchanged).  Re-running on an already patched file is a no-op error.

Geometry: measured from the glasses frame ('Mesh 1', skinned 100 % to Head) the same way ui/dm-flash.js measures it for its
runtime LED casing (front face z, top y at the bridge, width), so the strip sits on the top face of that casing:
  casing top y = frameTop + h  (h = clamp(band/8, 2.2 mm, 4 mm)),  casing z centre = zFront - dep/2 + 0.6 mm,  len = width/3
The strip is two separate boxes (her LEFT = +x half, RIGHT = -x half) a 0.6 mm gap apart, 36 mm overall, 3.4 mm deep, rising
1.2 mm above the casing top; the lower part is buried in the casing (bottom = casing bottom + 0.2 mm) so it is attached whether or not the runtime casing exists.
Each half: own mesh + node + material, skinned 100 % to the 'Head' joint, parent = the armature (like every other glasses part).
"""
import json, struct, sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glbio import read, acc, write

def box_half(x0, x1, y0, y1, z0, z1, nx=3, nz=2):
    """closed box, top face subdivided nx x nz, flat shaded; returns pos, nrm, uv, idx (CCW outward)"""
    P, N, U, I = [], [], [], []
    def quad(a, b, c, d, n, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
        o = len(P); P.extend([a, b, c, d]); N.extend([n] * 4); U.extend(uv); I.extend([o, o + 1, o + 2, o, o + 2, o + 3])
    # top (+y), subdivided
    for i in range(nx):
        for k in range(nz):
            xa, xb = x0 + (x1 - x0) * i / nx, x0 + (x1 - x0) * (i + 1) / nx
            za, zb = z0 + (z1 - z0) * k / nz, z0 + (z1 - z0) * (k + 1) / nz
            quad((xa, y1, zb), (xb, y1, zb), (xb, y1, za), (xa, y1, za), (0, 1, 0),
                 ((i / nx, k / nz), ((i + 1) / nx, k / nz), ((i + 1) / nx, (k + 1) / nz), (i / nx, (k + 1) / nz)))
    quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), (0, -1, 0))                 # bottom
    quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), (0, 0, 1))                  # +z (front)
    quad((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (0, 0, -1))                 # -z
    quad((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (1, 0, 0))                  # +x
    quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0), (-1, 0, 0))                 # -x
    return (np.array(P, np.float32), np.array(N, np.float32), np.array(U, np.float32), np.array(I, np.uint16))

def main(src, dst):
    j, b = read(src)
    if any(n.get('name') == 'LED_Top_Strip_L' for n in j['nodes']):
        sys.exit('already patched')
    nodes = j['nodes']; idx = {n.get('name'): i for i, n in enumerate(nodes)}
    arm = idx['Ariel_Armature']; head = idx['Head']
    joint = j['skins'][0]['joints'].index(head)
    glass = idx['Mesh 1']; assert nodes[glass].get('skin') == 0 and 'translation' not in nodes[glass] and 'matrix' not in nodes[glass]
    gp = acc(j, b, j['meshes'][nodes[glass]['mesh']]['primitives'][0]['attributes']['POSITION'])
    zf = float(gp[:, 2].max()); sel = gp[gp[:, 2] > zf - 0.027]
    width = float(sel[:, 0].max() - sel[:, 0].min()); c = sel[np.abs(sel[:, 0]) < 0.02]
    top, lo = float(c[:, 1].max()), float(c[:, 1].min())
    h = max(0.0022, min(0.004, (top - lo) / 8)); dep = 0.006
    zc = zf - dep / 2 + 0.0006                      # casing z centre (dm-flash F.dimsFrom)
    casing_top = top + h
    L_tot, gap, sd = 0.036, 0.0006, 0.0034
    y0, y1 = top + 0.0002, casing_top + 0.0012
    z0, z1 = zc - sd / 2, zc + sd / 2
    halves = {'L': (gap / 2, L_tot / 2),            # her left = +x (she faces +z, up +y)
              'R': (-L_tot / 2, -gap / 2)}
    info = {'zFront': zf, 'frameTop': top, 'width': width, 'casingTop': casing_top, 'zCentre': zc}
    new_children = []
    for side, (xa, xb) in halves.items():
        P, N, U, I = box_half(xa, xb, y0, y1, z0, z1)
        J = np.zeros((len(P), 4), np.uint8); J[:, 0] = joint
        W = np.zeros((len(P), 4), np.float32); W[:, 0] = 1
        def add(arr, comp, typ, target, mm=False):
            while len(b) % 4: b.append(0)
            data = arr.tobytes(); bv = {'buffer': 0, 'byteLength': len(data), 'byteOffset': len(b), 'target': target}
            b.extend(data); j['bufferViews'].append(bv)
            a = {'bufferView': len(j['bufferViews']) - 1, 'componentType': comp, 'count': int(arr.shape[0]), 'type': typ}
            if mm: a['min'] = [float(v) for v in arr.min(0)]; a['max'] = [float(v) for v in arr.max(0)]
            j['accessors'].append(a); return len(j['accessors']) - 1
        attrs = {'POSITION': add(P, 5126, 'VEC3', 34962, True), 'NORMAL': add(N, 5126, 'VEC3', 34962),
                 'TEXCOORD_0': add(U, 5126, 'VEC2', 34962), 'JOINTS_0': add(J, 5121, 'VEC4', 34962), 'WEIGHTS_0': add(W, 5126, 'VEC4', 34962)}
        ii = add(I, 5123, 'SCALAR', 34963)
        j['materials'].append({'name': 'LED_Top_Mat_' + side, 'doubleSided': False,
                               'pbrMetallicRoughness': {'baseColorFactor': [0.02, 0.02, 0.022, 1], 'metallicFactor': 0.0, 'roughnessFactor': 0.55},
                               'emissiveFactor': [0, 0, 0]})
        j['meshes'].append({'name': 'LED_Top_Strip_' + side, 'primitives': [{'attributes': attrs, 'indices': ii, 'material': len(j['materials']) - 1}]})
        nodes.append({'mesh': len(j['meshes']) - 1, 'name': 'LED_Top_Strip_' + side, 'skin': 0}); new_children.append(len(nodes) - 1)
    ch = nodes[arm]['children']; at = ch.index(idx['Mesh.003']) + 1
    ch[at:at] = new_children
    j['buffers'][0]['byteLength'] = len(b)
    write(dst, j, b); print(json.dumps(info))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
