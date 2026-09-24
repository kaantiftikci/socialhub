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

session_set_cookie_params([
    'lifetime' => 60 * 60 * 24 * 60,
    'path' => '/',
    'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

const PLATFORMS = [
    'whatsapp', 'telegram', 'slack', 'linkedin', 'x', 'imessage', 'instagram', 'messenger',
    'gmail', 'outlook', 'yahoo', 'icloud', 'imap', 'shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify',
];
const STATUSES = ['disconnected', 'connecting', 'pairing', 'connected', 'error'];

/** Demo kullanıcıları (kayıt kapalı). Şifre karmaları bcrypt; users.json'da yoksa ilk istekte eklenir, bağladıkları uygulamalar orada saklanır. */
const SEED_USERS = [
    ['username' => 'admin', 'name' => 'Admin', 'pass' => '$2y$12$1tzNt3O9WIQS14iDfUZKu.0W1pEji2HesBhT3HEw5/7BW8B82x/PS'],
    ['username' => 'editor', 'name' => 'Editör', 'pass' => '$2y$12$D3SKU5xbB5nDTIFmxA82bem7YHqBPD0dzi3KJCLyAEr65l.9j5x/u'],
    ['username' => 'misafir', 'name' => 'Misafir', 'pass' => '$2y$12$q0j8FuH7YcxzBLye9Vxtg.RDgao05rMFlL3B/UIkR0JfPhU02Svk6'],
];
/** Demo kullanıcıları boş başlar; uygulamaları kendileri "Uygulama bağla" ile ekler. Sürüm artınca mevcut listeleri de sıfırlanır. */
const SEED_ACCOUNTS = [];
const SEED_VERSION = 2;

function seed_users(array &$data): bool
{
    $changed = false;
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
            'accounts' => $accounts,
            'seedVersion' => SEED_VERSION,
            'createdAt' => (int) (microtime(true) * 1000),
        ];
        $changed = true;
    }
    return $changed;
}

function fail(int $code, string $message): never
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

/** @param callable(array): array $fn */
function with_users(callable $fn): mixed
{
    $path = data_dir() . '/users.json';
    $fh = fopen($path, 'c+');
    if ($fh === false) {
        fail(500, 'Kayıt alanı açılamadı');
    }
    flock($fh, LOCK_EX);
    $raw = stream_get_contents($fh);
    $data = ($raw !== false && $raw !== '') ? json_decode($raw, true) : ['users' => []];
    if (!is_array($data) || !isset($data['users']) || !is_array($data['users'])) {
        $data = ['users' => []];
    }
    $seeded = seed_users($data);
    $result = $fn($data);
    if (!empty($result['write']) || $seeded) {
        $json = json_encode($data, JSON_UNESCAPED_UNICODE);
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, $json === false ? '{"users":[]}' : $json);
        fflush($fh);
    }
    flock($fh, LOCK_UN);
    fclose($fh);
    return $result['out'] ?? null;
}

function user_public(array $u): array
{
    return ['id' => $u['id'], 'name' => $u['name'], 'username' => $u['username'] ?? $u['email']];
}

function current_user(array $data): ?array
{
    $id = $_SESSION['uid'] ?? '';
    if (!is_string($id) || $id === '') {
        return null;
    }
    foreach ($data['users'] as $u) {
        if (($u['id'] ?? '') === $id) {
            return $u;
        }
    }
    return null;
}

function clean_accounts(mixed $list): array
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

if ($action === 'register') {
    fail(403, 'Kayıt kapalı: bu demo için hazır kullanıcılarla giriş yap');
}

if ($action === 'login' && $method === 'POST') {
    $username = strtolower(trim((string) ($body['username'] ?? $body['email'] ?? '')));
    $password = (string) ($body['password'] ?? '');
    usleep(250000); // kaba kuvvete karşı küçük gecikme
    $user = with_users(function (array &$data) use ($username, $password) {
        foreach ($data['users'] as $u) {
            if (strtolower((string) ($u['username'] ?? $u['email'] ?? '')) === $username && password_verify($password, (string) ($u['pass'] ?? ''))) {
                return ['write' => false, 'out' => $u];
            }
        }
        return ['write' => false, 'out' => null];
    });
    if ($user === null) {
        fail(401, 'Kullanıcı adı veya şifre hatalı');
    }
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
            if (($u['id'] ?? '') === $id) {
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
