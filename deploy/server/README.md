# Mivelo sunucu çekirdeği (demo üyeleri için)

Demo sitesindeki (demo.mivelo.app) üyeler gerçek hesaplarını (WhatsApp, Telegram, Instagram, e-posta…) bağlayabilsin diye
Mivelo çekirdeği bir sunucuda çalışır. **Her üyeye ayrı bir çekirdek süreci ve ayrı bir veri klasörü** açılır; üyeler
birbirinin verisini göremez.

```
tarayıcı (demo.mivelo.app)
   │  https://core.mivelo.app/api/…  ve  wss://core.mivelo.app/ws   (belirteç: demo girişinde PHP verir)
   ▼
Caddy (HTTPS, sertifika kendiliğinden)  →  ağ geçidi 127.0.0.1:8787  (apps/gateway/gateway.mjs)
                                              │ belirteci doğrular, üyenin çekirdeğini gerekirse başlatır
                                              ▼
                        çekirdek u-admin (127.0.0.1:17000, /var/lib/mivelo/users/u-admin)
                        çekirdek u-b1f2…  (127.0.0.1:17001, /var/lib/mivelo/users/u-b1f2…)  …
```

- Çekirdek ilk istekte açılır (1–3 sn), 12 saat hiç kullanılmazsa kapanır (açık sekme = kullanılıyor), sonraki girişte
  yeniden açılır. Aynı anda en çok `MAX_CORES` üye (varsayılan: her 2 GB bellek için 1; 24 GB → 12).
- Tarayıcıyla girilen kanalların (Instagram, LinkedIn, Gmail…) giriş sayfası sunucudaki Chromium'da açılır ve görüntüsü
  Mivelo'nun içine yayınlanır; kullanıcı orada tıklar/yazar.
- `main` dalına her gönderimden sonra sunucu 5 dk içinde kendini günceller (yalnız çekirdek ya da ağ geçidi değiştiyse
  yeniden başlar).

---

## 1. Sunucu aç

### Seçenek A — Oracle Cloud "Always Free" (ücretsiz)

1. <https://www.oracle.com/cloud/free/> → **Start for free**. Kart bilgisi doğrulama için istenir, ücret alınmaz.
   "Home Region" olarak yakın bir bölge seç (ör. Frankfurt ya da Amsterdam); sonradan değiştirilemez.
2. Konsolda **Compute → Instances → Create instance**:
   - **Image**: *Canonical Ubuntu 24.04* (Change image → Ubuntu).
   - **Shape**: *Ampere* → **VM.Standard.A1.Flex**, **4 OCPU, 24 GB bellek** (Always Free sınırı).
     "Out of capacity" hatası alırsan birkaç saat sonra ya da başka bir "Availability domain" ile yeniden dene.
   - **Networking**: yeni sanal ağ (VCN) oluşturulsun, **Assign a public IPv4 address** açık.
   - **Add SSH keys**: "Generate a key pair" → özel anahtarı indir (ör. `ssh-key.key`).
   - Oluştur; birkaç dakika sonra **Public IP address** görünür.
