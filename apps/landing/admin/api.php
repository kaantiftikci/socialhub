<?php
declare(strict_types=1);

/**
 * Mivelo yönetim paneli API'si (mivelo.app/admin). Tüm veriler web kökünün dışında ~/mivelo-data:
 *   waitlist.json (bekleme listesi), stats/YYYY-MM.json (ziyaret sayacı), users.json (demo hesapları),
 *   admin.json (şifre değiştirildiyse karması + görevler), admin-auth.json (hatalı giriş sayaçları).
 * Oturum: ayrı çerez (mvadmin, yol /admin, HttpOnly, SameSite=Strict), 12 saat boşta kalınca düşer.
 * Yazan her istek X-CSRF başlığı ister; 5 hatalı girişte IP 15 dakika kilitlenir.
 */

// Varsayılan şifrenin bcrypt karması (şifre koda yazılmaz; panelden değiştirilince admin.json'daki karma geçerli olur)
const DEFAULT_HASH = '$2y$12$RMRxM3ZcJ3.SI.MuYUail.aDr4/jJwL4o8FbSRhp9FJMrcyMHDsRG';
const IDLE = 12 * 3600;
const STATUSES = ['waiting', 'invited', 'joined', 'spam'];

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: same-origin');

function out(mixed $v): never
{
    echo json_encode($v, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(int $code, string $msg): never
{
    http_response_code($code);
    out(['error' => $msg]);
}

$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && strtolower((string) parse_url($origin, PHP_URL_HOST)) !== $host) {
    fail(403, 'İstek reddedildi');
}

$secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
session_name('mvadmin');
session_set_cookie_params(['lifetime' => 0, 'path' => '/admin', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Strict']);
session_start();

function data_dir(): string
{
    $d = dirname(__DIR__, 2) . '/mivelo-data';
    if (!is_dir($d) && !@mkdir($d, 0700, true)) {
        fail(500, 'Veri klasörü açılamadı');
    }
    return $d;
}

/** JSON dosyasını kilitli oku-değiştir-yaz. $fn(array &$data): mixed; $fn false dönerse yazılmaz. */
function with_json(string $name, array $empty, callable $fn): mixed
{
    $fh = fopen(data_dir() . '/' . $name, 'c+');
    if ($fh === false) {
        fail(500, 'Dosya açılamadı');
    }
    flock($fh, LOCK_EX);
    $raw = stream_get_contents($fh);
    $data = ($raw !== false && $raw !== '') ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        $data = $empty;
    }
    $before = $data;
    $res = $fn($data);
    if ($data !== $before) {
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, (string) json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        fflush($fh);
    }
    flock($fh, LOCK_UN);
    fclose($fh);
    return $res;
}

function read_json(string $name, array $empty): array
{
    $p = data_dir() . '/' . $name;
    if (!is_file($p)) {
        return $empty;
    }
    $d = json_decode((string) file_get_contents($p), true);
    return is_array($d) ? $d : $empty;
}

function admin_hash(): string
{
    $a = read_json('admin.json', []);
    return is_string($a['hash'] ?? null) && $a['hash'] !== '' ? $a['hash'] : DEFAULT_HASH;
}

function authed(): bool
{
    if (empty($_SESSION['admin']) || (int) ($_SESSION['seen'] ?? 0) < time() - IDLE) {
        return false;
    }
    $_SESSION['seen'] = time();
    return true;
}

function mask_ip(string $ip): string
{
    if (str_contains($ip, ':')) {
        $p = explode(':', $ip);
        return implode(':', array_slice($p, 0, 3)) . ':…';
    }
    $p = explode('.', $ip);
    return count($p) === 4 ? "$p[0].$p[1].$p[2].x" : '';
}

$a = (string) ($_GET['a'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body = [];
if ($method === 'POST') {
    $body = json_decode((string) file_get_contents('php://input', false, null, 0, 65536), true);
    $body = is_array($body) ? $body : [];
}
$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');

/* ---------------- oturum ---------------- */
if ($a === 'me') {
    out(['authed' => authed(), 'csrf' => authed() ? $_SESSION['csrf'] : null]);
}

if ($a === 'login' && $method === 'POST') {
    $now = time();
    $lock = with_json('admin-auth.json', ['ips' => []], function (array &$d) use ($ip, $now) {
        foreach ($d['ips'] as $k => $v) {
            if (($v['until'] ?? 0) < $now && ($v['last'] ?? 0) < $now - 3600) {
                unset($d['ips'][$k]);
            }
        }
        return (int) ($d['ips'][$ip]['until'] ?? 0);
    });
    if ($lock > $now) {
        fail(429, 'Çok fazla hatalı deneme. ' . (int) ceil(($lock - $now) / 60) . ' dakika sonra tekrar dene.');
    }
    usleep(300000);
    if (!password_verify((string) ($body['password'] ?? ''), admin_hash())) {
        with_json('admin-auth.json', ['ips' => []], function (array &$d) use ($ip, $now) {
            $f = (int) ($d['ips'][$ip]['fails'] ?? 0) + 1;
            $d['ips'][$ip] = ['fails' => $f >= 5 ? 0 : $f, 'last' => $now, 'until' => $f >= 5 ? $now + 900 : 0];
        });
        fail(401, 'Şifre hatalı');
    }
    with_json('admin-auth.json', ['ips' => []], function (array &$d) use ($ip) {
        unset($d['ips'][$ip]);
    });
    session_regenerate_id(true);
    $_SESSION['admin'] = true;
    $_SESSION['seen'] = time();
    $_SESSION['csrf'] = bin2hex(random_bytes(16));
    out(['authed' => true, 'csrf' => $_SESSION['csrf']]);
}

if (!authed()) {
    fail(401, 'Giriş gerekli');
}
if ($method === 'POST' && !hash_equals((string) $_SESSION['csrf'], (string) ($_SERVER['HTTP_X_CSRF'] ?? ''))) {
    fail(403, 'Oturum doğrulanamadı; sayfayı yenile');
}

if ($a === 'logout' && $method === 'POST') {
    $_SESSION = [];
    setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => '/admin', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Strict']);
    session_destroy();
    out(['ok' => true]);
}

/* ---------------- veriler ---------------- */
function entries(): array
{
    $e = read_json('waitlist.json', ['entries' => []])['entries'] ?? [];
    return is_array($e) ? $e : [];
}

/** Son $n ayın günlük ziyaret kayıtları: ['2026-09-26' => [...]] */
function stat_days(int $months = 3): array
{
    $out = [];
    for ($i = $months - 1; $i >= 0; $i--) {
        $m = date('Y-m', strtotime(date('Y-m-01') . " -$i month"));
        $d = read_json("stats/$m.json", ['days' => []])['days'] ?? [];
        foreach ($d as $day => $v) {
            unset($v['ids']);
            $out[$day] = $v;
        }
    }
    return $out;
}

function add_counts(array &$into, array $from): void
{
    foreach ($from as $k => $n) {
        $into[$k] = ($into[$k] ?? 0) + (int) $n;
    }
}

if ($a === 'overview' || $a === 'traffic') {
    $days = max(7, min(90, (int) ($_GET['days'] ?? 30)));
    $es = entries();
    $st = stat_days(4);
    $series = [];
    $src = [];
    $dev = [];
    $page = [];
    $signSrc = [];
    $tot = ['views' => 0, 'uniques' => 0, 'signups' => 0];
    $byDay = [];
    foreach ($es as $e) {
        $byDay[date('Y-m-d', (int) ($e['at'] ?? 0))][] = $e;
    }
    for ($i = $days - 1; $i >= 0; $i--) {
        $day = date('Y-m-d', strtotime("-$i day"));
        $s = $st[$day] ?? [];
        $sg = count($byDay[$day] ?? []);
        $series[] = ['day' => $day, 'views' => (int) ($s['v'] ?? 0), 'uniques' => (int) ($s['u'] ?? 0), 'signups' => $sg];
        $tot['views'] += (int) ($s['v'] ?? 0);
        $tot['uniques'] += (int) ($s['u'] ?? 0);
        $tot['signups'] += $sg;
        add_counts($src, $s['src'] ?? []);
        add_counts($dev, $s['dev'] ?? []);
        add_counts($page, $s['page'] ?? []);
        foreach ($byDay[$day] ?? [] as $e) {
            $k = (string) ($e['src'] ?? 'doğrudan');
            $signSrc[$k] = ($signSrc[$k] ?? 0) + 1;
        }
    }
    arsort($src);
    arsort($dev);
    arsort($page);
    arsort($signSrc);
    $today = date('Y-m-d');
    $status = array_fill_keys(STATUSES, 0);
    $refTop = [];
    foreach ($es as $e) {
        $status[$e['status'] ?? 'waiting'] = ($status[$e['status'] ?? 'waiting'] ?? 0) + 1;
        if ((int) ($e['refs'] ?? 0) > 0) {
            $refTop[] = ['email' => $e['email'], 'refs' => (int) $e['refs']];
        }
    }
    usort($refTop, fn ($x, $y) => $y['refs'] <=> $x['refs']);
    $users = read_json('users.json', ['users' => []])['users'] ?? [];
    $recent = array_slice(array_reverse($es), 0, 6);
    out([
        'days' => $days,
        'series' => $series,
        'totals' => $tot + [
            'waitlist' => count($es),
            'today' => count($byDay[$today] ?? []),
            'week' => count(array_filter($es, fn ($e) => (int) ($e['at'] ?? 0) >= strtotime('-7 day'))),
            'viewsToday' => (int) ($st[$today]['v'] ?? 0),
            'uniquesToday' => (int) ($st[$today]['u'] ?? 0),
            'demoLogins' => array_sum(array_map(fn ($u) => (int) ($u['logins'] ?? 0), $users)),
        ],
        'status' => $status,
        'sources' => $src,
        'signupSources' => $signSrc,
        'devices' => $dev,
        'pages' => array_slice($page, 0, 8, true),
        'referrers' => array_slice($refTop, 0, 8),
        'recent' => array_map(fn ($e) => ['email' => $e['email'], 'at' => (int) $e['at'], 'src' => $e['src'] ?? 'doğrudan'], $recent),
    ]);
}

if ($a === 'waitlist') {
    $es = entries();
    $out = [];
    foreach ($es as $i => $e) {
        $out[] = [
            'pos' => $i + 1,
            'email' => $e['email'],
            'at' => (int) ($e['at'] ?? 0),
            'code' => $e['code'] ?? '',
            'ref' => $e['ref'] ?? '',
            'refs' => (int) ($e['refs'] ?? 0),
            'src' => $e['src'] ?? 'doğrudan',
            'status' => $e['status'] ?? 'waiting',
            'note' => $e['note'] ?? '',
            'invitedAt' => (int) ($e['invitedAt'] ?? 0),
            'ip' => mask_ip((string) ($e['ip'] ?? '')),
        ];
    }
    out(['entries' => $out]);
}

if ($a === 'csv') {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="mivelo-bekleme-listesi-' . date('Y-m-d') . '.csv"');
    $f = fopen('php://output', 'w');
    fwrite($f, "\xEF\xBB\xBF"); // Excel için UTF-8 BOM
    fputcsv($f, ['Sıra', 'E-posta', 'Kayıt', 'Kaynak', 'Durum', 'Davet kodu', 'Davet eden', 'Getirdiği', 'Not'], ';');
    $tr = ['waiting' => 'Bekliyor', 'invited' => 'Davet edildi', 'joined' => 'Katıldı', 'spam' => 'Spam'];
    foreach (entries() as $i => $e) {
        fputcsv($f, [$i + 1, $e['email'], date('Y-m-d H:i', (int) $e['at']), $e['src'] ?? '', $tr[$e['status'] ?? 'waiting'] ?? '', $e['code'] ?? '', $e['ref'] ?? '', (int) ($e['refs'] ?? 0), $e['note'] ?? ''], ';');
    }
    exit;
}

if ($a === 'wl_update' && $method === 'POST') {
    $emails = array_values(array_filter(array_map('strval', (array) ($body['emails'] ?? [$body['email'] ?? '']))));
    $status = isset($body['status']) ? (string) $body['status'] : null;
    $note = isset($body['note']) ? mb_substr((string) $body['note'], 0, 500) : null;
    if ($status !== null && !in_array($status, STATUSES, true)) {
        fail(400, 'Geçersiz durum');
    }
    $n = with_json('waitlist.json', ['entries' => []], function (array &$d) use ($emails, $status, $note) {
        $n = 0;
        foreach ($d['entries'] as &$e) {
            if (!in_array($e['email'], $emails, true)) {
                continue;
            }
            if ($status !== null) {
                if ($status === 'invited' && ($e['status'] ?? 'waiting') !== 'invited') {
                    $e['invitedAt'] = time();
                }
                $e['status'] = $status;
            }
            if ($note !== null) {
                $e['note'] = $note;
            }
            $n++;
        }
        unset($e);
        return $n;
    });
    out(['updated' => $n]);
}

if ($a === 'wl_delete' && $method === 'POST') {
    $emails = array_map('strval', (array) ($body['emails'] ?? []));
    $n = with_json('waitlist.json', ['entries' => []], function (array &$d) use ($emails) {
        $before = count($d['entries']);
        $d['entries'] = array_values(array_filter($d['entries'], fn ($e) => !in_array($e['email'], $emails, true)));
        return $before - count($d['entries']);
    });
    out(['deleted' => $n]);
}

if ($a === 'demo') {
    $users = read_json('users.json', ['users' => []])['users'] ?? [];
    out(['users' => array_map(fn ($u) => [
        'username' => $u['username'] ?? ($u['email'] ?? ''),
        'name' => $u['name'] ?? '',
        'logins' => (int) ($u['logins'] ?? 0),
        'lastLogin' => (int) ($u['lastLogin'] ?? 0),
        'apps' => array_values(array_map(fn ($x) => (string) ($x['platform'] ?? ''), is_array($u['accounts'] ?? null) ? $u['accounts'] : [])),
    ], $users)]);
}

/* ---------------- görevler (lansman süreçleri) ---------------- */
function default_tasks(): array
{
    $t = time();
    $mk = fn ($title, $tag, $status = 'todo') => ['id' => bin2hex(random_bytes(5)), 'title' => $title, 'tag' => $tag, 'status' => $status, 'due' => '', 'at' => $t];
    return [
        $mk('demo.mivelo.app için AutoSSL çalıştır', 'altyapı'),
        $mk('hello@mivelo.app e-posta kutusunu aç', 'altyapı'),
        $mk('Gizlilik ve Koşullar sayfalarını yaz (footer bağlantıları boş)', 'site'),
        $mk('Instagram: bio, öne çıkanlar ve ilk 3 gönderi', 'pazarlama'),
        $mk('Tanıtım videosunu Reels olarak paylaş', 'pazarlama'),
        $mk('İlk 50 kişiye beta daveti gönder', 'beta'),
        $mk('Windows sürümünü gerçek cihazda test et', 'ürün'),
    ];
}

if ($a === 'tasks') {
    $tasks = with_json('admin.json', [], function (array &$d) {
        if (!isset($d['tasks']) || !is_array($d['tasks'])) {
            $d['tasks'] = default_tasks();
        }
        return $d['tasks'];
    });
    out(['tasks' => $tasks]);
}

if ($a === 'task_save' && $method === 'POST') {
    $in = (array) ($body['task'] ?? []);
    $title = trim(mb_substr((string) ($in['title'] ?? ''), 0, 200));
    $status = in_array($in['status'] ?? '', ['todo', 'doing', 'done'], true) ? $in['status'] : 'todo';
    $tag = trim(mb_substr((string) ($in['tag'] ?? ''), 0, 24));
    $due = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($in['due'] ?? '')) ? (string) $in['due'] : '';
    $id = preg_replace('/[^a-f0-9]/', '', (string) ($in['id'] ?? ''));
    if ($title === '') {
        fail(400, 'Başlık gerekli');
    }
    $tasks = with_json('admin.json', [], function (array &$d) use ($id, $title, $status, $tag, $due) {
        $d['tasks'] = is_array($d['tasks'] ?? null) ? $d['tasks'] : default_tasks();
        foreach ($d['tasks'] as &$t) {
            if ($id !== '' && $t['id'] === $id) {
                $t = ['id' => $id, 'title' => $title, 'status' => $status, 'tag' => $tag, 'due' => $due, 'at' => $t['at'] ?? time(), 'doneAt' => $status === 'done' ? ($t['doneAt'] ?? time()) : 0];
                return $d['tasks'];
            }
        }
        unset($t);
        $d['tasks'][] = ['id' => bin2hex(random_bytes(5)), 'title' => $title, 'status' => $status, 'tag' => $tag, 'due' => $due, 'at' => time(), 'doneAt' => 0];
        return $d['tasks'];
    });
    out(['tasks' => $tasks]);
}

if ($a === 'task_delete' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    $tasks = with_json('admin.json', [], function (array &$d) use ($id) {
        $d['tasks'] = array_values(array_filter(is_array($d['tasks'] ?? null) ? $d['tasks'] : [], fn ($t) => $t['id'] !== $id));
        return $d['tasks'];
    });
    out(['tasks' => $tasks]);
}

/* ---------------- ayarlar ---------------- */
if ($a === 'password' && $method === 'POST') {
    $cur = (string) ($body['current'] ?? '');
    $next = (string) ($body['next'] ?? '');
    if (!password_verify($cur, admin_hash())) {
        fail(401, 'Mevcut şifre hatalı');
    }
    if (mb_strlen($next) < 12) {
        fail(400, 'Yeni şifre en az 12 karakter olmalı');
    }
    $hash = password_hash($next, PASSWORD_BCRYPT, ['cost' => 12]);
    with_json('admin.json', [], function (array &$d) use ($hash) {
        $d['hash'] = $hash;
        $d['changedAt'] = time();
    });
    session_regenerate_id(true);
    out(['ok' => true]);
}

if ($a === 'system') {
    $dir = data_dir();
    $files = [];
    foreach (['waitlist.json', 'users.json', 'admin.json'] as $f) {
        $files[$f] = is_file("$dir/$f") ? filesize("$dir/$f") : 0;
    }
    $statsSize = 0;
    foreach (glob("$dir/stats/*.json") ?: [] as $f) {
        $statsSize += filesize($f);
    }
    $files['stats/'] = $statsSize;
    $adm = read_json('admin.json', []);
    out([
        'php' => PHP_VERSION,
        'time' => time(),
        'tz' => date_default_timezone_get(),
        'files' => $files,
        'diskFree' => @disk_free_space($dir) ?: null,
        'passwordChangedAt' => (int) ($adm['changedAt'] ?? 0),
    ]);
}

if ($a === 'backup') {
    header('Content-Disposition: attachment; filename="mivelo-yedek-' . date('Y-m-d') . '.json"');
    $adm = read_json('admin.json', []);
    unset($adm['hash']);
    out([
        'exportedAt' => date('c'),
        'waitlist' => read_json('waitlist.json', ['entries' => []]),
        'stats' => stat_days(12),
        'admin' => $adm,
    ]);
}

fail(404, 'Bilinmeyen istek');
