"""Cliff-face tessellation for Ariel's mansion (imported by build_mansion.py inside Blender; pure numpy otherwise).

The old cliff was a 150x100 top-down height grid (2.7 m cells): a vertical wall has no resolution in a top-down grid.  This builds the same macro surface
(rock_h: the architect's coarse terrain incl. the deck / wing carves) as a *profile sweep*: for every x column the macro profile curve (y, z) is re-sampled
by density-weighted arclength, so rows are ~0.5-0.9 u apart ALONG the wall (fine on the face, coarse on the plateau / sea floor), and the rock is displaced
along the (mostly horizontal) wall normal.

(shard pass) The displacement is a structure of straight, angular SHARD ROCK, not organic relief.  Structural analogs only (habit, then built as opaque
weathered stone, never crystal): geode / cave crystal-shard clusters and dogtooth spar (tall prisms packed side by side, each a few planar facets meeting on a
straight ridge), columnar basalt (Giant's Causeway, Devils Tower: vertical prisms with straight cross-joints), cleaved slate / granite joint faces (planar
slabs at offset depths, sloped cleavage cuts).  Two piecewise-PLANAR layers:

  * macro shards (every tier incl. lod1 -> the impostor stays angular): vertical slots 4.5-15 u wide, each slot stacked into tiles 5-18 u tall cut by straight
    sloped cleavage planes (a linear 1.2-3 u bevel = a planar chamfer face, no smoothstep rounding); every tile is a WORLD plane (anchored on the sweep, yawed /
    pitched, -1.8..+2 u proud) and often a prism (two planes meeting on a vertical ridge); V-grooves on some slot seams.
  * fine splinters (hi; mob at reduced strength; not lod1): 0.9-3.4 u vertical splinters 8-30 u long, stepped +-0.55 u in depth, some ridged, V-grooved
    seams (the tight vertical fluting a cleaved / shard-rock face shows at character scale).
  * talus: angular planar blocks (1.6-5 u) over planar scree cones under the grooved seams at the base.

Slot seams are VERTICAL lines in x and the grid columns are vertical lines in x, so every shard side face / ridge / groove lands exactly on a column: the
vertical edges are crisp at any tier and cannot zig-zag.  Cleavage cuts cross the (column-sheared) rows, so they are linear ramps >= 0.5 u (hi) wide instead
of steps.  Outward displacement is clamped against the house (BVH distance) so rock never pokes through a deck / wing / pier.
Also returns per-vertex macro colour (per-shard tone, groove AO, edge wear, wet streaks, lichen, dust) for COLOR_0, and true-surface UVs."""
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

# density in proportion to the ground the rider stands on: the refined ground next to her is 0.40-0.45 u (TESS_TIER high / ultra; 1.78 u = 1 m), so the core
# frontage (x -95..105: deck / landing / facility) keeps 0.5 u columns: every shard seam / ridge / groove is a column, and they are what reads at her scale.
# (shard pass) shard faces are large planes, so rows are a little coarser than v298 (rows 226 -> 196, core_ds 0.5 -> 0.58 u): the cleavage bevels are >= 1 u
# and need ~2 rows, not 4; the plateau / sea floor go coarser (far 5 -> 8 u) and the far flanks finer (far_x 6 -> 3.2 u: the shoreline mass seen from the
# decks has to carry whole shards, not 6 u facets); the saving pays for the split (sharp-edge) normals.  mob gets the same layout one step coarser; lod1 keeps the full macro shard
# layer (macro=1.0) and drops the fine splinters (fine=0) so the far silhouette and the runtime impostor (built from LOD1) stay angular.
TIERS = {
    'hi':  dict(dx=1.0, rows=196, ds=0.95, far=8.0, far_x=3.2, disp=1.0, macro=1.0, core=(-95.0, 105.0), core_dx=0.5, core_ds=0.58, core_z=-22.0, ramp=18.0, fine=1.0, rowf=True),
    'mob': dict(dx=1.5, rows=124, ds=1.15, far=9.0, far_x=5.0, disp=1.0, macro=1.0, core=(-95.0, 105.0), core_dx=1.05, core_ds=0.95, core_z=-22.0, ramp=18.0, fine=0.6, rowf=True),
    'lod1': dict(dx=3.2, rows=58, ds=2.6,  far=12.0, far_x=12.0, disp=0.6, macro=1.0, core=None, fine=0.0, rowf=False),
}

