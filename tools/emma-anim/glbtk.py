"""Minimal GLB toolkit (numpy): read skeleton + animations, write animation-only / skeleton GLBs.
Pure python + numpy; no bpy needed."""
import struct, json, numpy as np

CT = {5120:np.int8,5121:np.uint8,5122:np.int16,5123:np.uint16,5125:np.uint32,5126:np.float32}
NC = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}

class GLB:
    def __init__(self, path):
        d = open(path,'rb').read()
        _, _, _ = struct.unpack('<4sII', d[:12]); off = 12
        self.bin = b''
        while off < len(d):
            cl, ct = struct.unpack('<II', d[off:off+8]); c = d[off+8:off+8+cl]
            if ct == 0x4E4F534A: self.j = json.loads(c)
            elif ct == 0x004E4942: self.bin = c
            off += 8+cl
        self.path = path
    def acc(self, i):
        a = self.j['accessors'][i]; bv = self.j['bufferViews'][a['bufferView']]
        dt = CT[a['componentType']]; n = NC[a['type']]; cnt = a['count']
        off = bv.get('byteOffset',0) + a.get('byteOffset',0)
        stride = bv.get('byteStride') or n*np.dtype(dt).itemsize
        if stride == n*np.dtype(dt).itemsize:
            arr = np.frombuffer(self.bin, dtype=dt, count=cnt*n, offset=off).reshape(cnt, n)
        else:
            arr = np.stack([np.frombuffer(self.bin, dtype=dt, count=n, offset=off+k*stride) for k in range(cnt)])
        arr = arr.astype(np.float64) if a.get('normalized') is None else arr.astype(np.float64)
        if a.get('normalized'):
            m = {np.int8:127.,np.uint8:255.,np.int16:32767.,np.uint16:65535.}[dt]; arr = np.maximum(arr/m,-1) if dt in (np.int8,np.int16) else arr/m
        return arr
    # ---- skeleton ----
    def nodes(self): return self.j['nodes']
    def name_index(self): return {n.get('name'): i for i, n in enumerate(self.j['nodes'])}
    def parents(self):
        p = {}
        for i, n in enumerate(self.j['nodes']):
            for c in n.get('children', []): p[c] = i
        return p
    def local_trs(self, i):
        n = self.j['nodes'][i]
        if 'matrix' in n:
            m = np.array(n['matrix']).reshape(4,4).T
            t = m[:3,3]; s = np.linalg.norm(m[:3,:3],axis=0); R = m[:3,:3]/s
            return t, mat_to_quat(R), s
        return (np.array(n.get('translation',[0,0,0]),float), np.array(n.get('rotation',[0,0,0,1]),float), np.array(n.get('scale',[1,1,1]),float))
    def joints(self):
        sk = self.j['skins'][0]; return sk['joints']
    def animations(self):
        out = {}
        nodes = self.j['nodes']
        for a in self.j.get('animations', []):
            tr = {}
            for ch in a['channels']:
                tg = ch['target']; node = tg.get('node'); path = tg['path']
                s = a['samplers'][ch['sampler']]
                times = self.acc(s['input'])[:,0]; vals = self.acc(s['output'])
                if s.get('interpolation','LINEAR') == 'CUBICSPLINE': vals = vals[1::3]; times = times
                tr.setdefault(nodes[node]['name'], {})[path] = (times, vals)
            out[a['name']] = tr
        return out

def mat_to_quat(R):
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t+1)*2; w = .25*s; x=(R[2,1]-R[1,2])/s; y=(R[0,2]-R[2,0])/s; z=(R[1,0]-R[0,1])/s
    elif R[0,0]>R[1,1] and R[0,0]>R[2,2]:
        s = np.sqrt(1+R[0,0]-R[1,1]-R[2,2])*2; w=(R[2,1]-R[1,2])/s; x=.25*s; y=(R[0,1]+R[1,0])/s; z=(R[0,2]+R[2,0])/s
    elif R[1,1]>R[2,2]:
        s = np.sqrt(1+R[1,1]-R[0,0]-R[2,2])*2; w=(R[0,2]-R[2,0])/s; x=(R[0,1]+R[1,0])/s; y=.25*s; z=(R[1,2]+R[2,1])/s
    else:
        s = np.sqrt(1+R[2,2]-R[0,0]-R[1,1])*2; w=(R[1,0]-R[0,1])/s; x=(R[0,2]+R[2,0])/s; y=(R[1,2]+R[2,1])/s; z=.25*s
    q = np.array([x,y,z,w]); return q/np.linalg.norm(q)

