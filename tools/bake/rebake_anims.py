#!/usr/bin/env python3
"""rebake_anims.py — rebuild Autumn/Ariel's mount / dismount / jump / climb / rope / cliff loops.

  python3 tools/bake/rebake_anims.py IN.glb OUT.glb [--report]

What it does per target clip (numpy only, no Blender):
  1. re-times the source clip through a monotone (PCHIP) time warp, so the hop is a natural speed
     instead of the game speeding a 1.9 s jump up 2.4x; resamples to 60 fps (source is 30 fps, linear).
  2. smooths every rotation track (hemisphere-aligned quaternion Gaussian, sigma in 60 fps frames) and the hips
     translation: removes the 30 fps stair-stepping / micro-pops. Constant tracks collapse to two keys.
  3. retargets amplitudes to her proportions: limb deltas from the first-frame pose are slerp-scaled
     (arms / legs / spine / head separately); the hips' vertical excursion is split into crouch (down) and
     rise (up) so a clip made for a 0.4-body-height jump can become a 0.07 step onto a board, or a jump that
     leaves the vertical travel to the game's physics (the root already rises, so the clip must not double it).
  4. moves rotation to the shoulder / hip chains: swing-twist about each bone's rest axis; ForeArm / Leg twist is
     scaled down and half of what was removed is handed to the Arm / UpLeg (and Arm -> Shoulder), which is what
     stops the forearm "candy wrapper" folding in the skin.
  5. strips root X/Z drift (the game owns locomotion) and re-emits a de-duplicated GLB (same nodes, same skin).
"""
import sys, json, struct, hashlib, math
import numpy as np

# ---------------------------------------------------------------- glb io
def load(path):
    f = open(path, 'rb').read(); l = struct.unpack('<I', f[12:16])[0]; j = json.loads(f[20:20 + l]); b = f[20 + l + 8:]
    def acc(i):
        a = j['accessors'][i]; v = j['bufferViews'][a['bufferView']]
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
        dt = {5126: np.float32, 5123: np.uint16, 5121: np.uint8, 5125: np.uint32}[a['componentType']]
        off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        raw = np.frombuffer(b, dt, a['count'] * n, off).copy()
        r = raw.reshape(a['count'], n) if n > 1 else raw
        if a.get('normalized') and dt != np.float32: r = r.astype(np.float32) / np.iinfo(dt).max
        return r.astype(np.float32)
    return j, acc

# ---------------------------------------------------------------- quaternion helpers (x,y,z,w)
def qmul(a, b):
    ax, ay, az, aw = np.moveaxis(a, -1, 0); bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx, aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz], -1)
def qconj(q): return q * np.array([-1, -1, -1, 1], np.float64)
def qnorm(q): return q / np.maximum(np.linalg.norm(q, axis=-1, keepdims=True), 1e-12)
def qaxis(axis, ang):
    ang = np.asarray(ang, np.float64); s = np.sin(ang * .5)[..., None]
    return np.concatenate([np.asarray(axis, np.float64) * s, np.cos(ang * .5)[..., None]], -1)
def qslerp(a, b, t):
    a = np.broadcast_to(a, np.broadcast(a, b).shape).astype(np.float64); b = b.astype(np.float64)
    d = (a * b).sum(-1, keepdims=True); b = np.where(d < 0, -b, b); d = np.abs(d).clip(0, 1)
    th = np.arccos(d); s = np.sin(th); t = np.asarray(t, np.float64)
    wa = np.where(s < 1e-6, 1 - t, np.sin((1 - t) * th) / np.maximum(s, 1e-12)); wb = np.where(s < 1e-6, t, np.sin(t * th) / np.maximum(s, 1e-12))
    return qnorm(a * wa + b * wb)
def align(Q):  # make a (T,4) quaternion track hemisphere-continuous
    Q = Q.copy()
    for i in range(1, len(Q)):
        if (Q[i] * Q[i-1]).sum() < 0: Q[i] = -Q[i]
    return Q
def gauss(X, sigma):
    if sigma <= 0 or len(X) < 3: return X
    r = int(math.ceil(sigma * 3)); k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    P = np.pad(X, [(r, r)] + [(0, 0)] * (X.ndim - 1), mode='edge'); out = np.zeros_like(X, dtype=np.float64)
    for i, w in enumerate(k): out += w * P[i:i + len(X)]
    return out
def median3(X):
    P = np.pad(X, [(1, 1)] + [(0, 0)] * (X.ndim - 1), mode='edge'); return np.median(np.stack([P[:-2], P[1:-1], P[2:]]), 0)

