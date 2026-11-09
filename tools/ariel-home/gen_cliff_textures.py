#!/usr/bin/env python3
"""Cliff rock PBR sets for Ariel's mansion cliff (Solenne).  numpy + scipy + PIL only, fully procedural, no downloads.

Four tileable 3 m x 3 m rock sets, each with diffuse/albedo, tangent normal (OpenGL, +Y up the cliff), ORM (R=AO G=roughness B=metal)
and a height map (white = proud, black = deep) for the parallax-occlusion shader (ui/dm-parallax.js reads cliff-materials.json):

  (shard pass; set names kept so the runtime / GLB material slots are unchanged)
  strata    cleaved shard-rock slab faces (main wall): straight vertical slabs at offset depths, planar tilted facets, sloped cleavage cuts with chamfers,
            tight straight vertical grooves, chipped pale proud edges   (ref: cleaved slate / greywacke joint faces; geode / cave shard habit read as rock)
  columnar  angular prism shards: narrow prisms, two planar facets on a ridge, deep V seams, straight sloped cross-joints
            (ref: columnar basalt - Giant's Causeway, Devils Tower; dogtooth spar habit, as dull basalt-grey stone)
  sheet     joint-face rock pavement (plateau / benches): tight planar plates on straight joints, two long straight joint sets
  talus     talus / scree apron: angular blocks over gravel infill, dust fill   (ref: Zion canyon base aprons, Dolomites scree)

Texel density (tile = 3 m): 2K = 683 px/m, 1K = 341 px/m, 512 = 171 px/m.
usage: gen_cliff_textures.py OUTDIR [--sets strata,columnar,...] [--preview PREVDIR]"""
import sys, os, json, numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree

N = 2048
TILE_M = 3.0
args = sys.argv[1:]
OUT = args[0] if args else 'assets/ariel-home/cliff'
SETS = args[args.index('--sets') + 1].split(',') if '--sets' in args else ['strata', 'columnar', 'sheet', 'talus']
PREV = args[args.index('--preview') + 1] if '--preview' in args else None
os.makedirs(OUT, exist_ok=True)
if PREV: os.makedirs(PREV, exist_ok=True)
F32 = np.float32
FLAT = 0.85

# ───────────────────────── helpers ─────────────────────────
def fnoise(rng, beta=2.0, sx=1.0, sy=1.0, n=N):
    """periodic 1/f^beta noise normalised to [0,1]. sx/sy scale the spectrum: small sy => features stretched along x (horizontal bands), small sx => stretched along y (vertical streaks)"""
    f = np.fft.fftfreq(n).astype(F32)
    fx, fy = np.meshgrid(f * sx, f * sy)
    r = np.sqrt(fx * fx + fy * fy); r[0, 0] = 1
    spec = (rng.standard_normal((n, n)) + 1j * rng.standard_normal((n, n))) / r ** beta
    spec[0, 0] = 0
    a = np.fft.ifft2(spec).real.astype(F32)
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.5)
    return np.clip((a - lo) / (hi - lo + 1e-9), 0, 1)

def noise1d(rng, n=N, beta=1.6, k0=1):
    f = np.fft.rfftfreq(n) * n; f[0] = 1
    spec = (rng.standard_normal(len(f)) + 1j * rng.standard_normal(len(f))) / f ** beta
    spec[0] = 0; spec[:k0] = 0
    a = np.fft.irfft(spec, n)
    return ((a - a.min()) / (a.max() - a.min() + 1e-9)).astype(F32)

def sm(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)

def blur(a, r_px):
    f = np.fft.fft2(a); fy = np.fft.fftfreq(a.shape[0])[:, None]; fx = np.fft.fftfreq(a.shape[1])[None, :]
    return np.real(np.fft.ifft2(f * np.exp(-(fx ** 2 + fy ** 2) * (2 * np.pi * r_px) ** 2 / 2))).astype(F32)

