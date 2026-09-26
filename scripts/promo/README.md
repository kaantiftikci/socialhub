# Mivelo tanıtım videosu (Reels / TikTok, 1080×1920)

Gerçek demodan çekilen **masaüstü** ekranlar + kare kare çizilen sahne → H.264 MP4 (30 fps, ~48 sn).

```bash
npm run demo:html                                   # tek dosya demo (apps/web/dist-single)
node scripts/promo/capture-assets.mjs /tmp/promo    # masaüstü ekranları (açık tema, 1440×900 @2×) + sosyal/e-posta simgeleri
python3 scripts/promo/brand-tiles.py /tmp/promo     # pazaryeri logoları (beyaz zemin atılır) + tüm simgelere aynı köşe maskesi
mkdir -p /tmp/promo/fonts && cp node_modules/@fontsource/inter/files/inter-latin{,-ext}-{400,500,600,700,800}-normal.woff2 /tmp/promo/fonts/
FFMPEG=$(npx -y ffmpeg-static) node scripts/promo/render.mjs /tmp/promo mivelo-reel.mp4
```

- Yazı tipi demo ve waitlist ile aynı: **Inter** (yerel woff2; `@fontsource/inter` geçici kurulabilir). Türkçe harfler latin-ext dosyasında.
- `reel.html?a=<varlık klasörü>&play=1` tarayıcıda gerçek zamanlı önizleme.
- Hareketin tamamı `window.render(t)` ile zamanın fonksiyonu (CSS geçişi yok): her kare birebir tekrar üretilir.
  Anahtar kare kuralı: bir karede verilmeyen değer önceki değerini korur. Pencere "kamerası": `cx/cy` (ekran görüntüsünün
  1440×900 CSS koordinatı) görünüm alanının ortasına, `z` kat yakın, `vh` görünüm yüksekliği.
- Müzik yok (Instagram/TikTok'ta hazır müzik eklenir); sahne geçişleri ~3,2 sn'lik vuruşlara göre (≈ 75 BPM'in 4 vuruşu).
