"""Stick-figure contact sheets of retargeted clips (FK in numpy, matplotlib): usage contact_sheet.py ANIM.glb SKEL.glb OUT_DIR [clip ...]"""
import sys, os, re; sys.path.insert(0, os.path.dirname(__file__))
import numpy as np, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
from glbtk import *; from retarget import Skel, frame_from_skel; from verify_fk import fk
def main(anim, skel, out, clips=None, cols=8):
    A = GLB(anim); S = Skel(GLB(skel)); an = A.animations(); os.makedirs(out, exist_ok=True)
    F = frame_from_skel(S); right, up, fwd = F[:,0], F[:,1], F[:,2]      # character frame: x=left, y=up, z=fwd
    skip = re.compile(r'Hair_|Brow|Lip|Mouth|Nostril|Cheek|Nose|Chin|Jaw|Hand\w+\d$|FootBig|FootToe|Toe_End')
    names = [S.names[i] for i in S.order if not skip.search(S.names[i])]
    edges = [(S.names[S.par[S.idx[n]]], n) for n in names if S.idx[n] in S.par and S.names[S.par[S.idx[n]]] in names]
    clips = clips or list(an.keys()); n = len(clips); rows = (n + 0) ; 
    for c in clips:
        d = max(t[0][-1] for tr in an[c].values() for t in tr.values()); T = int(round(d*30))+1; tg = np.linspace(0, d, T)
        P, _ = fk(S, an[c], T, tg); ks = np.linspace(0, T-1, cols).astype(int)
        fig, axs = plt.subplots(2, cols, figsize=(2*cols, 7))
        allp = np.concatenate([np.stack([P[n_][k] for n_ in names]) for k in range(T)])
        for r, (ax_h, ax_v) in enumerate([(fwd, up), (F[:,0], up)]):     # row 0 side view (fwd,up) / row 1 front view (left,up)
            xs = allp @ ax_h; ys = allp @ ax_v; xlim = (xs.min()-.1, xs.max()+.1); ylim = (ys.min()-.1, ys.max()+.1)
            for j, k in enumerate(ks):
                ax = axs[r, j]; 
                for a, b in edges: ax.plot([P[a][k]@ax_h, P[b][k]@ax_h], [P[a][k]@ax_v, P[b][k]@ax_v], 'k-', lw=1.4)
                for n_ in ('LeftFoot','RightFoot','LeftHand','RightHand','Head'): ax.plot(P[n_][k]@ax_h, P[n_][k]@ax_v, 'o', ms=3, color='tab:red' if 'Left' in n_ else 'tab:blue' if 'Right' in n_ else 'tab:green')
                ax.set_xlim(*xlim); ax.set_ylim(*ylim); ax.set_aspect('equal'); ax.axis('off'); 
                if r == 0: ax.set_title('%.2fs' % tg[k], fontsize=8)
        fig.suptitle(f'{c}  ({d:.2f}s)   top: side, bottom: front'); plt.tight_layout(); fig.savefig(os.path.join(out, f'sheet_{c}.png'), dpi=60); plt.close(fig)
if __name__ == '__main__': main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:] or None)
