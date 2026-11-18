"""Derived Emma-specific clips built from already-retargeted clips (all in the TARGET skeleton space):
slices of Regular_Jump / climbing_up_wall, ping-pong loops, in-place swim, pivot turns."""
import sys, os; sys.path.insert(0, os.path.dirname(__file__))
from glbtk import *

FPS = 30
def _grid(t0, t1): n = max(2, int(round((t1-t0)*FPS))+1); return np.linspace(t0, t1, n)

def sample(clip, tt):
    rot = {n: qfix(resample(clip['t'], q, tt, quat=True)) for n, q in clip['rot'].items()}
    return {'rot': rot, 'hips': resample(clip['t'], clip['hips'], tt)}

def make(clip, tt, name_info=None):
    s = sample(clip, tt); T = len(tt)
    return {'t': np.linspace(0, tt[-1]-tt[0], T), 'rot': s['rot'], 'hips': s['hips'], 'dur': tt[-1]-tt[0], 'info': name_info or {}}

def slice_clip(clip, t0, t1, info=None): return make(clip, _grid(t0, t1), info)

def pingpong(clip, t0, t1, info=None):
    """forward t0..t1 then back to t0 -> seamless loop (first == last frame)"""
    tt = _grid(t0, t1); c = make(clip, tt)
    def pp(a): return np.concatenate([a, a[-2:0:-1]], 0)
    T = len(tt) + len(tt) - 2
    return {'t': np.arange(T)/FPS, 'rot': {n: pp(q) for n, q in c['rot'].items()}, 'hips': pp(c['hips']) - np.array([0,0,0]), 'dur': (T-1)/FPS, 'info': info or {}}

def in_place(clip, up_axis_target, info=None):
    """remove horizontal root travel (keep vertical bob)"""
    h = clip['hips'].copy(); up = up_axis_target/np.linalg.norm(up_axis_target)
    d = h - h[0]; vert = np.outer(d @ up, up); h2 = h[0] + vert
    return {'t': clip['t'].copy(), 'rot': {n: q.copy() for n, q in clip['rot'].items()}, 'hips': h2, 'dur': clip['dur'], 'info': info or {}}

def ease(x): x = np.clip(x, 0, 1); return x*x*(3-2*x)

def pivot_turn(idle, SB, up_world, total_deg, dur=0.8, info=None):
    """stylised in-place pivot: hips lead by yaw, spine/neck/head follow with growing lead (head looks first).  world-yaw about `up_world`
    applied to the chain; every other bone keeps its local rotation so it rides along."""
    tt = np.arange(int(round(dur*FPS))+1)/FPS; T = len(tt)
    cl = make(idle, np.minimum(tt, idle['dur'])) if idle['dur'] < dur else make(idle, tt)
    leads = {'Hips': -0.10, 'Spine': -0.05, 'Spine01': 0.0, 'Spine02': 0.05, 'neck': 0.10, 'Head': 0.18}
    th = {n: np.radians(total_deg)*ease((tt - dur*0.1 + l)/(dur*0.8)) for n, l in leads.items()}
    ax = up_world/np.linalg.norm(up_world)
    # world-space FK over the whole skeleton with yaw offsets
    names = {SB.names[i]: i for i in SB.order}
    W0 = {}; W1 = {}; rot = {}
    def pw0(i): return mat_to_quat(SB.W[SB.par[i]][:3,:3]/np.linalg.norm(SB.W[SB.par[i]][:3,:3],axis=0)) if i in SB.par else np.array([0,0,0,1.])
    for i in SB.order:
        n = SB.names[i]; L = cl['rot'].get(n, np.tile(SB.trs[i][1], (T,1)))
        if i in SB.par and SB.par[i] in W0: W0[i] = qmul(W0[SB.par[i]], L)
        else: W0[i] = qmul(np.tile(pw0(i), (T,1)), L)
        yaw = th.get(n)
        W1[i] = qmul(np.stack([qaxis_angle(ax, a) for a in yaw]), W0[i]) if yaw is not None else (qmul(W1[SB.par[i]], L) if i in SB.par and SB.par[i] in W1 else W0[i])
        # for a bone not in `leads`, its parent chain already yawed: use parent's new world * own local
        if yaw is None and i in SB.par and SB.par[i] in W1: W1[i] = qmul(W1[SB.par[i]], L)
        pq = W1[SB.par[i]] if i in SB.par and SB.par[i] in W1 else np.tile(pw0(i), (T,1))
        rot[n] = qfix(qnorm(qmul(qinv(pq), W1[i])))
    return {'t': tt, 'rot': rot, 'hips': cl['hips'], 'dur': dur, 'info': info or {}}
