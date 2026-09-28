<?php
declare(strict_types=1);

/**
 * Geri bildirim kaydı (ortak): mivelo.app/api/feedback.php (yerel uygulama) ve demo.mivelo.app/api/index.php?action=feedback
 * (demo; üye kimliği OTURUMDAN — istemcinin gönderdiği ad/kullanıcı adı yok sayılır) aynı işlevi kullanır.
 * Çağıran `fail(int, string)` tanımlamış olmalı. Kayıt ~/mivelo-data/feedback/index.json + <id>/<n>.<ext>.
 */

if (!function_exists('mv_feedback_store')) {
    function mv_fb_lock(string $path)
    {
        $lh = @fopen($path . '.lock', 'c');
        if ($lh === false || !flock($lh, LOCK_EX)) {
            fail(500, 'Kayıt kilitlenemedi');
        }
        return $lh;
    }
    function mv_fb_read(string $path, array $empty): array
    {
        clearstatcache(true, $path);
        if (!file_exists($path)) {
            return $empty;
        }
        $raw = (string) @file_get_contents($path);
        if (trim($raw) === '') {
            return $empty;
        }
        $d = json_decode($raw, true);
        if (!is_array($d)) {
            fail(500, 'Kayıt dosyası bozuk');
        }
        return $d;
    }
    function mv_fb_write(string $path, array $data): void
    {
        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        if ($json === false) {
            fail(500, 'Kayıt kodlanamadı');
        }
        $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, $json) !== strlen($json) || !@rename($tmp, $path)) {
            @unlink($tmp);
            fail(500, 'Kayıt yazılamadı');
        }
    }

    /**
     * $_POST/$_FILES'tan geri bildirimi doğrula ve kaydet. $who: oturumdan gelen kimlik (demo) — verilirse istemcinin gönderdiği
     * kimlik alanları kullanılmaz. Kayıt kimliğini döndürür.
     * @param array{name?: string, user?: string, email?: string, userId?: string}|null $who
     */
    function mv_feedback_store(string $app, ?array $who): string
    {
        $MAX_FILES = 5;
        $MAX_FILE = 40 * 1024 * 1024;
        $MAX_TOTAL = 60 * 1024 * 1024;
        $TYPES = ['bug', 'idea', 'request', 'other'];
        $MIMES = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/gif' => 'gif', 'image/webp' => 'webp', 'video/mp4' => 'mp4', 'video/webm' => 'webm', 'video/quicktime' => 'mov'];
        // post_max_size aşılınca PHP $_POST/$_FILES'ı sessizce boşaltır
        if (empty($_POST) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
            fail(413, 'Ekler çok büyük; daha küçük bir video ya da görsel dene');
        }
        $in = fn (string $k, int $max) => trim(mb_substr(preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f]/u', '', (string) ($_POST[$k] ?? '')) ?? '', 0, $max));
        if ($in('website', 100) !== '') {
            echo json_encode(['ok' => true]);
            exit;
        }
        $type = in_array($_POST['type'] ?? '', $TYPES, true) ? (string) $_POST['type'] : 'other';
        $message = $in('message', 5000);
        // kimlik yalnız sunucudan: demo oturumundaki üye; yerel uygulamada yok (istemcinin gönderdiği ad/e-posta yok sayılır)
        $email = $who ? strtolower((string) ($who['email'] ?? '')) : '';
        $name = $who ? (string) ($who['name'] ?? '') : '';
        $user = $who ? (string) ($who['user'] ?? '') : '';
        $userId = $who ? (string) ($who['userId'] ?? '') : '';
        $page = $in('page', 300);
        $ua = mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 300);
        if (mb_strlen($message) < 3) {
            fail(400, 'Ne olduğunu kısaca yaz');
        }

        $dataDir = dirname(__DIR__, 2) . '/mivelo-data';
        if (!is_dir($dataDir) && !@mkdir($dataDir, 0700, true)) {
            fail(500, 'Kayıt alanı açılamadı');
        }
        $dir = $dataDir . '/feedback';
        if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
            fail(500, 'Kayıt alanı açılamadı');
        }

        // hız sınırı: IP (IPv6 /64) başına saatte 10
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        $key = $ip;
        if (strpos($ip, ':') !== false && ($bin = @inet_pton($ip)) !== false && strlen($bin) === 16) {
            $key = bin2hex(substr($bin, 0, 8)) . '::/64';
        }
        $rlPath = $dir . '/ratelimit.json';
        $lh = mv_fb_lock($rlPath);
        $rl = mv_fb_read($rlPath, []);
        $now = time();
        foreach ($rl as $k => $v) {
            $rl[$k] = array_values(array_filter(is_array($v) ? $v : [], fn ($t) => (int) $t > $now - 3600));
            if (!$rl[$k]) {
                unset($rl[$k]);
            }
        }
        if (count($rl[$key] ?? []) >= 10) {
            fail(429, 'Çok fazla gönderim; biraz sonra tekrar dene');
        }
        $rl[$key][] = $now;
        mv_fb_write($rlPath, $rl);
        flock($lh, LOCK_UN);
        fclose($lh);

        // dosyalar: türü içerikten (finfo) belirlenir, adı sunucu verir
        $files = [];
        $up = $_FILES['files'] ?? null;
        if (is_array($up) && isset($up['tmp_name'])) {
            $tmps = (array) $up['tmp_name'];
            $names = (array) $up['name'];
            $errs = (array) $up['error'];
            $sizes = (array) $up['size'];
            if (count($tmps) > $MAX_FILES) {
                fail(400, 'En çok ' . $MAX_FILES . ' dosya eklenebilir');
            }
            $total = 0;
            $finfo = function_exists('finfo_open') ? finfo_open(FILEINFO_MIME_TYPE) : false;
            foreach ($tmps as $i => $tmp) {
                if ((int) $errs[$i] === UPLOAD_ERR_NO_FILE) {
                    continue;
                }
                if ((int) $errs[$i] !== UPLOAD_ERR_OK) {
                    fail(413, 'Dosya yüklenemedi (çok büyük olabilir): ' . mb_substr((string) $names[$i], 0, 60));
                }
                $size = (int) $sizes[$i];
                $total += $size;
                if ($size > $MAX_FILE || $total > $MAX_TOTAL) {
                    fail(413, 'Ekler çok büyük (dosya başına 40 MB, toplam 60 MB)');
                }
                $mime = $finfo ? (string) finfo_file($finfo, $tmp) : '';
                if (!isset($MIMES[$mime])) {
                    fail(400, 'Yalnız görsel ya da video eklenebilir: ' . mb_substr((string) $names[$i], 0, 60));
                }
                $files[] = ['tmp' => $tmp, 'mime' => $mime, 'size' => $size, 'orig' => mb_substr(basename((string) $names[$i]), 0, 120)];
            }
        }

        $id = date('Ymd-His') . '-' . bin2hex(random_bytes(3));
        $saved = [];
        if ($files) {
            $fdir = $dir . '/' . $id;
            if (!@mkdir($fdir, 0700, true)) {
                fail(500, 'Dosya alanı açılamadı');
            }
            foreach ($files as $n => $f) {
                $fname = ($n + 1) . '.' . $MIMES[$f['mime']];
                if (!@move_uploaded_file($f['tmp'], $fdir . '/' . $fname)) {
                    fail(500, 'Dosya kaydedilemedi');
                }
                $saved[] = ['file' => $fname, 'mime' => $f['mime'], 'size' => $f['size'], 'name' => $f['orig']];
            }
        }

        $entry = [
            'id' => $id, 'at' => $now, 'type' => $type, 'message' => $message, 'email' => $email, 'name' => $name, 'user' => $user, 'userId' => $userId, 'verified' => (bool) $who,
            'page' => $page, 'app' => $app, 'ua' => $ua, 'files' => $saved, 'status' => 'new', 'note' => '',
        ];
        $idx = $dir . '/index.json';
        $lh = mv_fb_lock($idx);
        $d = mv_fb_read($idx, ['items' => []]);
        $d['items'] = is_array($d['items'] ?? null) ? $d['items'] : [];
        if (count($d['items']) >= 5000) {
            fail(507, 'Geri bildirim kutusu dolu');
        }
        $d['items'][] = $entry;
        mv_fb_write($idx, $d);
        flock($lh, LOCK_UN);
        fclose($lh);
        return $id;
    }

    /** SMTP ayarlıysa sahibine haber ver (yanıt gönderildikten sonra çağrılır; hata etkilemez) */
    function mv_feedback_notify(string $id): void
    {
        if (!function_exists('mv_smtp_config')) {
            return;
        }
        $cfg = mv_smtp_config();
        if (!$cfg) {
            return;
        }
        $d = mv_fb_read(dirname(__DIR__, 2) . '/mivelo-data/feedback/index.json', ['items' => []]);
        $x = null;
        foreach ($d['items'] ?? [] as $it) {
            if (($it['id'] ?? '') === $id) {
                $x = $it;
            }
        }
        if (!$x) {
            return;
        }
        $label = ['bug' => 'Hata', 'idea' => 'Öneri', 'request' => 'Talep', 'other' => 'Diğer'][$x['type']] ?? 'Diğer';
        $who = trim(($x['name'] ?: $x['user']) . ($x['email'] ? ' <' . $x['email'] . '>' : '')) ?: ($x['app'] === 'local' ? 'yerel uygulama' : 'anonim');
        $body = "Yeni geri bildirim ($label) — $who\n\n" . $x['message'] . "\n\n"
            . (!empty($x['files']) ? count($x['files']) . " ek dosya\n" : '')
            . 'Sayfa: ' . $x['page'] . "\nUygulama: " . $x['app'] . "\n\nPanelde gör: https://mivelo.app/admin/#geri\n";
        @mv_send_mail((string) ($cfg['notify'] ?? $cfg['from'] ?? $cfg['user']), "Mivelo geri bildirim: $label", $body, $x['email'] ?: null);
    }
}
