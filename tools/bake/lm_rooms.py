# (v129) room list for the baked glass reflections: per light group (nav, mess, crew, store, engine, bay, cmd, hall) the
# centroid of its LIGHT_* markers (glTF root space) and the lamps themselves. Output: rooms.json (input of lm_cubes.py)
import sys, json, numpy as np, pygltflib
sys.path.insert(0, __file__.rsplit('/', 1)[0])
g = pygltflib.GLTF2().load(sys.argv[1]); out = sys.argv[2]
def local(n):
    if n.matrix: return np.array(n.matrix, dtype=np.float64).reshape(4, 4).T
    T = np.eye(4); t = n.translation or [0, 0, 0]; r = n.rotation or [0, 0, 0, 1]; s = n.scale or [1, 1, 1]
    x, y, z, w = r; R = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    T[:3, :3] = R*np.array(s); T[:3, 3] = t; return T
lamps = []; alt = None
def walk(i, M):
    global alt
    n = g.nodes[i]; W = M @ local(n); e = n.extras or {}
    if n.name and n.name.startswith('LIGHT_') and e.get('light'): lamps.append(dict(name=n.name, group=e.get('group', 'hall'), color=e['light'], pos=W[:3, 3].tolist()))
    for c in (n.children or []): walk(c, W)
for r in g.scenes[g.scene or 0].nodes: walk(r, np.eye(4))
rooms = {}
for L in lamps: rooms.setdefault(L['group'], []).append(L['pos'])
rooms = {k: dict(c=np.mean(v, 0).tolist()) for k, v in rooms.items()}
json.dump(dict(lamps=lamps, rooms=rooms), open(out, 'w'), indent=1)
print(len(lamps), 'lamps', {k: [round(x, 2) for x in v['c']] for k, v in rooms.items()})
