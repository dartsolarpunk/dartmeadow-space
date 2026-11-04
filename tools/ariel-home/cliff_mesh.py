"""Cliff-face tessellation for Ariel's mansion (imported by build_mansion.py inside Blender; pure numpy otherwise).

The old cliff was a 150x100 top-down height grid (2.7 m cells): a vertical wall has no resolution in a top-down grid, so the strata were
faked with one sawtooth term (the wavy contour lines) and the texture carried everything.  This builds the same macro surface
(rock_h: the architect's coarse terrain incl. the deck / wing carves) as a *profile sweep*: for every x column the macro profile curve
(y, z) is re-sampled by density-weighted arclength, so rows are ~0.85 m apart ALONG the wall (fine on the face, coarse on the plateau /
sea floor), and a geological displacement model is applied along the surface normal:

  * bedding: beds 1.2-6 m thick, alternating hard caps (protruding, chamfered) and soft beds (recessed rubble ramp -> real overhangs),
    each bed pinching in / out laterally                       (Zion / Antelope sandstone, Dolomites limestone)
  * vertical joint sets with block jogs (a different jog per bed)                 (fractured shale ledges, Navajo Sandstone)
  * columnar basalt bands: rounded 3-4 m prisms + cross-joint steps               (Giant's Causeway, Devils Postpile)
  * granite exfoliation sheets on the flanks: broad domes + stepped sheet edges   (Half Dome, El Capitan, Yosemite)
  * talus aprons: rubble fans under the joints, blocky noise at the base          (Zion canyon base, Dolomites scree)
Outward displacement is clamped against the house (BVH distance) so rock never pokes through a deck / wing / pier.
Also returns per-vertex macro colour (cavity AO, wet streaks under ledges, iron bands, lichen, dust) for COLOR_0, and true-surface UVs."""
import numpy as np

def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0); return t * t * (3 - 2 * t)

