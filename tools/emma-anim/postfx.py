#!/usr/bin/env python3
"""Post-processing of retargeted clips (target skeleton space): relaxed-hand base layer, loop closing, shoulder/arm metrics."""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from retarget import *
from verify_fk import fk

def load_preset(name='relaxed_hand'):
    return json.load(open(os.path.join(os.path.dirname(__file__), 'presets', name + '.json')))

def clip_anim(clip):
    """clip dict -> the {bone:{rotation:(t,v),translation:(t,v)}} form used by verify_fk.fk"""
    a = {n: {'rotation': (clip['t'], q)} for n, q in clip['rot'].items()}
    a.setdefault('Hips', {})['translation'] = (clip['t'], clip['hips']); a['Hips'].setdefault('rotation', (clip['t'], clip['rot']['Hips']))
    return a

def relaxed_hand_quats(SB, preset=None):
    """per-bone LOCAL quaternions of the relaxed hand pose for skeleton SB (derived from its rest geometry, so Left/Right mirror automatically)"""
    P = preset or load_preset(); Fb = frame_from_skel(SB)        # columns: left, up, fwd (character axes in world)
    palm = Fb @ np.array(P['restPalmDir'], float); palm /= np.linalg.norm(palm)
    pos = lambda n: SB.wpos(SB.idx[n])
    out = {}
    for side in ('Left', 'Right'):
        mid1 = pos(f'{side}HandMiddle1')
        for fname in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky'):
            spec = P['thumb'] if fname == 'Thumb' else P['fingers'][fname]
            for j in (1, 2, 3):
                n = f'{side}Hand{fname}{j}'; i = SB.idx[n]; child = SB.idx[f'{side}Hand{fname}{j+1}']
                d = pos(f'{side}Hand{fname}{j+1}') - pos(n); d /= np.linalg.norm(d)
                a = np.cross(d, palm); a /= np.linalg.norm(a)                 # +angle about a swings d toward the palm
                ang = np.radians(spec['flex'][j-1])
                Dw = qaxis_angle(a, ang)
                sp = spec.get('adduct', 0) if fname == 'Thumb' else spec.get('spread', 0)
                if j == 1 and sp:
                    lat = (pos(f'{side}HandIndex1') - pos(f'{side}HandThumb2')) if fname == 'Thumb' else (pos(n) - mid1)
                    sgn = 1.0 if np.dot(np.cross(palm, d), lat) >= 0 else -1.0
                    Dw = qmul(qaxis_angle(palm, sgn*np.radians(sp)), Dw)
                Wr = SB.wrot(i); E = qmul(qmul(qinv(Wr), Dw), Wr)             # same rotation, expressed as a right-multiplied local delta
                out[n] = qnorm(qmul(SB.trs[i][1], E))
    return out

def hand_down_weight(SB, clip, preset):
    """per-frame, per-side blend weight (1 = hand hangs by the side)"""
    Fb = frame_from_skel(SB); up = Fb[:, 1]; T = len(clip['t'])
    P, _ = fk(SB, clip_anim(clip), T, clip['t'])
    w = {}
    s0, s1 = preset['weight']['handBelowHipsStart'], preset['weight']['handBelowHipsEnd']
    for side in ('Left', 'Right'):
        rel = (P[f'{side}Hand'] - P['Hips']) @ up        # wrist height above hips
        x = np.clip((s1 - rel) / max(s1 - s0, 1e-6), 0, 1); w[side] = x*x*(3-2*x)
    return w

def apply_relaxed_hand(clips, SB, preset=None, report=None):
    preset = preset or load_preset(); Q = relaxed_hand_quats(SB, preset); ex = set(preset['excludeClips'])
    for cname, c in clips.items():
        if cname in ex: continue
        w = hand_down_weight(SB, c, preset); T = len(c['t'])
        if cname in FORCE_RELAXED_HAND: w = {s: np.ones(T) for s in w}
        for n, qr in Q.items():
            side = 'Left' if n.startswith('Left') else 'Right'; ww = w[side][:, None]
            if ww.max() <= 1e-3: continue
            cur = c['rot'].get(n)
            if cur is None: cur = np.tile(SB.trs[SB.idx[n]][1], (T, 1))
            c['rot'][n] = qfix(qnorm(qslerp(cur, np.tile(qr, (T, 1)), ww)))
        if report is not None: report[cname] = {s: float(w[s].mean()) for s in w}

