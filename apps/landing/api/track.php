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
    if (str_contains($src, $needle)) {
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
$salt = $dir . '/.stats-salt';
if (!is_file($salt)) {
    file_put_contents($salt, bin2hex(random_bytes(16)));
}
$vid = substr(hash('sha256', trim((string) file_get_contents($salt)) . '|' . $day . '|' . ($_SERVER['REMOTE_ADDR'] ?? '') . '|' . $ua), 0, 16);

$fh = fopen($sdir . '/' . date('Y-m') . '.json', 'c+');
if ($fh === false) {
    exit('{}');
}
flock($fh, LOCK_EX);
$raw = stream_get_contents($fh);
$data = ($raw !== false && $raw !== '') ? json_decode($raw, true) : null;
if (!is_array($data)) {
    $data = ['days' => []];
}
$d = $data['days'][$day] ?? ['v' => 0, 'u' => 0, 'ids' => [], 'src' => [], 'dev' => [], 'page' => []];
// tekil kümesi anahtar olarak tutulur (O(1)); eski biçim (liste) dönüştürülür
if (array_is_list($d['ids'])) {
    $d['ids'] = array_fill_keys($d['ids'], 1);
}
// IP başına dakikalık sınır (sahte UA ile şişirmeye karşı): aynı IP'den dakikada en çok 30 kayıt
$ipKey = substr(hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . '|' . date('Y-m-d H:i')), 0, 12);
$d['rl'] = ($d['rl']['m'] ?? '') === date('H:i') ? $d['rl'] : ['m' => date('H:i'), 'c' => []];
$d['rl']['c'][$ipKey] = ($d['rl']['c'][$ipKey] ?? 0) + 1;
if ($d['rl']['c'][$ipKey] > 30) {
    flock($fh, LOCK_UN);
    fclose($fh);
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
ftruncate($fh, 0);
rewind($fh);
fwrite($fh, (string) json_encode($data, JSON_UNESCAPED_UNICODE));
fflush($fh);
flock($fh, LOCK_UN);
fclose($fh);
echo '{}';
