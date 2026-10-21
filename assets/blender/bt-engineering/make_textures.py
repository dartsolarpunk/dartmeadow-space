"""Procedural textures for the Bird Temple engineering office (run with system python3: PIL + numpy).
atlas.png   512x512: 8x8 patches of 64 px, felt/fabric/metal, plus a yarn gradient for Madison's hair.
screen.png  512x320: terminal UI (emissive).
Patch indices are shared with build_office.py (PATCHES)."""
import numpy as np, os, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
D = os.path.dirname(os.path.abspath(__file__)); T = os.path.join(D, 'tex')
F = '/usr/share/fonts/truetype/sand-box/google/'
rng = np.random.default_rng(7)
PATCHES = {  # name: (index, rgb, kind)
  'skin':(0,(236,190,160),'felt'), 'suit':(1,(22,22,30),'felt'), 'cyan':(2,(60,240,235),'felt'), 'magenta':(3,(240,70,210),'felt'),
  'eye':(4,(70,38,20),'felt'), 'eyewhite':(5,(250,248,240),'felt'), 'lip':(6,(214,120,120),'felt'), 'freckle':(7,(176,110,80),'felt'),
  'desk':(8,(34,40,54),'metal'), 'desktop':(9,(52,58,74),'metal'), 'dark':(10,(14,16,22),'metal'), 'steel':(11,(120,128,142),'metal'),
  'mat':(12,(24,24,30),'rubber'), 'pin':(13,(235,40,110),'plastic'), 'white':(14,(240,240,236),'plastic'), 'blush':(15,(240,150,150),'felt'),
  'g_cyan':(16,(80,255,245),'glow'), 'g_magenta':(17,(255,70,220),'glow'), 'g_violet':(18,(170,120,255),'glow'), 'g_amber':(19,(255,190,90),'glow'),
  'hair':(24,None,'hair'),  # 4 patches wide row 3 (24..27)
}
S, P = 512, 64
def patch_rect(i): return (i % 8) * P, (i // 8) * P
img = np.zeros((S, S, 3), np.float32)
for name, (i, col, kind) in PATCHES.items():
  x0, y0 = patch_rect(i)
  if kind == 'hair':
    w = P * 4; yy = np.linspace(0, 1, P)[:, None]; xx = np.arange(w)[None, :]
    top, bot = np.array([40, 95, 255]), np.array([165, 60, 230])
    c = top * (1 - yy[..., None]) + bot * yy[..., None]
    ply = 0.78 + 0.22 * np.abs(np.sin(xx * 0.9 + yy * 25))[..., None]          # twisted-yarn plies
    c = c * ply * (0.92 + 0.08 * rng.random((P, w, 1)))
    img[y0:y0 + P, x0:x0 + w] = np.broadcast_to(c, (P, w, 3)); continue
  c = np.array(col, np.float32)
  n = rng.random((P, P, 1))
  if kind == 'felt':
    fib = np.array(Image.fromarray((rng.random((P, P)) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), np.float32)[..., None] / 255
    t = c * (0.86 + 0.22 * fib + 0.06 * n)
    # running stitch near the patch rim (reads as seams on the plush)
    for k in range(4, P - 4, 6):
      for (a, b) in ((k, 3), (k, P - 4), (3, k), (P - 4, k)):
        t[b, a:a + 3] = np.minimum(c * 1.35 + 30, 255)
  elif kind == 'metal':
    br = np.array(Image.fromarray((rng.random((P, P)) * 255).astype(np.uint8)).resize((P, 4)).resize((P, P)), np.float32)[..., None] / 255
    t = c * (0.9 + 0.15 * br + 0.04 * n)
  elif kind == 'rubber':
    t = c * (0.9 + 0.1 * n); yy, xx = np.mgrid[0:P, 0:P]; t[((xx + yy) % 8 == 0)] *= 1.6
  else:
    t = c * (0.96 + 0.04 * n)
  img[y0:y0 + P, x0:x0 + P] = t
Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(os.path.join(T, 'atlas.png'))

# terminal screen
W, H = 512, 320
im = Image.new('RGB', (W, H), (3, 14, 22)); d = ImageDraw.Draw(im)
def font(path, size):   # any Google-fonts install works; falls back to PIL's default
  try: return ImageFont.truetype(F + path, size)
  except Exception: return ImageFont.load_default()
mono = font('JetBrains Mono/JetBrainsMono-VariableFont_wght.ttf', 13)
big = font('Exo 2/Exo2-VariableFont_wght.ttf', 22)
CY, MG, VI = (111, 247, 234), (255, 90, 220), (180, 160, 255)
for y in range(0, H, 3): d.line([(0, y), (W, y)], fill=(5, 20, 30))
d.rectangle([6, 6, W - 7, H - 7], outline=CY, width=2)
d.text((18, 12), 'BIRD TEMPLE // ENGINEERING', font=big, fill=CY)
d.text((W - 150, 18), 'REACTOR  OK', font=mono, fill=(125, 255, 168))
d.line([(18, 44), (W - 18, 44)], fill=MG, width=2)
random.seed(3)
lines = ['> core.flux      %.2f GW' % 4.71, '> ring.sync      LOCKED', '> coolant        98.6 %', '> hull.stress    nominal',
         '> warp.field     STANDBY', '> nav.uplink     dartmeadow.space', '> plush.morale   MAX  <3', '> log: madison@eng  online']
for i, s in enumerate(lines): d.text((20, 54 + i * 18), s, font=mono, fill=CY if i % 3 else VI)
# graph
gx, gy, gw, gh = 300, 60, 190, 110
d.rectangle([gx, gy, gx + gw, gy + gh], outline=(40, 110, 120))
pts = [(gx + i * gw / 40, gy + gh / 2 + 36 * np.sin(i * 0.5) * np.cos(i * 0.13)) for i in range(41)]
d.line(pts, fill=MG, width=2)
pts = [(gx + i * gw / 40, gy + gh / 2 + 22 * np.cos(i * 0.31)) for i in range(41)]
d.line(pts, fill=CY, width=1)
# bars
for i in range(12):
  h = 20 + random.random() * 70; x = 300 + i * 16
  d.rectangle([x, 290 - h, x + 10, 290], fill=CY if i % 2 else MG)
d.text((20, 210), 'SYS', font=big, fill=MG)
for i in range(6): d.rectangle([20 + i * 42, 244, 54 + i * 42, 264], outline=CY, fill=(10, 60, 70) if i % 2 else (60, 15, 55))
d.text((20, 280), 'uptime 1042:17:08   temp 21.4 C', font=mono, fill=(60, 140, 150))
im = im.filter(ImageFilter.SMOOTH)
glow = im.filter(ImageFilter.GaussianBlur(3))
im = Image.blend(im, glow, 0.25)
im.save(os.path.join(T, 'screen.png'))
print('ok')
