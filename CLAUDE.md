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
- **Canlı E2E** (`npm run e2e -- <komut>`, `scripts/e2e.mjs`; kullanıcının Mac'inde, `npm run dev` açıkken): `setup` ana ⇄ test hesap/sohbet
  eşleştirmesi (`~/.kavsak/e2e.json`; ikisi de Mivelo'ya bağlı; tek hesapta "elle" mod), `run [--ui] [wa ig …]` gidiş (`#e2e-ID-g`) /
  dönüş (`-d`) turu: gönderim API ms, karşı tarafta görülme ve platform zamanından gecikme, kendi kaydı, kopya, Türkçe/emoji bütünlüğü;
  canlı günlük sınıflandırma (`RULES`: derleme/port/hız sınırı/doğrulama/PIN/oturum/API→HTML/medya…) + hesap durum değişimleri;
  `--ui` Chromium'da duman testi (⌘K, mesaja gidiş, Takvim, konsol/sayfa/istek hataları). `watch` yalnız izleme. Rapor
  `~/.kavsak/e2e/rapor-*.md` → Claude'a yapıştırılır. Bekleyiciler gönderimden ÖNCE kurulur (çekirdek kendi kaydını HTTP yanıtından önce yayar).
  Demo çekirdeği `#e2e-` etiketli mesaja 2 sn'de yankı verir (aracın kendisi demo ile sınanır).
- `npm test -w packages/core` — sahte sayfa nesnesiyle strateji birim testleri (Slack: client.counts/conversations.list/history biçimlendirme,
  before, conversations.mark). Yeni strateji mantığı için buraya test ekle.
- `node scripts/verify-strategy.mjs <slack|instagram|linkedin|x|messenger>` — canlı oturumun profil KOPYASIYLA (uygulamaya dokunmadan)
  threads/messages/before doğrulaması. Önce `npm run build -w packages/core`.

## Yapı
- `packages/core` — Node 22, TypeScript ESM. SQLite (better-sqlite3 + FTS5) `~/.kavsak/kavsak.db`; oturumlar
  `~/.kavsak/sessions/<hesapId>/`. REST + WS sunucu 127.0.0.1:7788 (`server.ts`). `registry.ts` hesap↔connector.
  Ortak model `model.ts` (Account/Chat/Message/Participant/Attachment; Chat.handle/link/participants/meta).
  Connector arayüzü `connectors/base.ts` (start(opts)/stop/sendText, isteğe bağlı fetchMedia/openDirect/logout/action/loadHistory).
- `apps/web` — Vite + React 19, açık + gece modu (Inter, mor #6c47ff, lime #d4ff3f). Tema `theme.ts` (Ayarlar → Görünüm: Sistem/Açık/Koyu,
  localStorage `mivelo.theme`, `<html data-theme>`; index.html'deki satır içi betik ilk karede uygular, Tauri `setTheme`). Renkler YALNIZ
  token'la (`styles.css` :root + `:root[data-theme="dark"]`: --card/--field/--raise/--ctx-bg/--danger*/--warn*/--avN/--tg-*/--scN…); yeni
  stilde sabit açık renk (#fff zemin vb.) yazma. İkon rengi `color="var(--v)"` olabilir (Icon style üzerinden currentColor). `App.tsx` (liste/filtre/kanallar/ayarlar),
  `Conversation.tsx` (mesajlar, arama, medya penceresi, sağ ayrıntı paneli + Shopier sipariş kartı), `Connect.tsx`
  (kanal bağlama, formlar), `ui.tsx` (marka ikonları: simple-icons + Font Awesome brands), `desktop.ts` (Tauri köprüsü, sesler).
- `apps/desktop` — Tauri 2 kabuğu (`src-tauri/src/lib.rs`): tray, Dock rozeti, ⌘⇧K, çekirdeği `node` ile başlatır ve bekçiyle
  izler; paketli sürümde `scripts/bundle-core.mjs` çekirdeği kendi `node_modules`'üyle `core-bundle/`e koyar
  (Resources/core). Günlükler: `~/.kavsak/desktop.log`, `~/.kavsak/core.log`. Release'te devtools açık.
- Komutlar: `npm run dev` (çekirdek+Vite), `npm run demo`, `npm run desktop` (Tauri dev), `npm run app` (paketle + aç; `scripts/open-app.mjs`).
- **Herkese açık demo** (`VITE_STATIC_DEMO=1`, `static-demo.ts`): main'e push → `.github/workflows/deploy-demo.yml` FTP ile
  `demo.mivelo.app/` klasörüne (cPanel hesabı kaantiftikci.com; demo hesapları `~/mivelo-data`, `public/api/index.php`). Aynı iş akışı
  `apps/landing/` (bekleme listesi sayfası, tek dosya `index.html`; iletişim hello@mivelo.app) → `mivelo.app/`; kayıtlar
  `api/waitlist.php` → `~/mivelo-data/waitlist.json` (e-posta tekil ve sıkı biçim, davet kodu `?ref=`, `refs` sayacı, gizli `website`
  bot tuzağı, IP başına 20/saat + günlük 2000). `gizlilik.html`, `kosullar.html`, `og.png`, `apple-touch-icon.png` de burada.
  Landing hero'su: görünüm sekmeleri yalnız sahnenin altındaki `#seg` ("Kendine göre ayarla"; sahnedeki yüzen kopya kaldırıldı); her sekme imleçle ufak bir görev
  oynatır (`TASKS` dizisi, kaplamalar 1440×900 kare koordinatlarında). Telefon/tablette de masaüstü penceresi gösterilir.
- **Yönetim paneli** `mivelo.app/admin` (`apps/landing/admin/`: `index.html` tek sayfa + `api.php`): bekleme listesi (durum
  Bekliyor/Davet edildi/Katıldı/Spam, not, toplu işlem, CSV), trafik (`api/track.php` çerezsiz sayaç → `~/mivelo-data/stats/`),
  demo hesapları (demo `index.php` girişte `logins`/`lastLogin` yazar), görevler, şifre değiştirme, JSON yedek. Varsayılan şifre
  karması `api.php` `DEFAULT_HASH`; panelden değişince `~/mivelo-data/admin.json`. 5 hatalı girişte IP 15 dk kilitlenir.
  Demoda örnek AI açık (`demo-ai.ts`: sohbete özel taslak/özet/aksiyon/olay, model çağrısı yok); pazaryeri sipariş kartı `Script.order`.
  Tek dosya demo (`npm run demo:html`) profil adı "Mivelo".
- **Tanıtım videosu (reels 1080×1920, 48 sn)** `scripts/promo/`: `capture-assets.mjs` (tek dosya demodan açık tema masaüstü ekranları +
  saydam köşeli simgeler) → `brand-tiles.py` (pazaryeri logolarının beyaz zemini atılır, tek tip yuvarlak maske) → `reel.html`
  (`window.render(t)` ile deterministik sahneler; yalnız masaüstü pencereleri, Inter yerel woff2, geçişler çapraz lime/mor silme) →
  `render.mjs` (Playwright kare kare → ffmpeg H.264). Ayrıntı `scripts/promo/README.md`. Müzik yok (Instagram'da eklenir); MP4 depoya konmaz.
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
  `slack.ts` (localStorage `localConfig_v2` xoxc + `d` çerezi, `client.counts`), `messenger.ts` (DOM okuma; en kırılgan; iki adres:
  önce facebook.com/messages, olmazsa messenger.com — Nisan 2026'da kapandı; seçilen adres günlüğe yazılır, `verify-strategy.mjs messenger`
  hangisinin çalıştığını basar; facebook.com düzeni gerçek hesapla henüz doğrulanmadı).
  Çerezli medya `fetchMedia` ile vekilden geçer, `~/.kavsak/sessions/<hesap>/media` önbelleği.
- **Telegram** (teleproto — bakımı süren GramJS fork'u; GramJS Temmuz 2026'da arşivlendi): api_id/api_hash Bağlan formundan (token dosyası JSON); giriş QR ile (`tg://login?token`), 2FA parolası prompt.
- **iMessage**: `~/Library/Messages/chat.db` salt okunur + AppleScript gönderim; Tam Disk Erişimi yoksa Sistem Ayarları bölmesini açar.
- **E-posta** (`connectors/mail.ts`): imapflow + nodemailer + mailparser; thread = sohbet. Gmail: uygulama şifresi ya da
  Google OAuth (Desktop client id+secret, `/oauth/callback`); Outlook: Azure client id + cihaz kodu (pencere otomatik açılır/kapanır).
- **Gmail/iCloud Bağlan**: önce uygulama şifresi formu (IMAP + IDLE, anlık; `MAIL_FORM_FIRST` Connect.tsx), tarayıcı girişi formdaki yedek
  bağlantı. **Gmail (tarayıcı)** (`connectors/browser/gmail.ts`): yedek yol; görünür pencerede Google girişi, sonra Gmail web DOM'u (tr.zA satırları,
  div.adn iletileri, span.aZo ekleri) okunur; yanıt Gmail düzenleyicisiyle. IMAP/uygulama şifresi yalnızca token dosyası varsa (registry).
- **Shopier** (`connectors/shopier.ts`): resmi API `https://api.shopier.com/v1`, `Authorization: Bearer <PAT>`, 200 istek/dk.
  Sipariş = sohbet; olaylar mesaj; `action('fulfill')` → `PUT /orders/{id}`. API'de mesajlaşma ucu YOK.
- **Pazaryerleri**: `trendyol.ts` (resmi Satıcı API: soru-cevap + sipariş), `hepsiburada.ts` (Satıcıya Sor + OMS), `n11.ts` (REST sipariş + SOAP
  soru), `etsy.ts`/`shopify.ts`/`amazon.ts` (resmi API siparişler + tarayıcı köprüsüyle mesaj/inbox; deneysel). Pazaryeri yanıtları
  yalnız metin (arayüz dosya/ses düğmesini gizler). Shopier `available:false` ("Yakında").
  Pazaryeri kanal listesi sekmeleri **Tümü · Siparişler · Sorular** (`types.ts` `shopKind`: meta.order → sipariş, diğerleri soru; sayılar
  `shopPending`: açık sipariş / cevap bekleyen soru). Satırda 📦/❓ işareti (`.skind`); sağ panelde `OrderPanel` ya da `QuestionPanel` (meta.question).
  Trendyol/Hepsiburada/n11/Shopier'de (`ORDER_ONLY_PLATFORMS`, `isOrderPage`) sipariş sohbet DEĞİL: orta alanda `OrderPage` (özet + durum
  geçmişi, yazma alanı yok; API'de sipariş üzerinden alıcıya mesaj ucu yok). Bağlı soru varsa (question.orderNumber) "Soruyu aç". Odak'ta sayılmaz.

## Üretkenlik özellikleri
- **Takip hatırlatıcısı**: `chats.followup` {at, since, due}; `POST /api/chats/:id/followup {at|null}`. Sunucu dakikada bir
  `store.checkFollowUps()`: `since` sonrası karşı taraftan mesaj gelirse kendiliğinden kapanır, süre dolunca bir kez
  `chat.followup` olayı (bildirim). Arayüz: sağ panel "Takip hatırlatıcısı", sohbet üstü şerit, listede "Takip" sekmesi.
- **Genel arama** (⌘K / Ctrl+K, `SearchPalette.tsx`): görünüm/filtreden bağımsız; sohbet adları + FTS5 mesaj metni + ek adları
  (`store.search` LIKE yedeği; `/api/search?limit=` ≤200). "N uygulamada M sonuç", uygulama çipleriyle süzme; mesaja tıklayınca sohbet açılır,
  gerekirse eski mesajlar yüklenir (`focusMsg`), `data-mid` balon ortalanıp `.flash` ile vurgulanır. Liste başındaki arama kutusu ayrıca duruyor.
- WhatsApp arşivi: `meta.archived` (geçmiş paketi `archived`, `chats.update {archived}`, bağlanınca regular_low tam eşitleme; unarchiveChats
  açıksa yeni mesaj arşivden çıkarır). Telegram gibi "Sohbetler · Arşiv" sekmeleri (`ARCHIVE_TABS`), arşivdekiler Tümü'de/gelen kutusunda yok.
- Gelen kutusu sekmeleri Tümü · Okunmamış · Bekleyen (`isWaiting`; birebirler önde, gruplar arkada) · Takip. (Ekip/Pazaryeri
  kenar çubuğu görünümleri kullanıcı isteğiyle KALDIRILDI; yerinde Takvim.)
- **Odak**: "Yanıtla" satır içi yanıt kutusu (Enter gönderir; kart listeden çıkar, "X ile gönderildi"). Taslak yalnız "Taslak yaz" ile
  (SSS sözü: içerik ancak istenince Anthropic'e gider); `aiPrefs.focusAuto` (Ayarlar, varsayılan kapalı) ilk 3'ü önceden hazırlar.
  Söz onayları `mivelo.promisesDone`.
- **Zamanlanmış gönderim çekirdekte** (`scheduled.ts`, `~/.kavsak/scheduled.json`, 15 sn'de bir; `/api/scheduled` GET/POST/DELETE;
  olaylar `scheduled.update`/`scheduled.missed`). Çekirdek kapalıyken 15 dk'dan fazla geçen gönderilmez (kaçırıldı, 7 gün listede,
  Düzenle/Kaldır). Geçici hata 1 dk sonra yeniden (≤3), 400/404/429 kalıcı. Statik demoda tarayıcı kuyruğu (eski localStorage yolu).
- Mesaj üstü düğmeler (`.rpos.p0/p1/p2`): tepki · takvim · takip (2 gün; `.act` açıkken). Bildirim: "Grup ve kanal bildirimleri" anahtarı.
- **Görünümler**: ⌘1 Tümü, ⌘2… etiketler (Windows'ta Ctrl; `MOD_KEY`); ayrı çip satırı yok (sol kenar çubuğundaki Etiketler aynı işi görür,
  düğme ipucunda kısayol yazar); sıra `DEFAULT_TAGS` + kullanılanlar.
- **Mivelo takvimi** (kenar çubuğu → Takvim, `CalendarView.tsx`): ay görünümü + seçili günün ajandası + Yaklaşan; ←/→ ay, T bugün,
  N yeni, çift tık gün → yeni. Çekirdek `events` tablosu (`store.saveEvent/listEvents/deleteEvent`, `/api/events` GET/POST/DELETE,
  olay `events.update`); mesajdan eklenen `chatId/messageId` taşır ("Sohbete git" mesaja kaydırır). Hatırlatma `remindMin`
  (dakikalık döngüde `dueEventReminders`, bir kez; başlangıçtan 30 dk sonrasına kadar) → `event.reminder` bildirimi.
  `EventEditor` (mesaj üstü 📅, AI olayları, Takvim): kaydet = Mivelo takvimi; "Cihazın Takvim uygulamasına da ekle" kutusu
  (`mivelo.calDevice`) aşağıdaki cihaz yolunu kullanır; Dışa aktar = .ics. Demo: bellekte örnek etkinlikler.
- **Takvime ekle**: cihaz takvimine DOĞRUDAN (`calendar-device.ts`): macOS Takvim (JXA/Apple Events; değerler JSON argümanla,
  metne gömülmez), Windows klasik Outlook (COM, PowerShell ortam değişkeniyle). İlk seferde arayüz içi onay (`mivelo.calConsent`),
  ardından `GET /api/calendars?probe=1` macOS izin penceresini tetikler ve yazılabilir takvim adlarını getirir (seçim `mivelo.calName`).
  `POST /api/calendar {mode:'device', calendar}` → `{added, calendar}`; izin reddi `{denied}` (arayüz "Sistem Ayarları'nı aç" →
  `POST /api/calendars/permission`, Otomasyon bölmesi); diğer hatada .ics takvim uygulamasında açılır (`fallback`). Uzak (telefon)
  erişimde .ics indirilir. Demoda taklit (indirme yok). `npm run dev`de izin Terminal adına sorulur. Ön doldurma `apps/web/src/when.ts` (Türkçe tarih/saat tahmini); AI taslağı `events` da döndürür.
- **AI anahtarı**: Ayarlar → AI özellikleri → "Anthropic anahtarı" (`POST /api/ai/key`, yalnız yerel); `secrets.ts` ile Anahtar Zinciri/
  DPAPI/0600 dosyada; ortam değişkeni `ANTHROPIC_API_KEY` yedek. Değer asla geri döndürülmez (yalnız maske).
- **AI özellikleri anahtarları** (Ayarlar → AI özellikleri; `apps/web/src/ai-prefs.ts`, localStorage `mivelo.aiPrefs`): Özetler / Taslaklar /
  Aksiyon çıkarma ayrı ayrı. Taslak kapalıyken `api.draft` yalnızca özet/aksiyon için çağrılır (sağ paneldeki "Özetle"), metin tutulmaz.
  Waitlist'teki "AI senin kontrolünde" kartı bunu anlatır.
- **Senin tarzında taslak**: `style.ts` kullanıcının kendi mesajlarından yerel üslup profili (uzunluk, sen/siz, emoji, açılış/kapanış);
  `store.styleSamples` gelen→yanıt çiftleri (önce aynı sohbet, sonra platform, sonra hepsi). `ai.ts` @anthropic-ai/sdk ile
  yapılandırılmış çıktı (json_schema). `GET /api/style` profil satırları.

## Ban önleme (Eylül 2026 araştırması)
- Tarayıcı köprüsü yoklaması sabit `setInterval` DEĞİL: `bridge.schedule()` her tur ±%30 sapmalı `setTimeout`. Aralıklar (registry):
  LinkedIn 60 sn, X 60 sn, Instagram 30 sn (boşta 120), Messenger 30 sn (anlık sinyal canlıyken seyrekleşir), Slack(tarayıcı) 30 sn, Gmail/iCloud (tarayıcı) odakta 30 sn / boşta 90 sn, Outlook 90 sn. API paralelliği en çok 2.
- Hata sınıfları (`pollInner` catch): checkpoint/captcha/`account/access`/authwall → yoklama durur, durum 'pairing' (otomatik deneme yok);
  429/999/rate limit → üstel bekleme 5→10→20… ≤120 dk (`rateHits`, başarılı turda sıfırlanır).
- WhatsApp 402/403/406 → dur, oturumu SİLME (kısıtlı hesapta yeniden eşleşme yasağı kalıcılaştırabilir); kopmalarda üstel ≤5 dk + sapma.
- Slack: `_x_id` web istemcisinden öğrenilen önekle (`noversion-…`), uygulama adı gönderilmez. xoxp connector'ı: liste 10 dk önbellek,
  tur başına ≤20 `conversations.history` (DM/yakın etkin + dönüşümlü), ~60 sn.
- Info.plist: NSAppleEventsUsageDescription + NSContactsUsageDescription (iMessage/Kişiler TCC istemi).
- X: /i/chat her yoklamada yeniden YÜKLENMEZ (`freshSnapshot`): görünen liste imzası değişmediyse yalnız OPFS yedeği okunur; tam
  yükleme liste değişince ya da 6–9 dk'da bir. LinkedIn: tüm Voyager istekleri `pace()` ile sıralı, aralarında 400–1500 ms; eski sayfa önbelleği 3 sa.
- WhatsApp: `cachedGroupMetadata` + `getMessage` (gönderilen son 500) + `gateSend` (0,8–2 sn aralık, dakikada ≤20).
- `send-guard.ts` (server /send ve /send-file): aynı metin (≥16 kr.) 30 dk'da >5 farklı sohbete → 429. İki günlük sınır: `NEW_LIMIT`
  ilk temas (karşı taraf sohbette hiç yazmamış; server `isNew`) — LinkedIn/Telegram 50, X/Instagram/Messenger 80, WhatsApp 100,
  iMessage 150, Slack 300 farklı sohbet; `DAILY_LIMIT` tüm gönderimler için güvenlik ağı — LinkedIn 350, X 450 (X'in tavanı 500),
  Instagram/Messenger 600, iMessage 1500, WhatsApp/Telegram 2500, Slack 5000. Gün yerel gece yarısında döner; sayaçlar `~/.kavsak/send-guard.json`'da kalıcı. E-posta/pazaryeri muaf.
- WhatsApp arka plan boşluk doldurma varsayılan KAPALI (`MIVELO_WA_GAPFILL=1` ile açılır): her fetchMessageHistory telefonda "… senkronize ediliyor / durduruldu"
  bildirimi çıkarıyor (canlı testte arka arkaya). Eski mesajlar yalnız kullanıcı yukarı kaydırınca (loadHistory). İçeriksiz mesaj için yeniden gönderim
  isteği mesaj başına bir kez (`resend.json`). X: `/i/chat/pin/recovery` = XChat PIN bekleniyor → uyarı, needsWindow/afterLogin ile Yeniden bağlan'da PIN.
- Kullanıcı eylemi bekleyen durum: `Strategy.attention(page)` her yoklamadan sonra (X PIN sayfası, Messenger PIN penceresi) → `Account.attention`
  (kalıcı değil; registry.list connector'dan ekler). Arayüz `accountIssue(a)` (App.tsx): attention / pairing / error / disconnected → kanal
  satırında yeşil nokta yerine yanıp sönen kırmızı uyarı işareti (`.alert-ic`); üzerine gelince/dokununca `.alert-pop` kartı (ne oldu, ne
  yapmalı, düğme: PIN'i gir / Yeniden bağlan → restartAccount, QR'ı göster → Bağlan). 'connecting' uyarı sayılmaz.
- (açıksa) WhatsApp geçmiş boşluğu doldurma tur başına ≤25 istek × 50 mesaj (1,5–4 sn aralık; kalanı 30–45 dk sonra). "unavailable" presence yalnız
  bağlanınca ve gönderim/okundu sonrası tek sefer (`offlineSoon`); 4 dk'lık düzenli zamanlayıcı kaldırıldı (Baileys README: bildirim
  için yalnız `markOnlineOnConnect: false` yeterli).
- Gecikme tanısı (terminal): köprü her turda karşıdan gelen yeni mesaj varsa `<platform>: gecikme X sn — tetik: anlık sinyal|odak|zamanlayıcı
  (mesajdan Y sn sonra), tur Z sn · akış durumu` yazar; iMessage `tetik: izleyici|yedek 15 sn`. "zamanlayıcı" = anlık sinyal kaçırıldı,
  "izleyici"+yüksek gecikme = mesaj Mac'e geç yazıldı. Tur sürerken gelen sinyal artık sabit 10–15 sn değil `soonDelay` (1,5–4 sn, tur
  başlangıçları arası ≥10 sn) bekler.
- Uyarlamalı yoklama: arayüz `POST /api/activity {active}` (App.tsx, odak/görünürlük + dakikada bir) → `activity.ts`. Köprü seçeneği
  `idlePollMs` (Instagram: odakta 30 sn, boşta 2 dk); boştan etkine geçişte bekleyen tur öne çekilir (`pollSoon`).
- LinkedIn anlık akış: `Strategy.watch` → sayfaya init betiği, istemcinin kendi `/realtime/connect` akışının kopyası okunur (fetch/XHR/
  EventSource; kendi bağlantımız YOK). Mesaj konuları → birkaç sn içinde yoklama (≥10 sn arayla); akış canlıyken aralık 3 kat (60→180 sn).
- Slack: Bağlan formu önce resmi yol — manifest bağlantısı (`SLACK_MANIFEST`, Connect.tsx'teki kopyayla aynı; test denetler) ile kendi
  dahili uygulaması, xoxp + isteğe bağlı xapp (Socket Mode: olay gelen sohbet hemen çekilir, yoklama ~5 dk). Belirteç dosyası düz xoxp
  ya da JSON {token, appToken} (`parseSlackToken`). Tarayıcı girişi formdaki "yedek" bağlantısıyla.
  xoxp yolu tarayıcı yoluyla eşit: tepki (reactions.add/remove + Socket Mode reaction_added/removed olayı), okundu (conversations.mark),
  dosya gönderme (getUploadURLExternal → completeUploadExternal), dosya indirme (url_private + Bearer, `fetchMedia`), eski mesajlar
  (history latest), iş parçacığı yanıtları (conversations.replies; tur başına ≤5, thread_ts ile gönderim), birebir aç (conversations.open).
  Yeni kapsamlar (reactions/files/*:write) eski kurulumda yoksa `missing_scope` → "uygulamayı güncelleyip yeniden kur" hatası; metin etkilenmez.
- E-posta (IMAP) okundu: Mivelo'da açılan dizi sunucuda da `\\Seen` (`markRead`; UID'ler alımda tutulur, yoksa Gmail X-GM-THRID ile arama).
- E-posta (IMAP): ikinci uzun ömürlü oturum INBOX'ta IMAP IDLE (imapflow auto-IDLE, `maxIdleTime` 20 dk); 'exists' → 1 sn içinde
  yoklama; kopmada üstel yeniden bağlanma 5 sn → ≤5 dk.
- E-posta tarayıcı yolları canlı liste izler (`Strategy.watchSelector` → `bridge.watchDom`: ilk 6 satırın metni 2 sn'de bir, zaman
  ifadeleri hariç; değişince yoklama). Köprü `keepOpen`: Outlook 'always' (IMAP yok; sürekli açık, ~200-300 MB, yoklama 90 sn → izleyici
  canlıyken 270 sn), Gmail/iCloud tarayıcı 'whileActive' (odakta açık + 30 sn, boşta kapalı + 90 sn).
- Anlık sinyal altyapısı (Eylül 2026 araştırması: mautrix-meta/-twitter/-linkedin kaynakları): `Strategy.watchSockets` → sayfanın KENDİ
  WebSocket çerçeveleri pasif dinlenir (`watchSocketFrames`; soket açılmaz/yazılmaz). Instagram `gateway.instagram.com/ws/lightspeed`,
  Messenger `gateway.facebook.com/ws/lightspeed` + `web-chat-e2ee` (boyut), olay regex'i `LIGHTSPEED_EVENT` (insertMessage/upsertMessage/
  updateThreadSnippet…); X `chat-ws.x.com` (şifreli, ≥96 bayt). Olay → `pollSoon` (≥10 sn arayla, `soonAt` bekleyen turu ertelemez).
  Slack (tarayıcı yolu) `wss-(primary|backup).slack.com` RTM JSON (`"type":"message|*_marked|reaction_*"` olay; presence/typing/pong canlı);
  sayfa `keepOpen:'whileActive'` (Mivelo öndeyken; Slack masaüstünde aktif sayar → telefon bildirimi o sırada durabilir), boşta sayfasız 30 sn.
  Seyrekleşme (`rtSlowdown`) ancak en az bir 'event' görüldükten sonra: Instagram ×10 (yedek 5 dk; sayfa `keepOpen:'always'`),
  LinkedIn ×5, Messenger ×5, X ×3. X tam yeniden yükleme 20–30 dk. LinkedIn `tabBadgeUpdateTopic` yalnız MESSAGING ise olay.
- Pazaryerleri `PollTimer` + `marketDelay` (poll-timer.ts): Trendyol/Hepsiburada/Shopify odakta 30 sn / boşta 60 sn, n11 45/90, Etsy 60/90,
  Amazon 120 sn (getOrders 1/dk). Belgeli sınırlar çok üstte (Trendyol soru/sipariş 1000/dk, HB OMS ~240/dk); webhook'lar genel HTTPS ister.
- 429'da `PollTimer.backoff(retryAfterSec(Retry-After|X-RateLimit-Reset))`: sunucunun istediği süre, art arda gelirse katlanarak ≤30 dk.
  Açık tutulan sayfalar `softReloadHours` (varsayılan 6–10 sa, Instagram 12–20) aralığında bir kez yenilenir (SPA bellek sızıntısı).
  LinkedIn: akışın ClientConnection kimliği değişince (yeniden bağlandı) eşitleme olayı.
- WhatsApp (Baileys araştırması): kimlik deposu `wa-auth.ts` `useAtomicAuthState` (Baileys dosya biçimi, tmp+fsync+rename) +
  `makeCacheableSignalKeyStore`; modül düzeyi `msgRetryCounterCache`/`placeholderResendCache`/`userDevicesCache` (TtlCache). Sürüm
  `waver.json` (son başarılı; web.whatsapp.com → Baileys deposu, asla daha eskisi). 500 artık oturum SİLMEZ (Baileys kodsuz akış hatalarına
  da 500 veriyor; whatsmeow geçici sayar) — yalnız 401/411; 405 → sürüm atılıp bir kez; 402'de bitiş zamanı gösterilir.
  `fetchAccountReachoutTimelock` etkinse karşıdan mesaj gelmemiş sohbete gönderim engellenir. Boşluk doldurma istek başına 50, tur ≤25.
- Telegram: bekçi 60 sn — koptuysa bağlan + `client.catchUp()` (getDifference; kaçanlar olay olarak gelir); tam sohbet taraması 10 dk'da bir
  (eskiden 30 sn'de getDialogs+getHistory). `floodSleepThreshold` 60, `connectionRetries` 10. Çevrimdışı durumu 4 dk'da bir DEĞİL, gönderim/
  okundu sonrası tek sefer. `installMessageBehaviour()` modül yüklenirken (m.sender getter'ları istemcisiz testte de).
- iMessage: `fs.watch(~/Library/Messages)` (chat.db*, 150 ms) + 15 sn yedek; okunmamış ≥5 sn, geri alınan ≥60 sn aralıkla. Gönderim:
  chat id → (-1728'de 1 sn sonra) chat id of hizmet → birebirde participant; zaman aşımında Mesajlar yeniden başlatılıp bir kez. Ekler
  `~/Library/Messages/Attachments/Mivelo`e kopyalanıp gönderilir (5 dk sonra silinir), betikte `delay 1`.
- E-posta: IDLE bağlantısı açıkken yoklama AYNI bağlantıda (getMailboxLock; yeni oturum yok) — yedek 10 dk, IDLE yoksa 2 dk.
  `uidValidity` durum dosyasında; değişince imleç sıfırlanır. `classify`: authenticationFailed → dur (otomatik deneme yok), ETHROTTLE →
  throttleReset, [ALERT]/[LIMIT]/çok bağlantı → 15 dk. `missingIdleCommand: 'STATUS'`.
- Amazon Seller Central / Etsy Mesajları / Shopify Inbox tarayıcı köprüleri varsayılan KAPALI (yapılandırmada messaging/inbox:true ile açılır).
- "PIN'i gir" hızlı yol: `registry.restart` eski connector'da `attention` varsa `start({window:true})` → köprü görünmez denetim turunu
  (headless aç + needsWindow + kapat, 10-20 sn) atlar, görünür pencereyi hemen açar; çerezler varsa doğrudan `afterLogin` (`visibleLogin`).
- Bildirimler (desktop.ts): Ayarlar → Bildirimler: `kavsak.soundsOn` (tüm sesler), `kavsak.volume` 0–100 (varsayılan 60, kazanç 0,5·v²),
  `kavsak.bannersOn` (sistem kartı). Uygulama ayarları kartı: zil sesi, `kavsak.vol.<platform>` (genelin yüzdesi), Açık/Kapalı ('off' = ne ses
  ne kart). Tek giriş `playNotifySound(platform)`; `unlockAudio()` ilk tıklamada AudioContext'i açar (yoksa etkileşimsiz açılışta ses çıkmıyordu).
- Gönderim hızı: arayüz iyimser (`outbox`, Conversation.tsx) — Enter'da "Gönderiliyor" balonu hemen, gerçek kayıt gelince kopya gizlenir,
  hata olursa metin kutuya döner; ardışık gönderimler `sendChain` ile sıralı. Köprü: send/react/sendFile `urgent()` — yoklama turu sürüyorsa
  turu beklemez, `runUrgent()` güvenli noktada (liste sonrası, mesaj istekleri arası) araya alır (test: send-priority.test.ts).
  WhatsApp `watch()` (sohbet açılınca) `prewarm`: getUSyncDevices + assertSessions (sohbet başına 4 dk'da bir) → ilk yanıt beklemez.
- Mesaj üstüne gelince iki düğme (`.rtrig`, ikincisi `.second`): 😊 tepki (`REACT_PLATFORMS`: WhatsApp, Telegram, Slack, Instagram
  `broadcast/reaction`, LinkedIn `reactWithEmoji|unreactWithEmoji` {messageUrn, emoji} — mautrix-linkedin) + 📅 takvim (metinli her mesajda,
  tüm uygulamalar). LinkedIn gelen tepkiler `reactionSummaries` → `liReactions`. Messenger/X (yalnız DOM), iMessage, e-posta, pazaryeri: tepki yok.
- Arayüzde emoji yerine ikon: bağlayıcıların yazdığı baş emojiler ("📦 Kargoya verildi", "📷 Fotoğraf", "Sen: 🎤 …") `ui.tsx`
  `IconText`/`leadIcon` (`LEAD_ICONS` eşlemesi) ile ikon çizilir; sistem bildiriminde `stripLeadIcon` (düz metin). Kullanıcı içeriği ve
  tepki metinleri ("😂 … beğendi") olduğu gibi. Yeni arayüz metnine emoji yazma; `Icon` kullan.
- Bağlan: resmi olmayan kanallarda "resmi değil" etiketi + Sosyal Medya altında açıklama (`UNOFFICIAL`, Connect.tsx).

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
- Telegram: varsayılan api_id/api_hash Mivelo'nun kendi kimliği (config.ts, api_id 31111230, my.telegram.org "Mivelo" Desktop); cihaz bilgisi
  deviceModel "Mivelo" + gerçek OS sürümü. Ortam değişkeni ya da Bağlan formundaki kendi kimlik alanları geçersiz kılar.
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
