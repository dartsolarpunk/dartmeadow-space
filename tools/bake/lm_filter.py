# stage 2b: edge-aware cleanup of a low-spp bake (removes denoiser blotches without a long rebake).
# Joint-bilateral in UV space: weights = spatial gaussian x same UV chart (islands never bleed) x normal similarity.
# Texels outside charts are then dilated (padding) so mip/bilinear never samples black.
# usage: python3 lm_filter.py UVDIR BKDIR [radius=12]  (reads/writes BK/irr.npy, BK/ao.npy; keeps *_raw.npy)
import sys, os, json, numpy as np, cv2
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
UV, BK = sys.argv[1:3]; R = int(sys.argv[3]) if len(sys.argv) > 3 else 12
m = json.load(open(os.path.join(UV, 'meta.json')))
irr = np.load(os.path.join(BK, 'irr.npy'))[..., :3].astype(np.float32); ao = np.load(os.path.join(BK, 'ao.npy'))[..., 0].astype(np.float32)
H, W = ao.shape
chart = np.zeros((H, W), np.int32); nrm = np.zeros((H, W, 3), np.float32); cid = 1
for p in m['prims']:
    d = np.load(os.path.join(UV, p['file'])); ind = d['ind'].reshape(-1, 3); uv = d['uv']; nor = d['nor']
    n = len(uv); e = np.concatenate([ind[:, [0, 1]], ind[:, [1, 2]]])
    _, lab = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)), directed=False)
    px = np.stack([uv[:, 0] * W, (1 - uv[:, 1]) * H], -1)
    for t in ind:
        q = np.round(px[t] * 16).astype(np.int32); fn = nor[t].mean(0); fn /= (np.linalg.norm(fn) + 1e-9)
        cv2.fillConvexPoly(chart, q, int(cid + lab[t[0]]), lineType=cv2.LINE_8, shift=4)
        cv2.fillConvexPoly(nrm, q, tuple(float(x) for x in fn), lineType=cv2.LINE_8, shift=4)
    cid += lab.max() + 1
cov = chart > 0
print('charts', cid, 'coverage', cov.mean(), 'baked-in-cov', (ao[cov] > 1e-4).mean(), flush=True)
np.save(os.path.join(BK, 'irr_raw.npy'), irr); np.save(os.path.join(BK, 'ao_raw.npy'), ao)
sig_s = R / 2.0; acc = np.zeros((H, W, 4), np.float32); wsum = np.zeros((H, W), np.float32)
src = np.concatenate([irr, ao[..., None]], -1); valid = cov & (ao > 1e-4)
step = 2
for dy in range(-R, R + 1, step):
    for dx in range(-R, R + 1, step):
        ws = np.exp(-(dx * dx + dy * dy) / (2 * sig_s ** 2))
        sh = lambda a: np.roll(a, (dy, dx), (0, 1))
        w = ws * (sh(chart) == chart) * sh(valid) * np.clip((sh(nrm) * nrm).sum(-1), 0, 1) ** 8
        acc += sh(src) * w[..., None]; wsum += w
    print('row', dy, flush=True)
out = np.where(wsum[..., None] > 1e-6, acc / np.maximum(wsum, 1e-6)[..., None], src)
out[~cov] = 0
# padding: dilate chart texels outward 8 px
filled = cov.copy()
for _ in range(8):
    k = cv2.dilate(out, np.ones((3, 3), np.uint8)); f2 = cv2.dilate(filled.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    new = f2 & ~filled; out[new] = k[new]; filled = f2
np.save(os.path.join(BK, 'irr.npy'), out[..., :3]); np.save(os.path.join(BK, 'ao.npy'), np.where(filled, out[..., 3], 0)[..., None].repeat(4, -1))
print('FILTERED', flush=True)
