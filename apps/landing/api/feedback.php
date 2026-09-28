<?php
declare(strict_types=1);

/**
 * Geri bildirim (hata / öneri / talep): Mivelo uygulamasındaki sağ alt düğmeden multipart POST.
 *   alanlar: type (bug|idea|request|other), message, page?, website (bot tuzağı). Kimlik YOK (yerel uygulama); demo kendi
 *   API'sinden (action=feedback) oturumdaki üyeyle gönderir. Kayıt mantığı lib-feedback.php.
 *   dosyalar: files[] — görsel (png/jpeg/gif/webp) ya da video (mp4/webm/quicktime); en çok 5 dosya, dosya başına 40 MB, toplam 60 MB
 * Kayıtlar web kökü dışında ~/mivelo-data/feedback/index.json + ~/mivelo-data/feedback/<id>/<dosya>. Admin paneli okur.
 * Kaynaklar: demo.mivelo.app ve kullanıcının kendi bilgisayarındaki Mivelo (localhost / Tauri) → yalnız bu kökenlere CORS.
 * IP (/64) başına saatte 10 gönderim. SMTP ayarlıysa yeni bildirim sahibine e-postayla da haber verilir.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

const ALLOWED_ORIGINS = ['https://demo.mivelo.app', 'https://mivelo.app', 'http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

function fail(int $code, string $msg)
{
    http_response_code($code);
    echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
if ($origin !== '') {
    $same = strtolower((string) parse_url($origin, PHP_URL_HOST)) === $host;
    if (!$same && !in_array($origin, ALLOWED_ORIGINS, true)) {
        fail(403, 'İstek reddedildi');
    }
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 600');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'Yalnızca POST');
}
// post_max_size aşılınca PHP $_POST/$_FILES'ı sessizce boşaltır
if (empty($_POST) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
    fail(413, 'Ekler çok büyük; daha küçük bir video ya da ekran görüntüsü dene');
}

require_once __DIR__ . '/lib-smtp.php';
require_once __DIR__ . '/lib-feedback.php';
$id = mv_feedback_store('local', null);
echo json_encode(['ok' => true, 'id' => $id]);
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
}
mv_feedback_notify($id);
