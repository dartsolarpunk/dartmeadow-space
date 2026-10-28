#!/usr/bin/env python3
"""Pack Ucupaint bakes (bake_materials.py raw PNGs) into GLB/desktop texture tiers.
usage: pack_textures.py RAWDIR OUTDIR [SEEDDIR]   -> OUTDIR/<n>-{color,nrm,orm}-{2k,1k}.webp + <n>-height-1k.png
Seamless (offset-blend), displacement->normal bake (+ generated seed normal), AO from height cavity, ORM = R:AO G:rough B:metal."""
import sys, os, numpy as np
from PIL import Image
RAW, OUT = sys.argv[1], sys.argv[2]; SEED = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(OUT, exist_ok=True)
NSTR = dict(slate=2.2, concrete=1.6, rock=3.0, wood=1.2, dark=1.0, leaf=1.4)   # height -> slope gain
def load(n, k, mode16=False):
    im = Image.open(f'{RAW}/{n}-{k}-raw.png')
    a = np.asarray(im, dtype=np.float32) / (65535. if im.mode.startswith('I') or im.mode == 'I;16' else 255.)
    return a
def seamless(a):
    n = a.shape[0]; t = np.abs(np.linspace(-1, 1, n, endpoint=False)); w = 1 - t
    w = (w[:, None] * w[None, :]); w = w ** 0.8
    if a.ndim == 3: w = w[..., None]
    sh = np.roll(np.roll(a, n // 2, 0), n // 2, 1)
    return a * w + sh * (1 - w)
def blur(a, r):
    k = np.zeros(a.shape[:2]); n = a.shape[0]
    f = np.fft.fft2(a); fy = np.fft.fftfreq(n)[:, None]; fx = np.fft.fftfreq(n)[None, :]
    g = np.exp(-(fx ** 2 + fy ** 2) * (2 * np.pi * r) ** 2 / 2)
    return np.real(np.fft.ifft2(f * g))
def tiers(name, arr, kind, res_list):
    for tag, r in res_list:
        im = Image.fromarray((np.clip(arr, 0, 1) * 255 + .5).astype(np.uint8))
        if im.size[0] != r: im = im.resize((r, r), Image.LANCZOS)
        im.save(f'{OUT}/{name}-{kind}-{tag}.webp', quality=82 if kind != 'nrm' else 88, method=5)
for f in sorted(os.listdir(RAW)):
    if not f.endswith('-color-raw.png'): continue
    n = f.split('-')[0]
    col = seamless(load(n, 'color')[..., :3]); rough = seamless(load(n, 'rough')[..., 0]); metal = seamless(load(n, 'metal')[..., 0])
    h = load(n, 'height'); h = h[..., 0] if h.ndim == 3 else h; h = seamless(h)
    N = h.shape[0]
    # displacement -> tangent normal (periodic differences); height in metres-ish: gain per material
    g = NSTR.get(n, 1.5) * N / 512.
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * g; dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * g
    nx, ny, nz = -dx, dy, np.ones_like(dx)      # image row 0 = v=1 (top): +y is up = -row
    ny = -(-dy)  # (rows increase downward: dh/dv = -dy)
    if SEED and os.path.exists(f'{SEED}/{n}-nrm-2k.webp'):
        s = np.asarray(Image.open(f'{SEED}/{n}-nrm-2k.webp').convert('RGB').resize((N, N), Image.LANCZOS), dtype=np.float32) / 255. * 2 - 1
        nx = nx + s[..., 0] / np.maximum(s[..., 2], .2); ny = ny + s[..., 1] / np.maximum(s[..., 2], .2)
    L = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2); nrm = np.stack([nx / L, ny / L, nz / L], -1) * .5 + .5
    cav = np.clip(blur(h, 6 * N / 512.) - h, 0, None); ao = np.clip(1 - cav * 9 * np.clip(NSTR.get(n, 1.5), 1, 3) / 2, 0.25, 1)
    orm = np.stack([ao, rough, metal], -1)
    T = [('2k', 2048), ('1k', 1024)]
    tiers(n, col, 'color', T); tiers(n, nrm, 'nrm', T); tiers(n, orm, 'orm', T)
    Image.fromarray((np.clip(h, 0, 1) * 255 + .5).astype(np.uint8)).resize((1024, 1024)).save(f'{OUT}/{n}-height-1k.png', optimize=True)
    print('packed', n, N)
