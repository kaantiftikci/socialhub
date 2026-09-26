<?php
declare(strict_types=1);

/**
 * Bekleme listesi: POST {email, ref} → {position, code}. Kayıtlar web kökünün dışında ~/mivelo-data/waitlist.json.
 * Aynı e-posta ikinci kez gelirse yeni kayıt açılmaz, mevcut sıra ve kod döner. `ref` davet kodu; davet edenin `refs` sayacı artar.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function fail(int $code, string $msg): never
{
    http_response_code($code);
    echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && strtolower((string) parse_url($origin, PHP_URL_HOST)) !== $host) {
    fail(403, 'İstek reddedildi');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'Yalnızca POST');
}

$body = json_decode((string) file_get_contents('php://input', false, null, 0, 4096), true);
$email = strtolower(trim((string) ($body['email'] ?? '')));
$ref = preg_replace('/[^a-z0-9]/', '', strtolower((string) ($body['ref'] ?? '')));
if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    fail(400, 'Geçerli bir e-posta adresi yaz.');
}

function data_dir(): string
{
    $outside = dirname(__DIR__, 2) . '/mivelo-data';
    if (is_dir($outside) || @mkdir($outside, 0700, true)) {
        return $outside;
    }
    $inside = dirname(__DIR__) . '/.private';
    if (!is_dir($inside) && !@mkdir($inside, 0700, true)) {
        fail(500, 'Kayıt alanı açılamadı');
    }
    $guard = $inside . '/.htaccess';
    if (!is_file($guard)) {
        file_put_contents($guard, "Require all denied\nDeny from all\n");
    }
    return $inside;
}

$fh = fopen(data_dir() . '/waitlist.json', 'c+');
if ($fh === false) {
    fail(500, 'Kayıt alanı açılamadı');
}
flock($fh, LOCK_EX);
$raw = stream_get_contents($fh);
$data = ($raw !== false && $raw !== '') ? json_decode($raw, true) : null;
if (!is_array($data) || !isset($data['entries']) || !is_array($data['entries'])) {
    $data = ['entries' => []];
}

$ip = $_SERVER['REMOTE_ADDR'] ?? '';
$out = null;
foreach ($data['entries'] as $i => $e) {
    if ($e['email'] === $email) {
        $out = ['position' => $i + 1, 'code' => $e['code']];
        break;
    }
}
if ($out === null) {
    // Kaba kötüye kullanım sınırı: aynı IP'den son bir saatte en fazla 20 kayıt
    $recent = 0;
    foreach ($data['entries'] as $e) {
        if (($e['ip'] ?? '') === $ip && ($e['at'] ?? 0) > time() - 3600) {
            $recent++;
        }
    }
    if ($recent >= 20) {
        flock($fh, LOCK_UN);
        fclose($fh);
        fail(429, 'Çok fazla deneme, biraz sonra tekrar dene.');
    }
    $codes = array_column($data['entries'], 'code');
    do {
        $code = substr(bin2hex(random_bytes(4)), 0, 6);
    } while (in_array($code, $codes, true));
    if ($ref !== '') {
        foreach ($data['entries'] as &$e) {
            if ($e['code'] === $ref) {
                $e['refs'] = (int) ($e['refs'] ?? 0) + 1;
                break;
            }
        }
        unset($e);
    }
    $data['entries'][] = ['email' => $email, 'code' => $code, 'ref' => $ref, 'refs' => 0, 'at' => time(), 'ip' => $ip];
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, $json === false ? '{"entries":[]}' : $json);
    fflush($fh);
    $out = ['position' => count($data['entries']), 'code' => $code];
}
flock($fh, LOCK_UN);
fclose($fh);
echo json_encode($out);
