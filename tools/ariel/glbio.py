import json,struct,numpy as np
CT={5120:np.int8,5121:np.uint8,5122:np.int16,5123:np.uint16,5125:np.uint32,5126:np.float32}
NC={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
def read(p):
    d=open(p,'rb').read()
    jl=struct.unpack('<I',d[12:16])[0]; j=json.loads(d[20:20+jl])
    off=20+jl; bl=struct.unpack('<I',d[off:off+4])[0]; binb=d[off+8:off+8+bl]
    return j,bytearray(binb)
def acc(j,b,i):
    a=j['accessors'][i]; bv=j['bufferViews'][a['bufferView']]
    n=NC[a['type']]; dt=np.dtype(CT[a['componentType']]); st=bv.get('byteStride',n*dt.itemsize)
    o=bv.get('byteOffset',0)+a.get('byteOffset',0)
    arr=np.ndarray((a['count'],n),dtype=dt,buffer=b,offset=o,strides=(st,dt.itemsize))
    return arr.copy()
def write(p,j,b):
    js=json.dumps(j,separators=(',',':')).encode()
    js+=b' '*((4-len(js)%4)%4); b=bytes(b); b+=b'\0'*((4-len(b)%4)%4)
    tot=12+8+len(js)+8+len(b)
    with open(p,'wb') as f:
        f.write(struct.pack('<III',0x46546C67,2,tot)); f.write(struct.pack('<II',len(js),0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II',len(b),0x004E4942)); f.write(b)
