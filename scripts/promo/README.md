# Mivelo tanıtım videosu (reels, 1080×1920, ~46 sn)

Videodaki arayüz ekran görüntüsü değil, **gerçek uygulamadır**: tek dosya demo, bir iframe içinde sanal saatle kare kare
çalıştırılır. İmleç gerçekten tıklar, klavye gerçekten yazar, Enter gerçekten gönderir. Böylece her kare birebir tekrar üretilebilir.

## Çalıştırma

```bash
npm run demo:html                                   # apps/web/dist-single/mivelo-demo.html
python3 scripts/promo/brand-tiles.py <varlık>       # pazaryeri logoları (beyaz zemin temizlenir)
node scripts/promo/capture-assets.mjs <varlık>      # uygulama simgeleri (saydam köşeli)
# <varlık>/fonts: inter-latin(-ext)-opsz-normal.woff2 ve inter-latin(-ext)-wght-normal.woff2 (@fontsource-variable/inter)
node scripts/promo/render.mjs <varlık> mivelo-reel.mp4 --scale 2          # video + müzik + efektler
node scripts/promo/render.mjs <varlık> kareler/ --stills 3,10.5,22        # storyboard kareleri (JPEG)
```

`FFMPEG=/yol` (H.264), `CHROMIUM=/yol` isteğe bağlı.

## Dosyalar

- **`reel.html`**: kompozisyon. Tek nesne sürekli biçim değiştirir: bildirim hapı → logo → uygulama penceresi → logo → CTA.
  - `cam()` kart geometrisini ve kamerayı sürer: odak (`fx/fy` ya da `f: {sel}`) ve ölçek `S`.
  - `mv()` ve `click()` imleci, `typeText()` ve `press()` klavyeyi sürer.
  - `say()` başlıkları kelime kelime bulanıklıktan açar.
  - `inApp()` demoya gelen mesaj düşürür (`window.__miveloDemo.incoming`).
- **`render.mjs`**: yerel sunucu, Playwright sanal saati (`clock.runFor`), gerçek fare ve klavye.
  - iframe'deki CSS animasyonları video zamanına bağlanır (`syncAnims`).
  - Tıklama güvencesi: kamera kayarken imleç hedefi ıskalarsa, hedef DOM üzerinden tıklanır.
  - Çıktı: ffmpeg ile H.264 ve AAC; ses -14 LUFS'e normalleştirilir.
- **`audio.mjs`**: telifsiz, kodla üretilen müzik ve efektler.
  - Müzik: 120 BPM; Am7 – Fmaj7 – Cadd9 – G6; giriş, ana bölüm, 40. sn'de sadeleşme, 44. sn'de final.
  - Efektler: tıklama, tuş, gönder, bildirim, geçiş, onay. `render.mjs`'in topladığı ipuçlarıyla aynı karede çalar.

## Yazı tipi

- Başlıklar waitlist sitesiyle aynı yığını kullanır: `-apple-system`, SF Pro Display. Mac'te render alınırsa SF Pro ile çizilir.
- SF Pro yoksa (Linux/CI) Inter Display (opsz) kullanılır.
- Uygulamanın kendi arayüzü Inter'dir.