def warp(a, dx, dy):
    """periodic domain warp: sample a at (x+dx, y+dy) in pixels"""
    yy, xx = np.mgrid[0:N, 0:N].astype(F32)
    return map_coordinates(a, [(yy + dy) % N, (xx + dx) % N], order=1, mode='grid-wrap').astype(F32)

def voronoi(rng, npts, aniso=(1.0, 1.0), relax=0, n=N):
    """periodic Voronoi on the unit torus. returns F1, F2 (in tile units, aniso-scaled), cell id, cell centre (x,y)"""
    P = rng.random((npts, 2))
    for _ in range(relax):                         # Lloyd-ish relaxation => hexagon-like cells
        T = np.concatenate([P + [i, j] for i in (-1, 0, 1) for j in (-1, 0, 1)])
        g = rng.random((npts * 40, 2)); gi = cKDTree(T * aniso).query(g * aniso)[1]
        for k in range(npts):
            m = g[gi == k]
            if len(m): P[k] = m.mean(0)
        P %= 1
    T = np.concatenate([P + [i, j] for i in (-1, 0, 1) for j in (-1, 0, 1)])
    ids = np.tile(np.arange(npts), 9)
    tr = cKDTree(T * aniso)
    g = (np.mgrid[0:n, 0:n].astype(F32) + 0.5) / n
    q = np.stack([g[1].ravel(), g[0].ravel()], 1) * aniso
    d, i = tr.query(q, k=2, workers=-1)
    f1 = d[:, 0].reshape(n, n).astype(F32); f2 = d[:, 1].reshape(n, n).astype(F32)
    cid = ids[i[:, 0]].reshape(n, n); cen = T[i[:, 0]].reshape(n, n, 2).astype(F32)
    return f1, f2, cid, cen

def rnd_per(cid, vals): return vals[cid]

def mix(a, b, t): return a * (1 - t[..., None]) + b * t[..., None]

yy, xx = (np.mgrid[0:N, 0:N].astype(F32) + 0.5) / N     # yy: 0 = top of tile, increases DOWN the cliff; xx: along the wall

# ───────────────────────── sets ─────────────────────────
def finish(rng, col, H, rough, warp_px=14, fbm=0.10, chip=0.10, mott=0.28, chip_n=900):
    """natural irregularity on top of the geological layout: domain-warp everything, fractal roughness, angular fracture chips,
    multi-scale colour mottling (breaks the clean procedural look and any repetition of the layout)"""
    wx = (fnoise(rng, 2.4) - 0.5) * 2 * warp_px + (fnoise(rng, 1.6) - 0.5) * warp_px * 0.5
    wy = (fnoise(rng, 2.4) - 0.5) * 2 * warp_px * 0.6 + (fnoise(rng, 1.6) - 0.5) * warp_px * 0.3
    H = warp(H, wx, wy); rough = warp(rough, wx, wy)
    col = np.stack([warp(col[..., c], wx, wy) for c in range(3)], -1)
    oct_ = fnoise(rng, 2.6) * 0.5 + fnoise(rng, 2.0) * 0.3 + fnoise(rng, 1.4) * 0.2
    H = H + fbm * (oct_ - 0.5) * 2
    f1, f2, cid, cen = voronoi(rng, chip_n)
    n = len(np.unique(cid)); gr = rng.normal(0, 1.0, (n, 2)); lv = rng.normal(0, 0.5, n)
    dx = (xx - cen[..., 0] + 0.5) % 1 - 0.5; dy = (yy - cen[..., 1] + 0.5) % 1 - 0.5
    ch = lv[cid] * 0.05 + (gr[cid, 0] * dx + gr[cid, 1] * dy) * 9.0
    H = H + chip * (np.clip(ch, -0.5, 0.5) - 0.25 * np.exp(-((f2 - f1) / 0.0025) ** 2))
    m = 1 + mott * ((fnoise(rng, 2.2) - 0.5) * 0.9 + (fnoise(rng, 1.5) - 0.5) * 0.6 + (fnoise(rng, 0.9) - 0.5) * 0.35)
    grain = 1 + 0.16 * ((fnoise(rng, 0.7) - 0.5) * 2) + 0.10 * ((fnoise(rng, 1.1) - 0.5) * 2)
    col = col * (m * grain)[..., None]
    H = H + 0.02 * ((fnoise(rng, 0.8) - 0.5) * 2)
    return col, H, rough

