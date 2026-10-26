#!/usr/bin/env python3
"""Bake static/earth/earth-biome.png — Earth land-cover fractions for DMEarthPaint (ui/dm-earth-paint.js).

Source: "Land cover IGBP.png" (MODIS MOD12C1 IGBP classes, rendering by T. Hengl, Wikimedia Commons, CC BY-SA 3.0),
3600x1800 equirectangular, row 0 = 90N. Classes are collapsed into five covers and box-averaged to 0.5 deg cells:
  desert (barren), dirt (open/closed shrub, tundra), grass (grassland, savanna, cropland, mosaic),
  forest (needleleaf / deciduous / mixed, and broadleaf poleward of ~30 deg), tropical (evergreen broadleaf).
Output 1440x360 RGB, row 0 = 90N: left 720 cols R=desert G=dirt B=grass; right 720 cols R=forest G=tropical.
Water / snow (both white in the source), borders and grid lines are filled from the nearest classified cell;
unclassified land poleward of 60 deg (white = snow/tundra in the source) is dirt. Ice itself comes from DMEarthIce.
usage: python3 tools/bake/earth-biome.py igbp.png static/earth/earth-biome.png"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

DESERT, DIRT, GRASS, FOREST, TROP = range(5)
ANCHORS = [
    ((170, 170, 170), DESERT),
    ((255, 211, 160), DIRT), ((255, 200, 120), DIRT), ((127, 105, 80), DIRT), ((212, 190, 165), DIRT),
    ((250, 254, 3), GRASS), ((255, 168, 0), GRASS), ((251, 191, 0), GRASS), ((247, 214, 0), GRASS),
    ((202, 254, 143), GRASS), ((255, 178, 40), GRASS), ((255, 189, 80), GRASS),
    ((0, 141, 2), FOREST), ((158, 208, 3), FOREST), ((36, 156, 90), FOREST), ((49, 162, 120), FOREST),
    ((206, 254, 212), FOREST), ((0, 124, 5), FOREST),
    ((0, 249, 10), TROP),
]

def main(src, dst):
    a = np.asarray(Image.open(src).convert('RGB')).astype(np.int32)
    H, W, _ = a.shape
    cols = np.array([c for c, _ in ANCHORS]); cls = np.array([k for _, k in ANCHORS])
    d = ((a[:, :, None, :] - cols[None, None]) ** 2).sum(-1)
    best = d.argmin(-1); lab = cls[best]
    lab[d.min(-1) > 40 ** 2] = -1
    lat = 90 - (np.arange(H) + 0.5) / H * 180
    LAT = np.repeat(lat[:, None], W, 1)
    white = np.all(a == 255, -1)
    polar = (lab == -1) & white & (np.abs(LAT) >= 60)
    # broadleaf evergreen poleward of the tropics is temperate rain forest (Chile, NZ, Japan, SE US)
    lab[(lab == TROP) & (np.abs(LAT) > 30)] = FOREST
    unk = (lab == -1) | polar
    idx = ndimage.distance_transform_edt(unk, return_distances=False, return_indices=True)
    lab = lab[idx[0], idx[1]]
    lab[polar] = DIRT   # after the fill, so the open sea does not carry tundra into lower-latitude coasts
    oh = np.stack([(lab == k).astype(np.float32) for k in range(5)], -1)
    f = 5  # 0.1 deg -> 0.5 deg
    oh = oh.reshape(H // f, f, W // f, f, 5).mean((1, 3))
    oh = ndimage.uniform_filter(oh, size=(3, 3, 1), mode=('nearest', 'wrap', 'nearest'))
    oh /= oh.sum(-1, keepdims=True)
    q = np.round(oh * 255).astype(np.uint8)
    h, w = q.shape[:2]
    out = np.zeros((h, w * 2, 3), np.uint8)
    out[:, :w] = q[..., :3]; out[:, w:, 0] = q[..., 3]; out[:, w:, 1] = q[..., 4]
    Image.fromarray(out).save(dst, optimize=True)
    print(dst, out.shape)

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'igbp.png', sys.argv[2] if len(sys.argv) > 2 else 'static/earth/earth-biome.png')