def pchip(xs, ys):
    """monotone cubic Hermite through (xs, ys): returns f(x) (numpy)."""
    xs = np.asarray(xs, float); ys = np.asarray(ys, float); h = np.diff(xs); d = np.diff(ys) / h; m = np.zeros_like(ys)
    for i in range(1, len(xs) - 1):
        if d[i-1] * d[i] > 0:
            w1 = 2 * h[i] + h[i-1]; w2 = h[i] + 2 * h[i-1]; m[i] = (w1 + w2) / (w1 / d[i-1] + w2 / d[i])
    m[0] = d[0] * 0.5; m[-1] = d[-1] * 0.5     # soft ends: no velocity pop at start / end
    def f(x):
        x = np.clip(x, xs[0], xs[-1]); k = np.clip(np.searchsorted(xs, x, side='right') - 1, 0, len(xs) - 2)
        t = (x - xs[k]) / h[k]; t2 = t * t; t3 = t2 * t
        return (2*t3 - 3*t2 + 1) * ys[k] + (t3 - 2*t2 + t) * h[k] * m[k] + (-2*t3 + 3*t2) * ys[k+1] + (t3 - t2) * h[k] * m[k+1]
    return f

# ---------------------------------------------------------------- rig
class Rig:
    def __init__(s, j, acc):
        s.j = j; s.acc = acc; s.nodes = j['nodes']; s.names = [n['name'] for n in s.nodes]; s.ix = {n: i for i, n in enumerate(s.names)}
        s.rq = np.array([n.get('rotation', [0, 0, 0, 1]) for n in s.nodes], np.float64); s.rt = np.array([n.get('translation', [0, 0, 0]) for n in s.nodes], np.float64)
        s.anims = {a['name']: a for a in j['animations']}
    def tracks(s, name):
        a = s.anims[name]; out = {}
        for c in a['channels']:
            sm = a['samplers'][c['sampler']]; out[(c['target']['node'], c['target']['path'])] = (s.acc(sm['input']).astype(np.float64), s.acc(sm['output']).astype(np.float64), sm.get('interpolation', 'LINEAR'))
        return out
    def axis(s, bone, child):  # rest bone axis (unit, in the bone's frame): direction to its child
        t = s.rt[s.ix[child]]; return t / np.linalg.norm(t)

def sample_track(t, v, path, S):
    if len(t) == 1: return np.repeat(v[:1], len(S), 0)
    k = np.clip(np.searchsorted(t, S, side='right') - 1, 0, len(t) - 2); f = np.clip((S - t[k]) / (t[k+1] - t[k]), 0, 1)[:, None]
    a, c = v[k], v[k+1]
    if path == 'rotation': return qslerp(a, c, f)
    return a + (c - a) * f

# ---------------------------------------------------------------- the bake
ARM = ('Shoulder', 'Arm', 'ForeArm', 'Hand'); LEG = ('UpLeg', 'Leg', 'Foot', 'FootBig', 'Toe')
def group(name):
    if name == 'Hips': return 'hips'
    if any(name.endswith(x) or x in name for x in ('Shoulder', 'Arm', 'ForeArm')) and 'Hair' not in name: return 'arm'
    if name in ('LeftHand', 'RightHand') or name.startswith(('LeftHand', 'RightHand')): return 'hand'
    if 'UpLeg' in name or name.endswith(('LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot')): return 'leg'
    if name in ('Spine', 'Spine01', 'Spine02'): return 'spine'
    if name in ('neck', 'Head'): return 'head'
    return 'other'

