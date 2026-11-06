#!/usr/bin/env python3
"""Shrink the embedded images of a GLB to at most MAXPX on the long side (memory lane, sw v292).

The phone mansion (assets/ariel-home/ariel-home-512.glb) was named for its 512 px rock maps but still carried fifteen 1024 px images (the ah_slate / concrete / wood /
dark / leaf sets): ~84 MB of mipped RGBA8 on the GPU plus the same again as decoded bitmaps.  Phones/tablets show them at a few centimetres per texel anyway.

  python3 tools/ariel-home/shrink_glb_textures.py assets/ariel-home/ariel-home-512.glb [MAXPX=512]

Only the image payloads change: the glTF JSON keeps every index, sampler, UV and material, so nothing else (GI bake, collision, parallax tile sizes) is affected.
Idempotent: images already <= MAXPX are copied byte for byte.
"""
import sys, json, struct, io
from PIL import Image

def main(path, maxpx=512):
    b = open(path, 'rb').read()
    magic, ver, total = struct.unpack('<4sII', b[:12])
    assert magic == b'glTF' and ver == 2
    jl, jt = struct.unpack('<II', b[12:20]); assert jt == 0x4E4F534A
    J = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl, bt = struct.unpack('<II', b[off:off + 8]); assert bt == 0x004E4942
    bin0 = b[off + 8:off + 8 + bl]
    img_bv = {im['bufferView']: i for i, im in enumerate(J.get('images', [])) if 'bufferView' in im}
    new = io.BytesIO(); changed = 0; before = 0; after = 0
    for bi, bv in enumerate(J['bufferViews']):
        data = bin0[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        if bi in img_bv:
            im = Image.open(io.BytesIO(data)); w, h = im.size; before += len(data)
            if max(w, h) > maxpx:
                k = maxpx / max(w, h); nw, nh = max(1, round(w * k)), max(1, round(h * k))
                is_nrm = any(t.get('index') is not None and J['textures'][t['index']].get('source') == img_bv[bi] for m in J.get('materials', []) for t in [m.get('normalTexture') or {}])
                out = io.BytesIO(); im.convert('RGB' if im.mode != 'RGBA' else 'RGBA').resize((nw, nh), Image.LANCZOS).save(out, 'WEBP', quality=90 if is_nrm else 82, method=6)
                data = out.getvalue(); changed += 1
            after += len(data)
        pad = (-new.tell()) % 4
        new.write(b'\x00' * pad)
        bv['byteOffset'] = new.tell(); bv['byteLength'] = len(data); new.write(data)
    nb = new.getvalue(); nb += b'\x00' * ((-len(nb)) % 4)
    J['buffers'][0]['byteLength'] = len(nb)
    js = json.dumps(J, separators=(',', ':')).encode(); js += b' ' * ((-len(js)) % 4)
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(nb)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(nb), 0x004E4942) + nb
    open(path, 'wb').write(out)
    print(f'{path}: {changed} image(s) resized to <= {maxpx}px, image bytes {before} -> {after}, file {len(b)} -> {len(out)}')

if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 512)
