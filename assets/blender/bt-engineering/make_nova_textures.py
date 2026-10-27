"""Nova Rustveil textures (system python3: PIL + numpy). Run before build_nova.py.
  tex/nova_face.png  2048x1024  head colour, two equirect halves (u = azimuth, front at the centre of each half):
                                left half eyes open, right half eyes closed (the game blinks by offsetting u by 0.5)
  tex/nova_hair.png  256x512    copper-orange strand card (alpha), opaque centre column for the scalp cap
  tex/nova_wood.png  256        pale lacquered wood grain (arms, hands, ball joints)
"""
import os, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
D = os.path.dirname(os.path.abspath(__file__)); T = os.path.join(D, 'tex'); os.makedirs(T, exist_ok=True)
rng = np.random.default_rng(11)
def blur(a, r): return np.array(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)), np.float32)

# ---------- face ----------
W, H = 1024, 1024
def uv(az, el): return (0.5 + az / 360.0) * W, (0.5 - el / 180.0) * H
skin = np.array([238, 196, 168], np.float32)
n = blur(rng.random((H, W)) * 255, 2.0)[..., None] / 255
base = skin * (0.95 + 0.07 * n)
def face(closed):
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)); d = ImageDraw.Draw(im, 'RGBA')
    for s in (-1, 1):   # soft cheek warmth
        x, y = uv(s * 26, -14)
        for r in range(60, 0, -3): d.ellipse([x - r * 1.2, y - r * 0.8, x + r * 1.2, y + r * 0.8], fill=(225, 140, 120, 4))
    for s in (-1, 1):   # brows: thin, copper-brown, gently arched
        pts = [uv(s * a, 13.5 + 2.5 * math.sin(math.radians((a - 7) / 24 * 180))) for a in np.linspace(7, 31, 30)]
        for i, (x, y) in enumerate(pts):
            w = 4.2 - 2.4 * (i / 29) ** 1.3
            d.ellipse([x - w, y - w * 0.5, x + w, y + w * 0.5], fill=(150, 72, 40, 230))
    for s in (-1, 1):   # eyes (almond)
        cx, cy = uv(s * 17, 1.5); ew, eh = 30, 13
        # socket shadow
        for r in range(10, 0, -1): d.ellipse([cx - ew - r * 2, cy - eh - r * 2.4, cx + ew + r * 2, cy + eh + r], fill=(180, 120, 110, 6))
        if not closed:
            d.ellipse([cx - ew, cy - eh, cx + ew, cy + eh], fill=(248, 244, 240, 255))
            ir = 12.5; ix = cx - s * 1.5
            d.ellipse([ix - ir, cy - ir, ix + ir, cy + ir], fill=(40, 110, 200, 255))
            d.ellipse([ix - ir * 0.75, cy - ir * 0.75, ix + ir * 0.75, cy + ir * 0.75], fill=(70, 150, 230, 255))
            for k in range(24):   # iris fibres
                a = k / 24 * 2 * math.pi; d.line([ix + math.cos(a) * 4, cy + math.sin(a) * 4, ix + math.cos(a) * ir, cy + math.sin(a) * ir], fill=(140, 200, 250, 120), width=1)
            d.ellipse([ix - 5, cy - 5, ix + 5, cy + 5], fill=(12, 14, 22, 255))
            d.ellipse([ix + 3, cy - 8, ix + 8, cy - 3], fill=(255, 255, 255, 240))
            d.arc([cx - ew, cy - eh - 1, cx + ew, cy + eh + 1], 195, 345, fill=(40, 24, 20, 255), width=4)   # upper lash line
            d.arc([cx - ew, cy - eh, cx + ew, cy + eh], 20, 160, fill=(120, 70, 60, 160), width=2)
            for k in range(9):   # lashes
                t = k / 8; a = math.radians(200 + 140 * t); x0, y0 = cx + math.cos(a) * ew, cy + math.sin(a) * eh
                d.line([x0, y0, x0 + math.cos(a) * 6 + s * 2 * t, y0 - 6], fill=(30, 18, 14, 220), width=2)
        else:
            d.ellipse([cx - ew, cy - eh, cx + ew, cy + eh], fill=(225, 180, 155, 255))
            d.arc([cx - ew, cy - eh * 0.4, cx + ew, cy + eh * 1.1], 10, 170, fill=(40, 24, 20, 255), width=4)
    # nose shading + nostrils, lips
    x, y = uv(0, -9)
    for s in (-1, 1): d.ellipse([x + s * 7 - 3, y - 2, x + s * 7 + 3, y + 2], fill=(150, 90, 80, 160))
    x, y = uv(0, -17)
    d.chord([x - 24, y - 9, x + 24, y + 6], 180, 360, fill=(200, 110, 105, 255))
    d.chord([x - 22, y - 6, x + 22, y + 12], 0, 180, fill=(212, 120, 112, 255))
    d.line([x - 22, y, x + 22, y], fill=(130, 60, 60, 220), width=2)
    return im.filter(ImageFilter.GaussianBlur(0.7))
