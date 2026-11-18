#!/usr/bin/env python3
"""Retarget glTF skeletal animation clips from the Ariel/Autumn rig onto another skeleton that uses the SAME
bone names (Emma).  Rotation-only, world-space-delta retarget with per-bone rest-direction compensation:

    Sa(t) = Wa(t) * Wa0^-1                      (skin rotation in world space, source)
    Sb(t) = F Sa(t) F^-1 * Q                    (F = source->target world frame fix, Q = swing that aligns the
                                                 target's rest bone direction with the source's)
    Wb(t) = Sb(t) * Wb0 ;   Lb(t) = Wb(parent,t)^-1 * Wb(t)        (local rotation written to glTF)

Hips translation: Tb(t) = Tb0 + k * F (Ta(t) - Ta0),  k = target hip height / source hip height.
Optional per-clip ground lock keeps the lowest foot at the scaled source height (no floating/sinking when the
leg proportions differ).  Output = a skeleton+animations GLB with the same layout as Ariel's merged-animations GLB.
"""
import sys, os, json, argparse
sys.path.insert(0, os.path.dirname(__file__))
from glbtk import *

MAIN_CHILD = {  # bone -> child that defines its direction
 'Hips':'Spine','Spine':'Spine01','Spine01':'Spine02','Spine02':'neck','neck':'Head','Head':'head_end',
 'LeftShoulder':'LeftArm','LeftArm':'LeftForeArm','LeftForeArm':'LeftHand',
 'RightShoulder':'RightArm','RightArm':'RightForeArm','RightForeArm':'RightHand',
 'LeftUpLeg':'LeftLeg','LeftLeg':'LeftFoot','LeftFoot':'LeftToeBase',
 'LeftToeBase':'LeftToe_End','RightToeBase':'RightToe_End','LeftHand':'LeftHandMiddle1','RightHand':'RightHandMiddle1',
 'RightUpLeg':'RightLeg','RightLeg':'RightFoot','RightFoot':'RightToeBase',
}
LOCOMOTION = {'Walking','Walking_Woman','Running','Run_03','Idle_Breathe_Blink','Crouch_Walk_Right_with_Torch_inplace',
              'Fast_Stair_Climb','Acting_Talk','Acting_Wave_Happy','Acting_Thinking','Acting_Sad','Acting_Angry','Acting_Surprised'}

def min_rot(a, b):
    """quaternion rotating unit vector a to unit vector b (minimal swing)"""
    a = a/np.linalg.norm(a); b = b/np.linalg.norm(b); d = float(np.dot(a,b))
    if d > 1-1e-9: return np.array([0,0,0,1.])
    if d < -1+1e-9:
        ax = np.cross(a,[1,0,0]); 
        if np.linalg.norm(ax) < 1e-6: ax = np.cross(a,[0,1,0])
        return qaxis_angle(ax, np.pi)
    c = np.cross(a,b); q = np.array([c[0],c[1],c[2],1+d]); return q/np.linalg.norm(q)

class Skel:
    def __init__(self, g, root_name=None):
        self.g = g; nodes = g.nodes(); self.names = [n.get('name') for n in nodes]
        self.idx = {n:i for i,n in enumerate(self.names)}; self.par = g.parents()
        self.ch = {i:n.get('children',[]) for i,n in enumerate(nodes)}
        # bones = joints of the first skin, parents-first order
        self.joint_nodes = g.joints()
        self.order = []
        seen = set()
        def visit(i):
            if i in seen: return
            if i in self.par: visit(self.par[i])
            seen.add(i); self.order.append(i)
        for j in self.joint_nodes: visit(j)
        self.trs = {i: g.local_trs(i) for i in self.order}
        self.W = {}; self.P = {}
        for i in self.order:  # world rest matrices
            t,q,s = self.trs[i]; M = np.eye(4); M[:3,:3] = q2mat(q)*s; M[:3,3] = t
            self.W[i] = (self.W[self.par[i]] @ M) if i in self.par and self.par[i] in self.W else M
        self.rootrest = {}
    def wrot(self, i):
        M = self.W[i][:3,:3]; s = np.linalg.norm(M,axis=0); return mat_to_quat(M/s)
    def wpos(self, i): return self.W[i][:3,3].copy()
    def name_set(self): return {self.names[i] for i in self.order}

