#!/usr/bin/env python3
"""Cliff rock PBR sets for Ariel's mansion cliff (Solenne).  numpy + scipy + PIL only, fully procedural, no downloads.

Four tileable 3 m x 3 m rock sets, each with diffuse/albedo, tangent normal (OpenGL, +Y up the cliff), ORM (R=AO G=roughness B=metal)
and a height map (white = proud, black = deep) for the parallax-occlusion shader (ui/dm-parallax.js reads cliff-materials.json):

  strata    stratified sandstone / limestone ledges: variable bed thickness, hard caps + soft recessed beds, offset vertical joint
            sets (block fabric), iron-oxide bands, desert varnish streaks   (ref: Antelope Canyon / Zion Navajo Sandstone / Dolomites)
  columnar  columnar basalt: 0.3-0.6 m prismatic columns, rounded faces, chisel cross-joints, rust in the joints
            (ref: Giant's Causeway, Fingal's Cave, Devils Postpile, Svartifoss)
  sheet     granite exfoliation sheeting: smooth sheets, a few long curved sheet joints, crystalline speckle, black water streaks,
            lichen crusts   (ref: Half Dome / El Capitan, Yosemite; Sugarloaf)
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

def set_strata(rng):
    nb = 7
    th = rng.lognormal(0, 0.75, nb); th = th / th.sum()
    cuts = np.concatenate([[0], np.cumsum(th)])[:-1] + rng.random() * 0.0
    cuts = np.sort(cuts)
    hard = rng.random(nb) < 0.5
    recess = np.where(hard, 0.0, -0.22) + rng.normal(0, 0.08, nb)
    tone = rng.random(nb)
    ox = (rng.random(nb) < 0.28).astype(F32) * rng.uniform(0.4, 1.0, nb)
    # bed boundaries wander slightly along the wall (pinch-outs, cross-bedding) but stay near-horizontal
    wob = (noise1d(rng, beta=1.8, k0=2) - 0.5) * 0.030
    wob += (noise1d(rng, beta=1.2, k0=6) - 0.5) * 0.008
    vv = (yy + wob[None, :]) % 1.0
    bed = np.clip(np.searchsorted(cuts, vv.ravel(), side='right') - 1, 0, nb - 1).reshape(N, N)
    top = np.concatenate([cuts[1:], [1.0]])[bed]; bot = cuts[bed]
    t = ((vv - bot) / np.maximum(top - bot, 1e-4)).astype(F32)        # 0 at the bed's upper boundary, 1 at its lower boundary
    thick_m = (top - bot) * TILE_M
    H = np.zeros((N, N), F32); blockid = np.zeros((N, N), np.int32)
    xc = np.arange(N, dtype=F32) / N
    for i in range(nb):
        rows = np.nonzero((bed == i).any(1))[0]
        sp = rng.uniform(0.16, 0.55)
        js = np.sort((np.arange(int(1 / sp) + 1) * sp + rng.random()) % 1.0)
        js = np.concatenate([js, js[:1] + 1.0])
        k = np.clip(np.searchsorted(js, xc, side='right') - 1, 0, len(js) - 2)
        off = rng.normal(0, 0.025 if hard[i] else 0.015, len(js) - 1)
        d = np.minimum(np.abs(xc - js[k]), np.abs(js[k + 1] - xc))
        d = np.minimum(d, np.abs(xc + 1 - js[k + 1]))
        wj = 0.0035 if hard[i] else 0.006
        crack = -0.30 * np.exp(-(d / (wj*1.6)) ** 2) * (rng.random(len(js) - 1)[k] < 0.55)
        lat = (noise1d(rng, beta=1.5, k0=3) - 0.5) * 0.14
        H[rows] += (off[k] + crack + lat)[None, :]
        blockid[rows] = (i * 64 + k)[None, :]
    m = np.zeros((N, N), F32)
    ph = hard[bed]
    # hard beds: flat face, chamfered lower edge; soft beds: recessed rubble ramp that deepens toward the overhanging bed above
    prof_hard = -0.08 * sm(0.85, 1.0, t) - 0.03 * sm(0, 0.04, 1 - t)
    prof_soft = -0.30 * (1 - t) ** 1.2 * 0.55 - 0.1 * t
    prof = np.where(ph, prof_hard, prof_soft)
    H += recess[bed] + prof
    H -= 0.28 * np.exp(-(t / 0.012) ** 2)                               # dark parting plane at each bed top
    lam = fnoise(rng, 2.0, sx=1.0, sy=0.05)                            # thin laminations: stretched along x
    gr = fnoise(rng, 1.0)
    flake = sm(0.74, 0.9, fnoise(rng, 2.4, sx=1.0, sy=0.12)) * sm(0.45, 0.8, fnoise(rng, 1.8))
    H += 0.05 * lam + 0.018 * gr - 0.10 * flake
    # block-to-block colour/height offsets from the joint fabric
    bt = ((blockid * 0.6180339) % 1).astype(F32)
    # colour
    pal = np.array([[0.26, 0.23, 0.20], [0.31, 0.22, 0.14], [0.15, 0.145, 0.145], [0.34, 0.29, 0.22], [0.20, 0.17, 0.155]], F32)
    pi = (tone * len(pal)).astype(int) % len(pal)
    pm = pal.mean(0); pal = pm + (pal - pm) * 0.40            # (v2) the old 13-band orange/grey stripes read as painted contour lines: bed colour contrast cut to 40 %, the mesh carries the bed tone
    col = pal[pi][bed] * (0.80 + 0.45 * lam[..., None]) * (0.94 + 0.12 * bt[..., None])
    rust = np.array([0.30, 0.13, 0.07], F32)
    oxm = (ox[bed] * (0.4 + 0.6 * sm(0.3, 0.75, fnoise(rng, 2.0, sx=1.0, sy=0.2)))).astype(F32)
    col = mix(col, rust * (0.8 + 0.4 * gr[..., None]), np.clip(oxm * 0.5, 0, 0.5))
    varn = sm(0.66, 0.84, fnoise(rng, 2.3, sx=0.035, sy=1.0)) * sm(0.35, 0.7, fnoise(rng, 2.0))   # desert varnish: long vertical streaks
    col = mix(col, np.array([0.12, 0.105, 0.095], F32), varn * 0.22)   # (v2) was a 0.8 black stripe: one dark column per 3 m tile = the most visible repetition
    lich = sm(0.7, 0.85, fnoise(rng, 2.6)) * sm(0.55, 0.8, gr) * (1 - varn)
    col = mix(col, np.array([0.22, 0.25, 0.14], F32), lich * 0.45)
    rough = 0.80 + 0.1 * gr - 0.08 * ph + 0.06 * (1 - ph) - 0.22 * varn
    return col, H, rough, dict(depth_m=0.16, name='Stratified sandstone / limestone ledges')

def set_columnar(rng):
    ncol = 7
    w = rng.uniform(0.7, 1.3, ncol); w = w / w.sum()
    edges = np.concatenate([[0], np.cumsum(w)])
    xc = (np.arange(N, dtype=F32) + 0.5) / N
    cid = np.clip(np.searchsorted(edges, xc, side='right') - 1, 0, ncol - 1)
    left = edges[cid]; right = edges[cid + 1]
    # columns are not perfectly straight: edges meander a little with height
    meander = (fnoise(rng, 2.4, sx=0.1, sy=0.3) - 0.5) * 0.02
    X = np.broadcast_to(xc[None, :], (N, N)) + meander
    cidm = np.clip(np.searchsorted(edges, X.ravel() % 1.0, side='right') - 1, 0, ncol - 1).reshape(N, N)
    L = edges[cidm]; R = edges[cidm + 1]
    tt = ((X % 1.0 - L) / (R - L)).astype(F32)
    dedge = np.minimum(tt, 1 - tt) * (R - L)                           # tile units to nearest column edge
    tilt = rng.normal(0, 0.10, ncol)[cidm]; push = rng.normal(0, 0.05, ncol)[cidm]
    face = 0.30 * np.sqrt(np.clip(1 - (2 * tt - 1) ** 2, 0, 1)) + tilt * (tt - 0.5)
    H = face + push - 0.75 * np.exp(-(dedge / 0.006) ** 2) - 0.25 * sm(0.0, 0.03, 0.03 - dedge)
    # chisel cross-joints: each column breaks into segments at its own heights
    seg = np.zeros((N, N), F32); xseg = np.zeros((N, N), np.int32)
    for k in range(ncol):
        n_seg = int(rng.integers(3, 8)); cuts = np.sort(rng.random(n_seg)); cuts = np.concatenate([cuts, cuts[:1] + 1.0])
        v = yy[:, 0]
        j = np.clip(np.searchsorted(cuts, v, side='right') - 1, 0, n_seg - 1)
        j = np.where(v < cuts[0], n_seg - 1, j)
        vv = np.where(v < cuts[0], v + 1.0, v)
        t = (vv - cuts[j]) / np.maximum(cuts[j + 1] - cuts[j], 1e-4)
        dv = np.minimum(t, 1 - t) * (cuts[j + 1] - cuts[j])
        prof = -0.5 * np.exp(-(dv / 0.0045) ** 2) + 0.10 * np.sin(np.pi * np.clip(t, 0, 1)) - 0.05 * (1 - t)
        off = rng.normal(0, 0.05, n_seg)[j]
        m = (cidm == k)
        H = np.where(m, H + (prof + off)[:, None], H)
        xseg = np.where(m, (k * 32 + j[:, None]), xseg)
    gr = fnoise(rng, 1.2); mid = fnoise(rng, 2.2)
    flake = sm(0.68, 0.88, fnoise(rng, 2.2, sx=1.0, sy=0.5))
    H += 0.025 * gr + 0.05 * mid - 0.08 * flake
    st = ((xseg * 0.7548776) % 1).astype(F32)
    base = 0.12 + 0.07 * st + 0.05 * mid + 0.03 * gr
    col = np.stack([base * 1.02, base * 1.0, base * 1.05], -1)
    bloom = sm(0.55, 0.85, fnoise(rng, 2.6)) * sm(0.2, 0.7, mid)      # pale weathering bloom
    col = mix(col, np.array([0.34, 0.33, 0.31], F32), bloom * 0.6)
    jnt = np.clip(np.exp(-(dedge / 0.02) ** 2) * 0.9 + (H < -0.25) * 0.4, 0, 1)
    col = mix(col, np.array([0.20, 0.10, 0.06], F32), jnt * sm(0.4, 0.8, fnoise(rng, 2.0)) * 0.6)   # rust staining in the joints
    lich = sm(0.72, 0.88, fnoise(rng, 2.8)) * sm(0.5, 0.8, gr)
    col = mix(col, np.array([0.30, 0.32, 0.12], F32), lich * 0.5)
    rough = 0.68 + 0.18 * gr + 0.1 * bloom - 0.15 * (1 - bloom) * sm(0.6, 1, mid)
    return col, H, rough, dict(depth_m=0.14, name='Columnar basalt')

def set_sheet(rng):
    # (v298) Half Dome / El Capitan sheeting: 4-5 thin exfoliation shells, each edge a short crisp riser (domain-warped so it wanders and chips), instead of two broad
    # steps whose 0.47 isoline drew a single thin contour line across every 3 m tile
    sheets = fnoise(rng, 3.0); sw_ = (fnoise(rng, 1.7) - 0.5) * 0.05; sv_ = sheets + sw_
    lvls = np.sort(rng.uniform(0.30, 0.75, 3)); lvl = np.zeros_like(sheets); sheetedge = np.zeros_like(sheets); shell = np.zeros_like(sheets)
    for k_, lv_ in enumerate(lvls):
        on_ = sm(0.40, 0.62, fnoise(rng, 1.9))                                                 # the riser is only cut where the shell has spalled
        lvl += (0.10 + 0.06 * rng.random()) * sm(lv_ - 0.02, lv_ + 0.012, sv_) * on_
        sheetedge += np.exp(-((sv_ - lv_) / 0.012) ** 2) * on_; shell += sm(lv_ - 0.02, lv_ + 0.012, sv_) * on_ * (rng.random() - 0.5)
    cr = fnoise(rng, 2.6)
    crack = np.exp(-((cr - 0.5) / 0.0035) ** 2) * sm(0.4, 0.6, fnoise(rng, 2.2)) + 0.7 * np.exp(-((fnoise(rng, 2.8) - 0.5) / 0.003) ** 2) * sm(0.45, 0.65, fnoise(rng, 2.0))
    spk = fnoise(rng, 0.0); spk2 = blur(rng.random((N, N)).astype(F32), 1.1); spk2 = (spk2 - spk2.min()) / (spk2.max() - spk2.min())
    H = 0.30 * fnoise(rng, 3.4) + lvl * 0.9 - 0.16 * crack - 0.04 * sheetedge + 0.03 * spk2 + 0.03 * fnoise(rng, 1.6)
    flake = sm(0.78, 0.93, fnoise(rng, 2.4)) * sm(0.45, 0.8, fnoise(rng, 1.6))
    H -= 0.12 * flake
    quartz = np.array([0.46, 0.45, 0.43], F32); feld = np.array([0.42, 0.36, 0.32], F32); bio = np.array([0.07, 0.07, 0.075], F32)
    mflt = sm(0.4, 0.7, fnoise(rng, 2.0))
    base = mix(np.broadcast_to(quartz, (N, N, 3)).copy(), np.broadcast_to(feld, (N, N, 3)).copy(), mflt * 0.55)
    bmask = sm(0.62, 0.7, spk2); kq_ = blur(rng.random((N, N)).astype(F32), 3.0); kq_ = (kq_ - kq_.min()) / (kq_.max() - kq_.min() + 1e-9); kspar = sm(0.70, 0.80, kq_) * 0.6   # biotite flecks + pink K-feldspar phenocrysts
    col = mix(base, np.broadcast_to(bio, (N, N, 3)).copy(), bmask * 0.42) * (0.9 + 0.2 * fnoise(rng, 2.6)[..., None])
    col = mix(col, np.broadcast_to(np.array([0.50, 0.40, 0.36], F32), (N, N, 3)).copy(), kspar * 0.35)
    col = col * (1 + 0.16 * (shell[..., None] - shell.mean()))                     # each shell weathered to its own tone (fresh spall scars paler)
    streak = sm(0.60, 0.80, fnoise(rng, 2.4, sx=0.03, sy=1.0)) * sm(0.25, 0.7, fnoise(rng, 2.0, sx=0.3, sy=0.6))   # long black water streaks
    streak = np.clip(streak * 0.5 + 0.25 * crack, 0, 1)
    col = mix(col, np.array([0.12, 0.12, 0.12], F32), streak * 0.6)
    lich = sm(0.74, 0.9, fnoise(rng, 2.8)) * sm(0.5, 0.75, spk2) * (1 - streak)
    col = mix(col, np.array([0.40, 0.42, 0.18], F32), lich * 0.6)
    rough = 0.72 + 0.12 * spk2 - 0.2 * streak
    return col * 0.88, H, rough, dict(depth_m=0.07, name='Granite exfoliation sheets')

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
FIN = dict(strata=dict(warp_px=30, fbm=0.22, chip=0.035, mott=0.38, chip_n=350), columnar=dict(warp_px=10, fbm=0.12, chip=0.03, mott=0.34, chip_n=400),
           sheet=dict(warp_px=14, fbm=0.10, chip=0.025, mott=0.26, chip_n=300), talus=dict(warp_px=26, fbm=0.16, chip=0.05, mott=0.5, chip_n=1200))
SEED = dict(strata=4101, columnar=4202, sheet=4303, talus=4404)

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
        'use': {'strata': 'ledged beds on the main wall', 'columnar': 'basalt band (z -18..-40 m, flank windows)', 'sheet': 'granite sheeting on the flanks + plateau pavement', 'talus': 'aprons / rubble at the base'},
    }
    json.dump(J, open(f'{OUT}/cliff-materials.json', 'w'), indent=1)