out = Image.new('RGB', (2 * W, H)); out.paste(face(False), (0, 0)); out.paste(face(True), (W, 0))
out.save(os.path.join(T, 'nova_face.png'))

# ---------- hair card ----------
HW, HH = 256, 512
col = np.zeros((HH, HW, 4), np.float32)
for k in range(260):
    x = rng.uniform(4, HW - 4); w = rng.uniform(1.2, 3.2); L = rng.uniform(0.75, 1.0)
    c = np.array([226, 108, 40]) * rng.uniform(0.75, 1.18); c = np.minimum(c, 255)
    xs = np.arange(HW); prof = np.exp(-((xs - x - 3 * np.sin(np.arange(HH)[:, None] / 70 + k)) / w) ** 2)
    a = prof * (np.arange(HH)[:, None] < L * HH)
    col[..., :3] = col[..., :3] * (1 - a[..., None]) + c * a[..., None]
    col[..., 3] = np.maximum(col[..., 3], a)
edge = np.clip(1 - np.abs(np.arange(HW) - HW / 2) / (HW / 2), 0, 1) ** 0.5
col[..., 3] *= edge[None, :]
col[..., 3] = np.where(np.abs(np.arange(HW) - HW / 2)[None, :] < 18, 1, col[..., 3])
col[np.abs(np.arange(HW) - HW / 2)[None, :].repeat(HH, 0) < 18, :3] = np.maximum(col[np.abs(np.arange(HW) - HW / 2)[None, :].repeat(HH, 0) < 18, :3], [170, 75, 30])
col[..., 3] *= np.clip((HH - np.arange(HH)) / 60, 0, 1)[:, None]   # tips fade
Image.fromarray(np.clip(np.dstack([col[..., :3], col[..., 3:] * 255]), 0, 255).astype(np.uint8), 'RGBA').save(os.path.join(T, 'nova_hair.png'))

# ---------- wood ----------
S = 256; y = np.arange(S)[:, None]; x = np.arange(S)[None, :]
g = np.sin((x + 6 * np.sin(y / 23) + 3 * blur(rng.random((S, S)) * 255, 6) / 255 * 20) / 5.5)
w = np.array([228, 190, 156], np.float32) * (0.94 + 0.05 * g[..., None]) * (0.97 + 0.04 * blur(rng.random((S, S)) * 255, 1.5)[..., None] / 255)
Image.fromarray(np.clip(w, 0, 255).astype(np.uint8)).save(os.path.join(T, 'nova_wood.png'))
print('nova textures ok')

# ---------- torso (cylindrical u = azimuth, front at .5; v = (z - 0.44) / 0.42) ----------
TW, TH = 512, 512
u = (np.arange(TW) + 0.5) / TW; v = 1 - (np.arange(TH) + 0.5) / TH
az = (u - 0.5) * 2 * np.pi; z = 0.44 + v[:, None] * 0.42; A = np.abs(az)[None, :]
sx_ = np.abs(np.sin(az))[None, :] * 0.072
def soft(d, w=0.004): return np.clip(0.5 + d / w, 0, 1)
m = np.zeros((TH, TW))
m = np.maximum(m, soft(z - 0.818))
m = np.maximum(m, soft(z - (0.695 + sx_ * 2.1)) * soft(0.05 - sx_, 0.006) * (A < np.pi / 2))      # V-neck
m = np.maximum(m, soft(z - 0.765) * soft(sx_ - 0.056, 0.006))                                     # armholes
m = np.maximum(m, soft(z - 0.79) * (A > np.pi / 2))                                               # back neckline
leath = np.array([10, 9, 9], np.float32) * (0.9 + 0.3 * blur(rng.random((TH, TW)) * 255, 1.2)[..., None] / 255)
seam = (np.abs(z - 0.575) < 0.0035)[..., None] * 25                                                # waist seam
sk = np.array([238, 196, 168], np.float32)
t = leath + seam; t = t * (1 - m[..., None]) + sk * m[..., None]
Image.fromarray(np.clip(t, 0, 255).astype(np.uint8)).save(os.path.join(T, 'nova_torso.png'))
print('torso ok')
