<?php
declare(strict_types=1);

/**
 * Geri bildirim (hata / öneri / talep): Mivelo uygulamasındaki sağ alt düğmeden multipart POST.
 *   alanlar: type (bug|idea|request|other), message, email?, name?, user? (demo kullanıcı adı), page?, app? (demo|local), website (bot tuzağı)
 *   dosyalar: files[] — görsel (png/jpeg/gif/webp) ya da video (mp4/webm/quicktime); en çok 5 dosya, dosya başına 40 MB, toplam 60 MB
 * Kayıtlar web kökü dışında ~/mivelo-data/feedback/index.json + ~/mivelo-data/feedback/<id>/<dosya>. Admin paneli okur.
 * Kaynaklar: demo.mivelo.app ve kullanıcının kendi bilgisayarındaki Mivelo (localhost / Tauri) → yalnız bu kökenlere CORS.
 * IP (/64) başına saatte 10 gönderim. SMTP ayarlıysa yeni bildirim sahibine e-postayla da haber verilir.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

const ALLOWED_ORIGINS = ['https://demo.mivelo.app', 'https://mivelo.app', 'http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
const MAX_FILES = 5;
const MAX_FILE = 40 * 1024 * 1024;
const MAX_TOTAL = 60 * 1024 * 1024;
const TYPES = ['bug', 'idea', 'request', 'other'];
const MIMES = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/gif' => 'gif', 'image/webp' => 'webp', 'video/mp4' => 'mp4', 'video/webm' => 'webm', 'video/quicktime' => 'mov'];

function fail(int $code, string $msg)
{
    http_response_code($code);
    echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if ($origin !== '') {
    $same = strtolower((string) parse_url($origin, PHP_URL_HOST)) === $host;
    if (!$same && !in_array($origin, ALLOWED_ORIGINS, true)) {
        fail(403, 'İstek reddedildi');
    }
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 600');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'Yalnızca POST');
}
// post_max_size aşılınca PHP $_POST/$_FILES'ı sessizce boşaltır
if (empty($_POST) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
    fail(413, 'Ekler çok büyük; daha küçük bir video ya da ekran görüntüsü dene');
}

$in = fn (string $k, int $max) => trim(mb_substr(preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f]/u', '', (string) ($_POST[$k] ?? '')) ?? '', 0, $max));
if ($in('website', 100) !== '') {
    echo json_encode(['ok' => true]);
    exit;
}
$type = in_array($_POST['type'] ?? '', TYPES, true) ? (string) $_POST['type'] : 'other';
$message = $in('message', 5000);
$email = strtolower($in('email', 120));
$name = $in('name', 80);
$user = preg_replace('/[^a-z0-9._@-]/', '', strtolower($in('user', 120))) ?? '';
$page = $in('page', 300);
$app = in_array($_POST['app'] ?? '', ['demo', 'local'], true) ? (string) $_POST['app'] : 'other';
$ua = mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 300);
if (mb_strlen($message) < 3) {
    fail(400, 'Ne olduğunu kısaca yaz');
}
if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    fail(400, 'E-posta adresi geçersiz');
}

$dataDir = dirname(__DIR__, 2) . '/mivelo-data';
if (!is_dir($dataDir) && !@mkdir($dataDir, 0700, true)) {
    fail(500, 'Kayıt alanı açılamadı');
}
$dir = $dataDir . '/feedback';
if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
    fail(500, 'Kayıt alanı açılamadı');
}

function lock_file(string $path)
{
    $lh = @fopen($path . '.lock', 'c');
    if ($lh === false || !flock($lh, LOCK_EX)) {
        fail(500, 'Kayıt kilitlenemedi');
    }
    return $lh;
}
function read_json_file(string $path, array $empty): array
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
function write_json_file(string $path, array $data): void
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

// hız sınırı: IP (IPv6 /64) başına saatte 10
$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
$key = $ip;
if (strpos($ip, ':') !== false && ($bin = @inet_pton($ip)) !== false && strlen($bin) === 16) {
    $key = bin2hex(substr($bin, 0, 8)) . '::/64';
}
$rlPath = $dir . '/ratelimit.json';
$lh = lock_file($rlPath);
$rl = read_json_file($rlPath, []);
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
write_json_file($rlPath, $rl);
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
    if (count($tmps) > MAX_FILES) {
        fail(400, 'En çok ' . MAX_FILES . ' dosya eklenebilir');
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
        if ($size > MAX_FILE || $total > MAX_TOTAL) {
            fail(413, 'Ekler çok büyük (dosya başına 40 MB, toplam 60 MB)');
        }
        $mime = $finfo ? (string) finfo_file($finfo, $tmp) : '';
        if (!isset(MIMES[$mime])) {
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
        $fname = ($n + 1) . '.' . MIMES[$f['mime']];
        if (!@move_uploaded_file($f['tmp'], $fdir . '/' . $fname)) {
            fail(500, 'Dosya kaydedilemedi');
        }
        $saved[] = ['file' => $fname, 'mime' => $f['mime'], 'size' => $f['size'], 'name' => $f['orig']];
    }
}

$entry = [
    'id' => $id, 'at' => $now, 'type' => $type, 'message' => $message, 'email' => $email, 'name' => $name, 'user' => $user,
    'page' => $page, 'app' => $app, 'ua' => $ua, 'files' => $saved, 'status' => 'new', 'note' => '',
];
$idx = $dir . '/index.json';
$lh = lock_file($idx);
$d = read_json_file($idx, ['items' => []]);
$d['items'] = is_array($d['items'] ?? null) ? $d['items'] : [];
if (count($d['items']) >= 5000) {
    fail(507, 'Geri bildirim kutusu dolu');
}
$d['items'][] = $entry;
write_json_file($idx, $d);
flock($lh, LOCK_UN);
fclose($lh);

echo json_encode(['ok' => true, 'id' => $id]);

// yanıt gönderildikten sonra sahibine haber ver (SMTP ayarlıysa; hata gönderimi etkilemez)
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
}
require_once __DIR__ . '/lib-smtp.php';
$cfg = mv_smtp_config();
if ($cfg) {
    $label = ['bug' => 'Hata', 'idea' => 'Öneri', 'request' => 'Talep', 'other' => 'Diğer'][$type];
    $who = trim(($name ?: $user) . ($email ? " <$email>" : '')) ?: 'anonim';
    $body = "Yeni geri bildirim ($label) — $who\n\n$message\n\n"
        . ($saved ? count($saved) . " ek dosya\n" : '')
        . "Sayfa: $page\nUygulama: $app\n\nPanelde gör: https://mivelo.app/admin/#geri\n";
    @mv_send_mail((string) ($cfg['notify'] ?? $cfg['from'] ?? $cfg['user']), "Mivelo geri bildirim: $label", $body, $email ?: null);
}
