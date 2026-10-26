# stage 1: GLB -> xatlas lightmap UV2 per primitive (no change to the GLB). Output: /workspace/jots-bake/uv/*
import sys, json, struct, numpy as np, pygltflib, xatlas, os
src=sys.argv[1]; out=sys.argv[2]; RES=int(sys.argv[3]) if len(sys.argv)>3 else 2048
os.makedirs(out,exist_ok=True)
g=pygltflib.GLTF2().load(src); blob=g.binary_blob()
CT={5120:np.int8,5121:np.uint8,5122:np.int16,5123:np.uint16,5125:np.uint32,5126:np.float32}
NC={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
def acc(i):
    a=g.accessors[i]; bv=g.bufferViews[a.bufferView]; dt=np.dtype(CT[a.componentType]); n=NC[a.type]
    off=(bv.byteOffset or 0)+(a.byteOffset or 0); st=bv.byteStride or dt.itemsize*n
    raw=np.frombuffer(blob,dtype=np.uint8,count=st*(a.count-1)+dt.itemsize*n,offset=off)
    arr=np.lib.stride_tricks.as_strided(raw,shape=(a.count,dt.itemsize*n),strides=(st,1)).copy().view(dt).reshape(a.count,n)
    return arr
def local(n):
    if n.matrix: return np.array(n.matrix,dtype=np.float64).reshape(4,4).T
    T=np.eye(4); 
    t=n.translation or [0,0,0]; r=n.rotation or [0,0,0,1]; s=n.scale or [1,1,1]
    x,y,z,w=r; R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    T[:3,:3]=R*np.array(s); T[:3,3]=t; return T
prims=[]
def walk(ni,M):
    n=g.nodes[ni]; W=M@local(n)
    if n.mesh is not None:
        me=g.meshes[n.mesh]
        for pi,p in enumerate(me.primitives):
            if p.mode not in (None,4): continue
            pos=acc(p.attributes.POSITION).astype(np.float64); idx=acc(p.indices).ravel().astype(np.uint32) if p.indices is not None else np.arange(len(pos),dtype=np.uint32)
            nor=acc(p.attributes.NORMAL).astype(np.float64) if p.attributes.NORMAL is not None else None
            wp=(np.c_[pos,np.ones(len(pos))]@W.T)[:,:3]
            wn=None
            if nor is not None: N3=np.linalg.inv(W[:3,:3]).T; wn=nor@N3.T; wn/=np.linalg.norm(wn,axis=1,keepdims=True)+1e-12
            mat=g.materials[p.material] if p.material is not None else None
            prims.append(dict(node=n.name,mesh=me.name,prim=pi,nv=len(pos),pos=wp.astype(np.float32),idx=idx,nor=None if wn is None else wn.astype(np.float32),
              mat=(mat.name if mat else ''),base=(list(mat.pbrMetallicRoughness.baseColorFactor) if mat and mat.pbrMetallicRoughness and mat.pbrMetallicRoughness.baseColorFactor else [0.8,0.8,0.8,1]),
              emis=(list(mat.emissiveFactor) if mat and mat.emissiveFactor else [0,0,0]),blend=(mat.alphaMode if mat else 'OPAQUE')))
    for c in (n.children or []): walk(c,W)
for r in g.scenes[g.scene or 0].nodes: walk(r,np.eye(4))
# skip glass/holo/neon-only: still unwrap everything opaque; transparent (BLEND) skipped
keep=[p for p in prims if p['blend']!='BLEND' and len(p['idx'])>=3]
print('prims',len(prims),'kept',len(keep),'verts',sum(p['nv'] for p in keep))
A=xatlas.Atlas()
for p in keep: A.add_mesh(p['pos'],p['idx'].reshape(-1,3),p['nor'])
co=xatlas.ChartOptions(); co.max_iterations=4; co.normal_deviation_weight=4.0; co.max_cost=2.0
po=xatlas.PackOptions(); po.resolution=RES; po.padding=6; po.bilinear=True; po.texels_per_unit=0
A.generate(co,po)
print('atlases',A.atlas_count,A.width,A.height)
meta=dict(res=[A.width,A.height],pages=A.atlas_count,src=os.path.basename(src),prims=[])
for i,p in enumerate(keep):
    vm,ind,uv=A[i]; page=int(A.get_mesh_vertex_assignement(i)[0][0]) if hasattr(A,'get_mesh_vertex_assignement') else 0
    fn=f'p{i:04d}.npz'; np.savez(os.path.join(out,fn),vm=vm.astype(np.uint32),ind=ind.astype(np.uint32),uv=uv.astype(np.float32),pos=p['pos'][vm],nor=(p['nor'][vm] if p['nor'] is not None else np.zeros((len(vm),3),np.float32)))
    meta['prims'].append(dict(i=i,node=p['node'],mesh=p['mesh'],prim=p['prim'],nv=p['nv'],nv2=int(len(vm)),page=page,mat=p['mat'],base=p['base'],emis=p['emis'],file=fn))
json.dump(meta,open(os.path.join(out,'meta.json'),'w'))
