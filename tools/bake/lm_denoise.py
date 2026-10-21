# OIDN denoise of the baked atlases (compositor Denoise node), in place -> *_dn.exr
import bpy,sys
for f in sys.argv[sys.argv.index('--')+1:]:
    bpy.ops.wm.read_factory_settings(use_empty=True); sc=bpy.context.scene
    im=bpy.data.images.load(f); sc.render.resolution_x, sc.render.resolution_y = im.size; sc.render.resolution_percentage=100
    sc.use_nodes=True; nt=sc.node_tree; nt.nodes.clear()
    a=nt.nodes.new('CompositorNodeImage'); a.image=im; d=nt.nodes.new('CompositorNodeDenoise'); d.use_hdr=True; d.prefilter='NONE'
    c=nt.nodes.new('CompositorNodeComposite'); nt.links.new(a.outputs[0],d.inputs[0]); nt.links.new(d.outputs[0],c.inputs[0])
    sc.render.image_settings.file_format='OPEN_EXR'; sc.render.image_settings.color_depth='32'; sc.view_settings.view_transform='Standard'
    sc.render.filepath=f.replace('.exr','_dn.exr'); bpy.ops.render.render(write_still=True); print('DENOISED',f,flush=True)
