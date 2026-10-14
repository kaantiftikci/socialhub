<?php
declare(strict_types=1);

/**
 * Resmi giriş (OAuth) aracısının ortak işlevleri: oauth.php (yapılandırma + kod/yenileme değişimi) ve admin/api.php (Admin → Ayarlar →
 * Resmi giriş uygulamaları) kullanır. Bu dosya yalnız işlev tanımlar; doğrudan açılırsa hiçbir şey yapmaz.
 *
 * İstemci kimlikleri ve gizleri web kökü dışında ~/mivelo-data/oauth-clients.json (0600):
 *   {google: {clientId, clientSecret, enabled, updatedAt}, slack: {…, historyLimited}, instagram|facebook: {…, graphVersion}, microsoft: {clientId, enabled}}
 * Belirteçler burada SAKLANMAZ ve günlüğe yazılmaz; yalnız sağlayıcıyla Mivelo çekirdeği arasında geçer.
 * Test: MV_OAUTH_TEST_BASE=http://127.0.0.1:<port> ortam değişkeni varsa (yalnız yerel adres kabul edilir) sağlayıcı uçları
 * <taban>/<sağlayıcı sunucusu>/<yol> adresine gider ve gelen isteklerde HTTPS aranmaz.
 */

if (!function_exists('mv_oauth_providers')) {
    define('MV_OAUTH_BOUNCE', 'https://mivelo.app/api/oauth-cb.php');
    define('MV_OAUTH_GRAPH_DEFAULT', 'v23.0');
    define('MV_OAUTH_NAMES', ['google' => 'Google', 'microsoft' => 'Microsoft', 'yahoo' => 'Yahoo', 'yandex' => 'Yandex', 'slack' => 'Slack', 'instagram' => 'Instagram', 'facebook' => 'Facebook', 'whatsapp' => 'WhatsApp']);
    define('MV_WA_WEBHOOK', 'https://mivelo.app/api/wa-webhook.php');

    /** @return string[] */
    function mv_oauth_providers(): array
    {
        return array_keys(MV_OAUTH_NAMES);
    }

    /** Microsoft genel istemci (gizisiz, PKCE): kod değişimi çekirdekte, aracıdan geçmez */
    function mv_oauth_needs_secret(string $p): bool
    {
        return $p !== 'microsoft';
    }

    function mv_oauth_data_dir(): string
    {
        $d = dirname(__DIR__, 2) . '/mivelo-data';
        if (!is_dir($d) && !@mkdir($d, 0700, true)) {
            throw new RuntimeException('Veri klasörü açılamadı');
        }
        return $d;
    }

    /** Yerel sahte sağlayıcı tabanı (yalnız 127.0.0.1/localhost) ya da '' */
    function mv_oauth_test_base(): string
    {
        $b = rtrim((string) getenv('MV_OAUTH_TEST_BASE'), '/');
        return preg_match('#^http://(127\.0\.0\.1|localhost)(:\d{2,5})?$#', $b) ? $b : '';
    }

    /** Gelen istek HTTPS mi (cPanel: HTTPS=on; vekil arkasında X-Forwarded-Proto) */
    function mv_oauth_is_https(): bool
    {
        if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
            return true;
        }
        if ((int) ($_SERVER['SERVER_PORT'] ?? 0) === 443) {
            return true;
        }
        return strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    }

    /* ---------------- depo (tmp + rename, ayrı .lock, bozuk dosya asla boş sayılmaz) ---------------- */

    function mv_oauth_read_file(string $path): array
    {
        clearstatcache(true, $path);
        if (!file_exists($path)) {
            return [];
        }
        $raw = @file_get_contents($path);
        if ($raw === false) {
            throw new RuntimeException('Kayıt okunamadı: ' . basename($path));
        }
        if (trim($raw) === '') {
            return [];
        }
        $d = json_decode($raw, true);
        if (!is_array($d)) {
            throw new RuntimeException('Kayıt bozuk: ' . basename($path));
        }
        return $d;
    }

    /** Kilitli oku-değiştir-yaz; dosya 0600 doğar (içerik yazılmadan önce izin daraltılır). Dönüş: $fn'in dönüşü */
    function mv_oauth_store_update(string $name, callable $fn)
    {
        $path = mv_oauth_data_dir() . '/' . $name;
        $lh = @fopen($path . '.lock', 'c');
        if ($lh === false || !flock($lh, LOCK_EX)) {
            throw new RuntimeException('Kayıt kilitlenemedi');
        }
        try {
            $data = mv_oauth_read_file($path);
            $before = $data;
            $res = $fn($data);
            if ($data !== $before) {
                $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if ($json === false) {
                    throw new RuntimeException('Kayıt kodlanamadı');
                }
                $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
                $fh = @fopen($tmp, 'x');
                if ($fh === false) {
                    throw new RuntimeException('Geçici dosya açılamadı');
                }
                @chmod($tmp, 0600);
                $ok = fwrite($fh, $json) === strlen($json) && fflush($fh);
                fclose($fh);
                if (!$ok || !@rename($tmp, $path)) {
                    @unlink($tmp);
                    throw new RuntimeException('Kayıt yazılamadı');
                }
                @chmod($path, 0600);
            }
            return $res;
        } finally {
            flock($lh, LOCK_UN);
            fclose($lh);
        }
    }

    function mv_oauth_clients(): array
    {
        return mv_oauth_read_file(mv_oauth_data_dir() . '/oauth-clients.json');
    }

    function mv_oauth_graph_version($v): string
    {
        return is_string($v) && preg_match('/^v\d{1,2}\.\d$/', $v) ? $v : MV_OAUTH_GRAPH_DEFAULT;
    }

    /** Meta sağlayıcıları (Instagram, Facebook/Messenger, WhatsApp): açma-kapama anahtarı YOK — bilgiler doluysa açık (Kaan, 14.10) */
    function mv_oauth_always_on(string $p): bool
    {
        return $p === 'instagram' || $p === 'facebook' || $p === 'whatsapp';
    }

    /** Sağlayıcı kullanıma hazır mı: (Meta dışı: etkin) + istemci kimliği (+ gizi gerekenlerde gizi; WhatsApp'ta Embedded Signup config_id de) */
    function mv_oauth_ready(string $p, array $c): bool
    {
        if ($p === 'whatsapp' && (string) ($c['configId'] ?? '') === '') {
            return false;
        }
        return (mv_oauth_always_on($p) || !empty($c['enabled'])) && (string) ($c['clientId'] ?? '') !== '' && (!mv_oauth_needs_secret($p) || (string) ($c['clientSecret'] ?? '') !== '');
    }

    /** WhatsApp webhook doğrulama belirteci (Meta uygulama panosuna yapıştırılır); yoksa üretilir */
    function mv_wa_verify_token(array $c): string
    {
        $v = (string) ($c['webhookVerifyToken'] ?? '');
        return preg_match('/^[A-Za-z0-9]{24,64}$/', $v) ? $v : '';
    }

    /** Herkese açık yapılandırma (?action=config): yalnız hazır sağlayıcılar; GİZ ASLA eklenmez */
    function mv_oauth_public_config(array $clients): array
    {
        $out = [];
        foreach (mv_oauth_providers() as $p) {
            $c = is_array($clients[$p] ?? null) ? $clients[$p] : [];
            if (!mv_oauth_ready($p, $c)) {
                continue;
            }
            $pc = ['clientId' => (string) $c['clientId']];
            if ($p === 'slack') {
                $pc['historyLimited'] = ($c['historyLimited'] ?? true) !== false;
            }
            if ($p === 'instagram' || $p === 'facebook' || $p === 'whatsapp') {
                $pc['graphVersion'] = mv_oauth_graph_version($c['graphVersion'] ?? null);
            }
            // İşletmeler için Facebook Girişi / WhatsApp Embedded Signup: kapsam yerine yapılandırma kimliği (config_id)
            if (($p === 'facebook' || $p === 'whatsapp') && !empty($c['configId'])) {
                $pc['configId'] = (string) $c['configId'];
            }
            $out[$p] = $pc;
        }
        return ['v' => 1, 'providers' => (object) $out];
    }

    /** Yönetim paneli görünümü: gizi yalnız maske ("••••1234") */
    function mv_oauth_admin_view(array $clients): array
    {
        $out = [];
        foreach (mv_oauth_providers() as $p) {
            $c = is_array($clients[$p] ?? null) ? $clients[$p] : [];
            $sec = (string) ($c['clientSecret'] ?? '');
            $out[$p] = [
                'name' => MV_OAUTH_NAMES[$p],
                'enabled' => mv_oauth_always_on($p) || !empty($c['enabled']),
                'alwaysOn' => mv_oauth_always_on($p),
                'live' => mv_oauth_ready($p, $c),
                'clientId' => (string) ($c['clientId'] ?? ''),
                'needsSecret' => mv_oauth_needs_secret($p),
                'hasSecret' => $sec !== '',
                'secretHint' => $sec === '' ? '' : '••••' . (strlen($sec) >= 12 ? substr($sec, -4) : ''),
                'updatedAt' => (int) ($c['updatedAt'] ?? 0),
            ];
            if ($p === 'slack') {
                $out[$p]['historyLimited'] = ($c['historyLimited'] ?? true) !== false;
            }
            if ($p === 'instagram' || $p === 'facebook' || $p === 'whatsapp') {
                $out[$p]['graphVersion'] = mv_oauth_graph_version($c['graphVersion'] ?? null);
            }
            if ($p === 'facebook' || $p === 'whatsapp') {
                $out[$p]['configId'] = (string) ($c['configId'] ?? '');
            }
            if ($p === 'whatsapp') {
                $out[$p]['webhookVerifyToken'] = mv_wa_verify_token($c);
                $out[$p]['webhookUrl'] = MV_WA_WEBHOOK;
            }
        }
        return $out;
    }

    /**
     * Admin kaydı: $in {provider, enabled, clientId, clientSecret?, clearSecret?, historyLimited?, graphVersion?}.
     * Gizi boş gelirse eskisi korunur. Hata metni ya da '' döner ($clients yalnız başarıda değişir).
     */
    function mv_oauth_admin_save(array &$clients, array $in): string
    {
        $str = function (string $k) use ($in): string {
            return is_string($in[$k] ?? null) ? $in[$k] : '';
        };
        $p = $str('provider');
        if (!isset(MV_OAUTH_NAMES[$p])) {
            return 'Bilinmeyen sağlayıcı';
        }
        $old = is_array($clients[$p] ?? null) ? $clients[$p] : [];
        $id = trim($str('clientId'));
        if ($id !== '' && !preg_match('/^[\x21-\x7e]{4,300}$/', $id)) {
            return 'İstemci kimliği geçersiz (boşluksuz, 4-300 karakter)';
        }
        $c = ['clientId' => $id, 'enabled' => mv_oauth_always_on($p) || !empty($in['enabled'])];
        if (mv_oauth_needs_secret($p)) {
            $sec = trim($str('clientSecret'));
            if ($sec !== '' && !preg_match('/^[\x21-\x7e]{4,300}$/', $sec)) {
                return 'İstemci gizi geçersiz (boşluksuz, 4-300 karakter)';
            }
            $c['clientSecret'] = !empty($in['clearSecret']) ? '' : ($sec !== '' ? $sec : (string) ($old['clientSecret'] ?? ''));
        }
        if ($p === 'slack') {
            $c['historyLimited'] = ($in['historyLimited'] ?? true) !== false;
        }
        if ($p === 'instagram' || $p === 'facebook' || $p === 'whatsapp') {
            $gv = trim($str('graphVersion'));
            if ($gv !== '' && !preg_match('/^v\d{1,2}\.\d$/', $gv)) {
                return 'Graph sürümü v23.0 biçiminde olmalı';
            }
            $c['graphVersion'] = $gv !== '' ? $gv : MV_OAUTH_GRAPH_DEFAULT;
        }
        if ($p === 'facebook' || $p === 'whatsapp') {
            $cid = trim($str('configId'));
            if ($cid !== '' && !preg_match('/^\d{5,30}$/', $cid)) {
                return 'Yapılandırma kimliği (config_id) yalnız rakam olmalı';
            }
            $c['configId'] = $cid;
        }
        if ($p === 'whatsapp') {
            // webhook doğrulama belirteci bir kez üretilir, sonra korunur ("yenile" isteğinde yenisi)
            $old_vt = mv_wa_verify_token($old);
            $c['webhookVerifyToken'] = !empty($in['newVerifyToken']) || $old_vt === '' ? bin2hex(random_bytes(16)) : $old_vt;
            if ($c['enabled'] && $c['configId'] === '') {
                return 'Etkinleştirmek için Embedded Signup yapılandırma kimliği (config_id) gerekli';
            }
        }
        if ($c['enabled'] && $id === '') {
            return 'Etkinleştirmek için istemci kimliği gerekli';
        }
        if ($c['enabled'] && mv_oauth_needs_secret($p) && $c['clientSecret'] === '') {
            return 'Etkinleştirmek için istemci gizi gerekli';
        }
        $c['updatedAt'] = time();
        $clients[$p] = $c;
        return '';
    }

    /* ---------------- hız sınırı ---------------- */

    /** IPv4 tam adres, IPv6 /64 önek; kayıtta yalnız özet (ham IP yazılmaz) */
    function mv_oauth_client_key(string $ip): string
    {
        if (strpos($ip, ':') !== false) {
            $bin = @inet_pton($ip);
            if ($bin !== false && strlen($bin) === 16) {
                $ip = bin2hex(substr($bin, 0, 8)) . '::/64';
            }
        }
        return substr(hash('sha256', 'mv-oauth|' . $ip), 0, 32);
    }

    /** Saatlik pencere: bu istek sayılır; sınır aşıldıysa true */
    function mv_oauth_rate_over(string $action, int $limit): bool
    {
        $key = mv_oauth_client_key((string) ($_SERVER['REMOTE_ADDR'] ?? ''));
        $now = time();
        return (bool) mv_oauth_store_update('oauth-rate.json', function (array &$d) use ($key, $action, $limit, $now) {
            foreach ($d as $k => $acts) {
                foreach (is_array($acts) ? $acts : [] as $a => $v) {
                    if ((int) ($v['t'] ?? 0) < $now - 3600) {
                        unset($d[$k][$a]);
                    }
                }
                if (empty($d[$k])) {
                    unset($d[$k]);
                }
            }
            $e = $d[$key][$action] ?? ['t' => $now, 'n' => 0];
            $e['n'] = (int) $e['n'] + 1;
            $d[$key][$action] = $e;
            return $e['n'] > $limit;
        });
    }

    /* ---------------- sağlayıcı istekleri ---------------- */

    /** Gerçek uç → test tabanı (varsa) */
    function mv_oauth_url(string $real): string
    {
        $b = mv_oauth_test_base();
        if ($b === '') {
            return $real;
        }
        $u = parse_url($real);
        return $b . '/' . ($u['host'] ?? '') . ($u['path'] ?? '/');
    }

    /**
     * HTTP isteği (yönlendirme izlenmez, TLS doğrulanır, 20 sn). @return array{0:int,1:string} [durum, gövde]; ağ hatasında [0, '']
     */
    function mv_oauth_http(string $method, string $url, array $form, array $headers = []): array
    {
        $test = mv_oauth_test_base() !== '';
        if (!preg_match($test ? '#^https?://#' : '#^https://#', $url)) {
            return [0, ''];
        }
        $query = http_build_query($form, '', '&', PHP_QUERY_RFC1738);
        if ($method === 'GET' && $query !== '') {
            $url .= (strpos($url, '?') === false ? '?' : '&') . $query;
        }
        $hdr = array_merge(['Accept: application/json', 'User-Agent: Mivelo-OAuth/1'], $headers);
        if ($method === 'POST') {
            $hdr[] = 'Content-Type: application/x-www-form-urlencoded';
        }
        $max = 262144;
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            $opts = [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_CONNECTTIMEOUT => 8,
                CURLOPT_TIMEOUT => 20,
                CURLOPT_HTTPHEADER => $hdr,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
            ];
            if (defined('CURLOPT_PROTOCOLS')) {
                $opts[CURLOPT_PROTOCOLS] = $test ? (CURLPROTO_HTTP | CURLPROTO_HTTPS) : CURLPROTO_HTTPS;
            }
            if ($method === 'POST') {
                $opts[CURLOPT_POST] = true;
                $opts[CURLOPT_POSTFIELDS] = $query;
            }
            curl_setopt_array($ch, $opts);
            $res = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            unset($ch);
            if (!is_string($res) || $status === 0 || strlen($res) > $max) {
                return [0, ''];
            }
            return [$status, $res];
        }
        $ctx = stream_context_create([
            'http' => ['method' => $method, 'header' => implode("\r\n", $hdr), 'content' => $method === 'POST' ? $query : '', 'timeout' => 20,
                'ignore_errors' => true, 'follow_location' => 0, 'max_redirects' => 0],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $res = @file_get_contents($url, false, $ctx, 0, $max + 1);
        $hs = function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : ($http_response_header ?? []);
        $status = preg_match('#^HTTP/\S+\s+(\d{3})#', (string) ($hs[0] ?? ''), $m) ? (int) $m[1] : 0;
        if (!is_string($res) || $status === 0 || strlen($res) > $max) {
            return [0, ''];
        }
        return [$status, $res];
    }

    /** @return array{s:int, j:?array} durum + çözülmüş JSON (büyük sayılar metin: Instagram kullanıcı kimliği) */
    function mv_oauth_call(string $method, string $real, array $form, array $headers = []): array
    {
        [$s, $raw] = mv_oauth_http($method, mv_oauth_url($real), $form, $headers);
        $j = $raw !== '' ? json_decode($raw, true, 64, JSON_BIGINT_AS_STRING) : null;
        return ['s' => $s, 'j' => is_array($j) ? $j : null];
    }

    function mv_oauth_clip(string $v, int $n): string
    {
        return mb_substr(trim((string) preg_replace('/[\x00-\x1f\x7f]+/u', ' ', $v)), 0, $n);
    }

    /**
     * Sağlayıcı hatası → {error, error_description} (yalnız bu iki alan; Slack'te ok:false da). Ağ/biçim hatasında 502.
     * @return array{0:int,1:array}
     */
    function mv_oauth_error(string $p, array $r): array
    {
        $name = MV_OAUTH_NAMES[$p];
        if ($r['s'] === 0) {
            return [502, ['error' => 'provider_unreachable', 'error_description' => "$name sunucusuna ulaşılamadı; biraz sonra yeniden dene"]];
        }
        $j = $r['j'];
        if ($j === null) {
            return [502, ['error' => 'bad_provider_response', 'error_description' => "$name geçersiz yanıt verdi (HTTP {$r['s']})"]];
        }
        $err = '';
        $desc = '';
        if (is_array($j['error'] ?? null)) {
            // Meta Graph: {error:{message, type, code}}; 190 = belirteç geçersiz/süresi dolmuş/iptal
            $e = $j['error'];
            $err = (int) ($e['code'] ?? 0) === 190 ? 'invalid_token' : (string) ($e['type'] ?? '');
            $desc = (string) ($e['message'] ?? '');
        } elseif (isset($j['error_type']) || isset($j['error_message'])) {
            // api.instagram.com: {error_type, code, error_message}
            $err = (string) ($j['error_type'] ?? '');
            $desc = (string) ($j['error_message'] ?? '');
        } else {
            $err = is_string($j['error'] ?? null) ? $j['error'] : '';
            $desc = is_string($j['error_description'] ?? null) ? $j['error_description'] : '';
        }
        $err = substr((string) preg_replace('/[^A-Za-z0-9_.:-]/', '', $err), 0, 64) ?: 'provider_error';
        if ($p === 'slack' && $desc === '') {
            $desc = [
                'invalid_refresh_token' => 'Slack yenileme belirteci geçersiz ya da iptal edilmiş (revoked); yeniden giriş gerekli',
                'invalid_code' => 'Slack giriş kodu geçersiz ya da kullanılmış; yeniden dene',
                'code_already_used' => 'Slack giriş kodu zaten kullanılmış; yeniden dene',
                'bad_redirect_uri' => 'Geri dönüş adresi Slack uygulamasında kayıtlı değil',
                'invalid_client_id' => 'Slack uygulama kimliği hatalı (yönetim paneli)',
                'bad_client_secret' => 'Slack uygulama gizi hatalı (yönetim paneli)',
            ][$err] ?? '';
        }
        $out = ['error' => $err] + ($desc !== '' ? ['error_description' => mv_oauth_clip($desc, 300)] : []);
        if ($p === 'slack') {
            $out = ['ok' => false] + $out;
        }
        $status = $r['s'] >= 400 && $r['s'] < 500 ? $r['s'] : ($r['s'] >= 500 ? 502 : 400);
        return [$status, $out];
    }

    /** Başarılı mı: belirteç alanı var (Slack: ok:true) */
    function mv_oauth_ok(string $p, array $r): bool
    {
        if ($r['s'] < 200 || $r['s'] >= 300 || $r['j'] === null) {
            return false;
        }
        if ($p === 'slack') {
            return ($r['j']['ok'] ?? false) === true;
        }
        return is_string($r['j']['access_token'] ?? null) && $r['j']['access_token'] !== '';
    }

    /** İzinli geri dönüş adresi (sağlayıcı da kendi kaydıyla ayrıca denetler) */
    function mv_oauth_redirect_ok(string $p, string $uri): bool
    {
        if ($p === 'google') {
            return (bool) preg_match('#^http://127\.0\.0\.1:\d{2,5}/oauth/callback$#', $uri);
        }
        return $uri === MV_OAUTH_BOUNCE;
    }

    function mv_oauth_basic(array $c): string
    {
        return 'Authorization: Basic ' . base64_encode($c['clientId'] . ':' . $c['clientSecret']);
    }

    /** Meta uzun ömürlü kullanıcı belirteci (fb_exchange_token) */
    function mv_oauth_fb_long(array $c, string $token): array
    {
        $v = mv_oauth_graph_version($c['graphVersion'] ?? null);
        return mv_oauth_call('GET', "https://graph.facebook.com/$v/oauth/access_token", [
            'grant_type' => 'fb_exchange_token', 'client_id' => $c['clientId'], 'client_secret' => $c['clientSecret'], 'fb_exchange_token' => $token,
        ]);
    }

    /**
     * Yetki kodu → belirteç. Başarıda sağlayıcının ham yanıtı (Instagram/Facebook: uzun ömürlü belirteçle sadeleştirilmiş).
     * @return array{0:int,1:array}
     */
    function mv_oauth_token(string $p, array $c, string $code, string $redirect, string $verifier): array
    {
        $id = (string) $c['clientId'];
        $sec = (string) $c['clientSecret'];
        switch ($p) {
            case 'google':
                $r = mv_oauth_call('POST', 'https://oauth2.googleapis.com/token', ['client_id' => $id, 'client_secret' => $sec, 'code' => $code,
                    'grant_type' => 'authorization_code', 'redirect_uri' => $redirect] + ($verifier !== '' ? ['code_verifier' => $verifier] : []));
                break;
            case 'yahoo':
                $r = mv_oauth_call('POST', 'https://api.login.yahoo.com/oauth2/get_token', ['client_id' => $id, 'client_secret' => $sec,
                    'redirect_uri' => $redirect, 'code' => $code, 'grant_type' => 'authorization_code'], [mv_oauth_basic($c)]);
                break;
            case 'yandex':
                $r = mv_oauth_call('POST', 'https://oauth.yandex.com/token', ['grant_type' => 'authorization_code', 'code' => $code, 'client_id' => $id,
                    'client_secret' => $sec] + ($verifier !== '' ? ['code_verifier' => $verifier] : []));
                break;
            case 'slack':
                $r = mv_oauth_call('POST', 'https://slack.com/api/oauth.v2.access', ['client_id' => $id, 'client_secret' => $sec, 'code' => $code, 'redirect_uri' => $redirect]);
                break;
            case 'instagram':
                $r = mv_oauth_call('POST', 'https://api.instagram.com/oauth/access_token', ['client_id' => $id, 'client_secret' => $sec,
                    'grant_type' => 'authorization_code', 'redirect_uri' => $redirect, 'code' => $code]);
                // yanıt {data:[{access_token, user_id, permissions}]} ya da düz nesne
                $short = is_array($r['j']['data'][0] ?? null) ? $r['j']['data'][0] : ($r['j'] ?? []);
                if ($r['s'] < 200 || $r['s'] >= 300 || !is_string($short['access_token'] ?? null) || $short['access_token'] === '') {
                    return mv_oauth_error($p, $r);
                }
                // kısa ömürlü (1 sa) → uzun ömürlü (60 gün; çekirdek gizisiz yeniler)
                $r2 = mv_oauth_call('GET', 'https://graph.instagram.com/access_token', ['grant_type' => 'ig_exchange_token', 'client_secret' => $sec,
                    'access_token' => $short['access_token']]);
                if (!mv_oauth_ok($p, $r2)) {
                    return mv_oauth_error($p, $r2);
                }
                $out = ['access_token' => $r2['j']['access_token'], 'token_type' => (string) ($r2['j']['token_type'] ?? 'bearer'),
                    'expires_in' => (int) ($r2['j']['expires_in'] ?? 0), 'user_id' => (string) ($short['user_id'] ?? '')];
                if (isset($short['permissions'])) {
                    $out['permissions'] = is_array($short['permissions']) ? implode(',', $short['permissions']) : (string) $short['permissions'];
                }
                return [200, $out];
            case 'whatsapp':
                // Embedded Signup kodu: redirect_uri YOK; yanıt işletme sistem kullanıcısı belirteci (süresiz) ya da süreli kullanıcı belirteci
                $v = mv_oauth_graph_version($c['graphVersion'] ?? null);
                $r = mv_oauth_call('GET', "https://graph.facebook.com/$v/oauth/access_token", ['client_id' => $id, 'client_secret' => $sec, 'code' => $code]);
                if (!mv_oauth_ok($p, $r)) {
                    return mv_oauth_error($p, $r);
                }
                $out = ['access_token' => $r['j']['access_token'], 'token_type' => (string) ($r['j']['token_type'] ?? 'bearer')];
                if (isset($r['j']['expires_in']) && (int) $r['j']['expires_in'] > 0) {
                    // süreli kullanıcı belirteci → uzun ömürlü (~60 gün); olmazsa kısa olanla devam
                    $r2 = mv_oauth_fb_long($c, (string) $r['j']['access_token']);
                    if (mv_oauth_ok($p, $r2)) {
                        $out['access_token'] = $r2['j']['access_token'];
                        $out['expires_in'] = (int) ($r2['j']['expires_in'] ?? 0);
                    } else {
                        $out['expires_in'] = (int) $r['j']['expires_in'];
                    }
                }
                return [200, $out];
            case 'facebook':
                $v = mv_oauth_graph_version($c['graphVersion'] ?? null);
                $r = mv_oauth_call('GET', "https://graph.facebook.com/$v/oauth/access_token", ['client_id' => $id, 'redirect_uri' => $redirect,
                    'client_secret' => $sec, 'code' => $code]);
                if (!mv_oauth_ok($p, $r)) {
                    return mv_oauth_error($p, $r);
                }
                // kısa ömürlü (1-2 sa) → uzun ömürlü (~60 gün); sayfa belirteçleri bundan süresiz türer
                $r2 = mv_oauth_fb_long($c, (string) $r['j']['access_token']);
                if (!mv_oauth_ok($p, $r2)) {
                    return mv_oauth_error($p, $r2);
                }
                $out = ['access_token' => $r2['j']['access_token'], 'token_type' => (string) ($r2['j']['token_type'] ?? 'bearer')];
                if (isset($r2['j']['expires_in'])) {
                    $out['expires_in'] = (int) $r2['j']['expires_in'];
                }
                return [200, $out];
            default:
                return [400, ['error' => 'unsupported_provider', 'error_description' => 'Bu sağlayıcı aracıdan geçmez']];
        }
        return mv_oauth_ok($p, $r) ? [200, $r['j']] : mv_oauth_error($p, $r);
    }

    /** Erişim belirtecini yenile (Slack: belirteç döndürme). @return array{0:int,1:array} */
    function mv_oauth_refresh(string $p, array $c, string $refresh): array
    {
        $id = (string) $c['clientId'];
        $sec = (string) $c['clientSecret'];
        switch ($p) {
            case 'google':
                $r = mv_oauth_call('POST', 'https://oauth2.googleapis.com/token', ['client_id' => $id, 'client_secret' => $sec, 'grant_type' => 'refresh_token', 'refresh_token' => $refresh]);
                break;
            case 'yahoo':
                $r = mv_oauth_call('POST', 'https://api.login.yahoo.com/oauth2/get_token', ['client_id' => $id, 'client_secret' => $sec,
                    'redirect_uri' => MV_OAUTH_BOUNCE, 'refresh_token' => $refresh, 'grant_type' => 'refresh_token'], [mv_oauth_basic($c)]);
                break;
            case 'yandex':
                $r = mv_oauth_call('POST', 'https://oauth.yandex.com/token', ['grant_type' => 'refresh_token', 'refresh_token' => $refresh, 'client_id' => $id, 'client_secret' => $sec]);
                break;
            case 'slack':
                $r = mv_oauth_call('POST', 'https://slack.com/api/oauth.v2.access', ['client_id' => $id, 'client_secret' => $sec, 'grant_type' => 'refresh_token', 'refresh_token' => $refresh]);
                break;
            case 'facebook':
            case 'whatsapp':
                // Meta'da yenileme belirteci yok: geçerli uzun ömürlü belirteç yeniden takas edilir (süresi dolmuşsa 190 → yeniden giriş)
                $r = mv_oauth_fb_long($c, $refresh);
                if (!mv_oauth_ok($p, $r)) {
                    return mv_oauth_error($p, $r);
                }
                $out = ['access_token' => $r['j']['access_token'], 'token_type' => (string) ($r['j']['token_type'] ?? 'bearer')];
                if (isset($r['j']['expires_in'])) {
                    $out['expires_in'] = (int) $r['j']['expires_in'];
                }
                return [200, $out];
            default:
                return [400, ['error' => 'unsupported_provider', 'error_description' => 'Bu sağlayıcının yenilemesi aracıdan geçmez']];
        }
        return mv_oauth_ok($p, $r) ? [200, $r['j']] : mv_oauth_error($p, $r);
    }
}
