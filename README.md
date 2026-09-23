# Kavşak

Tüm mesajlaşma kanalların için **yerel öncelikli, AI destekli tek gelen kutusu**. Çalışma adı; henüz kesinleşmedi.

- Mesajlar ve oturum anahtarları yalnızca bu bilgisayarda (`~/.kavsak`) tutulur; hiçbir sunucuya gitmez.
- Kanallar: **WhatsApp** (QR ile bağlı cihaz), **Telegram** (resmi MTProto), **Slack** (kullanıcı token'ı), **iMessage** (Mac'teki Mesajlar veritabanı),
  **LinkedIn**, **Instagram**, **X** ve **Messenger** (tarayıcı köprüsü: açılan pencerede bir kez giriş yaparsın). 
- AI katmanı isteğe bağlı: `ANTHROPIC_API_KEY` verirsen özet, aksiyon çıkarma ve "senin tarzında" taslak açılır.

## Yapı

```
kavsak/
├─ packages/core      # Node/TypeScript çekirdek: connector'lar, SQLite deposu, yerel API (:7788)
│  └─ src/
│     ├─ model.ts         # ortak veri modeli (Account, Chat, Message, olaylar)
│     ├─ store.ts         # better-sqlite3 + FTS5 arama
│     ├─ connectors/      # base, whatsapp (Baileys), telegram (GramJS), slack, imessage, demo
│     │  └─ browser/      # Playwright köprüsü + linkedin (Voyager), instagram (direct_v2), x (1.1 DM), messenger (DOM)
│     ├─ registry.ts      # hesap ↔ connector yönetimi
│     ├─ ai.ts            # taslak / özet / aksiyon (Claude API)
│     └─ server.ts        # REST + WebSocket (/ws)
├─ apps/web           # Vite + React arayüz
└─ apps/desktop       # Tauri 2 masaüstü kabuğu (menü çubuğu, bildirim, ⌘⇧K, çekirdeği başlatır)
```

## Kurulum