def columns_x(cfg, x0=-200.0, x1=200.0):
    xs = [x0]; core = cfg.get('core')
    while xs[-1] < x1 - 1e-6:
        x = xs[-1]; sp = cfg['dx'] + (cfg['far_x'] - cfg['dx']) * sstep(120, 195, abs(x)) if core else cfg['dx'] + (cfg['far_x'] - cfg['dx']) * sstep(80, 190, abs(x))
        if core:      # fine frontage, feathered over `ramp` u so neighbouring columns never jump more than ~10 %
            dc = max(core[0] - x, x - core[1], 0.0); sp = cfg['core_dx'] + (sp - cfg['core_dx']) * sstep(0.0, cfg['ramp'], dc)
        xs.append(min(x1, x + sp))
    return np.array(xs)

# ───────────────────────── shard layers (piecewise-planar) ─────────────────────────
def shard_set(seed, w=(4.5, 15.0), h=(6.0, 26.0), hmed=12.0, z0=6.0, z1=-80.0, off=(1.1, -2.4, 2.6), tx=0.12, tz=0.06, ridge=(0.55, 0.10, 0.32),
              bev=(1.2, 3.0), slope=0.45, groove=(0.6, 0.0, 0.6, 0.9), rmax=1.8, x0=-215.0, x1=215.0):
    """a deterministic shard layout in wall space (x along the wall, z up).  Slots = vertical strips with straight seams; each slot is cut into tiles by straight
    sloped cleavage planes; each tile is a plane D = o + tx (x - xm) + tz (z - zm) - rk |x - xr| (rk > 0: a prism ridge at xr)."""
    r = np.random.default_rng(seed)
    b = [x0 + r.uniform(0, w[0])]
    while b[-1] < x1: b.append(b[-1] + r.uniform(*w))
    b = np.array(b); K = len(b) - 1; xm = 0.5 * (b[1:] + b[:-1]); wd = b[1:] - b[:-1]
    cuts = []
    for k in range(K):
        zs = [z0 - r.uniform(0, h[0])]; th = []
        while zs[-1] > z1:
            t_ = float(np.clip(r.lognormal(np.log(hmed), 0.5), h[0], h[1])); zs.append(zs[-1] - t_); th.append(t_)
        cuts.append((np.array(zs), np.array(th + [h[0]])))
    C = max(len(c[0]) for c in cuts); T = C + 1
    zc = np.full((K, C), -1e4); sl = np.zeros((K, C)); bw = np.ones((K, C))
    for k, (zs, th) in enumerate(cuts):
        n = len(zs); zc[k, :n] = zs
        gap = np.minimum(th, np.concatenate([[h[1]], th[:-1]]))                       # tile above / below this cut: neighbouring cuts may not cross inside the slot
        smax = np.minimum(slope, 0.35 * gap / max(wd[k], 1e-3))
        sl[k, :n] = r.uniform(-1, 1, n) * smax
        bw[k, :n] = np.minimum(r.uniform(*bev, n), 0.45 * gap)
    o = np.clip(r.normal(0, off[0], (K, T)), off[1], off[2])
    TX = r.uniform(-tx, tx, (K, T)); TZ = r.uniform(-tz, tz, (K, T))
    rk = np.where(r.random((K, T)) < ridge[0], r.uniform(ridge[1], ridge[2], (K, T)), 0.0)
    rk = np.minimum(rk, rmax / (0.8 * wd[:, None]))                                   # the facets fall back at most rmax u at the slot edges
    o = o + rk * wd[:, None] * 0.25                                                    # keep the tile's mean depth where o put it
    rx = xm[:, None] + r.uniform(-0.3, 0.3, (K, T)) * wd[:, None]
    zm = np.concatenate([zc[:, :1] + 4.0, 0.5 * (zc[:, 1:] + zc[:, :-1]), zc[:, -1:] - 4.0], 1)
    zm = np.where(zm < -5e3, -80.0, zm)
    gd = np.where(r.random(K + 1) < groove[0], r.uniform(groove[1], groove[2], K + 1), 0.0)
    return dict(b=b, xm=xm, zc=zc, sl=sl, bw=bw, o=o, tx=TX, tz=TZ, rk=rk, rx=rx, zm=zm, gd=gd, gw=groove[3], tone=r.random((K, T)), kind=r.random(K))

