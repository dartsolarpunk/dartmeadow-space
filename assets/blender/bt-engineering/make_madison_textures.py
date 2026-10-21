"""Madison v2 textures (system python3: PIL + numpy). Run before build_madison.py.
  tex/madison_face.png   1024x512  head colour (equirect: u = azimuth, front at u=.5; v = elevation) — skin felt,
                                   freckles, peach lips, brows, blush, nostrils
  tex/madison_eye.png    256       glossy amber-brown iris (planar UV per eye)
  tex/madison_felt_n.png 512       tiling felt/fleece nap normal map (fibres)
  tex/madison_suit.png   1024      body colour (black fleece, zipper, stitched seams drawn by build_madison.py's UV dump)
"""
import os, math, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
D = os.path.dirname(os.path.abspath(__file__)); T = os.path.join(D, 'tex')
rng = np.random.default_rng(42)
def blur(a, r): return np.array(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)), np.float32)

# ---------- face (equirect) ----------
W, H = 1024, 512
def uv(az, el):   # degrees → pixel (az 0 = front, + = her left = image right when facing her)
    return (0.5 + az / 360.0) * W, (0.5 - el / 180.0) * H
skin = np.array([244, 186, 152], np.float32)   # warm peach felt
fib = blur(rng.random((H, W)) * 255, 1.0)[..., None] / 255
img = skin * (0.9 + 0.16 * fib + 0.03 * rng.random((H, W, 1)))
im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)); d = ImageDraw.Draw(im, 'RGBA')
# blush
for s in (-1, 1):
    x, y = uv(s * 30, -16)
    for r in range(46, 0, -2): d.ellipse([x - r * 1.3, y - r * 0.8, x + r * 1.3, y + r * 0.8], fill=(235, 130, 120, 5))
# freckles across nose + cheeks
rs = np.random.default_rng(7)
for k in range(70):
    az = rs.normal(0, 17); el = -12 + rs.normal(0, 4.2)
    if abs(az) < 4 and el > -15: continue
    x, y = uv(az, el); r = 1.6 + rs.random() * 1.8
    d.ellipse([x - r, y - r, x + r, y + r], fill=(150, 88, 62, 150 + int(rs.random() * 80)))
# brows: thick dark-brown arcs, slightly angled
for s in (-1, 1):
    pts = [uv(s * a, 13 + 3.0 * math.sin(math.radians((a - 13) / 28 * 180))) for a in np.linspace(13, 41, 24)]
    for i, (x, y) in enumerate(pts):
        w = 5.6 - 3 * (i / 23) ** 1.5
        d.ellipse([x - w, y - w * 0.62, x + w, y + w * 0.62], fill=(52, 30, 22, 235))
# nose shading + nostrils
x, y = uv(0, -12); d.ellipse([x - 9, y - 6, x + 9, y + 6], fill=(205, 140, 115, 70))
for s in (-1, 1): x, y = uv(s * 3.2, -15); d.ellipse([x - 3, y - 1.8, x + 3, y + 1.8], fill=(140, 80, 65, 160))
# lips (peach, small, full lower lip)
x, y = uv(0, -25)
d.ellipse([x - 21, y - 3, x + 21, y + 12], fill=(230, 140, 118, 255))     # lower
d.polygon([(x - 22, y + 2), (x - 9, y - 9), (x, y - 5), (x + 9, y - 9), (x + 22, y + 2), (x, y + 3)], fill=(212, 120, 102, 255))   # upper (cupid's bow)
d.line([(x - 21, y + 2), (x, y + 4), (x + 21, y + 2)], fill=(150, 70, 62, 255), width=2)
d.ellipse([x - 6, y + 2, x + 4, y + 6], fill=(255, 210, 195, 90))       # gloss
im = im.filter(ImageFilter.SMOOTH)
im.save(os.path.join(T, 'madison_face.png'))

# ---------- eye (iris) ----------
S = 256; yy, xx = np.mgrid[0:S, 0:S] / (S - 1) * 2 - 1; r = np.hypot(xx, yy); a = np.arctan2(yy, xx)
iris = np.zeros((S, S, 3), np.float32)
amber = np.array([196, 120, 40.]); brown = np.array([92, 46, 16.]); dark = np.array([30, 14, 6.])
t = np.clip(r / 0.92, 0, 1)[..., None]
streak = (0.94 + 0.06 * np.sin(a * 38 + rng.random() * 3)[..., None]) * (0.9 + 0.1 * rng.random((S, S, 1)))
iris = (amber * (1 - t) ** 0.7 + brown * (1 - (1 - t) ** 0.7)) * streak
iris[r > 0.80] = iris[r > 0.80] * 0.55 + dark * 0.45                     # limbal ring
iris[r > 0.92] = dark
iris[r < 0.36] = dark * 0.6                                                # pupil
iris[(xx + 0.32) ** 2 + (yy + 0.34) ** 2 < 0.035] = [255, 250, 240]        # catch-lights
iris[(xx - 0.28) ** 2 + (yy - 0.30) ** 2 < 0.008] = [255, 245, 230]
Image.fromarray(np.clip(blur(iris, 0.8), 0, 255).astype(np.uint8)).save(os.path.join(T, 'madison_eye.png'))

