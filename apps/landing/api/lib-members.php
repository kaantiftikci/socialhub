<?php
declare(strict_types=1);

/**
 * Üyeler (lisans alacaklar): indirme sayfasında "İndir"e basınca açılan kayıt penceresinden gelenler (src 'indir') ve
 * kapatılan demo üyeliklerinden aktarılanlar (src 'demo'). Bekleme listesinden (waitlist.json, yalnız e-posta) AYRI tutulur.
 * Kayıt ~/mivelo-data/members.json (web kökü dışında, 0600): {members:[{email, firstName, lastName, name, src, at, lastAt, ip, downloads:[{file,at}]}]}.
 * Admin → Lisanslar → "Üyelere anahtar gönder" listesinde görünürler. mivelo.app/api ve demo api/ (yayında kopyalanır) ortak kullanır.
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
        $members[] = ['email' => $email, 'firstName' => $first, 'lastName' => $last, 'name' => $name, 'src' => (string) ($m['src'] ?? 'indir'),
            'at' => (int) ($m['at'] ?? $now), 'lastAt' => $now, 'ip' => (string) ($m['ip'] ?? ''), 'downloads' => $file !== '' ? [['file' => $file, 'at' => $now]] : []];
    }
}