# quaternions as [x,y,z,w], arrays (...,4)
def qmul(a, b):
    ax,ay,az,aw = a[...,0],a[...,1],a[...,2],a[...,3]; bx,by,bz,bw = b[...,0],b[...,1],b[...,2],b[...,3]
    return np.stack([aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx, aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz], -1)
def qinv(a): return a*np.array([-1,-1,-1,1.])
def qnorm(a): return a/np.linalg.norm(a,axis=-1,keepdims=True)
def qrot(q, v):
    qv = np.concatenate([v, np.zeros(v.shape[:-1]+(1,))], -1); return qmul(qmul(q, qv), qinv(q))[...,:3]
def qfix(q):
    """make quaternion sequence hemisphere-continuous"""
    q = q.copy()
    for i in range(1, len(q)):
        if np.dot(q[i], q[i-1]) < 0: q[i] = -q[i]
    return q
def qslerp(a, b, t):
    d = np.sum(a*b, -1, keepdims=True); b = np.where(d<0, -b, b); d = np.abs(d)
    d = np.clip(d, -1, 1); th = np.arccos(d); s = np.sin(th)
    w1 = np.where(s>1e-6, np.sin((1-t)*th)/np.where(s>1e-6,s,1), 1-t); w2 = np.where(s>1e-6, np.sin(t*th)/np.where(s>1e-6,s,1), t)
    return qnorm(w1*a + w2*b)
def q2mat(q):
    x,y,z,w = q[...,0],q[...,1],q[...,2],q[...,3]
    return np.stack([np.stack([1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],-1), np.stack([2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],-1), np.stack([2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)],-1)],-2)
def qaxis_angle(axis, ang):
    axis = np.asarray(axis,float); axis = axis/np.linalg.norm(axis); return np.concatenate([axis*np.sin(ang/2), [np.cos(ang/2)]])

def resample(times, vals, t_new, quat=False):
    """linear (slerp for quats) resample onto t_new"""
    idx = np.clip(np.searchsorted(times, t_new, side='right')-1, 0, len(times)-1); idx2 = np.minimum(idx+1, len(times)-1)
    dt = times[idx2]-times[idx]; f = np.where(dt>1e-9, (t_new-times[idx])/np.where(dt>1e-9,dt,1), 0.)[:,None]
    f = np.clip(f,0,1)
    if quat: return qslerp(vals[idx], vals[idx2], f)
    return vals[idx]*(1-f) + vals[idx2]*f

def write_glb(path, gj, binblob):
    js = json.dumps(gj, separators=(',',':')).encode()
    js += b' '*((4-len(js)%4)%4); bb = binblob + b'\0'*((4-len(binblob)%4)%4)
    out = struct.pack('<4sII', b'glTF', 2, 12+8+len(js)+8+len(bb)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(bb), 0x004E4942) + bb
    open(path,'wb').write(out)

class BinBuilder:
    def __init__(self): self.buf = bytearray(); self.views = []; self.accs = []
    def add(self, arr, typ, target=None, minmax=False):
        arr = np.ascontiguousarray(arr, dtype=np.float32)
        while len(self.buf)%4: self.buf.append(0)
        off = len(self.buf); self.buf += arr.tobytes()
        self.views.append({'buffer':0,'byteOffset':off,'byteLength':arr.nbytes})
        a = {'bufferView':len(self.views)-1,'componentType':5126,'count':int(arr.shape[0]),'type':typ}
        if minmax: a['min']=arr.reshape(arr.shape[0],-1).min(0).tolist(); a['max']=arr.reshape(arr.shape[0],-1).max(0).tolist()
        self.accs.append(a); return len(self.accs)-1
