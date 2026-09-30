# Mivelo — Claude için proje notları

Birleşik gelen kutusu masaüstü uygulaması (quicker.chat'ten esinlenmiş, daha gelişmiş): WhatsApp, Telegram, Slack, iMessage,
LinkedIn, X, Instagram, Messenger, e-posta (Gmail/Outlook/Yahoo/iCloud/IMAP) ve Shopier siparişleri tek yerde. Yerel öncelikli,
ücretsiz (hiçbir ücretli servis yok), AI destekli (isteğe bağlı Anthropic anahtarı). Sahibi: Kaan (Türkiye, geliştirici).
Dil: arayüz ve yorumlar Türkçe.

## Kaan'ın çalışma tercihleri
- Onay sorma, ilerle; belirsizlikte en makul yorumu seç ve ne yaptığını söyle.
- **Yanıtlar KISA ve Türkçe** (Kaan, 29.09): yapılanı uzun uzun anlatma; birkaç satır özet yeter.
- Yeni npm bağımlılığı eklersen **açıkça** "npm install gerekli" de.
- Ekran görüntüsü/log gelirse kök nedeni bul, yama yapma; birden fazla sorunu tek turda topluca çöz.
- **Her değişiklik otomatik yayında**: doğrulamadan sonra commit + main'e push ET (sormadan). Demo: push → `deploy-demo.yml`
  (demo.mivelo.app + mivelo.app). Yerel (Mac): `npm run autodeploy -- install` (`scripts/auto-deploy.mjs`) iki LaunchAgent kurar:
  `app.mivelo.autodeploy` 2 dk'da bir origin/main'i çeker (yalnız main + temiz ağaç, ff-only; yalnız package-lock.json kirliyse geri alır),
  package*.json değiştiyse npm install + web servisini yeniden başlatır, çekirdek değiştiyse core build; macOS bildirimi, günlük
  `~/.mivelo/autodeploy.log`. `app.mivelo.web` = `npm run dev` arka planda (KeepAlive, oturum açılınca; günlük `~/.mivelo/web.log`
  5 MB'ta kırpılır) → Kaan Mivelo'yu http://localhost:5173 adresinde web olarak kullanıyor (masaüstü uygulaması şimdilik YOK;
  `--app` ile paketleme açılır). tsx watch/Vite kod değişikliğini kendisi alır. `-- status | restart | run | uninstall`.
- Değişiklik sonrası: `npm run typecheck`, `npm run build -w packages/core`, `npm run build -w apps/web`; mümkünse demo
  modunda (`npm run demo`) Playwright ile görsel doğrulama.

- **Depo HERKESE AÇIK (Kaan, 29.09; Actions dakikaları ücretsiz olsun diye)**: depoya ve commit mesajlarına ASLA gizli bilgi yazma (şifre,
  API anahtarı, token, gerçek e-posta/telefon, müşteri/üye verisi, sunucu şifresi); gizliler GitHub Secrets'ta ya da sunucudaki ~/mivelo-data'da.
  Testlerde yalnız yer tutucu (905000000099, ornek@example.com). Geçmiş tarandı (29.09): bilinçli açık kalanlar admin/demo bcrypt karmaları
  (`DEFAULT_HASH`, `SEED_USERS`; Kaan panelden şifreyi değiştirince sunucudaki karma geçerli olur) ve Telegram api_hash (masaüstü paketinde zaten var).

## Test ve doğrulama
- **Canlı E2E** (`npm run e2e -- <komut>`, `scripts/e2e.mjs`; kullanıcının Mac'inde, `npm run dev` açıkken): `setup` ana ⇄ test hesap/sohbet
  eşleştirmesi (`~/.mivelo/e2e.json`; ikisi de Mivelo'ya bağlı; tek hesapta "elle" mod), `run [--ui] [wa ig …]` gidiş (`#e2e-ID-g`) /
  dönüş (`-d`) turu: gönderim API ms, karşı tarafta görülme ve platform zamanından gecikme, kendi kaydı, kopya, Türkçe/emoji bütünlüğü;
  canlı günlük sınıflandırma (`RULES`: derleme/port/hız sınırı/doğrulama/PIN/oturum/API→HTML/medya…) + hesap durum değişimleri;
  `--ui` Chromium'da duman testi (⌘K, mesaja gidiş, Takvim, konsol/sayfa/istek hataları). `watch` yalnız izleme. Rapor
  `~/.mivelo/e2e/rapor-*.md` → Claude'a yapıştırılır. Bekleyiciler gönderimden ÖNCE kurulur (çekirdek kendi kaydını HTTP yanıtından önce yayar).
  Demo çekirdeği `#e2e-` etiketli mesaja 2 sn'de yankı verir (aracın kendisi demo ile sınanır).
- `npm test -w packages/core` — sahte sayfa nesnesiyle strateji birim testleri (Slack: client.counts/conversations.list/history biçimlendirme,
  before, conversations.mark). Yeni strateji mantığı için buraya test ekle.
- Tanı betikleri (Mac'te, değer yazdırmaz; çıktı Claude'a): `node scripts/imessage-probe.mjs` (chat.db ↔ Mivelo sayıları, en yeni mesaj,
  klasörler, node ikilisi FDA yolu), `node scripts/trendyol-probe.mjs` (soru alan adları + aday sipariş sorusu uçları). Trendyol connector'ı
  soru alan adlarını günlüğe bir kez yazar (`Trendyol soru alanları: …`); `questionOrderNo` adında order geçen alanı sipariş bağı sayar.
  Ölçüm (28.09): qna/questions/filter sipariş bağı alanı DÖNDÜRMÜYOR (answer, creationDate, customerId, id, imageUrl, productName, public,
  showUserName, status, text, userName, webUrl, productMainId). Araştırma (28.09): Trendyol'da SİPARİŞ SORUSU API'si YOK; 556 = ağ geçidinde
  yönlendirilmemiş yol (order-questions var olmayan uç). Yeniden ölçüm (28.09, Kaan tüm API rollerini açtıktan sonra): DEĞİŞMEDİ — order-questions hâlâ 556, questionType=ORDER yok sayılıyor
  (aynı 4 soru), orders/questions 404, order/…/questions 401. Rol sorunu değil. Kaan'ın kararıyla Trendyol sipariş soruları KALDIRILDI: sekme yok (`questionOrderRef` trendyol'da
  boş), çekirdekte `questionOrderNo`/alan tanısı silindi, tüm sorular ürün sorusu; tarayıcıyla panel okuma YAPILMAYACAK. Panel verisi
  ancak satıcı paneli tarayıcı köprüsüyle okunabilir (yapılmadı).
- **Trendyol sipariş API v2** (v1 `/orders` 15 Ekim 2026'da kapanıyor): `GATEWAYS[0].ordersV2` = `/integration/order/sellers/{id}/v2/orders`
  önce denenir; 404/410/556 → bir kez `noOrdersV2`, v1 (günlükte uyarı). v2 yalnız son 1 ay + 10.000 kayıt → ilk eşitleme 2×2 hafta (v1'de 6).
  Geçmiş için `orders/stream` (nextCursor, 3 ay) var — kullanılmadı. Test: trendyol.test.ts.
- **Masaüstü duman testi** (`.github/workflows/desktop-smoke.yml`, 29.09): build-desktop bitince (workflow_run) ya da elle (`run_id`) GitHub'ın
  Apple Silicon Mac'inde (macos-14) GERÇEK DMG kurulur, karantina kaldırılır, (1) uygulama açılır + 60 sn çekirdek ölçülür (`scripts/smoke/probe.mjs`:
  health/accounts/chats, ilk dinleme, en uzun yanıt, >3 sn sayısı) + `screencapture`, (2) paketin KENDİ node'u/modülleriyle `scripts/smoke/seed.mjs`
  (şifreli DB, ~250 bin yer tutucu mesaj, Instagram/iMessage/Telegram hesapları + `removing:` bayraklı 100 bin mesajlık hesap) ve çekirdek 120 sn ölçülür.
  Sonuç iş günlüğünde + `smoke-logs` çıktısında (Claude `get_job_logs` ile okur). Gerçek kullanıcı verisi/TCC/Anahtar Zinciri penceresi taklit EDİLMEZ.
  Linux ölçümü (29.09): 250 bin mesaj, en uzun yanıt 0,48 sn, 100 bin mesaj silme 5 sn.
- **GitHub Actions canlı izleme** (`npm run ci`, `scripts/ci-watch.mjs`, Kaan 29.09): terminalde son çalışmalar (derleme/duman testi/demo yayını)
  iş + adım + süre, süren adım adı, başarısız adım; yeni çalışma kendiliğinden eklenir, başlayınca/bitince macOS bildirimi + zil. `--once` tek sefer,
  `--logs` başarısız adımın son 40 satırı (giriş gerekir). Belirteç: `GITHUB_TOKEN` ya da `gh auth token` (401'de girişsize düşer); girişsiz saatte
  60 istek (ETag 304 sayılmaz) → süren işte 15 sn, boşta 60 sn; girişliyse 5/20 sn. Belirteç yazdırılmaz.
- `node scripts/verify-strategy.mjs <slack|instagram|linkedin|x|messenger>` — canlı oturumun profil KOPYASIYLA (uygulamaya dokunmadan)
  threads/messages/before doğrulaması. Önce `npm run build -w packages/core`.

## Yapı
- **Veri klasörü `~/.mivelo`** (eski adı `~/.kavsak`): `config.ts` `migrateDataDir` ilk açılışta öğe öğe taşır (aynı adlı öğe varsa eski
  yerinde kalır, günlük/kilit dosyası ise atılır; sonraki açılışta yeniden denenir), eski yol `~/.mivelo`'ya sembolik bağ olur; veritabanı
  `kavsak.db` → `mivelo.db` (WAL/SHM ile). Ortam: `MIVELO_DATA_DIR` (eski `KAVSAK_DATA_DIR` de geçerli). Betikler ~/.mivelo yoksa ~/.kavsak'a bakar.
  Anahtar Zinciri hizmet adları, localStorage `kavsak.*` anahtarları ve Tauri kimliği `app.kavsak.desktop` DEĞİŞMEDİ (izinler/ayarlar kaybolmasın).
- `packages/core` — Node 22, TypeScript ESM. SQLite (better-sqlite3 + FTS5) `~/.mivelo/mivelo.db`; oturumlar
  `~/.mivelo/sessions/<hesapId>/`. REST + WS sunucu 127.0.0.1:7788 (`server.ts`). `registry.ts` hesap↔connector.
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
  (Resources/core). Günlükler: `~/.mivelo/desktop.log`, `~/.mivelo/core.log`. Release'te devtools açık.
- Komutlar: `npm run dev` (çekirdek+Vite), `npm run demo`, `npm run desktop` (Tauri dev), `npm run app` (paketle + aç; `scripts/open-app.mjs`).
- **Herkese açık demo** (`VITE_STATIC_DEMO=1`, `static-demo.ts`): main'e push → `.github/workflows/deploy-demo.yml` FTP ile
  `demo.mivelo.app/` klasörüne (cPanel hesabı kaantiftikci.com; demo hesapları `~/mivelo-data`, `public/api/index.php`). Aynı iş akışı
  `apps/landing/` (bekleme listesi sayfası, tek dosya `index.html`; iletişim hello@mivelo.app) → `mivelo.app/`; kayıtlar
  `api/waitlist.php` → `~/mivelo-data/waitlist.json` (e-posta tekil ve sıkı biçim, davet kodu `?ref=`, `refs` sayacı, gizli `website`
  bot tuzağı, IP başına 20/saat + günlük 2000). `gizlilik.html`, `kosullar.html`, `og.png`, `apple-touch-icon.png` de burada.
  Landing hero'su: görünüm sekmeleri yalnız sahnenin altındaki `#seg` ("Kendine göre ayarla"; sahnedeki yüzen kopya kaldırıldı); her sekme imleçle ufak bir görev
  oynatır (`TASKS` dizisi, kaplamalar 1440×900 kare koordinatlarında). Telefon/tablette de masaüstü penceresi gösterilir.
  "21 uygulama" bölümü (`.dock` grupları Sosyal medya 9 · E-posta 5 · Pazaryerleri 7 — ePttAVM sarı "ePtt" SVG kutusu n11'den sonra): telefonda
  simge boyu `min(32px, (100vw-104px)/9)` TÜM gruplarda aynı → 9'lu grup tek satır (eski 8 sütunlu ızgarada TikTok alta kayıyordu).
- **Yönetim paneli** `mivelo.app/admin` (`apps/landing/admin/`: `index.html` tek sayfa + `api.php`): bekleme listesi (durum
  Bekliyor/Davet edildi/Katıldı/Spam, not, toplu işlem, CSV), trafik (`api/track.php` çerezsiz sayaç → `~/mivelo-data/stats/`),
  demo hesapları (demo `index.php` girişte `logins`/`lastLogin` yazar), görevler, şifre değiştirme, JSON yedek. Varsayılan şifre
  karması `api.php` `DEFAULT_HASH`; panelden değişince `~/mivelo-data/admin.json`. 5 hatalı girişte IP 15 dk kilitlenir.
  **Demo üyeliği KAPALI (Kaan, 29.09)**: demoda YALNIZ `admin` girer; `index.php` `SIGNUP_OPEN=false` (register 410, signup_config `open:false`),
  `Auth.tsx` yalnız "Giriş yap" (üyelik sekmesi/formu SİLİNDİ). `MEMBERS_PURGE` 1: admin dışındaki tüm demo üyeleri users.json'dan bir kez silinir
  (oturumları düşer; aynı temizlik admin `demo` ucunda da), silinenlerin ad+e-postası (reddedilen hariç) `members.json`'a src 'demo' aktarılır.
  **Lisans için kayıt = indirme sayfası**: kartlardaki "İndir" → kayıt penceresi `#dlm` (ad, soyad, e-posta, gizlilik onayı, bot tuzağı) →
  `api/register.php` → `lib-members.php` `mv_members_update`/`mv_member_upsert` → `~/mivelo-data/members.json` (src 'indir', indirme geçmişi ≤20;
  IP başına saatte 10 yeni, günde 1000) → dosya kendiliğinden iner; tarayıcıda kayıt varsa (`localStorage mivelo.reg`) pencere açılmaz, indirme
  keepalive ile kayda yazılır. Bekleme listesi (waitlist.json) AYRI ve yalnız e-posta — ona ekleme YAPILMAZ.
  **Kayıt denetimi** (lib-members `mv_member_name_error`/`mv_member_email_error`, indir sayfasında da aynı kurallar): ad/soyad yalnız harf (+boşluk ' - .),
  en az 2 harf, ≤40; e-posta sıkı biçim + geçici servis listesi (`mv_disposable_domains`) + alan adında MX/A kaydı (`checkdnsrr`; testte `MV_SKIP_DNS=1`).
  Aynı e-posta yeni kayıt açmaz (`{known:true}` → "Zaten kayıtlısın"). **Aynı ad soyad** (`mv_member_namekey`: büyük/küçük harf + Türkçe karakter farkı
  yok, en az iki kelime) başka e-postadan gelirse kayıt `dupOf` ile işaretlenir; admin `people_with_keys` grupta tek "asıl" seçer (etkin anahtarlı, yoksa
  ilk kaydolan), ötekiler dupOf → `license_issue` onları ve aynı istekte adı tekrarlayanı ATLAR (`skipped`), arayüzde soluk "Aynı ad" satırı.
  **Admin → Üyeler** (ayrı sayfa `#p-uye`, Lisanslar'dan taşındı; `members` ucu = members.json'dakiler, `member_delete`): ad, e-posta, kaynak (İndirme
  sayfası / Eski demo üyesi), kayıt zamanı, indirme sayısı + son dosya, anahtar durumu; filtre Tümü/Anahtarsız/Gönderilen/Hatalı/Aynı ad; seç → cihaz +
  süre (vars. 30 gün) → anahtar gönder, Sil (iki tık; üyenin e-postası/gönderildiği adres eşleşen lisans anahtarları da silinir → uygulama sonraki denetimde kilitlenir). Bekleme listesindekilere anahtar: Bekleme listesi toplu çubuğu "Anahtar gönder" (2 cihaz, 30 gün).
  Lisanslar sayfasında yalnız e-posta taslağı + anahtar üretme + anahtar listesi. Oluştur formunda "Kime / not" ya da "E-posta"ya tıklayınca kayıtlı kişiler
  (`lic_people`: üyeler + bekleme listesi + demo üyeleri, dupOf hariç) açılır liste `#licPick`: yazarak ad/e-postada arama (Türkçe karakter/büyük-küçük
  harf duyarsız, çok kelime), ↑/↓/Enter/Esc, seçince ad → not, e-posta → e-posta; etkin anahtarı olan "Anahtarı var" rozeti + uyarı. `lib-members.php`
  demo api/'ye de kopyalanır (deploy-demo.yml). LicenseGate: "anahtarın mivelo.app/indir'den indirirken kayıt olduğun e-postaya gelir".
  (Eski) Demo üyeliği: hazır tek hesap `admin` (şifre karması `SEED_USERS`, `passVersion` artınca users.json'daki karma da güncellenir; editor/misafir
  `REMOVED_USERS` ile silinir). Giriş ekranında "Üyelik oluştur" (`Auth.tsx`, `authRegister`) → `action=register`: ad + soyad (ayrı alanlar; `firstName`/`lastName`, `name` birleşik), e-posta, kullanıcı adı
  (a-z0-9._-, 3-24), şifre ≥8 (iki kez; not alanı YOK); IP başına saatte 5 (`demo-signup.json`), gizli `website` bot tuzağı, ≤300 bekleyen. Kayıt users.json'da
  **Otomatik onay** (Admin → Demo anahtarı, `~/mivelo-data/demo-settings.json` `autoApprove`, VARSAYILAN AÇIK — onay e-postası
  gidemediği sürece; Kaan e-posta düzelince kapatacak): kayıt `active` + `approvedBy:'auto'`, yanıt `pending:false` → Auth.tsx doğrudan giriş
  (`signup_config` ile metin "Üye ol"); açıkken bekleyen talep ilk girişte onaylanır (reddedilen asla). Kapalıyken:
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
  **Demoda bağlanma gerçek akışla**: WhatsApp/Telegram `addAccount` → 'pairing' + taranamaz örnek QR (`demoQr`); KENDİLİĞİNDEN bağlanmaz
  (Kaan: "eşleşme bekleniyor derken bir anda bağlı"), "Kodu okuttum" (`DemoQrDone`) → `completeDemoLogin` (yenilemede yarım QR yeniden gösterilir); tarayıcıyla girilenler (mode 'browser') 'pairing' → yereldeki gibi AYRI giriş
  penceresi `public/demo-login.html` (`openDemoLoginWindow`, 460×640 açılır pencere; platform rengi/kodu; bilgiler gönderilmez/saklanmaz) →
  BroadcastChannel/postMessage `mivelo-demo-login` → `completeDemoLogin`, pencere kapanır. Engellenirse "Giriş ekranını aç". Tek dosya demoda
  (DEMO_OFFLINE) satır içi `DemoLogin` formu. Form doldurulan yollar (e-posta şifresi, pazaryeri, Slack belirteci) `demo-form`
  ile doğrudan bağlanır. Eskiden her şey anında "Bağlı" oluyordu.
  Demoda örnek AI açık (`demo-ai.ts`: sohbete özel taslak/özet/aksiyon/olay, model çağrısı yok); pazaryeri sipariş kartı `Script.order`.
  Tek dosya demo (`npm run demo:html`) profil adı "Mivelo".
- **Tanıtım videosu (reels 1080×1920, ~68 sn; TM() zaman eşlemesi: 5,5 sn sonrası ×1,25 + GAPS araları: AI özeti, sağ panel, takip/zamanlama hareketli grafikleri)** `scripts/promo/`: videodaki arayüz GERÇEK tek dosya demo (iframe, Playwright sanal saati
  `clock.runFor`; imleç/klavye gerçek girişler, CSS animasyonları video zamanına bağlı `syncAnims`; ıskalanan tıklamada DOM güvencesi).
  `reel.html` kompozisyon (tek nesne biçim değiştirir: bildirim hapı → logo → pencere → logo → CTA; Apple tarzı açık zemin, kelime kelime
  bulanıklıktan açılan başlıklar; logolar yalnız ilk iki sahnede), `render.mjs` (--scale 2, --stills), `audio.mjs` (kodla üretilen 120 BPM
  müzik + tık/tuş/gönder/bildirim efektleri, -14 LUFS). Başlık fontu -apple-system/SF Pro (Mac'te), yoksa Inter Display. Demo kancası
  `window.__miveloDemo.incoming(ad, metin)` (static-demo.ts). Ayrıntı `scripts/promo/README.md`; MP4 depoya konmaz.
- **App Store tasarımı (mobil, henüz uygulama YOK)** `design/appstore/`: Liquid Glass (iOS 26) dilinde `template.html` 6 ekran (gelen kutusu, AI özet, Odak, pazaryeri,
  takvim, kanallar/gizlilik) iOS uyarlaması; `node design/appstore/render.mjs` → `out/` 1290×2796 PNG (git dışı). Ayrıntı README.
- **Masaüstü paketleri (DMG + EXE, gerçek kullanım yolu — demo sunucusu değil; ban/gizlilik: kullanıcının kendi IP'si ve cihazı)**:
  `.github/workflows/build-desktop.yml` (eski build-windows.yml'in yerine): YALNIZ elle (Actions → Run workflow) ya da v* etiketi — main'e itme
  sürüm YAYINLAMAZ. **Sürümü Claude otomatik çıkarır (Kaan, 29.09: "sen otomatik yap sürüm işlerini")**: doğrulanmış her iş turu main'e
  itildikten sonra. Depo 29.09'dan beri HERKESE AÇIK → standart GitHub Actions makineleri ücretsiz ve kotasız (özelken macOS ×10 dakika
  sayılıyordu; takılan 0.1.7 derlemesi 2.000 dk'lık kotanın %90'ını bitirmişti). Depo yeniden özele dönerse kota kuralı geri gelir: en çok
  günde bir sürüm, GitHub kota uyarısında sürüm çıkarma. Tetik: GitHub MCP `actions_run_trigger run_workflow build-desktop.yml ref main`
  (etiket itmek bu ortamda proxy 403 veriyor; sürüm 0.1.<run>), sonucu kontrol et; takılırsa HEMEN iptal et. Birim testleri yalnız ayrı
  `test` işinde (ubuntu, 1×, ≤10 dk; sonucu paketlemeyi durdurmaz), `build` işi ≤30 dk; `npm test` `--test-force-exit --test-timeout=120000`. Sürüm 0.1.<run> (etikette
  etiketinki), `--config {"version"}` ile. Matris: mac-arm64 (macos-14), mac-intel (macos-14 + x64 Node/Rosetta + x86_64-apple-darwin), windows-x64 (NSIS).
  DMG'den gizli `.VolumeIcon.icns` + `.fseventsd` CI'da silinir (Finder'da gizli dosyalar açıkken ikinci "amblem" görünüyordu; UDRW → sil → UDZO).
  Mac simgesi `icons/icon.icns` Apple şablonunda (1024 tuval, ortada 824 squircle + gölge; `apps/desktop/scripts/mac-icon.py` → `icon-macos.png`
  → `npx tauri icon` çıktısından YALNIZ icon.icns): macOS 26 şablon dışı (tam kaplayan) simgeyi gri squircle'a koyuyordu. Windows/PNG'ler eski tam kaplayan.
  Node gömülü (`KAVSAK_BUNDLE_NODE=1`), macOS ad-hoc imza (`signingIdentity "-"`; Apple Developer hesabı YOK → macOS 15+/26'da "Mivelo açılmadı" uyarısı; sağ tık → Aç
  ARTIK İŞE YARAMIYOR: Bitti → Sistem Ayarları → Gizlilik ve Güvenlik → "Yine de Aç" + parola (ya da `xattr -dr com.apple.quarantine`); indir sayfası 4 adım),
  Windows imzasız (SmartScreen). Hepsi başarılıysa `publish`: `mivelo.app/indir/files/` (FTP; Mivelo-mac-arm64.dmg, Mivelo-mac-intel.dmg,
  Mivelo-windows-x64-setup.exe, latest.json {version,date,files}; `deploy/indir/.htaccess`: json'da CORS *, indirme başlığı, liste kapalı). İndirme sayfası
  `apps/landing/indir/index.html` (ana sayfanın görsel dili: cam üst çubuk, hareketli gradyan, kelime kelime açılan başlık + süpürülen alt metin,
  kaydırınca beliren kartlar; açılışta HER CİHAZDA AYNI tek koyu "Sürümleri gör" düğmesi (Apple + Windows logosu → #surumler) + "Sürüm X" + "Tüm sürümler ↓"
  (Kaan: mobil ve masaüstü aynı dursun; işletim sistemine göre "Mac/Windows için indir" YOK); "Senin için önerilen" çerçevesi KALDIRILDI.
  Başlık "Mivelo'yu indir." ana sayfa h1'iyle aynı (font/boyut/renk, 160 ms kelime açılışı, telefonda min(54px,13.2vw)); düğmeler ve Mac/Windows
  sekmesi ana sayfanın LIQUID GLASS stilinde (kartlardaki İndir düğmeleri İSTİSNA: düz siyah, Kaan isteği) (cam + ::before kenar + esneyen beyaz mercek; sekmelerde Apple/Windows logosu, seçili Windows mavi) (telefonda en üstte), Mac/Windows kayan hap sekmeli
  kurulum adımları, lisans bandı; latest.json'dan boyut/sürüm; `prefers-reduced-motion` uyar). Mac kurulum adımlarının üstünde sessiz ≈10 sn döngü
  macOS sahnesi (`#gk`, tek dosyada CSS+JS; 1440×900 koordinat, `--u`): Dock'ta Mivelo → "Mivelo açılmadı" → Bitti → Sistem Ayarları → Gizlilik ve Güvenlik →
  aşağı kay → Yine de Aç → parola → "Mivelo açılsın mı?" Yine de Aç → Mivelo lisans ekranı; imleç hedef öğenin GERÇEK konumuna gider (`gpos`), menü
  çubuğunda etkin uygulama adı değişir, alttaki adım kartı `.now` ile vurgulanır; Windows sekmesinde / görünmezken / sekme arka plandayken durur,
  azaltılmış harekette durağan kare (Yine de Aç). Sahne `.steps` DIŞINDA olmalı (`.steps li` kuralları sahnedeki listeyi gizliyordu). `indir/.htaccess` HTML'e `no-cache` (tarayıcı eski
  tasarımı gösteriyordu; admin/ ile aynı kural). Kök `.htaccess` YAZILMAZ (sunucudaki cPanel PHP işleyicisini ezer). Chromium pakette YOK:
  `packages/core/src/browser-install.ts` `ensureChromium` — köprü `launch` öncesi yoksa `playwright install --no-shell chromium` (gömülü node ile,
  tek uçuş, ilerleme hesap durumunda "Tarayıcı bileşeni indiriliyor… %N"); indirilemezse hata + "Yeniden bağlan". Uygulama içi yeni sürüm kartı
  `UpdateBanner.tsx` (yalnız Tauri + `VITE_APP_VERSION`; 6 sa'de bir latest.json; "Sonra" o sürümü atlar). **"Güncelle" = uygulama içi kurulum**
  (29.09, Kaan: indirme sayfasına gitmesin): çekirdek `updater.ts` — latest.json'dan bu OS/işlemcinin paketi (`assetName`: mac arm64/intel DMG,
  Windows setup; ad ve adres yalnız mivelo.app/indir/files, körlemesine alınmaz) `~/.mivelo/update/`e akışla iner, boyut + sha256 (CI latest.json'a
  yazar) doğrulanır; kart ilerleme çubuğu (`GET /api/update` 600 ms), bitince kendiliğinden `POST /api/update/install` → kopuk betik (günlük
  `~/.mivelo/update.log`): Mac `kur.sh` (Mivelo'yu Apple event ile kapatır, ≤30 sn bekler, DMG'den `Mivelo.app.yeni` → eskisiyle değiştirir, hata
  olursa eskisi geri, karantina silinir, `open`), Windows `kur.ps1` (kurulum klasöründeki Mivelo/node süreçleri kapatılır, NSIS `/S` sessiz, yeniden
  açılır). Uygulama konumu `appLocation` (Mac execPath'teki .app, Windows Mivelo.exe'li klasör); geliştirme/elle taşınmış pakette `supported:false`
  → indirme sayfası. /api/update lisanssızken de açık. Tauri updater KULLANILMADI (imza anahtarı gizlisi ister). İlk bu özellikli sürüm elle
  kurulmalı. Gerçek Mac/Windows'ta DENENMEDİ (betik sözdizimi + indirme/sha256/sürüm testleri: updater*.test.ts). ffmpeg pakette yok (sesli mesaj ogg).
- **Lisans (yalnız paketli DMG/EXE)**: kabuk (lib.rs) çekirdeği release'te `MIVELO_REQUIRE_LICENSE=1` + `MIVELO_APP_VERSION` ile başlatır (tauri dev,
  `npm run dev`, demo lisans istemez). Çekirdek `license.ts`: `~/.mivelo/license.json` {key, activation, device, lastOk, expiresAt} (0600); cihaz kimliği
  donanım kimliği (29.09: IOPlatformUUID/MachineGuid/machine-id, yedek hostname|kullanıcı; eski MAC'li kayıtlar hoşgörüyle); lisanssızken kanallar başlamaz (`whenLicensed` → bootAll) ve /api 402 (yalnız /api/health + /api/license);
  GET/POST/DELETE `/api/license` (`?check=1`: sunucuya sor, en çok dakikada bir); açılışta + 30 dk'da bir + arayüz öne gelince `check`: sunucu `invalid` derse (iptal/süre/cihaz kaldırıldı) kilit + registry.stopAll,
  ağ hatasında 14 gün çevrimdışı pay. Arayüz `LicenseGate.tsx` (main.tsx, yalnız Tauri): anahtar ekranı (MVL-XXXX-… biçimleme), 10 dk'da bir ve odakta
  yeniden sorar (?check=1 → iptal pencereye dönünce hemen kilitler). Sunucu `apps/landing/api/license.php` (mivelo.app/api/license.php; activate/check/release; `~/mivelo-data/licenses.json`, hatalı
  anahtar IP başına saatte 20, `license-rate.json`). Admin → **Lisanslar** (`api.php` licenses/license_create/update/delete; anahtar `MVL-` + 4×4
  karışmayan harf/rakam, 80 bit; not, e-posta (bekleme listesinden öneri), cihaz sınırı 1-10 (vars. 2), süre VARSAYILAN 30 gün (7/14/30/60/90/180/365/süresiz + "Özel…" 1-3650 gün; bitiş tarihi
  etiketin yanında; `daysOf`/`daysHint`, Oluştur formu ve Üyelere gönder'de aynı; sunucu `days` gelmezse 30), adet ≤50;
  Kopyala · E-postayla gönder (SMTP) / Taslağı aç (mailto yedeği) · İptal et/Etkinleştir · Cihazları sıfırla · cihaz başına Kaldır · Sil).
  **Anahtar gönderimi** (Üyeler sayfası / Bekleme listesi toplu): üyeler + bekleme listesi + demo üyeleri (spam/reddedilen hariç, e-postayla birleşik; `lic_people`) seçilir →
  `license_issue` kişi başına etkin anahtarı varsa onu, yoksa yenisini (≤50/istek) logolu HTML e-postayla gönderir (`lic_send_one`: anahtara
  `sentAt/sentTo/mailError`, başarıda bekleme listesi Bekliyor → Davet edildi). Oluştur formunda "hemen gönder" kutusu. **E-posta taslağı**
  (`~/mivelo-data/license-mail.json`, varsayılan `LIC_MAIL_DEFAULT`: kurumsal "siz" dili, konu "Mivelo Masaüstü Uygulaması | Lisans Anahtarınız";
  eski samimi varsayılan kayıtlıysa `LIC_MAIL_OLD` ile yenisine döner): yer tutucular {ad} (ad soyad; bilinmiyorsa "Sayın {ad}" → "Değerli
  kullanıcımız") {ilkad} {anahtar} (tek satırda büyük kutu) {indir} {cihaz} {gecerlilik}; canlı önizleme (`lic_mail_preview`, sandbox iframe) +
  deneme gönderimi. Kurulum 1. adımında {indir} (mivelo.app/indir). HTML tablo düzeni, üst şeritte logo + "Mivelo", altta küçük logo; logo (`apple-touch-icon.png`) e-postaya GÖMÜLÜ gider
  (`mv_send_mail(..., $html, $inline)` → multipart/related, `cid:mivelo-logo`; önizlemede data: adresi) — uzaktan görsel engelleyen istemcide de görünür.
  Gönderim SMTP'ye bağlı: Türkticaret giden SMTP'yi açmadıkça "Gönderilemedi" (anahtar yine üretilir). Yerelde sahte SMTP ile sınandı.
  İstemci tarafı denetimdir (paket değiştirilerek aşılabilir); amaç anahtarsız dağıtımı engellemek. Yerel uçtan uca sınandı (php -S + çekirdek).
- **İlk açılış, açılış animasyonu, çıkış** (`Onboarding.tsx`, `LicenseGate.tsx`; yalnız Tauri, çıkış her yerde): sıra kısa açılış animasyonu (lisans
  durumu gelene dek) → lisans ekranı → **ilk kurulum** (izinler bir kez: `mivelo.setup`='1', durumlar `mivelo.setupPerms`; Bildirimler = deneme bildirimi
  macOS izin penceresini şimdi çıkarır, Mikrofon = getUserMedia, Mac: Tam Disk Erişimi = Sistem Ayarları bölmesi + 1,5 sn'de bir `GET /api/permissions`
  (`permissions.ts fullDiskAccess`: chat.db/TCC.db/Safari açılabiliyor mu, EPERM = yok; "Çık ve Yeniden Aç" sonrası kurulum kaldığı yerden sürer),
  Mesajlar otomasyonu `POST /api/permissions/messages` (osascript, -1743 = red), Takvim isteğe bağlı (calendars probe); "Hepsine izin ver" FDA'yı en sona
  koyar) → **uzun açılış animasyonu** (`Splash` full ≈3,8 sn, quick ≈1,8 sn — 29.09 Kaan: 2,8 kısa, 5,5 çok uzun; logo + "mivelo" dışında alt yazı/çubuk YOK: kare büyür, kıvrım çizilir, lime nokta, "mivelo", ilerleme çubuğu; App ALTTA hemen çizilir,
  katman büyüyüp saydamlaşır) → uygulama; sonraki açılışlarda kısa (≈1,8 sn); `prefers-reduced-motion` uyar. Akıcılık (29.09, Kaan: "logo donuk donuk"): animasyonlar YALNIZ transform/opacity (kare ölçeği svg kökünde, gölge `.sp-stage::before` ayrı katmanda — eski `drop-shadow` filtresi ve yazıdaki blur her karede yeniden çiziliyordu), `.go` iki rAF sonra (uygulama altta ilk çizimini yaparken animasyon duraklı bekler). Demoda da girişten sonra uzun animasyon.
  **Kurulum ekranı yeniden (29.09, Kaan: "izin verdim ama vermemiş gibi görünüyor", "amatörce, AI olduğu belli")**: iki bölmeli `.setup2` (solda mor
  marka paneli: logo, "Kurulum", başlık, 2 güvence maddesi; sağda "İzinler" + "N / M açık" + ilerleme çubuğu + tek çerçeveli liste, eşit satırlar,
  kısa açıklamalar; sağda durum: "✓ Açık" / "Bekleniyor" / "Ayarları aç" (reddedilen) / "İzin ver"; YALNIZ sıradaki adım dolu düğme; altta
  "Tümüne izin ver" (≥2 bekleyen) + "Devam et"/"Şimdilik geç"). Durum TAHMİN DEĞİL, 2 sn'de bir + odakta canlı: bildirim eklentisi
  `isPermissionGranted` (istek `requestPermission`, eski deneme bildirimi → "İstendi" kaldırıldı), FDA denemesi, macOS izin kaydı
  (`permissions.ts tccStatus`: kullanıcı TCC.db salt okunur, FDA gerekir; istemci `app.kavsak.desktop` ya da `/Mivelo.app/` yolu; mikrofon,
  Apple Events → com.apple.MobileSMS / com.apple.iCal; `/api/permissions` `tcc`), mikrofon için ayrıca permissions.query; localStorage yanıtı
  yalnız yedek. Test: permissions-tcc.test.ts. PermissionBanner da tcc'yi kullanır.
  iMessage açılışta FDA bölmesini artık kendiliğinden AÇMAZ (yalnız interactive start). Ayarlar → İzinler (Tauri) aynı satırlar + "Yeniden iste".
  `Entitlements.plist` (tauri.conf macOS.entitlements; hardened runtime'da audio-input/apple-events/addressbook/calendars yoksa macOS izni SORMADAN
  reddeder → sesli mesaj kaydı çalışmıyordu). Gerçek Mac'te DENENMEDİ (Playwright + sahte Tauri iç API'siyle sınandı).
  **Çıkış yap** (Ayarlar menüsünün altındaki kırmızı düğme; web demoda hemen çıkar): yerel/masaüstünde önce onay kartı (`AccountPane`). Masaüstü (lisans
  zorunlu) → `DELETE /api/license` (cihaz hakkı boşalır, kanallar durur) → lisans ekranı "Çıkış yaptın" + "Giriş yap" → uzun animasyon. Lisans istenmeyen
  yerel sürümde (localhost) yalnız arayüzden çıkış (`mivelo.signedOut`, "Yeniden giriş yap"); aynı ~/.mivelo'yu paylaşan masaüstü lisansına DOKUNMAZ.
  Ayarlar → Hesap: ad, e-posta, maskeli anahtar + kalan gün, sürüm. **Profil adı** artık sabit "Kaan" DEĞİL: lisans sahibi (license.php activate/check
  `owner {name,email}` = anahtarın email'i ya da sentTo + members.json ad soyad; çekirdek license.json'da saklar, `licenseStatus().owner`, test:
  license-owner.test.ts), yoksa işletim sistemi tam adı (`/api/health` `user`, `platform.ts userDisplayName`: macOS `id -F`, Linux GECOS). Odak'ta ilk ad.
- **Windows**: `tauri.windows.conf.json` (NSIS, currentUser, yerel başlık çubuğu) Tauri'nin platform yapılandırma birleştirmesiyle
  uygulanır; paket yalnız CI'da üretilir (`.github/workflows/build-desktop.yml` windows-x64 işi, windows-latest,
  `KAVSAK_BUNDLE_NODE=1` ile node.exe `core-bundle/bin/`e gömülür, kabuk önce onu dener). `lib.rs`: kısayol Ctrl+Shift+K,
  rozet yok (okunmamış sayısı tepsi ipucunda), tepside renkli simge, node `CREATE_NO_WINDOW`. Çekirdekte OS farkları
  `packages/core/src/platform.ts` (`openExternal`, `killProcessesMatching`, `IS_WINDOWS`…). DB anahtarı Windows'ta DPAPI
  (PowerShell ProtectedData, CurrentUser) → `~/.mivelo/db.key.dpapi`; Linux'ta `db.key` dosyası. Oturum klasörlerinde `:` → `_`
  (yalnız Windows). Mac'e özgü kalanlar: iMessage (arayüzde "Yalnız Mac"), macOS Kişiler, Anahtar Zinciri, Dock rozeti.
  Linux'ta `cargo check --target x86_64-pc-windows-msvc` çalışır (webkit gerekmez; `src-tauri/core-bundle/` klasörü var olmalı);
  gerçek Windows cihaz testi yapılmadı.
- **Sunucu çekirdeği KALDIRILDI (28.09)**: demo üyeleri için VPS'te üye başına çekirdek (apps/gateway, deploy/server, `IS_SERVER`, admin
  "Sunucu çekirdeği" kartı, demo `core_token`) denendi ve silindi: veri merkezi IP'si + aynı IP'de çok hesap → Instagram/Meta/LinkedIn/X ban riski,
  tüm oturumlar tek sunucuda (güvenlik/KVKK), gerçek giriş sayfası kullanıcının tarayıcısında açılamıyor (çerezler sunucuya taşınamaz). Gerçek
  kullanım = masaüstü paketleri (DMG/EXE, kullanıcının kendi cihazı ve IP'si). Demo sitesi yalnız tanıtım (örnek veri). `#core=` tünel yolu (REMOTE_CORE) duruyor.
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
  Çerezli medya `fetchMedia` ile vekilden geçer, `~/.mivelo/sessions/<hesap>/media` önbelleği.
- **TikTok** (`connectors/browser/tiktok.ts`, DENEYSEL, gerçek hesapla DOĞRULANMADI; arayüzde "deneysel" etiketi): herkese açık DM API'si yok →
  tiktok.com/messages DOM'u. Seçiciler `data-e2e` (chat-list-item, chat-item, chat-nickname, chat-uniqueid, message-input-area, message-send) + sınıf
  parçaları (InfoNickname/InfoExtract/InfoTime, TimeContainer) + geometri; ilk turda `TikTok tanı:` günlüğü (sayılar + data-e2e adları, içerik yok) →
  seçiciler buna göre ayarlanır. Oturum `sessionid`/`sid_tt`; kimlik `__UNIVERSAL_DATA_FOR_REHYDRATION__` user (@uniqueId). Sohbet kimliği görünen addan
  (aynı ada #2), açılınca @kullanıcı adı → handle/link. Mesaj kimliği sohbet + çözülen ayırıcı zamanı + gönderen + metin ("Bugün"→"Dün" olsa da aynı).
  Paylaşılan video = kapak + /video/ bağlantısı eki. Gönderim Draft.js'e klavyeyle (satır arası Shift+Enter). Yoklama 60 sn (rtSlowdown 3), captcha →
  'pairing' + `attention`. Sınırlar: günlük 300, ilk temas 40. Okumak için sohbet açılır → karşı tarafa "Görüldü" gidebilir. Test: tiktok.test.ts
  (saf fonksiyonlar); DOM kodu yerelde sahte TikTok sayfasıyla sınandı. `verify-strategy.mjs tiktok`, e2e takma adı `tt`.
- **Bağlanma iptali (29.09, Kaan: X giriş penceresini girişsiz kapattım, "eşleşme bekleniyor"da kaldı)**: köprü `waitForLogin` pencere
  kapanınca/iptalde `loginCancelled` → tarayıcı TAMAMEN kapanır (macOS'ta son pencere kapanınca Chromium açık kalıyordu), hesap 'disconnected'
  "Giriş yapılmadı", `account.login-cancelled` olayı → registry bu oturumda "Bağlan" ile açılmış, hiç bağlanmamış (`fresh`) hesabı kaldırır
  (`cancelLogin` → `account.removed`, kart "Bağlan"a döner); var olan hesabın denemesi durur. Giriş algılandıktan sonra kapatılırsa devam
  edilir. `POST /api/accounts/:id/cancel-login`. Arayüz: Bağlan penceresi kapanınca bu pencerede başlatılıp hâlâ bekleyen QR'lı hesaplar
  (WhatsApp/Telegram; tek dosya demoda satır içi giriş formu da) iptal (`startedHere`, `QR_CANCEL`). Demo: giriş açılır penceresi girişsiz
  kapanınca (`watchDemoLoginWindow`, `win.closed` + 0,9 sn pay) aynı. Bildirim "Giriş penceresi kapatıldı; bağlanma iptal edildi". Test: connect-cancel.test.ts.
- **Giriş penceresi bekçisi (29.09, Kaan: Slack giriş penceresini kapattım, "Bağlanıyor" + yüzde artmaya devam etti)**: ayrı giriş penceresi
  açılınca durum hemen 'pairing' (`launchLogin`), köprü saniyede bir açık sayfa kalmış mı bakar (`watchLoginWindow`, iki ardışık boş denetim;
  macOS'ta son pencere kapanınca bağlam açık kalıp 'close' gelmiyor) → `loginCancelled` ("Bağlı değil"); giriş algılanınca ya da PIN adımında
  (oturum var) bekçi durur. HİÇBİR kanalda 'connecting'de eşitleme çubuğu BAŞLAMAZ (29.09, Kaan: Telegram Bağlan → %7 sonra QR; sahte yüzde yok): çubuk giriş doğrulanınca ('connected' %60, tarayıcıda oturum doğrulandı %45).
  Açılışta etkileşimsiz tarayıcı kanalları sıraya girer (`acquireBootSlot`, yuva ≤45 sn); kullanıcının "Bağlan"ı sıraya girmez.
- **Açılış planı (29.09, `boot-plan.ts`)**: hafif kanallar (WhatsApp/Telegram/iMessage/IMAP/pazaryeri) hemen birlikte; tarayıcı kanalları
  (`isBrowserAccount`, registry) ağırlıklı en kısa iş önce: puan = (1+okunmamış/10)·(0,3+yakınlık)/beklenen süre; süre = hesabın ölçülen
  açılış süresi (`meta boot_ms:<hesap>`, üstel ortalama, bridge.start yazar) ya da `BROWSER_DEFAULT_MS`. Aynı anda açılan tarayıcı sayısı
  makineden `browserSlots` (çekirdek/3 ve boş bellek/700 MB'ın küçüğü, 1–4). Günlükte "Açılış sırası …". Test: boot-plan.test.ts.
- **Kendiliğinden iyileşme (29.09, Kaan: ufacık bağlantı sorununda uyarı çıkmasın, önce arka planda denesin)**: registry `onStatusForHeal`:
  geçici düşüş (error/detaylı disconnected; ağ, zaman aşımı, tarayıcı çöktü; tarayıcı kanalında "Giriş gerekli/Oturum düştü" pairing) →
  penceresiz yeniden başlatma 15 sn / 45 sn / 2 dk (±%20); bu sürede `Account.autoRetry` → arayüz uyarı göstermez (`accountIssue` null,
  nokta 'connecting', Bağlan kartında "Yeniden bağlanılıyor…"). Üçü de tutmazsa uyarı. Denenmeyenler (`transient` hard): şifre/anahtar
  reddi, 401-406, eksik bilgi, kısıtlama, başka yerde açıldı, captcha/güvenlik doğrulaması, kullanıcı iptali, QR/PIN eşleşmesi. Kullanıcı
  Yeniden bağlan/iptal/kaldır ya da stopAll zamanlayıcıyı temizler; bağlanınca sayaç sıfırlanır. Denemede eski connector'ın ayrıntısız
  'disconnected'ı sayacı SİLMEZ (siliyordu → Mac duman testinde Instagram 15 sn'de bir sonsuz yeniden açıldı). Test: auto-heal.test.ts.
- **TikTok sağlamlaştırma (29.09, Kaan: girişten sonra mesaj gelmedi; gerçek DOM görülmedi)**: satır/mesaj seçicilerine bileşen sınıf adı
  yedekleri (DivItemWrapper/ChatListItem/ConversationItem, DivChatItemWrapper/MessageItemWrapper…), yalnız en dıştaki eşleşme sayılır;
  `TikTok tanı` artık tüm data-e2e adları + sohbetle ilgili sınıf parçası sayıları + başlık/gövde uzunluğu/giriş düğmesi (içerik yok);
  sohbet açılıp mesaj okunamazsa bir kez daha tanı. Kaan'ın ilk tanısı (29.09, KİŞİSEL hesap): tiktok.com/messages → `/business-suite/messages`
  ("Business Suite | TikTok", gövde 1241 kr., hiç data-e2e/sohbet öğesi yok) — eskiden bu adres mesaj sayfası sayılmayıp her turda yeniden yükleniyordu.
  Şimdi `INBOX_RE` Business Suite'i kabul eder; liste gömülü çerçevedeyse (`inboxFrame`, tiktok alan adı + message/chat/im yolu) çerçeve adresi sayfada
  doğrudan açılır ve hatırlanır (`bizInbox`). Tanı artık çerçeveler (alan adı+yol, öğe sayıları), hash'siz sınıf sözcükleri, rol sayıları, iframe/gölge DOM/
  düzenlenebilir alan sayısı da yazar. **Düzenden bağımsız yedek** (`tagLayout`, Kaan: "bireysel de kurumsal da otomatik çeksin"): bilinen
  seçiciler boşsa yapı görünüşten tanınıp `data-mv` ile işaretlenir (list = sol yarıda profil görselli, 1-8 kısa yazılı, aynı sınıflı kardeş
  satırlar; msg/sep = listenin sağındaki en büyük kaydırılan alanın satırları, yalnız tarih/saatten oluşan ortalı satır ayırıcı; input = sağ
  alttaki düzenlenebilir alan); tüm seçiciler `[data-mv=…]`'yı da kapsar, tanı satırında `auto` sayıları. data-e2e'siz sahte Business Suite
  sayfasında sohbet/mesaj/ben-o/zaman/gönderim sınandı; gerçek TikTok'ta DOĞRULANMADI.
- **Kaldır hızlı (29.09)**: `registry.remove` hesabı HEMEN gizler (`store.purgeAccount`: `removing` kümesi → listAccounts/getAccount/listChats/
  arama/WS olayları görmez; `purged` hesabın geri dirilmesini engeller) + `account.removed`, yanıt döner; platform çıkışı + durdurma + 2000'lik
  mesaj silme dilimleri + oturum klasörü arka planda (hesap kilidinde). Çekirdek yarıda kapanırsa `meta removing:<id>` → bootAll başlatmaz,
  `resumePurges` bitirir. Bağlan kartında çöp düğmesi ilk tıkta kırmızı "Emin misin? Kaldır", sonra "Kaldırılıyor…". Test: remove-reaction-text.test.ts.
- **Tepki metinleri Türkçe (29.09)**: `reaction-text.ts` `trReactionText` (çekirdek + arayüz kopyası `apps/web/src/reaction-text.ts`, aynı kalmalı):
  "Liked a message" → "👍 Bir mesajı beğendi", "Ayşe reacted ❤️ to your message", SMS/RCS 'Liked “…”'/'Laughed at "…"'/'Removed a like from “…”';
  yalnız metnin TAMAMI kalıpsa. Çekirdek yazarken (base upsertMessage/upsertChat önizlemesi/reactionPreview), arayüz eski kayıtları gösterirken
  (liste önizlemesi `trPreview`, balon `bubbleText`).
- **Yeniden bağlan (29.09)**: uyarı kartındaki ve sağ tık menüsündeki "Yeniden bağlan"/"PIN'i gir" (`App.reconnect`) Bağlan penceresini o hesabın
  alanında açar (`connectFocus`) + yeniden bağlanmayı başlatır; "Ayrıntı ve eşleşme" de o hesaba odaklanır. Panelde `attention` (PIN vb.) kırmızı satır.
- Bağlan penceresi: kapatma ✕ `.modal-x` kaydırılan alanın DIŞINDA (mutlak konum, aşağı inince de görünür). Telegram kartında Bağlan → doğrudan QR (ara form yok; kendi api_id'si yalnız QR altındaki "Gelişmiş" bağlantısıyla `telegram:new`).
- **Telegram** (teleproto — bakımı süren GramJS fork'u; GramJS Temmuz 2026'da arşivlendi): api_id/api_hash Bağlan formundan (token dosyası JSON); giriş QR ile (`tg://login?token`), 2FA parolası prompt.
- **iMessage**: `~/Library/Messages/chat.db` salt okunur + AppleScript gönderim; Tam Disk Erişimi yoksa Sistem Ayarları bölmesini açar.
- **E-posta** (`connectors/mail.ts`): imapflow + nodemailer + mailparser; thread = sohbet. Gmail: uygulama şifresi ya da
  Google OAuth (Desktop client id+secret, `/oauth/callback`); Outlook: Azure client id + cihaz kodu (pencere otomatik açılır/kapanır).
- **Gmail/iCloud Bağlan** (30.09 itibarıyla ESKİ: artık uygulamada şifre formu YOK, bkz. "Bağlan arayüzü 30.09"): eskiden önce uygulama şifresi formu, tarayıcı girişi yedek. **Gmail (tarayıcı)** (`connectors/browser/gmail.ts`): yedek yol; görünür pencerede Google girişi, sonra Gmail web DOM'u (tr.zA satırları,
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
- **Tarayıcı e-posta saatleri**: `parseMailDate` (outlook.ts; iki haneli yıl "28.04.25" de — Yandex listesi bunu kullanıyor, okunamayınca
  eski e-postalar eşitleme saatinde en üste çıkıyordu; Yandex 'ts-v2' ile bir kez yeniden eşitlenir; TR/EN/RU, Bugün/Dün/Сегодня/Вчера, ISO/RFC; okunamazsa undefined — ESKİDEN NaN →
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
- **Düzenle / herkesten sil** (yalnız kendi mesajım): `Connector.deleteMessage?/editMessage?` (base.ts), köprüde `Strategy.unsend?/edit?`
  (`react` gibi `urgent()+run`). `POST /api/messages/:id/delete` ve `/edit {text}` (fromMe değilse/destek yoksa 400; yalnız metin mesajı
  düzenlenir, bağlantı önizlemesi ('other') sayılmaz) → platform çağrısı + `store.applyEdit(id, text|null)` + message.upsert. DB `edited`/`deleted`
  sütunları; upsert düzenlenmiş metni düzenleme bilgisi taşımayan eşitlemeyle EZMEZ, silineni geri getirmez (silinen: `DELETED_TEXT`
  "🚫 Bu mesaj silindi", ekler []). WhatsApp `{delete:key}` / `{text, edit:key}` (anahtar fromMe, grupta katılımcı=ben; gelen düzenleme/REVOKE
  `applyEdit` → `applyEdited`), Telegram `deleteMessages(revoke)` / `editMessage` + gelen `EditedMessage`/`DeletedMessage` olayları (kanal
  dışında sohbet bilinmez → kimlikle `findMessageByRemote`; `editDate && !editHide` = düzenlendi), Slack xoxp `chat.delete/chat.update` +
  Socket Mode `message_changed`(edited)/`message_deleted`, tarayıcı Slack aynı yöntemler (xoxc), Instagram yalnız geri alma
  (`direct_v2/threads/<id>/items/<öğe>/delete/`; düzenleme ucu yok), demo. Arayüz: `EDIT_PLATFORMS`/`UNSEND_PLATFORMS` + süre sınırları
  `EDIT_LIMIT_MS` (WhatsApp 15 dk, Telegram 48 sa) / `UNSEND_LIMIT_MS` (WhatsApp 48 sa); kendi balonunda `…` düğmesi → `.own-menu`
  (Düzenle · Herkesten sil → "Emin misin? Sil" ikinci tık onayı), düzenleme yazma alanında `.edit-bar` (Enter kaydeder, Esc iptal, önceki taslak
  geri gelir, düğme "Kaydet"), saatte "düzenlendi", silinen balon soluk italik (`.bub.deleted`). Outbox kopyası gerçek kimlikle (`realId`) eşleşir
  (düzenlenince metin eşleşmesi bozulup kopya geri çıkıyordu). Gerçek hesaplarla DOĞRULANMADI (yalnız birim testi + statik demo). Test: edit-delete.test.ts.
- **Yahoo Mail**: varsayılan tarayıcı girişi (`connectors/browser/yahoo.ts`, mail.yahoo.com; `data-test-id` seçicileri + ARIA yedekleri,
  çerez onayı, oturum çerezleri kalıcı; DOĞRULANMADI → ilk girişte günlükle ayarlanacak). Yahoo birçok hesapta uygulama şifresini kapattı,
  IMAP normal şifreyi reddediyor. Token dosyası varsa IMAP (`MailConnector`). `registry.add('yahoo')` token'sız çağrılınca IMAP'i bozuk
  Yahoo hesabının token'ını silip tarayıcı yoluna geçirir (kopya yok). Uyarı `panelOnly` (aynı şifreyle yeniden denemez → kilit riski).
- **Sayaçlar** (App.tsx `baseList`): başlıktaki "N yeni" ve Okunmamış/Bekleyen sayıları listelenen kümeden (arşiv/iMessage klasörü/
  e-posta klasörü/pazaryeri sekmesi dahil); eskiden hep gelen kutusundan hesaplanıyordu.
- **Tepkiler mesaj gibi görünmez (29.09)**: karşı taraf bir mesaja tepki verince önizleme "❤️ Ayşe mesajına tepki verdi" (`base.reactionPreview`
  → `store.setReactionPreview`, sohbette `last_reaction` = 1: sıra/okunmamış/lastFromMe değişmez, listede tik yok, italik `.prev.rx`, "Bekleyen"e
  düşmez); sonraki gerçek mesaj ezer. Köprü (tüm tarayıcı kanalları): turda yeni gelen mesaj yokken var olan mesaja yeni tepki geldiyse ya da
  platform önizlemesi tepkiyi anlatıyorsa (`REACTION_PREVIEW_RE`) okunmamış tur başındaki değerine döner ve yeni etkinliğe dek platformun
  "okunmamış"ı yok sayılır (`reactionOnly`; IG read_state, LinkedIn read:false, Messenger kalın satır). Strateji bilirse `Thread.reactionPreview`.
  Instagram: `igReactionPreview` TÜM öğelerdeki tepkilere bakar (eskiden yalnız son mesaja → eski mesaj beğenilince sohbet "1 okunmamış" +
  son mesaj metniyle üste çıkıyordu), action_log "…beğendi" satırı; zaman birimi `anyMs`. iMessage tapback (2000-2007, 3000+ geri alma) hedef
  mesaja tepki (`tapbackOf`, associated_message_guid "p:0/…"/"bp:…", 2006 özel emoji); açılışta tapback'ler normal mesajlardan SONRA yazılır.
  Messenger satırındaki sayılı tepki rozeti ("1 tepki; …") çip; X yerel DB okunmamış yalnız `entry_type='message'`, en yeni kayıt tepkiyse
  önizleme. WhatsApp/Telegram canlı tepkide de aynı önizleme. Test: reaction-preview.test.ts.
- **Listede tik (29.09)**: `Chat.lastStatus` (store alt sorgusu) → son mesaj benimse satırda balondaki tik (`statusIcon`; e-posta/pazaryeri ve
  tepki önizlemesinde yok); alındı gelince connector sohbeti de yayınlar (`outgoingRead`, Telegram `emitRead`; arayüz `messages.read`'de yerelde).
- **Ayarlar → Profil + Tüm verileri sil (29.09, Kaan)**: Profil sekmesi (fotoğraf 256 px kare JPEG'e kırpılır, ad soyad, kullanıcı adı, e-posta, telefon)
  → çekirdek `profile.ts` `~/.mivelo/profile.json` 0600 (`GET/POST /api/profile`, doğrulama `validateProfile`; demoda localStorage `mivelo.profile`);
  ad lisans/OS adının önüne geçer (`applyProfile`, 'mivelo-profile' olayı), foto kenar çubuğu + Odak avatarında. Lisans e-postası değişmez.
  "Hesap ve veriler" → "Tüm verileri sil" (onay kartı) → `POST /api/reset {confirm:'SIL'}`: `registry.removeAll` (her kanalda platform çıkışı:
  WhatsApp bağlı cihazlar, Telegram oturumu; bitene dek bekler) + `store.wipeAll` (+FTS rebuild, VACUUM) + zamanlanmış/gönderim sayaçları/AI anahtarı/
  settings/profile/sessions/outbox/calendar silinir; lisans, db anahtarı, token, günlükler kalır. Arayüz localStorage kullanıcı kayıtlarını siler
  (kurulum izinleri + tema kalır) ve yeniden yüklenir. Uygulamayı çöpe atmak ~/.mivelo'yu SİLMEZ (macOS normali). Test: profile-reset.test.ts.
- **Eşitleme yüzdesi tek kaynak (29.09)**: `ui.tsx syncPercent(sync[id])` = yalnız çekirdeğin `account.sync` ilerlemesi (geri gitmez). WhatsApp telefonun aşama yüzdelerini (her aşamada sıfırdan başlıyordu → satır ile üst çubuk ayrışıyordu) tek ölçeğe çevirir: sohbetler %60-85, eski mesajlar %85-99, bitince 100; ilk eşitleme bitince (`base.synced`) çubuk yeniden açılmaz, aşama yüzdesi yalnız o zaman durum metninde; üst "N kanal eşitleniyor", kanal satırı ve Bağlan kartı aynısını kullanır; üst çubuk turdaki TÜM kanalların ortalaması (biten 100 sayılır, geri gitmez; `overallSync`) (eskiden üst çubuk yalnız genel ilerlemeyi, satır WhatsApp'ın yüzdesini gösteriyordu).
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
- **Zamanlanmış gönderim çekirdekte** (`scheduled.ts`, `~/.mivelo/scheduled.json`, 15 sn'de bir; `/api/scheduled` GET/POST/DELETE;
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
  Instagram/Messenger 600, iMessage 1500, WhatsApp/Telegram 2500, Slack 5000. Gün yerel gece yarısında döner; sayaçlar `~/.mivelo/send-guard.json`'da kalıcı. E-posta/pazaryeri muaf.
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
- Slack: Bağlan → VARSAYILAN kullanıcı adı + şifreyle tarayıcı girişi (Kaan isteğiyle, eskisi gibi); belirteç formu (`slack:new`, `add('slack',{token:true})`)
  yalnız "Gelişmiş: Slack uygulama belirteciyle bağlan" bağlantısından. Eski not — Bağlan formu önce resmi yol — manifest bağlantısı (`SLACK_MANIFEST`, Connect.tsx'teki kopyayla aynı; test denetler) ile kendi
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
  Amazon v2026 200 sn / v0 yedeği 120 sn. Belgeli sınırlar çok üstte (Trendyol soru/sipariş 1000/dk, HB OMS ~240/dk); webhook'lar genel HTTPS ister.
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
- Amazon Seller Central / Etsy Mesajları / Shopify Inbox tarayıcı köprüleri KALDIRILDI (30.09; Amazon BSA §19/Agent Policy tarayıcı otomasyonunu yasaklıyor; yalnız resmi API).
- Yeniden bağlan hızı: hesap 'pairing' iken (oturum düştüğü biliniyor) `restartNow` → `start({login:true})` görünmez denetim turu
  OLMADAN giriş penceresi (eski çerez "giriş var" sanılmasın diye visibleLogin(false)); diğer durumlarda denetim en çok 12 sn. Eşitleme
  yüzdesi oturum doğrulanmadan başlamaz (eskiden %20 "tarayıcı açıldı" pencereden önce çıkıyordu). Arayüz: `login-opening.ts` —
  "… giriş penceresi açılıyor" hapı hesap 'connecting'ten çıkana dek (pairing = pencere açıldı) üstte kalır (≤90 sn).
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
- **İzin uyarısı** (`PermissionBanner.tsx`, 29.09, Kaan: Claude'un "Notifications are turned off" kartı gibi): yalnız Tauri + kurulumdan sonra, sağ üstte
  tek kart `.perm-card` (üstü çizili zil `belloff` / kilit / mikrofon / gönder simgesi, metin, "Sistem Ayarları’nı aç", ✕). Öncelik bildirim (plugin
  `isPermissionGranted` false) → Tam Disk Erişimi (iMessage hesabı varsa, `/api/permissions` fullDisk false) → mikrofon (permissions.query denied) →
  Mesajlar otomasyonu (kurulumda denied). Düğme: bildirimde önce `requestPermission`, olmazsa `openPermissionPane` (Windows ms-settings:). ✕ o izni
  3 gün gizler (`mivelo.permDismiss`); 4 sn sonra, odakta ve 30 sn'de bir yeniden denetlenir (izin verilince kaybolur).
- Kenar çubuğu menüsü (`.nav-item`) 31 px + 1 px aralık (eski 36+2; Kaan: Claude'daki gibi daha sık).
- Parola alanları `PasswordInput` (ui.tsx): sağdaki göze BASILI TUTUNCA görünür, bırakınca gizlenir (Bağlan formları, 2FA istemi, AI anahtarı, giriş).
- **Mivelo içi giriş** (VARSAYILAN DEĞİL — Kaan isteğiyle kapatıldı, düğmeler tepki vermiyordu; yalnız `MIVELO_LOGIN_EMBED=1` ile; varsayılan ayrı `--app` penceresi; `bridge.launchLogin`): giriş sayfası GÖRÜNMEZ tarayıcıda açılır (görünürlük taklidi yok, 820×700, DPR 2),
  CDP `Page.startScreencast` kareleri `login.frame` olayıyla (JPEG base64) arayüze; `apps/web/src/LoginView.tsx` üst katmanda gösterir
  (kareler App durumundan geçmez: `pushLoginEvent` yayıncısı). Girdi `POST /api/accounts/:id/login-input {events}` (move/down/up/wheel/text/key;
  arayüz sıralı toplu gönderir, köprü `inputQ` ile sırayla uygular; klavye gizli textarea `.login-keys` — üst öğelerin `user-select:none`'ı yazmayı
  engelliyordu, `user-select:text` şart), `login-cancel` (bekleyen girişi bırakır, 'pairing'), `login-window` (restart `{external:true}` → eski
  ayrı pencere). OAuth açılır penceresine geçilince yayın yeni sayfaya taşınır (`startEmbed`). 
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
  tıklama en dıştaki eşleşme sırasıyla (`idx`). Dizi (sayılı "8 ▾") satırları bağlantı değil div → ROW_SEL'e `.mail-MessageSnippet` eklendi (eskiden bugünkü ve
  dizi e-postaları hiç yoktu); ileti görünümü okunamazsa satır özeti tek ileti; `openMail` #message/#thread görünümünde kalmışsa #inbox'a döner;
  avatar satırdaki img ya da avatar/logo kutusunun arka plan görseli (`Thread.avatarUrl`). Tanı günlüğü `threadish`/`avatarish`/`hash` da yazar. Giriş: oturum yokken mail.yandex ana sayfaya atıyor → passive loggedIn passport'a gider (`LOGIN_URL`). Token dosyalı eski IMAP hesapları sürer;
  şifre reddinde "Yandex ile giriş yap" (Yahoo gibi, IMAP hesabı tarayıcı yoluna çevrilir).
- **WhatsApp tek seferlik (bir kez görüntülenen) medya (29.09, Kaan: "geçmişte gönderilen tek seferlikler normal foto gibi görünüyor, ciddi")**:
  canlıda içerik bağlı cihazlara GELMEZ (içeriksiz → `VIEW_ONCE_TEXT` yer tutucu), ama geçmiş eşitlemesi sarmallı (viewOnceMessage/V2/V2Extension)
  ya da sarmalsız `imageMessage.viewOnce` bayraklı İÇERİKLE veriyor → `unwrap` sarmalı soyup normal fotoğraf yazıyor, medya indirilip gösteriliyordu.
  Şimdi `isViewOnce` (iç içe sarmallar + image/video/audio/ptv `viewOnce`) → `viewOncePlaceholder`: aynı uyarı metni, ek YOK (`attachments: []` —
  depo ekleri COALESCE ile korur, undefined eski fotoğrafı bırakırdı), medya kaydı tutulmaz (`forgetMedia`: media-index + indirilmiş dosya silinir);
  depoda normal foto olarak duran aynı kimlik yerinde çevrilir (`rewriteViewOnce`, açık sohbete message.upsert). Açılışta hesap başına BİR KEZ
  (`wa_viewonce_v1:<hesap>` bayrağı) `repairViewOnce`: media-index'teki ham mesajlar dilimli taranır (`"viewOnce` ön elemesi), eski kayıtlar çevrilir.
  `fetchMedia` tek seferlik medyayı (tam ve küçük önizleme) REDDEDER; alıntıda "🔒 Tek seferlik medya". Test: whatsapp-viewonce.test.ts.
- WhatsApp tek seferlik medya ikizi: telefon aynı gönderimi iki kimlikle yollayabiliyor (biri tek, biri çift tik iki yer tutucu) → `upsertPlaceholder`
  aynı sohbet+gönderen ±10 sn ikizi varsa yeni kayıt açmaz, kimliği `twins` ile bağlar (alındılar tek balona); açılışta `store.dropTwins` eskileri birleştirir.
- **Kaydırarak yanıt animasyonu** (Conversation.tsx `swipeProps`): ham dx → rAF ile yumuşatılan `--sw` (CSS `@property`, sayı), 60 px sonrası lastik direnci,
  56 px'te hazır (ok mor + pop, `navigator.vibrate`), bırakınca `.swipe-back` yaylı geçiş; ok yarı hızda gelip belirir/büyür; `.reply-bar` kayarak açılır.
  Trackpad: hareket başlayınca tekerlek olayları PENCEREDEN dinlenir (`wheelFeed`; balon imlecin altından kayınca olaylar kesilip hareket sıfırlanıyordu),
  180 ms sessizlik = bırakıldı, tetikten sonra 450 ms atalet yok sayılır. `prefers-reduced-motion` uyar.

- **Masaüstü "Çekirdek başlatılıyor"da takılma (29.09, Kaan: M1, 0.1.9, ilk açılış, dakikalarca %27)**: (1) arayüz Tauri belirtecini
  (`core_token`) yalnız 15 sn bekleyip BOŞ belirteci kalıcı önbelleğe alıyordu → çekirdek geç kalkınca her istek 403 "Yetkisiz kaynak";
  şimdi `coreToken()` işlevi + `refreshCoreToken()` (api.ts 403'te bir kez yeniden okur, WS her açılışta tazeler). (2) açılış döngüsü her
  denemede ≤12 sn (asılı istek dondurmasın), toplam 120 sn, 20 sn sonra "ilk açılışta 1-2 dk sürebilir". (3) bekçi `STARTUP_GRACE` 60 → 150 sn
  (ilk açılışta macOS gömülü node/yerel modülleri tararken — Intel paketi M1'de Rosetta ile daha da yavaş — dinlemeye başlamadan öldürüp
  yeniden başlatıyordu). (4) Anahtar Zinciri `security` çağrılarına zaman aşımı (dbkey 30/15 sn, secrets 8 sn); okunamayan anahtarda henüz
  şifreli DB yoksa 0600 dosya anahtarıyla devam (ilk açılış takılmaz). Gerçek Mac'te doğrulanmadı; sürerse `~/.mivelo/desktop.log` + `core.log` sonu.
  (5) Kalıcı kilit bekçisi `stall-watch.ts` (29.09, Kaan'ın core.log'unda "kilitlendi" hiç yoktu ama "Açılış sırası" 10+ kez = bekçi çekirdeği
  yeniden başlatıyor; index.ts gecikme ölçeri ana döngüde olduğu için döngü hiç dönmezse yazamıyordu): ayrı Worker, ortak sayaç 250 ms; 5/20/60 sn
  artmazsa `inspector.Session.connectToMainThread` + Debugger.pause → o an çalışan JS yığını (işlev dosya:satır, içerik yok) + son günlük satırı
  DOĞRUDAN stderr'e (core.log) "Olay döngüsü N sn'dir yanıt vermiyor — yığın: …"; yerel kodda (SQLite/execSync) "yerel kodda bekliyor", yığın dönünce;
  çözülünce "yeniden yanıt veriyor (N sn kilitliydi)". Kapatmak `MIVELO_STALL_WATCH=0`. Kaan'dan: `grep -E "yanıt vermiyor|kilitliydi" ~/.mivelo/core.log`.
  (6) Arayüz açılışı (29.09, Kaan: %27'de uzun süre, sonra hesaplar çok yavaş geliyor): eskiden `refresh()` (accounts+chats+health) 12 sn yarışla
  döngüdeydi → yavaşta vazgeçip YENİSİNİ gönderiyor, eskiler çekirdekte çalışmaya devam edip yığılıyordu; WS açılışı da ayrıca refresh çağırıyordu.
  Şimdi önce yalnız `/api/health` (deneme ≤8 sn, toplam 150 sn), sonra `refresh` TEK istekle zaman aşımsız (ağ hatasında ≤4); `refresh` tek uçuş
  (`refreshing` ref: açılış + WS aynı sözü paylaşır). `booting` 'core' | 'data' ("Sohbetler yükleniyor…", 1,5 sn'den uzunsa).
  Ölçüm (Linux, 5222 sohbet/280 bin mesaj): listChats 0,25 sn + JSON 1,3 MB 26 ms; dropTwins 136 ms — sohbet listesi darboğaz değil.

- **Kapsamlı performans/eşitleme denetimi (29.09, çok ajanlı)**: 12 alan × bulucu + her bulguya çekişmeli doğrulayıcı → 95 bulgu, 94 doğrulandı
  (29 yüksek); 12 dosya-sahipliği grubunda düzeltildi + bağımsız inceleme; 2. tur gruplar arası işler. Testler 213 → 317. Öne çıkanlar:
  lisans geçerli olunca `whenLicensed` uyanır (eskiden 14 gün çevrimdışı sonrası kanallar hiç başlamıyordu); cihaz kimliği donanım
  (IOPlatformUUID/MachineGuid/machine-id, license.json `hw`; MAC'e bağlı değil); `media-prune.ts` media-index'i ve e-posta eklerini SİLMEZ, günde bir,
  dinlemeden 5 dk sonra, eşzamansız; macOS `browserSlots` totalmem·0,35 (freemem hep ~0 → 1 yuva); bootAll sıradakileri 'connecting'
  ("Açılış sırası bekleniyor"); heal sayacı ≈2 dk kararlı bağlantıdan sonra sıfırlanır, sağlayıcı `retryAfterMs` (IMAP 15 dk) uyulur;
  store: findMessageByRemote/dropLocalDuplicates/dropTwins indeksli (O(n²) yok), FTS tetikleyicisi yalnız metin değişince, arama/AI sorguları
  indeksli; isOwnEcho yalnız kendi mesajımı eler (gruplarda başkasının aynı metinli mesajı silinmiyordu); WS demetinde messages.read sırası,
  yeniden bağlanınca tam eşitleme, kaldırılan hesap hayaleti; /read presenceSubscribe kısıtı; send-file akışla diske; `/api/shutdown`
  (belirteçli) + health `appVersion/execPath` → kabuk nazik kapatır (Windows dahil), bekçi HTTP sağlık denetler, 7788'deki yabancı süreci
  benimsemez; WhatsApp pompası süre bütçeli (25 ms), read-self yalnız okunan noktaya kadar, refreshNames/mediaPending/grup metadata ucuz,
  fetchMedia önbelleği index'ten önce; iMessage poll tek işlemde, Son Silinenler yalnız değişince, syncUnread Mivelo okuma noktasına uyar,
  zaman aşımında çift gönderim yok, düzenleme/geri alma canlı; Telegram pts kalıcı + açılışta boşluk telafisi, süpergrup kimlik çakışması,
  grup yankısı; köprü: `known`/tepki durumu kalıcı, doğrulamasız 'connected' yok, boşluk algılama + geriye sayfalama (before ≤5 sayfa,
  live=false), stop/launch yarışı, değişmeyen sohbet yeniden yazılmaz; IG/Messenger/TikTok/Slack/X strateji kayıpları; IMAP biriken
  e-postalar 100'lük parçalarla + ilerleme kaydı, \Seen iki yönlü, [LIMIT]/BYE sınıflama; Slack xoxp imleç kalıcı + has_more; Trendyol/ePttAVM
  telafi penceresi (son başarılı turdan beri), durum dosyası yalnız değişince; arayüz: balonlar memo, Intl biçimleyici önbelleği, markRead kısıtı,
  refresh WS'den gelen tazeyi ezmez, "daha eski" aynı saniyedeki mesajı atlamaz, msgCache sınırlı.
  Test dosyaları `test/<grup>-*.test.ts`. Denetim çıktısı yalnız oturumda (depoda yok).

## 30.09 turu (Kaan'ın 11 maddesi + TikTok)
- **Bağlan arayüzü (30.09)**: "deneysel" etiketleri ve TÜM "Gelişmiş" bağlantıları kaldırıldı; uygulama içinde kullanıcı adı/şifre formu YOK
  (e-posta uygulama şifresi/IMAP/OAuth istemci formları, Slack belirteç formu + manifest kopyası, Telegram api_id formu silindi). E-posta
  (Gmail/Outlook/Yahoo/Yandex/iCloud) Bağlan → doğrudan sağlayıcının giriş penceresi; "Diğer e-posta" yeni eklenemez (yalnız eski hesap
  kaldırılır). Şifreyle bağlanmış eski e-posta hesapları `restart(id, {browserLogin:true})` (registry/server/api) ile token'ı bırakıp giriş
  penceresine geçer ("Giriş ekranını aç" / uyarıdaki "<Sağlayıcı> ile giriş yap"). Kalan tek formlar: pazaryeri API anahtarları ("API anahtarı",
  "şifre" değil) + Telegram 2FA parolası (QR sonrası Telegram istiyor). Orijinal logolar: `apps/web/src/brand-icons.ts` (landing dock SVG'leri,
  19 platform; Trendyol/n11/Shopier PNG) → `Chip` her yerde. Ayarlar → Hesap ve veriler'deki Çıkış yap satırı kaldırıldı (menüdeki kalır).
- **Medya (30.09)**: video tam ekran düğmesi requestFullscreen → webkitRequestFullscreen → video.webkitEnterFullscreen → olmazsa uygulama içi
  Lightbox (`.lightbox.full`, Esc önce tam ekrandan çıkar); simgeler `maximize`/`minimize`. Bağlantı/medya/ek/paylaşım kartı/MsgLink/e-posta
  gövdesi bağlantıları YENİ SEKME AÇMAZ: uygulama içi pencere (görsel/video/ses/PDF doğrudan; IG/X/YouTube/TikTok/Vimeo gömülü oynatıcı;
  gömülemeyen sayfa `/api/preview` kartı); dışarı yalnız "Tarayıcıda aç"/"İndir".
- **Resmi API denetimi (30.09)**: Amazon KALDI (SP-API sipariş + şablonlu mesaj; alıcı mesajı okuma API'si YOK, Seller Central köprüsü silindi),
  siparişler Orders API v2026-01-01 (searchOrders, kalemler yanıtta; 404/403'te tek uyarıyla v0), şablon adları `_embedded/_links`, digitalAccessKey ≤400.
  Trendyol soru sayfa boyu 50 (doc üst sınırı). Hepsiburada Basic `merchantId:servisAnahtarı` + User-Agent entegratör adı (eski username/password
  sürer). Etsy `x-api-key: keystring:shared_secret` zorunlu (9.02.2026). Shopify API 2026-07 + Dev Dashboard client_credentials (24 sa belirteç,
  401'de yenileme; eski shpat_ sürer). Outlook.com kişisel SMTP smtp-mail.outlook.com:587. Etsy/Shopify tarayıcı köprüleri silindi.
  Resmi kişisel DM API'si olmayanlar: WhatsApp, Instagram, Messenger, X, LinkedIn, TikTok (ban riski; LinkedIn en yüksek). Slack: tek ortak
  "Mivelo" Slack uygulaması DAĞITILMAMALI (pazaryeri dışı uygulamalarda history 1/dk).
- **Slack (30.09, Kaan: kişiler geliyor, önizleme/mesaj yok)**: kesin tek neden bulunamadı; 5 düzeltme: kalıcı `sameOriginOnly` → 10 dk
  `sameOriginUntil` + iki adres sırayla (not_authed/invalid_auth/non_json'da ötekisi); xoxc `teams:{}` iken `prevTeams` ve istemcinin kendi
  isteklerinden (`learnFromRequest`); replies hız sınırı geçmişi atmaz (Retry-After bekler, 25 sn bütçe); önizleme `threads()` son üst düzey
  mesajdan; yalnız blocks/attachments'lı mesaj metni `blocksText`. xoxp: sohbet başına ayrı hata. Hatalar kodla günlükte (içerik yok).
  Kaan'dan: `grep -E "slack( mesajlar alınamadı| yoklama|: (tanı|conversations\.|users\.info|oturum anahtarı|çalışma alanı|hız sınırı|sayfasız))" ~/.mivelo/web.log ~/.mivelo/core.log | tail -60`.
- **TikTok (30.09)**: gerçek 2026 web DM düzeni (8+ açık kaynak kazıyıcıdan) `dm-new-*` data-e2e ailesi: liste `dm-new-conversation-item`
  (data-conv-id, aria-selected), ad `dm-new-conversation-nickname`, mesaj alanı `dm-new-chatbox`/`dm-new-message-list`, mesaj `dm-new-chat-item`,
  metin `dm-new-message-text`, ayırıcı `dm-new-time-separator`, yazma `dm-new-input-editor` (Draft.js), gönder `dm-new-send-btn`; sınıflar
  `css-<hash>-<build>--Label` (yalnız etiket kararlı, hash durumla değişir). tagLayout yedeği: satırlar hash'e göre bölünmez, sol menü/"Mesaj
  istekleri"/açık grubun üye mesajları sohbet sayılmaz; gerçek fare tıklaması; aynı adlı sohbette yanlış kişiye GÖNDERMEZ (seçili satır
  doğrulanamazsa hata); column-reverse, sanal liste, grup gönderen adı, emoji-only, ayırıcı tarihleri (`sepTime`, ABD/TR). Test: tiktok-dom.test.ts
  (Chromium yoksa atlanır; "Bugün" saatleri şimdiden geride `hm()`, gece yarısından sonraki 30 dk'da iki test atlanır). Gerçek TikTok'ta DOĞRULANMADI.
- **Rakip: HeloRobo (30.09 araştırma)**: B2B (T-Soft), resmi WhatsApp Cloud API (Embedded Signup, coexistence), IG/Messenger resmi (yalnız
  profesyonel), Telegram kullanıcı girişi, IMAP, Trendyol/HB/n11/Pazarama, Shopify/T-Soft, Thinker bot, HeloBot AI, çok operatör, mobil (500+),
  $29-99/ay + Meta ücretleri. Öneri: kısa vadede resmi WA yok (webhook relay sunucusu gerekir); Pazarama + hazır yanıtlar + mini CRM eklenebilir.
- **X giriş kısıtlaması (30.09)**: köprü `ignoreDefaultArgs: ['--enable-automation']`; sürerse giriş penceresini sistem Chrome'uyla açmak gerekebilir.

## 30.09 yeni özellikler (Kaan: 1-3-4-5-6-8-10-11)
- **Kişi birleştirme (30.09)** `people.ts`: kişi = ≥2 BİREBİR sohbet (tablolar `people`, `person_chats` CASCADE, `people_dismissed` sohbet çifti). Gruplar/kanallar/pazaryeri bağlanmaz;
  <2 sohbet kalan kişi `prunePeople` (deleteAccount, mergeChats bağı taşır, wipeAll). Öneri motoru OTOMATİK birleştirmez: güçlü = aynı telefon (E.164, TR varsayılan)/e-posta;
  orta = ad anahtarı (Türkçe/emoji/unvan farkı yok, ≥2 kelime, farklı platform)/aynı @kullanıcı adı; kova içi çiftler, bileşen ≤8; güçlü alt grup önce. İstisna: kişiye bağlı
  adrese yeni e-posta dizisi kendiliğinden eklenir. Hesap: açılıştan 90 sn sonra, account.sync 100'den 30 sn sonra, günde bir; `people.update`. Uçlar `/api/people*`.
  Arayüz `PersonPanel.tsx` (sağ panel Kişi, Bağla…, Birleştirme önerileri), `UnifiedTimeline.tsx` ("Tüm kanallar", gönderim kanalı seçimi, `.tl-mark`), `people-store.ts`.
  Demo `demo-people.ts` + `people-match.ts` (çekirdek kurallarının kopyası, AYNI kalmalı), localStorage `mivelo.demoPeople`. Telegram birebir handle @kullanıcı adı/+telefon (`meta.phone`).
  Test people-*.test.ts. Gerçek hesaplarla doğrulanmadı.
- **Hızlı gönder (⌘⇧K / Ctrl+Shift+K, `QuickSend.tsx`, 30.09)**: Kime (ad/@kullanıcı/e-posta/numara, Türkçe duyarsız, son yazışılanlar önce) → Enter gönder, ⌘Enter gönder+aç, Esc.
  İyimser: sağ üst hap, hatada (send-guard dahil) "Yeniden dene"/"Düzenle". Masaüstü: kabuk `quick_send` pencere önde değilse öne alır + `quick-send` "open"; öndeyse "toggle" →
  arayüz paleti kapatıp `hide_window`; tepsi menüsünde "Hızlı gönder…"; ⌘K artık Shift'le tetiklenmez.
- **Bildirimden hızlı yanıt**: sağ üst `QuickReplyStack` kartları satır içi yanıtlı (8 sn, üzerine gelince/yazarken durur); arka planda gelen `rememberBackground` → odakta karta
  döner; web bildirimi tıklanınca aynı kart (`notify(…, {onClick, tag})`). Tauri notification 2.4 masaüstünde tıklama/eylem VERMEZ → gerçek macOS satır içi yanıt YOK.
- **Pazaryeri gün sonu özeti**: saf `market-calc.ts` (web kopyası AYNI kalmalı, test denetler); `GET /api/market/summary?day&platform`, `GET/POST /api/market/digest`
  (`~/.mivelo/market-digest.json`, vars. açık 21:00); dakikalık `checkDigest` → `market.digest` bir kez, yalnız pazaryeri hesabı varsa. Ciro iptal/iade hariç, para birimine göre;
  iptal/iade durum değişim gününde. Arayüz: pazaryeri listesi üstünde katlanabilir "Bugün" (`MarketSummary.tsx`), panel ←/→/T, 7 gün çubuk. Demo `demo-market.ts`.
- **Soru yanıtına AI taslağı** (`POST /api/chats/:id/question-draft`, `question-draft.ts`): ürün + fiyat + aynı ürüne önceki cevaplar (`store.productAnswers`) + üslup +
  `MARKET_RULES`; çıktı süzülür (telefon/e-posta/URL/@hesap silinir); yalnız yazma alanına konur. `QuestionDraft.tsx`: Taslaklar kapalıysa gizli, anahtarsız → Ayarlar → AI.
  Gerçek pazaryeri verisi/gerçek Mac kısayoluyla doğrulanmadı.
- **Raporum / Wrapped (30.09)** `stats.ts` `GET /api/stats?range=month|year|all&at=`: yalnız yerel DB, mesajlar zaman sırasıyla 0,5–8 binlik dilimler + olay döngüsüne dönüş
  (300 bin şifreli mesajda tüm zamanlar 0,57 sn, en uzun bekleme 27 ms). Pazaryeri sayılmaz. Yanıt süresi yalnız birebirde (karşıdan ilk yanıtlanmamış mesajdan, >12 sa sayılmaz);
  kişiler yalnız iki yönlü birebirler; seri kendi mesajlı günler; emoji yalnız kendi mesajlarında. Önbellek meta `wrapped:v1:<dönem>` (süren 10 dk, geçmiş 6 sa, tümü 30 dk).
  `Wrapped.tsx` (dönem seçici, ızgara, tam ekran hikâye, basılı tut = duraklat), `wrapped-card.ts` canvas PNG 1080×1920/1080×1080, içerik YOK, "İsimleri gizle" vars. açık.
  Demo `demo-insights.ts`; fresh üyede "Rapor için yeterli mesaj yok".
- **Medya kütüphanesi** `library.ts` (`/api/library`, `/api/library/facets`): `library_items` (tür/platform/sohbet/zaman dizinli, "ts:rowid" imleç); saf SQL tetikleyiciler
  → `library_dirty` kuyruğu (JS işlevi YOK: seed.mjs gibi araçlar bozulmaz), 3 sn'de bir bütçeli dizinleyici, eskiler bir kez rowid aralıklarıyla (meta `library_fill`).
  E-posta abonelik/izleme bağlantıları elenir, mesaj başına ≤8 bağlantı. `MediaLibrary.tsx` Lightbox + "Sohbette göster"/"İndir"; önizleme yalnız görünenler, ≤2 eşzamanlı.
- **Dosya kaydetme (masaüstü)** `POST /api/downloads` (`downloads.ts`, yalnız yerel, gövde ≤80 MB) → İndirilenler + Finder/Gezgin'de göster; arayüz `save-file.ts saveBlob`.
  `store.sql()` (Ajan C) B'nin modüllerince kullanılıyor.
- **Yerel AI (30.09, `packages/core/src/ml/`)**: sesli mesajı yazıya dökme (`Xenova/whisper-small` q8 ≈250 MB), anlamsal arama (`Xenova/multilingual-e5-small` q8, 384 boyut,
  int8 vektör `embeddings`, bellek içi kaba kuvvet + FTS ile RRF hibrit, tarih/kişi ipuçları `query.ts`), çeviri (anahtar varsa Claude, yoksa NLLB-600M q8 ≈900 MB; dil algılama
  modelsiz `lang.ts`, arayüz kopyası `lang-detect.ts` AYNI kalmalı). Modeller yalnız Ayarlar → Yerel AI modelleri'nde onayla `~/.mivelo/models`e iner; ayarlar `~/.mivelo/ml.json`.
  Çalışma zamanı pakette YOK: ilk indirmede npm'den sabit sürüm + sha512 (transformers 4.3.0 Node yapısı + onnxruntime-web wasm) → `~/.mivelo/ml/runtime/<sürüm>`;
  `Symbol.for('onnxruntime')` + `device:'auto'`; sharp/onnxruntime-node yerine boş taslak. onnxruntime-node KULLANILMAZ (darwin-x64 ikilisi yok, 113 MB). Çıkarım worker_thread'de
  (`engine.ts`, tek kuyruk, kullanıcı işi önce, 3 dk boşta işçi kapanır). Ses: Ogg/Opus `opus-decoder` (bağımlılık), WAV; diğerleri macOS afconvert, yoksa ffmpeg.
  Tablolar `transcripts` (+ `transcripts_fts`), `embeddings`, `translations` → `messages(id)` CASCADE; `store.search` sesli mesaj metnini de döndürür. Uçlar `/api/ml/*`; olaylar
  `ml.status`, `transcript.update`. Arayüz `MlBubble.tsx` (balon altı metin/çeviri, "Çevir", "Çevir ve gönder", sağ panel "Otomatik çevir" `mivelo.autoTranslate`), ⌘K "Anlamsal"
  (`mivelo.searchSemantic`), `LocalAiPane.tsx`. Demo `demo-ml.ts`. Gerçek modellerle ve gerçek Mac/Windows'ta DOĞRULANMADI (bu ortamda Hugging Face 403); ilk kullanımda
  `Sesli mesaj yazıya döküldü: N sn ses…` günlüğüne bakılmalı.
- **Google çeviri (30.09, Kaan: "yerel çeviri yerine ücretsiz resmi translate")** `ml/google-translate.ts`: resmi Google Cloud Translation v2 (Basic),
  kullanıcının KENDİ `AIza…` anahtarı (ayda 500 bin karakter ücretsiz, Google faturalandırma hesabı şart) → gizli depo `google-translate` (secrets.ts), arayüze yalnız maske;
  `POST /api/ml/google-key` yalnız yerelden. Motor önceliği: Google anahtarı → Claude → yerel NLLB ("Yalnız yerel çeviri" hepsini ezer). Ayarlar → Yerel AI modelleri →
  "Google çeviri" satırı (`GoogleKeyRow`). Anahtarsız resmi olmayan translate.googleapis.com "gtx" KULLANILMAZ (ToS). Test: ml-google-translate.test.ts. Gerçek anahtarla denenmedi.
- **Dokümantasyon** `docs/dokumantasyon.html` → `docs/Mivelo-Dokumantasyon.pdf` (`CHROMIUM=<chrome yolu> node docs/build-pdf.mjs`); özellik eklenince güncelle.

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
- Yol haritası: Node'suz tek dosya paketleme (sidecar), Shopier panel mesajları, Pazarama, hazır yanıtlar, mini CRM, yerel AI (Ollama),
  ilişki hatırlatıcısı, akıllı öncelik, abonelik temizliği, mobil uygulama. (Kişi birleştirme, ⌘K, SQLCipher, pazaryeri connector'ları TAMAM.)

## Performans notları (Eylül 2026'da öğrenildi)
- **Eşitleme hızı (29.09, Kaan: WhatsApp 25 dk'da bitmiyor, mesajlar geç geliyor, "sürekli kendini eşitliyor")** kök nedenleri ve çözümler:
  - WS: her `message.upsert` sohbetin TAMAMINI taşıyordu (300 üyeli grupta 20 bin mesaj ≈ 877 MB) → tampon 8 MB'ı aşıp arayüz bağlantısı
    düşüyor, arayüz yeniden bağlanıp tüm listeyi çekiyordu. Şimdi `ws-batch.ts` `EventBatcher`: ≈40 ms demet `{type:'batch', chats, deletes,
    events, refetch}`; sohbet demette bir kez (tam hali yayın anında `store.getChat`), mesaj olayı sohbetsiz, hesap durumu/ilerleme/yazıyor
    birleşik, demet başına ≤150 geçmiş mesajı (fazlası `refetch` → açık sohbet depodan yeniden okunur); `login.frame` demetsiz. Arayüz
    `api.ts unpackBatch` eski tek tek olaylara açar (message.upsert'e sohbeti ekler). Aynı ölçüde 1,8 MB. Kopma eşiği 32 MB.
  - Depo: hazır sorgu önbelleği (`Store.stmt`), `hasChat`, `getChatLite` (katılımcı sütunsuz; o sütunu okumak ~45 µs), mesaj yazımında
    yalnız özet sütunları, `rowToChat` katılımcıları okununca çözer (getter; JSON/yayılımda tam), `lastStatus` (son mesaj durumu, alt sorgu).
  - WhatsApp: geçmiş paketi sohbetleri hemen, MESAJLARI arka plan kuyruğunda (`queueHistory/pumpHistory`, ≈25 ms'lik tek işlemli dilimler,
    `setImmediate`) — eskiden büyük paket olay döngüsünü kilitleyip canlı mesajları ve Baileys keep-alive'ını bekletiyordu (→ kopma →
    yeniden eşitleme görüntüsü). loadHistory bekleyicileri paket yazılınca çözülür. `wa-auth` fsync YALNIZ creds.json (Baileys geçmişte binlerce
    tctoken/lid-mapping anahtarı yazıyor, mesaj kilidi altında). Medya dizini (`media-index`) eşzamansız toplu yazım (`mediaPending`).
    `pickVersion`: kayıtlı sürüm 3 günden yeniyse ağ beklenmez (eskiden her yeniden bağlanmada 8-16 sn), günceli arka planda; 405'te sıfırlanır.
    Ek uygulama durumu tam eşitlemesi ilk eşleşmede geçmiş akışı 20 sn durunca ve yalnız rehber adı gelmediyse. Hesap satırında
    "sohbetler / eski mesajlar arka planda alınıyor %N — telefonda WhatsApp açık kalsın", duraksamada uyarı. loadHistory `{timedOut|unavailable}`
    → arayüz "daha eski mesaj yok" DEMEZ, yeniden denenebilir. `oldestRealMessage` tek sorgu.
  - `base.everSynced`: bir kez eşitlenen connector'ın kopma/yeniden bağlanmasında eşitleme çubuğu yeniden gösterilmez.
  - Tarayıcı köprüsü: değişen sohbetler okunmamış → en yeni sırasıyla; mesajı alınmamış önemli sohbet kaldıkça (son 30 gün/okunmamış)
    sonraki tur `backfillMs` (Instagram/Slack 8 sn, Messenger 10, X 20, LinkedIn 25; ±%30) — eskiden 8 sohbet/tur × 30-60 sn.
  - Telegram açılışı: okunmamışlar önce, ilk 25 sohbetin son 30 mesajı. iMessage açılış yüklemesi 800'lük dilimler (yeniden eskiye).
  - Masaüstü: pencere kapatılınca (tepsi) WebKit ~5 dk sonra arayüzü askıya alıyordu → bildirimler/rozet pencere açılınca geliyordu:
    `tauri.conf.json` `backgroundThrottling: "disabled"` (macOS 14+), Info.plist `LSAppNapIsDisabled`. Çekirdek `boot-env.ts` UV_THREADPOOL_SIZE=16.
  - Test: `test/sync-perf.test.ts`.
- `messages` tablosu 150 bin+ satır: gönderen bazlı UPDATE'ler için `messages_sender` indeksi şart; toplu yazımlar
  `store.transaction()` içinde. WhatsApp `refreshNames` debounce'lu (1.5 sn) ve gönderen imzası önbellekli; her olayda
  anında tam tarama olay döngüsünü dakikalarca kilitliyordu (REST yanıt vermiyordu, arayüz "Load failed").
- Arayüz WS olaylarını 150 ms pencerede toplulaştırır (App.tsx queueChat); geçmiş eşitlemesinde binlerce olay gelir.
- Messenger: messenger.com çerezler olsa da "<Ad> Olarak Devam Et" ara sayfasında kalır; strateji bunu tıklar. Mesajlar
  `[role=main] [role=log] [data-scope=messages_table]` ve aria-label "tarih, Gönderen: metin" ile okunur.
- X: Kasım 2025 sonrası sohbetler uçtan uca şifreli "XChat" (/i/chat); 1.1 DM uçlarında görünmez. Strateji sohbet listesini ve
  mesajları /i/chat DOM'undan (`dm-conversation-item-*`, `message-*`/`message-text-*`) okur, API ile birleştirir; gönderim API
  reddederse `dm-composer-textarea`. WhatsApp rehber adları `resyncAppState(['critical_unblock_low',…])` ile geliyor.
- Yerel API belirteci: ~/.mivelo/token; Tauri `core_token` komutu → `x-kavsak-token` başlığı / ws `?token=`. Yerel origin'ler
  (localhost/tauri) belirteçsiz; `null` ve yabancı origin belirteç ister.
- LinkedIn: Rest.li `variables=(...)` içinde URN'deki parantezler %28/%29 olmalı (encodeURIComponent bunları kodlamaz → 400).
