#!/usr/bin/env python3
"""uc_package.py BUILD_DIR REPO  - t1583u P2 packaging (byte level, after p2_build.py):
  1. assets/ariel-home/ariel-home-undercliff.glb (+ -512.glb for phones/iOS): the three baked zone meshes + the DM-7 Meadowlark (desktop 2K / iOS 1K GLB,
     merged byte-exact: its LODs, material, textures and RampOpen clip untouched), parked on its spot.
  2. assets/ariel-home/ariel-home.glb + ariel-home-512.glb: the bay opening and the hatch hole cut out of Mansion_LOD0 / LOD1 (rock triangles whose centroid is
     inside the bay prism / the shaft footprint), then the bay hall (ah_concrete, under both LODs), the hatch frame + grating, uc_hatch_lid and the portal cards
     (scene root, so the shell collider does not see them) appended with their materials re-bound to the mansion's own by name. Existing primitives, textures,
     the balcony LEDs and every other node are untouched. Idempotent: always starts from the pristine copies in BUILD_DIR/orig/ (made on first run from REPO).
Prints a JSON report."""
import sys, os, json, math, shutil
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_tool import Glb
B, R = sys.argv[1], sys.argv[2]; A = os.path.join(R, 'assets/ariel-home')
P2 = json.load(open(os.path.join(B, 'p2-build.json'))); C = P2['consts']; Ly = P2['layout']; U, Y0U, FU = C['U'], C['Y0U'], C['FU']
VT = '/workspace/jots-t1516/vtol'
rep = {}
def mu(X, D, H): return (X * U, Y0U - D * U, FU + H * U)
# ---------- 1. undercliff GLB ----------
def interior(vtol_glb, out):
    g = Glb(); g.J = {'asset': {'version': '2.0', 'generator': 'JOTS Cliffs uc_package.py (t1583u P2)'}, 'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': []}
    root = g.add_node({'name': 'uc_undercliff', 'extras': {'dm_undercliff': 1, 'frame': 'mansion GLB frame (u): child of the mansion root'}})
    zn = {}
    for z in ('lower', 'stair', 'hangar'):
        o = Glb(os.path.join(B, 'uc-zone-%s.glb' % z)); r = g.append(o, mat_by_name=True)
        zi = g.add_node({'name': 'uc_zone_' + z, 'children': r, 'extras': {'dm_uc_zone': z}}, parent=root); zn[z] = zi
    v = Glb(vtol_glb); r = v_roots = g.append(v)
    vx, vy, vz = mu(P2['vtol']['x'], -P2['vtol']['y'], P2['vtol']['z'])     # m-frame y = -D
    # Blender u (x, y, z) -> glTF (x, z, -y); nose: GLB +Z -> mansion +y (seaward) = glTF -Z: rotate pi about Y
    vi = g.add_node({'name': 'uc_vtol', 'translation': [vx, vz, -vy], 'rotation': [0, 1, 0, 0], 'scale': [U, U, U], 'children': r, 'extras': {'dm_vtol_spot': 1, 'world_note': 'Solenne x -16.58 z -1223.87 y 28.75, rotation.y -pi/2 (nose to the sea)'}}, parent=zn['hangar'])
    for i, nd in enumerate(g.J['nodes']):
        if nd.get('name') in ('Meadowlark_LOD1', 'Meadowlark_LOD2'): nd.setdefault('extras', {})['dm_lod_hidden_default'] = 1
    n = g.save(out)
    return dict(bytes=n, tris_total=g.tris(), vtol_gltf=[vx, vz, -vy], materials=[m.get('name') for m in g.J['materials']], images=len(g.J.get('images', [])))
