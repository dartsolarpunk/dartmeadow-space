# Pack the Blender bakes -> runtime maps (assets/bt-pbr/): <set>-color (sRGB, cavity AO multiplied in),
# <set>-nrm (tangent-space normal from the tileable height), <set>-orm (R=AO, G=roughness, B=metalness; glTF layout). 2K + 1K WebP.
import os, sys; os.environ['OPENCV_IO_ENABLE_OPENEXR'] = '1'
import cv2, numpy as np
from PIL import Image
RAW, OUT = sys.argv[1], sys.argv[2]; os.makedirs(OUT, exist_ok=True)
def rd(n): return np.load(f'{RAW}/{n}.npy')
def blur(a, s): p = int(4 * s); return cv2.GaussianBlur(np.pad(a, p, mode='wrap'), (0, 0), s)[p:-p, p:-p]
def srgb(x): x = np.clip(x, 0, 1); return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)
def save(a, name, q):
    im = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))
    im.save(f'{OUT}/{name}-2k.webp', quality=q, method=6)
    im.resize((1024, 1024), Image.LANCZOS).save(f'{OUT}/{name}-1k.webp', quality=q, method=6)
for s in ('hull', 'temple', 'altar', 'trim'):
    col = rd(f'{s}_color'); r = rd(f'{s}_rough')[..., 0]; m = rd(f'{s}_metal')[..., 0]; h = rd(f'{s}_height')[..., 0]
    pass   # exr2npy already wrote rows top-down (glTF v=0 at top)
    ao = np.clip(1 - np.maximum(blur(h, 6) - h, 0) * 3.0, 0.45, 1)             # cavity occlusion (seams, panel gaps)
    k = 6.0; hp = np.pad(h, 1, mode='wrap')
    dx = (hp[1:-1, 2:] - hp[1:-1, :-2]) * k; dy = (hp[2:, 1:-1] - hp[:-2, 1:-1]) * k
    n = np.dstack([-dx, dy, np.ones_like(h)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    save(srgb(col * ao[..., None]), f'{s}-color', 86)
    save(n * 0.5 + 0.5, f'{s}-nrm', 90)
    save(np.dstack([ao, np.clip(r, 0.04, 1), np.clip(m, 0, 1)]), f'{s}-orm', 88)
    print(s, 'ok')
