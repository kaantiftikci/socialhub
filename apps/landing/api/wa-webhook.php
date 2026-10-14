<?php
declare(strict_types=1);

/**
 * WhatsApp Business (Cloud API) bildirim aktarıcısı (https://mivelo.app/api/wa-webhook.php). Meta gelen mesajları yalnız herkese açık
 * bir HTTPS webhook'a iter; kullanıcının bilgisayarındaki Mivelo'ya doğrudan ulaşamaz. Bu sayfa olayları numara (phone_number_id)
 * başına kuyruklar, masaüstü uygulaması çeker:
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…   Meta webhook doğrulaması (belirteç Admin → Resmi giriş → WhatsApp)
 *   POST (Meta)                                                     X-Hub-Signature-256 (uygulama gizi) doğrulanır; yalnız kayıtlı numaralar kuyruklanır
 *   POST ?action=register   JSON {phone_number_id, waba_id, access_token} → {pullKey, last}
 *        belirteç Graph'ta BİR KEZ doğrulanır (GET /{numara}) ve SAKLANMAZ; anahtarın yalnız sha256 özeti tutulur
 *   GET  ?action=pull&phone_number_id=…&after=N   başlık X-Mivelo-Key → {events:[{seq,t,field,value}], last}
 *   POST ?action=unregister JSON {phone_number_id}  başlık X-Mivelo-Key → kayıt ve kuyruk silinir
 * Depo: ~/mivelo-data/wa-relay/<numara>/{reg.json, events.ndjson, seq, .lock}; kuyruk en çok 2000 olay / 3 gün. İçerik günlüğe yazılmaz.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');

require_once __DIR__ . '/lib-oauth.php';

function out(array $v, int $code = 200)
{
    http_response_code($code);
    echo json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(int $code, string $err, string $msg)
{
    out(['error' => $err, 'error_description' => $msg], $code);
}

const WA_MAX_EVENTS = 2000;
const WA_KEEP_EVENTS = 800;
const WA_MAX_AGE = 3 * 86400;
const WA_MAX_BODY = 2 * 1024 * 1024;

function wa_root(): string
{
    $d = mv_oauth_data_dir() . '/wa-relay';
    if (!is_dir($d) && !@mkdir($d, 0700, true)) {
        throw new RuntimeException('Aktarıcı klasörü açılamadı');
    }
    return $d;
}
function wa_pn(string $v): string
{
    return preg_match('/^\d{5,30}$/', $v) ? $v : '';
}
function wa_dir(string $pn): string
{
    return wa_root() . '/' . $pn;
}
/** Numara kilidi altında çalıştır */
function wa_locked(string $pn, callable $fn)
{
    $dir = wa_dir($pn);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        throw new RuntimeException('Kuyruk klasörü açılamadı');
    }
    $lh = @fopen($dir . '/.lock', 'c');
    if ($lh === false || !flock($lh, LOCK_EX)) {
        throw new RuntimeException('Kuyruk kilitlenemedi');
    }
    try {
        return $fn($dir);
    } finally {
        flock($lh, LOCK_UN);
        fclose($lh);
    }
}
function wa_reg(string $pn): ?array
{
    $f = wa_dir($pn) . '/reg.json';
    if (!is_file($f)) {
        return null;
    }
    $j = json_decode((string) @file_get_contents($f), true);
    return is_array($j) && is_string($j['keyHash'] ?? null) ? $j : null;
}
function wa_write(string $path, string $content): void
{
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $content) === false || !@rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException('Kayıt yazılamadı');
    }
    @chmod($path, 0600);
}
function wa_seq(string $dir): int
{
    return (int) @file_get_contents($dir . '/seq');
}
/** Kuyruğa olay ekle (kilit altında çağrılır); dosya büyüyünce eskiler atılır */
function wa_append(string $dir, string $field, array $value): void
{
    $seq = wa_seq($dir) + 1;
    $line = json_encode(['seq' => $seq, 't' => time(), 'field' => $field, 'value' => $value], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($line === false) {
        return;
    }
    $f = $dir . '/events.ndjson';
    if (@file_put_contents($f, $line . "\n", FILE_APPEND) === false) {
        throw new RuntimeException('Kuyruk yazılamadı');
    }
    wa_write($dir . '/seq', (string) $seq);
    clearstatcache(true, $f);
    if (@filesize($f) > 1536 * 1024 || $seq % 200 === 0) {
        $lines = @file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        if (count($lines) > WA_MAX_EVENTS) {
            wa_write($f, implode("\n", array_slice($lines, -WA_KEEP_EVENTS)) . "\n");
        }
    }
}
/** after'dan sonraki olaylar (≤100), 3 günden eskiler atlanır */
function wa_read(string $dir, int $after): array
{
    $f = $dir . '/events.ndjson';
    $out = [];
    if (!is_file($f)) {
        return $out;
    }
    $fh = @fopen($f, 'r');
    if ($fh === false) {
        return $out;
    }
    $minT = time() - WA_MAX_AGE;
    while (($line = fgets($fh)) !== false) {
        $j = json_decode($line, true);
        if (!is_array($j) || (int) ($j['seq'] ?? 0) <= $after || (int) ($j['t'] ?? 0) < $minT) {
            continue;
        }
        $out[] = $j;
        if (count($out) >= 100) {
            break;
        }
    }
    fclose($fh);
    return $out;
}
function wa_key_ok(string $pn): bool
{
    $key = (string) ($_SERVER['HTTP_X_MIVELO_KEY'] ?? '');
    if (!preg_match('/^[a-f0-9]{48}$/', $key)) {
        return false;
    }
    $reg = wa_reg($pn);
    return $reg !== null && hash_equals((string) $reg['keyHash'], hash('sha256', $key));
}
function wa_clients_whatsapp(): array
{
    $clients = mv_oauth_clients();
    return is_array($clients['whatsapp'] ?? null) ? $clients['whatsapp'] : [];
}
function wa_json_body(int $max = 8192): array
{
    if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? '')), 'application/json') !== 0) {
        fail(400, 'invalid_request', 'JSON bekleniyor');
    }
    $raw = (string) file_get_contents('php://input', false, null, 0, $max + 1);
    if (strlen($raw) > $max) {
        fail(413, 'invalid_request', 'İstek çok büyük');
    }
    $b = json_decode($raw, true);
    if (!is_array($b)) {
        fail(400, 'invalid_request', 'Geçersiz istek');
    }
    return $b;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = (string) ($_GET['action'] ?? '');

