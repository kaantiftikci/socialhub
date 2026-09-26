# Mivelo — Claude için proje notları

Birleşik gelen kutusu masaüstü uygulaması (quicker.chat'ten esinlenmiş, daha gelişmiş): WhatsApp, Telegram, Slack, iMessage,
LinkedIn, X, Instagram, Messenger, e-posta (Gmail/Outlook/Yahoo/iCloud/IMAP) ve Shopier siparişleri tek yerde. Yerel öncelikli,
ücretsiz (hiçbir ücretli servis yok), AI destekli (isteğe bağlı Anthropic anahtarı). Sahibi: Kaan (Türkiye, geliştirici).
Dil: arayüz ve yorumlar Türkçe.

## Kaan'ın çalışma tercihleri
- Onay sorma, ilerle; belirsizlikte en makul yorumu seç ve ne yaptığını söyle.
- Yeni npm bağımlılığı eklersen **açıkça** "npm install gerekli" de.
- Ekran görüntüsü/log gelirse kök nedeni bul, yama yapma; birden fazla sorunu tek turda topluca çöz.
- Değişiklik sonrası: `npm run typecheck`, `npm run build -w packages/core`, `npm run build -w apps/web`; mümkünse demo
  modunda (`npm run demo`) Playwright ile görsel doğrulama.

## Test ve doğrulama
- `npm test -w packages/core` — sahte sayfa nesnesiyle strateji birim testleri (Slack: client.counts/conversations.list/history biçimlendirme,
  before, conversations.mark). Yeni strateji mantığı için buraya test ekle.
- `node scripts/verify-strategy.mjs <slack|instagram|linkedin|x|messenger>` — canlı oturumun profil KOPYASIYLA (uygulamaya dokunmadan)
  threads/messages/before doğrulaması. Önce `npm run build -w packages/core`.

## Yapı
- `packages/core` — Node 22, TypeScript ESM. SQLite (better-sqlite3 + FTS5) `~/.kavsak/kavsak.db`; oturumlar
  `~/.kavsak/sessions/<hesapId>/`. REST + WS sunucu 127.0.0.1:7788 (`server.ts`). `registry.ts` hesap↔connector.
  Ortak model `model.ts` (Account/Chat/Message/Participant/Attachment; Chat.handle/link/participants/meta).
  Connector arayüzü `connectors/base.ts` (start(opts)/stop/sendText, isteğe bağlı fetchMedia/openDirect/logout/action/loadHistory).
- `apps/web` — Vite + React 19, açık tema (Inter, mor #6c47ff, lime #d4ff3f). `App.tsx` (liste/filtre/kanallar/ayarlar),
  `Conversation.tsx` (mesajlar, arama, medya penceresi, sağ ayrıntı paneli + Shopier sipariş kartı), `Connect.tsx`
  (kanal bağlama, formlar), `ui.tsx` (marka ikonları: simple-icons + Font Awesome brands), `desktop.ts` (Tauri köprüsü, sesler).
- `apps/desktop` — Tauri 2 kabuğu (`src-tauri/src/lib.rs`): tray, Dock rozeti, ⌘⇧K, çekirdeği `node` ile başlatır ve bekçiyle
  izler; paketli sürümde `scripts/bundle-core.mjs` çekirdeği kendi `node_modules`'üyle `core-bundle/`e koyar
  (Resources/core). Günlükler: `~/.kavsak/desktop.log`, `~/.kavsak/core.log`. Release'te devtools açık.
- Komutlar: `npm run dev` (çekirdek+Vite), `npm run demo`, `npm run desktop` (Tauri dev), `npm run app` (paketle + aç; `scripts/open-app.mjs`).
- **Herkese açık demo** (`VITE_STATIC_DEMO=1`, `static-demo.ts`): main'e push → `.github/workflows/deploy-demo.yml` FTP ile
  `mivelo.app/` klasörüne (cPanel hesabı kaantiftikci.com; eski mivelo.kaantiftikci.com alt alanı kaldırıldı; demo hesapları `~/mivelo-data`, `public/api/index.php`).
  Demoda örnek AI açık (`demo-ai.ts`: sohbete özel taslak/özet/aksiyon/olay, model çağrısı yok); pazaryeri sipariş kartı `Script.order`.
  Tek dosya demo (`npm run demo:html`) profil adı "Mivelo".
- **Windows**: `tauri.windows.conf.json` (NSIS, currentUser, yerel başlık çubuğu) Tauri'nin platform yapılandırma birleştirmesiyle
  uygulanır; paket yalnız CI'da üretilir (`.github/workflows/build-windows.yml`: workflow_dispatch + `v*` etiketi, windows-latest,
  `KAVSAK_BUNDLE_NODE=1` ile node.exe `core-bundle/bin/`e gömülür, kabuk önce onu dener). `lib.rs`: kısayol Ctrl+Shift+K,
  rozet yok (okunmamış sayısı tepsi ipucunda), tepside renkli simge, node `CREATE_NO_WINDOW`. Çekirdekte OS farkları
  `packages/core/src/platform.ts` (`openExternal`, `killProcessesMatching`, `IS_WINDOWS`…). DB anahtarı Windows'ta DPAPI
  (PowerShell ProtectedData, CurrentUser) → `~/.kavsak/db.key.dpapi`; Linux'ta `db.key` dosyası. Oturum klasörlerinde `:` → `_`
  (yalnız Windows). Mac'e özgü kalanlar: iMessage (arayüzde "Yalnız Mac"), macOS Kişiler, Anahtar Zinciri, Dock rozeti.
  Linux'ta `cargo check --target x86_64-pc-windows-msvc` çalışır (webkit gerekmez; `src-tauri/core-bundle/` klasörü var olmalı);
  gerçek Windows cihaz testi yapılmadı.

## Connector'lar ve kritik bilgiler
- **WhatsApp** (`connectors/whatsapp.ts`, Baileys 7.0.0-rc14): `browser: ['Mac','Mivelo','1.0']` + `syncFullHistory: true`.
  ASLA `Browsers.macOS(...)` + syncFullHistory birlikte kullanma (DARWIN kimliği → sunucu 428 ile anında kapatır).
  LID↔numara eşlemesi grup üyeliklerinden ve `chats.phoneNumberShare`'dan öğrenilir; kopya sohbetler `store.mergeChats` ile
  birleşir. Rehber adları geç gelirse macOS Kişiler (`contacts-mac.ts`) yedek. Medya istek üzerine indirilir
  (`/api/media/<hesap>?u=wa:<jid>/<id>`), sesli mesaj ffmpeg varsa mp3. Kaldırınca `logout()` telefondan da düşürür.
- **Tarayıcı köprüsü** (`connectors/browser/bridge.ts`, Playwright kalıcı profil): ilk girişte görünür pencere, giriş
  algılanınca kapanır ve görünmez (headless, `channel: 'chromium'`) devam eder; açılışta pencere fırlatmaz (interactive=false).
  Stratejiler: `instagram.ts` (direct_v2, xma paylaşımlar → ek), `x.ts` (1.1 DM uçları, twid çerezi = kimlik, video mp4),
  `linkedin.ts` (sayfanın yaptığı GraphQL isteklerini yakalayıp yeniden kullanır; queryId sabit yazılmaz),
  `slack.ts` (localStorage `localConfig_v2` xoxc + `d` çerezi, `client.counts`), `messenger.ts` (DOM okuma; en kırılgan).
  Çerezli medya `fetchMedia` ile vekilden geçer, `~/.kavsak/sessions/<hesap>/media` önbelleği.
- **Telegram** (GramJS): api_id/api_hash Bağlan formundan (token dosyası JSON); giriş QR ile (`tg://login?token`), 2FA parolası prompt.
- **iMessage**: `~/Library/Messages/chat.db` salt okunur + AppleScript gönderim; Tam Disk Erişimi yoksa Sistem Ayarları bölmesini açar.
- **E-posta** (`connectors/mail.ts`): imapflow + nodemailer + mailparser; thread = sohbet. Gmail: uygulama şifresi ya da
  Google OAuth (Desktop client id+secret, `/oauth/callback`); Outlook: Azure client id + cihaz kodu (pencere otomatik açılır/kapanır).
- **Gmail (tarayıcı)** (`connectors/browser/gmail.ts`): varsayılan yol; görünür pencerede Google girişi, sonra Gmail web DOM'u (tr.zA satırları,
  div.adn iletileri, span.aZo ekleri) okunur; yanıt Gmail düzenleyicisiyle. IMAP/uygulama şifresi yalnızca token dosyası varsa (registry).