def bake(rig, spec, fps=60):
    tr = rig.tracks(spec['src']); dur_src = max(t[-1] for t, _, _ in tr.values())
    wk = spec.get('warp'); D = spec.get('dur') or (wk[1][-1] if wk else dur_src)
    n = int(round(D * fps)) + 1; U = np.arange(n) / fps
    S = pchip(*wk)(U) if wk else np.minimum(U, dur_src)
    ref = spec.get('ref', 0.0); sig = spec.get('sigma', 1.6)
    Q = {}; P = {}
    for (nd, path), (t, v, interp) in tr.items():
        if path == 'scale': continue
        if path == 'rotation': Q[nd] = sample_track(t, v, 'rotation', S); Q[nd] = qnorm(gauss(align(median3(align(Q[nd]))), sig))
        else: P[nd] = sample_track(t, v, 'translation', S)
    Qr = {nd: sample_track(*tr[(nd, 'rotation')][:2], 'rotation', np.array([ref]))[0] for nd in Q}
    k = spec['k']
    for nd in Q:  # amplitude retarget (slerp from the reference pose)
        g = group(rig.names[nd]); kk = k.get(g, k.get('other', 1.0))
        if kk != 1.0: Q[nd] = qslerp(np.broadcast_to(Qr[nd], Q[nd].shape), Q[nd], kk)
    # hips: crouch / rise split, XZ strip
    hp = rig.ix['Hips']
    if hp in P:
        H = gauss(P[hp], sig); h0 = P[hp][int(round(ref * 0)) if False else 0]
        r0 = sample_track(*tr[(hp, 'translation')][:2], 'translation', np.array([ref]))[0]; d = H[:, 1] - r0[1]
        d = np.where(d < 0, d * spec.get('crouch', 1.0), d * spec.get('rise', 1.0)); H[:, 1] = r0[1] + d
        H[:, 0] = r0[0] + (H[:, 0] - r0[0]) * spec.get('xz', 0.0); H[:, 2] = r0[2] + (H[:, 2] - r0[2]) * spec.get('xz', 0.0)
        P[hp] = H
    for nd in P:
        if nd != hp: P[nd] = np.repeat(P[nd][:1], n, 0)    # bone offsets are constant in this rig
    # twist redistribution: (bone, child-for-axis, keep, give-to-parent-fraction-of-removed)
    for side in ('Left', 'Right'):
        for bone, child, parent, keep, give in (('Leg', 'Foot', 'UpLeg', spec.get('twLeg', .4), .55), ('ForeArm', 'Hand', 'Arm', spec.get('twFore', .4), .55), ('Arm', 'ForeArm', 'Shoulder', spec.get('twArm', .8), .5)):
            b, p = rig.ix[side + bone], rig.ix[side + parent]
            if b not in Q or p not in Q: continue
            a = rig.axis(side + bone, side + child); ap = rig.axis(side + parent, side + bone)
            dq = qmul(qconj(rig.rq[b])[None], Q[b])                    # delta in the bone's own frame
            ang = 2 * np.arctan2((dq[:, :3] @ a), dq[:, 3])             # signed twist about the rest axis
            ang = (ang + np.pi) % (2 * np.pi) - np.pi
            tw = qaxis(a, ang); sw = qmul(dq, qconj(tw))
            Q[b] = qnorm(qmul(rig.rq[b][None], qmul(sw, qaxis(a, ang * keep))))
            Q[p] = qnorm(qmul(Q[p], qaxis(ap, ang * (1 - keep) * give)))    # delta_p * twist_p (innermost)
    for nd in Q: Q[nd] = qnorm(gauss(align(Q[nd]), 0.8))              # final polish after redistribution
    return U, Q, P

def collapse(U, V, eps=1e-6):
    return (U[[0, -1]], V[[0, -1]]) if np.abs(V - V[0]).max() < eps else (U, V)

# ---------------------------------------------------------------- spec table
# warp: (source seconds -> output seconds); k: slerp factor per group; crouch / rise: hips Y scale (down / up).
SPECS = {
  # a step onto the deck (~0.08 body heights up). Source Regular_Jump: crouch 0.2-0.3, take-off 0.55, land 1.05.
  'Mount_Step': dict(src='Regular_Jump', warp=([0, .20, .32, .55, .80, 1.05, 1.30, 1.90], [0, .14, .26, .42, .52, .62, .80, 1.15]),
                     k=dict(arm=.45, hand=.6, leg=.6, spine=.55, head=.6, other=.8), crouch=.5, rise=.14, xz=0, sigma=2.0),
  # stepping off: a lower, softer landing, shorter anticipation
  'Dismount_Step': dict(src='Regular_Jump', warp=([0, .20, .32, .55, .80, 1.05, 1.30, 1.90], [0, .10, .20, .34, .43, .52, .70, 1.05]),
                     k=dict(arm=.4, hand=.6, leg=.55, spine=.5, head=.6, other=.8), crouch=.45, rise=.1, xz=0, sigma=2.0),
  # in-game jump: the root already rises with the physics (apex ~0.56 body heights), so the clip keeps the crouch,
  # the take-off extension, a tuck and the landing absorption but NOT a second ~0.4-height hips rise on top.
  # The air portion (0.55-1.05 src) is stretched to 0.8 s; the game scales playback to the real air time.
  'Regular_Jump': dict(src='Regular_Jump', warp=([0, .20, .32, .55, .80, 1.05, 1.30, 1.90], [0, .13, .24, .38, .78, 1.18, 1.42, 1.80]),
                     k=dict(arm=.65, hand=.75, leg=.85, spine=.8, head=.8, other=1.0), crouch=.75, rise=.06, xz=0, sigma=2.0),
  'climbing_up_wall': dict(src='climbing_up_wall', k=dict(arm=.75, hand=.9, leg=.8, spine=.8, head=.85, other=1.0), crouch=.9, rise=.8, xz=.0, sigma=2.0, dur=2.0),
  'Grab_Bar_and_Swing_Forward': dict(src='Grab_Bar_and_Swing_Forward', k=dict(arm=.8, hand=.9, leg=.8, spine=.75, head=.85, other=1.0), crouch=.85, rise=.8, xz=.0, sigma=2.0),
  'Swing_on_Rope_to_Ground': dict(src='Swing_on_Rope_to_Ground', k=dict(arm=.85, hand=.9, leg=.85, spine=.8, head=.85, other=1.0), crouch=.85, rise=.85, xz=.0, sigma=2.0),
}