def shard_eval(S, X, z, W=None):
    """D (same shape as X), slot id, tile id.  X / z any shape.  W (optional, see shard_planes): world-plane tiles instead of offsets relative to the macro."""
    b = S['b']; K = len(b) - 1
    k = np.clip(np.searchsorted(b, X, side='right') - 1, 0, K - 1); xr_ = X - S['xm'][k]
    zcut = S['zc'][k] + S['sl'][k] * xr_[..., None]
    dz = z[..., None] - zcut
    cs = np.argmin(np.abs(dz), -1)
    tk = lambda A, t: A[k, t]
    dzs = np.take_along_axis(dz, cs[..., None], -1)[..., 0]; bws = tk(S['bw'], cs)
    wu = np.clip(0.5 + dzs / bws, 0.0, 1.0)            # linear: 1 above the cut (tile cs), 0 below (tile cs + 1) -> a planar chamfer face, crisp creases
    if W is None:
        def plane(t): return tk(S['o'], t) + tk(S['tx'], t) * xr_ + tk(S['tz'], t) * (z - tk(S['zm'], t)) - tk(S['rk'], t) * np.abs(X - tk(S['rx'], t))
    else:
        # WORLD planes: the vertex is moved along its own displacement direction until it lands on the tile's plane, so a tile is truly flat however the
        # macro sweep curves under it; a ridged tile is the intersection of two planes (min = a convex prism edge on a straight line)
        P0_, dd_ = W['P0'], W['ddir']
        def onp(Q, Nn):
            num = ((Q - P0_) * Nn).sum(-1); den = np.maximum((dd_ * Nn).sum(-1), 0.3); return num / den
        def rel(t): return tk(S['o'], t) + tk(S['tx'], t) * xr_ + tk(S['tz'], t) * (z - tk(S['zm'], t)) - tk(S['rk'], t) * np.abs(X - tk(S['rx'], t))
        def plane(t):
            Q = W['Q'][k, t]; NL_ = W['NL'][k, t]; Dp = np.minimum(onp(Q, NL_), onp(Q, W['NR'][k, t]))
            # only on the face the tile was anchored on (inland embankment / carve walls face elsewhere) and only while the plane stays near the sweep:
            # beyond that the tile falls back to the relative facet (same offset / tilt), so nothing is pulled metres off the macro surface
            wq = sstep(0.5, 0.7, (W['nrm'] * W['NA'][k, t]).sum(-1)) * (1.0 - sstep(3.4, 4.6, np.abs(Dp)))
            return wq * np.clip(Dp, -4.6, 4.6) + (1 - wq) * rel(t)
    D = wu * plane(cs) + (1 - wu) * plane(cs + 1)
    tid = np.where(wu >= 0.5, cs, cs + 1)
    dl = X - b[k]; dr = b[k + 1] - X                     # V-groove on the seams (lands on the grid columns either side)
    D -= S['gd'][k] * np.clip(1 - dl / S['gw'], 0, 1) + S['gd'][k + 1] * np.clip(1 - dr / S['gw'], 0, 1)
    return D, k, tid