/* ---------------- Meta webhook doğrulaması (hub.*) ---------------- */
if ($method === 'GET' && $action === '' && isset($_GET['hub_mode'])) {
    try {
        $c = wa_clients_whatsapp();
    } catch (Throwable $e) {
        fail(500, 'server_error', 'Yapılandırma okunamadı');
    }
    $vt = mv_wa_verify_token($c);
    $given = (string) ($_GET['hub_verify_token'] ?? '');
    if ($_GET['hub_mode'] !== 'subscribe' || $vt === '' || !hash_equals($vt, $given)) {
        fail(403, 'forbidden', 'Doğrulama belirteci uyuşmuyor');
    }
    header('Content-Type: text/plain; charset=utf-8');
    http_response_code(200);
    echo (string) ($_GET['hub_challenge'] ?? '');
    exit;
}

/* ---------------- Meta'dan gelen olaylar ---------------- */
if ($method === 'POST' && $action === '') {
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > WA_MAX_BODY) {
        fail(413, 'invalid_request', 'İstek çok büyük');
    }
    $raw = (string) file_get_contents('php://input', false, null, 0, WA_MAX_BODY + 1);
    if (strlen($raw) > WA_MAX_BODY) {
        fail(413, 'invalid_request', 'İstek çok büyük');
    }
    try {
        $c = wa_clients_whatsapp();
    } catch (Throwable $e) {
        fail(500, 'server_error', 'Yapılandırma okunamadı');
    }
    $secret = (string) ($c['clientSecret'] ?? '');
    $sig = (string) ($_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '');
    if ($secret === '' || !preg_match('/^sha256=([a-f0-9]{64})$/', $sig, $m) || !hash_equals(hash_hmac('sha256', $raw, $secret), $m[1])) {
        fail(403, 'forbidden', 'İmza doğrulanamadı');
    }
    $body = json_decode($raw, true);
    // Meta yeniden denemesin: biçim bozuk/ilgisiz olsa da 200
    if (!is_array($body) || ($body['object'] ?? '') !== 'whatsapp_business_account') {
        out(['ok' => true, 'ignored' => true]);
    }
    $queued = 0;
    foreach (is_array($body['entry'] ?? null) ? $body['entry'] : [] as $entry) {
        foreach (is_array($entry['changes'] ?? null) ? $entry['changes'] : [] as $ch) {
            $field = is_string($ch['field'] ?? null) ? $ch['field'] : '';
            $value = is_array($ch['value'] ?? null) ? $ch['value'] : null;
            if ($value === null || !in_array($field, ['messages', 'smb_message_echoes', 'smb_app_state_sync', 'history'], true)) {
                continue;
            }
            $pn = wa_pn((string) ($value['metadata']['phone_number_id'] ?? ''));
            if ($pn === '' || wa_reg($pn) === null) {
                continue; // kayıtlı olmayan numara: saklanmaz
            }
            try {
                wa_locked($pn, function (string $dir) use ($field, $value) {
                    wa_append($dir, $field, $value);
                });
                $queued++;
            } catch (Throwable $e) {
                /* kuyruk yazılamadı: Meta yeniden dener (aşağıda 200 yine de döner; olay kaybı yerine çift olay tercih edilmez) */
                fail(500, 'server_error', 'Kuyruk yazılamadı');
            }
        }
    }
    out(['ok' => true, 'queued' => $queued]);
}