# ---------------------------------------------------------------- emit
class Out:
    def __init__(s): s.bufs = []; s.views = []; s.accs = []; s.dedup = {}; s.size = 0
    def add(s, arr, typ, minmax=False):
        arr = np.ascontiguousarray(arr, np.float32); key = hashlib.md5(arr.tobytes() + typ.encode()).hexdigest()
        if key in s.dedup: return s.dedup[key]
        pad = (-s.size) % 4; s.bufs.append(b'\0' * pad); s.size += pad
        raw = arr.tobytes(); s.views.append({'buffer': 0, 'byteOffset': s.size, 'byteLength': len(raw)}); s.bufs.append(raw); s.size += len(raw)
        a = {'bufferView': len(s.views) - 1, 'componentType': 5126, 'count': int(arr.shape[0]), 'type': typ}
        if minmax: a['min'] = [float(arr.min())]; a['max'] = [float(arr.max())]
        s.accs.append(a); s.dedup[key] = len(s.accs) - 1; return len(s.accs) - 1

def main():
    src, dst = sys.argv[1], sys.argv[2]; report = '--report' in sys.argv
    j, acc = load(src); rig = Rig(j, acc); out = Out(); T = {1: 'SCALAR', 3: 'VEC3', 4: 'VEC4', 16: 'MAT4'}
    ibm = out.add(acc(j['skins'][0]['inverseBindMatrices']), 'MAT4'); j['skins'][0]['inverseBindMatrices'] = ibm
    baked = {}
    for name, sp in SPECS.items(): baked[name] = bake(rig, sp)
    anims = []
    order = [a['name'] for a in j['animations']] + [n for n in SPECS if n not in rig.anims]
    for name in order:
        chans = []; sams = []
        if name in baked:
            U, Q, P = baked[name]; srcA = rig.anims[SPECS[name]['src']]
            for c in srcA['channels']:
                nd, path = c['target']['node'], c['target']['path']
                if path == 'rotation' and nd in Q: u, v = collapse(U, Q[nd])
                elif path == 'translation' and nd in P: u, v = collapse(U, P[nd])
                else:  # scale (constant)
                    sm = srcA['samplers'][c['sampler']]; vv = acc(sm['output'])[:1]; u, v = U[[0, -1]], np.repeat(vv, 2, 0)
                sams.append({'input': out.add(u, 'SCALAR', True), 'output': out.add(v, T[v.shape[1]]), 'interpolation': 'LINEAR'})
                chans.append({'sampler': len(sams) - 1, 'target': {'node': nd, 'path': path}})
        else:
            a = rig.anims[name]
            for c in a['channels']:
                sm = a['samplers'][c['sampler']]; i, o = acc(sm['input']), acc(sm['output'])
                sams.append({'input': out.add(i, 'SCALAR', True), 'output': out.add(o, T[o.shape[1] if o.ndim > 1 else 1]), 'interpolation': sm.get('interpolation', 'LINEAR')})
                chans.append({'sampler': len(sams) - 1, 'target': c['target']})
        anims.append({'name': name, 'channels': chans, 'samplers': sams})
    j['animations'] = anims; j['accessors'] = out.accs; j['bufferViews'] = out.views
    blob = b''.join(out.bufs); blob += b'\0' * ((-len(blob)) % 4); j['buffers'] = [{'byteLength': len(blob)}]
    js = json.dumps(j, separators=(',', ':')).encode(); js += b' ' * ((-len(js)) % 4)
    glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(blob), 0x004E4942) + blob
    open(dst, 'wb').write(glb)
    print('wrote', dst, len(glb), 'bytes;', len(anims), 'clips;', len(out.accs), 'accessors')
    if report:
        for n, (U, Q, P) in baked.items(): print(n, 'dur %.3f s' % U[-1], 'frames', len(U))

if __name__ == '__main__': main()