Gereksinimler: Node 22+, macOS/Linux. (`better-sqlite3` ilk kurulumda derlenebilir; Mac'te Xcode Command Line Tools yeterli.)

```bash
npm install
npx playwright install chromium   # LinkedIn / Instagram / X / Messenger için tarayıcı
```

## Çalıştırma

**Demo modu** — hesap bağlamadan arayüzü dene (örnek sohbetler, 45 sn'de bir gelen mesaj simülasyonu):

```bash
npm run demo
# arayüz: http://localhost:5173   (çekirdek: http://127.0.0.1:7788)
```

**Gerçek kanallarla:**

```bash
cp .env.example .env        # gerekirse düzenle
set -a; source .env; set +a  # ya da değişkenleri kendin ver
npm run dev
```

Arayüzde **+ Kanal bağla**:

- **WhatsApp:** Bağlan → telefonda *Ayarlar → Bağlı cihazlar → Cihaz bağla* → QR'ı okut. Cihaz telefonda "Kavşak (Mac)" olarak görünür; tam geçmiş istenir (`syncFullHistory`), telefon sohbet geçmişini gönderir (ilk seferde 1-3 dk sürebilir, Günlük panelinde "geçmiş paketi" satırları akar). WhatsApp'ın gizli LID kimlikleri: grup üyeliklerinden ve `chats.phoneNumberShare` olayından lid↔numara eşlemesi öğrenilir; aynı kişinin lid ve numara olarak açılmış iki sohbeti otomatik birleştirilir. Rehber adları WhatsApp'tan geç gelirse macOS Kişiler (AddressBook, Tam Disk Erişimi gerekir) yedek kaynak olarak kullanılır. Fotoğraf/video/belge/sesli mesajlar istek üzerine indirilir (`/api/media/<hesap>?u=wa:<jid>/<id>`) ve önbelleklenir; sesli mesajlar `ffmpeg` kuruluysa (`brew install ffmpeg`) mp3'e çevrilir, yoksa ogg olarak sunulur (WebKit ogg/opus oynatamayabilir). 90 sn içinde geçmiş gelmezse günlükte uyarı çıkar: telefondan cihazı kaldırıp kanalı Kaldır → yeniden bağla.
- **Telegram:** `TELEGRAM_API_ID` ve `TELEGRAM_API_HASH` gerekir (https://my.telegram.org, ücretsiz). Bağlan → telefon → kod → (varsa) 2FA parolası.
- **Slack:** https://api.slack.com/apps'ten bir uygulama oluştur, *User Token Scopes*'a
  `channels:history groups:history im:history mpim:history channels:read groups:read im:read mpim:read users:read chat:write`
  ekle, kur, `xoxp-…` token'ını yapıştır.

- **iMessage:** Yalnızca macOS. Çekirdeği çalıştıran terminale *Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi* ver. Gönderme, Mesajlar uygulaması üzerinden (AppleScript) yapılır; ilk gönderimde otomasyon izni istenir.
- **Slack:** Bağlan → açılan pencerede app.slack.com'a giriş yap; web istemcisinin oturum anahtarı (xoxc) + çerezle Slack Web API'si kullanılır, uygulama/token üretmek gerekmez. İstersen `~/.kavsak/sessions/<hesap>/token` dosyasına `xoxp-` token yazarak resmi API moduna geçebilirsin.
- **Telegram:** Bağlan → my.telegram.org'dan alınan `api_id`/`api_hash` girilir (bir kez), sonra WhatsApp gibi **QR** çıkar: telefonda Telegram → Ayarlar → Cihazlar → Masaüstü Cihazı Bağla ile okut (`tg://login?token=…`, ~30 sn'de bir yenilenir); iki adımlı doğrulama varsa parola sorulur.
- **iMessage:** chat.db açılamazsa Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi bölmesi otomatik açılır; Kavşak'ı (geliştirmede Terminal'i) ekleyip Yeniden dene.
- **E-posta (Gmail / Outlook / Yahoo / iCloud / diğer IMAP):** IMAP ile okunur, SMTP ile yanıtlanır; her e-posta konuşması bir sohbet. Gmail/Yahoo/iCloud uygulama şifresi ister. Outlook/Microsoft 365 kişisel hesaplarda şifreyle IMAP kapalı olduğundan ücretsiz bir Azure uygulama kimliği (Client ID, public client) girilir; Bağlan deyince kod önceden dolu `microsoft.com/devicelogin` penceresi açılır, giriş yapınca kendiliğinden kapanır. Gmail'de de istersen şifresiz yol var: Google Cloud'da ücretsiz bir "Desktop app" OAuth istemcisi (Client ID + secret) → Bağlan deyince Google giriş penceresi açılır, izin verince `127.0.0.1:7788/oauth/callback` üzerinden kapanır (XOAUTH2). Yenileme anahtarları yerelde `~/.kavsak/sessions/<hesap>/token` içinde.
- **Shopier:** Satıcı panelinde *Hesap Yönetimi → Kişisel Erişim Anahtarı* (2FA gerekli) ile PAT üret, Bağlan formuna yapıştır. Resmi REST API (`https://api.shopier.com/v1`, `Authorization: Bearer <PAT>`, dakikada 200 istek) ile son 60 günün siparişleri 60 sn'de bir çekilir; her sipariş bir sohbet (`#no · alıcı`), sipariş/kargo/iade olayları mesaj olarak akar, sağ panelde sipariş kartı (ürünler, tutar, adres, kargo takibi) ve **Kargoya verildi / Teslim edildi** formu (`PUT /orders/{id}` → `fulfillments`). Shopier API'sinde alıcı-satıcı mesajlaşma ucu yok; sohbete yazılan metin yerel not olarak saklanır.
- **Trendyol, Hepsiburada, Etsy, Shopify:** Bağlan penceresinde "Alışveriş" altında listelenir, connector'lar sırada ("Yakında").
- **LinkedIn / Instagram / X / Messenger:** Bağlan → ayrı bir Chromium penceresi açılır → o pencerede giriş yap (2FA/izin adımları dahil). Giriş algılanıp sayfa durulunca pencere kendiliğinden kapanır ve aynı profil görünmez (headless) modda arka planda 20–30 sn'de bir yoklanır. Oturum `~/.kavsak/sessions/<hesap>/profile` altında kalır; sonraki açılışlarda pencere hiç gösterilmez. Uygulama açılışında giriş penceresi asla kendiliğinden açılmaz: oturum düşmüşse kanal "giriş gerekli" durumuna geçer, kanala sağ tık → **Yeniden bağlan** deyince pencere açılır. Instagram'da paylaşılan gönderi/reel/hikâye görsel önizleme + bağlantı olarak gelir; DM'de gönderilen fotoğraf/videolar (Instagram ve X) çerezli oturumla `GET /api/media/<hesap>?u=<adres>` vekili üzerinden indirilir, `~/.kavsak/sessions/<hesap>/media` altında önbelleklenir ve videolar sohbet içinde oynar.
  - LinkedIn: iç Voyager API'si. Instagram: web istemcisinin `direct_v2` uçları. X: 1.1 DM uçları — X'in yeni uçtan uca şifreli sohbetleri okunamaz, yalnızca eski DM'ler gelir. Messenger: DOM okuma (arayüz değişince seçiciler güncellenmeli).

**Üretim benzeri:** `npm run build && npm start` → çekirdek arayüzü de sunar: http://127.0.0.1:7788

## Masaüstü uygulaması (Tauri)

Gereksinim: Rust (https://rustup.rs) ve Xcode Command Line Tools.

```bash
npm run desktop        # geliştirme: çekirdek + Vite + Tauri penceresi (terminalden)
npm run app            # paketle ve Kavşak.app'i aç (terminalden bağımsız, gerçek uygulama)
npm run desktop:build  # yalnızca paketle: .app + .dmg → apps/desktop/src-tauri/target/release/bundle
```

`npm run app` / `desktop:build` sırasında `scripts/bundle-core.mjs` çekirdeği kendi üretim `node_modules`'üyle
(`apps/desktop/src-tauri/core-bundle`, ~130 MB; ilk seferde `npm install` yapar) uygulama kaynaklarına koyar. Uygulama
açılınca çekirdeği `node Resources/core/dist/index.js` ile kendisi başlatır ve kapanınca durdurur; terminal gerekmez.
Makinede Node 22+ kurulu olmalı — Finder'dan açılan uygulamanın PATH'i kısıtlı olduğundan node Homebrew, nvm, volta, fnm
ve asdf konumlarında aranır, bulunamazsa giriş kabuğuna sorulur (`KAVSAK_NODE=/yol/node` ile de verilebilir). Oturumlar
ve veritabanı geliştirme sürümüyle aynı `~/.kavsak` altında olduğundan bağlı kanallar paketli sürüme aynen taşınır; iMessage
için Tam Disk Erişimi'ni bu kez **Kavşak.app**'e vermek gerekir. Uygulamayı `Applications`'a kopyalayabilirsin
(`.dmg` istersen `npx tauri build --bundles dmg` — Tauri'nin dmg betiği bazen Finder izinleri yüzünden düşer, .app bundan etkilenmez). İmzasız olduğundan ilk açılışta sağ tık → Aç gerekebilir. Uygulama çekirdeği bekçiyle izler (çökerse 10 sn içinde yeniden başlatır); başlatma günlüğü `~/.kavsak/desktop.log`, çekirdek çıktısı `~/.kavsak/core.log`. Paketli sürümde de geliştirici araçları açık: pencerede sağ tık → Inspect Element (ya da ⌥⌘I).

- Menü çubuğunda simge: okunmamış sayısı, göster/gizle, Odak modu, çıkış. Dock rozeti de güncellenir.
- Mesaj göndermek için **Enter** (Shift+Enter yeni satır). **⌘⇧K** pencereyi getirir/gizler; kapat düğmesi pencereyi gizler, uygulama arka planda çalışmaya devam eder.
- Yeni mesajlarda sistem bildirimi (pencere odakta değilse ya da başka sohbet açıksa).
- Bildirimler paketli sürümde Kavşak simgesiyle gelir (geliştirmede macOS bildirimi Terminal'e yazar).

## Yerel API (kısa)

| Yol | Açıklama |
|---|---|
| `GET /api/health` | durum, AI açık mı, sayılar |
| `GET /api/accounts` · `POST /api/accounts {platform, token?}` · `DELETE /api/accounts/:id` | hesaplar |
| `POST /api/accounts/:id/input {kind, value}` | Telegram telefon/kod/parola girişi |
| `GET /api/chats` · `GET /api/chats/:id/messages?limit=&before=` | sohbetler, mesajlar |
| `POST /api/chats/:id/send {text}` · `/read` · `/tags {tags}` · `/history` · `/draft {tone}` | işlemler |
| `GET /api/search?q=` | tam metin arama (FTS5) |
| `WS /ws` | canlı olaylar: `account.status`, `account.qr`, `account.prompt`, `chat.upsert`, `message.upsert` |

`:id` değerleri URL-encode edilir (`encodeURIComponent`).

## Notlar ve riskler

- WhatsApp, LinkedIn, X ve Instagram tarafındaki resmi olmayan yollar platformların kullanım koşullarıyla çelişir; test için ayrı hesap kullan.
- `~/.kavsak/kavsak.db` şu an düz SQLite. Üretimde SQLCipher + Keychain planlanıyor.
- GramJS paketi (`telegram`) arşivlendi; sıradaki sürümde `teleproto` çatalına geçilecek (API uyumlu).

## Marka kullanımı

Platform logoları yalnızca "hangi kanala bağlı" bilgisini vermek için, ilgili marka kurallarına göre gösterilir
(`apps/web/src/ui.tsx` → `BRAND`): WhatsApp/Telegram beyaz-üstü-marka-rengi, Instagram ve Messenger resmi gradyan üzerinde beyaz,
X yalnızca siyah/beyaz ve geniş boşlukla, hiçbiri 18px altında değil. Slack (tek renk, aubergine zemin) ve LinkedIn ("in",
mavi zemin) glifleri Font Awesome Free (CC BY 4.0) marka setinden gelir; simple-icons bu ikisini içermez. Apple'ın Mesajlar simgesi kullanılmaz; iMessage için kendi
balon simgemiz var. Uygulama içinde ve mağaza metinlerinde "bağımsız uygulama, … tarafından onaylanmamıştır" ibaresi bulunur.

## Yol haritası

1. Çekirdeği tek dosyalık sidecar olarak paketleme (Node gerektirmeyen .dmg), ⌘K komut paleti
2. Tarayıcı köprüsünü headless + ağ yakalama ile sağlamlaştırma; Messenger için iç API
3. Kişi birleştirme (aynı kişi, farklı kanallar) ve kural motoru
4. Yerel model seçeneği (llama.cpp / MLX) ve MCP sunucusu
