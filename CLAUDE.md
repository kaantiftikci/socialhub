# Kavşak — Claude için proje notları

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
- Komutlar: `npm run dev` (çekirdek+Vite), `npm run demo`, `npm run desktop` (Tauri dev), `npm run app` (paketle + aç).

## Connector'lar ve kritik bilgiler
- **WhatsApp** (`connectors/whatsapp.ts`, Baileys 6.7.24): `browser: ['Mac','Kavşak','1.0']` + `syncFullHistory: true`.
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
- **Shopier** (`connectors/shopier.ts`): resmi API `https://api.shopier.com/v1`, `Authorization: Bearer <PAT>`, 200 istek/dk.
  Sipariş = sohbet; olaylar mesaj; `action('fulfill')` → `PUT /orders/{id}`. API'de mesajlaşma ucu YOK.
- Trendyol/Hepsiburada/Etsy/Shopify: yalnızca kart (`available: false`), connector yok.

## Sunucu/arayüz sözleşmesi
- CORS: localhost/127.0.0.1/tauri.localhost/tauri://localhost ve WKWebView'ın `null` kaynağı (paketli uygulama!).
- keepAliveTimeout 120 s (WebKit "Load failed" önlemi); arayüz `api.ts` ağ hatasında bir kez yeniden dener; açılışta 45 s
  "Çekirdek başlatılıyor…" bekler.
- Olaylar WS `/ws`: account.status/qr/prompt, chat.upsert/delete, message.upsert, log. `GET /api/logs` son 200 günlük satırı.
- Tauri'de `confirm()`/`alert()` çalışmaz; onaylar arayüz içinde.

## Bilinen açık konular
- Messenger: görünmez modda sohbet listesi bazen boş (Günlük'te "sohbet listesi bulunamadı" satırı var); seçiciler kırılgan.
- WhatsApp sesli mesaj ffmpeg yoksa ogg (WebKit oynatmayabilir).
- Yol haritası: Node'suz tek dosya paketleme (sidecar), ⌘K komut paleti, SQLCipher, kişi birleştirme (aynı kişi farklı
  platformlarda), Trendyol/Hepsiburada/Etsy/Shopify connector'ları, Shopier panel mesajları (DOM üzerinden).
