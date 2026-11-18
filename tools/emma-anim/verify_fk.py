"""FK verification: compare joint world positions (relative to hips, scaled by hip-height ratio) of the retargeted clip on the target
skeleton vs. the source clip on the source skeleton.  Reports max / mean error as % of character height and NaN checks."""
import sys, os, re; sys.path.insert(0, os.path.dirname(__file__))
from glbtk import *
from retarget import Skel, frame_from_skel

def fk(S, anim, T, tg, hips_override=None):
    """anim: {boneName:{'rotation':(t,vals),'translation':(t,vals)}} -> positions dict name->(T,3), world rot"""
    W = {}; P = {}
    for i in S.order:
        n = S.names[i]
        if n in anim and 'rotation' in anim[n]: q = qfix(resample(anim[n]['rotation'][0], anim[n]['rotation'][1], tg, quat=True))
        else: q = np.tile(S.trs[i][1],(T,1))
        if n in anim and 'translation' in anim[n]: tr = resample(anim[n]['translation'][0], anim[n]['translation'][1], tg)
        else: tr = np.tile(S.trs[i][0],(T,1))
        if i in S.par and S.par[i] in W:
            pi = S.par[i]; W[i] = qmul(W[pi], q); P[i] = P[pi] + qrot(W[pi], tr)
        else:
            pq = mat_to_quat(S.W[S.par[i]][:3,:3]/np.linalg.norm(S.W[S.par[i]][:3,:3],axis=0)) if i in S.par else np.array([0,0,0,1.])
            pp = S.W[S.par[i]][:3,3] if i in S.par else np.zeros(3)
            W[i] = qmul(np.tile(pq,(T,1)), q); P[i] = pp + qrot(np.tile(pq,(T,1)), tr)
    return {S.names[i]:P[i] for i in S.order}, {S.names[i]:W[i] for i in S.order}

def compare(src_glb, dst_glb, out_glb, clips=None, k=None, ref_char=None):
    A = GLB(src_glb); B = GLB(dst_glb); O = GLB(out_glb)
    SA, SB = Skel(GLB(ref_char) if ref_char else A), Skel(B)
    anA = A.animations(); anO = O.animations()
    Fa, Fb = frame_from_skel(SA), frame_from_skel(SB); Fm = Fb @ Fa.T
    if k is None:
        k = (SB.wpos(SB.idx['Hips'])@Fb[:,1]) / (SA.wpos(SA.idx['Hips'])@Fa[:,1])
    height = np.linalg.norm(SB.wpos(SB.idx['Head']) - SB.wpos(SB.idx['Hips']))*0 + (SB.wpos(SB.idx['Head']) @ Fb[:,1] - min(SB.wpos(SB.idx[n])@Fb[:,1] for n in ('LeftFoot','RightFoot')))*1.8
    res = {}
    for c in (clips or [x for x in anO if x in anA]):
        dur = max(t[0][-1] for tr in anA[c].values() for t in tr.values()); T = int(round(dur*30))+1; tg = np.linspace(0,dur,T)
        PA,_ = fk(SA, anA[c], T, tg); PB,_ = fk(SB, anO[c], T, tg)
        errs = []; worst = {}
        for n in PB:
            if n not in PA or n == 'Hips' or re.search(r'Hand[A-Za-z]+\d$', n) or n.startswith('Hair_') or 'Foot' in n and 'Toe' in n and n != 'LeftFoot' and n!='RightFoot': continue
            a = (Fm @ (PA[n]-PA['Hips']).T).T * k; b = PB[n]-PB['Hips']
            e = np.linalg.norm(a-b,axis=1); errs.append(e); worst[n] = e.max()
        E = np.concatenate(errs)
        nan = any(np.isnan(v).any() for v in PB.values())
        top = sorted(worst.items(), key=lambda x:-x[1])[:3]
        res[c] = (E.max()/height*100, E.mean()/height*100, nan, top)
        print(f'{c:38s} max {E.max()/height*100:6.2f}%  mean {E.mean()/height*100:6.3f}%  nan={nan}  worst {[(n,round(v/height*100,2)) for n,v in top]}')
    return res
if __name__=='__main__':
    ref = os.environ.get('REF_CHAR'); compare(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:] or None, ref_char=ref)
