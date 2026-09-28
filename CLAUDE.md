# Mivelo — Claude için proje notları

Birleşik gelen kutusu masaüstü uygulaması (quicker.chat'ten esinlenmiş, daha gelişmiş): WhatsApp, Telegram, Slack, iMessage,
LinkedIn, X, Instagram, Messenger, e-posta (Gmail/Outlook/Yahoo/iCloud/IMAP) ve Shopier siparişleri tek yerde. Yerel öncelikli,
ücretsiz (hiçbir ücretli servis yok), AI destekli (isteğe bağlı Anthropic anahtarı). Sahibi: Kaan (Türkiye, geliştirici).
Dil: arayüz ve yorumlar Türkçe.

## Kaan'ın çalışma tercihleri
- Onay sorma, ilerle; belirsizlikte en makul yorumu seç ve ne yaptığını söyle.
- Yeni npm bağımlılığı eklersen **açıkça** "npm install gerekli" de.
- Ekran görüntüsü/log gelirse kök nedeni bul, yama yapma; birden fazla sorunu tek turda topluca çöz.
- **Her değişiklik otomatik yayında**: doğrulamadan sonra commit + main'e push ET (sormadan). Demo: push → `deploy-demo.yml`
  (demo.mivelo.app + mivelo.app). Yerel (Mac): `npm run autodeploy -- install` (`scripts/auto-deploy.mjs`) iki LaunchAgent kurar:
  `app.mivelo.autodeploy` 2 dk'da bir origin/main'i çeker (yalnız main + temiz ağaç, ff-only; yalnız package-lock.json kirliyse geri alır),
  package*.json değiştiyse npm install + web servisini yeniden başlatır, çekirdek değiştiyse core build; macOS bildirimi, günlük
  `~/.kavsak/autodeploy.log`. `app.mivelo.web` = `npm run dev` arka planda (KeepAlive, oturum açılınca; günlük `~/.kavsak/web.log`
  5 MB'ta kırpılır) → Kaan Mivelo'yu http://localhost:5173 adresinde web olarak kullanıyor (masaüstü uygulaması şimdilik YOK;
  `--app` ile paketleme açılır). tsx watch/Vite kod değişikliğini kendisi alır. `-- status | restart | run | uninstall`.
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
- Tanı betikleri (Mac'te, değer yazdırmaz; çıktı Claude'a): `node scripts/imessage-probe.mjs` (chat.db ↔ Mivelo sayıları, en yeni mesaj,
  klasörler, node ikilisi FDA yolu), `node scripts/trendyol-probe.mjs` (soru alan adları + aday sipariş sorusu uçları). Trendyol connector'ı
  soru alan adlarını günlüğe bir kez yazar (`Trendyol soru alanları: …`); `questionOrderNo` adında order geçen alanı sipariş bağı sayar.
  Ölçüm (28.09): qna/questions/filter sipariş bağı alanı DÖNDÜRMÜYOR (answer, creationDate, customerId, id, imageUrl, productName, public,
  showUserName, status, text, userName, webUrl, productMainId). Araştırma (28.09): Trendyol'da SİPARİŞ SORUSU API'si YOK; 556 = ağ geçidinde
  yönlendirilmemiş yol (order-questions var olmayan uç). Trendyol `ORDER_Q_PLATFORMS`'tan çıkarıldı (sekme yalnız içerik varsa). Panel verisi
  ancak satıcı paneli tarayıcı köprüsüyle okunabilir (yapılmadı).
- **Trendyol sipariş API v2** (v1 `/orders` 15 Ekim 2026'da kapanıyor): `GATEWAYS[0].ordersV2` = `/integration/order/sellers/{id}/v2/orders`
  önce denenir; 404/410/556 → bir kez `noOrdersV2`, v1 (günlükte uyarı). v2 yalnız son 1 ay + 10.000 kayıt → ilk eşitleme 2×2 hafta (v1'de 6).
  Geçmiş için `orders/stream` (nextCursor, 3 ay) var — kullanılmadı. Test: trendyol.test.ts.
- `node scripts/verify-strategy.mjs <slack|instagram|linkedin|x|messenger>` — canlı oturumun profil KOPYASIYLA (uygulamaya dokunmadan)
  threads/messages/before doğrulaması. Önce `npm run build -w packages/core`.

## Yapı
- `packages/core` — Node 22, TypeScript ESM. SQLite (better-sqlite3 + FTS5) `~/.kavsak/kavsak.db`; oturumlar
  `~/.kavsak/sessions/<hesapId>/`. REST + WS sunucu 127.0.0.1:7788 (`server.ts`). `registry.ts` hesap↔connector.
  Ortak model `model.ts` (Account/Chat/Message/Participant/Attachment; Chat.handle/link/participants/meta).
  Connector arayüzü `connectors/base.ts` (start(opts)/stop/sendText, isteğe bağlı fetchMedia/openDirect/logout/action/loadHistory).
- `apps/web` — Vite + React 19, açık + gece modu (Inter, mor #6c47ff, lime #d4ff3f). Tema `theme.ts` (kenar çubuğu altındaki ay/güneş düğmesi `.theme-tg` açık⇄koyu; seçim yoksa sistem teması,
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
  **Demo üyeliği**: hazır tek hesap `admin` (şifre karması `SEED_USERS`, `passVersion` artınca users.json'daki karma da güncellenir; editor/misafir
  `REMOVED_USERS` ile silinir). Giriş ekranında "Üyelik oluştur" (`Auth.tsx`, `authRegister`) → `action=register`: ad + soyad (ayrı alanlar; `firstName`/`lastName`, `name` birleşik), e-posta, kullanıcı adı
  (a-z0-9._-, 3-24), şifre ≥8 (iki kez; not alanı YOK); IP başına saatte 5 (`demo-signup.json`), gizli `website` bot tuzağı, ≤300 bekleyen. Kayıt users.json'da
  `status:'pending'` → giriş 403 "onaylanmadı" (şifre doğrulandıktan sonra söylenir); e-postayla da giriş olur. Admin → Demo: Onayla/Reddet/
  E-posta/Sil (`demo_update`/`demo_mail`/`demo_delete`, u-admin korunur); onayda `send_approval_mail` → `apps/landing/api/lib-smtp.php`
  `mv_send_mail` (kimlik doğrulamalı SMTP, bağımlılıksız; ayar `~/mivelo-data/smtp.json` 0600, Admin → Ayarlar → E-posta gönderimi + deneme
  e-postası + sunucu konuşma dökümü, şifre dökümde gizli). Türkticaret: smtp.turkticaret.net 465 SSL / 587 STARTTLS, kullanıcı = gönderen
  (varsayılan sunucu değeri bu). Bağlantı kurulamazsa ("Connection refused": barındırma bir giden portu kapatmış olabilir) öteki port
  kendiliğinden denenir, çalışan kaydedilir. Kaan'ın barındırması (Türkticaret python01-host, Exim) 465/587'yi dışarıya KAPATIYOR;
  yerel posta sunucusu (localhost) DENENMEZ: kurumsal kutu orada değil (535), kimliksiz 127.0.0.1:25 "kabul etti" ama İLETMEDİ (mail() gibi).
  Eski sürümün kaydettiği yerel yol `mv_smtp_config`'te smtp.turkticaret.net:465'e döndürülür. Çözüm sağlayıcıda: giden SMTP erişimi. SMTP yoksa mail() yedeği — cPanel'de "gönderildi" deyip ULAŞMIYORDU (SPF/DKIM).
  Şifre e-postada YOK; sonuç `mailed`/`mailError` rozetinde. Her kullanıcının bağladığı uygulamalar kendi kaydında (bağımsız); reddedilenin oturumu düşer.
  Kayıtla gelen kullanıcı (`requestedAt`) `user_public.fresh` → demo BOŞ panelle açılır (`loadDemoAccounts(list, {fresh})`: varsayılan
  DEMO_APPS, örnek sohbet ve takvim etkinliği yok; bağladığı uygulamanın örnekleri gelir). admin örnek veriyle açılır.
  **Üye verisi ayrımı (hassas)**: kayıtla gelen üye ASLA demo verisi görmez — bağladığı uygulama boş kanal (`freshUser`: seed yok, addAccount
  seedAccount yapmaz); eski girişlerden kalan uygulama listesi sunucuda bir kez silinir (`dataReset` 2; demo `seed_users` ve admin `demo`
  listesinde). Admin → Demo "Verileri sil" (`demo_reset`). `accounts` PUT yalnız ETKİN üye. Aynı tarayıcıyı paylaşanlar: `demo-isolation.ts`
  girişte başka üyenin (sahip `mivelo.demoOwner`) ve çıkışta tüm kullanıcıya özel mivelo./kavsak. anahtarları siler (tema/ses/panel/AI tercihleri kalır).
  **Geri bildirim** (`Feedback.tsx`, sağ alt 54 px mor düğme + solunda "Hata / öneri bildir" balonu (telefonda balon yok); ✕ yalnız o oturumda
  gizler, yenilemede geri gelir): Hata/Öneri/Talep/Diğer, metin (e-posta alanı YOK), YALNIZ "Fotoğraf / video ekle" (ekran görüntüsü/kaydı
  düğmeleri kullanıcı isteğiyle KALDIRILDI; ≤5 dosya, 40 MB/dosya, toplam 60 MB; yapıştırma da) → demoda `api/index.php?action=feedback` (üye kimliği OTURUMDAN, istemcinin adı yok sayılır; `verified`), yerel uygulamada
  `https://mivelo.app/api/feedback.php` (kimliksiz; `VITE_FEEDBACK_URL`); ortak kayıt `apps/landing/api/lib-feedback.php` (yayında demo api/'ye kopyalanır; CORS yalnız demo/localhost/tauri; multipart;
  tür finfo ile içerikten; IP başına saatte 10; `~/mivelo-data/feedback/index.json` + `<id>/<n>.<ext>`; `.user.ini` yükleme sınırları;
  SMTP ayarlıysa sahibine e-posta). Başarı yalnız `{ok:true}` (yanlış adres 200+HTML döndürebilir). Admin → Geri bildirim (Açık/Tümü/Çözülen,
  durum Yeni/İnceleniyor/Çözüldü/Yapılmayacak, not, Yanıtla=mailto, ekler `fb_file` yalnız oturumla, CSP sandbox).
  Demoda örnek AI açık (`demo-ai.ts`: sohbete özel taslak/özet/aksiyon/olay, model çağrısı yok); pazaryeri sipariş kartı `Script.order`.
  Tek dosya demo (`npm run demo:html`) profil adı "Mivelo".
- **Tanıtım videosu (reels 1080×1920, ~68 sn; TM() zaman eşlemesi: 5,5 sn sonrası ×1,25 + GAPS araları: AI özeti, sağ panel, takip/zamanlama hareketli grafikleri)** `scripts/promo/`: videodaki arayüz GERÇEK tek dosya demo (iframe, Playwright sanal saati
  `clock.runFor`; imleç/klavye gerçek girişler, CSS animasyonları video zamanına bağlı `syncAnims`; ıskalanan tıklamada DOM güvencesi).
  `reel.html` kompozisyon (tek nesne biçim değiştirir: bildirim hapı → logo → pencere → logo → CTA; Apple tarzı açık zemin, kelime kelime
  bulanıklıktan açılan başlıklar; logolar yalnız ilk iki sahnede), `render.mjs` (--scale 2, --stills), `audio.mjs` (kodla üretilen 120 BPM
  müzik + tık/tuş/gönder/bildirim efektleri, -14 LUFS). Başlık fontu -apple-system/SF Pro (Mac'te), yoksa Inter Display. Demo kancası
  `window.__miveloDemo.incoming(ad, metin)` (static-demo.ts). Ayrıntı `scripts/promo/README.md`; MP4 depoya konmaz.
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
  Pazaryeri kanal listesi sekmeleri **Tümü · Siparişler · Ürün soruları · Sipariş soruları** (tek satır `.tabs.shop`, 11 px, iMessage klasörleri gibi; `types.ts` `shopTabOf`:
  meta.order → sipariş; soru `questionOrderRef` varsa (meta.question.orderNumber — Trendyol'da alan adı belgesiz, orderNumber/orderId/order.*
  denenir; HB orderNumber; Amazon handle 123-1234567-1234567) sipariş sorusu, yoksa ürün sorusu; Sipariş soruları sekmesi `ORDER_Q_PLATFORMS`
  ya da içerik varsa; sayılar `shopPending`: açık sipariş / cevap bekleyen soru). Satırda 📦/❓ işareti (`.skind`); sağ panelde `OrderPanel` ya da `QuestionPanel` (meta.question).
  Trendyol/Hepsiburada/n11/Shopier'de (`ORDER_ONLY_PLATFORMS`, `isOrderPage`) sipariş sohbet DEĞİL: orta alanda `OrderPage` (özet + durum
  geçmişi, yazma alanı yok; API'de sipariş üzerinden alıcıya mesaj ucu yok). Bağlı soru varsa (question.orderNumber) "Soruyu aç". Odak'ta sayılmaz.
  Siparişler varsayılan AÇIK (`ordersFlag`: token `ordersOff:true` kapatır; eski formun yazdığı `orders:false` yok sayılır). Trendyol soru/sipariş
  API'si istek başına ≤2 hafta: ilk eşitleme geriye 2 haftalık dilimler (sorular 13 dilim ≈6 ay, siparişler 6 dilim ≈3 ay), sonra son 3 gün.
  Ayrı "sipariş soruları" ucu belgelerde yok (aynı qna/questions/filter). Hepsiburada soruları sayfalı (bekleyen ≤500), n11 sipariş 6×14 gün,
  Amazon ilk pencere 90 gün, Shopify/Etsy ilk 10 sayfa. **ePttAVM** (`connectors/pttavm.ts`, YALNIZ sipariş; API'de soru/mesaj
  ucu yok): SOAP `https://ws.pttavm.com:93/service.svc`, WS-Security UsernameToken (panel → Entegrasyon Bilgileri kullanıcı adı/şifre; token
  JSON {username,password}), `SiparisKontrolListesiV2` (ilk 4×1 hafta, sonra 3 gün; 90 sn/boşta 3 dk; 120 sn zaman aşımı). Türkçe durum metni
  `pttStatus` (toLocaleLowerCase('tr'): JS /i "İptal"i tanımaz) → Created/Shipped/Delivered/Cancelled/Returned. TLS doğrulaması KAPATILMAZ
  (resmi istemciler kapatıyor). REST (integration-api.pttavm.com, Api-Key+access-token) tek kaynaklı → kullanılmadı. Gerçek hesapla doğrulanmadı.
  `ORDER_ONLY_PLATFORMS`'ta (sipariş sayfası). Test: pttavm.test.ts.
- **E-posta girişi**: Gmail/iCloud Bağlan → önce "Google/Apple ile giriş yap" (tarayıcı, normal şifre; `:choose` pairbox), uygulama şifresi
  "gelişmiş". Yandex ayrı platform (`yandex`, imap.yandex.com, uygulama şifresi). "Diğer e-posta" yalnız e-posta+şifre: sunucu
  `mail-discover.ts` (bilinen sağlayıcılar → Thunderbird autoconfig → imap.<alan>); elle giriş "gelişmiş". Yahoo "Command failed": OBJECTID
  bildiren sunucuda imapflow THREADID istiyordu → threadId yalnız Gmail'de, reddedilirse onsuz yeniden.
- **Genel hata denetimi (Eylül 2026, satır satır)** sonrası kurallar:
  - WhatsApp telefon bildirimleri: gönderim/okundu/tepki sonrası HEMEN "unavailable" (+20–40 sn yedek), arayüz boşa geçince
    (`activity.ts onUiInactive`, ≥60 sn arayla), uykudan uyanma (30 sn saat sıçraması >90 sn) ve kapanışta. Düzenli presence YOK.
  - WhatsApp oturumu yalnız sunucu reddinde (428, ağ hatası değil) sayılır; 408/ağ kopması asla oturum silmez. Profil fotoğrafları tek
    sıralı kuyruk (0,5–1,5 sn, oturum başına ≤300, `avatars.json` 3 gün); ayrılınan grup metadata hatası 24 sa negatif önbellek; önbellekler hesap başına.
  - Sunucu: Host başlığı izin listesi (DNS rebinding), `/api/lan` belirteci yalnız yerelden; IPv6-içi IPv4 SSRF engeli; registry restart/remove
    hesap başına sıralı; send-guard anahtarı sha256.
  - PollTimer tek zincir (429 backoff çift yoklama üretmez). Trendyol paketleri sipariş başına durum dosyasında birleşir (≤2000).
  - Tarayıcı köprüsü `ensureOpen` tek uçuş; mesaj başına 429/checkpoint de backoff'a gider; markRead sonrası görünür sayfa terk edilir
    (IG/X/Messenger "Görüldü" sızmasın). Gmail/iCloud yoklama okunmamışı geri işaretler. E-posta tarayıcı gönderimleri `local-` kimlik.
  - Masaüstü bekçisi: 60 sn açılış payı, çökmede üstel bekleme ≤5 dk, SIGTERM→bekle→kill; `core-bundle/node-abi.json` ile uyumlu Node seçilir.
  - PHP depoları: önce kodla, tmp+rename, ayrı `.lock`; bozuk dosya 500 (asla sıfırlama); admin varsayılan şifreye asla düşmez; IPv6 /64 sınırı.
    Deploy durum dosyası `api/.ftp-deploy-sync-state.json` (sunucu kökündeki eskisi elle silinmeli).
- **Giriş bilgisi reddi** (`App.tsx` `AUTH_FAIL` + `credentialForm`): e-posta/pazaryeri hesabında şifre/anahtar reddedilince uyarı düğmesi
  "Şifreyi/Bilgileri güncelle" → Bağlan `focus="edit:<hesap>"` formu (e-posta dolu). Diğer hata/kopma durumlarında bu kanallarda uyarı
  düğmesi (`panel`) hesabın Bağlan panelini açar + yeniden dener (sessiz "Yeniden bağlanılıyor" yok). mail.ts ilk giriş hatası da
  `classify`'dan geçer (LOGIN failed/Authentication failed → authFailed) ve imapflow `responseText` detail'e eklenir. Çekirdek `registry.add`: aynı platform + aynı adresli
  e-posta hesabı varsa kopya açmaz, token'ı birleştirip (formda olmayan alanlar korunur) yeniden başlatır (test: security-fixes).
- **Sohbet listesi**: `/api/chats` HESAP BAŞINA en yeni 3000 (`store.listChats`; eskiden toplam 600 → çok sohbetli WhatsApp iMessage'ın
  eski/klasördeki sohbetlerini atıyordu) + okunmamış/bayraklı/takipte/iMessage klasör-silinen her zaman. Arayüz 300'lük parçalarla çizer
  (`rowLimit`, `.list-more` IntersectionObserver). Gezinme durumu (görünüm/kanal/sekme/klasör/açık sohbet) sessionStorage `mivelo.nav`
  → yenilemede aynı yer.
- **iMessage**: açılışta sohbete bağlı mesajların TAMAMI yüklenir (`FULL_LIMIT` 60 bin; eskiden en yeni 2000 + sohbet başına 20 → eski
  mesajlar eksikti). chat.db'ye 36 saattir mesaj düşmüyorsa `warnIfStale` → kanal satırında uyarı (Apple eşitlemesi durmuş; Mivelo yalnız
  Mac'tekini görür). Kaan'ın ölçümü (28.09): chat.db 12.192 bağlı / 828 bağsız mesaj, 1963 mesajlı sohbet — Mivelo sayıları tutarlı.
  poll birikmişi 500'lük parçalarla boşaltır (≤10/tur); `chat_message_join` henüz yazılmamış yeni satırlar `unjoined`da 2 dk
  yeniden denenir (eskiden atlanıyordu → "son gelenler görünmüyor"). Bilinmeyen klasörü: is_filtered 0 olsa da rehberde yok + hiç yanıtlanmamış
  birebir sohbet (`unknownSender`; rehber okunamazsa uygulanmaz).
- **Mesaj tikleri** (her kendi balonunda, `statusIcon` Conversation.tsx): read = yeşil çift tik (`--tick-read`), delivered = çift tik,
  sent = tek tik (WhatsApp SERVER_ACK: alıcı çevrimdışı), pending = saat, failed = kırmızı uyarı. `store.upsertMessage` durumu GERİ
  GÖTÜRMEZ (yeniden eşitleme "görüldü"yü "gönderildi"ye indiriyordu → tik kayboluyordu); failed yalnız pending/sent'in yerine geçer.
  Kaynaklar: WhatsApp geçmişi `waStatus(m.status)`, Telegram geçmişi diyalog `readOutboxMaxId` (`applyReadOutbox`), iMessage chat.db
  `is_delivered/is_read/date_read/error` (`imessageStatus`) + son 3 günün alındıları 5 sn'de bir (`syncReceipts`), IG/X/Messenger görüldü
  zamanı. Slack/e-posta/pazaryeri alındı vermez → tek tik. WhatsApp alındısı LID/numara farklı sohbet kimliğiyle gelebilir →
  `store.findMessageByRemote` yedeği (eskiden atlanıyordu: aynı koşullu bir sohbette tek, ötekinde çift tik); grup alındıları
  `message-receipt.update` ile (grupta en çok "iletildi", birebirde okunma = görüldü).
- **E-posta özgün HTML** (`MailFrame.tsx`): `Message.hasHtml`; gövde DB `messages.html` sütununda (listede TAŞINMAZ, `GET /api/messages/:id/html`).
  Kaynaklar: IMAP `mailparser` html (gömülü `cid:` görseller yerel medya adresine, gövdede kullanılanlar ek listesinde yok; ilk yoklamada son 150
  e-posta bir kez yeniden okunur `html-v1`), tarayıcı yolları (Gmail `div.a3s` alıntısız, Yahoo/Yandex gövde öğesi, iCloud article, Outlook gövde).
  Hepsi `connectors/mail-html.ts` `cleanMailHtml` (betik/iframe/form/on*/javascript: atılır, `<base>` eklenir). Arayüz: sandbox'ta allow-scripts
  YOK (yalnız same-origin: yükseklik ölçümü + popups), CSP, `<base target=_blank>`, beyaz "kağıt" (koyu temada da), ResizeObserver yüksekliği (gövde gözlenir, ölçüm bir sonraki karede ve yalnız değişince: aynı karede boy yazmak
  "ResizeObserver loop …" uyarısı veriyordu; App'in hata bildirimi bu zararsız uyarıyı yok sayar).
- **Tarayıcı e-posta saatleri**: `parseMailDate` (outlook.ts; TR/EN/RU, Bugün/Dün/Сегодня/Вчера, ISO/RFC; okunamazsa undefined — ESKİDEN NaN →
  Date.now(): her e-posta eşitleme anında gelmiş görünüyordu) + `fillListTimes` (okunamayan satır komşusundan) + ileti zamanı okunamazsa
  liste satırı zamanı (`threadTs`). Sohbet zamanı MAX ile güncellendiği için bozuk kayıtlar Yahoo/Yandex/iCloud tarayıcı hesaplarında
  bir kez silinip yeniden eşitlendi (`registry.resyncOnce` 'ts-v1'). Yahoo satırlarında ekran okuyucu etiketleri (`A11Y`) atlanır.
- **Albüm + galeri** (Conversation.tsx `toUnits`/`AlbumView`): aynı kişiden art arda ≥3 metinsiz görsel/video mesajı (aralar ≤3 dk) tek
  balonda 2 sütun ızgara (≤4 kare, "+N"); tüm platformlarda arayüz tarafında. Medya penceresi `Lightbox` sohbetteki tüm medya
  (`mediaList`) arasında ←/→ ve `.lb-nav` okları, "i / n" sayacı. Medyalı balon iç boşluğu 2 px (ince mor çerçeve).
- **Alıntılı yanıt** (`Message.replyTo` {remoteId, senderName, text, fromMe}; DB `reply_to` JSON, COALESCE): arayüzde balonu sağa kaydır
  (fare/dokunma sürükleme ya da trackpad yatay tekerlek, 64 px; `swipeProps`) ya da üzerine gelince "Yanıtla" → yazma alanında `.reply-bar`
  (Esc iptal); balonda `.quote` (tıkla → o mesaja kaydır). `REPLY_PLATFORMS` (types.ts): WhatsApp (`sendMessage(..., {quoted})`, gelen
  `contextInfo.stanzaId` → `quotedOf`), Telegram (`replyTo`, gelen `replyTo.replyToMsgId`), Instagram (`replied_to_item_id`, gelen
  `replied_to_message`; strateji `canReply`), Slack (iş parçacığına: threadId), demo. `SendOptions.replyTo` = platform kimliği.
- **Yahoo Mail**: varsayılan tarayıcı girişi (`connectors/browser/yahoo.ts`, mail.yahoo.com; `data-test-id` seçicileri + ARIA yedekleri,
  çerez onayı, oturum çerezleri kalıcı; DOĞRULANMADI → ilk girişte günlükle ayarlanacak). Yahoo birçok hesapta uygulama şifresini kapattı,
  IMAP normal şifreyi reddediyor. Token dosyası varsa IMAP (`MailConnector`). `registry.add('yahoo')` token'sız çağrılınca IMAP'i bozuk
  Yahoo hesabının token'ını silip tarayıcı yoluna geçirir (kopya yok). Uyarı `panelOnly` (aynı şifreyle yeniden denemez → kilit riski).
- **Sayaçlar** (App.tsx `baseList`): başlıktaki "N yeni" ve Okunmamış/Bekleyen sayıları listelenen kümeden (arşiv/iMessage klasörü/
  e-posta klasörü/pazaryeri sekmesi dahil); eskiden hep gelen kutusundan hesaplanıyordu.
- Sistem mesajı baş emojileri (🔒 🚫 ⏳ 🗑 ⚠; `SYSTEM_LEAD`) balonda da ikon (`bubbleText`). Kendi (mor) balonumda seçim beyaz zemin
  (`.grp.me .bub ::selection`). SyncBar yüzdesi çubukla aynı hizada, dolan ucun üstünde.
- **Web bildirimleri**: tarayıcı izni yalnız kullanıcı tıklamasıyla istenebilir (açılışta istenen sessizce engelleniyordu → sağ üstte
  sistem bildirimi çıkmıyordu); ilk `pointerdown`'da `requestWebNotify`; Ayarlar → Bildirimler'de izin durumu + "Deneme bildirimi".
- **Kendi mesajının yankısı**: `store.isOwnEcho` (aynı sohbette ±3 dk, ≥12 kr. aynı metinli fromMe) → base.upsertMessage gelen saymaz (tüm
  platformlar); WhatsApp'ta katılımcı kimliği `meIds` ise fromMe. Uyarıdaki "QR'ı göster" Bağlan'ı o hesabın eşleştirme alanıyla açar (`focus`).

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
- **Ayarlar penceresi** (`Settings.tsx`, sol alttaki ayar düğmesi): solda bölümler Bildirimler · Uygulama sesleri · AI özellikleri ·
  Telefondan erişim (· Hesap: yalnız web demo), sağda açıklamalı satırlar + `.sw` anahtarları; mobilde bölümler üstte kaydırmalı sekme.
  Görünüm burada YOK (kenar çubuğu düğmesi).
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
- E-posta (IMAP) okundu: Mivelo'da açılan dizi sunucuda da `\Seen` (`markRead`; UID'ler alımda tutulur, yoksa Gmail X-GM-THRID ile arama).
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
  `kavsak.bannersOn` (sistem kartı). Ayarlar → Uygulama sesleri (platform başına satır): zil sesi, `kavsak.vol.<platform>` (genelin yüzdesi), Açık/Kapalı ('off' = ne ses
  ne kart). Tek giriş `playNotifySound(platform)`; `unlockAudio()` ilk tıklamada AudioContext'i açar (yoksa etkileşimsiz açılışta ses çıkmıyordu).
- Gönderim hızı: arayüz iyimser (`outbox`, Conversation.tsx) — Enter'da "Gönderiliyor" balonu hemen, gerçek kayıt gelince kopya gizlenir,
  hata olursa metin kutuya döner; ardışık gönderimler `sendChain` ile sıralı. Köprü: send/react/sendFile `urgent()` — yoklama turu sürüyorsa
  turu beklemez, `runUrgent()` güvenli noktada (liste sonrası, mesaj istekleri arası) araya alır (test: send-priority.test.ts).
  WhatsApp `watch()` (sohbet açılınca) `prewarm`: getUSyncDevices + assertSessions (sohbet başına 4 dk'da bir) → ilk yanıt beklemez.
- Mesaj üstüne gelince iki düğme (`.rtrig`, ikincisi `.second`): 😊 tepki (`REACT_PLATFORMS`: WhatsApp, Telegram, Slack, Instagram
  `broadcast/reaction`, LinkedIn `reactWithEmoji|unreactWithEmoji` {messageUrn, emoji} — mautrix-linkedin) + 📅 takvim (metinli her mesajda,
  tüm uygulamalar). LinkedIn gelen tepkiler `reactionSummaries` → `liReactions`. Messenger/X (yalnız DOM), iMessage, e-posta, pazaryeri: tepki yok.
- Arayüzde emoji yerine ikon (`LEAD_RE` U+2300–23FF'yi de kapsar: ⏳⌛⏰ → clock; sipariş durum rozetleri de `IconText`): bağlayıcıların yazdığı baş emojiler ("📦 Kargoya verildi", "📷 Fotoğraf", "Sen: 🎤 …") `ui.tsx`
  `IconText`/`leadIcon` (`LEAD_ICONS` eşlemesi) ile ikon çizilir; sistem bildiriminde `stripLeadIcon` (düz metin). Kullanıcı içeriği ve
  tepki metinleri ("😂 … beğendi") olduğu gibi. Yeni arayüz metnine emoji yazma; `Icon` kullan.
- Bağlan talimatları kullanıcı isteğiyle SADE: teknik ayrıntı yok (kapsam adları, geri dönüş adresi, xoxp/xapp, api_id…); Telegram kendi
  kimlik alanları "Gelişmiş" arkasında; kart yöntem metinleri kısa (`types.ts` method).
- Bağlan: "resmi değil" etiketi kullanıcı isteğiyle KALDIRILDI (yalnız Sosyal Medya altındaki açıklama). Kart durumu en iyi durumdaki hesaptan
  (`STATUS_RANK`, bağlı önde; birden çoksa "· N hesap"), alt satırda bağlı hesabın adresi/@kullanıcı adı (`accountLabel`; genel adsa yöntem metni).
- Parola alanları `PasswordInput` (ui.tsx): sağdaki göze BASILI TUTUNCA görünür, bırakınca gizlenir (Bağlan formları, 2FA istemi, AI anahtarı, giriş).
- **Mivelo içi giriş** (varsayılan; `bridge.launchLogin`): giriş sayfası GÖRÜNMEZ tarayıcıda açılır (görünürlük taklidi yok, 820×700, DPR 2),
  CDP `Page.startScreencast` kareleri `login.frame` olayıyla (JPEG base64) arayüze; `apps/web/src/LoginView.tsx` üst katmanda gösterir
  (kareler App durumundan geçmez: `pushLoginEvent` yayıncısı). Girdi `POST /api/accounts/:id/login-input {events}` (move/down/up/wheel/text/key;
  arayüz sıralı toplu gönderir, köprü `inputQ` ile sırayla uygular; klavye gizli textarea `.login-keys` — üst öğelerin `user-select:none`'ı yazmayı
  engelliyordu, `user-select:text` şart), `login-cancel` (bekleyen girişi bırakır, 'pairing'), `login-window` (restart `{external:true}` → eski
  ayrı pencere). OAuth açılır penceresine geçilince yayın yeni sayfaya taşınır (`startEmbed`). `MIVELO_LOGIN_WINDOW=1` hep ayrı pencere.
  Hız: `login.start` olayı → arayüz ekranı HEMEN "açılıyor…" ile açar; tarayıcı gezinmeden (`launch(…, navigate=false)`) yayın başlar,
  sonra `Strategy.loginUrl ?? home` (Yandex: passport; eskiden 5-10 sn sonra açılıyordu). Akış donmasın: ana çerçeve gezinmesinde ve 2,5 sn kare
  gelmezse yayın yeniden başlar (`keepEmbedAlive`; tıklama/tuş sonrası da); `Emulation.setFocusEmulationEnabled` (sayfa odakta sanılsın);
  uygulanamayan girdi günlüğe. Yazı `keyboard.type` ile (≤200 kr.; gerçek tuş olayları) — `insertText` yalnız input üretiyordu, kutucuklu
  kod alanları kodu gösterip formu geçersiz sayıyordu ("Continue" basılamıyordu). (Kaan: Yandex kod girildi ama butonlar tepki vermedi → bu düzeltmeler; doğrulanmadı.)
  Site iframe'e gömülemez (X-Frame-Options) ve oturum Mivelo profilinde olmalı → bu yol. Google görünmez tarayıcıda girişi reddederse "Ayrı pencerede aç".
- Ayrı giriş penceresi `--app=<home>` (sekmesiz/adres çubuksuz 760×860 pencere, viewport null). Kullanıcının kendi tarayıcısında açılamaz:
  oturum çerezleri Mivelo'nun Chromium profilinde olmalı. Etiket genel kaldıysa köprü yoklamadan sonra 10 dk'da bir `me()`'yi yeniden dener
  (`refreshLabel`); Instagram adı sohbet listesi yanıtındaki `viewer.username`'den de öğrenilir.
- Tarayıcı girişi hızı (bridge): hiç çerezi olmayan profilde (`hasProfileCookies`) görünmez denetim turu atlanır → pencere hemen açılır; giriş 700 ms'de bir
  denetlenir, sonra URL 1,5 sn sabit kalınca (500 ms adım) pencere kapanır (eskiden 2 sn adım + 4 sn → 6-8 sn).
- Sol listede hesap tanıtıcısı her kanalda (`handleOf`): "Platform · X" etiketinde önek atılır; pazaryeri etiketleri küçük harfli
  platform adı ("trendyol") da boş sayar (`Trendyol · <satıcı>`). Instagram ek kaynak `web/accounts/edit/web_form_data`.
- Hesap etiketi: `finishStart` genel adı ("Instagram", "Outlook"…, `GENERIC_LABEL`) önceden öğrenilmiş @kullanıcı/adresin üstüne yazmaz. Instagram
  `accounts/current_user` + DOM yedeği; Messenger `facebook.com/me` (başlık = ad, son adres = @kullanıcı); Outlook localStorage ANAHTARLARINDAKI adres.
- Yarım kalmış tarayıcı girişi kopyaları: token'sız e-posta hesabı bağlanınca aynı platformdaki token'sız, bağlanmamış, sohbetsiz hesaplar silinir
  (`pruneStaleLogins`); token'sız yeniden "Bağlan" bağlanmamış token'sız hesabı yeniden başlatır (kopya açmaz). (Yahoo kartı "Bağlı değil" / panel "Bağlı".)
- **Yandex (tarayıcı)** (`connectors/browser/yandex.ts`): Bağlan → doğrudan passport.yandex girişi (uygulama şifresi formu yok; `mode:'browser'`),
  mail.yandex.com liza BEM seçicileri (mail-MessageSnippet…) + yedekler, `Session_id` çerezi. Satır = en dıştaki metinli eşleşme (iç parçalar
  ayrı satır sayılıyordu → boş "(konu yok)" sohbetleri; `prune-v1` ile bir kez silinir), alanlar tutmazsa satır metninden; ilk turda
  `Yandex Mail tanı:` günlüğü (seçici sayıları + ilk satırın sınıfları, içerik yok) → seçici ayarı buna göre. Adres `yandex_login` çerezinden.
  Eşleşme metinsiz bağlantı kaplaması olabilir → metinli ama başka satır içermeyen üst öğeye çıkılır (`lift`); metin parçaları yaprak öğelerden;
  tıklama en dıştaki eşleşme sırasıyla (`idx`). Giriş: oturum yokken mail.yandex ana sayfaya atıyor → passive loggedIn passport'a gider (`LOGIN_URL`). Token dosyalı eski IMAP hesapları sürer;
  şifre reddinde "Yandex ile giriş yap" (Yahoo gibi, IMAP hesabı tarayıcı yoluna çevrilir).
- WhatsApp tek seferlik medya ikizi: telefon aynı gönderimi iki kimlikle yollayabiliyor (biri tek, biri çift tik iki yer tutucu) → `upsertPlaceholder`
  aynı sohbet+gönderen ±10 sn ikizi varsa yeni kayıt açmaz, kimliği `twins` ile bağlar (alındılar tek balona); açılışta `store.dropTwins` eskileri birleştirir.
- **Kaydırarak yanıt animasyonu** (Conversation.tsx `swipeProps`): ham dx → rAF ile yumuşatılan `--sw` (CSS `@property`, sayı), 60 px sonrası lastik direnci,
  56 px'te hazır (ok mor + pop, `navigator.vibrate`), bırakınca `.swipe-back` yaylı geçiş; ok yarı hızda gelip belirir/büyür; `.reply-bar` kayarak açılır.
  Trackpad: hareket başlayınca tekerlek olayları PENCEREDEN dinlenir (`wheelFeed`; balon imlecin altından kayınca olaylar kesilip hareket sıfırlanıyordu),
  180 ms sessizlik = bırakıldı, tetikten sonra 450 ms atalet yok sayılır. `prefers-reduced-motion` uyar.

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