def frame_from_skel(S):
    """orthonormal world frame (right=+x', up=+y', fwd=+z') from the rest pose: left-right from the upleg bones, up from hips->head"""
    p = lambda n: S.wpos(S.idx[n])
    left = p('LeftUpLeg') - p('RightUpLeg'); up = p('Head') - p('Hips')
    left /= np.linalg.norm(left); up = up - np.dot(up,left)*left; up /= np.linalg.norm(up)
    fwd = np.cross(left, up)          # (left x up) = forward for a right-handed frame with left=+x_char? see below
    return np.stack([left, up, fwd], 1)  # columns

def fk_world(S, rot_local, hips_t, root_world=None):
    """rot_local: {node_idx: (T,4)}; returns world rot dict (T,4) and positions (T,3) for every joint. Positions use rest local translations."""
    T = len(next(iter(rot_local.values()))); W = {}; Pw = {}
    for i in S.order:
        q = rot_local.get(i); 
        if q is None: q = np.tile(S.trs[i][1], (T,1))
        t_rest = S.trs[i][0]
        if i in S.par and S.par[i] in W:
            pi = S.par[i]; W[i] = qmul(W[pi], q)
            t = hips_t if (hips_t is not None and S.names[i]=='Hips') else np.tile(t_rest,(T,1))
            Pw[i] = Pw[pi] + qrot(W[pi], t)
        else:
            Wr = mat_to_quat(S.W[i][:3,:3]/np.linalg.norm(S.W[i][:3,:3],axis=0)) if i in S.W else np.array([0,0,0,1.])
            # root of the chain: use rest world transform of the node itself (animated bone at chain root)
            W[i] = qmul(np.tile(0*Wr+np.array([0,0,0,1.]),(T,1)), q)
            Pw[i] = hips_t if hips_t is not None and S.names[i]=='Hips' else np.tile(t_rest,(T,1))
    return W, Pw

def reduce_track(times, vals, tol, quat):
    """Ramer-Douglas-Peucker keyframe reduction (slerp for quats); always keeps first and last."""
    n = len(times); keep = np.zeros(n, bool); keep[0] = keep[-1] = True
    stack = [(0, n-1)]
    while stack:
        a, b = stack.pop()
        if b-a < 2: continue
        tt = times[a+1:b]; f = ((tt-times[a])/max(times[b]-times[a],1e-9))[:,None]
        if quat: pred = qslerp(vals[a], vals[b], f); err = 2*np.arccos(np.clip(np.abs(np.sum(pred*vals[a+1:b],-1)),-1,1))
        else: pred = vals[a]*(1-f)+vals[b]*f; err = np.linalg.norm(pred-vals[a+1:b],axis=-1)
        k = int(np.argmax(err))
        if err[k] > tol: m = a+1+k; keep[m] = True; stack += [(a,m),(m,b)]
    return times[keep], vals[keep]

