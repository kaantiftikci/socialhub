"""Pazaryeri logolarını tanıtım videosu için temizler: beyaz zemin atılır, aynı yuvarlatılmış köşe maskesi (saydam köşe).
   python3 scripts/promo/brand-tiles.py <varlık klasörü>   (Pillow gerekir)
Çıktı: chip-<ad>.png (256×256, RGBA). Shopify çantası zeminsiz, n11 kendi yuvarlak biçiminde kalır."""
import os
import sys
from PIL import Image, ImageChops, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', 'apps', 'web', 'public', 'brands')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'assets')
S = 256
RADIUS = 0.28  # uygulamadaki Chip köşesi (s × 0.3) ile uyumlu


def rounded(im: Image.Image) -> Image.Image:
    im = im.resize((S, S), Image.LANCZOS)
    mask = Image.new('L', (S * 4, S * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S * 4 - 1, S * 4 - 1), radius=int(S * 4 * RADIUS), fill=255)
    mask = mask.resize((S, S), Image.LANCZOS)
    out = im.copy()
    out.putalpha(ImageChops.multiply(im.getchannel('A'), mask))
    return out


def crop_nonwhite(im: Image.Image, thr: int = 245) -> Image.Image:
    """Beyaz (ya da saydam) kenar boşluğunu kırp"""
    rgb = Image.new('RGB', im.size, (255, 255, 255))
    rgb.paste(im, mask=im.getchannel('A'))
    diff = ImageChops.difference(rgb, Image.new('RGB', im.size, (255, 255, 255))).convert('L').point(lambda v: 255 if v > 255 - thr else 0)
    box = diff.getbbox()
    return im.crop(box) if box else im


def white_to_alpha(im: Image.Image, thr: int = 238) -> Image.Image:
    """Köşelerden bağlı beyazı saydam yap (logonun içindeki beyaz korunur)"""
    im = im.copy()
    w, h = im.size
    px = im.load()
    seen = set()
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    while stack:
        x, y = stack.pop()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h):
            continue
        seen.add((x, y))
        r, g, b, a = px[x, y]
        if a < 10 or (r >= thr and g >= thr and b >= thr):
            px[x, y] = (r, g, b, 0)
            stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return im


def pad(im: Image.Image, frac: float) -> Image.Image:
    w, h = im.size
    side = int(max(w, h) * (1 + frac))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas.resize((S, S), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
load = lambda n: Image.open(os.path.join(SRC, n + '.png')).convert('RGBA')
tiles = {
    'trendyol': rounded(crop_nonwhite(load('trendyol'))),  # beyaz zemin içindeki turuncu kare
    'hepsiburada': rounded(load('hepsiburada')),
    'etsy': rounded(load('etsy')),
    'amazon': rounded(crop_nonwhite(load('amazon'))),
    'shopier': rounded(crop_nonwhite(load('shopier'))),
    'n11': load('n11').resize((S, S), Image.LANCZOS),  # yuvarlak logo, köşeler zaten saydam
    'shopify': pad(white_to_alpha(load('shopify')), 0.04),  # zeminsiz çanta
}
for name, im in tiles.items():
    im.save(os.path.join(OUT, f'chip-{name}.png'))
    print('chip', name, im.size)

# Uygulamadan çekilen sosyal/e-posta simgeleri: tarayıcı öğeyi alt piksel kaymasıyla kırpabiliyor (176×180, bir köşe kesik) →
# 2 px içeriden kırpıp aynı yuvarlatılmış maskeyi uygula; hepsi tek tip ve köşeleri saydam
for f in sorted(os.listdir(OUT)):
    name = f[5:-4] if f.startswith('chip-') and f.endswith('.png') else None
    if not name or name in tiles:
        continue
    im = Image.open(os.path.join(OUT, f)).convert('RGBA')
    w, h = im.size
    inset = max(2, round(min(w, h) * 0.012))
    im = im.crop((inset, inset, w - inset, h - inset))
    side = min(im.size)
    im = im.crop(((im.size[0] - side) // 2, (im.size[1] - side) // 2, (im.size[0] - side) // 2 + side, (im.size[1] - side) // 2 + side))
    solid = Image.new('RGBA', im.size, (0, 0, 0, 0))
    solid.paste(im, (0, 0))
    solid.putalpha(255)  # simge kendi zemini dolu (marka rengi); köşe maskesi aşağıda
    rounded(solid).save(os.path.join(OUT, f))
    print('yeniden maskelendi', name)
