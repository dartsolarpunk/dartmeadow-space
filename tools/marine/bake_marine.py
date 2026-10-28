#!/usr/bin/env python3
"""Bake the skinned sea-creature GLBs from the creature pack into slim STATIC rest-pose GLBs for GPU-instanced marine life.

The marine system animates on the GPU (a vertex shader: body wave, wing flap, bell pulse, current sway), so it needs only
the rest-pose mesh + its textures; the skeleton, joints/weights and baked clips of the source pack are dropped (≈90% smaller).
Textures are resized to <= MAXTEX px and re-encoded WebP (EXT_texture_webp, read natively by three's GLTFLoader).
Also writes assets/marine/marine-bake.json (per-species bbox / tris / bytes) that tools/marine/build_manifest.py merges.

  python3 tools/marine/bake_marine.py <pack>/creatures/glb assets/marine
"""
import sys, os, io, json, struct
import numpy as np
import pygltflib as G
from PIL import Image

MAXTEX = 512
IDS = """silver_sardine reef_tang reef_clownfish bluefin_tuna bottlenose_dolphin green_sea_turtle harbor_seal humpback_whale
manta_ray stingray moon_jelly lantern_jelly shore_crab giant_kelp coral_branch coral_fan sea_anemone
alien_abyss_leviathan alien_aurora_ray alien_crystal_coral alien_glass_squid alien_glow_kelp alien_lantern_angler
alien_lumen_eel alien_prism_jelly alien_spire_crab alien_spore_anemone alien_spore_drifter""".split()

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

def blob_of(g):
    return g.binary_blob()

def read(g, idx):
    a = g.accessors[idx]; bv = g.bufferViews[a.bufferView]; n = NC[a.type]
    dt = np.dtype(CT[a.componentType]); stride = bv.byteStride or n * dt.itemsize
    base = (bv.byteOffset or 0) + (a.byteOffset or 0); b = blob_of(g)
    out = np.empty((a.count, n), dt)
    for i in range(n):
        out[:, i] = np.ndarray((a.count,), dt, b, base + i * dt.itemsize, (stride,))
    if a.normalized: 
        out = out.astype(np.float32) / (np.iinfo(dt).max if dt.kind == 'u' else np.iinfo(dt).max)
    return out

def node_local(n):
    if n.matrix: return np.array(n.matrix, np.float64).reshape(4, 4).T
    t = np.array(n.translation or [0, 0, 0]); q = n.rotation or [0, 0, 0, 1]; s = np.array(n.scale or [1, 1, 1])
    x, y, z, w = q
    R = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    M = np.eye(4); M[:3, :3] = R * s; M[:3, 3] = t; return M

def world_mats(g):
    W = [None] * len(g.nodes); par = {}
    for i, n in enumerate(g.nodes):
        for c in n.children or []: par[c] = i
    def w(i):
        if W[i] is None:
            W[i] = (w(par[i]) if i in par else np.eye(4)) @ node_local(g.nodes[i])
        return W[i]
    for i in range(len(g.nodes)): w(i)
    return W

class Out:
    def __init__(s):
        s.g = G.GLTF2(); s.g.asset = G.Asset(version='2.0', generator='jots tools/marine/bake_marine.py'); s.b = bytearray()
        s.g.buffers = [G.Buffer()]; s.g.bufferViews = []; s.g.accessors = []; s.g.images = []; s.g.textures = []; s.g.materials = []; s.g.meshes = []
    def view(s, data, target=None):
        while len(s.b) % 4: s.b.append(0)
        s.g.bufferViews.append(G.BufferView(buffer=0, byteOffset=len(s.b), byteLength=len(data), target=target)); s.b += data
        return len(s.g.bufferViews) - 1
    def acc(s, arr, typ, ctype, target, minmax=False):
        a = G.Accessor(bufferView=s.view(arr.tobytes(), target), componentType=ctype, count=len(arr), type=typ)
        if minmax: a.min = arr.min(0).tolist(); a.max = arr.max(0).tolist()
        s.g.accessors.append(a); return len(s.g.accessors) - 1

def tex_of(src, out, cache, tidx):
    if tidx is None: return None
    if tidx in cache: return cache[tidx]
    t = src.textures[tidx]; im = src.images[t.source]
    bv = src.bufferViews[im.bufferView]; raw = bytes(blob_of(src)[(bv.byteOffset or 0):(bv.byteOffset or 0) + bv.byteLength])
    img = Image.open(io.BytesIO(raw)); img.load()
    if max(img.size) > MAXTEX: img.thumbnail((MAXTEX, MAXTEX), Image.LANCZOS)
    img = img.convert('RGBA' if img.mode in ('RGBA', 'LA', 'P') else 'RGB')
    bio = io.BytesIO(); img.save(bio, 'WEBP', quality=80, method=6)
    out.g.images.append(G.Image(mimeType='image/webp', bufferView=out.view(bio.getvalue())))
    out.g.textures.append(G.Texture(source=None, extensions={'EXT_texture_webp': {'source': len(out.g.images) - 1}}))
    cache[tidx] = len(out.g.textures) - 1; return cache[tidx]