# ---------- tiling felt nap normal ----------
N = 512
h = np.zeros((N, N), np.float32)
for k in range(2600):   # short random fibres, wrapped
    x0, y0 = rng.random(2) * N; ang = rng.random() * math.pi; L = 6 + rng.random() * 18
    for s in np.linspace(0, 1, int(L)):
        x = int(x0 + math.cos(ang) * L * s) % N; y = int(y0 + math.sin(ang) * L * s) % N; h[y, x] += 1
h = np.array(Image.fromarray(np.clip(h * 60, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.9)), np.float32) / 255
h += 0.35 * blur(rng.random((N, N)) * 255, 3) / 255
gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 2.2; gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 2.2
n = np.dstack([-gx, gy, np.ones_like(h)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).save(os.path.join(T, 'madison_felt_n.png'))

# ---------- suit normal: nap tiled 6x over the shared UV layout + stitched seams on every island border ----------
import sys
if '--seams' in sys.argv and os.path.exists(os.path.join(T, 'madison_seams.json')):
    S2 = 1024
    nap = np.array(Image.fromarray(((h - h.min()) / (np.ptp(h) + 1e-6) * 255).astype(np.uint8)).resize((S2 // 6 + 1, S2 // 6 + 1)), np.float32) / 255
    hh = np.tile(nap, (7, 7))[:S2, :S2] * 0.6
    seam = Image.new('L', (S2, S2), 0); sd = ImageDraw.Draw(seam)
    st = Image.new('L', (S2, S2), 0); td = ImageDraw.Draw(st)
    for (a, b) in json.load(open(os.path.join(T, 'madison_seams.json'))):
        x0, y0 = a[0] * S2, (1 - a[1]) * S2; x1, y1 = b[0] * S2, (1 - b[1]) * S2
        sd.line([(x0, y0), (x1, y1)], fill=255, width=3)                       # groove
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 1e-3: continue
        ux, uy = (x1 - x0) / L, (y1 - y0) / L; px, py = -uy, ux
        for k in np.arange(2.0, L - 1.0, 7.0):                                  # running stitch, both sides of the seam
            cx, cy = x0 + ux * k, y0 + uy * k
            for sgn in (-1, 1):
                ox, oy = cx + px * 4.5 * sgn, cy + py * 4.5 * sgn
                td.line([(ox - ux * 2, oy - uy * 2), (ox + ux * 2, oy + uy * 2)], fill=255, width=2)
    g = np.array(seam.filter(ImageFilter.GaussianBlur(1.6)), np.float32) / 255
    sti = np.array(st.filter(ImageFilter.GaussianBlur(0.7)), np.float32) / 255
    hh = hh - 0.9 * g + 0.55 * sti
    gx = (np.roll(hh, -1, 1) - np.roll(hh, 1, 1)) * 2.4; gy = (np.roll(hh, -1, 0) - np.roll(hh, 1, 0)) * 2.4
    n = np.dstack([-gx, gy, np.ones_like(hh)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).save(os.path.join(T, 'madison_suit_n.png'))
print('ok')

# ---------- v2 atlas (one felt material): 2048x1024 colour + normal ----------
#   u 0..0.5            suit layout (body + boots), seams in the normal
#   u 0.5..1, v .5..1   face (equirect head)
#   u 0.5..1, v 0..0.5  four 256-px patches: mitten, zipper, lash/liner, scalp
ATLAS_PATCHES = [('mitten', (238, 178, 146)), ('zip', (40, 40, 46)), ('lash', (22, 12, 10)), ('scalp', (14, 30, 120))]
if '--atlas' in sys.argv:
    AW, AH = 2048, 1024
    col = np.zeros((AH, AW, 3), np.float32)
    nap512 = np.array(Image.open(os.path.join(T, 'madison_felt_n.png')).convert('RGB'), np.float32)
    def tile(w, h, rep):
        t_ = np.array(Image.fromarray(nap512.astype(np.uint8)).resize((max(1, w // rep), max(1, h // rep))), np.float32)
        return np.tile(t_, (rep + 1, rep + 1, 1))[:h, :w]
    nrm = np.zeros((AH, AW, 3), np.float32)
    fz = blur(rng.random((AH, AW)) * 255, 1.0)[..., None] / 255
    col[:, :1024] = np.array([24, 24, 27.]) * (0.85 + 0.3 * fz[:, :1024])          # black fleece
    nrm[:, :1024] = np.array(Image.open(os.path.join(T, 'madison_suit_n.png')).convert('RGB').resize((1024, 1024)), np.float32)
    col[:512, 1024:] = np.array(Image.open(os.path.join(T, 'madison_face.png')).convert('RGB').resize((1024, 512)), np.float32)
    nrm[:512, 1024:] = tile(1024, 512, 3)
    for i, (nm_, c) in enumerate(ATLAS_PATCHES):
        x0 = 1024 + i * 256
        col[512:, x0:x0 + 256] = np.array(c, np.float32) * (0.88 + 0.24 * fz[512:, x0:x0 + 256])
        nrm[512:, x0:x0 + 256] = tile(256, 512, 2)
    Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(os.path.join(T, 'madison_atlas.png'))
    Image.fromarray(np.clip(nrm, 0, 255).astype(np.uint8)).save(os.path.join(T, 'madison_atlas_n.png'))
    nt_ = np.zeros((1, 2, 3), np.uint8); nt_[0, 0] = (40, 230, 255); nt_[0, 1] = (230, 50, 255)
    Image.fromarray(nt_).save(os.path.join(T, 'madison_neon.png'))
    print('atlas ok')
