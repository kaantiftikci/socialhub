"""macOS simgesi: Apple şablonu (1024 tuval, ortada 824 px squircle, 100 px saydam kenar + hafif gölge).
macOS 26 (Tahoe) şablona uymayan simgeyi (bizim eski tam kaplayan yuvarlak kare) gri bir squircle içine koyuyordu → kenarlar gri.
Kaynak: icons/icon.png (Windows/Linux için tam kaplayan hâli kalır). Çıktı: icons/icon-macos.png → `npx tauri icon` ile yalnız icon.icns.
Kullanım: python3 apps/desktop/scripts/mac-icon.py   (Pillow gerekir)"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

here = Path(__file__).resolve().parent.parent / 'src-tauri' / 'icons'
src = Image.open(here / 'icon.png').convert('RGBA')
S, BOX, OFF = 1024, 824, 100
SS = 4  # kenar yumuşatma için 4 kat büyük çiz

def squircle(size, n=5.0):
    """Apple'ın 'continuous corner' biçimine yakın süper elips maskesi."""
    big = size * SS
    m = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(m)
    r = big / 2
    pts = []
    import math
    for i in range(720):
        t = 2 * math.pi * i / 720
        c, s = math.cos(t), math.sin(t)
        x = r + r * math.copysign(abs(c) ** (2 / n), c)
        y = r + r * math.copysign(abs(s) ** (2 / n), s)
        pts.append((x, y))
    d.polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)

mask = squircle(BOX)
# iç: marka limesi zemin + eski simgenin içeriği (köşe saydamlıkları limeyle dolar)
lime = src.getpixel((S // 2, 5))
inner = Image.new('RGBA', (BOX, BOX), lime)
art = src.resize((BOX, BOX), Image.LANCZOS)
inner.alpha_composite(art)
inner.putalpha(mask)

out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sh = Image.new('RGBA', (BOX, BOX), (0, 0, 0, 90))
sh.putalpha(mask.point(lambda a: a * 90 // 255))
shadow.paste(sh, (OFF, OFF + 10), sh)
shadow = shadow.filter(ImageFilter.GaussianBlur(16))
out.alpha_composite(shadow)
out.alpha_composite(inner, (OFF, OFF))
out.save(here / 'icon-macos.png')
print('yazıldı:', here / 'icon-macos.png')
