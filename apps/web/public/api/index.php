<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    $oh = strtolower((string) parse_url($origin, PHP_URL_HOST));
    if ($oh !== $host) {
        http_response_code(403);
        echo json_encode(['error' => 'İstek reddedildi']);
        exit;
    }
}

// Çerez 60 gün: oturum dosyası da o kadar yaşamalı (varsayılan gc_maxlifetime 24 dk'da "beni hatırla" hiç çalışmıyordu;
// paylaşımlı klasörü barındırıcının temizleyicisi kendi süresine göre siliyordu). Özel klasörde GC'yi PHP yapar.
const SESSION_LIFETIME = 60 * 60 * 24 * 60;
$sessDir = dirname(__DIR__, 2) . '/mivelo-data/sessions-demo';
if (is_dir($sessDir) || @mkdir($sessDir, 0700, true)) {
    session_save_path($sessDir);
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '100');
}
ini_set('session.gc_maxlifetime', (string) SESSION_LIFETIME);
session_set_cookie_params([
    'lifetime' => SESSION_LIFETIME,
    'path' => '/',
    'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

const PLATFORMS = [
    'whatsapp', 'telegram', 'slack', 'linkedin', 'x', 'imessage', 'instagram', 'messenger',
    'gmail', 'outlook', 'yahoo', 'icloud', 'imap', 'shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon',
];
const STATUSES = ['disconnected', 'connecting', 'pairing', 'connected', 'error'];

/**
 * Demo kullanıcıları. Hazır tek hesap: admin. Diğerleri "Üyelik oluştur" ile talep açar (status 'pending'); talep
 * mivelo.app/admin → Demo'da onaylanınca 'active' olur ve kullanıcıya e-posta gider. Şifre karmaları bcrypt.
 * passVersion artınca users.json'daki karma da güncellenir (şifre değişikliği sunucudaki kayda yansısın diye).
 */
const SEED_USERS = [
    ['username' => 'admin', 'name' => 'Admin', 'pass' => '$2y$12$778n9wFmpF66gXSB4xaqau.BTb76mZD8vpYlTEbFVvOSmt36HaNNC', 'passVersion' => 2],
];
/** Artık kullanılmayan hazır hesaplar: users.json'dan silinir */
const REMOVED_USERS = ['editor', 'misafir'];
/** Demo kullanıcıları boş başlar; uygulamaları kendileri "Uygulama bağla" ile ekler. Sürüm artınca mevcut listeleri de sıfırlanır. */
const SEED_ACCOUNTS = [];
const SEED_VERSION = 2;

function seed_users(array &$data): bool
{
    $changed = false;
    $before = count($data['users']);
    $data['users'] = array_values(array_filter($data['users'], fn ($u) => !(in_array($u['username'] ?? '', REMOVED_USERS, true) && strpos((string) ($u['id'] ?? ''), 'u-' . ($u['username'] ?? '')) === 0 && empty($u['requestedAt']))));
    if (count($data['users']) !== $before) {
        $changed = true;
    }
    // Kayıtla gelen üyeler ASLA demo verisi görmez: boş panel özelliğinden önce kaydedilmiş varsayılan uygulamaları sil (bir kez)
    foreach ($data['users'] as &$u) {
        if (!empty($u['requestedAt']) && (int) ($u['dataReset'] ?? 0) < 2) {
            $u['accounts'] = [];
            $u['dataReset'] = 2;
            $changed = true;
        }
    }
    unset($u);
    foreach (SEED_USERS as $i => $su) {
        $found = false;
        foreach ($data['users'] as &$u) {
            if (($u['username'] ?? '') === $su['username']) {
                $found = true;
                if ((int) ($u['seedVersion'] ?? 1) < SEED_VERSION) {
                    $u['accounts'] = [];
                    $u['seedVersion'] = SEED_VERSION;
                    $changed = true;
                }
                if ((int) ($u['passVersion'] ?? 1) < (int) ($su['passVersion'] ?? 1)) {
                    $u['pass'] = $su['pass'];
                    $u['passVersion'] = (int) $su['passVersion'];
                    $changed = true;
                }
                break;
            }
        }
        unset($u);
        if ($found) {
            continue;
        }
        // (aşağıda eklenir)
        $accounts = [];
        foreach (SEED_ACCOUNTS as $j => $platform) {
            $accounts[] = ['id' => $platform . ':demo' . ($i + 1) . $j, 'platform' => $platform, 'label' => '', 'status' => 'connected', 'createdAt' => (int) (microtime(true) * 1000)];
        }
        $data['users'][] = [
            'id' => 'u-' . $su['username'],
            'username' => $su['username'],
            'name' => $su['name'],
            'email' => $su['username'] . '@demo',
            'pass' => $su['pass'],
            'passVersion' => (int) ($su['passVersion'] ?? 1),
            'status' => 'active',
            'accounts' => $accounts,
            'seedVersion' => SEED_VERSION,
            'createdAt' => (int) (microtime(true) * 1000),
        ];
        $changed = true;
    }
    return $changed;
}

function str_ends_with_demo(string $email): bool
{
    return substr($email, -5) === '@demo';
}

/** Hesap durumu: eski kayıtlarda alan yok → etkin */
function user_status(array $u): string
{
    $s = (string) ($u['status'] ?? 'active');
    return in_array($s, ['pending', 'active', 'rejected'], true) ? $s : 'active';
}

/** Yeni üyeler otomatik onaylanır mı (Admin → Demo anahtarı, demo-settings.json). Varsayılan AÇIK: onay e-postası gidemediği sürece
 *  (barındırma giden SMTP'yi kapatıyor) kayıt olan hemen girebilsin; e-posta düzelince admin kapatır → onaylı üyelik. */
function demo_auto_approve(): bool
{
    $s = store_read(data_dir() . '/demo-settings.json', []);
    return !array_key_exists('autoApprove', $s) || (bool) $s['autoApprove'];
}

function fail(int $code, string $message)
{
    http_response_code($code);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function data_dir(): string
{
    $outside = dirname(__DIR__, 2) . '/mivelo-data';
    if (is_dir($outside) || @mkdir($outside, 0700, true)) {
        return $outside;
    }
    // web kökü içine asla düşme (sunucu .htaccess'i yok sayarsa kullanıcı dosyası herkese açık olurdu)
    fail(500, 'Kayıt alanı açılamadı');
}

/**
 * JSON deposu (admin/api.php ile aynı düzen): <dosya>.lock üzerinde özel kilit; boş olmayan ama çözülemeyen dosya
 * "boş" sayılıp üstüne yazılmaz (500); yazım önce kodlanır, geçici dosya + rename ile atomik.
 * @return resource kilit tanıtıcısı
 */
function store_lock(string $path)
{
    $lh = @fopen($path . '.lock', 'c');
    if ($lh === false || !flock($lh, LOCK_EX)) {
        fail(500, 'Kayıt alanı kilitlenemedi');
    }
    return $lh;
}

function store_read(string $path, array $empty): array
{
    clearstatcache(true, $path);
    if (!file_exists($path)) {
        return $empty;
    }
    $raw = @file_get_contents($path);
    if ($raw === false) {
        fail(500, 'Kayıt alanı okunamadı');
    }
    if (trim($raw) === '') {
        return $empty;
    }
    $d = json_decode($raw, true);
    if (!is_array($d)) {
        fail(500, 'Kayıt alanı bozuk');
    }
    return $d;
}

function store_write(string $path, array $data): void
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        fail(500, 'Kayıt kodlanamadı');
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
        fail(500, 'Kayıt yazılamadı');
    }
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

/** @param callable(array): array $fn */
function with_users(callable $fn)
{
    $path = data_dir() . '/users.json';
    $lh = store_lock($path);
    $data = store_read($path, ['users' => []]);
    if (!isset($data['users']) || !is_array($data['users'])) {
        fail(500, 'Kayıt alanı bozuk');
    }
    $seeded = seed_users($data);
    $result = $fn($data);
    if (!empty($result['write']) || $seeded) {
        store_write($path, $data);
    }
    flock($lh, LOCK_UN);
    fclose($lh);
    return $result['out'] ?? null;
}

function user_public(array $u): array
{
    // fresh: üyelik talebiyle gelen kullanıcı → demo boş panelle açılır (varsayılan örnek uygulama/sohbet yok)
    return ['id' => $u['id'], 'name' => $u['name'], 'username' => $u['username'] ?? $u['email'], 'fresh' => !empty($u['requestedAt'])];
}

function current_user(array $data): ?array
{
    $id = $_SESSION['uid'] ?? '';
    if (!is_string($id) || $id === '') {
        return null;
    }
    foreach ($data['users'] as $u) {
        if (($u['id'] ?? '') === $id) {
            return user_status($u) === 'active' ? $u : null;
        }
    }
    return null;
}

function clean_accounts($list): array
{
    if (!is_array($list)) {
        fail(400, 'Uygulama listesi geçersiz');
    }
    if (count($list) > 40) {
        fail(400, 'En fazla 40 uygulama bağlanabilir');
    }
    $out = [];
    foreach ($list as $a) {
        if (!is_array($a)) {
            continue;
        }
        $platform = $a['platform'] ?? '';
        $id = $a['id'] ?? '';
        $status = $a['status'] ?? 'connected';
        $label = trim((string) ($a['label'] ?? ''));
        if (!is_string($platform) || !in_array($platform, PLATFORMS, true)) {
            continue;
        }
        if (!is_string($id) || !preg_match('/^[a-z0-9:_-]{3,80}$/', $id)) {
            continue;
        }
        if (!is_string($status) || !in_array($status, STATUSES, true)) {
            $status = 'connected';
        }
        $label = preg_replace('/\s+/', ' ', $label) ?? '';
        $label = function_exists('mb_substr') ? mb_substr($label, 0, 80) : substr($label, 0, 80);
        if ($label === '') {
            $label = $platform;
        }
        $created = (int) ($a['createdAt'] ?? 0);
        if ($created < 1_000_000_000_000) {
            $created = (int) (microtime(true) * 1000);
        }
        $out[] = [
            'id' => $id,
            'platform' => $platform,
            'label' => $label,
            'status' => $status,
            'createdAt' => $created,
        ];
    }
    return $out;
}

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body = [];
if ($method === 'POST' || $method === 'PUT') {
    $decoded = json_decode(file_get_contents('php://input') ?: '', true);
    $body = is_array($decoded) ? $decoded : [];
}

if ($action === 'signup_config' && $method === 'GET') {
    echo json_encode(['autoApprove' => demo_auto_approve()]);
    exit;
}

/**
 * Üyelik talebi (otomatik onay açıksa hemen etkin üye): onay bekleyen kullanıcı olarak kaydedilir (giriş yapamaz). IP (/64) başına saatte 5, toplam en çok 300
 * bekleyen talep; gizli "website" alanı bot tuzağı (doluysa sessizce başarılı görünür, kaydedilmez).
 */
if ($action === 'register' && $method === 'POST') {
    $clean = fn ($v) => trim(preg_replace('/\s+/u', ' ', (string) $v) ?? '');
    $firstName = $clean($body['firstName'] ?? '');
    $lastName = $clean($body['lastName'] ?? '');
    $name = $firstName !== '' || $lastName !== '' ? trim("$firstName $lastName") : $clean($body['name'] ?? '');
    $username = strtolower(trim((string) ($body['username'] ?? '')));
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    $password = (string) ($body['password'] ?? '');
    $note = trim(preg_replace('/\s+/u', ' ', (string) ($body['note'] ?? '')) ?? '');
    if (trim((string) ($body['website'] ?? '')) !== '') {
        echo json_encode(['ok' => true, 'pending' => true]);
        exit;
    }
    $len = fn (string $x) => function_exists('mb_strlen') ? mb_strlen($x) : strlen($x);
    if ($len($name) < 2 || $len($name) > 81 || (isset($body['firstName']) && ($firstName === '' || $lastName === '' || $len($firstName) > 40 || $len($lastName) > 40))) {
        fail(400, 'Adını ve soyadını yaz');
    }
    if (!preg_match('/^[a-z0-9._-]{3,24}$/', $username)) {
        fail(400, 'Kullanıcı adı 3-24 karakter olmalı; yalnız küçük harf, rakam, nokta, tire ve alt çizgi');
    }
    if (in_array($username, ['admin', 'root', 'mivelo', 'editor', 'misafir', 'destek', 'support'], true)) {
        fail(409, 'Bu kullanıcı adı alınmış; başka bir tane dene');
    }
    if (strlen($email) > 120 || !filter_var($email, FILTER_VALIDATE_EMAIL) || !preg_match('/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i', $email)) {
        fail(400, 'Geçerli bir e-posta adresi yaz');
    }
    if (strlen($password) < 8 || strlen($password) > 200) {
        fail(400, 'Şifre en az 8 karakter olmalı');
    }
    $note = function_exists('mb_substr') ? mb_substr($note, 0, 300) : substr($note, 0, 300);
    // hız sınırı (demo-signup.json)
    $sgFile = data_dir() . '/demo-signup.json';
    $ipKey = client_key((string) ($_SERVER['REMOTE_ADDR'] ?? ''));
    $now = time();
    $slh = store_lock($sgFile);
    $sg = store_read($sgFile, []);
    foreach ($sg as $k => $v) {
        $sg[$k] = array_values(array_filter(is_array($v) ? $v : [], fn ($t) => (int) $t > $now - 3600));
        if (!$sg[$k]) {
            unset($sg[$k]);
        }
    }
    if (count($sg[$ipKey] ?? []) >= 5) {
        fail(429, 'Çok fazla talep gönderildi. Bir saat sonra tekrar dene.');
    }
    $sg[$ipKey][] = $now;
    store_write($sgFile, $sg);
    flock($slh, LOCK_UN);
    fclose($slh);
    $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
    $auto = demo_auto_approve();
    $err = with_users(function (array &$data) use ($name, $firstName, $lastName, $username, $email, $hash, $note, $auto) {
        $pending = 0;
        foreach ($data['users'] as $u) {
            if (strtolower((string) ($u['username'] ?? '')) === $username) {
                return ['write' => false, 'out' => 'Bu kullanıcı adı alınmış; başka bir tane dene'];
            }
            if (strtolower((string) ($u['email'] ?? '')) === $email) {
                return ['write' => false, 'out' => user_status($u) === 'pending' ? 'Bu e-postayla bir talep zaten onay bekliyor' : 'Bu e-postayla bir üyelik zaten var'];
            }
            if (user_status($u) === 'pending') {
                $pending++;
            }
        }
        if ($pending >= 300) {
            return ['write' => false, 'out' => 'Şu an çok fazla bekleyen talep var; daha sonra tekrar dene'];
        }
        $data['users'][] = [
            'id' => 'u-' . bin2hex(random_bytes(6)),
            'username' => $username,
            'name' => $name,
            'firstName' => $firstName,
            'lastName' => $lastName,
            'email' => $email,
            'pass' => $hash,
            'status' => $auto ? 'active' : 'pending',
            'note' => $note,
            'accounts' => [],
            'seedVersion' => SEED_VERSION,
            'requestedAt' => time(),
            'createdAt' => (int) (microtime(true) * 1000),
        ] + ($auto ? ['approvedAt' => time(), 'approvedBy' => 'auto'] : []);
        return ['write' => true, 'out' => null];
    });
    if ($err !== null) {
        fail(409, $err);
    }
    echo json_encode(['ok' => true, 'pending' => !$auto]);
    exit;
}

if ($action === 'login' && $method === 'POST') {
    $username = strtolower(trim((string) ($body['username'] ?? $body['email'] ?? '')));
    $password = (string) ($body['password'] ?? '');
    // IP (IPv6: /64) başına kilit: 8 denemede 10 dakika (demo-auth.json, kayıt alanında). Deneme, şifre doğrulanmadan
    // ÖNCE aynı kilitli bölümde sayılır: paralel istekler sınırı aşamaz; başarılı girişte sayaç silinir.
    $authFile = data_dir() . '/demo-auth.json';
    $ipKey = client_key((string) ($_SERVER['REMOTE_ADDR'] ?? ''));
    $now = time();
    $alh = store_lock($authFile);
    $auth = store_read($authFile, []);
    foreach ($auth as $k => $v) {
        if (!is_array($v) || ((int) ($v['last'] ?? 0) < $now - 3600 && (int) ($v['until'] ?? 0) < $now)) {
            unset($auth[$k]);
        }
    }
    if ((int) ($auth[$ipKey]['until'] ?? 0) > $now) {
        fail(429, 'Çok fazla hatalı deneme. Birkaç dakika sonra tekrar dene.');
    }
    $f = (int) ($auth[$ipKey]['fails'] ?? 0) + 1;
    $auth[$ipKey] = ['fails' => $f >= 8 ? 0 : $f, 'last' => $now, 'until' => $f >= 8 ? $now + 600 : 0];
    store_write($authFile, $auth);
    flock($alh, LOCK_UN);
    fclose($alh);
    usleep(250000); // kaba kuvvete karşı küçük gecikme
    $auto = demo_auto_approve();
    $user = with_users(function (array &$data) use ($username, $password, $auto) {
        foreach ($data['users'] as &$u) {
            if ((strtolower((string) ($u['username'] ?? '')) === $username || strtolower((string) ($u['email'] ?? '')) === $username) && password_verify($password, (string) ($u['pass'] ?? ''))) {
                // otomatik onay açıkken bekleyen talep ilk girişte onaylanır (reddedilen asla)
                if ($auto && user_status($u) === 'pending') {
                    $u['status'] = 'active';
                    $u['approvedAt'] = time();
                    $u['approvedBy'] = 'auto';
                }
                // şifre doğru ama üyelik onaylanmamış: durumu söyle (şifre doğrulandıktan sonra → kullanıcı adı taraması olmaz)
                if (user_status($u) !== 'active') {
                    return ['write' => false, 'out' => ['__status' => user_status($u)]];
                }
                // admin paneli (mivelo.app/admin → Demo) için giriş sayısı ve son giriş
                $u['logins'] = (int) ($u['logins'] ?? 0) + 1;
                $u['lastLogin'] = time();
                return ['write' => true, 'out' => $u];
            }
        }
        unset($u);
        return ['write' => false, 'out' => null];
    });
    if ($user === null) {
        fail(401, 'Kullanıcı adı veya şifre hatalı');
    }
    if (isset($user['__status'])) {
        fail(403, $user['__status'] === 'pending' ? 'Üyelik talebin henüz onaylanmadı. Onaylanınca e-posta ile haber vereceğiz.' : 'Üyelik talebin onaylanmadı.');
    }
    $alh = store_lock($authFile);
    $auth = store_read($authFile, []);
    if (isset($auth[$ipKey])) {
        unset($auth[$ipKey]);
        store_write($authFile, $auth);
    }
    flock($alh, LOCK_UN);
    fclose($alh);
    session_regenerate_id(true);
    $_SESSION['uid'] = $user['id'];
    echo json_encode(['user' => user_public($user)], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($action === 'logout' && $method === 'POST') {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], (bool) $p['secure'], (bool) $p['httponly']);
    }
    session_destroy();
    echo json_encode(['ok' => true]);
    exit;
}

if ($action === 'me' && $method === 'GET') {
    $user = with_users(function (array &$data) {
        return ['write' => false, 'out' => current_user($data)];
    });
    if ($user === null) {
        fail(401, 'Giriş gerekli');
    }
    echo json_encode(['user' => user_public($user)], JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Sunucu çekirdeği (gerçek bağlantılar): Admin → Demo → "Sunucu çekirdeği" açıksa oturumdaki üyeye, ağ geçidinin (core.mivelo.app)
 * doğrulayacağı imzalı kısa belirteç verilir: base64url({"u":uid,"e":bitiş}) + "." + base64url(HMAC-SHA256(gizli, yük)).
 * Gizli anahtar web kökü dışında ~/mivelo-data/core-secret (0600); ağ geçidindeki CORE_SECRET ile aynı. Kapalıysa {core:null}.
 */
if ($action === 'core_token' && $method === 'GET') {
    $me = with_users(function (array &$data) {
        return ['write' => false, 'out' => current_user($data)];
    });
    if ($me === null) {
        fail(401, 'Giriş gerekli');
    }
    $s = store_read(data_dir() . '/demo-settings.json', []);
    $url = rtrim((string) ($s['coreUrl'] ?? ''), '/');
    $secretFile = data_dir() . '/core-secret';
    $secret = is_file($secretFile) ? trim((string) @file_get_contents($secretFile)) : '';
    if (empty($s['coreEnabled']) || !preg_match('#^https://[a-z0-9.-]+(:\d+)?$#i', $url) || strlen($secret) < 32) {
        echo json_encode(['core' => null]);
        exit;
    }
    $uid = (string) $me['id'];
    // hazır "admin" hesabı vitrin (örnek veri) olarak kalır; üyeler gerçek çekirdeğe bağlanır
    if ($uid === 'u-admin' || !preg_match('/^u-[a-z0-9-]{3,40}$/', $uid)) {
        echo json_encode(['core' => null]);
        exit;
    }
    $b64 = fn (string $x) => rtrim(strtr(base64_encode($x), '+/', '-_'), '=');
    $payload = $b64(json_encode(['u' => $uid, 'e' => time() + 30 * 86400]));
    $token = $payload . '.' . $b64(hash_hmac('sha256', $payload, $secret, true));
    echo json_encode(['core' => $url, 'token' => $token]);
    exit;
}

/**
 * Geri bildirim (uygulamadaki sağ alt düğme): üye kimliği OTURUMDAN yazılır (istemcinin gönderdiği ad/e-posta yok sayılır).
 * Kayıt mantığı mivelo.app ile ortak lib-feedback.php (yayında demo klasörüne de kopyalanır).
 */
if ($action === 'feedback' && $method === 'POST') {
    $me = with_users(function (array &$data) {
        return ['write' => false, 'out' => current_user($data)];
    });
    if ($me === null) {
        fail(401, 'Giriş gerekli');
    }
    foreach (['lib-smtp.php', 'lib-feedback.php'] as $lib) {
        $p = is_file(__DIR__ . '/' . $lib) ? __DIR__ . '/' . $lib : dirname(__DIR__, 2) . '/mivelo.app/api/' . $lib;
        if (!is_file($p)) {
            fail(500, 'Geri bildirim şu an alınamıyor');
        }
        require_once $p;
    }
    $id = mv_feedback_store('demo', [
        'userId' => (string) $me['id'],
        'user' => (string) ($me['username'] ?? ''),
        'name' => (string) ($me['name'] ?? ''),
        'email' => str_ends_with_demo((string) ($me['email'] ?? '')) ? '' : (string) ($me['email'] ?? ''),
    ]);
    echo json_encode(['ok' => true, 'id' => $id]);
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }
    mv_feedback_notify($id);
    exit;
}

if ($action === 'accounts' && $method === 'GET') {
    $user = with_users(function (array &$data) {
        return ['write' => false, 'out' => current_user($data)];
    });
    if ($user === null) {
        fail(401, 'Giriş gerekli');
    }
    echo json_encode(['accounts' => $user['accounts'] ?? []], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($action === 'accounts' && $method === 'PUT') {
    $clean = clean_accounts($body['accounts'] ?? null);
    $saved = with_users(function (array &$data) use ($clean) {
        $id = $_SESSION['uid'] ?? '';
        foreach ($data['users'] as &$u) {
            // yalnız etkin üye yazabilir (reddedilen/bekleyen hesabın eski oturumu yazamaz)
            if (($u['id'] ?? '') === $id && is_string($id) && $id !== '' && user_status($u) === 'active') {
                $u['accounts'] = $clean;
                return ['write' => true, 'out' => $clean];
            }
        }
        return ['write' => false, 'out' => null];
    });
    if ($saved === null) {
        fail(401, 'Giriş gerekli');
    }
    echo json_encode(['accounts' => $saved], JSON_UNESCAPED_UNICODE);
    exit;
}

fail(404, 'Bilinmeyen istek');
