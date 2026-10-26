# stage 3: baked EXR (as .npy) + xatlas UV2 -> web assets: bt-lm.json, bt-lm.bin, bt-irr.webp, bt-ao.webp (+ half-res copies)
import sys, json, os, numpy as np
from PIL import Image
UV, BK, OUT = sys.argv[1:4]; os.makedirs(OUT, exist_ok=True)
m = json.load(open(os.path.join(UV, 'meta.json')))
irr = np.load(os.path.join(BK, 'irr.npy'))[..., :3]; ao = np.load(os.path.join(BK, 'ao.npy'))[..., 0]
H, W = ao.shape
# irradiance -> 8-bit sRGB with a scale (decoded by the sRGB texture, multiplied back by lightMapIntensity at runtime)
lum = irr.max(-1); cov = lum > 0
MAX = float(np.percentile(lum[cov], 99.5)) if cov.any() else 1.0
enc = np.clip(irr / MAX, 0, 1) ** (1 / 2.2)
def save(arr, name, q):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8))
    im.save(os.path.join(OUT, name + '.webp'), 'WEBP', quality=q, method=6)
    im.resize((W // 2, H // 2), Image.LANCZOS).save(os.path.join(OUT, name + '-half.webp'), 'WEBP', quality=q, method=6)
ao = np.where(ao <= 1e-4, 1.0, ao)   # texels the bake never reached: no occlusion rather than black
save(enc, 'bt-irr', 72); save(ao, 'bt-ao', 45)   # AO: single channel (L), lower quality - it is smooth after lm_filter
# geometry remap: per primitive vm (orig vertex index), indices, uv2 (uint16 unorm)
buf = bytearray(); prims = []
def put(a):
    global buf
    while len(buf) % 4: buf += b'\0'
    off = len(buf); buf += a.tobytes(); return off
# irradiance volume: splat each baked vertex's irradiance (sampled at its uv2) into a coarse grid over the temple (glTF space)
allp = []; alli = []
for p in m['prims']:
    d = np.load(os.path.join(UV, p['file'])); vm = d['vm']; ind = d['ind'].ravel(); uv = d['uv']
    big = int(vm.max()) > 65535 or len(vm) > 65535
    e = dict(node=p['node'], mesh=p['mesh'], prim=p['prim'], nv=p['nv'], n2=int(len(vm)), ni=int(len(ind)), big=big, mat=p['mat'])
    e['vm'] = put(vm.astype(np.uint32 if int(vm.max()) > 65535 else np.uint16)); e['vm32'] = int(vm.max()) > 65535
    e['ind'] = put(ind.astype(np.uint32 if len(vm) > 65535 else np.uint16)); e['ind32'] = len(vm) > 65535
    e['uv'] = put((np.clip(uv, 0, 1) * 65535 + 0.5).astype(np.uint16))
    prims.append(e)
    px = np.clip((uv[:, 0] * (W - 1)).astype(int), 0, W - 1); py = np.clip(((1 - uv[:, 1]) * (H - 1)).astype(int), 0, H - 1)
    allp.append(d['pos']); alli.append(irr[py, px])
P = np.concatenate(allp); I = np.concatenate(alli)
mn, mx = P.min(0), P.max(0); G = np.array([12, 8, 24])
cell = (mx - mn) / G
acc = np.zeros(tuple(G) + (3,)); wsum = np.zeros(tuple(G))
ci = np.clip(((P - mn) / cell).astype(int), 0, G - 1)
np.add.at(acc, (ci[:, 0], ci[:, 1], ci[:, 2]), I); np.add.at(wsum, (ci[:, 0], ci[:, 1], ci[:, 2]), 1)
vol = np.where(wsum[..., None] > 0, acc / np.maximum(wsum[..., None], 1), np.nan)
# fill empty cells from neighbours (a few dilation passes), then the global mean
for _ in range(6):
    nanm = np.isnan(vol[..., 0])
    if not nanm.any(): break
    pad = np.pad(vol, ((1, 1), (1, 1), (1, 1), (0, 0)), constant_values=np.nan); s = np.zeros_like(vol); c = np.zeros(vol.shape[:3])
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                sl = pad[1 + dx:1 + dx + G[0], 1 + dy:1 + dy + G[1], 1 + dz:1 + dz + G[2]]; ok = ~np.isnan(sl[..., 0]); s[ok] += sl[ok]; c[ok] += 1
    fill = nanm & (c > 0); vol[fill] = s[fill] / c[fill][:, None]
nm = np.isnan(vol[..., 0]); vol[nm] = I.mean(0)
open(os.path.join(OUT, 'bt-lm.bin'), 'wb').write(bytes(buf))
json.dump(dict(v=1, src=m['src'], res=[W, H], scale=MAX, aoRes=[W, H], prims=prims,
               vol=dict(min=mn.tolist(), max=mx.tolist(), n=G.tolist(), rgb=np.round(vol.reshape(-1, 3), 4).ravel().tolist())),
          open(os.path.join(OUT, 'bt-lm.json'), 'w'), separators=(',', ':'))
print('prims', len(prims), 'bin', len(buf), 'scale', MAX, 'files', {f: os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)})
