# Before/after check: node names + transforms, every accessor's bytes except exterior TEXCOORD_0/TANGENT, POSITION exact.
import json, struct, sys, numpy as np
def load(f):
    b = open(f, 'rb').read(); n = struct.unpack('<I', b[12:16])[0]; return b, json.loads(b[20:20 + n]), 20 + n + 8
(b0, j0, o0), (b1, j1, o1) = load(sys.argv[1]), load(sys.argv[2])
assert len(b0) == len(b1) and o0 == o1, 'size/offset changed'
keys = lambda n: {k: n.get(k) for k in ('name', 'translation', 'rotation', 'scale', 'matrix', 'mesh', 'children', 'extras')}
assert [keys(n) for n in j0['nodes']] == [keys(n) for n in j1['nodes']], 'nodes differ'
for k in ('meshes', 'materials', 'bufferViews', 'scenes', 'skins', 'animations', 'textures', 'images'):
    assert j0.get(k) == j1.get(k), k
changed = {}
for i, (a0, a1) in enumerate(zip(j0['accessors'], j1['accessors'])):
    a0 = {k: v for k, v in a0.items() if k not in ('min', 'max')}; a1 = {k: v for k, v in a1.items() if k not in ('min', 'max')}
    assert a0 == a1
uvtan = set(); pos = set()
for m in j0['meshes']:
    for p in m['primitives']:
        uvtan.update(p['attributes'][k] for k in ('TEXCOORD_0', 'TANGENT') if k in p['attributes']); pos.add(p['attributes']['POSITION'])
def span(j, o, i):
    a = j['accessors'][i]; v = j['bufferViews'][a['bufferView']]; s = o + v.get('byteOffset', 0) + a.get('byteOffset', 0)
    sz = {5126: 4, 5123: 2, 5125: 4, 5121: 1}[a['componentType']] * {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    return s, s + (v.get('byteStride') or sz) * (a['count'] - 1) + sz
mask = np.zeros(len(b0), bool)
for i in uvtan: s, e = span(j0, o0, i); mask[s:e] = True
diff = np.frombuffer(b0, np.uint8)[o0:] != np.frombuffer(b1, np.uint8)[o0:]
outside = diff & ~mask[o0:]
print('nodes', len(j0['nodes']), 'identical; meshes/materials/bufferViews identical')
print('binary bytes changed:', int(diff.sum()), '| changed outside TEXCOORD_0/TANGENT ranges:', int(outside.sum()))
pe = all(b0[slice(*span(j0, o0, i))] == b1[slice(*span(j1, o1, i))] for i in pos)
print('POSITION accessors byte-identical:', pe, f'({len(pos)} accessors)')
assert not outside.any() and pe
print('OK')
others = [i for i in range(len(j0['accessors'])) if i not in uvtan]
assert all(b0[slice(*span(j0, o0, i))] == b1[slice(*span(j1, o1, i))] for i in others)
print('all', len(others), 'non-UV/tangent accessors (positions, indices, colors, normals) byte-identical')
