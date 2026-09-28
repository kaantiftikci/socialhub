<?php
declare(strict_types=1);

/**
 * Üyeler (lisans alacaklar): indirme sayfasında "İndir"e basınca açılan kayıt penceresinden gelenler (src 'indir') ve
 * kapatılan demo üyeliklerinden aktarılanlar (src 'demo'). Bekleme listesinden (waitlist.json, yalnız e-posta) AYRI tutulur.
 * Kayıt ~/mivelo-data/members.json (web kökü dışında, 0600): {members:[{email, firstName, lastName, name, src, at, lastAt, ip, downloads:[{file,at}]}]}.
 * Admin → Üyeler sayfasında görünürler (aynı ad soyadlı ikinci kayıt 'dupOf' ile işaretli). mivelo.app/api ve demo api/ (yayında kopyalanır) ortak kullanır.
 * Yazım admin/api.php düzeninde: ayrı .lock, önce kodla, geçici dosya + rename; bozuk dosya asla boş sayılıp üstüne yazılmaz.
 */

if (!function_exists('mv_members_update')) {
    function mv_members_path(): string
    {
        $d = dirname(__DIR__, 2) . '/mivelo-data';
        if (!is_dir($d)) {
            @mkdir($d, 0700, true);
        }
        return $d . '/members.json';
    }

    /**
     * Kilitli oku-değiştir-yaz: $fn(array &$members) → dönüş değeri aynen döner. Okuma/yazma hatasında RuntimeException.
     * @return mixed
     */
    function mv_members_update(callable $fn)
    {
        $path = mv_members_path();
        $lh = @fopen($path . '.lock', 'c');
        if ($lh === false || !flock($lh, LOCK_EX)) {
            throw new RuntimeException('Üye kaydı kilitlenemedi');
        }
        try {
            clearstatcache(true, $path);
            $data = ['members' => []];
            if (file_exists($path)) {
                $raw = @file_get_contents($path);
                if ($raw === false) {
                    throw new RuntimeException('Üye kaydı okunamadı');
                }
                if (trim($raw) !== '') {
                    $data = json_decode($raw, true);
                    if (!is_array($data) || !isset($data['members']) || !is_array($data['members'])) {
                        throw new RuntimeException('Üye kaydı bozuk');
                    }
                }
            }
            $before = $data['members'];
            $res = $fn($data['members']);
            if ($data['members'] !== $before) {
                $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
                if ($json === false) {
                    throw new RuntimeException('Üye kaydı kodlanamadı');
                }
                $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
                if (@file_put_contents($tmp, $json) !== strlen($json) || !@rename($tmp, $path)) {
                    @unlink($tmp);
                    throw new RuntimeException('Üye kaydı yazılamadı');
                }
                @chmod($path, 0600);
            }
            return $res;
        } finally {
            flock($lh, LOCK_UN);
            fclose($lh);
        }
    }

    function mv_members_read(): array
    {
        $raw = @file_get_contents(mv_members_path());
        $d = $raw ? json_decode($raw, true) : null;
        return is_array($d['members'] ?? null) ? $d['members'] : [];
    }

    /** Ad/soyad temizliği: kontrol karakterleri, fazla boşluk ve formül başlatan ilk karakterler (= + - @) atılır; ≤40 karakter */
    function mv_member_name($v): string
    {
        $v = trim(preg_replace('/[\x00-\x1f\x7f]+|\s+/u', ' ', (string) $v) ?? '');
        return mb_substr(ltrim($v, '=+-@ '), 0, 40);
    }

    /**
     * Ad karşılaştırma anahtarı: büyük/küçük harf, boşluk ve Türkçe karakter farkı yok sayılır ("Çağla  IŞIK" = "cagla isik").
     * Aynı anahtarlı iki üyeye iki ayrı lisans gönderilmez (admin license_issue).
     */
    function mv_member_namekey(string $name): string
    {
        $name = strtr($name, ['İ' => 'i', 'I' => 'ı']);
        $name = mb_strtolower($name, 'UTF-8');
        $name = strtr($name, ['ç' => 'c', 'ğ' => 'g', 'ı' => 'i', 'ö' => 'o', 'ş' => 's', 'ü' => 'u', 'â' => 'a', 'î' => 'i', 'û' => 'u']);
        return trim(preg_replace('/[^a-z]+/u', ' ', $name) ?? '');
    }

    /** Ad/soyad denetimi: yalnız harf (+ boşluk, kesme, tire, nokta), 2-40 karakter, en az 2 harf, rakam/bağlantı yok. Hata metni ya da '' */
    function mv_member_name_error(string $v, string $label): string
    {
        if ($v === '') {
            return "$label boş olamaz.";
        }
        if (!preg_match("/^[\\p{L}][\\p{L} '’.\\-]{0,39}$/u", $v) || preg_match_all('/\p{L}/u', $v) < 2) {
            return "$label yalnız harflerden oluşmalı (en az 2 harf).";
        }
        if (preg_match('/(.)\1{3,}/u', $v)) {
            return "$label geçerli görünmüyor.";
        }
        return '';
    }

    /** Geçici (tek kullanımlık) e-posta servisleri: anahtar gerçek kişiye gitsin */
    function mv_disposable_domains(): array
    {
        return ['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', '10minutemail.net', 'temp-mail.org',
        'tempmail.com', 'tempmail.net', 'tempmailo.com', 'yopmail.com', 'yopmail.net', 'trashmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
        'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempr.email', 'moakt.com', 'mail.tm', 'burnermail.io'];
    }

    /** E-posta denetimi: biçim + geçici servis değil + alan adı gerçekten e-posta alıyor (MX ya da A kaydı). Hata metni ya da '' */
    function mv_member_email_error(string $email): string
    {
        if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)
            || !preg_match('/^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/', $email)) {
            return 'Geçerli bir e-posta adresi yaz.';
        }
        $domain = substr(strrchr($email, '@') ?: '', 1);
        if (in_array($domain, mv_disposable_domains(), true)) {
            return 'Geçici e-posta adresleri kabul edilmiyor; kendi e-posta adresini yaz.';
        }
        if (getenv('MV_SKIP_DNS') !== '1' && function_exists('checkdnsrr') && !checkdnsrr($domain, 'MX') && !checkdnsrr($domain, 'A')) {
            return 'Bu e-posta adresinin alan adı bulunamadı; adresi kontrol et.';
        }
        return '';
    }

    /**
     * Üye ekle ya da güncelle (e-postayla tekil). Var olanın adı boşsa doldurulur (üzerine yazılmaz); $file verilirse indirme
     * geçmişine eklenir (son 20). $m: email, firstName, lastName, src, at?, ip?
     */
    function mv_member_upsert(array &$members, array $m, string $file = ''): void
    {
        $email = strtolower(trim((string) ($m['email'] ?? '')));
        $first = mv_member_name($m['firstName'] ?? '');
        $last = mv_member_name($m['lastName'] ?? '');
        $name = trim("$first $last") ?: mv_member_name($m['name'] ?? '');
        $now = time();
        foreach ($members as &$x) {
            if (($x['email'] ?? '') !== $email) {
                continue;
            }
            if (empty($x['name']) && $name !== '') {
                $x['name'] = $name;
                $x['firstName'] = $first;
                $x['lastName'] = $last;
            }
            $x['lastAt'] = $now;
            if (!empty($m['ip'])) {
                $x['ip'] = (string) $m['ip'];
            }
            if ($file !== '') {
                $x['downloads'] = array_slice(array_merge($x['downloads'] ?? [], [['file' => $file, 'at' => $now]]), -20);
            }
            return;
        }
        unset($x);
        // aynı ad soyadla başka e-postadan önceki kayıt varsa işaretle (anahtar ona ikinci kez gönderilmez)
        $dupOf = '';
        $nk = mv_member_namekey($name);
        if ($nk !== '') {
            foreach ($members as $x) {
                if (mv_member_namekey((string) ($x['name'] ?? '')) === $nk) {
                    $dupOf = (string) $x['email'];
                    break;
                }
            }
        }
        $members[] = ['email' => $email, 'firstName' => $first, 'lastName' => $last, 'name' => $name, 'dupOf' => $dupOf, 'src' => (string) ($m['src'] ?? 'indir'),
            'at' => (int) ($m['at'] ?? $now), 'lastAt' => $now, 'ip' => (string) ($m['ip'] ?? ''), 'downloads' => $file !== '' ? [['file' => $file, 'at' => $now]] : []];
    }
}
