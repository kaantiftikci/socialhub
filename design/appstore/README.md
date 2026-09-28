# App Store ekran görüntüleri (mobil tasarım)

Mivelo iPhone uygulaması için tasarım önerisi: 6 App Store ekranı, 1290×2796 (iPhone 6,9" / 6,7" boyutu; App Store
küçük iPhone'lar için kendisi ölçekler). Mobil uygulama henüz yok; ekranlar masaüstü/web arayüzünün iOS uyarlamasıdır
(Inter, mor #6C47FF, lime #D4FF3F, açık zemin, iOS sekme çubuğu + büyük başlık).

| # | Ekran | Başlık |
|---|---|---|
| 1 | Gelen kutusu | Tüm mesajların, tek bir yerde |
| 2 | Sohbet + AI özeti + yanıt taslağı (koyu zemin) | Uzun sohbetler, tek bakışta |
| 3 | Odak: bekleyenler + taslaklar + verdiğin sözler | Senin tarzında yanıt taslakları |
| 4 | Trendyol siparişi (durum çizelgesi) + ürün sorusu | Siparişler ve müşteri soruları |
| 5 | Takvim + mesajdan eklenen etkinlikler + takip | Hiçbir dönüşü kaçırma |
| 6 | Kanallar + gizlilik (koyu zemin) | 20+ uygulama. Verin sende. |

- Kaynak: `template.html` (tek sayfa, her ekran bir `.shot` 430×932 CSS pikseli). Metinleri buradan değiştir.
- Çıktı: kökten `node design/appstore/render.mjs` → `design/appstore/out/NN-*.png` (git'e konmaz).
- Marka simgeleri web arayüzüyle aynı kaynaktan (simple-icons, Font Awesome brands, `apps/web/public/brands`); avatarlar
  demo avatarları (`apps/web/public/demo/avatars`). Yazı tipi Inter (OFL, `fonts/`).
- iMessage yok (iOS'ta üçüncü taraf uygulama iMessage'a erişemez).
