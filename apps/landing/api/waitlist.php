<?php
declare(strict_types=1);

/**
 * Bekleme listesi: POST {email, ref, consent:{kvkk}} → {position, code}. consent.kvkk = okunan KVKK Aydınlatma Metni sürümü (zorunlu,
 * KVKK_VERSION ile aynı olmalı; kayda {kvkk, at} yazılır). Kayıtlar web kökünün dışında ~/mivelo-data/waitlist.json.
 * Aynı e-posta ikinci kez gelirse yeni kayıt açılmaz; yanıt yeni kayıtla aynı biçimde ama uydurma (sıra = liste sonu, rastgele
 * kod): kimin listede olduğu ve başkasının davet kodu dışarı sızmaz. `ref` davet kodu; davet edenin `refs` sayacı artar.
 * Yazım admin/api.php ile aynı düzen: waitlist.json.lock üzerinde kilit, önce kodla, geçici dosya + rename.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function fail(int $code, string $msg)
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
if (!is_array($body)) {
    $body = [];
}
$email = strtolower(trim((string) ($body['email'] ?? '')));
$ref = preg_replace('/[^a-z0-9]/', '', strtolower((string) ($body['ref'] ?? '')));
// nereden geldi: utm_source ya da yönlendiren alan adı (landing gönderir); admin panelinde kaynak kırılımı için
$src = substr(preg_replace('/[^a-z0-9._-]/', '', strtolower((string) ($body['src'] ?? ''))), 0, 40);
// Botlar gizli "website" alanını doldurur: sessizce başarılı gibi yanıtla, kaydetme
if (trim((string) ($body['website'] ?? '')) !== '') {
    echo json_encode(['position' => 0, 'code' => substr(bin2hex(random_bytes(4)), 0, 6)]);
    exit;
}
// KVKK Aydınlatma Metni okundu beyanı (kvkk.html sürümüyle aynı kalmalı); botlardan sonra, biçimden önce denetlenir
const KVKK_VERSION = '2026-10-01';
if (!is_array($body['consent'] ?? null) || ($body['consent']['kvkk'] ?? '') !== KVKK_VERSION) {
    fail(400, 'Devam etmek için KVKK Aydınlatma Metni’ni okuduğunu onayla.');
}
// Yalın adres biçimi: tırnaklı yerel kısımlar, < > " ve formül başlatan ilk karakterler (= + - @) reddedilir
if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL) || !preg_match('/^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/', $email)) {
    fail(400, 'Geçerli bir e-posta adresi yaz.');
}

function data_dir(): string
{
    $outside = dirname(__DIR__, 2) . '/mivelo-data';
    if (is_dir($outside) || @mkdir($outside, 0700, true)) {
        return $outside;
    }
    // web kökü içine asla düşme (sunucu .htaccess'i yok sayarsa kayıtlar herkese açık olurdu)
    fail(500, 'Kayıt alanı açılamadı');
}

/** Hız sınırı anahtarı: IPv4 tam adres, IPv6 /64 önek */
function client_key(string $ip): string
{
    if (strpos($ip, ':') !== false) {
        $bin = @inet_pton($ip);
        if ($bin !== false && strlen($bin) === 16) {
            return bin2hex(substr($bin, 0, 8)) . '::/64';
        }
    }
    return $ip;
}

$path = data_dir() . '/waitlist.json';
$lh = @fopen($path . '.lock', 'c');
if ($lh === false || !flock($lh, LOCK_EX)) {
    fail(500, 'Kayıt alanı açılamadı');
}
clearstatcache(true, $path);
$data = ['entries' => []];
if (file_exists($path)) {
    $raw = @file_get_contents($path);
    if ($raw === false) {
        fail(500, 'Kayıt alanı okunamadı');
    }
    if (trim($raw) !== '') {
        $data = json_decode($raw, true);
        // bozuk dosya "boş liste" sayılıp üstüne yazılmaz (tüm liste silinirdi)
        if (!is_array($data) || !isset($data['entries']) || !is_array($data['entries'])) {
            fail(500, 'Kayıt alanı geçici olarak kullanılamıyor');
        }
    }
}

$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
$ipKey = client_key($ip);
$codes = array_column($data['entries'], 'code');
$newCode = function () use ($codes) {
    do {
        $code = substr(bin2hex(random_bytes(4)), 0, 6);
    } while (in_array($code, $codes, true));
    return $code;
};
$exists = false;
foreach ($data['entries'] as $e) {
    if (($e['email'] ?? null) === $email) {
        $exists = true;
        break;
    }
}
if ($exists) {
    // yeni kayıttan ayırt edilemeyen yanıt (sıra/kod sızmasın)
    $out = ['position' => count($data['entries']) + 1, 'code' => $newCode()];
} else {
    // Kaba kötüye kullanım sınırı: aynı IP'den (IPv6: aynı /64) son bir saatte en fazla 20 kayıt
    $recent = 0;
    foreach ($data['entries'] as $e) {
        if (client_key((string) ($e['ip'] ?? '')) === $ipKey && ($e['at'] ?? 0) > time() - 3600) {
            $recent++;
        }
    }
    // Günlük toplam sınır (çok IP'den seri kayıt): 2000/gün
    $today = 0;
    $dayStart = strtotime('today');
    for ($k = count($data['entries']) - 1; $k >= 0 && ($data['entries'][$k]['at'] ?? 0) >= $dayStart; $k--) {
        $today++;
    }
    if ($recent >= 20 || $today >= 2000) {
        fail(429, 'Çok fazla deneme, biraz sonra tekrar dene.');
    }
    $code = $newCode();
    if ($ref !== '') {
        foreach ($data['entries'] as &$e) {
            if (($e['code'] ?? null) === $ref) {
                $e['refs'] = (int) ($e['refs'] ?? 0) + 1;
                break;
            }
        }
        unset($e);
    }
    $data['entries'][] = ['email' => $email, 'code' => $code, 'ref' => $ref, 'refs' => 0, 'at' => time(), 'ip' => $ip, 'src' => $src !== '' ? $src : ($ref !== '' ? 'davet' : 'doğrudan'), 'status' => 'waiting', 'consent' => ['kvkk' => KVKK_VERSION, 'at' => gmdate('c')]];
    // önce kodla (hata → dosyaya dokunma), sonra geçici dosya + rename (yarım yazım listeyi bozmaz)
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false) {
        fail(500, 'Kayıt yapılamadı');
    }
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
    $fh = @fopen($tmp, 'x');
    $ok = $fh !== false && fwrite($fh, $json) === strlen($json) && fflush($fh);
    if ($ok && function_exists('fsync')) {
        $ok = fsync($fh);
    }
    if ($fh !== false) {
        fclose($fh);
    }
    if (!$ok || !@rename($tmp, $path)) {
        @unlink($tmp);
        fail(500, 'Kayıt yapılamadı');
    }
    $out = ['position' => count($data['entries']), 'code' => $code];
}
flock($lh, LOCK_UN);
fclose($lh);
echo json_encode($out);
