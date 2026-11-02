#!/usr/bin/env python3
"""Interior PBR atlas for Ariel's mansion: 4x4 tiles (color / tangent normal / ORM), 1K desktop + 512 mobile (webp).
usage: make_interior_atlas.py TEXDIR(with the exterior *-2k.webp bakes) OUTDIR
Tiles are periodic (FFT-filtered noise), so a quad can repeat a tile by geometry; tile 15 is a 4x4 swatch palette."""
import sys, os, numpy as np
from PIL import Image
TEX, OUT = sys.argv[1], sys.argv[2]; os.makedirs(OUT, exist_ok=True)
T = 256; rng = np.random.default_rng(7)
yy, xx = np.mgrid[0:T, 0:T] / T
def pnoise(scale, seed=0):
    """periodic smooth noise in [0,1] (white noise low-passed in Fourier space)"""
    r = np.random.default_rng(seed).standard_normal((T, T)); f = np.fft.fft2(r)
    fy = np.fft.fftfreq(T)[:, None] * T; fx = np.fft.fftfreq(T)[None, :] * T
    g = np.exp(-(fx ** 2 + fy ** 2) / (2 * (T / scale / 2.5) ** 2)); a = np.real(np.fft.ifft2(f * g)); a -= a.min(); return a / a.max()
def ld(n, k):
    im = Image.open(f'{TEX}/{n}-{k}-2k.webp').convert('RGB').resize((T, T), Image.LANCZOS); return np.asarray(im, np.float32) / 255.
def nrm_from_h(h, s):
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * s; gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * s
    n = np.stack([-gx, gy, np.ones_like(h)], -1); n /= np.linalg.norm(n, axis=-1, keepdims=True); return n * .5 + .5
FLAT = np.dstack([np.full((T, T), .5), np.full((T, T), .5), np.ones((T, T))])
def orm(ao, r, m): return np.dstack([np.broadcast_to(ao, (T, T)), np.broadcast_to(r, (T, T)), np.broadcast_to(m, (T, T))])
def col(rgb): return np.dstack([np.full((T, T), c) for c in rgb])
tiles = {}
# 0 oak floor / 10 walnut (existing wood bake, rotated so the planks run along u)
w, wn, wo = ld('wood', 'color'), ld('wood', 'nrm'), ld('wood', 'orm')
rot = lambda a: np.rot90(a)
_o = rot(w); _l = _o.mean(-1, keepdims=True); tiles[0] = (np.clip((_o * .45 + _l * .55) * np.array([1.5, 1.42, 1.3]) + .04, 0, 1), np.stack([wn[..., 1], 1 - wn[..., 0], wn[..., 2]], -1)[::-1].transpose(1, 0, 2)[::-1] if False else rot(wn), rot(wo))
tiles[10] = (np.clip(rot(w) * np.array([.7, .55, .48]) + .03, 0, 1), rot(wn), np.dstack([rot(wo)[..., 0], np.clip(rot(wo)[..., 1] * .8, 0, 1), rot(wo)[..., 2]]))
tiles[1] = (ld('concrete', 'color') * 1.05, ld('concrete', 'nrm'), ld('concrete', 'orm'))
tiles[2] = (ld('slate', 'color'), ld('slate', 'nrm'), ld('slate', 'orm'))
_do = ld('dark', 'orm').copy(); _do[..., 2] *= .3   # no env map in the game: full metal would render near-black
tiles[3] = (np.clip(ld('dark', 'color') * 2.8 + .03, 0, 1), ld('dark', 'nrm'), _do)
# 4 plaster
n1 = pnoise(40, 1); n2 = pnoise(6, 2)
tiles[4] = (np.dstack([.88 + .04 * n2 - .02 * n1] * 3) * np.array([1, .975, .94]), nrm_from_h(n1 * .5 + n2 * .5, 2.0), orm(1, .88, 0))
# 5 / 6 woven fabric
def weave(c0, c1, seed, nthread=64):
    u = (np.floor(xx * nthread) + np.floor(yy * nthread)) % 2
    th = .5 + .5 * np.sin(2 * np.pi * xx * nthread) * (u) + .5 * np.sin(2 * np.pi * yy * nthread) * (1 - u)
    th = th * .5 + .25 * pnoise(100, seed)
    c = np.array(c0)[None, None] * (1 - th[..., None]) + np.array(c1)[None, None] * th[..., None]
    return c, nrm_from_h(th, 1.6), orm(.9, .92, 0)
tiles[5] = weave((.58, .6, .64), (.8, .82, .86), 5)
tiles[6] = weave((.72, .68, .62), (.92, .9, .85), 6)
# 7 white tile 2x2 with grout
def tiles_hm(n, grout=.04):
    fx = (xx * n) % 1; fy = (yy * n) % 1
    d = np.minimum(np.minimum(fx, 1 - fx), np.minimum(fy, 1 - fy)); return np.clip((d - grout * .5) / (grout * .5), 0, 1)
