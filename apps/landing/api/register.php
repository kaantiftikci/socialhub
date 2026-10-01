<?php
declare(strict_types=1);

/**
 * İndirme kaydı (mivelo.app/api/register.php): indirme sayfasında "İndir"e basınca açılan pencere → POST {firstName, lastName, email, file, website,
 * consent:{terms, kvkk}} (Kullanım Koşulları/EULA kabulü + KVKK Aydınlatma Metni okundu; sürümler lib-members MV_*_VERSION ile aynı olmalı, yoksa 400)
 * → {ok:true}; ardından sayfa dosyayı indirir. Kayıt lib-members.php ile ~/mivelo-data/members.json'a (src 'indir'); Admin →
 * Üyeler sayfasında görünür. Ad/soyad yalnız harf, e-posta biçim + geçici servis + alan adı (MX/A) denetimi (lib-members). Aynı e-posta yeniden
 * gelirse yeni kayıt açılmaz ({known:true}); aynı ad soyadla başka e-postadan gelen kayıt 'dupOf' ile işaretlenir.
 * Bot tuzağı gizli "website" alanı; aynı IP'den (IPv6 /64) saatte en çok 10 yeni üye, günde toplam 1000.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function out(array $v)
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
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'Yalnızca POST');
}
$body = json_decode((string) file_get_contents('php://input', false, null, 0, 4096), true);
if (!is_array($body)) {
    fail(400, 'Geçersiz istek');
}
if (trim((string) ($body['website'] ?? '')) !== '') {
    out(['ok' => true]); // bot: başarılı görün, kaydetme
}

require_once __DIR__ . '/lib-members.php';

$email = strtolower(trim((string) ($body['email'] ?? '')));
$first = mv_member_name($body['firstName'] ?? '');
$last = mv_member_name($body['lastName'] ?? '');
$file = (string) ($body['file'] ?? '');
$FILES = ['Mivelo-mac-arm64.dmg', 'Mivelo-mac-intel.dmg', 'Mivelo-windows-x64-setup.exe'];
if (($err = mv_member_name_error($first, 'Ad')) !== '' || ($err = mv_member_name_error($last, 'Soyad')) !== '' || ($err = mv_member_email_error($email)) !== '') {
    fail(400, $err);
}
$consent = mv_consent_from($body['consent'] ?? null);
if ($consent === null) {
    fail(400, 'Devam etmek için Kullanım Koşulları’nı kabul edip KVKK Aydınlatma Metni’ni okuduğunu onayla.');
}
if ($file !== '' && !in_array($file, $FILES, true)) {
    $file = '';
}

$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
$ipKey = $ip;
if (strpos($ip, ':') !== false && ($bin = @inet_pton($ip)) !== false && strlen($bin) === 16) {
    $ipKey = bin2hex(substr($bin, 0, 8)) . '::/64';
}

try {
    $res = mv_members_update(function (array &$members) use ($email, $first, $last, $file, $ip, $ipKey, $consent) {
        $known = false;
        $recent = 0;
        $today = 0;
        $dayStart = strtotime('today');
        foreach ($members as $m) {
            if (($m['email'] ?? '') === $email) {
                $known = true;
            }
            $mk = (string) ($m['ip'] ?? '');
            if (strpos($mk, ':') !== false && ($b = @inet_pton($mk)) !== false && strlen($b) === 16) {
                $mk = bin2hex(substr($b, 0, 8)) . '::/64';
            }
            if ($mk === $ipKey && (int) ($m['at'] ?? 0) > time() - 3600) {
                $recent++;
            }
            if ((int) ($m['at'] ?? 0) >= $dayStart) {
                $today++;
            }
        }
        if (!$known && ($recent >= 10 || $today >= 1000)) {
            return 'limit';
        }
        mv_member_upsert($members, ['email' => $email, 'firstName' => $first, 'lastName' => $last, 'src' => 'indir', 'ip' => $ip, 'consent' => $consent], $file);
        return $known ? 'known' : 'ok';
    });
} catch (Throwable $e) {
    fail(500, 'Kayıt şu an alınamıyor, biraz sonra tekrar dene.');
}
if ($res === 'limit') {
    fail(429, 'Çok fazla deneme, biraz sonra tekrar dene.');
}
// known: bu e-posta zaten kayıtlı (yeni kayıt açılmadı; indirme kaydına eklendi)
out(['ok' => true, 'known' => $res === 'known']);
