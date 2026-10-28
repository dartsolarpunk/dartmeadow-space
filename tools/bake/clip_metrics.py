#!/usr/bin/env python3
"""clip_metrics.py OLD.glb NEW.glb — before/after numbers for the rebaked clips (jerk, twist, hips excursion, foot pops)."""
import sys, numpy as np; sys.path.insert(0, __import__('os').path.dirname(__file__)); import rebake_anims as R
def stats(path, clip, fps=60):
    j, acc = R.load(path); rig = R.Rig(j, acc); tr = rig.tracks(clip); D = max(t[-1] for t, _, _ in tr.values())
    U = np.arange(0, D + 1e-9, 1 / fps); jerk = 0; vmax = 0; tw = {}; hips = None
    for (nd, path_), (t, v, itp) in tr.items():
        if path_ == 'rotation':
            q = R.qnorm(R.align(R.sample_track(t, v, 'rotation', U))); d = np.abs((q[1:] * q[:-1]).sum(1)).clip(0, 1); w = 2 * np.arccos(d) * fps   # rad/s
            a = np.abs(np.diff(w)) * fps; nm = rig.names[nd]
            if 'Hair' not in nm and 'Brow' not in nm and 'Lip' not in nm: jerk = max(jerk, np.percentile(a, 99)); vmax = max(vmax, w.max())
            if nm in ('LeftForeArm', 'RightForeArm', 'LeftLeg', 'RightLeg'):
                ch = {'LeftForeArm': 'LeftHand', 'RightForeArm': 'RightHand', 'LeftLeg': 'LeftFoot', 'RightLeg': 'RightFoot'}[nm]
                ax = rig.axis(nm, ch); dq = R.qmul(R.qconj(rig.rq[nd])[None], q); ang = np.abs((2 * np.arctan2(dq[:, :3] @ ax, dq[:, 3] + 0) + np.pi) % (2 * np.pi) - np.pi); tw[nm] = np.degrees(ang.max())
        if path_ == 'translation' and rig.names[nd] == 'Hips': hips = (v[:, 1].min(), v[:, 1].max(), v[0, 1])
    return dict(dur=round(D, 2), p99_ang_accel=round(float(jerk)), max_ang_vel=round(float(vmax), 1), max_twist_deg={k: round(float(x)) for k, x in tw.items()}, hipsY=tuple(round(float(x), 3) for x in hips))
for c in sys.argv[3:]:
    print(c, '\n  before', stats(sys.argv[1], c), '\n  after ', stats(sys.argv[2], c))