def _hash(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0

def vnoise(x, y, seed=0):
    """value noise in [0,1], smooth, vectorised"""
    x = np.asarray(x, np.float64); y = np.asarray(y, np.float64)
    x0 = np.floor(x).astype(np.int64); y0 = np.floor(y).astype(np.int64); fx = x - x0; fy = y - y0
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
    a = _hash(x0, y0, seed); b = _hash(x0 + 1, y0, seed); c = _hash(x0, y0 + 1, seed); d = _hash(x0 + 1, y0 + 1, seed)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

def fbm(x, y, seed, oct=4, lac=2.0, gain=0.5):
    s = 0.0; a = 1.0; tot = 0.0
    for o in range(oct):
        s = s + a * vnoise(x, y, seed + o * 17); tot += a; x = x * lac + 31.7; y = y * lac - 17.3; a *= gain
    return s / tot

TIERS = {
    'hi':  dict(dx=1.0, rows=150, ds=0.85, far=5.0, far_x=6.0, disp=1.0),
    'mob': dict(dx=1.7, rows=100, ds=1.4,  far=7.0, far_x=8.0, disp=1.0),
    'lod1': dict(dx=5.0, rows=36, ds=4.0,  far=14.0, far_x=14.0, disp=0.55),
}

def columns_x(cfg, x0=-200.0, x1=200.0):
    xs = [x0]
    while xs[-1] < x1 - 1e-6:
        x = xs[-1]; sp = cfg['dx'] + (cfg['far_x'] - cfg['dx']) * sstep(80, 190, abs(x))
        xs.append(min(x1, x + sp))
    return np.array(xs)

def beds(seed, z0=8.0, z1=-80.0):
    r = np.random.default_rng(seed); zs = [z0]; hard = []; rec = []; ox = []
    while zs[-1] > z1:
        th = float(np.clip(r.lognormal(np.log(2.2), 0.95), 0.5, 11.0)); zs.append(zs[-1] - th)
        h = r.random() < 0.52; hard.append(h); rec.append((0.0 if h else -r.uniform(0.35, 1.5)) + r.normal(0, 0.12)); ox.append(r.random() < 0.3)
    return np.array(zs), np.array(hard), np.array(rec), np.array(ox)

def build_cliff(rock_h, edge_y, tier='hi', house_bvh=None, sea=-62.0, seed=1234, yr=(-125.0, 125.0), mat_names=('rock', 'rockc', 'rocks', 'rockt')):
    """returns dict: P (nx,ny,3) world positions, uv (nx,ny,2) metres, col (nx,ny,3) 0..1, zone (nx,ny) int 0..3 (index into mat_names), tris count"""
    cfg = TIERS[tier]; xs = columns_x(cfg); nx = len(xs); ny = cfg['rows']
    ysamp = np.arange(yr[0], yr[1] + 1e-9, 0.25)
    Y = np.zeros((nx, ny)); Z = np.zeros((nx, ny))
    for i, x in enumerate(xs):
        zs = np.array([rock_h(float(x), float(y)) for y in ysamp])
        d = ysamp - edge_y(float(x))
        # target spacing: fine on the face (and just behind the lip), coarse on plateau / sea floor
        dist_out = np.maximum(np.maximum(-6.0 - d, d - 42.0), 0.0)
        sp = cfg['ds'] + (cfg['far'] - cfg['ds']) * sstep(0.0, 28.0, dist_out)
        sp = np.where(zs < sea - 5.0, np.maximum(sp, cfg['far'] * 0.7), sp)
        seg = np.hypot(np.diff(ysamp), np.diff(zs)); w = 1.0 / (0.5 * (sp[1:] + sp[:-1]))
        I = np.concatenate([[0], np.cumsum(seg * w)])
        tgt = np.linspace(0, I[-1], ny)
        Y[i] = np.interp(tgt, I, ysamp); Z[i] = np.interp(tgt, I, zs)
    X = np.repeat(xs[:, None], ny, 1)
    P0 = np.stack([X, Y, Z], -1)
    # macro normals (central differences along the grid, smoothed once)
    tx = np.gradient(P0, axis=0); ty = np.gradient(P0, axis=1)
    nrm = np.cross(tx, ty); nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-9)
    k = np.array([0.25, 0.5, 0.25])
    for ax in (0, 1):
        nrm = np.apply_along_axis(lambda v: np.convolve(np.pad(v, 1, mode='edge'), k, 'valid'), ax, nrm)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-9)
    z = Z; d = Y - np.array([edge_y(float(x)) for x in xs])[:, None]
    nz = nrm[..., 2]
    fw = 1.0 - sstep(0.30, 0.88, nz)                        # 1 on walls, 0 on flat plateau / sea floor
    amp = cfg['disp']

    # ── bedding ──
    bz, bhard, brec, box = beds(seed)
    zb = z + 0.055 * X + 1.8 * (fbm(X / 22.0, z / 9.0, seed + 60, 2) - 0.5) * 2 + 0.9 * (vnoise(X / 6.0, z / 2.5, seed + 61) - 0.5)   # bedding dips ~3 deg and undulates
    bi = np.clip(np.searchsorted(-bz, -zb, side='right') - 1, 0, len(bhard) - 1)
    top = bz[bi]; bot = bz[bi + 1]; t = np.clip((top - zb) / np.maximum(top - bot, 1e-3), 0, 1)
    lat = vnoise(X / 18.0, bi * 3.7, seed + 5)               # pinch-out / swell along the wall
    hard = bhard[bi]
    prof = np.where(hard, -0.22 * sstep(0.75, 1.0, t) - 0.04, -1.25 * (1 - t) ** 1.3 * 0.7 - 0.12 * t)
    D = (brec[bi] * (0.35 + 1.3 * lat) + prof * (0.5 + lat)) * 1.0
    pp = sstep(0.35, 0.65, vnoise(X / 9.0, bi * 5.3, seed + 62))                         # parting planes: continuous in some beds, absent in others
    D -= 0.30 * pp * np.exp(-(t / 0.07) ** 2)
    # ── vertical joints + block jogs ──
    jx = np.cumsum(np.random.default_rng(seed + 1).uniform(7, 24, 40)) - 200 + np.random.default_rng(seed + 2).uniform(0, 8)
    jw = np.random.default_rng(seed + 3).uniform(0.9, 1.7, len(jx))
    on = np.random.default_rng(seed + 4).random((len(jx), len(bhard))) < 0.6
    Jc = np.zeros_like(D); jog = np.zeros_like(D)
    cell = np.clip(np.searchsorted(jx, X) - 1, 0, len(jx) - 1)
    jr = np.random.default_rng(seed + 6).normal(0, 0.42, (len(jx) + 1, len(bhard)))
    jog = jr[cell, bi] * (0.5 + 0.8 * hard)
    for jj in range(len(jx)):
        m = np.abs(X - jx[jj]) < 4.0
        if m.any(): Jc -= np.where(m & on[jj][bi], 0.95 * np.exp(-((X - jx[jj]) / jw[jj]) ** 2), 0.0)
    D += Jc + jog
    # ── gullies (water-cut chimneys that feed the talus fans) and a few big protruding shelves ──
    gr_ = np.random.default_rng(seed + 70); gx = np.sort(gr_.uniform(-190, 190, 16)); gd = gr_.uniform(1.0, 2.4, 16); gwid = gr_.uniform(1.6, 3.4, 16)
    gul = np.zeros_like(D)
    for k_ in range(len(gx)):
        xc = gx[k_] + 3.5 * (vnoise(z / 14.0, k_ * 3.1, seed + 71) - 0.5) * 2
        gul -= gd[k_] * np.exp(-((X - xc) / (gwid[k_] * (1.0 + 0.5 * sstep(-30, -55, z)))) ** 2) * sstep(-1.0, -6.0, z)
    D += gul * 0.9
    shelf = np.zeros_like(D); sr_ = np.random.default_rng(seed + 72)
    for k_ in range(14):
        zc = sr_.uniform(-50, -4); xc = sr_.uniform(-170, 170); wl = sr_.uniform(10, 34); th_ = sr_.uniform(0.8, 1.9); ht = sr_.uniform(0.9, 2.2)
        shelf += th_ * sstep(wl, wl * 0.55, np.abs(X - xc)) * np.where(z > zc - 0.0, 0, 1) * np.exp(-((z - zc) / ht) ** 2) * 1.0
        shelf -= 0.8 * th_ * sstep(wl, wl * 0.55, np.abs(X - xc)) * np.exp(-((z - (zc - ht * 1.5)) / (ht * 0.8)) ** 2)   # undercut below the shelf
    D += shelf
    # ── zones ──
    zcol = sstep(-12, -18, z + 4 * (vnoise(X / 9.0, 2.0, seed + 81) - 0.5)) * (1 - sstep(-34, -42, z + 5 * (vnoise(X / 11.0, 5.0, seed + 82) - 0.5)))                                    # columnar bands live in a z-window
    xmask = np.maximum(sstep(0.50, 0.62, vnoise(X / 70.0, 11.0, seed + 8)), sstep(0.35, 0.28, vnoise(X / 70.0, 11.0, seed + 8)))
    xmask = 0.5 * (xmask + sstep(0.45, 0.60, vnoise(X / 55.0, 3.0, seed + 9)))
    colw = np.clip(zcol * (xmask > 0.5) * (np.abs(X) > 18), 0, 1) * fw
    # columnar basalt geometry: 3-4 m rounded prisms, cross-joint steps
    cw = 3.4; cid = np.floor(X / cw + 0.3 * vnoise(z / 9.0, 0.0, seed + 10)); tcol = (X / cw + 0.3 * vnoise(z / 9.0, 0.0, seed + 10)) - cid
    rr = _hash(cid.astype(np.int64), np.zeros_like(cid, dtype=np.int64), seed + 11)
    cD = 0.42 * np.sqrt(np.clip(1 - (2 * tcol - 1) ** 2, 0, 1)) - 0.55 * np.exp(-(np.minimum(tcol, 1 - tcol) / 0.16) ** 2) + (rr - 0.5) * 0.5
    seg = np.floor((z + rr * 7.0) / 2.6); cD += (_hash(seg.astype(np.int64), cid.astype(np.int64), seed + 12) - 0.5) * 0.45
    D = D * (1 - colw) + cD * colw
    # granite exfoliation domes on the flanks
    sh = sstep(88, 112, np.abs(X)) * fw
    dome = (fbm(X / 26.0, z / 17.0, seed + 20, 2) - 0.5) * 3.2
    lvl = np.floor(fbm(X / 40.0, z / 30.0, seed + 21, 2) * 4.0) * 0.35 + sstep(0, 1, (fbm(X / 40.0, z / 30.0, seed + 21, 2) * 4.0) % 1.0) * 0.1
    D = D * (1 - 0.55 * sh) + (dome + lvl) * sh          # flanks keep 45% of the bedding/joint fabric under the granite domes
    # fractal roughness (blocky, fracture-controlled): stronger on soft beds
    rough = (fbm(X / 7.0, z / 4.5, seed + 30, 3) - 0.5) * (0.6 + 0.4 * (~hard)) + (fbm(X / 3.4, z / 3.0, seed + 31, 1) - 0.5) * 0.6
    D += rough
    # talus aprons
    zn = z + 5.0 * (fbm(X / 16.0, z / 8.0, seed + 80, 3) - 0.5) * 2
    tal = sstep(-47, -57, zn) * (0.35 + 0.65 * sstep(0.0, 1.0, 1 - nz))
    fan = np.zeros_like(D)
    for jj in range(0, len(jx), 1):
        m = np.abs(X - jx[jj]) < 14
        if m.any(): fan += np.where(m, 2.4 * np.exp(-((X - jx[jj]) / (5 + 3 * jw[jj])) ** 2), 0.0)
    D = D * (1 - 0.6 * tal) + tal * (fan * 0.9 + (fbm(X / 3.2, z / 3.2, seed + 40, 2) - 0.5) * 1.3)
    # plateau / sea floor: flat, only a trace so the collision plane stays put
    D = D * (fw * 0.92 + 0.08 * (1 - fw) * 0.0)
    # lip: soften the first metre so the rounded macro lip survives
    D *= sstep(-1.5, 1.0, d + 2.5) * 1.0 + 0.0
    D *= amp
    # kill grid-Nyquist aliasing of the displacement ([1 2 1] along both axes; exact zero at the 2-sample wavelength)
    for ax in (0, 1):
        Dp = np.pad(D, [(1, 1) if a_ == ax else (0, 0) for a_ in (0, 1)], mode='edge')
        D = (np.take(Dp, range(0, D.shape[ax]), ax) + 2 * np.take(Dp, range(1, D.shape[ax] + 1), ax) + np.take(Dp, range(2, D.shape[ax] + 2), ax)) / 4.0
    # clearance against the house: displacement may only move outward as far as the nearest house surface allows
    if house_bvh is not None:
        flat = P0.reshape(-1, 3); nn = nrm.reshape(-1, 3); Df = D.reshape(-1).copy()
        for q in np.nonzero(Df > 0.02)[0]:
            hit = house_bvh.find_nearest((float(flat[q, 0]), float(flat[q, 1]), float(flat[q, 2])), 4.0 + float(Df[q]))
            if hit[0] is not None:
                Df[q] = min(Df[q], max(0.0, hit[3] - 0.3))
        D = Df.reshape(D.shape)
    # soft clamp: keep every vertex a sane distance from the macro surface (limits fold-over)
    D = np.clip(D, -2.2, 2.4)
    P = P0 + nrm * D[..., None]
    # ── zone / material ──
    zone = np.zeros((nx, ny), int)                         # 0 strata, 1 columnar, 2 sheet, 3 talus
    zone[colw > 0.5] = 1
    zone[sh > 0.5] = 2
    zone[(nz > 0.74) & (zone != 3)] = 2                   # plateau / flat benches: smooth sheeted pavement
    zone[tal > 0.5] = 3
    print('[cliff_mesh] zone shares', {n: round(float((zone == i).mean()), 3) for i, n in enumerate(mat_names)})
    # ── UV in metres along the true displaced surface; v negative = down the wall (Blender v up) ──
    # u = x (no shear); v = arclength down the *displaced* profile, anchored so v == world z on the vertical wall (first row below z=-3)
    sv = np.concatenate([np.zeros((nx, 1)), np.cumsum(np.linalg.norm(np.diff(P, axis=1), axis=-1), axis=1)], 1)
    hi_ = P[..., 2] > -3.0; anc = np.where(hi_.any(1), ny - 1 - np.argmax(hi_[:, ::-1], axis=1), 0)     # last plateau row = the lip; the wall starts below it
    anc = np.minimum(anc + 1, ny - 1)
    sva = sv[np.arange(nx), anc][:, None]; za = P[np.arange(nx), anc, 2][:, None]
    uv = np.stack([X, za - (sv - sva)], -1)
    # ── macro colour (multiplied into the albedo tile) ──
    Db = D.copy()
    for _ in range(6):                                  # cavity = D minus a wide blur: a 4-neighbour laplacian turns grid noise into a dot at every vertex
        for ax in (0, 1):
            Dp = np.pad(Db, [(1, 1) if a_ == ax else (0, 0) for a_ in (0, 1)], mode='edge')
            Db = (np.take(Dp, range(0, Db.shape[ax]), ax) + 2 * np.take(Dp, range(1, Db.shape[ax] + 1), ax) + np.take(Dp, range(2, Db.shape[ax] + 2), ax)) / 4.0
    cav = D - Db
    ao = np.clip(1.0 + cav * 0.9, 0.6, 1.0)
    streak = sstep(0.62, 0.8, vnoise(X / 1.4, z / 22.0, seed + 50)) * sstep(0.3, 0.7, vnoise(X / 9.0, z / 30.0, seed + 51)) * fw
    ironb = box[bi] * (0.3 + 0.3 * vnoise(X / 12.0, bi * 2.1, seed + 52)) * fw
    lich = sstep(0.64, 0.8, fbm(X / 4.0, z / 3.0, seed + 53, 3)) * sstep(-8, 0, z + 6) * 0.0 + sstep(0.66, 0.84, fbm(X / 5.0, z / 4.0, seed + 54, 3)) * (1 - 0.7 * fw)
    wet = sstep(-52, -62, z) * 0.5 + sstep(-4, -62, z) * 0.0
    dust = sstep(0.55, 0.9, nz) * 0.25 + tal * 0.2
    bedtone = 0.80 + 0.30 * _hash(bi.astype(np.int64), np.zeros_like(bi, dtype=np.int64), seed + 56) * (0.5 + 0.5 * lat)       # non-repeating bed-to-bed tone (the tile itself is flat)
    base = (0.80 + 0.2 * vnoise(X / 35.0, z / 22.0, seed + 55)) * np.where(zone == 0, bedtone, 0.92 + 0.12 * vnoise(X / 5.0, z / 5.0, seed + 57))
    c = np.stack([base, base, base], -1) * ao[..., None]
    c = c * (1 - 0.45 * streak[..., None]) 
    c = c * (1 - 0.5 * ironb[..., None] * np.array([0.0, 0.30, 0.55])[None, None, :])
    c = c * (1 - lich[..., None] * np.array([0.35, 0.05, 0.45])[None, None, :] * 0.8)
    c = c * (1 - 0.35 * wet[..., None])
    c = c + dust[..., None] * np.array([0.10, 0.09, 0.07])
    c = np.clip(c, 0.2, 1.0)
    return dict(P=P, P0=P0, uv=uv, col=c, zone=zone, xs=xs, nrm=nrm, D=D)

def cliff_quads(R, mat_names):
    """yield (pts4, uv4, col4, mat) quads in the same winding build_rock used (CCW from above / outward)"""
    P, uv, col, zone = R['P'], R['uv'], R['col'], R['zone']
    nx, ny = zone.shape[0], zone.shape[1]
    for i in range(nx - 1):
        for j in range(ny - 1):
            ids = ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))
            zz = [zone[a, b] for a, b in ids]; m = max(set(zz), key=zz.count)
            yield [tuple(P[a, b]) for a, b in ids], [tuple(uv[a, b]) for a, b in ids], [tuple(col[a, b]) for a, b in ids], mat_names[m]
