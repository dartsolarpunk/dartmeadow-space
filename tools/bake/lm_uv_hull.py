# stage 1b: re-chart the Hull/deck group into its own, coarse atlas (big coplanar/adjacent islands, 16+ px padding) and
# append it under the main atlas: composite UV2 = main atlas rows 0..H0-1, hull atlas (HR x HR) at rows H0..H0+HR-1, x 0..HR-1.
# usage: python3 lm_uv_hull.py UVDIR OUTDIR [H0=4096] [HR=2048]   (writes OUTDIR/meta.json + p*.npz; hull npz also get 'uvl' = local hull UV)
import sys, os, json, shutil, numpy as np, xatlas
UV, OUT = sys.argv[1:3]; H0 = int(sys.argv[3]) if len(sys.argv) > 3 else 4096; HR = int(sys.argv[4]) if len(sys.argv) > 4 else 2048
HULL = {'Hull', 'deck'}; W = H0; H = H0 + HR
os.makedirs(OUT, exist_ok=True); m = json.load(open(os.path.join(UV, 'meta.json')))
hp = [p for p in m['prims'] if p['node'] in HULL]
A = xatlas.Atlas(); D = {}
for p in hp:
    d = dict(np.load(os.path.join(UV, p['file']))); D[p['file']] = d
    # weld the xatlas-split vertices back together so adjacent faces can share an island
    key = np.round(d['pos'], 4); u, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
    d['weld'] = inv; d['wpos'] = u.astype(np.float32)
    A.add_mesh(d['wpos'], inv[d['ind'].reshape(-1, 3)].astype(np.uint32))
co = xatlas.ChartOptions(); co.max_iterations = 4; co.normal_deviation_weight = 1.0; co.roundness_weight = 0.0; co.straightness_weight = 0.0
co.normal_seam_weight = 2.0; co.max_cost = 16.0
po = xatlas.PackOptions(); po.resolution = HR; po.padding = 20; po.bilinear = True; po.rotate_charts = True; po.texels_per_unit = 0
A.generate(co, po); print('hull atlas', A.atlas_count, A.width, A.height, 'charts', A.chart_count, flush=True)
assert A.atlas_count == 1
# xatlas UVs are normalised to its own (slightly larger than HR) atlas: 20 px there is >= 16 px at HR
for i, p in enumerate(hp):
    d = D[p['file']]; vm2, ind2, uvl = A[i]
    # vm2 indexes welded verts; map to an original npz vertex for vm/nor (any representative with that position)
    rep = np.zeros(len(d['wpos']), np.int64); rep[d['weld']] = np.arange(len(d['weld']))
    src = rep[vm2]
    d['uvl'] = uvl.astype(np.float32)
    d['uv'] = np.stack([uvl[:, 0] * HR / W, uvl[:, 1] * HR / H], 1).astype(np.float32)
    d['vm'] = d['vm'][src]; d['nor'] = d['nor'][src]; d['pos'] = d['wpos'][vm2]; d['ind'] = ind2.astype(np.uint32)
for p in m['prims']:
    if p['node'] in HULL:
        d = D[p['file']]; np.savez(os.path.join(OUT, p['file']), vm=d['vm'], ind=d['ind'], uv=d['uv'], uvl=d['uvl'], pos=d['pos'], nor=d['nor'])
        p['nv2'] = int(len(d['vm'])); p['hull'] = True
    else:
        d = dict(np.load(os.path.join(UV, p['file']))); uv = d['uv'].copy(); uv[:, 1] = 1 - (1 - uv[:, 1]) * H0 / H; d['uv'] = uv
        np.savez(os.path.join(OUT, p['file']), **d)
m['res'] = [W, H]; m['hull'] = dict(H0=H0, HR=HR); json.dump(m, open(os.path.join(OUT, 'meta.json'), 'w'))
print('OK', W, H, flush=True)
