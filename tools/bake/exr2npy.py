import bpy,sys,numpy as np
a=sys.argv[sys.argv.index('--')+1:]
for f in a:
    im=bpy.data.images.load(f); w,h=im.size; px=np.empty(w*h*4,np.float32); im.pixels.foreach_get(px)
    np.save(f.replace('.exr','.npy'),px.reshape(h,w,4)[::-1])   # top row first
    print('SAVED',f,w,h,float(px.reshape(-1,4)[:,:3].max()))
