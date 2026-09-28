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

require_once __DIR__ . '/../api/lib-smtp.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: same-origin');

function out($v)
{
    echo json_encode($v, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(int $code, string $msg)
{
    http_response_code($code);
    out(['error' => $msg]);
}

$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && strtolower((string) parse_url($origin, PHP_URL_HOST)) !== $host) {
    fail(403, 'İstek reddedildi');
}

function data_dir(): string
{
    $d = dirname(__DIR__, 2) . '/mivelo-data';
    if (!is_dir($d) && !@mkdir($d, 0700, true)) {
        fail(500, 'Veri klasörü açılamadı');
    }
    return $d;
}

$secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
// Oturumlar kendi klasöründe ve IDLE kadar yaşar (varsayılan gc_maxlifetime 24 dk'da "12 saat" hiç çalışmıyordu;
// paylaşımlı klasörü barındırıcının temizleyicisi kendi süresine göre siliyordu). Özel klasörde GC'yi PHP yapar.
$sessDir = data_dir() . '/sessions-admin';
if (is_dir($sessDir) || @mkdir($sessDir, 0700, true)) {
    session_save_path($sessDir);
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '100');
}
ini_set('session.gc_maxlifetime', (string) IDLE);
session_name('mvadmin');
session_set_cookie_params(['lifetime' => 0, 'path' => '/admin', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Strict']);
session_start();

/**
 * JSON deposu. Yazım: önce kodlanır (hata → 500, dosyaya dokunulmaz), geçici dosyaya yazılıp rename ile atomik
 * değiştirilir; okuyucular (kilitsiz read_json) hep eski ya da yeni tam dosyayı görür. Boş olmayan ama çözülemeyen
 * dosya ASLA "boş" sayılıp üstüne yazılmaz (500; elle bakılmalı). $strict: var olan boş dosya da bozuk sayılır.
 */
function store_read(string $path, array $empty, bool $strict = false): array
{
    clearstatcache(true, $path);
    if (!file_exists($path)) {
        return $empty;
    }
    $raw = @file_get_contents($path);
    if ($raw === false) {
        fail(500, 'Kayıt dosyası okunamadı');
    }
    if (trim($raw) === '') {
        if ($strict) {
            fail(500, 'Kayıt dosyası boş/bozuk: ' . basename($path));
        }
        return $empty;
    }
    $d = json_decode($raw, true);
    if (!is_array($d)) {
        fail(500, 'Kayıt dosyası bozuk: ' . basename($path));
    }
    return $d;
}

function store_write(string $path, array $data, int $flags = 0): void
{
    $json = json_encode($data, $flags | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        fail(500, 'Kayıt kodlanamadı');
    }
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
    $fh = @fopen($tmp, 'x');
    if ($fh === false) {
        fail(500, 'Geçici dosya açılamadı');
    }
    $ok = fwrite($fh, $json) === strlen($json) && fflush($fh);
    if ($ok && function_exists('fsync')) {
        $ok = fsync($fh);
    }
    fclose($fh);
    if (!$ok || !@rename($tmp, $path)) {
        @unlink($tmp);
        fail(500, 'Kayıt yazılamadı');
    }
}

/** Dosyanın yanındaki .lock üzerinde özel kilit (asıl dosya rename ile değiştiği için onun üstünde kilit tutulamaz) */
function store_lock(string $path)
{
    $lh = @fopen($path . '.lock', 'c');
    if ($lh === false || !flock($lh, LOCK_EX)) {
        fail(500, 'Kayıt kilitlenemedi');
    }
    return $lh;
}

/** Kilitli oku-değiştir-yaz: $fn(array &$data); veri değiştiyse atomik yazılır. */
function with_json(string $name, array $empty, callable $fn)
{
    $path = data_dir() . '/' . $name;
    $lh = store_lock($path);
    $data = store_read($path, $empty, $name === 'admin.json');
    $before = $data;
    $res = $fn($data);
    if ($data !== $before) {
        store_write($path, $data, JSON_PRETTY_PRINT);
    }
    flock($lh, LOCK_UN);
    fclose($lh);
    return $res;
}

function read_json(string $name, array $empty): array
{
    return store_read(data_dir() . '/' . $name, $empty, $name === 'admin.json');
}

/**
 * Geçerli şifre karması. Kapalı başarısızlık: admin.json var ama okunamıyor/boş/bozuksa ya da şifre değiştirilmiş
 * (changedAt) ama karma yoksa varsayılana DÜŞÜLMEZ, 500 döner (eskiden bozuk dosya varsayılan şifreyi geri açıyordu).
 */
function admin_hash(): string
{
    $a = read_json('admin.json', []);
    if (array_key_exists('hash', $a)) {
        if (is_string($a['hash']) && $a['hash'] !== '') {
            return $a['hash'];
        }
        fail(500, 'Yönetici şifre kaydı bozuk');
    }
    if (!empty($a['changedAt'])) {
        fail(500, 'Yönetici şifre kaydı eksik');
    }
    return DEFAULT_HASH;
}

/** Hız sınırı anahtarı: IPv4 tam adres, IPv6 /64 önek (tek bağlantı milyarlarca adres verir) */
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

function authed(): bool
{
    if (empty($_SESSION['admin']) || (int) ($_SESSION['seen'] ?? 0) < time() - IDLE) {
        return false;
    }
    $_SESSION['seen'] = time();
    return true;
}

/** CSV formül enjeksiyonu: = + - @ sekme/CR ile başlayan hücreler Excel/LibreOffice'te formül olarak çalışır → başına ' */
function csv_safe($v)
{
    if (is_string($v) && $v !== '' && strpbrk($v[0], "=+-@\t\r") !== false) {
        return "'" . $v;
    }
    return $v;
}

function mask_ip(string $ip): string
{
    if (strpos($ip, ':') !== false) {
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
    $key = client_key($ip);
    // Deneme, şifre doğrulanmadan ÖNCE aynı kilitli bölümde sayılır: paralel istekler 5 sınırını aşamaz.
    // Anahtar başına 5 deneme / 15 dk kilit; ayrıca tüm anahtarlar için saatte en çok GLOBAL_FAILS başarısız deneme.
    $lock = with_json('admin-auth.json', ['ips' => []], function (array &$d) use ($key, $now) {
        $d['ips'] = is_array($d['ips'] ?? null) ? $d['ips'] : [];
        foreach ($d['ips'] as $k => $v) {
            if ((int) ($v['until'] ?? 0) < $now && (int) ($v['last'] ?? 0) < $now - 3600) {
                unset($d['ips'][$k]);
            }
        }
        $g = array_values(array_filter(is_array($d['global'] ?? null) ? $d['global'] : [], function ($t) use ($now) {
            return (int) $t > $now - 3600;
        }));
        $d['global'] = $g;
        $e = $d['ips'][$key] ?? ['fails' => 0, 'last' => 0, 'until' => 0];
        if ((int) ($e['until'] ?? 0) > $now) {
            return (int) $e['until'];
        }
        if (count($g) >= 100) {
            return (int) min($g) + 3600;
        }
        $f = (int) ($e['fails'] ?? 0) + 1;
        $d['ips'][$key] = ['fails' => $f >= 5 ? 0 : $f, 'last' => $now, 'until' => $f >= 5 ? $now + 900 : 0];
        $d['global'][] = $now;
        return 0;
    });
    if ($lock > $now) {
        fail(429, 'Çok fazla hatalı deneme. ' . (int) ceil(($lock - $now) / 60) . ' dakika sonra tekrar dene.');
    }
    usleep(300000);
    if (!password_verify((string) ($body['password'] ?? ''), admin_hash())) {
        fail(401, 'Şifre hatalı');
    }
    // başarılı: bu anahtarın sayacı ve bu denemenin genel kaydı silinir
    with_json('admin-auth.json', ['ips' => []], function (array &$d) use ($key, $now) {
        unset($d['ips'][$key]);
        $i = array_search($now, is_array($d['global'] ?? null) ? $d['global'] : [], true);
        if ($i !== false) {
            array_splice($d['global'], (int) $i, 1);
        }
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
            unset($v['ids'], $v['rl']);
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
        fputcsv($f, array_map('csv_safe', [$i + 1, $e['email'], date('Y-m-d H:i', (int) $e['at']), $e['src'] ?? '', $tr[$e['status'] ?? 'waiting'] ?? '', $e['code'] ?? '', $e['ref'] ?? '', (int) ($e['refs'] ?? 0), $e['note'] ?? '']), ';');
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

// Yeni demo üyeleri otomatik onay (demo API'si demo-settings.json'u okur; varsayılan açık)
if ($a === 'demo_settings' && $method === 'POST') {
    $on = (bool) ($body['autoApprove'] ?? true);
    with_json('demo-settings.json', [], function (array &$d) use ($on) {
        $d['autoApprove'] = $on;
        return null;
    });
    out(['autoApprove' => $on]);
}

if ($a === 'demo') {
    // kayıtla gelen üyelerin eski demo verisi (varsayılan uygulamalar) bir kez silinir — demo API'si ile aynı kural
    $users = with_json('users.json', ['users' => []], function (array &$d) {
        foreach ($d['users'] as &$u) {
            if (!empty($u['requestedAt']) && (int) ($u['dataReset'] ?? 0) < 2) {
                $u['accounts'] = [];
                $u['dataReset'] = 2;
            }
        }
        unset($u);
        return $d['users'];
    });
    $rank = ['pending' => 0, 'active' => 1, 'rejected' => 2];
    $list = array_map(fn ($u) => [
        'id' => (string) ($u['id'] ?? ''),
        'username' => $u['username'] ?? ($u['email'] ?? ''),
        'name' => $u['name'] ?? '',
        'email' => str_ends_with_s((string) ($u['email'] ?? ''), '@demo') ? '' : (string) ($u['email'] ?? ''),
        'note' => (string) ($u['note'] ?? ''),
        'status' => demo_status($u),
        'requestedAt' => (int) ($u['requestedAt'] ?? 0),
        'approvedAt' => (int) ($u['approvedAt'] ?? 0),
        'mailed' => $u['mailed'] ?? null,
        'mailError' => (string) ($u['mailError'] ?? ''),
        'logins' => (int) ($u['logins'] ?? 0),
        'lastLogin' => (int) ($u['lastLogin'] ?? 0),
        'apps' => array_values(array_map(fn ($x) => (string) ($x['platform'] ?? ''), is_array($u['accounts'] ?? null) ? $u['accounts'] : [])),
    ], is_array($users) ? $users : []);
    usort($list, fn ($x, $y) => [$rank[$x['status']], -$x['requestedAt']] <=> [$rank[$y['status']], -$y['requestedAt']]);
    $ds = read_json('demo-settings.json', []);
    out(['users' => $list, 'autoApprove' => !array_key_exists('autoApprove', $ds) || (bool) $ds['autoApprove']]);
}

function demo_status(array $u): string
{
    $s = (string) ($u['status'] ?? 'active');
    return in_array($s, ['pending', 'active', 'rejected'], true) ? $s : 'active';
}

function str_ends_with_s(string $h, string $n): bool
{
    return $n === '' || substr($h, -strlen($n)) === $n;
}

/** Onay e-postası: SMTP ayarlıysa kimlik doğrulamalı SMTP (Ayarlar → E-posta gönderimi), yoksa mail() yedeği. */
function send_approval_mail(string $to, string $name, string $username): array
{
    $n = trim(preg_replace('/[\r\n]+/', ' ', $name) ?? '');
    $body = "Merhaba $n,\n\n"
        . "Mivelo demo üyelik talebin onaylandı. Artık giriş yapabilirsin:\n\n"
        . "  Adres: https://demo.mivelo.app\n"
        . "  Kullanıcı adı: $username\n"
        . "  Şifre: talep ederken belirlediğin şifre\n\n"
        . "Demo sana özel: bağladığın uygulamalar ve ayarların yalnız senin hesabında durur. Gördüğün mesajlar örnek veridir.\n"
        . "Bir hata görürsen ya da önerin olursa sağ alttaki geri bildirim düğmesini kullanabilir veya bu e-postayı yanıtlayabilirsin.\n\n"
        . "Mivelo\nhello@mivelo.app\n";
    return mv_send_mail($to, 'Mivelo demo üyeliğin onaylandı', $body);
}

/** Kullanıcı kaydına e-posta sonucunu yaz (panelde rozet + hata ipucu) */
function record_mail(string $id, array $res): void
{
    with_json('users.json', ['users' => []], function (array &$d) use ($id, $res) {
        foreach ($d['users'] as &$x) {
            if (($x['id'] ?? '') === $id) {
                $x['mailed'] = $res['ok'] && $res['via'] === 'smtp';
                $x['mailError'] = $res['ok'] && $res['via'] === 'smtp' ? '' : (string) ($res['error'] ?? 'Bilinmeyen hata');
                $x['mailedAt'] = time();
            }
        }
        unset($x);
    });
}

if ($a === 'demo_update' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    $status = (string) ($body['status'] ?? '');
    if (!in_array($status, ['active', 'rejected', 'pending'], true)) {
        fail(400, 'Geçersiz durum');
    }
    $u = with_json('users.json', ['users' => []], function (array &$d) use ($id, $status) {
        foreach ($d['users'] as &$u) {
            if (($u['id'] ?? '') !== $id) {
                continue;
            }
            if (($u['id'] ?? '') === 'u-admin') {
                return 'admin';
            }
            $prev = demo_status($u);
            $u['status'] = $status;
            if ($status === 'active' && $prev !== 'active') {
                $u['approvedAt'] = time();
            }
            return $u + ['__prev' => $prev];
        }
        unset($u);
        return null;
    });
    if ($u === 'admin') {
        fail(400, 'admin hesabının durumu değiştirilemez');
    }
    if ($u === null) {
        fail(404, 'Kullanıcı yok');
    }
    $res = null;
    if ($status === 'active' && $u['__prev'] !== 'active') {
        $res = send_approval_mail((string) ($u['email'] ?? ''), (string) ($u['name'] ?? ''), (string) ($u['username'] ?? ''));
        record_mail($id, $res);
    }
    out(['ok' => true, 'mailed' => $res ? ($res['ok'] && $res['via'] === 'smtp') : null, 'mailError' => $res && !($res['ok'] && $res['via'] === 'smtp') ? ($res['error'] ?? '') : '']);
}

if ($a === 'demo_mail' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    $u = null;
    foreach (read_json('users.json', ['users' => []])['users'] ?? [] as $x) {
        if (($x['id'] ?? '') === $id) {
            $u = $x;
        }
    }
    if ($u === null || demo_status($u) !== 'active') {
        fail(404, 'Onaylı kullanıcı yok');
    }
    $res = send_approval_mail((string) ($u['email'] ?? ''), (string) ($u['name'] ?? ''), (string) ($u['username'] ?? ''));
    record_mail($id, $res);
    out(['ok' => true, 'mailed' => $res['ok'] && $res['via'] === 'smtp', 'mailError' => $res['ok'] && $res['via'] === 'smtp' ? '' : ($res['error'] ?? ''), 'log' => $res['log'] ?? []]);
}

// üyenin demo verisini (bağladığı uygulamalar) sil; hesap kalır
if ($a === 'demo_reset' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    $n = with_json('users.json', ['users' => []], function (array &$d) use ($id) {
        foreach ($d['users'] as &$u) {
            if (($u['id'] ?? '') === $id) {
                $u['accounts'] = [];
                $u['dataReset'] = max(2, (int) ($u['dataReset'] ?? 0));
                return 1;
            }
        }
        unset($u);
        return 0;
    });
    out(['reset' => $n]);
}

if ($a === 'demo_delete' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    if ($id === 'u-admin') {
        fail(400, 'admin hesabı silinemez');
    }
    $n = with_json('users.json', ['users' => []], function (array &$d) use ($id) {
        $before = count($d['users']);
        $d['users'] = array_values(array_filter($d['users'], fn ($u) => ($u['id'] ?? '') !== $id));
        return $before - count($d['users']);
    });
    out(['deleted' => $n]);
}

/* ---------------- lisanslar (masaüstü uygulaması; doğrulama: api/license.php) ---------------- */

/** MVL-XXXX-XXXX-XXXX-XXXX: karışan karakterler (0/O, 1/I/L) yok, 80 bit rastgele */
function new_license_key(): string
{
    $abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    $g = [];
    for ($i = 0; $i < 4; $i++) {
        $s = '';
        for ($j = 0; $j < 4; $j++) {
            $s .= $abc[random_int(0, strlen($abc) - 1)];
        }
        $g[] = $s;
    }
    return 'MVL-' . implode('-', $g);
}
function license_public(array $k): array
{
    $exp = $k['expiresAt'] ?? null;
    $st = ($k['status'] ?? 'active') !== 'active' ? 'revoked' : ($exp && strtotime((string) $exp) < time() ? 'expired' : 'active');
    return ['id' => $k['id'], 'key' => $k['key'], 'note' => $k['note'] ?? '', 'email' => $k['email'] ?? '', 'maxDevices' => (int) ($k['maxDevices'] ?? 2),
        'expiresAt' => $exp, 'status' => $st, 'createdAt' => $k['createdAt'] ?? null, 'usedAt' => $k['usedAt'] ?? null,
        'activations' => array_map(fn ($a) => ['id' => $a['id'], 'name' => $a['name'] ?? '', 'os' => $a['os'] ?? '', 'version' => $a['version'] ?? '',
            'firstAt' => $a['firstAt'] ?? null, 'lastAt' => $a['lastAt'] ?? null], $k['activations'] ?? [])];
}

if ($a === 'licenses' && $method === 'GET') {
    $d = read_json('licenses.json', ['keys' => []]);
    out(['keys' => array_map('license_public', array_reverse($d['keys']))]);
}

if ($a === 'license_create' && $method === 'POST') {
    $n = max(1, min(50, (int) ($body['count'] ?? 1)));
    $note = mb_substr(trim((string) ($body['note'] ?? '')), 0, 120);
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        fail(400, 'E-posta geçersiz');
    }
    $max = max(1, min(10, (int) ($body['maxDevices'] ?? 2)));
    $days = (int) ($body['days'] ?? 0);
    $exp = $days > 0 ? gmdate('c', time() + min($days, 3650) * 86400) : null;
    $made = with_json('licenses.json', ['keys' => []], function (array &$d) use ($n, $note, $email, $max, $exp) {
        $out = [];
        $have = array_flip(array_map(fn ($k) => $k['key'], $d['keys']));
        for ($i = 0; $i < $n; $i++) {
            do {
                $key = new_license_key();
            } while (isset($have[$key]));
            $have[$key] = 1;
            $k = ['id' => 'l-' . bin2hex(random_bytes(6)), 'key' => $key, 'note' => $note, 'email' => $n === 1 ? $email : '', 'maxDevices' => $max,
                'expiresAt' => $exp, 'status' => 'active', 'createdAt' => gmdate('c'), 'activations' => []];
            $d['keys'][] = $k;
            $out[] = license_public($k);
        }
        return $out;
    });
    out(['created' => $made]);
}

if ($a === 'license_update' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    $r = with_json('licenses.json', ['keys' => []], function (array &$d) use ($id, $body) {
        foreach ($d['keys'] as &$k) {
            if ($k['id'] !== $id) {
                continue;
            }
            if (isset($body['status'])) {
                $k['status'] = $body['status'] === 'revoked' ? 'revoked' : 'active';
            }
            if (isset($body['note'])) {
                $k['note'] = mb_substr(trim((string) $body['note']), 0, 120);
            }
            if (isset($body['maxDevices'])) {
                $k['maxDevices'] = max(1, min(10, (int) $body['maxDevices']));
            }
            if (!empty($body['resetDevices'])) {
                $k['activations'] = [];
            }
            if (isset($body['release'])) {
                $k['activations'] = array_values(array_filter($k['activations'] ?? [], fn ($a) => $a['id'] !== (string) $body['release']));
            }
            return license_public($k);
        }
        return null;
    });
    if (!$r) {
        fail(404, 'Lisans yok');
    }
    out($r);
}

if ($a === 'license_delete' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    $n = with_json('licenses.json', ['keys' => []], function (array &$d) use ($id) {
        $b = count($d['keys']);
        $d['keys'] = array_values(array_filter($d['keys'], fn ($k) => $k['id'] !== $id));
        return $b - count($d['keys']);
    });
    out(['deleted' => $n]);
}

/* ---------------- geri bildirim (uygulamadaki sağ alt düğme → api/feedback.php) ---------------- */
function fb_dir(): string
{
    return data_dir() . '/feedback';
}

if ($a === 'fb_list') {
    $d = store_read(fb_dir() . '/index.json', ['items' => []]);
    $items = array_reverse(is_array($d['items'] ?? null) ? $d['items'] : []);
    out(['items' => array_map(fn ($x) => [
        'id' => (string) $x['id'], 'at' => (int) $x['at'], 'type' => (string) $x['type'], 'message' => (string) $x['message'],
        'email' => (string) ($x['email'] ?? ''), 'name' => (string) ($x['name'] ?? ''), 'user' => (string) ($x['user'] ?? ''),
        'page' => (string) ($x['page'] ?? ''), 'app' => (string) ($x['app'] ?? ''), 'ua' => (string) ($x['ua'] ?? ''),
        'files' => is_array($x['files'] ?? null) ? $x['files'] : [], 'status' => (string) ($x['status'] ?? 'new'), 'note' => (string) ($x['note'] ?? ''),
        'verified' => !empty($x['verified']),
    ], $items)]);
}

if ($a === 'fb_update' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    $status = isset($body['status']) ? (string) $body['status'] : null;
    $note = isset($body['note']) ? mb_substr((string) $body['note'], 0, 1000) : null;
    if ($status !== null && !in_array($status, ['new', 'doing', 'done', 'wontfix'], true)) {
        fail(400, 'Geçersiz durum');
    }
    $path = fb_dir() . '/index.json';
    $lh = store_lock($path);
    $d = store_read($path, ['items' => []]);
    $n = 0;
    foreach ($d['items'] as &$x) {
        if (($x['id'] ?? '') === $id) {
            if ($status !== null) {
                $x['status'] = $status;
            }
            if ($note !== null) {
                $x['note'] = $note;
            }
            $n++;
        }
    }
    unset($x);
    if ($n) {
        store_write($path, $d, JSON_PRETTY_PRINT);
    }
    flock($lh, LOCK_UN);
    fclose($lh);
    out(['updated' => $n]);
}

if ($a === 'fb_delete' && $method === 'POST') {
    $id = (string) ($body['id'] ?? '');
    if (!preg_match('/^\d{8}-\d{6}-[a-f0-9]{6}$/', $id)) {
        fail(400, 'Geçersiz kimlik');
    }
    $path = fb_dir() . '/index.json';
    $lh = store_lock($path);
    $d = store_read($path, ['items' => []]);
    $before = count($d['items']);
    $d['items'] = array_values(array_filter($d['items'], fn ($x) => ($x['id'] ?? '') !== $id));
    if (count($d['items']) !== $before) {
        store_write($path, $d, JSON_PRETTY_PRINT);
    }
    flock($lh, LOCK_UN);
    fclose($lh);
    foreach (glob(fb_dir() . '/' . $id . '/*') ?: [] as $f) {
        @unlink($f);
    }
    @rmdir(fb_dir() . '/' . $id);
    out(['deleted' => $before - count($d['items'])]);
}

// ek dosyası (yalnız oturum açmış yönetici): kimlik ve dosya adı sıkı biçimde; tür kayıttaki izinli listeden
if ($a === 'fb_file') {
    $id = (string) ($_GET['id'] ?? '');
    $f = (string) ($_GET['f'] ?? '');
    if (!preg_match('/^\d{8}-\d{6}-[a-f0-9]{6}$/', $id) || !preg_match('/^\d{1,2}\.(png|jpg|gif|webp|mp4|webm|mov)$/', $f)) {
        fail(400, 'Geçersiz dosya');
    }
    $path = fb_dir() . '/' . $id . '/' . $f;
    if (!is_file($path)) {
        fail(404, 'Dosya yok');
    }
    $types = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp', 'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mov' => 'video/quicktime'];
    header_remove('Content-Type');
    header('Content-Type: ' . $types[pathinfo($f, PATHINFO_EXTENSION)]);
    header('Content-Length: ' . filesize($path));
    header('Content-Disposition: inline; filename="' . $id . '-' . $f . '"');
    header("Content-Security-Policy: default-src 'none'; sandbox");
    header('Cache-Control: private, max-age=3600');
    readfile($path);
    exit;
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
if ($a === 'smtp') {
    $c = mv_smtp_config() ?? [];
    out(['configured' => (bool) $c, 'host' => $c['host'] ?? '', 'port' => (int) ($c['port'] ?? 465), 'secure' => $c['secure'] ?? 'ssl', 'user' => $c['user'] ?? '', 'from' => $c['from'] ?? '', 'fromName' => $c['fromName'] ?? 'Mivelo', 'hasPass' => !empty($c['pass'])]);
}

if ($a === 'smtp_save' && $method === 'POST') {
    $old = mv_smtp_config() ?? [];
    $host = trim((string) ($body['host'] ?? ''));
    $user = trim((string) ($body['user'] ?? ''));
    $from = trim((string) ($body['from'] ?? '')) ?: $user;
    $secure = in_array($body['secure'] ?? '', ['ssl', 'tls', 'none'], true) ? $body['secure'] : 'ssl';
    $port = max(1, min(65535, (int) ($body['port'] ?? 465)));
    if ($host === '' && $user === '') {
        @unlink(mv_smtp_path());
        out(['ok' => true, 'configured' => false]);
    }
    if ($host === '') {
        fail(400, 'SMTP sunucusu boş: Türkticaret için smtp.turkticaret.net yaz');
    }
    if (!preg_match('/^[a-z0-9.-]{3,253}$/i', $host)) {
        fail(400, 'SMTP sunucu adı geçersiz (ör. smtp.turkticaret.net)');
    }
    if (!filter_var($from, FILTER_VALIDATE_EMAIL) || $user === '') {
        fail(400, 'Kullanıcı adı (e-posta adresinin tamamı) ve gönderen adresi gerekli');
    }
    $pass = (string) ($body['pass'] ?? '');
    $cfg = ['host' => $host, 'port' => $port, 'secure' => $secure, 'user' => $user, 'pass' => $pass !== '' ? $pass : (string) ($old['pass'] ?? ''), 'from' => $from, 'fromName' => mb_substr(trim((string) ($body['fromName'] ?? 'Mivelo')), 0, 60) ?: 'Mivelo'];
    if ($cfg['pass'] === '') {
        fail(400, 'Şifre gerekli');
    }
    $path = mv_smtp_path();
    $lh = store_lock($path);
    store_write($path, $cfg, JSON_PRETTY_PRINT);
    @chmod($path, 0600);
    flock($lh, LOCK_UN);
    fclose($lh);
    out(['ok' => true, 'configured' => true]);
}

if ($a === 'smtp_test' && $method === 'POST') {
    $to = trim((string) ($body['to'] ?? ''));
    $res = mv_send_mail($to, 'Mivelo deneme e-postası', "Bu bir deneme e-postasıdır. Bunu aldıysan yönetim panelinin e-posta gönderimi çalışıyor.\n\nGönderim: " . date('d.m.Y H:i') . "\n");
    out(['ok' => $res['ok'] && $res['via'] === 'smtp', 'via' => $res['via'], 'error' => $res['ok'] && $res['via'] === 'smtp' ? '' : ($res['error'] ?? ''), 'note' => $res['note'] ?? '', 'log' => $res['log'] ?? []]);
}

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