def bake(path, dst):
    g = G.GLTF2().load(path); W = world_mats(g); o = Out(); cache = {}; matmap = {}
    tris = 0; bb0 = np.full(3, 1e9); bb1 = np.full(3, -1e9)
    mnode = [i for i, n in enumerate(g.nodes) if n.mesh is not None][0]
    mesh = g.meshes[g.nodes[mnode].mesh]; skin = g.skins[g.nodes[mnode].skin] if g.nodes[mnode].skin is not None else None
    if skin is not None:
        ibm = read(g, skin.inverseBindMatrices).reshape(-1, 4, 4).transpose(0, 2, 1)   # column-major -> row-major
        J = np.stack([W[j] @ ibm[k] for k, j in enumerate(skin.joints)])               # glTF: mesh node transform is ignored
    for p in mesh.primitives:
        pos = read(g, p.attributes.POSITION).astype(np.float64); nor = read(g, p.attributes.NORMAL).astype(np.float64)
        if skin is not None:
            ji = read(g, p.attributes.JOINTS_0).astype(int); wt = read(g, p.attributes.WEIGHTS_0).astype(np.float64)
            wt /= np.maximum(wt.sum(1, keepdims=True), 1e-9)
            P = np.concatenate([pos, np.ones((len(pos), 1))], 1); Nn = np.concatenate([nor, np.zeros((len(pos), 1))], 1)
            op = np.zeros_like(P); on = np.zeros_like(Nn)
            for k in range(ji.shape[1]):
                M = J[ji[:, k]]
                op += wt[:, k:k+1] * np.einsum('nij,nj->ni', M, P); on += wt[:, k:k+1] * np.einsum('nij,nj->ni', M, Nn)
            pos = op[:, :3]; nor = on[:, :3]
        else:
            M = W[mnode]; pos = (np.concatenate([pos, np.ones((len(pos), 1))], 1) @ M.T)[:, :3]; nor = nor @ M[:3, :3].T
        nor /= np.maximum(np.linalg.norm(nor, axis=1, keepdims=True), 1e-9)
        uv = read(g, p.attributes.TEXCOORD_0).astype(np.float32)
        idx = read(g, p.indices).reshape(-1).astype(np.uint32); tris += len(idx) // 3
        bb0 = np.minimum(bb0, pos.min(0)); bb1 = np.maximum(bb1, pos.max(0))
        big = len(pos) > 65535
        prim = G.Primitive(mode=4, attributes=G.Attributes(
            POSITION=o.acc(pos.astype(np.float32), 'VEC3', 5126, 34962, True), NORMAL=o.acc(nor.astype(np.float32), 'VEC3', 5126, 34962),
            TEXCOORD_0=o.acc(uv, 'VEC2', 5126, 34962)), indices=o.acc(idx.astype(np.uint32 if big else np.uint16), 'SCALAR', 5125 if big else 5123, 34963))
        if p.material not in matmap:
            m = g.materials[p.material]; pb = m.pbrMetallicRoughness
            nm = G.Material(name=m.name, alphaMode=m.alphaMode, doubleSided=bool(m.doubleSided), emissiveFactor=m.emissiveFactor or [0, 0, 0],
                            pbrMetallicRoughness=G.PbrMetallicRoughness(baseColorFactor=pb.baseColorFactor, metallicFactor=pb.metallicFactor, roughnessFactor=pb.roughnessFactor))
            t = tex_of(g, o, cache, pb.baseColorTexture.index if pb.baseColorTexture else None)
            if t is not None: nm.pbrMetallicRoughness.baseColorTexture = G.TextureInfo(index=t)
            et = tex_of(g, o, cache, m.emissiveTexture.index if m.emissiveTexture else None)
            if et is not None: nm.emissiveTexture = G.TextureInfo(index=et)
            if m.extensions and 'KHR_materials_emissive_strength' in m.extensions: nm.extensions = {'KHR_materials_emissive_strength': m.extensions['KHR_materials_emissive_strength']}
            o.g.materials.append(nm); matmap[p.material] = len(o.g.materials) - 1
        prim.material = matmap[p.material]; o.g.meshes.append(G.Mesh(primitives=[prim])) if not o.g.meshes else o.g.meshes[0].primitives.append(prim)
    o.g.nodes = [G.Node(mesh=0)]; o.g.scenes = [G.Scene(nodes=[0])]; o.g.scene = 0
    used = ['EXT_texture_webp'] + (['KHR_materials_emissive_strength'] if any(m.extensions for m in o.g.materials) else [])
    o.g.extensionsUsed = used; o.g.extensionsRequired = ['EXT_texture_webp']
    o.g.set_binary_blob(bytes(o.b)); o.g.buffers[0].byteLength = len(o.b); o.g.save_binary(dst)
    return {'tris': int(tris), 'min': [round(float(x), 4) for x in bb0], 'max': [round(float(x), 4) for x in bb1],
            'tex': int(sum(1 for _ in o.g.images)), 'bytes': os.path.getsize(dst)}

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]; os.makedirs(dst, exist_ok=True); info = {}
    for i in IDS:
        info[i] = bake(os.path.join(src, i + '.glb'), os.path.join(dst, i + '.glb')); print(i, info[i])
    json.dump(info, open(os.path.join(dst, 'marine-bake.json'), 'w'), indent=1)
    print('total bytes', sum(v['bytes'] for v in info.values()))