# (shard pass) the visible mansion cliff is a structure of straight angular SHARD ROCK (see cliff_mesh.py), so the wall sets are rebuilt in the same language:
# planar facets at offset depths, straight seams, sloped cleavage cuts, tight straight vertical grooves, chipped (paler) proud edges, rock-rough.  Opaque weathered
# stone only: no transmission, no gem colour, no emissive, roughness >= 0.6 everywhere.  Analogs (structure only): cleaved slate / greywacke joint faces,
# dogtooth-spar / geode shard clusters and columnar basalt, re-read as dull fractured rock.  Nothing is taken from any game.
def _slabs(rng, n, wlo=0.6, whi=1.4):
    w = rng.uniform(wlo, whi, n); w = w / w.sum(); e = np.concatenate([[0], np.cumsum(w)]) + rng.random() * 0.0
    xc = (np.arange(N, dtype=F32) + 0.5) / N
    k = np.clip(np.searchsorted(e, xc, side='right') - 1, 0, n - 1)
    return e, k, xc

def _tiles(rng, H, e, k, xc, cuts_lo, cuts_hi, off_sd, gx_sd, gy_sd, ridge_p, ridge_k, slope_sd, bev_px, seam_px, seam_d):
    """planar tiles: every slab (straight vertical strip) is cut by straight sloped cleavage lines (periodic in y), every tile a tilted plane, some ridged"""
    n = len(e) - 1; tid = np.zeros((N, N), np.int32); tone = np.zeros((N, N), F32)
    v = yy[:, 0]
    for s_ in range(n):
        cols = np.nonzero(k == s_)[0]
        if not len(cols): continue
        xm = 0.5 * (e[s_] + e[s_ + 1]); wd = e[s_ + 1] - e[s_]; xs_ = xc[cols] - xm
        nc = int(rng.integers(cuts_lo, cuts_hi + 1)); cz = np.sort(rng.random(nc)); sl = rng.normal(0, slope_sd, nc)
        # y of each cut along this slab's columns (periodic): cut c at v = cz[c] + sl[c] * x
        Yc = (cz[None, :] + sl[None, :] * xs_[:, None]) % 1.0                                   # (cols, nc)
        vv = v[:, None, None]                                                                     # (N, 1, 1)
        dv = (vv - Yc[None]) % 1.0                                                               # distance below each cut, (N, cols, nc)
        above = np.argmin(dv, -1)                                                                # the nearest cut above = this tile's top cut
        dtop = np.take_along_axis(dv, above[..., None], -1)[..., 0]
        dbot = np.min((Yc[None] - vv) % 1.0, -1)
        o = rng.normal(0, off_sd, nc); gx = rng.normal(0, gx_sd, nc); gy = rng.normal(0, gy_sd, nc)
        rk = np.where(rng.random(nc) < ridge_p, rng.uniform(*ridge_k, nc), 0.0); rx = rng.uniform(-0.3, 0.3, nc) * wd
        tt = rng.random(nc)
        plane = o[above] + gx[above] * xs_[None, :] + gy[above] * (dtop - 0.5 * (dtop + dbot)) - rk[above] * np.abs(xs_[None, :] - rx[above])
        # cleavage cut: a short planar chamfer under the tile above (the tile below sits proud or recessed by its own offset) + a dark hairline
        bev = bev_px / N
        cut_on = (rng.random(nc) < 0.6).astype(F32)                                              # 40 % of the cuts are only a tone / offset change, no chamfer
        plane = plane - cut_on[above] * (0.22 * np.clip(1 - dtop / bev, 0, 1)) - cut_on[np.argmin((Yc[None] - vv) % 1.0, -1)] * 0.12 * np.clip(1 - dbot / (bev * 0.6), 0, 1)
        H[:, cols] += plane
        tid[:, cols] = s_ * 64 + above; tone[:, cols] = tt[above]
    de = np.minimum(np.abs(xc[:, None] - e[None, :]).min(1), 1.0)                                # distance to the nearest straight seam
    seam = -seam_d * np.clip(1 - de / (seam_px / N), 0, 1) ** 1.0                                # V-groove: linear walls = two planar faces
    H += seam[None, :]
    return H, tid, tone, de

