<?php
declare(strict_types=1);

/**
 * Resmi giriş aracısı (mivelo.app/api/oauth.php). Mivelo çekirdeği (packages/core/src/oauth) çağırır; Origin yok.
 *   GET  ?action=config  → {v:1, providers:{google:{clientId}, slack:{clientId, historyLimited}, instagram|facebook:{clientId, graphVersion}, …}}
 *        yalnız etkin + kimliği (ve gizi) olanlar; GİZ ASLA dönmez. 5 dk önbellek.
 *   POST ?action=token   JSON {provider, code, redirect_uri, code_verifier?} → sağlayıcının belirteç yanıtı (istemci gizi burada eklenir)
 *   POST ?action=refresh JSON {provider, refresh_token}                       → yenileme yanıtı
 * Hata: {error, error_description} (Slack'te ok:false da). Microsoft genel istemci → aracıdan geçmez (400).
 * Güvenlik: gelen istek HTTPS olmalı; gövde ≤8 KB ve JSON; IP (IPv6 /64) başına saatte token 60, refresh 300; geri dönüş adresi
 * izin listesinde (Google: http://127.0.0.1:<port>/oauth/callback, diğerleri https://mivelo.app/api/oauth-cb.php).
 * Belirteçler SAKLANMAZ ve günlüğe yazılmaz. Gizler ~/mivelo-data/oauth-clients.json (Admin → Ayarlar → Resmi giriş uygulamaları).
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');

require_once __DIR__ . '/lib-oauth.php';

function out(array $v, int $code = 200)
{
    http_response_code($code);
    echo json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(int $code, string $err, string $msg)
{
    header('Cache-Control: no-store');
    out(['error' => $err, 'error_description' => $msg], $code);
}

$action = (string) ($_GET['action'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($action === 'config') {
    if ($method !== 'GET' && $method !== 'HEAD') {
        fail(405, 'method_not_allowed', 'Yalnızca GET');
    }
    try {
        $cfg = mv_oauth_public_config(mv_oauth_clients());
    } catch (Throwable $e) {
        fail(500, 'server_error', 'Yapılandırma okunamadı');
    }
    header('Cache-Control: public, max-age=300');
    out($cfg);
}

header('Cache-Control: no-store');
if ($action !== 'token' && $action !== 'refresh') {
    fail(404, 'not_found', 'Bilinmeyen istek');
}
// tarayıcıdan başka siteler adına çağrılamasın (çekirdek Origin göndermez)
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$host = strtolower((string) preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if ($origin !== '' && strtolower((string) parse_url($origin, PHP_URL_HOST)) !== $host) {
    fail(403, 'forbidden', 'İstek reddedildi');
}
if ($method !== 'POST') {
    fail(405, 'method_not_allowed', 'Yalnızca POST');
}
// gizler yalnız şifreli bağlantıda kullanılır (kod/yenileme belirteci açık ağda taşınmasın)
if (!mv_oauth_is_https() && mv_oauth_test_base() === '') {
    fail(403, 'https_required', 'Yalnız HTTPS');
}
if (stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? '')), 'application/json') !== 0) {
    fail(400, 'invalid_request', 'JSON bekleniyor');
}
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 8192) {
    fail(413, 'invalid_request', 'İstek çok büyük');
}
$raw = (string) file_get_contents('php://input', false, null, 0, 8193);
if (strlen($raw) > 8192) {
    fail(413, 'invalid_request', 'İstek çok büyük');
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    fail(400, 'invalid_request', 'Geçersiz istek');
}
// yalnız metin alanlar (dizi/sayı gelirse boş sayılır)
$str = function (string $k) use ($body): string {
    return is_string($body[$k] ?? null) ? $body[$k] : '';
};

try {
    if (mv_oauth_rate_over($action, $action === 'token' ? 60 : 300)) {
        fail(429, 'rate_limited', 'Çok fazla istek; biraz sonra yeniden dene');
    }
} catch (Throwable $e) {
    fail(500, 'server_error', 'Giriş sunucusu şu an kullanılamıyor');
}

$p = $str('provider');
if (!in_array($p, mv_oauth_providers(), true)) {
    fail(400, 'invalid_request', 'Bilinmeyen sağlayıcı');
}
if (!mv_oauth_needs_secret($p)) {
    fail(400, 'unsupported_provider', 'Microsoft girişi aracıdan geçmez');
}
if ($action === 'refresh' && $p === 'instagram') {
    fail(400, 'unsupported_provider', 'Instagram belirteci gizisiz yenilenir');
}
try {
    $clients = mv_oauth_clients();
} catch (Throwable $e) {
    fail(500, 'server_error', 'Yapılandırma okunamadı');
}
$c = is_array($clients[$p] ?? null) ? $clients[$p] : [];
if (!mv_oauth_ready($p, $c)) {
    fail(400, 'provider_disabled', MV_OAUTH_NAMES[$p] . ' resmi girişi şu an kapalı');
}

@set_time_limit(60);
if ($action === 'token') {
    $code = (string) preg_replace('/#_$/', '', $str('code'));
    $redirect = $str('redirect_uri');
    $verifier = $str('code_verifier');
    if (!preg_match('/^[\x21-\x7e]{1,4096}$/', $code)) {
        fail(400, 'invalid_request', 'Giriş kodu geçersiz');
    }
    if (!mv_oauth_redirect_ok($p, $redirect)) {
        fail(400, 'invalid_request', 'Geri dönüş adresi izinli değil');
    }
    if ($verifier !== '' && !preg_match('/^[A-Za-z0-9._~-]{43,128}$/', $verifier)) {
        fail(400, 'invalid_request', 'PKCE doğrulayıcısı geçersiz');
    }
    [$status, $res] = mv_oauth_token($p, $c, $code, $redirect, $verifier);
    out($res, $status);
}

$refresh = $str('refresh_token');
if (!preg_match('/^[\x21-\x7e]{1,4096}$/', $refresh)) {
    fail(400, 'invalid_request', 'Yenileme belirteci geçersiz');
}
[$status, $res] = mv_oauth_refresh($p, $c, $refresh);
out($res, $status);
