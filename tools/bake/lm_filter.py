# stage 2b: edge-aware cleanup of a low-spp bake (removes 16-spp/OIDN blotches without a long rebake).
# Smoothing happens in 3D, not UV: every lightmap texel gets its interpolated glTF position + face normal; values are
# splatted into a voxel grid per normal direction (6 bins, so floors never mix with walls/ceilings), gaussian-blurred,
# and read back trilinearly. Works across UV chart seams (xatlas makes ~26k small charts), never across facing.
# Then texels outside charts are dilated 8 px (padding) so bilinear/mips never pull in black.
# usage: python3 lm_filter.py UVDIR BKDIR [cell_m=0.3] [sigma_cells=1.2]   (keeps BK/*_raw.npy, rewrites irr.npy/ao.npy)
import sys, os, json, numpy as np, cv2
from scipy.ndimage import gaussian_filter, map_coordinates
UV, BK = sys.argv[1:3]; CELL = float(sys.argv[3]) if len(sys.argv) > 3 else 0.3; SIG = float(sys.argv[4]) if len(sys.argv) > 4 else 1.2
m = json.load(open(os.path.join(UV, 'meta.json')))
rp = lambda n: os.path.join(BK, n)
if not os.path.exists(rp('irr_raw.npy')):
    np.save(rp('irr_raw.npy'), np.load(rp('irr.npy'))[..., :3]); np.save(rp('ao_raw.npy'), np.load(rp('ao.npy'))[..., 0])
irr = np.load(rp('irr_raw.npy')).astype(np.float32); ao = np.load(rp('ao_raw.npy')).astype(np.float32)
H, W = ao.shape
tid = np.full((H, W), -1, np.int32); TP = []; TU = []; TN = []; TH = []; base = 0
HULL = {'Hull', 'deck'}; HSIG = float(os.environ.get('HULL_SIGMA_M', '0.9')) / CELL   # hull plating: wider blur (tiny charts)
for p in m['prims']:
    d = np.load(os.path.join(UV, p['file'])); ind = d['ind'].reshape(-1, 3); uv = d['uv']; pos = d['pos']
    px = np.stack([uv[:, 0] * W, (1 - uv[:, 1]) * H], -1)
    fn = np.cross(pos[ind[:, 1]] - pos[ind[:, 0]], pos[ind[:, 2]] - pos[ind[:, 0]]); fn /= (np.linalg.norm(fn, axis=1, keepdims=True) + 1e-12)
    for k, t in enumerate(ind):
        cv2.fillConvexPoly(tid, np.round(px[t] * 16 - 8).astype(np.int32), int(base + k), lineType=cv2.LINE_8, shift=4)
    TH.append(np.full(len(ind), p['node'] in HULL)); TP.append(pos[ind]); TU.append(px[ind]); TN.append(fn); base += len(ind)
TP = np.concatenate(TP).astype(np.float64); TU = np.concatenate(TU); TN = np.concatenate(TN); TH = np.concatenate(TH)
cov = tid >= 0; yy, xx = np.nonzero(cov); t = tid[yy, xx]
q = np.stack([xx + 0.5, yy + 0.5], -1); a, b, c = TU[t, 0], TU[t, 1], TU[t, 2]
v0, v1, v2 = b - a, c - a, q - a
d00 = (v0 * v0).sum(1); d01 = (v0 * v1).sum(1); d11 = (v1 * v1).sum(1); d20 = (v2 * v0).sum(1); d21 = (v2 * v1).sum(1)
den = d00 * d11 - d01 * d01; den[np.abs(den) < 1e-12] = 1e-12
w1 = (d11 * d20 - d01 * d21) / den; w2 = (d00 * d21 - d01 * d20) / den; w0 = 1 - w1 - w2
# conservative raster puts edge texels slightly outside their triangle: clamp to >=0 and renormalise (clipping each
# weight independently let w0+w1+w2 reach 2-3, throwing those texels far from the mesh -> blocky hull)
W3 = np.clip(np.stack([w0, w1, w2], 1), 0, None); W3 /= np.maximum(W3.sum(1, keepdims=True), 1e-9); w0, w1, w2 = W3.T
P = TP[t, 0] * w0[:, None] + TP[t, 1] * w1[:, None] + TP[t, 2] * w2[:, None]; N = TN[t]
valid = ao[yy, xx] > 1e-4
mn = P.min(0) - 2 * CELL; G = np.ceil((P.max(0) + 2 * CELL - mn) / CELL).astype(int) + 1
g = (P - mn) / CELL; gi = np.round(g).astype(int)
nb = np.argmax(np.concatenate([N, -N], 1), 1)   # 6 facing bins
val = np.concatenate([irr[yy, xx], ao[yy, xx, None]], 1)
out = val.copy()
print('texels', len(t), 'grid', G.tolist(), flush=True)
hull = TH[t]
for bin_, grp, sg in [(b_, g_, sg_) for g_, sg_ in ((False, SIG), (True, HSIG)) for b_ in range(6)]:
    s = (nb == bin_) & (hull == grp); sv = s & valid
    if not sv.any(): continue
    acc = np.zeros(tuple(G) + (4,), np.float32); wt = np.zeros(tuple(G), np.float32)
    ii = gi[sv]; np.add.at(acc, (ii[:, 0], ii[:, 1], ii[:, 2]), val[sv]); np.add.at(wt, (ii[:, 0], ii[:, 1], ii[:, 2]), 1)
    wt = gaussian_filter(wt, sg); co = g[s].T
    ws = map_coordinates(wt, co, order=1)
    for ch in range(4):
        out[s, ch] = np.where(ws > 1e-4, map_coordinates(gaussian_filter(acc[..., ch], sg), co, order=1) / np.maximum(ws, 1e-4), val[s, ch])
    print('bin', bin_, 'hull' if grp else 'int', int(s.sum()), flush=True)
img = np.zeros((H, W, 4), np.float32); img[yy, xx] = out
filled = cov.copy(); K = np.ones((3, 3), np.uint8)
for _ in range(8):   # padding: average of already-filled neighbours
    sm = cv2.blur(img * filled[..., None], (3, 3)); cn = cv2.blur(filled.astype(np.float32), (3, 3))
    f2 = cv2.dilate(filled.astype(np.uint8), K).astype(bool); new = f2 & ~filled
    img[new] = sm[new] / np.maximum(cn[new], 1e-6)[:, None]; filled = f2
img[..., 3] = np.where(filled, img[..., 3], 0)
np.save(rp('irr.npy'), img[..., :3]); np.save(rp('ao.npy'), img[..., 3:4].repeat(4, -1))
print('FILTERED', flush=True)