def _grooves(rng, H, n, depth=(0.02, 0.09), wpx=(0.8, 2.6), lmin=0.15):
    """tight straight vertical grooves (cleavage / fluting): partial-length, periodic in y"""
    v = yy[:, 0]; G = np.zeros((N, N), F32)
    for _ in range(n):
        x0 = rng.random() * N; w = rng.uniform(*wpx); dep = rng.uniform(*depth); y0 = rng.random(); L = rng.uniform(lmin, 1.0)
        c0 = int(x0 - 3 * w) - 1; c1 = int(x0 + 3 * w) + 2; cols = np.arange(c0, c1) % N
        prof = np.clip(1 - np.abs(np.arange(c0, c1) + 0.5 - x0) / (w * 1.5), 0, 1)               # a V (two planar walls), not a gaussian
        ym = ((v - y0) % 1.0) < L
        tap = np.clip(np.minimum((v - y0) % 1.0, L - (v - y0) % 1.0) / 0.02, 0, 1) * ym        # groove ends taper out over 6 cm
        G[:, cols] -= dep * tap[:, None] * prof[None, :]
    return G

def _edgewear(H, r=3.0):
    cvx = np.clip(H - blur(H, r), 0, None); return np.clip(cvx / (np.percentile(cvx, 99.5) + 1e-6), 0, 1)

def set_strata(rng):
    """cleaved slab faces (main wall): straight vertical slabs at offset depths, sloped cleavage cuts, tight vertical grooves"""
    e, k, xc = _slabs(rng, 7)
    H = np.zeros((N, N), F32)
    H, tid, tone, de = _tiles(rng, H, e, k, xc, 1, 2, off_sd=0.10, gx_sd=0.9, gy_sd=0.25, ridge_p=0.35, ridge_k=(0.6, 1.8), slope_sd=0.22, bev_px=10, seam_px=7, seam_d=0.5)
    H += _grooves(rng, H, 130, depth=(0.03, 0.13))
    gr = fnoise(rng, 1.0); mid = fnoise(rng, 2.2)
    H += 0.012 * gr + 0.02 * mid
    wear = _edgewear(H)
    pal = np.array([[0.215, 0.205, 0.195], [0.19, 0.185, 0.18], [0.235, 0.215, 0.19], [0.17, 0.17, 0.175], [0.205, 0.19, 0.17]], F32)
    col = pal[(tone * len(pal)).astype(int) % len(pal)] * (0.88 + 0.16 * mid[..., None]) * (0.94 + 0.10 * gr[..., None])
    col = mix(col, np.array([0.34, 0.325, 0.30], F32), wear * 0.55)                                   # chipped proud edges: paler fresh stone
    deep = np.clip(-(H - blur(H, 6)) * 6, 0, 1)
    col = mix(col, np.array([0.09, 0.085, 0.08], F32), deep * 0.5)                                    # grime in seams / grooves
    varn = sm(0.66, 0.84, fnoise(rng, 2.3, sx=0.035, sy=1.0)) * sm(0.35, 0.7, fnoise(rng, 2.0))       # vertical run-off streaks
    col = mix(col, np.array([0.12, 0.11, 0.10], F32), varn * 0.20)
    lich = sm(0.74, 0.88, fnoise(rng, 2.6)) * sm(0.55, 0.8, gr) * (1 - varn)
    col = mix(col, np.array([0.24, 0.26, 0.17], F32), lich * 0.30)
    rough = 0.80 + 0.06 * gr + 0.08 * deep + 0.05 * wear - 0.06 * (1 - deep) * sm(0.6, 1, mid)
    return col, H, rough, dict(depth_m=0.16, name='Cleaved shard-rock slab faces')

