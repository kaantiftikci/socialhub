# mivelo-bridge

Beeper'ın açık kaynak [mautrix](https://github.com/mautrix) köprülerini — WhatsApp, Instagram, Messenger, X, LinkedIn,
Slack — **Matrix sunucusu olmadan**, kullanıcının kendi bilgisayarında çalıştıran yardımcı süreç. Mivelo çekirdeği
(`packages/core/src/connectors/mautrix/`) bu süreci başlatır ve stdin/stdout üzerinden JSON satırlarıyla konuşur.

- `shim.go`, `intent.go`: bridgev2'nin beklediği "Matrix" katmanı; odalar = sohbetler, olaylar çekirdeğe iletilir
- `nets.go`: ağlar ve Mivelo'ya özel ayar farkları (ör. WhatsApp'ta bağlı cihaz adı "Mivelo")
- `login.go`: bridgev2 giriş adımları (QR, çerez, bilgi) çekirdeğe aynen aktarılır
- `actions.go`: gönder, tepki, düzenle, sil, okundu, yazıyor, eski mesajlar, medya, yeni sohbet
- `rid.go`: mesaj kimliği ↔ çekirdeğin kimliği (WhatsApp'ta eski bağlayıcıyla aynı kimlik)
- `media.go`: medya istek üzerine indirilir (`<veri>/bridge/<ağ>/media`)
- `fake_net.go`: testler için sahte ağ (yalnız `MIVELO_FAKE_NET=1`)

Derleme: `npm run bridge:build` (Go 1.26+, CGO: SQLite ve webp için C derleyicisi). Test: `go test ./...`.

## Lisans

Bu klasör mautrix köprülerini (GNU AGPL-3.0) içerdiği için **GNU AGPL-3.0** altındadır (bkz. `LICENSE`).
Kaynak kodu bu depoda herkese açıktır.