- **Shopier** (`connectors/shopier.ts`): resmi API `https://api.shopier.com/v1`, `Authorization: Bearer <PAT>`, 200 istek/dk.
  Sipariş = sohbet; olaylar mesaj; `action('fulfill')` → `PUT /orders/{id}`. API'de mesajlaşma ucu YOK.
- Trendyol/Hepsiburada/Etsy/Shopify: yalnızca kart (`available: false`), connector yok.

## Üretkenlik özellikleri
- **Takip hatırlatıcısı**: `chats.followup` {at, since, due}; `POST /api/chats/:id/followup {at|null}`. Sunucu dakikada bir
  `store.checkFollowUps()`: `since` sonrası karşı taraftan mesaj gelirse kendiliğinden kapanır, süre dolunca bir kez
  `chat.followup` olayı (bildirim). Arayüz: sağ panel "Takip hatırlatıcısı", sohbet üstü şerit, listede "Takip" sekmesi.
- **Görünümler**: ⌘1 Tümü, ⌘2… etiketler (Windows'ta Ctrl; `MOD_KEY`); ayrı çip satırı yok (sol kenar çubuğundaki Etiketler aynı işi görür,
  düğme ipucunda kısayol yazar); sıra `DEFAULT_TAGS` + kullanılanlar.