def set_columnar(rng):
    """angular prism shards: narrow straight prisms, each two planar facets on a ridge, straight sloped cross-joints"""
    e, k, xc = _slabs(rng, 6, 0.7, 1.3)
    H = np.zeros((N, N), F32)
    H, tid, tone, de = _tiles(rng, H, e, k, xc, 1, 2, off_sd=0.08, gx_sd=0.5, gy_sd=0.15, ridge_p=0.85, ridge_k=(1.2, 2.6), slope_sd=0.35, bev_px=12, seam_px=9, seam_d=0.7)
    H += _grooves(rng, H, 60, depth=(0.02, 0.07))
    gr = fnoise(rng, 1.2); mid = fnoise(rng, 2.2)
    H += 0.012 * gr + 0.02 * mid
    wear = _edgewear(H)
    st = ((tid * 0.7548776) % 1).astype(F32)
    base = 0.135 + 0.05 * st + 0.035 * mid + 0.02 * gr
    col = np.stack([base * 1.0, base * 0.99, base * 1.03], -1)
    col = mix(col, np.array([0.30, 0.295, 0.285], F32), wear * 0.55)
    deep = np.clip(-(H - blur(H, 6)) * 6, 0, 1)
    col = mix(col, np.array([0.17, 0.10, 0.07], F32), deep * sm(0.4, 0.8, fnoise(rng, 2.0)) * 0.45)    # rust in the joints
    bloom = sm(0.58, 0.85, fnoise(rng, 2.6)) * sm(0.2, 0.7, mid)
    col = mix(col, np.array([0.30, 0.29, 0.27], F32), bloom * 0.35)
    lich = sm(0.75, 0.9, fnoise(rng, 2.8)) * sm(0.5, 0.8, gr)
    col = mix(col, np.array([0.26, 0.28, 0.14], F32), lich * 0.35)
    rough = 0.74 + 0.12 * gr + 0.08 * bloom + 0.06 * deep
    return col, H, rough, dict(depth_m=0.14, name='Angular prism shard rock')

def set_sheet(rng):
    """joint-face pavement (plateau / benches): tight-fitted planar plates on straight joints (Voronoi bisectors) + two long straight joint sets"""
    f1, f2, cid, cen = voronoi(rng, 70, aniso=(1.0, 1.0), relax=2)
    n1 = cid.max() + 1; g1 = rng.normal(0, 0.35, (n1, 2)); lvl = rng.normal(0, 0.05, n1)
    dx = (xx - cen[..., 0] + 0.5) % 1 - 0.5; dy = (yy - cen[..., 1] + 0.5) % 1 - 0.5
    edge = f2 - f1
    H = lvl[cid] + g1[cid, 0] * dx + g1[cid, 1] * dy - 0.35 * np.clip(1 - edge / 0.006, 0, 1)
    for (a_, b_), dep in (((1, 2), 0.25), ((2, -1), 0.18)):                                        # straight joints that wrap the torus (integer directions)
        ph = rng.random(); t_ = (a_ * xx + b_ * yy + ph) % 1.0; dj = np.minimum(t_, 1 - t_) / np.hypot(a_, b_)
        H -= dep * np.clip(1 - dj / 0.004, 0, 1)
    gr = fnoise(rng, 1.0); H += 0.015 * gr + 0.02 * fnoise(rng, 2.2)
    wear = _edgewear(H)
    tone = rng.random(n1)[cid]
    base = 0.17 + 0.07 * tone + 0.03 * gr
    col = np.stack([base, base * 0.97, base * 0.93], -1)
    col = mix(col, np.array([0.33, 0.32, 0.30], F32), wear * 0.45)
    deep = np.clip(-(H - blur(H, 6)) * 6, 0, 1)
    col = mix(col, np.array([0.10, 0.095, 0.085], F32), deep * 0.5)
    lich = sm(0.72, 0.88, fnoise(rng, 2.8)) * (1 - deep)
    col = mix(col, np.array([0.30, 0.32, 0.17], F32), lich * 0.35)
    dust = sm(0.5, 0.8, fnoise(rng, 2.2)) * 0.35
    col = mix(col, np.array([0.36, 0.33, 0.28], F32), dust * deep)
    rough = 0.82 + 0.08 * gr + 0.06 * deep
    return col, H, rough, dict(depth_m=0.07, name='Joint-face rock pavement')