def loopify(clip, SB, up, blend=0.5, name_info=None, fps=30):
    """make a clip loop seamlessly: net root travel removed (vertical bob and sway kept), last `blend` seconds crossfaded into the first pose"""
    T = len(clip['t']); N = max(2, min(T//2, int(round(blend*fps))))
    ramp = np.linspace(0, 1, T)[:, None]; h = clip['hips'] - ramp * (clip['hips'][-1] - clip['hips'][0])
    rot = {}
    wgt = np.zeros((T, 1)); k = np.arange(N)/(N-1); wgt[T-N:, 0] = k*k*(3-2*k)          # 0 -> 1 over the last N frames
    for n, q in clip['rot'].items():
        q = qfix(q); tgt = np.tile(q[0], (T, 1)); rot[n] = qfix(qnorm(qslerp(q, tgt, wgt)))
    hh = h.copy(); hh[T-N:] = h[T-N:]*(1-wgt[T-N:]) + h[0]*wgt[T-N:]
    return {'t': clip['t'].copy(), 'rot': rot, 'hips': hh, 'dur': clip['dur'], 'info': name_info or {}}

def shoulder_metrics(SB, clip):
    """joint positions of Shoulder/Arm relative to Spine02, in the Spine02 frame -> drift vs rest (m); fingertip drop of the hanging pose"""
    T = len(clip['t']); P, W = fk(SB, clip_anim(clip), T, clip['t']); res = {}
    Wq = lambda j: SB.wrot(SB.idx[j])
    for side in ('Left', 'Right'):
        for j in (side+'Shoulder', side+'Arm'):
            rest = qrot(qinv(Wq('Spine')), SB.wpos(SB.idx[j]) - SB.wpos(SB.idx['Spine']))
            rel = qrot(qinv(W['Spine']), P[j] - P['Spine']); res[j] = np.linalg.norm(rel - rest, axis=1)
    return res

# ---------------------------------------------------------------------------------------------------------------------------------
# arm clean-up for locomotion: remove forearm/wrist roll that the Ariel->Emma rest difference adds, and (run) a relaxed-jog arm swing
def _twist_swing(d, axis):
    """split delta quaternions d (T,4) about local `axis` into (swing, twist) with d = swing * twist"""
    axis = axis/np.linalg.norm(axis); v = d[:, :3] @ axis
    tq = np.concatenate([v[:, None]*axis[None, :], d[:, 3:4]], 1); n = np.linalg.norm(tq, axis=1, keepdims=True)
    tq = np.where(n > 1e-9, tq/np.maximum(n, 1e-9), np.array([0, 0, 0, 1.])); sw = qmul(d, qinv(tq)); return sw, tq

def _scaled(d, axis, swing_k, twist_k):
    sw, tw = _twist_swing(qfix(d), axis); I = np.tile(np.array([0, 0, 0, 1.]), (len(d), 1))
    return qnorm(qmul(qslerp(I, sw, np.full((len(d), 1), swing_k)), qslerp(I, tw, np.full((len(d), 1), twist_k))))

# clip -> settings. twist_keep: fraction of forearm / hand roll kept (1 = untouched); jog: relaxed-jog arm swing for run clips
ARM_FIX = {
    'Walking': {'twist_keep': 0.15}, 'Walking_Woman': {'twist_keep': 0.15},
    'Crouch_Walk_Right_with_Torch_inplace': {'twist_keep': 0.15, 'only_hanging': True},
    'Running': {'twist_keep': 0.15, 'jog': {'center_deg': -8, 'swing': 0.55, 'bend': 0.6}},
    'Run_03':  {'twist_keep': 0.15, 'jog': {'center_deg': -8, 'swing': 0.55, 'bend': 0.7}},
}
FORCE_RELAXED_HAND = {'Walking', 'Walking_Woman', 'Running', 'Run_03'}    # fingers relaxed for the whole clip, not only while the wrist is low

def fix_arms(clips, SB, report=None):
    Fb = frame_from_skel(SB); left, up, fwd = Fb[:, 0], Fb[:, 1], Fb[:, 2]
    for cname, cfg in ARM_FIX.items():
        c = clips.get(cname)
        if c is None: continue
        T = len(c['t']); P, W = fk(SB, clip_anim(c), T, c['t'])
        for side in ('Left', 'Right'):
            if cfg.get('only_hanging'):
                rel = ((P[side+'Hand'] - P[side+'Arm']) @ up).mean()
                if rel > -0.25: continue                              # hand is holding something up (torch): leave it
            def L(n):
                q = c['rot'].get(n); return qfix(q if q is not None else np.tile(SB.trs[SB.idx[n]][1], (T, 1)))
            rest = lambda n: SB.trs[SB.idx[n]][1]
            jog = cfg.get('jog')
            if jog:
                a = P[side+'ForeArm'] - P[side+'Arm']; a /= np.linalg.norm(a, axis=1, keepdims=True)
                ax, y, z = a @ left, a @ up, a @ fwd
                phi = np.unwrap(np.arctan2(z, -y)); m = np.sqrt(y*y + z*z)
                phi2 = np.radians(jog['center_deg']) + jog['swing']*(phi - phi.mean())
                a2 = ax[:, None]*left[None, :] + (-m*np.cos(phi2))[:, None]*up[None, :] + (m*np.sin(phi2))[:, None]*fwd[None, :]
                Wp = W[side+'Shoulder']; Wa = W[side+'Arm']; new = np.zeros_like(Wa)
                for t in range(T): new[t] = qmul(min_rot(a[t], a2[t]), Wa[t])
                c['rot'][side+'Arm'] = qfix(qnorm(qmul(qinv(Wp), new)))
            # forearm: elbow bend scale (jog) + roll removal; hand: roll removal
            fa, ha = side+'ForeArm', side+'Hand'
            ax_f = SB.trs[SB.idx[ha]][0]; ax_h = SB.trs[SB.idx[side+'HandMiddle1']][0]
            tk = cfg['twist_keep']
            df = qmul(np.tile(qinv(rest(fa)), (T, 1)), L(fa)); c['rot'][fa] = qfix(qnorm(qmul(np.tile(rest(fa), (T, 1)), _scaled(df, ax_f, jog['bend'] if jog else 1.0, tk))))
            dh = qmul(np.tile(qinv(rest(ha)), (T, 1)), L(ha)); c['rot'][ha] = qfix(qnorm(qmul(np.tile(rest(ha), (T, 1)), _scaled(dh, ax_h, 1.0, tk))))