def retarget(src_glb, dst_glb, clips=None, ref_char=None, fps=30, rot_tol_deg=0.05, pos_tol=1e-4, ground_lock=True, align_dirs=True, verbose=True):
    A = GLB(src_glb); B = GLB(dst_glb)
    SA = Skel(A); SB = Skel(B)   # source skeleton = the animation file's own (translations in its tracks == its node rest: that is what plays)
    common = [n for n in SB.names if n in SA.name_set() and SB.idx[n] in SB.order]
    missing_dst = sorted(SA.name_set() - SB.name_set())
    if verbose: print(f'src bones {len(SA.order)}  dst bones {len(SB.order)}  shared {len(common)}  src-only {len(missing_dst)}')
    anims = A.animations()
    if clips: anims = {k:v for k,v in anims.items() if k in clips}
    # --- global frame fix F (source world -> target world) ---
    Fa, Fb = frame_from_skel(SA), frame_from_skel(SB)
    Fm = Fb @ Fa.T; Fq = mat_to_quat(Fm)
    # --- scale ---
    ha = SA.wpos(SA.idx['Hips']) ; hb = SB.wpos(SB.idx['Hips'])
    # hip height measured along the up axis, relative to the lowest foot bone
    def ftip(S): return min(S.wpos(S.idx[n]) @ frame_from_skel(S)[:,1] for n in ('LeftFoot','RightFoot','LeftToeBase','RightToeBase','LeftToe_End','RightToe_End') if n in S.idx)
    up_a, up_b = Fa[:,1], Fb[:,1]
    hip_a = ha @ up_a - ftip(SA); hip_b = hb @ up_b - ftip(SB)
    k = hip_b/hip_a
    if verbose: print(f'hip height src {hip_a:.4f}  dst {hip_b:.4f}  root-motion scale k={k:.4f}   frame fix angle {np.degrees(2*np.arccos(abs(Fq[3]))):.1f} deg')
    # --- per-bone swing correction Q (in target frame) ---
    Q = {}
    for n in common:
        i = SB.idx[n]; Q[n] = np.array([0,0,0,1.])
        c = MAIN_CHILD.get(n)
        if align_dirs and c and c in SA.idx and c in SB.idx:
            da = SA.wpos(SA.idx[c]) - SA.wpos(SA.idx[n]); db = SB.wpos(SB.idx[c]) - SB.wpos(SB.idx[n])
            da = Fm @ da
            if np.linalg.norm(da) > 1e-6 and np.linalg.norm(db) > 1e-6:
                # Q expressed so Sb = Sa' * Q : Q D_e0 = D_a0'
                Q[n] = min_rot(db, da)
    # bones whose local rest equals the Ariel *character* file's local rest (fingers, toes, face, hair ... of a rig cloned from Ariel) are copied
    # local-for-local, which is exactly what the game does for Ariel (clip tracks are authored against that bone frame)
    COPY = set()
    if ref_char:
        R = GLB(ref_char); rn = R.name_index()
        for n in common:
            if n in MAIN_CHILD or n == 'Hips' or n not in rn: continue
            qd = SB.trs[SB.idx[n]][1]; qr = R.local_trs(rn[n])[1]
            if 2*np.arccos(min(1,abs(float(qd@qr)))) < np.radians(2.0): COPY.add(n)
        if verbose: print(f'copy-local bones (rest matches Ariel character file): {len(COPY)} of {len(common)}')
    qa0 = {n: SA.wrot(SA.idx[n]) for n in SA.name_set()}
    qb0 = {n: SB.wrot(SB.idx[n]) for n in common}
    out = {}
    for cname, tracks in anims.items():
        dur = max(t[0][-1] for tr in tracks.values() for t in tr.values()); T = max(2, int(round(dur*fps))+1)
        tg = np.linspace(0, dur, T)
        # source local rotations resampled
        rot_a = {}
        for n in SA.name_set():
            if n in tracks and 'rotation' in tracks[n]:
                rot_a[SA.idx[n]] = qfix(resample(tracks[n]['rotation'][0], tracks[n]['rotation'][1], tg, quat=True))
        hips_a = resample(*tracks['Hips']['translation'], tg) if 'Hips' in tracks and 'translation' in tracks['Hips'] else np.tile(SA.trs[SA.idx['Hips']][0],(T,1))
        # source world rotations (armature-root orientation folded in via rest world of root parent chain)
        Wa = {}
        for i in SA.order:
            q = rot_a.get(i, np.tile(SA.trs[i][1],(T,1)))
            if i in SA.par and SA.par[i] in Wa: Wa[i] = qmul(Wa[SA.par[i]], q)
            else:
                pw = np.tile(mat_to_quat(np.eye(3)) if i not in SA.par else mat_to_quat(SA.W[SA.par[i]][:3,:3]/np.linalg.norm(SA.W[SA.par[i]][:3,:3],axis=0)),(T,1)); Wa[i] = qmul(pw,q)
        # target world rotations
        Wb = {}; rot_b = {}
        for i in SB.order:
            n = SB.names[i]
            if n in COPY:
                lq = qfix(resample(tracks[n]['rotation'][0], tracks[n]['rotation'][1], tg, quat=True)) if (n in tracks and 'rotation' in tracks[n]) else np.tile(SB.trs[i][1],(T,1))
                W = qmul(Wb[SB.par[i]], lq) if i in SB.par and SB.par[i] in Wb else qmul(np.tile(qb0[n],(T,1)), lq)
            elif n in Q and n in SA.idx:
                Sa = qmul(Wa[SA.idx[n]], np.tile(qinv(qa0[n]),(T,1)))                    # world skin rotation, source frame
                Sap = qmul(qmul(np.tile(Fq,(T,1)), Sa), np.tile(qinv(Fq),(T,1)))          # expressed in target frame
                Sb = qmul(Sap, np.tile(Q[n],(T,1)))
                W = qmul(Sb, np.tile(qb0[n],(T,1)))
            else:
                # bone not animated by the source: keep rest local relative to the (animated) parent
                lq = np.tile(SB.trs[i][1],(T,1))
                if i in SB.par and SB.par[i] in Wb: W = qmul(Wb[SB.par[i]], lq)
                else: W = np.tile(qb0[n] if n in qb0 else SB.wrot(i),(T,1))
            Wb[i] = qnorm(W)
            if i in SB.par and SB.par[i] in Wb: L = qmul(qinv(Wb[SB.par[i]]), Wb[i])
            else:
                pw = mat_to_quat(SB.W[SB.par[i]][:3,:3]/np.linalg.norm(SB.W[SB.par[i]][:3,:3],axis=0)) if i in SB.par else np.array([0,0,0,1.])
                L = qmul(np.tile(qinv(pw),(T,1)), Wb[i])
            rot_b[n] = qfix(qnorm(L))
        # hips translation: delta from source rest, in target frame, scaled
        t_rest_a = SA.trs[SA.idx['Hips']][0]; t_rest_b = SB.trs[SB.idx['Hips']][0]
        # source hips parent frame: armature root (identity for Ariel); work in world: world pos of hips = parent chain
        pA = SA.W[SA.par[SA.idx['Hips']]] if SA.idx['Hips'] in SA.par else np.eye(4); pB = SB.W[SB.par[SB.idx['Hips']]] if SB.idx['Hips'] in SB.par else np.eye(4)
        wa = (pA[:3,:3] @ hips_a.T).T + pA[:3,3]; wa0 = SA.wpos(SA.idx['Hips'])
        dW = Fm @ (wa - wa0).T                     # (3,T) world delta in target frame
        dW = dW.T * k
        wb = SB.wpos(SB.idx['Hips']) + dW
        hips_b = (np.linalg.inv(pB[:3,:3]) @ (wb - pB[:3,3]).T).T
        info = {'k':k}
        if ground_lock and cname in LOCOMOTION:
            # keep the lower foot at k * source height: measure with FK on both
            hb_fix = ground_fix(SA, SB, Wa, hips_a, rot_b, hips_b, wa, k, Fm, tg, pA, pB)
            hips_b = hips_b + hb_fix; info['lock']=float(np.abs(hb_fix).max())
        out[cname] = {'t':tg, 'rot':rot_b, 'hips':hips_b, 'dur':dur, 'info':info}
        if verbose: print(f'  {cname:38s} dur {dur:5.2f}s frames {T:3d}  {info}')
    return out, SB, k