def set_talus(rng):
    f1, f2, cid, cen = voronoi(rng, 120, aniso=(1.0, 0.75), relax=0)
    n1 = len(np.unique(cid))
    g1 = rng.normal(0, 0.9, (n1, 2)); lvl = rng.normal(0, 0.12, n1)
    dx = (xx - cen[..., 0] + 0.5) % 1 - 0.5; dy = (yy - cen[..., 1] + 0.5) % 1 - 0.5
    hb = lvl[cid] + g1[cid, 0] * dx + g1[cid, 1] * dy
    edge = f2 - f1
    inblock = sm(0.004, 0.012, edge)
    s1, s2, c2, cen2 = voronoi(rng, 2400, relax=0)
    gl = rng.normal(0, 0.12, len(np.unique(c2))); gg = rng.normal(0, 3.0, (len(gl), 2))
    dx2 = (xx - cen2[..., 0] + 0.5) % 1 - 0.5; dy2 = (yy - cen2[..., 1] + 0.5) % 1 - 0.5
    hg = gl[c2] + gg[c2, 0] * dx2 + gg[c2, 1] * dy2 - 0.9 * np.exp(-((s2 - s1) / 0.002) ** 2)
    H = np.where(inblock > 0.5, 0.25 + hb * 0.9, -0.2 + hg * 0.5)
    H -= 0.6 * np.exp(-(edge / 0.004) ** 2) * (inblock > 0.0)
    H += 0.02 * fnoise(rng, 1.4)
    pal = np.array([[0.28, 0.27, 0.26], [0.33, 0.29, 0.24], [0.2, 0.19, 0.19], [0.36, 0.30, 0.22], [0.15, 0.14, 0.14], [0.30, 0.22, 0.16]], F32)
    pb = pal[rng.integers(0, len(pal), n1)][cid] * (0.8 + 0.4 * rng.random(n1)[cid][..., None])
    pg = pal[rng.integers(0, len(pal), len(gl))][c2] * (0.75 + 0.5 * rng.random(len(gl))[c2][..., None])
    col = np.where((inblock > 0.5)[..., None], pb, pg)
    dust = sm(0.45, 0.8, fnoise(rng, 2.2)) * sm(0.0, 0.5, np.clip(g1[cid, 1] * 0 + 0.5 + (hb - hb.mean()) * 1.5, 0, 1)) * 0.5
    col = mix(col, np.array([0.40, 0.36, 0.30], F32), dust * 0.5)
    lich = sm(0.74, 0.9, fnoise(rng, 2.8)) * (inblock > 0.5)
    col = mix(col, np.array([0.25, 0.28, 0.13], F32), lich * 0.35)
    lum = col.mean(-1, keepdims=True); col = lum * 0.75 + col * 0.25                 # scree is mostly grey; keep only a hint of the palette
    col = col * (0.75 + 0.5 * fnoise(rng, 2.0)[..., None])
    rough = 0.86 + 0.1 * fnoise(rng, 1.2)
    return col, H, rough, dict(depth_m=0.20, name='Talus / scree')

