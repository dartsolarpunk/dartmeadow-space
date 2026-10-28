#!/usr/bin/env python3
"""Builds assets/marine/marine.json (species table for ui/dm-marine.js) from the baked GLBs + the creature pack AI data.
Usage: python3 tools/marine/build_manifest.py <pack>/ai/jots-species.json assets/marine
The species table below is the source of truth for marine behaviour/animation; the pack's jots-species.json only
supplies the AI profiles. Output is deterministic (sorted keys)."""
import json, sys, io, os
from pygltflib import GLTF2
from PIL import Image

pack_ai, out = sys.argv[1], sys.argv[2]
P = json.load(open(pack_ai))
bake = json.load(open(os.path.join(out, 'marine-bake.json')))

# anim: mode wave|flap|pulse|sway ; axis x|y (displacement) ; amp = fraction of body extent ; freq rad/s ; k = phase along body
# n = group size, w = pick weight, D = seabed depth (m under surface) where it can live, depth = swim band under surface
# scale = visual scale vs the baked (real-size) model. react: follow = keeps 'curious' alive for a passing rider
S = {}
def F(id, **k): S[id] = k
# ---- Earth ----
F('silver_sardine', set='earth', role='school', n=[22,40], w=5, D=[3,400], depth=[1,16], scale=2.6, anim=dict(mode='wave',axis='x',amp=.10,freq=22,k=5), ai=dict(profile='fish_school_large'))
F('reef_tang', set='earth', role='school', n=[6,12], w=3, D=[1.5,26], depth=[0.6,12], scale=2.4, anim=dict(mode='wave',axis='x',amp=.10,freq=18,k=5), ai=dict(profile='fish_school_small'))
F('reef_clownfish', set='earth', role='school', n=[3,6], w=2, D=[1,13], depth=[0.5,8], scale=3.2, anim=dict(mode='wave',axis='x',amp=.11,freq=20,k=5),
  ai=dict(profile='fish_school_small', over=dict(flee=dict(r=2.5,hold=1.5), curious=dict(r=9,chance=0.7,keep=2.2,maxSpeed=3))))