def ground_fix(SA, SB, Wa, hips_a, rot_b, hips_b, wa, k, Fm, tg, pA, pB):
    """vertical offset (world up) per frame so min(foot y) matches k * source min(foot y) (relative to rest foot height)"""
    up_b = frame_from_skel(SB)[:,1]; up_a = frame_from_skel(SA)[:,1]
    def foot_heights(S, rotd, hips_w, upv, pA_):
        T = len(tg); W = {}; P = {}
        res = []
        for i in S.order:
            n = S.names[i]; q = rotd.get(n) if isinstance(rotd, dict) and not isinstance(next(iter(rotd)), int) else rotd.get(i)
            if q is None: q = np.tile(S.trs[i][1],(T,1))
            if i in S.par and S.par[i] in W:
                pi = S.par[i]; W[i] = qmul(W[pi], q); P[i] = P[pi] + qrot(W[pi], np.tile(S.trs[i][0],(T,1)))
            else:
                pr = np.tile(mat_to_quat(S.W[S.par[i]][:3,:3]/np.linalg.norm(S.W[S.par[i]][:3,:3],axis=0)) if i in S.par else np.array([0,0,0,1.]),(T,1)); W[i] = qmul(pr,q); P[i] = hips_w
            if n == 'Hips': P[i] = hips_w
        return W, P
    # target: FK with hips world pos
    wb_hips = (pB[:3,:3] @ hips_b.T).T + pB[:3,3]
    Wt, Pt = foot_heights(SB, rot_b, wb_hips, up_b, pB)
    # source: need rot dict by name
    rot_a_by = {}
    # recompute source local rotations from Wa
    for i in SA.order:
        if i in SA.par and SA.par[i] in Wa: rot_a_by[SA.names[i]] = qmul(qinv(Wa[SA.par[i]]), Wa[i])
        else: rot_a_by[SA.names[i]] = qmul(np.tile(qinv(mat_to_quat(SA.W[SA.par[i]][:3,:3]/np.linalg.norm(SA.W[SA.par[i]][:3,:3],axis=0))) if i in SA.par else np.array([0,0,0,1.]),(len(tg),1)), Wa[i])
    Ws, Ps = foot_heights(SA, rot_a_by, wa, up_a, pA)
    feet = [n for n in ('LeftFoot','RightFoot') if n in SB.idx and n in SA.idx]
    ys = lambda P,S,upv,ref: np.min([P[S.idx[n]] @ upv - ref[n] for n in feet],0)
    refA = {n: SA.wpos(SA.idx[n]) @ up_a for n in feet}; refB = {n: SB.wpos(SB.idx[n]) @ up_b for n in feet}
    ya = ys(Ps,SA,up_a,refA)*k; yb = ys(Pt,SB,up_b,refB)
    d = ya - yb                                   # world-up correction
    return np.outer(d, np.linalg.inv(pB[:3,:3]) @ up_b)

