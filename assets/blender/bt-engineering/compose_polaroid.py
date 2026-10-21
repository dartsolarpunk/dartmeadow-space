"""tex/selfie.png → tex/polaroid.png : classic Polaroid (white border, thick bottom strip, 'Madison' in black Sharpie).
Layout matches the card in build_office.py (0.44 × 0.53, UV 0..1 over the front face)."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
import numpy as np
D = os.path.dirname(os.path.abspath(__file__)); T = os.path.join(D, 'tex')
W, H = 440, 530                                   # 1000 px per unit
side, top, photo = 26, 26, 388                    # square photo, thick bottom strip
card = Image.new('RGB', (W, H), (246, 244, 236))
rng = np.random.default_rng(2)
paper = (np.array(card, np.float32) * (0.97 + 0.03 * rng.random((H, W, 1)))).clip(0, 255).astype(np.uint8)
card = Image.fromarray(paper)
ph = Image.open(os.path.join(T, 'selfie.png')).convert('RGB').resize((photo, photo), Image.LANCZOS)
ph = ImageEnhance.Color(ph).enhance(1.12); ph = ImageEnhance.Contrast(ph).enhance(1.05)
a = np.array(ph, np.float32); yy, xx = np.mgrid[0:photo, 0:photo] / photo - 0.5
vig = 1 - 0.35 * (xx ** 2 + yy ** 2) * 2; a *= vig[..., None]; a = a * 0.94 + np.array([10, 6, 0])   # instant-film warmth
card.paste(Image.fromarray(a.clip(0, 255).astype(np.uint8)), (side, top))
d = ImageDraw.Draw(card)
fp = '/usr/share/fonts/truetype/sand-box/google/Permanent Marker/PermanentMarker-Regular.ttf'
try: f = ImageFont.truetype(fp, 58)
except Exception: f = ImageFont.load_default()
txt = Image.new('L', (W, 140), 0); ImageDraw.Draw(txt).text((W // 2, 70), 'Madison', font=f, fill=255, anchor='mm')
txt = txt.rotate(-3, resample=Image.BICUBIC).filter(ImageFilter.GaussianBlur(0.6))
ink = Image.new('RGB', (W, 140), (14, 14, 18))
card.paste(ink, (0, top + photo + (H - top - photo - 140) // 2 + 4), txt)
# little heart doodle
d.text((W - 92, top + photo + 30), '<3', font=ImageFont.truetype(fp, 30) if os.path.exists(fp) else None, fill=(20, 20, 24))
card = card.resize((384, 464), Image.LANCZOS)   # power-friendly, plenty for a card this size on screen
card.save(os.path.join(T, 'polaroid.png'))
card.save(os.path.join(T, 'polaroid_preview.webp'), quality=88)
print('ok', os.path.getsize(os.path.join(T, 'polaroid_preview.webp')))