- **Takvime ekle**: `POST /api/calendar` → `calendar.ts` .ics (kayan yerel saat); yerelde `openExternal` ile takvim uygulamasında
  açılır, uzakta/demoda indirilir. Ön doldurma `apps/web/src/when.ts` (Türkçe tarih/saat tahmini); AI taslağı `events` da döndürür.
- **Senin tarzında taslak**: `style.ts` kullanıcının kendi mesajlarından yerel üslup profili (uzunluk, sen/siz, emoji, açılış/kapanış);
  `store.styleSamples` gelen→yanıt çiftleri (önce aynı sohbet, sonra platform, sonra hepsi). `ai.ts` @anthropic-ai/sdk ile
  yapılandırılmış çıktı (json_schema). `GET /api/style` profil satırları.

## Sunucu/arayüz sözleşmesi
- CORS: localhost/127.0.0.1/tauri.localhost/tauri://localhost ve WKWebView'ın `null` kaynağı (paketli uygulama!).
- keepAliveTimeout 120 s (WebKit "Load failed" önlemi); arayüz `api.ts` ağ hatasında bir kez yeniden dener; açılışta 45 s
  "Çekirdek başlatılıyor…" bekler.
- Olaylar WS `/ws`: account.status/qr/prompt, chat.upsert/delete, message.upsert, log. `GET /api/logs` son 200 günlük satırı.
- Tauri'de `confirm()`/`alert()` çalışmaz; onaylar arayüz içinde.

## Bilinen açık konular
- Slack (tarayıcı): giriş penceresinde Google/e-posta girişi yetmez; kullanıcı listeden **çalışma alanını açmalı** (`d` çerezi ancak o zaman
  yazılır). Bağlantı akışı `slack.com/signin?redir=/gantry/auth…` üzerinden.
- iMessage: Tam Disk Erişimi ad-hoc imzalı pakette her derlemede düşebilir (cdhash değişir); kalıcı çözüm sabit imza kimliği.
- WhatsApp: rehberde olmayan LID kişileri ("WhatsApp kişisi") ancak canlı mesaj (sender_pn/pushName) gelince ad kazanır; eşlemeler
  `sessions/<hesap>/names.json`'da kalıcı. 45 grup adı gelmiyor (muhtemelen ayrılınan gruplar).
- Telegram: varsayılan api_id/api_hash Telegram Desktop'ın açık kimliği (config.ts); kullanıcı isterse Bağlan formundan kendi kimliğini verir.
- WhatsApp sesli mesaj ffmpeg yoksa ogg (WebKit oynatmayabilir).
- Yol haritası: Node'suz tek dosya paketleme (sidecar), ⌘K komut paleti, SQLCipher, kişi birleştirme (aynı kişi farklı
  platformlarda), Trendyol/Hepsiburada/Etsy/Shopify connector'ları, Shopier panel mesajları (DOM üzerinden).

## Performans notları (Eylül 2026'da öğrenildi)
- `messages` tablosu 150 bin+ satır: gönderen bazlı UPDATE'ler için `messages_sender` indeksi şart; toplu yazımlar
  `store.transaction()` içinde. WhatsApp `refreshNames` debounce'lu (1.5 sn) ve gönderen imzası önbellekli; her olayda
  anında tam tarama olay döngüsünü dakikalarca kilitliyordu (REST yanıt vermiyordu, arayüz "Load failed").
- Arayüz WS olaylarını 150 ms pencerede toplulaştırır (App.tsx queueChat); geçmiş eşitlemesinde binlerce olay gelir.
- Messenger: messenger.com çerezler olsa da "<Ad> Olarak Devam Et" ara sayfasında kalır; strateji bunu tıklar. Mesajlar
  `[role=main] [role=log] [data-scope=messages_table]` ve aria-label "tarih, Gönderen: metin" ile okunur.
- X: Kasım 2025 sonrası sohbetler uçtan uca şifreli "XChat" (/i/chat); 1.1 DM uçlarında görünmez. Strateji sohbet listesini ve
  mesajları /i/chat DOM'undan (`dm-conversation-item-*`, `message-*`/`message-text-*`) okur, API ile birleştirir; gönderim API
  reddederse `dm-composer-textarea`. WhatsApp rehber adları `resyncAppState(['critical_unblock_low',…])` ile geliyor.
- Yerel API belirteci: ~/.kavsak/token; Tauri `core_token` komutu → `x-kavsak-token` başlığı / ws `?token=`. Yerel origin'ler
  (localhost/tauri) belirteçsiz; `null` ve yabancı origin belirteç ister.
- LinkedIn: Rest.li `variables=(...)` içinde URN'deki parantezler %28/%29 olmalı (encodeURIComponent bunları kodlamaz → 400).