def write_animation_glb(out, SB, dst_glb, outpath, rot_tol_deg=0.05, pos_tol=1e-4, keep_mesh=False, extra_extras=None):
    """skeleton (nodes + skin) copied from dst GLB, meshes dropped; animations written with reduced tracks"""
    B = GLB(dst_glb); j = B.j
    nodes = json.loads(json.dumps(j['nodes']))
    # keep only skeleton hierarchy nodes (joints + their ancestors) -- drop mesh/camera/light nodes
    joint_set = set(SB.joint_nodes)
    keep = set(joint_set)
    for i in list(joint_set):
        while i in SB.par: i = SB.par[i]; keep.add(i)
    remap = {old:new for new,old in enumerate(sorted(keep))}
    nn = []
    for old in sorted(keep):
        n = {k:v for k,v in nodes[old].items() if k in ('name','translation','rotation','scale','matrix')}
        ch = [remap[c] for c in nodes[old].get('children',[]) if c in keep]
        if ch: n['children'] = ch
        nn.append(n)
    roots = [remap[i] for i in sorted(keep) if i not in SB.par or SB.par[i] not in keep]
    # inverse bind matrices accessor (copy)
    bb = BinBuilder()
    sk = j['skins'][0]
    ibm = B.acc(sk['inverseBindMatrices']).astype(np.float32) if 'inverseBindMatrices' in sk else None
    gj = {'asset':{'generator':'emma retarget (retarget.py)','version':'2.0'},'scene':0,'scenes':[{'nodes':roots,'name':'Scene'}],'nodes':nn,'animations':[]}
    skin = {'joints':[remap[i] for i in sk['joints']]}
    if ibm is not None: skin['inverseBindMatrices'] = bb.add(ibm,'MAT4')
    gj['skins'] = [skin]
    nid = {nodes[o].get('name'): remap[o] for o in remap}
    rtol = np.radians(rot_tol_deg); stats = {'keys':0}
    for cname, d in out.items():
        samplers=[]; chans=[]
        for n, q in d['rot'].items():
            rest = SB.trs[SB.idx[n]][1]
            if np.max(2*np.arccos(np.clip(np.abs(q @ rest),0,1))) < np.radians(0.02): continue   # constant == rest: omit (smaller file, no hair/finger noise)
            tr, qr = reduce_track(d['t'], q, rtol, True)
            ti = bb.add(tr.reshape(-1,1),'SCALAR',minmax=True); qi = bb.add(qr,'VEC4')
            samplers.append({'input':ti,'output':qi,'interpolation':'LINEAR'}); chans.append({'sampler':len(samplers)-1,'target':{'node':nid[n],'path':'rotation'}}); stats['keys'] += len(tr)
        tr, hp = reduce_track(d['t'], d['hips'], pos_tol, False)
        ti = bb.add(tr.reshape(-1,1),'SCALAR',minmax=True); pi = bb.add(hp,'VEC3')
        samplers.append({'input':ti,'output':pi,'interpolation':'LINEAR'}); chans.append({'sampler':len(samplers)-1,'target':{'node':nid['Hips'],'path':'translation'}})
        gj['animations'].append({'name':cname,'samplers':samplers,'channels':chans})
    gj['accessors'] = bb.accs; gj['bufferViews'] = bb.views; gj['buffers'] = [{'byteLength':len(bb.buf)}]
    write_glb(outpath, gj, bytes(bb.buf)); return stats

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True); ap.add_argument('--dst', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--ref-char'); ap.add_argument('--clips', nargs='*'); ap.add_argument('--no-ground-lock', action='store_true'); ap.add_argument('--no-align', action='store_true')
    a = ap.parse_args()
    o, SB, k = retarget(a.src, a.dst, a.clips, ref_char=a.ref_char, ground_lock=not a.no_ground_lock, align_dirs=not a.no_align)
    print(write_animation_glb(o, SB, a.dst, a.out)); print(os.path.getsize(a.out)/1e6, 'MB')
