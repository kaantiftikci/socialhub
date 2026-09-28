<?php
declare(strict_types=1);

/**
 * Çerezsiz, kişisel veri tutmayan ziyaret sayacı (landing her açılışta bir kez sendBeacon ile çağırır).
 * Günlük toplamlar ~/mivelo-data/stats/YYYY-MM.json: görüntülenme, tekil (IP+UA+gün tuzlu özeti; ham IP yazılmaz),
 * kaynak, cihaz, sayfa. Admin paneli "Trafik" bölümü okur.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    exit('{}');
}
// yalnız kendi sayfamızdan (sendBeacon aynı origin'i gönderir)
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if ($origin === '' || strtolower((string) parse_url($origin, PHP_URL_HOST)) !== $host) {
    http_response_code(403);
    exit('{}');
}
$ua = (string) ($_SERVER['HTTP_USER_AGENT'] ?? '');
if ($ua === '' || preg_match('/bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse/i', $ua)) {
    exit('{}');
}
$body = json_decode((string) file_get_contents('php://input', false, null, 0, 2048), true);
if (!is_array($body)) {
    exit('{}');
}

$clean = static fn ($v, int $n = 40): string => substr(preg_replace('/[^a-z0-9._\/-]/', '', strtolower((string) $v)), 0, $n);
$src = $clean($body['u'] ?? '');
if ($src === '') {
    $rh = strtolower((string) parse_url((string) ($body['r'] ?? ''), PHP_URL_HOST));
    $rh = preg_replace('/^(www\.|m\.|l\.|lm\.)/', '', $rh);
    $src = ($rh === '' || $rh === $host) ? 'doğrudan' : $clean($rh);
}
// yaygın kaynakları tek ada topla
foreach (['instagram' => 'instagram', 'facebook' => 'facebook', 't.co' => 'x', 'twitter' => 'x', 'x.com' => 'x', 'linkedin' => 'linkedin', 'google' => 'google', 'youtube' => 'youtube', 'whatsapp' => 'whatsapp', 'wa.me' => 'whatsapp', 'bing' => 'bing'] as $needle => $name) {
    if (strpos($src, $needle) !== false) {
        $src = $name;
        break;
    }
}
$w = (int) ($body['w'] ?? 0);
$dev = $w > 0 && $w <= 700 ? 'mobil' : ($w > 700 && $w <= 1024 ? 'tablet' : 'masaüstü');
$page = $clean($body['p'] ?? '/', 60) ?: '/';

$dir = dirname(__DIR__, 2) . '/mivelo-data';
if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
    exit('{}');
}
$sdir = $dir . '/stats';
if (!is_dir($sdir)) {
    @mkdir($sdir, 0700, true);
}
$day = date('Y-m-d');
// IPv6'da tek bağlantı /64 önekinin tamamını kullanabilir: sınır ve tekil sayımı /64'e göre
$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
if (strpos($ip, ':') !== false) {
    $bin = @inet_pton($ip);
    if ($bin !== false && strlen($bin) === 16) {
        $ip = bin2hex(substr($bin, 0, 8)) . '::/64';
    }
}
$salt = $dir . '/.stats-salt';
if (!is_file($salt)) {
    // 'x': eşzamanlı ilk iki istekten yalnız biri yazar
    $sh = @fopen($salt, 'x');
    if ($sh !== false) {
        fwrite($sh, bin2hex(random_bytes(16)));
        fclose($sh);
    }
}
$saltVal = trim((string) @file_get_contents($salt));
if (strlen($saltVal) !== 32) {
    exit('{}'); // tuz henüz yazılıyor/okunamadı: bu ziyareti sayma
}
$vid = substr(hash('sha256', $saltVal . '|' . $day . '|' . $ip . '|' . $ua), 0, 16);

$path = $sdir . '/' . date('Y-m') . '.json';
$lh = @fopen($path . '.lock', 'c');
if ($lh === false || !flock($lh, LOCK_EX)) {
    exit('{}');
}
clearstatcache(true, $path);
$data = ['days' => []];
if (file_exists($path)) {
    $raw = @file_get_contents($path);
    if ($raw === false) {
        exit('{}');
    }
    if (trim($raw) !== '') {
        $data = json_decode($raw, true);
        // bozuk dosya sıfırlanıp üstüne yazılmaz (ayın tüm sayımları giderdi)
        if (!is_array($data)) {
            exit('{}');
        }
    }
}
if (!isset($data['days']) || !is_array($data['days'])) {
    $data['days'] = [];
}
// Tekil kümesi (ids) ve dakikalık sınır (rl) yalnız bugün için gerekir: eski günlerinkini at (dosya her ziyarette
// baştan yazılıyor; ay boyu 50 000'er kimlik birikince her istek MB'larca JSON işliyor, panel bellek sınırına takılıyordu)
foreach ($data['days'] as $k => $v) {
    if ($k !== $day && is_array($v)) {
        unset($data['days'][$k]['ids'], $data['days'][$k]['rl']);
    }
}
$d = $data['days'][$day] ?? ['v' => 0, 'u' => 0, 'ids' => [], 'src' => [], 'dev' => [], 'page' => []];
$d['ids'] = is_array($d['ids'] ?? null) ? $d['ids'] : [];
// tekil kümesi anahtar olarak tutulur (O(1)); eski biçim (liste) dönüştürülür
if ($d['ids'] !== [] && $d['ids'] === array_values($d['ids'])) {
    $d['ids'] = array_fill_keys($d['ids'], 1);
}
// IP başına dakikalık sınır (sahte UA ile şişirmeye karşı): aynı IP'den (IPv6: /64) dakikada en çok 30 kayıt
$ipKey = substr(hash('sha256', $ip . '|' . date('Y-m-d H:i')), 0, 12);
$d['rl'] = (($d['rl']['m'] ?? '') === date('H:i') && is_array($d['rl']['c'] ?? null)) ? $d['rl'] : ['m' => date('H:i'), 'c' => []];
$d['rl']['c'][$ipKey] = ($d['rl']['c'][$ipKey] ?? 0) + 1;
if ($d['rl']['c'][$ipKey] > 30) {
    exit('{}');
}
$d['v']++;
// günlük tekil sınırı 50 000 (dosya sınırsız büyümesin; aşılırsa yalnız görüntülenme sayılır)
if (!isset($d['ids'][$vid]) && count($d['ids']) < 50000) {
    $d['ids'][$vid] = 1;
    $d['u']++;
    // kaynak ve cihaz tekil ziyaretçi başına sayılır
    $d['src'][$src] = ($d['src'][$src] ?? 0) + 1;
    $d['dev'][$dev] = ($d['dev'][$dev] ?? 0) + 1;
}
$d['page'][$page] = ($d['page'][$page] ?? 0) + 1;
$data['days'][$day] = $d;
// önce kodla (hata → dosyaya dokunma), sonra geçici dosya + rename
$json = json_encode($data, JSON_UNESCAPED_UNICODE);
if ($json === false) {
    exit('{}');
}
$tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
$fh = @fopen($tmp, 'x');
$ok = $fh !== false && fwrite($fh, $json) === strlen($json) && fflush($fh);
if ($fh !== false) {
    fclose($fh);
}
if (!$ok || !@rename($tmp, $path)) {
    @unlink($tmp);
}
flock($lh, LOCK_UN);
fclose($lh);
echo '{}';