3. **80 ve 443 portlarını aç** (Oracle'da iki katman var):
   - **VCN güvenlik listesi**: Instance sayfası → Subnet bağlantısı → **Security Lists** → *Default Security List* →
     **Add Ingress Rules**: Source CIDR `0.0.0.0/0`, IP Protocol `TCP`, Destination Port Range `80` → ekle; aynısını `443` için.
   - **Sunucunun kendi güvenlik duvarı** (Oracle'ın Ubuntu imajı iptables ile her şeyi kapatır): kurulum betiği bunu
     kendisi açar (`iptables` + `netfilter-persistent`), ayrıca bir şey yapman gerekmez.
4. Bağlan (Mac Terminal'de):
   ```bash
   chmod 600 ~/Downloads/ssh-key.key
   ssh -i ~/Downloads/ssh-key.key ubuntu@<PUBLIC_IP>
   ```

### Seçenek B — Hetzner Cloud CX22 (~4 €/ay)

<https://console.hetzner.cloud> → proje → **Add Server**: konum Falkenstein/Nürnberg/Helsinki, image **Ubuntu 24.04**,
tip **CX22** (2 vCPU, 4 GB), SSH anahtarını ekle. Hetzner'de varsayılan güvenlik duvarı yok (80/443 açık).
4 GB bellekle aynı anda ~2 üye rahat çalışır (betik 4 GB takas alanı da açar). `ssh root@<IP>` ile bağlan.

## 2. Alan adını sunucuya yönlendir (Türkticaret DNS)

Türkticaret müşteri paneli → **Alan Adlarım → mivelo.app → DNS Yönetimi** → yeni kayıt:

| Tür | Ad     | Değer            | TTL  |
|-----|--------|------------------|------|
| A   | `core` | sunucunun IP'si  | 300  |

Kontrol (birkaç dakika sürebilir): `ping core.mivelo.app` sunucunun IP'sini göstermeli.

## 3. Kurulum (tek satır)

Sırrı **Mivelo Admin → Demo → Sunucu çekirdeği** kartından kopyala (demo sitesi bu sırla üyelere belirteç imzalar;
ikisi aynı olmalı). Sunucuda:

```bash
curl -fsSL https://raw.githubusercontent.com/kaantiftikci/socialhub/main/deploy/server/setup.sh \
  | sudo bash -s -- --domain core.mivelo.app --secret 'BURAYA_SIR'
```

10–15 dakika sürer (Node 22, Caddy, Chromium, bağımlılıklar). Betik tekrar çalıştırılabilir: güncel sürüme getirir,
önceki ayarları korur. Sırrı değiştirmek için yalnız `--secret` ile yeniden çalıştır (panelde de aynısı olmalı).

Ek seçenekler: `--origins https://demo.mivelo.app` (virgülle birden çok, boşluksuz), `--max-cores 8`,
`--idle-minutes 720`, `--branch main`. Ayarlar `/etc/mivelo/gateway.env` dosyasında (yalnız root okur).

## 4. Kontrol

Tarayıcıda ya da terminalde: <https://core.mivelo.app/gw/health> → `{"ok":true,"cores":0}` (`cores` = şu an açık
üye çekirdeği). Sertifika ilk istekte birkaç saniye içinde alınır; hata alırsan DNS kaydını ve 80/443 portlarını kontrol et.

## Günlükler ve bakım

```bash
journalctl -u mivelo-gateway -f          # ağ geçidi: hangi üyenin çekirdeği açıldı/kapandı/çöktü (içerik/belirteç yazmaz)
sudo tail -f /var/lib/mivelo/users/<uid>/core.log   # bir üyenin çekirdek günlüğü (5 MB'ta core.log.1'e döner)
journalctl -u mivelo-update -n 50        # otomatik güncellemeler
journalctl -u caddy -n 50                # HTTPS / sertifika
systemctl status mivelo-gateway mivelo-xvfb caddy
sudo systemctl restart mivelo-gateway    # tüm çekirdekleri kapatıp yeniden başlatır (üyeler sayfayı yenileyince açılır)
sudo systemctl start mivelo-update       # güncellemeyi hemen dene
```

Üyenin kimliği (`u-…`) Admin → Demo listesinde. Üye silinince demo arka ucu `POST /gw/delete-user` ile sunucudaki
çekirdeği durdurup veri klasörünü siler (KVKK).

## Kaynak ve riskler

- **Bellek**: üye başına çekirdek ~150 MB; tarayıcıyla bağlanan her kanal (Instagram, LinkedIn, X, Messenger, Gmail/Outlook
  tarayıcı girişi…) ~250 MB daha. WhatsApp, Telegram, Slack (uygulama), e-posta (uygulama şifresi) ve pazaryerleri tarayıcısız
  ve hafif. 24 GB'lık Oracle sunucusu ~12 üyeyi rahat taşır; `free -h` ve `MAX_CORES` ile ayarla.
- **Disk**: üye başına veritabanı + medya önbelleği (60 günden eskisi silinir) + tarayıcı profilleri; birkaç yüz MB olabilir.
- **Veri merkezi IP'si**: Instagram, LinkedIn, Facebook ve Google, bulut sunucusundan gelen girişte sıkça ek doğrulama
  (e-posta/SMS kodu, "Bu sen misin?") ister, bazen hesabı geçici kısıtlar. Üyelere bunu söyle; önemli hesaplarla deneme
  yapılmasın. **WhatsApp ve Telegram** (QR ile, telefon bağlı cihaz olarak) sorunsuz çalışır.
- Sunucu tek kişilik masaüstü çekirdeğiyle aynı kod; iMessage, macOS Kişiler ve cihaz takvimi sunucuda kapalı.
- Oracle "Always Free" hesaplarında uzun süre boşta kalan sunucular geri alınabiliyor; hesabı "Pay As You Go"ya
  yükseltmek (ücretsiz kaynaklar yine ücretsiz) bunu önler.