BUILD = dict(strata=set_strata, columnar=set_columnar, sheet=set_sheet, talus=set_talus)
# (shard pass) domain warp cut to 1.5-3 px so seams / cuts / grooves stay STRAIGHT (the v298 10-30 px warp bent every line into a wave); fbm relief small (planar faces)
FIN = dict(strata=dict(warp_px=2.0, fbm=0.035, chip=0.03, mott=0.30, chip_n=500), columnar=dict(warp_px=1.5, fbm=0.03, chip=0.03, mott=0.28, chip_n=450),
           sheet=dict(warp_px=2.0, fbm=0.03, chip=0.025, mott=0.24, chip_n=300), talus=dict(warp_px=3.0, fbm=0.06, chip=0.05, mott=0.45, chip_n=1200))
SEED = dict(strata=5101, columnar=5202, sheet=5303, talus=4404)

# ───────────────────────── derived maps + export ─────────────────────────
MICRO = dict(strata=0.0035, columnar=0.0025, sheet=0.0030, talus=0.0030)    # metres of grain relief in the DETAIL normal layer (normal map only)

def derive(col, H, rough, depth_m, micro=0.0, rng=None):
    H = (H - np.percentile(H, 0.05)) / (np.percentile(H, 99.95) - np.percentile(H, 0.05) + 1e-9); H = np.clip(H, 0, 1).astype(F32)
    Hm = H * depth_m; px = TILE_M / N
    if micro > 0 and rng is not None:
        # (v298) DETAIL-NORMAL layer: crystal / sand-grain relief at 1.5-6 mm (2-8 px at 2K) folded into the normal map only.  The height map (POM) stays the
        # macro relief so the march is unchanged; up close the 2K normal now carries grain instead of a smooth plastic sheen.  The 1K / 512 tiers average it
        # away by construction (Lanczos downscale), so they are not noisier.
        g_ = (fnoise(rng, 0.6) - 0.5) * 0.7 + (blur(rng.random((N, N)).astype(F32), 0.9) - 0.5) * 1.6
        Hm = Hm + micro * g_ * (0.6 + 0.4 * H)
    gx = (np.roll(Hm, -1, 1) - np.roll(Hm, 1, 1)) / (2 * px)                 # dh/dx (right)
    gu = (np.roll(Hm, 1, 0) - np.roll(Hm, -1, 0)) / (2 * px)                 # dh/dup (image rows increase downward)
    nx, ny, nz = -gx * 1.25, -gu * 1.25, np.ones_like(gx)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    nrm = np.stack([nx / l, ny / l, nz / l], -1) * 0.5 + 0.5
    cav = np.clip(blur(H, 3) - H, 0, None) * 5 + np.clip(blur(H, 14) - H, 0, None) * 2.2
    ao = np.clip(1 - cav, 0.2, 1)
    # tile-scale colour banding would repeat every 3 m on a 60 m wall: flatten the low-frequency luminance (macro colour comes from the mesh COLOR_0 instead)
    lum = col.mean(-1); lo = blur(lum, 260); flat = (lum.mean() / np.maximum(lo, 1e-3)) ** FLAT
    col = col * flat[..., None]
    col = np.clip(col * 1.3 * (0.78 + 0.22 * ao[..., None]), 0, 1)
    orm = np.stack([ao, np.clip(rough, 0.3, 1), np.zeros_like(ao)], -1)
    return col, nrm.astype(F32), orm, H

def save_tiers(name, col, nrm, orm, H):
    sizes = {}
    for tag, r in (('2k', 2048), ('1k', 1024), ('512', 512)):
        for kind, arr, q in (('color', col, 84), ('nrm', nrm, 86), ('orm', orm, 82), ('height', H, 88)):
            if kind == 'height': a8 = (np.clip(arr, 0, 1) * 255 + .5).astype(np.uint8); im = Image.fromarray(a8, 'L')
            else: im = Image.fromarray((np.clip(arr, 0, 1) * 255 + .5).astype(np.uint8))
            if r != N: im = im.resize((r, r), Image.LANCZOS)
            p = f'{OUT}/{name}-{kind}-{tag}.webp'
            im.save(p, quality=q, method=5); sizes[f'{kind}-{tag}'] = os.path.getsize(p)
    return sizes

