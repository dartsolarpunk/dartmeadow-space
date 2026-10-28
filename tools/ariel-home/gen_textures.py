#!/usr/bin/env python3
"""Procedural, tileable PBR sets for Ariel's cliff mansion (numpy + PIL, no downloads).
Writes <name>-{color,nrm,orm}-{2k,1k}.webp into assets/ariel-home/tex.  ORM: R=AO G=roughness B=metal.
usage: gen_textures.py OUTDIR"""
import sys, os, numpy as np
from PIL import Image
out = sys.argv[1] if len(sys.argv) > 1 else 'assets/ariel-home/tex'
os.makedirs(out, exist_ok=True)
N = 2048
rng = np.random.default_rng(1000)

def fnoise(beta=2.0, n=N, sx=1.0, sy=1.0):
    """periodic filtered noise in [0,1]; sx/sy stretch the spectrum (anisotropic grain)"""
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f * sx, f * sy)
    r = np.sqrt(fx * fx + fy * fy); r[0, 0] = 1
    spec = (rng.standard_normal((n, n)) + 1j * rng.standard_normal((n, n))) / r ** (beta / 1.0)
    spec[0, 0] = 0
    a = np.fft.ifft2(spec).real
    a = (a - a.min()) / (a.max() - a.min() + 1e-9)
    return a

def sm(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)

def normal_from_h(h, k=3.0):
    gx = np.roll(h, -1, 1) - np.roll(h, 1, 1)
    gy = np.roll(h, -1, 0) - np.roll(h, 1, 0)
    nx, ny, nz = -gx * k * N / 64, -gy * k * N / 64, np.ones_like(h)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / l, ny / l, nz / l], -1) * 0.5 + 0.5

def save(name, col, h, rough, metal, ao=None):
    if ao is None: ao = np.ones_like(h)
    nrm = normal_from_h(h)
    orm = np.stack([ao, rough, metal], -1)
    for tag, arr in (('color', col), ('nrm', nrm), ('orm', orm)):
        im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
        im.save(f'{out}/{name}-{tag}-2k.webp', quality=82, method=6)
        im.resize((1024, 1024), Image.LANCZOS).save(f'{out}/{name}-{tag}-1k.webp', quality=80, method=6)

yy, xx = np.mgrid[0:N, 0:N] / N

# ── gunmetal / slate standing-seam roof & cladding ──
seam_n = 16                       # seams per 4 m tile -> 0.25 m panels
u = (xx * seam_n) % 1
seam = np.exp(-((u - 0.5) / 0.018) ** 2) + 0.5 * np.exp(-((u - 0.5 + 0.06) / 0.01) ** 2)
streak = fnoise(2.6, sx=0.05, sy=1.0)          # long vertical brushing
fine = fnoise(1.2)
panel = np.floor(xx * seam_n) / seam_n
pv = fnoise(3.5)[(np.floor(xx * seam_n) * 97 % N).astype(int) % N, 5]  # per-panel tint
pt = (np.floor(xx * seam_n) * 0.37 % 1) * 0.08
base = 0.095 + 0.05 * streak + 0.02 * fine + pt * 0.5
col = np.stack([base * 0.93, base * 0.98, base * 1.10], -1)
col *= (1 - 0.55 * seam)[..., None]
h = 0.35 * seam + 0.04 * streak + 0.01 * fine
rough = 0.38 + 0.25 * streak + 0.1 * fine
metal = np.full_like(h, 0.82) - 0.1 * fine
save('slate', col, h, rough, metal, 1 - 0.5 * seam)

# ── board-formed concrete ──
bn = 14                                   # boards per tile
v = (yy * bn) % 1
board_edge = np.exp(-((v - 0.0) / 0.01) ** 2) + np.exp(-((v - 1.0) / 0.01) ** 2)
grain = fnoise(2.2, sx=1.0, sy=0.08)      # horizontal wood-grain imprint
mott = fnoise(2.8)
pores = (fnoise(1.0) > 0.93).astype(float)
bid = np.floor(yy * bn)
btone = ((bid * 0.6180339) % 1) * 0.06
shift = ((bid * 0.2718) % 1) * 0.08
c = 0.34 + 0.18 * mott + 0.05 * grain + btone - 0.12 * pores - 0.05 * board_edge
col = np.stack([c * 0.97, c * 1.0, c * 1.03], -1)
# form-tie holes on a grid
tx = (xx * 4 % 1 - 0.5); ty = ((yy * 7 + 0.5) % 1 - 0.5)
tie = np.exp(-((tx / 0.02) ** 2 + (ty / 0.03) ** 2)); col *= (1 - 0.6 * tie)[..., None]
h = 0.5 * grain + 0.25 * mott - 0.35 * board_edge - 0.3 * pores - 0.4 * tie
save('concrete', col, h, 0.78 + 0.15 * mott - 0.1 * pores, np.zeros_like(h), 1 - 0.4 * pores - 0.5 * tie)

# ── warm wood slat ceiling ──
sn = 24                                    # slats per tile -> 0.17 m
u = (xx * sn) % 1
gap = np.exp(-((u - 0.0) / 0.03) ** 2) + np.exp(-((u - 1.0) / 0.03) ** 2)
sid = np.floor(xx * sn)
g1 = fnoise(2.4, sx=0.04, sy=1.0); g2 = fnoise(1.6, sx=0.1, sy=1.0)
ring = 0.5 + 0.5 * np.sin((g1 * 22 + yy * 0.0) * np.pi)
stone = ((sid * 0.7548) % 1)
wood = 0.55 * g1 + 0.25 * ring + 0.2 * g2
r_ = 0.46 + 0.36 * wood + 0.06 * stone
g_ = 0.24 + 0.2 * wood + 0.03 * stone
b_ = 0.10 + 0.08 * wood
col = np.stack([r_, g_, b_], -1) * (1 - 0.85 * gap)[..., None]
h = 0.2 * ring + 0.25 * g2 - 0.8 * gap
save('wood', col, h, 0.5 + 0.22 * g2, np.zeros_like(h), 1 - 0.8 * gap)

# ── dark layered cliff rock (strata + fracture + lichen hint) ──
macro = fnoise(2.5); mid = fnoise(2.0); fine = fnoise(1.3)
strata = np.sin((yy * 9 + macro * 0.9 + mid * 0.18) * 2 * np.pi)
ridge = 1 - np.abs(2 * fnoise(2.0) - 1)
cr = (ridge ** 6)
c = 0.12 + 0.10 * macro + 0.05 * fine + 0.025 * strata - 0.05 * cr
col = np.stack([c * 1.04, c * 1.0, c * 0.96], -1)
lich = sm(0.62, 0.8, fnoise(2.6)) * sm(0.45, 0.7, fine)
col = col * (1 - lich[..., None]) + lich[..., None] * np.array([0.14, 0.2, 0.1])
h = 0.5 * macro + 0.3 * mid + 0.12 * fine + 0.2 * strata - 0.5 * cr
save('rock', col, h, 0.8 + 0.15 * fine, np.zeros_like(h), 1 - 0.6 * cr)
print('ok', out)
