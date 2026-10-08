<?php
declare(strict_types=1);

/**
 * Resmi giriş geri dönüş sayfası (https://mivelo.app/api/oauth-cb.php): HTTPS geri dönüş isteyen sağlayıcılar (Slack, Meta, Yahoo,
 * Yandex) kullanıcıyı buraya gönderir; sayfa kodu kullanıcının KENDİ bilgisayarındaki Mivelo'ya (http://127.0.0.1:<port>/oauth/callback)
 * yönlendirir. Port state'in sonundadır ("<rastgele>.<port>", çekirdek makeState). Kod tek başına işe yaramaz (gizi aracıda, PKCE çekirdekte).
 * Hiçbir şey kaydedilmez ve günlüğe yazılmaz.
 */

header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
header('X-Frame-Options: DENY');

$clip = function ($v, int $n): string {
    return mb_substr(trim((string) preg_replace('/[\x00-\x1f\x7f]+/u', ' ', is_string($v) ? $v : '')), 0, $n);
};

$state = is_string($_GET['state'] ?? null) ? $_GET['state'] : '';
// Instagram kodun sonuna "#_" ekleyebilir
$code = preg_replace('/#_$/', '', is_string($_GET['code'] ?? null) ? $_GET['code'] : '');
$error = substr((string) preg_replace('/[^A-Za-z0-9_.:-]/', '', is_string($_GET['error'] ?? null) ? $_GET['error'] : ''), 0, 64);
$desc = $clip($_GET['error_description'] ?? ($_GET['error_message'] ?? ''), 300);

$port = 0;
if (preg_match('/^[A-Za-z0-9_-]{16,64}\.(\d{4,5})$/', $state, $m)) {
    $port = (int) $m[1];
}
$denied = $error !== ''; // sağlayıcı hata döndü (izin verilmedi/iptal)
// bozuk/eksik kod: uygulama 10 dk beklemesin, hatayla dönsün
if ($code !== '' && !preg_match('/^[\x21-\x7e]{1,4096}$/', $code)) {
    $code = '';
}
if ($code === '' && $error === '') {
    $error = 'invalid_request';
    $desc = 'Sağlayıcı giriş kodu göndermedi';
}

if ($port >= 1024 && $port <= 65535) {
    $q = [];
    if ($code !== '') {
        $q['code'] = $code;
    }
    $q['state'] = $state;
    if ($error !== '') {
        $q['error'] = $error;
        if ($desc !== '') {
            $q['error_description'] = $desc;
        }
    }
    $to = 'http://127.0.0.1:' . $port . '/oauth/callback?' . http_build_query($q, '', '&', PHP_QUERY_RFC3986);
    header('Location: ' . $to, true, 302);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta charset="utf-8"><title>Mivelo</title><p>Mivelo’ya dönülüyor… <a href="' . htmlspecialchars($to, ENT_QUOTES) . '">Devam et</a></p>';
    exit;
}

// geçersiz: kısa açıklama (Mivelo dışından açılmış ya da bozuk bağlantı)
http_response_code(400);
header('Content-Type: text/html; charset=utf-8');
$title = $denied ? 'Giriş tamamlanmadı' : 'Giriş bağlantısı geçersiz';
$text = $denied
    ? 'İzin verilmedi ya da giriş iptal edildi. Mivelo’ya dönüp Bağlan’a yeniden basabilirsin.'
    : 'Bu sayfa yalnız Mivelo masaüstü uygulamasından başlatılan girişler içindir. Bağlantı eksik ya da bozuk; Mivelo’da Bağlan’a yeniden bas.';
?><!doctype html>
<html lang="tr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Mivelo</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Inter,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f6fa;color:#16131f}
@media (prefers-color-scheme:dark){body{background:#131118;color:#f1eff6}p{color:#a29db0!important}}
.c{text-align:center;max-width:440px;padding:24px}
.m{width:56px;height:56px;border-radius:16px;background:#6c47ff;display:inline-grid;place-items:center;margin-bottom:14px}
h1{font-size:22px;margin:0 0 8px}p{color:#6b6878;line-height:1.5;margin:0}
</style>
<div class="c">
  <div class="m"><svg width="30" height="30" viewBox="0 0 28 28" aria-hidden="true"><path d="M8 8c4.5 0 6 3 6 6s1.5 6 6 6M8 20c4.5 0 6-3 6-6" stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round"/><circle cx="20" cy="8" r="2.5" fill="#D4FF3F"/></svg></div>
  <h1><?= htmlspecialchars($title, ENT_QUOTES) ?></h1>
  <p><?= htmlspecialchars($text, ENT_QUOTES) ?></p>
</div>
</html>