F('bluefin_tuna', set='earth', role='school', n=[6,12], w=2, D=[8,400], depth=[3,30], scale=1.25, anim=dict(mode='wave',axis='x',amp=.07,freq=13,k=4), ai=dict(profile='fish_school_large', over=dict(walk=2.6,run=7,flee=dict(r=9,hold=2.5),wander=dict(r=50))))
F('bottlenose_dolphin', set='earth', role='solo', n=[2,4], w=1.4, D=[6,400], depth=[0.6,14], scale=1.2, anim=dict(mode='wave',axis='y',amp=.05,freq=8,k=3.5), follow=True, ai=dict(profile='dolphin', over=dict(curious=dict(r=36,chance=0.95,keep=3.5,maxSpeed=14))))
F('green_sea_turtle', set='earth', role='solo', n=[1,2], w=1.2, D=[2.5,120], depth=[0.8,18], scale=1.5, anim=dict(mode='flap',axis='y',amp=.30,freq=4.2,k=1.2), follow=True, ai=dict(profile='turtle', over=dict(curious=dict(r=14,chance=0.6,keep=2.5,maxSpeed=4))))
F('harbor_seal', set='earth', role='solo', n=[1,2], w=0.9, D=[1.8,26], depth=[0.6,10], scale=1.3, anim=dict(mode='wave',axis='y',amp=.06,freq=8,k=3), follow=True, ai=dict(profile='seal', over=dict(curious=dict(r=26,chance=0.8,keep=3,maxSpeed=7))))
F('humpback_whale', set='earth', role='solo', n=[1,1], w=0.55, D=[16,400], depth=[7,34], scale=1.0, anim=dict(mode='wave',axis='y',amp=.05,freq=3.0,k=3), ai=dict(profile='whale', over=dict(curious=dict(r=60,chance=0.7,keep=16,maxSpeed=8))))
F('manta_ray', set='earth', role='solo', n=[1,2], w=1.1, D=[5,400], depth=[2,20], scale=1.5, anim=dict(mode='flap',axis='y',amp=.32,freq=2.6,k=1.4), follow=True, ai=dict(profile='ray_glider', over=dict(curious=dict(r=28,chance=0.7,keep=5,maxSpeed=12))))
F('stingray', set='earth', role='crawler', n=[1,2], w=1.2, D=[1.6,60], depth=[0,0], scale=1.5, anim=dict(mode='flap',axis='y',amp=.28,freq=4.5,k=1.2), ai=dict(profile='ray_bottom'))
F('moon_jelly', set='earth', role='jelly', n=[3,8], w=3, D=[3,400], depth=[0.6,26], scale=2.4, anim=dict(mode='pulse',freq=3.4,radial=.16,lift=.10,amp=.06), ai=dict(profile='jelly_drift'))
F('lantern_jelly', set='earth', role='jelly', n=[2,5], w=1.5, D=[10,400], depth=[8,34], scale=2.2, anim=dict(mode='pulse',freq=2.8,radial=.15,lift=.10,amp=.08), ai=dict(profile='jelly_drift'))
F('shore_crab', set='earth', role='crawler', n=[2,5], w=2, D=[0.45,3.5], depth=[0,0], scale=2.0, anim=dict(mode='flap',axis='y',amp=.05,freq=26,k=3,alt=True), ai=dict(profile='crab'))
F('giant_kelp', set='earth', role='flora', n=[5,10], w=3, D=[4.5,34], scale=[1.0,1.7], anim=dict(mode='sway',amp=.16,freq=1.15,k=2.6,push=1.4))
F('coral_branch', set='earth', role='flora', n=[6,14], w=3, D=[1,15], scale=[1.4,2.4], anim=dict(mode='sway',amp=.05,freq=1.6,k=2.0,push=.3))
F('coral_fan', set='earth', role='flora', n=[4,9], w=2, D=[2,22], scale=[1.4,2.4], anim=dict(mode='sway',amp=.07,freq=1.4,k=2.0,push=.4))
F('sea_anemone', set='earth', role='flora', n=[3,6], w=1.5, D=[0.8,11], scale=[1.4,2.4], anim=dict(mode='sway',amp=.09,freq=1.9,k=2.4,push=.5))
# ---- Alien ----
F('alien_abyss_leviathan', set='alien', role='solo', n=[1,1], w=0.4, D=[22,400], depth=[10,34], scale=1.0, anim=dict(mode='wave',axis='y',amp=.05,freq=2.4,k=3), ai=dict(profile='leviathan', over=dict(curious=dict(r=90,chance=0.7,keep=26,maxSpeed=9))))
F('alien_aurora_ray', set='alien', role='solo', n=[1,3], w=2, D=[4,400], depth=[2,22], scale=1.6, anim=dict(mode='flap',axis='y',amp=.34,freq=2.2,k=1.5), follow=True, ai=dict(profile='ray_glider', over=dict(curious=dict(r=30,chance=0.8,keep=5,maxSpeed=12))))
F('alien_glass_squid', set='alien', role='school', n=[3,6], w=2.4, D=[8,400], depth=[4,32], scale=2.2, anim=dict(mode='pulse',freq=4.0,radial=.12,lift=.14,amp=.10), ai=dict(profile='jelly_swimmer', over=dict(flock=dict(on=True,rad=6,sepR=1.0,coh=.8,ali=1,sep=1,maxN=5,leash=.8))))
F('alien_lantern_angler', set='alien', role='solo', n=[1,2], w=1.4, D=[14,400], depth=[8,34], scale=1.5, anim=dict(mode='wave',axis='x',amp=.06,freq=7,k=3), ai=dict(profile='angler'))
F('alien_lumen_eel', set='alien', role='solo', n=[2,4], w=1.8, D=[4,400], depth=[2,28], scale=1.3, anim=dict(mode='wave',axis='x',amp=.12,freq=9,k=7), ai=dict(profile='eel'))
F('alien_prism_jelly', set='alien', role='jelly', n=[3,6], w=2.4, D=[4,400], depth=[0.8,28], scale=2.2, anim=dict(mode='pulse',freq=3.0,radial=.15,lift=.10,amp=.08), ai=dict(profile='jelly_drift'))
F('alien_spore_drifter', set='alien', role='jelly', n=[4,9], w=2.6, D=[2,400], depth=[0.6,26], scale=2.4, anim=dict(mode='pulse',freq=2.4,radial=.18,lift=.12,amp=.09), ai=dict(profile='jelly_drift'))
F('alien_spire_crab', set='alien', role='crawler', n=[2,4], w=1.5, D=[0.5,6], depth=[0,0], scale=2.2, anim=dict(mode='flap',axis='y',amp=.05,freq=24,k=3,alt=True), ai=dict(profile='crab'))
F('alien_crystal_coral', set='alien', role='flora', n=[5,12], w=3, D=[1,40], scale=[1.4,2.5], anim=dict(mode='sway',amp=.04,freq=1.3,k=2.0,push=.25))
F('alien_glow_kelp', set='alien', role='flora', n=[5,10], w=3, D=[4.5,38], scale=[0.9,1.5], anim=dict(mode='sway',amp=.14,freq=1.0,k=2.6,push=1.4))
F('alien_spore_anemone', set='alien', role='flora', n=[3,7], w=2, D=[1,32], scale=[1.6,2.6], anim=dict(mode='sway',amp=.09,freq=1.7,k=2.4,push=.5))

missing = [k for k in bake if k not in S]; extra = [k for k in S if k not in bake]
assert not missing and not extra, (missing, extra)

def texpx(path):
    g = GLTF2().load(path); n = 0
    for im in g.images:
        data = g.get_data_from_buffer_uri(im.uri) if im.uri else g.binary_blob()[g.bufferViews[im.bufferView].byteOffset: g.bufferViews[im.bufferView].byteOffset + g.bufferViews[im.bufferView].byteLength]
        w, h = Image.open(io.BytesIO(data)).size; n += w * h
    return n

species = {}
for id in sorted(S):
    s = dict(S[id]); b = bake[id]; ai = s.pop('ai', None)
    px = texpx(os.path.join(out, id + '.glb'))
    ent = dict(m=dict(s, file=id + '.glb', bb=[b['min'], b['max']], bytes=b['bytes'], tris=b['tris'], mem=int(px * 4 * 1.34 + b['tris'] * 3 * 32 + 4096)))
    ent['name'] = P['species'][id]['name']; ent['bodyLength'] = P['species'][id]['bodyLength']
    if ai:
        ent['profile'] = ai['profile']; ent['over'] = ai.get('over', {})
        d = s['depth']; ent['depth'] = d
        if 'journal' in P['species'][id]: ent['journal'] = P['species'][id]['journal']
        if 'greeting' in P['species'][id]: ent['greeting'] = P['species'][id]['greeting']
        if P['species'][id].get('lateral'): ent['lateral'] = True
    species[id] = ent
used = sorted({e['profile'] for e in species.values() if 'profile' in e})
man = dict(version=1, profiles={p: P['profiles'][p] for p in used}, species=species)
json.dump(man, open(os.path.join(out, 'marine.json'), 'w'), sort_keys=True, separators=(',', ':'))
print('species', len(species), 'profiles', used, 'bytes', os.path.getsize(os.path.join(out, 'marine.json')),
      'mem(MB) total', round(sum(e['m']['mem'] for e in species.values()) / 1e6, 1))