meta = {}
for s in SETS:
    rng = np.random.default_rng(SEED[s])
    col, H, rough, info = BUILD[s](rng)
    col, H, rough = finish(rng, col, H, rough, **FIN[s])
    col, nrm, orm, Hn = derive(col, H, rough, info['depth_m'], MICRO.get(s, 0.0), rng)
    sz = save_tiers(s, col, nrm, orm, Hn)
    info['bytes'] = sz; meta[s] = info
    if PREV:
        Image.fromarray((np.clip(col, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)).resize((768, 768), Image.LANCZOS).save(f'{PREV}/{s}-color.png')
        Image.fromarray((nrm * 255).astype(np.uint8)).resize((768, 768), Image.LANCZOS).save(f'{PREV}/{s}-nrm.png')
        Image.fromarray((Hn * 255).astype(np.uint8)).resize((768, 768), Image.LANCZOS).save(f'{PREV}/{s}-height.png')
    print('set', s, {k: v // 1024 for k, v in sz.items() if k.endswith('2k')})
MATNAME = dict(strata='ah_rock', columnar='ah_rockc', sheet='ah_rocks', talus='ah_rockt')
if set(SETS) == set(BUILD):
    J = {
        'version': 1, 'tileM': TILE_M, 'base': 'assets/ariel-home/cliff/',
        'about': 'Procedural cliff rock for Ariel\'s mansion (tools/ariel-home/gen_cliff_textures.py). Tileable 3 m x 3 m sets; mesh UVs are true surface metres / tileM, so 1 UV unit = 3 m.',
        'uv': {'u': 'world x metres / tileM along the wall', 'v': 'metres up the wall / tileM (Blender v up; glTF v is flipped, load with flipY=false); image row 0 = top = up the cliff',
               'note': 'meshes: Mansion_LOD0 prims ah_rock / ah_rockc / ah_rocks / ah_rockt carry COLOR_0 = macro tint (multiply into albedo) and NORMAL; tangents are derived from the UVs'},
        'tiers': {t: {'px': r, 'pxPerM': round(r / TILE_M)} for t, r in (('2k', 2048), ('1k', 1024), ('512', 512))},
        'heightTierFor': {'2k': '2k', '1k': '1k', '512': '512'},
        'files': '<set>-<map>-<tier>.webp, map in color|nrm|orm|height, tier in 2k|1k|512',
        'channels': {'color': 'sRGB albedo, already flattened at tile scale; multiply by COLOR_0', 'nrm': 'tangent-space normal, OpenGL (+Y = up the wall), RGB 8-bit, linear',
                     'orm': 'linear: R ambient occlusion, G roughness, B metalness (0)', 'height': '8-bit gray, linear, 1 = proud, 0 = deepest; for parallax occlusion: depth = (1 - h) * depthM below the surface plane'},
        'parallax': {'steps': {'near': 24, 'far': 8}, 'fadeStartM': 14, 'fadeEndM': 40, 'note': 'use heightmap tier of the loaded albedo tier; skip POM on the 512 tier / mobile if the frame budget is tight'},
        'sets': {k: {'material': MATNAME[k], 'name': meta[k]['name'], 'depthM': meta[k]['depth_m'], 'bytes': meta[k]['bytes']} for k in BUILD},
        'use': {'strata': 'cleaved shard slabs on the main wall', 'columnar': 'prism-shard slots (~38 % of the macro shard slots)', 'sheet': 'plateau / bench pavement', 'talus': 'angular block aprons at the base'},
    }
    json.dump(J, open(f'{OUT}/cliff-materials.json', 'w'), indent=1)
