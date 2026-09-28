<?php
declare(strict_types=1);

/**
 * Masaüstü uygulaması lisans servisi (mivelo.app/api/license.php). Anahtarları yönetim paneli üretir (Admin → Lisanslar);
 * kayıtlar web kökü dışında ~/mivelo-data/licenses.json (admin/api.php ile aynı kilit + atomik yazım düzeni).
 *
 * POST JSON {action, …} — çağıran Mivelo çekirdeği (Node, Origin yok):
 *   activate {key, device, name, os, version} → {ok, activation, expiresAt, owner?}   (aynı cihaz yeniden etkinleştirirse aynı kayıt)
 *   check    {key, activation, device}         → {ok, expiresAt, owner?}               (uygulama 12 saatte bir; iptal/süre sonu burada anlaşılır)
 *   owner {name?, email?}: anahtarın e-postası (Admin → Lisanslar) + o e-postanın üye kaydındaki ad soyad → uygulamada profil adı.
 *   Yalnız anahtarı bilen (80 bit) cihaza döner.
 *   release  {key, activation}                 → {ok}                          (uygulamada "Lisansı kaldır": cihaz yeri boşalır)
 * Hata: {error, invalid?:true}. invalid = anahtar/etkinleştirme artık geçersiz (uygulama kilitlenir); ağ/sunucu hatasında
 * uygulama çevrimdışı payını (14 gün) kullanır. Hatalı anahtar denemeleri IP başına saatte 20 ile sınırlı.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function out(array $v)
{
    echo json_encode($v, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(int $code, string $msg, bool $invalid = false)
{
    http_response_code($code);
    out($invalid ? ['error' => $msg, 'invalid' => true] : ['error' => $msg]);
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if ($origin !== '' && strtolower((string) parse_url($origin, PHP_URL_HOST)) !== $host) {
    fail(403, 'İstek reddedildi');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'Yalnızca POST');
}
$body = json_decode((string) file_get_contents('php://input', false, null, 0, 8192), true);
if (!is_array($body)) {
    fail(400, 'Geçersiz istek');
}

function data_dir(): string
{
    $d = dirname(__DIR__, 2) . '/mivelo-data';
    if (!is_dir($d) && !@mkdir($d, 0700, true)) {
        fail(500, 'Veri klasörü açılamadı');
    }
    return $d;
}

/** Kilitli oku-değiştir-yaz (admin/api.php with_json ile aynı sözleşme; bozuk dosya asla boş sayılmaz) */
function with_store(string $name, array $empty, callable $fn)
{
    $path = data_dir() . '/' . $name;
    $lh = @fopen($path . '.lock', 'c');
    if ($lh === false || !flock($lh, LOCK_EX)) {
        fail(500, 'Kayıt kilitlenemedi');
    }
    clearstatcache(true, $path);
    $data = $empty;
    if (file_exists($path)) {
        $raw = @file_get_contents($path);
        if ($raw === false) {
            fail(500, 'Kayıt okunamadı');
        }
        if (trim($raw) !== '') {
            $data = json_decode($raw, true);
            if (!is_array($data)) {
                fail(500, 'Kayıt bozuk');
            }
        }
    }
    $before = $data;
    $res = $fn($data);
    if ($data !== $before) {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
        if ($json === false) {
            fail(500, 'Kayıt kodlanamadı');
        }
        $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, $json) !== strlen($json) || !@rename($tmp, $path)) {
            @unlink($tmp);
            fail(500, 'Kayıt yazılamadı');
        }
        @chmod($path, 0600);
    }
    flock($lh, LOCK_UN);
    fclose($lh);
    return $res;
}

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

/** Hatalı anahtar denemesi sayacı (saatlik pencere); sınır aşılmışsa 429 */
function rate_guard(bool $count): void
{
    $ip = hash('sha256', client_key($_SERVER['REMOTE_ADDR'] ?? ''));
    $now = time();
    $over = with_store('license-rate.json', [], function (array &$d) use ($ip, $now, $count) {
        foreach ($d as $k => $v) {
            if (($v['t'] ?? 0) < $now - 3600) {
                unset($d[$k]);
            }
        }
        if ($count) {
            $d[$ip] = ['t' => $d[$ip]['t'] ?? $now, 'n' => ($d[$ip]['n'] ?? 0) + 1];
        }
        return ($d[$ip]['n'] ?? 0) > 20;
    });
    if ($over) {
        fail(429, 'Çok fazla hatalı deneme; bir saat sonra yeniden dene');
    }
}

$norm = fn ($k) => strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string) $k));
$key = $norm($body['key'] ?? '');
$action = (string) ($body['action'] ?? '');
$device = substr(preg_replace('/[^a-f0-9]/', '', strtolower((string) ($body['device'] ?? ''))), 0, 64);
$activation = substr(preg_replace('/[^a-f0-9]/', '', strtolower((string) ($body['activation'] ?? ''))), 0, 64);
$clip = fn ($v, $n) => mb_substr(trim(preg_replace('/[\x00-\x1f]/u', '', (string) $v)), 0, $n);

