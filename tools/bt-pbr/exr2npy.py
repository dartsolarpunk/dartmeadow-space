import bpy, sys, glob, numpy as np
d = sys.argv[sys.argv.index('--') + 1]
for f in sorted(glob.glob(d + '/*.exr')):
    im = bpy.data.images.load(f); w, h = im.size; a = np.empty(w * h * 4, np.float32); im.pixels.foreach_get(a)
    np.save(f[:-4] + '.npy', a.reshape(h, w, 4)[::-1, :, :3]); bpy.data.images.remove(im)   # top-down rows