def shard_planes(S, xs, P0, nrm, fw, P0full, ddir, face, yaw=0.20, pitch=0.10):
    """anchor every macro tile on the sweep: Q = macro point at (ridge x, tile mid z) pushed out by the tile offset; NL / NR = the macro normal there yawed
    (+-ridge) / pitched by the tile's random tilt.  Tiles that never reach the wall get the nearest wall anchor (they are multiplied by fw = 0 anyway)."""
    K, T = S['o'].shape; Q = np.zeros((K, T, 3)); NL = np.zeros((K, T, 3)); NR = np.zeros((K, T, 3)); NA = np.zeros((K, T, 3))
    r = np.random.default_rng(int(S['b'][0] * 1000) & 0xFFFF)
    a = r.uniform(-yaw, yaw, (K, T)); b = r.uniform(-pitch, pitch, (K, T)); rr = np.where(S['rk'] > 0, r.uniform(0.18, 0.45, (K, T)), 0.0)
    up = np.array([0.0, 0.0, 1.0])
    for k in range(K):
        for t in range(T):
            ic = int(np.argmin(np.abs(xs - S['rx'][k, t])))
            zc_ = float(np.clip(S['zm'][k, t], -58.0, -2.0))
            cost = np.abs(P0[ic, :, 2] - zc_) + 1e3 * (~face[ic])
            j = int(np.argmin(cost)); nA = nrm[ic, j].copy()
            if not face[ic, j]: nA = np.array([0.0, 1.0, 0.0])
            NA[k, t] = nA
            nA[2] *= 0.5; nA /= np.linalg.norm(nA)                       # shard faces stand steeper than the leaning sweep
            Tx = np.cross(nA, up); Tx /= max(np.linalg.norm(Tx), 1e-6); U = np.cross(Tx, nA)
            Q[k, t] = P0[ic, j] + ddir[ic, j] * S['o'][k, t]
            for arr, sg in ((NL, -1.0), (NR, 1.0)):
                n_ = nA + (a[k, t] + sg * rr[k, t]) * Tx + b[k, t] * U; arr[k, t] = n_ / np.linalg.norm(n_)
    return dict(Q=Q, NL=NL, NR=NR, NA=NA, P0=P0full, ddir=ddir, nrm=nrm)