if ($key === '' || strlen($key) > 40) {
    fail(400, 'Lisans anahtarı gerekli');
}
rate_guard(false);

$ownerEmail = '';
$res = with_store('licenses.json', ['keys' => []], function (array &$d) use ($key, $norm, $action, $device, $activation, $body, $clip, &$ownerEmail) {
    $now = time();
    foreach ($d['keys'] as &$k) {
        if ($norm($k['key'] ?? '') !== $key) {
            continue;
        }
        $ownerEmail = strtolower(trim((string) (($k['email'] ?? '') !== '' ? $k['email'] : ($k['sentTo'] ?? ''))));
        if (($k['status'] ?? 'active') !== 'active') {
            return ['code' => 403, 'error' => 'Bu lisans anahtarı iptal edilmiş', 'invalid' => true];
        }
        if (!empty($k['expiresAt']) && strtotime((string) $k['expiresAt']) < $now) {
            return ['code' => 403, 'error' => 'Bu lisansın süresi dolmuş', 'invalid' => true];
        }
        $k['activations'] = $k['activations'] ?? [];
        if ($action === 'activate') {
            if (strlen($device) < 16) {
                return ['code' => 400, 'error' => 'Cihaz kimliği eksik'];
            }
            foreach ($k['activations'] as &$a) {
                if (($a['device'] ?? '') === $device) {
                    $a['lastAt'] = gmdate('c');
                    $a['version'] = $clip($body['version'] ?? '', 20);
                    return ['ok' => true, 'activation' => $a['id'], 'expiresAt' => $k['expiresAt'] ?? null];
                }
            }
            unset($a);
            $max = max(1, (int) ($k['maxDevices'] ?? 2));
            if (count($k['activations']) >= $max) {
                return ['code' => 409, 'error' => "Bu anahtar en fazla $max cihazda kullanılabilir; başka cihazdan kaldırıp yeniden dene ya da hello@mivelo.app'e yaz"];
            }
            $id = bin2hex(random_bytes(16));
            $k['activations'][] = ['id' => $id, 'device' => $device, 'name' => $clip($body['name'] ?? '', 60), 'os' => $clip($body['os'] ?? '', 30),
                'version' => $clip($body['version'] ?? '', 20), 'firstAt' => gmdate('c'), 'lastAt' => gmdate('c')];
            $k['usedAt'] = $k['usedAt'] ?? gmdate('c');
            return ['ok' => true, 'activation' => $id, 'expiresAt' => $k['expiresAt'] ?? null];
        }
        if ($action === 'check' || $action === 'release') {
            foreach ($k['activations'] as $i => &$a) {
                if (($a['id'] ?? '') !== $activation || $activation === '') {
                    continue;
                }
                if ($action === 'release') {
                    array_splice($k['activations'], $i, 1);
                    return ['ok' => true];
                }
                if (($a['device'] ?? '') !== $device) {
                    return ['code' => 403, 'error' => 'Lisans bu cihaza ait değil', 'invalid' => true];
                }
                // her denetimde yazmamak için: son görülme en çok saatte bir güncellenir
                if (strtotime((string) ($a['lastAt'] ?? '')) < $now - 3600) {
                    $a['lastAt'] = gmdate('c');
                    $a['version'] = $clip($body['version'] ?? ($a['version'] ?? ''), 20);
                }
                return ['ok' => true, 'expiresAt' => $k['expiresAt'] ?? null];
            }
            unset($a);
            return $action === 'release' ? ['ok' => true] : ['code' => 403, 'error' => 'Bu cihazın lisansı kaldırılmış', 'invalid' => true];
        }
        return ['code' => 400, 'error' => 'Bilinmeyen işlem'];
    }
    unset($k);
    return ['code' => 404, 'error' => 'Lisans anahtarı geçersiz', 'invalid' => true, 'unknown' => true];
});

if (!empty($res['unknown'])) {
    rate_guard(true);
}
if (isset($res['code'])) {
    fail((int) $res['code'], (string) $res['error'], !empty($res['invalid']));
}
// Lisans sahibi: uygulamada profil adı (eskiden her kurulumda sabit bir ad görünüyordu)
if (!empty($res['ok']) && $action !== 'release' && filter_var($ownerEmail, FILTER_VALIDATE_EMAIL)) {
    $owner = ['email' => $ownerEmail];
    try {
        require_once __DIR__ . '/lib-members.php';
        foreach (mv_members_read() as $m) {
            if (strtolower(trim((string) ($m['email'] ?? ''))) === $ownerEmail) {
                $nm = trim(mv_member_name($m['firstName'] ?? '') . ' ' . mv_member_name($m['lastName'] ?? ''));
                if ($nm === '') {
                    $nm = mv_member_name($m['name'] ?? '');
                }
                if ($nm !== '') {
                    $owner['name'] = $nm;
                }
                break;
            }
        }
    } catch (Throwable $e) {
        // üye kaydı okunamadı: yalnız e-posta
    }
    $res['owner'] = $owner;
}
out($res);