rep['undercliff'] = interior(os.path.join(VT, 'meadowlark.glb'), os.path.join(A, 'ariel-home-undercliff.glb'))
rep['undercliff_512'] = interior(os.path.join(VT, 'meadowlark-1k.glb'), os.path.join(A, 'ariel-home-undercliff-512.glb'))
# ---------- 2. mansion GLB edits ----------
os.makedirs(os.path.join(B, 'orig'), exist_ok=True)
L = Ly['L']; bay = L['bay']; SH = Ly['SHAFT']
BAYP = dict(x0=bay['X'][0] * U, x1=bay['X'][1] * U, y0=Y0U - bay['D'][1] * U - 0.5, y1=0.5, z0=FU + 0.02, z1=FU + bay['H'][1] * U)
sx0, sx1 = sorted((SH['X'][0] * U, SH['X'][1] * U)); sy0, sy1 = sorted((Y0U - SH['D'][1] * U, Y0U - SH['D'][0] * U))
HATP = dict(x0=sx0, x1=sx1, y0=sy0, y1=sy1, z0=-9.0, z1=3.0)
def inside(c, P): return (c[:, 0] > P['x0']) & (c[:, 0] < P['x1']) & (c[:, 1] > P['y0']) & (c[:, 1] < P['y1']) & (c[:, 2] > P['z0']) & (c[:, 2] < P['z1'])
def mansion(name):
    src = os.path.join(B, 'orig', name)
    if not os.path.exists(src): shutil.copy(os.path.join(A, name), src)
    g = Glb(src); J = g.J; mats = [m['name'] for m in J['materials']]; r = {'cut': {}, 'deck_vc': None}
    # deck COLOR_0 next to the back wall (the bay floor's baked level is matched to it)
    vals = []
    for p in J['meshes'][0]['primitives']:
        c, I = g.tri_centroids_u(p); sel = (np.abs(c[:, 2] - FU) < 0.15) & (c[:, 1] > Y0U + 0.3) & (c[:, 1] < Y0U + 6) & (np.abs(c[:, 0]) < 55)
        if sel.any() and 'COLOR_0' in p['attributes']:
            col = g.acc[p['attributes']['COLOR_0']].astype(np.float64); a = J['accessors'][p['attributes']['COLOR_0']]
            if a['componentType'] != 5126: col = col / (255.0 if a['componentType'] == 5121 else 65535.0)
            vals.append(col[I[sel]].reshape(-1, col.shape[1])[:, :3].mean(axis=1))
    deck = float(np.median(np.concatenate(vals))) if vals else 1.0; r['deck_vc'] = round(deck, 4)
    for mi in (0, 1):
        for p in J['meshes'][mi]['primitives']:
            c, I = g.tri_centroids_u(p); kill = inside(c, BAYP) | inside(c, HATP); m = mats[p['material']]
            if not kill.any(): continue
            if not m.startswith('ah_rock'):     # only the GLB's rock / plateau surfaces are opened; report anything else instead of cutting it
                r.setdefault('kept_non_rock', {})[m] = int(kill.sum()); kill[:] = False; continue
            r['cut'].setdefault('LOD%d' % mi, {})[m] = int(kill.sum()); g.cut(p, ~kill)
    t_before = sum(g.tris(i) for i in (0, 1))
    lod0, lod1 = g.node_index('Mansion_LOD0'), g.node_index('Mansion_LOD1')
    def add(fn, mat, parents, scale_vc=None):
        o = Glb(os.path.join(B, fn))
        import re
        for nd in o.J['nodes']:   # Blender export of the duplicate carries '.001'; the runtime binds by the plain names
            if 'name' in nd: nd['name'] = re.sub(r'\.\d{3}$', '', nd['name'])
        if scale_vc:
            for me in o.J['meshes']:
                for p in me['primitives']:
                    k = p['attributes'].get('COLOR_0')
                    if k is not None: a = o.acc[k].astype(np.float32); a[:, :3] *= scale_vc; o.acc[k] = a
        roots = g.append(o, mat_by_name=True)
        for nd in roots:
            n0 = g.J['nodes'][nd]
            if parents == 'root': g.J['scenes'][0]['nodes'].append(nd)
            else:
                g.J['nodes'][parents[0]].setdefault('children', []).append(nd)
                for extra in parents[1:]:
                    cp = dict(n0); cp['name'] = n0['name'] + '_lod1'; cp.pop('children', None); g.add_node(cp, parent=extra)
        return roots
    add('uc-add-bay.glb', 'ah_concrete', [lod0, lod1], scale_vc=deck)
    for fn in ('uc-add-frame.glb', 'uc-add-lid.glb', 'uc-add-portal.glb'): add(fn, 'ah_dark', 'root')
    for nm in ('uc_bay_hall', 'uc_hatch_frame', 'uc_hatch_lid', 'uc_hatch_leaf_w', 'uc_hatch_leaf_e', 'uc_portal_cards'):
        assert g.node_index(nm) is not None, nm
    newm = [m.get('name') for m in g.J['materials']]; assert newm[:len(mats)] == mats and len(newm) == len(mats), ('materials changed', newm)
    r['bytes'] = g.save(os.path.join(A, name)); r['tris_lod0'] = g.tris(0); r['tris_lod1'] = g.tris(1); r['tris_lod01_after_cut'] = t_before
    return r
for nm in ('ariel-home.glb', 'ariel-home-512.glb'): rep[nm] = mansion(nm)
rep['bay_prism_u'] = BAYP; rep['hatch_prism_u'] = HATP
print(json.dumps(rep, indent=1))
json.dump(rep, open(os.path.join(B, 'package.json'), 'w'), indent=1)