g = tiles_hm(2, .05); v = pnoise(8, 7)
tiles[7] = (np.dstack([(.86 + .05 * v) * g + .45 * (1 - g)] * 3) * np.array([1, 1, .99])[None, None], nrm_from_h(g * .8 + .05 * v, 2.5), orm(g * .2 + .8, .18 + .6 * (1 - g), 0))
# 8 teal mosaic 8x8
g = tiles_hm(8, .12); idx = (np.floor(xx * 8) * 7 + np.floor(yy * 8) * 13) % 5 / 4
base = np.array([.05, .42, .5])[None, None] * (.7 + .5 * idx[..., None]) + np.array([.0, .12, .08])[None, None] * idx[..., None]
tiles[8] = (base * g[..., None] + .35 * (1 - g[..., None]), nrm_from_h(g, 3.0), orm(g * .3 + .7, .12 + .5 * (1 - g), 0))
# 9 marble
nz = pnoise(5, 9); vein = np.abs(np.sin((xx * 3 + yy * 2 + nz * 1.6) * np.pi * 2)); vein = np.clip(1 - vein * 7, 0, 1) ** 2; fine = pnoise(60, 10)
tiles[9] = (np.dstack([.92 - .05 * fine - .5 * vein] * 3) * np.array([1, 1, 1.02]), nrm_from_h(fine * .1, 1.0), orm(1, .12 + .1 * fine, 0))
# 11 leather
cell = pnoise(90, 11) + .5 * pnoise(45, 12); cell = (cell - cell.min()) / np.ptp(cell)
tiles[11] = (np.dstack([.5 + .1 * cell, .3 + .07 * cell, .19 + .05 * cell]), nrm_from_h(cell, 2.2), orm(.6 + .4 * cell, .5 - .15 * cell, 0))
# 12 hazard stripes (workshop floor markings)
st = (((xx + yy) * 8) % 1 < .5).astype(float); tiles[12] = (np.dstack([.9 * st + .04 * (1 - st), .72 * st + .04 * (1 - st), .05 * st + .04 * (1 - st)]), FLAT, orm(1, .55, 0))
# 13 acoustic panel: felt + slot grid
g = tiles_hm(4, .08); fl = pnoise(120, 13)
tiles[13] = (np.dstack([.08 + .05 * fl, .18 + .08 * fl, .22 + .08 * fl]) * (.45 + .55 * g[..., None]), nrm_from_h(g * .5 + fl * .3, 2.0), orm(.4 + .6 * g, .95, 0))
# 14 diamond plate
fx = (xx * 12) % 1; fy = (yy * 12) % 1; a = np.abs(fx - .5) + np.abs(((fy + (np.floor(xx * 12) % 2) * .5) % 1) - .5); hh = np.clip(1 - a * 2.2, 0, 1) ** .6 * .8
tiles[14] = (np.dstack([.52 + .1 * pnoise(30, 14)] * 3) * np.array([1, 1, 1.03]), nrm_from_h(hh, 3.0), orm(.7 + .3 * (1 - hh), .4 + .1 * pnoise(50, 15), .4))
# 15 palette 4x4 swatches
PAL = [((.9, .9, .88), .6, 0), ((.16, .16, .18), .5, 0), ((.75, .1, .08), .5, 0), ((.9, .45, .08), .5, 0),
       ((.95, .8, .1), .5, 0), ((.18, .55, .22), .6, 0), ((.08, .58, .58), .5, 0), ((.12, .28, .8), .5, 0),
       ((.5, .2, .7), .5, 0), ((.9, .3, .55), .55, 0), ((.6, .6, .6), .5, 0), ((.3, .3, .32), .5, 0),
       ((.85, .63, .3), .35, .4), ((.8, .82, .85), .3, .4), ((.015, .03, .07), .08, 0), ((.8, .6, .35), .55, 0)]
pc = np.zeros((T, T, 3)); po = np.zeros((T, T, 3)); s = T // 4
for i, (c, r, m) in enumerate(PAL):
    sl = (slice((i // 4) * s, (i // 4 + 1) * s), slice((i % 4) * s, (i % 4 + 1) * s)); pc[sl] = c; po[sl] = (1, r, m)
tiles[15] = (pc, FLAT, po)
def put(kind, size, fn):
    A = np.zeros((4 * T, 4 * T, 3), np.float32)
    for i, t in tiles.items():
        A[(i // 4) * T:(i // 4 + 1) * T, (i % 4) * T:(i % 4 + 1) * T] = np.clip(t[kind], 0, 1)
    im = Image.fromarray((A * 255 + .5).astype(np.uint8))
    if size != 4 * T: im = im.resize((size, size), Image.LANCZOS)
    im.save(f'{OUT}/{fn}', quality=84 if kind != 1 else 90, method=5)
for kind, nm in ((0, 'color'), (1, 'nrm'), (2, 'orm')):
    put(kind, 1024, f'interior-{nm}-1k.webp'); put(kind, 512, f'interior-{nm}-512.webp')
print('atlas ok', os.listdir(OUT))