def build_cliff(rock_h, edge_y, tier='hi', house_bvh=None, sea=-62.0, seed=1234, yr=(-125.0, 125.0), mat_names=('rock', 'rockc', 'rocks', 'rockt')):
    """returns dict: P (nx,ny,3) world positions, uv (nx,ny,2) metres, col (nx,ny,3) 0..1, zone (nx,ny) int 0..3 (index into mat_names), tris count"""
    cfg = TIERS[tier]; xs = columns_x(cfg); nx = len(xs); ny = cfg['rows']
    ysamp = np.arange(yr[0], yr[1] + 1e-9, 0.25)
    Y = np.zeros((nx, ny)); Z = np.zeros((nx, ny)); need_rows = []
    for i, x in enumerate(xs):
        zs = np.array([rock_h(float(x), float(y)) for y in ysamp])
        d = ysamp - edge_y(float(x))
        # target spacing: fine on the face (and just behind the lip), coarse on plateau / sea floor
        dist_out = np.maximum(np.maximum(-6.0 - d, d - 42.0), 0.0)
        sp = cfg['ds'] + (cfg['far'] - cfg['ds']) * sstep(0.0, 28.0, dist_out)
        if cfg.get('core'):      # upper wall (decks, landing pads, facility look down on it) at core_ds, feathered in z.  Deliberately the SAME in every column: the row
            # count is global, so a per-column density would only shear row j between neighbouring columns (zig-zag 'teeth' at the core edge), and costs no extra rows
            wz_ = sstep(cfg['core_z'] - 8.0, cfg['core_z'], zs) * (1.0 - sstep(0.0, 18.0, dist_out))
            sp = sp + (np.minimum(sp, cfg['core_ds']) - sp) * wz_
        sp = np.where(zs < sea - 5.0, np.maximum(sp, cfg['far'] * 0.7), sp)
        seg = np.hypot(np.diff(ysamp), np.diff(zs)); w = 1.0 / (0.5 * (sp[1:] + sp[:-1]))
        I = np.concatenate([[0], np.cumsum(seg * w)])
        tgt = np.linspace(0, I[-1], ny); need_rows.append(I[-1])
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
    fws = 1.0 - sstep(0.55, 0.86, nz)                       # (shard pass) the shards run further down the leaning lower wall before they fade out

    # ── shard layers (deterministic in world x / z, so hi / mob / lod1 share one layout and LOD switches do not pop the silhouette) ──
    SM = shard_set(seed + 101, h=(5.0, 18.0), hmed=10.0, off=(0.9, -1.8, 2.0))
    SF = shard_set(seed + 202, w=(0.9, 3.4), h=(8.0, 30.0), hmed=16.0, off=(0.26, -0.55, 0.55), tx=0.05, tz=0.0, ridge=(0.35, 0.06, 0.2), bev=(0.8, 1.6),
                   slope=0.3, groove=(0.45, 0.06, 0.25, 0.4), rmax=0.3)      # vertical splinters / fluting: long, straight, stepped only in depth
    ST = shard_set(seed + 303, w=(1.6, 5.0), h=(1.6, 4.5), hmed=2.6, z0=-30.0, off=(0.55, -1.2, 1.3), tx=0.18, tz=0.15, ridge=(0.35, 0.10, 0.35), bev=(0.4, 0.9),
                   slope=0.6, groove=(0.3, 0.05, 0.25, 0.5), rmax=0.8)
    ddir = nrm.copy(); ddir[..., 2] *= (1.0 - 0.85 * fw); ddir /= np.maximum(np.linalg.norm(ddir, axis=-1, keepdims=True), 1e-9)
    face = (fw > 0.5) & (d > -6.0) & (d < 40.0) & (nrm[..., 1] > 0.3)      # the seaward cliff (not the inland embankment / carve back-walls)
    WP = shard_planes(SM, xs, P0, nrm, fw, P0, ddir, face)
    M, kM, tM = shard_eval(SM, X, z, WP)
    print('[cliff_mesh] macro plane D p1/p50/p99', np.round(np.percentile(M[fw > 0.5], [1, 50, 99]), 2), '|D|>3 share', round(float((np.abs(M) > 3.0)[face].mean()), 3))
    Fd, kF, tF = shard_eval(SF, X, z)
    Tb, kT, tT = shard_eval(ST, X, z)
    # talus aprons (the base): angular blocks over the broad rubble fans under the big seams
    zn = z + 4.0 * (vnoise(X / 16.0, 0.5, seed + 80) - 0.5) * 2
    tal = sstep(-47, -57, zn) * (0.35 + 0.65 * sstep(0.0, 1.0, 1 - nz))
    sb = SM['b']; fan = np.zeros_like(z)
    for jj in range(len(sb)):
        if SM['gd'][jj] <= 0: continue
        m = np.abs(X - sb[jj]) < 14
        if m.any(): fan += np.where(m, 2.0 * np.clip(1.0 - np.abs(X - sb[jj]) / 9.0, 0.0, 1.0), 0.0)     # a planar scree cone (two flat flanks), not a bump
    amp = cfg['disp']
    D = M * cfg.get('macro', 1.0) + Fd * cfg.get('fine', 0.0)
    D = D * (1 - 0.7 * tal) + tal * (fan * 0.8 + Tb * (0.6 + 0.4 * amp))
    D = D * fws
    # lip: soften the first metre so the plateau edge (HOME / landing approach) stays put
    D *= sstep(-1.5, 1.0, d + 2.5)
    # SHEAR-AWARE smoothing.  Rows are equal weighted-arclength steps from the inland edge, so where a deck carve differs between neighbouring columns, row j sits
    # several row spacings higher in one column than the next.  A cleavage bevel then crosses those sheared quads on their long diagonal (teeth).  Where the shear
    # is large the field is blurred across columns (the grid cannot carry a cut there anyway); well-aligned quads keep every crisp edge.
    rs_ = np.maximum(np.linalg.norm(np.diff(P0, axis=1), axis=-1), 1e-3); rs_ = np.concatenate([rs_, rs_[:, -1:]], 1)
    sh_ = np.abs(np.diff(P0[..., 2], axis=0)) / np.minimum(rs_[1:], rs_[:-1]); sh_ = np.maximum(np.concatenate([sh_, sh_[-1:]], 0), np.concatenate([sh_[:1], sh_], 0))
    wsh = sstep(0.8, 2.5, sh_) * fw
    for _ in range(4):
        Dp = np.pad(D, [(1, 1), (0, 0)], mode='edge'); Dbx = (Dp[:-2] + 2 * D + Dp[2:]) / 4.0
        Dp = np.pad(D, [(0, 0), (1, 1)], mode='edge'); Dby = (Dp[:, :-2] + 2 * D + Dp[:, 2:]) / 4.0
        D = D + wsh * (0.5 * (Dbx + Dby) - D)
    # anti-alias along the ROWS only ([1 2 1]): the bevels are linear ramps, so this just rounds a crease by a few cm; across columns nothing is filtered (the
    # seams / ridges / grooves sit on the columns and must stay crisp)
    if cfg.get('rowf'):
        Dp = np.pad(D, [(0, 0), (1, 1)], mode='edge'); D = (Dp[:, :-2] + 2 * D + Dp[:, 2:]) / 4.0
    # clearance against the house: displacement may only move outward as far as the nearest house surface allows
    if house_bvh is not None:
        flat = P0.reshape(-1, 3); Df = D.reshape(-1).copy()
        for q in np.nonzero(Df > 0.02)[0]:
            hit = house_bvh.find_nearest((float(flat[q, 0]), float(flat[q, 1]), float(flat[q, 2])), 4.0 + float(Df[q]))
            if hit[0] is not None:
                Df[q] = min(Df[q], max(0.0, hit[3] - 0.3))
        D = Df.reshape(D.shape)
    D = np.clip(D, -4.4, 4.6)
    # displacement DIRECTION: along the macro normal with its vertical part mostly removed on walls (a shard face is a vertical-ish plane; pushing along a leaning
    # wall's normal would also move vertices up / down and drag rows over each other).  Plateau / sea floor (fw = 0) keep the true normal.
    # (shard pass) LIP GUARD: next to the plateau (macro z > -6) no shard may rise above the plateau (the displacement direction loses any upward part there) and
    # recesses are capped at 0.8 u at the lip itself (full depth by z = -6), so the walkable edge / HOME approach / lamp levels keep the v298 footprint
    zl = P0[..., 2]
    ddir[..., 2] = np.where(zl > -6.0, np.minimum(ddir[..., 2], 0.0), ddir[..., 2]); ddir /= np.maximum(np.linalg.norm(ddir, axis=-1, keepdims=True), 1e-9)
    D = np.maximum(D, -(0.8 + 3.6 * sstep(-1.0, -6.0, zl)))
    P = P0 + ddir * D[..., None]
    # fold-over guard: a displaced quad whose normal turns past ~88 deg from the macro normal is flipped / degenerate (a 'tooth'); blend its corners toward a local
    # average (a few passes).  Shard SIDE faces sit at 60-85 deg by design and are left alone (the v298 80 deg threshold would round every seam).
    def _flip(P_):
        a_ = P_[1:, :-1] - P_[:-1, :-1]; b_ = P_[:-1, 1:] - P_[:-1, :-1]; fn_ = np.cross(a_, b_)
        fn_ /= np.maximum(np.linalg.norm(fn_, axis=-1, keepdims=True), 1e-9)
        return (fn_ * nrm[:-1, :-1]).sum(-1) < 0.035
    bad0 = _flip(P0)                                   # quads already degenerate in the MACRO sweep (vertical deck-carve walls at the lip): not the shards' doing
    for it_ in range(60):
        bad = _flip(P) & ~bad0
        if it_ == 0: print('[cliff_mesh] fold-over quads before guard', int(bad.sum()), '(macro sweep itself:', int(bad0.sum()), ')')
        if not bad.any(): break
        mk_ = np.zeros(D.shape, bool); mk_[:-1, :-1] |= bad; mk_[1:, :-1] |= bad; mk_[:-1, 1:] |= bad; mk_[1:, 1:] |= bad
        Dp = np.pad(D, 1, mode='edge'); Dav = (Dp[:-2, 1:-1] + Dp[2:, 1:-1] + Dp[1:-1, :-2] + Dp[1:-1, 2:]) * 0.25
        D = np.where(mk_, 0.35 * D + 0.65 * Dav, D) if it_ < 20 else np.where(mk_, 0.6 * D, D)     # then fall back toward the macro surface
        P = P0 + ddir * D[..., None]
    print('[cliff_mesh] fold-over quads left', int(bad.sum()))
    # ── zone / material ──  0 cleaved slab (main wall), 1 prism shards (a share of the macro slots), 2 joint-face pavement (plateau / benches), 3 talus blocks
    zone = np.zeros((nx, ny), int)
    zone[(SM['kind'][kM] < 0.38) & (fw > 0.5)] = 1
    zone[(nz > 0.74)] = 2
    zone[tal > 0.5] = 3
    print('[cliff_mesh] tier', tier, 'cols', nx, 'rows', ny, 'rows needed for target spacing (max column)', int(max(need_rows)) + 1)
    print('[cliff_mesh] zone shares', {n: round(float((zone == i).mean()), 3) for i, n in enumerate(mat_names)})
    print('[cliff_mesh] D range', round(float(D.min()), 2), round(float(D.max()), 2))
    # ── UV in metres along the true surface; v negative = down the wall (Blender v up) ──
    # v = arclength down the MACRO profile (P0 + the macro shards), anchored so v == world z on the vertical wall (first row below z=-3): the fine splinters would add a
    # different extra length in every column and shear the maps.  u = world x (no shear), so the maps' straight vertical seams / grooves stay straight and parallel
    # to the shard seams; a seam side face takes one stretched texel column, which reads as the same vertical grain.
    Pm_ = P0 + ddir * np.clip(M * cfg.get('macro', 1.0) * fws, -4.4, 4.6)[..., None]
    sv = np.concatenate([np.zeros((nx, 1)), np.cumsum(np.linalg.norm(np.diff(Pm_, axis=1), axis=-1), axis=1)], 1)
    hi_ = P[..., 2] > -3.0; anc = np.where(hi_.any(1), ny - 1 - np.argmax(hi_[:, ::-1], axis=1), 0)     # last plateau row = the lip; the wall starts below it
    anc = np.minimum(anc + 1, ny - 1)
    sva = sv[np.arange(nx), anc][:, None]; za = P[np.arange(nx), anc, 2][:, None]
    uv = np.stack([X, za - (sv - sva)], -1)
    # ── macro colour (multiplied into the albedo tile) ──
    Db = D.copy()
    for _ in range(4):                                  # cavity = D minus a blur: seams / grooves / recessed tiles darker, proud shard edges a touch lighter (edge wear)
        for ax in (0, 1):
            Dp = np.pad(Db, [(1, 1) if a_ == ax else (0, 0) for a_ in (0, 1)], mode='edge')
            Db = (np.take(Dp, range(0, Db.shape[ax]), ax) + 2 * np.take(Dp, range(1, Db.shape[ax] + 1), ax) + np.take(Dp, range(2, Db.shape[ax] + 2), ax)) / 4.0
    cav = D - Db
    ao = np.clip(1.0 + cav * 0.55, 0.62, 1.07)
    streak = sstep(0.62, 0.8, vnoise(X / 1.4, z / 22.0, seed + 50)) * sstep(0.3, 0.7, vnoise(X / 9.0, z / 30.0, seed + 51)) * fw
    lich = sstep(0.66, 0.84, fbm(X / 5.0, z / 4.0, seed + 54, 3)) * (1 - 0.7 * fw)
    wet = sstep(-52, -62, z) * 0.5
    dust = sstep(0.55, 0.9, nz) * 0.25 + tal * 0.2
    tone = SM['tone'][kM, np.clip(tM, 0, SM['tone'].shape[1] - 1)]          # every macro shard its own weathered tone, finer splinters +-
    ftone = SF['tone'][kF, np.clip(tF, 0, SF['tone'].shape[1] - 1)]
    base = (0.84 + 0.14 * vnoise(X / 35.0, z / 22.0, seed + 55)) * (0.84 + 0.24 * tone) * (0.95 + 0.10 * ftone * cfg.get('fine', 0.0) + 0.05 * (1 - cfg.get('fine', 0.0)))
    c = np.stack([base, base, base], -1) * ao[..., None]
    c = c * (1 - 0.40 * streak[..., None])
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