/* ---------------- masaüstü uygulaması uçları ---------------- */
if (!mv_oauth_is_https() && mv_oauth_test_base() === '') {
    fail(403, 'https_required', 'Yalnız HTTPS');
}
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$host = strtolower((string) preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if ($origin !== '' && strtolower((string) parse_url($origin, PHP_URL_HOST)) !== $host) {
    fail(403, 'forbidden', 'İstek reddedildi');
}

if ($action === 'register') {
    if ($method !== 'POST') {
        fail(405, 'method_not_allowed', 'Yalnızca POST');
    }
    try {
        if (mv_oauth_rate_over('wa_register', 30)) {
            fail(429, 'rate_limited', 'Çok fazla istek; biraz sonra yeniden dene');
        }
        $c = wa_clients_whatsapp();
    } catch (Throwable $e) {
        fail(500, 'server_error', 'Aktarıcı şu an kullanılamıyor');
    }
    if (!mv_oauth_ready('whatsapp', $c)) {
        fail(400, 'provider_disabled', 'WhatsApp resmi girişi şu an kapalı');
    }
    $b = wa_json_body();
    $pn = wa_pn(is_string($b['phone_number_id'] ?? null) ? $b['phone_number_id'] : '');
    $waba = is_string($b['waba_id'] ?? null) && preg_match('/^\d{0,30}$/', $b['waba_id']) ? $b['waba_id'] : '';
    $token = is_string($b['access_token'] ?? null) ? $b['access_token'] : '';
    if ($pn === '' || !preg_match('/^[\x21-\x7e]{20,4096}$/', $token)) {
        fail(400, 'invalid_request', 'Numara kimliği ya da belirteç eksik');
    }
    // sahiplik: belirteç bu numarayı okuyabiliyor mu (belirteç saklanmaz, günlüğe yazılmaz)
    $v = mv_oauth_graph_version($c['graphVersion'] ?? null);
    $r = mv_oauth_call('GET', "https://graph.facebook.com/$v/$pn", ['fields' => 'id', 'access_token' => $token]);
    if ($r['s'] !== 200 || (string) ($r['j']['id'] ?? '') !== $pn) {
        [$st, $err] = mv_oauth_error('whatsapp', $r);
        fail($st === 502 ? 502 : 403, 'not_owner', $err['error_description'] ?? 'Belirteç bu numaraya erişemiyor');
    }
    $key = bin2hex(random_bytes(24));
    try {
        $last = wa_locked($pn, function (string $dir) use ($key, $waba) {
            wa_write($dir . '/reg.json', (string) json_encode(['keyHash' => hash('sha256', $key), 'wabaId' => $waba, 'at' => time()]));
            return wa_seq($dir);
        });
    } catch (Throwable $e) {
        fail(500, 'server_error', 'Kayıt yazılamadı');
    }
    out(['ok' => true, 'pullKey' => $key, 'last' => $last, 'webhook' => MV_WA_WEBHOOK]);
}

if ($action === 'pull') {
    if ($method !== 'GET') {
        fail(405, 'method_not_allowed', 'Yalnızca GET');
    }
    $pn = wa_pn((string) ($_GET['phone_number_id'] ?? ''));
    if ($pn === '') {
        fail(400, 'invalid_request', 'Numara kimliği eksik');
    }
    try {
        if (wa_reg($pn) === null) {
            fail(404, 'not_registered', 'Bu numara aktarıcıda kayıtlı değil');
        }
        if (!wa_key_ok($pn)) {
            fail(401, 'unauthorized', 'Anahtar geçersiz');
        }
        $after = max(0, (int) ($_GET['after'] ?? 0));
        [$events, $last] = wa_locked($pn, function (string $dir) use ($after) {
            return [wa_read($dir, $after), wa_seq($dir)];
        });
    } catch (Throwable $e) {
        fail(500, 'server_error', 'Kuyruk okunamadı');
    }
    out(['events' => $events, 'last' => $last]);
}

if ($action === 'unregister') {
    if ($method !== 'POST') {
        fail(405, 'method_not_allowed', 'Yalnızca POST');
    }
    $b = wa_json_body();
    $pn = wa_pn(is_string($b['phone_number_id'] ?? null) ? $b['phone_number_id'] : '');
    if ($pn === '' || wa_reg($pn) === null) {
        out(['ok' => true]);
    }
    if (!wa_key_ok($pn)) {
        fail(401, 'unauthorized', 'Anahtar geçersiz');
    }
    try {
        wa_locked($pn, function (string $dir) {
            foreach (['reg.json', 'events.ndjson', 'seq'] as $f) {
                @unlink($dir . '/' . $f);
            }
        });
    } catch (Throwable $e) {
        fail(500, 'server_error', 'Kayıt silinemedi');
    }
    out(['ok' => true]);
}

fail(404, 'not_found', 'Bilinmeyen istek');
